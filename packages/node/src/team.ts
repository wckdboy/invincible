import { z } from "zod";
import {
  TEAM_PRIMARY, TEAM_LIMITS, capLabel, TeamControlInput, TeamRoomId, type TeamSayInput, AgentId, TeamSteerInput, type TeamSteer,
  type Agent, type AgentInput, type TeamRecruitInput, type TeamRoom, type TeamRoomInput, type TeamPostInput, type TeamWorkspace,
  type TeamMessage, type TeamTask, type TeamTaskChanges, type TeamTaskInput, type TeamTaskRecord, type TeamTrailEntry, type TeamSnapshot, type TeamRoomView, type TeamOverview, type TeamSeenInput,
  type InterventionKind, type TeamWorkStatus, type TeamTaskFix, type TeamTaskShipped, type TeamMergeInput,
} from "../../core/src/team.ts";
import { CUT_OFF, TeamStore, TeamError, teamInput, teamOutput, teamText, WITHDRAWN, YOURS_STOPPED, type TeamAnswer, type TeamAsker, type TeamJob, type TeamSelection } from "./team-store.ts";

export { TeamError } from "./team-store.ts";
import type { TeamRunContext } from "@invincible/agents";
import type { TaskAccount } from "../../core/src/seats.ts";


export interface TeamServiceOptions {
  store: TeamStore;
  respond(agent: Agent, room: TeamRoom, history: TeamMessage[], context: TeamRunContext): Promise<string | { text: string }>;
  executeTask(agent: Agent, task: TeamTask, context: TeamRunContext): Promise<{ verified: boolean; output: string; error?: string; record?: TeamTaskRecord; changes?: TeamTaskChanges; rest?: { until: number; why: string } }>;
  /** The primary's answer in a room it was asked in (TeamStore.post says when): its words, posted for it. Absent: it
   * sits in no room on this node, and what was for it waits. */
  answer?(room: TeamRoom, history: TeamMessage[], ask: { asker: TeamAsker; trigger: TeamMessage | null }, signal: AbortSignal): Promise<string>;
  concurrency?: number;
  timeoutMs?: number;
  /** A task's own limit (work in a repository takes longer than a reply); absent: the same as `timeoutMs`; null: none (an agent's task, which its audit watches instead). */
  taskTimeoutMs?: number | null;
  /** Shutdown waits this long for callbacks to settle, then leaves their persisted state interrupted. */
  shutdownGraceMs?: number;
  /** How long work a planned restart cut off waits before it is taken up again by itself: until whatever it was running
   * in its agent's VM has surely met its own deadline there (team-runtime's TEAM_COMMAND_SECONDS). Absent: at once. */
  restartWaitMs?: number;
  /** How often the controller looks again at what has come due (a daily budget, work a restart cut off): 15 s. */
  tickMs?: number;
  onChange?(): void;
  /** An agent seated by the primary (in your conversation) or by another agent (in its room): for the record. */
  onRecruit?(made: Agent): void;
  /** A task's run has ended, however it ended (an outcome it is a step of looks again: outcomes.ts). */
  onTaskEnded?(task: TeamTask): void;
  /** What is left of your usage budget now, in US dollars (usage.ts meter; null: you set none): what it starts on its own yes must fit it. */
  budgetLeft?(): number | null;
  /**
   * Why a task another node handed over may not be taken up again by its id (yours, the one resume that reaches it), or
   * null when it may (fabric/handoff.ts resumable). Absent: it may.
   */
  mayResumeHanded?(task: TeamTask): string | null;
  /** A task another node handed over, taken up again by its id: the hand-offs follow it from now (handoff.ts resumed). */
  resumedHanded?(task: TeamTask): void;
}

/** What the primary may still commit on its own word (TeamService.ownLeft), with what that is said against: what approved
 * work holds of your budget, and its daily cap. */
export type OwnBound = { usd: number; of: "budget" | "day"; held: number; daily: number };

interface Active {
  job: TeamJob;
  controller: AbortController;
  done: Promise<void>;
  timer: ReturnType<typeof setTimeout> | null;
}

/** The primary answers in this many rooms at once, and takes this long at most over one answer. */
const ANSWERS = { atOnce: 3, timeoutMs: 10 * 60_000 } as const;

const Destination = z.union([z.strictObject({ room: TeamRoomId }), z.strictObject({ agent: AgentId })]);
const selected = (job: TeamJob, select: TeamSelection): boolean => (!select.room || job.room === select.room) && (!select.agent || job.agent === select.agent) && (!select.task || job.id === select.task);

/** A single controller schedules named agents. The injected runner owns models and VM transport;
 * this service owns identity, delivery, persistence, budgets, dependencies and exclusive access. */
export class TeamService {
  private readonly active = new Map<string, Active>();
  /** Its answers under way, by answer. */
  private readonly answering = new Map<string, { answer: TeamAnswer; controller: AbortController; done: Promise<void> }>();
  /** Workers on their way out: between the pause and the record's retirement nothing may bring one back. */
  private readonly removing = new Set<string>();
  private readonly concurrency: number;
  private readonly timeoutMs: number;
  private readonly taskTimeoutMs: number | null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;
  private scheduled = false;
  private stopping: Promise<void> | null = null;

  constructor(private readonly options: TeamServiceOptions) {
    this.concurrency = Math.max(1, Math.min(16, Math.trunc(options.concurrency ?? 4)));
    this.timeoutMs = Math.max(1, Math.min(2 * 60 * 60_000, options.timeoutMs ?? 30 * 60_000));
    this.taskTimeoutMs = options.taskTimeoutMs === null ? null : Math.max(1, Math.min(2 * 60 * 60_000, options.taskTimeoutMs ?? this.timeoutMs));
  }

  get store(): TeamStore { return this.options.store; }
  /** Who is at work now: a fresh projection, with no database or output payloads. */
  activeWork(): readonly { agent: string; room: string; kind: "delivery" | "task" }[] {
    return [...this.active.values()].map(({ job }) => ({ agent: job.agent, room: job.room, kind: job.kind }));
  }
  snapshot(): TeamSnapshot { return this.store.snapshot(); }
  room(id: string): TeamRoomView { return this.store.roomView(id); }
  /** You looked at an agent's page or a room (one that is here). */
  see(input: TeamSeenInput): void {
    if ("agent" in input) {
      if (!this.store.agent(input.agent)) throw new TeamError(404, "No such agent at the table.");
      this.store.see(`agent:${input.agent}`);
    } else {
      this.store.requireRoom(input.room);
      this.store.see(`room:${input.room}`);
    }
  }
  messages(room: string, limit?: number): TeamMessage[] { return this.store.messages(room, limit); }
  saveAgent(input: AgentInput): Agent {
    this.accepting();
    this.steady((input as { id?: unknown } | null)?.id);
    const saved = this.store.saveAgent(input);
    if (!saved.enabled) this.cancel({ agent: saved.id }, "interrupted", "Paused by you.");
    this.changed(); this.kick();
    return saved;
  }
  /**
   * You stepped in (#28): on a task by its id, or on the work running now of an agent or a room. Counted on each such task
   * by how, with a line on its trail; the caller is a route that only you may call.
   */
  steppedIn(on: TeamSelection, kind: InterventionKind, text: string): void {
    if (!on.task && !on.agent && !on.room) return;
    const tasks = on.task ? [on.task] : this.store.tasksIn(on, ["running"]).map((task) => task.id);
    let counted = false;
    for (const task of tasks) counted = this.store.intervene(task, kind, text) || counted;
    if (counted) this.changed();
  }
  /** A line on a task's trail from outside its run (a skill its verified work taught), shown on every device. */
  noteTask(task: string, text: string): void {
    this.store.noteTask(task, text);
    this.changed();
  }
  /** A task's work, shipped as a pull request on your word. */
  markShipped(task: string, shipped: TeamTaskShipped): void {
    this.store.markShipped(task, shipped);
    this.changed();
  }
  setWorkspace(id: string, binding: TeamWorkspace | null): Agent {
    this.accepting();
    this.steady(id);
    if (this.active.has(id) && this.store.requireAgent(id).workspace) throw new TeamError(409, "Stop this agent's work before changing its workspace.");
    const saved = this.store.setWorkspace(id, binding);
    this.changed();
    return saved;
  }
  remember(id: string, text: string): Agent { this.accepting(); const saved = this.store.remember(id, text); this.changed(); return saved; }
  /** The primary's own computer bound, or no longer: yours to make, as an agent's VM is. */
  setComputer(binding: TeamWorkspace | null): TeamWorkspace | null { this.accepting(); const saved = this.store.setComputer(binding); this.changed(); return saved; }
  /** The VMs' notes store, for every agent here: a task reads the switch as it starts, so one that is running is not changed. */
  setEngram(on: boolean): boolean { this.accepting(); const set = this.store.setEngram(on); this.changed(); return set; }
  /** Whether failing checks go back to the agent whose work it was, outside an outcome too (ci-back.ts reads it when they fail). */
  setCiBack(on: boolean): boolean { this.accepting(); const set = this.store.setCiBack(on); this.changed(); return set; }
  setBacklog(on: boolean): boolean { this.accepting(); const set = this.store.setBacklog(on); this.changed(); return set; }
  /** Whether it merges its agents' proven work itself in a repository: yours to turn off there, and on again. */
  setMerge(input: TeamMergeInput): TeamMergeInput { this.accepting(); const set = this.store.setMerge(input); this.changed(); return set; }
  /**
   * Work proposed to an agent, waiting for a yes: the primary's from your backlog (backlog.ts), which it may approve
   * itself; or a task another node handed over beyond your grant (`node:<id>`, fabric/handoff.ts), which only you approve.
   */
  proposeTask(input: TeamTaskInput, by: string = TEAM_PRIMARY): TeamTask { this.accepting(); const task = this.store.createTask(input, { givenBy: by, propose: true }); this.changed(); return task; }
  /** What the primary may commit on its own word in a day while you set no usage budget: yours to set, never its. */
  ownDaily(): number { return this.store.ownDaily(); }
  setOwnDaily(usd: number): number { this.accepting(); const set = this.store.setOwnDaily(usd); this.changed(); return set; }
  /**
   * What the primary may still commit on its own word now, to the cent (money is yours past it: your word, 23 November
   * 2026). With a usage budget of yours, what is left of it past what approved work holds (TeamStore.heldUsd: the budgets
   * of the tasks queued or running, whoever gave them, as an outcome holds its own); with none, what is left of its own
   * daily cap, yours to set, past what it committed in the last day (TeamStore.ownCommitted).
   */
  ownLeft(): { usd: number; of: "budget" | "day" } {
    const { usd, of } = this.ownBound();
    return { usd, of };
  }
  private ownBound(): OwnBound {
    const left = this.options.budgetLeft?.() ?? null;
    const held = this.store.heldUsd();
    const daily = this.store.ownDaily();
    const usd = left !== null ? left - held : daily - this.store.ownCommitted();
    return { usd: Math.max(0, Math.round(usd * 100) / 100), of: left !== null ? "budget" : "day", held, daily };
  }
  /** What a commitment on its own word was within, as its trail says it. */
  private within(bound: OwnBound): string {
    return bound.of === "budget"
      ? `and of the $${bound.usd.toFixed(2)} left of yours${bound.held > 0 ? " past what approved work holds" : ""}`
      : `and of the $${bound.usd.toFixed(2)} left of the ${capLabel(bound.daily)} a day it may commit on its own`;
  }
  /**
   * Whether the primary may commit `budget` on its own word now: a budget named, at most TEAM_LIMITS.ownTaskUsd, that
   * fits what it may still commit (ownLeft). Throws why not, the work being yours to give; else the bound it fits.
   */
  mayGiveOwn(budget: number | undefined): OwnBound {
    if (budget === undefined || budget > TEAM_LIMITS.ownTaskUsd) throw new TeamError(400, `A task your agent gives on its own word names its budget, ${capLabel(TEAM_LIMITS.ownTaskUsd)} at most: more is yours to give.`);
    const bound = this.ownBound();
    if (bound.usd < budget) throw new TeamError(409, `${this.past(bound)} Give it among the agents yourself.`);
    return bound;
  }
  /** What is left that a commitment past it meets, as a refusal says it. */
  private past(bound: OwnBound): string {
    const left = bound.of === "budget"
      ? `$${bound.usd.toFixed(2)} is left of your budget${bound.held > 0 ? " past what approved work holds" : ""}`
      : `$${bound.usd.toFixed(2)} is left of the ${capLabel(bound.daily)} a day it may commit on its own (yours to set: invincible agents daily)`;
    return `That's past what your agent may commit on its own: ${left}.`;
  }
  /**
   * The bound a task's budget fits, committed again on the primary's own word (approving it, taking it up again), or why
   * not: no budget (money nobody capped), more than TEAM_LIMITS.ownTaskUsd, or more than it may still commit (ownLeft).
   * `yours`: what you would do then; `instead`: what the refusal ends on.
   */
  private ownMoney(budget: number | undefined, yours: string, instead: string): OwnBound {
    if (budget === undefined) throw new TeamError(409, `It names no budget: money nobody capped is yours to ${yours}.`);
    if (budget > TEAM_LIMITS.ownTaskUsd) throw new TeamError(409, `It may spend $${budget}, more than the ${capLabel(TEAM_LIMITS.ownTaskUsd)} a task your agent may commit on its own: yours to ${yours}.`);
    const bound = this.ownBound();
    if (bound.usd < budget) throw new TeamError(409, `${this.past(bound)} ${instead}`);
    return bound;
  }
  /**
   * A task the primary gives on its own word (team_give, team_again, from your conversation): within mayGiveOwn, judged
   * again as it is written (nothing between the two awaits) so two at once can't both take what one fits. It waits its
   * turn like any task, and its trail says whose word it was (`said`) and what it was within.
   */
  giveOwn(input: TeamTaskInput, said = "Given by your agent on its own word", fix?: TeamTaskFix): TeamTask {
    this.accepting();
    // Never behind a pause of yours: it would wait there, holding its money, and run the moment you resume (the review of
    // 27 November, S1), as work given again would (againOwn).
    if (this.store.agent(input.assignee)?.enabled === false) throw new TeamError(409, `You paused @${input.assignee}: giving it work is yours.`);
    if (this.store.room(input.room)?.paused) throw new TeamError(409, "Its conversation is paused: giving work in it is yours.");
    const bound = this.mayGiveOwn(input.budgetUsd);
    const task = this.store.createTask(input, { givenBy: TEAM_PRIMARY, own: true, ...(fix ? { fix } : {}) });
    this.store.noteTask(task.id, `${said}, within its budget of $${input.budgetUsd}, ${this.within(bound)}`.slice(0, 500));
    this.changed();
    this.kick();
    return task;
  }
  /**
   * A proposed task, its own from your backlog or an agent's from a room, started on its own yes (your word, 23 November
   * 2026: it approves its own decisions and its agents'; what is monetary asks you): only when it names its budget, at
   * most TEAM_LIMITS.ownTaskUsd, and that fits what it may still commit on its own (ownLeft). It waits its turn like any
   * task, and its trail says whose yes it was, why, and what it was within. Null when it isn't its to approve: it waits
   * for yours (approveOwnOrSay says why).
   */
  approveOwn(task: string, why: string): TeamTask | null {
    this.accepting();
    try {
      return this.approveOwnOrSay(task, why);
    } catch (error) {
      if (error instanceof TeamError) return null;
      throw error;
    }
  }
  /** Its yes to a proposal (approveOwn), from your conversation (team_approve): why not, said, when it isn't its to give. */
  approveOwnOrSay(task: string, why: string): TeamTask {
    this.accepting();
    const proposed = this.proposal(task);
    // A task another node handed over beyond your grant is yours alone to approve, whatever it would spend.
    if (proposed.proposedBy?.startsWith("node:")) throw new TeamError(403, "Another node handed it over beyond your grant: approving it is yours alone, whatever it would spend.");
    const bound = this.ownMoney(proposed.budgetUsd, "approve", "Approve it yourself, or decline it.");
    const approved = this.store.approve(task, true);
    this.store.noteTask(task, `Approved by your agent itself: ${why}, within its budget of $${proposed.budgetUsd}, ${this.within(bound)}`.slice(0, 500));
    this.changed();
    this.kick();
    return approved;
  }
  /**
   * One task ended now, in these words, by no word of yours: another node's hand-off that nobody follows any more, or
   * one your grant for it was revoked under (fabric/handoff.ts). Running, queued, waiting for you, or cut off by a crash;
   * ended ones stay.
   */
  stopTask(task: string, why: string): void {
    this.accepting();
    const found = this.store.task(task);
    if (found?.status === "interrupted") {
      this.store.endInterrupted(task, why);
      this.changed();
      return;
    }
    if (!found || (found.status !== "running" && found.status !== "queued" && found.status !== "proposed")) return;
    this.cancel({ task }, "stopped", why);
    this.store.finish(task, "stopped", why);
    this.changed();
    this.kick();
  }
  private proposal(task: string): TeamTask {
    const proposed = this.store.task(task);
    if (!proposed) throw new TeamError(404, "No such team task.");
    if (proposed.status !== "proposed") throw new TeamError(409, "That task isn't a proposal waiting for a yes.");
    return proposed;
  }
  /**
   * A proposal it declines (team_approve): an agent's is said to be declined by it, never by you; one of its own (from
   * your backlog) is withdrawn, as the backlog says it, so the backlog never takes it for one you declined. It never ran.
   */
  declineOwn(task: string, why: string): TeamTask {
    this.accepting();
    const proposed = this.proposal(task);
    const said = (proposed.proposedBy === TEAM_PRIMARY ? `${WITHDRAWN}: ${why}.` : `Declined by your agent: ${why}`).slice(0, 500);
    this.store.finish(task, "stopped", said);
    this.store.noteTask(task, said);
    this.changed();
    return this.store.task(task)!;
  }
  /** Work it stops (team_stop): waiting or running, said as its, and taken up again by it (resumeOwn) or by you. */
  stopOwn(task: string, why: string): TeamTask {
    this.accepting();
    const work = this.store.task(task);
    if (!work) throw new TeamError(404, "No such team task.");
    if (work.status === "proposed") throw new TeamError(409, "A proposal is declined, not stopped: approve it or decline it.");
    if (work.status !== "queued" && work.status !== "running") throw new TeamError(409, `Only work that is waiting or running is stopped: this one is ${work.status}.`);
    const said = `Stopped by your agent: ${why}`.slice(0, 500);
    this.cancel({ task }, "stopped", said);
    this.store.finish(task, "stopped", said);
    this.store.noteTask(task, said);
    this.changed();
    this.kick();
    return this.store.task(task)!;
  }
  /**
   * Work it takes up again (team_resume): what stopped, failed or a restart cut off, its budget committed again on its own
   * word, as a run spends it anew (ownMoney). Never what you stopped, paused or declined (your word stands), nor what a
   * crash cut off mid-work (what it had done is yours to review), nor a step of an outcome (its outcome's to give again,
   * within its budget), nor work whose agent or conversation you paused.
   */
  resumeOwn(task: string, why: string): TeamTask {
    this.accepting();
    const work = this.store.task(task);
    if (!work) throw new TeamError(404, "No such team task.");
    if (work.status !== "stopped" && work.status !== "failed" && work.status !== "interrupted") throw new TeamError(409, `Only work that stopped, failed or was cut off is taken up again: this one is ${work.status}.`);
    const yoursSaid = work.error === null ? undefined : YOURS_STOPPED.get(work.error);
    if (yoursSaid) throw new TeamError(409, `${yoursSaid}: taking it up again is yours.`);
    if (work.error === CUT_OFF) throw new TeamError(409, "A crash cut it off mid-work: what it had done is yours to review before it runs again.");
    const hold = this.store.restartHold(task);
    if (hold === "waits") throw new TeamError(409, "A restart cut it off, and it is taken up again by itself once the command it was running has surely ended: leave it be.");
    if (hold === "yours") throw new TeamError(409, "A restart cut it off a second time: what it had done is yours to review before it runs again.");
    if (work.outcome) throw new TeamError(409, "It is a step of an outcome, which gives its work again within its own budget.");
    if (this.store.agent(work.assignee)?.enabled === false) throw new TeamError(409, "You paused its agent: taking its work up again is yours.");
    if (this.store.room(work.room)?.paused) throw new TeamError(409, "Its conversation is paused: taking its work up again is yours.");
    if ([...this.active.values()].some((a) => a.job.id === task)) throw new TeamError(409, "This work is still stopping. Wait for its current command to finish.");
    const bound = this.ownMoney(work.budgetUsd, "take up again", "Take it up again yourself.");
    this.store.resume({ task });
    this.store.commitOwn(`${task}@${this.store.now()}`, work.budgetUsd!);
    this.store.noteTask(task, `Taken up again by your agent: ${why}, within its budget of $${work.budgetUsd}, ${this.within(bound)}`.slice(0, 500));
    const resumed = this.store.task(task)!;
    this.changed();
    this.kick();
    return resumed;
  }
  /**
   * Work it gives again (team_again): to the same agent in the same conversation, its title, goal and gates the old ones
   * unless it gives its own, from a step of it when `from` names one, held to the same models when the old one was in
   * sensitive mode (yours, kept, never its to name); on its own word and within its money (giveOwn), its budget at most
   * TEAM_LIMITS.ownTaskUsd, the old one's when that is less. Not what is still under way, nor a step of an outcome.
   */
  againOwn(task: string, give: { why: string; from?: number; goal?: string; gates?: string[]; budgetUsd?: number }): TeamTask {
    this.accepting();
    const before = this.store.task(task);
    if (!before) throw new TeamError(404, "No such team task to give again.");
    if (before.status === "queued" || before.status === "running" || before.status === "proposed") throw new TeamError(409, "It hasn't ended: steer it, or stop it first.");
    if (before.outcome) throw new TeamError(409, "It is a step of an outcome, which gives its work again within its own budget.");
    // What you stopped or declined, or work of an agent or a conversation you paused, is yours to give again, as it is
    // yours to take up again (resumeOwn; the review of 27 November, N4).
    const yoursSaid = before.error === null ? undefined : YOURS_STOPPED.get(before.error);
    if (yoursSaid) throw new TeamError(409, `${yoursSaid}: giving it again is yours.`);
    if (this.store.agent(before.assignee)?.enabled === false) throw new TeamError(409, "You paused its agent: giving its work again is yours.");
    if (this.store.room(before.room)?.paused) throw new TeamError(409, "Its conversation is paused: giving its work again is yours.");
    // Its gates stay: it may add to them, never drop or replace one (what proves the work again is at least what proved it).
    const dropped = before.gates.filter((gate) => give.gates !== undefined && !give.gates.includes(gate));
    if (dropped.length) throw new TeamError(409, `Its gates stay when it is given again: ${dropped.join(", ")} would be dropped. Add gates, never drop or replace them.`);
    const budgetUsd = give.budgetUsd ?? Math.min(before.budgetUsd ?? TEAM_LIMITS.ownTaskUsd, TEAM_LIMITS.ownTaskUsd);
    const input: TeamTaskInput = {
      room: before.room,
      assignee: before.assignee,
      title: before.title,
      goal: give.goal ?? before.goal,
      gates: give.gates ?? before.gates,
      budgetUsd,
      ...(give.from ? { from: { task: before.id, step: give.from } } : {}),
      ...(before.models?.length ? { models: before.models } : {}),
    };
    return this.giveOwn(input, `Given again by your agent after “${before.title}” (${before.id})${give.from ? `, from its step ${give.from}` : ""}: ${give.why}`);
  }
  /** One it proposed, taken back before you answered it (backlog.ts: its step done, or another first): it never ran. */
  withdrawProposal(task: string, why: string): void {
    this.accepting();
    if (this.store.task(task)?.status !== "proposed") return;
    this.store.finish(task, "stopped", why);
    this.changed();
  }
  planWorkspace(id: string, node: string): Agent {
    this.accepting();
    this.steady(id);
    if (this.active.has(id) && this.store.requireAgent(id).workspace) throw new TeamError(409, "Stop this agent's work before provisioning its workspace.");
    const saved = this.store.planWorkspace(id, node); this.changed(); return saved;
  }
  saveRoom(input: TeamRoomInput): TeamRoom {
    this.accepting();
    const saved = this.store.saveRoom(input);
    for (const work of this.active.values()) if (work.job.room === saved.id && !saved.members.includes(work.job.agent)) this.cancel({ agent: work.job.agent, room: saved.id }, "stopped", "Removed from this room.");
    this.changed(); this.kick();
    return saved;
  }
  direct(agent: string): TeamRoom { this.accepting(); const room = this.store.direct(agent); this.changed(); return room; }
  /** Your words to a room, from the device you wrote on (`asker`), whose own scopes the primary answers with. */
  post(input: TeamPostInput, asker?: Exclude<TeamAsker, { kind: "agent" }>): TeamMessage { this.accepting(); const message = this.store.post(input, asker ? { asker } : {}); this.changed(); this.kick(); return message; }
  /** Its workers as the primary itself reads them. */
  overview(room?: string): TeamOverview { return this.store.overview(room); }
  /** What was said in the conversations an agent is part of (its own with you and other agents included) that holds every word of `query`. */
  search(agent: string, query: string): { room: string; speaker: string; speakerName: string; text: string; at: string }[] {
    const rooms = this.store.rooms().filter((room) => room.members.includes(agent)).map((room) => room.id);
    return this.store.searchMessages(rooms, query).map(({ room, speaker, speakerName, text, createdAt }) => ({ room, speaker, speakerName, text: text.length > 600 ? `${text.slice(0, 599)}…` : text, at: new Date(createdAt).toISOString() }));
  }
  /** A room's story so far, and keeping it told anew (TeamStore.story). */
  story(room: string): { text: string; through: string } | null { return this.store.story(room); }
  keepStory(room: string, text: string, through: string): void { this.accepting(); this.store.keepStory(room, text, through); }
  /** The primary itself, from your conversation with it: a new worker of its own. */
  recruit(input: TeamRecruitInput): Agent {
    this.accepting();
    const made = this.store.recruit(input, TEAM_PRIMARY);
    this.recruited(made);
    return made;
  }
  /** The primary itself, from your conversation with it: its words to one worker (where you talk with it too) or to a room. */
  say(input: TeamSayInput): TeamMessage {
    this.accepting();
    const message = this.store.say(input);
    this.changed(); this.kick();
    return message;
  }
  createTask(input: TeamTaskInput, givenBy?: string, fix?: TeamTaskFix): TeamTask { this.accepting(); const task = this.store.createTask(input, { ...(givenBy ? { givenBy } : {}), ...(fix ? { fix } : {}) }); this.changed(); this.kick(); return task; }
  /**
   * Your words, or your agent's, to a running task (core's TeamSteerInput): by its id, or as the task an agent is running
   * now. Kept on it (TeamStore.steer) until its run takes them at its next safe point; refused in words when it isn't
   * running. The caller is the route that may: yours (fleet:admin), or your agent's own (its team_steer).
   */
  steer(raw: TeamSteerInput, by: TeamSteer["by"]): { task: TeamTask; steer: TeamSteer } {
    this.accepting();
    const input = teamInput(TeamSteerInput, raw);
    let id = input.task;
    if (!id) {
      const agent = this.store.requireAgent(input.agent!);
      const running = this.store.runningTaskOf(agent.id);
      if (!running) throw new TeamError(409, `${agent.name} isn't at work on a task now: say it in its conversation, or give it a task.`);
      id = running.id;
    }
    const steer = this.store.steer(id, by, input.text);
    this.changed();
    return { task: this.store.task(id)!, steer };
  }

  start(): void {
    if (this.running) return;
    if (this.stopping) throw new TeamError(409, "This team controller has stopped.");
    this.store.recover();
    this.store.resumeRestarted();
    this.running = true;
    // A daily budget can become available while nobody has the page open, and work a restart cut off comes due.
    this.timer = setInterval(() => { if (this.store.resumeRestarted() || this.active.size) this.changed(); this.kick(); }, this.options.tickMs ?? 15_000);
    this.kick();
  }

  stop(): Promise<void> {
    if (this.stopping) return this.stopping;
    this.stopping = this.shutdown();
    return this.stopping;
  }
  private async shutdown(): Promise<void> {
    this.running = false;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    // The node is stopping on purpose (a deploy, an update): what it cuts off is taken up again after the restart, once,
    // when its VM command has surely ended (TeamStore.interruptForRestart). A crash leaves no such mark (recover()).
    const wait = this.options.restartWaitMs ?? 0;
    for (const active of this.active.values()) {
      this.store.interruptForRestart(active.job.id, this.store.now() + wait, Math.max(1, Math.ceil(wait / 60_000)));
      if (active.timer) clearTimeout(active.timer);
      active.timer = null;
      active.controller.abort(new Error("The node is restarting."));
    }
    // An answer of its is never given twice: one cut off is said to be, and is yours to ask for again.
    for (const { answer, controller } of this.answering.values()) {
      this.store.finishAnswer(answer.id, "interrupted", "The node restarted while your agent was answering. Ask it again.");
      controller.abort(new Error("The node is restarting."));
    }
    this.changed();
    // A runner that ignores cancellation keeps its agent's lock until it really ends. Shutdown itself is bounded.
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([Promise.all([...this.active.values(), ...this.answering.values()].map((a) => a.done)), new Promise<void>((resolve) => { timer = setTimeout(resolve, this.options.shutdownGraceMs ?? 10_000); })]);
    if (timer) clearTimeout(timer);
  }

  /** A task by its id, or null. */
  task(id: string): TeamTask | null {
    return this.store.task(id);
  }
  /** The tasks in any of these states: one by its id, an agent's or a room's. */
  tasksIn(select: TeamSelection, statuses: readonly TeamWorkStatus[]): TeamTask[] {
    return this.store.tasksIn(select, statuses);
  }
  /** What a task did, as it happened (TeamStore.trail), with its status now. */
  trail(task: string, after = 0): { task: { id: string; status: TeamTask["status"] }; entries: TeamTrailEntry[]; more: boolean } {
    const found = this.store.task(task);
    if (!found) throw new TeamError(404, "No such team task.");
    return { task: { id: found.id, status: found.status }, ...this.store.trail(task, after) };
  }

  control(raw: TeamControlInput): TeamSnapshot {
    this.accepting();
    const input = teamInput(TeamControlInput, raw);
    const select: TeamSelection = { ...(input.room ? { room: input.room } : {}), ...(input.agent ? { agent: input.agent } : {}), ...(input.task ? { task: input.task } : {}) };
    if (input.room) this.store.requireRoom(input.room);
    if (input.agent) { this.store.requireAgent(input.agent); this.steady(input.agent); }
    if (input.task && !this.store.task(input.task)) throw new TeamError(404, "No such team task.");
    if (input.action === "approve") {
      this.store.approve(input.task!);
      this.changed(); this.kick();
      return this.snapshot();
    }
    if (input.action === "resume") {
      // A callback may still be winding down its VM command. It cannot be overlapped by a retry.
      if ([...this.active.values()].some((a) => selected(a.job, select))) throw new TeamError(409, "This work is still stopping. Wait for its current command to finish.");
      // Another node's task, named by its id: only while its node and what it was taken under hold, and followed from
      // then, as one handed over now would be (the third re-review's R3-6).
      const handed = input.task ? this.store.task(input.task) : null;
      const given = handed?.givenBy?.startsWith("node:") === true ? handed : null;
      if (given) {
        const why = this.options.mayResumeHanded?.(given) ?? null;
        if (why) throw new TeamError(409, why);
      }
      if (input.room) this.store.pauseRoom(input.room, false);
      if (input.agent) this.store.enable(input.agent, true);
      this.store.resume(select);
      if (given && this.store.task(given.id)?.status === "queued") this.options.resumedHanded?.(given);
    } else {
      if (input.room) this.store.pauseRoom(input.room, true);
      if (input.agent) this.store.enable(input.agent, false);
      const state = input.action === "pause" ? "interrupted" : "stopped";
      this.cancel(select, state, input.action === "pause" ? "Paused by you." : "Stopped by you.");
      this.store.holdRestarts(select, state, input.action === "pause" ? "Paused by you." : "Stopped by you.");
      if (input.action === "stop" || input.task) this.store.stopQueued(select);
    }
    this.changed(); this.kick();
    return this.snapshot();
  }

  /**
   * Take a worker out for good, which is yours alone to ask. It is paused and its running work stopped first; if
   * that work is still winding down when the wait is over, the removal is refused and the worker stays, paused.
   * A workspace goes only through `release`, which the caller gives to destroy whatever VM the worker has (bound
   * here or not): with none given, a bound worker's removal is refused before anything is touched, and if the
   * release fails the worker stays too, paused and still bound. Only then is its record retired
   * (TeamStore.remove), so neither running work nor a workspace is ever left behind by it.
   */
  async remove(id: string, options: { release?(member: Agent): Promise<void>; waitMs?: number } = {}): Promise<Agent> {
    this.accepting();
    const member = this.store.requireAgent(id);
    this.steady(id);
    if (member.workspace && !options.release) throw new TeamError(409, `${member.name} has a persistent workspace. Removing ${member.name} destroys it and everything in it: say so, or pause ${member.name} instead.`);
    this.removing.add(id);
    try {
      this.store.enable(id, false);
      this.cancel({ agent: id }, "stopped", "Stopped to remove its agent.");
      const winding = this.active.get(id);
      if (winding) {
        let timer: ReturnType<typeof setTimeout> | undefined;
        await Promise.race([winding.done, new Promise<void>((resolve) => { timer = setTimeout(resolve, options.waitMs ?? 10_000); })]);
        if (timer) clearTimeout(timer);
        this.accepting();
      }
      // A callback may still be winding down its VM command: its agent's record and workspace must outlast it.
      if (this.active.has(id)) throw new TeamError(409, "This agent's work is still stopping. It is paused now: remove it once its current command has finished.");
      const bound = this.store.requireAgent(id);
      if (options.release) await options.release(bound);
      else if (bound.workspace) throw new TeamError(409, "This agent has a workspace and nothing was given to release it.");
      // What was released is gone: the record follows it at once, even if the controller has begun to stop meanwhile.
      if (bound.workspace) this.store.setWorkspace(id, null);
      return this.store.remove(id);
    } finally {
      this.removing.delete(id);
      if (!this.stopping) { this.changed(); this.kick(); }
    }
  }

  /** Useful to tests and shutdown callers: waits for currently runnable work, not blocked dependencies. */
  async settled(): Promise<void> {
    for (;;) {
      await Promise.resolve();
      this.pump();
      const active = [...this.active.values(), ...this.answering.values()].map((a) => a.done);
      if (!active.length) return;
      await Promise.all(active);
    }
  }

  private accepting(): void { if (this.stopping) throw new TeamError(409, "This team controller has stopped."); }
  private steady(id: unknown): void { if (typeof id === "string" && this.removing.has(id)) throw new TeamError(409, "This agent is being removed."); }
  private changed(): void { try { this.options.onChange?.(); } catch { /* an observer cannot stop the scheduler */ } }
  private recruited(made: Agent): void {
    try { this.options.onRecruit?.(made); } catch { /* nor undo what was made */ }
    this.changed(); this.kick();
  }
  private kick(): void {
    if (!this.running || this.scheduled) return;
    this.scheduled = true;
    queueMicrotask(() => { this.scheduled = false; this.pump(); });
  }
  private pump(): void {
    if (!this.running) return;
    // An agent whose cut-off work waits out a restart may still have its last command running in its VM.
    const waiting = this.store.restartWaits();
    for (const job of this.store.queued()) {
      if (this.active.size >= this.concurrency) break;
      if (this.active.has(job.agent) || waiting.has(job.agent) || !this.store.claim(job.id)) continue;
      this.launch(job);
    }
    if (!this.options.answer) return;
    for (const answer of this.store.queuedAnswers()) {
      if (this.answering.size >= ANSWERS.atOnce) break;
      if (this.store.claimAnswer(answer.id)) this.answerIn(this.store.answer(answer.id)!);
    }
  }
  private cancel(select: TeamSelection, status: "interrupted" | "stopped", error: string): void {
    for (const active of this.active.values()) {
      if (!selected(active.job, select)) continue;
      this.store.finish(active.job.id, status, error);
      if (active.timer) clearTimeout(active.timer);
      active.timer = null;
      active.controller.abort(new Error(error));
    }
    // Its answer in a room stops with the room: an agent's or a task's stopping leaves it be.
    if (!select.agent && !select.task) {
      for (const { answer, controller } of this.answering.values()) {
        if (select.room && answer.room !== select.room) continue;
        this.store.finishAnswer(answer.id, status, error);
        controller.abort(new Error(error));
      }
    }
    this.changed();
  }
  /** Its answer, asked of the injected `answer` and posted in its room. One that fails says so there; one you stopped,
   * or the node cut off, says nothing (its record does). */
  private answerIn(answer: TeamAnswer): void {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error(`it took longer than ${ANSWERS.timeoutMs / 60_000} minutes`)), ANSWERS.timeoutMs);
    const run = async () => {
      const room = this.store.requireRoom(answer.room);
      const history = this.store.messages(room.id);
      const text = await this.options.answer!(room, history, { asker: answer.asker, trigger: history.find((m) => m.id === answer.trigger) ?? null }, controller.signal);
      controller.signal.throwIfAborted();
      const said = teamOutput(text, TEAM_LIMITS.message).trim();
      this.store.answered(answer.id, said === "[SILENT]" ? "" : said);
    };
    const done = run().catch((error) => {
      if (!this.running || this.store.answer(answer.id)?.status !== "running") return;
      const why = (controller.signal.aborted ? String((controller.signal.reason as Error)?.message ?? controller.signal.reason) : String((error as Error)?.message ?? error)).trim() || "no reason was given";
      try {
        this.store.answered(answer.id, `I couldn't answer: ${why}`, why);
      } catch {
        this.store.finishAnswer(answer.id, "failed", why);
      }
    }).finally(() => {
      clearTimeout(timer);
      this.answering.delete(answer.id);
      if (this.running) { this.changed(); this.kick(); }
    });
    this.answering.set(answer.id, { answer, controller, done });
    this.changed();
  }
  private launch(job: TeamJob): void {
    const controller = new AbortController();
    const active: Active = { job, controller, done: Promise.resolve(), timer: null };
    this.active.set(job.agent, active);
    // (A task with no limit of time has no clock: its audit watches it instead.)
    const limit = job.kind === "task" ? this.taskTimeoutMs : this.timeoutMs;
    if (limit !== null) active.timer = setTimeout(() => {
      if (!this.running) return;
      this.store.finish(job.id, "interrupted", "This work reached its time limit. Review it before resuming.");
      this.store.pauseRoom(job.room, true);
      controller.abort(new Error("Team work timed out"));
      this.changed();
    }, limit);
    active.done = Promise.resolve().then(() => this.run(job, controller.signal)).catch((error) => {
      if (this.running) this.store.finish(job.id, "failed", String((error as Error).message ?? error));
    }).finally(() => {
      if (active.timer) clearTimeout(active.timer);
      this.active.delete(job.agent);
      if (this.running) { this.changed(); this.kick(); }
      // (After a bounded shutdown the store is closed: nobody is told, as no observer is.)
      if (this.running && job.kind === "task") {
        const ended = this.store.task(job.id);
        if (ended && ended.status !== "running" && ended.status !== "queued") {
          try {
            this.options.onTaskEnded?.(ended);
          } catch {
            // (Whoever listens never holds up the team.)
          }
        }
      }
    });
    this.changed();
  }
  private async run(job: TeamJob, signal: AbortSignal): Promise<void> {
    let calls = 0;
    const current = () => {
      if (signal.aborted || this.store.job(job.id)?.status !== "running") throw new TeamError(409, "This agent's work has stopped.");
      const member = this.store.requireAgent(job.agent);
      const room = this.store.requireRoom(job.room);
      if (!member.enabled || room.paused || !room.members.includes(member.id)) throw new TeamError(403, "This agent may no longer act in this room.");
    };
    const budget = () => { current(); if (++calls > 64) throw new TeamError(429, "This turn reached its team action limit."); this.store.acted(job.id); };
    const context: TeamRunContext = {
      signal,
      chainId: job.chainId,
      acting: () => this.store.acted(job.id),
      send: (raw, text) => {
        budget();
        const target = teamInput(Destination, raw);
        teamText(text);
        const room = "room" in target ? this.store.requireRoom(target.room) : this.store.direct(target.agent, job.agent);
        const message = this.store.post({ room: room.id, text }, { agent: job.agent, chainId: job.chainId });
        this.changed(); this.kick(); return message;
      },
      remember: (text) => { budget(); const saved = this.store.remember(job.agent, text); this.changed(); return saved; },
      delegate: (task) => {
        budget();
        const saved = this.store.createTask({ ...task, room: job.room }, { agent: job.agent, chainId: job.chainId });
        // An agent's proposal within a budget it names is its to approve (approveOwn); any other waits for you.
        const given = saved.status === "proposed" ? this.approveOwn(saved.id, `proposed by @${job.agent} in ${this.store.room(job.room)?.name ?? job.room}`) : null;
        this.changed(); this.kick(); return given ?? saved;
      },
      recruit: (worker) => { budget(); const made = this.store.recruit(worker, job.agent, job.room); this.recruited(made); return made; },
      emit: (progress) => { current(); this.store.progress(job.id, progress); this.changed(); },
      // A task's run takes what was said to it at its safe points: each once, at the step it reached (a reply takes none).
      // And it goes on on the account its work began on, alone among that vendor's (the rule): kept with the task.
      ...(job.kind === "task"
        ? {
            steers: (step: number) => {
              const taken = this.store.takeSteers(job.id, step);
              if (taken.length) this.changed();
              return taken.map(({ by, text }) => ({ by, text }));
            },
            account: this.store.account(job.id),
            onAccount: (account: TaskAccount) => this.store.keepAccount(job.id, account),
          }
        : {}),
    };
    current();
    const agent = this.store.requireAgent(job.agent);
    const room = this.store.requireRoom(job.room);
    if (job.kind === "delivery") {
      const response = await this.options.respond(agent, room, this.store.messages(room.id), context);
      current();
      const text = teamOutput(typeof response === "string" ? response : response.text, TEAM_LIMITS.message).trim();
      if (text) this.store.post({ room: room.id, text }, { agent: agent.id, chainId: job.chainId, output: true });
      this.store.finish(job.id, "done");
    } else {
      const task = this.store.task(job.id)!;
      const outcome = await this.options.executeTask(agent, task, context);
      current();
      // Every model it could run on spent, its plan saying when it resets: it rests until then, and goes on by itself.
      if (!outcome.verified && outcome.rest) this.store.rest(job.id, outcome.rest.until, outcome.rest.why, outcome);
      else this.store.finish(job.id, outcome.verified ? "done" : "failed", outcome.error ?? (outcome.verified ? null : "The work was not independently verified."), outcome);
    }
  }
}
