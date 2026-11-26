import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { seat, workerAvatar } from "./avatar.ts";
import { appMark, agentFace, orb } from "./orb.ts";

/*
 * Your agent's I-beam and each agent's mark (the Grille, O2: ui/mark.ts) on a page that records what is made, without a
 * browser: no canvas anywhere; still where they are many, where motion is reduced, and at rest; moving slowly where one is
 * looked at and its state moves it; asking for nothing once still.
 */

/** A 2D context that keeps the name of every call made on it, and every blend it is set to. (A gradient it makes, linear
 * or radial, takes its stops and keeps nothing.) */
function context(calls: string[], blends: string[]): CanvasRenderingContext2D {
  return new Proxy({} as Record<string, unknown>, {
    get(target, key) {
      if (typeof key !== "string") return undefined;
      if (key in target) return target[key];
      return () => {
        calls.push(key);
        return key === "createLinearGradient" || key === "createRadialGradient" ? { addColorStop() {} } : undefined;
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
  getAttribute(key: string) { return this.attrs[key] ?? null; }
  removeAttribute(key: string) { delete this.attrs[key]; }
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


describe("your agent's mark", () => {
  test("the I-beam, still, wherever it is: no canvas, no frame asked for, whatever it is doing", () => {
    const drawn = orb({ size: 168, mood: "working", label: "Your agent: at work", key: "test:sharp" }) as unknown as Node_;
    expect([drawn.attrs.class, drawn.attrs.role, drawn.attrs["aria-label"], drawn.attrs["data-mood"]]).toEqual(["orb orb-mark", "img", "Your agent: at work", undefined]);
    expect(made.some((node) => node.tag === "canvas")).toBe(false);
    run(1000);
    expect(frames).toEqual([]);
  });
});

const pathsIn = (node: Node_): Node_[] => (node.tag === "path" ? [node] : node.children.flatMap(pathsIn));
const slidesOf = (node: Node_) => pathsIn(node).map((path) => path.attrs.transform);

describe("an agent's mark", () => {
  test("its Grille at its own size, named: no canvas, a disc cut into three or four slats; in a state that moves, a frame at a time", () => {
    const drawn = agentFace({ id: "ada", size: 168, mood: "working", label: "Ada · Working", key: "test:sharp" }) as unknown as Node_;
    expect([drawn.attrs.class, drawn.attrs.role, drawn.attrs["aria-label"], drawn.attrs["data-state"]]).toEqual(["agent-orb agent-mark", "img", "Ada · Working", "working"]);
    expect(drawn.attrs.style).toStartWith("--orb-size:168px;");
    expect(made.some((node) => node.tag === "canvas")).toBe(false);
    expect(pathsIn(drawn).length).toBeWithin(3, 5);
    expect(frames.length).toBeGreaterThan(0);
  });

  test("at rest (idle), done, queued, paused or failed, still: drawn once, asking for no frame (nothing animates at rest)", () => {
    for (const mood of ["idle", "done", "queued", "paused", "failed"] as const) agentFace({ id: "ada", size: 48, mood, key: `test:rest-${mood}` });
    const before = asked;
    run(1000);
    run(2000);
    expect(asked).toBe(before);
    expect(frames).toEqual([]);
  });

  test("at work, then at rest: it stops, and asks for no more frames", () => {
    const working = agentFace({ id: "ada", size: 48, mood: "working", key: "test:settles" }) as unknown as Node_;
    run(1000);
    expect(frames.length + timers.length).toBeGreaterThan(0);
    working.isConnected = false;
    const resting = agentFace({ id: "ada", size: 48, mood: "idle", key: "test:settles" }) as unknown as Node_;
    const still = slidesOf(resting);
    for (let ms = 1000; ms < 4000; ms += 50) run(ms);
    expect(slidesOf(resting)).toEqual(still);
    expect([frames, timers]).toEqual([[], []]);
  });

  test("still where motion is reduced: drawn once, and nothing more", () => {
    root.dataset.motion = "reduce";
    const drawn = agentFace({ id: "ada", size: 168, mood: "working", key: "test:still" }) as unknown as Node_;
    const still = slidesOf(drawn);
    run(1000);
    run(2000);
    expect(slidesOf(drawn)).toEqual(still);
    expect(frames).toEqual([]);
  });

  test("without a mood (a row, the history), still: drawn once, whatever its state", () => {
    agentFace({ id: "ada", size: 28 });
    agentFace({ id: "ada", size: 28, state: "working" });
    run(1000);
    run(2000);
    expect(frames).toEqual([]);
  });

  test("on screen it moves a frame at a time at its pace, and once off the page it is forgotten", () => {
    const drawn = agentFace({ id: "ada", size: 36, mood: "working", key: "test:frames" }) as unknown as Node_;
    const first = slidesOf(drawn);
    run(5000);
    expect(slidesOf(drawn)).not.toEqual(first);
    // (A frame sooner than its next is due draws nothing: its slats slide at 15 frames a second.)
    const drawnThen = slidesOf(drawn);
    run(5040);
    expect(slidesOf(drawn)).toEqual(drawnThen);
    run(5070);
    expect(slidesOf(drawn)).not.toEqual(drawnThen);
    drawn.isConnected = false;
    const gone = slidesOf(drawn);
    run(6000);
    run(6100);
    expect(slidesOf(drawn)).toEqual(gone);
  });

  test("one made before it is put on the page is looked for ten times a second, not at every frame, and forgotten after five", () => {
    const drawn = agentFace({ id: "ada", size: 36, mood: "working", key: "test:unplaced" }) as unknown as Node_;
    drawn.isConnected = false;
    const before = asked;
    for (let ms = 1000; ms < 2000; ms += 1000 / 60) run(ms);
    expect(asked - before).toBeWithin(8, 13);
    drawn.isConnected = true;
    const then = slidesOf(drawn);
    for (let ms = 2000; ms < 3000; ms += 1000 / 60) run(ms);
    expect(slidesOf(drawn)).not.toEqual(then);
    const other = agentFace({ id: "ada", size: 36, mood: "working", key: "test:never" }) as unknown as Node_;
    other.isConnected = false;
    drawn.isConnected = false;
    for (let ms = 3000; ms < 9000; ms += 1000 / 60) run(ms);
    expect([frames, timers]).toEqual([[], []]);
  });

  test("a change of theme draws nothing again: its colours are the page's own pair, light and dark (light-dark())", () => {
    const drawn = agentFace({ id: "ada", size: 34, key: "test:theme" }) as unknown as Node_;
    expect(drawn.attrs.style).toMatch(/--mark-body:light-dark\(#[0-9a-f]{6}, #[0-9a-f]{6}\)/);
    expect(themeWatcher).toBeNull();
  });
});

describe("the app's mark", () => {
  test("the I-beam alone, still and on nothing, in the page's ink (light or dark): no canvas, no frames", () => {
    const mark = appMark(20) as unknown as Node_;
    expect([mark.attrs.class, mark.attrs.style, mark.attrs["aria-hidden"]]).toEqual(["orb app-mark", "--orb-size:20px", "true"]);
    expect(mark.children.map((child) => [child.tag, child.attrs.class])).toEqual([["svg", "ibeam"]]);
    expect(made.some((node) => node.tag === "canvas")).toBe(false);
    run(1000);
    expect(frames).toEqual([]);
  });
});

describe("an agent's face", () => {
  test("its mark alone: slats and nothing else, never a beam, never a canvas", () => {
    const working = agentFace({ id: "max", size: 50, mood: "working", key: "test:no-beam" }) as unknown as Node_;
    const still = agentFace({ id: "ada", size: 34 }) as unknown as Node_;
    for (const face of [working, still]) {
      const svgs = face.children;
      expect(svgs.map((child) => [child.tag, child.attrs.class])).toEqual([["svg", "agent-mark-svg"]]);
      expect(made.filter((node) => node.tag !== "span" && node.tag !== "svg" && node.tag !== "g" && node.tag !== "path")).toEqual([]);
    }
  });

  test("still unless its state moves it where it is looked at: at rest, in a row or in the history, never asking for a frame", () => {
    agentFace({ id: "max", size: 34, mood: "idle", key: "test:idle" });
    agentFace({ id: "max", size: 34 });
    workerAvatar({ id: "max", name: "Max", still: true });
    const before = asked;
    run(1000);
    run(2000);
    expect(asked).toBe(before);
    expect(frames).toEqual([]);
  });

  test("at work its slats slide; given rest again, it is still and asks for no more frames", () => {
    const working = agentFace({ id: "max", size: 34, mood: "working", key: "test:rest" }) as unknown as Node_;
    expect(frames.length).toBeGreaterThan(0);
    const first = slidesOf(working);
    for (let ms = 1000; ms < 2000; ms += 1000 / 60) run(ms);
    expect(slidesOf(working)).not.toEqual(first);
    working.isConnected = false;
    agentFace({ id: "max", size: 34, mood: "idle", key: "test:rest" });
    for (let ms = 2000; ms < 4000; ms += 1000 / 60) run(ms);
    expect(frames).toEqual([]);
  });
});

describe("an agent's seat", () => {
  test("its mark, still, with no ring round it; its state on the seat, in its mark's shape and in its name", () => {
    const live = seat({ id: "max", name: "Max", state: "working", expression: "working", size: 40 }) as unknown as Node_;
    expect(live.children.map((child) => child.attrs.class ?? child.className)).toEqual(["worker-avatar"]);
    expect(live.attrs["data-state"]).toBe("working");
    const face = live.children[0]!.children[0]!;
    expect([face.attrs.class, face.attrs["aria-label"], face.attrs["data-state"]]).toEqual(["agent-orb agent-mark", "Max · Working", "working"]);
    // Failed: its bottom slat red and loose, still; asks you: its top slat in ink.
    const failed = seat({ id: "max", name: "Max", state: "failed", size: 40 }) as unknown as Node_;
    expect(pathsIn(failed).map((path) => path.attrs.class).at(-1)).toBe("key");
    const asks = seat({ id: "max", name: "Max", state: "needs", size: 40 }) as unknown as Node_;
    expect(pathsIn(asks).map((path) => path.attrs.class)[0]).toBe("key");
    run(1000);
    expect(frames).toEqual([]);
  });

  test("Your agent's seat is its mark, still, in the room a face and its seat take", () => {
    const drawn = seat({ id: "primary", name: "Your agent", state: "needs", size: 40 }) as unknown as Node_;
    expect([drawn.children[0]!.attrs.class, drawn.children[0]!.attrs["data-tone"], drawn.children[0]!.attrs["data-mood"], drawn.children[0]!.attrs.style]).toEqual(["orb orb-mark", "warn", undefined, "--orb-size:48px"]);
    run(1000);
    expect(frames).toEqual([]);
  });
});
