import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { b64u, newNodeIdentity, type Prov, type RouteName, routes, SEATS_READ, type SeatView, signEvent } from "@invincible/core";
import { enrollDevice, foundFleet, LedgerStore } from "@invincible/ledger";
import type { Capabilities } from "../src/capabilities.ts";
import { type Daemon, startDaemon } from "../src/daemon.ts";
import { Home } from "../src/home.ts";
import { freePort } from "./ports.ts";

/*
 * A seat of a kind some node of the fleet can't read yet is never added (the lead's word, 27 November 2026): that node
 * would refuse its seat.added, and hold back its sync of everything this node writes after it. Each node says in its
 * profile which kinds it reads (core's SEATS_READ); an older one says nothing, and reads the first six alone. A fleet
 * of two nodes over real HTTP: this one, and a mini on an older release.
 */

const caps: Capabilities = { os: "linux", arch: "x64", hostname: "seats-test", cores: 4, cpu: "test", memoryGb: 8, hasBattery: false, gpu: [], docker: false, vm: { kvm: false, tools: [] }, tools: [], localModels: [], tailscale: null };

const root = mkdtempSync(join(tmpdir(), "invincible-seat-kinds-"));
const home = new Home(join(root, "node"));
const port = freePort();
let daemon: Daemon;

const admin = async <T = any,>(name: RouteName, input?: unknown): Promise<{ status: number; body: T }> => {
  const route = routes[name];
  const response = await fetch(`http://127.0.0.1:${port}${route.path}`, { method: route.method, headers: { authorization: `Bearer ${home.adminToken()}`, "content-type": "application/json" }, body: route.method === "POST" ? JSON.stringify(input ?? {}) : undefined });
  return { status: response.status, body: (await response.json().catch(() => ({}))) as T };
};
const logText = () => JSON.stringify(daemon.store.eventsSince({}, 100_000).events);

beforeAll(async () => {
  const { identity, keystore } = await home.createIdentity("file");
  const store = new LedgerStore(home.ledgerPath);
  const fleet = foundFleet(store, identity, { fleetName: "homelab", nodeName: "ultra" });
  store.close();
  home.writeConfig({ v: 1, name: "ultra", fleet, port, keystore, advertise: "127.0.0.1" });
  daemon = await startDaemon(home, { capabilities: caps, proxyPort: freePort(), log: () => {} });
});

afterAll(async () => {
  await daemon?.stop();
  rmSync(root, { recursive: true, force: true });
});

describe("a seat of a kind the fleet can't all read", () => {
  test("a seat of a kind some node of the fleet can't read yet is refused, that node named, and nothing written; once it reads it, added", async () => {
    // This node says in its profile which kinds it reads.
    expect((daemon.store.device(daemon.identity.id)?.profile?.caps as { seats?: unknown }).seats).toEqual(SEATS_READ);
    // A second node, an older release's: it has said nothing of seats (its profile, as such a release publishes it).
    const mini = newNodeIdentity();
    enrollDevice(daemon.store, daemon.identity, { device: mini.id, name: "mini", kind: "node", box: b64u(mini.boxPublic) });
    const said = () => daemon.store.eventsSince({}, 100_000).events.filter((e) => e.kind === "seat.added").length;
    const before = said();
    const gemini = { kind: "google-antigravity", label: "Gemini 1", email: "owner@example.test" };
    const behind = "Update mini first: it runs a release that doesn't know Gemini plans";
    // Not yet heard from at all, then an older release's profile: refused either way, before anything is written.
    let refused = await admin<{ error: string }>("addSeat", gemini);
    expect([refused.status, refused.body.error]).toEqual([409, behind]);
    daemon.store.emit(mini, "node.profile", { endpoint: "http://192.0.2.20:7400", caps: { requests: 2 } });
    refused = await admin<{ error: string }>("addSeat", gemini);
    expect([refused.status, refused.body.error]).toEqual([409, behind]);
    expect(said()).toBe(before);
    // (This node's own profile names the kind it reads; no seat of it, and nothing of the one asked for, is in the log.)
    for (const kept of ["Gemini 1", "owner@example.test"]) expect(logText()).not.toContain(kept);
    // (Nor its email in the vault: a secret is said in the log too.)
    expect(daemon.store.eventsSince({}, 100_000).events.some((e) => e.kind === "secret.set" && String((e.body as { name?: unknown }).name).startsWith("seat-email"))).toBe(false);
    // A kind every release reads is added all the same.
    const claude = await admin<{ seat: SeatView }>("addSeat", { kind: "claude-subscription", label: "Claude 1" });
    expect(claude.status).toBe(200);
    // Once the mini says it reads Gemini plans, one is added.
    daemon.store.emit(mini, "node.profile", { endpoint: "http://192.0.2.20:7400", caps: { requests: 2, seats: SEATS_READ } });
    const added = await admin<{ seat: SeatView }>("addSeat", { kind: "google-antigravity", label: "Gemini 1" });
    expect([added.status, added.body.seat?.kind]).toEqual([200, "google-antigravity"]);
    // A node you revoked holds nothing back: an older one revoked, and the add goes on.
    const old = newNodeIdentity();
    enrollDevice(daemon.store, daemon.identity, { device: old.id, name: "attic", kind: "node", box: b64u(old.boxPublic) });
    expect((await admin("addSeat", { kind: "google-antigravity", label: "Gemini 2" })).status).toBe(409);
    expect((await admin("revokeDevice", { device: old.id, reason: "gone" })).status).toBe(200);
    const after = await admin<{ seat: SeatView }>("addSeat", { kind: "google-antigravity", label: "Gemini 2" });
    expect(after.status).toBe(200);
    for (const id of [claude.body.seat.id, added.body.seat.id, after.body.seat.id]) expect((await admin("removeSeat", { id })).status).toBe(200);
  });

  test("a seat of a kind a later release brings, written by that release's node, is listed apart and used for nothing here; what that node writes after it applies", async () => {
    // A node on a later release: a seat of a kind this one doesn't know, then a Claude plan, one after the other in its chain.
    const later = newNodeIdentity();
    enrollDevice(daemon.store, daemon.identity, { device: later.id, name: "studio", kind: "node", box: b64u(later.boxPublic) });
    const yours: Prov = { trust: "owner", via: `c_${"p".repeat(44)}` };
    let prev = daemon.store.head(later.id);
    const write = (kind: string, body: unknown) => {
      const event = signEvent({ v: 2, fleet: daemon.store.fleet!, hlc: daemon.store.clock.tick(), device: later.id, prev, kind, body: body as never, prov: yours }, later);
      prev = event.id;
      return event;
    };
    const cursor = `st_${"c".repeat(22)}`;
    const work = `st_${"w".repeat(22)}`;
    const written = [write("seat.added", { id: cursor, kind: "cursor-plan", label: "Cursor 1", node: later.id, runs: 1 }), write("seat.added", { id: work, kind: "claude-subscription", label: "Work Max", node: later.id, runs: 1 })];
    expect(daemon.store.ingest(written).invalid).toEqual([]);
    const listed = await admin<{ seats: SeatView[]; unknown?: unknown[] }>("seats");
    expect(listed.status).toBe(200);
    expect(listed.body.seats.map((seat) => seat.id)).toEqual([work]);
    expect(listed.body.unknown).toEqual([{ id: cursor, kind: "cursor-plan", label: "Cursor 1", node: later.id, addedAt: expect.any(Number) }]);
    // Nothing of it is done here: it is no seat of those this release knows.
    expect((await admin("startSeatSignIn", { id: cursor })).status).toBe(404);
    expect((await admin("setSeatServes", { id: cursor, agents: [] })).status).toBe(404);
  });

});
