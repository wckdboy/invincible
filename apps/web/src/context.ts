import type { ActionView, ConnectorRequestView, FleetView, LoopDraftView, MemoryView, NoticeView, PairingView, QuestionView, ScreenSessionView, SecretRequestView } from "@galahad/core";
import type { LiveTopic } from "@galahad/core/live";
import type { TeamSnapshot } from "@galahad/core/team";
import type { Api } from "./api.ts";
import type { BrowserIdentity } from "./identity.ts";
import type { AnyScope, WhoAmI } from "./types.ts";
import type { Scope } from "./ui/dom.ts";
import type { Signal } from "./ui/signal.ts";
import type { Route } from "./lib/nav.ts";
import type { TeamTab } from "./lib/team.ts";

export type { Route };

export interface NavigateOptions {
  /** A secret detected in chat or memory, handed to the vault form. Kept in memory only, never in the URL. */
  prefillKey?: string;
  /** A search to run on arrival (memory). */
  query?: string;
  /** Something to open on arrival, e.g. "add-key", "invite", "create", "remember", "place", "add-loop", "check". */
  intent?: string;
  /** A kept chat to open (chat), or a project to show or start a chat in (projects, chat). */
  conversation?: string;
  project?: string;
  /** A persistent team room or direct conversation, and its selected view. */
  room?: string;
  teamTab?: TeamTab;
  /** A task to show in that room's timeline (from Work): it is brought into view and marked a moment. */
  task?: string;
}

/** Live data shared by the shell and the views, read again as the node says it changed, while the app is visible. */
export interface Live {
  fleet: Signal<FleetView | null>;
  pairings: Signal<PairingView[]>;
  secretRequests: Signal<SecretRequestView[]>;
  /** The oath's outbox: actions waiting for your answer, and recently decided ones. */
  actions: Signal<ActionView[]>;
  /** His asks to use a Mac itself, and his sessions there. */
  screenSessions: Signal<ScreenSessionView[]>;
  refreshScreenSessions(): Promise<void>;
  /** MCP servers' questions to you, mid-call: each holds its call until you answer, say no, or its time runs out. */
  questions: Signal<QuestionView[]>;
  refreshQuestions(): Promise<void>;
  /** What the heartbeat found, dismissed ones included (the Inbox shows the open ones). */
  notices: Signal<NoticeView[]>;
  /** Loops Galahad drafted when you asked for one in chat, waiting for you to add or dismiss. */
  loopDrafts: Signal<LoopDraftView[]>;
  /** Connectors an agent asked you for. */
  connectorRequests: Signal<ConnectorRequestView[]>;
  /** Facts about you he proposed, waiting for you to keep or drop (what you kept goes with every answer). */
  aboutYou: Signal<MemoryView[]>;
  refreshAboutYou(): Promise<void>;
  online: Signal<boolean>;
  /** The inbox has been asked at least once (until then, "nothing needs you" would be a guess). */
  inboxLoaded: Signal<boolean>;
  inboxCount: Signal<number>;
  /** The knights, their rooms and their work, as the node last gave them (null: not yet, or not this device's to read). Set anew at every asking. */
  team: Signal<TeamSnapshot | null>;
  /** Why the last asking for the team failed (null: it didn't). */
  teamProblem: Signal<unknown>;
  refreshTeam(): Promise<void>;
  /** How often the team is asked for while the app is visible (null: not at all). The shell says, from what is on screen. */
  watchTeam(everyMs: number | null): void;
  refreshFleet(): Promise<void>;
  refreshActions(): Promise<void>;
  refreshNotices(): Promise<void>;
  refreshLoopDrafts(): Promise<void>;
  refreshConnectorRequests(): Promise<void>;
  /** Pairings, secret requests, actions, notices and loop drafts. */
  refreshInbox(): Promise<void>;
  /** The node's live stream is open: what changes there is told as it changes, and nothing is polled. */
  streaming: Signal<boolean>;
  /**
   * Runs `run` when one of these topics changes on the node (the live stream says so), once whenever the stream comes
   * up, and every `everyMs` while it is down (null: once, and `run`'s owner keeps its own time then); never while the
   * app is hidden. `run` is told which of its topics changed (null: everything). Runs come one at a time, no closer
   * than `gapMs` (half a second unless said). Returns how to stop.
   */
  follow(topics: readonly LiveTopic[], run: (changed: readonly LiveTopic[] | null) => unknown, everyMs: number | null, gapMs?: number): () => void;
  /** Stops polling and listening (when the app shell is torn down). */
  stop(): void;
}

export interface Ctx {
  api: Api;
  identity: BrowserIdentity;
  whoami: WhoAmI;
  can(scope: AnyScope): boolean;
  navigate(route: Route, opts?: NavigateOptions): void;
  live: Live;
  /** Opens the command palette, optionally with a query; given the button pressed for it, on a phone it grows out of it. */
  palette(query?: string, from?: Element): void;
}

export interface ViewArgs {
  /** Disposed when the view is left: timers, listeners, aborts in-flight requests. */
  scope: Scope;
  opts: NavigateOptions;
}

export type View = (root: HTMLElement, ctx: Ctx, args: ViewArgs) => void;

export const errorMessage = (error: unknown): string => (error instanceof Error ? error.message : String(error));
