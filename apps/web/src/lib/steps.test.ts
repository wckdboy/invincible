import { describe, expect, test } from "bun:test";
import type { TeamTrailEntry } from "@invincible/core/team";
import { because, commandKind, costWords, factsOfProof, factsOfRecord, gateRows, judgedWith, liveStep, proofOf, proofSeal, readTrailLine, saidBesideProof, workedLine, reviewOf, sameModelReview, stepGroups, steersOf, summaryWords, verdictOf, workedFor, workSummary } from "./steps.ts";

/* A task's trail as the node writes it (team-runtime.ts progress()), its lines in the order they happened. */
const T0 = 1_764_000_000_000;
const trail = (...texts: string[]): TeamTrailEntry[] => texts.map((text, i) => ({ n: i + 1, at: T0 + i * 10_000, text }));
const EDIT = "edit 'packages/link/sync.ts' <<'END'\n-  retry()\n+  resume()\nEND";
const WRITE = "cat > 'packages/link/resume.ts' <<'END'\nexport const resume = 1;\nEND";

describe("a task's work, folded", () => {
  test("its folded line says how long its agent worked, and never \"0s\": under half a second, only that it worked", () => {
    expect(workedLine("Ada", 372_000)).toBe("Ada worked for 6m 12s");
    expect(workedLine("Ada", 900)).toBe("Ada worked for 1s");
    expect([workedLine("Ada", 0), workedLine("Ada", 499)]).toEqual(["Ada worked", "Ada worked"]);
  });

  test("an ended task's work says nothing of its end: no bare 'finished' step (its verdict says how it ended)", () => {
    // (Trails written before 26 November 2026 end with the runner's bare "finished": every ended task's thread showed it.)
    expect(stepGroups(trail("Running · bun test", "Exit 0 · 4 pass", "finished")).map((g) => g.text)).toEqual(["Ran bun test"]);
  });


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

  test("a call is read as the agent's own tools say it: a read, an edit or a write; anything else is a command", () => {
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

describe("what proves it, apart from what the agent says", () => {
  const GATES = ["bun test packages/link", "bun run typecheck"];

  test("each gate as its latest round left it, with how long it took and what it said", () => {
    const entries = trail(
      "Gates · 1. bun test packages/link\n2. bun run typecheck\n3. bun run lint",
      "Submitted for review · first try",
      "Gate 1/3 · exit 1 · bun test packages/link\nexit 1\n2 fail",
      "Running · bun test packages/link",
      "Submitted for review · second try",
      "Gate 1/3 · exit 0 · bun test packages/link\nexit 0\n14 pass",
      "Gate 2/3 · exit 0 · bun run typecheck\nexit 0 · 412 ms\n(no output)",
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

describe("the verdict, in words that follow the proof", () => {
  const record = (proof?: { before: number[]; after: number[]; review: "pass" | "revise" | null; sameModel: boolean }, ended: "done" | "unverified" | "gave-up" | "stopped" = "done") => ({ startedAt: 0, endedAt: 1, ended, commands: 1, revisions: 0, spent: [], ...(proof ? { proof } : {}) });
  const done = (proof?: Parameters<typeof record>[0]) => ({ status: "done" as const, verified: true, error: null, record: record(proof) });

  test("proven: a gate that failed before the work passes after it, and another model's reviewer passed it", () => {
    const task = done({ before: [1, 0], after: [0, 0], review: "pass", sameModel: false });
    expect(verdictOf(task, factsOfRecord(task.record))).toEqual({ word: "Proven", verdict: "proven" });
  });

  test("never proven when every gate passed before the work, when there were none, or when the work's own model reviewed it", () => {
    for (const proof of [{ before: [0], after: [0], review: "pass", sameModel: false }, { before: [], after: [], review: "pass", sameModel: false }, { before: [1], after: [0], review: "pass", sameModel: true }] as const) {
      const task = done({ ...proof, before: [...proof.before], after: [...proof.after] });
      expect(verdictOf(task, factsOfRecord(task.record))).toEqual({ word: "Reviewed, not proven", verdict: "reviewed" });
    }
    // Nothing says what its gates showed (a record from before they were kept): reviewed, and no more.
    expect(verdictOf(done(), factsOfRecord(done().record))).toEqual({ word: "Reviewed", verdict: "reviewed" });
  });

  test("a thread's seal says the verdict and what it rests on: never \"Verified\" above a warning that its gates proved nothing", () => {
    const proven = done({ before: [1, 0], after: [0, 0], review: "pass", sameModel: false });
    expect(proofSeal(proven, factsOfRecord(proven.record), "")).toEqual({ word: "Proven", by: "a gate that failed before the work passes now, and a reviewer that didn't write it passed it", passed: true });
    const before = done({ before: [0], after: [0], review: "pass", sameModel: false });
    expect(proofSeal(before, factsOfRecord(before.record), "")).toEqual({ word: "Reviewed, not proven", by: "its reviewer passed it; what its gates can't show is said below", passed: true });
    const failed = { status: "failed" as const, verified: false, error: "unverified", record: record({ before: [1, 1], after: [0, 1], review: null, sameModel: false }, "unverified") };
    expect(proofSeal(failed, factsOfRecord(failed.record), "Its gate failed at the end")).toEqual({ word: "Failed · gate 2", by: "Its gate failed at the end", passed: false });
    const gave = { status: "failed" as const, verified: false, error: "gave-up", record: record({ before: [1], after: [], review: null, sameModel: false }, "gave-up") };
    expect(proofSeal(gave, factsOfRecord(gave.record), "")).toEqual({ word: "Gave up", by: "its gates or the review did not pass", passed: false });
    // Its why, never its verdict's word again (the iPhone's, I10): "Gave up · It gave up." said it twice.
    expect(proofSeal(gave, factsOfRecord(gave.record), "It gave up.")).toEqual({ word: "Gave up", by: "", passed: false });
    // In hand, there is no seal.
    expect(proofSeal({ status: "running", verified: false, error: null, record: undefined }, null, "")).toBeNull();
  });

  test("nothing said twice beside the proof (the iPhone's TaskCard, I10): an agent's bare claim, and its verdict's word again", () => {
    for (const bare of ["Verified.", "done", " Proven! ", "PASSED", "Completed.", "OK"]) expect([bare, saidBesideProof(bare)]).toEqual([bare, null]);
    expect(saidBesideProof("The importer reads ISO 8601 dates; four new tests cover both.")).toBe("The importer reads ISO 8601 dates; four new tests cover both.");
    expect([saidBesideProof(""), saidBesideProof("   "), saidBesideProof(null)]).toEqual([null, null, null]);
    expect(because("It gave up.", "Gave up")).toBeNull();
    expect(because("Not verified: its gates prove nothing", "Not verified")).toBe("Its gates prove nothing");
    expect(because("Not verified · the review sent it back", "Not verified")).toBe("The review sent it back");
    expect(because("The gate needs a Postgres this VM does not have", "Failed · gate 1")).toBe("The gate needs a Postgres this VM does not have");
    expect([because("", "Gave up"), because(null, "Gave up")]).toEqual([null, null]);
  });

  test("failed at a gate names the first that failed at the end; sent back, gave up, stopped say so", () => {
    const failed = { status: "failed" as const, verified: false, error: "unverified", record: record({ before: [1, 1], after: [0, 1], review: null, sameModel: false }, "unverified") };
    expect(verdictOf(failed, factsOfRecord(failed.record))).toEqual({ word: "Failed · gate 2", verdict: "failed" });
    const sent = { status: "failed" as const, verified: false, error: "unverified", record: record({ before: [1], after: [0], review: "revise", sameModel: false }, "unverified") };
    expect(verdictOf(sent, factsOfRecord(sent.record))).toEqual({ word: "Sent back", verdict: "rejected" });
    const gave = { status: "failed" as const, verified: false, error: "gave-up", record: record({ before: [1], after: [], review: null, sameModel: false }, "gave-up") };
    expect(verdictOf(gave, factsOfRecord(gave.record))).toEqual({ word: "Gave up", verdict: "gave-up" });
    expect(verdictOf({ status: "stopped", verified: false, error: "stopped", record: undefined }, null)).toEqual({ word: "Stopped", verdict: "stopped" });
    expect(verdictOf({ status: "running", verified: false, error: null, record: undefined }, null)).toBeNull();
  });

  test("the trail's proof and the record's give the same facts", () => {
    const entries: TeamTrailEntry[] = [
      { n: 1, at: 1, text: "Gates before the work · 1. exit 1 · bun test" },
      { n: 2, at: 2, text: "Submitted for review · now" },
      { n: 3, at: 3, text: "Gate 1/1 · exit 0 · bun test\n1 pass" },
      { n: 4, at: 4, text: "Review · pass\nFine." },
    ];
    const fromTrail = factsOfProof(proofOf({ gates: ["bun test"], status: "done" }, entries));
    expect(fromTrail.gates.map((g) => [g.exit, g.before])).toEqual([[0, 1]]);
    expect(verdictOf(done(), fromTrail)).toEqual({ word: "Proven", verdict: "proven" });
  });
});

describe("a steer, as its trail says it", () => {
  // As the runner writes them (team-runtime.ts progress() and its Judged line), each where the work took it.
  const STEERED = trail(
    "Running · bun test packages/link",
    "Exit 1 · 2 fail",
    "Steered · You: Use the new schema.",
    "Steered · Your agent: Keep the old reader.\nIt still has users.",
    "Running · bun test packages/link",
    "Exit 0 · 14 pass",
    "Submitted for review · on the new schema",
    "Gate 1/1 · exit 0 · bun test packages/link\n14 pass",
    "Judged · against its goal and 2 steers, in order",
    "Review · pass\nBoth taken up.",
  );

  test("read by its mark: whose words they were and what they said; any other speaker is a note, as before", () => {
    expect(readTrailLine("Steered · You: Use the new schema.")).toEqual({ kind: "steer", by: "owner", text: "Use the new schema." });
    expect(readTrailLine("Steered · Your agent: Keep the old reader.\nIt still has users.")).toEqual({ kind: "steer", by: "primary", text: "Keep the old reader.\nIt still has users." });
    expect(readTrailLine("Judged · against its goal and 2 steers, in order")).toEqual({ kind: "judged", steers: 2 });
    expect(readTrailLine("Judged · against its goal and 1 steer, in order")).toEqual({ kind: "judged", steers: 1 });
    expect(readTrailLine("Steered · Somebody: x")).toEqual({ kind: "note", text: "Steered · Somebody: x", tone: "neutral" });
  });

  test("each steer stands alone among the steps, where it was taken, in whose words; the judged line is the proof's, not a step", () => {
    const groups = stepGroups(STEERED);
    expect(groups.map((g) => [g.kind, g.text])).toEqual([
      ["run", "Ran bun test packages/link · failed"],
      ["steer", "You: Use the new schema."],
      ["steer", "Your agent: Keep the old reader."],
      ["run", "Ran bun test packages/link"],
      ["submitted", "Submitted it for its gates and review"],
      ["gate", "Gate 1 of 1 · passed"],
      ["review", "The reviewer passed it"],
    ]);
    // Its words whole, a click away.
    expect(groups[2]!.items).toEqual([{ text: "Keep the old reader.\nIt still has users.", exit: null }]);
    expect(groups[1]).toMatchObject({ from: 3, to: 3, tone: "neutral", by: "owner" });
    expect(groups[2]!.by).toBe("primary");
    // No other step says whose it is.
    expect(groups.filter((g) => g.kind !== "steer").every((g) => !("by" in g))).toBe(true);
  });

  test("the steers on a trail, in order, and how many the latest review judged the work against", () => {
    expect(steersOf(STEERED)).toEqual([
      { by: "owner", text: "Use the new schema.", n: 3, at: STEERED[2]!.at },
      { by: "primary", text: "Keep the old reader.\nIt still has users.", n: 4, at: STEERED[3]!.at },
    ]);
    expect(judgedWith(STEERED)).toBe(2);
    // A steer taken after the latest review is not one it judged with; no review, nothing judged.
    expect(judgedWith([...STEERED, { n: 11, at: T0, text: "Steered · You: And name it v2." }])).toBe(2);
    expect(judgedWith(STEERED.slice(0, 8))).toBeNull();
    expect(judgedWith(trail("Review · pass"))).toBe(0);
    expect(steersOf(trail("Running · ls", "Exit 0 · ok"))).toEqual([]);
  });

  test("what a review judged with is the runner's own count, said just before it: a run taken up again is told each steer anew", () => {
    // Cut off by a restart after it took the steer, then taken up again: its new run is told it again, and judged with it once.
    const again = trail(
      "Steered · You: Use the new schema.",
      "Running · ls",
      "Taken up again by itself after Invincible restarted.",
      "Steered · You: Use the new schema.",
      "Submitted for review · on the new schema",
      "Judged · against its goal and 1 steer, in order",
      "Review · pass",
    );
    expect(steersOf(again)).toHaveLength(2);
    expect(judgedWith(again)).toBe(1);
    // A review with no such line before it judged with none, whatever steers came before in an earlier run.
    expect(judgedWith(trail("Steered · You: x", "Taken up again by itself after Invincible restarted.", "Review · pass"))).toBe(0);
  });

  test("the live line, when a steer was the last thing on its trail: it is taking up whose words", () => {
    expect(liveStep(trail("Running · ls", "Exit 0 · ok", "Steered · You: Use the new schema."))).toMatchObject({ text: "Taking up your words", command: false });
    expect(liveStep(trail("Steered · Your agent: Keep the old reader."))).toMatchObject({ text: "Taking up your agent's words", command: false });
  });
});
