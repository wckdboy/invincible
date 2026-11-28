import { describe, expect, test } from "bun:test";
import type { TeamSnapshot, TeamTask, Agent } from "@invincible/core/team";
import { atAGlance, attended, byAttention, doingNow, failedGate, failedIn, inboxBeyond, inProject, namesProjects, NEW_FOR_MS, projectBadge, projectKey, seenOnOpen, shortSpan, spentSince, taskState, workOf } from "./work.ts";

const NOW = 1_764_000_000_000;
const ago = (minutes: number) => NOW - minutes * 60_000;
const agent = (id: string, repository: string | null, extra: Partial<Agent> = {}): Agent => ({
  id, name: id[0]!.toUpperCase() + id.slice(1), instructions: "", role: "engineer", harness: "native", enabled: true, dailyTurns: 40, turnsToday: 0,
  repository, workspaceNode: null, workspace: null, memory: "", createdAt: ago(600), updatedAt: ago(600), ...extra,
});
let n = 0;
const task = (assignee: string, status: TeamTask["status"], minutes: number, extra: Partial<TeamTask> = {}): TeamTask => ({
  id: `task-${String(++n).padStart(12, "0")}`, room: "room-x", assignee, title: `Task ${n}`, goal: "Do it.", dependsOn: [], gates: [], status, verified: false,
  progress: "", output: "", error: null, chainId: "c", createdAt: ago(minutes + 5), updatedAt: ago(minutes), ...extra,
});
const snapshot = (agents: Agent[], tasks: TeamTask[], seen?: Record<string, number>): Pick<TeamSnapshot, "agents" | "tasks" | "seen"> => ({ agents, tasks, ...(seen ? { seen } : {}) });

// Your word, 25 November 2026: the agents "more like per task/per project like t3code": the work is told by project,
// each task a thread of its own, the agent on it beside it.
describe("the work, by project", () => {
  test("a project is a repository: its address however it was written, its name its own last part or a project's of yours", () => {
    expect(projectKey("https://github.com/amiriteorg/invincible")).toBe("github.com/amiriteorg/invincible");
    expect(projectKey("https://GitHub.com/amiriteorg/invincible.git/")).toBe("github.com/amiriteorg/invincible");
    expect(projectKey("https://github.com/amiriteorg/invincible")).toBe("github.com/amiriteorg/invincible");
    expect(projectKey("not a url")).toBeNull();
    const work = workOf({ snapshot: snapshot([agent("max", "https://github.com/amiriteorg/invincible"), agent("noa", "https://github.com/amiriteorg/importer")], [task("max", "done", 30)]), projects: [{ id: "imp", name: "The importer", instructions: "", repo: "https://github.com/amiriteorg/importer.git", checkout: "/work/projects/imp", updatedAt: 1 }], now: NOW });
    expect(work.projects.map((p) => [p.name, p.repo, p.host, p.agents])).toEqual([
      ["invincible", "https://github.com/amiriteorg/invincible", "github.com", ["max"]],
      ["The importer", "https://github.com/amiriteorg/importer", "github.com", ["noa"]],
    ]);
  });

  test("each task is in its agent's project, the newest first; an agent with no repository's are other work", () => {
    const tasks = [task("max", "done", 90, { verified: true }), task("ivo", "failed", 20), task("max", "running", 5, { progress: "Gate 1/2 · bun test" }), task("max", "stopped", 300)];
    const work = workOf({ snapshot: snapshot([agent("max", "https://github.com/amiriteorg/invincible"), agent("ivo", null)], tasks), projects: [], now: NOW });
    expect(work.projects).toHaveLength(1);
    expect(work.projects[0]!.tasks.map((t) => t.id)).toEqual([tasks[2]!.id, tasks[0]!.id, tasks[3]!.id]);
    expect(work.other!.tasks.map((t) => t.id)).toEqual([tasks[1]!.id]);
    expect(work.other!.name).toBe("Other work");
    // A task's agent goes with it: its name, and its avatar for its orb.
    expect(work.projects[0]!.tasks[0]!.agent).toEqual({ id: "max", name: "Max", avatar: undefined });
  });

  test("what is under way, across every project: at work, waiting on you, queued; what needs you first", () => {
    const tasks = [task("max", "running", 5), task("noa", "proposed", 2, { proposedBy: "noa" }), task("max", "queued", 1), task("noa", "done", 0, { verified: true })];
    const work = workOf({ snapshot: snapshot([agent("max", "https://github.com/a/b"), agent("noa", "https://github.com/a/c")], tasks), projects: [], now: NOW });
    expect(work.underWay.map((t) => [t.id, t.state])).toEqual([[tasks[1]!.id, "needs"], [tasks[0]!.id, "working"], [tasks[2]!.id, "queued"]]);
    // A project with work in hand or waiting on you comes before one at rest.
    expect(work.projects.map((p) => [p.name, p.running, p.needs])).toEqual([["c", 0, 1], ["b", 1, 0]]);
  });

  test("a task's state is its ring's, and its line says who, what and how it went, in a word", () => {
    expect(taskState(task("a", "running", 0))).toBe("working");
    expect(taskState(task("a", "proposed", 0))).toBe("needs");
    expect(taskState(task("a", "interrupted", 0))).toBe("needs");
    expect(taskState(task("a", "queued", 0))).toBe("queued");
    expect(taskState(task("a", "failed", 0))).toBe("failed");
    expect(taskState(task("a", "done", 0, { verified: true }))).toBe("verified");
    expect(taskState(task("a", "done", 0))).toBe("resting");
    expect(taskState(task("a", "stopped", 0))).toBe("paused");
    const lines = workOf({
      snapshot: snapshot([agent("max", "https://github.com/a/b")], [
        task("max", "running", 12, { progress: "Gate 1/2 · bun test\nmore" }),
        task("max", "done", 30, { verified: true }),
        task("max", "failed", 44, { error: "gave-up" }),
      ]),
      projects: [],
      now: NOW,
    }).projects[0]!.tasks.map((t) => t.line);
    expect(lines).toEqual(["Max · Gate 1/2 · bun test", "Max · verified · 30 min ago", "Max · failed: gave up · 44 min ago"]);
  });

  test("a removed agent's tasks keep their place, under its name; nothing at all is no project", () => {
    const work = workOf({ snapshot: snapshot([], [task("old", "done", 10)]), projects: [], now: NOW });
    expect(work.projects).toEqual([]);
    expect(work.other!.tasks[0]!.agent).toEqual({ id: "old", name: "old", avatar: undefined });
    expect(workOf({ snapshot: snapshot([], []), projects: [], now: NOW })).toEqual({ underWay: [], projects: [], other: null });
  });
});

// Your word, 26 November 2026: "project/tasks/coding t3code style for the [agents]": one list, what needs you first, each
// task a row of three lines.
describe("the work by attention", () => {
  const PRIMARY = "https://github.com/amiriteorg/invincible";
  const ada = agent("ada", PRIMARY);
  const arm = (handle: string) => `arm:team.0123456789.${handle}`;

  test("what only you can move on needs you: a proposal, work cut short, an agent asking for your approval as it works, work behind an agent you paused", () => {
    const tasks = [
      task("ada", "proposed", 3, { proposedBy: "ada" }),
      task("ada", "interrupted", 4),
      task("ada", "running", 1, { progress: "Running · git push" }),
      task("eli", "queued", 2),
    ];
    const work = attended({ snapshot: snapshot([ada, agent("eli", null, { enabled: false })], tasks, {}), projects: [], asks: [{ by: arm("ada"), connector: "github", tool: "push" }], now: NOW });
    expect(work.needs.map((row) => [row.id, row.word, row.detail, row.mono])).toEqual([
      [tasks[2]!.id, "Allow?", "github.push", true],
      [tasks[3]!.id, "Agent paused", "resume Eli to start it", false],
      [tasks[0]!.id, "Approve?", "proposed by its agent", false],
      [tasks[1]!.id, "Interrupted", "look at it before it resumes", false],
    ]);
    // Each in amber, said in words too.
    expect(new Set(work.needs.map((row) => [row.state, row.tone].join()))).toEqual(new Set(["needs,needs"]));
    // Someone else's approval (The primary's own, a loop's) is no task's: the task works on.
    const other = attended({ snapshot: snapshot([ada], [tasks[2]!], {}), projects: [], asks: [{ by: "loop:morning", connector: "gmail", tool: "send" }], now: NOW });
    expect(other.working.map((row) => row.word)).toEqual(["Working · 6m"]);
  });

  test("a result is new to you until you look at its agent or its room, on any device; then it is settled", () => {
    const failed = task("ada", "failed", 30, { error: "gave-up" });
    const verified = task("ada", "done", 10, { verified: true, changes: { artifact: "art_0123456789abcdefghijkl", files: 5, base: "a".repeat(40) } });
    const inRoom = task("ada", "done", 20, { verified: true, room: "forge" });
    const look = (seen: Record<string, number>) => attended({ snapshot: snapshot([ada], [failed, verified, inRoom], seen), projects: [], now: NOW });
    expect(look({}).active.map((row) => [row.title, row.word, row.detail])).toEqual([
      [verified.title, "Reviewed", "5 files kept"],
      [inRoom.title, "Reviewed", ""],
      [failed.title, "Gave up", "gave up"],
    ]);
    // Ada's page seen after the failure, but before the newer two: only those are new.
    expect(look({ "agent:ada": ago(25) }).active.map((row) => row.id)).toEqual([verified.id, inRoom.id]);
    // The forge seen after its task ended settles it too, whatever was seen of Ada.
    expect(look({ "agent:ada": ago(25), "room:forge": ago(15) }).active.map((row) => row.id)).toEqual([verified.id]);
    expect(look({ "agent:ada": ago(1) }).done.map((row) => row.id)).toEqual([verified.id, inRoom.id, failed.id]);
    // A node that keeps no read marks: new for half a day after it ended.
    const old = task("ada", "done", NEW_FOR_MS / 60_000 + 1, { verified: true });
    const fresh = attended({ snapshot: snapshot([ada], [old, verified]), projects: [], now: NOW });
    expect([fresh.active.map((row) => row.id), fresh.done.map((row) => row.id)]).toEqual([[verified.id], [old.id]]);
  });

  // Your word through the lead, 27 November 2026: no "Verified" beside a "Reviewed, not proven". A row that ended says
  // its verdict as its proof allows (lib/steps.ts verdictOf, from its record), as its card and its thread say it, in its
  // colour: in ink with its tick only where it is proven, red where it failed, quiet otherwise (the iPhone's StateWord).
  test("a row that ended says its verdict as its proof allows, never Verified", () => {
    const record = (proof?: { before: number[]; after: number[]; review: "pass" | "revise" | null; sameModel: boolean }, ended: "done" | "unverified" | "gave-up" = "done") => ({ startedAt: 0, endedAt: 1, ended, commands: 1, revisions: 0, spent: [], ...(proof ? { proof } : {}) });
    const tasks = [
      task("ada", "done", 10, { verified: true, record: record({ before: [1], after: [0], review: "pass", sameModel: false }) }),
      task("ada", "done", 11, { verified: true, record: record({ before: [0], after: [0], review: "pass", sameModel: false }) }),
      task("ada", "done", 12, { verified: true }),
      task("ada", "done", 13, { verified: false }),
      task("ada", "failed", 14, { record: record({ before: [1, 1], after: [0, 2], review: null, sameModel: false }, "unverified") }),
      task("ada", "failed", 15, { record: record({ before: [1], after: [0], review: "revise", sameModel: false }, "unverified") }),
      // A record from before its gates were kept: the failing gate its progress names, as before.
      task("ada", "failed", 16, { progress: "Gate 2/3 · exit 1 · bun test" }),
      task("ada", "failed", 17, { error: "gave-up" }),
      task("ada", "stopped", 18, { error: "stopped" }),
    ];
    const rows = byAttention(attended({ snapshot: snapshot([ada], tasks, {}), projects: [], now: NOW }));
    expect(rows.map((row) => [row.word, row.tone, row.verdict])).toEqual([
      ["Proven", "ok", "proven"],
      ["Reviewed, not proven", "neutral", "reviewed"],
      ["Reviewed", "neutral", "reviewed"],
      ["Not verified", "neutral", "unverified"],
      ["Failed · gate 2", "failed", "failed"],
      ["Sent back", "failed", "rejected"],
      ["Failed · gate 2", "failed", "failed"],
      ["Gave up", "failed", "gave-up"],
      ["Stopped", "neutral", "stopped"],
    ]);
    expect(rows.filter((row) => row.word.includes("Verified"))).toEqual([]);
    // Work in hand has no verdict yet.
    const inHand = byAttention(attended({ snapshot: snapshot([ada], [task("ada", "running", 1), task("ada", "queued", 2)], {}), projects: [], now: NOW }));
    expect(inHand.map((row) => row.verdict)).toEqual([null, null]);
  });

  test("a failure you have seen is settled, folded with what was verified, but counted on its own so it never hides", () => {
    const failed = task("ada", "failed", 30, { error: "gave-up" });
    const verified = task("ada", "done", 10, { verified: true });
    const work = attended({ snapshot: snapshot([ada], [failed, verified], { "agent:ada": ago(1) }), projects: [], now: NOW });
    expect(work.done.map((row) => row.id)).toEqual([verified.id, failed.id]);
    expect(failedIn(work.done)).toBe(1);
    expect(failedIn(work.done.filter((row) => row.id !== failed.id))).toBe(0);
  });

  test("rows name their project only where the work is in more than one: in one, or none, \"Other work\" says nothing", () => {
    const none = attended({ snapshot: snapshot([agent("eli", null)], [task("eli", "running", 1)], {}), projects: [], now: NOW });
    expect([none.projects.map((project) => project.name), namesProjects(none)]).toEqual([["Other work"], false]);
    const one = attended({ snapshot: snapshot([ada], [task("ada", "running", 1), task("ada", "queued", 1)], {}), projects: [], now: NOW });
    expect([one.projects.length, namesProjects(one)]).toEqual([1, false]);
    const two = attended({ snapshot: snapshot([ada, agent("eli", null)], [task("ada", "running", 1), task("eli", "queued", 1)], {}), projects: [], now: NOW });
    expect([two.projects.map((project) => project.name), namesProjects(two)]).toEqual([["invincible", "Other work"], true]);
  });

  test("at work and queued are under way, at work first; a stop of yours is settled at once", () => {
    const tasks = [task("ada", "queued", 1), task("ada", "running", 3, { progress: "Gate 1/2 · exit 0 · bun test" }), task("ada", "stopped", 2), task("ada", "queued", 0, { dependsOn: [] })];
    tasks[0]!.dependsOn = [tasks[1]!.id];
    const work = attended({ snapshot: snapshot([ada], tasks, {}), projects: [], now: NOW });
    expect(work.working.map((row) => [row.id, row.word, row.detail, row.age])).toEqual([
      [tasks[1]!.id, "Working · 8m", "gate 1 of 2", null],
      [tasks[3]!.id, "Queued", "", "now"],
      [tasks[0]!.id, "Queued", `after “${tasks[1]!.title}”`, "1m"],
    ]);
    expect(work.done.map((row) => [row.id, row.word, row.state])).toEqual([[tasks[2]!.id, "Stopped", "paused"]]);
  });

  test("a row's three lines: its project and how it stands, its title, its agent and what it is doing", () => {
    const running = task("ada", "running", 2, { progress: "Running · bun test packages/link\nmore" });
    const [row] = attended({ snapshot: snapshot([ada], [running], {}), projects: [{ name: "Invincible", repo: `${PRIMARY}.git` }], now: NOW }).working;
    expect(row).toEqual({
      id: running.id, room: running.room, title: running.title, project: { key: "github.com/amiriteorg/invincible", name: "Invincible", badge: "I" },
      agent: { id: "ada", name: "Ada", avatar: undefined }, state: "working", attention: "working", word: "Working · 7m", tone: "work", verdict: null, age: null,
      detail: "bun test packages/link", mono: true, at: running.updatedAt,
    });
  });

  test("a failed gate is named where the latest line says which; an agent with no repository's work is other work", () => {
    const failed = task("noa", "failed", 5, { error: "unverified", progress: "Gate 2/2 · exit 1 · bun test db\nECONNREFUSED" });
    const [row] = attended({ snapshot: snapshot([agent("noa", null)], [failed], {}), projects: [], now: NOW }).active;
    expect([row!.word, row!.detail, row!.tone, row!.project]).toEqual(["Failed · gate 2", "not verified", "failed", { key: "other", name: "Other work", badge: "" }]);
    expect(failedGate("Gate 1/3 · exit 0 · ok")).toBeNull();
    expect(failedGate("Gate 3/3 · exit -1 · timed out")).toBe(3);
  });

  test("the projects to filter by, the busiest first, other work last; one project's rows alone", () => {
    const noa = agent("noa", "https://github.com/amiriteorg/importer");
    const tasks = [task("ada", "done", 300, { verified: true }), task("noa", "proposed", 1), task("ivo", "running", 2)];
    const work = attended({ snapshot: snapshot([ada, noa, agent("ivo", null)], tasks, { "agent:ada": NOW }), projects: [], now: NOW });
    expect(work.projects).toEqual([
      { key: "github.com/amiriteorg/importer", name: "importer", badge: "I", count: 1 },
      { key: "github.com/amiriteorg/invincible", name: "invincible", badge: "I", count: 1 },
      { key: "other", name: "Other work", badge: "", count: 1 },
    ]);
    const primary = inProject(work, "github.com/amiriteorg/invincible");
    expect(byAttention(primary).map((row) => row.id)).toEqual([tasks[0]!.id]);
    expect(byAttention(inProject(work, null)).map((row) => row.id)).toEqual([tasks[1]!.id, tasks[2]!.id, tasks[0]!.id]);
  });

  test("what a task is doing, from its latest line; a span, short; a badge's letter", () => {
    expect(doingNow("Running · git status --short")).toEqual({ text: "git status --short", mono: true });
    expect(doingNow("Plan · 1. read\n2. write")).toEqual({ text: "planning", mono: false });
    expect(doingNow("Gate 2/3 · exit 0 · bun test")).toEqual({ text: "gate 2 of 3", mono: false });
    expect(doingNow("Submitted for review · it works")).toEqual({ text: "its gates run", mono: false });
    expect(doingNow("")).toEqual({ text: "", mono: false });
    expect([shortSpan(-5), shortSpan(59_000), shortSpan(60_000), shortSpan(59 * 60_000), shortSpan(60 * 60_000), shortSpan(47 * 3_600_000)]).toEqual(["now", "now", "1m", "59m", "1h", "1d"]);
    expect([projectBadge("garden"), projectBadge("  übung"), projectBadge("3d-lab"), projectBadge("—")]).toEqual(["G", "Ü", "3", ""]);
  });

  test("what waits in the Inbox beyond the rows that ask for it: an agent's ask is its task's row, the rest is the Inbox's", () => {
    const rows = attended({ snapshot: snapshot([ada], [task("ada", "running", 1)], {}), projects: [], asks: [{ by: arm("ada"), connector: "github", tool: "push" }], now: NOW }).needs;
    expect(inboxBeyond(3, [{ by: arm("ada") }, { by: arm("ada") }, { by: "loop:morning" }], rows)).toBe(1);
    expect(inboxBeyond(2, [{ by: "pairing" }], [])).toBe(2);
    expect(inboxBeyond(0, [{ by: arm("ada") }], rows)).toBe(0);
  });

  test("opening a task marks its agent's results read when it is the newest of them still new to you", () => {
    const older = task("ada", "failed", 30);
    const newer = task("ada", "done", 10, { verified: true });
    const running = task("ada", "running", 1);
    const theirs = snapshot([ada], [older, newer, running], {});
    expect(seenOnOpen(newer.id, theirs)).toEqual({ agent: "ada" });
    // The older first: nothing is marked, and the newer still waits for you.
    expect(seenOnOpen(older.id, theirs)).toBeNull();
    // Once Ada's page was seen after the newer one: nothing left to mark.
    expect(seenOnOpen(newer.id, snapshot([ada], [older, newer], { "agent:ada": ago(5) }))).toBeNull();
    // Read in its room: read.
    expect(seenOnOpen(newer.id, snapshot([ada], [{ ...newer, room: "forge" }], { "room:forge": ago(5) }))).toBeNull();
    // Still in hand, unknown, or a node that keeps no marks: nothing.
    expect([seenOnOpen(running.id, theirs), seenOnOpen("task-nope00000000", theirs), seenOnOpen(newer.id, snapshot([ada], [newer]))]).toEqual([null, null, null]);
  });

  test("Home's line: what needs you first (its colour and its first words agree), then how many are at work, else its own", () => {
    const work = attended({ snapshot: snapshot([ada], [task("ada", "running", 1), task("ada", "running", 2), task("ada", "queued", 3)], {}), projects: [], now: NOW });
    expect(atAGlance(work, 2, "Idle")).toEqual({ text: "2 need you · 2 at work", needs: true });
    expect(atAGlance(work, 1, "Idle")).toEqual({ text: "1 needs you · 2 at work", needs: true });
    expect(atAGlance(work, 0, "Idle")).toEqual({ text: "2 at work", needs: false });
    expect(atAGlance({ working: [] }, 0, "Idle · nothing needs you")).toEqual({ text: "Idle · nothing needs you", needs: false });
  });

  test("what an agent's work cost this week, at your prices: a lower bound where a call went uncounted or unpriced", () => {
    const line = (model: string, calls: number, unknown: number) => ({ role: "engineer", model, calls, unknown, input: 1_000_000, output: 0, cached: 0, reasoning: 0 });
    const record = (endedMinutesAgo: number, spent: ReturnType<typeof line>[]) => ({ startedAt: ago(endedMinutesAgo + 5), endedAt: ago(endedMinutesAgo), ended: "done" as const, commands: 1, revisions: 0, spent });
    const tasks = [task("ada", "done", 10, { record: record(10, [line("a/m", 2, 0)]) }), task("ada", "done", 20, { record: record(20, [line("a/m", 1, 0)]) }), task("ada", "done", 9000, { record: record(9000, [line("a/m", 5, 0)]) }), task("noa", "done", 5, { record: record(5, [line("a/m", 1, 0)]) })];
    const prices = { "a/m": { input: 0.5, output: 0 } };
    expect(spentSince(tasks, "ada", ago(60), prices)).toEqual({ usd: 1, complete: true, atMost: false });
    expect(spentSince(tasks, "ada", ago(60), {})).toEqual({ usd: 0, complete: false, atMost: false });
    expect(spentSince([task("ada", "done", 1, { record: record(1, [line("a/m", 2, 1)]) })], "ada", ago(60), prices)).toEqual({ usd: 0.5, complete: false, atMost: false });
    expect(spentSince(tasks, "eli", ago(60), prices)).toBeNull();
    expect(spentSince([task("ada", "done", 1, { record: record(1, [line("a/m", 1, 1)]) })], "ada", ago(60), prices)).toBeNull();
  });
});
