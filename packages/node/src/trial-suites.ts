import type { Prices, SandboxNetwork } from "@galahad/core";
import { AGENTIC_SUITE, agenticProblem, agenticProblems, ENGINEERING_SUITE, LEVELS, reviewDomain, REVIEWER_CASES, USUAL_LEVEL } from "@galahad/brain";
import type { NodeClient } from "./quest-cli.ts";
import { agenticUnit } from "./trial-agentic.ts";
import { reviewerUnit } from "./trial-reviewer.ts";
import type { Tryable } from "./trial-cli.ts";
import { caseUnit, chooseCases, originalRun, readCases, type YourCases, yoursAside } from "./trial-yours.ts";

/*
 * The suites a run can be made from. A suite says what it is, lists its problems, and
 * chooses the ones a run names; how one trial of a problem is done and graded is the
 * problem's own (trial-cli.ts Tryable).
 */

export interface SuiteInfo {
  id: string;
  /** What it measures, in a line. */
  about: string;
  /** Where its trials are worked, for the run's first line. */
  where: string;
  /** The network a run uses unless you say otherwise, and the ones it may. */
  network: SandboxNetwork;
  networks: readonly SandboxNetwork[];
  /** Whether its problems have a difficulty you can turn (`--level`). */
  levels?: { min: number; max: number; usual: number };
  /** Whether its problems come hardest first, and a run that names none takes this many of them (`--hardest n`). */
  hardest?: number;
  /** Every problem, as `galahad trial problems` lists them (`detail`: a line more about one). */
  list(level?: number): { id: string; domain: string; title: string; detail?: string }[];
  /** The problems a run would pose: all of them, or those named (by id or domain). Throws with what's unknown. */
  choose(names: readonly string[], level?: number): Tryable[];
  /** A suite of your own work: its problems are your node's, so it is read through the node before it lists or chooses any. */
  load?(node: NodeClient): Promise<SuiteInfo>;
  /** What `galahad trial problems` says under the list (yours: what a run would likely cost, and which tasks aren't cases). */
  aside?: string;
}

/** The suite ready to list and choose from: read through the node first when it is your own work. */
export const loadSuite = async (suite: SuiteInfo, node: () => NodeClient): Promise<SuiteInfo> => (suite.load ? suite.load(node()) : suite);

/** Those named, by id or domain; all when none is named. */
export function named<T extends { id: string; domain: string }>(all: readonly T[], names: readonly string[], suite: string): T[] {
  if (!names.length) return [...all];
  const unknown = names.filter((n) => !all.some((p) => p.id === n || p.domain === n));
  if (unknown.length) throw new Error(`no such problem or domain: ${unknown.join(", ")} (galahad trial problems --suite ${suite} lists them)`);
  return all.filter((p) => names.includes(p.id) || names.includes(p.domain));
}

const engineering: SuiteInfo = {
  id: "engineering",
  about: "fourteen mathematics, physics and engineering problems with exact answers",
  where: "in the Lab",
  network: "gateway",
  networks: ["gateway", "online"],
  list: () => ENGINEERING_SUITE.map((p) => ({ id: p.id, domain: p.domain, title: p.title })),
  choose: (names) => named(ENGINEERING_SUITE, names, "engineering"),
};

/**
 * Agentic tasks: a problem is a task at a level (`slow-rollup-l3`). Named without one, a task is posed at the
 * run's `--level`, or at its usual level; a kind of work (`debugging`) names every task of that kind.
 */
const agentic: SuiteInfo = {
  id: "agentic",
  about: "real work in a small repository, graded by hidden tests run in a fresh sandbox against what he left",
  // (The run's line says its network next: isolated by default, or the gateway's models only for a coding tool.)
  where: "in the workshop",
  network: "isolated",
  networks: ["isolated", "gateway"],
  levels: { min: 1, max: LEVELS, usual: USUAL_LEVEL },
  list: (level) => agenticProblems(level).map((p) => ({ id: p.id, domain: p.task.kind, title: `${p.task.title} (${p.task.dial})` })),
  choose: (names, level) => {
    if (!names.length) return agenticProblems(level).map((p) => agenticUnit(p.task, p.level));
    const chosen: Tryable[] = [];
    const unknown: string[] = [];
    for (const name of names) {
      const one = agenticProblem(name, level);
      const ofKind = AGENTIC_SUITE.filter((t) => t.kind === name);
      if (one) chosen.push(agenticUnit(one.task, one.level));
      else if (ofKind.length) for (const task of ofKind) chosen.push(agenticUnit(task, agenticProblem(task.id, level)!.level));
      else unknown.push(name);
    }
    if (unknown.length) throw new Error(`no such task, or kind of work: ${unknown.join(", ")} (galahad trial problems --suite agentic lists them; a level is named as slow-rollup-l3)`);
    // Named twice (by name and by kind), a problem is posed once.
    return chosen.filter((p, i) => chosen.findIndex((q) => q.id === p.id) === i);
  },
};

/** The reviewer, measured directly: cases of a quest's evidence with a known answer. Named by case, or by what a careful reviewer does with it. */
const reviewer: SuiteInfo = {
  id: "reviewer",
  about: "a quest's evidence with a known answer, put to the reviewer: does it pass what it should fail, or fail what it should pass?",
  where: "put to the reviewer as a quest's evidence is (no sandbox)",
  network: "gateway",
  networks: ["gateway", "isolated", "online"],
  list: () => REVIEWER_CASES.map((c) => ({ id: c.id, domain: reviewDomain(c.truth), title: c.title })),
  choose: (names) => named(REVIEWER_CASES.map((c) => ({ ...reviewerUnit(c), domain: reviewDomain(c.truth) })), names, "reviewer"),
};

/** What your own work is as a suite, read or not. */
const YOURS = {
  id: "yours",
  about: "your knights' tasks that passed review, each worked again from the commit it began at and graded by its own gates",
  where: "in the workshop, each from the commit its task began at, with no archive, memories or skills (they may hold its answer)",
  network: "online",
  networks: ["online", "gateway"],
  hardest: 5,
} as const satisfies Partial<SuiteInfo>;

/** Your own work as read through your node: its cases hardest first, each with what its original run took (trial-yours.ts). */
function yoursRead(cases: YourCases, prices: Prices): SuiteInfo {
  return {
    ...YOURS,
    list: () => cases.cases.map((c) => ({ id: c.id, domain: c.knight, title: c.title, detail: `when it was done: ${originalRun(c, prices)}` })),
    choose: (names) => chooseCases(cases, names).map(caseUnit),
    aside: yoursAside(cases, prices, YOURS.hardest),
  };
}

/** Your knights' verified tasks as trials (trial-yours.ts): your node's, so read through it before any is listed or chosen. */
const yours: SuiteInfo = {
  ...YOURS,
  // (Unread, it knows of no case: a report of past runs lists the ones they tried.)
  list: () => [],
  choose: () => {
    throw new Error("your cases are your node's: the suite is read through it first (loadSuite)");
  },
  load: async (node) => {
    const [cases, { prices }] = await Promise.all([readCases(node), node.call<{ prices: Prices }>("prices").catch(() => ({ prices: {} as Prices }))]);
    return yoursRead(cases, prices);
  },
};

export const TRIAL_SUITES: Record<string, SuiteInfo> = { engineering, agentic, reviewer, yours };

export function suiteNamed(id: string): SuiteInfo {
  const suite = TRIAL_SUITES[id];
  if (!suite) throw new Error(`no trial suite "${id}" (there is: ${Object.keys(TRIAL_SUITES).join(", ")})`);
  return suite;
}
