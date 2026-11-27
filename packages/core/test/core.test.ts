import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  AUTH,
  aeadOpen,
  aeadSeal,
  b64u,
  canonical,
  concat,
  ClockSkewError,
  clientIdFromKey,
  decodeInvite,
  encodeInvite,
  fromB64u,
  HlcClock,
  isHlc,
  newInvite,
  newNodeIdentity,
  openSealed,
  pairProof,
  PairRequestFields,
  parseEvent,
  proofMatches,
  randomBytes,
  sasCode,
  sealTo,
  signEvent,
  signRequest,
  utf8,
  verifyRequestSignature,
  NonceCache,
  judgeNodeProof,
  nodeChallenge,
  NODE_CHALLENGE,
  nodeProofInput,
  REQUESTS_NAME_THEIR_NODE_FROM,
  SIGNATURES_STRICT_FROM,
  encodeHlc,
  eventId,
  verifyNodeProof,
  isStrictNodeId,
  strictEd25519Point,
  verifyEd25519,
  verifyEd25519Strict,
} from "../src/index.ts";
import { ed25519 } from "@noble/curves/ed25519.js";
import { sha512 } from "@noble/hashes/sha2.js";

describe("canonical json", () => {
  test("is independent of key order and drops undefined", () => {
    expect(canonical({ b: 1, a: [true, null, "x"], c: undefined })).toBe(canonical({ a: [true, null, "x"], b: 1 }));
    expect(canonical({ z: { y: 2, x: 1 } })).toBe('{"z":{"x":1,"y":2}}');
  });
  test("rejects non-finite numbers", () => {
    expect(() => canonical({ n: Number.NaN })).toThrow();
  });
});

describe("base64url", () => {
  test("round-trips arbitrary bytes", () => {
    for (let n = 0; n < 70; n++) {
      const bytes = randomBytes(n);
      expect(fromB64u(b64u(bytes))).toEqual(bytes);
    }
  });
  test("rejects garbage", () => {
    expect(() => fromB64u("not base64!")).toThrow();
  });
});

describe("hybrid logical clock", () => {
  test("is strictly monotonic even when wall time stalls or goes backwards", () => {
    let wall = 1_000;
    const clock = new HlcClock(() => wall);
    const a = clock.tick();
    wall = 500;
    const b = clock.tick();
    const c = clock.tick();
    expect(a < b && b < c).toBe(true);
  });
  test("orders after observed remote timestamps", () => {
    const clock = new HlcClock(() => 1_000);
    const remote = new HlcClock(() => 5_000).tick();
    clock.observe(remote);
    expect(clock.tick() > remote).toBe(true);
  });
  test("a maxed-out observed counter carries into milliseconds instead of wedging writes (review #3)", () => {
    const clock = new HlcClock(() => 1_000);
    clock.observe("000000000001000.999999");
    const next = clock.tick();
    expect(next).toBe("000000000001001.000000");
    expect(isHlc(next)).toBe(true);
  });

  test("refuses far-future timestamps", () => {
    const clock = new HlcClock(() => 1_000);
    const future = new HlcClock(() => 1_000 + 60 * 60_000).tick();
    expect(() => clock.observe(future)).toThrow(ClockSkewError);
  });
});

describe("sealing", () => {
  test("aead detects tampering and wrong aad", () => {
    const key = randomBytes(32);
    const box = aeadSeal(key, utf8("sk-ant-secret"), "ctx");
    expect(new TextDecoder().decode(aeadOpen(key, box, "ctx"))).toBe("sk-ant-secret");
    expect(() => aeadOpen(key, box, "other-ctx")).toThrow();
    const flipped = fromB64u(box.ct);
    flipped[0]! ^= 1;
    expect(() => aeadOpen(key, { ...box, ct: b64u(flipped) }, "ctx")).toThrow();
  });
  test("sealed boxes open only for the recipient and context", () => {
    const alice = newNodeIdentity();
    const mallory = newNodeIdentity();
    const box = sealTo(alice.boxPublic, utf8("vault key"), "grant|f|k|alice");
    expect(new TextDecoder().decode(openSealed(alice.boxSecret, box, "grant|f|k|alice"))).toBe("vault key");
    expect(() => openSealed(mallory.boxSecret, box, "grant|f|k|alice")).toThrow();
    expect(() => openSealed(alice.boxSecret, box, "grant|f|k|bob")).toThrow();
  });
  test("a box opens only under the label it was sealed under: Invincible's own, unless another is named", () => {
    const alice = newNodeIdentity();
    const box = sealTo(alice.boxPublic, utf8("vault key"), "grant|f|k|alice");
    expect(new TextDecoder().decode(openSealed(alice.boxSecret, box, "grant|f|k|alice", "invincible/seal/v1"))).toBe("vault key");
    expect(() => openSealed(alice.boxSecret, box, "grant|f|k|alice", "elsewhere/seal/v1")).toThrow();
  });
});

describe("events", () => {
  const node = newNodeIdentity();
  const unsigned = {
    v: 1 as const,
    fleet: "",
    hlc: new HlcClock().tick(),
    device: node.id,
    kind: "fleet.genesis",
    body: { name: "test", created: 1 },
  };

  test("signed events verify and are content-addressed", () => {
    const event = signEvent(unsigned, node);
    expect(parseEvent(JSON.parse(JSON.stringify(event))).id).toBe(event.id);
    expect(signEvent(unsigned, node).id).toBe(event.id);
  });
  test("any modification is rejected", () => {
    const event = signEvent(unsigned, node);
    expect(() => parseEvent({ ...event, body: { name: "evil", created: 1 } })).toThrow();
    expect(() => parseEvent({ ...event, hlc: new HlcClock(() => 9e12).tick() })).toThrow();
    const other = newNodeIdentity();
    expect(() => parseEvent({ ...event, device: other.id })).toThrow();
  });
  test("bodies of known kinds are schema-checked", () => {
    const bad = signEvent({ ...unsigned, body: { name: "x", created: 1, extra: true } }, node);
    expect(() => parseEvent(bad)).toThrow();
  });
  test("unknown kinds are stored for forward compatibility", () => {
    const future = signEvent({ ...unsigned, fleet: b64u(randomBytes(32)), kind: "run.started", body: { any: "thing" } }, node);
    expect(parseEvent(future).kind).toBe("run.started");
  });
});

describe("request signing", () => {
  test("node requests verify; tampering, skew and replay are caught", async () => {
    const node = newNodeIdentity();
    const body = utf8('{"have":{}}');
    const headers = new Headers(await signRequest(node.id, node.sign, "POST", "/link/sync", body, 10_000));
    expect(verifyRequestSignature(headers, "POST", "/link/sync", body, 10_000)?.device).toBe(node.id);
    expect(verifyRequestSignature(headers, "POST", "/link/push", body, 10_000)).toBeNull();
    expect(verifyRequestSignature(headers, "POST", "/link/sync", utf8("{}"), 10_000)).toBeNull();
    expect(verifyRequestSignature(headers, "POST", "/link/sync", body, 10_000 + 120_000)).toBeNull();
    const nonces = new NonceCache(10_000);
    const proof = verifyRequestSignature(headers, "POST", "/link/sync", body, 10_000)!;
    expect(nonces.claim(proof.device, proof.nonce, 10_000, proof.ts)).toBe(true);
    expect(nonces.claim(proof.device, proof.nonce, 10_001, proof.ts)).toBe(false);
  });

  // The slice 8 note's item 11 (the lead's word of 27 November): a request names the node it is for in what it signs, so
  // a node that was sent one for another refuses it. One that names none (v1) is taken until 14 December 2026, then not,
  // but for whoami's, which a device asks to learn which node it speaks to.
  test("a request names the node it is for: taken there, refused at any other, and one naming none taken only before the cutoff", async () => {
    const client = newNodeIdentity(); // (any device's key signs alike: a node's here)
    const [a, b] = [newNodeIdentity().id, newNodeIdentity().id];
    const body = utf8('{"q":"units"}');
    const at = REQUESTS_NAME_THEIR_NODE_FROM - 60_000;
    const forA = new Headers(await signRequest(client.id, client.sign, "POST", "/api/memories/search", body, at, a));
    expect(verifyRequestSignature(forA, "POST", "/api/memories/search", body, at, a)).toEqual({ device: client.id, nonce: forA.get(AUTH.nonce)!, ts: at, named: true });
    expect(verifyRequestSignature(forA, "POST", "/api/memories/search", body, at, b)).toBeNull();
    // (Read as one that names no node, it isn't one either: its domain is another.)
    expect(verifyRequestSignature(forA, "POST", "/api/memories/search", body, at)).toBeNull();
    const old = new Headers(await signRequest(client.id, client.sign, "POST", "/api/memories/search", body, at));
    expect(verifyRequestSignature(old, "POST", "/api/memories/search", body, at, a)?.named).toBe(false);
    const after = REQUESTS_NAME_THEIR_NODE_FROM + 1;
    const late = new Headers(await signRequest(client.id, client.sign, "POST", "/api/memories/search", body, after));
    expect(verifyRequestSignature(late, "POST", "/api/memories/search", body, after, a)).toBeNull();
    // Whoami's is taken all the same (its caller says so): a device learns from it which node it speaks to.
    expect(verifyRequestSignature(late, "POST", "/api/memories/search", body, after, a, true)?.named).toBe(false);
    const named = new Headers(await signRequest(client.id, client.sign, "POST", "/api/memories/search", body, after, a));
    expect(verifyRequestSignature(named, "POST", "/api/memories/search", body, after, a)?.named).toBe(true);
  });

  test("a node proves its id to a device that asks: its signature of the device's challenge, under its own domain", () => {
    const node = newNodeIdentity();
    const challenge = "c2xpY2UtOC1jaGFsbGVuZ2U";
    const proof = b64u(node.sign(nodeProofInput(challenge)));
    expect(verifyNodeProof(node.id, challenge, proof)).toBe(true);
    expect(verifyNodeProof(newNodeIdentity().id, challenge, proof)).toBe(false);
    expect(verifyNodeProof(node.id, "c2xpY2UtOC1jaGFsbGVuZ2X", proof)).toBe(false);
    // Under its own domain: an event's or a request's signature by that key is no proof.
    expect(verifyNodeProof(node.id, challenge, b64u(node.sign(utf8(`invincible-event/v1\n${challenge}`))))).toBe(false);
    // A challenge as a device poses one, and a client's id never proves to be a node.
    expect(verifyNodeProof(node.id, "short", b64u(node.sign(nodeProofInput("short"))))).toBe(false);
    expect(verifyNodeProof(`c_${"A".repeat(87)}`, challenge, proof)).toBe(false);
  });

  // The lead's word of 27 November 2026: a node's key, and a signature's R, are held to the strict rule.
  test("whoami's proof is held to Ed25519's strict rule: a node id that is a small-order point proves nothing, though it would verify anything", () => {
    const identityPoint = new Uint8Array(32);
    identityPoint[0] = 1;
    const weak = `n_${b64u(identityPoint)}`;
    const challenge = nodeChallenge();
    // R the identity, S zero: under ZIP-215's rules this verifies for any message by the identity's key.
    const forgery = new Uint8Array(64);
    forgery.set(identityPoint, 0);
    expect(verifyEd25519(forgery, nodeProofInput(challenge), identityPoint)).toBe(true);
    expect(isStrictNodeId(weak)).toBe(false);
    expect(verifyNodeProof(weak, challenge, b64u(forgery))).toBe(false);
    expect(judgeNodeProof(undefined, { node: weak, proof: b64u(forgery) }, challenge)).toEqual({ kind: "false" });
    // A real node's proof still holds.
    const node = newNodeIdentity();
    expect(isStrictNodeId(node.id)).toBe(true);
    expect(verifyNodeProof(node.id, challenge, b64u(node.sign(nodeProofInput(challenge))))).toBe(true);
  });

  test("a device judges whoami's proof against the node it pinned: the first it pins, the same it keeps, another and a failed one it refuses", () => {
    const [node, other] = [newNodeIdentity(), newNodeIdentity()];
    const challenge = nodeChallenge();
    expect(NODE_CHALLENGE.test(challenge)).toBe(true);
    const said = (who: typeof node) => ({ node: who.id, proof: b64u(who.sign(nodeProofInput(challenge))) });
    expect(judgeNodeProof(undefined, said(node), challenge)).toEqual({ kind: "pin", node: node.id });
    expect(judgeNodeProof(node.id, said(node), challenge)).toEqual({ kind: "same", node: node.id });
    expect(judgeNodeProof(node.id, said(other), challenge)).toEqual({ kind: "other", node: other.id });
    // One that names a node its proof isn't by, or answers another challenge: never taken.
    expect(judgeNodeProof(node.id, { node: other.id, proof: said(node).proof }, challenge)).toEqual({ kind: "false" });
    expect(judgeNodeProof(undefined, said(node), nodeChallenge())).toEqual({ kind: "false" });
    // A node from before, which offers no proof: spoken to as before.
    expect(judgeNodeProof(undefined, { node: node.id }, challenge)).toEqual({ kind: "older" });
  });

  // The review of apps-name-node, L7 and I1: once a node is pinned, an answer that gives no proof is no node from before
  // but one that won't prove which it is, so it is a proof that fails; and an answer that isn't one never is taken.
  test("once a node is pinned, a whoami with no proof is a proof that fails, as one whose proof isn't one is, pinned or not", () => {
    const node = newNodeIdentity();
    const challenge = nodeChallenge();
    const proof = b64u(node.sign(nodeProofInput(challenge)));
    expect(judgeNodeProof(node.id, { node: node.id }, challenge)).toEqual({ kind: "false" });
    expect(judgeNodeProof(node.id, {}, challenge)).toEqual({ kind: "false" });
    for (const pinned of [undefined, node.id]) {
      expect(judgeNodeProof(pinned, { node: node.id, proof: null }, challenge)).toEqual({ kind: "false" });
      expect(judgeNodeProof(pinned, { node: node.id, proof: 5 }, challenge)).toEqual({ kind: "false" });
      expect(judgeNodeProof(pinned, { proof }, challenge)).toEqual({ kind: "false" });
      expect(judgeNodeProof(pinned, { node: 7, proof }, challenge)).toEqual({ kind: "false" });
    }
    // Unpinned, no proof is a node from before still; and a proof that holds is taken either way.
    expect(judgeNodeProof(undefined, {}, challenge)).toEqual({ kind: "older" });
    expect(judgeNodeProof(node.id, { node: node.id, proof }, challenge)).toEqual({ kind: "same", node: node.id });
  });

  // The slice 8 note's item 11 (the lead's word of 27 November): a node that restarts forgets the nonces it saw, so a
  // request signed before it began is refused, however fresh its nonce looks to it.
  test("a request signed before the node began is refused: what it saw before is forgotten", () => {
    const nonces = new NonceCache(20_000);
    expect(nonces.claim("c_x", "n1", 20_010, 19_999)).toBe(false);
    expect(nonces.claim("c_x", "n2", 20_010, 20_000)).toBe(true);
    expect(nonces.claim("c_x", "n2", 20_011, 20_000)).toBe(false);
  });

  test("a signature counts only as its bytes encode: one written another way (its last character's unused bits set) is refused", async () => {
    // An Ed25519 signature is 64 bytes, 86 base64url characters, of which the last carries 2 bits and 4 unused: changed
    // only in those, it decodes to the same bytes, so the same request would have had more than one form (the fabric's
    // fuzzing found one taken as "changed").
    const node = newNodeIdentity();
    const body = utf8('{"have":{}}');
    const signed = await signRequest(node.id, node.sign, "POST", "/link/sync", body, 10_000);
    const sig = signed[AUTH.sig]!;
    const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    const last = alphabet.indexOf(sig.at(-1)!);
    const otherwise = `${sig.slice(0, -1)}${alphabet[last ^ 1]}`;
    expect(fromB64u(otherwise)).toEqual(fromB64u(sig));
    expect(verifyRequestSignature(new Headers({ ...signed, [AUTH.sig]: otherwise }), "POST", "/link/sync", body, 10_000)).toBeNull();
    expect(verifyRequestSignature(new Headers(signed), "POST", "/link/sync", body, 10_000)?.device).toBe(node.id);
  });

  test("browser WebCrypto P-256 signatures verify (the PWA path)", async () => {
    const pair = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, [
      "sign",
      "verify",
    ])) as CryptoKeyPair;
    const raw = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey));
    const device = clientIdFromKey(raw);
    const signer = async (message: Uint8Array<ArrayBuffer>) =>
      new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, pair.privateKey, message));
    const body = utf8("{}");
    // Many signatures so that high-S signatures (which WebCrypto emits ~50% of the time) are covered.
    for (let i = 0; i < 16; i++) {
      const headers = new Headers(await signRequest(device, signer, "GET", "/api/fleet", body, 5_000));
      expect(verifyRequestSignature(headers, "GET", "/api/fleet", body, 5_000)?.device).toBe(device);
    }
  });
});

describe("pairing", () => {
  test("invites round-trip, also from a #pair= URL", () => {
    const { invite } = newInvite("http://100.64.0.1:7400", b64u(randomBytes(32)), "client");
    const text = encodeInvite(invite);
    expect(decodeInvite(text)).toEqual(invite);
    expect(decodeInvite(`https://laptop.tail.ts.net/#pair=${text}`)).toEqual(invite);
  });
  test("proof binds the device key; SAS differs per device", () => {
    const fleet = b64u(randomBytes(32));
    const { invite, secret } = newInvite("http://100.64.0.1:7400", fleet, "node");
    const a = newNodeIdentity();
    const b = newNodeIdentity();
    const fields = { invite: invite.i, device: a.id, name: "server", kind: "node" as const };
    const proof = pairProof(secret, fields);
    expect(proofMatches(proof, pairProof(secret, fields))).toBe(true);
    expect(proofMatches(proof, pairProof(secret, { ...fields, device: b.id }))).toBe(false);
    expect(proofMatches(proof, pairProof(randomBytes(32), fields))).toBe(false);
    expect(sasCode(secret, fleet, a.id)).toMatch(/^\d{3} \d{3}$/);
    expect(sasCode(secret, fleet, a.id)).not.toBe(sasCode(secret, fleet, b.id));
  });
  test("a device's name carries no control characters: a terminal would act on them when it's shown", () => {
    const fields = { invite: b64u(randomBytes(32)), device: newNodeIdentity().id, kind: "node" as const };
    for (const name of ["server", "Pixel 9 Pro", "Kontor-PC", "Ærø's Mac", "📱 phone"]) expect(PairRequestFields.safeParse({ ...fields, name }).success).toBe(true);
    for (const name of ["evil\x1b]0;owned\x07", "two\nlines", "back\rspace", "nul\x00", "del\x7f", "c1\x9b31m", "flip\u202Egnp.exe", "iso\u2066late"]) {
      expect(PairRequestFields.safeParse({ ...fields, name }).success).toBe(false);
    }
  });
});

// The lead's word of 27 November 2026: one strict rule for a node's Ed25519 signature, in core, Swift and Kotlin.
describe("Ed25519's strict rule", () => {
  const hex = (h: string) => Uint8Array.from(h.match(/../g) ?? [], (b) => parseInt(b, 16));
  // The eight points of small order, as they are written canonically (libsodium's blocklist): the identity, and those of
  // order 2, 4 and 8.
  const SMALL = [
    "0100000000000000000000000000000000000000000000000000000000000000",
    "ecffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f",
    "0000000000000000000000000000000000000000000000000000000000000000",
    "0000000000000000000000000000000000000000000000000000000000000080",
    "c7176a703d4dd84fba3c0b760d10670f2a2053fa2c39ccc64ec7fd7792ac037a",
    "c7176a703d4dd84fba3c0b760d10670f2a2053fa2c39ccc64ec7fd7792ac03fa",
    "26e8958fc2b227b045c3f489f2ef98f0d5dfac05d3c63339b13802886d53fc05",
    "26e8958fc2b227b045c3f489f2ef98f0d5dfac05d3c63339b13802886d53fc85",
  ].map(hex);
  // Points written another way: y = p + 1 (the identity's y, unreduced), y = 1 with x's sign bit set (Wycheproof's
  // tc151), and y = p (zero's, unreduced).
  const NONCANONICAL = ["eeffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f", "0100000000000000000000000000000000000000000000000000000000000080", "edffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f"].map(hex);
  const node = newNodeIdentity();
  const key = fromB64u(node.id.slice(2));
  const message = utf8("a node signs this");

  test("a key, or a signature's R, is a canonical point of the prime-order subgroup and never the identity", () => {
    expect(strictEd25519Point(key)).toBe(true);
    for (const point of SMALL) expect(strictEd25519Point(point)).toBe(false);
    for (const point of NONCANONICAL) expect(strictEd25519Point(point)).toBe(false);
    // A mixed-order key: a real one with a point of order 8 added. It is a point, but outside the prime-order subgroup.
    const mixed = ed25519.Point.fromBytes(key, false).add(ed25519.Point.fromBytes(SMALL[4]!, false)).toBytes();
    expect(strictEd25519Point(mixed)).toBe(false);
    expect(strictEd25519Point(key.subarray(0, 31))).toBe(false);
  });

  // The published vectors themselves (apps/apple/InvincibleTests/Fixtures, as NOTICE says): RFC 8032's and Wycheproof's.
  test("it takes every one of RFC 8032's test vectors and Wycheproof's valid ones, and refuses every other: its invalid ones, and the small-order and mixed-order keys it calls acceptable", () => {
    const fixtures = join(import.meta.dir, "../../../apps/apple/InvincibleTests/Fixtures");
    const rfc = JSON.parse(readFileSync(join(fixtures, "rfc8032-ed25519.json"), "utf8")) as { publicKey: string; message: string; signature: string }[];
    expect(rfc).toHaveLength(5);
    for (const t of rfc) expect(verifyEd25519Strict(hex(t.signature), hex(t.message), hex(t.publicKey))).toBe(true);
    const wycheproof = JSON.parse(readFileSync(join(fixtures, "wycheproof-ed25519.json"), "utf8")) as { testGroups: { publicKey: { pk: string }; tests: { tcId: number; msg: string; sig: string; result: string }[] }[] };
    const taken: Record<string, number> = {};
    let n = 0;
    for (const group of wycheproof.testGroups) {
      for (const t of group.tests) {
        n++;
        const valid = verifyEd25519Strict(hex(t.sig), hex(t.msg), hex(group.publicKey.pk));
        expect([t.tcId, valid]).toEqual([t.tcId, t.result === "valid"]);
        if (valid) taken[t.result] = (taken[t.result] ?? 0) + 1;
      }
    }
    expect([n, taken]).toEqual([210, { valid: 117 }]);
  });

  test("a signature holds under it only by a strict key, with a strict R and S < L, and over its own message", () => {
    const signature = node.sign(message);
    expect(verifyEd25519Strict(signature, message, key)).toBe(true);
    expect(verifyEd25519Strict(signature, utf8("another message"), key)).toBe(false);
    // S + L is the same scalar written past L: refused.
    let s = 0n;
    for (let i = 63; i >= 32; i--) s = (s << 8n) | BigInt(signature[i]!);
    let t = s + ed25519.Point.Fn.ORDER;
    const malleable = Uint8Array.from(signature);
    for (let i = 32; i < 64; i++, t >>= 8n) malleable[i] = Number(t & 0xffn);
    expect(verifyEd25519Strict(malleable, message, key)).toBe(false);
    // R written non-canonically, or replaced by a small-order point: refused.
    for (const r of [...SMALL, ...NONCANONICAL]) {
      const forged = Uint8Array.from(signature);
      forged.set(r, 0);
      expect(verifyEd25519Strict(forged, message, key)).toBe(false);
    }
    // Each small-order key's forgery (R the identity, S zero) is refused, whatever ZIP-215 says of it.
    const forgery = new Uint8Array(64);
    forgery.set(SMALL[0]!, 0);
    for (const point of SMALL) expect(verifyEd25519Strict(forgery, message, point)).toBe(false);
    expect(verifyEd25519Strict(signature.subarray(0, 63), message, key)).toBe(false);
  });

  // What only a key's own holder can sign, which a cofactored equation can't tell apart: R the identity, or R of mixed
  // order. ZIP-215, and noble's own strict mode, take both; the rule takes neither (A and R in the prime-order subgroup,
  // neither the identity), however it is checked.
  test("a key's own holder can't sign with R the identity, nor with R of mixed order: ZIP-215 takes both, the rule neither", () => {
    const { scalar: a, pointBytes: key } = ed25519.utils.getExtendedPublicKey(randomBytes(32));
    const order = ed25519.Point.Fn.ORDER;
    const message = utf8("a log event's id");
    const le = (bytes: Uint8Array) => bytes.reduceRight((n, byte) => (n << 8n) | BigInt(byte), 0n);
    const signed = (encodedR: Uint8Array, r: bigint) => {
      const k = le(sha512(concat(encodedR, key, message))) % order;
      let s = (r + k * a) % order;
      const signature = new Uint8Array(64);
      signature.set(encodedR, 0);
      for (let i = 32; i < 64; i++, s >>= 8n) signature[i] = Number(s & 0xffn);
      return signature;
    };
    const r = (le(randomBytes(32)) % (order - 1n)) + 1n;
    // R the identity, S = k·a: [S]B = R + [k]A holds exactly.
    const withIdentity = signed(SMALL[0]!, 0n);
    // R = [r]B plus the point of order 2: the equation holds only once the cofactor clears it.
    const withMixed = signed(ed25519.Point.BASE.multiply(r).add(ed25519.Point.fromBytes(SMALL[1]!)).toBytes(), r);
    for (const signature of [withIdentity, withMixed]) {
      expect(verifyEd25519(signature, message, key)).toBe(true);
      expect(ed25519.verify(signature, message, key, { zip215: false })).toBe(true);
      expect(verifyEd25519Strict(signature, message, key)).toBe(false);
    }
    // Signed as it should be, by the same key: taken.
    expect(verifyEd25519Strict(signed(ed25519.Point.BASE.multiply(r).toBytes(), r), message, key)).toBe(true);
  });

  // The lead's word of 27 November 2026: the log's and link calls' node signatures are held to the rule from 14 December
  // 2026, by the event's own HLC and the request's own time; before it, as they always were, so a log converges the same.
  const weakKey = SMALL[0]!;
  const weak = `n_${b64u(weakKey)}`;
  /** R the identity, S zero: under ZIP-215's rules, the identity's key "signs" any message so. */
  const universal = (() => {
    const signature = new Uint8Array(64);
    signature.set(weakKey, 0);
    return signature;
  })();

  test("a log event is held to the rule from the cutoff by its own HLC: a weak key's forgery stamped before it is taken as it always was, after it refused", () => {
    const at = (ms: number, device = weak) => ({ v: 1 as const, fleet: b64u(randomBytes(32)), hlc: encodeHlc({ ms, counter: 0 }), device, kind: "run.started", body: { any: "thing" } });
    const forged = (ms: number) => {
      const unsigned = at(ms);
      return { ...unsigned, id: eventId(unsigned), sig: b64u(universal) };
    };
    // The lead's date: the day requests must name their node too.
    expect(new Date(SIGNATURES_STRICT_FROM).toISOString()).toBe("2026-12-14T00:00:00.000Z");
    expect(SIGNATURES_STRICT_FROM).toBe(REQUESTS_NAME_THEIR_NODE_FROM);
    expect(verifyEd25519(universal, utf8("anything at all"), weakKey)).toBe(true);
    expect(parseEvent(forged(SIGNATURES_STRICT_FROM - 1)).device).toBe(weak);
    expect(() => parseEvent(forged(SIGNATURES_STRICT_FROM))).toThrow("bad event signature");
    expect(() => parseEvent(forged(SIGNATURES_STRICT_FROM + 86_400_000))).toThrow("bad event signature");
    // A real node's events verify on either side.
    const node = newNodeIdentity();
    for (const ms of [SIGNATURES_STRICT_FROM - 1, SIGNATURES_STRICT_FROM]) expect(parseEvent(signEvent(at(ms, node.id), node)).device).toBe(node.id);
  });

  test("a link call is held to the rule from the cutoff by its own time: a weak key's forgery made before it is taken as it always was, after it refused", async () => {
    const body = utf8('{"have":{}}');
    const forged = (ms: number) =>
      new Headers({ [AUTH.device]: weak, [AUTH.ts]: String(ms), [AUTH.nonce]: "a-link-call-nonce", [AUTH.sig]: b64u(universal) });
    const node = newNodeIdentity().id;
    const before = SIGNATURES_STRICT_FROM - 60_000;
    expect(verifyRequestSignature(forged(before), "POST", "/link/sync", body, before, node)?.named).toBe(true);
    expect(verifyRequestSignature(forged(before), "POST", "/link/sync", body, before)?.named).toBe(false);
    for (const after of [SIGNATURES_STRICT_FROM, SIGNATURES_STRICT_FROM + 60_000]) {
      expect(verifyRequestSignature(forged(after), "POST", "/link/sync", body, after, node)).toBeNull();
      // Nor as one that names no node, whoami's (taken after the cutoff when its caller says so).
      expect(verifyRequestSignature(forged(after), "POST", "/link/sync", body, after, node, true)).toBeNull();
    }
    // A real node's link calls verify on either side.
    const real = newNodeIdentity();
    for (const ms of [before, SIGNATURES_STRICT_FROM + 60_000]) {
      const headers = new Headers(await signRequest(real.id, real.sign, "POST", "/link/sync", body, ms, node));
      expect(verifyRequestSignature(headers, "POST", "/link/sync", body, ms, node)?.device).toBe(real.id);
    }
  });
});
