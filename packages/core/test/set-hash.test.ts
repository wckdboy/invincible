import { describe, expect, test } from "bun:test";
import { chacha20 } from "@noble/ciphers/chacha.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { SET_HASH_BYTES, SetHash } from "../src/index.ts";

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

const shuffle = <T>(items: T[], random: () => number): T[] => {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
};

describe("the set hash sync compares device logs with", () => {
  test("its bytes are pinned: replicas on any version and platform compute the same digest", () => {
    // Changing these would make every node in a mixed fleet see every other one as holed.
    expect(SetHash.empty().digest()).toBe("5aAKqZkayKXuMQmETYSlVYO9IFcq0__NQnkvPDaxg60");
    expect(SetHash.of(["a", "b"]).digest()).toBe("GwYhugaHfLbpH4y8Yk48stgMcEMeUnjdUYRSOYCQTLs");
    expect(SetHash.of(["8SpuaToTVJa71zgvba41gtk83EkAB8nIV4TUfLJurdo"]).digest()).toBe("UCzbBZegwvGnN1D1NKFpWq-aqtalDgc8EaodLGqeYjg");
    expect(SetHash.empty().bytes().length).toBe(SET_HASH_BYTES);
  });

  test("PROPERTY: the order elements are added in never matters", () => {
    const random = rng(11);
    const ids = Array.from({ length: 300 }, (_, i) => `event-${i}-${Math.floor(random() * 1e9)}`);
    const reference = SetHash.of(ids).digest();
    for (let round = 0; round < 20; round++) expect(SetHash.of(shuffle(ids, random)).digest()).toBe(reference);
  });

  test("removing undoes adding, even through wrap-around, so a subset's hash comes from the whole one", () => {
    const random = rng(5);
    const ids = Array.from({ length: 200 }, (_, i) => `id${i}`);
    const whole = SetHash.of(ids);
    for (let round = 0; round < 10; round++) {
      const keep = ids.filter(() => random() < 0.6);
      const dropped = ids.filter((id) => !keep.includes(id));
      const derived = SetHash.from(whole.bytes());
      for (const id of dropped) derived.remove(id);
      expect(derived.digest()).toBe(SetHash.of(keep).digest());
    }
    expect(SetHash.of(["x"]).remove("x").digest()).toBe(SetHash.empty().digest());
  });

  test("different sets get different hashes: a missing, extra or swapped element shows", () => {
    const ids = Array.from({ length: 50 }, (_, i) => `id${i}`);
    const reference = SetHash.of(ids).digest();
    expect(SetHash.of(ids.slice(1)).digest()).not.toBe(reference);
    expect(SetHash.of([...ids, "id50"]).digest()).not.toBe(reference);
    expect(SetHash.of([...ids.slice(1), "id50"]).digest()).not.toBe(reference);
    // A multiset: the same element twice is not the same as once.
    expect(SetHash.of([...ids, "id0"]).digest()).not.toBe(reference);
  });

  test("the lanes are exactly the documented sum: little-endian ChaCha20 lanes keyed by SHA-256, mod 2^16", () => {
    const elements = ["a", "b", "event-3", "a"];
    const expected = new Uint8Array(2048);
    for (const element of elements) {
      const lanes = chacha20(sha256(new TextEncoder().encode(element)), new TextEncoder().encode("galahad/set1"), new Uint8Array(2048));
      for (let i = 0; i < 2048; i += 2) {
        const sum = (expected[i]! | (expected[i + 1]! << 8)) + (lanes[i]! | (lanes[i + 1]! << 8));
        expected[i] = sum & 0xff;
        expected[i + 1] = (sum >> 8) & 0xff;
      }
    }
    expect(SetHash.of(elements).bytes()).toEqual(expected);
  });

  test("stored bytes are copied, never changed in place, and must be the right size", () => {
    const stored = SetHash.of(["a"]).bytes();
    const before = Uint8Array.from(stored);
    SetHash.from(stored).add("b");
    expect(stored).toEqual(before);
    expect(() => SetHash.from(new Uint8Array(16))).toThrow(/2048 bytes/);
  });
});
