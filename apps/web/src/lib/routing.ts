import { beginsByKind, KIND_WORDS, type RoutedTaskRead, routingReport, type RoutingReportTask } from "@invincible/core/routing";

/**
 * Where an agent's next task of each kind begins, for its details beside its timeline: one quiet line each kind it has
 * done (core's routing.ts, the rule its node begins them by and the CLI says them by), and why, from its tasks in the
 * node's order, the latest first.
 */
export function beginLines(tasks: readonly RoutedTaskRead[]): { text: string; why: string }[] {
  return beginsByKind(tasks).map(({ kind, begin }) => {
    const many = KIND_WORDS[kind].many;
    return { text: `${many[0]!.toUpperCase()}${many.slice(1)} begin on the ${begin.tier}'s models`, why: begin.why };
  });
}

/**
 * The team's routing on the agents' page, at a desk's width and never on a phone: a quiet line each kind its node's
 * finished tasks were routed as (core's routingReport, what `invincible agents routing` says in full): how many were
 * verified, began on the planner's models, moved up, went round on both tiers, and needed you (you stepped in on them,
 * however often), leaving out what is none. No money: each agent's row says what its week cost.
 */
export function teamRoutingLines(tasks: readonly RoutingReportTask[]): string[] {
  return routingReport(tasks, {}).kinds.map((kind) => {
    const many = KIND_WORDS[kind.kind].many;
    const sum = (count: (group: (typeof kind.groups)[number]) => number) => kind.groups.reduce((total, group) => total + count(group), 0);
    const planner = sum((group) => (group.began === "planner" ? group.tasks : 0));
    const moved = sum((group) => group.movedUp.gate + group.movedUp.review + group.movedUp.stall + group.movedUp.rereads);
    const round = sum((group) => group.wentRound);
    return [
      `${many[0]!.toUpperCase()}${many.slice(1)}: ${kind.verified} of ${kind.tasks} verified`,
      planner ? `${planner} began on the planner's` : "",
      moved ? `${moved} moved up` : "",
      round ? `${round} went round on both tiers` : "",
      kind.neededYou ? `${kind.neededYou} needed you` : "",
    ]
      .filter(Boolean)
      .join(" · ");
  });
}
