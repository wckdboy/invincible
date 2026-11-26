import { type ChatMessage, redact } from "@galahad/core";
import { clip, type GateResult, type QuestEvent, type QuestOutcome } from "./quest.ts";

/*
 * Effort: more compute for a better answer. Several independent attempts at the
 * same quest run at once, each in its own sandbox and each reviewed as any quest
 * is; then the independent reviewer takes the best, on the evidence alone (what
 * each ran, the exit codes, what its files print now), blind to which attempt or
 * model made it.
 *
 * The honesty rules of quests don't change: the outcome is the taken attempt's
 * own (done only if its own review passed it), and when none passed, the outcome
 * is the best of them and never "done".
 *
 * Pure orchestration: the attempts and the reviewer are injected, so the CLI, a
 * node and a test run the same code.
 */

export interface EffortAttempt<T = unknown> {
  /** 1-based. */
  index: number;
  outcome: QuestOutcome;
  /** What the reviewer sees of it when attempts are compared (evidenceCollector). */
  evidence: string;
  /** What the caller needs to finish with the one taken (its sandbox, say). */
  handle: T;
}

export interface EffortPick {
  /** The attempt taken. */
  index: number;
  /**
   * only: the one attempt that passed its review (or the only attempt) · reviewer: the reviewer chose among
   * those that passed · first-passed: the reviewer's pick couldn't be had · status: none passed.
   */
  by: "only" | "reviewer" | "first-passed" | "status";
  reason: string;
  /** The model that picked, when one did. */
  model?: string;
}

export type EffortEvent =
  | { type: "attempt-started"; index: number; of: number }
  | { type: "attempt-finished"; index: number; of: number; status: QuestOutcome["status"] }
  | { type: "attempt-failed"; index: number; of: number; error: string }
  | { type: "picking"; candidates: number[] }
  | { type: "picked"; index: number; by: EffortPick["by"]; reason: string; model?: string };

export interface EffortDeps<T> {
  /** One attempt, start to finish, in its own sandbox. A rejection loses that attempt, not the quest. */
  attempt(index: number, of: number, signal: AbortSignal): Promise<Omit<EffortAttempt<T>, "index">>;
  /** One complete reply from the reviewer role. */
  ask(messages: ChatMessage[]): Promise<{ text: string; model: string }>;
  emit?(event: EffortEvent): void;
  signal?: AbortSignal;
}

export interface EffortResult<T> {
  outcome: QuestOutcome;
  /** The attempt whose outcome this is (null only when you stopped it before any finished). */
  taken: EffortAttempt<T> | null;
  pick: EffortPick;
  /** Every attempt that finished, by index; the taken one is among them. */
  attempts: EffortAttempt<T>[];
  /** Attempts that never finished (no sandbox, a model outage past its retries). */
  failed: { index: number; error: string }[];
}

/** Each attempt's share of the comparison prompt. */
const EVIDENCE_HEAD = 4_500;
const EVIDENCE_TAIL = 1_500;
const LABELS = "ABCDEFGH";

/** The comparison: the quest and each attempt's evidence under a letter. Nothing in it says who made which. */
export function pickPrompt(goal: string, candidates: { label: string; evidence: string }[]): string {
  return `You are choosing between ${candidates.length} independent attempts at the same quest. Each has already passed a review of its own. Judge only from the evidence below (what each ran, the exit codes, what its files print now); claims without evidence don't count, and nothing tells you who or what made each attempt.

Quest: ${goal}

${candidates.map((c) => `=== Attempt ${c.label} ===\n${clip(c.evidence, EVIDENCE_HEAD, EVIDENCE_TAIL)}`).join("\n\n")}

Reply with PICK and one letter on the first line (for example: PICK ${candidates[0]?.label ?? "A"}): the attempt whose evidence best shows the quest done and verified. Then, in a few lines, why, and what the others lacked.`;
}

/** Read the reviewer's reply: PICK and one of the letters on the first line, or null. */
export function parsePick(reply: string, labels: readonly string[]): { label: string; notes: string } | null {
  const text = reply.trim();
  const firstLine = text.split(/\r?\n/, 1)[0]?.trim() ?? "";
  const m = /^\**\s*PICK\b[\s:*]*([A-Za-z])\b/i.exec(firstLine);
  if (!m) return null;
  const label = m[1]!.toUpperCase();
  return labels.includes(label) ? { label, notes: text.slice(firstLine.length).trim() } : null;
}

const STATUS_RANK: Record<QuestOutcome["status"], number> = { done: 0, unverified: 1, "gave-up": 2, stopped: 3 };

/**
 * Which attempt is taken. One that passed its review: that one. Several: the reviewer picks, seeing only
 * their evidence under letters. None: the best status (never "done"), and it says so.
 */
export async function chooseAttempt<T>(goal: string, attempts: readonly EffortAttempt<T>[], ask: EffortDeps<T>["ask"]): Promise<EffortPick> {
  const sorted = [...attempts].sort((a, b) => a.index - b.index);
  const passed = sorted.filter((a) => a.outcome.status === "done");
  if (!passed.length) {
    const best = [...sorted].sort((a, b) => STATUS_RANK[a.outcome.status] - STATUS_RANK[b.outcome.status] || a.index - b.index)[0]!;
    return {
      index: best.index,
      by: sorted.length === 1 ? "only" : "status",
      reason: sorted.length === 1 ? "The only attempt." : `None passed its review: the outcome is attempt ${best.index}'s (${best.outcome.status}).`,
    };
  }
  if (passed.length === 1) return { index: passed[0]!.index, by: "only", reason: sorted.length === 1 ? "The only attempt." : `Attempt ${passed[0]!.index} is the only one that passed its review.` };
  const candidates = passed.map((a, i) => ({ label: LABELS[i]!, index: a.index, evidence: a.evidence }));
  const firstPassed = (why: string): EffortPick => ({ index: passed[0]!.index, by: "first-passed", reason: `${why}: attempt ${passed[0]!.index}, the first that passed its review, is taken.` });
  let reply: { text: string; model: string };
  try {
    reply = await ask([{ role: "user", content: redact(pickPrompt(goal, candidates)) }]);
  } catch (error) {
    return firstPassed(`The reviewer couldn't be asked to compare them (${redact(String((error as Error).message ?? error)).slice(0, 200)})`);
  }
  const picked = parsePick(reply.text, candidates.map((c) => c.label));
  if (!picked) return firstPassed("The reviewer's pick wasn't clear");
  const taken = candidates.find((c) => c.label === picked.label)!;
  return { index: taken.index, by: "reviewer", reason: redact(picked.notes || `The reviewer took attempt ${taken.index}.`).slice(0, 2000), model: reply.model };
}

/** `attempts` attempts at once, then the pick. With one attempt this is just the quest. */
export async function runEffort<T>(options: { goal: string; attempts: number }, deps: EffortDeps<T>): Promise<EffortResult<T>> {
  const of = Math.max(1, Math.floor(options.attempts));
  const signal = deps.signal ?? new AbortController().signal;
  const emit = (event: EffortEvent): void => deps.emit?.(event);
  const finished: EffortAttempt<T>[] = [];
  const failed: { index: number; error: string }[] = [];
  await Promise.all(
    Array.from({ length: of }, async (_, i) => {
      const index = i + 1;
      emit({ type: "attempt-started", index, of });
      try {
        const done = await deps.attempt(index, of, signal);
        finished.push({ index, ...done });
        emit({ type: "attempt-finished", index, of, status: done.outcome.status });
      } catch (error) {
        const message = redact(String((error as Error)?.message ?? error)).slice(0, 500);
        failed.push({ index, error: message });
        emit({ type: "attempt-failed", index, of, error: message });
      }
    }),
  );
  finished.sort((a, b) => a.index - b.index);
  failed.sort((a, b) => a.index - b.index);
  if (!finished.length) throw new Error(failed.length === 1 ? failed[0]!.error : `no attempt could run: ${[...new Set(failed.map((f) => f.error))].join("; ")}`);
  if (signal.aborted) {
    // You stopped it: nothing is compared, and nothing is called done.
    const best = [...finished].sort((a, b) => a.index - b.index)[0]!;
    const pick: EffortPick = { index: best.index, by: "status", reason: "Stopped at your request." };
    return { outcome: { ...best.outcome, status: "stopped", summary: "Stopped at your request." }, taken: best, pick, attempts: finished, failed };
  }
  const several = finished.filter((a) => a.outcome.status === "done").length > 1;
  if (several) emit({ type: "picking", candidates: finished.filter((a) => a.outcome.status === "done").map((a) => a.index) });
  const pick = await chooseAttempt(options.goal, finished, deps.ask);
  const taken = finished.find((a) => a.index === pick.index)!;
  emit({ type: "picked", index: pick.index, by: pick.by, reason: pick.reason, ...(pick.model ? { model: pick.model } : {}) });
  return { outcome: taken.outcome, taken, pick, attempts: finished, failed };
}

/**
 * What an attempt beyond the first is told, after the usual instructions. The first attempt is the plain
 * quest (so effort 1 and the first attempt of effort 3 are the same work); the others know they aren't
 * alone, which is the only thing that sets one apart when a single model plays the engineer.
 */
export function attemptInstructions(index: number, of: number): string {
  if (of <= 1 || index <= 1) return "";
  return `Other engineers are attempting this same quest independently, and an independent reviewer will take the attempt whose evidence is strongest. Where there is a real choice of method, prefer a sound one that isn't the most obvious, and verify your result independently before you finish. (You are attempt ${index} of ${of}.)`;
}

/** A role's models, starting at another one for each attempt (the rest stay as fallbacks, in order). */
export function rotated<T>(models: readonly T[], by: number): T[] {
  if (models.length < 2) return [...models];
  const k = ((Math.floor(by) % models.length) + models.length) % models.length;
  return [...models.slice(k), ...models.slice(0, k)];
}

/** How much of each command's output the comparison keeps. */
const STEP_HEAD = 500;
const STEP_TAIL = 250;
/** The most commands of one attempt the comparison shows (the latest: the verification usually comes last). */
const STEPS_SHOWN = 30;

/**
 * Collects an attempt's evidence as its quest runs: every command, its exit code and an excerpt of what it
 * printed (never which model did it). `text` adds what the evidence commands print now, and the engineer's
 * summary, marked as the claim it is.
 */
export function evidenceCollector(): { emit(event: QuestEvent): void; text(outcome: QuestOutcome, fromSandbox?: string): string } {
  const commands = new Map<number, string>();
  const steps: { command: string; exitCode: number; excerpt: string }[] = [];
  /** The gates' last run (a quest with gates): the comparison shows what each printed then. */
  let gates: GateResult[] = [];
  return {
    emit(event) {
      if (event.type === "command") commands.set(event.step, event.command);
      else if (event.type === "gated") gates = event.results;
      else if (event.type === "observation") {
        steps.push({ command: commands.get(event.step) ?? "(unknown)", exitCode: event.exitCode, excerpt: clip(event.output.split("\n").slice(1).join("\n"), STEP_HEAD, STEP_TAIL) });
      }
    },
    text(outcome, fromSandbox = "") {
      const shown = steps.slice(-STEPS_SHOWN);
      const ran = shown.map((s, i) => `${steps.length - shown.length + i + 1}. $ ${s.command}\n   exit ${s.exitCode}\n${s.excerpt.replace(/^/gm, "   ")}`).join("\n");
      return redact(
        [
          `What it ran (${steps.length} command${steps.length === 1 ? "" : "s"}${shown.length < steps.length ? `, the last ${shown.length} shown` : ""}; exit code and an excerpt of the output):\n${ran || "(nothing)"}`,
          gates.length
            ? `Gates (commands that each had to exit 0 in its sandbox before its own review; their last run):\n${gates.map((g, i) => `${i + 1}. $ ${g.command}\n   exit ${g.exitCode}\n${clip(g.excerpt, STEP_HEAD, STEP_TAIL).replace(/^/gm, "   ")}`).join("\n")}`
            : "",
          fromSandbox.trim() ? `What these print now, in its sandbox:\n${fromSandbox.trim()}` : "",
          `Its own summary (a claim, not evidence):\n${outcome.summary.trim() || "(none)"}`,
        ]
          .filter(Boolean)
          .join("\n\n"),
      );
    },
  };
}
