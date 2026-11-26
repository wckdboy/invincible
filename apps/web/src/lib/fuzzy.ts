/*
 * Fuzzy matching for the command palette: every query character must appear in
 * order. Consecutive runs, word starts and an exact prefix score higher, so
 * "nc" finds "New chat" before "Invite a machine".
 */

export interface FuzzyMatch {
  score: number;
  /** Indices into the text that matched, for highlighting. */
  indices: number[];
}

const isWordStart = (text: string, i: number): boolean => i === 0 || /[\s/_.:-]/.test(text[i - 1]!) || (/[a-z]/.test(text[i - 1]!) && /[A-Z]/.test(text[i]!));

export function fuzzyMatch(query: string, text: string): FuzzyMatch | null {
  const q = query.trim().toLowerCase();
  if (!q) return { score: 0, indices: [] };
  const t = text.toLowerCase();
  const indices: number[] = [];
  let score = 0;
  let from = 0;
  let previous = -2;
  for (const ch of q) {
    if (ch === " ") continue;
    // Prefer the next occurrence that starts a word, else the next occurrence at all.
    let at = -1;
    for (let i = t.indexOf(ch, from); i >= 0; i = t.indexOf(ch, i + 1)) {
      if (i === previous + 1 || isWordStart(text, i)) {
        at = i;
        break;
      }
      if (at < 0) at = i;
    }
    if (at < 0) return null;
    score += 1;
    if (at === previous + 1) score += 3;
    if (isWordStart(text, at)) score += 2;
    if (at === 0) score += 2;
    indices.push(at);
    previous = at;
    from = at + 1;
  }
  if (t.startsWith(q)) score += 6;
  else if (t.includes(q)) score += 3;
  score -= Math.min(text.length, 60) / 60; // shorter labels win ties
  return { score, indices };
}

export interface Searchable {
  label: string;
  keywords?: string[];
}

/** Best match over the label and keywords; keyword matches rank a little lower. */
export function scoreItem(query: string, item: Searchable): FuzzyMatch | null {
  const main = fuzzyMatch(query, item.label);
  let best = main;
  for (const keyword of item.keywords ?? []) {
    const m = fuzzyMatch(query, keyword);
    if (m && (!best || m.score - 1 > best.score)) best = { score: m.score - 1, indices: [] };
  }
  return best;
}

export function rank<T extends Searchable>(query: string, items: T[]): { item: T; match: FuzzyMatch }[] {
  const out: { item: T; match: FuzzyMatch; order: number }[] = [];
  items.forEach((item, order) => {
    const match = scoreItem(query, item);
    if (match) out.push({ item, match, order });
  });
  if (query.trim()) out.sort((a, b) => b.match.score - a.match.score || a.order - b.order);
  return out;
}
