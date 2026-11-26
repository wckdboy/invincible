import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type RouteName, routes } from "@galahad/core";
import { foundFleet, MindStore } from "@galahad/mind";
import type { Capabilities } from "../src/capabilities.ts";
import { type Daemon, startDaemon } from "../src/daemon.ts";
import { Home } from "../src/home.ts";
import { freePort } from "./ports.ts";

/*
 * Galahad as an ACP agent, end to end: `galahad acp install` mints a credential that may only chat, and `galahad acp`,
 * as an ACP client starts it, answers a prompt through the node. A real daemon; a stand-in model.
 */

const caps: Capabilities = { os: "linux", arch: "x64", hostname: "acp-test", cores: 4, cpu: "test", memoryGb: 8, hasBattery: false, gpu: [], docker: false, vm: { kvm: false, tools: [] }, tools: [], localModels: [], tailscale: null };
const root = mkdtempSync(join(tmpdir(), "galahad-acp-"));
const home = new Home(join(root, "node"));
const port = freePort();
let daemon: Daemon;
const CLI = join(import.meta.dir, "../src/cli.ts");

const bodies: any[] = [];
const model = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  fetch: async (req) => {
    bodies.push(await req.json());
    return new Response(`data: ${JSON.stringify({ choices: [{ delta: { content: "It deploys with scripts/deploy.sh." } }] })}\n\ndata: [DONE]\n\n`, { headers: { "content-type": "text/event-stream" } });
  },
});

const TURN = "How do we deploy?";

const call = (name: RouteName, input: unknown) =>
  fetch(`http://127.0.0.1:${port}${routes[name].path}`, { method: routes[name].method, headers: { authorization: `Bearer ${home.adminToken()}`, "content-type": "application/json" }, body: JSON.stringify(input) });
const env = () => ({ ...process.env, GALAHAD_KEYSTORE: "file" });

beforeAll(async () => {
  const { identity, keystore } = await home.createIdentity("file");
  const store = new MindStore(home.mindPath);
  const fleet = foundFleet(store, identity, { fleetName: "camelot", nodeName: "acp-node" });
  store.close();
  home.writeConfig({ v: 1, name: "acp-node", fleet, port, keystore, advertise: "127.0.0.1" });
  daemon = await startDaemon(home, { capabilities: caps, proxyPort: freePort(), log: () => {} });
  expect((await call("setProvider", { id: "stand-in", kind: "openai", baseUrl: `http://127.0.0.1:${model.port}/v1` })).status).toBe(200);
  expect((await call("setRoster", { role: "planner", models: ["stand-in/m"] })).status).toBe(200);
});
afterAll(async () => {
  await daemon?.stop();
  model.stop(true);
  rmSync(root, { recursive: true, force: true });
});

test("installed for an ACP client, he answers a prompt through his node, with nothing but chat", async () => {
  const install = Bun.spawn([process.execPath, CLI, "acp", "install", "--home", home.dir], { env: env(), stdout: "pipe", stderr: "pipe" });
  const [shown, installErr, installed] = await Promise.all([new Response(install.stdout).text(), new Response(install.stderr).text(), install.exited]);
  expect(installed, installErr).toBe(0);
  expect(shown).toContain('Arm "acp" ready · scopes: chat');
  expect(shown).toContain(`${CLI} acp --arm acp --home ${home.dir}`);

  // As a client starts him: the protocol on stdio.
  const agent = Bun.spawn([process.execPath, CLI, "acp", "--arm", "acp", "--home", home.dir], {
    env: env(),
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  const out: any[] = [];
  const reading = (async () => {
    let buffer = "";
    for await (const chunk of agent.stdout) {
      buffer += new TextDecoder().decode(chunk);
      let newline: number;
      while ((newline = buffer.indexOf("\n")) >= 0) {
        out.push(JSON.parse(buffer.slice(0, newline)));
        buffer = buffer.slice(newline + 1);
      }
    }
  })();
  const send = (id: number, method: string, params: object) => {
    agent.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    agent.stdin.flush();
  };
  const answer = async (id: number) => {
    for (let n = 0; n < 1000 && !out.some((m) => m.id === id); n++) await Bun.sleep(10);
    return out.find((m) => m.id === id);
  };
  send(1, "initialize", { protocolVersion: 2, clientCapabilities: {} });
  expect((await answer(1)).result.agentInfo.name).toBe("galahad");
  send(2, "session/new", { cwd: root, mcpServers: [] });
  const { sessionId } = (await answer(2)).result;
  send(3, "session/prompt", { sessionId, prompt: [{ type: "text", text: TURN }] });
  expect((await answer(3)).result).toEqual({ stopReason: "end_turn" });

  // His words streamed back to the client as he wrote them.
  const said = out.filter((m) => m.method === "session/update" && m.params.update.sessionUpdate === "agent_message_chunk").map((m) => m.params.update.content.text).join("");
  expect(said).toBe("It deploys with scripts/deploy.sh.");
  // He was asked what was prompted, and was offered nothing that reaches past the chat.
  const asked = bodies.at(-1);
  expect(JSON.stringify(asked.messages)).toContain(TURN);
  for (const tool of (asked.tools ?? []) as { function: { name: string } }[]) expect(["decide", "loop_draft"]).toContain(tool.function.name);

  agent.stdin.end();
  expect(await agent.exited).toBe(0);
  await reading;
}, 30_000);
