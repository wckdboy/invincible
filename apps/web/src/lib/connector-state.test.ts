import { describe, expect, test } from "bun:test";
import { connectorState } from "./connector-state.ts";

describe("where a connector stands, in words", () => {
  test("a hosted MCP server needs no app of yours: until you sign in it is just not signed in", () => {
    expect(connectorState({ key: "missing", oauth: { provider: "mcp", account: null } })).toEqual({ label: "not signed in", tone: "warn" });
    expect(connectorState({ key: "ready", oauth: { provider: "mcp", account: null } })).toEqual({ label: "signed in", tone: "ok" });
    // Mail's sign-in needs the app you registered first; a key is a key.
    expect(connectorState({ key: "missing", oauth: { provider: "google", account: null } })?.label).toBe("needs your app");
    expect(connectorState({ key: "missing", oauth: null })?.label).toBe("needs a key");
    expect(connectorState({ key: "unheard-of", oauth: null })).toBeNull();
  });
});
