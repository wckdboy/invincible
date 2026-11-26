import { describe, expect, test } from "bun:test";
import { AVATAR_EXPRESSIONS, defaultAvatar, KNIGHT_TINTS, knightColors, lookProfile } from "@galahad/core/avatar";
import { avatarEditor, KNIGHT_CSS, leadMark, seat, stateChip, workerAvatar, type WorkerAvatarOptions } from "./avatar.ts";

/** Captures the renderer's real createElement and createElementNS calls, without an HTML parser or a browser (and with
 * no canvas, so a knight's orb is its box alone and Galahad's his ring and seat in SVG). */
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
const orbOf = (node: Node_) => walk(node).find((child) => child.attrs.class === "knight-orb")!;
const HEX = /^#[0-9a-f]{6}$/i;

describe("knights at the page's boundary", () => {
  test("nothing from a profile or a name reaches a URL, a style or a paint, but a colour checked to be six hex digits", () => {
    const name = '<image href="https://invalid.example/pixel" onload="alert(1)">';
    const profiles = [
      { ...defaultAvatar("ada"), color: "url(https://invalid.example/paint)", accent: '#fff" onload="alert(1)', form: "foreignObject", onload: "alert(1)" },
      { v: 2, color: "url(https://invalid.example/paint)" },
      { v: 2, color: '#3abeff" onload="alert(1)' },
      { v: 2, color: "#3abeff", onload: "alert(1)" },
    ];
    for (const profile of profiles) {
      const [node] = render({ id: "ada", name, profile, expression: 'idle" onload="alert(1)' as never });
      expect(orbOf(node!).attrs["aria-label"]).toBe(`${name} · idle`);
      expect(node!.attrs["data-expression"]).toBe("idle");
      // A colour that isn't one is its handle's.
      expect(orbOf(node!).attrs["data-tint"]).toBe(knightColors("ada").tint);
    }
    for (const drawn of render(...AVATAR_EXPRESSIONS.flatMap((expression) => [{ id: "ada", name, profile: profiles[0], expression, size: 96 }, { id: "ada", name, profile: { v: 2, color: "#3ABEFF" }, expression, size: 200 }]))) {
      for (const child of walk(drawn)) {
        expect(child.ns === "html" ? ["span", "#text"] : ["svg", "path"]).toContain(child.tag);
        for (const [key, value] of Object.entries(child.attrs)) {
          expect(key).not.toMatch(/^(on|href|xlink|src)/i);
          if (key !== "aria-label") expect(value).not.toContain("invalid.example");
          if (key === "style") expect(value).toMatch(/^--orb-size:\d+px$/);
          if (key === "fill") expect(value).toBe("none");
          if (key === "data-tint" || key === "stroke") expect(value).toMatch(HEX);
        }
      }
    }
  });

  test("its colour is the one you chose for it, or its handle's; a look from the drawings colours nothing", () => {
    const [chosen, handle, look] = render({ id: "ada", name: "Ada", profile: { v: 2, color: "#3ABEFF" }, still: true }, { id: "ada", name: "Ada", still: true }, { id: "ada", name: "Ada", profile: lookProfile("bors"), still: true });
    expect(orbOf(chosen!).attrs["data-tint"]).toBe("#3abeff");
    expect(orbOf(handle!).attrs["data-tint"]).toBe(knightColors("ada").tint);
    expect(orbOf(look!).attrs["data-tint"]).toBe(knightColors("ada").tint);
    expect(KNIGHT_TINTS).toContain(orbOf(handle!).attrs["data-tint"] as never);
    // Still, as a speaker in a conversation's history: named as the knight's orb, and doing nothing.
    expect(orbOf(handle!).attrs["aria-label"]).toBe("Ada's orb");
  });

  test("a face says nothing a row doesn't: still where it is given no mood, named for what it is doing where it is", () => {
    const [still, working, resting] = render({ id: "ada", name: "Ada", still: true, size: 28 }, { id: "ada", name: "Ada", expression: "working", size: 34 }, { id: "ada", name: "Ada", size: 160 });
    expect([orbOf(still!).attrs["aria-label"], orbOf(working!).attrs["aria-label"], orbOf(resting!).attrs["aria-label"]]).toEqual(["Ada's orb", "Ada · working", "Ada · idle"]);
    expect([orbOf(still!).attrs.style, orbOf(working!).attrs.style, orbOf(resting!).attrs.style]).toEqual(["--orb-size:28px", "--orb-size:34px", "--orb-size:160px"]);
    // (No canvas here: nothing is drawn, and nothing else is put in its place.)
    for (const node of [still!, working!, resting!]) expect(orbOf(node).children).toEqual([]);
  });
});

describe("a knight in its seat", () => {
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
    expect(orbOf(working!).attrs.style).toBe("--orb-size:32px");
    expect(orbOf(resting!).attrs["aria-label"]).toBe("Ada");
    expect(working!.attrs.style).toBeUndefined();
  });

  test("Galahad's seat is his orb, in the room a face and its seat take; where he stands is kept on it", () => {
    const [needs, resting, card] = withDocument(() => [
      seat({ id: "galahad", name: "Galahad", state: "needs", expression: "asking", size: 32 }),
      seat({ id: "galahad", name: "Galahad", size: 32 }),
      seat({ id: "galahad", name: "Galahad", state: "working", size: 88 }),
    ] as unknown as Node_[]);
    expect([needs!.attrs.class, needs!.attrs["data-state"]]).toEqual(["seat seat-s seat-orb", "needs"]);
    const shown = (node: Node_) => node.children[0]!.attrs;
    expect([shown(needs!).class, shown(needs!)["data-tone"], shown(needs!).style]).toEqual(["orb", "warn", "--orb-size:40px"]);
    expect([shown(resting!)["data-tone"], shown(card!)["data-tone"], shown(card!).style]).toEqual(["neutral", "accent", "--orb-size:102px"]);
    expect(shown(needs!)["aria-label"]).toBe("Galahad");
    // Still in a seat: no mood. (No canvas here: his ring and seat, in SVG.)
    expect(shown(card!)["data-mood"]).toBeUndefined();
    expect(walk(card!).map((child) => child.attrs.class).filter(Boolean)).toContain("orb-seat");
  });

  test("its state is said in words beside its name, in its tone; working with a live dot, so it isn't read as a quiet one", () => {
    const [working, needs, failed, resting] = withDocument(() => [stateChip("working"), stateChip("needs"), stateChip("failed"), stateChip("resting")] as unknown as (Node_ | null)[]);
    expect([working!.attrs["data-tone"], working!.children.map((child) => child.text || child.attrs.class)]).toEqual(["work", ["dot live", "Working"]]);
    expect([needs!.attrs["data-tone"], needs!.children.map((child) => child.text)]).toEqual(["needs", ["Needs you"]]);
    expect(failed!.attrs["data-tone"]).toBe("failed");
    // At rest there is nothing to say beyond its line.
    expect(resting).toBeNull();
  });

  test("the one who leads wears a mark in words, which says what leading means", () => {
    const [lin, galahad] = withDocument(() => [leadMark("Lin"), leadMark()] as unknown as Node_[]);
    expect(lin!.children.map((child) => child.text)).toEqual(["Leads"]);
    expect(lin!.attrs.title).toContain("what you say to a room Lin sits in without naming anyone is its to answer");
    expect(galahad!.attrs.title).toBe("Leads the Roundtable");
  });
});

describe("choosing a knight's colour", () => {
  test("untouched, it keeps what is saved; a swatch chooses that colour; its handle's colour lets it go", () => {
    const editor = withDocument(() => avatarEditor({ id: () => "ada", name: () => "Ada", profile: { v: 2, color: "#3abeff" } }));
    expect(editor.value()).toBeUndefined();
    const swatches = walk(editor.element as unknown as Node_).filter((child) => child.attrs.class === "orb-swatch");
    expect(swatches).toHaveLength(24);
    expect(swatches.filter((swatch) => swatch.attrs["aria-pressed"] === "true").map((swatch) => swatch.attrs.style)).toEqual(["--swatch:#3abeff"]);
    for (const swatch of swatches) expect(swatch.attrs["aria-label"]).toMatch(/^[A-Z][a-z]+$/);
  });
});

test("a face moves by the orbs' one clock, which stops for reduced motion: its stylesheet animates nothing", () => {
  expect(KNIGHT_CSS).not.toMatch(/\banimation\s*:/);
  expect(KNIGHT_CSS).not.toContain("@keyframes");
});
