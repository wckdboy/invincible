import { afterAll, beforeAll, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type RouteName, routes } from "@galahad/core";
import { foundFleet, MindStore } from "@galahad/mind";
import { BUZZ_FRAME } from "../src/buzz.ts";
import type { Capabilities } from "../src/capabilities.ts";
import { type Daemon, startDaemon } from "../src/daemon.ts";
import { Home } from "../src/home.ts";
import { freePort } from "./ports.ts";

/*
 * Galahad in a Buzz community, end to end: `galahad acp install buzz` mints a credential that may only chat, and
 * `galahad acp --buzz`, as Buzz's harness starts it, answers a turn through the node and posts the answer where the turn
 * says, with Buzz's CLI (a stand-in that keeps what it was given). A real daemon; a stand-in model.
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

/** Buzz's CLI, stood in for: keeps its arguments and what it read. */
const buzz = join(root, "buzz");
writeFileSync(buzz, `#!/bin/sh\nprintf '%s\\n' "$@" > "${root}/args"\ncat > "${root}/posted"\n`);
chmodSync(buzz, 0o755);

const CHANNEL = "3f2a9c1e-5b7d-4e8f-9a0b-1c2d3e4f5a6b";
const EVENT = "ab".repeat(32);
const OWNER = "cd".repeat(32);
const TURN = `<context>\nScope: channel\nSession scope: channel\nChannel: eng (#${CHANNEL})\nIMPORTANT: This is a new top-level message. For ordinary replies in this turn, use \`--reply-to ${EVENT}\` on \`buzz messages send\` — the triggering message is the thread root.\n</context>\n\n<buzz-event type="mention">\nEvent ID: ${EVENT}\nChannel: eng (#${CHANNEL})\nKind: 9\nFrom: Ana (npub: npub1x, hex: ${OWNER})\nContent: @Galahad how do we deploy?\n</buzz-event>`;

const call = (name: RouteName, input: unknown) =>
  fetch(`http://127.0.0.1:${port}${routes[name].path}`, { method: routes[name].method, headers: { authorization: `Bearer ${home.adminToken()}`, "content-type": "application/json" }, body: JSON.stringify(input) });
const env = (extra: Record<string, string> = {}) => ({ ...process.env, GALAHAD_KEYSTORE: "file", ...extra });

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

test("installed for Buzz, he answers a turn there through his node, with nothing but chat, and his answer is posted where it was asked", async () => {
  const install = Bun.spawn([process.execPath, CLI, "acp", "install", "buzz", "--home", home.dir], { env: env(), stdout: "pipe", stderr: "pipe" });
  const [shown, installErr, installed] = await Promise.all([new Response(install.stdout).text(), new Response(install.stderr).text(), install.exited]);
  expect(installed, installErr).toBe(0);
  expect(shown).toContain('Arm "buzz" ready · scopes: chat');
  expect(shown).toContain(`--agent-args ${CLI},acp,--arm,buzz,--buzz,--home,${home.dir}`);

  // As buzz-acp starts him: the community's relay and the agent's key in his environment, the protocol on stdio.
  const agent = Bun.spawn([process.execPath, CLI, "acp", "--arm", "buzz", "--buzz", "--buzz-cli", buzz, "--home", home.dir], {
    env: env({ BUZZ_RELAY_URL: "wss://community.invalid", BUZZ_PRIVATE_KEY: "test-key-not-real", BUZZ_ACP_AGENT_OWNER: OWNER }),
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

  // Posted as his reply in the thread the mention began, naming you, his words as he wrote them.
  expect(readFileSync(join(root, "args"), "utf8").trim().split("\n")).toEqual(["messages", "send", "--channel", CHANNEL, "--reply-to", EVENT, "--mention", OWNER, "--content", "-"]);
  expect(readFileSync(join(root, "posted"), "utf8")).toBe("It deploys with scripts/deploy.sh.");
  // He was told where he answers, and was offered nothing that reaches past the chat.
  const asked = bodies.at(-1);
  expect(JSON.stringify(asked.messages)).toContain(BUZZ_FRAME.slice(0, 60));
  for (const tool of (asked.tools ?? []) as { function: { name: string } }[]) expect(["decide", "loop_draft"]).toContain(tool.function.name);

  agent.stdin.end();
  expect(await agent.exited).toBe(0);
  await reading;
}, 30_000);

test("--buzz outside Buzz's harness says what it needs, and starts nothing", async () => {
  const run = Bun.spawn([process.execPath, CLI, "acp", "--arm", "buzz", "--buzz", "--buzz-cli", buzz, "--home", home.dir], { env: env({ BUZZ_PRIVATE_KEY: "", BUZZ_RELAY_URL: "" }), stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const [said, code] = await Promise.all([new Response(run.stderr).text(), run.exited]);
  expect(code).not.toBe(0);
  expect(said).toContain("BUZZ_RELAY_URL and BUZZ_PRIVATE_KEY");
});
