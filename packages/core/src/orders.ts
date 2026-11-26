import { z } from "zod";
import { canonical } from "./canonical.ts";
import { type ConnectorManifest, isMcpTool } from "./connectors.ts";
import { sha256B64u } from "./crypto.ts";

/*
 * Standing orders: answers you give in advance. One order names one connector
 * tool, constrains its arguments and expires. When an agent's call matches an
 * active order, Galahad doesn't ask: the order is your answer, and the log records
 * which order gave it. Everything else still asks.
 *
 * Narrow by construction:
 *   - only for tools that would ask (outward, delete): the rest need no order
 *   - every path parameter (where the request goes) is named, and at least one is
 *     pinned without wildcards: an order says where, not "anywhere"
 *   - a delete is pinned exactly, with no wildcards at all: one named thing, never a family
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
  /** Who may use it: arm labels or loop arms (`loop.release`), patterns allowed. Omitted: any of Galahad's agents. */
  callers: z.array(OrderPattern).min(1).max(16).optional(),
  /** Epoch ms. */
  until: z.number().int(),
  /** The tool's digest when you signed (see toolDigest). */
  digest: z.string().min(1).max(64),
  label: z.string().min(1).max(128),
});
export type OrderTerms = z.infer<typeof OrderTerms>;

const wild = (pattern: string) => pattern.includes("*");

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
    return [`${manifest.id}.${terms.tool} is ${tool.class}: Galahad does that without asking, so it needs no order`];
  }
  if (terms.class !== tool.class) problems.push(`${manifest.id}.${terms.tool} is ${tool.class}, not ${terms.class}`);
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
}

/**
 * The caller name orders match against: an arm's label, `loop.<name>` for a loop
 * (whether it calls directly, recorded as `loop:<name>`, or through its quest's arm),
 * or `node:<name>`.
 */
export const callerName = (by: string) => (by.startsWith("arm:") ? by.slice(4) : by.startsWith("loop:") ? `loop.${by.slice(5)}` : by);

/** Whether this order answers this call at time `at` (epoch ms). Pure: replicas check it again on replay. */
export function orderCovers(order: OrderTerms, call: CoveredCall, at: number): boolean {
  if (order.connector !== call.connector || order.tool !== call.tool || order.class !== call.class) return false;
  if (at >= order.until || call.digest === null || call.digest !== order.digest) return false;
  for (const [name, pattern] of Object.entries(order.args)) {
    const value = call.args[name];
    if (value === undefined || value === null || typeof value === "object") return false;
    if (order.class === "delete" ? String(value) !== pattern : !globMatch(pattern, String(value))) return false;
  }
  if (order.callers && !order.callers.some((pattern) => globMatch(pattern, callerName(call.by)))) return false;
  return true;
}
