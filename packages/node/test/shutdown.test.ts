import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type ChatStreamEvent, type ConversationSummary, type RouteName, routes } from "@galahad/core";
import { foundFleet, MindStore } from "@galahad/mind";
import type { Capabilities } from "../src/capabilities.ts";
import { type Daemon, startDaemon } from "../src/daemon.ts";
import { Home } from "../src/home.ts";
import { freePort } from "./ports.ts";

/*
 * Stopping a node: it stops taking new requests first, lets the ones under way finish,
 * and only then closes what they write to. A chat answered while the node stops is kept.
 */

const caps: Capabilities = {
  os: "linux",
  arch: "x64",
  hostname: "shutdown-test",
  cores: 4,
  cpu: "test",
  memoryGb: 8,
  hasBattery: false,
  gpu: [],
  docker: false,
  vm: { kvm: false, tools: [] },
  tools: [],
  localModels: [],
  tailscale: null,
};

const root = mkdtempSync(join(tmpdir(), "galahad-shutdown-"));
const home = new Home(join(root, "node"));
const port = freePort();

/** A stand-in model that thinks for a while before it answers. */
let asked: () => void = () => {};
const model = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  fetch: async () => {
    asked();
    await Bun.sleep(400);
    return new Response(`data: ${JSON.stringify({ choices: [{ delta: { content: "Kept, even while stopping." } }] })}\n\ndata: [DONE]\n\n`, {
      headers: { "content-type": "text/event-stream" },
    });
  },
});

async function call(name: RouteName, input?: unknown): Promise<Response> {
  const route = routes[name];
  return fetch(`http://127.0.0.1:${port}${route.path}`, {
    method: route.method,
    headers: { authorization: `Bearer ${home.adminToken()}`, "content-type": "application/json" },
    body: route.method === "POST" ? JSON.stringify(input ?? {}) : undefined,
  });
}

async function start(): Promise<Daemon> {
  return startDaemon(home, { capabilities: caps, proxyPort: freePort(), log: () => {} });
}

afterAll(() => {
  model.stop(true);
  rmSync(root, { recursive: true, force: true });
});

describe("a node stopping", () => {
  test("refuses new requests at once, finishes the chat under way, keeps it, then closes", async () => {
    const { identity, keystore } = await home.createIdentity("file");
    const store = new MindStore(home.mindPath);
    const fleet = foundFleet(store, identity, { fleetName: "camelot", nodeName: "stopper" });
    store.close();
    home.writeConfig({ v: 1, name: "stopper", fleet, port, keystore, advertise: "127.0.0.1" });
    let daemon = await start();
    expect((await call("setProvider", { id: "stand-in", kind: "openai", baseUrl: `http://127.0.0.1:${model.port}/v1` })).status).toBe(200);
    expect((await call("setRoster", { role: "planner", models: ["stand-in/m"] })).status).toBe(200);

    const reached = new Promise<void>((resolve) => (asked = resolve));
    const chat = call("chat", { save: true, messages: [{ role: "user", content: "Are you still there?" }] });
    await reached; // the answer is being thought about
    const stopping = daemon.stop();
    // From the moment it's asked to stop, nothing new gets in.
    await expect(fetch(`http://127.0.0.1:${port}/api/whoami`, { headers: { authorization: `Bearer ${home.adminToken()}` } })).rejects.toThrow();
    const events = (await (await chat).text())
      .split("\n")
      .filter((line) => line.startsWith("data: "))
      .map((line) => JSON.parse(line.slice(6)) as ChatStreamEvent);
    expect(events.map((e) => e.type)).toContain("done");
    expect(events.some((e) => e.type === "error")).toBe(false);
    await stopping;

    // Back up: the conversation was kept, answer and all.
    daemon = await start();
    try {
      const { conversations } = (await (await call("conversations")).json()) as { conversations: ConversationSummary[] };
      expect(conversations).toHaveLength(1);
      const { conversation: kept } = (await (await call("conversation", { id: conversations[0]!.id })).json()) as { conversation: { messages: { role: string; content: string }[] } };
      expect(kept.messages.map((m) => m.content)).toEqual(["Are you still there?", "Kept, even while stopping."]);
    } finally {
      await daemon.stop();
    }
  });
});
