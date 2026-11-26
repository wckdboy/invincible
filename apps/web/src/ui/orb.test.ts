import { describe, expect, test } from "bun:test";
import { knightColors } from "@galahad/core/avatar";
import { GALAHAD_RING } from "../lib/field-orb.ts";
import { knightFace, orb, type OrbTone } from "./orb.ts";

/** Captures the renderer's real createElement and createElementNS calls, without an HTML parser or a browser (and with
 * no canvas: what an orb is where there is nothing to draw it on). */
class Node_ {
  readonly attrs: Record<string, string> = {};
  readonly children: Node_[] = [];
  text = "";
  constructor(readonly tag: string, readonly ns: "html" | "svg") {}
  setAttribute(key: string, value: string) { this.attrs[key] = value; }
  appendChild(child: Node_) { this.children.push(child); return child; }
  addEventListener() {}
}
function draw<T>(make: () => T): T {
  const original = Object.getOwnPropertyDescriptor(globalThis, "document");
  Object.defineProperty(globalThis, "document", { configurable: true, value: {
    createElement: (tag: string) => new Node_(tag, "html"),
    createElementNS(namespace: string, tag: string) {
      expect(namespace).toBe("http://www.w3.org/2000/svg");
      return new Node_(tag, "svg");
    },
    createTextNode: (text: string) => Object.assign(new Node_("#text", "html"), { text }),
  } });
  try { return make(); }
  finally { if (original) Object.defineProperty(globalThis, "document", original); else Reflect.deleteProperty(globalThis, "document"); }
}
const walk = (node: Node_): Node_[] => [node, ...node.children.flatMap(walk)];

// Your word, 23 November 2026: Galahad, the one you talk to, as a Jarvis-like orb; since 26 November 2026 his field.
describe("Galahad's orb, where there is no canvas", () => {
  test("his ring and his seat alone, from fixed shapes, at any size and in any state", () => {
    for (const tone of ["neutral", "accent", "warn", "ok", "danger"] as OrbTone[]) {
      const node = draw(() => orb({ tone, size: 168 }) as unknown as Node_);
      expect([node.attrs.class, node.attrs["data-tone"], node.attrs.style]).toEqual(["orb", tone, "--orb-size:168px"]);
      const shapes = walk(node).filter((child) => child.ns === "svg");
      expect(shapes.map((child) => child.tag)).toEqual(["svg", "path", "path"]);
      expect(shapes.slice(1).map((child) => child.attrs.class)).toEqual(["orb-ring", "orb-seat"]);
      for (const child of walk(node)) for (const key of Object.keys(child.attrs)) expect(key).not.toMatch(/^(on|href|xlink)/i);
      // Five arcs of ink, and his seat in oxblood (the dark page's here: nothing says the page is light).
      expect(shapes[1]!.attrs.d!.match(/M/g)).toHaveLength(5);
      expect([shapes[1]!.attrs.stroke, shapes[2]!.attrs.stroke]).toEqual([GALAHAD_RING.ink.dark, GALAHAD_RING.oxblood.dark]);
    }
    // A tone it doesn't know is its rest; a size past its bounds is held to them.
    const [odd, tiny, huge] = draw(() => [orb({ tone: "pulse" as OrbTone, size: 36 }), orb({ size: 4 }), orb({ size: 900 })] as unknown as Node_[]);
    expect([odd!.attrs["data-tone"], tiny!.attrs.style, huge!.attrs.style]).toEqual(["neutral", "--orb-size:16px", "--orb-size:320px"]);
  });

  test("named when it stands alone, decorative beside his name; in a mood it says so", () => {
    const [named, plain, moving] = draw(() => [orb({ label: "Galahad: at work" }), orb({}), orb({ mood: "working" })] as unknown as Node_[]);
    expect([named!.attrs.role, named!.attrs["aria-label"], named!.attrs["aria-hidden"]]).toEqual(["img", "Galahad: at work", undefined]);
    expect([plain!.attrs.role, plain!.attrs["aria-hidden"]]).toEqual([undefined, "true"]);
    // (With nothing to draw on, nothing moves: no "orb-live".)
    expect([moving!.attrs.class, moving!.attrs["data-mood"]]).toEqual(["orb", "working"]);
  });
});

describe("a knight's face, where there is no canvas", () => {
  test("its colour, its size and its name, and nothing drawn", () => {
    const face = draw(() => knightFace({ id: "ada", size: 34, label: "Ada · Working" }) as unknown as Node_);
    expect([face.attrs.class, face.attrs.style, face.attrs["data-tint"], face.attrs.role, face.attrs["aria-label"]]).toEqual(["knight-orb", "--orb-size:34px", knightColors("ada").tint, "img", "Ada · Working"]);
    expect(face.children).toEqual([]);
    const decorative = draw(() => knightFace({ id: "ada", size: 900 }) as unknown as Node_);
    expect([decorative.attrs["aria-hidden"], decorative.attrs.style]).toEqual(["true", "--orb-size:256px"]);
  });
});
