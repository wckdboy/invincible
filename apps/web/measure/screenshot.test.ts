import { describe, expect, test } from "bun:test";
import { NoScreenshot, screenshot } from "./screenshot.ts";

/** A Page.captureScreenshot that answers as each of `answers` says, in turn: a picture, Chrome's refusal, or nothing ever. */
function chrome(...answers: ("picture" | "refused" | "never")[]) {
  const asked: number[] = [];
  const said: string[] = [];
  /** Each ask's signal: one given up on is aborted, so the asker forgets it. */
  const signals: AbortSignal[] = [];
  const capture = (signal: AbortSignal): Promise<{ data: string }> => {
    asked.push(asked.length + 1);
    signals.push(signal);
    const answer = answers[asked.length - 1] ?? "never";
    if (answer === "picture") return Promise.resolve({ data: `picture ${asked.length}` });
    if (answer === "refused") return Promise.reject(new Error("Unable to capture screenshot"));
    return new Promise(() => {});
  };
  return { asked, said, signals, capture, say: (line: string) => void said.push(line) };
}

describe("a screenshot is never waited for forever (28 November 2026: one waited 30 minutes, silent)", () => {
  test("one that comes is taken, and nothing is said", async () => {
    const c = chrome("picture");
    expect(await screenshot(c.capture, "inbox-390-light", { ms: 20, say: c.say })).toBe("picture 1");
    expect(c.asked.length).toBe(1);
    expect(c.said).toEqual([]);
  });

  test("one that doesn't come is asked for once more, and that is said", async () => {
    const c = chrome("never", "picture");
    expect(await screenshot(c.capture, "inbox-390-light", { ms: 20, say: c.say })).toBe("picture 2");
    expect(c.asked.length).toBe(2);
    expect(c.said).toEqual(["inbox-390-light: no screenshot came in 0.02 s; asking once more"]);
    // (The ask that got no answer is given up, so its asker forgets it; the one answered is not.)
    expect(c.signals.map((signal) => signal.aborted)).toEqual([true, false]);
  });

  test("one that doesn't come twice fails, saying which it was, and is asked for no more", async () => {
    const c = chrome("never", "never", "picture");
    const taking = screenshot(c.capture, "inbox-390-light", { ms: 20, say: c.say });
    await expect(taking).rejects.toThrow("inbox-390-light: no screenshot came in 0.02 s, twice: not taken");
    // (Its own kind, so a caller goes on without it and lets any other failure be what it was.)
    await expect(taking).rejects.toBeInstanceOf(NoScreenshot);
    expect(c.asked.length).toBe(2);
    expect(c.signals.map((signal) => signal.aborted)).toEqual([true, true]);
    expect(c.said).toEqual(["inbox-390-light: no screenshot came in 0.02 s; asking once more"]);
  });

  test("Chrome's own refusal fails it at once: only silence is asked again", async () => {
    const c = chrome("refused", "picture");
    const taking = screenshot(c.capture, "inbox-390-light", { ms: 20, say: c.say });
    await expect(taking).rejects.toThrow("Unable to capture screenshot");
    await expect(taking).rejects.not.toBeInstanceOf(NoScreenshot);
    expect(c.asked.length).toBe(1);
    expect(c.said).toEqual([]);
  });
});
