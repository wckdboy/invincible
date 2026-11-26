import { describe, expect, test } from "bun:test";
import { syncChildren } from "./dom.ts";

/** A parent's children as the DOM keeps them (a list, each child knowing the next), and every change made to them. */
class FakeNode {
  parent: FakeParent | null = null;
  constructor(readonly name: string) {}
  get nextSibling(): FakeNode | null {
    const siblings = this.parent?.children ?? [];
    return siblings[siblings.indexOf(this) + 1] ?? null;
  }
}
class FakeParent {
  children: FakeNode[] = [];
  readonly changes: string[] = [];
  get firstChild(): FakeNode | null { return this.children[0] ?? null; }
  insertBefore(node: FakeNode, before: FakeNode | null): FakeNode {
    if (node.parent) node.parent.children.splice(node.parent.children.indexOf(node), 1);
    this.children.splice(before ? this.children.indexOf(before) : this.children.length, 0, node);
    node.parent = this;
    this.changes.push(`put ${node.name}`);
    return node;
  }
  removeChild(node: FakeNode): FakeNode {
    this.children.splice(this.children.indexOf(node), 1);
    node.parent = null;
    this.changes.push(`take ${node.name}`);
    return node;
  }
}
const nodes = (...names: string[]) => names.map((name) => new FakeNode(name));
const names = (parent: FakeParent) => parent.children.map((child) => child.name);
const sync = (parent: FakeParent, next: FakeNode[]) => syncChildren(parent as unknown as Element, next as unknown as Node[]);

describe("putting a list's children in order without rebuilding them", () => {
  test("children already in their place are left alone: nothing is moved or taken out", () => {
    const parent = new FakeParent();
    const [a, b, c] = nodes("a", "b", "c");
    sync(parent, [a!, b!, c!]);
    parent.changes.length = 0;
    sync(parent, [a!, b!, c!]);
    expect(parent.changes).toEqual([]);
  });

  test("a new child goes in its place, and one that went is taken out; the rest stay where they were", () => {
    const parent = new FakeParent();
    const [a, b, c, d] = nodes("a", "b", "c", "d");
    sync(parent, [a!, b!, c!]);
    parent.changes.length = 0;
    sync(parent, [a!, c!, d!]);
    expect(names(parent)).toEqual(["a", "c", "d"]);
    // (Only b went and d came: a and c were never taken out of the page, so focus and opened details stay.)
    expect(parent.changes).toEqual(["take b", "put d"]);
  });

  test("any order is reached from any other, and a child rebuilt in place replaces the old one", () => {
    const parent = new FakeParent();
    const [a, b, c, d] = nodes("a", "b", "c", "d");
    sync(parent, [a!, b!, c!, d!]);
    sync(parent, [d!, b!, a!]);
    expect(names(parent)).toEqual(["d", "b", "a"]);
    const [b2] = nodes("b2");
    sync(parent, [d!, b2!, a!]);
    expect(names(parent)).toEqual(["d", "b2", "a"]);
    sync(parent, []);
    expect(names(parent)).toEqual([]);
  });
});
