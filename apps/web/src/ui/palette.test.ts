import { describe, expect, test } from "bun:test";
import { clipTo } from "./palette.ts";

/*
 * On a phone the palette grows out of the search button that opened it: it starts clipped to that button's box, and
 * goes back into it when it closes.
 */

describe("the palette grown out of a button", () => {
  test("it starts as the button: the clip leaves only the button's box, its corners rounded like the button's", () => {
    // A 390 px phone: the palette 16 px in from each side, its field over the 44 px button at the bar's end.
    const palette = { top: 66, right: 374, bottom: 600, left: 16 };
    expect(clipTo({ top: 66, right: 374, bottom: 110, left: 330 }, palette, 8)).toBe("inset(0px 0px 490px 314px round 8px)");
  });

  test("a button reaching past the palette's edge starts it at that edge, never beyond", () => {
    const palette = { top: 66, right: 374, bottom: 600, left: 16 };
    expect(clipTo({ top: 60, right: 380, bottom: 94, left: 346 }, palette, 8)).toBe("inset(0px 0px 506px 330px round 8px)");
  });
});
