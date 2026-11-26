import { expect, test } from "bun:test";
import { MARK_POLYGON } from "../../../../scripts/mark.ts";
import { PLACES } from "../lib/nav.ts";
import { icon } from "./icons.ts";

/** Captures the icon's real createElementNS calls, without a browser. */
class Node_ {
  readonly attrs: Record<string, string> = {};
  readonly children: Node_[] = [];
  constructor(readonly tag: string) {}
  setAttribute(key: string, value: string) { this.attrs[key] = value; }
  appendChild(child: Node_) { this.children.push(child); return child; }
}
function draw(name: Parameters<typeof icon>[0]): Node_ {
  const original = Object.getOwnPropertyDescriptor(globalThis, "document");
  Object.defineProperty(globalThis, "document", { configurable: true, value: { createElementNS: (_: string, tag: string) => new Node_(tag) } });
  try { return icon(name) as unknown as Node_; }
  finally { if (original) Object.defineProperty(globalThis, "document", original); else Reflect.deleteProperty(globalThis, "document"); }
}
test("the agents' icon is three of them, apart, drawn as strokes on the grid; your agent's mark is the I-beam, filled", () => {
  const agents = draw("agents").children;
  expect(agents).toHaveLength(3);
  for (const one of agents) expect(one.attrs.fill).not.toBe("currentColor");
  // The I-beam of scripts/mark.ts (a 100 box), on the icons' 24 px grid: the same twelve corners, never redrawn by hand.
  const [beam, ...rest] = draw("mark").children;
  expect(rest).toEqual([]);
  expect(beam!.attrs).toMatchObject({ fill: "currentColor", stroke: "none" });
  const corners = (beam!.attrs.d ?? "").replace(/^M|z$/g, "").split("L").map((pair) => pair.split(" ").map(Number));
  expect(corners).toEqual(MARK_POLYGON.split(" ").map((pair) => pair.split(",").map((n) => Math.round(Number(n) * 0.24 * 100) / 100)));
});

test("the agents are shown by their own icon wherever the app names the place", () => {
  expect(PLACES.find((place) => place.id === "team")!.icon).toBe("agents");
});
