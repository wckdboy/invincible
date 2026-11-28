import { type SeatKind, seatKindOf } from "./seats.ts";

/*
 * A plan that works only on your own repositories (the owner's word, 28 November 2026). A Gemini plan's sign-in is a key
 * to the owner's Google Cloud (agy asks Google for cloud-platform, offline: not Gmail or Drive), and any command agy runs
 * can read it, since agy 1.5.18 runs every tool itself and hands none to its client (the review of 28 November 2026, H1).
 * Your agent directs it as it directs any plan: a task you give, one it gives in any turn, a fix it gives back, its steer
 * and its words to a task that runs (the owner's word, 02:04 UTC: "my primary agent needs to be able to direct/steer and
 * use the gemini ultra plan"). It never works on another node's task, its proposal among them, since another node of the
 * fabric is another trust domain, nor for an agent with no repository you set. What it isn't given ends there, in words
 * that say how to get it run, and never moves to another harness or seat.
 */

/** The seat kinds whose plan works only on your own repositories, on a seat of it or on its tool's sign-in in an agent's own VM. */
export const OWN_WORK_ONLY: readonly SeatKind[] = ["google-antigravity"];

/**
 * Whether an agent's work is on such a plan: its harness is that plan's tool (Antigravity), or it is an ACP agent whose
 * command runs that tool, a word of it named agy (`agy acp`, `/opt/agy/bin/agy acp`: the re-check of 28 November 2026,
 * R10). An ACP agent's command is yours alone to set (saveAgent).
 */
export function ownWorkOnly(agent: { harness: string; acp?: string | null }): boolean {
  if (agent.harness === "acp") return !!agent.acp && agent.acp.split(" ").some((word) => word.split("/").at(-1) === "agy");
  const kind = agent.harness === "native" ? null : seatKindOf(agent.harness);
  return kind !== null && OWN_WORK_ONLY.includes(kind);
}

/**
 * Why a task can't run on such a plan, or null: it is another node's (given by it, or its proposal, approved or not), or
 * its agent works on no repository you set (an agent's repository is yours alone to set: saveAgent). Whoever gave it of
 * yours, you or your agent, it runs.
 */
export function ownWorkRefusal(task: { givenBy?: string; proposedBy?: string }, agent: { name: string; repository: string | null }): string | null {
  const rule = "The Gemini plan works only on your own repositories";
  if (task.givenBy?.startsWith("node:") || task.proposedBy?.startsWith("node:")) return `${rule}: another node's task never runs on it; give it to an agent of yours on another plan`;
  if (!agent.repository) return `${rule}: ${agent.name} works on no repository of yours; set one, then give the task again`;
  return null;
}
