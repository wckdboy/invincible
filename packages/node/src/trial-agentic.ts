import type { ExecResult, SandboxView, TrialRecord } from "@galahad/core";
import { type QuestTiming, span, timingLine } from "@galahad/brain";
import {
  AGENTIC_DIFF,
  AGENTIC_EVIDENCE,
  AGENTIC_INSTRUCTIONS,
  type AgenticTask,
  checkCommand,
  GRADE,
  gradeChecks,
  MARK,
  type PosedTask,
  poseTask,
  problemId,
  putCommands,
  readTree,
  REPO,
  RESULT_FILE,
  treeCommand,
} from "@galahad/brain";
import { type NodeClient, questId, runNodeQuest } from "./quest-cli.ts";
import { harnessOptions, heldToEffort, nothingAnswered, tellPassedOver, type TrialJob, type TrialUnit } from "./trial-cli.ts";

/*
 * One agentic trial: a small repository and a task, posed from a seed, put in a fresh
 * sandbox, and worked as an ordinary quest (planner → engineer → gates → independent
 * reviewer; with effort, several attempts and the reviewer's pick). Then what he left
 * in the repository is taken out, the sandbox goes, and the hidden tests run in another
 * fresh sandbox the engineer never had: no network, no models, nothing of his but the
 * files. A program decides, check by check.
 *
 * What keeps it honest is what keeps the engineering suite honest: the hidden tests and
 * the reference solution are never in the engineer's sandbox; the reviewer has picked
 * before anything is graded; only what was left counts; every check is recorded as a
 * number each replica re-checks; and a crash of the machinery (no sandbox, a tree that
 * can't be read) is recorded as a crash, which says nothing about ability.
 */

/** How long one hidden check may run. A check that doesn't finish has failed: that is his code's doing. */
export const CHECK_TIMEOUT_SEC = 120;

type Exec = (command: string, timeoutSec: number) => Promise<ExecResult>;

/** The repository as given, in the quest's sandbox, as a git repository of one commit (so the reviewer sees what changed). */
async function seed(exec: Exec, posed: PosedTask): Promise<void> {
  for (const command of putCommands(posed.files, REPO)) {
    const result = await exec(command, 120);
    if (result.exitCode !== 0) throw new Error(`the task's repository couldn't be put in the sandbox: ${(result.stderr || result.stdout).trim().slice(0, 300)}`);
  }
  // Without git the work goes on: only the reviewer's view of what changed is poorer.
  await exec(
    `${MARK}commit\nmkdir -p /work/out && cd ${REPO} && git init -q . 2>/dev/null && git add -A 2>/dev/null && git -c user.name=galahad -c user.email=trial@galahad.invalid commit -qm "as given" 2>/dev/null; true`,
    120,
  );
}

/**
 * The hidden checks, in a fresh sandbox with no network: what he left, the check script beside it, and one
 * process a check. Which passed, by key. Anything that keeps a check from being run at all throws (a crash).
 */
async function gradeApart(node: NodeClient, posed: PosedTask, left: Record<string, string>, said: string | null, questStatus: string, job: TrialJob): Promise<Map<string, boolean>> {
  const { sandbox } = await node.call<{ sandbox: SandboxView }>("createSandbox", {
    network: "isolated",
    quest: questId("g"),
    ...(job.isolation ? { isolation: job.isolation } : {}),
    ...(job.on ? { on: job.on } : {}),
  });
  const exec: Exec = (command, timeoutSec) => node.call<ExecResult>("execSandbox", { id: sandbox.id, cmd: ["bash", "-c", command], timeoutSec, on: sandbox.node });
  try {
    const files: Record<string, string> = {
      ...Object.fromEntries(Object.entries(left).map(([path, text]) => [`repo/${path}`, text])),
      "check.mjs": posed.script,
      "quest.json": JSON.stringify({ status: questStatus }),
      ...(said !== null ? { "result.json": said } : {}),
    };
    for (const command of putCommands(files, GRADE.root)) {
      const result = await exec(command, 120);
      if (result.exitCode !== 0) throw new Error(`what he left couldn't be put in the grading sandbox: ${(result.stderr || result.stdout).trim().slice(0, 300)}`);
    }
    // A token of this trial's own: a check passed only if its process printed it after its assertions held.
    const token = crypto.randomUUID().replace(/-/g, "");
    const verdicts = new Map<string, boolean>();
    for (const check of posed.checks) {
      if (job.signal?.aborted) throw new Error("stopped");
      const { command, passed } = checkCommand(check.key, token);
      verdicts.set(check.key, passed(await exec(command, CHECK_TIMEOUT_SEC)));
    }
    return verdicts;
  } finally {
    await node.call("destroySandbox", { id: sandbox.id, on: sandbox.node }).catch(() => {});
  }
}

/**
 * Where a trial's time went, kept with its record (its note): the quest's own stages (brain QuestTiming; a coding
 * tool's whole run is its commands), the grading, and the rest (sandboxes made and waited for, files put in and out).
 */
export function timeNote(timing: QuestTiming | undefined, gradingMs: number, wholeMs: number): string {
  if (!timing) return "";
  const quest = timing.plan + timing.model + timing.commands + timing.gates + timing.review;
  return `time: ${timingLine(timing)}, grading ${span(gradingMs)}, the rest ${span(Math.max(0, wholeMs - quest - gradingMs))}`;
}

/** One trial of a task at a level. The record, or null when you stopped it. */
export async function attemptTask(node: NodeClient, task: AgenticTask, level: number, job: TrialJob): Promise<TrialRecord | null> {
  const posed = poseTask(task, job.seed, level);
  const id = problemId(task, level);
  const models = new Set<string>();
  const started = Date.now();
  const base = { run: job.run, suite: job.suite, problem: id, title: task.title, domain: task.kind, seed: job.seed, version: job.version };
  try {
    let left: Record<string, string> | null = null;
    let skipped: string[] = [];
    let said: string | null = null;
    // A task's own gates run unless the run's variant turns gates off.
    const gates = (job.harness ? job.harness.gates : true) ? posed.gates : [];
    const { outcome, artifact } = await runNodeQuest(
      node,
      {
        goal: posed.goal,
        network: job.network,
        ...(job.isolation ? { isolation: job.isolation } : {}),
        ...(job.on ? { on: job.on } : {}),
        maxSteps: posed.maxSteps,
        instructions: AGENTIC_INSTRUCTIONS,
        evidence: job.harness?.diff ? [...AGENTIC_EVIDENCE, AGENTIC_DIFF] : AGENTIC_EVIDENCE,
        label: `Trial ${id} (seed ${job.seed})`,
        remember: false,
        trial: true,
        ...(gates.length ? { gates } : {}),
        ...harnessOptions(job),
      },
      {
        signal: job.signal,
        effort: heldToEffort(job.effort),
        ...(job.spent ? { spent: job.spent } : {}),
        ...(job.sandboxSpent ? { sandboxSpent: job.sandboxSpent } : {}),
        emit: (event) => {
          if ((event.type === "plan" || event.type === "thought" || event.type === "review") && event.model) models.add(event.model);
          tellPassedOver(job)(event);
        },
        // Every attempt starts from the same repository, as given.
        prepare: (exec) => seed(exec, posed),
        // With effort this is the attempt the reviewer took: nothing has been graded yet, and nothing of the others is.
        finished: async (exec) => {
          const tree = readTree((await exec(treeCommand(REPO), 120)).stdout);
          left = tree?.files ?? null;
          skipped = tree?.skipped ?? [];
          const read = await exec(`cat ${RESULT_FILE} 2>/dev/null | head -c 20000`, 60).catch(() => null);
          said = read?.exitCode === 0 && read.stdout.trim() ? read.stdout : null;
        },
      },
    );
    // Your Ctrl-C says nothing about ability; running out of commands does, and is graded.
    if (job.signal?.aborted) return null;
    // Nor does work no model ever answered (every call refused: a plan's allowance spent, a key gone): a crash, not a 0.
    const unanswered = nothingAnswered(outcome, models);
    if (unanswered) throw new Error(unanswered);
    if (!left) throw new Error("what he left in the repository couldn't be read out of the sandbox");
    const grading = Date.now();
    const verdicts = await gradeApart(node, posed, left, said, outcome.status, job);
    if (job.signal?.aborted) return null;
    const graded = gradeChecks(posed.checks, (key) => verdicts.get(key) ?? null);
    const notes = [graded.note, skipped.length ? `not taken out (too large, or not a file): ${skipped.slice(0, 5).join(", ")}` : "", timeNote(outcome.timing, Date.now() - grading, Date.now() - started)].filter(Boolean).join("; ");
    return {
      ...base,
      status: "scored",
      score: graded.score,
      answers: graded.answers,
      quest: { status: outcome.status, steps: outcome.steps, revisions: outcome.revisions },
      models: [...models].slice(0, 8),
      seconds: Math.round((Date.now() - started) / 1000),
      ...(artifact ? { artifact: artifact.id } : {}),
      ...(notes ? { note: notes.slice(0, 1000) } : {}),
    };
  } catch (error) {
    if (job.signal?.aborted) return null;
    return {
      ...base,
      status: "crashed",
      score: 0,
      answers: gradeChecks(posed.checks, () => null).answers,
      models: [...models].slice(0, 8),
      seconds: Math.round((Date.now() - started) / 1000),
      note: (error instanceof Error ? error.message : String(error)).slice(0, 1000),
    };
  }
}

/** A task at a level, as something a run can try. */
export const agenticUnit = (task: AgenticTask, level: number): TrialUnit => ({
  id: problemId(task, level),
  title: task.title,
  domain: task.kind,
  attempt: (node, job) => attemptTask(node, task, level, job),
});
