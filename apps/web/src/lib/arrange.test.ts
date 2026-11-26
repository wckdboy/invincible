import { describe, expect, test } from "bun:test";
import { type Box, canMove, dropIndex, dropMark, GALAHAD, inOrder, leaderOf, moved, movers, placed, seating } from "./arrange.ts";

const ORDER = ["ada", "lin", "kay", "bors"];

describe("who leads, and where everyone sits", () => {
  test("Galahad leads unless the node names one of your knights; a name that is no knight of yours is Galahad's lead", () => {
    expect(leaderOf(ORDER, undefined)).toBe(GALAHAD);
    expect(leaderOf(ORDER, "galahad")).toBe(GALAHAD);
    expect(leaderOf(ORDER, "lin")).toBe("lin");
    // (A knight removed since, or an older node's snapshot.)
    expect(leaderOf(ORDER, "percival")).toBe(GALAHAD);
    expect(leaderOf([], "lin")).toBe(GALAHAD);
  });

  test("who leads comes first, Galahad next when a knight leads, then the knights in your order", () => {
    expect(seating(ORDER)).toEqual(["galahad", "ada", "lin", "kay", "bors"]);
    expect(seating(ORDER, "galahad")).toEqual(["galahad", "ada", "lin", "kay", "bors"]);
    expect(seating(ORDER, "kay")).toEqual(["kay", "galahad", "ada", "lin", "bors"]);
    expect(seating(ORDER, "ada")).toEqual(["ada", "galahad", "lin", "kay", "bors"]);
    expect(seating([], "kay")).toEqual(["galahad"]);
  });
});

describe("moving a knight", () => {
  test("up or down one place, and not past either end", () => {
    expect(moved(ORDER, "kay", -1)).toEqual(["ada", "kay", "lin", "bors"]);
    expect(moved(ORDER, "kay", 1)).toEqual(["ada", "lin", "bors", "kay"]);
    expect(moved(ORDER, "ada", -1)).toEqual(ORDER);
    expect(moved(ORDER, "bors", 1)).toEqual(ORDER);
    expect([canMove(ORDER, "ada", -1), canMove(ORDER, "ada", 1), canMove(ORDER, "bors", 1), canMove(ORDER, "bors", -1)]).toEqual([false, true, false, true]);
  });

  test("the one who leads is shown first, so it doesn't move; the others step past it, and it keeps its place in your order", () => {
    // Lin leads: shown are lin, galahad, then ada, kay, bors. Moving kay up puts it before ada.
    expect(movers(ORDER, "lin")).toEqual(["ada", "kay", "bors"]);
    expect(moved(ORDER, "kay", -1, "lin")).toEqual(["kay", "lin", "ada", "bors"]);
    expect(moved(ORDER, "ada", 1, "lin")).toEqual(["kay", "lin", "ada", "bors"]);
    expect(canMove(ORDER, "lin", -1, "lin")).toBe(false);
    expect(canMove(ORDER, "lin", 1, "lin")).toBe(false);
    expect(moved(ORDER, "lin", 1, "lin")).toEqual(ORDER);
    // Galahad is in no order of yours.
    expect(canMove(ORDER, GALAHAD, 1)).toBe(false);
    expect(moved(ORDER, GALAHAD, 1)).toEqual(ORDER);
  });

  test("dropped anywhere among the ones that move (a drag), held to the ends", () => {
    expect(placed(ORDER, "bors", 0)).toEqual(["bors", "ada", "lin", "kay"]);
    expect(placed(ORDER, "ada", 2)).toEqual(["lin", "kay", "ada", "bors"]);
    expect(placed(ORDER, "ada", 99)).toEqual(["lin", "kay", "bors", "ada"]);
    expect(placed(ORDER, "kay", -5)).toEqual(["kay", "ada", "lin", "bors"]);
    expect(placed(ORDER, "kay", 2)).toEqual(ORDER);
    expect(placed(ORDER, "percival", 0)).toEqual(ORDER);
    // With Kay leading, Bors dropped first among the others: Kay stays where it stood in your order.
    expect(placed(ORDER, "bors", 0, "kay")).toEqual(["bors", "ada", "kay", "lin"]);
    expect(seating(placed(ORDER, "bors", 0, "kay"), "kay")).toEqual(["kay", "galahad", "bors", "ada", "lin"]);
  });

  test("a new order is shown at once, before the node has it: the things it names in its order, the rest after as they were", () => {
    const knights = ["ada", "lin", "kay", "gareth"].map((id) => ({ id }));
    expect(inOrder(knights, ["kay", "ada"]).map((knight) => knight.id)).toEqual(["kay", "ada", "lin", "gareth"]);
    expect(inOrder(knights, []).map((knight) => knight.id)).toEqual(["ada", "lin", "kay", "gareth"]);
    expect(inOrder(knights, ["percival", "gareth"]).map((knight) => knight.id)).toEqual(["gareth", "ada", "lin", "kay"]);
  });
});

describe("where a drag would drop", () => {
  // A list: rows 48 tall, 2 apart. A board: cards 200 wide and 260 tall, 12 apart, three to a row.
  const rows: Box[] = [0, 1, 2].map((i) => ({ x: 0, y: i * 50, width: 220, height: 48 }));
  const cards: Box[] = [0, 1, 2, 3, 4].map((i) => ({ x: (i % 3) * 212, y: Math.floor(i / 3) * 272, width: 200, height: 260 }));

  test("in a list: before the first row whose middle the pointer hasn't passed", () => {
    expect(dropIndex(rows, 100, -10, "rows")).toBe(0);
    expect(dropIndex(rows, 100, 20, "rows")).toBe(0);
    expect(dropIndex(rows, 100, 30, "rows")).toBe(1);
    expect(dropIndex(rows, 5, 126, "rows")).toBe(3);
    expect(dropIndex(rows, 100, 400, "rows")).toBe(3);
  });

  test("on a board, a row at a time: after the rows above, and after the cards in its row whose middle it has passed", () => {
    expect(dropIndex(cards, 10, 10, "grid")).toBe(0);
    expect(dropIndex(cards, 150, 10, "grid")).toBe(1);
    expect(dropIndex(cards, 590, 10, "grid")).toBe(3);
    // In the gap under the first row: after it, before the second.
    expect(dropIndex(cards, 300, 266, "grid")).toBe(3);
    expect(dropIndex(cards, 330, 300, "grid")).toBe(5);
    expect(dropIndex(cards, 50, 300, "grid")).toBe(3);
    expect(dropIndex(cards, 50, 900, "grid")).toBe(5);
  });

  test("the line that shows it: between two rows across a list, between two cards down a board, after the last at the end", () => {
    expect(dropMark(rows, 1, "rows", 2)).toEqual({ x: 0, y: 48, width: 220, height: 2 });
    expect(dropMark(rows, 3, "rows", 2)).toEqual({ x: 0, y: 148, width: 220, height: 2 });
    expect(dropMark(cards, 1, "grid", 12)).toEqual({ x: 205, y: 0, width: 2, height: 260 });
    expect(dropMark(cards, 5, "grid", 12)).toEqual({ x: 417, y: 272, width: 2, height: 260 });
    expect(dropMark([], 0, "rows", 2)).toBeNull();
  });
});
