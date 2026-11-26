#!/usr/bin/env bun
/*
 * Regenerates the app icon, as light: the field in gold (apps/web/src/lib/field.ts, the owner's choice of 26 November
 * 2026, "field aurum"), rendered by scripts/field-icon.ts into every PNG a platform takes: the web app's (its manifest's
 * tiles, its maskable and touch icons, its favicon, its notification badge) and the README's. The site's, the Android
 * app's adaptive layers and the Apple app's come back with those apps (a later phase). The new identity's mark comes
 * with Phase 1.
 *
 *   bun scripts/brand.ts --png    the icons (deterministic: pure TypeScript, no browser; about ten seconds)
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { downscale, png, renderField, rgba, roundTile } from "./field-icon.ts";

const ROOT = resolve(import.meta.dir, "..");
const at = (p: string): string => join(ROOT, p);

/** How far the field is drawn in, for a form a platform masks: its whole glow inside the circle every mask keeps (a
 * maskable icon's 80 %, an adaptive icon's 66 dp of 108). */
export const ZOOM = { tile: 1, maskable: 0.84, adaptive: 0.68, badge: 0.96 } as const;

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

if (import.meta.main) {
  if (Bun.argv.includes("--png")) await renderPngs();
}

async function renderPngs(): Promise<void> {
  const write = (path: string, image: Uint8Array, size: number) => {
    mkdirSync(dirname(at(path)), { recursive: true });
    writeFileSync(at(path), png(image, size));
    console.log(`rendered ${path} (${size} px)`);
  };
  // The tile, edge to edge (the field on its night), and the field alone on nothing, drawn in for the masks.
  const tile = rgba(renderField(1024, { zoom: ZOOM.tile }));
  const maskable = rgba(renderField(1024, { zoom: ZOOM.maskable }));
  const badge = rgba(renderField(1024, { tile: null, zoom: ZOOM.badge }), { opaque: false, mono: true });

  // The web app: its manifest's tiles (shown as they are, so rounded here), its favicon, the full-bleed forms a mask or
  // iOS rounds, and the badge a notification carries (white, read from its alpha).
  const rounded = roundTile(tile, 1024);
  for (const [path, size] of [["apps/web/src/icon-192.png", 192], ["apps/web/src/icon-512.png", 512], ["apps/web/src/icon-64.png", 64], ["assets/icon.png", 256]] as const) write(path, downscale(rounded, 1024, size), size);
  write("apps/web/src/icon-maskable-512.png", downscale(maskable, 1024, 512), 512);
  write("apps/web/src/apple-touch-icon.png", downscale(tile, 1024, 180), 180);
  write("apps/web/src/icon-mono-96.png", downscale(badge, 1024, 96), 96);
}
