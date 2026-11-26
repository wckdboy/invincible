import { describe, expect, test } from "bun:test";
import { taskRecordFacts, TeamTaskRecord } from "../src/index.ts";

/* What a knight's task came to, in words: the same at a terminal and in the app, from the record the runner kept. */

const spent = [
  { role: "engineer", model: "plan/m", calls: 9, unknown: 0, input: 90_000, output: 4000, cached: 70_000, reasoning: 1500 },
  { role: "reviewer", model: "plan/r", calls: 1, unknown: 0, input: 6000, output: 500, cached: 0, reasoning: 0 },
];
const prices = { "plan/m": { input: 1, output: 4, cached: 0.2 }, "plan/r": { input: 0.5, output: 2 } };

describe("a task's record, in words", () => {
  test("its time, its commands and how often it was sent back, its tokens, and money where every model that answered has a price", () => {
    const record = TeamTaskRecord.parse({ startedAt: 0, endedAt: 724_000, ended: "done", commands: 8, revisions: 1, spent });
    expect(taskRecordFacts(record, prices)).toEqual(["12m04s", "8 commands, sent back once", "101k tokens", "$0.05"]);
    // A price missing for one model: its money isn't guessed.
    expect(taskRecordFacts(record, { "plan/m": prices["plan/m"] }).at(-1)).toBe("no price");
  });

  test("an ending that isn't done comes first; a provider that reported nothing is said as that; no model call, no money", () => {
    expect(taskRecordFacts({ startedAt: 1000, endedAt: 60_000, ended: "unverified", commands: 1, revisions: 2, spent: [{ ...spent[1]!, unknown: 1, input: 0, output: 0 }] }, prices)).toEqual(["ended unverified", "59s", "1 command, sent back 2 times", "tokens unknown"]);
    // One call of ten unreported: what was counted is a lower bound, and says so.
    const partly = [{ ...spent[0]!, unknown: 1 }];
    expect(taskRecordFacts({ startedAt: 0, endedAt: 1000, ended: "done", commands: 1, revisions: 0, spent: partly }, prices).slice(-2)).toEqual(["94.0k+ tokens", "at least $0.05"]);
    expect(taskRecordFacts({ startedAt: 0, endedAt: 0, ended: "stopped", commands: 0, revisions: 0, spent: [] }, prices)).toEqual(["ended stopped", "0s", "0 commands", "no model calls"]);
  });

  test("a record is counts and times and nothing else: a field too many is refused", () => {
    expect(TeamTaskRecord.safeParse({ startedAt: 0, endedAt: 1, ended: "done", commands: 0, revisions: 0, spent: [], prompt: "words" }).success).toBe(false);
    expect(TeamTaskRecord.safeParse({ startedAt: 0, endedAt: 1, ended: "finished", commands: 0, revisions: 0, spent: [] }).success).toBe(false);
  });
});
