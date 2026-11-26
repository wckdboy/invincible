import { describe, expect, test } from "bun:test";
import type { RouteName } from "@invincible/core";
import { askCommand } from "../../src/inv/ask.ts";
import type { NodeClient } from "../../src/inv/client.ts";
import type { Connection } from "../../src/inv/connect.ts";
import { EXIT } from "../../src/inv/exit.ts";
import type { Flags } from "../../src/inv/io.ts";
import { againCommand } from "../../src/inv/work.ts";
import { snapshot, task, testIo } from "./fixtures.ts";

/*
 * inv "…" and inv again (docs/CLI.md): a word with your agent, its answer streamed as plain text (a terminal acts on
 * nothing in it), kept in your history; and a task given again as its agent's new one, from a step where asked.
 */

const flags = (over: Partial<Flags> = {}): Flags => ({ json: false, stream: false, wait: false, noAsk: false, gate: [], forTask: false, needsYou: false, working: false, done: false, week: false, forget: false, help: false, ...over });
const ESC = String.fromCharCode(27);

function node(events: object[]) {
  const asked: { name: RouteName; input: unknown }[] = [];
  const client: NodeClient = {
    label: "a stand-in node",
    async call<T>(name: RouteName, input?: unknown): Promise<T> {
      asked.push({ name, input });
      if (name === "team") return snapshot([task({ status: "failed", error: "unverified", budgetUsd: 2 })]) as T;
      if (name === "createTeamTask") return { task: task({ id: "task-again0000001", status: "queued" }) } as T;
      return {} as T;
    },
    async *events(name: RouteName, input?: unknown): AsyncGenerator<string> {
      asked.push({ name, input });
      for (const event of events) yield JSON.stringify(event);
    },
  };
  return { conn: async (): Promise<Connection> => ({ client, how: "paired", pairing: null }), asked };
}

describe('inv "…"', () => {
  const answer = [
    { type: "turn", id: "turn-1", conversation: "cv_one", answer: 1, role: "primary", startedAt: 0, deadline: 1, replay: false },
    { type: "model", ref: "stand-in/primary" },
    { type: "text", text: "Good " },
    { type: "text", text: `morning${ESC}[2J.` },
    { type: "done", ref: "stand-in/primary" },
  ];

  test("its answer, streamed as plain text, in a chat kept in your history", async () => {
    const { conn, asked } = node(answer);
    const io = testIo({});
    expect(await askCommand(conn, ["Good", "morning"], flags(), io)).toBe(EXIT.ok);
    expect(io.stdout()).toBe("Good morning[2J.\n");
    expect(asked[0]).toEqual({ name: "chat", input: { messages: [{ role: "user", content: "Good morning" }], save: true } });
  });

  test("--json: one object when it has finished; --chat goes on in that chat", async () => {
    const { conn, asked } = node(answer);
    const io = testIo({});
    expect(await askCommand(conn, ["Go on"], flags({ json: true, chat: "cv_one" }), io)).toBe(EXIT.ok);
    expect(JSON.parse(io.stdout())).toEqual({ chat: "cv_one", turn: "turn-1", model: "stand-in/primary", text: "Good morning[2J.", stopped: false });
    expect(asked[0]?.input).toEqual({ messages: [{ role: "user", content: "Go on" }], conversation: "cv_one" });
  });

  test("stopped, it exits 13; an answer that failed exits 1, saying why", async () => {
    expect(await askCommand(node([...answer.slice(0, 3), { type: "stopped", reason: "asked" }]).conn, ["x"], flags(), testIo({}))).toBe(EXIT.stopped);
    const failed = await askCommand(node([{ type: "error", error: "no model answered" }]).conn, ["x"], flags(), testIo({})).catch((error: { exit: number; message: string }) => [error.exit, error.message]);
    expect(failed).toEqual([EXIT.error, "your agent couldn't answer: no model answered"]);
    expect(await askCommand(node([]).conn, [], flags(), testIo({})).catch((error: { exit: number }) => error.exit)).toBe(EXIT.usage);
  });
});

describe("inv again", () => {
  test("the task given again as its agent's new one: its goal, gates and budget, from a step when --from names one, your words its goal", async () => {
    const { conn, asked } = node([]);
    const io = testIo({});
    expect(await againCommand(conn, ["a1b2c3d4e5f6", "Fix", "it", "properly"], flags({ from: "3", json: true }), io)).toBe(EXIT.ok);
    expect(asked.find((call) => call.name === "createTeamTask")?.input).toEqual({
      room: "dm-ada",
      assignee: "ada",
      title: "Fix the flaky link sync test",
      goal: "Fix it properly",
      gates: ["bun test packages/link"],
      budgetUsd: 2,
      again: "task-a1b2c3d4e5f6",
      from: { task: "task-a1b2c3d4e5f6", step: 3 },
    });
    expect(JSON.parse(io.stdout())).toMatchObject({ task: "task-again0000001", agent: "ada", why: "task-a1b2c3d4e5f6 given again, from its step 3" });
    expect(await againCommand(conn, ["a1b2c3d4e5f6"], flags({ from: "zero" }), testIo({})).catch((error: { exit: number }) => error.exit)).toBe(EXIT.usage);
  });
});
