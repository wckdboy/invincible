#!/usr/bin/env bun
/*
 * Regenerates the app icon: the I-beam (scripts/mark.ts), white on near black, the owner's choice of 26 November 2026
 * ("simpler, still sleek and cool, logo, minimal bold monochrome"; it replaced Field · Aurum). Every PNG a platform takes
 * is drawn at its own size, each pixel's share of the mark worked out exactly: the web app's (its manifest's tiles, its
 * maskable and touch icons, its favicon, its notification badge), the README's, and the Android app's adaptive layers.
 * The Apple app's come from the same mark (apps/apple/scripts/brand.ts).
 *
 *   bun scripts/brand.ts --png    the icons (deterministic: pure TypeScript, no browser; a second or two)
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { png, roundTile } from "./field-icon.ts";
import { renderMark } from "./mark.ts";

const ROOT = resolve(import.meta.dir, "..");
const at = (p: string): string => join(ROOT, p);

/** How large the mark is drawn, for each form: on its tile half the icon's height; inside the circle every mask keeps
 * (a maskable icon's 80 %, an adaptive icon's 66 dp of 108); and large on a notification's badge (scripts/mark.ts
 * markReach says how far each reaches). */
export const ZOOM = { tile: 1, maskable: 1, adaptive: 0.9, badge: 1.3 } as const;

/** The Android app's densities: an adaptive icon's 108 dp in each. */
export const ANDROID_DENSITIES = { mdpi: 108, hdpi: 162, xhdpi: 216, xxhdpi: 324, xxxhdpi: 432 } as const;

/** Every icon this script writes, by where it goes, and its size: what tests check (brand.test.ts). */
export const BRAND_PNGS: Record<string, number> = {
  "apps/web/src/icon-192.png": 192,
  "apps/web/src/icon-512.png": 512,
  "apps/web/src/icon-64.png": 64,
  "apps/web/src/icon-maskable-512.png": 512,
  "apps/web/src/apple-touch-icon.png": 180,
  "apps/web/src/icon-mono-96.png": 96,
  "assets/icon.png": 256,
  ...Object.fromEntries(
    Object.entries(ANDROID_DENSITIES).flatMap(([d, px]) => ["foreground", "background", "monochrome"].map((layer) => [`apps/android/app/src/main/res/mipmap-${d}/ic_launcher_${layer}.png`, px])),
  ),
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

  // The Android app's adaptive icon: the near black behind, the mark in front (inside the safe zone, so the launcher
  // may mask and move the layers as it likes), and its themed form: the mark in white, for the system to colour.
  for (const [density, px] of Object.entries(ANDROID_DENSITIES)) {
    const front = renderMark(px, { tile: null, zoom: ZOOM.adaptive });
    write(`apps/android/app/src/main/res/mipmap-${density}/ic_launcher_foreground.png`, front, px);
    write(`apps/android/app/src/main/res/mipmap-${density}/ic_launcher_background.png`, renderMark(px, { zoom: 0 }), px);
    write(`apps/android/app/src/main/res/mipmap-${density}/ic_launcher_monochrome.png`, front, px);
  }
}
