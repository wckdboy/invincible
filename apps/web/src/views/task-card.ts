import type { TeamCheckpoint, TeamTask } from "@galahad/core/team";
import { taskRecordFacts } from "@galahad/core/team-record";
import type { Price } from "@galahad/core/spend";
import { type Api, isAbort } from "../api.ts";
import type { Ctx } from "../context.ts";
import { givenLine, keptChanges, proposedLine, sensitiveLine, shippedLine, steppedLine, type TaskAction, taskActions, taskBadge, taskEnd } from "../lib/task-card.ts";
import { hashOf } from "../lib/nav.ts";
import { relativeTime } from "../lib/time.ts";
import { emptyTrail, takeTrail, type Trail, trailNext, type TrailPage, trailTail } from "../lib/trail.ts";
import { badge, button, callout, dot } from "../ui/controls.ts";
import { h, replace } from "../ui/dom.ts";
import { icon } from "../ui/icons.ts";
import { renderMarkdown } from "../ui/markdown.ts";

/*
 * A task, as a card in a timeline: where it stands; while it runs, its latest lines as they happen;
 * once it has ended, whether it was verified, what its run came to, what it kept, and for work that
 * wasn't verified what the knight said and what can be done. What it says is lib/task-card.ts.
 */

/** As many of a running task's latest lines as its card shows. */
const TAIL = 6;
/** A running card asks for new lines this often while it is on screen. */
const EVERY_MS = 1500;

export interface LiveTrail {
  el: HTMLElement;
  dispose(): void;
}

/**
 * A running task's latest lines, asked of the node only for what is new (POST /api/team/trail { task, after }), every
 * second or two while the card is on screen and the app is in front; never once the task has ended. `ended`: the node
 * says it has (the team is then asked for again, and the card becomes an ended one).
 */
export function liveTrail(api: Api, task: string, viewport: Element | null, ended: () => void): LiveTrail {
  // (A log, but not read aloud as it grows: a list that refreshes by itself is never a live region.)
  const el = h("div", { class: "task-trail", role: "log", "aria-live": "off", "aria-label": "What it is doing" });
  const controller = new AbortController();
  let trail: Trail = emptyTrail();
  let shown = false;
  let over = false;
  let asking = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const draw = (): void =>
    replace(
      el,
      ...(trail.entries.length
        ? trailTail(trail, TAIL).map((line) => h("div", { class: "task-trail-line" }, h("span", { class: "ellipsis" }, line.text), line.more ? h("span", { class: "subtle", title: `${line.more} more line${line.more === 1 ? "" : "s"}` }, `+${line.more}`) : null))
        : [h("div", { class: "task-trail-line subtle" }, "Starting…")]),
    );
  const later = (ms: number): void => {
    clearTimeout(timer);
    if (!over && shown && !document.hidden) timer = setTimeout(() => void ask(), ms);
  };
  async function ask(): Promise<void> {
    if (asking || over || !shown || document.hidden) return;
    asking = true;
    try {
      const page = await api.post<TrailPage>("/api/team/trail", { task, after: trail.after }, controller.signal);
      const before = trail;
      trail = takeTrail(trail, page);
      if (trail !== before) draw();
      const next = trailNext(page, trail !== before);
      if (next === "done") {
        over = true;
        ended();
      } else later(next === "now" ? 0 : EVERY_MS);
    } catch (error) {
      // Out of reach just now: asked again a little later.
      if (!isAbort(error)) later(EVERY_MS * 3);
    } finally {
      asking = false;
    }
  }
  const observer = new IntersectionObserver(
    ([entry]) => {
      shown = Boolean(entry?.isIntersecting);
      if (shown) void ask();
      else clearTimeout(timer);
    },
    { root: viewport },
  );
  observer.observe(el);
  const inFront = (): void => void (document.hidden ? clearTimeout(timer) : ask());
  document.addEventListener("visibilitychange", inFront);
  draw();
  return {
    el,
    dispose() {
      over = true;
      clearTimeout(timer);
      controller.abort();
      observer.disconnect();
      document.removeEventListener("visibilitychange", inFront);
    },
  };
}

/** Everything the node kept of what an ended task did, read when it is opened. */
function wholeTrail(api: Api, task: string, signal: AbortSignal): HTMLElement {
  const body = h("div", {}, h("p", { class: "tiny subtle" }, "Reading…"));
  const details = h("details", { class: "team-task-details" }, h("summary", { "data-key": `trail:${task}` }, "What it did"), body);
  let read = false;
  details.addEventListener("toggle", async () => {
    if (!details.open || read) return;
    read = true;
    try {
      let trail = emptyTrail();
      for (;;) {
        const page = await api.post<TrailPage>("/api/team/trail", { task, after: trail.after }, signal);
        const next = takeTrail(trail, page);
        const done = next === trail || !page.more;
        trail = next;
        if (done) break;
      }
      replace(body, trail.entries.length ? h("pre", { class: "team-output" }, trail.entries.map((entry) => entry.text).join("\n")) : h("p", { class: "tiny subtle" }, "Nothing was kept of what it did."));
    } catch (error) {
      read = false;
      if (!isAbort(error)) replace(body, h("p", { class: "tiny subtle" }, `Couldn't read it just now: ${error instanceof Error ? error.message : String(error)}`));
    }
  });
  return details;
}

export interface CardOptions {
  /** The conversation the card is shown in: a task given in another says where. */
  room: string;
  roomName(id: string): string;
  /** Whose the task is, in a room (a knight's own timeline needn't say). */
  assignee: string | null;
  /** The name of the knight that proposed it, when one did. */
  proposer: string | null;
  dependencies: { id: string; title: string; satisfied: boolean }[];
  prices: Record<string, Price> | null;
  /** This device may stop, resume and give tasks. */
  canAct: boolean;
  /** The view's lifetime: what a card asks for is let go with it. */
  signal: AbortSignal;
  /** A running task's latest lines (views/team.ts keeps one per running task, across redraws). */
  trail: LiveTrail | null;
  act(action: TaskAction): void;
  /** Gives it again from one of its steps (PLAN #15): its workspace as it stood after that step. */
  againFrom?(step: number): void;
}

/**
 * The steps of a task another can be given from, asked of the node when you open them (POST /api/team/steps): each
 * command and when it ended, with Give again from here. Kept for a knight's task in a repository, on his own harness.
 */
function stepsOf(api: Api, task: TeamTask, again: (step: number) => void, signal: AbortSignal): HTMLElement {
  const list = h("div", { class: "stack" }, h("p", { class: "tiny subtle" }, "Reading its steps…"));
  let asked = false;
  const steps = h("details", { class: "team-task-details" }, h("summary", { "data-key": `task-steps:${task.id}` }, "Give again from a step"), list);
  steps.addEventListener("toggle", () => {
    if (!steps.open || asked) return;
    asked = true;
    api.post<{ steps: TeamCheckpoint[] }>("/api/team/steps", { task: task.id }, signal).then(
      ({ steps: kept }) => replace(list, kept.length
        ? kept.map((s) => h("div", { class: "row" }, h("span", { class: "tiny subtle tnum" }, `${s.step}.`), h("code", { class: "grow ellipsis" }, s.command), h("span", { class: "tiny subtle" }, relativeTime(s.at)), button("Give again from here", { size: "sm", variant: "ghost", icon: "retry", onClick: () => again(s.step) })))
        : [h("p", { class: "tiny subtle" }, "No steps were kept: they are kept for a knight's task in a repository, on Galahad's own harness.")]),
      (error) => { if (!isAbort(error)) replace(list, [h("p", { class: "tiny subtle" }, `Its steps couldn't be read: ${(error as Error).message}`)]); },
    );
  });
  return steps;
}

const ACTION = {
  approve: { label: "Approve", icon: "check" },
  decline: { label: "Decline", icon: "x" },
  stop: { label: "Stop", icon: "stop" },
  resume: { label: "Resume", icon: "play" },
  again: { label: "Give again…", icon: "retry" },
  ship: { label: "Ship it…", icon: "external" },
} as const;

export function taskCard(ctx: Ctx, task: TeamTask, o: CardOptions): HTMLElement {
  const state = taskBadge(task);
  const end = taskEnd(task);
  const kept = keptChanges(task);
  const shipped = shippedLine(task);
  const meta = [proposedLine(task, o.proposer), givenLine(task), sensitiveLine(task), task.room !== o.room ? `in ${o.roomName(task.room)}` : null, o.assignee].filter(Boolean).join(" · ");
  const stepped = steppedLine(task);
  const waiting = task.status === "queued" ? o.dependencies.filter((dependency) => !dependency.satisfied) : [];
  return h(
    "article",
    { class: "team-task", "data-key": `task:${task.id}`, "data-status": task.status, "aria-label": `Task: ${task.title} · ${state.text}` },
    // Its title opens it as a thread of its own (#/task/<id>): its work folded, what proves it, its details.
    h("div", { class: "task-head" }, dot(state.tone, { live: task.status === "running" }), h("a", { class: "grow task-card-title", href: hashOf("task", { task: task.id }), title: "Open it as a thread of its own" }, h("strong", {}, task.title)), badge(state.text, state.tone)),
    meta ? h("p", { class: "task-meta" }, meta) : null,
    stepped ? h("p", { class: "task-meta" }, stepped) : null,
    waiting.length ? h("p", { class: "task-meta" }, icon("clock", { size: 12 }), ` Waiting for ${waiting.map((dependency) => `“${dependency.title}”`).join(", ")} to be done and verified`) : null,
    o.trail?.el ?? null,
    // Why it wasn't verified, as the node said it; a stop of your own is said quietly.
    end?.why ? callout(task.status === "failed" ? "danger" : task.status === "stopped" ? "quiet" : "warn", end.why) : null,
    end?.said ? h("p", { class: "task-said" }, end.said) : null,
    // What its run came to, as the runner counted it: its time, commands, tokens, and money at your prices.
    task.record ? h("p", { class: "tiny subtle tnum", title: "Counted by the runner as the task ran" }, taskRecordFacts(task.record, o.prices ?? {}).join(" · ")) : null,
    // What it changed in its repository, kept to read and to ship (a pull request from Artifacts, on your word).
    kept
      ? h(
          "p",
          { class: "task-kept" },
          icon("archive", { size: 14 }),
          `${kept.text} · kept as `,
          h("a", { href: "#/artifacts", class: "mono", onclick: (event: Event) => (event.preventDefault(), ctx.navigate("artifacts", { intent: kept.artifact })) }, kept.artifact),
          shipped ? [" · ", h("a", { href: shipped.url, target: "_blank", rel: "noopener noreferrer" }, shipped.text)] : null,
        )
      : null,
    end ? wholeTrail(ctx.api, task.id, o.signal) : null,
    o.canAct && o.againFrom && task.status !== "queued" && task.status !== "proposed" ? stepsOf(ctx.api, task, o.againFrom, o.signal) : null,
    h(
      "details",
      { class: "team-task-details" },
      h("summary", { "data-key": `task-details:${task.id}` }, "The task"),
      h(
        "div",
        { class: "stack" },
        h("p", { class: "pre-wrap small" }, task.goal),
        task.gates.length ? h("div", {}, h("strong", { class: "small" }, "Done when these pass"), h("pre", { class: "team-output" }, task.gates.join("\n"))) : h("p", { class: "tiny subtle" }, "No commands were given to prove it."),
        task.output ? h("div", {}, h("strong", { class: "small" }, "Result"), h("div", { class: "md" }, renderMarkdown(task.output))) : null,
      ),
    ),
    h(
      "div",
      { class: "task-foot" },
      h("span", { class: "tiny subtle grow" }, `${task.status === "queued" || task.status === "running" ? "Given" : "Ended"} ${relativeTime(task.status === "queued" || task.status === "running" ? task.createdAt : task.updatedAt)}`),
      ...(o.canAct ? taskActions(task).map((action) => button(ACTION[action].label, { variant: action === "approve" || action === "ship" ? "primary" : "ghost", size: "sm", icon: ACTION[action].icon, onClick: () => o.act(action) })) : []),
    ),
  );
}
