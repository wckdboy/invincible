import { type ActionView, plainLine, plainText, type TeamTrailEntry } from "@invincible/core";
import { commandKind, readTrailLine } from "../../../../apps/web/src/lib/steps.ts";
import { hlcMs } from "../../../../apps/web/src/lib/time.ts";
import type { ProofJson } from "./proof.ts";
import { askingAgent } from "./view.ts";

/*
 * The events `--stream` prints (docs/CLI.md, "Events"): one JSON object a line, each with v, type, task and at. Read from
 * what every client reads, as it comes: the task's trail, line by line, as the apps' steps read it (lib/steps.ts'
 * readTrailLine, the runner's own marks), the approvals its agent waits on, and how its row says it stands. Pure: given
 * the same lines in the same order, the same events.
 */

export interface InvEvent {
  v: 1;
  type: string;
  task: string;
  at: number;
  [field: string]: unknown;
}

/** The final event's type for a proof's state. */
export const endType = (state: ProofJson["state"]): string =>
  state === "verified" ? "task.verified" : state === "unproven" ? "task.unproven" : state === "stopped" ? "task.stopped" : "task.failed";

const firstLine = (text: string): string => text.trim().split("\n")[0]?.trim() ?? "";
/** A budget's line ("Budget · $0.81 of $1.00 spent: wrapping up"): what is spent, of what. */
const BUDGET = /^Budget · (?:spent \()?\$(\d+(?:\.\d+)?) of \$(\d+(?:\.\d+)?)/;

export class Tracker {
  /** The gates' commands as the runner knows them (yours, then the planner's), for the gates run before the work. */
  private gates: string[];
  /** The command the work is running, until its exit is told. */
  private open: { n: number; kind: string; text: string } | null = null;
  private lastAt: number | null = null;
  private sameModel = false;
  private told = new Map<string, string>();
  private stood: string | null = null;
  /** What its runner said the next review judged the work against: how many steers (its Judged line, just before it). */
  private judged = 0;

  constructor(
    readonly task: string,
    gates: readonly string[],
    /** When the task was made: an approval its agent asked for before it is another task's. */
    private readonly since: number,
  ) {
    this.gates = [...gates];
  }

  private event(type: string, at: number, fields: Record<string, unknown>): InvEvent {
    return { v: 1, type, task: this.task, at, ...fields };
  }

  /** The events new lines of its trail make. */
  trail(entries: readonly TeamTrailEntry[]): InvEvent[] {
    const out: InvEvent[] = [];
    for (const entry of entries) {
      const line = readTrailLine(entry.text);
      const at = entry.at;
      switch (line.kind) {
        case "plan":
          out.push(this.event("step.completed", at, { n: entry.n, kind: "plan", text: plainLine(firstLine(line.text)), exit: null }));
          break;
        case "command": {
          const what = commandKind(line.command);
          this.open = { n: entry.n, kind: what.kind, text: plainLine(what.kind === "run" ? firstLine(line.command) : (what.path ?? line.command)) };
          out.push(this.event("step.started", at, { n: entry.n, kind: this.open.kind, text: this.open.text }));
          break;
        }
        case "exit":
          if (this.open) out.push(this.event("step.completed", at, { ...this.open, exit: line.code }));
          this.open = null;
          break;
        case "gates":
          this.gates = line.commands;
          break;
        case "baseline":
          line.exits.forEach((exit, i) => out.push(this.event("gate.result", at, { phase: "before", index: i + 1, of: line.exits.length, cmd: this.gates[i] ?? null, exit, ms: null })));
          break;
        case "gate":
          out.push(this.event("gate.result", at, { phase: "after", index: line.index, of: line.of, cmd: plainLine(line.command), exit: line.exit, ms: this.lastAt === null ? null : Math.max(0, at - this.lastAt) }));
          break;
        case "submitted":
          out.push(this.event("step.completed", at, { n: entry.n, kind: "submitted", text: plainLine(line.summary), exit: null }));
          break;
        case "review":
          out.push(this.event("review.verdict", at, { verdict: line.verdict, sameModel: this.sameModel, notes: line.notes.split("\n").filter((l) => l.trim()).length, steers: this.judged }));
          this.judged = 0;
          break;
        case "steer":
          // Your words, or your agent's, where its run took them.
          out.push(this.event("task.steered", at, { n: entry.n, by: line.by, text: plainText(line.text) }));
          break;
        case "judged":
          this.judged = line.steers;
          break;
        case "note": {
          if (line.text.startsWith("Review · by the same model")) this.sameModel = true;
          const budget = BUDGET.exec(line.text);
          if (budget) out.push(this.event("cost.update", at, { usd: Number(budget[1]), budgetUsd: Number(budget[2]), complete: false }));
          out.push(this.event("step.completed", at, { n: entry.n, kind: "note", text: plainLine(line.text), exit: null }));
          break;
        }
        case "thought":
        case "gated":
          break;
      }
      this.lastAt = at;
    }
    return out;
  }

  /** The events its agent's approvals make: each asked for, then each decided. `agent`: its handle. */
  asks(actions: readonly ActionView[], agent: string, at: number): InvEvent[] {
    const out: InvEvent[] = [];
    for (const action of actions) {
      if (askingAgent(action) !== agent) continue;
      const before = this.told.get(action.id);
      if (before === undefined) {
        // Asked for before this task was made: another task's (an agent works one thing at a time).
        if (action.state !== "waiting" || (hlcMs(action.requestedAt) ?? at) < this.since - 1000) continue;
        this.told.set(action.id, action.state);
        out.push(this.event("approval.requested", at, { id: action.id, op: `${action.connector}.${action.tool}`, inputs: action.args, class: action.class, by: agent }));
      } else if (before !== action.state) {
        this.told.set(action.id, action.state);
        out.push(this.event("approval.decided", at, { id: action.id, state: action.state }));
      }
    }
    return out;
  }

  /** The approvals of its agent's this tracker has seen asked for and not yet decided. */
  waitingAsks(): string[] {
    return [...this.told].filter(([, state]) => state === "waiting").map(([id]) => id);
  }

  /** An event when how it stands changed: its state, and the apps' word for it. */
  stands(state: string, word: string, at: number): InvEvent[] {
    const now = `${state}\u0000${word}`;
    if (now === this.stood) return [];
    this.stood = now;
    return [this.event("task.state", at, { state, word })];
  }

  started(at: number, fields: { title: string; agent: string; room: string; node: string | null; project: string | null; budgetUsd: number | null; gates: string[]; why: string | null }): InvEvent {
    return this.event("task.started", at, fields);
  }

  end(at: number, proof: ProofJson): InvEvent {
    return this.event(endType(proof.state), at, { exit: proof.exit, proof });
  }

  left(at: number, reason: "timeout" | "needs-you" | "interrupted", exit: number): InvEvent {
    return this.event("left", at, { reason, exit });
  }
}
