import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { TrialRecord, trialProblem } from "@galahad/core";
import type { TrialJob } from "../src/trial-cli.ts";
import { attemptCase, gateTail, TAIL_CHARS } from "../src/trial-yours.ts";
import { GATES, widgets, widgetsCase, WIDGETS, YoursStandIn } from "./yours-standin.ts";

/*
 * A graded gate's failure keeps the end of what it printed (its tail: where a test runner says what failed), in the
 * note's words, both where a gate fails with the task's own change and where a counted gate fails what the engineer
 * left. A gate that passes keeps nothing, and a long tail is cut before anything else so the note stays within the
 * record's 1,000 characters.
 */

describe("a failing gate's printed tail in the note", () => {
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
  const job = (over: Partial<TrialJob> = {}): TrialJob => ({ seed: 7, run: "r-tails", suite: "yours", version: "abc1234", network: "online", ...over });
  const valid = (record: TrialRecord) => {
    expect(TrialRecord.parse(record)).toEqual(record);
    expect(trialProblem(record)).toBeNull();
  };

  test("gateTail keeps the end of what a failing gate printed, a few hundred characters at most, and nothing for a pass", () => {
    const printed = `${"x".repeat(2000)}FAILED: total_test.sh\n`;
    expect(gateTail({ exitCode: 1, stderr: printed, stdout: "" })).toBe(`${"x".repeat(TAIL_CHARS - "FAILED: total_test.sh".length)}FAILED: total_test.sh`);
    expect(gateTail({ exitCode: 0, stderr: "whatever it printed", stdout: "" })).toBe("");
    // A runner that reports on stdout (pytest, go test, cargo) is read there when stderr has nothing.
    expect(gateTail({ exitCode: 1, stderr: "  \n", stdout: "FAILED test_total.py::test_sum - assert 7 == 6\n" })).toBe("FAILED test_total.py::test_sum - assert 7 == 6");
  });

  test("a gate that fails with the task's own change says the end of what it printed", async () => {
    const node = standIn();
    // Always fails, and says why to stderr (where a test runner says what failed): nothing to act on would be exit 1 alone.
    const gate = `printf 'widgetfmt: not found\\n' >&2; exit 1`;
    const record = (await attemptCase(node, widgetsCase(repo.base, { gates: [gate] }), job()))!;
    valid(record);
    expect(record).toMatchObject({ status: "crashed", score: 0, answers: [] });
    expect(record.note).toBe("not graded: no gate proves anything here (gate 1 fails with the task's own change too (exit 1): widgetfmt: not found)");
    expect(node.chats).toEqual([]);
  });

  test("a counted gate the engineer's work fails says it too", async () => {
    const node = standIn("echo 'looked, changed nothing' > NOTES.md");
    // As the task's gate, but with its failure sent to stderr, the way a test runner reports it.
    const gate = `sh test/total_test.sh 1>&2`;
    const record = (await attemptCase(node, widgetsCase(repo.base, { gates: [gate] }), job()))!;
    valid(record);
    expect(record).toMatchObject({ status: "scored", score: 0, answers: [{ key: "gate_1", got: 0, ok: false }] });
    expect(record.note).toBe("counted: gate 1 of 1; gate 1 failed (exit 1): expected 6, got 7");
  });

  test("a failing gate whose reason is only on stdout says it from there (as pytest, go test and cargo report)", async () => {
    const node = standIn("echo 'looked, changed nothing' > NOTES.md");
    // The frozen suite's own gate: it prints 'expected 6, got 7' to stdout and nothing to stderr.
    const record = (await attemptCase(node, widgetsCase(repo.base, { gates: [GATES.test] }), job()))!;
    valid(record);
    expect(record).toMatchObject({ status: "scored", score: 0 });
    expect(record.note).toBe("counted: gate 1 of 1; gate 1 failed (exit 1): expected 6, got 7");
  });

  test("a long tail is cut so the note keeps its limit, its words kept whole", async () => {
    const node = standIn("echo 'looked, changed nothing' > NOTES.md");
    // Four counted gates, each printing far more than a note can hold when it fails (its marker at the very end).
    const longGate = (marker: string) => `if sh test/total_test.sh; then exit 0; else printf '%02000d\\n' 0 >&2; printf '%s\\n' '${marker}' >&2; exit 1; fi`;
    const gates = ["GATE1", "GATE2", "GATE3", "GATE4"].map(longGate);
    const record = (await attemptCase(node, widgetsCase(repo.base, { gates }), job()))!;
    valid(record);
    const note = record.note!;
    expect(record).toMatchObject({ status: "scored", score: 0 });
    expect(note.length).toBeLessThanOrEqual(1000);
    expect(note.startsWith("counted: gate 1, gate 2, gate 3, gate 4 of 4;")).toBe(true);
    expect(note).toContain("gate 1 failed (exit 1):");
    expect(note).toContain("gate 4 failed (exit 1):");
    // The end of each gate's tail is what's kept, so the last gate's marker is still there.
    expect(note.endsWith("GATE4")).toBe(true);
  });
});
