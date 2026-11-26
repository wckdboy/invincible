#!/usr/bin/env bun
/*
 * Writes the Apple app's brand assets, so they can't drift from the web app's:
 *   - the app icon, the I-beam (scripts/mark.ts, the owner's choice of 26 November 2026, "minimal bold monochrome"; it
 *     replaced Field · Aurum), the same mark as the web app's and the Android app's icons. iOS's "any" form is the tile,
 *     1024 px edge to edge and opaque, white on near black (iOS rounds the corners itself); its dark form is the mark
 *     alone on nothing, which iOS backs itself; its tinted form is that mark in grey, for the system to colour. The Mac's
 *     is the tile drawn at each size a Mac draws an icon at (macOS clips it to its own shape);
 *   - the app's colours, monochrome (the owner's word, 26 November 2026: black, white and greys, colour kept for the
 *     agents): the ink (black on light, white on dark, as the web app's --accent), what is written on it, and the red of
 *     what went wrong, the one colour of the app's own.
 *
 *   bun apps/apple/scripts/brand.ts      (pure TypeScript: no browser, no ImageMagick)
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { greyscale, png } from "../../../scripts/field-icon.ts";
import { renderMark } from "../../../scripts/mark.ts";

/** The app's inks: black on light and white on dark (the web app's --accent), and the red of what went wrong (its deeper
 * form on light, its brighter one on dark). Gold, amber and cream are gone (26 November 2026). */
export const INK = { tile: "#0a0a0b", white: "#ffffff", danger: "#c4141b", dangerOnDark: "#ee2c36" } as const;

const ASSETS = join(import.meta.dir, "../Invincible/Assets.xcassets");
const MAC_ICON = join(import.meta.dir, "../Invincible/Mac/MacAssets.xcassets/MacIcon.appiconset");
/** A Mac icon's sizes, in points and scales. */
const MAC_SIZES = [[16, 1], [16, 2], [32, 1], [32, 2], [128, 1], [128, 2], [256, 1], [256, 2], [512, 1], [512, 2]] as const;
const write = (path: string, text: string) => {
  mkdirSync(join(ASSETS, path, ".."), { recursive: true });
  writeFileSync(join(ASSETS, path), text);
  console.log(`wrote ${path}`);
};
const contents = (value: object) => `${JSON.stringify({ ...value, info: { author: "xcode", version: 1 } }, null, 2)}\n`;

if (import.meta.main) {
  // ---- colours -----------------------------------------------------------------------------------------------------
  const rgb = (hex: string) => ({ red: `0x${hex.slice(1, 3)}`, green: `0x${hex.slice(3, 5)}`, blue: `0x${hex.slice(5, 7)}`, alpha: "1.000" });
  const colour = (name: string, light: string, dark: string) =>
    write(
      `${name}.colorset/Contents.json`,
      contents({
        colors: [
          { color: { "color-space": "srgb", components: rgb(light) }, idiom: "universal" },
          { appearances: [{ appearance: "luminosity", value: "dark" }], color: { "color-space": "srgb", components: rgb(dark) }, idiom: "universal" },
        ],
      }),
    );
  // The ink: black on light, white on dark; and what is written on it.
  colour("AccentColor", INK.tile, INK.white);
  colour("OnAccent", INK.white, INK.tile);
  // The red of what went wrong.
  colour("Danger", INK.danger, INK.dangerOnDark);

  // ---- the app icon --------------------------------------------------------------------------------------------------
  // The I-beam (scripts/mark.ts): white on near black; its dark form the mark alone on nothing, which iOS backs itself.
  const icon = renderMark(1024);
  const bare = renderMark(1024, { tile: null });
  mkdirSync(join(ASSETS, "AppIcon.appiconset"), { recursive: true });
  writeFileSync(join(ASSETS, "AppIcon.appiconset/AppIcon.png"), png(icon, 1024));
  writeFileSync(join(ASSETS, "AppIcon.appiconset/AppIcon-dark.png"), png(bare, 1024));
  writeFileSync(join(ASSETS, "AppIcon.appiconset/AppIcon-tinted.png"), png(greyscale(bare), 1024));
  console.log("rendered AppIcon.appiconset (any, dark, tinted)");
  write(
    "AppIcon.appiconset/Contents.json",
    contents({
      images: [
        { filename: "AppIcon.png", idiom: "universal", platform: "ios", size: "1024x1024" },
        { appearances: [{ appearance: "luminosity", value: "dark" }], filename: "AppIcon-dark.png", idiom: "universal", platform: "ios", size: "1024x1024" },
        { appearances: [{ appearance: "luminosity", value: "tinted" }], filename: "AppIcon-tinted.png", idiom: "universal", platform: "ios", size: "1024x1024" },
      ],
    }),
  );
  mkdirSync(MAC_ICON, { recursive: true });
  for (const px of new Set(MAC_SIZES.map(([points, scale]) => points * scale))) writeFileSync(join(MAC_ICON, `icon_${px}.png`), png(renderMark(px), px));
  writeFileSync(
    join(MAC_ICON, "Contents.json"),
    contents({ images: MAC_SIZES.map(([points, scale]) => ({ filename: `icon_${points * scale}.png`, idiom: "mac", scale: `${scale}x`, size: `${points}x${points}` })) }),
  );
  console.log("rendered the Mac's MacIcon.appiconset");
}
