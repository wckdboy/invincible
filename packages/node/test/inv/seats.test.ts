import { describe, expect, test } from "bun:test";
import type { RouteName, SeatSignInCard, SeatView } from "@invincible/core";
import type { NodeClient } from "../../src/inv/client.ts";
import type { Connection } from "../../src/inv/connect.ts";
import { EXIT } from "../../src/inv/exit.ts";
import type { Flags } from "../../src/inv/io.ts";
import { run } from "../../src/inv/run.ts";
import { seatCommand, seatsCommand } from "../../src/inv/seats.ts";
import { testIo } from "./fixtures.ts";

/*
 * inv seats and inv seat (docs/CLI.md): your accounts with a vendor, each signed in on its vendor's page. A sign-in says
 * its page (and Codex's code to enter there), reads the code Claude's page shows from the terminal, and waits until it
 * has ended: 0 signed in, 1 not.
 */

const flags = (over: Partial<Flags> = {}): Flags => ({ json: false, stream: false, wait: false, noAsk: false, gate: [], forTask: false, needsYou: false, working: false, done: false, week: false, forget: false, help: false, ...over });
const ID = `st_${"a".repeat(22)}`;
const ATTEMPT = `sa_${"b".repeat(22)}`;
const seatOf = (over: Partial<SeatView> = {}): SeatView => ({ id: ID, kind: "claude-subscription", vendor: "anthropic", label: "Claude 1", node: "n_node", provider: null, runs: 1, plan: null, method: null, state: { is: "signed-out", why: "never" }, windows: [], serves: [], ...over });

/** A node with these seats; what it was asked, in order; how a sign-in goes (its card, and the state it ends in). */
function node(seats: SeatView[], card: SeatSignInCard, ends: SeatView["state"] = { is: "ready", renewBy: null }) {
  const asked: { name: RouteName; input: unknown }[] = [];
  let looks = 0;
  const client: NodeClient = {
    label: "a stand-in node",
    async call<T>(name: RouteName, input?: unknown): Promise<T> {
      asked.push({ name, input });
      if (name === "seats") {
        // Signing in for a look or two, then as it ended.
        const signing = asked.some((a) => a.name === "startSeatSignIn") && looks++ < 2;
        return { seats: seats.map((seat) => ({ ...seat, ...(asked.some((a) => a.name === "startSeatSignIn") ? { state: signing ? { is: "signing-in", attempt: ATTEMPT, since: 0, until: 1 } : ends, plan: "max" } : {}) })) } as T;
      }
      if (name === "addSeat") {
        const { kind, label } = input as { kind: SeatView["kind"]; label: string };
        const seat = seatOf({ kind, label });
        seats.push(seat);
        return { seat } as T;
      }
      if (name === "startSeatSignIn") return { card } as T;
      return {} as T;
    },
  } as NodeClient;
  return { conn: async (): Promise<Connection> => ({ client, how: "paired", pairing: null }), asked };
}

const DEVICE: SeatSignInCard = { attempt: ATTEMPT, seat: ID, kind: "device-code", url: "https://auth.openai.com/codex/device", code: "FAKE-1234", until: 1, firstTime: true };
const PASTE: SeatSignInCard = { attempt: ATTEMPT, seat: ID, kind: "paste-code", url: "https://claude.ai/oauth/authorize?state=FAKE", until: 1 };

describe("inv seat add", () => {
  test("a ChatGPT plan: added with its name, its page and code said, and 0 once it is signed in", async () => {
    const n = node([], DEVICE);
    const io = testIo({});
    expect(await seatCommand(n.conn, ["add", "chatgpt"], flags(), io)).toBe(EXIT.ok);
    expect(n.asked.find((a) => a.name === "addSeat")?.input).toEqual({ kind: "chatgpt-codex", label: "ChatGPT 1" });
    expect(io.stdout()).toContain("First, turn on device code sign-in in ChatGPT's settings (Security)");
    expect(io.stdout()).toContain("Open https://auth.openai.com/codex/device and sign in to the account this seat is for, then enter this code there: FAKE-1234\n");
    expect(io.stdout().trimEnd().split("\n").at(-1)).toBe("ChatGPT 1: Signed in · Max");
  });

  test("a Claude plan: the code its page shows read from the terminal, to its sign-in once; with --email, its account", async () => {
    const n = node([], PASTE);
    const io = { ...testIo({}), readLine: async (prompt: string) => (prompt === "Paste the code it shows: " ? "  FAKEcode0000#FAKE-state  " : null) };
    expect(await seatCommand(n.conn, ["add", "claude", "Work Max"], flags({ email: "owner@example.test" }), io)).toBe(EXIT.ok);
    expect(n.asked.find((a) => a.name === "addSeat")?.input).toEqual({ kind: "claude-subscription", label: "Work Max", email: "owner@example.test" });
    expect(n.asked.filter((a) => a.name === "answerSeatSignIn").map((a) => a.input)).toEqual([{ id: ID, attempt: ATTEMPT, code: "FAKEcode0000#FAKE-state" }]);
  });

  test("where it can't read a code (a pipe, --no-ask) it says to run it in a terminal; no code given cancels it; not signed in is 1", async () => {
    await expect(seatCommand(node([], PASTE).conn, ["add", "claude"], flags(), testIo({}))).rejects.toMatchObject({ exit: EXIT.usage });
    const empty = node([], PASTE);
    await expect(seatCommand(empty.conn, ["add", "claude"], flags(), { ...testIo({}), readLine: async () => "" })).rejects.toThrow("the sign-in was cancelled");
    expect(empty.asked.some((a) => a.name === "cancelSeatSignIn")).toBe(true);
    const lapsed = node([], DEVICE, { is: "signed-out", why: "expired" });
    const io = testIo({});
    expect(await seatCommand(lapsed.conn, ["add", "chatgpt"], flags(), io)).toBe(EXIT.error);
    expect(io.stdout().trimEnd().split("\n").at(-1)).toBe("ChatGPT 1: Sign-in lapsed");
  });
});

describe("inv seats, sign-in and remove", () => {
  test("the list says each seat, its vendor and where it stands; --json is the node's own", async () => {
    const n = node([seatOf({ label: "Work Max", plan: "max", state: { is: "ready", renewBy: null } })], PASTE);
    const io = testIo({});
    expect(await seatsCommand(n.conn, [], flags(), io)).toBe(EXIT.ok);
    expect(io.stdout()).toBe(`Work Max  anthropic  Signed in · Max  ${ID}\n`);
    const json = testIo({});
    expect(await seatsCommand(n.conn, [], flags({ json: true }), json)).toBe(EXIT.ok);
    expect(JSON.parse(json.stdout()).seats[0].label).toBe("Work Max");
    const none = testIo({});
    await seatsCommand(node([], PASTE).conn, [], flags(), none);
    expect(none.stdout()).toBe("No seats yet: inv seat add claude, or inv seat add chatgpt.\n");
  });

  test("a seat by its label or its id: signed in again, or removed with its sign-in", async () => {
    const n = node([seatOf({ kind: "chatgpt-codex", label: "Personal" })], DEVICE);
    expect(await seatCommand(n.conn, ["sign-in", "Personal"], flags(), testIo({}))).toBe(EXIT.ok);
    expect(n.asked.find((a) => a.name === "startSeatSignIn")?.input).toEqual({ id: ID });
    const io = testIo({});
    expect(await seatCommand(n.conn, ["remove", ID], flags(), io)).toBe(EXIT.ok);
    expect(n.asked.at(-1)).toEqual({ name: "removeSeat", input: { id: ID } });
    expect(io.stdout()).toBe("Removed Personal, and its sign-in.\n");
    await expect(seatCommand(n.conn, ["remove", "Nobody"], flags(), testIo({}))).rejects.toThrow("no seat Nobody");
  });

  test("its usage, and the help says it", async () => {
    await expect(seatCommand(node([], PASTE).conn, ["add", "gemini"], flags(), testIo({}))).rejects.toMatchObject({ exit: EXIT.usage });
    await expect(seatCommand(node([], PASTE).conn, [], flags(), testIo({}))).rejects.toMatchObject({ exit: EXIT.usage });
    const io = testIo({});
    expect(await run(["help"], io)).toBe(EXIT.ok);
    expect(io.stdout()).toContain("inv seat add <claude|chatgpt>");
  });
});
