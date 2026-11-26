import type { QuestView } from "@galahad/core";
import type { TurnLimits, TurnView } from "@galahad/core/turns";
import { type Ctx, errorMessage } from "../context.ts";
import { needsYou } from "../lib/now.ts";
import { gateOwner, gateResult, questBadge, questInHand, questWhere } from "../lib/quests.ts";
import { duration, relativeTime } from "../lib/time.ts";
import { stopsIn } from "../lib/turns.ts";
import { badge, button, callout, dot, meter, section } from "../ui/controls.ts";
import { openSheet } from "../ui/dialog.ts";
import { h, keepPlace, replace, type Scope } from "../ui/dom.ts";
import { icon } from "../ui/icons.ts";
import { toast } from "../ui/toast.ts";

/*
 * In hand: what Galahad is working on right now, wherever you look from. The chat
 * turns the node is running (what each is at, what it has cost so far, whether anyone
 * is watching, when it stops by itself), and the quests in hand: each one's plan, the
 * command he's on, and each gate's last result. Then the quests that ended lately,
 * with how. Nothing is shown when there's nothing in hand and nothing ended.
 * The same section is one tap from the chat's header, in a sheet that also says what
 * needs you.
 */

function turnRow(ctx: Ctx, t: TurnView, now: number, leave?: () => void): HTMLElement {
  const watching = t.watchers === 0 ? "nobody watching" : t.watchers === 1 ? "1 watching" : `${t.watchers} watching`;
  const meta = [duration(now - t.startedAt), t.tools ? `${t.tools} tool${t.tools === 1 ? "" : "s"}` : null, watching, stopsIn(t.deadline, now)].filter(Boolean).join(" · ");
  const stop = button("Stop", {
    size: "sm",
    variant: "ghost",
    icon: "stop",
    label: `Stop him working on ${t.title ?? "this chat"}`,
    onClick: () => void ctx.api.post("/api/turns/stop", { turn: t.id }).catch((error: unknown) => toast("Couldn't stop him", { tone: "error", description: errorMessage(error) })),
  });
  return h(
    "div",
    { class: "item center in-hand-turn" },
    h("span", { class: "avatar agent" }, icon("chat", { size: 16 })),
    h(
      "div",
      { class: "grow" },
      h("div", { class: "row" }, h("span", { class: "strong small ellipsis" }, t.title ?? "A temporary chat"), t.steering ? badge(`${t.steering} on its way to him`, "info") : null),
      h("div", { class: "meta" }, h("span", { class: "ellipsis" }, t.watchable ? (t.step ?? "Starting") : "May read the bank: not shown to this device"), h("span", { class: "tnum" }, meta)),
    ),
    t.conversation && t.watchable ? button("Open", { size: "sm", onClick: () => (leave?.(), ctx.navigate("chat", { conversation: t.conversation! })) }) : null,
    stop,
  );
}

function gateRow(g: QuestView["gates"][number], n: number): HTMLElement {
  const result = gateResult(g.exitCode);
  const line = h("div", { class: "in-hand-gate" }, badge(`Gate ${n}: ${result.text}`, result.tone), h("code", { class: "mono ellipsis", title: g.command }, `$ ${g.command}`), h("span", { class: "tiny subtle" }, gateOwner(g.by)));
  // What a gate that failed printed is one click away.
  if (g.exitCode === null || g.exitCode === 0 || !g.excerpt?.trim()) return line;
  return h("details", { class: "in-hand-gate-detail" }, h("summary", {}, line), h("pre", { class: "mono tiny" }, g.excerpt.trim()));
}

function questCard(q: QuestView, opened: Set<string>): HTMLElement {
  const b = questBadge(q.state, q.silent);
  const state = badge(b.text, b.tone);
  if (b.live) state.prepend(dot(b.tone, { live: true }));
  const going = questInHand(q.state);
  const plan = q.plan
    ? h(
        "details",
        {
          class: "in-hand-plan",
          open: opened.has(q.quest),
          ontoggle: (event: Event) => ((event.currentTarget as HTMLDetailsElement).open ? opened.add(q.quest) : opened.delete(q.quest)),
        },
        h("summary", { class: "tiny" }, "The plan"),
        h("pre", { class: "in-hand-plan-text" }, q.plan),
      )
    : null;
  return h(
    "div",
    { class: "card pad stack tight in-hand-quest" },
    h("div", { class: "row wrap" }, h("span", { class: "strong small grow" }, q.goal), state),
    h("div", { class: "tiny subtle tnum" }, [questWhere(q), `run by ${q.by}`, going ? `started ${relativeTime(q.startedAt)}` : `ended ${relativeTime(q.updatedAt)}`].join(" · ")),
    going ? meter(Math.min(1, q.step / Math.max(1, q.maxSteps)), undefined, `Command ${q.step} of ${q.maxSteps}`) : null,
    going && q.doing ? h("div", { class: "in-hand-doing small" }, icon("chevron-right", { size: 13 }), h("span", { class: "ellipsis", title: q.doing }, q.doing)) : null,
    !going && q.summary ? h("div", { class: "small muted in-hand-summary" }, q.summary) : null,
    q.gates.length ? h("div", { class: "stack tight" }, ...q.gates.map((g, i) => gateRow(g, i + 1))) : null,
    plan,
  );
}

/**
 * The section itself: asks the node while it's on screen, and redraws only when something changed.
 * `always`: said even when there's nothing in hand; `leave`: called before a row goes to a chat.
 */
export function inHandSection(ctx: Ctx, scope: Scope, options: { always?: boolean; leave?: () => void } = {}): HTMLElement {
  // (Busy until its first answer: a page that appears whole waits for it, pageBody().)
  const host = h("div", { class: "in-hand", hidden: true, "aria-busy": "true" });
  const opened = new Set<string>();
  let seen = "";
  const mayTurns = ctx.can("chat");
  const mayQuests = ctx.can("mind:read");

  async function load(): Promise<void> {
    if (document.hidden) return;
    const [turns, quests] = await Promise.all([
      mayTurns ? ctx.api.get<{ turns: TurnView[]; limits: TurnLimits }>("/api/turns", scope.signal).catch(() => null) : null,
      mayQuests ? ctx.api.get<{ quests: QuestView[] }>("/api/quests", scope.signal).catch(() => null) : null,
    ]);
    if (scope.disposed) return;
    host.setAttribute("aria-busy", "false");
    const running = turns?.turns ?? [];
    const all = quests?.quests ?? [];
    const going = all.filter((q) => questInHand(q.state));
    const ended = all.filter((q) => !questInHand(q.state)).slice(0, 3);
    // Minutes move on while he works: they're part of what's shown.
    const signature = JSON.stringify([running, going, ended, Math.floor(Date.now() / 60_000)]);
    if (signature === seen) return;
    seen = signature;
    host.hidden = !options.always && !running.length && !going.length && !ended.length;
    if (host.hidden) return replace(host);
    const now = Date.now();
    const count = running.length + going.length;
    keepPlace(host, () =>
      replace(
        host,
        section(
          "In hand",
          { count: count ? String(count) : undefined },
          running.length ? h("div", { class: "card rows" }, ...running.map((t) => turnRow(ctx, t, now, options.leave))) : null,
          ...going.map((q) => questCard(q, opened)),
          !count ? h("p", { class: "small muted" }, "Nothing in hand right now.") : null,
          running.length
            ? h("p", { class: "tiny subtle" }, `A turn goes on whether or not anyone is watching, and still spends model tokens: at most ${turns!.limits.maxTurns} at once on this node, ${turns!.limits.maxMinutes} minutes each. What needs you waits in your Inbox; nothing is approved for you.`)
            : null,
          ended.length ? h("div", { class: "stack tight" }, h("div", { class: "tiny subtle" }, "Ended lately"), ...ended.map((q) => questCard(q, opened))) : null,
        ),
      ),
    );
  }

  void load();
  scope.interval(() => void load(), 5000);
  return host;
}

/** One tap from the chat's header: what he has in hand, and what needs you. The rest of the day's picture is the Overview. */
export function openInHand(ctx: Ctx): void {
  const needs = h("div");
  const sheet = openSheet({
    title: "Galahad",
    description: "What he has in hand, and what needs you.",
    size: "wide",
    body: needs,
    footer: button("Overview", { icon: "overview", title: "Health, what's in hand and recent activity", onClick: () => ctx.navigate("overview") }),
  });
  sheet.body.append(inHandSection(ctx, sheet.scope, { always: true, leave: sheet.close }));
  sheet.scope.add(
    ctx.live.inboxCount.watch((n) =>
      replace(
        needs,
        n
          ? callout("warn", "It waits in your Inbox: nothing is approved for you.", { title: needsYou(n), actions: button("Open the Inbox", { size: "sm", icon: "inbox", onClick: () => ctx.navigate("inbox") }) })
          : null,
      ),
    ),
  );
}
