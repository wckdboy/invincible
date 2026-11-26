/*
 * Hosted MCP servers worth having at hand: each the service's own, as the official MCP Registry lists it under the
 * service's own namespace (checked 17 November 2026), added with one tap or `galahad connector add <id>`. Every one that
 * signs in was found to take Galahad's own sign-in as it is: a 401 that names its authorization server, which lets a
 * client register itself, with PKCE (S256). This reviewed list is the library's floor; the index at mcp.galahad.sh
 * (apps/mcp-index, mcp-index.ts) adds the rest of the registry's that pass its checks, and a node reads it.
 *
 * Dinero's is the service's own by its own page (dinero.dk/funktioner/mcp, checked 18 November 2026), not the
 * registry's: its authorization server (Visma Connect) takes only clients with a secret, which Galahad asks for when it
 * registers there (brain mcp-oauth.ts, clientAuthMethod). Its endpoint is the root; the page's /mcp answers 404.
 */
import { z } from "zod";
import type { ConnectorTool } from "./connectors.ts";
import { entryProblem, MCP_AUTHS, MCP_CATEGORIES, type McpCategory, type McpIndexEntry } from "./mcp-index.ts";

/** One hosted MCP server: where it is, whether you sign in to it as yourself, and what it gives, in a line. */
export interface McpLibraryEntry {
  id: string;
  label: string;
  url: string;
  auth: "oauth" | "none";
  description: string;
  category: McpCategory;
  /** The registrable domain it is on. */
  site: string;
}

export const MCP_LIBRARY: readonly McpLibraryEntry[] = [
  { id: "linear", label: "Linear", url: "https://mcp.linear.app/mcp", auth: "oauth", description: "Issues, projects and cycles: find, file and update them.", category: "Project management", site: "linear.app" },
  { id: "sentry", label: "Sentry", url: "https://mcp.sentry.dev/mcp", auth: "oauth", description: "Errors and slow requests, with their stack traces and the releases that brought them.", category: "Developer tools", site: "sentry.dev" },
  { id: "notion", label: "Notion", url: "https://mcp.notion.com/mcp", auth: "oauth", description: "Pages and databases: search, read and write them.", category: "Docs & knowledge", site: "notion.com" },
  { id: "atlassian", label: "Atlassian", url: "https://mcp.atlassian.com/v2/mcp", auth: "oauth", description: "Jira issues and Confluence pages.", category: "Project management", site: "atlassian.com" },
  { id: "gitlab", label: "GitLab", url: "https://gitlab.com/api/v4/mcp", auth: "oauth", description: "Projects, merge requests, issues and pipelines on gitlab.com.", category: "Developer tools", site: "gitlab.com" },
  { id: "vercel", label: "Vercel", url: "https://mcp.vercel.com", auth: "oauth", description: "Projects, deployments and their logs.", category: "Cloud & infrastructure", site: "vercel.com" },
  { id: "supabase", label: "Supabase", url: "https://mcp.supabase.com/mcp", auth: "oauth", description: "Projects, their Postgres databases and edge functions.", category: "Data & databases", site: "supabase.com" },
  { id: "neon", label: "Neon", url: "https://mcp.neon.tech/mcp", auth: "oauth", description: "Serverless Postgres: projects, branches and queries.", category: "Data & databases", site: "neon.tech" },
  { id: "prisma", label: "Prisma", url: "https://mcp.prisma.io/mcp", auth: "oauth", description: "Prisma Postgres databases and their schemas.", category: "Data & databases", site: "prisma.io" },
  { id: "cloudflare-observability", label: "Cloudflare Observability", url: "https://observability.mcp.cloudflare.com/mcp", auth: "oauth", description: "Workers' logs and analytics, to find what broke.", category: "Cloud & infrastructure", site: "cloudflare.com" },
  { id: "cloudflare-bindings", label: "Cloudflare Bindings", url: "https://bindings.mcp.cloudflare.com/mcp", auth: "oauth", description: "Workers, KV, R2, D1 and the rest of a Cloudflare account.", category: "Cloud & infrastructure", site: "cloudflare.com" },
  { id: "cloudflare-docs", label: "Cloudflare Docs", url: "https://docs.mcp.cloudflare.com/mcp", auth: "none", description: "Cloudflare's documentation, searched. No sign-in.", category: "Docs & knowledge", site: "cloudflare.com" },
  { id: "context7", label: "Context7", url: "https://mcp.context7.com/mcp", auth: "none", description: "Up-to-date documentation for the libraries a project uses. No sign-in.", category: "Docs & knowledge", site: "context7.com" },
  { id: "huggingface", label: "Hugging Face", url: "https://huggingface.co/mcp", auth: "oauth", description: "Models, datasets, Spaces and papers on the Hub.", category: "AI & machine learning", site: "huggingface.co" },
  { id: "posthog", label: "PostHog", url: "https://mcp.posthog.com/mcp", auth: "oauth", description: "Product analytics, feature flags and error tracking.", category: "Analytics", site: "posthog.com" },
  { id: "stripe", label: "Stripe", url: "https://mcp.stripe.com", auth: "oauth", description: "Customers, payments, subscriptions and invoices.", category: "Commerce & payments", site: "stripe.com" },
  { id: "paypal", label: "PayPal", url: "https://mcp.paypal.com/mcp", auth: "oauth", description: "Invoices, orders and transactions.", category: "Commerce & payments", site: "paypal.com" },
  { id: "figma", label: "Figma", url: "https://mcp.figma.com/mcp", auth: "oauth", description: "Designs, their components and the code behind them.", category: "Design & media", site: "figma.com" },
  { id: "canva", label: "Canva", url: "https://mcp.canva.com/mcp", auth: "oauth", description: "Designs: find, make and export them.", category: "Design & media", site: "canva.com" },
  { id: "airtable", label: "Airtable", url: "https://mcp.airtable.com/mcp", auth: "oauth", description: "Bases, tables and records.", category: "Data & databases", site: "airtable.com" },
  { id: "monday", label: "monday.com", url: "https://mcp.monday.com/mcp", auth: "oauth", description: "Boards, items and updates.", category: "Project management", site: "monday.com" },
  { id: "dinero", label: "Dinero", url: "https://mcp.dinero.dk/", auth: "oauth", description: "Danish bookkeeping: invoices, vouchers, contacts, bank transactions and the figures (Dinero Pro or Total).", category: "Finance", site: "dinero.dk" },
  { id: "webflow", label: "Webflow", url: "https://mcp.webflow.com/mcp", auth: "oauth", description: "Sites, pages and CMS collections.", category: "Design & media", site: "webflow.com" },
];

type ToolClass = ConnectorTool["class"];

/**
 * The reviewed list's own proposal of a class for a server's tools, by their names (case aside; `*` any run of
 * characters), the first that matches: before the server's hints, never before your own choice (brain
 * mcp-connectors.ts). Only the reviewed list proposes: a server from the index is classed by its hints alone.
 *
 * Dinero's is the owner's ruling for the knight that keeps the books (18 November 2026, "Drafts on its own"): it
 * reads, and prepares drafts (vouchers, invoices, offers, credit notes, the contacts and products they name, the files
 * they carry, uploaded) without asking; booking, registering a payment, sending, changing what is there (attaching a
 * file to a voucher's card among it) and deleting ask you.
 */
export const MCP_TOOL_CLASSES: Readonly<Record<string, readonly (readonly [pattern: string, toolClass: ToolClass])[]>> = {
  dinero: [
    ["book*", "outward"],
    ["add_*payment*", "outward"],
    ["send*", "outward"],
    ["update*", "outward"],
    ["submit*", "outward"],
    // Attaching a file to a voucher's card changes the books, Dinero's own description says: it asks.
    ["attach*", "outward"],
    ["delete*", "delete"],
    ["get*", "read"],
    ["list*", "read"],
    ["search*", "read"],
    ["create*", "create"],
    ["generate*", "create"],
    ["upload*", "create"],
  ],
};

/**
 * Servers on the reviewed list that hold what is yours alone (your company's books): installed as Galahad's alone, so
 * only he and the knights you allow may call them (`galahad connector allow <id> <knight>`), and private as your mail
 * and your bank are, so what one answer reads of them goes nowhere but their own tools.
 */
export const MCP_ALONE: ReadonlySet<string> = new Set(["dinero"]);

/** What the reviewed list proposes for a server's tool (MCP_TOOL_CLASSES), or null where it proposes nothing. */
export function libraryClass(proposed: readonly (readonly [string, ToolClass])[] | undefined, remote: string): ToolClass | null {
  const name = remote.toLowerCase();
  for (const [pattern, toolClass] of proposed ?? []) {
    const glob = new RegExp(`^${pattern.toLowerCase().split("*").map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*")}$`);
    if (glob.test(name)) return toolClass;
  }
  return null;
}

/** A library entry by its id, or null. */
export const mcpLibraryEntry = (id: string): McpLibraryEntry | null => MCP_LIBRARY.find((entry) => entry.id === id) ?? null;

/** The reviewed list's entry for the server at this address (a trailing slash aside), whatever it was added as. */
export const reviewedMcp = (url: string): McpLibraryEntry | null => {
  const at = url.replace(/\/+$/, "");
  return MCP_LIBRARY.find((entry) => entry.url.replace(/\/+$/, "") === at) ?? null;
};

/** The reviewed list as the index's entries: listed first, whatever the index says. */
export const reviewedEntries = (): McpIndexEntry[] =>
  MCP_LIBRARY.map((e) => ({ id: e.id, label: e.label, description: e.description, url: e.url, site: e.site, category: e.category, auth: e.auth, rank: null, registry: "", updated: "", reviewed: true }));

/** Where the index is read from, unless a node is told otherwise (GALAHAD_MCP_INDEX; "off" reads none). */
export const MCP_INDEX_URL = "https://mcp.galahad.sh/v1/library.json";

/** The index as mcp.galahad.sh serves it: each entry is checked again on its own (entryProblem), and a bad one is dropped, not the rest. */
export const McpIndexSnapshot = z.object({
  v: z.literal(1),
  generated: z.string().max(40),
  count: z.number().int().nonnegative(),
  entries: z.array(z.unknown()).max(20_000),
});

const IndexEntry = z.object({
  id: z.string().max(40),
  label: z.string().max(80),
  description: z.string().max(400),
  url: z.string().max(400),
  site: z.string().max(253),
  category: z.enum(MCP_CATEGORIES),
  auth: z.enum(MCP_AUTHS as [McpIndexEntry["auth"], ...McpIndexEntry["auth"][]]),
  header: z.string().max(64).optional(),
  rank: z.number().int().positive().nullable(),
  registry: z.string().max(200),
  updated: z.string().max(40),
});

/** An entry from the index, taken in only when it passes every rule (never marked reviewed: only Galahad's own list is). */
export function indexEntry(raw: unknown): McpIndexEntry | null {
  const parsed = IndexEntry.safeParse(raw);
  if (!parsed.success) return null;
  const entry: McpIndexEntry = { ...parsed.data };
  return entryProblem(entry) ? null : entry;
}
