import { z } from "zod";
import { findSecrets } from "./secret-scan.ts";
import { HOMED_KINDS, SEAT_HARNESS, type SeatAgent, seatServes, servedBy } from "./seat-agents.ts";
import { AgentId } from "./team.ts";

// (Which agents a seat serves, and which tool runs on it, are plain rules of their own, re-exported here: seat-agents.ts.)
export { HOMED_KINDS, SEAT_HARNESS, type SeatAgent, seatServes, servedBy };

/*
 * Seats: one account you hold with a vendor, added once, that serves the agents you choose (docs/ARCHITECTURE.md §6):
 *   claude-subscription  a Claude Pro, Max or Ultra plan, signed in with Claude Code in the seat's own home;
 *   chatgpt-codex        a ChatGPT plan, signed in with Codex in the seat's own home;
 *   chatgpt-siwc         a ChatGPT plan through Sign in with ChatGPT, its tokens held by the node (never in a VM);
 *   mistral-vibe         a Mistral plan, signed in with Mistral Vibe in the seat's own home;
 *   google-antigravity   a Gemini plan (Google AI Pro or Ultra), signed in with Google's Antigravity CLI (agy) in the
 *                        seat's own home, and run by it as T3 Code drives it: the owner's choice of 27 November 2026,
 *                        accepting the risk Google's Antigravity terms put on their Google account (clause 6);
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
 * A seat serves one agent, the one you choose for it, and others only when you share it (the owner's word, 27 November
 * 2026, "One trust domain"). Its home is shared by every run on it, and what one run leaves there (its tool's settings,
 * hooks and notes) is what the next one runs with: the agents sharing a seat are one trust domain, and that is said
 * wherever you choose it. A seat names each agent as that agent, its handle and when its node's team made it, so an
 * agent you remove, or a later one given its handle, is never served. Whether one is served is worked out from the
 * roster wherever a seat is used or shown (servedBy, seatServes), never written into the log on anyone's behalf.
 *
 * Where a seat stands is worked out here, the same on every node and in every app, from what the log holds (the mind's
 * seats: seat.added, seat.signin, seat.window, seat.rested, seat.back, seat.policy, seat.serves, seat.removed). None of
 * those carries a sign-in's address, its code or a token; the email a sign-in starts with is sealed in the vault, never
 * in the log.
 */

export const SEAT_KINDS = ["claude-subscription", "chatgpt-codex", "chatgpt-siwc", "mistral-vibe", "google-antigravity", "plan", "api"] as const;
export const SeatKind = z.enum(SEAT_KINDS);
export type SeatKind = z.infer<typeof SeatKind>;

/**
 * A seat's kind as the log holds it (seat.added): one word, so a replica never refuses the seat.added of a kind it
 * doesn't know, a later release's, and so never holds back everything its node writes after it (the lead's word, 27
 * November 2026; AGENTS.md's rule for unknown kinds, applied to an enum inside a known event). What a route takes is a
 * SeatKind, as ever: a node adds only a kind it knows.
 */
export const SeatKindWord = z.string().regex(/^[a-z][a-z0-9-]{0,39}$/, "a seat's kind, in one word");
/** The kind a word names, or null: a kind this release doesn't know, kept as it was said and used for nothing. */
export const readSeatKind = (word: string): SeatKind | null => ((SEAT_KINDS as readonly string[]).includes(word) ? (word as SeatKind) : null);

/**
 * The kinds every release has read, the six of the first: a node whose profile says nothing of seats reads these alone,
 * and refuses a seat.added of any other kind, which holds back its sync of everything the adding node writes after it.
 * (Every release whose profile says which kinds it reads also keeps a seat of any other kind, as one it doesn't know:
 * both came in one release.)
 */
const FIRST_SEAT_KINDS: readonly SeatKind[] = ["claude-subscription", "chatgpt-codex", "chatgpt-siwc", "mistral-vibe", "plan", "api"];

/**
 * What a node's profile says of seats (`caps.seats`, as `caps.requests` says which requests it reads): the kinds it
 * reads. A seat of a kind some node of the fleet doesn't read yet is never added (seatKindBehind).
 */
export const SEATS_READ: { kinds: readonly SeatKind[] } = { kinds: [...SEAT_KINDS] };

/** Whether a node reads a seat of this kind, by what its profile says (`caps`): one that says nothing reads the first six alone. */
export function readsSeatKind(caps: unknown, kind: SeatKind): boolean {
  const said = caps && typeof caps === "object" ? (caps as { seats?: unknown }).seats : undefined;
  const kinds = said && typeof said === "object" ? (said as { kinds?: unknown }).kinds : undefined;
  if (Array.isArray(kinds) && kinds.length <= 64 && kinds.every((one) => typeof one === "string")) return kinds.includes(kind);
  return FIRST_SEAT_KINDS.includes(kind);
}

/** A kind as a sentence names many of them. */
const KIND_PLURALS: Readonly<Record<SeatKind, string>> = {
  "claude-subscription": "Claude plans",
  "chatgpt-codex": "ChatGPT plans",
  "chatgpt-siwc": "ChatGPT plans",
  "mistral-vibe": "Mistral plans",
  "google-antigravity": "Gemini plans",
  plan: "coding plans",
  api: "API keys",
};

/**
 * Why a seat of this kind can't be added yet, in a sentence, or null: the fleet's other nodes (each with what its profile
 * says, null where it has said nothing yet) that don't read it, named, to be updated first. Each would refuse its
 * seat.added and hold back its sync of everything this node writes after it (the lead's word, 27 November 2026).
 */
export function seatKindBehind(kind: SeatKind, nodes: readonly { id: string; name: string; caps: unknown }[]): string | null {
  const behind = nodes.filter((node) => !readsSeatKind(node.caps, kind)).map((node) => node.name.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, " ").trim() || node.id);
  if (!behind.length) return null;
  const named = behind.length === 1 ? behind[0]! : `${behind.slice(0, -1).join(", ")} and ${behind.at(-1)}`;
  return `Update ${named} first: ${behind.length === 1 ? "it runs" : "they run"} a release that doesn't know ${KIND_PLURALS[kind]}`;
}

/** The kinds that are an account of a vendor's own, signed in through its own flow: the rest are keys in the vault. */
export const SUBSCRIPTION_KINDS: readonly SeatKind[] = ["claude-subscription", "chatgpt-codex", "chatgpt-siwc", "mistral-vibe", "google-antigravity"];

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
  /** How long a window its tool refused without saying when it resets counts as spent: the shortest plan window, five hours. */
  restMinutes: 300,
  /** Agents one seat serves, at most: as many as a node's team holds (TEAM_LIMITS.agents). */
  serves: 32,
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
/**
 * How a tool said it is signed in, as the log holds it (seat.signin): one word, as a seat's kind is, since a later
 * release's kind brings its tool's own word, and a replica that refused it would hold back everything the seat's node
 * writes after it. Read as one of these, or as none (readSignInMethod).
 */
export const SignInMethodWord = z.string().regex(/^[a-z0-9][a-z0-9_. -]{0,31}$/, "how a tool says it is signed in, in a word");
export const readSignInMethod = (word: string | undefined): z.infer<typeof SignInMethod> | null => ((SIGN_IN_METHODS as readonly string[]).includes(word ?? "") ? (word as z.infer<typeof SignInMethod>) : null);

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

/**
 * The codes a vendor's page shows you to paste back, by their shape. Each is random by design, so the scanner's guess at
 * a token of no kind it knows (its high-entropy rule) is no reason to refuse one: Claude Code's, "code#state", whose
 * state Claude Code makes itself as base64url of 32 random bytes, 43 characters (2.1.325, read from its binary: the
 * re-check of 28 November 2026, R5; its code half is Anthropic's). What the scanner knows by name is still refused in
 * one, and so are an Anthropic key and a signed token. (Codex's sign-in takes no paste: you enter its code on its page.)
 */
const VENDOR_CODES: readonly RegExp[] = [/^[A-Za-z0-9_-]{8,512}#[A-Za-z0-9_-]{43}$/];
/** Why a code you paste for a seat's sign-in is refused, or null: as tokenShaped, but a vendor's code of its own shape isn't a token. */
export function codeTokenShaped(code: string): string | null {
  if (!VENDOR_CODES.some((shape) => shape.test(code))) return tokenShaped(code);
  if (/sk-ant-/i.test(code)) return "an Anthropic key or token";
  if (SIGNED.test(code)) return "a signed token";
  return findSecrets(code).find((found) => found.kind !== "high-entropy token")?.kind ?? null;
}

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

/**
 * Add a seat (fleet:admin). A plan or api seat names its provider; a subscription seat may name the email its sign-in
 * starts with, and the agent it serves (one of its node's, by handle): without one, it serves none until you choose.
 */
export const SeatAddInput = z
  .strictObject({
    kind: SeatKind,
    label: SeatLabel,
    /** The account's email, to start its sign-in with: sealed in the vault, never in the log. */
    email: SeatEmail.optional(),
    provider: SeatProvider.optional(),
    runs: SeatRuns.optional(),
    agent: AgentId.optional(),
  })
  .superRefine((input, ctx) => {
    const keyed = input.kind === "plan" || input.kind === "api";
    if (keyed && !input.provider) ctx.addIssue({ code: "custom", path: ["provider"], message: "a plan or api seat names the provider whose key it is" });
    if (!keyed && input.provider) ctx.addIssue({ code: "custom", path: ["provider"], message: "only a plan or api seat names a provider" });
    if (keyed && input.email) ctx.addIssue({ code: "custom", path: ["email"], message: "a plan or api seat has no sign-in to start with an email" });
    if (input.agent && !HOMED_KINDS.includes(input.kind)) ctx.addIssue({ code: "custom", path: ["agent"], message: "only a seat with a home of its own serves an agent: a key reaches the agents you grant it" });
  });
export type SeatAddInput = z.infer<typeof SeatAddInput>;

/** One seat, by its id (remove; start a sign-in). */
export const SeatIdInput = z.strictObject({ id: SeatId });
/** Your answer to a sign-in that asks for one: the code its vendor's page showed you. It goes to that sign-in's process alone. */
export const SeatSignInAnswerInput = z.strictObject({
  id: SeatId,
  attempt: SeatAttemptId,
  code: z
    .string()
    .trim()
    .min(1)
    .max(SEAT_LIMITS.code)
    .regex(/^[!-~]+$/, "a code is one word of letters, digits and signs")
    .refine((code) => codeTokenShaped(code) === null, NO_TOKEN),
});
export const SeatSignInCancelInput = z.strictObject({ id: SeatId, attempt: SeatAttemptId });
/** A seat's own setting: how many runs at once it takes, at most (D4; never above SHARED_RUNS_PROVEN for a subscription). */
export const SeatPolicyInput = z.strictObject({ id: SeatId, runs: SeatRuns });
/**
 * The agents a seat serves (fleet:admin): its node's own, by handle, each once; one, or none. More than one is a share,
 * and only with `shared: true`: the agents sharing a seat are one trust domain, and that is yours to say.
 */
export const SeatServesInput = z
  .strictObject({ id: SeatId, agents: z.array(AgentId).max(SEAT_LIMITS.serves), shared: z.literal(true).optional() })
  .superRefine((input, ctx) => {
    if (new Set(input.agents).size !== input.agents.length) ctx.addIssue({ code: "custom", path: ["agents"], message: "each agent is named once" });
    if (input.agents.length > 1 && !input.shared) ctx.addIssue({ code: "custom", path: ["shared"], message: "a seat serves one agent: to share it, say so (shared: true). The agents sharing a seat are one trust domain: what one's runs leave in its home, the next runs with" });
    if (input.shared && input.agents.length < 2) ctx.addIssue({ code: "custom", path: ["shared"], message: "a seat is shared by two agents or more" });
  });

/* ---------- signing a seat in (never in the log: a card lives on the node, for the length of its sign-in) ---------- */

/**
 * What a sign-in asks of you, on your device: Codex's device code (open its page, sign in there and enter the code it
 * shows here), or Claude Code's (open its page, sign in there, and paste back the code it shows you, which goes to that
 * sign-in's own process and nowhere else: D7). `until`: when it lapses. `firstTime`: the first ChatGPT seat's card says
 * once to turn on device code sign-in in ChatGPT's security settings. Answered by startSeatSignIn, never kept or logged.
 */
export interface SeatSignInCard {
  attempt: string;
  seat: string;
  kind: "device-code" | "paste-code";
  url: string;
  /** The code to enter on the vendor's page (device-code alone). */
  code?: string;
  until: number;
  firstTime?: boolean;
}

/**
 * Where each vendor's own sign-in is: a sign-in's card shows only an address there, over https, so a VM can never put
 * another site in front of you as its vendor's page. (Codex's device page is OpenAI's own; Claude Code's sign-in is on
 * claude.ai, or Anthropic's console for a key; Antigravity's is Google's own accounts page, whose sign-in then shows its
 * code on antigravity.google, a page the card never shows.)
 */
export const SIGN_IN_HOSTS: Readonly<Record<"claude-subscription" | "chatgpt-codex" | "google-antigravity", readonly string[]>> = {
  "claude-subscription": ["claude.ai", "claude.com", "platform.claude.com", "console.anthropic.com"],
  "chatgpt-codex": ["auth.openai.com", "chatgpt.com"],
  "google-antigravity": ["accounts.google.com"],
};

/** Whether an address a seat's tool showed is its vendor's sign-in page: https, on one of its hosts, nothing else in it. */
export function signInUrlOk(kind: SeatKind, url: string): boolean {
  if (kind !== "claude-subscription" && kind !== "chatgpt-codex" && kind !== "google-antigravity") return false;
  if (url.length > 4_096 || /[\s<>"'`]/.test(url)) return false;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  return parsed.protocol === "https:" && !parsed.username && !parsed.password && !parsed.port && SIGN_IN_HOSTS[kind].includes(parsed.hostname);
}

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
    method: SignInMethodWord.optional(),
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
  /** The agents it serves, as you chose them (seat.serves), each as that agent: none until you choose one. */
  serves: SeatAgent[];
}

/**
 * A seat of a kind this release doesn't know (readSeatKind), as the log holds it: a later release's, kept, shown as "a
 * kind this version doesn't know", and used for nothing here: never chosen for work, signed in, set or given agents.
 */
export interface UnknownSeat {
  id: string;
  /** The word its seat.added said (SeatKindWord). */
  kind: string;
  label: string;
  /** The node that holds its home, whose release knows it. */
  node: string;
  addedAt: number;
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
  /** The agents it serves, each as that agent: which of them are on a roster now is servedBy's to say. */
  serves: SeatAgent[];
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
    serves: seat.serves,
  };
}


/** How far back a seat's use is counted: a week, a plan's longest window. */
export const SEAT_USE_DAYS = 7;

/**
 * What a seat's plan did lately for the agents of the node that holds it, as their tasks recorded it (I15 step 10): over
 * the last SEAT_USE_DAYS (since `since`), the tasks whose coding tool ran on it and the tokens they spent there (on its
 * own sign-in); and its runs now.
 */
export interface SeatUse {
  since: number;
  tasks: number;
  tokens: number;
  running: number;
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
    case "google-antigravity":
      return "google";
    default:
      return seat.provider ?? "unknown";
  }
}

/** Runs at once a seat takes: its own setting, and for a subscription never more than has been shown safe (D4). */
export function seatRuns(seat: { kind: SeatKind; runs: number }): number {
  const limit = seat.kind === "chatgpt-codex" ? 1 : SUBSCRIPTION_KINDS.includes(seat.kind) ? SHARED_RUNS_PROVEN : SEAT_LIMITS.runs;
  return Math.max(1, Math.min(seat.runs, limit));
}


/** When a window ends: its reset, or with none said, SEAT_LIMITS.restMinutes after it was said (the shortest plan window). */
const windowEnds = (window: SeatFacts["windows"][number]): number => window.resetsAt ?? window.at + SEAT_LIMITS.restMinutes * 60_000;

/**
 * How much of a seat's plan is used now: its most used window that is still open (one past its end is fresh again, and
 * one its tool refused is used whole), and when that one resets; of the equally used, the soonest to reset.
 */
export function seatHeadroom(seat: Pick<SeatView, "windows">, now: number): { used: number; resetsAt: number | null } {
  let used = 0;
  let resetsAt: number | null = null;
  for (const window of seat.windows) {
    if (windowEnds(window) <= now) continue;
    const share = window.status === "rejected" ? 100 : (window.usedPercent ?? 0);
    if (share > used || (share === used && window.resetsAt !== null && (resetsAt === null || window.resetsAt < resetsAt))) {
      used = share;
      resetsAt = window.resetsAt;
    }
  }
  return { used, resetsAt };
}

/**
 * The seat a run of `harness` takes now (I15 step 9: Invincible chooses, and nothing asks the owner), or null when none
 * can. Of the seats that serve its `agent` as that agent (never another agent's, nor a later agent given its handle),
 * whose own plan runs that harness, ready (not signed out, signing in or resting), with a run to spare (`busy` below its
 * runs), with some of their plan left, and that the work may go on on (mayCarryOn from the seat it ran on, if it ran on
 * one: never a second subscription seat of that vendor's): the most headroom first (the share its most used open window
 * has used), then, of the equally used, the soonest reset (what would expire unused goes first), then its id. `pinned`:
 * that seat or none (a project's pin keeps its work off another account). The same seats at the same time always give
 * the same choice, whatever their order.
 */
export function chooseSeat(
  harness: string,
  seats: readonly SeatView[],
  busy: (seat: string) => number,
  now: number,
  opts: { agent: SeatAgent; pinned?: string | null; from?: Pick<SeatView, "id" | "kind" | "provider"> | null },
): SeatView | null {
  const able = seats.filter((seat) => seatServes(seat, opts.agent) && SEAT_HARNESS[seat.kind] === harness && seat.state.is === "ready" && busy(seat.id) < seat.runs && seatHeadroom(seat, now).used < 100 && (!opts.from || mayCarryOn(opts.from, seat)));
  if (opts.pinned) return able.find((seat) => seat.id === opts.pinned) ?? null;
  const later = (at: number | null) => (at === null ? Number.MAX_SAFE_INTEGER : at);
  const ranked = able
    .map((seat) => ({ seat, room: seatHeadroom(seat, now) }))
    .sort((a, b) => a.room.used - b.room.used || later(a.room.resetsAt) - later(b.room.resetsAt) || (a.seat.id < b.seat.id ? -1 : a.seat.id > b.seat.id ? 1 : 0));
  return ranked[0]?.seat ?? null;
}

/**
 * When a seat whose plan is spent now is open again: every window of its that is used whole has ended, and its rest is
 * over. Null: it isn't spent now.
 */
export function seatOpensAt(seat: Pick<SeatView, "windows" | "state">, now: number): number | null {
  let at: number | null = seat.state.is === "resting" && seat.state.until > now ? seat.state.until : null;
  for (const window of seat.windows) {
    const ends = windowEnds(window);
    if (ends <= now || (window.status !== "rejected" && (window.usedPercent ?? 0) < 100)) continue;
    at = Math.max(at ?? 0, ends);
  }
  return at;
}

/** The seat kind whose plan a harness's own sign-in is (an agent's VM signed in by hand is one account of its vendor's). */
export function seatKindOf(harness: string): SeatKind | null {
  for (const kind of SEAT_KINDS) if (SEAT_HARNESS[kind] === harness) return kind;
  return null;
}

/**
 * The account a task's work ran on (I15 step 9), kept with the task so that work taken up again goes on on it alone (the
 * rule): a seat of yours, or (`seat` null) its tool's own sign-in in its agent's VM, an account of `kind`'s vendor.
 */
export const TaskAccount = z.strictObject({ seat: SeatId.nullable(), kind: SeatKind });
export type TaskAccount = z.infer<typeof TaskAccount>;

/** A task's account as the seat it would go on from (chooseSeat's `from`): its own VM's sign-in is an account no seat is. */
export const accountSeat = (account: TaskAccount): { id: string; kind: SeatKind; provider: null } => ({ id: account.seat ?? "own", kind: account.kind, provider: null });

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
