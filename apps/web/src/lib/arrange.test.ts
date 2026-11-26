import { expect, test } from "bun:test";
import { PRIMARY, seating } from "./arrange.ts";

test("everyone at the table as shown: your agent first, then the agents as the node lists them", () => {
  expect(seating(["ada", "lin"])).toEqual([PRIMARY, "ada", "lin"]);
  expect(seating([])).toEqual([PRIMARY]);
});
