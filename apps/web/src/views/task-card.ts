import type { TeamCheckpoint, TeamTask } from "@invincible/core/team";
import { type Api, isAbort } from "../api.ts";
import type { Ctx } from "../context.ts";
import { hashOf } from "../lib/nav.ts";
import { STEER_WORDS } from "../lib/steer.ts";
import { because, saidBesideProof } from "../lib/steps.ts";
import { gatesLine, givenLine, keptChanges, latestLine, proposedLine, sensitiveLine, shippedLine, steppedLine, type TaskAction, taskAnswers, taskEnd, taskStanding } from "../lib/task-card.ts";
import { relativeTime } from "../lib/time.ts";
import { button } from "../ui/controls.ts";
import { openSheet } from "../ui/dialog.ts";
import { h, replace } from "../ui/dom.ts";
import { icon, type IconName } from "../ui/icons.ts";
import { selector, type SelectorOption } from "../ui/selector.ts";

/*
 * A task where it was given, between hairlines (the iPhone's TaskCardView, I10: no cards): what it is and how it stands
 * (its word while it is in hand, its verdict as its proof allows once it ended, never "Verified"), who proposed or gave
 * it, a proposal's goal and what proves it, a running task's latest line, why it ended as it did and what the agent said,
 * what it kept; then its one answer in full, unfilled, the rest under its ⋯: a list of ten queued tasks isn't ten Stops.
 * Its title opens its thread (views/task.ts), where its work, its proof and its cost are in full. What it says is
 * lib/task-card.ts.
 */

export interface CardOptions {
  /** The conversation the card is shown in: a task given in another says where. */
  room: string;
  roomName(id: string): string;
  /** Whose the task is, in a room (an agent's own timeline needn't say). */
  assignee: string | null;
  /** The name of the agent that proposed it, when one did. */
  proposer: string | null;
  dependencies: { id: string; title: string; satisfied: boolean }[];
  /** This device may stop, resume and give tasks. */
  canAct: boolean;
  act(action: TaskAction): void;
  /** Gives it again from one of its steps (PLAN #15): its workspace as it stood after that step. */
  againFrom?(step: number): void;
  /** Words for it as it runs (a steer: views/team-forms.ts steerTask). */
  steer?(): void;
}

/** Each answer in its words ("…": more is asked before it happens), and its mark in the menu. */
const ANSWER: Record<TaskAction, { label: string; icon: IconName }> = {
  approve: { label: "Approve", icon: "check" },
  decline: { label: "Decline", icon: "x" },
  stop: { label: "Stop", icon: "stop" },
  resume: { label: "Resume", icon: "play" },
  again: { label: "Give again…", icon: "retry" },
  ship: { label: "Ship it…", icon: "external" },
};

/**
 * Its steps, to give it again from one (PLAN #15), asked of the node as the sheet opens (POST /api/team/steps): each
 * command and when it ended, with Give again from here (the iPhone's StepsPicker). Kept for an agent's task in a
 * repository, on your agent's own harness.
 */
function openSteps(api: Api, task: TeamTask, again: (step: number) => void): void {
  const list = h("div", { class: "stack" }, h("p", { class: "tiny subtle" }, "Reading its steps…"));
  const sheet = openSheet({ title: "Give it again from a step", description: "Its workspace as it stood after that step. What came after is set aside, and stays this task's.", body: list });
  api.post<{ steps: TeamCheckpoint[] }>("/api/team/steps", { task: task.id }, sheet.scope.signal).then(
    ({ steps }) =>
      replace(
        list,
        ...(steps.length
          ? steps.map((s) => h("div", { class: "row" }, h("span", { class: "tiny subtle tnum" }, `${s.step}.`), h("code", { class: "grow ellipsis" }, s.command), h("span", { class: "tiny subtle" }, relativeTime(s.at)), button("Give again from here", { size: "sm", variant: "ghost", icon: "retry", onClick: () => (sheet.close(), again(s.step)) })))
          : [h("p", { class: "tiny subtle" }, "No steps were kept: they are kept for an agent's task in a repository, on your agent's own harness.")]),
      ),
    (error) => {
      if (!isAbort(error)) replace(list, h("p", { class: "tiny subtle" }, `Its steps couldn't be read: ${(error as Error).message}`));
    },
  );
}

/** Its other answers under ⋯ (a popover, a sheet on a phone): the rest of taskAnswers, a steer while it runs, and giving
 * it again from one of its steps where it can be given again. Null when there is nothing more. (No scope: a card drawn
 * again would leave each menu it had in the view's.) */
function moreOf(ctx: Ctx, task: TeamTask, rest: TaskAction[], again: boolean, o: CardOptions): HTMLElement | null {
  const options: SelectorOption[] = [
    ...rest.map((action) => ({ value: action, label: ANSWER[action].label, icon: ANSWER[action].icon })),
    ...(o.steer && task.status === "running" ? [{ value: "steer", label: "Steer…", icon: "arrow-up" as const, meta: STEER_WORDS.steerTitle }] : []),
    ...(o.againFrom && again ? [{ value: "from-step", label: "From a step…", icon: "layers" as const }] : []),
  ];
  if (!options.length) return null;
  const menu = selector({
    label: `More for “${task.title}”`,
    search: false,
    variant: "ghost",
    className: "icon-only task-more",
    current: () => ({ text: "", icon: "more" }),
    groups: () => [{ id: "rest", mode: "action", options }],
    onSelect: (_group, option) => {
      if (option.value === "steer") o.steer?.();
      else if (option.value === "from-step") openSteps(ctx.api, task, (step) => o.againFrom?.(step));
      else o.act(option.value as TaskAction);
    },
  });
  return menu.el;
}

export function taskCard(ctx: Ctx, task: TeamTask, o: CardOptions): HTMLElement {
  const standing = taskStanding(task);
  const end = taskEnd(task);
  // Why it ended as it did, beside its verdict and never that word again; what the agent said, unless only a verdict.
  const why = end && task.status !== "interrupted" ? because(end.why, standing.word) : null;
  const said = saidBesideProof(end?.said);
  const kept = keptChanges(task);
  const shipped = shippedLine(task);
  const meta = [proposedLine(task, o.proposer), givenLine(task), sensitiveLine(task), task.room !== o.room ? `in ${o.roomName(task.room)}` : null, o.assignee].filter(Boolean).join(" · ");
  const stepped = steppedLine(task);
  const waiting = task.status === "queued" ? o.dependencies.filter((dependency) => !dependency.satisfied) : [];
  const gates = task.status === "proposed" ? gatesLine(task.gates) : null;
  const answers = o.canAct ? taskAnswers(task) : { prominent: null, rest: [] };
  const prominent = answers.prominent;
  const answer = prominent ? button(ANSWER[prominent].label, { size: "sm", onClick: () => o.act(prominent) }) : null;
  answer?.classList.add("answer");
  const again = prominent === "again" || answers.rest.includes("again");
  return h(
    "article",
    { class: "team-task", "data-key": `task:${task.id}`, "data-status": task.status, "aria-label": `Task: ${task.title} · ${standing.word}` },
    h(
      "div",
      { class: "task-head" },
      // Its title opens it as a thread of its own (#/task/<id>): its work folded, what proves it, its details.
      h(
        "a",
        { class: "task-open", href: hashOf("task", { task: task.id }), title: "Open it as a thread of its own" },
        h("strong", { class: "task-title" }, task.title),
        h("span", { class: "task-standing", "data-tone": standing.tone, "data-strong": String(standing.strong) }, standing.tone === "proven" ? icon("check", { size: 12 }) : null, standing.word),
        icon("chevron-right", { size: 14, class: "task-chev" }),
      ),
      o.canAct ? moreOf(ctx, task, answers.rest, again, o) : null,
    ),
    meta ? h("p", { class: "task-meta" }, meta) : null,
    stepped ? h("p", { class: "task-meta" }, stepped) : null,
    waiting.length ? h("p", { class: "task-meta" }, icon("clock", { size: 12 }), ` Waiting for ${waiting.map((dependency) => `“${dependency.title}”`).join(", ")} to be done and verified`) : null,
    task.status === "proposed" ? h("p", { class: "task-goal" }, task.goal) : null,
    gates ? h("p", { class: "task-gates" }, icon("shield-check", { size: 13 }), h("span", {}, gates)) : null,
    // Two lines kept from the start, so the card doesn't grow as its latest line comes and lengthens (showLatest).
    task.status === "running" ? h("p", { class: "task-latest" }, latestLine(task)) : null,
    why ? h("p", { class: "task-why" }, why) : null,
    said ? h("p", { class: "task-said" }, said) : null,
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
    answer ? h("div", { class: "task-answers" }, answer) : null,
  );
}

/** A running card's latest line, set where it is as the task's progress moves on: the card isn't drawn again for it (an
 * open menu of its stays open). */
export function showLatest(card: HTMLElement, task: TeamTask): void {
  const line = card.querySelector<HTMLElement>(".task-latest");
  const text = latestLine(task);
  if (line && line.textContent !== text) line.textContent = text;
}
