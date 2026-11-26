/*
 * Hybrid search, the pure parts. Two rankings of passages, one by their words (SQLite
 * FTS5's BM25) and one by their meaning (cosine similarity of embeddings), each reduced
 * to entries (an entry ranks where its best passage does) and fused by reciprocal rank
 * (RRF: Σ 1/(k + rank)). RRF needs no calibration between the two scores, which live on
 * different scales, and an entry both rankings like rises above one only one likes.
 */

/** The usual constant (Cormack, Clarke & Büttcher, 2009): damps the head of each list. */
export const RRF_K = 60;

/** Words too common to say what a passage is about (English and Danish). */
const STOP = new Set(
  "a an and are as at be but by can did do does for from had has have how i if in into is it its me my no not of on or our so than that the their them then there these they this to was we were what when where which who why will with would you your about after again all also any been before being both could each few more most other over own same some such only very just should now og i jeg det at en den til er som på de med han af for ikke der var mig sig men et har om vi min havde ham hun nu over da fra du ud sin dem os op man hans hvor eller hvad skal selv her alle vil blev kunne ind når være dog noget ville jo deres efter ned skulle denne end dette mit også under have dig anden hende mine alt meget sit sine vor mod disse hvis din nogle hos blive mange ad bliver hendes været thi jer sådan".split(
    " ",
  ),
);

/** A query's distinct search terms: letters and digits, lowercased, without stop words (unless that's all there is). */
export function queryTerms(query: string): string[] {
  const all = [...new Set((query.toLowerCase().match(/[\p{L}\p{N}_]+/gu) ?? []).filter((t) => t.length <= 64))];
  const meaningful = all.filter((t) => !STOP.has(t) && (t.length > 1 || /\d/.test(t)));
  return (meaningful.length ? meaningful : all).slice(0, 32);
}

/** An FTS5 MATCH expression: each term as a quoted prefix, any of them. Quoting makes every term inert (no FTS syntax from a query). */
export const ftsQuery = (terms: string[]): string => terms.map((t) => `"${t.replace(/"/g, "")}"*`).join(" OR ");

/** How many of the terms a passage contains (as a word's beginning, as FTS5 matches them). */
export function matchedTerms(text: string, terms: string[]): number {
  const words = new Set((text.toLowerCase().match(/[\p{L}\p{N}_]+/gu) ?? []).map((w) => w));
  let n = 0;
  for (const term of terms) {
    for (const word of words) {
      if (word.startsWith(term)) {
        n++;
        break;
      }
    }
  }
  return n;
}

export interface Ranked {
  entry: number;
  chunk: number;
}

/**
 * Fuse ranked passage lists into ranked entries. Each list is reduced to its entries'
 * first (best) appearance; an entry's score is Σ over lists of 1/(k + rank), rank from 1.
 * Ties keep the order of the first list. Returns, per entry, its score, its best passage
 * in each list, and which lists found it.
 */
export function fuse(lists: Ranked[][], k = RRF_K): { entry: number; score: number; best: number[]; found: number[] }[] {
  const out = new Map<number, { entry: number; score: number; best: number[]; found: number[]; order: number }>();
  let order = 0;
  lists.forEach((list, which) => {
    const seen = new Set<number>();
    let rank = 0;
    for (const item of list) {
      if (seen.has(item.entry)) continue;
      seen.add(item.entry);
      rank++;
      const hit = out.get(item.entry) ?? { entry: item.entry, score: 0, best: lists.map(() => -1), found: [], order: order++ };
      hit.score += 1 / (k + rank);
      hit.best[which] = item.chunk;
      hit.found.push(which);
      out.set(item.entry, hit);
    }
  });
  return [...out.values()].sort((a, b) => b.score - a.score || a.order - b.order).map(({ order: _, ...hit }) => hit);
}

/** A passage cut to its most relevant part: around the first term it contains, without the title line it was given. */
export function snippet(text: string, terms: string[], max = 320): string {
  const body = text.includes("\n") ? text.slice(text.indexOf("\n") + 1) : text;
  const flat = body.replace(/\s+/g, " ").trim();
  if (flat.length <= max) return flat;
  const lower = flat.toLowerCase();
  const at = terms.map((t) => lower.indexOf(t)).filter((i) => i >= 0).sort((a, b) => a - b)[0] ?? 0;
  const start = Math.max(0, Math.min(at - Math.floor(max / 3), flat.length - max));
  const cut = flat.slice(start, start + max);
  return `${start > 0 ? "…" : ""}${cut.trim()}${start + max < flat.length ? "…" : ""}`;
}
