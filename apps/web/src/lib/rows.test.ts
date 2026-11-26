import { describe, expect, test } from "bun:test";
import { nextRow } from "./rows.ts";

/* The usability pass (I11): the arrow keys go through a list's rows, as they do through a menu. */

describe("the arrow keys through a list's rows", () => {
  test("↓ and ↑ go to the next row and the one before; the ends stop, nothing wraps round", () => {
    expect(nextRow(4, 0, "ArrowDown")).toBe(1);
    expect(nextRow(4, 2, "ArrowUp")).toBe(1);
    expect(nextRow(4, 3, "ArrowDown")).toBe(3);
    expect(nextRow(4, 0, "ArrowUp")).toBe(0);
  });

  test("Home and End go to the first and the last", () => {
    expect(nextRow(4, 2, "Home")).toBe(0);
    expect(nextRow(4, 1, "End")).toBe(3);
  });

  test("only from a row, and only these keys: anything else is left to the page", () => {
    expect(nextRow(4, -1, "ArrowDown")).toBeNull();
    expect(nextRow(4, -1, "Home")).toBeNull();
    expect(nextRow(4, 1, "Enter")).toBeNull();
    expect(nextRow(4, 1, "ArrowRight")).toBeNull();
    expect(nextRow(0, 0, "ArrowDown")).toBeNull();
  });
});
