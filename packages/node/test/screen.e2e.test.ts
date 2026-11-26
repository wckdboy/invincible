import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { clientIdFromKey, type RouteName, routes, type Scope, type ScreenSessionView, type ScreenStatus, type ScreenView, signRequest, utf8 } from "@galahad/core";
import { requestPairing, waitForApproval } from "@galahad/link";
import { foundFleet, MindStore } from "@galahad/mind";
import type { Capabilities } from "../src/capabilities.ts";
import { type Daemon, startDaemon } from "../src/daemon.ts";
import { Home } from "../src/home.ts";
import { type HelperRun, MacScreen } from "../src/mac-screen.ts";
import { freePort } from "./ports.ts";

/*
 * A Mac's own screen over real HTTP (mac-screen.ts, docs/MAC.md): watched and taken over by you alone, from a terminal
 * or a paired device that may manage the fleet; never by an agent. Each thing done is a line in the ledger, and what is
 * typed is carried in one argument and never written down. A stand-in plays the app's helper.
 */

const caps: Capabilities = {
  os: "darwin",
  arch: "arm64",
  hostname: "screen-test",
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

const asked: string[][] = [];
const helper: HelperRun = async (args) => {
  asked.push(args);
  if (args[0] === "status" || args[0] === "allow") return { code: 0, stdout: '{"width":1512,"height":948,"record":true,"control":true,"front":"Finder"}\n', stderr: "" };
  if (args[0] === "shot") return { code: 0, stdout: "SlBFRw==", stderr: "" };
  return { code: 0, stdout: "", stderr: "" };
};

const root = mkdtempSync(join(tmpdir(), "galahad-screen-"));
const home = new Home(join(root, "node"));
const port = freePort();
const bareHome = new Home(join(root, "bare"));
const barePort = freePort();
let daemon: Daemon;
let bare: Daemon;
let armToken: string;

type Caller = <T = any>(name: RouteName, input?: unknown) => Promise<{ status: number; body: T }>;
const answer = async <T,>(response: Response): Promise<{ status: number; body: T }> => ({ status: response.status, body: (await response.json().catch(() => ({}))) as T });
const withToken =
  (token: () => string, at = port): Caller =>
  async (name, input) => {
    const route = routes[name];
    return answer(await fetch(`http://127.0.0.1:${at}${route.path}`, { method: route.method, headers: { authorization: `Bearer ${token()}`, "content-type": "application/json" }, body: route.method === "POST" ? JSON.stringify(input ?? {}) : undefined }));
  };
const admin = withToken(() => home.adminToken());
const arm = withToken(() => armToken);

/** A browser paired with the node, holding the scopes given. */
async function pair(name: string, scopes: Scope[]): Promise<Caller> {
  const keys = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, ["sign", "verify"])) as CryptoKeyPair;
  const id = clientIdFromKey(new Uint8Array(await crypto.subtle.exportKey("raw", keys.publicKey)));
  const { invite } = (await admin<{ invite: string }>("createInvite", { kind: "client", scopes })).body;
  const joining = await requestPairing(invite, { device: id, name, kind: "client" });
  const { pairings } = (await admin<{ pairings: { invite: string; device: string }[] }>("pairings")).body;
  const mine = pairings.find((p) => p.device === id)!;
  expect((await admin("approvePairing", { invite: mine.invite, device: mine.device })).status).toBe(200);
  await waitForApproval(joining, { intervalMs: 20 });
  return async (route, input) => {
    const r = routes[route];
    const bytes = r.method === "POST" ? utf8(JSON.stringify(input ?? {})) : new Uint8Array();
    const headers = await signRequest(id, async (m) => new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, keys.privateKey, m)), r.method, r.path, bytes);
    return answer(await fetch(`http://127.0.0.1:${port}${r.path}`, { method: r.method, headers: { ...headers, "content-type": "application/json" }, body: r.method === "POST" ? bytes : undefined }));
  };
}

const screenLines = () => daemon.store.ledger(200).map((e) => e.body).filter((b) => b.resource === "screen");

beforeAll(async () => {
  for (const [h, p, name] of [[home, port, "mini"], [bareHome, barePort, "ultra"]] as const) {
    const { identity, keystore } = await h.createIdentity("file");
    const store = new MindStore(h.mindPath);
    const fleet = foundFleet(store, identity, { fleetName: "camelot", nodeName: name });
    store.close();
    h.writeConfig({ v: 1, name, fleet, port: p, keystore, advertise: "127.0.0.1" });
  }
  daemon = await startDaemon(home, { capabilities: caps, proxyPort: freePort(), log: () => {}, screen: new MacScreen(helper, { settleMs: 0 }) });
  bare = await startDaemon(bareHome, { capabilities: { ...caps, os: "linux" }, proxyPort: freePort(), log: () => {}, screen: null });
  armToken = (await admin<{ token: string }>("mintArm", { label: "test-arm" })).body.token;
});

afterAll(async () => {
  await daemon?.stop();
  await bare?.stop();
  rmSync(root, { recursive: true, force: true });
});

describe("a Mac's own screen", () => {
  test("the node says it has one, and you see its size, what macOS allows Galahad, and what is in front", async () => {
    expect(daemon.store.activeDevice(daemon.identity.id)?.profile?.caps?.screen).toBe(true);
    const status = await admin<ScreenStatus>("screen", {});
    expect(status.status).toBe(200);
    expect(status.body).toEqual({ node: daemon.identity.id, width: 1512, height: 948, record: true, control: true, front: "Finder", frontId: "", asking: null });
    // Asking macOS's leave shows its prompts on that Mac, and says where things stand.
    expect((await admin<ScreenStatus>("screenAllow", {})).body.control).toBe(true);
    expect(asked.some((a) => a[0] === "allow")).toBe(true);
  });

  test("taken over from a paired device: a click, and a picture of what it did; each thing done a line in the ledger", async () => {
    const phone = await pair("phone", ["chat", "fleet:admin"]);
    const clicked = await phone<ScreenView>("screenDesktop", { action: { do: "click", x: 700, y: 400 } });
    expect(clicked.status).toBe(200);
    expect(clicked.body).toEqual({ shot: { mediaType: "image/jpeg", data: "SlBFRw==" }, width: 1512, height: 948 });
    expect(asked).toContainEqual(["click", "700", "400", "left"]);
    // Looking is no line; a click is one.
    expect((await phone("screenDesktop", {})).status).toBe(200);
    expect(screenLines().map((b) => b.detail)).toEqual(["click 700 400 left · by you"]);
    expect((await admin("screenDesktop", { action: { do: "app", name: "Safari" } })).status).toBe(200);
    expect(asked).toContainEqual(["open", "Safari"]);
  });

  test("what you type is carried in one argument and never written down", async () => {
    expect((await admin("screenDesktop", { action: { do: "type", text: "hunter2 in the field" } })).status).toBe(200);
    expect(asked).toContainEqual(["type", Buffer.from("hunter2 in the field", "utf8").toString("base64")]);
    // (The ledger says the newest first.)
    expect(screenLines()[0]?.detail).toBe("type (20 characters, not recorded) · by you");
    expect(JSON.stringify(daemon.store.ledger(500))).not.toContain("hunter2");
  });

  test("never an agent's, and never a device's that may not manage the fleet", async () => {
    const before = asked.length;
    expect((await arm("screenDesktop", { action: { do: "click", x: 1, y: 1 } })).status).toBe(403);
    expect((await arm("screen", {})).status).toBe(403);
    const reader = await pair("reader", ["chat", "mind:read"]);
    expect((await reader("screenDesktop", { action: { do: "click", x: 1, y: 1 } })).status).toBe(403);
    expect(asked.length).toBe(before);
  });

  test("a node without a screen of its own says so", async () => {
    const asksBare = withToken(() => bareHome.adminToken(), barePort);
    const answered = await asksBare<{ error: string }>("screen", {});
    expect(answered.status).toBe(424);
    expect(answered.body.error).toContain("only a Mac that runs its node from the Galahad app has one");
    expect(bare.store.activeDevice(bare.identity.id)?.profile?.caps?.screen).toBeUndefined();
  });
});

describe("sessions on a Mac's own screen", () => {
  /** An ask, as Galahad's own (in your conversation with him) puts it in the log: only his principal reaches the route. */
  let n = 0;
  const asked = (minutes = 30) => {
    const id = `sc_${String(++n).padStart(22, "0")}`;
    daemon.store.emit(daemon.identity, "screen.asked", { id, node: daemon.identity.id, why: "build the app in Xcode", minutes });
    return id;
  };
  const sessionNow = async (id: string) => (await admin<{ sessions: ScreenSessionView[] }>("screenSessions")).body.sessions.find((s) => s.id === id)!;

  test("an ask waits as a card; you allow it from a paired device, and it is his for its minutes from your answer", async () => {
    const id = asked(30);
    const reader = await pair("reader-2", ["chat", "mind:read"]);
    const listed = await reader<{ sessions: ScreenSessionView[] }>("screenSessions");
    expect(listed.status).toBe(200);
    expect(listed.body.sessions.find((s) => s.id === id)).toMatchObject({ node: daemon.identity.id, nodeName: "mini", why: "build the app in Xcode", minutes: 30, state: "waiting", until: null });
    // A device that may only read can't answer it; one that may manage the fleet can.
    expect((await reader("decideScreen", { id, allow: true })).status).toBe(403);
    const phone = await pair("phone-2", ["chat", "fleet:admin"]);
    const before = Date.now();
    const allowed = await phone<{ session: ScreenSessionView }>("decideScreen", { id, allow: true });
    expect(allowed.status).toBe(200);
    expect(allowed.body.session.state).toBe("allowed");
    expect(allowed.body.session.decidedVia).toMatch(/^c_/);
    expect(allowed.body.session.until! - before).toBeGreaterThanOrEqual(30 * 60_000 - 1_000);
    // The first answer stands.
    expect((await phone("decideScreen", { id, allow: false })).status).toBe(409);
    expect((await sessionNow(id)).state).toBe("allowed");
  });

  test("said no to, it stays no; ended by you, it is over at once, and saying so again changes nothing", async () => {
    const no = asked();
    expect((await admin<{ session: ScreenSessionView }>("decideScreen", { id: no, allow: false })).body.session.state).toBe("denied");
    const yes = asked();
    await admin("decideScreen", { id: yes, allow: true });
    const ended = await admin<{ session: ScreenSessionView }>("endScreen", { id: yes });
    expect(ended.body.session.state).toBe("ended");
    expect((await admin<{ session: ScreenSessionView }>("endScreen", { id: yes })).body.session.state).toBe("ended");
    expect(daemon.store.screenSessions().find((s) => s.id === yes)?.endedAt).toBeNumber();
    expect((await admin("decideScreen", { id: `sc_${"x".repeat(22)}`, allow: true })).status).toBe(404);
  });

  test("an agent neither asks (only Galahad himself does, in your conversation), nor answers, nor ends one", async () => {
    const id = asked();
    expect((await arm("askScreen", { why: "just looking", minutes: 5 })).status).toBe(403);
    expect((await arm("decideScreen", { id, allow: true })).status).toBe(403);
    expect((await arm("endScreen", { id })).status).toBe(403);
    expect((await sessionNow(id)).state).toBe("waiting");
  });
});

