import { z } from "zod";
import { EffortLevel } from "./compute.ts";

/*
 * Trials: problems with known answers, scored by a program, never by a model.
 * A trial run hands Galahad a problem (with fresh random parameters, so a
 * remembered answer doesn't help), lets him solve it in a sandbox as he would any
 * quest, and grades the numbers he leaves in /work/out/answer.json against the
 * exact solution within a stated tolerance. The record is checkable by every
 * replica: each answer's verdict and the score follow from the numbers recorded.
 */

export const TrialId = z.string().regex(/^tr_[A-Za-z0-9_-]{22}$/);
/** Trials started together (one `galahad trial run`) share a run id: the Galahad Index is computed per run. */
export const TrialRunId = z.string().regex(/^r-[a-z0-9]{1,16}$/);
const Slug = z.string().regex(/^[a-z0-9][a-z0-9-]{0,59}$/);

export const TrialAnswer = z.strictObject({
  key: z.string().regex(/^[a-z][a-z0-9_]{0,39}$/),
  units: z.string().max(20),
  expected: z.number(),
  /** What Galahad answered (null: missing or not a number). */
  got: z.number().nullable(),
  /** Absolute: |got − expected| ≤ tolerance passes. */
  tolerance: z.number().min(0),
  ok: z.boolean(),
});
export type TrialAnswer = z.infer<typeof TrialAnswer>;

export const TrialRecord = z.strictObject({
  run: TrialRunId,
  suite: Slug,
  problem: Slug,
  title: z.string().min(1).max(200),
  domain: Slug,
  /** The parameters' seed: the same seed is the same problem. */
  seed: z.number().int().min(0).max(0xffffffff),
  /** scored: graded; crashed: the run itself failed (no sandbox, no model…), which says nothing about ability. */
  status: z.enum(["scored", "crashed"]),
  score: z.number().min(0).max(1),
  answers: z.array(TrialAnswer).max(16),
  quest: z
    .strictObject({ status: z.enum(["done", "unverified", "gave-up", "stopped"]), steps: z.number().int().min(0), revisions: z.number().int().min(0) })
    .optional(),
  /** The models that did the work (planner, engineer, reviewer as they answered). */
  models: z.array(z.string().max(120)).max(8),
  /** Galahad's revision that ran it. */
  version: z.string().max(64),
  seconds: z.number().int().min(0),
  artifact: z.string().regex(/^art_[A-Za-z0-9_-]{22}$/).optional(),
  note: z.string().max(1000).optional(),
});
export type TrialRecord = z.infer<typeof TrialRecord>;

/** The roles a trial's quest asks (a pin is for one of them). */
export const TRIAL_ROLES = ["planner", "engineer", "reviewer"] as const;
export type TrialRole = (typeof TRIAL_ROLES)[number];
const PinnedModel = z.string().min(3).max(256).regex(/^[A-Za-z0-9._:-]+\/\S+$/, "a pin is <role>=<provider>/<model>");
export const TrialPins = z.strictObject({ planner: PinnedModel.optional(), engineer: PinnedModel.optional(), reviewer: PinnedModel.optional() });
export type TrialPins = z.infer<typeof TrialPins>;

/**
 * The harness, as switches: what a variant turns on or off around the same models and the same tasks.
 * `gates`: a task's own gates run before the review · `plannerGates`: the planner may add its own ·
 * `effort`: attempts per trial · `skills`: his skills are offered to the planner and the engineer ·
 * `archive`: the archive's context goes with the plan · `revisions`: how many times work may be sent back ·
 * `engram`: the engineer is given the sandbox's notes store (Engram: its two commands, and how far to trust a
 * note) · `diff`: the reviewer is shown the work itself, the repository's diff, beside what was run and what the
 * tests print · `escalate`: a gate that fails twice in a row moves the rest of the work to the planner's models ·
 * `remind`: the quest's constraints (its goal, the plan's "Done when:", the gates) are said again every ten commands ·
 * `keepReads`: of the command outputs cut short to keep a quest affordable, current file reads stay whole, within a budget ·
 * `tools`: the engineer works with tools of its own (a shell, and reading, editing and writing files), several calls a
 * turn, in place of one command a reply (with keepReads, which it implies) ·
 * `contract`: where no gate fails before the work, the planner first writes one test that does, and the work must pass it ·
 * `agent`: a coding tool does the work (opencode, claude, codex), on the engineer's models through the gateway ·
 * `planner`: off, no plan is made: the goal is the whole brief · `review`: off, no independent reviewer: what passes the
 * gates (with none, the work's own word that it's done) is done. All three off is a coding tool as a person runs it.
 * A run recorded before a switch existed lacks it and reads as what it was run with: off, and the planner and the
 * reviewer on.
 */
export const HarnessOptions = z.object({
  gates: z.boolean(),
  plannerGates: z.boolean(),
  effort: EffortLevel,
  skills: z.boolean(),
  archive: z.boolean(),
  revisions: z.number().int().min(0).max(4),
  engram: z.boolean().default(false),
  diff: z.boolean().default(false),
  escalate: z.boolean().default(false),
  remind: z.boolean().default(false),
  keepReads: z.boolean().default(false),
  tools: z.boolean().default(false),
  contract: z.boolean().default(false),
  agent: z.string().regex(/^[a-z][a-z0-9-]{0,31}$/, "a coding tool's name is lowercase letters, digits and -").nullable().default(null),
  planner: z.boolean().default(true),
  review: z.boolean().default(true),
});
export type HarnessOptions = z.infer<typeof HarnessOptions>;

/** How trials are run when nothing says otherwise: what `galahad trial run` has always done, with a task's gates on. */
export const BASELINE: HarnessOptions = { gates: true, plannerGates: false, effort: 1, skills: false, archive: true, revisions: 2, engram: false, diff: false, escalate: false, remind: false, keepReads: false, tools: false, contract: false, agent: null, planner: true, review: true };

export const VariantName = z.string().regex(/^[a-z0-9][a-z0-9-]{0,39}$/, "a variant's name is lowercase letters, digits and - (max 40)");
export const TrialVariant = z.object({ name: VariantName, options: HarnessOptions });
export type TrialVariant = z.infer<typeof TrialVariant>;

/**
 * How a run was run: its effort (attempts per trial, the best taken by the reviewer on the evidence before
 * anything is graded), how many trials ran at once, and what was held fixed or switched. Read leniently from
 * the log (trial.run): what a newer node adds is left out here, never refused.
 */
export const TrialRunSettings = z.object({
  effort: EffortLevel,
  parallel: z.number().int().min(1).max(64).optional(),
  /** Roles held to one model for this run (`--pin engineer=provider/model`); every other role is the roster's. */
  pins: TrialPins.optional(),
  /** The harness options the run was made under, by name (variants A/B compare two of them on the same tasks). */
  variant: TrialVariant.optional(),
  /** The seed its first trial of each problem was posed with (a second run with the same seed poses the same tasks). */
  seed: z.number().int().min(0).max(0xffffffff).optional(),
  /** Runs made to be compared with each other (an A/B's two, a sweep's candidates) share this. */
  group: z.string().regex(/^g-[a-z0-9]{1,16}$/).optional(),
  /** What the run was allowed to spend, as it was told. */
  budget: z.object({ tokens: z.number().int().min(1).optional(), usd: z.number().min(0).optional() }).optional(),
});
export type TrialRunSettings = z.infer<typeof TrialRunSettings>;

/**
 * The variants that come named: each differs from the baseline by one switch (bare: by all of them). `contract` differs
 * from `no-gates` by one: a task that brings gates failing before the work has its contract already, so the planner's
 * is measured where a task comes without them, as most of yours do. `opencode` is no variant of Galahad's: it is
 * OpenCode alone on the engineer's models, as T3 Code runs it (no plan, no gates, no reviewer), so what Galahad's loop is
 * worth against a bare coding tool is a number (PLAN #32).
 */
export const VARIANTS: Readonly<Record<string, HarnessOptions>> = {
  baseline: BASELINE,
  "no-gates": { ...BASELINE, gates: false },
  "planner-gates": { ...BASELINE, plannerGates: true },
  "effort-2": { ...BASELINE, effort: 2 },
  "effort-3": { ...BASELINE, effort: 3 },
  skills: { ...BASELINE, skills: true },
  "no-archive": { ...BASELINE, archive: false },
  "no-revisions": { ...BASELINE, revisions: 0 },
  engram: { ...BASELINE, engram: true },
  "shown-diff": { ...BASELINE, diff: true },
  escalate: { ...BASELINE, escalate: true },
  remind: { ...BASELINE, remind: true },
  "keep-reads": { ...BASELINE, keepReads: true },
  tools: { ...BASELINE, tools: true },
  contract: { ...BASELINE, gates: false, contract: true },
  bare: { ...BASELINE, gates: false, archive: false, revisions: 0 },
  opencode: { ...BASELINE, gates: false, archive: false, revisions: 0, agent: "opencode", planner: false, review: false },
};

const ON = new Set(["on", "yes", "true", "1"]);
const OFF = new Set(["off", "no", "false", "0"]);

/**
 * A variant from its spelling: a name that comes built in (`no-gates`), or `name:switch=value,…` over the
 * baseline (`mine:gates=off,skills=on,effort=2`). Throws with what's wrong.
 */
export function parseVariant(spelling: string): TrialVariant {
  const [rawName, ...restParts] = spelling.split(":");
  const name = VariantName.parse(rawName);
  const rest = restParts.join(":").trim();
  if (!rest) {
    const options = VARIANTS[name];
    if (!options) throw new Error(`no variant "${name}" (there is: ${Object.keys(VARIANTS).join(", ")}; or define one: ${name}:gates=off,skills=on)`);
    return { name, options };
  }
  if (VARIANTS[name]) throw new Error(`"${name}" is a variant that comes built in: give yours another name`);
  const options: Record<string, unknown> = { ...BASELINE };
  for (const pair of rest.split(",")) {
    const [key, value = ""] = pair.split("=").map((s) => s.trim());
    const flag = (): boolean => {
      if (ON.has(value)) return true;
      if (OFF.has(value)) return false;
      throw new Error(`${key} is on or off, not "${value}"`);
    };
    if (key === "gates" || key === "skills" || key === "archive" || key === "engram" || key === "diff" || key === "escalate" || key === "remind" || key === "contract" || key === "planner" || key === "review") options[key] = flag();
    else if (key === "planner-gates" || key === "plannerGates") options.plannerGates = flag();
    else if (key === "keep-reads" || key === "keepReads") options.keepReads = flag();
    else if (key === "tools") options.tools = flag();
    else if (key === "effort" || key === "revisions") options[key] = Number(value);
    else if (key === "agent") options.agent = OFF.has(value) ? null : value;
    else throw new Error(`no harness switch "${key}" (there is: gates, planner-gates, effort, skills, archive, revisions, engram, diff, escalate, remind, keep-reads, tools, contract, agent, planner, review)`);
  }
  return { name, options: z.strictObject(HarnessOptions.shape).parse(options) };
}

/** A variant's switches in a line, as far as they differ from the baseline ("as the baseline" when they don't). */
export function describeVariant(options: HarnessOptions): string {
  const said: string[] = [];
  if (options.gates !== BASELINE.gates) said.push(options.gates ? "gates on" : "gates off");
  if (options.plannerGates !== BASELINE.plannerGates) said.push(options.plannerGates ? "the planner's own gates" : "no planner gates");
  if (options.effort !== BASELINE.effort) said.push(`effort ${options.effort}`);
  if (options.skills !== BASELINE.skills) said.push(options.skills ? "skills offered" : "no skills");
  if (options.archive !== BASELINE.archive) said.push(options.archive ? "the archive's context" : "no archive context");
  if (options.revisions !== BASELINE.revisions) said.push(options.revisions ? `${options.revisions} revision${options.revisions === 1 ? "" : "s"}` : "no revisions");
  if (options.engram !== BASELINE.engram) said.push(options.engram ? "the notes store (Engram)" : "no notes store");
  if (options.diff !== BASELINE.diff) said.push(options.diff ? "the reviewer is shown the diff" : "the reviewer isn't shown the diff");
  if (options.escalate !== BASELINE.escalate) said.push(options.escalate ? "a gate failing twice moves the work to the planner" : "no escalation");
  if (options.remind !== BASELINE.remind) said.push(options.remind ? "the quest's constraints said again every ten commands" : "no constraints said again");
  if (options.keepReads !== BASELINE.keepReads) said.push(options.keepReads ? "current file reads kept whole" : "file reads cut short like any output");
  if (options.tools !== BASELINE.tools) said.push(options.tools ? "the engineer's own tools, several calls a turn" : "one command a reply");
  if (options.contract !== BASELINE.contract) said.push(options.contract ? "where no gate fails before the work, the planner writes a test that does" : "no contract first");
  if (options.agent !== BASELINE.agent) said.push(options.agent ? `${options.agent} does the work` : "his own loop does the work");
  if (options.planner !== BASELINE.planner) said.push(options.planner ? "a plan first" : "no plan");
  if (options.review !== BASELINE.review) said.push(options.review ? "an independent reviewer" : "no reviewer");
  return said.join(", ") || "as the baseline";
}

/**
 * A trial's quest has an id of its own kind (t-…, where any other quest's is q-…), so what it kept can be told
 * from other work wherever it goes. The archive keeps a trial's record and its kept work as kind `trial`, and
 * that kind is never offered to a model as context: a later trial of the same problem (the same seed, in an A/B
 * or a sweep; the same kind of task, any time) must not be handed an earlier one's answers, or its marks.
 */
export const TRIAL_QUEST_PREFIX = "t";
export const isTrialQuest = (quest: string | null | undefined): boolean => typeof quest === "string" && quest.startsWith(`${TRIAL_QUEST_PREFIX}-`);
/** The archive's kind for a trial's record and what a trial kept. */
export const TRIAL_ARCHIVE_KIND = "trial";

/** An answer passes when it is within its tolerance of the exact one. */
export const answerOk = (got: number | null, expected: number, tolerance: number): boolean =>
  got !== null && Number.isFinite(got) && Math.abs(got - expected) <= tolerance;

/** The score is the share of answers that pass. */
export const trialScore = (answers: readonly { ok: boolean }[]): number => (answers.length ? answers.filter((a) => a.ok).length / answers.length : 0);

/**
 * Why a record doesn't add up, or null. Every replica runs this: a verdict or a score
 * that doesn't follow from the recorded numbers is refused, so nobody can inflate one.
 */
export function trialProblem(record: Pick<TrialRecord, "status" | "score" | "answers">): string | null {
  for (const a of record.answers) {
    if (a.ok !== answerOk(a.got, a.expected, a.tolerance)) return `answer ${a.key}'s verdict doesn't follow from its numbers`;
  }
  if (new Set(record.answers.map((a) => a.key)).size !== record.answers.length) return "an answer is listed twice";
  if (record.status === "scored" && !record.answers.length) return "a scored trial has answers";
  const score = record.status === "crashed" ? 0 : trialScore(record.answers);
  if (Math.abs(record.score - score) > 1e-12) return "the score doesn't follow from the answers";
  return null;
}
