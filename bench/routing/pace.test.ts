import { describe, expect, test } from "bun:test";
import { runPace } from "./pace.ts";

/* The routing suite's plan pace (pace.ts): the real Pacer against a stand-in OpenCode Go that refuses past 25 a minute. */

describe("a plan's pace, in virtual time", () => {
  test("eight agents on one plan: none of their asks refused with the pace, and more of them answered than when each refusal is waited out", () => {
    const off = runPace({ seed: 7, agents: 8 });
    const on = runPace({ seed: 7, agents: 8, pace: 24 });
    expect(off.refused).toBeGreaterThan(0);
    expect(on.refused).toBe(0);
    expect(on.served).toBeGreaterThan(off.served);
    // Under the plan's limit, it changes nothing.
    expect(runPace({ seed: 7, agents: 2, pace: 24 })).toEqual(runPace({ seed: 7, agents: 2 }));
  });

  test("the same seed, the same minutes", () => {
    expect(runPace({ seed: 7, agents: 8, pace: 24 })).toEqual(runPace({ seed: 7, agents: 8, pace: 24 }));
  });
});
