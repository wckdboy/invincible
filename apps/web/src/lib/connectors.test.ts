import { describe, expect, test } from "bun:test";
import { argKind, asksYou, claimSentence, claimWords, discoveredSummary, mcpUrlProblem, stopsAsking, suggestId } from "./connectors.ts";

describe("connector tools as people type them in", () => {
  test("lists and objects are JSON; a lone number or boolean type gets its control; the rest is text", () => {
    expect(argKind("string")).toBe("text");
    expect(argKind("integer")).toBe("integer");
    expect(argKind("number")).toBe("number");
    expect(argKind("boolean")).toBe("boolean");
    expect(argKind("array")).toBe("json");
    expect(argKind("object")).toBe("json");
    expect(argKind("array|string")).toBe("json");
    expect(argKind("integer|string")).toBe("text");
    expect(argKind("any")).toBe("text");
  });

  test("outward and delete ask you; the rest run freely", () => {
    expect(["read", "create", "modify", "outward", "delete"].map(asksYou)).toEqual([false, false, false, true, true]);
  });
});

describe("MCP servers", () => {
  test("what the server claims, in the CLI's words", () => {
    expect(claimWords({ readOnly: true })).toBe("says read-only");
    expect(claimWords({ destructive: true })).toBe("says destructive");
    expect(claimWords({})).toBe("no hints");
    expect(claimWords(null)).toBe("no hints");
    expect(claimWords(undefined)).toBe("no hints");
    expect(claimSentence({ readOnly: true })).toBe("The server says it's read-only.");
    expect(claimSentence({ destructive: true })).toBe("The server says it's destructive.");
    expect(claimSentence(null)).toBe("The server gives no hints.");
  });

  test("an id is suggested from the host, as the CLI does; an IP address suggests nothing", () => {
    expect(suggestId("https://mcp.linear.app/mcp")).toBe("linear");
    expect(suggestId("https://api.githubcopilot.com/mcp/")).toBe("githubcopilot");
    expect(suggestId("https://www.notion.so/mcp")).toBe("notion");
    expect(suggestId("http://homeassistant.local:8123/mcp_server/sse")).toBe("homeassistant");
    expect(suggestId("https://my_tracker.example.com/mcp")).toBe("my-tracker");
    expect(suggestId("http://127.0.0.1:4000/mcp")).toBeNull();
    expect(suggestId("http://[::1]:4000/mcp")).toBeNull();
    expect(suggestId("not a url")).toBeNull();
  });

  test("addresses: a full URL, http(s), and never a key in it", () => {
    expect(mcpUrlProblem("https://mcp.linear.app/mcp")).toBeNull();
    expect(mcpUrlProblem("http://127.0.0.1:4000/mcp")).toBeNull();
    expect(mcpUrlProblem("mcp.linear.app")).toContain("full address");
    expect(mcpUrlProblem("ftp://example.com/mcp")).toContain("https://");
    expect(mcpUrlProblem("https://example.com/mcp?api_key=abc")).toContain("keys go in the vault");
    expect(mcpUrlProblem("https://user:pw@example.com/mcp")).toContain("keys go in the vault");
  });

  test("saving classes: which tools would stop asking you", () => {
    const tools = [
      { name: "search", class: "read" },
      { name: "create_issue", class: "outward" },
      { name: "delete_repo", class: "delete" },
    ];
    expect(stopsAsking(tools, { create_issue: "create", delete_repo: "outward", search: "outward" })).toEqual(["create_issue"]);
    expect(stopsAsking(tools, {})).toEqual([]);
  });

  test("what a listing found, in one line", () => {
    expect(discoveredSummary("Tracker", { server: "tracker 1.2.3", tools: 5, skipped: 0 })).toBe("Tracker (tracker 1.2.3): 5 tools.");
    expect(discoveredSummary("Tracker", { server: null, tools: 1, skipped: 3 })).toBe("Tracker: 1 tool, 3 left out.");
  });
});
