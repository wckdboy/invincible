import { z } from "zod";
import { findSecrets } from "./secret-scan.ts";

/*
 * Seats: one account you hold with a vendor, added once, that any agent may use (docs/ARCHITECTURE.md §6):
 *   claude-subscription  a Claude Pro, Max or Ultra plan, signed in with Claude Code in the seat's own home;
 *   chatgpt-codex        a ChatGPT plan, signed in with Codex in the seat's own home;
 *   chatgpt-siwc         a ChatGPT plan through Sign in with ChatGPT, its tokens held by the node (never in a VM);
 *   mistral-vibe         a Mistral plan, signed in with Mistral Vibe in the seat's own home;
 *   plan                 a coding plan's key, in the vault, through the gateway;
 *   api                  an API key, in the vault, through the gateway.
 * A seat's home is a volume of its own on the node that holds it, where the vendor's own tool keeps its sign-in, made
 * there in the vendor's own flow. The node never reads its files: it reads what the tool's own status command says,
 * and five things of that (signed in or not, how, the plan's tier, the account's fingerprint, when the sign-in ends).
 *
 * The rule, the owner's word (26 November 2026, "All, never switch"): every account is used side by side, each running
 * its own agents, and work running on one never moves to a second subscription seat of the same vendor. A spent seat's
 * work waits for its reset, goes to another vendor's tool, or uses that plan's own sanctioned capacity (such as the API
 * credits a Claude plan comes with). There is no setting that switches accounts: mayCarryOn says so for every caller.
 *
 * Where a seat stands is worked out here, the same on every node and in every app, from what the log holds (the mind's
 * seats: seat.added, seat.signin, seat.window, seat.rested, seat.back, seat.policy, seat.removed). None of those carries
 * a sign-in's address, its code or a token; the email a sign-in starts with is sealed in the vault, never in the log.
 */

export const SEAT_KINDS = ["claude-subscription", "chatgpt-codex", "chatgpt-siwc", "mistral-vibe", "plan", "api"] as const;
export const SeatKind = z.enum(SEAT_KINDS);
export type SeatKind = z.infer<typeof SeatKind>;

/** The kinds that are an account of a vendor's own, signed in through its own flow: the rest are keys in the vault. */
export const SUBSCRIPTION_KINDS: readonly SeatKind[] = ["claude-subscription", "chatgpt-codex", "chatgpt-siwc", "mistral-vibe"];
/** The kinds whose sign-in a vendor's tool keeps in the seat's home, on its node (chatgpt-siwc's is the node's own). */
export const HOMED_KINDS: readonly SeatKind[] = ["claude-subscription", "chatgpt-codex", "mistral-vibe"];

export const SEAT_LIMITS = {
  label: 60,
  email: 254,
  /** What a vendor's page shows to paste back (Claude's code): longer is not one. */
  code: 512,
  /** Runs at once on one seat, as you may set it (D4: "Up to 3"). */
  runs: 3,
  /** How long a sign-in waits for you before it lapses. */
  attemptMinutes: 10,
  /** Windows kept for one seat (five hours, a week, a model's week, a month…). */
  windows: 8,
} as const;

/**
 * How many runs at once a subscription seat takes, until shown otherwise (D4). One, until two VMs have shared one seat's
 * home across a token refresh with its window read right (I15 step 3b); then three, the owner's word already given. A
 * seat's own setting (`runs`) can only lower it. Codex's homes stay one at a time whatever that shows: OpenAI's CI page
 * (learn.chatgpt.com/docs/auth/ci-cd-auth, read 26 November 2026) asks that only one machine or serialized job stream
 * use a given copy of Codex's sign-in.
 */
export const SHARED_RUNS_PROVEN = 1;

export const SeatId = z.string().regex(/^st_[A-Za-z0-9_-]{22}$/, "a seat's id");
export type SeatId = z.infer<typeof SeatId>;
/** One sign-in, from its start to its end: the node's own, never anything of the vendor's. */
export const SeatAttemptId = z.string().regex(/^sa_[A-Za-z0-9_-]{22}$/, "a sign-in's id");

/** How a tool says it is signed in: one of these words is all that is passed on of what its status command prints. */
export const SIGN_IN_METHODS = ["claude.ai", "oauth_token", "api_key", "api_key_helper", "third_party", "chatgpt", "api-key", "signed in"] as const;
export const SignInMethod = z.enum(SIGN_IN_METHODS);

/** A plan's tier, as its tool says it ("pro", "max", "ultra", "plus", "team"…): one word. */
export const SeatPlan = z.string().regex(/^[a-z0-9][a-z0-9_.-]{0,31}$/, "a plan's tier, in one word");
/**
 * Which account a seat is signed in to, as a salted hash made in its VM from the account's own id: every later sign-in
 * must be the same account, so a seat signed in to the wrong one is refused. The id itself never leaves the VM.
 */
export const SeatFingerprint = z.string().regex(/^[A-Za-z0-9_-]{22}$/, "an account's fingerprint");
/** A window as its tool names it: five_hour, seven_day, seven_day_opus, primary, secondary, monthly… */
export const SeatWindowName = z.string().regex(/^[a-z0-9][a-z0-9_]{0,31}$/, "a window's name");
export const SeatWindowStatus = z.enum(["allowed", "warning", "rejected"]);
/** A plan or api seat's provider (as a provider's id is: providers.ts), whose key is in the vault. */
const SeatProvider = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9._:-]+$/)
  .refine((name) => name !== "search" && !name.startsWith("git:"), "search and git:… are your agent's own gateway scopes, not model providers");

/** Anything a seat must never be given: an Anthropic key or token (a setup-token too: D3), a signed three-part token, or any key the scanner knows. */
const SIGNED = /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/;
export function tokenShaped(text: string): string | null {
  if (/sk-ant-/i.test(text)) return "an Anthropic key or token";
  if (SIGNED.test(text)) return "a signed token";
  return findSecrets(text)[0]?.kind ?? null;
}
const NO_TOKEN = "That looks like a token or a key. A seat never takes one: its account is signed in on the vendor's own page.";
const untokened = <T extends z.ZodType<string>>(schema: T) => schema.refine((text) => tokenShaped(text) === null, NO_TOKEN);

/** What you call a seat: one plain line ("Work Max", "Personal Pro"). */
export const SeatLabel = untokened(
  z
    .string()
    .trim()
    .min(1)
    .max(SEAT_LIMITS.label)
    .refine((text) => !/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/.test(text), "a seat's name is one plain line"),
);
const SeatEmail = untokened(z.string().trim().max(SEAT_LIMITS.email).email());
const SeatRuns = z.number().int().min(1).max(SEAT_LIMITS.runs);

/** Add a seat (fleet:admin). A plan or api seat names its provider; a subscription seat may name the email its sign-in starts with. */
export const SeatAddInput = z
  .strictObject({
    kind: SeatKind,
    label: SeatLabel,
    /** The account's email, to start its sign-in with: sealed in the vault, never in the log. */
    email: SeatEmail.optional(),
    provider: SeatProvider.optional(),
    runs: SeatRuns.optional(),
  })
  .superRefine((input, ctx) => {
    const keyed = input.kind === "plan" || input.kind === "api";
    if (keyed && !input.provider) ctx.addIssue({ code: "custom", path: ["provider"], message: "a plan or api seat names the provider whose key it is" });
    if (!keyed && input.provider) ctx.addIssue({ code: "custom", path: ["provider"], message: "only a plan or api seat names a provider" });
    if (keyed && input.email) ctx.addIssue({ code: "custom", path: ["email"], message: "a plan or api seat has no sign-in to start with an email" });
  });
export type SeatAddInput = z.infer<typeof SeatAddInput>;

/** One seat, by its id (remove; start a sign-in). */
export const SeatIdInput = z.strictObject({ id: SeatId });
/** Your answer to a sign-in that asks for one: the code its vendor's page showed you. It goes to that sign-in's process alone. */
export const SeatSignInAnswerInput = z.strictObject({
  id: SeatId,
  attempt: SeatAttemptId,
  code: untokened(z.string().trim().min(1).max(SEAT_LIMITS.code).regex(/^[!-~]+$/, "a code is one word of letters, digits and signs")),
});
export const SeatSignInCancelInput = z.strictObject({ id: SeatId, attempt: SeatAttemptId });
/** A seat's own setting: how many runs at once it takes, at most (D4; never above SHARED_RUNS_PROVEN for a subscription). */
export const SeatPolicyInput = z.strictObject({ id: SeatId, runs: SeatRuns });

/* ---------- in the log (the bodies, with a node's own device id where one is named: events.ts) ---------- */

/** How a sign-in ended: ready, or why not. */
export const SEAT_SIGN_IN_OUTCOMES = ["ready", "signed-out", "cancelled", "expired", "failed", "wrong-account"] as const;
export const SeatSignInOutcome = z.enum(SEAT_SIGN_IN_OUTCOMES);

export const SeatSignInBody = z.discriminatedUnion("phase", [
  z.strictObject({ id: SeatId, attempt: SeatAttemptId, phase: z.literal("started") }),
  /**
   * Ended: by a sign-in (`attempt`), or as its node found it when it asked the tool (none). Ready says how, the tier and
   * the account's fingerprint, and when the sign-in ends at the earliest (Claude's "Sign-in ends: between …").
   */
  z.strictObject({
    id: SeatId,
    attempt: SeatAttemptId.optional(),
    phase: z.literal("ended"),
    outcome: SeatSignInOutcome,
    method: SignInMethod.optional(),
    plan: SeatPlan.optional(),
    fingerprint: SeatFingerprint.optional(),
    renewBy: z.number().int().min(0).optional(),
  }),
]);
export type SeatSignInBody = z.infer<typeof SeatSignInBody>;

export const SeatWindowBody = z.strictObject({
  id: SeatId,
  window: SeatWindowName,
  status: SeatWindowStatus,
  usedPercent: z.number().int().min(0).max(100).optional(),
  resetsAt: z.number().int().min(0).optional(),
});
export type SeatWindowBody = z.infer<typeof SeatWindowBody>;

/* ---------- where a seat stands ---------- */

/** A seat as the log holds it (the mind's SeatFacts). */
export interface SeatFacts {
  id: string;
  kind: SeatKind;
  label: string;
  /** The node that holds its home (and its tokens, for chatgpt-siwc). */
  node: string;
  provider: string | null;
  /** Runs at once, as you set it. */
  runs: number;
  addedAt: number;
  /** Its latest sign-in, begun or ended. */
  signIn:
    | { phase: "started"; attempt: string; at: number }
    | { phase: "ended"; attempt: string | null; outcome: z.infer<typeof SeatSignInOutcome>; method: string | null; plan: string | null; renewBy: number | null; at: number }
    | null;
  /** The account its first sign-in was to: every later one is held to it. */
  account: string | null;
  windows: { window: string; status: z.infer<typeof SeatWindowStatus>; usedPercent: number | null; resetsAt: number | null; at: number }[];
  /** Resting until its window resets, as its node said (`window`: the one that is spent). */
  rest: { until: number; window: string | null; at: number } | null;
}

export type SeatState =
  /** Never signed in, or not now: `why` says what ended its last sign-in. */
  | { is: "signed-out"; why: "never" | "signed-out" | "cancelled" | "expired" | "failed" | "wrong-account" }
  | { is: "signing-in"; attempt: string; since: number; until: number }
  /** Signed in: `renewBy`, when its sign-in may end at the earliest (sign in again before then). */
  | { is: "ready"; renewBy: number | null }
  | { is: "resting"; until: number; window: string | null };

/** Where a seat stands at `now`. A sign-in nobody ended within SEAT_LIMITS.attemptMinutes has lapsed; a rest past its reset is over. */
export function seatState(seat: SeatFacts, now: number): SeatState {
  const rested = seat.rest && seat.rest.until > now ? { is: "resting" as const, until: seat.rest.until, window: seat.rest.window } : null;
  if (!SUBSCRIPTION_KINDS.includes(seat.kind)) return rested ?? { is: "ready", renewBy: null };
  const sign = seat.signIn;
  if (!sign) return { is: "signed-out", why: "never" };
  if (sign.phase === "started") {
    const until = sign.at + SEAT_LIMITS.attemptMinutes * 60_000;
    return now < until ? { is: "signing-in", attempt: sign.attempt, since: sign.at, until } : { is: "signed-out", why: "expired" };
  }
  if (sign.outcome !== "ready") return { is: "signed-out", why: sign.outcome };
  return rested ?? { is: "ready", renewBy: sign.renewBy };
}

/** A seat, and where it stands: what every app shows. */
export interface SeatView {
  id: string;
  kind: SeatKind;
  /** Whose account it is: anthropic, openai, mistral, or a keyed seat's provider. */
  vendor: string;
  label: string;
  node: string;
  provider: string | null;
  /** Runs at once it takes now: its setting, held to what has been shown safe (SHARED_RUNS_PROVEN). */
  runs: number;
  plan: string | null;
  method: string | null;
  state: SeatState;
  windows: SeatFacts["windows"];
}

export function seatView(seat: SeatFacts, now: number): SeatView {
  const signed = seat.signIn?.phase === "ended" && seat.signIn.outcome === "ready" ? seat.signIn : null;
  return {
    id: seat.id,
    kind: seat.kind,
    vendor: seatVendor(seat),
    label: seat.label,
    node: seat.node,
    provider: seat.provider,
    runs: seatRuns(seat),
    plan: signed?.plan ?? null,
    method: signed?.method ?? null,
    state: seatState(seat, now),
    windows: seat.windows,
  };
}

/** Whose account a seat is. */
export function seatVendor(seat: { kind: SeatKind; provider?: string | null }): string {
  switch (seat.kind) {
    case "claude-subscription":
      return "anthropic";
    case "chatgpt-codex":
    case "chatgpt-siwc":
      return "openai";
    case "mistral-vibe":
      return "mistral";
    default:
      return seat.provider ?? "unknown";
  }
}

/** Runs at once a seat takes: its own setting, and for a subscription never more than has been shown safe (D4). */
export function seatRuns(seat: { kind: SeatKind; runs: number }): number {
  const limit = seat.kind === "chatgpt-codex" ? 1 : SUBSCRIPTION_KINDS.includes(seat.kind) ? SHARED_RUNS_PROVEN : SEAT_LIMITS.runs;
  return Math.max(1, Math.min(seat.runs, limit));
}

/**
 * The rule (D1 and D2, the owner's "never switch"): may work that runs on `from` go on on `to`? Never on a second
 * subscription seat of the same vendor: that would be one account's spent window carried on another's. Any other way
 * on is the scheduler's to weigh (another vendor's tool, a keyed seat's sanctioned capacity, or waiting for the reset).
 */
export function mayCarryOn(from: { id: string; kind: SeatKind; provider?: string | null }, to: { id: string; kind: SeatKind; provider?: string | null }): boolean {
  if (from.id === to.id) return true;
  const both = SUBSCRIPTION_KINDS.includes(from.kind) && SUBSCRIPTION_KINDS.includes(to.kind);
  return !(both && seatVendor(from) === seatVendor(to));
}
