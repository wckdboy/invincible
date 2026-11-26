import { describe, expect, test } from "bun:test";
import {
  mayCarryOn,
  SEAT_KINDS,
  SEAT_LIMITS,
  SeatAddInput,
  type SeatFacts,
  SeatIdInput,
  SeatPolicyInput,
  seatRuns,
  SeatSignInAnswerInput,
  SeatSignInCancelInput,
  seatState,
  seatVendor,
  seatView,
  SHARED_RUNS_PROVEN,
  tokenShaped,
} from "../src/seats.ts";

/*
 * Seats (seats.ts): the inputs every route takes, where a seat stands over time, how many runs it takes at once (D4),
 * and the rule that work never moves to a second subscription seat of the same vendor (D1 and D2: "never switch").
 */

const ID = `st_${"a".repeat(22)}`;
const ATTEMPT = `sa_${"b".repeat(22)}`;
// Fake, every one, and said to be: shaped as each vendor's are, so the refusal is of the shape.
const FAKE_SETUP_TOKEN = "sk-ant-oat01-FAKE-not-a-token-0000000000000000";
const FAKE_API_KEY = "sk-ant-api03-FAKE-not-a-key-00000000000000000000";
const FAKE_SIGNED = "eyJGQUtFIjoibm90LWEtdG9rZW4ifQ.eyJGQUtFIjoibm90LWEtdG9rZW4ifQ.RkFLRS1ub3QtYS1zaWduYXR1cmU";
const FAKE_GITHUB = `ghp_${"F".repeat(36)}`;
/** One short enough for a seat's name, so it is its shape that is refused there, not its length. */
const FAKE_SIGNED_SHORT = "eyJGQUtFIn0.eyJGQUtFIn0.RkFLRS1zaWc";

const facts = (over: Partial<SeatFacts> = {}): SeatFacts => ({
  id: ID,
  kind: "claude-subscription",
  label: "Work Max",
  node: "n_node",
  provider: null,
  runs: 1,
  addedAt: 1_000,
  signIn: null,
  account: null,
  windows: [],
  rest: null,
  ...over,
});

describe("the inputs", () => {
  test("a seat of each kind: a subscription may start with its email, a plan or api seat names its provider", () => {
    for (const kind of SEAT_KINDS) {
      const keyed = kind === "plan" || kind === "api";
      expect(SeatAddInput.safeParse({ kind, label: "Work", ...(keyed ? { provider: "zai" } : { email: "owner@example.test" }) }).success).toBe(true);
    }
    expect(SeatAddInput.parse({ kind: "claude-subscription", label: "  Work Max  " })).toEqual({ kind: "claude-subscription", label: "Work Max" });
    expect(SeatAddInput.safeParse({ kind: "plan", label: "Z.ai" }).success).toBe(false);
    expect(SeatAddInput.safeParse({ kind: "claude-subscription", label: "x", provider: "anthropic" }).success).toBe(false);
    expect(SeatAddInput.safeParse({ kind: "api", label: "x", provider: "anthropic", email: "owner@example.test" }).success).toBe(false);
    expect(SeatAddInput.safeParse({ kind: "api", label: "x", provider: "search" }).success).toBe(false);
    expect(SeatAddInput.safeParse({ kind: "team-plan", label: "x" }).success).toBe(false);
  });

  test("its bounds: a name of one plain line, an email, runs from 1 to 3, ids of their own shapes", () => {
    expect(SeatAddInput.safeParse({ kind: "claude-subscription", label: "x".repeat(SEAT_LIMITS.label) }).success).toBe(true);
    expect(SeatAddInput.safeParse({ kind: "claude-subscription", label: "x".repeat(SEAT_LIMITS.label + 1) }).success).toBe(false);
    expect(SeatAddInput.safeParse({ kind: "claude-subscription", label: "   " }).success).toBe(false);
    expect(SeatAddInput.safeParse({ kind: "claude-subscription", label: "two\nlines" }).success).toBe(false);
    expect(SeatAddInput.safeParse({ kind: "claude-subscription", label: "x", email: "not an email" }).success).toBe(false);
    for (const runs of [0, 4, 1.5]) expect(SeatPolicyInput.safeParse({ id: ID, runs }).success).toBe(false);
    for (const runs of [1, 2, 3]) expect(SeatPolicyInput.safeParse({ id: ID, runs }).success).toBe(true);
    expect(SeatIdInput.safeParse({ id: "st_short" }).success).toBe(false);
    expect(SeatSignInCancelInput.safeParse({ id: ID, attempt: "sa_nope" }).success).toBe(false);
    expect(SeatAddInput.safeParse({ kind: "claude-subscription", label: "x", extra: 1 }).success).toBe(false);
  });

  test("a code is one word, as a vendor's page shows it: never more than a code holds", () => {
    expect(SeatSignInAnswerInput.parse({ id: ID, attempt: ATTEMPT, code: "  q8XyFAKEcode0#FAKEstate0  " }).code).toBe("q8XyFAKEcode0#FAKEstate0");
    expect(SeatSignInAnswerInput.safeParse({ id: ID, attempt: ATTEMPT, code: "two words" }).success).toBe(false);
    expect(SeatSignInAnswerInput.safeParse({ id: ID, attempt: ATTEMPT, code: "x".repeat(SEAT_LIMITS.code + 1) }).success).toBe(false);
    expect(SeatSignInAnswerInput.safeParse({ id: ID, attempt: ATTEMPT, code: "" }).success).toBe(false);
  });

  test("no input takes a token-shaped value: an Anthropic setup-token or key, a signed token, any key the scanner knows", () => {
    for (const fake of [FAKE_SETUP_TOKEN, FAKE_API_KEY, FAKE_SIGNED, FAKE_GITHUB]) {
      expect(tokenShaped(fake)).not.toBeNull();
      expect(tokenShaped(`my seat ${fake}`)).not.toBeNull();
      const label = fake.length <= SEAT_LIMITS.label ? fake : FAKE_SIGNED_SHORT;
      expect(SeatAddInput.safeParse({ kind: "claude-subscription", label }).success).toBe(false);
      expect(SeatSignInAnswerInput.safeParse({ id: ID, attempt: ATTEMPT, code: fake }).success).toBe(false);
    }
    expect(SeatAddInput.safeParse({ kind: "claude-subscription", label: "x", email: `${FAKE_SETUP_TOKEN.slice(0, 30)}@example.test` }).success).toBe(false);
    const refused = SeatAddInput.safeParse({ kind: "claude-subscription", label: FAKE_SETUP_TOKEN });
    expect(refused.success ? "" : refused.error.issues[0]!.message).toContain("A seat never takes one");
    expect(tokenShaped("Work Max")).toBeNull();
    expect(tokenShaped("q8XyFAKEcode0#FAKEstate0")).toBeNull();
  });
});

describe("where a seat stands", () => {
  const MIN = 60_000;
  test("never signed in, then signing in for ten minutes at most, then ready until it rests", () => {
    expect(seatState(facts(), 0)).toEqual({ is: "signed-out", why: "never" });
    const started = facts({ signIn: { phase: "started", attempt: ATTEMPT, at: 1_000 } });
    expect(seatState(started, 1_000 + 9 * MIN)).toEqual({ is: "signing-in", attempt: ATTEMPT, since: 1_000, until: 1_000 + SEAT_LIMITS.attemptMinutes * MIN });
    expect(seatState(started, 1_000 + SEAT_LIMITS.attemptMinutes * MIN)).toEqual({ is: "signed-out", why: "expired" });
    const ready = facts({ signIn: { phase: "ended", attempt: ATTEMPT, outcome: "ready", method: "claude.ai", plan: "max", renewBy: 9_000_000, at: 2_000 } });
    expect(seatState(ready, 3_000)).toEqual({ is: "ready", renewBy: 9_000_000 });
    const resting = { ...ready, rest: { until: 10_000, window: "five_hour", at: 3_000 } };
    expect(seatState(resting, 4_000)).toEqual({ is: "resting", until: 10_000, window: "five_hour" });
    expect(seatState(resting, 10_000)).toEqual({ is: "ready", renewBy: 9_000_000 });
  });

  test("a sign-in that ended otherwise says why; a seat signed in to the wrong account is out", () => {
    for (const outcome of ["cancelled", "expired", "failed", "wrong-account", "signed-out"] as const) {
      expect(seatState(facts({ signIn: { phase: "ended", attempt: null, outcome, method: null, plan: null, renewBy: null, at: 1 } }), 2)).toEqual({ is: "signed-out", why: outcome });
    }
  });

  test("a plan or api seat is its key's: ready unless it rests", () => {
    const keyed = facts({ kind: "plan", provider: "zai" });
    expect(seatState(keyed, 0)).toEqual({ is: "ready", renewBy: null });
    expect(seatState({ ...keyed, rest: { until: 5, window: null, at: 1 } }, 2)).toEqual({ is: "resting", until: 5, window: null });
    expect(seatVendor(keyed)).toBe("zai");
  });

  test("the view says whose account it is, its tier and how it's signed in, and never its account's fingerprint", () => {
    const view = seatView(facts({ account: "fp_account_one_0000000", signIn: { phase: "ended", attempt: null, outcome: "ready", method: "claude.ai", plan: "max", renewBy: null, at: 1 } }), 2);
    expect(view).toMatchObject({ id: ID, kind: "claude-subscription", vendor: "anthropic", label: "Work Max", plan: "max", method: "claude.ai", state: { is: "ready" } });
    expect(JSON.stringify(view)).not.toContain("fp_account");
  });
});

describe("runs at once (D4) and the rule (D1, D2)", () => {
  test("a subscription takes no more than has been shown safe, Codex one always, a keyed seat its own setting", () => {
    expect(SHARED_RUNS_PROVEN).toBe(1);
    expect(seatRuns({ kind: "claude-subscription", runs: 3 })).toBe(SHARED_RUNS_PROVEN);
    expect(seatRuns({ kind: "chatgpt-codex", runs: 3 })).toBe(1);
    expect(seatRuns({ kind: "api", runs: 3 })).toBe(3);
    expect(seatRuns({ kind: "plan", runs: 2 })).toBe(2);
  });

  test("work never goes on on a second subscription seat of the same vendor; another vendor's, or a keyed seat, may take it", () => {
    const claude = (id: string) => ({ id, kind: "claude-subscription" as const });
    expect(mayCarryOn(claude("st_a"), claude("st_a"))).toBe(true);
    expect(mayCarryOn(claude("st_a"), claude("st_b"))).toBe(false);
    expect(mayCarryOn({ id: "st_c", kind: "chatgpt-codex" }, { id: "st_d", kind: "chatgpt-codex" })).toBe(false);
    // The same vendor's other sign-in is a second account all the same.
    expect(mayCarryOn({ id: "st_c", kind: "chatgpt-codex" }, { id: "st_e", kind: "chatgpt-siwc" })).toBe(false);
    expect(mayCarryOn(claude("st_a"), { id: "st_c", kind: "chatgpt-codex" })).toBe(true);
    // A plan's own sanctioned capacity: the API credits it comes with, on its Console org's key.
    expect(mayCarryOn(claude("st_a"), { id: "st_k", kind: "api", provider: "anthropic" })).toBe(true);
  });
});
