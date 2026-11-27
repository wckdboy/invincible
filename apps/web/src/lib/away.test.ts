import { describe, expect, test } from "bun:test";
import { awayShown } from "./away.ts";

const line = (text: string, tone = "warn") => ({ text, tone });

describe("while you were away", () => {
  test("the count of what needs you is said once: left out of the card where the chat's head says it already", () => {
    // (The node's away.ts says it last, in its own words, as "N things need your answer.")
    const lines = [line("3 agents' tasks ended: 2 verified, 1 didn't pass.", "danger"), line("Disk almost full"), line("9 things need your answer.")];
    expect(awayShown(lines, true).map((one) => one.text)).toEqual(["3 agents' tasks ended: 2 verified, 1 didn't pass.", "Disk almost full"]);
    expect(awayShown(lines, false)).toEqual(lines);
    expect(awayShown([line("1 thing needs your answer.")], true)).toEqual([]);
    // A notice that only reads like it stays.
    expect(awayShown([line("Your answer is needed on the 9 things in Forge")], true).map((one) => one.text)).toEqual(["Your answer is needed on the 9 things in Forge"]);
  });
});
