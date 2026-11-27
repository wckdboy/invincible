import { afterAll, beforeAll, expect, setSystemTime, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type AttachmentRef, MARK_PALETTE, readGlassProfile, routes, snapColor, teamArmLabel, type LedgerEntry, type RouteName, type TeamMessage, type TeamSnapshot, type TeamRoomView, type TeamTask } from "@invincible/core";
import { foundFleet, LedgerStore } from "@invincible/ledger";
import { startDaemon, type Daemon } from "../src/daemon.ts";
import { Home } from "../src/home.ts";
import type { Capabilities } from "../src/capabilities.ts";
import { freePort } from "./ports.ts";

const root = mkdtempSync(join(tmpdir(), "invincible-team-e2e-"));
const home = new Home(join(root, "node"));
const port = freePort();
const caps: Capabilities = { os: "linux", arch: "x64", hostname: "team-test", cores: 4, cpu: "test", memoryGb: 8, hasBattery: false, gpu: [], docker: false, vm: { kvm: false, tools: [] }, tools: [], localModels: [], tailscale: null };
let daemon: Daemon;
let calls = 0;
const prompts: any[] = [];
const model = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: async (req) => {
  prompts.push(await req.json()); calls++;
  const delta = calls === 1
    ? { tool_calls: [{ index: 0, id: "shared-note", function: { name: "remember", arguments: JSON.stringify({ text: "The agents shares verified lessons.", tags: ["team-test"] }) } }] }
    : { content: "A useful contribution." };
  return new Response(`data: ${JSON.stringify({ choices: [{ delta }] })}\n\ndata: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: calls === 1 ? "tool_calls" : "stop" }] })}\n\ndata: [DONE]\n\n`, { headers: { "content-type": "text/event-stream" } });
} });
const request = (name: RouteName, input?: unknown, token = home.adminToken()) => fetch(`http://127.0.0.1:${port}${routes[name].path}`, { method: routes[name].method, headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: routes[name].method === "POST" ? JSON.stringify(input ?? {}) : undefined });
async function api<T = any>(name: RouteName, input?: unknown): Promise<T> { const r = await request(name, input); const body = await r.json(); if (!r.ok) throw new Error(`${r.status}: ${JSON.stringify(body)}`); return body as T; }
const start = () => startDaemon(home, { capabilities: caps, proxyPort: freePort(), log: () => {}, shutdownGraceMs: 100 });
beforeAll(async () => {
  const { identity, keystore } = await home.createIdentity("file"); const mind = new LedgerStore(home.ledgerPath);
  const fleet = foundFleet(mind, identity, { fleetName: "agents", nodeName: "keep" }); mind.close();
  home.writeConfig({ v: 1, name: "keep", fleet, port, keystore, advertise: "127.0.0.1" });
  daemon = await start();
  await api("setProvider", { id: "stand-in", kind: "openai", baseUrl: `http://127.0.0.1:${model.port}/v1` });
  await api("setRoster", { role: "planner", models: ["stand-in/m"] });
});
afterAll(async () => { await daemon?.stop(); model.stop(true); rmSync(root, { recursive: true, force: true }); });

test("real API: agents converse autonomously under a shared bound and write to the same mind", async () => {
  for (const id of ["ada", "lin"]) await api("saveAgent", { id, name: id.toUpperCase(), role: "planner" });
  await api("saveTeamRoom", { id: "forge", name: "Forge", members: ["ada", "lin"], turnBudget: 3 });
  await api("postTeamMessage", { room: "forge", text: "@ada @lin: coordinate on the project together." });
  let state: TeamSnapshot = await api("team");
  for (let n = 0; n < 200 && state.deliveries.some((d) => d.status === "queued" || d.status === "running"); n++) { await Bun.sleep(5); state = await api("team"); }
  expect(state.deliveries.some((d) => d.status === "queued" || d.status === "running")).toBe(false);
  expect(state.deliveries.filter((d) => d.status === "failed")).toEqual([]);
  const room = await api<TeamRoomView>("teamRoom", { id: "forge" });
  expect(room.messages[0]?.speaker).toBe("owner");
  expect(room.messages.filter((m) => m.speaker !== "owner")).toHaveLength(3);
  expect(new Set(room.messages.map((m) => m.speaker))).toEqual(new Set(["owner", "ada", "lin"]));
  expect(state.agents.reduce((n, m) => n + m.turnsToday, 0)).toBe(3);
  const shared = daemon.store.recall("Agents shares", 8).find((m) => m.text.includes("verified lessons"));
  expect(shared?.trust).toBe("agent");
  expect(daemon.store.event(shared!.id)?.prov?.source).toMatch(new RegExp(`^arm:(${["ada", "lin"].map((id) => teamArmLabel(daemon.identity.id, id).replace(/\./g, "\\.")).join("|")})$`));
  // What an agent is told of the others: none beneath another, the best suited takes the task.
  expect(prompts.some((p) => JSON.stringify(p).includes("one of the owner's agents, with a lasting job of your own. The primary leads the work for the owner"))).toBe(true);
  expect(prompts.some((p) => JSON.stringify(p).includes("None of you is beneath another: the one best suited to a task takes it, and evidence decides"))).toBe(true);
  expect(prompts.some((p) => /hivemind|sub-agent of you|parts of you/i.test(JSON.stringify(p)))).toBe(false);
  expect(prompts.flatMap((p) => p.tools ?? []).map((t: any) => t.function?.name)).not.toContain("bank_accounts");
}, 10000);

test("real API: your word to a room that names no agent is your agent's, and it answers it there as itself, with its own tools", async () => {
  const before = prompts.length;
  await api("postTeamMessage", { room: "forge", text: "Where does the project stand?" });
  let room = await api<TeamRoomView>("teamRoom", { id: "forge" });
  for (let n = 0; n < 400 && !room.messages.some((m) => m.speaker === "primary"); n++) { await Bun.sleep(5); room = await api<TeamRoomView>("teamRoom", { id: "forge" }); }
  expect(room.messages.at(-1)).toMatchObject({ speaker: "primary", speakerName: "Your agent", text: "A useful contribution." });
  expect(room.deliveries.find((d) => d.agent === "primary")).toMatchObject({ status: "done", trigger: room.messages.at(-2)!.id });
  // It named nobody, so no agent was asked for a turn.
  expect(room.deliveries.filter((d) => d.trigger === room.messages.at(-1)!.id)).toEqual([]);
  const asked = prompts.slice(before);
  expect(JSON.stringify(asked)).toContain("where you lead the agents for the owner");
  expect(JSON.stringify(asked)).toContain(JSON.stringify("The owner's message you answer:\nWhere does the project stand?").slice(1, -1));
  expect(asked.flatMap((p) => p.tools ?? []).map((t: any) => t.function?.name)).toContain("team_message");
}, 10000);

test("team owner routes reject external arms, spoofed speakers and fake VM availability", async () => {
  const { token } = await api("mintArm", { label: "outsider", scopes: ["chat", "mind:read", "sandbox"] });
  expect((await request("team", undefined, token)).status).toBe(403);
  expect((await request("postTeamMessage", { room: "forge", text: "forged", speaker: "ada" })).status).toBe(400);
  expect((await request("prepareTeamWorkspace", { id: "0123456789", run: "arm.team.ada" }, token)).status).toBe(403);
  expect((await request("renewTeamWorkspace", { id: "0123456789", run: "arm.team.ada" }, token)).status).toBe(403);
  const unavailable = await request("provisionAgent", { id: "ada" });
  expect(unavailable.status).toBe(424);
  expect((await api<TeamSnapshot>("team")).agents.find((m) => m.id === "ada")?.workspace).toBeNull();
  expect((await request("mintArm", { label: "team.ada" })).status).toBeGreaterThanOrEqual(400);
});

test("agents, notes, rooms and messages survive a controller restart", async () => {
  await api("teamMemory", { id: "ada", text: "Working context for the ongoing build." });
  const avatar = { v: 2 as const, color: "#b9dfd4" };
  const saved = await api("saveAgent", { id: "ada", name: "ADA", avatar });
  // A colour picked as the apps already out send it: snapped to the eight its glass is drawn in, its shape kept (glass.ts).
  const mark = { v: 4 as const, color: MARK_PALETTE[snapColor(avatar.color)]!.light, shape: readGlassProfile(saved.agent.avatar)!.shape };
  expect(saved.agent.avatar).toEqual(mark);
  expect(saved.agent.role).toBe("planner");
  expect((await request("saveAgent", { id: "ada", name: "ADA", avatar: { ...avatar, color: "url(https://untrusted.example/avatar.svg)" } })).status).toBe(400);
  expect((await request("saveAgent", { id: "ada", name: "ADA", avatar: { ...avatar, imageUrl: "javascript:alert(1)" } })).status).toBe(400);
  const before = await api<TeamRoomView>("teamRoom", { id: "forge" });
  await daemon.stop(); daemon = await start();
  expect((await api<TeamRoomView>("teamRoom", { id: "forge" })).messages).toEqual(before.messages);
  const persisted = (await api<TeamSnapshot>("team")).agents.find((m) => m.id === "ada");
  expect(persisted?.memory).toContain("ongoing build");
  expect(persisted?.avatar).toEqual(mark);
});

test("real API: you remove an agent, nobody else can; it is gone from the team and what it said stays its own", async () => {
  await api("saveAgent", { id: "temp", name: "Temp", role: "planner" });
  const { token } = await api("mintArm", { label: "remover", scopes: ["chat", "mind:read", "mind:write", "sandbox"] });
  expect((await request("removeAgent", { id: "temp" }, token)).status).toBe(403);
  // Nor has anyone else an agent's VM made again: an agent is refused on your route and on its host's, and no
  // agent can be given the scope that both need.
  expect((await request("remakeAgent", { id: "temp" }, token)).status).toBe(403);
  expect((await request("remakeTeamWorkspace", { id: "0123456789", run: "arm.team.abcdef0123.temp", providers: [] }, token)).status).toBe(403);
  expect((await request("mintArm", { label: "overreach", scopes: ["fleet:admin", "sandbox"] })).status).toBe(400);
  expect((await request("removeAgent", { id: "temp", keepWorkspace: true })).status).toBe(400);
  expect((await request("removeAgent", { id: "nobody" })).status).toBe(404);
  expect((await api<TeamSnapshot>("team")).agents.map((m) => m.id)).toEqual(["ada", "lin", "temp"]);

  expect(await api("removeAgent", { id: "lin" })).toEqual({ removed: { id: "lin", name: "LIN" }, workspace: "none" });
  const state = await api<TeamSnapshot>("team");
  expect(state.agents.map((m) => m.id)).toEqual(["ada", "temp"]);
  expect(state.removed).toEqual([{ id: "lin", name: "LIN", removedAt: expect.any(Number) }]);
  expect(state.rooms.find((r) => r.id === "forge")!.members).toEqual(["ada"]);
  const room = await api<TeamRoomView>("teamRoom", { id: "forge" });
  expect(room.messages.some((m) => m.speaker === "lin" && m.speakerName === "LIN")).toBe(true);
  // Removed is for good: not again, not written to, and its handle is nobody else's.
  expect((await request("removeAgent", { id: "lin" })).status).toBe(410);
  expect((await request("directAgent", { id: "lin" })).status).toBe(410);
  expect((await request("saveAgent", { id: "lin", name: "Lin again" })).status).toBe(409);
  // It is on record that you did it.
  const { entries } = await api<{ entries: LedgerEntry[] }>("ledger");
  expect(entries.find((e) => e.resource === "team" && e.class === "delete")).toMatchObject({ target: "worker:lin", verdict: "approved", detail: "it had no workspace" });
  // And it stays so across a restart.
  await daemon.stop(); daemon = await start();
  const again = await api<TeamSnapshot>("team");
  expect(again.agents.map((m) => m.id)).toEqual(["ada", "temp"]);
  expect(again.removed?.map((m) => m.id)).toEqual(["lin"]);
});

test("real API: given to the agents, a task goes to the agent best suited to it, in its own conversation, and says why", async () => {
  await api("saveAgent", { id: "noa", name: "NOA", role: "engineer", instructions: "Reviews changes: reads the diff and runs the tests." });
  await api("saveAgent", { id: "tor", name: "TOR", role: "engineer" });
  const goal = "Review the change to the importer and run its tests.";
  const given = await api<{ task: TeamTask; choice: { id: string; name: string; reasons: string[] }; considered: { id: string; eligible: boolean; why: string[] }[] }>("giveTeamTask", { goal, gates: ["true"] });
  // The one whose job is this work takes it, and the answer says why.
  expect(given.choice.id).toBe("noa");
  expect(given.choice.reasons).toContain("its job speaks of reviews, changes and tests");
  expect(given.task).toMatchObject({ assignee: "noa", goal, title: goal, gates: ["true"] });
  // In that agent's own conversation with you.
  expect(given.task.room).toBe((await api<{ room: { id: string } }>("directAgent", { id: "noa" })).room.id);
  // Every agent was weighed.
  expect(given.considered.map((c) => c.id)).toEqual(expect.arrayContaining(["noa", "tor", "ada"]));
  // A task none can take is refused, with each agent's reason: here, none has a desktop.
  const refused = await request("giveTeamTask", { goal: "Open the dashboard and click Export.", needs: { desktop: true } });
  expect(refused.status).toBe(409);
  expect(((await refused.json()) as { error: string }).error).toMatch(/^No agent can take this task now: .*NOA: it has no VM with a desktop/);
  // And it is yours alone, like giving an agent a task by name.
  const { token } = await api("mintArm", { label: "giver", scopes: ["chat", "mind:read", "mind:write", "sandbox"] });
  expect((await request("giveTeamTask", { goal }, token)).status).toBe(403);
});


test("real API: a role you made is yours to remove, but not while an agent works on it: you're told which", async () => {
  await api("setRoster", { role: "frontend", models: ["stand-in/front"] });
  await api("saveAgent", { id: "rolly", name: "Rolly", role: "frontend" });
  expect((await api("roster")).roster.frontend).toMatchObject({ models: ["stand-in/front"], custom: true, forAgents: true });
  const refused = await request("setRoster", { role: "frontend", models: [] });
  expect(refused.status).toBe(409);
  expect((await refused.json()).error).toBe("Rolly works on frontend: give it another role first");
  expect((await api("roster")).roster.frontend).toMatchObject({ models: ["stand-in/front"] });
  // Given another, the role is yours to remove; a built-in one emptied goes back to its defaults instead.
  await api("saveAgent", { id: "rolly", name: "Rolly", role: "engineer" });
  expect((await api("setRoster", { role: "frontend", models: [] })).roster.frontend).toBeUndefined();
  expect((await api("setRoster", { role: "swift", models: [] })).roster.swift).toMatchObject({ configured: false, custom: false });
  await api("removeAgent", { id: "rolly" });
});

test("real API: you looked at an agent's page or a room, on any device: the team says when; no agent can say it for you", async () => {
  const before = await api<TeamSnapshot>("team");
  expect(before.seen).toBeDefined();
  expect(await api("seeTeam", { agent: "ada" })).toEqual({ seen: true });
  expect(await api("seeTeam", { room: "forge" })).toEqual({ seen: true });
  const after = await api<TeamSnapshot>("team");
  expect(after.seen!["agent:ada"]).toBeGreaterThanOrEqual(before.seen!["agent:ada"] ?? 0);
  expect(after.seen!["room:forge"]).toBeGreaterThan(0);
  // One that isn't at the table; both at once, or neither; and an agent, whatever its scopes.
  expect((await request("seeTeam", { agent: "nobody" })).status).toBe(404);
  expect((await request("seeTeam", { room: "nowhere" })).status).toBe(404);
  expect((await request("seeTeam", { agent: "ada", room: "forge" })).status).toBe(400);
  expect((await request("seeTeam", {})).status).toBe(400);
  const { token } = await api("mintArm", { label: "reader", scopes: ["chat", "mind:read"] });
  expect((await request("seeTeam", { agent: "ada" }, token)).status).toBe(403);
});

test("real API: a task given again unchanged stays given again; with a changed goal it is rewritten, never both; the team says the north star (#28)", async () => {
  await api("saveAgent", { id: "gil", name: "GIL", role: "engineer" });
  const room = (await api<{ room: { id: string } }>("directAgent", { id: "gil" })).room.id;
  const first = (await api<{ task: TeamTask }>("createTeamTask", { room, assignee: "gil", title: "Fix the importer", goal: "Fix it", gates: ["true"] })).task;
  expect(first.interventions).toBeUndefined();
  // Unchanged goal and gates: a task given again, not a rewrite.
  const again = (await api<{ task: TeamTask }>("createTeamTask", { room, assignee: "gil", title: "Fix the importer", goal: "Fix it", gates: ["true"], again: first.id })).task;
  expect(again.interventions).toEqual({ again: 1 });
  const againTrail = await api<{ entries: { text: string }[] }>("teamTrail", { task: again.id });
  expect(againTrail.entries.map((e) => e.text)).toContain("You stepped in: given again after “Fix the importer”");
  // A changed goal: rewritten, said so on its trail, and never also given again.
  const rewritten = (await api<{ task: TeamTask }>("createTeamTask", { room, assignee: "gil", title: "Fix the importer", goal: "Fix it, and test the empty file", gates: ["true"], again: first.id })).task;
  expect(rewritten.interventions).toEqual({ rewritten: 1 });
  const rewrittenTrail = await api<{ entries: { text: string }[] }>("teamTrail", { task: rewritten.id });
  expect(rewrittenTrail.entries.map((e) => e.text)).toContain("You stepped in: rewrote “Fix the importer”");
  expect(rewrittenTrail.entries.map((e) => e.text)).not.toContain("You stepped in: given again");
  // A task that isn't there can't be given again, and nothing is made.
  const before = (await api<TeamSnapshot>("team")).tasks.length;
  expect((await request("createTeamTask", { room, assignee: "gil", title: "Nothing", goal: "Nothing", again: "task-000000000000" })).status).toBe(404);
  const state = await api<TeamSnapshot>("team");
  expect(state.tasks.length).toBe(before);
  expect(state.northStar).toMatchObject({ since: expect.any(Number), completed: expect.any(Number), interventions: expect.any(Number) });
});

test("real API: a file of yours goes with your words to a room, and the agent it reaches is given it", async () => {
  const { attachment } = await api<{ attachment: AttachmentRef }>("uploadAttachment", { name: "build.log", type: "text/plain", data: Buffer.from("step 3 of the build failed: missing lockfile\n").toString("base64") });
  const before = prompts.length;
  const { message } = await api<{ message: TeamMessage }>("postTeamMessage", { room: "forge", text: "@ada what broke?", attachments: [attachment] });
  expect(message.attachments).toEqual([attachment]);
  let room = await api<TeamRoomView>("teamRoom", { id: "forge" });
  const busy = (view: TeamRoomView) => view.deliveries.some((d) => d.trigger === message.id && (d.status === "queued" || d.status === "running"));
  for (let n = 0; n < 400 && busy(room); n++) { await Bun.sleep(5); room = await api<TeamRoomView>("teamRoom", { id: "forge" }); }
  expect(busy(room)).toBe(false);
  expect(room.messages.find((m) => m.id === message.id)?.attachments).toEqual([attachment]);
  // Ada was given the file's words, fenced as data.
  expect(JSON.stringify(prompts.slice(before))).toContain("step 3 of the build failed: missing lockfile");
  // Files alone are a message; one this node doesn't keep is refused, and so are an agent's.
  expect((await api<{ message: TeamMessage }>("postTeamMessage", { room: "forge", text: "", attachments: [attachment] })).message.text).toBe("");
  expect((await request("postTeamMessage", { room: "forge", text: "and this", attachments: [{ ...attachment, id: "c".repeat(64) }] })).status).toBe(409);
  expect((await request("postTeamMessage", { room: "forge", text: "" })).status).toBe(400);
  const { token } = await api("mintArm", { label: "carrier", scopes: ["chat", "mind:read", "sandbox"] });
  expect((await request("postTeamMessage", { room: "forge", text: "mine", attachments: [attachment] }, token)).status).toBe(403);
});

test("real API: an agent's workspace is yours alone to look into; one with no VM, a path outside it and its token file are refused", async () => {
  const { token } = await api("mintArm", { label: "peeker", scopes: ["chat", "mind:read", "sandbox"] });
  for (const [name, input] of [["teamFiles", { id: "ada" }], ["teamFile", { id: "ada", path: "/work/a.txt" }], ["teamChanges", { id: "ada" }]] as const) {
    expect((await request(name, input, token)).status).toBe(403);
  }
  const none = await request("teamFiles", { id: "ada" });
  expect(none.status).toBe(424);
  expect(((await none.json()) as { error: string }).error).toContain("this agent has no VM yet");
  expect((await request("teamFile", { id: "ada", path: "/etc/passwd" })).status).toBe(400);
  expect((await request("teamFiles", { id: "ada", path: "/work/../etc" })).status).toBe(400);
  expect((await request("teamFile", { id: "ada", path: "/work/.invincible-gateway.json" })).status).toBe(403);
  expect((await request("teamChanges", { id: "ada", task: "task-000000000000" })).status).toBe(404);
  // A repository by its path (a project's checkout): under /work only, and a task or a path, never both.
  expect((await request("teamChanges", { id: "ada", path: "/etc" })).status).toBe(400);
  expect((await request("teamChanges", { id: "ada", path: "/work/../etc" })).status).toBe(400);
  expect((await request("teamChanges", { id: "ada", task: "task-000000000000", path: "/work/projects/site" })).status).toBe(400);
  expect((await request("teamChanges", { id: "ada", path: "/work/projects/site" }, token)).status).toBe(403);
});

test("real API: a project's git is yours alone; an unknown project, a name git won't take, a clone with nothing to clone and a key in a message are refused", async () => {
  await api("setProject", { id: "site", name: "The site" });
  const { token } = await api("mintArm", { label: "brancher", scopes: ["chat", "mind:read", "sandbox"] });
  for (const [name, input] of [["projectGit", { id: "site" }], ["projectBranch", { id: "site", branch: "fix" }], ["projectCommit", { id: "site", message: "Fix" }], ["projectClone", { id: "site" }]] as const) {
    expect((await request(name, input, token)).status).toBe(403);
  }
  expect((await request("projectGit", { id: "nowhere" })).status).toBe(404);
  expect((await request("projectBranch", { id: "site", branch: "a..b" })).status).toBe(400);
  expect((await request("projectClone", { id: "site" })).status).toBe(409);
  expect((await request("projectCommit", { id: "site", message: `Add sk-ant-api03-${"A".repeat(93)}AA` })).status).toBe(422);
  // It has no computer yet: said, with how to make one.
  const none = await request("projectGit", { id: "site" });
  expect(none.status).toBe(424);
  expect(((await none.json()) as { error: string }).error).toContain("Your agent has no computer yet");
  await api("removeProject", { id: "site" });
});

test("real API: a node whose clock went back keeps writing, never a 500: its own events are stamped by its own clock", async () => {
  // (Found by a test that moves the clock, 27 November 2026: after it, setProject answered 500, as every write did.)
  try {
    setSystemTime(new Date(Date.now() + 63 * 60_000));
    await api("setProject", { id: "ahead", name: "Written ahead" });
  } finally {
    setSystemTime();
  }
  const after = await request("setProject", { id: "after", name: "Written after" });
  expect([after.status, ((await after.json()) as { error?: string }).error ?? null]).toEqual([200, null]);
  await api("removeProject", { id: "ahead" });
  await api("removeProject", { id: "after" });
});
