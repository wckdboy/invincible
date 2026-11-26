import type { ChatMessage, ExecResult } from "../../packages/core/src/index.ts";
import { type QuestRole, runQuest } from "../../packages/brain/src/quest.ts";
import type { Suite } from "../lib.ts";

/*
 * What a quest sends its engineer: the characters of every turn's conversation, summed over a whole quest, for three
 * kinds of work a stand-in engineer does the same way every time. The engineer's conversation is most of what a quest
 * costs, so a change that sends more (or rewrites the beginning a provider caches) shows here as a number, not a feeling.
 *
 * No model is called: the planner, engineer and reviewer are scripts, and every command answers at once.
 */

interface Work {
  /** The engineer's commands, in order; DONE after the last. */
  commands: string[];
  /** What each command printed, by the command and its place. */
  answer(command: string, i: number): Partial<ExecResult>;
}

/** The engineer's conversation on every turn of one quest. */
async function sent(work: Work): Promise<ChatMessage[][]> {
  const replies = [...work.commands.map((c) => `Next.\n\`\`\`sh\n${c}\n\`\`\``), "DONE\nIt is done."];
  const turns: ChatMessage[][] = [];
  let step = 0;
  await runQuest(
    { goal: "make it so", environment: "a stand-in sandbox", maxSteps: work.commands.length + 4 },
    {
      ask: async (role: QuestRole, messages: ChatMessage[]) => {
        if (role === "engineer") turns.push(messages.map((m) => ({ ...m })));
        if (role === "planner") return { text: "1. Do it.\nDone when: it is done.", model: "stand-in" };
        if (role === "reviewer") return { text: "PASS\nIt is.", model: "stand-in" };
        return { text: replies.shift()!, model: "stand-in" };
      },
      exec: async (command: string) => ({ exitCode: 0, stdout: "", stderr: "", durationMs: 5, truncated: false, ...work.answer(command, step++) }),
    },
  );
  return turns;
}

const size = (turn: readonly ChatMessage[]): number => turn.reduce((sum, m) => sum + m.content.length, 0);

/** Turns whose conversation doesn't begin with the turn before's: each one a beginning a provider can't read from its cache. */
const rewrites = (turns: readonly ChatMessage[][]): number => {
  let n = 0;
  for (let t = 1; t < turns.length; t++) if (JSON.stringify(turns[t]!.slice(0, turns[t - 1]!.length)) !== JSON.stringify(turns[t - 1])) n += 1;
  return n;
};

const page = (c: string, n: number): string => c.repeat(n);

/**
 * Code to understand before writing, as a knight's task has it: the five files the first real outcome's knights had to
 * read (AGENTS.md, ci-watch.ts, ci-back.ts and their tests, at their sizes on 19 November 2026, some 56 characters a
 * line), every line marked with its file and the file's version, so a stand-in can tell what it can see of them now.
 */
const CODE_CHARS = [3_321, 16_892, 10_341, 15_609, 14_476];
const LINES = CODE_CHARS.map((chars) => Math.ceil(chars / 56));
const codeLine = (k: number, version: number, n: number): string => `F${k}.${version}:${n} ${"c".repeat(46)}`;
/** The lines a sed window holds that fits a lean quest's whole output (8,000 characters), as the knights read them. */
const WINDOW = 140;
/** The files it changes, one edit each, in turn: ci-watch.ts, ci-back.ts, then a test. */
const EDITS = [1, 2, 3];

/**
 * A careful stand-in knight: before each of its three edits it must have every line of the code in its conversation at
 * once, as the files are now, and until then reads what it can't see: a file whole first, then a window of what is
 * missing from it. Each edit is an inline python3 script naming the file it changes. Then it runs the tests and is done.
 * How many commands that takes, or that it never finished within eighty (the third real task ran 76), is what a quest's
 * view of its work comes to.
 */
async function understand(keepReads: boolean): Promise<{ turns: ChatMessage[][]; commands: number; done: boolean }> {
  const turns: ChatMessage[][] = [];
  const version = CODE_CHARS.map(() => 0);
  let edits = 0;
  let tested = false;
  const next = (messages: ChatMessage[]): string => {
    if (tested) return "DONE\nChanged and tested.";
    if (edits === EDITS.length) {
      tested = true;
      return "```sh\nbun test\n```";
    }
    const shown = messages.filter((m, i) => i > 0 && m.role === "user").map((m) => m.content).join("\n");
    const missing = LINES.map((n, k) => Array.from({ length: n }, (_, i) => i).filter((i) => !shown.includes(`${codeLine(k, version[k]!, i).split(" ")[0]} `)));
    const k = missing.findIndex((m) => m.length > 0);
    if (k === -1) {
      const file = EDITS[edits++]!;
      return `\`\`\`sh\ncd /work && python3 - <<'PY'\nimport pathlib\np = pathlib.Path("src/f${file}.ts")\np.write_text(p.read_text().replace("old", "new"))\nPY\n\`\`\``;
    }
    const from = missing[k]![0]!;
    return missing[k]!.length < LINES[k]! ? `\`\`\`sh\nsed -n '${from + 1},${from + WINDOW}p' src/f${k}.ts\n\`\`\`` : `\`\`\`sh\ncat src/f${k}.ts\n\`\`\``;
  };
  const lines = (k: number, from: number, to: number): string => Array.from({ length: Math.min(to, LINES[k]!) - from }, (_, i) => codeLine(k, version[k]!, from + i)).join("\n");
  const ran = (stdout: string): ExecResult => ({ exitCode: 0, stdout, stderr: "", durationMs: 5, truncated: false });
  const outcome = await runQuest(
    { goal: "understand the code, then change it", environment: "a stand-in sandbox", maxSteps: 80, ...(keepReads ? { keepReads: true } : {}) },
    {
      ask: async (role: QuestRole, messages: ChatMessage[]) => {
        if (role === "planner") return { text: "1. Read the code.\n2. Change it.\nDone when: the tests pass.", model: "stand-in" };
        if (role === "reviewer") return { text: "PASS\nIt is.", model: "stand-in" };
        turns.push(messages.map((m) => ({ ...m })));
        return { text: next(messages), model: "stand-in" };
      },
      exec: async (command: string) => {
        const file = Number(/src\/f(\d)\.ts/.exec(command)?.[1] ?? -1);
        const window = /^sed -n '(\d+),(\d+)p' /.exec(command);
        if (command.startsWith("cat ")) return ran(`${lines(file, 0, LINES[file]!)}\n`);
        if (window) return ran(`${lines(file, Number(window[1]) - 1, Number(window[2]))}\n`);
        if (command.includes("python3")) version[file]! += 1;
        return ran(command === "bun test" ? `12 pass\n${page("p", 1_500)}\n` : "");
      },
    },
  );
  return { turns, commands: outcome.steps, done: outcome.status === "done" };
}


/** The tests run after each of thirteen edits, failing until the last. */
const testsAfterEdits: Work = {
  commands: Array.from({ length: 26 }, (_, i) => (i % 2 === 0 ? "bun test" : `sed -i 's/a${i}/b${i}/' src/x.ts`)),
  answer: (command, i) => (command === "bun test" ? { exitCode: i >= 24 ? 0 : 1, stdout: `${i} fail\n${page("y", 3000)}\n` } : {}),
};

/** Ten files, each read, edited in place, and the tests run after it. */
const readEditTest: Work = {
  commands: Array.from({ length: 10 }, (_, k) => [`cat src/f${k}.ts`, `sed -i 's/x/y/' src/f${k}.ts`, "bun test"]).flat(),
  answer: (command, i) => (command.startsWith("cat ") ? { stdout: `${page("x", 2400)}\n` } : command === "bun test" ? { exitCode: i >= 29 ? 0 : 1, stdout: `${page("f", 1500)}\n` } : {}),
};

/**
 * Eight test files failing in turn, each fixed, then the whole suite passing; the typecheck failing, piped short, then
 * passing; then the work looked over. None of the failures is run again as it was: each is fixed by a later check.
 */
const fixThenCheck: Work = {
  commands: [
    ...Array.from({ length: 8 }, (_, i) => [`cd /work && bun test src/t${i}.test.ts 2>&1 | tail -60`, `sed -i 's/bug/fix/' src/m${i}.ts`]).flat(),
    "cd /work && bun test",
    "bunx tsc --noEmit 2>&1 | head -40",
    "sed -i 's/any/T/' src/m0.ts",
    "bunx tsc --noEmit",
    ...Array.from({ length: 10 }, (_, i) => `git diff --stat src/m${i % 8}.ts`),
  ],
  answer: (command) =>
    /t\d\.test\.ts|head -40/.test(command) ? { exitCode: 1, stdout: `${page("f", 2500)}\n` } : command.startsWith("git diff") ? { stdout: `${page("d", 1200)}\n` } : command === "cd /work && bun test" ? { stdout: "40 pass\n" } : {},
};

/** Thirty different commands that each print a page: nothing is superseded or made stale, only cut short. */
const longSurvey: Work = {
  commands: Array.from({ length: 30 }, (_, i) => `grep -rn "symbol${i}" src`),
  answer: () => ({ stdout: `${page("g", 2000)}\n` }),
};

export const suite: Suite = {
  name: "context",
  about: "what a quest sends its engineer over a whole quest, for three kinds of work done by a stand-in: characters, and beginnings a provider can't cache",
  headline: ["context.quest.tests-after-edits", "context.quest.read-edit-test", "context.quest.survey", "context.quest.fix-then-check", "context.quest.read-edit-test.last-turn", "context.quest.rewrites", "context.knight.understand.commands", "context.knight.understand"],
  async run(ctx) {
    const kinds: [string, Work, string][] = [
      ["tests-after-edits", testsAfterEdits, "the tests run after each of 13 edits, failing until the last (26 commands)"],
      ["read-edit-test", readEditTest, "ten files, each read, edited in place and tested (30 commands)"],
      ["survey", longSurvey, "thirty different searches that each print a page (30 commands)"],
    ];
    let rewritten = 0;
    for (const [name, work, about] of kinds) {
      const turns = await sent(work);
      ctx.quality(`context.quest.${name}`, turns.reduce((sum, t) => sum + size(t), 0), "chars", "lower", { note: `every engineer turn's conversation, summed: ${about}` });
      if (name === "read-edit-test") ctx.quality("context.quest.read-edit-test.last-turn", size(turns.at(-1)!), "chars", "lower", { note: "the last turn of the same quest: what a long quest's every turn tends to" });
      rewritten += rewrites(turns);
    }
    ctx.quality("context.quest.rewrites", rewritten, "turns", "lower", { note: "turns, over the three quests, whose conversation doesn't begin with the turn before's (a batch cut is one)" });
    // Failures each fixed by a later check (none run again as it was): measured apart, so the three above stay as they were.
    const fixes = await sent(fixThenCheck);
    ctx.quality("context.quest.fix-then-check", fixes.reduce((sum, t) => sum + size(t), 0), "chars", "lower", { note: "every engineer turn's conversation, summed: eight test files failing in turn and fixed, the whole suite passing, a typecheck failing then passing, the work looked over (30 commands)" });
    ctx.quality("context.quest.fix-then-check.rewrites", rewrites(fixes), "turns", "lower", { note: "turns of that quest whose conversation doesn't begin with the turn before's" });
    // As a knight's task runs (keepReads): the code it must understand, read until it can see all of it, then changed.
    const knight = await understand(true);
    ctx.quality("context.knight.understand.commands", knight.commands, "commands", "lower", { note: "commands a careful stand-in knight ran to change three files of the first real outcome's code, each with all five files in view as they were then, and test it (eighty: it never finished)" });
    ctx.quality("context.knight.understand.done", knight.done ? 1 : 0, "tasks", "higher", { note: "whether that stand-in finished within eighty commands: nought when its reads were cut before it could see what it needed" });
    ctx.quality("context.knight.understand", knight.turns.reduce((sum, t) => sum + size(t), 0), "chars", "lower", { note: "every turn's conversation of the same task, summed: what its view of the code cost to send" });
  },
};
