import { describe, expect, test } from "bun:test";
import type { RouteName, TeamTask, UsageLine, UsageView } from "@invincible/core";
import type { NodeClient } from "../../src/inv/client.ts";
import type { Connection } from "../../src/inv/connect.ts";
import { costCommand } from "../../src/inv/cost.ts";
import { EXIT } from "../../src/inv/exit.ts";
import type { Flags } from "../../src/inv/io.ts";
import { snapshot, T0, task, testIo } from "./fixtures.ts";

/*
 * inv cost (docs/CLI.md): what the work cost at your prices. With --task, the task's spend as its record kept it, a line
 * each role and model beneath its row; its JSON's rows carry the lines as kept (`spent`), for a script.
 */

const flags = (over: Partial<Flags> = {}): Flags => ({ json: false, stream: false, wait: false, noAsk: false, gate: [], forTask: false, needsYou: false, working: false, done: false, week: false, forget: false, help: false, ...over });

// Ultra's first hand-off (28 November 2026), its coding tool's two calls counted at their most.
const spent: UsageLine[] = [
  { role: "planner", model: "deepseek/deepseek-v4-pro", calls: 1, unknown: 0, input: 1323, output: 979, cached: 0, reasoning: 612 },
  { role: "tool", model: "deepseek/deepseek-v4-pro", calls: 2, unknown: 0, input: 44_300, output: 57_300, cached: 0, reasoning: 0, atMost: 2 },
  { role: "reviewer", model: "deepseek/deepseek-v4-pro", calls: 1, unknown: 0, input: 1586, output: 1701, cached: 0, reasoning: 1203 },
];
const handed = task({ id: "task-handed000001", title: "Write hello.txt", status: "done", verified: true, budgetUsd: 2, record: { startedAt: T0, endedAt: T0 + 49_000, ended: "done", commands: 1, revisions: 0, spent } });
const running = task({ id: "task-running0001", title: "Fix the flaky link sync test" });
// (The clock a minute after it ended: its day is today.)
const ioNow = () => ({ ...testIo({}), now: () => T0 + 60_000 });

function node(tasks: TeamTask[]) {
  const usage: UsageView = { node: "keep", since: "2026-11-26", rows: [], prices: { "deepseek/deepseek-v4-pro": { input: 1.32, output: 3.96, cached: 0.044 } }, plans: [] };
  const client = {
    label: "a stand-in node",
    async call<T>(name: RouteName): Promise<T> {
      if (name === "team") return snapshot(tasks) as T;
      if (name === "usage") return usage as T;
      if (name === "projects") return { projects: [] } as T;
      if (name === "actions") return { actions: [] } as T;
      throw new Error(`unexpected call: ${name}`);
    },
  } as NodeClient;
  return async (): Promise<Connection> => ({ client, how: "paired", pairing: null });
}

describe("inv cost --task <id>", () => {
  test("beneath its row, a line each role and model as its record kept them, at your prices; then why it's at most", async () => {
    const io = ioNow();
    expect(await costCommand(node([handed, running]), [], flags({ task: "task-handed000001" }), io)).toBe(EXIT.ok);
    const lines = io.stdout().trimEnd().split("\n");
    expect(lines.slice(2)).toEqual([
      expect.stringMatching(/^ {2}at most \$0\.30 of \$2\.00 +\S.* +ada {2}Write hello\.txt {2}task-handed000001$/),
      "    planner · deepseek/deepseek-v4-pro · 1,323 tokens in, 979 out (612 reasoning) · 1 call · $0.0056",
      "    tool · deepseek/deepseek-v4-pro · at most 44.3k tokens in, 57.3k out · 2 calls, 2 counted at their most · at most $0.29",
      "    reviewer · deepseek/deepseek-v4-pro · 1,586 tokens in, 1,701 out (1,203 reasoning) · 1 call · $0.0088",
      "At most: a handed task's call was counted at its most, its provider silent in time: every byte a token, or the most it allowed itself.",
    ]);
  });

  test("--json: each task's row carries its lines as its record kept them (`spent`), null for one with no record yet", async () => {
    const io = ioNow();
    expect(await costCommand(node([handed, running]), [], flags({ json: true, task: "task-handed000001" }), io)).toBe(EXIT.ok);
    const shown = JSON.parse(io.stdout());
    expect(shown.tasks).toEqual([{ id: "task-handed000001", title: "Write hello.txt", agent: "ada", project: "invincible", usd: 0.299837, complete: true, atMost: true, budgetUsd: 2, spent }]);
    const none = ioNow();
    expect(await costCommand(node([handed, running]), [], flags({ json: true, task: "task-running0001" }), none)).toBe(EXIT.ok);
    expect(JSON.parse(none.stdout()).tasks).toEqual([expect.objectContaining({ id: "task-running0001", usd: null, spent: null })]);
  });

  test("without --task, the rows alone, as ever: the lines are for one task", async () => {
    const io = ioNow();
    expect(await costCommand(node([handed]), [], flags(), io)).toBe(EXIT.ok);
    expect(io.stdout()).not.toContain("planner · ");
  });
});
