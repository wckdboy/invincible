import { describe, expect, test } from "bun:test";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import {
  CborError,
  cborDecode,
  cborEncode,
  didKeyOfEd25519,
  goalDigest,
  handoffUnder,
  newNodeIdentity,
  onTailnetOrLoopback,
  type ProofStatement,
  proofRefusal,
  qampAddressDid,
  qampEndpointOf,
  qdtChainText,
  qdtChainTokens,
  readHandoffTerms,
  readQdt,
  runGrantPolicy,
  signingPublicKey,
  signEd25519,
  signProof,
  signQdt,
  signTransportClaim,
} from "../src/index.ts";
import rust from "./fixtures/qdt-rust.json";

/*
 * The fabric's parts that every node shares: CBOR as Q-AMP reads it, delegation tokens as its SPEC 9.3 writes them (checked
 * against tokens its own Rust CLI made), a node's Q-AMP endpoint in its profile, and the proof a node signs for work it
 * ran for another, which no node that didn't run the work can make pass.
 */

/** Test keys only: the Ed25519 seeds 01…01 and 02…02 of Q-AMP's SPEC A.2, and their DIDs (the fixture's `one` and `two`). */
const SEED_ONE = new Uint8Array(32).fill(1);
const SEED_TWO = new Uint8Array(32).fill(2);
const ONE = didKeyOfEd25519(signingPublicKey(SEED_ONE));
const TWO = didKeyOfEd25519(signingPublicKey(SEED_TWO));

/** A small deterministic generator, so the fuzzing below is the same run every time (never flaky). */
function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe("CBOR, as Q-AMP reads it", () => {
  test("the JSON data model and byte strings go there and back", () => {
    const value = { t: "call", id: 7, peer: "qamp://x", args: { n: -3, f: 1.5, big: 2n ** 60n, list: [true, false, null, "é"], deep: { a: [{ b: [] }] } }, bytes: new Uint8Array([0, 1, 255]) };
    const back = cborDecode(cborEncode(value)) as Record<string, unknown>;
    expect(back).toEqual(value);
    // A number that isn't a safe integer goes as a double, as JSON would carry it.
    expect(cborDecode(cborEncode(2 ** 53 + 2))).toBe(2 ** 53 + 2);
    expect(Object.getPrototypeOf(back)).toBeNull();
  });

  test("tags, undefined, other simple values, trailing bytes and broken text are refused", () => {
    for (const [hex, why] of [
      ["c11a5f5e1000", "tags"],
      ["f7", "undefined"],
      ["f0", "simple values"],
      ["0000", "trailing"],
      ["62c328", "UTF-8"],
      ["5a00000010", "truncated"],
      ["9b0000000100000000", "truncated"],
    ] as const) {
      const bytes = Uint8Array.from(Buffer.from(hex, "hex"));
      expect(() => cborDecode(bytes)).toThrow(CborError);
      expect(() => cborDecode(bytes)).toThrow(new RegExp(why, "i"));
    }
  });

  test("the decode budget is held before anything is built: depth and items", () => {
    const deep = new Uint8Array(70).fill(0x81);
    expect(() => cborDecode(Uint8Array.from([...deep, 0x00]))).toThrow(/nested too deeply/);
    // An array that says it holds 100,000 items, each one byte: past the item budget, and refused before any is made.
    const many = new Uint8Array(5 + 100_000);
    many.set([0x9a, 0x00, 0x01, 0x86, 0xa0]);
    expect(() => cborDecode(many)).toThrow(/too many items/);
    expect(cborDecode(many, { budget: { maxItems: 200_000, maxDepth: 4 } })).toHaveLength(100_000);
  });

  test("signed statements can refuse floats and a key said twice", () => {
    expect(() => cborDecode(cborEncode({ exp: 1.5 }), { rejectFloats: true })).toThrow(/float/);
    const twice = Uint8Array.from(Buffer.from("a2617801617802", "hex"));
    expect(cborDecode(twice)).toEqual({ x: 2 });
    expect(() => cborDecode(twice, { rejectDuplicateKeys: true })).toThrow(/duplicate/);
  });

  test("fuzzed: whatever the bytes, it decodes or says why as a CborError, and what decodes encodes back to itself", () => {
    const random = prng(0x5eed);
    const seeds = [cborEncode({ t: "invoke", task: 3, args: { a: [1, 2.5, "x"] }, chain: [{ id: "ab" }] }), cborEncode([new Uint8Array(8), -1, 2 ** 40, { k: null }]), cborEncode("text")];
    let decoded = 0;
    for (let i = 0; i < 20_000; i++) {
      let bytes: Uint8Array;
      if (i % 3 === 0) {
        bytes = new Uint8Array(Math.floor(random() * 40));
        for (let j = 0; j < bytes.length; j++) bytes[j] = Math.floor(random() * 256);
      } else {
        bytes = Uint8Array.from(seeds[i % seeds.length]!);
        for (let flips = 1 + Math.floor(random() * 4); flips > 0; flips--) {
          const at = Math.floor(random() * bytes.length);
          bytes[at] = bytes[at]! ^ (1 << Math.floor(random() * 8));
        }
        if (random() < 0.2) bytes = bytes.slice(0, Math.floor(random() * bytes.length));
      }
      let value: unknown;
      try {
        value = cborDecode(bytes);
      } catch (error) {
        if (!(error instanceof CborError)) throw new Error(`${Buffer.from(bytes).toString("hex")} threw ${(error as Error).name}: ${(error as Error).message}`);
        continue;
      }
      decoded++;
      expect(cborDecode(cborEncode(value))).toEqual(value as never);
    }
    expect(decoded).toBeGreaterThan(100);
  });
});

describe("delegation tokens, as Q-AMP's SPEC 9.3 writes them", () => {
  test("the spec's test keys name the spec's DIDs (A.2)", () => {
    expect(didKeyOfEd25519(signingPublicKey(SEED_ONE))).toBe("did:key:z6Mkon3Necd6NkkyfoGoHxid2znGc59LU3K7mubaRcFbLfLX");
    expect(TWO).not.toBe(ONE);
  });

  test("a chain Q-AMP's own CLI made reads here: its links, their ids, their signatures", () => {
    const tokens = qdtChainTokens(rust.chain2).map(readQdt);
    expect(tokens).toHaveLength(2);
    const [root, last] = tokens as [ReturnType<typeof readQdt>, ReturnType<typeof readQdt>];
    expect(root.payload).toMatchObject({ iss: ONE, aud: TWO, sub: ONE, cmd: "/tool/invincible/agent", pol: [["==", ".task", "h_AAAAAAAAAAAAAAAAAAAAAA"]] });
    expect(last.payload).toMatchObject({ iss: TWO, aud: ONE, cmd: "/tool/invincible/agent/fleet" });
    expect([root.signed, last.signed]).toEqual([true, true]);
    expect(qdtChainTokens(rust.chain1).map((t) => readQdt(t).id)).toEqual([root.id]);
  });

  test("a token signed here reads back as Q-AMP's would: signed, its id the SHA-256 of its payload", () => {
    const token = signQdt(SEED_TWO, { aud: ONE, sub: ONE, cmd: "/tool/invincible/agent", exp: 4_102_444_800, pol: runGrantPolicy("h_AAAAAAAAAAAAAAAAAAAAAA") });
    const read = readQdt(token.encoded);
    expect(read.signed).toBe(true);
    expect(read.payload).toMatchObject({ iss: TWO, aud: ONE, sub: ONE, cmd: "/tool/invincible/agent", exp: 4_102_444_800, nbf: null, meta: null });
    const envelope = cborDecode(token.encoded) as { p: Uint8Array };
    expect(read.id).toBe(bytesToHex(sha256(envelope.p)));
    // Extending the CLI's chain: its root link, then this one.
    const chain = qdtChainText([qdtChainTokens(rust.chain1)[0]!, token.encoded]);
    expect(qdtChainTokens(chain).map((t) => readQdt(t).signed)).toEqual([true, true]);
  });

  test("a token whose payload was changed after signing is not signed by its issuer", () => {
    const token = signQdt(SEED_ONE, { aud: TWO, cmd: "/tool/invincible/agent/fleet", exp: 4_102_444_800 });
    const envelope = cborDecode(token.encoded) as { p: Uint8Array; s: Uint8Array };
    const payload = cborDecode(envelope.p) as Record<string, unknown>;
    // The same payload with a later expiry, under the first one's signature.
    const later = cborEncode(new Map(Object.entries({ ...payload, exp: 4_102_444_801 })));
    const changed = cborEncode(new Map<string, unknown>([["p", later], ["s", envelope.s]]));
    expect(readQdt(changed).payload.exp).toBe(4_102_444_801);
    expect(readQdt(changed).signed).toBe(false);
    expect(readQdt(token.encoded).signed).toBe(true);
  });

  test("what isn't a command, a lifetime or a DID is refused, never trimmed", () => {
    expect(() => signQdt(SEED_ONE, { aud: TWO, cmd: "/Tool/x", exp: 10 })).toThrow(/command/);
    expect(() => signQdt(SEED_ONE, { aud: TWO, cmd: "/tool/x", exp: 1.5 })).toThrow(/exp/);
    expect(() => signQdt(SEED_ONE, { aud: "n_abc", cmd: "/tool/x", exp: 10 })).toThrow(/aud/);
    expect(() => qdtChainTokens("qdt2.gA")).toThrow(/qdt1/);
    expect(() => qdtChainTokens(`qdt1.${"A".repeat(30_000)}`)).toThrow(/too long/);
  });
});

describe("a node's Q-AMP endpoint, as its profile says it", () => {
  const NODE = "n_" + "A".repeat(43);
  const OTHER = "n_" + "B".repeat(43);
  const pop = signTransportClaim(SEED_ONE, NODE);

  test("its key, an address that names the same key, and the key's own signature that it is this node's", () => {
    const did = ONE;
    expect(qampAddressDid(`qamp://${did}@192.0.2.10:7410`)).toBe(did);
    expect(qampAddressDid(`qamp://${did}@[fd7a:115c::1]:7410`)).toBe(did);
    expect(qampEndpointOf({ cores: 4, qamp: { did, address: `qamp://${did}@127.0.0.1:7410`, pop } }, NODE)).toEqual({ did, address: `qamp://${did}@127.0.0.1:7410`, pop });
  });

  test("a claim on a key it doesn't hold is no endpoint: no signature, another node's, or another key's", () => {
    const address = `qamp://${ONE}@127.0.0.1:7410`;
    expect(qampEndpointOf({ qamp: { did: ONE, address } }, NODE)).toBeNull();
    // The same proof, claimed by another node: it names the node it was made for.
    expect(qampEndpointOf({ qamp: { did: ONE, address, pop } }, OTHER)).toBeNull();
    // Signed by another key than the one it names.
    expect(qampEndpointOf({ qamp: { did: ONE, address, pop: signTransportClaim(SEED_TWO, NODE) } }, NODE)).toBeNull();
    expect(qampEndpointOf({ qamp: { did: ONE, address, pop: "A".repeat(86) } }, NODE)).toBeNull();
  });

  test("an address naming another key, no port, or no endpoint at all reads as none", () => {
    for (const caps of [{ qamp: { did: ONE, address: `qamp://${TWO}@127.0.0.1:7410`, pop } }, { qamp: { did: ONE, address: `qamp://${ONE}@127.0.0.1`, pop } }, { qamp: { did: ONE, address: `qamp://${ONE}@127.0.0.1:70000`, pop } }, { qamp: "x" }, {}, null]) {
      expect(qampEndpointOf(caps, NODE)).toBeNull();
    }
  });
});

describe("the proof a node signs for work it ran for another", () => {
  const runner = newNodeIdentity();
  const giver = newNodeIdentity();
  const other = newNodeIdentity();
  const goal = "Make the failing test pass";
  const statement: ProofStatement = {
    v: 1, by: runner.id, for: giver.id, handoff: "h_AAAAAAAAAAAAAAAAAAAAAA", nonce: "n".repeat(22), task: "task-abcdefghijkl", run: ONE,
    goal: goalDigest(goal), gates: ["bun test"], status: "done", verified: true, ended: "done",
    proof: { before: [1], after: [0], review: "pass", sameModel: false }, startedAt: 1, endedAt: 2,
  };
  const expect_ = { by: runner.id, for: giver.id, handoff: statement.handoff, nonce: statement.nonce, goal, gates: ["bun test"], active: (id: string) => id !== "revoked" };

  test("the runner's signature over this hand-off checks", () => {
    expect(proofRefusal(signProof(runner, statement), expect_)).toBeNull();
  });

  test("a node signs no proof in another's name", () => {
    expect(() => signProof(other, statement)).toThrow(/work it ran/);
  });

  test("a node that didn't run the work can't make it look proven", () => {
    // Its own signature over a statement naming the runner.
    const forged = { statement, sig: signProof(other, { ...statement, by: other.id }).sig };
    expect(proofRefusal(forged, expect_)).toBe("its signature doesn't check");
    // Its own proof, as itself.
    expect(proofRefusal(signProof(other, { ...statement, by: other.id }), expect_)).toBe("it is signed as another node than the one that ran the work");
    // The runner's, with an exit changed on the way.
    const genuine = signProof(runner, statement);
    expect(proofRefusal({ ...genuine, statement: { ...statement, proof: { ...statement.proof!, before: [0] } } }, expect_)).toBe("its signature doesn't check");
    expect(proofRefusal({ ...genuine, statement: { ...statement, verified: false } }, expect_)).toBe("its signature doesn't check");
  });

  test("the runner's proof of another hand-off, another goal or other gates is refused", () => {
    expect(proofRefusal(signProof(runner, { ...statement, handoff: "h_BBBBBBBBBBBBBBBBBBBBBB" }), expect_)).toBe("it is the proof of another hand-off");
    expect(proofRefusal(signProof(runner, { ...statement, nonce: "m".repeat(22) }), expect_)).toBe("it is the proof of another hand-off");
    expect(proofRefusal(signProof(runner, { ...statement, for: other.id }), expect_)).toBe("it is for another node");
    expect(proofRefusal(signProof(runner, { ...statement, goal: goalDigest("Something else") }), expect_)).toBe("it is over another goal");
    expect(proofRefusal(signProof(runner, { ...statement, gates: ["true"] }), expect_)).toBe("its gates aren't the ones asked for");
    // The planner's own proposals may follow yours; yours never go missing.
    expect(proofRefusal(signProof(runner, { ...statement, gates: ["bun test", "bun run lint"] }), expect_)).toBeNull();
    expect(proofRefusal(signProof(runner, { ...statement, gates: [] }), expect_)).toBe("its gates aren't the ones asked for");
  });

  test("a revoked node's proof is refused, and so is what isn't a proof", () => {
    expect(proofRefusal(signProof(runner, statement), { ...expect_, active: () => false })).toBe("the node that signed it isn't an active node of this fleet");
    for (const junk of [null, "x", { statement, sig: "short" }, { statement: { ...statement, extra: 1 }, sig: "A".repeat(86) }]) expect(proofRefusal(junk, expect_)).toBe("it isn't a proof");
  });
});

describe("your grant for hand-offs: what a node takes at once, and what waits for you", () => {
  const grant = readHandoffTerms({ agents: ["ada", "noa"], tools: ["fleet", "ledger"], budgetUsdPerDay: 5 })!;

  test("no grant: everything waits for your approval", () => {
    expect(handoffUnder(null, { agent: "ada", tools: [], budgetUsd: 1 }, 0)).toEqual({ beyond: "you haven't granted that node hand-offs here" });
  });

  test("within it: at once, with the budget asked for, or, when none was, what your agent may give on its own yes ($3), less if the day has less left", () => {
    expect(handoffUnder(grant, { agent: "ada", tools: ["fleet"], budgetUsd: 2 }, 1)).toEqual({ budgetUsd: 2 });
    expect(handoffUnder(grant, { agent: null, tools: [], budgetUsd: undefined }, 1)).toEqual({ budgetUsd: 3 });
    expect(handoffUnder(grant, { agent: null, tools: [] }, 3.5)).toEqual({ budgetUsd: 1.5 });
    expect(handoffUnder(readHandoffTerms({ tools: [], budgetUsdPerDay: 500 })!, { agent: "anyone", tools: [] }, 0)).toEqual({ budgetUsd: 3 });
  });

  test("beyond it, each way, with why: another agent, a tool it doesn't give, more than the day has left", () => {
    expect(handoffUnder(grant, { agent: "max", tools: [], budgetUsd: 1 }, 0)).toEqual({ beyond: "your grant names ada, noa, not max" });
    expect(handoffUnder(grant, { agent: "ada", tools: ["fleet", "compute"], budgetUsd: 1 }, 0)).toEqual({ beyond: "your grant gives its runs fleet, ledger, not compute" });
    expect(handoffUnder(grant, { agent: "ada", tools: [], budgetUsd: 3 }, 2.5)).toEqual({ beyond: "it would pass your grant's $5 a day ($2.50 given in the last 24 hours)" });
    // The day spent: nothing is taken at once, whatever it asks.
    expect(handoffUnder(grant, { agent: "ada", tools: [] }, 5)).toEqual({ beyond: "it would pass your grant's $5 a day ($5.00 given in the last 24 hours)" });
  });

  test("terms this version doesn't understand are no grant here, and a grant gives no tool unless it names it", () => {
    expect(readHandoffTerms({ tools: [], budgetUsdPerDay: 5, hours: [9, 17] })).toBeNull();
    expect(readHandoffTerms({ tools: ["shell"], budgetUsdPerDay: 5 })).toBeNull();
    expect(readHandoffTerms({ budgetUsdPerDay: 5 })).toBeNull();
    expect(handoffUnder(readHandoffTerms({ tools: [], budgetUsdPerDay: 5 })!, { agent: null, tools: ["fleet"], budgetUsd: 1 }, 0)).toEqual({ beyond: "your grant gives its runs none of its tools, not fleet" });
  });
});

describe("CBOR's budget holds for indefinite-length strings too (L8)", () => {
  test("a few MiB of empty chunks are refused by the item budget, before anything is built", () => {
    const n = 4 * 1024 * 1024;
    const bytes = new Uint8Array(n + 2);
    bytes[0] = 0x5f; // an indefinite-length byte string
    bytes.fill(0x40, 1, n + 1); // each chunk an empty definite one
    bytes[n + 1] = 0xff;
    const started = performance.now();
    expect(() => cborDecode(bytes)).toThrow(CborError);
    expect(performance.now() - started).toBeLessThan(200);
  });

  test("a few chunks, within the budget, still read whole", () => {
    expect(cborDecode(Uint8Array.of(0x5f, 0x42, 1, 2, 0x41, 3, 0xff))).toEqual(Uint8Array.of(1, 2, 3));
    expect(cborDecode(Uint8Array.of(0x7f, 0x62, 0x68, 0x69, 0x61, 0x21, 0xff))).toBe("hi!");
  });
});

describe("readQdt reads what Q-AMP's SPEC 9.3 says, and nothing else (I1)", () => {
  test("exp written as a CBOR float is refused: it is a uint", () => {
    const good = signQdt(SEED_ONE, { aud: TWO, cmd: "/tool/x", exp: 4_000_000_000 });
    // The same payload, by hand, with exp as a float64 (0xfb): a map of six entries.
    const head = cborEncode(new Map<string, unknown>([["iss", good.payload.iss], ["aud", good.payload.aud], ["sub", null], ["cmd", "/tool/x"]]));
    const float = Uint8Array.of(0xfb, ...new Uint8Array(new Float64Array([4_000_000_000]).buffer).reverse());
    const payload = Uint8Array.from([0xa6, ...head.subarray(1), ...cborEncode("exp"), ...float, ...cborEncode("nonce"), ...cborEncode(new Uint8Array(16))]);
    const signature = signEd25519(SEED_ONE, Uint8Array.from([...new TextEncoder().encode("qamp-delegation-v1\0"), ...payload]));
    const token = cborEncode(new Map<string, unknown>([["p", payload], ["s", signature]]));
    expect(() => readQdt(token)).toThrow(CborError);
    // As a uint, the same token reads, and is signed.
    expect(readQdt(good.encoded).signed).toBe(true);
  });
});

describe("where plain HTTP to a peer stays inside the tailnet (L7)", () => {
  // Tailnet addresses and names, made here from the ranges' own numbers (RFC 6598's shared range, Tailscale's MagicDNS
  // domain): none of them a real host.
  const shared = (b: number, c: number, d: number) => [100, b, c, d].join(".");
  const magic = (...labels: string[]) => [...labels, "ts", "net"].join(".");

  test("a tailnet address, a MagicDNS name or this machine: yes; any other: no", () => {
    for (const host of [shared(64, 0, 1), shared(127, 255, 254), "fd7a:115c:a1e0::1", "[fd7a:115c:a1e0:ab12::7]", "127.0.0.1", "::1", "[::1]", "localhost", magic("node", "tail1a2b")]) expect([host, onTailnetOrLoopback(host)]).toEqual([host, true]);
    for (const host of ["192.0.2.10", "198.51.100.7", "203.0.113.9", shared(128, 0, 1), shared(63, 255, 255), "fd7a:115c:a1e1::1", "node.example.test", `${magic()}.example.test`, ""]) expect([host, onTailnetOrLoopback(host)]).toEqual([host, false]);
  });
});
