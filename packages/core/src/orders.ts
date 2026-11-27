import { z } from "zod";
import { canonical } from "./canonical.ts";
import { type ConnectorManifest, isMcpTool } from "./connectors.ts";
import { sha256B64u } from "./crypto.ts";

/*
 * Standing orders: answers you give in advance. One order names one connector
 * tool, constrains its arguments and expires. When an agent's call matches an
 * active order, the primary doesn't ask: the order is your answer, and the log records
 * which order gave it. Everything else still asks.
 *
 * Narrow by construction:
 *   - only for tools that would ask (outward, delete): the rest need no order
 *   - every path parameter (where the request goes) is named, and at least one is
 *     pinned without wildcards: an order says where, not "anywhere"
 *   - a delete is pinned exactly, with no wildcards at all: one named thing, never a family
 *   - a send of mail names every address it may send to (to, and cc where it allows one), none of them a pattern: a
 *     call that names anyone else, in to or in cc, asks
 *   - it expires, at most a year out
 *   - it is pinned to the tool as it was when you signed: if the connector's tool
 *     changes (another path, other parameters, another origin), the order no longer applies
 */

export const OrderId = z.string().regex(/^o_[A-Za-z0-9_-]{22}$/);
export const MAX_ORDER_DAYS = 365;
const DAY_MS = 24 * 60 * 60_000;

/** Exact text, with `*` standing for any run of characters. */
export const OrderPattern = z.string().min(1).max(200);

export const OrderTerms = z.strictObject({
  connector: z.string().regex(/^[a-z][a-z0-9-]{0,39}$/),
  tool: z.string().min(1).max(48),
  class: z.enum(["outward", "delete"]),
  /** Parameter → pattern. Parameters not named here may take any value. */
  args: z.record(z.string().max(40), OrderPattern),
  /** Who may use it: arm labels or loop arms (`loop.release`), patterns allowed. Omitted: any of the primary's agents. */
  callers: z.array(OrderPattern).min(1).max(16).optional(),
  /** Epoch ms. */
  until: z.number().int(),
  /** The tool's digest when you signed (see toolDigest). */
  digest: z.string().min(1).max(64),
  label: z.string().min(1).max(128),
});
export type OrderTerms = z.infer<typeof OrderTerms>;

const wild = (pattern: string) => pattern.includes("*");

/**
 * The tools that send mail (their natives): an order for one names whom it may send to. A send goes to everyone in its
 * `to` and its `cc`, so an order that left either free would send your words to anyone a planted line chose.
 */
export const MAIL_SENDS: ReadonlySet<string> = new Set(["gmail.send", "outlook.send"]);
/** A mail send's arguments that say whom it goes to, as the mail tools take them: addresses, comma-separated. */
export const RECIPIENTS = ["to", "cc"] as const;
/**
 * From when a send's order is held to its named recipients on every replica, read off the application's own clock:
 * 28 November 2026, 00:00 UTC. One applied before replays as it always did, each argument a pattern, so an old log comes
 * out the same everywhere; this node holds every application it makes now to both (sendCovered).
 */
export const SENDS_NAME_RECIPIENTS_FROM = Date.UTC(2026, 10, 28);

/** The addresses a recipients argument names, lowercased: null if any of them isn't a plain address (as mail.ts takes them). */
export function mailAddresses(list: string): string[] | null {
  const each = list.split(",").map((part) => part.trim()).filter(Boolean);
  if (!each.every((address) => /^[^\s@<>(),;:"\\[\]*]{1,64}@[A-Za-z0-9.-]{1,253}\.[A-Za-z]{2,63}$/.test(address))) return null;
  return each.map((address) => address.toLowerCase());
}

/** Whether a send's recipients, in to and in cc, are all among those its order names (and it names at least one). */
export function sendCovered(order: Pick<OrderTerms, "args">, args: Record<string, unknown>): boolean {
  const named = new Set(RECIPIENTS.flatMap((name) => (order.args[name] === undefined ? [] : (mailAddresses(order.args[name]!) ?? []))));
  if (!named.size) return false;
  let any = false;
  for (const name of RECIPIENTS) {
    const value = args[name];
    if (value === undefined || value === null || value === "") continue;
    const each = typeof value === "string" ? mailAddresses(value) : null;
    if (!each || !each.every((address) => named.has(address))) return false;
    any ||= each.length > 0;
  }
  return any;
}

export function globMatch(pattern: string, value: string): boolean {
  const source = pattern
    .split("*")
    .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
    .join("[\\s\\S]*");
  return new RegExp(`^${source}$`, "u").test(value);
}

/**
 * What an order is pinned to: the origin, base path and the tool's full definition.
 * Computed from the manifest as stored, so every replica gets the same answer.
 */
export function toolDigest(manifest: Pick<ConnectorManifest, "origin" | "basePath" | "mcp" | "tools">, tool: string): string | null {
  const definition = Object.hasOwn(manifest.tools, tool) ? manifest.tools[tool] : undefined;
  if (!definition) return null;
  const mcp = manifest.mcp ? { mcp: manifest.mcp.path } : {};
  return sha256B64u(canonical({ origin: manifest.origin, basePath: manifest.basePath ?? null, ...mcp, tool: definition }));
}

const pathParams = (path: string) => [...path.matchAll(/\{([^}]*)\}/g)].map((m) => m[1]!);

/** Why these terms can't be signed, if anything (empty = fine). */
export function orderProblems(terms: Omit<OrderTerms, "digest" | "label"> & { label?: string }, manifest: ConnectorManifest, now: number): string[] {
  const problems: string[] = [];
  const tool = Object.hasOwn(manifest.tools, terms.tool) ? manifest.tools[terms.tool] : undefined;
  if (!tool) return [`${manifest.id} has no tool "${terms.tool}"`];
  if (tool.class !== "outward" && tool.class !== "delete") {
    return [`${manifest.id}.${terms.tool} is ${tool.class}: your agent does that without asking, so it needs no order`];
  }
  if (terms.class !== tool.class) problems.push(`${manifest.id}.${terms.tool} is ${tool.class}, not ${terms.class}`);
  // A send of mail names whom it may send to: every address, never a pattern.
  if (!isMcpTool(tool) && tool.native !== undefined && MAIL_SENDS.has(tool.native)) {
    if (terms.args.to === undefined) problems.push(`an order to send mail names whom it may send to: pin to (and cc, if it may copy anyone), each address in full`);
    for (const name of RECIPIENTS) {
      const pattern = terms.args[name];
      if (pattern !== undefined && (wild(pattern) || !mailAddresses(pattern)?.length)) problems.push(`${name}: name each address in full, comma-separated, with no *`);
    }
  }
  const params: Record<string, { required?: boolean }> = tool.params ?? {};
  for (const name of Object.keys(terms.args)) {
    if (!Object.hasOwn(params, name)) problems.push(`${manifest.id}.${terms.tool} takes no "${name}"`);
  }
  // An MCP tool has no path; what it acts on is in its arguments, so a delete pins every required one.
  const inPath = isMcpTool(tool) ? [] : pathParams(tool.path);
  if (isMcpTool(tool) && tool.class === "delete") {
    const loose = Object.entries(params).filter(([name, p]) => p.required && !Object.hasOwn(terms.args, name)).map(([name]) => name);
    if (loose.length) problems.push(`an order to delete names exactly one thing: pin ${loose.join(", ")}`);
  }
  const unnamed = inPath.filter((name) => !Object.hasOwn(terms.args, name));
  if (unnamed.length) problems.push(`name where it goes: ${unnamed.join(", ")} (use * for any)`);
  if (inPath.length && !inPath.some((name) => Object.hasOwn(terms.args, name) && !wild(terms.args[name]!))) {
    problems.push(`pin at least one of ${inPath.join(", ")} to a value without *`);
  }
  if (tool.class === "delete") {
    const wildcards = Object.entries(terms.args).filter(([, pattern]) => wild(pattern));
    if (wildcards.length) problems.push(`an order to delete names exactly one thing: no * (in ${wildcards.map(([name]) => name).join(", ")})`);
  }
  if (terms.until <= now) problems.push("it would already have expired");
  if (terms.until > now + MAX_ORDER_DAYS * DAY_MS) problems.push(`orders last at most ${MAX_ORDER_DAYS} days`);
  return problems;
}

export interface CoveredCall {
  connector: string;
  tool: string;
  class: string;
  args: Record<string, unknown>;
  /** Who asked, as recorded on the action: `arm:<label>` or `node:<name>`. */
  by: string;
  /** The tool's digest now. */
  digest: string | null;
  /** The tool's native, as the manifest has it now (a mail send's order is held to its recipients: MAIL_SENDS). */
  native?: string;
}

/**
 * The caller name orders match against: an arm's label, `loop.<name>` for a loop
 * (whether it calls directly, recorded as `loop:<name>`, or through its run's arm),
 * or `node:<name>`.
 */
export const callerName = (by: string) => (by.startsWith("arm:") ? by.slice(4) : by.startsWith("loop:") ? `loop.${by.slice(5)}` : by);

/** Whether this order answers this call at time `at` (epoch ms). Pure: replicas check it again on replay. */
export function orderCovers(order: OrderTerms, call: CoveredCall, at: number): boolean {
  if (order.connector !== call.connector || order.tool !== call.tool || order.class !== call.class) return false;
  if (at >= order.until || call.digest === null || call.digest !== order.digest) return false;
  // A send of mail, from SENDS_NAME_RECIPIENTS_FROM: whom it goes to is judged as addresses, the rest as patterns.
  const send = call.native !== undefined && MAIL_SENDS.has(call.native) && at >= SENDS_NAME_RECIPIENTS_FROM;
  if (send && !sendCovered(order, call.args)) return false;
  for (const [name, pattern] of Object.entries(order.args)) {
    if (send && (RECIPIENTS as readonly string[]).includes(name)) continue;
    const value = call.args[name];
    if (value === undefined || value === null || typeof value === "object") return false;
    if (order.class === "delete" ? String(value) !== pattern : !globMatch(pattern, String(value))) return false;
  }
  if (order.callers && !order.callers.some((pattern) => globMatch(pattern, callerName(call.by)))) return false;
  return true;
}
