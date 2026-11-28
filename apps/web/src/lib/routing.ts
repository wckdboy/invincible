import { beginsByKind, KIND_WORDS, type RoutedTaskRead } from "@invincible/core/routing";

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
