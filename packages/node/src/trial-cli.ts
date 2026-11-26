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
  galahadIndex,
  type HarnessOptions,
  mergeSpend,
  type Prices,
  type SandboxNetwork,
  spendLabel,
  spendTotal,
  tokensLabel,
  type TrialPins,
  type TrialRecord,
  type TrialRunsView,
  type TrialVariant,
  type TrialView,
  type Usage,
  type UsageLine,
  usdLabel,
} from "@galahad/core";
import { grade, pose, type QuestOutcome, SUITES, TRIAL_EVIDENCE, TRIAL_INSTRUCTIONS, type TrialProblem } from "@galahad/brain";
import { CLAUDE_CODE_IMAGE } from "@galahad/sandbox";
import { type DoOptions, type NodeClient, runNodeQuest } from "./quest-cli.ts";

/*
 * `galahad trial run`: each problem is posed with fresh random parameters, solved as
 * an ordinary quest in the Lab (models only, no internet: nothing to look up), graded
 * here against the exact answers, and recorded in the mind. The Galahad Index is the
 * mean score of a run, with a bootstrap interval.
 *
 * Trials run in parallel across the fleet's free slots, and a run may spend effort: each
 * trial then makes that many attempts, the reviewer takes one on the evidence, and only
 * that one's answers are graded (the grader never tells the reviewer which was right).
 * A run records its effort, so the Index per effort level says, with its interval,
 * whether more compute made him more capable.
 *
 * A run also records what else was held fixed or switched (a role pinned to one model, a
 * named variant of the harness), counts what every model call cost as the providers
 * reported it, and keeps to a budget: it says before it starts roughly what it will
 * cost from past runs of the same problems, and stops cleanly when the budget is spent.
 */

/** What one trial of something needs from the run it belongs to. */
export interface TrialJob {
  seed: number;
  run: string;
  suite: string;
  version: string;
  network: SandboxNetwork;
  isolation?: "container" | "vm";
  on?: string;
  signal?: AbortSignal;
  effort?: EffortLevel;
  /** The harness switches of the run's variant (absent: as trials have always run). */
  harness?: HarnessOptions;
  /** Roles held to one model. */
  pins?: TrialPins;
  /** Every model call as it ends (the run's budget counts them as they come). */
  spent?(call: { role: string; model: string; usage: Usage | null }): void;
  /** What a sandbox's own calls through the gateway came to (a coding agent's), as it closes: counted like any. */
  sandboxSpent?(lines: UsageLine[]): void;
  /** A role's model that couldn't answer, and the one that answered in its place (a trial's quest says it once). */
  passedOver?(call: PassedOver): void;
}

/** Lines folded into a count kept as it goes, in place. */
export const absorb = (into: UsageLine[], lines: readonly UsageLine[]): void => void into.splice(0, into.length, ...mergeSpend(into, lines));

/** How long a coding tool has for a trial's work: the time a run takes, not a limit that decides it. */
export const AGENT_TRIAL_MINUTES = 60;

/**
 * A coding tool the workshop image hasn't got, in an image made for trials alone (sandbox/claude-code): a run puts it to
 * the same tasks as his own loop, on the same model, through the gateway. A knight's VM never gets it from Galahad.
 */
export const TRIAL_IMAGES: Readonly<Record<string, string>> = { claude: CLAUDE_CODE_IMAGE };

/** A model of a role's that couldn't answer, why, and which one answered instead. */
export interface PassedOver {
  role: string;
  model: string;
  error: string;
  answered: string;
}

/** A trial's quest tells its run which models were passed over (the run says each once). */
export const tellPassedOver =
  (job: Pick<TrialJob, "passedOver">) =>
  (event: { type: string; role?: string; model?: string; error?: string; answered?: string }): void => {
    if (event.type === "skipped" && event.role && event.model && event.answered) job.passedOver?.({ role: event.role, model: event.model, error: event.error ?? "", answered: event.answered });
  };

/**
 * Something a run can try: a problem of a suite that isn't the engineering one (an agentic task with hidden
 * tests, a case put to the reviewer). It poses itself from the seed, does the work through the node, grades
 * it by program, and hands back the record; the run adds what it spent and records it. Null: you stopped it.
 */
export interface TrialUnit {
  id: string;
  title: string;
  domain: string;
  /** Tokens one trial of it may be expected to cost when nothing is known from past runs (null: say unknown). */
  attempt(node: NodeClient, job: TrialJob): Promise<TrialRecord | null>;
}

export type Tryable = TrialProblem | TrialUnit;
const isUnit = (p: Tryable): p is TrialUnit => typeof (p as TrialUnit).attempt === "function";

export interface TrialBudget {
  /** Tokens in and out together, as the providers report them. */
  tokens?: number;
  /** US dollars, at your prices (needs a price for every model that answers). */
  usd?: number;
}

export interface TrialRunOptions {
  suite: string;
  problems: readonly Tryable[];
  /** The same seed poses the same problem (default: a fresh one per trial). */
  seed?: number;
  repeat: number;
  /** How many trials at once; "auto": as many as the free slots carry at this effort. */
  parallel: number | "auto";
  /** Attempts per trial (the run records it). Left out: one, and nothing about effort is recorded or asked. */
  effort?: EffortLevel;
  /** The harness as this run switches it (its effort is the run's). */
  variant?: TrialVariant;
  /** Roles held to one model for the whole run. */
  pins?: TrialPins;
  /** Runs made to be compared (an A/B's two, a sweep's candidates) share this. */
  group?: string;
  /** What the run may spend. Left out: DEFAULT_TOKENS_PER_ATTEMPT for every attempt it would make. */
  budget?: TrialBudget;
  /** Your prices: what a money budget counts with. */
  prices?: Prices;
  /** The run's id (default: a fresh one). */
  run?: string;
  network: SandboxNetwork;
  isolation?: "container" | "vm";
  on?: string;
  signal?: AbortSignal;
  /** As each trial starts and ends. */
  progress?(
    event:
      | { type: "start"; problem: Tryable; seed: number }
      | { type: "done"; trial: TrialView }
      | { type: "skipped"; problem: Tryable; why: string }
      /** A role's model couldn't answer and another did: what is measured, and paid for, is the one that answered. Once for each. */
      | ({ type: "fallback" } & PassedOver)
      /** How the run will go: trials at once, and why (the slots there are). */
      | { type: "plan"; parallel: number; effort: EffortLevel | null; why: string }
      /** Before the first trial: the budget, and roughly what the run will cost going by past runs of the same problems. */
      | { type: "budget"; budget: TrialBudget; byDefault: boolean; estimate: RunEstimate }
      /** The budget is spent: what was finished, and what wasn't started or was stopped. */
      | { type: "spent"; finished: number; stopped: number; notStarted: number; why: string },
  ): void;
}

/** Tokens one attempt at a trial is allowed for when you name no budget: a guard against a runaway, not a forecast. */
export const DEFAULT_TOKENS_PER_ATTEMPT = 600_000;

/**
 * How many trials run at once: no more than the fleet's sandbox slots carry at this effort (what's asked for
 * beyond that would only wait in the queue until it gave up). With "auto", what's free now. A fleet whose
 * slots can't carry one trial at the effort asked can't measure it, and says so.
 */
export function planParallel(census: Pick<ComputeView, "nodes"> | null, asked: number | "auto", effort: number, jobs: number, on?: string): { parallel: number; why: string } {
  const fallback = Math.max(1, Math.min(asked === "auto" ? 3 : asked, jobs));
  if (!census) return { parallel: fallback, why: "the node doesn't say what it carries" };
  const hosts = census.nodes.filter((n) => (on ? n.name === on || n.id === on : n.online) && (n.capacity?.sandboxes ?? 0) > 0);
  const slots = hosts.reduce((sum, n) => sum + n.capacity!.sandboxes, 0);
  const free = hosts.reduce((sum, n) => sum + (n.free ?? 0), 0);
  const where = on ?? (hosts.length === 1 ? hosts[0]!.name : "the fleet");
  if (slots < effort) throw new Error(`${where} carries ${slots} sandbox${slots === 1 ? "" : "es"} at once: effort ${effort} can't be measured there (galahad compute)`);
  const most = Math.max(1, Math.floor(slots / effort));
  if (asked === "auto") {
    const now = Math.max(1, Math.min(most, Math.floor(free / effort) || 1, jobs, 8));
    return { parallel: now, why: `${free} of ${slots} slots free on ${where}${effort > 1 ? `, ${effort} attempts a trial` : ""}` };
  }
  const parallel = Math.max(1, Math.min(asked, most, jobs));
  return { parallel, why: parallel < Math.min(asked, jobs) ? `${where} carries ${slots} slots${effort > 1 ? `, ${effort} attempts a trial` : ""}: ${parallel} at once, not ${asked}` : `${slots} slots on ${where}` };
}

export { galahadRevision } from "./revision.ts";
import { galahadRevision } from "./revision.ts";

const freshSeed = (): number => crypto.getRandomValues(new Uint32Array(1))[0]!;

/** A run's id: when it started (the Index is computed per run). */
/**
 * When it began, and four characters of chance, never an id this process made before: two runs begun in the same
 * millisecond (a sweep's or an A/B's, one that had no room for a trial) are two runs, not one recorded twice.
 */
const madeRuns = new Set<string>();
export function freshRunId(): string {
  for (;;) {
    const id = `r-${Date.now().toString(36)}${(crypto.getRandomValues(new Uint32Array(1))[0]! % 36 ** 4).toString(36).padStart(4, "0")}`;
    if (!madeRuns.has(id)) return (madeRuns.add(id), id);
  }
}

/**
 * Why a trial's quest measured nothing, when no model of it ever answered: it gave up before a single step, and no
 * model said a word (a coding tool whose every call its gateway refused, a plan's allowance spent). Null otherwise.
 * On 21 November 2026 four OpenCode trials were scored 0 so, in fifteen seconds each, the plan's allowance spent.
 */
export function nothingAnswered(outcome: Pick<QuestOutcome, "status" | "steps" | "summary">, models: ReadonlySet<string>): string | null {
  if (outcome.status !== "gave-up" || outcome.steps > 0 || models.size > 0) return null;
  return `no model answered, so nothing was measured: ${outcome.summary.split("\n").find((line) => line.trim())?.trim().slice(0, 400) ?? "(no reason given)"}`;
}

/** The harness switches as a quest's options (a task's own gates are the caller's to add). */
export function harnessOptions(job: Pick<TrialJob, "harness" | "pins" | "effort">): Partial<DoOptions> {
  const h = job.harness;
  return {
    ...(job.effort !== undefined ? { effort: job.effort } : {}),
    ...(job.pins && Object.keys(job.pins).length ? { pins: job.pins } : {}),
    ...(h ? { proposeGates: h.plannerGates, offerSkills: h.skills, archive: h.archive, maxRevisions: h.revisions } : {}),
    ...(h?.engram ? { engram: true } : {}),
    // A trial escalates only when its variant says so: a run without one is measured as trials always were.
    escalate: h?.escalate ?? false,
    // Nor are its constraints said again unless its variant says so, nor its file reads kept whole, nor a contract written first.
    ...(h?.remind ? { remind: true } : {}),
    ...(h?.keepReads ? { keepReads: true } : {}),
    ...(h?.tools ? { tools: true } : {}),
    ...(h?.contract ? { contract: true } : {}),
    // A coding tool doing the work, and without the planner or the reviewer: a bare tool, as a person runs it.
    ...(h?.agent ? { agent: { name: h.agent, minutes: AGENT_TRIAL_MINUTES, ...(TRIAL_IMAGES[h.agent] ? { image: TRIAL_IMAGES[h.agent] } : {}) } } : {}),
    ...(h && !h.planner ? { plan: "" } : {}),
    ...(h && !h.review ? { unreviewed: true } : {}),
  };
}

/** A run is measured at one effort: a trial the node couldn't give it to says nothing about that level. */
export const heldToEffort =
  (effort: EffortLevel | undefined) =>
  (event: { type: string; grant?: { attempts: number; reasons: string[] } }): void => {
    if (event.type === "granted" && effort !== undefined && event.grant && event.grant.attempts !== effort) {
      throw new Error(`the node granted ${event.grant.attempts} attempt(s), not the run's ${effort}: ${event.grant.reasons.join(" ")}`);
    }
  };

/** One engineering trial: pose, solve as a quest, grade. The record, or null when you stopped it. */
async function solveProblem(node: NodeClient, problem: TrialProblem, job: TrialJob): Promise<TrialRecord | null> {
  const { seed } = job;
  const posed = pose(problem, seed);
  const models = new Set<string>();
  const started = Date.now();
  const base = { run: job.run, suite: job.suite, problem: problem.id, title: problem.title, domain: problem.domain, seed, version: job.version };
  try {
    let answer: string | null = null;
    const { outcome, artifact } = await runNodeQuest(
      node,
      {
        goal: posed.goal,
        network: job.network,
        lab: true,
        ...(job.isolation ? { isolation: job.isolation } : {}),
        ...(job.on ? { on: job.on } : {}),
        ...(problem.budget?.maxSteps ? { maxSteps: problem.budget.maxSteps } : {}),
        ...(problem.budget?.commandTimeoutSec ? { commandTimeoutSec: problem.budget.commandTimeoutSec } : {}),
        instructions: TRIAL_INSTRUCTIONS,
        evidence: TRIAL_EVIDENCE,
        label: `Trial ${problem.id} (seed ${seed})`,
        remember: false,
        trial: true,
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
    // Nor does work no model ever answered: a crash, not a 0 (trial-agentic nothingAnswered).
    const unanswered = nothingAnswered(outcome, models);
    if (unanswered) throw new Error(unanswered);
    const graded = grade(posed.expected, answer);
    return {
      ...base,
      status: "scored",
      score: graded.score,
      answers: graded.answers,
      quest: { status: outcome.status, steps: outcome.steps, revisions: outcome.revisions },
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

/** What a trial spent, as a record carries it: the heaviest lines first, within what a record holds. */
const MAX_LINES = 24;
function spentLines(lines: readonly UsageLine[]): UsageLine[] {
  return [...lines].sort((a, b) => b.input + b.output - (a.input + a.output) || b.calls - a.calls).slice(0, MAX_LINES);
}

/** One trial of anything a run can try: done through the node, graded by program, recorded with what it spent. Null when you stopped it. */
export async function tryOne(node: NodeClient, problem: Tryable, job: TrialJob): Promise<TrialView | null> {
  const lines: UsageLine[] = [];
  const counted: TrialJob = {
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
  return (await node.call<{ trial: TrialView }>("recordTrial", { ...record, ...(lines.length ? { spent: spentLines(lines) } : {}) })).trial;
}

/** One engineering trial: pose, solve as a quest, grade, record. Null when you stopped it. */
export function runTrial(node: NodeClient, job: Omit<TrialJob, "spent" | "harness" | "pins"> & { problem: TrialProblem } & Pick<Partial<TrialJob>, "spent" | "harness" | "pins">): Promise<TrialView | null> {
  const { problem, ...rest } = job;
  return tryOne(node, problem, rest);
}

/* ---------- what a run will cost, going by the past ---------- */

export interface RunEstimate {
  /** Tokens for the whole run, going by past trials of the same problems (null: none of them has been tried with counting). */
  tokens: number | null;
  /** The same in money, when those past trials were all priced. */
  usd: number | null;
  /** How many of the run's trials the estimate rests on past trials of the same problem for. */
  known: number;
  of: number;
}

/** A trial's tokens when all of its calls were counted, else null. */
const tokensOf = (t: Pick<TrialView, "spent">): number | null => {
  if (!t.spent?.lines.length) return null;
  const total = spendTotal(t.spent.lines);
  return total.complete ? total.tokens : null;
};

/**
 * Roughly what a run would cost: for each problem, the mean of its past scored trials at the same effort
 * (their tokens as the providers reported them); a problem never tried with counting goes by the mean of the
 * others. Nothing known at all: it says so rather than guess.
 */
export function estimateRun(past: readonly TrialView[], problems: readonly { id: string }[], repeat: number, effort: number, efforts: Readonly<Record<string, number>>, prices: Prices = {}): RunEstimate {
  const perProblem = (id: string): { tokens: number; usd: number | null } | null => {
    const same = past.filter((t) => t.problem === id && t.status === "scored" && tokensOf(t) !== null);
    const atEffort = same.filter((t) => (efforts[t.run] ?? 1) === effort);
    // Past trials at another effort still say something: an attempt's worth, times this run's attempts.
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
  trials: TrialView[];
  /** Everything the run's model calls came to, stopped trials included. */
  spent: UsageLine[];
  /** Set when the budget ended the run: what wasn't started, and what was stopped mid-way (and so not recorded). */
  budgetEnded?: { notStarted: number; stopped: number; why: string };
}

/** A run: every problem (repeated), a few at a time, within its budget. */
export async function runTrials(node: NodeClient, options: TrialRunOptions): Promise<RunResult> {
  const run = options.run ?? freshRunId();
  const version = galahadRevision();
  const jobs = options.problems.flatMap((problem) =>
    Array.from({ length: options.repeat }, (_, i) => ({ problem, seed: options.seed === undefined ? freshSeed() : (options.seed + i) >>> 0 })),
  );
  const trials: TrialView[] = [];
  // A variant's effort is the run's (a run is measured at one level).
  const effort = options.variant ? options.variant.options.effort : options.effort;
  // Across the slots there are: with effort (or "auto"), the node says what it carries; otherwise as asked.
  const census = effort !== undefined || options.parallel === "auto" ? await node.call<ComputeView>("compute").catch(() => null) : null;
  const asked = effort !== undefined || options.parallel === "auto" ? planParallel(census, options.parallel, effort ?? 1, jobs.length, options.on) : { parallel: options.parallel as number, why: "as asked" };

  // The budget: yours, or an allowance for every attempt the run would make. And roughly what it will cost.
  const prices = options.prices ?? {};
  const byDefault = options.budget?.tokens === undefined && options.budget?.usd === undefined;
  const budget: TrialBudget = byDefault ? { tokens: jobs.length * (effort ?? 1) * DEFAULT_TOKENS_PER_ATTEMPT } : options.budget!;
  const past = await node.call<{ trials: TrialView[]; runs?: TrialRunsView }>("trials").catch(() => null);
  const pastEfforts = Object.fromEntries(Object.entries(past?.runs ?? {}).map(([r, s]) => [r, s.effort]));
  const estimate = estimateRun(past?.trials ?? [], options.problems, options.repeat, effort ?? 1, pastEfforts, prices);
  // Trials no past run has priced, under a budget short of twice what the run is expected to cost, run one at a time: a
  // stop at the budget then cuts one short and keeps those before it, never every one under way. (21 November 2026: four
  // at once, two of them never tried and dearer than the rest, spent $2.03 of a $2 budget, and none was recorded.)
  const tight = (limit: number | undefined, expected: number | null): boolean => limit !== undefined && (expected === null || expected * 2 > limit);
  const guessing = !byDefault && estimate.known < estimate.of && (tight(budget.usd, estimate.usd) || tight(budget.tokens, estimate.tokens));
  const plan = guessing && asked.parallel > 1 ? { parallel: 1, why: "some have never been tried, and the budget is close to what they're expected to cost: a stop at it cuts one short, not all" } : asked;
  options.progress?.({ type: "plan", parallel: Math.max(1, Math.min(plan.parallel, jobs.length)), effort: effort ?? null, why: plan.why });
  options.progress?.({ type: "budget", budget, byDefault, estimate });

  // The run's settings are on record before its first trial, so its trials can be told apart by them.
  const recorded = effort !== undefined || options.variant || options.pins || options.group || !byDefault;
  if (recorded) {
    await node.call("startTrialRun", {
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
      if (cost.unpriced.length) return `a money budget needs a price for every model that answers, and there's none for ${cost.unpriced.join(", ")} (galahad price set …)`;
      if (cost.usd >= budget.usd) return `the budget of ${usdLabel(budget.usd)} is spent (${usdLabel(cost.usd)} counted)`;
    }
    return null;
  };
  // Your budget isn't spent on trials it can't be expected to see through: one stopped mid-way is paid for and not
  // recorded. Going by past runs, a trial starts only while what's spent, what the trials under way are still expected
  // to spend, and what it is expected to cost fit the budget. (Nothing known of the past, or no budget of yours: as
  // many as there are slots, and the budget's stop below.)
  const each = { tokens: estimate.tokens === null ? null : estimate.tokens / estimate.of, usd: estimate.usd === null ? null : estimate.usd / estimate.of };
  const underway = new Map<number, UsageLine[]>();
  const ahead = (cost: (lines: UsageLine[]) => number, per: number): number => [...underway.values()].reduce((s, lines) => s + Math.max(0, per - cost(lines)), 0);
  const noRoom = (): string | null => {
    if (byDefault) return null;
    if (budget.tokens !== undefined && each.tokens !== null && spendTotal(spent).tokens + ahead((l) => spendTotal(l).tokens, each.tokens) + each.tokens > budget.tokens)
      return `${tokensLabel(Math.max(0, budget.tokens - spendTotal(spent).tokens))} tokens of the budget are left, and a trial takes about ${tokensLabel(each.tokens)} going by past runs`;
    if (budget.usd !== undefined && each.usd !== null && costOf(spent, prices).usd + ahead((l) => costOf(l, prices).usd, each.usd) + each.usd > budget.usd)
      return `${usdLabel(Math.max(0, budget.usd - costOf(spent, prices).usd))} of the budget is left, and a trial costs about ${usdLabel(each.usd)} going by past runs`;
    return null;
  };
  // The budget's own stop: running trials end after their current step (unrecorded), and none starts.
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
      // (No room for another: this slot closes, and one still running looks again when its trial ends.)
      if (noRoom()) break;
      const index = next++;
      const { problem, seed } = jobs[index]!;
      const mine: UsageLine[] = [];
      underway.set(index, mine);
      options.progress?.({ type: "start", problem, seed });
      const trial = await tryOne(node, problem, {
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
          // Spent with trials still running: they stop after their current step, so the overrun is a step's worth each.
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
      if (trial) {
        trials.push(trial);
        options.progress?.({ type: "done", trial });
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
    options.progress?.({ type: "spent", finished: trials.length, stopped, notStarted, why });
    return { run, trials, spent, budgetEnded: { notStarted, stopped, why } };
  }
  return { run, trials, spent };
}

/* ---------- the terminal ---------- */

const tty = process.stdout.isTTY;
const dim = (s: string) => (tty ? `\x1b[2m${s}\x1b[0m` : s);
const bold = (s: string) => (tty ? `\x1b[1m${s}\x1b[0m` : s);
const pct = (x: number) => `${(100 * x).toFixed(0)}%`;
const minutes = (s: number) => (s >= 60 ? `${Math.floor(s / 60)}m${String(s % 60).padStart(2, "0")}s` : `${s}s`);
const num = (x: number | null) => (x === null ? "—" : Number(x.toPrecision(6)).toString());

/** A hidden test or a reviewer's verdict is a check that passed or didn't; an engineering answer is a number. */
const isCheck = (a: TrialView["answers"][number]): boolean => a.units === "pass";

/**
 * A role's model that couldn't answer, said as it happened (once a run): that one answer was the other model's, measured
 * and paid as its own, and the next is asked of the role's models in order again, so the run is not that model's.
 */
export function describeFallback(over: PassedOver): string {
  return `${bold(`! ${over.model} couldn't answer as ${over.role}`)}: ${over.error.split("\n")[0]}. ${over.answered} answered in its place, and that answer is measured and paid as its own; the next is asked of the role's models in order again (said once a run).`;
}

export function describeTrial(t: TrialView, detail = false, prices?: Prices): string {
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

export function describeIndex(trials: readonly TrialView[]): string {
  const scored = trials.filter((t) => t.status === "scored");
  const crashed = trials.length - scored.length;
  const index = galahadIndex(scored.map((t) => t.score));
  const solved = scored.filter((t) => t.score === 1).length;
  return (
    `${bold(`Galahad Index ${pct(index.mean)}`)} ${dim(`(90% interval ${pct(index.low)}–${pct(index.high)})`)} · ` +
    `${solved} of ${scored.length} solved outright${crashed ? ` · ${crashed} crashed (not counted)` : ""}`
  );
}

const sig = (x: number): string => (x >= 100 ? x.toFixed(0) : x >= 10 ? x.toFixed(1) : x >= 1 ? x.toFixed(2) : x.toPrecision(2));

/**
 * What the Index cost: its tokens, time and money, and the quality each bought (points per million tokens,
 * per hour, per dollar; a point is one trial solved outright), each with its 90 % interval. Empty when no
 * trial here counted its calls.
 */
export function describeCost(trials: readonly TrialView[], prices: Prices = {}): string {
  const scored = trials.filter((t) => t.status === "scored");
  const index = costIndex(scored.map((t) => costed(t, prices)));
  const ratio = (label: string, i: { mean: number; low: number; high: number; n: number } | null): string | null =>
    i ? `${sig(i.mean)} ${label} ${dim(`(${sig(i.low)}–${sig(i.high)}${i.n < scored.length ? `, ${i.n} of ${scored.length} trials` : ""})`)}` : null;
  const counted = scored.filter((t) => t.spent?.lines.length).length;
  if (!counted) return "";
  const totals = [index.tokens !== null ? `${tokensLabel(index.tokens)} tokens` : "tokens unknown", minutes(index.seconds), index.usd !== null ? usdLabel(index.usd) : "money unknown (no price, or a call unreported)"];
  const ratios = [ratio("points per million tokens", index.perMTok), ratio("per hour", index.perHour), ratio("per dollar", index.perUsd)].filter(Boolean);
  return `  ${dim("cost")} ${totals.join(" · ")}${ratios.length ? `\n  ${dim("buys")} ${ratios.join(" · ")}` : ""}`;
}

/**
 * What his "done" was worth in these trials: how often a quest that ended done was found short by the grading,
 * and how often right work was left unverified or stopped. Empty where no trial has a quest on record (the reviewer's cases).
 */
export function describeDone(trials: readonly TrialView[]): string {
  const report = doneReport(trials);
  return report ? `  ${dim("done")} ${doneLine(report)}` : "";
}

/**
 * The Index per effort level, and whether more compute measurably helped (the same rule as any change: its
 * interval must clear effort 1's). Empty when no run recorded an effort above 1.
 */
export function describeEffort(trials: readonly TrialView[], runs: TrialRunsView): string {
  const efforts = Object.fromEntries(Object.entries(runs).map(([run, settings]) => [run, settings.effort]));
  if (!Object.values(efforts).some((e) => e > 1)) return "";
  const report = effortReport(trials, efforts);
  return [
    `${bold("By effort")} ${dim("(attempts per trial; the reviewer takes one on the evidence before anything is graded)")}`,
    ...report.levels.map((l) => `  effort ${l.effort}   ${pct(l.mean).padStart(4)}  ${dim(`90% interval ${pct(l.low)}–${pct(l.high)} · ${l.n} trial${l.n === 1 ? "" : "s"} in ${l.runs} run${l.runs === 1 ? "" : "s"}`)}`),
    `  ${report.verdict}`,
  ].join("\n");
}

/** A budget in words. */
export const budgetLabel = (b: TrialBudget): string => [b.tokens !== undefined ? `${tokensLabel(b.tokens)} tokens` : "", b.usd !== undefined ? usdLabel(b.usd) : ""].filter(Boolean).join(" and ") || "none";

/** An estimate in words: what it rests on, or that nothing is known. */
export function estimateLabel(e: RunEstimate): string {
  if (e.tokens === null) return "what it will cost is unknown: none of these problems has been tried with its calls counted";
  return `going by past runs it will cost about ${tokensLabel(e.tokens)} tokens${e.usd !== null ? ` (${usdLabel(e.usd)})` : ""}${e.known < e.of ? `, known for ${e.known} of its ${e.of} trials and assumed alike for the rest` : ""}`;
}

export async function trialRunFromCli(node: NodeClient, options: Omit<TrialRunOptions, "signal" | "progress">, where = "in the Lab"): Promise<RunResult> {
  const controller = new AbortController();
  const onInterrupt = (): void => {
    controller.abort();
    process.stderr.write(dim("\n[stopping: running trials end after their current step and aren't recorded; Ctrl-C again to quit now]\n"));
    process.once("SIGINT", () => process.exit(130));
  };
  process.once("SIGINT", onInterrupt);
  const total = options.problems.length * options.repeat;
  try {
    const result = await runTrials(node, {
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
              `[${total} trial(s) from the ${options.suite} suite, ${event.parallel} at a time (${event.why})${event.effort ? `, effort ${event.effort}${event.effort > 1 ? `: ${event.effort} attempts each, ${total * (event.effort - 1)} extra attempts in all` : ""}` : ""}, ${where} · network ${options.network} · revision ${galahadRevision()}]` +
                (held.length ? `\n[${held.join(" · ")}]` : ""),
            ),
          );
        } else if (event.type === "budget") {
          console.log(dim(`[budget ${budgetLabel(event.budget)}${event.byDefault ? " (the default: --budget to set your own)" : ""} · ${estimateLabel(event.estimate)}]\n`));
        } else if (event.type === "start") console.log(dim(`… ${event.problem.id} (seed ${event.seed})`));
        else if (event.type === "fallback") console.log(describeFallback(event));
        else if (event.type === "done") console.log(describeTrial(event.trial));
        else if (event.type === "spent") {
          console.log(`\n${bold("■ Stopped at the budget:")} ${event.why}. ${event.finished} trial(s) finished and recorded${event.stopped ? `, ${event.stopped} stopped mid-way (not recorded)` : ""}${event.notStarted ? `, ${event.notStarted} not started` : ""}.`);
        }
      },
    });
    const { run, trials, spent } = result;
    if (trials.length) {
      const said = [describeCost(trials, options.prices), describeDone(trials)].filter(Boolean);
      console.log(`\n${describeIndex(trials)}${said.length ? `\n${said.join("\n")}` : ""}\n${dim(`run ${run} · galahad trials · galahad trial ${run}`)}`);
    }
    if (spent.length) console.log(dim(`spent in all: ${spendLabel(spent, options.prices)}`));
    return result;
  } finally {
    process.off("SIGINT", onInterrupt);
  }
}

/** The problems a run would pose: all of a suite, or those named (by id or domain). */
export function chooseProblems(suite: string, names: readonly string[]): TrialProblem[] {
  const all = SUITES[suite];
  if (!all) throw new Error(`no trial suite "${suite}" (there is: ${Object.keys(SUITES).join(", ")})`);
  if (!names.length) return [...all];
  const chosen = all.filter((p) => names.includes(p.id) || names.includes(p.domain));
  const unknown = names.filter((n) => !all.some((p) => p.id === n || p.domain === n));
  if (unknown.length) throw new Error(`no such problem or domain: ${unknown.join(", ")} (galahad trial problems lists them)`);
  return chosen;
}
