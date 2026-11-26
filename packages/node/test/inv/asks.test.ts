import { describe, expect, test } from "bun:test";
import type { RouteName } from "@invincible/core";
import { allowCommand, denyCommand, forTaskOrder } from "../../src/inv/asks.ts";
import type { NodeClient } from "../../src/inv/client.ts";
import type { Connection } from "../../src/inv/connect.ts";
import { CliError, EXIT } from "../../src/inv/exit.ts";
import type { Flags } from "../../src/inv/io.ts";
import { action, snapshot, task, testIo } from "./fixtures.ts";

/*
 * Answering what waits (docs/CLI.md): an approval allowed once, or with --for-task as a standing order narrowed to the
 * asking agent and that exact call for a day; a proposal allowed to start, or declined. Each by the node's own route,
 * which checks fleet:admin as it does for the apps.
 */

const flags = (over: Partial<Flags> = {}): Flags => ({ json: false, stream: false, wait: false, noAsk: false, gate: [], forTask: false, needsYou: false, working: false, done: false, week: false, forget: false, help: false, ...over });

function node(state = { tasks: [task(), task({ id: "task-propose00001", status: "proposed", proposedBy: "ada" })], actions: [action()] }) {
  const asked: { name: RouteName; input: unknown }[] = [];
  const client: NodeClient = {
    label: "a stand-in node",
    async call<T>(name: RouteName, input?: unknown): Promise<T> {
      asked.push({ name, input });
      if (name === "team") return snapshot(state.tasks) as T;
      if (name === "actions") return { actions: state.actions } as T;
      if (name === "whoami") return { primaryName: null } as T;
      if (name === "decideAction") return { action: { ...state.actions[0], state: (input as { approve: boolean }).approve ? "approved" : "denied" } } as T;
      if (name === "setOrder") return { order: { id: "o_order0000000000000000000" }, action: { ...state.actions[0], state: "approved" } } as T;
      return {} as T;
    },
    async *events(): AsyncGenerator<string> {},
  };
  const conn = async (): Promise<Connection> => ({ client, how: "paired", pairing: null });
  return { conn, asked, answers: () => asked.filter((call) => !["team", "actions", "whoami"].includes(call.name)) };
}

describe("inv allow and inv deny", () => {
  test("an approval: allowed once, by its id or a start of it; denied with your reason", async () => {
    const one = node();
    expect(await allowCommand(one.conn, [action().id.slice(0, 8)], flags({ json: true }), testIo({}))).toBe(EXIT.ok);
    expect(one.answers()).toEqual([{ name: "decideAction", input: { id: action().id, approve: true } }]);
    const two = node();
    const io = testIo({});
    expect(await denyCommand(two.conn, [action().id, "not", "today"], flags({ json: true }), io)).toBe(EXIT.ok);
    expect(two.answers()).toEqual([{ name: "decideAction", input: { id: action().id, approve: false, note: "not today" } }]);
    expect(JSON.parse(io.stdout())).toEqual({ id: action().id, state: "denied" });
  });

  test("--for-task: a standing order for the asking agent alone and that exact call, for a day, which approves this one too", async () => {
    const one = node();
    expect(await allowCommand(one.conn, [action().id], flags({ forTask: true }), testIo({}))).toBe(EXIT.ok);
    expect(one.answers()).toEqual([
      {
        name: "setOrder",
        input: { connector: "github", tool: "create_pull_request", args: { owner: "example-owner", repo: "invincible", title: "Fix the race in retry()" }, callers: ["team.0123456789.ada"], days: 1, label: "inv --for-task: ada · task-a1b2c3d4e5f6", approve: action().id },
      },
    ]);
  });

  test("--for-task never widens: not for an ask that isn't an agent's, nor a call an order can't pin exactly", () => {
    const refused = (over: Parameters<typeof action>[0]) => {
      try {
        forTaskOrder(action(over), null);
        return null;
      } catch (error) {
        return (error as CliError).exit;
      }
    };
    expect(refused({ by: "arm:primary" })).toBe(EXIT.usage);
    expect(refused({ args: { title: "every * thing" } })).toBe(EXIT.usage);
    expect(refused({ args: { labels: ["a", "b"] } })).toBe(EXIT.usage);
    expect(forTaskOrder(action({ args: { number: 7, draft: false } }), null).args).toEqual({ number: "7", draft: "false" });
  });

  test("a proposal: allowed to start, or declined; an approval that is no longer waiting has nothing to answer", async () => {
    const one = node();
    expect(await allowCommand(one.conn, ["task-propose00001"], flags(), testIo({}))).toBe(EXIT.ok);
    expect(await denyCommand(one.conn, ["task-propose00001"], flags(), testIo({}))).toBe(EXIT.ok);
    expect(one.answers()).toEqual([
      { name: "controlTeam", input: { task: "task-propose00001", action: "approve" } },
      { name: "controlTeam", input: { task: "task-propose00001", action: "stop" } },
    ]);
    const done = node({ tasks: [task()], actions: [action({ state: "approved" })] });
    expect(await allowCommand(done.conn, [action().id], flags(), testIo({})).catch((error: CliError) => error.exit)).toBe(EXIT.error);
    expect(await allowCommand(done.conn, ["nothing-like-it"], flags(), testIo({})).catch((error: CliError) => error.exit)).toBe(EXIT.error);
    expect(done.answers()).toEqual([]);
  });
});
