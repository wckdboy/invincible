import { describe, expect, test } from "bun:test";
import { ed25519 } from "@noble/curves/ed25519.js";
import { ed25519OfDidKey, QAMP_TOOLS, QAMP_TTL, QampDid, QampGrantInput, QampRevokeInput, qampArm } from "../src/index.ts";

/*
 * A Q-AMP grant, as the contract holds it: an agent's Ed25519 key, some of the four read-only tools you allowed, and a
 * lifetime of a minute to a day. Anything else is refused at the door, by name, never trimmed or cut short.
 */

/** The did:key method's own example (a public key, from its spec). */
const SPEC_EXAMPLE = "did:key:z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK";

/** A did:key written here, apart from the code under test: base58btc of 0xed 0x01 and the key. */
function didKeyOf(publicKey: Uint8Array): string {
  const alphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  let n = BigInt(`0x${Buffer.from([0xed, 0x01, ...publicKey]).toString("hex")}`);
  let out = "";
  while (n > 0n) {
    out = alphabet[Number(n % 58n)] + out;
    n /= 58n;
  }
  return `did:key:z${out}`;
}

describe("an agent's key", () => {
  test("an Ed25519 did:key names its public key: the spec's example, and keys made here", () => {
    expect(Buffer.from(ed25519OfDidKey(SPEC_EXAMPLE)!).toString("hex")).toBe("2e6fcce36701dc791488e0d0b1745cc1e33a4c1c9fcc41c63bd343dbbe0970e6");
    for (let i = 0; i < 50; i++) {
      const { publicKey } = ed25519.keygen();
      expect(ed25519OfDidKey(didKeyOf(publicKey))).toEqual(publicKey);
    }
  });

  test("anything else names none: another curve, a character base58 hasn't, the wrong length, the wrong prefix, around spaces", () => {
    for (const did of [
      "did:key:zDnaerDaTF5BXEavCrfRZEk316dpbLsfPDZ3WJ5hRTPFU2169", // P-256: Q-AMP 0.1 has no such keys
      SPEC_EXAMPLE.replace("haX", "ha0"),
      SPEC_EXAMPLE.slice(0, -1),
      `${SPEC_EXAMPLE}K`,
      `did:key:z6Mk${"1".repeat(44)}`,
      `did:key:z6Mk${"z".repeat(44)}`,
      ` ${SPEC_EXAMPLE}`,
      `${SPEC_EXAMPLE}\n`,
      SPEC_EXAMPLE.replace("did:key:", "did:web:"),
      "n_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    ]) {
      expect([did, ed25519OfDidKey(did)]).toEqual([did, null]);
      expect(QampDid.safeParse(did).success).toBe(false);
    }
  });
});

describe("a grant, as you give it", () => {
  test("an agent's key, some of the four tools, and a lifetime: an hour unless you say", () => {
    expect(QampGrantInput.parse({ agent: SPEC_EXAMPLE, tools: ["fleet", "compute"] })).toEqual({ agent: SPEC_EXAMPLE, tools: ["fleet", "compute"], ttlSeconds: 3600 });
    expect(QampGrantInput.parse({ agent: SPEC_EXAMPLE, tools: [...QAMP_TOOLS], ttlSeconds: QAMP_TTL.max }).ttlSeconds).toBe(86_400);
    expect(QampGrantInput.parse({ agent: SPEC_EXAMPLE, tools: ["ledger"], ttlSeconds: QAMP_TTL.min }).ttlSeconds).toBe(60);
  });

  test("any other tool is refused by name, saying which four you have allowed so far", () => {
    for (const tool of ["recall", "archive_search", "about_you", "remember", "sandbox_run", "connector_call", "FLEET", "fleet "]) {
      const refused = QampGrantInput.safeParse({ agent: SPEC_EXAMPLE, tools: ["fleet", tool] });
      expect(refused.success).toBe(false);
      expect(refused.error!.issues.map((i) => i.message)).toEqual([`${JSON.stringify(tool)} can't be granted: fleet, compute, place and ledger are the tools you have allowed so far`]);
    }
    expect(QampGrantInput.safeParse({ agent: SPEC_EXAMPLE, tools: [] }).success).toBe(false);
    expect(QampGrantInput.safeParse({ agent: SPEC_EXAMPLE, tools: ["fleet", "fleet"] }).error!.issues.map((i) => i.message)).toEqual(["each tool once"]);
  });

  test("a lifetime past 24 hours is refused, never cut short; under a minute too, and anything not whole seconds", () => {
    const over = QampGrantInput.safeParse({ agent: SPEC_EXAMPLE, tools: ["fleet"], ttlSeconds: QAMP_TTL.max + 1 });
    expect(over.error!.issues.map((i) => i.message)).toEqual(["a grant lasts 24 hours at most: grant again when it ends"]);
    for (const ttlSeconds of [59, 0, -1, 3600.5, "3600", null]) expect(QampGrantInput.safeParse({ agent: SPEC_EXAMPLE, tools: ["fleet"], ttlSeconds }).success).toBe(false);
  });

  test("nothing else is taken: no scopes, no tool of another name, no key that isn't Ed25519", () => {
    expect(QampGrantInput.safeParse({ agent: SPEC_EXAMPLE, tools: ["fleet"], scopes: ["mind:read"] }).success).toBe(false);
    expect(QampGrantInput.safeParse({ agent: "did:key:zDnaerDaTF5BXEavCrfRZEk316dpbLsfPDZ3WJ5hRTPFU2169", tools: ["fleet"] }).success).toBe(false);
  });

  test("one ended by its id, or every one; never both, never neither", () => {
    expect(QampRevokeInput.safeParse({ id: "0a1b2c3d4e" }).success).toBe(true);
    expect(QampRevokeInput.safeParse({ all: true }).success).toBe(true);
    for (const input of [{}, { all: false }, { id: "0a1b2c3d4e", all: true }, { id: "../arms" }, { id: "0A1B2C3D4E" }]) expect(QampRevokeInput.safeParse(input).success).toBe(false);
    expect(qampArm("0a1b2c3d4e")).toBe("qamp.0a1b2c3d4e");
  });
});
