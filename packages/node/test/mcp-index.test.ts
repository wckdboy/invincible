import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MCP_INDEX_URL, MCP_LIBRARY, type McpIndexEntry } from "@galahad/core";
import { indexUrl, McpIndex } from "../src/mcp-index.ts";

/* The library on a node (mcp-index.ts): the reviewed list and the index at mcp.galahad.sh, read lazily and kept on disk. */

const root = mkdtempSync(join(tmpdir(), "galahad-mcp-index-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const entry = (over: Partial<McpIndexEntry> = {}): McpIndexEntry => ({
  id: "acme",
  label: "Acme",
  description: "Builds and their logs.",
  url: "https://mcp.acme.example/mcp",
  site: "acme.example",
  category: "Developer tools",
  auth: "oauth",
  rank: 500,
  registry: "example.acme/mcp",
  updated: "2026-11-01T00:00:00Z",
  ...over,
});
const snapshot = (entries: unknown[]) => ({ v: 1, generated: "2026-11-18T00:00:00Z", count: entries.length, entries });

/** A stand-in index: what it serves, and how often it was asked. */
function served(body: unknown, status = 200) {
  let asked = 0;
  const fetcher = (async () => {
    asked++;
    return new Response(JSON.stringify(body), { status });
  }) as unknown as typeof fetch;
  return { fetcher, asked: () => asked };
}

test("where the index is read from: mcp.galahad.sh, another over https (plain http only on this machine), or none", () => {
  expect(indexUrl(undefined)).toBe(MCP_INDEX_URL);
  expect(indexUrl("off")).toBeNull();
  expect(indexUrl("https://mirror.example/library.json")).toBe("https://mirror.example/library.json");
  expect(indexUrl("http://127.0.0.1:8080/library.json")).toBe("http://127.0.0.1:8080/library.json");
  expect(() => indexUrl("http://mirror.example/library.json")).toThrow("https");
});

describe("the library", () => {
  test("the reviewed list first, then the index's: one that is a reviewed server by its address is that one, a taken id gets -2", async () => {
    const linear = MCP_LIBRARY.find((e) => e.id === "linear")!;
    const index = served(
      snapshot([
        entry(),
        entry({ id: "linear-clone", label: "Linear (from the registry)", url: linear.url, site: "linear.app", rank: 7869 }),
        entry({ id: "github", label: "Someone's GitHub", url: "https://mcp.someone.example/mcp", site: "someone.example" }),
        entry({ id: "notion", label: "Not Notion", url: "https://mcp.elsewhere.example/mcp", site: "elsewhere.example" }),
      ]),
    );
    const library = new McpIndex({ file: join(root, "a.json"), url: "https://mcp.galahad.sh/v1/library.json", fetch: index.fetcher, reserved: ["github"] });
    expect(library.entries().length).toBe(MCP_LIBRARY.length); // nothing read yet: the reviewed list alone
    await library.refresh();
    const all = library.entries();
    expect(all.slice(0, MCP_LIBRARY.length).every((e) => e.reviewed)).toBe(true);
    // The same server by its address isn't listed twice; the reviewed one takes its site's rank.
    expect(all.filter((e) => e.url === linear.url).map((e) => e.id)).toEqual(["linear"]);
    expect(library.find("linear")?.rank).toBe(7869);
    // Ids are their own: a reserved one and a reviewed one both get -2.
    expect(library.find("github-2")?.label).toBe("Someone's GitHub");
    expect(library.find("notion-2")?.label).toBe("Not Notion");
    expect(library.find("acme")?.reviewed).toBeUndefined();
    expect(library.status()).toMatchObject({ count: 4, problem: null });
  });

  test("an entry that breaks a rule is dropped, never the rest", async () => {
    const index = served(
      snapshot([
        entry(),
        entry({ id: "plain", url: "http://mcp.plain.example/mcp", site: "plain.example" }),
        entry({ id: "elsewhere", url: "https://mcp.evil.example/mcp", site: "acme.example" }),
        entry({ id: "Bad Id" }),
        entry({ id: "keyless", auth: "key" }),
        { not: "an entry" },
        entry({ id: "acme" }), // the same id again
      ]),
    );
    const library = new McpIndex({ file: join(root, "b.json"), url: "https://x.example/library.json", fetch: index.fetcher });
    await library.refresh();
    expect(library.status().count).toBe(1);
    expect(library.find("acme")).not.toBeNull();
  });

  test("kept on disk: a node started offline still has the last one; a failed read is said, and the kept one stays", async () => {
    const file = join(root, "c.json");
    const first = new McpIndex({ file, url: "https://x.example/library.json", fetch: served(snapshot([entry()])).fetcher });
    await first.refresh();
    const offline = new McpIndex({ file, url: "https://x.example/library.json", fetch: served("down", 503).fetcher, now: () => Date.now() + 13 * 3600_000 });
    expect(offline.find("acme")).not.toBeNull();
    await offline.refresh();
    expect(offline.status().problem).toContain("503");
    expect(offline.find("acme")).not.toBeNull();
  });

  test("read when asked and more than twelve hours old, not on every ask; never with the index off", async () => {
    let now = 1_000_000;
    const index = served(snapshot([entry()]));
    const library = new McpIndex({ file: join(root, "d.json"), url: "https://x.example/library.json", fetch: index.fetcher, now: () => now });
    library.entries();
    library.entries();
    await library.refresh();
    expect(index.asked()).toBe(1);
    now += 11 * 3600_000;
    library.entries();
    expect(index.asked()).toBe(1);
    now += 2 * 3600_000;
    library.entries();
    await library.refresh();
    expect(index.asked()).toBe(2);
    const off = new McpIndex({ file: join(root, "e.json"), url: null, fetch: index.fetcher });
    off.entries();
    await off.refresh();
    expect(index.asked()).toBe(2);
    expect(off.entries().length).toBe(MCP_LIBRARY.length);
  });
});
