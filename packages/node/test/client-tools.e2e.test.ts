import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type ChatStreamEvent, type RouteName, routes } from "@galahad/core";
import { foundFleet, MindStore } from "@galahad/mind";
import type { Capabilities } from "../src/capabilities.ts";
import { type Daemon, startDaemon } from "../src/daemon.ts";
import { Home } from "../src/home.ts";
import { freePort } from "./ports.ts";

/*
 * Tools the caller runs (clientTools: a quest's engineer's shell and files), end to end: a real daemon over real HTTP
 * and a stand-in model that calls one. The node offers them, never runs one, ends the answer with its calls and carry,
 * and gives the next request's calls, carry and results back to the model as its provider takes them. Every result and
 * every call's input is scanned for secrets, as words are.
 */

const caps: Capabilities = { os: "linux", arch: "x64", hostname: "client-tools-test", cores: 4, cpu: "test", memoryGb: 8, hasBattery: false, gpu: [], docker: false, vm: { kvm: false, tools: [] }, tools: [], localModels: [], tailscale: null };

const root = mkdtempSync(join(tmpdir(), "galahad-client-tools-"));
const home = new Home(join(root, "node"));
const port = freePort();
let daemon: Daemon;

const bodies: any[] = [];
const sse = (...chunks: object[]) => new Response(chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join("") + "data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } });
const model = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  fetch: async (req) => {
    const body = await req.json();
    bodies.push(body);
    // Asked with no results yet: it reads a file (thinking first); given them: it is done.
    if (!body.messages.some((m: { role: string }) => m.role === "tool")) {
      return sse({ choices: [{ delta: { reasoning_content: "Read it first." } }] }, { choices: [{ delta: { tool_calls: [{ index: 0, id: "call_1", function: { name: "read", arguments: '{"path":"a.ts"}' } }] } }] });
    }
    return sse({ choices: [{ delta: { content: "DONE\nRead it." } }] });
  },
});

const READ = { name: "read", description: "Read a file.", inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } };

const call = (name: RouteName, input?: unknown) => {
  const route = routes[name];
  return fetch(`http://127.0.0.1:${port}${route.path}`, {
    method: route.method,
    headers: { authorization: `Bearer ${home.adminToken()}`, "content-type": "application/json" },
    body: route.method === "POST" ? JSON.stringify(input ?? {}) : undefined,
  });
};
const json = async (response: Promise<Response>) => {
  const r = await response;
  if (!r.ok) throw new Error(`${r.status} ${await r.text()}`);
  return r.json();
};
/** A chat call's events, read to its end. */
async function events(input: object): Promise<ChatStreamEvent[]> {
  const response = await call("chat", input);
  if (!response.ok) throw new Error(`${response.status} ${await response.text()}`);
  return (await response.text())
    .split("\n")
    .filter((l) => l.startsWith("data: "))
    .map((l) => JSON.parse(l.slice(6)) as ChatStreamEvent);
}

beforeAll(async () => {
  const { identity, keystore } = await home.createIdentity("file");
  const store = new MindStore(home.mindPath);
  const fleet = foundFleet(store, identity, { fleetName: "camelot", nodeName: "keep" });
  store.close();
  home.writeConfig({ v: 1, name: "keep", fleet, port, keystore, advertise: "127.0.0.1" });
  daemon = await startDaemon(home, { capabilities: caps, proxyPort: freePort(), log: () => {} });
  await json(call("setProvider", { id: "ollama", kind: "openai", baseUrl: `http://127.0.0.1:${model.port}/v1` }));
  await json(call("setRoster", { role: "engineer", models: ["ollama/qwen3:8b"] }));
});

afterAll(async () => {
  await daemon?.stop();
  model.stop(true);
  rmSync(root, { recursive: true, force: true });
});

describe("tools the caller runs, through the chat route", () => {
  const asked = { role: "engineer", tools: false, coding: true, memories: false, clientTools: [READ] };
  let carry: string | undefined;

  test("are offered to the model, and an answer that calls them ends with its calls and carry", async () => {
    bodies.length = 0;
    const said = await events({ ...asked, messages: [{ role: "user", content: "Fix a.ts." }] });
    const calls = said.find((e) => e.type === "calls") as Extract<ChatStreamEvent, { type: "calls" }>;
    expect(calls.calls).toEqual([{ id: "call_1", name: "read", input: { path: "a.ts" } }]);
    carry = calls.carry;
    expect(JSON.parse(carry!)).toMatchObject({ provider: "ollama", model: "qwen3:8b", reasoning: "Read it first." });
    expect(said.at(-1)!.type).toBe("done");
    expect(bodies[0].tools.map((t: { function: { name: string } }) => t.function.name)).toEqual(["read"]);
  });

  test("the next request gives the model back its call, its reasoning and what the call came to", async () => {
    bodies.length = 0;
    const said = await events({
      ...asked,
      messages: [
        { role: "user", content: "Fix a.ts." },
        { role: "assistant", content: "", calls: [{ id: "call_1", name: "read", input: { path: "a.ts" } }], carry },
        { role: "user", content: "", results: [{ id: "call_1", content: "a.ts: lines 1–1 of 1\n     1\tconst a = 1;" }] },
      ],
    });
    expect(said.filter((e) => e.type === "text").map((e) => (e as { text: string }).text).join("")).toBe("DONE\nRead it.");
    const sent = bodies[0].messages;
    expect(sent.at(-2)).toEqual({ role: "assistant", content: null, reasoning_content: "Read it first.", tool_calls: [{ id: "call_1", type: "function", function: { name: "read", arguments: '{"path":"a.ts"}' } }] });
    expect(sent.at(-1)).toEqual({ role: "tool", tool_call_id: "call_1", content: "a.ts: lines 1–1 of 1\n     1\tconst a = 1;" });
  });

  test("a secret in what a tool came to, or in what it was called with, is refused before any model sees it", async () => {
    const key = `sk-ant-api03-${"FAKE".repeat(8)}`;
    bodies.length = 0;
    const inResult = await call("chat", { ...asked, messages: [{ role: "user", content: "Fix it." }, { role: "assistant", content: "", calls: [{ id: "c", name: "read", input: { path: ".env" } }] }, { role: "user", content: "", results: [{ id: "c", content: `KEY=${key}` }] }] });
    expect(inResult.status).toBe(422);
    const inCall = await call("chat", { ...asked, messages: [{ role: "user", content: "Fix it." }, { role: "assistant", content: "", calls: [{ id: "c", name: "read", input: { path: key } }] }, { role: "user", content: "", results: [{ id: "c", content: "No such file." }] }] });
    expect(inCall.status).toBe(422);
    expect(bodies).toHaveLength(0);
  });

  test("they go only without Galahad's own tools, and never in a kept chat", async () => {
    expect((await call("chat", { ...asked, tools: true, messages: [{ role: "user", content: "x" }] })).status).toBe(400);
    expect((await call("chat", { ...asked, save: true, messages: [{ role: "user", content: "x" }] })).status).toBe(400);
  });
});
