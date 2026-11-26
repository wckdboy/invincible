import { z } from "zod";
import { TEAM_LIMITS } from "./team-limits.ts";
import { sha256Bytes } from "./crypto.ts";
import { utf8 } from "./bytes.ts";
import { AVATAR_FORMS, AVATAR_EYES, AVATAR_ACCESSORIES, AVATAR_TEMPERAMENTS, type AvatarProfile, type OrbProfile } from "./avatar.ts";
import { hasUndrawn, oneScript, readAlike } from "./lookalike.ts";
import { SpendLines } from "./usage.ts";
import { ATTACHMENT_LIMITS } from "./attachments.ts";
import { AttachmentRef } from "./attachment-ref.ts";
export { TEAM_LIMITS } from "./team-limits.ts";
import type { InterventionKind, NorthStar } from "./interventions.ts";
export { INTERVENTIONS, type InterventionKind, interventionWords, type NorthStar, northStar } from "./interventions.ts";

/* Named teammates and their conversations live on one controller node. Their VM
 * workspaces may live on other fleet nodes; no team chat is put in the shared mind. */

/** Who else speaks in a room, makes a worker or writes its job: you, and Galahad himself in your own
 * conversation with him. Neither is ever a worker's handle (nor is "system"). */
export const TEAM_OWNER = "owner";
export const TEAM_GALAHAD = "galahad";
export const TeammateId = z.string().regex(/^[a-z][a-z0-9-]{0,31}$/, "a lowercase name of at most 32 letters, digits or hyphens").refine((id) => id !== TEAM_OWNER && id !== "system" && id !== TEAM_GALAHAD, "that name is reserved");
export const TeamRoomId = z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/);
export const TeamTaskId = z.string().regex(/^task-[a-z0-9_-]{12}$/);
/** An outcome Galahad owns (PLAN #43): its id is its room's too. */
export const TeamOutcomeId = z.string().regex(/^out-[a-z0-9_-]{12}$/);
/**
 * `claude` and `codex` are the vendors' own tools (Claude Code, Codex), which the owner installs and signs in in the
 * knight's VM; `acp`, any agent that speaks the Agent Client Protocol, started by the command you name (`acp`).
 */
export const TeamHarness = z.enum(["native", "opencode", "hermes", "claude", "codex", "acp"]);
export type TeamHarness = z.infer<typeof TeamHarness>;
/**
 * A key of yours a knight may use but never see (PLAN #17): a secret in the vault, pinned to its API's address, that the
 * gateway puts into the knight's calls there and nowhere else. `header`: where it goes (authorization, as "Bearer
 * <key>"; or the API's own x-… header, the key as it is). `write`: whether calls that change something (POST, PUT, PATCH,
 * DELETE) may go too; without it, reads alone.
 */
export const TeamKeyGrant = z.strictObject({
  secret: z.string().regex(/^[A-Za-z0-9._-]{1,64}$/, "a secret's name, as the vault keeps it"),
  header: z.string().regex(/^(authorization|api-key|x-[a-z0-9-]{1,60})$/, "authorization, api-key, or an x-… header").default("authorization"),
  write: z.boolean().default(false),
});
export type TeamKeyGrant = z.infer<typeof TeamKeyGrant>;
/** An ACP agent you name to a knight (harness `acp`): the command that starts it in its ACP mode in its VM, as plain words. */
export const TeamAcpCommand = z.string().trim().max(300).regex(/^[A-Za-z0-9._\/:=@+,-]+( [A-Za-z0-9._\/:=@+,-]+){0,15}$/, "the command that starts it in its ACP mode, as plain words: no quotes, no shell");
export const TeamWorkspaceQuest = z.string().regex(/^arm\.team\.[a-f0-9]{10}\.[a-z][a-z0-9-]{0,31}$/);
/** Controller-local identities must not accidentally share a VM on a fleet host. */
export function teamArmLabel(controller: string, teammate: string): string {
  const tag = [...sha256Bytes(utf8(controller)).slice(0, 5)].map((b) => b.toString(16).padStart(2, "0")).join("");
  // (Galahad's own computer goes under his reserved handle, which no knight can ever take.)
  return `team.${tag}.${teammate === TEAM_GALAHAD ? TEAM_GALAHAD : TeammateId.parse(teammate)}`;
}

const AvatarColor = z.string().regex(/^#[0-9a-f]{6}$/i, "a six-digit hex color").transform((color) => color.toLowerCase());
/** A knight's avatar as saved: the colour you chose for its orb (v 2), or the look from before the orbs (v 1), still taken
 * from an app that sends one, though it colours nothing now (core's knightColors). */
export const AvatarProfileSchema = z.union([
  z.strictObject({ v: z.literal(2), color: AvatarColor }),
  z.strictObject({
    v: z.literal(1), form: z.enum(AVATAR_FORMS), color: AvatarColor, accent: AvatarColor,
    eyes: z.enum(AVATAR_EYES), accessory: z.enum(AVATAR_ACCESSORIES), temperament: z.enum(AVATAR_TEMPERAMENTS),
  }),
]);

/** The model role a knight works on: one of the roster's, built in or one you made. */
export const TeammateRole = z.string().regex(/^[a-z][a-z0-9-]{0,39}$/);
/**
 * The models a knight's own work runs on, in order, in place of its role's: `provider/model` as the roster names them,
 * a local runtime's on whichever node of the fleet serves it (never a wildcard), eight at most.
 */
export const TeammateModels = z.array(z.string().trim().min(3).max(256).regex(/^[A-Za-z0-9._-]+\/[^\s*]+$/, "provider/model, as the roster names it")).max(8);

/**
 * Sensitive mode: the models a knight's work is held to, when it is on (a knight in sensitive mode, held to its own;
 * a task that names its own). Every call of that work goes to them and to no other model, not a role's, not a
 * fallback: its plan, its work, its audits and its review; a conversation's turns and the story it is told; Galahad's
 * look at its backlog; the work it gives another knight, and the knights it makes; its coding tool's, through a lease
 * of its VM good for them alone. It saves nothing to the memory every knight shares, no skill is learned from its
 * work, and the archive keeps none of what it kept (SENSITIVE_WORK). When none of them answers, the work fails: it never goes elsewhere. A task of a knight in sensitive mode may
 * be held to some of its models, never to others. Null: not on, and its calls go where they always have.
 */
/** How kept work of a task in sensitive mode ends its label: the archive keeps none of it (its summaries and vectors are other models'). */
export const SENSITIVE_WORK = " · sensitive mode";

export function heldModels(knight: Pick<Teammate, "name" | "models" | "sensitive">, task?: { models?: readonly string[] }): readonly string[] | null {
  // (The store never keeps a knight so; one that was would do nothing, never something elsewhere.)
  if (knight.sensitive && !knight.models?.length) throw new Error(`${knight.name} is in sensitive mode with no models of its own: it does no work until you choose some`);
  const own = knight.sensitive ? knight.models! : null;
  const named = task?.models?.length ? task.models : null;
  const outside = own && named ? named.filter((ref) => !own.includes(ref)) : [];
  if (outside.length) throw new Error(`${knight.name} is in sensitive mode, held to its own models (${own!.join(", ")}): a task held to ${outside.join(", ")} is never its`);
  return named ?? own;
}

export const TeammateInput = z.strictObject({
  id: TeammateId,
  name: z.string().trim().min(1).max(80),
  instructions: z.string().max(8000).optional(),
  role: TeammateRole.optional(),
  /** Omitted: kept as they were; null or none: its role's again. */
  models: TeammateModels.nullable().optional(),
  /** Sensitive mode: every call of its work held to its own models (`models`), none elsewhere (heldModels). Omitted: kept as it was. */
  sensitive: z.boolean().optional(),
  harness: TeamHarness.optional(),
  /** Its ACP agent's command (harness `acp`), e.g. `goose acp`. Omitted: kept as it was; null: none. */
  acp: TeamAcpCommand.nullable().optional(),
  /** Keys of yours it may use but never see (TeamKeyGrant), each once. Omitted: kept as they were; null or none: none. */
  keys: z.array(TeamKeyGrant).max(16).refine((keys) => new Set(keys.map((k) => k.secret)).size === keys.length, "each key once").nullable().optional(),
  enabled: z.boolean().optional(),
  dailyTurns: z.number().int().min(0).max(1000).optional(),
  repository: z.string().trim().max(300).regex(/^https:\/\/github\.com\/[A-Za-z0-9][A-Za-z0-9_.-]*\/[A-Za-z0-9][A-Za-z0-9_.-]*\/?$/, "an HTTPS GitHub repository without credentials, query or fragment").transform((url) => url.replace(/\/$/, "").replace(/\.git$/, "")).nullable().optional(),
  /** Omitted edits preserve appearance; null restores this identity's seeded default. */
  avatar: AvatarProfileSchema.nullable().optional(),
});
export type TeammateInput = z.infer<typeof TeammateInput>;

/** The name of a worker Galahad makes: a model chose it and every briefing that worker is given reads it, so it is
 * one plain word (letters, digits, hyphens and apostrophes, in their ordinary forms), written in one script, and
 * nobody else's name: not yours, his or the system's, however it is spelled (lookalike.ts). That it isn't another
 * worker's either is for the store to say, which knows them. */
const RESERVED_NAMES = ["you", "owner", "system", "galahad"];
const RecruitName = z.string().trim().transform((name) => name.normalize("NFKC")).pipe(
  z.string().max(24).regex(/^[\p{L}\p{N}][\p{L}\p{N}'’-]*$/u, "one plain word: letters, digits, hyphens and apostrophes")
    .refine((name) => !hasUndrawn(name), "one plain word: nothing in it that isn't drawn")
    .refine(oneScript, "one plain word, written in one script")
    .refine((name) => !RESERVED_NAMES.some((reserved) => readAlike(name, reserved)), "that name is reserved"),
);

/** What Galahad himself (or a worker of his, for its own room) may say of a worker he makes: its handle, its name,
 * its job, and which of your model roles answers for it. Everything else starts at the defaults and stays yours to
 * set: its allowance, its state, its look, its harness, and above all its repository, which is cloned into its VM
 * with your own GitHub access. */
export const TeamRecruitInput = z.strictObject({
  id: TeammateId,
  name: RecruitName,
  instructions: z.string().trim().min(1).max(8000),
  role: TeammateRole.optional(),
});
export type TeamRecruitInput = z.infer<typeof TeamRecruitInput>;

export const TeamWorkspace = z.strictObject({ node: z.string().min(1).max(200), id: z.string().regex(/^[a-f0-9]{10}$/) });
export type TeamWorkspace = z.infer<typeof TeamWorkspace>;

export const TeamRoomInput = z.strictObject({
  id: TeamRoomId.optional(),
  name: z.string().trim().min(1).max(100),
  members: z.array(TeammateId).min(1).max(TEAM_LIMITS.teammates).refine((ids) => new Set(ids).size === ids.length, "members must be distinct"),
  direct: z.boolean().optional(),
  turnBudget: z.number().int().min(1).max(64).optional(),
});
export type TeamRoomInput = z.infer<typeof TeamRoomInput>;

export const TeamPostInput = z
  .strictObject({
    room: TeamRoomId,
    /** Its words: none only for a message of yours that carries files. */
    text: z.string().trim().max(TEAM_LIMITS.message),
    /** Your files with it, kept on the node first (uploadAttachment), as a chat message's are. */
    attachments: z.array(AttachmentRef).min(1).max(ATTACHMENT_LIMITS.perMessage).optional(),
  })
  .refine((m) => m.text.length > 0 || !!m.attachments, "a message has words, or files it carries");
export type TeamPostInput = z.infer<typeof TeamPostInput>;
/** Galahad's own words into Team: to one worker (in that worker's direct conversation with you) or to a room. */
export const TeamSayInput = z.strictObject({ teammate: TeammateId.optional(), room: TeamRoomId.optional(), text: z.string().trim().min(1).max(TEAM_LIMITS.message) })
  .refine((input) => Boolean(input.teammate) !== Boolean(input.room), "choose one knight or one room");
export type TeamSayInput = z.infer<typeof TeamSayInput>;
/**
 * A step of a knight's task to start another from (PLAN #15): its repository workspace as it stood after that command,
 * kept as a checkpoint in the knight's VM. Steps are counted from 1, the task's first command.
 */
export const TeamTaskFrom = z.strictObject({ task: TeamTaskId, step: z.number().int().min(1).max(1_000_000) });
export type TeamTaskFrom = z.infer<typeof TeamTaskFrom>;

/** One step of a task that can be started from: the command it ran, and the commit its workspace was kept as after it. */
export interface TeamCheckpoint {
  step: number;
  /** The commit object, under refs/galahad/checkpoints/<task>/<step> in the knight's repository. */
  commit: string;
  command: string;
  at: number;
}

export const TeamTaskInput = z.strictObject({
  room: TeamRoomId,
  assignee: TeammateId,
  title: z.string().trim().min(1).max(200),
  goal: z.string().trim().min(1).max(8000),
  dependsOn: z.array(TeamTaskId).max(32).refine((ids) => new Set(ids).size === ids.length, "dependencies must be distinct").optional(),
  gates: z.array(z.string().trim().min(1).max(1000)).max(16).optional(),
  /** Money its model calls may spend, in US dollars at your prices: told what is spent at each step, it stops when spent. */
  budgetUsd: z.number().positive().max(100).optional(),
  /** The task this one gives again (Give again): your stepping in, counted on this one (#28). */
  again: TeamTaskId.optional(),
  /** The outcome it is a step of (PLAN #43): its spend counts against that outcome's budget. */
  outcome: TeamOutcomeId.optional(),
  /** Sensitive mode for this task alone: the models every call of its work is held to, none elsewhere (heldModels); absent: its knight's. Yours to name: no knight or Galahad does. */
  models: TeammateModels.min(1).optional(),
  /** Started from a step of another task of the same knight's: its workspace as it stood then (TeamTaskFrom). Yours to give. */
  from: TeamTaskFrom.optional(),
});
export type TeamTaskInput = z.infer<typeof TeamTaskInput>;

/**
 * A task given to the Roundtable rather than to a knight: the knight best suited to it takes it (roundtable.ts says
 * who and why), in that knight's direct conversation with you. `needs`: what it requires of that knight.
 */
export const TeamGiveInput = z.strictObject({
  goal: z.string().trim().min(1).max(8000),
  title: z.string().trim().min(1).max(200).optional(),
  gates: z.array(z.string().trim().min(1).max(1000)).max(16).optional(),
  /** Money its model calls may spend, in US dollars at your prices: told what is spent at each step, it stops when spent. */
  budgetUsd: z.number().positive().max(100).optional(),
  needs: z.strictObject({ desktop: z.boolean().optional(), repository: z.string().trim().min(1).max(300).optional() }).optional(),
});
export type TeamGiveInput = z.infer<typeof TeamGiveInput>;

/**
 * An outcome you give Galahad to own for days or weeks (PLAN #43; Devin Bots' core): he plans it in a room of its own,
 * gives tasks to the knights you name for it on his own within its budget (your ruling of 18 November), judges what
 * comes back (each task still gated and reviewed), reports once a day and asks you there when a decision is yours.
 * Shipping, and anything outward, still asks you on a card.
 */
export const TeamOutcomeInput = z.strictObject({
  title: z.string().trim().min(1).max(120),
  goal: z.string().trim().min(1).max(4000),
  /** How you'll both know it's done, in a few lines (optional: he proposes it, and asks). */
  done: z.string().trim().min(1).max(1000).optional(),
  knights: z.array(TeammateId).min(1).max(8).refine((ids) => new Set(ids).size === ids.length, "each knight once"),
  /** What it may spend in all, in US dollars at your prices: its tasks, and his own looks at it. */
  budgetUsd: z.number().min(0.5).max(1000),
  /** The hour of his daily report, in your time zone (default 9). */
  reportHour: z.number().int().min(0).max(23).optional(),
  tz: z.string().max(64).optional(),
});
export type TeamOutcomeInput = z.infer<typeof TeamOutcomeInput>;
export const TeamOutcomeControlInput = z.union([
  z.strictObject({ id: TeamOutcomeId, action: z.enum(["pause", "resume", "stop"]) }),
  /** Its budget, raised (or lowered, never below what it has spent and holds): one that had spent what it may goes on. */
  z.strictObject({ id: TeamOutcomeId, action: z.literal("budget"), budgetUsd: z.number().min(0.5).max(1000) }),
]);
export type TeamOutcomeControlInput = z.infer<typeof TeamOutcomeControlInput>;

export type TeamOutcomeStatus = "active" | "paused" | "done" | "stopped" | "spent";

export interface TeamOutcome {
  id: string;
  /** Its room: its tasks, his reports, and your words to him about it. */
  room: string;
  title: string;
  goal: string;
  done: string | null;
  knights: string[];
  budgetUsd: number;
  /** What its tasks and his looks have cost, at your prices (models with no price of yours count nothing). */
  spentUsd: number;
  /** Reserved by tasks still to run or running: what their budgets may still spend. */
  committedUsd: number;
  status: TeamOutcomeStatus;
  /** His plan, as he keeps it: what's done, what's next, what's in the way. */
  notes: string;
  tasks: { total: number; queued: number; running: number; done: number; failed: number };
  /** How often you stepped in on this outcome's own tasks, per one done and verified, since it began (#43). */
  northStar: NorthStar;
  reportHour: number;
  tz: string;
  lastLookAt: number | null;
  lastReportAt: number | null;
  /** When it ended, how he said it ended (done) or why (stopped, spent). */
  ended: string | null;
  createdAt: number;
  updatedAt: number;
}

/** Your order of the knights, and who leads the Roundtable (`galahad`, or one of your knights). Each is optional. */
export const TeamArrangeInput = z.strictObject({
  order: z.array(TeammateId).max(64).refine((ids) => new Set(ids).size === ids.length, "each knight is in the order once").optional(),
  primary: z.union([z.literal(TEAM_GALAHAD), TeammateId]).optional(),
});
export type TeamArrangeInput = z.infer<typeof TeamArrangeInput>;

/** A knight's page (its conversation with you and its tasks), or a room, looked at by you. */
export const TeamSeenInput = z.union([z.strictObject({ knight: TeammateId }), z.strictObject({ room: TeamRoomId })]);
export type TeamSeenInput = z.infer<typeof TeamSeenInput>;

/** `approve`: a task a knight proposed starts (a task only); `stop` declines one. */
export const TeamControlInput = z.strictObject({
  room: TeamRoomId.optional(),
  teammate: TeammateId.optional(),
  task: TeamTaskId.optional(),
  action: z.enum(["pause", "resume", "stop", "approve"]),
}).refine((input) => [input.room, input.teammate, input.task].filter(Boolean).length === 1, "choose exactly one room, knight or task")
  .refine((input) => input.action !== "approve" || Boolean(input.task), "only a task is approved");
export type TeamControlInput = z.infer<typeof TeamControlInput>;

/** Removing a worker, which is yours alone. A worker that has a VM is removed only together with it, and only
 * when you say so here: everything in its workspace goes with the VM. */
export const TeamRemoveInput = z.strictObject({ id: z.string().min(1).max(32), destroyWorkspace: z.boolean().optional() });
export type TeamRemoveInput = z.infer<typeof TeamRemoveInput>;

/** The VMs' notes store (Engram: docs/ROUNDTABLE.md): one switch for all of a node's knights, yours alone to turn, and
 * off until you do. Nothing else of the store is anyone's to set: its version is the image's, its place and its
 * tools are the code's, and a knight's project is its repository's name or its own handle. */
export const TeamEngramInput = z.strictObject({ on: z.boolean() });
export type TeamEngramInput = z.infer<typeof TeamEngramInput>;
/** Whether a pull request's failing checks go back to the knight whose work it was when no outcome gives them back (PLAN #29). */
export const TeamCiInput = z.strictObject({ on: z.boolean() });
/** Whether Galahad offers idle knights work from your backlog (on until you turn it off). */
export const TeamBacklogInput = z.strictObject({ on: z.boolean() });

/** What a knight's Workspace is told of the notes store: the node's switch, and whether this VM has the pinned binary. */
export interface TeamEngramStatus {
  on: boolean;
  /** The version the knights' image pins. */
  pinned: string;
  /** This VM has it, at that version. Absent: not asked (no running VM, or the knight is at work). */
  present?: boolean;
  /** When it hasn't: why, in words. */
  reason?: string;
}

export interface Teammate {
  id: string;
  name: string;
  instructions: string;
  role: string;
  /**
   * The models its own work runs on, in order, in place of its role's (absent: its role's): its conversations, its
   * tasks' work and its harness. A task's plan and its independent review stay the planner's and the reviewer's,
   * unless it is in sensitive mode.
   */
  models?: string[];
  /** Sensitive mode: every call of its work goes to its own models, and none elsewhere (heldModels). Absent: off. */
  sensitive?: boolean;
  harness: TeamHarness;
  /** The command that starts its ACP agent in its VM (harness `acp`); absent: none. */
  acp?: string;
  /** Keys of yours it may use but never see (TeamKeyGrant); absent: none. */
  keys?: TeamKeyGrant[];
  enabled: boolean;
  dailyTurns: number;
  turnsToday: number;
  repository: string | null;
  /** Host selected before provisioning; survives a crash before the VM id is bound. */
  workspaceNode: string | null;
  workspace: TeamWorkspace | null;
  memory: string;
  /** The colour you chose for its orb (v 2), or a look from before the orbs (v 1, which colours nothing); absent: none
   * chosen. Drawn with core's knightColors(id, avatar). */
  avatar?: AvatarProfile | OrbProfile;
  /** Who made this worker, and whose words its instructions are: TEAM_OWNER (you: also what an older
   * snapshot without them means), TEAM_GALAHAD (himself, in your conversation) or the worker that made it.
   * Instructions you save are yours from then on. */
  createdBy?: string;
  instructionsBy?: string;
  createdAt: number;
  updatedAt: number;
  /** When you removed it. A removed worker is in no list and does no work; its record is kept, so what it said
   * stays its own and its handle is never anyone else's. */
  removedAt?: number;
}

/** A model you may set a knight to work on (`GET /api/team/models`): its ref, and the nodes that serve it, when a local runtime does. */
export interface TeamModelChoice {
  ref: string;
  on: string[];
}

export interface TeamRoom {
  id: string;
  name: string;
  members: string[];
  direct: boolean;
  turnBudget: number;
  paused: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface TeamMessage {
  id: string;
  room: string;
  /** TEAM_OWNER, TEAM_GALAHAD or a worker's id. */
  speaker: string;
  speakerName: string;
  text: string;
  createdAt: number;
  chainId: string;
  /** The files a message of yours carried (absent: none). */
  attachments?: AttachmentRef[];
}

/** `proposed`: a task a knight wrote, waiting for your approval before it may run. */
export type TeamWorkStatus = "proposed" | "queued" | "running" | "done" | "failed" | "stopped" | "interrupted";

export interface TeamDelivery {
  id: string;
  room: string;
  teammate: string;
  trigger: string;
  chainId: string;
  status: TeamWorkStatus;
  error: string | null;
  createdAt: number;
  updatedAt: number;
}

/**
 * What a task's run came to, as the runner counted it (never the knight's own account): when the knight began on
 * it and when it ended, how its quest ended, its commands, how often the work was sent back, and its model calls by
 * role and model as the providers reported them (counts only). A coding harness's own calls, through the gateway
 * or on its own sign-in, are not in `spent` yet: with a harness it holds the planner's and the reviewer's.
 */
export const TeamTaskRecord = z.strictObject({
  startedAt: z.number().int().min(0),
  endedAt: z.number().int().min(0),
  ended: z.enum(["done", "unverified", "gave-up", "stopped"]),
  commands: z.number().int().min(0).max(1_000_000),
  revisions: z.number().int().min(0).max(1000),
  spent: SpendLines,
});
export type TeamTaskRecord = z.infer<typeof TeamTaskRecord>;

/**
 * What a task in a repository changed, kept on the node that hosts the knight's VM: the artifact that holds the
 * patch and the shipment (`galahad ship` turns it into a pull request, on your word), how many files, and the
 * commit the work began from.
 */
export const TeamTaskChanges = z.strictObject({
  artifact: z.string().regex(/^art_[A-Za-z0-9_-]{22}$/),
  files: z.number().int().min(1).max(1_000_000),
  base: z.string().regex(/^[0-9a-f]{40}$/),
});
export type TeamTaskChanges = z.infer<typeof TeamTaskChanges>;

export interface TeamTask {
  id: string;
  room: string;
  assignee: string;
  title: string;
  goal: string;
  dependsOn: string[];
  gates: string[];
  /** Its budget in US dollars at your prices (absent: none). */
  budgetUsd?: number;
  status: TeamWorkStatus;
  verified: boolean;
  progress: string;
  output: string;
  error: string | null;
  chainId: string;
  createdAt: number;
  updatedAt: number;
  /** What its run came to, once it has ended in the knight's hands (absent: not run yet, stopped before it began, or from before records were kept). */
  record?: TeamTaskRecord;
  /** What it changed in its repository, where that was kept (absent: no repository, nothing changed, or it could not be kept). */
  changes?: TeamTaskChanges;
  /** Who gave it to the Roundtable rather than to a knight by name (TEAM_OWNER or TEAM_GALAHAD); absent: given to a knight by name. */
  givenBy?: string;
  /** The knight that wrote it, in a conversation: it was proposed to you, and ran only once you approved it. Absent: you
   * or Galahad gave it. */
  proposedBy?: string;
  /** Each time you stepped in on it, by how (absent: never). */
  interventions?: Partial<Record<InterventionKind, number>>;
  /** The outcome it is a step of (PLAN #43); absent: none. */
  outcome?: string;
  /** Sensitive mode for this task alone: the models it is held to (heldModels); absent: its knight's, as its knight's mode says. */
  models?: string[];
  /** The step of another task it was started from (PLAN #15), with that step's commit and command; absent: its repository as it was fetched. */
  from?: TeamTaskFrom & { commit: string; command: string };
  /** The pull request whose failing checks it fixes (PLAN #29); absent: none. */
  fix?: TeamTaskFix;
  /** Its pull request, once you shipped its work from an app (PLAN #37; absent: not shipped that way). */
  shipped?: TeamTaskShipped;
}

/** Where a knight's verified work went as a pull request, on your word: its address, and its number. */
export interface TeamTaskShipped {
  url: string;
  pr: number | null;
}

/** A knight's verified work shipped as a pull request, on your word; `title` is the pull request's (the task's when absent). */
export const TeamShipInput = z.strictObject({ task: TeamTaskId, title: z.string().trim().min(1).max(120).optional() });

/**
 * A pull request a task fixes (PLAN #29, the node's ci-back.ts): its checks failed on `head`, so the knight whose work it
 * was starts on its branch, and its verified fix is offered to you as a push onto that branch (github.ship.update).
 */
export interface TeamTaskFix {
  /** The GitHub connector it was shipped through. */
  connector: string;
  owner: string;
  repo: string;
  branch: string;
  pr: number | null;
  /** The commit whose checks failed, or that the review was on. */
  head: string;
  /** The review it answers, by its id (absent: it fixes failing checks). */
  review?: number;
  /** The base commit its pull request conflicted with: it merges the base branch in and resolves the conflicts. */
  conflict?: string;
}

/** A path in a knight's workspace (its VM's /work): absolute, under /work, with no `.` or `..` in it. */
export const WorkPath = z
  .string()
  .max(1024)
  .regex(/^\/work(\/[^/\u0000]+)*\/?$/, "a path under /work")
  .refine((path) => !path.split("/").some((part) => part === "." || part === ".."), "a path with no . or .. in it");
/** A knight's workspace looked into (its VM's, or `galahad` for his computer): a folder, a file, or what a task changed. */
export const TeamFilesInput = z.strictObject({ id: z.string().min(1).max(32), path: WorkPath.default("/work") });
export const TeamFileInput = z.strictObject({ id: z.string().min(1).max(32), path: WorkPath });
export const TeamChangesInput = z
  .strictObject({
    id: z.string().min(1).max(32),
    task: TeamTaskId.optional(),
    /** The repository at this path instead (a project's checkout on his computer), changed since its last commit. */
    path: WorkPath.optional(),
  })
  .refine((input) => !(input.task && input.path), "a task or a path, not both");

export interface TeamFileEntry {
  name: string;
  kind: "dir" | "file" | "link" | "other";
  size: number;
  modified: number;
}
/** A folder of a knight's workspace: its entries, folders first (`more`: there were more than the first two thousand). */
export interface TeamFilesView {
  id: string;
  path: string;
  entries: TeamFileEntry[];
  more: boolean;
}
/**
 * One file of a knight's workspace: text (anything like a key redacted), a picture (base64), or what it is: `binary`, or
 * `large` (a picture too big to show here). `cut`: only its beginning is here.
 */
export interface TeamFileView {
  id: string;
  path: string;
  size: number;
  modified: number;
  kind: "text" | "image" | "binary" | "large";
  text?: string;
  data?: string;
  type?: string;
  redacted?: boolean;
  cut?: boolean;
}
export interface TeamChangedFile {
  path: string;
  /** git's letter: A added, M modified, D deleted, T type changed. */
  status: string;
  added: number | null;
  removed: number | null;
}
/** What a task changed in its repository: from the commit it started at (`base`), or HEAD with none; the diff redacted. */
export interface TeamChangesView {
  id: string;
  task: string | null;
  path: string | null;
  base: string | null;
  head: string | null;
  files: TeamChangedFile[];
  untracked: string[];
  diff: string;
  cut: boolean;
  redacted?: boolean;
}

/** One line of what a task did, as it happened: its number in order (from 1), when, and the line (redacted, cut if long). */
export interface TeamTrailEntry {
  n: number;
  at: number;
  text: string;
}

export interface TeamSnapshot {
  /** Interventions per completed task over the last thirty days (#28; absent from an older node). */
  northStar?: NorthStar;
  teammates: Teammate[];
  rooms: TeamRoom[];
  tasks: TeamTask[];
  deliveries: TeamDelivery[];
  /** Workers you removed: their handles stay taken, and their names stay beside what they said. `conversations`:
   * the direct conversations it had (yours with it first), kept to read though no longer among the rooms. */
  removed?: (Pick<Teammate, "id" | "name" | "removedAt"> & { conversations?: string[] })[];
  /** The notes store's switch, said only when it is on (absent: off, which is also what a node from before it says). */
  engram?: boolean;
  /** Failing checks go back to the knight whose work it was, outside an outcome too (PLAN #29): said only when on. */
  ciBack?: boolean;
  /** Galahad offers idle knights work from your backlog, a proposal each that waits for you (on unless you turned it off). */
  backlog?: boolean;
  /** Galahad's own computer, when he has one: his persistent VM, made and watched as a knight's is (under his handle). */
  computer?: TeamWorkspace;
  /** Your order of the knights (`teammates` comes in it already; absent from an older node). */
  order?: string[];
  /** Who leads the Roundtable: `galahad`, or the knight you chose (absent from an older node: Galahad). */
  primary?: string;
  /** When you last looked, on any device, at each knight's page (`knight:<id>`) and each room (`room:<id>`): what ended
   * there after it is new to you, as an email is unread (absent from an older node, which keeps no such thing). */
  seen?: Record<string, number>;
}

export interface TeamRoomView extends TeamRoom {
  messages: TeamMessage[];
  tasks: TeamTask[];
  deliveries: TeamDelivery[];
}

/** His workers as Galahad himself reads them: who each is, what it is for and what it is doing. Never their
 * working notes; a room's words only when he asks for that room. */
export interface TeamOverview {
  workers: {
    id: string;
    name: string;
    role: string;
    harness: TeamHarness;
    job: string;
    madeBy: string;
    state: "working" | "queued" | "ready" | "paused" | "allowance spent";
    turnsToday: number;
    dailyTurns: number;
    repository: string | null;
    workspace: boolean;
  }[];
  rooms: Pick<TeamRoom, "id" | "name" | "members" | "direct" | "paused" | "turnBudget">[];
  room?: Pick<TeamRoom, "id" | "name" | "members" | "direct" | "paused"> & {
    messages: Pick<TeamMessage, "speaker" | "speakerName" | "text" | "createdAt">[];
    tasks: Pick<TeamTask, "id" | "title" | "assignee" | "status" | "verified">[];
  };
  /** How many more workers he may make: on this node in all, and today. */
  spare: { workers: number; today: number };
}
