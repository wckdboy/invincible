import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { b64u, clientIdFromKey, newNodeIdentity, type QampGrantMade, type QampGrantView, type RouteName, routes, type Scope, signRequest, utf8 } from "@galahad/core";
import { requestPairing, signedFetch, waitForApproval } from "@galahad/link";
import { foundFleet, MindStore } from "@galahad/mind";
import type { Capabilities } from "../src/capabilities.ts";
import { type Daemon, startDaemon } from "../src/daemon.ts";
import { Home } from "../src/home.ts";
import type { QampProcess, QampRunner } from "../src/qamp-grants.ts";
import { freePort } from "./ports.ts";

/*
 * Q-AMP grants over the node's real API, with a stand-in for Q-AMP's binary (qamp.e2e.test.ts drives the real one):
 * made, listed and ended by you alone; checked at the door; an arm whose token stops opening the door the moment its
 * grant ends; ended wherever arms are listed; bridges stopped and started again with the node.
 */

const caps: Capabilities = {
  os: "linux",
  arch: "x64",
  hostname: "qamp-test",
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

const BRIDGE = "did:key:z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK";
const AGENT = "did:key:z6Mkg6rJ6LnB4z2LqAFGGMCgLaJDq6KuLLSRXwwCV5RpjyBW";

/** Q-AMP's binary, as far as the node asks it: a key, a chain, and bridges that listen at once and stop when told. */
class FakeQamp implements QampRunner {
  readonly bridges: { args: string[]; signals: string[] }[] = [];
  async run(args: string[]) {
    if (args[0] === "keygen") {
      writeFileSync(args[2]!, "qamp-sk1.FAKE-KEY-FOR-TESTS\n", { mode: 0o600 });
      return { code: 0, stdout: `${BRIDGE}\n`, stderr: "" };
    }
    if (args[0] === "id") return { code: 0, stdout: `${BRIDGE}\n`, stderr: "" };
    return { code: 0, stdout: "qdt1.FAKE-CHAIN-FOR-TESTS\n", stderr: "" };
  }
  serve(args: string[]): QampProcess {
    const bridge = { args, signals: [] as string[] };
    this.bridges.push(bridge);
    let end: (how: string) => void = () => {};
    const exited = new Promise<string>((resolve) => (end = resolve));
    return { ready: Promise.resolve(`qamp://${BRIDGE}@${args[args.indexOf("--listen") + 1]}`), exited, kill: (signal) => (bridge.signals.push(signal), end(signal)) };
  }
}

const root = mkdtempSync(join(tmpdir(), "galahad-qamp-routes-"));
const home = new Home(join(root, "node"));
const port = freePort();
const qampPort = freePort();
const qamp = new FakeQamp();
let daemon: Daemon;
let armToken: string;

type Caller = <T = any>(name: RouteName, input?: unknown) => Promise<{ status: number; body: T }>;
const answer = async <T,>(response: Response): Promise<{ status: number; body: T }> => ({ status: response.status, body: (await response.json().catch(() => ({}))) as T });
const withToken =
  (token: () => string): Caller =>
  async (name, input) => {
    const route = routes[name];
    return answer(await fetch(`http://127.0.0.1:${port}${route.path}`, { method: route.method, headers: { authorization: `Bearer ${token()}`, "content-type": "application/json" }, body: route.method === "POST" ? JSON.stringify(input ?? {}) : undefined }));
  };
const admin = withToken(() => home.adminToken());
const arm = withToken(() => armToken);

/** A browser paired with the node, holding the scopes given. */
async function pair(name: string, scopes: Scope[]): Promise<{ id: string; call: Caller }> {
  const keys = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, ["sign", "verify"])) as CryptoKeyPair;
  const id = clientIdFromKey(new Uint8Array(await crypto.subtle.exportKey("raw", keys.publicKey)));
  const { invite } = (await admin<{ invite: string }>("createInvite", { kind: "client", scopes })).body;
  const joining = await requestPairing(invite, { device: id, name, kind: "client" });
  const { pairings } = (await admin<{ pairings: { invite: string; device: string }[] }>("pairings")).body;
  const mine = pairings.find((p) => p.device === id)!;
  expect((await admin("approvePairing", { invite: mine.invite, device: mine.device })).status).toBe(200);
  await waitForApproval(joining, { intervalMs: 20 });
  const call: Caller = async (route, input) => {
    const r = routes[route];
    const bytes = r.method === "POST" ? utf8(JSON.stringify(input ?? {})) : new Uint8Array();
    const headers = await signRequest(id, async (m) => new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, keys.privateKey, m)), r.method, r.path, bytes);
    return answer(await fetch(`http://127.0.0.1:${port}${r.path}`, { method: r.method, headers: { ...headers, "content-type": "application/json" }, body: r.method === "POST" ? bytes : undefined }));
  };
  return { id, call };
}

const start = () => startDaemon(home, { capabilities: caps, proxyPort: freePort(), log: () => {}, qamp, qampPorts: { first: qampPort, last: qampPort + 2 }, qampSweepMs: 0, backups: false, shutdownGraceMs: 200 });
const grantsNow = async () => (await admin<{ grants: QampGrantView[] }>("qampGrants")).body.grants;
const lines = () => daemon.store.ledger(200).map((e) => e.body).filter((b) => b.resource === "qamp");

beforeAll(async () => {
  const { identity, keystore } = await home.createIdentity("file");
  const store = new MindStore(home.mindPath);
  const fleet = foundFleet(store, identity, { fleetName: "camelot", nodeName: "ultra" });
  store.close();
  home.writeConfig({ v: 1, name: "ultra", fleet, port, keystore, advertise: "127.0.0.1" });
  daemon = await start();
  armToken = (await admin<{ token: string }>("mintArm", { label: "claude-code" })).body.token;
});

afterAll(async () => {
  await daemon?.stop();
  rmSync(root, { recursive: true, force: true });
});

describe("a grant, from you", () => {
  test("from a terminal: listed, its arm among the arms with the one scope its tools need, its line in the ledger", async () => {
    const made = await admin<QampGrantMade>("qampGrant", { agent: AGENT, tools: ["fleet", "compute"], ttlSeconds: 600 });
    expect(made.status).toBe(200);
    expect(made.body.proof).toBe("qdt1.FAKE-CHAIN-FOR-TESTS");
    expect(made.body.grant).toMatchObject({ agent: AGENT, tools: ["fleet", "compute"], scopes: ["mind:read"], url: `qamp://${BRIDGE}@127.0.0.1:${qampPort}`, bridge: { state: "up" } });
    expect(made.body.grant.endsAt - made.body.grant.createdAt).toBe(600_000);
    expect(await grantsNow()).toEqual([made.body.grant]);
    const { arms } = (await admin<{ arms: { label: string; scopes: string[] }[] }>("arms")).body;
    expect(arms.find((a) => a.label === made.body.grant.label)?.scopes).toEqual(["mind:read"]);
    expect(lines().some((l) => l.target === made.body.grant.label && l.detail === `agent ${AGENT} · tools fleet, compute · scopes mind:read · until ${new Date(made.body.grant.endsAt).toISOString()}`)).toBe(true);
    expect((await admin("qampRevoke", { id: made.body.grant.id })).body).toEqual({ revoked: 1 });
  });

  test("from a paired device of yours that holds fleet:admin", async () => {
    const phone = await pair("phone", ["mind:read", "fleet:admin"]);
    const made = await phone.call<QampGrantMade>("qampGrant", { agent: AGENT, tools: ["ledger"] });
    expect(made.status).toBe(200);
    // An hour, unless you say.
    expect(made.body.grant.endsAt - made.body.grant.createdAt).toBe(3_600_000);
    expect((await phone.call<{ grants: QampGrantView[] }>("qampGrants")).body.grants.map((g) => g.id)).toEqual([made.body.grant.id]);
    expect((await phone.call("qampRevoke", { all: true })).body).toEqual({ revoked: 1 });
    // Nothing it couldn't do from where it asked.
    const partial = await pair("tablet", ["fleet:admin"]);
    const refused = await partial.call<{ error: string }>("qampGrant", { agent: AGENT, tools: ["fleet"] });
    expect([refused.status, refused.body.error]).toEqual([403, "this device doesn't hold mind:read, which those tools need"]);
  });
});

describe("refused at the door", () => {
  test("an agent (its arm holds no fleet:admin), another node (it holds every scope and still isn't you), a device you didn't give fleet:admin", async () => {
    for (const [route, body] of [["qampGrant", { agent: AGENT, tools: ["fleet"] }], ["qampGrants", undefined], ["qampRevoke", { all: true }]] as const) {
      expect([route, (await arm(route, body)).status]).toEqual([route, 403]);
    }
    const other = newNodeIdentity();
    daemon.store.emit(daemon.identity, "device.enrolled", { device: other.id, name: "mini", kind: "node", role: "full", box: b64u(other.boxPublic), scopes: [] });
    for (const [route, body] of [["qampGrant", { agent: AGENT, tools: ["fleet"] }], ["qampRevoke", { all: true }]] as const) {
      const refused = await signedFetch(other, `http://127.0.0.1:${port}`, routes[route].path, body);
      expect({ route, status: refused.status, error: ((await refused.json()) as { error: string }).error }).toEqual({ route, status: 403, error: "only you grant, list and end an agent's access over Q-AMP" });
    }
    const reader = await pair("reader", ["mind:read"]);
    expect((await reader.call("qampGrant", { agent: AGENT, tools: ["fleet"] })).status).toBe(403);
    expect((await reader.call("qampGrants")).status).toBe(403);
    expect(await grantsNow()).toEqual([]);
  });

  test("a tool outside the four, by name; a lifetime over a day, never cut short; a key that isn't an Ed25519 did:key", async () => {
    const issues = async (input: unknown) => {
      const refused = await admin<{ error: string; issues: { message: string }[] }>("qampGrant", input);
      return [refused.status, refused.body.issues?.map((i) => i.message)];
    };
    expect(await issues({ agent: AGENT, tools: ["fleet", "recall"] })).toEqual([400, ['"recall" can\'t be granted: fleet, compute, place and ledger are the tools you have allowed so far']]);
    expect(await issues({ agent: AGENT, tools: ["fleet"], ttlSeconds: 86_401 })).toEqual([400, ["a grant lasts 24 hours at most: grant again when it ends"]]);
    expect((await issues({ agent: "did:key:zDnaerDaTF5BXEavCrfRZEk316dpbLsfPDZ3WJ5hRTPFU2169", tools: ["fleet"] }))[0]).toBe(400);
    expect((await issues({ agent: AGENT, tools: ["fleet"], scopes: ["fleet:admin"] }))[0]).toBe(400);
    expect(await grantsNow()).toEqual([]);
  });

  test("a grant's arm is made by a grant alone, and never widened by hand", async () => {
    const minted = await admin<{ error: string }>("mintArm", { label: "qamp.0a1b2c3d4e" });
    expect([minted.status, minted.body.error]).toEqual([400, "names beginning qamp. are grants to agents on other machines (galahad qamp grant); choose another"]);
    const { grant } = (await admin<QampGrantMade>("qampGrant", { agent: AGENT, tools: ["fleet"] })).body;
    const widened = await admin<{ error: string }>("grantArm", { label: grant.label, add: ["bank:read"] });
    expect(widened.status).toBe(400);
    expect((await admin<{ arms: { label: string; scopes: string[] }[] }>("arms")).body.arms.find((a) => a.label === grant.label)?.scopes).toEqual(["mind:read"]);
    await admin("qampRevoke", { id: grant.id });
  });
});

describe("its arm at the door", () => {
  test("opens it for the tools' routes alone, its MCP server offers the granted tools alone; revoked, its very next call is refused", async () => {
    const { grant } = (await admin<QampGrantMade>("qampGrant", { agent: AGENT, tools: ["fleet"] })).body;
    // What its bridge runs, with the token the grant wrote: the same command, the same home.
    const client = new Client({ name: "qamp-bridge-stand-in", version: "1" });
    await client.connect(new StdioClientTransport({ command: process.execPath, args: [resolve(import.meta.dir, "../src/cli.ts"), "mcp", "--arm", grant.label, "--tools", grant.tools.join(","), "--home", home.dir], stderr: "ignore" }));
    try {
      expect((await client.listTools()).tools.map((t) => t.name)).toEqual(["fleet"]);
      const fleet = await client.callTool({ name: "fleet", arguments: {} });
      expect(fleet.isError).toBeFalsy();
      expect((fleet.content as { text: string }[])[0]!.text).toStartWith('Fleet "camelot"');
      const token = withToken(() => home.readArmToken(grant.label));
      const who = await token<{ kind: string; scopes: string[] }>("whoami");
      expect([who.status, who.body.kind, who.body.scopes]).toEqual([200, "arm", ["mind:read"]]);
      // mind:read is what it holds, never more: nothing that writes.
      expect((await token("remember", { text: "a note" })).status).toBe(403);
      const tokenText = home.readArmToken(grant.label);

      expect((await admin("qampRevoke", { id: grant.id })).body).toEqual({ revoked: 1 });
      const after = await client.callTool({ name: "fleet", arguments: {} });
      expect(after.isError).toBe(true);
      expect((after.content as { text: string }[])[0]!.text).toBe("Galahad: sign the request with an enrolled device key");
      expect((await withToken(() => tokenText)("whoami")).status).toBe(401);
      expect(existsSync(home.armTokenPath(grant.label))).toBe(false);
      expect(qamp.bridges.at(-1)!.signals).toEqual(["SIGTERM"]);
      expect((await admin("qampRevoke", { id: grant.id })).status).toBe(404);
    } finally {
      await client.close();
    }
  }, 30_000);

  test("revoked where arms are listed (galahad arms revoke, the app's Revoke): the grant ends with it, its bridge stopped", async () => {
    const { grant } = (await admin<QampGrantMade>("qampGrant", { agent: AGENT, tools: ["compute"] })).body;
    const bridge = qamp.bridges.at(-1)!;
    expect((await admin("revokeArm", { label: grant.label })).body).toEqual({ revoked: true });
    expect(await grantsNow()).toEqual([]);
    expect(bridge.signals).toEqual(["SIGTERM"]);
    expect(lines().filter((l) => l.target === grant.label && l.class === "delete").map((l) => l.reason)).toEqual([
      "the grant ended (you revoked it): its bridge stopped",
      "the grant ended (you revoked it): its arm is deleted, so the agent's next call is refused",
    ]);
  });
});

describe("with the node", () => {
  test("stopping it stops its bridges and keeps its grants; starting it starts them again on their ports", async () => {
    const { grant } = (await admin<QampGrantMade>("qampGrant", { agent: AGENT, tools: ["place"] })).body;
    const bridge = qamp.bridges.at(-1)!;
    await daemon.stop();
    expect(bridge.signals).toEqual(["SIGTERM"]);
    daemon = await start();
    // Its bridge comes back as the node starts (a moment after it listens).
    for (let i = 0; i < 50 && qamp.bridges.at(-1) === bridge; i++) await Bun.sleep(20);
    expect(qamp.bridges.at(-1)!.args).toContain(`127.0.0.1:${qampPort}`);
    expect((await grantsNow()).map((g) => [g.id, g.bridge.state])).toEqual([[grant.id, "up"]]);
    await admin("qampRevoke", { all: true });
  });
});
