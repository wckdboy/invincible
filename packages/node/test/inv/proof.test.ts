import { describe, expect, test } from "bun:test";
import type { RunEvent } from "@invincible/agents";
import type { TeamTask } from "@invincible/core";
import { EXIT } from "../../src/inv/exit.ts";
import { proofFor, reasonOf, STATE_EXIT } from "../../src/inv/proof.ts";
import { GATE, gated, judged, reviewed, T0, task, trail, worked } from "./fixtures.ts";

/*
 * The proof and its verdict (docs/CLI.md, "The proof" and "Exit codes"): what proves a task is what the runner wrote on
 * its trail, and 0 means more than the node's "verified": a gate that failed before the work and passes now, and a
 * reviewer that didn't do the work.
 */

const PRICES = { "stand-in/engineer": { input: 1, output: 2 } };
const record = (ended: "done" | "unverified" | "gave-up" | "stopped") => ({ startedAt: T0, endedAt: T0 + 372_000, ended, commands: 2, revisions: 0, spent: [{ role: "engineer", model: "stand-in/engineer", calls: 3, unknown: 0, input: 100_000, output: 10_000, cached: 0, reasoning: 0 }] });
const proof = (over: Partial<TeamTask>, events: RunEvent[], asking = false) =>
  proofFor(task(over), trail(events), { word: "Verified", node: "ultra", project: "invincible", prices: PRICES, asking });

describe("the verdict, as an exit code", () => {
  test("verified (0): its gate failed before the work and passes now, and a reviewer that didn't do the work passed it", () => {
    const shown = proof({ status: "done", verified: true, record: record("done"), output: "Fixed the race in retry(); all tests pass.\n\nReview: Looks right." }, [...worked([1]), ...gated([0]), ...reviewed("pass")]);
    expect([shown.state, shown.exit]).toEqual(["verified", EXIT.ok]);
    expect(reasonOf(shown)).toBe("by its gates and a reviewer that didn't do the work");
  });

  test("finished without proof (12): no gate, only gates that passed before the work, or reviewed by the model that did it", () => {
    const none = proof({ status: "done", verified: true, gates: [] }, [...worked([], []), ...reviewed("pass")]);
    expect([none.state, none.exit, reasonOf(none)]).toEqual(["unproven", EXIT.unproven, "no gate shows the work: the reviewer decided alone"]);
    const already = proof({ status: "done", verified: true }, [...worked([0]), ...gated([0]), ...reviewed("pass")]);
    expect([already.state, already.exit, reasonOf(already)]).toEqual(["unproven", EXIT.unproven, "every gate passed before the work, so none shows it"]);
    const sameModel: RunEvent[] = [...worked([1]), ...gated([0]), ...reviewed("pass")];
    const entries = trail(sameModel);
    // (The runner says so on a line of its own before the verdict: team-runtime's "Review · by the same model".)
    entries.splice(entries.length - 1, 0, { n: 99, at: entries.at(-1)!.at, text: "Review · by the same model that did the work (stand-in/engineer): no other reviewer model could answer" });
    const same = proofFor(task({ status: "done", verified: true }), entries, { word: "Verified", node: null, project: null, prices: {}, asking: false });
    expect([same.state, same.exit, same.review?.sameModel, reasonOf(same)]).toEqual(["unproven", EXIT.unproven, true, "reviewed only by the model that did the work"]);
  });

  test("a gate failed (10), the reviewer rejected it (11), stopped (13), or it ended another way (1)", () => {
    const gate = proof({ status: "failed", error: "unverified", record: record("unverified") }, [...worked([1]), ...gated([2])]);
    expect([gate.state, gate.exit, reasonOf(gate)]).toEqual(["failed", EXIT.gateFailed, "gate 1 of 1 didn't pass"]);
    const rejected = proof({ status: "failed", error: "unverified", record: record("unverified") }, [...worked([1]), ...gated([0]), ...reviewed("revise", "It skips the retry.")]);
    expect([rejected.state, rejected.exit]).toEqual(["rejected", EXIT.rejected]);
    const yours = proof({ status: "stopped", error: "Stopped at your request." }, worked([1]));
    expect([yours.state, yours.exit]).toEqual(["stopped", EXIT.stopped]);
    const budget = proof({ status: "failed", error: "stopped", record: record("stopped") }, [...worked([1]), { type: "budget", spentUsd: 2, budgetUsd: 2, out: true }]);
    expect([budget.state, budget.exit]).toEqual(["stopped", EXIT.stopped]);
    const gaveUp = proof({ status: "failed", error: "gave-up", record: record("gave-up") }, worked([1]).slice(0, 5));
    expect([gaveUp.state, gaveUp.exit]).toEqual(["error", EXIT.error]);
  });

  test("not ended: it waits on you (20), or it is at work or queued, with no verdict yet (21)", () => {
    for (const status of ["proposed", "interrupted"] as const) expect(proof({ status }, []).exit).toBe(EXIT.needsYou);
    expect(proof({ status: "running" }, worked([1]), true)).toMatchObject({ state: "needs-you", exit: EXIT.needsYou });
    expect(proof({ status: "running" }, worked([1]))).toMatchObject({ state: "working", exit: EXIT.stillRunning });
    expect(proof({ status: "queued" }, [])).toMatchObject({ state: "queued", exit: EXIT.stillRunning });
  });

  test("every state has its code, and the codes are the contract's", () => {
    expect(STATE_EXIT).toEqual({ verified: 0, failed: 10, rejected: 11, unproven: 12, stopped: 13, "needs-you": 20, working: 21, queued: 21, error: 1 });
  });
});

describe("the proof's JSON", () => {
  test("it holds what docs/CLI.md says, in its types: gates with their exits, times and how they ran before; the review; the cost against the budget", () => {
    const shown = proof({ status: "done", verified: true, budgetUsd: 2, record: record("done"), changes: { artifact: "art_3hVZ0iW2kq6mJx0sY1aB4c", files: 2, base: "0".repeat(40) }, output: "Fixed the race in retry(); all tests pass.\n\nReview: Looks right." }, [...worked([1]), ...gated([0]), ...reviewed("pass")]);
    expect(Object.keys(shown).sort()).toEqual(["agent", "budgetUsd", "changes", "costAtMost", "costComplete", "costUsd", "exit", "gates", "ms", "node", "project", "review", "said", "state", "steers", "task", "title", "v", "word"].sort());
    expect(shown).toMatchObject({
      v: 1,
      task: "task-a1b2c3d4e5f6",
      title: "Fix the flaky link sync test",
      agent: "ada",
      node: "ultra",
      project: "invincible",
      review: { verdict: "pass", sameModel: false, notes: 2 },
      changes: { files: 2, artifact: "art_3hVZ0iW2kq6mJx0sY1aB4c" },
      costComplete: true,
      costAtMost: false,
      budgetUsd: 2,
      ms: 372_000,
      said: "Fixed the race in retry(); all tests pass.",
    });
    // $1 a million in, $2 a million out: 100,000 in and 10,000 out.
    expect(shown.costUsd).toBeCloseTo(0.12, 6);
    expect(shown.gates).toEqual([{ cmd: GATE, exit: 0, ms: 1000, before: 1, failedBefore: true, said: "38 pass" }]);
    expect(JSON.parse(JSON.stringify(shown))).toEqual(shown);
  });

  test("a handed task's call counted at its most (its provider silent in time) makes its cost an upper bound, and the proof says so", () => {
    const counted = { ...record("done"), spent: [{ ...record("done").spent[0]!, atMost: 2 }] };
    const shown = proof({ status: "done", verified: true, record: counted }, []);
    expect([shown.costComplete, shown.costAtMost]).toEqual([true, true]);
    expect(proof({ status: "done", verified: true, record: record("done") }, []).costAtMost).toBe(false);
  });

  test("what isn't known is null, never guessed: a task not run has no cost, no time and no review", () => {
    const shown = proof({ status: "queued" }, []);
    expect(shown).toMatchObject({ review: null, changes: null, costUsd: null, costComplete: false, ms: null, said: "" });
    expect(shown.gates).toEqual([{ cmd: GATE, exit: null, ms: null, before: null, failedBefore: false, said: "" }]);
  });
});

describe("a steered task's proof (fields added: none changes its meaning)", () => {
  test("the old form: a task nothing was said to has no steers, and its review judged the work against none", () => {
    const shown = proof({ status: "done", verified: true }, [...worked([1]), ...gated([0]), ...reviewed("pass")]);
    expect(shown.steers).toEqual([]);
    expect(shown.review).toEqual({ verdict: "pass", sameModel: false, notes: 2, steers: 0 });
  });

  test("the new form: each steer, whose and the step its run took it at (null: it never did), and how many the review judged with", () => {
    const steered: RunEvent[] = [...worked([1]), { type: "steered", step: 2, by: "owner", text: "Use the new schema." }, ...gated([0]), ...reviewed("pass")];
    const shown = proofFor(task({ status: "done", verified: true, steers: [{ by: "owner", text: "Use the new schema.", at: T0, taken: { at: T0, step: 2 } }, { by: "primary", text: "Keep the old reader.", at: T0 }] }), judged(trail(steered), 1), { word: "Verified", node: "ultra", project: "invincible", prices: PRICES, asking: false });
    expect(shown.steers).toEqual([{ by: "owner", text: "Use the new schema.", step: 2 }, { by: "primary", text: "Keep the old reader.", step: null }]);
    expect(shown.review).toMatchObject({ verdict: "pass", steers: 1 });
    // What it proves is what it proved: the verdict follows the gates and the review, steered or not.
    expect([shown.state, shown.exit]).toEqual(["verified", EXIT.ok]);
  });
});
