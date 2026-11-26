import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { checkScript, type PosedTask, type Solution } from "../src/agentic/index.ts";

/*
 * Running a posed task's hidden checks here, on this machine, with bun: the repository
 * as given (or with a solution laid over it) in a temporary directory, the check script
 * beside it. What the suite's own verification rests on: a reference solution passes
 * every check, a plausible wrong one doesn't, and the repository as given passes none.
 */

export interface Laid {
  dir: string;
  repo: string;
  script: string;
  result: string;
  quest: string;
  remove(): void;
}

/** The repository as given, with `solution` over it (null: as given, nothing said, the quest not done). */
export function lay(posed: PosedTask, solution: Solution | null): Laid {
  const dir = mkdtempSync(join(tmpdir(), "galahad-agentic-"));
  const repo = join(dir, "repo");
  const files: Record<string, string | null> = { ...posed.files, ...(solution?.files ?? {}) };
  for (const [path, text] of Object.entries(files)) {
    if (text === null) continue;
    mkdirSync(dirname(join(repo, path)), { recursive: true });
    writeFileSync(join(repo, path), text);
  }
  const script = join(dir, "check.mjs");
  writeFileSync(script, posed.script);
  const result = join(dir, "result.json");
  if (solution?.result) writeFileSync(result, JSON.stringify(solution.result));
  const quest = join(dir, "quest.json");
  writeFileSync(quest, JSON.stringify({ status: solution ? (solution.quest ?? "done") : "stopped" }));
  return { dir, repo, script, result, quest, remove: () => rmSync(dir, { recursive: true, force: true }) };
}

const TOKEN = "tok-4f1c9a";

/** Every check in one process: key → null (passed) or why it failed. */
export async function checkAll(laid: Laid): Promise<Record<string, string | null>> {
  const run = Bun.spawn([process.execPath, laid.script, laid.repo, laid.result, laid.quest, "all", TOKEN], { stdout: "pipe", stderr: "pipe", cwd: laid.dir, env: { ...process.env, NO_COLOR: "1" } });
  const [out, err, code] = await Promise.all([new Response(run.stdout).text(), new Response(run.stderr).text(), run.exited]);
  const line = out.split("\n").find((l) => l.startsWith(`RESULT ${TOKEN} `));
  if (!line) throw new Error(`the check script said nothing (exit ${code}): ${err.slice(0, 600) || out.slice(0, 600)}`);
  return JSON.parse(line.slice(`RESULT ${TOKEN} `.length)) as Record<string, string | null>;
}

/** One check in a process of its own, as the grader runs it: passed only on exit 0 with the token's line. */
export async function checkOne(laid: Laid, key: string): Promise<boolean> {
  const run = Bun.spawn([process.execPath, laid.script, laid.repo, laid.result, laid.quest, key, TOKEN], { stdout: "pipe", stderr: "pipe", cwd: laid.dir, env: { ...process.env, NO_COLOR: "1" } });
  const [out, code] = await Promise.all([new Response(run.stdout).text(), run.exited]);
  return code === 0 && out.split("\n").includes(`PASS ${key} ${TOKEN}`);
}

/** The share of checks a way of leaving the work passes, and which failed and why. */
export async function scoreOf(posed: PosedTask, solution: Solution | null): Promise<{ score: number; failed: Record<string, string> }> {
  const laid = lay(posed, solution);
  try {
    const all = await checkAll(laid);
    const failed = Object.fromEntries(Object.entries(all).filter((entry): entry is [string, string] => entry[1] !== null));
    return { score: (posed.checks.length - Object.keys(failed).length) / posed.checks.length, failed };
  } finally {
    laid.remove();
  }
}

/** What a task says must be true of its repository as given (Built.asGiven): null when it holds, or there's nothing to hold. */
export async function asGiven(posed: PosedTask): Promise<string | null> {
  if (!posed.asGiven) return null;
  const laid = lay({ ...posed, script: checkScript({ prelude: posed.prelude, checks: [{ key: "as_given", body: posed.asGiven }], files: posed.files }) }, null);
  try {
    return (await checkAll(laid)).as_given ?? null;
  } finally {
    laid.remove();
  }
}

/** `bun test` in the repository: whether its own (visible) tests pass. */
export async function visibleTests(posed: PosedTask, solution: Solution | null): Promise<{ passed: boolean; output: string }> {
  const laid = lay(posed, solution);
  try {
    const run = Bun.spawn([process.execPath, "test"], { stdout: "pipe", stderr: "pipe", cwd: laid.repo, env: { ...process.env, NO_COLOR: "1" } });
    const [out, err, code] = await Promise.all([new Response(run.stdout).text(), new Response(run.stderr).text(), run.exited]);
    return { passed: code === 0, output: `${out}\n${err}` };
  } finally {
    laid.remove();
  }
}

/** A gate's command, run in the repository (the sandbox's /work/repo is here). */
export async function gate(posed: PosedTask, solution: Solution | null, command: string): Promise<boolean> {
  const laid = lay(posed, solution);
  try {
    const local = command.replace(/^cd \/work\/repo && /, "");
    const [bin, ...args] = local.split(" ");
    const run = Bun.spawn([bin === "bun" ? process.execPath : bin!, ...args], { stdout: "ignore", stderr: "ignore", cwd: laid.repo, env: { ...process.env, NO_COLOR: "1" } });
    return (await run.exited) === 0;
  } finally {
    laid.remove();
  }
}
