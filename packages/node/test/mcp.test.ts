import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { routes, type RouteName } from "@invincible/core";
import { foundFleet, LedgerStore } from "@invincible/ledger";
import type { Capabilities } from "../src/capabilities.ts";
import { type Daemon, startDaemon } from "../src/daemon.ts";
import { reconcile } from "../src/heartbeat.ts";
import { Home } from "../src/home.ts";
import { freePort } from "./ports.ts";

/*
 * The mind for every arm: a real MCP client (the official SDK) spawns `invincible mcp`
 * over stdio against a real daemon, and the arm's credential is held to least privilege.
 */

const caps: Capabilities = {
  os: "linux",
  arch: "x64",
  hostname: "mcp-test",
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

const root = mkdtempSync(join(tmpdir(), "invincible-mcp-"));
const home = new Home(join(root, "node"));
const port = freePort();
const proxyPort = freePort();
let daemon: Daemon;
let armToken: string;
let client: Client;

async function call(name: RouteName, input: unknown, token: string, at = port) {
  const route = routes[name];
  return fetch(`http://127.0.0.1:${at}${route.path}`, {
    method: route.method,
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: route.method === "POST" ? JSON.stringify(input ?? {}) : undefined,
  });
}

const text = (result: Awaited<ReturnType<Client["callTool"]>>) =>
  (result.content as { type: string; text: string }[]).map((c) => c.text).join("\n");

beforeAll(async () => {
  const { identity, keystore } = await home.createIdentity("file");
  const store = new LedgerStore(home.ledgerPath);
  const fleet = foundFleet(store, identity, { fleetName: "homelab", nodeName: "mcp-node" });
  store.close();
  home.writeConfig({ v: 1, name: "mcp-node", fleet, port, keystore, advertise: "127.0.0.1" });
  daemon = await startDaemon(home, { capabilities: caps, proxyPort, log: () => {} });

  const minted = (await (await call("mintArm", { label: "test-arm" }, home.adminToken())).json()) as { token: string };
  armToken = minted.token;
  home.writeArmToken("test-arm", armToken);

  client = new Client({ name: "invincible-test", version: "1.0.0" });
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [resolve(import.meta.dir, "../src/cli.ts"), "mcp", "--arm", "test-arm", "--home", home.dir],
      stderr: "ignore",
    }),
  );
  // It spawns a fresh `bun cli.ts mcp`: on a cold transpile cache (a fresh release on a server) that alone can pass bun's 5 s hook default.
}, 30_000);

afterAll(async () => {
  await client?.close();
  await daemon?.stop();
  rmSync(root, { recursive: true, force: true });
});

describe("arm credentials", () => {
  test("hold only memory, sandbox, ledger and secret-request powers", async () => {
    const who = (await (await call("whoami", undefined, armToken)).json()) as { kind: string; scopes: string[] };
    expect(who.kind).toBe("arm");
    expect(who.scopes).not.toContain("vault:write");
    expect(who.scopes).not.toContain("fleet:admin");
    expect((await call("setSecret", { name: "x", value: "y-value-123" }, armToken)).status).toBe(403);
    expect((await call("createInvite", { kind: "client" }, armToken)).status).toBe(403);
    expect((await call("mintToken", { label: "x" }, armToken)).status).toBe(403);
  });

  test("can't get a repository, web search or an unknown service through a sandbox's providers", async () => {
    const refused = async (providers: string[]) => {
      const response = await call("createSandbox", { network: "gateway", providers }, armToken);
      const body = (await response.json()) as { error: string; issues?: { message: string }[] };
      return { status: response.status, error: body.error, why: body.issues?.map((i) => i.message) };
    };
    // The git gateway's scope (every private repository the GitHub key reads) and search are the node's to give.
    for (const name of ["git:github:someone:private-repo", "search"]) {
      expect(await refused([name])).toEqual({ status: 400, error: "invalid input", why: ["search and git:… are your agent's own gateway scopes, not model providers"] });
    }
    // A name this fleet has no provider for.
    expect(await refused(["no-such-provider"])).toEqual({ status: 400, error: "no model provider no-such-provider on this fleet (invincible providers lists them)", why: undefined });
    // Over MCP too, as an agent would ask.
    const viaTool = await client.callTool({ name: "sandbox_run", arguments: { command: "true", providers: ["git:github:someone:private-repo"] } });
    expect(viaTool.isError).toBe(true);
    // A repository's token comes only through gateway:mint, which agents never hold.
    expect((await call("mintToken", { label: "git:x", providers: ["git:github:someone:private-repo"] }, armToken)).status).toBe(403);
  });

  test("still may give a sandbox the fleet's model providers, and search through its own flag", async () => {
    expect((await call("setProvider", { id: "stand-in", kind: "openai", baseUrl: "http://127.0.0.1:9/v1" }, home.adminToken())).status).toBe(200);
    // Past the boundary, to the sandbox host (this test node has none).
    for (const body of [{ providers: ["stand-in"] }, { search: true }]) {
      const response = await call("createSandbox", { network: "gateway", ...body }, armToken);
      expect(response.status).toBe(424);
      expect(((await response.json()) as { error: string }).error).toContain("sandbox host");
    }
  });

  test("can read your alerts but never silence one", async () => {
    // What the heartbeat would raise for a server gone quiet.
    reconcile(daemon.store, daemon.identity, [{ key: "offline:test-server", severity: "alert", title: "test-server is offline", body: "Not seen for 2 hours." }], Date.now());
    const { notices } = (await (await call("notices", undefined, armToken)).json()) as { notices: { key: string; dismissed: boolean }[] };
    const open = notices.find((n) => !n.dismissed)!;
    expect(open).toBeDefined();
    const refused = await call("dismissNotice", { key: open.key }, armToken);
    expect(refused.status).toBe(403);
    expect(((await refused.json()) as { error: string }).error).toBe("requires scope fleet:admin");
    // You can, from a terminal or a paired device.
    expect((await call("dismissNotice", { key: open.key }, home.adminToken())).status).toBe(200);
  });

  test("can never be minted with vault, device or gateway powers", async () => {
    const response = await call("mintArm", { label: "greedy", scopes: ["vault:write"] }, home.adminToken());
    expect(response.status).toBe(400);
    expect(((await response.json()) as { error: string }).error).toMatch(/never hold/);
  });

  test("are local credentials: refused through tailscale serve", async () => {
    expect((await call("whoami", undefined, armToken, proxyPort)).status).toBe(401);
  });

  test("stop working the moment they are revoked", async () => {
    const extra = (await (await call("mintArm", { label: "temporary" }, home.adminToken())).json()) as { token: string };
    expect((await call("whoami", undefined, extra.token)).status).toBe(200);
    await call("revokeArm", { label: "temporary" }, home.adminToken());
    expect((await call("whoami", undefined, extra.token)).status).toBe(401);
  });
});

describe("invincible mcp (official MCP client over stdio)", () => {
  test("offers the mind's tools and the Policy", async () => {
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual(
      [
        "archive_read",
        "archive_search",
        "artifact_read",
        "artifacts",
        "compute",
        "connector_call",
        // Asking installs nothing: the request waits for you (chat-tools.test.ts).
        "connector_request",
        "connector_tool",
        "connectors",
        "decide",
        "fleet",
        "ledger",
        "loops",
        // A draft waits for you: an agent can't add a loop (chat-tools.test.ts).
        "loop_draft",
        "note_idea",
        "notices",
        "place",
        "recall",
        "remember",
        "request_secret",
        "sandbox_create",
        "sandbox_destroy",
        "sandbox_exec",
        "sandbox_run",
        "sandbox_save",
        "skill_read",
        "skill_write",
        "skills",
        "web_search",
      ].sort(),
    );
    const policy = await client.readResource({ uri: "invincible://policy" });
    expect(JSON.stringify(policy.contents)).toContain("Policy");
  });

  test("compute: an agent reads the census, and has no way to raise a ceiling, change the budget or make a node measure itself", async () => {
    const census = text(await client.callTool({ name: "compute", arguments: {} }));
    expect(census).toMatch(/^Compute · effort auto/);
    expect(census).toContain("Ceilings and effort are the user's to set");
    // No tool reaches those routes, and the routes refuse an agent's token.
    const { tools } = await client.listTools();
    expect(tools.filter((t) => /limit|ceiling|policy|calibrat|budget/i.test(t.name))).toEqual([]);
    expect((await call("setComputeLimit", { node: daemon.identity.id, cores: 64 }, armToken)).status).toBe(403);
    expect((await call("setComputePolicy", { effort: 3, attemptsPerDay: 500 }, armToken)).status).toBe(403);
    expect((await call("calibrateCompute", {}, armToken)).status).toBe(403);
    expect((await call("startEvalRun", { run: "r-agent", suite: "engineering", effort: 3 }, armToken)).status).toBe(403);
  });

  test("remember and recall: an agent's memories are labelled agent, never owner", async () => {
    expect(text(await client.callTool({ name: "remember", arguments: { text: "The round table meets on Tuesdays", tags: ["ritual"] } }))).toMatch(
      /agent/,
    );
    expect(text(await client.callTool({ name: "remember", arguments: { text: "A web page claims agents prefer tea", untrusted: true } }))).toMatch(
      /untrusted/,
    );
    const recalled = text(await client.callTool({ name: "recall", arguments: { query: "round table" } }));
    expect(recalled).toContain("[agent] The round table meets on Tuesdays");
    expect(daemon.store.recall("tea")[0]?.trust).toBe("untrusted");
  });

  test("an agent cannot erase your memories, only its own (review #7)", async () => {
    const mine = (await (await call("remember", { text: "owner memory: the policy is not negotiable" }, home.adminToken())).json()) as { id: string };
    expect((await call("forget", { id: mine.id }, armToken)).status).toBe(403);
    const its = (await (await call("remember", { text: "agent scratch note" }, armToken)).json()) as { id: string };
    expect((await call("forget", { id: its.id }, armToken)).status).toBe(200);
  });

  test("secrets are refused, and the agent is pointed to request_secret", async () => {
    const result = await client.callTool({ name: "remember", arguments: { text: "key: sk-ant-api03-AbCdEfGhIjKlMnOpQrStUvWxYz0123" } });
    expect(result.isError).toBe(true);
    expect(text(result)).toMatch(/vault/);
    expect(text(await client.callTool({ name: "request_secret", arguments: { name: "deepseek", purpose: "reviewer role" } }))).toMatch(/never see/);
  });

  test("connectors: reads come back, outward calls are filed for you, and the key never shows", async () => {
    const seen: string[] = [];
    const service = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: (req) => {
        seen.push(`${req.method} ${new URL(req.url).pathname} ${req.headers.get("authorization")}`);
        return Response.json({ ok: true, token: req.headers.get("authorization") });
      },
    });
    try {
      const manifest = {
        id: "forge",
        label: "Forge",
        origin: `http://127.0.0.1:${service.port}`,
        auth: { secret: "forge", scheme: "bearer" },
        tools: {
          status: { description: "Status.", method: "GET", path: "/status", class: "read" },
          post: { description: "Post.", method: "POST", path: "/posts", params: { text: { type: "string", required: true } }, class: "outward" },
        },
      };
      expect((await call("setConnector", { id: "forge", manifest }, home.adminToken())).status).toBe(200);
      expect((await call("setSecret", { name: "forge", value: "forge-mcp-key-0123456789", connector: "forge" }, home.adminToken())).status).toBe(200);

      expect(text(await client.callTool({ name: "connectors", arguments: {} }))).toMatch(/post\(text: string\) \[outward: asks the user\]/);
      const read = text(await client.callTool({ name: "connector_call", arguments: { connector: "forge", tool: "status" } }));
      expect(read).toContain("GET /status → 200");
      expect(read).not.toContain("forge-mcp-key-0123456789");
      expect(seen).toEqual(["GET /status Bearer forge-mcp-key-0123456789"]);

      const outward = text(await client.callTool({ name: "connector_call", arguments: { connector: "forge", tool: "post", args: { text: "hi" }, why: "say hi" } }));
      expect(outward).toMatch(/Filed for the user's approval as action a_/);
      expect(seen).toHaveLength(1);

      // A standing order the user signed: the agent sees it, and a covered call goes straight out.
      const signed = await call("setOrder", { connector: "forge", tool: "post", args: { text: "status: *" }, label: "Status posts" }, home.adminToken());
      expect(signed.status).toBe(200);
      expect(text(await client.callTool({ name: "connectors", arguments: {} }))).toMatch(/standing order "Status posts" \(no need to ask\): forge\.post text=status: \*/);
      const covered = text(await client.callTool({ name: "connector_call", arguments: { connector: "forge", tool: "post", args: { text: "status: green" } } }));
      expect(covered).toMatch(/Sent under the user's standing order "Status posts"/);
      expect(covered).toContain("POST /posts → 200");
      expect(seen).toHaveLength(2);
    } finally {
      service.stop(true);
    }
  });

  test("tool failures come back as readable errors, not crashes", async () => {
    const result = await client.callTool({ name: "sandbox_run", arguments: { command: "echo hi" } });
    expect(result.isError).toBe(true);
    expect(text(result)).toMatch(/sandbox host/);
    expect(text(await client.callTool({ name: "fleet", arguments: {} }))).toContain("mcp-node");
  });
});

describe("what an agent may be granted", () => {
  test("no agent grants itself anything", async () => {
    expect((await call("grantArm", { label: "test-arm", add: ["connect"] }, armToken)).status).toBe(403);
  });

  test("granted a scope it lacked, it holds it with the same token, and gives it back; what agents never hold is refused", async () => {
    const admin = home.adminToken();
    const { token } = (await (await call("mintArm", { label: "reader", scopes: ["mind:read"] }, admin)).json()) as { token: string };
    const refused = await call("grantArm", { label: "reader", add: ["fleet:admin"] }, admin);
    expect(refused.status).toBe(400);
    expect(((await refused.json()) as { error: string }).error).toMatch(/never hold: fleet:admin/);

    const granted = (await (await call("grantArm", { label: "reader", add: ["connect"] }, admin)).json()) as { arm: { label: string; scopes: string[] } };
    expect(granted.arm.scopes).toContain("connect");
    expect(JSON.stringify(granted)).not.toContain(token);
    expect(((await (await call("whoami", undefined, token)).json()) as { scopes: string[] }).scopes).toContain("connect");
    await call("grantArm", { label: "reader", remove: ["connect"] }, admin);
    expect(((await (await call("whoami", undefined, token)).json()) as { scopes: string[] }).scopes).not.toContain("connect");
  });
});
