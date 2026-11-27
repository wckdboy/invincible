import { z } from "zod";
import { canonical, type Json } from "./canonical.ts";
import { b64u, fromB64u } from "./bytes.ts";
import { sha256B64u } from "./crypto.ts";
import { decodeHlc, isHlc } from "./hlc.ts";
import { type DeviceId, domain, isNodeId, type NodeIdentity, verifyDeviceSignature } from "./identity.ts";
import { ProjectId } from "./chats.ts";
import { Conclusion, InvestigationId, InvestigationStatus, PredictionOutcome } from "./investigations.ts";
import { OrderId, OrderTerms } from "./orders.ts";
import { RuleName } from "./rules.ts";
import { Scope } from "./scopes.ts";
import { SkillId, SkillVersionId } from "./skills-input.ts";
import { EvalId, EvalRecord, EvalRunId } from "./evals.ts";
import { SEAT_LIMITS, SeatId, SeatKind, SeatSignInBody, SeatWindowBody, SeatWindowName } from "./seats.ts";
import { WORD_NONCE } from "./words.ts";

/** How hard a model thinks for an answer (Anthropic's `effort`; other providers' models choose for themselves). */
export const THINKING_EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;
export type ThinkingEffort = (typeof THINKING_EFFORTS)[number];

/*
 * The mind is an append-only log of these events. Each event is content-addressed
 * (id = sha256 of its canonical unsigned form) and signed by the node that wrote it,
 * so applying it twice is a no-op and nobody can alter it in transit.
 */

const B64 = z.string().regex(/^[A-Za-z0-9_-]+$/).max(8192);
const Name = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9._:-]+$/, "letters, digits and . _ : - only");
const DeviceRef = z.string().regex(/^[nc]_[A-Za-z0-9_-]{43,87}$/);
const SealedBoxSchema = z.strictObject({ eph: B64, nonce: B64, ct: B64 });

export const Trust = z.enum(["owner", "agent", "untrusted"]);
export type Trust = z.infer<typeof Trust>;

/** Provenance: who caused this event and how much to trust its content. */
export const Prov = z.strictObject({
  via: DeviceRef.optional(),
  trust: Trust,
  source: z.string().max(2048).optional(),
});
export type Prov = z.infer<typeof Prov>;

export const SecretMeta = z.strictObject({
  provider: Name.optional(),
  hint: z.string().max(16).optional(),
  label: z.string().max(128).optional(),
  /** The only origin this key is ever sent to; set when you enter it. A repointed provider gets nothing. */
  origin: z
    .string()
    .max(256)
    .regex(/^https?:\/\/[^/?#]+$/)
    .optional(),
});

/** Loop names double as arm labels (`loop.<name>`), so they are lowercase. */
export const LoopName = z.string().regex(/^[a-z0-9][a-z0-9._-]{0,39}$/, "lowercase letters, digits, . _ - (max 40)");
export const ConnectorId = z.string().regex(/^[a-z][a-z0-9-]{0,39}$/, "lowercase letters, digits and - (max 40)");
export const NoticeKey = z.string().min(1).max(160).regex(/^[A-Za-z0-9._:-]+$/);
export const ActionId = z.string().regex(/^a_[A-Za-z0-9_-]{22}$/);
/** A session on a Mac's own screen that the primary asked for (docs/MAC.md, M4). */
export const ScreenSessionId = z.string().regex(/^sc_[A-Za-z0-9_-]{22}$/);
/** The longest a session on a Mac's own screen is allowed for at once, in minutes. */
export const SCREEN_SESSION_MAX_MINUTES = 120;
export const ArtifactId = z.string().regex(/^art_[A-Za-z0-9_-]{22}$/);
export const ArtifactFile = z.strictObject({
  path: z.string().min(1).max(512),
  size: z.number().int().min(0),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
});
export const LoopStatus = z.enum(["ok", "attention", "failed", "interrupted"]);
export const NoticeSeverity = z.enum(["info", "warn", "alert"]);
/**
 * Open-ended objects (a loop's task, a connector's manifest, a call's arguments)
 * stay loosely typed in the log, so what a newer node adds never makes an older
 * one refuse the event. The API and the runner validate them strictly.
 */
const Open = z.record(z.string(), z.unknown());

/** The log's limits on a ledger line's words (ledger.recorded): a longer one is clipped to them (fitLedger), never refused. */
export const LEDGER_LIMITS = { target: 256, reason: 500, detail: 2000 } as const;

/**
 * A ledger line within the log's limits: each of its words cut to its limit, with an ellipsis, so no line is refused for
 * its length and left unrecorded (the re-review of 27 November, A4). What it is and whose run it is stay as given: an
 * identifier cut short would be another's.
 */
export function fitLedger<T extends { target: string; reason?: string; detail?: string }>(line: T): T {
  const cut = (text: string, max: number): string => {
    if (text.length <= max) return text;
    const head = text.slice(0, max - 1);
    return `${/[\uD800-\uDBFF]$/.test(head) ? head.slice(0, -1) : head}…`;
  };
  return {
    ...line,
    target: cut(line.target, LEDGER_LIMITS.target),
    ...(line.reason !== undefined ? { reason: cut(line.reason, LEDGER_LIMITS.reason) } : {}),
    ...(line.detail !== undefined ? { detail: cut(line.detail, LEDGER_LIMITS.detail) } : {}),
  };
}

export const Bodies = {
  "fleet.genesis": z.strictObject({ name: z.string().min(1).max(64), created: z.number().int() }),
  "device.enrolled": z.strictObject({
    device: DeviceRef,
    name: z.string().min(1).max(64),
    kind: z.enum(["node", "client"]),
    role: z.enum(["full", "limited", "client"]),
    box: B64.optional(),
    scopes: z.array(Scope).max(32),
  }),
  "device.revoked": z.strictObject({
    device: DeviceRef,
    reason: z.string().max(500),
    /** The revoked device's chain head as the revoker saw it: nothing after it ever counts. */
    head: z
      .string()
      .regex(/^[A-Za-z0-9_-]{43}$/)
      .nullable()
      .optional(),
  }),
  /** Change what a paired client may do (full nodes are always owner-equivalent). */
  "device.scoped": z.strictObject({ device: DeviceRef, scopes: z.array(Scope).max(32) }),
  /** A legacy (v1) fleet adopts chains: exactly these unchained events stay valid, no others ever. */
  "fleet.chained": z.strictObject({ legacy: z.array(z.string().regex(/^[A-Za-z0-9_-]{43}$/)).max(1400) }),
  "vault.key": z.strictObject({ kid: B64, grants: z.record(z.string(), SealedBoxSchema) }),
  "vault.grant": z.strictObject({ kid: B64, device: DeviceRef, box: SealedBoxSchema }),
  "secret.set": z.strictObject({ name: Name, kid: B64, nonce: B64, ct: B64, meta: SecretMeta }),
  "secret.deleted": z.strictObject({ name: Name }),
  /** The primary asks you for a credential; you fill it in the vault, it never sees it. */
  "secret.requested": z.strictObject({
    name: Name,
    provider: Name.optional(),
    purpose: z.string().min(1).max(500),
  }),
  /** You dismissed a request (it no longer matters, or you won't give it): it leaves your Inbox until it asks again. */
  "secret.request.dismissed": z.strictObject({ name: Name }),
  "memory.added": z.strictObject({
    text: z.string().min(1).max(20_000),
    tags: z.array(z.string().min(1).max(64)).max(32).optional(),
  }),
  "memory.forgotten": z.strictObject({ memory: B64 }),
  "node.profile": z.strictObject({
    endpoint: z.string().url().max(512).optional(),
    caps: z.record(z.string(), z.unknown()),
  }),
  "provider.set": z.strictObject({
    id: Name,
    kind: z.enum(["openai", "anthropic"]),
    baseUrl: z.string().url().max(512),
    secret: Name.optional(),
    label: z.string().max(128).optional(),
  }),
  "provider.removed": z.strictObject({ id: Name }),
  /** The ledger: every gated action, its verdict and why. Signed and replicated like everything else. */
  "ledger.recorded": z.strictObject({
    class: z.enum(["read", "create", "modify", "outward", "delete", "forbidden"]),
    resource: z.string().min(1).max(64),
    target: z.string().min(1).max(LEDGER_LIMITS.target),
    verdict: z.enum(["allow", "ask", "deny", "approved"]),
    reason: z.string().max(LEDGER_LIMITS.reason).optional(),
    run: z.string().max(64).optional(),
    detail: z.string().max(LEDGER_LIMITS.detail).optional(),
  }),
  "roster.set": z.strictObject({ role: Name, models: z.array(z.string().min(1).max(256)).max(16) }),
  /**
   * How hard a role's models think (LWW by role): `auto`, by what each step of the work needs (brain roster.ts
   * STEP_EFFORT), or one level you chose, whatever the step. A kind of its own, so a node from before it keeps it unread.
   */
  "roster.effort": z.strictObject({ role: Name, effort: z.enum(["auto", ...THINKING_EFFORTS]) }),
  /** A loop: work the primary does on a schedule, on one named node (LWW by name). */
  "loop.set": z.strictObject({
    name: LoopName,
    schedule: z.string().min(1).max(128),
    tz: z.string().max(64).optional(),
    /** The one node that runs it, so a loop never runs twice. */
    on: DeviceRef,
    enabled: z.boolean(),
    task: Open,
    label: z.string().max(128).optional(),
  }),
  "loop.removed": z.strictObject({ name: LoopName }),
  /**
   * What else wakes a loop, besides its schedule: all of it, replacing what was (an empty list: none). Its own kind, so
   * a node from before it keeps every loop it had; each wake stays loosely typed, like a task, for the same reason.
   */
  "loop.wakes": z.strictObject({ name: LoopName, wakes: z.array(Open).max(8), cooldownMs: z.number().int().min(0).max(7 * 24 * 3600_000) }),
  /** One run of a loop, recorded by the node that ran it. `slot` is the scheduled time (null when run by hand). */
  "loop.ran": z.strictObject({
    loop: LoopName,
    run: z.string().min(1).max(64),
    slot: z.number().int().nullable(),
    status: LoopStatus,
    started: z.number().int(),
    finished: z.number().int(),
    summary: z.string().max(2000),
  }),
  /** Something that needs your attention (LWW by key); the heartbeat raises and clears these. */
  "notice.raised": z.strictObject({
    key: NoticeKey,
    severity: NoticeSeverity,
    title: z.string().min(1).max(200),
    body: z.string().max(2000),
    source: z.string().min(1).max(64),
    /** The node whose body it concerns, when it is about one node (its disk, its vault). */
    node: DeviceRef.optional(),
    at: z.number().int(),
  }),
  "notice.cleared": z.strictObject({ key: NoticeKey }),
  /** You've seen it: it stays quiet until it changes. */
  "notice.dismissed": z.strictObject({ key: NoticeKey }),
  "connector.set": z.strictObject({ id: ConnectorId, manifest: Open }),
  "connector.removed": z.strictObject({ id: ConnectorId }),
  /** A project: a workspace every node knows (LWW by id). Its instructions steer the primary, so only you set them. */
  "project.set": z.strictObject({ id: ProjectId, name: z.string().min(1).max(80), instructions: z.string().max(8000), repo: z.string().url().max(300).optional() }),
  "project.removed": z.strictObject({ id: ProjectId }),
  /** The outbox: an action the policy says to ask about, recorded before anything is sent. */
  "action.requested": z.strictObject({
    id: ActionId,
    connector: ConnectorId,
    tool: z.string().min(1).max(48),
    args: Open,
    class: z.enum(["read", "create", "modify", "outward", "delete"]),
    target: z.string().min(1).max(256),
    /** Who asked: an arm, a loop or a run. */
    by: z.string().min(1).max(100),
    why: z.string().max(500).optional(),
    expires: z.number().int(),
  }),
  /** Your answer. The first decision stands; no answer before it expires means no. */
  "action.decided": z.strictObject({ id: ActionId, verdict: z.enum(["approved", "denied"]), note: z.string().max(500).optional() }),
  /** The receipt, written once by the node that asked, after it sent the request exactly once. */
  "action.done": z.strictObject({ id: ActionId, ok: z.boolean(), status: z.number().int().optional(), receipt: z.string().max(2000) }),

  /**
   * The primary asks to use a Mac's own screen and shell (docs/MAC.md, M4): which Mac (`node`), what for, for how many
   * minutes. Filed by a full node; nothing is its until you allow it.
   */
  "screen.asked": z.strictObject({ id: ScreenSessionId, node: DeviceRef, why: z.string().min(1).max(500), minutes: z.number().int().min(1).max(SCREEN_SESSION_MAX_MINUTES) }),
  /** Your answer, your word alone: allowed (for its minutes, from this answer) or not. The first answer stands. */
  "screen.decided": z.strictObject({ id: ScreenSessionId, verdict: z.enum(["allowed", "denied"]) }),
  /** A session over before its time: ended by you, or by it once it's done. Once. */
  "screen.ended": z.strictObject({ id: ScreenSessionId }),
  /** A standing order: your answer in advance to calls that match it (see orders.ts). Immutable: revoke and sign anew. */
  "order.set": OrderTerms.extend({ id: OrderId }),
  "order.revoked": z.strictObject({ id: OrderId }),
  /** The node that filed an action records which order answered it; every replica checks the order covers it. */
  "order.applied": z.strictObject({ order: OrderId, action: ActionId }),
  /**
   * Work products kept from a sandbox (its /work/out): the files stay on the node that saved them
   * (the signer); the log records what they are, so any device can see and fetch them.
   */
  "artifact.saved": z.strictObject({
    id: ArtifactId,
    label: z.string().min(1).max(200),
    run: z.string().max(64).optional(),
    sandbox: z.string().regex(/^[0-9a-f]{10}$/).optional(),
    bytes: z.number().int().min(0),
    count: z.number().int().min(0),
    /** As many as fit; the holding node keeps the full manifest. */
    files: z.array(ArtifactFile).max(200),
  }),
  /** Recorded by the node that held the files, once they're gone. */
  "artifact.removed": z.strictObject({ id: ArtifactId }),
  /**
   * A pre-registered investigation: recorded before anything runs and never changed.
   * `registration` is open in the log (newer nodes may add fields); `digest` pins it.
   */
  "investigation.registered": z.strictObject({
    id: InvestigationId,
    question: z.string().min(1).max(2000),
    registration: Open,
    digest: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  }),
  /** How it ended, recorded once by the node that registered it. */
  "investigation.concluded": z.strictObject({
    id: InvestigationId,
    status: InvestigationStatus,
    conclusion: Conclusion.optional(),
    summary: z.string().max(4000),
    review: z.string().max(4000).optional(),
    artifact: ArtifactId.optional(),
    predictions: z.array(PredictionOutcome).max(16).optional(),
  }),
  /** An eval's score, recorded once by the node that ran it; every replica checks it follows from the numbers (evals.ts). */
  "eval.scored": EvalRecord.extend({ id: EvalId }),
  /**
   * An eval run's settings (its effort: attempts per eval), recorded once when it starts by the node that
   * runs it; the first stands. Open in the log (evals.ts EvalRunSettings): the Index per effort reads it.
   */
  "eval.run": z.strictObject({ run: EvalRunId, suite: z.string().regex(/^[a-z0-9][a-z0-9-]{0,59}$/), settings: Open }),
  /**
   * A node's own measurement of itself (compute.ts Calibration): the signer is the node measured, and its
   * latest stands. Open in the log, so a newer node that measures more never makes an older one refuse it.
   */
  "compute.calibrated": z.strictObject({ measured: Open }),
  /** The owner's ceiling for one node (compute.ts ComputeLimit; the latest stands; empty: the defaults again). */
  "compute.limit": z.strictObject({ node: DeviceRef, limit: Open }),
  /** How it spends compute on a run: the level auto may reach and the day's budget of extra attempts (compute.ts ComputePolicy). */
  "compute.policy": z.strictObject({ policy: Open }),
  /** Its defaults, re-derived when the fleet's compute changed (compute.ts ComputePlan), and what changed, a line each. */
  "compute.adapted": z.strictObject({
    at: z.number().int(),
    digest: z.string().regex(/^[A-Za-z0-9_-]{22}$/),
    plan: Open,
    changes: z.array(z.string().max(400)).max(24),
  }),
  /*
   * Skills (skills.ts): how it did a kind of work, as words it reads. Every replica applies the same rules
   * on replay (who may revise what, what a lock holds), so no node can record a change they don't allow.
   */
  /**
   * A version of a skill: the first makes the skill, a later one revises it. Its words are open in the log
   * (a field a newer node adds never makes an older one refuse it); its trust is the event's `prov`.
   * `by`: owner, primary, or arm:<label>. `run`: the run it was distilled from.
   */
  "skill.written": z.strictObject({ skill: SkillId, doc: Open, by: z.string().min(1).max(100), run: z.string().max(64).optional() }),
  /** You approved exactly this version: an untrusted one is given to a model only after that. The first approval stands. */
  "skill.approved": z.strictObject({ skill: SkillId, version: SkillVersionId }),
  /** A mark on a skill, the latest standing (locked, retired: yours; stale: the tidy-up's). A mark this node doesn't know is kept and ignored. */
  "skill.marked": z.strictObject({ skill: SkillId, mark: z.string().regex(/^[a-z][a-z-]{0,31}$/), on: z.boolean() }),
  /** One step back: the version before `from` is the skill's head again (`from` must be the head, so a rollback never undoes what you didn't see). */
  "skill.reverted": z.strictObject({ skill: SkillId, from: SkillVersionId }),
  /** A skill was given to a run's planner (or, `chat:…`, to an answer): counted once per run. */
  "skill.used": z.strictObject({ skill: SkillId, version: SkillVersionId, run: z.string().min(1).max(100) }),
  /** How the run that used it ended (done: its review passed). The first word stands. */
  "skill.outcome": z.strictObject({ skill: SkillId, run: z.string().min(1).max(100), status: z.string().regex(/^[a-z][a-z-]{0,31}$/) }),
  /*
   * What model calls cost (usage.ts, spend.ts). Per-call counts stay on the node that made the call (its own
   * usage table, never the log); only what every replica must agree on is here: your prices, and what an eval
   * spent, because the Index per token and per dollar is computed from it everywhere.
   */
  /** Your price for a model, US dollars per million tokens (usage.ts PriceSchema; LWW by model). Open in the log, read leniently. */
  "price.set": z.strictObject({ model: z.string().min(3).max(256), price: Open }),
  "price.removed": z.strictObject({ model: z.string().min(3).max(256) }),
  /**
   * What a model was seen to do when it was checked (model-checks.ts: the run loop's format, reading a screen,
   * placing a click), so every node chooses by the same evidence. LWW by model; open in the log, read leniently.
   */
  "model.checked": z.strictObject({ model: z.string().min(3).max(256), check: Open }),
  /**
   * What an eval's model calls came to, by role and model (usage.ts EvalSpent): counts as the providers reported
   * them, never a prompt or an answer. Recorded once, by the node that recorded the eval; the first stands.
   */
  "eval.spent": z.strictObject({ evalCase: EvalId, spent: Open }),
  /*
   * Your rules (rules.ts): tripwires on the commands its work runs. Yours alone: every replica refuses one that isn't
   * your word (its prov's trust) or wasn't written by a full node. The last writer wins, by name.
   */
  /** A rule, set or replaced. Open in the log: a newer node's rule never makes this one refuse the event (core's readRule reads it). */
  "rule.set": z.strictObject({ name: RuleName, rule: Open }),
  "rule.removed": z.strictObject({ name: RuleName }),

  /*
   * Seats (seats.ts): accounts you hold with a vendor, each serving the agents you chose. Added, set and removed by you
   * alone; how each stands (its sign-in, its windows, a rest until a reset) is said by the node that holds its home, and
   * by no other.
   * None carries a sign-in's address, its code or a token, and a seat's email is in the vault. The last writer wins.
   * (Checked here only by length and alphabet, as every body is: the routes refuse anything shaped like a token, and a
   * newer scanner must never make a replica refuse an event an older one took.)
   */
  "seat.added": z.strictObject({
    id: SeatId,
    kind: SeatKind,
    label: z.string().min(1).max(SEAT_LIMITS.label),
    node: DeviceRef,
    provider: Name.optional(),
    runs: z.number().int().min(1).max(SEAT_LIMITS.runs),
  }),
  "seat.policy": z.strictObject({ id: SeatId, runs: z.number().int().min(1).max(SEAT_LIMITS.runs) }),
  /**
   * The agents a seat serves, as you chose them: each as that agent, its handle and when its node's team made it (a
   * later agent given the handle is another). None: it serves none. Only a seat with a home of its own serves agents.
   */
  "seat.serves": z.strictObject({
    id: SeatId,
    agents: z.array(z.strictObject({ id: z.string().regex(/^[a-z][a-z0-9-]{0,31}$/), made: z.number().int().min(0) })).max(SEAT_LIMITS.serves),
  }),
  "seat.removed": z.strictObject({ id: SeatId }),
  /** A sign-in begun, or ended (by a sign-in, or as its node found it when it asked the tool). */
  "seat.signin": SeatSignInBody,
  /** A window, as the seat's tool reported it: said when its state or its reset changes, never at every call. */
  "seat.window": SeatWindowBody,
  /** Its window is spent: it rests until that resets. Back: it is in use again. */
  "seat.rested": z.strictObject({ id: SeatId, until: z.number().int().min(0), window: SeatWindowName.optional() }),
  "seat.back": z.strictObject({ id: SeatId }),

  /*
   * Your grants for hand-offs (core's fabric.ts HandoffTerms): your word that one node may hand tasks to another's
   * agents, given once for the pair. Yours alone: every replica refuses one that isn't your word, wasn't written by a
   * full node, or isn't from one node to another. The last writer wins, by pair; a revocation ends it.
   */
  /** A grant, given or replaced. Its terms are open in the log: a newer node's never make this one refuse the event (readHandoffTerms reads them). */
  "handoff.granted": z.strictObject({ from: DeviceRef, to: DeviceRef, terms: Open }),
  "handoff.revoked": z.strictObject({ from: DeviceRef, to: DeviceRef }),
  /**
   * Your word's companion (slice 8; core's words.ts): written by the node that records a word of yours just before it,
   * so the word's prev is this. It carries the statement a device of yours signed, and its P-256 signature. Applying it
   * changes nothing and refuses nothing: the word that follows is judged by it, from WORDS_SIGNED_FROM.
   */
  "word.signed": z.strictObject({
    v: z.literal(1),
    device: z.string().regex(/^c_[A-Za-z0-9_-]{87}$/),
    nonce: z.string().regex(WORD_NONCE),
    at: z.number().int().nonnegative(),
    kind: z.string().regex(/^[a-z]+(\.[a-z_]+)+$/).max(64),
    digest: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
    sig: z.string().regex(/^[A-Za-z0-9_-]{86}$/),
  }),
} as const;

export type EventKind = keyof typeof Bodies;
export type BodyOf<K extends EventKind> = z.infer<(typeof Bodies)[K]>;
export const isKnownKind = (kind: string): kind is EventKind => Object.hasOwn(Bodies, kind);

export const MAX_EVENT_BYTES = 64 * 1024;

const EventIdRef = z.string().regex(/^[A-Za-z0-9_-]{43}$/);

/*
 * v1: legacy, unchained.
 * v2: chained. `prev` is the id of the same device's previous event (null for its
 *     first). A device's events form one hash chain; revocation pins its head, so a
 *     stolen key cannot add events "in the past", and a device that forks its own
 *     chain (equivocates) is detected by every replica.
 */
export const EventEnvelope = z.strictObject({
  v: z.union([z.literal(1), z.literal(2)]),
  id: EventIdRef,
  /** Fleet id = id of the fleet.genesis event; empty only on the genesis event itself. */
  fleet: z.string().regex(/^([A-Za-z0-9_-]{43})?$/),
  hlc: z.string().refine(isHlc, "invalid hlc"),
  device: DeviceRef,
  prev: EventIdRef.nullable().optional(),
  kind: z.string().regex(/^[a-z]+(\.[a-z_]+)+$/).max(64),
  body: z.unknown(),
  prov: Prov.optional(),
  sig: B64,
});
export type GEvent = z.infer<typeof EventEnvelope> & { body: Json };
export type UnsignedEvent = Omit<GEvent, "id" | "sig">;

export const unsignedOf = (event: GEvent): UnsignedEvent => {
  const { id: _id, sig: _sig, ...rest } = event;
  return rest;
};

export const eventId = (unsigned: UnsignedEvent): string => sha256B64u(canonical(unsigned));
const signingInput = (id: string) => domain("invincible-event/v1", id);

export function signEvent(unsigned: UnsignedEvent, signer: NodeIdentity): GEvent {
  if (unsigned.device !== signer.id) throw new Error("event device must be the signer");
  const id = eventId(unsigned);
  const sig = signer.sign(signingInput(id));
  return { ...unsigned, id, sig: b64u(sig) };
}

/** Structural parse + content-address check + signature check. Throws on any failure. */
export function parseEvent(raw: unknown): GEvent {
  const event = EventEnvelope.parse(raw) as GEvent;
  if (event.v === 2 && event.prev === undefined) throw new Error("v2 events must name their predecessor (prev)");
  if (event.v === 1 && event.prev !== undefined) throw new Error("v1 events cannot be chained");
  if (canonical(event).length > MAX_EVENT_BYTES) throw new Error("event too large");
  if (!isNodeId(event.device)) throw new Error("only nodes sign log events");
  if (eventId(unsignedOf(event)) !== event.id) throw new Error("event id does not match content");
  // Held to Ed25519's strict rule from the cutoff, by the event's own HLC: the same answer on every replica (identity.ts).
  if (!verifyDeviceSignature(event.device as DeviceId, fromB64u(event.sig), signingInput(event.id), decodeHlc(event.hlc).ms)) {
    throw new Error("bad event signature");
  }
  if (isKnownKind(event.kind)) Bodies[event.kind].parse(event.body);
  return event;
}

export function bodyOf<K extends EventKind>(event: GEvent, kind: K): BodyOf<K> {
  return Bodies[kind].parse(event.body) as BodyOf<K>;
}

/** Total order used everywhere: (hlc, id). */
export const compareEvents = (a: { hlc: string; id: string }, b: { hlc: string; id: string }): number =>
  a.hlc < b.hlc ? -1 : a.hlc > b.hlc ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
