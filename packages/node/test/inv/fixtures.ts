import { progress, type RunEvent } from "@invincible/agents";
import { type ActionView, type Agent, encodeHlc, type TeamSnapshot, type TeamTask, type TeamTrailEntry } from "@invincible/core";
import type { Io } from "../../src/inv/io.ts";
import { PLAIN } from "../../src/inv/render.ts";

/*
 * What a node serves, made here for inv's tests: tasks, agents and approvals in their contracts' shapes, and a task's
 * trail written by the runner's own words for each step (team-runtime.ts progress()), so what inv reads is what the
 * runner writes.
 */

export const T0 = Date.UTC(2026, 10, 26, 12, 0, 0);
export const GATE = "bun test packages/link";

export const task = (over: Partial<TeamTask> = {}): TeamTask => ({
  id: "task-a1b2c3d4e5f6",
  room: "dm-ada",
  assignee: "ada",
  title: "Fix the flaky link sync test",
  goal: "Fix the flaky link sync test.",
  dependsOn: [],
  gates: [GATE],
  status: "running",
  verified: false,
  progress: "",
  output: "",
  error: null,
  chainId: "chain-1",
  createdAt: T0,
  updatedAt: T0 + 60_000,
  ...over,
});

export const agent = (over: Partial<Agent> = {}): Agent => ({
  id: "ada",
  name: "Ada",
  instructions: "Make small, verifiable changes.",
  role: "engineer",
  harness: "native",
  enabled: true,
  dailyTurns: 40,
  turnsToday: 1,
  repository: "https://github.com/example-owner/invincible",
  workspaceNode: null,
  workspace: { node: `n_${"u".repeat(43)}`, id: "0123456789" },
  memory: "",
  createdAt: T0 - 86_400_000,
  updatedAt: T0 - 86_400_000,
  ...over,
});

export const snapshot = (tasks: TeamTask[], agents: Agent[] = [agent()]): TeamSnapshot => ({ agents, rooms: [], tasks, deliveries: [] });

export const action = (over: Partial<ActionView> = {}): ActionView => ({
  id: `a_${"q".repeat(22)}`,
  connector: "github",
  tool: "create_pull_request",
  args: { owner: "example-owner", repo: "invincible", title: "Fix the race in retry()" },
  class: "outward",
  target: "POST /repos/example-owner/invincible/pulls",
  by: "arm:team.0123456789.ada",
  why: "Ship the fix.",
  node: "keep",
  requestedAt: encodeHlc({ ms: T0 + 30_000, counter: 0 }),
  expires: T0 + 3_600_000,
  state: "waiting",
  sendBy: null,
  decidedVia: null,
  order: null,
  receipt: null,
  note: null,
  self: false,
  ...over,
});

/** A trail as the runner writes it: one line for each step, a second apart from `start`. */
export const trail = (events: RunEvent[], start = T0, stepMs = 1000, from = 1): TeamTrailEntry[] =>
  events.map((event, i) => ({ n: from + i, at: start + (i + 1) * stepMs, text: progress(event) }));

const owner = (command: string) => ({ command, by: "owner" as const });
const result = (command: string, exitCode: number, durationMs = 1000) => ({ ...owner(command), exitCode, durationMs, excerpt: "" });

/** The work up to its submission: its gates, how they ran before it, a plan, a read, a command that failed, then done. */
export const worked = (before: number[] = [1], gates: string[] = [GATE]): RunEvent[] => [
  { type: "gates", gates: gates.map(owner) },
  { type: "baseline", results: gates.map((gate, i) => result(gate, before[i] ?? 1)) },
  { type: "plan", text: "1. Find the race.\n2. Fix it.", model: "stand-in/planner" },
  { type: "command", step: 1, command: "sed -n '1,80p' packages/link/src/sync.ts" },
  { type: "observation", step: 1, exitCode: 0, durationMs: 10, output: "exit 0 · 10 ms\nexport function sync() {}" },
  { type: "command", step: 2, command: GATE },
  { type: "observation", step: 2, exitCode: 1, durationMs: 1200, output: "exit 1 · 1200 ms\n1 fail" },
  { type: "submitted", summary: "Fixed the race in retry()." },
];

/** A round of the gates after the work, each with its exit. */
export const gated = (exits: number[], gates: string[] = [GATE]): RunEvent[] => [
  ...gates.map((gate, i): RunEvent => ({ type: "gate", index: i + 1, of: gates.length, round: 1, command: gate, by: "owner", exitCode: exits[i] ?? 0, durationMs: 41_200, output: exits[i] ? "1 fail" : "38 pass" })),
  { type: "gated", round: 1, passed: exits.every((exit) => exit === 0), results: gates.map((gate, i) => result(gate, exits[i] ?? 0)) },
];

export const reviewed = (verdict: "pass" | "revise", notes = "Looks right.\nThe test now waits for the retry."): RunEvent[] => [{ type: "review", verdict, notes, model: "stand-in/reviewer" }];

/**
 * A trail with what its runtime says just before each review of steered work (team-runtime.ts: "Judged · against its
 * goal and 2 steers, in order"), which is not one of the run's events: put in before its last review, then numbered.
 */
export function judged(entries: TeamTrailEntry[], steers: number): TeamTrailEntry[] {
  const at = entries.findLastIndex((entry) => entry.text.startsWith("Review · pass") || entry.text.startsWith("Review · revise"));
  const lines = steers && at >= 0 ? [...entries.slice(0, at), { n: 0, at: entries[at]!.at, text: `Judged · against its goal and ${steers} steer${steers === 1 ? "" : "s"}, in order` }, ...entries.slice(at)] : entries;
  return lines.map((entry, i) => ({ ...entry, n: i + 1 }));
}

/** An Io that keeps what is written, for a command run whole in a test (plain, as when piped). */
export function testIo(env: Record<string, string | undefined>): Io & { stdout: () => string; stderr: () => string } {
  let out = "";
  let err = "";
  return {
    out: (text) => void (out += text),
    err: (text) => void (err += text),
    style: { ...PLAIN },
    errStyle: { ...PLAIN },
    rows: null,
    env,
    now: Date.now,
    signal: new AbortController().signal,
    onInterrupt: () => () => {},
    onResize: () => () => {},
    pollMs: 20,
    stdout: () => out,
    stderr: () => err,
  };
}

