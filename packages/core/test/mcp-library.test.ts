import { describe, expect, test } from "bun:test";
import { ConnectorManifest, MCP_LIBRARY, mcpLibraryEntry } from "../src/index.ts";

/* The library of hosted MCP servers (mcp-library.ts): each one addable as it stands. */

describe("the library of hosted MCP servers", () => {
  test("each has an id a connector may have, its own https address with no query or credentials, and says whether you sign in", () => {
    expect(new Set(MCP_LIBRARY.map((entry) => entry.id)).size).toBe(MCP_LIBRARY.length);
    for (const entry of MCP_LIBRARY) {
      const at = new URL(entry.url);
      expect(at.protocol).toBe("https:");
      expect(at.search + at.hash + at.username + at.password).toBe("");
      expect(["oauth", "none"]).toContain(entry.auth);
      expect(entry.description.length).toBeGreaterThan(10);
      // It makes a manifest the node accepts, as installing it does.
      const manifest = ConnectorManifest.safeParse({ id: entry.id, label: entry.label, origin: at.origin, mcp: { path: at.pathname || "/" }, tools: {}, ...(entry.auth === "oauth" ? { auth: { secret: entry.id, scheme: "oauth", oauth: { provider: "mcp", scopes: [] } } } : {}) });
      expect(manifest.success).toBe(true);
    }
    expect(mcpLibraryEntry("linear")?.url).toBe("https://mcp.linear.app/mcp");
    expect(mcpLibraryEntry("nothing-like-it")).toBeNull();
  });

  test("each one's address is on its own site: the service's own server, not someone else's", () => {
    for (const entry of MCP_LIBRARY) {
      const host = new URL(entry.url).hostname;
      expect([entry.id, host === entry.site || host.endsWith(`.${entry.site}`)]).toEqual([entry.id, true]);
    }
  });
});
