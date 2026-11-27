import type { MarkState } from "@invincible/core/agent-mark";
import { glassState } from "@invincible/core/glass";
import type { AgentState } from "../lib/agent-state.ts";
import type { OrbMood } from "../lib/orb-motion.ts";
import { glassAvatar } from "./glass.ts";

/*
 * An agent's mark: its glass (ui/glass.ts; core's glass.ts, the owner's word of 27 November 2026 that the Grille goes),
 * its shape and ramp as its node gave them, the same on every device. What the Grille said in its shape is a dot beside
 * the word now: working, needs you, failed, and idle for the rest (core's glassState), the row's line saying which.
 */

/** The state a mark shows for an orb's mood (what the app said of a face before the marks). */
export const markStateOfMood = (mood: OrbMood | undefined): MarkState => (mood === "waiting" ? "needs" : (mood ?? "idle"));

/** The state a mark shows for an agent's state in a seat (lib/agent-state.ts): work that passed review is done; new to
 * you, or at rest, idle. */
export function markStateOfAgent(state: AgentState | undefined): MarkState {
  switch (state) {
    case "working": case "needs": case "failed": case "paused": case "queued": return state;
    case "verified": return "done";
    default: return "idle";
  }
}

export interface AgentMarkOptions {
  id: string;
  /** Its saved avatar: its glass (v 4), a mark (v 3) or a colour chosen before (v 2), or nothing (core's glassOf). */
  profile?: unknown;
  /** Its width and height in CSS pixels (16 to 256). */
  size: number;
  /** What it shows, as its dot; left out, no dot (a speaker in a conversation, a pick list). */
  state?: MarkState;
  /** Its accessible name; left out, it is decorative (its name is beside it). */
  label?: string;
}

/** An agent's mark: its glass, its state's dot where its state is known. */
export function agentMark(options: AgentMarkOptions): HTMLElement {
  return glassAvatar({
    id: String(options.id ?? ""),
    profile: options.profile,
    size: options.size,
    ...(options.state ? { state: glassState(options.state) } : {}),
    ...(options.label ? { label: options.label } : {}),
  });
}
