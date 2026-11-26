import { createHash } from "node:crypto";
import type { ArgValue } from "@galahad/core";
import { z } from "zod";
import type { ArtifactStore } from "./artifacts.ts";
import type { NativeTool } from "./connectors.ts";

/*
 * Shipping: a quest's changes become a pull request, through the oath gate.
 *
 * The sandbox never holds a GitHub key. When a quest worked on a clone, it leaves its
 * changes in its kept work as a shipment (ship/manifest.json: the commit it started
 * from, each changed file's path and mode, deletions; ship/files/…: the new contents).
 * `github.ship` is one outward action: you approve it (or a standing order does, or he
 * does: his and his knights' work in a repository you gave a knight, oath.ts ownApproval),
 * and then the node, with the connector's key on its pinned origin (api.github.com),
 * commits the files on a new branch with GitHub's Git Data API and opens the pull
 * request. A branch that already exists is never touched.
 *
 * `github.ship.update` is the one exception, for a fix to a pull request already shipped
 * (ci-back.ts): its commit goes on top of the branch, and only when the branch stands
 * exactly where the fixing work began; the branch is moved forward, never forced, and
 * the pull request on it updates. Like a ship, it asks you first, but where it is his to approve.
 */

const Sha = z.string().regex(/^[0-9a-f]{40}$/);
/** Relative, no . or .. segments, nothing inside .git. */
const RepoPath = z
  .string()
  .min(1)
  .max(1024)
  .refine((p) => !p.startsWith("/") && !p.includes("\0") && !p.split("/").some((s) => s === "" || s === "." || s === "..") && p.split("/")[0] !== ".git", "an unsafe path");

export const ShipManifest = z.object({
  v: z.literal(1),
  /** The commit the work started from (the clone's HEAD). */
  base: Sha,
  /** Where it was cloned from: the shipment must go back there. */
  remote: z.string().max(500),
  files: z
    .array(z.object({ path: RepoPath, mode: z.enum(["100644", "100755"]).default("100644"), deleted: z.boolean().optional() }))
    .min(1)
    .max(1000),
});
export type ShipManifest = z.infer<typeof ShipManifest>;

export const SHIP_LIMITS = { bytes: 50 * 2 ** 20 };

export interface ShipDeps {
  /** One request to api.github.com, with the connector's key. */
  github(method: "GET" | "POST" | "PATCH", path: string, body?: unknown): Promise<{ status: number; json: any }>;
  /** The kept work, if this node holds it: its file list and a file's bytes. */
  artifact(id: string): { files: { path: string; size: number }[]; read(path: string): Uint8Array } | null;
}

export interface ShipResult {
  ok: boolean;
  status: number;
  /** What happened, for the action's receipt. */
  receipt: string;
  url?: string;
}

const seg = (s: string) => encodeURIComponent(s);
const refPath = (branch: string) => branch.split("/").map(seg).join("/");

/** The clone's remote names this repository (https or git@, with or without .git). */
export function sameRepository(remote: string, owner: string, repo: string): boolean {
  const m = remote.trim().match(/^(?:https:\/\/(?:[^@/]+@)?github\.com\/|git@github\.com:)([^/]+)\/([^/]+?)(?:\.git)?\/?$/i);
  return !!m && m[1]!.toLowerCase() === owner.toLowerCase() && m[2]!.toLowerCase() === repo.toLowerCase();
}

/** A shipment to GitHub: on a new branch with its pull request, or (`update`) on top of the branch it began on. */
export async function shipToGitHub(deps: ShipDeps, args: Record<string, ArgValue>, update = false): Promise<ShipResult> {
  try {
    return await ship(deps, args, update);
  } catch (error) {
    return { ok: false, status: 500, receipt: `nothing more was shipped: ${String((error as Error).message ?? error).slice(0, 500)}` };
  }
}

async function ship(deps: ShipDeps, args: Record<string, ArgValue>, update: boolean): Promise<ShipResult> {
  const owner = String(args.owner);
  const repo = String(args.repo);
  const branch = String(args.branch);
  const fail = (status: number, receipt: string): ShipResult => ({ ok: false, status, receipt });
  const at = `/repos/${seg(owner)}/${seg(repo)}`;

  const kept = deps.artifact(String(args.artifact));
  if (!kept) return fail(404, `the work ${args.artifact} isn't kept on this node`);
  if (!kept.files.some((f) => f.path === "ship/manifest.json")) return fail(422, `${args.artifact} has no shipment (ship/manifest.json): only a quest that worked on a clone leaves one`);
  let shipment: ShipManifest;
  try {
    shipment = ShipManifest.parse(JSON.parse(new TextDecoder().decode(kept.read("ship/manifest.json"))));
  } catch (error) {
    return fail(422, `the shipment's manifest doesn't hold up: ${(error as Error).message.slice(0, 300)}`);
  }
  if (!sameRepository(shipment.remote, owner, repo)) return fail(422, `this work was done on ${shipment.remote}, not ${owner}/${repo}`);
  const sizes = new Map(kept.files.map((f) => [f.path, f.size]));
  let bytes = 0;
  for (const f of shipment.files) {
    if (f.deleted) continue;
    const size = sizes.get(`ship/files/${f.path}`);
    if (size === undefined) return fail(422, `the shipment lists ${f.path} but doesn't hold it`);
    bytes += size;
  }
  if (bytes > SHIP_LIMITS.bytes) return fail(413, `the shipment is ${Math.round(bytes / 2 ** 20)} MB; at most ${SHIP_LIMITS.bytes / 2 ** 20} MB`);

  // Where it goes: never onto an existing branch; an update only onto its own, standing exactly where the work began.
  const existing = await deps.github("GET", `${at}/git/ref/heads/${refPath(branch)}`);
  let base = args.base === undefined ? "" : String(args.base);
  if (update) {
    if (existing.status === 404) return fail(404, `${owner}/${repo} has no branch ${branch} to push onto`);
    if (existing.status !== 200) return fail(existing.status, `couldn't read the branch ${branch}: ${existing.status}`);
    const now = String(existing.json?.object?.sha ?? "");
    if (now !== shipment.base) return fail(409, `${branch} has moved since the work began (from ${shipment.base.slice(0, 12)} to ${now.slice(0, 12) || "nothing"}): nothing was pushed`);
  } else {
    if (existing.status === 200) return fail(409, `${owner}/${repo} already has a branch ${branch}; a shipment never touches an existing branch`);
    if (existing.status !== 404) return fail(existing.status, `couldn't check for the branch ${branch}: ${existing.status}`);
    if (!base) {
      const info = await deps.github("GET", at);
      if (info.status !== 200) return fail(info.status, `couldn't read ${owner}/${repo}: ${info.status}`);
      base = String(info.json.default_branch ?? "main");
    }
  }
  const from = await deps.github("GET", `${at}/git/commits/${shipment.base}`);
  if (from.status !== 200) return fail(from.status, `${owner}/${repo} doesn't have the commit the work started from (${shipment.base.slice(0, 12)})`);

  // The files, one blob each; then one tree on top of the start, one commit, one branch.
  const tree: { path: string; mode: string; type: "blob"; sha: string | null }[] = [];
  for (const f of shipment.files) {
    if (f.deleted) {
      tree.push({ path: f.path, mode: "100644", type: "blob", sha: null });
      continue;
    }
    const blob = await deps.github("POST", `${at}/git/blobs`, { content: Buffer.from(kept.read(`ship/files/${f.path}`)).toString("base64"), encoding: "base64" });
    if (blob.status !== 201) return fail(blob.status, `couldn't upload ${f.path}: ${blob.status}`);
    tree.push({ path: f.path, mode: f.mode, type: "blob", sha: String(blob.json.sha) });
  }
  const made = await deps.github("POST", `${at}/git/trees`, { base_tree: String(from.json.tree.sha), tree });
  if (made.status !== 201) return fail(made.status, `couldn't build the tree: ${made.status}`);
  const title = String(args.title);
  const body = args.body === undefined ? "" : String(args.body);
  const commit = await deps.github("POST", `${at}/git/commits`, { message: body ? `${title}\n\n${body}` : title, tree: String(made.json.sha), parents: [shipment.base] });
  if (commit.status !== 201) return fail(commit.status, `couldn't commit: ${commit.status}`);
  const changed = `${shipment.files.length} file${shipment.files.length === 1 ? "" : "s"}`;
  const sha = String(commit.json.sha);
  if (update) {
    // Forward only: GitHub refuses a move that isn't one (the branch moved since it was read), and nothing is forced.
    const moved = await deps.github("PATCH", `${at}/git/refs/heads/${refPath(branch)}`, { sha, force: false });
    if (moved.status !== 200) return fail(moved.status, `committed ${changed} (${sha.slice(0, 12)}), but ${branch} wasn't moved onto it: ${String(moved.json?.message ?? moved.status).slice(0, 300)}`);
    const open = await deps.github("GET", `${at}/pulls?head=${seg(owner)}:${seg(branch)}&state=open&per_page=1`);
    const pr = open.status === 200 && Array.isArray(open.json) ? open.json[0] : undefined;
    return { ok: true, status: 200, ...(pr?.html_url ? { url: String(pr.html_url) } : {}), receipt: `${changed} pushed onto ${branch}, commit ${sha.slice(0, 12)}${pr ? `: pull request #${pr.number} updated, ${pr.html_url}` : ""}` };
  }
  const ref = await deps.github("POST", `${at}/git/refs`, { ref: `refs/heads/${branch}`, sha });
  if (ref.status !== 201) return fail(ref.status, `couldn't create the branch ${branch}: ${ref.status}`);
  const pr = await deps.github("POST", `${at}/pulls`, { title, head: branch, base, ...(body ? { body } : {}), ...(args.draft === true ? { draft: true } : {}) });
  if (pr.status !== 201) {
    const why = Array.isArray(pr.json?.errors) ? pr.json.errors.map((e: any) => e.message ?? e.code).join("; ") : (pr.json?.message ?? pr.status);
    return fail(pr.status, `committed ${changed} on ${branch} (${String(commit.json.sha).slice(0, 12)}), but the pull request wasn't opened: ${String(why).slice(0, 300)}`);
  }
  const url = String(pr.json.html_url);
  return { ok: true, status: 201, url, receipt: `pull request #${pr.json.number}: ${url} (${changed} on ${branch} into ${base}, commit ${String(commit.json.sha).slice(0, 12)})` };
}

/** github.ship (or, `update`, github.ship.update) as the connector service runs it: GitHub through `send` (the pinned origin and key), the work from this node's artifacts. */
export function shipNative(artifacts: ArtifactStore, update = false): NativeTool {
  return async (manifest, args, send) => {
    const started = performance.now();
    const origin = new URL(manifest.origin).origin;
    const result = await shipToGitHub(
      {
        github: async (method, path, body) => {
          const url = new URL(path, origin);
          if (url.origin !== origin) throw new Error("refusing a request off the connector's origin");
          const response = await send({
            kind: "http",
            method,
            url: url.toString(),
            headers: { ...(manifest.headers ?? {}) },
            ...(body === undefined ? {} : { body: JSON.stringify(body) }),
            class: method === "GET" ? "read" : method === "PATCH" ? "modify" : "create",
            target: `${method} ${url.pathname}`,
          });
          let json: any = null;
          try {
            json = JSON.parse(response.body);
          } catch {
            /* not JSON: the status says enough */
          }
          return { status: response.status, json };
        },
        artifact: (id) => {
          const files = artifacts.filesOf(id);
          if (!files) return null;
          return {
            files,
            // What leaves for GitHub is exactly what was kept: each file is checked against its recorded SHA-256.
            read: (path) => {
              const bytes = artifacts.read(id, path).bytes;
              if (createHash("sha256").update(bytes).digest("hex") !== files.find((f) => f.path === path)?.sha256) throw new Error(`${path} isn't what was kept (its SHA-256 differs)`);
              return bytes;
            },
          };
        },
      },
      args,
      update,
    );
    return { ok: result.ok, status: result.status, contentType: "text/plain", body: result.receipt, truncated: false, durationMs: Math.round(performance.now() - started) };
  };
}

/**
 * What a quest leaves for shipping, run in the sandbox after the work (python3 is in the
 * workshop) as `python3 -c SCRIPT <repo> <out> [<base>]`: the starting commit, the remote, and every
 * change since, new files included. Prints how many files changed. The start is the clone's HEAD unless
 * `base` says where the work began: a knight's task works in a worktree of its own and may commit there,
 * and a commit of its own is no start GitHub has ever seen.
 */
export const SHIPMENT_SCRIPT = `import json, os, shutil, subprocess, sys
repo, out = sys.argv[1], sys.argv[2]
os.chdir(repo)
run = lambda *a: subprocess.check_output(["git", *a]).decode()
subprocess.check_call(["git", "add", "-A"])
base = run("rev-parse", "--verify", (sys.argv[3] if len(sys.argv) > 3 else "HEAD") + "^{commit}").strip()
remote = run("remote", "get-url", "origin").strip()
listed = run("diff", "--cached", "--name-status", "--no-renames", "-z", base).split("\\0")[:-1]
# Modes as git records them (100755 executable; 120000 a link and 160000 a submodule aren't shipped).
modes = {}
for entry in run("ls-files", "-s", "-z").split("\\0")[:-1]:
    meta, name = entry.split("\\t", 1)
    modes[name] = meta.split(" ")[0]
files = []
shutil.rmtree(out, ignore_errors=True)
for status, path in zip(listed[0::2], listed[1::2]):
    if status == "D":
        files.append({"path": path, "deleted": True})
        continue
    mode = modes.get(path)
    if mode not in ("100644", "100755") or not os.path.isfile(path):
        continue
    target = os.path.join(out, "files", path)
    os.makedirs(os.path.dirname(target), exist_ok=True)
    shutil.copyfile(path, target)
    files.append({"path": path, "mode": mode})
subprocess.check_call(["git", "reset", "-q"])
if files:
    os.makedirs(out, exist_ok=True)
    json.dump({"v": 1, "base": base, "remote": remote, "files": files}, open(os.path.join(out, "manifest.json"), "w"), indent=1)
print(len(files))`;
