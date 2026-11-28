import type { Suite } from "../lib.ts";
import { LIMIT_PER_MINUTE, runPace } from "../routing/pace.ts";
import { BUDGET_USD, memoryTasks, type PolicyResult, POLICIES, runPolicy, simTasks, TIERS } from "../routing/sim.ts";

/*
 * Smart routing (bench/routing/sim.ts): a seeded set of an agent's tasks run as the node runs them, the real team
 * runtime and its work loop, with stand-in models in the roster's roles: a cheap worker on the engineer's, a strong lead
 * on the planner's, and a judge on the reviewer's that knows the truth. Three ways to route the same tasks: as a node
 * does (`routed`: the ladder may move work up), the agent pinned to the cheap model (`pinned`, the all-cheap bound) and
 * every turn on the strong one (`strong`). Measured, each against the mandate's numbers: tasks verified, interventions
 * per verified task (a task that ends unverified needs you), stand-in dollars and virtual minutes per verified task, and
 * how often the work moved up; and the rules, never anything but 0: an agent's pinned work moved off its model, work
 * moved up more than the ladder's one rung, work moved "up" onto the model it was on, a task of a kind its worker always
 * does begun on the lead by the memory, and a run (or the memory's) that differs when run again. No vendor's model,
 * price or speed is in it: what it measures is the routing, on the stand-ins' terms.
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
    "routing.memory.on.usd-per-done",
    "routing.rule.memory-misroutes",
    "routing.memory.replay.differs",
    "routing.notice.minutes",
    "routing.rule.notice-lost",
    "routing.rule.notice-left",
    "routing.pace.on.served",
    "routing.pace.on.refused",
    "routing.replay.differs",
  ],
  held: { "routing.rule.pinned-moved": 0, "routing.rule.climbs": 0, "routing.rule.same-rung": 0, "routing.rule.memory-misroutes": 0, "routing.memory.replay.differs": 0, "routing.rule.notice-lost": 0, "routing.rule.notice-left": 0, "routing.pace.on.refused": 0, "routing.replay.differs": 0 },
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
    // Work going round on both tiers (run.ts round): you are told at once, with a notice, and the work goes on until you
    // stop it or its budget ends it (your word, 19 November 2026). How soon, against when it ended; and that it changes
    // nothing of the work: the same tasks without it, held equal.
    const told = routed.tasks.filter((t) => t.noticed);
    const mean = (f: (t: PolicyResult["tasks"][number]) => number) => told.reduce((sum, t) => sum + f(t), 0) / Math.max(1, told.length);
    ctx.quality("routing.notice.told", told.length, "tasks", "higher", { note: `of ${TASKS}, routed tasks that went round on both tiers and were told to you as they went on` });
    ctx.quality("routing.notice.minutes", mean((t) => t.noticed!.minutes), "min", "lower", { note: "virtual minutes from such a task's start to its notice" });
    ctx.quality("routing.notice.ended-minutes", mean((t) => t.minutes), "min", "lower", { note: "virtual minutes the same tasks ran in all: when you would have heard without the notice" });
    ctx.quality("routing.notice.false", told.filter((t) => t.verified).length, "tasks", "lower", { note: "tasks told as going round on both tiers that then ended verified" });
    ctx.quality("routing.rule.notice-left", told.filter((t) => !t.noticed!.cleared).length, "tasks", "lower", { note: "notices left standing after their task ended (never)" });
    const unnoticed = await runPolicy("routed", tasks, { notice: false });
    ctx.pulse();
    ctx.quality("routing.rule.notice-lost", unnoticed.tasks.filter((t, i) => t.verified && !routed.tasks[i]!.verified).length, "tasks", "lower", { note: "tasks verified without the notice that weren't with it (never: it tells you, and stops nothing)" });
    ctx.log(`the notice: ${told.length} told, at ${mean((t) => t.noticed!.minutes).toFixed(2)} min, where they ran ${mean((t) => t.minutes).toFixed(2)} min in all; ${told.filter((t) => t.verified).length} of them verified after all`);
    ctx.quality("routing.rule.pinned-moved", results.get("pinned")!.tasks.reduce((sum, t) => sum + t.movedOffPins, 0), "turns", "lower", { note: "turns of a pinned agent's work answered by a model other than its own (the rule: never)" });
    ctx.quality("routing.rule.climbs", [...results.values()].flatMap((r) => r.tasks).filter((t) => t.escalations.length > 1).length, "tasks", "lower", { note: "tasks whose work moved up more than once: the ladder has one rung (never)" });
    ctx.quality("routing.rule.same-rung", results.get("strong")!.tasks.reduce((sum, t) => sum + t.escalations.length, 0), "", "lower", { note: "work said to move up onto the model it was on: with the planner's model the work's own there is no rung (never)" });
    // The memory, by kind of task (core's routing.ts beginFor): four agents' tasks in turn, `ada`'s all the worker's to
    // do, `bo`'s all the lead's, `cy`'s any, and `di`'s fixes the worker's and its other tasks the lead's, one and the
    // other; routed as a node does, with each agent's tasks so far its memory's, and without.
    const remembered = memoryTasks(ctx.seed);
    let kept: PolicyResult | null = null;
    for (const memory of [false, true]) {
      const r = await runPolicy("routed", remembered, { memory });
      ctx.pulse();
      if (!r.verified) throw new Error("no task of the memory's ended verified: the stand-ins or the runtime are broken");
      const name = memory ? "on" : "off";
      const per = (n: number) => n / r.verified;
      const said = memory ? "each agent's tasks so far its memory's, as a node's are" : "no agent's tasks so far seen";
      ctx.quality(`routing.memory.${name}.verified`, r.verified, "tasks", "higher", { note: `of ${remembered.length}, four agents' tasks in turn, routed, ${said}` });
      ctx.quality(`routing.memory.${name}.usd-per-done`, per(r.usd), "$", "lower", { note: `stand-in dollars per verified task, ${said}` });
      ctx.quality(`routing.memory.${name}.minutes-per-done`, per(r.minutes), "min", "lower", { note: `virtual minutes per verified task, ${said}` });
      ctx.quality(`routing.memory.${name}.escalations`, r.tasks.flatMap((t) => t.escalations).length, "", "lower", { note: `times work moved up, ${said}` });
      if (memory) {
        kept = r;
        ctx.quality("routing.memory.on.began-on-lead", r.tasks.filter((t) => t.began === "planner").length, "tasks", "higher", { note: "tasks that began on the lead by how their agent's last task of their kind went" });
        ctx.quality("routing.memory.on.probes", r.tasks.filter((t) => t.routed?.because === "probe").length, "tasks", "lower", { note: "tasks that began on the worker again as a try, after their kind's last two began on the lead by the memory" });
        // (ada's tasks are all the worker's to do, and so are di's fixes, whatever its other tasks needed: never one of
        // them begun on the lead. A memory of one kind for all would begin di's fixes there.)
        const misrouted = r.tasks.filter((t) => t.began === "planner" && (t.task.agent === "ada" || (t.task.agent === "di" && t.task.fix)));
        ctx.quality("routing.rule.memory-misroutes", misrouted.length, "tasks", "lower", { note: "tasks of a kind the worker does every one of, begun on the lead (never): ada's, and di's fixes" });
      }
      ctx.log(`the memory ${name}: ${r.verified} of ${remembered.length} verified, $${r.usd.toFixed(2)} and ${r.minutes.toFixed(0)} min in all, moved up ${r.tasks.flatMap((t) => t.escalations).length} times, ${r.tasks.filter((t) => t.began === "planner").length} begun on the lead`);
    }
    // The memory's tasks again, with it: each begins where it did, for the same reason, with the same outcome.
    const memoryAgain = await runPolicy("routed", remembered, { memory: true });
    const begun = (t: PolicyResult["tasks"][number]) => JSON.stringify([t.began, t.routed, t.verified, t.usd, t.minutes, t.escalations]);
    ctx.quality("routing.memory.replay.differs", memoryAgain.tasks.filter((t, i) => begun(t) !== begun(kept!.tasks[i]!)).length, "tasks", "lower", { note: `of ${remembered.length}, the memory's tasks that began elsewhere, for another reason, or ended otherwise when run again (never)` });
    // A plan's pace (bursts.ts Pacer): eight agents on OpenCode Go for ten virtual minutes, without the pace and with it.
    for (const pace of [undefined, 24]) {
      const r = runPace({ seed: ctx.seed, agents: 8, ...(pace ? { pace } : {}) });
      const name = pace ? "on" : "off";
      const said = pace ? `every call taking its turn at ${pace} a minute, as a node's chat() and gateway do` : "each refusal waited out after it came, as bursts.ts does";
      ctx.quality(`routing.pace.${name}.served`, r.served, "calls", "higher", { note: `calls the plan answered in ten minutes to eight agents, ${said}` });
      ctx.quality(`routing.pace.${name}.refused`, r.refused, "asks", "lower", { note: `asks it refused as a burst (past ${LIMIT_PER_MINUTE} a minute), ${said}` });
      ctx.quality(`routing.pace.${name}.waited`, r.waitedS, "s", "lower", { note: `seconds the agents waited, their turn or a burst out, ${said}` });
      ctx.log(`the pace ${name}: ${r.served} calls served, ${r.refused} refused, ${r.givenUp} given up, ${r.waitedS} s waited`);
    }
    // The same tasks again, task by task: the same outcome, cost and time.
    const again = await runPolicy("routed", tasks);
    const key = (t: PolicyResult["tasks"][number]) => JSON.stringify([t.verified, t.usd, t.minutes, t.escalations, t.calls]);
    ctx.quality("routing.replay.differs", again.tasks.filter((t, i) => key(t) !== key(routed.tasks[i]!)).length, "tasks", "lower", { note: `of ${TASKS}, the tasks whose outcome, cost, time or escalations differed when run again` });
  },
};
