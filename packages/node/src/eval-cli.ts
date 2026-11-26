import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  addUsage,
  type ComputeView,
  costed,
  costIndex,
  costOf,
  describeVariant,
  doneLine,
  doneReport,
  type EffortLevel,
  effortReport,
  evalIndex,
  type HarnessOptions,
  mergeSpend,
  type Prices,
  type SandboxNetwork,
  spendLabel,
  spendTotal,
  tokensLabel,
  type EvalPins,
  type EvalRecord,
  type EvalRunsView,
  type EvalVariant,
  type EvalView,
  type Usage,
  type UsageLine,
  usdLabel,
} from "@invincible/core";
import { grade, pose, SUITES, EVAL_EVIDENCE, EVAL_INSTRUCTIONS, type EvalProblem } from "@invincible/models";
import { type RunOutcome } from "@invincible/agents";
import { CLAUDE_CODE_IMAGE } from "@invincible/sandbox";
import { type DoOptions, type NodeClient, runOnNode } from "./run-cli.ts";

/*
 * `invincible eval run`: each problem is posed with fresh random parameters, solved as
 * an ordinary run in the Lab (models only, no internet: nothing to look up), graded
 * here against the exact answers, and recorded in the mind. The Eval Index is the
 * mean score of a run, with a bootstrap interval.
 *
 * Evals run in parallel across the fleet's free slots, and a run may spend effort: each
 * eval then makes that many attempts, the reviewer takes one on the evidence, and only
 * that one's answers are graded (the grader never tells the reviewer which was right).
 * A run records its effort, so the Index per effort level says, with its interval,
 * whether more compute made it more capable.
 *
 * A run also records what else was held fixed or switched (a role pinned to one model, a
 * named variant of the harness), counts what every model call cost as the providers
 * reported it, and keeps to a budget: it says before it starts roughly what it will
 * cost from past runs of the same problems, and stops cleanly when the budget is spent.
 */

/** What one eval of something needs from the run it belongs to. */
export interface EvalJob {
  seed: number;
  run: string;
  suite: string;
  version: string;
  network: SandboxNetwork;
  isolation?: "container" | "vm";
  on?: string;
  signal?: AbortSignal;
  effort?: EffortLevel;
  /** The harness switches of the run's variant (absent: as evals have always run). */
  harness?: HarnessOptions;
  /** Roles held to one model. */
  pins?: EvalPins;
  /** Every model call as it ends (the run's budget counts them as they come). */
  spent?(call: { role: string; model: string; usage: Usage | null }): void;
  /** What a sandbox's own calls through the gateway came to (a coding agent's), as it closes: counted like any. */
  sandboxSpent?(lines: UsageLine[]): void;
  /** A role's model that couldn't answer, and the one that answered in its place (an eval's run says it once). */
  passedOver?(call: PassedOver): void;
}

/** Lines folded into a count kept as it goes, in place. */
export const absorb = (into: UsageLine[], lines: readonly UsageLine[]): void => void into.splice(0, into.length, ...mergeSpend(into, lines));

/** How long a coding tool has for an eval's work: the time a run takes, not a limit that decides it. */
export const AGENT_EVAL_MINUTES = 60;

/**
 * A coding tool the workshop image hasn't got, in an image made for evals alone (sandbox/claude-code): a run puts it to
 * the same tasks as its own loop, on the same model, through the gateway. An agent's VM never gets it from the primary.
 */
export const EVAL_IMAGES: Readonly<Record<string, string>> = { claude: CLAUDE_CODE_IMAGE };

/** A model of a role's that couldn't answer, why, and which one answered instead. */
export interface PassedOver {
  role: string;
  model: string;
  error: string;
  answered: string;
}

/** An eval's run tells its run which models were passed over (the run says each once). */
export const tellPassedOver =
  (job: Pick<EvalJob, "passedOver">) =>
  (event: { type: string; role?: string; model?: string; error?: string; answered?: string }): void => {
    if (event.type === "skipped" && event.role && event.model && event.answered) job.passedOver?.({ role: event.role, model: event.model, error: event.error ?? "", answered: event.answered });
  };

/**
 * Something a run can try: a problem of a suite that isn't the engineering one (an agentic task with hidden
 * tests, a case put to the reviewer). It poses itself from the seed, does the work through the node, grades
 * it by program, and hands back the record; the run adds what it spent and records it. Null: you stopped it.
 */
export interface EvalUnit {
  id: string;
  title: string;
  domain: string;
  /** Tokens one eval of it may be expected to cost when nothing is known from past runs (null: say unknown). */
  attempt(node: NodeClient, job: EvalJob): Promise<EvalRecord | null>;
}

export type Tryable = EvalProblem | EvalUnit;
const isUnit = (p: Tryable): p is EvalUnit => typeof (p as EvalUnit).attempt === "function";

export interface EvalBudget {
  /** Tokens in and out together, as the providers report them. */
  tokens?: number;
  /** US dollars, at your prices (needs a price for every model that answers). */
  usd?: number;
}

export interface EvalRunOptions {
  suite: string;
  problems: readonly Tryable[];
  /** The same seed poses the same problem (default: a fresh one per eval). */
  seed?: number;
  repeat: number;
  /** How many evals at once; "auto": as many as the free slots carry at this effort. */
  parallel: number | "auto";
  /** Attempts per eval (the run records it). Left out: one, and nothing about effort is recorded or asked. */
  effort?: EffortLevel;
  /** The harness as this run switches it (its effort is the run's). */
  variant?: EvalVariant;
  /** Roles held to one model for the whole run. */
  pins?: EvalPins;
  /** Runs made to be compared (an A/B's two, a sweep's candidates) share this. */
  group?: string;
  /** What the run may spend. Left out: DEFAULT_TOKENS_PER_ATTEMPT for every attempt it would make. */
  budget?: EvalBudget;
  /** Your prices: what a money budget counts with. */
  prices?: Prices;
  /** The run's id (default: a fresh one). */
  run?: string;
  network: SandboxNetwork;
  isolation?: "container" | "vm";
  on?: string;
  signal?: AbortSignal;
  /** As each eval starts and ends. */
  progress?(
    event:
      | { type: "start"; problem: Tryable; seed: number }
      | { type: "done"; evalCase: EvalView }
      | { type: "skipped"; problem: Tryable; why: string }
      /** A role's model couldn't answer and another did: what is measured, and paid for, is the one that answered. Once for each. */
      | ({ type: "fallback" } & PassedOver)
      /** How the run will go: evals at once, and why (the slots there are). */
      | { type: "plan"; parallel: number; effort: EffortLevel | null; why: string }
      /** Before the first eval: the budget, and roughly what the run will cost going by past runs of the same problems. */
      | { type: "budget"; budget: EvalBudget; byDefault: boolean; estimate: RunEstimate }
      /** The budget is spent: what was finished, and what wasn't started or was stopped. */
      | { type: "spent"; finished: number; stopped: number; notStarted: number; why: string },
  ): void;
}

/** Tokens one attempt at an eval is allowed for when you name no budget: a guard against a runaway, not a forecast. */
export const DEFAULT_TOKENS_PER_ATTEMPT = 600_000;

/**
 * How many evals run at once: no more than the fleet's sandbox slots carry at this effort (what's asked for
 * beyond that would only wait in the queue until it gave up). With "auto", what's free now. A fleet whose
 * slots can't carry one eval at the effort asked can't measure it, and says so.
 */
export function planParallel(census: Pick<ComputeView, "nodes"> | null, asked: number | "auto", effort: number, jobs: number, on?: string): { parallel: number; why: string } {
  const fallback = Math.max(1, Math.min(asked === "auto" ? 3 : asked, jobs));
  if (!census) return { parallel: fallback, why: "the node doesn't say what it carries" };
  const hosts = census.nodes.filter((n) => (on ? n.name === on || n.id === on : n.online) && (n.capacity?.sandboxes ?? 0) > 0);
  const slots = hosts.reduce((sum, n) => sum + n.capacity!.sandboxes, 0);
  const free = hosts.reduce((sum, n) => sum + (n.free ?? 0), 0);
  const where = on ?? (hosts.length === 1 ? hosts[0]!.name : "the fleet");
  if (slots < effort) throw new Error(`${where} carries ${slots} sandbox${slots === 1 ? "" : "es"} at once: effort ${effort} can't be measured there (invincible compute)`);
  const most = Math.max(1, Math.floor(slots / effort));
  if (asked === "auto") {
    const now = Math.max(1, Math.min(most, Math.floor(free / effort) || 1, jobs, 8));
    return { parallel: now, why: `${free} of ${slots} slots free on ${where}${effort > 1 ? `, ${effort} attempts an eval` : ""}` };
  }
  const parallel = Math.max(1, Math.min(asked, most, jobs));
  return { parallel, why: parallel < Math.min(asked, jobs) ? `${where} carries ${slots} slots${effort > 1 ? `, ${effort} attempts an eval` : ""}: ${parallel} at once, not ${asked}` : `${slots} slots on ${where}` };
}

export { primaryRevision } from "./revision.ts";
import { primaryRevision } from "./revision.ts";

const freshSeed = (): number => crypto.getRandomValues(new Uint32Array(1))[0]!;

/** A run's id: when it started (the Index is computed per run). */
/**
 * When it began, and four characters of chance, never an id this process made before: two runs begun in the same
 * millisecond (a sweep's or an A/B's, one that had no room for an eval) are two runs, not one recorded twice.
 */
const madeRuns = new Set<string>();
export function freshRunId(): string {
  for (;;) {
    const id = `r-${Date.now().toString(36)}${(crypto.getRandomValues(new Uint32Array(1))[0]! % 36 ** 4).toString(36).padStart(4, "0")}`;
    if (!madeRuns.has(id)) return (madeRuns.add(id), id);
  }
}

/**
 * Why an eval's run measured nothing, when no model of it ever answered: it gave up before a single step, and no
 * model said a word (a coding tool whose every call its gateway refused, a plan's allowance spent). Null otherwise.
 * On 21 November 2026 four OpenCode evals were scored 0 so, in fifteen seconds each, the plan's allowance spent.
 */
export function nothingAnswered(outcome: Pick<RunOutcome, "status" | "steps" | "summary">, models: ReadonlySet<string>): string | null {
  if (outcome.status !== "gave-up" || outcome.steps > 0 || models.size > 0) return null;
  return `no model answered, so nothing was measured: ${outcome.summary.split("\n").find((line) => line.trim())?.trim().slice(0, 400) ?? "(no reason given)"}`;
}

/** The harness switches as a run's options (a task's own gates are the caller's to add). */
export function harnessOptions(job: Pick<EvalJob, "harness" | "pins" | "effort">): Partial<DoOptions> {
  const h = job.harness;
  return {
    ...(job.effort !== undefined ? { effort: job.effort } : {}),
    ...(job.pins && Object.keys(job.pins).length ? { pins: job.pins } : {}),
    ...(h ? { proposeGates: h.plannerGates, offerSkills: h.skills, archive: h.archive, maxRevisions: h.revisions } : {}),
    ...(h?.engram ? { engram: true } : {}),
    // An eval escalates only when its variant says so: a run without one is measured as evals always were.
    escalate: h?.escalate ?? false,
    // Nor are its constraints said again unless its variant says so, nor its file reads kept whole, nor a contract written first.
    ...(h?.remind ? { remind: true } : {}),
    ...(h?.keepReads ? { keepReads: true } : {}),
    ...(h?.tools ? { tools: true } : {}),
    ...(h?.contract ? { contract: true } : {}),
    // A coding tool doing the work, and without the planner or the reviewer: a bare tool, as a person runs it.
    ...(h?.agent ? { agent: { name: h.agent, minutes: AGENT_EVAL_MINUTES, ...(EVAL_IMAGES[h.agent] ? { image: EVAL_IMAGES[h.agent] } : {}) } } : {}),
    ...(h && !h.planner ? { plan: "" } : {}),
    ...(h && !h.review ? { unreviewed: true } : {}),
  };
}

/** A run is measured at one effort: an eval the node couldn't give it to says nothing about that level. */
export const heldToEffort =
  (effort: EffortLevel | undefined) =>
  (event: { type: string; grant?: { attempts: number; reasons: string[] } }): void => {
    if (event.type === "granted" && effort !== undefined && event.grant && event.grant.attempts !== effort) {
      throw new Error(`the node granted ${event.grant.attempts} attempt(s), not the run's ${effort}: ${event.grant.reasons.join(" ")}`);
    }
  };

/** One engineering eval: pose, solve as a run, grade. The record, or null when you stopped it. */
async function solveProblem(node: NodeClient, problem: EvalProblem, job: EvalJob): Promise<EvalRecord | null> {
  const { seed } = job;
  const posed = pose(problem, seed);
  const models = new Set<string>();
  const started = Date.now();
  const base = { run: job.run, suite: job.suite, problem: problem.id, title: problem.title, domain: problem.domain, seed, version: job.version };
  try {
    let answer: string | null = null;
    const { outcome, artifact } = await runOnNode(
      node,
      {
        goal: posed.goal,
        network: job.network,
        lab: true,
        ...(job.isolation ? { isolation: job.isolation } : {}),
        ...(job.on ? { on: job.on } : {}),
        ...(problem.budget?.maxSteps ? { maxSteps: problem.budget.maxSteps } : {}),
        ...(problem.budget?.commandTimeoutSec ? { commandTimeoutSec: problem.budget.commandTimeoutSec } : {}),
        instructions: EVAL_INSTRUCTIONS,
        evidence: EVAL_EVIDENCE,
        label: `Eval ${problem.id} (seed ${seed})`,
        remember: false,
        evalCase: true,
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
        finished: async (exec) => {
          const read = await exec("cat /work/out/answer.json 2>/dev/null | head -c 100000", 60).catch(() => null);
          answer = read?.exitCode === 0 ? read.stdout : null;
        },
      },
    );
    // Your Ctrl-C says nothing about ability; running out of commands does, and is scored.
    if (job.signal?.aborted) return null;
    // Nor does work no model ever answered: a crash, not a 0 (eval-agentic nothingAnswered).
    const unanswered = nothingAnswered(outcome, models);
    if (unanswered) throw new Error(unanswered);
    const graded = grade(posed.expected, answer);
    return {
      ...base,
      status: "scored",
      score: graded.score,
      answers: graded.answers,
      outcome: { status: outcome.status, steps: outcome.steps, revisions: outcome.revisions },
      models: [...models].slice(0, 8),
      seconds: Math.round((Date.now() - started) / 1000),
      ...(artifact ? { artifact: artifact.id } : {}),
      ...(graded.note ? { note: graded.note } : {}),
    };
  } catch (error) {
    if (job.signal?.aborted) return null;
    return {
      ...base,
      status: "crashed",
      score: 0,
      answers: grade(posed.expected, null).answers,
      models: [...models].slice(0, 8),
      seconds: Math.round((Date.now() - started) / 1000),
      note: (error instanceof Error ? error.message : String(error)).slice(0, 1000),
    };
  }
}

/** What an eval spent, as a record carries it: the heaviest lines first, within what a record holds. */
const MAX_LINES = 24;
function spentLines(lines: readonly UsageLine[]): UsageLine[] {
  return [...lines].sort((a, b) => b.input + b.output - (a.input + a.output) || b.calls - a.calls).slice(0, MAX_LINES);
}

/** One eval of anything a run can try: done through the node, graded by program, recorded with what it spent. Null when you stopped it. */
export async function tryOne(node: NodeClient, problem: Tryable, job: EvalJob): Promise<EvalView | null> {
  const lines: UsageLine[] = [];
  const counted: EvalJob = {
    ...job,
    spent: (call) => {
      addUsage(lines, call.role, call.model, call.usage);
      job.spent?.(call);
    },
    sandboxSpent: (through) => {
      absorb(lines, through);
      job.sandboxSpent?.(through);
    },
  };
  const record = isUnit(problem) ? await problem.attempt(node, counted) : await solveProblem(node, problem, counted);
  if (!record) return null;
  return (await node.call<{ evalCase: EvalView }>("recordEval", { ...record, ...(lines.length ? { spent: spentLines(lines) } : {}) })).evalCase;
}

/** One engineering eval: pose, solve as a run, grade, record. Null when you stopped it. */
export function runEval(node: NodeClient, job: Omit<EvalJob, "spent" | "harness" | "pins"> & { problem: EvalProblem } & Pick<Partial<EvalJob>, "spent" | "harness" | "pins">): Promise<EvalView | null> {
  const { problem, ...rest } = job;
  return tryOne(node, problem, rest);
}

/* ---------- what a run will cost, going by the past ---------- */

export interface RunEstimate {
  /** Tokens for the whole run, going by past evals of the same problems (null: none of them has been tried with counting). */
  tokens: number | null;
  /** The same in money, when those past evals were all priced. */
  usd: number | null;
  /** How many of the run's evals the estimate rests on past evals of the same problem for. */
  known: number;
  of: number;
}

/** An eval's tokens when all of its calls were counted, else null. */
const tokensOf = (t: Pick<EvalView, "spent">): number | null => {
  if (!t.spent?.lines.length) return null;
  const total = spendTotal(t.spent.lines);
  return total.complete ? total.tokens : null;
};

/**
 * Roughly what a run would cost: for each problem, the mean of its past scored evals at the same effort
 * (their tokens as the providers reported them); a problem never tried with counting goes by the mean of the
 * others. Nothing known at all: it says so rather than guess.
 */
export function estimateRun(past: readonly EvalView[], problems: readonly { id: string }[], repeat: number, effort: number, efforts: Readonly<Record<string, number>>, prices: Prices = {}): RunEstimate {
  const perProblem = (id: string): { tokens: number; usd: number | null } | null => {
    const same = past.filter((t) => t.problem === id && t.status === "scored" && tokensOf(t) !== null);
    const atEffort = same.filter((t) => (efforts[t.run] ?? 1) === effort);
    // Past evals at another effort still say something: an attempt's worth, times this run's attempts.
    const pool = atEffort.length ? atEffort.map((t) => ({ t, scale: 1 })) : same.map((t) => ({ t, scale: effort / (efforts[t.run] ?? 1) }));
    if (!pool.length) return null;
    const tokens = pool.reduce((s, p) => s + tokensOf(p.t)! * p.scale, 0) / pool.length;
    const costs = pool.map((p) => {
      const c = costOf(p.t.spent!.lines, prices);
      return c.complete ? c.usd * p.scale : null;
    });
    return { tokens, usd: costs.every((c) => c !== null) ? costs.reduce<number>((s, c) => s + c!, 0) / costs.length : null };
  };
  const each = problems.map((p) => perProblem(p.id));
  const known = each.filter((e): e is { tokens: number; usd: number | null } => e !== null);
  if (!known.length) return { tokens: null, usd: null, known: 0, of: problems.length * repeat };
  const meanTokens = known.reduce((s, e) => s + e.tokens, 0) / known.length;
  const priced = known.every((e) => e.usd !== null);
  const meanUsd = priced ? known.reduce((s, e) => s + e.usd!, 0) / known.length : null;
  return {
    tokens: Math.round(each.reduce((s, e) => s + (e?.tokens ?? meanTokens), 0) * repeat),
    usd: meanUsd === null ? null : each.reduce((s, e) => s + (e?.usd ?? meanUsd), 0) * repeat,
    known: known.length * repeat,
    of: problems.length * repeat,
  };
}

export interface RunResult {
  run: string;
  evals: EvalView[];
  /** Everything the run's model calls came to, stopped evals included. */
  spent: UsageLine[];
  /** Set when the budget ended the run: what wasn't started, and what was stopped mid-way (and so not recorded). */
  budgetEnded?: { notStarted: number; stopped: number; why: string };
}

/** A run: every problem (repeated), a few at a time, within its budget. */
export async function runEvals(node: NodeClient, options: EvalRunOptions): Promise<RunResult> {
  const run = options.run ?? freshRunId();
  const version = primaryRevision();
  const jobs = options.problems.flatMap((problem) =>
    Array.from({ length: options.repeat }, (_, i) => ({ problem, seed: options.seed === undefined ? freshSeed() : (options.seed + i) >>> 0 })),
  );
  const evals: EvalView[] = [];
  // A variant's effort is the run's (a run is measured at one level).
  const effort = options.variant ? options.variant.options.effort : options.effort;
  // Across the slots there are: with effort (or "auto"), the node says what it carries; otherwise as asked.
  const census = effort !== undefined || options.parallel === "auto" ? await node.call<ComputeView>("compute").catch(() => null) : null;
  const asked = effort !== undefined || options.parallel === "auto" ? planParallel(census, options.parallel, effort ?? 1, jobs.length, options.on) : { parallel: options.parallel as number, why: "as asked" };

  // The budget: yours, or an allowance for every attempt the run would make. And roughly what it will cost.
  const prices = options.prices ?? {};
  const byDefault = options.budget?.tokens === undefined && options.budget?.usd === undefined;
  const budget: EvalBudget = byDefault ? { tokens: jobs.length * (effort ?? 1) * DEFAULT_TOKENS_PER_ATTEMPT } : options.budget!;
  const past = await node.call<{ evals: EvalView[]; runs?: EvalRunsView }>("evals").catch(() => null);
  const pastEfforts = Object.fromEntries(Object.entries(past?.runs ?? {}).map(([r, s]) => [r, s.effort]));
  const estimate = estimateRun(past?.evals ?? [], options.problems, options.repeat, effort ?? 1, pastEfforts, prices);
  // Evals no past run has priced, under a budget short of twice what the run is expected to cost, run one at a time: a
  // stop at the budget then cuts one short and keeps those before it, never every one under way. (21 November 2026: four
  // at once, two of them never tried and dearer than the rest, spent $2.03 of a $2 budget, and none was recorded.)
  const tight = (limit: number | undefined, expected: number | null): boolean => limit !== undefined && (expected === null || expected * 2 > limit);
  const guessing = !byDefault && estimate.known < estimate.of && (tight(budget.usd, estimate.usd) || tight(budget.tokens, estimate.tokens));
  const plan = guessing && asked.parallel > 1 ? { parallel: 1, why: "some have never been tried, and the budget is close to what they're expected to cost: a stop at it cuts one short, not all" } : asked;
  options.progress?.({ type: "plan", parallel: Math.max(1, Math.min(plan.parallel, jobs.length)), effort: effort ?? null, why: plan.why });
  options.progress?.({ type: "budget", budget, byDefault, estimate });

  // The run's settings are on record before its first eval, so its evals can be told apart by them.
  const recorded = effort !== undefined || options.variant || options.pins || options.group || !byDefault;
  if (recorded) {
    await node.call("startEvalRun", {
      run,
      suite: options.suite,
      effort: effort ?? 1,
      parallel: plan.parallel,
      ...(options.pins && Object.keys(options.pins).length ? { pins: options.pins } : {}),
      ...(options.variant ? { variant: options.variant } : {}),
      ...(options.seed !== undefined ? { seed: options.seed } : {}),
      ...(options.group ? { group: options.group } : {}),
      ...(!byDefault ? { budget } : {}),
    });
  }

  // What the run has spent so far, counted call by call as the providers report it.
  const spent: UsageLine[] = [];
  const over = (): string | null => {
    const total = spendTotal(spent);
    if (budget.tokens !== undefined && total.tokens >= budget.tokens) return `the budget of ${tokensLabel(budget.tokens)} tokens is spent (${tokensLabel(total.tokens)} counted)`;
    if (budget.usd !== undefined) {
      const cost = costOf(spent, prices);
      // A money budget can't be kept blind: a call nobody priced ends the run rather than run on uncounted.
      if (cost.unpriced.length) return `a money budget needs a price for every model that answers, and there's none for ${cost.unpriced.join(", ")} (invincible price set …)`;
      if (cost.usd >= budget.usd) return `the budget of ${usdLabel(budget.usd)} is spent (${usdLabel(cost.usd)} counted)`;
    }
    return null;
  };
  // Your budget isn't spent on evals it can't be expected to see through: one stopped mid-way is paid for and not
  // recorded. Going by past runs, an eval starts only while what's spent, what the evals under way are still expected
  // to spend, and what it is expected to cost fit the budget. (Nothing known of the past, or no budget of yours: as
  // many as there are slots, and the budget's stop below.)
  const each = { tokens: estimate.tokens === null ? null : estimate.tokens / estimate.of, usd: estimate.usd === null ? null : estimate.usd / estimate.of };
  const underway = new Map<number, UsageLine[]>();
  const ahead = (cost: (lines: UsageLine[]) => number, per: number): number => [...underway.values()].reduce((s, lines) => s + Math.max(0, per - cost(lines)), 0);
  const noRoom = (): string | null => {
    if (byDefault) return null;
    if (budget.tokens !== undefined && each.tokens !== null && spendTotal(spent).tokens + ahead((l) => spendTotal(l).tokens, each.tokens) + each.tokens > budget.tokens)
      return `${tokensLabel(Math.max(0, budget.tokens - spendTotal(spent).tokens))} tokens of the budget are left, and an eval takes about ${tokensLabel(each.tokens)} going by past runs`;
    if (budget.usd !== undefined && each.usd !== null && costOf(spent, prices).usd + ahead((l) => costOf(l, prices).usd, each.usd) + each.usd > budget.usd)
      return `${usdLabel(Math.max(0, budget.usd - costOf(spent, prices).usd))} of the budget is left, and an eval costs about ${usdLabel(each.usd)} going by past runs`;
    return null;
  };
  // The budget's own stop: running evals end after their current step (unrecorded), and none starts.
  const stop = new AbortController();
  const signal = options.signal ? AbortSignal.any([options.signal, stop.signal]) : stop.signal;
  let ended: string | null = null;
  let stopped = 0;
  let next = 0;
  /** The models said to have been passed over so far: each once a run, by role. */
  const passedOver = new Set<string>();
  const worker = async (): Promise<void> => {
    while (next < jobs.length && !signal.aborted) {
      ended ??= over();
      if (ended) break;
      // (No room for another: this slot closes, and one still running looks again when its eval ends.)
      if (noRoom()) break;
      const index = next++;
      const { problem, seed } = jobs[index]!;
      const mine: UsageLine[] = [];
      underway.set(index, mine);
      options.progress?.({ type: "start", problem, seed });
      const evalCase = await tryOne(node, problem, {
        seed,
        run,
        suite: options.suite,
        version,
        network: options.network,
        isolation: options.isolation,
        on: options.on,
        signal,
        ...(effort !== undefined ? { effort } : {}),
        ...(options.variant ? { harness: options.variant.options } : {}),
        ...(options.pins ? { pins: options.pins } : {}),
        spent: (call) => {
          addUsage(spent, call.role, call.model, call.usage);
          addUsage(mine, call.role, call.model, call.usage);
          // Spent with evals still running: they stop after their current step, so the overrun is a step's worth each.
          if (!ended && (ended = over())) stop.abort();
        },
        // (A coding agent's own calls are heard as its sandbox closes: its time bounds what it can spend before then.)
        sandboxSpent: (through) => {
          absorb(spent, through);
          absorb(mine, through);
          if (!ended && (ended = over())) stop.abort();
        },
        passedOver: (call) => {
          const key = `${call.role}\u0000${call.model}`;
          if (passedOver.has(key)) return;
          passedOver.add(key);
          options.progress?.({ type: "fallback", ...call });
        },
      }).finally(() => underway.delete(index));
      if (evalCase) {
        evals.push(evalCase);
        options.progress?.({ type: "done", evalCase });
      } else {
        if (stop.signal.aborted && !options.signal?.aborted) stopped += 1;
        options.progress?.({ type: "skipped", problem, why: stop.signal.aborted && !options.signal?.aborted ? "the budget was spent" : "stopped" });
      }
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(plan.parallel, jobs.length)) }, worker));
  const why = options.signal?.aborted ? null : (ended ?? (next < jobs.length ? noRoom() : null));
  if (why) {
    const notStarted = jobs.length - next;
    options.progress?.({ type: "spent", finished: evals.length, stopped, notStarted, why });
    return { run, evals, spent, budgetEnded: { notStarted, stopped, why } };
  }
  return { run, evals, spent };
}

/* ---------- the terminal ---------- */

const tty = process.stdout.isTTY;
const dim = (s: string) => (tty ? `\x1b[2m${s}\x1b[0m` : s);
const bold = (s: string) => (tty ? `\x1b[1m${s}\x1b[0m` : s);
const pct = (x: number) => `${(100 * x).toFixed(0)}%`;
const minutes = (s: number) => (s >= 60 ? `${Math.floor(s / 60)}m${String(s % 60).padStart(2, "0")}s` : `${s}s`);
const num = (x: number | null) => (x === null ? "—" : Number(x.toPrecision(6)).toString());

/** A hidden test or a reviewer's verdict is a check that passed or didn't; an engineering answer is a number. */
const isCheck = (a: EvalView["answers"][number]): boolean => a.units === "pass";

/**
 * A role's model that couldn't answer, said as it happened (once a run): that one answer was the other model's, measured
 * and paid as its own, and the next is asked of the role's models in order again, so the run is not that model's.
 */
export function describeFallback(over: PassedOver): string {
  return `${bold(`! ${over.model} couldn't answer as ${over.role}`)}: ${over.error.split("\n")[0]}. ${over.answered} answered in its place, and that answer is measured and paid as its own; the next is asked of the role's models in order again (said once a run).`;
}

export function describeEval(t: EvalView, detail = false, prices?: Prices): string {
  const passed = t.answers.filter((a) => a.ok).length;
  const mark = t.status === "crashed" ? "!" : t.score === 1 ? "✓" : t.score > 0 ? "△" : "✗";
  const cost = t.spent?.lines.length ? ` · ${tokensLabel(spendTotal(t.spent.lines).tokens)} tokens${spendTotal(t.spent.lines).complete ? "" : "+"}` : "";
  const head = `${mark} ${t.problem.padEnd(26)} ${t.status === "crashed" ? "crashed".padEnd(9) : `${passed}/${t.answers.length}`.padEnd(9)} ${dim(`${minutes(t.seconds)} · seed ${t.seed}${cost}`)}`;
  const lines = [head];
  for (const a of t.answers) {
    if (!detail && a.ok) continue;
    if (isCheck(a)) lines.push(dim(`      ${a.ok ? "ok    " : a.got === null ? "no run" : "failed"} ${a.key}`));
    else lines.push(dim(`      ${a.ok ? "ok " : "off"} ${a.key.padEnd(22)} got ${num(a.got).padEnd(12)} expected ${num(a.expected)} ± ${num(a.tolerance)} ${a.units}`));
  }
  if (t.note && (detail || t.status === "crashed")) lines.push(dim(`      ${t.note}`));
  if (detail && t.spent?.lines.length) {
    lines.push(dim(`      spent: ${spendLabel(t.spent.lines, prices)}`));
    for (const l of t.spent.lines) lines.push(dim(`        ${l.role.padEnd(9)} ${l.model}  ${l.calls} call${l.calls === 1 ? "" : "s"}${l.unknown ? ` (${l.unknown} unreported)` : ""} · ${tokensLabel(l.input)} in, ${tokensLabel(l.output)} out`));
  }
  return lines.join("\n");
}

export function describeIndex(evals: readonly EvalView[]): string {
  const scored = evals.filter((t) => t.status === "scored");
  const crashed = evals.length - scored.length;
  const index = evalIndex(scored.map((t) => t.score));
  const solved = scored.filter((t) => t.score === 1).length;
  return (
    `${bold(`Eval Index ${pct(index.mean)}`)} ${dim(`(90% interval ${pct(index.low)}–${pct(index.high)})`)} · ` +
    `${solved} of ${scored.length} solved outright${crashed ? ` · ${crashed} crashed (not counted)` : ""}`
  );
}

const sig = (x: number): string => (x >= 100 ? x.toFixed(0) : x >= 10 ? x.toFixed(1) : x >= 1 ? x.toFixed(2) : x.toPrecision(2));

/**
 * What the Index cost: its tokens, time and money, and the quality each bought (points per million tokens,
 * per hour, per dollar; a point is one eval solved outright), each with its 90 % interval. Empty when no
 * eval here counted its calls.
 */
export function describeCost(evals: readonly EvalView[], prices: Prices = {}): string {
  const scored = evals.filter((t) => t.status === "scored");
  const index = costIndex(scored.map((t) => costed(t, prices)));
  const ratio = (label: string, i: { mean: number; low: number; high: number; n: number } | null): string | null =>
    i ? `${sig(i.mean)} ${label} ${dim(`(${sig(i.low)}–${sig(i.high)}${i.n < scored.length ? `, ${i.n} of ${scored.length} evals` : ""})`)}` : null;
  const counted = scored.filter((t) => t.spent?.lines.length).length;
  if (!counted) return "";
  const totals = [index.tokens !== null ? `${tokensLabel(index.tokens)} tokens` : "tokens unknown", minutes(index.seconds), index.usd !== null ? usdLabel(index.usd) : "money unknown (no price, or a call unreported)"];
  const ratios = [ratio("points per million tokens", index.perMTok), ratio("per hour", index.perHour), ratio("per dollar", index.perUsd)].filter(Boolean);
  return `  ${dim("cost")} ${totals.join(" · ")}${ratios.length ? `\n  ${dim("buys")} ${ratios.join(" · ")}` : ""}`;
}

/**
 * What its "done" was worth in these evals: how often a run that ended done was found short by the grading,
 * and how often right work was left unverified or stopped. Empty where no eval has a run on record (the reviewer's cases).
 */
export function describeDone(evals: readonly EvalView[]): string {
  const report = doneReport(evals);
  return report ? `  ${dim("done")} ${doneLine(report)}` : "";
}

/**
 * The Index per effort level, and whether more compute measurably helped (the same rule as any change: its
 * interval must clear effort 1's). Empty when no run recorded an effort above 1.
 */
export function describeEffort(evals: readonly EvalView[], runs: EvalRunsView): string {
  const efforts = Object.fromEntries(Object.entries(runs).map(([run, settings]) => [run, settings.effort]));
  if (!Object.values(efforts).some((e) => e > 1)) return "";
  const report = effortReport(evals, efforts);
  return [
    `${bold("By effort")} ${dim("(attempts per eval; the reviewer takes one on the evidence before anything is graded)")}`,
    ...report.levels.map((l) => `  effort ${l.effort}   ${pct(l.mean).padStart(4)}  ${dim(`90% interval ${pct(l.low)}–${pct(l.high)} · ${l.n} eval${l.n === 1 ? "" : "s"} in ${l.runs} run${l.runs === 1 ? "" : "s"}`)}`),
    `  ${report.verdict}`,
  ].join("\n");
}

/** A budget in words. */
export const budgetLabel = (b: EvalBudget): string => [b.tokens !== undefined ? `${tokensLabel(b.tokens)} tokens` : "", b.usd !== undefined ? usdLabel(b.usd) : ""].filter(Boolean).join(" and ") || "none";

/** An estimate in words: what it rests on, or that nothing is known. */
export function estimateLabel(e: RunEstimate): string {
  if (e.tokens === null) return "what it will cost is unknown: none of these problems has been tried with its calls counted";
  return `going by past runs it will cost about ${tokensLabel(e.tokens)} tokens${e.usd !== null ? ` (${usdLabel(e.usd)})` : ""}${e.known < e.of ? `, known for ${e.known} of its ${e.of} evals and assumed alike for the rest` : ""}`;
}

export async function evalRunFromCli(node: NodeClient, options: Omit<EvalRunOptions, "signal" | "progress">, where = "in the Lab"): Promise<RunResult> {
  const controller = new AbortController();
  const onInterrupt = (): void => {
    controller.abort();
    process.stderr.write(dim("\n[stopping: running evals end after their current step and aren't recorded; Ctrl-C again to quit now]\n"));
    process.once("SIGINT", () => process.exit(130));
  };
  process.once("SIGINT", onInterrupt);
  const total = options.problems.length * options.repeat;
  try {
    const result = await runEvals(node, {
      ...options,
      signal: controller.signal,
      progress: (event) => {
        if (event.type === "plan") {
          const held = [
            options.variant ? `variant ${options.variant.name} (${describeVariant(options.variant.options)})` : "",
            ...Object.entries(options.pins ?? {}).map(([role, model]) => `${role} held to ${model}`),
          ].filter(Boolean);
          console.log(
            dim(
              `[${total} eval(s) from the ${options.suite} suite, ${event.parallel} at a time (${event.why})${event.effort ? `, effort ${event.effort}${event.effort > 1 ? `: ${event.effort} attempts each, ${total * (event.effort - 1)} extra attempts in all` : ""}` : ""}, ${where} · network ${options.network} · revision ${primaryRevision()}]` +
                (held.length ? `\n[${held.join(" · ")}]` : ""),
            ),
          );
        } else if (event.type === "budget") {
          console.log(dim(`[budget ${budgetLabel(event.budget)}${event.byDefault ? " (the default: --budget to set your own)" : ""} · ${estimateLabel(event.estimate)}]\n`));
        } else if (event.type === "start") console.log(dim(`… ${event.problem.id} (seed ${event.seed})`));
        else if (event.type === "fallback") console.log(describeFallback(event));
        else if (event.type === "done") console.log(describeEval(event.evalCase));
        else if (event.type === "spent") {
          console.log(`\n${bold("■ Stopped at the budget:")} ${event.why}. ${event.finished} eval(s) finished and recorded${event.stopped ? `, ${event.stopped} stopped mid-way (not recorded)` : ""}${event.notStarted ? `, ${event.notStarted} not started` : ""}.`);
        }
      },
    });
    const { run, evals, spent } = result;
    if (evals.length) {
      const said = [describeCost(evals, options.prices), describeDone(evals)].filter(Boolean);
      console.log(`\n${describeIndex(evals)}${said.length ? `\n${said.join("\n")}` : ""}\n${dim(`run ${run} · invincible evals · invincible eval ${run}`)}`);
    }
    if (spent.length) console.log(dim(`spent in all: ${spendLabel(spent, options.prices)}`));
    return result;
  } finally {
    process.off("SIGINT", onInterrupt);
  }
}

/** The problems a run would pose: all of a suite, or those named (by id or domain). */
export function chooseProblems(suite: string, names: readonly string[]): EvalProblem[] {
  const all = SUITES[suite];
  if (!all) throw new Error(`no eval suite "${suite}" (there is: ${Object.keys(SUITES).join(", ")})`);
  if (!names.length) return [...all];
  const chosen = all.filter((p) => names.includes(p.id) || names.includes(p.domain));
  const unknown = names.filter((n) => !all.some((p) => p.id === n || p.domain === n));
  if (unknown.length) throw new Error(`no such problem or domain: ${unknown.join(", ")} (invincible eval problems lists them)`);
  return chosen;
}
