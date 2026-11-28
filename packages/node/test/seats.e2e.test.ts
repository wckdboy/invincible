import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { b64u, clientIdFromKey, newNodeIdentity, type RouteName, routes, type Scope, type SeatView, SHARED_RUNS_PROVEN, signRequest, type TeamSnapshot, utf8 } from "@invincible/core";
import { requestPairing, waitForApproval } from "@invincible/link";
import { enrollDevice, foundFleet, LedgerStore, Vault } from "@invincible/ledger";
import type { Capabilities } from "../src/capabilities.ts";
import { type Daemon, startDaemon } from "../src/daemon.ts";
import { Home } from "../src/home.ts";
import { MAX_SEATS, seatEmailName, yourWord } from "../src/seats.ts";
import { freePort } from "./ports.ts";

/*
 * Seats over real HTTP (core's seats.ts): added, set and removed by you alone (a terminal, a paired device of yours
 * with fleet:admin), read by anyone who may read the mind, never by an agent; nothing shaped like a token taken; a
 * seat's email sealed in the vault, never in the log; a keyed seat only for a provider with a key of yours; the agents
 * a seat serves chosen by you alone, of its own node's, each as itself, and shared only when you say so.
 */

const caps: Capabilities = { os: "linux", arch: "x64", hostname: "seats-test", cores: 4, cpu: "test", memoryGb: 8, hasBattery: false, gpu: [], docker: false, vm: { kvm: false, tools: [] }, tools: [], localModels: [], tailscale: null };

const root = mkdtempSync(join(tmpdir(), "invincible-seats-"));
const home = new Home(join(root, "node"));
const port = freePort();
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

const seatsNow = async (call: Caller = admin): Promise<SeatView[]> => (await call<{ seats: SeatView[] }>("seats")).body.seats;
/** Everything the log holds, as text: what any replica of the fleet would hold. */
const logText = () => JSON.stringify(daemon.store.eventsSince({}, 100_000).events);
// Fake, every one: shaped as each vendor's are.
const FAKE_SETUP_TOKEN = "sk-ant-oat01-FAKE-not-a-token-0000000000000000";
const FAKE_SIGNED = "eyJGQUtFIn0.eyJGQUtFIn0.RkFLRS1zaWc";
/** A state as Claude Code makes one, base64url of 32 random bytes (the re-check's R5), of fake bytes made here: never anyone's. */
const CLAUDE_STATE = Buffer.from(Array.from({ length: 32 }, (_, i) => (i * 73 + 41) % 256)).toString("base64url");

beforeAll(async () => {
  const { identity, keystore } = await home.createIdentity("file");
  const store = new LedgerStore(home.ledgerPath);
  const fleet = foundFleet(store, identity, { fleetName: "homelab", nodeName: "ultra" });
  store.close();
  home.writeConfig({ v: 1, name: "ultra", fleet, port, keystore, advertise: "127.0.0.1" });
  daemon = await startDaemon(home, { capabilities: caps, proxyPort: freePort(), log: () => {} });
  armToken = (await admin<{ token: string }>("mintArm", { label: "test-arm" })).body.token;
});

afterAll(async () => {
  await daemon?.stop();
  rmSync(root, { recursive: true, force: true });
});

describe("seats", () => {
  test("added from a terminal or a device of yours, its home on this node; its email in the vault and never in the log", async () => {
    const added = await admin<{ seat: SeatView }>("addSeat", { kind: "claude-subscription", label: "Work Max", email: "owner@example.test" });
    expect(added.status).toBe(200);
    const seat = added.body.seat;
    expect(seat).toMatchObject({ kind: "claude-subscription", vendor: "anthropic", label: "Work Max", node: daemon.identity.id, provider: null, runs: 1, plan: null, state: { is: "signed-out", why: "never" }, windows: [] });
    expect(logText()).not.toContain("owner@example.test");
    const vault = new Vault(daemon.store, daemon.identity);
    expect(vault.reveal(seatEmailName(seat.id))).toBe("owner@example.test");
    const phone = await pair("phone", ["mind:read", "fleet:admin"]);
    const second = await phone.call<{ seat: SeatView }>("addSeat", { kind: "chatgpt-codex", label: "Personal Plus" });
    expect(second.status).toBe(200);
    expect((await seatsNow(phone.call)).map((s) => [s.label, s.vendor, s.state.is])).toEqual([
      ["Work Max", "anthropic", "signed-out"],
      ["Personal Plus", "openai", "signed-out"],
    ]);
    // Its runs at once: as you set it, never above what has been shown safe.
    const set = await phone.call<{ seat: SeatView }>("setSeatPolicy", { id: seat.id, runs: 3 });
    expect(set.status).toBe(200);
    expect(set.body.seat.runs).toBe(SHARED_RUNS_PROVEN);
    expect(daemon.store.seats().find((s) => s.id === seat.id)!.runs).toBe(3);
    // Removed, with its email.
    expect((await admin("removeSeat", { id: seat.id })).status).toBe(200);
    expect(vault.has(seatEmailName(seat.id))).toBe(false);
    expect((await seatsNow()).map((s) => s.label)).toEqual(["Personal Plus"]);
    expect((await admin("removeSeat", { id: seat.id })).status).toBe(404);
    expect((await admin("removeSeat", { id: second.body.seat.id })).status).toBe(200);
  });

  test("nothing shaped like a token is taken, by its name or its email, and nothing is written when it is refused", async () => {
    const before = logText().length;
    for (const label of [FAKE_SETUP_TOKEN, `mine ${FAKE_SIGNED}`]) expect((await admin("addSeat", { kind: "claude-subscription", label })).status).toBe(400);
    expect((await admin("addSeat", { kind: "claude-subscription", label: "x", email: `${FAKE_SETUP_TOKEN.slice(0, 30)}@example.test` })).status).toBe(400);
    // (A credential said as one, which the scanner reads as a key: refused at the door too.)
    expect((await admin("addSeat", { kind: "claude-subscription", label: "password=hunter2hunter2" })).status).toBe(400);
    expect(logText().length).toBe(before);
    expect(await seatsNow()).toEqual([]);
  });

  test("a keyed seat is only for a provider there is, with a key of yours", async () => {
    const missing = await admin<{ error: string }>("addSeat", { kind: "api", label: "Console credits", provider: "anthropic" });
    expect(missing.status).toBe(404);
    expect(missing.body.error).toContain("add it first");
    expect((await admin("setProvider", { id: "anthropic", preset: "anthropic" })).status).toBe(200);
    const keyless = await admin<{ error: string }>("addSeat", { kind: "api", label: "Console credits", provider: "anthropic" });
    expect(keyless.status).toBe(400);
    expect(keyless.body.error).toContain("add its key first");
  });

  test("an agent can never add, set or remove one; a device you didn't give fleet:admin can only read them", async () => {
    const seat = (await admin<{ seat: SeatView }>("addSeat", { kind: "claude-subscription", label: "Work Max" })).body.seat;
    expect((await arm("addSeat", { kind: "claude-subscription", label: "agent's own" })).status).toBe(403);
    expect((await arm("setSeatPolicy", { id: seat.id, runs: 2 })).status).toBe(403);
    expect((await arm("removeSeat", { id: seat.id })).status).toBe(403);
    const reader = await pair("tablet", ["mind:read"]);
    expect((await seatsNow(reader.call)).map((s) => s.id)).toEqual([seat.id]);
    expect((await reader.call("addSeat", { kind: "claude-subscription", label: "tablet's" })).status).toBe(403);
    expect((await reader.call("removeSeat", { id: seat.id })).status).toBe(403);
    expect((await seatsNow()).map((s) => s.id)).toEqual([seat.id]);
    expect((await admin("removeSeat", { id: seat.id })).status).toBe(200);
  });

  test("a sign-in is yours alone, its code never shaped like a token, and on a node without Docker it says it can't make the seat's VM", async () => {
    const seat = (await admin<{ seat: SeatView }>("addSeat", { kind: "claude-subscription", label: "Work Max" })).body.seat;
    const attempt = `sa_${"a".repeat(22)}`;
    expect((await arm("startSeatSignIn", { id: seat.id })).status).toBe(403);
    expect((await arm("answerSeatSignIn", { id: seat.id, attempt, code: "FAKEcode0000#FAKE-state-0000" })).status).toBe(403);
    const reader = await pair("watch", ["mind:read"]);
    expect((await reader.call("startSeatSignIn", { id: seat.id })).status).toBe(403);
    // (This test's node has no Docker: a seat's VM is made on a Linux host with it.)
    const started = await admin<{ error: string }>("startSeatSignIn", { id: seat.id });
    expect(started.status).toBe(424);
    expect(started.body.error).toContain("can't make a seat's VM");
    for (const code of [FAKE_SETUP_TOKEN, FAKE_SIGNED, "two words"]) expect((await admin("answerSeatSignIn", { id: seat.id, attempt, code })).status).toBe(400);
    // A code of the shape Claude Code's page shows is taken (the re-check's R5): none is waited for here, so 404.
    expect((await admin("answerSeatSignIn", { id: seat.id, attempt, code: `FAKEcode0000#${CLAUDE_STATE}` })).status).toBe(404);
    expect((await admin("cancelSeatSignIn", { id: seat.id, attempt })).status).toBe(404);
    expect((await admin("removeSeat", { id: seat.id })).status).toBe(200);
  });

  test("whom a seat serves is yours alone to choose, of this node's agents, each as itself; a share only when you say so; a seat homed on another node, there", async () => {
    for (const id of ["ada", "bo"]) expect((await admin("saveAgent", { id, name: id === "ada" ? "Ada" : "Bo", role: "engineer", harness: "claude" })).status).toBe(200);
    const team = (await admin<TeamSnapshot>("team")).body;
    const as = (id: string) => ({ id, made: team.agents.find((agent) => agent.id === id)!.createdAt });
    // Added for Ada: it serves her, as herself.
    const added = await admin<{ seat: SeatView }>("addSeat", { kind: "claude-subscription", label: "Work Max", agent: "ada" });
    expect(added.status).toBe(200);
    const seat = added.body.seat;
    expect(seat.serves).toEqual([as("ada")]);
    expect((await seatsNow()).find((s) => s.id === seat.id)!.serves).toEqual([as("ada")]);
    // Added without one, it serves none; for an agent this node hasn't, it isn't added at all.
    const plain = (await admin<{ seat: SeatView }>("addSeat", { kind: "chatgpt-codex", label: "Personal Plus" })).body.seat;
    expect(plain.serves).toEqual([]);
    const count = (await seatsNow()).length;
    const nobody = await admin<{ error: string }>("addSeat", { kind: "claude-subscription", label: "Nobody's", agent: "zed" });
    expect(nobody.status).toBe(404);
    expect(nobody.body.error).toContain("no agent zed");
    expect((await seatsNow()).length).toBe(count);
    // Moved to Bo; then shared, only when you say so, and what a share means is said with the refusal.
    expect((await admin<{ seat: SeatView }>("setSeatServes", { id: seat.id, agents: ["bo"] })).body.seat.serves).toEqual([as("bo")]);
    const unsaid = await admin<{ issues: { message: string }[] }>("setSeatServes", { id: seat.id, agents: ["ada", "bo"] });
    expect(unsaid.status).toBe(400);
    expect(unsaid.body.issues.map((issue) => issue.message).join(" ")).toContain("one trust domain");
    const shared = await admin<{ seat: SeatView }>("setSeatServes", { id: seat.id, agents: ["ada", "bo"], shared: true });
    expect(shared.status).toBe(200);
    expect(shared.body.seat.serves).toEqual([as("ada"), as("bo")]);
    expect((await admin("setSeatServes", { id: seat.id, agents: ["zed"] })).status).toBe(404);
    // Yours alone: never an agent's, never a device you didn't give fleet:admin.
    expect((await arm("setSeatServes", { id: seat.id, agents: ["ada"] })).status).toBe(403);
    const reader = await pair("e-reader", ["mind:read"]);
    expect((await reader.call("setSeatServes", { id: seat.id, agents: ["ada"] })).status).toBe(403);
    // A seat homed on another node serves that node's agents, and is chosen for there.
    const mini = newNodeIdentity();
    enrollDevice(daemon.store, daemon.identity, { device: mini.id, name: "mini", kind: "node", box: b64u(mini.boxPublic) });
    const there = `st_${"m".repeat(22)}`;
    daemon.store.emit(daemon.identity, "seat.added", { id: there, kind: "claude-subscription", label: "Mini Max", node: mini.id, runs: 1 }, yourWord(null));
    const elsewhere = await admin<{ error: string }>("setSeatServes", { id: there, agents: ["ada"] });
    expect(elsewhere.status).toBe(409);
    expect(elsewhere.body.error).toContain("another node");
    // Ada removed: nothing is written for you (the view works out that no seat serves her), and she can't be chosen again.
    const serves = () => daemon.store.eventsSince({}, 100_000).events.filter((e) => e.kind === "seat.serves").length;
    const written = serves();
    expect((await admin("removeAgent", { id: "ada" })).status).toBe(200);
    expect(serves()).toBe(written);
    expect((await admin("setSeatServes", { id: seat.id, agents: ["ada", "bo"], shared: true })).status).toBe(404);
    for (const id of [seat.id, plain.id, there]) expect((await admin("removeSeat", { id })).status).toBe(200);
  });

  test(`at most ${MAX_SEATS}`, async () => {
    const ids: string[] = [];
    for (let i = 0; i < MAX_SEATS; i++) ids.push((await admin<{ seat: SeatView }>("addSeat", { kind: "claude-subscription", label: `Seat ${i}` })).body.seat.id);
    const more = await admin<{ error: string }>("addSeat", { kind: "claude-subscription", label: "one more" });
    expect(more.status).toBe(400);
    expect(more.body.error).toContain(`at most ${MAX_SEATS}`);
    for (const id of ids) expect((await admin("removeSeat", { id })).status).toBe(200);
  });
});
