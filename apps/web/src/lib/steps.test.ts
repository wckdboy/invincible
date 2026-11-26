import { describe, expect, test } from "bun:test";
import type { TeamTrailEntry } from "@galahad/core/team";
import { commandKind, costWords, gateRows, liveStep, proofOf, reviewOf, sameModelReview, stepGroups, summaryWords, workedFor, workSummary } from "./steps.ts";

/* A task's trail as the node writes it (team-runtime.ts progress()), its lines in the order they happened. */
const T0 = 1_764_000_000_000;
const trail = (...texts: string[]): TeamTrailEntry[] => texts.map((text, i) => ({ n: i + 1, at: T0 + i * 10_000, text }));
const EDIT = "edit 'packages/link/sync.ts' <<'END'\n-  retry()\n+  resume()\nEND";
const WRITE = "cat > 'packages/link/resume.ts' <<'END'\nexport const resume = 1;\nEND";

describe("a task's work, folded", () => {
  test("steps alike in a row fold into one line; the plan, each gate, the review and the runner's notes stand alone", () => {
    const groups = stepGroups(trail(
      "Plan · 1. read the link\n2. make it resume",
      "Thinking · the link drops mid-sync",
      "Running · sed -n '1,200p' 'packages/link/sync.ts'",
      "Exit 0 · lines 1-200 of 340",
      "Running · sed -n '1,200p' 'packages/link/peer.ts'",
      "Exit 0 · lines 1-80 of 80",
      `Running · ${EDIT}`,
      "Exit 0 · Edited packages/link/sync.ts",
      `Running · ${WRITE}`,
      "Exit 0 · Wrote packages/link/resume.ts: 1 line",
      "Running · bun test packages/link",
      "Exit 1 · 2 fail",
      "Running · bun test packages/link",
      "Exit 0 · 14 pass",
      "Submitted for review · it resumes",
      "Gate 1/2 · exit 0 · bun test packages/link\n14 pass",
      "Gate 2/2 · exit 1 · bun run typecheck\nerror TS2304",
      "Gates · 1 of 2 failed: back to the work",
      "Tripwire · no-lockfiles refused a command: *.lock\n$ rm bun.lock",
      "Review · revise\nThe banner is not wired.",
    ));
    expect(groups.map((g) => [g.kind, g.text, g.tone])).toEqual([
      ["plan", "Planned the work", "neutral"],
      ["read", "Read sync.ts and peer.ts", "neutral"],
      ["edit", "Edited sync.ts and resume.ts", "neutral"],
      ["run", "Ran 2 commands · 1 failed", "warn"],
      ["submitted", "Submitted it for its gates and review", "neutral"],
      ["gate", "Gate 1 of 2 · passed", "ok"],
      ["gate", "Gate 2 of 2 · failed, exit 1", "failed"],
      ["note", "Tripwire · no-lockfiles refused a command: *.lock", "warn"],
      ["review", "The reviewer sent it back", "warn"],
    ]);
    // What is inside each: the plan's lines, the paths, each command with its exit.
    expect(groups[0]!.items.map((i) => i.text)).toEqual(["1. read the link", "2. make it resume"]);
    expect(groups[2]!.items).toEqual([{ text: "packages/link/sync.ts", exit: 0 }, { text: "packages/link/resume.ts", exit: 0 }]);
    expect(groups[3]!.items).toEqual([{ text: "bun test packages/link", exit: 1 }, { text: "bun test packages/link", exit: 0 }]);
    expect(groups[8]!.items).toEqual([{ text: "The banner is not wired.", exit: null }]);
    // The trail's numbers each spans, so a group can be found again.
    expect(groups.map((g) => [g.from, g.to])).toEqual([[1, 1], [3, 6], [7, 10], [11, 14], [15, 15], [16, 16], [17, 17], [19, 19], [20, 20]]);
  });

  test("many files are counted, with the folder they share; one command is named", () => {
    const reads = ["a.ts", "b.ts", "c.ts", "d.ts"].map((f) => `Running · sed -n '1,50p' '/work/tasks/task-abcdefghijkl/packages/link/${f}'`);
    expect(stepGroups(trail(...reads)).map((g) => g.text)).toEqual(["Read 4 files in packages/link"]);
    expect(stepGroups(trail("Running · git status --short", "Exit 0 · M sync.ts")).map((g) => g.text)).toEqual(["Ran git status --short"]);
    expect(stepGroups(trail("Running · bun test", "Exit 1 · fail")).map((g) => g.text)).toEqual(["Ran bun test · failed"]);
  });

  test("a call is read as the knight's own tools say it: a read, an edit or a write; anything else is a command", () => {
    expect(commandKind("sed -n '1,200p' 'src/it'\\''s.ts'")).toEqual({ kind: "read", path: "src/it's.ts" });
    expect(commandKind(EDIT)).toEqual({ kind: "edit", path: "packages/link/sync.ts" });
    expect(commandKind("edit 'a.ts' --all <<'X'\n-a\n+b\nX")).toEqual({ kind: "edit", path: "a.ts" });
    expect(commandKind(WRITE)).toEqual({ kind: "edit", path: "packages/link/resume.ts" });
    // A command that only looks like one is a command.
    for (const command of ["sed -n '1,2p' a.ts | head", "cat > out.txt", "cat README.md", "edit the file", "sed -i s/a/b/ x"]) expect([command, commandKind(command).kind]).toEqual([command, "run"]);
  });

  test("what the work came to in figures: its time (the runner's record where there is one), commands, failures, files", () => {
    const entries = trail("Running · sed -n '1,9p' 'a.ts'", "Exit 0 · ok", `Running · ${EDIT}`, "Exit 0 · ok", `Running · ${EDIT}`, "Exit 0 · ok", "Running · bun test", "Exit 1 · fail", "Running · bun test", "Exit 0 · ok");
    expect(workSummary(entries)).toEqual({ ms: 90_000, commands: 2, failed: 1, read: 1, edited: 1 });
    expect(workSummary(entries, { startedAt: T0, endedAt: T0 + 372_000 }).ms).toBe(372_000);
    expect(summaryWords(workSummary(entries))).toBe("ran 2 commands · edited 1 file");
    expect(summaryWords(workSummary(trail("Running · sed -n '1,9p' 'a.ts'")))).toBe("read 1 file");
    expect(summaryWords(workSummary([]))).toBe("");
    expect([workedFor(42_400), workedFor(372_000), workedFor(3_840_000)]).toEqual(["42s", "6m 12s", "1h 04m"]);
  });
});

describe("what proves it, apart from what the knight says", () => {
  const GATES = ["bun test packages/link", "bun run typecheck"];

  test("each gate as its latest round left it, with how long it took and what it said", () => {
    const entries = trail(
      "Gates · 1. bun test packages/link\n2. bun run typecheck\n3. bun run lint",
      "Submitted for review · first try",
      "Gate 1/3 · exit 1 · bun test packages/link\nexit 1\n2 fail",
      "Running · bun test packages/link",
      "Submitted for review · second try",
      "Gate 1/3 · exit 0 · bun test packages/link\nexit 0\n14 pass",
      "Gate 2/3 · exit 0 · bun run typecheck\n(no output)",
    );
    // At work: the round's first gate without a result is running, the rest wait. The planner's own gate is listed too.
    expect(gateRows(GATES, entries, true)).toEqual([
      { command: "bun test packages/link", state: "passed", exit: 0, ms: 10_000, said: "14 pass", before: null },
      { command: "bun run typecheck", state: "passed", exit: 0, ms: 10_000, said: "", before: null },
      { command: "bun run lint", state: "running", exit: null, ms: null, said: "", before: null },
    ]);
    // Ended there: the last waits, not runs.
    expect(gateRows(GATES, entries, false)[2]!.state).toBe("waiting");
    // Before any submission, every gate waits.
    expect(gateRows(GATES, trail("Plan · go"), true).map((g) => g.state)).toEqual(["waiting", "waiting"]);
  });

  test("a gate that passed before any work shows nothing about it, and says so", () => {
    const entries = trail(
      "Gates before the work · 1. exit 0 · bun test packages/link · passes already, so it shows nothing about this work\n2. exit 2 · bun run typecheck",
      "Submitted for review · done",
      "Gate 1/2 · exit 0 · bun test packages/link\nok",
      "Gate 2/2 · exit 0 · bun run typecheck\nok",
    );
    expect(gateRows(GATES, entries, false).map((g) => [g.state, g.before])).toEqual([["passed", 0], ["passed", 2]]);
  });

  test("the reviewer's latest verdict, and whether it was the model that did the work", () => {
    const entries = trail("Review · revise\nNot wired.", "Review · by the same model that did the work (a/b): no other reviewer model could answer", "Review · pass\nMatches the brief; nothing else moved.\nMore notes.");
    expect(reviewOf(entries)).toEqual({ verdict: "pass", notes: "Matches the brief; nothing else moved.\nMore notes.", at: T0 + 20_000 });
    expect(sameModelReview(entries)).toBe(true);
    expect(sameModelReview(entries.slice(0, 1))).toBe(false);
    expect(reviewOf(trail("Review · by the same model that did the work (a/b)"))).toBeNull();
    expect(reviewOf([])).toBeNull();
  });

  test("the live line: the command it runs and since when, or the step it is at", () => {
    expect(liveStep(trail("Plan · go", "Running · bun test packages/link\nmore"))).toEqual({ text: "bun test packages/link", command: true, since: T0 + 10_000 });
    expect(liveStep(trail("Submitted for review · x"))?.text).toBe("Running its gates");
    expect(liveStep(trail("Gate 1/2 · exit 0 · a"))?.text).toBe("Running gate 2 of 2");
    expect(liveStep(trail("Gate 2/2 · exit 0 · a"))?.text).toBe("The reviewer is reading it");
    expect(liveStep(trail("Running · a", "Exit 0 · ok"))?.text).toBe("Reading what it printed");
    expect(liveStep([])).toBeNull();
  });
});

describe("a task's proof and its cost, in one place", () => {
  const GATES = ["bun test", "bun run typecheck"];
  test("verified: every gate passed this round and the reviewer passed it; what can make a pass say less is said", () => {
    const entries = trail("Submitted for review · done", "Gate 1/2 · exit 0 · bun test\nok", "Gate 2/2 · exit 0 · bun run typecheck\nok", "Review · pass\nMatches the brief.");
    const proof = proofOf({ gates: GATES, status: "done" }, entries);
    expect([proof.passed, proof.reviewer, proof.sameModel, proof.provesNothing, proof.review?.notes]).toEqual([2, "passed", false, false, "Matches the brief."]);
    const before = trail("Gates before the work · 1. exit 0 · bun test · passes already\n2. exit 0 · bun run typecheck · passes already", ...entries.map((e) => e.text), "Review · by the same model that did the work (a/b): no other reviewer model could answer");
    const said = proofOf({ gates: GATES, status: "done" }, before);
    expect([said.provesNothing, said.sameModel]).toEqual([true, true]);
  });

  test("at work: the reviewer waits for the gates, then reads; ended before it: none", () => {
    expect(proofOf({ gates: GATES, status: "running" }, trail("Submitted for review · x", "Gate 1/2 · exit 0 · bun test")).reviewer).toBe("waits");
    expect(proofOf({ gates: GATES, status: "running" }, trail("Submitted for review · x", "Gate 1/2 · exit 0 · bun test", "Gate 2/2 · exit 0 · bun run typecheck")).reviewer).toBe("reading");
    expect(proofOf({ gates: GATES, status: "failed" }, trail("Plan · x")).reviewer).toBe("none");
    expect(proofOf({ gates: GATES, status: "failed" }, trail("Review · revise\nNo.")).reviewer).toBe("sent back");
    // No gates at all: nothing proves anything but the reviewer, and a gateless task doesn't claim its gates passed.
    expect([proofOf({ gates: [], status: "done" }, trail("Review · pass\nok")).gates, proofOf({ gates: [], status: "done" }, []).provesNothing]).toEqual([[], false]);
  });

  test("its cost: money at your prices against its budget, and how long it ran; at work, its budget alone", () => {
    const line = (model: string, calls: number, unknown: number, input: number, output: number) => ({ role: "engineer", model, calls, unknown, input, output, cached: 0, reasoning: 0 });
    const record = { startedAt: T0, endedAt: T0 + 372_000, ended: "done" as const, commands: 14, revisions: 0, spent: [line("a/m", 3, 0, 1_000_000, 100_000)] };
    const prices = { "a/m": { input: 0.25, output: 0.6 } };
    expect(costWords({ record, budgetUsd: 2 }, prices)).toBe("$0.31 of $2.00 · 6m 12s");
    expect(costWords({ record }, prices)).toBe("$0.31 · 6m 12s");
    expect(costWords({ record }, {})).toBe("no price · 6m 12s");
    expect(costWords({ record: { ...record, spent: [line("a/m", 2, 1, 1_000_000, 100_000)] } }, prices)).toBe("at least $0.31 · 6m 12s");
    expect(costWords({ record: { ...record, spent: [] }, budgetUsd: 2 }, prices)).toBe("budget $2.00 · 6m 12s");
    // Nothing counted: said so, never a bare time.
    expect(costWords({ record: { ...record, spent: [] } }, prices)).toBe("no model calls · 6m 12s");
    expect(costWords({ record: { ...record, spent: [line("a/m", 2, 2, 0, 0)] } }, prices)).toBe("spend unknown · 6m 12s");
    expect(costWords({ budgetUsd: 0.5 }, prices)).toBe("budget $0.50");
    expect(costWords({}, prices)).toBe("");
  });
});
