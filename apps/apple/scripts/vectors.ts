#!/usr/bin/env bun
/*
 * The test vectors the Apple app's Swift tests read (InvincibleTests/Fixtures/core-vectors.json), made by packages/core
 * itself, so the app is held to what a node checks: base64url, the device id, request signing, canonical JSON, the
 * pairing math, which drawing an agent wears and what the agents say of each agent (the PWA's own lines). Every
 * vector is checked against core here first: a signature core would refuse never reaches the file.
 *
 * Every key in it is fake: low-entropy, made for these tests and used nowhere else.
 *
 *   bun apps/apple/scripts/vectors.ts           write the file
 *   bun apps/apple/scripts/vectors.ts --check   exit 1 if the file isn't what core makes now
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import * as core from "../../../packages/core/src/index.ts";
import { besideChip, primaryState, type AgentState } from "../../web/src/lib/agent-state.ts";
import { homePrimaryLine, homeRows, primaryNeeds, rosterRows } from "../../web/src/lib/roster.ts";
import { listLocale, listTime, timeMark } from "../../web/src/lib/time.ts";
import { ruleSentence, ruleTitle } from "../../web/src/lib/rules.ts";
import { budgetWords, meterLine, moneyWords, SETTINGS_WORDS, spentWords } from "../../web/src/lib/usage.ts";
import { askPlain, connectorLabels } from "../../web/src/lib/asks.ts";
import { handoffTerms, handoffTitle } from "../../web/src/lib/grants.ts";
import { primaryNow, needsFirst, type NowInput } from "../../web/src/lib/now.ts";
import { groupConversations, timeMarks } from "../../web/src/lib/chats.ts";
import { highlight } from "../../web/src/lib/highlight.ts";
import { parseMarkdown } from "../../web/src/lib/markdown.ts";
import { detectProvider, detectSignIn, planLine, providerSetup } from "../../web/src/lib/text.ts";
import { desktopAddress, screenPoint, shotSource } from "../../web/src/lib/desktop.ts";
import { againIn, BEHIND, BEHIND_TIMES, BEHIND_WITHIN_MS, behindAgain, behindTooOften, chunkOf, codecOf, holdEnds, LIVE_TRIES } from "../../web/src/lib/desktop-stream.ts";
import { bitsOf, readStrip, STRIP } from "../../../bench/desktop/glass-clock.ts";
import { cardWords, quickLabel, SEAT_KIND_WORDS, seatMeterWords, seatStateWords, seatUseWords, seatWindowWords, servesChoiceWords, servesWords, signInAction, UNKNOWN_KIND_WORDS, USE_ELSEWHERE } from "../../web/src/lib/seats.ts";
import { DATA_GLYPHS, dataGlyph, GLYPH_LADDER, AGENT_SPHERE, agentArcs, orbSphere, paperShades, SPHERE_FLASH, SPHERE_TURN, sphereFrame, sphereGlyph, spherePoints, sphereShades } from "../../web/src/lib/orb-sphere.ts";
import { ORB_TONES, orbLevel, orbPalette, orbParts, orbToneOfState } from "../../web/src/lib/orb.ts";
import { AURUM, FIELD_KEY, FIELD_RIM, fieldAt, fieldBuffer, fieldLight, fieldModel, linear, project, shadeLit, type FieldColours, type FieldOptions } from "../../web/src/lib/field.ts";
import {
  FIELD_EASE, FIELD_EMBERS, FIELD_EXPOSURE, FIELD_INK, FIELD_MOTION, FIELD_STROKE, fieldClock, fieldColours, fieldFps, fieldFrame, fieldInk, fieldInks, fieldLook, fieldMotion, fieldStep, fieldStill, fieldTone, inkOf,
  PRIMARY_FIELD, PRIMARY_BEAM, agentField, beamAt, beamLine, RIM_ANGLE, RIM_DIM, strokeLight, type FieldClock, type FieldIdentity,
} from "../../web/src/lib/field-orb.ts";
import { ORB_ARRIVE, ORB_BURST, ORB_BURST_MOTES, ORB_EASE, ORB_LONGEST_STEP, ORB_MOODS, ORB_MOTION, ORB_MOVES, ORB_STAGES, orbBursts, orbClock, orbFrame, orbMoodOfExpression, orbMoodOfState, orbRand, orbSeed, orbStep, type OrbClock, type OrbMood } from "../../web/src/lib/orb-motion.ts";
import { connectorState } from "../../web/src/lib/connector-state.ts";
import { noticeFrom } from "../../web/src/lib/notices.ts";
import { PRESETS, SIGN_INS } from "../../../packages/models/src/providers.ts";
import { applePayload } from "../../../packages/node/src/apns-send.ts";
import { CLONE_TIMEOUT, GIT_TIMEOUT } from "../../../packages/node/src/project-git.ts";
import { againGoal, timeline, timelineTasks } from "../../web/src/lib/timeline.ts";
import { activityLine, activityOf, activityOthers, activityShort } from "../../web/src/lib/live-activity.ts";
import { describeTask } from "../../web/src/lib/loops.ts";
import { describeWakes } from "../../web/src/lib/wakes.ts";
import { givenLine, keptChanges, proposedLine, sensitiveLine, shippedLine, steppedLine, taskActions, taskBadge, taskEnd, taskWord } from "../../web/src/lib/task-card.ts";
import { agentModelChoices, agentModelsLine, agentRoleLine, agentRoles, type AgentRoleSpec, agentWorksOn, removalPlan, teamSpeaker, agentId, toggleAgentModel } from "../../web/src/lib/team.ts";
import { budgetFrom } from "../../web/src/lib/give.ts";
import { applyEvent, ASIDE_ANSWERING, ASIDE_FAILED, ASIDE_NOTHING_YET, asideNote, asideOf, asidePlaceholder, BRING_BACK_FAILED, beginTurn, broughtBackWords, busyPlaceholder, composerAction, endTurn, failTurn, FILES_WAIT, JUST_STARTING, keptDiffers, NOT_KEPT, queueHead, shownAgain, steeringLine, turnOf, undeliveredWords } from "../../web/src/lib/turns.ts";
import { chatStateWords } from "../../../packages/core/src/turns.ts";
import { atAGlance, attended, byAttention, doingNow, failedGate, inboxBeyond, inProject, NEW_FOR_MS, projectBadge, projectKey, seenOnOpen, shortSpan, spentSince, type Attended } from "../../web/src/lib/work.ts";
import { commandKind, costWords, factsOfRecord, gateRows, judgedWith, liveStep, proofOf, reviewOf, sameModelReview, stepGroups, steersOf, summaryWords, verdictOf, workedFor, workSummary, proofLine } from "../../web/src/lib/steps.ts";
import { judgedLine, neverReached, STEER_WORDS, steerAction, steerHint, steersWaiting } from "../../web/src/lib/steer.ts";
import { MARK_BOX, MARK_POLYGON, MARK_RECTS } from "../../../scripts/mark.ts";
import { GAP_MS, HELLO_WAIT_MS, liveLink, RETRY_FIRST_MS, RETRY_MAX_MS, SILENT_MS, STEADY_MS } from "../../web/src/lib/live-link.ts";

// The chats list groups at midnight: UTC here, and in the Swift tests, whatever this machine's own zone is.
process.env.TZ = "UTC";
const OUT = join(import.meta.dir, "../InvincibleTests/Fixtures/core-vectors.json");
// The noble the core is built on (its own dependency), for the one thing core leaves to the browser: signing as a phone.
const { p256 } = (await import(Bun.resolveSync("@noble/curves/nist.js", join(import.meta.dir, "../../../packages/core/src")))) as typeof import("../../../packages/core/node_modules/@noble/curves/nist.js");

const { b64u, utf8, fromUtf8 } = core;
const fail = (what: string): never => {
  throw new Error(`vectors: ${what}`);
};
const hex = (bytes: Uint8Array): string => [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
const bytesOf = (...values: number[]): Uint8Array => new Uint8Array(values);

// ---- base64url ----------------------------------------------------------------------------------------------------
const base64url = {
  encode: [bytesOf(), bytesOf(0), bytesOf(0, 1), bytesOf(0, 1, 2), bytesOf(0xfb, 0xff), bytesOf(0xfb, 0xff, 0xbf), bytesOf(0x3e, 0x3f, 0xfe, 0xff), utf8("Invincible")].map((bytes) => ({ hex: hex(bytes), b64u: b64u(bytes) })),
  decode: ["", "AA", "AAE", "AAEC", "-_8", "A", "AB+C", "AB/C", "AB==", "AB C", "ABCDE"].map((text) => {
    try {
      return { text, hex: hex(core.fromB64u(text)) };
    } catch {
      return { text, hex: null };
    }
  }),
};

// ---- the device: a fake P-256 key, its id, and the id the PWA's WebCrypto export gives -------------------------------
const scalar = new Uint8Array(32).fill(0x11);
const publicKey = p256.getPublicKey(scalar, false);
const device = core.clientIdFromKey(publicKey);
if (!core.isClientId(device)) fail("the fake device id isn't a client id");
// The PWA takes its id from WebCrypto's raw export: the same 65 bytes (0x04, x, y).
const jwk = { kty: "EC", crv: "P-256", x: b64u(publicKey.slice(1, 33)), y: b64u(publicKey.slice(33)), ext: true };
const webKey = await crypto.subtle.importKey("jwk", jwk, { name: "ECDSA", namedCurve: "P-256" }, true, ["verify"]);
if (core.clientIdFromKey(new Uint8Array(await crypto.subtle.exportKey("raw", webKey))) !== device) fail("WebCrypto's raw export gives another id");
// And what WebCrypto signs (IEEE P1363 r||s, as the PWA sends it) is what core verifies.
const webPrivate = await crypto.subtle.importKey("jwk", { ...jwk, d: b64u(scalar) }, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
const webSigned = new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, webPrivate, utf8("probe")));
if (webSigned.length !== 64 || !core.verifyDeviceSignature(device, webSigned, utf8("probe"))) fail("core doesn't verify what WebCrypto signs");

// ---- request signing ------------------------------------------------------------------------------------------------
const ORDER = p256.Point.Fn.ORDER;
const requests = [
  { method: "GET", path: "/api/whoami", ts: "1763200000000", nonce: b64u(bytesOf(0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11)), body: "" },
  { method: "GET", path: "/api/team?probe=1", ts: "1763200000001", nonce: "nonce-for-tests1", body: "" },
  { method: "post", path: "/api/chat", ts: "1763200000002", nonce: "AAAAAAAAAAAAAAAA", body: JSON.stringify({ role: "planner", save: true, messages: [{ role: "user", content: "Hvad så, Invincible? 🛡️ «quoted» \\ \n" }] }) },
  { method: "POST", path: "/api/secrets", ts: "1763200000003", nonce: "_-_-_-_-_-_-_-_-", body: JSON.stringify({ name: "github-token", value: "not-a-real-key" }) },
].map((request) => {
  const body = utf8(request.body);
  const input = core.requestSigningInput(request.method, request.path, request.ts, request.nonce, body);
  const signature = p256.sign(input, scalar);
  const parsed = p256.Signature.fromBytes(signature, "compact");
  const high = new p256.Signature(parsed.r, ORDER - parsed.s);
  const highS = high.toBytes("compact");
  const der = parsed.toBytes("der");
  if (!core.verifyDeviceSignature(device, signature, input)) fail(`core refuses the signature for ${request.path}`);
  if (!core.verifyDeviceSignature(device, highS, input)) fail(`core refuses the high-S form for ${request.path}`);
  if (core.verifyDeviceSignature(device, der, input)) fail(`core takes a DER signature for ${request.path}: the format note is wrong`);
  const headers = { [core.AUTH.device]: device, [core.AUTH.ts]: request.ts, [core.AUTH.nonce]: request.nonce, [core.AUTH.sig]: b64u(signature) };
  const proof = core.verifyRequestSignature(new Headers(headers), request.method, request.path, body, Number(request.ts));
  if (proof?.device !== device || proof.nonce !== request.nonce) fail(`core's verifier refuses the headers for ${request.path}`);
  return {
    ...request,
    bodySha256: core.sha256B64u(body),
    signingInput: fromUtf8(input),
    signature: b64u(signature),
    signatureHighS: b64u(highS),
    signatureDer: b64u(der),
    headers,
  };
});

// ---- a request for one node, and that node's proof of its id (the slice 8 note's item 11) ----------------------------
// What a device signs names the node it is for (v2: its id, last in what is signed), so another node refuses it; the
// device learns that id from whoami, which proves it: the node's Ed25519 signature of the device's challenge.
const theNode = core.nodeIdentity(new Uint8Array(32).fill(7), new Uint8Array(32).fill(9));
const anotherNode = core.nodeIdentity(new Uint8Array(32).fill(8), new Uint8Array(32).fill(10));
const requestsForNode = requests.map((request) => {
  const body = utf8(request.body);
  const input = core.requestSigningInput(request.method, request.path, request.ts, request.nonce, body, theNode.id);
  const signature = p256.sign(input, scalar);
  const headers = { [core.AUTH.device]: device, [core.AUTH.ts]: request.ts, [core.AUTH.nonce]: request.nonce, [core.AUTH.sig]: b64u(signature) };
  if (core.verifyRequestSignature(new Headers(headers), request.method, request.path, body, Number(request.ts), theNode.id)?.named !== true) fail(`core refuses the request for its node at ${request.path}`);
  if (core.verifyRequestSignature(new Headers(headers), request.method, request.path, body, Number(request.ts), anotherNode.id) !== null) fail(`another node takes the request for ${theNode.id} at ${request.path}`);
  return { method: request.method, path: request.path, ts: request.ts, nonce: request.nonce, body: request.body, node: theNode.id, signingInput: fromUtf8(input), signature: b64u(signature), headers };
});
const nodeProofs = ["c2xpY2UtOC1jaGFsbGVuZ2U", "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"].map((challenge) => {
  const proof = b64u(theNode.sign(core.nodeProofInput(challenge)));
  if (!core.verifyNodeProof(theNode.id, challenge, proof) || core.verifyNodeProof(anotherNode.id, challenge, proof)) fail(`core's node proof for ${challenge} isn't the node's alone`);
  return { node: theNode.id, anotherNode: anotherNode.id, challenge, signingInput: fromUtf8(core.nodeProofInput(challenge)), proof };
});
// What a whoami's answer says of the node, against the one pinned, as core judges it (judgeNodeProof): the answers as a
// node sends them, the malformed ones too (the review of apps-name-node, I1), with no pin and with one, a moment before
// the cutoff and at it. Each app reads the same bytes and gives the same verdict.
const judgedNodeProofs = (() => {
  const challenge = "c2xpY2UtOC1jaGFsbGVuZ2U";
  const proofBy = (who: typeof theNode, asked = challenge) => b64u(who.sign(core.nodeProofInput(asked)));
  const proof = proofBy(theNode);
  // The same signature with its last character's unused bits set: base64url written another way.
  const respelled = proof.slice(0, -1) + "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_"[("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_".indexOf(proof.at(-1)!) | 1)];
  const identity = new Uint8Array(32);
  identity[0] = 1;
  const universal = new Uint8Array(64);
  universal.set(identity, 0);
  const whoami = (fields: Record<string, unknown>) => JSON.stringify({ device, kind: "client", scopes: ["mind:read"], nodeName: "test node", fleet: "f_test", fleetName: null, ...fields });
  const answers: [string, string][] = [
    ["proven", whoami({ node: theNode.id, proof })],
    ["proven to be another", whoami({ node: anotherNode.id, proof: proofBy(anotherNode) })],
    ["no proof", whoami({ node: theNode.id })],
    ["no proof, nor any node", whoami({})],
    ["a proof by another key", whoami({ node: theNode.id, proof: proofBy(anotherNode) })],
    ["a proof of another challenge", whoami({ node: theNode.id, proof: proofBy(theNode, "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA") })],
    ["a proof written another way", whoami({ node: theNode.id, proof: respelled })],
    ["the proof null", whoami({ node: theNode.id, proof: null })],
    ["the proof a number", whoami({ node: theNode.id, proof: 5 })],
    ["a proof and no node", whoami({ proof })],
    ["a node that isn't a string", whoami({ node: 7, proof })],
    ["the identity's universal forgery", whoami({ node: `n_${b64u(identity)}`, proof: b64u(universal) })],
  ];
  const cases = [];
  for (const [what, answer] of answers) {
    for (const pinned of [null, theNode.id]) {
      for (const now of [core.REQUESTS_NAME_THEIR_NODE_FROM - 1, core.REQUESTS_NAME_THEIR_NODE_FROM]) {
        const judged = core.judgeNodeProof(pinned ?? undefined, JSON.parse(answer), challenge, now);
        cases.push({ what, answer, pinned, challenge, now, judged });
      }
    }
  }
  const kinds = new Set(cases.map((c) => c.judged.kind));
  for (const kind of ["pin", "same", "other", "older", "false"]) if (!kinds.has(kind as never)) fail(`the judged proofs hold no "${kind}"`);
  return cases;
})();

// ---- your word, signed (slice 8a): the statement a device of yours signs for each word of yours, as core makes it -----
// Each app builds these bytes and signs them with the key it already has (8c): the statement's six fields as canonical
// JSON after the domain, the body's digest as SHA-256 of its canonical JSON. Every signature here is the fake device's,
// checked against core first, and refused for any field changed.
const words = (() => {
  const fleet = b64u(new Uint8Array(32).fill(0x2a));
  const cases = [
    { kind: "rule.set", body: { name: "quiet", rule: { after: "22:00", until: "07:00" } }, nonce: "nonce-for-words1", at: 1_797_206_400_000 },
    { kind: "action.decided", body: { id: `a_${"A".repeat(22)}`, verdict: "approved", note: "Hvad så? 🛡️ «quoted» \\ \n" }, nonce: b64u(bytesOf(0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11)), at: 4_102_444_800_001 },
    { kind: "price.set", body: { model: "stand-in/model", price: { output: 2.5, input: 0.125 } }, nonce: "_-_-_-_-_-_-_-_-", at: 0 },
  ].map(({ kind, body, nonce, at }) => {
    const statement = { v: 1 as const, fleet, kind, digest: core.wordDigest(body), nonce, at };
    const input = core.wordSigningInput(statement);
    const signature = b64u(p256.sign(input, scalar));
    if (!core.verifyWordSignature(device, signature, statement)) fail(`core refuses the word's signature for ${kind}`);
    for (const changed of [{ fleet: b64u(new Uint8Array(32).fill(0x2b)) }, { kind: `${kind}x` }, { digest: core.wordDigest({ ...body, extra: 1 }) }, { nonce: `${nonce}x` }, { at: at + 1 }]) {
      if (core.verifyWordSignature(device, signature, { ...statement, ...changed })) fail(`core takes the word's signature for ${kind} with ${Object.keys(changed)[0]} changed`);
    }
    return { kind, body, bodyCanonical: core.canonical(body), statement, signingInput: fromUtf8(input), device, signature };
  });
  return {
    domain: core.WORD_DOMAIN,
    signedFrom: core.WORDS_SIGNED_FROM,
    skewMs: core.WORD_SKEW_MS,
    nonce: core.WORD_NONCE.source,
    scopes: core.WORD_SCOPES,
    cases,
  };
})();

// ---- Ed25519's strict rule (the lead's word of 27 November 2026): RFC 8032's test vectors and all of Wycheproof's -------
// Each with the rule's answer as core gives it (verifyEd25519Strict), and whether its key and its R are points the rule
// takes (strictEd25519Point): the apps hold their verifiers to these, so TS, Swift and Kotlin answer alike on every one.
// The fixtures are others' as they are (NOTICE): Wycheproof's testvectors_v1/ed25519_test.json, and RFC 8032's §7.1.
// Every RFC vector and every one Wycheproof marks valid holds; every one it marks invalid, and every small-order or
// mixed-order key it calls acceptable, doesn't.
const fixture = (name: string) => JSON.parse(readFileSync(join(import.meta.dir, "../InvincibleTests/Fixtures", name), "utf8")) as unknown;
const hexBytes = (text: string): Uint8Array => Uint8Array.from(text.match(/../g) ?? [], (b) => parseInt(b, 16));
const rfc8032 = fixture("rfc8032-ed25519.json") as { name: string; publicKey: string; message: string; signature: string }[];
const wycheproof = fixture("wycheproof-ed25519.json") as { testGroups: { publicKey: { pk: string }; tests: { tcId: number; msg: string; sig: string; result: "valid" | "invalid" | "acceptable" }[] }[] };
const ed25519 = [
  ...rfc8032.map((t) => ({ source: `RFC 8032 ${t.name}`, key: t.publicKey, msg: t.message, sig: t.signature, said: "valid" })),
  ...wycheproof.testGroups.flatMap((group) => group.tests.map((t) => ({ source: `Wycheproof tc${t.tcId}`, key: group.publicKey.pk, msg: t.msg, sig: t.sig, said: t.result }))),
].map((v) => {
  const sig = hexBytes(v.sig);
  const valid = core.verifyEd25519Strict(sig, hexBytes(v.msg), hexBytes(v.key));
  if (valid !== (v.said === "valid")) fail(`the strict rule says ${valid} of ${v.source}, which is ${v.said}`);
  return { source: v.source, key: v.key, msg: v.msg, sig: v.sig, valid, keyStrict: core.strictEd25519Point(hexBytes(v.key)), rStrict: sig.length === 64 && core.strictEd25519Point(sig.subarray(0, 32)) };
});
if (ed25519.length !== 5 + 210) fail(`${ed25519.length} Ed25519 vectors, not RFC 8032's 5 and Wycheproof's 210`);

// ---- canonical JSON (what the pairing proof is a MAC over) -----------------------------------------------------------
const canonical = [
  { kind: "client", name: "Invincible app on iPhone", invite: "abc", device: "c_x" },
  { b: "quote \" backslash \\ slash /", a: "tab \t newline \n return \r backspace \b formfeed \f" },
  { z: "nul \u0000 one \u0001 unit separator \u001f delete \u007f", y: "line   paragraph  " },
  { name: "Will’s “iPad” æøå 🛡️", Name: "upper sorts first", "": "empty key" },
].map((value) => ({ value, canonical: core.canonical(value) }));

// ---- pairing ---------------------------------------------------------------------------------------------------------
const secretText = "fake-invite-secret-for-tests-001";
const secret = utf8(secretText);
if (secret.length !== 32) fail("the fake invite secret isn't 32 bytes");
const fleet = b64u(core.sha256Bytes(utf8("a fake fleet, for tests")));
const invite = core.Invite.parse({ v: 1, e: "http://127.0.0.1:7777", f: fleet, i: b64u(utf8("fake-invite-id01")), s: b64u(secret), k: "client" });
const token = core.encodeInvite(invite);
const rawToken = (value: unknown): string => `gi1.${b64u(utf8(JSON.stringify(value)))}`;
const decodeCases = [
  token,
  `http://127.0.0.1:7778/#pair=${token}`,
  `  https://keep.example.test/#pair=${token}\n`,
  `https://keep.example.test/?pair=${token}`,
  `https://keep.example.test/#x=1&pair=${token}`,
  rawToken({ ...invite, k: "node" }),
  rawToken({ ...invite, e: "https://keep.example.test" }),
  `gi2.${token.slice(4)}`,
  rawToken({ ...invite, x: 1 }),
  rawToken({ v: 1, e: invite.e, f: invite.f, i: invite.i, k: invite.k }),
  rawToken({ ...invite, v: 2 }),
  rawToken({ ...invite, e: "not a url" }),
  rawToken({ ...invite, f: "too-short" }),
  rawToken({ ...invite, k: "phone" }),
  rawToken({ ...invite, s: "not base64url!" }),
  `gi1.${b64u(utf8("not json"))}`,
  "gi1.@@@",
  "hello",
  "",
].map((text) => {
  try {
    return { text, invite: core.decodeInvite(text) };
  } catch {
    return { text, invite: null };
  }
});
const names = ["Invincible app on iPhone", "Will’s “iPad” \\ 🛡️"];
const proofs = names.map((name) => {
  const fields: core.PairRequestFields = { invite: invite.i, device, name, kind: "client" };
  if (!core.PairRequestFields.safeParse(fields).success) fail(`the pairing fields for ${name} don't parse`);
  return { name, canonical: core.canonical(fields), proof: core.pairProof(secret, fields) };
});
// More codes, one of them led by a zero (the code keeps it: "048 213", never "48 213").
const codes: { fleet: string; device: string; sas: string }[] = [];
for (let n = 0; codes.length < 6 || !codes.some((code) => code.sas.startsWith("0")); n++) {
  const sas = core.sasCode(secret, `fleet-${n}`, device);
  if (codes.length < 6 || sas.startsWith("0")) codes.push({ fleet: `fleet-${n}`, device, sas });
}
const pairing = {
  secretText,
  invite,
  token,
  url: `http://127.0.0.1:7778/#pair=${token}`,
  decode: decodeCases,
  device,
  proofs,
  sas: core.sasCode(secret, invite.f, device),
  codes,
  statusProof: core.statusProof(secret, invite.i, device),
  approvalProof: core.approvalProof(secret, invite.i, device, invite.f),
};

// ---- a profile from before the orbs (v 1): it colours nothing ----------------------------------------------------------
const profile = (color: string, extra: Record<string, unknown> = {}) => ({ v: 1, form: "armored", color, accent: "#2fa36b", eyes: "oval", accessory: "none", temperament: "calm", ...extra });
// ---- an agent's orb's colours (core's agentColors): the one you chose for it, or its handle's ---------------------------
const agentOrbs = {
  tints: core.AGENT_TINTS,
  names: core.AGENT_TINT_NAMES,
  agents: [
    { id: "ada" },
    { id: "lin" },
    { id: "coder" },
    { id: "" },
    { id: "Will’s “iPad” \\ 🛡️" },
    { id: "x6", avatar: profile("#4f8fe0") },
    { id: "x7", avatar: { v: 2, color: "#3ABEFF" } },
    { id: "x8", avatar: { v: 2, color: "#123456" } },
    { id: "x9", avatar: { v: 2, color: "blue" } },
    { id: "x10", avatar: { v: 2, color: "#3abeff", form: "round" } },
    { id: "x11", avatar: { v: "2", color: "#3abeff" } },
    { id: "x12", avatar: { v: 2, color: "#000000" } },
    { id: "x13", avatar: { v: 2, color: "#ffffff" } },
  ].map((agent) => ({ ...agent, colors: core.agentColors(agent.id, agent.avatar) })),
  seeds: ["", "a", "foobar", "coder", "Will’s “iPad” \\ 🛡️"].map((id) => ({ id, seed: core.handleSeed(id) })),
  blends: ([["#000000", "#ffffff", 0.5], ["#3abeff", "#ffffff", 0.45], ["#3abeff", "#000000", 0.52], ["#fe879c", "#0a0b0c", 1 / 3], ["#123456", "#fedcba", 2 / 3], ["#050505", "#fafafa", 0.55]] as [string, string, number][]).map(([from, to, t]) => ({ from, to, t, blend: core.blendHex(from, to, t) })),
  nearest: ["#000000", "#ffffff", "#ff8d65", "#3abeff", "#808080", "#00ff00", "#FE879C"].map((color) => ({ color, at: core.nearestTint(color) })),
};

// ---- the team's lines (the PWA's own roster) ----------------------------------------------------------------------
const NOW = 1763200000000;
const at = (minutesAgo: number) => NOW - minutesAgo * 60_000;
const agent = (id: string, name: string, extra: Partial<core.Agent> = {}): core.Agent => ({
  id, name, instructions: `${name} keeps the build green.\nA second line nobody shows.`, role: "engineer", harness: "native", enabled: true, dailyTurns: 40, turnsToday: 3,
  repository: null, workspaceNode: null, workspace: null, memory: "", createdAt: at(600), updatedAt: at(600), ...extra,
});
const task = (id: string, assignee: string, status: core.TeamWorkStatus, extra: Partial<core.TeamTask> = {}): core.TeamTask => ({
  id: `task-${id.padEnd(12, "0")}`, room: `dm-${assignee}`, assignee, title: `The ${id} task`, goal: "Do it well.", dependsOn: [], gates: [], status, verified: false,
  progress: "", output: "", error: null, chainId: `chain-${id}`, createdAt: at(90), updatedAt: at(30), ...extra,
});
const delivery = (id: string, agent: string, status: core.TeamWorkStatus, extra: Partial<core.TeamDelivery> = {}): core.TeamDelivery => ({
  id: `delivery-${id}`, room: `dm-${agent}`, agent, trigger: "message", chainId: `chain-d-${id}`, status, error: null, createdAt: at(20), updatedAt: at(10), ...extra,
});
const direct = (id: string): core.TeamRoom => ({ id: `dm-${id}`, name: id, members: [id], direct: true, turnBudget: 3, paused: false, createdAt: at(600), updatedAt: at(5) });
const syncTask = task("sync", "ada", "done", { verified: true, updatedAt: at(50) });
const snapshot: core.TeamSnapshot = {
  agents: [
    agent("ada", "Ada"),
    agent("bea", "Bea"),
    agent("cy", "Cy"),
    agent("dot", "Dot", { enabled: false }),
    agent("eve", "Eve", { turnsToday: 40 }),
    agent("fay", "Fay"),
    agent("gus", "Gus"),
    agent("hal", "Hal", { createdBy: "primary" }),
    agent("ivy", "Ivy", { createdBy: "hal" }),
    agent("jo", "Jo", { instructions: "", role: "reviewer" }),
    agent("kit", "Kit"),
    agent("lou", "Lou"),
    agent("max", "Max"),
    agent("ned", "Ned", { enabled: false }),
    agent("oz", "Oz"),
    agent("pip", "Pip"),
    agent("quin", "Quin"),
  ],
  rooms: ["ada", "bea", "cy", "fay", "gus", "kit", "lou", "max", "ned"].map(direct),
  tasks: [
    task("run", "ada", "running", { progress: "Running · bun test packages/link\nmore" }),
    syncTask,
    task("plain", "bea", "running"),
    task("keep", "cy", "done", { verified: true, changes: { artifact: `art_${"a".repeat(22)}`, files: 3, base: "4f7a1c2e9b8d0a1f2e3c4b5a69788796a5b4c3d2" } }),
    task("fail", "fay", "failed", { error: "The gate needs a Postgres this VM doesn't have.\nDetails follow." }),
    task("wait", "gus", "queued", { dependsOn: [task("blocker", "max", "running").id] }),
    task("blocker", "max", "running", { progress: "" }),
    task("halt", "kit", "interrupted"),
    task("stop", "lou", "stopped"),
    task("held", "ned", "queued"),
    task("ask", "oz", "proposed", { proposedBy: "oz" }),
    task("ask2", "oz", "proposed", { proposedBy: "oz", updatedAt: at(40) }),
    task("askpip", "pip", "proposed", { proposedBy: "ada" }),
    // Work the primary offers an idle agent from your backlog (backlog.ts): it is named, not its id.
    task("backlog", "quin", "proposed", { proposedBy: "primary" }),
  ],
  deliveries: [delivery("busy", "bea", "running"), delivery("think", "eve", "queued"), delivery("old", "jo", "failed", { error: "Model unavailable", updatedAt: at(2) })],
};
const asks = [{ by: `arm:team.0123456789.max`, connector: "forge", tool: "post" }, { by: `arm:team.0123456789.max`, connector: "forge", tool: "bucket.delete" }, { by: "loop:morning", connector: "github", tool: "comment" }];
const rows = rosterRows({ snapshot, asks, now: NOW }).filter((row) => row.kind === "agent").map((row) => ({ id: row.id, line: row.line, plain: row.plain, needs: row.needs, expression: row.expression ?? null, state: row.state ?? "resting" }));
// Each line as it reads beside its state's chip (lib/agent-state.ts), every row's and a few that only start alike.
const besides = [
  ...rows.map((row) => ({ line: row.line, state: row.state })),
  { line: "Paused", state: "paused" }, { line: "Paused · 2 waiting", state: "paused" }, { line: "Pausedness", state: "paused" },
  // (Verified work's chip says New, and its line its verdict: neither says the other again.)
  { line: "Reviewed, not proven: “Ship it” · 3 files kept", state: "verified" }, { line: "New", state: "verified" }, { line: "Proven: “Ship it”", state: "resting" },
].map(({ line, state }) => ({ line, state, beside: besideChip(line, state as AgentState) }));
const nows: NowInput[] = [
  { turns: [], runs: [], needs: null },
  { turns: [], runs: [], needs: 0 },
  { turns: [], runs: [], needs: 1 },
  { turns: [], runs: [], needs: 3 },
  { step: null, turns: [], runs: [], needs: 2 },
  { step: "Reading packages/link/src/sync.ts", turns: [], runs: [], needs: null },
  { turns: [{ title: "The release plan" }], runs: [], needs: 1 },
  { turns: [{ title: null }], runs: [], needs: 0 },
  { turns: [], runs: [{ goal: "Make sync resume\nafter a drop" }], needs: null },
  { turns: [{ title: "A" }], runs: [{ goal: "B" }], needs: 4 },
  // Its answers you haven't read: said when nothing else is, green; what needs you and work in hand come first.
  { turns: [], runs: [], needs: 0, unread: [{ title: "The release plan" }] },
  { turns: [], runs: [], needs: null, unread: [{ title: "A" }, { title: "B" }] },
  { turns: [], runs: [], needs: 1, unread: [{ title: "A" }] },
  { turns: [{ title: "A" }], runs: [], needs: 0, unread: [{ title: "B" }] },
];
/** The list that is home on a phone (lib/roster.ts homeRows): each row by its key, the latest first, with when it last did
 * something and how much of it waits on you. */
const homeOf = (input: Parameters<typeof homeRows>[0]) => homeRows(input).map(({ key, at, count }) => ({ key, at, count }));
const agents = {
  now: NOW,
  snapshot,
  asks,
  rows,
  home: homeOf({ snapshot, asks, now: NOW }),
  besides,
  // (the primary's state from its line; the app adds its own answer being written here, which a node's line doesn't know.
  // needsFirst: its line as every app shows it, what needs you first when there is any, its tone and state the same.)
  primary: nows.map((input) => ({ input, ...primaryNow(input), state: primaryState(primaryNow(input)), needsFirst: needsFirst(input).text })),
  needs: [
    { inbox: 5, agents: snapshot.agents.map((t) => t.id), needs: primaryNeeds(5, asks, snapshot.agents.map((t) => t.id)) },
    { inbox: 1, agents: ["max"], needs: primaryNeeds(1, asks, ["max"]) },
  ],
};

// ---- the team's rooms (the PWA's own roster), in a team of their own ----------------------------------------
const inRoom = (room: string) => ({ room });
const roomsSnapshot: core.TeamSnapshot = {
  agents: [agent("ada", "Ada"), agent("bea", "Bea"), agent("cy", "Cy")],
  rooms: [
    { ...direct("ada"), updatedAt: at(1) },
    { id: "studio", name: "Studio", members: ["ada", "bea"], direct: false, turnBudget: 8, paused: false, createdAt: at(600), updatedAt: at(9) },
    { id: "pair", name: "Pair", members: ["ada", "cy"], direct: false, turnBudget: 8, paused: false, createdAt: at(600), updatedAt: at(8) },
    { id: "chatter", name: "Chatter", members: ["ada", "bea", "cy"], direct: false, turnBudget: 8, paused: false, createdAt: at(600), updatedAt: at(7) },
    { id: "talk", name: "Talk", members: ["bea"], direct: false, turnBudget: 8, paused: false, createdAt: at(600), updatedAt: at(7) },
    { id: "broken", name: "Broken", members: ["cy"], direct: false, turnBudget: 8, paused: false, createdAt: at(600), updatedAt: at(6) },
    { id: "cut", name: "Cut", members: ["cy"], direct: false, turnBudget: 8, paused: false, createdAt: at(600), updatedAt: at(5) },
    { id: "failed", name: "Failed", members: ["ada"], direct: false, turnBudget: 8, paused: false, createdAt: at(600), updatedAt: at(4) },
    { id: "gave", name: "Gave", members: ["ada"], direct: false, turnBudget: 8, paused: false, createdAt: at(600), updatedAt: at(4) },
    { id: "unsure", name: "Unsure", members: ["bea"], direct: false, turnBudget: 8, paused: false, createdAt: at(600), updatedAt: at(4) },
    { id: "held", name: "Held", members: ["ada", "bea"], direct: false, turnBudget: 8, paused: true, createdAt: at(600), updatedAt: at(3) },
    { id: "rest", name: "Rest", members: ["bea"], direct: false, turnBudget: 8, paused: true, createdAt: at(600), updatedAt: at(3) },
    { id: "quiet", name: "Quiet", members: ["ada", "bea", "gone"], direct: false, turnBudget: 8, paused: false, createdAt: at(600), updatedAt: at(2) },
    { id: "asks", name: "Asks", members: ["ada", "bea"], direct: false, turnBudget: 8, paused: false, createdAt: at(600), updatedAt: at(2) },
  ],
  tasks: [
    task("studio1", "ada", "running", inRoom("studio")),
    task("pair1", "ada", "running", inRoom("pair")),
    task("pair2", "cy", "running", inRoom("pair")),
    task("failed1", "ada", "failed", { ...inRoom("failed"), error: "No Postgres here.\nMore." }),
    // (A run's own word for how it ended, as a task keeps it: said as words.)
    task("gave1", "ada", "failed", { ...inRoom("gave"), error: "gave-up" }),
    task("unsure1", "bea", "failed", { ...inRoom("unsure"), error: "unverified" }),
    task("held1", "ada", "queued", inRoom("held")),
    task("held2", "bea", "queued", inRoom("held")),
    task("asks1", "ada", "running", inRoom("asks")),
    task("asks2", "bea", "proposed", { ...inRoom("asks"), proposedBy: "bea" }),
  ],
  deliveries: [
    delivery("c1", "ada", "running", inRoom("chatter")),
    delivery("c2", "bea", "running", inRoom("chatter")),
    delivery("t1", "bea", "running", inRoom("talk")),
    delivery("b1", "cy", "failed", { ...inRoom("broken"), error: "Model unavailable\nretry later" }),
    delivery("x1", "cy", "interrupted", inRoom("cut")),
  ],
};
const rooms = {
  snapshot: roomsSnapshot,
  rows: rosterRows({ snapshot: roomsSnapshot, asks: [], now: NOW }).filter((row) => row.kind === "room").map((row) => ({ id: row.id, line: row.line, plain: row.plain, needs: row.needs })),
  home: homeOf({ snapshot: roomsSnapshot, asks: [], now: NOW }),
};

// ---- what is new to you among the agents: what ended on an agent's page, or in a room, since you last looked --------
const seenSnapshot: core.TeamSnapshot = {
  agents: [agent("ada", "Ada"), agent("bea", "Bea"), agent("cy", "Cy"), agent("dee", "Dee"), agent("eli", "Eli"), agent("fin", "Fin")],
  rooms: [...["ada", "bea", "cy", "dee", "eli", "fin"].map(direct), { id: "forge", name: "Forge", members: ["eli", "fin"], direct: false, turnBudget: 8, paused: false, createdAt: at(600), updatedAt: at(5) }, { id: "shed", name: "Shed", members: ["fin"], direct: false, turnBudget: 8, paused: false, createdAt: at(600), updatedAt: at(5) }],
  tasks: [task("pass", "cy", "done", { verified: true, updatedAt: at(120) }), task("ran", "dee", "done", { updatedAt: at(20) }), task("fell", "fin", "failed", { updatedAt: at(10) })],
  deliveries: [
    // Its reply to you, after you last looked; one you looked at since; one in a room, which is the room's to be new in.
    delivery("reply", "ada", "done", { updatedAt: at(10) }),
    delivery("seen", "bea", "done", { updatedAt: at(10) }),
    delivery("there", "eli", "done", { room: "forge", updatedAt: at(10) }),
    delivery("old", "fin", "done", { room: "shed", updatedAt: at(40) }),
  ],
  seen: { "agent:ada": at(30), "agent:bea": at(5), "agent:dee": at(10), "room:forge": at(15), "room:shed": at(30) },
};
// ---- when, as the list that is home says it (lib/time.ts listTime): a chat app's times, its zone and locale pinned ----
const LIST_NOW = Date.UTC(2026, 10, 28, 13, 30);
const LIST_ZONE = "Europe/Copenhagen";
const LIST_LOCALE = "en-GB";
// (Single-digit days and months, whose padding differs between CLDR's versions for some regions as no rule of ours does:
// English in Denmark is 5/11/2026 in ICU 78 and 05/11/2026 in Android 16's. Pinned for en-GB alone, which agree.)
const PADDED = [Date.UTC(2026, 10, 5, 7, 0), Date.UTC(2026, 0, 2, 7, 0)];
const LIST_MOMENTS = [
  // Today there (Copenhagen is UTC + 1): the afternoon, the morning, half past midnight (still yesterday in UTC), a
  // minute ahead.
  Date.UTC(2026, 10, 28, 13, 5), Date.UTC(2026, 10, 28, 7, 4), Date.UTC(2026, 10, 27, 23, 30), Date.UTC(2026, 10, 28, 13, 31),
  // Yesterday there, at its last minute and its first.
  Date.UTC(2026, 10, 27, 22, 59), Date.UTC(2026, 10, 26, 23, 1),
  // Two and six days back; then a week back, single-digit days and months, last year, and a day ahead.
  Date.UTC(2026, 10, 26, 8, 0), Date.UTC(2026, 10, 22, 8, 0), Date.UTC(2026, 10, 21, 8, 0), ...PADDED, Date.UTC(2025, 11, 31, 22, 0),
  Date.UTC(2026, 10, 29, 8, 0),
];
// `locale` is the device's; the words are said in English with its region (listLocale), which for en-GB is its own.
// `devices`: a phone in another language, its words the app's (English), its clock and dates its region's.
const listTimes = {
  now: LIST_NOW,
  zone: LIST_ZONE,
  locale: LIST_LOCALE,
  cases: LIST_MOMENTS.map((at) => ({ at, words: listTime(at, LIST_NOW, LIST_ZONE, LIST_LOCALE) })),
  devices: ["da-DK"].map((device) => ({
    device,
    locale: listLocale(device),
    cases: LIST_MOMENTS.filter((at) => !PADDED.includes(at)).map((at) => ({ at, words: listTime(at, LIST_NOW, LIST_ZONE, device) })),
  })),
};

// ---- when a chat went on (lib/chats.ts timeMarks: which messages are marked; lib/time.ts timeMark: the mark's words), at the
// list's now and zone. `ats`: a chat's messages' times, null for one whose time isn't known (your agent's answers), which
// is never marked. Its words for a phone in British English and one in Danish (English with Denmark's clock). ----
const cphAt = (month: number, day: number, hour: number, minute: number) => Date.UTC(2026, month - 1, day, hour - 1, minute);
const MARK_ATS = [cphAt(11, 27, 9, 0), null, cphAt(11, 27, 9, 14), null, cphAt(11, 27, 9, 29), cphAt(11, 27, 23, 59), cphAt(11, 28, 0, 5), cphAt(11, 28, 0, 10), null, cphAt(11, 28, 0, 40)];
const MARK_MOMENTS = [
  cphAt(11, 28, 9, 41), cphAt(11, 28, 0, 30), cphAt(11, 27, 18, 20), cphAt(11, 27, 0, 1), cphAt(11, 24, 10, 0), cphAt(11, 22, 9, 0),
  cphAt(11, 21, 9, 0), cphAt(11, 5, 8, 0), cphAt(6, 3, 8, 0), Date.UTC(2025, 11, 31, 22, 0), cphAt(11, 29, 9, 0),
];
const chatMarks = {
  now: LIST_NOW,
  zone: LIST_ZONE,
  ats: MARK_ATS,
  marked: timeMarks(MARK_ATS, LIST_ZONE),
  devices: ["en-GB", "da-DK"].map((device) => ({ device, cases: MARK_MOMENTS.map((at) => ({ at, words: timeMark(at, LIST_NOW, LIST_ZONE, device) })) })),
};

// ---- Settings' Permissions, read-only, in every app's words: a rule as a sentence (lib/rules.ts ruleSentence), a hand-off
// grant's title and terms (lib/grants.ts handoffTitle, handoffTerms) ----
// ---- an approval in plain words, as its ask says it in a chat (lib/asks.ts askPlain): what it would do, to or on which
// service (its label, else its id with a capital), and the first words it would send, cut on a character at 60. ----
const askVectors = {
  plain: (
    [
      [{ connector: "forge", tool: "post", args: { text: "Sync survives a dropped connection." } }, "Forge"],
      [{ connector: "forge", tool: "post", args: { text: "Sync survives a dropped connection: thanks to everyone who tested it on their own nodes." } }, null],
      [{ connector: "forge", tool: "post", args: { text: "  First line.\nSecond line." } }, null],
      [{ connector: "forge", tool: "post", args: { text: `${"a".repeat(58)}😀😀😀` } }, null],
      [{ connector: "github", tool: "create_pull_request", args: { title: "Fix the importer", body: "It reads ISO dates now." } }, "GitHub"],
      [{ connector: "github", tool: "merge", args: { number: 12 } }, "GitHub"],
      [{ connector: "github", tool: "merge", args: { title: "   " } }, null],
      [{ connector: "s3", tool: "bucket.delete", args: { bucket: "old-logs" } }, null],
      [{ connector: "mail", tool: "send_email", args: { subject: "The 0.4 notes", body: "Attached." } }, "Mail"],
      [{ connector: "drive", tool: "upload", args: { name: "notes.md" } }, "  "],
    ] as [{ connector: string; tool: string; args: Record<string, unknown> }, string | null][]
  ).map(([ask, label]) => ({ ask, label, words: askPlain(ask, label) })),
  // Its service by the connector's own name, from the node's list (GET /api/connectors, read once and kept): each id's
  // label as written, a blank one none; one not in the list, its id with a capital (lib/asks.ts connectorLabels).
  listed: (() => {
    const connectors = [{ id: "github", label: "GitHub" }, { id: "forge", label: "  " }, { id: "ha", label: " Home Assistant " }];
    const labels = connectorLabels(connectors);
    const asks = [
      { connector: "github", tool: "merge", args: {} },
      { connector: "forge", tool: "post", args: { text: "Hi" } },
      { connector: "ha", tool: "call_service", args: { name: "Kitchen lights" } },
      { connector: "s3", tool: "bucket.delete", args: {} },
    ];
    return { connectors, labels: Object.fromEntries(labels), asks: asks.map((ask) => ({ ask, words: askPlain(ask, labels.get(ask.connector)) })) };
  })(),
};

const permissions = {
  rules: (
    [
      { does: "halt", words: ["sudo", "curl*", "wget"] },
      { does: "refuse", words: ["git"], contains: "push --force" },
      { does: "check", words: ["bun"], run: "bun run check" },
      { does: "tell", words: [], contains: "deploy" },
      { does: "tell", words: ["kubectl"] },
    ] as { does: "halt" | "refuse" | "check" | "tell"; words: string[]; contains?: string; run?: string }[]
  ).map((rule) => ({ rule, sentence: ruleSentence(rule) })),
  handoffs: [
    { from: { id: "n_laptop", name: "laptop" }, to: { id: "n_homelab", name: "homelab" }, terms: { agents: ["ada", "bea"], tools: [], budgetUsdPerDay: 5 } },
    { from: { id: "n_homelab", name: "homelab" }, to: { id: "n_ultra", name: "ultra" }, terms: { tools: [], budgetUsdPerDay: 0.5 } },
    { from: { id: "n_ultra", name: "ultra" }, to: { id: "n_laptop", name: "laptop" }, terms: null },
  ].map((grant) => ({ grant, title: handoffTitle(grant), terms: handoffTerms(grant.terms) })),
  // A rule's name heads its row as you'd say it (lib/rules.ts ruleTitle).
  titles: ["pushes", "no-force-push", "ci_on_main", "Deploys"].map((name) => ({ name, title: ruleTitle(name) })),
  // Settings' own words (lib/usage.ts SETTINGS_WORDS): "Can do" for what a device may do; a read-only page's one line.
  words: SETTINGS_WORDS,
  // Money as the apps say it, always two decimals, rounded on the exact value (1.005 is under; 0.125 is half way), and the
  // usage meter: its figure, the line under it, and the two in one line (lib/usage.ts moneyWords, spentWords, budgetWords, meterLine).
  money: [0, 0.0042, 0.61, 12.3, 36.6, 240, 1.005, 0.125, 2.675].map((usd) => ({ usd, words: moneyWords(usd) })),
  meters: [
    { spentUsd: 0.4, budgetUsd: 1, complete: true, tokens: 1_204_000 },
    { spentUsd: 1, budgetUsd: 1, complete: true, tokens: 1_204_000 },
    { spentUsd: 36.6, budgetUsd: 1, complete: false, tokens: 1_204_000 },
    { spentUsd: 36.6, budgetUsd: 1, complete: true, tokens: 1_204_000 },
    { spentUsd: 36.6, budgetUsd: null, complete: true, tokens: 1_204_000 },
    { spentUsd: 0, budgetUsd: null, complete: false, tokens: 8_200 },
  ].map((meter) => ({ meter, spent: spentWords(meter), budget: budgetWords(meter), line: meterLine(meter) })),
};

// ---- your agent's line in the list that is home (lib/roster.ts homePrimaryLine): never what waits on you, which its row
// counts. `answering`: it is writing an answer this app watches (`step`: the step it is at, null before it says one). ----
const homePrimary = (
  [
    [{ step: "Reading sync.ts", turns: [{ title: "Fix sync" }], runs: [] }, null, null],
    [{ step: null, turns: [], runs: [] }, "Earlier words", "Release"],
    [{ turns: [{ title: "Fix sync" }], runs: [] }, null, null],
    [{ turns: [{ title: null }], runs: [] }, null, null],
    [{ turns: [{ title: "a" }], runs: [{ goal: "b" }] }, null, null],
    [{ turns: [], runs: [{ goal: "  Make sync faster\nand more" }] }, null, null],
    [{ turns: [], runs: [], unread: [{ title: "The release" }] }, "## Done", "Release"],
    [{ turns: [], runs: [], unread: [{ title: null }] }, null, null],
    [{ turns: [], runs: [], unread: [{ title: "a" }, { title: "b" }] }, null, null],
    [{ turns: [], runs: [] }, "## Done\nThe board is green.", "Release"],
    [{ turns: [], runs: [] }, "\n\n  > Quoted first\nnext", "Release"],
    [{ turns: [], runs: [] }, "   \n\t", "Release"],
    [{ turns: [], runs: [] }, null, "Release"],
    [{ turns: [], runs: [] }, null, "   "],
    [{ turns: [], runs: [] }, null, null],
  ] as [Omit<NowInput, "needs">, string | null, string | null][]
).map(([work, latest, title]) => ({
  answering: work.step !== undefined,
  step: work.step ?? null,
  turns: work.turns.map((turn) => turn.title),
  runs: work.runs.map((run) => run.goal),
  unread: (work.unread ?? []).map((chat) => chat.title),
  latest,
  title,
  line: homePrimaryLine(work, latest, title),
}));

const unread = {
  snapshot: seenSnapshot,
  rows: rosterRows({ snapshot: seenSnapshot, asks: [], now: NOW }).map((row) => ({ id: row.id, kind: row.kind, line: row.line, plain: row.plain, needs: row.needs, unread: row.unread, state: row.state ?? null })),
  home: homeOf({ snapshot: seenSnapshot, asks: [], now: NOW }),
};

// ---- seating and keeping agents (the PWA's forms) --------------------------------------------------------------------
const agentRoster = {
  reviewer: { models: ["a/r"], forAgents: false }, frontend: { models: ["orcarouter/anthropic/claude-opus-5.5", "deepseek/deepseek-v4-pro"], forAgents: true },
  planner: { models: ["a/p"], forAgents: true }, eyes: { models: ["a/v"], forAgents: false }, engineer: { models: ["a/e"], forAgents: true },
  swift: { models: [], forAgents: true }, "cheap-coder": { models: ["a/c"], forAgents: true }, fold: { models: ["a/x"], forAgents: false },
};
const agentModelOffer = [{ ref: "deepseek/deepseek-v4-pro", on: [] as string[] }, { ref: "ollama/mimo-v2.6:9b", on: ["mini"] }, { ref: "ollama/qwen3.8:27b", on: ["mini", "ultra"] }];
const agentForms = {
  handles: [
    ["Ada", []], ["Owner", []], ["Invincible", []], ["System", ["system-2"]], ["Áda", ["ada", "ada-2"]], ["123", []], ["研究", []],
    ["  The   Reviewer du Lac!! ", []], ["Ünïcödé Ñame", []], ["-x-", []], ["A".repeat(40), []], ["a very long name that goes on and on and on", []],
    ["", []], ["🛡️ Shield", []], ["ﬁne ﬂow", []], ["İstanbul", []], ["Straße", []], ["ada", ["ada", "ada-2", "ada-3"]],
  ].map(([name, taken]) => ({ name: name as string, taken: taken as string[], handle: agentId(name as string, taken as string[]) })),
  removals: [
    { workspace: false, workspaceNode: false, maySandbox: true },
    { workspace: false, workspaceNode: false, maySandbox: false },
    { workspace: true, workspaceNode: true, maySandbox: true },
    { workspace: true, workspaceNode: true, maySandbox: false },
    { workspace: false, workspaceNode: true, maySandbox: true },
    { workspace: false, workspaceNode: true, maySandbox: false },
  ].map((c) => ({ ...c, id: "ada", name: "Ada", plan: removalPlan({ id: "ada", name: "Ada", workspace: c.workspace ? { node: "n1", id: "0123456789" } : null, workspaceNode: c.workspaceNode ? "n1" : null }, { sandbox: c.maySandbox }) })),
  // The roles an agent may be given, from a roster that says which are for agents, and from an older one that doesn't.
  roles: [
    { roster: agentRoster },
    { roster: agentRoster, current: "reviewer" },
    { roster: agentRoster, current: "frontend" },
    { roster: { swift: { models: [] }, engineer: { models: ["a/e"] }, fold: { models: ["a/x"] }, Odd: { models: ["a/o"] } }, current: "made-up" },
    { roster: {} as Record<string, AgentRoleSpec> },
  ].map((c) => ({ ...c, roles: agentRoles(c.roster, c.current) })),
  // A task's budget as typed (the PWA's budgetFrom): the dollars, or what is wrong with it.
  budgets: ["", "  ", "0.50", "$2", "$ 1,5", "100", "abc", "1.2.3", ".5", "5.", "-1", "1e3", "0", "0.00", "100.01", "250", " 3 "].map((text) => {
    const read = budgetFrom(text);
    return { text, ...("error" in read ? { error: read.error } : { usd: read.usd }) };
  }),
  roleLines: [
    { role: "frontend", spec: agentRoster.frontend },
    { role: "engineer", spec: agentRoster.engineer },
    { role: "swift", spec: agentRoster.swift },
    { role: "reviewer", spec: agentRoster.reviewer },
    { role: "made-up" },
  ].map((c) => ({ ...c, line: agentRoleLine(c.role, c.spec) })),
  // An agent's own models: the toggles offered, one turned on or off, and what it works on in a line and in a word or two.
  modelChoices: [
    { choices: agentModelOffer },
    { choices: agentModelOffer, own: ["ollama/qwen3.8:27b", "gone/model"] },
    { choices: [] as { ref: string; on: string[] }[], own: ["ollama/mimo-v2.6:9b"] },
  ].map((c) => ({ ...c, offered: agentModelChoices(c.choices, c.own) })),
  modelToggles: [
    { own: ["a/1"], ref: "a/2", on: true }, { own: ["a/1", "a/2"], ref: "a/1", on: false }, { own: ["a/1"], ref: "a/1", on: true },
    { own: ["a/0", "a/1", "a/2", "a/3", "a/4", "a/5", "a/6", "a/7"], ref: "a/8", on: true }, { own: [] as string[], ref: "a/1", on: false },
  ].map((c) => ({ ...c, after: toggleAgentModel(c.own, c.ref, c.on) })),
  modelLines: [
    { own: ["ollama/mimo-v2.6:9b", "deepseek/deepseek-v4-pro"], role: "engineer", spec: agentRoster.engineer },
    { own: ["ollama/mimo-v2.6:9b"], role: "frontend", spec: agentRoster.frontend },
    { own: [] as string[], role: "engineer", spec: agentRoster.engineer },
    { own: [] as string[], role: "made-up" },
    // Sensitive mode: every call of its work on them alone.
    { own: ["nearai/Qwen/Qwen3.8-27B-abliterated", "heabsy/heabsy/cyberheabsy"], role: "engineer", spec: agentRoster.engineer, sensitive: true },
    { own: [] as string[], role: "engineer", spec: agentRoster.engineer, sensitive: true },
  ].map((c) => ({ ...c, line: agentModelsLine(c.own, c.role, c.spec, "sensitive" in c ? c.sensitive : false) })),
  worksOn: [
    { role: "engineer" }, { role: "engineer", models: ["ollama/mimo-v2.6:9b"] }, { role: "planner", models: ["orcarouter/anthropic/claude-opus-5.5", "ollama/qwen3.8:27b"] }, { role: "swift", models: [] as string[] },
    { role: "engineer", models: ["nearai/Qwen/Qwen3.8-27B-abliterated"], sensitive: true },
  ].map((c) => ({ ...c, words: agentWorksOn(c) })),
};

// ---- keys and the providers they are for (the PWA's own lib/text.ts, over the node's real presets) -----------------------
const fakeKeys = ["sk-ant-api03-FAKE-for-tests", "sk-ant-oat01-FAKE-for-tests", "sk-or-v1-FAKE", "sk-orca-FAKE", "sk-kimi-FAKE", "sk-sp-FAKE", "sk-nano-FAKE", "sk-cp-FAKE", "tp-FAKE", "ttp-FAKE", "gsk_FAKE", "plain-FAKE", ""];
const configured = [{ id: "openrouter", kind: "openai" as const, baseUrl: "https://openrouter.ai/api/v1", secret: "openrouter", label: null, hasKey: true }];
const keys = {
  presets: PRESETS,
  signIns: SIGN_INS,
  providers: configured,
  detected: fakeKeys.map((key) => ({ key, provider: detectProvider(key, PRESETS, SIGN_INS), signIn: detectSignIn(key, SIGN_INS) })),
  plans: PRESETS.map((preset) => ({ id: preset.id, line: planLine(preset) })),
  // (A base URL is given with a key for a preset with no address of its own, a Cloudflare AI Gateway's, or for another
  // region than its own: Xiaomi's Europe.)
  setups: (
    [
      ["anthropic", "anthropic", true], ["zai-coding", "zai-coding", true], ["opencode-go", "opencode-go", true], ["openrouter", "openrouter", true],
      ["openrouter", "openrouter-2", true], ["verda", "verda", true], ["cloudflare-ai", "cf", true], ["mine", "mine", true], ["anthropic", "anthropic", false],
      ["cloudflare-ai", "cloudflare-ai", true, "https://gateway.ai.cloudflare.com/v1/0123456789abcdef0123456789abcdef/invincible/compat"],
      ["openrouter", "openrouter", true, "https://openrouter.ai/api/v1"], ["openrouter", "openrouter", true, "https://openrouter.example.test/api/v1"],
      ["mimo-token", "mimo-token", true, "https://token-plan-ams.xiaomimimo.com/v1"], ["mimo-token", "mimo-token", true, "https://token-plan-sgp.xiaomimimo.com/v1"],
    ] as [string, string, boolean, string?][]
  ).map(([provider, secret, may, baseUrl]) => ({ provider, secret, may, baseUrl: baseUrl ?? null, ...providerSetup({ providers: configured, presets: PRESETS }, provider, secret, may, baseUrl) })),
};

// ---- an agent's desktop (the PWA's own lib/desktop.ts) ---------------------------------------------------------------
const drawn = { left: 10, top: 20, width: 640, height: 400 };
const desktop = {
  points: [[10, 20], [330, 220], [649.9, 419.9], [650, 420], [9, 20], [10, 421], [100.5, 300.25]].map(([x, y]) => ({ tap: { x, y }, shown: drawn, screen: { width: 1280, height: 800 }, point: screenPoint({ x: x!, y: y! }, drawn, { width: 1280, height: 800 }) })),
  unshown: screenPoint({ x: 1, y: 1 }, { left: 0, top: 0, width: 0, height: 0 }, { width: 1280, height: 800 }),
  addresses: ["invincible.sh", "https://invincible.sh/x?y=1", "http://localhost:3000", "localhost:3000", "file:///work/index.html", "about:blank", "javascript:alert(1)", "mailto:x@y.z", "two words", "  ", "", `a${"b".repeat(2000)}.com`, "ftp://host"].map((text) => ({ text, address: desktopAddress(text) })),
  shots: [
    { shot: { mediaType: "image/jpeg", data: "/9j/4AAQ" }, width: 1280, height: 800 },
    { shot: { mediaType: "image/png", data: "iVBORw0KGgo=" }, width: 1280, height: 800 },
    { shot: { mediaType: "image/gif", data: "R0lGODlh" }, width: 1280, height: 800 },
    { shot: { mediaType: "image/jpeg", data: "not base64!" }, width: 1280, height: 800 },
    { shot: { mediaType: "image/jpeg", data: "" }, width: 1280, height: 800 },
    { shot: { mediaType: "image/jpeg", data: "/9j/4AAQ" }, width: 0, height: 800 },
  ].map((view) => ({ view, shown: shotSource(view) !== null })),
};

// ---- an agent's desktop, live (core's desktop-frames.ts, the PWA's lib/desktop-stream.ts) ------------------------------
const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64");
/** A frame as the VM's encoder writes it: a 4-byte length of what follows, a kind, an 8-byte time (ms), the payload. */
const framed = (kind: number, time: number, payload: number[]) => {
  const out = new Uint8Array(core.DESKTOP_FRAME_HEADER + payload.length);
  new DataView(out.buffer).setUint32(0, 9 + payload.length);
  out[4] = kind;
  new DataView(out.buffer).setBigUint64(5, BigInt(time));
  out.set(payload, core.DESKTOP_FRAME_HEADER);
  return out;
};
const joined = (...parts: Uint8Array[]) => new Uint8Array(parts.flatMap((part) => [...part]));
// A keyframe's NAL units (an access unit delimiter, the SPS, the PPS, the IDR slice), another frame's, a beat, a kind
// no app knows: each as the stream carries it.
const KEY_UNITS = [0, 0, 0, 1, 0x09, 0xf0, 0, 0, 0, 1, 0x67, 0x42, 0xc0, 0x1f, 0xda, 0x01, 0x40, 0, 0, 1, 0x68, 0xce, 0x3c, 0x80, 0, 0, 1, 0x65, 0x88, 0x84, 0x00, 0x33];
const DELTA_UNITS = [0, 0, 1, 0x41, 0x9a, 0x02];
const T0 = 1_764_216_000_123;
const streamBytes = joined(framed(1, T0, KEY_UNITS), framed(2, T0 + 100, DELTA_UNITS), core.desktopBeat(T0 + 1600), framed(7, T0 + 1700, [1, 2, 3]));
/** The glass page's recording the apps' decoders are tested on: 30 frames, a keyframe first, each strip as drawn. */
const GLASS = "desktop-glass.frames";
const glassFrames = new core.DesktopFrames().push(new Uint8Array(readFileSync(join(import.meta.dir, "../InvincibleTests/Fixtures", GLASS))));
const desktopStream = {
  header: core.DESKTOP_FRAME_HEADER,
  most: core.DESKTOP_FRAME_MAX,
  type: core.DESKTOP_FRAMES_TYPE,
  // The same bytes cut in any of these places come out as the same frames.
  bytes: b64(streamBytes),
  cuts: [[], [1], [3, 4, 5], [12, 13, 14], [44], [45, 46], [60, 70, 80]],
  frames: new core.DesktopFrames().push(streamBytes).map((f) => ({ kind: f.kind, time: f.time, payload: b64(f.payload), chunk: chunkOf(f) && { type: chunkOf(f)!.type, timestamp: chunkOf(f)!.timestamp } })),
  // What is no stream of frames: a length under the kind and the time, one past the most, text where frames should be.
  refused: [new Uint8Array([0, 0, 0, 8, 1, 0, 0, 0, 0, 0, 0, 0]), (() => { const long = new Uint8Array(4); new DataView(long.buffer).setUint32(0, core.DESKTOP_FRAME_MAX + 1); return long; })(), new TextEncoder().encode("desktop: unknown command\n")].map((bytes) => {
    let refused = false;
    try {
      new core.DesktopFrames().push(bytes);
    } catch {
      refused = true;
    }
    if (!refused) throw new Error("a refused vector was taken");
    return b64(bytes);
  }),
  codecs: [KEY_UNITS, [0, 0, 1, 0x67, 0x64, 0x00, 0x28, 0xac], [0, 0, 1, 0x65, 0x88, 0x84], [0, 0, 1, 0x67, 0x42]].map((units) => ({ payload: b64(new Uint8Array(units)), codec: codecOf(new Uint8Array(units)) })),
  holds: [{ held: { since: T0 - 30_000, idleSec: 120, mostSec: 900, endsInSec: 119.5 }, at: T0 }, { held: { since: T0, idleSec: 120, mostSec: 900, endsInSec: 0 }, at: T0 + 5 }].map((h) => ({ ...h, ends: holdEnds(h.held, h.at) })),
  again: [1, 2, 3, 4, 5, 9].map((n) => ({ n, ms: againIn(n) })),
  liveTries: LIVE_TRIES,
  // Falling behind: past BEHIND frames waiting; BEHIND_TIMES in a row, each within BEHIND_WITHIN_MS of the last, gives way.
  behind: BEHIND,
  behindTimes: BEHIND_TIMES,
  behindWithinMs: BEHIND_WITHIN_MS,
  behinds: ([[null, T0], [{ count: 1, at: T0 }, T0 + 10_000], [{ count: 2, at: T0 + 10_000 }, T0 + 40_000], [{ count: 2, at: T0 + 10_000 }, T0 + 40_001], [{ count: 5, at: T0 }, T0 - 1]] as const).map(([row, at]) => {
    const next = behindAgain(row, at);
    return { row, at, next, tooOften: behindTooOften(next) };
  }),
  // The glass clock (bench/desktop/glass-clock.ts): its strip, and what each frame of the fixture shows, read back here
  // from the bits it was drawn with (its 30 frames drew BASE + 37 ms a frame, and clicks 0 to 4 over and over).
  glass: {
    fixture: GLASS,
    strip: STRIP,
    frames: glassFrames.map((f, i) => ({ kind: f.kind, time: 1_764_216_000_000 + i * 37, clicks: i % 5 })),
    // Each strip's blocks for one time and count, as the page draws them (1 white): the readers' own test.
    bits: { time: T0, clicks: 3, bits: bitsOf(T0, 3) },
  },
};
// (The glass reader agrees with what was drawn: the vectors' strip is the one the page draws.)
if (readStrip((x, y) => { const i = Math.floor((x - STRIP.x) / STRIP.block); return y >= STRIP.y && y < STRIP.y + STRIP.block && i >= 0 && i < STRIP.bits ? (desktopStream.glass.bits.bits[i] ? 255 : 0) : 128; })?.time !== T0) throw new Error("the glass strip doesn't read back");

// ---- an agent's face (core's taskStep, and the mood its orb takes from what it is doing) ------------------------------
const faces = {
  steps: ["Plan · read the code", "Thinking · which test", "Running · desktop open https://x", "Running · desktop", "Running · bun test", "Exit 0 · 12 passed", "Exit -1 · killed", "Gate 1/2 · bun test", "Gates · 1. bun test", "Gates · all 2 passed", "Gates · 1 of 2 failed: back to the work", "Gates before the work · 2", "Review · PASS", "Submitted for review · now", "gates", "gated", "  Running · ls", "Something else", ""].map((line) => ({ line, step: core.taskStep(line) })),
  moods: core.AVATAR_EXPRESSIONS.map((expression) => ({ expression, mood: orbMoodOfExpression(expression) })),
};

// ---- the primary's orb (the PWA's own lib/orb.ts): each state's colours, the parts of each level, and the level of each size ----
const orb = {
  palettes: Object.fromEntries(ORB_TONES.map((tone) => [tone, orbPalette(tone)])),
  levels: { badge: orbParts(28), seat: orbParts(64), full: orbParts(168) },
  sizes: [16, 28, 36, 47, 48, 64, 72, 119, 120, 168, 200, 320].map((size) => ({ size, level: orbLevel(size) })),
  // Where it stands among the agents, as its seat's orb shows it.
  states: ["working", "needs", "failed", "paused", "queued", "verified", "unread", "resting"].map((state) => ({ state, tone: orbToneOfState(state) })),
  motion: orbMotion(),
  sphere: orbSpheres(),
};

// ---- the orbs as fields (the PWA's own lib/field.ts and lib/field-orb.ts, 26 November 2026): the primary's field in gold with
// its beam through it (the heads-up ring went the same day), each agent's in its own colours. (The orb section above is
// the glyph orb the apps drew before they ported the fields.)
const field = fieldVectors();

/** The primary's field as every orb (the PWA's own lib/field.ts and lib/field-orb.ts): the lights, whose field each is, a
 * field's lines and points at given turns (a few steps along each line: the same function at any count), where they fall
 * on a picture, each size's look, its beam, how a field moves in each mood (its clock, its frames, its embers), its tints
 * and its light and ink, for every app to draw the same orbs. A point on a cut (the core's, r < 0.32, or the dark's, a
 * light under 0.02) or an ember at the turn of its life would part on another processor's last digit: none is within a
 * millionth of one here, or the vectors aren't written. */
function fieldVectors() {
  const handles = ["ada", "coder", "", "Will’s “iPad” \\ 🛡️"];
  const chosen = { v: 2, color: "#3ABEFF" };
  /** A field's points at a look and a turn (its model's lines at `steps` a line), with each one's place on its line and
   * the key's and the rim's light on it; checked off the cuts. */
  const pointsOf = (who: string, identity: FieldIdentity, primary: boolean, size: number, turn: number, steps: number, rim = 0) => {
    const look = fieldLook(identity, size, primary);
    const colours = fieldColours(identity.colours, rim);
    const options: FieldOptions = { lines: look.lines, steps, tilt: identity.tilt, seed: identity.seed, colours: identity.colours, weight: look.weight, turn };
    const model = fieldModel(options);
    offTheCuts(who, options, turn, colours);
    const out = fieldBuffer(model);
    const count = fieldAt(model, turn, out, fieldLight(colours));
    return {
      who, size, primary, turn, rim, options, colours,
      points: Array.from({ length: count }, (_, i) => ({ at: out.at[i]!, x: out.x[i]!, y: out.y[i]!, z: out.z[i]!, rgb: [out.r[i]!, out.g[i]!, out.b[i]!], size: out.size[i]!, lit: out.lit[i]!, rim: out.rim[i]! })),
    };
  };
  const points = [
    pointsOf("primary", PRIMARY_FIELD, true, 160, 0, 3),
    pointsOf("primary", PRIMARY_FIELD, true, 18, 1.3, 4),
    pointsOf("ada", agentField("ada"), false, 34, 0.5, 5),
    pointsOf("coder", agentField("coder"), false, 18, 4.2, 4),
    pointsOf("ada, chosen", agentField("ada", chosen), false, 50, 2.75, 4, 0.6),
  ];
  // A clock taken through moods a step at a time (a step back in time and one a minute long among them), its and a
  // agent's.
  const steps: { agent: boolean; mood: OrbMood; dt: number; clock: FieldClock; fps: number }[] = [];
  for (const agent of [false, true]) {
    let clock = fieldClock(fieldMotion("idle", agent));
    for (const [mood, dt] of [["idle", 1 / 60], ["working", 1 / 60], ["working", 0.1], ["working", 0.6], ["waiting", 1 / 30], ["waiting", 0.2], ["failed", 0.05], ["done", -1], ["done", 0.016], ["paused", 0.25], ["queued", 60], ["idle", 0.1]] as [OrbMood, number][]) {
      clock = fieldStep(clock, fieldMotion(mood, agent), dt);
      steps.push({ agent, mood, dt, clock, fps: fieldFps(clock, fieldMotion(mood, agent)) });
    }
  }
  const working = fieldStep(fieldStep(fieldClock(FIELD_MOTION.idle), FIELD_MOTION.working, 0.25), FIELD_MOTION.working, 0.2);
  const frames = ([[working, 0.37, 0, true], [working, 1000.5, 0, true], [working, 47.9, orbSeed("primary"), true], [working, 12.25, orbSeed("primary:seat"), false], [{ ...fieldClock(FIELD_MOTION.waiting), breath: 0.3 }, 5, 0, true], [fieldClock(FIELD_MOTION.idle), 3, 0, true]] as [FieldClock, number, number, boolean][])
    .map(([clock, t, seed, embers]) => {
      offTheTurn(clock, t, seed);
      return { clock, t, seed, embers, frame: fieldFrame(clock, t, { seed, embers }) };
    });
  const rgbOf = (hex: string) => [1, 3, 5].map((at) => parseInt(hex.slice(at, at + 2), 16)) as [number, number, number];
  return {
    lights: { key: FIELD_KEY, rim: FIELD_RIM, exposure: FIELD_EXPOSURE },
    primary: PRIMARY_FIELD,
    agents: [...handles.map((handle) => ({ handle, profile: null, field: agentField(handle) })), { handle: "ada", profile: chosen, field: agentField("ada", chosen) }],
    linear: [AURUM.key[0], AURUM.key[1], AURUM.rim, "#3abeff", "#000000", "#ffffff", "#0a0b0c"].map((hex) => ({ hex, rgb: linear(hex) })),
    shades: ([[0, 0, 1], [0.6, 0.64, 0.48], [-0.55, 0.58, 0.6], [0.8, -0.45, -0.35], [0, -1, 0]] as [number, number, number][]).flatMap((n) => {
      const length = Math.hypot(...n);
      const unit = n.map((v) => v / length) as [number, number, number];
      return [AURUM, agentField("coder").colours].map((colours) => ({ n: unit, colours, shade: shadeLit(unit, fieldLight(colours)) }));
    }),
    models: ([[46, 11], [12, 1], [20, 2147483646]] as [number, number][]).map(([lines, seed]) => {
      const model = fieldModel({ lines, steps: 4, seed });
      return { lines, seed, phi: [...model.phi], width: [...model.width] };
    }),
    points,
    projections: points.slice(0, 3).flatMap((each) => [[1, 1], [36, 0.86], [100, 0.94]].map(([size, zoom]) => ({ who: each.who, size, zoom, shown: each.points.slice(0, 6).map((p) => project({ x: p.x, y: p.y, z: p.z, rgb: [0, 0, 0], size: p.size }, size!, { zoom })) }))),
    looks: [8, 14, 16, 18, 24, 25, 29, 30, 34, 48, 49, 50, 55, 56, 96, 160, 175, 320].flatMap((size) => [{ who: "primary", size, primary: true, look: fieldLook(PRIMARY_FIELD, size, true) }, { who: "ada", size, primary: false, look: fieldLook(agentField("ada"), size, false) }]),
    // Its beam: where its halves fall in the square at a zoom, and its width, light and colour along it.
    beam: { ...PRIMARY_BEAM, lines: [0.94, 0.86, 1].map((zoom) => ({ zoom, halves: beamLine(PRIMARY_FIELD, zoom) })), along: [-0.5, 0, 0.125, 0.25, 0.5, 0.75, 0.9375, 1, 1.5].map((u) => ({ u, ...beamAt(u) })) },
    stroke: { ...FIELD_STROKE, lights: [14, 18, 34, 50, 96, 160].map((size) => ({ size, light: strokeLight(size) })) },
    motion: FIELD_MOTION,
    agentMotion: Object.fromEntries((Object.keys(FIELD_MOTION) as OrbMood[]).map((mood) => [mood, fieldMotion(mood, true)])),
    ease: FIELD_EASE,
    embers: { ...FIELD_EMBERS, rimAngle: RIM_ANGLE },
    clocks: (Object.keys(FIELD_MOTION) as OrbMood[]).map((mood) => ({ mood, clock: fieldClock(FIELD_MOTION[mood]), still: fieldStill(FIELD_MOTION[mood]) })),
    steps,
    frames,
    tints: { dim: RIM_DIM, rims: [0, 0.0005, 0.4, 1, 1.5].map((rim) => ({ rim, aurum: fieldColours(AURUM, rim), coder: fieldColours(agentField("coder").colours, rim) })) },
    tones: ([[0, 0, 0], [0.02, 0.01, 0.005], [0.2, 0.12, 0.03], [1.2, 0.25, 0.05], [3, 2.2, 1], [40, 40, 40], [-1, 0.5, 2]] as [number, number, number][]).flatMap((rgb) => [FIELD_EXPOSURE, 0.8].map((exposure) => ({ rgb, exposure, shown: fieldTone(rgb[0], rgb[1], rgb[2], exposure) }))),
    inks: [AURUM, agentField("ada").colours, agentField("coder").colours].map((colours) => {
      const inks = fieldInks(colours);
      return { colours, inks, keyRgb: rgbOf(colours.key[1]), shown: ([[1, 0], [0, 1], [0.5, 0.5], [0.2, 0.05], [0, 0], [0.8, 0], [0.9, 0.1]] as [number, number][]).map(([lit, rim]) => ({ lit, rim, ink: fieldInk(inks, lit, rim) })) };
    }),
    // A colour as an ink on the light page (26 November 2026): its hue kept, more saturated, as light as its contrast allows.
    ink: { ...FIELD_INK, of: ["#ffb12e", "#ff5a2a", "#fff4d6", "#3abeff", "#0a0b0c", "#ffffff", "#7f7f7f", "#00ff00"].flatMap((hex) => [FIELD_INK.key, FIELD_INK.rim, FIELD_INK.sheen.contrast].map((contrast) => ({ hex, contrast, rgb: inkOf(hex, contrast) }))) },
  };
}

/** Fails if a field's candidate point lies within a millionth of a cut: the core's (r 0.32) or the dark's (k 0.02). */
function offTheCuts(who: string, options: FieldOptions, turn: number, colours: FieldColours) {
  const model = fieldModel(options);
  const light = fieldLight(colours);
  const [cx, sx, cy, sy, cz, sz] = model.lean;
  for (let line = 0; line < model.lines; line++) {
    const p = model.phi[line]! + turn;
    for (let j = 1; j < model.steps; j++) {
      const r = model.width[line]! * model.sin2[j]!;
      if (Math.abs(r - 0.32) < 1e-6) fail(`${who}: a point on the core's cut`);
      if (r < 0.32) continue;
      const a0 = r * model.sin[j]! * Math.cos(p), a1 = r * model.cos[j]!, a2 = r * model.sin[j]! * Math.sin(p);
      const x = a0 * cz - a1 * sz, y0 = a0 * sz + a1 * cz;
      const x2 = x * cy + a2 * sy, z2 = -x * sy + a2 * cy;
      const y3 = y0 * cx - z2 * sx, z3 = y0 * sx + z2 * cx;
      const l = Math.hypot(x2, y3, z3);
      if (Math.abs(shadeLit([x2 / l, y3 / l, z3 / l], light).k - 0.02) < 1e-6) fail(`${who}: a point on the dark's cut`);
    }
  }
}

/** Fails if an ember of a frame is within a millionth of the turn of its life (where it would set out again elsewhere). */
function offTheTurn(_clock: FieldClock, t: number, seed: number) {
  for (let i = 0; i < FIELD_EMBERS.count; i++) {
    const life = FIELD_EMBERS.life[0] + (FIELD_EMBERS.life[1] - FIELD_EMBERS.life[0]) * orbRand(seed >>> 0, i, 70);
    const at = t / life + orbRand(seed >>> 0, i, 71);
    const u = at - Math.floor(at);
    if (u < 1e-6 || u > 1 - 1e-6) fail(`an ember at the turn of its life at ${t}`);
  }
}

/** The orbs' spheres of glyphs (the PWA's own lib/orb-sphere.ts): each handle's sphere, its points, its glyphs as they
 * change, what is seen of them at given turns, sizes, breaths, moods and pages, the shades, an agent's arcs and
 * The primary's data ring, for every app to draw the same glyphs. (Times are picked well away from a beat's edge.) */
function orbSpheres() {
  const handles = ["primary", "coder", "ada", "", "Will’s “iPad” \\ 🛡️"];
  const coder = orbSphere("coder");
  const primary = orbSphere("primary");
  const frame = (sphere: ReturnType<typeof orbSphere>, handle: string, count: number, angle: number, scale: number, radius: number, glyph: number, t: number, mood: OrbMood, paper: boolean) =>
    ({ handle, count, angle, scale, radius, glyph, t, mood, paper, shown: sphereFrame(sphere, spherePoints(sphere, count), { angle, scale, radius, glyph, t, mood, paper }) });
  return {
    agent: AGENT_SPHERE,
    turn: SPHERE_TURN,
    ladder: GLYPH_LADDER,
    data: DATA_GLYPHS,
    flash: SPHERE_FLASH,
    spheres: handles.map((handle) => ({ handle, sphere: orbSphere(handle) })),
    points: ([["coder", 30], ["primary", 72], ["ada", 7]] as [string, number][]).map(([handle, count]) => ({ handle, count, points: spherePoints(orbSphere(handle), count) })),
    glyphs: ([[coder.seed, 0, 0, 0.25, 0], [coder.seed, 7, 3, 31.5, 0.03], [coder.seed, 12, 5, 1234.567, 0.5], [primary.seed, 3, 1, 77.7, 0.01], [primary.seed, 40, 4, 9.25, 1]] as [number, number, number, number, number][])
      .map(([seed, i, level, t, flash]) => ({ seed, i, level, t, flash, glyph: sphereGlyph(seed, i, level, t, flash) })),
    frames: [
      frame(coder, "coder", 30, 0, 1, 74, 32, 0.25, "idle", false),
      frame(coder, "coder", 72, 123.4, 1.02, 72, 24, 31.5, "working", false),
      frame(coder, "coder", 72, 400, 0.97, 72, 24, 47.3, "failed", false),
      frame(coder, "coder", 30, -37.5, 1, 74, 32, 8.1, "waiting", true),
      frame(primary, "primary", 72, 210, 1, 64, 22, 12.6, "working", false),
    ],
    shades: ([["#3abeff", "#9cdfff", "#1c5b7a"], ["#ffffff", "#ffffff", "#cae0ff"]] as [string, string, string][]).map(([ink, light, deep]) => ({ ink, light, deep, shades: sphereShades(ink, light, deep), paper: paperShades(ink, deep) })),
    arcs: handles.flatMap((handle) => (["badge", "seat", "full"] as const).map((level) => ({ handle, level, arcs: agentArcs(orbSphere(handle), level) }))),
    ring: ([[primary.seed, 0.25], [primary.seed, 31.6], [coder.seed, 7.75]] as [number, number][]).map(([seed, t]) => ({ seed, t, share: 0.62, places: Array.from({ length: 48 }, (_, k) => dataGlyph(seed, k, t, 0.62)) })),
  };
}

/** How the orb moves (the PWA's own lib/orb-motion.ts): each mood's motion, each state's mood, the stages, its random
 * numbers, and its clock and frames as they stand at given moments, for every app to draw the same. */
function orbMotion() {
  const coder = orbSeed("coder");
  // A clock taken through moods a step at a time: each step's mood, its time, and the clock after it. A step longer
  // than the longest a frame takes, and one back in time, are among them.
  const steps: { mood: OrbMood; dt: number; clock: OrbClock }[] = [];
  let clock = orbClock("idle", 5);
  for (const [mood, dt] of [["idle", 1 / 60], ["working", 1 / 60], ["working", 0.1], ["working", 0.6], ["done", 1 / 30], ["done", 0.2], ["failed", 0.05], ["waiting", -1], ["waiting", 0.016], ["paused", 0.25], ["queued", 1 / 120], ["idle", 0.1]] as [OrbMood, number][]) {
    clock = orbStep(clock, mood, dt);
    steps.push({ mood, dt, clock });
  }
  // Frames: each mood settled at two moments (the primary's own orb, then an agent's); moods arriving; bursts under way.
  const frame = (mood: OrbMood, seed: number, t: number, since: number | null = null, from: OrbMood | null = null, run = 0) => {
    let c = orbClock(from ?? mood, seed);
    for (let i = 0; i < run; i++) c = orbStep(c, mood, 0.1);
    return { mood, seed, t, since, from, burst: orbBursts(from, mood), clock: c, frame: orbFrame(mood, c, t, { seed, since, from, burst: orbBursts(from, mood) }) };
  };
  const frames = [
    ...ORB_MOODS.flatMap((mood) => [frame(mood, 0, 0.37), frame(mood, coder, 12.25)]),
    frame("working", 0, 31.4, 0.3, "idle", 3),
    frame("waiting", coder, 47.9, 1.9, "working", 19),
    frame("failed", coder, 8.8, 0.5, "working", 5),
    frame("done", 0, 64.2, 0.4, "working", 4),
    frame("done", coder, 65, 1.2, "waiting", 12),
    frame("idle", 0, 90.05, 0.9, "working", 9),
  ];
  return {
    moods: ORB_MOTION,
    states: ["working", "needs", "failed", "paused", "queued", "verified", "unread", "resting", "thinking"].map((state) => ({ state, mood: orbMoodOfState(state) })),
    arrive: ORB_ARRIVE, burst: ORB_BURST, burstMotes: ORB_BURST_MOTES, ease: ORB_EASE, longestStep: ORB_LONGEST_STEP,
    stages: ORB_STAGES,
    moves: ORB_MOVES,
    bursts: ORB_MOODS.flatMap((to) => [null, ...ORB_MOODS].map((from) => ({ from, to, bursts: orbBursts(from, to) }))),
    seeds: ["", "a", "foobar", "primary", "coder", "Will’s “iPad” \\ 🛡️"].map((name) => ({ name, seed: orbSeed(name) })),
    rands: [[0, 0, 0], [1, 2, 3], [0xffffffff, 25, 8], [coder, 7, 4], [5, 1000, 6]].map(([seed, i, k]) => ({ seed, i, k, value: orbRand(seed!, i!, k!) })),
    clocks: ORB_MOODS.flatMap((mood) => [0, coder].map((seed) => ({ mood, seed, clock: orbClock(mood, seed) }))),
    start: orbClock("idle", 5),
    steps,
    frames,
  };
}

// ---- where a connector's key or sign-in stands (the PWA's own lib/connector-state.ts) -------------------------------
// (signIn: whose sign-in it uses, or null for a key: Google's or Microsoft's needs your app; a hosted MCP server's doesn't.)
const connectorStates = ["none-needed", "ready", "missing", "optional-missing", "signed-out", "wrong-origin", "unheard-of"].flatMap((key) =>
  ([null, "google", "mcp"] as const).map((signIn) => ({ key, signIn, state: connectorState({ key, oauth: signIn ? { provider: signIn, account: null } : null }) })),
);

// ---- a chat on screen: kept messages, and a turn's stream applied event by event (the PWA's lib/turns.ts) --------------
const stored = (id: number, role: "user" | "assistant", content: string, extra: Partial<core.StoredMessage> = {}): core.StoredMessage => ({
  id,
  role,
  content,
  model: role === "assistant" ? "stand-in/planner" : null,
  steps: [],
  status: "done",
  error: null,
  createdAt: NOW - 60_000,
  endedAt: NOW - 30_000,
  ...extra,
});
const kept: core.StoredMessage[] = [
  stored(1, "user", "What's on today?"),
  stored(2, "assistant", "The dentist at nine, then **the release**.", {
    steps: [
      { kind: "model", ref: "stand-in/planner" },
      { kind: "archive", entries: [{ id: "ar_1", title: "Calendar", kind: "note", trust: "trusted" }, { id: "ar_2", title: "Mail", kind: "mail", trust: "untrusted" }] },
      { kind: "tool", id: "t1", name: "recall", title: "Searching memory", input: '{"q":"today"}', ok: true, summary: "2 found" },
      { kind: "tool", id: "t2", name: "web_search", title: "Searching the web", input: '{"q":"x"}', ok: false, summary: "refused" },
    ],
  }),
  stored(3, "user", "And tomorrow?"),
  stored(4, "assistant", "", { status: "error", error: "Every model on the roster failed.", steps: [{ kind: "model", ref: "a/b" }, { kind: "fallback", from: "a/b", error: "429" }] }),
  stored(5, "user", "Try again"),
  stored(6, "assistant", "Halfway", { status: "stopped" }),
  stored(7, "user", "Go on"),
  stored(8, "assistant", "First part", { status: "steered" }),
  // A look of its come back: a "user" message that isn't yours, shown as its own note.
  stored(9, "user", "(A look you set yourself at 21:07, not the owner's words: Is the site live?) Look now, with your tools, and say what you found and what comes next: the owner reads it here.", { look: { set: NOW - 3_600_000, note: "Is the site live?" } }),
  stored(10, "assistant", "It's live: the home page answers 200."),
];
type ThreadTurn = import("../../web/src/lib/turns.ts").Turn;
const shown = (turns: ThreadTurn[]) =>
  turns.map((t) => ({
    role: t.role,
    content: t.content,
    status: t.status,
    error: t.error ?? null,
    sid: t.sid ?? null,
    steps: t.steps.map((s) => ({ text: s.text, detail: s.detail ?? null, state: s.state, tool: s.tool ?? null })),
    look: t.look ?? null,
  }));
const freshThread = (): import("../../web/src/lib/turns.ts").Thread => ({ turns: [], nextId: 1, target: null, base: null });
/** A thread from kept messages, then events (null: the stream ends; a string: the watching was cut with it). */
function play(messages: core.StoredMessage[], role: string, question: string | null, events: (core.ChatStreamEvent | null | string)[]) {
  const thread = freshThread();
  for (const m of messages) thread.turns.push(turnOf(m, role, thread.nextId++));
  if (question !== null) beginTurn(thread, question, role, NOW);
  for (const event of events) {
    if (event === null) endTurn(thread, NOW);
    else if (typeof event === "string") failTurn(thread, event, NOW);
    else applyEvent(thread, event, NOW);
  }
  return shown(thread.turns);
}
const turnEvent = (answer: number | null, replay: boolean): core.ChatStreamEvent => ({ type: "turn", id: "tn_1", conversation: "cv_1", answer, role: "planner", startedAt: NOW, deadline: NOW + 1_800_000, replay });
const streamed: { name: string; messages: core.StoredMessage[]; question: string | null; events: (core.ChatStreamEvent | null | string)[] }[] = [
  { name: "kept", messages: kept, question: null, events: [] },
  {
    name: "asked",
    messages: kept.slice(0, 2),
    question: "And the weather?",
    events: [
      turnEvent(9, false),
      { type: "conversation", id: "cv_1", title: "Today", project: null },
      { type: "model", ref: "stand-in/planner" },
      { type: "tool", id: "t3", name: "web_search", title: "Searching the web", input: '{"q":"weather"}' },
      { type: "tool_result", id: "t3", name: "web_search", ok: true, summary: "3 results" },
      { type: "text", text: "Dry " },
      { type: "text", text: "and cold." },
      { type: "usage", ref: "stand-in/planner", usage: null },
      { type: "done", ref: "stand-in/planner" },
      null,
    ],
  },
  {
    name: "fallback-then-error",
    messages: [],
    question: "Hi",
    events: [{ type: "model", ref: "a/b" }, { type: "fallback", from: "a/b", error: "429 slow down" }, { type: "model", ref: "c/d" }, { type: "error", error: "Every model on the roster failed." }, null],
  },
  {
    name: "attached",
    // Loaded while it was answering: the kept answer as it stood, then the node replays the turn from its start.
    messages: [...kept.slice(0, 2), stored(3, "user", "Plan the week"), stored(4, "assistant", "Mon", { status: "streaming", endedAt: null })],
    question: null,
    events: [
      turnEvent(4, true),
      { type: "model", ref: "stand-in/planner" },
      { type: "text", text: "Monday: " },
      { type: "tool", id: "t4", name: "calendar", title: "Reading your calendar", input: "" },
      { type: "tool_result", id: "t4", name: "calendar", ok: false, summary: "no access" },
      { type: "steer", text: "Skip Friday" },
      { type: "text", text: "Done." },
      { type: "stopped", reason: "you" },
      null,
    ],
  },
  { name: "cut", messages: [], question: "Long one", events: [turnEvent(2, false), { type: "model", ref: "x/y" }, { type: "text", text: "Part" }, "The connection to the node dropped."] },
  { name: "steered-before-words", messages: [], question: "Go", events: [{ type: "model", ref: "x/y" }, { type: "steer", text: "Actually, stop" }, { type: "text", text: "OK." }, null] },
];
const threads = streamed.map((s) => ({ ...s, role: "planner", turns: play(s.messages, "planner", s.question, s.events) }));

// ---- the chats list: pinned first, then by when each was last active (lib/chats.ts), at midnight UTC -----------------
const DAY = 86_400_000;
const summary = (id: string, updatedAt: number, pinned = false): core.ConversationSummary => ({
  id,
  title: id,
  project: null,
  role: "planner",
  pinned,
  createdAt: updatedAt - 1000,
  updatedAt,
  count: 2,
  state: "done",
  queued: 0,
  held: null,
  needs: null,
});
const chatList = [
  summary("pinned-old", NOW - 40 * DAY, true),
  summary("just-now", NOW - 60_000),
  summary("this-morning", NOW - (NOW % DAY) + 60_000),
  summary("yesterday", NOW - (NOW % DAY) - 3_600_000),
  summary("five-days", NOW - 5 * DAY),
  summary("seven-days", NOW - (NOW % DAY) - 6 * DAY - 1),
  summary("last-month", NOW - 31 * DAY),
];
const stateCases: Pick<core.ConversationSummary, "state" | "queued" | "held" | "needs">[] = [
  { state: "done", queued: 0, held: null, needs: null },
  { state: "working", queued: 0, held: null, needs: null },
  { state: "working", queued: 2, held: null, needs: null },
  { state: "waiting", queued: 0, held: null, needs: { approvals: 1, keys: 0, question: false } },
  { state: "waiting", queued: 1, held: "stopped", needs: { approvals: 2, keys: 1, question: true } },
  { state: "waiting", queued: 0, held: null, needs: { approvals: 0, keys: 0, question: true } },
  { state: "waiting", queued: 0, held: null, needs: null },
  { state: "queued", queued: 1, held: null, needs: null },
  { state: "queued", queued: 3, held: "restart", needs: null },
  { state: "queued", queued: 1, held: "device", needs: null },
  { state: "queued", queued: 2, held: "error", needs: null },
  { state: "stopped", queued: 0, held: null, needs: null },
  { state: "failed", queued: 0, held: null, needs: null },
];
// A kept chat that changed on another device (the PWA's own keptDiffers): what's on screen against what the node keeps.
const onScreen = kept.slice(0, 4);
const changes = {
  shown: onScreen,
  cases: [
    { name: "the same", kept: onScreen },
    { name: "asked and answered elsewhere", kept: kept.slice(0, 6) },
    { name: "retried elsewhere", kept: [...kept.slice(0, 3), { ...kept[3]!, id: 40, status: "done" as const, content: "Now it worked.", error: null }] },
    { name: "stopped elsewhere", kept: [kept[0]!, { ...kept[1]!, status: "stopped" as const }, ...kept.slice(2, 4)] },
    { name: "deleted from", kept: kept.slice(0, 2) },
  ].map((c) => ({ ...c, differs: keptDiffers(onScreen.map((m, i) => turnOf(m, "planner", i + 1)), c.kept) })),
  // This device's own exchange, its ids not yet known on screen: the same words and states are no change.
  own: [
    { name: "the same words", kept: onScreen },
    { name: "other words", kept: [...onScreen.slice(0, 3), { ...onScreen[3]!, content: "Other words." }] },
  ].map((c) => ({ ...c, differs: keptDiffers(onScreen.map((m, i) => ({ ...turnOf(m, "planner", i + 1), sid: undefined })), c.kept) })),
  // A message of this device's the node never took (it was full): what is shown when the chat is read again (shownAgain).
  refused: { question: "And Sunday?", error: "This node is already working on 3 turns, its limit." },
  again: [
    { name: "nothing changed: it stays, with why", kept: onScreen },
    { name: "asked elsewhere meanwhile: shown, and it after", kept: [...onScreen, stored(90, "user", "And Saturday?"), stored(91, "assistant", "Saturday too.")] },
    { name: "the node took it after all: shown once, as kept", kept: [...onScreen, stored(90, "user", "And Sunday?"), stored(91, "assistant", "Sunday as well.")] },
  ].map((c) => {
    const thread = { turns: onScreen.map((m, i) => turnOf(m, "planner", i + 1)), nextId: onScreen.length + 1, target: null, base: null };
    beginTurn(thread, "And Sunday?", "planner", 10);
    failTurn(thread, "This node is already working on 3 turns, its limit.", 11);
    const again = shownAgain(thread.turns, c.kept, (m) => turnOf(m, "planner", thread.nextId++));
    return { ...c, shown: again ? again.map((t) => ({ role: t.role, content: t.content, status: t.status, error: t.error ?? null })) : null };
  }),
};
const chats = {
  now: NOW,
  list: chatList,
  groups: groupConversations(chatList, NOW).map((g) => ({ label: g.label, ids: g.items.map((c) => c.id) })),
  states: stateCases.map((c) => ({ ...c, words: chatStateWords(c) })),
  changes,
};

// ---- the composer while it works: steer or queue, a side question, what waits above it (the PWA's lib/turns.ts) ----------
const composer = {
  actions: (["steer", "queue"] as const).flatMap((enter) =>
    [false, true].flatMap((busy) => [false, true].flatMap((modifier) => [false, true].map((canQueue) => ({ busy, enter, modifier, canQueue, action: composerAction({ busy, enter, modifier, canQueue }) })))),
  ),
  asides: ["/btw how long will this take?", "  /aside   where is it?\nand why", "/btw", "/BTW Loud", "by the way /btw", "/btween us", "plain words"].map((text) => ({ text, aside: asideOf(text) })),
  steering: [1, 2].map((count) => ({ count, line: steeringLine(count) })),
  heads: [{ queued: 1, held: null, busy: true }, { queued: 3, held: null, busy: false }, ...(["stopped", "error", "restart", "device"] as const).map((held) => ({ queued: 2, held, busy: false }))].map((q) => ({ ...q, ...queueHead(q) })),
  undelivered: [
    { texts: 1, queued: true },
    { texts: 2, queued: true },
    { texts: 1, queued: false },
    { texts: 3, queued: false },
  ].map((u) => ({ ...u, ...undeliveredWords(u) })),
  placeholders: [true, false].map((canQueue) => ({ canQueue, words: busyPlaceholder(canQueue) })),
  filesWait: FILES_WAIT,
  justStarting: JUST_STARTING,
  notKept: NOT_KEPT,
  asideNotes: [true, false].map((working) => ({ working, note: asideNote(working) })),
  broughtBack: (["steered", "kept"] as const).map((how) => ({ how, words: broughtBackWords(how) })),
  nothingYet: ASIDE_NOTHING_YET,
  asidePlaceholders: [true, false].map((working) => ({ working, words: asidePlaceholder(working) })),
  asideAnswering: ASIDE_ANSWERING,
  asideFailed: ASIDE_FAILED,
  bringBackFailed: BRING_BACK_FAILED,
};

// ---- an answer's words: Markdown read as the PWA reads it (lib/markdown.ts) -------------------------------------------
const markdownCases = [
  "## What I found\n\nThree things stand out, and **one needs you**:\n\n1. The *release* is on track.\n2. CI on `main` is green: https://github.com/wckdboy/invincible/actions.\n3. ~~Friday~~ Monday is the new date.\n   - It moved for the review.\n\n> The gate held: nothing ships unreviewed.",
  "| Check | Result | Time |\n|:--|:-:|--:|\n| Unit tests | passed | 41 s |\n| Review | `a|b` \\| c |\n| Short |",
  "```ts\nconst ok = await verify(change);\n```\n\n```chart\n{\"type\":\"line\"}\n```\n\n~~~\ntilde fence\n~~~",
  "Still writing:\n\n```python\nprint('half",
  '```steps [{"text":"Predict","state":"doing"}]\n```\n\n**First, a prediction.**\n\n```Choices ["15°", "45°"]\n```\n\n```ts title="a.ts"\nconst a = 1;\n```\n\n```ts title=x\n```\n\n```x``` stays text\n\n~~~chart {"type":"bar"}  \n~~~',
  "# One\n###### Six\n####### Seven\n## C#\n## Closed ##",
  "---\n* * *\n___\n- - -\n    ---",
  "3. Third\n4. Fourth\n\n   indented under Fourth\n\n5) Fifth",
  "- a\n  - nested\n    - deeper\n- b\nlazy continuation\n\n- after a blank",
  "> quoted\n> - with a list\n>\n> > and a quote",
  "**bold** __also__ snake_case_name *em* _em_ 2 * 3 * 4 ~~gone~~ ***both***",
  "`code` ``a`b`` ` padded ` `unclosed\n\\*not em\\* \\_ \\# \\[x\\]",
  "[a link](https://example.com/x?y=1) [no](javascript:alert(1)) [rel](/path) [Upper](HTTPS://Example.COM)",
  "See https://example.com/a. And (https://example.com/b), xhttps://not.a.link and HTTP://EXAMPLE.ORG:80/p!",
  "Line one\nline two\r\nline three\rline four",
  "Blåbærgrød på fredag 🛡️ — **fed** *kursiv* `kode` 🎉",
  "<b>raw html stays text</b> & < >",
  "*a\n\nb* stays apart, ** no space ** and *trailing *",
  "",
];
const markdown = markdownCases.map((source) => ({ source, blocks: parseMarkdown(source) }));

// ---- what an answer may show beyond words: core's readers (blocks.ts) ------------------------------------------------
const chartCases = [
  JSON.stringify({ type: "line", title: "Tokens a task", unit: "k", labels: ["Mon", "Tue", "Wed"], series: [{ name: "Before", values: [442, 430, 451] }, { name: "After", values: [258, null, 262] }] }),
  JSON.stringify({ labels: ["A", "B"], series: [{ values: [1, 2] }] }),
  JSON.stringify({ type: "stacked", title: "  Spend\n by   role ", labels: ["Q1", "Q2"], series: [{ name: "Plan", values: [3, 4] }, { name: "Build", values: [5, 6] }] }),
  JSON.stringify({ type: "bar", labels: [1, "Two", "  three  "], series: [{ name: "x", values: [1, 2, 3] }, { values: [4, 5, 6] }] }),
  JSON.stringify({ type: "pie", labels: ["a"], series: [{ values: [1] }] }),
  JSON.stringify({ type: "line", labels: [], series: [] }),
  JSON.stringify({ type: "line", labels: ["a", "b"], series: [{ values: [1] }] }),
  JSON.stringify({ type: "line", labels: ["a"], series: [{ values: ["7"] }] }),
  JSON.stringify({ type: "stacked", labels: ["a"], series: [{ values: [-1] }] }),
  JSON.stringify({ type: "line", labels: ["a"], series: [{ name: "Same", values: [1] }, { name: "same", values: [2] }] }),
  JSON.stringify({ type: "line", labels: ["a"], series: [{ values: [null] }] }),
  JSON.stringify({ type: "line", labels: Array.from({ length: 61 }, (_, i) => `d${i}`), series: [{ values: Array.from({ length: 61 }, () => 1) }] }),
  JSON.stringify({ type: "line", labels: ["a"], series: Array.from({ length: 7 }, (_, i) => ({ name: `s${i}`, values: [i] })) }),
  JSON.stringify({ type: "line", title: "x".repeat(90), unit: "kilometres an hour", labels: ["a".repeat(40)], series: [{ name: "n".repeat(40), values: [1.5] }] }),
  "not json",
  "[1,2]",
];
const statsCases = [
  JSON.stringify([{ label: "Read from a cache", value: "73%", delta: 71, note: "since Monday", good: "up" }, { label: "Cost a task", value: 0.54, unit: "$", delta: -0.51, good: "down" }]),
  JSON.stringify({ stats: [{ label: "Tests", value: 2120 }, { label: "Skipped", value: 13, delta: 0, good: "sideways" }] }),
  JSON.stringify([{ label: "x" }]),
  JSON.stringify([]),
  JSON.stringify(Array.from({ length: 7 }, (_, i) => ({ label: `l${i}`, value: i }))),
  JSON.stringify([{ label: "Infinite", value: 1e400, delta: "3" }]),
];
const choiceCases = [JSON.stringify(["Ship it", "Hold until Monday"]), JSON.stringify({ options: ["Yes", " yes ", "No", 3] }), JSON.stringify(["Only one"]), JSON.stringify(Array.from({ length: 7 }, (_, i) => `c${i}`)), JSON.stringify("text")];
const stepCases = [
  JSON.stringify([{ text: "Read the failing test", state: "done" }, { text: "Fix the parser", state: "doing" }, { text: "Ship it", state: "todo" }, "A bare line", { text: "Odd", state: "maybe" }]),
  JSON.stringify({ steps: [{ text: "failed one", state: "failed" }, { text: "skipped one", state: "skipped" }] }),
  JSON.stringify([{ state: "done" }]),
  JSON.stringify([]),
];
// A page past the limit is written down as how many x's it holds (the test makes it), not as 200,000 characters here.
const artifactCases: (string | { xs: number })[] = ["<!doctype html><title>Q3 &amp; plans</title><p>Hi</p>", "no tags here", { xs: 200_001 }, "<title>  spaced\n title </title>"];
const numbers = [0, 7, 7.256, 42.25, 999.5, 1284, 9999, 10_000, 12_900, 999_999, 1_000_000, 4_200_000, -15_500, 2.5e9, 7e12, 0.054];
const blocks = {
  charts: chartCases.map((text) => ({ text, read: core.readChart(text) })),
  stats: statsCases.map((text) => ({ text, read: core.readStats(text) })),
  choices: choiceCases.map((text) => ({ text, read: core.readChoices(text) })),
  steps: stepCases.map((text) => ({ text, read: core.readSteps(text) })),
  artifacts: artifactCases.map((item) => {
    const read = core.readArtifact(typeof item === "string" ? item : `<p>${"x".repeat(item.xs)}</p>`);
    return { text: typeof item === "string" ? item : null, xs: typeof item === "string" ? null : item.xs, ok: read.ok, why: read.ok ? null : read.why, title: read.ok ? core.artifactTitle(read.value) : null };
  }),
  numbers: numbers.map((n) => ({ n, text: core.compactNumber(n) })),
};

// ---- an agent's timeline: its words and its work, in order (lib/timeline.ts, lib/task-card.ts, lib/team.ts) -----------
const said = (id: string, speaker: string, text: string, minutesAgo: number, speakerName = ""): core.TeamMessage => ({
  id: `msg-${id}`, room: "dm-ada", speaker, speakerName, text, createdAt: at(minutesAgo), chainId: `chain-m-${id}`,
});
const adaMessages = [
  said("1", "owner", "Can you make sync resume after a drop?", 120),
  said("2", "ada", "On it. I'll keep the gate green.", 119, "Ada"),
  said("3", "primary", "Ada, the release is Monday.", 95),
  said("4", "system", "Ada was given a task by the agents.", 90),
  said("5", "owner", "Thanks!", 10),
  said("6", "tester", "", 5),
];
const adaTasks = [
  task("sync", "ada", "done", { verified: true, createdAt: at(90), output: "Sync now resumes from the last acknowledged event.\n\nReview: PASS", changes: { artifact: `art_${"b".repeat(22)}`, files: 2, base: "4f7a1c2e9b8d0a1f2e3c4b5a69788796a5b4c3d2" }, interventions: { message: 2, approval: 1 } }),
  task("run", "ada", "running", { createdAt: at(30), progress: "Running · bun test packages/link\nmore" }),
  task("same", "ada", "queued", { createdAt: at(30), givenBy: "owner" }),
  task("old", "ada", "failed", { createdAt: at(200), error: "gave-up", output: "Review: FAIL", interventions: { again: 2, takeover: 1, stop: 1, resume: 12, message: 0, rewritten: 1 } }),
  task("cut", "ada", "interrupted", { createdAt: at(60) }),
  task("halt", "ada", "stopped", { createdAt: at(40), error: "stopped", givenBy: "primary" }),
  task("half", "ada", "done", { createdAt: at(20), verified: false, output: "x".repeat(1200) }),
  task("elsewhere", "bea", "running", { createdAt: at(15), room: "room-wckd" }),
  task("roomwork", "bea", "queued", { createdAt: at(12), room: "dm-ada" }),
  task("ask", "ada", "proposed", { createdAt: at(150), proposedBy: "ada" }),
  task("asked", "ada", "running", { createdAt: at(8), proposedBy: "bea" }),
  task("declined", "ada", "stopped", { createdAt: at(7), proposedBy: "ada", error: "Declined by you." }),
  // Shipped from an app: its pull request said, and nothing more to ship; a fix goes onto its own pull request's branch.
  task("shipped", "ada", "done", { verified: true, createdAt: at(120), output: "Units parse.\n\nReview: PASS", changes: { artifact: `art_${"c".repeat(22)}`, files: 1, base: "4f7a1c2e9b8d0a1f2e3c4b5a69788796a5b4c3d2" }, shipped: { url: "https://github.com/wckdboy/invincible/pull/12", pr: 12 } }),
  // Given again with what came of it: why, what it said, what the review said (a goal that held an earlier try's lesson loses it).
  task("revised", "ada", "failed", { createdAt: at(100), error: "unverified", goal: "Parse SI units.\n\nLast time (task-older000000), it ended without verified work: It gave up.", output: "I made kilo work.\n\nReview: REVISE\nMega still parses as milli: src/units.ts:14.\nWorkspace: /work/tasks/task-revised00000" }),
  task("fixing", "ada", "done", { verified: true, createdAt: at(110), output: "Checks pass.\n\nReview: PASS", changes: { artifact: `art_${"d".repeat(22)}`, files: 1, base: "4f7a1c2e9b8d0a1f2e3c4b5a69788796a5b4c3d2" }, fix: { connector: "github", owner: "amiriteorg", repo: "primary", branch: "invincible/units", pr: 12, head: "4f7a1c2e9b8d0a1f2e3c4b5a69788796a5b4c3d2" } }),
  // In sensitive mode alone: every call of its work on the models it is held to.
  task("held", "ada", "queued", { createdAt: at(5), models: ["nearai/Qwen/Qwen3.8-27B-abliterated"] }),
];
const adaRoom = { id: "dm-ada", direct: true, members: ["ada"] };
const sharedRoom = { id: "dm-ada", direct: false, members: ["ada", "bea"] };
const timelines = {
  messages: adaMessages,
  tasks: adaTasks,
  agent: timeline(adaMessages, timelineTasks(adaRoom, adaTasks)).map((item) => item.key),
  room: timeline(adaMessages, timelineTasks(sharedRoom, adaTasks)).map((item) => item.key),
  sinceAt: at(100),
  since: timeline(adaMessages, timelineTasks(adaRoom, adaTasks), { since: at(100) }).map((item) => item.key),
  speakers: adaMessages.map((message) => teamSpeaker(message, snapshot.agents)),
  // A task's one grey word, as a chat's compact row says it (lib/task-card.ts taskWord), for every status a task has.
  words: (["proposed", "queued", "running", "done", "failed", "stopped", "interrupted"] as const).map((status) => ({ status, word: taskWord({ status }) })),
  cards: adaTasks.map((t) => ({ id: t.id, word: taskWord(t), badge: taskBadge(t), end: taskEnd(t), actions: taskActions(t), given: givenLine(t), sensitive: sensitiveLine(t), kept: keptChanges(t)?.text ?? null, proposed: proposedLine(t, t.proposedBy === "ada" ? "Ada" : null), stepped: steppedLine(t), shipped: shippedLine(t)?.text ?? null, again: againGoal(t) })),
};

// ---- where a notice came from, in words (the PWA's lib/notices.ts) ----------------------------------------------------
const notices = ["rule:pushes", "loop:morning", "heartbeat", "ci", "compute", "routing", "rule:a:b", "rule:", ":x", "constructor:x", "something-new"].map((source) => ({ source, from: noticeFrom(source) }));

// ---- notifications: what a native app does when it opens, and which kinds it tells quietly (core's notify.ts) --------
const notifyReach = (["granted", "denied", "undetermined"] as const).flatMap((permission) =>
  [
    [true, false],
    [false, true],
    [false, false],
  ].flatMap(([subscribed, lost]) =>
    [0, 2].flatMap((reachable) => [false, true].map((localOn) => ({ permission, subscribed: subscribed!, lost: lost!, reachable, localOn, step: core.notifyReach({ permission, subscribed: subscribed!, lost: lost!, reachable, localOn }) }))),
  ),
);
const notifyQuiet = ["needs-you", "approval", "question", "finished", "told", "summary", "limit", "test", "advert"].map((kind) => ({ kind, quiet: core.isQuietKind(kind) }));

// ---- a notification's payload, read strictly (core's readNotifyPayload): as the web's service worker reads it, and the
// Android and Mac apps what they collect; and, for each one read, what the node sends the iPhone for it (apns-send.ts
// applePayload), whose buttons, thread, sound and own fields the Mac's notifications carry too --------------------------
const NOTE_CHAT = `cv_${"Ab3_-".repeat(4)}xy`;
const NOTE_TASK = "task-abc123def456";
const NOTE_ACTION = `a_${"0123456789".repeat(2)}kl`;
const note = { v: 1, kind: "needs-you", title: "Your agent: this needs you", body: "It waits in Needs you.", open: "inbox", tag: "t-0123456789abcdefghijkl" };
const notePayloads: unknown[] = [
  // Read as they are.
  note,
  { ...note, kind: "approval", title: "Your agent asks your approval", action: NOTE_ACTION, approvable: true },
  { ...note, kind: "approval", action: NOTE_ACTION, approvable: false },
  { ...note, kind: "approval", action: NOTE_ACTION },
  { ...note, kind: "finished", title: "Your agent's task: Proven", body: "Proven · $0.31. Its changes are ready to ship.", open: "task", task: NOTE_TASK, ship: true },
  { ...note, kind: "finished", open: "task", task: NOTE_TASK, ship: false },
  { ...note, kind: "finished", open: "task", task: NOTE_TASK },
  { ...note, kind: "told", open: "chat", conversation: NOTE_CHAT },
  ...["question", "summary", "limit", "test"].map((kind) => ({ ...note, kind })),
  ...["chat", "overview", "settings", "task"].map((open) => ({ ...note, open })),
  { ...note, body: "" },
  { ...note, title: "Café and café, as they came" },
  { ...note, title: "x".repeat(60), body: "y".repeat(140) },
  { ...note, title: "😀".repeat(30) },
  // Refused.
  null,
  [],
  "a line",
  1,
  {},
  { ...note, v: 2 },
  { ...note, v: "1" },
  { ...note, kind: "advert" },
  { ...note, extra: true },
  { ...note, title: 1 },
  { ...note, body: null },
  { ...note, tag: "has space" },
  { ...note, tag: "primary\n" },
  { ...note, tag: "x".repeat(65) },
  { ...note, tag: "" },
  { ...note, open: "vault" },
  { ...note, conversation: NOTE_CHAT },
  { ...note, open: "chat", conversation: "cv_short" },
  { ...note, open: "chat", conversation: null },
  { ...note, task: NOTE_TASK },
  { ...note, open: "task", task: "task-ABC123DEF456" },
  { ...note, open: "task", task: NOTE_TASK, ship: "yes" },
  { ...note, ship: true },
  { ...note, action: NOTE_ACTION },
  { ...note, kind: "approval", action: "a_short" },
  { ...note, approvable: true },
  { ...note, kind: "approval", action: NOTE_ACTION, approvable: "yes" },
  { ...note, title: "" },
  { ...note, title: " Leading space" },
  { ...note, title: "Two  spaces" },
  { ...note, title: "A\ttab" },
  { ...note, title: "Non breaking" },
  { ...note, title: "Zero​width" },
  { ...note, title: "Bidi‮override" },
  { ...note, body: "A line\nbreak" },
  { ...note, body: "A bell\u0007" },
  { ...note, title: "x".repeat(61) },
  { ...note, body: "y".repeat(141) },
  { ...note, title: "😀".repeat(30) + "!" },
];
const notifyPayload = {
  titleMax: core.NOTIFY_TITLE_MAX,
  bodyMax: core.NOTIFY_BODY_MAX,
  generic: core.GENERIC_NOTIFICATION,
  read: notePayloads.map((raw) => {
    const read = core.readNotifyPayload(raw);
    return { raw, read, apple: read ? JSON.parse(applePayload(read)) : null };
  }),
  // notifyClean: one line, nothing hidden, cut to its length in UTF-16 units with an ellipsis.
  clean: (
    [
      ["  Two  spaces\tand a tab  ", 60],
      ["Zero​width⁠joiner﻿mark", 60],
      ["Bidi‮override⁦isolate⁩", 60],
      ["A line\nbreak\r\nand a separator", 60],
      ["A bell\u0007and C1\u009fcontrols", 60],
      ["Non breaking　ideographic ogham", 60],
      ["x".repeat(61), 60],
      ["word ".repeat(30), 60],
      ["a" + "😀".repeat(30), 60],
      ["😀".repeat(30), 60],
      ["", 60],
      ["   ", 60],
    ] as [string, number][]
  ).map(([text, max]) => ({ text, max, clean: core.notifyClean(text, max) })),
};

// ---- code, coloured by what each part is (the PWA's lib/highlight.ts) -------------------------------------------------
const highlights = [
  ["swift", `let x = "hi \\" there" // say it\nif c == 'a' { return 0x1F }\nlet big = 1_000.5e-3, odd = 0b2, y1 = x`],
  ["rust", "/* a\nblock */ fn main<'a>() { let s = '\\n'; }"],
  ["ts", "const s = `a\nb`; const t = 'x'; // café ☕\nexport type A = typeof s;"],
  ["go", 'x := `raw\nline` /* c */ + "s"'],
  ["python", "def f():\n    \"\"\"doc\n    string\"\"\"\n    return None  # nothing\nx = 'it\\'s'"],
  ["bash", 'echo "a#b" # say\nif [ $x ]; then exit 1; fi\nurl=http://x#frag'],
  ["SQL", "SELECT id FROM t -- all\nwhere n > 2 /* why */"],
  ["json", '{"a": [1.5e3, true, null], "b": "c\\"d"}'],
  ["yaml", "key: 'v' # note\nother: true"],
  ["ruby", "def go; puts 'hi' # yes\nend"],
  ["diff", "diff --git a/x b/x\nindex 1..2\n--- a/x\n+++ b/x\n@@ -1 +1 @@\n-old\n+new\n same\r\n same too"],
  ["html", "<b>x</b>"],
  ["", "let x"],
  ["swift", 'say("open'],
  ["ts", "/* never closed"],
  ["py", "'''x"],
].map(([lang, code]) => ({ lang, code, pieces: highlight(code!, lang!) }));

// ---- the work by attention (the PWA's lib/work.ts, 26 November 2026): every task a row of three lines, in four sections
// by what it asks of you (needs you, new to you, at work, settled), under its agent's project ---------------------------
const usage = (model: string, calls: number, input: number, output: number, extra: Partial<core.UsageLine> = {}): core.UsageLine => ({ role: "engineer", model, calls, unknown: 0, input, output, cached: 0, reasoning: 0, ...extra });
const PRICES: core.Prices = { "deepseek/deepseek-v4-pro": { input: 0.6, output: 2.4, cached: 0.06 }, "mistral/*": { input: 0.4, output: 2 } };
const record = (startedMinutesAgo: number, endedMinutesAgo: number, spent: core.UsageLine[], ended: core.TeamTaskRecord["ended"] = "done"): core.TeamTaskRecord => ({ startedAt: at(startedMinutesAgo), endedAt: at(endedMinutesAgo), ended, commands: 12, revisions: 1, spent });
const workSnapshot: Pick<core.TeamSnapshot, "agents" | "tasks" | "seen"> = {
  agents: [
    agent("ada", "Ada", { repository: "https://github.com/wckdboy/invincible" }),
    // The same repository, written otherwise: one project.
    agent("bea", "Bea", { repository: "https://GitHub.com/wckdboy/invincible.git/" }),
    agent("cy", "Cy", { repository: "https://forge.example/team/sync-kit" }),
    agent("dee", "Dee"),
    agent("eli", "Eli", { repository: "https://forge.example/team/9lives" }),
    // Not an https address: other work.
    agent("fin", "Fin", { repository: "git@github.com:team/fin.git" }),
    agent("gus", "Gus", { enabled: false, repository: "https://forge.example/team/sync-kit" }),
  ],
  tasks: [
    task("self", "ada", "proposed", { proposedBy: "ada", updatedAt: at(3) }),
    task("for", "bea", "proposed", { proposedBy: "primary", updatedAt: at(4) }),
    task("bare", "cy", "proposed", { updatedAt: at(5) }),
    task("cut", "dee", "interrupted", { updatedAt: at(6) }),
    task("leave", "eli", "running", { progress: "Running · gh pr create", updatedAt: at(1) }),
    task("leave2", "fin", "running", { progress: "Thinking · which branch", updatedAt: at(2) }),
    task("tests", "ada", "running", { progress: "Running · bun test packages/link\nmore", createdAt: at(90), updatedAt: at(0.5) }),
    task("fresh", "bea", "running", { progress: "Plan · read the code", createdAt: NOW - 10_000, updatedAt: NOW - 5_000 }),
    task("gating", "cy", "running", { progress: "Gate 1/2 · exit 0 · bun test\n12 pass", createdAt: at(14), updatedAt: at(1) }),
    task("long", "dee", "running", { progress: `Checking ${"the very long line ".repeat(6)}`, createdAt: at(200), updatedAt: at(2) }),
    task("after", "cy", "queued", { dependsOn: [task("gating", "cy", "running").id], updatedAt: at(7) }),
    task("held", "gus", "queued", { updatedAt: at(8) }),
    task("plain", "eli", "queued", { updatedAt: at(9) }),
    task("halt", "fin", "stopped", { updatedAt: at(10) }),
    task("pr", "ada", "done", { verified: true, shipped: { url: "https://github.com/wckdboy/invincible/pull/12", pr: 12 }, updatedAt: at(20) }),
    task("sent", "bea", "done", { verified: true, shipped: { url: "https://forge.example/x", pr: null }, updatedAt: at(25) }),
    task("one", "cy", "done", { verified: false, changes: { artifact: `art_${"b".repeat(22)}`, files: 1, base: "4f7a1c2e9b8d0a1f2e3c4b5a69788796a5b4c3d2" }, updatedAt: at(30) }),
    task("three", "eli", "done", { verified: true, changes: { artifact: `art_${"c".repeat(22)}`, files: 3, base: "4f7a1c2e9b8d0a1f2e3c4b5a69788796a5b4c3d2" }, updatedAt: at(800) }),
    task("gate2", "ada", "failed", { progress: "Gate 2/3 · exit 1 · bun run typecheck\nerror TS2322", error: "gave-up", updatedAt: at(35) }),
    task("why", "dee", "failed", { error: `The gate needs a Postgres this VM doesn't have, and the image has none either.\nDetails.`, updatedAt: at(40) }),
    task("quiet", "fin", "failed", { error: null, updatedAt: at(2000) }),
  ],
  // Ada's page looked at after her failure, Cy's room before its result, Eli's never: what ended since is new to you.
  seen: { "agent:ada": at(34), "room:dm-cy": at(31), "agent:bea": at(1) },
};
const workProjects = [{ name: "Invincible", repo: "https://github.com/wckdboy/invincible" }, { name: "Notes", repo: null }, { name: "Elsewhere", repo: "https://forge.example/team/none" }];
const workAsks = [{ by: "arm:team.0123456789.eli", connector: "forge", tool: "post" }, { by: "arm:team.0123456789.fin" }, { by: "loop:morning", connector: "github", tool: "comment" }];
const shownWork = (work: Attended) => ({
  ...Object.fromEntries(
    (["needs", "active", "working", "done"] as const).map((section) => [
      section,
      work[section].map((row) => ({ id: row.id, room: row.room, title: row.title, project: row.project, agent: { id: row.agent.id, name: row.agent.name }, state: row.state, attention: row.attention, word: row.word, tone: row.tone, age: row.age, detail: row.detail, mono: row.mono, at: row.at })),
    ]),
  ),
  projects: work.projects,
});
const workRead = attended({ snapshot: workSnapshot, projects: workProjects, asks: workAsks, now: NOW });
// A node that keeps no read marks: a result is new to you for half a day after it ended.
const workUnmarked = attended({ snapshot: { ...workSnapshot, seen: undefined }, projects: workProjects, asks: workAsks, now: NOW });
const work = {
  now: NOW,
  newForMs: NEW_FOR_MS,
  snapshot: workSnapshot,
  projects: workProjects,
  asks: workAsks,
  attended: shownWork(workRead),
  unmarked: shownWork(workUnmarked),
  order: byAttention(workRead).map((row) => row.id),
  only: [projectKey("https://github.com/wckdboy/invincible"), "forge.example/team/sync-kit", "other", "nowhere"].map((key) => ({ key, ids: byAttention(inProject(workRead, key)).map((row) => row.id) })),
  spans: [0, 59_999, 60_000, 3_599_999, 3_600_000, 86_399_999, 86_400_000, 3 * 86_400_000 + 5, -5].map((ms) => ({ ms, span: shortSpan(ms) })),
  badges: ["Invincible", "9lives", "  sync", "élan", "über-kit", "— dash", "", "日本"].map((name) => ({ name, badge: projectBadge(name) })),
  keys: ["https://github.com/wckdboy/invincible", "https://GitHub.com/wckdboy/invincible.git/", " https://forge.example/a/b/ ", "http://forge.example/a/b", "git@github.com:a/b.git", "https://github.com", "https://github.com/", "not a url", ""].map((repo) => ({ repo, key: projectKey(repo) })),
  doing: ["Running · bun test packages/link\nmore", "Plan · read the code", "Thinking · which test", "Submitted for review · sync resumes", "Review · pass", "Exit 0 · 12 passed", "Gate 2/3 · exit 0 · bun test", "Gates · all 2 passed", `Something ${"long ".repeat(20)}`, "", "Running · "].map((progress) => ({ progress, ...doingNow(progress) })),
  failedGates: ["Gate 2/3 · exit 1 · bun run typecheck\nmore", "Gate 1/2 · exit 0 · bun test", "Gate 3/3 · exit -1 · bun test", "Running · bun test", ""].map((progress) => ({ progress, gate: failedGate(progress) })),
  // (`count`: how many need you, in; `needs`: whether the line says so, out.)
  glances: [0, 1, 3].flatMap((count) => [workRead, attended({ snapshot: { ...workSnapshot, tasks: [] }, projects: workProjects, now: NOW })].map((w, i) => ({ count, its: "At rest.", working: i === 0, ...atAGlance(w, count, "At rest.") }))),
  beyond: [0, 1, 4].map((inbox) => ({ inbox, beyond: inboxBeyond(inbox, workAsks, workRead.needs) })),
  opened: workSnapshot.tasks.map((t) => ({ id: t.id, marks: seenOnOpen(t.id, workSnapshot) })).concat([{ id: "task-nothing", marks: seenOnOpen("task-nothing", workSnapshot) }]),
  prices: PRICES,
  spent: (() => {
    const tasks: Pick<core.TeamTask, "assignee" | "record">[] = [
      { assignee: "ada", record: record(300, 200, [usage("deepseek/deepseek-v4-pro", 4, 120_000, 8_000, { cached: 40_000 })]) },
      { assignee: "ada", record: record(60, 30, [usage("mistral/mistral-large", 2, 30_000, 2_000)]) },
      { assignee: "bea", record: record(60, 30, [usage("unknown/model", 3, 10_000, 1_000)]) },
      { assignee: "cy", record: record(60, 30, [usage("deepseek/deepseek-v4-pro", 2, 0, 0, { unknown: 2 })]) },
      { assignee: "dee", record: record(60, 30, [usage("deepseek/deepseek-v4-pro", 3, 9_000, 900, { unknown: 1 })]) },
      { assignee: "eli" },
    ];
    return ["ada", "bea", "cy", "dee", "eli"].flatMap((id) => [at(250), at(100)].map((since) => ({ agent: id, since, spent: spentSince(tasks, id, since, PRICES) }))).concat([{ agent: "ada", since: 0, spent: spentSince(tasks, "ada", 0, PRICES) }]);
  })(),
};

// ---- a task's work, folded, and what proves it (the PWA's lib/steps.ts, 26 November 2026): its steps grouped as T3 Code
// folds them, each gate as its latest round left it, the reviewer's verdict, its live line and its cost -----------------
const trailOf = (lines: [minutesAgo: number, text: string][]): core.TeamTrailEntry[] => lines.map(([minutesAgo, text], i) => ({ n: i + 1, at: at(minutesAgo), text }));
const W = "/work/tasks/task-sync00000000";
const fullTrail = trailOf([
  [30, "Plan · read the sync code\nwrite a failing test\nmake it pass"],
  [29.9, "Thinking · where resume belongs"],
  [29.8, "Gates · 1. bun test packages/link\n2. bun run typecheck"],
  [29.7, "Gates before the work · 1. exit 1 · bun test packages/link\n2. exit 0 · bun run typecheck · passes already, so it shows nothing about this work"],
  [29.5, `Running · sed -n '1,80p' ${W}/packages/link/src/sync.ts`],
  [29.4, "Exit 0 · export function sync() {"],
  [29.3, `Running · sed -n '1,40p' '${W}/packages/link/src/resume.ts'`],
  [29.2, "Exit 0 · export function resume() {"],
  [29.1, `Running · sed -n '1,40p' '${W}/packages/link/src/it'\\''s.ts'`],
  [29, "Exit 0 · ok"],
  [28, `Running · edit '${W}/packages/link/src/sync.ts' <<'EOF'\n-old\n+new\nEOF`],
  [27.9, "Exit 0 · edited"],
  [27.5, `Running · cat > ${W}/packages/link/test/resume.test.ts <<'EOF'\ntest("resumes", () => {})\nEOF`],
  [27.4, "Exit 0 · written"],
  [27, "Running · bun test packages/link\n--bail"],
  [26, "Exit 1 · 1 fail"],
  [25, "Running · bun test packages/link"],
  [24, "Exit 0 · 13 pass"],
  [23.5, "Running · git status --short"],
  [23.4, "Exit 0 · M sync.ts"],
  [23, "Tripwire · no-force-push refused a command: force-pushing rewrites history\n$ git push -f"],
  [22, "Submitted for review · sync resumes after a dropped connection"],
  [20, "Gate 1/2 · exit 0 · bun test packages/link\nstderr:\n13 pass\n0 fail"],
  [19, "Gate 2/2 · exit 0 · bun run typecheck\n(no output)"],
  [18, "Review · by the same model that did the work (deepseek/deepseek-v4-pro): no other reviewer model could answer"],
  [17, "Review · pass\nThe test covers the drop.\nShip it."],
  // (A command's line carries the length of all the run showed the model of it, beside its words: data the apps don't
  // say. Every app reads this trail with it, and folds it as it did without: the groups and summaries are unchanged.)
]).map((entry): core.TeamTrailEntry => (entry.text.startsWith("Exit ") ? { ...entry, outputChars: 12 * entry.text.length } : entry));
const roundsTrail = trailOf([
  [60, "Gates · 1. bun test\n2. bun run typecheck\n3. bun run lint"],
  [59, "Running · bun test"],
  [58, "Exit 0 · ok"],
  [50, "Submitted for review · first try"],
  [48, "Gate 1/3 · exit 2 · bun test\n\nexit 2\nFAIL resume.test.ts"],
  [47, "Gates · 1 of 3 failed: back to the work"],
  [46, "Running · bun test"],
  [45, "Exit 0 · ok"],
  [40, "Submitted for review · second try"],
  [37, "Gate 1/3 · exit 0 · bun test\n13 pass"],
]);
const editsOnly = trailOf([[10, `Running · edit '${W}/a/one.ts' <<'EOF'\nx\nEOF`], [9, "Exit 0 · ok"], [8, `Running · edit '${W}/a/two.ts' --all <<'EOF'\nx\nEOF`], [7, "Exit 0 · ok"], [6, `Running · edit '${W}/a/b/three.ts' <<'EOF'\nx\nEOF`], [5, "Exit 0 · ok"], [4, `Running · edit '${W}/a/b/four.ts' <<'EOF'\nx\nEOF`], [3, "Exit 0 · ok"], [2, "Review · revise\nThe test doesn't cover the drop."]]);
// What a gate printed under the runner's own line ("exit 0 · 412 ms"), which its row says already (26 November 2026: a
// gate read "exit 0 · 0:00 · exit 0 · 1 ms"): what it said is the line after it.
const timedTrail = trailOf([
  [12, "Gates · 1. bun test\n2. bun run typecheck"],
  [11, "Submitted for review · timed"],
  [10, "Gate 1/2 · exit 0 · bun test\nexit 0 · 1 ms\nrequired gate passed"],
  [9, "Gate 2/2 · exit 1 · bun run typecheck\nexit 1 · 412 ms\nstderr:\nerror TS2322"],
]);
const lastLines = ["Running · bun test packages/link\nmore", "Submitted for review · x", "Gate 1/2 · exit 0 · bun test", "Gate 2/2 · exit 0 · bun run typecheck", "Plan · x", "Review · pass", "Review · revise\nmore", "Exit 0 · ok", "Thinking · x", "Budget · $0.40 of $0.50 spent: wrapping up", "Gates · all 2 passed"];
const stepTask = (status: core.TeamWorkStatus, gates: string[], extra: Partial<core.TeamTask> = {}) => ({ ...task("steps", "ada", status, { gates }), ...extra });
const steps = {
  commands: [
    `sed -n '1,80p' ${W}/packages/link/src/sync.ts`,
    `sed -n '1,80p' '${W}/a b/c.ts'`,
    `sed -n '1,80p' '${W}/it'\\''s.ts'`,
    `sed -n '1,80p' '${W}/unclosed.ts`,
    `sed -n '1,80p' ${W}/a.ts ${W}/b.ts`,
    `edit '${W}/a.ts' <<'EOF'\nx\nEOF`,
    `edit ${W}/a.ts --all <<'EOF'\nx\nEOF`,
    `edit ${W}/a.ts`,
    `cat > ${W}/new.ts <<'EOF'\nx\nEOF`,
    `cat > ${W}/new.ts`,
    "bun test packages/link",
    "",
  ].map((command) => ({ command, ...commandKind(command) })),
  trails: { full: fullTrail, rounds: roundsTrail, edits: editsOnly, timed: timedTrail },
  groups: { full: stepGroups(fullTrail), rounds: stepGroups(roundsTrail), edits: stepGroups(editsOnly), none: stepGroups([]) },
  summaries: [
    { trail: "full", record: null, summary: workSummary(fullTrail) },
    { trail: "full", record: { startedAt: at(31), endedAt: at(16) }, summary: workSummary(fullTrail, { startedAt: at(31), endedAt: at(16) }) },
    { trail: "rounds", record: null, summary: workSummary(roundsTrail) },
    { trail: "edits", record: null, summary: workSummary(editsOnly) },
    { trail: "none", record: null, summary: workSummary([]) },
    { trail: "one", record: null, summary: workSummary(fullTrail.slice(0, 1)) },
  ],
  workedFor: [0, 499, 500, 42_000, 59_499, 59_500, 372_000, 3_599_000, 3_600_000, 3_840_000, 90_000_000, -5].map((ms) => ({ ms, words: workedFor(ms) })),
  summaryWords: [
    { commands: 14, failed: 1, read: 2, edited: 5, ms: 0 },
    { commands: 1, failed: 0, read: 1, edited: 0, ms: 0 },
    { commands: 0, failed: 0, read: 3, edited: 1, ms: 0 },
    { commands: 0, failed: 0, read: 0, edited: 0, ms: 0 },
  ].map((summary) => ({ summary, words: summaryWords(summary) })),
  gates: [
    { trail: "full", gates: ["bun test"], running: false, rows: gateRows(["bun test"], fullTrail, false) },
    { trail: "rounds", gates: [], running: true, rows: gateRows([], roundsTrail, true) },
    { trail: "rounds", gates: [], running: false, rows: gateRows([], roundsTrail, false) },
    { trail: "edits", gates: ["bun test", "bun run lint"], running: true, rows: gateRows(["bun test", "bun run lint"], editsOnly, true) },
    { trail: "none", gates: ["bun test"], running: true, rows: gateRows(["bun test"], [], true) },
    { trail: "timed", gates: [], running: false, rows: gateRows([], timedTrail, false) },
  ],
  reviews: { full: reviewOf(fullTrail), rounds: reviewOf(roundsTrail), edits: reviewOf(editsOnly), none: reviewOf([]) },
  sameModel: { full: sameModelReview(fullTrail), edits: sameModelReview(editsOnly) },
  live: [...lastLines.map((text) => ({ text, live: liveStep(trailOf([[3, text]])) })), { text: null, live: liveStep([]) }],
  proofs: [
    { trail: "full", task: { status: "done", gates: ["bun test"] }, proof: proofOf(stepTask("done", ["bun test"]), fullTrail) },
    { trail: "rounds", task: { status: "running", gates: [] }, proof: proofOf(stepTask("running", []), roundsTrail) },
    { trail: "edits", task: { status: "running", gates: ["bun test"] }, proof: proofOf(stepTask("running", ["bun test"]), editsOnly) },
    { trail: "none", task: { status: "failed", gates: ["bun test"] }, proof: proofOf(stepTask("failed", ["bun test"]), []) },
    { trail: "none", task: { status: "running", gates: [] }, proof: proofOf(stepTask("running", []), []) },
    {
      trail: "passing",
      task: { status: "running", gates: ["bun test"] },
      proof: proofOf(stepTask("running", ["bun test"]), trailOf([[9, "Gates before the work · 1. exit 0 · bun test · passes already, so it shows nothing about this work"], [8, "Submitted for review · x"], [7, "Gate 1/1 · exit 0 · bun test\nok"]])),
      entries: trailOf([[9, "Gates before the work · 1. exit 0 · bun test · passes already, so it shows nothing about this work"], [8, "Submitted for review · x"], [7, "Gate 1/1 · exit 0 · bun test\nok"]]),
    },
  ],
  prices: PRICES,
  costs: [
    { budgetUsd: undefined, record: undefined },
    { budgetUsd: 2, record: undefined },
    { budgetUsd: 2, record: record(40, 34, [usage("deepseek/deepseek-v4-pro", 4, 120_000, 8_000, { cached: 40_000 })]) },
    { budgetUsd: undefined, record: record(40, 34, [usage("deepseek/deepseek-v4-pro", 4, 120_000, 8_000)]) },
    { budgetUsd: 0.5, record: record(40, 34, [usage("deepseek/deepseek-v4-pro", 4, 120_000, 8_000, { unknown: 1 })]) },
    { budgetUsd: 1, record: record(40, 34, [usage("unknown/model", 2, 1_000, 100)]) },
    { budgetUsd: 1, record: record(40, 34, [usage("deepseek/deepseek-v4-pro", 2, 0, 0, { unknown: 2 })]) },
    { budgetUsd: undefined, record: record(40, 34, [usage("deepseek/deepseek-v4-pro", 2, 0, 0, { unknown: 2 })]) },
    { budgetUsd: 3, record: record(40, 34, []) },
    { budgetUsd: undefined, record: record(130, 4, []) },
    // (Money in two decimals however much: $14.40 of $25.00, never $14.4 of $25.0.)
    { budgetUsd: 25, record: undefined },
    { budgetUsd: 25, record: record(40, 34, [usage("deepseek/deepseek-v4-pro", 4, 20_000_000, 1_000_000)]) },
    // A handed task's call counted at its most (its provider silent in time): an upper bound, "at most $0.30 of $2.00";
    // beside a call that reported nothing, neither bound: "about".
    { budgetUsd: 2, record: record(40, 34, [usage("deepseek/deepseek-v4-pro", 3, 47_200, 60_000, { atMost: 2 })]) },
    { budgetUsd: undefined, record: record(40, 34, [usage("deepseek/deepseek-v4-pro", 3, 47_200, 60_000, { atMost: 2 }), usage("mistral/large", 2, 1_000, 100, { unknown: 1 })]) },
  ].map(({ budgetUsd, record: r }) => ({ budgetUsd: budgetUsd ?? null, record: r ?? null, words: costWords({ budgetUsd, record: r }, PRICES) })),
};

// ---- steering an agent's running task (the PWA's lib/steer.ts, and its trail's steps in lib/steps.ts): the task thread's
// message box while it runs and the line under it, what is on its way to the work, what never reached it, what its proof
// was judged against, and the steers its trail holds. A section of its own: no other one changes. ------------------------
const steerOf = (by: core.TeamSteer["by"], text: string, taken?: number): core.TeamSteer => ({ by, text, at: at(20), ...(taken !== undefined ? { taken: { at: at(10), step: taken } } : {}) });
const steeredTrail = trailOf([
  [40, "Plan · write the parser\nDone when: its test passes."],
  [39, "Running · bun test parser"],
  [38.9, "Exit 1 · 1 fail"],
  [38, "Steered · You: Use the new schema."],
  [37, "Running · bun test parser"],
  [36.9, "Exit 0 · 1 pass"],
  [36, "Steered · Your agent: Keep the old reader.\nIt still reads the v1 files."],
  [35, "Submitted for review · Written on the new schema."],
  [34, "Judged · against its goal and 2 steers, in order"],
  [33, "Review · pass\nIt reads the new schema."],
]);
/** A task as the steer lib reads it: how it stands, and what was said to it. */
const steerTaskOf = (status: core.TeamWorkStatus, steers: core.TeamSteer[]) => ({ status, steers });
const steer = {
  words: STEER_WORDS,
  limit: core.TEAM_LIMITS.steer,
  actions: [true, false].flatMap((running) => (["steer", "queue"] as const).flatMap((enter) => [false, true].map((modifier) => ({ running, enter, modifier, action: steerAction({ running, enter, modifier }) })))),
  hints: (["running", "queued", "done"] as const).flatMap((status) =>
    (["steer", "queue"] as const).flatMap((enter) => [false, true].flatMap((coarse) => [false, true].map((mac) => ({ status, name: "Ada", enter, coarse, mac, hint: steerHint({ status, name: "Ada", enter, coarse, mac }) })))),
  ),
  tasks: [
    steerTaskOf("running", [steerOf("owner", "Use the new schema.", 3), steerOf("primary", "Keep the old reader."), steerOf("owner", "And name it v2.\nAs the others are.")]),
    steerTaskOf("running", [steerOf("owner", "Use the new schema.", 1)]),
    steerTaskOf("running", []),
    steerTaskOf("stopped", [steerOf("owner", "Use the new schema.", 3), steerOf("owner", "And name it v2.")]),
    steerTaskOf("failed", [steerOf("primary", "Keep the old reader.")]),
    steerTaskOf("done", [steerOf("owner", "Use the new schema.", 1)]),
    steerTaskOf("queued", [steerOf("owner", "Use the new schema.")]),
  ].map((task) => ({ task, name: "Ada", waiting: steersWaiting(task, "Ada"), never: neverReached(task) })),
  judged: (
    [
      [1, [steerOf("owner", "x", 1)]],
      [2, [steerOf("owner", "x", 1), steerOf("owner", "y", 2)]],
      [1, [steerOf("primary", "x", 1)]],
      [2, [steerOf("primary", "x", 1), steerOf("primary", "y", 2)]],
      [2, [steerOf("owner", "x", 1), steerOf("primary", "y", 2)]],
      [1, [steerOf("owner", "x", 1), steerOf("owner", "y", 9)]],
      [2, [steerOf("owner", "x", 1), steerOf("owner", "y", 2), steerOf("primary", "z", 3)]],
      [2, [steerOf("owner", "x", 1)]],
      [1, []],
      [0, []],
      [null, [steerOf("owner", "x", 1)]],
    ] as [number | null, core.TeamSteer[]][]
  ).map(([judged, steers]) => ({ judged, steers, line: judgedLine(judged, steers) })),
  trail: steeredTrail,
  groups: stepGroups(steeredTrail),
  steers: steersOf(steeredTrail),
  judgedWith: [
    { entries: steeredTrail, judged: judgedWith(steeredTrail) },
    { entries: trailOf([[2, "Steered · You: Use the new schema."], [1, "Review · pass\nIt holds."]]), judged: 0 },
    { entries: trailOf([[1, "Steered · You: Use the new schema."]]), judged: null },
  ].map((c) => ({ ...c, judged: judgedWith(c.entries) })),
  live: ["Steered · You: Use the new schema.", "Steered · Your agent: Keep the old reader.\nIt still reads the v1 files."].map((text) => ({ text, live: liveStep(trailOf([[3, text]])) })),
  // Whose words a steer was is the runner's to say, "You" or "Your agent": any other line with its mark is a note.
  strangers: ["Steered · Someone: x", "Steered · you: x", "Judged · against its goal and two steers"].map((text) => ({ text, groups: stepGroups(trailOf([[3, text]])) })),
};

// ---- the file ----------------------------------------------------------------------------------------------------------
// ---- the verdict, in words that follow the proof (the PWA's lib/steps.ts verdictOf), from a task's record ------------
const proofRecord = (ended: "done" | "unverified" | "gave-up" | "stopped", proof?: { before: number[]; after: number[]; review: "pass" | "revise" | null; sameModel: boolean }) => ({ startedAt: 0, endedAt: 1000, ended, commands: 2, revisions: 0, spent: [], ...(proof ? { proof } : {}) });
const verdictCases = [
  { status: "done", verified: true, error: null, record: proofRecord("done", { before: [1, 0], after: [0, 0], review: "pass", sameModel: false }) },
  { status: "done", verified: true, error: null, record: proofRecord("done", { before: [0], after: [0], review: "pass", sameModel: false }) },
  { status: "done", verified: true, error: null, record: proofRecord("done", { before: [], after: [], review: "pass", sameModel: false }) },
  { status: "done", verified: true, error: null, record: proofRecord("done", { before: [1], after: [0], review: "pass", sameModel: true }) },
  { status: "done", verified: true, error: null, record: proofRecord("done") },
  { status: "done", verified: true, error: null },
  { status: "failed", verified: false, error: "unverified", record: proofRecord("unverified", { before: [1, 1], after: [0, 1], review: null, sameModel: false }) },
  { status: "failed", verified: false, error: "unverified", record: proofRecord("unverified", { before: [1], after: [0], review: "revise", sameModel: false }) },
  { status: "failed", verified: false, error: "gave-up", record: proofRecord("gave-up", { before: [1], after: [], review: null, sameModel: false }) },
  { status: "failed", verified: false, error: "Model unavailable" },
  { status: "done", verified: false, error: null, record: proofRecord("unverified") },
  { status: "stopped", verified: false, error: "stopped" },
  { status: "failed", verified: false, error: "stopped\nBy you.", record: proofRecord("stopped") },
  { status: "running", verified: false, error: null },
  { status: "queued", verified: false, error: null },
] as const;
const verdicts = verdictCases.map((task) => ({ task, verdict: verdictOf(task as never, factsOfRecord((task as { record?: never }).record)) }));
// A proof in one line, as a chat's compact row says it (lib/steps.ts proofLine): its verdict, then how many gates passed.
const proofLines = verdictCases.map((task) => ({ task, line: proofLine(task as never) }));

// ---- the mark: the I-beam (scripts/mark.ts), which the app draws as a shape of its own (AppMark) --------------------
const mark = { rects: MARK_RECTS, polygon: MARK_POLYGON, box: MARK_BOX };

// ---- the live stream's timing (core's live.ts, the web app's lib/live-link.ts), which the app's LiveLink keeps -------
// And its cursors: which a device keeps and opens the stream again from (core's LIVE_CURSOR, the node's LiveCursor), and
// the path it signs and sends for each (livePath).
const liveCursors = ["b00t.0", "AbC-_9.123456789012345", "x".repeat(64), "x".repeat(65), "", "a b", "b00t.1?x=1", "b00t.1&since=2", "b00t/1", "%2e", "a+b", "é.1", "b00t.1\n"].map((cursor) => {
  const kept = core.LIVE_CURSOR.test(cursor);
  if (kept !== core.LiveCursor.safeParse(cursor).success) fail(`the node and a device disagree on whether ${JSON.stringify(cursor)} is a cursor`);
  return { cursor, kept, path: core.livePath(cursor) };
});

// And the link itself, played on a clock in hand (lib/live-link.ts): above all, a link up a moment ago is said down only
// if it isn't up again within HELLO_WAIT_MS of then, whatever its fresh streams do meanwhile. Each case is its steps, then
// what the link told and when, and when it opened each stream; LiveLink.swift and LiveLink.kt play the same steps, and
// must tell the same at the same times. The steps:
//   start, stop: the app shown, hidden; hello: the newest stream says hello (a node of today's, beating every beatMs);
//   end: it ends; offline, refusing, online: from now on a fresh stream fails at once, as with no network, or as the
//   node refuses it, or opens; wait: the clock moves on; steady: it moves on, the newest stream beating all the while.
type LinkStep = { act: "start" | "stop" | "end" | "offline" | "refusing" | "online" } | { act: "hello"; topics: core.LiveTopic[] } | { act: "wait" | "steady"; ms: number };
class LinkRefused extends Error {}
async function playLink(steps: LinkStep[]): Promise<{ told: string[]; opened: number[] }> {
  let now = 0;
  const timers: { at: number; run: () => void; off: boolean }[] = [];
  const after = (ms: number, run: () => void) => {
    const timer = { at: now + ms, run, off: false };
    timers.push(timer);
    return () => void (timer.off = true);
  };
  const flush = async () => {
    for (let i = 0; i < 20; i++) await Promise.resolve();
  };
  // What comes due runs in order, and of two due at once, the one set first.
  const advance = async (ms: number) => {
    const end = now + ms;
    for (;;) {
      await flush();
      const due = timers.filter((t) => !t.off && t.at <= end).sort((a, b) => a.at - b.at)[0];
      if (!due) break;
      due.off = true;
      now = due.at;
      due.run();
    }
    now = end;
    await flush();
  };
  const streams: { at: number; put(item: core.LiveEvent | "end"): void; alive(): void }[] = [];
  let failing: Error | null = null;
  const open = (signal: AbortSignal, alive: () => void): AsyncIterable<core.LiveEvent> => {
    const queue: (core.LiveEvent | "end" | Error)[] = [];
    let wake: (() => void) | null = null;
    const put = (item: (typeof queue)[number]) => {
      queue.push(item);
      wake?.();
    };
    signal.addEventListener("abort", () => put(new DOMException("aborted", "AbortError")));
    const fails = failing;
    streams.push({ at: now, put, alive });
    return {
      async *[Symbol.asyncIterator]() {
        if (fails) throw fails;
        for (;;) {
          while (!queue.length) await new Promise<void>((resolve) => (wake = resolve));
          const item = queue.shift()!;
          if (item === "end") return;
          if (item instanceof Error) throw item;
          yield item;
        }
      },
    };
  };
  const told: string[] = [];
  const link = liveLink({ open, refused: (error) => error instanceof LinkRefused, after, now: () => now });
  link.attach({ up: (topics) => told.push(`${now} up ${topics.join(",")}`), changed: (topics) => told.push(`${now} changed ${topics.join(",")}`), down: () => told.push(`${now} down`) });
  const newest = () => streams.at(-1)!;
  for (const step of steps) {
    if (step.act === "start") link.start();
    else if (step.act === "stop") link.stop();
    else if (step.act === "hello") {
      newest().alive();
      newest().put({ type: "hello", topics: step.topics, beat: core.LIVE_BEAT_MS });
    } else if (step.act === "end") newest().put("end");
    else if (step.act === "offline") failing = new TypeError("fetch failed");
    else if (step.act === "refusing") failing = new LinkRefused("refused");
    else if (step.act === "online") failing = null;
    else if (step.act === "wait") await advance(step.ms);
    else if (step.act === "steady")
      for (let moved = 0; moved < step.ms; moved += core.LIVE_BEAT_MS) {
        await advance(core.LIVE_BEAT_MS);
        newest().alive();
      }
    await flush();
  }
  link.stop();
  return { told, opened: streams.map((stream) => stream.at) };
}
const helloFleet: LinkStep = { act: "hello", topics: ["fleet"] };
const linkCases: { name: string; steps: LinkStep[] }[] = [
  { name: "never up: down at once when it can't be opened, then tried again a second later, then twice as long", steps: [{ act: "offline" }, { act: "start" }, { act: "wait", ms: 3_000 }] },
  {
    name: "up a while, then gone with the network: a fresh one failing at once says nothing, and back within HELLO_WAIT_MS it never went",
    steps: [{ act: "start" }, helloFleet, { act: "steady", ms: STEADY_MS }, { act: "offline" }, { act: "end" }, { act: "wait", ms: 500 }, { act: "online" }, { act: "wait", ms: 500 }, helloFleet, { act: "wait", ms: HELLO_WAIT_MS }],
  },
  {
    name: "up a moment ago and failing since: down when HELLO_WAIT_MS ends after it went, not sooner",
    steps: [{ act: "start" }, helloFleet, { act: "offline" }, { act: "end" }, { act: "wait", ms: HELLO_WAIT_MS - 1 }, { act: "wait", ms: 1 }, { act: "online" }, { act: "wait", ms: 4_000 }, helloFleet],
  },
  {
    name: "up a moment ago, a fresh one that says nothing doesn't put it off: down when HELLO_WAIT_MS ends after it went",
    steps: [{ act: "start" }, helloFleet, { act: "end" }, { act: "wait", ms: HELLO_WAIT_MS }, { act: "wait", ms: 500 }, helloFleet],
  },
  { name: "up again in time and gone again: counted from when it last went", steps: [{ act: "start" }, helloFleet, { act: "end" }, { act: "wait", ms: 1_500 }, helloFleet, { act: "wait", ms: 500 }, { act: "end" }, { act: "wait", ms: HELLO_WAIT_MS }] },
  {
    name: "the node's refusal is down at once, up a moment ago or not, and not tried again on a timer",
    steps: [{ act: "start" }, helloFleet, { act: "refusing" }, { act: "end" }, { act: "wait", ms: RETRY_FIRST_MS }, { act: "wait", ms: 60_000 }],
  },
  {
    name: "stopped while it waits to be said down, nothing is said; started again, it waits for a hello afresh",
    steps: [{ act: "start" }, helloFleet, { act: "end" }, { act: "wait", ms: RETRY_FIRST_MS }, { act: "stop" }, { act: "wait", ms: 5_000 }, { act: "start" }, { act: "wait", ms: HELLO_WAIT_MS }],
  },
];
const links = [];
for (const c of linkCases) links.push({ ...c, ...(await playLink(c.steps)) });

// ---- an agent's own computer as the node makes it (core's computerSize), and how long the node lets a project's git run --
// (the Mac's Build window says the first before the primary's computer is made, and waits the second out for a clone)
const computer = { start: core.COMPUTER_START, sizes: [true, false].map((desktop) => ({ desktop, size: core.computerSize(desktop) })) };
const projectGit = { cloneTimeoutS: CLONE_TIMEOUT, gitTimeoutS: GIT_TIMEOUT };

const live = { beatMs: core.LIVE_BEAT_MS, silentMs: SILENT_MS, helloWaitMs: HELLO_WAIT_MS, retryFirstMs: RETRY_FIRST_MS, retryMaxMs: RETRY_MAX_MS, steadyMs: STEADY_MS, gapMs: GAP_MS, topics: core.LIVE_TOPICS, cursors: liveCursors, links };

// ---- a task on its Live Activity: its state, from the task and its trail, and its words (lib/live-activity.ts) ----------
const activityTrail = (...texts: string[]) => texts.map((text, i) => ({ n: i + 1, at: NOW - 600_000 + i * 10_000, text }));
const ACTIVITY_GATES = ["bun test packages/link", "bun run typecheck"];
const activityBefore = "Gates before the work · 1. exit 1 · bun test packages/link\n2. exit 0 · bun run typecheck";
const activityCases: { name: string; task: { status: core.TeamTask["status"]; verified: boolean; error: string | null; gates: string[]; record?: core.TeamTask["record"] }; entries: ReturnType<typeof activityTrail>; others?: number }[] = [
  { name: "queued", task: { status: "queued", verified: false, error: null, gates: ACTIVITY_GATES }, entries: [] },
  { name: "at work, before its gates", task: { status: "running", verified: false, error: null, gates: ACTIVITY_GATES }, entries: activityTrail("Plan · go", activityBefore, "Running · bun test") },
  { name: "at work, two more of the team's at work", task: { status: "running", verified: false, error: null, gates: ACTIVITY_GATES }, entries: activityTrail("Plan · go"), others: 2 },
  { name: "at work, one more of the team's at work", task: { status: "running", verified: false, error: null, gates: ACTIVITY_GATES }, entries: activityTrail("Plan · go"), others: 1 },
  { name: "its first gate passed, the second running", task: { status: "running", verified: false, error: null, gates: ACTIVITY_GATES }, entries: activityTrail(activityBefore, "Submitted for review · done", "Gate 1/2 · exit 0 · bun test packages/link\n14 pass") },
  { name: "under review", task: { status: "running", verified: false, error: null, gates: ACTIVITY_GATES }, entries: activityTrail(activityBefore, "Submitted for review · done", "Gate 1/2 · exit 0 · bun test packages/link", "Gate 2/2 · exit 0 · bun run typecheck") },
  { name: "sent back, at work again", task: { status: "running", verified: false, error: null, gates: ACTIVITY_GATES }, entries: activityTrail(activityBefore, "Submitted for review · done", "Gate 1/2 · exit 0 · bun test packages/link", "Gate 2/2 · exit 0 · bun run typecheck", "Review · revise\nNot wired.", "Running · bun test") },
  { name: "proven", task: { status: "done", verified: true, error: null, gates: ACTIVITY_GATES }, entries: activityTrail(activityBefore, "Submitted for review · done", "Gate 1/2 · exit 0 · bun test packages/link", "Gate 2/2 · exit 0 · bun run typecheck", "Review · pass\nMatches the brief.") },
  { name: "reviewed, not proven", task: { status: "done", verified: true, error: null, gates: ACTIVITY_GATES }, entries: activityTrail("Gates before the work · 1. exit 0 · bun test packages/link\n2. exit 0 · bun run typecheck", "Submitted for review · done", "Gate 1/2 · exit 0 · bun test packages/link", "Gate 2/2 · exit 0 · bun run typecheck", "Review · pass\nok") },
  { name: "a gate failed", task: { status: "failed", verified: false, error: "unverified", gates: ACTIVITY_GATES }, entries: activityTrail(activityBefore, "Submitted for review · done", "Gate 1/2 · exit 0 · bun test packages/link", "Gate 2/2 · exit 1 · bun run typecheck") },
  { name: "gave up", task: { status: "failed", verified: false, error: "gave-up", gates: ACTIVITY_GATES }, entries: activityTrail("Plan · go") },
  { name: "stopped", task: { status: "stopped", verified: false, error: null, gates: ACTIVITY_GATES }, entries: activityTrail("Plan · go") },
  { name: "interrupted", task: { status: "interrupted", verified: false, error: null, gates: ACTIVITY_GATES }, entries: activityTrail("Plan · go") },
  { name: "proven, from its record alone", task: { status: "done", verified: true, error: null, gates: ACTIVITY_GATES, record: { startedAt: NOW - 600_000, endedAt: NOW, ended: "done", commands: 0, revisions: 0, spent: [], proof: { before: [1, 0], after: [0, 0], review: "pass", sameModel: false } } }, entries: [] },
];
const liveActivities = activityCases.map((c) => {
  const state = activityOf({ ...c.task, record: c.task.record }, c.entries, NOW, c.others ?? 0);
  return { ...c, others: c.others ?? 0, at: NOW, state, line: activityLine(state), short: activityShort(state), othersLine: activityOthers(state) };
});

// ---- what the Grille (core's agent-mark.ts) leaves the glass: the palette, a colour you pick snapped to it, a mark an
// app or a node from before the glass saved, read for its colour, and the states an agent is shown in ------------------
// (The dev fleet and five more: the glass's `given` gives them their glass in this order.)
const markFleet = ["builder", "writer", "researcher", "coder", "reviewer", "operator", "designer", "tester", "ops", "docs", "scout", "scribe", "warden", "pilot", "smith"];
const marks = {
  palette: core.MARK_PALETTE,
  states: core.MARK_STATES,
  stateOf: core.AVATAR_EXPRESSIONS.map((expression) => ({ expression, state: core.markState(expression) })),
  // A colour you pick, to the nearest hue of the eight (OKLCH), reckoned with + − × ÷ and √ alone from these: sRGB's
  // levels in linear light, a cube root by Newton's method, the chroma under which a colour is a grey.
  linear: core.MARK_LINEAR,
  grey: core.MARK_GREY,
  snaps: ["#b9dfd4", "#8bafff", "#c8b222", "#ff0000", "#3abeff", "#6eca73", "#fa86b6", "#000000", "#ffffff", "#808080", "#f5f5f0", "#202020", "#C8B222", ...core.AGENT_TINTS, ...core.MARK_PALETTE.flatMap((hue) => [hue.light, hue.dark])].map((hex) => ({ hex, color: core.snapColor(hex) })),
  // Every colour of an 18-level grid (0, 15 … 255 in each channel, red slowest), its snap a digit each.
  snapGrid: (() => {
    let out = "";
    for (let r = 0; r < 256; r += 15) for (let g = 0; g < 256; g += 15) for (let b = 0; b < 256; b += 15) out += core.snapColor(`#${[r, g, b].map((c) => c.toString(16).padStart(2, "0")).join("")}`);
    return out;
  })(),
  // Every one of the 2^24 colours: FNV-1a over each one's snap, a byte each, from #000000 to #ffffff, and how many go to
  // each hue (an optimised build of an app can check it all; its tests check the grid).
  snapAll: (() => {
    let digest = 0x811c9dc5;
    const counts = new Array(8).fill(0);
    for (let n = 0; n < 1 << 24; n++) {
      const k = core.snapColor(`#${n.toString(16).padStart(6, "0")}`);
      counts[k]++;
      digest = Math.imul(digest ^ k, 0x01000193) >>> 0;
    }
    return { digest: digest.toString(16).padStart(8, "0"), counts };
  })(),
  // Profiles as an agent may have them: a mark (v 3), read strictly; a colour chosen before the marks (v 2); nothing;
  // and what reads as no mark.
  profiles: [
    { id: "coder", profile: { v: 3, color: "#0084ba", form: 10 } },
    { id: "coder", profile: { v: 2, color: "#3abeff" } },
    { id: "coder", profile: null },
    { id: "docs", profile: { v: 3, color: "#0084ba", form: 12 } },
    { id: "docs", profile: { v: 3, color: "#3bb7f7", form: 1 } },
    { id: "docs", profile: { v: 3, color: "#0084ba", form: 1, glow: true } },
  ].map((c) => ({ ...c, saved: core.isMarkProfile(c.profile), mark: core.readMarkProfile(c.profile) })),
};

// ---- an agent's glass (core's glass.ts), which every app draws from the same numbers -------------------------------
// The shapes (lines and curves alone; each with the bounds of every point its path names, to hold a parser to), the
// I-beam, the ramps and the Guardian's pearl, the paint, the glow, the dot, the state each mark state shows, and an
// agent's glass read from what it has: its own (v 4), a mark's colour (v 3), a colour chosen before (v 2), or its
// handle's, for anything else (a profile from a version yet to come too).
const pointsOf = (d: string) => (d.match(/-?\d*\.?\d+/g) ?? []).map(Number);
const boundsOf = (d: string) => {
  const n = pointsOf(d), xs = n.filter((_, i) => i % 2 === 0), ys = n.filter((_, i) => i % 2 === 1);
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
};
const glassReads: { id: string; profile: unknown }[] = [
  { id: "scout", profile: core.glassProfile({ color: 5, shape: 7 }) },
  { id: "scout", profile: { v: 3, color: core.MARK_PALETTE[2]!.light, form: 9 } },
  { id: "scout", profile: { v: 2, color: "#ff0000" } },
  { id: "scout", profile: null },
  { id: "coder", profile: { v: 5, color: core.MARK_PALETTE[1]!.light, shape: 3 } },
  { id: "coder", profile: { v: 4, color: "#123456", shape: 1 } },
  { id: "coder", profile: { v: 4, color: core.MARK_PALETTE[0]!.light, shape: 22 } },
  { id: "coder", profile: { v: 4, color: core.MARK_PALETTE[0]!.light, shape: 1, glow: true } },
  { id: "planner", profile: "glass" },
  ...markFleet.slice(0, 6).map((id) => ({ id, profile: null })),
];
const glass = {
  shapes: core.GLASS_SHAPES.map((s) => ({ ...s, bounds: boundsOf(s.d) })),
  ibeam: { points: core.IBEAM_POINTS, glass: { ...core.GLASS_IBEAM, bounds: boundsOf(core.GLASS_IBEAM.d) } },
  ramps: core.GLASS_RAMPS,
  pearl: core.GLASS_PEARL,
  paint: core.GLASS_PAINT,
  glow: core.GLASS_GLOW,
  dot: core.GLASS_DOT,
  nudge: core.GLASS_NUDGE,
  // When a glass knocks (nudgeNow), as an app keeps it from one drawing to the next: it starts to wait on you; the same
  // again; more; less (one answered); more again (a new one); at work; waiting again; at rest; waiting on three.
  knocks: (() => {
    let before: number | null = null;
    return ([["needs", 1], ["needs", 1], ["needs", 2], ["needs", 1], ["needs", 2], ["working", 0], ["needs", 1], ["idle", 0], ["needs", 3]] as const).map(([state, needs]) => {
      const now = core.nudgeNow(before, state, needs);
      before = now.after;
      return { state, needs, knock: now.knock };
    });
  })(),
  states: core.MARK_STATES.map((state) => ({ state, glass: core.glassState(state) })),
  reads: glassReads.map((r) => ({ ...r, glass: core.glassOf(r.id, r.profile), own: core.isGlassProfile(r.profile) })),
  // As a node gives them, one by one in the order they join (the apps preview a new agent's with the same rule): the
  // fifteen of the marks' fleet, so every family and every colour is worn; and a colour chosen, snapped to the eight.
  given: (() => {
    const out: { id: string; seed: number; glass: core.Glass }[] = [];
    for (const id of markFleet) out.push({ id, seed: core.handleSeed(id), glass: core.assignGlass(id, out.map((g) => g.glass)) });
    return out;
  })(),
  chosen: [
    { id: "writer", others: [{ color: 0, shape: 1 }, { color: 3, shape: 6 }], chosen: "#ffbc63", glass: core.assignGlass("writer", [{ color: 0, shape: 1 }, { color: 3, shape: 6 }], "#ffbc63") },
    { id: "ops", others: [], chosen: "#ff0000", glass: core.assignGlass("ops", [], "#ff0000") },
    { id: "ops", others: [{ color: 2, shape: 0 }], chosen: 5, glass: core.assignGlass("ops", [{ color: 2, shape: 0 }], 5) },
  ],
};

// ---- a loop's task and what wakes it, in words (lib/loops.ts, lib/wakes.ts): a loop it drafted, in Needs you --------
const loops = {
  tasks: [
    { kind: "heartbeat" },
    { kind: "heartbeat", checklist: "Disk under 90 %", selfAction: false },
    { kind: "heartbeat", selfAction: true },
    { kind: "run", network: "isolated", goal: "Tidy the logs" },
    { kind: "run", network: "online", goal: "Check the release notes", gates: ["bun test"] },
    { kind: "run", network: "gateway", goal: `Read every line of the importer ${"and its tests ".repeat(14)}`, gates: ["bun test packages/link", "bun run typecheck", "bun run lint"] },
    { kind: "call", connector: "gmail", tool: "send", args: { to: "ada@example.test", subject: "The week", count: 2, urgent: false, cc: null, labels: ["a", "b"], extra: { x: 1 } } },
    { kind: "call", connector: "github", tool: "comment", args: {} },
    { kind: "call", connector: "github", tool: "comment" },
    { kind: "call", connector: "notes", tool: "append", args: { text: "x".repeat(130) } },
    // Numbers as JavaScript writes them: whole ones past 2^53 in their shortest digits and zeros, never their exact value,
    // up to 1e21; decimals in figures from 1e-6, in an exponent below it.
    { kind: "call", connector: "calc", tool: "set", args: { a: 2 ** 53, b: 2 ** 53 + 2, c: 12345678901234567890, d: 2 ** 64 } },
    { kind: "call", connector: "calc", tool: "set", args: { e: 1e20, f: 999999999999999900000, g: 1e21, h: -(2 ** 60), i: 123456789012345680000 } },
    { kind: "call", connector: "calc", tool: "set", args: { a: 0.0001, b: 0.00001, c: 0.000015, d: 0.000001, e: 1e-7, f: 0.0000099 } },
    { kind: "call", connector: "calc", tool: "set", args: { g: 0.00009999, h: -0.00005, i: 0.0001234, j: 1.5e-6, k: [0.00002, 2 ** 53 + 2] } },
    { kind: "tell", text: "Stand up" },
    { kind: "tell" },
    null,
  ].map((task) => ({ task, words: describeTask(task as Parameters<typeof describeTask>[0]) })),
  wakes: [
    { wakes: [], cooldownMs: null },
    { wakes: [{ kind: "webhook" }], cooldownMs: null },
    { wakes: [{ kind: "mail", connector: "gmail", query: "from:boss@example.test" }, { kind: "mail", connector: "outlook" }], cooldownMs: 300_000 },
    { wakes: [{ kind: "github", owner: "example", repo: "app", on: ["ci.failed", "pr.opened"], branch: "main" }, { kind: "github", owner: "example", repo: "app", on: ["pushed", "issue.opened"] }], cooldownMs: 90_000 },
  ].map((c) => ({ ...c, words: describeWakes(c.wakes as Parameters<typeof describeWakes>[0], c.cooldownMs) })),
};

// ---- seats (I15): their words as the PWA and inv say them (web lib/seats.ts), and a task's plan (core's team-record.ts):
// where each stands, whom it serves and what a share means, its meter, a sign-in's card. The apps show no seats yet: when
// they do, they say these, held here.
const SEAT_NOW = Date.UTC(2026, 10, 26, 12, 0);
const SEAT_HOUR = 3_600_000;
const seatWindow = (over: Partial<core.SeatView["windows"][number]> = {}): core.SeatView["windows"][number] => ({ window: "five_hour", status: "allowed", usedPercent: 42, resetsAt: SEAT_NOW + 2 * SEAT_HOUR, at: SEAT_NOW, ...over });
const ADA = { id: "ada", name: "Ada", createdAt: 1_000 };
const BO = { id: "bo", name: "Bo", createdAt: 2_000 };
const serving = (...agents: { id: string; createdAt: number }[]) => agents.map((agent) => ({ id: agent.id, made: agent.createdAt }));
const seatStates: core.SeatState[] = [
  { is: "ready", renewBy: null },
  { is: "ready", renewBy: SEAT_NOW + 3 * 24 * SEAT_HOUR + SEAT_HOUR },
  { is: "signing-in", attempt: "sa_x", since: SEAT_NOW, until: SEAT_NOW + 600_000 },
  { is: "resting", until: SEAT_NOW + 2 * SEAT_HOUR, window: "five_hour" },
  { is: "resting", until: Number.MAX_SAFE_INTEGER, window: null },
  ...(["never", "signed-out", "cancelled", "expired", "failed", "wrong-account"] as const).map((why): core.SeatState => ({ is: "signed-out", why })),
];
const seatUses: (core.SeatUse | undefined)[] = [undefined, { since: SEAT_NOW, tasks: 0, tokens: 0, running: 0 }, { since: SEAT_NOW, tasks: 1, tokens: 4_000, running: 0 }, { since: SEAT_NOW, tasks: 3, tokens: 1_204_000, running: 1 }, { since: SEAT_NOW, tasks: 0, tokens: 0, running: 2 }];
const seats = {
  now: SEAT_NOW,
  kinds: SEAT_KIND_WORDS,
  // A seat of a kind this version doesn't know (core's UnknownSeat), a later release's: what is said of it. A Seats
  // screen reads a seat's kind leniently and says these, never a failed screen (the lead's word, 27 November 2026).
  unknownKind: UNKNOWN_KIND_WORDS,
  quickLabels: [[], [{ label: "Claude 1" }, { label: "Claude 3" }]].map((have) => ({ have, claude: quickLabel("claude-subscription", have), chatgpt: quickLabel("chatgpt-codex", have) })),
  states: seatStates.map((state) => ({ state, plan: "max", words: seatStateWords(state, "max", SEAT_NOW), action: signInAction({ kind: "claude-subscription", state }, SEAT_NOW) })),
  serves: [
    { serves: [], roster: [ADA, BO] },
    { serves: serving(ADA), roster: [ADA, BO] },
    { serves: serving(ADA, BO), roster: [BO, ADA] },
    { serves: serving(ADA), roster: [BO] },
    { serves: serving(ADA), roster: [{ ...ADA, createdAt: 9_000 }] },
    { serves: serving(ADA, BO), roster: null },
  ].map(({ serves, roster }) => ({ serves, roster, words: servesWords({ serves }, roster) })),
  choices: [
    { before: ["Ada"], after: ["Ada", "Bo"] },
    { before: ["Ada"], after: ["Bo"] },
    { before: ["Ada", "Cy"], after: ["Bo"] },
    { before: [], after: ["Ada"] },
    { before: ["Ada", "Bo"], after: ["Ada"] },
  ].map(({ before, after }) => ({ label: "Claude 1", before, after, words: servesChoiceWords("Claude 1", before, after) })),
  windows: [seatWindow(), seatWindow({ window: "seven_day", usedPercent: 12, resetsAt: SEAT_NOW + 3 * 24 * SEAT_HOUR }), seatWindow({ status: "rejected", usedPercent: 100 }), seatWindow({ status: "warning", usedPercent: 91 }), seatWindow({ usedPercent: null, resetsAt: null }), seatWindow({ window: "minutes_90", usedPercent: 7.6 })].map((window) => ({ window, words: seatWindowWords(window, SEAT_NOW) })),
  uses: seatUses.map((use) => ({ use: use ?? null, words: seatUseWords(use) })),
  meters: [
    { windows: [seatWindow(), seatWindow({ window: "seven_day_opus", usedPercent: 80, resetsAt: SEAT_NOW - 1 })], use: seatUses[3]! },
    { windows: [], use: undefined },
  ].map(({ windows, use }) => ({ windows, use: use ?? null, words: seatMeterWords({ windows }, use, SEAT_NOW) })),
  elsewhere: USE_ELSEWHERE,
  windowNames: ["five_hour", "seven_day", "seven_day_opus", "minutes_60", "minutes_1440", "minutes_90", "plan", "overage_window"].map((name) => ({ name, words: core.windowName(name) })),
  plans: [
    { seat: "st_ssssssssssssssssssssss", kind: "claude-subscription", windows: [{ window: "five_hour", share: 7 }, { window: "seven_day", share: 1 }], usd: 0.00144 },
    { seat: "st_ssssssssssssssssssssss", kind: "claude-subscription", windows: [{ window: "five_hour", share: 0 }], usd: null },
    { seat: null, kind: "chatgpt-codex", windows: [], usd: 2.8 },
  ].map((plan) => ({ plan, facts: core.taskPlanFacts(plan) })),
  // (Each with its seat's kind: a code to paste back is Claude's, or Google's for an Antigravity seat.)
  cards: [
    { card: { kind: "device-code" as const, code: "FAKE-1234", firstTime: true }, seat: "chatgpt-codex" as const },
    { card: { kind: "device-code" as const, code: "FAKE-1234", firstTime: false }, seat: "chatgpt-codex" as const },
    { card: { kind: "paste-code" as const }, seat: "claude-subscription" as const },
    { card: { kind: "paste-code" as const }, seat: "google-antigravity" as const },
  ].map(({ card, seat }) => ({ card, seat, words: cardWords(card, seat) })),
};

const vectors = {
  about: "Made by apps/apple/scripts/vectors.ts from packages/core (and the PWA's roster). Every key here is a fake made for these tests.",
  auth: {
    domain: "invincible-req/v1",
    domainNamed: "invincible-req/v2",
    nodeProofDomain: "invincible-node/v1",
    nodeChallenge: core.NODE_CHALLENGE.source,
    namedFrom: core.REQUESTS_NAME_THEIR_NODE_FROM,
    headers: core.AUTH,
    maxSkewMs: core.MAX_REQUEST_SKEW_MS,
  },
  base64url,
  identity: { scalarHex: hex(scalar), publicKey: b64u(publicKey), device },
  requests,
  requestsForNode,
  nodeProofs,
  judgedNodeProofs,
  words,
  ed25519,
  canonical,
  pairing,
  agentOrbs,
  agents,
  unread,
  rooms,
  listTimes,
  chatMarks,
  permissions,
  asks: askVectors,
  proofLines,
  homePrimary,
  agentForms,
  keys,
  desktop,
  desktopStream,
  faces,
  orb,
  field,
  connectorStates,
  threads,
  chats,
  composer,
  steer,
  markdown,
  blocks,
  timelines,
  notices,
  highlights,
  notifyReach,
  notifyQuiet,
  notifyPayload,
  work,
  steps,
  mark,
  live,
  verdicts,
  liveActivities,
  marks,
  glass,
  loops,
  seats,
  computer,
  projectGit,
};
const text = `${JSON.stringify(vectors, null, 2)}\n`;
if (Bun.argv.includes("--check")) {
  let kept = "";
  try {
    kept = readFileSync(OUT, "utf8");
  } catch {
    /* none yet */
  }
  // Every number to within a trillionth (the apps' own tests hold theirs to a billionth), everything else exactly: a
  // sine on another processor (x86 Linux, in CI) can differ from this Mac's in its last digit, and that is no change.
  const differs = kept === "" ? "none kept" : firstDifference(JSON.parse(kept), JSON.parse(text), "");
  if (differs) {
    console.error(`${OUT} isn't what core makes now (${differs}): run bun apps/apple/scripts/vectors.ts`);
    process.exit(1);
  }
  console.log("the vectors match core");
} else {
  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, text);
  console.log(`wrote ${OUT}`);
}

/** Where two readings of the vectors first part, or null: numbers within a trillionth of each other (and of their size)
 * are the same, anything else must be equal. */
function firstDifference(a: unknown, b: unknown, at: string): string | null {
  if (typeof a === "number" && typeof b === "number") return Math.abs(a - b) <= 1e-12 * Math.max(1, Math.abs(a), Math.abs(b)) ? null : `${at || "the top"}: ${a} ≠ ${b}`;
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return `${at}: ${a.length} items ≠ ${b.length}`;
    for (let i = 0; i < a.length; i++) {
      const found = firstDifference(a[i], b[i], `${at}[${i}]`);
      if (found) return found;
    }
    return null;
  }
  if (a && b && typeof a === "object" && typeof b === "object" && !Array.isArray(a) && !Array.isArray(b)) {
    const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])];
    for (const key of keys) {
      const found = firstDifference((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key], `${at}.${key}`);
      if (found) return found;
    }
    return null;
  }
  return Object.is(a, b) ? null : `${at || "the top"}: ${JSON.stringify(a)} ≠ ${JSON.stringify(b)}`;
}
