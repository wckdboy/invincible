import { describe, expect, test } from "bun:test";
import { lookedWords, lookWords, nextLookMs, taskWords, whenWords } from "./underway.ts";

/* What is under way in a chat, in words (views/underway.ts draws it): his knights' tasks there, his looks that wait. */

const T = Date.parse("2026-11-24T20:07:31Z");

describe("what is under way in a chat", () => {
  test("a time is the time of day today, with its day on another", () => {
    expect(whenWords(T + 2 * 3_600_000, T, "Europe/Copenhagen")).toBe("23:07");
    expect(whenWords(Date.parse("2026-11-25T08:00:00Z"), T, "Europe/Copenhagen")).toBe("Wed 25 Nov, 09:00");
  });

  test("a task: its knight, how it stands (its first line of progress, or at work; waiting its turn while queued), what it is", () => {
    expect(taskWords({ name: "Gareth", status: "running", title: "The importer's tests", progress: "" })).toEqual({ who: "Gareth", state: "at work", what: "The importer's tests" });
    expect(taskWords({ name: "Gareth", status: "running", title: "x", progress: "12 commands · running bun test\nmore" }).state).toBe("12 commands · running bun test");
    expect(taskWords({ name: "Ada", status: "queued", title: "x", progress: "" }).state).toBe("waiting its turn");
  });

  test("a look: when he looks again and at what; come back, as his own note", () => {
    expect(lookWords({ at: T + 2 * 3_600_000, note: "Is the site live?" }, T, "Europe/Copenhagen")).toBe("Looking again at 23:07: Is the site live?");
    expect(lookedWords({ set: T, note: "Is the site live?" }, T + 3_600_000, "Europe/Copenhagen")).toBe("He looked again, as he said at 21:07 he would: Is the site live?");
  });

  test("asked again every few seconds while a task is under way or he is answering, else every half minute", () => {
    expect(nextLookMs({ tasks: 1, looks: [] }, false, T)).toBe(5_000);
    expect(nextLookMs({ tasks: 0, looks: [T + 3_600_000] }, true, T)).toBe(5_000);
    expect(nextLookMs({ tasks: 0, looks: [T + 3_600_000, T + 7_200_000] }, false, T)).toBe(30_000);
    expect(nextLookMs({ tasks: 0, looks: [] }, false, T)).toBe(30_000);
  });

  test("a look's row goes when it comes: asked just after it comes due, then every few seconds until the node takes it", () => {
    // Its turn starts within the node's tick of it coming due, and the look is gone from the row then: never half a
    // minute of a Cancel on a look he has already taken.
    expect(nextLookMs({ tasks: 0, looks: [T + 3_600_000, T + 12_000] }, false, T)).toBe(13_000);
    expect(nextLookMs({ tasks: 0, looks: [T + 12_000] }, false, T + 12_000)).toBe(5_000);
    expect(nextLookMs({ tasks: 0, looks: [T + 12_000] }, false, T + 20_000)).toBe(5_000);
  });
});
