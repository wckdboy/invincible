import { RECALIBRATE_AFTER_MS, SELF_ACTION_QUEST, SELF_ACTION_RESOURCE, SELF_ACTIONS, SelfAction, selfActionTarget, selfActionTitle } from "@galahad/core";
import { OFFLINE_AFTER_MS } from "./heartbeat.ts";

/*
 * After each heartbeat, Galahad fixes what's on the self-action allowlist himself
 * (packages/core/src/self-action.ts) and leaves everything else to you as notices
 * and approvals, as the oath says.
 *
 *   plan     pure: a snapshot of this node in, the fixes it calls for out;
 *   act      each fix is parsed against the allowlist (anything else is refused),
 *            checked again against a fresh snapshot (it must be exactly a fix the
 *            plan calls for now), carried out by the node's own hands (the oath
 *            gate still decides a sandbox's removal), and recorded in the ledger
 *            as his own.
 *
 * Nothing here can reach a connector, the vault, devices, the roster, the bank or
 * anything that needs fleet:admin: the hands below are all it has.
 */

/** What the plan reads: this node's own sandboxes, loops and compute. */
export interface SelfSnapshot {
  now: number;
  /** This node's sandboxes (null: not a sandbox host, or Docker didn't answer). */
  sandboxes: { id: string; expiresAt: number; ephemeral: boolean; quest: string }[] | null;
  /** Loops this node runs: whether they only read, whether one is running now, their latest runs (newest first). */
  loops: { name: string; readOnly: boolean; running: boolean; recent: { run: string; status: string; finished: number }[] }[];
  /** Failed runs he has already run again (from the ledger), so none is retried twice. */
  retried: string[];
  /** This node's compute (absent: nothing about it is his to fix here). */
  compute?: {
    /** It can measure itself here. */
    canMeasure: boolean;
    /** It should: it never has, or its body, its ceiling or the benchmark isn't what it measured with. */
    due: "joined" | "changed" | null;
    /** When it last did, and when the owner last set its ceiling (ms; null: never). */
    lastAt: number | null;
    limitSetAt: number | null;
    /** This node records the fleet's plan (it runs a heartbeat); and whether the recorded plan is what the mind gives now. */
    adapts: boolean;
    planDigest: string;
    recordedDigest: string | null;
  } | null;
}

/** At most this many fixes after one heartbeat. */
export const MAX_SELF_ACTIONS = 8;
/** A failed run older than this isn't retried (the next scheduled run is near, or it's old news). */
export const RETRY_WITHIN_MS = 6 * 60 * 60_000;

/** The fixes a snapshot calls for, in order: sandboxes, then loops, then compute. Pure. */
export function planSelfActions(s: SelfSnapshot): SelfAction[] {
  const out: SelfAction[] = [];
  for (const box of s.sandboxes ?? []) {
    // The heartbeat's own rule for "the reaper missed it" (sandbox-overdue): ephemeral, and past its expiry by the grace.
    if (box.ephemeral && s.now - box.expiresAt >= OFFLINE_AFTER_MS) out.push({ kind: "reap-sandbox", sandbox: box.id });
  }
  const retried = new Set(s.retried);
  // A bad run of a loop that only reads: it failed, or its service answered with an error (attention).
  const bad = (status: string | undefined) => status === "failed" || status === "attention";
  for (const loop of s.loops) {
    const [last, before] = loop.recent;
    if (!loop.readOnly || loop.running || !last || !bad(last.status)) continue;
    // Once: not after two bad runs in a row, not twice for the same run, not for old news.
    if (bad(before?.status) || retried.has(last.run) || s.now - last.finished > RETRY_WITHIN_MS) continue;
    out.push({ kind: "retry-loop", loop: loop.name, after: last.run });
  }
  const c = s.compute;
  if (c) {
    // Measured for the first time at once; again when its body, its ceiling or the benchmark changed, but not in a loop: at most once
    // an hour (a runtime that comes and goes, a busy day), unless the owner changed its ceiling since.
    const settled = c.lastAt === null || s.now - c.lastAt >= RECALIBRATE_AFTER_MS || (c.limitSetAt !== null && c.limitSetAt > c.lastAt);
    if (c.canMeasure && c.due && settled) out.push({ kind: "calibrate", why: c.lastAt === null ? "joined" : "changed" });
    if (c.adapts && c.planDigest !== c.recordedDigest) out.push({ kind: "adapt-compute" });
  }
  return out.slice(0, MAX_SELF_ACTIONS);
}

/** The node's hands for the allowlist, and nothing else. */
export interface SelfActionHands {
  /** Destroy one sandbox through the oath gate, on behalf of the quest that made it. */
  reap(sandbox: string, quest: string): Promise<{ verdict: string; reason: string }>;
  /** Start one run of a loop now (it doesn't count as its scheduled run). */
  retry(loop: string): void;
  /** Measure this node (a few seconds, low priority, within its ceiling) and record it. */
  calibrate?(why: "joined" | "changed"): Promise<void>;
  /** Record his compute defaults as the mind gives them now; returns what changed, a line each. */
  adaptCompute?(): string[] | null;
}

export interface LedgerWrite {
  class: "read" | "create" | "modify" | "delete";
  resource: string;
  target: string;
  verdict: "allow";
  reason: string;
  quest: string;
  detail: string;
}

export interface SelfActionOutcome {
  action: SelfAction;
  ok: boolean;
  /** "Removed sandbox 0123456789, which had outlived its time" (or why it didn't). */
  title: string;
}

export class SelfActionRefused extends Error {}

const same = (a: SelfAction, b: SelfAction): boolean => JSON.stringify(a) === JSON.stringify(b);

/**
 * Carries out one fix, or refuses it: it must parse as an allowlisted action and be exactly one the
 * plan calls for in `fresh` (taken just before). Recorded in the ledger as his own either way it ran.
 */
export async function runSelfAction(raw: unknown, fresh: SelfSnapshot, hands: SelfActionHands, ledger: (entry: LedgerWrite) => void): Promise<SelfActionOutcome> {
  const parsed = SelfAction.safeParse(raw);
  if (!parsed.success) throw new SelfActionRefused("not on the self-action allowlist");
  const action = parsed.data;
  if (!planSelfActions(fresh).some((wanted) => same(wanted, action))) throw new SelfActionRefused("nothing calls for it now");
  let title = selfActionTitle(action);
  let ok = true;
  let why = "";
  try {
    switch (action.kind) {
      case "reap-sandbox": {
        const box = fresh.sandboxes!.find((b) => b.id === action.sandbox)!;
        const decision = await hands.reap(box.id, box.quest);
        if (decision.verdict !== "allow") {
          ok = false;
          why = `the oath gate said ${decision.verdict}: ${decision.reason}`;
        }
        break;
      }
      case "retry-loop":
        hands.retry(action.loop);
        break;
      case "calibrate":
        if (!hands.calibrate) throw new Error("this node can't measure itself here");
        await hands.calibrate(action.why);
        break;
      case "adapt-compute": {
        if (!hands.adaptCompute) throw new Error("this node doesn't record the plan");
        const changes = hands.adaptCompute();
        // What changed is the line the owner reads.
        if (changes?.length) title = `${title}: ${changes.join(" ")}`.slice(0, 1500);
        break;
      }
    }
  } catch (error) {
    ok = false;
    why = String((error as Error)?.message ?? error).slice(0, 300);
  }
  ledger({
    class: SELF_ACTIONS[action.kind].class,
    resource: SELF_ACTION_RESOURCE,
    target: selfActionTarget(action),
    verdict: "allow",
    reason: ok ? `Galahad's own fix after the heartbeat: ${SELF_ACTIONS[action.kind].why}` : `Galahad's own fix didn't work: ${why}`,
    quest: SELF_ACTION_QUEST,
    detail: title,
  });
  return { action, ok, title: ok ? title : `Tried: ${title.charAt(0).toLowerCase()}${title.slice(1)} (${why})` };
}

/** Plans from one snapshot, checks each fix against a fresh one, and carries out what still stands. */
export async function selfAct(first: SelfSnapshot, fresh: () => Promise<SelfSnapshot>, hands: SelfActionHands, ledger: (entry: LedgerWrite) => void): Promise<SelfActionOutcome[]> {
  const plan = planSelfActions(first);
  if (!plan.length) return [];
  const now = await fresh();
  const out: SelfActionOutcome[] = [];
  for (const action of plan) {
    try {
      out.push(await runSelfAction(action, now, hands, ledger));
    } catch (error) {
      if (!(error instanceof SelfActionRefused)) throw error;
      // It no longer stands (the reaper got there first, the loop ran): nothing to do.
    }
  }
  return out;
}
