import { z } from "zod";
import {
  TEAM_GALAHAD, TEAM_LIMITS, TeamControlInput, TeamRoomId, type TeamSayInput, TeammateId,
  type Teammate, type TeammateInput, type TeamRecruitInput, type TeamRoom, type TeamRoomInput, type TeamPostInput, type TeamWorkspace,
  type TeamMessage, type TeamTask, type TeamTaskChanges, type TeamTaskInput, type TeamTaskRecord, type TeamTrailEntry, type TeamSnapshot, type TeamRoomView, type TeamOverview, type TeamSeenInput,
  type InterventionKind, type TeamWorkStatus, type TeamTaskFix, type TeamTaskShipped,
} from "../../core/src/team.ts";
import { TeamStore, TeamError, teamInput, teamOutput, teamText, type TeamAnswer, type TeamAsker, type TeamJob, type TeamSelection } from "./team-store.ts";

export { TeamError } from "./team-store.ts";

export interface TeamRunContext {
  signal: AbortSignal;
  chainId: string;
  /** The sender is this callback's teammate, never a field supplied by a model. */
  send(to: { room: string } | { teammate: string }, text: string): TeamMessage;
  /** Replaces only this teammate's private working notes. */
  remember(text: string): Teammate;
  /** Delegation stays in the current room and in the current causal budget. */
  delegate(task: Omit<TeamTaskInput, "room">): TeamTask;
  /** A new worker, made by this one (never a field a model supplies): it joins this room unless the room is a
   * direct conversation, and what it then does here spends this same causal budget. */
  recruit(worker: TeamRecruitInput): Teammate;
  emit(progress: string): void;
  /**
   * Before anything that changes something (a message, notes, a task proposed, a knight made, a command in its VM, a
   * connector's action): a reply a planned restart cuts off after this waits for you, instead of being taken up again
   * by itself and doing it twice (TeamStore.interruptForRestart).
   */
  acting?(): void;
}

export interface TeamServiceOptions {
  store: TeamStore;
  respond(teammate: Teammate, room: TeamRoom, history: TeamMessage[], context: TeamRunContext): Promise<string | { text: string }>;
  executeTask(teammate: Teammate, task: TeamTask, context: TeamRunContext): Promise<{ verified: boolean; output: string; error?: string; record?: TeamTaskRecord; changes?: TeamTaskChanges }>;
  /** Galahad's answer in a room he was asked in (TeamStore.post says when): his words, posted for him. Absent: he
   * sits in no room on this node, and what was for him waits. */
  answer?(room: TeamRoom, history: TeamMessage[], ask: { asker: TeamAsker; trigger: TeamMessage | null }, signal: AbortSignal): Promise<string>;
  concurrency?: number;
  timeoutMs?: number;
  /** A task's own limit (work in a repository takes longer than a reply); absent: the same as `timeoutMs`; null: none (a knight's task, which its audit watches instead). */
  taskTimeoutMs?: number | null;
  /** Shutdown waits this long for callbacks to settle, then leaves their persisted state interrupted. */
  shutdownGraceMs?: number;
  /** How long work a planned restart cut off waits before it is taken up again by itself: until whatever it was running
   * in its knight's VM has surely met its own deadline there (team-runtime's TEAM_COMMAND_SECONDS). Absent: at once. */
  restartWaitMs?: number;
  /** How often the controller looks again at what has come due (a daily budget, work a restart cut off): 15 s. */
  tickMs?: number;
  onChange?(): void;
  /** A knight seated by Galahad (in your conversation) or by another knight (in its room): for the record. */
  onRecruit?(made: Teammate): void;
  /** A task's run has ended, however it ended (an outcome it is a step of looks again: outcomes.ts). */
  onTaskEnded?(task: TeamTask): void;
  /** What is left of your usage budget now, in US dollars (usage.ts meter; null: you set none): what he starts on his own yes must fit it. */
  budgetLeft?(): number | null;
}

interface Active {
  job: TeamJob;
  controller: AbortController;
  done: Promise<void>;
  timer: ReturnType<typeof setTimeout> | null;
}

/** Galahad answers in this many rooms at once, and takes this long at most over one answer. */
const ANSWERS = { atOnce: 3, timeoutMs: 10 * 60_000 } as const;

const Destination = z.union([z.strictObject({ room: TeamRoomId }), z.strictObject({ teammate: TeammateId })]);
const selected = (job: TeamJob, select: TeamSelection): boolean => (!select.room || job.room === select.room) && (!select.teammate || job.teammate === select.teammate) && (!select.task || job.id === select.task);

/** A single controller schedules named teammates. The injected runner owns models and VM transport;
 * this service owns identity, delivery, persistence, budgets, dependencies and exclusive access. */
export class TeamService {
  private readonly active = new Map<string, Active>();
  /** His answers under way, by answer. */
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
  activeWork(): readonly { teammate: string; room: string; kind: "delivery" | "task" }[] {
    return [...this.active.values()].map(({ job }) => ({ teammate: job.teammate, room: job.room, kind: job.kind }));
  }
  snapshot(): TeamSnapshot { return this.store.snapshot(); }
  room(id: string): TeamRoomView { return this.store.roomView(id); }
  /** You looked at a knight's page or a room (one that is here). */
  see(input: TeamSeenInput): void {
    if ("knight" in input) {
      if (!this.store.teammate(input.knight)) throw new TeamError(404, "No such knight at the table.");
      this.store.see(`knight:${input.knight}`);
    } else {
      this.store.requireRoom(input.room);
      this.store.see(`room:${input.room}`);
    }
  }
  messages(room: string, limit?: number): TeamMessage[] { return this.store.messages(room, limit); }
  saveTeammate(input: TeammateInput): Teammate {
    this.accepting();
    this.steady((input as { id?: unknown } | null)?.id);
    const saved = this.store.saveTeammate(input);
    if (!saved.enabled) this.cancel({ teammate: saved.id }, "interrupted", "Paused by you.");
    this.changed(); this.kick();
    return saved;
  }
  /**
   * You stepped in (#28): on a task by its id, or on the work running now of a knight or a room. Counted on each such task
   * by how, with a line on its trail; the caller is a route that only you may call.
   */
  steppedIn(on: TeamSelection, kind: InterventionKind, text: string): void {
    if (!on.task && !on.teammate && !on.room) return;
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
  setWorkspace(id: string, binding: TeamWorkspace | null): Teammate {
    this.accepting();
    this.steady(id);
    if (this.active.has(id) && this.store.requireTeammate(id).workspace) throw new TeamError(409, "Stop this knight's work before changing its workspace.");
    const saved = this.store.setWorkspace(id, binding);
    this.changed();
    return saved;
  }
  remember(id: string, text: string): Teammate { this.accepting(); const saved = this.store.remember(id, text); this.changed(); return saved; }
  /** Galahad's own computer bound, or no longer: yours to make, as a knight's VM is. */
  setComputer(binding: TeamWorkspace | null): TeamWorkspace | null { this.accepting(); const saved = this.store.setComputer(binding); this.changed(); return saved; }
  /** The VMs' notes store, for every knight here: a task reads the switch as it starts, so one that is running is not changed. */
  setEngram(on: boolean): boolean { this.accepting(); const set = this.store.setEngram(on); this.changed(); return set; }
  /** Whether failing checks go back to the knight whose work it was, outside an outcome too (ci-back.ts reads it when they fail). */
  setCiBack(on: boolean): boolean { this.accepting(); const set = this.store.setCiBack(on); this.changed(); return set; }
  setBacklog(on: boolean): boolean { this.accepting(); const set = this.store.setBacklog(on); this.changed(); return set; }
  /** Work Galahad offers a knight from your backlog (backlog.ts): proposed, it starts when he approves it himself, or you do. */
  proposeTask(input: TeamTaskInput): TeamTask { this.accepting(); const task = this.store.createTask(input, { givenBy: TEAM_GALAHAD, propose: true }); this.changed(); return task; }
  /**
   * A proposed task, his own from your backlog or a knight's from a room, started on his own yes (your word, 23 November
   * 2026: he approves his own decisions and his knights'; what is monetary asks you): only when it names its budget, at
   * most TEAM_LIMITS.ownTaskUsd, and that fits what is left of yours, if you set one. It waits its turn like any task,
   * and its trail says whose yes it was and why. Null when it isn't his to approve: it waits for yours.
   */
  approveOwn(task: string, why: string): TeamTask | null {
    this.accepting();
    const proposed = this.store.task(task);
    const budget = proposed?.budgetUsd;
    const left = this.options.budgetLeft?.() ?? null;
    if (proposed?.status !== "proposed" || budget === undefined || budget > TEAM_LIMITS.ownTaskUsd || (left !== null && left < budget)) return null;
    const approved = this.store.approve(task);
    this.store.noteTask(task, `Approved by Galahad himself: ${why}, within its budget of $${budget}${left === null ? "" : `, and of the $${left.toFixed(2)} left of yours`}`.slice(0, 500));
    this.changed();
    this.kick();
    return approved;
  }
  /** One he proposed, taken back before you answered it (backlog.ts: its step done, or another first): it never ran. */
  withdrawProposal(task: string, why: string): void {
    this.accepting();
    if (this.store.task(task)?.status !== "proposed") return;
    this.store.finish(task, "stopped", why);
    this.changed();
  }
  planWorkspace(id: string, node: string): Teammate {
    this.accepting();
    this.steady(id);
    if (this.active.has(id) && this.store.requireTeammate(id).workspace) throw new TeamError(409, "Stop this knight's work before provisioning its workspace.");
    const saved = this.store.planWorkspace(id, node); this.changed(); return saved;
  }
  saveRoom(input: TeamRoomInput): TeamRoom {
    this.accepting();
    const saved = this.store.saveRoom(input);
    for (const work of this.active.values()) if (work.job.room === saved.id && !saved.members.includes(work.job.teammate)) this.cancel({ teammate: work.job.teammate, room: saved.id }, "stopped", "Removed from this room.");
    this.changed(); this.kick();
    return saved;
  }
  direct(teammate: string): TeamRoom { this.accepting(); const room = this.store.direct(teammate); this.changed(); return room; }
  /** Your order of the knights, and who leads the Roundtable. */
  arrange(input: { order?: string[]; primary?: string }): { order: string[]; primary: string } { this.accepting(); const arranged = this.store.arrange(input); this.changed(); return arranged; }
  /** Your words to a room, from the device you wrote on (`asker`), whose own scopes Galahad answers with. */
  post(input: TeamPostInput, asker?: Exclude<TeamAsker, { kind: "knight" }>): TeamMessage { this.accepting(); const message = this.store.post(input, asker ? { asker } : {}); this.changed(); this.kick(); return message; }
  /** His workers as Galahad himself reads them. */
  overview(room?: string): TeamOverview { return this.store.overview(room); }
  /** What was said in the conversations a knight is part of (its own with you and other knights included) that holds every word of `query`. */
  search(teammate: string, query: string): { room: string; speaker: string; speakerName: string; text: string; at: string }[] {
    const rooms = this.store.rooms().filter((room) => room.members.includes(teammate)).map((room) => room.id);
    return this.store.searchMessages(rooms, query).map(({ room, speaker, speakerName, text, createdAt }) => ({ room, speaker, speakerName, text: text.length > 600 ? `${text.slice(0, 599)}…` : text, at: new Date(createdAt).toISOString() }));
  }
  /** A room's story so far, and keeping it told anew (TeamStore.story). */
  story(room: string): { text: string; through: string } | null { return this.store.story(room); }
  keepStory(room: string, text: string, through: string): void { this.accepting(); this.store.keepStory(room, text, through); }
  /** Galahad himself, from your conversation with him: a new worker of his own. */
  recruit(input: TeamRecruitInput): Teammate {
    this.accepting();
    const made = this.store.recruit(input, TEAM_GALAHAD);
    this.recruited(made);
    return made;
  }
  /** Galahad himself, from your conversation with him: his words to one worker (where you talk with it too) or to a room. */
  say(input: TeamSayInput): TeamMessage {
    this.accepting();
    const message = this.store.say(input);
    this.changed(); this.kick();
    return message;
  }
  createTask(input: TeamTaskInput, givenBy?: string, fix?: TeamTaskFix): TeamTask { this.accepting(); const task = this.store.createTask(input, { ...(givenBy ? { givenBy } : {}), ...(fix ? { fix } : {}) }); this.changed(); this.kick(); return task; }

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
    // An answer of his is never given twice: one cut off is said to be, and is yours to ask for again.
    for (const { answer, controller } of this.answering.values()) {
      this.store.finishAnswer(answer.id, "interrupted", "The node restarted while Galahad was answering. Ask him again.");
      controller.abort(new Error("The node is restarting."));
    }
    this.changed();
    // A runner that ignores cancellation keeps its teammate's lock until it really ends. Shutdown itself is bounded.
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([Promise.all([...this.active.values(), ...this.answering.values()].map((a) => a.done)), new Promise<void>((resolve) => { timer = setTimeout(resolve, this.options.shutdownGraceMs ?? 10_000); })]);
    if (timer) clearTimeout(timer);
  }

  /** A task by its id, or null. */
  task(id: string): TeamTask | null {
    return this.store.task(id);
  }
  /** The tasks in any of these states: one by its id, a knight's or a room's. */
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
    const select: TeamSelection = { ...(input.room ? { room: input.room } : {}), ...(input.teammate ? { teammate: input.teammate } : {}), ...(input.task ? { task: input.task } : {}) };
    if (input.room) this.store.requireRoom(input.room);
    if (input.teammate) { this.store.requireTeammate(input.teammate); this.steady(input.teammate); }
    if (input.task && !this.store.task(input.task)) throw new TeamError(404, "No such team task.");
    if (input.action === "approve") {
      this.store.approve(input.task!);
      this.changed(); this.kick();
      return this.snapshot();
    }
    if (input.action === "resume") {
      // A callback may still be winding down its VM command. It cannot be overlapped by a retry.
      if ([...this.active.values()].some((a) => selected(a.job, select))) throw new TeamError(409, "This work is still stopping. Wait for its current command to finish.");
      if (input.room) this.store.pauseRoom(input.room, false);
      if (input.teammate) this.store.enable(input.teammate, true);
      this.store.resume(select);
    } else {
      if (input.room) this.store.pauseRoom(input.room, true);
      if (input.teammate) this.store.enable(input.teammate, false);
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
  async remove(id: string, options: { release?(member: Teammate): Promise<void>; waitMs?: number } = {}): Promise<Teammate> {
    this.accepting();
    const member = this.store.requireTeammate(id);
    this.steady(id);
    if (member.workspace && !options.release) throw new TeamError(409, `${member.name} has a persistent workspace. Removing ${member.name} destroys it and everything in it: say so, or pause ${member.name} instead.`);
    this.removing.add(id);
    try {
      this.store.enable(id, false);
      this.cancel({ teammate: id }, "stopped", "Stopped to remove its knight.");
      const winding = this.active.get(id);
      if (winding) {
        let timer: ReturnType<typeof setTimeout> | undefined;
        await Promise.race([winding.done, new Promise<void>((resolve) => { timer = setTimeout(resolve, options.waitMs ?? 10_000); })]);
        if (timer) clearTimeout(timer);
        this.accepting();
      }
      // A callback may still be winding down its VM command: its teammate's record and workspace must outlast it.
      if (this.active.has(id)) throw new TeamError(409, "This knight's work is still stopping. It is paused now: remove it once its current command has finished.");
      const bound = this.store.requireTeammate(id);
      if (options.release) await options.release(bound);
      else if (bound.workspace) throw new TeamError(409, "This knight has a workspace and nothing was given to release it.");
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
  private steady(id: unknown): void { if (typeof id === "string" && this.removing.has(id)) throw new TeamError(409, "This knight is being removed."); }
  private changed(): void { try { this.options.onChange?.(); } catch { /* an observer cannot stop the scheduler */ } }
  private recruited(made: Teammate): void {
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
    // A knight whose cut-off work waits out a restart may still have its last command running in its VM.
    const waiting = this.store.restartWaits();
    for (const job of this.store.queued()) {
      if (this.active.size >= this.concurrency) break;
      if (this.active.has(job.teammate) || waiting.has(job.teammate) || !this.store.claim(job.id)) continue;
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
    // His answer in a room stops with the room: a knight's or a task's stopping leaves it be.
    if (!select.teammate && !select.task) {
      for (const { answer, controller } of this.answering.values()) {
        if (select.room && answer.room !== select.room) continue;
        this.store.finishAnswer(answer.id, status, error);
        controller.abort(new Error(error));
      }
    }
    this.changed();
  }
  /** His answer, asked of the injected `answer` and posted in its room. One that fails says so there; one you stopped,
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
    this.active.set(job.teammate, active);
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
      this.active.delete(job.teammate);
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
      if (signal.aborted || this.store.job(job.id)?.status !== "running") throw new TeamError(409, "This knight's work has stopped.");
      const member = this.store.requireTeammate(job.teammate);
      const room = this.store.requireRoom(job.room);
      if (!member.enabled || room.paused || !room.members.includes(member.id)) throw new TeamError(403, "This knight may no longer act in this room.");
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
        const room = "room" in target ? this.store.requireRoom(target.room) : this.store.direct(target.teammate, job.teammate);
        const message = this.store.post({ room: room.id, text }, { teammate: job.teammate, chainId: job.chainId });
        this.changed(); this.kick(); return message;
      },
      remember: (text) => { budget(); const saved = this.store.remember(job.teammate, text); this.changed(); return saved; },
      delegate: (task) => {
        budget();
        const saved = this.store.createTask({ ...task, room: job.room }, { teammate: job.teammate, chainId: job.chainId });
        // A knight's proposal within a budget it names is his to approve (approveOwn); any other waits for you.
        const given = saved.status === "proposed" ? this.approveOwn(saved.id, `proposed by @${job.teammate} in ${this.store.room(job.room)?.name ?? job.room}`) : null;
        this.changed(); this.kick(); return given ?? saved;
      },
      recruit: (worker) => { budget(); const made = this.store.recruit(worker, job.teammate, job.room); this.recruited(made); return made; },
      emit: (progress) => { current(); this.store.progress(job.id, progress); this.changed(); },
    };
    current();
    const teammate = this.store.requireTeammate(job.teammate);
    const room = this.store.requireRoom(job.room);
    if (job.kind === "delivery") {
      const response = await this.options.respond(teammate, room, this.store.messages(room.id), context);
      current();
      const text = teamOutput(typeof response === "string" ? response : response.text, TEAM_LIMITS.message).trim();
      if (text) this.store.post({ room: room.id, text }, { teammate: teammate.id, chainId: job.chainId, output: true });
      this.store.finish(job.id, "done");
    } else {
      const task = this.store.task(job.id)!;
      const outcome = await this.options.executeTask(teammate, task, context);
      current();
      this.store.finish(job.id, outcome.verified ? "done" : "failed", outcome.error ?? (outcome.verified ? null : "The work was not independently verified."), outcome);
    }
  }
}
