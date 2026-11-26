import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { b64u, type GEvent, HlcClock, isKnownKind, newNodeIdentity, type NodeIdentity, type Prov, seatState, signEvent } from "@invincible/core";
import { enrollDevice, foundFleet, LedgerStore } from "../src/index.ts";

/*
 * Seats in the mind (seat.added, seat.policy, seat.serves, seat.removed by you; seat.signin, seat.window, seat.rested, seat.back by
 * the node that holds the seat's home; core's seats.ts). Every replica applies them the same way, so they converge like
 * everything else: any order, duplicates, a rebuild; and a replica that held them before it knew them applies them
 * once it is upgraded. A kind of the seat's this version doesn't know is kept and ignored.
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

const allEvents = (store: LedgerStore): GEvent[] => store.eventsSince({}, 100_000).events;

function syncInto(from: LedgerStore, to: LedgerStore): void {
  for (;;) {
    const { events, more } = from.eventsSince(to.frontier(), 7);
    to.ingest(events);
    if (!more) return;
  }
}

/** Ultra holds the seats' homes; the mini is another full node of the same fleet. */
function fleet(now?: () => number): { a: NodeIdentity; b: NodeIdentity; storeA: LedgerStore; storeB: LedgerStore } {
  const a = newNodeIdentity();
  const b = newNodeIdentity();
  const storeA = new LedgerStore(":memory:", now ? new HlcClock(now) : undefined);
  foundFleet(storeA, a, { fleetName: "homelab", nodeName: "ultra" });
  enrollDevice(storeA, a, { device: b.id, name: "mini", kind: "node", box: b64u(b.boxPublic) });
  const storeB = new LedgerStore(":memory:", now ? new HlcClock(now) : undefined);
  storeB.expectFleet(storeA.fleet!);
  syncInto(storeA, storeB);
  return { a, b, storeA, storeB };
}

const PHONE = "c_phone000000000000000000000000000000000000000";
const YOURS: Prov = { trust: "owner", via: PHONE };
let n = 0;
const seatId = () => `st_${String(++n).padStart(22, "0")}`;
const attempt = () => `sa_${String(++n).padStart(22, "0")}`;
const ACCOUNT = "fp_account_one_0000000";
/** Agents a seat serves, each as itself: its id, and when it was made. */
const ADA = { id: "ada", made: 1_795_000_000_000 };
const BO = { id: "bo", made: 1_795_000_360_000 };
const OTHER = "fp_account_two_0000000";
const add = (store: LedgerStore, signer: NodeIdentity, node: NodeIdentity, id = seatId(), kind: "claude-subscription" | "chatgpt-codex" = "claude-subscription") =>
  (store.emit(signer, "seat.added", { id, kind, label: "Work Max", node: node.id, runs: 1 }, YOURS), id);
const ready = (store: LedgerStore, node: NodeIdentity, id: string, fingerprint = ACCOUNT, extra: Record<string, unknown> = {}) =>
  store.emit(node, "seat.signin", { id, attempt: attempt(), phase: "ended", outcome: "ready", method: "claude.ai", plan: "max", fingerprint, ...extra });
const seen = (store: LedgerStore) =>
  store.seats().map((s) => ({ id: s.id, label: s.label, runs: s.runs, sign: s.signIn ? (s.signIn.phase === "ended" ? s.signIn.outcome : "started") : null, account: s.account, windows: s.windows.map((w) => `${w.window}:${w.status}`), rest: s.rest?.until ?? null, serves: s.serves }));

function forged(store: LedgerStore, signer: NodeIdentity, kind: string, body: unknown, p?: Prov): GEvent {
  return signEvent({ v: 2, fleet: store.fleet!, hlc: store.clock.tick(), device: signer.id, prev: store.head(signer.id), kind, body: body as never, ...(p ? { prov: p } : {}) }, signer);
}

describe("seats in the mind", () => {
  test("added by you, signed in, its windows and a rest reported by its node: the same on every replica; removed, gone", () => {
    let now = Date.now();
    const { a, b, storeA, storeB } = fleet(() => now);
    const id = add(storeB, b, a);
    syncInto(storeB, storeA);
    expect(seatState(storeA.seats()[0]!, now)).toEqual({ is: "signed-out", why: "never" });
    const started = attempt();
    storeA.emit(a, "seat.signin", { id, attempt: started, phase: "started" });
    syncInto(storeA, storeB);
    expect(seatState(storeB.seats()[0]!, now)).toMatchObject({ is: "signing-in", attempt: started });
    now += 30_000;
    ready(storeA, a, id, ACCOUNT, { renewBy: now + 30 * 86_400_000 });
    storeA.emit(a, "seat.window", { id, window: "five_hour", status: "allowed", usedPercent: 40, resetsAt: now + 3_600_000 });
    storeA.emit(a, "seat.window", { id, window: "seven_day", status: "allowed", usedPercent: 12 });
    syncInto(storeA, storeB);
    const [seat] = storeB.seats();
    expect(seat).toMatchObject({ id, kind: "claude-subscription", label: "Work Max", node: a.id, provider: null, runs: 1, account: ACCOUNT });
    expect(seatState(seat!, now)).toEqual({ is: "ready", renewBy: now + 30 * 86_400_000 });
    expect(seen(storeB)[0]!.windows.sort()).toEqual(["five_hour:allowed", "seven_day:allowed"]);
    // Spent: it rests until the reset, and is back after it, or when its node says so.
    storeA.emit(a, "seat.window", { id, window: "five_hour", status: "rejected", usedPercent: 100, resetsAt: now + 3_600_000 });
    storeA.emit(a, "seat.rested", { id, until: now + 3_600_000, window: "five_hour" });
    syncInto(storeA, storeB);
    expect(seatState(storeB.seats()[0]!, now)).toEqual({ is: "resting", until: now + 3_600_000, window: "five_hour" });
    expect(seatState(storeB.seats()[0]!, now + 3_600_000)).toMatchObject({ is: "ready" });
    storeA.emit(a, "seat.back", { id });
    storeB.emit(b, "seat.policy", { id, runs: 2 }, YOURS);
    syncInto(storeA, storeB);
    syncInto(storeB, storeA);
    expect(seatState(storeA.seats()[0]!, now)).toMatchObject({ is: "ready" });
    expect(storeA.seats()[0]!.runs).toBe(2);
    expect(storeA.digest()).toBe(storeB.digest());
    storeB.emit(b, "seat.removed", { id }, YOURS);
    syncInto(storeB, storeA);
    expect(storeA.seats()).toEqual([]);
    expect(() => storeA.emit(a, "seat.window", { id, window: "five_hour", status: "allowed" })).toThrow("no such seat");
    expect(() => add(storeA, a, a, id)).toThrow("seat already added");
    expect(storeA.digest()).toBe(storeB.digest());
  });

  test("yours alone to add, set and remove, on a full node; its home on an active node", () => {
    const { a, b, storeA } = fleet();
    for (const prov of [{ trust: "agent" }, { trust: "untrusted" }] as Prov[]) {
      expect(() => storeA.emit(a, "seat.added", { id: seatId(), kind: "claude-subscription", label: "x", node: a.id, runs: 1 }, prov)).toThrow("a seat is yours alone to add");
    }
    expect(() => storeA.emit(a, "seat.added", { id: seatId(), kind: "claude-subscription", label: "x", node: a.id, runs: 1 })).toThrow("a seat is yours alone to add");
    const phone = "c_" + "p".repeat(43);
    expect(() => storeA.emit(a, "seat.added", { id: seatId(), kind: "claude-subscription", label: "x", node: phone, runs: 1 }, YOURS)).toThrow("a seat's home is on an active node");
    const limited = newNodeIdentity();
    storeA.emit(a, "device.enrolled", { device: limited.id, name: "sensor", kind: "node", role: "limited", box: b64u(limited.boxPublic), scopes: [] });
    expect(() => add(storeA, limited, a)).toThrow("only full nodes may record seats");
    const id = add(storeA, a, b);
    expect(() => storeA.emit(a, "seat.policy", { id, runs: 3 }, { trust: "agent" })).toThrow("a seat is yours alone to set");
    expect(() => storeA.emit(a, "seat.removed", { id }, { trust: "agent" })).toThrow("a seat is yours alone to set");
    expect(() => storeA.emit(a, "seat.policy", { id: seatId(), runs: 3 }, YOURS)).toThrow("no such seat");
    expect(storeA.seats().map((s) => s.id)).toEqual([id]);
  });

  test("the agents a seat serves: yours alone to choose, on a full node, each as itself; the last word stands; a seat with no home of its own serves none", () => {
    const { a, b, storeA, storeB } = fleet();
    const id = add(storeA, a, a);
    syncInto(storeA, storeB);
    // Added, it serves no agent until you choose one.
    expect(storeA.seats()[0]!.serves).toEqual([]);
    for (const prov of [{ trust: "agent" }, { trust: "untrusted" }, undefined] as (Prov | undefined)[]) {
      expect(() => storeA.emit(a, "seat.serves", { id, agents: [ADA] }, prov)).toThrow("a seat is yours alone to set");
    }
    expect(() => storeA.emit(a, "seat.serves", { id: seatId(), agents: [ADA] }, YOURS)).toThrow("no such seat");
    const limited = newNodeIdentity();
    storeA.emit(a, "device.enrolled", { device: limited.id, name: "sensor", kind: "node", role: "limited", box: b64u(limited.boxPublic), scopes: [] });
    expect(() => storeA.emit(limited, "seat.serves", { id, agents: [ADA] }, YOURS)).toThrow("only full nodes may record seats");
    // Each agent as itself, and nothing else: a body with more than its own fields, or an id no handle has, is refused.
    expect(() => storeA.emit(a, "seat.serves", { id, agents: [{ ...ADA, name: "Ada" }] } as never, YOURS)).toThrow();
    expect(() => storeA.emit(a, "seat.serves", { id, agents: [{ id: "Ada!", made: ADA.made }] }, YOURS)).toThrow();
    expect(() => storeA.emit(a, "seat.serves", { id, agents: [{ id: "ada", made: -1 }] }, YOURS)).toThrow();
    storeA.emit(a, "seat.serves", { id, agents: [ADA] }, YOURS);
    syncInto(storeA, storeB);
    // Shared later from another node of yours: the last word stands, on every replica.
    storeB.emit(b, "seat.serves", { id, agents: [ADA, BO] }, YOURS);
    syncInto(storeB, storeA);
    for (const store of [storeA, storeB]) expect(store.seats()[0]!.serves).toEqual([ADA, BO]);
    // And none: it serves no one.
    storeA.emit(a, "seat.serves", { id, agents: [] }, YOURS);
    syncInto(storeA, storeB);
    for (const store of [storeA, storeB]) expect(store.seats()[0]!.serves).toEqual([]);
    expect(storeA.digest()).toBe(storeB.digest());
    // A key's seat (or Sign in with ChatGPT's, whose tokens the node holds) has no home its agents share: it serves none.
    const keyed = seatId();
    storeA.emit(a, "seat.added", { id: keyed, kind: "api", label: "Key", node: a.id, provider: "anthropic", runs: 1 }, YOURS);
    expect(() => storeA.emit(a, "seat.serves", { id: keyed, agents: [ADA] }, YOURS)).toThrow("only a seat with a home of its own serves agents");
    storeA.emit(a, "seat.removed", { id }, YOURS);
    expect(storeA.seats().map((s) => s.id)).toEqual([keyed]);
  });

  test("only the node that holds a seat's home says how it stands, on every replica", () => {
    const { a, b, storeA, storeB } = fleet();
    const id = add(storeA, a, a);
    syncInto(storeA, storeB);
    expect(() => ready(storeB, b, id)).toThrow("only the node that holds a seat's home says how it stands");
    const sent = forged(storeB, b, "seat.rested", { id, until: Date.now() + 60_000 });
    storeB.ingest([sent]);
    syncInto(storeB, storeA);
    for (const store of [storeA, storeB]) {
      expect(store.rejection(sent.id)).toBe("only the node that holds a seat's home says how it stands");
      expect(store.seats()[0]!.rest).toBeNull();
    }
    expect(storeA.digest()).toBe(storeB.digest());
  });

  test("the account its first sign-in was to is the seat's: a sign-in to another is refused on every replica", () => {
    const { a, b, storeA, storeB } = fleet();
    const id = add(storeA, a, a);
    ready(storeA, a, id, ACCOUNT);
    expect(() => ready(storeA, a, id, OTHER)).toThrow("signed in to another account than the seat's");
    // A sign-out, and the same account again, are as they were.
    storeA.emit(a, "seat.signin", { id, phase: "ended", outcome: "signed-out" });
    expect(seatState(storeA.seats()[0]!, Date.now())).toEqual({ is: "signed-out", why: "signed-out" });
    ready(storeA, a, id, ACCOUNT);
    const wrong = forged(storeA, a, "seat.signin", { id, attempt: attempt(), phase: "ended", outcome: "ready", fingerprint: OTHER });
    storeA.ingest([wrong]);
    syncInto(storeA, storeB);
    for (const store of [storeA, storeB]) {
      expect(store.rejection(wrong.id)).toBe("signed in to another account than the seat's");
      expect(store.seats()[0]!.account).toBe(ACCOUNT);
      expect(seatState(store.seats()[0]!, Date.now())).toMatchObject({ is: "ready" });
    }
    expect(storeA.digest()).toBe(storeB.digest());
  });

  test("none of them carries a sign-in's address, its code or a token: a body with more than its own fields is refused", () => {
    const { a, storeA } = fleet();
    const id = add(storeA, a, a);
    for (const extra of [{ url: "https://claude.example.test/oauth/authorize?state=x" }, { code: "abc#state" }, { token: "not-a-token" }]) {
      expect(() => storeA.emit(a, "seat.signin", { id, attempt: attempt(), phase: "started", ...extra } as never)).toThrow();
      expect(() => storeA.emit(a, "seat.window", { id, window: "five_hour", status: "allowed", ...extra } as never)).toThrow();
    }
    expect(() => storeA.emit(a, "seat.added", { id: seatId(), kind: "claude-subscription", label: "x", node: a.id, runs: 1, email: "owner@example.test" } as never, YOURS)).toThrow();
  });

  test("a kind of the seat's this version doesn't know is kept and ignored", () => {
    const { a, b, storeA, storeB } = fleet();
    const id = add(storeA, a, a);
    const newer = forged(storeA, a, "seat.lent", { id, to: "another fleet" });
    expect(isKnownKind(newer.kind)).toBe(false);
    storeA.ingest([newer]);
    syncInto(storeA, storeB);
    for (const store of [storeA, storeB]) {
      expect(allEvents(store).some((e) => e.id === newer.id)).toBe(true);
      expect(store.rejection(newer.id)).toBeNull();
      expect(store.seats().map((s) => s.id)).toEqual([id]);
    }
    expect(storeA.digest()).toBe(storeB.digest());
  });

  test("PROPERTY: any delivery order, with duplicates, yields identical seats and the identical mind; a rebuild too", () => {
    const { a, b, storeA, storeB } = fleet();
    const random = rng(41);
    const ids: string[] = [];
    const quietly = (work: () => unknown): void => {
      try {
        work();
      } catch {
        /* refused by this replica's rules: not in its log */
      }
    };
    for (let round = 0; round < 90; round++) {
      const [store, signer] = random() < 0.5 ? [storeA, a] : [storeB, b];
      const pick = random();
      if (pick < 0.15 || !ids.length) ids.push(add(store, signer, random() < 0.5 ? a : b, seatId(), random() < 0.5 ? "claude-subscription" : "chatgpt-codex"));
      else {
        const id = ids[Math.floor(random() * ids.length)]!;
        const prov: Prov = random() < 0.15 ? { trust: "agent" } : YOURS;
        if (pick < 0.3) quietly(() => store.emit(signer, "seat.signin", { id, attempt: attempt(), phase: "started" }));
        else if (pick < 0.45) quietly(() => ready(store, signer, id, random() < 0.8 ? ACCOUNT : OTHER));
        else if (pick < 0.6) quietly(() => store.emit(signer, "seat.window", { id, window: random() < 0.5 ? "five_hour" : "seven_day", status: random() < 0.7 ? "allowed" : "rejected", usedPercent: Math.floor(random() * 101) }));
        else if (pick < 0.7) quietly(() => store.emit(signer, "seat.rested", { id, until: 1_900_000_000_000 + round, window: "five_hour" }));
        else if (pick < 0.78) quietly(() => store.emit(signer, "seat.back", { id }));
        else if (pick < 0.86) quietly(() => store.emit(signer, "seat.policy", { id, runs: 1 + Math.floor(random() * 3) }, prov));
        else if (pick < 0.9) quietly(() => store.emit(signer, "seat.removed", { id }, prov));
        else store.ingest([forged(store, signer, "seat.signin", { id, attempt: attempt(), phase: "ended", outcome: "ready", fingerprint: OTHER })]);
      }
      if (ids.length && random() < 0.3) {
        const id = ids[Math.floor(random() * ids.length)]!;
        const agents = [[], [ADA], [BO], [ADA, BO], [{ id: "ada", made: ADA.made + 1 }]][Math.floor(random() * 5)]!;
        quietly(() => store.emit(signer, "seat.serves", { id, agents }, random() < 0.15 ? { trust: "agent" } : YOURS));
      }
      store.remember(signer, `note ${round}`);
      if (round % 11 === 10) {
        syncInto(storeA, storeB);
        syncInto(storeB, storeA);
      }
    }
    const everything = [...new Map([...allEvents(storeA), ...allEvents(storeB)].map((e) => [e.id, e])).values()];
    expect(everything.filter((e) => e.kind === "seat.signin").length).toBeGreaterThan(10);
    expect(everything.filter((e) => e.kind === "seat.removed").length).toBeGreaterThan(0);
    expect(everything.filter((e) => e.kind === "seat.serves").length).toBeGreaterThan(3);
    let reference: { digest: string; seats: unknown } | null = null;
    for (let seed = 1; seed <= 8; seed++) {
      const order = rng(seed);
      const replica = new LedgerStore(":memory:");
      replica.expectFleet(storeA.fleet!);
      const shuffled = shuffle([...everything, ...everything.slice(0, 12)], order);
      for (let i = 0; i < shuffled.length; i += 1 + Math.floor(order() * 5)) replica.ingest(shuffled.slice(i, i + 5));
      replica.ingest(shuffled);
      reference ??= { digest: replica.digest(), seats: seen(replica) };
      expect(replica.digest()).toBe(reference.digest);
      expect(seen(replica)).toEqual(reference.seats as never);
      replica.rebuild();
      expect(replica.digest()).toBe(reference.digest);
      expect(seen(replica)).toEqual(reference.seats as never);
      replica.close();
    }
    syncInto(storeA, storeB);
    syncInto(storeB, storeA);
    expect(storeA.digest()).toBe(reference!.digest);
    expect(storeB.digest()).toBe(reference!.digest);
  }, 60_000);

  test("a replica that held them before it knew them applies them when it's upgraded", () => {
    const dir = mkdtempSync(join(tmpdir(), "invincible-seats-"));
    try {
      const path = join(dir, "ledger.db");
      const a = newNodeIdentity();
      const store = new LedgerStore(path);
      foundFleet(store, a, { fleetName: "homelab", nodeName: "ultra" });
      const id = add(store, a, a);
      ready(store, a, id);
      store.emit(a, "seat.window", { id, window: "five_hour", status: "allowed", usedPercent: 10 });
      const wrong = forged(store, a, "seat.signin", { id, attempt: attempt(), phase: "ended", outcome: "ready", fingerprint: OTHER });
      store.ingest([wrong]);
      const digest = store.digest();
      const seats = seen(store);
      store.close();
      // As the older code left it: the events in the log, nothing of them in the views, the older schema version.
      const raw = new Database(path);
      raw.exec(`DELETE FROM v_lww WHERE k LIKE 'seat%'; DELETE FROM v_rejected WHERE id = '${wrong.id}'; PRAGMA user_version = 6;`);
      raw.close();
      const upgraded = new LedgerStore(path);
      expect(upgraded.schemaVersion()).toBe(9);
      expect(seen(upgraded)).toEqual(seats);
      // A log from before seats served agents names none: its seats serve no one until you choose.
      expect(upgraded.seats().map((s) => s.serves)).toEqual([[]]);
      expect(upgraded.rejection(wrong.id)).toBe("signed in to another account than the seat's");
      expect(upgraded.digest()).toBe(digest);
      upgraded.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a replica of the version before seats served agents kept seat.serves unknown, and applies it when it's upgraded", () => {
    const dir = mkdtempSync(join(tmpdir(), "invincible-seats-"));
    try {
      const path = join(dir, "ledger.db");
      const a = newNodeIdentity();
      const store = new LedgerStore(path);
      foundFleet(store, a, { fleetName: "homelab", nodeName: "ultra" });
      const chosen = add(store, a, a);
      const plain = add(store, a, a);
      store.emit(a, "seat.serves", { id: chosen, agents: [ADA] }, YOURS);
      store.emit(a, "seat.serves", { id: chosen, agents: [ADA, BO] }, YOURS);
      const digest = store.digest();
      const seats = seen(store);
      store.close();
      // As that version left it: the kind in the log, unknown there and so applied to nothing, at schema version 7.
      const raw = new Database(path);
      raw.exec(`DELETE FROM v_lww WHERE k LIKE 'seat-serves:%'; PRAGMA user_version = 7;`);
      raw.close();
      const upgraded = new LedgerStore(path);
      expect(upgraded.schemaVersion()).toBe(9);
      expect(seen(upgraded)).toEqual(seats);
      expect(Object.fromEntries(upgraded.seats().map((s) => [s.id, s.serves]))).toEqual({ [chosen]: [ADA, BO], [plain]: [] });
      expect(upgraded.digest()).toBe(digest);
      upgraded.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
