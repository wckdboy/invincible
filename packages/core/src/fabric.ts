import { z } from "zod";
import { b64u, fromB64u } from "./bytes.ts";
import { canonical } from "./canonical.ts";
import { sha256B64u } from "./crypto.ts";
import { domain, isNodeId, type NodeIdentity, verifyDeviceSignature } from "./identity.ts";
import { QAMP_TOOLS, QampDid } from "./qamp.ts";
import { MAX_PROPOSED_GATES, MAX_RUN_GATES } from "./runs.ts";
import { TeamTaskProof } from "./team.ts";

/*
 * The fabric (docs/ARCHITECTURE.md §3): what nodes say to each other over Q-AMP, through each node's sidecar, and what
 * they keep of it. One connection per peer, between the two nodes' own transport keys; HTTPS with signed requests where
 * Q-AMP can't be had. These are the parts every surface shares: the tools a node serves its peers, what goes in and out
 * of each, the path a node says it is on, and the proof a node signs for work it ran for another.
 */

/** How a node reaches a peer: Q-AMP through its sidecar, or HTTPS with signed requests (the fallback). */
export const PEER_PATHS = ["qamp", "https"] as const;
export type PeerPath = (typeof PEER_PATHS)[number];

/**
 * A node's Q-AMP endpoint, as its own signed profile says it (node.profile's `caps.qamp`): its sidecar's transport key
 * and where that key listens. Its device key vouches for the transport key: a call that the key's handshake proves is
 * that node's.
 */
export const QampEndpoint = z
  .strictObject({ did: QampDid, address: z.string().min(1).max(300) })
  .refine((e) => qampAddressDid(e.address) === e.did, "the address names its own key: qamp://<did>@<host>:<port>");
export type QampEndpoint = z.infer<typeof QampEndpoint>;

/** The key a `qamp://<did>@<host>:<port>` address names, or null when it isn't one. */
export function qampAddressDid(address: string): string | null {
  const m = /^qamp:\/\/(did:key:z[1-9A-HJ-NP-Za-km-z]{40,60})@(\[[0-9a-fA-F:.]+\]|[A-Za-z0-9.-]{1,253}):(\d{1,5})$/.exec(address);
  if (!m || Number(m[3]) < 1 || Number(m[3]) > 65_535) return null;
  return m[1]!;
}

/** A peer's endpoint from its profile's capabilities, when it has one that reads as one. */
export function qampEndpointOf(caps: unknown): QampEndpoint | null {
  const raw = caps && typeof caps === "object" ? (caps as { qamp?: unknown }).qamp : undefined;
  const parsed = QampEndpoint.safeParse(raw);
  return parsed.success ? parsed.data : null;
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

/** The command a run's grant holds: every tool under `invincible/agent/`, held to the task by its policy. */
export const RUN_GRANT_COMMAND = `/tool/${FABRIC.agent}`;

/** The tools a run elsewhere may call back on the node that gave its task: read-only, as for an agent outside the fleet (your word, 25 November 2026). */
export const FABRIC_RUN_TOOLS = QAMP_TOOLS;
export type FabricRunTool = (typeof FABRIC_RUN_TOOLS)[number];

/** How long a run's grant lasts before it is renewed (at half of it), in seconds; it never outlives its task. */
export const RUN_GRANT_TTL = 300;

/** A grant to a run's key holds it to its own task: every call's `task` must be the hand-off's (Q-AMP SPEC 9.7). */
export const runGrantPolicy = (handoff: string): [string, string, string][] => [["==", ".task", handoff]];

/** A request forwarded to the node that holds the sandbox (`forward` in the server): one route, as a node signed it over HTTPS. */
export const LinkForwardInput = z.strictObject({
  path: z.string().regex(/^\/api\/[a-z0-9/-]{1,200}$/),
  body: z.record(z.string(), z.unknown()),
});

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

/** What the running node streams back, as structured chunks, oldest first. */
export const HandChunk = z.discriminatedUnion("kind", [
  /** Taken: its task there, the agent that took it, and the run's key (what the handing node grants its tools to). */
  z.strictObject({ kind: z.literal("accepted"), task: z.string().regex(/^task-[a-z0-9_-]{12}$/), agent: z.strictObject({ id: z.string().max(32), name: z.string().max(64) }), run: RunDid }),
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
  /** SHA-256 of the goal as it was handed over (base64url), and its gates as they were run. */
  goal: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  gates: z.array(z.string()).max(MAX_RUN_GATES + MAX_PROPOSED_GATES),
  status: z.enum(["done", "failed", "stopped", "interrupted"]),
  verified: z.boolean(),
  ended: z.enum(["done", "unverified", "gave-up", "stopped"]).nullable(),
  /** Each gate's exit before the work and in the last round, the reviewer's verdict, and whether it was the same model's. */
  proof: TeamTaskProof.nullable(),
  startedAt: z.number().int().min(0).nullable(),
  endedAt: z.number().int().min(0).nullable(),
});
export type ProofStatement = z.infer<typeof ProofStatement>;

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
  return null;
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
