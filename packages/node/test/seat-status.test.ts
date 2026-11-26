import { describe, expect, test } from "bun:test";
import { newNodeIdentity, seatState } from "@invincible/core";
import { CLAUDE } from "@invincible/agents";
import { foundFleet, LedgerStore, Vault } from "@invincible/ledger";
import { askSeat, recordSeatStatus, SEATS_SALT, seatSalt, yourWord } from "../src/seats.ts";

/*
 * A seat's status on the node that holds its home (seats.ts): asked of its own tool in a VM made for it, which goes once
 * it has answered; told to the log only when it changes; and never a sign-in to an account other than the seat's own or
 * one that is another seat's. One salt for the fleet, so one account is one fingerprint whatever its seat.
 */

function mind() {
  const node = newNodeIdentity();
  const store = new LedgerStore(":memory:");
  foundFleet(store, node, { fleetName: "homelab", nodeName: "ultra" });
  const add = (id: string) => (store.emit(node, "seat.added", { id, kind: "claude-subscription", label: "Work Max", node: node.id, runs: 3 }, yourWord(null)), id);
  const seat = (id: string) => store.seats().find((s) => s.id === id)!;
  const signins = () => store.eventsSince({}, 10_000).events.filter((e) => e.kind === "seat.signin");
  return { node, store, add, seat, signins, vault: new Vault(store, node) };
}

const A = `st_${"a".repeat(22)}`;
const B = `st_${"b".repeat(22)}`;
const ATTEMPT = `sa_${"c".repeat(22)}`;
const ONE = "F".repeat(22);
const TWO = "G".repeat(22);

describe("what the log is told of a seat's status", () => {
  test("a sign-in once, and then only what changes: the same status again says nothing", () => {
    const m = mind();
    m.add(A);
    expect(recordSeatStatus(m.store, m.node, m.seat(A), { signedIn: true, method: "claude.ai", plan: "max", fingerprint: ONE, renewBy: 2_000_000_000_000 }, ATTEMPT)).toBe("ready");
    expect(m.seat(A).account).toBe(ONE);
    expect(seatState(m.seat(A), Date.now())).toEqual({ is: "ready", renewBy: 2_000_000_000_000 });
    const after = m.signins().length;
    expect(recordSeatStatus(m.store, m.node, m.seat(A), { signedIn: true, method: "claude.ai", plan: "max", fingerprint: ONE, renewBy: 2_000_000_000_000 })).toBe("ready");
    expect(m.signins()).toHaveLength(after);
    // A new end to its sign-in (renewed), and a sign-out, are said.
    recordSeatStatus(m.store, m.node, m.seat(A), { signedIn: true, method: "claude.ai", plan: "max", fingerprint: ONE, renewBy: 2_100_000_000_000 });
    expect(m.signins()).toHaveLength(after + 1);
    expect(recordSeatStatus(m.store, m.node, m.seat(A), { signedIn: false })).toBe("signed-out");
    expect(seatState(m.seat(A), Date.now())).toEqual({ is: "signed-out", why: "signed-out" });
    // Signed out and still signed out: nothing more.
    recordSeatStatus(m.store, m.node, m.seat(A), { signedIn: false });
    expect(m.signins()).toHaveLength(after + 2);
  });

  test("a seat signed in to another account than its own, or to another seat's, is refused, and its own stands", () => {
    const m = mind();
    m.add(A);
    m.add(B);
    recordSeatStatus(m.store, m.node, m.seat(A), { signedIn: true, method: "claude.ai", fingerprint: ONE }, ATTEMPT);
    expect(recordSeatStatus(m.store, m.node, m.seat(A), { signedIn: true, method: "claude.ai", fingerprint: TWO }, ATTEMPT)).toBe("wrong-account");
    expect(m.seat(A).account).toBe(ONE);
    expect(seatState(m.seat(A), Date.now())).toEqual({ is: "signed-out", why: "wrong-account" });
    // B signed in to A's account: one account, two seats, would be one window counted twice.
    expect(recordSeatStatus(m.store, m.node, m.seat(B), { signedIn: true, method: "claude.ai", fingerprint: ONE }, ATTEMPT)).toBe("wrong-account");
    expect(m.seat(B).account).toBeNull();
    expect(recordSeatStatus(m.store, m.node, m.seat(B), { signedIn: true, method: "claude.ai", fingerprint: TWO }, ATTEMPT)).toBe("ready");
  });
});

describe("asking a seat's tool", () => {
  test("in a VM made for the seat, from its own check with the fleet's salt; the VM goes, even when the ask fails", async () => {
    const m = mind();
    m.add(A);
    const asked: unknown[] = [];
    const host = {
      createSeatVm: async (input: unknown) => (asked.push(["vm", input]), { id: "vm00000001" }) as never,
      exec: async (id: string, cmd: string[]) => (asked.push(["exec", id, cmd]), { exitCode: 0, stdout: JSON.stringify({ type: "status", installed: true, signedIn: true, method: "claude.ai", plan: "max", fingerprint: ONE, email: "agent@example.invalid" }), stderr: "", durationMs: 1, truncated: false }),
      destroy: async (id: string, opts: unknown) => (asked.push(["destroy", id, opts]), { verdict: "allow" as const, reason: "its own run" }),
    };
    const salt = seatSalt(m.vault);
    expect(seatSalt(m.vault)).toBe(salt);
    expect(m.vault.has(SEATS_SALT)).toBe(true);
    expect(await askSeat(host, m.seat(A), CLAUDE, salt)).toEqual({ signedIn: true, method: "claude.ai", plan: "max", fingerprint: ONE });
    expect(asked).toEqual([
      // (It takes no more than has been shown safe at once, whatever its setting: SHARED_RUNS_PROVEN.)
      ["vm", { seat: { id: A, kind: "claude-subscription", runs: 1 }, network: "online", cpus: 1, memoryGb: 1, ttlMinutes: 15, run: `seat.${A}` }],
      ["exec", "vm00000001", ["bash", "-lc", CLAUDE.signIn!.seatCheck(salt)]],
      ["destroy", "vm00000001", { run: `seat.${A}` }],
    ]);
    asked.length = 0;
    const failing = { ...host, exec: async () => { throw new Error("the VM went away"); } };
    await expect(askSeat(failing, m.seat(A), CLAUDE, salt)).rejects.toThrow("the VM went away");
    expect(asked.at(-1)).toEqual(["destroy", "vm00000001", { run: `seat.${A}` }]);
  });
});
