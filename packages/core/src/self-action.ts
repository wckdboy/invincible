import { z } from "zod";
import { LoopName } from "./events.ts";

/*
 * Self-action: what Galahad may fix on his own after a heartbeat. The oath's line is
 * that he acts on what's safe, reversible and internal, and asks about everything
 * else; this is that line written down. The allowlist is these kinds and nothing
 * more: each is typed, each is checked again against the state it's about just
 * before it runs, and anything else (outward, destructive of your data, the bank,
 * the vault, devices, the roster, anything that needs fleet:admin) stays a notice
 * or an approval. Every one is recorded in the ledger as his own
 * (resource SELF_ACTION_RESOURCE, quest SELF_ACTION_QUEST), and you can turn them
 * all off with one switch (the heartbeat loop's `selfAction: false`).
 */

export const SelfAction = z.discriminatedUnion("kind", [
  /**
   * A sandbox the reaper missed: ephemeral, past its expiry by more than the heartbeat's grace, destroyed
   * through the oath gate on behalf of the quest that made it (the oath's own exception for cleaning up
   * ephemeral things; a persistent sandbox is never touched).
   */
  z.strictObject({ kind: z.literal("reap-sandbox"), sandbox: z.string().regex(/^[a-f0-9]{10}$/) }),
  /**
   * A loop that went wrong once (it failed, or its service answered with an error; the run before was fine)
   * runs again, once: only a loop that only reads (a connector tool of class read) and runs on this node.
   * A second bad run in a row is left to you.
   */
  z.strictObject({ kind: z.literal("retry-loop"), loop: LoopName, after: z.string().min(1).max(64) }),
  /**
   * This node measures itself (a calibration): it never has, or its body, its ceiling or the benchmark isn't what it measured with.
   * A few seconds at low priority, within its ceiling; nothing leaves the machine, nothing is installed.
   */
  z.strictObject({ kind: z.literal("calibrate"), why: z.enum(["joined", "changed"]) }),
  /**
   * The fleet's compute isn't what his recorded plan says (a node joined, left or was measured again, a ceiling
   * changed): he re-derives his defaults (slots, the effort auto may reach, which host takes sandboxes first),
   * records them, and tells you in a line what changed. Internal: undone by setting a ceiling.
   */
  z.strictObject({ kind: z.literal("adapt-compute") }),
]);
export type SelfAction = z.infer<typeof SelfAction>;
export type SelfActionKind = SelfAction["kind"];

/** The allowlist, with each kind's oath class and why it's safe to do without asking. */
export const SELF_ACTIONS: Record<SelfActionKind, { class: "read" | "create" | "modify" | "delete"; why: string }> = {
  "reap-sandbox": { class: "delete", why: "an ephemeral sandbox past its expiry: the reaper's own rule, through the oath gate" },
  "retry-loop": { class: "read", why: "a read-only loop that went wrong once: running it again only reads" },
  calibrate: { class: "create", why: "this node measuring itself for a few seconds at low priority, within its ceiling: nothing leaves it and nothing is installed" },
  "adapt-compute": { class: "modify", why: "his own defaults (slots, effort, which host first), derived from what the fleet measured and your ceilings: internal, and a ceiling of yours overrides them" },
};

export const SELF_ACTION_KINDS = Object.keys(SELF_ACTIONS) as SelfActionKind[];

/** The ledger's resource and quest for his own fixes. */
export const SELF_ACTION_RESOURCE = "self-action";
export const SELF_ACTION_QUEST = "galahad.self";

/** One line for the ledger and the inbox's history ("Galahad fixed: …"). */
export function selfActionTitle(action: SelfAction): string {
  switch (action.kind) {
    case "reap-sandbox":
      return `Removed sandbox ${action.sandbox}, which had outlived its time`;
    case "retry-loop":
      return `Ran loop ${action.loop} again after one bad run`;
    case "calibrate":
      return action.why === "joined" ? "Measured this node for the first time" : "Measured this node again (its body, its ceiling or the benchmark had changed)";
    case "adapt-compute":
      return "Re-derived his compute defaults";
  }
}

/** What the ledger's target says (`<kind>:<what>`; a retry names the failed run too), so a history can be read without the action. */
export function selfActionTarget(action: SelfAction): string {
  switch (action.kind) {
    case "reap-sandbox":
      return `reap-sandbox:${action.sandbox}`;
    case "retry-loop":
      return `retry-loop:${action.loop}:${action.after}`;
    case "calibrate":
      return `calibrate:${action.why}`;
    case "adapt-compute":
      return "adapt-compute:plan";
  }
}

/** The failed runs a ledger's self-action targets say were already run again. */
export const retriedRuns = (targets: readonly string[]): string[] =>
  targets.flatMap((t) => {
    const m = /^retry-loop:[^:]+:(.+)$/.exec(t);
    return m ? [m[1]!] : [];
  });
