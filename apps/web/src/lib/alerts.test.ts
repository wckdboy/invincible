import { describe, expect, test } from "bun:test";
import { type Connection, CONNECTION, connectionCourse, countRoll, countText, RECONNECTED_MS, stackPlaces, TOAST_GAP, TOAST_SHOWN } from "./alerts.ts";

/*
 * The toasts' stack: newest in front, the rest tucked behind it; fanned out (under the pointer, or a finger's focus),
 * each sits above the newer ones by their heights.
 */

describe("where each toast stands in the stack", () => {
  test("the newest is in front, the older ones behind it in order, each a step further back", () => {
    const places = stackPlaces([60, 80, 70]);
    expect(places.map((p) => p.depth)).toEqual([2, 1, 0]);
    expect(places.map((p) => p.z)).toEqual([98, 99, 100]);
  });

  test("fanned out, each sits above the newer ones by their heights and the gap between", () => {
    const places = stackPlaces([60, 80, 70]);
    expect(places.map((p) => p.offset)).toEqual([70 + TOAST_GAP + 80 + TOAST_GAP, 70 + TOAST_GAP, 0]);
  });

  test("only the newest three show while tucked; the rest wait behind them, hidden, until the stack fans out", () => {
    const places = stackPlaces([50, 50, 50, 50, 50]);
    expect(places.map((p) => p.hidden)).toEqual([true, true, false, false, false]);
    expect(places.filter((p) => !p.hidden)).toHaveLength(TOAST_SHOWN);
    // (However far back, a toast is drawn at the last step's depth: the hidden ones don't shrink away to nothing.)
    expect(places.map((p) => p.step)).toEqual([3, 3, 2, 1, 0]);
  });

  test("tucked, each behind is drawn as tall as the one in front, by a scale, never a new height (nothing on the page moves)", () => {
    const places = stackPlaces([40, 112, 56]);
    expect(places.map((p) => p.fit)).toEqual([56 / 40, 56 / 112, 1]);
    // (One not yet measured is left as it is.)
    expect(stackPlaces([0, 56]).map((p) => p.fit)).toEqual([1, 1]);
  });

  test("one toast alone is in front, where it is; none is no stack", () => {
    expect(stackPlaces([64])).toEqual([{ depth: 0, step: 0, offset: 0, hidden: false, z: 100, fit: 1 }]);
    expect(stackPlaces([])).toEqual([]);
  });
});

/*
 * The banner under the top bar: it says Galahad can't be reached (or that this device is offline) while that lasts,
 * and that he is reached again for a moment once he is, then goes.
 */

/** A banner's course with its clock in hand: `later()` runs what's due; `browser` is whether the device is online. */
function course({ online = true } = {}) {
  const said: (Connection | "gone")[] = [];
  const timers: { ms: number; run: () => void; off: boolean }[] = [];
  const browser = { online };
  const c = connectionCourse({
    show: (what) => void said.push(what),
    hide: () => void said.push("gone"),
    after: (ms, run) => {
      const timer = { ms, run, off: false };
      timers.push(timer);
      return () => void (timer.off = true);
    },
    offline: () => !browser.online,
  });
  const later = () => {
    for (const t of timers.splice(0)) if (!t.off) t.run();
  };
  return { c, said, timers, later, browser };
}

describe("the banner that says whether Galahad can be reached", () => {
  test("while he can, it says nothing", () => {
    const b = course();
    b.c.reach(true);
    b.c.network();
    expect(b.said).toEqual([]);
  });

  test("it says he can't be reached, or that this device is offline, as the browser stands", () => {
    const online = course();
    online.c.reach(false);
    expect(online.said).toEqual(["unreachable"]);
    const offline = course({ online: false });
    offline.c.reach(false);
    expect(offline.said).toEqual(["offline"]);
  });

  test("once he is reached again it says so for a moment, then goes", () => {
    const b = course();
    b.c.reach(false);
    b.c.reach(true);
    expect(b.said).toEqual(["unreachable", "reconnected"]);
    expect(b.timers.map((t) => t.ms)).toEqual([RECONNECTED_MS]);
    // (Told again meanwhile, it says nothing more, and still goes when its moment is up.)
    b.c.reach(true);
    b.later();
    expect(b.said).toEqual(["unreachable", "reconnected", "gone"]);
  });

  test("lost again while it says he's back: it says so, and doesn't go", () => {
    const b = course();
    b.c.reach(false);
    b.c.reach(true);
    b.c.reach(false);
    b.later();
    expect(b.said).toEqual(["unreachable", "reconnected", "unreachable"]);
  });

  test("the browser going offline, or coming back, while it is up: it says how things stand now", () => {
    const b = course();
    b.c.reach(false);
    b.browser.online = false;
    b.c.network();
    b.browser.online = true;
    b.c.network();
    expect(b.said).toEqual(["unreachable", "offline", "unreachable"]);
    // Once it says he's back, or has gone, the browser's word changes nothing.
    b.c.reach(true);
    b.browser.online = false;
    b.c.network();
    b.later();
    b.c.network();
    expect(b.said).toEqual(["unreachable", "offline", "unreachable", "reconnected", "gone"]);
  });

  test("what each says: offline is no error, can't reach him tries again, and back is good news with nothing to do", () => {
    const how = (said: Connection) => ({ tone: CONNECTION[said].tone, trying: CONNECTION[said].trying, retry: CONNECTION[said].retry });
    expect(how("offline")).toEqual({ tone: "neutral", trying: false, retry: true });
    expect(how("unreachable")).toEqual({ tone: "warn", trying: true, retry: true });
    expect(how("reconnected")).toEqual({ tone: "ok", trying: false, retry: false });
    expect(CONNECTION.reconnected.text).toBe("Reconnected");
  });
});

/*
 * A count that changes rolls to its new figure rather than jumping: up as it grows, down as it shrinks; drawn the
 * first time, or showing the same figure, it doesn't move.
 */

describe("a count's figure, and which way it rolls", () => {
  test("a count shows its number, up to 99; more is 99+", () => {
    expect([0, 1, 42, 99, 100, 1234].map(countText)).toEqual(["0", "1", "42", "99", "99+", "99+"]);
  });

  test("it rolls up as it grows and down as it shrinks", () => {
    expect(countRoll(2, 3)).toBe("up");
    expect(countRoll(10, 9)).toBe("down");
    expect(countRoll(99, 100)).toBe("up");
  });

  test("drawn the first time, or showing the same figure as before, it doesn't move", () => {
    expect(countRoll(null, 4)).toBe(null);
    expect(countRoll(4, 4)).toBe(null);
    expect(countRoll(120, 130)).toBe(null);
  });
});
