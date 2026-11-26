import { describe, expect, test } from "bun:test";
import { desktopAddress, DESKTOP_KEYS, hasDesktop, saysNoDesktop, screenPoint, shotSource } from "./desktop.ts";

const SCREEN = { width: 1280, height: 800 };

describe("a tap on the picture, as a place on the knight's screen", () => {
  test("the picture drawn at its own size: a tap is where it is", () => {
    const shown = { left: 0, top: 0, width: 1280, height: 800 };
    expect(screenPoint({ x: 0, y: 0 }, shown, SCREEN)).toEqual({ x: 0, y: 0 });
    expect(screenPoint({ x: 640, y: 400 }, shown, SCREEN)).toEqual({ x: 640, y: 400 });
    expect(screenPoint({ x: 1279.6, y: 799.9 }, shown, SCREEN)).toEqual({ x: 1279, y: 799 });
  });

  test("the picture drawn smaller, and somewhere on the page: the same place on the screen", () => {
    // A phone: 358 px wide (so 223.75 tall), 16 px from the left and 300 down the page.
    const shown = { left: 16, top: 300, width: 358, height: 223.75 };
    expect(screenPoint({ x: 16, y: 300 }, shown, SCREEN)).toEqual({ x: 0, y: 0 });
    expect(screenPoint({ x: 16 + 179, y: 300 + 111.875 }, shown, SCREEN)).toEqual({ x: 640, y: 400 });
    expect(screenPoint({ x: 16 + 358 * 0.25, y: 300 + 223.75 * 0.75 }, shown, SCREEN)).toEqual({ x: 320, y: 600 });
    // Drawn larger than the screen it shows (a wide window): scaled down the same way.
    expect(screenPoint({ x: 1280, y: 800 }, { left: 0, top: 0, width: 2560, height: 1600 }, SCREEN)).toEqual({ x: 640, y: 400 });
  });

  test("always whole numbers inside the screen: the far edge is its last pixel", () => {
    const shown = { left: 10, top: 10, width: 400, height: 250 };
    expect(screenPoint({ x: 410, y: 260 }, shown, SCREEN)).toEqual({ x: 1279, y: 799 });
    const point = screenPoint({ x: 133.3, y: 77.7 }, shown, SCREEN)!;
    expect([Number.isInteger(point.x), Number.isInteger(point.y)]).toEqual([true, true]);
  });

  test("a tap beside the picture, or on one that isn't drawn yet, is no place at all", () => {
    const shown = { left: 10, top: 10, width: 400, height: 250 };
    for (const tap of [{ x: 9, y: 100 }, { x: 411, y: 100 }, { x: 100, y: 9 }, { x: 100, y: 261 }]) expect([tap, screenPoint(tap, shown, SCREEN)]).toEqual([tap, null]);
    expect(screenPoint({ x: 5, y: 5 }, { left: 0, top: 0, width: 0, height: 0 }, SCREEN)).toBeNull();
    expect(screenPoint({ x: Number.NaN, y: 5 }, shown, SCREEN)).toBeNull();
  });

  test("the screen's size is the one the node sent with the picture", () => {
    expect(screenPoint({ x: 100, y: 50 }, { left: 0, top: 0, width: 200, height: 100 }, { width: 1920, height: 1080 })).toEqual({ x: 960, y: 540 });
  });
});

describe("an address for the knight's browser", () => {
  test("a whole address is taken as it is; a bare host gets https", () => {
    expect(desktopAddress("https://example.com/a?b=c")).toBe("https://example.com/a?b=c");
    expect(desktopAddress("  http://localhost:3000  ")).toBe("http://localhost:3000");
    expect(desktopAddress("about:blank")).toBe("about:blank");
    expect(desktopAddress("file:///work/out/report.html")).toBe("file:///work/out/report.html");
    expect(desktopAddress("example.com/docs")).toBe("https://example.com/docs");
    expect(desktopAddress("localhost:3000")).toBe("https://localhost:3000");
  });

  test("nothing, words with spaces, another scheme or too long an address is not one", () => {
    for (const text of ["", "   ", "two words", "javascript:alert(1)", "data:text/html,hi", "ftp://example.com", `https://example.com/${"a".repeat(2000)}`]) expect([text.slice(0, 30), desktopAddress(text)]).toEqual([text.slice(0, 30), null]);
  });
});

describe("whether a VM has a desktop", () => {
  test("its image says so", () => {
    expect(hasDesktop({ image: "galahad/desktop:1" })).toBe(true);
    expect(hasDesktop({ image: "galahad/workshop:1" })).toBe(false);
    expect(hasDesktop(null)).toBe(false);
    expect(hasDesktop(undefined)).toBe(false);
  });

  test("the node's refusal that a VM has none is told apart from every other", () => {
    expect(saysNoDesktop({ status: 424, message: "this teammate's VM has no desktop: have it made again with one (galahad knights provision <id> --remake --desktop)" })).toBe(true);
    expect(saysNoDesktop({ status: 424, message: "the desktop could not do that: exit 1" })).toBe(false);
    expect(saysNoDesktop({ status: 409, message: "the teammate's VM is exited" })).toBe(false);
    expect(saysNoDesktop({ status: 500, message: "has no desktop" })).toBe(false);
    expect(saysNoDesktop(new Error("has no desktop"))).toBe(false);
    expect(saysNoDesktop(null)).toBe(false);
  });
});

describe("the keys offered beside the picture", () => {
  test("are names the desktop takes", () => {
    expect(DESKTOP_KEYS.map((key) => key.label)).toEqual(["Return", "Tab", "Escape", "Backspace"]);
    for (const key of DESKTOP_KEYS) expect([key.key, /^[A-Za-z0-9_+]{1,40}$/.test(key.key)]).toEqual([key.key, true]);
    // (X names the key BackSpace.)
    expect(DESKTOP_KEYS.at(-1)!.key).toBe("BackSpace");
  });
});

describe("the picture the node sent, as an image's source", () => {
  test("a JPEG or a PNG in base64 is shown as it came", () => {
    expect(shotSource({ shot: { mediaType: "image/jpeg", data: "/9j/4AAQSkZJRg==" }, width: 1280, height: 800 })).toBe("data:image/jpeg;base64,/9j/4AAQSkZJRg==");
    expect(shotSource({ shot: { mediaType: "image/png", data: "iVBORw0KGgo=" }, width: 1280, height: 800 })).toBe("data:image/png;base64,iVBORw0KGgo=");
  });

  test("anything else is not shown: another kind of file, data that isn't base64, nothing, or a screen with no size", () => {
    const shots = [
      { mediaType: "image/svg+xml", data: "PHN2Zz4=" },
      { mediaType: "text/html", data: "PGgxPg==" },
      { mediaType: "image/jpeg", data: 'abc"onerror="alert(1)' },
      { mediaType: "image/jpeg", data: "abc def" },
      { mediaType: "image/jpeg", data: "" },
    ];
    for (const shot of shots) expect([shot.mediaType, shotSource({ shot, width: 1280, height: 800 })]).toEqual([shot.mediaType, null]);
    expect(shotSource({ shot: { mediaType: "image/jpeg", data: "/9j/" }, width: 0, height: 800 })).toBeNull();
    expect(shotSource({ shot: { mediaType: "image/jpeg", data: "/9j/" }, width: 1280, height: Number.NaN })).toBeNull();
  });
});
