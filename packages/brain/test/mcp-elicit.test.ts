import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import type { BuiltMcpCall, ConnectorManifest } from "@galahad/core";
import type { Vault } from "@galahad/mind";
import { callMcpTool } from "../src/mcp-connectors.ts";

/*
 * A call that may ask you a question (elicitation) keeps its own time while its server works, and that time stops
 * while its question waits on you: a server that hangs is cut off as soon as before, one that asks is given your answer.
 * A real MCP server (the SDK's, keeping its sessions) on this machine; nothing leaves it.
 */

let upstream: ReturnType<typeof Bun.serve>;

function server(): McpServer {
  const mcp = new McpServer({ name: "slow", version: "1.0.0" });
  mcp.registerTool("hang", { description: "Never answers in time." }, async () => {
    await Bun.sleep(5_000);
    return { content: [{ type: "text", text: "too late" }] };
  });
  mcp.registerTool("ask", { description: "Asks where, then answers." }, async () => {
    const answer = await mcp.server.elicitInput({ message: "Where?", requestedSchema: { type: "object", properties: { where: { type: "string" } }, required: ["where"] } });
    return { content: [{ type: "text", text: answer.action === "accept" ? `there: ${answer.content?.where}` : answer.action }] };
  });
  return mcp;
}

beforeAll(() => {
  const sessions = new Map<string, WebStandardStreamableHTTPServerTransport>();
  upstream = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      const id = req.headers.get("mcp-session-id");
      let transport = id ? sessions.get(id) : undefined;
      if (!transport) {
        const made: WebStandardStreamableHTTPServerTransport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: () => crypto.randomUUID(), onsessioninitialized: (sid) => void sessions.set(sid, made) });
        transport = made;
        await server().connect(transport);
      }
      return transport.handleRequest(req);
    },
  });
});
afterAll(() => upstream?.stop(true));

const manifest = () => ({ id: "slow", label: "Slow", origin: `http://127.0.0.1:${upstream.port}`, mcp: { path: "/mcp" } }) as unknown as ConnectorManifest;
const call = (remote: string): BuiltMcpCall => ({ kind: "mcp", remote, args: {}, class: "read" }) as unknown as BuiltMcpCall;
const vault = {} as Vault;

describe("a call that may ask you", () => {
  test("a server that hangs is cut off at the call's own time, as one that can't ask is", async () => {
    const started = performance.now();
    const result = await callMcpTool({ vault, timeoutMs: 400, elicit: async () => ({ action: "decline" }) }, manifest(), call("hang"));
    expect(result).toMatchObject({ ok: false, body: expect.stringContaining("Request timed out") });
    expect(performance.now() - started).toBeLessThan(3_000);
  });

  test("its time stops while its question waits on you, however long you take past it", async () => {
    const result = await callMcpTool(
      { vault, timeoutMs: 400, elicit: async () => (await Bun.sleep(900), { action: "accept", content: { where: "the forge" } }) },
      manifest(),
      call("ask"),
    );
    expect(result).toMatchObject({ ok: true, body: "there: the forge" });
  });
});
