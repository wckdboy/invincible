import type { ActionView, ConnectorRequestView, FleetView, LoopDraftView, MemoryView, NoticeView, PairingView, QuestionView, ScreenSessionView, SecretRequestView } from "@galahad/core";
import type { LiveEvent, LiveTopic } from "@galahad/core/live";
import type { TeamSnapshot } from "@galahad/core/team";
import { type Api, ApiError } from "./api.ts";
import type { Live } from "./context.ts";
import { type After, Followers, GAP_MS, type LiveLink, liveLink } from "./lib/live-link.ts";
import type { AnyScope } from "./types.ts";
import { signal } from "./ui/signal.ts";

/*
 * What the shell shows everywhere: fleet health, the inbox (pairing requests, secret requests, actions waiting for your
 * answer, the heartbeat's notices, …) and the team (the knights, their rooms and work: the roster's rows and every
 * timeline read the one snapshot). The node's live stream (lib/live-link.ts, core's live.ts) says which of them changed,
 * as it changes, and only that is read again; nothing is asked for while nothing changes. While the stream is down (the
 * node away or restarting, an older node without it), each is asked for every FALLBACK_MS instead, and the stream is
 * opened again. Nothing at all while the app is hidden; it catches up the moment it's visible again.
 */

/** While the stream is down, what the shell shows everywhere is asked for this often. */
const FALLBACK_MS = 15_000;
/** The team is read again at most this often however busy it is (it is the largest answer). */
const TEAM_GAP_MS = 2_000;
/** A read that failed after the stream said it changed is asked again this much later. */
const READ_AGAIN_MS = 5_000;

/** The Inbox's parts, each read by its own route. */
const INBOX: readonly LiveTopic[] = ["pairings", "secretRequests", "actions", "screenSessions", "questions", "notices", "loopDrafts", "connectorRequests", "aboutYou"];

const after: After = (ms, run) => {
  const timer = setTimeout(run, ms);
  return () => clearTimeout(timer);
};

/**
 * The node's live stream for this app, opened beside its first request (app.ts), so it has said hello by the time the
 * shell is drawn. A node without one (404), a device that may not read it (403) or one revoked (401, which the app's
 * own check of the device then says) isn't asked again on a timer.
 */
export function openLink(api: Api): LiveLink {
  const link = liveLink({
    open: (signal, alive) => api.listen<LiveEvent>("/api/live", signal, alive),
    refused: (error) => error instanceof ApiError && (error.status === 401 || error.status === 403 || error.status === 404),
    after,
    now: () => Date.now(),
  });
  if (!document.hidden) link.start();
  return link;
}

export interface LiveEvents {
  /** A device asked to join since the last look. */
  onNewPairing(pairing: PairingView): void;
  /** An action began waiting for your answer since the last look. */
  onNewAction(action: ActionView): void;
}

/** Waiting, and not yet past its deadline (the node says expired on its next answer). */
export const isWaiting = (action: ActionView, now = Date.now()): boolean => action.state === "waiting" && action.expires > now;

export interface LiveOptions {
  /** The stream, opened earlier (openLink); one is opened here otherwise. */
  link?: LiveLink;
  /** The clock (tests hold it). */
  after?: After;
  now?: () => number;
}

export function startLive(api: Api, can: (scope: AnyScope) => boolean, events: LiveEvents, opts: LiveOptions = {}): Live {
  const fleet = signal<FleetView | null>(null);
  const pairings = signal<PairingView[]>([]);
  const secretRequests = signal<SecretRequestView[]>([]);
  const loopDrafts = signal<LoopDraftView[]>([]);
  const connectorRequests = signal<ConnectorRequestView[]>([]);
  const aboutYou = signal<MemoryView[]>([]);
  const actions = signal<ActionView[]>([]);
  /** His asks to use a Mac itself, and his sessions there (core's screen.ts). */
  const screenSessions = signal<ScreenSessionView[]>([]);
  /** MCP servers' questions to you, mid-call (core's questions.ts). */
  const questions = signal<QuestionView[]>([]);
  const notices = signal<NoticeView[]>([]);
  const online = signal(navigator.onLine);
  const inboxLoaded = signal(false);
  const inboxCount = signal(0);
  const team = signal<TeamSnapshot | null>(null);
  const teamProblem = signal<unknown>(null);
  const seen = new Set<string>();
  const seenActions = new Set<string>();
  let lastFleet = "";
  let lastActions = "";
  let lastNotices = "";
  let primed = false;
  let actionsPrimed = false;

  const recount = () =>
    inboxCount.set(
      pairings.value.length +
        secretRequests.value.length +
        actions.value.filter((a) => isWaiting(a)).length +
        screenSessions.value.filter((s) => s.state === "waiting" || s.state === "allowed").length +
        questions.value.filter((q) => q.expires > Date.now()).length +
        notices.value.filter((n) => !n.dismissed).length +
        loopDrafts.value.length +
        connectorRequests.value.length +
        aboutYou.value.length,
    );
  // A read that failed after the stream said its topic changed is asked again a little later (while the stream is
  // up; while it's down the slow poll has it): a hiccup on the way never leaves a place showing what was. One the node
  // refused or doesn't have (a 4xx) isn't: asking again would only be refused again.
  const later = opts.after ?? after;
  const failing = new Set<LiveTopic>();
  const readAgain = (topic: LiveTopic) => (error: unknown): void => {
    if ((error instanceof ApiError && error.status >= 400 && error.status < 500) || failing.has(topic)) return;
    failing.add(topic);
    later(READ_AGAIN_MS, () => {
      failing.delete(topic);
      followers.changed([topic]);
    });
  };
  pairings.subscribe(recount);
  secretRequests.subscribe(recount);
  loopDrafts.subscribe(recount);
  connectorRequests.subscribe(recount);
  aboutYou.subscribe(recount);
  actions.subscribe(recount);
  screenSessions.subscribe(recount);
  questions.subscribe(recount);
  notices.subscribe(recount);

  async function refreshFleet(): Promise<void> {
    if (!can("mind:read")) return;
    try {
      const next = await api.get<FleetView>("/api/fleet");
      // Only wake the views when something actually changed.
      const signature = JSON.stringify(next);
      if (signature !== lastFleet) {
        lastFleet = signature;
        fleet.set(next);
      }
    } catch (error) {
      // (The shell shows offline state; views show their own errors.)
      readAgain("fleet")(error);
    }
  }

  async function refreshPairings(): Promise<void> {
    if (!can("fleet:admin")) return;
    try {
      const { pairings: list } = await api.get<{ pairings: PairingView[] }>("/api/pairings");
      for (const p of list) {
        const key = `${p.invite}:${p.device}`;
        if (!seen.has(key)) {
          seen.add(key);
          if (primed) events.onNewPairing(p);
        }
      }
      primed = true;
      const same = list.length === pairings.value.length && list.every((p, i) => p.device === pairings.value[i]?.device && p.conflict === pairings.value[i]?.conflict);
      if (!same) pairings.set(list);
    } catch (error) {
      readAgain("pairings")(error);
    }
  }

  async function refreshRequests(): Promise<void> {
    if (!can("vault:read")) return;
    try {
      const { requests } = await api.get<{ requests: SecretRequestView[] }>("/api/secret-requests");
      const same = requests.length === secretRequests.value.length && requests.every((r, i) => r.name === secretRequests.value[i]?.name);
      if (!same) secretRequests.set(requests);
    } catch (error) {
      readAgain("secretRequests")(error);
    }
  }

  async function refreshLoopDrafts(): Promise<void> {
    if (!can("mind:read")) return;
    try {
      const { drafts } = await api.get<{ drafts: LoopDraftView[] }>("/api/loops/drafts");
      if (JSON.stringify(drafts.map((d) => d.id)) !== JSON.stringify(loopDrafts.value.map((d) => d.id))) loopDrafts.set(drafts);
    } catch (error) {
      // (Or an older node with no drafts.)
      readAgain("loopDrafts")(error);
    }
  }

  async function refreshConnectorRequests(): Promise<void> {
    if (!can("mind:read")) return;
    try {
      const { requests } = await api.get<{ requests: ConnectorRequestView[] }>("/api/connectors/requests");
      if (JSON.stringify(requests.map((r) => r.id)) !== JSON.stringify(connectorRequests.value.map((r) => r.id))) connectorRequests.set(requests);
    } catch (error) {
      // (Or an older node that takes no requests.)
      readAgain("connectorRequests")(error);
    }
  }

  /** The facts about you he proposed, waiting for you (what you kept is on the Memory page). */
  async function refreshAboutYou(): Promise<void> {
    if (!can("mind:read")) return;
    try {
      const { proposed } = await api.get<{ proposed: MemoryView[] }>("/api/about-you");
      if (JSON.stringify(proposed.map((m) => m.id)) !== JSON.stringify(aboutYou.value.map((m) => m.id))) aboutYou.set(proposed);
    } catch (error) {
      // (Or an older node that keeps nothing about you.)
      readAgain("aboutYou")(error);
    }
  }

  async function refreshActions(): Promise<void> {
    if (!can("mind:read")) return;
    try {
      const { actions: list } = await api.get<{ actions: ActionView[] }>("/api/actions");
      for (const a of list) {
        if (!isWaiting(a) || seenActions.has(a.id)) continue;
        seenActions.add(a.id);
        if (actionsPrimed) events.onNewAction(a);
      }
      actionsPrimed = true;
      const signature = JSON.stringify(list);
      if (signature !== lastActions) {
        lastActions = signature;
        actions.set(list);
      }
    } catch (error) {
      // (An older node without the outbox answers 404 and shows nothing.)
      readAgain("actions")(error);
    }
  }

  let lastScreen = "";
  async function refreshScreenSessions(): Promise<void> {
    if (!can("mind:read")) return;
    try {
      const { sessions } = await api.get<{ sessions: ScreenSessionView[] }>("/api/screen/sessions");
      const signature = JSON.stringify(sessions);
      if (signature !== lastScreen) {
        lastScreen = signature;
        screenSessions.set(sessions);
      }
    } catch (error) {
      // (Or an older node without screen sessions.)
      readAgain("screenSessions")(error);
    }
  }

  let lastQuestions = "";
  async function refreshQuestions(): Promise<void> {
    if (!can("mind:read")) return;
    try {
      const { questions: list } = await api.get<{ questions: QuestionView[] }>("/api/questions");
      const signature = JSON.stringify(list);
      if (signature !== lastQuestions) {
        lastQuestions = signature;
        questions.set(list);
      }
    } catch (error) {
      // (Or an older node without questions.)
      readAgain("questions")(error);
    }
  }

  async function refreshNotices(): Promise<void> {
    if (!can("mind:read")) return;
    try {
      const { notices: list } = await api.get<{ notices: NoticeView[] }>("/api/notices");
      const signature = JSON.stringify(list);
      if (signature !== lastNotices) {
        lastNotices = signature;
        notices.set(list);
      }
    } catch (error) {
      readAgain("notices")(error);
    }
  }

  // One asking at a time: whoever asks meanwhile is given the same answer. Each answer is set anew, so what
  // moves with the clock (a face that was pleased for half a minute) is worked out again by whoever shows it.
  let teamAsking: Promise<void> | null = null;
  function refreshTeam(): Promise<void> {
    if (!can("chat")) return Promise.resolve();
    teamAsking ??= api
      .get<TeamSnapshot>("/api/team")
      .then(
        (next) => {
          teamProblem.set(null);
          team.set(next);
        },
        (error: unknown) => {
          teamProblem.set(error);
          readAgain("team")(error);
        },
      )
      .finally(() => (teamAsking = null));
    return teamAsking;
  }
  // One asking of the whole Inbox at a time: whoever asks meanwhile is given the same answer.
  let inboxAsking: Promise<void> | null = null;
  const refreshInbox = (): Promise<void> =>
    (inboxAsking ??= Promise.all([refreshPairings(), refreshRequests(), refreshActions(), refreshScreenSessions(), refreshQuestions(), refreshNotices(), refreshLoopDrafts(), refreshConnectorRequests(), refreshAboutYou()])
      .then(() => inboxLoaded.set(true))
      .finally(() => (inboxAsking = null)));
  /** Each of the Inbox's parts, read again alone when it changed. */
  const inboxPart: Partial<Record<LiveTopic, () => Promise<void>>> = {
    pairings: refreshPairings,
    secretRequests: refreshRequests,
    actions: refreshActions,
    screenSessions: refreshScreenSessions,
    questions: refreshQuestions,
    notices: refreshNotices,
    loopDrafts: refreshLoopDrafts,
    connectorRequests: refreshConnectorRequests,
    aboutYou: refreshAboutYou,
  };

  const link = opts.link ?? openLink(api);
  const followers = new Followers(opts.after ?? after, opts.now ?? (() => Date.now()));
  const streaming = signal(false);
  const follow: Live["follow"] = (topics, run, everyMs, gapMs) => followers.follow(topics, run, everyMs, gapMs);

  // The team, while something shows it: read again when it changes (or, while the stream is down, as often as the
  // shell says), and at once whenever the shell asks for another pace (another place came on screen). That first read
  // is asked for here and now, ahead of anything the stream's coming up reads: the Roundtable waits on it.
  let teamEvery: number | null = null;
  let unfollowTeam: (() => void) | null = null;
  function watchTeam(everyMs: number | null = teamEvery): void {
    if (everyMs === teamEvery && (unfollowTeam || everyMs === null)) return;
    teamEvery = everyMs;
    unfollowTeam?.();
    unfollowTeam = null;
    if (everyMs === null) return;
    const shown = !document.hidden;
    if (shown) void refreshTeam();
    unfollowTeam = followers.follow(["team"], () => refreshTeam(), everyMs, TEAM_GAP_MS, shown ? "owner" : "later");
  }

  // (Read first when the stream comes up or goes down: after the page's own first reads, which are asked for as it is drawn.)
  followers.follow(["fleet"], () => refreshFleet(), FALLBACK_MS, GAP_MS, "later");
  followers.follow(INBOX, (changed) => (changed ? Promise.all(changed.map((topic) => inboxPart[topic]?.())) : refreshInbox()), FALLBACK_MS, GAP_MS, "later");
  link.attach({
    up: (_topics, at) => {
      streaming.set(true);
      followers.up(at);
    },
    changed: (topics) => followers.changed(topics),
    down: () => {
      streaming.set(false);
      followers.down();
    },
  });

  const listeners = new AbortController();
  const until = listeners.signal;
  document.addEventListener(
    "visibilitychange",
    () => {
      if (document.hidden) {
        link.stop();
        followers.off();
        streaming.set(false);
      } else link.start();
    },
    { signal: until },
  );
  window.addEventListener(
    "online",
    () => {
      online.set(true);
      link.retry();
    },
    { signal: until },
  );
  window.addEventListener("offline", () => online.set(false), { signal: until });

  const dispose = () => {
    link.stop();
    followers.off();
    unfollowTeam?.();
    listeners.abort();
  };
  return { fleet, pairings, secretRequests, actions, screenSessions, refreshScreenSessions, questions, refreshQuestions, notices, loopDrafts, connectorRequests, aboutYou, refreshAboutYou, online, inboxLoaded, inboxCount, team, teamProblem, refreshTeam, watchTeam, refreshFleet, refreshActions, refreshNotices, refreshLoopDrafts, refreshConnectorRequests, refreshInbox, streaming, follow, stop: dispose };
}
