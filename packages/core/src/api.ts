import { z } from "zod";
import { ATTACHMENT_LIMITS } from "./attachments.ts";
import { AttachmentId, AttachmentName, AttachmentRef, AttachmentType } from "./attachment-ref.ts";
export { AttachmentId, AttachmentName, AttachmentRef, AttachmentType };
import { AgentLabel, ConnectorArgs, ToolName } from "./connectors.ts";
import { MCP_AUTHS, MCP_CATEGORIES, type McpCategory, type McpIndexEntry } from "./mcp-index.ts";
import { ActionId, ArtifactId, ConnectorId, LoopName, LoopStatus, NoticeKey, NoticeSeverity, SCREEN_SESSION_MAX_MINUTES, ScreenSessionId, THINKING_EFFORTS } from "./events.ts";
import { Conclusion, InvestigationId, InvestigationStatus, PredictionOutcome, Preregistration } from "./investigations.ts";
import { MAX_ORDER_DAYS, OrderId, OrderPattern } from "./orders.ts";
import { QampGrantInput, QampRevokeInput } from "./qamp.ts";
import { RuleInput, RuleName, RuleToldInput, RuleTrippedInput } from "./rules.ts";
import { type Scope, Scope as ScopeSchema } from "./scopes.ts";
import { TrialRecord, TrialRunId, type TrialRunSettings } from "./trials.ts";
import { HarnessOptions, TrialPins, VariantName } from "./trials.ts";
import type { Usage } from "./spend.ts";
import { PricedModel, PriceSchema, SpendLines, type TrialSpent, UsageBudgetInput } from "./usage.ts";
import { type ComputeUsage, EffortAsk, EffortLevel } from "./compute.ts";
import { DecisionRequest } from "./decisions.ts";
import { BankBalancesInput, BankCompleteInput, BankTransactionsInput } from "./bank.ts";
import { CancelLookInput, ConversationId, LookLaterInput, ProjectBranchInput, ProjectCommitInput, ProjectGitInput, ProjectId, ProjectInput } from "./chats.ts";
import { TeammateId, TeammateInput, TeamArrangeInput, TeamBacklogInput, TeamChangesInput, TeamCiInput, TeamEngramInput, TeamShipInput, TeamFileInput, TeamFilesInput, TeamRecruitInput, TeamRemoveInput, TeamRoomId, TeamRoomInput, TeamPostInput, TeamSayInput, TeamSeenInput, TeamTaskId, TeamTaskInput, TeamGiveInput, TeamControlInput, TeamOutcomeControlInput, TeamOutcomeInput, TeamWorkspaceQuest, TeammateModels } from "./team.ts";
import { QuestGates, QuestProgressInput } from "./quests.ts";
import { type StopReason, TURN_ID } from "./turns.ts";
import { type ArchiveContextEntry, ArchiveBudgetInput, ArchiveDeleteInput, ArchiveId, ArchiveReindexInput, ArchiveSearchInput, NoteIdeaInput } from "./archive.ts";
import { QuestEvidenceInput, SkillApproveInput, SkillId, SkillLockInput, SkillRetireInput, SkillsBudgetInput, SkillWriteInput } from "./skills-input.ts";
import { QUESTION_ID, QUESTION_LIMITS } from "./questions.ts";
import { ApplePushInput, ApplePushKeyInput, NotifyDeviceRef, NotifyPrefsInput, PushSubscriptionInput } from "./notify-input.ts";

/*
 * The node HTTP API contract, shared by the daemon, the CLI and the PWA.
 * Each route declares exactly one scope; the server validates input with the
 * schema below before any handler runs. Transports stay thin.
 */

const Name = z.string().min(1).max(128).regex(/^[A-Za-z0-9._:-]+$/);

/**
 * Gateway scopes that aren't model providers. The node gives them itself, on its own typed
 * paths: `search` through a sandbox's search flag, `git:<connector>:<owner>:<repo>` in a token
 * minted through gateway:mint. Never a provider's id, so nobody can ask for one by name.
 * `world` is retired (the SANDBOX it served was removed on 14 November 2026): tokens and sandboxes
 * from before still carry it, so it stays reserved and no provider is ever reached under that name.
 */
export const isReservedGatewayScope = (name: string): boolean => name === "search" || name === "world" || name.startsWith("git:");

/** A model provider's id: a name that isn't one of the gateway's own scopes. */
export const ProviderId = Name.refine((name) => !isReservedGatewayScope(name), {
  message: "search, world and git:… are Galahad's own gateway scopes, not model providers",
});

const ModelRef = z.string().min(3).max(256);

/** A tool the caller runs itself (a quest's engineer: its shell, its files), offered to the model by name. */
export const ClientToolName = z.string().regex(/^[a-z][a-z0-9_]{0,40}$/, "a tool's name: lower case, digits and _");
/** A call the model made to one of the caller's own tools (clientTools): its id, the tool, its input as the model gave it. */
export const ClientCall = z.strictObject({ id: z.string().min(1).max(128), name: ClientToolName, input: z.record(z.string(), z.unknown()) });
export type ClientCall = z.infer<typeof ClientCall>;
/** What one such call came to, as the caller ran it. */
export const ClientResult = z.strictObject({ id: z.string().min(1).max(128), content: z.string().max(200_000), error: z.boolean().optional() });
export type ClientResult = z.infer<typeof ClientResult>;

export const ChatMessage = z
  .strictObject({
    role: z.enum(["user", "assistant"]),
    /** Its words: none only for a message of yours that carries attachments, an answer that only calls tools, or results. */
    content: z.string().max(400_000),
    /** Your files with it, kept on the node (uploadAttachment). An answer carries none. */
    attachments: z.array(AttachmentRef).min(1).max(ATTACHMENT_LIMITS.perMessage).optional(),
    /**
     * How hard the model thinks from this message on: a quest's loop says it for each turn by what the turn is (brain
     * roster.ts STEP_EFFORT), and a role you pinned (setRosterEffort) thinks at your level instead. Absent: the role's.
     */
    effort: z.enum(THINKING_EFFORTS).optional(),
    /** An answer's calls to the caller's own tools (clientTools), as the model made them: the caller ran them. */
    calls: z.array(ClientCall).min(1).max(32).optional(),
    /**
     * What a provider needs back with an answer that called tools for the work to go on (a model's reasoning, its
     * thinking and their signatures), as the chat route gave it: opaque to the caller, and only ever given back to the
     * provider and model it came from.
     */
    carry: z.string().max(400_000).optional(),
    /** What the calls of the answer before it came to, in their order (a message of the caller's). */
    results: z.array(ClientResult).min(1).max(32).optional(),
  })
  .refine((m) => m.content.length > 0 || (m.role === "user" && (!!m.attachments || !!m.results)) || (m.role === "assistant" && !!m.calls), "a message has words, or files, calls or results it carries")
  .refine((m) => m.role === "user" || !m.attachments, "only your messages carry files")
  .refine((m) => m.role === "assistant" || (!m.calls && m.carry === undefined), "only an answer calls tools")
  .refine((m) => m.role === "user" || !m.results, "only the caller's messages carry results");
export type ChatMessage = z.infer<typeof ChatMessage>;

export const PlacementNeeds = z.strictObject({
  docker: z.boolean().optional(),
  vm: z.boolean().optional(),
  gpu: z.boolean().optional(),
  minMemoryGb: z.number().min(0).max(4096).optional(),
  tools: z.array(z.string().max(64)).max(32).optional(),
  localModels: z.boolean().optional(),
  longRunning: z.boolean().optional(),
  interactive: z.boolean().optional(),
  untrusted: z.boolean().optional(),
  prefer: z.string().optional(),
});
export type PlacementNeeds = z.infer<typeof PlacementNeeds>;

/** A turn the node is running, by its id; a message of yours to steer or queue; a queued message's id. */
const TurnId = z.string().regex(TURN_ID);
const QueuedText = z.string().trim().min(1).max(100_000);
const QueuedId = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);
const AsideId = z.string().regex(/^as_[A-Za-z0-9_-]{22}$/);

/** A node, by name or device id. */
const NodeRef = z.string().min(1).max(100).regex(/^[A-Za-z0-9._:-]+$/);
const SandboxId = z.string().regex(/^[a-f0-9]{10}$/);

/** A terminal open on a node, and a terminal's size in characters. */
export const TERMINAL_ID = /^tm_[A-Za-z0-9_-]{16}$/;
const TerminalId = z.string().regex(TERMINAL_ID);
const TerminalSize = z.strictObject({ cols: z.number().int().min(10).max(500), rows: z.number().int().min(4).max(200) });

/**
 * One of several attempts at the same quest (effort): the node shows where each is, and counts
 * nothing by it. Its quest must be one an effort was granted for; otherwise it's ignored.
 */
export const AttemptTag = z.strictObject({
  quest: z.string().regex(/^[A-Za-z0-9._:-]{1,64}$/),
  index: z.number().int().min(1).max(8),
  of: z.number().int().min(1).max(8),
});
export type AttemptTag = z.infer<typeof AttemptTag>;

export const SandboxNetwork = z.enum(["isolated", "gateway", "online"]);
export type SandboxNetwork = z.infer<typeof SandboxNetwork>;

export const SandboxRequest = z.strictObject({
  /** isolated = no network · gateway = models only (default) · online = internet + models */
  network: SandboxNetwork.default("gateway"),
  image: z
    .string()
    .max(200)
    .regex(/^[a-z0-9][a-z0-9._/:@-]*$/)
    .optional(),
  cpus: z.number().min(0.25).max(64).default(4),
  memoryGb: z.number().min(0.25).max(512).default(8),
  ttlMinutes: z.number().int().min(1).max(7 * 24 * 60).default(120),
  /** Model providers the sandbox may call through the gateway (scoped token; never the key). The node refuses one it doesn't have. */
  providers: z.array(ProviderId).max(16).optional(),
  /** Persistent sandboxes are not cleaned up automatically; destroying one asks first. */
  persistent: z.boolean().default(false),
  quest: z.string().max(64).regex(/^[A-Za-z0-9._:-]+$/).optional(),
  /** The workspace's size limit in GB (default 20). /work can't grow past it. */
  diskGb: z.number().int().min(1).max(2048).optional(),
  /**
   * container: a hardened container on the host's kernel. vm: the same container inside its own
   * KVM microVM with its own kernel (Kata), for code there's no reason to trust. Default: vm for
   * online sandboxes where the host has microVMs, container otherwise.
   */
  isolation: z.enum(["container", "vm"]).optional(),
  /** The Lab image: mathematics, physics and engineering (FEniCSx, OpenFOAM, OpenCascade, MuJoCo, JSBSim, RocketPy, ngspice, …). */
  lab: z.boolean().optional(),
  /** The Gazebo image: robotics simulation (gz-sim 8, headless, DART physics). */
  gazebo: z.boolean().optional(),
  /** The desktop image: the workshop with a display, a window manager and a browser (`desktop help` inside it). */
  desktop: z.boolean().optional(),
  /** Web search through the gateway (the node's own SearXNG), even without the internet: `websearch <words>`. */
  search: z.boolean().optional(),
});
export type SandboxRequest = z.input<typeof SandboxRequest>;

/** What a loop does each time it runs. */
export const LoopTask = z.discriminatedUnion("kind", [
  /**
   * Look around: fleet and body checks, notices in your inbox; optionally a checklist a model reads. After
   * it, Galahad fixes what's on the self-action allowlist himself (self-action.ts) unless `selfAction` is false.
   */
  z.strictObject({ kind: z.literal("heartbeat"), checklist: z.string().max(4000).optional(), selfAction: z.boolean().optional() }),
  /** A quest in a fresh sandbox: plan, work, independent review, remembered. */
  z.strictObject({
    kind: z.literal("quest"),
    goal: z.string().min(1).max(4000),
    network: SandboxNetwork,
    maxSteps: z.number().int().min(1).max(100).optional(),
    /** Gates (quests.ts): each must exit 0 in the quest's sandbox before the reviewer is asked. */
    gates: QuestGates.optional(),
  }),
  /** One connector tool; outward and delete tools file an approval request instead. */
  z.strictObject({ kind: z.literal("call"), connector: ConnectorId, tool: ToolName, args: ConnectorArgs.optional() }),
  /**
   * Tell you (PLAN #37): a notice in your Inbox each run, with what woke it, and on your phone your loop's name. No
   * model, no sandbox: "tell me when my boss emails", or a reminder on a schedule. `text`: what to say, in your words.
   */
  z.strictObject({ kind: z.literal("tell"), text: z.string().trim().min(1).max(200).optional() }),
  /**
   * Copy bilag to Google Drive (the owner's word, 18 November 2026): each receipt or invoice attached to the mail that
   * woke it (its mail wakes), as it is, into <folder>/<year>/<month> (Bilag unless you name another). No model: the
   * node's own work (node bilag.ts), each copy a line in the ledger, nothing deleted or sent.
   */
  z.strictObject({ kind: z.literal("bilag"), folder: z.string().trim().min(1).max(60).regex(/^[^/\\\u0000-\u001f]+$/, "a folder's name, without slashes").optional() }),
]);
export type LoopTask = z.infer<typeof LoopTask>;

/** Copying the bilag of mail a search finds (bilagCopy): which mailbox, its search words (receipts' and invoices' by default), a batch's size, where the last batch left off. */
export const BilagCopyInput = z.strictObject({
  from: z.enum(["gmail", "outlook"]),
  query: z.string().trim().min(1).max(500).optional(),
  limit: z.number().int().min(1).max(100).optional(),
  page: z.string().min(1).max(2000).optional(),
  folder: z.string().trim().min(1).max(60).regex(/^[^/\\\u0000-\u001f]+$/, "a folder's name, without slashes").optional(),
});
export type BilagCopyInput = z.infer<typeof BilagCopyInput>;

/** A bilag from your Drive into Dinero, to the card of the payment it documents (docs/BOOKS.md). */
export const BooksAttachInput = z
  .strictObject({
    organizationId: z.number().int().positive(),
    /** The voucher file card: a payment booked without its bilag (list_voucher_file_cards). */
    card: z.string().uuid(),
    /** The bilag's id in Drive, to put into Dinero's archive first; or dineroFile, a file already there. */
    file: z.string().regex(/^[A-Za-z0-9_-]{10,100}$/).optional(),
    dineroFile: z.string().regex(/^[A-Za-z0-9_-]{8,64}$/).optional(),
    /** Why this bilag is this payment's: your approval card says it. */
    why: z.string().trim().min(1).max(500),
  })
  .refine((input) => !input.file !== !input.dineroFile, "give the bilag's Drive file, or a file already in Dinero's archive: one of them");
export type BooksAttachInput = z.infer<typeof BooksAttachInput>;

/** A bilag from your Drive into Dinero's archive alone, for a voucher drafted with it (docs/BOOKS.md). */
export const BooksUploadInput = z.strictObject({
  organizationId: z.number().int().positive(),
  file: z.string().regex(/^[A-Za-z0-9_-]{10,100}$/),
});

/** What wakes a loop on GitHub: a workflow run that failed, a push to the repository, a new issue or a new pull request. */
export const GITHUB_WAKE_EVENTS = ["ci.failed", "pushed", "issue.opened", "pr.opened"] as const;
const GITHUB_WAKE_WORDS: Record<(typeof GITHUB_WAKE_EVENTS)[number], string> = { "ci.failed": "a failed CI run", pushed: "a push", "issue.opened": "a new issue", "pr.opened": "a new pull request" };
const GitHubName = z.string().regex(/^[A-Za-z0-9_.-]{1,100}$/);

/**
 * What else wakes a loop, besides its schedule (PLAN #13). Whatever woke it reaches the run as outside data, never as
 * instructions; a burst within the loop's cooldown wakes it once, with all of it. Only what happens from the moment a
 * wake is set counts: the mail already in your inbox, and the runs GitHub already has, never wake it.
 */
export const LoopWake = z.discriminatedUnion("kind", [
  /** A POST to the node's /hooks/<loop>, signed with the loop's own secret: HMAC-SHA256 of the body, as GitHub signs. */
  z.strictObject({ kind: z.literal("webhook") }),
  /** New mail in your Gmail or Outlook that a search finds (Gmail's search words, or Outlook's), read every few minutes. */
  z.strictObject({ kind: z.literal("mail"), connector: z.enum(["gmail", "outlook"]), query: z.string().trim().min(1).max(200).optional() }),
  /** A GitHub repository, read every few minutes: a workflow run that failed (on one branch, if named), a push, a new issue or pull request. */
  z.strictObject({
    kind: z.literal("github"),
    owner: GitHubName,
    repo: GitHubName,
    on: z.array(z.enum(GITHUB_WAKE_EVENTS)).min(1).max(GITHUB_WAKE_EVENTS.length),
    branch: z.string().regex(/^[A-Za-z0-9._/-]{1,200}$/).optional(),
  }),
]);
export type LoopWake = z.infer<typeof LoopWake>;

/** A wake in a few words, the same on every surface. */
export function describeWake(wake: LoopWake): string {
  switch (wake.kind) {
    case "webhook":
      return "a webhook";
    case "mail":
      return `new ${wake.connector === "gmail" ? "Gmail" : "Outlook"} mail${wake.query ? ` matching "${wake.query}"` : ""}`;
    case "github": {
      const what = wake.on.map((on) => (on === "ci.failed" && wake.branch ? `a failed CI run on ${wake.branch}` : GITHUB_WAKE_WORDS[on]));
      return `${what.join(" or ")} in ${wake.owner}/${wake.repo}`;
    }
  }
}

export const MAX_LOOP_WAKES = 4;
/** A burst within this wakes a loop once (unless the loop says otherwise). */
export const DEFAULT_WAKE_COOLDOWN_MS = 10 * 60_000;
export const LoopWakes = z.array(LoopWake).max(MAX_LOOP_WAKES);
export const WakeCooldownMs = z.number().int().min(60_000).max(24 * 3600_000);

/**
 * A loop Galahad drafted because you asked for one in chat ("every weekday at 8, check my open PRs"). It is only a
 * draft: it waits in your Inbox, and becomes a loop only when you add it (setLoop with its `draft`), as you'd add one
 * yourself. Kept on the node it was drafted on, never in the mind's log; a week unanswered and it's gone.
 */
export const LoopDraftId = z.string().regex(/^ld_[A-Za-z0-9_-]{22}$/);
export const LoopDraftInput = z.strictObject({
  name: LoopName,
  schedule: z.string().min(1).max(128),
  tz: z.string().max(64).optional(),
  on: NodeRef.optional(),
  task: LoopTask,
  /** What else wakes it ("never" as the schedule: only these). */
  wakes: LoopWakes.optional(),
  cooldownMs: WakeCooldownMs.optional(),
  label: z.string().max(128).optional(),
  /** What you asked for, in his words: shown with the draft. */
  why: z.string().max(500).optional(),
});

/**
 * A connector an agent asked you for (Galahad, a knight, an agent over MCP): one Galahad ships that isn't installed, or
 * a service he doesn't have at all. Like a key's request it waits in your Inbox, and in the chat it was asked in, with
 * who asked and what for; it never installs anything, and it goes once that connector is installed or you dismiss it.
 * Kept on the node it was asked on, never in the mind's log; a week unanswered and it's gone.
 */
export const ConnectorRequestId = z.string().regex(/^cr_[A-Za-z0-9_-]{22}$/);
export const ConnectorRequestInput = z.strictObject({
  connector: ConnectorId,
  /** What it's for, in a line: shown with the request. */
  why: z.string().min(1).max(500),
});

/**
 * Kinds of task this version no longer has, and what each was. A fleet's mind may still hold a loop with one:
 * it never runs, and every surface that lists it says its task no longer exists (loops.ts' loopRecords).
 */
export const RETIRED_LOOP_TASKS: Readonly<Record<string, string>> = {
  review: "his review of the 3D world, removed with it on 14 November 2026",
  reflect: "his journal, removed on 14 November 2026; what he wrote is still in his memory",
};

/** A place on a knight's screen, in its pixels. */
const ScreenPx = z.number().int().min(0).max(10_000);
/** One thing done on a knight's desktop from outside its VM (`look`: nothing, only the picture). */
export const DesktopAction = z.discriminatedUnion("do", [
  z.strictObject({ do: z.literal("look") }),
  z.strictObject({ do: z.literal("click"), x: ScreenPx, y: ScreenPx, button: z.enum(["left", "right", "middle", "double"]).optional() }),
  z.strictObject({ do: z.literal("move"), x: ScreenPx, y: ScreenPx }),
  z.strictObject({ do: z.literal("scroll"), direction: z.enum(["up", "down"]), times: z.number().int().min(1).max(50).optional() }),
  z.strictObject({ do: z.literal("type"), text: z.string().min(1).max(2000) }),
  z.strictObject({ do: z.literal("key"), keys: z.array(z.string().regex(/^[A-Za-z0-9_+]{1,40}$/)).min(1).max(8) }),
  z.strictObject({ do: z.literal("open"), address: z.string().max(2000).regex(/^(https?:\/\/|file:\/\/|about:)/) }),
]);
export type DesktopAction = z.infer<typeof DesktopAction>;

/** An app on a Mac, by its name (`Safari`, `Xcode`) or bundle id (`com.apple.Safari`). */
const AppName = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9 ._-]{0,79}$/);
/**
 * One thing done on a Mac's own screen (docs/MAC.md, the Mac itself): a knight's desktop's actions, in its words and
 * places (its xdotool key names, a turn of the wheel), and an app opened by its name. A place is in the screen's points.
 */
export const ScreenAction = z.discriminatedUnion("do", [...DesktopAction.options, z.strictObject({ do: z.literal("app"), name: AppName })]);
export type ScreenAction = z.infer<typeof ScreenAction>;

/**
 * One thing Galahad does on a Mac itself, in a session you allowed: a thing done on its screen, or a shell command run
 * as its user in its home (`run`, held to your tripwires).
 */
export const ScreenUseAction = z.discriminatedUnion("do", [
  ...ScreenAction.options,
  z.strictObject({ do: z.literal("run"), command: z.string().min(1).max(100_000), timeoutSec: z.number().int().min(1).max(900).optional() }),
]);
export type ScreenUseAction = z.infer<typeof ScreenUseAction>;

/** What one thing he did on a Mac itself came to: a picture of its screen after it, or what a command printed. */
export interface ScreenUse {
  node: string;
  nodeName: string;
  session: string;
  view?: ScreenView;
  front?: string;
  ran?: ExecResult;
}

/** A Mac's own screen, as the node that has it says: its size in points, and whether macOS lets Galahad record it and control it. */
export interface ScreenStatus {
  node: string;
  width: number;
  height: number;
  record: boolean;
  control: boolean;
  /** The app in front, and its window's title where macOS lets Galahad read it. */
  front: string;
  /** The app in front's bundle id. */
  frontId?: string;
  /** A question of macOS's on the screen (a permission's consent, a password), by the process showing it; null: none. */
  asking?: string | null;
}

/** A picture of a screen, as a knight's desktop and a Mac's own give it: JPEG, at the screen's size. */
export interface ScreenView {
  shot: { mediaType: "image/jpeg"; data: string };
  width: number;
  height: number;
}

export const routes = {
  team: { method: "GET", path: "/api/team", scope: "chat", input: null },
  saveTeammate: { method: "POST", path: "/api/team/teammates", scope: "fleet:admin", input: TeammateInput },
  /** The models you may set a knight to work on: the roster's, then each local model a node of the fleet serves, and where. */
  teamModels: { method: "GET", path: "/api/team/models", scope: "mind:read", input: null },
  saveTeamRoom: { method: "POST", path: "/api/team/rooms", scope: "fleet:admin", input: TeamRoomInput },
  /** Yours alone: the knights' order, and who leads the Roundtable. */
  arrangeTeam: { method: "POST", path: "/api/team/arrange", scope: "fleet:admin", input: TeamArrangeInput },
  directTeammate: { method: "POST", path: "/api/team/direct", scope: "fleet:admin", input: z.strictObject({ id: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,31}$/) }) },
  teamRoom: { method: "POST", path: "/api/team/room", scope: "chat", input: z.strictObject({ id: z.string().min(1).max(80) }) },
  /** What a task did, as it happened: its kept lines after number `after`, a page at a time, with the task's status now. Yours to read, like a room. */
  teamTrail: { method: "POST", path: "/api/team/trail", scope: "chat", input: z.strictObject({ task: TeamTaskId, after: z.number().int().min(0).max(10_000_000).optional() }) },
  /** The steps of a task that another can be started from (PLAN #15): `{ steps: TeamCheckpoint[] }`, the first first. */
  teamSteps: { method: "POST", path: "/api/team/steps", scope: "chat", input: z.strictObject({ task: TeamTaskId }) },
  /** How often a knight's scripts used each key of yours it was given, through the key gateway, in the last thirty days (PLAN #17). */
  teamKeyUses: { method: "POST", path: "/api/team/key-uses", scope: "chat", input: z.strictObject({ id: TeammateId }) },
  /** You have looked at a knight's page or a room, on whichever device: what ended there so far is no longer new (`team`'s `seen`). */
  seeTeam: { method: "POST", path: "/api/team/seen", scope: "chat", input: TeamSeenInput },
  postTeamMessage: { method: "POST", path: "/api/team/messages", scope: "fleet:admin", input: TeamPostInput },
  createTeamTask: { method: "POST", path: "/api/team/tasks", scope: "fleet:admin", input: TeamTaskInput },
  /** Outcomes Galahad owns (PLAN #43): each with its room, budget and spend, its tasks and his plan. */
  teamOutcomes: { method: "GET", path: "/api/team/outcomes", scope: "chat", input: null },
  /**
   * Give him an outcome to own: its room is made with the knights you named, and he gives them tasks on his own within
   * its budget (your ruling of 18 November). Yours alone, as giving work is.
   */
  setTeamOutcome: { method: "POST", path: "/api/team/outcomes", scope: "fleet:admin", input: TeamOutcomeInput },
  controlTeamOutcome: { method: "POST", path: "/api/team/outcomes/control", scope: "fleet:admin", input: TeamOutcomeControlInput },
  /** Galahad takes on an outcome you asked him to own, in your conversation (his team_outcome; leads the team, as giveToTeam). */
  galahadOutcome: { method: "POST", path: "/api/team/galahad-outcome", scope: "mind:write", input: TeamOutcomeInput },
  /** A task given to the Roundtable: the knight best suited to it takes it, and the answer says who and why (everyone considered, each with its reasons). */
  giveTeamTask: { method: "POST", path: "/api/team/give", scope: "fleet:admin", input: TeamGiveInput },
  controlTeam: { method: "POST", path: "/api/team/control", scope: "fleet:admin", input: TeamControlInput },
  /** Yours alone, and for good. A worker with a VM goes only with `destroyWorkspace`, from a device that also holds `sandbox`. */
  removeTeammate: { method: "POST", path: "/api/team/remove", scope: "fleet:admin", input: TeamRemoveInput },
  teamMemory: { method: "POST", path: "/api/team/memory", scope: "fleet:admin", input: z.strictObject({ id: z.string().min(1).max(32), text: z.string().max(20000) }) },
  /** The VMs' notes store (Engram) for this node's knights: on or off, and yours alone to say. `team` says when it is on; a knight's `teamWorkspace` says whether its VM has it. */
  teamEngram: { method: "POST", path: "/api/team/engram", scope: "fleet:admin", input: TeamEngramInput },
  /** Whether a pull request's failing checks go back to the knight whose work it was, outside an outcome too (PLAN #29): yours alone to say. `team` says when it is on. */
  teamCi: { method: "POST", path: "/api/team/ci", scope: "fleet:admin", input: TeamCiInput },
  /** Whether Galahad offers idle knights work from your backlog: one task a day at most for each, waiting for your approval. */
  teamBacklog: { method: "POST", path: "/api/team/backlog", scope: "fleet:admin", input: TeamBacklogInput },
  /** A knight's verified work as a pull request, on your word (PLAN #37): filed as its knight's ship and answered by you at once, so the outbox (and the CI watcher) has it. */
  shipTeamTask: { method: "POST", path: "/api/team/ship", scope: "fleet:admin", input: TeamShipInput },
  /* Galahad's own way to the other knights, from your conversation with him (his tools: team, team_recruit, team_message).
   * Refused to everyone else whatever their scopes, you included: the routes above are yours. */
  teamOverview: { method: "POST", path: "/api/team/overview", scope: "mind:read", input: z.strictObject({ room: TeamRoomId.optional() }) },
  recruitTeammate: { method: "POST", path: "/api/team/recruit", scope: "mind:write", input: TeamRecruitInput },
  sayToTeam: { method: "POST", path: "/api/team/say", scope: "mind:write", input: TeamSayInput },
  /** His work for the Roundtable: the knight best suited to it takes it, as when you give one; within his allowance for the day. */
  giveToTeam: { method: "POST", path: "/api/team/galahad-give", scope: "mind:write", input: TeamGiveInput },
  teamWorkspace: { method: "POST", path: "/api/team/workspace", scope: "sandbox", input: z.strictObject({ id: z.string().min(1).max(32) }) },
  /** A folder of a knight's workspace (its VM's /work; `galahad`: his computer's), read; yours alone. */
  teamFiles: { method: "POST", path: "/api/team/files", scope: "sandbox", input: TeamFilesInput },
  /** One file of a knight's workspace, read: text with anything like a key redacted, a picture, or what it is. */
  teamFile: { method: "POST", path: "/api/team/file", scope: "sandbox", input: TeamFileInput },
  /** What a knight's task changed in its repository (its latest task with none named): the files and the diff. */
  teamChanges: { method: "POST", path: "/api/team/changes", scope: "sandbox", input: TeamChangesInput },
  provisionTeammate: {
    method: "POST", path: "/api/team/provision", scope: "fleet:admin",
    input: z.strictObject({
      id: z.string().min(1).max(32), on: NodeRef.optional(), cpus: z.number().min(0.25).max(64).default(1), memoryGb: z.number().min(0.25).max(512).default(2), diskGb: z.number().int().min(1).max(2048).default(20),
      /**
       * What the knight's VM can reach: `online` (the internet and the model gateway: the owner's word is that
       * knights can use the internet) or `gateway` (the model gateway and nothing else). Set when the VM is made:
       * a microVM's network can't be changed afterwards.
       */
      network: z.enum(["online", "gateway"]).default("online"),
      /** A desktop in its VM (a display, a window manager, a browser) for work that needs a screen. Set when the VM is made, or made again. */
      desktop: z.boolean().optional(),
    }),
  },
  /**
   * A knight's VM made again from its image as it is now, on your word: the same VM and `/work`, a new
   * container, so a fix to the image (or a newer tool in it) reaches a knight that was made before it. Its
   * network may be chosen again with it. Refused while the knight is working. Yours alone, like its removal.
   */
  remakeTeammate: {
    method: "POST", path: "/api/team/remake", scope: "fleet:admin",
    input: z.strictObject({ id: z.string().min(1).max(32), network: z.enum(["online", "gateway"]).optional(), /** With a desktop from now on (true), or without one (false); absent: as it is. */ desktop: z.boolean().optional() }),
  },
  /** The same, asked of the node that hosts the VM by the team's controller (never by a knight). */
  remakeTeamWorkspace: {
    method: "POST", path: "/api/team/remake-workspace", scope: "fleet:admin",
    input: z.strictObject({
      id: SandboxId, on: NodeRef.optional(), quest: TeamWorkspaceQuest, providers: z.array(z.string().min(1).max(64)).max(16), network: z.enum(["online", "gateway"]).optional(), desktop: z.boolean().optional(),
      /** The device whose word it was, when a node passes the request on to the VM's host. */
      onBehalfOf: z.string().max(100).optional(),
    }),
  },
  /**
   * A knight's VM made bigger while it runs, on your word: more threads, memory or disk, with nothing stopped and its
   * work kept (the microVM takes threads and memory as it runs; its workspace grows where it is mounted). What it adds
   * must fit this node's ceiling. Never smaller this way: a smaller size takes effect when the VM is made again.
   */
  resizeTeammate: {
    method: "POST", path: "/api/team/resize", scope: "fleet:admin",
    input: z
      .strictObject({ id: z.string().min(1).max(32), cpus: z.number().min(0.25).max(64).optional(), memoryGb: z.number().min(0.25).max(512).optional(), diskGb: z.number().int().min(1).max(4096).optional() })
      .refine((input) => input.cpus !== undefined || input.memoryGb !== undefined || input.diskGb !== undefined, "say what it should have: cpus, memoryGb or diskGb"),
  },
  /**
   * Galahad gives a knight's VM (or his own computer, id "galahad") more while it runs, himself, when its work needs it
   * (your ruling, 16 November 2026): only more, never past the ceiling, and the ledger says it was him and why. His alone,
   * from your conversation with him; you give a VM more with resizeTeammate.
   */
  growTeammate: {
    method: "POST", path: "/api/team/grow", scope: "sandbox",
    input: z
      .strictObject({ id: z.string().min(1).max(32), cpus: z.number().min(0.25).max(64).optional(), memoryGb: z.number().min(0.25).max(512).optional(), diskGb: z.number().int().min(1).max(4096).optional(), why: z.string().trim().min(3).max(300) })
      .refine((input) => input.cpus !== undefined || input.memoryGb !== undefined || input.diskGb !== undefined, "say what it should have: cpus, memoryGb or diskGb"),
  },
  /**
   * Galahad's own computer, worked on by him alone (his `computer` tool): one command in his VM, run as a knight's task
   * runs its own, with the model gateway, and his eyes when the roster names a model for them. Everyone else is refused.
   */
  computerExec: { method: "POST", path: "/api/team/computer", scope: "sandbox", input: z.strictObject({ command: z.string().min(1).max(100_000), timeoutSec: z.number().int().min(1).max(900).optional() }) },
  /** The same, asked of the node that hosts the VM by the team's controller (never by a knight). */
  resizeTeamWorkspace: {
    method: "POST", path: "/api/team/resize-workspace", scope: "fleet:admin",
    input: z.strictObject({
      id: SandboxId, on: NodeRef.optional(), quest: TeamWorkspaceQuest,
      cpus: z.number().min(0.25).max(64).optional(), memoryGb: z.number().min(0.25).max(512).optional(), diskGb: z.number().int().min(1).max(4096).optional(),
      /** The device whose word it was, when a node passes the request on to the VM's host. */
      onBehalfOf: z.string().max(100).optional(),
      /** When Galahad grew it himself (growTeammate): why, which the ledger keeps. */
      why: z.string().trim().min(3).max(300).optional(),
    }),
  },
  /**
   * A knight's desktop, for you to watch and to take over (to sign in for it, to get it past something): one
   * thing done there, or nothing (`look`), and a picture of the screen back. Yours alone. What you type is carried
   * to the VM and never written to the ledger.
   */
  teamDesktop: { method: "POST", path: "/api/team/desktop", scope: "sandbox", input: z.strictObject({ id: z.string().min(1).max(32), action: DesktopAction.default({ do: "look" }) }) },
  /** The same, asked of the node that hosts the VM by the team's controller. */
  teamDesktopOn: { method: "POST", path: "/api/team/desktop-workspace", scope: "sandbox", input: z.strictObject({ id: SandboxId, on: NodeRef.optional(), quest: TeamWorkspaceQuest, action: DesktopAction }) },
  /** A Mac's own screen (`on`: another node's): its size, and what macOS lets Galahad do with it. Yours alone. */
  screen: { method: "POST", path: "/api/screen", scope: "fleet:admin", input: z.strictObject({ on: NodeRef.optional() }) },
  /**
   * Shows macOS's own prompts on that Mac's screen, to let Galahad record it and control it (or lists the app in System
   * Settings for you to turn on): answered there, once, by you.
   */
  screenAllow: { method: "POST", path: "/api/screen/allow", scope: "fleet:admin", input: z.strictObject({ on: NodeRef.optional() }) },
  /**
   * A Mac's own screen, for you to watch and take over: one thing done there, or nothing (`look`), and a picture back.
   * Yours alone; what you type is carried to it and never written to the ledger.
   */
  screenDesktop: { method: "POST", path: "/api/screen/desktop", scope: "fleet:admin", input: z.strictObject({ on: NodeRef.optional(), action: ScreenAction.default({ do: "look" }) }) },
  /** Sessions on a Mac's own screen Galahad asked for, the newest first, each where it stands now (core's screen.ts). */
  screenSessions: { method: "GET", path: "/api/screen/sessions", scope: "mind:read", input: null },
  /**
   * Galahad asks to use a Mac itself for a while (`on`: which, where the fleet has more than one): his alone, in your
   * conversation with him. An approve card goes to your devices; nothing of that Mac is his until you allow it.
   */
  askScreen: {
    method: "POST", path: "/api/screen/ask", scope: "sandbox",
    input: z.strictObject({ on: NodeRef.optional(), why: z.string().trim().min(3).max(500), minutes: z.number().int().min(1).max(SCREEN_SESSION_MAX_MINUTES) }),
  },
  /** Your answer to his ask, yours alone: allowed (his for its minutes, from now) or not. */
  decideScreen: { method: "POST", path: "/api/screen/decide", scope: "fleet:admin", input: z.strictObject({ id: ScreenSessionId, allow: z.boolean() }) },
  /** A session over before its time: ended by you, or by him once he's done. */
  endScreen: { method: "POST", path: "/api/screen/end", scope: "chat", input: z.strictObject({ id: ScreenSessionId }) },
  /**
   * One thing Galahad does on a Mac itself (his alone, in a session you allowed: the Mac checks it from its own copy of
   * the log before anything is done), and a picture of its screen after it, or what a command printed.
   */
  screenUse: { method: "POST", path: "/api/screen/use", scope: "sandbox", input: z.strictObject({ on: NodeRef.optional(), action: ScreenUseAction }) },
  prepareTeamWorkspace: {
    method: "POST", path: "/api/team/prepare-workspace", scope: "fleet:admin",
    input: z.strictObject({
      id: SandboxId,
      on: NodeRef.optional(),
      quest: TeamWorkspaceQuest,
      repository: z.string().regex(/^https:\/\/github\.com\/[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}\/?$/).optional(),
      /** What the task's lease covers: the providers with a key now (absent: what the VM was made with). */
      providers: z.array(z.string().min(1).max(64)).max(16).optional(),
      /** Work in sensitive mode (heldModels): the lease is good for these models alone (absent: any of its providers'). */
      models: TeammateModels.min(1).optional(),
      /** The keys of yours its knight may use but never see (PLAN #17), as the key gateway reads them: key:<secret>:<header>:<read|write>. */
      keys: z.array(z.string().regex(/^key:[A-Za-z0-9._-]{1,64}:[a-z][a-z0-9-]{0,63}:(read|write)$/)).max(16).optional(),
    }),
  },
  /** A knight's lease kept while its task runs (its controller asks every ten minutes): `{ renewed }`. A lapsed one isn't brought back. */
  renewTeamWorkspace: {
    method: "POST", path: "/api/team/renew-workspace", scope: "fleet:admin",
    input: z.strictObject({ id: SandboxId, on: NodeRef.optional(), quest: TeamWorkspaceQuest }),
  },
  whoami: { method: "GET", path: "/api/whoami", scope: null, input: null },
  /**
   * What changed, as it changes (core's live.ts): one answer that stays open, server-sent events naming the routes whose
   * answers changed, never what they hold, each only to a device that holds that route's scope. Your devices' alone; it
   * ends when the device is revoked or its scopes change, and when the node stops.
   */
  live: { method: "GET", path: "/api/live", scope: "mind:read", input: null },
  fleet: { method: "GET", path: "/api/fleet", scope: "mind:read", input: null },
  recall: {
    method: "POST",
    path: "/api/memories/search",
    scope: "mind:read",
    input: z.strictObject({ q: z.string().max(1000).optional(), limit: z.number().int().min(1).max(200).optional() }),
  },
  remember: {
    method: "POST",
    path: "/api/memories",
    scope: "mind:write",
    input: z.strictObject({
      text: z.string().min(1).max(20_000),
      tags: z.array(z.string().min(1).max(64)).max(32).optional(),
      /** Set when the content came from the web, a file or someone else: it stays data, never instructions. */
      untrusted: z.boolean().optional(),
    }),
  },
  forget: { method: "POST", path: "/api/memories/forget", scope: "mind:write", input: z.strictObject({ id: z.string() }) },
  /**
   * What he knows of you (ABOUT_YOU_TAG): the facts you kept, which go with every answer of his, and the ones he
   * proposed, which wait for you. Yours to read from any device that may read the mind.
   */
  aboutYou: { method: "GET", path: "/api/about-you", scope: "mind:read", input: null },
  /** Keep a fact he proposed (or reword one you kept): yours alone, never an agent's. It goes with his answers from then on. */
  keepAboutYou: {
    method: "POST",
    path: "/api/about-you/keep",
    scope: "mind:write",
    input: z.strictObject({ id: z.string().min(1).max(100), text: z.string().trim().min(1).max(2000).optional() }),
  },
  secrets: { method: "GET", path: "/api/secrets", scope: "vault:read", input: null },
  setSecret: {
    method: "POST",
    path: "/api/secrets",
    scope: "vault:write",
    input: z.strictObject({
      name: Name,
      value: z.string().min(1).max(16_384),
      provider: Name.optional(),
      label: z.string().max(128).optional(),
      /** Where this key may be sent (entered with the key). Defaults to the provider's built-in preset. */
      baseUrl: z.string().url().max(512).optional(),
      /** The key is for this connector: it is pinned to the connector's origin. */
      connector: ConnectorId.optional(),
    }),
  },
  deleteSecret: { method: "POST", path: "/api/secrets/delete", scope: "vault:write", input: z.strictObject({ name: Name }) },
  secretRequests: { method: "GET", path: "/api/secret-requests", scope: "vault:read", input: null },
  requestSecret: {
    method: "POST",
    path: "/api/secret-requests",
    scope: "mind:write",
    input: z.strictObject({ name: Name, provider: Name.optional(), purpose: z.string().min(1).max(500) }),
  },
  /** A key he asked for that no longer matters (or that you won't give): out of your Inbox until he asks again. Yours: the
   * scope that fills a request, which agents never hold. */
  dismissSecretRequest: { method: "POST", path: "/api/secret-requests/dismiss", scope: "vault:write", input: z.strictObject({ name: Name }) },
  rotateVault: {
    method: "POST",
    path: "/api/vault/rotate",
    scope: "vault:write",
    input: z.strictObject({ reason: z.string().max(200).optional() }),
  },
  providers: { method: "GET", path: "/api/providers", scope: "mind:read", input: null },
  setProvider: {
    method: "POST",
    path: "/api/providers",
    scope: "brain:write",
    input: z.strictObject({
      id: ProviderId,
      preset: Name.optional(),
      kind: z.enum(["openai", "anthropic"]).optional(),
      baseUrl: z.string().url().optional(),
      secret: Name.optional(),
      label: z.string().max(128).optional(),
    }),
  },
  removeProvider: { method: "POST", path: "/api/providers/remove", scope: "brain:write", input: z.strictObject({ id: Name }) },
  providerModels: { method: "POST", path: "/api/providers/models", scope: "mind:read", input: z.strictObject({ id: Name }) },
  /**
   * A full node's call to a model this node's own local runtime serves (Ollama, llama.cpp: on its loopback), when the
   * node that asks has none: an OpenAI-style chat request passed to that runtime as sent, its answer streamed back as it
   * came. Nodes only.
   */
  localModelCall: {
    method: "POST", path: "/api/models/local", scope: "brain:write",
    input: z.strictObject({ provider: Name, request: z.record(z.string(), z.unknown()) }),
  },
  roster: { method: "GET", path: "/api/roster", scope: "mind:read", input: null },
  /**
   * Check what a model can do (brain/checks.ts): follow the quest loop's format, read a screen, place a click on
   * one. About eight calls; recorded for every node, which then chooses by it. Yours alone.
   */
  checkModel: { method: "POST", path: "/api/models/check", scope: "brain:write", input: z.strictObject({ model: ModelRef, parts: z.array(z.enum(["format", "reads", "places"])).min(1).max(3).optional() }) },
  setRoster: {
    method: "POST",
    path: "/api/roster",
    scope: "brain:write",
    input: z.strictObject({ role: Name, models: z.array(ModelRef).max(16) }),
  },
  /**
   * How hard a role's models think: `auto` (the default), by what each step of the work needs, routine turns less and
   * hard ones more (brain roster.ts STEP_EFFORT); or one level you choose, whatever the step.
   */
  setRosterEffort: {
    method: "POST",
    path: "/api/roster/effort",
    scope: "brain:write",
    input: z.strictObject({ role: Name, effort: z.enum(["auto", ...THINKING_EFFORTS]) }),
  },
  chat: {
    method: "POST",
    path: "/api/chat",
    scope: "chat",
    input: z.strictObject({
      role: Name.optional(),
      model: ModelRef.optional(),
      /** The model this answer is to be independent of (a review, usually): its candidates that are the same model are asked last. */
      apart: ModelRef.optional(),
      messages: z.array(ChatMessage).min(1).max(500),
      /** Galahad's tools, within the caller's scopes (default). Quests turn them off: their roles have their own. */
      tools: z.boolean().optional(),
      /**
       * Tools the caller runs itself (a quest's engineer: its shell and its files, in its own sandbox), offered to the
       * model. The node never runs one: an answer that calls them ends with a `calls` event, and the next request
       * carries what they came to. Only with Galahad's own tools off, and never in a kept chat.
       */
      clientTools: z
        .array(z.strictObject({ name: ClientToolName, description: z.string().min(1).max(4000), inputSchema: z.record(z.string(), z.unknown()) }))
        .min(1)
        .max(16)
        .optional(),
      /** Keep it in your chat history: a new conversation, or the one named by `conversation` (whose stored history then leads). */
      save: z.boolean().optional(),
      conversation: ConversationId.optional(),
      /** A new conversation's project: its instructions and memories go with every answer. */
      project: ProjectId.optional(),
      /** Ask again: the conversation's last exchange is replaced by this one, when it asked the same (one it never had is just asked). */
      retry: z.boolean().optional(),
      /**
       * Offer the archive's most relevant entries as context (fenced as data). Default: on when
       * the answer has tools, off without them; quests turn it on for the plan only.
       */
      archive: z.boolean().optional(),
      /**
       * Recall what the mind holds that bears on it (default yes). A trial of your own work's quest goes without: the
       * mind may hold what the task it replays taught, and a trial is never handed its answer.
       */
      memories: z.boolean().optional(),
      /** Start the role's models at this position: each parallel attempt takes another one first (the rest stay its fallbacks). */
      rotate: z.number().int().min(0).max(15).optional(),
      /** This call is one attempt's (effort): the census counts it as that attempt's, not his own. */
      attempt: AttemptTag.optional(),
      /**
       * This call is a quest of his own (its planner's or its engineer's): the skills that bear on its goal go
       * with it, fenced as data, chosen once and the same for every call of that quest (skills.ts), and their
       * use is counted against it. Only his own quests (yours from a terminal, a loop's): never an agent's.
       */
      quest: z.strictObject({ id: z.string().regex(/^[A-Za-z0-9._:-]{1,64}$/), goal: z.string().min(1).max(4000) }).optional(),
      /**
       * This call is coding work (a quest's planner, engineer or reviewer): a coding plan's models may answer
       * it, called as Galahad. Without it a plan's models are passed over, as for any talk with him.
       */
      coding: z.boolean().optional(),
      /**
       * This call spends a budget of yours (a quest given --budget-usd): only a model whose spend it can count answers
       * it, one you've priced or one on the node's own machine. Any other is passed over, saying why.
       */
      budgeted: z.boolean().optional(),
      /**
       * This call is a turn of a quest's work loop (a command a reply), whichever role answers it: the engineer's,
       * or the planner's once a gate has failed twice in a row. A model checked as not following the loop's
       * format is passed over for it, as for the engineer's own turns.
       */
      loop: z.boolean().optional(),
    })
      .refine((c) => !c.clientTools || c.tools === false, "tools the caller runs go without Galahad's own (tools: false)")
      .refine((c) => !c.clientTools || (!c.save && !c.conversation), "tools the caller runs are never in a kept chat"),
  },
  /**
   * A file for a message of yours (a picture, or text), kept on this node by the SHA-256 of its bytes: what you then
   * attach to the message. Yours alone, as your chats are. The same file again is the same one. Its bytes in base64.
   */
  uploadAttachment: {
    method: "POST",
    path: "/api/uploads",
    scope: "chat",
    input: z.strictObject({
      name: AttachmentName,
      type: AttachmentType,
      data: z
        .string()
        .min(4)
        .max(Math.ceil(ATTACHMENT_LIMITS.imageBytes / 3) * 4)
        .regex(/^[A-Za-z0-9+/]*={0,2}$/, "base64"),
    }),
  },
  /** An attached file's bytes, to show it (a picture) or save it: served as what its bytes are, never run. */
  attachmentFile: { method: "POST", path: "/api/uploads/get", scope: "chat", input: z.strictObject({ id: AttachmentId }) },
  /** Your chats, kept on this node (yours alone: never an agent's to read). */
  conversations: { method: "GET", path: "/api/conversations", scope: "chat", input: null },
  conversation: { method: "POST", path: "/api/conversations/get", scope: "chat", input: z.strictObject({ id: ConversationId }) },
  /** What is under way in a chat of yours: his knights' tasks given there that haven't ended (Stop on each), his looks that wait. */
  underway: { method: "POST", path: "/api/conversations/underway", scope: "chat", input: z.strictObject({ id: ConversationId }) },
  /** A look he sets himself (his look_later, as he answers in a chat of yours): only Galahad himself, from inside the node. */
  lookLater: { method: "POST", path: "/api/looks/set", scope: "chat", input: LookLaterInput },
  /** His looks that wait, in every chat of yours. */
  looks: { method: "GET", path: "/api/looks", scope: "chat", input: null },
  /** One of his looks, called off: by you, or by him in the chat it is in. */
  cancelLook: { method: "POST", path: "/api/looks/cancel", scope: "chat", input: CancelLookInput },
  updateConversation: {
    method: "POST",
    path: "/api/conversations/update",
    scope: "chat",
    input: z.strictObject({ id: ConversationId, title: z.string().trim().min(1).max(120).optional(), project: ProjectId.nullable().optional(), pinned: z.boolean().optional() }),
  },
  /** Gone for good: the node overwrites what it held. */
  deleteConversation: { method: "POST", path: "/api/conversations/delete", scope: "chat", input: z.strictObject({ id: ConversationId }) },
  /** You have read it, on whichever device: its answers so far are no longer new, as email's read (`unread`). */
  seeConversation: { method: "POST", path: "/api/conversations/seen", scope: "chat", input: z.strictObject({ id: ConversationId }) },
  /*
   * Turns the node owns (turns.ts): a chat turn of yours (the chat route, with his tools) runs on the node to
   * its end whether or not anyone is listening. Yours alone, like your chats: never an agent's. A turn that may
   * read the bank is watched and steered only by a device that may read the bank; a temporary chat's, only by
   * the device that started it.
   */
  /** The turns running on this node now, and its limits. */
  turns: { method: "GET", path: "/api/turns", scope: "chat", input: null },
  /** Watch a turn from its start to its end (server-sent events): what happened so far, then live. Leaving doesn't stop it. */
  attachTurn: { method: "POST", path: "/api/turns/attach", scope: "chat", input: z.strictObject({ turn: TurnId }) },
  /** Stop a turn: the only thing that does, besides the node's own limit for one turn. */
  stopTurn: { method: "POST", path: "/api/turns/stop", scope: "chat", input: z.strictObject({ turn: TurnId }) },
  /** Steer: your message reaches him at the next safe point, and the turn goes on with it. */
  steerTurn: { method: "POST", path: "/api/turns/steer", scope: "chat", input: z.strictObject({ turn: TurnId, text: QueuedText }) },
  /** Queue: kept on the node behind a kept chat, sent as its next turn when the one before it ends well. */
  queueMessage: { method: "POST", path: "/api/conversations/queue", scope: "chat", input: z.strictObject({ conversation: ConversationId, text: QueuedText, role: Name.optional() }) },
  editQueued: { method: "POST", path: "/api/conversations/queue/edit", scope: "chat", input: z.strictObject({ conversation: ConversationId, id: QueuedId, text: QueuedText }) },
  /** Remove one queued message, or (no id) discard them all. */
  removeQueued: { method: "POST", path: "/api/conversations/queue/remove", scope: "chat", input: z.strictObject({ conversation: ConversationId, id: QueuedId.optional() }) },
  /** Send now: steers the turn under way with it, or starts it as a turn at once. */
  sendQueued: { method: "POST", path: "/api/conversations/queue/send", scope: "chat", input: z.strictObject({ conversation: ConversationId, id: QueuedId }) },
  /** A held queue (after a stop, a failure or a restart) goes on. */
  resumeQueue: { method: "POST", path: "/api/conversations/queue/resume", scope: "chat", input: z.strictObject({ conversation: ConversationId }) },
  /**
   * A side question: answered (server-sent events) from what a chat holds and what its running turn has said
   * and done so far, without his tools, and added to nothing. The working turn never sees it unless you
   * bring it back. Names a kept chat, or a running turn (a temporary chat's).
   */
  askAside: {
    method: "POST",
    path: "/api/turns/aside",
    scope: "chat",
    input: z
      .strictObject({ conversation: ConversationId.optional(), turn: TurnId.optional(), question: z.string().trim().min(1).max(4000) })
      .refine((input) => Boolean(input.conversation) !== Boolean(input.turn), "name a conversation or a turn (one of them)"),
  },
  /** Bring a side question and its answer back: the turn under way is steered with them; with none running, they join the kept chat. */
  bringBack: { method: "POST", path: "/api/turns/aside/bring", scope: "chat", input: z.strictObject({ aside: AsideId }) },
  /** The quests in hand on this node and the ones that just ended: each one's plan, the step he's on, its gates' last results. */
  quests: { method: "GET", path: "/api/quests", scope: "mind:read", input: null },
  /** Whoever runs a quest says where it stands (whoever may run its sandbox may: the sandbox scope). */
  questProgress: { method: "POST", path: "/api/quests/progress", scope: "sandbox", input: QuestProgressInput },
  projects: { method: "GET", path: "/api/projects", scope: "mind:read", input: null },
  /** A project's instructions steer Galahad, so setting one is yours (brain:write: never an agent's). */
  setProject: { method: "POST", path: "/api/projects", scope: "brain:write", input: ProjectInput },
  removeProject: { method: "POST", path: "/api/projects/remove", scope: "brain:write", input: z.strictObject({ id: ProjectId }) },
  /** The Build view's git on a project's checkout on his computer (docs/BUILD.md), yours alone: how it stands. */
  projectGit: { method: "POST", path: "/api/projects/git", scope: "sandbox", input: ProjectGitInput },
  /** Switch its checkout to a branch, or start one where it stands. */
  projectBranch: { method: "POST", path: "/api/projects/branch", scope: "sandbox", input: ProjectBranchInput },
  /** Commit everything changed or new in its checkout. */
  projectCommit: { method: "POST", path: "/api/projects/commit", scope: "sandbox", input: ProjectCommitInput },
  /** Clone its repository into its checkout, the first time. */
  projectClone: { method: "POST", path: "/api/projects/clone", scope: "sandbox", input: ProjectGitInput },
  createInvite: {
    method: "POST",
    path: "/api/invites",
    scope: "fleet:admin",
    input: z.strictObject({
      kind: z.enum(["node", "client"]),
      scopes: z.array(ScopeSchema).max(16).optional(),
      origin: z.string().url().optional(),
    }),
  },
  pairings: { method: "GET", path: "/api/pairings", scope: "fleet:admin", input: null },
  approvePairing: {
    method: "POST",
    path: "/api/pairings/approve",
    scope: "fleet:admin",
    input: z.strictObject({ invite: z.string(), device: z.string() }),
  },
  rejectPairing: {
    method: "POST",
    path: "/api/pairings/reject",
    scope: "fleet:admin",
    input: z.strictObject({ invite: z.string(), device: z.string() }),
  },
  revokeDevice: {
    method: "POST",
    path: "/api/devices/revoke",
    scope: "fleet:admin",
    input: z.strictObject({ device: z.string(), reason: z.string().max(500).optional() }),
  },
  setDeviceScopes: {
    method: "POST",
    path: "/api/devices/scopes",
    scope: "fleet:admin",
    input: z.strictObject({ device: z.string(), scopes: z.array(ScopeSchema).max(16) }),
  },
  place: { method: "POST", path: "/api/place", scope: "mind:read", input: PlacementNeeds },
  mintToken: {
    method: "POST",
    path: "/api/tokens",
    scope: "gateway:mint",
    input: z.strictObject({
      label: z.string().min(1).max(64),
      providers: z.array(Name).max(32).optional(),
      ttlMinutes: z.number().int().min(1).max(7 * 24 * 60).default(60),
      maxRequests: z.number().int().min(1).max(1_000_000).default(1000),
    }),
  },
  revokeToken: {
    method: "POST",
    path: "/api/tokens/revoke",
    scope: "gateway:mint",
    input: z.strictObject({ hash: z.string().min(10).max(64) }),
  },
  ledger: { method: "GET", path: "/api/ledger", scope: "mind:read", input: null },
  sandboxes: { method: "POST", path: "/api/sandboxes/list", scope: "sandbox", input: z.strictObject({ on: NodeRef.optional() }) },
  /**
   * A sandbox takes a slot on its host, and waits for one when the host is full (the answer comes when it
   * has started). Unpinned, it goes to the sandbox host with the most room. More CPUs or memory than the
   * host's ceiling gets the ceiling.
   */
  createSandbox: { method: "POST", path: "/api/sandboxes", scope: "sandbox", input: SandboxRequest.extend({ on: NodeRef.optional(), attempt: AttemptTag.optional() }) },
  execSandbox: {
    method: "POST",
    path: "/api/sandboxes/exec",
    scope: "sandbox",
    input: z.strictObject({
      id: SandboxId,
      cmd: z.array(z.string().max(100_000)).min(1).max(256),
      timeoutSec: z.number().int().min(1).max(3600).optional(),
      on: NodeRef.optional(),
      /** Set by a full node relaying an arm's request: the arm may only use its own sandboxes. */
      quest: z.string().max(64).optional(),
    }),
  },
  /**
   * What a sandbox's own calls through its node's gateway have come to (a coding agent's, a script's), by model, as that
   * node counted them by the sandbox's token: `{ lines: UsageLine[] }`, role "tool". `galahad do` counts them in its
   * budget. Asked of the node the sandbox is on; an agent, of its own sandboxes only.
   */
  sandboxSpend: {
    method: "POST",
    path: "/api/sandboxes/spend",
    scope: "sandbox",
    input: z.strictObject({
      id: SandboxId,
      /** Calls since then (ms; absent: all it made, as for a fresh sandbox). A knight's VM outlives its tasks. */
      since: z.number().int().min(0).optional(),
      on: NodeRef.optional(),
      /** Set by a full node relaying an arm's request: the arm may only ask of its own sandboxes. */
      quest: z.string().max(64).optional(),
    }),
  },
  /**
   * Terminals in this node's sandboxes (a knight's VM, one of yours), for you alone: a login shell on a real terminal.
   * One stays open while it is watched and for a while after, so a phone that leaves to finish a sign-in comes back to it.
   */
  terminals: { method: "GET", path: "/api/terminals", scope: "sandbox", input: null },
  openTerminal: { method: "POST", path: "/api/terminals", scope: "sandbox", input: z.strictObject({ sandbox: SandboxId, size: TerminalSize }) },
  /** What it shows, as `TerminalEvent`s: what it showed lately first, then as it comes; its exit ends them. */
  watchTerminal: { method: "POST", path: "/api/terminals/watch", scope: "sandbox", input: z.strictObject({ terminal: TerminalId }) },
  /** Keys typed or pasted, and the size it has now. In order: send the next when this one is answered. */
  terminalInput: {
    method: "POST",
    path: "/api/terminals/input",
    scope: "sandbox",
    input: z.strictObject({ terminal: TerminalId, data: z.string().min(1).max(65_536).optional(), size: TerminalSize.optional() }),
  },
  closeTerminal: { method: "POST", path: "/api/terminals/close", scope: "sandbox", input: z.strictObject({ terminal: TerminalId }) },
  destroySandbox: {
    method: "POST",
    path: "/api/sandboxes/destroy",
    scope: "sandbox",
    input: z.strictObject({
      id: SandboxId,
      on: NodeRef.optional(),
      /** Set by a full node forwarding an owner's request; honored only from full nodes. */
      onBehalfOf: z.string().max(100).optional(),
      /** Set by a full node relaying an arm's request: cleanup of that quest's own sandboxes only. */
      quest: z.string().max(64).optional(),
    }),
  },
  /**
   * A commit of a GitHub repository put in one of your sandboxes that isn't a knight's VM (a trial of your own work's),
   * through the node's read-only git gateway: a lease for that one repository is written inside the sandbox and
   * revoked once the fetch is over, so its token is never in a command or an answer. The commit, with up to 50
   * commits of its history and nothing after it, is checked out at `path`.
   */
  checkoutRepository: {
    method: "POST",
    path: "/api/sandboxes/checkout",
    scope: "fleet:admin",
    input: z.strictObject({
      id: SandboxId,
      on: NodeRef.optional(),
      repository: z.string().regex(/^https:\/\/github\.com\/[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}\/?$/),
      commit: z.string().regex(/^[0-9a-f]{40}$/),
      path: z
        .string()
        .max(256)
        .regex(/^\/work(\/[A-Za-z0-9._-]+)+$/, "a directory under /work")
        .refine((path) => !path.split("/").some((part) => part === "." || part === ".."), "no . or .. in the path"),
    }),
  },
  buildSandboxImage: {
    method: "POST",
    path: "/api/sandboxes/build",
    scope: "sandbox",
    input: z.strictObject({ on: NodeRef.optional(), lab: z.boolean().optional(), gazebo: z.boolean().optional(), desktop: z.boolean().optional() }),
  },
  loops: { method: "GET", path: "/api/loops", scope: "mind:read", input: null },
  setLoop: {
    method: "POST",
    path: "/api/loops",
    scope: "brain:write",
    // A new loop needs a schedule and a task; an existing one keeps whatever you leave out.
    input: z.strictObject({
      name: LoopName,
      schedule: z.string().min(1).max(128).optional(),
      tz: z.string().max(64).optional(),
      on: NodeRef.optional(),
      enabled: z.boolean().optional(),
      task: LoopTask.optional(),
      label: z.string().max(128).optional(),
      /** What else wakes it, all of them (an empty list: only its schedule); left out, it keeps its own. */
      wakes: LoopWakes.optional(),
      cooldownMs: WakeCooldownMs.optional(),
      /** The draft this adds (loopDrafts): it leaves your Inbox once the loop is set. */
      draft: LoopDraftId.optional(),
    }),
  },
  /**
   * A new secret for a loop's webhook, shown this once (the old one stops working): what signs a POST to its path.
   * Setting a loop's first webhook makes one and shows it the same way.
   */
  loopHook: { method: "POST", path: "/api/loops/hook", scope: "brain:write", input: z.strictObject({ name: LoopName }) },
  /** The bilag copied to Google Drive from your mail (node bilag.ts): how many, and the latest. Yours alone: they're your company's. */
  bilag: { method: "GET", path: "/api/bilag", scope: "fleet:admin", input: null },
  /** Copy the bilag of mail a search finds (what came before a bilag loop's wakes), a batch a call: `next` goes on. */
  bilagCopy: { method: "POST", path: "/api/bilag/copy", scope: "fleet:admin", input: BilagCopyInput },
  /** Copies of forwarded mail named for who first sent it, in Drive (bilag.ts renameForwarded). Yours alone. */
  bilagNames: { method: "POST", path: "/api/bilag/names", scope: "fleet:admin", input: z.strictObject({}) },
  /** A bilag into Dinero's archive as it is, its attaching to a payment's card filed for your approval (books.ts). Yours alone. */
  booksAttach: { method: "POST", path: "/api/books/attach", scope: "fleet:admin", input: BooksAttachInput },
  /** A bilag into Dinero's archive as it is, and the fileGuid a voucher drafted with it takes (books.ts). Yours alone. */
  booksUpload: { method: "POST", path: "/api/books/upload", scope: "fleet:admin", input: BooksUploadInput },
  loopDrafts: { method: "GET", path: "/api/loops/drafts", scope: "mind:read", input: null },
  /** Telegram (PLAN #19): whether a bot of yours talks to Galahad through this node, and which account it answers. */
  telegram: { method: "GET", path: "/api/telegram", scope: "mind:read", input: null },
  /**
   * Connect a bot of yours (its token from BotFather, checked with Telegram and sealed in the vault). The gateway
   * becomes a device of its own (chat and mind:read only), and the code it answers, sent to the bot from your account,
   * links that account. Again: a new code (another bot forgets the account it had).
   */
  telegramConnect: { method: "POST", path: "/api/telegram/connect", scope: "fleet:admin", input: z.strictObject({ token: z.string().trim().min(20).max(100) }) },
  /** Stop: the bot's token goes, and the gateway's device is revoked. Its chats stay yours. */
  telegramDisconnect: { method: "POST", path: "/api/telegram/disconnect", scope: "fleet:admin", input: z.strictObject({}) },
  /** Slack (PLAN #19): whether an app of yours talks to Galahad through this node, in which workspace, and which account it answers. */
  slack: { method: "GET", path: "/api/slack", scope: "mind:read", input: null },
  /**
   * Connect an app of yours (made from SLACK_APP_MANIFEST): its app-level token (Socket Mode) and its bot token, checked
   * with Slack and sealed in the vault. The gateway becomes a device of its own (chat and mind:read only), and the code
   * it answers, sent to the app from your account, links that account. Again: a new code (another app forgets the account).
   */
  slackConnect: { method: "POST", path: "/api/slack/connect", scope: "fleet:admin", input: z.strictObject({ appToken: z.string().trim().min(20).max(400), botToken: z.string().trim().min(20).max(400) }) },
  /** Stop: the app's tokens go, and the gateway's device is revoked. Its chats stay yours. */
  slackDisconnect: { method: "POST", path: "/api/slack/disconnect", scope: "fleet:admin", input: z.strictObject({}) },
  /** Galahad's draft of a loop you asked for in chat: never a loop until you add it (setLoop, brain:write). */
  draftLoop: { method: "POST", path: "/api/loops/drafts", scope: "chat", input: LoopDraftInput },
  dismissLoopDraft: { method: "POST", path: "/api/loops/drafts/dismiss", scope: "brain:write", input: z.strictObject({ id: LoopDraftId }) },
  removeLoop: { method: "POST", path: "/api/loops/remove", scope: "brain:write", input: z.strictObject({ name: LoopName }) },
  runLoop: { method: "POST", path: "/api/loops/run", scope: "brain:write", input: z.strictObject({ name: LoopName }) },
  loopRuns: {
    method: "POST",
    path: "/api/loops/runs",
    scope: "mind:read",
    input: z.strictObject({ name: LoopName.optional(), limit: z.number().int().min(1).max(200).optional() }),
  },
  notices: { method: "GET", path: "/api/notices", scope: "mind:read", input: null },
  // Yours alone (fleet:admin, which agents never hold): an injected agent can't silence an alert.
  dismissNotice: { method: "POST", path: "/api/notices/dismiss", scope: "fleet:admin", input: z.strictObject({ key: NoticeKey }) },
  /** Run the heartbeat's checks here, now, and return what they find (writes nothing). */
  heartbeat: { method: "POST", path: "/api/heartbeat", scope: "mind:read", input: z.strictObject({}) },
  /**
   * The doctor (doctor.ts): one look at this node's whole installation, answered in plain lines (ok, needs you,
   * broken) with what to do for anything that isn't ok. It changes nothing. `quick`: only what costs nothing to
   * look at; `offline`: no model is asked and no connector's service probed. Yours alone (fleet:admin, from a
   * terminal or a paired device; never an agent, never another node): a full check asks each role's model a word.
   */
  doctor: { method: "POST", path: "/api/doctor", scope: "fleet:admin", input: z.strictObject({ quick: z.boolean().optional(), offline: z.boolean().optional() }) },
  /** Whether Galahad fixes what's on the self-action allowlist himself after each heartbeat, and what he fixed lately. */
  selfAction: { method: "GET", path: "/api/self-action", scope: "mind:read", input: null },
  /** The owner's switch for self-action (on by default). It steers Galahad, so it's brain:write: never an agent's. */
  setSelfAction: { method: "POST", path: "/api/self-action", scope: "brain:write", input: z.strictObject({ on: z.boolean() }) },
  connectors: { method: "GET", path: "/api/connectors", scope: "mind:read", input: null },
  /** The library of hosted MCP servers (Galahad's reviewed list and the index at mcp.galahad.sh): a page of what matches. */
  connectorLibrary: { method: "POST", path: "/api/connectors/library", scope: "mind:read", input: z.strictObject({
    q: z.string().max(200).optional(),
    auth: z.enum(MCP_AUTHS as [McpIndexEntry["auth"], ...McpIndexEntry["auth"][]]).optional(),
    category: z.enum(MCP_CATEGORIES).optional(),
    sort: z.enum(["popular", "name", "updated"]).optional(),
    offset: z.number().int().min(0).max(100_000).optional(),
    limit: z.number().int().min(1).max(100).optional(),
  }) },
  setConnector: {
    method: "POST",
    path: "/api/connectors",
    scope: "brain:write",
    input: z.strictObject({
      id: ConnectorId,
      /** For a catalog connector whose origin is yours (Home Assistant on your LAN). */
      origin: z.string().url().max(256).optional(),
      /** A connector of your own: a full manifest. */
      manifest: z.record(z.string(), z.unknown()).optional(),
      /** A remote MCP server: Galahad lists its tools now (again, to refresh) and keeps the classes you chose. */
      mcp: z
        .strictObject({
          url: z.string().url().max(512),
          label: z.string().min(1).max(64).optional(),
          description: z.string().max(500).optional(),
          /** How the key is sent, if it needs one: bearer (Authorization) or a header of the server's choosing. */
          /** How its key is sent; oauth: you sign in to it as yourself (its own sign-in, found from the server). */
          auth: z.enum(["none", "bearer", "header", "oauth"]).optional(),
          header: z.string().regex(/^[A-Za-z0-9-]{1,64}$/).optional(),
          /** Install only these tools (the server's names). */
          only: z.array(z.string().min(1).max(128)).max(128).optional(),
          /** Your class for a tool (server or local name); "*" for the ones you don't name. */
          classes: z.record(z.string().min(1).max(128), z.enum(["read", "create", "modify", "outward", "delete"])).optional(),
        })
        .optional(),
    }),
  },
  removeConnector: { method: "POST", path: "/api/connectors/remove", scope: "brain:write", input: z.strictObject({ id: ConnectorId }) },
  /** What agents asked you to connect (ConnectorRequestInput): each waits until that connector is installed or you dismiss it. */
  connectorRequests: { method: "GET", path: "/api/connectors/requests", scope: "mind:read", input: null },
  /** An agent asking for a connector it doesn't have. Asking installs nothing: you add it, from the request. */
  requestConnector: { method: "POST", path: "/api/connectors/requests", scope: "connect", input: ConnectorRequestInput },
  dismissConnectorRequest: { method: "POST", path: "/api/connectors/requests/dismiss", scope: "brain:write", input: z.strictObject({ id: ConnectorRequestId }) },
  /**
   * The app you registered for a connector that signs in (Gmail, Outlook): its client id, and for Google its secret.
   * Sealed in the vault under the connector's secret, pinned to it; a new client id ends the sign-in it had.
   */
  setOAuthApp: {
    method: "POST",
    path: "/api/oauth/app",
    scope: "vault:write",
    input: z.strictObject({ connector: ConnectorId, client: z.string().min(1).max(256).regex(/^\S+$/), secret: z.string().min(1).max(256).regex(/^\S+$/).optional() }),
  },
  /**
   * Sign in to a connector as yourself. Google: the address of its consent page, which returns to `redirect` (your
   * app's own /oauth/callback, as you registered it). Microsoft: a code to type at its page, while the node waits.
   */
  oauthStart: {
    method: "POST",
    path: "/api/oauth/start",
    scope: "brain:write",
    input: z.strictObject({ connector: ConnectorId, redirect: z.string().url().max(300).optional() }),
  },
  /** Forget a connector's sign-in (the app you registered stays). */
  oauthSignOut: { method: "POST", path: "/api/oauth/signout", scope: "brain:write", input: z.strictObject({ connector: ConnectorId }) },
  /** Let an agent use a connector that's Galahad's alone, or stop it again. It answers that agent's request for it. */
  setConnectorAccess: {
    method: "POST",
    path: "/api/connectors/access",
    scope: "brain:write",
    input: z.strictObject({ id: ConnectorId, agent: AgentLabel, allow: z.boolean() }),
  },
  callConnector: {
    method: "POST",
    path: "/api/connectors/call",
    scope: "connect",
    input: z.strictObject({
      connector: ConnectorId,
      tool: ToolName,
      args: ConnectorArgs.optional(),
      why: z.string().max(500).optional(),
      /**
       * You, asking to be asked: file it for approval like an agent's call (on behalf of a quest
       * you started), instead of running it now. Standing orders still answer it.
       */
      ask: z.strictObject({ quest: z.string().regex(/^q-[a-z0-9]{1,16}$/).optional() }).optional(),
    }),
  },
  /** One tool's whole definition, for a call: an MCP server's read from it now and held to its pin; a template's as installed. */
  connectorTool: {
    method: "POST",
    path: "/api/connectors/tool",
    scope: "connect",
    input: z.strictObject({ connector: ConnectorId, tool: ToolName }),
  },
  actions: { method: "GET", path: "/api/actions", scope: "mind:read", input: null },
  /**
   * While you were away (PLAN #37): what happened since `since` (ms), in a few lines from what the node holds, no model
   * asked: knights' tasks that ended, his outcomes' reports and questions, loops that failed, and what waits for you now.
   */
  away: { method: "POST", path: "/api/away", scope: "mind:read", input: z.strictObject({ since: z.number().int().min(0) }) },
  decideAction: {
    method: "POST",
    path: "/api/actions/decide",
    scope: "fleet:admin",
    input: z
      .strictObject({
        id: ActionId,
        approve: z.boolean(),
        note: z.string().max(500).optional(),
        /**
         * Your own words in it, with a yes: text it already has (a message's, a pull request's), replaced, its other
         * arguments as they were. Your version is filed anew under the same asker and approved in the same step, and
         * the one it was asked as is declined, saying which it became (connectors.ts amend).
         */
        edits: z
          .record(z.string().min(1).max(64), z.string().max(8000))
          .refine((edits) => Object.keys(edits).length >= 1 && Object.keys(edits).length <= 16, "edit one to sixteen of its texts")
          .optional(),
      })
      .refine((answer) => !answer.edits || answer.approve, "an edit goes with a yes: decline it as it is, or edit it and approve"),
  },
  /**
   * MCP servers' questions to you in the middle of a call (elicitation, PLAN #49): each waits in your Inbox until you
   * answer it or it runs out of time. Read like the actions that wait for you.
   */
  questions: { method: "GET", path: "/api/questions", scope: "mind:read", input: null },
  /**
   * Your answer to one, yours alone: what you filled in, checked against what it asked and sent back to the server that
   * asked (accept), or no (decline). Nothing in it may look like a key: a key goes in the vault, never to a server's form.
   */
  answerQuestion: {
    method: "POST",
    path: "/api/questions/answer",
    scope: "fleet:admin",
    input: z.strictObject({
      id: z.string().regex(QUESTION_ID),
      accept: z.boolean(),
      content: z.record(z.string().max(64), z.union([z.string().max(QUESTION_LIMITS.text), z.number(), z.boolean(), z.array(z.string().max(QUESTION_LIMITS.option)).max(QUESTION_LIMITS.options)])).optional(),
    }),
  },
  investigations: { method: "GET", path: "/api/investigations", scope: "mind:read", input: null },
  /** Record a pre-registration before anything runs (it never changes afterwards). */
  registerInvestigation: {
    method: "POST",
    path: "/api/investigations",
    scope: "mind:write",
    input: z.strictObject({ registration: Preregistration }),
  },
  /** How it ended, once, by the node that registered it. */
  concludeInvestigation: {
    method: "POST",
    path: "/api/investigations/conclude",
    scope: "mind:write",
    input: z.strictObject({
      id: InvestigationId,
      status: InvestigationStatus,
      conclusion: Conclusion.optional(),
      summary: z.string().max(4000),
      review: z.string().max(4000).optional(),
      artifact: z.string().regex(/^art_[A-Za-z0-9_-]{22}$/).optional(),
      predictions: z.array(PredictionOutcome).max(16).optional(),
    }),
  },
  trials: { method: "GET", path: "/api/trials", scope: "mind:read", input: null },
  /**
   * Record a graded trial, once. brain:write (never an arm's): the Index decides what
   * Galahad keeps, so the thing being measured can't write its own marks.
   */
  recordTrial: {
    method: "POST",
    path: "/api/trials",
    scope: "brain:write",
    /** `spent`: what its model calls came to, by role and model (counts only), recorded beside it (`trial.spent`). */
    input: TrialRecord.extend({ spent: SpendLines.optional() }),
  },
  /** A run's settings (its effort, what it pinned, its variant, its budget), recorded once when it starts: the reports read them. */
  startTrialRun: {
    method: "POST",
    path: "/api/trials/runs",
    scope: "brain:write",
    input: z.strictObject({
      run: TrialRunId,
      suite: z.string().regex(/^[a-z0-9][a-z0-9-]{0,59}$/),
      effort: EffortLevel,
      parallel: z.number().int().min(1).max(64).optional(),
      pins: TrialPins.optional(),
      variant: z.strictObject({ name: VariantName, options: z.strictObject(HarnessOptions.shape) }).optional(),
      seed: z.number().int().min(0).max(0xffffffff).optional(),
      group: z.string().regex(/^g-[a-z0-9]{1,16}$/).optional(),
      budget: z.strictObject({ tokens: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER).optional(), usd: z.number().min(0).max(1_000_000).optional() }).optional(),
    }),
  },
  // ---- What model calls cost (usage.ts): tokens as the providers report them, money at your prices ----
  /** Your prices, per model, in US dollars per million tokens. */
  prices: { method: "GET", path: "/api/prices", scope: "mind:read", input: null },
  /** State a model's price (yours to state, never an agent's: it decides what "cheaper" means). `<provider>/*` prices all of a provider's models. */
  setPrice: { method: "POST", path: "/api/prices", scope: "brain:write", input: z.strictObject({ model: PricedModel, ...z.strictObject(PriceSchema.shape).shape }) },
  removePrice: { method: "POST", path: "/api/prices/remove", scope: "brain:write", input: z.strictObject({ model: PricedModel }) },
  /** This node's own count of its model calls, by day, who asked, role and model (never a prompt or an answer), and your prices. */
  usage: { method: "POST", path: "/api/usage", scope: "mind:read", input: z.strictObject({ days: z.number().int().min(1).max(366).optional() }) },
  /** This period's model calls on this node at your prices, against your budget for them: a meter's numbers. */
  usageMeter: { method: "GET", path: "/api/usage/meter", scope: "mind:read", input: null },
  /** Your budget for this node's model calls (a line to watch, never a stop): a day's or a month's, or none. */
  setUsageBudget: { method: "POST", path: "/api/usage/budget", scope: "brain:write", input: UsageBudgetInput },

  // ---- Compute: what the fleet can carry, and how he spends it (compute.ts) ----------
  /** The census: every node's body, what it measured, its ceiling, slots in use and waiting; his plan; the day's budget. */
  compute: { method: "GET", path: "/api/compute", scope: "mind:read", input: null },
  /** A node measures itself now: a few seconds, at low priority, within its ceiling. Yours to ask (brain:write: never an agent's). */
  calibrateCompute: { method: "POST", path: "/api/compute/calibrate", scope: "brain:write", input: z.strictObject({ on: NodeRef.optional() }) },
  /**
   * The ceiling for one node: the threads and memory he may use there, how many sandboxes and model calls at
   * once. Yours alone (fleet:admin, from a terminal or a paired device; never an agent, never a node on its own).
   */
  setComputeLimit: {
    method: "POST",
    path: "/api/compute/limit",
    scope: "fleet:admin",
    input: z.strictObject({
      node: NodeRef,
      cores: z.number().int().min(1).max(4096).optional(),
      memoryGb: z.number().min(1).max(65_536).optional(),
      sandboxes: z.number().int().min(0).max(256).optional(),
      modelCalls: z.number().int().min(1).max(256).optional(),
      /** Back to the defaults first (then whatever else is given). */
      reset: z.boolean().optional(),
    }),
  },
  /** The level auto may reach, and the day's budget of extra attempts. It steers how he spends: brain:write, and yours alone. */
  setComputePolicy: {
    method: "POST",
    path: "/api/compute/policy",
    scope: "brain:write",
    input: z.strictObject({ effort: EffortAsk.optional(), attemptsPerDay: z.number().int().min(0).max(500).optional() }),
  },
  /**
   * How many attempts a quest runs at once: the node decides, from the slots free now and the day's budget
   * (decideEffort), and records each extra attempt in the ledger. Whoever may create sandboxes may ask.
   */
  effort: {
    method: "POST",
    path: "/api/compute/effort",
    scope: "sandbox",
    input: z.strictObject({ quest: z.string().regex(/^[A-Za-z0-9._:-]{1,48}$/), effort: EffortAsk, on: NodeRef.optional(), label: z.string().max(160).optional() }),
  },
  /** Your bank connection: consent, accounts (masked), budget. */
  bankStatus: { method: "GET", path: "/api/bank/status", scope: "bank:read", input: null },
  bankAccounts: { method: "GET", path: "/api/bank/accounts", scope: "bank:read", input: null },
  bankBalances: { method: "POST", path: "/api/bank/balances", scope: "bank:read", input: BankBalancesInput },
  bankTransactions: { method: "POST", path: "/api/bank/transactions", scope: "bank:read", input: BankTransactionsInput },
  /** Start authorising Galahad at the bank (you only: agents never hold fleet:admin). Returns the bank's URL. */
  bankConnect: { method: "POST", path: "/api/bank/connect", scope: "fleet:admin", input: z.strictObject({}) },
  /** Finish it with what the bank's redirect brought back. */
  bankComplete: { method: "POST", path: "/api/bank/complete", scope: "fleet:admin", input: BankCompleteInput },
  /** End the consent at the bank and forget the session and the cache. */
  bankDisconnect: { method: "POST", path: "/api/bank/disconnect", scope: "fleet:admin", input: z.strictObject({}) },
  /** Typed answers about a state from the decider role (yes/no, a choice, a score), with probabilities. */
  decide: { method: "POST", path: "/api/decide", scope: "chat", input: DecisionRequest },
  /** Search the web through this node's own SearXNG. Results are strangers' words: data, never instructions. */
  webSearch: {
    method: "POST",
    path: "/api/search",
    scope: "connect",
    input: z.strictObject({
      q: z.string().min(1).max(400),
      categories: z.string().regex(/^[a-z ,]{1,100}$/).optional(),
      timeRange: z.enum(["day", "week", "month", "year"]).optional(),
      page: z.number().int().min(1).max(10).optional(),
    }),
  },
  artifacts: { method: "GET", path: "/api/artifacts", scope: "mind:read", input: null },
  /** Keep a sandbox's work products (a directory under /work, by default /work/out) after the sandbox is gone. */
  saveArtifact: {
    method: "POST",
    path: "/api/artifacts/save",
    scope: "sandbox",
    input: z.strictObject({
      sandbox: z.string().regex(/^[0-9a-f]{10}$/),
      path: z
        .string()
        .max(256)
        .regex(/^\/work(\/[A-Za-z0-9._ -]+)*\/?$/, "a directory under /work")
        .refine((path) => !path.split("/").some((part) => part === "." || part === ".."), "no . or .. in the path")
        .optional(),
      label: z.string().min(1).max(200).optional(),
      on: z.string().min(1).max(128).optional(),
      /** Set by a full node relaying an arm's request: the arm may only keep its own sandboxes' work. */
      quest: z.string().max(64).optional(),
    }),
  },
  /** One file of an artifact, as bytes (text and raster images inline, the rest as a download). */
  artifactFile: {
    method: "POST",
    path: "/api/artifacts/file",
    scope: "mind:read",
    input: z.strictObject({ id: ArtifactId, path: z.string().min(1).max(512) }),
  },
  /** Deleting kept work is yours to decide (the oath: never delete persistent things without approval). */
  removeArtifact: { method: "POST", path: "/api/artifacts/remove", scope: "fleet:admin", input: z.strictObject({ id: ArtifactId }) },
  orders: { method: "GET", path: "/api/orders", scope: "mind:read", input: null },
  /** Sign a standing order: your answer in advance. Only you (never an agent or another node). */
  setOrder: {
    method: "POST",
    path: "/api/orders",
    scope: "fleet:admin",
    input: z.strictObject({
      connector: ConnectorId,
      tool: ToolName,
      args: z.record(z.string().max(40), OrderPattern),
      callers: z.array(OrderPattern).min(1).max(16).optional(),
      /** How long it lasts (default 30 days). */
      days: z.number().int().min(1).max(MAX_ORDER_DAYS).optional(),
      label: z.string().min(1).max(128),
      /** Also approve this waiting action, which the order was made from. */
      approve: ActionId.optional(),
    }),
  },
  revokeOrder: { method: "POST", path: "/api/orders/revoke", scope: "fleet:admin", input: z.strictObject({ id: OrderId }) },
  /** Your rules (rules.ts): the tripwires on his work's commands, each as this node reads it. */
  rules: { method: "GET", path: "/api/rules", scope: "mind:read", input: null },
  /** Set a rule, or replace the one by its name: yours alone, like a standing order (never an agent's, never another node's). */
  setRule: { method: "POST", path: "/api/rules", scope: "fleet:admin", input: RuleInput },
  removeRule: { method: "POST", path: "/api/rules/remove", scope: "fleet:admin", input: z.strictObject({ name: RuleName }) },
  /** A rule stopped a quest's command: the ledger says so. Whoever runs the quest's sandbox says it, and the node checks the rule stops it. */
  ruleTripped: { method: "POST", path: "/api/rules/tripped", scope: "sandbox", input: RuleTrippedInput },
  /** A command a rule of yours that tells matched has run (a quest's, said by its loop): the node tells you. */
  ruleTold: { method: "POST", path: "/api/rules/told", scope: "sandbox", input: RuleToldInput },
  arms: { method: "GET", path: "/api/arms", scope: "fleet:admin", input: null },
  mintArm: {
    method: "POST",
    path: "/api/arms",
    scope: "fleet:admin",
    input: z.strictObject({ label: z.string().regex(/^[a-z0-9][a-z0-9._-]{0,47}$/), scopes: z.array(ScopeSchema).max(16).optional() }),
  },
  /** Change what an agent may do without changing its token (e.g. grant bank:read). */
  grantArm: {
    method: "POST",
    path: "/api/arms/grant",
    scope: "fleet:admin",
    input: z.strictObject({
      label: z.string().regex(/^[a-z0-9][a-z0-9._-]{0,47}$/),
      add: z.array(ScopeSchema).max(16).optional(),
      remove: z.array(ScopeSchema).max(16).optional(),
    }),
  },
  revokeArm: {
    method: "POST",
    path: "/api/arms/revoke",
    scope: "fleet:admin",
    input: z.strictObject({ label: z.string().regex(/^[a-z0-9][a-z0-9._-]{0,47}$/) }),
  },

  // ---- Q-AMP grants (qamp.ts; PLAN #58): an agent on another of your machines, a few of his tools, for a while ----
  /** The grants in force on this node: each one's agent, tools, end and bridge. Yours alone, as each of these is. */
  qampGrants: { method: "GET", path: "/api/qamp/grants", scope: "fleet:admin", input: null },
  /** Grant an agent's key some of the read-only tools for a while: an arm of its own, a chain bound to its key, a bridge. */
  qampGrant: { method: "POST", path: "/api/qamp/grants", scope: "fleet:admin", input: QampGrantInput },
  /** End one grant, or every one: its arm deleted at once (the agent's next call refused), its bridge stopped. */
  qampRevoke: { method: "POST", path: "/api/qamp/revoke", scope: "fleet:admin", input: QampRevokeInput },

  // ---- The archive (node-local: what this node keeps, for good) -----------------
  /** Entries, chunks embedded, the backlog, the embedder, the last integrity check, disk used. */
  archiveStatus: { method: "GET", path: "/api/archive", scope: "mind:read", input: null },
  /** Hybrid search (words and meaning, fused), filtered by kind, trust, source and time. */
  archiveSearch: { method: "POST", path: "/api/archive/search", scope: "mind:read", input: ArchiveSearchInput },
  /** One entry: its description, understanding, files and links. */
  archiveEntry: { method: "POST", path: "/api/archive/entry", scope: "mind:read", input: z.strictObject({ id: ArchiveId }) },
  /** One file of an entry, as bytes (checked against its SHA-256 before it's sent). */
  archiveFile: { method: "POST", path: "/api/archive/file", scope: "mind:read", input: z.strictObject({ id: ArchiveId, path: z.string().min(1).max(512) }) },
  /** An idea, kept: yours from the app or a terminal, Galahad's from his note_idea tool. */
  noteIdea: { method: "POST", path: "/api/archive/ideas", scope: "mind:write", input: NoteIdeaInput },
  /** Only you delete, with a reason; a tombstone stays so it's never archived again. */
  deleteArchived: { method: "POST", path: "/api/archive/delete", scope: "fleet:admin", input: ArchiveDeleteInput },
  /** Embed (and optionally summarise) everything again, in the background. */
  reindexArchive: { method: "POST", path: "/api/archive/reindex", scope: "fleet:admin", input: ArchiveReindexInput },
  /** Re-hash every stored file now (it also runs daily). */
  verifyArchive: { method: "POST", path: "/api/archive/verify", scope: "fleet:admin", input: z.strictObject({}) },
  /** How many entries the swift role may summarise per day. */
  setArchiveBudget: { method: "POST", path: "/api/archive/budget", scope: "brain:write", input: ArchiveBudgetInput },

  // ---- His skills (skills.ts): how he did a kind of work, as words he reads --------
  /** Every skill with its state, uses and track record, and the day's budget for distilling. Read like any memory. */
  skills: { method: "GET", path: "/api/skills", scope: "mind:read", input: null },
  /** One skill in full: every version kept, where each came from, and the quests it was given to. */
  skill: { method: "POST", path: "/api/skills/get", scope: "mind:read", input: z.strictObject({ id: SkillId }) },
  /**
   * Write a skill, or a new version of one. Who asks decides its trust, never the caller's say: yours are
   * owner; what he writes when asked in a chat, and what another agent proposes, is untrusted and waits for you.
   */
  writeSkill: { method: "POST", path: "/api/skills", scope: "mind:write", input: SkillWriteInput },
  /**
   * A quest of his has ended: its outcome is recorded against the skills it was given, and if its review
   * passed, one bounded call distils at most one skill from its evidence. His own quests only.
   */
  learnSkill: { method: "POST", path: "/api/skills/learn", scope: "mind:write", input: QuestEvidenceInput },
  /**
   * Yours alone: an Agent Skill's folder on GitHub (PLAN #34) taken in as a skill, as text: its SKILL.md alone is read,
   * nothing in the folder runs, and the skill waits for your approval (untrusted, by where it came from) like any other.
   */
  importSkill: { method: "POST", path: "/api/skills/take-in", scope: "fleet:admin", input: z.strictObject({ url: z.string().trim().min(10).max(500) }) },
  /** Yours alone: approve exactly the version you read (an untrusted skill is given to no model before that). */
  approveSkill: { method: "POST", path: "/api/skills/approve", scope: "fleet:admin", input: SkillApproveInput },
  /** Yours alone: locked, he may use it but not change it. */
  lockSkill: { method: "POST", path: "/api/skills/lock", scope: "fleet:admin", input: SkillLockInput },
  /** Yours alone: retired, it's kept and never offered (nothing is deleted); put back with `retired: false`. */
  retireSkill: { method: "POST", path: "/api/skills/retire", scope: "fleet:admin", input: SkillRetireInput },
  /** Yours alone: one step back, to the version before the latest. */
  rollbackSkill: { method: "POST", path: "/api/skills/rollback", scope: "fleet:admin", input: z.strictObject({ id: SkillId }) },
  /** The day's budget for distilling skills, in tokens (0: he distils none). */
  setSkillsBudget: { method: "POST", path: "/api/skills/budget", scope: "brain:write", input: SkillsBudgetInput },
  // ---- Notifications: he comes to you, on your own paired devices (notify.ts; node-local) ----------
  /*
   * Yours alone, every one of them: the node refuses agents and other nodes whatever their scopes. No route takes a
   * title or a line: what a notification says comes only from the node's own records, through its own rules.
   */
  /** Who is notified (devices by name, never an endpoint), what he sends and when he stays silent, what was sent today, and this node's public key to subscribe to. */
  notify: { method: "GET", path: "/api/notify", scope: "mind:read", input: null },
  /** What he sends and when he stays silent: the kinds, quiet hours, the day's limit. It steers him: brain:write, never an agent's. */
  setNotify: { method: "POST", path: "/api/notify", scope: "brain:write", input: NotifyPrefsInput },
  /** This device turns notifications on, for itself: its browser's push subscription, kept as that device's. Only a paired device may, and only its own. */
  pushSubscribe: { method: "POST", path: "/api/notify/subscribe", scope: "mind:read", input: PushSubscriptionInput },
  /** The iPhone app turns notifications on, for itself: its Apple push token, kept as that device's (off and test: the two below). */
  applePushSubscribe: { method: "POST", path: "/api/notify/apple", scope: "mind:read", input: ApplePushInput },
  /** The Android app turns notifications on, for itself: no push service is called; the node keeps each one for it, and the app collects them (the next). */
  collectSubscribe: { method: "POST", path: "/api/notify/collect/on", scope: "mind:read", input: z.strictObject({}) },
  /** What the node kept for this device (one that collects its notifications), handed over once and forgotten; `on` false when its notifications are off. */
  notifyCollect: { method: "POST", path: "/api/notify/collect", scope: "mind:read", input: z.strictObject({}) },
  /** The owner's Apple push key, which the iPhone app's notifications are sent with: sealed, pinned to Apple's push service. A key: vault:write. */
  setApplePushKey: { method: "POST", path: "/api/notify/apple-key", scope: "vault:write", input: ApplePushKeyInput },
  /** Off again: this device's own; another's by id only from a terminal or a device that may administer the fleet. */
  pushUnsubscribe: { method: "POST", path: "/api/notify/unsubscribe", scope: "mind:read", input: z.strictObject({ device: NotifyDeviceRef.optional() }) },
  /** One fixed test message: to the device that asks, or from a terminal to every subscribed device (or the one named). */
  notifyTest: { method: "POST", path: "/api/notify/test", scope: "mind:read", input: z.strictObject({ device: NotifyDeviceRef.optional() }) },
} as const satisfies Record<string, { method: "GET" | "POST"; path: string; scope: Scope | null; input: z.ZodType | null }>;

export type RouteName = keyof typeof routes;
export type RouteInput<R extends RouteName> = (typeof routes)[R]["input"] extends z.ZodType
  ? z.input<(typeof routes)[R]["input"]>
  : undefined;

// ---- Response shapes -------------------------------------------------------

export interface DeviceView {
  id: string;
  name: string;
  kind: "node" | "client";
  role: string;
  scopes: Scope[];
  enrolledAt: string;
  revokedAt: string | null;
  endpoint: string | null;
  caps: Record<string, unknown> | null;
}

export interface PeerStatus {
  device: string;
  online: boolean;
  lastSeen: number | null;
  rttMs: number | null;
  error: string | null;
  /** Live load reported by the peer on its last sync (not stored in the log). */
  presence?: Presence | null;
}

export interface Presence {
  load: number;
  cores: number;
  freeMemoryGb: number;
  onBattery: boolean | null;
  batteryPercent: number | null;
  /** What the node's own work holds now and what waits (absent from older nodes). */
  compute?: ComputeUsage;
}

export interface FleetView {
  fleet: string;
  name: string;
  self: string;
  devices: DeviceView[];
  peers: PeerStatus[];
  events: number;
  digest: string;
}

/**
 * A memory with this tag is a durable fact about you (a preference, a convention, what not to do): yours, written
 * from your device or kept by you, goes with every answer of his; his own (an agent's) is only proposed, and waits
 * for you to keep it (your ruling, 16 November 2026), so nothing he read can plant a standing instruction.
 */
export const ABOUT_YOU_TAG = "about-you";

export interface MemoryView {
  id: string;
  text: string;
  tags: string[];
  device: string;
  via: string | null;
  trust: string;
  hlc: string;
}

export interface SecretView {
  name: string;
  provider: string | null;
  hint: string | null;
  /** The only origin this key is ever sent to. */
  origin: string | null;
  label: string | null;
  updatedAt: string;
  updatedBy: string;
}

export interface SecretRequestView {
  name: string;
  provider: string | null;
  purpose: string;
  requestedAt: string;
  requestedBy: string;
}

export interface ProviderView {
  id: string;
  kind: "openai" | "anthropic";
  baseUrl: string;
  secret: string | null;
  label: string | null;
  hasKey: boolean;
  /** The address its key was added for, when that isn't `baseUrl` (it was pointed elsewhere since): the key isn't sent there. An older node says nothing. */
  keyElsewhere?: string;
}

export interface PairingView {
  invite: string;
  device: string;
  name: string;
  kind: "node" | "client";
  sas: string;
  requestedAt: number;
  conflict: boolean;
}

export interface SandboxView {
  id: string;
  name: string;
  node: string;
  quest: string;
  image: string;
  network: SandboxNetwork;
  cpus: number;
  memoryGb: number;
  createdAt: number;
  expiresAt: number;
  status: string;
  ephemeral: boolean;
  providers: string[];
  /** The workspace's limit and what it uses now; null when this host can't limit disk (see the heartbeat). */
  disk: { limitGb: number; usedGb: number | null } | null;
  /** container (the host's kernel) or vm (its own KVM microVM and kernel). */
  isolation: "container" | "vm";
}

export interface ExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  durationMs: number;
  truncated: boolean;
}

/** A terminal open on a node: in which sandbox, its size, since when, and how it ended (null while its shell runs). */
export interface TerminalView {
  id: string;
  sandbox: string;
  /** The sandbox's name. */
  name: string;
  cols: number;
  rows: number;
  opened: number;
  exitCode: number | null;
  /** Devices watching it now. */
  watchers: number;
}

/** What a watched terminal sends: its output (base64, as bytes), then its shell's exit code when it ends. */
export type TerminalEvent = { type: "output"; data: string } | { type: "exit"; code: number };

export interface LedgerEntry {
  id: string;
  hlc: string;
  device: string;
  class: "read" | "create" | "modify" | "outward" | "delete" | "forbidden";
  resource: string;
  target: string;
  verdict: "allow" | "ask" | "deny" | "approved";
  reason: string | null;
  quest: string | null;
  detail: string | null;
}

export interface LoopRunView {
  loop: string;
  run: string;
  /** The scheduled time it ran for; null when run by hand. */
  slot: number | null;
  status: z.infer<typeof LoopStatus>;
  started: number;
  finished: number;
  summary: string;
  node: string;
}

export interface LoopView {
  name: string;
  schedule: string;
  tz: string;
  on: string;
  onName: string | null;
  enabled: boolean;
  /** null when this node can't read the task (a newer version's, or one this version no longer has): `problem` says which. */
  task: LoopTask | null;
  problem: string | null;
  label: string | null;
  updatedAt: string;
  next: number | null;
  last: LoopRunView | null;
  /** Known only on the node that runs it. */
  running: boolean | null;
  /** What else wakes it (PLAN #13); its webhook's path on the node that runs it, when it has one. */
  wakes: LoopWake[];
  cooldownMs: number;
  hook: string | null;
}

export interface ConnectorRequestView {
  id: string;
  /** The connector asked for. */
  connector: string;
  /** It's installed, and this asks to use it: it's Galahad's alone and the asker isn't allowed yet. */
  access: boolean;
  /** The asker's label, as a connector's access names it. */
  agent: string;
  /** Its name, when Galahad ships it (adding it is then a tap); null for a service he doesn't have yet. */
  label: string | null;
  why: string;
  /** Who asked: Galahad, a knight by name, or an agent's label. */
  by: string;
  at: number;
  /** Unanswered by then, and it's gone. */
  expires: number;
}

/** The Telegram gateway, as the node you asked runs it (telegram.ts). */
export interface TelegramView {
  connected: boolean;
  bot: string | null;
  /** Your Telegram account, once linked. */
  owner: string | null;
  /** Until then, when the code you were given stops working. */
  linkExpires: number | null;
  device: string | null;
  problem: string | null;
  node: string;
}

/** The Slack gateway, as the node you asked runs it (slack.ts). */
export interface SlackView {
  connected: boolean;
  /** The workspace the app is in, and its bot, by name. */
  workspace: string | null;
  bot: string | null;
  /** Your Slack account, once linked. */
  owner: string | null;
  /** Until then, when the code you were given stops working. */
  linkExpires: number | null;
  device: string | null;
  problem: string | null;
  node: string;
}

/**
 * The Slack app Galahad answers through, as Slack makes one from a manifest (api.slack.com/apps → Create New App → From
 * a manifest): Socket Mode, so nothing of yours is opened; your direct messages with it and nothing else
 * (`message.im`), and the files you share there; buttons for an answer's choices; 👀 on your message while he works;
 * your name, to say who it answers.
 */
export const SLACK_APP_MANIFEST = {
  display_information: { name: "Galahad", description: "Your Galahad, in your direct messages.", background_color: "#141416" },
  features: {
    app_home: { home_tab_enabled: false, messages_tab_enabled: true, messages_tab_read_only_enabled: false },
    bot_user: { display_name: "Galahad", always_online: true },
  },
  oauth_config: { scopes: { bot: ["chat:write", "files:read", "im:history", "reactions:write", "users:read"] } },
  settings: {
    event_subscriptions: { bot_events: ["message.im"] },
    interactivity: { is_enabled: true },
    org_deploy_enabled: false,
    socket_mode_enabled: true,
    token_rotation_enabled: false,
  },
} as const;

export interface LoopDraftView {
  id: string;
  name: string;
  schedule: string;
  tz: string;
  /** The node it would run on, by name, when the draft names one. */
  on: string | null;
  task: LoopTask;
  wakes: LoopWake[];
  cooldownMs: number | null;
  label: string | null;
  why: string | null;
  /** Who drafted it: Galahad, in a chat. */
  by: string;
  at: number;
  /** Unanswered by then, and it's gone. */
  expires: number;
  /** Adding it replaces the loop that has its name. */
  replaces: boolean;
}

export interface NoticeView {
  key: string;
  severity: z.infer<typeof NoticeSeverity>;
  title: string;
  body: string;
  source: string;
  node: string | null;
  at: number;
  dismissed: boolean;
}

export interface FindingView {
  key: string;
  severity: z.infer<typeof NoticeSeverity>;
  title: string;
  body: string;
  node?: string;
}

export interface SelfActionView {
  /** Every heartbeat loop lets him fix what's safe himself (none of them says `selfAction: false`). */
  on: boolean;
  /** The heartbeat loops it follows (self-action runs after each of their runs). */
  heartbeats: string[];
  /** The allowlist: each kind, its oath class, and why it needs no asking. */
  allowlist: { kind: string; class: string; why: string }[];
  /** His own fixes, newest first (ledger entries of resource "self-action"). */
  recent: LedgerEntry[];
}

/** One tool in full (connectorTool): what connectors lists in short, and an MCP server's whole argument schema. */
export interface ConnectorToolDefinition {
  connector: string;
  tool: string;
  class: ConnectorToolView["class"];
  asks: boolean;
  /** The server's words for an MCP tool (untrusted text), whole up to 8,000 characters. */
  description: string;
  /** Its arguments as a JSON Schema: an MCP server's own, nested lists and objects included; a template's params. */
  input: unknown;
  /** An MCP tool that differs on its server now from what was installed (galahad connector refresh shows how). */
  changed: boolean;
}

export interface ConnectorToolView {
  name: string;
  description: string;
  /** GET, POST… or MCP. */
  method: string;
  /** The request path with its {placeholders} (where the call goes); null for MCP tools. */
  path: string | null;
  /** An MCP tool's name on its server, and what the server claimed about it (hints only). */
  remote?: string;
  hints?: { readOnly?: boolean; destructive?: boolean } | null;
  class: "read" | "create" | "modify" | "outward" | "delete";
  /** read, create and modify run freely; outward and delete ask you. */
  asks: boolean;
  params: Record<string, { type: string; required: boolean; description: string | null; enum: string[] | null }>;
}

/** A server of the library, and whether it is installed here. */
export interface McpLibraryView extends McpIndexEntry {
  installed: boolean;
}
export interface ConnectorLibraryView {
  entries: McpLibraryView[];
  total: number;
  categories: { name: McpCategory; count: number }[];
  /** The index as this node last read it: where from (null: none is read), when, how many it holds, and why it couldn't be read, if so. */
  index: { url: string | null; fetched: number | null; count: number; problem: string | null };
}

export interface ConnectorView {
  id: string;
  label: string;
  description: string | null;
  /** http: request templates · mcp: a remote MCP server (its tools listed from the server). */
  kind: "http" | "mcp";
  /** An MCP server's endpoint. */
  url: string | null;
  origin: string | null;
  installed: boolean;
  /** none-needed · ready · missing · optional-missing · wrong-origin */
  key: string;
  secret: string | null;
  keyHelp: string | null;
  needsOrigin: boolean;
  problem: string | null;
  tools: ConnectorToolView[];
  /** Galahad's alone (and the agents you allowed, by label), when it isn't every agent's. */
  access: { only: "galahad"; allowed: string[] } | null;
  /** One that signs in as you: whose sign-in, and whose account it's signed in to (null until then). */
  /** A connector you sign in to: whose sign-in (an MCP server's own: `mcp`, no app of yours needed), and whose account, once said. */
  oauth: { provider: "google" | "microsoft" | "mcp"; account: string | null } | null;
  /** What it reads stays in the answer that read it (mail), as the bank's data does. */
  private: boolean;
}

/**
 * How long an approval stays good: the node that filed the action sends it within this of
 * your approval's recorded time, or never (a node back after weeks doesn't send what you
 * approved back then).
 */
export const APPROVAL_TTL_MS = 72 * 60 * 60_000;

/**
 * The last moment an approval may be sent, from recorded times only (so every replica agrees):
 * 72 hours after it was recorded, or never when it was recorded after the request had expired.
 */
export const approvalSendBy = (decidedMs: number, requestExpires: number): number =>
  decidedMs > requestExpires ? requestExpires : decidedMs + APPROVAL_TTL_MS;

export interface ActionView {
  id: string;
  connector: string;
  tool: string;
  args: Record<string, unknown>;
  class: string;
  target: string;
  by: string;
  why: string | null;
  node: string;
  requestedAt: string;
  /** Answer by then, or it's "expired" (no answer means no). */
  expires: number;
  /** "lapsed": approved, but not sent by `sendBy`, so it never will be. */
  state: "waiting" | "approved" | "denied" | "expired" | "lapsed" | "done" | "failed";
  /** For an approval: sent by then or never (approvalSendBy). */
  sendBy: number | null;
  decidedVia: string | null;
  /** The standing order that answered it, when one did. */
  order: { id: string; label: string } | null;
  receipt: string | null;
  /** What you said with your answer; for one you edited, which it was sent as; for one Galahad approved himself, why. */
  note: string | null;
  /** Galahad approved it himself, as his to approve (oath.ts ownApproval; your word of 23 November 2026), not you. */
  self: boolean;
}

/** A line of "while you were away" (PLAN #37): what happened, in its state's colour (done green, failed red, waits amber). */
export interface AwayLine {
  text: string;
  tone: "ok" | "warn" | "danger" | "neutral";
}

export interface AwayView {
  since: number;
  lines: AwayLine[];
}

export interface InvestigationView {
  id: string;
  question: string;
  /** The pre-registration, as recorded before anything ran (null if a newer node wrote a shape this one can't read). */
  registration: Preregistration | null;
  registeredAt: number;
  /** The node that ran it. */
  nodeName: string;
  status: "running" | z.infer<typeof InvestigationStatus>;
  conclusion: Conclusion | null;
  summary: string | null;
  review: string | null;
  artifact: string | null;
  predictions: z.infer<typeof PredictionOutcome>[];
  concludedAt: number | null;
}

export interface TrialView extends TrialRecord {
  id: string;
  recordedAt: number;
  /** The node that ran it. */
  nodeName: string;
  /** What its model calls came to, by role and model (absent: recorded before calls were counted). */
  spent?: TrialSpent;
}

/** The runs that recorded their settings (their effort), by run id. A run not here ran at effort 1. */
export type TrialRunsView = Record<string, TrialRunSettings>;

export interface ArtifactView {
  id: string;
  label: string;
  quest: string | null;
  sandbox: string | null;
  /** The node holding the files. */
  node: string;
  nodeName: string;
  bytes: number;
  count: number;
  /** Up to 200 files (the holding node has them all). */
  files: { path: string; size: number; sha256: string }[];
  savedAt: number;
  /** The files are on the node you asked. */
  here: boolean;
}

export interface OrderView {
  id: string;
  label: string;
  connector: string;
  tool: string;
  class: "outward" | "delete";
  args: Record<string, string>;
  callers: string[] | null;
  until: number;
  /** active · expired · revoked · stale (the tool changed since you signed, so it no longer applies) */
  state: "active" | "expired" | "revoked" | "stale";
  signedAt: number;
  /** The device you signed it from. */
  signedVia: string | null;
  uses: number;
  lastUsed: number | null;
}

export type ChatStreamEvent =
  | { type: "model"; ref: string }
  /** Kept in your history: the conversation this answer belongs to (first, when it's new). */
  | { type: "conversation"; id: string; title: string; project: string | null }
  | { type: "text"; text: string }
  /** Galahad calls one of his tools (input: a short summary of the arguments). */
  | { type: "tool"; id: string; name: string; title: string; input: string }
  /** How it went, in a line (never the whole result). */
  | { type: "tool_result"; id: string; name: string; ok: boolean; summary: string }
  /** Archived entries offered to the model as context for this answer (data, never instructions). */
  | { type: "archive"; entries: ArchiveContextEntry[] }
  | { type: "fallback"; from: string; error: string }
  /**
   * One model call's tokens, as its provider reported them when the call ended (null: it reported nothing,
   * which is said as unknown, never estimated). Counts only: nothing of the prompt or the answer.
   */
  | { type: "usage"; ref: string; usage: Usage | null }
  /** A message of yours reached him while he worked (a steer): what follows answers it, in the same turn. */
  | { type: "steer"; text: string }
  /**
   * First in the stream of a turn the node owns: its id (to attach to, steer or stop), and `answer`, the kept
   * message its first answer is (null: a temporary chat). `replay`: what follows first is what already happened.
   */
  | { type: "turn"; id: string; conversation: string | null; answer: number | null; role: string; startedAt: number; deadline: number; replay: boolean }
  /** It was stopped, and by what (a turn that ran into the node's time limit ends with an error that says so). */
  | { type: "stopped"; reason: StopReason }
  /** Messages of yours that hadn't reached him when the turn ended: queued (held) in a kept chat, handed back otherwise. */
  | { type: "undelivered"; texts: string[]; queued: boolean }
  /** First in a side question's stream: its id, to bring it back by. */
  | { type: "aside"; id: string }
  /**
   * The answer called tools the caller runs (clientTools), and ends here: the caller runs them and asks again with what
   * they came to. `carry`: what the provider needs back with this answer for the work to go on (see ChatMessage).
   */
  | { type: "calls"; calls: ClientCall[]; carry?: string }
  | { type: "done"; ref: string }
  | { type: "error"; error: string };
