import { describe, expect, test } from "bun:test";
import { activeScreenSession, SCREEN_ANSWER_MINUTES, type ScreenSessionFacts, screenSessionState } from "../src/index.ts";

/*
 * Where a session on a Mac's own screen stands (screen.ts), the same on every node and in every app: his only once you
 * allow it, for its minutes counted from your answer, until you or he ends it; an ask you don't answer lapses.
 */

const T = 1_800_000_000_000;
const MIN = 60_000;
const asked = (over: Partial<ScreenSessionFacts> = {}): ScreenSessionFacts => ({ id: "sc_1", node: "n_mini", why: "build the app", minutes: 30, askedAt: T, decision: null, endedAt: null, ...over });

describe("a screen session", () => {
  test("waits for your answer, and lapses unanswered: no answer is no", () => {
    expect(screenSessionState(asked(), T + MIN).state).toBe("waiting");
    expect(screenSessionState(asked(), T + SCREEN_ANSWER_MINUTES * MIN).state).toBe("lapsed");
    expect(screenSessionState(asked(), T).answerBy).toBe(T + SCREEN_ANSWER_MINUTES * MIN);
  });

  test("allowed, it is his for its minutes from your answer (not from his ask), then over", () => {
    const allowed = asked({ decision: { verdict: "allowed", at: T + 10 * MIN, via: "c_phone" } });
    expect(screenSessionState(allowed, T + 39 * MIN)).toEqual({ state: "allowed", answerBy: T + 15 * MIN, until: T + 40 * MIN });
    expect(screenSessionState(allowed, T + 40 * MIN).state).toBe("over");
  });

  test("denied stays denied; ended is ended, whenever, and its time stops there", () => {
    expect(screenSessionState(asked({ decision: { verdict: "denied", at: T + MIN, via: null } }), T + 2 * MIN).state).toBe("denied");
    const ended = asked({ decision: { verdict: "allowed", at: T + MIN, via: null }, endedAt: T + 5 * MIN });
    expect(screenSessionState(ended, T + 6 * MIN)).toEqual({ state: "ended", answerBy: T + 15 * MIN, until: T + 5 * MIN });
    expect(screenSessionState(asked({ endedAt: T + MIN }), T + 2 * MIN).state).toBe("ended");
  });

  test("the session that lets him use a Mac now: allowed, on that Mac, and the newest answer if two overlap", () => {
    const older = asked({ id: "sc_old", decision: { verdict: "allowed", at: T, via: null } });
    const newer = asked({ id: "sc_new", decision: { verdict: "allowed", at: T + 5 * MIN, via: null } });
    const elsewhere = asked({ id: "sc_ultra", node: "n_ultra", decision: { verdict: "allowed", at: T + 6 * MIN, via: null } });
    expect(activeScreenSession([older, newer, elsewhere], "n_mini", T + 10 * MIN)?.id).toBe("sc_new");
    // The older one is over at 30 minutes, the newer at 35: in between, the newer still holds; after, neither.
    expect(activeScreenSession([older, newer], "n_mini", T + 32 * MIN)?.id).toBe("sc_new");
    expect(activeScreenSession([older, newer], "n_mini", T + 36 * MIN)).toBeNull();
    expect(activeScreenSession([older, asked({ id: "sc_waiting" })], "n_mini", T + 31 * MIN)).toBeNull();
    expect(activeScreenSession([elsewhere], "n_mini", T + 7 * MIN)).toBeNull();
  });
});
