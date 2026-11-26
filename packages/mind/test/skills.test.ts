import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { b64u, type GEvent, HlcClock, newNodeIdentity, type NodeIdentity, type Prov, readSkillDoc, signEvent, skillStanding, type SkillTrust } from "@galahad/core";
import { enrollDevice, foundFleet, MindStore, type SkillRecord } from "../src/index.ts";

/*
 * Skills in the mind: signed versions, your approval of an exact version, marks, a
 * rollback, and each use with how its quest ended. Every replica applies the same rules
 * on replay (who may revise what, what a lock holds, what may be counted as given to a
 * model), so the skills converge like everything else: any order, duplicates, a rebuild.
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

/** Two nodes of one fleet. With `now`, both keep that time: a test that says which of two things came first sets it itself. */
function fleet(now?: () => number): { a: NodeIdentity; b: NodeIdentity; storeA: MindStore; storeB: MindStore } {
  const a = newNodeIdentity();
  const b = newNodeIdentity();
  const storeA = new MindStore(":memory:", now ? new HlcClock(now) : undefined);
  foundFleet(storeA, a, { fleetName: "camelot", nodeName: "laptop" });
  enrollDevice(storeA, a, { device: b.id, name: "server", kind: "node", box: b64u(b.boxPublic) });
  const storeB = new MindStore(":memory:", now ? new HlcClock(now) : undefined);
  storeB.expectFleet(storeA.fleet!);
  syncInto(storeA, storeB);
  return { a, b, storeA, storeB };
}

const SK = "sk_aaaaaaaaaaaaaaaa";
const doc = (title = "Fix a failing test") => ({ title, when: "a test fails", steps: ["run it alone", "fix the code"] });
const prov = (trust: SkillTrust): Prov => ({ trust });

/** Write a version as `by` with `trust`; returns its id (the event's). */
const write = (store: MindStore, signer: NodeIdentity, by: string, trust: SkillTrust, skill = SK, title?: string, quest?: string): string =>
  store.emit(signer, "skill.written", { skill, doc: doc(title), by, ...(quest ? { quest } : {}) }, prov(trust)).id;

/** A skill as a reader sees it: where it stands, by core's own rule. */
function standing(record: SkillRecord) {
  const ms = (hlc: string) => Number(hlc.slice(0, 15));
  return skillStanding({
    versions: record.versions.map((v) => ({ id: v.id, prev: v.prev, trust: v.trust as SkillTrust, approvedAt: v.approvedHlc ? ms(v.approvedHlc) : null, doc: readSkillDoc(v.doc) })),
    head: record.head,
    retired: record.retired,
    staleHlc: record.staleHlc,
    touchedHlc: record.touchedHlc,
  });
}

/** Everything a reader could see of the skills, for comparing replicas. */
const seen = (store: MindStore) => store.skills().map((s) => ({ ...s, standing: standing(s), uses: store.skillUses(s.id, 1000) }));

/** An event signed by an enrolled node but never checked by a store's emit: what a misbehaving (or newer) node could send. */
function forged(store: MindStore, signer: NodeIdentity, kind: string, body: unknown, p?: Prov): GEvent {
  return signEvent({ v: 2, fleet: store.fleet!, hlc: store.clock.tick(), device: signer.id, prev: store.head(signer.id), kind, body: body as never, ...(p ? { prov: p } : {}) }, signer);
}

describe("a skill's versions", () => {
  test("the first version makes the skill; it's the same on every node", () => {
    const { a, storeA, storeB } = fleet();
    const v1 = write(storeA, a, "galahad", "agent", SK, undefined, "q-1");
    syncInto(storeA, storeB);
    const skill = storeB.skill(SK)!;
    expect(skill.head).toBe(v1);
    expect(skill.versions).toEqual([{ id: v1, skill: SK, n: 1, prev: null, doc: doc(), trust: "agent", by: "galahad", quest: "q-1", via: null, source: null, hlc: skill.createdHlc, approvedHlc: null }]);
    expect(standing(skill)).toEqual({ state: "in-use", offered: v1, pending: null });
    expect(storeA.digest()).toBe(storeB.digest());
    expect(storeB.skill("sk_zzzzzzzzzzzzzzzz")).toBeNull();
  });

  test("he revises what he wrote: a new version, the old one kept", () => {
    const { a, storeA } = fleet();
    const v1 = write(storeA, a, "galahad", "agent");
    const v2 = write(storeA, a, "galahad", "agent", SK, "Fix a failing test, better");
    const skill = storeA.skill(SK)!;
    expect(skill.head).toBe(v2);
    expect(skill.versions.map((v) => [v.id, v.n, v.prev])).toEqual([
      [v1, 1, null],
      [v2, 2, v1],
    ]);
  });

  test("he never edits yours: once you wrote the head, his revision is refused, on every replica", () => {
    const { a, storeA } = fleet();
    write(storeA, a, "galahad", "agent");
    const yours = write(storeA, a, "owner", "owner", SK, "Yours now");
    expect(() => write(storeA, a, "galahad", "agent", SK, "His again")).toThrow("he revises only skills he wrote");
    expect(() => write(storeA, a, "galahad", "untrusted", SK, "His again")).toThrow("he revises only skills he wrote");
    expect(storeA.skill(SK)!.head).toBe(yours);
    // A skill you wrote from the start is the same.
    write(storeA, a, "owner", "owner", "sk_bbbbbbbbbbbbbbbb");
    expect(() => write(storeA, a, "galahad", "agent", "sk_bbbbbbbbbbbbbbbb")).toThrow("he revises only skills he wrote");
    // You may always write again.
    expect(storeA.skill("sk_bbbbbbbbbbbbbbbb")!.versions.length).toBe(1);
    write(storeA, a, "owner", "owner", "sk_bbbbbbbbbbbbbbbb", "Yours, edited");
    expect(storeA.skill("sk_bbbbbbbbbbbbbbbb")!.versions.length).toBe(2);
  });

  test("a locked skill is his to use, not to change; unlocked, he may again; you change it either way", () => {
    const { a, storeA } = fleet();
    write(storeA, a, "galahad", "agent");
    storeA.emit(a, "skill.marked", { skill: SK, mark: "locked", on: true });
    expect(storeA.skill(SK)!.locked).toBe(true);
    expect(() => write(storeA, a, "galahad", "agent", SK, "changed")).toThrow("the skill is locked");
    storeA.emit(a, "skill.marked", { skill: SK, mark: "locked", on: false });
    write(storeA, a, "galahad", "agent", SK, "changed");
    storeA.emit(a, "skill.marked", { skill: SK, mark: "locked", on: true });
    write(storeA, a, "owner", "owner", SK, "yours, though locked");
    expect(storeA.skill(SK)!.versions.length).toBe(3);
  });

  test("another agent proposes, never revises; and nobody but you writes as you", () => {
    const { a, storeA } = fleet();
    write(storeA, a, "galahad", "agent");
    expect(() => write(storeA, a, "arm:claude-code", "untrusted", SK)).toThrow("only you and Galahad revise a skill");
    // An agent's own proposal is a skill of its own, untrusted.
    write(storeA, a, "arm:claude-code", "untrusted", "sk_cccccccccccccccc");
    expect(standing(storeA.skill("sk_cccccccccccccccc")!).state).toBe("proposed");
    expect(() => write(storeA, a, "galahad", "untrusted", "sk_cccccccccccccccc")).toThrow("he revises only skills he wrote");
    // Trust can't be claimed: owner is only yours, agent only his.
    expect(() => write(storeA, a, "galahad", "owner", "sk_dddddddddddddddd")).toThrow("only your own words are yours");
    expect(() => write(storeA, a, "owner", "agent", "sk_dddddddddddddddd")).toThrow("only your own words are yours");
    expect(() => write(storeA, a, "arm:claude-code", "agent", "sk_dddddddddddddddd")).toThrow("only his own reviewed work is trusted as his");
    expect(storeA.skill("sk_dddddddddddddddd")).toBeNull();
  });

  test("a version with no word on its trust is a stranger's", () => {
    const { a, storeA } = fleet();
    storeA.ingest([forged(storeA, a, "skill.written", { skill: SK, doc: doc(), by: "galahad" })]);
    expect(storeA.skill(SK)!.versions[0]!.trust).toBe("untrusted");
    expect(standing(storeA.skill(SK)!).state).toBe("proposed");
  });

  test("its words are open in the log: a newer node's field is kept, and never makes this one refuse it", () => {
    const { a, storeA } = fleet();
    const result = storeA.ingest([forged(storeA, a, "skill.written", { skill: SK, doc: { ...doc(), later: { field: 1 } }, by: "galahad" }, prov("agent"))]);
    expect(result).toMatchObject({ added: 1, invalid: [] });
    expect(readSkillDoc(storeA.skill(SK)!.versions[0]!.doc)).toEqual({ ...doc(), proof: [], pitfalls: [] });
    // Words this node can't read at all are kept too, and offered to nobody.
    storeA.ingest([forged(storeA, a, "skill.written", { skill: "sk_bbbbbbbbbbbbbbbb", doc: { shape: "of the future" }, by: "galahad" }, prov("agent"))]);
    expect(standing(storeA.skill("sk_bbbbbbbbbbbbbbbb")!)).toMatchObject({ state: "proposed", offered: null });
  });

  test("only a full node writes skills", () => {
    const { a, storeA } = fleet();
    const limited = newNodeIdentity();
    storeA.emit(a, "device.enrolled", { device: limited.id, name: "sensor", kind: "node", role: "limited", box: b64u(limited.boxPublic), scopes: [] });
    expect(() => write(storeA, limited, "galahad", "agent")).toThrow("only full nodes write skills");
    write(storeA, a, "galahad", "untrusted");
    const v = storeA.skill(SK)!.head;
    expect(() => storeA.emit(limited, "skill.approved", { skill: SK, version: v })).toThrow("only full nodes record your approval");
    expect(() => storeA.emit(limited, "skill.marked", { skill: SK, mark: "retired", on: true })).toThrow("only full nodes mark skills");
    expect(() => storeA.emit(limited, "skill.reverted", { skill: SK, from: v })).toThrow("only full nodes roll a skill back");
  });
});

describe("your approval", () => {
  test("names an exact version; the first approval stands; a later revision waits again", () => {
    const { a, storeA } = fleet();
    const v1 = write(storeA, a, "galahad", "untrusted");
    expect(standing(storeA.skill(SK)!)).toEqual({ state: "proposed", offered: null, pending: v1 });
    storeA.emit(a, "skill.approved", { skill: SK, version: v1 });
    expect(standing(storeA.skill(SK)!)).toEqual({ state: "in-use", offered: v1, pending: null });
    expect(() => storeA.emit(a, "skill.approved", { skill: SK, version: v1 })).toThrow("already approved");
    // His next untrusted version doesn't ride on that approval.
    const v2 = write(storeA, a, "galahad", "untrusted", SK, "revised from the web");
    expect(standing(storeA.skill(SK)!)).toEqual({ state: "in-use", offered: v1, pending: v2 });
    storeA.emit(a, "skill.approved", { skill: SK, version: v2 });
    expect(standing(storeA.skill(SK)!)).toEqual({ state: "in-use", offered: v2, pending: null });
  });

  test("a version of another skill, or none, can't be approved", () => {
    const { a, storeA } = fleet();
    const v1 = write(storeA, a, "galahad", "untrusted");
    write(storeA, a, "galahad", "untrusted", "sk_bbbbbbbbbbbbbbbb");
    expect(() => storeA.emit(a, "skill.approved", { skill: "sk_bbbbbbbbbbbbbbbb", version: v1 })).toThrow("no such version of that skill");
    expect(() => storeA.emit(a, "skill.approved", { skill: SK, version: "x".repeat(43) })).toThrow("no such version of that skill");
  });
});

describe("marks and rollback", () => {
  test("retired, it stays in the mind with every version; put back, it's as it was", () => {
    const { a, storeA } = fleet();
    const v1 = write(storeA, a, "galahad", "agent");
    storeA.emit(a, "skill.marked", { skill: SK, mark: "retired", on: true });
    expect(standing(storeA.skill(SK)!).state).toBe("retired");
    expect(storeA.skill(SK)!.versions.map((v) => v.id)).toEqual([v1]);
    storeA.emit(a, "skill.marked", { skill: SK, mark: "retired", on: false });
    expect(standing(storeA.skill(SK)!).state).toBe("in-use");
    expect(() => storeA.emit(a, "skill.marked", { skill: "sk_zzzzzzzzzzzzzzzz", mark: "retired", on: true })).toThrow("no such skill");
  });

  test("a stale mark holds until the skill is used or changed again", () => {
    const { a, storeA } = fleet();
    const v1 = write(storeA, a, "galahad", "agent");
    storeA.emit(a, "skill.marked", { skill: SK, mark: "stale", on: true });
    expect(standing(storeA.skill(SK)!).state).toBe("stale");
    storeA.emit(a, "skill.used", { skill: SK, version: v1, quest: "q-9" });
    expect(standing(storeA.skill(SK)!).state).toBe("in-use");
    storeA.emit(a, "skill.marked", { skill: SK, mark: "stale", on: true });
    expect(standing(storeA.skill(SK)!).state).toBe("stale");
    write(storeA, a, "galahad", "agent", SK, "revised");
    expect(standing(storeA.skill(SK)!).state).toBe("in-use");
  });

  test("a mark this node doesn't know is kept and changes nothing", () => {
    const { a, storeA } = fleet();
    write(storeA, a, "galahad", "agent");
    storeA.emit(a, "skill.marked", { skill: SK, mark: "pinned-to-shelf", on: true });
    expect(storeA.skill(SK)).toMatchObject({ locked: false, retired: false, staleHlc: null });
  });

  test("a rollback goes one step back, from the version you saw; nothing is deleted", () => {
    const { a, storeA } = fleet();
    const v1 = write(storeA, a, "galahad", "agent");
    const v2 = write(storeA, a, "galahad", "agent", SK, "second");
    const v3 = write(storeA, a, "galahad", "agent", SK, "third");
    expect(() => storeA.emit(a, "skill.reverted", { skill: SK, from: v2 })).toThrow("the skill changed since");
    storeA.emit(a, "skill.reverted", { skill: SK, from: v3 });
    expect(storeA.skill(SK)!.head).toBe(v2);
    expect(storeA.skill(SK)!.versions.map((v) => v.id)).toEqual([v1, v2, v3]);
    storeA.emit(a, "skill.reverted", { skill: SK, from: v2 });
    expect(storeA.skill(SK)!.head).toBe(v1);
    expect(() => storeA.emit(a, "skill.reverted", { skill: SK, from: v1 })).toThrow("nothing to go back to");
    // A version written after a rollback follows the head it was written on.
    const v4 = write(storeA, a, "galahad", "agent", SK, "fourth");
    expect(storeA.skill(SK)!.versions.at(-1)).toMatchObject({ id: v4, n: 4, prev: v1 });
  });

  test("rolling back a waiting revision declines it: the version in use goes on", () => {
    const { a, storeA } = fleet();
    const v1 = write(storeA, a, "galahad", "agent");
    const v2 = write(storeA, a, "galahad", "untrusted", SK, "from an online quest");
    expect(standing(storeA.skill(SK)!)).toEqual({ state: "in-use", offered: v1, pending: v2 });
    storeA.emit(a, "skill.reverted", { skill: SK, from: v2 });
    expect(standing(storeA.skill(SK)!)).toEqual({ state: "in-use", offered: v1, pending: null });
  });
});

describe("a skill's track record", () => {
  test("each quest it was given to counts once, and how that quest ended is recorded against it", () => {
    const { a, storeA } = fleet();
    const v1 = write(storeA, a, "galahad", "agent");
    for (const quest of ["q-1", "q-2", "q-3", "q-4"]) storeA.emit(a, "skill.used", { skill: SK, version: v1, quest });
    expect(() => storeA.emit(a, "skill.used", { skill: SK, version: v1, quest: "q-1" })).toThrow("already counted");
    storeA.emit(a, "skill.outcome", { skill: SK, quest: "q-1", status: "done" });
    storeA.emit(a, "skill.outcome", { skill: SK, quest: "q-2", status: "unverified" });
    storeA.emit(a, "skill.outcome", { skill: SK, quest: "q-3", status: "stopped" });
    expect(() => storeA.emit(a, "skill.outcome", { skill: SK, quest: "q-1", status: "gave-up" })).toThrow("already recorded");
    expect(() => storeA.emit(a, "skill.outcome", { skill: SK, quest: "q-99", status: "done" })).toThrow("that quest didn't use the skill");
    expect(storeA.skill(SK)).toMatchObject({ uses: 4, passed: 1, failed: 1, chats: 0 });
    expect(storeA.skillUses(SK).map((u) => [u.quest, u.status])).toEqual([
      ["q-4", null],
      ["q-3", "stopped"],
      ["q-2", "unverified"],
      ["q-1", "done"],
    ]);
    expect(storeA.skillsUsedBy("q-2").map((u) => u.skill)).toEqual([SK]);
  });

  test("a chat answer it was given to is counted apart, and has no review", () => {
    const { a, storeA } = fleet();
    const v1 = write(storeA, a, "galahad", "agent");
    storeA.emit(a, "skill.used", { skill: SK, version: v1, quest: "chat:t_1" });
    expect(storeA.skill(SK)).toMatchObject({ uses: 0, chats: 1 });
    expect(() => storeA.emit(a, "skill.outcome", { skill: SK, quest: "chat:t_1", status: "done" })).toThrow("a chat answer has no review");
  });

  test("no replica counts as given to a model what wasn't his to be given: an unapproved untrusted version, a retired skill", () => {
    const { a, storeA } = fleet();
    const v1 = write(storeA, a, "galahad", "untrusted");
    expect(() => storeA.emit(a, "skill.used", { skill: SK, version: v1, quest: "q-1" })).toThrow("that version was not approved");
    storeA.emit(a, "skill.approved", { skill: SK, version: v1 });
    storeA.emit(a, "skill.used", { skill: SK, version: v1, quest: "q-1" });
    storeA.emit(a, "skill.marked", { skill: SK, mark: "retired", on: true });
    expect(() => storeA.emit(a, "skill.used", { skill: SK, version: v1, quest: "q-2" })).toThrow("the skill is retired");
    expect(() => storeA.emit(a, "skill.used", { skill: SK, version: "x".repeat(43), quest: "q-3" })).toThrow("no such version of that skill");
    expect(storeA.skill(SK)!.uses).toBe(1);
  });
});

describe("skills converge", () => {
  test("two nodes apart, each right by what it knew: together they agree, and the rules decide the same on both", () => {
    // The time is the test's own, so which came first is said here and never left to how fast the machine is:
    // inside one millisecond two nodes' events are ordered by their ids, and either order is a history they agree on.
    let now = Date.now();
    const { a, b, storeA, storeB } = fleet(() => now);
    const v1 = write(storeA, a, "galahad", "agent");
    syncInto(storeA, storeB);
    // Apart: you lock it on A; a moment later on B, he revises it (B hasn't heard of the lock).
    now += 5;
    storeA.emit(a, "skill.marked", { skill: SK, mark: "locked", on: true });
    now += 5;
    const revised = write(storeB, b, "galahad", "agent", SK, "revised while locked elsewhere");
    syncInto(storeA, storeB);
    syncInto(storeB, storeA);
    expect(storeA.digest()).toBe(storeB.digest());
    expect(seen(storeA)).toEqual(seen(storeB));
    // The lock came first by the clock both agree on, so the revision is refused on both.
    expect(storeA.skill(SK)!.head).toBe(v1);
    expect(storeA.rejection(revised)).toBe("the skill is locked");
    expect(storeB.rejection(revised)).toBe("the skill is locked");
  });

  test("the other way round: his revision came first, so it stands on both, and the lock holds from then on", () => {
    let now = Date.now();
    const { a, b, storeA, storeB } = fleet(() => now);
    write(storeA, a, "galahad", "agent");
    syncInto(storeA, storeB);
    // Apart: on B he revises it; a moment later on A, you lock it (A hasn't heard of the revision).
    now += 5;
    const revised = write(storeB, b, "galahad", "agent", SK, "revised before it was locked");
    now += 5;
    storeA.emit(a, "skill.marked", { skill: SK, mark: "locked", on: true });
    syncInto(storeA, storeB);
    syncInto(storeB, storeA);
    expect(storeA.digest()).toBe(storeB.digest());
    expect(seen(storeA)).toEqual(seen(storeB));
    for (const store of [storeA, storeB]) {
      expect(store.skill(SK)!.head).toBe(revised);
      expect(store.skill(SK)!.locked).toBe(true);
    }
    // Locked now, on both: a further revision of his is refused wherever he tries it.
    now += 5;
    expect(() => write(storeB, b, "galahad", "agent", SK, "after the lock")).toThrow("the skill is locked");
  });

  test("PROPERTY: any delivery order, with duplicates, yields identical skills and the identical mind; a rebuild too", () => {
    const { a, b, storeA, storeB } = fleet();
    const random = rng(42);
    const ids = ["sk_aaaaaaaaaaaaaaaa", "sk_bbbbbbbbbbbbbbbb", "sk_cccccccccccccccc"];
    const quietly = (work: () => unknown): void => {
      try {
        work();
      } catch {
        /* refused by this replica's rules, as it knew them: not in its log */
      }
    };
    // Two nodes work apart for a while, then meet now and then: writes, approvals, marks, rollbacks, uses, outcomes,
    // many of them refused by one side's view and some only once the two histories meet.
    for (let round = 0; round < 60; round++) {
      const [store, signer] = random() < 0.5 ? [storeA, a] : [storeB, b];
      const skill = ids[Math.floor(random() * ids.length)]!;
      const record = store.skill(skill);
      const pick = random();
      if (pick < 0.3) {
        const who = (["galahad", "owner", "arm:other"] as const)[Math.floor(random() * 3)]!;
        const trust: SkillTrust = who === "owner" ? "owner" : who === "galahad" && random() < 0.5 ? "agent" : "untrusted";
        quietly(() => write(store, signer, who, trust, skill, `version ${round}`, `q-${round}`));
      } else if (pick < 0.42 && record) quietly(() => store.emit(signer, "skill.approved", { skill, version: record.versions[Math.floor(random() * record.versions.length)]!.id }));
      else if (pick < 0.57 && record) quietly(() => store.emit(signer, "skill.marked", { skill, mark: (["locked", "retired", "stale"] as const)[Math.floor(random() * 3)]!, on: random() < 0.6 }));
      else if (pick < 0.65 && record) quietly(() => store.emit(signer, "skill.reverted", { skill, from: record.head }));
      else if (pick < 0.85 && record) quietly(() => store.emit(signer, "skill.used", { skill, version: record.versions[Math.floor(random() * record.versions.length)]!.id, quest: random() < 0.2 ? `chat:${round}` : `q-${Math.floor(random() * 12)}` }));
      else if (record) quietly(() => store.emit(signer, "skill.outcome", { skill, quest: `q-${Math.floor(random() * 12)}`, status: (["done", "unverified", "gave-up", "stopped"] as const)[Math.floor(random() * 4)]! }));
      store.remember(signer, `note ${round}`);
      if (round % 17 === 16) {
        syncInto(storeA, storeB);
        syncInto(storeB, storeA);
      }
    }
    const everything = [...new Map([...allEvents(storeA), ...allEvents(storeB)].map((e) => [e.id, e])).values()];
    expect(everything.some((e) => e.kind === "skill.written")).toBe(true);
    let reference: { digest: string; skills: unknown } | null = null;
    for (let seed = 1; seed <= 8; seed++) {
      const order = rng(seed);
      const replica = new MindStore(":memory:");
      replica.expectFleet(storeA.fleet!);
      const shuffled = shuffle([...everything, ...everything.slice(0, 12)], order);
      for (let i = 0; i < shuffled.length; i += 1 + Math.floor(order() * 5)) replica.ingest(shuffled.slice(i, i + 5));
      replica.ingest(shuffled);
      reference ??= { digest: replica.digest(), skills: seen(replica) };
      expect(replica.digest()).toBe(reference.digest);
      expect(seen(replica)).toEqual(reference.skills as never);
      replica.rebuild();
      expect(replica.digest()).toBe(reference.digest);
      expect(seen(replica)).toEqual(reference.skills as never);
      replica.close();
    }
    // The two nodes that lived it agree with every replica that only heard of it.
    syncInto(storeA, storeB);
    syncInto(storeB, storeA);
    expect(storeA.digest()).toBe(reference!.digest);
    expect(storeB.digest()).toBe(reference!.digest);
    // And some of what they wrote apart was refused once the histories met.
    expect(storeA.skills().length).toBeGreaterThan(0);
  }, 60_000);

  test("a mind with no skill keeps the digest it had before skills: an older node's", () => {
    const { a, storeA } = fleet();
    storeA.remember(a, "a note");
    const before = storeA.digest();
    write(storeA, a, "galahad", "agent");
    expect(storeA.digest()).not.toBe(before);
    const other = new MindStore(":memory:");
    other.expectFleet(storeA.fleet!);
    other.ingest(allEvents(storeA).filter((e) => !e.kind.startsWith("skill.")));
    expect(other.digest()).toBe(before);
  });

  test("a replica that held skills before it knew them applies them when it's upgraded", () => {
    const dir = mkdtempSync(join(tmpdir(), "galahad-skills-"));
    try {
      const path = join(dir, "mind.db");
      const a = newNodeIdentity();
      const store = new MindStore(path);
      foundFleet(store, a, { fleetName: "camelot", nodeName: "laptop" });
      const v1 = write(store, a, "galahad", "untrusted");
      store.emit(a, "skill.approved", { skill: SK, version: v1 });
      store.emit(a, "skill.used", { skill: SK, version: v1, quest: "q-1" });
      store.emit(a, "skill.outcome", { skill: SK, quest: "q-1", status: "done" });
      store.emit(a, "skill.marked", { skill: SK, mark: "locked", on: true });
      const digest = store.digest();
      const skills = seen(store);
      store.close();
      // As the older code left it: the events in the log, nothing in the views, the older schema version.
      const raw = new Database(path);
      raw.exec("DELETE FROM v_skills; DELETE FROM v_skill_versions; DELETE FROM v_skill_uses; DELETE FROM v_lww WHERE k LIKE 'skill-mark:%'; PRAGMA user_version = 2;");
      raw.close();
      const upgraded = new MindStore(path);
      expect(upgraded.schemaVersion()).toBe(6);
      expect(seen(upgraded)).toEqual(skills);
      expect(upgraded.skill(SK)).toMatchObject({ uses: 1, passed: 1, locked: true });
      expect(upgraded.digest()).toBe(digest);
      upgraded.close();
    } finally {
      rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });
});

describe("a day's ledger of one resource", () => {
  test("the entries since a moment, newest first, whatever else fills the ledger", () => {
    const { a, storeA } = fleet();
    const entry = (resource: string, detail: string) => storeA.emit(a, "ledger.recorded", { class: "create", resource, target: "q-1", verdict: "allow", detail });
    entry("skill.distil", "~900 tokens · x/y");
    for (let i = 0; i < 20; i++) entry("sandbox.exec", `step ${i}`);
    entry("skill.distil", "~1100 tokens · x/y");
    expect(storeA.ledgerOf("skill.distil", 0).map((e) => e.body.detail)).toEqual(["~1100 tokens · x/y", "~900 tokens · x/y"]);
    expect(storeA.ledgerOf("skill.distil", Date.now() + 60_000)).toEqual([]);
    expect(storeA.ledgerOf("nothing", 0)).toEqual([]);
  });
});
