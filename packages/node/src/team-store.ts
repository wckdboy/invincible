import { Database } from "bun:sqlite";
import { chmodSync, closeSync, existsSync, openSync } from "node:fs";
import { AttachmentRef, findSecrets, HANDOFF_MIN_USD, randomId, readAlike, redact } from "@invincible/core";
import { isOrbProfile, type AvatarActivity } from "@invincible/core/avatar";
import { isMarkProfile, joinOrder, readMarkProfile, snapColor } from "@invincible/core/agent-mark";
import { assignGlass, backfillGlass, type Glass, glassOf, glassProfile, type GlassProfile, isGlassProfile, readGlassProfile } from "@invincible/core/glass";
import { z } from "zod";
import {
  TEAM_PRIMARY, TEAM_LIMITS, TEAM_OWNER, AgentId, AgentInput, TeamRecruitInput, TeamRoomInput, TeamPostInput, TeamSayInput, TeamTaskChanges, TeamTaskInput, TeamTaskRecord, type TeamTrailEntry, TeamWorkspace,
  type Agent, type TeamRoom, type TeamMessage, type TeamTask, type TeamDelivery, type TeamSnapshot, type TeamRoomView, type TeamWorkStatus, type TeamOverview,
  mergingOf, TeamMergeInput, TeamOutcomeInput, TeamOwnDailyInput, type TeamOutcomeStatus, type TeamTaskFix, type TeamTaskShipped, type TeamCheckpoint, type TeamSteer, heldModels, SENSITIVE_WORK,
} from "../../core/src/team.ts";
import { type InterventionKind, type NorthStar, northStar } from "../../core/src/interventions.ts";
import { TaskAccount } from "../../core/src/seats.ts";

/** An outcome as the store keeps it (outcomes.ts adds what it has cost, at your prices, for its view). */
export interface StoredOutcome {
  id: string;
  room: string;
  title: string;
  goal: string;
  done: string | null;
  agents: string[];
  budgetUsd: number;
  /** What its own looks at it have cost (its tasks' costs are read from their records). */
  leadUsd: number;
  status: TeamOutcomeStatus;
  notes: string;
  reportHour: number;
  tz: string;
  lastLookAt: number | null;
  lastReportAt: number | null;
  ended: string | null;
  /** What its looks have taken in: the tasks of it whose end it has seen, and the last message of yours it read. */
  seen: { tasks: string[]; message: string | null };
  createdAt: number;
  updatedAt: number;
}

export class TeamError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

/** How work reads that you stopped, paused or declined: your word, which only you take back (TeamService.resumeOwn). */
export const YOURS_STOPPED: ReadonlyMap<string, string> = new Map([["Stopped by you.", "You stopped it"], ["Paused by you.", "You paused it"], ["Declined by you.", "You declined it"]]);
/** How work a crash cut off reads: what it had done is yours to review before it runs again. */
export const CUT_OFF = "The node stopped during this work. Review it before resuming.";
/** How a proposal of the primary's own reads that it took back (backlog.ts, TeamService.declineOwn): never one you declined. */
export const WITHDRAWN = "Withdrawn by your agent";

export function teamInput<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) throw new TeamError(400, result.error.issues[0]?.message ?? "Invalid team request");
  return result.data;
}

/** Caller-supplied chat and memory must never be kept with a credential in them. */
export function teamText(text: string): void {
  if (findSecrets(text).length) throw new TeamError(422, "This looks like a credential. Put it in the vault, not team chat or memory.");
}

/** Model output and failures are untrusted too; callers never persist their raw values. */
/** A task's trail: how long one line may be, how many a task keeps, and how many are read at once. */
const TRAIL = { text: 2_000, keep: 600, page: 200 } as const;

export function teamOutput(text: string, max: number = TEAM_LIMITS.output): string {
  const safe = redact(String(text)).slice(0, max);
  return findSecrets(safe).length ? "[Output withheld because it looks like a credential.]" : safe;
}

interface DocRow { value: string }
interface MessageRow { id: string; room: string; speaker: string; speaker_name: string; text: string; created_at: number; chain_id: string; attachments: string | null }
interface JobRow { id: string; kind: "delivery" | "task"; room: string; agent: string; chain_id: string; status: TeamWorkStatus; data: string; error: string | null; created_at: number; updated_at: number }
interface AnswerRow { id: string; room: string; chain_id: string; trigger: string; asker: string; status: TeamWorkStatus; error: string | null; reply: string | null; created_at: number; updated_at: number }
export interface TeamJob { id: string; kind: "delivery" | "task"; room: string; agent: string; chainId: string; status: TeamWorkStatus; createdAt: number }
export interface TeamSelection { room?: string; agent?: string; task?: string }
/** Who asked the primary to answer in a room: you, from the device you wrote on (as it stands when it answers), or an agent,
 * whose words give it no hands. */
export type TeamAsker = { kind: "admin" } | { kind: "client"; device: string } | { kind: "agent"; agent: string };
/** The primary's answer to a room: one waits per room, for its newest words. */
export interface TeamAnswer { id: string; room: string; chainId: string; trigger: string; asker: TeamAsker; status: TeamWorkStatus; error: string | null; createdAt: number; updatedAt: number }

const messageOf = (r: MessageRow): TeamMessage => {
  const attachments = attachmentsOf(r.attachments);
  return { id: r.id, room: r.room, speaker: r.speaker, speakerName: r.speaker_name, text: r.text, createdAt: r.created_at, chainId: r.chain_id, ...(attachments.length ? { attachments } : {}) };
};
/** A message's files, read back: what was kept (each still checked to be one), or none. */
function attachmentsOf(json: string | null): AttachmentRef[] {
  if (!json) return [];
  try {
    const parsed = z.array(AttachmentRef).safeParse(JSON.parse(json));
    return parsed.success ? parsed.data : [];
  } catch {
    return [];
  }
}
const jobOf = (r: JobRow): TeamJob => ({ id: r.id, kind: r.kind, room: r.room, agent: r.agent, chainId: r.chain_id, status: r.status, createdAt: r.created_at });
const answerOf = (r: AnswerRow): TeamAnswer => ({ id: r.id, room: r.room, chainId: r.chain_id, trigger: r.trigger, asker: JSON.parse(r.asker) as TeamAsker, status: r.status, error: r.error, createdAt: r.created_at, updatedAt: r.updated_at });
/** Its seat in every room, for the mentions that call it. */
const PRIMARY_SEAT = [{ id: TEAM_PRIMARY, name: "Your agent" }] as const;
const id = (prefix: string): string => `${prefix}-${randomId(9).toLowerCase()}`;
/**
 * The agents a message names with @: by handle, by name, or by the first word of its name (case aside), each once and
 * in the room's order. An @ inside a word (an address) names nobody.
 */
export function mentioned(text: string, members: readonly Pick<Agent, "id" | "name">[]): string[] {
  const said = new Set([...text.normalize("NFKC").matchAll(/(?<![\p{L}\p{N}_.@])@([\p{L}\p{N}][\p{L}\p{N}_-]*)/gu)].map((match) => match[1]!.toLowerCase()));
  if (!said.size) return [];
  const call = (name: string) => name.normalize("NFKC").toLowerCase();
  return members.filter((member) => said.has(member.id) || said.has(call(member.name).replace(/\s+/g, "")) || said.has(call(member.name).split(/\s+/)[0] ?? "")).map((member) => member.id);
}

/** A new worker's daily allowance, whoever makes it: yours to change. */
const DAILY_TURNS = 40;
const DAY = 24 * 3_600_000;
/** What the primary is told of a room when it asks: its latest messages, each clipped; and of a worker's job, its start. */
const OVERVIEW = { messages: 20, message: 1200, job: 300 } as const;
const clipped = (text: string, max: number): string => (text.length > max ? `${text.slice(0, max)}… (${text.length - max} more characters)` : text);
/** Why a task that isn't running takes no steer, and what to do instead (the route says it in these words). */
const ENDED = "It has ended: give it again from a step instead.";
const NOT_STEERED: Readonly<Record<Exclude<TeamWorkStatus, "running">, string>> = {
  proposed: "It hasn't started: it waits for your approval. Approve it and steer it once it runs, or decline it and give it again with what you want.",
  queued: "It hasn't started yet: steer it once it runs, or stop it and give it again with what you want.",
  interrupted: "It isn't running: it was interrupted. Resume it, then steer it.",
  done: ENDED,
  failed: ENDED,
  stopped: ENDED,
};
/**
 * A task's data as it is queued again (by itself after a restart, or by your Resume): its steers are untaken, so its new
 * run, which begins from its goal, takes every one of them at its first safe point and its reviewer judges with them.
 */
const untaken = <T extends { steers?: TeamSteer[] }>(data: T): T =>
  Array.isArray(data.steers) && data.steers.some((s) => s.taken) ? { ...data, steers: data.steers.map(({ taken: _, ...steer }) => steer) } : data;
/** A steer's words, as the route takes them (core's TeamSteerInput): checked again here, where they are kept. */
const SteerText = z.string().trim().min(1, "say what it should take up").max(TEAM_LIMITS.steer, `at most ${TEAM_LIMITS.steer} characters`);
/** Why work stopped when its worker is gone, and why a direct conversation with a removed worker takes nothing new. */
const REMOVED = "Its agent was removed.";
const CLOSED = "This conversation is kept to read: its agent was removed.";
const matches = (job: TeamJob, select: TeamSelection) => (!select.room || job.room === select.room) && (!select.agent || job.agent === select.agent) && (!select.task || job.id === select.task);

/** Additive, private, node-local state. Opening the store never touches chat history or the mind. */
export class TeamStore {
  private readonly db: Database;

  constructor(path: string, readonly now: () => number = Date.now) {
    if (path !== ":memory:") {
      if (!existsSync(path)) closeSync(openSync(path, "wx", 0o600));
      chmodSync(path, 0o600);
    }
    this.db = new Database(path);
    this.db.exec(`PRAGMA secure_delete = ON; PRAGMA foreign_keys = ON;
      CREATE TABLE IF NOT EXISTS team_agents (id TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS team_rooms (id TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS team_chains (id TEXT PRIMARY KEY, budget INTEGER NOT NULL, spent INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS team_usage (agent TEXT NOT NULL, day TEXT NOT NULL, turns INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(agent, day));
      CREATE TABLE IF NOT EXISTS team_messages (
        seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, room TEXT NOT NULL REFERENCES team_rooms(id),
        speaker TEXT NOT NULL, speaker_name TEXT NOT NULL, text TEXT NOT NULL, created_at INTEGER NOT NULL, chain_id TEXT NOT NULL REFERENCES team_chains(id));
      CREATE INDEX IF NOT EXISTS team_messages_room ON team_messages(room, seq);
      CREATE INDEX IF NOT EXISTS team_messages_speaker ON team_messages(speaker, created_at);
      CREATE TABLE IF NOT EXISTS team_jobs (
        seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, kind TEXT NOT NULL, room TEXT NOT NULL REFERENCES team_rooms(id),
        agent TEXT NOT NULL REFERENCES team_agents(id), chain_id TEXT NOT NULL REFERENCES team_chains(id), status TEXT NOT NULL,
        data TEXT NOT NULL, error TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS team_jobs_queue ON team_jobs(status, seq);
      CREATE INDEX IF NOT EXISTS team_jobs_agent ON team_jobs(agent, status);
      CREATE INDEX IF NOT EXISTS team_jobs_activity ON team_jobs(updated_at, agent, kind, status);
      CREATE TABLE IF NOT EXISTS team_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS team_own (task TEXT PRIMARY KEY, usd REAL NOT NULL, at INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS team_own_at ON team_own(at);
      CREATE TABLE IF NOT EXISTS ci_yours (pull TEXT NOT NULL, head TEXT NOT NULL, said TEXT NOT NULL, at INTEGER NOT NULL, PRIMARY KEY (pull, head));
      CREATE TABLE IF NOT EXISTS team_outcomes (id TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS team_trail (task TEXT NOT NULL, n INTEGER NOT NULL, at INTEGER NOT NULL, text TEXT NOT NULL, PRIMARY KEY(task, n));
      CREATE TABLE IF NOT EXISTS team_checkpoints (task TEXT NOT NULL, step INTEGER NOT NULL, at INTEGER NOT NULL, commit_id TEXT NOT NULL, command TEXT NOT NULL, PRIMARY KEY(task, step));
      CREATE TABLE IF NOT EXISTS team_stories (room TEXT PRIMARY KEY REFERENCES team_rooms(id), text TEXT NOT NULL, through TEXT NOT NULL, updated_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS team_answers (
        seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, room TEXT NOT NULL REFERENCES team_rooms(id),
        chain_id TEXT NOT NULL REFERENCES team_chains(id), trigger TEXT NOT NULL, asker TEXT NOT NULL, status TEXT NOT NULL,
        error TEXT, reply TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS team_answers_queue ON team_answers(status, seq);
      CREATE INDEX IF NOT EXISTS team_answers_room ON team_answers(room, seq);
      CREATE INDEX IF NOT EXISTS team_answers_reply ON team_answers(reply);`);
    // A database from before files among the agents: a message of yours may carry some (kept on the node: uploads.ts).
    const fields = new Set(this.db.query<{ name: string }, []>("PRAGMA table_info(team_messages)").all().map((c) => c.name));
    if (!fields.has("attachments")) this.db.exec("ALTER TABLE team_messages ADD COLUMN attachments TEXT");
    // A trail from before lengths were kept: a command's line gains the length of all the run showed the model (TeamTrailEntry).
    const trailFields = new Set(this.db.query<{ name: string }, []>("PRAGMA table_info(team_trail)").all().map((c) => c.name));
    if (!trailFields.has("output_chars")) this.db.exec("ALTER TABLE team_trail ADD COLUMN output_chars INTEGER");
    // When you last looked at each agent's page and each room (`agent:<id>`, `room:<id>`): what ended there after it
    // is new to you. A database from before it counts everything until now as seen.
    const seenBefore = this.db.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'team_seen'").get();
    this.db.exec("CREATE TABLE IF NOT EXISTS team_seen (key TEXT PRIMARY KEY, at INTEGER NOT NULL)");
    if (!seenBefore) {
      const at = this.now();
      const add = this.db.query("INSERT OR IGNORE INTO team_seen (key, at) VALUES (?, ?)");
      for (const { id } of this.db.query<{ id: string }, []>("SELECT id FROM team_agents").all()) add.run(`agent:${id}`, at);
      for (const { id } of this.db.query<{ id: string }, []>("SELECT id FROM team_rooms").all()) add.run(`room:${id}`, at);
    }
    this.glassEveryone();
  }

  /**
   * Agents from before the glass (glass.ts) given theirs, once: one by one in the order they joined, each after the ones
   * before it, by the rule (core's backfillGlass): a mark (v 3) keeps its colour, a colour chosen for its orb (v 2) keeps
   * it snapped to the eight, and each gets a shape. Deterministic (ids, when each was made, what each had), so every node
   * with the same agents comes to the same glass. Only the avatar is written; an agent removed keeps what it had.
   */
  private glassEveryone(): void {
    const agents = joinOrder(this.agents());
    if (agents.every((agent) => isGlassProfile(agent.avatar))) return;
    const given = backfillGlass(agents);
    this.db.transaction(() => {
      agents.forEach((agent, n) => {
        if (isGlassProfile(agent.avatar)) return;
        const value = JSON.parse(this.db.query<DocRow, [string]>("SELECT value FROM team_agents WHERE id = ?").get(agent.id)!.value) as Record<string, unknown>;
        this.db.query("UPDATE team_agents SET value = ? WHERE id = ?").run(JSON.stringify({ ...value, avatar: glassProfile(given[n]!) }), agent.id);
      });
    })();
  }

  /** The glass of the agents here but `id`, in the order they joined: what a glass given to `id` now comes after. */
  private glassBut(id: string): Glass[] {
    return joinOrder(this.agents().filter((agent) => agent.id !== id)).map((agent) => glassOf(agent.id, agent.avatar));
  }

  /**
   * Its glass, as you ask for it: omitted, the one it has (or, new, the one it is given as it joins); a glass you chose
   * (v 4), kept; a colour an app picked, its shape kept: a mark's (v 3, today's apps) as it is, any other (v 2, the apps
   * already out) snapped to the eight; null, the one it would be given now.
   */
  private glassFor(id: string, previous: Agent | null, asked: AgentInput["avatar"]): GlassProfile {
    const own = readGlassProfile(previous?.avatar);
    if (asked === undefined) {
      if (own) return glassProfile(own);
      const mark = readMarkProfile(previous?.avatar);
      return glassProfile(assignGlass(id, this.glassBut(id), mark ? mark.color : isOrbProfile(previous?.avatar) ? previous.avatar.color : null));
    }
    if (asked === null) return glassProfile(assignGlass(id, this.glassBut(id)));
    if (isGlassProfile(asked)) return asked;
    const color = isMarkProfile(asked) ? readMarkProfile(asked)!.color : snapColor(asked.color);
    return glassProfile({ color, shape: own?.shape ?? assignGlass(id, this.glassBut(id), color).shape });
  }

  close(): void { this.db.close(); }
  private day(): string { return new Date(this.now()).toISOString().slice(0, 10); }
  private turns(agent: string): number { return this.db.query<{ turns: number }, [string, string]>("SELECT turns FROM team_usage WHERE agent = ? AND day = ?").get(agent, this.day())?.turns ?? 0; }
  /** The primary's own computer: its persistent VM, bound as an agent's workspace is (null: it has none yet). */
  computer(): TeamWorkspace | null {
    const raw = this.db.query<DocRow, []>("SELECT value FROM team_settings WHERE key='computer'").get()?.value;
    const bound = raw ? TeamWorkspace.safeParse(JSON.parse(raw)) : null;
    return bound?.success ? bound.data : null;
  }
  setComputer(raw: TeamWorkspace | null): TeamWorkspace | null {
    if (raw === null) {
      this.db.query("DELETE FROM team_settings WHERE key='computer'").run();
      return null;
    }
    const bound = teamInput(TeamWorkspace, raw);
    this.db.query("INSERT INTO team_settings(key,value) VALUES('computer',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(JSON.stringify(bound));
    return bound;
  }
  /** The VMs' notes store (Engram) for this node's agents: on unless you turned it off, and kept across restarts. */
  engram(): boolean { return this.db.query<DocRow, []>("SELECT value FROM team_settings WHERE key='engram'").get()?.value !== "off"; }
  setEngram(raw: boolean): boolean {
    const on = teamInput(z.boolean(), raw);
    this.db.query("INSERT INTO team_settings(key,value) VALUES('engram',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(on ? "on" : "off");
    return on;
  }
  /** Whether the primary offers idle agents work from your backlog (backlog.ts): on until you turn it off. */
  backlog(): boolean { return this.db.query<DocRow, []>("SELECT value FROM team_settings WHERE key='backlog'").get()?.value !== "off"; }
  setBacklog(raw: boolean): boolean {
    const on = teamInput(z.boolean(), raw);
    this.db.query("INSERT INTO team_settings(key,value) VALUES('backlog',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(on ? "on" : "off");
    return on;
  }
  /** When an agent was last looked at for work from your backlog (0: never), kept so a restart doesn't look again. */
  backlogLooked(agent: string): number { return Number(this.db.query<DocRow, [string]>("SELECT value FROM team_settings WHERE key=?").get(`backlog:${agent}`)?.value ?? 0); }
  setBacklogLooked(agent: string, at: number): void {
    this.db.query("INSERT INTO team_settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(`backlog:${agent}`, String(at));
  }
  /** What the primary may commit on its own word in a day while you set no usage budget: TEAM_LIMITS.ownDailyUsd until you set another. */
  ownDaily(): number {
    const set = Number(this.db.query<DocRow, []>("SELECT value FROM team_settings WHERE key='own-daily'").get()?.value ?? Number.NaN);
    return Number.isFinite(set) && set >= 0 ? set : TEAM_LIMITS.ownDailyUsd;
  }
  setOwnDaily(raw: number): number {
    const usd = Math.round(teamInput(TeamOwnDailyInput.shape.usd, raw) * 100) / 100;
    this.db.query("INSERT INTO team_settings(key,value) VALUES('own-daily',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(String(usd));
    return usd;
  }
  /** A commitment of the primary's own word beyond a give or a yes (TeamService.resumeOwn: a run taken up again spends its
   * budget anew), kept as one (team_own, under its own key). */
  commitOwn(key: string, usd: number): void {
    this.db.query("INSERT INTO team_own(task,usd,at) VALUES(?,?,?)").run(key, usd, this.now());
  }
  /**
   * The fixes the primary gave back on its own word in the last day (ci-back.ts), outside an outcome: how many, and their
   * budgets. They have an allowance of their own inside its day (TEAM_LIMITS.ciFixesPerDay, ciFixDailyUsd).
   */
  ownFixes(): { n: number; usd: number } {
    return this.db
      .query<{ n: number; usd: number }, [string, number]>("SELECT COUNT(*) AS n, COALESCE(SUM(json_extract(data,'$.budgetUsd')),0) AS usd FROM team_jobs WHERE kind='task' AND json_extract(data,'$.givenBy') = ? AND json_extract(data,'$.fix') IS NOT NULL AND json_extract(data,'$.outcome') IS NULL AND created_at > ?")
      .get(TEAM_PRIMARY, this.now() - 86_400_000)!;
  }
  /** What was said of a pull request's failing commit that stayed yours (ci-back.ts): it stays so (the review of 27 November, S5). */
  ciYours(pull: string, head: string): string | null {
    return this.db.query<{ said: string }, [string, string]>("SELECT said FROM ci_yours WHERE pull = ? AND head = ?").get(pull, head)?.said ?? null;
  }
  markCiYours(pull: string, head: string, said: string): void {
    this.db.query("INSERT OR IGNORE INTO ci_yours (pull, head, said, at) VALUES (?, ?, ?, ?)").run(pull, head, said, this.now());
  }
  /** What the primary committed on its own word in the last day: the budgets of the tasks it gave, of the proposals it approved itself, and of the runs it took up again, as each was then (team_own). */
  ownCommitted(): number {
    return this.db.query<{ usd: number }, [number]>("SELECT COALESCE(SUM(usd),0) AS usd FROM team_own WHERE at > ?").get(this.now() - 86_400_000)!.usd;
  }
  /** What approved work still holds: the budgets of the tasks queued or running, whoever gave or approved them, as an
   * outcome holds its own (a running one its whole budget until it ends, though some of it is spent: more than it needs
   * for that while, never less). */
  heldUsd(): number {
    return this.db.query<{ usd: number }, []>("SELECT COALESCE(SUM(json_extract(data,'$.budgetUsd')),0) AS usd FROM team_jobs WHERE kind='task' AND status IN ('queued','running')").get()!.usd;
  }
  /** Whether the primary merges its agents' proven work itself in a repository (owner/repo, whatever its case): on until you turn it off there. */
  mergeOn(repository: string): boolean { return this.db.query<DocRow, [string]>("SELECT value FROM team_settings WHERE key=?").get(`merge:${repository.toLowerCase()}`)?.value !== "off"; }
  setMerge(raw: TeamMergeInput): TeamMergeInput {
    const { repository, on } = teamInput(TeamMergeInput, raw);
    if (on) this.db.query("DELETE FROM team_settings WHERE key=?").run(`merge:${repository.toLowerCase()}`);
    else this.db.query("INSERT INTO team_settings(key,value) VALUES(?,'off') ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(`merge:${repository.toLowerCase()}`);
    return { repository, on };
  }
  /** The repositories where you turned it off, lowercased. */
  mergeOff(): string[] { return this.db.query<{ key: string }, []>("SELECT key FROM team_settings WHERE key LIKE 'merge:%' AND value='off' ORDER BY key").all().map((r) => r.key.slice("merge:".length)); }
  /** Whether failing checks go back to the agent whose work it was when no outcome gives them back (PLAN #29), on your
   * agent's own word within its money: on until you turn it off (your word, 27 November 2026: it decides this itself). */
  ciBack(): boolean { return this.db.query<DocRow, []>("SELECT value FROM team_settings WHERE key='ci'").get()?.value !== "off"; }
  setCiBack(raw: boolean): boolean {
    const on = teamInput(z.boolean(), raw);
    this.db.query("INSERT INTO team_settings(key,value) VALUES('ci',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(on ? "on" : "off");
    return on;
  }
  /** Whether it writes first in a chat of yours when a task it gave there ends (write-first.ts): on until you turn it off (the review of 27 November, S9). */
  writesFirst(): boolean { return this.db.query<DocRow, []>("SELECT value FROM team_settings WHERE key='first'").get()?.value !== "off"; }
  setWritesFirst(raw: boolean): boolean {
    const on = teamInput(z.boolean(), raw);
    this.db.query("INSERT INTO team_settings(key,value) VALUES('first',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(on ? "on" : "off");
    return on;
  }
  /** The tasks you stopped, paused or declined since `since` (YOURS_STOPPED), newest first: what its own giving keeps off (TeamService.giveOwn). */
  yoursEnded(since: number): TeamTask[] {
    return this.db
      .query<JobRow, [string, string, string, number]>("SELECT * FROM team_jobs WHERE kind='task' AND error IN (?, ?, ?) AND updated_at > ? ORDER BY seq DESC LIMIT 200")
      .all(...([...YOURS_STOPPED.keys()] as [string, string, string]), since)
      .map((row) => this.taskOf(row));
  }
  /** A room's story so far: what its agents summed up of the conversation before `through` (a message's id), so a
   * long one keeps what it settled. Null: nothing has been summed up yet. */
  story(room: string): { text: string; through: string; updatedAt: number } | null {
    const row = this.db.query<{ text: string; through: string; updated_at: number }, [string]>("SELECT text, through, updated_at FROM team_stories WHERE room = ?").get(room);
    return row ? { text: row.text, through: row.through, updatedAt: row.updated_at } : null;
  }
  /** The story told anew, through a later message. A model wrote it: it is held to what team memory is. */
  keepStory(room: string, raw: string, through: string): void {
    const text = teamOutput(raw, TEAM_LIMITS.memory);
    teamText(text);
    this.requireRoom(room);
    this.db.query("INSERT INTO team_stories(room,text,through,updated_at) VALUES(?,?,?,?) ON CONFLICT(room) DO UPDATE SET text=excluded.text, through=excluded.through, updated_at=excluded.updated_at").run(room, text, through, this.now());
  }
  /** What was said in these rooms that holds every word of `query` (case aside), the latest first: at most `limit`. */
  searchMessages(rooms: string[], query: string, limit = 8): TeamMessage[] {
    const words = [...new Set(query.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((word) => word.length >= 2))].slice(0, 8);
    if (!rooms.length || !words.length) return [];
    const where = `room IN (${rooms.map(() => "?").join(",")}) AND ${words.map(() => "instr(lower(text), ?) > 0").join(" AND ")}`;
    return this.db.query<MessageRow, string[]>(`SELECT * FROM team_messages WHERE ${where} ORDER BY seq DESC LIMIT ${Math.max(1, Math.min(32, Math.trunc(limit)))}`).all(...rooms, ...words).map(messageOf);
  }
  /** A worker's record as it is kept, whether or not it was removed. */
  private record(id: string): Agent | null {
    const row = this.db.query<DocRow, [string]>("SELECT value FROM team_agents WHERE id = ?").get(id);
    if (!row) return null;
    const value = JSON.parse(row.value) as Agent;
    return { ...value, avatar: isGlassProfile(value.avatar) || isMarkProfile(value.avatar) || isOrbProfile(value.avatar) ? value.avatar : undefined, repository: value.repository ?? null, workspaceNode: value.workspaceNode ?? value.workspace?.node ?? null, createdBy: value.createdBy ?? TEAM_OWNER, instructionsBy: value.instructionsBy ?? TEAM_OWNER, turnsToday: this.turns(id) };
  }
  private records(): Agent[] { return this.db.query<{ id: string }, []>("SELECT id FROM team_agents ORDER BY id").all().map((r) => this.record(r.id)!); }
  /** A worker that is here. One that was removed is nobody's to work with, write to or change (null), though its record is kept. */
  agent(id: string): Agent | null {
    const kept = this.record(id);
    return kept && kept.removedAt === undefined ? kept : null;
  }
  /** Your agents, by handle. */
  agents(): Agent[] {
    return this.records().filter((t) => t.removedAt === undefined);
  }
  /** The workers you removed. Their handles stay taken and their names stay beside what they said. */
  removed(): Agent[] { return this.records().filter((t) => t.removedAt !== undefined); }
  private putAgent(raw: Agent): Agent {
    // Every agent here has its glass: one that joins without one (a worker the primary makes) is given it now.
    const value = raw.removedAt === undefined && !isGlassProfile(raw.avatar) ? { ...raw, avatar: this.glassFor(raw.id, raw, undefined) } : raw;
    this.db.query("INSERT INTO team_agents(id,value) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value").run(value.id, JSON.stringify(value));
    return this.agent(value.id)!;
  }
  saveAgent(raw: AgentInput): Agent {
    const input = teamInput(AgentInput, raw);
    // (Its ACP agent's command too: a key named on a command line would be kept here, in the clear.)
    teamText([input.name, input.instructions, input.role, input.repository, input.acp].filter(Boolean).join("\n"));
    if (this.record(input.id)?.removedAt !== undefined) throw new TeamError(409, "That handle belonged to an agent that was removed. Its history stays its own: choose another handle.");
    const previous = this.agent(input.id);
    // A VM's repository is not changed or taken away under the work that is in it. One that has none may be given its first: nothing there to orphan.
    if (previous?.workspace && previous.repository && input.repository !== undefined && input.repository !== previous.repository) throw new TeamError(409, "This agent's workspace is already bound to its repository. Keep that repository to preserve its work.");
    if (!previous && this.agents().length >= TEAM_LIMITS.agents) throw new TeamError(409, `At most ${TEAM_LIMITS.agents} agents can live on this node.`);
    const at = this.now();
    // This is your own way in: instructions you change here are yours from then on, whoever wrote the ones before.
    // (Saved as they were, with something else about the worker, they stay whose they were: the app sends them every time.)
    // (Its own models: omitted, kept; null or none, its role's again.)
    const models = input.models === undefined ? previous?.models : input.models?.length ? input.models : undefined;
    // Sensitive mode holds it to models of its own: never on without them, and never let go of by taking them away.
    const sensitive = input.sensitive ?? previous?.sensitive ?? false;
    if (sensitive && !models?.length) throw new TeamError(400, previous?.sensitive && input.sensitive === undefined ? `${previous.name} is in sensitive mode, held to its own models: choose others, or turn sensitive mode off first.` : "Sensitive mode holds an agent to models of its own: choose them first.");
    // An ACP agent of yours (harness acp) is started by the command you named: kept until you name another or none.
    const harness = input.harness ?? previous?.harness ?? "native";
    const acp = input.acp === undefined ? previous?.acp : input.acp ?? undefined;
    // Keys of yours it may use but never see (PLAN #17): omitted, kept; null or none, none. That each is a key it can be
    // given (in the vault, pinned to an address, no provider's or connector's) is the node's to check (server.ts).
    const keys = input.keys === undefined ? previous?.keys : input.keys?.length ? input.keys : undefined;
    if (harness === "acp" && !acp) throw new TeamError(400, "Name the command that starts its ACP agent in its VM, e.g. goose acp or gemini --acp.");
    // (It calls the models you set it up with, which sensitive mode can't hold it to.)
    if (harness === "acp" && sensitive) throw new TeamError(400, "An agent in sensitive mode works on your agent's own harness, OpenCode, Hermes, Claude Code or Codex: an ACP agent of yours calls the models you set it up with, which your agent can't hold it to.");
    return this.putAgent({ id: input.id, name: input.name, instructions: input.instructions ?? previous?.instructions ?? "", role: input.role ?? previous?.role ?? "engineer", ...(models ? { models } : {}), ...(sensitive ? { sensitive: true } : {}), harness, ...(acp ? { acp } : {}), ...(keys ? { keys } : {}), enabled: input.enabled ?? previous?.enabled ?? true, dailyTurns: input.dailyTurns ?? previous?.dailyTurns ?? DAILY_TURNS, repository: input.repository === undefined ? previous?.repository ?? null : input.repository, turnsToday: this.turns(input.id), workspaceNode: previous?.workspaceNode ?? null, workspace: previous?.workspace ?? null, memory: previous?.memory ?? "", avatar: this.glassFor(input.id, previous, input.avatar), createdBy: previous?.createdBy ?? TEAM_OWNER, instructionsBy: input.instructions === undefined || input.instructions === previous?.instructions ? previous?.instructionsBy ?? TEAM_OWNER : TEAM_OWNER, createdAt: previous?.createdAt ?? at, updatedAt: at });
  }
  /**
   * An agent brought whole from the system Invincible succeeds (`invincible import`): its profile, held to every rule
   * one you add is (saveAgent); its notes; when it was made; and whose words its job is, kept as they were there, so
   * one the primary or another agent wrote stays fenced as theirs and never becomes yours by coming across. Only ever
   * a new handle: one taken here, by an agent here or one removed, is refused.
   */
  adopt(raw: AgentInput & { memory: string; createdBy: string; instructionsBy: string; createdAt: number; updatedAt: number }): Agent {
    const { memory, createdBy, instructionsBy, createdAt, updatedAt, ...profile } = raw;
    const by = z.union([z.literal(TEAM_OWNER), z.literal(TEAM_PRIMARY), AgentId]);
    const kept = teamInput(z.strictObject({ memory: z.string().max(TEAM_LIMITS.memory), createdBy: by, instructionsBy: by, createdAt: z.number().int().min(0), updatedAt: z.number().int().min(0) }), { memory, createdBy, instructionsBy, createdAt, updatedAt });
    teamText(kept.memory);
    return this.db.transaction(() => {
      if (this.record(profile.id)) throw new TeamError(409, `The handle ${profile.id} is taken here already.`);
      const saved = this.saveAgent(profile);
      return this.putAgent({ ...saved, memory: kept.memory, createdBy: kept.createdBy, instructionsBy: kept.instructionsBy, createdAt: kept.createdAt, updatedAt: kept.updatedAt });
    })();
  }
  /** How many more workers the primary may make for itself: on this node in all, and in the day now ending. */
  private spare(all: Agent[] = this.agents()): TeamOverview["spare"] {
    const since = this.now() - DAY;
    // One you removed still counts as made today: removing a worker gives it no more to make. It no longer takes a place on the node.
    const today = [...all, ...this.removed()].filter((t) => t.createdBy !== TEAM_OWNER && t.createdAt > since).length;
    return { workers: Math.max(0, TEAM_LIMITS.agents - all.length), today: Math.max(0, TEAM_LIMITS.recruitsPerDay - today) };
  }
  /**
   * A worker the primary makes for itself (`by`: TEAM_PRIMARY, or the worker that asked for it): only ever a new one,
   * with the defaults that stay yours to change, its job marked as its words and never yours, and within its
   * allowance for the day. `room`: its maker's room, which it joins at once unless that is a direct conversation.
   */
  recruit(raw: TeamRecruitInput, by: string, room?: string): Agent {
    const input = teamInput(TeamRecruitInput, raw);
    teamText([input.name, input.instructions, input.role].filter(Boolean).join("\n"));
    return this.db.transaction(() => {
      if (by !== TEAM_PRIMARY) this.requireAgent(by);
      const taken = this.record(input.id);
      if (taken?.removedAt !== undefined) throw new TeamError(409, `The handle ${input.id} belonged to an agent that was removed. Its history stays its own: choose another handle.`);
      if (taken) throw new TeamError(409, `An agent with the handle ${input.id} already exists. Work with them, or choose another handle.`);
      // A name a model chose must not be taken for another worker's, however it is spelled: one that was removed too, whose name is still beside what it said.
      const twin = this.records().find((other) => readAlike(other.name, input.name));
      if (twin) throw new TeamError(409, `The name ${input.name} reads like ${twin.name}'s (${twin.id}). Choose a name nobody could take for another agent's.`);
      const spare = this.spare();
      if (!spare.workers) throw new TeamError(409, `At most ${TEAM_LIMITS.agents} agents can live on this node.`);
      if (!spare.today) throw new TeamError(429, `Your agent has made ${TEAM_LIMITS.recruitsPerDay} agents in the last day, which is its allowance. The owner can add more among the agents.`);
      const joined = room ? this.requireRoom(room) : null;
      // A worker brings one only into a room of its own.
      if (joined && by !== TEAM_PRIMARY) this.roomMember(joined, by);
      const at = this.now();
      // One an agent in sensitive mode makes is in it too, on the same models: what it starts never runs elsewhere.
      const held = by === TEAM_PRIMARY ? null : heldModels(this.requireAgent(by));
      const made = this.putAgent({ id: input.id, name: input.name, instructions: input.instructions, role: input.role ?? "engineer", ...(held ? { models: [...held], sensitive: true } : {}), harness: "native", enabled: true, dailyTurns: DAILY_TURNS, repository: null, turnsToday: 0, workspaceNode: null, workspace: null, memory: "", createdBy: by, instructionsBy: by, createdAt: at, updatedAt: at });
      if (joined && !joined.direct) this.putRoom({ ...joined, members: [...joined.members, made.id], updatedAt: at });
      return made;
    })();
  }
  planWorkspace(agent: string, raw: string): Agent {
    const current = this.requireAgent(agent);
    const node = teamInput(z.string().min(1).max(200), raw);
    teamText(node);
    if (current.workspaceNode && current.workspaceNode !== node) throw new TeamError(409, "This agent's workspace is already assigned to another host.");
    return this.putAgent({ ...current, workspaceNode: node, updatedAt: this.now() });
  }
  setWorkspace(agent: string, raw: TeamWorkspace | null): Agent {
    const current = this.requireAgent(agent);
    const workspace = raw === null ? null : teamInput(TeamWorkspace, raw);
    if (workspace) teamText(workspace.node);
    if (workspace && current.workspace && (current.workspace.node !== workspace.node || current.workspace.id !== workspace.id)) throw new TeamError(409, "This agent already has a workspace. Recover that workspace rather than replacing its work.");
    if (workspace && current.workspaceNode && current.workspaceNode !== workspace.node) throw new TeamError(409, "This agent's workspace is already assigned to another host.");
    if (workspace && this.agents().some((t) => t.id !== agent && t.workspace?.node === workspace.node && t.workspace?.id === workspace.id)) throw new TeamError(409, "That workspace belongs to another agent.");
    return this.putAgent({ ...current, workspace, workspaceNode: workspace?.node ?? current.workspaceNode, updatedAt: this.now() });
  }
  remember(agent: string, raw: string): Agent {
    const memory = teamInput(z.string().max(TEAM_LIMITS.memory), raw);
    teamText(memory);
    return this.putAgent({ ...this.requireAgent(agent), memory, updatedAt: this.now() });
  }
  requireAgent(id: string): Agent {
    const agent = this.record(id);
    if (!agent) throw new TeamError(404, "No such agent.");
    if (agent.removedAt !== undefined) throw new TeamError(410, "That agent was removed.");
    return agent;
  }
  /**
   * Retire a worker for good. Nothing of it is erased: its record is kept (so its handle is never anyone else's and
   * nothing new inherits its history), its words stay where it said them, and its direct conversations stay to read.
   * It leaves every shared room, and what it had not started is stopped. A bound workspace and running work are
   * the caller's to deal with first: neither is ever left behind.
   */
  remove(id: string): Agent {
    return this.db.transaction(() => {
      const current = this.requireAgent(id);
      if (current.workspace) throw new TeamError(409, "This agent still has a workspace. Destroy it with the agent, or keep the agent paused instead.");
      if (this.db.query("SELECT id FROM team_jobs WHERE agent=? AND status='running'").get(id)) throw new TeamError(409, "Stop this agent's work before removing it.");
      const at = this.now();
      // Its direct conversations are closed with it: what its peers had still to say there is stopped too.
      const closing = new Set(this.rooms().filter((room) => room.direct && room.members.includes(id)).map((room) => room.id));
      for (const job of this.queued()) {
        if (job.agent === id) this.finish(job.id, "stopped", REMOVED);
        else if (closing.has(job.room)) this.finish(job.id, "stopped", CLOSED);
      }
      for (const room of this.rooms()) if (!room.direct && room.members.includes(id)) this.putRoom({ ...room, members: room.members.filter((member) => member !== id), updatedAt: at });
      this.db.query("UPDATE team_agents SET value=? WHERE id=?").run(JSON.stringify({ ...current, enabled: false, removedAt: at, updatedAt: at }), id);
      return this.record(id)!;
    })();
  }
  room(id: string): TeamRoom | null {
    const row = this.db.query<DocRow, [string]>("SELECT value FROM team_rooms WHERE id = ?").get(id);
    return row ? JSON.parse(row.value) as TeamRoom : null;
  }
  rooms(): TeamRoom[] { return this.db.query<DocRow, []>("SELECT value FROM team_rooms ORDER BY id").all().map((r) => JSON.parse(r.value) as TeamRoom); }

  /* ---------- outcomes it owns (PLAN #43; outcomes.ts runs them) ---------- */

  outcomes(): StoredOutcome[] { return this.db.query<DocRow, []>("SELECT value FROM team_outcomes ORDER BY id").all().map((r) => JSON.parse(r.value) as StoredOutcome); }
  outcome(id: string): StoredOutcome | null {
    const row = this.db.query<DocRow, [string]>("SELECT value FROM team_outcomes WHERE id = ?").get(id);
    return row ? (JSON.parse(row.value) as StoredOutcome) : null;
  }
  putOutcome(outcome: StoredOutcome): StoredOutcome {
    const saved = { ...outcome, updatedAt: this.now() };
    this.db.query("INSERT INTO team_outcomes(id,value) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value").run(saved.id, JSON.stringify(saved));
    return saved;
  }
  /** A new outcome, with a room of its own (its id the outcome's) holding the agents you named for it. */
  createOutcome(raw: TeamOutcomeInput): StoredOutcome {
    const input = teamInput(TeamOutcomeInput, raw);
    teamText([input.title, input.goal, input.done ?? ""].join("\n"));
    return this.db.transaction(() => {
      for (const agent of input.agents) this.requireAgent(agent);
      const key = id("out");
      if (this.rooms().length >= TEAM_LIMITS.rooms) throw new TeamError(409, `At most ${TEAM_LIMITS.rooms} team rooms can live on this node.`);
      const at = this.now();
      this.putRoom({ id: key, name: input.title, members: input.agents, direct: false, turnBudget: 8, paused: false, createdAt: at, updatedAt: at });
      return this.putOutcome({ id: key, room: key, title: input.title, goal: input.goal, done: input.done ?? null, agents: input.agents, budgetUsd: input.budgetUsd, leadUsd: 0, status: "active", notes: "", reportHour: input.reportHour ?? 9, tz: input.tz ?? "UTC", lastLookAt: null, lastReportAt: null, ended: null, seen: { tasks: [], message: null }, createdAt: at, updatedAt: at });
    })();
  }
  /** A direct conversation with a worker that was removed: kept to read (by its id), and taking no new words or work. */
  private closed(room: TeamRoom): boolean { return room.direct && room.members.some((member) => !this.agent(member)); }
  /** The rooms that are still in use. */
  private openRooms(): TeamRoom[] { return this.rooms().filter((room) => !this.closed(room)); }
  requireRoom(id: string): TeamRoom {
    const room = this.room(id);
    if (!room) throw new TeamError(404, "No such team room.");
    return room;
  }
  private putRoom(room: TeamRoom): TeamRoom {
    this.db.query("INSERT INTO team_rooms(id,value) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value").run(room.id, JSON.stringify(room));
    return room;
  }
  saveRoom(raw: TeamRoomInput): TeamRoom {
    const input = teamInput(TeamRoomInput, raw);
    teamText(input.name);
    for (const member of input.members) this.requireAgent(member);
    const previous = input.id ? this.room(input.id) : null;
    const direct = input.direct ?? previous?.direct ?? false;
    if (direct && input.members.length > 2) throw new TeamError(400, "A direct conversation has one or two agents.");
    if (previous?.direct && (direct !== true || [...previous.members].sort().join() !== [...input.members].sort().join())) throw new TeamError(409, "The people in a direct conversation cannot be changed.");
    if (!previous && this.rooms().length >= TEAM_LIMITS.rooms) throw new TeamError(409, `At most ${TEAM_LIMITS.rooms} team rooms can live on this node.`);
    const at = this.now();
    const saved = this.putRoom({ id: input.id ?? id("room"), name: input.name, members: input.members, direct, turnBudget: input.turnBudget ?? previous?.turnBudget ?? 8, paused: previous?.paused ?? false, createdAt: previous?.createdAt ?? at, updatedAt: at });
    // Membership is checked again when work starts; removed participants never see new history.
    return saved;
  }
  direct(agent: string, from?: string): TeamRoom {
    const target = this.requireAgent(agent);
    if (from) this.requireAgent(from);
    if (from === agent) throw new TeamError(400, "An agent cannot send a direct message to itself.");
    const members = from ? [from, agent].sort() : [agent];
    const existing = this.rooms().find((r) => r.direct && [...r.members].sort().join() === members.join());
    return existing ?? this.saveRoom({ name: from ? `${this.requireAgent(from).name} & ${target.name}`.slice(0, 100) : target.name, members, direct: true });
  }
  private chain(room: TeamRoom): string {
    const chain = id("chain");
    this.db.query("INSERT INTO team_chains(id,budget) VALUES(?,?)").run(chain, room.turnBudget);
    return chain;
  }
  /** Work in sight: running, waiting its turn, or proposed and waiting for you. All of it is bounded together. */
  private pending(): number { return this.db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM team_jobs WHERE status IN ('proposed','queued','running')").get()!.n; }
  private roomMember(room: TeamRoom, agent: string): void {
    this.requireAgent(agent);
    if (!room.members.includes(agent)) throw new TeamError(403, "That agent is not a member of this room.");
  }
  /** Owner posts start a bounded chain, and so do the primary's own from your conversation (`primary`), within its
   * allowance for the day. Brokered posts keep their originating chain across rooms, and so does its answer in a room
   * (`reply`): that was asked for, so it is no part of its allowance. `asker`: the device you wrote on. */
  post(raw: TeamPostInput, by: { agent?: string; chainId?: string; output?: boolean; primary?: boolean; reply?: boolean; quiet?: boolean; asker?: Exclude<TeamAsker, { kind: "agent" }> } = {}): TeamMessage {
    const input = teamInput(TeamPostInput, raw);
    if (!by.output) teamText(input.text);
    // Files are yours alone to bring: an agent's or the primary's words carry none.
    if (input.attachments && (by.agent || by.primary || by.output)) throw new TeamError(403, "Only you bring files to the agents.");
    return this.db.transaction(() => {
      const room = this.requireRoom(input.room);
      if (by.reply ? !by.primary || by.agent || !by.chainId : by.primary && (by.agent || by.chainId)) throw new TeamError(400, "Your agent speaks for itself, in a conversation of its own.");
      if (by.primary && !by.reply && this.saidToday() >= TEAM_LIMITS.saysPerDay) {
        throw new TeamError(429, `Your agent has sent ${TEAM_LIMITS.saysPerDay} messages to the agents in the last day, which is its allowance. The owner can message the agents among the agents.`);
      }
      if (by.agent) this.roomMember(room, by.agent);
      // (Only a direct conversation can still name a worker that was removed: it is kept to read, and takes no new words.)
      for (const member of room.members) this.requireAgent(member);
      if (by.agent && !by.chainId) throw new TeamError(403, "An agent message must belong to its current conversation.");
      if (by.chainId && !this.db.query("SELECT id FROM team_chains WHERE id = ?").get(by.chainId)) throw new TeamError(404, "No such conversation chain.");
      const named = mentioned(input.text, room.members.map((member) => this.requireAgent(member)));
      // What you say to a room of agents without naming one is the primary's.
      const unnamed = !by.primary && !by.agent && !by.reply && !room.direct && !named.length;
      // The primary hears what names it, and what you say to a room of agents without naming one when it leads it: it answers
      // it, or names who should take it up. In an agent's own conversation with you, your words stay the agent's unless you name it.
      const forPrimary = !by.primary && (mentioned(input.text, PRIMARY_SEAT).length > 0 || (unnamed && !named.length));
      // Those it names with @ (by handle or name) hear it. One that names nobody here reaches everyone, unless it was its
      // to answer, or is its answer: that was for whoever asked.
      const recipients = by.quiet ? [] : (named.length || forPrimary || by.reply ? named : room.members).filter((member) => member !== by.agent);
      if (this.pending() + recipients.length > TEAM_LIMITS.pending) throw new TeamError(429, "The team queue is full. Let some work finish first.");
      // Its own words never fill it: half is always left for yours, however much of its waits in held rooms.
      if (by.primary && this.pending() + recipients.length > TEAM_LIMITS.pending / 2) throw new TeamError(429, "Half the team queue is waiting work already. Let some of it finish before writing to them again.");
      const chainId = by.chainId ?? this.chain(room);
      const at = this.now();
      const message: TeamMessage = { id: id("message"), room: room.id, speaker: by.agent ?? (by.primary ? TEAM_PRIMARY : TEAM_OWNER), speakerName: by.agent ? this.requireAgent(by.agent).name : by.primary ? "Your agent" : "You", text: by.output ? teamOutput(input.text, TEAM_LIMITS.message) : input.text, createdAt: at, chainId };
      if (input.attachments) message.attachments = input.attachments;
      this.db.query("INSERT INTO team_messages(id,room,speaker,speaker_name,text,created_at,chain_id,attachments) VALUES(?,?,?,?,?,?,?,?)").run(message.id, message.room, message.speaker, message.speakerName, message.text, at, chainId, input.attachments ? JSON.stringify(input.attachments) : null);
      for (const member of recipients) this.insertJob("delivery", room.id, member, chainId, { trigger: message.id });
      if (forPrimary) this.queueAnswer(room.id, message, by.agent ? { kind: "agent", agent: by.agent } : (by.asker ?? { kind: "admin" }));
      this.putRoom({ ...room, updatedAt: at });
      return message;
    })();
  }
  /** What the primary said to the agents in the last day from its own conversation: its allowance. Its answers in rooms were asked for. */
  /** Every file a kept message carries: what uploads.ts keeps whatever its age (rooms keep their words). */
  attachmentIds(): Set<string> {
    const ids = new Set<string>();
    for (const row of this.db.query<{ attachments: string }, []>("SELECT attachments FROM team_messages WHERE attachments IS NOT NULL").all()) {
      for (const a of attachmentsOf(row.attachments)) ids.add(a.id);
    }
    return ids;
  }
  private saidToday(): number {
    return this.db.query<{ n: number }, [string, number]>("SELECT COUNT(*) AS n FROM team_messages m WHERE m.speaker = ? AND m.created_at > ? AND NOT EXISTS (SELECT 1 FROM team_answers a WHERE a.reply = m.id)").get(TEAM_PRIMARY, this.now() - DAY)!.n;
  }
  /** One answer of its waits per room, for its newest words, in their conversation; if you asked as well as an agent, it is yours. */
  private queueAnswer(room: string, message: TeamMessage, asker: TeamAsker): void {
    const at = this.now();
    const waiting = this.db.query<AnswerRow, [string]>("SELECT * FROM team_answers WHERE room=? AND status='queued'").get(room);
    if (!waiting) {
      this.db.query("INSERT INTO team_answers(id,room,chain_id,trigger,asker,status,created_at,updated_at) VALUES(?,?,?,?,?,'queued',?,?)").run(id("answer"), room, message.chainId, message.id, JSON.stringify(asker), at, at);
      return;
    }
    const before = JSON.parse(waiting.asker) as TeamAsker;
    this.db.query("UPDATE team_answers SET chain_id=?,trigger=?,asker=?,updated_at=? WHERE id=?").run(message.chainId, message.id, JSON.stringify(before.kind === "agent" ? asker : before), at, waiting.id);
  }
  private answerRow(key: string): AnswerRow | null { return this.db.query<AnswerRow, [string]>("SELECT * FROM team_answers WHERE id=?").get(key); }
  answer(key: string): TeamAnswer | null { const row = this.answerRow(key); return row ? answerOf(row) : null; }
  /** Its answers waiting their turn, oldest first. */
  queuedAnswers(): TeamAnswer[] { return this.db.query<AnswerRow, []>("SELECT * FROM team_answers WHERE status='queued' ORDER BY seq").all().map(answerOf); }
  /** Its turn to answer: the room open and not paused, no answer of its already under way in it, and the conversation's
   * budget not spent (its turn spends it as an agent's does). */
  claimAnswer(key: string): boolean {
    return this.db.transaction(() => {
      const row = this.answerRow(key);
      if (!row || row.status !== "queued") return false;
      const room = this.requireRoom(row.room);
      if (this.closed(room)) { this.finishAnswer(key, "stopped", CLOSED); return false; }
      if (room.paused || this.db.query("SELECT id FROM team_answers WHERE room=? AND status='running'").get(row.room)) return false;
      const chain = this.db.query<{ budget: number; spent: number }, [string]>("SELECT budget,spent FROM team_chains WHERE id=?").get(row.chain_id);
      if (!chain || chain.spent >= chain.budget) { this.finishAnswer(key, "stopped", "This conversation reached its turn budget. Start a new message to continue."); return false; }
      this.db.query("UPDATE team_chains SET spent=spent+1 WHERE id=?").run(row.chain_id);
      this.db.query("UPDATE team_answers SET status='running',error=NULL,updated_at=? WHERE id=? AND status='queued'").run(this.now(), key);
      return true;
    })();
  }
  /** Its answer, posted in its room and its record closed together. It reaches only the agents it names; empty: it had
   * nothing to add. With `error` it failed, and the text says so. */
  answered(key: string, text: string, error: string | null = null): TeamMessage | null {
    return this.db.transaction(() => {
      const row = this.answerRow(key);
      if (!row || row.status !== "running") throw new TeamError(409, "This answer has stopped.");
      const message = text ? this.post({ room: row.room, text }, { primary: true, reply: true, chainId: row.chain_id, output: true }) : null;
      this.db.query("UPDATE team_answers SET status=?,error=?,reply=?,updated_at=? WHERE id=?").run(error ? "failed" : "done", error ? teamOutput(error, 2000) : null, message?.id ?? null, this.now(), key);
      return message;
    })();
  }
  finishAnswer(key: string, status: "stopped" | "interrupted" | "failed", error: string): void {
    this.db.query("UPDATE team_answers SET status=?,error=?,updated_at=? WHERE id=? AND status IN ('queued','running')").run(status, teamOutput(error, 2000), this.now(), key);
  }
  /** Its answers as a room's deliveries are shown: what is under way, then the latest that ended. */
  private primaryAnswers(room?: string): TeamDelivery[] {
    const rows = room
      ? this.db.query<AnswerRow, [string]>("SELECT * FROM team_answers WHERE room=? ORDER BY status IN ('queued','running') DESC,seq DESC LIMIT 16").all(room)
      : this.db.query<AnswerRow, []>("SELECT * FROM team_answers WHERE status IN ('queued','running') ORDER BY seq DESC LIMIT 128").all();
    return rows.map((r) => ({ id: r.id, room: r.room, agent: TEAM_PRIMARY, trigger: r.trigger, chainId: r.chain_id, status: r.status, error: r.error, createdAt: r.created_at, updatedAt: r.updated_at }));
  }
  /** The primary's own words to one worker (in the conversation you have with it) or to a room: all of it or nothing,
   * so a message that is refused leaves no conversation behind. */
  say(raw: TeamSayInput): TeamMessage {
    const input = teamInput(TeamSayInput, raw);
    return this.db.transaction(() => this.post({ room: input.room ?? this.direct(input.agent!).id, text: input.text }, { primary: true }))();
  }
  /** Its words in a room for you, waking no agent: what it tells you of an outcome it owns (outcomes.ts). */
  note(room: string, text: string): TeamMessage {
    teamText(text);
    // A reply in a conversation of its own, for you: it reaches nobody, even an agent it names (an outcome's note that
    // said "I've given @max the task" woke Max for a reply, which held its next task behind it).
    return this.db.transaction(() => this.post({ room, text }, { primary: true, reply: true, quiet: true, chainId: this.chain(this.requireRoom(room)) }))();
  }
  messages(room: string, limit: number = TEAM_LIMITS.history): TeamMessage[] {
    this.requireRoom(room);
    const count = Math.max(1, Math.min(TEAM_LIMITS.history, Math.trunc(limit) || TEAM_LIMITS.history));
    return this.db.query<MessageRow, [string, number]>("SELECT * FROM team_messages WHERE room = ? ORDER BY seq DESC LIMIT ?").all(room, count).reverse().map(messageOf);
  }
  private insertJob(kind: JobRow["kind"], room: string, agent: string, chain: string, data: unknown, status: "queued" | "proposed" = "queued"): string {
    const key = id(kind === "task" ? "task" : "delivery");
    const at = this.now();
    this.db.query("INSERT INTO team_jobs(id,kind,room,agent,chain_id,status,data,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)").run(key, kind, room, agent, chain, status, JSON.stringify(data), at, at);
    return key;
  }
  /** `own`: the primary gives it on its own word (TeamService.giveOwn), so its budget is kept as what it committed (team_own). */
  createTask(raw: TeamTaskInput, by: { agent?: string; chainId?: string; givenBy?: string; fix?: TeamTaskFix; propose?: boolean; own?: boolean } = {}): TeamTask {
    const input = teamInput(TeamTaskInput, raw);
    teamText([input.title, input.goal, ...(input.gates ?? [])].join("\n"));
    return this.db.transaction(() => {
      const room = this.requireRoom(input.room);
      if (this.closed(room)) throw new TeamError(410, CLOSED);
      this.roomMember(room, input.assignee);
      if (by.agent) this.roomMember(room, by.agent);
      if (by.agent && !by.chainId) throw new TeamError(403, "A delegated task must belong to the current conversation.");
      for (const dependency of input.dependsOn ?? []) {
        const task = this.task(dependency);
        if (!task || task.room !== room.id) throw new TeamError(400, "Every dependency must already exist in this room.");
      }
      if (this.pending() >= TEAM_LIMITS.pending) throw new TeamError(429, "The team queue is full. Let some work finish first.");
      // The primary's own giving is within its allowance for the day; yours is not counted, nor an outcome's (its own allowance and budget: outcomes.ts).
      if (by.givenBy === TEAM_PRIMARY && !input.outcome && !by.propose && this.db.query<{ n: number }, [string, number]>("SELECT COUNT(*) AS n FROM team_jobs WHERE kind = 'task' AND json_extract(data, '$.givenBy') = ? AND json_extract(data, '$.outcome') IS NULL AND created_at > ?").get(TEAM_PRIMARY, this.now() - 86_400_000)!.n >= TEAM_LIMITS.givesPerDay) {
        throw new TeamError(429, `Your agent has given agents ${TEAM_LIMITS.givesPerDay} tasks in the last day, which is its allowance. More can be given on the Agents page.`);
      }
      // Sensitive mode (heldModels): the models you named for it; work an agent in sensitive mode gives is held to its
      // models, whoever does it; and one in it is given none held to others.
      const models = input.models ?? (by.agent ? heldModels(this.requireAgent(by.agent)) ?? undefined : undefined);
      const assignee = this.requireAgent(input.assignee);
      try {
        heldModels(assignee, { models });
      } catch (error) {
        throw new TeamError(400, (error as Error).message);
      }
      if (models && assignee.harness === "acp") throw new TeamError(400, `${assignee.name} works in an ACP agent of yours, which calls the models you set it up with: a task in sensitive mode goes to an agent on your agent's own harness, OpenCode, Hermes, Claude Code or Codex.`);
      // Started from a step of another task (PLAN #15): the same agent's, whose VM keeps that step's checkpoint.
      let from: TeamTask["from"];
      if (input.from) {
        const source = this.task(input.from.task);
        if (!source) throw new TeamError(404, "No such task to start from.");
        if (source.assignee !== input.assignee) throw new TeamError(400, `A task starts from a step of its own agent's work: task ${source.id} is ${source.assignee}'s, and its steps are kept in that agent's VM.`);
        const point = this.checkpoint(source.id, input.from.step);
        if (!point) throw new TeamError(400, `Task ${source.id} has no step ${input.from.step} kept to start from.`);
        from = { task: source.id, step: point.step, commit: point.commit, command: point.command };
      }
      const chain = by.chainId ?? this.chain(room);
      // An agent's task is proposed to you: it is written down where it was asked for, and waits for your approval. So
      // is the work the primary offers an idle agent from your backlog (backlog.ts): a proposal isn't a give.
      const proposed = by.agent ? { proposedBy: by.agent } : by.propose ? { proposedBy: by.givenBy ?? TEAM_PRIMARY } : {};
      const key = this.insertJob("task", room.id, input.assignee, chain, { title: input.title, goal: input.goal, dependsOn: input.dependsOn ?? [], gates: input.gates ?? [], ...(input.budgetUsd !== undefined ? { budgetUsd: input.budgetUsd } : {}), verified: false, progress: "", output: "", ...(by.givenBy ? { givenBy: by.givenBy } : {}), ...(input.outcome ? { outcome: input.outcome } : {}), ...(models ? { models: [...models] } : {}), ...(from ? { from } : {}), ...(by.fix ? { fix: by.fix } : {}), ...proposed }, by.agent || by.propose ? "proposed" : "queued");
      if (by.own) this.db.query("INSERT INTO team_own(task,usd,at) VALUES(?,?,?)").run(key, input.budgetUsd ?? 0, this.now());
      return this.task(key)!;
    })();
  }
  /**
   * What one node has handed here (its tasks' givenBy, `node:<id>`): how many wait for you, are queued or are running
   * now, and what those it handed under your grant since `since` count against its day (each one's budget, the most it
   * may spend, or HANDOFF_MIN_USD if that is more: core's handoffCounts).
   */
  handed(by: string, since: number): { atOnce: number; given: number } {
    const atOnce = this.db.query<{ n: number }, [string]>("SELECT COUNT(*) AS n FROM team_jobs WHERE kind = 'task' AND status IN ('proposed','queued','running') AND json_extract(data, '$.givenBy') = ?").get(by)!.n;
    const given = this.db.query<{ usd: number | null }, [number, string, number]>("SELECT SUM(MAX(COALESCE(json_extract(data, '$.budgetUsd'), 0), ?)) AS usd FROM team_jobs WHERE kind = 'task' AND json_extract(data, '$.givenBy') = ? AND json_extract(data, '$.proposedBy') IS NULL AND created_at > ?").get(HANDOFF_MIN_USD, by, since)!.usd ?? 0;
    return { atOnce, given };
  }
  /** The tasks other nodes handed here that haven't ended (waiting for you, queued, running, or cut off): each by id, who
   * handed it (`node:<id>`), and whether it was taken under your grant rather than proposed to you. */
  handedOpen(): { id: string; by: string; granted: boolean }[] {
    return this.db
      .query<{ id: string; giver: string; proposed: string | null }, []>("SELECT id, json_extract(data, '$.givenBy') AS giver, json_extract(data, '$.proposedBy') AS proposed FROM team_jobs WHERE kind = 'task' AND status IN ('proposed','queued','running','interrupted') AND json_extract(data, '$.givenBy') LIKE 'node:%' ORDER BY seq")
      .all()
      .map((r) => ({ id: r.id, by: r.giver, granted: r.proposed === null }));
  }
  /** Interrupted work nobody should take up again (another node's hand-off whose call ended with it): stopped, in these words. */
  endInterrupted(key: string, error: string): void {
    const row = this.jobRow(key);
    if (row?.status !== "interrupted") return;
    const data = JSON.parse(row.data);
    delete data.restart;
    this.db.query("UPDATE team_jobs SET status='stopped',error=?,data=?,updated_at=? WHERE id=?").run(teamOutput(error, 2000), JSON.stringify(data), this.now(), key);
  }
  /** A task's work, shipped as a pull request on your word (PLAN #37): said on it from then on. */
  markShipped(key: string, shipped: TeamTaskShipped): void {
    const row = this.jobRow(key);
    if (row?.kind !== "task") return;
    // (When it ended stays as it was: shipping it is not more of its work.)
    this.db.query("UPDATE team_jobs SET data=? WHERE id=?").run(JSON.stringify({ ...JSON.parse(row.data), shipped }), key);
  }
  /** A step of a task's work, kept as it ended (PLAN #15): the runner says each once. Anything that isn't one is passed over. */
  keepCheckpoint(task: string, point: TeamCheckpoint): void {
    if (!/^[0-9a-f]{40}$/.test(point.commit) || !Number.isSafeInteger(point.step) || point.step < 1) return;
    this.db.query("INSERT OR IGNORE INTO team_checkpoints(task,step,at,commit_id,command) VALUES(?,?,?,?,?)").run(task, point.step, point.at, point.commit, teamOutput(point.command, 300));
  }
  /** The steps of a task another can be started from, the first first. */
  checkpoints(task: string): TeamCheckpoint[] {
    return this.db.query<{ step: number; at: number; commit_id: string; command: string }, [string]>("SELECT step, at, commit_id, command FROM team_checkpoints WHERE task = ? ORDER BY step").all(task).map((r) => ({ step: r.step, commit: r.commit_id, command: r.command, at: r.at }));
  }
  checkpoint(task: string, step: number): TeamCheckpoint | null {
    const r = this.db.query<{ step: number; at: number; commit_id: string; command: string }, [string, number]>("SELECT step, at, commit_id, command FROM team_checkpoints WHERE task = ? AND step = ?").get(task, step);
    return r ? { step: r.step, commit: r.commit_id, command: r.command, at: r.at } : null;
  }
  /** Whether kept work is of work in sensitive mode (heldModels): as its label says, its agent's mode, or its task's. */
  sensitiveWork(artifact: { id: string; label: string; sandbox?: string | null }): boolean {
    if (artifact.label.endsWith(SENSITIVE_WORK)) return true;
    if (artifact.sandbox && this.agents().some((t) => t.sensitive && t.workspace?.id === artifact.sandbox)) return true;
    return Boolean(this.taskOfWork(artifact.id)?.models?.length);
  }
  /** The task whose kept work this is (an artifact's id), if it was this node's agents'. */
  taskOfWork(artifact: string): TeamTask | null {
    const row = this.db.query<JobRow, [string]>("SELECT * FROM team_jobs WHERE kind='task' AND json_extract(data,'$.changes.artifact') = ? ORDER BY seq DESC LIMIT 1").get(artifact);
    return row ? this.taskOf(row) : null;
  }
  /** The fixes given for a pull request's branch (PLAN #29), the first first. */
  fixesOf(owner: string, repo: string, branch: string): TeamTask[] {
    return this.db
      .query<JobRow, [string, string, string]>("SELECT * FROM team_jobs WHERE kind='task' AND lower(json_extract(data,'$.fix.owner')) = lower(?) AND lower(json_extract(data,'$.fix.repo')) = lower(?) AND json_extract(data,'$.fix.branch') = ? ORDER BY seq")
      .all(owner, repo, branch)
      .map((row) => this.taskOf(row));
  }
  private jobRow(id: string): JobRow | null { return this.db.query<JobRow, [string]>("SELECT * FROM team_jobs WHERE id = ?").get(id); }
  job(id: string): TeamJob | null { const row = this.jobRow(id); return row ? jobOf(row) : null; }
  private taskOf(row: JobRow): TeamTask {
    const data = JSON.parse(row.data) as Pick<TeamTask, "title" | "goal" | "dependsOn" | "gates" | "budgetUsd" | "verified" | "progress" | "output" | "record" | "changes" | "givenBy" | "proposedBy" | "interventions" | "outcome" | "models" | "from" | "fix" | "shipped" | "steers">;
    return { ...data, id: row.id, room: row.room, assignee: row.agent, chainId: row.chain_id, status: row.status, error: row.error, createdAt: row.created_at, updatedAt: row.updated_at };
  }
  task(id: string): TeamTask | null { const row = this.jobRow(id); return row?.kind === "task" ? this.taskOf(row) : null; }
  /** Keep current work visible however much history accumulated while it ran. The active query
   * uses the status index; the history query walks recent sequence numbers, not a full-history sort. */
  private listedJobs(kind: JobRow["kind"], room?: string): JobRow[] {
    const active = room
      ? this.db.query<JobRow, [string, string]>("SELECT * FROM team_jobs WHERE kind=? AND room=? AND status IN ('running','queued','proposed') ORDER BY status='running' DESC,seq DESC LIMIT 512").all(kind, room)
      : this.db.query<JobRow, [string]>("SELECT * FROM team_jobs WHERE kind=? AND status IN ('running','queued','proposed') ORDER BY status='running' DESC,seq DESC LIMIT 512").all(kind);
    const remaining = 512 - active.length;
    if (remaining <= 0) return active;
    const recent = room
      ? this.db.query<JobRow, [string, string, number]>("SELECT * FROM team_jobs WHERE kind=? AND room=? AND status NOT IN ('running','queued','proposed') ORDER BY seq DESC LIMIT ?").all(kind, room, remaining)
      : this.db.query<JobRow, [string, number]>("SELECT * FROM team_jobs WHERE kind=? AND status NOT IN ('running','queued','proposed') ORDER BY seq DESC LIMIT ?").all(kind, remaining);
    return [...active, ...recent];
  }
  tasks(room?: string): TeamTask[] {
    return this.listedJobs("task", room).map((r) => this.taskOf(r));
  }
  deliveries(room?: string): TeamDelivery[] {
    return this.listedJobs("delivery", room).map((r) => ({ id: r.id, room: r.room, agent: r.agent, trigger: (JSON.parse(r.data) as { trigger: string }).trigger, chainId: r.chain_id, status: r.status, error: r.error, createdAt: r.created_at, updatedAt: r.updated_at }));
  }
  queued(): TeamJob[] { return this.db.query<JobRow, []>("SELECT * FROM team_jobs WHERE status='queued' ORDER BY seq").all().map(jobOf); }
  /** A bounded public activity projection: no titles, messages, errors or task JSON
   * leave the store with it. Keep old live jobs and only a minute of terminal states. */
  avatarActivity(): AvatarActivity {
    const rows = this.db.query<{ kind: JobRow["kind"]; agent: string; status: TeamWorkStatus; updatedAt: number }, [number, number]>(`
      SELECT kind,agent,status,MAX(updated_at) AS updatedAt FROM (
        SELECT kind,agent,status,updated_at FROM team_jobs WHERE status IN ('running','queued')
        UNION ALL
        SELECT kind,agent,status,updated_at FROM team_jobs WHERE updated_at >= ? AND status NOT IN ('running','queued')
      )
      GROUP BY agent,kind,status
      ORDER BY status IN ('running','queued') DESC,updatedAt DESC LIMIT ?
    `).all(this.now() - 60_000, TEAM_LIMITS.agents * 12);
    const tasks: AvatarActivity["tasks"][number][] = [];
    const deliveries: AvatarActivity["deliveries"][number][] = [];
    for (const row of rows) {
      // finish() only permits a task to reach done after a verified result.
      if (row.kind === "task") tasks.push({ assignee: row.agent, status: row.status, verified: row.status === "done", updatedAt: row.updatedAt });
      else deliveries.push({ agent: row.agent, status: row.status, updatedAt: row.updatedAt });
    }
    return { tasks, deliveries };
  }
  snapshot(): TeamSnapshot {
    // Its kept conversations, yours with it first: they are in no other list.
    const direct = this.rooms().filter((room) => room.direct).sort((a, b) => a.members.length - b.members.length);
    const removed = this.removed().map(({ id, name, removedAt }) => { const conversations = direct.filter((room) => room.members.includes(id)).map((room) => room.id); return { id, name, removedAt, ...(conversations.length ? { conversations } : {}) }; });
    const computer = this.computer();
    // Where its own merging stands: each repository you gave an agent, and each where you turned it off.
    const merging = mergingOf(this.agents(), this.mergeOff());
    return { northStar: this.northStar(this.now() - 30 * 86_400_000), agents: this.agents(), rooms: this.openRooms(), tasks: this.tasks(), deliveries: [...this.deliveries(), ...this.primaryAnswers()], ...(removed.length ? { removed } : {}), ...(this.engram() ? { engram: true } : {}), ...(this.ciBack() ? { ciBack: true } : {}), ...(this.writesFirst() ? { writesFirst: true } : {}), ...(this.backlog() ? { backlog: true } : {}), ownDailyUsd: this.ownDaily(), ...(this.mergeOff().length ? { mergeOff: this.mergeOff() } : {}), ...(merging.length ? { merging } : {}), ...(computer ? { computer } : {}), seen: this.seen() };
  }
  /**
   * Which writing of the team this is, for the live stream: the rows this store has written, and the database's
   * count of what another connection wrote. Says nothing of what changed.
   */
  version(): string {
    const { n } = this.db.query<{ n: number }, []>("SELECT total_changes() AS n").get()!;
    const { data_version } = this.db.query<{ data_version: number }, []>("PRAGMA data_version").get()!;
    return `${n}.${data_version}`;
  }
  /** When you last looked at each agent's page (`agent:<id>`) and each room (`room:<id>`), on any device. */
  seen(): Record<string, number> {
    return Object.fromEntries(this.db.query<{ key: string; at: number }, []>("SELECT key, at FROM team_seen").all().map((row) => [row.key, row.at]));
  }
  /** You looked at an agent's page or a room just now: what ended there so far is no longer new. */
  see(key: `agent:${string}` | `room:${string}`): void {
    this.db.query("INSERT INTO team_seen (key, at) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET at = MAX(at, excluded.at)").run(key, this.now());
  }
  /** The team as the primary itself reads it: bounded, and without anyone's working notes. `room`: that room's latest words too. */
  overview(room?: string): TeamOverview {
    const all = this.agents();
    const active = this.db.query<{ agent: string; status: TeamWorkStatus }, []>("SELECT agent,status FROM team_jobs WHERE status IN ('running','queued')").all();
    const state = (t: Agent): TeamOverview["workers"][number]["state"] =>
      active.some((job) => job.agent === t.id && job.status === "running") ? "working" : !t.enabled ? "paused" : t.turnsToday >= t.dailyTurns ? "allowance spent" : active.some((job) => job.agent === t.id) ? "queued" : "ready";
    const asked = room === undefined ? null : this.requireRoom(room);
    return {
      workers: all.map((t) => ({ id: t.id, name: t.name, role: t.role, harness: t.harness, job: clipped(t.instructions, OVERVIEW.job), madeBy: t.createdBy ?? TEAM_OWNER, state: state(t), turnsToday: t.turnsToday, dailyTurns: t.dailyTurns, repository: t.repository, workspace: Boolean(t.workspace) })),
      rooms: this.openRooms().map(({ id, name, members, direct, paused, turnBudget }) => ({ id, name, members, direct, paused, turnBudget })),
      ...(asked ? { room: {
        id: asked.id, name: asked.name, members: asked.members, direct: asked.direct, paused: asked.paused,
        messages: this.messages(asked.id, OVERVIEW.messages).map(({ speaker, speakerName, text, createdAt }) => ({ speaker, speakerName, text: clipped(text, OVERVIEW.message), createdAt })),
        tasks: this.tasks(asked.id).slice(0, 32).map(({ id, title, assignee, status, verified }) => ({ id, title, assignee, status, verified })),
      } } : {}),
      spare: this.spare(all),
    };
  }
  roomView(id: string): TeamRoomView { return { ...this.requireRoom(id), messages: this.messages(id), tasks: this.tasks(id), deliveries: [...this.deliveries(id), ...this.primaryAnswers(id)] }; }

  /** Daily allowance and the cross-room causal allowance are reserved together, before any callback runs. */
  claim(key: string): boolean {
    return this.db.transaction(() => {
      const row = this.jobRow(key);
      if (!row || row.status !== "queued") return false;
      // (Never a throw here: one job that cannot run must not hold up everyone else's.)
      const agent = this.agent(row.agent);
      if (!agent) { this.finish(key, "stopped", REMOVED); return false; }
      const room = this.requireRoom(row.room);
      if (this.closed(room)) { this.finish(key, "stopped", CLOSED); return false; }
      if (!room.members.includes(agent.id)) { this.finish(key, "stopped", "The agent is no longer in this room."); return false; }
      if (!agent.enabled || room.paused) return false;
      if (this.db.query("SELECT id FROM team_jobs WHERE agent=? AND status='running'").get(agent.id)) return false;
      if (row.kind === "task") {
        const task = this.taskOf(row);
        if (!task.dependsOn.every((key) => { const before = this.task(key); return before?.status === "done" && before.verified; })) return false;
      }
      const chain = this.db.query<{ budget: number; spent: number }, [string]>("SELECT budget,spent FROM team_chains WHERE id=?").get(row.chain_id);
      if (!chain || chain.spent >= chain.budget) { this.finish(key, "stopped", "This conversation reached its turn budget. Start a new message to continue."); return false; }
      if (this.turns(agent.id) >= agent.dailyTurns) return false;
      this.db.query("INSERT INTO team_usage(agent,day,turns) VALUES(?,?,1) ON CONFLICT(agent,day) DO UPDATE SET turns=turns+1").run(agent.id, this.day());
      this.db.query("UPDATE team_chains SET spent=spent+1 WHERE id=?").run(row.chain_id);
      this.db.query("UPDATE team_jobs SET status='running',error=NULL,updated_at=? WHERE id=? AND status='queued'").run(this.now(), key);
      return true;
    })();
  }
  progress(key: string, text: string, line?: Pick<TeamTrailEntry, "outputChars">): void {
    const row = this.jobRow(key);
    if (!row || row.kind !== "task" || row.status !== "running") return;
    const at = this.now();
    const data = { ...JSON.parse(row.data), progress: teamOutput(text, TEAM_LIMITS.progress) };
    this.db.transaction(() => {
      this.db.query("UPDATE team_jobs SET data=?,updated_at=? WHERE id=?").run(JSON.stringify(data), at, key);
      this.trailLine(key, at, text, line?.outputChars);
    })();
  }
  /**
   * You stepped in on a task (#28): counted on it by how, with a line on its trail saying so. A desktop taken over counts
   * once a task, however many clicks it took. Returns whether it was counted.
   */
  intervene(key: string, kind: InterventionKind, text: string): boolean {
    const row = this.jobRow(key);
    if (!row || row.kind !== "task") return false;
    const data = JSON.parse(row.data) as { interventions?: Partial<Record<InterventionKind, number>> };
    const counts = { ...data.interventions };
    if (kind === "takeover" && counts.takeover) return false;
    counts[kind] = (counts[kind] ?? 0) + 1;
    const at = this.now();
    this.db.transaction(() => {
      this.db.query("UPDATE team_jobs SET data=? WHERE id=?").run(JSON.stringify({ ...data, interventions: counts }), key);
      this.trailLine(key, at, `You stepped in: ${text}`);
    })();
    return true;
  }
  /**
   * Your words, or your agent's, to a task that is running (core's TeamSteer): kept on it until its run takes them
   * (takeSteers), TEAM_LIMITS.steers in all. Yours is stepping in (#28), counted in the same write; your agent's is not.
   * Its trail says nothing yet: its run says them where it takes them.
   */
  steer(key: string, by: TeamSteer["by"], raw: string): TeamSteer {
    const text = teamInput(SteerText, raw);
    teamText(text);
    return this.db.transaction(() => {
      const row = this.jobRow(key);
      if (!row || row.kind !== "task") throw new TeamError(404, "No such team task.");
      const data = JSON.parse(row.data) as { steers?: TeamSteer[]; interventions?: Partial<Record<InterventionKind, number>>; rest?: { until?: unknown }; restart?: { until?: unknown } };
      // (Resting until its plan resets, or waiting out a planned restart, it goes on by itself: kept for that run.)
      const goesOn = row.status === "interrupted" && (typeof data.rest?.until === "number" || typeof data.restart?.until === "number");
      if (row.status !== "running" && !goesOn) throw new TeamError(409, NOT_STEERED[row.status]);
      const steers = Array.isArray(data.steers) ? data.steers : [];
      if (steers.length >= TEAM_LIMITS.steers) throw new TeamError(429, `It has been steered ${steers.length} times, as many as one task takes: give it again with what you want now.`);
      // Your agent may say at most half of what one task takes: what you say always reaches it.
      const its = steers.filter((s) => s.by !== TEAM_OWNER).length;
      if (by !== TEAM_OWNER && its >= TEAM_LIMITS.steers / 2) throw new TeamError(429, `Your agent has said ${its} things to this task, as many as it may: yours still reach it.`);
      const steer: TeamSteer = { by, text, at: this.now() };
      const interventions = by === TEAM_OWNER ? { ...data.interventions, steer: (data.interventions?.steer ?? 0) + 1 } : data.interventions;
      this.db.query("UPDATE team_jobs SET data=? WHERE id=?").run(JSON.stringify({ ...data, steers: [...steers, steer], ...(interventions ? { interventions } : {}) }), key);
      return steer;
    })();
  }
  /** The steers its run hasn't taken, taken now, at `step` (the commands it had run): each once, in order, and only while it runs. */
  takeSteers(key: string, step: number): TeamSteer[] {
    return this.db.transaction(() => {
      const row = this.jobRow(key);
      if (!row || row.kind !== "task" || row.status !== "running") return [];
      const data = JSON.parse(row.data) as { steers?: TeamSteer[] };
      if (!Array.isArray(data.steers) || data.steers.every((s) => s.taken)) return [];
      const taken = { at: this.now(), step: Number.isSafeInteger(step) && step >= 0 ? step : 0 };
      const now: TeamSteer[] = [];
      const steers = data.steers.map((s) => (s.taken ? s : (now.push({ ...s, taken }), { ...s, taken })));
      this.db.query("UPDATE team_jobs SET data=? WHERE id=?").run(JSON.stringify({ ...data, steers }), key);
      return now;
    })();
  }
  /** The task an agent is running now, or null (it is at none, or at a reply). */
  runningTaskOf(agent: string): TeamTask | null {
    const row = this.db.query<JobRow, [string]>("SELECT * FROM team_jobs WHERE kind='task' AND agent=? AND status='running' ORDER BY seq LIMIT 1").get(agent);
    return row ? this.taskOf(row) : null;
  }
  /** The tasks in any of these states: one by its id, an agent's or a room's. */
  tasksIn(select: TeamSelection, statuses: readonly TeamWorkStatus[]): TeamTask[] {
    if (!statuses.length) return [];
    const rows = this.db.query<JobRow, string[]>(`SELECT * FROM team_jobs WHERE kind='task' AND status IN (${statuses.map(() => "?").join(",")}) ORDER BY seq`).all(...statuses);
    return rows.filter((row) => matches(jobOf(row), select)).map((row) => this.taskOf(row));
  }
  /** Interventions per completed task over the tasks that ended since `since` (all of them, not only the listed). */
  northStar(since: number): NorthStar {
    const rows = this.db.query<JobRow, [number]>("SELECT * FROM team_jobs WHERE kind='task' AND status IN ('done','failed','stopped') AND updated_at >= ?").all(since);
    return northStar(rows.map((r) => this.taskOf(r)), since);
  }
  /** Its trail: each line as it happened, numbered in order, kept after the task has ended. Bounded: a line is cut to
   * TRAIL.text, and once a task has more than TRAIL.keep lines the oldest go (the numbers stay as written). */
  /** A line of its own on a task's trail after it ran: what its verified work taught (a skill). */
  noteTask(key: string, text: string): void {
    if (this.jobRow(key)) this.trailLine(key, this.now(), text);
  }
  private trailLine(key: string, at: number, text: string, outputChars?: number): void {
    const n = (this.db.query<{ n: number | null }, [string]>("SELECT MAX(n) AS n FROM team_trail WHERE task=?").get(key)?.n ?? 0) + 1;
    // (A steer's line is kept whole: its words are what every client says it was told.)
    const limit = text.startsWith("Steered · ") ? Math.max(TRAIL.text, TEAM_LIMITS.steer + 64) : TRAIL.text;
    // (Its whole length, where it is a command's line: a count, never anything of what it said.)
    const chars = outputChars !== undefined && Number.isSafeInteger(outputChars) && outputChars >= 0 ? outputChars : null;
    this.db.query("INSERT INTO team_trail(task,n,at,text,output_chars) VALUES(?,?,?,?,?)").run(key, n, at, teamOutput(text, limit), chars);
    if (n > TRAIL.keep) this.db.query("DELETE FROM team_trail WHERE task=? AND n<=?").run(key, n - TRAIL.keep);
  }
  /** What a task did, as it happened: its lines after number `after` (0: from the first kept), a page at a time; `more`: there are further lines. */
  trail(task: string, after = 0): { entries: TeamTrailEntry[]; more: boolean } {
    const rows = this.db.query<{ n: number; at: number; text: string; output_chars: number | null }, [string, number, number]>("SELECT n, at, text, output_chars FROM team_trail WHERE task=? AND n>? ORDER BY n LIMIT ?").all(task, Math.max(0, Math.trunc(after)), TRAIL.page + 1);
    // (A line with no length kept has no field: as it read before lengths were.)
    const entries = rows.slice(0, TRAIL.page).map(({ n, at, text, output_chars }): TeamTrailEntry => ({ n, at, text, ...(output_chars === null ? {} : { outputChars: output_chars }) }));
    return { entries, more: rows.length > TRAIL.page };
  }
  finish(key: string, status: Exclude<TeamWorkStatus, "queued" | "running">, error: string | null = null, result?: { verified: boolean; output: string; record?: TeamTaskRecord; changes?: TeamTaskChanges }): void {
    const row = this.jobRow(key);
    if (!row || (row.status !== "queued" && row.status !== "running" && row.status !== "proposed")) return;
    const data = JSON.parse(row.data);
    if (row.kind === "task") {
      data.verified = status === "done" && result?.verified === true;
      data.output = teamOutput(result?.output ?? data.output ?? "");
      // What the run came to, as its runner counted it: counts and times, kept only if it is exactly that.
      const record = TeamTaskRecord.safeParse(result?.record);
      if (record.success) data.record = record.data;
      // What it changed and where that was kept: an artifact's id, a count and a commit, or nothing.
      const changes = TeamTaskChanges.safeParse(result?.changes);
      if (changes.success) data.changes = changes.data;
      if (status === "done" && !data.verified) { status = "failed"; error = error ?? "The work was not independently verified."; }
    }
    this.db.query("UPDATE team_jobs SET status=?,data=?,error=?,updated_at=? WHERE id=?").run(status, JSON.stringify(data), error ? teamOutput(error, 2000) : null, this.now(), key);
  }
  /**
   * Work whose coding agent found every model it could run on spent, its plan's window saying when it resets (agents'
   * RunOutcome.rest): it rests until then, and is taken up again by itself in its own session (resumeRestarted), its
   * agent's other work going on meanwhile. Spent again after TeamStore.RESTS rests, it waits for you instead: a window
   * that keeps saying it is spent isn't one that resets.
   */
  rest(key: string, until: number, why: string, result?: { verified: boolean; output: string; record?: TeamTaskRecord; changes?: TeamTaskChanges }): void {
    this.db.transaction(() => {
      const row = this.jobRow(key);
      if (!row || row.status !== "running" || row.kind !== "task") return;
      const rested = Number(JSON.parse(row.data).rest?.count) || 0;
      const clock = new Date(until).toISOString();
      const at = `${clock.slice(11, 16)} UTC${clock.slice(0, 10) === new Date(this.now()).toISOString().slice(0, 10) ? "" : ` on ${clock.slice(0, 10)}`}`;
      const again = rested >= TeamStore.RESTS;
      this.finish(key, "interrupted", again ? `${why}. It has rested for its plan's window ${rested} times already, so it waits for you: resume it when you like.` : `${why}. It rests until its plan's window resets, and goes on by itself at ${at}, in its own session.`, result);
      const data = JSON.parse(this.jobRow(key)!.data);
      data.rest = again ? { count: rested } : { until, count: rested + 1 };
      this.db.query("UPDATE team_jobs SET data=? WHERE id=?").run(JSON.stringify(data), key);
      this.trailLine(key, this.now(), again ? "Resting · its plan's window is spent again: it waits for you" : `Resting · its plan's window is spent: it goes on by itself at ${at}`);
    })();
  }
  /** How many times work rests for its plan's window before it waits for you (TeamStore.rest). */
  static readonly RESTS = 3;
  /**
   * Work a planned restart (a deploy, an update: the node stopped on purpose) cut off: interrupted, and taken up again by
   * itself after `until`, when whatever it was running in its agent's VM has surely met its own deadline there. That
   * happens once: cut off a second time, it waits for you, its room held, as work a crash cut off does (`recover`).
   */
  interruptForRestart(key: string, until: number, minutes: number): void {
    this.db.transaction(() => {
      const row = this.jobRow(key);
      if (!row || row.status !== "running") return;
      const data = JSON.parse(row.data);
      // Another node's hand-off (fabric/handoff.ts): its call ends with this restart, and nobody would follow it after,
      // so it ends here rather than run again by itself.
      if (row.kind === "task" && typeof data.givenBy === "string" && data.givenBy.startsWith("node:")) {
        this.finish(key, "stopped", "Invincible restarted during this work, which was handed over by another node: its call ended with the restart, and nobody follows it now, so it ends here rather than run again unseen.");
        return;
      }
      const again = data.restart?.resumed === true;
      // A reply is begun again from its start: one that had already done something (acted) would do it twice.
      const acted = row.kind === "delivery" && data.acted === true;
      if (again) data.restart = { resumed: true };
      else if (acted) delete data.restart;
      else data.restart = { until };
      const error = again
        ? "Invincible restarted during this work again. It was taken up once by itself already, so it waits for you: review it before resuming."
        : acted
          ? "Invincible restarted during this reply, after it had already done something (a message sent, a task proposed, a command run). Begun again it could do that twice, so it waits for you: review it before resuming."
          : `Invincible restarted during this work. It picks up again by itself once the command it was running has surely ended: at most ${minutes} minutes after the restart.`;
      this.db.query("UPDATE team_jobs SET status='interrupted',data=?,error=?,updated_at=? WHERE id=?").run(JSON.stringify(data), error, this.now(), key);
      if (again || acted) this.pauseRoom(row.room, true);
    })();
  }
  /** The account a task's work began on (I15 step 9: a seat of yours, or its tool's own sign-in in its agent's VM), or null. */
  account(key: string): TaskAccount | null {
    const row = this.jobRow(key);
    if (!row || row.kind !== "task") return null;
    const kept = TaskAccount.safeParse(JSON.parse(row.data).account);
    return kept.success ? kept.data : null;
  }
  /** Its work began on this account (TeamRunContext.onAccount): kept with the task, so work taken up again goes on on it alone. */
  keepAccount(key: string, account: TaskAccount): void {
    const row = this.jobRow(key);
    if (!row || row.kind !== "task" || row.status !== "running") return;
    const data = JSON.parse(row.data);
    data.account = TaskAccount.parse(account);
    this.db.query("UPDATE team_jobs SET data=? WHERE id=?").run(JSON.stringify(data), key);
  }
  /** Running work did something that changes something (TeamRunContext.acting): said once, in its own row. */
  acted(key: string): void {
    const row = this.jobRow(key);
    if (!row || row.status !== "running") return;
    const data = JSON.parse(row.data);
    if (data.acted === true) return;
    data.acted = true;
    this.db.query("UPDATE team_jobs SET data=? WHERE id=?").run(JSON.stringify(data), key);
  }
  /** Whether work a planned restart cut off is to be left be: "waits" while it waits to be taken up again by itself (its
   * command in the VM may still be running), "yours" once cut off a second time (it waits for you, its room held). */
  restartHold(key: string): "waits" | "yours" | null {
    const row = this.jobRow(key);
    if (!row || row.status !== "interrupted") return null;
    const restart = JSON.parse(row.data).restart as { until?: unknown; resumed?: unknown } | undefined;
    return typeof restart?.until === "number" ? "waits" : restart?.resumed === true ? "yours" : null;
  }
  /** Agents with work a restart cut off that isn't due yet: nothing else of theirs starts before it, in the same VM. */
  restartWaits(): Set<string> {
    const now = this.now();
    const waiting = new Set<string>();
    for (const row of this.db.query<JobRow, []>("SELECT * FROM team_jobs WHERE status='interrupted'").all()) {
      const until = JSON.parse(row.data).restart?.until;
      if (typeof until === "number" && until > now) waiting.add(row.agent);
    }
    return waiting;
  }
  /** Work a restart cut off whose wait is over, queued again where it stood in line, with a line on its trail saying why.
   * A removed agent's never is, and a paused agent's or a closed room's waits for you. Returns how many. */
  resumeRestarted(): number {
    return this.db.transaction(() => {
      const now = this.now();
      let taken = 0;
      for (const row of this.db.query<JobRow, []>("SELECT * FROM team_jobs WHERE status='interrupted' ORDER BY seq").all()) {
        const data = JSON.parse(row.data);
        const restart = typeof data.restart?.until === "number";
        const until = restart ? data.restart.until : typeof data.rest?.until === "number" ? data.rest.until : null;
        if (until === null || until > now) continue;
        const room = this.room(row.room);
        if (!room || this.closed(room) || !this.agent(row.agent)?.enabled) continue;
        if (restart) data.restart = { resumed: true };
        else data.rest = { count: data.rest.count };
        this.db.query("UPDATE team_jobs SET status='queued',error=NULL,chain_id=?,data=?,updated_at=? WHERE id=?").run(this.chain(room), JSON.stringify(untaken(data)), now, row.id);
        if (row.kind === "task") this.trailLine(row.id, now, restart ? "Taken up again by itself after Invincible restarted." : "Taken up again by itself: its plan's window has reset.");
        taken++;
      }
      return taken;
    })();
  }
  /** You paused or stopped work (or its agent, or its room) while it waited to be taken up after a restart: it won't be. */
  holdRestarts(select: TeamSelection, status: "interrupted" | "stopped", error: string): void {
    this.db.transaction(() => {
      for (const row of this.db.query<JobRow, []>("SELECT * FROM team_jobs WHERE status='interrupted'").all()) {
        const data = JSON.parse(row.data);
        if ((typeof data.restart?.until !== "number" && typeof data.rest?.until !== "number") || !matches(jobOf(row), select)) continue;
        delete data.restart;
        if (data.rest) data.rest = { count: data.rest.count };
        this.db.query("UPDATE team_jobs SET status=?,error=?,data=?,updated_at=? WHERE id=?").run(status, teamOutput(error, 2000), JSON.stringify(data), this.now(), row.id);
      }
    })();
  }
  /** In-flight side effects are never replayed by merely reopening a node: work a crash cut off waits for you. */
  recover(): void {
    this.db.transaction(() => {
      const running = this.db.query<JobRow, []>("SELECT * FROM team_jobs WHERE status='running'").all();
      for (const row of running) {
        this.finish(row.id, "interrupted", CUT_OFF);
        this.pauseRoom(row.room, true);
      }
      // Its answer is never given twice: one the node stopped during is said to be cut off, and asked for again by you.
      this.db.query("UPDATE team_answers SET status='interrupted',error=?,updated_at=? WHERE status='running'").run("The node stopped while your agent was answering. Ask it again.", this.now());
    })();
  }
  pauseRoom(id: string, paused: boolean): TeamRoom { return this.putRoom({ ...this.requireRoom(id), paused, updatedAt: this.now() }); }
  enable(id: string, enabled: boolean): Agent { return this.putAgent({ ...this.requireAgent(id), enabled, updatedAt: this.now() }); }
  stopQueued(select: TeamSelection): void {
    for (const job of this.queued()) if (matches(job, select)) this.finish(job.id, "stopped", "Stopped by you.");
    // Its answers wait in rooms: an agent's or a task's stopping leaves them be.
    if (!select.agent && !select.task) for (const answer of this.queuedAnswers()) if (!select.room || answer.room === select.room) this.finishAnswer(answer.id, "stopped", "Stopped by you.");
    // A proposal you stop is declined: it never ran.
    for (const row of this.db.query<JobRow, []>("SELECT * FROM team_jobs WHERE status='proposed' ORDER BY seq").all()) if (matches(jobOf(row), select)) this.finish(row.id, "stopped", "Declined by you.");
  }
  /** A task an agent proposed, approved by you: it waits its turn like one you gave, in a chain of its own. `own`: the
   * primary's own yes (TeamService.approveOwn), so its budget is kept as what it committed (team_own). */
  approve(task: string, own = false): TeamTask {
    return this.db.transaction(() => {
      const row = this.jobRow(task);
      if (!row || row.kind !== "task") throw new TeamError(404, "No such team task.");
      if (row.status !== "proposed") throw new TeamError(409, "That task isn't waiting for your approval.");
      if (!this.agent(row.agent)) throw new TeamError(410, "That task's agent was removed. Give the work to another agent.");
      this.db.query("UPDATE team_jobs SET status='queued',chain_id=?,updated_at=? WHERE id=? AND status='proposed'").run(this.chain(this.requireRoom(row.room)), this.now(), row.id);
      if (own) this.db.query("INSERT INTO team_own(task,usd,at) VALUES(?,?,?)").run(row.id, (JSON.parse(row.data) as { budgetUsd?: number }).budgetUsd ?? 0, this.now());
      return this.task(row.id)!;
    })();
  }
  /** Your resume makes interrupted or stopped work runnable again (the one other way: a planned restart's own work, once,
   * by itself: resumeRestarted). Another node's hand-off is taken up again only when you name it by its id: its call
   * has ended, so it would run with nobody following it. */
  resume(select: TeamSelection): void {
    this.db.transaction(() => {
      const handed = (r: JobRow) => r.kind === "task" && String((JSON.parse(r.data) as { givenBy?: unknown }).givenBy ?? "").startsWith("node:");
      const found = this.db.query<JobRow, []>("SELECT * FROM team_jobs WHERE status IN ('interrupted','stopped','failed') ORDER BY seq").all().filter((r) => matches(jobOf(r), select) && (select.task || (r.status === "interrupted" && !handed(r))));
      // What a removed worker left unfinished is never started again: asked for by name it says so, otherwise it is passed over.
      const rows = found.filter((r) => this.agent(r.agent));
      if (select.task && found.length && !rows.length) throw new TeamError(410, "That task's agent was removed. Revise the task for another agent.");
      if (this.pending() + rows.length > TEAM_LIMITS.pending) throw new TeamError(429, "Too much work to resume at once.");
      const chains = new Map<string, string>();
      for (const row of rows) {
        let chain = chains.get(row.room);
        if (!chain) { chain = this.chain(this.requireRoom(row.room)); chains.set(row.room, chain); }
        const data = untaken(JSON.parse(row.data));
        if (data.rest) data.rest = { count: data.rest.count };
        this.db.query("UPDATE team_jobs SET status='queued',error=NULL,chain_id=?,data=?,updated_at=? WHERE id=?").run(chain, JSON.stringify(data), this.now(), row.id);
      }
    })();
  }
}
