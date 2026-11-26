import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { b64u, type GEvent, newNodeIdentity, type NodeIdentity } from "@galahad/core";
import { enrollDevice, foundFleet, MindStore, Vault } from "../src/index.ts";

/*
 * Key requests you dismiss (secret.request.dismissed): out of your Inbox until he asks again. The newer of an ask and a
 * dismissal stands on every replica, in any order, with duplicates and after a rebuild; and a replica that held a
 * dismissal before it knew the kind applies it once it is upgraded.
 */

function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffle<T>(items: T[], random: () => number): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

const allEvents = (store: MindStore): GEvent[] => store.eventsSince({}, 100_000).events;

function syncInto(from: MindStore, to: MindStore): void {
  for (;;) {
    const { events, more } = from.eventsSince(to.frontier(), 7);
    to.ingest(events);
    if (!more) return;
  }
}

function fleet(): { a: NodeIdentity; b: NodeIdentity; storeA: MindStore; storeB: MindStore } {
  const a = newNodeIdentity();
  const b = newNodeIdentity();
  const storeA = new MindStore(":memory:");
  foundFleet(storeA, a, { fleetName: "camelot", nodeName: "ultra" });
  enrollDevice(storeA, a, { device: b.id, name: "mini", kind: "node", box: b64u(b.boxPublic) });
  const storeB = new MindStore(":memory:");
  storeB.expectFleet(storeA.fleet!);
  syncInto(storeA, storeB);
  return { a, b, storeA, storeB };
}

const open = (vault: Vault) => vault.requests().map((r) => `${r.name}: ${r.purpose}`);

describe("key requests you dismiss", () => {
  test("dismissed, it leaves the Inbox on every replica; asked for again, it's back", () => {
    const { a, b, storeA, storeB } = fleet();
    const ultra = new Vault(storeA, a);
    const mini = new Vault(storeB, b);
    ultra.request("github", "to open a pull request", "github");
    ultra.request("deepseek", "to ask a second model");
    syncInto(storeA, storeB);
    expect(open(mini)).toEqual(["deepseek: to ask a second model", "github: to open a pull request"]);

    // Dismissed on the mini, as your phone's call would be there.
    expect(mini.dismissRequest("github")).toBe(true);
    expect(open(mini)).toEqual(["deepseek: to ask a second model"]);
    syncInto(storeB, storeA);
    expect(open(ultra)).toEqual(["deepseek: to ask a second model"]);
    // Nothing to dismiss: already dismissed, or never asked for.
    expect(ultra.dismissRequest("github")).toBe(false);
    expect(ultra.dismissRequest("weather")).toBe(false);

    // He asks again: it's open again, with what he says it's for now.
    ultra.request("github", "to merge the release branch", "github");
    syncInto(storeA, storeB);
    expect(open(mini)).toEqual(["deepseek: to ask a second model", "github: to merge the release branch"]);
    expect(storeA.digest()).toBe(storeB.digest());
  });

  test("PROPERTY: any delivery order, with duplicates, yields the same open requests and the identical mind; a rebuild too", () => {
    const { a, b, storeA, storeB } = fleet();
    const random = rng(47);
    const names = ["github", "deepseek", "cloudflare", "weather"];
    for (let round = 0; round < 80; round++) {
      const [store, signer] = random() < 0.5 ? [storeA, a] : [storeB, b];
      const name = names[Math.floor(random() * names.length)]!;
      // Asks and dismissals race: a dismissal may land on a replica before the ask it answers.
      if (random() < 0.5) store.emit(signer, "secret.requested", { name, purpose: `round ${round}` });
      else store.emit(signer, "secret.request.dismissed", { name });
      store.remember(signer, `note ${round}`);
      if (round % 13 === 12) {
        syncInto(storeA, storeB);
        syncInto(storeB, storeA);
      }
    }
    const everything = [...new Map([...allEvents(storeA), ...allEvents(storeB)].map((e) => [e.id, e])).values()];
    expect(everything.filter((e) => e.kind === "secret.request.dismissed").length).toBeGreaterThan(10);
    let reference: { digest: string; open: string[] } | null = null;
    for (let seed = 1; seed <= 8; seed++) {
      const order = rng(seed);
      const replica = new MindStore(":memory:");
      replica.expectFleet(storeA.fleet!);
      const shuffled = shuffle([...everything, ...everything.slice(0, 12)], order);
      for (let i = 0; i < shuffled.length; i += 1 + Math.floor(order() * 5)) replica.ingest(shuffled.slice(i, i + 5));
      replica.ingest(shuffled);
      const vault = new Vault(replica, a);
      reference ??= { digest: replica.digest(), open: open(vault) };
      expect(replica.digest()).toBe(reference.digest);
      expect(open(vault)).toEqual(reference.open);
      replica.rebuild();
      expect(replica.digest()).toBe(reference.digest);
      expect(open(vault)).toEqual(reference.open);
      replica.close();
    }
    syncInto(storeA, storeB);
    syncInto(storeB, storeA);
    expect(storeA.digest()).toBe(reference!.digest);
    expect(open(new Vault(storeB, b))).toEqual(reference!.open);
  }, 60_000);

  test("a replica that held a dismissal before it knew the kind applies it when it's upgraded", () => {
    const dir = mkdtempSync(join(tmpdir(), "galahad-requests-"));
    try {
      const path = join(dir, "mind.db");
      const a = newNodeIdentity();
      let store = new MindStore(path);
      foundFleet(store, a, { fleetName: "camelot", nodeName: "ultra" });
      new Vault(store, a).request("github", "to open a pull request");
      store.close();
      // What the older code holds for the ask, which it applied: the dismissal after it, it kept but didn't know.
      let raw = new Database(path);
      const asked = raw.query<{ k: string; hlc: string; eid: string; device: string; v: string }, []>("SELECT k, hlc, eid, device, v FROM v_lww WHERE k = 'secret-request:github'").get()!;
      raw.close();
      store = new MindStore(path);
      expect(new Vault(store, a).dismissRequest("github")).toBe(true);
      const digest = store.digest();
      store.close();
      // As the older code left it: the dismissal in the log, the ask still open in the views, the older schema version.
      raw = new Database(path);
      raw.query("INSERT OR REPLACE INTO v_lww (k, hlc, eid, device, v) VALUES (?, ?, ?, ?, ?)").run(asked.k, asked.hlc, asked.eid, asked.device, asked.v);
      raw.exec("PRAGMA user_version = 5;");
      raw.close();
      const upgraded = new MindStore(path);
      expect(upgraded.schemaVersion()).toBe(6);
      expect(open(new Vault(upgraded, a))).toEqual([]);
      expect(upgraded.digest()).toBe(digest);
      upgraded.close();
    } finally {
      rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });
});
