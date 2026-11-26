import { parseArgs } from "node:util";
import {
  CborError,
  cborDecode,
  cborEncode,
  didKeyOfEd25519,
  goalDigest,
  HandArgs,
  HandChunk,
  HandInputChunk,
  LINK_PATHS,
  LinkCall,
  newNodeIdentity,
  ProofAttestation,
  type ProofStatement,
  proofRefusal,
  qdtChainText,
  qampEndpointOf,
  qdtChainTokens,
  readHandoffTerms,
  readQdt,
  runGrantPolicy,
  saidDigest,
  signingPublicKey,
  signProof,
  signQdt,
} from "../../packages/core/src/index.ts";
import { handleFabricTool } from "../../packages/node/src/fabric/handoff.ts";
import { Fabric } from "../../packages/node/src/fabric/service.ts";
import { FrameReader, type Invocation } from "../../packages/node/src/fabric/socket.ts";
import { transportKeyOf } from "../../packages/node/src/home.ts";
import { rng } from "../lib.ts";

/*
 * Fuzzing the fabric's decoders: whatever bytes or values arrive, each says why it refuses, in its own kind of error,
 * and nothing that was changed passes for what it wasn't. Seeded (the same seed, the same inputs) and time-bounded:
 *
 *   bun bench/fabric/fuzz.ts [--seconds 60] [--seed 20261126] [--only cbor,frames,qdt,messages,gateway,link]
 *
 *  - cbor: CBOR decoding (Q-AMP's budget): only CborError; what decodes, re-encoded, decodes to itself.
 *  - frames: the sidecar socket's framing, fed in pieces of any size: only its SidecarError; never a message past its
 *    length's bound; what is held never grows past one message's worth.
 *  - qdt: delegation tokens and chains: only errors of its own; a token whose payload or signature was changed never
 *    reads as signed by its issuer.
 *  - messages: the hand-off's messages and the proof, as JSON-shaped values: their schemas never throw; a changed proof
 *    never checks.
 *  - gateway: a VM's tool requests: any path and body, never a 5xx and never a throw.
 *  - link: the door's signed link calls (LinkCall), a profile's endpoint and its proof, a grant's terms: any value never
 *    throws, and a signed call changed in any way, or sent again, is refused; only the one sent as signed is taken.
 */

const { values } = parseArgs({ options: { seconds: { type: "string" }, seed: { type: "string" }, only: { type: "string" } } });
const SECONDS = Number(values.seconds ?? 60);
const SEED = Number(values.seed ?? 20_261_126);
const only = new Set((values.only ?? "cbor,frames,qdt,messages,gateway,link").split(","));

type Random = () => number;
const below = (r: Random, n: number) => Math.floor(r() * n);

function mutate(r: Random, input: Uint8Array): Uint8Array {
  let out = Uint8Array.from(input);
  const ops = 1 + below(r, 4);
  for (let i = 0; i < ops; i++) {
    const op = below(r, 6);
    if (op === 0 && out.length) {
      const at = below(r, out.length);
      out[at] = out[at]! ^ (1 << below(r, 8));
    } else if (op === 1 && out.length) out[below(r, out.length)] = below(r, 256);
    else if (op === 2) out = out.slice(0, below(r, out.length + 1));
    else if (op === 3) {
      const at = below(r, out.length + 1);
      const extra = new Uint8Array(1 + below(r, 8)).map(() => below(r, 256));
      out = Uint8Array.from([...out.subarray(0, at), ...extra, ...out.subarray(at)]);
    } else if (op === 4 && out.length > 1) {
      const a = below(r, out.length);
      const b = below(r, out.length);
      out.copyWithin(a, b, Math.min(out.length, b + 1 + below(r, 8)));
    } else if (op === 5) {
      // An interesting byte: CBOR's heads for lengths, tags, floats, indefinite items.
      const interesting = [0x18, 0x19, 0x1a, 0x1b, 0x1f, 0x5f, 0x7f, 0x9f, 0xbf, 0xc0, 0xd8, 0xf7, 0xf9, 0xfa, 0xfb, 0xff];
      if (out.length) out[below(r, out.length)] = interesting[below(r, interesting.length)]!;
    }
  }
  return out;
}

const randomBytes = (r: Random, max: number) => new Uint8Array(below(r, max + 1)).map(() => below(r, 256));

/** A JSON-shaped value, sometimes near the shapes a schema wants. */
function randomValue(r: Random, depth = 0): unknown {
  const pick = below(r, depth > 3 ? 6 : 9);
  if (pick === 0) return null;
  if (pick === 1) return r() < 0.5;
  if (pick === 2) return below(r, 3) === 0 ? r() * 1e12 - 5e11 : below(r, 1_000_000_000);
  if (pick === 3) return ["", "h_AAAAAAAAAAAAAAAAAAAAAA", "task-abcdefghijkl", "qdt1.gA", "did:key:z6Mk", "stop", "chain", "accepted", "trail", "state", "x".repeat(below(r, 5000))][below(r, 11)];
  if (pick === 4) return Number.NaN;
  if (pick === 5) return "😀\u0000\ud800";
  if (pick === 6) return Array.from({ length: below(r, 5) }, () => randomValue(r, depth + 1));
  const keys = ["kind", "task", "agent", "run", "at", "text", "status", "chain", "handoff", "nonce", "goal", "title", "gates", "tools", "budgetUsd", "statement", "sig", "v", "by", "for", "proof", "__proto__", "constructor"];
  return Object.fromEntries(Array.from({ length: below(r, 6) }, () => [keys[below(r, keys.length)]!, randomValue(r, depth + 1)]));
}

interface Campaign {
  name: string;
  /** One input: throws only to say the property broke. */
  one(r: Random): void | Promise<void>;
}

const campaigns: Campaign[] = [];

// ---- cbor ----
{
  const seeds = [cborEncode({ t: "invoke", task: 3, tool: "invincible/link/sync", args: { have: { n_x: "0000001" } }, chain: [{ id: "ab", exp: 1 }], input: false }), cborEncode([new Uint8Array(16), -1, 2 ** 40, 1.5, { k: null }]), cborEncode({ t: "chunk", id: 9, value: { kind: "trail", at: 1, text: "Gate 1/1 · exit 0" } })];
  campaigns.push({
    name: "cbor",
    one(r) {
      const bytes = below(r, 4) === 0 ? randomBytes(r, 64) : mutate(r, seeds[below(r, seeds.length)]!);
      let value: unknown;
      try {
        value = cborDecode(bytes);
      } catch (error) {
        if (error instanceof CborError) return;
        throw error;
      }
      const again = cborDecode(cborEncode(value));
      if (JSON.stringify(again, (_k, v) => (typeof v === "bigint" ? `${v}n` : v instanceof Uint8Array ? [...v] : v)) !== JSON.stringify(value, (_k, v) => (typeof v === "bigint" ? `${v}n` : v instanceof Uint8Array ? [...v] : v))) throw new Error("what decoded didn't decode to itself once encoded again");
    },
  });
}

// ---- frames ----
{
  const frame = (m: unknown) => {
    const body = cborEncode(m);
    const out = new Uint8Array(4 + body.length);
    new DataView(out.buffer).setUint32(0, body.length);
    out.set(body, 4);
    return out;
  };
  const stream = Uint8Array.from([...frame({ t: "hello", api: 1, did: "did:key:z6Mk", key_type: "ed25519", version: "0.2.0" }), ...frame({ t: "pong", id: 1 }), ...frame({ t: "chunk", id: 2, text: "x".repeat(300) })]);
  campaigns.push({
    name: "frames",
    one(r) {
      const bytes = below(r, 5) === 0 ? randomBytes(r, 256) : mutate(r, stream);
      const reader = new FrameReader();
      let at = 0;
      try {
        while (at < bytes.length) {
          const piece = 1 + below(r, 64);
          const messages = reader.push(bytes.subarray(at, at + piece));
          at += piece;
          for (const m of messages) if (typeof m.t !== "string") throw new Error("a message without a type passed");
          if (reader.held > bytes.length) throw new Error("it holds more than it was given");
        }
      } catch (error) {
        if ((error as Error).name === "SidecarError") return;
        throw error;
      }
    },
  });
}

// ---- qdt ----
{
  const seed1 = new Uint8Array(32).fill(1);
  const seed2 = new Uint8Array(32).fill(2);
  // (Test keys only: the seeds 01…01 and 02…02 of Q-AMP's SPEC A.2, each the other's audience.)
  const one = signQdt(seed1, { aud: didKeyOfEd25519(signingPublicKey(seed2)), cmd: "/tool/invincible/agent", exp: 4_102_444_800, pol: runGrantPolicy("h_AAAAAAAAAAAAAAAAAAAAAA") });
  const two = signQdt(seed2, { aud: didKeyOfEd25519(signingPublicKey(seed1)), cmd: "/tool/invincible/agent/fleet", exp: 4_102_444_800 });
  const pairOf = (encoded: Uint8Array) => {
    const env = cborDecode(encoded) as { p: Uint8Array; s: Uint8Array };
    return `${Buffer.from(env.p).toString("hex")}:${Buffer.from(env.s).toString("hex")}`;
  };
  const originals = new Set([pairOf(one.encoded), pairOf(two.encoded)]);
  const chain = qdtChainText([one.encoded, two.encoded]);
  campaigns.push({
    name: "qdt",
    one(r) {
      if (below(r, 3) === 0) {
        // A chain's text, changed.
        const chars = [...chain];
        for (let i = 1 + below(r, 3); i > 0; i--) chars[below(r, chars.length)] = "ABCDEFabcdef0123456789-_.qdt1!"[below(r, 31)]!;
        try {
          for (const token of qdtChainTokens(chars.join("").slice(0, below(r, 2) ? chars.length : below(r, chars.length)))) readQdt(token);
        } catch (error) {
          if (error instanceof Error && (error.name === "CborError" || error.name === "Error")) return;
          throw error;
        }
        return;
      }
      const bytes = mutate(r, below(r, 2) ? one.encoded : two.encoded);
      let read: ReturnType<typeof readQdt>;
      try {
        read = readQdt(bytes);
      } catch (error) {
        if (error instanceof Error && (error.name === "CborError" || error.name === "Error")) return;
        throw error;
      }
      if (read.signed && !originals.has(pairOf(bytes))) throw new Error("a changed token read as signed by its issuer");
    },
  });
}

// ---- messages ----
{
  const runner = newNodeIdentity();
  const giver = newNodeIdentity();
  const goal = "Make the gate pass";
  const statement: ProofStatement = { v: 1, by: runner.id, for: giver.id, handoff: "h_AAAAAAAAAAAAAAAAAAAAAA", nonce: "n".repeat(22), task: "task-abcdefghijkl", run: null, goal: goalDigest(goal), gates: ["true"], status: "done", verified: true, ended: "done", proof: { before: [1], after: [0], review: "pass", sameModel: false }, startedAt: 1, endedAt: 2, said: saidDigest("done", null) };
  const good = signProof(runner, statement);
  const expect_ = { by: runner.id, for: giver.id, handoff: statement.handoff, nonce: statement.nonce, goal, gates: ["true"], active: () => true };
  if (proofRefusal(good, expect_) !== null) throw new Error("the genuine proof doesn't check");
  const changeOne = (r: Random, value: unknown): unknown => {
    if (!value || typeof value !== "object") return randomValue(r);
    const copy: Record<string, unknown> = Array.isArray(value) ? ([...value] as never) : { ...(value as Record<string, unknown>) };
    const keys = Object.keys(copy);
    const key = keys[below(r, keys.length)]!;
    copy[key] = below(r, 3) === 0 ? randomValue(r) : changeOne(r, copy[key]);
    return copy;
  };
  campaigns.push({
    name: "messages",
    one(r) {
      const value = randomValue(r);
      for (const schema of [HandChunk, HandInputChunk, HandArgs, ProofAttestation]) schema.safeParse(value);
      const changed = changeOne(r, good);
      if (JSON.stringify(changed) !== JSON.stringify(good) && proofRefusal(changed, expect_) === null) throw new Error(`a changed proof checked: ${JSON.stringify(changed).slice(0, 300)}`);
      proofRefusal(value, expect_);
    },
  });
}

// ---- gateway ----
{
  const ctx = { tokens: { liveLabel: (t: string) => (t === "gw_ok" ? "sandbox:0a1b2c3d4e" : null) }, handoffs: { callGiver: async () => ({ status: 200, body: { ok: true } }) } };
  const paths = ["/fabric/tool/fleet", "/fabric/tool/", "/fabric/tool/a/b", "/fabric/tool/%2e%2e", "/fabric/tool/fleet?x=1", "/fabric/tool/FLEET", "/fabric/tool/x".padEnd(300, "y")];
  campaigns.push({
    name: "gateway",
    async one(r) {
      const path = paths[below(r, paths.length)]!;
      const body = below(r, 2) ? JSON.stringify(randomValue(r)) : new TextDecoder().decode(randomBytes(r, 80));
      const res = await handleFabricTool(new Request(`http://10.89.0.1:7402${path}`, { method: below(r, 6) ? "POST" : "PUT", body, headers: below(r, 4) ? { authorization: "Bearer gw_ok" } : {} }), ctx);
      if (res.status >= 500) throw new Error(`a ${res.status} for ${path}`);
    },
  });
}

// ---- link ----
{
  const node = newNodeIdentity();
  const key = transportKeyOf(new Uint8Array(32).fill(9), node.id);
  const peer = { id: node.id, name: "peer", kind: "node", role: "full", box: null, scopes: [], enrolledBy: node.id, enrolledHlc: "0", revokedHlc: null, profile: { endpoint: "http://127.0.0.1:1", caps: { qamp: { did: key.did, address: `qamp://${key.did}@127.0.0.1:7410`, pop: key.pop } } } };
  const store = { onApplied: () => () => {}, devices: () => [peer], activeDevice: (id: string) => (id === node.id ? peer : null), profilesOf: () => [] };
  const answered = { events: [], more: false };
  // The door is another node's; the calls are the peer's own, sealed as its node seals them.
  const fabric = new Fabric({ store: store as never, identity: newNodeIdentity(), sidecar: { client: null } as never, log: () => {}, presence: async () => ({}) as never });
  const sealer = new Fabric({ store: store as never, identity: node, sidecar: { client: null } as never, log: () => {}, presence: async () => ({}) as never });
  // Sync's answer is stood in for: what is checked here is the door, before anything is read.
  (fabric as unknown as { deps: { store: unknown } }).deps.store = { ...store, eventsSince: () => answered };
  const knock = (args: unknown): Promise<"taken" | "refused" | "other"> =>
    new Promise((resolve) => {
      const timer = setTimeout(() => resolve("other"), 1_000);
      const said = (verdict: "taken" | "refused" | "other") => {
        clearTimeout(timer);
        resolve(verdict);
      };
      const inv = { task: 1, tool: "invincible/link/sync", args, caller: key.did, authorization: { kind: "public" }, chain: [], meta: null, deadlineMs: null, input: false, signal: new AbortController().signal, inputs: { [Symbol.asyncIterator]: () => ({ next: async () => ({ done: true, value: undefined }) }) }, emit() {}, progress() {}, complete: () => said("taken"), fail: (code: number) => said(code === 3 ? "refused" : "other") } as unknown as Invocation;
      fabric.door(inv);
    });
  const fields = ["path", "body", "auth.device", "auth.ts", "auth.nonce", "auth.sig"] as const;
  campaigns.push({
    name: "link",
    async one(r) {
      const value = randomValue(r);
      LinkCall.safeParse(value);
      readHandoffTerms(value);
      qampEndpointOf({ qamp: value }, node.id);
      qampEndpointOf({ qamp: { ...key, address: `qamp://${key.did}@127.0.0.1:7410`, pop: typeof value === "string" ? value : key.pop.slice(0, below(r, 86)) } }, node.id);
      const sealed = await sealer.seal(LINK_PATHS.sync, { have: {} });
      // Changed in one field, by a character or a value of its own: refused, never taken.
      const field = fields[below(r, fields.length)]!;
      const changed = structuredClone(sealed) as unknown as Record<string, Record<string, unknown> | unknown>;
      const [top, sub] = field.split(".") as [string, string | undefined];
      const holder = (sub ? changed[top] : changed) as Record<string, unknown>;
      const name = sub ?? top;
      const was = String(holder[name]);
      holder[name] = below(r, 3) === 0 ? randomValue(r) : `${was.slice(0, below(r, was.length))}${String.fromCharCode(33 + below(r, 90))}${was.slice(below(r, was.length) + 1)}`;
      const sameAsSigned = JSON.stringify(changed) === JSON.stringify(sealed);
      const verdict = await knock(changed);
      if (!sameAsSigned && verdict === "taken") throw new Error(`a changed link call was taken (${field}: ${JSON.stringify(holder[name]).slice(0, 80)})`);
      if (sameAsSigned) return;
      // The call as signed, once: taken; again: refused.
      if ((await knock(sealed)) !== "taken") throw new Error("the call as it was signed was refused");
      if ((await knock(sealed)) !== "refused") throw new Error("a signed call sent twice was taken the second time");
    },
  });
}

let failed = false;
for (const campaign of campaigns) {
  if (!only.has(campaign.name)) continue;
  const r = rng(SEED ^ campaign.name.length);
  const until = performance.now() + SECONDS * 1000;
  let runs = 0;
  let failures = 0;
  let first: string | null = null;
  while (performance.now() < until) {
    for (let i = 0; i < 200; i++) {
      runs++;
      try {
        await campaign.one(r);
      } catch (error) {
        failures++;
        first ??= `${(error as Error).name}: ${(error as Error).message}`.slice(0, 400);
      }
    }
  }
  if (failures) failed = true;
  console.log(`${campaign.name.padEnd(9)} ${String(runs).padStart(10)} inputs in ${SECONDS} s · ${failures ? `${failures} FAILED, the first: ${first}` : "clean"}`);
}
process.exit(failed ? 1 : 0);
