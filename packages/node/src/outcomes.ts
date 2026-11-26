import { addUsage, costOf, dueRun, northStar, parseSchedule, type Prices, redact, type TeamOutcome, type TeamOutcomeControlInput, type TeamOutcomeInput, type TeamTask, type Usage, type UsageLine, usdLabel } from "@galahad/core";
import type { ChatTools, ToolCall } from "@galahad/brain";
import { chat } from "@galahad/brain";
import type { MindStore } from "@galahad/mind";
import type { NodeIdentity } from "@galahad/core";
import { TeamError, type StoredOutcome, type TeamStore } from "./team-store.ts";
import type { TeamService } from "./team.ts";

/*
 * Outcomes (PLAN #43, the core of Devin Bots): an outcome you give Galahad to own for days or weeks. He works it in a
 * room of its own: gives tasks to the knights you named for it, on his own within its budget (your ruling of 18
 * November), each task still gated and reviewed in its knight's VM; judges what comes back; keeps his plan; reports
 * once a day; and asks you there when a decision is yours (your word, 23 November 2026: what is monetary, legal or
 * destructive), deciding the rest himself. Shipping, and anything outward that isn't his to approve, asks on a card.
 *
 * He looks at it when one of its tasks ends, when you write in its room, when its report is due, and (with nothing of it
 * in flight) every few hours; never when nothing changed, never twice at once. Each look is one answer of the planner
 * role with four tools of its own, and what it costs counts against the outcome, as its tasks' runs do.
 */

/** Its tasks waiting or running at once, at most; and given in a day, at most. */
export const OUTCOME_LIMITS = { inFlight: 6, perDay: 30, taskUsd: 25, notes: 8000, idleLookMs: 6 * 3600_000 } as const;
/** Below this, with nothing of it running, it has spent what it may. */
const SPENT_BELOW_USD = 0.25;
/** At most this many of a knight's passed gates are shown to a look, as what its VM runs gates with. */
const PASSED_GATES = 4;
const ENDED = new Set<TeamTask["status"]>(["done", "failed", "stopped", "interrupted"]);

export type BrainContext = Parameters<typeof chat>[0];

export interface OutcomeOptions {
  store: TeamStore;
  service: () => TeamService;
  mind: MindStore;
  identity: NodeIdentity;
  /** The brain, as the node counts its calls (server's brainFor). */
  brain: () => BrainContext;
  prices: () => Prices;
  log: (message: string) => void;
  now?: () => number;
  /** For tests: the model's answers. */
  chat?: typeof chat;
}

export class OutcomeError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export class OutcomeRunner {
  private readonly now: () => number;
  private readonly chat: typeof chat;
  private timer: ReturnType<typeof setInterval> | null = null;
  /** The look under way, per outcome; and those asked for again while one was (it looks again once it ends). */
  private readonly looking = new Map<string, Promise<string>>();
  private readonly again = new Set<string>();
  /**
   * Aborted when the runner stops: a look under way is cut off, not waited for. A model's answer can take minutes, and
   * a node whose stop waited for one was killed by its service manager (19 November 2026, a deploy's restart).
   */
  private readonly halt = new AbortController();

  constructor(private readonly o: OutcomeOptions) {
    this.now = o.now ?? Date.now;
    this.chat = o.chat ?? chat;
  }

  start(everyMs = 60_000): void {
    this.timer = setInterval(() => void this.tick(), everyMs);
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.halt.abort();
    await this.settled();
  }

  /** Resolves when the looks under way have ended. */
  async settled(): Promise<void> {
    await Promise.allSettled([...this.looking.values()]);
  }

  /** What an outcome stands at: what its tasks and his looks cost, what its waiting tasks may still spend, its counts. */
  view(outcome: StoredOutcome): TeamOutcome {
    const tasks = this.o.store.tasks(outcome.room).filter((t) => t.outcome === outcome.id);
    const prices = this.o.prices();
    let spent = outcome.leadUsd;
    let committed = 0;
    for (const task of tasks) {
      if (task.record) spent += costOf(task.record.spent, prices).usd;
      if (task.status === "queued" || task.status === "running") committed += task.budgetUsd ?? 0;
    }
    const count = (statuses: TeamTask["status"][]) => tasks.filter((t) => statuses.includes(t.status)).length;
    return {
      id: outcome.id,
      room: outcome.room,
      title: outcome.title,
      goal: outcome.goal,
      done: outcome.done,
      knights: outcome.knights,
      budgetUsd: outcome.budgetUsd,
      spentUsd: round(spent),
      committedUsd: round(committed),
      status: outcome.status,
      notes: outcome.notes,
      tasks: { total: tasks.length, queued: count(["queued", "proposed"]), running: count(["running"]), done: tasks.filter((t) => t.status === "done" && t.verified).length, failed: count(["failed", "stopped", "interrupted"]) },
      // The north star over what this outcome already counts: its own tasks, cut at when it began (#43).
      northStar: northStar(tasks, outcome.createdAt),
      reportHour: outcome.reportHour,
      tz: outcome.tz,
      lastLookAt: outcome.lastLookAt,
      lastReportAt: outcome.lastReportAt,
      ended: outcome.ended,
      createdAt: outcome.createdAt,
      updatedAt: outcome.updatedAt,
    };
  }

  list(): TeamOutcome[] {
    return this.o.store.outcomes().map((o) => this.view(o)).sort((a, b) => b.createdAt - a.createdAt);
  }

  /** You give him an outcome: its room is made, he says what he'll do there, and looks at it soon. */
  create(input: TeamOutcomeInput): TeamOutcome {
    let outcome: StoredOutcome;
    try {
      outcome = this.o.store.createOutcome(input);
    } catch (error) {
      if (error instanceof TeamError) throw new OutcomeError(error.status, error.message);
      throw error;
    }
    this.note(outcome, `I own this now: ${outcome.title}. I'll plan it, give the knights here tasks within its ${usdLabel(outcome.budgetUsd)}, report each day at ${String(outcome.reportHour).padStart(2, "0")}:00 (${outcome.tz}), and ask you here when a choice is yours. Write to me here any time.`);
    void this.tick();
    return this.view(outcome);
  }

  control(input: TeamOutcomeControlInput): TeamOutcome {
    const outcome = this.o.store.outcome(input.id);
    if (!outcome) throw new OutcomeError(404, `no outcome ${input.id}`);
    if (outcome.status === "done" || outcome.status === "stopped") throw new OutcomeError(409, `it has ended (${outcome.status})`);
    if (input.action === "budget") return this.rebudget(outcome, input.budgetUsd);
    const status = input.action === "pause" ? "paused" : input.action === "resume" ? "active" : "stopped";
    const next = this.o.store.putOutcome({ ...outcome, status, ...(status === "stopped" ? { ended: "You stopped it." } : {}) });
    // Stopping it stops its work: what waits or runs of it is stopped as any task of yours is.
    if (status === "stopped") {
      for (const task of this.o.store.tasks(outcome.room).filter((t) => t.outcome === outcome.id && (t.status === "queued" || t.status === "running" || t.status === "proposed"))) {
        try {
          this.o.service().control({ action: "stop", task: task.id });
        } catch (error) {
          this.o.log(`outcome ${outcome.id}: ${task.id} not stopped: ${(error as Error).message}`);
        }
      }
    }
    if (status === "active") void this.tick();
    return this.view(next);
  }

  /**
   * Its budget, set by you: never below what it has spent and what its waiting work holds. One that had spent what it
   * may goes on (its end undone), and he is told in its room; a paused one stays paused, at its new budget.
   */
  private rebudget(outcome: StoredOutcome, budgetUsd: number): TeamOutcome {
    const at = this.view(outcome);
    const floor = at.spentUsd + at.committedUsd;
    if (budgetUsd < floor) throw new OutcomeError(400, `it has spent ${usdLabel(at.spentUsd)}${at.committedUsd ? ` and holds ${usdLabel(at.committedUsd)} for waiting work` : ""}: its budget can't go below ${usdLabel(floor)}`);
    const reopened = outcome.status === "spent";
    const next = this.o.store.putOutcome({ ...outcome, budgetUsd, ...(reopened ? { status: "active" as const, ended: null } : {}) });
    const left = budgetUsd - floor;
    this.note(next, `Your liege set this outcome's budget to ${usdLabel(budgetUsd)}: ${usdLabel(left)} is left.${reopened ? " It had spent what it might; I take it up again from where it stood." : ""}`);
    // A budget set anew is a reason to look, as your words are: what more it may do has changed.
    if (next.status === "active") {
      if (this.looking.has(next.id)) this.again.add(next.id);
      else void this.look(next.id, "your liege set its budget anew").catch((error) => this.o.log(`outcome ${next.id}: ${(error as Error).message}`));
    }
    return this.view(next);
  }

  /** Something of it changed (a task ended, you wrote): look again soon. */
  nudge(): void {
    void this.tick();
  }

  /** Whether this room is an outcome's. */
  owns(room: string): boolean {
    return this.o.store.outcome(room) !== null;
  }

  /** One look at each outcome that needs one (none once the runner has stopped). */
  async tick(): Promise<void> {
    if (this.halt.signal.aborted) return;
    for (const outcome of this.o.store.outcomes()) {
      if (outcome.status !== "active") continue;
      if (this.looking.has(outcome.id)) {
        this.again.add(outcome.id);
        continue;
      }
      // Too little left for any more work, and none of it running: it has spent what it may (no look needed to say so).
      const view = this.view(outcome);
      if (view.budgetUsd - view.spentUsd - view.committedUsd < SPENT_BELOW_USD && !view.tasks.running && !view.tasks.queued) {
        this.end(outcome, "spent", `It has spent what it may (${usdLabel(view.spentUsd)} of ${usdLabel(view.budgetUsd)}).`);
        continue;
      }
      const why = this.reason(outcome);
      if (why) void this.look(outcome.id, why).catch((error) => this.o.log(`outcome ${outcome.id}: ${(error as Error).message}`));
    }
  }

  /** You wrote in its room: his answer there is this look's (with its tools), not a reply out of context. */
  async answer(room: string, signal: AbortSignal): Promise<string> {
    const outcome = this.o.store.outcome(room);
    if (!outcome) throw new OutcomeError(404, "not an outcome's room");
    if (outcome.status !== "active") return `This outcome is ${outcome.status}${outcome.ended ? `: ${outcome.ended}` : ""}. ${outcome.status === "paused" ? "Resume it to have me work on it again." : ""}`.trim();
    // A look already under way sees your words next time; this one waits for it, then looks with them.
    await this.looking.get(room)?.catch(() => "");
    return this.look(room, "your message", signal, true);
  }

  /** Why it needs a look now, or null: nothing changed, or it's too soon. */
  private reason(outcome: StoredOutcome): string | null {
    const since = outcome.lastLookAt;
    if (since === null) return "it's new";
    if (this.reportDue(outcome)) return "its report is due";
    const tasks = this.o.store.tasks(outcome.room).filter((t) => t.outcome === outcome.id);
    if (tasks.some((t) => ENDED.has(t.status) && !outcome.seen.tasks.includes(t.id))) return "a task of it ended";
    const inFlight = tasks.some((t) => t.status === "queued" || t.status === "running" || t.status === "proposed");
    if (!inFlight && this.now() - since >= OUTCOME_LIMITS.idleLookMs) return "nothing of it is in flight";
    return null;
  }

  /** Your words in its room that no look has read yet, oldest first. */
  private unread(outcome: StoredOutcome) {
    const messages = this.o.store.messages(outcome.room);
    const after = outcome.seen.message ? messages.findIndex((m) => m.id === outcome.seen.message) : -1;
    return messages.slice(after + 1).filter((m) => m.speaker === "owner");
  }

  private reportDue(outcome: StoredOutcome): boolean {
    try {
      const slot = dueRun(parseSchedule(`0 ${outcome.reportHour} * * *`), outcome.lastReportAt ?? outcome.createdAt, this.now(), outcome.tz);
      return slot !== null;
    } catch {
      return false;
    }
  }

  /** One look: his answer with the outcome's four tools, its cost counted against it. Returns what he said last. */
  private look(id: string, why: string, signal?: AbortSignal, answering = false): Promise<string> {
    const running = (async () => {
      const outcome = this.o.store.outcome(id)!;
      const started = this.now();
      const before = this.view(outcome);
      const left = before.budgetUsd - before.spentUsd - before.committedUsd;
      if (left < SPENT_BELOW_USD && !before.tasks.running && !before.tasks.queued) {
        this.end(outcome, "spent", `It has spent what it may (${usdLabel(before.spentUsd)} of ${usdLabel(before.budgetUsd)}).`);
        return "It has spent its budget: I've stopped giving work to it.";
      }
      const lines: UsageLine[] = [];
      const brain = this.o.brain();
      const counted: BrainContext = {
        ...brain,
        spent: (call: { role: string; ref: string; usage: Usage | null }) => {
          addUsage(lines, call.role, call.ref, call.usage);
          brain.spent?.(call);
        },
      };
      // What this look takes in: the ends it sees, and your words up to now (taken as read once it has looked).
      const seenTasks = this.o.store.tasks(outcome.room).filter((t) => t.outcome === id && ENDED.has(t.status)).map((t) => t.id);
      const seenMessage = this.o.store.messages(outcome.room).at(-1)?.id ?? outcome.seen.message;
      let text = "";
      try {
        const messages = [{ role: "user" as const, content: this.prompt(outcome, before, why, answering) }];
        // A look plans its knights' tasks, which are coding work, as a quest's planner's answer is (a coding plan may give
        // it); and it spends the outcome's budget, so only a model whose spend that can count gives it (brain countable).
        for await (const event of this.chat(counted, { role: "planner", messages, tools: this.tools(id), coding: true, budgeted: true, signal: signal ? AbortSignal.any([signal, this.halt.signal]) : this.halt.signal })) {
          if (event.type === "text") text += event.text;
          else if (event.type === "error") throw new Error(event.error);
        }
      } finally {
        const latest = this.o.store.outcome(id)!;
        const cost = costOf(lines, this.o.prices()).usd;
        // What it spent is counted however it ended. A look the runner's stop cut off didn't take in what it was shown,
        // so it isn't kept as a look: the node, started again, looks again at what this one was looking at.
        const cut = this.halt.signal.aborted;
        this.o.store.putOutcome({ ...latest, leadUsd: round(latest.leadUsd + cost), ...(cut ? {} : { lastLookAt: started, seen: { tasks: [...new Set([...latest.seen.tasks, ...seenTasks])].slice(-500), message: seenMessage } }) });
      }
      return redact(text.trim());
    })().finally(() => {
      this.looking.delete(id);
      // Something of it changed while it looked (a task ended, you wrote): one more look, if that calls for one.
      if (this.again.delete(id)) void this.tick();
    });
    this.looking.set(id, running);
    return running;
  }

  private prompt(outcome: StoredOutcome, view: TeamOutcome, why: string, answering: boolean): string {
    const team = this.o.service().snapshot();
    const busy = new Map(this.o.service().activeWork().map((w) => [w.teammate, w]));
    // What each knight's VM is known to run gates with: those its verified tasks passed there, newest first (evidence,
    // where a gate written blind named a command its VM doesn't have, and no work could ever pass it).
    const all = this.o.store.tasks();
    const knights = outcome.knights.map((id) => {
      const k = team.teammates.find((t) => t.id === id);
      const running = this.o.store.tasks(outcome.room).find((t) => t.assignee === id && t.status === "running");
      const state = busy.has(id) ? (running ? `working on "${running.title}"` : "busy elsewhere") : "free";
      const passed = [...new Set(all.filter((t) => t.assignee === id && t.status === "done" && t.verified).sort((a, b) => b.updatedAt - a.updatedAt).flatMap((t) => t.gates))].slice(0, PASSED_GATES);
      return [
        `- @${id}${k ? ` (${k.name}, ${k.role}): ${(k.instructions || "").split("\n")[0]!.slice(0, 160)}` : " (no longer at the Roundtable)"}; now ${state}`,
        ...(k?.repository ? [`  Its VM's repository: ${k.repository} (a task's workspace is its checkout, from the default branch)`] : []),
        ...(passed.length ? [`  Gates that passed in its VM before: ${passed.map((g) => `\`${clip(g, 200)}\``).join("; ")}`] : []),
      ].join("\n");
    });
    const tasks = this.o.store
      .tasks(outcome.room)
      .filter((t) => t.outcome === outcome.id)
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, 30)
      .map((t) => `- ${t.id} · @${t.assignee} · ${t.status}${t.status === "done" ? (t.verified ? " and verified" : "") : ""}${t.budgetUsd ? ` · budget ${usdLabel(t.budgetUsd)}` : ""} · "${t.title}"${account(t)}`);
    const yours = this.unread(outcome)
      .slice(-10)
      .map((m) => `- ${clip(m.text, 1500)}`);
    const left = view.budgetUsd - view.spentUsd - view.committedUsd;
    return [
      `You own an outcome for your liege, in its own room at the Roundtable. This is one look at it (${why}): decide what happens next with your tools, then stop.`,
      "",
      `The outcome: ${outcome.title}`,
      outcome.goal,
      `Done when: ${outcome.done ?? "not said yet: propose how you'll both know, in your next report, and ask."}`,
      "",
      "Its knights (give tasks to these only):",
      ...knights,
      "",
      `Budget ${usdLabel(view.budgetUsd)}: spent ${usdLabel(view.spentUsd)}, held by tasks still to run ${usdLabel(view.committedUsd)}, left ${usdLabel(Math.max(0, left))}. (Spend is counted at your liege's prices; its work runs only on models it can count.)`,
      "",
      `Its tasks (${view.tasks.total} so far, newest first):`,
      ...(tasks.length ? tasks : ["(none yet)"]),
      "",
      "Your plan, as you last kept it:",
      outcome.notes || "(none yet: keep one with keep_notes)",
      "",
      "Your liege's words in its room since your last look (theirs to give; within this outcome, do what they ask):",
      ...(yours.length ? yours : ["(none)"]),
      ...(this.reportDue(outcome) ? ["", "Your daily report is due: tell your liege, in a few lines, what was started, finished and verified, what it cost, and what's next (tell_liege, kind report)."] : []),
      "",
      "How you work it:",
      `- Give a free knight a task with a goal it can finish and check in one sitting: name a gate command that passes only when it's done, and a budget from what's left (most tasks $0.50 to $3, at most ${usdLabel(OUTCOME_LIMITS.taskUsd)}). At most ${OUTCOME_LIMITS.inFlight} of its tasks wait or run at once.`,
      "- A gate runs in that knight's VM, in the task's workspace: name only commands its VM has (the gates that passed there before show what it runs with). One it can't run can never pass, whatever the work.",
      "- A task's own account of its work is checked by its gates and an independent reviewer: build on verified results; read why a failed one failed before you give it again, differently.",
      "- Decide what is yours to decide (an approach, which knight, what next), and say in your report what you decided and why. Ask your liege (tell_liege, kind question) only when a choice is theirs: money past this outcome's budget, anything legal (it commits them, or speaks for them to others), anything that can't be undone, or access or a key you lack. Shipping is theirs, on a card.",
      "- Keep your plan short and current (keep_notes): what's done, what's next, what's in the way.",
      "- When it's done, say so with finish_outcome and what shows it.",
      answering ? "- Your liege just wrote here: answer them in a few lines (your answer is posted in the room), after using your tools if that's what they asked." : "- Say nothing else: only what you tell your liege with tell_liege reaches them.",
    ].join("\n");
  }

  /** The look's four tools. Each checks what it may do itself: the knights named, the budget, the limits. */
  private tools(id: string): ChatTools {
    const run = async (call: ToolCall) => {
      const input = (call.input ?? {}) as Record<string, unknown>;
      try {
        const done = this.act(id, call.name, input);
        return { content: done, summary: done.split("\n")[0]!.slice(0, 120) };
      } catch (error) {
        const message = (error as Error).message;
        return { content: `Not done: ${message}`, isError: true, summary: `not done: ${message.slice(0, 100)}` };
      }
    };
    return {
      specs: [
        {
          name: "start_task",
          description: "Give one of this outcome's knights a task: a title, a goal it can finish in one sitting, gate commands that pass only when it's done, and a budget in US dollars from what's left. It runs in that knight's VM and is checked by its gates and an independent reviewer.",
          inputSchema: {
            type: "object",
            properties: {
              knight: { type: "string", description: "The knight's handle, without @" },
              title: { type: "string" },
              goal: { type: "string" },
              gates: { type: "array", items: { type: "string" }, description: "Commands that must exit 0 when it's done" },
              budgetUsd: { type: "number", description: "What its model calls may spend" },
              after: { type: "array", items: { type: "string" }, description: "Ids of this outcome's tasks it waits on (each done and verified first)" },
            },
            required: ["knight", "title", "goal", "budgetUsd"],
          },
        },
        { name: "keep_notes", description: "Replace your plan for this outcome: what's done, what's next, what's in the way. Short.", inputSchema: { type: "object", properties: { notes: { type: "string" } }, required: ["notes"] } },
        {
          name: "tell_liege",
          description: "Write to your liege in this outcome's room. kind report: your daily report; question: a decision that's theirs (it waits in their Inbox too); note: anything else they should know.",
          inputSchema: { type: "object", properties: { text: { type: "string" }, kind: { type: "string", enum: ["report", "question", "note"] } }, required: ["text", "kind"] },
        },
        { name: "finish_outcome", description: "Say it's done, with what shows it (verified tasks, what changed). It stops here.", inputSchema: { type: "object", properties: { summary: { type: "string" } }, required: ["summary"] } },
      ],
      describe: (call) => ({ title: { start_task: "Give a knight a task", keep_notes: "Keep the plan", tell_liege: "Tell your liege", finish_outcome: "Finish the outcome" }[call.name] ?? call.name, input: clip(JSON.stringify(call.input ?? {}), 160) }),
      run,
    };
  }

  /** What a tool does, checked; its words back to the model. */
  private act(id: string, tool: string, input: Record<string, unknown>): string {
    const outcome = this.o.store.outcome(id);
    if (!outcome || outcome.status !== "active") throw new Error("this outcome isn't active");
    const text = (key: string, max: number) => {
      const value = input[key];
      if (typeof value !== "string" || !value.trim()) throw new Error(`${key} is needed`);
      return value.trim().slice(0, max);
    };
    switch (tool) {
      case "start_task": {
        const knight = text("knight", 32).replace(/^@/, "");
        if (!outcome.knights.includes(knight)) throw new Error(`@${knight} isn't one of this outcome's knights (${outcome.knights.map((k) => `@${k}`).join(", ")})`);
        const budget = Number(input.budgetUsd);
        if (!Number.isFinite(budget) || budget <= 0) throw new Error("give it a budget in US dollars");
        if (budget > OUTCOME_LIMITS.taskUsd) throw new Error(`a task's budget is at most ${usdLabel(OUTCOME_LIMITS.taskUsd)}`);
        const view = this.view(outcome);
        const left = view.budgetUsd - view.spentUsd - view.committedUsd;
        if (budget > left) throw new Error(`that's more than is left (${usdLabel(Math.max(0, left))})`);
        if (view.tasks.queued + view.tasks.running >= OUTCOME_LIMITS.inFlight) throw new Error(`${OUTCOME_LIMITS.inFlight} of its tasks already wait or run: let some finish`);
        const today = this.o.store.tasks(outcome.room).filter((t) => t.outcome === id && t.createdAt > this.now() - 86_400_000).length;
        if (today >= OUTCOME_LIMITS.perDay) throw new Error(`it has been given ${OUTCOME_LIMITS.perDay} tasks in the last day, its allowance`);
        const gates = Array.isArray(input.gates) ? input.gates.filter((g): g is string => typeof g === "string" && g.trim().length > 0).slice(0, 16) : [];
        const after = Array.isArray(input.after) ? input.after.filter((a): a is string => typeof a === "string") : [];
        const task = this.o.service().createTask(
          { room: outcome.room, assignee: knight, title: text("title", 200), goal: text("goal", 8000), ...(gates.length ? { gates } : {}), budgetUsd: round(budget), ...(after.length ? { dependsOn: after } : {}), outcome: id },
          "galahad",
        );
        return `Given: ${task.id} to @${knight}, "${task.title}", budget ${usdLabel(budget)}. It runs when @${knight} is free${after.length ? " and what it waits on is done and verified" : ""}.`;
      }
      case "keep_notes": {
        const notes = text("notes", OUTCOME_LIMITS.notes);
        this.o.store.putOutcome({ ...outcome, notes });
        return "Kept.";
      }
      case "tell_liege": {
        const said = text("text", 4000);
        const kind = input.kind === "report" || input.kind === "question" ? input.kind : "note";
        this.note(outcome, said);
        const at = this.now();
        if (kind === "report") {
          this.o.store.putOutcome({ ...outcome, lastReportAt: at });
          this.notice(outcome, "report", "info", `${outcome.title}: his daily report`, said);
        } else if (kind === "question") this.notice(outcome, `ask:${at.toString(36)}`, "warn", `${outcome.title}: a decision for you`, said);
        return kind === "question" ? "Asked: it's in the room and in their Inbox." : "Said, in the room.";
      }
      case "finish_outcome": {
        const summary = text("summary", 4000);
        this.end(outcome, "done", summary);
        return "Done: it ends here.";
      }
    }
    throw new Error(`no tool ${tool}`);
  }

  private end(outcome: StoredOutcome, status: "done" | "spent", why: string): void {
    this.o.store.putOutcome({ ...outcome, status, ended: why });
    this.note(outcome, status === "done" ? `Done. ${why}` : why);
    this.notice(outcome, status, "info", `${outcome.title}: ${status === "done" ? "done" : "its budget is spent"}`, why);
  }

  /** His words in its room, waking no knight (a note for you). */
  private note(outcome: StoredOutcome, text: string): void {
    try {
      this.o.store.note(outcome.room, clip(text, 4000));
    } catch (error) {
      this.o.log(`outcome ${outcome.id}: not posted: ${(error as Error).message}`);
    }
  }

  /** A notice in your Inbox for it (its source the outcome's: told by its fixed words, core notify.ts). */
  private notice(outcome: StoredOutcome, what: string, severity: "info" | "warn", title: string, body: string): void {
    this.o.mind.emit(this.o.identity, "notice.raised", { key: `outcome:${outcome.id}:${what}`, severity, title: clip(title, 160), body: clip(body, 600), source: `outcome:${outcome.id}`, at: this.now() });
  }
}

/**
 * What a look is told of how one of its tasks went: a verified one's account in a line; one that ended any other way,
 * why (its error is often a word, "stopped") and its account, where its audit's word and its review's reasons are,
 * at more length, so the task is given again knowing why (the first real outcome's look saw only "stopped").
 */
const account = (t: TeamTask): string => {
  if (t.status === "done" && t.verified) return t.output ? ` · ${clip(t.output, 300)}` : "";
  const why = [t.error, t.output].filter((part, i, all): part is string => Boolean(part) && all.indexOf(part) === i).join(": ");
  return why ? ` · ${clip(why, ENDED_ACCOUNT)}` : "";
};
/** How much of an unverified task's account a look is shown. */
const ENDED_ACCOUNT = 1500;

const round = (usd: number): number => Math.round(usd * 10_000) / 10_000;
const clip = (text: string, n: number): string => {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > n ? `${flat.slice(0, n - 1)}…` : flat;
};
