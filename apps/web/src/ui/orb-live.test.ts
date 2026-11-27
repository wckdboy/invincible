import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { seat, workerAvatar } from "./avatar.ts";
import { GLASS_PEARL, GLASS_SHAPES, glassOf } from "@invincible/core/glass";
import { MARK_POLYGON } from "../../../../scripts/mark.ts";
import { appMark, agentFace, orb } from "./orb.ts";
import { GLASS_CSS } from "./glass.ts";

/*
 * Your agent's I-beam and each agent's glass (ui/glass.ts) on a page that records what is made, without a browser: no
 * canvas anywhere, and never a frame asked for: what moves (a working agent's light) is the stylesheet's alone.
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
  test("is the bare I-beam in the page's ink, on no tile: the squircle round it is the app icon's alone (the owner's word, 27 November 2026)", () => {
    const mono = GLASS_CSS.split("\n").filter((line) => line.startsWith(".guardian-mark.gm-mono"));
    expect(mono).toEqual([".guardian-mark.gm-mono polygon { fill: var(--accent); }"]);
  });

  test("the bare I-beam in one ink, still, wherever it is: no canvas, no frame asked for, whatever it is doing", () => {
    const drawn = orb({ size: 168, mood: "working", label: "Your agent: at work", key: "test:sharp" }) as unknown as Node_;
    expect([drawn.attrs.class, drawn.attrs.role, drawn.attrs["aria-label"]]).toEqual(["guardian-mark gm-mono orb orb-mark", "img", "Your agent: at work"]);
    expect(drawn.children[0]!.children.map((child) => [child.tag, child.attrs.points])).toEqual([["polygon", MARK_POLYGON]]);
    expect(made.some((node) => node.tag === "canvas")).toBe(false);
    run(1000);
    expect(frames).toEqual([]);
  });

  test("or, where this device is set so, the I-beam in pearl glass, lit as an agent's glass is: its pool from 24 and its blur from 40, and no shadow (it has its tile)", () => {
    stub("localStorage", { getItem: (key: string) => (key === "invincible.guardian-mark" ? "pearl" : null), setItem() {} });
    const drawn = orb({ size: 40 }) as unknown as Node_;
    // (Its glass's own rules: the pool in the pearl's colours, and the blur's opacity and drop by page.)
    expect(drawn.attrs.class).toBe("guardian-mark gm-pearl agent-glass gl-pool orb orb-mark");
    expect(drawn.attrs.style).toContain(`--ga:light-dark(${GLASS_PEARL.light.a}, ${GLASS_PEARL.dark.a});--gb:light-dark(${GLASS_PEARL.light.b}, ${GLASS_PEARL.dark.b})`);
    const uses = drawn.children[0]!.children;
    expect(uses.map((use) => [use.attrs.href, use.attrs.fill, use.attrs.filter])).toEqual([["#gs-ibeam", "url(#gp-pearl)", "url(#gl-blur)"], ["#gs-ibeam", "url(#gp-pearl)", undefined]]);
    expect((orb({ size: 20 }) as unknown as Node_).attrs.class).toBe("guardian-mark gm-pearl agent-glass orb orb-mark");
  });
});

/** The uses an agent's glass is drawn with. */
const usesOf = (node: Node_): Node_[] => (node.tag === "use" ? [node] : node.children.flatMap(usesOf));

describe("an agent's face", () => {
  test("its glass alone, at its own size: its shape in its ramp, as its node gave them; no canvas, no beam", () => {
    const glass = glassOf("coder");
    const face = agentFace({ id: "coder", size: 24, label: "Coder" }) as unknown as Node_;
    expect([face.attrs.class, face.attrs["data-shape"], face.attrs.role, face.attrs["aria-label"]]).toEqual(["agent-orb agent-glass gl-pool gl-shade", GLASS_SHAPES[glass.shape]!.id, "img", "Coder"]);
    expect(usesOf(face).map((use) => [use.attrs.href, use.attrs.fill, use.attrs.stroke])).toEqual([[`#gs-${glass.shape}`, `url(#gp-${glass.color})`, `url(#gp-${glass.color})`]]);
    expect(made.some((node) => node.tag === "canvas" || node.tag === "polygon")).toBe(false);
  });

  test("at 16 its small form and no glow; from 20 its shadow, from 24 its pool, from 40 its blur", () => {
    const glass = glassOf("coder");
    const at = (size: number) => agentFace({ id: "coder", size }) as unknown as Node_;
    expect([at(16).attrs.class, usesOf(at(16)).map((use) => use.attrs.href)]).toEqual(["agent-orb agent-glass", [`#gs-${glass.shape}-s`]]);
    expect(at(20).attrs.class).toBe("agent-orb agent-glass gl-shade");
    expect(at(24).attrs.class).toBe("agent-orb agent-glass gl-pool gl-shade");
    expect(usesOf(at(40)).map((use) => [use.attrs.class, use.attrs.filter])).toEqual([["gl-blur", "url(#gl-blur)"], [undefined, undefined]]);
  });

  test("its state a dot where it is known; without a state or a mood (a speaker in the history), none; never a frame asked for", () => {
    const working = agentFace({ id: "coder", size: 24, mood: "working" }) as unknown as Node_;
    expect([working.attrs["data-state"], working.children.at(-1)!.attrs.class]).toEqual(["working", "gl-dot"]);
    const failed = agentFace({ id: "coder", size: 24, state: "failed" }) as unknown as Node_;
    expect(failed.attrs["data-state"]).toBe("failed");
    const quiet = agentFace({ id: "coder", size: 24 }) as unknown as Node_;
    expect([quiet.attrs["data-state"], quiet.children.some((child) => child.attrs.class === "gl-dot")]).toEqual([undefined, false]);
    run(1000);
    expect([frames, asked]).toEqual([[], 0]);
  });
});

describe("an agent's seat", () => {
  test("its glass, still, with no ring round it; its state on the seat, on its dot and in its name", () => {
    const sat = seat({ id: "tester", name: "Tester", size: 24, state: "needs" }) as unknown as Node_;
    expect(sat.attrs["data-state"]).toBe("needs");
    const face = sat.children[0]!.children[0]!;
    expect([face.attrs["data-state"], face.attrs["aria-label"]]).toEqual(["needs", "Tester · Needs you"]);
    run(1000);
    expect(frames).toEqual([]);
  });

  test("Your agent's seat is its mark, still, in the room a face and its seat take", () => {
    const sat = seat({ id: "primary", name: "Your agent", size: 24, state: "working" }) as unknown as Node_;
    expect(sat.attrs.class).toBe("seat seat-s seat-orb");
    expect(sat.children[0]!.attrs.class).toBe("guardian-mark gm-mono orb orb-mark");
  });

  test("a speaker in the history: its glass, with no dot", () => {
    const said = workerAvatar({ id: "tester", name: "Tester", size: 24, still: true }) as unknown as Node_;
    const face = said.children[0]!;
    expect([face.attrs["data-state"], face.attrs["aria-label"]]).toEqual([undefined, "Tester's mark"]);
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
