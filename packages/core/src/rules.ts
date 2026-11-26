import { z } from "zod";

/*
 * Your rules (PLAN #23): tripwires on the commands his work runs, and checks after them. A rule is data you write,
 * never a model's judgment and never code an agent wrote: globs matched against a command's words, a piece of text it
 * must hold, and what happens to a command that matches. Only you write them: the mind refuses one that isn't your
 * word, from a full node (rule.set, rule.removed; the last writer wins, by name), so every replica holds the same rules.
 *
 * Before a command (`on: "command"`), the quest loop checks them for each command it runs, each of a parallel batch,
 * and each gate (brain's tripwires.ts). `halt`: the quest or task stops, saying which rule. `refuse`: that command
 * isn't run, the engineer is told which rule refused it and why, and the work goes on. After a command (`on: "after"`):
 * `check`, once one that matches has run and exited 0, runs your command where his work runs, and he is told at once if
 * it fails (a gate at the moment of the change, not at the end); `tell`, once one that matches has run however it
 * ended, tells you (a notice in your Inbox, and a notification of its own kind: once for each rule and task).
 */

/** A rule's name: what it is known, replaced and removed by. */
export const RuleName = z.string().regex(/^[a-z0-9][a-z0-9._-]{0,39}$/, "lowercase letters, digits, . _ - (max 40)");

/** What a tripwire does to a command, before it runs. */
export const RULE_DOES = ["halt", "refuse"] as const;
export type RuleDoes = (typeof RULE_DOES)[number];

/** The most rules you may keep, and the most globs one rule may hold. */
export const MAX_RULES = 32;
export const MAX_RULE_GLOBS = 8;

const oneLine = (text: string): boolean => !/[\u0000-\u001f\u007f]/.test(text);

/**
 * A glob matched against a command's words: `*` is any run of characters but `/`, `**` any run, `?` one character but
 * `/`, and every other character itself (case counts). One that starts with `/` is matched against a whole word; any
 * other against a whole word or what follows any `/` in it: `*.lock` is `bun.lock` and `web/bun.lock`, `rm` is
 * `/bin/rm`, and `migrations/**` is anything in a migrations folder, and the folder itself. Never a regular expression.
 */
export const RuleGlob = z.string().min(1).max(100).refine(oneLine, "a glob is one line of text");

/** A piece of a command's text (here-documents included) that a command must hold to trip the rule. */
export const RuleText = z.string().min(1).max(200).refine(oneLine, "one line of text");

/**
 * The command a check runs after one its rule matches: yours, one line (join several with && or ;), run where his work
 * runs, as his own commands are.
 */
export const RuleCheck = z.string().trim().min(1).max(1000).refine(oneLine, "a check is one line: join commands with && or ;");

const matching = {
  /** Globs: a word of the command matching one trips the rule (with `contains`: as well as holding that). */
  words: z.array(RuleGlob).max(MAX_RULE_GLOBS),
  contains: RuleText.optional(),
};

/** Before a command runs: a tripwire. */
const before = { on: z.literal("command"), does: z.enum(RULE_DOES), ...matching };
/** After a command that matches has run and exited 0: your check. */
const after = { on: z.literal("after"), does: z.literal("check"), run: RuleCheck, ...matching };
/** After a command that matches has run, however it ended: you are told. */
const told = { on: z.literal("after"), does: z.literal("tell"), ...matching };

const matchesSomething = (rule: { words: string[]; contains?: string }): boolean => rule.words.length > 0 || rule.contains !== undefined;
const SOMETHING = "a rule needs a glob, or a piece of text it must hold (--contains)";

/**
 * A rule as this node reads it from the log, where it is open. A field this node doesn't know is set aside and the rest
 * stands, so an older node applies a newer rule at least as strictly as written; a point or an effect it doesn't have
 * (another `on`, another `does`) is no rule here (readRule: null), and is shown as such.
 */
export const RuleTerms = z.union([z.object(before), z.object(after), z.object(told)]).refine(matchesSomething, SOMETHING);
export type Rule = z.infer<typeof RuleTerms>;
/** A tripwire: a rule before a command. */
export type Tripwire = Extract<Rule, { on: "command" }>;
/** A rule after a command: a check, or one that tells you. */
export type RuleAfter = Extract<Rule, { on: "after" }>;

/** A rule with its name, as the quest loop checks it. */
export type NamedRule = Rule & { name: string };
/** A check with its name, as the quest loop runs it. */
export type NamedCheck = Extract<Rule, { does: "check" }> & { name: string };
/** A rule that tells you, with its name. */
export type NamedTell = Extract<Rule, { does: "tell" }> & { name: string };

/** What the log holds for a rule, read: the rule, or null when this node doesn't understand it. */
export function readRule(value: unknown): Rule | null {
  const read = RuleTerms.safeParse(value);
  return read.success ? read.data : null;
}

/**
 * A rule, as you set it (setRule): strict, so a field nobody knows never slips in. What it does says when it applies:
 * `halt` and `refuse` before a command, `check` (with the command it runs) and `tell` after one.
 */
export const RuleInput = z
  .strictObject({ name: RuleName, does: z.enum([...RULE_DOES, "check", "tell"]), words: matching.words, contains: matching.contains, run: RuleCheck.optional() })
  .refine(matchesSomething, SOMETHING)
  .refine((input) => (input.does === "check") === (input.run !== undefined), { message: "a check runs a command of yours after one it matches (--check \"command\"); a tripwire runs none", path: ["run"] });
export type RuleInput = z.infer<typeof RuleInput>;

/** The rule a RuleInput says, as the log holds it. */
export function ruleOf(input: RuleInput): Rule {
  const contains = input.contains !== undefined ? { contains: input.contains } : {};
  if (input.does === "check") return { on: "after", does: "check", run: input.run!, words: input.words, ...contains };
  if (input.does === "tell") return { on: "after", does: "tell", words: input.words, ...contains };
  return { on: "command", does: input.does, words: input.words, ...contains };
}

/** A command a rule of yours that tells matched, said to the node (ruleTold), which checks the rule matches it, then tells you. */
export const RuleToldInput = z.strictObject({
  quest: z.string().regex(/^[A-Za-z0-9._:-]{1,64}$/),
  rule: RuleName,
  command: z.string().min(1).max(100_000),
  exitCode: z.number().int(),
});
export type RuleToldInput = z.infer<typeof RuleToldInput>;

/** A rule stopped a command of a quest's, said to the node for the ledger (ruleTripped); the node checks the rule stops it. */
export const RuleTrippedInput = z.strictObject({
  quest: z.string().regex(/^[A-Za-z0-9._:-]{1,64}$/),
  rule: RuleName,
  command: z.string().min(1).max(100_000),
  /** It was one of the quest's gates. */
  gate: z.boolean().optional(),
});
export type RuleTrippedInput = z.infer<typeof RuleTrippedInput>;

/** A rule as every surface shows it. */
export interface RuleView {
  name: string;
  /** As this node reads it; null: a newer node's rule this one doesn't understand (kept and shown, not applied here). */
  rule: Rule | null;
  setAt: number;
  /** The device you set it from (null: a terminal on a node). */
  setVia: string | null;
}
