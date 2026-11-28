import { describe, expect, test } from "bun:test";
import { TeamTaskRouting } from "@invincible/core";
import { ESCALATION_WHYS } from "../src/index.ts";

/*
 * Smart routing's memory, by kind of task, is core's (routing.ts beginFor, its tests there): the team runtime begins a
 * task by it (the node's team-runtime tests). What the run says of work that moved up is what the record keeps of it.
 */

describe("the run and the record", () => {
  test("why work moves up is said the same in the run and in the record core keeps", () => {
    expect([...TeamTaskRouting.shape.moved.unwrap().options]).toEqual([...ESCALATION_WHYS]);
  });
});
