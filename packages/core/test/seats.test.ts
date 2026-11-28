import { describe, expect, test } from "bun:test";
import { Bodies } from "../src/events.ts";
import {
  accountSeat,
  chooseSeat,
  HOMED_KINDS,
  mayCarryOn,
  readSeatKind,
  readSignInMethod,
  readsSeatKind,
  SEATS_READ,
  seatKindBehind,
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
  SeatServesInput,
  seatRuns,
  seatServes,
  servedBy,
  SeatSignInAnswerInput,
  codeTokenShaped,
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
/** Fake, made the same on every run (xorshift32), never anyone's: shaped as a vendor's random codes are, so made here, not written down. */
const fakeRun = (seed: number, n: number): string => {
  const abc = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
  let x = Math.imul(seed, 2654435761) >>> 0 || 1;
  let out = "";
  for (let i = 0; i < n; i++) {
    x ^= x << 13;
    x >>>= 0;
    x ^= x >>> 17;
    x ^= x << 5;
    x >>>= 0;
    out += abc[x % 64];
  }
  return out;
};
/** Fake bytes, made the same on every run (xorshift32), never anyone's. */
const fakeBytes = (seed: number, n: number): Uint8Array => {
  let x = Math.imul(seed, 2654435761) >>> 0 || 1;
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    x ^= x << 13;
    x >>>= 0;
    x ^= x >>> 17;
    x ^= x << 5;
    x >>>= 0;
    out[i] = x >>> 24;
  }
  return out;
};
/**
 * Claude Code's state, made as Claude Code makes one (2.1.325, read from its binary by the re-check of 28 November 2026,
 * R5: base64url of 32 random bytes, 43 characters), of fake bytes.
 */
const claudeState = (seed: number): string => Buffer.from(fakeBytes(seed, 32)).toString("base64url");
/** A code of the shape Google's callback page shows (antigravity.google/oauth-callback): "4/0A" and about 69 more. */
const GOOGLE_CODE = `4/0A${fakeRun(4, 69)}`;

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
  serves: [],
  ...over,
});

describe("the inputs", () => {
  test("whom a seat serves: agents of its node's, by handle, each once; more than one only as a share you say, and none at all", () => {
    expect(SeatServesInput.safeParse({ id: ID, agents: ["ada"] }).success).toBe(true);
    expect(SeatServesInput.safeParse({ id: ID, agents: [] }).success).toBe(true);
    // Two agents is a share: yours to say, and what it means is said with the refusal.
    const unsaid = SeatServesInput.safeParse({ id: ID, agents: ["ada", "bo"] });
    expect(unsaid.success).toBe(false);
    expect(unsaid.error!.issues.map((issue) => issue.message).join(" ")).toContain("one trust domain");
    expect(SeatServesInput.safeParse({ id: ID, agents: ["ada", "bo"], shared: true }).success).toBe(true);
    const many = Array.from({ length: SEAT_LIMITS.serves + 1 }, (_, n) => `agent-${n}`);
    for (const bad of [{ agents: ["ada"], shared: true }, { agents: ["ada", "ada"], shared: true }, { agents: ["Ada"] }, { agents: ["primary"] }, { agents: ["owner"] }, { agents: many, shared: true }, { agents: ["ada"], shared: false }, { agents: [{ id: "ada", made: 1 }] }, { agents: ["ada"], made: 1 }, {}]) {
      expect(SeatServesInput.safeParse({ id: ID, ...bad }).success).toBe(false);
    }
    // Added for an agent: only a seat with a home of its own (a key reaches the agents you grant it).
    expect(SeatAddInput.safeParse({ kind: "claude-subscription", label: "Claude 1", agent: "ada" }).success).toBe(true);
    expect(SeatAddInput.safeParse({ kind: "chatgpt-codex", label: "ChatGPT 1", agent: "bo" }).success).toBe(true);
    expect(SeatAddInput.safeParse({ kind: "api", label: "Key", provider: "anthropic", agent: "ada" }).success).toBe(false);
    expect(SeatAddInput.safeParse({ kind: "claude-subscription", label: "Claude 1", agent: "Ada!" }).success).toBe(false);
  });

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

  // Claude Code asks for what its page shows as "code#state", and makes the state itself (the re-check of 28 November
  // 2026, R5). That state alone is a random run the scanner's high-entropy guess refuses, so no Claude seat could be
  // signed in from the card or inv; the fixtures' short, plain state hid it. Its code half is Anthropic's and unseen:
  // here a plain one, and random ones of two lengths.
  test("Claude Code's paste, code#state with the state as Claude Code makes it, is taken: random by design, it is no token (the re-check's R5)", () => {
    const answer = (code: string) => SeatSignInAnswerInput.safeParse({ id: ID, attempt: ATTEMPT, code });
    for (let seed = 1; seed <= 200; seed++) {
      const state = claudeState(seed);
      expect([seed, state.length, /^[A-Za-z0-9_-]+$/.test(state)]).toEqual([seed, 43, true]);
      // The scanner's high-entropy rule refuses the state alone: what refused the paste.
      expect([seed, tokenShaped(state)]).toEqual([seed, "high-entropy token"]);
      for (const half of ["FAKEcode0000", fakeRun(1000 + seed, 43), fakeRun(2000 + seed, 96)]) expect([seed, half.length, answer(`${half}#${state}`).success]).toEqual([seed, half.length, true]);
    }
  });

  test("in Claude Code's shape a key or a token is still refused, and so is a random run of no code's shape", () => {
    const answer = (code: string) => SeatSignInAnswerInput.safeParse({ id: ID, attempt: ATTEMPT, code });
    const state = claudeState(201);
    const github = `ghp_${fakeRun(9, 39).replace(/[-_]/g, "F")}`;
    const signed = `${Buffer.from('{"alg":"RS256"}').toString("base64url")}.${Buffer.from('{"sub":"0"}').toString("base64url")}.${fakeRun(8, 40)}`;
    // An Anthropic token, a key the scanner knows by name in either half; a signed token; and a random run alone, or with
    // a state a character short or long.
    const refused = [`sk-ant-oat01-${fakeRun(5, 40)}#${state}`, `${github}#${state}`, `FAKEcode0000#${github}`, signed, state, `FAKEcode0000#${state.slice(1)}`, `FAKEcode0000#${state}A`];
    for (const code of refused) expect([code.slice(0, 16), answer(code).success]).toEqual([code.slice(0, 16), false]);
    expect(refused.map(codeTokenShaped)).toEqual(["an Anthropic key or token", "GitHub token", "GitHub token", "a signed token", "high-entropy token", "high-entropy token", "high-entropy token"]);
  });

  test("the code Google's page shows, of its real shape, is taken: random by design, it is no token; a key or a token in that shape still isn't (the review's H2)", () => {
    const answer = (code: string) => SeatSignInAnswerInput.safeParse({ id: ID, attempt: ATTEMPT, code });
    // The scanner's high-entropy rule is what refused it: no Gemini seat could be signed in.
    expect(tokenShaped(GOOGLE_CODE)).toBe("high-entropy token");
    expect([answer(GOOGLE_CODE).success, answer("4/0FAKE-code-0000").success]).toEqual([true, true]);
    // Still refused: an Anthropic key, and a key the scanner knows by name, in a code's shape; a signed token; and a
    // long random run of no code's shape at all.
    const signed = `${Buffer.from('{"alg":"RS256"}').toString("base64url")}.${Buffer.from('{"sub":"0"}').toString("base64url")}.${fakeRun(8, 40)}`;
    const refused = [`4/sk-ant-oat01-${fakeRun(5, 40)}`, `4/ghp_${fakeRun(6, 36).replace(/[-_]/g, "F")}`, signed, fakeRun(7, 48)];
    for (const code of refused) expect([code.slice(0, 14), answer(code).success]).toEqual([code.slice(0, 14), false]);
    expect(refused.map(codeTokenShaped)).toEqual(["an Anthropic key or token", "GitHub token", "a signed token", "high-entropy token"]);
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

  test("an Antigravity seat's card shows Google's own sign-in page alone: not the page that shows its code, nor a look-alike", () => {
    const google = "https://accounts.google.com/o/oauth2/v2/auth?client_id=FAKE-client.apps.googleusercontent.com&redirect_uri=https%3A%2F%2Fantigravity.google%2Foauth-callback&response_type=code&state=FAKE-state-0000";
    expect(signInUrlOk("google-antigravity", google)).toBe(true);
    for (const url of [
      "http://accounts.google.com/o/oauth2/v2/auth",
      "https://accounts.google.com.example.test/o/oauth2/v2/auth",
      "https://user:pass@accounts.google.com/o/oauth2/v2/auth",
      "https://accounts.google.com:8443/o/oauth2/v2/auth",
      "https://antigravity.google/oauth-callback",
      "https://claude.ai/oauth/authorize",
    ]) expect([url, signInUrlOk("google-antigravity", url)]).toEqual([url, false]);
    expect(signInUrlOk("claude-subscription", google)).toBe(false);
    expect(signInUrlOk("chatgpt-codex", google)).toBe(false);
  });
});

/*
 * A seat of a kind some node of the fleet can't read is never added (the lead's word, 27 November 2026): that node
 * would refuse its seat.added, and hold back everything the adding node writes after it. Each node says in its profile
 * which kinds it reads (`caps.seats`, as `caps.requests` says what requests it reads); one that says nothing is older and
 * reads the first six alone.
 */
describe("which nodes can read a seat of a kind", () => {
  test("a node that says nothing of seats reads the first six kinds alone; one that names a kind reads it", () => {
    for (const kind of ["claude-subscription", "chatgpt-codex", "chatgpt-siwc", "mistral-vibe", "plan", "api"] as const) {
      expect([kind, readsSeatKind({}, kind), readsSeatKind(undefined, kind)]).toEqual([kind, true, true]);
    }
    expect(readsSeatKind({}, "google-antigravity")).toBe(false);
    expect(readsSeatKind({ requests: 2 }, "google-antigravity")).toBe(false);
    expect(readsSeatKind({ seats: SEATS_READ }, "google-antigravity")).toBe(true);
    // This release says every kind it has.
    expect(SEATS_READ).toEqual({ kinds: [...SEAT_KINDS] });
    // What isn't a list of kinds says nothing: read as an older node's.
    for (const seats of [null, "google-antigravity", { kinds: "google-antigravity" }, { kinds: [7] }, { kinds: Array(65).fill("google-antigravity") }]) {
      expect([seats, readsSeatKind({ seats }, "google-antigravity")]).toEqual([seats, false]);
    }
  });

  test("the nodes behind are named, and what to do is said: update them first", () => {
    const older = { id: "n_mini", name: "mini", caps: { requests: 2 } };
    const newer = { id: "n_book", name: "book", caps: { seats: SEATS_READ } };
    expect(seatKindBehind("google-antigravity", [newer])).toBeNull();
    expect(seatKindBehind("claude-subscription", [older])).toBeNull();
    expect(seatKindBehind("google-antigravity", [older, newer])).toBe("Update mini first: it runs a release that doesn't know Gemini plans");
    // A node that has said nothing at all yet (no profile) is behind too.
    expect(seatKindBehind("google-antigravity", [older, { id: "n_new", name: "studio", caps: null }])).toBe("Update mini and studio first: they run a release that doesn't know Gemini plans");
  });
});

/*
 * A seat of a kind a later release brings, as a replica of this one reads it (the lead's word, 27 November 2026): in the
 * log a seat's kind and its sign-in's method are words, so none is refused, nor holds back what its node writes after
 * it; read here as a kind or a method this release doesn't know. What a route takes is a kind it knows, as ever.
 */
describe("a kind a later release brings", () => {
  const NODE = `n_${"a".repeat(43)}`;
  const ID = `st_${"0".repeat(22)}`;
  const added = (kind: string) => Bodies["seat.added"].safeParse({ id: ID, kind, label: "Cursor 1", node: NODE, runs: 1 }).success;
  const ended = (method: string) => Bodies["seat.signin"].safeParse({ id: ID, phase: "ended", outcome: "ready", method }).success;

  test("its seat.added is taken, a kind as one word; read as no kind this release knows", () => {
    for (const kind of SEAT_KINDS) expect([kind, added(kind), readSeatKind(kind)]).toEqual([kind, true, kind]);
    expect([added("cursor-plan"), readSeatKind("cursor-plan")]).toEqual([true, null]);
    // One word, short: never two, never a flag, never anything a token could hide in.
    for (const kind of ["Cursor Plan", "cursor plan", "--tools", "cursor_plan", "1-plan", "", "x".repeat(41)]) expect([kind, added(kind)]).toEqual([kind, false]);
    // A route adds only a kind this release knows.
    expect(SeatAddInput.safeParse({ kind: "cursor-plan", label: "Cursor 1" }).success).toBe(false);
    expect(SeatAddInput.safeParse({ kind: "google-antigravity", label: "Gemini 1" }).success).toBe(true);
  });

  test("its sign-in, in its tool's word: taken, and read as no method this release knows", () => {
    for (const method of ["claude.ai", "api_key", "api-key", "signed in"]) expect([method, ended(method), readSignInMethod(method)]).toEqual([method, true, method]);
    expect([ended("cursor"), readSignInMethod("cursor")]).toEqual([true, null]);
    expect(readSignInMethod(undefined)).toBeNull();
    for (const method of ["Bearer abc", "-x", "", "x".repeat(33)]) expect([method, ended(method)]).toEqual([method, false]);
  });
});

/*
 * A Gemini plan (Google AI Pro or Ultra), signed in with Google's Antigravity CLI (agy) in the seat's own home and run
 * by it, as T3 Code drives it: the owner's choice of 27 November 2026 (agents' antigravity.ts says what was taken).
 */
describe("an Antigravity seat", () => {
  test("is Google's, has a home of its own, runs Antigravity, and takes one run at a time until more is shown safe", () => {
    expect(SEAT_KINDS).toContain("google-antigravity");
    expect(HOMED_KINDS).toContain("google-antigravity");
    expect(SEAT_HARNESS["google-antigravity"]).toBe("antigravity");
    expect(seatKindOf("antigravity")).toBe("google-antigravity");
    expect(seatVendor({ kind: "google-antigravity" })).toBe("google");
    expect(seatRuns({ kind: "google-antigravity", runs: 3 })).toBe(SHARED_RUNS_PROVEN);
    expect(SeatAddInput.safeParse({ kind: "google-antigravity", label: "Gemini Ultra", agent: "ada" }).success).toBe(true);
    // Its sign-in is Google's own page: no provider, no key.
    expect(SeatAddInput.safeParse({ kind: "google-antigravity", label: "Gemini Ultra", provider: "gemini" }).success).toBe(false);
  });

  test("work that ran on one never goes on on a second Google sign-in; another vendor's seat, or a key, may take it", () => {
    const agy = (id: string) => ({ id, kind: "google-antigravity" as const });
    expect(mayCarryOn(agy("st_g"), agy("st_g"))).toBe(true);
    expect(mayCarryOn(agy("st_g"), agy("st_h"))).toBe(false);
    expect(mayCarryOn(agy("st_g"), { id: "st_a", kind: "claude-subscription" })).toBe(true);
    expect(mayCarryOn(agy("st_g"), { id: "st_k", kind: "api", provider: "gemini" })).toBe(true);
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
  /** The agent each of these seats serves, as that agent: its id, and when it was made. */
  const ADA = { id: "ada", made: Date.UTC(2026, 10, 20, 8, 0) };
  const seat = (id: string, over: Partial<SeatView> = {}): SeatView => ({ id: `st_${id.padEnd(22, "0")}`, kind: "claude-subscription", vendor: "anthropic", label: id, node: "n_node", provider: null, runs: 1, plan: "max", method: "claude.ai", state: { is: "ready", renewBy: null }, windows: [], serves: [ADA], ...over });
  const used = (share: number, resetsIn: number, status: "allowed" | "warning" | "rejected" = "allowed") => ({ window: "five_hour", status, usedPercent: share, resetsAt: NOW + resetsIn, at: NOW - HOUR });
  const idle = () => 0;

  test("a seat serves the agent you chose for it, as that agent: another agent's run, or a later agent given its id, never takes it", () => {
    const BO = { id: "bo", made: ADA.made + HOUR };
    const ours = seat("ours", { windows: [used(10, HOUR)] });
    // Bo has no seat of its own: Ada's isn't one it may take, however much of its plan is left.
    expect(chooseSeat("claude", [ours], idle, NOW, { agent: BO })).toBeNull();
    // An agent given Ada's id after Ada was removed (its node's team made again, say) was made later: another agent.
    expect(chooseSeat("claude", [ours], idle, NOW, { agent: { id: "ada", made: ADA.made + 1 } })).toBeNull();
    expect(chooseSeat("claude", [ours], idle, NOW, { agent: ADA })?.label).toBe("ours");
    // Of two seats, the one with more headroom that serves Bo, never Ada's with more.
    const bos = seat("bos", { windows: [used(80, HOUR)], serves: [BO] });
    expect(chooseSeat("claude", [ours, bos], idle, NOW, { agent: BO })?.label).toBe("bos");
    // A seat that serves none (added without an agent, or from before seats served one) is taken by no run.
    expect(chooseSeat("claude", [seat("none", { serves: [] })], idle, NOW, { agent: ADA })).toBeNull();
    // A seat you share serves each agent it names, each as itself: one trust domain.
    const shared = seat("shared", { serves: [ADA, BO] });
    expect(chooseSeat("claude", [shared], idle, NOW, { agent: BO })?.label).toBe("shared");
    expect(chooseSeat("claude", [shared], idle, NOW, { agent: ADA })?.label).toBe("shared");
    expect([seatServes(shared, BO), seatServes(shared, { id: "bo", made: BO.made - 1 }), seatServes(ours, BO)]).toEqual([true, false, false]);
  });

  test("the agents a seat serves now: those it names that are on the roster as themselves, in its order; one removed, or a later one with its id, isn't", () => {
    const roster = [
      { id: "bo", name: "Bo", createdAt: ADA.made + HOUR },
      { id: "ada", name: "Ada", createdAt: ADA.made },
    ];
    expect(servedBy(seat("s", { serves: [ADA, { id: "bo", made: ADA.made + HOUR }] }), roster).map((a) => a.name)).toEqual(["Ada", "Bo"]);
    expect(servedBy(seat("s", { serves: [{ id: "bo", made: ADA.made + HOUR }, ADA] }), roster).map((a) => a.name)).toEqual(["Bo", "Ada"]);
    // Ada removed: the roster no longer has her, and the seat serves no one, though the log still names her.
    expect(servedBy(seat("s"), roster.slice(0, 1))).toEqual([]);
    // A later agent given Ada's id: not the one the seat names.
    expect(servedBy(seat("s"), [{ id: "ada", name: "Ada", createdAt: ADA.made + 5 }])).toEqual([]);
    // A seat that names one twice serves it once.
    expect(servedBy(seat("s", { serves: [ADA, ADA] }), roster).map((a) => a.id)).toEqual(["ada"]);
  });

  test("PROPERTY: on any roster, made of agents added, removed and their ids given again, a seat serves exactly the agents it names as themselves, whatever the order", () => {
    let state = 0xa9e17;
    const random = () => {
      state = (state + 0x6d2b79f5) >>> 0;
      let t = state;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    const ids = ["ada", "bo", "cy", "dee"];
    for (let round = 0; round < 300; round++) {
      // A team's history: agents added (each made at its own time), some removed, and some of their ids given again.
      let clock = ADA.made;
      const ever: { id: string; createdAt: number; removed: boolean }[] = [];
      for (let step = 0; step < 1 + Math.floor(random() * 10); step++) {
        const id = ids[Math.floor(random() * ids.length)]!;
        const current = ever.find((a) => a.id === id && !a.removed);
        if (current && random() < 0.5) current.removed = true;
        else if (!current) ever.push({ id, createdAt: (clock += 1 + Math.floor(random() * 1000)), removed: false });
      }
      // The seat names some of those that ever were, as each was when it was chosen.
      const named = ever.filter(() => random() < 0.5).map((a) => ({ id: a.id, made: a.createdAt }));
      const roster = ever.filter((a) => !a.removed);
      const served = servedBy(seat("s", { serves: named }), roster);
      // Exactly those named that are on the roster as themselves: never a removed one, never a later one with its id.
      const expected = roster.filter((a) => named.some((one) => one.id === a.id && one.made === a.createdAt));
      expect(new Set(served)).toEqual(new Set(expected));
      for (const agent of served) expect(ever.find((a) => a.id === agent.id && a.createdAt === agent.createdAt)?.removed).toBe(false);
      // The roster's order doesn't change who is served, and each is served as the run asks for it.
      expect(new Set(servedBy(seat("s", { serves: named }), [...roster].reverse()))).toEqual(new Set(served));
      for (const agent of ever) expect(seatServes(seat("s", { serves: named }), { id: agent.id, made: agent.createdAt })).toBe(named.some((one) => one.id === agent.id && one.made === agent.createdAt));
    }
  });

  test("the most headroom, then the soonest reset; its harness's seats alone; the same whatever their order", () => {
    const a = seat("a", { windows: [used(60, 2 * HOUR)] });
    const b = seat("b", { windows: [used(20, 4 * HOUR)] });
    const c = seat("c", { windows: [used(20, 1 * HOUR)] });
    const codex = seat("x", { kind: "chatgpt-codex", vendor: "openai", windows: [] });
    expect(chooseSeat("claude", [a, b, c, codex], idle, NOW, { agent: ADA })?.label).toBe("c");
    expect(chooseSeat("claude", [codex, c, b, a], idle, NOW, { agent: ADA })?.label).toBe("c");
    expect(chooseSeat("codex", [a, b, c, codex], idle, NOW, { agent: ADA })?.label).toBe("x");
    expect(chooseSeat("opencode", [a, b, c, codex], idle, NOW, { agent: ADA })).toBeNull();
    expect(SEAT_HARNESS).toEqual({ "claude-subscription": "claude", "chatgpt-codex": "codex", "google-antigravity": "antigravity" });
  });

  test("a window past its reset is fresh again, one its tool refused is used whole, and a seat with none left, resting, signed out or at its runs is passed over", () => {
    expect(seatHeadroom({ windows: [used(90, -1)] }, NOW)).toEqual({ used: 0, resetsAt: null });
    expect(seatHeadroom({ windows: [used(10, HOUR, "rejected"), used(40, 2 * HOUR)] }, NOW)).toEqual({ used: 100, resetsAt: NOW + HOUR });
    const spent = seat("spent", { windows: [used(100, HOUR)] });
    const resting = seat("resting", { state: { is: "resting", until: NOW + HOUR, window: "five_hour" } });
    const out = seat("out", { state: { is: "signed-out", why: "expired" } });
    const busy = seat("busy");
    const free = seat("free", { windows: [used(95, HOUR)] });
    expect(chooseSeat("claude", [spent, resting, out, busy, free], (id) => (id === busy.id ? 1 : 0), NOW, { agent: ADA })?.label).toBe("free");
    expect(chooseSeat("claude", [spent, resting, out, busy], (id) => (id === busy.id ? 1 : 0), NOW, { agent: ADA })).toBeNull();
  });

  test("work that ran on a seat goes on on it, never on a second subscription seat of the vendor's (D1, D2); a pin is that seat or none", () => {
    const mine = seat("mine", { windows: [used(70, HOUR)] });
    const other = seat("other", { windows: [used(5, HOUR)] });
    expect(chooseSeat("claude", [mine, other], idle, NOW, { agent: ADA })?.label).toBe("other");
    expect(chooseSeat("claude", [mine, other], idle, NOW, { agent: ADA, from: mine })?.label).toBe("mine");
    // Its seat spent, it isn't carried on another of the vendor's: there is none to take it.
    expect(chooseSeat("claude", [{ ...mine, state: { is: "resting", until: NOW + HOUR, window: "five_hour" } }, other], idle, NOW, { agent: ADA, from: mine })).toBeNull();
    expect(chooseSeat("claude", [mine, other], idle, NOW, { agent: ADA, pinned: mine.id })?.label).toBe("mine");
    expect(chooseSeat("claude", [mine, other], (id) => (id === mine.id ? 1 : 0), NOW, { agent: ADA, pinned: mine.id })).toBeNull();
  });

  test("a window its tool refused without saying when it resets is spent for five hours from when it was said, then fresh; an own VM's sign-in is an account no seat of its vendor's carries on", () => {
    const refused = { window: "five_hour", status: "rejected" as const, usedPercent: null, resetsAt: null, at: NOW - HOUR };
    expect(seatHeadroom({ windows: [refused] }, NOW)).toEqual({ used: 100, resetsAt: null });
    expect(seatHeadroom({ windows: [refused] }, NOW - HOUR + SEAT_LIMITS.restMinutes * 60_000)).toEqual({ used: 0, resetsAt: null });
    expect(chooseSeat("claude", [seat("r", { windows: [refused] })], idle, NOW, { agent: ADA })).toBeNull();
    expect(chooseSeat("claude", [seat("r", { windows: [refused] })], idle, NOW + 4 * HOUR, { agent: ADA })?.label).toBe("r");
    // Work that began on its agent's own VM's sign-in: no seat of that vendor's takes it on (it is another account).
    const own = accountSeat({ seat: null, kind: "claude-subscription" });
    expect(chooseSeat("claude", [seat("a")], idle, NOW, { agent: ADA, from: own })).toBeNull();
    expect(chooseSeat("codex", [seat("x", { kind: "chatgpt-codex", vendor: "openai" })], idle, NOW, { agent: ADA, from: own })?.label).toBe("x");
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
        return seat(`s${n}`, { kind, vendor: kind === "chatgpt-codex" ? "openai" : "anthropic", runs: 1 + Math.floor(random() * 3), state: pick(states), serves: pick([[ADA], [ADA], [], [{ id: "bo", made: 1 }], [ADA, { id: "bo", made: 1 }], [{ id: "ada", made: ADA.made + 1 }]]), windows: Array.from({ length: Math.floor(random() * 3) }, () => used(Math.floor(random() * 101), Math.floor((random() * 10 - 2) * HOUR), random() < 0.1 ? "rejected" : "allowed")) });
      });
      const load = new Map(seats.map((s) => [s.id, Math.floor(random() * 3)]));
      const busy = (id: string) => load.get(id) ?? 0;
      const harness = pick(["claude", "codex"]);
      const from = random() < 0.3 ? pick(seats) : null;
      const able = seats.filter((s) => seatServes(s, ADA) && SEAT_HARNESS[s.kind] === harness && s.state.is === "ready" && busy(s.id) < s.runs && seatHeadroom(s, NOW).used < 100 && (!from || mayCarryOn(from, s)));
      const chosen = chooseSeat(harness, seats, busy, NOW, { agent: ADA, from });
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
      expect(chooseSeat(harness, [...seats].reverse(), busy, NOW, { agent: ADA, from })?.id).toBe(chosen.id);
      expect(chooseSeat(harness, seats, busy, NOW, { agent: ADA, from })?.id).toBe(chosen.id);
    }
  });
});
