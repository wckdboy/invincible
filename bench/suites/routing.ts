import type { Suite } from "../lib.ts";
import { BUDGET_USD, type PolicyResult, POLICIES, runPolicy, simTasks, TIERS } from "../routing/sim.ts";

/*
 * Smart routing (bench/routing/sim.ts): a seeded set of an agent's tasks run as the node runs them, the real team
 * runtime and its work loop, with stand-in models in the roster's roles: a cheap worker on the engineer's, a strong lead
 * on the planner's, and a judge on the reviewer's that knows the truth. Three ways to route the same tasks: as a node
 * does (`routed`: the ladder may move work up), the agent pinned to the cheap model (`pinned`, the all-cheap bound) and
 * every turn on the strong one (`strong`). Measured, each against the mandate's numbers: tasks verified, interventions
 * per verified task (a task that ends unverified needs you), stand-in dollars and virtual minutes per verified task, and
 * how often the work moved up; and the rules, never anything but 0: an agent's pinned work moved off its model, work
 * moved up more than the ladder's one rung, work moved "up" onto the model it was on, and a run that differs when run
 * again. No vendor's model, price or speed is in it: what it measures is the routing, on the stand-ins' terms.
 */

const TASKS = 36;

export const suite: Suite = {
  name: "routing",
  about: "an agent's seeded tasks through the real team runtime with stand-in models (a cheap worker, a strong lead, a judge): tasks verified, interventions, stand-in $ and minutes per verified task, escalations, the routing rules",
  headline: [
    "routing.routed.verified",
    "routing.routed.interventions-per-done",
    "routing.routed.usd-per-done",
    "routing.routed.minutes-per-done",
    "routing.routed.escalations",
    "routing.rule.pinned-moved",
    "routing.rule.climbs",
    "routing.rule.same-rung",
    "routing.replay.differs",
  ],
  held: { "routing.rule.pinned-moved": 0, "routing.rule.climbs": 0, "routing.rule.same-rung": 0, "routing.replay.differs": 0 },
  async run(ctx) {
    const tasks = simTasks(ctx.seed, TASKS);
    const kinds = (["gate", "review", "stall"] as const).map((kind) => `${tasks.filter((t) => t.kind === kind).length} ${kind}`).join(", ");
    const levels = [1, 2, 3, 4].map((level) => `${tasks.filter((t) => t.level === level).length} at ${level}`).join(", ");
    ctx.log(`${TASKS} tasks (${kinds}; ${levels}): the worker does levels to ${TIERS.worker.capability}, the lead to ${TIERS.lead.capability}, nothing a 4; $${BUDGET_USD} each`);
    const results = new Map<string, PolicyResult>();
    for (const policy of POLICIES) {
      const r = await runPolicy(policy, tasks);
      ctx.pulse();
      results.set(policy, r);
      // (None verified would be the stand-ins broken, not a number: the suite breaks, and says so.)
      if (!r.verified) throw new Error(`no task ended verified when ${policy}: the stand-ins or the runtime are broken`);
      const per = (n: number) => n / r.verified;
      const said = { routed: "routed as a node does: the ladder may move the work from the cheap worker to the strong lead", pinned: "the agent pinned to the cheap worker, so its work stays there (the all-cheap bound)", strong: "every turn of the work on the strong lead (the all-strong bound)" }[policy];
      ctx.quality(`routing.${policy}.verified`, r.verified, "tasks", "higher", { note: `of ${TASKS}, the tasks that ended verified, ${said}` });
      ctx.quality(`routing.${policy}.interventions-per-done`, per(r.interventions), "", "lower", { note: "tasks that ended unverified (each needs you), per verified task: the north star" });
      ctx.quality(`routing.${policy}.usd-per-done`, per(r.usd), "$", "lower", { note: "stand-in dollars every task spent (its record's tokens at the stand-ins' prices), per verified task" });
      ctx.quality(`routing.${policy}.minutes-per-done`, per(r.minutes), "min", "lower", { note: "virtual minutes every task took (its calls, commands and gates at the stand-ins' seconds), per verified task" });
      const moved = r.tasks.flatMap((t) => t.escalations);
      ctx.quality(`routing.${policy}.escalations`, moved.length, "", "lower", { note: "times work moved up the ladder: each a failure found late, on the cheap model" });
      const told = (words: string) => moved.filter((line) => line.includes(words)).length;
      ctx.log(`${policy}: ${r.verified} of ${TASKS} verified, ${r.interventions} need you, $${r.usd.toFixed(2)} and ${r.minutes.toFixed(0)} min in all; moved up ${moved.length} times (${told("same gate")} gate, ${told("the reviewer")} reviewer, ${told("two audits")} audits, ${told("the same files again")} reading again)`);
    }
    const routed = results.get("routed")!;
    for (const [why, words] of [["gate", "the same gate failed twice in a row"], ["review", "the reviewer sent it back twice in a row"], ["stall", "two audits in a row steered it"], ["rereads", "it read the same files again and again"]] as const) {
      ctx.quality(`routing.routed.escalations.${why}`, routed.tasks.filter((t) => t.escalations.some((line) => line.includes(words))).length, "tasks", "lower", { note: `routed tasks whose work moved up because ${words}` });
    }
    ctx.quality("routing.rule.pinned-moved", results.get("pinned")!.tasks.reduce((sum, t) => sum + t.movedOffPins, 0), "turns", "lower", { note: "turns of a pinned agent's work answered by a model other than its own (the rule: never)" });
    ctx.quality("routing.rule.climbs", [...results.values()].flatMap((r) => r.tasks).filter((t) => t.escalations.length > 1).length, "tasks", "lower", { note: "tasks whose work moved up more than once: the ladder has one rung (never)" });
    ctx.quality("routing.rule.same-rung", results.get("strong")!.tasks.reduce((sum, t) => sum + t.escalations.length, 0), "", "lower", { note: "work said to move up onto the model it was on: with the planner's model the work's own there is no rung (never)" });
    // The same tasks again, task by task: the same outcome, cost and time.
    const again = await runPolicy("routed", tasks);
    const key = (t: PolicyResult["tasks"][number]) => JSON.stringify([t.verified, t.usd, t.minutes, t.escalations, t.calls]);
    ctx.quality("routing.replay.differs", again.tasks.filter((t, i) => key(t) !== key(routed.tasks[i]!)).length, "tasks", "lower", { note: `of ${TASKS}, the tasks whose outcome, cost, time or escalations differed when run again` });
  },
};
