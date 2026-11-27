import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { GLASS_DOT, GLASS_RAMPS, GLASS_SHAPES, glassOf, glassState } from "@invincible/core/glass";
import { GLASS_CSS, glassAvatar } from "./glass.ts";
import { agentMark, markStateOfAgent, markStateOfMood } from "./mark.ts";

/*
 * An agent's mark, its glass, as the web draws it: from core's numbers (core's glass.ts, held to the vectors every app is
 * held to), one sprite a page, each avatar a use of it in a box of its own; its state a dot; only working moves, and only
 * by the stylesheet, by opacity: still where motion is reduced, paused while the page is hidden.
 */

describe("what a mark shows", () => {
  test("an orb's mood, and an agent's state in its seat: work that passed review is done; new to you, or at rest, idle", () => {
    expect(["idle", "working", "waiting", "queued", "paused", "done", "failed", undefined].map((mood) => markStateOfMood(mood as never))).toEqual(["idle", "working", "needs", "queued", "paused", "done", "failed", "idle"]);
    expect(["working", "needs", "failed", "paused", "queued", "verified", "unread", "resting", undefined].map((state) => markStateOfAgent(state as never))).toEqual(["working", "needs", "failed", "paused", "queued", "done", "idle", "idle", "idle"]);
  });
});

describe("the page's sprite", () => {
  /** A page that keeps what is put in it. */
  type El = { tag: string; attrs: Record<string, string>; children: El[]; textContent?: string };
  let body: El[] = [], head: El[] = [], listeners: string[] = [], hiddenSet: boolean[] = [];
  const saved = Object.getOwnPropertyDescriptor(globalThis, "document");
  beforeEach(() => {
    body = []; head = []; listeners = []; hiddenSet = [];
    const make = (tag: string): El & Record<string, unknown> => {
      const el: El & Record<string, unknown> = { tag, attrs: {}, children: [] };
      el.setAttribute = (k: string, v: string) => void (el.attrs[k] = v);
      el.appendChild = (child: El) => (el.children.push(child), child);
      el.append = (...kids: El[]) => void el.children.push(...kids);
      el.addEventListener = () => {};
      return el;
    };
    Object.defineProperty(globalThis, "document", { configurable: true, writable: true, value: {
      createElement: make,
      createElementNS: (_: string, tag: string) => make(tag),
      createTextNode: (text: string) => ({ tag: "#text", attrs: {}, children: [], textContent: text }),
      getElementById: () => null,
      body: { prepend: (el: El) => body.push(el) },
      head: { append: (el: El) => head.push(el) },
      documentElement: { toggleAttribute: (_: string, on: boolean) => hiddenSet.push(on) },
      visibilityState: "visible",
      addEventListener: (kind: string) => listeners.push(kind),
    } });
  });
  afterEach(() => {
    if (saved) Object.defineProperty(globalThis, "document", saved);
    else Reflect.deleteProperty(globalThis, "document");
  });

  test("made once, with every shape in both its forms, the nine paints and the blur; the page told to pause it when hidden", () => {
    glassAvatar({ id: "coder", size: 24 });
    expect(body).toHaveLength(1);
    const defs = body[0]!.children[0]!;
    const ids = defs.children.map((el) => el.attrs.id);
    for (let n = 0; n < GLASS_SHAPES.length; n++) expect(ids).toContain(`gs-${n}`), expect(ids).toContain(`gs-${n}-s`);
    for (const id of [...GLASS_RAMPS.map((_, n) => String(n)), "pearl"]) expect(ids).toContain(`gp-${id}`);
    expect(ids).toContain("gl-blur");
    // Each shape's path is core's own, in both forms.
    const drawn = defs.children.find((el) => el.attrs.id === "gs-1")!.children[0]!;
    expect([drawn.attrs.d, drawn.attrs["stroke-width"]]).toEqual([GLASS_SHAPES[1]!.d, String(GLASS_SHAPES[1]!.width)]);
    const small = defs.children.find((el) => el.attrs.id === "gs-1-s")!.children[0]!;
    expect(small.attrs["stroke-width"]).toBe(String(GLASS_SHAPES[1]!.smallWidth));
    expect(head.map((el) => el.attrs.id ?? el.tag)).toEqual(["style"]);
    expect(listeners).toEqual(["visibilitychange"]);
    expect(hiddenSet).toEqual([false]);
  });

  test("working, needs you and failed are their own; idle, queued, paused and done are idle (the word says which)", () => {
    for (const state of ["idle", "working", "needs", "queued", "paused", "done", "failed"] as const) {
      const drawn = agentMark({ id: "coder", size: 24, state }) as unknown as { attrs: Record<string, string> };
      expect(drawn.attrs["data-state"]).toBe(glassState(state));
    }
    expect(glassOf("coder").shape).toBeGreaterThanOrEqual(0);
  });
});

describe("its stylesheet", () => {
  test("only working breathes, by opacity; still where motion is reduced (by the system, unless set to full, or by Settings); paused while the page is hidden", () => {
    expect(GLASS_CSS).toContain('.agent-glass[data-state="working"]::before { animation: gl-pool');
    expect(GLASS_CSS).toMatch(/@keyframes gl-pool \{ 0%, 100% \{ opacity: [0-9.]+; \} 50% \{ opacity: 1; \} \}/);
    expect(GLASS_CSS).toContain('@media (prefers-reduced-motion: reduce) { :root:not([data-motion="full"]) .agent-glass[data-state="working"]::before, :root:not([data-motion="full"]) .agent-glass[data-state="working"]::after { animation: none; } }');
    expect(GLASS_CSS).toContain(':root[data-motion="reduce"] .agent-glass[data-state="working"]::before, :root[data-motion="reduce"] .agent-glass[data-state="working"]::after { animation: none; }');
    expect(GLASS_CSS).toContain(":root[data-hidden] .agent-glass::before, :root[data-hidden] .agent-glass::after { animation-play-state: paused; }");
    // Nothing else in it moves: its two breaths, and the two rules that still them.
    expect(GLASS_CSS.match(/animation:/g)).toHaveLength(4);
  });

  test("its glow follows the page's theme by itself: the pool on a dark page, the shadow on a light one", () => {
    expect(GLASS_CSS).toContain('@media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) { --gl-dark: 1; } }');
    expect(GLASS_CSS).toContain(':root[data-theme="dark"] { --gl-dark: 1; }');
    for (const state of ["working", "needs", "failed"] as const) expect(GLASS_CSS).toContain(`light-dark(${GLASS_DOT.colors[state].light}, ${GLASS_DOT.colors[state].dark})`);
  });
});
