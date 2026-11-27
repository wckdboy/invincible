import { describe, expect, test } from "bun:test";
import { checkFacts, eyesSpaceOf, followsFormat, placesClicks, readModelCheck, readsScreens } from "../src/model-checks.ts";

/*
 * What a model was seen to do when it was checked: whether it follows the run loop's command format, reads a
 * screen, and points at the right place on one. Read leniently from the mind (a newer node may check more).
 */

describe("a model's check", () => {
  test("what it says, in the words the terminal and the app use", () => {
    const check = readModelCheck({ at: 1, format: { replies: 25, good: 8 }, reads: { ok: true, said: "Quarterly harbour ledger" }, places: { targets: 8, landed: 3, meanErrorPx: 140 } })!;
    expect(checkFacts(check)).toEqual(["commands in 8 of 25 replies", "reads a screen", "3 of 8 clicks land (140 px off on average)"]);
    expect([followsFormat(check), readsScreens(check), placesClicks(check)]).toEqual([false, true, false]);
    const good = readModelCheck({ at: 1, format: { replies: 6, good: 6 }, reads: { ok: false, said: "Harbour" }, places: { targets: 8, landed: 8, meanErrorPx: 4 } })!;
    expect(checkFacts(good)).toEqual(["commands in 6 of 6 replies", "misreads a screen (said: Harbour)", "8 of 8 clicks land (4 px off on average)"]);
    expect([followsFormat(good), readsScreens(good), placesClicks(good)]).toEqual([true, false, true]);
  });

  test("a part not checked is not known, and says nothing; a part that could not be done says why", () => {
    const some = readModelCheck({ at: 1, format: { replies: 5, good: 4 }, errors: ["places: 400 Invalid image or video input"] })!;
    expect([followsFormat(some), readsScreens(some), placesClicks(some)]).toEqual([true, null, null]);
    expect(checkFacts(some)).toEqual(["commands in 4 of 5 replies", "could not check places: 400 Invalid image or video input"]);
    expect([followsFormat(null), readsScreens(null), placesClicks(null)]).toEqual([null, null, null]);
  });

  test("read leniently: what a newer node added is kept, what is malformed is dropped, and nothing that isn't a check is one", () => {
    expect(readModelCheck({ at: 5, format: { replies: 3, good: 3 }, latencyMs: 900 })).toMatchObject({ at: 5, format: { replies: 3, good: 3 } });
    expect(readModelCheck({ at: 5, format: { replies: "three" }, reads: { ok: "yes" } })).toEqual({ at: 5 });
    for (const bad of [null, 7, "x", [], {}, { at: "now" }]) expect(readModelCheck(bad)).toBeNull();
  });
});

import { chooseEyes } from "../src/model-checks.ts";

describe("the space a model answers places in (C1 step 7)", () => {
  test("measured and kept: its pixels, its own 0 to 1000, or a frame of its own by a factor; said where it isn't the picture's pixels", () => {
    const thousandths = readModelCheck({ at: 1, places: { targets: 8, landed: 8, meanErrorPx: 1, space: "per-mille" } })!;
    expect(checkFacts(thousandths)).toEqual(["8 of 8 clicks land (1 px off on average), its places in 0 to 1000"]);
    expect([placesClicks(thousandths), eyesSpaceOf(thousandths)]).toEqual([true, "per-mille"]);
    const framed = readModelCheck({ at: 1, places: { targets: 8, landed: 8, meanErrorPx: 2, space: "scaled", scale: 1.3333 } })!;
    expect(checkFacts(framed)).toEqual(["8 of 8 clicks land (2 px off on average), its places in a frame of its own (×1.3333 to the screen's)"]);
    expect(eyesSpaceOf(framed)).toBe("scaled:1.3333");
    const pixels = readModelCheck({ at: 1, places: { targets: 8, landed: 8, meanErrorPx: 0, space: "pixels" } })!;
    expect([checkFacts(pixels), eyesSpaceOf(pixels)]).toEqual([["8 of 8 clicks land (0 px off on average)"], null]);
    // A check from before spaces were measured asked for pixels, and its places were judged in them.
    expect(eyesSpaceOf(readModelCheck({ at: 1, places: { targets: 8, landed: 8, meanErrorPx: 3 } })!)).toBeNull();
  });

  test("a space that isn't one, or a frame with no factor it could be, makes its places no measure at all", () => {
    for (const places of [{ space: "inches" }, { space: "scaled" }, { space: "scaled", scale: 40 }, { space: "pixels", scale: 2 }]) {
      expect(readModelCheck({ at: 1, places: { targets: 8, landed: 8, meanErrorPx: 1, ...places } })!.places).toBeUndefined();
    }
  });
});

describe("an agent's eyes", () => {
  const check = (landed: number, off: number, reads = true) => ({ at: 1, reads: { ok: reads, said: "x" }, places: { targets: 8, landed, meanErrorPx: off } });
  const checks = [
    { ref: "go/qwen", check: check(1, 140) },
    { ref: "go/luna", check: check(8, 6) },
    { ref: "other/sharp", check: check(8, 2) },
    { ref: "go/blurry", check: check(8, 1, false) },
  ];
  test("the first model named for the role that can be used; none usable, none", () => {
    expect(chooseEyes(["other/sharp", "go/luna"], checks, (ref) => ref.startsWith("go/"))).toBe("go/luna");
    expect(chooseEyes(["other/sharp"], checks, (ref) => ref.startsWith("go/"))).toBeNull();
  });
  test("none named: the checked model whose clicks all land and that reads the screen, nearest the mark, among those that can be used", () => {
    expect(chooseEyes([], checks, () => true)).toBe("other/sharp");
    expect(chooseEyes([], checks, (ref) => ref.startsWith("go/"))).toBe("go/luna");
    expect(chooseEyes([], checks.slice(0, 1), () => true)).toBeNull();
    expect(chooseEyes([], [], () => true)).toBeNull();
  });
});
