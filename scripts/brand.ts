#!/usr/bin/env bun
/*
 * Regenerates the app icon: the I-beam (scripts/mark.ts), white on near black, the owner's choice of 26 November 2026
 * ("simpler, still sleek and cool, logo, minimal bold monochrome"; it replaced Field · Aurum). Every PNG a platform takes
 * is drawn at its own size, each pixel's share of the mark worked out exactly: the web app's (its manifest's tiles, its
 * maskable and touch icons, its favicon for a browser that takes no SVG, its notification badge) and the README's. A
 * browser tab's own icon is the SVG one, which follows the mode (FAVICON_SVG); the Android app's adaptive icon is
 * vectors (ANDROID_ICON).
 * The Apple app's come from the same mark (apps/apple/scripts/brand.ts).
 *
 *   bun scripts/brand.ts --png    the icons (deterministic: pure TypeScript, no browser; a second or two)
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { png, roundTile } from "./field-icon.ts";
import { MARK_BOX, MARK_FORMS, MARK_INK, MARK_POLYGON, MARK_RECTS, renderMark } from "./mark.ts";

const ROOT = resolve(import.meta.dir, "..");
const at = (p: string): string => join(ROOT, p);

/** How large the mark is drawn, for each form: on its tile half the icon's height; inside the circle every mask keeps
 * (a maskable icon's 80 %, an adaptive icon's 66 dp of 108); and large on a notification's badge (scripts/mark.ts
 * markReach says how far each reaches). */
export const ZOOM = { tile: 1, maskable: 1, adaptive: 0.9, badge: 1.3 } as const;

/**
 * A browser tab's icon, which follows the mode (the owner's word, 28 November 2026: "light/dark mode, preferred bare
 * I-beam logo/no background"): the bare I-beam on nothing, near black in a light tab and white in a dark one (MARK_FORMS'
 * inks, by prefers-color-scheme), its height the tab's square (the box cut to the mark's 72 units).
 */
export const FAVICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="14 14 72 72"><style>polygon{fill:${MARK_FORMS.light.mark}}@media (prefers-color-scheme:dark){polygon{fill:${MARK_FORMS.dark.mark}}}</style><polygon points="${MARK_POLYGON}"/></svg>\n`;

/** Every icon this script writes, by where it goes, and its size: what tests check (brand.test.ts). */
export const BRAND_PNGS: Record<string, number> = {
  "apps/web/src/icon-192.png": 192,
  "apps/web/src/icon-512.png": 512,
  "apps/web/src/icon-64.png": 64,
  "apps/web/src/icon-maskable-512.png": 512,
  "apps/web/src/apple-touch-icon.png": 180,
  "apps/web/src/icon-mono-96.png": 96,
  "assets/icon.png": 256,
};

/** The adaptive icon's front and its themed form: the I-beam (MARK_RECTS, in its 100-unit box) at the adaptive zoom, a
 * vector in one colour, white (in front of the field; the system tints the themed form). */
function androidVector(what: string): string {
  const s = (MARK_BOX * ZOOM.adaptive * 108) / 100, scale = +s.toFixed(4), shift = +(54 - 50 * s).toFixed(4);
  const path = MARK_RECTS.map(([x0, y0, x1, y1]) => `M${x0},${y0}H${x1}V${y1}H${x0}Z`).join(" ");
  return `<?xml version="1.0" encoding="utf-8"?>
<!-- Made by scripts/brand.ts from scripts/mark.ts: ${what}. -->
<vector xmlns:android="http://schemas.android.com/apk/res/android"
    android:width="108dp"
    android:height="108dp"
    android:viewportWidth="108"
    android:viewportHeight="108">
    <group android:scaleX="${scale}" android:scaleY="${scale}" android:translateX="${shift}" android:translateY="${shift}">
        <path android:fillColor="#FFFFFFFF" android:pathData="${path}" />
    </group>
</vector>
`;
}

/**
 * The Android app's launcher icon, by where it goes under res/: the white I-beam on its near black field, the black icon
 * as first chosen, in light and dark alike. Android's launcher keeps the form it drew when the app was installed (a Pixel
 * launcher, 28 November 2026), so a field that followed the mode would glare white on a dark home screen; the I-beam that
 * follows the mode is the themed form, which the system tints.
 */
export const ANDROID_ICON: Record<string, string> = {
  "values/ic_launcher.xml": `<?xml version="1.0" encoding="utf-8"?>
<!-- Made by scripts/brand.ts: the launcher icon's field, near black in light and dark alike (scripts/mark.ts MARK_INK). -->
<resources>
    <color name="ic_launcher_background">#FF${MARK_INK.tile.slice(1).toUpperCase()}</color>
</resources>
`,
  "drawable/ic_launcher_foreground.xml": androidVector("the adaptive icon's front, the I-beam in white at the adaptive zoom, inside the 66 dp every launcher's mask keeps"),
  "drawable/ic_launcher_monochrome.xml": androidVector("the adaptive icon's themed form, the I-beam exactly, which the system tints in light and dark"),
  "mipmap-anydpi/ic_launcher.xml": `<?xml version="1.0" encoding="utf-8"?>
<!-- Made by scripts/brand.ts: the launcher icon, the white I-beam on its near black field, and its themed form. -->
<adaptive-icon xmlns:android="http://schemas.android.com/apk/res/android">
    <background android:drawable="@color/ic_launcher_background" />
    <foreground android:drawable="@drawable/ic_launcher_foreground" />
    <monochrome android:drawable="@drawable/ic_launcher_monochrome" />
</adaptive-icon>
`,
};

if (import.meta.main) {
  if (Bun.argv.includes("--png")) await renderPngs();
}

async function renderPngs(): Promise<void> {
  const write = (path: string, image: Uint8Array, size: number) => {
    mkdirSync(dirname(at(path)), { recursive: true });
    writeFileSync(at(path), png(image, size));
    console.log(`rendered ${path} (${size} px)`);
  };
  // The web app: its manifest's tiles (shown as they are, so rounded here), its favicon, the full-bleed forms a mask or
  // iOS rounds, and the badge a notification carries (white, read from its alpha). Each drawn at its own size.
  for (const [path, size] of [["apps/web/src/icon-192.png", 192], ["apps/web/src/icon-512.png", 512], ["apps/web/src/icon-64.png", 64], ["assets/icon.png", 256]] as const)
    write(path, roundTile(renderMark(size, { zoom: ZOOM.tile }), size), size);
  write("apps/web/src/icon-maskable-512.png", renderMark(512, { zoom: ZOOM.maskable }), 512);
  write("apps/web/src/apple-touch-icon.png", renderMark(180, { zoom: ZOOM.tile }), 180);
  write("apps/web/src/icon-mono-96.png", renderMark(96, { tile: null, zoom: ZOOM.badge }), 96);
  writeFileSync(at("apps/web/src/favicon.svg"), FAVICON_SVG);
  console.log("wrote apps/web/src/favicon.svg");

  // The Android app's adaptive icon, as vectors: the near black behind, the mark in front (inside the safe zone, so the
  // launcher may mask and move the layers as it likes), and its themed form, the mark exactly, for the system to colour.
  for (const [path, text] of Object.entries(ANDROID_ICON)) {
    mkdirSync(dirname(at(`apps/android/app/src/main/res/${path}`)), { recursive: true });
    writeFileSync(at(`apps/android/app/src/main/res/${path}`), text);
    console.log(`wrote apps/android/app/src/main/res/${path}`);
  }
}
