import { z } from "zod";
import type { AttachmentRef } from "./api.ts";
import type { TeamWorkStatus } from "./team.ts";
import type { AnswerStatus, ChatNeeds, ChatState, QueuedMessage, QueueHold, TurnView } from "./turns.ts";

/*
 * Chat history and projects.
 *
 * A conversation lives on the node that served it (a private database there): every
 * device and the terminal see the same history through that node, and deleting one
 * deletes it. Only you read it (never an agent), and a conversation where Galahad read
 * the bank is shown only to a device that may read the bank.
 *
 * A project is a workspace that every node knows (the mind, `project.set`): a name,
 * the instructions Galahad follows in its chats, an optional repository. Its chats and
 * the memories made in them are grouped under it.
 */

export const ProjectId = z.string().regex(/^[a-z0-9][a-z0-9-]{0,39}$/, "lowercase letters, digits and - (max 40)");
export const ConversationId = z.string().regex(/^cv_[A-Za-z0-9_-]{22}$/);

export const ProjectInput = z.strictObject({
  id: ProjectId,
  name: z.string().trim().min(1).max(80),
  instructions: z.string().max(8000).optional(),
  /** An https URL of the project's repository (null: none). */
  repo: z.string().url().max(300).regex(/^https:\/\//, "an https:// URL").nullable().optional(),
});

export interface ProjectView {
  id: string;
  name: string;
  instructions: string;
  repo: string | null;
  /** Where its work is kept on his computer (`projectCheckout`): the Build view's files, changes and branch are that folder's. */
  checkout: string;
  updatedAt: number;
}

/** A project's checkout on Galahad's computer: one folder per project, under /work. */
export const projectCheckout = (id: string): string => `/work/projects/${id}`;

/** A branch's name as git takes one (its own check runs too): letters, digits and . _ / -, never starting with - . or /. */
export const BranchName = z
  .string()
  .min(1)
  .max(100)
  .regex(/^(?![-./])[A-Za-z0-9._/-]+$/, "letters, digits and . _ / -")
  .refine((name) => !name.includes("..") && !name.endsWith("/") && !name.endsWith(".") && !name.endsWith(".lock"), "not a branch name git takes");
/** The Build view's git, yours alone, on a project's checkout: its state, a branch to switch to or start, a commit, the first clone. */
export const ProjectGitInput = z.strictObject({ id: ProjectId });
export const ProjectBranchInput = z.strictObject({ id: ProjectId, branch: BranchName, create: z.boolean().default(false) });
export const ProjectCommitInput = z.strictObject({ id: ProjectId, message: z.string().trim().min(1).max(2000) });

/** A project's checkout as git has it (`POST /api/projects/git`). */
export interface ProjectGitView {
  checkout: string;
  /** missing: no folder yet (Set up clones it); not-a-repository: a folder git doesn't know. */
  state: "ready" | "missing" | "not-a-repository";
  /** Null when detached, or not ready. */
  branch: string | null;
  head: string | null;
  /** Its branches, the latest worked on first. */
  branches: string[];
  /** Files changed or new, not yet committed. */
  changed: number;
  upstream: string | null;
  ahead: number | null;
  behind: number | null;
  /** origin's address, with any credentials in it taken out. */
  remote: string | null;
  /** Its latest commits, newest first. */
  log: { sha: string; subject: string; at: number }[];
}

/** One step of an answer, as the chat streamed it (kept with the answer). */
export type StoredStep =
  | { kind: "model"; ref: string }
  | { kind: "fallback"; from: string; error: string }
  | { kind: "tool"; id: string; name: string; title: string; input: string; ok: boolean | null; summary: string | null }
  /** Archived entries Galahad was given as context for this answer. */
  | { kind: "archive"; entries: { id: string; title: string; kind: string; trust: string }[] };

export interface StoredMessage {
  id: number;
  role: "user" | "assistant";
  content: string;
  /** Your files with it, as kept on the node (a message of yours alone). */
  attachments?: AttachmentRef[];
  /**
   * A look of his own (look_later), not your words: the message that starts the turn he takes when it comes, with
   * when he set it and his note (its `content` is the note as the model is given it).
   */
  look?: { set: number; note: string };
  /** Assistant answers: which model, what it did, how it ended. */
  model: string | null;
  steps: StoredStep[];
  /** "steered": you sent a message while he was answering; the turn went on with it, in the next answer. */
  status: AnswerStatus;
  error: string | null;
  createdAt: number;
  endedAt: number | null;
}

/** A look he set himself, to look at something again later in a chat of yours: it comes back there as a turn of his. */
export interface LookView {
  id: string;
  conversation: string;
  /** When he looks (ms). */
  at: number;
  /** What he means to look at, in his words. */
  note: string;
  /** When he set it (ms). */
  set: number;
  /** The zone its time was given in (the one he was told then). */
  zone: string;
  state: "waiting" | "done" | "cancelled" | "failed";
  /** Why it was called off or failed (null: neither). */
  why: string | null;
}

/** So many waiting in a chat, and on a node; no sooner than a minute and no later than 30 days; a note this long. A look
 * due while its node was away is taken when it is back, within a week. */
export const LOOK_LIMITS = { perChat: 10, perNode: 50, minMs: 60_000, aheadMs: 30 * 24 * 3_600_000, noteChars: 500, lateMs: 7 * 24 * 3_600_000 } as const;

export const LookId = z.string().regex(/^lk_[A-Za-z0-9_-]{16}$/);
/** What the answer that set a look held of yours (the bank, or a private connector's data): its turn starts holding it too. */
export const LookHeld = z.union([z.strictObject({ what: z.literal("bank") }), z.strictObject({ what: z.literal("connector"), id: z.string().min(1).max(64) })]);
export type LookHeld = z.infer<typeof LookHeld>;
/** When: in a while (45m, 2h, 1d), or at a wall-clock time in the zone of the turn it is set in. */
export const LookWhen = { in: z.string().trim().regex(/^\d{1,5} ?[mhd]$/, "in minutes, hours or days: 45m, 2h, 1d"), at: z.string().trim().regex(/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}$/, "a date and a time: 2026-11-25 09:00") };
/** Where a look is set, filled in by the node from the turn it is set in, never by the model. */
const LookTurn = z.strictObject({ conversation: ConversationId, by: z.strictObject({ kind: z.enum(["admin", "client"]), device: z.string().min(1).max(128) }), zone: z.string().min(1).max(64) });
export const LookLaterInput = z
  .strictObject({ note: z.string().trim().min(1).max(LOOK_LIMITS.noteChars), in: LookWhen.in.optional(), at: LookWhen.at.optional(), held: LookHeld.nullable().optional(), turn: LookTurn.optional() })
  .refine((x) => (x.in === undefined) !== (x.at === undefined), "give in or at, one of them");
export const CancelLookInput = z.strictObject({ id: LookId, turn: LookTurn.optional() });

/** A knight's task he gave from a chat of yours that hasn't ended: its row above that chat's message box, with its Stop. */
export interface UnderwayTask {
  id: string;
  title: string;
  /** The knight's handle, and its name. */
  assignee: string;
  name: string;
  status: TeamWorkStatus;
  progress: string;
  /** The knight's own conversation with you, where it works. */
  room: string;
  createdAt: number;
  updatedAt: number;
}

/** What is under way in a chat of yours: the tasks he gave knights there that haven't ended, and his looks that wait. */
export interface UnderwayView {
  tasks: UnderwayTask[];
  looks: LookView[];
}

export interface ConversationSummary {
  id: string;
  title: string;
  project: string | null;
  /** The roster role it was asked as. */
  role: string;
  pinned: boolean;
  createdAt: number;
  updatedAt: number;
  /** How many messages it holds. */
  count: number;
  /** Galahad read the bank in it: shown only to devices that may read the bank. */
  bank: boolean;
  /** Where it stands, at a glance (turns.ts): working, waiting on you, queued, stopped, failed or done. */
  state: ChatState;
  /** Messages of yours queued behind it, and why they're held (null: they go when the turn before them ends). */
  queued: number;
  held: QueueHold | null;
  /** What it waits on you for (null: nothing). */
  needs: ChatNeeds | null;
  /** An answer of his ended in it since you last read it, on any device (email's unread). An answer that ended while a
   * device was watching it was read there. Absent from an older node. */
  unread?: boolean;
}

/** A chat with an answer you haven't read yet, as `GET /api/turns` lists them (the newest answer first). */
export interface UnreadChat {
  id: string;
  title: string;
  /** When its latest answer ended. */
  answeredAt: number;
}

export interface ConversationView extends ConversationSummary {
  messages: StoredMessage[];
  /** The turn the node is running in it now (attach to watch it), if any. */
  turn: TurnView | null;
  /** Your queued messages, in the order they'll be sent. */
  queue: QueuedMessage[];
}

/** A title from the first thing you asked: its first line, at most 60 characters. */
export function titleFrom(text: string): string {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length > 60 ? `${line.slice(0, 59).trimEnd()}…` : line || "New chat";
}
