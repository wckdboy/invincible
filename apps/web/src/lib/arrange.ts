/*
 * Your order of the knights, and who leads the Roundtable. Pure (no DOM). The node keeps both (POST /api/team/arrange,
 * yours alone) and lists the knights in your order; this says who sits where when they are shown, and what your order
 * becomes when you move a knight with a button or a drag. Galahad is in no order of yours: he sits first, or beside the
 * knight you made primary, which then comes first.
 */

/** Galahad's handle at the Roundtable (core's TEAM_GALAHAD: the app takes only types from core's team module). */
export const GALAHAD = "galahad";

/** Who leads: the knight the node names while it is still one of yours; else Galahad (an older node names none). */
export const leaderOf = (knights: readonly string[], primary: string | null | undefined): string => (primary && primary !== GALAHAD && knights.includes(primary) ? primary : GALAHAD);

/** Everyone at the table as they are shown: who leads first, Galahad next when a knight leads, then the knights in
 * your order. */
export function seating(knights: readonly string[], primary?: string | null): string[] {
  const leader = leaderOf(knights, primary);
  return leader === GALAHAD ? [GALAHAD, ...knights] : [leader, GALAHAD, ...knights.filter((id) => id !== leader)];
}

/** The knights a button or a drag moves: every one but the one who leads, which is shown first wherever it stands. */
export const movers = (order: readonly string[], primary?: string | null): string[] => {
  const leader = leaderOf(order, primary);
  return order.filter((id) => id !== leader);
};

/** Your order with `id` put at `index` among the knights that move (a drag's drop); the one who leads keeps its own
 * place in it, for when it no longer leads. The same order when `id` isn't one that moves. */
export function placed(order: readonly string[], id: string, index: number, primary?: string | null): string[] {
  const moving = movers(order, primary);
  const from = moving.indexOf(id);
  const to = Math.max(0, Math.min(moving.length - 1, Math.round(index)));
  if (from < 0 || to === from) return [...order];
  const next = moving.filter((other) => other !== id);
  next.splice(to, 0, id);
  const leader = leaderOf(order, primary);
  if (leader !== GALAHAD) next.splice(order.indexOf(leader), 0, leader);
  return next;
}

/** Whether `id` can move up (-1) or down (+1) among the knights that move. */
export function canMove(order: readonly string[], id: string, by: -1 | 1, primary?: string | null): boolean {
  const moving = movers(order, primary);
  const at = moving.indexOf(id);
  return at >= 0 && at + by >= 0 && at + by < moving.length;
}

/** Your order with `id` one place up (-1) or down (+1) among the knights that move; the same at either end. */
export const moved = (order: readonly string[], id: string, by: -1 | 1, primary?: string | null): string[] =>
  canMove(order, id, by, primary) ? placed(order, id, movers(order, primary).indexOf(id) + by, primary) : [...order];

/** Things with ids in the order given (a change not yet back from the node): those it names first, in its order; the
 * rest after them, as they came. */
export function inOrder<T extends { id: string }>(items: readonly T[], order: readonly string[]): T[] {
  const rank = (id: string): number => {
    const at = order.indexOf(id);
    return at < 0 ? order.length : at;
  };
  return items.map((item, at) => ({ item, at })).sort((a, b) => rank(a.item.id) - rank(b.item.id) || a.at - b.at).map(({ item }) => item);
}

/** Where something is on screen: its top-left corner and its size. */
export interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * Where a dragged knight would go among the others (their boxes in order, its own not among them), for the pointer at
 * (x, y). In a list ("rows"), before the first whose middle the pointer hasn't passed going down; on a board ("grid"),
 * read a row at a time: after every one in a row above the pointer's, and after those in its row whose middle it has
 * passed going right.
 */
export function dropIndex(boxes: readonly Box[], x: number, y: number, layout: "rows" | "grid"): number {
  let index = 0;
  for (const box of boxes) {
    const before = layout === "rows" ? y >= box.y + box.height / 2 : y >= box.y + box.height || (y >= box.y && x >= box.x + box.width / 2);
    if (before) index++;
  }
  return index;
}

/** The line that shows where a drop would go (`index` from dropIndex): across a list between two rows, or down a board
 * between two cards, `gap` being the space between them. Null with nothing to place it by. */
export function dropMark(boxes: readonly Box[], index: number, layout: "rows" | "grid", gap: number): Box | null {
  const at = boxes[Math.max(0, Math.min(boxes.length - 1, index))];
  if (!at) return null;
  const after = index >= boxes.length;
  const half = gap / 2;
  if (layout === "rows") return { x: at.x, y: (after ? at.y + at.height + half : at.y - half) - 1, width: at.width, height: 2 };
  return { x: (after ? at.x + at.width + half : at.x - half) - 1, y: at.y, width: 2, height: at.height };
}
