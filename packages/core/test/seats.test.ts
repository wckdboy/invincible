import { describe, expect, test } from "bun:test";
import {
  accountSeat,
  chooseSeat,
  mayCarryOn,
  seatKindOf,
  seatOpensAt,
  TaskAccount,
  SEAT_HARNESS,
  seatHeadroom,
  type SeatView,
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
  signInUrlOk,
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

describe("a sign-in's card", () => {
  test("shows only its vendor's own sign-in page, over https: never a look-alike, a login in the address, another port or a stranger's site", () => {
    expect(signInUrlOk("claude-subscription", "https://claude.ai/oauth/authorize?code=true&client_id=FAKE&state=FAKE")).toBe(true);
    expect(signInUrlOk("claude-subscription", "https://claude.com/cai/oauth/authorize?state=FAKE")).toBe(true);
    expect(signInUrlOk("chatgpt-codex", "https://auth.openai.com/codex/device")).toBe(true);
    for (const url of [
      "http://claude.ai/oauth/authorize",
      "https://claude.ai.example.test/oauth/authorize",
      "https://claude-ai.example.test/",
      "https://user:pass@claude.ai/oauth",
      "https://claude.ai:8443/oauth",
      "https://claude.ai/oauth authorize",
      "javascript:alert(1)",
      "not a url",
    ]) expect([url, signInUrlOk("claude-subscription", url)]).toEqual([url, false]);
    // Each vendor's own: not the other's, and never a keyed seat's.
    expect(signInUrlOk("chatgpt-codex", "https://claude.ai/oauth/authorize")).toBe(false);
    expect(signInUrlOk("claude-subscription", "https://auth.openai.com/codex/device")).toBe(false);
    expect(signInUrlOk("api", "https://claude.ai/oauth/authorize")).toBe(false);
  });
});

/*
 * The scheduler's choice (I15 step 9: Invincible chooses, the owner never routes): a seat whose own plan runs the
 * harness, ready, with a run to spare and some of its plan left, by headroom then the soonest reset; never a second
 * subscription seat of the vendor's for work that ran on one (D1, D2); a pin is that seat or none; the same seats at the
 * same time always the same choice.
 */
describe("which seat a run takes", () => {
  const NOW = Date.UTC(2026, 10, 27, 9, 0);
  const HOUR = 3_600_000;
  const seat = (id: string, over: Partial<SeatView> = {}): SeatView => ({ id: `st_${id.padEnd(22, "0")}`, kind: "claude-subscription", vendor: "anthropic", label: id, node: "n_node", provider: null, runs: 1, plan: "max", method: "claude.ai", state: { is: "ready", renewBy: null }, windows: [], ...over });
  const used = (share: number, resetsIn: number, status: "allowed" | "warning" | "rejected" = "allowed") => ({ window: "five_hour", status, usedPercent: share, resetsAt: NOW + resetsIn, at: NOW - HOUR });
  const idle = () => 0;

  test("the most headroom, then the soonest reset; its harness's seats alone; the same whatever their order", () => {
    const a = seat("a", { windows: [used(60, 2 * HOUR)] });
    const b = seat("b", { windows: [used(20, 4 * HOUR)] });
    const c = seat("c", { windows: [used(20, 1 * HOUR)] });
    const codex = seat("x", { kind: "chatgpt-codex", vendor: "openai", windows: [] });
    expect(chooseSeat("claude", [a, b, c, codex], idle, NOW)?.label).toBe("c");
    expect(chooseSeat("claude", [codex, c, b, a], idle, NOW)?.label).toBe("c");
    expect(chooseSeat("codex", [a, b, c, codex], idle, NOW)?.label).toBe("x");
    expect(chooseSeat("opencode", [a, b, c, codex], idle, NOW)).toBeNull();
    expect(SEAT_HARNESS).toEqual({ "claude-subscription": "claude", "chatgpt-codex": "codex" });
  });

  test("a window past its reset is fresh again, one its tool refused is used whole, and a seat with none left, resting, signed out or at its runs is passed over", () => {
    expect(seatHeadroom({ windows: [used(90, -1)] }, NOW)).toEqual({ used: 0, resetsAt: null });
    expect(seatHeadroom({ windows: [used(10, HOUR, "rejected"), used(40, 2 * HOUR)] }, NOW)).toEqual({ used: 100, resetsAt: NOW + HOUR });
    const spent = seat("spent", { windows: [used(100, HOUR)] });
    const resting = seat("resting", { state: { is: "resting", until: NOW + HOUR, window: "five_hour" } });
    const out = seat("out", { state: { is: "signed-out", why: "expired" } });
    const busy = seat("busy");
    const free = seat("free", { windows: [used(95, HOUR)] });
    expect(chooseSeat("claude", [spent, resting, out, busy, free], (id) => (id === busy.id ? 1 : 0), NOW)?.label).toBe("free");
    expect(chooseSeat("claude", [spent, resting, out, busy], (id) => (id === busy.id ? 1 : 0), NOW)).toBeNull();
  });

  test("work that ran on a seat goes on on it, never on a second subscription seat of the vendor's (D1, D2); a pin is that seat or none", () => {
    const mine = seat("mine", { windows: [used(70, HOUR)] });
    const other = seat("other", { windows: [used(5, HOUR)] });
    expect(chooseSeat("claude", [mine, other], idle, NOW)?.label).toBe("other");
    expect(chooseSeat("claude", [mine, other], idle, NOW, { from: mine })?.label).toBe("mine");
    // Its seat spent, it isn't carried on another of the vendor's: there is none to take it.
    expect(chooseSeat("claude", [{ ...mine, state: { is: "resting", until: NOW + HOUR, window: "five_hour" } }, other], idle, NOW, { from: mine })).toBeNull();
    expect(chooseSeat("claude", [mine, other], idle, NOW, { pinned: mine.id })?.label).toBe("mine");
    expect(chooseSeat("claude", [mine, other], (id) => (id === mine.id ? 1 : 0), NOW, { pinned: mine.id })).toBeNull();
  });

  test("a window its tool refused without saying when it resets is spent for five hours from when it was said, then fresh; an own VM's sign-in is an account no seat of its vendor's carries on", () => {
    const refused = { window: "five_hour", status: "rejected" as const, usedPercent: null, resetsAt: null, at: NOW - HOUR };
    expect(seatHeadroom({ windows: [refused] }, NOW)).toEqual({ used: 100, resetsAt: null });
    expect(seatHeadroom({ windows: [refused] }, NOW - HOUR + SEAT_LIMITS.restMinutes * 60_000)).toEqual({ used: 0, resetsAt: null });
    expect(chooseSeat("claude", [seat("r", { windows: [refused] })], idle, NOW)).toBeNull();
    expect(chooseSeat("claude", [seat("r", { windows: [refused] })], idle, NOW + 4 * HOUR)?.label).toBe("r");
    // Work that began on its agent's own VM's sign-in: no seat of that vendor's takes it on (it is another account).
    const own = accountSeat({ seat: null, kind: "claude-subscription" });
    expect(chooseSeat("claude", [seat("a")], idle, NOW, { from: own })).toBeNull();
    expect(chooseSeat("codex", [seat("x", { kind: "chatgpt-codex", vendor: "openai" })], idle, NOW, { from: own })?.label).toBe("x");
    expect(accountSeat({ seat: seat("a").id, kind: "claude-subscription" }).id).toBe(seat("a").id);
    expect([seatKindOf("claude"), seatKindOf("codex"), seatKindOf("opencode")]).toEqual(["claude-subscription", "chatgpt-codex", null]);
    expect(TaskAccount.safeParse({ seat: null, kind: "chatgpt-codex" }).success).toBe(true);
    expect(TaskAccount.safeParse({ seat: "st_x", kind: "chatgpt-codex" }).success).toBe(false);
    expect(TaskAccount.safeParse({ seat: null, kind: "chatgpt-codex", url: "https://example.test" }).success).toBe(false);
  });

  test("a spent seat is open again once every window of its used whole has ended and its rest is over; one not spent says so", () => {
    const week = { window: "seven_day", status: "rejected" as const, usedPercent: 100, resetsAt: NOW + 30 * HOUR, at: NOW - HOUR };
    expect(seatOpensAt({ windows: [used(40, HOUR)], state: { is: "ready", renewBy: null } }, NOW)).toBeNull();
    expect(seatOpensAt({ windows: [used(100, 2 * HOUR), week], state: { is: "ready", renewBy: null } }, NOW)).toBe(NOW + 30 * HOUR);
    expect(seatOpensAt({ windows: [used(100, 2 * HOUR)], state: { is: "resting", until: NOW + 3 * HOUR, window: "five_hour" } }, NOW)).toBe(NOW + 3 * HOUR);
    expect(seatOpensAt({ windows: [{ window: "five_hour", status: "rejected", usedPercent: null, resetsAt: null, at: NOW - HOUR }], state: { is: "ready", renewBy: null } }, NOW)).toBe(NOW - HOUR + SEAT_LIMITS.restMinutes * 60_000);
    // A window whose reset wasn't said is taken as said for five hours, whatever it says.
    expect(seatHeadroom({ windows: [{ window: "five_hour", status: "allowed", usedPercent: 80, resetsAt: null, at: NOW - 6 * HOUR }] }, NOW)).toEqual({ used: 0, resetsAt: null });
  });

  test("properties: any able seat means one is chosen; it is able and none able has more headroom; order never matters; the same seats give the same choice", () => {
    let state = 0x5eed;
    const random = () => {
      state = (state + 0x6d2b79f5) >>> 0;
      let t = state;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    const pick = <T,>(items: readonly T[]) => items[Math.floor(random() * items.length)]!;
    for (let round = 0; round < 400; round++) {
      const seats: SeatView[] = Array.from({ length: 1 + Math.floor(random() * 6) }, (_, n) => {
        const kind = pick(["claude-subscription", "chatgpt-codex", "plan"] as const);
        const states: SeatView["state"][] = [{ is: "ready", renewBy: null }, { is: "ready", renewBy: null }, { is: "resting", until: NOW + HOUR, window: null }, { is: "signed-out", why: "never" }];
        return seat(`s${n}`, { kind, vendor: kind === "chatgpt-codex" ? "openai" : "anthropic", runs: 1 + Math.floor(random() * 3), state: pick(states), windows: Array.from({ length: Math.floor(random() * 3) }, () => used(Math.floor(random() * 101), Math.floor((random() * 10 - 2) * HOUR), random() < 0.1 ? "rejected" : "allowed")) });
      });
      const load = new Map(seats.map((s) => [s.id, Math.floor(random() * 3)]));
      const busy = (id: string) => load.get(id) ?? 0;
      const harness = pick(["claude", "codex"]);
      const from = random() < 0.3 ? pick(seats) : null;
      const able = seats.filter((s) => SEAT_HARNESS[s.kind] === harness && s.state.is === "ready" && busy(s.id) < s.runs && seatHeadroom(s, NOW).used < 100 && (!from || mayCarryOn(from, s)));
      const chosen = chooseSeat(harness, seats, busy, NOW, { from });
      expect(chosen === null).toBe(able.length === 0);
      if (!chosen) continue;
      expect(able).toContain(chosen);
      const room = (s: SeatView) => seatHeadroom(s, NOW);
      for (const other of able) {
        const better = room(other).used < room(chosen).used || (room(other).used === room(chosen).used && (room(other).resetsAt ?? Infinity) < (room(chosen).resetsAt ?? Infinity));
        expect(better).toBe(false);
      }
      // Never a second subscription seat of the vendor's for work that ran on one.
      if (from && from.id !== chosen.id) expect(mayCarryOn(from, chosen)).toBe(true);
      expect(chooseSeat(harness, [...seats].reverse(), busy, NOW, { from })?.id).toBe(chosen.id);
      expect(chooseSeat(harness, seats, busy, NOW, { from })?.id).toBe(chosen.id);
    }
  });
});
