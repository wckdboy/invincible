import { describe, expect, test } from "bun:test";
import { type RouteName, TEAM_LIMITS, type TeamTask, type TurnView } from "@invincible/core";
import type { NodeClient } from "../../src/inv/client.ts";
import type { Connection } from "../../src/inv/connect.ts";
import { CliError, EXIT } from "../../src/inv/exit.ts";
import type { Flags } from "../../src/inv/io.ts";
import { run } from "../../src/inv/run.ts";
import { steerCommand } from "../../src/inv/steer.ts";
import { snapshot, task, testIo } from "./fixtures.ts";

/*
 * inv steer (docs/CLI.md): your words to a task that is running, or to your agent's turn in a chat, taken at its next
 * safe point. It exits 0 once the node has them, 1 when it refuses them (in its own words), 2 for bad usage, 30 when
 * this device may not, 31 when nothing answers.
 */

const flags = (over: Partial<Flags> = {}): Flags => ({ json: false, stream: false, wait: false, noAsk: false, gate: [], forTask: false, needsYou: false, working: false, done: false, week: false, forget: false, help: false, ...over });

const TURN = `tn_${"a".repeat(22)}`;
const CHAT = "c_release";
const turn = (over: Partial<TurnView> = {}): TurnView => ({ id: TURN, conversation: CHAT, title: "The release plan", role: "planner", state: "running", startedAt: 0, endedAt: null, deadline: 0, model: null, step: null, tools: 0, watchers: 0, steering: 0, watchable: true, ...over });

/** A node with these tasks and these turns; what it was asked, in order; and how it answers a steer (a refusal to throw). */
function node(tasks: TeamTask[], turns: TurnView[] = [], refuse?: CliError) {
  const asked: { name: RouteName; input: unknown }[] = [];
  const client: NodeClient = {
    label: "a stand-in node",
    async call<T>(name: RouteName, input?: unknown): Promise<T> {
      asked.push({ name, input });
      if (name === "team") return snapshot(tasks) as T;
      if (name === "turns") return { turns, limits: { maxTurns: 4, maxMinutes: 30, maxQueued: 20 }, chats: "1", unread: [] } as T;
      if (refuse && (name === "steerTeamTask" || name === "steerTurn")) throw refuse;
      if (name === "steerTeamTask") {
        const { task: id, text } = input as { task: string; text: string };
        const found = tasks.find((one) => one.id === id)!;
        return { task: { ...found, steers: [...(found.steers ?? []), { by: "owner", text, at: 1 }] }, steer: { by: "owner", text, at: 1 } } as T;
      }
      if (name === "steerTurn") return { steered: true, waiting: 1 } as T;
      return {} as T;
    },
  } as NodeClient;
  return { conn: async (): Promise<Connection> => ({ client, how: "paired", pairing: null }), asked };
}

describe("inv steer <task>", () => {
  test("your words to its running task: it says the node has them, and where to watch them reach it", async () => {
    const n = node([task()]);
    const io = testIo({});
    expect(await steerCommand(n.conn, ["a1b2", "use", "the", "new", "schema"], flags(), io)).toBe(EXIT.ok);
    expect(n.asked.at(-1)).toEqual({ name: "steerTeamTask", input: { task: "task-a1b2c3d4e5f6", text: "use the new schema" } });
    expect(io.stdout()).toBe("Steered task-a1b2c3d4e5f6: Fix the flaky link sync test. It takes your words at its next safe point; inv watch task-a1b2c3d4e5f6 shows where.\n");
  });

  test("--json: one object, the task and how many of its steers wait for it", async () => {
    const io = testIo({});
    expect(await steerCommand(node([task({ steers: [{ by: "primary", text: "Keep the old reader.", at: 0 }] })]).conn, ["task-a1b2c3d4e5f6", "Use the new schema."], flags({ json: true }), io)).toBe(EXIT.ok);
    expect(JSON.parse(io.stdout())).toEqual({ task: "task-a1b2c3d4e5f6", waiting: 2 });
  });

  test("a task the node won't steer is refused in its words, and exits 1; one this device may not steer exits 30", async () => {
    const ended = node([task({ status: "done", verified: true })], [], new CliError("It has ended: give it again from a step instead."));
    await expect(steerCommand(ended.conn, ["a1b2", "x"], flags(), testIo({}))).rejects.toMatchObject({ exit: EXIT.error, message: "It has ended: give it again from a step instead." });
    const refused = node([task()], [], new CliError("a stand-in node refused: requires scope fleet:admin", EXIT.refused));
    await expect(steerCommand(refused.conn, ["a1b2", "x"], flags(), testIo({}))).rejects.toMatchObject({ exit: EXIT.refused });
  });

  test("words are needed, and no more than a steer may hold: said before anything is sent", async () => {
    const n = node([task()]);
    await expect(steerCommand(n.conn, ["a1b2"], flags(), testIo({}))).rejects.toMatchObject({ exit: EXIT.usage });
    await expect(steerCommand(n.conn, [], flags(), testIo({}))).rejects.toMatchObject({ exit: EXIT.usage, message: 'usage: inv steer <task> "<what it should take up>" · inv steer --chat <id> "…"' });
    await expect(steerCommand(n.conn, ["a1b2", "x".repeat(TEAM_LIMITS.steer + 1)], flags(), testIo({}))).rejects.toMatchObject({ exit: EXIT.usage, message: `a steer holds at most ${TEAM_LIMITS.steer} characters` });
    expect(n.asked.filter((a) => a.name === "steerTeamTask")).toEqual([]);
  });
});

describe("inv steer --chat <id>", () => {
  test("your words to your agent's turn running in that chat: steered through the node, as Steer does in the apps", async () => {
    const n = node([], [turn()]);
    const io = testIo({});
    expect(await steerCommand(n.conn, ["keep", "it", "short"], flags({ chat: CHAT }), io)).toBe(EXIT.ok);
    expect(n.asked.at(-1)).toEqual({ name: "steerTurn", input: { turn: TURN, text: "keep it short" } });
    expect(io.stdout()).toBe("Steered your agent in “The release plan”: it reads your words at its next safe point.\n");
    const json = testIo({});
    expect(await steerCommand(n.conn, ["keep it short"], flags({ chat: CHAT, json: true }), json)).toBe(EXIT.ok);
    expect(JSON.parse(json.stdout())).toEqual({ chat: CHAT, turn: TURN, waiting: 1 });
  });

  test("with nothing running in it, it says how to say it there instead, and exits 1", async () => {
    const n = node([task()], [turn({ conversation: "c_other" })]);
    await expect(steerCommand(n.conn, ["keep it short"], flags({ chat: CHAT }), testIo({}))).rejects.toMatchObject({ exit: EXIT.error, message: `nothing is running in that chat now: inv "…" --chat ${CHAT} says it there` });
    expect(n.asked.filter((a) => a.name === "steerTurn")).toEqual([]);
  });
});

describe("inv steer, read from its words and its flags", () => {
  test("it takes --chat and --json, and nothing else", async () => {
    const io = testIo({});
    expect(await run(["steer", "a1b2", "x", "--wait"], io)).toBe(EXIT.usage);
    expect(io.stderr()).toBe("inv: inv steer takes no --wait (inv help)\n");
  });

  test("the help says it", async () => {
    const io = testIo({});
    expect(await run(["help"], io)).toBe(EXIT.ok);
    expect(io.stdout()).toContain('inv steer <task> "…"');
  });
});
