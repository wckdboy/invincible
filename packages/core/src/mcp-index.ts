/*
 * The library of hosted MCP servers, as its index lists them (apps/mcp-index, served at mcp.galahad.sh): what an entry
 * is, the rules every entry is held to wherever it is read (the indexer when it lists one, the node when it takes one
 * in), the category it is filed under, and the search the node answers the apps with. Pure: no I/O, and nothing here
 * needs zod, so the indexer's Worker carries it as it is.
 */

/** The shelves of the library, in the order they are shown. */
export const MCP_CATEGORIES = [
  "Developer tools",
  "Cloud & infrastructure",
  "Data & databases",
  "Analytics",
  "Project management",
  "Docs & knowledge",
  "Communication",
  "Design & media",
  "Commerce & payments",
  "Finance",
  "Marketing & sales",
  "Security & identity",
  "AI & machine learning",
  "Search & web",
  "Productivity",
  "Other",
] as const;
export type McpCategory = (typeof MCP_CATEGORIES)[number];

/** How a server lets Galahad in: you sign in to it as yourself (oauth), it takes a key (in Authorization, or a header of its own), or it needs nothing. */
export type McpAuth = "oauth" | "key" | "none";
export const MCP_AUTHS: readonly McpAuth[] = ["oauth", "key", "none"];

/** One hosted MCP server in the library. */
export interface McpIndexEntry {
  /** Galahad's connector id for it. */
  id: string;
  label: string;
  description: string;
  /** Its streamable HTTP endpoint: https, on its own site. */
  url: string;
  /** The registrable domain its publisher proved to the MCP Registry, which its endpoint is on (stripe.com). */
  site: string;
  category: McpCategory;
  auth: McpAuth;
  /** A key's header (key only): Authorization means a bearer token. */
  header?: string;
  /** Its site's place among the web's most visited (Tranco), when it has one: the library's "popular". */
  rank: number | null;
  /** Its name in the official MCP Registry (com.stripe/mcp), or "" for one Galahad lists itself. */
  registry: string;
  /** When the registry last saw it change (ISO), or "". */
  updated: string;
  /** Galahad's own reviewed list, not only the index's checks. */
  reviewed?: boolean;
}

/** A connector id: lowercase letters, digits and -, starting with a letter. */
export const LIBRARY_ID = /^[a-z][a-z0-9-]{0,39}$/;
/** A header a key may be sent in. */
const HEADER_NAME = /^[A-Za-z0-9-]{1,64}$/;

/** Whether a host is the site or under it (mcp.stripe.com within stripe.com; evilstripe.com is not). */
export function hostWithin(host: string, site: string): boolean {
  const h = host.toLowerCase().replace(/\.$/, "");
  const s = site.toLowerCase().replace(/\.$/, "");
  return s.includes(".") && (h === s || h.endsWith(`.${s}`));
}

/** What is wrong with an entry, or null: every entry a node takes in is held to this, whoever listed it. */
export function entryProblem(e: McpIndexEntry): string | null {
  if (!LIBRARY_ID.test(e.id)) return `id "${e.id}" isn't lowercase letters, digits and -`;
  if (!e.label.trim() || e.label.length > 80) return "label";
  if (e.description.length > 400) return "description too long";
  let url: URL;
  try {
    url = new URL(e.url);
  } catch {
    return "not a URL";
  }
  if (url.protocol !== "https:") return "not https";
  if (url.username || url.password || url.search || url.hash) return "a URL with credentials, a query or a fragment";
  if (!hostWithin(url.hostname, e.site)) return `${url.hostname} isn't on ${e.site}`;
  if (!(MCP_CATEGORIES as readonly string[]).includes(e.category)) return `category "${e.category}"`;
  if (!MCP_AUTHS.includes(e.auth)) return `auth "${e.auth}"`;
  if (e.auth === "key" && !HEADER_NAME.test(e.header ?? "")) return "a key with no header to send it in";
  if (e.rank !== null && !(Number.isInteger(e.rank) && e.rank > 0)) return "rank";
  return null;
}

// ---- categories -----------------------------------------------------------------------------------------------------

/** Words that file a server on a shelf; a name's words count three times a description's. */
const SHELF_WORDS: readonly (readonly [McpCategory, RegExp])[] = [
  ["Developer tools", /\b(git|github|gitlab|bitbucket|code|coding|sdks?|devops|ci|cd|builds?|logs?|logging|monitor\w*|observability|errors?|debug\w*|testing|tests|postman|developers?|api docs|repositor\w*|pull requests?)\b/gi],
  ["Cloud & infrastructure", /\b(cloud|aws|azure|gcp|kubernetes|k8s|servers?|hosting|deploy\w*|dns|cdn|compute|containers?|serverless|infrastructure|domains?|workers|vms?|edge|networking)\b/gi],
  ["Data & databases", /\b(databases?|sql|postgres\w*|mysql|mongo\w*|redis|warehouse|bigquery|snowflake|datasets?|tables|vectors?|etl|records|schemas?)\b/gi],
  ["Analytics", /\b(analytics|metrics|insights?|dashboards?|tracking|attribution|telemetry|reporting|funnels?|product analytics|events)\b/gi],
  ["Project management", /\b(issues?|tasks?|project management|tickets?|sprints?|roadmaps?|kanban|boards?|jira|linear|asana|trello|backlog|to-?dos?|work management|cycles)\b/gi],
  ["Docs & knowledge", /\b(docs|documentation|knowledge|wiki|notes|learn|tutorials?|reference|guides?|manuals?|confluence|notion|pages|articles?)\b/gi],
  ["Communication", /\b(e-?mails?|mail|inbox|chats?|messag\w*|sms|slack|teams|discord|calendars?|meetings?|calls?|voice|phone|whatsapp|telegram|support tickets)\b/gi],
  ["Design & media", /\b(design\w*|figma|canva|images?|photos?|videos?|audio|music|media|graphics?|3d|fonts?|icons?|illustrat\w*|animations?|assets)\b/gi],
  ["Commerce & payments", /\b(payments?|checkout|invoic\w*|stripe|paypal|e-?commerce|shop\w*|stores?|orders?|billing|subscriptions?|merchants?|carts?|products? catalog|refunds?)\b/gi],
  ["Finance", /\b(financ\w*|accounting|bookkeep\w*|tax(es)?|banks?|banking|crypto\w*|bitcoin|blockchain|trading|stocks?|markets?|portfolios?|expenses?|payroll|wallets?|defi)\b/gi],
  ["Marketing & sales", /\b(marketing|crm|sales|leads?|campaigns?|ads|advertis\w*|seo|newsletters?|outreach|social media|affiliates?|customers?)\b/gi],
  ["Security & identity", /\b(security|secure|vulnerabilit\w*|threats?|siem|sentinel|identity|sso|iam|okta|auth0|compliance|malware|phishing|firewall|zero trust|cves?|audits?)\b/gi],
  ["AI & machine learning", /\b(ai|llms?|models?|machine learning|ml|inference|embeddings?|agents?|gpt|prompts?|generative|genai)\b/gi],
  ["Search & web", /\b(search\w*|web|scrap\w*|crawl\w*|browsers?|brows\w*|urls?|news|wikipedia|websites?)\b/gi],
  ["Productivity", /\b(forms?|surveys?|spreadsheets?|files?|storage|drive|pdfs?|signatures?|e-?sign\w*|scheduling|automat\w*|workflows?|zapier|productivity)\b/gi],
];

/** The shelf a server goes on, from its name and what it says it does: the most words of a shelf's win, a tie the shelf named first. */
export function categorize(name: string, description: string): McpCategory {
  let best: McpCategory = "Other";
  let bestScore = 0;
  for (const [shelf, words] of SHELF_WORDS) {
    const hits = (text: string) => new Set((text.match(words) ?? []).map((w) => w.toLowerCase())).size;
    const score = 3 * hits(name) + hits(description);
    if (score > bestScore) {
      best = shelf;
      bestScore = score;
    }
  }
  return best;
}

// ---- search ---------------------------------------------------------------------------------------------------------

export type LibrarySort = "popular" | "name" | "updated";
export interface LibraryQuery {
  /** Words to find, each somewhere in its name, site, category or description. */
  q?: string;
  auth?: McpAuth;
  category?: McpCategory;
  sort?: LibrarySort;
  offset?: number;
  limit?: number;
}
export interface LibraryPage {
  entries: McpIndexEntry[];
  /** All that match, before the page is cut. */
  total: number;
  /** Each shelf's count among what the words and the kind match (the shelf asked for left out of the filter, so every shelf shows what it holds). */
  categories: { name: McpCategory; count: number }[];
}

const fold = (text: string) => text.toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "");

/** A page of the library: what matches the words, kind and shelf, in the order asked for (a name that starts with the words first). */
export function searchLibrary(entries: readonly McpIndexEntry[], query: LibraryQuery): LibraryPage {
  const words = fold(query.q ?? "").split(/\s+/).filter(Boolean);
  const found = (e: McpIndexEntry) => {
    const hay = fold(`${e.label} ${e.site} ${e.id} ${e.category} ${e.description}`);
    return words.every((w) => hay.includes(w));
  };
  const before = entries.filter((e) => (!query.auth || e.auth === query.auth) && found(e));
  const counts = new Map<McpCategory, number>();
  for (const e of before) counts.set(e.category, (counts.get(e.category) ?? 0) + 1);
  const matched = query.category ? before.filter((e) => e.category === query.category) : before;
  const label = (a: McpIndexEntry, b: McpIndexEntry) => a.label.localeCompare(b.label, "en", { sensitivity: "base" }) || a.id.localeCompare(b.id);
  const named = (e: McpIndexEntry) => (words.length && fold(e.label).startsWith(words[0]!) ? 0 : 1);
  const sorted = [...matched].sort((a, b) => {
    switch (query.sort ?? "popular") {
      case "name":
        return label(a, b);
      case "updated":
        return (b.updated || "").localeCompare(a.updated || "") || label(a, b);
      default:
        return named(a) - named(b) || Number(!a.reviewed) - Number(!b.reviewed) || (a.rank ?? Infinity) - (b.rank ?? Infinity) || label(a, b);
    }
  });
  const offset = Math.max(0, query.offset ?? 0);
  const limit = Math.min(200, Math.max(1, query.limit ?? 30));
  return {
    entries: sorted.slice(offset, offset + limit),
    total: sorted.length,
    categories: MCP_CATEGORIES.filter((c) => counts.has(c)).map((name) => ({ name, count: counts.get(name)! })),
  };
}
