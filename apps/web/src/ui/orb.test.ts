import { describe, expect, test } from "bun:test";
import { agentColors } from "@invincible/core/avatar";
import { appMark, agentFace, orb, type OrbTone } from "./orb.ts";

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

// Your word, 23 November 2026: the primary, the one you talk to, as a Jarvis-like orb; since 26 November 2026 its field, and
// since the same evening its beam in place of the heads-up ring ("remove the old mark around [the primary]").
describe("Your agent's mark: the I-beam, with or without a canvas", () => {
  test("its box, its tone and its size, at any size and in any state, holding the I-beam alone", () => {
    for (const tone of ["neutral", "accent", "warn", "ok", "danger"] as OrbTone[]) {
      const node = draw(() => orb({ tone, size: 168 }) as unknown as Node_);
      expect([node.attrs.class, node.attrs["data-tone"], node.attrs.style]).toEqual(["orb orb-mark", tone, "--orb-size:168px"]);
      expect(node.children.map((child) => [child.tag, child.attrs.class])).toEqual([["svg", "ibeam"]]);
      for (const child of walk(node)) for (const key of Object.keys(child.attrs)) expect(key).not.toMatch(/^(on|href|xlink)/i);
    }
    // A tone it doesn't know is its rest; a size past its bounds is held to them.
    const [odd, tiny, huge] = draw(() => [orb({ tone: "pulse" as OrbTone, size: 36 }), orb({ size: 4 }), orb({ size: 900 })] as unknown as Node_[]);
    expect([odd!.attrs["data-tone"], tiny!.attrs.style, huge!.attrs.style]).toEqual(["neutral", "--orb-size:16px", "--orb-size:320px"]);
  });

  test("named when it stands alone, decorative beside its name; whatever it is doing, it doesn't move", () => {
    const [named, plain, moving] = draw(() => [orb({ label: "Your agent: at work" }), orb({}), orb({ mood: "working" })] as unknown as Node_[]);
    expect([named!.attrs.role, named!.attrs["aria-label"], named!.attrs["aria-hidden"]]).toEqual(["img", "Your agent: at work", undefined]);
    expect([plain!.attrs.role, plain!.attrs["aria-hidden"]]).toEqual([undefined, "true"]);
    expect([moving!.attrs.class, moving!.attrs["data-mood"]]).toEqual(["orb orb-mark", undefined]);
  });
});

describe("the app's mark", () => {
  test("the I-beam alone, its size held to the orbs' bounds, and never read aloud (what it is in is named)", () => {
    const [mark, tiny] = draw(() => [appMark(20), appMark(4)] as unknown as Node_[]);
    expect([mark!.attrs.class, mark!.attrs.style, mark!.attrs["aria-hidden"]]).toEqual(["orb app-mark", "--orb-size:20px", "true"]);
    expect(mark!.children.map((child) => [child.tag, child.attrs.class])).toEqual([["svg", "ibeam"]]);
    expect(tiny!.attrs.style).toBe("--orb-size:16px");
  });
});

describe("an agent's face, where there is no canvas", () => {
  test("its colour, its size and its name, and nothing drawn", () => {
    const face = draw(() => agentFace({ id: "ada", size: 34, label: "Ada · Working" }) as unknown as Node_);
    expect([face.attrs.class, face.attrs.style, face.attrs["data-tint"], face.attrs.role, face.attrs["aria-label"]]).toEqual(["agent-orb", "--orb-size:34px", agentColors("ada").tint, "img", "Ada · Working"]);
    expect(face.children).toEqual([]);
    const decorative = draw(() => agentFace({ id: "ada", size: 900 }) as unknown as Node_);
    expect([decorative.attrs["aria-hidden"], decorative.attrs.style]).toEqual(["true", "--orb-size:256px"]);
  });
});
