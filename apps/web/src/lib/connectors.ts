/*
 * Connectors as people read them: how a tool's parameter is typed in, what an
 * MCP server claims about its tools, and the checks said before the node says
 * them (packages/node/src/connectors.ts has the last word). Pure, so unit-tested.
 */

export const TOOL_CLASSES = ["read", "create", "modify", "outward", "delete"] as const;
export type ToolClass = (typeof TOOL_CLASSES)[number];

/** Outward and delete ask you first; the rest run freely (and are logged). */
export const asksYou = (cls: string): boolean => cls === "outward" || cls === "delete";

/** A connector id: lowercase letters, digits and -, starting with a letter (max 40). */
export const CONNECTOR_ID = /^[a-z][a-z0-9-]{0,39}$/;

export type ArgKind = "text" | "integer" | "number" | "boolean" | "json";

/**
 * How a parameter is typed in, from its declared type. An MCP tool's may be a
 * list, an object or several types ("integer|string"): lists and objects are
 * given as JSON, a single number or boolean type gets its own control, and
 * everything else is text.
 */
export function argKind(type: string): ArgKind {
  const types = type.split("|").filter(Boolean);
  if (types.some((t) => t === "array" || t === "object")) return "json";
  if (types.length === 1 && (types[0] === "integer" || types[0] === "number" || types[0] === "boolean")) return types[0];
  return "text";
}

/** What the server says about a tool, in the CLI's words. Only a claim: it proposes a class, you choose. */
export function claimWords(hints: { readOnly?: boolean; destructive?: boolean } | null | undefined): string {
  return hints?.readOnly ? "says read-only" : hints?.destructive ? "says destructive" : "no hints";
}

/** The same claim as a sentence: "The server says it's read-only." */
export function claimSentence(hints: { readOnly?: boolean; destructive?: boolean } | null | undefined): string {
  return hints?.readOnly ? "The server says it's read-only." : hints?.destructive ? "The server says it's destructive." : "The server gives no hints.";
}

/**
 * A connector id to suggest from an MCP server's address, as the CLI derives it:
 * "https://mcp.linear.app/mcp" → "linear". Null when the host gives nothing usable
 * (an IP address, say).
 */
export function suggestId(address: string): string | null {
  let host: string;
  try {
    host = new URL(address.trim()).hostname.toLowerCase();
  } catch {
    return null;
  }
  if (/^[\d.]+$/.test(host) || host.includes(":") || host.startsWith("[")) return null;
  const part = host.split(".").filter((p) => !["mcp", "api", "www"].includes(p))[0] ?? "";
  const id = part.replace(/[^a-z0-9-]/g, "-").replace(/^[^a-z]+/, "").replace(/-+$/, "").slice(0, 40);
  return CONNECTOR_ID.test(id) ? id : null;
}

/** Why this can't be an MCP server's address, before the node says so (it checks again, and more). */
export function mcpUrlProblem(address: string): string | null {
  let url: URL;
  try {
    url = new URL(address.trim());
  } catch {
    return "Give the server's full address, such as https://mcp.example.com/mcp.";
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return "An MCP server's address starts with https:// (plain http only on this machine or your own network).";
  if (url.username || url.password || url.search || url.hash) return "Give the server's address without a query or credentials: keys go in the vault, never in a URL.";
  return null;
}

/** The tools that would stop asking you if these classes were saved. */
export function stopsAsking(tools: { name: string; class: string }[], chosen: Record<string, string>): string[] {
  return tools.filter((t) => Object.hasOwn(chosen, t.name) && asksYou(t.class) && !asksYou(chosen[t.name]!)).map((t) => t.name);
}

export interface Discovered {
  server: string | null;
  tools: number;
  needsKey: boolean;
  /** One you sign in to, not signed in yet: its tools are listed once you have. */
  needsSignIn?: boolean;
  added: string[];
  changed: string[];
  removed: string[];
  skipped: number;
}

/** "Tracker (tracker 1.2.3): 5 tools, 2 left out." */
export function discoveredSummary(label: string, d: Pick<Discovered, "server" | "tools" | "skipped">): string {
  return `${label}${d.server ? ` (${d.server})` : ""}: ${d.tools} tool${d.tools === 1 ? "" : "s"}${d.skipped ? `, ${d.skipped} left out` : ""}.`;
}
