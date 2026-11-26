import { describe, expect, test } from "bun:test";
import type { TeamSnapshot, TeamTask, Teammate } from "@galahad/core/team";
import { atAGlance, attended, byAttention, doingNow, failedGate, inboxBeyond, inProject, NEW_FOR_MS, projectBadge, projectKey, seenOnOpen, shortSpan, spentSince, taskState, workOf } from "./work.ts";

const NOW = 1_764_000_000_000;
const ago = (minutes: number) => NOW - minutes * 60_000;
const knight = (id: string, repository: string | null, extra: Partial<Teammate> = {}): Teammate => ({
  id, name: id[0]!.toUpperCase() + id.slice(1), instructions: "", role: "engineer", harness: "native", enabled: true, dailyTurns: 40, turnsToday: 0,
  repository, workspaceNode: null, workspace: null, memory: "", createdAt: ago(600), updatedAt: ago(600), ...extra,
});
let n = 0;
const task = (assignee: string, status: TeamTask["status"], minutes: number, extra: Partial<TeamTask> = {}): TeamTask => ({
  id: `task-${String(++n).padStart(12, "0")}`, room: "room-x", assignee, title: `Task ${n}`, goal: "Do it.", dependsOn: [], gates: [], status, verified: false,
  progress: "", output: "", error: null, chainId: "c", createdAt: ago(minutes + 5), updatedAt: ago(minutes), ...extra,
});
const snapshot = (teammates: Teammate[], tasks: TeamTask[], seen?: Record<string, number>): Pick<TeamSnapshot, "teammates" | "tasks" | "seen"> => ({ teammates, tasks, ...(seen ? { seen } : {}) });

// Your word, 25 November 2026: the knights "more like per task/per project like t3code": the work is told by project,
// each task a thread of its own, the knight on it beside it.
describe("the work, by project", () => {
  test("a project is a repository: its address however it was written, its name its own last part or a project's of yours", () => {
    expect(projectKey("https://github.com/amiriteorg/galahad")).toBe("github.com/amiriteorg/galahad");
    expect(projectKey("https://GitHub.com/amiriteorg/galahad.git/")).toBe("github.com/amiriteorg/galahad");
    expect(projectKey("https://sovware.io/amiriteorg/galahad")).toBe("sovware.io/amiriteorg/galahad");
    expect(projectKey("not a url")).toBeNull();
    const work = workOf({ snapshot: snapshot([knight("gareth", "https://github.com/amiriteorg/galahad"), knight("kay", "https://github.com/amiriteorg/importer")], [task("gareth", "done", 30)]), projects: [{ id: "imp", name: "The importer", instructions: "", repo: "https://github.com/amiriteorg/importer.git", checkout: "/work/projects/imp", updatedAt: 1 }], now: NOW });
    expect(work.projects.map((p) => [p.name, p.repo, p.host, p.knights])).toEqual([
      ["galahad", "https://github.com/amiriteorg/galahad", "github.com", ["gareth"]],
      ["The importer", "https://github.com/amiriteorg/importer", "github.com", ["kay"]],
    ]);
  });

  test("each task is in its knight's project, the newest first; a knight with no repository's are other work", () => {
    const tasks = [task("gareth", "done", 90, { verified: true }), task("percival", "failed", 20), task("gareth", "running", 5, { progress: "Gate 1/2 · bun test" }), task("gareth", "stopped", 300)];
    const work = workOf({ snapshot: snapshot([knight("gareth", "https://github.com/amiriteorg/galahad"), knight("percival", null)], tasks), projects: [], now: NOW });
    expect(work.projects).toHaveLength(1);
    expect(work.projects[0]!.tasks.map((t) => t.id)).toEqual([tasks[2]!.id, tasks[0]!.id, tasks[3]!.id]);
    expect(work.other!.tasks.map((t) => t.id)).toEqual([tasks[1]!.id]);
    expect(work.other!.name).toBe("Other work");
    // A task's knight goes with it: its name, and its avatar for its orb.
    expect(work.projects[0]!.tasks[0]!.knight).toEqual({ id: "gareth", name: "Gareth", avatar: undefined });
  });

  test("what is under way, across every project: at work, waiting on you, queued; what needs you first", () => {
    const tasks = [task("gareth", "running", 5), task("kay", "proposed", 2, { proposedBy: "kay" }), task("gareth", "queued", 1), task("kay", "done", 0, { verified: true })];
    const work = workOf({ snapshot: snapshot([knight("gareth", "https://github.com/a/b"), knight("kay", "https://github.com/a/c")], tasks), projects: [], now: NOW });
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
      snapshot: snapshot([knight("gareth", "https://github.com/a/b")], [
        task("gareth", "running", 12, { progress: "Gate 1/2 · bun test\nmore" }),
        task("gareth", "done", 30, { verified: true }),
        task("gareth", "failed", 44, { error: "gave-up" }),
      ]),
      projects: [],
      now: NOW,
    }).projects[0]!.tasks.map((t) => t.line);
    expect(lines).toEqual(["Gareth · Gate 1/2 · bun test", "Gareth · verified · 30 min ago", "Gareth · failed: gave up · 44 min ago"]);
  });

  test("a removed knight's tasks keep their place, under its name; nothing at all is no project", () => {
    const work = workOf({ snapshot: snapshot([], [task("old", "done", 10)]), projects: [], now: NOW });
    expect(work.projects).toEqual([]);
    expect(work.other!.tasks[0]!.knight).toEqual({ id: "old", name: "old", avatar: undefined });
    expect(workOf({ snapshot: snapshot([], []), projects: [], now: NOW })).toEqual({ underWay: [], projects: [], other: null });
  });
});

// Your word, 26 November 2026: "project/tasks/coding t3code style for the knights": one list, what needs you first, each
// task a row of three lines.
describe("the work by attention", () => {
  const GALAHAD = "https://github.com/amiriteorg/galahad";
  const ada = knight("ada", GALAHAD);
  const arm = (handle: string) => `arm:team.0123456789.${handle}`;

  test("what only you can move on needs you: a proposal, work cut short, a knight asking your leave as it works, work behind a knight you paused", () => {
    const tasks = [
      task("ada", "proposed", 3, { proposedBy: "ada" }),
      task("ada", "interrupted", 4),
      task("ada", "running", 1, { progress: "Running · git push" }),
      task("bors", "queued", 2),
    ];
    const work = attended({ snapshot: snapshot([ada, knight("bors", null, { enabled: false })], tasks, {}), projects: [], asks: [{ by: arm("ada"), connector: "github", tool: "push" }], now: NOW });
    expect(work.needs.map((row) => [row.id, row.word, row.detail, row.mono])).toEqual([
      [tasks[2]!.id, "Allow?", "github.push", true],
      [tasks[3]!.id, "Knight paused", "resume Bors to start it", false],
      [tasks[0]!.id, "Approve?", "proposed by its knight", false],
      [tasks[1]!.id, "Interrupted", "look at it before it resumes", false],
    ]);
    // Each in amber, said in words too.
    expect(new Set(work.needs.map((row) => [row.state, row.tone].join()))).toEqual(new Set(["needs,needs"]));
    // Someone else's approval (Galahad's own, a loop's) is no task's: the task works on.
    const other = attended({ snapshot: snapshot([ada], [tasks[2]!], {}), projects: [], asks: [{ by: "loop:morning", connector: "gmail", tool: "send" }], now: NOW });
    expect(other.working.map((row) => row.word)).toEqual(["Working · 6m"]);
  });

  test("a result is new to you until you look at its knight or its room, on any device; then it is settled", () => {
    const failed = task("ada", "failed", 30, { error: "gave-up" });
    const verified = task("ada", "done", 10, { verified: true, changes: { artifact: "art_0123456789abcdefghijkl", files: 5, base: "a".repeat(40) } });
    const inRoom = task("ada", "done", 20, { verified: true, room: "forge" });
    const look = (seen: Record<string, number>) => attended({ snapshot: snapshot([ada], [failed, verified, inRoom], seen), projects: [], now: NOW });
    expect(look({}).active.map((row) => [row.title, row.word, row.detail])).toEqual([
      [verified.title, "Verified", "5 files kept"],
      [inRoom.title, "Verified", ""],
      [failed.title, "Failed", "gave up"],
    ]);
    // Ada's page seen after the failure, but before the newer two: only those are new.
    expect(look({ "knight:ada": ago(25) }).active.map((row) => row.id)).toEqual([verified.id, inRoom.id]);
    // The forge seen after its task ended settles it too, whatever was seen of Ada.
    expect(look({ "knight:ada": ago(25), "room:forge": ago(15) }).active.map((row) => row.id)).toEqual([verified.id]);
    expect(look({ "knight:ada": ago(1) }).done.map((row) => row.id)).toEqual([verified.id, inRoom.id, failed.id]);
    // A node that keeps no read marks: new for half a day after it ended.
    const old = task("ada", "done", NEW_FOR_MS / 60_000 + 1, { verified: true });
    const fresh = attended({ snapshot: snapshot([ada], [old, verified]), projects: [], now: NOW });
    expect([fresh.active.map((row) => row.id), fresh.done.map((row) => row.id)]).toEqual([[verified.id], [old.id]]);
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

  test("a row's three lines: its project and how it stands, its title, its knight and what it is doing", () => {
    const running = task("ada", "running", 2, { progress: "Running · bun test packages/link\nmore" });
    const [row] = attended({ snapshot: snapshot([ada], [running], {}), projects: [{ name: "Galahad", repo: `${GALAHAD}.git` }], now: NOW }).working;
    expect(row).toEqual({
      id: running.id, room: running.room, title: running.title, project: { key: "github.com/amiriteorg/galahad", name: "Galahad", badge: "G" },
      knight: { id: "ada", name: "Ada", avatar: undefined }, state: "working", attention: "working", word: "Working · 7m", tone: "work", age: null,
      detail: "bun test packages/link", mono: true, at: running.updatedAt,
    });
  });

  test("a failed gate is named where the latest line says which; a knight with no repository's work is other work", () => {
    const failed = task("kay", "failed", 5, { error: "unverified", progress: "Gate 2/2 · exit 1 · bun test db\nECONNREFUSED" });
    const [row] = attended({ snapshot: snapshot([knight("kay", null)], [failed], {}), projects: [], now: NOW }).active;
    expect([row!.word, row!.detail, row!.tone, row!.project]).toEqual(["Failed · gate 2", "not verified", "failed", { key: "other", name: "Other work", badge: "" }]);
    expect(failedGate("Gate 1/3 · exit 0 · ok")).toBeNull();
    expect(failedGate("Gate 3/3 · exit -1 · timed out")).toBe(3);
  });

  test("the projects to filter by, the busiest first, other work last; one project's rows alone", () => {
    const kay = knight("kay", "https://github.com/amiriteorg/importer");
    const tasks = [task("ada", "done", 300, { verified: true }), task("kay", "proposed", 1), task("percival", "running", 2)];
    const work = attended({ snapshot: snapshot([ada, kay, knight("percival", null)], tasks, { "knight:ada": NOW }), projects: [], now: NOW });
    expect(work.projects).toEqual([
      { key: "github.com/amiriteorg/importer", name: "importer", badge: "I", count: 1 },
      { key: "github.com/amiriteorg/galahad", name: "galahad", badge: "G", count: 1 },
      { key: "other", name: "Other work", badge: "", count: 1 },
    ]);
    const galahad = inProject(work, "github.com/amiriteorg/galahad");
    expect(byAttention(galahad).map((row) => row.id)).toEqual([tasks[0]!.id]);
    expect(byAttention(inProject(work, null)).map((row) => row.id)).toEqual([tasks[1]!.id, tasks[2]!.id, tasks[0]!.id]);
  });

  test("what a task is doing, from its latest line; a span, short; a badge's letter", () => {
    expect(doingNow("Running · git status --short")).toEqual({ text: "git status --short", mono: true });
    expect(doingNow("Plan · 1. read\n2. write")).toEqual({ text: "planning", mono: false });
    expect(doingNow("Gate 2/3 · exit 0 · bun test")).toEqual({ text: "gate 2 of 3", mono: false });
    expect(doingNow("Submitted for review · it works")).toEqual({ text: "its gates run", mono: false });
    expect(doingNow("")).toEqual({ text: "", mono: false });
    expect([shortSpan(-5), shortSpan(59_000), shortSpan(60_000), shortSpan(59 * 60_000), shortSpan(60 * 60_000), shortSpan(47 * 3_600_000)]).toEqual(["now", "now", "1m", "59m", "1h", "1d"]);
    expect([projectBadge("galahad"), projectBadge("  übung"), projectBadge("3d-lab"), projectBadge("—")]).toEqual(["G", "Ü", "3", ""]);
  });

  test("what waits in the Inbox beyond the rows that ask for it: a knight's ask is its task's row, the rest is the Inbox's", () => {
    const rows = attended({ snapshot: snapshot([ada], [task("ada", "running", 1)], {}), projects: [], asks: [{ by: arm("ada"), connector: "github", tool: "push" }], now: NOW }).needs;
    expect(inboxBeyond(3, [{ by: arm("ada") }, { by: arm("ada") }, { by: "loop:morning" }], rows)).toBe(1);
    expect(inboxBeyond(2, [{ by: "pairing" }], [])).toBe(2);
    expect(inboxBeyond(0, [{ by: arm("ada") }], rows)).toBe(0);
  });

  test("opening a task marks its knight's results read when it is the newest of them still new to you", () => {
    const older = task("ada", "failed", 30);
    const newer = task("ada", "done", 10, { verified: true });
    const running = task("ada", "running", 1);
    const theirs = snapshot([ada], [older, newer, running], {});
    expect(seenOnOpen(newer.id, theirs)).toEqual({ knight: "ada" });
    // The older first: nothing is marked, and the newer still waits for you.
    expect(seenOnOpen(older.id, theirs)).toBeNull();
    // Once Ada's page was seen after the newer one: nothing left to mark.
    expect(seenOnOpen(newer.id, snapshot([ada], [older, newer], { "knight:ada": ago(5) }))).toBeNull();
    // Read in its room: read.
    expect(seenOnOpen(newer.id, snapshot([ada], [{ ...newer, room: "forge" }], { "room:forge": ago(5) }))).toBeNull();
    // Still in hand, unknown, or a node that keeps no marks: nothing.
    expect([seenOnOpen(running.id, theirs), seenOnOpen("task-nope00000000", theirs), seenOnOpen(newer.id, snapshot([ada], [newer]))]).toEqual([null, null, null]);
  });

  test("Home's line: how many are at work and what needs you, else his own", () => {
    const work = attended({ snapshot: snapshot([ada], [task("ada", "running", 1), task("ada", "running", 2), task("ada", "queued", 3)], {}), projects: [], now: NOW });
    expect(atAGlance(work, 2, "Idle")).toEqual({ text: "2 at work · 2 need you", needs: true });
    expect(atAGlance(work, 1, "Idle")).toEqual({ text: "2 at work · 1 needs you", needs: true });
    expect(atAGlance(work, 0, "Idle")).toEqual({ text: "2 at work", needs: false });
    expect(atAGlance({ working: [] }, 0, "Idle · nothing needs you")).toEqual({ text: "Idle · nothing needs you", needs: false });
  });

  test("what a knight's work cost this week, at your prices: a lower bound where a call went uncounted or unpriced", () => {
    const line = (model: string, calls: number, unknown: number) => ({ role: "engineer", model, calls, unknown, input: 1_000_000, output: 0, cached: 0, reasoning: 0 });
    const record = (endedMinutesAgo: number, spent: ReturnType<typeof line>[]) => ({ startedAt: ago(endedMinutesAgo + 5), endedAt: ago(endedMinutesAgo), ended: "done" as const, commands: 1, revisions: 0, spent });
    const tasks = [task("ada", "done", 10, { record: record(10, [line("a/m", 2, 0)]) }), task("ada", "done", 20, { record: record(20, [line("a/m", 1, 0)]) }), task("ada", "done", 9000, { record: record(9000, [line("a/m", 5, 0)]) }), task("kay", "done", 5, { record: record(5, [line("a/m", 1, 0)]) })];
    const prices = { "a/m": { input: 0.5, output: 0 } };
    expect(spentSince(tasks, "ada", ago(60), prices)).toEqual({ usd: 1, complete: true });
    expect(spentSince(tasks, "ada", ago(60), {})).toEqual({ usd: 0, complete: false });
    expect(spentSince([task("ada", "done", 1, { record: record(1, [line("a/m", 2, 1)]) })], "ada", ago(60), prices)).toEqual({ usd: 0.5, complete: false });
    expect(spentSince(tasks, "bors", ago(60), prices)).toBeNull();
    expect(spentSince([task("ada", "done", 1, { record: record(1, [line("a/m", 1, 1)]) })], "ada", ago(60), prices)).toBeNull();
  });
});
