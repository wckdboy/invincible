import { describe, expect, test } from "bun:test";
import { b64u, type Bytes, concat, fromB64u, utf8 } from "../src/bytes.ts";
import { aes128gcmEncode, encryptPush, isP256Point, newPushKeyPair, PUSH_MAX_PLAINTEXT, pushPublicKey, readVapidToken, vapidAuthorization, vapidToken } from "../src/webpush.ts";

/*
 * Web Push against the RFCs' own examples, byte for byte, and a round trip in which the
 * message is decrypted the way a browser does it: by WebCrypto, an implementation that
 * shares no code with ours.
 *
 * Every key below is published in an RFC as an example. None of them protects anything.
 */

/* ---------- a browser's side, on WebCrypto (RFC 8291 §3.4, RFC 8188 §2) ---------- */

const buf = (bytes: Bytes): ArrayBuffer => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;

async function hkdf(salt: Bytes, ikm: Bytes, info: Bytes, length: number): Promise<Bytes> {
  const key = await crypto.subtle.importKey("raw", buf(ikm), "HKDF", false, ["deriveBits"]);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt: buf(salt), info: buf(info) }, key, length * 8));
}

/** A browser's subscription keys: a WebCrypto ECDH key pair and a random authentication secret. */
async function browserSubscription(): Promise<{ keys: CryptoKeyPair; p256dh: Bytes; auth: Bytes }> {
  const keys = (await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"])) as CryptoKeyPair;
  return { keys, p256dh: new Uint8Array(await crypto.subtle.exportKey("raw", keys.publicKey)), auth: crypto.getRandomValues(new Uint8Array(16)) };
}

/** Decrypts an aes128gcm push message as the user agent: header, ECDH, the two HKDF steps, AES-GCM, the delimiter. */
async function browserDecrypt(body: Bytes, privateKey: CryptoKey, p256dh: Bytes, auth: Bytes): Promise<Bytes> {
  const salt = body.slice(0, 16);
  const recordSize = new DataView(buf(body)).getUint32(16, false);
  const idLength = body[20]!;
  const senderPublic = body.slice(21, 21 + idLength);
  const ciphertext = body.slice(21 + idLength);
  expect(ciphertext.length).toBeLessThanOrEqual(recordSize);
  const sender = await crypto.subtle.importKey("raw", buf(senderPublic), { name: "ECDH", namedCurve: "P-256" }, false, []);
  const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: "ECDH", public: sender }, privateKey, 256));
  const ikm = await hkdf(auth, shared, concat(utf8("WebPush: info\0"), p256dh, senderPublic), 32);
  const cek = await hkdf(salt, ikm, utf8("Content-Encoding: aes128gcm\0"), 16);
  const nonce = await hkdf(salt, ikm, utf8("Content-Encoding: nonce\0"), 12);
  const key = await crypto.subtle.importKey("raw", buf(cek), "AES-GCM", false, ["decrypt"]);
  const record = new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: buf(nonce) }, key, buf(ciphertext)));
  // The last record ends with 0x02, then only padding.
  let end = record.length - 1;
  while (end >= 0 && record[end] === 0) end -= 1;
  expect(record[end]).toBe(0x02);
  return record.slice(0, end);
}

/** A private scalar as a WebCrypto ECDH key (the RFC gives the user agent's key as its scalar). */
async function importScalar(d: Bytes, publicKey: Bytes): Promise<CryptoKey> {
  return crypto.subtle.importKey("jwk", { kty: "EC", crv: "P-256", d: b64u(d), x: b64u(publicKey.slice(1, 33)), y: b64u(publicKey.slice(33)), ext: true }, { name: "ECDH", namedCurve: "P-256" }, false, ["deriveBits"]);
}

describe("RFC 8188: the aes128gcm content coding", () => {
  test("§3.1's example, byte for byte", () => {
    const body = aes128gcmEncode({ ikm: fromB64u("yqdlZ-tYemfogSmv7Ws5PQ"), salt: fromB64u("I1BsxtFttlv3u_Oo94xnmw"), keyId: new Uint8Array(), plaintext: utf8("I am the walrus"), recordSize: 4096 });
    expect(b64u(body)).toBe("I1BsxtFttlv3u_Oo94xnmwAAEAAA-NAVub2qFgBEuQKRapoZu-IxkIva3MEB1PD-ly8Thjg");
  });

  test("a message that doesn't fit in one record is refused, never split", () => {
    expect(() => aes128gcmEncode({ ikm: new Uint8Array(16), salt: new Uint8Array(16), keyId: new Uint8Array(), plaintext: new Uint8Array(24), recordSize: 40 })).toThrow("doesn't fit");
    expect(() => aes128gcmEncode({ ikm: new Uint8Array(16), salt: new Uint8Array(8), keyId: new Uint8Array(), plaintext: new Uint8Array(1) })).toThrow("16 bytes");
  });
});

describe("RFC 8291: message encryption for Web Push", () => {
  // §5 and Appendix A.
  const plaintext = fromB64u("V2hlbiBJIGdyb3cgdXAsIEkgd2FudCB0byBiZSBhIHdhdGVybWVsb24");
  const asPrivate = fromB64u("yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw");
  const asPublic = fromB64u("BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8");
  const uaPrivate = fromB64u("q1dXpw3UpT5VOmu_cf_v6ih07Aems3njxI-JWgLcM94");
  const uaPublic = fromB64u("BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4");
  const auth = fromB64u("BTBZMqHH6r4Tts7J_aSIgg");
  const salt = fromB64u("DGv6ra1nlYgDCS1FRnbzlw");
  const expected =
    "DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN";

  test("the example's keys are a pair (so the vector is copied right)", () => {
    expect(new TextDecoder().decode(plaintext)).toBe("When I grow up, I want to be a watermelon");
    expect(b64u(pushPublicKey(asPrivate))).toBe(b64u(asPublic));
    expect(b64u(pushPublicKey(uaPrivate))).toBe(b64u(uaPublic));
  });

  test("§5's example, byte for byte", () => {
    const body = encryptPush({ p256dh: uaPublic, auth }, plaintext, { sender: { privateKey: asPrivate, publicKey: asPublic }, salt });
    expect(b64u(body)).toBe(expected);
  });

  test("the RFC's own message decrypts on WebCrypto with the user agent's key", async () => {
    const key = await importScalar(uaPrivate, uaPublic);
    expect(new TextDecoder().decode(await browserDecrypt(fromB64u(expected), key, uaPublic, auth))).toBe("When I grow up, I want to be a watermelon");
  });

  test("a round trip: encrypted on the node's side, decrypted as a browser would", async () => {
    const browser = await browserSubscription();
    const message = utf8(JSON.stringify({ v: 1, k: "needs-you", t: "Galahad: needs you", b: "ultra is low on disk", o: "inbox" }));
    const body = encryptPush({ p256dh: browser.p256dh, auth: browser.auth }, message);
    expect(new TextDecoder().decode(await browserDecrypt(body, browser.keys.privateKey, browser.p256dh, browser.auth))).toBe(new TextDecoder().decode(message));
    // A fresh sender key and salt each time: the same message never encrypts the same way twice.
    const again = encryptPush({ p256dh: browser.p256dh, auth: browser.auth }, message);
    expect(b64u(again)).not.toBe(b64u(body));
    expect(b64u(again.slice(0, 16))).not.toBe(b64u(body.slice(0, 16)));
    expect(b64u(again.slice(21, 86))).not.toBe(b64u(body.slice(21, 86)));
    // Another browser (another key, or the right key with another secret) can't read it.
    const other = await browserSubscription();
    await expect(browserDecrypt(body, other.keys.privateKey, other.p256dh, other.auth)).rejects.toThrow();
    await expect(browserDecrypt(body, browser.keys.privateKey, browser.p256dh, other.auth)).rejects.toThrow();
    // Nothing of the message is readable in what the push service carries.
    expect(new TextDecoder("utf-8", { fatal: false }).decode(body)).not.toContain("low on disk");
  });

  test("padded: a short message and a long one are the same size on the wire, and both read back whole", async () => {
    const browser = await browserSubscription();
    const short = utf8('{"v":1,"kind":"test","title":"Galahad","body":"Hi.","open":"settings","tag":"test"}');
    const long = utf8(JSON.stringify({ v: 1, kind: "needs-you", title: "Galahad: this needs you", body: "x".repeat(140), open: "inbox", tag: "t-0123456789abcdefghijkl" }));
    const a = encryptPush({ p256dh: browser.p256dh, auth: browser.auth }, short, { padTo: 1024 });
    const b = encryptPush({ p256dh: browser.p256dh, auth: browser.auth }, long, { padTo: 1024 });
    expect(a.length).toBe(b.length);
    // Header (16 + 4 + 1 + 65), the padded record with its delimiter, the tag.
    expect(a.length).toBe(86 + 1024 + 1 + 16);
    expect(new TextDecoder().decode(await browserDecrypt(a, browser.keys.privateKey, browser.p256dh, browser.auth))).toBe(new TextDecoder().decode(short));
    expect(new TextDecoder().decode(await browserDecrypt(b, browser.keys.privateKey, browser.p256dh, browser.auth))).toBe(new TextDecoder().decode(long));
    // Unpadded they differ, which is what a push service would otherwise see.
    expect(encryptPush({ p256dh: browser.p256dh, auth: browser.auth }, short).length).not.toBe(encryptPush({ p256dh: browser.p256dh, auth: browser.auth }, long).length);
    // A message longer than the padding is sent as it is, never cut.
    const big = new Uint8Array(1500).fill(65);
    expect((await browserDecrypt(encryptPush({ p256dh: browser.p256dh, auth: browser.auth }, big, { padTo: 1024 }), browser.keys.privateKey, browser.p256dh, browser.auth)).length).toBe(1500);
  });

  test("a changed byte is refused by the browser, wherever it is", async () => {
    const browser = await browserSubscription();
    const body = encryptPush({ p256dh: browser.p256dh, auth: browser.auth }, utf8("approve?"));
    for (const at of [0, 30, body.length - 1]) {
      const bent = body.slice();
      bent[at]! ^= 1;
      await expect(browserDecrypt(bent, browser.keys.privateKey, browser.p256dh, browser.auth)).rejects.toThrow();
    }
  });

  test("a subscription that isn't one is refused before anything is derived", () => {
    const good = newPushKeyPair();
    expect(() => encryptPush({ p256dh: good.publicKey.slice(0, 64), auth: new Uint8Array(16) }, utf8("x"))).toThrow("P-256");
    const offCurve = good.publicKey.slice();
    offCurve[64]! ^= 1;
    expect(isP256Point(offCurve)).toBe(false);
    expect(() => encryptPush({ p256dh: offCurve, auth: new Uint8Array(16) }, utf8("x"))).toThrow("P-256");
    // A compressed point is a valid key elsewhere, but not what a subscription carries.
    expect(isP256Point(good.publicKey)).toBe(true);
    expect(() => encryptPush({ p256dh: good.publicKey, auth: new Uint8Array(12) }, utf8("x"))).toThrow("16 bytes");
    expect(() => encryptPush({ p256dh: good.publicKey, auth: new Uint8Array(16) }, new Uint8Array(PUSH_MAX_PLAINTEXT + 1))).toThrow("at most");
  });
});

describe("RFC 8292: VAPID", () => {
  // §2.4's example: the token, and the key it verifies under.
  const example =
    "eyJ0eXAiOiJKV1QiLCJhbGciOiJFUzI1NiJ9.eyJhdWQiOiJodHRwczovL3B1c2guZXhhbXBsZS5uZXQiLCJleHAiOjE0NTM1MjM3NjgsInN1YiI6Im1haWx0bzpwdXNoQGV4YW1wbGUuY29tIn0.i3CYb7t4xfxCDquptFOepC9GAu_HLGkMlMuCGSK2rpiUfnK9ojFwDXb1JrErtmysazNjjvW2L9OkSSHzvoD1oA";
  const exampleKey = fromB64u("BA1Hxzyi1RUM1b5wjxsn7nGxAszw2u61m164i3MrAIxHF6YK5h4SDYic-dRuU_RCPCfA5aq9ojSwk5Y2EmClBPs");

  test("the RFC's example token verifies under the RFC's key, and reads as it says", () => {
    expect(readVapidToken(example, exampleKey)).toEqual({ aud: "https://push.example.net", exp: 1453523768, sub: "mailto:push@example.com" });
    // Under another key, or with a claim changed, it's no token.
    expect(readVapidToken(example, newPushKeyPair().publicKey)).toBeNull();
    const [header, , signature] = example.split(".");
    const forged = `${header}.${b64u(utf8('{"aud":"https://evil.example","exp":1453523768,"sub":"mailto:push@example.com"}'))}.${signature}`;
    expect(readVapidToken(forged, exampleKey)).toBeNull();
    expect(readVapidToken("not.a.token", exampleKey)).toBeNull();
  });

  test("our token is the RFC's, but for the signature: same header, same claims in the same order", () => {
    const keys = newPushKeyPair();
    const token = vapidToken({ audience: "https://push.example.net", subject: "mailto:push@example.com", expires: 1453523768, privateKey: keys.privateKey });
    expect(token.split(".").slice(0, 2).join(".")).toBe(example.split(".").slice(0, 2).join("."));
    expect(readVapidToken(token, keys.publicKey)).toEqual({ aud: "https://push.example.net", exp: 1453523768, sub: "mailto:push@example.com" });
    // The signature is r || s, 64 bytes (JWS), not DER.
    expect(fromB64u(token.split(".")[2]!).length).toBe(64);
  });

  test("a browser's WebCrypto verifies our signature (ES256 as push services check it)", async () => {
    const keys = newPushKeyPair();
    const token = vapidToken({ audience: "https://updates.push.services.mozilla.com", subject: "mailto:owner@example.com", expires: 1_800_000_000, privateKey: keys.privateKey });
    const [header, claims, signature] = token.split(".");
    const key = await crypto.subtle.importKey("raw", buf(keys.publicKey), { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
    expect(await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, key, buf(fromB64u(signature!)), buf(utf8(`${header}.${claims}`)))).toBe(true);
  });

  test("the Authorization header carries the token and the public key, and nothing of the private one", () => {
    const keys = newPushKeyPair();
    const token = vapidToken({ audience: "https://fcm.googleapis.com", subject: "mailto:owner@example.com", expires: 1_800_000_000, privateKey: keys.privateKey });
    const header = vapidAuthorization(token, keys.publicKey);
    expect(header).toBe(`vapid t=${token}, k=${b64u(keys.publicKey)}`);
    expect(header).not.toContain(b64u(keys.privateKey));
    expect(keys.publicKey.length).toBe(65);
    expect(keys.privateKey.length).toBe(32);
  });
});
