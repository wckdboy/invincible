import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { GatewayTokens } from "@galahad/brain";
import { gatewayEnv, type LedgerEntryInput } from "@galahad/sandbox";
import { handleSandboxSearch, SearchError, searchWeb } from "../src/search.ts";

/*
 * Web search: Galahad's own SearXNG, through the node. Results are trimmed to what's
 * useful; sandboxes search through their gateway with a token that carries the search
 * scope; the `websearch` command is the same in both images.
 */

const REPO = join(import.meta.dir, "..", "..", "..");

function searxng(results: unknown[], status = 200) {
  const asked: string[] = [];
  const fetch = (async (input: string | URL | Request) => {
    asked.push(String(input));
    return Response.json({ results, suggestions: ["finite element analysis", 7] }, { status });
  }) as typeof globalThis.fetch;
  return { asked, fetch };
}

const RESULTS = [
  { title: "Finite element method - Wikipedia", url: "https://en.wikipedia.org/wiki/Finite_element_method", content: "The finite element method (FEM) is…", engines: ["brave", "google cse"] },
  { title: "Not a web page", url: "javascript:alert(1)", content: "x", engines: [] },
  { title: "A".repeat(500), url: "https://example.com/long", content: "B".repeat(2000), engines: ["brave"], publishedDate: "2026-11-01T00:00:00" },
];

describe("searching", () => {
  test("SearXNG's JSON, trimmed: web pages only, titles and snippets clipped, its suggestions", async () => {
    const s = searxng(RESULTS);
    const found = await searchWeb({ q: "finite element method", timeRange: "year", page: 2 }, s.fetch);
    expect(s.asked[0]).toBe("http://127.0.0.1:8888/search?q=finite+element+method&format=json&time_range=year&pageno=2");
    expect(found.results.map((r) => r.url)).toEqual(["https://en.wikipedia.org/wiki/Finite_element_method", "https://example.com/long"]);
    expect(found.results[1]!.title.length).toBeLessThanOrEqual(301);
    expect(found.results[1]!.snippet.length).toBeLessThanOrEqual(601);
    expect(found.results[1]!.published).toBe("2026-11-01T00:00:00");
    expect(found.suggestions).toEqual(["finite element analysis"]);
  });

  test("no SearXNG: a clear 503, not a hang", async () => {
    const down = (async () => {
      throw new TypeError("fetch failed");
    }) as unknown as typeof fetch;
    const error = await searchWeb({ q: "x" }, down).catch((e) => e);
    expect(error).toBeInstanceOf(SearchError);
    expect(error.status).toBe(503);
  });
});

describe("searching from a sandbox", () => {
  const setup = () => {
    const tokens = new GatewayTokens(new Database(":memory:"));
    const ledger: LedgerEntryInput[] = [];
    const s = searxng(RESULTS);
    const call = (query: string, token: string) =>
      handleSandboxSearch(new Request(`http://172.31.250.1:7779/search${query}`, { headers: { authorization: `Bearer ${token}` } }), { tokens, ledger: (e) => ledger.push(e), fetch: s.fetch });
    return { tokens, ledger, call, s };
  };

  test("a token with the search scope searches, and the search is ledgered", async () => {
    const { tokens, ledger, call } = setup();
    const { token } = tokens.mint({ label: "sandbox:x", providers: ["orcarouter", "search"], ttlMinutes: 60, maxRequests: 10 });
    const response = await call("?q=finite+element+method", token);
    expect(response.status).toBe(200);
    expect(((await response.json()) as { results: unknown[] }).results).toHaveLength(2);
    expect(ledger).toEqual([expect.objectContaining({ class: "read", resource: "search", target: "finite element method" })]);
  });

  test("a model-only token, a git token or no query: refused, nothing searched", async () => {
    const { tokens, call, s } = setup();
    const models = tokens.mint({ label: "sandbox:y", providers: ["orcarouter"], ttlMinutes: 60, maxRequests: 10 }).token;
    const git = tokens.mint({ label: "git:q", providers: ["git:github:o:r"], ttlMinutes: 60, maxRequests: 10 }).token;
    expect((await call("?q=x", models)).status).toBe(401);
    expect((await call("?q=x", git)).status).toBe(401);
    const search = tokens.mint({ label: "sandbox:z", providers: ["search"], ttlMinutes: 60, maxRequests: 10 }).token;
    expect((await call("", search)).status).toBe(400);
    expect(s.asked).toEqual([]);
  });

  test("a sandbox with search gets its address; search is never mistaken for a model provider", () => {
    const env = gatewayEnv("gw_test", ["search", "orcarouter"]);
    expect(env.GALAHAD_SEARCH).toBe("http://172.31.250.1:7779/search");
    expect(env.OPENAI_BASE_URL).toBe("http://172.31.250.1:7779/gw/orcarouter");
    const searchOnly = gatewayEnv("gw_test", ["search"]);
    expect(searchOnly.OPENAI_BASE_URL).toBeUndefined();
    expect(searchOnly.GALAHAD_TOKEN).toBe("gw_test");
    expect(gatewayEnv("gw_test", ["orcarouter"]).GALAHAD_SEARCH).toBeUndefined();
  });
});

describe("websearch, in the images", () => {
  test("the same command in the workshop and the Lab, and valid shell", () => {
    const workshop = readFileSync(join(REPO, "sandbox", "websearch"), "utf8");
    expect(readFileSync(join(REPO, "sandbox", "lab", "websearch"), "utf8")).toBe(workshop);
    expect(Bun.spawnSync(["sh", "-n", join(REPO, "sandbox", "websearch")]).exitCode).toBe(0);
  });

  const python = (() => {
    try {
      return Bun.spawnSync(["python3", "-c", "print(1)"]).exitCode === 0;
    } catch {
      return false;
    }
  })();

  test.skipIf(!python || process.platform === "win32")("prints each result from the gateway, sending the token", async () => {
    let auth = "";
    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch(req) {
        auth = req.headers.get("authorization") ?? "";
        return Response.json({ results: [{ title: "FEM", url: "https://en.wikipedia.org/wiki/FEM", snippet: "The finite element method…" }], suggestions: [] });
      },
    });
    try {
      const run = Bun.spawn(["sh", join(REPO, "sandbox", "websearch"), "finite", "element"], {
        env: { ...process.env, GALAHAD_SEARCH: `http://127.0.0.1:${server.port}/search`, GALAHAD_TOKEN: "gw_test" },
        stdout: "pipe",
      });
      const out = await new Response(run.stdout).text();
      expect(await run.exited).toBe(0);
      expect(out).toContain("1. FEM\n   https://en.wikipedia.org/wiki/FEM");
      expect(auth).toBe("Bearer gw_test");
    } finally {
      server.stop(true);
    }
  });
});
