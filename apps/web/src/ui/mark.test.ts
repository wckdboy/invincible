import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { type MarkGeometry, type MarkState, MARK_PALETTE, markColors, markGeometry, markOf } from "@invincible/core/agent-mark";
import { handleSeed } from "@invincible/core/avatar";
import { agentMark, bandPath, markParts, markStateOfAgent, markStateOfMood } from "./mark.ts";

/*
 * An agent's mark, the Grille (O2), as the web draws it: from core's numbers, held to the vectors every app is held to
 * (apps/apple/scripts/vectors.ts' `marks`: 108 cases of form, state, size, theme and moment); still in rows and where
 * motion is reduced; moving only where it is looked at and its state moves it; asking for nothing at rest.
 */

interface Case {
  id: string;
  mark: { color: number; form: number };
  seed: number;
  state: MarkState;
  size: number;
  theme: "light" | "dark";
  t: number | null;
  since: number | null;
  geometry: MarkGeometry;
  colors: { body: string; key: string };
}
const fixture = JSON.parse(readFileSync(join(import.meta.dir, "../../../apple/InvincibleTests/Fixtures/core-vectors.json"), "utf8")) as { marks: { geometry: Case[] } };
const cases = fixture.marks.geometry;
// (Plus zero: a path says "0" for minus zero, as JavaScript writes it.)
const round = (n: number) => Math.round(n * 100) / 100 + 0;

describe("the marks, held to the vectors", () => {
  test("every case: core's geometry and colours as the vectors hold them, and the web's slats saying exactly those numbers", () => {
    expect(cases.length).toBeGreaterThanOrEqual(108);
    for (const c of cases) {
      const geometry = markGeometry({ mark: c.mark, seed: c.seed, state: c.state, size: c.size, t: c.t, since: c.since });
      expect([c.id, c.state, c.size, c.t, geometry]).toEqual([c.id, c.state, c.size, c.t, c.geometry]);
      expect(markColors(c.mark.color, c.state, c.theme)).toEqual(c.colors);
      const parts = markParts(c.geometry);
      expect(parts).toHaveLength(c.geometry.slats.length);
      parts.forEach((part, n) => {
        const slat = c.geometry.slats[n]!;
        const r = c.geometry.radius;
        // Its band: from the chord at `from` to the chord at `to`, each as wide as the disc is there.
        const [x0, y0, x1, y1] = part.d.match(/^M(-?[\d.]+),(-?[\d.]+) L(-?[\d.]+),(-?[\d.]+) A/)!.slice(1).map(Number);
        expect([x0, y0, x1, y1]).toEqual([round(-Math.sqrt(r * r - slat.from * slat.from)), round(slat.from), round(Math.sqrt(r * r - slat.from * slat.from)), round(slat.from)]);
        expect(part.d).toContain(`,${round(slat.to)} L${round(-Math.sqrt(Math.max(0, r * r - slat.to * slat.to)))},${round(slat.to)} A`);
        expect(part.slid).toBe(`translate(${round(slat.slide)} 0)`);
        expect(part.turned).toBe(`translate(50 50) rotate(${round(c.geometry.angle)})`);
        expect(part.loose).toBe(slat.drop || slat.turn ? `translate(0 ${round(slat.drop)}) rotate(${round(slat.turn)} ${round(slat.pivot[0])} ${round(slat.pivot[1])})` : null);
        expect(part.fill).toBe(slat.fill);
      });
    }
  });

  test("a band is two chords of the disc and the arcs between them, closed", () => {
    expect(bandPath(44, -44, 44)).toBe("M0,-44 L0,-44 A44,44 0 0 1 0,44 L0,44 A44,44 0 0 1 0,-44 Z");
    expect(bandPath(44, 0, 10)).toBe("M-44,0 L44,0 A44,44 0 0 1 42.85,10 L-42.85,10 A44,44 0 0 1 -44,0 Z");
  });
});

describe("what a mark shows", () => {
  test("an orb's mood, and an agent's state in its seat: work that passed review is done; new to you, or at rest, idle", () => {
    expect(["idle", "working", "waiting", "queued", "paused", "done", "failed", undefined].map((mood) => markStateOfMood(mood as never))).toEqual(["idle", "working", "needs", "queued", "paused", "done", "failed", "idle"]);
    expect(["working", "needs", "failed", "paused", "queued", "verified", "unread", "resting", undefined].map((state) => markStateOfAgent(state as never))).toEqual(["working", "needs", "failed", "paused", "queued", "done", "idle", "idle", "idle"]);
  });
});

// ---- drawn on a page ------------------------------------------------------------------------------------------------

class Node_ {
  readonly attrs: Record<string, string> = {};
  readonly children: Node_[] = [];
  isConnected = true;
  constructor(readonly tag: string) {
    made.push(this);
  }
  setAttribute(key: string, value: string) { this.attrs[key] = value; }
  getAttribute(key: string) { return this.attrs[key] ?? null; }
  removeAttribute(key: string) { delete this.attrs[key]; }
  appendChild(child: Node_) { this.children.push(child); return child; }
  addEventListener() {}
}

let frames: FrameRequestCallback[] = [];
let asked = 0;
let timers: { at: number; callback: () => void; id: number }[] = [];
let clock = 0;
let ids = 0;
let made: Node_[] = [];
const root = { dataset: {} as Record<string, string> };
const run = (ms: number) => {
  clock = ms;
  for (const timer of timers.filter((timer) => timer.at <= ms)) {
    timers = timers.filter((other) => other !== timer);
    timer.callback();
  }
  for (const frame of frames.splice(0)) frame(ms);
};
const saved = new Map<string, PropertyDescriptor | undefined>();
function stub(name: string, value: unknown) {
  saved.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
  Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
}
beforeEach(() => {
  made = [];
  asked = 0;
  clock = 0;
  root.dataset = { theme: "light" };
  stub("document", { createElement: (tag: string) => new Node_(tag), createElementNS: (_: string, tag: string) => new Node_(tag), createTextNode: () => new Node_("#text"), documentElement: root, hidden: false, addEventListener() {} });
  stub("matchMedia", () => ({ matches: false, addEventListener() {} }));
  stub("MutationObserver", class { observe() {} });
  stub("requestAnimationFrame", (callback: FrameRequestCallback) => (asked++, frames.push(callback)));
  stub("performance", { now: () => clock });
  stub("setTimeout", (callback: () => void, ms?: number) => {
    timers.push({ at: clock + (Number.isFinite(ms) ? Math.max(0, ms!) : 0), callback, id: ++ids });
    return ids;
  });
  stub("clearTimeout", (id: number) => (timers = timers.filter((timer) => timer.id !== id)));
});
afterEach(() => {
  // Everything drawn leaves the page, and the page's clock, with nothing left on it, stops.
  for (const node of made) node.isConnected = false;
  for (let i = 0; i < 300 && (frames.length || timers.length); i++) run(600_000 + 20 * i);
  expect([frames, timers]).toEqual([[], []]);
  for (const [name, descriptor] of saved) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else Reflect.deleteProperty(globalThis, name);
  }
  saved.clear();
});

const paths = (node: Node_): Node_[] => (node.tag === "path" ? [node] : node.children.flatMap(paths));
const slides = (node: Node_) => paths(node).map((path) => path.attrs.transform);

describe("a mark on a page", () => {
  test("its slats, its state, its size and its colours: core's palette's in either theme, never a profile's words", () => {
    const el = agentMark({ id: "builder", profile: { v: 3, color: "#c88200", form: 1 }, size: 44, state: "failed", label: "Builder: failed" }) as unknown as Node_;
    expect(el.attrs).toMatchObject({ class: "agent-orb agent-mark", "data-state": "failed", role: "img", "aria-label": "Builder: failed" });
    // Form 1: two slots, three slats; the bottom one red, knocked loose, as a row draws it (settled).
    expect(paths(el).map((path) => path.attrs.class)).toEqual(["body", "body", "key"]);
    expect(el.attrs.style).toBe(`--orb-size:44px;--mark-body:light-dark(#c88200, #ffbc63);--mark-key:light-dark(#c4141b, #ee2c36)`);
    const odd = agentMark({ id: "builder", profile: { v: 3, color: "red;background:url(x)", form: 1 }, size: 44 }) as unknown as Node_;
    expect(odd.attrs.style).not.toContain("url");
    expect(MARK_PALETTE.some((hue) => odd.attrs.style!.includes(hue.light))).toBe(true);
  });

  test("still in a row: drawn once, asking for no frame, whatever its state", () => {
    for (const state of ["idle", "working", "needs", "queued", "paused", "done", "failed"] as const) agentMark({ id: "coder", size: 16, state });
    run(1000);
    expect(asked).toBe(0);
  });

  test("the one you look at, at work: its slats slide on the page's clock, calmly; once off the page it is forgotten", () => {
    const el = agentMark({ id: "coder", size: 44, state: "working", live: true }) as unknown as Node_;
    const first = slides(el);
    for (let ms = 16; ms <= 1200; ms += 16) run(ms);
    expect(slides(el)).not.toEqual(first);
    // About fifteen frames a second, not one a screen refresh.
    expect(asked).toBeGreaterThan(8);
    expect(asked).toBeLessThan(30);
  });

  test("at rest, even where it is looked at, nothing moves and no frame is asked for; where motion is reduced, nothing moves at all", () => {
    for (const state of ["idle", "queued", "paused", "done", "failed"] as const) agentMark({ id: "coder", size: 44, state, live: true, key: `rest:${state}` });
    run(1000);
    expect(asked).toBe(0);
    root.dataset.motion = "reduce";
    const el = agentMark({ id: "coder", size: 44, state: "working", live: true }) as unknown as Node_;
    const still = slides(el);
    run(2000);
    expect([asked, slides(el)]).toEqual([0, still]);
  });

  test("arriving at failed, where it is looked at, its bottom slat drops once, and then it asks for nothing", () => {
    const key = "task:coder";
    const working = agentMark({ id: "coder", size: 44, state: "working", live: true, key }) as unknown as Node_;
    run(16);
    // Its task failed: the header draws its face again, and the one at work leaves the page.
    working.isConnected = false;
    const failed = agentMark({ id: "coder", size: 44, state: "failed", live: true, key }) as unknown as Node_;
    const groups = (node: Node_): Node_[] => (node.tag === "g" ? [node, ...node.children.flatMap(groups)] : node.children.flatMap(groups));
    const loose = () => groups(failed).map((group) => group.attrs.transform ?? "").filter((transform) => transform.startsWith("translate(0 "));
    const settled = markParts(markGeometry({ mark: markOf("coder"), seed: handleSeed("coder"), state: "failed", size: 44, t: null, since: null })).at(-1)!.loose;
    // At its arrival the slat is in its place; over the next 0.6 s it turns and falls, and there it stays.
    expect(loose()).toEqual([]);
    for (let ms = 32; ms <= 816; ms += 16) run(ms);
    expect(loose()).toEqual([settled!]);
    const after = asked;
    run(5000);
    run(6000);
    expect(asked - after).toBe(0);
    // Drawn again in the same state (its page drawn anew), it is long in it: it doesn't fall again.
    const again = agentMark({ id: "coder", size: 44, state: "failed", live: true, key }) as unknown as Node_;
    run(7000);
    expect(asked - after).toBe(0);
    expect(groups(again).map((group) => group.attrs.transform ?? "").filter((transform) => transform.startsWith("translate(0 "))).toEqual([settled!]);
  });
});
