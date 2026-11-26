import { describe, expect, test } from "bun:test";
import { interventionWords, northStar } from "../src/interventions.ts";

describe("the north star (#28)", () => {
  const task = (status: string, interventions: Record<string, number> | undefined, opts: { verified?: boolean; updatedAt?: number } = {}) =>
    ({ status, verified: opts.verified ?? status === "done", updatedAt: opts.updatedAt ?? 100, ...(interventions ? { interventions } : {}) });

  test("counts every intervention on the tasks that ended since, per one done and verified", () => {
    const star = northStar([
      task("done", { approval: 1 }),
      task("done", undefined),
      task("done", { message: 2 }, { verified: false }),
      task("failed", { stop: 1, again: 1 }),
      task("stopped", { stop: 1 }),
      task("running", { message: 5 }),
      task("queued", { again: 1 }),
      task("done", { message: 9 }, { updatedAt: 10 }),
    ], 50);
    expect(star).toEqual({ since: 50, completed: 2, ended: 5, interventions: 6, perCompleted: 3, byKind: { approval: 1, message: 2, stop: 2, again: 1 } });
  });

  test("with nothing completed there is no ratio, only the count", () => {
    expect(northStar([task("failed", { stop: 1 })], 0)).toMatchObject({ completed: 0, interventions: 1, perCompleted: null });
    expect(northStar([], 0)).toEqual({ since: 0, completed: 0, ended: 0, interventions: 0, perCompleted: null, byKind: {} });
  });

  test("says how you stepped in, in words", () => {
    expect(interventionWords(undefined)).toBe("");
    expect(interventionWords({})).toBe("");
    expect(interventionWords({ message: 0 })).toBe("");
    expect(interventionWords({ approval: 1 })).toBe("an approval");
    expect(interventionWords({ message: 2, approval: 1 })).toBe("an approval and two messages");
    expect(interventionWords({ again: 1, stop: 3, takeover: 1, resume: 1 })).toBe("its desktop taken over, three stops, a resume and given again");
    expect(interventionWords({ again: 2, message: 12 })).toBe("12 messages and given again two times");
  });

  test("a task rewritten is its own kind: said in words, and counted once beside given again", () => {
    expect(interventionWords({ rewritten: 1 })).toBe("rewritten");
    expect(interventionWords({ again: 1, rewritten: 1 })).toBe("given again and rewritten");
    const star = northStar([
      task("done", { again: 1, rewritten: 1 }),
      task("failed", { rewritten: 2 }),
    ], 0);
    expect(star).toMatchObject({ completed: 1, interventions: 4, byKind: { again: 1, rewritten: 3 } });
  });
});
