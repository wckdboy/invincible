import { expect, test } from "bun:test";
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
test("the agents' icon is three of them, apart, drawn as strokes on the grid; the mark is a ring round a filled core", () => {
  const agents = draw("roundtable").children;
  expect(agents).toHaveLength(3);
  for (const one of agents) expect(one.attrs.fill).not.toBe("currentColor");
  const [ring, core] = draw("mark").children;
  expect(ring!.attrs.fill).not.toBe("currentColor");
  expect(core!.attrs).toMatchObject({ fill: "currentColor", stroke: "none" });
});

test("the Roundtable is shown by its own icon wherever the app names the place", () => {
  expect(PLACES.find((place) => place.id === "team")!.icon).toBe("roundtable");
});
