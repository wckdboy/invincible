import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { newNodeIdentity } from "@invincible/core";
import { foundFleet, LedgerStore, Vault } from "@invincible/ledger";
import { CATALOG } from "@invincible/models";
import type { ArtifactStore } from "../src/artifacts.ts";
import { ConnectorService } from "../src/connectors.ts";
import { mergeNative } from "../src/merge.ts";
import { shipmentFiles, shipNative } from "../src/ship.ts";

/*
 * What a merge of its agents' work lands, and what a push of it stands on (the review of f805030..9fbcdd2, 27 November
 * 2026: N2b, N6, and the merge's callers; its PoCs, poc45-ship-merge, turned into tests that fail at 9fbcdd2). Against
 * the real ConnectorService, policy, shipNative, shipmentFiles and mergeNative, with a stand-in GitHub that keeps its
 * branches, its commits and its pull requests. No real service is called; the key is obviously fake.
 */

const ORIGIN = "https://api.github.com";
const KEY = "github_pat_FAKEFAKEFAKEFAKE0000_lands";
const MAIN = "a".repeat(40);
/** A contributor's pull request #3's head, kept in the base repository (refs/pull/3/head): it changes the workflow. */
const STRANGER = "5".repeat(40);
const AT = "/repos/lin-example/site";

function gh(o: { onRead?: (path: string) => void } = {}) {
  const heads = new Map<string, string>([["main", MAIN]]);
  const pulls = new Map<number, { head: string; base: string }>();
  /** Each commit GitHub makes: its parents, and the files it changes from them. */
  const commits = new Map<string, { parents: string[]; files: string[] }>([[STRANGER, { parents: [MAIN], files: ["src/units.ts", ".github/workflows/ci.yml"] }]]);
  const made: { parents: string[] }[] = [];
  const merges: { number: number; into: string; sha: string }[] = [];
  const sent: string[] = [];
  let count = 0;
  let tree: string[] = [];
  /** A pull request's commits, newest first back to main's history, and the files they change. */
  const lands = (head: string) => {
    const chain: string[] = [];
    for (let at = head; at !== MAIN && commits.has(at) && chain.length < 50; at = commits.get(at)!.parents[0]!) chain.push(at);
    return { commits: chain.reverse(), files: [...new Set(chain.flatMap((c) => commits.get(c)!.files))] };
  };
  const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    sent.push(`${method} ${url.pathname}`);
    const path = url.pathname.slice(AT.length);
    const nf = () => Response.json({ message: "Not Found" }, { status: 404 });
    if (!url.pathname.startsWith(AT)) return nf();
    if (method === "GET") o.onRead?.(path);
    if (method === "GET" && path === "") return Response.json({ full_name: "lin-example/site", private: false, fork: false, default_branch: "main", owner: { login: "lin-example", id: 501, type: "User" }, allow_merge_commit: true, allow_squash_merge: true, allow_rebase_merge: true });
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
      made.push({ parents: body.parents });
      commits.set(sha, { parents: body.parents, files: tree });
      return Response.json({ sha }, { status: 201 });
    }
    if (method === "POST" && path === "/git/refs") return heads.set(String(body.ref).slice(11), body.sha), Response.json({}, { status: 201 });
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
      return Response.json({ number: Number(pull[1]), state: "open", merged: false, mergeable: true, mergeable_state: "clean", changed_files: landed.files.length, head: { ref: p.head, sha: head, repo }, base: { ref: p.base, repo } });
    }
    if (pull && p && method === "PUT") return merges.push({ number: Number(pull[1]), into: p.base, sha: body.sha }), Response.json({ merged: true, sha: "d".repeat(40) });
    return nf();
  }) as unknown as typeof globalThis.fetch;
  return { fetch, heads, pulls, made, merges, sent };
}

/** Kept work, as the node's ArtifactStore gives it: each artifact's files, by id. */
function keptWork(all: Record<string, Record<string, string>>): ArtifactStore {
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

function world(files: Record<string, Record<string, string>>, g = gh()) {
  const identity = newNodeIdentity();
  const store = new LedgerStore(":memory:");
  foundFleet(store, identity, { fleetName: "homelab", nodeName: "solo" });
  const vault = new Vault(store, identity);
  vault.set("github", KEY, { provider: "github", origin: ORIGIN });
  store.emit(identity, "connector.set", { id: "github", manifest: CATALOG.github!.manifest });
  const artifacts = keptWork(files);
  const service = new ConnectorService({
    store,
    vault,
    identity,
    local: new Database(":memory:"),
    ledger: () => {},
    log: () => {},
    fetch: g.fetch,
    repositories: () => ["https://github.com/lin-example/site"],
    natives: { "github.ship": shipNative(artifacts), "github.ship.update": shipNative(artifacts, true), "github.merge": mergeNative() },
    shipment: shipmentFiles(artifacts),
    // Each kept work here is a verified task's.
    proven: (artifact) => (files[artifact] ? {} : null),
  });
  return { service, store, g };
}
const manifest = (base: string, paths: string[]) => JSON.stringify({ v: 1, base, remote: "https://github.com/lin-example/site.git", files: paths.map((path) => ({ path })) });
const ada = { kind: "agent" as const, by: "team.0123456789.ada" };
const at = { owner: "lin-example", repo: "site" };
const UNITS = { art_AAAAAAAAAAAAAAAAAAAAAA: { "ship/manifest.json": manifest(MAIN, ["src/units.ts"]), "ship/files/src/units.ts": "export const k = 1e3;\n" } };

test("a merge of its own, on main's head, lands what GitHub says the pull request changes: its commit, its file", async () => {
  const w = world(UNITS);
  expect((await w.service.call({ connector: "github", tool: "ship", args: { ...at, artifact: "art_AAAAAAAAAAAAAAAAAAAAAA", branch: "invincible/units", title: "Units" } }, ada)).status).toBe("done");
  const head = w.g.heads.get("invincible/units")!;
  const merged = await w.service.call({ connector: "github", tool: "merge", args: { ...at, number: 7, sha: head } }, { kind: "agent", by: "primary" });
  expect(merged.status === "done" && merged.own).toStartWith("a merge of its agents' proven work into main (its one commit");
  expect(w.g.merges).toEqual([{ number: 7, into: "main", sha: head }]);
  // GitHub was asked what it lands: the pull request, its commits and its files.
  expect(w.g.sent).toEqual(expect.arrayContaining([`GET ${AT}/pulls/7`, `GET ${AT}/pulls/7/commits`, `GET ${AT}/pulls/7/files`]));
});

test("N2b: a ship you approved off main's head (a contributor's commit) is never then its own merge: what it would land holds their commit and their workflow", async () => {
  const w = world({ art_AAAAAAAAAAAAAAAAAAAAAA: { "ship/manifest.json": manifest(STRANGER, ["src/units.ts"]), "ship/files/src/units.ts": "export const k = 1e3;\n" } });
  const asked = await w.service.call({ connector: "github", tool: "ship", args: { ...at, artifact: "art_AAAAAAAAAAAAAAAAAAAAAA", branch: "invincible/units", title: "Fix #3's test" } }, ada);
  expect(asked.status).toBe("asked"); // its base isn't main's head: yours
  w.service.decide(asked.status === "asked" ? asked.action : "", true, null); // you approve the one-file fix
  await w.service.drain();
  expect(w.g.made[0]!.parents).toEqual([STRANGER]);
  const merged = await w.service.call({ connector: "github", tool: "merge", args: { ...at, number: 7, sha: w.g.heads.get("invincible/units")! } }, { kind: "agent", by: "primary" });
  expect(merged.status).toBe("asked");
  expect(w.g.merges).toEqual([]);
});

test("N6: main moved between the fresh read that approved a ship and its push: nothing is pushed, and it says so", async () => {
  // A CI fix lands on main (to B) right after the policy's read of main says A, while the shipper uploads its blobs.
  const B = "b0".repeat(20);
  let reads = 0;
  const g = gh({ onRead: (path) => { if (path === "/git/ref/heads/main" && ++reads === 1) queueMicrotask(() => g.heads.set("main", B)); } });
  const w = world(UNITS, g);
  const out = await w.service.call({ connector: "github", tool: "ship", args: { ...at, artifact: "art_AAAAAAAAAAAAAAAAAAAAAA", branch: "invincible/units", title: "Units" } }, ada);
  expect(out.status === "done" && out.own).toContain("built on main as it stands");
  expect(out.status === "done" && out.result).toMatchObject({ ok: false, status: 409, body: expect.stringContaining(`main moved since your agent's own approval read it (from ${MAIN} to ${B}): nothing was pushed`) });
  // Read again just before the branch would have been made; no branch, no pull request.
  expect(g.sent.filter((s) => s === `GET ${AT}/git/ref/heads/main`)).toHaveLength(2);
  expect(g.sent.filter((s) => s === `POST ${AT}/git/refs` || s === `POST ${AT}/pulls`)).toEqual([]);
});

test("the merge's callers: only the node's own merge ('primary') is its own; its chat, agents, loops and tools ask", async () => {
  const w = world(UNITS);
  expect((await w.service.call({ connector: "github", tool: "ship", args: { ...at, artifact: "art_AAAAAAAAAAAAAAAAAAAAAA", branch: "invincible/units", title: "Units" } }, ada)).status).toBe("done");
  const sha = w.g.heads.get("invincible/units")!;
  for (const by of ["arm:primary", "team.0123456789.ada", "arm:team.0123456789.ada", "loop:triage", "arm:coder", "node:other"]) {
    expect([by, (await w.service.call({ connector: "github", tool: "merge", args: { ...at, number: 7, sha } }, { kind: "agent", by })).status]).toEqual([by, "asked"]);
  }
  expect(w.g.merges).toEqual([]);
});
