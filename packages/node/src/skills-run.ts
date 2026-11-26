import type { RunEvent, RunOutcome } from "@invincible/models";
import type { RunEvidence, RouteName, SkillLearned } from "@invincible/core";

/*
 * What a run's runner does for its skills (skills.ts), in two small pieces so the
 * runner itself stays as it is: a trail that listens to the run's events and keeps
 * only what the reviewer's evidence is made of (each command and its exit code, the
 * gates' last run; never what anything printed), and the one call that tells the node
 * the run has ended. The node does the rest: it records the outcome against the skills
 * the run was given and, if the review passed, distils at most one skill.
 */

const exit = (code: number): number => (Number.isFinite(code) ? Math.max(-1, Math.min(255, Math.trunc(code))) : -1);

/** A run's trail, from its events: the commands that ran with their exit codes, and each gate's last result. */
export function runTrail() {
  const commands = new Map<number, string>();
  const steps: { command: string; exitCode: number }[] = [];
  let gates: { command: string; exitCode: number }[] = [];
  return {
    on(event: RunEvent): void {
      if (event.type === "command") commands.set(event.step, event.command);
      else if (event.type === "observation") steps.push({ command: commands.get(event.step) ?? "(unknown)", exitCode: exit(event.exitCode) });
      else if (event.type === "gated") gates = event.results.map((g) => ({ command: g.command, exitCode: exit(g.exitCode) }));
    },
    steps: (): { command: string; exitCode: number }[] => steps,
    gates: (): { command: string; exitCode: number }[] => gates,
  };
}
export type RunTrail = ReturnType<typeof runTrail>;

/** The evidence as the node takes it: bounded, and nothing but the goal, the plan, commands, exit codes and gates. */
export function runEvidence(about: { run: string; sandbox?: string | undefined; goal: string; network: RunEvidence["network"]; repo?: boolean; agent?: string | undefined; outcome: Pick<RunOutcome, "status" | "plan">; trail: RunTrail }): RunEvidence {
  const gates = about.trail.gates().slice(0, 16);
  return {
    run: about.run,
    ...(about.sandbox && about.sandbox !== about.run ? { sandbox: about.sandbox } : {}),
    goal: about.goal.slice(0, 4000),
    status: about.outcome.status,
    network: about.network,
    ...(about.repo ? { repo: true } : {}),
    ...(about.agent ? { agent: about.agent.slice(0, 40) } : {}),
    plan: about.outcome.plan.slice(0, 8000),
    steps: about.trail
      .steps()
      .slice(-400)
      .map((s) => ({ command: s.command.slice(0, 4000), exitCode: s.exitCode })),
    ...(gates.length ? { gates: gates.map((g) => ({ command: g.command.slice(0, 1000), exitCode: g.exitCode })) } : {}),
  };
}

/**
 * The run has ended: tell the node. What comes back is only what the mind now holds (a skill learned, the
 * skills its outcome was recorded against). Never fails the run: a node that can't take it answers nothing.
 */
export async function learnFromRun(node: { call<T = any>(name: RouteName, input?: unknown): Promise<T> }, about: Parameters<typeof runEvidence>[0]): Promise<SkillLearned | null> {
  try {
    const learned = await node.call<SkillLearned>("learnSkill", runEvidence(about));
    return learned && Array.isArray(learned.used) ? learned : null;
  } catch {
    return null;
  }
}

/**
 * What a run's end taught, a line each: only what the node said is in the mind. For the run's memory and a
 * loop's summary (which models read later), a skill that waits for you is named by its id alone: its words are
 * given to no model before you approve them. `toYou`: for your terminal, with its title.
 */
export function learnedLines(learned: SkillLearned | null, toYou = false): string[] {
  if (!learned) return [];
  const lines: string[] = [];
  if (learned.used.length) lines.push(`Skills used: ${learned.used.map((u) => `"${u.title}"`).join(", ")}`);
  if (learned.skill) {
    const what = `Skill ${learned.revised ? "revised" : "learned"}`;
    if (!learned.skill.pending) lines.push(`${what}: "${learned.skill.title}" (${learned.skill.id})`);
    else lines.push(`${what}: ${toYou ? `"${learned.skill.title}" (${learned.skill.id})` : learned.skill.id} (it waits for your approval, and isn't used until then)`);
  }
  return lines;
}
