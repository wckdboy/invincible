import type { ActionView, MemoryView, NoticeView } from "@invincible/core";
import { isNotifyActionId } from "@invincible/core/notify-payload";
import { type Ctx, errorMessage, type View } from "../context.ts";
import { isWaiting } from "../live.ts";
import { askPlain } from "../lib/asks.ts";
import { hashOf } from "../lib/nav.ts";
import { noticeFrom } from "../lib/notices.ts";
import { agentOfCaller } from "../lib/roster.ts";
import { relativeTime } from "../lib/time.ts";
import type { Attended, WorkRow } from "../lib/work.ts";
import type { ActionClass } from "../types.ts";
import { busy, button, callout, card, disclosure, empty, note, pageBody, pageHead, rows, skeletonRows } from "../ui/controls.ts";
import { openSheet } from "../ui/dialog.ts";
import { cx, h, keepPlace, replace, Scope, type Child } from "../ui/dom.ts";
import { icon, type IconName } from "../ui/icons.ts";
import { agentFace } from "../ui/orb.ts";
import { selector } from "../ui/selector.ts";
import { toast } from "../ui/toast.ts";
import { dropFact, factRow, keepFact, openAboutYou } from "./about-you.ts";
import { CLASS_INFO } from "./activity.ts";
import { connectorRequestCard } from "./connectors.ts";
import { openInvite, pairingCard } from "./fleet.ts";
import { actionCard, answerAction, approveAction, decidedRow, loopDraftCard, questionCard, screenSessionCard } from "./inbox.ts";
import { findingRow } from "./loops.ts";
import { reachNote } from "./notifications.ts";
import { controlTeam } from "./team-forms.ts";
import { secretRequestCard } from "./vault.ts";
import { rowsVersion, workNow, workSources } from "./work-rows.ts";

/*
 * What needs you (the iPhone's Needs you, I10), built one way for Home (three at most) and for its own page (every one):
 * each decision a row with its one answer in place, the rest under its ⋯, and all of it a tap away (its task, or its card
 * in a sheet: comparing a device's code, typing a key, a service's question with fields, an approval's arguments and
 * your own words in it). Counted as every place counts it (needsCount). Then, on its page only, what was noticed for
 * you: news, counted nowhere, each yours to dismiss or keep. Nothing here happens without your say.
 */

/** A row of Needs you (the iPhone's Decision): who asks or what it is about, what, its one answer, the rest, all of it. */
interface Need {
  key: string;
  kind: string;
  lead: Child;
  who: string;
  what: Child;
  /** Its one answer, in place: its words, and what it does (`trigger`: its button, held while the node is told; `problem`:
   * where what went wrong is said, under the row). */
  answer: { label: string; run(trigger: HTMLButtonElement, problem: (shown: HTMLElement) => void): void } | null;
  /** The rest, under its ⋯ (`trigger`: the ⋯, held while the node is told). Never a yes: letting anything in or out
   * stays its answer, or its card's. */
  rest: { label: string; icon: IconName; run(trigger: HTMLButtonElement, problem: (shown: HTMLElement) => void): void }[];
  /** All of it: its task's address, or its card in a sheet. */
  open: string | (() => void);
}

const leadIcon = (name: IconName): HTMLElement => h("span", { class: "decision-icon", "aria-hidden": "true" }, icon(name, { size: 15 }));
const face = (row: Pick<WorkRow, "agent">): HTMLElement => agentFace({ id: row.agent.id, profile: row.agent.avatar, size: 28 });
/** Opens one of the Inbox's own cards in a sheet, to read it whole and answer there. */
const inSheet = (title: string, body: () => HTMLElement) => () => void openSheet({ title, body: body() });

/** A row: its face or mark and its words (a tap opens all of it), its answer, its ⋯; what went wrong, under it. (Its ⋯ is
 * given no scope: a row drawn again would leave each menu it had in the view's.) */
function decisionEl(need: Need): HTMLElement {
  const outcome = h("div", { class: "need-outcome" });
  const problem = (shown: HTMLElement): void => void replace(outcome, shown);
  const words = [need.lead, h("span", { class: "decision-words" }, h("span", { class: "decision-who" }, need.who), h("span", { class: "decision-what" }, need.what))];
  const opener = typeof need.open === "string" ? h("a", { class: "decision-open", href: need.open }, ...words) : h("button", { class: "decision-open", type: "button", onclick: need.open }, ...words);
  const answer = need.answer ? button(need.answer.label, { size: "sm" }) : null;
  if (answer) {
    answer.classList.add("answer");
    answer.addEventListener("click", () => need.answer!.run(answer, problem));
  }
  const more = need.rest.length
    ? selector({
        label: `More: ${need.who}`,
        search: false,
        variant: "ghost",
        className: "icon-only decision-more",
        current: () => ({ text: "", icon: "more" }),
        groups: () => [{ id: "rest", mode: "action", options: need.rest.map((one, i) => ({ value: String(i), label: one.label, icon: one.icon })) }],
        onSelect: (_group, option) => need.rest[Number(option.value)]?.run(more!.el, problem),
      })
    : null;
  return h("article", { class: "decision", "data-kind": need.kind, "data-key": need.key }, h("div", { class: "decision-row" }, opener, answer, more?.el ?? h("span", { class: "decision-more-space", "aria-hidden": "true" })), outcome);
}

/** An approval in a row: who asks (an agent under its task's name) and what, Allow once (confirmed, as the card's), and
 * under its ⋯ Deny and the whole card (its arguments, a standing order, your own words in it). A delete is approved only
 * in its whole card, by typing what it deletes. */
function approvalNeed(ctx: Ctx, action: ActionView, row: WorkRow | null): Need {
  const info = CLASS_INFO[action.class as ActionClass];
  const destructive = action.class === "delete";
  const admin = ctx.can("fleet:admin");
  const whole = inSheet(`${info?.label ?? "An action"}: ${action.target}`, () => actionCard(ctx, action));
  return {
    key: `action:${action.id}`,
    kind: "action",
    lead: row ? face(row) : leadIcon(info?.icon ?? "shield"),
    who: row ? `${row.agent.name} · ${row.title}` : `${askerName(ctx, action.by)} asks`,
    // (In plain words, "Post to Forge: “…”" (lib/asks.ts askPlain); the call itself, its class, connector, tool and target,
    // is in its whole card, a tap away.)
    what: askPlain(action),
    answer: admin ? { label: destructive ? "Review…" : "Allow once", run: (trigger, problem) => (destructive ? whole() : void approveAction(ctx, action, trigger, problem)) } : null,
    rest: admin
      ? [
          { label: "Deny", icon: "x", run: (trigger, problem) => void answerAction(ctx, action, false, trigger, problem) },
          { label: "The whole of it…", icon: "more", run: whole },
        ]
      : [],
    open: whole,
  };
}

/** Who filed an action, as a person says it: an agent by its name, a loop of yours, or the primary itself. */
function askerName(ctx: Ctx, by: string): string {
  const agent = agentOfCaller(by);
  if (agent) return ctx.live.team.value?.agents.find((person) => person.id === agent)?.name ?? agent;
  if (by.startsWith("loop:")) return `The loop ${by.slice(5)}`;
  return "Your agent";
}

/** A task only you can move on: its proposal (Approve; Decline under its ⋯), its work cut short (Resume), an agent you
 * paused that it waits behind (Resume it). A tap opens its thread. */
function taskNeed(ctx: Ctx, row: WorkRow): Need {
  const canAct = ctx.can("fleet:admin") && ctx.can("chat");
  const control = (change: Parameters<typeof controlTeam>[1]) => (trigger: HTMLButtonElement) => {
    trigger.disabled = true;
    void controlTeam(ctx, change).finally(() => (trigger.disabled = false));
  };
  const base = { key: `task:${row.id}`, lead: face(row), what: row.title, open: hashOf("task", { task: row.id }) };
  if (row.word === "Approve?") return { ...base, kind: "proposal", who: `${row.agent.name} proposes`, answer: canAct ? { label: "Approve", run: control({ task: row.id, action: "approve" }) } : null, rest: canAct ? [{ label: "Decline", icon: "x", run: control({ task: row.id, action: "stop" }) }] : [] };
  if (row.word === "Interrupted") return { ...base, kind: "interrupted", who: `${row.agent.name} · interrupted`, answer: canAct ? { label: "Resume", run: control({ task: row.id, action: "resume" }) } : null, rest: [] };
  if (row.word === "Agent paused") return { ...base, kind: "paused", who: `${row.agent.name} is paused`, answer: canAct ? { label: "Resume", run: control({ agent: row.agent.id, action: "resume" }) } : null, rest: [] };
  return { ...base, kind: "task", who: row.agent.name, answer: null, rest: [] };
}

/** One that opens its card in a sheet, its answer the same sheet: what takes more than a tap. */
function sheetNeed(key: string, kind: string, lead: Child, who: string, what: Child, label: string | null, title: string, body: () => HTMLElement): Need {
  const whole = inSheet(title, body);
  return { key, kind, lead, who, what, answer: label ? { label, run: whole } : null, rest: [], open: whole };
}

/**
 * Every decision that waits, as needsCount counts them: each approval once (an agent's under its task's name), each task
 * only you can move on, devices asking to join, keys it asked for, a service's question while it can be answered, its
 * use of a Mac, a loop it drafted, a connector asked for.
 */
function decisions(ctx: Ctx, work: Attended): Need[] {
  const now = Date.now();
  const l = ctx.live;
  const waiting = l.actions.value.filter((action) => isWaiting(action, now));
  const out: Need[] = [];
  const shown = new Set<string>();
  for (const row of work.needs) {
    if (row.word === "Allow?") {
      for (const action of waiting.filter((one) => agentOfCaller(one.by) === row.agent.id)) {
        shown.add(action.id);
        out.push(approvalNeed(ctx, action, row));
      }
    } else out.push(taskNeed(ctx, row));
  }
  for (const action of waiting.filter((one) => !shown.has(one.id))) out.push(approvalNeed(ctx, action, null));
  const admin = ctx.can("fleet:admin");
  for (const p of l.pairings.value) out.push(sheetNeed(`pairing:${p.device}`, "pairing", leadIcon(p.kind === "node" ? "server" : "phone"), p.kind === "node" ? "A machine asks to join" : "A device asks to join", p.name, admin ? "Compare…" : null, `${p.name} asks to join`, () => pairingCard(ctx, p)));
  for (const r of l.secretRequests.value) out.push(sheetNeed(`key:${r.name}`, "key", leadIcon("key"), "Your agent asks for a key", [h("span", { class: "mono" }, r.name), ` · ${r.purpose}`], ctx.can("vault:write") ? "Add…" : null, `A key for ${r.name}`, () => secretRequestCard(ctx, r)));
  for (const q of l.questions.value.filter((one) => one.expires > now)) out.push(sheetNeed(`question:${q.id}`, "question", leadIcon("plug"), `${q.label} asks`, q.message, "Answer…", `${q.label} asks`, () => questionCard(ctx, q)));
  for (const s of l.screenSessions.value.filter((one) => one.state === "waiting" || one.state === "allowed")) {
    const using = s.state === "allowed";
    out.push(sheetNeed(`screen:${s.id}`, "screen", leadIcon("monitor"), using ? `Your agent is using ${s.nodeName}` : `Your agent asks to use ${s.nodeName}`, s.why, using ? "See it…" : "Answer…", s.nodeName, () => screenSessionCard(ctx, s)));
  }
  for (const d of l.loopDrafts.value) out.push(sheetNeed(`draft:${d.id}`, "draft", leadIcon("repeat"), "Your agent drafted a loop", d.label ?? d.name, "Review…", `A loop: ${d.label ?? d.name}`, () => loopDraftCard(ctx, d)));
  for (const c of l.connectorRequests.value) out.push(sheetNeed(`connector:${c.id}`, "connector", leadIcon("plug"), `${c.by} asks for a connector`, c.label ?? c.connector, "Review…", `A connector: ${c.label ?? c.connector}`, () => connectorRequestCard(ctx, c)));
  return out;
}

/** A notice as the Inbox shows it whole: what it is, from where and when (a rule of yours leads with a bell). */
const noticeRow = (ctx: Ctx, n: NoticeView): HTMLElement =>
  findingRow(ctx, n.severity === "info" && n.source.startsWith("rule:") ? { ...n, icon: "bell" } : n, [h("span", {}, noticeFrom(n.source)), h("span", { title: new Date(n.at).toLocaleString() }, relativeTime(n.at))]);

/** Dismissing a notice: yours alone (fleet:admin, which agents never hold). It stays quiet until it changes. */
const dismissNotice = (ctx: Ctx, n: NoticeView, trigger: HTMLButtonElement): Promise<void> =>
  busy(trigger, async () => {
    try {
      await ctx.api.post("/api/notices/dismiss", { key: n.key });
      toast("Dismissed", { description: "It stays quiet until it changes." });
      await ctx.live.refreshNotices();
    } catch (error) {
      toast("Couldn't dismiss it", { tone: "error", description: errorMessage(error) });
    }
  });

/** What it noticed for you (your rules, the heartbeat) and facts it noticed about you: news, counted nowhere, each yours
 * to dismiss or keep. */
function news(ctx: Ctx): Need[] {
  const admin = ctx.can("fleet:admin");
  const canKeep = ctx.can("mind:write");
  const notices = ctx.live.notices.value.filter((n) => !n.dismissed).map((n): Need => ({
    key: `notice:${n.key}`,
    kind: "notice",
    lead: leadIcon(n.severity === "info" ? "bell" : "alert"),
    who: noticeFrom(n.source),
    what: n.title,
    answer: null,
    rest: admin ? [{ label: "Dismiss", icon: "x", run: (trigger) => void dismissNotice(ctx, n, trigger) }] : [],
    open: inSheet(n.title, () => card({ flush: true }, rows(noticeRow(ctx, n)))),
  }));
  const facts = ctx.live.aboutYou.value.map((m: MemoryView): Need => ({
    key: `fact:${m.id}`,
    kind: "fact",
    lead: leadIcon("user"),
    who: "Your agent noticed about you",
    what: m.text.split("\n")[0] ?? "",
    answer: canKeep ? { label: "Keep", run: (trigger) => void keepFact(ctx, m, trigger) } : null,
    rest: canKeep
      ? [
          { label: "Drop", icon: "trash", run: (trigger) => void dropFact(ctx, m, true, trigger) },
          { label: "In my words…", icon: "edit", run: () => openAboutYou(ctx, m) },
        ]
      : [],
    open: inSheet("A fact about you", () => h("div", { class: "card rows" }, factRow(ctx, m, true))),
  }));
  return [...notices, ...facts];
}

/** Home's rows of what needs you: every decision, each with its answer in place (Home shows three, the rest a tap away). */
export const needsItems = (ctx: Ctx, work: Attended): HTMLElement[] => decisions(ctx, work).map(decisionEl);

/** What the rows are drawn from, to compare before drawing them again: each waiting thing by its id and state. */
export function needsVersion(ctx: Ctx): string {
  const l = ctx.live;
  return JSON.stringify([
    l.actions.value.map((a) => [a.id, a.state]),
    l.pairings.value.map((p) => p.device),
    l.secretRequests.value.map((r) => r.name),
    l.questions.value.map((q) => q.id),
    l.screenSessions.value.map((x) => [x.id, x.state]),
    l.notices.value.map((n) => [n.key, n.dismissed]),
    l.loopDrafts.value.map((d) => d.id),
    l.connectorRequests.value.map((c) => c.id),
    l.aboutYou.value.map((m) => m.id),
  ]);
}

/**
 * How many decisions wait, worked out without drawing them, as every place counts them (the iPhone's needsCount): every
 * waiting approval once (under its task's row or alone), each other task row that needs you, and each other thing that
 * waits for your answer. News (a notice, a fact it noticed about you) is counted nowhere.
 */
export function needsCount(ctx: Ctx, work: Attended): number {
  const now = Date.now();
  const l = ctx.live;
  return (
    l.actions.value.filter((action) => isWaiting(action, now)).length +
    work.needs.filter((row) => row.word !== "Allow?").length +
    l.pairings.value.length +
    l.secretRequests.value.length +
    l.questions.value.filter((q) => q.expires > now).length +
    l.screenSessions.value.filter((x) => x.state === "waiting" || x.state === "allowed").length +
    l.loopDrafts.value.length +
    l.connectorRequests.value.length
  );
}

/** An approval, compact, in the thread of the task whose agent asks: who asks and what, its target in mono, then Allow
 * once (confirmed, as the card's), Deny, and the whole card (its arguments, a standing order, your own words in it). */
export function askItem(ctx: Ctx, action: ActionView, row: WorkRow | null): HTMLElement {
  const info = CLASS_INFO[action.class as ActionClass];
  const destructive = action.class === "delete";
  const outward = action.class === "outward";
  const asker = row ? `${row.agent.name} · ${row.title}` : `${askerName(ctx, action.by)} asks`;
  const admin = ctx.can("fleet:admin");
  const allow = button(destructive ? "Allow delete…" : "Allow once", { variant: "primary", size: "sm" });
  const deny = button("Deny", { size: "sm" });
  const more = button("More", { variant: "ghost", size: "sm", iconOnly: true, icon: "more", label: "Everything about it, a standing order, or your own words in it", onClick: inSheet(`${info?.label ?? "An action"}: ${action.target}`, () => actionCard(ctx, action)) });
  const outcome = h("div", { class: "need-outcome" });
  const lead = row ? agentFace({ id: row.agent.id, profile: row.agent.avatar, size: 20 }) : h("span", { class: "need-icon", "aria-hidden": "true" }, icon("mark", { size: 14 }));
  const shown = h(
    "article",
    { class: "need", "data-kind": "action" },
    h("div", { class: "need-who" }, lead, h("span", { class: "ellipsis" }, asker)),
    h("div", { class: "need-what" }, h("span", {}, `${info?.label ?? action.class} · `), h("span", { class: "mono wrap-anywhere" }, `${action.connector}.${action.tool}`), " ", h("span", { class: "mono wrap-anywhere need-target" }, action.target)),
    h("p", { class: cx("need-note", (destructive || outward) && "is-warn") }, destructive ? "It can't be brought back once deleted." : outward ? "Others can see it once it's sent." : "", h("span", { class: "tnum expires", "data-expires": String(action.expires) }, ` Expires ${relativeTime(action.expires)}; no answer means no.`)),
    h("div", { class: "need-acts" }, ...(admin ? [allow, deny, more] : [more])),
    outcome,
  );
  const problem = (callout: HTMLElement) => replace(outcome, callout);
  allow.addEventListener("click", () => void approveAction(ctx, action, allow, problem));
  deny.addEventListener("click", () => void answerAction(ctx, action, false, deny, problem));
  // (Allow similar…, and your own words in it, are in the whole card, under More, as the Inbox's.)
  return shown;
}

/**
 * Needs you, its own page (#/inbox; the iPhone's Needs you, I10): every decision as a row with its one answer in place,
 * the rest under its ⋯, all of it a tap (its task, or its card in a sheet), counted as Home counts them; then what was
 * noticed for you, news counted nowhere; then, folded, what was decided lately. An approval named in the address
 * (#/inbox?a=…, a notification's or a link's) opens its card once the page has it; one no longer waiting says so.
 */
/**
 * Every ask at once, in a sheet over your agent's chat on a phone (••• › Waiting on you, or a link to them: there is no
 * Needs you screen on a phone, the lead's defaults of 28 November 2026): Needs you's own list, its approval's card at
 * once where one is named.
 */
export function openWaiting(ctx: Ctx, approval?: string): void {
  const scope = new Scope();
  const body = h("div", { class: "waiting" });
  openSheet({ title: "Waiting on you", body, onClose: () => scope.dispose() });
  needsView(body, ctx, { scope, opts: { intent: "sheet", ...(approval ? { approval } : {}) } });
}

export const needsView: View = (root, ctx, { scope, opts }) => {
  // (In a sheet, Waiting on you: its title is the sheet's, and what it lists says no count.)
  const inSheet = opts.intent === "sheet";
  const picked = opts.approval && isNotifyActionId(opts.approval) ? opts.approval : null;
  let opened = false;
  const pickedNote = h("div");
  const lists = h("div", { class: "stack loose" }, card({ flush: true }, skeletonRows(3, { avatar: true })));
  const historyRows = rows();
  const historySummary = h("span", { class: "small strong" });
  // Kept across drawings, so it stays open while the outbox changes.
  const history = disclosure(historySummary, { flush: true, hidden: true }, historyRows);
  const admin = ctx.can("fleet:admin");
  // First, while it matters: that it can't reach this device when the primary is closed, and the one thing to do.
  const reach = reachNote(ctx, scope);
  let shown = "";

  const part = (title: string, count: number | null, items: Need[], foot: string): HTMLElement =>
    h(
      "section",
      { class: "decisions", "aria-label": title },
      inSheet && count !== null ? null : h("h2", { class: "decisions-head" }, h("span", {}, title), count !== null ? h("span", { class: "tnum" }, String(count)) : null),
      h("div", { class: "decisions-list" }, ...items.map(decisionEl)),
      note(foot),
    );

  function draw(): void {
    const loaded = ctx.live.inboxLoaded.value;
    const work = workNow(ctx);
    const version = JSON.stringify([loaded, needsVersion(ctx), work ? rowsVersion(work.needs) : null, admin]);
    if (version !== shown) {
      shown = version;
      const asks = work ? decisions(ctx, work) : [];
      const told = news(ctx);
      // Until the first answer, a placeholder: "nothing needs you" would be a guess, and pushed away a moment later.
      replace(
        lists,
        ...(!loaded
          ? [card({ flush: true }, skeletonRows(3, { avatar: true }))]
          : !asks.length && !told.length
            ? [
                card(
                  { flush: true },
                  empty({
                    icon: "check-circle",
                    title: "Nothing needs you",
                    body: "Approvals, keys your agent asks for, devices asking to join, its asks to use a Mac, and what it noticed for you wait here, each with its answer in place.",
                    actions: admin ? button("Pair a device", { icon: "plus", onClick: () => openInvite(ctx, "client") }) : null,
                  }),
                ),
              ]
            : [
                asks.length ? part("Decisions", asks.length, asks, "Nothing leaves until you approve it. Unanswered, it's a no.") : null,
                told.length ? part("Noticed", null, told, "What your rules and the heartbeat told you, and what your agent noticed about you. News: counted nowhere, and one you dismiss stays quiet until it changes.") : null,
              ]),
      );
    }
    const waiting = ctx.live.actions.value.filter((action) => isWaiting(action));
    const asked = picked ? waiting.find((action) => action.id === picked) : undefined;
    if (asked && !opened) {
      opened = true;
      const info = CLASS_INFO[asked.class as ActionClass];
      openSheet({ title: `${info?.label ?? "An action"}: ${asked.target}`, body: actionCard(ctx, asked) });
    }
    replace(pickedNote, picked && !opened && loaded && !asked ? callout("quiet", "That approval isn't waiting any more: it was answered, or it expired (no answer in 24 hours means no). What was decided is under Recent decisions.") : null);
    const decided = ctx.live.actions.value.filter((action) => !isWaiting(action)).slice(0, 6);
    keepPlace(historyRows, () => replace(historyRows, ...decided.map((action) => decidedRow(ctx, action))));
    historySummary.textContent = `Recent decisions (${decided.length})`;
    history.hidden = !decided.length;
  }

  replace(
    root,
    h(
      "div",
      { class: "page narrow" },
      inSheet ? null : pageHead("Needs you", "Nothing here happens without your say."),
      // Shown whole once it has been read: what waits comes in at once.
      pageBody(pickedNote, reach.el, lists, ctx.can("mind:read") ? history : null),
    ),
  );
  for (const source of [...workSources(ctx), ctx.live.pairings, ctx.live.secretRequests, ctx.live.loopDrafts, ctx.live.connectorRequests, ctx.live.aboutYou, ctx.live.screenSessions, ctx.live.questions, ctx.live.notices, ctx.live.inboxLoaded] as { subscribe(listener: () => void): () => void }[]) scope.add(source.subscribe(draw));
  draw();
  void ctx.live.refreshInbox();
  // Each part is read again as the node's live stream says it changed (live.ts); while that stream is down, the whole
  // Inbox every two seconds while it is open.
  scope.add(ctx.live.follow([], () => ctx.live.refreshInbox(), 2000));
};
