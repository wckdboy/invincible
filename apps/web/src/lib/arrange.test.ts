import { expect, test } from "bun:test";
import { GALAHAD, seating } from "./arrange.ts";

test("everyone at the table as shown: Galahad first, then the knights as the node lists them", () => {
  expect(seating(["ada", "lin"])).toEqual([GALAHAD, "ada", "lin"]);
  expect(seating([])).toEqual([GALAHAD]);
});
