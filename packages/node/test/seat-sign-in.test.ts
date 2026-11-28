import { describe, expect, test } from "bun:test";
import { newNodeIdentity, seatState } from "@invincible/core";
import { AGENTS } from "@invincible/agents";
import { foundFleet, LedgerStore, Vault } from "@invincible/ledger";
import type { SandboxStream } from "@invincible/sandbox";
import { SeatSignIns } from "../src/seat-sign-in.ts";
import { seatEmailName, seatSalt, yourWord } from "../src/seats.ts";

/*
 * Signing a seat in on the node that holds its home (seat-sign-in.ts), against a stand-in host whose seat VM runs a
 * stand-in of the sign-in bridge: the card comes back from the tool (never into the log), Claude Code's code goes to its
 * process once, a sign-in can be cancelled and lapses, the seat's own tool then says how it stands, an account that isn't
 * the seat's is refused and signed out again, and an address that isn't the vendor's is never shown.
 */

const PAGE = "https://claude.ai/oauth/authorize?code=true&client_id=FAKE-client&state=FAKE-state-0000";
const DEVICE = "https://auth.openai.com/codex/device";
const CODE = "FAKEcode0000#FAKE-state-0000";
const ONE = "F".repeat(22);
const TWO = "G".repeat(22);

/** A stand-in for the bridge in a seat's VM: what it was told, and what it says when the test says so. */
function bridge() {
  const told: Record<string, unknown>[] = [];
  const queue: string[] = [];
  let wake: (() => void) | null = null;
  let ended = false;
  let exit!: (code: number) => void;
  const exited = new Promise<number>((resolve) => (exit = resolve));
  const end = () => {
    ended = true;
    wake?.();
    exit(0);
  };
  const stream: SandboxStream = {
    lines: (async function* () {
      for (;;) {
        while (queue.length) yield queue.shift()!;
        if (ended) return;
        await new Promise<void>((resolve) => (wake = resolve));
        wake = null;
      }
    })(),
    write: (text) => {
      for (const line of text.split("\n").filter(Boolean)) {
        const said = JSON.parse(line) as Record<string, unknown>;
        told.push(said);
        // As the bridge does: cancelled, it says so and ends.
        if (said.cancel) say({ type: "done", ok: false, why: "cancelled" }, true);
      }
    },
    close: () => end(),
    kill: () => end(),
    exited,
  };
  const say = (line: Record<string, unknown>, last = false) => {
    if (ended) return;
    queue.push(JSON.stringify(line));
    if (last) ended = true;
    wake?.();
  };
  return { stream, told, say };
}

function node(options: { status?: Record<string, unknown>; attemptMs?: number } = {}) {
  const identity = newNodeIdentity();
  const store = new LedgerStore(":memory:");
  foundFleet(store, identity, { fleetName: "homelab", nodeName: "ultra" });
  const vault = new Vault(store, identity);
  const asked: unknown[][] = [];
  let current = bridge();
  const status = options.status ?? { type: "status", installed: true, signedIn: true, method: "claude.ai", plan: "max", fingerprint: ONE, renewBy: 2_000_000_000_000 };
  const host = {
    createSeatVm: async (input: unknown) => (asked.push(["vm", input]), { id: "vm00000001" }) as never,
    stream: async (id: string, cmd: string[]) => (asked.push(["stream", id, cmd.slice(0, 2)]), current.stream),
    exec: async (id: string, cmd: string[]) => (asked.push(["exec", id, cmd]), { exitCode: 0, stdout: JSON.stringify(status), stderr: "", durationMs: 1, truncated: false }),
    destroy: async (id: string, opts: unknown) => (asked.push(["destroy", id, opts]), { verdict: "allow" as const, reason: "its own run" }),
  };
  const signIns = new SeatSignIns({ store, vault, node: identity, host: () => host, cardWaitMs: 2_000, ...(options.attemptMs ? { attemptMs: options.attemptMs } : {}) });
  const add = (id: string, kind: "claude-subscription" | "chatgpt-codex" | "mistral-vibe" | "chatgpt-siwc" | "google-antigravity" = "claude-subscription", on = identity.id) =>
    (store.emit(identity, "seat.added", { id, kind, label: "Work", node: on, runs: 1 }, yourWord(null)), id);
  const seat = (id: string) => store.seats().find((s) => s.id === id)!;
  const log = () => JSON.stringify(store.eventsSince({}, 100_000).events);
  const settled = async (check: () => boolean) => {
    for (let i = 0; i < 200 && !check(); i++) await Bun.sleep(5);
  };
  return { identity, store, vault, asked, signIns, add, seat, log, settled, bridge: () => current, next: () => (current = bridge()) };
}

const A = `st_${"a".repeat(22)}`;
const B = `st_${"b".repeat(22)}`;

describe("a Claude seat's sign-in", () => {
  test("its card from its own tool, your code to its process once, then ready as its tool says: nothing of it in the log", async () => {
    const n = node();
    n.add(A);
    n.vault.set(seatEmailName(A), "owner@example.test", { label: "a seat's email" });
    const started = n.signIns.start(A);
    // (The bridge's start: the seat's email, from the vault, on its input: never an argument.)
    await n.settled(() => n.bridge().told.length > 0);
    expect(n.bridge().told[0]).toEqual({ email: "owner@example.test" });
    n.bridge().say({ type: "card", url: PAGE });
    const card = await started;
    expect(card).toMatchObject({ seat: A, kind: "paste-code", url: PAGE });
    expect(card.attempt).toMatch(/^sa_[A-Za-z0-9_-]{22}$/);
    expect(seatState(n.seat(A), Date.now())).toMatchObject({ is: "signing-in", attempt: card.attempt });
    // Asked again while it's open: the same card, and no second VM.
    expect(await n.signIns.start(A)).toEqual(card);
    expect(n.asked.filter((a) => a[0] === "vm")).toHaveLength(1);
    n.signIns.answer(A, card.attempt, CODE);
    expect(() => n.signIns.answer(A, card.attempt, CODE)).toThrow("a code reaches its sign-in once");
    expect(n.bridge().told.filter((t) => "code" in t)).toEqual([{ code: CODE }]);
    n.bridge().say({ type: "done", ok: true }, true);
    await n.settled(() => n.asked.some((a) => a[0] === "destroy"));
    expect(seatState(n.seat(A), Date.now())).toEqual({ is: "ready", renewBy: 2_000_000_000_000 });
    expect(n.seat(A).account).toBe(ONE);
    // Its status asked in the same VM, with the fleet's salt; and then the VM gone, as its own run.
    expect(n.asked.find((a) => a[0] === "exec")).toEqual(["exec", "vm00000001", ["bash", "-lc", AGENTS.claude!.signIn!.seatCheck(seatSalt(n.vault))]]);
    expect(n.asked.at(-1)).toEqual(["destroy", "vm00000001", { run: `seat.${A}` }]);
    for (const kept of [PAGE, "FAKE-state-0000", CODE, "owner@example.test"]) expect(n.log()).not.toContain(kept);
  });

  test("cancelled: its tool is told, the log says so, and its VM goes; a code after that reaches nothing", async () => {
    const n = node();
    n.add(A);
    const started = n.signIns.start(A);
    await n.settled(() => n.bridge().told.length > 0);
    n.bridge().say({ type: "card", url: PAGE });
    const card = await started;
    await n.signIns.cancel(A, card.attempt);
    expect(n.bridge().told.at(-1)).toEqual({ cancel: true });
    expect(seatState(n.seat(A), Date.now())).toEqual({ is: "signed-out", why: "cancelled" });
    expect(n.asked.at(-1)).toEqual(["destroy", "vm00000001", { run: `seat.${A}` }]);
    expect(() => n.signIns.answer(A, card.attempt, CODE)).toThrow("That sign-in has ended");
  });

  test("it lapses if nobody finishes it, said as expired", async () => {
    const n = node({ attemptMs: 150 });
    n.add(A);
    const started = n.signIns.start(A);
    await n.settled(() => n.bridge().told.length > 0);
    n.bridge().say({ type: "card", url: PAGE });
    await started;
    await n.settled(() => n.asked.some((a) => a[0] === "destroy"));
    expect(seatState(n.seat(A), Date.now())).toEqual({ is: "signed-out", why: "expired" });
  });

  test("an account that isn't the seat's, or is another seat's, is refused and signed out again by its own tool", async () => {
    const n = node({ status: { type: "status", installed: true, signedIn: true, method: "claude.ai", fingerprint: TWO } });
    n.add(A);
    n.add(B);
    n.store.emit(n.identity, "seat.signin", { id: B, phase: "ended", outcome: "ready", fingerprint: TWO });
    const started = n.signIns.start(A);
    await n.settled(() => n.bridge().told.length > 0);
    n.bridge().say({ type: "card", url: PAGE });
    const card = await started;
    n.signIns.answer(A, card.attempt, CODE);
    n.bridge().say({ type: "done", ok: true }, true);
    await n.settled(() => n.asked.some((a) => a[0] === "destroy"));
    expect(seatState(n.seat(A), Date.now())).toEqual({ is: "signed-out", why: "wrong-account" });
    expect(n.seat(A).account).toBeNull();
    expect(n.asked.filter((a) => a[0] === "exec").map((a) => a[2])).toContainEqual(["claude", "auth", "logout"]);
  });

  test("an address that isn't its vendor's is never shown: the sign-in is refused, and nothing is said of it", async () => {
    const n = node();
    n.add(A);
    const started = n.signIns.start(A);
    await n.settled(() => n.bridge().told.length > 0);
    n.bridge().say({ type: "card", url: "https://claude.ai.example.test/oauth/authorize?state=x" });
    await expect(started).rejects.toThrow("isn't its vendor's own");
    expect(n.asked.at(-1)).toEqual(["destroy", "vm00000001", { run: `seat.${A}` }]);
    expect(n.store.seats()[0]!.signIn).toBeNull();
  });
});

describe("a ChatGPT seat's sign-in, by Codex's device code", () => {
  test("its page and code on the card (the first one says to turn device codes on), and ready once its page is done", async () => {
    const n = node({ status: { type: "status", installed: true, signedIn: true, method: "chatgpt", plan: "plus", fingerprint: ONE } });
    n.add(A, "chatgpt-codex");
    const started = n.signIns.start(A);
    await n.settled(() => n.bridge().told.length > 0);
    // (Codex starts on no account: it is told nothing of one.)
    expect(n.bridge().told[0]).toEqual({});
    n.bridge().say({ type: "card", url: DEVICE, code: "FAKE-1234" });
    const card = await started;
    expect(card).toMatchObject({ kind: "device-code", url: DEVICE, code: "FAKE-1234", firstTime: true });
    expect(() => n.signIns.answer(A, card.attempt, CODE)).toThrow("its page finishes it");
    n.bridge().say({ type: "done", ok: true }, true);
    await n.settled(() => n.asked.some((a) => a[0] === "destroy"));
    expect(seatState(n.seat(A), Date.now())).toMatchObject({ is: "ready" });
    expect(n.asked.find((a) => a[0] === "exec")![2]).toEqual(["bash", "-lc", AGENTS.codex!.signIn!.seatCheck(seatSalt(n.vault))]);
    expect(n.log()).not.toContain("FAKE-1234");
    // A second ChatGPT seat's card no longer says it.
    n.next();
    n.add(B, "chatgpt-codex");
    const second = n.signIns.start(B);
    await n.settled(() => n.bridge().told.length > 0);
    n.bridge().say({ type: "card", url: DEVICE, code: "FAKE-5678" });
    expect((await second).firstTime).toBeUndefined();
  });

  test("a sign-in its tool couldn't start says why, and leaves nothing behind", async () => {
    const n = node();
    n.add(A, "chatgpt-codex");
    const started = n.signIns.start(A);
    await n.settled(() => n.bridge().told.length > 0);
    n.bridge().say({ type: "done", ok: false, why: "device code sign-in is off for this workspace" }, true);
    await expect(started).rejects.toThrow("Its sign-in couldn't start: device code sign-in is off for this workspace");
    expect(n.asked.at(-1)).toEqual(["destroy", "vm00000001", { run: `seat.${A}` }]);
  });
});

/*
 * A Gemini plan's seat, signed in with Antigravity's CLI as T3 Code signs it in (agents' antigravity.ts): Google's page on
 * the card, the code its page then shows pasted back to agy once, and its status asked of agy itself in the same VM.
 */
describe("an Antigravity seat's sign-in, Google's to finish", () => {
  const GOOGLE = "https://accounts.google.com/o/oauth2/v2/auth?client_id=FAKE-client.apps.googleusercontent.com&redirect_uri=https%3A%2F%2Fantigravity.google%2Foauth-callback&response_type=code&state=FAKE-state-0000";
  /** A code of the shape Google's callback page shows ("4/0A" and 69 more), fake: made here, never anyone's (the review's H2: a short one hid that the node refused a real one). */
  const GOOGLE_CODE = `4/0A${Array.from({ length: 69 }, (_, i) => "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_"[(i * 37 + 11) % 64]).join("")}`;

  test("Google's page on the card, its code to agy once, then ready as agy says: no account's fingerprint, nothing of it in the log", async () => {
    const n = node({ status: { type: "status", signedIn: true, version: "1.5.18" } });
    n.add(A, "google-antigravity");
    const started = n.signIns.start(A);
    await n.settled(() => n.bridge().told.length > 0);
    // (agy starts on no account: it is told nothing of one.)
    expect(n.bridge().told[0]).toEqual({});
    n.bridge().say({ type: "card", url: GOOGLE });
    const card = await started;
    expect(card).toMatchObject({ seat: A, kind: "paste-code", url: GOOGLE });
    n.signIns.answer(A, card.attempt, GOOGLE_CODE);
    expect(n.bridge().told.filter((t) => "code" in t)).toEqual([{ code: GOOGLE_CODE }]);
    n.bridge().say({ type: "done", ok: true }, true);
    await n.settled(() => n.asked.some((a) => a[0] === "destroy"));
    expect(seatState(n.seat(A), Date.now())).toEqual({ is: "ready", renewBy: null });
    expect(n.seat(A).signIn).toMatchObject({ outcome: "ready", method: "signed in" });
    expect(n.seat(A).account).toBeNull();
    // Its status asked of agy itself, by its own driver's check, in the same VM; then the VM gone, as its own run.
    expect(n.asked.find((a) => a[0] === "exec")).toEqual(["exec", "vm00000001", ["bash", "-lc", AGENTS.antigravity!.signIn!.seatCheck(seatSalt(n.vault))]]);
    expect(n.asked.at(-1)).toEqual(["destroy", "vm00000001", { run: `seat.${A}` }]);
    for (const kept of [GOOGLE, "FAKE-state-0000", GOOGLE_CODE]) expect(n.log()).not.toContain(kept);
  });

  test("an address that isn't Google's own sign-in is never shown, the page that shows its code included", async () => {
    const n = node();
    n.add(A, "google-antigravity");
    const started = n.signIns.start(A);
    await n.settled(() => n.bridge().told.length > 0);
    n.bridge().say({ type: "card", url: "https://antigravity.google/oauth-callback?code=FAKE" });
    await expect(started).rejects.toThrow("isn't its vendor's own");
    expect(n.store.seats()[0]!.signIn).toBeNull();
  });

  test("signed out after it, as agy says: the seat is out, and nothing is signed out by a command of ours", async () => {
    const n = node({ status: { type: "status", signedIn: false } });
    n.add(A, "google-antigravity");
    const started = n.signIns.start(A);
    await n.settled(() => n.bridge().told.length > 0);
    n.bridge().say({ type: "card", url: GOOGLE });
    const card = await started;
    n.signIns.answer(A, card.attempt, GOOGLE_CODE);
    n.bridge().say({ type: "done", ok: true }, true);
    await n.settled(() => n.asked.some((a) => a[0] === "destroy"));
    expect(seatState(n.seat(A), Date.now())).toEqual({ is: "signed-out", why: "signed-out" });
    expect(n.asked.filter((a) => a[0] === "exec")).toHaveLength(1);
  });
});

describe("what isn't signed in here", () => {
  test("a Mistral plan is a key; Sign in with ChatGPT is the node's own; a seat whose home is elsewhere is signed in there", async () => {
    const n = node();
    await expect(n.signIns.start(n.add(A, "mistral-vibe"))).rejects.toThrow("A Mistral plan signs in with a key");
    await expect(n.signIns.start(n.add(B, "chatgpt-siwc"))).rejects.toThrow("Sign in with ChatGPT signs in on the node itself");
    const other = newNodeIdentity();
    n.store.emit(n.identity, "device.enrolled", { device: other.id, name: "mini", kind: "node", role: "full", box: "FAKEbox", scopes: [] } as never);
    const elsewhere = `st_${"c".repeat(22)}`;
    n.store.emit(n.identity, "seat.added", { id: elsewhere, kind: "claude-subscription", label: "Elsewhere", node: other.id, runs: 1 }, yourWord(null));
    await expect(n.signIns.start(elsewhere)).rejects.toThrow("This seat's home is on another node");
    await expect(n.signIns.start(`st_${"d".repeat(22)}`)).rejects.toThrow("no such seat");
    expect(n.asked).toEqual([]);
  });
});
