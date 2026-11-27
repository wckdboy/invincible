import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { b64u, bodyFingerprint, type Calibration, ceilingThreads, DESKTOP_FRAME_KIND, DESKTOP_FRAMES_TYPE, DesktopFrames, KERNEL, newNodeIdentity, REFERENCE_SINGLE, type RouteName, routes, type SyncPage, teamArmLabel } from "@invincible/core";
import { foundFleet, LedgerStore } from "@invincible/ledger";
import { requestPairing, signedFetch, signedPost, waitForApproval } from "@invincible/link";
import type { FramesProcess, SessionProcess } from "@invincible/sandbox";
import type { Capabilities } from "../src/capabilities.ts";
import type { Measure } from "../src/compute/service.ts";
import { type Daemon, startDaemon } from "../src/daemon.ts";
import { Home } from "../src/home.ts";
import { fakeDocker } from "./fake-docker.ts";
import { freePort } from "./ports.ts";

/*
 * Watching an agent's desktop and taking it over (C1 step 9), over real HTTP between two nodes of one fleet: yours,
 * which keeps the team ("keep"), and the one its VM is on ("box"), with stand-ins for Docker, for deskd's sessions and
 * for the VM's encoder there. Your node passes each request on to the VM's node, and relays its stream as it comes.
 */

const root = mkdtempSync(join(tmpdir(), "invincible-desktop-watch-"));
const keepHome = new Home(join(root, "keep"));
const boxHome = new Home(join(root, "box"));
const keepPort = freePort();
const boxPort = freePort();
let keep: Daemon;
let box: Daemon;
let armToken: string;
const caps = (hostname: string, over: Partial<Capabilities> = {}): Capabilities => ({ os: "linux", arch: "x64", hostname, cores: 16, cpu: "test", memoryGb: 32, hasBattery: false, gpu: [], docker: false, vm: { kvm: false, tools: [] }, tools: [], localModels: [], tailscale: null, sandbox: { image: false, networks: false, vm: false }, ...over });
const measure: Measure = async (reason, body, limit): Promise<Calibration> => {
  const threads = ceilingThreads(body, limit);
  return { at: Date.now(), tookMs: 1, reason, body: bodyFingerprint(body, limit), cpu: { single: REFERENCE_SINGLE, multi: REFERENCE_SINGLE * threads * 0.75, threads, kernel: KERNEL }, memoryGbps: 9.5 };
};
const docker = fakeDocker();

/** deskd's stand-in on the VM's node: the agent's session and yours told apart by how they were started, your hold kept. */
const sessions: { args: string[]; asked: Record<string, unknown>[] }[] = [];
let hold: { since: number; idle: number; most: number; ends_in: number } | null = null;
const spawnSession = (args: string[]): SessionProcess => {
  const one = { args, asked: [] as Record<string, unknown>[] };
  sessions.push(one);
  const owner = args.includes("--owner-session");
  let take: ((line: string) => void) | null = null;
  let ended!: (code: number) => void;
  const exited = new Promise<number>((resolve) => (ended = resolve));
  return {
    write: (text) => {
      for (const line of text.trim().split("\n")) {
        const q = JSON.parse(line) as Record<string, unknown>;
        one.asked.push(q);
        const answer: Record<string, unknown> = { id: q.id, ok: true };
        const fresh = { since: 1_764_216_000.5, idle: 120, most: 900, ends_in: 120 };
        if (owner && q.name === "take") hold = fresh;
        else if (owner && q.name === "release") {
          answer.released = hold !== null;
          hold = null;
        } else if (q.argv) {
          // (Your input takes the desktop over if no one has it, as deskd's rule is; a word that is a look doesn't.)
          if (owner && !hold && (q.argv as string[])[0] !== "status") {
            hold = fresh;
            answer.took = true;
          }
          Object.assign(answer, { code: 0, stdout: "", stderr: "" });
        } else if (q.name === "screenshot") Object.assign(answer, { action: "screenshot", image: { media_type: "image/jpeg", data: "/9j/4AAQ", width: 1280, height: 800, settled: null } });
        if (owner) answer.hold = hold;
        queueMicrotask(() => take?.(JSON.stringify(answer)));
      }
    },
    onLine: (fn) => void (take = fn),
    kill: () => ended(-15),
    exited,
  };
};

/** The VM's encoder's stand-in: what it was started as and told, the frames a test gives it, and its end. */
const encoders: { args: string[]; said: string[]; closed: boolean; push(bytes: Uint8Array): void }[] = [];
const spawnFrames = (args: string[]): FramesProcess => {
  const queue: Uint8Array[] = [];
  let wake: (() => void) | null = null;
  let done = false;
  let exit!: (code: number) => void;
  const exited = new Promise<number>((resolve) => (exit = resolve));
  const end = (code: number) => { done = true; wake?.(); exit(code); };
  const one = { args, said: [] as string[], closed: false, push: (bytes: Uint8Array) => { queue.push(bytes); wake?.(); } };
  encoders.push(one);
  async function* chunks(): AsyncIterable<Uint8Array> {
    for (;;) {
      if (queue.length) yield queue.shift()!;
      else if (done) return;
      else await new Promise<void>((resolve) => (wake = resolve));
    }
  }
  return { chunks: chunks(), write: (text) => void one.said.push(text), close: () => { one.closed = true; end(0); }, kill: () => end(137), exited };
};
/** A frame as the encoder writes one, its payload a byte that says which. */
const frame = (kind: number, n: number) => {
  const out = new Uint8Array(14);
  new DataView(out.buffer).setUint32(0, 10);
  out[4] = kind;
  new DataView(out.buffer).setBigUint64(5, BigInt(1_764_216_000_000 + n));
  out[13] = n;
  return out;
};

async function call(name: RouteName, input: unknown, token = keepHome.adminToken(), signal?: AbortSignal): Promise<Response> {
  const route = routes[name];
  return fetch(`http://127.0.0.1:${keepPort}${route.path}`, { method: route.method, headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, ...(route.method === "POST" ? { body: JSON.stringify(input ?? {}) } : {}), ...(signal ? { signal } : {}) });
}
async function api<T = any>(name: RouteName, input?: unknown): Promise<T> {
  const response = await call(name, input);
  const body = (await response.json()) as T & { error?: string };
  if (!response.ok) throw new Error(`${name}: ${response.status} ${body.error ?? ""}`);
  return body;
}
async function until(ready: () => boolean | Promise<boolean>, ms = 10_000) {
  const end = Date.now() + ms;
  while (!(await ready())) {
    if (Date.now() > end) throw new Error("never got there");
    await Bun.sleep(10);
  }
}
/** The frames a stream has sent so far, read until `count` have come (beats left out). */
async function frames(reader: ReadableStreamDefaultReader<Uint8Array>, count: number): Promise<[number, number][]> {
  const parser = new DesktopFrames();
  const seen: [number, number][] = [];
  while (seen.length < count) {
    const { done, value } = await reader.read();
    if (done) break;
    for (const f of parser.push(value)) if (f.kind !== DESKTOP_FRAME_KIND.beat) seen.push([f.kind, f.payload[0]!]);
  }
  return seen;
}
/** What the box's ledger says of its desktops, the oldest first (it reads newest first). */
const boxLedger = () => box.store.ledger(500).map((e) => e.body).filter((b) => b.resource === "sandbox.desktop").map((b) => b.detail).reverse();

beforeAll(async () => {
  // Your node founds the fleet and keeps the team; the box joins it, with Docker and microVMs.
  const { identity, keystore } = await keepHome.createIdentity("file");
  const store = new LedgerStore(keepHome.ledgerPath);
  const fleet = foundFleet(store, identity, { fleetName: "desk", nodeName: "keep" });
  store.close();
  keepHome.writeConfig({ v: 1, name: "keep", fleet, port: keepPort, keystore, advertise: "127.0.0.1" });
  keep = await startDaemon(keepHome, { capabilities: caps("keep"), syncIntervalMs: 100, proxyPort: freePort(), log: () => {}, measure, archiveIntervalMs: false });
  const invite = await api<{ invite: string }>("createInvite", { kind: "node" });
  const joined = await boxHome.createIdentity("file");
  const join = await requestPairing(invite.invite, { device: joined.identity.id, name: "box", kind: "node", box: b64u(joined.identity.boxPublic), endpoint: `http://127.0.0.1:${boxPort}` });
  const { pairings } = await api<{ pairings: { invite: string; device: string }[] }>("pairings");
  await api("approvePairing", { invite: pairings[0]!.invite, device: pairings[0]!.device });
  const approved = await waitForApproval(join, { intervalMs: 20 });
  const boxStore = new LedgerStore(boxHome.ledgerPath);
  boxStore.expectFleet(approved.fleet);
  boxStore.ingest((await signedPost<SyncPage>(joined.identity, keep.endpoint, "/link/sync", { have: {} })).events);
  boxStore.close();
  boxHome.writeConfig({ v: 1, name: "box", fleet: approved.fleet, port: boxPort, keystore: joined.keystore, advertise: "127.0.0.1" });
  box = await startDaemon(boxHome, {
    capabilities: caps("box", { docker: true, vm: { kvm: true, tools: ["kata"] }, tools: ["docker"], sandbox: { image: true, networks: true, vm: true } }),
    syncIntervalMs: 100,
    proxyPort: freePort(),
    log: () => {},
    measure,
    archiveIntervalMs: false,
    docker: docker.runner,
    spawnSession,
    spawnFrames,
  });
  // Your node knows the box is up, and that it makes microVMs, before it places one there.
  await until(() => box.store.lww(`calibration:${box.identity.id}`) !== null && keep.store.lww(`calibration:${box.identity.id}`) !== null);
  await until(async () => (await api<{ peers: { online: boolean }[] }>("fleet")).peers.some((peer) => peer.online));
  await until(() => Boolean((keep.store.activeDevice(box.identity.id)?.profile?.caps as { sandbox?: { vm?: boolean } } | undefined)?.sandbox?.vm));
  await api("saveAgent", { id: "una", name: "UNA", role: "engineer" });
  await api("saveAgent", { id: "vmless", name: "VMLESS", role: "engineer" });
  const made = await api<{ workspace: { id: string; image: string; node: string } }>("provisionAgent", { id: "una", on: "box" });
  expect(made.workspace.image).toBe("invincible/desktop:1");
  armToken = (await api<{ token: string }>("mintArm", { label: "test-arm" })).token;
}, 30_000);

afterAll(async () => {
  await box?.stop();
  await keep?.stop();
  rmSync(root, { recursive: true, force: true });
});

describe("an agent's desktop, from your node, on the node its VM is on", () => {
  test("you take it over and give it back: through your own session there, as the owner's uid, and that node's ledger says each", async () => {
    expect(await api("teamDesktopTake", { id: "una" })).toEqual({ held: { since: 1_764_216_000_500, idleSec: 120, mostSec: 900, endsInSec: 120 } });
    const yours = sessions.find((s) => s.args.includes("--owner-session"))!;
    expect(yours.args).toContain("1001:1001");
    expect(yours.asked.map((q) => q.name)).toEqual(["take"]);
    expect(await api("teamDesktopRelease", { id: "una" })).toEqual({ held: null });
    expect(boxLedger()).toEqual(["took over its desktop: yours until you give it back, or 120 s pass with no input from you (15 min at most)", "gave its desktop back"]);
  });

  test("your click with no picture asked answers once it is done, and says you now have the desktop, as your input took it", async () => {
    expect(await api("teamDesktop", { id: "una", action: { do: "click", x: 4, y: 5 }, picture: false })).toEqual({ done: true, held: { since: 1_764_216_000_500, idleSec: 120, mostSec: 900, endsInSec: 120 } });
    // A look, picture and all, says it too.
    expect(await api("teamDesktop", { id: "una" })).toMatchObject({ shot: { mediaType: "image/jpeg" }, held: { idleSec: 120 } });
    expect(boxLedger().slice(-2)).toEqual(["took over its desktop by your input: yours until you give it back, or 120 s pass with no input from you (15 min at most)", "click 4 5 left"]);
    await api("teamDesktopRelease", { id: "una" });
  });

  test("you watch it: one encoder in its VM for two of your devices, its frames relayed through your node as they come, each from a keyframe; your input asks for fast frames; leaving ends it", async () => {
    const first = new AbortController();
    const asked = call("teamDesktopStream", { id: "una" }, undefined, first.signal);
    await until(() => encoders.length === 1);
    expect(encoders[0]!.args).toEqual(["exec", "--interactive", expect.stringMatching(/^invincible-sbx-[0-9a-f]{10}$/), "desktop", "stream"]);
    encoders[0]!.push(frame(DESKTOP_FRAME_KIND.key, 1));
    const a = await asked;
    expect(a.status).toBe(200);
    expect(a.headers.get("content-type")).toBe(DESKTOP_FRAMES_TYPE);
    const ra = a.body!.getReader();
    expect(await frames(ra, 1)).toEqual([[1, 1]]);
    // A second device: a keyframe is asked for, and it is sent from that one on.
    const second = new AbortController();
    const askedB = call("teamDesktopStream", { id: "una" }, undefined, second.signal);
    await until(() => encoders[0]!.said.includes("key\n"));
    encoders[0]!.push(frame(DESKTOP_FRAME_KIND.key, 2));
    const rb = (await askedB).body!.getReader();
    expect(await frames(rb, 1)).toEqual([[1, 2]]);
    expect(await frames(ra, 1)).toEqual([[1, 2]]);
    await api("teamDesktop", { id: "una", action: { do: "key", keys: ["Return"] }, picture: false });
    expect(encoders[0]!.said).toEqual(["key\n", "fast\n"]);
    encoders[0]!.push(frame(DESKTOP_FRAME_KIND.delta, 3));
    expect(await frames(ra, 1)).toEqual([[2, 3]]);
    expect(await frames(rb, 1)).toEqual([[2, 3]]);
    expect(encoders).toHaveLength(1);
    first.abort();
    second.abort();
    await until(() => encoders[0]!.closed);
    await api("teamDesktopRelease", { id: "una" });
  });

  test("an agent is refused each of it, however it asks; one with no VM is told so, and one that isn't there isn't found", async () => {
    const asAgent = (name: RouteName, input: unknown) => call(name, input, armToken).then((r) => r.status);
    expect(await asAgent("teamDesktopTake", { id: "una" })).toBe(403);
    expect(await asAgent("teamDesktopRelease", { id: "una" })).toBe(403);
    expect(await asAgent("teamDesktopStream", { id: "una" })).toBe(403);
    const vm = (await api<{ agents: { id: string; workspace: { id: string; node: string } | null }[] }>("team")).agents.find((a) => a.id === "una")!.workspace!;
    const run = `arm.${teamArmLabel(keep.identity.id, "una")}`;
    expect(await asAgent("teamDesktopStreamOn", { id: vm.id, on: vm.node, run })).toBe(403);
    expect(await asAgent("teamDesktopHoldOn", { id: vm.id, on: vm.node, run, take: true })).toBe(403);
    expect(sessions.flatMap((s) => s.asked).filter((q) => q.name === "take")).toHaveLength(1);
    expect((await call("teamDesktopTake", { id: "vmless" })).status).toBe(424);
    expect((await call("teamDesktopStream", { id: "nobody" })).status).toBe(404);
  });

  test("a node you didn't trust with the vault (a limited one) is refused each twin, on the VM's node and on yours, though it holds `sandbox`; you, and the full node that passes your request on, get through as before", async () => {
    // (Enrolled as the fleet's records allow, though pairing makes every node a full one.)
    const lent = newNodeIdentity();
    keep.store.emit(keep.identity, "device.enrolled", { device: lent.id, name: "lent", kind: "node", role: "limited", box: b64u(lent.boxPublic), scopes: ["sandbox"] });
    await until(() => box.store.activeDevice(lent.id) !== null);
    const vm = (await api<{ agents: { id: string; workspace: { id: string; node: string } | null }[] }>("team")).agents.find((a) => a.id === "una")!.workspace!;
    const run = `arm.${teamArmLabel(keep.identity.id, "una")}`;
    const before = { asked: sessions.flatMap((s) => s.asked).length, encoders: encoders.length };
    const asLent = (port: number, name: RouteName, input: unknown) => signedFetch(lent, `http://127.0.0.1:${port}`, routes[name].path, input).then((r) => r.status);
    for (const [port, on] of [[boxPort, {}], [keepPort, { on: vm.node }]] as const) {
      expect(await asLent(port, "teamDesktopOn", { id: vm.id, ...on, run, action: { do: "click", x: 1, y: 1 } })).toBe(403);
      expect(await asLent(port, "teamDesktopHoldOn", { id: vm.id, ...on, run, take: true })).toBe(403);
      expect(await asLent(port, "teamDesktopStreamOn", { id: vm.id, ...on, run })).toBe(403);
    }
    // None of it reached the VM's desktop.
    expect(sessions.flatMap((s) => s.asked)).toHaveLength(before.asked);
    expect(encoders).toHaveLength(before.encoders);
    // You, from your node, which passes it on to the VM's as a full node: as before.
    expect(await api("teamDesktop", { id: "una", picture: false })).toMatchObject({ done: true, held: null });
  });
});
