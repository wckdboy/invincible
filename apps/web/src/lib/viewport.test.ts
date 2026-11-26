import { describe, expect, test } from "bun:test";
import { closesKeyboard, keyboardOpen } from "./viewport.ts";

/*
 * iOS doesn't shrink the page for the on-screen keyboard; it shrinks only the visual
 * viewport. While you type on a touch screen and the visible part is much shorter than
 * the page, the keyboard is up: the tab bar steps aside so the composer sits on it.
 */

describe("is the on-screen keyboard up?", () => {
  test("typing on a phone with the visible part much shorter than the page: yes", () => {
    expect(keyboardOpen({ coarse: true, typing: true, fullHeight: 844, visibleHeight: 508 })).toBe(true);
  });

  test("not typing, a fine pointer, or only a browser bar sliding away: no", () => {
    expect(keyboardOpen({ coarse: true, typing: false, fullHeight: 844, visibleHeight: 508 })).toBe(false);
    expect(keyboardOpen({ coarse: false, typing: true, fullHeight: 844, visibleHeight: 508 })).toBe(false);
    expect(keyboardOpen({ coarse: true, typing: true, fullHeight: 844, visibleHeight: 790 })).toBe(false);
  });
});

// Your word, 23 November 2026: the keyboard can always be closed, so you never get stuck under it. iOS leaves it up after
// a tap on the page, so the page puts it away.
describe("does a tap close the on-screen keyboard?", () => {
  const tap = (moved: number, ms: number) => ({ from: [100, 400] as const, to: [100 + moved, 400] as const, ms });

  test("a tap on the page, on what takes no tap itself, while you type on a touch screen: yes", () => {
    expect(closesKeyboard({ coarse: true, typing: true, takesTap: false, ...tap(0, 120) })).toBe(true);
    expect(closesKeyboard({ coarse: true, typing: true, takesTap: false, ...tap(6, 300) })).toBe(true);
  });

  test("a field, a button or a link takes the tap; a drag scrolls; a long press selects; nothing typed, nothing to close", () => {
    expect(closesKeyboard({ coarse: true, typing: true, takesTap: true, ...tap(0, 120) })).toBe(false);
    expect(closesKeyboard({ coarse: true, typing: true, takesTap: false, ...tap(40, 200) })).toBe(false);
    expect(closesKeyboard({ coarse: true, typing: true, takesTap: false, ...tap(0, 900) })).toBe(false);
    expect(closesKeyboard({ coarse: true, typing: false, takesTap: false, ...tap(0, 120) })).toBe(false);
    // With a mouse, the browser closes nothing: there is no keyboard on screen.
    expect(closesKeyboard({ coarse: false, typing: true, takesTap: false, ...tap(0, 120) })).toBe(false);
  });
});
