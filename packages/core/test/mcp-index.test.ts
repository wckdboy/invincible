import { describe, expect, test } from "bun:test";
import { categorize, entryProblem, hostWithin, type McpIndexEntry, searchLibrary } from "../src/mcp-index.ts";

/* The library's index (mcp-index.ts): what an entry may be, the shelf it goes on, and the search the apps get. */

const entry = (over: Partial<McpIndexEntry> = {}): McpIndexEntry => ({
  id: "stripe",
  label: "Stripe",
  description: "Customers, payments, subscriptions and invoices.",
  url: "https://mcp.stripe.com",
  site: "stripe.com",
  category: "Commerce & payments",
  auth: "oauth",
  rank: 214,
  registry: "com.stripe/mcp",
  updated: "2026-10-01T00:00:00Z",
  ...over,
});

describe("what an entry may be", () => {
  test("a host is its site or under it, never a look-alike", () => {
    expect(hostWithin("mcp.stripe.com", "stripe.com")).toBe(true);
    expect(hostWithin("stripe.com", "stripe.com")).toBe(true);
    expect(hostWithin("evilstripe.com", "stripe.com")).toBe(false);
    expect(hostWithin("stripe.com.evil.example", "stripe.com")).toBe(false);
    expect(hostWithin("anything", "localhost")).toBe(false);
  });

  test("https on its own site, no credentials or query, an id Galahad can use, a header for a key", () => {
    expect(entryProblem(entry())).toBeNull();
    expect(entryProblem(entry({ url: "http://mcp.stripe.com" }))).toBe("not https");
    expect(entryProblem(entry({ url: "https://mcp.stripe.com/?key=x" }))).toContain("query");
    expect(entryProblem(entry({ url: "https://user:pw@mcp.stripe.com" }))).toContain("credentials");
    expect(entryProblem(entry({ url: "https://mcp.stripe.com.evil.example/mcp" }))).toContain("isn't on stripe.com");
    expect(entryProblem(entry({ id: "Stripe!" }))).toContain("id");
    expect(entryProblem(entry({ auth: "key" }))).toContain("header");
    expect(entryProblem(entry({ auth: "key", header: "X-API-Key" }))).toBeNull();
    expect(entryProblem(entry({ category: "Toys" as never }))).toContain("category");
  });
});

describe("the shelf a server goes on", () => {
  test("from its name and what it does", () => {
    expect(categorize("Stripe", "Customers, payments, subscriptions and invoices.")).toBe("Commerce & payments");
    expect(categorize("Linear", "Issues, projects and cycles: find, file and update them.")).toBe("Project management");
    expect(categorize("Supabase", "Projects, their Postgres databases and edge functions.")).toBe("Data & databases");
    expect(categorize("Sentry", "Errors and slow requests, with their stack traces and the releases that brought them.")).toBe("Developer tools");
    expect(categorize("Notion", "Pages and databases: search, read and write them.")).toBe("Docs & knowledge");
    expect(categorize("Figma", "Designs, their components and the code behind them.")).toBe("Design & media");
    expect(categorize("Context7", "Up-to-date documentation for the libraries a project uses.")).toBe("Docs & knowledge");
    expect(categorize("Vercel", "Projects, deployments and their logs.")).not.toBe("Other");
    expect(categorize("Zzz", "Nothing of note here.")).toBe("Other");
  });
});

describe("the search the apps get", () => {
  const all = [
    entry(),
    entry({ id: "linear", label: "Linear", site: "linear.app", url: "https://mcp.linear.app/mcp", category: "Project management", description: "Issues and projects.", rank: 7869, updated: "2026-11-10T00:00:00Z" }),
    entry({ id: "acme-docs", label: "Acme Docs", site: "acme.example", url: "https://docs.acme.example/mcp", category: "Docs & knowledge", auth: "none", description: "Acme's documentation.", rank: null, updated: "2026-11-17T00:00:00Z" }),
    entry({ id: "keyed", label: "Keyed", site: "keyed.example", url: "https://mcp.keyed.example", auth: "key", header: "Authorization", category: "Developer tools", description: "Builds.", rank: 50 }),
  ];

  test("popular first, reviewed ahead of the rest, a name that starts with the words ahead of one that only mentions them", () => {
    expect(searchLibrary(all, {}).entries.map((e) => e.id)).toEqual(["keyed", "stripe", "linear", "acme-docs"]);
    expect(searchLibrary(all.map((e) => (e.id === "linear" ? { ...e, reviewed: true } : e)), {}).entries[0]!.id).toBe("linear");
    expect(searchLibrary(all, { q: "lin" }).entries.map((e) => e.id)).toEqual(["linear"]);
    expect(searchLibrary(all, { sort: "name" }).entries.map((e) => e.label)).toEqual(["Acme Docs", "Keyed", "Linear", "Stripe"]);
    expect(searchLibrary(all, { sort: "updated" }).entries[0]!.id).toBe("acme-docs");
  });

  test("every word must be found; the kind and the shelf narrow it; shelves count what the words and kind found", () => {
    expect(searchLibrary(all, { q: "acme documentation" }).total).toBe(1);
    expect(searchLibrary(all, { q: "acme nowhere" }).total).toBe(0);
    expect(searchLibrary(all, { auth: "key" }).entries.map((e) => e.id)).toEqual(["keyed"]);
    const docs = searchLibrary(all, { category: "Docs & knowledge" });
    expect(docs.entries.map((e) => e.id)).toEqual(["acme-docs"]);
    // The shelf asked for doesn't hide the others' counts.
    expect(docs.categories.map((c) => c.name)).toEqual(["Developer tools", "Project management", "Docs & knowledge", "Commerce & payments"]);
  });

  test("a page at a time, never more than 200", () => {
    expect(searchLibrary(all, { offset: 1, limit: 2 }).entries.map((e) => e.id)).toEqual(["stripe", "linear"]);
    expect(searchLibrary(all, { offset: 1, limit: 2 }).total).toBe(4);
    expect(searchLibrary(Array.from({ length: 300 }, (_, i) => entry({ id: `s${i}` })), { limit: 1000 }).entries).toHaveLength(200);
  });
});
