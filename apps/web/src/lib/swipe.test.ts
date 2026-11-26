import { describe, expect, test } from "bun:test";
import { EDGE_PX, fromEdge, swiped, SWIPE_PX } from "./swipe.ts";

/* The drawer by a finger, as the iPhone's: a swipe from the left edge opens it, one back towards the edge closes it. */

describe("a swipe", () => {
  test("only a finger that touched down at the screen's left edge can open the drawer", () => {
    expect(fromEdge({ x: 0, y: 300 })).toBe(true);
    expect(fromEdge({ x: EDGE_PX, y: 300 })).toBe(true);
    expect(fromEdge({ x: EDGE_PX + 1, y: 300 })).toBe(false);
  });

  test("far enough across, mostly across, is the swipe", () => {
    expect(swiped({ x: 4, y: 300 }, { x: 4 + SWIPE_PX, y: 310 }, 1)).toBe(true);
    expect(swiped({ x: 300, y: 300 }, { x: 300 - SWIPE_PX, y: 296 }, -1)).toBe(true);
  });

  test("not yet far enough: not decided", () => {
    expect(swiped({ x: 4, y: 300 }, { x: 30, y: 302 }, 1)).toBeNull();
  });

  test("mostly up or down is a scroll, and stays one", () => {
    expect(swiped({ x: 4, y: 300 }, { x: 20, y: 340 }, 1)).toBe(false);
    expect(swiped({ x: 300, y: 300 }, { x: 290, y: 200 }, -1)).toBe(false);
  });

  test("the other way is not the swipe", () => {
    expect(swiped({ x: 100, y: 300 }, { x: 100 - SWIPE_PX - 10, y: 300 }, 1)).toBe(false);
    expect(swiped({ x: 100, y: 300 }, { x: 100 + SWIPE_PX + 10, y: 300 }, -1)).toBe(false);
  });
});
