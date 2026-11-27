import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { type ActionView, type RouteName, routes, type TeamSnapshot } from "@invincible/core";
import { foundFleet, LedgerStore } from "@invincible/ledger";
import type { Capabilities } from "../src/capabilities.ts";
import { type Daemon, startDaemon } from "../src/daemon.ts";
import { Home } from "../src/home.ts";
import { githubRepo, shipBranch } from "../src/run-cli.ts";
import { sameRepository, SHIPMENT_SCRIPT, type ShipDeps, shipToGitHub } from "@invincible/agents";
import { TeamStore } from "../src/team-store.ts";
import { freePort } from "./ports.ts";

/*
 * Shipping: a run's kept changes become a pull request. The shipper against a fake
 * GitHub; the gate end to end through a node (an agent asks, you approve, it ships
 * once, with the connector's key and nowhere else); and the script the sandbox runs,
 * on a real git repository.
 */

const enc = new TextEncoder();
const BASE = "a".repeat(40);
const REMOTE = "https://github.com/amiriteorg/shipyard.git";

function shipmentFiles(manifest: object, files: Record<string, string>): Record<string, Uint8Array> {
  const out: Record<string, Uint8Array> = { "ship/manifest.json": enc.encode(JSON.stringify(manifest)) };
  for (const [path, text] of Object.entries(files)) out[`ship/files/${path}`] = enc.encode(text);
  out["changes.patch"] = enc.encode("diff --git …");
  return out;
}

const SHIPMENT = shipmentFiles(
  {
    v: 1,
    base: BASE,
    remote: REMOTE,
    files: [
      { path: "src/units.ts", mode: "100644" },
      { path: "bin/run", mode: "100755" },
      { path: "old.txt", deleted: true },
    ],
  },
  { "src/units.ts": "export const k = 1e3;\n", "bin/run": "#!/bin/sh\nbun src/units.ts\n" },
);

function fakeGitHub(options: { branchExists?: boolean; prFails?: boolean; heads?: Record<string, string>; moveFails?: boolean } = {}) {
  const calls: { method: string; path: string; body?: any }[] = [];
  let blobs = 0;
  // Where each branch stands: a new one where it was made, one moved where it was moved to.
  const heads: Record<string, string> = { ...options.heads };
  const github: ShipDeps["github"] = async (method, path, body) => {
    calls.push({ method, path, ...(body === undefined ? {} : { body }) });
    if (method === "GET" && path.includes("/git/ref/heads/")) {
      const branch = decodeURIComponent(path.split("/git/ref/heads/")[1]!);
      const at = heads[branch];
      return at ? { status: 200, json: { ref: `refs/heads/${branch}`, object: { sha: at, type: "commit" } } } : { status: options.branchExists ? 200 : 404, json: {} };
    }
    if (method === "PATCH" && path.includes("/git/refs/heads/")) {
      if (options.moveFails) return { status: 422, json: { message: "Update is not a fast forward" } };
      heads[decodeURIComponent(path.split("/git/refs/heads/")[1]!)] = (body as { sha: string }).sha;
      return { status: 200, json: {} };
    }
    if (method === "GET" && path.split("?")[0]!.endsWith("/pulls")) return { status: 200, json: [{ number: 7, html_url: "https://github.com/amiriteorg/shipyard/pull/7" }] };
    if (method === "GET" && path === "/repos/amiriteorg/shipyard") return { status: 200, json: { full_name: "amiriteorg/shipyard", private: false, fork: false, default_branch: "main", owner: { login: "amiriteorg", id: 600, type: "Organization" } } };
    // Whose the key is (a person's account, by its id), a private repository of it, an organization's, and two threads:
    // one opened under your account, one by someone else.
    if (method === "GET" && path === "/user") return { status: 200, json: { login: "lin-example", id: 501, type: "User" } };
    if (method === "GET" && path === "/repos/lin-example/notes") return { status: 200, json: { full_name: "lin-example/notes", private: true, fork: false, default_branch: "main", owner: { login: "lin-example", id: 501, type: "User" } } };
    if (method === "GET" && path === "/repos/amiriteorg/docs") return { status: 200, json: { full_name: "amiriteorg/docs", private: true, fork: false, default_branch: "main", owner: { login: "amiriteorg", id: 600, type: "Organization" } } };
    if (method === "GET" && path === "/repos/lin-example/notes/issues/4") return { status: 200, json: { number: 4, user: { id: 501 } } };
    if (method === "GET" && path === "/repos/lin-example/notes/issues/5") return { status: 200, json: { number: 5, user: { id: 777 } } };
    if (method === "POST" && path.endsWith("/issues")) return { status: 201, json: { number: 4, html_url: "https://github.com/lin-example/notes/issues/4" } };
    if (method === "POST" && path.endsWith("/comments")) return { status: 201, json: { id: 1 } };
    // Any commit the repository has (where main stood, a commit the node pushed): its tree.
    if (method === "GET" && /^\/repos\/amiriteorg\/shipyard\/git\/commits\/[0-9a-f]{40}$/.test(path)) return { status: 200, json: { tree: { sha: "f".repeat(40) } } };
    if (path.endsWith("/git/blobs")) return { status: 201, json: { sha: String(++blobs).padStart(40, "b") } };
    if (path.endsWith("/git/trees")) return { status: 201, json: { sha: "e".repeat(40) } };
    if (path.endsWith("/git/commits")) return { status: 201, json: { sha: "c".repeat(40) } };
    if (path.endsWith("/git/refs")) {
      const made = body as { ref: string; sha: string };
      heads[made.ref.replace(/^refs\/heads\//, "")] = made.sha;
      return { status: 201, json: {} };
    }
    if (path.endsWith("/pulls"))
      return options.prFails
        ? { status: 422, json: { message: "Validation Failed", errors: [{ message: "No commits between main and invincible/units" }] } }
        : { status: 201, json: { number: 7, html_url: "https://github.com/amiriteorg/shipyard/pull/7" } };
    return { status: 404, json: {} };
  };
  return { calls, github, posts: () => calls.filter((c) => c.method === "POST") };
}

const kept = (files: Record<string, Uint8Array>): ShipDeps["artifact"] => (id) =>
  id === "art_AAAAAAAAAAAAAAAAAAAAAA"
    ? { files: Object.entries(files).map(([path, bytes]) => ({ path, size: bytes.length })), read: (path) => files[path]! }
    : null;

const ARGS = { owner: "amiriteorg", repo: "shipyard", artifact: "art_AAAAAAAAAAAAAAAAAAAAAA", branch: "invincible/units", title: "Parse SI units", body: "40 tests pass." };

describe("shipping to GitHub", () => {
  test("blobs, one tree on the starting commit (deletions included), one commit, a new branch, the pull request", async () => {
    const gh = fakeGitHub();
    const result = await shipToGitHub({ github: gh.github, artifact: kept(SHIPMENT) }, ARGS);
    expect(result).toMatchObject({ ok: true, status: 201, url: "https://github.com/amiriteorg/shipyard/pull/7" });
    expect(result.receipt).toContain("pull request #7");
    expect(gh.calls.map((c) => `${c.method} ${c.path}`)).toEqual([
      "GET /repos/amiriteorg/shipyard/git/ref/heads/invincible/units",
      "GET /repos/amiriteorg/shipyard",
      `GET /repos/amiriteorg/shipyard/git/commits/${BASE}`,
      "POST /repos/amiriteorg/shipyard/git/blobs",
      "POST /repos/amiriteorg/shipyard/git/blobs",
      "POST /repos/amiriteorg/shipyard/git/trees",
      "POST /repos/amiriteorg/shipyard/git/commits",
      "POST /repos/amiriteorg/shipyard/git/refs",
      "POST /repos/amiriteorg/shipyard/pulls",
    ]);
    const [blob] = gh.posts();
    expect(Buffer.from(blob!.body.content, "base64").toString()).toBe("export const k = 1e3;\n");
    const tree = gh.posts().find((c) => c.path.endsWith("/git/trees"))!.body;
    expect(tree.base_tree).toBe("f".repeat(40));
    expect(tree.tree).toEqual([
      { path: "src/units.ts", mode: "100644", type: "blob", sha: "1".padStart(40, "b") },
      { path: "bin/run", mode: "100755", type: "blob", sha: "2".padStart(40, "b") },
      { path: "old.txt", mode: "100644", type: "blob", sha: null },
    ]);
    expect(gh.posts().find((c) => c.path.endsWith("/git/commits"))!.body).toEqual({ message: "Parse SI units\n\n40 tests pass.", tree: "e".repeat(40), parents: [BASE] });
    expect(gh.posts().find((c) => c.path.endsWith("/git/refs"))!.body).toEqual({ ref: "refs/heads/invincible/units", sha: "c".repeat(40) });
    expect(gh.posts().at(-1)!.body).toEqual({ title: "Parse SI units", head: "invincible/units", base: "main", body: "40 tests pass." });
  });

  test("an existing branch is never touched", async () => {
    const gh = fakeGitHub({ branchExists: true });
    expect(await shipToGitHub({ github: gh.github, artifact: kept(SHIPMENT) }, ARGS)).toMatchObject({ ok: false, status: 409 });
    expect(gh.posts()).toEqual([]);
  });

  test("work done on another repository, a file it doesn't hold, or an unsafe path: nothing is sent", async () => {
    for (const files of [
      shipmentFiles({ v: 1, base: BASE, remote: "https://github.com/someone/else", files: [{ path: "a.ts" }] }, { "a.ts": "x" }),
      shipmentFiles({ v: 1, base: BASE, remote: REMOTE, files: [{ path: "a.ts" }] }, {}),
      shipmentFiles({ v: 1, base: BASE, remote: REMOTE, files: [{ path: "../etc/passwd" }] }, { "../etc/passwd": "x" }),
      shipmentFiles({ v: 1, base: BASE, remote: REMOTE, files: [{ path: ".git/config" }] }, { ".git/config": "x" }),
    ]) {
      const gh = fakeGitHub();
      const result = await shipToGitHub({ github: gh.github, artifact: kept(files) }, ARGS);
      expect(result).toMatchObject({ ok: false, status: 422 });
      expect(gh.calls).toEqual([]);
    }
    expect((await shipToGitHub({ github: fakeGitHub().github, artifact: () => null }, ARGS)).status).toBe(404);
  });

  test("a pull request GitHub refuses says what was done and what wasn't", async () => {
    const result = await shipToGitHub({ github: fakeGitHub({ prFails: true }).github, artifact: kept(SHIPMENT) }, ARGS);
    expect(result.ok).toBe(false);
    expect(result.receipt).toContain("committed 3 files on invincible/units");
    expect(result.receipt).toContain("No commits between main and invincible/units");
  });

  const UPDATE = { owner: "amiriteorg", repo: "shipyard", artifact: "art_AAAAAAAAAAAAAAAAAAAAAA", branch: "invincible/units", title: "Fix the failing checks", body: "Made by @noa." };

  test("a fix goes on top of the branch it began on: one commit on where the branch stands, the branch moved forward (never forced), the pull request on it named", async () => {
    const gh = fakeGitHub({ heads: { "invincible/units": BASE } });
    const result = await shipToGitHub({ github: gh.github, artifact: kept(SHIPMENT) }, UPDATE, true);
    expect(result).toMatchObject({ ok: true, status: 200, url: "https://github.com/amiriteorg/shipyard/pull/7" });
    expect(result.receipt).toBe(`3 files pushed onto invincible/units, commit ${"c".repeat(40)}: pull request #7 updated, https://github.com/amiriteorg/shipyard/pull/7`);
    expect(gh.calls.map((c) => `${c.method} ${c.path}`)).toEqual([
      "GET /repos/amiriteorg/shipyard/git/ref/heads/invincible/units",
      `GET /repos/amiriteorg/shipyard/git/commits/${BASE}`,
      "POST /repos/amiriteorg/shipyard/git/blobs",
      "POST /repos/amiriteorg/shipyard/git/blobs",
      "POST /repos/amiriteorg/shipyard/git/trees",
      "POST /repos/amiriteorg/shipyard/git/commits",
      "PATCH /repos/amiriteorg/shipyard/git/refs/heads/invincible/units",
      "GET /repos/amiriteorg/shipyard/pulls?head=amiriteorg:invincible%2Funits&state=open&per_page=1",
    ]);
    expect(gh.posts().find((c) => c.path.endsWith("/git/commits"))!.body).toEqual({ message: "Fix the failing checks\n\nMade by @noa.", tree: "e".repeat(40), parents: [BASE] });
    expect(gh.calls.find((c) => c.method === "PATCH")!.body).toEqual({ sha: "c".repeat(40), force: false });
  });

  test("a branch that moved since the fix began, or that isn't there, is never pushed onto", async () => {
    const moved = fakeGitHub({ heads: { "invincible/units": "d".repeat(40) } });
    const result = await shipToGitHub({ github: moved.github, artifact: kept(SHIPMENT) }, UPDATE, true);
    expect(result).toMatchObject({ ok: false, status: 409 });
    expect(result.receipt).toBe(`invincible/units has moved since the work began (from ${BASE.slice(0, 12)} to ${"d".repeat(12)}): nothing was pushed`);
    expect(moved.calls.filter((c) => c.method !== "GET")).toEqual([]);
    const gone = fakeGitHub();
    expect(await shipToGitHub({ github: gone.github, artifact: kept(SHIPMENT) }, UPDATE, true)).toMatchObject({ ok: false, status: 404 });
    expect(gone.calls.filter((c) => c.method !== "GET")).toEqual([]);
  });

  test("a move GitHub refuses (it wasn't forward) says what was committed, and that the branch stayed where it was", async () => {
    const result = await shipToGitHub({ github: fakeGitHub({ heads: { "invincible/units": BASE }, moveFails: true }).github, artifact: kept(SHIPMENT) }, UPDATE, true);
    expect(result.ok).toBe(false);
    expect(result.receipt).toBe(`committed 3 files (${"c".repeat(12)}), but invincible/units wasn't moved onto it: Update is not a fast forward`);
  });

  test("a file that fails its check stops the shipment", async () => {
    const result = await shipToGitHub(
      {
        github: fakeGitHub().github,
        artifact: () => ({ files: Object.entries(SHIPMENT).map(([path, b]) => ({ path, size: b.length })), read: (path) => {
          if (path === "ship/files/bin/run") throw new Error("ship/files/bin/run isn't what was kept (its SHA-256 differs)");
          return SHIPMENT[path]!;
        } }),
      },
      ARGS,
    );
    expect(result).toMatchObject({ ok: false, status: 500 });
    expect(result.receipt).toContain("SHA-256 differs");
  });

  test("repositories and branch names", () => {
    expect(sameRepository("https://github.com/AmiriteOrg/Shipyard.git", "amiriteorg", "shipyard")).toBe(true);
    expect(sameRepository("git@github.com:amiriteorg/shipyard.git", "amiriteorg", "shipyard")).toBe(true);
    expect(sameRepository("https://github.com/amiriteorg/shipyard-evil", "amiriteorg", "shipyard")).toBe(false);
    expect(sameRepository("https://gitlab.com/amiriteorg/shipyard", "amiriteorg", "shipyard")).toBe(false);
    expect(githubRepo("https://github.com/amiriteorg/invincible.git")).toEqual({ owner: "amiriteorg", repo: "invincible" });
    expect(githubRepo("https://example.com/a/b")).toBeNull();
    expect(shipBranch("Parse SI units, with tests!", "q-mwafrqc4")).toBe("invincible/parse-si-units-with-tests-mwafrqc4");
  });
});

describe("the shipment the sandbox leaves", () => {
  const have = (cmd: string[]) => {
    try {
      return Bun.spawnSync(cmd).exitCode === 0;
    } catch {
      return false;
    }
  };
  const python = have(["python3", "--version"]) && have(["git", "--version"]);

  test.skipIf(!python)("every change since the clone: new, changed, executable and deleted files", () => {
    const dir = mkdtempSync(join(tmpdir(), "invincible-ship-"));
    try {
      const repo = join(dir, "repo");
      const git = (...a: string[]) => Bun.spawnSync(["git", "-C", repo, "-c", "user.email=t@t", "-c", "user.name=t", ...a]);
      mkdirSync(repo);
      git("init", "-q");
      git("config", "core.autocrlf", "false");
      writeFileSync(join(repo, "keep.txt"), "same\n");
      writeFileSync(join(repo, "old.txt"), "going\n");
      writeFileSync(join(repo, "calc.py"), "a - b\n");
      git("add", "-A");
      git("commit", "-qm", "init");
      git("remote", "add", "origin", REMOTE);
      const base = git("rev-parse", "HEAD").stdout.toString().trim();
      writeFileSync(join(repo, "calc.py"), "a + b\n");
      rmSync(join(repo, "old.txt"));
      mkdirSync(join(repo, "bin"));
      writeFileSync(join(repo, "bin", "run"), "#!/bin/sh\n", { mode: 0o755 });
      const out = join(dir, "out", "ship");
      const run = Bun.spawnSync(["python3", "-c", SHIPMENT_SCRIPT, repo, out]);
      expect({ exit: run.exitCode, stderr: run.exitCode ? run.stderr.toString() : "" }).toEqual({ exit: 0, stderr: "" });
      expect(run.stdout.toString().trim()).toBe("3");
      const manifest = JSON.parse(require("node:fs").readFileSync(join(out, "manifest.json"), "utf8"));
      expect(manifest).toMatchObject({ v: 1, base, remote: REMOTE });
      expect(manifest.files).toEqual(
        expect.arrayContaining([
          { path: "calc.py", mode: "100644" },
          { path: "old.txt", deleted: true },
          { path: "bin/run", mode: process.platform === "win32" ? "100644" : "100755" },
        ]),
      );
      expect(require("node:fs").readFileSync(join(out, "files", "calc.py"), "utf8")).toBe("a + b\n");
      // The repository is as the agent left it (nothing staged).
      expect(git("diff", "--cached", "--name-only").stdout.toString()).toBe("");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test.skipIf(!python)("told where the work began, it ships what was committed since as well as what wasn't: an agent in its own worktree may commit", () => {
    const dir = mkdtempSync(join(tmpdir(), "invincible-ship-"));
    try {
      const repo = join(dir, "repo");
      const git = (...a: string[]) => Bun.spawnSync(["git", "-C", repo, "-c", "user.email=t@t", "-c", "user.name=t", ...a]);
      mkdirSync(repo);
      git("init", "-q");
      git("config", "core.autocrlf", "false");
      writeFileSync(join(repo, "calc.py"), "a - b\n");
      git("add", "-A");
      git("commit", "-qm", "init");
      git("remote", "add", "origin", REMOTE);
      const base = git("rev-parse", "HEAD").stdout.toString().trim();
      // The engineer fixed one file and committed it, then wrote another and did not.
      writeFileSync(join(repo, "calc.py"), "a + b\n");
      git("commit", "-qam", "fix the sum");
      const tip = git("rev-parse", "HEAD").stdout.toString().trim();
      writeFileSync(join(repo, "notes.md"), "why\n");
      const read = (out: string) => JSON.parse(require("node:fs").readFileSync(join(out, "manifest.json"), "utf8"));
      // From its own HEAD the script sees only what was not committed, and names the engineer's commit as the start:
      // a commit GitHub has never seen.
      const alone = join(dir, "alone", "ship");
      expect(Bun.spawnSync(["python3", "-c", SHIPMENT_SCRIPT, repo, alone]).stdout.toString().trim()).toBe("1");
      expect(read(alone).base).toBe(tip);
      // Told the commit the work began from, it ships everything since, from that commit.
      const out = join(dir, "out", "ship");
      const run = Bun.spawnSync(["python3", "-c", SHIPMENT_SCRIPT, repo, out, base]);
      expect({ exit: run.exitCode, stderr: run.exitCode ? run.stderr.toString() : "" }).toEqual({ exit: 0, stderr: "" });
      expect(run.stdout.toString().trim()).toBe("2");
      expect(read(out)).toMatchObject({ v: 1, base, remote: REMOTE });
      expect(read(out).files.map((f: { path: string }) => f.path).sort()).toEqual(["calc.py", "notes.md"]);
      expect(require("node:fs").readFileSync(join(out, "files", "calc.py"), "utf8")).toBe("a + b\n");
      // The worktree is as the engineer left it: its commit, and nothing staged.
      expect(git("rev-parse", "HEAD").stdout.toString().trim()).toBe(tip);
      expect(git("diff", "--cached", "--name-only").stdout.toString()).toBe("");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("the gate, end to end", () => {
  const caps: Capabilities = { os: "linux", arch: "x64", hostname: "ship", cores: 4, cpu: "t", memoryGb: 8, hasBattery: false, gpu: [], docker: false, vm: { kvm: false, tools: [] }, tools: [], localModels: [], tailscale: null };
  const root = mkdtempSync(join(tmpdir(), "invincible-shipgate-"));
  const home = new Home(join(root, "node"));
  const port = freePort();
  const TOKEN = "github_pat_FAKEFAKEFAKEFAKE0000_fakefakefakefakefakefakefakefakefakefakefakefake";
  const seen: { method: string; url: string; auth: string | null }[] = [];
  // Your default branch stands where the shipments began, and so does the pull request's branch a fix begins on.
  const gh = fakeGitHub({ heads: { main: BASE, "invincible/fixing": BASE } });
  let daemon: Daemon;
  let armToken: string;
  let artifact: string;
  const send = (token: string, name: RouteName, input?: unknown) =>
    fetch(`http://127.0.0.1:${port}${routes[name].path}`, {
      method: routes[name].method,
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: routes[name].method === "POST" ? JSON.stringify(input ?? {}) : undefined,
    }).then(async (r) => ({ status: r.status, body: (await r.json()) as any }));

  beforeAll(async () => {
    const { identity, keystore } = await home.createIdentity("file");
    const store = new LedgerStore(home.ledgerPath);
    const fleet = foundFleet(store, identity, { fleetName: "homelab", nodeName: "ultra" });
    store.close();
    home.writeConfig({ v: 1, name: "ultra", fleet, port, keystore, advertise: "127.0.0.1" });
    // GitHub, as the node's fetch sees it.
    const fakeFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      seen.push({ method: init?.method ?? "GET", url: url.toString(), auth: new Headers(init?.headers).get("authorization") });
      if (url.origin !== "https://api.github.com") return new Response("{}", { status: 404 });
      const answer = await gh.github((init?.method ?? "GET") as "GET" | "POST" | "PATCH", url.pathname, init?.body ? JSON.parse(String(init.body)) : undefined);
      return Response.json(answer.json, { status: answer.status });
    }) as typeof fetch;
    daemon = await startDaemon(home, { capabilities: caps, proxyPort: freePort(), log: () => {}, fetch: fakeFetch });
    armToken = (await send(home.adminToken(), "mintArm", { label: "coder" })).body.token;
    expect((await send(home.adminToken(), "setConnector", { id: "github" })).status).toBe(200);
    expect((await send(home.adminToken(), "setSecret", { name: "github", value: TOKEN, provider: "github" })).status).toBe(200);
    const collector = async (_s: string, _f: string, dest: string) => {
      const out = { files: [] as { path: string; size: number; sha256: string }[], bytes: 0, skipped: [] as { path: string; reason: string }[] };
      for (const [path, bytes] of Object.entries(SHIPMENT)) {
        const target = join(dest, ...path.split("/"));
        mkdirSync(dirname(target), { recursive: true });
        writeFileSync(target, bytes);
        out.files.push({ path, size: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") });
        out.bytes += bytes.length;
      }
      return out;
    };
    artifact = (await daemon.artifacts.save(collector, { sandbox: "0123456789", label: "units" })).artifact!.id;
  });
  afterAll(async () => {
    await daemon?.stop();
    rmSync(root, { recursive: true, force: true });
  });
  /** Kept work holding a shipment of these files, built on `base`. */
  const keep = async (label: string, files: { path: string; mode?: string; deleted?: boolean }[], base = BASE) => {
    const contents = Object.fromEntries(files.filter((f) => !f.deleted).map((f) => [f.path, `// ${f.path}\n`]));
    const all = shipmentFiles({ v: 1, base, remote: REMOTE, files: files.map((f) => (f.deleted ? f : { mode: "100644", ...f })) }, contents);
    const collector = async (_s: string, _f: string, dest: string) => {
      const out = { files: [] as { path: string; size: number; sha256: string }[], bytes: 0, skipped: [] as { path: string; reason: string }[] };
      for (const [path, bytes] of Object.entries(all)) {
        const target = join(dest, ...path.split("/"));
        mkdirSync(dirname(target), { recursive: true });
        writeFileSync(target, bytes);
        out.files.push({ path, size: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") });
        out.bytes += bytes.length;
      }
      return out;
    };
    return (await daemon.artifacts.save(collector, { sandbox: "0123456789", label })).artifact!.id;
  };

  test("an agent's shipment waits for you; approved, it ships once, with the key and only to GitHub", async () => {
    const args = { ...ARGS, artifact };
    const asked = await send(armToken, "callConnector", { connector: "github", tool: "ship", args, why: "40 tests pass" });
    expect(asked.status).toBe(200);
    expect(asked.body).toMatchObject({ status: "asked", class: "outward" });
    expect(seen).toEqual([]); // nothing left before you answered
    // Arms can't answer; you can.
    expect((await send(armToken, "decideAction", { id: asked.body.action, approve: true })).status).toBe(403);
    const decided = await send(home.adminToken(), "decideAction", { id: asked.body.action, approve: true });
    expect(decided.status).toBe(200);
    const actions = (await send(home.adminToken(), "actions")).body.actions as ActionView[];
    const action = actions.find((a) => a.id === asked.body.action)!;
    expect(action.state).toBe("done");
    expect(action.receipt).toContain("pull request #7");
    expect(seen.every((s) => s.url.startsWith("https://api.github.com/") && s.auth === `Bearer ${TOKEN}`)).toBe(true);
    expect(seen.filter((s) => s.method === "POST" && s.url.endsWith("/pulls"))).toHaveLength(1);
    // Approving again sends nothing more.
    const before = seen.length;
    await send(home.adminToken(), "decideAction", { id: asked.body.action, approve: true });
    expect(seen.length).toBe(before);
  });

  test("you can ask to be asked: your own call, filed for approval", async () => {
    const filed = await send(home.adminToken(), "callConnector", { connector: "github", tool: "ship", args: { ...ARGS, artifact, branch: "invincible/second" }, ask: {} });
    expect(filed.body).toMatchObject({ status: "asked" });
  });

  test("a branch the catalog's pattern doesn't allow is refused before anything is filed", async () => {
    const bad = await send(armToken, "callConnector", { connector: "github", tool: "ship", args: { ...ARGS, artifact, branch: "main" } });
    expect(bad.status).toBe(400);
    expect(bad.body.error).toMatch(/branch doesn't match/);
  });

  test("an agent's verified work ships from an app in one tap: filed as the agent's ship and answered by you, so it is followed after; said on the task; once", async () => {
    // The node's team, as an agent's run leaves it: a verified task whose work is kept here.
    const team = new TeamStore(join(home.dir, "team.db"));
    let id: string;
    try {
      team.saveAgent({ id: "noa", name: "Noa", repository: "https://github.com/amiriteorg/shipyard" });
      const work = team.createTask({ room: team.direct("noa").id, assignee: "noa", title: "Parse SI units", goal: "Parse them." });
      team.finish(work.id, "done", null, { verified: true, output: "Units parse, kilo to giga.\n\nReview: PASS", changes: { artifact, files: 3, base: BASE } });
      id = work.id;
    } finally {
      team.close();
    }
    const before = seen.length;
    const shipped = await send(home.adminToken(), "shipTeamTask", { task: id, title: "Parse SI units" });
    expect(shipped.status).toBe(200);
    expect(shipped.body).toMatchObject({ url: "https://github.com/amiriteorg/shipyard/pull/7", pr: 7 });
    expect(seen.slice(before).filter((s) => s.method === "POST" && s.url.endsWith("/pulls"))).toHaveLength(1);
    // In the outbox as the agent's, answered by you: what the CI watcher follows.
    const actions = (await send(home.adminToken(), "actions")).body.actions as ActionView[];
    const filed = actions.find((a) => a.tool === "ship" && a.state === "done" && a.by.endsWith(".noa"));
    // Your tap is your approval, recorded as yours, though the repository is one you gave an agent.
    expect(filed?.self).toBe(false);
    expect(filed?.args).toMatchObject({ owner: "amiriteorg", repo: "shipyard", artifact, title: "Parse SI units", branch: `invincible/parse-si-units-${id.slice(-8)}` });
    expect(String(filed?.args.body)).toStartWith("Units parse, kilo to giga.");
    // Said on the task, and not offered again.
    const task = ((await send(home.adminToken(), "team")).body as TeamSnapshot).tasks.find((t) => t.id === id);
    expect(task?.shipped).toEqual({ url: "https://github.com/amiriteorg/shipyard/pull/7", pr: 7 });
    expect((await send(home.adminToken(), "shipTeamTask", { task: id })).status).toBe(409);
    // Yours alone: an agent may not.
    expect((await send(armToken, "shipTeamTask", { task: id })).status).toBe(403);
  });

  test("a fix onto its pull request's branch goes through the same gate: it waits for you; approved, the branch moves forward once and no new pull request opens", async () => {
    const fix = { owner: "amiriteorg", repo: "shipyard", artifact, branch: "invincible/fixing", title: "Fix the failing checks" };
    const asked = await send(armToken, "callConnector", { connector: "github", tool: "ship.update", args: fix, why: "its checks failed" });
    expect(asked.body).toMatchObject({ status: "asked", class: "outward", target: "PATCH /repos/amiriteorg/shipyard/git/refs/heads/invincible%2Ffixing (ship.update)" });
    const before = seen.length;
    expect((await send(home.adminToken(), "decideAction", { id: asked.body.action, approve: true })).status).toBe(200);
    const action = ((await send(home.adminToken(), "actions")).body.actions as ActionView[]).find((a) => a.id === asked.body.action)!;
    expect(action.state).toBe("done");
    expect(action.receipt).toBe(`200 3 files pushed onto invincible/fixing, commit ${"c".repeat(40)}: pull request #7 updated, https://github.com/amiriteorg/shipyard/pull/7`);
    const sent = seen.slice(before);
    expect(sent.filter((s) => s.method === "PATCH").map((s) => s.url)).toEqual(["https://api.github.com/repos/amiriteorg/shipyard/git/refs/heads/invincible/fixing"]);
    expect(sent.some((s) => s.method === "POST" && (s.url.endsWith("/pulls") || s.url.endsWith("/git/refs")))).toBe(false);
    expect(sent.every((s) => s.url.startsWith("https://api.github.com/") && s.auth === `Bearer ${TOKEN}`)).toBe(true);
    // Never onto a branch that isn't the primary's own.
    const main = await send(armToken, "callConnector", { connector: "github", tool: "ship.update", args: { ...fix, branch: "main" } });
    expect(main.status).toBe(400);
    expect(main.body.error).toMatch(/branch doesn't match/);
  });

  // Your word, 23 November 2026: it approves its own decisions and its agents'; what is monetary, legal or destructive
  // still asks you (policy.ts ownApproval).
  test("its agents' work in the repository you gave them is its to approve: sent at once, and said to be its", async () => {
    const team = new TeamStore(join(home.dir, "team.db"));
    try {
      team.saveAgent({ id: "liv", name: "Liv", repository: "https://github.com/amiriteorg/shipyard" });
    } finally {
      team.close();
    }
    const agent = { kind: "agent" as const, by: "team.0123456789.liv" };
    const actions = async () => (await send(home.adminToken(), "actions")).body.actions as ActionView[];
    const why = "a pull request of the work on a new branch invincible/its-own, built on main as it stands, in amiriteorg/shipyard, a repository you gave an agent";
    let before = seen.length;
    const shipped = await daemon.connectors.call({ connector: "github", tool: "ship", args: { ...ARGS, artifact, branch: "invincible/its-own" }, why: "its gates and its reviewer passed" }, agent);
    expect(shipped.status).toBe("done");
    expect(shipped.status === "done" && shipped.own).toBe(why);
    expect(seen.slice(before).filter((s) => s.method === "POST" && s.url.endsWith("/pulls"))).toHaveLength(1);
    // Where main stands was asked of GitHub just before, with the key: the shipment is built on it.
    expect(seen.slice(before, before + 2).map((s) => `${s.method} ${s.url}`)).toEqual(["GET https://api.github.com/repos/amiriteorg/shipyard", "GET https://api.github.com/repos/amiriteorg/shipyard/git/ref/heads/main"]);
    const filed = (await actions()).find((a) => a.id === (shipped.status === "done" ? shipped.action : ""))!;
    expect([filed.state, filed.self, filed.note]).toEqual(["done", true, `Your agent approved it itself: ${why}`]);
    // A fix pushed onto a branch it shipped (invincible/fixing, by your approval, earlier), from the commit it last pushed
    // there, likewise.
    const fixed = await keep("fix", [{ path: "src/units.ts" }], "c".repeat(40));
    before = seen.length;
    const pushed = await daemon.connectors.call({ connector: "github", tool: "ship.update", args: { owner: "amiriteorg", repo: "shipyard", artifact: fixed, branch: "invincible/fixing", title: "Fix the failing checks" }, why: "its checks failed" }, agent);
    expect(pushed.status === "done" && pushed.own).toBe("a fix pushed onto invincible/fixing, a branch it shipped, from where it last pushed it, in amiriteorg/shipyard, a repository you gave an agent");
    expect(seen.slice(before).filter((s) => s.method === "PATCH")).toHaveLength(1);
    // A fix that began on another commit than the one it last pushed there waits for you.
    expect((await daemon.connectors.call({ connector: "github", tool: "ship.update", args: { owner: "amiriteorg", repo: "shipyard", artifact, branch: "invincible/fixing", title: "Fix" } }, agent)).status).toBe("asked");
    // Its own tools in chat: a pull request from the branch it shipped, into main.
    const opened = await daemon.connectors.call({ connector: "github", tool: "pr.create", args: { owner: "amiriteorg", repo: "shipyard", head: "invincible/its-own", base: "main", title: "Parse SI units" } }, { kind: "agent", by: "arm:primary" });
    expect(opened.status === "done" && opened.own).toBe("a pull request from invincible/its-own, a branch it shipped, into main, in amiriteorg/shipyard, a repository you gave an agent");
    // Its agent's own call, from its VM (arm:team.…: a name no token you mint can take, and none older authenticates as):
    // the same rule, its to approve from a branch it shipped; from one it didn't, it waits for you.
    before = seen.length;
    const agents = await daemon.connectors.call({ connector: "github", tool: "pr.create", args: { owner: "amiriteorg", repo: "shipyard", head: "invincible/its-own", base: "main", title: "Units in the docs" } }, { kind: "agent", by: "arm:team.0123456789.liv" });
    expect(agents.status === "done" && agents.own).toStartWith("a pull request from invincible/its-own, a branch it shipped");
    expect(seen.slice(before).filter((s) => s.method === "POST" && s.url.endsWith("/pulls"))).toHaveLength(1);
    expect((await daemon.connectors.call({ connector: "github", tool: "pr.create", args: { owner: "amiriteorg", repo: "shipyard", head: "invincible/liv-own", base: "main", title: "Units in the docs" } }, { kind: "agent", by: "arm:team.0123456789.liv" })).status).toBe("asked");
  });

  // Your word, 27 November 2026, as the review of 27 November drew it: in a private repository of yours its own threads
  // are its to speak in; anyone else's thread, an organization's place, and its agents' and loops' calls are yours.
  test("in a private repository of yours the primary itself speaks on its own threads: GitHub is asked first whose the key is, the repository and the thread; anyone else's thread, an organization's repository and its agents' calls wait for you", async () => {
    const before = seen.length;
    const primary = { kind: "agent" as const, by: "arm:primary" };
    const issue = await daemon.connectors.call({ connector: "github", tool: "issue.create", args: { owner: "lin-example", repo: "notes", title: "Units in the docs" } }, primary);
    expect(issue.status === "done" && issue.own).toBe("an issue in lin-example/notes, a private repository of yours");
    const comment = await daemon.connectors.call({ connector: "github", tool: "issue.comment", args: { owner: "lin-example", repo: "notes", number: 4, body: "Done in #5." } }, primary);
    expect(comment.status === "done" && comment.own).toBe("a comment on its own thread #4 in lin-example/notes, a private repository of yours");
    const filed = ((await send(home.adminToken(), "actions")).body.actions as ActionView[]).find((a) => a.id === (issue.status === "done" ? issue.action : ""))!;
    expect([filed.state, filed.self, filed.note]).toEqual(["done", true, "Your agent approved it itself: an issue in lin-example/notes, a private repository of yours"]);
    // Asked of GitHub, with the key, before each was filed; then what it sent.
    expect(seen.slice(before).map((s) => `${s.method} ${s.url} ${s.auth === `Bearer ${TOKEN}`}`)).toEqual([
      "GET https://api.github.com/user true",
      "GET https://api.github.com/repos/lin-example/notes true",
      "POST https://api.github.com/repos/lin-example/notes/issues true",
      "GET https://api.github.com/repos/lin-example/notes true",
      "GET https://api.github.com/repos/lin-example/notes/issues/4 true",
      "POST https://api.github.com/repos/lin-example/notes/issues/4/comments true",
    ]);
    // Someone else's thread, an organization's repository, its agents' own calls from their VMs: they wait, nothing is sent.
    const after = seen.length;
    expect((await daemon.connectors.call({ connector: "github", tool: "issue.comment", args: { owner: "lin-example", repo: "notes", number: 5, body: "Thanks." } }, primary)).status).toBe("asked");
    expect((await daemon.connectors.call({ connector: "github", tool: "issue.create", args: { owner: "amiriteorg", repo: "docs", title: "Units" } }, primary)).status).toBe("asked");
    expect((await daemon.connectors.call({ connector: "github", tool: "issue.comment", args: { owner: "lin-example", repo: "notes", number: 4, body: "Me too." } }, { kind: "agent", by: "arm:team.0123456789.liv" })).status).toBe("asked");
    // A tool you run with a token of its own isn't its anywhere.
    expect((await daemon.connectors.call({ connector: "github", tool: "issue.create", args: { owner: "lin-example", repo: "notes", title: "Units" } }, { kind: "agent", by: "arm:coder" })).status).toBe("asked");
    expect(seen.slice(after).filter((s) => s.method !== "GET")).toEqual([]);
  });

  test("a shipment that changes what the repository's CI runs, or isn't built on your default branch's head, waits for you, in a repository you gave an agent too: it would run with the repository's secrets", async () => {
    // (The repository is one you gave an agent: its work that changes no CI, on main as it stands, is its own to ship there.)
    const team = new TeamStore(join(home.dir, "team.db"));
    try {
      team.saveAgent({ id: "liv", name: "Liv", repository: "https://github.com/amiriteorg/shipyard" });
    } finally {
      team.close();
    }
    const liv = { kind: "agent" as const, by: "team.0123456789.liv" };
    const clean = await daemon.connectors.call({ connector: "github", tool: "ship", args: { ...ARGS, artifact, branch: "invincible/no-ci" }, why: "its gates and its reviewer passed" }, liv);
    expect(clean.status).toBe("done");
    const yours = {
      // A workflow, added or changed.
      "invincible/with-ci": await keep("units-ci", [{ path: "src/units.ts" }, { path: ".github/workflows/ci.yml" }]),
      // The workflows' folder itself, deleted (everything in it goes).
      "invincible/no-workflows": await keep("units-no-ci", [{ path: "src/units.ts" }, { path: ".github/workflows", deleted: true }]),
      // A local action at the root (uses: ./), which a workflow runs with the inputs it passes, secrets too.
      "invincible/action": await keep("units-action", [{ path: "action.yml" }]),
      // Built on a contributor's pull request's head (GitHub keeps it as refs/pull/7/head): the branch would carry their
      // workflows, though the shipment lists one source file.
      "invincible/on-theirs": await keep("units-theirs", [{ path: "src/units.ts" }], "7".repeat(40)),
    };
    const before = seen.length;
    for (const [branch, work] of Object.entries(yours)) {
      const shipped = await daemon.connectors.call({ connector: "github", tool: "ship", args: { ...ARGS, artifact: work, branch }, why: "its gates and its reviewer passed" }, liv);
      expect([branch, shipped.status]).toEqual([branch, "asked"]);
    }
    // Nothing went out: GitHub was asked only where main stands, for the one built elsewhere.
    expect(seen.slice(before).filter((s) => s.method !== "GET")).toEqual([]);
    expect(seen.slice(before).map((s) => s.url)).toEqual(["https://api.github.com/repos/amiriteorg/shipyard", "https://api.github.com/repos/amiriteorg/shipyard/git/ref/heads/main"]);
  });

  test("what isn't its still waits for you: another repository, a tool you run with a token of its own, your own tap", async () => {
    const before = seen.length;
    const elsewhere = await daemon.connectors.call({ connector: "github", tool: "pr.create", args: { owner: "oven-sh", repo: "bun", head: "invincible/x", base: "main", title: "A fix" } }, { kind: "agent", by: "arm:primary" });
    expect(elsewhere.status).toBe("asked");
    const tool = await send(armToken, "callConnector", { connector: "github", tool: "pr.create", args: { owner: "amiriteorg", repo: "shipyard", head: "invincible/x", base: "main", title: "A fix" } });
    expect(tool.body.status).toBe("asked");
    const tapped = await daemon.connectors.call({ connector: "github", tool: "pr.create", args: { owner: "amiriteorg", repo: "shipyard", head: "invincible/y", base: "main", title: "Another" } }, { kind: "agent", by: "team.0123456789.liv", yours: true });
    expect(tapped.status).toBe("asked");
    // Its agents' own calls past the rule wait for you too: another repository, a branch that isn't its.
    const own = { kind: "agent" as const, by: "arm:team.0123456789.liv" };
    expect((await daemon.connectors.call({ connector: "github", tool: "pr.create", args: { owner: "oven-sh", repo: "bun", head: "invincible/x", base: "main", title: "A fix" } }, own)).status).toBe("asked");
    expect((await daemon.connectors.call({ connector: "github", tool: "pr.create", args: { owner: "amiriteorg", repo: "shipyard", head: "feat/x", base: "main", title: "A fix" } }, own)).status).toBe("asked");
    expect(seen.length).toBe(before);
  });
});
