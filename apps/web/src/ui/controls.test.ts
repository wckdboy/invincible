import { describe, expect, test } from "bun:test";
import { onePrimary } from "./controls.ts";

/*
 * One primary action on a screen (the usability pass, I11: the Inbox showed three ink buttons at once). Of the primary
 * buttons a part of a page holds, the first shown keeps the ink, the others are default buttons that do the same.
 */

/** An element as onePrimary reads it: its parent, whether it is hidden, its classes and its data. */
class El {
  parentElement: El | null = null;
  hidden = false;
  readonly dataset: Record<string, string> = {};
  readonly classes: Set<string>;
  readonly children: El[] = [];
  constructor(classes: string) {
    this.classes = new Set(classes.split(" ").filter(Boolean));
  }
  get classList() {
    return { contains: (name: string) => this.classes.has(name), toggle: (name: string, on: boolean) => (on ? this.classes.add(name) : this.classes.delete(name)) };
  }
  add(...children: El[]): this {
    for (const child of children) {
      child.parentElement = this;
      this.children.push(child);
    }
    return this;
  }
  /** Every button below it, in reading order, that is primary or was made so. */
  querySelectorAll(): El[] {
    const found: El[] = [];
    const walk = (el: El) => {
      for (const child of el.children) {
        if (child.classes.has("btn") && (child.classes.has("primary") || "primary" in child.dataset)) found.push(child);
        walk(child);
      }
    };
    walk(this);
    return found;
  }
}

const primary = () => new El("btn primary");
const run = (root: El) => onePrimary(root as unknown as ParentNode);
const inked = (...buttons: El[]) => buttons.map((button) => button.classes.has("primary"));

describe("one primary action on a screen", () => {
  test("the first decision keeps the ink; the others are default buttons", () => {
    const [allow, seal, keep] = [primary(), primary(), primary()];
    const root = new El("page").add(new El("card").add(allow, new El("btn")), new El("card").add(seal), new El("card").add(keep));
    run(root);
    expect(inked(allow, seal, keep)).toEqual([true, false, false]);
  });

  test("when the first is answered and goes, the next one takes the ink", () => {
    const [allow, seal] = [primary(), primary()];
    const root = new El("page").add(new El("card").add(allow), new El("card").add(seal));
    run(root);
    root.children.splice(0, 1);
    run(root);
    expect(inked(seal)).toEqual([true]);
  });

  test("one in a hidden part doesn't count, but a page's body waiting to be shown whole does", () => {
    const [hiddenOne, shownOne] = [primary(), primary()];
    const hiddenSection = new El("section").add(hiddenOne);
    hiddenSection.hidden = true;
    const root = new El("page").add(hiddenSection, new El("section").add(shownOne));
    run(root);
    expect(inked(hiddenOne, shownOne)).toEqual([false, true]);
    // (Seen on the Inbox: its parts are drawn while its body waits to be shown whole, so no button kept the ink.)
    const waiting = new El("page-body-parts").add(primary());
    waiting.hidden = true;
    const page = new El("page").add(waiting);
    run(page);
    expect(inked(waiting.children[0]!)).toEqual([true]);
  });
});
