import { describe, expect, test } from "bun:test";
import {
  b64u,
  canonical,
  clientIdentity,
  domain,
  isWord,
  newClientSecret,
  newNodeIdentity,
  parseEvent,
  sha256B64u,
  signEvent,
  signWord,
  verifyWordSignature,
  WORD_DOMAIN,
  WORD_SCOPES,
  WORD_SKEW_MS,
  wordDigest,
  wordSigningInput,
  WORDS_SIGNED_FROM,
  type WordStatement,
} from "../src/index.ts";

/*
 * Slice 8a, your word signed end to end (the design note of 27 November 2026, approved): the statement a device of yours
 * signs for each word of yours, its domain, and its verify; which events are words, and the scope each needs; and the
 * companion that carries the signature, word.signed, as the log takes it.
 */

// A fleet is named by its genesis event's id.
const fleet = "w".repeat(43);
const statement = (over: Partial<WordStatement> = {}): WordStatement => ({ v: 1, fleet, kind: "rule.set", digest: wordDigest({ name: "quiet", rule: { after: "22:00" } }), nonce: "nonce-for-words1", at: 1_797_206_400_000, ...over });

describe("the statement your device signs", () => {
  test("is the domain and the canonical statement, nothing else", () => {
    const s = statement();
    expect(WORD_DOMAIN).toBe("invincible-word/v1");
    expect(new TextDecoder().decode(wordSigningInput(s))).toBe(`invincible-word/v1\n${canonical({ v: 1, fleet, kind: s.kind, digest: s.digest, nonce: s.nonce, at: s.at })}`);
    expect(wordSigningInput(s)).toEqual(domain(WORD_DOMAIN, canonical(s)));
    // A field the statement doesn't have is never signed: only the six are.
    expect(wordSigningInput({ ...s, extra: "x" } as WordStatement)).toEqual(wordSigningInput(s));
  });

  test("digests the word's body as canonical JSON, whatever order its keys come in", () => {
    expect(wordDigest({ b: 2, a: [1, { d: 4, c: 3 }] })).toBe(sha256B64u('{"a":[1,{"c":3,"d":4}],"b":2}'));
    expect(wordDigest({ a: 1, b: 2 })).toBe(wordDigest({ b: 2, a: 1 }));
    expect(wordDigest({ a: 1 })).not.toBe(wordDigest({ a: 2 }));
  });

  test("holds only by the device it names, for that fleet, kind, body, nonce and time", () => {
    const you = clientIdentity(newClientSecret());
    const other = clientIdentity(newClientSecret());
    const s = statement();
    const sig = signWord(you, s);
    expect(sig).toMatch(/^[A-Za-z0-9_-]{86}$/);
    expect(verifyWordSignature(you.id, sig, s)).toBe(true);
    expect(verifyWordSignature(other.id, sig, s)).toBe(false);
    for (const changed of [{ fleet: "x".repeat(43) }, { kind: "rule.removed" }, { digest: wordDigest({ name: "loud" }) }, { nonce: "nonce-for-words2" }, { at: s.at + 1 }]) {
      expect(verifyWordSignature(you.id, sig, statement(changed))).toBe(false);
    }
    // A node's key never signs a word, nor does a signature that isn't one.
    const node = newNodeIdentity();
    expect(verifyWordSignature(node.id, b64u(node.sign(wordSigningInput(s))), s)).toBe(false);
    expect(verifyWordSignature(you.id, "not a signature", s)).toBe(false);
    expect(verifyWordSignature("c_short", sig, s)).toBe(false);
  });
});

describe("which events are your words", () => {
  test("your decisions, standing words, settings and grants, each with the scope its route asks", () => {
    expect(WORD_SCOPES).toEqual({
      "action.decided": "fleet:admin",
      "order.set": "fleet:admin",
      "order.revoked": "fleet:admin",
      "rule.set": "fleet:admin",
      "rule.removed": "fleet:admin",
      "seat.added": "fleet:admin",
      "seat.policy": "fleet:admin",
      "seat.serves": "fleet:admin",
      "seat.removed": "fleet:admin",
      "screen.decided": "fleet:admin",
      "skill.written": "mind:write",
      "skill.approved": "fleet:admin",
      "skill.marked": "fleet:admin",
      "skill.reverted": "fleet:admin",
      "handoff.granted": "fleet:admin",
      "handoff.revoked": "fleet:admin",
      "price.set": "brain:write",
      "compute.limit": "fleet:admin",
      "project.set": "brain:write",
    });
    expect(isWord({ kind: "rule.set", body: {} })).toBe(true);
    // A decision is yours only when it says so: your agent's own is its own word, not yours.
    expect(isWord({ kind: "action.decided", body: {}, prov: { trust: "owner" } })).toBe(true);
    expect(isWord({ kind: "action.decided", body: {}, prov: { trust: "agent" } })).toBe(false);
    expect(isWord({ kind: "action.decided", body: {} })).toBe(false);
    // So is a skill's text: an agent's, or one learned from a run, is not your word.
    expect(isWord({ kind: "skill.written", body: { by: "owner" } })).toBe(true);
    expect(isWord({ kind: "skill.written", body: { by: "engineer" } })).toBe(false);
    // Enrollment, revocation and scoping become words with the root of trust (8d); a ledger line never is.
    for (const kind of ["device.enrolled", "device.revoked", "device.scoped", "ledger.recorded", "memory.added", "word.signed"]) expect(isWord({ kind, body: {} })).toBe(false);
  });

  test("the cutoff is far off until every node and app signs (8e), and a statement's time is held to five minutes", () => {
    expect(WORDS_SIGNED_FROM).toBeGreaterThan(Date.UTC(2099, 0, 1));
    expect(WORD_SKEW_MS).toBe(5 * 60_000);
  });
});

describe("the companion, word.signed", () => {
  test("is a known kind with a strict body, signed into the log by the node that recorded your word", () => {
    const node = newNodeIdentity();
    const you = clientIdentity(newClientSecret());
    const s = statement();
    const body = { v: 1, device: you.id, nonce: s.nonce, at: s.at, kind: s.kind, digest: s.digest, sig: signWord(you, s) };
    const companion = signEvent({ v: 2, fleet, hlc: "001797206400000.000000", device: node.id, prev: null, kind: "word.signed", body }, node);
    expect(parseEvent(JSON.parse(JSON.stringify(companion))).body).toEqual(body);
    for (const bad of [{ ...body, v: 2 }, { ...body, device: node.id }, { ...body, nonce: "short" }, { ...body, at: -1 }, { ...body, digest: "x" }, { ...body, sig: "x" }, { ...body, extra: 1 }]) {
      const event = signEvent({ v: 2, fleet, hlc: "001797206400000.000000", device: node.id, prev: null, kind: "word.signed", body: bad as typeof body }, node);
      expect(() => parseEvent(JSON.parse(JSON.stringify(event)))).toThrow();
    }
  });
});
