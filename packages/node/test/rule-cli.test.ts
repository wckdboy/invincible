import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { RouteName, RuleView } from "@galahad/core";
import { describeRule, ruleCommand } from "../src/rule-cli.ts";

/* `galahad rule` at a terminal: what it prints, and what it sends (exactly your rule, never anything you didn't say). */

const at = Date.UTC(2026, 10, 16, 9, 30);
const view = (name: string, rule: RuleView["rule"], setVia: string | null = null): RuleView => ({ name, rule, setAt: at, setVia });

let printed: string[] = [];
const log = console.log;
beforeEach(() => {
  printed = [];
  console.log = (...args: unknown[]) => void printed.push(args.join(" "));
});
afterEach(() => {
  console.log = log;
});

function api(answers: Partial<Record<RouteName, unknown>>) {
  const calls: { name: RouteName; input: unknown }[] = [];
  return {
    calls,
    call: async <T,>(name: RouteName, input?: unknown): Promise<T> => {
      calls.push({ name, input });
      if (!(name in answers)) throw new Error(`unexpected call ${name}`);
      return answers[name] as T;
    },
  };
}

describe("what a rule says", () => {
  test("what it does, and when: its globs, its piece of text, or both", () => {
    expect(describeRule({ on: "command", does: "halt", words: ["*.lock", "package-lock.json"] })).toBe("halts the work when a word matches *.lock or package-lock.json");
    expect(describeRule({ on: "command", does: "refuse", words: [], contains: "git push" })).toBe('refuses the command when it holds "git push"');
    expect(describeRule({ on: "command", does: "refuse", words: ["git"], contains: "--force" })).toBe('refuses the command when a word matches git and it holds "--force"');
    expect(describeRule({ on: "command", does: "refuse", words: ["a", "b", "c"] })).toBe("refuses the command when a word matches a, b or c");
  });

  test("a check: what it runs, and after what", () => {
    expect(describeRule({ on: "after", does: "check", run: "bunx tsc --noEmit", words: ["*.ts", "*.tsx"] })).toBe("runs bunx tsc --noEmit after a command that succeeds, when a word matches *.ts or *.tsx");
    expect(describeRule({ on: "after", does: "check", run: "bun test", words: [], contains: "git commit" })).toBe('runs bun test after a command that succeeds, when it holds "git commit"');
  });

  test("a rule that tells you: of a command that has run, however it ended", () => {
    expect(describeRule({ on: "after", does: "tell", words: ["git"], contains: "push" })).toBe('tells you when a command has run, when a word matches git and it holds "push"');
  });
});

describe("galahad rule ls", () => {
  test("each rule, what it does and when; one this node doesn't understand is said, never applied; and what they cover", async () => {
    const node = api({
      rules: {
        rules: [
          view("no-locks", { on: "command", does: "halt", words: ["*.lock"] }),
          view("no-push", { on: "command", does: "refuse", words: [], contains: "git push" }, "c_phone"),
          view("types", { on: "after", does: "check", run: "bunx tsc --noEmit", words: ["*.ts"] }),
          view("later", null),
        ],
      },
    });
    await ruleCommand(node, "ls", [], {});
    const out = printed.join("\n");
    expect(out).toContain("no-locks  halts the work when a word matches *.lock");
    expect(out).toContain('no-push   refuses the command when it holds "git push"');
    expect(out).toContain("types     runs bunx tsc --noEmit after a command that succeeds, when a word matches *.ts");
    expect(out).toContain("later     a newer node's rule: this node doesn't understand it, and doesn't apply it");
    expect(out).toContain("Tripwires are checked before every command of Galahad's quests");
    expect(out).toContain("checks run after those commands, never after a gate");
    expect(out).toContain("A coding tool (OpenCode, Claude Code, Codex, Hermes) runs its own commands in its VM, where they aren't seen");
    // (No word is the same as ls.)
    printed = [];
    await ruleCommand(node, undefined, [], {});
    expect(printed.join("\n")).toBe(out);
  });

  test("with none, says so and how to add one", async () => {
    await ruleCommand(api({ rules: { rules: [] } }), "ls", [], {});
    expect(printed.join("\n")).toContain("No rules yet.");
    expect(printed.join("\n")).toContain('galahad rule add <name> --halt|--refuse|--check "command"|--tell <glob>… [--contains text]');
  });
});

describe("galahad rule add", () => {
  test("--halt or --refuse with its globs, and --contains: exactly that is sent, and what it now does is said", async () => {
    const node = api({ setRule: { rule: view("no-locks", { on: "command", does: "halt", words: ["*.lock", "package-lock.json"] }) } });
    await ruleCommand(node, "add", ["no-locks", "*.lock", "package-lock.json"], { halt: true });
    expect(node.calls).toEqual([{ name: "setRule", input: { name: "no-locks", does: "halt", words: ["*.lock", "package-lock.json"] } }]);
    expect(printed[0]).toBe("Set no-locks: it halts the work when a word matches *.lock or package-lock.json.");

    const push = api({ setRule: { rule: view("no-push", { on: "command", does: "refuse", words: [], contains: "git push" }) } });
    await ruleCommand(push, "add", ["no-push"], { refuse: true, contains: "git push" });
    expect(push.calls).toEqual([{ name: "setRule", input: { name: "no-push", does: "refuse", words: [], contains: "git push" } }]);
  });

  test('--check "command" with its globs: the command to run after one that matches is sent as written', async () => {
    const node = api({ setRule: { rule: view("types", { on: "after", does: "check", run: "bunx tsc --noEmit", words: ["*.ts"] }) } });
    await ruleCommand(node, "add", ["types", "*.ts"], { check: "bunx tsc --noEmit" });
    expect(node.calls).toEqual([{ name: "setRule", input: { name: "types", does: "check", words: ["*.ts"], run: "bunx tsc --noEmit" } }]);
    expect(printed[0]).toBe("Set types: it runs bunx tsc --noEmit after a command that succeeds, when a word matches *.ts.");
  });

  test("--tell with its globs and text: a rule that tells you, with no command of its own", async () => {
    const node = api({ setRule: { rule: view("pushes", { on: "after", does: "tell", words: ["git"], contains: "push" }) } });
    await ruleCommand(node, "add", ["pushes", "git"], { tell: true, contains: "push" });
    expect(node.calls).toEqual([{ name: "setRule", input: { name: "pushes", does: "tell", words: ["git"], contains: "push" } }]);
    expect(printed[0]).toBe('Set pushes: it tells you when a command has run, when a word matches git and it holds "push".');
    await expect(ruleCommand(api({}), "add", ["both", "git"], { tell: true, halt: true })).rejects.toThrow("--halt or --tell, not both");
  });

  test("what isn't a rule is refused before anything is sent: no name, no --halt or --refuse, both, nothing to match", async () => {
    const node = api({});
    await expect(ruleCommand(node, "add", [], { halt: true })).rejects.toThrow('usage: galahad rule add <name> --halt|--refuse|--check "command"|--tell <glob>… [--contains text]');
    await expect(ruleCommand(node, "add", ["no-locks", "*.lock"], {})).rejects.toThrow('say what it does: --halt (the work stops), --refuse (that command isn\'t run), --check "command" (yours runs after it) or --tell (you are told it ran)');
    await expect(ruleCommand(node, "add", ["no-locks", "*.lock"], { halt: true, refuse: true })).rejects.toThrow("--halt or --refuse, not both");
    await expect(ruleCommand(node, "add", ["types", "*.ts"], { refuse: true, check: "tsc" })).rejects.toThrow("--refuse or --check, not both");
    await expect(ruleCommand(node, "add", ["types", "*.ts"], { check: true })).rejects.toThrow('--check takes the command to run after: --check "bunx tsc --noEmit"');
    await expect(ruleCommand(node, "add", ["types", "*.ts"], { check: "  " })).rejects.toThrow("--check takes the command to run after");
    await expect(ruleCommand(node, "add", ["no-locks"], { refuse: true })).rejects.toThrow("give it a glob to match a command's words, or --contains text");
    expect(node.calls).toEqual([]);
  });
});

describe("galahad rule rm", () => {
  test("removes it by name", async () => {
    const node = api({ removeRule: { removed: "no-locks" } });
    await ruleCommand(node, "rm", ["no-locks"], {});
    expect(node.calls).toEqual([{ name: "removeRule", input: { name: "no-locks" } }]);
    expect(printed[0]).toBe("Removed no-locks: no command is held to it any more.");
    await expect(ruleCommand(api({}), "rm", [], {})).rejects.toThrow("usage: galahad rule rm <name>");
  });

  test("anything else says how it is used", async () => {
    await expect(ruleCommand(api({}), "frobnicate", [], {})).rejects.toThrow('usage: galahad rule ls | rule add <name> --halt|--refuse|--check "command"|--tell <glob>… [--contains text] | rule rm <name>');
  });
});
