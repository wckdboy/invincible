import { z } from "zod";
import { b64u, fromB64u } from "./bytes.ts";
import { canonical } from "./canonical.ts";
import { sha256B64u, signEd25519, verifyEd25519 } from "./crypto.ts";
import { domain, isNodeId, type NodeIdentity, verifyDeviceSignature } from "./identity.ts";
import { ed25519OfDidKey, QAMP_TOOLS, QampDid } from "./qamp.ts";
import { MAX_PROPOSED_GATES, MAX_RUN_GATES } from "./runs.ts";
import type { Scope } from "./scopes.ts";
import { moneyPrices, type Prices } from "./spend.ts";
import { AgentId, type TeamHarness, TeamTaskProof } from "./team.ts";
import { TEAM_LIMITS } from "./team-limits.ts";

/*
 * The fabric (docs/ARCHITECTURE.md §3): what nodes say to each other over Q-AMP, through each node's sidecar, and what
 * they keep of it. One connection per peer, between the two nodes' own transport keys; HTTPS with signed requests where
 * Q-AMP can't be had. These are the parts every surface shares: the tools a node serves its peers, what goes in and out
 * of each, the path a node says it is on, and the proof a node signs for work it ran for another.
 */

/** How a node reaches a peer: Q-AMP through its sidecar, or HTTP with signed requests (the fallback; "https" is the API's name for it). */
export const PEER_PATHS = ["qamp", "https"] as const;
export type PeerPath = (typeof PEER_PATHS)[number];

/**
 * A node's Q-AMP endpoint, as its own signed profile says it (node.profile's `caps.qamp`): its sidecar's transport key,
 * where that key listens, and the key's own signature over the node's id (`pop`: it holds the key it names, so no node
 * can claim another's). The transport key carries calls and nothing more: each link call is signed by the node's device
 * key as its HTTPS request would be (LinkCall).
 */
export const QampEndpoint = z
  .strictObject({ did: QampDid, address: z.string().min(1).max(300), pop: z.string().regex(/^[A-Za-z0-9_-]{86}$/) })
  .refine((e) => qampAddressDid(e.address) === e.did, "the address names its own key: qamp://<did>@<host>:<port>");
export type QampEndpoint = z.infer<typeof QampEndpoint>;

/** What a node's transport key signs to say it is that node's (`caps.qamp.pop`): the node's id, under a label of its own. */
export const transportClaimInput = (node: string): Uint8Array<ArrayBuffer> => domain("invincible-qamp-key/v1", node);

/** The proof that the transport key with this seed is `node`'s, for its profile. */
export const signTransportClaim = (seed: Uint8Array, node: string): string => b64u(signEd25519(seed, transportClaimInput(node)));

/**
 * Whether plain HTTP to this host stays inside the tailnet's own encryption (WireGuard) or on this machine: a tailnet
 * address (RFC 6598's shared range, which Tailscale gives its machines, or its own IPv6 prefix), a MagicDNS name, or
 * loopback. Anywhere else, a link's
 * requests and answers would travel in clear.
 */
export function onTailnetOrLoopback(host: string): boolean {
  const bare = host.replace(/^\[(.*)\]$/, "$1").toLowerCase();
  if (bare === "localhost" || bare === "::1" || /^[a-z0-9-]+(\.[a-z0-9-]+)*\.ts\.net$/.test(bare)) return true;
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(bare);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    return a === 127 || (a === 100 && b >= 64 && b <= 127);
  }
  return /^fd7a:115c:a1e0:/.test(bare);
}

/** The key a `qamp://<did>@<host>:<port>` address names, or null when it isn't one. */
export function qampAddressDid(address: string): string | null {
  const m = /^qamp:\/\/(did:key:z[1-9A-HJ-NP-Za-km-z]{40,60})@(\[[0-9a-fA-F:.]+\]|[A-Za-z0-9.-]{1,253}):(\d{1,5})$/.exec(address);
  if (!m || Number(m[3]) < 1 || Number(m[3]) > 65_535) return null;
  return m[1]!;
}

/**
 * A node's endpoint from its profile's capabilities, when it has one that reads as one and its transport key signed
 * for that node; null otherwise (a claim on a key the node doesn't hold is no endpoint, and takes nobody's calls).
 */
export function qampEndpointOf(caps: unknown, node: string): QampEndpoint | null {
  const raw = caps && typeof caps === "object" ? (caps as { qamp?: unknown }).qamp : undefined;
  const parsed = QampEndpoint.safeParse(raw);
  if (!parsed.success) return null;
  const key = ed25519OfDidKey(parsed.data.did);
  let pop: Uint8Array;
  try {
    pop = fromB64u(parsed.data.pop);
  } catch {
    return null;
  }
  return key && pop.length === 64 && verifyEd25519(pop, transportClaimInput(node), key) ? parsed.data : null;
}

/**
 * The tools a node's host serves its peers. The link's three take an enrolled node's call alone: the sidecar proves the
 * caller's key, and the node's door maps that key to an active node of the fleet by its signed profile, or refuses.
 * A handed task's run on another node calls `agent/<tool>` with its own key's chain (FABRIC_RUN_TOOLS).
 */
export const FABRIC = {
  sync: "invincible/link/sync",
  push: "invincible/link/push",
  forward: "invincible/link/forward",
  hand: "invincible/task/hand",
  /** `invincible/agent/<tool>`: a tool of the primary's, for a run another node runs for this one. */
  agent: "invincible/agent",
} as const;

/**
 * The one scope each of the fabric's tools needs of its caller (AGENTS.md: each Q-AMP tool declares one), held by the
 * caller's principal as over HTTP (a full node holds every scope; a limited node, what it was given). A forwarded route
 * needs its own route's (every route declares one), and a run's call back, its tool's (the run's own grant).
 */
export const FABRIC_SCOPES: Readonly<Record<string, Scope>> = { [FABRIC.sync]: "mind:read", [FABRIC.push]: "mind:write", [FABRIC.hand]: "fleet:admin" };

/** The command a run's grant holds: every tool under `invincible/agent/`, held to the task by its policy. */
export const RUN_GRANT_COMMAND = `/tool/${FABRIC.agent}`;

/** The tools a run elsewhere may call back on the node that gave its task: read-only, as for an agent outside the fleet (your word, 25 November 2026). */
export const FABRIC_RUN_TOOLS = QAMP_TOOLS;
export type FabricRunTool = (typeof FABRIC_RUN_TOOLS)[number];

/** How long a run's grant lasts before it is renewed (at half of it), in seconds; it never outlives its task. */
export const RUN_GRANT_TTL = 300;

/** A grant to a run's key holds it to its own task: every call's `task` must be the hand-off's (Q-AMP SPEC 9.7). */
export const runGrantPolicy = (handoff: string): [string, string, string][] => [["==", ".task", handoff]];

/**
 * A link call, as one node sends it to another over Q-AMP (sync, push, a forwarded route, a hand-off): its path, its
 * body as the JSON text that was signed, and the signature of the sending node's device key over them, made and checked
 * exactly as its HTTPS request's would be (request-auth.ts: the time, a fresh nonce, the body's digest), with the method
 * QAMP, so a request signed for either path never passes on the other. The transport key's handshake says which
 * connection; this says which node, so a transport key alone carries nothing.
 */
export const LINK_METHOD = "QAMP";
/** The path each link tool's call is signed for (a forwarded route's is that route's own, `/api/…`). */
export const LINK_PATHS = { sync: "/link/sync", push: "/link/push", hand: "/fabric/hand" } as const;
/** A forwarded route's path, as `forward` in the server sends it. */
export const LinkForwardPath = z.string().regex(/^\/api\/[a-z0-9/-]{1,200}$/);
/** The most a link call's body may be: what one Q-AMP frame holds, with room for the rest. */
export const LINK_BODY_MAX = 15 * 1024 * 1024;
export const LinkCall = z.strictObject({
  path: z.string().regex(/^\/[a-z0-9/-]{1,200}$/),
  body: z.string().max(LINK_BODY_MAX),
  auth: z.strictObject({
    device: z.string().regex(/^n_[A-Za-z0-9_-]{43,87}$/),
    ts: z.string().regex(/^\d{1,16}$/),
    nonce: z.string().regex(/^[A-Za-z0-9_-]{8,64}$/),
    sig: z.string().regex(/^[A-Za-z0-9_-]{1,200}$/),
  }),
});
export type LinkCall = z.infer<typeof LinkCall>;

/** A hand-off's id, made by the node that hands the task on. */
export const HandId = z.string().regex(/^h_[A-Za-z0-9_-]{22}$/);
/** A run's key, as Q-AMP names it (Ed25519, made by its node for that run alone). */
const RunDid = QampDid;

const Gates = z.array(z.string().trim().min(1).max(1000)).max(MAX_RUN_GATES);

/** You, handing a task to another node's agents: what it is, where, and which of this node's tools its run may use. */
export const HandTaskInput = z.strictObject({
  /** The node, by its name or its id (a start of it will do). */
  node: z.string().min(1).max(100).regex(/^[A-Za-z0-9._:-]+$/),
  goal: z.string().trim().min(1).max(8000),
  title: z.string().trim().min(1).max(200).optional(),
  gates: Gates.optional(),
  budgetUsd: z.number().positive().max(100).optional(),
  /** One of that node's agents, by its id; absent: the one best suited takes it, as when you give work there. */
  agent: z.string().regex(/^[a-z][a-z0-9-]{0,31}$/).optional(),
  /** Which of this node's tools the run may call back; absent: none. */
  tools: z.array(z.enum(FABRIC_RUN_TOOLS)).max(FABRIC_RUN_TOOLS.length).refine((t) => new Set(t).size === t.length, "each tool once").optional(),
});
export type HandTaskInput = z.infer<typeof HandTaskInput>;

/** What the handing node sends with the call (`invincible/task/hand`'s arguments). */
export const HandArgs = z.strictObject({
  handoff: HandId,
  /** Fresh, the handing node's: the proof that comes back must carry it, so no proof of another hand-off passes for this one. */
  nonce: z.string().regex(/^[A-Za-z0-9_-]{22,64}$/),
  goal: HandTaskInput.shape.goal,
  title: z.string().trim().min(1).max(200),
  gates: Gates,
  budgetUsd: HandTaskInput.shape.budgetUsd,
  agent: HandTaskInput.shape.agent,
  tools: z.array(z.enum(FABRIC_RUN_TOOLS)).max(FABRIC_RUN_TOOLS.length),
});
export type HandArgs = z.infer<typeof HandArgs>;

/*
 * Your word that one node may hand tasks to another's agents (handoff.granted, by pair; handoff.revoked ends it): given
 * once, recorded as rules and standing orders are, so every replica holds the same and only your word counts. The node
 * that runs a hand-off takes it at once only within your grant: for an agent it names (or any, when it names none), with
 * tools it names, and a budget that fits what is left of its day. Anything else waits there for your approval, as a
 * proposal. Either way the task is recorded as the giving node's, never as yours.
 */
/**
 * A coding tool a grant may name for its hand-offs to run on (core's handoffHarness): never an ACP agent, which calls
 * the models it was set up with, which a budget can't hold it to, nor Antigravity, whose Gemini plan works on your own
 * repositories alone.
 */
export const HandoffHarness = z.enum(["opencode", "claude", "codex", "hermes"]);
export type HandoffHarness = z.infer<typeof HandoffHarness>;

export const HandoffTerms = z.strictObject({
  /** The runner's agents it may give work to, by id; absent: any of them. */
  agents: z.array(AgentId).min(1).max(32).refine((a) => new Set(a).size === a.length, "each agent once").optional(),
  /** Which of the giver's tools its runs may be given; none: none. */
  tools: z.array(z.enum(FABRIC_RUN_TOOLS)).max(FABRIC_RUN_TOOLS.length).refine((t) => new Set(t).size === t.length, "each tool once"),
  /** What its tasks there may be given to spend in a day, all together, in US dollars (each one's budget, the most it may spend). */
  budgetUsdPerDay: z.number().positive().max(1000),
  /**
   * The coding tool its tasks there run on, whatever their agent's own harness; absent: the native tools loop (the lead's
   * word, 28 November 2026). A node from before reads a grant that names one as terms it doesn't understand: no grant
   * there, so its hand-offs wait for your approval.
   */
  harness: HandoffHarness.optional(),
});
export type HandoffTerms = z.infer<typeof HandoffTerms>;

/**
 * What a hand-off runs on (the lead's word, 28 November 2026): the coding tool your grant for the pair names, else the
 * native tools loop, never its agent's own coding tool. The node's own loop asks the models itself, so each call is
 * counted as its provider said it, its cache included; its first request is about a third of OpenCode's (8.3 KB to the
 * first hand-off's 22 KB, measured offline). A plan that works only on your own repositories still refuses it
 * (ownWorkRefusal), never moved to another harness.
 */
export const handoffHarness = (terms: HandoffTerms | null): TeamHarness => terms?.harness ?? "native";

/** A grant's terms as the log holds them, read strictly: what this version doesn't understand is no grant here. */
export function readHandoffTerms(raw: unknown): HandoffTerms | null {
  const parsed = HandoffTerms.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

/** The window a grant's day is counted over: the last 24 hours. */
export const HANDOFF_DAY_MS = 86_400_000;
/** The most tasks one node may have handed to another at once, waiting for you, queued or running there, grant or not. */
export const HANDED_AT_ONCE = 8;
/** What a hand-off that names no budget is given under your grant: what your agent may give a task on its own yes ($3), or less if the day has less left. */
export const HANDOFF_DEFAULT_USD = TEAM_LIMITS.ownTaskUsd;
/** What each hand-off under your grant counts against its day at least, whatever smaller budget it asks for (and keeps). */
export const HANDOFF_MIN_USD = 0.1;

/**
 * Whether your grant takes a hand-off at once, and with what budget: the one asked for, or, when none was,
 * HANDOFF_DEFAULT_USD (or what is left of the day, if less). Each counts at least HANDOFF_MIN_USD against the day, so
 * the day bounds how many there are as well as what they spend. `given`: what the tasks this pair handed under it in
 * the last day count (handoffCounts). Otherwise why it waits for your approval.
 */
export function handoffUnder(terms: HandoffTerms | null, ask: { agent: string | null; tools: readonly string[]; budgetUsd?: number }, given: number): { budgetUsd: number } | { beyond: string } {
  if (!terms) return { beyond: "you haven't granted that node hand-offs here" };
  if (ask.agent !== null && terms.agents && !terms.agents.includes(ask.agent)) return { beyond: `your grant names ${terms.agents.join(", ")}, not ${ask.agent}` };
  const extra = ask.tools.filter((t) => !(terms.tools as readonly string[]).includes(t));
  if (extra.length) return { beyond: `your grant gives its runs ${terms.tools.join(", ") || "none of its tools"}, not ${extra.join(", ")}` };
  const left = Math.floor((terms.budgetUsdPerDay - given) * 100) / 100;
  const budgetUsd = ask.budgetUsd ?? Math.min(HANDOFF_DEFAULT_USD, left);
  if (budgetUsd <= 0 || handoffCounts(budgetUsd) > left + 1e-9) {
    const why = `it would pass your grant's $${terms.budgetUsdPerDay} a day ($${given.toFixed(2)} given in the last 24 hours)`;
    // (It would have fitted by its own amount: what decided is the least each one counts.)
    const least = budgetUsd > 0 && budgetUsd <= left + 1e-9;
    return { beyond: least ? `${why}: each hand-off counts at least $${HANDOFF_MIN_USD.toFixed(2)}` : why };
  }
  return { budgetUsd };
}

/** What a hand-off with this budget counts against its grant's day. */
export const handoffCounts = (budgetUsd: number): number => Math.max(budgetUsd, HANDOFF_MIN_USD);

/**
 * Whether a hand-off's work may run on your coding plans (the lead's word, 28 November 2026): only one handed over by a
 * node of your own, an active full node of this fleet (`giver`: its device as the log holds it, null once it isn't
 * active), whose work is yours, as your plans serve your nodes' own agents. A node with a limited part in the fleet, or
 * one revoked, never: its work's budget counts money alone (handoffPrices), so it runs on no plan.
 */
export const handoffOnPlans = (giver: { role: string } | null): boolean => giver?.role === "full";

/**
 * The prices a hand-off's budget is counted at. On your plans (handoffOnPlans): yours as you set them, a coding plan's
 * models at their list price (your price for each, as `invincible price` lists it), never $0, so the budget bounds a
 * plan's use as tightly as a key's and real money can't pass it; a plan's model you haven't priced can't be counted, so
 * the work passes it over. Otherwise money (moneyPrices), a plan's calls counting as nothing, so the work never runs on
 * one. Its work runs only on a model these count at more than $0 (`paidOnly`). What it spent stays money: a plan's
 * calls cost nothing more.
 */
export function handoffPrices(prices: Prices, plans: readonly string[], onPlans: boolean): Prices {
  return onPlans ? prices : moneyPrices(prices, plans);
}

/** You, granting one node hand-offs to another's agents (each by its name or id): its terms, given once for the pair. */
export const HandoffGrantInput = z.strictObject({
  from: HandTaskInput.shape.node,
  to: HandTaskInput.shape.node,
  agents: HandoffTerms.shape.agents,
  tools: HandoffTerms.shape.tools.optional(),
  budgetUsdPerDay: HandoffTerms.shape.budgetUsdPerDay,
  harness: HandoffTerms.shape.harness,
});
export const HandoffRevokeInput = z.strictObject({ from: HandTaskInput.shape.node, to: HandTaskInput.shape.node });

/** A grant in force, as every node shows it: the pair, its terms (null: written by a newer node, not understood here). */
export interface HandoffGrantView {
  from: { id: string; name: string };
  to: { id: string; name: string };
  terms: HandoffTerms | null;
  /** The device of yours it was given from (null: a terminal on a node), and when (ms). */
  via: string | null;
  at: number;
  /** The full node that recorded it: a grant ends when the node that recorded it is revoked. */
  by: { id: string; name: string };
}

/** What the running node streams back, as structured chunks, oldest first. */
export const HandChunk = z.discriminatedUnion("kind", [
  /** Taken: its task there, the agent that took it, and the run's key (what the handing node grants its tools to). */
  z.strictObject({ kind: z.literal("accepted"), task: z.string().regex(/^task-[a-z0-9_-]{12}$/), agent: z.strictObject({ id: z.string().max(32), name: z.string().max(64) }), run: RunDid }),
  /** Written down there, beyond your grant: it waits for your approval on that node (accepted follows once you give it). */
  z.strictObject({ kind: z.literal("proposed"), task: z.string().regex(/^task-[a-z0-9_-]{12}$/), agent: z.strictObject({ id: z.string().max(32), name: z.string().max(64) }), why: z.string().max(500) }),
  /** A line of its trail, as the runner wrote it. */
  z.strictObject({ kind: z.literal("trail"), at: z.number().int().min(0), text: z.string().max(4000) }),
  /** Its state there, when it changes. */
  z.strictObject({ kind: z.literal("state"), status: z.enum(["proposed", "queued", "running", "done", "failed", "stopped", "interrupted"]) }),
]);
export type HandChunk = z.infer<typeof HandChunk>;

/** What the handing node streams in, while the task lives: the run's chain (and each renewal of it), or a stop. */
export const HandInputChunk = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("chain"), chain: z.string().regex(/^qdt1\.[A-Za-z0-9_-]+$/).max(24_000) }),
  z.strictObject({ kind: z.literal("stop") }),
]);
export type HandInputChunk = z.infer<typeof HandInputChunk>;

/**
 * What the node that ran the work says it came to, signed by its own device key (its fleet identity, never its
 * transport key), so the proof is checked by whoever holds it, long after the connection it came on.
 */
export const ProofStatement = z.strictObject({
  v: z.literal(1),
  /** The node that ran it, and the node it ran it for (device ids). */
  by: z.string().refine(isNodeId),
  for: z.string().refine(isNodeId),
  handoff: HandId,
  nonce: HandArgs.shape.nonce,
  /** Its task on the node that ran it, and the run's key. */
  task: z.string().regex(/^task-[a-z0-9_-]{12}$/),
  run: RunDid.nullable(),
  /**
   * SHA-256 of the goal as it was handed over (base64url), and the gates it was asked for, in order: each one's exits
   * come first in `proof`; the planner's own gates, run after them, follow there unnamed.
   */
  goal: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  gates: z.array(z.string()).max(MAX_RUN_GATES + MAX_PROPOSED_GATES),
  status: z.enum(["done", "failed", "stopped", "interrupted"]),
  verified: z.boolean(),
  ended: z.enum(["done", "unverified", "gave-up", "stopped"]).nullable(),
  /** Each gate's exit before the work and in the last round, the reviewer's verdict, and whether it was the same model's. */
  proof: TeamTaskProof.nullable(),
  startedAt: z.number().int().min(0).nullable(),
  endedAt: z.number().int().min(0).nullable(),
  /** What it says beside its proof, its output and its error as it sent them (saidDigest): signed too, so neither can be swapped. */
  said: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
});
export type ProofStatement = z.infer<typeof ProofStatement>;

/** The digest of what a runner says beside its proof: its output and its error, exactly as it sent them. */
export const saidDigest = (output: string, error: string | null): string => sha256B64u(canonical({ output, error }));

export const ProofAttestation = z.strictObject({ statement: ProofStatement, sig: z.string().regex(/^[A-Za-z0-9_-]{86}$/) });
export type ProofAttestation = z.infer<typeof ProofAttestation>;

/** What is signed: the statement's canonical JSON, under a label of its own (no other signature of a node's is one). */
export const proofSigningInput = (statement: ProofStatement): Uint8Array<ArrayBuffer> => domain("invincible-proof/v1", canonical(statement));

export const goalDigest = (goal: string): string => sha256B64u(goal);

/** A proof, signed by the node that ran the work. */
export function signProof(identity: NodeIdentity, statement: ProofStatement): ProofAttestation {
  const checked = ProofStatement.parse(statement);
  if (checked.by !== identity.id) throw new Error("a node signs only the proof of work it ran");
  return { statement: checked, sig: b64u(identity.sign(proofSigningInput(checked))) };
}

/** What the node that handed the work on knows to expect, and how it asks whether a node is an active one of its fleet. */
export interface ProofExpectation {
  /** The node it handed the work to, the node it is (the one asking), and the hand-off. */
  by: string;
  for: string;
  handoff: string;
  nonce: string;
  goal: string;
  /** The gates it asked for: the proof's must begin with them, in order (the planner's may follow). */
  gates: readonly string[];
  /** Its task there and its run's key, as the runner said them when it took the work (null: never taken, a proposal declined). */
  task?: string | null;
  run?: string | null;
  /** What the runner said beside its proof, as it came: its output and its error. */
  said?: { output: unknown; error: unknown };
  /** Whether a node is active in the fleet now (revoked nodes' proofs are refused). */
  active(node: string): boolean;
}

/**
 * Whether a proof is the one it should be, and why not: signed by the node the work was handed to, with its own device
 * key, for this hand-off and its nonce, over its goal and the gates asked for. Null: it checks. A node that didn't run
 * the work can't make it look proven: its signature isn't the runner's, and the runner's for another hand-off names
 * another hand-off and nonce.
 */
export function proofRefusal(attestation: unknown, expect: ProofExpectation): string | null {
  const parsed = ProofAttestation.safeParse(attestation);
  if (!parsed.success) return "it isn't a proof";
  const { statement, sig } = parsed.data;
  if (statement.by !== expect.by) return "it is signed as another node than the one that ran the work";
  if (!expect.active(statement.by)) return "the node that signed it isn't an active node of this fleet";
  let signature: Uint8Array;
  try {
    signature = fromB64u(sig);
  } catch {
    return "its signature isn't one";
  }
  if (!verifyDeviceSignature(statement.by, signature, proofSigningInput(statement))) return "its signature doesn't check";
  if (statement.for !== expect.for) return "it is for another node";
  if (statement.handoff !== expect.handoff || statement.nonce !== expect.nonce) return "it is the proof of another hand-off";
  if (statement.goal !== goalDigest(expect.goal)) return "it is over another goal";
  if (expect.gates.some((gate, i) => statement.gates[i] !== gate)) return "its gates aren't the ones asked for";
  if (expect.task && statement.task !== expect.task) return "it names another task than the one it was taken as";
  if (expect.run && statement.run !== expect.run) return "it names another run's key than the one it was taken with";
  // Verified, only as its own facts say: done, its end done, every gate it names passing after (one exit of 0 each),
  // no review asking for more; and only as the task and run this node was told it was taken as (its `accepted`).
  const facts = statement.proof;
  if (statement.verified) {
    const gated = statement.gates.length === 0 ? facts === null || facts.after.every((exit) => exit === 0) : facts !== null && facts.after.length === statement.gates.length && facts.after.every((exit) => exit === 0);
    if (statement.status !== "done" || statement.ended !== "done" || !gated || facts?.review === "revise") return "it says verified, but its own facts don't";
    if (!expect.task || !expect.run) return "it says verified, but this node was never told the task and run it was taken as";
  }
  if (expect.said) {
    const { output, error } = expect.said;
    if (typeof output !== "string" || (error !== null && typeof error !== "string") || saidDigest(output, error) !== statement.said) return "what it said beside its proof isn't what it signed";
  }
  return null;
}

/**
 * The node's own switch for its fabric (`invincible fabric on|off`, the fabricSetting route), off by default: what it is
 * set to, and its sidecar's state and why, as they are once the switch has been applied.
 */
export const FabricSettingInput = z.strictObject({ on: z.boolean().optional() });
export interface FabricSettingView {
  on: boolean;
  state: "off" | "starting" | "up" | "down";
  why: string | null;
  did: string | null;
  address: string | null;
}

/** A task this node handed to another, as it shows it. */
export interface HandedView {
  id: string;
  /** The node it runs on, and its task there once taken. */
  node: { id: string; name: string };
  task: string | null;
  agent: { id: string; name: string } | null;
  title: string;
  goal: string;
  gates: string[];
  tools: FabricRunTool[];
  /** Here: handing it over, following it, or ended. `status`: its state there as last told. */
  phase: "handing" | "following" | "ended";
  status: string;
  /** Why it waited there for your approval, beyond your grant (null: your grant took it at once, or it hasn't been told). */
  waits: string | null;
  /** The path it went on (Q-AMP; the hand-off has no HTTPS form). */
  path: PeerPath;
  /** Its proof: checked (with its verdict's facts), refused and why, or none yet. */
  proof: { state: "checked"; verified: boolean; proof: z.infer<typeof TeamTaskProof> | null; ended: string | null } | { state: "refused"; why: string } | { state: "none" };
  output: string;
  error: string | null;
  createdAt: number;
  /** When the first line of its trail came back (ms), and when it ended. */
  firstOutputAt: number | null;
  endedAt: number | null;
  trail: { at: number; text: string }[];
}
