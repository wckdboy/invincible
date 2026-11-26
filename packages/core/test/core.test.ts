import { describe, expect, test } from "bun:test";
import {
  aeadOpen,
  aeadSeal,
  b64u,
  canonical,
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
} from "../src/index.ts";

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
    const future = signEvent({ ...unsigned, fleet: b64u(randomBytes(32)), kind: "quest.started", body: { any: "thing" } }, node);
    expect(parseEvent(future).kind).toBe("quest.started");
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
    const nonces = new NonceCache();
    const proof = verifyRequestSignature(headers, "POST", "/link/sync", body, 10_000)!;
    expect(nonces.claim(proof.device, proof.nonce, 10_000)).toBe(true);
    expect(nonces.claim(proof.device, proof.nonce, 10_001)).toBe(false);
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
    const { invite } = newInvite("http://100.64.0.1:7777", b64u(randomBytes(32)), "client");
    const text = encodeInvite(invite);
    expect(decodeInvite(text)).toEqual(invite);
    expect(decodeInvite(`https://laptop.tail.ts.net/#pair=${text}`)).toEqual(invite);
  });
  test("proof binds the device key; SAS differs per device", () => {
    const fleet = b64u(randomBytes(32));
    const { invite, secret } = newInvite("http://100.64.0.1:7777", fleet, "node");
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
