/*
 * Hosted MCP servers worth having at hand: each the service's own, as the official MCP Registry lists it under the
 * service's own namespace (checked 17 November 2026), added with one tap or `invincible connector add <id>`. Every one that
 * signs in was found to take the primary's own sign-in as it is: a 401 that names its authorization server, which lets a
 * client register itself, with PKCE (S256).
 */

/** One hosted MCP server: where it is, whether you sign in to it as yourself, and what it gives, in a line. */
export interface McpLibraryEntry {
  id: string;
  label: string;
  url: string;
  auth: "oauth" | "none";
  description: string;
  /** The registrable domain it is on. */
  site: string;
}

export const MCP_LIBRARY: readonly McpLibraryEntry[] = [
  { id: "linear", label: "Linear", url: "https://mcp.linear.app/mcp", auth: "oauth", description: "Issues, projects and cycles: find, file and update them.", site: "linear.app" },
  { id: "sentry", label: "Sentry", url: "https://mcp.sentry.dev/mcp", auth: "oauth", description: "Errors and slow requests, with their stack traces and the releases that brought them.", site: "sentry.dev" },
  { id: "notion", label: "Notion", url: "https://mcp.notion.com/mcp", auth: "oauth", description: "Pages and databases: search, read and write them.", site: "notion.com" },
  { id: "atlassian", label: "Atlassian", url: "https://mcp.atlassian.com/v2/mcp", auth: "oauth", description: "Jira issues and Confluence pages.", site: "atlassian.com" },
  { id: "gitlab", label: "GitLab", url: "https://gitlab.com/api/v4/mcp", auth: "oauth", description: "Projects, merge requests, issues and pipelines on gitlab.com.", site: "gitlab.com" },
  { id: "vercel", label: "Vercel", url: "https://mcp.vercel.com", auth: "oauth", description: "Projects, deployments and their logs.", site: "vercel.com" },
  { id: "supabase", label: "Supabase", url: "https://mcp.supabase.com/mcp", auth: "oauth", description: "Projects, their Postgres databases and edge functions.", site: "supabase.com" },
  { id: "neon", label: "Neon", url: "https://mcp.neon.tech/mcp", auth: "oauth", description: "Serverless Postgres: projects, branches and queries.", site: "neon.tech" },
  { id: "prisma", label: "Prisma", url: "https://mcp.prisma.io/mcp", auth: "oauth", description: "Prisma Postgres databases and their schemas.", site: "prisma.io" },
  { id: "cloudflare-observability", label: "Cloudflare Observability", url: "https://observability.mcp.cloudflare.com/mcp", auth: "oauth", description: "Workers' logs and analytics, to find what broke.", site: "cloudflare.com" },
  { id: "cloudflare-bindings", label: "Cloudflare Bindings", url: "https://bindings.mcp.cloudflare.com/mcp", auth: "oauth", description: "Workers, KV, R2, D1 and the rest of a Cloudflare account.", site: "cloudflare.com" },
  { id: "cloudflare-docs", label: "Cloudflare Docs", url: "https://docs.mcp.cloudflare.com/mcp", auth: "none", description: "Cloudflare's documentation, searched. No sign-in.", site: "cloudflare.com" },
  { id: "context7", label: "Context7", url: "https://mcp.context7.com/mcp", auth: "none", description: "Up-to-date documentation for the libraries a project uses. No sign-in.", site: "context7.com" },
  { id: "huggingface", label: "Hugging Face", url: "https://huggingface.co/mcp", auth: "oauth", description: "Models, datasets, Spaces and papers on the Hub.", site: "huggingface.co" },
  { id: "posthog", label: "PostHog", url: "https://mcp.posthog.com/mcp", auth: "oauth", description: "Product analytics, feature flags and error tracking.", site: "posthog.com" },
  { id: "stripe", label: "Stripe", url: "https://mcp.stripe.com", auth: "oauth", description: "Customers, payments, subscriptions and invoices.", site: "stripe.com" },
  { id: "paypal", label: "PayPal", url: "https://mcp.paypal.com/mcp", auth: "oauth", description: "Invoices, orders and transactions.", site: "paypal.com" },
  { id: "figma", label: "Figma", url: "https://mcp.figma.com/mcp", auth: "oauth", description: "Designs, their components and the code behind them.", site: "figma.com" },
  { id: "canva", label: "Canva", url: "https://mcp.canva.com/mcp", auth: "oauth", description: "Designs: find, make and export them.", site: "canva.com" },
  { id: "airtable", label: "Airtable", url: "https://mcp.airtable.com/mcp", auth: "oauth", description: "Bases, tables and records.", site: "airtable.com" },
  { id: "monday", label: "monday.com", url: "https://mcp.monday.com/mcp", auth: "oauth", description: "Boards, items and updates.", site: "monday.com" },
  { id: "webflow", label: "Webflow", url: "https://mcp.webflow.com/mcp", auth: "oauth", description: "Sites, pages and CMS collections.", site: "webflow.com" },
];

/** A library entry by its id, or null. */
export const mcpLibraryEntry = (id: string): McpLibraryEntry | null => MCP_LIBRARY.find((entry) => entry.id === id) ?? null;
