import { describe, expect, test } from "bun:test";
import type { ChatStreamEvent, RouteName, SandboxView } from "@galahad/core";
import { runNodeQuest } from "../src/quest-cli.ts";

/*
 * A quest whose work is in a directory (a trial of your own work: the task's repository, where its knight had it):
 * each of its commands and gates starts there, as a knight's task's did, with $TMPDIR a directory that can run what
 * is written to it; what prepares its sandbox runs as given, and is told which sandbox it is.
 */

function fakeNode() {
  const commands: string[] = [];
  const chats: any[] = [];
  const turns = new Map<string, number>();
  const node = {
    async call<T>(name: RouteName, input?: any): Promise<T> {
      switch (name) {
        case "createSandbox":
          return { sandbox: { id: "0000000001", node: "n_ultra", image: "galahad/workshop:1", network: input.network, isolation: "vm", cpus: 4, memoryGb: 8, providers: [] } } as T;
        case "fleet":
          return { devices: [{ id: "n_ultra", name: "ultra" }] } as T;
        case "execSandbox":
          commands.push(input.cmd[2]);
          return { exitCode: 0, stdout: "", stderr: "", durationMs: 1, truncated: false } as T;
        case "saveArtifact":
          return { artifact: null } as T;
        case "effort":
          return { quest: input.quest, attempts: input.effort, asked: input.effort, host: "ultra", reasons: [], budget: { perDay: 12, usedToday: 0 } } as T;
        case "destroySandbox":
        case "questProgress":
          return {} as T;
        case "rules":
          return { rules: [] } as T;
        default:
          throw new Error(`unexpected call ${name}`);
      }
    },
    async *stream(_name: RouteName, input: any): AsyncGenerator<ChatStreamEvent> {
      chats.push(input);
      const first: string = input.messages[0].content;
      yield { type: "model", ref: `fake/${input.role}` };
      // (Each attempt's engineer looks once, then says it's done.)
      const turnOf = input.attempt ? `${input.attempt.index}` : "solo";
      const text = first.startsWith("You are choosing between")
        ? "PICK A\nA's evidence is complete."
        : input.role === "planner"
          ? "1. Fix it.\nDone when: the tests pass."
          : input.role === "engineer"
            ? ((turns.set(turnOf, (turns.get(turnOf) ?? 0) + 1), turns.get(turnOf) === 1) ? "Looking.\n```sh\nls src\n```" : "DONE\nFixed.")
            : "PASS\nThe gates passed.";
      yield { type: "text", text };
    },
  };
  return { node, commands, chats };
}

describe("a quest whose work is in a directory", () => {
  test("its commands and gates start there, with a temporary directory of the quest's own; what prepares its sandbox runs as given", async () => {
    const fake = fakeNode();
    const prepared: { commands: string[]; sandbox?: SandboxView } = { commands: [] };
    const { outcome } = await runNodeQuest(
      fake.node,
      { goal: "Fix the parser.", network: "gateway", workdir: "/work/tasks/task-abc_def-1234", gates: ["bun test"], remember: false, trial: true },
      {
        prepare: async (exec, info) => {
          prepared.sandbox = info.sandbox;
          await exec("put the repository there", 60);
          prepared.commands.push(fake.commands.at(-1)!);
        },
      },
    );
    expect(outcome.status).toBe("done");
    // What prepares the sandbox knows which it is, and runs as given: the directory may not be there yet.
    expect(prepared.sandbox?.id).toBe("0000000001");
    expect(prepared.commands).toEqual(["put the repository there"]);
    const there = (command: string) => `mkdir -p /work/.tmp && export TMPDIR=/work/.tmp && cd '/work/tasks/task-abc_def-1234' && ${command}`;
    expect(fake.commands).toContain(there("ls src"));
    expect(fake.commands).toContain(there("bun test"));
    // The gates are the task's as written: told to the engineer without the directory around them.
    const briefing = fake.chats.find((c) => c.role === "engineer").messages[0].content as string;
    expect(briefing).toContain("1. $ bun test");
    expect(briefing).not.toContain("cd '/work/tasks/task-abc_def-1234'");
  });

  test("with effort, the attempts are compared on evidence taken where the work is", async () => {
    const fake = fakeNode();
    const { effort } = await runNodeQuest(fake.node, { goal: "Fix the parser.", network: "gateway", workdir: "/work/tasks/task-abc_def-1234", evidence: ["git status --short"], effort: 2, remember: false, trial: true });
    expect(effort?.attempts).toHaveLength(2);
    expect(fake.chats.some((c) => String(c.messages[0].content).startsWith("You are choosing between"))).toBe(true);
    const evidence = fake.commands.filter((c) => c.endsWith("git status --short"));
    expect(evidence.length).toBeGreaterThan(2);
    expect(evidence.every((c) => c.startsWith("mkdir -p /work/.tmp && export TMPDIR=/work/.tmp && cd '/work/tasks/task-abc_def-1234' && "))).toBe(true);
  });

  test("a quest that goes without memories asks every call to, its pick among attempts included", async () => {
    const fake = fakeNode();
    await runNodeQuest(fake.node, { goal: "Fix the parser.", network: "gateway", memories: false, effort: 2, remember: false, trial: true });
    expect(new Set(fake.chats.map((c) => c.role))).toEqual(new Set(["planner", "engineer", "reviewer"]));
    expect(fake.chats.some((c) => String(c.messages[0].content).startsWith("You are choosing between"))).toBe(true);
    expect(fake.chats.every((c) => c.memories === false)).toBe(true);
    // (Otherwise the node recalls as it always has: nothing is said.)
    const usual = fakeNode();
    await runNodeQuest(usual.node, { goal: "Fix the parser.", network: "gateway", remember: false });
    expect(usual.chats.some((c) => "memories" in c)).toBe(false);
  });

  test("without one, a quest runs its commands as it always has", async () => {
    const fake = fakeNode();
    await runNodeQuest(fake.node, { goal: "Fix the parser.", network: "gateway", gates: ["bun test"], remember: false });
    expect(fake.commands).toContain("ls src");
    expect(fake.commands).toContain("bun test");
  });
});

describe("a quest whose coding tool works in an image of its own", () => {
  test("its sandbox is asked for in that image (a trial's Claude Code); without one, in the workshop's", async () => {
    const asked: any[] = [];
    const node = {
      async call<T>(name: RouteName, input?: any): Promise<T> {
        if (name === "roster") return { roster: { engineer: { models: ["anthropic/claude-test-model"] } } } as T;
        if (name === "providers") return { providers: [{ id: "anthropic", kind: "anthropic", hasKey: true }] } as T;
        if (name === "rules") return { rules: [] } as T;
        if (name === "createSandbox") {
          asked.push(input);
          throw new Error("stop here: only the request is looked at");
        }
        throw new Error(`unexpected call ${name}`);
      },
      async *stream(): AsyncGenerator<ChatStreamEvent> {},
    };
    const quest = (image?: string) =>
      runNodeQuest(node, { goal: "Fix the parser.", network: "gateway", remember: false, trial: true, plan: "", agent: { name: "claude", minutes: 5, ...(image ? { image } : {}) } }).catch((error: Error) => error.message);
    expect(await quest("galahad/claude-code:2.1.319")).toContain("stop here");
    expect(await quest()).toContain("stop here");
    expect(asked.map((input) => input.image ?? null)).toEqual(["galahad/claude-code:2.1.319", null]);
  });
});
