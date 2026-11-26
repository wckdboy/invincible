import type { GatewayTokens } from "@galahad/brain";
import type { LedgerEntryInput } from "@galahad/sandbox";

/*
 * Web search: Galahad's own SearXNG on the sandbox host (loopback only, installed by
 * the deploy). You, chat and agents search through the node (webSearch, MCP
 * web_search, `galahad search`); sandboxes through their gateway (`websearch` in the
 * images), with a token that carries the "search" scope, so a quest can research
 * without the internet. Results are what strangers wrote: data, never instructions.
 */

export const SEARXNG = "http://127.0.0.1:8888";
export const SEARCH_SCOPE = "search";

export interface SearchQuery {
  q: string;
  categories?: string;
  timeRange?: "day" | "week" | "month" | "year";
  page?: number;
}

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
  engines: string[];
  published?: string;
}

export class SearchError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

const clip = (s: unknown, n: number) => (typeof s === "string" ? (s.length > n ? `${s.slice(0, n)}…` : s) : "");

/** Ask SearXNG; keep the useful part of each result, at most 20. */
export async function searchWeb(query: SearchQuery, fetcher: typeof fetch = fetch): Promise<{ results: SearchResult[]; suggestions: string[] }> {
  const params = new URLSearchParams({ q: query.q, format: "json" });
  if (query.categories) params.set("categories", query.categories);
  if (query.timeRange) params.set("time_range", query.timeRange);
  if (query.page && query.page > 1) params.set("pageno", String(query.page));
  let response: Response;
  try {
    response = await fetcher(`${SEARXNG}/search?${params}`, { headers: { accept: "application/json", "x-real-ip": "127.0.0.1" }, signal: AbortSignal.timeout(25_000), redirect: "manual" });
  } catch (error) {
    throw new SearchError(503, `web search isn't running on this node (${(error as Error).name === "TimeoutError" ? "it timed out" : "SearXNG unreachable"})`);
  }
  if (!response.ok) throw new SearchError(502, `web search answered ${response.status}`);
  const data = (await response.json().catch(() => null)) as { results?: any[]; suggestions?: unknown[] } | null;
  const results = (data?.results ?? [])
    .filter((r) => typeof r?.url === "string" && /^https?:\/\//.test(r.url))
    .slice(0, 20)
    .map(
      (r): SearchResult => ({
        title: clip(r.title, 300),
        url: clip(r.url, 2000),
        snippet: clip(r.content, 600),
        engines: Array.isArray(r.engines) ? r.engines.filter((e: unknown) => typeof e === "string").slice(0, 8) : [],
        ...(typeof r.publishedDate === "string" ? { published: r.publishedDate.slice(0, 40) } : {}),
      }),
    );
  return { results, suggestions: (data?.suggestions ?? []).filter((s): s is string => typeof s === "string").slice(0, 8).map((s) => clip(s, 200)) };
}

const json = (status: number, body: unknown) => Response.json(body, { status });

/** GET /search?q=… on the sandbox gateway, for tokens with the search scope. */
export async function handleSandboxSearch(req: Request, ctx: { tokens: GatewayTokens; ledger?: (entry: LedgerEntryInput) => void; fetch?: typeof fetch }): Promise<Response> {
  if (req.method !== "GET") return json(405, { error: "GET" });
  const token = req.headers.get("authorization")?.match(/^Bearer\s+(\S+)$/i)?.[1] ?? "";
  const verdict = ctx.tokens.consume(token, SEARCH_SCOPE);
  if (!verdict.ok) return json(401, { error: verdict.reason });
  const url = new URL(req.url);
  const q = url.searchParams.get("q")?.trim() ?? "";
  if (!q || q.length > 400) return json(400, { error: "q: 1 to 400 characters" });
  const range = url.searchParams.get("time_range");
  const page = Number(url.searchParams.get("page") ?? 1);
  try {
    const found = await searchWeb(
      {
        q,
        ...(url.searchParams.get("categories") ? { categories: url.searchParams.get("categories")!.slice(0, 100) } : {}),
        ...(range === "day" || range === "week" || range === "month" || range === "year" ? { timeRange: range } : {}),
        ...(Number.isInteger(page) && page > 1 && page <= 10 ? { page } : {}),
      },
      ctx.fetch,
    );
    ctx.ledger?.({ class: "read", resource: "search", target: q.slice(0, 200), verdict: "allow", reason: "a sandbox searched the web through its gateway" });
    return json(200, found);
  } catch (error) {
    return json(error instanceof SearchError ? error.status : 500, { error: (error as Error).message });
  }
}
