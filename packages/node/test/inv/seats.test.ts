import { describe, expect, test } from "bun:test";
import type { RouteName, SeatSignInCard, SeatUse, SeatView } from "@invincible/core";
import type { NodeClient } from "../../src/inv/client.ts";
import type { Connection } from "../../src/inv/connect.ts";
import { refusal } from "../../src/inv/client.ts";
import { EXIT } from "../../src/inv/exit.ts";
import type { Flags } from "../../src/inv/io.ts";
import { run } from "../../src/inv/run.ts";
import { seatCommand, seatsCommand } from "../../src/inv/seats.ts";
import { testIo } from "./fixtures.ts";

/*
 * inv seats and inv seat (docs/CLI.md): your accounts with a vendor, each signed in on its vendor's page. A sign-in says
 * its page (and Codex's code to enter there), reads the code Claude's page shows from the terminal, and waits until it
 * has ended: 0 signed in, 1 not. Each serves the agent you name, and agents share one only when you say so: what that
 * means is said as you do.
 */

const flags = (over: Partial<Flags> = {}): Flags => ({ json: false, stream: false, wait: false, noAsk: false, gate: [], forTask: false, needsYou: false, working: false, done: false, week: false, forget: false, help: false, ...over });
const ID = `st_${"a".repeat(22)}`;
const ATTEMPT = `sa_${"b".repeat(22)}`;
const seatOf = (over: Partial<SeatView> = {}): SeatView => ({ id: ID, kind: "claude-subscription", vendor: "anthropic", label: "Claude 1", node: "n_node", provider: null, runs: 1, plan: null, method: null, state: { is: "signed-out", why: "never" }, windows: [], serves: [], ...over });

/** This node's team: Ada and Bo, each as its team made them. */
const TEAM = { agents: [{ id: "ada", name: "Ada", createdAt: 1_000, harness: "claude" }, { id: "bo", name: "Bo", createdAt: 2_000, harness: "claude" }], rooms: [], tasks: [], deliveries: [] };
const made = (id: string) => TEAM.agents.find((agent) => agent.id === id)!.createdAt;

/** A node with these seats; what it was asked, in order; how a sign-in goes (its card, and the state it ends in). */
function node(seats: SeatView[], card: SeatSignInCard, ends: SeatView["state"] = { is: "ready", renewBy: null }, use?: Record<string, SeatUse>) {
  const asked: { name: RouteName; input: unknown }[] = [];
  let looks = 0;
  const client: NodeClient = {
    label: "a stand-in node",
    async call<T>(name: RouteName, input?: unknown): Promise<T> {
      asked.push({ name, input });
      if (name === "seats") {
        // Signing in for a look or two, then as it ended.
        const signing = asked.some((a) => a.name === "startSeatSignIn") && looks++ < 2;
        return { seats: seats.map((seat) => ({ ...seat, ...(asked.some((a) => a.name === "startSeatSignIn") ? { state: signing ? { is: "signing-in", attempt: ATTEMPT, since: 0, until: 1 } : ends, plan: "max" } : {}) })), ...(use ? { use } : {}) } as T;
      }
      if (name === "addSeat") {
        const { kind, label, agent } = input as { kind: SeatView["kind"]; label: string; agent?: string };
        const seat = seatOf({ kind, label, serves: agent ? [{ id: agent, made: made(agent) }] : [] });
        seats.push(seat);
        return { seat } as T;
      }
      if (name === "setSeatServes") {
        const { id, agents } = input as { id: string; agents: string[] };
        const at = seats.findIndex((seat) => seat.id === id);
        seats[at] = { ...seats[at]!, serves: agents.map((agent) => ({ id: agent, made: made(agent) })) };
        return { seat: seats[at] } as T;
      }
      if (name === "team") return TEAM as T;
      if (name === "whoami") return { node: "n_node" } as T;
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

  test("a Gemini plan: the risk Google's terms put on your account said first, Google's page, then the code its last page shows read here", async () => {
    const google: SeatSignInCard = { attempt: ATTEMPT, seat: ID, kind: "paste-code", url: "https://accounts.google.com/o/oauth2/v2/auth?state=FAKE", until: 1 };
    const n = node([], google);
    const io = { ...testIo({}), readLine: async (prompt: string) => (prompt === "Paste the code it shows: " ? "  4/0FAKE-code-0000  " : null) };
    expect(await seatCommand(n.conn, ["add", "gemini"], flags(), io)).toBe(EXIT.ok);
    expect(n.asked.find((a) => a.name === "addSeat")?.input).toEqual({ kind: "google-antigravity", label: "Gemini 1" });
    expect(io.stdout()).toContain("Google's Antigravity terms call reaching it through another tool, as Invincible does, a breach that may get your Antigravity and Gemini CLI accounts suspended: you chose this on 27 November 2026, accepting that risk to your Google account.\nOpen https://accounts.google.com/o/oauth2/v2/auth?state=FAKE and sign in to the account this seat is for.\n");
    expect(n.asked.filter((a) => a.name === "answerSeatSignIn").map((a) => a.input)).toEqual([{ id: ID, attempt: ATTEMPT, code: "4/0FAKE-code-0000" }]);
  });

  test("a kind a node of the fleet can't read yet: the node's words, which node to update first, and nothing signed in", async () => {
    const n = node([], PASTE);
    const behind = "Update mini first: it runs a release that doesn't know Gemini plans";
    const real = n.conn;
    // The node refuses the add (409), as the client says any refusal: in the node's own words.
    const conn = async () => {
      const made = await real();
      return { ...made, client: { ...made.client, call: async (name: string, input?: unknown) => (name === "addSeat" ? Promise.reject(refusal(409, behind, "the node", "unknown")) : made.client.call(name as never, input)) } as typeof made.client };
    };
    const io = testIo({});
    await expect(seatCommand(conn, ["add", "gemini"], flags(), io)).rejects.toMatchObject({ message: behind, exit: EXIT.error });
    expect(n.asked.map((a) => a.name)).not.toContain("startSeatSignIn");
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
    expect(io.stdout()).toBe(`Work Max  anthropic  Signed in · Max  ${ID}  Serves no agent yet\n`);
    const json = testIo({});
    expect(await seatsCommand(n.conn, [], flags({ json: true }), json)).toBe(EXIT.ok);
    expect(JSON.parse(json.stdout()).seats[0].label).toBe("Work Max");
    const none = testIo({});
    await seatsCommand(node([], PASTE).conn, [], flags(), none);
    expect(none.stdout()).toBe("No seats yet: inv seat add claude, inv seat add chatgpt, or inv seat add gemini.\n");
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
    await expect(seatCommand(node([], PASTE).conn, ["add", "cursor"], flags(), testIo({}))).rejects.toMatchObject({ exit: EXIT.usage });
    await expect(seatCommand(node([], PASTE).conn, [], flags(), testIo({}))).rejects.toMatchObject({ exit: EXIT.usage });
    const io = testIo({});
    expect(await run(["help"], io)).toBe(EXIT.ok);
    expect(io.stdout()).toContain("inv seat add <claude|chatgpt|gemini>");
    expect(io.stdout()).toContain("inv seat serve <seat> <agent>");
    expect(io.stdout()).toContain("inv seat share <seat> <agent> <agent>");
  });
});

describe("inv seat serve and share", () => {
  test("a seat serves the agent you name; in place of another, what that means is said", async () => {
    const n = node([seatOf({ serves: [{ id: "ada", made: made("ada") }] })], PASTE);
    const io = testIo({});
    expect(await seatCommand(n.conn, ["serve", "Claude 1", "bo"], flags(), io)).toBe(EXIT.ok);
    expect(n.asked.find((a) => a.name === "setSeatServes")?.input).toEqual({ id: ID, agents: ["bo"] });
    expect(io.stdout()).toBe("bo will run with what ada's runs left in Claude 1's home (its tool's settings, hooks and notes): ada and bo are one trust domain.\nClaude 1: Serves bo\n");
    // The one it serves already: nothing new to say.
    const again = testIo({});
    expect(await seatCommand(n.conn, ["serve", ID, "bo"], flags(), again)).toBe(EXIT.ok);
    expect(again.stdout()).toBe("Claude 1: Serves bo\n");
  });

  test("a share names two agents or more, says what it means, and is sent as a share you said", async () => {
    const n = node([seatOf({ serves: [{ id: "ada", made: made("ada") }] })], PASTE);
    const io = testIo({});
    expect(await seatCommand(n.conn, ["share", ID, "ada", "bo"], flags(), io)).toBe(EXIT.ok);
    expect(n.asked.find((a) => a.name === "setSeatServes")?.input).toEqual({ id: ID, agents: ["ada", "bo"], shared: true });
    expect(io.stdout()).toBe("ada and bo will share Claude 1's home, and what any of their runs leave there (its tool's settings, hooks and notes) the next one runs with: they are one trust domain.\nClaude 1: Shared by ada and bo: one trust domain\n");
    const json = testIo({});
    expect(await seatCommand(n.conn, ["share", ID, "ada", "bo"], flags({ json: true }), json)).toBe(EXIT.ok);
    expect(JSON.parse(json.stdout()).seat.serves).toEqual([{ id: "ada", made: made("ada") }, { id: "bo", made: made("bo") }]);
    // One agent is no share, and serve names one.
    await expect(seatCommand(n.conn, ["share", ID, "ada"], flags(), testIo({}))).rejects.toMatchObject({ exit: EXIT.usage });
    await expect(seatCommand(n.conn, ["serve", ID, "ada", "bo"], flags(), testIo({}))).rejects.toMatchObject({ exit: EXIT.usage });
    await expect(seatCommand(n.conn, ["serve", ID], flags(), testIo({}))).rejects.toMatchObject({ exit: EXIT.usage });
  });

  test("inv seats says whom each serves, from its node's team: an agent removed is served no more; another node's, as you chose there", async () => {
    const seats = [
      seatOf({ label: "Ours", serves: [{ id: "ada", made: made("ada") }, { id: "bo", made: made("bo") }] }),
      seatOf({ id: `st_${"r".repeat(22)}`, label: "Removed's", serves: [{ id: "cy", made: 3_000 }] }),
      seatOf({ id: `st_${"m".repeat(22)}`, label: "Mini's", node: "n_mini", serves: [{ id: "lin", made: 4_000 }] }),
    ];
    const io = testIo({});
    expect(await seatsCommand(node(seats, PASTE).conn, [], flags(), io)).toBe(EXIT.ok);
    expect(io.stdout().split("\n").map((line) => line.split("  ").at(-1))).toEqual(["Shared by ada and bo: one trust domain", "Serves no agent now", "Serves lin", ""]);
  });

  test("inv seat add --agent: added for that agent; without one, it says it serves none yet and how to choose", async () => {
    const n = node([], DEVICE);
    const io = testIo({});
    expect(await seatCommand(n.conn, ["add", "chatgpt"], flags({ agent: "bo" }), io)).toBe(EXIT.ok);
    expect(n.asked.find((a) => a.name === "addSeat")?.input).toEqual({ kind: "chatgpt-codex", label: "ChatGPT 1", agent: "bo" });
    expect(io.stdout().split("\n")[0]).toBe(`Added ChatGPT 1 (${ID}), for bo.`);
    const plain = testIo({});
    expect(await seatCommand(node([], DEVICE).conn, ["add", "chatgpt"], flags(), plain)).toBe(EXIT.ok);
    expect(plain.stdout().split("\n")[0]).toBe(`Added ChatGPT 1 (${ID}). It serves no agent yet: inv seat serve ${ID} <agent>.`);
  });
});

describe("inv seats: the meter", () => {
  const NOW = Date.UTC(2026, 10, 27, 9, 0);
  test("under each seat, its meter: its open windows and its use lately; a ChatGPT plan's use, where ChatGPT counts it; --json has the node's use too", async () => {
    const claude = seatOf({ label: "Work Max", plan: "max", state: { is: "ready", renewBy: null }, windows: [{ window: "five_hour", status: "allowed", usedPercent: 42, resetsAt: NOW + 5 * 3_600_000, at: NOW }] });
    const codex = seatOf({ id: `st_${"c".repeat(22)}`, kind: "chatgpt-codex", vendor: "openai", label: "Personal", state: { is: "ready", renewBy: null } });
    const use = { [claude.id]: { since: NOW - 7 * 86_400_000, tasks: 3, tokens: 1_204_000, running: 1 } };
    const io = { ...testIo({}), now: () => NOW };
    expect(await seatsCommand(node([claude, codex], PASTE, undefined, use).conn, [], flags(), io)).toBe(EXIT.ok);
    expect(io.stdout()).toBe(
      `Work Max  anthropic  Signed in · Max  ${claude.id}  Serves no agent yet\n` +
        `    Five hours: 42% used, resets 14:00 UTC · 3 tasks this week · 1.20M tokens · 1 running now\n` +
        `Personal  openai  Signed in  ${codex.id}  Serves no agent yet\n` +
        `    Its use as ChatGPT counts it: Settings → Usage (https://chatgpt.com/)\n`,
    );
    const json = { ...testIo({}), now: () => NOW };
    expect(await seatsCommand(node([claude], PASTE, undefined, use).conn, [], flags({ json: true }), json)).toBe(EXIT.ok);
    expect(JSON.parse(json.stdout()).use).toEqual(use);
  });
});
