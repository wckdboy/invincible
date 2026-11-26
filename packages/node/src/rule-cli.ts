import type { Rule, RuleView } from "@galahad/core";
import type { Api } from "./loop-cli.ts";

/*
 * `galahad rule`: your tripwires on the commands his work runs, your checks after them, and the rules that tell you one
 * has run (core's rules.ts). Thin: the node checks every rule and keeps them in the mind; this shapes what you type and
 * prints what it holds.
 */

type Flags = Record<string, string | boolean | (string | boolean)[] | undefined>;

const tty = process.stdout.isTTY;
const dim = (s: string) => (tty ? `\x1b[2m${s}\x1b[0m` : s);
const bold = (s: string) => (tty ? `\x1b[1m${s}\x1b[0m` : s);

const ADD = 'galahad rule add <name> --halt|--refuse|--check "command"|--tell <glob>… [--contains text]';
const USAGE = `usage: galahad rule ls | rule add <name> --halt|--refuse|--check "command"|--tell <glob>… [--contains text] | rule rm <name>`;

/** What they cover, and what they can't see. */
const COVERS = [
  "Tripwires are checked before every command of Galahad's quests (galahad do, his loops', a trial's) and of a knight's task on his own runner, and before every gate; checks run after those commands, never after a gate; a rule that tells you does so once for each task, in your Inbox and as a notification (galahad notify kinds told off: the Inbox alone).",
  "A coding tool (OpenCode, Claude Code, Codex, Hermes) runs its own commands in its VM, where they aren't seen: only its gates are checked.",
];

const either = (items: readonly string[]): string => (items.length < 2 ? (items[0] ?? "") : `${items.slice(0, -1).join(", ")} or ${items.at(-1)}`);

/** What a rule does, and when, in a line. */
export function describeRule(rule: Rule): string {
  const when = [rule.words.length ? `a word matches ${either(rule.words)}` : "", rule.contains !== undefined ? `it holds "${rule.contains}"` : ""].filter(Boolean).join(" and ");
  if (rule.does === "tell") return `tells you when a command has run, when ${when}`;
  if (rule.on === "after") return `runs ${rule.run} after a command that succeeds, when ${when}`;
  return `${rule.does === "halt" ? "halts the work" : "refuses the command"} when ${when}`;
}

export async function ruleCommand(api: Api, sub: string | undefined, rest: string[], flags: Flags): Promise<void> {
  switch (sub) {
    case undefined:
    case "ls":
    case "list": {
      const { rules } = await api.call<{ rules: RuleView[] }>("rules");
      if (!rules.length) {
        console.log(`No rules yet. A tripwire stops a command before it runs; a check runs yours after one; --tell tells you one ran: ${ADD}`);
        return;
      }
      const width = Math.max(...rules.map((r) => r.name.length));
      for (const r of rules) console.log(`  ${bold(r.name.padEnd(width))}  ${r.rule ? describeRule(r.rule) : "a newer node's rule: this node doesn't understand it, and doesn't apply it"}`);
      console.log(dim(`\n  ${COVERS.join("\n  ")}`));
      return;
    }
    case "add":
    case "set": {
      const [name, ...words] = rest;
      if (!name) throw new Error(`usage: ${ADD}`);
      const said = [flags.halt && "--halt", flags.refuse && "--refuse", flags.check !== undefined && "--check", flags.tell && "--tell"].filter(Boolean);
      if (said.length > 1) throw new Error(said.length === 2 ? `${said[0]} or ${said[1]}, not both` : "--halt, --refuse, --check or --tell: one of them");
      if (!said.length) throw new Error('say what it does: --halt (the work stops), --refuse (that command isn\'t run), --check "command" (yours runs after it) or --tell (you are told it ran)');
      if (flags.check !== undefined && (typeof flags.check !== "string" || !flags.check.trim())) throw new Error('--check takes the command to run after: --check "bunx tsc --noEmit"');
      const contains = typeof flags.contains === "string" ? flags.contains : undefined;
      if (!words.length && contains === undefined) throw new Error("give it a glob to match a command's words, or --contains text");
      const does = flags.halt ? "halt" : flags.refuse ? "refuse" : flags.tell ? "tell" : "check";
      const { rule } = await api.call<{ rule: RuleView }>("setRule", { name, does, words, ...(contains !== undefined ? { contains } : {}), ...(does === "check" ? { run: flags.check } : {}) });
      console.log(`Set ${rule.name}: it ${rule.rule ? describeRule(rule.rule) : "is kept"}.`);
      console.log(dim(COVERS.join("\n")));
      return;
    }
    case "rm":
    case "remove": {
      if (!rest[0]) throw new Error("usage: galahad rule rm <name>");
      const { removed } = await api.call<{ removed: string }>("removeRule", { name: rest[0] });
      console.log(`Removed ${removed}: no command is held to it any more.`);
      return;
    }
    default:
      throw new Error(USAGE);
  }
}
