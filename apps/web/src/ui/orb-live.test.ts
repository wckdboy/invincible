import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { seat, workerAvatar } from "./avatar.ts";
import { knightFace, orb } from "./orb.ts";

/*
 * The orbs on a canvas (26 November 2026: Galahad's field, and each knight's), drawn on one that records what is drawn
 * on it, without a browser: light added to light on a dark page, ink on a light one; still where they are many, where
 * motion is reduced, and once a knight has come to rest; moving slowly where they are looked at.
 */

/** A 2D context that keeps the name of every call made on it, and every blend it is set to. */
function context(calls: string[], blends: string[]): CanvasRenderingContext2D {
  return new Proxy({} as Record<string, unknown>, {
    get(target, key) {
      if (typeof key !== "string") return undefined;
      if (key in target) return target[key];
      return () => {
        calls.push(key);
      };
    },
    set(target, key, value) {
      if (key === "globalCompositeOperation") blends.push(String(value));
      target[key as string] = value;
      return true;
    },
  }) as unknown as CanvasRenderingContext2D;
}

class Node_ {
  readonly attrs: Record<string, string> = {};
  readonly children: Node_[] = [];
  readonly style: Record<string, string> = {};
  readonly calls: string[] = [];
  readonly blends: string[] = [];
  className = "";
  width = 0;
  height = 0;
  isConnected = true;
  constructor(readonly tag: string) {
    made.push(this);
  }
  setAttribute(key: string, value: string) { this.attrs[key] = value; }
  appendChild(child: Node_) { this.children.push(child); return child; }
  addEventListener() {}
  getContext(kind: string) { return this.tag === "canvas" && kind === "2d" ? context(this.calls, this.blends) : null; }
}

let frames: FrameRequestCallback[] = [];
/** Frames asked for since the test began. */
let asked = 0;
let timers: { at: number; callback: () => void; id: number }[] = [];
let clock = 0;
let ids = 0;
let made: Node_[] = [];
/** What the page's theme watcher was given (ui/orb.ts installs it once, with the first orb it draws). */
let themeWatcher: (() => void) | null = null;
/** Runs, at `ms`, the timers due by then and then the frames asked for. */
const run = (ms: number) => {
  clock = ms;
  for (const timer of timers.filter((timer) => timer.at <= ms)) {
    timers = timers.filter((other) => other !== timer);
    timer.callback();
  }
  for (const frame of frames.splice(0)) frame(ms);
};
const root = { dataset: {} as Record<string, string> };
const saved = new Map<string, PropertyDescriptor | undefined>();
function stub(name: string, value: unknown) {
  saved.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
  Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
}
beforeEach(() => {
  made = [];
  asked = 0;
  clock = 0;
  root.dataset = { theme: "dark" };
  stub("document", {
    createElement: (tag: string) => new Node_(tag),
    createElementNS: (_: string, tag: string) => new Node_(tag),
    createTextNode: () => new Node_("#text"),
    documentElement: root,
    hidden: false,
    getElementById: () => ({}),
    addEventListener() {},
  });
  stub("window", { devicePixelRatio: 2 });
  stub("matchMedia", () => ({ matches: false, addEventListener() {} }));
  // (The page's clock watches the motion setting the same way: the theme's watcher is the one watching data-theme.)
  stub("MutationObserver", class {
    constructor(readonly callback: () => void) {}
    observe(_: unknown, options: { attributeFilter?: string[] }) {
      if (options.attributeFilter?.includes("data-theme")) themeWatcher ??= this.callback;
    }
  });
  stub("requestAnimationFrame", (callback: FrameRequestCallback) => (asked++, frames.push(callback)));
  // (A page's frames and its clock tell the same time, as a browser's do: an orb's course is kept by it.)
  stub("performance", { now: () => clock });
  // (The clock waits by a timer for a frame that isn't due yet. As a browser does, a delay that isn't a finite number
  // of ms is none.)
  stub("setTimeout", (callback: () => void, ms?: number) => {
    timers.push({ at: clock + (Number.isFinite(ms) ? Math.max(0, ms!) : 0), callback, id: ++ids });
    return ids;
  });
  stub("clearTimeout", (id: number) => (timers = timers.filter((timer) => timer.id !== id)));
});
afterEach(() => {
  // Everything drawn leaves the page, and the page's clock, with nothing left on it, stops.
  for (const node of made) node.isConnected = false;
  for (let i = 0; i < 300 && (frames.length || timers.length); i++) run(60_000 + 20 * i);
  expect([frames, timers]).toEqual([[], []]);
  for (const [name, descriptor] of saved) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else Reflect.deleteProperty(globalThis, name);
  }
  saved.clear();
});

const canvasOf = (node: Node_) => node.children.find((child) => child.tag === "canvas");
const canvasIn = (node: Node_): Node_ | undefined => (node.tag === "canvas" ? node : node.children.map(canvasIn).find(Boolean));
const count = (calls: string[], name: string) => calls.filter((call) => call === name).length;

describe("his orb", () => {
  test("in a mood, a canvas its own size, sharp on the screen: his field added as light, then his ring and seat", () => {
    const drawn = orb({ size: 168, mood: "working", label: "Galahad: at work", key: "test:sharp" }) as unknown as Node_;
    expect(drawn.attrs.class).toBe("orb orb-live");
    expect([drawn.attrs["data-mood"], drawn.attrs.role, drawn.attrs["aria-label"]]).toEqual(["working", "img", "Galahad: at work"]);
    const canvas = canvasOf(drawn)!;
    // Nothing reaches past it: its canvas is its own square, at twice the pixels on this screen.
    expect([canvas.className, canvas.style.width, canvas.width, canvas.attrs["aria-hidden"]]).toEqual(["orb-canvas", "168px", 336, "true"]);
    // Drawn at once, so it never shows empty: its lines as strokes (a few dozen, gathered by colour, a glow and a line
    // each), added as light; then his five arcs and his seat.
    expect(canvas.blends).toContain("lighter");
    expect(count(canvas.calls, "stroke")).toBeGreaterThan(10);
    expect(count(canvas.calls, "stroke")).toBeLessThan(400);
    expect(count(canvas.calls, "arc")).toBeGreaterThanOrEqual(6);
    // Then a frame at a time.
    expect(frames.length).toBeGreaterThan(0);
  });

  test("on a light page, ink: nothing is added as light", () => {
    root.dataset.theme = "light";
    const canvas = canvasOf(orb({ size: 50, mood: "idle", key: "test:paper" }) as unknown as Node_)!;
    expect(canvas.blends).not.toContain("lighter");
    expect(count(canvas.calls, "stroke")).toBeGreaterThan(5);
  });

  test("still where motion is reduced: drawn once, and nothing more", () => {
    root.dataset.motion = "reduce";
    const canvas = canvasOf(orb({ size: 168, mood: "working", key: "test:still" }) as unknown as Node_)!;
    const before = canvas.calls.length;
    expect(before).toBeGreaterThan(0);
    run(1000);
    run(2000);
    expect(canvas.calls.length).toBe(before);
    expect(frames).toEqual([]);
  });

  test("without a mood (a row, the history), still: drawn once; the same orb again is stamped from one picture", () => {
    const [a, b] = [orb({ size: 28 }), orb({ size: 28 })].map((node) => canvasOf(node as unknown as Node_)!) as [Node_, Node_];
    // Each stamped from one picture, drawn once in its own canvas.
    expect([count(a.calls, "drawImage"), count(b.calls, "drawImage"), count(a.calls, "stroke"), count(b.calls, "stroke")]).toEqual([1, 1, 0, 0]);
    expect(made.filter((node) => node.tag === "canvas" && count(node.calls, "stroke") > 0)).toHaveLength(1);
    run(1000);
    run(2000);
    expect(frames).toEqual([]);
  });

  test("with no canvas to draw on, his ring in SVG", () => {
    stub("window", undefined);
    expect((orb({ size: 28, mood: "working" }) as unknown as Node_).children[0]!.tag).toBe("svg");
  });

  test("on screen it moves a frame at a time at its pace, and once off the page it is forgotten", () => {
    const canvas = canvasOf(orb({ size: 36, mood: "working", key: "test:frames" }) as unknown as Node_)!;
    const first = canvas.calls.length;
    run(5000);
    expect(canvas.calls.length).toBeGreaterThan(first);
    // (A frame sooner than its next is due draws nothing: at work it is drawn at 30 a second.)
    const drawn = canvas.calls.length;
    run(5010);
    expect(canvas.calls.length).toBe(drawn);
    run(5034);
    expect(canvas.calls.length).toBeGreaterThan(drawn);
    canvas.isConnected = false;
    const gone = canvas.calls.length;
    run(6000);
    run(6100);
    expect(canvas.calls.length).toBe(gone);
  });

  test("one made before it is put on the page is looked for ten times a second, not at every frame, and forgotten after five", () => {
    const canvas = canvasOf(orb({ size: 36, mood: "working", key: "test:unplaced" }) as unknown as Node_)!;
    canvas.isConnected = false;
    const before = asked;
    for (let ms = 1000; ms < 2000; ms += 1000 / 60) run(ms);
    expect(asked - before).toBeWithin(8, 13);
    canvas.isConnected = true;
    const drawn = canvas.calls.length;
    for (let ms = 2000; ms < 3000; ms += 1000 / 60) run(ms);
    expect(canvas.calls.length).toBeGreaterThan(drawn);
    const other = canvasOf(orb({ size: 36, mood: "working", key: "test:never" }) as unknown as Node_)!;
    other.isConnected = false;
    canvas.isConnected = false;
    for (let ms = 3000; ms < 9000; ms += 1000 / 60) run(ms);
    expect([frames, timers]).toEqual([[], []]);
  });

  test("a change of theme draws every orb on the page again, in the new one", () => {
    const canvas = canvasOf(orb({ size: 34, key: "test:theme" }) as unknown as Node_)!;
    expect(themeWatcher).not.toBeNull();
    const drawn = canvas.calls.length;
    root.dataset.theme = "light";
    themeWatcher!();
    expect(canvas.calls.length).toBeGreaterThan(drawn);
    // (Stamped from the light page's picture: drawn anew, with no light added in it.)
    const pictures = made.filter((node) => node.tag === "canvas" && count(node.calls, "stroke") > 0);
    expect(pictures.at(-1)!.blends).not.toContain("lighter");
  });
});

describe("a knight's face", () => {
  test("still unless it works: at rest, in a row or in the history, drawn once and never asking for a frame", () => {
    for (const face of [knightFace({ id: "gareth", size: 34, mood: "idle", key: "test:idle" }), knightFace({ id: "gareth", size: 34 }), workerAvatar({ id: "gareth", name: "Gareth", still: true })]) {
      const canvas = canvasIn(face as unknown as Node_)!;
      expect([canvas.className, count(canvas.calls, "drawImage")]).toEqual(["knight-orb-canvas", 1]);
    }
    const before = asked;
    run(1000);
    run(2000);
    expect(asked).toBe(before);
    expect(frames).toEqual([]);
  });

  test("at work it turns; given rest again, it comes to rest and asks for no more frames", () => {
    const working = knightFace({ id: "gareth", size: 34, mood: "working", key: "test:rest" }) as unknown as Node_;
    expect(working.children[0]!.className).toBe("knight-orb-canvas");
    expect(frames.length).toBeGreaterThan(0);
    for (let ms = 1000; ms < 2000; ms += 1000 / 60) run(ms);
    // Its work ends: drawn again at rest, on the same course, it slows to a stop, then nothing more.
    working.children[0]!.isConnected = false;
    const resting = canvasOf(knightFace({ id: "gareth", size: 34, mood: "idle", key: "test:rest" }) as unknown as Node_)!;
    for (let ms = 2000; ms < 12_000; ms += 1000 / 60) run(ms);
    const settled = resting.calls.length;
    for (let ms = 12_000; ms < 13_000; ms += 1000 / 60) run(ms);
    expect(resting.calls.length).toBe(settled);
    expect(frames).toEqual([]);
  });
});

describe("a knight's seat", () => {
  test("its face, still, with no ring and no lights round it; its state on the seat and in its name", () => {
    const live = seat({ id: "gareth", name: "Gareth", state: "working", expression: "working", size: 40 }) as unknown as Node_;
    expect(live.children.map((child) => child.attrs.class ?? child.className)).toEqual(["worker-avatar"]);
    expect(live.attrs["data-state"]).toBe("working");
    const face = live.children[0]!.children[0]!;
    expect([face.attrs.class, face.attrs["aria-label"]]).toEqual(["knight-orb", "Gareth · Working"]);
    run(1000);
    expect(frames).toEqual([]);
  });

  test("Galahad's seat is his orb, still, in the room a face and its seat take", () => {
    const drawn = seat({ id: "galahad", name: "Galahad", state: "needs", size: 40 }) as unknown as Node_;
    expect([drawn.children[0]!.attrs.class, drawn.children[0]!.attrs["data-tone"], drawn.children[0]!.attrs["data-mood"], drawn.children[0]!.attrs.style]).toEqual(["orb", "warn", undefined, "--orb-size:48px"]);
    run(1000);
    expect(frames).toEqual([]);
  });
});
