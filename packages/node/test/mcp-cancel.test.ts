import { expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createMcpServer } from "../src/mcp.ts";

/*
 * A caller that cancels a call (MCP's notifications/cancelled: an agent stopping, or Q-AMP's bridge passing a cancel on
 * from an agent on another machine, 25 November 2026) is heard by the node: the tool's request to it is aborted, so the
 * work it started there can stop. A stand-in node that never answers says when its request went away.
 */
test("a caller's cancel reaches the node: the tool's request to it is aborted", async () => {
  let started = () => {};
  let ended = () => {};
  const asked = new Promise<void>((done) => (started = done));
  const aborted = new Promise<void>((done) => (ended = done));
  const node = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch(request) {
      started();
      request.signal.addEventListener("abort", () => ended());
      return new Promise<Response>(() => {});
    },
  });
  const server = createMcpServer({ base: `http://127.0.0.1:${node.port}`, token: "arm_fake_token_for_tests", version: "test", scopes: ["mind:read"] });
  const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  const client = new Client({ name: "cancel-test", version: "1" });
  await client.connect(clientSide);
  try {
    const stop = new AbortController();
    const call = client.callTool({ name: "compute", arguments: {} }, undefined, { signal: stop.signal }).catch((error: unknown) => error);
    await asked;
    stop.abort("the caller stopped");
    const heard = await Promise.race([aborted.then(() => true), Bun.sleep(2000).then(() => false)]);
    expect(heard).toBe(true);
    await call;
  } finally {
    await client.close();
    node.stop(true);
  }
});
