import type { Ctx } from "../context.ts";
import { isWaiting } from "../live.ts";
import { plural } from "../lib/text.ts";
import { h, replace, type Scope } from "../ui/dom.ts";
import { connectorRequestCard } from "./connectors.ts";
import { actionCard, questionCard } from "./inbox.ts";
import { reachNote } from "./notifications.ts";
import { secretRequestCard } from "./vault.ts";

/*
 * What the primary asks you, under its orb as you come to it (your word, 23 November 2026: it is the one you talk to and
 * hear from, for nearly everything): the approvals the policy leaves to you (its and the agents', each saying who asked),
 * the keys and connectors it asked for, and what services ask you in the middle of its calls, each answered here. The
 * Inbox still holds all of it, and the rest: devices asking to join, notices, drafts, facts about you. First, while it
 * matters, that it can't reach this device when the primary is closed (notifications.ts, reachNote).
 */

/** At most this many here; the rest are counted, a tap from the Inbox. */
const SHOWN = 4;

/**
 * The section, and its drawing (the caller draws it first, once the welcome is where you stay: `settled` says so, so
 * that one shown on a welcome a moment before the chat you had open comes back never moves what follows).
 */
export function primaryAsks(ctx: Ctx, scope: Scope, settled: () => boolean = () => true): { box: HTMLElement; render: () => void } {
  const box = h("section", { class: "primary-asks stack", "aria-label": "Your agent asks you", hidden: true });
  // First, while it matters: that it can't reach this device when the primary is closed, and the one thing to do.
  const reach = reachNote(ctx, scope, () => render());
  const render = (): void => {
    const cards = !settled() ? [] : [
      ...ctx.live.actions.value.filter((action) => isWaiting(action)).map((action) => actionCard(ctx, action)),
      ...ctx.live.secretRequests.value.map((request) => secretRequestCard(ctx, request)),
      ...ctx.live.connectorRequests.value.map((request) => connectorRequestCard(ctx, request)),
      ...ctx.live.questions.value.filter((question) => question.expires > Date.now()).map((question) => questionCard(ctx, question)),
    ];
    const reaching = settled() && reach.shown();
    box.hidden = cards.length === 0 && !reaching;
    const more = cards.length - SHOWN;
    replace(
      box,
      cards.length || reaching ? h("h3", { class: "small strong" }, "Your agent asks you") : null,
      reaching ? reach.el : null,
      ...cards.slice(0, SHOWN),
      more > 0 ? h("a", { class: "small", href: "#/inbox" }, `${plural(more, "more", "more")} in the Inbox`) : null,
    );
  };
  for (const watched of [ctx.live.actions, ctx.live.secretRequests, ctx.live.connectorRequests, ctx.live.questions]) scope.add(watched.subscribe(render));
  return { box, render };
}
