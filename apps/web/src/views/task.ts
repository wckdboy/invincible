import type { TeamChangesView } from "@invincible/core";
import { findSecrets } from "@invincible/core/secret-scan";
import { moneyPrices, type Price } from "@invincible/core/spend";
import type { TeamMessage, TeamRoom, TeamRoomView, TeamSnapshot, TeamTask } from "@invincible/core/team";
import { TEAM_LIMITS } from "@invincible/core/team-limits";
import { isAbort } from "../api.ts";
import { type Ctx, errorMessage, type View } from "../context.ts";
import { isWaiting } from "../live.ts";
import { keyWords } from "../lib/keys.ts";
import { hashOf } from "../lib/nav.ts";
import { orbMoodOfState } from "../lib/orb-motion.ts";
import { agentOfCaller } from "../lib/roster.ts";
import { costWords, factsOfProof, factsOfRecord, type GateRow, judgedWith, liveStep, type Proof, proofOf, proofSeal, saidBesideProof, type StepGroup, stepGroups, summaryWords, verdictOf, workedLine, workSummary } from "../lib/steps.ts";
import { judgedLine, neverReached, STEER_WORDS, steerAction, steerHint, steersWaiting } from "../lib/steer.ts";
import { handedFrom, sensitiveLine, steppedLine, taskActions, taskEnd } from "../lib/task-card.ts";
import { teamSpeaker } from "../lib/team.ts";
import { changesLine, hunksOf, type ThreadChips, threadChips } from "../lib/threads.ts";
import { giveAgain } from "../lib/timeline.ts";
import { duration, relativeTime } from "../lib/time.ts";
import { emptyTrail, takeTrail, type Trail, trailNext, type TrailPage } from "../lib/trail.ts";
import { byAttention, projectsOfAgents, seenOnOpen, shortSpan, taskState } from "../lib/work.ts";
import { chatEnter, setTaskDetailsShown, taskDetailsShown } from "../prefs.ts";
import { badge, button, callout, dot, empty, errorState, skeletonBlock } from "../ui/controls.ts";
import { composerBox } from "../ui/composer.ts";
import { openSheet } from "../ui/dialog.ts";
import { cx, h, isMac, keepPlace, replace, type Child, type Scope } from "../ui/dom.ts";
import { icon, type IconName } from "../ui/icons.ts";
import { codeBlock, renderMarkdown } from "../ui/markdown.ts";
import { markStateOfAgent } from "../ui/mark.ts";
import { agentFace, orb } from "../ui/orb.ts";
import { toast } from "../ui/toast.ts";
import { askItem } from "./needs.ts";
import { controlTeam, giveTask, shipTask } from "./team-forms.ts";
import { openTerminal, runTerminal, type TerminalRun } from "./terminal.ts";
import { onViewKey } from "./view-keys.ts";
import { askProjects, projectNames, projectTile, workNow } from "./work-rows.ts";
import { diffParts, openWorkspace } from "./workspace.ts";
import { rosterBack } from "./sidebar.ts";

/*
 * A task as a thread of its own (#/task/<id>; your words, 26 November 2026: "project/tasks/coding t3code style for the
 * [agents]"), as T3 Code has a thread: what it is in a crumb (its project, its title), the brief and who gave it, its
 * agent's work folded into steps ("Worked for 6m 12s ›": read 6 files, edited 3, ran 14 commands; while it works, the
 * steps as they come and one live line), an outward step asking in place, what the agent said, and then, apart from
 * the agent's words and in its own colour, what proves it (the Verified card: each gate's command and how it ended, the
 * reviewer that didn't write it, its changes, its cost, and Ship it). Beside it on a wide screen, and in a sheet on a
 * phone, its details: the agent's VM, where its work began, its changes, its gates as they run, the reviewer, its cost
 * against its budget, and what waits on it.
 *
 * Everything is what the app already reads: the team (the task, its agent, what depends on it), the task's trail
 * (POST /api/team/trail: the runner's own lines, never the agent's account; lib/steps.ts reads them), its conversation
 * (POST /api/team/room), its changes (POST /api/team/changes, where this device may look into a VM), your prices.
 */

/** A trail that could not be read is asked for again after three of these. */
const EVERY_MS = 1500;

/** The agent's own conversation (its direct room), where its Workspace is. */
const directRoom = (snapshot: TeamSnapshot, agent: string): TeamRoom | undefined => snapshot.rooms.find((room) => room.direct && room.members.length === 1 && room.members[0] === agent);

/** What was said in the task's conversation from when it was given until the next task given there. */
function conversationOf(room: TeamRoomView | null, task: TeamTask): TeamMessage[] {
  if (!room) return [];
  const next = room.tasks.filter((other) => other.id !== task.id && other.createdAt > task.createdAt).reduce((soonest, other) => Math.min(soonest, other.createdAt), Infinity);
  return room.messages.filter((message) => message.createdAt >= task.createdAt && message.createdAt < next && message.speaker !== "system");
}

/** Who gave it, and how, in a line (the dispatch): the primary or you to the agents, an agent's proposal, or by name. No
 * full stop: its time follows it after a dot ("Given to Ada by name · just now"), never as a sentence of its own. */
function dispatchWords(task: TeamTask, agent: string, proposer: string | null): string {
  // Another node's hand-off: under your grant (taken at once), or beyond it (a proposal, yours to approve).
  if (handedFrom(task.givenBy)) {
    const node = proposer ?? "Another node of yours";
    if (!task.proposedBy) return `${node} handed it over under your grant, and ${agent} took it`;
    return task.status === "proposed" ? `${node} handed it over beyond your grant: it starts when you approve it` : `${node} handed it over beyond your grant, and you approved it`;
  }
  if (task.proposedBy) return task.status === "proposed" ? `${proposer ?? task.proposedBy} proposes it: it starts when you approve it` : `${proposer ?? task.proposedBy} proposed it, and it was approved`;
  if (task.givenBy === "primary") return `Your agent gave it to the agents, and ${agent} took it as best suited`;
  if (task.givenBy === "owner") return `You gave it to the agents, and ${agent} took it as best suited`;
  return `Given to ${agent} by name`;
}

const GATE_ICON: Record<GateRow["state"], IconName> = { passed: "check", failed: "x", running: "play", waiting: "clock" };
/** How long a gate ran, as long as it took ("4 ms", "2.3 s"): never "0:00" (null: unknown, or under a millisecond). */
const gateTime = (ms: number | null): string | null => (ms !== null && ms >= 1 ? duration(ms) : null);
const clock = (ms: number): string => {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
};

/** A desk's panel's tabs (views/task.ts deskPanel), and the words on them. */
type PanelTab = "changes" | "proof" | "details";
const PANEL_WORDS: Record<PanelTab, string> = { changes: "Changes", proof: "Proof", details: "Details" };
const PANEL_KEY = "invincible:task-panel";
function panelTabKept(): PanelTab {
  try {
    const kept = localStorage.getItem(PANEL_KEY);
    return kept === "proof" || kept === "details" ? kept : "changes";
  } catch {
    return "changes";
  }
}
function keepPanelTab(tab: PanelTab): void {
  try {
    localStorage.setItem(PANEL_KEY, tab);
  } catch {
    /* refused: this session's only */
  }
}

/** A desk's terminal drawer's height (views/task.ts), kept on this device, and how short it goes. */
const DRAWER_KEY = "invincible:terminal-height";
const DRAWER_LEAST = 140;
/** The height you left it at on this device (null: none yet). */
function drawerHeightKept(): number | null {
  try {
    const kept = Number(localStorage.getItem(DRAWER_KEY));
    return Number.isFinite(kept) && kept >= DRAWER_LEAST ? kept : null;
  } catch {
    return null;
  }
}
function keepDrawerHeight(height: number): void {
  try {
    localStorage.setItem(DRAWER_KEY, String(Math.round(height)));
  } catch {
    /* refused: this session's only */
  }
}

/** A desk's thread header's chips (shown from 1024 px; lib/threads.ts threadChips says what they are). */
function headChips(chips: ThreadChips): HTMLElement {
  return h(
    "span",
    { class: "thread-chips" },
    chips.verdict ? badge(chips.verdict.word, chips.verdict.tone, chips.verdict.proven ? "check" : undefined) : null,
    chips.branch ? h("span", { class: "thread-chip mono", title: chips.branch.title }, icon("code", { size: 12 }), h("span", { class: "ellipsis" }, chips.branch.text)) : null,
    chips.pr ? h("a", { class: "thread-chip", href: chips.pr.url, target: "_blank", rel: "noopener noreferrer", title: "Its pull request" }, icon("external", { size: 12 }), `#${chips.pr.number}`) : null,
  );
}

export const taskView: View = (root, ctx, { scope, opts }) => {
  askProjects(ctx);
  const canAct = ctx.can("fleet:admin") && ctx.can("chat");
  const wide = matchMedia("(min-width: 768px)");
  // A desk's (from 1024 px): T3 Code's thread, its header naming its branch, its pull request and its proof, and its
  // details a panel docked beside it (⌘D) in three tabs: what it changed, its diff opening in place; its proof; the rest.
  const desk = matchMedia("(min-width: 1024px)");
  let panelTab: PanelTab = panelTabKept();
  let id: string | null = opts.task ?? null;
  let trail: Trail = emptyTrail();
  /** The whole trail has been read once (until then, the work isn't drawn: it would arrive in pieces). */
  let trailRead = false;
  /** Its task's entry in the team as it stood when its trail was last read: read again only once that moves. */
  let trailEntry = "";
  let asking = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let room: TeamRoomView | null = null;
  /** The conversation is asked for once here, then again as the team changes (follow, below): never at every redraw. */
  let roomAsked = false;
  let prices: Record<string, Price> | null = null;
  let pricesAsked = false;
  /** What the task changed (null: not asked, or this device can't look into a VM), and the status it was asked at. */
  let changes: TeamChangesView | null = null;
  let changesAt = "";
  let changesUnread = false;
  let marked = "";
  let shownDetails = taskDetailsShown();
  /** Whether its proof is open (its one line, opened: kept as the thread is drawn again). */
  let proofOpen = false;
  let sending = false;
  let headVersion = "";
  let threadVersion = "";
  let detailsVersion = "";
  scope.add(() => clearTimeout(timer));

  const head = h("header", { class: "page-head thread-head" });
  const thread = h("div", { class: "thread-items" });
  const scroller = h("div", { class: "thread-scroll", tabindex: 0 }, thread);
  const liveLine = h("div", { class: "thread-live", role: "status", hidden: true });
  // (Made as it will be drawn: shown only once opened. Made shown and hidden at its first drawing, the thread beside it
  // moved back across as the page came.)
  const details = h("aside", { class: "thread-details", "aria-label": "The task's details", hidden: !wide.matches || !shownDetails });

  // ---- the message box: words to the agent, in the task's conversation; while it runs, a steer of the task, or a
  // message queued for after it (lib/steer.ts) ----
  const input = h("textarea", { rows: 1, maxlength: TEAM_LIMITS.message, placeholder: "Message…", "aria-label": "Message", autocomplete: "off", enterkeyhint: "send" });
  const hint = h("span", { class: "hint grow ellipsis" });
  const problem = h("div", { class: "team-send-error", role: "status" });
  const send = button("Send", { variant: "primary", iconOnly: true, icon: "arrow-up", type: "submit", label: "Send" });
  // (Full size: 44 px to touch on a phone, as the Send beside them.)
  const steerButton = button(STEER_WORDS.steer, { icon: "arrow-up", title: STEER_WORDS.steerTitle, onClick: () => void deliver("steer") });
  const queueButton = button(STEER_WORDS.queue, { title: STEER_WORDS.queueTitle, onClick: () => void deliver("queue") });
  steerButton.hidden = queueButton.hidden = true;
  /** What is on its way to the work: your steers and your agent's that its run hasn't taken yet. */
  const onItsWay = h("div", { class: "thread-steering", role: "status", hidden: true });
  send.classList.add("send");
  // The one message box (ui/composer.ts): Steer this task and Queue for after it trail the field while it works.
  const composer = composerBox({
    className: "thread-composer",
    onSubmit: (event: Event) => {
      event.preventDefault();
      void deliver();
    },
    field: input,
    trail: [queueButton, steerButton],
    send: [send],
    hint: [hint],
  });
  const composerWrap = h("div", { class: "thread-composer-wrap", hidden: true }, onItsWay, problem, composer);

  // A desk's terminal (T3 Code's ⌘J): a drawer under the thread, in its agent's VM. Hidden, its shell runs on; the thread
  // left, the node keeps it for fifteen minutes, and the thread opened again takes it up (views/terminal.ts).
  let terminalShown = false;
  let term: { run: TerminalRun; scope: Scope; sandbox: string } | null = null;
  let drawerHeight = drawerHeightKept() ?? 0;
  const termTitle = h("span", { class: "drawer-title ellipsis" });
  const termStatus = h("span", { class: "drawer-status", role: "status" });
  const termBox = h("div", { class: "drawer-screen" });
  const endShell = button("End its shell", { variant: "ghost", size: "sm", onClick: () => term?.run.end() });
  const newShell = button("New shell", {
    variant: "ghost",
    size: "sm",
    onClick: () => {
      term?.scope.dispose();
      term = null;
      showTerminal(true);
    },
  });
  newShell.hidden = true;
  const hideTerminal = button("Hide the terminal", { variant: "ghost", size: "sm", iconOnly: true, icon: "x", title: `Hide the terminal  (${keyWords(["mod", "J"], isMac())})`, onClick: () => showTerminal(false) });
  const grip = h("div", { class: "drawer-grip", role: "separator", tabindex: 0, "aria-orientation": "horizontal", "aria-label": "The terminal's height", "aria-valuemin": String(DRAWER_LEAST) });
  const drawer = h("section", { class: "thread-drawer", hidden: true, "aria-label": "Terminal" }, grip, h("div", { class: "drawer-bar" }, icon("terminal", { size: 14 }), termTitle, termStatus, h("span", { class: "grow" }), endShell, newShell, hideTerminal), termBox);
  const column = h("div", { class: "thread-column" }, scroller, liveLine, composerWrap, drawer);

  replace(root, h("div", { class: "thread-page" }, head, h("div", { class: "thread-body" }, column, details)));
  // Until the team is known, the header and the thread hold their places.
  replace(head, rosterBack(ctx), h("div", { class: "grow stack snug", "aria-hidden": "true" }, h("div", { class: "skeleton thread-head-name" }), h("div", { class: "skeleton sk-line thread-head-line" })));
  replace(thread, skeletonBlock(64), skeletonBlock(160));

  /** The task, its agent and its project, as the team has them now (null: not yet known, or no such task). */
  const now = () => {
    const snapshot = ctx.live.team.value;
    if (!snapshot || !id) return null;
    const task = snapshot.tasks.find((one) => one.id === id);
    if (!task) return null;
    const agent = snapshot.agents.find((person) => person.id === task.assignee);
    const name = agent?.name ?? snapshot.removed?.find((person) => person.id === task.assignee)?.name ?? task.assignee;
    const project = projectsOfAgents(snapshot.agents, projectNames.value)(task.assignee);
    return { snapshot, task, agent, name, project };
  };
  type Now = NonNullable<ReturnType<typeof now>>;

  // ---------- reading what it did ----------
  async function readTrail(): Promise<void> {
    if (asking || !id || scope.disposed) return;
    asking = true;
    const n = now();
    trailEntry = n ? JSON.stringify(n.task) : "";
    try {
      for (;;) {
        const page = await ctx.api.post<TrailPage>("/api/team/trail", { task: id, after: trail.after }, scope.signal);
        const before = trail;
        trail = takeTrail(trail, page);
        const next = trailNext(page, trail !== before);
        if (next === "now") continue;
        trailRead = true;
        draw();
        clearTimeout(timer);
        // (Caught up, at work or ended: read again once its entry moves, never on a timer.)
        break;
      }
    } catch (error) {
      if (isAbort(error)) return;
      if (!trailRead) {
        trailRead = true;
        draw();
      }
      clearTimeout(timer);
      timer = setTimeout(() => void readTrail(), EVERY_MS * 3);
    } finally {
      asking = false;
    }
    readIfMoved();
  }

  /**
   * Its trail read again only when its own entry in the team moves (a step, a steer, its end: the node writes each line
   * with its task's entry, in one transaction), so a task at rest is never asked again; while the stream is down the
   * team is read every few seconds, its entry with it.
   */
  function readIfMoved(): void {
    const n = now();
    if (!n || !trailRead || asking || document.hidden || scope.disposed) return;
    if (JSON.stringify(n.task) !== trailEntry) void readTrail();
  }
  scope.listen(document, "visibilitychange", () => {
    if (!document.hidden && trailRead) void readTrail();
  });

  async function readRoom(task: TeamTask): Promise<void> {
    try {
      const detail = await ctx.api.post<TeamRoomView>("/api/team/room", { id: task.room }, scope.signal);
      if (scope.disposed) return;
      room = detail;
      draw();
    } catch (error) {
      if (!isAbort(error)) room = room ?? null;
    }
  }

  function readPrices(): void {
    if (pricesAsked) return;
    pricesAsked = true;
    ctx.api.get<{ prices: Record<string, Price>; plans?: string[] }>("/api/prices", scope.signal).then(
      (answer) => {
        // Money as it goes: a coding plan's calls are paid for already (moneyPrices).
        prices = moneyPrices(answer.prices, answer.plans ?? []);
        draw();
      },
      () => {
        prices = {};
        draw();
      },
    );
  }

  function readChanges(n: Now): void {
    // Looking into a VM is a sandbox device's; asked once, and again when the work has moved on (ended, or kept). A task
    // that kept its changes worked in a repository, whatever its agent's is now (as its Workspace's Changes asks).
    const at = `${n.task.status}/${n.task.changes?.artifact ?? ""}`;
    if (!ctx.can("sandbox") || !(n.agent?.repository || n.task.changes) || changesAt === at || n.task.status === "proposed" || n.task.status === "queued") return;
    changesAt = at;
    changesUnread = false;
    ctx.api.post<TeamChangesView>("/api/team/changes", { id: n.task.assignee, task: n.task.id }, scope.signal).then(
      (answer) => {
        changes = answer;
        drawDetails(true);
        drawThread(true);
      },
      () => {
        // (Its VM gone or asleep: a desk's Changes says where what it kept is instead.)
        changesUnread = true;
        drawDetails(true);
      },
    );
  }

  // ---------- drawing ----------
  function draw(): void {
    const snapshot = ctx.live.team.value;
    if (!id && snapshot) {
      // #/task alone: the task that needs you most, at its own address.
      const first = workNow(ctx);
      const pick = first ? byAttention(first)[0]?.id : undefined;
      if (pick) return void location.replace(hashOf("task", { task: pick }));
    }
    const n = now();
    if (!n) {
      if (!snapshot && !ctx.live.teamProblem.value) return;
      // The team couldn't be read: said so, with a way to ask again (not "no such task", which it can't know yet).
      if (!snapshot) {
        replace(head, backHome(), h("div", { class: "thread-crumb grow" }, h("h1", { class: "thread-title" }, "The work can't be read just now")));
        replace(thread, errorState("Couldn't reach the agents", ctx.live.teamProblem.value, () => void ctx.live.refreshTeam()));
        return;
      }
      // No such task here (given on another node, or its agent removed), or none at all yet: said where the thread is.
      composerWrap.hidden = true;
      liveLine.hidden = true;
      details.hidden = true;
      headVersion = threadVersion = detailsVersion = "";
      replace(head, backHome(), h("div", { class: "thread-crumb grow" }, h("h1", { class: "thread-title" }, id ? "This task isn't here" : "No tasks yet")));
      replace(
        thread,
        empty({
          icon: "layers",
          title: id ? "Nothing to show" : "Nothing given yet",
          body: id ? "It may have been given on another node, or its agent was removed. Home has the work, by what needs you." : "Each task you or your agent give an agent has a thread of its own here.",
          actions: h("a", { class: "btn", href: "#/home" }, "Home"),
        }),
      );
      return;
    }
    if (!trailRead) void readTrail();
    if (!roomAsked) {
      roomAsked = true;
      void readRoom(n.task);
    }
    if (n.task.record) readPrices();
    readChanges(n);
    drawHead(n);
    drawThread();
    drawDetails();
    drawComposer(n);
    markRead(n);
  }

  const backHome = (): HTMLElement => rosterBack(ctx);
  /** Its details shown or hidden beside it (a sheet on a phone): its button, and ⌘D. */
  const toggleDetails = (): void => {
    if (!wide.matches) return openDetailsSheet();
    shownDetails = !shownDetails;
    setTaskDetailsShown(shownDetails);
    drawHead(now()!, true);
    drawDetails(true);
  };
  const detailsToggle = (): HTMLButtonElement => {
    const toggle = button(shownDetails ? "Hide the details" : "Show the details", {
      variant: "ghost",
      size: "sm",
      iconOnly: true,
      icon: "panel",
      title: `${shownDetails ? "Hide" : "Show"} the details  (${keyWords(["mod", "D"], isMac())})`,
      onClick: toggleDetails,
    });
    toggle.classList.add("thread-details-toggle");
    toggle.setAttribute("aria-pressed", String(wide.matches && shownDetails));
    return toggle;
  };

  /** Its agent's VM, where this device may open a terminal in it (a sandbox device, the VM on this node). */
  const terminalOf = (n: Now): { id: string; name: string } | null => {
    const vm = n.agent?.workspace;
    return ctx.can("sandbox") && vm && vm.node === ctx.whoami.node ? { id: vm.id, name: `${n.name}'s VM` } : null;
  };
  const terminalToggle = (n: Now): HTMLButtonElement | null => {
    if (!desk.matches || !terminalOf(n)) return null;
    const toggle = button(terminalShown ? "Hide the terminal" : "Show the terminal", { variant: "ghost", size: "sm", iconOnly: true, icon: "terminal", title: `${terminalShown ? "Hide" : "Show"} the terminal  (${keyWords(["mod", "J"], isMac())})`, onClick: () => showTerminal(!terminalShown) });
    toggle.classList.add("thread-terminal-toggle");
    toggle.setAttribute("aria-pressed", String(terminalShown));
    return toggle;
  };
  /** The drawer shown (a shell opened in its agent's VM, or the one it had taken up again) or hidden (its shell runs on). */
  function showTerminal(on: boolean): void {
    const n = now();
    const vm = n ? terminalOf(n) : null;
    terminalShown = on && Boolean(vm);
    // (Hidden while you typed in it: the message box takes the keys.)
    const typing = drawer.contains(document.activeElement);
    drawer.hidden = !(terminalShown && desk.matches);
    if (n) drawHead(n, true);
    if (!terminalShown || !vm) {
      if (typing && !composerWrap.hidden) input.focus();
      return;
    }
    // First shown on this device: 38 % of the thread's height, at most 360 px.
    sizeDrawer(drawerHeight || Math.min(360, column.getBoundingClientRect().height * 0.38));
    if (!term || term.run.ended || term.sandbox !== vm.id) {
      term?.scope.dispose();
      const screen = h("div", { class: "term-screen" });
      replace(termBox, screen);
      termTitle.textContent = vm.name;
      termStatus.textContent = "Opening…";
      endShell.hidden = false;
      newShell.hidden = true;
      const child = scope.child();
      const said = (text: string) => {
        termStatus.textContent = text;
        // (Its shell ended: a new one in its place, a press away.)
        const ended = Boolean(term?.run.ended);
        endShell.hidden = ended;
        newShell.hidden = !ended;
      };
      term = { sandbox: vm.id, scope: child, run: runTerminal(ctx, vm, screen, { scope: child, say: said }) };
    }
    term.run.focus();
  }
  /** Its height, between DRAWER_LEAST and what leaves the thread 220 px. */
  function sizeDrawer(height: number): void {
    const most = Math.max(DRAWER_LEAST, column.getBoundingClientRect().height - 220);
    drawerHeight = Math.round(Math.min(most, Math.max(DRAWER_LEAST, height)));
    drawer.style.setProperty("--drawer-h", `${drawerHeight}px`);
    grip.setAttribute("aria-valuenow", String(drawerHeight));
  }
  // Its top edge pulled up or down (or ↑ ↓ on it) sets its height, kept on this device.
  grip.addEventListener("pointerdown", (event) => {
    event.preventDefault();
    grip.setPointerCapture(event.pointerId);
    const from = event.clientY;
    const start = drawerHeight;
    const move = (e: PointerEvent) => sizeDrawer(start + from - e.clientY);
    const done = () => {
      grip.removeEventListener("pointermove", move);
      keepDrawerHeight(drawerHeight);
    };
    grip.addEventListener("pointermove", move);
    grip.addEventListener("pointerup", done, { once: true });
    grip.addEventListener("pointercancel", done, { once: true });
  });
  grip.addEventListener("keydown", (event) => {
    if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
    event.preventDefault();
    sizeDrawer(drawerHeight + (event.key === "ArrowUp" ? 24 : -24));
    keepDrawerHeight(drawerHeight);
  });

  function drawHead(n: Now, force = false): void {
    const working = n.task.status === "running";
    const state = taskState(n.task);
    const chips = threadChips(n.task, verdictOf(n.task, factsOfRecord(n.task.record) ?? (trailRead ? factsOfProof(proofOf(n.task, trail.entries)) : null)), changes?.base ?? null);
    const version = JSON.stringify([n.task.title, n.project, n.name, n.agent?.avatar, working, state, shownDetails, wide.matches, chips, desk.matches, terminalShown, terminalOf(n)?.id]);
    if (version === headVersion && !force) return;
    headVersion = version;
    const direct = directRoom(n.snapshot, n.task.assignee);
    // The agent's mark, the one in focus: its slats slide while it works; as its task ends it settles (done) or its bottom
    // slat drops (failed), once, then it is still.
    const face = h("span", { class: "thread-head-face" }, agentFace({ id: n.task.assignee, profile: n.agent?.avatar, size: 28, mood: orbMoodOfState("working"), state: markStateOfAgent(state), label: `${n.name}${working ? ", working" : ""}` }));
    keepPlace(head, () =>
      replace(
        head,
        backHome(),
        h(
          "div",
          { class: "thread-crumb grow" },
          h("span", { class: "thread-crumb-project" }, projectTile(n.project), h("span", { class: "ellipsis" }, n.project.name)),
          h("span", { class: "thread-crumb-sep", "aria-hidden": "true" }, "/"),
          h("h1", { class: "thread-title ellipsis", title: n.task.title }, n.task.title),
          h("p", { class: "thread-sub ellipsis" }, `${n.project.name} · ${n.name}`),
        ),
        headChips(chips),
        h(
          "div",
          { class: "actions thread-head-acts" },
          // Its agent's desktop and terminal, watched and taken over, in its Workspace.
          direct && n.agent?.workspace ? h("a", { class: "btn ghost sm thread-workspace", href: hashOf("team", { room: direct.id, teamTab: "workspace" }), title: `${n.name}'s Workspace: its desktop to watch and take over, a terminal, its files` }, icon("monitor", { size: 15 }), h("span", { class: "label" }, "Workspace")) : null,
          terminalToggle(n),
          detailsToggle(),
        ),
        face,
      ),
    );
    head.dataset.state = state;
  }

  /** A folded group of steps: its line, and what is in it a click away. */
  const groupEl = (group: StepGroup): HTMLElement => {
    const mark = group.kind === "gate" ? (group.tone === "ok" ? "check" : "x") : group.kind === "review" ? "review" : group.kind === "note" ? (group.tone === "warn" ? "alert" : "info") : group.kind === "plan" ? "scroll" : group.kind === "edit" ? "edit" : group.kind === "read" ? "file" : group.kind === "submitted" ? "shield-check" : group.kind === "steer" ? "arrow-up" : "terminal";
    const line = h("span", { class: "step-line" }, h("span", { class: "step-icon", "data-tone": group.tone === "ok" ? "ok" : group.tone === "failed" ? "failed" : group.tone === "warn" ? "needs" : null }, icon(mark, { size: 13 })), h("span", { class: "step-text ellipsis" }, group.text));
    // (A steer whose words are one line says them whole in its line; a longer one opens on them.)
    const whole = group.kind === "steer" && !group.items[0]?.text.includes("\n");
    if (!group.items.length || whole || (group.items.length === 1 && group.kind !== "plan" && group.kind !== "review" && group.kind !== "gate" && group.kind !== "steer")) return h("li", { class: "thread-step", "data-kind": group.kind, "data-by": group.by ?? null }, line);
    return h(
      "li",
      { class: "thread-step", "data-kind": group.kind, "data-by": group.by ?? null },
      h(
        "details",
        {},
        h("summary", { "data-key": `step:${group.from}` }, line),
        h("ul", { class: "step-items" }, ...group.items.map((item) => h("li", { class: cx(group.kind !== "plan" && group.kind !== "review" && group.kind !== "steer" && "mono", group.kind === "steer" && "pre-wrap", "step-item") }, item.text, item.exit !== null && item.exit !== 0 ? h("span", { class: "step-exit" }, ` exit ${item.exit}`) : null))),
      ),
    );
  };

  /** What proves it, apart from what the agent says: the Verified card, or why it isn't verified. */
  function proofCard(n: Now, proof: Proof): HTMLElement | null {
    const task = n.task;
    if (task.status !== "done" && task.status !== "failed") return null;
    const verified = task.status === "done" && task.verified;
    const end = taskEnd(task);
    const seal = proofSeal(task, factsOfRecord(task.record) ?? factsOfProof(proof), end?.why ?? "") ?? { word: verified ? "Reviewed" : "Not verified", by: end?.why ?? "", passed: verified };
    const files = task.changes?.files ?? changes?.files.length ?? 0;
    const added = changes ? changes.files.reduce((sum, file) => sum + (file.added ?? 0), 0) : null;
    const removed = changes ? changes.files.reduce((sum, file) => sum + (file.removed ?? 0), 0) : null;
    const actions = canAct ? taskActions(task) : [];
    const room = n.snapshot.rooms.find((one) => one.id === task.room);
    const caveats = [
      proof.sameModel ? "The review was by the same model that did the work: no other reviewer model could answer." : null,
      proof.provesNothing ? (verified ? "Each gate passed before the work too, so none shows it was done: the reviewer decided alone." : "Each gate passes before any work, so none can show this work was done.") : null,
      !proof.gates.length && verified ? "No commands were given to prove it: the reviewer decided alone." : null,
    ].filter((line): line is string => line !== null);
    const review = proof.review;
    // Steered work was judged against its brief and its steers, in order: said beside the verdict.
    const judged = judgedLine(judgedWith(trail.entries), task.steers ?? []);
    // One line with its verdict (the owner's word, 27 November 2026: "Proof is one line with its verdict, expandable"):
    // what its gates came to and what it changed beside the word, a warning's mark where one is said inside; opened, the
    // verdict's reason, its gates whole, the reviewer's words and what it cost. What to do with it stays out, under it.
    const passed = proof.gates.filter((gate) => gate.state === "passed").length;
    const summary = [
      proof.gates.length ? `${passed} of ${proof.gates.length} ${proof.gates.length === 1 ? "gate" : "gates"} passed` : null,
      files ? `${files} ${files === 1 ? "file" : "files"}${added !== null ? ` +${added} −${removed}` : ""}` : null,
    ].filter((part): part is string => part !== null);
    return h(
      "section",
      { class: "proof", "data-verdict": verified ? "verified" : "failed", "aria-label": seal.by ? `${seal.word}: ${seal.by}` : seal.word },
      h(
        "details",
        { class: "proof-fold", open: proofOpen, ontoggle: (event: Event) => (proofOpen = (event.currentTarget as HTMLDetailsElement).open) },
        h(
          "summary",
          { class: "proof-seal" },
          h("span", { class: "proof-mark", "aria-hidden": "true" }, icon(seal.passed ? "check" : "x", { size: 12 })),
          // The verdict that follows the proof (the iPhone's words): never "Verified" above a warning that its gates proved nothing.
          h("strong", {}, seal.word),
          summary.length ? h("span", { class: "proof-sum tnum ellipsis" }, ` · ${summary.join(" · ")}`) : null,
          caveats.length ? h("span", { class: "proof-warned", title: caveats.join(" "), "aria-label": "A warning, inside" }, icon("alert", { size: 13 })) : null,
          icon("chevron-right", { size: 14, class: "chev" }),
        ),
        h(
          "div",
          { class: "proof-body" },
          seal.by ? h("p", { class: "proof-by" }, seal.by) : null,
          ...caveats.map((line) => h("p", { class: "proof-caveat" }, icon("alert", { size: 13 }), h("span", {}, line))),
          proof.gates.length
            ? h(
                "ol",
                { class: "proof-gates", "aria-label": "Its gates" },
                ...proof.gates.map((gate) =>
                  h(
                    "li",
                    { class: "proof-gate", "data-state": gate.state },
                    h("span", { class: "proof-gate-mark", "aria-label": gate.state }, icon(GATE_ICON[gate.state], { size: 12 })),
                    // The command whole and what it said under it, never cut (the iPhone's): a gate is the proof.
                    h("span", { class: "proof-gate-text" }, h("code", {}, gate.command), h("span", { class: "proof-gate-said tnum" }, gate.exit !== null ? [`exit ${gate.exit}`, gateTime(gate.ms), gate.said || null].filter(Boolean).join(" · ") : "not run")),
                  ),
                ),
              )
            : null,
          review ? h("p", { class: "proof-review" }, icon("review", { size: 13 }), h("span", {}, h("strong", {}, review.verdict === "pass" ? "The reviewer passed it" : "The reviewer sent it back"), review.notes ? `: “${review.notes.split("\n")[0]!.slice(0, 200)}”` : "")) : null,
          review && judged ? h("p", { class: "proof-review proof-steered" }, icon("arrow-up", { size: 13 }), h("span", {}, judged)) : null,
          h(
            "div",
            { class: "proof-facts" },
            files
              ? h(
                  "span",
                  { class: "proof-changes" },
                  n.agent && ctx.can("sandbox") ? h("button", { type: "button", class: "link-button", onclick: () => openWorkspace(ctx, { id: task.assignee, name: n.name }, "changes", task.id) }, `${files} file${files === 1 ? "" : "s"} · Review`, icon("chevron-right", { size: 12 })) : `${files} file${files === 1 ? "" : "s"} kept`,
                  added !== null ? h("span", { class: "tnum proof-diff" }, " ", h("span", { "data-tone": "ok", class: "toned" }, `+${added}`), " ", h("span", { "data-tone": "failed", class: "toned" }, `−${removed}`)) : null,
                )
              : h("span", { class: "subtle" }, "No changes kept"),
            h("span", { class: "tnum subtle" }, prices || !task.record ? costWords(task, prices ?? {}) : ""),
          ),
        ),
      ),
      actions.length || task.shipped
        ? h(
            "div",
            { class: "proof-acts" },
            ...actions.map((action) =>
              action === "ship"
                ? button("Ship it…", { variant: "primary", size: "sm", icon: "external", onClick: () => shipTask(ctx, task) })
                : action === "again"
                  ? button("Give again…", { variant: verified ? "default" : "primary", size: "sm", icon: "retry", onClick: () => room && giveTask(ctx, room, giveAgain(task)) })
                  : action === "resume"
                    ? button("Resume", { size: "sm", icon: "play", onClick: () => void controlTeam(ctx, { task: task.id, action: "resume" }) })
                    : null,
            ),
            // Verified work with nothing to ship (no repository, or shipped already) can still be given again, revised.
            verified && !actions.includes("again") && canAct ? button("Give again…", { size: "sm", icon: "retry", onClick: () => room && giveTask(ctx, room, giveAgain(task)) }) : null,
            task.shipped ? h("a", { class: "btn ghost sm", href: task.shipped.url, target: "_blank", rel: "noopener noreferrer" }, icon("external", { size: 14 }), task.shipped.pr ? `Pull request #${task.shipped.pr}` : "Its pull request") : null,
          )
        : null,
    );
  }

  function drawThread(force = false): void {
    const n = now();
    if (!n) return;
    if (!trailRead) return;
    const task = n.task;
    const entries = trail.entries;
    const groups = stepGroups(entries);
    const summary = workSummary(entries, task.record);
    const proof = proofOf(task, entries);
    const running = task.status === "running";
    const asks = running ? ctx.live.actions.value.filter((action) => isWaiting(action) && agentOfCaller(action.by) === task.assignee) : [];
    // (What it said, unless no more than a verdict the proof says: never "Verified." beside it.)
    const said = saidBesideProof(taskEnd(task)?.said);
    const talk = conversationOf(room, task);
    const dependents = n.snapshot.tasks.filter((other) => other.dependsOn.includes(task.id));
    const waitsFor = task.status === "queued" ? task.dependsOn.map((dep) => n.snapshot.tasks.find((other) => other.id === dep)).filter((other): other is TeamTask => Boolean(other && !(other.status === "done" && other.verified))) : [];
    const version = JSON.stringify([task, entries.length, entries.at(-1)?.n, asks.map((a) => a.id), talk.map((m) => m.id), Boolean(prices), changes?.files.length, n.name, n.project.name, dependents.map((d) => [d.id, d.status]), Math.floor(Date.now() / 60_000)]);
    if (version === threadVersion && !force) return;
    threadVersion = version;
    const from = handedFrom(task.givenBy);
    const proposer = from ? (ctx.live.fleet.value?.devices.find((device) => device.id === from)?.name ?? null) : task.proposedBy ? (n.snapshot.agents.find((person) => person.id === task.proposedBy)?.name ?? (task.proposedBy === "primary" ? "Your agent" : task.proposedBy)) : null;
    const nearEnd = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 120;
    const startedAgo = shortSpan(Date.now() - task.createdAt);
    const facts = [sensitiveLine(task), steppedLine(task), task.outcome ? "A step of an outcome your agent owns" : null, task.fix ? `It fixes pull request ${task.fix.pr ? `#${task.fix.pr}` : task.fix.branch}` : null, task.from ? `Started where step ${task.from.step} of another task left its files` : null].filter(Boolean);
    const work: Child[] = [];
    if (groups.length) {
      const list = h("ol", { class: "thread-steps" }, ...groups.map(groupEl));
      if (running) work.push(h("div", { class: "thread-by" }, h("strong", {}, n.name), startedAgo === "now" ? " · just started" : ` · working for ${startedAgo}`), list);
      else
        work.push(
          h(
            "details",
            { class: "thread-worked" },
            h("summary", { "data-key": `worked:${task.id}` }, icon("chevron-right", { size: 14, class: "chev" }), h("span", {}, workedLine(n.name, summary.ms)), summaryWords(summary) ? h("span", { class: "subtle" }, ` · ${summaryWords(summary)}`) : null),
            list,
          ),
        );
    } else if (running) work.push(h("div", { class: "thread-by" }, h("strong", {}, n.name), " is starting on it"));
    else if (task.status === "queued") work.push(h("p", { class: "thread-by" }, waitsFor.length ? `Queued: it starts once ${waitsFor.map((other) => `“${other.title}”`).join(" and ")} ${waitsFor.length === 1 ? "is" : "are"} done and verified.` : `Queued: ${n.name} starts on it next.`));
    keepPlace(thread, () =>
      replace(
        thread,
        // Who gave it, and how; then the brief itself.
        h("p", { class: "thread-dispatch" }, task.givenBy === "primary" || task.proposedBy === "primary" ? orb({ size: 18 }) : icon(task.proposedBy ? "lightbulb" : "layers", { size: 15 }), h("span", {}, dispatchWords(task, n.name, proposer), h("span", { class: "subtle" }, " · "), h("time", { class: "subtle", datetime: new Date(task.createdAt).toISOString(), title: new Date(task.createdAt).toLocaleString() }, relativeTime(task.createdAt)))),
        h("section", { class: "thread-brief", "aria-label": "The brief" }, h("p", { class: "pre-wrap" }, task.goal)),
        facts.length ? h("p", { class: "thread-facts subtle" }, facts.join(" · ")) : null,
        dependents.length ? h("p", { class: "thread-facts subtle" }, `${dependents.map((other) => `“${other.title}”`).join(", ")} ${dependents.length === 1 ? "waits" : "wait"} on it.`) : null,
        ...work,
        // An outward step asks here, in place: Allow once, or Deny.
        ...asks.map((action) => h("div", { class: "thread-ask" }, askItem(ctx, action, null))),
        task.status === "proposed" && canAct
          ? h("div", { class: "thread-ask" }, callout("accent", `${proposer ?? n.name} proposes this. Nothing runs until you approve it.`, { actions: [button("Approve", { variant: "primary", size: "sm", onClick: () => void controlTeam(ctx, { task: task.id, action: "approve" }) }), button("Decline", { size: "sm", onClick: () => void controlTeam(ctx, { task: task.id, action: "stop" }) })] }))
          : null,
        task.status === "interrupted" && canAct
          ? h("div", { class: "thread-ask" }, callout("warn", "The node was cut off while this ran. Look at what it did, then resume it, or give it again.", { actions: [button("Resume", { variant: "primary", size: "sm", onClick: () => void controlTeam(ctx, { task: task.id, action: "resume" }) })] }))
          : null,
        task.status === "stopped"
          ? h("div", { class: "thread-ask" }, callout("quiet", "Stopped before it was done.", { actions: canAct ? [button("Resume", { size: "sm", icon: "play", onClick: () => void controlTeam(ctx, { task: task.id, action: "resume" }) }), button("Give again…", { size: "sm", icon: "retry", onClick: () => { const where = n.snapshot.rooms.find((one) => one.id === task.room); if (where) giveTask(ctx, where, giveAgain(task)); } })] : undefined }))
          : null,
        task.status === "queued" && canAct
          ? h("div", { class: "thread-ask" }, button("Stop it", { variant: "ghost", size: "sm", icon: "stop", onClick: () => void controlTeam(ctx, { task: task.id, action: "stop" }) }))
          : null,
        // What the agent said of it: its own words, never the proof.
        said ? h("section", { class: "thread-said", "aria-label": `What ${n.name} said` }, h("div", { class: "thread-said-by" }, agentFace({ id: task.assignee, profile: n.agent?.avatar, size: 16 }), h("strong", {}, n.name), h("span", { class: "subtle" }, " said")), h("div", { class: "md" }, renderMarkdown(said))) : null,
        proofCard(n, proof),
        // What you or your agent said that its run never took: it ended first.
        ((never) => (never ? h("div", { class: "thread-ask" }, callout("quiet", never.lines.map((line) => h("p", { class: "pre-wrap" }, line)), { title: never.title, icon: "arrow-up" })) : null))(neverReached(task)),
        // What was said in its conversation since: your words and the agent's replies.
        ...talk.map((message) => {
          const owner = message.speaker === "owner";
          const speaker = teamSpeaker(message, n.snapshot.agents);
          return h(
            "article",
            { class: cx("thread-message", owner && "owner"), "aria-label": `${speaker} said` },
            h("div", { class: "thread-message-by" }, h("strong", {}, owner ? "You" : speaker), " ", h("time", { class: "subtle", datetime: new Date(message.createdAt).toISOString() }, relativeTime(message.createdAt))),
            h("div", { class: owner ? "pre-wrap" : "md" }, owner ? message.text : renderMarkdown(message.text)),
          );
        }),
      ),
    );
    if (nearEnd && running) scroller.scrollTop = scroller.scrollHeight;
    drawLive(n);
  }

  /** The one live line while it works: what it runs now, and since when; Stop. */
  let liveTick: ReturnType<typeof setInterval> | undefined;
  scope.add(() => clearInterval(liveTick));
  function drawLive(n: Now): void {
    const step = n.task.status === "running" ? liveStep(trail.entries) : null;
    liveLine.hidden = !step;
    clearInterval(liveTick);
    if (!step) return;
    const since = h("span", { class: "tnum subtle" }, clock(Date.now() - step.since));
    replace(
      liveLine,
      dot("work"),
      h("span", { class: "thread-live-text ellipsis" }, step.command ? ["Running ", h("code", {}, step.text)] : step.text),
      since,
      canAct ? button("Stop", { variant: "ghost", size: "sm", onClick: () => void controlTeam(ctx, { task: n.task.id, action: "stop" }) }) : null,
    );
    liveTick = setInterval(() => (since.textContent = clock(Date.now() - step.since)), 1000);
  }

  /** The details: the agent's VM, where its work began, its changes, its gates as they run, the reviewer, its cost, what
   * waits on it. Beside the thread on a wide screen; a sheet on a phone. */
  function detailsBody(n: Now): HTMLElement {
    return h("div", { class: "td" }, ...detailParts(n));
  }

  /** The details' three parts: where its work is (its VM, its base, its changes), its proof (its gates and its reviewer),
   * and the task itself (its cost, what waits on it, where it ships). */
  function detailParts(n: Now): [HTMLElement, HTMLElement, HTMLElement] {
    const task = n.task;
    const proof = proofOf(task, trail.entries);
    const vm = n.agent?.workspace ?? null;
    const node = vm ? (vm.node === ctx.whoami.node ? "this node" : (ctx.live.fleet.value?.devices.find((device) => device.id === vm.node)?.name ?? "another node")) : null;
    const direct = directRoom(n.snapshot, task.assignee);
    const added = changes ? changes.files.reduce((sum, file) => sum + (file.added ?? 0), 0) : null;
    const removed = changes ? changes.files.reduce((sum, file) => sum + (file.removed ?? 0), 0) : null;
    const fileCount = changes?.files.length ?? task.changes?.files ?? null;
    const dependents = n.snapshot.tasks.filter((other) => other.dependsOn.includes(task.id));
    const kv = (iconName: IconName | HTMLElement, value: Child, end: Child = null, label?: string) =>
      h("div", { class: "td-row", "aria-label": label ?? null }, h("span", { class: "td-icon", "aria-hidden": "true" }, typeof iconName === "string" ? icon(iconName, { size: 14 }) : iconName), h("span", { class: "td-value ellipsis" }, value), end ? h("span", { class: "td-end" }, end) : null);
    const reviewerWords = { passed: "passed it", "sent back": "sent it back", reading: "is reading it", waits: "waits for the gates", none: "not reached" }[proof.reviewer];
    const shipWords = task.shipped ? (task.shipped.pr ? `Pull request #${task.shipped.pr}` : "Shipped") : task.status === "done" && task.verified && task.changes && !task.fix ? "Ready to ship" : task.fix ? `Onto ${task.fix.branch} when verified` : task.changes || n.agent?.repository ? "Ship it when verified" : "Nothing to ship: no repository";
    return [
      h(
        "div",
        { class: "td-sec" },
        kv(
          "monitor",
          vm ? [`${n.name}'s VM`, h("span", { class: "subtle" }, ` on ${node}`)] : h("span", { class: "subtle" }, `${n.name} has no VM yet`),
          vm && direct
            ? h(
                "span",
                { class: "td-seg" },
                h("a", { class: "btn ghost sm", href: hashOf("team", { room: direct.id, teamTab: "workspace" }), title: "Its desktop, to watch and take over" }, "Peek"),
                ctx.can("sandbox") && vm.node === ctx.whoami.node ? button("Terminal", { variant: "ghost", size: "sm", onClick: () => (desk.matches ? showTerminal(true) : openTerminal(ctx, { id: vm.id, name: `${n.name}'s VM` })) }) : null,
              )
            : null,
        ),
        kv("code", task.fix ? h("span", { class: "mono" }, task.fix.branch) : task.changes ? h("span", { class: "mono" }, `from ${task.changes.base.slice(0, 10)}`) : h("span", { class: "subtle" }, n.agent?.repository ? "its repository, as fetched" : "no repository"), task.from ? `step ${task.from.step}` : null),
        kv(
          "file",
          fileCount !== null ? `Changes · ${fileCount} file${fileCount === 1 ? "" : "s"}` : h("span", { class: "subtle" }, task.status === "running" ? "Changes as it works" : "No changes kept"),
          added !== null && fileCount
            ? n.agent && ctx.can("sandbox")
              ? h("button", { type: "button", class: "link-button tnum", onclick: () => openWorkspace(ctx, { id: task.assignee, name: n.name }, "changes", task.id) }, h("span", { "data-tone": "ok", class: "toned" }, `+${added}`), " ", h("span", { "data-tone": "failed", class: "toned" }, `−${removed}`), icon("chevron-right", { size: 12 }))
              : h("span", { class: "tnum" }, `+${added} −${removed}`)
            : null,
        ),
      ),
      h(
        "div",
        { class: "td-sec" },
        h("div", { class: "td-label" }, h("span", {}, proof.gates.length ? `Gates · ${proof.passed} of ${proof.gates.length} passed` : "No gates"), h("span", {}, `Reviewer ${reviewerWords}`)),
        ...proof.gates.map((gate) =>
          h(
            "div",
            { class: "td-gate", "data-state": gate.state },
            h("span", { class: "td-icon", "aria-label": gate.state }, icon(GATE_ICON[gate.state], { size: 12 })),
            h("code", { class: "ellipsis" }, gate.command),
            h("span", { class: "td-end tnum" }, gate.state === "running" ? "running" : gate.state === "waiting" ? (task.status === "running" ? "next" : "not run") : (gateTime(gate.ms) ?? `exit ${gate.exit}`)),
          ),
        ),
        !proof.gates.length ? h("p", { class: "td-note" }, "No commands were given to prove it: the independent reviewer decides alone.") : null,
      ),
      h(
        "div",
        { class: "td-sec" },
        h("div", { class: "td-label" }, h("span", {}, "This task"), h("span", { class: "tnum" }, prices || !task.record ? costWords(task, prices ?? {}) || "no budget" : "")),
        ...dependents.map((other) => kv(agentFace({ id: other.assignee, profile: n.snapshot.agents.find((person) => person.id === other.assignee)?.avatar, size: 16 }), `“${other.title}” waits on it`, other.status, `“${other.title}” waits on it`)),
        kv("external", shipWords, task.shipped ? h("a", { href: task.shipped.url, target: "_blank", rel: "noopener noreferrer" }, "Open") : null),
      ),
    ];
  }

  /** A desk's panel (from 1024 px): its tabs, and the one chosen (kept on this device). */
  function deskPanel(n: Now): HTMLElement {
    const [where, proof, rest] = detailParts(n);
    const tabs = (["changes", "proof", "details"] as const).map((tab) =>
      h(
        "button",
        {
          type: "button",
          class: "dp-tab",
          role: "tab",
          "aria-selected": String(tab === panelTab),
          onclick: () => {
            panelTab = tab;
            keepPanelTab(tab);
            drawDetails(true);
          },
        },
        PANEL_WORDS[tab],
      ),
    );
    const body = panelTab === "changes" ? changesPane(n) : panelTab === "proof" ? h("div", { class: "td" }, proof) : h("div", { class: "td" }, where, rest);
    return h("div", { class: "dp" }, h("div", { class: "dp-tabs", role: "tablist", "aria-label": "The task's details" }, ...tabs), h("div", { class: "dp-body", role: "tabpanel" }, body));
  }

  /** What it changed, as T3 Code's diff panel shows it: each file with its lines added and taken away, its part of the
   * diff opening in place (drawn only once opened: a long diff costs nothing until you look). */
  function changesPane(n: Now): HTMLElement {
    const task = n.task;
    if (!changes) {
      const kept = task.changes;
      // What it kept, where its VM can't be looked into (this device, or its VM gone): its files, among what is kept.
      if (kept && (!ctx.can("sandbox") || changesUnread)) {
        const open = ctx.can("mind:read") ? h("button", { type: "button", class: "link-button", onclick: () => ctx.navigate("artifacts", { intent: kept.artifact }) }, "Open what it kept") : null;
        return h("p", { class: "dp-note" }, `It kept ${kept.files} changed file${kept.files === 1 ? "" : "s"}, from ${kept.base.slice(0, 8)}.`, open ? " " : null, open);
      }
      const said = !ctx.can("sandbox") ? "This device can't look into its VM." : !n.agent?.repository && !kept ? "It works in no repository." : task.status === "proposed" || task.status === "queued" ? "Nothing yet: it hasn't started." : changesUnread ? "Its VM can't be looked into just now." : "Reading what it changed…";
      return h("p", { class: "dp-note" }, said);
    }
    const view = changes;
    const parts = diffParts(view.diff);
    const line = changesLine(view);
    const files = view.files.map((file) => {
      const part = parts.get(file.path);
      const summary = h(
        "summary",
        { class: "dp-file-line" },
        h("span", { class: "dp-status mono" }, file.status),
        h("span", { class: "dp-path mono ellipsis", title: file.path }, file.path),
        file.added === null ? h("span", { class: "dp-lines subtle" }, "binary") : h("span", { class: "dp-lines tnum" }, file.added ? h("span", { class: "tok-added-text" }, `+${file.added}`) : null, file.added && file.removed ? " " : null, file.removed ? h("span", { class: "tok-removed-text" }, `−${file.removed}`) : null),
      );
      // (A file the diff has no part for, one binary or past where it is cut, is its line alone.)
      if (!part) return h("div", { class: "dp-file" }, h("div", { class: "dp-file-line" }, ...summary.childNodes));
      const el = h("details", { class: "dp-file" }, summary);
      el.addEventListener("toggle", () => {
        if (el.open && el.childElementCount === 1) el.append(codeBlock({ lang: "diff", v: hunksOf(part) }));
      });
      return el;
    });
    return h(
      "div",
      { class: "dp-changes" },
      h("p", { class: "dp-sum" }, h("strong", { class: "tnum" }, `${line.files} file${line.files === 1 ? "" : "s"}`), " ", h("span", { class: "tnum" }, h("span", { class: "tok-added-text" }, `+${line.added}`), " ", h("span", { class: "tok-removed-text" }, `−${line.removed}`)), h("span", { class: "subtle" }, ` · ${line.from}`)),
      ...(files.length ? files : [h("p", { class: "dp-note" }, "Nothing changed yet.")]),
      ...view.untracked.map((path) => h("div", { class: "dp-file" }, h("div", { class: "dp-file-line" }, h("span", { class: "dp-status mono", title: "Not yet in git" }, "?"), h("span", { class: "dp-path mono ellipsis", title: path }, path), h("span", { class: "dp-lines subtle" }, "new")))),
      view.cut ? h("p", { class: "dp-note" }, "The diff is cut: only its beginning is here.") : null,
      view.redacted ? h("p", { class: "dp-note" }, "Something that looked like a key was redacted.") : null,
    );
  }

  function drawDetails(force = false): void {
    const n = now();
    if (!n || !trailRead) return;
    details.hidden = !wide.matches || !shownDetails;
    if (details.hidden) return;
    const version = JSON.stringify([n.task, trail.after, Boolean(prices), changes?.files.length, changes?.diff.length, n.agent?.workspace, n.snapshot.tasks.filter((other) => other.dependsOn.includes(n.task.id)).map((other) => [other.id, other.status]), desk.matches, panelTab]);
    if (version === detailsVersion && !force) return;
    detailsVersion = version;
    // (A file's diff left open stays open as its panel is drawn again.)
    const opened = new Set([...details.querySelectorAll("details.dp-file[open] .dp-path")].map((el) => el.textContent ?? ""));
    keepPlace(details, () => replace(details, desk.matches ? deskPanel(n) : detailsBody(n)));
    for (const el of details.querySelectorAll<HTMLDetailsElement>("details.dp-file")) if (opened.has(el.querySelector(".dp-path")?.textContent ?? "")) el.open = true;
  }

  function openDetailsSheet(): void {
    const n = now();
    if (!n) return;
    openSheet({ title: "The task's details", description: n.task.title, body: detailsBody(n) });
  }

  /** What this device does on Enter while a task runs (Settings → Chat), and how it's pointed: read as the composer is drawn. */
  const coarse = matchMedia("(pointer: coarse)");
  const mac = /Mac|iPhone|iPad/.test(navigator.platform);
  let running = false;
  function drawComposer(n: Now): void {
    composerWrap.hidden = !canAct;
    if (!canAct) return;
    running = n.task.status === "running";
    const enter = chatEnter();
    input.placeholder = `Tell ${n.name}…`;
    input.setAttribute("aria-label", running ? `Steer ${n.name}'s task, or queue a message for after it` : `Message ${n.name}`);
    hint.textContent = steerHint({ status: n.task.status, name: n.name, enter, coarse: coarse.matches, mac });
    // While it runs: steer it, or queue for after it, the one Enter does in ink. Otherwise a message, as ever.
    send.hidden = running;
    steerButton.hidden = queueButton.hidden = !running;
    steerButton.classList.toggle("primary", enter === "steer");
    queueButton.classList.toggle("primary", enter === "queue");
    drawWaiting(n);
    syncComposer();
  }

  /** What is on its way to the work, above the message box: said once the node has it, gone once its run has taken it. */
  function drawWaiting(n: Now): void {
    const waiting = steersWaiting(n.task, n.name);
    onItsWay.hidden = !waiting;
    replace(onItsWay, ...(waiting ? [h("div", { class: "thread-steering-title" }, dot("work"), h("span", {}, waiting.title)), ...waiting.lines.map((line) => h("p", { class: "thread-steering-line", title: line }, line))] : []));
  }

  function syncComposer(): void {
    const text = input.value.trim();
    const secret = findSecrets(input.value).length > 0;
    // (A steer holds TEAM_LIMITS.steer characters; a message, a good deal more.)
    const long = running && text.length > TEAM_LIMITS.steer;
    send.disabled = queueButton.disabled = sending || !text || secret;
    steerButton.disabled = sending || !text || secret || long;
    replace(
      problem,
      secret
        ? callout("warn", "That looks like a secret. Remove it before sending; keys belong in the vault.")
        : long
          ? callout("quiet", `A steer holds ${TEAM_LIMITS.steer.toLocaleString("en-US")} characters at most: queue it for after this task instead.`)
          : null,
    );
  }

  /** Your words, as Enter or a button said: a steer of the running task, or a message (queued for after it while it runs). */
  async function deliver(how?: "send" | "steer" | "queue"): Promise<void> {
    const n = now();
    syncComposer();
    if (!n) return;
    const action = how ?? steerAction({ running: n.task.status === "running", enter: chatEnter(), modifier: false });
    const text = input.value.trim();
    if ((action === "steer" ? steerButton : action === "queue" ? queueButton : send).disabled) return;
    sending = true;
    syncComposer();
    try {
      if (action === "steer") {
        await ctx.api.post("/api/team/steer", { task: n.task.id, text }, scope.signal);
        if (input.value.trim() === text) input.value = "";
        // (The task now holds it, on its way: the team says so.)
        await ctx.live.refreshTeam();
      } else {
        await ctx.api.post("/api/team/messages", { room: n.task.room, text }, scope.signal);
        if (input.value.trim() === text) input.value = "";
        await readRoom(n.task);
        scroller.scrollTop = scroller.scrollHeight;
      }
    } catch (error) {
      if (!isAbort(error)) toast(action === "steer" ? "It wasn't steered" : "Message wasn't sent", { tone: "error", description: errorMessage(error) });
    } finally {
      sending = false;
      if (!scope.disposed) syncComposer();
    }
  }
  input.addEventListener("input", syncComposer);
  input.addEventListener("keydown", (event: KeyboardEvent) => {
    if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
      event.preventDefault();
      // While it runs, Enter does what this device chose and Ctrl or ⌘ with it the other (as a chat's composer).
      void deliver(steerAction({ running, enter: chatEnter(), modifier: event.metaKey || event.ctrlKey }));
    }
  });

  /** On screen, an ended task's result is read: no longer new to you, on any device (lib/work.ts seenOnOpen). */
  function markRead(n: Now): void {
    if (document.hidden || !trailRead) return;
    const mark = seenOnOpen(n.task.id, n.snapshot);
    const asked = JSON.stringify([mark, n.snapshot.seen?.[`agent:${n.task.assignee}`]]);
    if (!mark || asked === marked) return;
    marked = asked;
    void ctx.api.post("/api/team/seen", mark).then(() => ctx.live.refreshTeam(), () => {});
  }

  const redraw = () => draw();
  scope.add(ctx.live.team.subscribe(redraw));
  scope.add(ctx.live.team.subscribe(() => readIfMoved()));
  scope.add(ctx.live.teamProblem.subscribe(redraw));
  scope.add(ctx.live.actions.subscribe(() => (threadVersion = "", draw())));
  scope.add(projectNames.subscribe(() => (headVersion = "", draw())));
  // The conversation read again as the team changes (its replies), at most every two seconds.
  scope.add(ctx.live.follow(["team"], () => {
    const n = now();
    if (n) void readRoom(n.task);
  }, 2000, 2000));
  const resized = () => {
    headVersion = "";
    drawer.hidden = !(terminalShown && desk.matches);
    drawDetails(true);
    draw();
  };
  wide.addEventListener("change", resized);
  scope.add(() => wide.removeEventListener("change", resized));
  desk.addEventListener("change", resized);
  scope.add(() => desk.removeEventListener("change", resized));
  // T3 Code's ⌘D (its details) and ⌘J (its terminal, a desk's, where its agent's VM is on this node), while it shows.
  scope.add(
    onViewKey("panel", () => {
      if (!now()) return false;
      toggleDetails();
      return true;
    }),
  );
  scope.add(
    onViewKey("terminal", () => {
      const n = now();
      if (!n || !desk.matches || !terminalOf(n)) return false;
      showTerminal(!terminalShown);
      return true;
    }),
  );
  // The trail as it was last read this session, at once (api.peek): the work shows with the page.
  const kept = id ? ctx.api.peek<TrailPage>("/api/team/trail", { task: id, after: 0 }) : null;
  if (kept && !kept.more) {
    trail = takeTrail(trail, kept);
    trailRead = true;
  }
  draw();
  void ctx.live.refreshTeam();
};
