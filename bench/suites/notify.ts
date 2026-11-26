import { type NotifyPayload } from "../../packages/core/src/index.ts";
import type { MindStore } from "../../packages/mind/src/index.ts";
import { NotifyService, type NotifySources } from "../../packages/node/src/notify.ts";
import { NotifyStore } from "../../packages/node/src/notify-store.ts";
import { quantile, type Suite } from "../lib.ts";
import { runNotifySim } from "../notify/sim.ts";

/*
 * Notifications: does what needs you reach you, and does little else interrupt you? A seeded week in virtual time
 * (bench/notify/sim.ts): the real rules and the real notifier, a stand-in week of asks and news, two devices that each
 * fail once, and a stand-in owner who answers only what reached them. Every number is a count or virtual minutes.
 */

export const suite: Suite = {
  name: "notify",
  about: "a seeded week of asks and news on the owner's two devices: are asks answered in time, and how often does he buzz?",
  headline: [
    "notify.week.asks-missed",
    "notify.week.ask-answer-p90",
    "notify.week.asks-unreachable-minutes",
    "notify.week.buzzes-per-completed",
    "notify.week.night-buzzes",
    "notify.week.duplicates",
    "notify.week.summary-overwrote-ask",
    "notify.look",
  ],
  async run(ctx) {
    const r = await runNotifySim({ seed: ctx.seed });
    ctx.pulse();
    if (r.problems.length) throw new Error(`the simulation went wrong: ${r.problems.join("; ")}`);
    const minutes = [...r.answerMinutes].sort((a, b) => a - b);
    ctx.quality("notify.week.asks-missed", r.missed, "asks", "lower", { note: `of ${r.asks} asks, those that lapsed unanswered (no answer is no)` });
    ctx.quality("notify.week.asks-answered", r.answered, "asks", "higher", { note: `of ${r.asks} asks (one connector request is left standing on purpose)` });
    ctx.quality("notify.week.ask-answer-p50", minutes.length ? quantile(minutes, 0.5) : 0, "min", "lower", { note: "from an ask to its answer, the median, virtual minutes" });
    ctx.quality("notify.week.ask-answer-p90", minutes.length ? quantile(minutes, 0.9) : 0, "min", "lower", { note: "from an ask to its answer, the 90th percentile, virtual minutes" });
    ctx.quality("notify.week.asks-unreachable-minutes", r.unreachableMinutes, "min", "lower", { note: "minutes in which an ask stood and no device of the owner's could be reached" });
    ctx.quality("notify.week.buzzes", r.buzzes, "buzzes", "lower", { note: `deliveries that sounded, of ${r.delivered} that arrived (tests and the day's-limit message aside)` });
    ctx.quality("notify.week.buzzes-per-completed", r.completed ? r.buzzes / r.completed : 0, "", "lower", { note: `buzzes for each of ${r.completed} knights' tasks that ended verified (the north star's denominator)` });
    ctx.quality("notify.week.night-buzzes", r.nightBuzzes, "buzzes", "lower", { note: "buzzes between 22:00 and 07:00 in the owner's own time that weren't alerts" });
    ctx.quality("notify.week.self-resolved-buzzes", r.selfResolvedBuzzes, "buzzes", "lower", { note: "buzzes about something that resolved without the owner (a CI failure a knight fixed, a node back online)" });
    ctx.quality("notify.week.summary-overwrote-ask", r.summaryOverwroteAsk, "", "lower", { note: "a notification that replaced one telling of an ask still waiting, without telling of it" });
    ctx.quality("notify.week.duplicates", r.duplicates, "", "lower", { note: "the same thing told as new again while it stood" });
    ctx.quality("notify.week.model-buzzes", r.modelBuzzes, "buzzes", "lower", { note: "buzzes about what his own judgment raised (a look or an outcome ending by asking you)" });
    ctx.log(`a week: ${r.buzzes} buzzes of ${r.delivered} deliveries, ${r.answered} of ${r.asks} asks answered, ${r.missed} missed`);

    // What one look costs, with a day's worth standing: what a node pays every 15 seconds.
    let clock = Date.parse("2026-11-25T12:00:00Z");
    const db = new NotifyStore(":memory:", () => clock, "Europe/London");
    db.put("c_bench-phone", { endpoint: "apns:production:" + "ab".repeat(32), p256dh: "", auth: "", service: "Apple" });
    const notices = Array.from({ length: 24 }, (_, i) => ({ key: `bench:${i}`, severity: i % 3 ? "info" : "warn", title: `finding ${i}`, source: i % 2 ? "heartbeat" : `tell:loop-${i}`, dismissed: false }));
    const actions = Array.from({ length: 6 }, (_, i) => ({ id: `a_${String(i).padStart(22, "0")}`, connector: "dinero", tool: "book", state: "waiting", requestedAt: `${clock - 3_600_000}.0000.n_bench`, expires: clock + 86_400_000, class: "outward" }));
    const sources: NotifySources = {
      notices: () => notices,
      actions: () => actions,
      secretRequests: () => ["a-key", "another-key"],
      connectorRequests: () => [],
      turns: { running: () => [], view: () => ({ watchers: 0 }) },
      chats: { summary: () => null },
      quests: { list: () => [], onChange: () => () => {} },
    };
    const device = { id: "c_bench-phone", name: "iPhone", kind: "client", scopes: ["mind:read", "chat", "vault:read", "brain:write"] };
    const mind = { activeDevice: (id: string) => (id === device.id ? device : null), devices: () => [device] } as unknown as MindStore;
    const sender = { publicKey: async () => "key", send: async (_t: unknown, _p: NotifyPayload) => ({ ok: true, gone: false, status: 200, error: null, attempts: 1 }) };
    const service = new NotifyService({ mind, nodeName: "bench", db, sender, allowed: [], sources, ledger: () => {}, log: () => {}, now: () => clock, tickMs: false });
    await service.tick();
    await ctx.timeAsync(
      "notify.look",
      async () => {
        clock += 15_000;
        await service.tick();
      },
      { n: 15, warm: 5, note: "one look with 24 notices, 6 approvals and 2 key requests standing, all told already" },
    );
    await service.stop();
    db.close();
  },
};
