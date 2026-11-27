import { describe, expect, test } from "bun:test";
import {
  b64u,
  clientIdentity,
  type ClientIdentity,
  encodeHlc,
  type GEvent,
  HlcClock,
  newClientSecret,
  newNodeIdentity,
  type NodeIdentity,
  signEvent,
  signWord,
  WORD_SKEW_MS,
  wordDigest,
  WORDS_SIGNED_FROM,
} from "@invincible/core";
import { enrollDevice, foundFleet, LedgerStore, revokeDevice } from "../src/index.ts";

/*
 * Slice 8a, your word signed end to end, as the log takes it: from WORDS_SIGNED_FROM (far off until 8e; these tests run
 * their clocks past it), a word of yours applies only when its prev is its companion, word.signed, carrying a statement
 * of that word signed by an active device of yours that holds the word's scope, with a nonce no applied word of that
 * device used, and a time within five minutes of the companion's. Otherwise it is kept and never applied. Before the
 * cutoff, words are kept and applied as they always were.
 */

const AFTER = WORDS_SIGNED_FROM + 86_400_000;
const RULE = { name: "quiet", rule: { after: "22:00" } };

interface World {
  store: LedgerStore;
  founder: NodeIdentity;
  fleet: string;
  phone: ClientIdentity;
  at: () => number;
  tick: (ms?: number) => number;
}

function world(start = AFTER, phoneScopes?: string[]): World {
  let now = start;
  const founder = newNodeIdentity();
  const store = new LedgerStore(":memory:", new HlcClock(() => now));
  const fleet = foundFleet(store, founder, { fleetName: "homelab", nodeName: "here" });
  const phone = clientIdentity(newClientSecret());
  now += 1_000;
  enrollDevice(store, founder, { device: phone.id, name: "phone", kind: "client", ...(phoneScopes ? { scopes: phoneScopes as never } : {}) });
  return { store, founder, fleet, phone, at: () => now, tick: (ms = 1_000) => (now += ms) };
}

let nonces = 0;
const freshNonce = () => `nonce-for-words-${String(++nonces).padStart(6, "0")}`;

/** The companion's body for a word, as a device of yours signs it (`over`: what a forger or a mistake changes). */
function signed(w: World, kind: string, body: unknown, over: { device?: ClientIdentity; nonce?: string; at?: number; fleet?: string; kindSigned?: string; bodySigned?: unknown } = {}) {
  const device = over.device ?? w.phone;
  const statement = { v: 1 as const, fleet: over.fleet ?? w.fleet, kind: over.kindSigned ?? kind, digest: wordDigest(over.bodySigned ?? body), nonce: over.nonce ?? freshNonce(), at: over.at ?? w.at() };
  return { v: 1 as const, device: device.id, nonce: statement.nonce, at: statement.at, kind: statement.kind, digest: statement.digest, sig: signWord(device, statement) };
}

/** A node's events as it writes them, chained on its own head: what reaches every replica by sync. */
function written(w: World, node: NodeIdentity, kind: string, body: unknown, prov?: GEvent["prov"]): GEvent {
  const event = signEvent({ v: 2, fleet: w.fleet, hlc: encodeHlc({ ms: w.tick(), counter: 0 }), device: node.id, prev: w.store.head(node.id), kind: kind as GEvent["kind"], body: body as never, ...(prov ? { prov } : {}) }, node);
  expect(w.store.ingest([event]).invalid).toEqual([]);
  return event;
}

/** Your word, as the node records it: its companion, then the word, back to back. */
function said(w: World, kind: string, body: unknown, prov?: GEvent["prov"], over?: Parameters<typeof signed>[3]) {
  const companion = written(w, w.founder, "word.signed", signed(w, kind, body, over));
  const word = written(w, w.founder, kind, body, prov);
  return { companion, word };
}

const rule = (w: World, name = RULE.name) => w.store.rules().find((r) => r.name === name) ?? null;

describe("before the cutoff", () => {
  test("a word applies as it always did, with no companion", () => {
    const w = world(WORDS_SIGNED_FROM - 86_400_000);
    const word = written(w, w.founder, "rule.set", RULE, { trust: "owner" });
    expect(w.store.rejection(word.id)).toBeNull();
    expect(rule(w)?.rule).toEqual(RULE.rule);
  });
});

describe("from the cutoff", () => {
  test("a word with no companion is kept and never applied", () => {
    const w = world();
    const word = written(w, w.founder, "rule.set", RULE, { trust: "owner" });
    expect(w.store.event(word.id)).not.toBeNull();
    expect(w.store.rejection(word.id)).toMatch(/companion/);
    expect(rule(w)).toBeNull();
  });

  test("a word with its companion, signed by a device of yours that may say it, applies", () => {
    const w = world();
    const { companion, word } = said(w, "rule.set", RULE, { trust: "owner", via: w.phone.id });
    expect([w.store.rejection(companion.id), w.store.rejection(word.id)]).toEqual([null, null]);
    expect(rule(w)?.rule).toEqual(RULE.rule);
    // The node's own emit writes them so too, back to back.
    const body = { name: "loud", rule: { before: "07:00" } };
    w.store.emit(w.founder, "word.signed", signed(w, "rule.set", body));
    w.store.emit(w.founder, "rule.set", body, { trust: "owner" });
    expect(rule(w, "loud")?.rule).toEqual(body.rule);
  });

  test("a companion that signs another word, or isn't the word's prev, holds nothing", () => {
    const w = world();
    const cases: [string, Parameters<typeof signed>[3]][] = [
      ["another kind", { kindSigned: "rule.removed" }],
      ["another body", { bodySigned: { name: "loud", rule: {} } }],
      ["another fleet", { fleet: "x".repeat(43) }],
    ];
    for (const [what, over] of cases) {
      const { word } = said(w, "rule.set", RULE, { trust: "owner" }, over);
      expect([what, w.store.rejection(word.id)]).toEqual([what, expect.stringMatching(/companion|signature/)]);
    }
    // A companion with something between it and the word: the word's prev is that, not the companion.
    written(w, w.founder, "word.signed", signed(w, "rule.set", RULE));
    written(w, w.founder, "memory.added", { text: "between" });
    const late = written(w, w.founder, "rule.set", RULE, { trust: "owner" });
    expect(w.store.rejection(late.id)).toMatch(/companion/);
    expect(rule(w)).toBeNull();
  });

  test("only an active device of yours holding the word's scope signs it, at the companion's time", () => {
    const w = world();
    // A device nobody enrolled.
    const stranger = clientIdentity(newClientSecret());
    expect(w.store.rejection(said(w, "rule.set", RULE, { trust: "owner" }, { device: stranger }).word.id)).toMatch(/device of yours/);
    // One without the scope: a chat app's bridge holds chat and mind:read.
    const bridge = clientIdentity(newClientSecret());
    // (The node's own clock goes past what it signed that was refused, which never moved it.)
    w.tick();
    enrollDevice(w.store, w.founder, { device: bridge.id, name: "bridge", kind: "client", scopes: ["chat", "mind:read"] });
    w.tick();
    expect(w.store.rejection(said(w, "rule.set", RULE, { trust: "owner" }, { device: bridge }).word.id)).toMatch(/device of yours/);
    // One revoked before it signed.
    const old = clientIdentity(newClientSecret());
    w.tick();
    enrollDevice(w.store, w.founder, { device: old.id, name: "old phone", kind: "client" });
    w.tick();
    revokeDevice(w.store, w.founder, old.id, "lost");
    w.tick();
    expect(w.store.rejection(said(w, "rule.set", RULE, { trust: "owner" }, { device: old }).word.id)).toMatch(/device of yours/);
    // A word whose scope the device holds applies: price.set needs brain:write, which your phone holds.
    const price = { model: "stand-in/model", price: { input: 1, output: 2 } };
    expect(w.store.rejection(said(w, "price.set", price, { trust: "owner" }).word.id)).toBeNull();
    expect(rule(w)).toBeNull();
  });

  test("its time is within five minutes of its companion's, and its nonce no applied word of that device used", () => {
    const w = world();
    expect(w.store.rejection(said(w, "rule.set", RULE, { trust: "owner" }, { at: w.at() - WORD_SKEW_MS - 2_000 }).word.id)).toMatch(/time/);
    const nonce = freshNonce();
    expect(w.store.rejection(said(w, "rule.set", RULE, { trust: "owner" }, { nonce }).word.id)).toBeNull();
    const again = { name: "quiet", rule: { after: "23:00" } };
    expect(w.store.rejection(said(w, "rule.set", again, { trust: "owner" }, { nonce }).word.id)).toMatch(/nonce/);
    expect(rule(w)?.rule).toEqual(RULE.rule);
  });

  test("a nonce is used only by a word that applies: a copied companion with no word, or with a word refused, takes none", () => {
    const w = world();
    const nonce = freshNonce();
    const companion = signed(w, "rule.set", RULE, { nonce });
    // A full node that saw your companion copies it, back-dated, alone; then another, followed by a word it can't make apply.
    written(w, w.founder, "word.signed", companion);
    written(w, w.founder, "memory.added", { text: "after the copy" });
    written(w, w.founder, "word.signed", companion);
    const refused = written(w, w.founder, "rule.set", RULE, { trust: "agent" });
    expect(w.store.rejection(refused.id)).toBe("a rule is your word alone");
    // Your word, with its own companion, still applies.
    const word = (() => {
      written(w, w.founder, "word.signed", companion);
      return written(w, w.founder, "rule.set", RULE, { trust: "owner" });
    })();
    expect(w.store.rejection(word.id)).toBeNull();
    expect(rule(w)?.rule).toEqual(RULE.rule);
  });

  test("an agent's own decision is its own word, not yours: it needs no companion", () => {
    const w = world();
    // (Refused or not for its own reasons, never for want of a companion.)
    const decided = written(w, w.founder, "action.decided", { id: `a_${"a".repeat(22)}`, verdict: "approved" }, { trust: "agent" });
    expect(w.store.rejection(decided.id) ?? "").not.toMatch(/companion/);
  });
});

describe("convergence", () => {
  test("every replica, in any order, logs and applies the same words, and a rebuild keeps it", () => {
    const w = world();
    const events: GEvent[] = [];
    const keep = (...e: GEvent[]) => events.push(...e);
    const nonce = freshNonce();
    keep(...Object.values(said(w, "rule.set", RULE, { trust: "owner" }, { nonce })));
    keep(written(w, w.founder, "rule.set", { name: "bare", rule: {} }, { trust: "owner" }));
    keep(...Object.values(said(w, "rule.set", { name: "again", rule: { x: 1 } }, { trust: "owner" }, { nonce })));
    keep(...Object.values(said(w, "rule.removed", { name: "quiet" }, { trust: "owner" })));
    keep(...Object.values(said(w, "rule.set", { name: "forged", rule: {} }, { trust: "owner" }, { bodySigned: { name: "other" } })));
    const all = w.store.eventsSince({}, 10_000).events;
    const replica = (batches: GEvent[][]) => {
      const store = new LedgerStore(":memory:", new HlcClock(() => w.at()));
      store.expectFleet(w.fleet);
      for (const batch of batches) store.ingest(batch);
      return store;
    };
    const stores = [replica([all]), replica([[...all].reverse()]), replica(all.map((e) => [e])), replica([...all].reverse().map((e) => [e])), replica([all.filter((_, i) => i % 2), all.filter((_, i) => !(i % 2))])];
    const digests = new Set([w.store.digest(), ...stores.map((s) => s.digest())]);
    expect(digests.size).toBe(1);
    for (const store of stores) expect([store.eventCount(), store.pendingCount()]).toEqual([w.store.eventCount(), 0]);
    const [digest] = digests;
    for (const store of [w.store, ...stores]) {
      store.rebuild();
      expect(store.digest()).toBe(digest!);
    }
    expect(w.store.rules().map((r) => r.name)).toEqual([]);
    expect(events.length).toBe(9);
  });
});

// The property tests' rule (any order gives the same digest, a rebuild the same state), with words: per seed, a fleet of
// two nodes and three devices of yours writes words with their companions, words with none, companions that sign another
// word or are signed by a device without the scope, words said twice with one nonce, and companions copied with no word
// or with a word refused, each node on its own chain; then seven replicas take the log in seven orders.
describe("convergence over random worlds of words", () => {
  const seeds = (() => {
    const [a, b] = (process.env.WORD_SEEDS ?? "1-24").split("-").map(Number);
    return Array.from({ length: b! - a! + 1 }, (_, i) => a! + i);
  })();
  const rng = (seed: number) => {
    let s = seed >>> 0;
    return () => {
      s = (s + 0x6d2b79f5) >>> 0;
      let t = Math.imul(s ^ (s >>> 15), s | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  };
  for (const seed of seeds) {
    test(`seed ${seed}: one log, one digest, nothing parked, in any order; a rebuild keeps it`, () => {
      const random = rng(seed);
      const pick = <T>(xs: T[]): T => xs[Math.floor(random() * xs.length)]!;
      const w = world();
      const second = newNodeIdentity();
      w.tick();
      enrollDevice(w.store, w.founder, { device: second.id, name: "second", kind: "node", box: b64u(second.boxPublic) });
      const tablet = clientIdentity(newClientSecret());
      const bridge = clientIdentity(newClientSecret());
      w.tick();
      enrollDevice(w.store, w.founder, { device: tablet.id, name: "tablet", kind: "client" });
      w.tick();
      enrollDevice(w.store, w.founder, { device: bridge.id, name: "bridge", kind: "client", scopes: ["chat", "mind:read"] });
      const devices = [w.phone, tablet, bridge];
      const used: { device: ClientIdentity; nonce: string }[] = [];
      const heads = new Map<string, string | null>();
      const write = (node: NodeIdentity, kind: string, body: unknown, prov?: GEvent["prov"], ms = w.tick(1 + Math.floor(random() * 4_000))) => {
        const event = signEvent({ v: 2, fleet: w.fleet, hlc: encodeHlc({ ms, counter: 0 }), device: node.id, prev: heads.get(node.id) ?? w.store.head(node.id), kind: kind as GEvent["kind"], body: body as never, ...(prov ? { prov } : {}) }, node);
        heads.set(node.id, event.id);
        w.store.ingest([event]);
        return event;
      };
      for (let step = 0; step < 40; step++) {
        const node = pick([w.founder, second]);
        const name = pick(["quiet", "loud", "night"]);
        const body = random() < 0.25 ? { name } : { name, rule: { n: Math.floor(random() * 5) } };
        const kind = "rule" in body ? "rule.set" : "rule.removed";
        const roll = random();
        const device = pick(devices);
        const again = used.length && random() < 0.15 ? pick(used) : null;
        const nonce = again?.nonce ?? freshNonce();
        const signer = again?.device ?? device;
        const companion = signed(w, kind, body, { device: signer, nonce, ...(roll < 0.1 ? { kindSigned: kind === "rule.set" ? "rule.removed" : "rule.set" } : roll < 0.2 ? { bodySigned: { name: "other" } } : roll < 0.25 ? { at: w.at() - WORD_SKEW_MS - 60_000 } : {}) });
        if (roll < 0.9) used.push({ device: signer, nonce });
        if (roll >= 0.9 && roll < 0.95) {
          // A word with no companion.
          write(node, kind, body, { trust: "owner" });
        } else if (roll >= 0.95) {
          // A companion copied with no word after it.
          write(node, "word.signed", companion);
          write(node, "memory.added", { text: `step ${step}` });
        } else {
          write(node, "word.signed", companion);
          write(node, kind, body, { trust: random() < 0.9 ? "owner" : "agent" });
        }
      }
      const all = w.store.eventsSince({}, 100_000).events;
      const shuffled = () => {
        const xs = [...all];
        for (let i = xs.length - 1; i > 0; i--) {
          const j = Math.floor(random() * (i + 1));
          [xs[i], xs[j]] = [xs[j]!, xs[i]!];
        }
        return xs;
      };
      const replica = (batches: GEvent[][]) => {
        const store = new LedgerStore(":memory:", new HlcClock(() => w.at()));
        store.expectFleet(w.fleet);
        for (const batch of batches) store.ingest(batch);
        return store;
      };
      const inBatches = (xs: GEvent[]) => {
        const out: GEvent[][] = [];
        for (let i = 0; i < xs.length; ) {
          const n = 1 + Math.floor(random() * 9);
          out.push(xs.slice(i, i + n));
          i += n;
        }
        return out;
      };
      const stores = [replica([all]), replica([[...all].reverse()]), replica(all.map((e) => [e])), replica([...all].reverse().map((e) => [e])), replica(inBatches(shuffled())), replica(inBatches(shuffled())), replica([shuffled()])];
      const digest = w.store.digest();
      for (const store of stores) expect([store.eventCount(), store.pendingCount(), store.digest()]).toEqual([w.store.eventCount(), 0, digest]);
      for (const store of [w.store, stores[4]!]) {
        store.rebuild();
        expect(store.digest()).toBe(digest);
      }
      // No word applied that no device of yours with its scope signed: the bridge's never did.
      const applied = all.filter((e) => e.kind.startsWith("rule.") && !w.store.rejection(e.id));
      for (const word of applied) {
        const companion = w.store.event(word.prev!);
        expect(companion?.kind).toBe("word.signed");
        expect((companion!.body as { device: string }).device).not.toBe(bridge.id);
      }
    });
  }
});
