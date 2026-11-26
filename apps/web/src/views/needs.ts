import type { ActionView } from "@galahad/core";
import type { Ctx } from "../context.ts";
import { isWaiting } from "../live.ts";
import { hashOf } from "../lib/nav.ts";
import { knightOfCaller } from "../lib/roster.ts";
import { relativeTime } from "../lib/time.ts";
import type { Attended, WorkRow } from "../lib/work.ts";
import type { ActionClass } from "../types.ts";
import { button } from "../ui/controls.ts";
import { openSheet } from "../ui/dialog.ts";
import { cx, h, replace, type Child } from "../ui/dom.ts";
import { icon, type IconName } from "../ui/icons.ts";
import { knightFace } from "../ui/orb.ts";
import { factRow } from "./about-you.ts";
import { CLASS_INFO } from "./activity.ts";
import { connectorRequestCard } from "./connectors.ts";
import { pairingCard } from "./fleet.ts";
import { actionCard, answerAction, approveAction, loopDraftCard, questionCard, screenSessionCard } from "./inbox.ts";
import { controlTeam } from "./team-forms.ts";
import { secretRequestCard } from "./vault.ts";

/*
 * What needs you, each with its answer in place (your words, 26 November 2026, after OpenMausBot's best idea: "Needs
 * you" with every card's buttons inline, never a trip to another page to answer): an approval's Allow once and Deny, a
 * proposal's Approve and Decline, work cut short's Resume, a knight you paused that work waits behind. What takes more
 * than a tap (comparing a device's code, typing a key, a service's question with fields) opens the Inbox's own card for
 * it in a sheet, over the page. Home draws these; the Inbox page is still where all of it is, with its history.
 */

/** Who asked, as an item's first line says it: a knight by its orb and name, or him, a loop, a service. */
const who = (lead: Child, text: string): HTMLElement => h("div", { class: "need-who" }, lead, h("span", { class: "ellipsis" }, text));
const leadIcon = (name: IconName): HTMLElement => h("span", { class: "need-icon", "aria-hidden": "true" }, icon(name, { size: 14 }));
const face = (row: Pick<WorkRow, "knight">): HTMLElement => knightFace({ id: row.knight.id, profile: row.knight.avatar, size: 20 });

function item(kind: string, head: HTMLElement, what: Child, acts: Child[], extra: Child = null): HTMLElement {
  const outcome = h("div", { class: "need-outcome" });
  return h("article", { class: "need", "data-kind": kind }, head, h("div", { class: "need-what" }, what), extra, h("div", { class: "need-acts" }, ...acts), outcome);
}

/** Opens one of the Inbox's own cards in a sheet, to answer there. */
const inSheet = (title: string, card: () => HTMLElement) => () => openSheet({ title, body: card() });

/** An approval, compact: who asks and what, its target in mono, then Allow once (confirmed, as the Inbox's), Deny, and
 * the whole card (its arguments, a standing order, your own words in it). */
export function askItem(ctx: Ctx, action: ActionView, row: WorkRow | null): HTMLElement {
  const info = CLASS_INFO[action.class as ActionClass];
  const destructive = action.class === "delete";
  const outward = action.class === "outward";
  const asker = row ? `${row.knight.name} · ${row.title}` : `${askerName(ctx, action.by)} asks`;
  const admin = ctx.can("fleet:admin");
  const allow = button(destructive ? "Allow delete…" : "Allow once", { variant: "primary", size: "sm" });
  const deny = button("Deny", { size: "sm" });
  const more = button("More", { variant: "ghost", size: "sm", iconOnly: true, icon: "more", label: "Everything about it, a standing order, or your own words in it", onClick: inSheet(`${info?.label ?? "An action"}: ${action.target}`, () => actionCard(ctx, action)) });
  const shown = item(
    "action",
    who(row ? face(row) : leadIcon("mark"), asker),
    [h("span", {}, `${info?.label ?? action.class} · `), h("span", { class: "mono wrap-anywhere" }, `${action.connector}.${action.tool}`), " ", h("span", { class: "mono wrap-anywhere need-target" }, action.target)],
    admin ? [allow, deny, more] : [more],
    h("p", { class: cx("need-note", (destructive || outward) && "is-warn") }, destructive ? "It can't be brought back once deleted." : outward ? "Others can see it once it's sent." : "", h("span", { class: "tnum expires", "data-expires": String(action.expires) }, ` Expires ${relativeTime(action.expires)}; no answer means no.`)),
  );
  const outcome = shown.querySelector<HTMLElement>(".need-outcome")!;
  const problem = (callout: HTMLElement) => replace(outcome, callout);
  allow.addEventListener("click", () => void approveAction(ctx, action, allow, problem));
  deny.addEventListener("click", () => void answerAction(ctx, action, false, deny, problem));
  // (Allow similar…, and your own words in it, are in the whole card, under More, as the Inbox's.)
  return shown;
}

/** Who filed an action, as a person says it: a knight by its name, a loop of yours, or Galahad himself. */
function askerName(ctx: Ctx, by: string): string {
  const knight = knightOfCaller(by);
  if (knight) return ctx.live.team.value?.teammates.find((person) => person.id === knight)?.name ?? knight;
  if (by.startsWith("loop:")) return `The loop ${by.slice(5)}`;
  return "Galahad";
}

/** A task that only you can move on: its proposal, its work cut short, a knight you paused that it waits behind. */
function taskItem(ctx: Ctx, row: WorkRow): HTMLElement {
  const canAct = ctx.can("fleet:admin") && ctx.can("chat");
  const open = h("a", { class: "btn ghost sm", href: hashOf("task", { task: row.id }) }, "Open");
  const control = (label: string, change: Parameters<typeof controlTeam>[1], primary = false) =>
    button(label, { size: "sm", variant: primary ? "primary" : "default", onClick: (event) => {
      const trigger = event.currentTarget as HTMLButtonElement;
      trigger.disabled = true;
      void controlTeam(ctx, change).finally(() => (trigger.disabled = false));
    } });
  const what = h("span", {}, row.title);
  if (row.word === "Approve?") return item("proposal", who(face(row), `${row.knight.name} proposes`), what, canAct ? [control("Approve", { task: row.id, action: "approve" }, true), control("Decline", { task: row.id, action: "stop" }), open] : [open]);
  if (row.word === "Interrupted") return item("interrupted", who(face(row), `${row.knight.name} · interrupted`), what, canAct ? [control("Resume", { task: row.id, action: "resume" }, true), open] : [open]);
  if (row.word === "Knight paused") return item("paused", who(face(row), `${row.knight.name} is paused`), what, canAct ? [control(`Resume ${row.knight.name}`, { teammate: row.knight.id, action: "resume" }, true), open] : [open]);
  return item("task", who(face(row), row.knight.name), what, [open]);
}

/**
 * Everything that needs you, as items with their answers in place: each task row that needs you (its knight's asks
 * under it), then what is no task's (his own asks and a loop's, devices, keys, services' questions, notices, drafts,
 * connectors, facts, his use of a Mac). The count is the same as what is shown.
 */
export function needsItems(ctx: Ctx, work: Attended): HTMLElement[] {
  const now = Date.now();
  const waiting = ctx.live.actions.value.filter((action) => isWaiting(action, now));
  const items: HTMLElement[] = [];
  const shownActions = new Set<string>();
  for (const row of work.needs) {
    if (row.word === "Allow?") {
      for (const action of waiting.filter((one) => knightOfCaller(one.by) === row.knight.id)) {
        shownActions.add(action.id);
        items.push(askItem(ctx, action, row));
      }
    } else items.push(taskItem(ctx, row));
  }
  for (const action of waiting.filter((one) => !shownActions.has(one.id))) items.push(askItem(ctx, action, null));
  const admin = ctx.can("fleet:admin");
  for (const p of ctx.live.pairings.value) {
    items.push(item("pairing", who(leadIcon(p.kind === "node" ? "server" : "phone"), p.kind === "node" ? "A machine asks to join" : "A device asks to join"), h("span", {}, p.name), admin ? [button("Compare codes…", { size: "sm", variant: "primary", onClick: inSheet(`${p.name} asks to join`, () => pairingCard(ctx, p)) })] : []));
  }
  for (const r of ctx.live.secretRequests.value) {
    items.push(item("key", who(leadIcon("key"), "Galahad asks for a key"), [h("span", { class: "mono" }, r.name), ` · ${r.purpose}`], ctx.can("vault:write") ? [button("Add it…", { size: "sm", variant: "primary", onClick: inSheet(`A key for ${r.name}`, () => secretRequestCard(ctx, r)) })] : []));
  }
  for (const q of ctx.live.questions.value.filter((one) => one.expires > now)) {
    items.push(item("question", who(leadIcon("plug"), `${q.label} asks`), h("span", {}, q.message), [button("Answer…", { size: "sm", variant: "primary", onClick: inSheet(`${q.label} asks`, () => questionCard(ctx, q)) })]));
  }
  for (const s of ctx.live.screenSessions.value.filter((one) => one.state === "waiting" || one.state === "allowed")) {
    items.push(item("screen", who(leadIcon("monitor"), s.state === "allowed" ? `Galahad is using ${s.nodeName}` : `Galahad asks to use ${s.nodeName}`), h("span", {}, s.why), [button(s.state === "allowed" ? "See it…" : "Answer…", { size: "sm", variant: "primary", onClick: inSheet(`${s.nodeName}`, () => screenSessionCard(ctx, s)) })]));
  }
  for (const n of ctx.live.notices.value.filter((one) => !one.dismissed)) {
    const dismiss = admin
      ? button("Dismiss", {
          size: "sm",
          onClick: (event) => {
            const trigger = event.currentTarget as HTMLButtonElement;
            trigger.disabled = true;
            void ctx.api.post("/api/notices/dismiss", { key: n.key }).then(() => ctx.live.refreshNotices(), () => (trigger.disabled = false));
          },
        })
      : null;
    items.push(item("notice", who(leadIcon(n.severity === "info" ? "bell" : "alert"), "Noticed"), h("span", {}, n.title), [dismiss, h("a", { class: "btn ghost sm", href: "#/inbox" }, "Read")]));
  }
  for (const d of ctx.live.loopDrafts.value) items.push(item("draft", who(leadIcon("repeat"), "Galahad drafted a loop"), h("span", {}, d.label ?? d.name), [button("Review…", { size: "sm", variant: "primary", onClick: inSheet(`A loop: ${d.label ?? d.name}`, () => loopDraftCard(ctx, d)) })]));
  for (const c of ctx.live.connectorRequests.value) items.push(item("connector", who(leadIcon("plug"), `${c.by} asks for a connector`), h("span", {}, c.label ?? c.connector), [button("Review…", { size: "sm", variant: "primary", onClick: inSheet(`A connector: ${c.label ?? c.connector}`, () => connectorRequestCard(ctx, c)) })]));
  for (const m of ctx.live.aboutYou.value) items.push(item("fact", who(leadIcon("user"), "He noticed about you"), h("span", {}, m.text.split("\n")[0] ?? ""), [button("Keep or drop…", { size: "sm", variant: "primary", onClick: inSheet("A fact about you", () => h("div", { class: "card rows" }, factRow(ctx, m, true))) })]));
  return items;
}

/** What the items are drawn from, to compare before drawing them again: each waiting thing by its id and state. */
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

/** An item's "Expires in 12 min", kept true without drawing it again (that would lose a half-made answer). */
export function tickExpiries(root: ParentNode): void {
  for (const el of root.querySelectorAll<HTMLElement>(".need .expires")) {
    const at = Number(el.dataset.expires);
    el.textContent = at > Date.now() ? ` Expires ${relativeTime(at)}; no answer means no.` : " Expired.";
  }
}

/** How many items needsItems() draws, worked out without drawing them: every waiting approval once (under its task's
 * row or alone), each other task row that needs you, and each other waiting thing. */
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
    l.notices.value.filter((n) => !n.dismissed).length +
    l.loopDrafts.value.length +
    l.connectorRequests.value.length +
    l.aboutYou.value.length
  );
}
