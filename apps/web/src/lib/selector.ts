import { rank } from "./fuzzy.ts";

/*
 * The smart selector's logic (ui/selector.ts draws it): grouped choices filtered by
 * what you type, arrow keys that skip what can't be chosen, type-ahead, and a
 * group of toggles summed up in plain words. Pure functions, unit-tested.
 */

export interface Choice {
  value: string;
  label: string;
  /** A second line: a model, a count, what it means. Searched too. */
  meta?: string;
  /** More words that find it. */
  keywords?: string[];
  selected?: boolean;
  /** Can't be chosen; a string says why. */
  disabled?: boolean | string;
}

export interface ChoiceGroup<C extends Choice = Choice> {
  id: string;
  label?: string;
  /** "one": choosing replaces the group's choice (and closes). "many": each is a toggle. "action": runs once. */
  mode?: "one" | "many" | "action";
  options: C[];
}

export interface Shown<C extends Choice = Choice> {
  option: C;
  /** Matched characters of the label, for highlighting. */
  indices: number[];
}

export interface ShownGroup<C extends Choice = Choice> {
  group: ChoiceGroup<C>;
  options: Shown<C>[];
}

export const optionCount = (groups: ChoiceGroup[]): number => groups.reduce((n, g) => n + g.options.length, 0);

/** The groups as shown for a query: matches stay in their group, best first; groups with none are dropped. */
export function filterChoices<C extends Choice>(groups: ChoiceGroup<C>[], query: string): ShownGroup<C>[] {
  const out: ShownGroup<C>[] = [];
  for (const group of groups) {
    const ranked = rank(
      query,
      group.options.map((option) => ({ option, label: option.label, keywords: [...(option.meta ? [option.meta] : []), ...(option.keywords ?? [])] })),
    );
    if (ranked.length) out.push({ group, options: ranked.map((r) => ({ option: r.item.option, indices: r.match.indices })) });
  }
  return out;
}

const enabled = (shown: Shown | undefined): boolean => Boolean(shown) && !shown!.option.disabled;

/** The next choosable option from `from` in direction `delta`, wrapping; -1 when there is none. */
export function moveActive(items: Shown[], from: number, delta: 1 | -1): number {
  const n = items.length;
  if (!n) return -1;
  let i = from < 0 ? (delta > 0 ? -1 : n) : from;
  for (let step = 0; step < n; step++) {
    i = (i + delta + n) % n;
    if (enabled(items[i])) return i;
  }
  return -1;
}

/**
 * Which option is active after the list is drawn again: for a new query, its best match (the
 * first choosable one); otherwise the same option as before (a toggle redraws the list), else the
 * one chosen now, else the first choosable one. -1 when nothing can be chosen.
 */
export function activeAfter<C extends Choice>(items: Shown<C>[], opts: { query: string; queryChanged: boolean; keep: (shown: Shown<C>) => boolean }): number {
  let next = opts.queryChanged ? -1 : items.findIndex(opts.keep);
  if (next < 0 && !opts.query.trim()) next = items.findIndex((i) => i.option.selected && !i.option.disabled);
  if (next < 0 || items[next]?.option.disabled) next = moveActive(items, -1, 1);
  return next;
}

/**
 * Type-ahead: the next choosable option whose label starts with what was typed. A single
 * letter looks past the current one (pressing it again cycles); a longer prefix may stay put.
 */
export function typeahead(items: Shown[], typed: string, from: number): number {
  const prefix = typed.toLowerCase();
  const n = items.length;
  if (!n || !prefix) return -1;
  const start = from < 0 ? 0 : from + (prefix.length === 1 ? 1 : 0);
  for (let step = 0; step < n; step++) {
    const i = (start + step) % n;
    if (enabled(items[i]) && items[i]!.option.label.toLowerCase().startsWith(prefix)) return i;
  }
  return -1;
}

/** What a group of toggles has chosen, in words: none or all → `all`; one or two by name; more by count. */
export function choicesSummary(group: ChoiceGroup, all: string, words: { noun?: string; plural?: string } = {}): string {
  const on = group.options.filter((o) => o.selected);
  if (!on.length || on.length === group.options.length) return all;
  if (on.length <= 2) return on.map((o) => o.label).join(", ");
  const noun = words.noun ?? "kind";
  return `${on.length} ${words.plural ?? `${noun}s`}`;
}
