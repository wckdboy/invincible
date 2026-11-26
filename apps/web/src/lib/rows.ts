/*
 * Through a list's rows with the keys (the usability pass, I11): ↓ and ↑ go to the next row and the one before, Home
 * and End to the first and the last. The ends stop (nothing wraps round), and only a row's own keys are taken: from
 * anywhere else, or any other key, the page has them.
 */

/** The row the key goes to from row `at` of `count` (-1: focus is on none of them), or null: the key isn't the rows'. */
export function nextRow(count: number, at: number, key: string): number | null {
  if (count <= 0 || at < 0 || at >= count) return null;
  if (key === "ArrowDown") return Math.min(count - 1, at + 1);
  if (key === "ArrowUp") return Math.max(0, at - 1);
  if (key === "Home") return 0;
  if (key === "End") return count - 1;
  return null;
}
