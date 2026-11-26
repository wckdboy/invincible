import { addUsage, type Usage, type UsageLine } from "@galahad/core";

/*
 * What tools' calls through this node's gateway cost lately, by who called (a gateway token's label: a knight's VM is
 * `sandbox:<its id>`), kept in memory so a task's budget can count its knight's coding tool beside its own calls. The
 * node's usage table keeps the lasting count (by day); this keeps only the last two days of calls, and at most so many
 * a caller, so it can't grow.
 */

const KEPT_MS = 48 * 60 * 60_000;
const MAX_PER_CALLER = 20_000;

interface Call {
  at: number;
  model: string;
  usage: Usage | null;
}

export class GatewaySpend {
  private readonly calls = new Map<string, Call[]>();

  constructor(private readonly now: () => number = Date.now) {}

  /** A call answered: who made it, the model (provider/model), and its tokens as the answer said them (null: none). */
  add(label: string, model: string, usage: Usage | null): void {
    const at = this.now();
    const kept = (this.calls.get(label) ?? []).filter((c) => at - c.at < KEPT_MS);
    kept.push({ at, model, usage });
    if (kept.length > MAX_PER_CALLER) kept.splice(0, kept.length - MAX_PER_CALLER);
    this.calls.set(label, kept);
  }

  /** The calls `label` made since `since` (ms), by model, under `role`: lines for core's costOf, as a quest's own are. */
  since(label: string, since: number, role = "tool"): UsageLine[] {
    const lines: UsageLine[] = [];
    for (const c of this.calls.get(label) ?? []) if (c.at >= since) addUsage(lines, role, c.model, c.usage);
    return lines;
  }
}
