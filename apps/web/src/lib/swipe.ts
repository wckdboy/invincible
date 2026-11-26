/*
 * The drawer by a finger, as the iPhone's: a swipe from the screen's left edge opens it, and one back towards that edge
 * closes it. A move is decided once it has gone far enough: mostly across, the right way, it is the swipe; mostly up or
 * down, it is a scroll and is left alone for good. (Where the system takes the edge for its own back gesture, Android's
 * or Safari's, the page never hears of it: the I-beam and "…" open the drawer there.)
 */

export interface Point {
  x: number;
  y: number;
}

/** How near the left edge a finger must touch down to open the drawer, in CSS pixels. */
export const EDGE_PX = 24;
/** How far across it must go. */
export const SWIPE_PX = 48;
/** How far up or down a move goes before it counts as a scroll. */
const SCROLL_PX = 12;

/** Whether a finger that touched down here may open the drawer. */
export const fromEdge = (at: Point): boolean => at.x <= EDGE_PX;

/** A finger's move from `from` to `to`, `way` 1 to the right and -1 to the left: true, the swipe; false, it isn't one
 * (a scroll, or the other way); null, not yet decided. */
export function swiped(from: Point, to: Point, way: 1 | -1): boolean | null {
  const across = (to.x - from.x) * way;
  const down = Math.abs(to.y - from.y);
  if (down > SCROLL_PX && down > Math.abs(to.x - from.x)) return false;
  if (across <= -SWIPE_PX) return false;
  if (across >= SWIPE_PX) return across > 1.5 * down;
  return null;
}
