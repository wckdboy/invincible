import { Database } from "bun:sqlite";
import { chmodSync, closeSync, existsSync, openSync } from "node:fs";
import { AttachmentRef, findSecrets, randomId, readAlike, redact } from "@galahad/core";
import { defaultAvatar, isOrbProfile, resolveAvatar, type AvatarActivity } from "@galahad/core/avatar";
import { z } from "zod";
import {
  TEAM_GALAHAD, TEAM_LIMITS, TEAM_OWNER, TeammateInput, TeamRecruitInput, TeamRoomInput, TeamPostInput, TeamSayInput, TeamTaskChanges, TeamTaskInput, TeamTaskRecord, type TeamTrailEntry, TeamWorkspace,
  type Teammate, type TeamRoom, type TeamMessage, type TeamTask, type TeamDelivery, type TeamSnapshot, type TeamRoomView, type TeamWorkStatus, type TeamOverview,
  TeamOutcomeInput, type TeamOutcomeStatus, type TeamTaskFix, type TeamTaskShipped, type TeamCheckpoint, heldModels, SENSITIVE_WORK,
} from "../../core/src/team.ts";
import { type InterventionKind, type NorthStar, northStar } from "../../core/src/interventions.ts";

/** An outcome as the store keeps it (outcomes.ts adds what it has cost, at your prices, for its view). */
export interface StoredOutcome {
  id: string;
  room: string;
  title: string;
  goal: string;
  done: string | null;
  knights: string[];
  budgetUsd: number;
  /** What his own looks at it have cost (its tasks' costs are read from their records). */
  leadUsd: number;
  status: TeamOutcomeStatus;
  notes: string;
  reportHour: number;
  tz: string;
  lastLookAt: number | null;
  lastReportAt: number | null;
  ended: string | null;
  /** What his looks have taken in: the tasks of it whose end he has seen, and the last message of yours he read. */
  seen: { tasks: string[]; message: string | null };
  createdAt: number;
  updatedAt: number;
}

export class TeamError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

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
interface JobRow { id: string; kind: "delivery" | "task"; room: string; teammate: string; chain_id: string; status: TeamWorkStatus; data: string; error: string | null; created_at: number; updated_at: number }
interface AnswerRow { id: string; room: string; chain_id: string; trigger: string; asker: string; status: TeamWorkStatus; error: string | null; reply: string | null; created_at: number; updated_at: number }
export interface TeamJob { id: string; kind: "delivery" | "task"; room: string; teammate: string; chainId: string; status: TeamWorkStatus; createdAt: number }
export interface TeamSelection { room?: string; teammate?: string; task?: string }
/** Who asked Galahad to answer in a room: you, from the device you wrote on (as it stands when he answers), or a knight,
 * whose words give him no hands. */
export type TeamAsker = { kind: "admin" } | { kind: "client"; device: string } | { kind: "knight"; teammate: string };
/** Galahad's answer to a room: one waits per room, for its newest words. */
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
const jobOf = (r: JobRow): TeamJob => ({ id: r.id, kind: r.kind, room: r.room, teammate: r.teammate, chainId: r.chain_id, status: r.status, createdAt: r.created_at });
const answerOf = (r: AnswerRow): TeamAnswer => ({ id: r.id, room: r.room, chainId: r.chain_id, trigger: r.trigger, asker: JSON.parse(r.asker) as TeamAsker, status: r.status, error: r.error, createdAt: r.created_at, updatedAt: r.updated_at });
/** His seat in every room, for the mentions that call him. */
const GALAHAD_SEAT = [{ id: TEAM_GALAHAD, name: "Galahad" }] as const;
const id = (prefix: string): string => `${prefix}-${randomId(9).toLowerCase()}`;
/**
 * The knights a message names with @: by handle, by name, or by the first word of its name (case aside), each once and
 * in the room's order. An @ inside a word (an address) names nobody.
 */
export function mentioned(text: string, members: readonly Pick<Teammate, "id" | "name">[]): string[] {
  const said = new Set([...text.normalize("NFKC").matchAll(/(?<![\p{L}\p{N}_.@])@([\p{L}\p{N}][\p{L}\p{N}_-]*)/gu)].map((match) => match[1]!.toLowerCase()));
  if (!said.size) return [];
  const call = (name: string) => name.normalize("NFKC").toLowerCase();
  return members.filter((member) => said.has(member.id) || said.has(call(member.name).replace(/\s+/g, "")) || said.has(call(member.name).split(/\s+/)[0] ?? "")).map((member) => member.id);
}

/** A new worker's daily allowance, whoever makes it: yours to change. */
const DAILY_TURNS = 40;
const DAY = 24 * 3_600_000;
/** What Galahad is told of a room when he asks: its latest messages, each clipped; and of a worker's job, its start. */
const OVERVIEW = { messages: 20, message: 1200, job: 300 } as const;
const clipped = (text: string, max: number): string => (text.length > max ? `${text.slice(0, max)}… (${text.length - max} more characters)` : text);
/** Why work stopped when its worker is gone, and why a direct conversation with a removed worker takes nothing new. */
const REMOVED = "Its knight was removed.";
const CLOSED = "This conversation is kept to read: its knight was removed.";
const matches = (job: TeamJob, select: TeamSelection) => (!select.room || job.room === select.room) && (!select.teammate || job.teammate === select.teammate) && (!select.task || job.id === select.task);

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
      CREATE TABLE IF NOT EXISTS team_teammates (id TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS team_rooms (id TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS team_chains (id TEXT PRIMARY KEY, budget INTEGER NOT NULL, spent INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS team_usage (teammate TEXT NOT NULL, day TEXT NOT NULL, turns INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(teammate, day));
      CREATE TABLE IF NOT EXISTS team_messages (
        seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, room TEXT NOT NULL REFERENCES team_rooms(id),
        speaker TEXT NOT NULL, speaker_name TEXT NOT NULL, text TEXT NOT NULL, created_at INTEGER NOT NULL, chain_id TEXT NOT NULL REFERENCES team_chains(id));
      CREATE INDEX IF NOT EXISTS team_messages_room ON team_messages(room, seq);
      CREATE INDEX IF NOT EXISTS team_messages_speaker ON team_messages(speaker, created_at);
      CREATE TABLE IF NOT EXISTS team_jobs (
        seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, kind TEXT NOT NULL, room TEXT NOT NULL REFERENCES team_rooms(id),
        teammate TEXT NOT NULL REFERENCES team_teammates(id), chain_id TEXT NOT NULL REFERENCES team_chains(id), status TEXT NOT NULL,
        data TEXT NOT NULL, error TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS team_jobs_queue ON team_jobs(status, seq);
      CREATE INDEX IF NOT EXISTS team_jobs_teammate ON team_jobs(teammate, status);
      CREATE INDEX IF NOT EXISTS team_jobs_activity ON team_jobs(updated_at, teammate, kind, status);
      CREATE TABLE IF NOT EXISTS team_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
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
    // A database from before files at the Roundtable: a message of yours may carry some (kept on the node: uploads.ts).
    const fields = new Set(this.db.query<{ name: string }, []>("PRAGMA table_info(team_messages)").all().map((c) => c.name));
    if (!fields.has("attachments")) this.db.exec("ALTER TABLE team_messages ADD COLUMN attachments TEXT");
    // When you last looked at each knight's page and each room (`knight:<id>`, `room:<id>`): what ended there after it
    // is new to you. A database from before it counts everything until now as seen.
    const seenBefore = this.db.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'team_seen'").get();
    this.db.exec("CREATE TABLE IF NOT EXISTS team_seen (key TEXT PRIMARY KEY, at INTEGER NOT NULL)");
    if (!seenBefore) {
      const at = this.now();
      const add = this.db.query("INSERT OR IGNORE INTO team_seen (key, at) VALUES (?, ?)");
      for (const { id } of this.db.query<{ id: string }, []>("SELECT id FROM team_teammates").all()) add.run(`knight:${id}`, at);
      for (const { id } of this.db.query<{ id: string }, []>("SELECT id FROM team_rooms").all()) add.run(`room:${id}`, at);
    }
  }

  close(): void { this.db.close(); }
  private day(): string { return new Date(this.now()).toISOString().slice(0, 10); }
  private turns(teammate: string): number { return this.db.query<{ turns: number }, [string, string]>("SELECT turns FROM team_usage WHERE teammate = ? AND day = ?").get(teammate, this.day())?.turns ?? 0; }
  /** Galahad's own computer: his persistent VM, bound as a knight's workspace is (null: he has none yet). */
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
  /** The VMs' notes store (Engram) for this node's knights: on unless you turned it off, and kept across restarts. */
  engram(): boolean { return this.db.query<DocRow, []>("SELECT value FROM team_settings WHERE key='engram'").get()?.value !== "off"; }
  setEngram(raw: boolean): boolean {
    const on = teamInput(z.boolean(), raw);
    this.db.query("INSERT INTO team_settings(key,value) VALUES('engram',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(on ? "on" : "off");
    return on;
  }
  /** Whether Galahad offers idle knights work from your backlog (backlog.ts): on until you turn it off. */
  backlog(): boolean { return this.db.query<DocRow, []>("SELECT value FROM team_settings WHERE key='backlog'").get()?.value !== "off"; }
  setBacklog(raw: boolean): boolean {
    const on = teamInput(z.boolean(), raw);
    this.db.query("INSERT INTO team_settings(key,value) VALUES('backlog',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(on ? "on" : "off");
    return on;
  }
  /** When a knight was last looked at for work from your backlog (0: never), kept so a restart doesn't look again. */
  backlogLooked(knight: string): number { return Number(this.db.query<DocRow, [string]>("SELECT value FROM team_settings WHERE key=?").get(`backlog:${knight}`)?.value ?? 0); }
  setBacklogLooked(knight: string, at: number): void {
    this.db.query("INSERT INTO team_settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(`backlog:${knight}`, String(at));
  }
  /** Whether failing checks go back to the knight whose work it was when no outcome gives them back (PLAN #29): off until you turn it on. */
  ciBack(): boolean { return this.db.query<DocRow, []>("SELECT value FROM team_settings WHERE key='ci'").get()?.value === "on"; }
  setCiBack(raw: boolean): boolean {
    const on = teamInput(z.boolean(), raw);
    this.db.query("INSERT INTO team_settings(key,value) VALUES('ci',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(on ? "on" : "off");
    return on;
  }
  /** A room's story so far: what its knights summed up of the conversation before `through` (a message's id), so a
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
  private record(id: string): Teammate | null {
    const row = this.db.query<DocRow, [string]>("SELECT value FROM team_teammates WHERE id = ?").get(id);
    if (!row) return null;
    const value = JSON.parse(row.value) as Teammate;
    return { ...value, avatar: isOrbProfile(value.avatar) ? value.avatar : resolveAvatar(id, value.avatar), repository: value.repository ?? null, workspaceNode: value.workspaceNode ?? value.workspace?.node ?? null, createdBy: value.createdBy ?? TEAM_OWNER, instructionsBy: value.instructionsBy ?? TEAM_OWNER, turnsToday: this.turns(id) };
  }
  private records(): Teammate[] { return this.db.query<{ id: string }, []>("SELECT id FROM team_teammates ORDER BY id").all().map((r) => this.record(r.id)!); }
  /** A worker that is here. One that was removed is nobody's to work with, write to or change (null), though its record is kept. */
  teammate(id: string): Teammate | null {
    const kept = this.record(id);
    return kept && kept.removedAt === undefined ? kept : null;
  }
  /** Your knights in the order you gave them; one you didn't place comes after, by handle. */
  teammates(): Teammate[] {
    const here = this.records().filter((t) => t.removedAt === undefined);
    const order = this.arrangement().order;
    const at = (id: string) => { const i = order.indexOf(id); return i < 0 ? order.length : i; };
    return here.sort((a, b) => at(a.id) - at(b.id) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  }
  /** Your order of the knights (only those still here), and who leads the Roundtable: Galahad (`galahad`) unless you chose a knight. */
  arrangement(): { order: string[]; primary: string } {
    const here = new Set(this.records().filter((t) => t.removedAt === undefined).map((t) => t.id));
    const setting = (key: string) => this.db.query<DocRow, [string]>("SELECT value FROM team_settings WHERE key=?").get(key)?.value;
    const order = ((): string[] => { try { const parsed = JSON.parse(setting("order") ?? "[]"); return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === "string" && here.has(id)) : []; } catch { return []; } })();
    const primary = setting("primary");
    return { order, primary: primary && here.has(primary) ? primary : TEAM_GALAHAD };
  }
  /** Yours alone (the route says so): the knights' order, and who leads. Every name must be a knight of yours (or, to lead, Galahad). */
  arrange(input: { order?: string[]; primary?: string }): { order: string[]; primary: string } {
    const here = new Set(this.teammates().map((t) => t.id));
    if (input.order) {
      const unknown = input.order.filter((id) => !here.has(id));
      if (unknown.length) throw new TeamError(400, `No knight of yours is ${unknown.map((id) => `"${id}"`).join(", ")}.`);
      if (new Set(input.order).size !== input.order.length) throw new TeamError(400, "Each knight is in the order once.");
    }
    if (input.primary !== undefined && input.primary !== TEAM_GALAHAD && !here.has(input.primary)) throw new TeamError(400, `No knight of yours is "${input.primary}": the Roundtable is led by Galahad or one of your knights.`);
    const put = (key: string, value: string) => this.db.query("INSERT INTO team_settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(key, value);
    if (input.order) put("order", JSON.stringify(input.order));
    if (input.primary !== undefined) put("primary", input.primary);
    return this.arrangement();
  }
  /** The workers you removed. Their handles stay taken and their names stay beside what they said. */
  removed(): Teammate[] { return this.records().filter((t) => t.removedAt !== undefined); }
  private putTeammate(value: Teammate): Teammate {
    this.db.query("INSERT INTO team_teammates(id,value) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value").run(value.id, JSON.stringify(value));
    return this.teammate(value.id)!;
  }
  saveTeammate(raw: TeammateInput): Teammate {
    const input = teamInput(TeammateInput, raw);
    // (Its ACP agent's command too: a key named on a command line would be kept here, in the clear.)
    teamText([input.name, input.instructions, input.role, input.repository, input.acp].filter(Boolean).join("\n"));
    if (this.record(input.id)?.removedAt !== undefined) throw new TeamError(409, "That handle belonged to a knight that was removed. Its history stays its own: choose another handle.");
    const previous = this.teammate(input.id);
    // A VM's repository is not changed or taken away under the work that is in it. One that has none may be given its first: nothing there to orphan.
    if (previous?.workspace && previous.repository && input.repository !== undefined && input.repository !== previous.repository) throw new TeamError(409, "This knight's workspace is already bound to its repository. Keep that repository to preserve its work.");
    if (!previous && this.teammates().length >= TEAM_LIMITS.teammates) throw new TeamError(409, `At most ${TEAM_LIMITS.teammates} knights can live on this node.`);
    const at = this.now();
    // This is your own way in: instructions you change here are yours from then on, whoever wrote the ones before.
    // (Saved as they were, with something else about the worker, they stay whose they were: the app sends them every time.)
    // (Its own models: omitted, kept; null or none, its role's again.)
    const models = input.models === undefined ? previous?.models : input.models?.length ? input.models : undefined;
    // Sensitive mode holds it to models of its own: never on without them, and never let go of by taking them away.
    const sensitive = input.sensitive ?? previous?.sensitive ?? false;
    if (sensitive && !models?.length) throw new TeamError(400, previous?.sensitive && input.sensitive === undefined ? `${previous.name} is in sensitive mode, held to its own models: choose others, or turn sensitive mode off first.` : "Sensitive mode holds a knight to models of its own: choose them first.");
    // An ACP agent of yours (harness acp) is started by the command you named: kept until you name another or none.
    const harness = input.harness ?? previous?.harness ?? "native";
    const acp = input.acp === undefined ? previous?.acp : input.acp ?? undefined;
    // Keys of yours it may use but never see (PLAN #17): omitted, kept; null or none, none. That each is a key it can be
    // given (in the vault, pinned to an address, no provider's or connector's) is the node's to check (server.ts).
    const keys = input.keys === undefined ? previous?.keys : input.keys?.length ? input.keys : undefined;
    if (harness === "acp" && !acp) throw new TeamError(400, "Name the command that starts its ACP agent in its VM, e.g. goose acp or gemini --acp.");
    // (It calls the models you set it up with, which sensitive mode can't hold it to.)
    if (harness === "acp" && sensitive) throw new TeamError(400, "A knight in sensitive mode works on Galahad's own harness, OpenCode, Hermes, Claude Code or Codex: an ACP agent of yours calls the models you set it up with, which Galahad can't hold it to.");
    return this.putTeammate({ id: input.id, name: input.name, instructions: input.instructions ?? previous?.instructions ?? "", role: input.role ?? previous?.role ?? "engineer", ...(models ? { models } : {}), ...(sensitive ? { sensitive: true } : {}), harness, ...(acp ? { acp } : {}), ...(keys ? { keys } : {}), enabled: input.enabled ?? previous?.enabled ?? true, dailyTurns: input.dailyTurns ?? previous?.dailyTurns ?? DAILY_TURNS, repository: input.repository === undefined ? previous?.repository ?? null : input.repository, turnsToday: this.turns(input.id), workspaceNode: previous?.workspaceNode ?? null, workspace: previous?.workspace ?? null, memory: previous?.memory ?? "", avatar: input.avatar === undefined ? previous?.avatar ?? defaultAvatar(input.id) : input.avatar ?? defaultAvatar(input.id), createdBy: previous?.createdBy ?? TEAM_OWNER, instructionsBy: input.instructions === undefined || input.instructions === previous?.instructions ? previous?.instructionsBy ?? TEAM_OWNER : TEAM_OWNER, createdAt: previous?.createdAt ?? at, updatedAt: at });
  }
  /** How many more workers Galahad may make for himself: on this node in all, and in the day now ending. */
  private spare(all: Teammate[] = this.teammates()): TeamOverview["spare"] {
    const since = this.now() - DAY;
    // One you removed still counts as made today: removing a worker gives him no more to make. It no longer takes a place on the node.
    const today = [...all, ...this.removed()].filter((t) => t.createdBy !== TEAM_OWNER && t.createdAt > since).length;
    return { workers: Math.max(0, TEAM_LIMITS.teammates - all.length), today: Math.max(0, TEAM_LIMITS.recruitsPerDay - today) };
  }
  /**
   * A worker Galahad makes for himself (`by`: TEAM_GALAHAD, or the worker that asked for it): only ever a new one,
   * with the defaults that stay yours to change, its job marked as his words and never yours, and within his
   * allowance for the day. `room`: its maker's room, which it joins at once unless that is a direct conversation.
   */
  recruit(raw: TeamRecruitInput, by: string, room?: string): Teammate {
    const input = teamInput(TeamRecruitInput, raw);
    teamText([input.name, input.instructions, input.role].filter(Boolean).join("\n"));
    return this.db.transaction(() => {
      if (by !== TEAM_GALAHAD) this.requireTeammate(by);
      const taken = this.record(input.id);
      if (taken?.removedAt !== undefined) throw new TeamError(409, `The handle ${input.id} belonged to a knight that was removed. Its history stays its own: choose another handle.`);
      if (taken) throw new TeamError(409, `A knight with the handle ${input.id} already exists. Work with them, or choose another handle.`);
      // A name a model chose must not be taken for another worker's, however it is spelled: one that was removed too, whose name is still beside what it said.
      const twin = this.records().find((other) => readAlike(other.name, input.name));
      if (twin) throw new TeamError(409, `The name ${input.name} reads like ${twin.name}'s (${twin.id}). Choose a name nobody could take for another knight's.`);
      const spare = this.spare();
      if (!spare.workers) throw new TeamError(409, `At most ${TEAM_LIMITS.teammates} knights can live on this node.`);
      if (!spare.today) throw new TeamError(429, `Galahad has made ${TEAM_LIMITS.recruitsPerDay} knights in the last day, which is his allowance. The owner can add more at the Roundtable.`);
      const joined = room ? this.requireRoom(room) : null;
      // A worker brings one only into a room of its own.
      if (joined && by !== TEAM_GALAHAD) this.roomMember(joined, by);
      const at = this.now();
      // One a knight in sensitive mode makes is in it too, on the same models: what it starts never runs elsewhere.
      const held = by === TEAM_GALAHAD ? null : heldModels(this.requireTeammate(by));
      const made = this.putTeammate({ id: input.id, name: input.name, instructions: input.instructions, role: input.role ?? "engineer", ...(held ? { models: [...held], sensitive: true } : {}), harness: "native", enabled: true, dailyTurns: DAILY_TURNS, repository: null, turnsToday: 0, workspaceNode: null, workspace: null, memory: "", avatar: defaultAvatar(input.id), createdBy: by, instructionsBy: by, createdAt: at, updatedAt: at });
      if (joined && !joined.direct) this.putRoom({ ...joined, members: [...joined.members, made.id], updatedAt: at });
      return made;
    })();
  }
  planWorkspace(teammate: string, raw: string): Teammate {
    const current = this.requireTeammate(teammate);
    const node = teamInput(z.string().min(1).max(200), raw);
    teamText(node);
    if (current.workspaceNode && current.workspaceNode !== node) throw new TeamError(409, "This knight's workspace is already assigned to another host.");
    return this.putTeammate({ ...current, workspaceNode: node, updatedAt: this.now() });
  }
  setWorkspace(teammate: string, raw: TeamWorkspace | null): Teammate {
    const current = this.requireTeammate(teammate);
    const workspace = raw === null ? null : teamInput(TeamWorkspace, raw);
    if (workspace) teamText(workspace.node);
    if (workspace && current.workspace && (current.workspace.node !== workspace.node || current.workspace.id !== workspace.id)) throw new TeamError(409, "This knight already has a workspace. Recover that workspace rather than replacing its work.");
    if (workspace && current.workspaceNode && current.workspaceNode !== workspace.node) throw new TeamError(409, "This knight's workspace is already assigned to another host.");
    if (workspace && this.teammates().some((t) => t.id !== teammate && t.workspace?.node === workspace.node && t.workspace?.id === workspace.id)) throw new TeamError(409, "That workspace belongs to another knight.");
    return this.putTeammate({ ...current, workspace, workspaceNode: workspace?.node ?? current.workspaceNode, updatedAt: this.now() });
  }
  remember(teammate: string, raw: string): Teammate {
    const memory = teamInput(z.string().max(TEAM_LIMITS.memory), raw);
    teamText(memory);
    return this.putTeammate({ ...this.requireTeammate(teammate), memory, updatedAt: this.now() });
  }
  requireTeammate(id: string): Teammate {
    const teammate = this.record(id);
    if (!teammate) throw new TeamError(404, "No such knight.");
    if (teammate.removedAt !== undefined) throw new TeamError(410, "That knight was removed.");
    return teammate;
  }
  /**
   * Retire a worker for good. Nothing of it is erased: its record is kept (so its handle is never anyone else's and
   * nothing new inherits its history), its words stay where it said them, and its direct conversations stay to read.
   * It leaves every shared room, and what it had not started is stopped. A bound workspace and running work are
   * the caller's to deal with first: neither is ever left behind.
   */
  remove(id: string): Teammate {
    return this.db.transaction(() => {
      const current = this.requireTeammate(id);
      if (current.workspace) throw new TeamError(409, "This knight still has a workspace. Destroy it with the knight, or keep the knight paused instead.");
      if (this.db.query("SELECT id FROM team_jobs WHERE teammate=? AND status='running'").get(id)) throw new TeamError(409, "Stop this knight's work before removing it.");
      const at = this.now();
      // Its direct conversations are closed with it: what its peers had still to say there is stopped too.
      const closing = new Set(this.rooms().filter((room) => room.direct && room.members.includes(id)).map((room) => room.id));
      for (const job of this.queued()) {
        if (job.teammate === id) this.finish(job.id, "stopped", REMOVED);
        else if (closing.has(job.room)) this.finish(job.id, "stopped", CLOSED);
      }
      for (const room of this.rooms()) if (!room.direct && room.members.includes(id)) this.putRoom({ ...room, members: room.members.filter((member) => member !== id), updatedAt: at });
      this.db.query("UPDATE team_teammates SET value=? WHERE id=?").run(JSON.stringify({ ...current, enabled: false, removedAt: at, updatedAt: at }), id);
      return this.record(id)!;
    })();
  }
  room(id: string): TeamRoom | null {
    const row = this.db.query<DocRow, [string]>("SELECT value FROM team_rooms WHERE id = ?").get(id);
    return row ? JSON.parse(row.value) as TeamRoom : null;
  }
  rooms(): TeamRoom[] { return this.db.query<DocRow, []>("SELECT value FROM team_rooms ORDER BY id").all().map((r) => JSON.parse(r.value) as TeamRoom); }

  /* ---------- outcomes he owns (PLAN #43; outcomes.ts runs them) ---------- */

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
  /** A new outcome, with a room of its own (its id the outcome's) holding the knights you named for it. */
  createOutcome(raw: TeamOutcomeInput): StoredOutcome {
    const input = teamInput(TeamOutcomeInput, raw);
    teamText([input.title, input.goal, input.done ?? ""].join("\n"));
    return this.db.transaction(() => {
      for (const knight of input.knights) this.requireTeammate(knight);
      const key = id("out");
      if (this.rooms().length >= TEAM_LIMITS.rooms) throw new TeamError(409, `At most ${TEAM_LIMITS.rooms} team rooms can live on this node.`);
      const at = this.now();
      this.putRoom({ id: key, name: input.title, members: input.knights, direct: false, turnBudget: 8, paused: false, createdAt: at, updatedAt: at });
      return this.putOutcome({ id: key, room: key, title: input.title, goal: input.goal, done: input.done ?? null, knights: input.knights, budgetUsd: input.budgetUsd, leadUsd: 0, status: "active", notes: "", reportHour: input.reportHour ?? 9, tz: input.tz ?? "UTC", lastLookAt: null, lastReportAt: null, ended: null, seen: { tasks: [], message: null }, createdAt: at, updatedAt: at });
    })();
  }
  /** A direct conversation with a worker that was removed: kept to read (by its id), and taking no new words or work. */
  private closed(room: TeamRoom): boolean { return room.direct && room.members.some((member) => !this.teammate(member)); }
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
    for (const member of input.members) this.requireTeammate(member);
    const previous = input.id ? this.room(input.id) : null;
    const direct = input.direct ?? previous?.direct ?? false;
    if (direct && input.members.length > 2) throw new TeamError(400, "A direct conversation has one or two knights.");
    if (previous?.direct && (direct !== true || [...previous.members].sort().join() !== [...input.members].sort().join())) throw new TeamError(409, "The people in a direct conversation cannot be changed.");
    if (!previous && this.rooms().length >= TEAM_LIMITS.rooms) throw new TeamError(409, `At most ${TEAM_LIMITS.rooms} team rooms can live on this node.`);
    const at = this.now();
    const saved = this.putRoom({ id: input.id ?? id("room"), name: input.name, members: input.members, direct, turnBudget: input.turnBudget ?? previous?.turnBudget ?? 8, paused: previous?.paused ?? false, createdAt: previous?.createdAt ?? at, updatedAt: at });
    // Membership is checked again when work starts; removed participants never see new history.
    return saved;
  }
  direct(teammate: string, from?: string): TeamRoom {
    const target = this.requireTeammate(teammate);
    if (from) this.requireTeammate(from);
    if (from === teammate) throw new TeamError(400, "A knight cannot send a direct message to itself.");
    const members = from ? [from, teammate].sort() : [teammate];
    const existing = this.rooms().find((r) => r.direct && [...r.members].sort().join() === members.join());
    return existing ?? this.saveRoom({ name: from ? `${this.requireTeammate(from).name} & ${target.name}`.slice(0, 100) : target.name, members, direct: true });
  }
  private chain(room: TeamRoom): string {
    const chain = id("chain");
    this.db.query("INSERT INTO team_chains(id,budget) VALUES(?,?)").run(chain, room.turnBudget);
    return chain;
  }
  /** Work in sight: running, waiting its turn, or proposed and waiting for you. All of it is bounded together. */
  private pending(): number { return this.db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM team_jobs WHERE status IN ('proposed','queued','running')").get()!.n; }
  private roomMember(room: TeamRoom, teammate: string): void {
    this.requireTeammate(teammate);
    if (!room.members.includes(teammate)) throw new TeamError(403, "That knight is not a member of this room.");
  }
  /** Owner posts start a bounded chain, and so do Galahad's own from your conversation (`galahad`), within his
   * allowance for the day. Brokered posts keep their originating chain across rooms, and so does his answer in a room
   * (`reply`): that was asked for, so it is no part of his allowance. `asker`: the device you wrote on. */
  post(raw: TeamPostInput, by: { teammate?: string; chainId?: string; output?: boolean; galahad?: boolean; reply?: boolean; quiet?: boolean; asker?: Exclude<TeamAsker, { kind: "knight" }> } = {}): TeamMessage {
    const input = teamInput(TeamPostInput, raw);
    if (!by.output) teamText(input.text);
    // Files are yours alone to bring: a knight's or Galahad's words carry none.
    if (input.attachments && (by.teammate || by.galahad || by.output)) throw new TeamError(403, "Only you bring files to the Roundtable.");
    return this.db.transaction(() => {
      const room = this.requireRoom(input.room);
      if (by.reply ? !by.galahad || by.teammate || !by.chainId : by.galahad && (by.teammate || by.chainId)) throw new TeamError(400, "Galahad speaks for himself, in a conversation of his own.");
      if (by.galahad && !by.reply && this.saidToday() >= TEAM_LIMITS.saysPerDay) {
        throw new TeamError(429, `Galahad has sent ${TEAM_LIMITS.saysPerDay} messages to the Roundtable in the last day, which is his allowance. The owner can message the knights at the Roundtable.`);
      }
      if (by.teammate) this.roomMember(room, by.teammate);
      // (Only a direct conversation can still name a worker that was removed: it is kept to read, and takes no new words.)
      for (const member of room.members) this.requireTeammate(member);
      if (by.teammate && !by.chainId) throw new TeamError(403, "A knight message must belong to its current conversation.");
      if (by.chainId && !this.db.query("SELECT id FROM team_chains WHERE id = ?").get(by.chainId)) throw new TeamError(404, "No such conversation chain.");
      let named = mentioned(input.text, room.members.map((member) => this.requireTeammate(member)));
      // What you say to a room of knights without naming one is the lead's: the knight you made primary when it sits
      // here (it alone hears it), Galahad otherwise.
      const primary = this.arrangement().primary;
      const unnamed = !by.galahad && !by.teammate && !by.reply && !room.direct && !named.length;
      if (unnamed && primary !== TEAM_GALAHAD && room.members.includes(primary)) named = [primary];
      // Galahad hears what names him, and what you say to a room of knights without naming one when he leads it: he answers
      // it, or names who should take it up. In a knight's own conversation with you, your words stay the knight's unless you name him.
      const forGalahad = !by.galahad && (mentioned(input.text, GALAHAD_SEAT).length > 0 || (unnamed && !named.length));
      // Those it names with @ (by handle or name) hear it. One that names nobody here reaches everyone, unless it was his
      // to answer, or is his answer: that was for whoever asked.
      const recipients = by.quiet ? [] : (named.length || forGalahad || by.reply ? named : room.members).filter((member) => member !== by.teammate);
      if (this.pending() + recipients.length > TEAM_LIMITS.pending) throw new TeamError(429, "The team queue is full. Let some work finish first.");
      // His own words never fill it: half is always left for yours, however much of his waits in held rooms.
      if (by.galahad && this.pending() + recipients.length > TEAM_LIMITS.pending / 2) throw new TeamError(429, "Half the team queue is waiting work already. Let some of it finish before writing to them again.");
      const chainId = by.chainId ?? this.chain(room);
      const at = this.now();
      const message: TeamMessage = { id: id("message"), room: room.id, speaker: by.teammate ?? (by.galahad ? TEAM_GALAHAD : TEAM_OWNER), speakerName: by.teammate ? this.requireTeammate(by.teammate).name : by.galahad ? "Galahad" : "You", text: by.output ? teamOutput(input.text, TEAM_LIMITS.message) : input.text, createdAt: at, chainId };
      if (input.attachments) message.attachments = input.attachments;
      this.db.query("INSERT INTO team_messages(id,room,speaker,speaker_name,text,created_at,chain_id,attachments) VALUES(?,?,?,?,?,?,?,?)").run(message.id, message.room, message.speaker, message.speakerName, message.text, at, chainId, input.attachments ? JSON.stringify(input.attachments) : null);
      for (const member of recipients) this.insertJob("delivery", room.id, member, chainId, { trigger: message.id });
      if (forGalahad) this.queueAnswer(room.id, message, by.teammate ? { kind: "knight", teammate: by.teammate } : (by.asker ?? { kind: "admin" }));
      this.putRoom({ ...room, updatedAt: at });
      return message;
    })();
  }
  /** What Galahad said to the Roundtable in the last day from his own conversation: his allowance. His answers in rooms were asked for. */
  /** Every file a kept message carries: what uploads.ts keeps whatever its age (rooms keep their words). */
  attachmentIds(): Set<string> {
    const ids = new Set<string>();
    for (const row of this.db.query<{ attachments: string }, []>("SELECT attachments FROM team_messages WHERE attachments IS NOT NULL").all()) {
      for (const a of attachmentsOf(row.attachments)) ids.add(a.id);
    }
    return ids;
  }
  private saidToday(): number {
    return this.db.query<{ n: number }, [string, number]>("SELECT COUNT(*) AS n FROM team_messages m WHERE m.speaker = ? AND m.created_at > ? AND NOT EXISTS (SELECT 1 FROM team_answers a WHERE a.reply = m.id)").get(TEAM_GALAHAD, this.now() - DAY)!.n;
  }
  /** One answer of his waits per room, for its newest words, in their conversation; if you asked as well as a knight, it is yours. */
  private queueAnswer(room: string, message: TeamMessage, asker: TeamAsker): void {
    const at = this.now();
    const waiting = this.db.query<AnswerRow, [string]>("SELECT * FROM team_answers WHERE room=? AND status='queued'").get(room);
    if (!waiting) {
      this.db.query("INSERT INTO team_answers(id,room,chain_id,trigger,asker,status,created_at,updated_at) VALUES(?,?,?,?,?,'queued',?,?)").run(id("answer"), room, message.chainId, message.id, JSON.stringify(asker), at, at);
      return;
    }
    const before = JSON.parse(waiting.asker) as TeamAsker;
    this.db.query("UPDATE team_answers SET chain_id=?,trigger=?,asker=?,updated_at=? WHERE id=?").run(message.chainId, message.id, JSON.stringify(before.kind === "knight" ? asker : before), at, waiting.id);
  }
  private answerRow(key: string): AnswerRow | null { return this.db.query<AnswerRow, [string]>("SELECT * FROM team_answers WHERE id=?").get(key); }
  answer(key: string): TeamAnswer | null { const row = this.answerRow(key); return row ? answerOf(row) : null; }
  /** His answers waiting their turn, oldest first. */
  queuedAnswers(): TeamAnswer[] { return this.db.query<AnswerRow, []>("SELECT * FROM team_answers WHERE status='queued' ORDER BY seq").all().map(answerOf); }
  /** His turn to answer: the room open and not paused, no answer of his already under way in it, and the conversation's
   * budget not spent (his turn spends it as a knight's does). */
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
  /** His answer, posted in its room and its record closed together. It reaches only the knights it names; empty: he had
   * nothing to add. With `error` it failed, and the text says so. */
  answered(key: string, text: string, error: string | null = null): TeamMessage | null {
    return this.db.transaction(() => {
      const row = this.answerRow(key);
      if (!row || row.status !== "running") throw new TeamError(409, "This answer has stopped.");
      const message = text ? this.post({ room: row.room, text }, { galahad: true, reply: true, chainId: row.chain_id, output: true }) : null;
      this.db.query("UPDATE team_answers SET status=?,error=?,reply=?,updated_at=? WHERE id=?").run(error ? "failed" : "done", error ? teamOutput(error, 2000) : null, message?.id ?? null, this.now(), key);
      return message;
    })();
  }
  finishAnswer(key: string, status: "stopped" | "interrupted" | "failed", error: string): void {
    this.db.query("UPDATE team_answers SET status=?,error=?,updated_at=? WHERE id=? AND status IN ('queued','running')").run(status, teamOutput(error, 2000), this.now(), key);
  }
  /** His answers as a room's deliveries are shown: what is under way, then the latest that ended. */
  private galahadAnswers(room?: string): TeamDelivery[] {
    const rows = room
      ? this.db.query<AnswerRow, [string]>("SELECT * FROM team_answers WHERE room=? ORDER BY status IN ('queued','running') DESC,seq DESC LIMIT 16").all(room)
      : this.db.query<AnswerRow, []>("SELECT * FROM team_answers WHERE status IN ('queued','running') ORDER BY seq DESC LIMIT 128").all();
    return rows.map((r) => ({ id: r.id, room: r.room, teammate: TEAM_GALAHAD, trigger: r.trigger, chainId: r.chain_id, status: r.status, error: r.error, createdAt: r.created_at, updatedAt: r.updated_at }));
  }
  /** Galahad's own words to one worker (in the conversation you have with it) or to a room: all of it or nothing,
   * so a message that is refused leaves no conversation behind. */
  say(raw: TeamSayInput): TeamMessage {
    const input = teamInput(TeamSayInput, raw);
    return this.db.transaction(() => this.post({ room: input.room ?? this.direct(input.teammate!).id, text: input.text }, { galahad: true }))();
  }
  /** His words in a room for you, waking no knight: what he tells you of an outcome he owns (outcomes.ts). */
  note(room: string, text: string): TeamMessage {
    teamText(text);
    // A reply in a conversation of its own, for you: it reaches nobody, even a knight it names (an outcome's note that
    // said "I've given @gareth the task" woke Gareth for a reply, which held his next task behind it).
    return this.db.transaction(() => this.post({ room, text }, { galahad: true, reply: true, quiet: true, chainId: this.chain(this.requireRoom(room)) }))();
  }
  messages(room: string, limit: number = TEAM_LIMITS.history): TeamMessage[] {
    this.requireRoom(room);
    const count = Math.max(1, Math.min(TEAM_LIMITS.history, Math.trunc(limit) || TEAM_LIMITS.history));
    return this.db.query<MessageRow, [string, number]>("SELECT * FROM team_messages WHERE room = ? ORDER BY seq DESC LIMIT ?").all(room, count).reverse().map(messageOf);
  }
  private insertJob(kind: JobRow["kind"], room: string, teammate: string, chain: string, data: unknown, status: "queued" | "proposed" = "queued"): string {
    const key = id(kind === "task" ? "task" : "delivery");
    const at = this.now();
    this.db.query("INSERT INTO team_jobs(id,kind,room,teammate,chain_id,status,data,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)").run(key, kind, room, teammate, chain, status, JSON.stringify(data), at, at);
    return key;
  }
  createTask(raw: TeamTaskInput, by: { teammate?: string; chainId?: string; givenBy?: string; fix?: TeamTaskFix; propose?: boolean } = {}): TeamTask {
    const input = teamInput(TeamTaskInput, raw);
    teamText([input.title, input.goal, ...(input.gates ?? [])].join("\n"));
    return this.db.transaction(() => {
      const room = this.requireRoom(input.room);
      if (this.closed(room)) throw new TeamError(410, CLOSED);
      this.roomMember(room, input.assignee);
      if (by.teammate) this.roomMember(room, by.teammate);
      if (by.teammate && !by.chainId) throw new TeamError(403, "A delegated task must belong to the current conversation.");
      for (const dependency of input.dependsOn ?? []) {
        const task = this.task(dependency);
        if (!task || task.room !== room.id) throw new TeamError(400, "Every dependency must already exist in this room.");
      }
      if (this.pending() >= TEAM_LIMITS.pending) throw new TeamError(429, "The team queue is full. Let some work finish first.");
      // Galahad's own giving is within his allowance for the day; yours is not counted, nor an outcome's (its own allowance and budget: outcomes.ts).
      if (by.givenBy === TEAM_GALAHAD && !input.outcome && !by.propose && this.db.query<{ n: number }, [string, number]>("SELECT COUNT(*) AS n FROM team_jobs WHERE kind = 'task' AND json_extract(data, '$.givenBy') = ? AND json_extract(data, '$.outcome') IS NULL AND created_at > ?").get(TEAM_GALAHAD, this.now() - 86_400_000)!.n >= TEAM_LIMITS.givesPerDay) {
        throw new TeamError(429, `Galahad has given the Roundtable ${TEAM_LIMITS.givesPerDay} tasks in the last day, which is his allowance. The owner can give more at the Roundtable.`);
      }
      // Sensitive mode (heldModels): the models you named for it; work a knight in sensitive mode gives is held to its
      // models, whoever does it; and one in it is given none held to others.
      const models = input.models ?? (by.teammate ? heldModels(this.requireTeammate(by.teammate)) ?? undefined : undefined);
      const assignee = this.requireTeammate(input.assignee);
      try {
        heldModels(assignee, { models });
      } catch (error) {
        throw new TeamError(400, (error as Error).message);
      }
      if (models && assignee.harness === "acp") throw new TeamError(400, `${assignee.name} works in an ACP agent of yours, which calls the models you set it up with: a task in sensitive mode goes to a knight on Galahad's own harness, OpenCode, Hermes, Claude Code or Codex.`);
      // Started from a step of another task (PLAN #15): the same knight's, whose VM keeps that step's checkpoint.
      let from: TeamTask["from"];
      if (input.from) {
        const source = this.task(input.from.task);
        if (!source) throw new TeamError(404, "No such task to start from.");
        if (source.assignee !== input.assignee) throw new TeamError(400, `A task starts from a step of its own knight's work: task ${source.id} is ${source.assignee}'s, and its steps are kept in that knight's VM.`);
        const point = this.checkpoint(source.id, input.from.step);
        if (!point) throw new TeamError(400, `Task ${source.id} has no step ${input.from.step} kept to start from.`);
        from = { task: source.id, step: point.step, commit: point.commit, command: point.command };
      }
      const chain = by.chainId ?? this.chain(room);
      // A knight's task is proposed to you: it is written down where it was asked for, and waits for your approval. So
      // is the work Galahad offers an idle knight from your backlog (backlog.ts): a proposal isn't a give.
      const proposed = by.teammate ? { proposedBy: by.teammate } : by.propose ? { proposedBy: by.givenBy ?? TEAM_GALAHAD } : {};
      const key = this.insertJob("task", room.id, input.assignee, chain, { title: input.title, goal: input.goal, dependsOn: input.dependsOn ?? [], gates: input.gates ?? [], ...(input.budgetUsd !== undefined ? { budgetUsd: input.budgetUsd } : {}), verified: false, progress: "", output: "", ...(by.givenBy ? { givenBy: by.givenBy } : {}), ...(input.outcome ? { outcome: input.outcome } : {}), ...(models ? { models: [...models] } : {}), ...(from ? { from } : {}), ...(by.fix ? { fix: by.fix } : {}), ...proposed }, by.teammate || by.propose ? "proposed" : "queued");
      return this.task(key)!;
    })();
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
  /** Whether kept work is of work in sensitive mode (heldModels): as its label says, its knight's mode, or its task's. */
  sensitiveWork(artifact: { id: string; label: string; sandbox?: string | null }): boolean {
    if (artifact.label.endsWith(SENSITIVE_WORK)) return true;
    if (artifact.sandbox && this.teammates().some((t) => t.sensitive && t.workspace?.id === artifact.sandbox)) return true;
    return Boolean(this.taskOfWork(artifact.id)?.models?.length);
  }
  /** The task whose kept work this is (an artifact's id), if it was this node's knights'. */
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
    const data = JSON.parse(row.data) as Pick<TeamTask, "title" | "goal" | "dependsOn" | "gates" | "budgetUsd" | "verified" | "progress" | "output" | "record" | "changes" | "givenBy" | "proposedBy" | "interventions" | "outcome" | "models" | "from" | "fix" | "shipped">;
    return { ...data, id: row.id, room: row.room, assignee: row.teammate, chainId: row.chain_id, status: row.status, error: row.error, createdAt: row.created_at, updatedAt: row.updated_at };
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
    return this.listedJobs("delivery", room).map((r) => ({ id: r.id, room: r.room, teammate: r.teammate, trigger: (JSON.parse(r.data) as { trigger: string }).trigger, chainId: r.chain_id, status: r.status, error: r.error, createdAt: r.created_at, updatedAt: r.updated_at }));
  }
  queued(): TeamJob[] { return this.db.query<JobRow, []>("SELECT * FROM team_jobs WHERE status='queued' ORDER BY seq").all().map(jobOf); }
  /** A bounded public activity projection: no titles, messages, errors or task JSON
   * leave the store with it. Keep old live jobs and only a minute of terminal states. */
  avatarActivity(): AvatarActivity {
    const rows = this.db.query<{ kind: JobRow["kind"]; teammate: string; status: TeamWorkStatus; updatedAt: number }, [number, number]>(`
      SELECT kind,teammate,status,MAX(updated_at) AS updatedAt FROM (
        SELECT kind,teammate,status,updated_at FROM team_jobs WHERE status IN ('running','queued')
        UNION ALL
        SELECT kind,teammate,status,updated_at FROM team_jobs WHERE updated_at >= ? AND status NOT IN ('running','queued')
      )
      GROUP BY teammate,kind,status
      ORDER BY status IN ('running','queued') DESC,updatedAt DESC LIMIT ?
    `).all(this.now() - 60_000, TEAM_LIMITS.teammates * 12);
    const tasks: AvatarActivity["tasks"][number][] = [];
    const deliveries: AvatarActivity["deliveries"][number][] = [];
    for (const row of rows) {
      // finish() only permits a task to reach done after a verified result.
      if (row.kind === "task") tasks.push({ assignee: row.teammate, status: row.status, verified: row.status === "done", updatedAt: row.updatedAt });
      else deliveries.push({ teammate: row.teammate, status: row.status, updatedAt: row.updatedAt });
    }
    return { tasks, deliveries };
  }
  snapshot(): TeamSnapshot {
    // Its kept conversations, yours with it first: they are in no other list.
    const direct = this.rooms().filter((room) => room.direct).sort((a, b) => a.members.length - b.members.length);
    const removed = this.removed().map(({ id, name, removedAt }) => { const conversations = direct.filter((room) => room.members.includes(id)).map((room) => room.id); return { id, name, removedAt, ...(conversations.length ? { conversations } : {}) }; });
    const computer = this.computer();
    const { order, primary } = this.arrangement();
    return { northStar: this.northStar(this.now() - 30 * 86_400_000), teammates: this.teammates(), rooms: this.openRooms(), tasks: this.tasks(), deliveries: [...this.deliveries(), ...this.galahadAnswers()], ...(removed.length ? { removed } : {}), ...(this.engram() ? { engram: true } : {}), ...(this.ciBack() ? { ciBack: true } : {}), ...(this.backlog() ? { backlog: true } : {}), ...(computer ? { computer } : {}), order, primary, seen: this.seen() };
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
  /** When you last looked at each knight's page (`knight:<id>`) and each room (`room:<id>`), on any device. */
  seen(): Record<string, number> {
    return Object.fromEntries(this.db.query<{ key: string; at: number }, []>("SELECT key, at FROM team_seen").all().map((row) => [row.key, row.at]));
  }
  /** You looked at a knight's page or a room just now: what ended there so far is no longer new. */
  see(key: `knight:${string}` | `room:${string}`): void {
    this.db.query("INSERT INTO team_seen (key, at) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET at = MAX(at, excluded.at)").run(key, this.now());
  }
  /** The team as Galahad himself reads it: bounded, and without anyone's working notes. `room`: that room's latest words too. */
  overview(room?: string): TeamOverview {
    const all = this.teammates();
    const active = this.db.query<{ teammate: string; status: TeamWorkStatus }, []>("SELECT teammate,status FROM team_jobs WHERE status IN ('running','queued')").all();
    const state = (t: Teammate): TeamOverview["workers"][number]["state"] =>
      active.some((job) => job.teammate === t.id && job.status === "running") ? "working" : !t.enabled ? "paused" : t.turnsToday >= t.dailyTurns ? "allowance spent" : active.some((job) => job.teammate === t.id) ? "queued" : "ready";
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
  roomView(id: string): TeamRoomView { return { ...this.requireRoom(id), messages: this.messages(id), tasks: this.tasks(id), deliveries: [...this.deliveries(id), ...this.galahadAnswers(id)] }; }

  /** Daily allowance and the cross-room causal allowance are reserved together, before any callback runs. */
  claim(key: string): boolean {
    return this.db.transaction(() => {
      const row = this.jobRow(key);
      if (!row || row.status !== "queued") return false;
      // (Never a throw here: one job that cannot run must not hold up everyone else's.)
      const teammate = this.teammate(row.teammate);
      if (!teammate) { this.finish(key, "stopped", REMOVED); return false; }
      const room = this.requireRoom(row.room);
      if (this.closed(room)) { this.finish(key, "stopped", CLOSED); return false; }
      if (!room.members.includes(teammate.id)) { this.finish(key, "stopped", "The knight is no longer in this room."); return false; }
      if (!teammate.enabled || room.paused) return false;
      if (this.db.query("SELECT id FROM team_jobs WHERE teammate=? AND status='running'").get(teammate.id)) return false;
      if (row.kind === "task") {
        const task = this.taskOf(row);
        if (!task.dependsOn.every((key) => { const before = this.task(key); return before?.status === "done" && before.verified; })) return false;
      }
      const chain = this.db.query<{ budget: number; spent: number }, [string]>("SELECT budget,spent FROM team_chains WHERE id=?").get(row.chain_id);
      if (!chain || chain.spent >= chain.budget) { this.finish(key, "stopped", "This conversation reached its turn budget. Start a new message to continue."); return false; }
      if (this.turns(teammate.id) >= teammate.dailyTurns) return false;
      this.db.query("INSERT INTO team_usage(teammate,day,turns) VALUES(?,?,1) ON CONFLICT(teammate,day) DO UPDATE SET turns=turns+1").run(teammate.id, this.day());
      this.db.query("UPDATE team_chains SET spent=spent+1 WHERE id=?").run(row.chain_id);
      this.db.query("UPDATE team_jobs SET status='running',error=NULL,updated_at=? WHERE id=? AND status='queued'").run(this.now(), key);
      return true;
    })();
  }
  progress(key: string, text: string): void {
    const row = this.jobRow(key);
    if (!row || row.kind !== "task" || row.status !== "running") return;
    const at = this.now();
    const data = { ...JSON.parse(row.data), progress: teamOutput(text, TEAM_LIMITS.progress) };
    this.db.transaction(() => {
      this.db.query("UPDATE team_jobs SET data=?,updated_at=? WHERE id=?").run(JSON.stringify(data), at, key);
      this.trailLine(key, at, text);
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
  /** The tasks in any of these states: one by its id, a knight's or a room's. */
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
  private trailLine(key: string, at: number, text: string): void {
    const n = (this.db.query<{ n: number | null }, [string]>("SELECT MAX(n) AS n FROM team_trail WHERE task=?").get(key)?.n ?? 0) + 1;
    this.db.query("INSERT INTO team_trail(task,n,at,text) VALUES(?,?,?,?)").run(key, n, at, teamOutput(text, TRAIL.text));
    if (n > TRAIL.keep) this.db.query("DELETE FROM team_trail WHERE task=? AND n<=?").run(key, n - TRAIL.keep);
  }
  /** What a task did, as it happened: its lines after number `after` (0: from the first kept), a page at a time; `more`: there are further lines. */
  trail(task: string, after = 0): { entries: TeamTrailEntry[]; more: boolean } {
    const rows = this.db.query<TeamTrailEntry, [string, number, number]>("SELECT n, at, text FROM team_trail WHERE task=? AND n>? ORDER BY n LIMIT ?").all(task, Math.max(0, Math.trunc(after)), TRAIL.page + 1);
    return { entries: rows.slice(0, TRAIL.page), more: rows.length > TRAIL.page };
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
   * Work a planned restart (a deploy, an update: the node stopped on purpose) cut off: interrupted, and taken up again by
   * itself after `until`, when whatever it was running in its knight's VM has surely met its own deadline there. That
   * happens once: cut off a second time, it waits for you, its room held, as work a crash cut off does (`recover`).
   */
  interruptForRestart(key: string, until: number, minutes: number): void {
    this.db.transaction(() => {
      const row = this.jobRow(key);
      if (!row || row.status !== "running") return;
      const data = JSON.parse(row.data);
      const again = data.restart?.resumed === true;
      // A reply is begun again from its start: one that had already done something (acted) would do it twice.
      const acted = row.kind === "delivery" && data.acted === true;
      if (again) data.restart = { resumed: true };
      else if (acted) delete data.restart;
      else data.restart = { until };
      const error = again
        ? "Galahad restarted during this work again. It was taken up once by itself already, so it waits for you: review it before resuming."
        : acted
          ? "Galahad restarted during this reply, after it had already done something (a message sent, a task proposed, a command run). Begun again it could do that twice, so it waits for you: review it before resuming."
          : `Galahad restarted during this work. It picks up again by itself once the command it was running has surely ended: at most ${minutes} minutes after the restart.`;
      this.db.query("UPDATE team_jobs SET status='interrupted',data=?,error=?,updated_at=? WHERE id=?").run(JSON.stringify(data), error, this.now(), key);
      if (again || acted) this.pauseRoom(row.room, true);
    })();
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
  /** Knights with work a restart cut off that isn't due yet: nothing else of theirs starts before it, in the same VM. */
  restartWaits(): Set<string> {
    const now = this.now();
    const waiting = new Set<string>();
    for (const row of this.db.query<JobRow, []>("SELECT * FROM team_jobs WHERE status='interrupted'").all()) {
      const until = JSON.parse(row.data).restart?.until;
      if (typeof until === "number" && until > now) waiting.add(row.teammate);
    }
    return waiting;
  }
  /** Work a restart cut off whose wait is over, queued again where it stood in line, with a line on its trail saying why.
   * A removed knight's never is, and a paused knight's or a closed room's waits for you. Returns how many. */
  resumeRestarted(): number {
    return this.db.transaction(() => {
      const now = this.now();
      let taken = 0;
      for (const row of this.db.query<JobRow, []>("SELECT * FROM team_jobs WHERE status='interrupted' ORDER BY seq").all()) {
        const data = JSON.parse(row.data);
        if (typeof data.restart?.until !== "number" || data.restart.until > now) continue;
        const room = this.room(row.room);
        if (!room || this.closed(room) || !this.teammate(row.teammate)?.enabled) continue;
        data.restart = { resumed: true };
        this.db.query("UPDATE team_jobs SET status='queued',error=NULL,chain_id=?,data=?,updated_at=? WHERE id=?").run(this.chain(room), JSON.stringify(data), now, row.id);
        if (row.kind === "task") this.trailLine(row.id, now, "Taken up again by itself after Galahad restarted.");
        taken++;
      }
      return taken;
    })();
  }
  /** You paused or stopped work (or its knight, or its room) while it waited to be taken up after a restart: it won't be. */
  holdRestarts(select: TeamSelection, status: "interrupted" | "stopped", error: string): void {
    this.db.transaction(() => {
      for (const row of this.db.query<JobRow, []>("SELECT * FROM team_jobs WHERE status='interrupted'").all()) {
        const data = JSON.parse(row.data);
        if (typeof data.restart?.until !== "number" || !matches(jobOf(row), select)) continue;
        delete data.restart;
        this.db.query("UPDATE team_jobs SET status=?,error=?,data=?,updated_at=? WHERE id=?").run(status, teamOutput(error, 2000), JSON.stringify(data), this.now(), row.id);
      }
    })();
  }
  /** In-flight side effects are never replayed by merely reopening a node: work a crash cut off waits for you. */
  recover(): void {
    this.db.transaction(() => {
      const running = this.db.query<JobRow, []>("SELECT * FROM team_jobs WHERE status='running'").all();
      for (const row of running) {
        this.finish(row.id, "interrupted", "The node stopped during this work. Review it before resuming.");
        this.pauseRoom(row.room, true);
      }
      // His answer is never given twice: one the node stopped during is said to be cut off, and asked for again by you.
      this.db.query("UPDATE team_answers SET status='interrupted',error=?,updated_at=? WHERE status='running'").run("The node stopped while Galahad was answering. Ask him again.", this.now());
    })();
  }
  pauseRoom(id: string, paused: boolean): TeamRoom { return this.putRoom({ ...this.requireRoom(id), paused, updatedAt: this.now() }); }
  enable(id: string, enabled: boolean): Teammate { return this.putTeammate({ ...this.requireTeammate(id), enabled, updatedAt: this.now() }); }
  stopQueued(select: TeamSelection): void {
    for (const job of this.queued()) if (matches(job, select)) this.finish(job.id, "stopped", "Stopped by you.");
    // His answers wait in rooms: a knight's or a task's stopping leaves them be.
    if (!select.teammate && !select.task) for (const answer of this.queuedAnswers()) if (!select.room || answer.room === select.room) this.finishAnswer(answer.id, "stopped", "Stopped by you.");
    // A proposal you stop is declined: it never ran.
    for (const row of this.db.query<JobRow, []>("SELECT * FROM team_jobs WHERE status='proposed' ORDER BY seq").all()) if (matches(jobOf(row), select)) this.finish(row.id, "stopped", "Declined by you.");
  }
  /** A task a knight proposed, approved by you: it waits its turn like one you gave, in a chain of its own. */
  approve(task: string): TeamTask {
    return this.db.transaction(() => {
      const row = this.jobRow(task);
      if (!row || row.kind !== "task") throw new TeamError(404, "No such team task.");
      if (row.status !== "proposed") throw new TeamError(409, "That task isn't waiting for your approval.");
      if (!this.teammate(row.teammate)) throw new TeamError(410, "That task's knight was removed. Give the work to another knight.");
      this.db.query("UPDATE team_jobs SET status='queued',chain_id=?,updated_at=? WHERE id=? AND status='proposed'").run(this.chain(this.requireRoom(row.room)), this.now(), row.id);
      return this.task(row.id)!;
    })();
  }
  /** Your resume makes interrupted or stopped work runnable again (the one other way: a planned restart's own work, once,
   * by itself: resumeRestarted). */
  resume(select: TeamSelection): void {
    this.db.transaction(() => {
      const found = this.db.query<JobRow, []>("SELECT * FROM team_jobs WHERE status IN ('interrupted','stopped','failed') ORDER BY seq").all().filter((r) => matches(jobOf(r), select) && (select.task || r.status === "interrupted"));
      // What a removed worker left unfinished is never started again: asked for by name it says so, otherwise it is passed over.
      const rows = found.filter((r) => this.teammate(r.teammate));
      if (select.task && found.length && !rows.length) throw new TeamError(410, "That task's knight was removed. Revise the task for another knight.");
      if (this.pending() + rows.length > TEAM_LIMITS.pending) throw new TeamError(429, "Too much work to resume at once.");
      const chains = new Map<string, string>();
      for (const row of rows) {
        let chain = chains.get(row.room);
        if (!chain) { chain = this.chain(this.requireRoom(row.room)); chains.set(row.room, chain); }
        this.db.query("UPDATE team_jobs SET status='queued',error=NULL,chain_id=?,updated_at=? WHERE id=?").run(chain, this.now(), row.id);
      }
    })();
  }
}
