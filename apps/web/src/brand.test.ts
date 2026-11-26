import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { BRAND_PNGS, ZOOM } from "../../../scripts/brand.ts";
import { downscale, greyscale, png, renderField, rgba, roundTile } from "../../../scripts/field-icon.ts";
import { fieldPoints, project } from "./lib/field.ts";

const ROOT = resolve(import.meta.dir, "../../..");
/** A PNG's width, height and colour type (2: RGB, 6: RGBA), from its header. */
function header(path: string): { width: number; height: number; type: number } {
  const bytes = readFileSync(join(ROOT, path));
  expect([...bytes.subarray(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
  const view = new DataView(bytes.buffer, bytes.byteOffset);
  return { width: view.getUint32(16), height: view.getUint32(20), type: bytes[25]! };
}

// The owner's, 26 November 2026: "field aurum", then "maybe less fog, so it reads clearer".
describe("the app icon: your agent's field in gold, rendered as light", () => {
  test("the same pixels every time, on every machine: no randomness the seed doesn't give", () => {
    const a = renderField(48), b = renderField(48);
    expect(a.rgb.every((v, i) => v === b.rgb[i])).toBe(true);
    expect(png(rgba(a), 48)).toEqual(png(rgba(b), 48));
  });

  test("its heart is dark: no line comes into the core, so nothing lights its middle (no bright dot, no halo round one)", () => {
    for (const p of fieldPoints({ lines: 52 })) expect(Math.hypot(p.x, p.y, p.z)).toBeGreaterThan(0.33);
  });

  test("every form a platform masks keeps the field's lines inside the circle its mask keeps", () => {
    const reach = (zoom: number) => Math.max(...fieldPoints({ lines: 52 }).map((p) => { const q = project(p, 1, { zoom }); return Math.hypot(q.x - 0.5, q.y - 0.5); }));
    expect(reach(ZOOM.maskable)).toBeLessThanOrEqual(0.4); // a maskable icon: 80 % of it is always shown
    expect(reach(ZOOM.adaptive)).toBeLessThanOrEqual(66 / 108 / 2); // an adaptive icon: its 66 dp of 108
    expect(reach(ZOOM.tile)).toBeLessThanOrEqual(0.47); // on its tile, clear of iOS's rounding
  });

  test("its tile is rounded where a platform shows it as it is; the full-bleed forms are opaque; the badge is white", () => {
    const tile = roundTile(rgba(renderField(64)), 64);
    expect(tile[3]).toBe(0); // a corner: transparent
    expect(tile[(32 * 64 + 32) * 4 + 3]).toBe(255); // its middle: opaque
    const badge = rgba(renderField(64, { tile: null }), { opaque: false, mono: true });
    for (let i = 0; i < badge.length; i += 4) expect([badge[i], badge[i + 1], badge[i + 2]]).toEqual([255, 255, 255]);
    const grey = greyscale(rgba(renderField(16)));
    for (let i = 0; i < grey.length; i += 4) expect(grey[i] === grey[i + 1] && grey[i + 1] === grey[i + 2]).toBe(true);
    expect(downscale(tile, 64, 16)).toHaveLength(16 * 16 * 4);
  });

  test("every icon a platform takes is committed, at its size: the web app's and the README's", () => {
    for (const [path, size] of Object.entries(BRAND_PNGS)) {
      const h = header(path);
      expect([path, h.width, h.height]).toEqual([path, size, size]);
      // The full-bleed forms are opaque (iOS wants its touch icon so); the rounded and layered forms keep their alpha.
      const transparent = /icon-(64|192|512|mono-96)\.png$|assets\/icon\.png$|ic_launcher_(foreground|monochrome)\.png$/.test(path);
      expect([path, h.type]).toEqual([path, transparent ? 6 : 2]);
    }
  });

  test("the Apple app's: iOS's tile, its dark form the field alone (iOS backs it), its tinted form in grey; the Mac's at each size", () => {
    const set = "apps/apple/Invincible/Assets.xcassets/AppIcon.appiconset";
    expect(header(`${set}/AppIcon.png`)).toEqual({ width: 1024, height: 1024, type: 2 });
    expect(header(`${set}/AppIcon-dark.png`)).toEqual({ width: 1024, height: 1024, type: 6 });
    expect(header(`${set}/AppIcon-tinted.png`)).toEqual({ width: 1024, height: 1024, type: 6 });
    const contents = JSON.parse(readFileSync(join(ROOT, set, "Contents.json"), "utf8")) as { images: { filename: string; appearances?: { value: string }[] }[] };
    expect(contents.images.map((i) => [i.filename, i.appearances?.[0]?.value ?? "any"])).toEqual([["AppIcon.png", "any"], ["AppIcon-dark.png", "dark"], ["AppIcon-tinted.png", "tinted"]]);
    for (const px of [16, 32, 64, 128, 256, 512, 1024]) expect(header(`apps/apple/Invincible/Mac/MacAssets.xcassets/MacIcon.appiconset/icon_${px}.png`)).toMatchObject({ width: px, height: px });
    // The dark form is the field on nothing: its corners are transparent (no more than 1 of 255 there), where the tile's are its night. (At 256 px, as
    // at the 1024 the app takes; at 64 its bloom reaches the corners.)
    const dark = rgba(renderField(256, { tile: null }), { opaque: false });
    for (const at of [0, 255, 256 * 255, 256 * 256 - 1]) expect(dark[at * 4 + 3]).toBeLessThanOrEqual(1);
  });

  test("the pages and the manifest name only icons that are there, and the favicon is the field", () => {
    const manifest = JSON.parse(readFileSync(join(ROOT, "apps/web/src/manifest.webmanifest"), "utf8")) as { icons: { src: string; type: string }[] };
    for (const icon of manifest.icons) {
      expect(icon.type).toBe("image/png");
      expect(existsSync(join(ROOT, "apps/web/src", icon.src))).toBe(true);
    }
    expect(manifest.icons.some((i) => i.src === "/icon-maskable-512.png")).toBe(true);
    expect(readFileSync(join(ROOT, "apps/web/src/index.html"), "utf8")).toContain('<link rel="icon" href="/icon-64.png" type="image/png" sizes="64x64" />');
  });
});
