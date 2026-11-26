import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { type QuestionView, type RouteName, routes } from "@galahad/core";
import { foundFleet, MindStore } from "@galahad/mind";
import { z } from "zod";
import type { Capabilities } from "../src/capabilities.ts";
import { type Daemon, startDaemon } from "../src/daemon.ts";
import { Home } from "../src/home.ts";
import { freePort } from "./ports.ts";

/*
 * An MCP server that asks you a question in the middle of a call (elicitation), end to end: a real MCP server (the
 * SDK's, keeping its sessions, as a server that asks must) and a node. The call waits while its question waits in your
 * Inbox; your answer goes back and the call goes on with it; your no, too. An agent can neither see what you'd type
 * nor answer for you.
 */

const caps: Capabilities = {
  os: "linux",
  arch: "x64",
  hostname: "mcp-questions-test",
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

const KEY = "tracker_questions_test_key_0123456789";
const root = mkdtempSync(join(tmpdir(), "galahad-mcp-questions-"));
const home = new Home(join(root, "node"));
const port = freePort();
let daemon: Daemon;
let upstream: ReturnType<typeof Bun.serve>;
let armToken: string;

/** A tracker that asks where an issue goes before it files it. */
function tracker(): McpServer {
  const server = new McpServer({ name: "tracker", version: "2.0.0" });
  server.registerTool("file_issue", { description: "Files an issue, asking you where.", inputSchema: { title: z.string() }, annotations: { readOnlyHint: true } }, async (args) => {
    const answer = await server.server.elicitInput({
      message: "Which repository should it go in?",
      requestedSchema: { type: "object", properties: { repo: { type: "string", title: "Repository" }, urgent: { type: "boolean", title: "Urgent?" } }, required: ["repo"] },
    });
    return { content: [{ type: "text", text: answer.action === "accept" ? `filed "${args.title}" in ${answer.content?.repo}${answer.content?.urgent ? ", urgent" : ""}` : `not filed (${answer.action})` }] };
  });
  return server;
}

async function as<T = any>(token: string, name: RouteName, input?: unknown): Promise<{ status: number; body: T }> {
  const route = routes[name];
  const response = await fetch(`http://127.0.0.1:${port}${route.path}`, {
    method: route.method,
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: route.method === "POST" ? JSON.stringify(input ?? {}) : undefined,
  });
  return { status: response.status, body: (await response.json()) as T };
}
const admin = <T = any>(name: RouteName, input?: unknown) => as<T>(home.adminToken(), name, input);
async function waiting(): Promise<QuestionView> {
  for (let i = 0; i < 200; i++) {
    const { questions } = (await admin<{ questions: QuestionView[] }>("questions")).body;
    if (questions.length) return questions[0]!;
    await Bun.sleep(25);
  }
  throw new Error("no question came");
}

beforeAll(async () => {
  // Its sessions kept, one transport each: the answer to its question comes back on the session that asked it.
  const sessions = new Map<string, WebStandardStreamableHTTPServerTransport>();
  upstream = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      if (req.headers.get("authorization") !== `Bearer ${KEY}`) return new Response("unauthorized", { status: 401 });
      const id = req.headers.get("mcp-session-id");
      let transport = id ? sessions.get(id) : undefined;
      if (!transport) {
        const made: WebStandardStreamableHTTPServerTransport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: () => crypto.randomUUID(), onsessioninitialized: (sid) => void sessions.set(sid, made) });
        transport = made;
        await tracker().connect(transport);
      }
      return transport.handleRequest(req);
    },
  });
  const { identity, keystore } = await home.createIdentity("file");
  const store = new MindStore(home.mindPath);
  const fleet = foundFleet(store, identity, { fleetName: "camelot", nodeName: "ultra" });
  store.close();
  home.writeConfig({ v: 1, name: "ultra", fleet, port, keystore, advertise: "127.0.0.1" });
  daemon = await startDaemon(home, { capabilities: caps, proxyPort: freePort(), log: () => {} });
  armToken = (await admin<{ token: string }>("mintArm", { label: "test-arm" })).body.token;
  expect((await admin("setConnector", { id: "tracker", mcp: { url: `http://127.0.0.1:${upstream.port}/mcp`, label: "Tracker", auth: "bearer" } })).status).toBe(200);
  expect((await admin("setSecret", { name: "tracker", value: KEY, connector: "tracker" })).status).toBe(200);
  expect((await admin("setConnector", { id: "tracker", mcp: { url: `http://127.0.0.1:${upstream.port}/mcp` } })).body.discovered).toMatchObject({ tools: 1 });
});

afterAll(async () => {
  await daemon?.stop();
  upstream?.stop(true);
  rmSync(root, { recursive: true, force: true });
});

describe("a question in the middle of a call", () => {
  test("waits in your Inbox while its call waits; your answer goes back, and the call goes on with it", async () => {
    const call = as<{ status: string; result: { ok: boolean; body: string } }>(armToken, "callConnector", { connector: "tracker", tool: "file_issue", args: { title: "Disk full" } });
    const q = await waiting();
    expect(q).toMatchObject({ connector: "tracker", label: "Tracker", message: "Which repository should it go in?" });
    expect(q.fields.map((f) => [f.name, f.kind, f.required])).toEqual([["repo", "text", true], ["urgent", "yes-no", false]]);
    // An agent may read that one waits, never answer it.
    expect((await as(armToken, "answerQuestion", { id: q.id, accept: true, content: { repo: "x/y" } })).status).toBe(403);
    expect((await admin("answerQuestion", { id: q.id, accept: true, content: { repo: "amiriteorg/galahad", urgent: true } })).status).toBe(200);
    expect((await call).body).toMatchObject({ status: "done", result: { ok: true, body: 'filed "Disk full" in amiriteorg/galahad, urgent' } });
    expect((await admin<{ questions: QuestionView[] }>("questions")).body.questions).toEqual([]);
  }, 20_000);

  test("your no goes back as one: the call goes on without what it asked", async () => {
    const call = as<{ result: { body: string } }>(armToken, "callConnector", { connector: "tracker", tool: "file_issue", args: { title: "Flaky test" } });
    const q = await waiting();
    expect((await admin("answerQuestion", { id: q.id, accept: false })).status).toBe(200);
    expect((await call).body.result.body).toBe("not filed (decline)");
  }, 20_000);
});
