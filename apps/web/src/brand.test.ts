import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { BRAND_PNGS, ZOOM } from "../../../scripts/brand.ts";
import { downscale, greyscale, png, roundTile } from "../../../scripts/field-icon.ts";
import { MARK_FORMS, MARK_RECTS, markCoverage, markReach, renderMark } from "../../../scripts/mark.ts";

const ROOT = resolve(import.meta.dir, "../../..");
/** A PNG's width, height and colour type (2: RGB, 6: RGBA), from its header. */
function header(path: string): { width: number; height: number; type: number } {
  const bytes = readFileSync(join(ROOT, path));
  expect([...bytes.subarray(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
  const view = new DataView(bytes.buffer, bytes.byteOffset);
  return { width: view.getUint32(16), height: view.getUint32(20), type: bytes[25]! };
}

// The owner's, 26 November 2026: "simpler, still sleek and cool, logo, minimal bold monochrome" (it replaced Field · Aurum).
describe("the app icon: the I-beam, one solid form in one ink", () => {
  test("the same pixels every time, on every machine: each pixel's share of the mark is worked out, not sampled", () => {
    expect(png(renderMark(48), 48)).toEqual(png(renderMark(48), 48));
    // Three rectangles that never overlap, so no pixel is counted twice: the whole mark's area, exactly.
    const box = 0.7 * 100, unit = box / 100, area = MARK_RECTS.reduce((sum, [x0, y0, x1, y1]) => sum + (x1 - x0) * unit * ((y1 - y0) * unit), 0);
    const covered = markCoverage(100).reduce((sum, k) => sum + k, 0);
    expect(Math.abs(covered - area)).toBeLessThan(1e-3);
  });

  // The owner's, 28 November 2026: "what ever makes it look the best, light/dark mode, preferred bare I-beam logo/no
  // background". Its forms come from one source: the page's ground in its ink, light and dark, and the bare I-beam.
  test("its forms: light, the ink on the white ground; dark, as first chosen; bare, the I-beam alone in either ink", () => {
    const n = 64;
    const pixel = (image: Uint8Array, x: number, y: number) => [...image.subarray((y * n + x) * 4, (y * n + x) * 4 + 4)];
    const rgb = (colour: string) => [1, 3, 5].map((i) => Number.parseInt(colour.slice(i, i + 2), 16));
    const light = renderMark(n, { tile: MARK_FORMS.light.tile, ink: MARK_FORMS.light.mark });
    expect([pixel(light, 0, 0), pixel(light, 32, 32)]).toEqual([[255, 255, 255, 255], [10, 10, 11, 255]]);
    const dark = renderMark(n, { tile: MARK_FORMS.dark.tile, ink: MARK_FORMS.dark.mark });
    expect([pixel(dark, 0, 0), pixel(dark, 32, 32)]).toEqual([[10, 10, 11, 255], [255, 255, 255, 255]]);
    expect(dark).toEqual(renderMark(n)); // the black icon, as it was
    for (const form of [MARK_FORMS.light, MARK_FORMS.dark]) {
      const bare = renderMark(n, { tile: null, ink: form.mark });
      expect([pixel(bare, 0, 0)[3], pixel(bare, 32, 32)]).toEqual([0, [...rgb(form.mark), 255]]);
    }
    // The page's own ground and ink, as the apps' themes have them (Android's, which its splash and icon are drawn in).
    const colours = (dir: string) => Object.fromEntries([...readFileSync(join(ROOT, `apps/android/app/src/main/res/${dir}/colors.xml`), "utf8").matchAll(/<color name="(\w+)">(#\w+)<\/color>/g)].map((m) => [m[1], m[2]!.toLowerCase()]));
    expect([colours("values").window, colours("values").ink]).toEqual([MARK_FORMS.light.tile, MARK_FORMS.light.mark]);
    expect([colours("values-night").window, colours("values-night").ink]).toEqual([MARK_FORMS.dark.tile, MARK_FORMS.dark.mark]);
  });

  test("it is upright and even: the same mirrored left to right, and top to bottom", () => {
    const n = 64, c = markCoverage(n);
    for (let y = 0; y < n; y++)
      for (let x = 0; x < n; x++) {
        expect(Math.abs(c[y * n + x]! - c[y * n + (n - 1 - x)]!)).toBeLessThan(1e-5);
        expect(Math.abs(c[y * n + x]! - c[(n - 1 - y) * n + x]!)).toBeLessThan(1e-5);
      }
  });

  test("every form a platform masks keeps the whole mark inside the circle its mask keeps", () => {
    expect(markReach(ZOOM.maskable)).toBeLessThanOrEqual(0.4); // a maskable icon: 80 % of it is always shown
    expect(markReach(ZOOM.adaptive)).toBeLessThanOrEqual(66 / 108 / 2); // an adaptive icon: its 66 dp of 108
    expect(markReach(ZOOM.tile)).toBeLessThanOrEqual(0.47); // on its tile, clear of iOS's rounding
    expect(markReach(ZOOM.badge)).toBeLessThanOrEqual(0.5); // on a badge: large, and still whole
  });

  test("its tile is rounded where a platform shows it as it is; the full-bleed forms are opaque; the badge is white", () => {
    const tile = roundTile(renderMark(64), 64);
    expect(tile[3]).toBe(0); // a corner: transparent
    expect(tile[(32 * 64 + 32) * 4 + 3]).toBe(255); // its middle: opaque
    expect([...tile.subarray((32 * 64 + 32) * 4, (32 * 64 + 32) * 4 + 3)]).toEqual([255, 255, 255]); // the web, in white
    const badge = renderMark(64, { tile: null });
    for (let i = 0; i < badge.length; i += 4) expect([badge[i], badge[i + 1], badge[i + 2]]).toEqual([255, 255, 255]);
    expect(badge[3]).toBe(0); // on nothing outside the mark
    const grey = greyscale(renderMark(16));
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

  test("the Apple app's: iOS's tile, its dark form the mark alone (iOS backs it), its tinted form in grey; the Mac's at each size", () => {
    const set = "apps/apple/Invincible/Assets.xcassets/AppIcon.appiconset";
    expect(header(`${set}/AppIcon.png`)).toEqual({ width: 1024, height: 1024, type: 2 });
    expect(header(`${set}/AppIcon-dark.png`)).toEqual({ width: 1024, height: 1024, type: 6 });
    expect(header(`${set}/AppIcon-tinted.png`)).toEqual({ width: 1024, height: 1024, type: 6 });
    const contents = JSON.parse(readFileSync(join(ROOT, set, "Contents.json"), "utf8")) as { images: { filename: string; appearances?: { value: string }[] }[] };
    expect(contents.images.map((i) => [i.filename, i.appearances?.[0]?.value ?? "any"])).toEqual([["AppIcon.png", "any"], ["AppIcon-dark.png", "dark"], ["AppIcon-tinted.png", "tinted"]]);
    for (const px of [16, 32, 64, 128, 256, 512, 1024]) expect(header(`apps/apple/Invincible/Mac/MacAssets.xcassets/MacIcon.appiconset/icon_${px}.png`)).toMatchObject({ width: px, height: px });
    // The dark form is the mark on nothing: its corners are transparent, where the tile's are its near black.
    const dark = renderMark(256, { tile: null });
    for (const at of [0, 255, 256 * 255, 256 * 256 - 1]) expect(dark[at * 4 + 3]).toBeLessThanOrEqual(1);
  });

  // The owner's, 28 November 2026: the icon follows light and dark wherever the platform can. iOS can: its light form is
  // the page's own ground in its ink, its dark and tinted forms the bare I-beam, as they were.
  test("iOS's icon, byte for byte: light, the ink on white; dark, the white I-beam on nothing; tinted, that in grey", () => {
    const set = join(ROOT, "apps/apple/Invincible/Assets.xcassets/AppIcon.appiconset");
    const bare = renderMark(1024, { tile: null, ink: MARK_FORMS.dark.mark });
    expect(readFileSync(join(set, "AppIcon.png"))).toEqual(Buffer.from(png(renderMark(1024, { tile: MARK_FORMS.light.tile, ink: MARK_FORMS.light.mark }), 1024)));
    expect(readFileSync(join(set, "AppIcon-dark.png"))).toEqual(Buffer.from(png(bare, 1024)));
    expect(readFileSync(join(set, "AppIcon-tinted.png"))).toEqual(Buffer.from(png(greyscale(bare), 1024)));
  });

  test("the pages and the manifest name only icons that are there, and the favicon is the mark", () => {
    const manifest = JSON.parse(readFileSync(join(ROOT, "apps/web/src/manifest.webmanifest"), "utf8")) as { icons: { src: string; type: string }[] };
    for (const icon of manifest.icons) {
      expect(icon.type).toBe("image/png");
      expect(existsSync(join(ROOT, "apps/web/src", icon.src))).toBe(true);
    }
    expect(manifest.icons.some((i) => i.src === "/icon-maskable-512.png")).toBe(true);
    expect(readFileSync(join(ROOT, "apps/web/src/index.html"), "utf8")).toContain('<link rel="icon" href="/icon-64.png" type="image/png" sizes="64x64" />');
  });
});
