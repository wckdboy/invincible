// Makes mind-v0.db and mind-v0.json: a replica written by the store as it was before
// schema versions (commit 391be80), and what that code read back from it. The migration
// test opens a copy with today's code and checks nothing was lost or changed.
//
// Kept for the record: it was run once, at that commit (`bun packages/mind/test/fixtures/make-mind-v0.ts`).
// Running it with today's code would make a migrated database instead, which is not the point.
// Every key in it is a throwaway made for this file; the vault holds only fake values.
import { copyFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { b64u, type GEvent, HlcClock, newNodeIdentity, registrationDigest, sha256B64u, signEvent, toolDigest } from "@galahad/core";
import { enrollDevice, foundFleet, MindStore, revokeDevice, Vault } from "../../src/index.ts";

const dir = mkdtempSync(join(tmpdir(), "galahad-fixture-"));
const path = join(dir, "mind.db");
const here = import.meta.dir;

let now = Date.UTC(2026, 9, 1, 8, 0, 0);
const clock = () => now;
const step = (ms = 60_000) => (now += ms);

const a = newNodeIdentity();
const b = newNodeIdentity();
const c = newNodeIdentity();
const stranger = newNodeIdentity();
const store = new MindStore(path, new HlcClock(clock));
foundFleet(store, a, { fleetName: "fixture", nodeName: "founder" });
step();
enrollDevice(store, a, { device: b.id, name: "sandbox-host", kind: "node", box: b64u(b.boxPublic) });
enrollDevice(store, a, { device: c.id, name: "spare", kind: "node", box: b64u(c.boxPublic) });
const phone = `c_${"p".repeat(87)}`;
enrollDevice(store, a, { device: phone, name: "phone", kind: "client", scopes: ["mind:read", "chat"] });
store.emit(a, "device.scoped", { device: phone, scopes: ["mind:read", "chat", "fleet:admin"] });
step();

// The other nodes write on their own replicas; everything meets on the founder's.
const replica = () => {
  const r = new MindStore(":memory:", new HlcClock(clock));
  r.expectFleet(store.fleet!);
  r.ingest(store.eventsSince({}, 100_000).events);
  return r;
};
const sync = (from: MindStore, to: MindStore) => to.ingest(from.eventsSince({}, 100_000).events);
const storeB = replica();
const storeC = replica();

const vault = new Vault(store, a);
vault.set("example", "test-only-not-a-real-key-0001", { provider: "example", origin: "https://api.example.com" });
vault.set("scratch", "test-only-not-a-real-key-0002");
vault.delete("scratch");
vault.request("weather", "to read the forecast", "example");
store.emit(a, "provider.set", { id: "example", kind: "openai", baseUrl: "https://api.example.com/v1", secret: "example" });
store.emit(a, "provider.set", { id: "gone", kind: "openai", baseUrl: "https://gone.example.com/v1" });
store.emit(a, "provider.removed", { id: "gone" });
store.emit(a, "roster.set", { role: "swift", models: ["example/small"] });
step();

const m1 = store.remember(a, "the founder likes short answers", { tags: ["style"] });
store.remember(a, "the sandbox host is in a closet", { tags: ["fleet"], prov: { trust: "agent", via: phone } });
store.remember(a, "an untrusted page said something", { prov: { trust: "untrusted", source: "https://example.com" } });
store.emit(a, "memory.forgotten", { memory: m1.id });
storeB.remember(b, "b remembers the build cache", { tags: ["build"] });
step();

const loop = (name: string, on: string) => ({ name, schedule: "every 30m", tz: "UTC", on, enabled: true, task: { kind: "heartbeat" } });
store.emit(a, "loop.set", loop("heartbeat", b.id));
store.emit(a, "loop.set", loop("poll", c.id));
store.emit(a, "loop.set", loop("old", a.id));
store.emit(a, "loop.removed", { name: "old" });
sync(store, storeB);
sync(store, storeC);
const slot0 = Date.UTC(2026, 9, 1, 9, 0, 0);
for (let i = 0; i < 40; i++) {
  step(30 * 60_000);
  const slot = slot0 + i * 30 * 60_000;
  storeB.emit(b, "loop.ran", { loop: "heartbeat", run: `s${slot.toString(36)}`, slot, status: i % 7 === 3 ? "attention" : "ok", started: slot, finished: slot + 900, summary: "All quiet." });
  for (let j = 0; j < 12; j++) {
    storeB.emit(b, "ledger.recorded", { class: "create", resource: "sandbox.exec", target: `sb${i}`, verdict: "allow", quest: `q${i}`, detail: `step ${j}` });
  }
  if (i % 4 === 0) storeC.emit(c, "loop.ran", { loop: "poll", run: `s${slot.toString(36)}`, slot, status: "ok", started: slot, finished: slot + 100, summary: "Nothing new." });
}
storeB.emit(b, "loop.ran", { loop: "heartbeat", run: "mbyhand", slot: null, status: "ok", started: now, finished: now + 10, summary: "By hand." });
sync(storeB, store);
sync(storeC, store);
step();

store.emit(a, "notice.raised", { key: "disk:b", severity: "warn", title: "Disk filling", body: "80 %", source: "heartbeat", node: b.id, at: now });
store.emit(a, "notice.dismissed", { key: "disk:b" });
store.emit(a, "notice.raised", { key: "vault:c", severity: "alert", title: "Vault locked", body: "", source: "heartbeat", at: now });
store.emit(a, "notice.cleared", { key: "vault:c" });
step();

const manifest = {
  id: "example",
  label: "Example",
  origin: "https://api.example.com",
  tools: {
    "note.create": {
      description: "Post a note.",
      method: "POST",
      path: "/notes/{owner}",
      params: { owner: { type: "string" }, text: { type: "string", required: true } },
      class: "outward",
    },
  },
};
store.emit(a, "connector.set", { id: "example", manifest });
store.emit(a, "project.set", { id: "fixture", name: "Fixture", instructions: "Be brief." });
const action = (n: number) => `a_${String(n).padStart(22, "0")}`;
const requested = (id: string) => ({
  id,
  connector: "example",
  tool: "note.create",
  args: { owner: "someone", text: "hello" },
  class: "outward" as const,
  target: "POST /notes/someone",
  by: "arm:fixture",
  expires: now + 24 * 60 * 60_000,
});
store.emit(a, "action.requested", requested(action(1)));
store.emit(a, "action.decided", { id: action(1), verdict: "approved" }, { trust: "owner", via: phone });
store.emit(a, "action.done", { id: action(1), ok: true, status: 201, receipt: "201 created" });
store.emit(a, "action.requested", requested(action(2)));
store.emit(a, "action.decided", { id: action(2), verdict: "denied", note: "not today" });
store.emit(a, "action.requested", requested(action(3))); // still waiting
const orderId = `o_${"1".padStart(22, "0")}`;
store.emit(a, "order.set", {
  id: orderId,
  connector: "example",
  tool: "note.create",
  class: "outward",
  args: { owner: "someone" },
  until: now + 30 * 24 * 60 * 60_000,
  digest: toolDigest(manifest as never, "note.create")!,
  label: "Notes for someone",
});
store.emit(a, "action.requested", requested(action(4)));
store.emit(a, "order.applied", { order: orderId, action: action(4) });
store.emit(a, "order.revoked", { id: orderId });
const registration = { question: "Does it hold?", hypothesis: "Yes.", alternative: "No.", predictions: [], method: "Look.", verification: [], uncertainty: "None.", decision: "Yes if it holds." };
store.emit(a, "investigation.registered", { id: `inv_${"1".padStart(22, "0")}`, question: "Does it hold?", registration, digest: registrationDigest(registration) });
store.emit(a, "investigation.concluded", { id: `inv_${"1".padStart(22, "0")}`, status: "done", conclusion: "supported", summary: "It held." });
store.emit(a, "artifact.saved", { id: `art_${"1".padStart(22, "0")}`, label: "plots", bytes: 3, count: 1, files: [{ path: "out/a.txt", size: 3, sha256: "0".repeat(64) }] });
step();

// Things the log must keep exactly as they are: a kind this version doesn't know (stored, ignored)…
const head = (s: MindStore, id: string) => s.head(id);
const forge = (signer: typeof a, kind: string, body: unknown, prev: string | null, hlc: string): GEvent =>
  signEvent({ v: 2, fleet: store.fleet!, hlc, device: signer.id, prev, kind, body: body as never }, signer);
const t = new HlcClock(clock);
store.ingest([forge(a, "future.kind", { anything: [1, 2, 3] }, head(store, a.id), t.tick())]);
// …c forks its own chain (equivocation), and is then revoked…
const cHead = head(store, c.id);
step();
store.ingest([forge(c, "memory.added", { text: "left branch" }, cHead, t.tick()), forge(c, "memory.added", { text: "right branch" }, cHead, t.tick())]);
step();
revokeDevice(store, a, c.id, "forked its chain");
step();
// …a loop run from the revoked node, after its revocation (refused)…
store.ingest([forge(c, "loop.ran", { loop: "poll", run: "late", slot: slot0 + 99 * 30 * 60_000, status: "ok", started: now, finished: now, summary: "late" }, head(store, c.id), t.tick())]);
// …and an event from a key nobody enrolled (parked, never relayed).
const strangerEvent = signEvent({ v: 2, fleet: store.fleet!, hlc: t.tick(), device: stranger.id, prev: null, kind: "memory.added", body: { text: "who am I" } }, stranger);
store.ingest([strangerEvent]);

store.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
const events = store.db.query<{ id: string; raw: string }, []>("SELECT id, raw FROM events ORDER BY id").all();
const expected = {
  made: "commit 391be80 (before schema versions)",
  fleet: store.fleet,
  devices: { a: a.id, b: b.id, c: c.id, stranger: stranger.id, phone },
  eventCount: store.eventCount(),
  /** sha256 over every stored event, in id order: the log itself must not change. */
  log: sha256B64u(events.map((e) => `${e.id}:${e.raw}`).join("\n")),
  digest: store.digest(),
  frontier: store.frontier(),
  heads: { a: store.head(a.id), b: store.head(b.id), c: store.head(c.id) },
  lastSlot: {
    heartbeatOnB: store.lastSlot("heartbeat", b.id),
    pollOnC: store.lastSlot("poll", c.id),
    heartbeatOnA: store.lastSlot("heartbeat", a.id),
  },
  loopRuns: store.loopRuns(undefined, 1000).map((e) => e.id),
  ledger: store.ledger(1000).map((e) => e.id),
  rejected: store.db.query("SELECT id, reason FROM v_rejected ORDER BY id").all(),
  forks: store.forks(),
  pending: store.pendingCount(),
  recall: store.recall(undefined, 50).map((m) => m.id),
  rebuiltDigest: (() => {
    store.rebuild();
    return store.digest();
  })(),
};
if (expected.rebuiltDigest !== expected.digest) throw new Error("the old code's own rebuild changed its state");
store.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
store.close();
copyFileSync(path, join(here, "mind-v0.db"));
writeFileSync(join(here, "mind-v0.json"), `${JSON.stringify(expected, null, 2)}\n`);
rmSync(dir, { recursive: true, force: true });
console.log(`${expected.eventCount} events, ${expected.rejected.length} rejected, ${expected.pending} parked; digest ${expected.digest}`);
