import { describe, expect, test } from "bun:test";
import type { TeamDelivery, TeamRoom, TeamTask, Agent } from "@invincible/core/team";
import { primaryNeeds, rosterRows, agentOfCaller, type RosterInput } from "./roster.ts";

const NOW = 1_000_000;
const person = (id: string, more: Partial<Agent> = {}): Agent => ({ id, name: id[0]!.toUpperCase() + id.slice(1), instructions: `Does ${id}'s job.\nIn detail.`, role: "engineer", harness: "native", enabled: true, dailyTurns: 40, turnsToday: 1, memory: "", repository: null, workspaceNode: null, workspace: null, createdAt: 1, updatedAt: 1, ...more });
const room = (id: string, members: string[], more: Partial<TeamRoom> = {}): TeamRoom => ({ id, name: id, members, direct: members.length === 1, turnBudget: 8, paused: false, createdAt: 1, updatedAt: 1, ...more });
const task = (assignee: string, status: TeamTask["status"], more: Partial<TeamTask> = {}): TeamTask => ({ id: `task-${assignee}${status}`.padEnd(17, "x").slice(0, 17), room: `dm-${assignee}`, assignee, title: "Fix the importer", goal: "Fix it", dependsOn: [], gates: [], status, verified: status === "done", progress: "", output: "", error: null, chainId: "c", createdAt: 10, updatedAt: 20, ...more });
const delivery = (agent: string, status: TeamDelivery["status"], more: Partial<TeamDelivery> = {}): TeamDelivery => ({ id: `d-${agent}-${status}`, room: `dm-${agent}`, agent, trigger: "m", chainId: "c", status, error: null, createdAt: 10, updatedAt: 20, ...more });
const rows = (input: Partial<RosterInput["snapshot"]>, more: Partial<Omit<RosterInput, "snapshot">> = {}) =>
  rosterRows({ snapshot: { agents: [person("ada")], rooms: [room("dm-ada", ["ada"])], tasks: [], deliveries: [], ...input }, now: NOW, ...more });
const ada = (input: Partial<RosterInput["snapshot"]>, more: Partial<Omit<RosterInput, "snapshot">> = {}) => rows(input, more).find((row) => row.id === "ada")!;

describe("the roster: each agent, then each room", () => {
  test("agents come in the node's order, then the rooms that are not one agent's own, the latest spoken in first", () => {
    const list = rows({
      agents: [person("ada"), person("lin")],
      rooms: [room("dm-ada", ["ada"]), room("old", ["ada", "lin"], { name: "Old", updatedAt: 5 }), room("forge", ["ada", "lin"], { name: "Forge", updatedAt: 9 })],
    });
    expect(list.map((row) => [row.kind, row.id, row.name])).toEqual([["agent", "ada", "Ada"], ["agent", "lin", "Lin"], ["room", "forge", "Forge"], ["room", "old", "Old"]]);
    // An agent's row opens its own conversation with you, once there is one.
    expect(list.map((row) => row.room)).toEqual(["dm-ada", null, "forge", "old"]);
    expect(new Set(list.map((row) => row.key)).size).toBe(4);
  });

  test("an agent with nothing going on says its job in a line, and who made it when that wasn't you", () => {
    expect(ada({})).toMatchObject({ line: "Does ada's job.", needs: false, expression: "idle" });
    expect(ada({ agents: [person("ada", { createdBy: "primary" })] }).line).toBe("Made by your agent · Does ada's job.");
    expect(ada({ agents: [person("ada", { instructions: "" })] }).line).toBe("engineer");
  });

  test("a running task says its title and the step it is at, and the face is at work", () => {
    expect(ada({ tasks: [task("ada", "running", { progress: "Running · bun test packages/link\nmore output" })] })).toMatchObject({ line: "Fix the importer · Running · bun test packages/link", needs: false, expression: "working" });
    expect(ada({ tasks: [task("ada", "running")] }).line).toBe("Working on “Fix the importer”");
    // The work in hand is said before anything older that went wrong.
    expect(ada({ tasks: [task("ada", "running", { updatedAt: 30 }), task("ada", "failed", { id: "task-old", updatedAt: 20, error: "gave-up" })] })).toMatchObject({ line: "Working on “Fix the importer”", needs: false });
  });

  test("a reply being written is said", () => {
    expect(ada({ deliveries: [delivery("ada", "running")] })).toMatchObject({ line: "Writing a reply", needs: false, expression: "thinking" });
  });

  test("a latest task that failed or was interrupted marks the row, with what it said", () => {
    expect(ada({ tasks: [task("ada", "failed", { error: "gave-up\nmore" })] })).toMatchObject({ line: "Failed: “Fix the importer” · gave up", needs: true });
    expect(ada({ tasks: [task("ada", "failed")] }).line).toBe("Failed: “Fix the importer”");
    expect(ada({ tasks: [task("ada", "interrupted")] })).toMatchObject({ line: "Interrupted: “Fix the importer” · review it before resuming", needs: true });
    // A reply that failed needs you too: nothing was said.
    expect(ada({ deliveries: [delivery("ada", "failed", { error: "no model answers as engineer" })] })).toMatchObject({ line: "Couldn't reply · no model answers as engineer", needs: true });
  });

  test("the mark is for the latest work only: given again, or done since, it is gone", () => {
    const failed = task("ada", "failed", { id: "task-first", updatedAt: 20 });
    expect(ada({ tasks: [failed, task("ada", "queued", { id: "task-again", updatedAt: 30 })] })).toMatchObject({ line: "Queued: “Fix the importer”", needs: false });
    expect(ada({ tasks: [failed, task("ada", "done", { id: "task-again", updatedAt: 30 })] })).toMatchObject({ line: "Reviewed: “Fix the importer”", needs: false });
    // You stopped it yourself: said, not marked.
    expect(ada({ tasks: [task("ada", "stopped")] })).toMatchObject({ line: "Stopped: “Fix the importer”", needs: false });
  });

  test("a verified task says what it kept", () => {
    const changes = { artifact: "art_AAAAAAAAAAAAAAAAAAAAAA", files: 3, base: "a".repeat(40) };
    expect(ada({ tasks: [task("ada", "done", { changes })] }).line).toBe("Reviewed: “Fix the importer” · 3 files kept");
    expect(ada({ tasks: [task("ada", "done", { changes: { ...changes, files: 1 } })] }).line).toBe("Reviewed: “Fix the importer” · 1 file kept");
  });

  // Your word through the lead, 27 November 2026: no "Verified" beside a "Reviewed, not proven". A task that ended is
  // said as its proof allows (lib/steps.ts verdictOf, from its record), as its card and its thread say it.
  test("a task that ended says its verdict as its proof allows, never Verified", () => {
    const record = (proof?: { before: number[]; after: number[]; review: "pass" | "revise" | null; sameModel: boolean }, ended: "done" | "unverified" = "done") => ({ startedAt: 0, endedAt: 1, ended, commands: 1, revisions: 0, spent: [], ...(proof ? { proof } : {}) });
    const line = (more: Partial<TeamTask>) => ada({ tasks: [task("ada", "done", more)] }).line;
    expect(line({ record: record({ before: [1], after: [0], review: "pass", sameModel: false }) })).toBe("Proven: “Fix the importer”");
    expect(line({ record: record({ before: [0], after: [0], review: "pass", sameModel: false }) })).toBe("Reviewed, not proven: “Fix the importer”");
    expect(line({ record: record({ before: [1], after: [0], review: "pass", sameModel: true }) })).toBe("Reviewed, not proven: “Fix the importer”");
    expect(line({})).toBe("Reviewed: “Fix the importer”");
    // Ended without its proof (it said "Done" for this): what its record says of it.
    expect(line({ verified: false })).toBe("Not verified: “Fix the importer”");
    expect(line({ verified: false, record: record({ before: [1, 1], after: [0, 2], review: null, sameModel: false }, "unverified") })).toBe("Failed · gate 2: “Fix the importer”");
    for (const more of [{}, { verified: false }, { record: record({ before: [0], after: [0], review: "pass", sameModel: false }) }]) expect(line(more)).not.toContain("Verified");
  });

  test("a paused agent, or one whose allowance is spent, is marked only when work waits on it", () => {
    expect(ada({ agents: [person("ada", { enabled: false })] })).toMatchObject({ line: "Paused", needs: false, expression: "resting" });
    expect(ada({ agents: [person("ada", { enabled: false })], tasks: [task("ada", "queued")], deliveries: [delivery("ada", "queued")] })).toMatchObject({ line: "Paused · 2 waiting", needs: true });
    expect(ada({ agents: [person("ada", { turnsToday: 40 })] })).toMatchObject({ line: "Daily allowance spent", needs: false });
    expect(ada({ agents: [person("ada", { turnsToday: 40 })], tasks: [task("ada", "queued")] })).toMatchObject({ line: "Daily allowance spent · 1 waiting", needs: true });
  });

  test("queued work says what it waits for", () => {
    const first = task("lin", "running", { id: "task-first", title: "Sync resumes" });
    expect(ada({ tasks: [first, task("ada", "queued", { dependsOn: ["task-first"] })] })).toMatchObject({ line: "Waiting for “Sync resumes”", needs: false, expression: "waiting" });
    expect(ada({ deliveries: [delivery("ada", "queued")] }).line).toBe("Reply queued");
  });

  test("the last thing said shows where the app has read the conversation, unless a task ended since", () => {
    const said = new Map([["dm-ada", { speaker: "ada", speakerName: "Ada", text: "The gate passes.\nDetails follow.", createdAt: 50 }]]);
    expect(ada({}, { said }).line).toBe("Ada: The gate passes.");
    expect(ada({ tasks: [task("ada", "done", { updatedAt: 40 })] }, { said }).line).toBe("Ada: The gate passes.");
    expect(ada({ tasks: [task("ada", "done", { updatedAt: 60 })] }, { said }).line).toBe("Reviewed: “Fix the importer”");
    expect(ada({}, { said: new Map([["dm-ada", { speaker: "owner", speakerName: "You", text: "Start with the parser", createdAt: 50 }]]) }).line).toBe("You: Start with the parser");
    // Something was said after what the app read: its words aren't known, so the old ones aren't shown as the latest.
    expect(ada({ rooms: [room("dm-ada", ["ada"], { updatedAt: 70 })] }, { said }).line).toBe("Does ada's job.");
  });

  test("an approval an agent asked for marks its row, before anything else", () => {
    const asks = [{ by: "arm:team.0123456789.ada", connector: "github", tool: "create_pull_request" }, { by: "arm:team.0123456789.ada", connector: "github", tool: "merge" }, { by: "loop:morning", connector: "mail", tool: "send" }];
    // Asking is what its face shows too, even over work it has running: only you can move it on.
    expect(ada({ tasks: [task("ada", "running")] }, { asks })).toMatchObject({ line: "Asks for approval: github.create_pull_request, and 1 more", needs: true, expression: "asking" });
    expect(ada({}, { asks: asks.slice(0, 1) }).line).toBe("Asks for approval: github.create_pull_request");
    expect(ada({}, { asks: asks.slice(2) }).expression).toBe("idle");
  });
});

describe("an agent's state: the ring round its face and the chip beside its name", () => {
  test("says what its line says first: what waits on you, the work in hand, a failure, a pause, a queue, a pass, rest", () => {
    const asks = [{ by: "arm:team.0123456789.ada", connector: "github", tool: "merge" }];
    expect(ada({ tasks: [task("ada", "running")] }, { asks }).state).toBe("needs");
    expect(ada({ tasks: [task("ada", "proposed", { proposedBy: "ada" })] }).state).toBe("needs");
    expect(ada({ tasks: [task("ada", "running")] }).state).toBe("working");
    expect(ada({ deliveries: [delivery("ada", "running")] }).state).toBe("working");
    expect(ada({ tasks: [task("ada", "failed")] }).state).toBe("failed");
    expect(ada({ deliveries: [delivery("ada", "failed")] }).state).toBe("failed");
    // Cut short by the node: yours to look at before it resumes, not a failure of its own.
    expect(ada({ tasks: [task("ada", "interrupted")] }).state).toBe("needs");
    expect(ada({ agents: [person("ada", { enabled: false })] }).state).toBe("paused");
    expect(ada({ agents: [person("ada", { enabled: false })], tasks: [task("ada", "queued")] })).toMatchObject({ state: "paused", needs: true });
    // A spent allowance renews by itself: at rest, unless work waits on it.
    expect(ada({ agents: [person("ada", { turnsToday: 40 })] }).state).toBe("resting");
    expect(ada({ agents: [person("ada", { turnsToday: 40 })], tasks: [task("ada", "queued")] }).state).toBe("needs");
    expect(ada({ tasks: [task("ada", "queued")] }).state).toBe("queued");
    expect(ada({ deliveries: [delivery("ada", "queued")] }).state).toBe("queued");
    // Verified a moment ago (its face is pleased); later, at rest.
    expect(ada({ tasks: [task("ada", "done", { updatedAt: NOW - 1000 })] })).toMatchObject({ state: "verified", expression: "pleased" });
    expect(ada({ tasks: [task("ada", "done", { updatedAt: NOW - 60_000 })] }).state).toBe("resting");
    expect(ada({}).state).toBe("resting");
    // A room has none: its row has no face.
    expect(rows({ rooms: [room("dm-ada", ["ada"]), room("forge", ["ada"], { direct: false })] }).find((row) => row.kind === "room")!.state).toBeUndefined();
  });

  test("what ended on its page since you last looked is new to you, green until you look (on any device)", () => {
    const reply = delivery("ada", "done", { updatedAt: 50 });
    // Its reply to you ended after you last looked: new. Looked at since: at rest.
    expect(ada({ deliveries: [reply], seen: { "agent:ada": 40 } })).toMatchObject({ state: "unread", unread: true, needs: false });
    expect(ada({ deliveries: [reply], seen: { "agent:ada": 50 } })).toMatchObject({ state: "resting", unread: false });
    // Never looked at: anything that ended is new. Its verified work says so, however long ago it passed.
    expect(ada({ deliveries: [reply], seen: {} }).state).toBe("unread");
    expect(ada({ tasks: [task("ada", "done", { updatedAt: NOW - 60_000 })], seen: {} })).toMatchObject({ state: "verified", unread: true });
    // A pass you have seen is at rest, however pleased its face still is.
    expect(ada({ tasks: [task("ada", "done", { updatedAt: NOW - 1000 })], seen: { "agent:ada": NOW } })).toMatchObject({ state: "resting", expression: "pleased" });
    // Its page holds its replies to you, not what it says in a room: that is the room's to be new in.
    expect(ada({ deliveries: [delivery("ada", "done", { room: "forge", updatedAt: 50 })], seen: { "agent:ada": 40 } })).toMatchObject({ state: "resting", unread: false });
    // What waits on you, work in hand and a failure still come first.
    expect(ada({ deliveries: [reply], tasks: [task("ada", "running", { updatedAt: 60 })], seen: {} })).toMatchObject({ state: "working", unread: true });
    expect(ada({ tasks: [task("ada", "failed", { updatedAt: 60 })], seen: {} }).state).toBe("failed");
    // A node that keeps no such thing: nothing is new, and a pass is green only a moment.
    expect(ada({ deliveries: [reply] })).toMatchObject({ state: "resting", unread: false });
  });
});

describe("a task an agent proposed", () => {
  test("marks its agent's row with what waits for your approval, and its face asks", () => {
    const proposal = task("ada", "proposed", { proposedBy: "ada", title: "Draft the notes" });
    expect(ada({ tasks: [proposal] })).toMatchObject({ line: "Proposes “Draft the notes”", needs: true, expression: "asking" });
    expect(ada({ tasks: [proposal, task("ada", "proposed", { id: "task-adaproposed2", proposedBy: "ada", title: "Older", updatedAt: 5 })] }).line).toBe("Proposes “Draft the notes”, and 1 more");
    // One another agent proposed for it says who.
    expect(rows({ agents: [person("ada"), person("noa")], tasks: [task("ada", "proposed", { proposedBy: "noa", title: "Check it" })] }).find((row) => row.id === "ada")!.line).toBe("Noa proposes “Check it”");
    // Asking for your approval still comes first.
    expect(ada({ tasks: [proposal] }, { asks: [{ by: "arm:team.0123456789.ada", connector: "github", tool: "merge" }] }).line).toBe("Asks for approval: github.merge");
  });
});

describe("a room's row", () => {
  const forge = (input: Partial<RosterInput["snapshot"]>, more: Partial<Omit<RosterInput, "snapshot">> = {}) =>
    rows({ agents: [person("ada"), person("lin")], rooms: [room("forge", ["ada", "lin"], { name: "Forge", ...(input.rooms?.[0] ?? {}) })], tasks: input.tasks ?? [], deliveries: input.deliveries ?? [] }, more).find((row) => row.kind === "room")!;

  test("says who is in it, who is at work in it, and what was last said there", () => {
    expect(forge({})).toMatchObject({ line: "Ada, Lin", needs: false });
    expect(forge({ tasks: [task("ada", "running", { room: "forge" })] }).line).toBe("Ada · Fix the importer");
    expect(forge({ tasks: [task("ada", "running", { room: "forge" }), task("lin", "running", { room: "forge" })] }).line).toBe("2 at work · Fix the importer");
    expect(forge({ deliveries: [delivery("lin", "running", { room: "forge" })] }).line).toBe("Lin is writing");
    expect(forge({}, { said: new Map([["forge", { speaker: "lin", speakerName: "Lin", text: "I take the app.", createdAt: 50 }]]) }).line).toBe("Lin: I take the app.");
  });

  test("is marked when its latest work failed or was interrupted, or when it is paused with work waiting", () => {
    expect(forge({ tasks: [task("ada", "interrupted", { room: "forge" })] })).toMatchObject({ line: "Interrupted: “Fix the importer” · review it before resuming", needs: true });
    expect(forge({ rooms: [room("forge", [], { paused: true })] })).toMatchObject({ line: "Paused", needs: false });
    expect(forge({ rooms: [room("forge", [], { paused: true })], tasks: [task("ada", "queued", { room: "forge" })] })).toMatchObject({ line: "Paused · 1 waiting", needs: true });
    expect(forge({ tasks: [task("ada", "running", { room: "forge" }), task("lin", "proposed", { room: "forge", proposedBy: "lin", title: "Ship it" })] })).toMatchObject({ line: "Lin proposes “Ship it”", needs: true });
    // Work in another room is not this room's.
    expect(forge({ tasks: [task("ada", "failed", { room: "elsewhere" })] })).toMatchObject({ line: "Ada, Lin", needs: false });
  });

  test("is new to you when a reply or a task ended there since you last looked at it", () => {
    const room = (seen: Record<string, number> | undefined) =>
      rows({ agents: [person("ada"), person("lin")], rooms: [{ id: "forge", name: "Forge", members: ["ada", "lin"], direct: false, turnBudget: 8, paused: false, createdAt: 1, updatedAt: 1 }], tasks: [], deliveries: [delivery("lin", "done", { room: "forge", updatedAt: 50 })], ...(seen ? { seen } : {}) }).find((row) => row.kind === "room")!;
    expect(room({ "room:forge": 40 }).unread).toBe(true);
    expect(room({ "room:forge": 50 }).unread).toBe(false);
    expect(room({}).unread).toBe(true);
    expect(room(undefined).unread).toBe(false);
  });
});

describe("whose an approval is", () => {
  test("an agent's name is read from the request it filed, and from nothing that only looks like one", () => {
    expect(agentOfCaller("arm:team.0123456789.ada")).toBe("ada");
    expect(agentOfCaller("arm:team.abcdef0123.ada-2")).toBe("ada-2");
    for (const by of ["arm:hermes", "loop:morning", "run", "node:keep", "arm:team.0123456789.", "arm:team.xyz.ada", "arm:team.0123456789.Ada", "x arm:team.0123456789.ada"]) expect([by, agentOfCaller(by)]).toEqual([by, null]);
  });

  test("what needs you is on the row it belongs to, and on your agent's for everything that is no agent's", () => {
    const asks = [{ by: "arm:team.0123456789.ada" }, { by: "arm:team.0123456789.ada" }, { by: "arm:team.0123456789.gone" }, { by: "loop:morning" }];
    // Five things wait in the Inbox; two are Ada's. One was asked by an agent that is no longer on the roster: it stays the primary's.
    expect(primaryNeeds(5, asks, ["ada", "lin"])).toBe(3);
    expect(primaryNeeds(0, [], ["ada"])).toBe(0);
    // Never less than nothing, whatever the two lists say of each other for a moment.
    expect(primaryNeeds(1, asks, ["ada"])).toBe(0);
  });
});
