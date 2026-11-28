import { describe, expect, test } from "bun:test";
import { browsersOwn, KEY_ROWS, keyAction, keyWords, type Press } from "./keys.ts";

/*
 * T3 Code's keys, and Invincible's own where T3 Code leaves a key free: ⌘ on a Mac, Ctrl elsewhere; a bracket or a digit
 * read by where it lies on the keyboard too, so the owner's Danish keyboard has them where a US one does.
 */

/** Where a key is pressed: the Mac app's window, a Mac's browser, a PC's browser. */
const APP = { mac: true, app: true };
const MAC_BROWSER = { mac: true, app: false };
const PC = { mac: false, app: false };

const press = (key: string, more: Partial<Press> = {}): Press => {
  const code = /^[a-z]$/i.test(key) ? `Key${key.toUpperCase()}` : /^[0-9]$/.test(key) ? `Digit${key}` : key === "[" || key === "{" ? "BracketLeft" : key === "]" || key === "}" ? "BracketRight" : "";
  return { key, code, metaKey: true, ctrlKey: false, shiftKey: false, altKey: false, ...more };
};

describe("keyAction", () => {
  test("T3 Code's: the palette, a new thread, the sidebar, the panel and the terminal", () => {
    expect(keyAction(press("k"), APP)).toBe("palette");
    expect(keyAction(press("n"), APP)).toBe("new-chat");
    expect(keyAction(press("b"), APP)).toBe("sidebar");
    expect(keyAction(press("d"), APP)).toBe("panel");
    expect(keyAction(press("j"), APP)).toBe("terminal");
    // (A letter is the letter, whichever case Shift or Caps Lock gives it.)
    expect(keyAction(press("D"), APP)).toBe("panel");
  });

  test("the threads: the first nine by number, the one above and below, back and forward", () => {
    expect(keyAction(press("1"), APP)).toEqual({ thread: 1 });
    expect(keyAction(press("9"), APP)).toEqual({ thread: 9 });
    expect(keyAction(press("["), APP)).toBe("back");
    expect(keyAction(press("]"), APP)).toBe("forward");
    expect(keyAction(press("{", { shiftKey: true }), APP)).toBe("previous");
    expect(keyAction(press("}", { shiftKey: true }), APP)).toBe("next");
  });

  test("Invincible's own where T3 Code leaves a key free: your agent, Needs you, giving a task", () => {
    expect(keyAction(press("0"), APP)).toBe("primary");
    expect(keyAction(press("I", { shiftKey: true }), APP)).toBe("needs");
    expect(keyAction(press("N", { shiftKey: true }), APP)).toBe("give");
  });

  test("a Danish keyboard has them where a US one does: Å is [, ¨ is ], a shifted digit still its digit's key", () => {
    // (What the key types differs; where it lies doesn't.)
    expect(keyAction({ ...press("å"), code: "BracketLeft" }, APP)).toBe("back");
    expect(keyAction({ ...press("Å", { shiftKey: true }), code: "BracketLeft" }, APP)).toBe("previous");
    expect(keyAction({ ...press("¨"), code: "BracketRight" }, APP)).toBe("forward");
    expect(keyAction({ ...press("!"), code: "Digit1" }, APP)).toEqual({ thread: 1 });
  });

  test("⌘ on a Mac, Ctrl elsewhere; with ⌥, or both, or neither, nothing of the app's", () => {
    expect(keyAction(press("d", { metaKey: false, ctrlKey: true }), PC)).toBe("panel");
    // A Mac's Ctrl is the shell's and the field's (⌃D deletes forward), Ctrl+⌘ a system's.
    expect(keyAction(press("d", { metaKey: false, ctrlKey: true }), APP)).toBeNull();
    expect(keyAction(press("d", { ctrlKey: true }), APP)).toBeNull();
    // ⌘ elsewhere is the system's (the Windows key).
    expect(keyAction(press("d"), PC)).toBeNull();
    // ⌥ types characters on a Mac (⌥8 is a Danish [); AltGr is Ctrl+Alt elsewhere.
    expect(keyAction(press("[", { altKey: true }), APP)).toBeNull();
    expect(keyAction(press("d", { metaKey: false, ctrlKey: true, altKey: true }), PC)).toBeNull();
    expect(keyAction(press("d", { metaKey: false }), APP)).toBeNull();
  });

  test("in a browser, its tabs, its zoom and its history stay its own; the Mac app's window has none, so there they are the app's", () => {
    for (const key of [press("1"), press("9"), press("0"), press("["), press("]"), press("{", { shiftKey: true }), press("}", { shiftKey: true })]) {
      expect(keyAction(key, MAC_BROWSER)).toBeNull();
      expect(keyAction(key, APP)).not.toBeNull();
    }
    expect(browsersOwn({ thread: 3 })).toBe(true);
    // The rest are the app's in a browser too, as T3 Code's are.
    for (const [key, action] of [["k", "palette"], ["n", "new-chat"], ["b", "sidebar"], ["d", "panel"], ["j", "terminal"]] as const) expect(keyAction(press(key), MAC_BROWSER)).toBe(action);
    expect(keyAction(press("I", { shiftKey: true }), MAC_BROWSER)).toBe("needs");
    expect(keyAction(press("d", { metaKey: false, ctrlKey: true }), PC)).toBe("panel");
    expect(keyAction(press("1", { metaKey: false, ctrlKey: true }), PC)).toBeNull();
  });

  test("keys it doesn't take stay the browser's and the field's", () => {
    for (const key of ["c", "v", "x", "z", "a", "f", "w", "t", "q", "s", "p"]) expect(keyAction(press(key), APP)).toBeNull();
    // A shifted digit (⌘⇧3 is the Mac's screenshot), or a letter Shift gives nothing to.
    expect(keyAction(press("#", { shiftKey: true, code: "Digit3" } as Partial<Press>), APP)).toBeNull();
    expect(keyAction(press("D", { shiftKey: true }), APP)).toBeNull();
  });
});

describe("keyWords", () => {
  test("as a Mac's menus write keys, or as Windows and Linux do", () => {
    expect(keyWords(["mod", "Shift", "N"], true)).toBe("⌘⇧N");
    expect(keyWords(["mod", "D"], false)).toBe("Ctrl+D");
    expect(keyWords(["mod", "Shift", "N"], false)).toBe("Ctrl+Shift+N");
  });

  test("the sheet lists every key the app takes, the Mac app's window's alone said so", () => {
    const listed = new Set(KEY_ROWS.map((row) => row.label));
    expect(listed.size).toBe(KEY_ROWS.length);
    expect(KEY_ROWS.every((row) => row.keys[0] === "mod")).toBe(true);
    expect(KEY_ROWS.filter((row) => row.app).map((row) => row.keys.at(-1))).toEqual(["0", "1–9", "[ ]", "[ ]"]);
  });
});
