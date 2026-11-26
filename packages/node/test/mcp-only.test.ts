import { expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createMcpServer } from "../src/mcp.ts";
import { toolsFor } from "../src/tools.ts";

/*
 * `galahad mcp --tools a,b`: the MCP server offers those tools and no others, whatever its arm's scopes would allow. A
 * grant to an agent on another machine (qamp-grants.ts) runs it so: its arm holds mind:read for `fleet`, and mind:read
 * would also offer your memories (recall, the archive, skills). Q-AMP's bridge serves only the granted tools too; this
 * keeps them out even if that allow-list failed.
 */

async function listed(only: string[] | undefined): Promise<string[]> {
  const server = createMcpServer({ base: "http://127.0.0.1:1", token: "arm_fake_token_for_tests", version: "test", scopes: ["mind:read", "mind:write", "sandbox", "connect"], ...(only ? { only } : {}) });
  const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  const client = new Client({ name: "only-test", version: "1" });
  await client.connect(clientSide);
  try {
    return (await client.listTools()).tools.map((t) => t.name).sort();
  } finally {
    await client.close();
  }
}

test("with tools named, only those are offered: never recall, the archive or anything else mind:read reaches", async () => {
  expect(await listed(["fleet", "compute"])).toEqual(["compute", "fleet"]);
  const all = await listed(undefined);
  expect(all).toContain("recall");
  expect(all).toContain("archive_search");
  expect(all.length).toBe(toolsFor(["mind:read", "mind:write", "sandbox", "connect"]).length);
});

test("a tool named that the arm's scopes don't reach is still not offered; none named, none offered", async () => {
  // bank_status needs bank:read, which this arm doesn't hold.
  expect(await listed(["fleet", "bank_status"])).toEqual(["fleet"]);
  // With none, the server has no tools at all: it doesn't even answer a listing (JSON-RPC's "method not found").
  expect(await listed([]).catch((error: { code?: number }) => error.code)).toBe(-32601);
});
