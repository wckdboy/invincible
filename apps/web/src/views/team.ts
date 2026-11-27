import type { SandboxView } from "@invincible/core";
import { outcomeBar, isOutcomeRoom } from "./outcome-bar.ts";
import { findSecrets } from "@invincible/core/secret-scan";
import type { TeamEngramStatus, TeamHarness, TeamMessage, TeamRoomView, TeamSnapshot, TeamTask, Agent } from "@invincible/core/team";
import { TEAM_LIMITS } from "@invincible/core/team-limits";
import { avatarExpression } from "@invincible/core/avatar";
import { isAbort, isUnavailable } from "../api.ts";
import { errorMessage, type View } from "../context.ts";
import { PRIMARY } from "../lib/arrange.ts";
import { hasDesktop } from "../lib/desktop.ts";
import { besideChip } from "../lib/agent-state.ts";
import { rosterRows } from "../lib/roster.ts";
import { type TaskAction, taskStanding } from "../lib/task-card.ts";
import { activeTeamWork, engramLine, HARNESS, harnessNote, agentWorksOn, taskDependencies, teamSpeaker, agentMaker, type HarnessStatus } from "../lib/team.ts";
import { giveAgain, timeline, timelineTasks } from "../lib/timeline.ts";
import { relativeTime } from "../lib/time.ts";
import { agentPanelShown, setAgentPanelShown } from "../prefs.ts";
import { badge, button, callout, dot, empty, errorState, list, listRow, note, section, skeletonRows } from "../ui/controls.ts";
import { composerBox } from "../ui/composer.ts";
import { h, keepPlace, prefersReducedMotion, replace, syncChildren } from "../ui/dom.ts";
import { icon } from "../ui/icons.ts";
import { renderMarkdown } from "../ui/markdown.ts";
import { stateChip, workerAvatar } from "../ui/avatar.ts";
import { orb } from "../ui/orb.ts";
import { toast } from "../ui/toast.ts";
import { attachedView, attachTray, type Waiting } from "./attach-tray.ts";
import { agentsHome } from "./board.ts";
import { noteSaid, seatFace, tableOf } from "./roster.ts";
import { openConsole } from "./sandboxes.ts";
import { desktopViewer, type DesktopViewer } from "./desktop.ts";
import { showLatest, taskCard } from "./task-card.ts";
import { controlTeam, editAgent, editNotes, editRoom, exportAgent, giveTask, growVm, provisionVm, remakeVm, removeAgent, setCiBack, setEngram, shipTask, steerTask } from "./team-forms.ts";
import { openTerminal } from "./terminal.ts";
import { openWorkspace } from "./workspace.ts";

/*
 * An agent, or a room, as one timeline: what was said and the tasks given, in the order they happened, each task a
 * card (views/task-card.ts). An agent's Workspace (its VM, its harnesses, its notes store) is a panel opened from its
 * header. On a wide screen an agent's timeline has a side panel beside it (unless you hid it on this device): the
 * agent and what it is doing, its tasks, its workspace and its working notes. Conversations and work belong to the
 * node: polling only observes them, and leaving never stops an agent. Unsaved drafts stay in memory, never storage.
 * Who there is to talk to is the roster's (views/roster.ts); with no conversation open, the agents' own page is
 * the board's (views/board.ts).
 */
const drafts = new Map<string, string>();
/** Each conversation's next files, kept while you look elsewhere, as its words are. */
const roomFiles = new Map<string, Waiting[]>();
interface WorkspaceStatus {
  workspace: SandboxView | null;
  error?: string;
  harnesses?: HarnessStatus[];
  /** The notes store (Engram): the node's switch, and whether this agent's VM has it. Absent on a node from before it. */
  engram?: TeamEngramStatus;
}

export const teamView: View = (root, ctx, { scope, opts }) => {
  const canEdit = ctx.can("fleet:admin");
  const canChat = canEdit && ctx.can("chat");
  const roomId = opts.room;
  /** Whether the task asked for (opts.task, from Work) has been brought into view yet. */
  let focused = false;
  const panelAsked = opts.teamTab === "workspace";
  let snapshot: TeamSnapshot | null = ctx.live.team.value;
  let room: TeamRoomView | null = null;
  let loading = false;
  let sending = false;
  let drawn = "";
  let headVersion = "";
  let workspace: WorkspaceStatus | null = null;
  let workspaceLoading = false;
  /** Each item of the timeline as last drawn, by key: one that hasn't changed is handed back as it is. */
  let drawnItems = new Map<string, { version: string; el: HTMLElement }>();

  const head = h("header", { class: "team-head" });
  const notice = h("div", { class: "team-notice", role: "status", hidden: true });
  const thread = h("div", { class: "team-thread", "aria-label": "Timeline" });
  const content = h("div", { class: "team-content", tabindex: 0 });
  const status = h("div", { class: "team-live", "aria-live": "polite" });
  const problem = h("div", { class: "team-send-error", role: "status" });
  const input = h("textarea", { rows: 2, maxlength: TEAM_LIMITS.message, placeholder: "Message…", "aria-label": "Message", autocomplete: "off", enterkeyhint: "send" });
  input.value = roomId ? (drafts.get(roomId) ?? "") : "";
  // Files with your words: chosen, pasted or dropped, as in your chat with the primary.
  const tray = attachTray(ctx, {
    files: { get: () => (roomId ? (roomFiles.get(roomId) ?? []) : []), set: (next) => void (roomId && roomFiles.set(roomId, next)) },
    enabled: () => canChat && Boolean(roomId),
    changed: () => syncComposer(),
    disposed: () => scope.disposed,
  });
  const send = button("Send", { variant: "primary", iconOnly: true, icon: "arrow-up", type: "submit", label: "Send" });
  send.classList.add("send");
  // Giving a task (a goal and the commands that prove it) sits beside the message.
  const give = button("Give a task", { size: "sm", icon: "layers", onClick: () => room && giveTask(ctx, room) });
  const composerHint = h("span", { class: "hint grow" });
  // The one message box (ui/composer.ts): the paperclip, the field, Give a task and the send circle.
  const composer = composerBox({
    onSubmit: (event: Event) => {
      event.preventDefault();
      void deliver();
    },
    files: tray.row,
    lead: [tray.button],
    field: input,
    trail: [give],
    send: [send],
    chooser: tray.chooser,
    hint: [icon("shield-check", { size: 13, class: "subtle" }), composerHint],
  });
  tray.take(input, composer);
  tray.render();
  const composerWrap = h("div", { class: "team-composer", hidden: true }, status, problem, composer);
  // An agent's side panel, beside its timeline on a wide screen: shown unless you hid it (remembered on this device).
  const side = h("aside", { class: "team-side", hidden: true });
  let sideShown = agentPanelShown();
  let sideVersion = "";
  // An outcome's room: the bar of what the primary owns there (outcome-bar.ts).
  const ownBar = roomId && isOutcomeRoom(roomId) ? outcomeBar(ctx, roomId, scope.signal) : null;
  const main = h("section", { class: "team-main", "aria-label": "The agents" }, head, notice, ownBar?.el ?? null, h("div", { class: "team-body" }, h("div", { class: "team-column" }, content, composerWrap), side));
  replace(root, h("div", { class: "team-layout" }, main));
  replace(content, skeletonRows(4));

  const nameOf = (id: string): string => (id === "primary" ? "Your agent" : snapshot?.agents.find((person) => person.id === id)?.name ?? snapshot?.removed?.find((person) => person.id === id)?.name ?? id);
  const roomName = (id: string): string => snapshot?.rooms.find((candidate) => candidate.id === id)?.name ?? id;
  /** "made by the primary", for an agent it (or another agent) made; nothing for one of yours. */
  const madeBy = (person: Agent): string => {
    const maker = agentMaker(person, snapshot?.agents ?? [], snapshot?.removed);
    return maker ? `made by ${maker}` : "";
  };
  const personOf = (id: string): Agent | undefined => snapshot?.agents.find((person) => person.id === id);
  /** The agent whose own conversation this is (none: a room). */
  const agent = (): Agent | undefined => (room?.direct && room.members.length === 1 ? personOf(room.members[0]!) : undefined);
  const panelOpen = (): boolean => panelAsked && Boolean(agent());
  const avatar = (person: Agent, live = true, size = 40): HTMLElement =>
    workerAvatar({ id: person.id, name: person.name, profile: person.avatar, size, still: !live, expression: live && snapshot ? avatarExpression(person, snapshot, Date.now()) : "idle" });
  const control = (change: Parameters<typeof controlTeam>[1]) => controlTeam(ctx, change);
  const showPanel = (open: boolean) => roomId && ctx.navigate("team", { room: roomId, ...(open ? { teamTab: "workspace" as const } : {}) });
  const showSide = (shown: boolean): void => {
    sideShown = shown;
    setAgentPanelShown(shown);
    draw(true);
  };
  /** A VM made, or made again: shown at once, and asked about again. */
  const madeVm = (person: Agent) => (made: SandboxView | null) => {
    workspace = { workspace: made };
    draw(true);
    void refreshWorkspace(person.id);
  };

  /** The way back to the roster (a phone's; a wide screen has the roster beside it). */
  const backLink = () => h("a", { class: "btn ghost sm icon-only pane-back", href: "#/team", "aria-label": "The agents", title: "The agents" }, icon("chevron-left", { size: 16 }));

  function renderHead(): void {
    if (!room || !snapshot) {
      // While a room is asked for, its header holds its place (the way back, a face's and two lines' places), so the
      // timeline under it doesn't drop when it arrives. The agents' own page has none.
      replace(head, ...(roomId ? [backLink(), h("span", { class: "skeleton team-head-face", "aria-hidden": "true" }), h("div", { class: "grow stack snug", "aria-hidden": "true" }, h("div", { class: "skeleton team-head-name" }), h("div", { class: "skeleton sk-line team-head-line" }))] : []));
      return;
    }
    const current = room;
    const person = agent();
    const active = [...current.tasks, ...current.deliveries].filter(activeTeamWork);
    // An agent's face sits in its seat, its state in a word beside its name, as on the roster.
    const table = person ? tableOf(ctx) : null;
    const seated = person ? table!.seats.find((one) => one.id === person.id) : undefined;
    const open = panelOpen();
    const version = JSON.stringify([current.id, current.name, current.members.map((id) => [id, nameOf(id)]), current.paused, person, seated, active.map((job) => [job.id, job.status]), person && snapshot ? avatarExpression(person, snapshot, Date.now()) : null, open, sideShown]);
    if (version === headVersion) return;
    headVersion = version;
    const toggle = button("Workspace", { size: "sm", icon: "sandbox", label: open ? "Close the workspace" : "Workspace", onClick: () => showPanel(!open) });
    toggle.classList.add("workspace-toggle");
    toggle.setAttribute("aria-pressed", String(open));
    const sideToggle = button(sideShown ? "Hide the side panel" : "Show the side panel", { variant: "ghost", size: "sm", iconOnly: true, icon: "panel", onClick: () => showSide(!sideShown) });
    sideToggle.classList.add("side-toggle");
    sideToggle.setAttribute("aria-pressed", String(sideShown));
    keepPlace(head, () =>
      replace(
        head,
        backLink(),
        person ? (seated ? seatFace(seated, 32) : avatar(person)) : h("span", { class: "avatar" }, icon("hash")),
        h(
          "div",
          { class: "grow" },
          h("div", { class: "team-head-title" }, h("h2", { class: "ellipsis" }, person?.name ?? current.name), person ? stateChip(seated?.state) : null),
          h("p", { class: "meta ellipsis" }, person ? [agentWorksOn(person), madeBy(person)].filter(Boolean).join(" · ") : [...(current.direct ? [] : ["Your agent"]), ...current.members.map(nameOf)].join(" · ")),
        ),
        current.paused ? badge("Paused", "warn") : null,
        person ? sideToggle : null,
        person ? toggle : null,
        !person && canEdit ? button("Room settings", { variant: "ghost", size: "sm", iconOnly: true, icon: "settings", onClick: () => editRoom(ctx, current) }) : null,
        !person && canChat ? button(current.paused ? "Resume room" : "Pause room", { variant: "ghost", size: "sm", iconOnly: true, icon: current.paused ? "play" : "pause", onClick: () => void control({ room: current.id, action: current.paused ? "resume" : "pause" }) }) : null,
        !person && canChat && active.length ? button("Stop the room's work", { variant: "ghost", size: "sm", iconOnly: true, icon: "stop", onClick: () => void control({ room: current.id, action: "stop" }) }) : null,
      ),
    );
    composerHint.textContent = current.paused ? "Paused · messages are kept" : active.length ? (person ? "Replies when its work ends" : "A busy agent replies when free") : person || current.direct ? `Up to ${current.turnBudget} replies a chain` : "Your agent answers; name an agent with @ to ask it";
    input.placeholder = `Message ${person?.name ?? current.name}…`;
    input.setAttribute("aria-label", `Message ${person?.name ?? current.name}`);
    const writing = current.deliveries.filter((delivery) => activeTeamWork(delivery));
    replace(status, ...writing.map((delivery) => h("span", { class: "row" }, dot(delivery.status === "running" ? "accent" : "neutral", { live: delivery.status === "running" }), `${nameOf(delivery.agent)} ${delivery.status === "running" ? "is writing" : "replies when free"}`)));
    syncComposer();
  }

  function messageEl(message: TeamMessage): HTMLElement {
    const speaker = teamSpeaker(message, snapshot?.agents ?? []);
    const at = h("time", { datetime: new Date(message.createdAt).toISOString(), title: new Date(message.createdAt).toLocaleString() }, relativeTime(message.createdAt));
    if (message.speaker === "system") return h("div", { class: "team-system", "data-key": message.id }, icon("activity", { size: 13 }), h("span", {}, message.text), at);
    const owner = message.speaker === "owner";
    return h(
      "article",
      { class: `team-message${owner ? " owner" : ""}`, "data-key": message.id, "aria-label": `${speaker} said` },
      // (The primary speaking in a room is its orb, at rest, as beside its own answers.)
      owner ? null : message.speaker === PRIMARY ? orb({ size: 40 }) : workerAvatar({ id: message.speaker, name: speaker, profile: personOf(message.speaker)?.avatar, still: true }),
      h(
        "div",
        { class: "team-message-body" },
        h("div", { class: "team-message-by" }, h("strong", {}, speaker), at),
        // What a message of yours carried, above its words (a message may be files alone).
        message.attachments?.length ? attachedView(ctx, message.attachments) : null,
        message.text ? h("div", { class: owner ? "team-owner-text" : "md" }, owner ? message.text : renderMarkdown(message.text)) : null,
      ),
    );
  }

  function act(task: TeamTask, action: TaskAction): void {
    if (action === "again") {
      const where = snapshot?.rooms.find((candidate) => candidate.id === task.room) ?? room;
      if (where) giveTask(ctx, where, giveAgain(task));
    } else if (action === "ship") void shipTask(ctx, task);
    else void control({ task: task.id, action: action === "decline" ? "stop" : action });
  }

  function taskEl(task: TeamTask): HTMLElement {
    return taskCard(ctx, task, {
      room: room!.id,
      roomName,
      assignee: room!.direct ? null : nameOf(task.assignee),
      proposer: task.proposedBy ? nameOf(task.proposedBy) : null,
      dependencies: taskDependencies(task, snapshot?.tasks ?? []),
      canAct: canChat,
      act: (action) => act(task, action),
      againFrom: (step) => {
        const where = snapshot?.rooms.find((candidate) => candidate.id === task.room) ?? room;
        if (where) giveTask(ctx, where, { ...giveAgain(task), from: { task: task.id, step } });
      },
      steer: () => steerTask(ctx, task, nameOf(task.assignee)),
    });
  }

  /** What a task's card shows, so that one whose card would look the same is not drawn again: everything but a running
   * task's latest line, which is set where it is (showLatest), and its times, which it doesn't show. */
  const taskVersion = (task: TeamTask): string => {
    const { progress: _latest, updatedAt: _ended, ...shown } = task;
    return JSON.stringify([shown, roomName(task.room), nameOf(task.assignee), task.proposedBy ? nameOf(task.proposedBy) : null, taskDependencies(task, snapshot?.tasks ?? [])]);
  };

  function renderTimeline(): void {
    if (!room || !snapshot) return;
    const current = room;
    const tasks = timelineTasks(current, snapshot.tasks);
    // (Only the latest words of a long conversation come from the node: the timeline begins where they do.)
    const since = current.messages.length >= TEAM_LIMITS.history ? current.messages[0]?.createdAt : undefined;
    const items = timeline(current.messages, tasks, since === undefined ? {} : { since });
    const next = new Map<string, { version: string; el: HTMLElement }>();
    const els = items.map((item) => {
      const version = item.kind === "message" ? JSON.stringify([item.message.text, teamSpeaker(item.message, snapshot!.agents), personOf(item.message.speaker)?.avatar, relativeTime(item.message.createdAt)]) : taskVersion(item.task);
      const had = drawnItems.get(item.key);
      const el = had?.version === version ? had.el : item.kind === "message" ? messageEl(item.message) : taskEl(item.task);
      if (item.kind === "task" && item.task.status === "running") showLatest(el, item.task);
      next.set(item.key, { version, el });
      return el;
    });
    drawnItems = next;
    const first = content.firstChild !== thread;
    const nearEnd = content.scrollHeight - content.scrollTop - content.clientHeight < 120;
    const person = agent();
    syncChildren(
      thread,
      els.length
        ? els
        : [
            empty({
              icon: "chat",
              title: person ? `Talk with ${person.name}` : `Welcome to ${current.name}`,
              body: person ? `Give ${person.name} a job, share context, or ask a question. A task you give it is a card here, from its first line to what it kept.` : "Your agent is in this room with these agents: say what you need and it answers, or brings in the agents it needs. Name an agent with @ to ask it yourself.",
              compact: true,
            }),
          ],
    );
    if (first) replace(content, thread);
    // A task opened from Work is brought into view, once, and marked a moment; otherwise the timeline opens at its end.
    const asked = !focused && opts.task ? content.querySelector<HTMLElement>(`[data-key="task:${opts.task}"]`) : null;
    if (asked) {
      focused = true;
      asked.scrollIntoView({ block: "center", behavior: "auto" });
      asked.classList.add("is-focus");
      const unmark = setTimeout(() => asked.classList.remove("is-focus"), 2400);
      scope.add(() => clearTimeout(unmark));
    } else if (first || nearEnd) content.scrollTop = content.scrollHeight;
  }

  async function refreshWorkspace(id: string): Promise<void> {
    if (workspaceLoading || !ctx.can("sandbox")) return;
    workspaceLoading = true;
    try {
      const result = await ctx.api.post<WorkspaceStatus>("/api/team/workspace", { id }, scope.signal);
      if (scope.disposed) return;
      workspace = result;
    } catch (error) {
      if (!isAbort(error)) workspace = { workspace: null, error: errorMessage(error) };
    } finally {
      workspaceLoading = false;
      if (!scope.disposed && panelOpen()) draw(true);
    }
  }

  /** A node by its name: this one, one of the fleet's, or one the app can't name. */
  const nodeName = (id: string): string => (id === ctx.whoami.node ? "this node" : (ctx.live.fleet.value?.devices.find((device) => device.id === id)?.name ?? "another node"));

  /** An agent's task in its side panel: its title and where it stands, in its card's words (its verdict once it ended,
   * never "Verified"); a press finds its card in the timeline. */
  const taskRow = (task: TeamTask): HTMLElement => {
    const stands = taskStanding(task);
    const tone = stands.tone === "failed" ? "danger" : stands.tone === "proven" ? "ok" : stands.tone === "active" ? "accent" : "neutral";
    return listRow({
      title: task.title,
      meta: [badge(stands.word, tone), h("time", { datetime: new Date(task.updatedAt).toISOString() }, relativeTime(task.updatedAt))],
      key: `side-task:${task.id}`,
      onClick: () => {
        if (panelOpen()) return void showPanel(false);
        content.querySelector(`[data-key="task:${task.id}"]`)?.scrollIntoView({ block: "center", behavior: prefersReducedMotion() ? "auto" : "smooth" });
      },
    });
  };

  /** The side panel beside an agent's timeline on a wide screen: the agent in its seat and what it is doing, its tasks,
   * its workspace and its working notes. Drawn from the team as the app has it: it asks the node nothing. */
  function renderSide(): void {
    const person = agent();
    side.hidden = !person || !sideShown;
    if (side.hidden || !person || !snapshot) return;
    const table = tableOf(ctx);
    const seated = table.seats.find((one) => one.id === person.id);
    const tasks = snapshot.tasks.filter((task) => task.assignee === person.id).sort((a, b) => b.updatedAt - a.updatedAt);
    const version = JSON.stringify([person, seated, tasks.map((task) => [task.id, task.title, taskStanding(task).word, relativeTime(task.updatedAt)]), panelOpen()]);
    if (version === sideVersion) return;
    sideVersion = version;
    side.setAttribute("aria-label", `${person.name}, beside the timeline`);
    keepPlace(side, () =>
      replace(
        side,
        h(
          "div",
          { class: "team-side-who" },
          seated ? seatFace(seated, 88) : avatar(person, true, 88),
          h("div", { class: "team-side-name" }, h("h2", { class: "ellipsis" }, person.name), stateChip(seated?.state)),
          h("p", { class: "meta" }, [agentWorksOn(person), madeBy(person)].filter(Boolean).join(" · ")),
          seated ? h("p", { class: "team-side-line" }, besideChip(seated.line, seated.state)) : null,
          canEdit
            ? h(
                "div",
                { class: "row wrap" },
                button("Edit", { size: "sm", icon: "edit", onClick: () => void editAgent(ctx, person) }),
                button(person.enabled ? "Pause" : "Resume", { size: "sm", icon: person.enabled ? "pause" : "play", label: `${person.enabled ? "Pause" : "Resume"} ${person.name}`, onClick: () => void control({ agent: person.id, action: person.enabled ? "pause" : "resume" }) }),
              )
            : null,
        ),
        section("Tasks", { count: tasks.length ? String(tasks.length) : undefined, note: tasks.length > 6 ? "The latest six; every one is a card in the timeline." : undefined }, list(tasks.slice(0, 6).map(taskRow), { empty: { icon: "layers", title: "No tasks yet", body: `A task you give ${person.name} is a card in its timeline, and a line here.` } })),
        section(
          "Workspace",
          { actions: button(panelOpen() ? "Back to the timeline" : "Open", { variant: "ghost", size: "sm", onClick: () => showPanel(!panelOpen()) }) },
          note(person.workspace ? `Its VM is on ${nodeName(person.workspace.node)}: its desktop, a terminal into it and its notes store are in its Workspace.` : "No VM yet. Its Workspace makes one: a place of its own for code, files and tools."),
        ),
        section(
          "Working notes",
          { actions: canEdit ? button("Edit", { variant: "ghost", size: "sm", label: `Edit ${person.name}'s working notes`, onClick: () => editNotes(ctx, person) }) : null },
          person.memory.trim() ? h("p", { class: "team-side-notes" }, person.memory.trim()) : note("None yet: what it keeps for itself between tasks, such as an investigation under way or what to pick up next."),
        ),
      ),
    );
  }

  /** The Workspace panel, made once: what is above the desktop and below it is drawn again as it changes, the desktop never. */
  let panel: { top: HTMLElement; slot: HTMLElement; bottom: HTMLElement } | null = null;
  let viewer: DesktopViewer | null = null;
  scope.add(() => viewer?.dispose());

  function renderPanel(): void {
    const person = agent()!;
    const known = workspace;
    const vm = known?.workspace;
    // (The switch as the team says it now; what this VM has, as it was last asked.)
    const notes = engramLine(known?.engram && snapshot ? { ...known.engram, on: snapshot.engram === true } : known?.engram);
    if (!panel) {
      // (Its desktop, when it has one, first: the screen is what the panel is opened to see.)
      panel = { top: h("div", { class: "stack loose" }), slot: h("div", { class: "desktop-slot" }), bottom: h("div", { class: "stack loose" }) };
      const head = h("div", { class: "row between" }, h("h3", {}, "Workspace"), button("Back to the timeline", { variant: "ghost", size: "sm", iconOnly: true, icon: "x", onClick: () => showPanel(false) }));
      replace(content, h("div", { class: "team-panel stack loose", "aria-label": `${person.name}'s workspace` }, head, panel.slot, panel.top, panel.bottom));
    }
    // Its desktop, while its VM runs with one and this device may look: watched from here, and taken over.
    const desktop = Boolean(vm && hasDesktop(vm) && vm.status === "running" && ctx.can("sandbox"));
    if (desktop && !viewer) {
      viewer = desktopViewer(ctx, person, content, canEdit ? () => remakeVm(ctx, person, vm!, madeVm(person), { desktop: true }) : null);
      replace(panel.slot, viewer.el);
    } else if (!desktop && viewer) {
      viewer.dispose();
      viewer = null;
      replace(panel.slot);
    }
    const { top, bottom } = panel;
    keepPlace(top, () =>
      replace(
        top,
        h(
          "div",
          { class: "team-person-summary" },
          avatar(person, true, 56),
          h(
            "div",
            { class: "grow" },
            h("strong", {}, person.name),
            h("p", { class: "small muted" }, person.instructions || "No instructions yet."),
            h("div", { class: "meta" }, [HARNESS[person.harness], agentWorksOn(person), `${person.turnsToday}/${person.dailyTurns} turns/jobs today`, madeBy(person)].filter(Boolean).join(" · ")),
            person.repository ? h("a", { class: "tiny mono", href: person.repository, target: "_blank", rel: "noopener noreferrer" }, person.repository.replace("https://github.com/", "")) : null,
          ),
          canEdit ? button("Edit", { size: "sm", icon: "edit", onClick: () => void editAgent(ctx, person) }) : null,
        ),
        canEdit
          ? h(
              "div",
              { class: "row wrap" },
              button(person.enabled ? "Pause agent" : "Resume agent", { size: "sm", icon: person.enabled ? "pause" : "play", onClick: () => void control({ agent: person.id, action: person.enabled ? "pause" : "resume" }) }),
              button("Working notes", { size: "sm", icon: "memory", onClick: () => editNotes(ctx, person) }),
              button("Export", { size: "sm", icon: "download", title: `${person.name} as a file to take in on another node: its job and how it works, never its memory or a key`, onClick: () => exportAgent(person) }),
              button("Remove agent", { size: "sm", variant: "danger", icon: "trash", onClick: () => void removeAgent(ctx, person) }),
            )
          : null,
        known?.error ? callout("warn", known.error, { title: "Workspace status unavailable", actions: button("Check again", { size: "sm", icon: "refresh", onClick: () => void refreshWorkspace(person.id) }) }) : null,
        vm
          ? h(
              "div",
              { class: "card" },
              h(
                "div",
                { class: "card-body stack" },
                h("div", { class: "row wrap" }, icon("sandbox"), h("strong", {}, vm.name), badge(vm.status), badge(vm.isolation === "vm" ? "MicroVM" : "Container", vm.isolation === "vm" ? "ok" : "warn"), hasDesktop(vm) ? badge("Desktop", "neutral", "monitor") : badge("No desktop")),
                h("p", { class: "small muted" }, `On ${vm.node} · ${vm.cpus} CPUs · ${vm.memoryGb} GB memory · ${vm.disk ? `${vm.disk.limitGb} GB disk limit` : "Unlimited disk"} · ${vm.network}`),
                h(
                  "div",
                  { class: "row wrap" },
                  // A real terminal where the VM is on the node you are talking to (terminals aren't forwarded); else the console.
                  ctx.can("sandbox") ? (person.workspace?.node === ctx.whoami.node ? button("Open terminal", { size: "sm", icon: "terminal", onClick: () => void openTerminal(ctx, { id: vm.id, name: `${person.name}'s VM` }) }) : button("Open console", { size: "sm", icon: "terminal", onClick: () => openConsole(ctx, vm, person.workspace?.node ?? null) })) : null,
                  // Its files and what its latest task changed, read (views/workspace.ts).
                  ctx.can("sandbox") ? button("Files", { size: "sm", icon: "folder", onClick: () => openWorkspace(ctx, person, "files") }) : null,
                  ctx.can("sandbox") ? button("Changes", { size: "sm", icon: "code", onClick: () => openWorkspace(ctx, person, "changes") }) : null,
                  button("Check status", { size: "sm", icon: "refresh", onClick: () => void refreshWorkspace(person.id) }),
                  canEdit ? button("Give it more", { size: "sm", icon: "plus", onClick: () => growVm(ctx, person, vm, madeVm(person)) }) : null,
                  canEdit ? button("Make VM again", { size: "sm", icon: "retry", onClick: () => remakeVm(ctx, person, vm, madeVm(person)) }) : null,
                ),
              ),
            )
          : h(
              "div",
              { class: "team-workspace-empty" },
              icon("sandbox", { size: 30 }),
              h("h3", {}, person.workspace ? "Workspace registered" : "A place to work"),
              h("p", { class: "muted small" }, person.workspace ? `Workspace ${person.workspace.id} on ${person.workspace.node}.${!ctx.can("sandbox") ? " Its live state is shown to a device that may manage sandboxes." : known ? " Its live state couldn't be confirmed." : " Checking its live state…"}` : "Give this agent a persistent VM for code, files and tools. Its job and working notes stay with it."),
              canEdit && ctx.can("sandbox") ? button(person.workspace ? "Check / provision VM" : "Provision VM", { variant: "primary", icon: "plus", onClick: () => provisionVm(ctx, person, madeVm(person)) }) : h("p", { class: "small muted" }, "Provisioning needs fleet:admin and sandbox access on an owner device."),
            ),
      ),
    );
    keepPlace(bottom, () =>
      replace(
        bottom,
        known?.harnesses?.length
          ? section(
              "Harness readiness",
              {},
              h(
                "div",
                { class: "card" },
                h("div", { class: "rows" }, ...known.harnesses.map((harness) => h("div", { class: "item" }, icon(harness.ready ? "check-circle" : "alert", { size: 16 }), h("div", { class: "grow" }, h("strong", { class: "small" }, HARNESS[harness.id as TeamHarness] ?? harness.id), harnessNote(harness) ? h("p", { class: "meta" }, harnessNote(harness)) : null), badge(harness.ready ? "Ready" : "Unavailable", harness.ready ? "ok" : "warn")))),
              ),
            )
          : h("p", { class: "small subtle" }, "Harness readiness is checked on the workspace host; choosing one is not proof that it is installed or signed in."),
        notes
          ? section(
              "Notes store",
              {},
              h(
                "div",
                { class: "card" },
                h(
                  "div",
                  { class: "rows" },
                  h(
                    "div",
                    { class: "item" },
                    icon(notes.tone === "warn" ? "alert" : "memory", { size: 16 }),
                    h("div", { class: "grow" }, h("strong", { class: "small" }, "Engram, for every agent on this node"), h("p", { class: "meta" }, notes.text)),
                    badge(notes.badge, notes.tone),
                    canEdit ? button(notes.badge === "Off" ? "Turn on" : "Turn off", { size: "sm", onClick: () => void setEngram(ctx, notes.badge === "Off").then((changed) => changed && !scope.disposed && void refreshWorkspace(person.id)) }) : null,
                  ),
                ),
              ),
            )
          : null,
        person.repository && snapshot
          ? section(
              "Pull requests",
              {},
              h(
                "div",
                { class: "card" },
                h(
                  "div",
                  { class: "rows" },
                  h(
                    "div",
                    { class: "item" },
                    icon("repeat", { size: 16 }),
                    h(
                      "div",
                      { class: "grow" },
                      h("strong", { class: "small" }, "Failing checks and reviews back to the agent, for every agent on this node"),
                      h("p", { class: "meta" }, snapshot.ciBack ? "On: a fix goes back on the pull request's branch, and your agent approves its push itself, as it may in a repository you gave an agent." :"Off: they are yours, except in an outcome, which gives its own back."),
                    ),
                    badge(snapshot.ciBack ? "On" : "Off", snapshot.ciBack ? "ok" : "neutral"),
                    canEdit ? button(snapshot.ciBack ? "Turn off" : "Turn on", { size: "sm", onClick: () => void setCiBack(ctx, !snapshot?.ciBack) }) : null,
                  ),
                ),
              ),
            )
          : null,
      ),
    );
  }

  /** The agents' own page (no conversation open): its board, drawn by itself from then on (views/board.ts). */
  let home = false;
  function renderHome(): void {
    if (home) return;
    home = true;
    replace(head);
    composerWrap.hidden = true;
    agentsHome(ctx, content, scope);
  }

  function syncComposer(): void {
    const secret = findSecrets(input.value).length > 0;
    send.disabled = sending || (!input.value.trim() && !tray.carried().length) || tray.going() || secret || !room;
    give.hidden = !room;
    if (roomId) {
      if (secret) drafts.delete(roomId);
      else drafts.set(roomId, input.value);
    }
    replace(problem, secret ? callout("warn", "That looks like a secret. Remove it before sending; keys belong in the vault.") : null);
  }

  async function deliver(): Promise<void> {
    syncComposer();
    if (send.disabled || !room) return;
    const text = input.value.trim();
    const files = tray.carried();
    sending = true;
    syncComposer();
    try {
      await ctx.api.post("/api/team/messages", { room: room.id, text, ...(files.length ? { attachments: files } : {}) }, scope.signal);
      if (files.length) tray.sent();
      if (scope.disposed) return;
      if (input.value.trim() === text) {
        input.value = "";
        drafts.delete(room.id);
      }
      await load(true);
      content.scrollTop = content.scrollHeight;
    } catch (error) {
      if (!isAbort(error)) toast("Message wasn't sent", { tone: "error", description: errorMessage(error) });
    } finally {
      sending = false;
      if (!scope.disposed) syncComposer();
    }
  }

  /** Drawn from the team as the app has it and this conversation as last read; only when something changed. */
  function draw(force = false): void {
    snapshot = ctx.live.team.value;
    if (!snapshot) return;
    if (!roomId) return renderHome();
    if (!room) return;
    const next = snapshot;
    notice.hidden = true;
    // A face that was pleased for a moment changes back by itself, and "2 min ago" moves on: both are drawn again.
    const signature = JSON.stringify([next, room, workspace, next.agents.map((person) => avatarExpression(person, next, Date.now())), Math.floor(Date.now() / 60_000)]);
    if (signature === drawn && !force) return;
    drawn = signature;
    renderHead();
    renderSide();
    composerWrap.hidden = !canChat || panelOpen();
    if (panelOpen()) {
      renderPanel();
      if (!workspace) void refreshWorkspace(agent()!.id);
    } else renderTimeline();
    read();
  }

  /** What you asked to mark read last (with what the node said had been seen then), so it's asked once. */
  let reading = "";
  /** On screen, what ended here is read: this agent's page, or this room, is no longer new to you, on any device. */
  function read(): void {
    if (!snapshot || !room || document.hidden) return;
    const agentId = room.direct && room.members.length === 1 ? room.members[0]! : null;
    const row = rosterRows({ snapshot, now: Date.now() }).find((r) => (agentId ? r.kind === "agent" && r.id === agentId : r.kind === "room" && r.id === room!.id));
    if (!row?.unread) return;
    const body = agentId ? { agent: agentId } : { room: room.id };
    const asked = JSON.stringify([body, snapshot.seen]);
    if (asked === reading) return;
    reading = asked;
    void ctx.api.post("/api/team/seen", body).then(() => ctx.live.refreshTeam(), () => {});
  }

  function failed(error: unknown): void {
    if (scope.disposed || isAbort(error)) return;
    if (!snapshot || (roomId && !room)) replace(content, isUnavailable(error) ? empty({ icon: "agents", title: "The agents isn't available here", body: "This node doesn't seat agents yet.", actions: button("Try again", { onClick: () => void load(true) }) }) : errorState("Couldn't reach the agents", error, () => void load(true)));
    else {
      notice.hidden = false;
      replace(notice, h("div", { class: "banner-pill", "data-tone": "warn" }, icon("offline", { size: 16 }), h("span", { class: "banner-text" }, "Updates paused. What you see may be out of date."), button("Retry", { size: "sm", variant: "ghost", onClick: () => void load(true) })));
    }
  }

  /** This conversation, read again (and, when asked for at once, the team with it). */
  async function load(force = false): Promise<void> {
    if (force) void ctx.live.refreshTeam();
    if (!roomId || loading || scope.disposed || (!force && document.hidden)) return;
    loading = true;
    try {
      const detail = await ctx.api.post<TeamRoomView>("/api/team/room", { id: roomId }, scope.signal);
      if (scope.disposed) return;
      room = detail;
      void ownBar?.refresh();
      noteSaid(detail.id, detail.messages.at(-1));
      draw(force);
    } catch (error) {
      failed(error);
    } finally {
      loading = false;
    }
  }

  input.addEventListener("input", syncComposer);
  input.addEventListener("keydown", (event: KeyboardEvent) => {
    if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
      event.preventDefault();
      void deliver();
    }
  });
  scope.add(() => {
    if (roomId && !findSecrets(input.value).length) drafts.set(roomId, input.value);
  });
  scope.listen(document, "visibilitychange", () => {
    if (!document.hidden) void load(true);
  });
  // The room read again when the team changes (the node's live stream says so: at most every two seconds while it is
  // busy), and every two seconds while that stream is down.
  scope.add(ctx.live.follow(["team"], () => load(), 2000, 2000));
  scope.add(ctx.live.team.subscribe(() => draw()));
  // (Who leads, as you just chose it, before the node has said so.)
  scope.add(ctx.live.teamProblem.subscribe((error) => error && failed(error)));
  // The room as it was last read this session, at once (api.peek); the fresh one is drawn only if it differs.
  if (roomId) room = ctx.api.peek<TeamRoomView>("/api/team/room", { id: roomId }) ?? null;
  // The header's place, at once: until the team and the room are both known, draw() can't say whose it is.
  renderHead();
  void load();
  draw();
};
