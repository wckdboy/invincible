#!/usr/bin/env bun
/*
 * A throwaway node to run the Apple app against, started as apps/web/measure/first-load.ts starts one: a temp home, the
 * file keystore, startDaemon with a proxyPort (the app comes in as a phone does behind `tailscale serve`), a stand-in
 * Docker and stand-in models. Nothing leaves this machine, and ~/.invincible is never touched.
 *
 * It adds agents named by their jobs, in every state the app shows (Builder running a task, Researcher thinking, Writer's
 * task verified, Coder's failed, Reviewer paused, Operator with a desktop in its VM to watch and take over, which
 * proposes a task for your approval), has an agent ask your approval for an outward call, has the primary ask for a key,
 * and has a rule of yours tell you of a command it ran. Then it makes a client invite and prints its link: paste it into
 * the app. The stand-in streams the primary's answer a word at a time; asked to show
 * something, its answer holds everything an answer can (headings, a list, a table, code, a chart, figures, steps, a page,
 * choices). Asked to hand work over, it gives an agent a task that stays at its first command; asked to look again, it
 * sets itself a look a minute ahead: both are under way above that chat's message box, and the look comes back as its own.
 *
 * Pairing waits for you as a node does: the app's request is printed with its code, and approved only once you write
 * that code into <dir>/approve (`echo 482913 > <dir>/approve`), having compared it with the app's.
 *
 *   bun apps/apple/scripts/dev-node.ts [--dir <dir>]    (SIGINT or SIGTERM stops it and deletes its home)
 *
 * <dir> (default: a new temp directory, printed) receives invite.txt, and pairing.txt while a request waits. The node's
 * home is made inside it too, so a run that is killed outright leaves its home there, not in the system's temp folder.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as core from "../../../packages/core/src/index.ts";
import { foundFleet, LedgerStore } from "../../../packages/ledger/src/index.ts";
import { startDaemon } from "../../../packages/node/src/daemon.ts";
import { Home } from "../../../packages/node/src/home.ts";
import { CHANGES_SCRIPT, LIST_SCRIPT, READ_SCRIPT } from "../../../packages/node/src/workspace-look.ts";
import { fakeDocker } from "../../../packages/node/test/fake-docker.ts";
import { freePort } from "../../../packages/node/test/ports.ts";

const flag = (name: string): string | undefined => {
  const at = process.argv.indexOf(`--${name}`);
  return at < 0 ? undefined : process.argv[at + 1];
};
// The node's key goes to a file in the temp home, never to the OS keychain.
process.env.INVINCIBLE_KEYSTORE = "file";
const chosen = flag("dir");
if (chosen) mkdirSync(chosen, { recursive: true });
const tmp = mkdtempSync(join(chosen ?? tmpdir(), "invincible-apple-node-"));
const dir = chosen ?? join(tmp, "out");
mkdirSync(dir, { recursive: true });
const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));
const say = (line: string) => console.log(`[dev-node] ${line}`);

let daemon: Awaited<ReturnType<typeof startDaemon>> | undefined;
const servers: { stop(force?: boolean): unknown }[] = [];
const held: (() => void)[] = [];
let stopping = false;
async function tidy(): Promise<void> {
  if (stopping) return;
  stopping = true;
  for (const release of held.splice(0)) release();
  for (const server of servers) server.stop(true);
  await daemon?.stop().catch(() => {});
  rmSync(tmp, { recursive: true, force: true });
}
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) process.on(signal, () => void tidy().finally(() => process.exit(0)));

// ---------- the node ----------
const home = new Home(join(tmp, "home"));
const port = freePort();
const { identity, keystore } = await home.createIdentity("file");
if (keystore !== "file") throw new Error(`the node's key went to the ${keystore} keystore, not a file`);
const mind = new LedgerStore(home.ledgerPath);
const fleet = foundFleet(mind, identity, { fleetName: "homelab", nodeName: "keep" });
mind.close();
home.writeConfig({ v: 1, name: "keep", fleet, port, keystore, advertise: "127.0.0.1" });
const caps = { os: "linux", arch: "x64", hostname: "keep", cores: 16, cpu: "stand-in", memoryGb: 32, hasBattery: false, gpu: [], docker: true, vm: { kvm: true, tools: ["kata"] }, tools: ["docker"], localModels: [], tailscale: null, sandbox: { image: true, networks: true, vm: true } };
// Builder's task stays at its first command, so one agent is always at work; Researcher's answer never comes, so one is always
// thinking. Coder's gate can't run in its VM.
const docker = fakeDocker();
const hold = new Promise<void>((release) => held.push(release));
let builderAtWork = false;
// Operator's VM has a desktop: its screen is a browser on a blank tab until you open an address, then a page.
const SCREENS = ["screen-blank.jpg", "screen-page.jpg"].map((file) => readFileSync(join(import.meta.dir, "fixtures", file)).toString("base64"));
let screen = 0;
// An agent's workspace to look into (its /work), made here: a small repository, and a task's worktree with its change in
// it. The workspace's own scripts (packages/node/src/workspace-look.ts) run on it for real, /work read as this folder.
const work = join(tmp, "work");
const sh = (cwd: string, ...args: string[]) => Bun.spawnSync(args, { cwd, stdout: "ignore", stderr: "ignore" });
mkdirSync(join(work, "repo", "src"), { recursive: true });
writeFileSync(join(work, "repo", "README.md"), "# Sync\n\nKeeps every node's log the same, **whichever order** events arrive in.\n\n- Resumes after a dropped connection\n- Verified by `bun test packages/link`\n");
writeFileSync(join(work, "repo", "src", "sync.ts"), "// Pulls what a peer has that we don't.\nexport async function pull(peer: string, since: number): Promise<number> {\n  const retries = 1;\n  return retries;\n}\n");
writeFileSync(join(work, "repo", "package.json"), JSON.stringify({ name: "sync", version: "0.4.0", scripts: { test: "bun test" } }, null, 2) + "\n");
const git = ["git", "-c", "user.name=Builder", "-c", "user.email=builder@example.invalid", "-c", "commit.gpgsign=false"];
sh(join(work, "repo"), "git", "init", "-q", "-b", "main");
sh(join(work, "repo"), ...git, "add", ".");
sh(join(work, "repo"), ...git, "commit", "-q", "-m", "Start");
mkdirSync(join(work, "tasks"), { recursive: true });
sh(join(work, "repo"), ...git, "worktree", "add", "-q", "--detach", join(work, "tasks", "task"), "HEAD");
const startedAt = Bun.spawnSync(["git", "-C", join(work, "repo"), "rev-parse", "HEAD"]).stdout.toString().trim();
mkdirSync(join(work, ".agent", "base"), { recursive: true });
writeFileSync(join(work, ".agent", "base", "task"), `${startedAt} fetched`);
writeFileSync(join(work, "tasks", "task", "src", "sync.ts"), "// Pulls what a peer has that we don't, and picks up where a dropped connection left off.\nexport async function pull(peer: string, since: number): Promise<number> {\n  const retries = 3;\n  const resumeFrom = since;\n  return retries + resumeFrom;\n}\n");
writeFileSync(join(work, "tasks", "task", "src", "resume.test.ts"), 'import { expect, test } from "bun:test";\nimport { pull } from "./sync.ts";\n\ntest("a dropped pull resumes", async () => {\n  expect(await pull("peer", 4)).toBe(7);\n});\n');
const atWork = (path: string) => (path.startsWith("/work/tasks/") ? join(work, "tasks", "task") : path.startsWith("/work/.agent/base/") ? join(work, ".agent", "base", "task") : path.startsWith("/work") ? work + path.slice(5) : path);

docker.onExec = async (_container: string, command: string[]) => {
  if (command[0] === "python3" && command[1] === "-c" && [LIST_SCRIPT, READ_SCRIPT, CHANGES_SCRIPT].includes(command[2]!)) {
    const ran = Bun.spawnSync(["python3", "-c", command[2]!, ...command.slice(3).map(atWork)], { stdout: "pipe", stderr: "pipe" });
    return { code: ran.exitCode, stdout: ran.stdout.toString(), stderr: ran.stderr.toString() };
  }
  const text = command.join("\n");
  if (command[0] === "desktop" && command[1] === "open") screen = 1;
  if (text.includes("base64 -w0")) return { code: 0, stdout: SCREENS[screen]! };
  if (text.includes("write-sync")) {
    builderAtWork = true;
    await hold;
  }
  if (text.includes("gate-fail")) return { code: 1, stdout: "", stderr: "error: connect ECONNREFUSED 127.0.0.1:5432" };
  return { code: 0, stdout: text.includes("gate-") ? "required gate passed" : "command completed" };
};

// ---------- stand-in models ----------
const PRIMARY = "Good evening. This is a stand-in model on a throwaway node, so the words are canned, but they stream to you as a real model's would: a word at a time, into this bubble, until the answer is done.";
// Asked to show something, it answers with everything an answer can hold: what the app draws beyond plain words.
const SHOWN = [
  "## What I found",
  "",
  "Three things stand out, and **one needs you**:",
  "",
  "1. The *release* is on track.",
  "2. CI on `main` is green: https://github.com/wckdboy/invincible/actions.",
  "3. ~~Friday~~ Monday is the new date.",
  "   - It moved for the review.",
  "",
  "> The gate held: nothing ships unreviewed.",
  "",
  "| Check | Result | Time |",
  "|:--|:--:|--:|",
  "| Unit tests | passed | 41 s |",
  "| Review | passed | 2 min |",
  "",
  "```ts",
  "const ok = await verify(change);",
  "if (!ok) throw new Error(\"held\");",
  "```",
  "",
  "```chart",
  JSON.stringify({ type: "line", title: "Tokens a task", unit: "k", labels: ["Mon", "Tue", "Wed", "Thu", "Fri"], series: [{ name: "Before", values: [442, 430, 451, 438, 440] }, { name: "After", values: [258, 250, 262, 249, 255] }] }),
  "```",
  "",
  "```stats",
  JSON.stringify([{ label: "Read from a cache", value: "73%", delta: 71, note: "since Monday", good: "up" }, { label: "Cost a task", value: 0.54, unit: "$", delta: -0.51, good: "down" }]),
  "```",
  "",
  "```steps",
  JSON.stringify([{ text: "Read the failing test", state: "done" }, { text: "Fix the parser", state: "doing" }, { text: "Ship it", state: "todo" }]),
  "```",
  "",
  "```artifact",
  "<!doctype html><title>Release board</title><style>body{font:16px system-ui;margin:16px;color:#222}h1{font-size:20px}button{font:inherit;padding:8px 14px}</style><h1>Release board</h1><p id=state>3 of 4 checks are green.</p><button onclick=\"document.getElementById('state').textContent='Its script ran.'\">Run its script</button>",
  "```",
  "",
  "Shall I go ahead?",
  "",
  "```choices",
  JSON.stringify(["Ship it", "Hold until Monday"]),
  "```",
].join("\n");
/** A stand-in engineer's call to its bash tool, streamed as an OpenAI-compatible tool call. */
const bashCall = (command: string): Response =>
  new Response(`data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: "call_stand_in", function: { name: "bash", arguments: JSON.stringify({ command }) } }] } }] })}\n\ndata: [DONE]\n\n`, { headers: { "content-type": "text/event-stream" } });

const stream = (text: string, delayMs: number): Response => {
  const encoder = new TextEncoder();
  const words = text.split(/(?<= )/);
  return new Response(
    new ReadableStream({
      async start(controller) {
        for (const word of words) {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify({ choices: [{ delta: { content: word } }] })}\n\n`));
          if (delayMs) await sleep(delayMs);
        }
        // What a provider says the call came to, as OpenAI's API ends a stream: so the usage meter has numbers.
        controller.enqueue(encoder.encode(`data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 42_000, completion_tokens: 1_800 } })}\n\n`));
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        controller.close();
      },
    }),
    { headers: { "content-type": "text/event-stream" } },
  );
};
/** A tool call, streamed as an OpenAI-compatible model streams one. */
const toolCall = (name: string, args: unknown, id = "call_dev_1"): Response =>
  new Response(
    [
      { choices: [{ delta: { tool_calls: [{ index: 0, id, type: "function", function: { name, arguments: JSON.stringify(args) } }] } }] },
      { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
    ].map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("") + "data: [DONE]\n\n",
    { headers: { "content-type": "text/event-stream" } },
  );
const model = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  idleTimeout: 255,
  fetch: async (request) => {
    const body = (await request.json()) as { model: string; tools?: unknown[]; messages: { role: string; content: unknown }[] };
    const turns = body.messages.filter((message) => message.role !== "system");
    if (JSON.stringify(turns).includes("Take your time")) await hold;
    const goal = JSON.stringify(turns[0] ?? "");
    if (goal.includes("TASK_")) {
      let text = "1. Make the change.\n2. Run the required gate.\nDone when: the gate and independent review pass.";
      const write = goal.includes("TASK_KEEP") ? "write-keep" : "write-sync";
      // Whoever works it: an engineer, or an agent offered its tools on its own role's models (Writer works on the planner's).
      if (body.model === "engineer" || (body.model !== "reviewer" && !!body.tools?.length)) {
        if (goal.includes("TASK_FAIL")) text = "GIVE UP\nThe gate needs a Postgres this VM does not have: `bun test db/` exits 1 before any work, with ECONNREFUSED on 127.0.0.1:5432.";
        else if (turns.some((message) => message.role === "assistant")) text = "DONE\nVerified.";
        // Offered its own tools (an agent on the roster's models: run.ts tools), it calls bash, as a real one does.
        else if (body.tools?.length) return bashCall(`printf done > result.txt # ${write}`);
        else text = `\`\`\`sh\nprintf done > result.txt # ${write}\n\`\`\``;
      } else if (body.model === "reviewer") text = "PASS\nThe required gate passed and execution evidence supports the result.";
      return stream(text, 0);
    }
    // An agent in a conversation answers you, by name, and lets its fellows' words pass ([SILENT]). Asked to propose
    // something, it proposes a task with its tool, then says so.
    const [, agent, handle] = /You are (\w+) \(([a-z][a-z0-9-]*)\)/.exec(JSON.stringify(body.messages ?? "")) ?? [];
    if (agent && /\bpropose\b/i.test(JSON.stringify(turns.at(-1) ?? "")) && !turns.some((message) => message.role === "tool")) {
      return toolCall("delegate_task", { assignee: handle, title: "Draft the 0.4 release notes", goal: "TASK_KEEP: draft the release notes from the merged pull requests, as notes.md.", gates: ["test -f notes.md # gate-keep"] });
    }
    if (agent && turns.some((message) => message.role === "tool")) return stream("I've written it up as a task: approve it and I'll start.", 0);
    if (agent) {
      const last = [...JSON.stringify(turns.at(-1) ?? "").matchAll(/\\"speaker\\":\\"([a-z-]+)\\"/g)].at(-1)?.[1];
      return stream(last === "owner" ? (AGENT_SAYS[agent] ?? "Understood. I will take the part that is mine and say when it is done.") : "[SILENT]", 0);
    }
    // The primary itself answers with its tools at hand.
    const asked = JSON.stringify(turns.filter((message) => message.role === "user").at(-1) ?? "");
    // Asked to hand work over, it gives it to an agent, who stays at its first command: a task under way above the
    // message box, with its Stop. Asked to look again, it sets itself a look a minute ahead: there too, with its Cancel.
    // Each done, it says what its tools said; and a look of its that comes is answered with what it found.
    const offered = new Set((body.tools ?? []).map((t) => (t as { function?: { name?: string } }).function?.name));
    if (asked.includes("A look you set yourself")) return stream("I looked again, as I said I would: the importer check is still at its first command. Nothing needs you yet.", 30);
    const plan: [string, unknown][] = [];
    if (/\b(hand|give)\b/i.test(asked) && offered.has("team_give")) plan.push(["team_give", { title: "Check the importer's dates", goal: "TASK_HOLD: check that the importer reads ISO 8601 dates, with a test.", gates: ["bun test importer # gate-hold"] }]);
    if (/\blook again\b/i.test(asked) && offered.has("look_later")) plan.push(["look_later", { note: "Is the importer check still going?", in: "1m" }]);
    if (plan.length) {
      const since = turns.slice(turns.findLastIndex((message) => message.role === "user") + 1);
      const said = since.filter((message) => message.role === "tool").map((message) => String(message.content).split("\n")[0]);
      const next = plan[said.length];
      return next ? toolCall(next[0], next[1], `call_dev_${said.length + 1}`) : stream(said.join(" "), 30);
    }
    if (Array.isArray(body.tools) && body.tools.length) return stream(/\bshow\b/i.test(asked) ? SHOWN : PRIMARY, /\bshow\b/i.test(asked) ? 15 : 70);
    return stream("Understood. I will take the part that is mine and say when it is done.", 0);
  },
});
servers.push(model);
// Where the agent's outward call would go, were it approved.
const upstream = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => Response.json({ ok: true }) });
servers.push(upstream);

// What each agent says to you in a room, in the stand-in's voice.
const AGENT_SAYS: Record<string, string> = {
  Writer: "I'll take the release notes: I can draft them from the merged pull requests and hand you a list to check.",
  Coder: "I'll check that every migration in 0.4 runs on a fresh database before the notes go out.",
};

// An agent's terminal is a stand-in shell, never one on this machine: it echoes what you type, and answers the vendors'
// sign-ins as they do (an address to open, then a code to paste), so the app's terminal can be tried end to end.
const standInShell = (_argv: string[], _size: { cols: number; rows: number }, onData: (bytes: Uint8Array) => void) => {
  const say = (text: string) => onData(new TextEncoder().encode(text));
  let line = "";
  let waitingForCode = false;
  let done!: (code: number) => void;
  const exited = new Promise<number>((resolve) => (done = resolve));
  const prompt = () => say("\x1b[32moperator@vm\x1b[0m:\x1b[34m/work\x1b[0m$ ");
  setTimeout(() => { say("A stand-in shell on the dev node (nothing here runs).\r\n"); prompt(); }, 50);
  return {
    write(data: string) {
      for (const ch of data) {
        if (ch === "\r") {
          say("\r\n");
          const typed = line.trim();
          line = "";
          if (waitingForCode) {
            waitingForCode = false;
            say(typed ? "Login successful. Claude Code is signed in to your subscription, in this VM.\r\n" : "No code given.\r\n");
          } else if (typed === "claude auth login") {
            say("Browser didn't open? Use the url below to sign in:\r\n\r\n\x1b[36mhttps://claude.ai/oauth/authorize?code=true&client_id=dev-node-stand-in&state=fake\x1b[39m\r\n\r\nPaste code here if prompted > ");
            waitingForCode = true;
            continue;
          } else if (typed === "exit") {
            done(0);
            return;
          } else if (typed) say(`stand-in: ${typed}\r\n`);
          prompt();
        } else if (ch === "\x7f") {
          if (line) { line = line.slice(0, -1); say("\b \b"); }
        } else if (ch >= " ") {
          line += ch;
          say(ch);
        }
      }
    },
    resize() {},
    kill() { done(130); },
    exited,
  };
};

// ---------- start ----------
const proxyPort = freePort();
const started = await startDaemon(home, {
  capabilities: caps,
  proxyPort,
  log: () => {},
  docker: docker.runner,
  spawnTerminal: standInShell,
  measure: async (reason, body, limit) => {
    const threads = core.ceilingThreads(body, limit);
    return { at: Date.now(), tookMs: 1, reason, body: core.bodyFingerprint(body, limit), cpu: { single: core.REFERENCE_SINGLE, multi: core.REFERENCE_SINGLE * threads, threads, kernel: core.KERNEL } };
  },
  loopIntervalMs: 3_600_000,
  defaultHeartbeat: false,
  archiveIntervalMs: false,
  shutdownGraceMs: 100,
});
daemon = started;
const routes = core.routes as Record<string, { method: string; path: string }>;
const call = async (token: string, name: string, input?: unknown): Promise<any> => {
  const route = routes[name]!;
  const response = await fetch(`http://127.0.0.1:${port}${route.path}`, {
    method: route.method,
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: route.method === "POST" ? JSON.stringify(input ?? {}) : undefined,
  });
  const answer = await response.json();
  if (!response.ok) throw new Error(`${name}: ${response.status} ${JSON.stringify(answer)}`);
  return answer;
};
const admin = (name: string, input?: unknown) => call(home.adminToken(), name, input);
const until = async (what: string, probe: () => unknown | Promise<unknown>, timeoutMs = 45_000): Promise<void> => {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (await probe()) return;
    await sleep(100);
  }
  throw new Error(`waited ${timeoutMs / 1000} s for ${what}`);
};

await until("the node's calibration", () => started.store.lww(`calibration:${started.identity.id}`) !== null);
await admin("setProvider", { id: "stand-in", kind: "openai", baseUrl: `http://127.0.0.1:${model.port}/v1` });
for (const role of ["planner", "engineer", "reviewer", "swift"]) await admin("setRoster", { role, models: [`stand-in/${role}`] });
// A price for the stand-in, and a day's budget, so the usage meter shows a spend against something.
await admin("setPrice", { model: "stand-in/*", input: 3, output: 15 });
await admin("setUsageBudget", { usd: 1, per: "day" });

// ---------- the agents ----------
const agents = [
  { id: "builder", name: "Builder", role: "engineer", instructions: "Builds the sync engine and keeps its tests green." },
  { id: "writer", name: "Writer", role: "planner", instructions: "Writes the release notes and the docs, from what was merged." },
  { id: "researcher", name: "Researcher", role: "planner", instructions: "Researches the questions the others park." },
  { id: "coder", name: "Coder", role: "engineer", instructions: "Keeps the database layer and its migrations honest." },
  { id: "reviewer", name: "Reviewer", role: "reviewer", instructions: "Reviews what the others ship, independently.", enabled: false },
  { id: "operator", name: "Operator", role: "engineer", instructions: "Works the web through a browser: signs in, downloads, checks pages." },
];
for (const agent of agents) await admin("saveAgent", agent);
await admin("provisionAgent", { id: "operator", desktop: true });
await admin("setComputeLimit", { node: started.identity.id, cores: 16, memoryGb: 32, sandboxes: 6 });
const ended = (id: string) => async () => !["queued", "running"].includes((await admin("team")).tasks.find((t: { id: string }) => t.id === id)?.status ?? "queued");
const own: Record<string, string> = {};
for (const id of ["builder", "writer", "researcher", "coder"]) own[id] = (await admin("directAgent", { id })).room.id;
await admin("createTeamTask", { room: own.builder, assignee: "builder", title: "Sync survives a dropped connection", goal: "TASK_SYNC: make sync resume after a dropped connection, with a test that drops it.", dependsOn: [], gates: ["test -f result.txt # gate-sync"] });
await until("Builder's task to start", () => builderAtWork);
const kept = (await admin("createTeamTask", { room: own.writer, assignee: "writer", title: "The importer reads ISO dates", goal: "TASK_KEEP: make the importer read ISO 8601 dates as well as the day-first form, with tests.", dependsOn: [], gates: ["bun test importer # gate-keep"] })).task;
await until("Writer's task to end", ended(kept.id));
// A room of several: Writer and Coder, answering you there (named: what names no agent is the primary's to answer). Before
// Coder's task, so its failure is the latest of its work, and its row says so.
const studio = (await admin("saveTeamRoom", { name: "Release room", members: ["writer", "coder"], turnBudget: 6 })).room;
await admin("postTeamMessage", { room: studio.id, text: "@writer @coder Who takes the release notes for 0.4?" });
await until("the room's replies", async () => (await admin("teamRoom", { id: studio.id })).messages.length >= 3);
const failing = (await admin("createTeamTask", { room: own.coder, assignee: "coder", title: "Migrations run on a fresh database", goal: "TASK_FAIL: make every migration run on a fresh database, with a test.", dependsOn: [], gates: ["bun test db/ # gate-fail"] })).task;
await until("Coder's task to end", ended(failing.id));
await admin("postTeamMessage", { room: own.researcher, text: "Take your time: what do other agents do about context rot?" });
// Operator proposes work, so one agent waits for your approval.
own.operator = (await admin("directAgent", { id: "operator" })).room.id;
await admin("postTeamMessage", { room: own.operator, text: "Could you propose what the release needs from you?" });
await until("Operator's proposal", async () => (await admin("team")).tasks.some((t: { assignee: string; status: string }) => t.assignee === "operator" && t.status === "proposed"));
await until("Researcher to start thinking", async () => (await admin("team")).deliveries.some((d: { status: string; agent: string }) => d.agent === "researcher" && d.status === "running"));

// ---------- what needs you ----------
// A fact about you the primary noticed (an agent's memory, so only proposed), waiting in the Inbox for you to keep.
{
  const noticer = (await admin("mintArm", { label: "dev-noticer" })) as { token: string };
  await call(noticer.token, "remember", { text: "Writes in British English.", tags: ["about-you"] });
}
// An agent asks for your approval for an outward call (a connector's post), and the primary asks for a key.
const forge = { id: "forge", label: "Forge", origin: `http://127.0.0.1:${upstream.port}`, auth: { secret: "forge", scheme: "bearer" }, tools: { post: { description: "Post publicly.", method: "POST", path: "/posts", params: { text: { type: "string", required: true } }, class: "outward" } } };
await admin("setConnector", { id: "forge", manifest: forge });
await admin("setSecret", { name: "forge", value: "fake-forge-key-for-tests-only", provider: "forge" });
const { token: bot } = await admin("mintArm", { label: "release-bot", scopes: ["connect"] });
const asked = await call(bot, "callConnector", { connector: "forge", tool: "post", args: { text: "Invincible 0.4: sync survives a dropped connection." }, why: "Announce the release once its checks pass." });
if (asked.status !== "asked") throw new Error(`the agent's call wasn't held for you: ${JSON.stringify(asked)}`);
await admin("requestSecret", { name: "github-token", purpose: "To open the pull request for the sync fix." });
// A rule of yours that tells you, and a command of one of its runs it matched: a notice in the Inbox.
await admin("setRule", { name: "pushes", does: "tell", words: ["git"], contains: "push" });
await admin("ruleTold", { run: "q-release", rule: "pushes", command: "git push origin release/0.4", exitCode: 0 });

// ---------- pairing ----------
const origin = `http://127.0.0.1:${proxyPort}`;
const invite = await admin("createInvite", { kind: "client", origin, scopes: core.CLIENT_DEFAULT_SCOPES });
writeFileSync(join(dir, "invite.txt"), `${invite.url}\n`);
say(`node keep (fleet homelab) at ${origin}`);
say(`invite: ${invite.url}`);
say(`(also in ${join(dir, "invite.txt")}; approve a request with: echo <code> > ${join(dir, "approve")})`);

// A second device asks too once the app is in, so the app's Inbox has a device to answer: a fake key, a code of its own.
let appPaired = false;
const approveFile = join(dir, "approve");
const seen = new Set<string>();
for (;;) {
  const { pairings } = (await admin("pairings")) as { pairings: core.PairingView[] };
  for (const pending of pairings) {
    if (!seen.has(pending.device)) {
      seen.add(pending.device);
      say(`pairing request: "${pending.name}" (${pending.kind}) shows ${pending.sas}`);
      if (!appPaired) writeFileSync(join(dir, "pairing.txt"), `${pending.sas}\n`);
    }
  }
  if (!appPaired && existsSync(approveFile)) {
    const code = readFileSync(approveFile, "utf8").replace(/\D/g, "");
    unlinkSync(approveFile);
    const match = pairings.find((pending) => pending.sas.replace(/\s/g, "") === code);
    if (!match) say(`no request shows ${code}: nothing approved`);
    else {
      await admin("approvePairing", { invite: match.invite, device: match.device });
      appPaired = true;
      rmSync(join(dir, "pairing.txt"), { force: true });
      say(`approved "${match.name}" (${match.device.slice(0, 10)}…)`);
      const second = core.decodeInvite((await admin("createInvite", { kind: "client" })).invite);
      const { p256 } = (await import(Bun.resolveSync("@noble/curves/nist.js", join(import.meta.dir, "../../../packages/core/src")))) as typeof import("../../../packages/core/node_modules/@noble/curves/nist.js");
      const fields: core.PairRequestFields = { invite: second.i, device: core.clientIdFromKey(p256.getPublicKey(p256.utils.randomSecretKey(), false)), name: "Invincible app on iPad", kind: "client" };
      const response = await fetch(`${origin}/link/pair/request`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...fields, proof: core.pairProof(core.fromB64u(second.s), fields) }) });
      say(`a second device asks to join: ${response.status} ${await response.text()}`);
    }
  }
  await sleep(500);
}
