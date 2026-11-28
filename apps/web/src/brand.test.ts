import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { ANDROID_ICON, BRAND_PNGS, FAVICON_SVG, ZOOM } from "../../../scripts/brand.ts";
import { downscale, greyscale, png, roundTile } from "../../../scripts/field-icon.ts";
import { MARK_BOX, MARK_FORMS, MARK_INK, MARK_POLYGON, MARK_RECTS, markCoverage, markReach, renderMark } from "../../../scripts/mark.ts";

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
      const transparent = /icon-(64|192|512|mono-96)\.png$|assets\/icon\.png$/.test(path);
      expect([path, h.type]).toEqual([path, transparent ? 6 : 2]);
    }
  });

  test("the Apple app's: iOS's tile, its dark form the mark alone (iOS backs it), its tinted form in grey", () => {
    const set = "apps/apple/Invincible/Assets.xcassets/AppIcon.appiconset";
    expect(header(`${set}/AppIcon.png`)).toEqual({ width: 1024, height: 1024, type: 2 });
    expect(header(`${set}/AppIcon-dark.png`)).toEqual({ width: 1024, height: 1024, type: 6 });
    expect(header(`${set}/AppIcon-tinted.png`)).toEqual({ width: 1024, height: 1024, type: 6 });
    const contents = JSON.parse(readFileSync(join(ROOT, set, "Contents.json"), "utf8")) as { images: { filename: string; appearances?: { value: string }[] }[] };
    expect(contents.images.map((i) => [i.filename, i.appearances?.[0]?.value ?? "any"])).toEqual([["AppIcon.png", "any"], ["AppIcon-dark.png", "dark"], ["AppIcon-tinted.png", "tinted"]]);
    // The dark form is the mark on nothing: its corners are transparent, where the tile's are its near black.
    const dark = renderMark(256, { tile: null });
    for (const at of [0, 255, 256 * 255, 256 * 256 - 1]) expect(dark[at * 4 + 3]).toBeLessThanOrEqual(1);
  });

  // The Mac's follows light and dark too (macOS 26's Icon Composer icons): one layer, the I-beam (MARK_POLYGON at
  // MARK_BOX, the same box as every other icon's), its ground and ink per appearance from MARK_FORMS. The tinted and
  // clear forms are drawn by macOS from the mark, white for it to tint. Xcode compiles it into the app's Assets.car.
  test("the Mac's icon is an Icon Composer icon: light, the ink on white; dark, white on near black; tinted, the white mark", () => {
    const icon = "apps/apple/Invincible/Mac/MacIcon.icon";
    type Solid = { appearance?: string; value: { solid: string } };
    const json = JSON.parse(readFileSync(join(ROOT, icon, "icon.json"), "utf8")) as {
      "fill-specializations": Solid[];
      groups: { layers: { "image-name": string; glass: boolean; "fill-specializations": Solid[] }[] }[];
      "supported-platforms": { squares: string[] };
    };
    // Icon Composer's colour form (sRGB components, 0 to 1) of a hex colour.
    const srgb = (hex: string) => `srgb:${[1, 3, 5].map((i) => (Number.parseInt(hex.slice(i, i + 2), 16) / 255).toFixed(5)).join(",")},1.00000`;
    const forms = (list: Solid[]) => list.map((s) => [s.appearance ?? "light", s.value.solid]);
    expect(forms(json["fill-specializations"])).toEqual([["light", srgb(MARK_FORMS.light.tile)], ["dark", srgb(MARK_FORMS.dark.tile)]]);
    const layer = json.groups[0]!.layers[0]!;
    expect(json.groups.flatMap((g) => g.layers).length).toBe(1);
    expect(forms(layer["fill-specializations"])).toEqual([["light", srgb(MARK_FORMS.light.mark)], ["dark", srgb(MARK_FORMS.dark.mark)], ["tinted", srgb(MARK_FORMS.dark.mark)]]);
    expect([layer["image-name"], layer.glass, json["supported-platforms"].squares]).toEqual(["ibeam.svg", false, ["macOS"]]);
    const svg = readFileSync(join(ROOT, icon, "Assets", layer["image-name"]), "utf8");
    expect(svg).toContain(`points="${MARK_POLYGON}"`);
    expect(svg).toContain(`scale(${MARK_BOX})`);
    // It replaced the set of PNGs, white on near black at each size, which followed no mode.
    expect(existsSync(join(ROOT, "apps/apple/Invincible/Mac/MacAssets.xcassets/MacIcon.appiconset"))).toBe(false);
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
    const page = readFileSync(join(ROOT, "apps/web/src/index.html"), "utf8");
    // The tab's icon follows the mode (the owner's word, 28 November 2026): the bare I-beam as SVG, its ink the page's,
    // after the PNG a browser that takes no SVG falls back to (the black tile, as it was: it can't follow the mode).
    const png64 = '<link rel="icon" href="/icon-64.png" type="image/png" sizes="64x64" />';
    const svg = '<link rel="icon" href="/favicon.svg" type="image/svg+xml" sizes="any" />';
    expect(page).toContain(png64);
    expect(page.indexOf(svg)).toBeGreaterThan(page.indexOf(png64));
  });

  // Android's launcher keeps the form it drew at install (checked on a Pixel launcher, 28 November 2026), so its icon
  // can't follow the mode: it stays the black icon, now drawn from the mark itself, and its themed form is the bare
  // I-beam the system tints in light and dark.
  test("Android's adaptive icon: the near black field, the white I-beam in front, and its themed form, exactly the mark", () => {
    const res = "apps/android/app/src/main/res";
    for (const [path, text] of Object.entries(ANDROID_ICON)) expect([path, readFileSync(join(ROOT, res, path), "utf8")]).toEqual([path, text]);
    expect(ANDROID_ICON["values/ic_launcher.xml"]).toContain(`<color name="ic_launcher_background">${MARK_INK.tile.toUpperCase().replace("#", "#FF")}</color>`);
    const scale = (MARK_BOX * ZOOM.adaptive * 108) / 100;
    for (const layer of ["foreground", "monochrome"]) {
      const vector = ANDROID_ICON[`drawable/ic_launcher_${layer}.xml`]!;
      expect(vector).toContain(`android:scaleX="${+scale.toFixed(4)}" android:scaleY="${+scale.toFixed(4)}" android:translateX="${+(54 - 50 * scale).toFixed(4)}" android:translateY="${+(54 - 50 * scale).toFixed(4)}"`);
      const rects = [...vector.matchAll(/M(\d+),(\d+)H(\d+)V(\d+)H(\d+)Z/g)].map((m) => [m[1], m[2], m[3], m[4]].map(Number));
      expect(rects).toEqual(MARK_RECTS.map((r) => [...r]));
      expect(vector).toContain('android:fillColor="#FFFFFFFF"');
    }
    expect(ANDROID_ICON["mipmap-anydpi/ic_launcher.xml"]).toContain('<monochrome android:drawable="@drawable/ic_launcher_monochrome" />');
    // No raster layers left behind.
    for (const density of ["mdpi", "hdpi", "xhdpi", "xxhdpi", "xxxhdpi"])
      for (const layer of ["foreground", "background", "monochrome"]) expect(existsSync(join(ROOT, res, `mipmap-${density}/ic_launcher_${layer}.png`))).toBe(false);
  });

  test("the favicon is the bare I-beam, near black in a light tab and white in a dark one, on nothing", () => {
    expect(readFileSync(join(ROOT, "apps/web/src/favicon.svg"), "utf8")).toBe(FAVICON_SVG);
    expect(FAVICON_SVG).toContain(`<polygon points="${MARK_POLYGON}"/>`);
    expect(FAVICON_SVG).toContain(`polygon{fill:${MARK_FORMS.light.mark}}`);
    expect(FAVICON_SVG).toContain(`@media (prefers-color-scheme:dark){polygon{fill:${MARK_FORMS.dark.mark}}}`);
    expect(FAVICON_SVG).not.toMatch(/<rect|<circle|background/);
  });
});
