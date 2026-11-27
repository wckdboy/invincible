import { z } from "zod";
import { ATTACHMENT_LIMITS } from "./attachments.ts";
import { AttachmentId, AttachmentName, AttachmentRef, AttachmentType } from "./attachment-ref.ts";
export { AttachmentId, AttachmentName, AttachmentRef, AttachmentType };
import { AgentLabel, ConnectorArgs, ToolName } from "./connectors.ts";
import { ActionId, ArtifactId, ConnectorId, LoopName, LoopStatus, NoticeKey, NoticeSeverity, SCREEN_SESSION_MAX_MINUTES, ScreenSessionId, THINKING_EFFORTS } from "./events.ts";
import { Conclusion, InvestigationId, InvestigationStatus, PredictionOutcome, Preregistration } from "./investigations.ts";
import { MAX_ORDER_DAYS, OrderId, OrderPattern } from "./orders.ts";
import { QampGrantInput, QampRevokeInput } from "./qamp.ts";
import { FabricSettingInput, HandId, HandoffGrantInput, HandoffRevokeInput, HandTaskInput } from "./fabric.ts";
import { RuleInput, RuleName, RuleToldInput, RuleTrippedInput } from "./rules.ts";
import { SeatAddInput, SeatIdInput, SeatPolicyInput, SeatServesInput, SeatSignInAnswerInput, SeatSignInCancelInput } from "./seats.ts";
import { type Scope, Scope as ScopeSchema } from "./scopes.ts";
import { EvalRecord, EvalRunId, type EvalRunSettings } from "./evals.ts";
import { HarnessOptions, EvalPins, VariantName } from "./evals.ts";
import type { Usage } from "./spend.ts";
import { PricedModel, PriceSchema, SpendLines, type EvalSpent, UsageBudgetInput } from "./usage.ts";
import { COMPUTER_START, type ComputeUsage, EffortAsk, EffortLevel } from "./compute.ts";
import { DecisionRequest } from "./decisions.ts";
import { CancelLookInput, ConversationId, LookLaterInput, ProjectBranchInput, ProjectCommitInput, ProjectGitInput, ProjectId, ProjectInput } from "./chats.ts";
import { AgentId, AgentInput, TeamBacklogInput, TeamOwnDailyInput, TeamChangesInput, TeamCiInput, TeamEngramInput, TeamShipInput, TeamFileInput, TeamFilesInput, TeamRecruitInput, TeamRemoveInput, TeamRoomId, TeamRoomInput, TeamPostInput, TeamSayInput, TeamSeenInput, TeamTaskId, TeamTaskInput, TeamGiveInput, TeamControlInput, TeamOutcomeControlInput, TeamOutcomeInput, TeamSteerInput, TeamWorkspaceRun, AgentModels } from "./team.ts";
import { RunGates, RunProgressInput } from "./runs.ts";
import { type StopReason, TURN_ID } from "./turns.ts";
import { type ArchiveContextEntry, ArchiveBudgetInput, ArchiveDeleteInput, ArchiveId, ArchiveReindexInput, ArchiveSearchInput, NoteIdeaInput } from "./archive.ts";
import { RunEvidenceInput, SkillApproveInput, SkillId, SkillLockInput, SkillRetireInput, SkillsBudgetInput, SkillWriteInput } from "./skills-input.ts";
import { QUESTION_ID, QUESTION_LIMITS } from "./questions.ts";
import { ApplePushInput, ApplePushKeyInput, LiveActivityInput, NotifyDeviceRef, NotifyPrefsInput, PushSubscriptionInput } from "./notify-input.ts";
import { LIVE_CURSOR } from "./live.ts";

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
 */
export const isReservedGatewayScope = (name: string): boolean => name === "search" || name.startsWith("git:");

/** A model provider's id: a name that isn't one of the gateway's own scopes. */
export const ProviderId = Name.refine((name) => !isReservedGatewayScope(name), {
  message: "search and git:… are your agent's own gateway scopes, not model providers",
});

const ModelRef = z.string().min(3).max(256);

/** A tool the caller runs itself (a run's engineer: its shell, its files), offered to the model by name. */
export const ClientToolName = z.string().regex(/^[a-z][a-z0-9_]{0,40}$/, "a tool's name: lower case, digits and _");
/** A call the model made to one of the caller's own tools (clientTools): its id, the tool, its input as the model gave it. */
export const ClientCall = z.strictObject({ id: z.string().min(1).max(128), name: ClientToolName, input: z.record(z.string(), z.unknown()) });
export type ClientCall = z.infer<typeof ClientCall>;
/**
 * A picture a call's result carries: a computer's screen after its actions (a run's engineer on its VM's desktop). A
 * model that sees is shown it; one that doesn't reads its words.
 */
export const ResultImage = z.strictObject({
  mediaType: z.enum(["image/png", "image/jpeg"]),
  /** Base64. A desktop's whole screen as JPEG is a few hundred kilobytes. */
  data: z.string().min(1).max(4_000_000).regex(/^[A-Za-z0-9+/]+={0,2}$/, "base64"),
  alt: z.string().min(1).max(400),
});
export type ResultImage = z.infer<typeof ResultImage>;
/** What one such call came to, as the caller ran it: its words, and the pictures it shows (two at most). */
export const ClientResult = z.strictObject({ id: z.string().min(1).max(128), content: z.string().max(200_000), error: z.boolean().optional(), images: z.array(ResultImage).min(1).max(2).optional() });
export type ClientResult = z.infer<typeof ClientResult>;

export const ChatMessage = z
  .strictObject({
    role: z.enum(["user", "assistant"]),
    /** Its words: none only for a message of yours that carries attachments, an answer that only calls tools, or results. */
    content: z.string().max(400_000),
    /** Your files with it, kept on the node (uploadAttachment). An answer carries none. */
    attachments: z.array(AttachmentRef).min(1).max(ATTACHMENT_LIMITS.perMessage).optional(),
    /**
     * How hard the model thinks from this message on: a run's loop says it for each turn by what the turn is (brain
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
 * One of several attempts at the same run (effort): the node shows where each is, and counts
 * nothing by it. Its run must be one an effort was granted for; otherwise it's ignored.
 */
export const AttemptTag = z.strictObject({
  run: z.string().regex(/^[A-Za-z0-9._:-]{1,64}$/),
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
  run: z.string().max(64).regex(/^[A-Za-z0-9._:-]+$/).optional(),
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
   * it, the primary fixes what's on the self-action allowlist itself (self-action.ts) unless `selfAction` is false.
   */
  z.strictObject({ kind: z.literal("heartbeat"), checklist: z.string().max(4000).optional(), selfAction: z.boolean().optional() }),
  /** A run in a fresh sandbox: plan, work, independent review, remembered. */
  z.strictObject({
    kind: z.literal("run"),
    goal: z.string().min(1).max(4000),
    network: SandboxNetwork,
    maxSteps: z.number().int().min(1).max(100).optional(),
    /** Gates (runs.ts): each must exit 0 in the run's sandbox before the reviewer is asked. */
    gates: RunGates.optional(),
  }),
  /** One connector tool; outward and delete tools file an approval request instead. */
  z.strictObject({ kind: z.literal("call"), connector: ConnectorId, tool: ToolName, args: ConnectorArgs.optional() }),
  /**
   * Tell you (PLAN #37): a notice in your Inbox each run, with what woke it, and on your phone your loop's name. No
   * model, no sandbox: "tell me when my boss emails", or a reminder on a schedule. `text`: what to say, in your words.
   */
  z.strictObject({ kind: z.literal("tell"), text: z.string().trim().min(1).max(200).optional() }),
]);
export type LoopTask = z.infer<typeof LoopTask>;

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
 * A loop the primary drafted because you asked for one in chat ("every weekday at 8, check my open PRs"). It is only a
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
  /** What you asked for, in its words: shown with the draft. */
  why: z.string().max(500).optional(),
});

/**
 * A connector an agent asked you for (The primary, an agent, an agent over MCP): one the primary ships that isn't installed, or
 * a service it doesn't have at all. Like a key's request it waits in your Inbox, and in the chat it was asked in, with
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
  reflect: "its journal, removed on 14 November 2026; what it wrote is still in its memory",
};

/** A place on an agent's screen, in its pixels. */
const ScreenPx = z.number().int().min(0).max(10_000);
/** One thing done on an agent's desktop from outside its VM (`look`: nothing, only the picture). */
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
 * One thing done on a Mac's own screen (docs/MAC.md, the Mac itself): an agent's desktop's actions, in its words and
 * places (its xdotool key names, a turn of the wheel), and an app opened by its name. A place is in the screen's points.
 */
export const ScreenAction = z.discriminatedUnion("do", [...DesktopAction.options, z.strictObject({ do: z.literal("app"), name: AppName })]);
export type ScreenAction = z.infer<typeof ScreenAction>;

/**
 * One thing the primary does on a Mac itself, in a session you allowed: a thing done on its screen, or a shell command run
 * as its user in its home (`run`, held to your tripwires).
 */
export const ScreenUseAction = z.discriminatedUnion("do", [
  ...ScreenAction.options,
  z.strictObject({ do: z.literal("run"), command: z.string().min(1).max(100_000), timeoutSec: z.number().int().min(1).max(900).optional() }),
]);
export type ScreenUseAction = z.infer<typeof ScreenUseAction>;

/** What one thing it did on a Mac itself came to: a picture of its screen after it, or what a command printed. */
export interface ScreenUse {
  node: string;
  nodeName: string;
  session: string;
  view?: ScreenView;
  front?: string;
  ran?: ExecResult;
}

/** A Mac's own screen, as the node that has it says: its size in points, and whether macOS lets the primary record it and control it. */
export interface ScreenStatus {
  node: string;
  width: number;
  height: number;
  record: boolean;
  control: boolean;
  /** The app in front, and its window's title where macOS lets the primary read it. */
  front: string;
  /** The app in front's bundle id. */
  frontId?: string;
  /** A question of macOS's on the screen (a permission's consent, a password), by the process showing it; null: none. */
  asking?: string | null;
}

/** A picture of a screen, as an agent's desktop and a Mac's own give it: JPEG, at the screen's size. */
export interface ScreenView {
  shot: { mediaType: "image/jpeg"; data: string };
  width: number;
  height: number;
}

/**
 * Where the live stream stood (core's live.ts): the `at` of its hello and each change, and the `since` it is opened
 * again from (GET /api/live?since=<cursor>). The node reads `since` through this alone; one that isn't a cursor is no
 * cursor (a fresh hello), never a refusal.
 */
export const LiveCursor = z.string().regex(LIVE_CURSOR);

export const routes = {
  team: { method: "GET", path: "/api/team", scope: "chat", input: null },
  saveAgent: { method: "POST", path: "/api/team/agents", scope: "fleet:admin", input: AgentInput },
  /** The models you may set an agent to work on: the roster's, then each local model a node of the fleet serves, and where. */
  teamModels: { method: "GET", path: "/api/team/models", scope: "mind:read", input: null },
  saveTeamRoom: { method: "POST", path: "/api/team/rooms", scope: "fleet:admin", input: TeamRoomInput },
  /** Yours alone: the agents' order, and who leads the agents. */
  directAgent: { method: "POST", path: "/api/team/direct", scope: "fleet:admin", input: z.strictObject({ id: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,31}$/) }) },
  teamRoom: { method: "POST", path: "/api/team/room", scope: "chat", input: z.strictObject({ id: z.string().min(1).max(80) }) },
  /** What a task did, as it happened: its kept lines after number `after`, a page at a time, with the task's status now. Yours to read, like a room. */
  teamTrail: { method: "POST", path: "/api/team/trail", scope: "chat", input: z.strictObject({ task: TeamTaskId, after: z.number().int().min(0).max(10_000_000).optional() }) },
  /** The steps of a task that another can be started from (PLAN #15): `{ steps: TeamCheckpoint[] }`, the first first. */
  teamSteps: { method: "POST", path: "/api/team/steps", scope: "chat", input: z.strictObject({ task: TeamTaskId }) },
  /** How often an agent's scripts used each key of yours it was given, through the key gateway, in the last thirty days (PLAN #17). */
  teamKeyUses: { method: "POST", path: "/api/team/key-uses", scope: "chat", input: z.strictObject({ id: AgentId }) },
  /** You have looked at an agent's page or a room, on whichever device: what ended there so far is no longer new (`team`'s `seen`). */
  seeTeam: { method: "POST", path: "/api/team/seen", scope: "chat", input: TeamSeenInput },
  postTeamMessage: { method: "POST", path: "/api/team/messages", scope: "fleet:admin", input: TeamPostInput },
  createTeamTask: { method: "POST", path: "/api/team/tasks", scope: "fleet:admin", input: TeamTaskInput },
  /** Outcomes the primary owns (PLAN #43): each with its room, budget and spend, its tasks and its plan. */
  teamOutcomes: { method: "GET", path: "/api/team/outcomes", scope: "chat", input: null },
  /**
   * Give it an outcome to own: its room is made with the agents you named, and it gives them tasks on its own within
   * its budget (your ruling of 18 November). Yours alone, as giving work is.
   */
  setTeamOutcome: { method: "POST", path: "/api/team/outcomes", scope: "fleet:admin", input: TeamOutcomeInput },
  controlTeamOutcome: { method: "POST", path: "/api/team/outcomes/control", scope: "fleet:admin", input: TeamOutcomeControlInput },
  /** The primary takes on an outcome you asked it to own, in your conversation (its team_outcome; leads the team, as giveToTeam). */
  primaryOutcome: { method: "POST", path: "/api/team/primary-outcome", scope: "mind:write", input: TeamOutcomeInput },
  /** A task given to the agents: the agent best suited to it takes it, and the answer says who and why (everyone considered, each with its reasons). */
  giveTeamTask: { method: "POST", path: "/api/team/give", scope: "fleet:admin", input: TeamGiveInput },
  controlTeam: { method: "POST", path: "/api/team/control", scope: "fleet:admin", input: TeamControlInput },
  /**
   * Your words to a running task (a steer), as giving and stopping one are yours: its run takes them at its next safe
   * point, its trail says them there ("You: …"), and its reviewer judges the work against its goal and every steer, in
   * order. A task that isn't running is refused in words (409), and one that has taken TEAM_LIMITS.steers (429).
   * Answers `{ task, steer }`: the task as it stands, with its steers, and this one.
   */
  steerTeamTask: { method: "POST", path: "/api/team/steer", scope: "fleet:admin", input: TeamSteerInput },
  /** Yours alone, and for good. A worker with a VM goes only with `destroyWorkspace`, from a device that also holds `sandbox`. */
  removeAgent: { method: "POST", path: "/api/team/remove", scope: "fleet:admin", input: TeamRemoveInput },
  teamMemory: { method: "POST", path: "/api/team/memory", scope: "fleet:admin", input: z.strictObject({ id: z.string().min(1).max(32), text: z.string().max(20000) }) },
  /** The VMs' notes store (Engram) for this node's agents: on or off, and yours alone to say. `team` says when it is on; an agent's `teamWorkspace` says whether its VM has it. */
  teamEngram: { method: "POST", path: "/api/team/engram", scope: "fleet:admin", input: TeamEngramInput },
  /** Whether a pull request's failing checks go back to the agent whose work it was, outside an outcome too (PLAN #29): yours alone to say. `team` says when it is on. */
  teamCi: { method: "POST", path: "/api/team/ci", scope: "fleet:admin", input: TeamCiInput },
  /** Whether the primary offers idle agents work from your backlog: one task a day at most for each, which it approves itself when its cost fits its rule (at most $3, within what it may commit on its own: what is left of your budget past what approved work holds, or its daily cap), and which otherwise waits for you. */
  teamBacklog: { method: "POST", path: "/api/team/backlog", scope: "fleet:admin", input: TeamBacklogInput },
  /** What the primary may commit on its own word in a day while you set no usage budget (the budgets of the tasks it gives, and of the proposals it approves itself): yours alone to say, never its. `team` says it. */
  teamOwnDaily: { method: "POST", path: "/api/team/own-daily", scope: "fleet:admin", input: TeamOwnDailyInput },
  /** An agent's verified work as a pull request, on your word (PLAN #37): filed as its agent's ship and answered by you at once, so the outbox (and the CI watcher) has it. */
  shipTeamTask: { method: "POST", path: "/api/team/ship", scope: "fleet:admin", input: TeamShipInput },
  /* The primary's own way to the other agents, from your conversation with it (its tools: team, team_recruit, team_message,
   * team_give, team_steer).
   * Refused to everyone else whatever their scopes, you included: the routes above are yours. */
  teamOverview: { method: "POST", path: "/api/team/overview", scope: "mind:read", input: z.strictObject({ room: TeamRoomId.optional() }) },
  recruitAgent: { method: "POST", path: "/api/team/recruit", scope: "mind:write", input: TeamRecruitInput },
  sayToTeam: { method: "POST", path: "/api/team/say", scope: "mind:write", input: TeamSayInput },
  /** Its work for the agents: the agent best suited to it takes it, as when you give one; within its allowance for the day. */
  giveToTeam: { method: "POST", path: "/api/team/primary-give", scope: "mind:write", input: TeamGiveInput },
  /** Its words to a running task (its team_steer), as yours reach one: said as its ("Your agent: …"), and within the task's steers. */
  primarySteer: { method: "POST", path: "/api/team/primary-steer", scope: "mind:write", input: TeamSteerInput },
  teamWorkspace: { method: "POST", path: "/api/team/workspace", scope: "sandbox", input: z.strictObject({ id: z.string().min(1).max(32) }) },
  /** A folder of an agent's workspace (its VM's /work; `primary`: its computer's), read; yours alone. */
  teamFiles: { method: "POST", path: "/api/team/files", scope: "sandbox", input: TeamFilesInput },
  /** One file of an agent's workspace, read: text with anything like a key redacted, a picture, or what it is. */
  teamFile: { method: "POST", path: "/api/team/file", scope: "sandbox", input: TeamFileInput },
  /** What an agent's task changed in its repository (its latest task with none named): the files and the diff. */
  teamChanges: { method: "POST", path: "/api/team/changes", scope: "sandbox", input: TeamChangesInput },
  provisionAgent: {
    method: "POST", path: "/api/team/provision", scope: "fleet:admin",
    input: z.strictObject({
      id: z.string().min(1).max(32), on: NodeRef.optional(), cpus: z.number().min(0.25).max(64).default(COMPUTER_START.cpus), memoryGb: z.number().min(0.25).max(512).default(COMPUTER_START.memoryGb), diskGb: z.number().int().min(1).max(2048).default(COMPUTER_START.diskGb),
      /**
       * What the agent's VM can reach: `online` (the internet and the model gateway: the owner's word is that
       * agents can use the internet) or `gateway` (the model gateway and nothing else). Set when the VM is made:
       * a microVM's network can't be changed afterwards.
       */
      network: z.enum(["online", "gateway"]).default("online"),
      /** A desktop in its VM (a display, a window manager, a browser) for work that needs a screen. Set when the VM is made, or made again. */
      desktop: z.boolean().optional(),
    }),
  },
  /**
   * An agent's VM made again from its image as it is now, on your word: the same VM and `/work`, a new
   * container, so a fix to the image (or a newer tool in it) reaches an agent that was made before it. Its
   * network may be chosen again with it. Refused while the agent is working. Yours alone, like its removal.
   */
  remakeAgent: {
    method: "POST", path: "/api/team/remake", scope: "fleet:admin",
    input: z.strictObject({ id: z.string().min(1).max(32), network: z.enum(["online", "gateway"]).optional(), /** With a desktop from now on (true), or without one (false); absent: as it is. */ desktop: z.boolean().optional() }),
  },
  /** The same, asked of the node that hosts the VM by the team's controller (never by an agent). */
  remakeTeamWorkspace: {
    method: "POST", path: "/api/team/remake-workspace", scope: "fleet:admin",
    input: z.strictObject({
      id: SandboxId, on: NodeRef.optional(), run: TeamWorkspaceRun, providers: z.array(z.string().min(1).max(64)).max(16), network: z.enum(["online", "gateway"]).optional(), desktop: z.boolean().optional(),
      /** The device whose word it was, when a node passes the request on to the VM's host. */
      onBehalfOf: z.string().max(100).optional(),
    }),
  },
  /**
   * An agent's VM made bigger while it runs, on your word: more threads, memory or disk, with nothing stopped and its
   * work kept (the microVM takes threads and memory as it runs; its workspace grows where it is mounted). What it adds
   * must fit this node's ceiling. Never smaller this way: a smaller size takes effect when the VM is made again.
   */
  resizeAgent: {
    method: "POST", path: "/api/team/resize", scope: "fleet:admin",
    input: z
      .strictObject({ id: z.string().min(1).max(32), cpus: z.number().min(0.25).max(64).optional(), memoryGb: z.number().min(0.25).max(512).optional(), diskGb: z.number().int().min(1).max(4096).optional() })
      .refine((input) => input.cpus !== undefined || input.memoryGb !== undefined || input.diskGb !== undefined, "say what it should have: cpus, memoryGb or diskGb"),
  },
  /**
   * The primary gives an agent's VM (or its own computer, id "primary") more while it runs, itself, when its work needs it
   * (your ruling, 16 November 2026): only more, never past the ceiling, and the ledger says it was it and why. Its alone,
   * from your conversation with it; you give a VM more with resizeAgent.
   */
  growAgent: {
    method: "POST", path: "/api/team/grow", scope: "sandbox",
    input: z
      .strictObject({ id: z.string().min(1).max(32), cpus: z.number().min(0.25).max(64).optional(), memoryGb: z.number().min(0.25).max(512).optional(), diskGb: z.number().int().min(1).max(4096).optional(), why: z.string().trim().min(3).max(300) })
      .refine((input) => input.cpus !== undefined || input.memoryGb !== undefined || input.diskGb !== undefined, "say what it should have: cpus, memoryGb or diskGb"),
  },
  /**
   * The primary's own computer, worked on by it alone (its `computer` tool): one command in its VM, run as an agent's task
   * runs its own, with the model gateway, and its eyes when the roster names a model for them. Everyone else is refused.
   */
  computerExec: { method: "POST", path: "/api/team/computer", scope: "sandbox", input: z.strictObject({ command: z.string().min(1).max(100_000), timeoutSec: z.number().int().min(1).max(900).optional() }) },
  /** The same, asked of the node that hosts the VM by the team's controller (never by an agent). */
  resizeTeamWorkspace: {
    method: "POST", path: "/api/team/resize-workspace", scope: "fleet:admin",
    input: z.strictObject({
      id: SandboxId, on: NodeRef.optional(), run: TeamWorkspaceRun,
      cpus: z.number().min(0.25).max(64).optional(), memoryGb: z.number().min(0.25).max(512).optional(), diskGb: z.number().int().min(1).max(4096).optional(),
      /** The device whose word it was, when a node passes the request on to the VM's host. */
      onBehalfOf: z.string().max(100).optional(),
      /** When the primary grew it itself (growAgent): why, which the ledger keeps. */
      why: z.string().trim().min(3).max(300).optional(),
    }),
  },
  /**
   * An agent's desktop, for you to watch and to take over (to sign in for it, to get it past something): one
   * thing done there, or nothing (`look`), and a picture of the screen back; none with `picture` false (while you
   * watch its stream: teamDesktopStream). Yours alone. What you type is carried to the VM and never written to the
   * ledger. Your input takes the desktop over if no one has it (teamDesktopTake), and each answer says whether you
   * have it (`held`).
   */
  teamDesktop: { method: "POST", path: "/api/team/desktop", scope: "sandbox", input: z.strictObject({ id: z.string().min(1).max(32), action: DesktopAction.default({ do: "look" }), picture: z.boolean().optional() }) },
  /** The same, asked of the node that hosts the VM by the team's controller. */
  teamDesktopOn: { method: "POST", path: "/api/team/desktop-workspace", scope: "sandbox", input: z.strictObject({ id: SandboxId, on: NodeRef.optional(), run: TeamWorkspaceRun, action: DesktopAction, picture: z.boolean().optional() }) },
  /**
   * You take an agent's desktop over (C1 step 9): it is yours until you give it back, or 120 s pass with no input
   * from you, or 15 min at most; a second take starts a fresh window. Meanwhile its own desktop commands and its
   * looks wait, and are told so. Yours alone. Whether you have it after (`held`).
   */
  teamDesktopTake: { method: "POST", path: "/api/team/desktop/take", scope: "sandbox", input: z.strictObject({ id: z.string().min(1).max(32) }) },
  /** You give an agent's desktop back: its desktop commands go on. Yours alone. */
  teamDesktopRelease: { method: "POST", path: "/api/team/desktop/release", scope: "sandbox", input: z.strictObject({ id: z.string().min(1).max(32) }) },
  /** Taking over or giving back, asked of the node that hosts the VM by the team's controller. */
  teamDesktopHoldOn: { method: "POST", path: "/api/team/desktop-workspace/hold", scope: "sandbox", input: z.strictObject({ id: SandboxId, on: NodeRef.optional(), run: TeamWorkspaceRun, take: z.boolean() }) },
  /**
   * An agent's desktop as you watch it (C1 step 9): its frames as they come (desktop-frames.ts, DESKTOP_FRAMES_TYPE),
   * H.264 from a keyframe, for as long as you read them. One encoder in its VM however many of your devices watch,
   * and none while none does. Yours alone.
   */
  teamDesktopStream: { method: "POST", path: "/api/team/desktop/stream", scope: "sandbox", input: z.strictObject({ id: z.string().min(1).max(32) }) },
  /** The same, asked of the node that hosts the VM by the team's controller, and relayed through it as it comes. */
  teamDesktopStreamOn: { method: "POST", path: "/api/team/desktop-workspace/stream", scope: "sandbox", input: z.strictObject({ id: SandboxId, on: NodeRef.optional(), run: TeamWorkspaceRun }) },
  /** A Mac's own screen (`on`: another node's): its size, and what macOS lets the primary do with it. Yours alone. */
  screen: { method: "POST", path: "/api/screen", scope: "fleet:admin", input: z.strictObject({ on: NodeRef.optional() }) },
  /**
   * Shows macOS's own prompts on that Mac's screen, to let the primary record it and control it (or lists the app in System
   * Settings for you to turn on): answered there, once, by you.
   */
  screenAllow: { method: "POST", path: "/api/screen/allow", scope: "fleet:admin", input: z.strictObject({ on: NodeRef.optional() }) },
  /**
   * A Mac's own screen, for you to watch and take over: one thing done there, or nothing (`look`), and a picture back.
   * Yours alone; what you type is carried to it and never written to the ledger.
   */
  screenDesktop: { method: "POST", path: "/api/screen/desktop", scope: "fleet:admin", input: z.strictObject({ on: NodeRef.optional(), action: ScreenAction.default({ do: "look" }) }) },
  /** Sessions on a Mac's own screen the primary asked for, the newest first, each where it stands now (core's screen.ts). */
  screenSessions: { method: "GET", path: "/api/screen/sessions", scope: "mind:read", input: null },
  /**
   * The primary asks to use a Mac itself for a while (`on`: which, where the fleet has more than one): its alone, in your
   * conversation with it. An approve card goes to your devices; nothing of that Mac is its until you allow it.
   */
  askScreen: {
    method: "POST", path: "/api/screen/ask", scope: "sandbox",
    input: z.strictObject({ on: NodeRef.optional(), why: z.string().trim().min(3).max(500), minutes: z.number().int().min(1).max(SCREEN_SESSION_MAX_MINUTES) }),
  },
  /** Your answer to its ask, yours alone: allowed (its for its minutes, from now) or not. */
  decideScreen: { method: "POST", path: "/api/screen/decide", scope: "fleet:admin", input: z.strictObject({ id: ScreenSessionId, allow: z.boolean() }) },
  /** A session over before its time: ended by you, or by it once it's done. */
  endScreen: { method: "POST", path: "/api/screen/end", scope: "chat", input: z.strictObject({ id: ScreenSessionId }) },
  /**
   * One thing the primary does on a Mac itself (its alone, in a session you allowed: the Mac checks it from its own copy of
   * the log before anything is done), and a picture of its screen after it, or what a command printed.
   */
  screenUse: { method: "POST", path: "/api/screen/use", scope: "sandbox", input: z.strictObject({ on: NodeRef.optional(), action: ScreenUseAction }) },
  prepareTeamWorkspace: {
    method: "POST", path: "/api/team/prepare-workspace", scope: "fleet:admin",
    input: z.strictObject({
      id: SandboxId,
      on: NodeRef.optional(),
      run: TeamWorkspaceRun,
      repository: z.string().regex(/^https:\/\/github\.com\/[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}\/?$/).optional(),
      /** What the task's lease covers: the providers with a key now (absent: what the VM was made with). */
      providers: z.array(z.string().min(1).max(64)).max(16).optional(),
      /** Work in sensitive mode (heldModels): the lease is good for these models alone (absent: any of its providers'). */
      models: AgentModels.min(1).optional(),
      /** The keys of yours its agent may use but never see (PLAN #17), as the key gateway reads them: key:<secret>:<header>:<read|write>. */
      keys: z.array(z.string().regex(/^key:[A-Za-z0-9._-]{1,64}:[a-z][a-z0-9-]{0,63}:(read|write)$/)).max(16).optional(),
    }),
  },
  /** An agent's lease kept while its task runs (its controller asks every ten minutes): `{ renewed }`. A lapsed one isn't brought back. */
  renewTeamWorkspace: {
    method: "POST", path: "/api/team/renew-workspace", scope: "fleet:admin",
    input: z.strictObject({ id: SandboxId, on: NodeRef.optional(), run: TeamWorkspaceRun }),
  },
  whoami: { method: "GET", path: "/api/whoami", scope: null, input: null },
  /**
   * What changed, as it changes (core's live.ts): one answer that stays open, server-sent events naming the routes whose
   * answers changed, never what they hold, each only to a device that holds that route's scope. Your devices' alone; it
   * ends when the device is revoked or its scopes change, and when the node stops. Opened again from where it left off
   * with `?since=<cursor>` (LiveCursor, above), its hello says what changed since.
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
   * What it knows of you (ABOUT_YOU_TAG): the facts you kept, which go with every answer of its, and the ones it
   * proposed, which wait for you. Yours to read from any device that may read the mind.
   */
  aboutYou: { method: "GET", path: "/api/about-you", scope: "mind:read", input: null },
  /** Keep a fact it proposed (or reword one you kept): yours alone, never an agent's. It goes with its answers from then on. */
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
  /** A key it asked for that no longer matters (or that you won't give): out of your Inbox until it asks again. Yours: the
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
   * Check what a model can do (models/checks.ts): follow the run loop's format, read a screen, place a click on
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
      /**
       * What this answer is to be independent of (a review, usually): a model, or each of a list (every model that did the
       * work, and for a tool on its own sign-in its vendor's family, `family:<word>`). Its candidates that are any of them
       * are asked last.
       */
      apart: z.union([ModelRef, z.array(ModelRef).min(1).max(16)]).optional(),
      messages: z.array(ChatMessage).min(1).max(500),
      /** The primary's tools, within the caller's scopes (default). Runs turn them off: their roles have their own. */
      tools: z.boolean().optional(),
      /**
       * Tools the caller runs itself (a run's engineer: its shell and its files, in its own sandbox), offered to the
       * model. The node never runs one: an answer that calls them ends with a `calls` event, and the next request
       * carries what they came to. Only with the primary's own tools off, and never in a kept chat.
       */
      clientTools: z
        .array(
          z.strictObject({
            name: ClientToolName,
            description: z.string().min(1).max(4000),
            inputSchema: z.record(z.string(), z.unknown()),
            /**
             * The provider's own tool it stands for (C1 step 8): Claude's computer toolset, offered to a model that takes
             * it and to no other (models' COMPUTER, nativeComputer). Its calls come back named by the toolset's members.
             */
            native: z.literal("computer").optional(),
          }),
        )
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
       * the answer has tools, off without them; runs turn it on for the plan only.
       */
      archive: z.boolean().optional(),
      /**
       * Recall what the mind holds that bears on it (default yes). An eval of your own work's run goes without: the
       * mind may hold what the task it replays taught, and an eval is never handed its answer.
       */
      memories: z.boolean().optional(),
      /** Start the role's models at this position: each parallel attempt takes another one first (the rest stay its fallbacks). */
      rotate: z.number().int().min(0).max(15).optional(),
      /** This call is one attempt's (effort): the census counts it as that attempt's, not its own. */
      attempt: AttemptTag.optional(),
      /**
       * This call is a run of its own (its planner's or its engineer's): the skills that bear on its goal go
       * with it, fenced as data, chosen once and the same for every call of that run (skills.ts), and their
       * use is counted against it. Only its own runs (yours from a terminal, a loop's): never an agent's.
       */
      run: z.strictObject({ id: z.string().regex(/^[A-Za-z0-9._:-]{1,64}$/), goal: z.string().min(1).max(4000) }).optional(),
      /**
       * This call is coding work (a run's planner, engineer or reviewer): a coding plan's models may answer
       * it, called as the primary. Without it a plan's models are passed over, as for any talk with it.
       */
      coding: z.boolean().optional(),
      /**
       * This call spends a budget of yours (a run given --budget-usd): only a model whose spend it can count answers
       * it, one you've priced or one on the node's own machine. Any other is passed over, saying why.
       */
      budgeted: z.boolean().optional(),
      /**
       * This call is a turn of a run's work loop (a command a reply), whichever role answers it: the engineer's,
       * or the planner's once a gate has failed twice in a row. A model checked as not following the loop's
       * format is passed over for it, as for the engineer's own turns.
       */
      loop: z.boolean().optional(),
    })
      .refine((c) => !c.clientTools || c.tools === false, "tools the caller runs go without your agent's own (tools: false)")
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
  /** What is under way in a chat of yours: its agents' tasks given there that haven't ended (Stop on each), its looks that wait. */
  underway: { method: "POST", path: "/api/conversations/underway", scope: "chat", input: z.strictObject({ id: ConversationId }) },
  /** A look it sets itself (its look_later, as it answers in a chat of yours): only the primary itself, from inside the node. */
  lookLater: { method: "POST", path: "/api/looks/set", scope: "chat", input: LookLaterInput },
  /** Its looks that wait, in every chat of yours. */
  looks: { method: "GET", path: "/api/looks", scope: "chat", input: null },
  /** One of its looks, called off: by you, or by it in the chat it is in. */
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
   * Turns the node owns (turns.ts): a chat turn of yours (the chat route, with its tools) runs on the node to
   * its end whether or not anyone is listening. Yours alone, like your chats: never an agent's. A temporary chat's
   * turn is watched and steered only by the device that started it.
   */
  /** The turns running on this node now, and its limits. */
  turns: { method: "GET", path: "/api/turns", scope: "chat", input: null },
  /** Watch a turn from its start to its end (server-sent events): what happened so far, then live. Leaving doesn't stop it. */
  attachTurn: { method: "POST", path: "/api/turns/attach", scope: "chat", input: z.strictObject({ turn: TurnId }) },
  /** Stop a turn: the only thing that does, besides the node's own limit for one turn. */
  stopTurn: { method: "POST", path: "/api/turns/stop", scope: "chat", input: z.strictObject({ turn: TurnId }) },
  /** Steer: your message reaches it at the next safe point, and the turn goes on with it. */
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
   * and done so far, without its tools, and added to nothing. The working turn never sees it unless you
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
  /** The runs in hand on this node and the ones that just ended: each one's plan, the step it's on, its gates' last results. */
  runs: { method: "GET", path: "/api/runs", scope: "mind:read", input: null },
  /** Whoever runs a run says where it stands (whoever may run its sandbox may: the sandbox scope). */
  runProgress: { method: "POST", path: "/api/runs/progress", scope: "sandbox", input: RunProgressInput },
  projects: { method: "GET", path: "/api/projects", scope: "mind:read", input: null },
  /** A project's instructions steer the primary, so setting one is yours (brain:write: never an agent's). */
  setProject: { method: "POST", path: "/api/projects", scope: "brain:write", input: ProjectInput },
  removeProject: { method: "POST", path: "/api/projects/remove", scope: "brain:write", input: z.strictObject({ id: ProjectId }) },
  /** The Build view's git on a project's checkout on its computer (docs/BUILD.md), yours alone: how it stands. */
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
      run: z.string().max(64).optional(),
    }),
  },
  /**
   * A coding agent's run in a sandbox followed as it goes (the agents package's FOLLOW, harnesses.ts): its events from
   * byte `offset` of its events file as they are written, one long-lived command in the sandbox that runs only that
   * fixed script, never a command of the caller's. Answered as lines (application/x-ndjson) that end with the run, or at
   * that script's time; asked of the node the sandbox is on, it is followed there and its lines passed back.
   */
  followSandbox: {
    method: "POST",
    path: "/api/sandboxes/follow",
    scope: "sandbox",
    input: z.strictObject({
      id: SandboxId,
      offset: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
      on: NodeRef.optional(),
      /** Set by a full node relaying an arm's request: the arm may only follow its own sandboxes. */
      run: z.string().max(64).optional(),
    }),
  },
  /**
   * What a sandbox's own calls through its node's gateway have come to (a coding agent's, a script's), by model, as that
   * node counted them by the sandbox's token: `{ lines: UsageLine[] }`, role "tool". `invincible do` counts them in its
   * budget. Asked of the node the sandbox is on; an agent, of its own sandboxes only.
   */
  sandboxSpend: {
    method: "POST",
    path: "/api/sandboxes/spend",
    scope: "sandbox",
    input: z.strictObject({
      id: SandboxId,
      /** Calls since then (ms; absent: all it made, as for a fresh sandbox). An agent's VM outlives its tasks. */
      since: z.number().int().min(0).optional(),
      on: NodeRef.optional(),
      /** Set by a full node relaying an arm's request: the arm may only ask of its own sandboxes. */
      run: z.string().max(64).optional(),
    }),
  },
  /**
   * Terminals in this node's sandboxes (an agent's VM, one of yours), for you alone: a login shell on a real terminal.
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
      /** Set by a full node relaying an arm's request: cleanup of that run's own sandboxes only. */
      run: z.string().max(64).optional(),
    }),
  },
  /**
   * A commit of a GitHub repository put in one of your sandboxes that isn't an agent's VM (an eval of your own work's),
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
    input: z.strictObject({ on: NodeRef.optional(), lab: z.boolean().optional(), desktop: z.boolean().optional() }),
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
  loopDrafts: { method: "GET", path: "/api/loops/drafts", scope: "mind:read", input: null },
  /** Telegram (PLAN #19): whether a bot of yours talks to the primary through this node, and which account it answers. */
  telegram: { method: "GET", path: "/api/telegram", scope: "mind:read", input: null },
  /**
   * Connect a bot of yours (its token from BotFather, checked with Telegram and sealed in the vault). The gateway
   * becomes a device of its own (chat and mind:read only), and the code it answers, sent to the bot from your account,
   * links that account. Again: a new code (another bot forgets the account it had).
   */
  telegramConnect: { method: "POST", path: "/api/telegram/connect", scope: "fleet:admin", input: z.strictObject({ token: z.string().trim().min(20).max(100) }) },
  /** Stop: the bot's token goes, and the gateway's device is revoked. Its chats stay yours. */
  telegramDisconnect: { method: "POST", path: "/api/telegram/disconnect", scope: "fleet:admin", input: z.strictObject({}) },
  /** Slack (PLAN #19): whether an app of yours talks to the primary through this node, in which workspace, and which account it answers. */
  slack: { method: "GET", path: "/api/slack", scope: "mind:read", input: null },
  /**
   * Connect an app of yours (made from SLACK_APP_MANIFEST): its app-level token (Socket Mode) and its bot token, checked
   * with Slack and sealed in the vault. The gateway becomes a device of its own (chat and mind:read only), and the code
   * it answers, sent to the app from your account, links that account. Again: a new code (another app forgets the account).
   */
  slackConnect: { method: "POST", path: "/api/slack/connect", scope: "fleet:admin", input: z.strictObject({ appToken: z.string().trim().min(20).max(400), botToken: z.string().trim().min(20).max(400) }) },
  /** Stop: the app's tokens go, and the gateway's device is revoked. Its chats stay yours. */
  slackDisconnect: { method: "POST", path: "/api/slack/disconnect", scope: "fleet:admin", input: z.strictObject({}) },
  /** The primary's draft of a loop you asked for in chat: never a loop until you add it (setLoop, brain:write). */
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
  /** Whether the primary fixes what's on the self-action allowlist itself after each heartbeat, and what it fixed lately. */
  selfAction: { method: "GET", path: "/api/self-action", scope: "mind:read", input: null },
  /** The owner's switch for self-action (on by default). It steers the primary, so it's brain:write: never an agent's. */
  setSelfAction: { method: "POST", path: "/api/self-action", scope: "brain:write", input: z.strictObject({ on: z.boolean() }) },
  connectors: { method: "GET", path: "/api/connectors", scope: "mind:read", input: null },
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
      /** A remote MCP server: the primary lists its tools now (again, to refresh) and keeps the classes you chose. */
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
  /** Let an agent use a connector that's the primary's alone, or stop it again. It answers that agent's request for it. */
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
       * You, asking to be asked: file it for approval like an agent's call (on behalf of a run
       * you started), instead of running it now. Standing orders still answer it.
       */
      ask: z.strictObject({ run: z.string().regex(/^q-[a-z0-9]{1,16}$/).optional() }).optional(),
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
   * asked: agents' tasks that ended, its outcomes' reports and questions, loops that failed, and what waits for you now.
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
  evals: { method: "GET", path: "/api/evals", scope: "mind:read", input: null },
  /**
   * Record a graded eval, once. brain:write (never an arm's): the Index decides what
   * the primary keeps, so the thing being measured can't write its own marks.
   */
  recordEval: {
    method: "POST",
    path: "/api/evals",
    scope: "brain:write",
    /** `spent`: what its model calls came to, by role and model (counts only), recorded beside it (`eval.spent`). */
    input: EvalRecord.extend({ spent: SpendLines.optional() }),
  },
  /** A run's settings (its effort, what it pinned, its variant, its budget), recorded once when it starts: the reports read them. */
  startEvalRun: {
    method: "POST",
    path: "/api/evals/runs",
    scope: "brain:write",
    input: z.strictObject({
      run: EvalRunId,
      suite: z.string().regex(/^[a-z0-9][a-z0-9-]{0,59}$/),
      effort: EffortLevel,
      parallel: z.number().int().min(1).max(64).optional(),
      pins: EvalPins.optional(),
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

  // ---- Compute: what the fleet can carry, and how it spends it (compute.ts) ----------
  /** The census: every node's body, what it measured, its ceiling, slots in use and waiting; its plan; the day's budget. */
  compute: { method: "GET", path: "/api/compute", scope: "mind:read", input: null },
  /** A node measures itself now: a few seconds, at low priority, within its ceiling. Yours to ask (brain:write: never an agent's). */
  calibrateCompute: { method: "POST", path: "/api/compute/calibrate", scope: "brain:write", input: z.strictObject({ on: NodeRef.optional() }) },
  /**
   * The ceiling for one node: the threads and memory it may use there, how many sandboxes and model calls at
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
  /** The level auto may reach, and the day's budget of extra attempts. It steers how it spends: brain:write, and yours alone. */
  setComputePolicy: {
    method: "POST",
    path: "/api/compute/policy",
    scope: "brain:write",
    input: z.strictObject({ effort: EffortAsk.optional(), attemptsPerDay: z.number().int().min(0).max(500).optional() }),
  },
  /**
   * How many attempts a run runs at once: the node decides, from the slots free now and the day's budget
   * (decideEffort), and records each extra attempt in the ledger. Whoever may create sandboxes may ask.
   */
  effort: {
    method: "POST",
    path: "/api/compute/effort",
    scope: "sandbox",
    input: z.strictObject({ run: z.string().regex(/^[A-Za-z0-9._:-]{1,48}$/), effort: EffortAsk, on: NodeRef.optional(), label: z.string().max(160).optional() }),
  },
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
      run: z.string().max(64).optional(),
    }),
  },
  /** One file of an artifact, as bytes (text and raster images inline, the rest as a download). */
  artifactFile: {
    method: "POST",
    path: "/api/artifacts/file",
    scope: "mind:read",
    input: z.strictObject({ id: ArtifactId, path: z.string().min(1).max(512) }),
  },
  /** Deleting kept work is yours to decide (the policy: never delete persistent things without approval). */
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
  /** Your rules (rules.ts): the tripwires on its work's commands, each as this node reads it. */
  rules: { method: "GET", path: "/api/rules", scope: "mind:read", input: null },
  /** Set a rule, or replace the one by its name: yours alone, like a standing order (never an agent's, never another node's). */
  setRule: { method: "POST", path: "/api/rules", scope: "fleet:admin", input: RuleInput },
  removeRule: { method: "POST", path: "/api/rules/remove", scope: "fleet:admin", input: z.strictObject({ name: RuleName }) },
  /** A rule stopped a run's command: the ledger says so. Whoever runs the run's sandbox says it, and the node checks the rule stops it. */
  ruleTripped: { method: "POST", path: "/api/rules/tripped", scope: "sandbox", input: RuleTrippedInput },
  /** A command a rule of yours that tells matched has run (a run's, said by its loop): the node tells you. */
  ruleTold: { method: "POST", path: "/api/rules/told", scope: "sandbox", input: RuleToldInput },
  /*
   * Seats (seats.ts): accounts you hold with a vendor, each serving the agents you chose, their homes on this node. Every
   * change is yours alone. Nothing a seat route answers or takes carries a token: a seat's account is signed in on its
   * vendor's page.
   */
  /** Every seat, and where each stands; and `use`, each of this node's seats' use lately (seats.ts SeatUse), by its id. */
  seats: { method: "GET", path: "/api/seats", scope: "mind:read", input: null },
  /** Add a seat, its home on this node. Answers `{ seat }`. */
  addSeat: { method: "POST", path: "/api/seats", scope: "fleet:admin", input: SeatAddInput },
  /** Remove a seat, and the email its sign-in started with. */
  removeSeat: { method: "POST", path: "/api/seats/remove", scope: "fleet:admin", input: SeatIdInput },
  /** How many runs at once a seat takes, at most (never more than has been shown safe). Answers `{ seat }`. */
  setSeatPolicy: { method: "POST", path: "/api/seats/policy", scope: "fleet:admin", input: SeatPolicyInput },
  /**
   * The agents a seat serves: this node's own, each as itself (its handle, and when this node's team made it), for a seat
   * whose home is on this node. A share only with `shared: true`: its agents are one trust domain. Answers `{ seat }`.
   */
  setSeatServes: { method: "POST", path: "/api/seats/serves", scope: "fleet:admin", input: SeatServesInput },
  /**
   * Sign a seat in: its vendor's tool starts its own sign-in in a VM made for the seat, and answers with what it asks of
   * you (`{ card }`: its page, and its code or a field for yours). Asked again while one is open, the same card.
   */
  startSeatSignIn: { method: "POST", path: "/api/seats/sign-in", scope: "fleet:admin", input: SeatIdInput },
  /** The code its vendor's page showed you: to that sign-in's own process, once, and nowhere else. */
  answerSeatSignIn: { method: "POST", path: "/api/seats/sign-in/answer", scope: "fleet:admin", input: SeatSignInAnswerInput },
  cancelSeatSignIn: { method: "POST", path: "/api/seats/sign-in/cancel", scope: "fleet:admin", input: SeatSignInCancelInput },
  arms: { method: "GET", path: "/api/arms", scope: "fleet:admin", input: null },
  mintArm: {
    method: "POST",
    path: "/api/arms",
    scope: "fleet:admin",
    input: z.strictObject({ label: z.string().regex(/^[a-z0-9][a-z0-9._-]{0,47}$/), scopes: z.array(ScopeSchema).max(16).optional() }),
  },
  /** Change what an agent may do without changing its token (e.g. grant mind:read). */
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

  // ---- Q-AMP grants (qamp.ts; PLAN #58): an agent on another of your machines, a few of its tools, for a while ----
  /** The grants in force on this node: each one's agent, tools, end and bridge. Yours alone, as each of these is. */
  qampGrants: { method: "GET", path: "/api/qamp/grants", scope: "fleet:admin", input: null },
  /** Grant an agent's key some of the read-only tools for a while: an arm of its own, a chain bound to its key, a bridge. */
  qampGrant: { method: "POST", path: "/api/qamp/grants", scope: "fleet:admin", input: QampGrantInput },
  /** End one grant, or every one: its arm deleted at once (the agent's next call refused), its bridge stopped. */
  qampRevoke: { method: "POST", path: "/api/qamp/revoke", scope: "fleet:admin", input: QampRevokeInput },

  // ---- The fabric (fabric.ts; docs/ARCHITECTURE.md §3): a task handed to another node's agents, over Q-AMP ----
  /** The node's own switch for its fabric, off by default: set it (`on`) or read it (none). Yours alone. */
  fabricSetting: { method: "POST", path: "/api/fabric/setting", scope: "fleet:admin", input: FabricSettingInput },
  /** A new transport key for the node's sidecar, in place of the one it kept: its peers refuse the old one from then on. Yours alone. */
  rotateTransportKey: { method: "POST", path: "/api/fabric/rotate", scope: "fleet:admin", input: z.strictObject({}) },
  /** Your grants for hand-offs in force, by pair: which node may hand tasks to which node's agents at once, within what. */
  handoffGrants: { method: "GET", path: "/api/fabric/grants", scope: "fleet:admin", input: null },
  /** Grant one node hand-offs to another's agents, given once for the pair (the next one replaces it). Yours alone. */
  grantHandoffs: { method: "POST", path: "/api/fabric/grants", scope: "fleet:admin", input: HandoffGrantInput },
  /** End a pair's grant: what was handed under it stops, and the next hand-off waits for your approval. Yours alone. */
  revokeHandoffs: { method: "POST", path: "/api/fabric/grants/revoke", scope: "fleet:admin", input: HandoffRevokeInput },
  /** Hand a task to another node's agents: it runs there, its trail streams back, and its proof is checked here. Yours alone. */
  handTask: { method: "POST", path: "/api/fabric/hand", scope: "fleet:admin", input: HandTaskInput },
  /** The tasks this node handed on, the latest first, without their trails. */
  handedTasks: { method: "GET", path: "/api/fabric/handed", scope: "chat", input: null },
  /** One task handed on, with its trail after line `after` (0: all of it that is kept). */
  handedTask: { method: "POST", path: "/api/fabric/handed/one", scope: "chat", input: z.strictObject({ id: HandId, after: z.number().int().min(0).max(10_000_000).optional() }) },
  /** Stop a task handed on: the node it runs on stops the work and says how it ended. Yours alone. */
  stopHanded: { method: "POST", path: "/api/fabric/handed/stop", scope: "fleet:admin", input: z.strictObject({ id: HandId }) },
  /** Cut a handed task's run off from this node's tools (its grant revoked: its next call refused); the task goes on there. Yours alone. */
  revokeHandedRun: { method: "POST", path: "/api/fabric/handed/revoke", scope: "fleet:admin", input: z.strictObject({ id: HandId }) },

  // ---- The archive (node-local: what this node keeps, for good) -----------------
  /** Entries, chunks embedded, the backlog, the embedder, the last integrity check, disk used. */
  archiveStatus: { method: "GET", path: "/api/archive", scope: "mind:read", input: null },
  /** Hybrid search (words and meaning, fused), filtered by kind, trust, source and time. */
  archiveSearch: { method: "POST", path: "/api/archive/search", scope: "mind:read", input: ArchiveSearchInput },
  /** One entry: its description, understanding, files and links. */
  archiveEntry: { method: "POST", path: "/api/archive/entry", scope: "mind:read", input: z.strictObject({ id: ArchiveId }) },
  /** One file of an entry, as bytes (checked against its SHA-256 before it's sent). */
  archiveFile: { method: "POST", path: "/api/archive/file", scope: "mind:read", input: z.strictObject({ id: ArchiveId, path: z.string().min(1).max(512) }) },
  /** An idea, kept: yours from the app or a terminal, the primary's from its note_idea tool. */
  noteIdea: { method: "POST", path: "/api/archive/ideas", scope: "mind:write", input: NoteIdeaInput },
  /** Only you delete, with a reason; a tombstone stays so it's never archived again. */
  deleteArchived: { method: "POST", path: "/api/archive/delete", scope: "fleet:admin", input: ArchiveDeleteInput },
  /** Embed (and optionally summarise) everything again, in the background. */
  reindexArchive: { method: "POST", path: "/api/archive/reindex", scope: "fleet:admin", input: ArchiveReindexInput },
  /** Re-hash every stored file now (it also runs daily). */
  verifyArchive: { method: "POST", path: "/api/archive/verify", scope: "fleet:admin", input: z.strictObject({}) },
  /** How many entries the swift role may summarise per day. */
  setArchiveBudget: { method: "POST", path: "/api/archive/budget", scope: "brain:write", input: ArchiveBudgetInput },

  // ---- Its skills (skills.ts): how it did a kind of work, as words it reads --------
  /** Every skill with its state, uses and track record, and the day's budget for distilling. Read like any memory. */
  skills: { method: "GET", path: "/api/skills", scope: "mind:read", input: null },
  /** One skill in full: every version kept, where each came from, and the runs it was given to. */
  skill: { method: "POST", path: "/api/skills/get", scope: "mind:read", input: z.strictObject({ id: SkillId }) },
  /**
   * Write a skill, or a new version of one. Who asks decides its trust, never the caller's say: yours are
   * owner; what it writes when asked in a chat, and what another agent proposes, is untrusted and waits for you.
   */
  writeSkill: { method: "POST", path: "/api/skills", scope: "mind:write", input: SkillWriteInput },
  /**
   * A run of its has ended: its outcome is recorded against the skills it was given, and if its review
   * passed, one bounded call distils at most one skill from its evidence. Its own runs only.
   */
  learnSkill: { method: "POST", path: "/api/skills/learn", scope: "mind:write", input: RunEvidenceInput },
  /**
   * Yours alone: an Agent Skill's folder on GitHub (PLAN #34) taken in as a skill, as text: its SKILL.md alone is read,
   * nothing in the folder runs, and the skill waits for your approval (untrusted, by where it came from) like any other.
   */
  importSkill: { method: "POST", path: "/api/skills/take-in", scope: "fleet:admin", input: z.strictObject({ url: z.string().trim().min(10).max(500) }) },
  /** Yours alone: approve exactly the version you read (an untrusted skill is given to no model before that). */
  approveSkill: { method: "POST", path: "/api/skills/approve", scope: "fleet:admin", input: SkillApproveInput },
  /** Yours alone: locked, it may use it but not change it. */
  lockSkill: { method: "POST", path: "/api/skills/lock", scope: "fleet:admin", input: SkillLockInput },
  /** Yours alone: retired, it's kept and never offered (nothing is deleted); put back with `retired: false`. */
  retireSkill: { method: "POST", path: "/api/skills/retire", scope: "fleet:admin", input: SkillRetireInput },
  /** Yours alone: one step back, to the version before the latest. */
  rollbackSkill: { method: "POST", path: "/api/skills/rollback", scope: "fleet:admin", input: z.strictObject({ id: SkillId }) },
  /** The day's budget for distilling skills, in tokens (0: it distils none). */
  setSkillsBudget: { method: "POST", path: "/api/skills/budget", scope: "brain:write", input: SkillsBudgetInput },
  // ---- Notifications: it comes to you, on your own paired devices (notify.ts; node-local) ----------
  /*
   * Yours alone, every one of them: the node refuses agents and other nodes whatever their scopes. No route takes a
   * title or a line: what a notification says comes only from the node's own records, through its own rules.
   */
  /** Who is notified (devices by name, never an endpoint), what it sends and when it stays silent, what was sent today, and this node's public key to subscribe to. */
  notify: { method: "GET", path: "/api/notify", scope: "mind:read", input: null },
  /** What it sends and when it stays silent: the kinds, quiet hours, the day's limit. It steers it: brain:write, never an agent's. */
  setNotify: { method: "POST", path: "/api/notify", scope: "brain:write", input: NotifyPrefsInput },
  /** This device turns notifications on, for itself: its browser's push subscription, kept as that device's. Only a paired device may, and only its own. */
  pushSubscribe: { method: "POST", path: "/api/notify/subscribe", scope: "mind:read", input: PushSubscriptionInput },
  /** The iPhone app turns notifications on, for itself: its Apple push token, kept as that device's (off and test: the two below). */
  applePushSubscribe: { method: "POST", path: "/api/notify/apple", scope: "mind:read", input: ApplePushInput },
  /** One of the iPhone app's Live Activities (live-activity.ts): its task and its own push token, kept as that device's while the task goes, so the node says how it stands while the app isn't in front; a null token forgets it. Only a paired device, for itself. */
  notifyActivity: { method: "POST", path: "/api/notify/activity", scope: "mind:read", input: LiveActivityInput },
  /** The Android app turns notifications on, for itself: no push service is called; the node keeps each one for it, and the app collects them (the next). */
  collectSubscribe: { method: "POST", path: "/api/notify/collect/on", scope: "mind:read", input: z.strictObject({}) },
  /** What the node kept for this device (one that collects its notifications: all of them, or what its push service refused while it is told through one), handed over once and forgotten; `on` false when its notifications are off. */
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
  /**
   * The path its last sync went on: Q-AMP through the sidecars, or HTTPS with signed requests (the fallback); absent from
   * a node from before the fabric (docs/ARCHITECTURE.md §3).
   */
  path?: "qamp" | "https";
  /** Why it is on HTTPS when it is (no sidecar here or there, Q-AMP failed and when it is tried again); null on Q-AMP. */
  fallback?: string | null;
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
 * from your device or kept by you, goes with every answer of its; its own (an agent's) is only proposed, and waits
 * for you to keep it (your ruling, 16 November 2026), so nothing it read can plant a standing instruction.
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
  run: string;
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
  /** A seat's VM (core's seats.ts: a run on it, its sign-in or its status): the seat whose home it has. No route reaches into one. */
  seat?: string;
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
  run: string | null;
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
  /** It's installed, and this asks to use it: it's the primary's alone and the asker isn't allowed yet. */
  access: boolean;
  /** The asker's label, as a connector's access names it. */
  agent: string;
  /** Its name, when the primary ships it (adding it is then a tap); null for a service it doesn't have yet. */
  label: string | null;
  why: string;
  /** Who asked: the primary, an agent by name, or an agent's label. */
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
 * The Slack app the primary answers through, as Slack makes one from a manifest (api.slack.com/apps → Create New App → From
 * a manifest): Socket Mode, so nothing of yours is opened; your direct messages with it and nothing else
 * (`message.im`), and the files you share there; buttons for an answer's choices; 👀 on your message while it works;
 * your name, to say who it answers.
 */
export const SLACK_APP_MANIFEST = {
  display_information: { name: "Invincible", description: "Your agent, in your direct messages.", background_color: "#141416" },
  features: {
    app_home: { home_tab_enabled: false, messages_tab_enabled: true, messages_tab_read_only_enabled: false },
    bot_user: { display_name: "Invincible", always_online: true },
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
  /** Who drafted it: the primary, in a chat. */
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
  /** Every heartbeat loop lets it fix what's safe itself (none of them says `selfAction: false`). */
  on: boolean;
  /** The heartbeat loops it follows (self-action runs after each of their runs). */
  heartbeats: string[];
  /** The allowlist: each kind, its policy class, and why it needs no asking. */
  allowlist: { kind: string; class: string; why: string }[];
  /** Its own fixes, newest first (ledger entries of resource "self-action"). */
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
  /** An MCP tool that differs on its server now from what was installed (invincible connector refresh shows how). */
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
  /** The primary's alone (and the agents you allowed, by label), when it isn't every agent's. */
  access: { only: "primary"; allowed: string[] } | null;
  /** One that signs in as you: whose sign-in, and whose account it's signed in to (null until then). */
  /** A connector you sign in to: whose sign-in (an MCP server's own: `mcp`, no app of yours needed), and whose account, once said. */
  oauth: { provider: "google" | "microsoft" | "mcp"; account: string | null } | null;
  /** What it reads stays in the answer that read it: your mail, your Drive, your home, your books (the catalog's PRIVATE_CONNECTORS). */
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
  /** What you said with your answer; for one you edited, which it was sent as; for one the primary approved itself, why. */
  note: string | null;
  /** The primary approved it itself, as its to approve (policy.ts ownApproval; your word of 23 November 2026), not you. */
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

export interface EvalView extends EvalRecord {
  id: string;
  recordedAt: number;
  /** The node that ran it. */
  nodeName: string;
  /** What its model calls came to, by role and model (absent: recorded before calls were counted). */
  spent?: EvalSpent;
}

/** The runs that recorded their settings (their effort), by run id. A run not here ran at effort 1. */
export type EvalRunsView = Record<string, EvalRunSettings>;

export interface ArtifactView {
  id: string;
  label: string;
  run: string | null;
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

/**
 * What a folder kept left out (saveArtifact's answer, never stored): how many, and as many of them named, each with why,
 * as the ledger's line for it names. The walk names what it couldn't read; the extractor, what it refused.
 */
export interface ArtifactSkipped {
  count: number;
  named: { path: string; reason: string }[];
  /** The VM said more of what it left out than the node reads (512 KB of it): more may be left out than `count`. */
  cut?: true;
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
  /** The primary calls one of its tools (input: a short summary of the arguments). */
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
  /** A message of yours reached it while it worked (a steer): what follows answers it, in the same turn. */
  | { type: "steer"; text: string }
  /**
   * First in the stream of a turn the node owns: its id (to attach to, steer or stop), and `answer`, the kept
   * message its first answer is (null: a temporary chat). `replay`: what follows first is what already happened.
   */
  | { type: "turn"; id: string; conversation: string | null; answer: number | null; role: string; startedAt: number; deadline: number; replay: boolean }
  /** It was stopped, and by what (a turn that ran into the node's time limit ends with an error that says so). */
  | { type: "stopped"; reason: StopReason }
  /** Messages of yours that hadn't reached it when the turn ended: queued (held) in a kept chat, handed back otherwise. */
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
