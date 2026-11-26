import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { TrialRecord, trialProblem } from "@galahad/core";
import type { TrialJob } from "../src/trial-cli.ts";
import { trialCommand, UsageError } from "../src/trial-commands.ts";
import { attemptCase, chooseCases, commandsFor, type GateRun, hardestFirst, judgeGates, rootOf, yourCases } from "../src/trial-yours.ts";
import { FIX, GATES, KNIGHT_ARTIFACT, knightOf, runOf, taskOf, teamOf, widgets, widgetsCase, WIDGETS, YoursStandIn } from "./yours-standin.ts";

/*
 * Trials from your own work: which of your knights' tasks are cases, in what order a run takes them, and a trial of
 * one, against a stand-in node whose sandboxes really run git and the gates (yours-standin.ts). What's held: a gate
 * counts only when it fails before any work and passes with the task's own change, both asked before any model is
 * paid; what the engineer left is graded apart, in a fresh sandbox, on the commit the task began from; a change that
 * alters a test its gate runs fails that gate; and a crash of the machinery is a crash, never a score.
 */

describe("your cases", () => {
  test("a knight's task is a case when it passed review in a repository, with the commit it began from kept and gates of its own", () => {
    const team = teamOf(
      [
        taskOf(),
        taskOf({ id: "task-notverified", verified: false, status: "failed" }),
        taskOf({ id: "task-nochangekp", changes: undefined }),
        taskOf({ id: "task-norecordxx", record: undefined }),
        taskOf({ id: "task-nogatesxxx", gates: [] }),
        taskOf({ id: "task-removedxxx", assignee: "lancelot" }),
        taskOf({ id: "task-norepoxxxx", assignee: "bors" }),
      ],
      [knightOf(), knightOf({ id: "bors", name: "Bors", repository: null })],
    );
    const { cases, left } = yourCases(team);
    expect(cases).toEqual([
      {
        id: "task-abc-def-1234",
        task: "task-abc_def-1234",
        title: "Make the total the sum",
        knight: "gareth",
        goal: "total.sh adds one to every total. Make it print the sum.",
        gates: [GATES.test, GATES.readme],
        repository: WIDGETS,
        base: "0".repeat(40),
        artifact: KNIGHT_ARTIFACT,
        record: runOf(),
      },
    ]);
    expect(left).toEqual([
      { task: "task-notverified", why: "not verified" },
      { task: "task-nochangekp", why: "no change kept" },
      { task: "task-norecordxx", why: "no record of its run" },
      { task: "task-nogatesxxx", why: "no gates" },
      { task: "task-removedxxx", why: "knight removed" },
      { task: "task-norepoxxxx", why: "no repository" },
    ]);
  });

  test("a task whose gate looks at a desktop isn't a case yet: a trial's sandbox has none, so its gate couldn't pass there", () => {
    const team = teamOf([
      taskOf({ id: "task-desktopxxx", gates: ["test -s answer.txt && grep -qi oath answer.txt && desktop text | head -2 | grep -qi oath"] }),
      taskOf({ id: "task-desktop2xx", gates: ["desktop screenshot out.png"] }),
      // A gate that only names the word is no desktop's.
      taskOf({ id: "task-wordonlyxx", gates: ["grep -q desktop README.md"] }),
    ]);
    const { cases, left } = yourCases(team);
    expect(cases.map((c) => c.task)).toEqual(["task-wordonlyxx"]);
    expect(left).toEqual([
      { task: "task-desktopxxx", why: "needs a desktop" },
      { task: "task-desktop2xx", why: "needs a desktop" },
    ]);
  });

  test("the hardest first, by what the original run took: revisions, then commands, then tokens, then the latest", () => {
    const tokens = (n: number) => [{ role: "engineer", model: "example/coder", calls: 1, unknown: 0, input: n, output: 0, cached: 0, reasoning: 0 }];
    const team = teamOf([
      taskOf({ id: "task-aaaaaaaaaaaa", record: runOf({ revisions: 0, commands: 30, spent: tokens(900_000) }) }),
      taskOf({ id: "task-bbbbbbbbbbbb", record: runOf({ revisions: 2, commands: 5, spent: tokens(10_000) }) }),
      taskOf({ id: "task-cccccccccccc", record: runOf({ revisions: 1, commands: 20, spent: tokens(10_000) }) }),
      taskOf({ id: "task-dddddddddddd", record: runOf({ revisions: 1, commands: 20, spent: tokens(50_000) }) }),
      taskOf({ id: "task-eeeeeeeeeeee", record: runOf({ revisions: 1, commands: 25, spent: tokens(1_000) }) }),
      taskOf({ id: "task-ffffffffffff", record: runOf({ revisions: 1, commands: 20, spent: tokens(50_000), endedAt: 9_000_000 }) }),
    ]);
    expect(yourCases(team).cases.map((c) => c.task)).toEqual(["task-bbbbbbbbbbbb", "task-eeeeeeeeeeee", "task-ffffffffffff", "task-dddddddddddd", "task-cccccccccccc", "task-aaaaaaaaaaaa"]);
    const [a, b] = yourCases(team).cases;
    expect(hardestFirst(a!, b!)).toBeLessThan(0);
    expect(hardestFirst(a!, a!)).toBe(0);
  });

  test("a run names cases by task id, as it is or as a slug, or by knight; a task that isn't a case says why", () => {
    const yours = yourCases(
      teamOf(
        [taskOf(), taskOf({ id: "task-second_case", record: runOf({ revisions: 1 }) }), taskOf({ id: "task-other_knigh", assignee: "bors" }), taskOf({ id: "task-notverified", verified: false })],
        [knightOf(), knightOf({ id: "bors", name: "Bors" })],
      ),
    );
    expect(chooseCases(yours, []).map((c) => c.task)).toEqual(["task-second_case", "task-abc_def-1234", "task-other_knigh"]);
    expect(chooseCases(yours, ["task-abc_def-1234"]).map((c) => c.id)).toEqual(["task-abc-def-1234"]);
    expect(chooseCases(yours, ["task-abc-def-1234"]).map((c) => c.id)).toEqual(["task-abc-def-1234"]);
    expect(chooseCases(yours, ["gareth"]).map((c) => c.task)).toEqual(["task-second_case", "task-abc_def-1234"]);
    expect(() => chooseCases(yours, ["task-notverified"])).toThrow("task-notverified isn't a case (not verified)");
    expect(() => chooseCases(yours, ["lancelot", "gareth"])).toThrow("lancelot: no case, nor a knight with one");
  });

  test("a gate counts only when it fails before any work and passes with the task's own change", () => {
    const gates = ["a", "b", "c", "d"];
    const before: GateRun = { exits: [1, 0, 1, 1], altered: [[], [], [], []] };
    const withOwn: GateRun = { exits: [0, 0, 127, 0], altered: [[], [], [], ["test/d.test.ts"]] };
    expect(judgeGates(gates, before, withOwn)).toEqual({
      counted: [0],
      uncounted: ["gate 2 passes before any work", "gate 3 fails with the task's own change too (exit 127)", "gate 4 fails with the task's own change too (alters test/d.test.ts, which it runs)"],
    });
    expect(judgeGates(["a"], { exits: [0], altered: [[]] }, { exits: [0], altered: [[]] }).counted).toEqual([]);
  });
});

describe("a trial of a case", () => {
  let repo: ReturnType<typeof widgets>;
  const nodes: YoursStandIn[] = [];
  beforeAll(() => {
    repo = widgets();
  });
  afterAll(() => {
    for (const node of nodes) node.remove();
    repo.remove();
  });
  const standIn = (work: string | null = null): YoursStandIn => {
    const node = new YoursStandIn({ [WIDGETS]: repo.dir }, repo.patch);
    node.work = work;
    nodes.push(node);
    return node;
  };
  const job = (over: Partial<TrialJob> = {}): TrialJob => ({ seed: 7, run: "r-test", suite: "yours", version: "abc1234", network: "online", ...over });
  const valid = (record: TrialRecord) => {
    expect(TrialRecord.parse(record)).toEqual(record);
    expect(trialProblem(record)).toBeNull();
  };

  test("the commit it began from goes in a fresh sandbox, is worked as a quest with its gates, and what was left is graded by them in another", async () => {
    const node = standIn(FIX);
    const c = widgetsCase(repo.base);
    const record = (await attemptCase(node, c, job()))!;
    valid(record);
    // A case is the same at any seed: recorded at 0, so two runs of it pair case by case.
    expect(record).toMatchObject({ suite: "yours", problem: "task-abc-def-1234", title: "Make the total the sum", domain: "gareth", seed: 0, status: "scored", score: 1, quest: { status: "done" } });
    // Only the gate that proves something is an answer; the one that passed already is said, not counted.
    expect(record.answers).toEqual([{ key: "gate_1", units: "pass", expected: 1, got: 1, tolerance: 0, ok: true }]);
    expect(record.note).toBe("counted: gate 1 of 2; gate 2 passes before any work");
    expect(record.models).toEqual(["fake/planner", "fake/engineer", "fake/reviewer"]);

    // Two sandboxes to see which gates prove something (as it was, with the task's own change), before any model
    // is asked; then the engineer's; then a fresh one to grade what was left. Each made for this alone, each gone.
    expect(node.boxes.map((b) => String(b.input.quest).slice(0, 2))).toEqual(["g-", "g-", "t-", "g-"]);
    expect(node.destroyed.sort()).toEqual(node.boxes.map((b) => b.id).sort());
    expect(node.boxes.every((b) => b.input.network === "online")).toBe(true);
    expect(node.chats.length).toBeGreaterThan(0);
    // Every one of them had the repository at the commit the task began from, through the gateway, where its knight had it.
    expect(node.checkouts).toEqual(node.boxes.map((b) => ({ id: b.id, on: "n_ultra", repository: WIDGETS, commit: repo.base, path: "/work/tasks/task-abc_def-1234" })));
    // The task's own change went only where gates were run, never where the engineer worked.
    const [workshop] = node.workshops();
    expect(workshop!.commands.some((command) => command.includes("/work/.trial/"))).toBe(false);
    expect(node.graders()[1]!.commands.some((command) => command.includes("/work/.trial/"))).toBe(true);
    // Its commands and gates ran where the knight's did, the gates exactly as the task has them.
    expect(workshop!.commands).toContain(`mkdir -p /work/.tmp && export TMPDIR=/work/.tmp && cd '${rootOf(c)}' && ${FIX}`);
    expect(workshop!.commands).toContain(`mkdir -p /work/.tmp && export TMPDIR=/work/.tmp && cd '${rootOf(c)}' && ${GATES.test}`);
    // Nothing the mind learned went with it: no memories, no archive, no skills.
    expect(node.chats.every((chat) => chat.memories === false && !chat.archive && !chat.quest)).toBe(true);
    // What it left is kept with its work, as a patch against the commit it began from.
    const kept = node.artifacts.get(record.artifact!)!.get("changes.patch")!;
    expect(new TextDecoder().decode(kept)).toContain("-awk '{ s += $1 } END { print s + 1 }' \"$1\"\n+awk '{ s += $1 } END { print s }' \"$1\"");
  });

  test("a trial has the commands a real task needs: three times what its knight's run used, never fewer than 150", async () => {
    expect(commandsFor({ record: runOf({ commands: 13 }) })).toBe(150);
    expect(commandsFor({ record: runOf({ commands: 52 }) })).toBe(156);
    const node = standIn(FIX);
    await attemptCase(node, widgetsCase(repo.base), job());
    expect(JSON.stringify(node.chats)).toContain("You have 150 commands in all.");
  });

  test("work that doesn't do it scores nothing, beside how its quest ended", async () => {
    const node = standIn("echo 'looked, changed nothing' > NOTES.md");
    const record = (await attemptCase(node, widgetsCase(repo.base), job()))!;
    valid(record);
    expect(record).toMatchObject({ status: "scored", score: 0, answers: [{ key: "gate_1", got: 0, ok: false }] });
    expect(record.quest?.status).not.toBe("done");
    expect(record.note).toBe("counted: gate 1 of 2; gate 2 passes before any work; gate 1 failed (exit 1): expected 6, got 7");
  });

  test("a change that alters the test its gate runs fails that gate, whatever the gate then printed", async () => {
    const node = standIn("printf '#!/bin/sh\\nexit 0\\n' > test/total_test.sh");
    const record = (await attemptCase(node, widgetsCase(repo.base), job()))!;
    valid(record);
    expect(record).toMatchObject({ status: "scored", score: 0, answers: [{ key: "gate_1", got: 0, ok: false }] });
    expect(record.note).toContain("gate 1 failed (alters test/total_test.sh, which it runs)");
  });

  test("a case whose every gate passes before any work isn't graded, and no model is asked", async () => {
    const node = standIn(FIX);
    const record = (await attemptCase(node, widgetsCase(repo.base, { gates: [GATES.readme] }), job()))!;
    valid(record);
    expect(record).toMatchObject({ status: "crashed", score: 0, answers: [] });
    expect(record.note).toBe("not graded: no gate proves anything here (gate 1 passes before any work)");
    expect(node.chats).toEqual([]);
    expect(node.boxes.map((b) => String(b.input.quest).slice(0, 2))).toEqual(["g-"]);
  });

  test("a gate the task's own change can't pass in a fresh sandbox doesn't count; with none left, the case isn't graded", async () => {
    const node = standIn(FIX);
    const record = (await attemptCase(node, widgetsCase(repo.base, { gates: [GATES.tool] }), job()))!;
    valid(record);
    expect(record).toMatchObject({ status: "crashed", score: 0, answers: [] });
    expect(record.note).toBe("not graded: no gate proves anything here (gate 1 fails with the task's own change too (exit 1))");
    expect(node.chats).toEqual([]);
    // Beside one that does count, it is said and left out.
    const both = standIn(FIX);
    const graded = (await attemptCase(both, widgetsCase(repo.base, { gates: [GATES.test, GATES.tool] }), job({ harness: { ...{ gates: false, plannerGates: false, effort: 1, skills: false, archive: true, revisions: 2, engram: false, diff: false, escalate: false, remind: false, keepReads: false, tools: false, contract: false, agent: null, planner: true, review: true } } })))!;
    valid(graded);
    expect(graded).toMatchObject({ status: "scored", score: 1 });
    expect(graded.note).toBe("counted: gate 1 of 2; gate 2 fails with the task's own change too (exit 1)");
  });

  test("a commit that can't be fetched is a crash, not a score, and no model is asked", async () => {
    const node = standIn(FIX);
    const record = (await attemptCase(node, widgetsCase("f".repeat(40)), job()))!;
    valid(record);
    expect(record).toMatchObject({ status: "crashed", score: 0, answers: [] });
    expect(record.note).toContain("couldn't fetch ffffffffffff of example/widgets");
    expect(node.chats).toEqual([]);
    expect(node.destroyed).toEqual(node.boxes.map((b) => b.id));
  });

  test("a sandbox that can't be made, or a task's change that can't be read, is a crash", async () => {
    const full = standIn(FIX);
    full.full = true;
    const none = (await attemptCase(full, widgetsCase(repo.base), job()))!;
    valid(none);
    expect(none).toMatchObject({ status: "crashed", note: "no sandbox host has a free slot" });
    const lost = standIn(FIX);
    const unread = (await attemptCase(lost, widgetsCase(repo.base, { artifact: `art_${"x".repeat(22)}` }), job()))!;
    valid(unread);
    expect(unread.status).toBe("crashed");
    expect(unread.note).toContain("the task's own change couldn't be read");
    expect(lost.chats).toEqual([]);
  });

  test("a crash after the work keeps its counted gates as not run, and how its quest ended beside them", async () => {
    const node = standIn(FIX);
    // (Room for the two that see which gates count, and the engineer's: none for grading what was left.)
    node.full = 3;
    const record = (await attemptCase(node, widgetsCase(repo.base), job()))!;
    valid(record);
    expect(record).toMatchObject({ status: "crashed", score: 0, quest: { status: "done" }, note: "no sandbox host has a free slot" });
    expect(record.answers).toEqual([{ key: "gate_1", units: "pass", expected: 1, got: null, tolerance: 0, ok: false }]);
  });

  test("with effort, each attempt starts from the commit in a sandbox of its own, and the one the reviewer took is graded", async () => {
    const node = standIn(FIX);
    const record = (await attemptCase(node, widgetsCase(repo.base), job({ effort: 2 })))!;
    valid(record);
    expect(record).toMatchObject({ status: "scored", score: 1 });
    expect(node.workshops()).toHaveLength(2);
    expect(node.checkouts.filter((c) => node.workshops().some((b) => b.id === c.id))).toHaveLength(2);
    expect(node.chats.some((chat) => String(chat.messages[0].content).startsWith("You are choosing between") && chat.memories === false)).toBe(true);
  });

  test("stopped by you, nothing is recorded", async () => {
    const node = standIn(FIX);
    const stop = new AbortController();
    stop.abort();
    expect(await attemptCase(node, widgetsCase(repo.base), job({ signal: stop.signal }))).toBeNull();
  });
});

describe("the yours suite at the command line", () => {
  let printed: string[] = [];
  const realLog = console.log;
  beforeEach(() => {
    printed = [];
    console.log = (...args: unknown[]) => void printed.push(args.join(" "));
  });
  afterEach(() => {
    console.log = realLog;
  });
  const out = () => printed.join("\n");
  const trial = (node: YoursStandIn, sub: string, rest: string[], flags: Record<string, unknown> = {}) => trialCommand({ command: "trial", sub, rest, flags: { parallel: "1", ...flags }, node: () => node });
  const spent = (input: number) => [{ role: "engineer", model: "example/coder", calls: 9, unknown: 0, input, output: 4_000, cached: 0, reasoning: 0 }];

  test("trial problems --suite yours lists the cases hardest first, with what each took and cost when it was done, and why the rest aren't cases", async () => {
    const node = new YoursStandIn({});
    node.team = teamOf([
      taskOf({ id: "task-easy_one-123", title: "Fix the typo in the README", record: runOf({ revisions: 0, commands: 4, spent: spent(20_000) }) }),
      taskOf({ id: "task-hard_one-123", record: runOf({ revisions: 2, commands: 31, spent: spent(90_000) }) }),
      taskOf({ id: "task-notverified", verified: false }),
      taskOf({ id: "task-nogatesxxxx", gates: [] }),
    ]);
    expect(await trial(node, "problems", [], { suite: "yours" })).toBe(0);
    expect(printed[0]).toBe("yours · your knights' tasks that passed review, each worked again from the commit it began at and graded by its own gates · hardest first");
    expect(printed[1]).toBe(`  ${"task-hard-one-123".padEnd(26)} ${"gareth".padEnd(13)} Make the total the sum\n${" ".repeat(43)}when it was done: 2 revisions · 31 commands · 18 min · 94.0k tokens · $0.11`);
    expect(printed[2]).toBe(`  ${"task-easy-one-123".padEnd(26)} ${"gareth".padEnd(13)} Fix the typo in the README\n${" ".repeat(43)}when it was done: 0 revisions · 4 commands · 18 min · 24.0k tokens · $0.04`);
    // What a run of the hardest would likely cost, going by when they were done; and what isn't a case, and why.
    expect(out()).toContain("A run that names none takes the first 2 (--hardest n for more or fewer). When they were done they took 118k tokens · $0.14");
    expect(out()).toContain("2 of your knights' 4 latest tasks aren't cases: 1 not verified, 1 no gates.");
    // Every suite at once needs no node: your own work is pointed to, not read.
    printed = [];
    expect(await trialCommand({ command: "trial", sub: "problems", rest: [], flags: {}, node: () => { throw new Error("no node was needed"); } })).toBe(0);
    expect(out()).toContain("your node's own: galahad trial problems --suite yours");
    expect(out()).toContain("cantilever-beam");
  });

  test("a run takes the hardest 5 unless told otherwise; names choose some; --hardest takes that many of those", async () => {
    const node = new YoursStandIn({});
    node.team = teamOf(Array.from({ length: 7 }, (_, i) => taskOf({ id: `task-case_${String(i).padStart(7, "0")}`, record: runOf({ revisions: i % 3, commands: 10 + i }) })), [knightOf(), knightOf({ id: "bors", name: "Bors" })]);
    node.team.tasks.push(taskOf({ id: "task-bors_task-01", assignee: "bors" }));
    const count = async (rest: string[], flags: Record<string, unknown> = {}) => {
      printed = [];
      expect(await trial(node, "estimate", rest, { suite: "yours", ...flags })).toBe(0);
      return Number(/^(\d+) trial\(s\) from the yours suite/.exec(printed[0] ?? "")?.[1]);
    };
    expect(await count([])).toBe(5);
    expect(await count([], { hardest: "2" })).toBe(2);
    expect(await count(["gareth"])).toBe(7);
    expect(await count(["gareth"], { hardest: "3" })).toBe(3);
    expect(await count(["task-case_0000001", "task-bors-task-01"])).toBe(2);
    await expect(trial(node, "estimate", [], { suite: "yours", hardest: "0" })).rejects.toThrow("--hardest must be a whole number from 1 to 100");
    await expect(trial(node, "estimate", [], { suite: "agentic", hardest: "2" })).rejects.toThrow("the agentic suite has no --hardest");
    await expect(trial(node, "estimate", [], { suite: "yours", level: "2" })).rejects.toThrow("the yours suite has no --level");
    await expect(trial(node, "estimate", [], { suite: "yours", net: "isolated" })).rejects.toThrow("--net must be online or gateway for the yours suite");
    await expect(trial(node, "estimate", ["task-nothere-0001"], { suite: "yours" })).rejects.toThrow("task-nothere-0001: no case, nor a knight with one");
    node.team = teamOf([taskOf({ verified: false })]);
    await expect(trial(node, "estimate", [], { suite: "yours" })).rejects.toThrow(UsageError);
    await expect(trial(node, "estimate", [], { suite: "yours" })).rejects.toThrow("the yours suite has nothing to run yet (galahad trial problems --suite yours says why)");
  });

  test("its trials are ordinary trials: the report and compare read two runs of it, pairing case by case", async () => {
    const repo = widgets();
    const node = new YoursStandIn({ [WIDGETS]: repo.dir }, repo.patch);
    node.work = FIX;
    try {
      node.team = teamOf([
        taskOf({ changes: { artifact: KNIGHT_ARTIFACT, files: 1, base: repo.base } }),
        taskOf({ id: "task-other_one-12", changes: { artifact: KNIGHT_ARTIFACT, files: 1, base: repo.base }, record: runOf({ revisions: 1 }) }),
      ]);
      expect(await trial(node, "run", [], { suite: "yours" })).toBe(0);
      expect(out()).toContain("[2 trial(s) from the yours suite, 1 at a time (as asked), in the workshop, each from the commit its task began at, with no archive, memories or skills (they may hold its answer) · network online");
      expect(out()).toContain("Galahad Index 100%");
      expect(await trial(node, "run", [], { suite: "yours" })).toBe(0);
      const runs = [...new Set(node.recorded.map((t) => t.run))];
      expect(runs).toHaveLength(2);
      expect(node.recorded.map((t) => [t.suite, t.problem, t.seed])).toEqual([
        ["yours", "task-other-one-12", 0],
        ["yours", "task-abc-def-1234", 0],
        ["yours", "task-other-one-12", 0],
        ["yours", "task-abc-def-1234", 0],
      ]);
      // What each spent is recorded beside it, as for any suite.
      expect(node.recorded.every((t) => t.spent?.lines.some((l) => l.role === "engineer"))).toBe(true);
      // Each of the four was graded: one that wasn't says why here (a gate's run under a loaded machine, 22 November
      // 2026, left one case 1/1 in the report below, and nothing said what had become of the other).
      expect(node.recorded.filter((t) => t.status !== "scored").map((t) => `${t.problem}: ${t.status}: ${t.note ?? "no note"}`)).toEqual([]);
      printed = [];
      expect(await trialCommand({ command: "trials", sub: undefined, rest: [], flags: { suite: "yours" }, node: () => node })).toBe(0);
      expect(out()).toContain("— yours —");
      expect(out()).toMatch(/task-abc-def-1234\s+2\/2\s+solved · mean score 100%/);
      printed = [];
      expect(await trial(node, "compare", runs)).toBe(0);
      expect(out()).toContain("On the 2 tasks both ran (same problem, same seed)");
    } finally {
      node.remove();
      repo.remove();
    }
    // (Two whole runs of the command, with real git and bash: 2.6 s alone, over five in a loaded full suite.)
  }, 30_000);
});
