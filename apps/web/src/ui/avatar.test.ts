import { describe, expect, test } from "bun:test";
import { MARK_PALETTE, snapColor } from "@invincible/core/agent-mark";
import { GLASS_RAMPS, GLASS_SHAPES, glassOf } from "@invincible/core/glass";
import { AVATAR_EXPRESSIONS } from "@invincible/core/avatar";
import { MARK_POLYGON } from "../../../../scripts/mark.ts";
import { avatarEditor, AGENT_CSS, seat, stateChip, workerAvatar, type WorkerAvatarOptions } from "./avatar.ts";
import { appMark, orb } from "./orb.ts";

/** Captures the renderer's real createElement and createElementNS calls, without an HTML parser or a browser: an agent's
 * mark is SVG (its glass, a use of the page's sprite), the primary's the I-beam. */
class Node_ {
  readonly attrs: Record<string, string> = {};
  readonly children: Node_[] = [];
  constructor(readonly tag: string, readonly ns: "html" | "svg", readonly text = "") {}
  setAttribute(key: string, value: string) { this.attrs[key] = value; }
  appendChild(child: Node_) { this.children.push(child); return child; }
  addEventListener() {}
  get firstChild(): Node_ | null { return this.children[0] ?? null; }
  removeChild(child: Node_) { this.children.splice(this.children.indexOf(child), 1); return child; }
  replaceChildren(...nodes: Node_[]) { this.children.splice(0, this.children.length, ...nodes); }
  append(...nodes: Node_[]) { this.children.push(...nodes); }
}
function render(...options: WorkerAvatarOptions[]): Node_[] {
  return withDocument(() => options.map((option) => workerAvatar(option) as unknown as Node_));
}
function withDocument<T>(draw: () => T): T {
  const original = Object.getOwnPropertyDescriptor(globalThis, "document");
  Object.defineProperty(globalThis, "document", { configurable: true, value: {
    createElement: (tag: string) => new Node_(tag, "html"),
    createElementNS(namespace: string, tag: string) {
      expect(namespace).toBe("http://www.w3.org/2000/svg");
      return new Node_(tag, "svg");
    },
    createTextNode: (text: string) => new Node_("#text", "html", text),
  } });
  try { return draw(); }
  finally { if (original) Object.defineProperty(globalThis, "document", original); else Reflect.deleteProperty(globalThis, "document"); }
}
const walk = (node: Node_): Node_[] => [node, ...node.children.flatMap(walk)];
const orbOf = (node: Node_) => walk(node).find((child) => (child.attrs.class ?? "").startsWith("agent-orb agent-glass"))!;
/** Every colour a glass may be drawn in: core's ramps' own. */
const CORE_COLOURS = new Set<string>(GLASS_RAMPS.flatMap((ramp) => [...Object.values(ramp.light), ...Object.values(ramp.dark)]));
/** The colours a face's style names, and whether the style says nothing else. */
const STYLE = /^--orb-size:\d+px;--ga:light-dark\((#[0-9a-f]{6}), (#[0-9a-f]{6})\);--gb:light-dark\((#[0-9a-f]{6}), (#[0-9a-f]{6})\);--gl-dot:\d+px;--gl-dot-out:-?\d+px;--gl-dot-cut:[\d.]+px$/;
/** The colour a face's glass is in: the index of the ramp its paint names. */
const colourOf = (node: Node_) => Number(/url\(#gp-(\d)\)/.exec(walk(orbOf(node)).find((child) => child.tag === "use")!.attrs.fill!)![1]);
const shapeOf = (node: Node_) => orbOf(node).attrs["data-shape"];

describe("agents at the page's boundary", () => {
  test("nothing from a profile or a name reaches a URL, a style or a paint: its colours are only ever core's", () => {
    const name = '<image href="https://invalid.example/pixel" onload="alert(1)">';
    const profiles = [
      { v: 1, color: "url(https://invalid.example/paint)", accent: '#fff" onload="alert(1)', form: "foreignObject", onload: "alert(1)" },
      { v: 2, color: "url(https://invalid.example/paint)" },
      { v: 2, color: '#3abeff" onload="alert(1)' },
      { v: 2, color: "#3abeff", onload: "alert(1)" },
    ];
    for (const profile of profiles) {
      const [node] = render({ id: "ada", name, profile, expression: 'idle" onload="alert(1)' as never });
      expect(orbOf(node!).attrs["aria-label"]).toBe(`${name} · idle`);
      expect(node!.attrs["data-expression"]).toBe("idle");
      // A colour that isn't one is its handle's.
      expect(colourOf(node!)).toBe(glassOf("ada").color);
    }
    for (const drawn of render(...AVATAR_EXPRESSIONS.flatMap((expression) => [{ id: "ada", name, profile: profiles[0], expression, size: 96 }, { id: "ada", name, profile: { v: 2, color: "#3ABEFF" }, expression, size: 200 }]))) {
      for (const child of walk(drawn)) {
        expect(child.ns === "html" ? ["span", "i", "#text"] : ["svg", "use"]).toContain(child.tag);
        for (const [key, value] of Object.entries(child.attrs)) {
          expect(key).not.toMatch(/^(on|xlink|src)/i);
          if (key !== "aria-label") expect(value).not.toContain("invalid.example");
          // A use points into the page's own sprite, at a shape of core's, painted in a ramp of core's.
          if (key === "href") expect(value).toMatch(/^#gs-(1?\d|2[01])(-s)?$/);
          if (key === "fill" || key === "stroke") expect(value).toMatch(/^url\(#gp-[0-7]\)$/);
          if (key === "filter") expect(value).toBe("url(#gl-blur)");
          if (key === "style") {
            const colours = STYLE.exec(value);
            expect(colours).not.toBeNull();
            for (const colour of colours!.slice(1)) expect(CORE_COLOURS.has(colour!)).toBe(true);
          }
        }
      }
    }
  });

  test("its glass is the one its node gave it; a mark's colour or one chosen before, snapped to the eight; else its handle's", () => {
    const [given, mark, before, handle, look] = render(
      { id: "ada", name: "Ada", profile: { v: 4, color: "#0084ba", shape: 13 }, still: true },
      { id: "ada", name: "Ada", profile: { v: 3, color: "#0084ba", form: 10 }, still: true },
      { id: "ada", name: "Ada", profile: { v: 2, color: "#3ABEFF" }, still: true },
      { id: "ada", name: "Ada", still: true },
      { id: "ada", name: "Ada", profile: { v: 1, form: "round", color: "#be7153" }, still: true },
    );
    expect([colourOf(given!), shapeOf(given!)]).toEqual([4, GLASS_SHAPES[13]!.id]);
    expect([colourOf(mark!), shapeOf(mark!)]).toEqual([4, GLASS_SHAPES[glassOf("ada").shape]!.id]);
    expect(colourOf(before!)).toBe(snapColor("#3abeff"));
    expect(colourOf(handle!)).toBe(glassOf("ada").color);
    expect([colourOf(look!), shapeOf(look!)]).toEqual([colourOf(handle!), shapeOf(handle!)]);
    // Still, as a speaker in a conversation's history: named as the agent's mark, and doing nothing.
    expect(orbOf(handle!).attrs["aria-label"]).toBe("Ada's mark");
  });

  test("a face says nothing a row doesn't: still where it is given no mood, named for what it is doing where it is", () => {
    const [still, working, resting] = render({ id: "ada", name: "Ada", still: true, size: 28 }, { id: "ada", name: "Ada", expression: "working", size: 34 }, { id: "ada", name: "Ada", size: 160 });
    expect([orbOf(still!).attrs["aria-label"], orbOf(working!).attrs["aria-label"], orbOf(resting!).attrs["aria-label"]]).toEqual(["Ada's mark", "Ada · working", "Ada · idle"]);
    expect([still!, working!, resting!].map((node) => orbOf(node).attrs.style!.split(";")[0])).toEqual(["--orb-size:28px", "--orb-size:34px", "--orb-size:160px"]);
    // What it is doing is its dot (working; at rest, idle), and a speaker in the history has none.
    expect([orbOf(still!).attrs["data-state"], orbOf(working!).attrs["data-state"], orbOf(resting!).attrs["data-state"]]).toEqual([undefined, "working", "idle"]);
    expect(orbOf(still!).children.map((child) => child.tag)).toEqual(["svg"]);
    for (const node of [working!, resting!]) expect(orbOf(node).children.map((child) => child.tag)).toEqual(["svg", "i"]);
  });
});

describe("an agent in its seat", () => {
  test("no ring: the face alone, still, at the size asked, its state kept on the seat and said in its name; the seat's size follows it", () => {
    const [working, resting, portrait, card] = withDocument(() => [
      seat({ id: "ada", name: "Ada", state: "working", expression: "working", size: 32 }),
      seat({ id: "ada", name: "Ada", size: 32 }),
      seat({ id: "ada", name: "Ada", state: "needs", expression: "asking", size: 104 }),
      seat({ id: "ada", name: "Ada", state: "paused", size: 84 }),
    ] as unknown as Node_[]);
    expect([working!.attrs.class, working!.attrs["data-state"]]).toEqual(["seat seat-s", "working"]);
    expect(resting!.attrs["data-state"]).toBe("resting");
    expect([portrait!.attrs.class, card!.attrs.class]).toEqual(["seat seat-l", "seat seat-m"]);
    // Nothing but the face inside, named for its state, and no style of the seat's own.
    expect(working!.children).toHaveLength(1);
    expect(orbOf(working!).attrs["aria-label"]).toBe("Ada · Working");
    expect(orbOf(working!).attrs.style!.split(";")[0]).toBe("--orb-size:32px");
    expect(orbOf(resting!).attrs["aria-label"]).toBe("Ada");
    expect(working!.attrs.style).toBeUndefined();
  });

  test("Your agent's seat is its mark, in the room a face and its seat take; where it stands is kept on it", () => {
    const [needs, resting, card] = withDocument(() => [
      seat({ id: "primary", name: "Your agent", state: "needs", expression: "asking", size: 32 }),
      seat({ id: "primary", name: "Your agent", size: 32 }),
      seat({ id: "primary", name: "Your agent", state: "working", size: 88 }),
    ] as unknown as Node_[]);
    expect([needs!.attrs.class, needs!.attrs["data-state"]]).toEqual(["seat seat-s seat-orb", "needs"]);
    const shown = (node: Node_) => node.children[0]!.attrs;
    expect([shown(needs!).class, shown(needs!)["data-tone"], shown(needs!).style!.split(";")[0]]).toEqual(["guardian-mark gm-mono orb orb-mark", "warn", "--orb-size:40px"]);
    expect([shown(resting!)["data-tone"], shown(card!)["data-tone"], shown(card!).style!.split(";")[0]]).toEqual(["neutral", "accent", "--orb-size:102px"]);
    expect(shown(needs!)["aria-label"]).toBe("Your agent");
    // Still in a seat: no mood. Its mark alone: no ring round it, nor a seat drawn on one.
    expect(shown(card!)["data-mood"]).toBeUndefined();
    expect(walk(card!).map((child) => child.attrs.class).filter(Boolean)).toEqual(["seat seat-m seat-orb", "guardian-mark gm-mono orb orb-mark", "ibeam"]);
  });

  test("its state is said in words beside its name, in its tone; working with a live dot, so it isn't read as a quiet one", () => {
    const [working, needs, failed, resting] = withDocument(() => [stateChip("working"), stateChip("needs"), stateChip("failed"), stateChip("resting")] as unknown as (Node_ | null)[]);
    expect([working!.attrs["data-tone"], working!.children.map((child) => child.text || child.attrs.class)]).toEqual(["work", ["dot live", "Working"]]);
    expect([needs!.attrs["data-tone"], needs!.children.map((child) => child.text)]).toEqual(["needs", ["Needs you"]]);
    expect(failed!.attrs["data-tone"]).toBe("failed");
    // At rest there is nothing to say beyond its line.
    expect(resting).toBeNull();
  });
});

describe("your agent's mark", () => {
  test("is the I-beam in one ink, still, wherever it is drawn (on its tile as your agent's, alone as the app's): never the gold field", () => {
    const drawn = withDocument(() => [
      workerAvatar({ id: "primary", name: "Your agent", size: 48, expression: "working" }),
      seat({ id: "primary", name: "Your agent", state: "working", size: 88 }),
      orb({ size: 48, mood: "working", label: "Your agent: 3 at work" }),
      appMark(20),
    ] as unknown as Node_[]);
    for (const node of drawn) {
      const all = walk(node);
      // Its shape has one place, scripts/mark.ts: the polygon is drawn from it, in the page's ink (its class says so).
      const polygons = all.filter((child) => child.tag === "polygon");
      expect(polygons.map((p) => p.attrs.points)).toEqual([MARK_POLYGON]);
      expect(all.some((child) => child.tag === "svg" && child.attrs.viewBox === "0 0 100 100")).toBe(true);
      // No field: no canvas to paint gold on, and nothing that moves.
      expect(all.some((child) => child.tag === "canvas")).toBe(false);
      expect(all.some((child) => child.attrs["data-mood"] !== undefined)).toBe(false);
    }
    // Named where it stands alone; beside its name, decorative.
    expect(walk(drawn[2]!).find((child) => child.attrs.role === "img")?.attrs["aria-label"]).toBe("Your agent: 3 at work");
    expect(walk(drawn[3]!)[0]!.attrs["aria-hidden"]).toBe("true");
  });
});

describe("choosing an agent's glass", () => {
  test("eight colours and 22 shapes; untouched, it keeps what is saved; each kept as it is when you choose the other; or the one it would be given", () => {
    const saved = { v: 4, color: "#0084ba", shape: 13 };
    const editor = withDocument(() => avatarEditor({ id: () => "ada", name: () => "Ada", profile: saved }));
    expect(editor.value()).toBeUndefined();
    const all = () => walk(editor.element as unknown as Node_);
    const swatches = () => all().filter((child) => child.attrs.class === "orb-swatch");
    const shapes = () => all().filter((child) => child.attrs.class === "glass-shape");
    expect(swatches().map((swatch) => swatch.attrs["aria-label"])).toEqual(MARK_PALETTE.map((hue) => hue.name));
    expect(shapes().map((shape) => shape.attrs["aria-label"])).toEqual(GLASS_SHAPES.map((s) => s.name));
    expect(swatches().filter((swatch) => swatch.attrs["aria-pressed"] === "true").map((swatch) => swatch.attrs["aria-label"])).toEqual(["Sky"]);
    expect(shapes().filter((shape) => shape.attrs["aria-pressed"] === "true").map((shape) => shape.attrs["aria-label"])).toEqual([GLASS_SHAPES[13]!.name]);
    // A colour from before (v 2) is shown as the one of the eight it snaps to.
    const before = withDocument(() => avatarEditor({ id: () => "ada", name: () => "Ada", profile: { v: 2, color: "#3abeff" } }));
    const pressed = walk(before.element as unknown as Node_).filter((child) => child.attrs.class === "orb-swatch" && child.attrs["aria-pressed"] === "true");
    expect(pressed.map((swatch) => swatch.attrs["aria-label"])).toEqual([MARK_PALETTE[snapColor("#3abeff")]!.name]);
  });
});

test("this stylesheet animates nothing: a working agent's breathing is the glass's (ui/glass.ts), still where motion is reduced", () => {
  expect(AGENT_CSS).not.toMatch(/\banimation\s*:/);
  expect(AGENT_CSS).not.toContain("@keyframes");
});
