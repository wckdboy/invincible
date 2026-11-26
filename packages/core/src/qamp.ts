import { z } from "zod";
import type { Scope } from "./scopes.ts";

/*
 * Q-AMP grants (PLAN #58, its first phase): an agent on another of your machines calls a few of Galahad's tools on a
 * node over Q-AMP (QUIC), under a grant you made. A grant is bound to the agent's own key, ends by itself, and can be
 * revoked. The node keeps each one as three things: an arm of its own (`qamp.<id>`, checked at the node's door on every
 * call), a delegation chain from the node's bridge key to the agent's key, and a bridge (`qamp serve --mcp-stdio`) that
 * lets that key alone connect and serves the granted tools alone. These are the parts every surface shares.
 */

/** The tools a grant may hold: read-only, none of your memories, nothing that writes (your word, 25 November 2026). */
export const QAMP_TOOLS = ["fleet", "compute", "place", "ledger"] as const;
export type QampTool = (typeof QAMP_TOOLS)[number];

/** Why any other tool is refused, by name. */
export const QAMP_TOOLS_ALLOWED = "fleet, compute, place and ledger are the tools you have allowed so far";

/** How long a grant lasts, in seconds: an hour unless you say otherwise, a day at most. Longer is refused, never cut short. */
export const QAMP_TTL = { min: 60, default: 3600, max: 86_400 } as const;

/** The UDP ports a node's bridges listen on, one a grant: what the tailnet firewall rule opens (deploy.sh --open-qamp). */
export const QAMP_PORTS = { first: 7781, last: 7789 } as const;

/** What an agent's grant is named by: its arm is `qamp.<id>`. */
export const QampGrantId = z.string().regex(/^[0-9a-f]{10}$/, "a grant's id: 10 hex digits (galahad qamp grants lists them)");

/** A grant's arm, by its id. The prefix is reserved: no agent installed by hand may take it. */
export const qampArm = (id: string): string => `qamp.${id}`;
export const QAMP_ARM_PREFIX = "qamp.";

const BASE58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

/** base58btc (Bitcoin's alphabet) to bytes; null when a character isn't in it. */
function base58btc(text: string): Uint8Array | null {
  const little: number[] = [];
  for (const ch of text) {
    let carry = BASE58.indexOf(ch);
    if (carry < 0) return null;
    for (let i = 0; i < little.length; i++) {
      carry += little[i]! * 58;
      little[i] = carry & 0xff;
      carry >>= 8;
    }
    while (carry > 0) {
      little.push(carry & 0xff);
      carry >>= 8;
    }
  }
  for (let i = 0; i < text.length && text[i] === "1"; i++) little.push(0);
  return Uint8Array.from(little.reverse());
}

/**
 * The Ed25519 public key a `did:key` names, or null when it names none: `z` (base58btc), then the multicodec prefix
 * for Ed25519 (0xed 0x01) and 32 bytes. Q-AMP 0.1 accepts Ed25519 keys alone (its SPEC §2.2).
 */
export function ed25519OfDidKey(did: string): Uint8Array | null {
  if (!/^did:key:z6Mk[1-9A-HJ-NP-Za-km-z]{44}$/.test(did)) return null;
  const bytes = base58btc(did.slice("did:key:z".length));
  if (!bytes || bytes.length !== 34 || bytes[0] !== 0xed || bytes[1] !== 0x01) return null;
  return bytes.slice(2);
}

/** An agent's key, as Q-AMP names it. */
export const QampDid = z
  .string()
  .max(64)
  .refine((did) => ed25519OfDidKey(did) !== null, "an agent's key as Q-AMP names it: did:key:z6Mk… (an Ed25519 key: `qamp keygen` prints it, `qamp id --key <file>` again)");

export const QampToolName = z.enum(QAMP_TOOLS, { error: (issue) => `${JSON.stringify(issue.input)} can't be granted: ${QAMP_TOOLS_ALLOWED}` });

export const QampGrantInput = z.strictObject({
  /** The agent's key: the one its bridge lets in, and its chain is bound to. */
  agent: QampDid,
  /** What it may call, each once. */
  tools: z
    .array(QampToolName)
    .min(1, `name the tools it may call: ${QAMP_TOOLS_ALLOWED}`)
    .max(QAMP_TOOLS.length)
    .refine((tools) => new Set(tools).size === tools.length, "each tool once"),
  /** For how long, in seconds. */
  ttlSeconds: z
    .number()
    .int()
    .min(QAMP_TTL.min, "a grant lasts a minute at least")
    .max(QAMP_TTL.max, "a grant lasts 24 hours at most: grant again when it ends")
    .default(QAMP_TTL.default),
});
export type QampGrantInput = z.input<typeof QampGrantInput>;

/** One grant ended, or every one. */
export const QampRevokeInput = z.union([z.strictObject({ id: QampGrantId }), z.strictObject({ all: z.literal(true) })]);

export interface QampGrantView {
  id: string;
  /** Its arm: what the node's door checks on every call the agent makes. */
  label: string;
  /** The agent's key: the only one its bridge lets connect, and the one its chain is bound to. */
  agent: string;
  tools: QampTool[];
  /** What its arm holds: the scopes its tools' routes need, nothing more. */
  scopes: Scope[];
  createdAt: number;
  /** When it ends by itself: its bridge stops and its arm is deleted. */
  endsAt: number;
  /** Where the agent reaches it: qamp://<the bridge's key>@<this node's tailnet address>:<port>. */
  url: string;
  /** Its bridge: serving, starting, or down and why (it is started again until the grant ends). */
  bridge: { state: "up" | "starting" | "down"; why: string | null };
}

/** A grant just made: it, and its chain (`qdt1.…`), said this once for the agent's machine. */
export interface QampGrantMade {
  grant: QampGrantView;
  proof: string;
}
