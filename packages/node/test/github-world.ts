// A stand-in GitHub that keeps its branches, commits and pull requests, a repository's workflows (the contents API, raw)
// and its Actions runs per head, and issues and their comments (merge-lands.test.ts's, grown by the re-review of 27
// November); and a world around it: the real ConnectorService, policy, shipNative, shipmentFiles and mergeNative. Not a
// test file: tests import it. No real service is called, and its key is obviously fake.
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { type ConnectorManifest, newNodeIdentity } from "@invincible/core";
import { foundFleet, LedgerStore, Vault } from "@invincible/ledger";
import { CATALOG } from "@invincible/models";
import type { ArtifactStore } from "../src/artifacts.ts";
import { ConnectorService } from "../src/connectors.ts";
import { mergeNative } from "../src/merge.ts";
import { shipmentFiles, shipNative } from "../src/ship.ts";

export const ORIGIN = "https://api.github.com";
const KEY = "github_pat_FAKEFAKEFAKEFAKE0000_world";
export const MAIN = "a".repeat(40);
export const AT = "/repos/lin-example/site";
export type Run = { event: string; status: string; conclusion: string | null; head_sha: string };

export function gh(o: { workflows?: Record<string, string | null>; runs?: (head: string) => Run[] } = {}) {
  const heads = new Map<string, string>([["main", MAIN]]);
  const pulls = new Map<number, { head: string; base: string }>();
  const commits = new Map<string, { parents: string[]; files: string[] }>();
  const merges: { number: number; into: string; sha: string }[] = [];
  const issues: unknown[] = [];
  const sent: string[] = [];
  let count = 0;
  let tree: string[] = [];
  const lands = (head: string) => {
    const chain: string[] = [];
    for (let at = head; at !== MAIN && commits.has(at) && chain.length < 50; at = commits.get(at)!.parents[0]!) chain.push(at);
    return { commits: chain.reverse(), files: [...new Set(chain.flatMap((c) => commits.get(c)!.files))] };
  };
  const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    sent.push(`${method} ${url.pathname}${url.search}`);
    const path = url.pathname.slice(AT.length);
    const nf = () => Response.json({ message: "Not Found" }, { status: 404 });
    if (method === "GET" && url.pathname === "/user") return Response.json({ login: "lin-example", id: 501, type: "User" });
    if (!url.pathname.startsWith(AT)) return nf();
    if (method === "GET" && path === "") return Response.json({ full_name: "lin-example/site", private: false, fork: false, default_branch: "main", owner: { login: "lin-example", id: 501, type: "User" }, allow_merge_commit: true, allow_squash_merge: true, allow_rebase_merge: true });
    // The repository's workflows, on its default branch (a null text: GitHub fails to give that file).
    if (method === "GET" && path === "/contents/.github/workflows") return o.workflows ? Response.json(Object.keys(o.workflows).map((name) => ({ type: "file", name, path: `.github/workflows/${name}` }))) : nf();
    const file = /^\/contents\/\.github\/workflows\/(.+)$/.exec(path);
    if (method === "GET" && file && o.workflows) {
      const text = o.workflows[decodeURIComponent(file[1]!)];
      return text === null ? Response.json({ message: "Server Error" }, { status: 500 }) : text === undefined ? nf() : new Response(text, { headers: { "content-type": "text/plain" } });
    }
    if (method === "GET" && path === "/actions/runs") return Response.json({ workflow_runs: (o.runs?.(url.searchParams.get("head_sha") ?? "") ?? []) });
    // Issues and their comments: every thread opened under the key's account (its user, id 501).
    const issue = /^\/issues\/(\d+)$/.exec(path);
    if (method === "GET" && issue) return Response.json({ number: Number(issue[1]), user: { id: 501 } });
    if (method === "POST" && path === "/issues") return issues.push(body), Response.json({ number: 12, html_url: "https://github.com/lin-example/site/issues/12" }, { status: 201 });
    if (method === "POST" && /^\/issues\/\d+\/comments$/.test(path)) return issues.push(body), Response.json({ id: 1, html_url: "https://github.com/lin-example/site/issues/3#issuecomment-1" }, { status: 201 });
    const ref = /^\/git\/ref\/heads\/(.+)$/.exec(path);
    if (method === "GET" && ref) {
      const sha = heads.get(ref[1]!);
      return sha ? Response.json({ ref: `refs/heads/${ref[1]}`, object: { sha, type: "commit" } }) : nf();
    }
    if (method === "GET" && path.startsWith("/git/commits/")) return Response.json({ sha: path.slice(13), tree: { sha: "f".repeat(40) } });
    if (method === "POST" && path === "/git/blobs") return Response.json({ sha: "b".repeat(40) }, { status: 201 });
    if (method === "POST" && path === "/git/trees") return (tree = (body.tree as { path: string }[]).map((t) => t.path)), Response.json({ sha: "e".repeat(40) }, { status: 201 });
    if (method === "POST" && path === "/git/commits") {
      const sha = `${(++count).toString(16).padStart(2, "0")}${"c".repeat(38)}`;
      commits.set(sha, { parents: body.parents, files: tree });
      return Response.json({ sha }, { status: 201 });
    }
    if (method === "POST" && path === "/git/refs") return heads.set(String(body.ref).slice(11), body.sha), Response.json({}, { status: 201 });
    const move = /^\/git\/refs\/heads\/(.+)$/.exec(path);
    if (method === "PATCH" && move) return heads.set(move[1]!, body.sha), Response.json({ object: { sha: body.sha } });
    if (method === "GET" && path === "/pulls") return Response.json([...pulls].filter(([, p]) => url.searchParams.get("head")?.endsWith(`:${p.head}`)).map(([number]) => ({ number, html_url: `https://github.com/lin-example/site/pull/${number}` })));
    if (method === "POST" && path === "/pulls") {
      const n = 7 + pulls.size;
      pulls.set(n, { head: body.head, base: body.base });
      return Response.json({ number: n, html_url: `https://github.com/lin-example/site/pull/${n}` }, { status: 201 });
    }
    const pull = /^\/pulls\/(\d+)(\/merge|\/commits|\/files)?$/.exec(path);
    const p = pull ? pulls.get(Number(pull[1])) : undefined;
    if (pull && p && method === "GET") {
      const head = heads.get(p.head)!;
      const landed = lands(head);
      const page = Number(url.searchParams.get("page") ?? "1");
      if (pull[2] === "/commits") return Response.json(page === 1 ? landed.commits.map((sha) => ({ sha })) : []);
      if (pull[2] === "/files") return Response.json(page === 1 ? landed.files.map((filename) => ({ filename })) : []);
      const repo = { full_name: "lin-example/site" };
      return Response.json({ number: Number(pull[1]), state: "open", merged: false, mergeable: true, mergeable_state: "clean", changed_files: landed.files.length, head: { ref: p.head, sha: head, repo }, base: { ref: p.base, repo }, html_url: `https://github.com/lin-example/site/pull/${pull[1]}` });
    }
    if (pull && p && method === "PUT") return merges.push({ number: Number(pull[1]), into: p.base, sha: body.sha }), Response.json({ merged: true, sha: "d".repeat(40) });
    return nf();
  }) as unknown as typeof globalThis.fetch;
  return { fetch, heads, pulls, merges, issues, sent };
}

export function keptWork(all: Record<string, Record<string, string>>): ArtifactStore {
  const enc = new TextEncoder();
  const bytes = (id: string) => Object.fromEntries(Object.entries(all[id] ?? {}).map(([p, t]) => [p, enc.encode(t)]));
  return {
    filesOf: (id: string) => (all[id] ? Object.entries(bytes(id)).map(([path, b]) => ({ path, size: b.length, sha256: createHash("sha256").update(b).digest("hex") })) : null),
    read: (id: string, path: string) => {
      const b = bytes(id)[path];
      if (!b) throw new Error("not kept");
      return { bytes: b, type: "application/octet-stream", inline: false, name: path };
    },
  } as unknown as ArtifactStore;
}

/** `proven`: whose proven work each kept work is ({} a verified task's; { fix } a verified fix task's). */
export function world(files: Record<string, Record<string, string>>, g: ReturnType<typeof gh>, proven: Record<string, { fix?: { owner: string; repo: string; branch: string } }> = {}, installed: ConnectorManifest | Record<string, unknown> = CATALOG.github!.manifest) {
  const identity = newNodeIdentity();
  const store = new LedgerStore(":memory:");
  foundFleet(store, identity, { fleetName: "homelab", nodeName: "solo" });
  const vault = new Vault(store, identity);
  vault.set("github", KEY, { provider: "github", origin: ORIGIN });
  store.emit(identity, "connector.set", { id: "github", manifest: installed as Record<string, unknown> });
  const artifacts = keptWork(files);
  const lines: { resource: string; target: string; detail?: string }[] = [];
  const service = new ConnectorService({
    store, vault, identity, local: new Database(":memory:"), ledger: (entry) => void lines.push(entry as never), log: () => {}, fetch: g.fetch,
    repositories: () => ["https://github.com/lin-example/site"],
    natives: { "github.ship": shipNative(artifacts), "github.ship.update": shipNative(artifacts, true), "github.merge": mergeNative() },
    shipment: shipmentFiles(artifacts),
    proven: (artifact) => proven[artifact] ?? (files[artifact] ? {} : null),
  });
  return { service, store, g, lines };
}
export const manifest = (base: string, paths: string[]) => JSON.stringify({ v: 1, base, remote: "https://github.com/lin-example/site.git", files: paths.map((path) => ({ path })) });
