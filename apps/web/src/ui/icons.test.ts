import { expect, test } from "bun:test";
import { ROUNDTABLE } from "../brand.ts";
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
/** The points a path passes through: each move and line's, and each arc's end. */
const points = (d: string): [number, number][] => [...d.matchAll(/([MLA])([^MLAZ]*)/g)].map(([, command, args]) => {
  const n = args!.trim().split(/[\s,]+/).map(Number);
  return command === "A" ? [n[5]!, n[6]!] : [n[0]!, n[1]!];
});
const box = (d: string) => {
  const p = points(d);
  const xs = p.map(([x]) => x), ys = p.map(([, y]) => y);
  return { left: Math.min(...xs), right: Math.max(...xs), top: Math.min(...ys), bottom: Math.max(...ys) };
};

test("the Roundtable's icon is the table from above, its chairs round it, Galahad's the deeper one and the one in red", () => {
  const [table, ...chairs] = draw("roundtable").children;
  // The table: a ring, filled between its two edges (so no stroke width decides where they fall).
  expect(table!.attrs).toMatchObject({ fill: "currentColor", stroke: "none" });
  expect(table!.attrs.d!.match(/M/g)).toHaveLength(2);
  // Six chairs, solid; one of them Galahad's, the Siege Perilous, in the page's red for it.
  expect(chairs).toHaveLength(6);
  for (const chair of chairs) expect(chair.attrs).toMatchObject({ fill: "currentColor", stroke: "none" });
  const siege = chairs.filter((chair) => chair.attrs.class === "icon-siege");
  expect(siege).toHaveLength(1);
  const his = box(siege[0]!.attrs.d!);
  const across = box(chairs.map((chair) => chair.attrs.d!).find((d) => box(d).top > 18)!);
  expect(his.bottom - his.top).toBeGreaterThan(across.bottom - across.top);
  // Every corner on the 24-unit grid.
  for (const chair of chairs) for (const [x, y] of points(chair.attrs.d!)) expect(x >= 0 && x <= 24 && y >= 0 && y <= 24).toBe(true);
});

test("drawn at 24 px it is pixel-true: the table's outer edge and the straight chairs' edges fall on whole pixels, every chair as far from the table", () => {
  const { table, chair, siege } = ROUNDTABLE;
  expect(table.r + table.width / 2).toBe(6);
  for (const [R, d, w] of [[chair.R, chair.d, chair.w], [siege.R, siege.d, siege.w]] as const) {
    // Its inner edge two units out from the table's outer one.
    expect(R - d / 2 - (table.r + table.width / 2)).toBe(2);
    // Its edges, upright at the top and the bottom, on whole units.
    for (const edge of [12 - w / 2, 12 + w / 2, 12 + R - d / 2, 12 + R + d / 2]) expect(Number.isInteger(edge)).toBe(true);
  }
  const [, ...chairs] = draw("roundtable").children;
  // The two on the vertical through the middle: Galahad's at the top, the one across from it at the bottom.
  const upright = chairs.map((c) => box(c.attrs.d!)).filter((b) => b.left + b.right === 24);
  expect(upright).toHaveLength(2);
  for (const b of upright) for (const edge of [b.left, b.right, b.top, b.bottom]) expect(Number.isInteger(edge)).toBe(true);
});

test("the Roundtable is shown by its own icon wherever the app names the place", () => {
  expect(PLACES.find((place) => place.id === "team")!.icon).toBe("roundtable");
});
