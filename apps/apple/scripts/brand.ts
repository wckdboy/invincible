#!/usr/bin/env bun
/*
 * Writes the Apple app's brand assets, so they can't drift from the web app's:
 *   - the app icon, the I-beam (scripts/mark.ts, the owner's choice of 26 November 2026, "minimal bold monochrome"; it
 *     replaced Field · Aurum), the same mark as the web app's and the Android app's icons. It follows light and dark (the
 *     owner's word, 28 November 2026): iOS's "any" form, its light one, is the page's own ground in its ink, near black
 *     on white, 1024 px edge to edge and opaque (iOS rounds the corners itself); its dark form is the white mark alone on
 *     nothing, which iOS backs itself; its tinted form is that mark in grey, for the system to colour. The Mac's follows
 *     the mode too: an Icon Composer icon (Invincible/Mac/MacIcon.icon, macOS 26's, which Xcode compiles into the app),
 *     the I-beam as one layer on the page's ground in its ink, light (near black on white) and dark (white on near black),
 *     and white for macOS to tint, which it draws the tinted and clear forms from. macOS shows the form the Mac's
 *     "Icon & widget style" asks for: Dark, Clear or Tinted can follow light and dark (Auto); Default shows the light one;
 *   - the app's colours, monochrome (the owner's word, 26 November 2026: black, white and greys, colour kept for the
 *     agents): the ink (black on light, white on dark, as the web app's --accent), what is written on it, and the red of
 *     what went wrong, the one colour of the app's own.
 *
 *   bun apps/apple/scripts/brand.ts      (pure TypeScript: no browser, no ImageMagick)
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { greyscale, png } from "../../../scripts/field-icon.ts";
import { MARK_BOX, MARK_FORMS, MARK_POLYGON, renderMark } from "../../../scripts/mark.ts";

/** The app's inks: black on light and white on dark (the web app's --accent), and the red of what went wrong (its deeper
 * form on light, its brighter one on dark). Gold, amber and cream are gone (26 November 2026). */
export const INK = { tile: "#0a0a0b", white: "#ffffff", danger: "#c4141b", dangerOnDark: "#ee2c36" } as const;

const ASSETS = join(import.meta.dir, "../Invincible/Assets.xcassets");
const MAC_ICON = join(import.meta.dir, "../Invincible/Mac/MacIcon.icon");
const write = (path: string, text: string) => {
  mkdirSync(join(ASSETS, path, ".."), { recursive: true });
  writeFileSync(join(ASSETS, path), text);
  console.log(`wrote ${path}`);
};
const contents = (value: object) => `${JSON.stringify({ ...value, info: { author: "xcode", version: 1 } }, null, 2)}\n`;

/** Icon Composer's form of a colour: its sRGB components, 0 to 1. */
const srgb = (hex: string) => `srgb:${[1, 3, 5].map((i) => (Number.parseInt(hex.slice(i, i + 2), 16) / 255).toFixed(5)).join(",")},1.00000`;
const solid = (hex: string) => ({ solid: srgb(hex) });

/**
 * The Mac's icon as Icon Composer writes one (its keys in its order): the ground per appearance (fill-specializations), and
 * one layer, the I-beam, in its ink per appearance: near black on the light ground, white on the dark one, and white for
 * macOS to tint (its tinted and clear forms are drawn from the layer; an icon can name only these appearances). Flat, as
 * every other icon of the mark is: no glass, shadow, shine or translucency. Its picture, the mark in its 100-unit box at
 * MARK_BOX of a 1,024-point square, the size Icon Composer draws a Mac's icon at.
 */
export function macIcon(): { json: string; svg: string } {
  const icon = {
    "fill-specializations": [{ value: solid(MARK_FORMS.light.tile) }, { appearance: "dark", value: solid(MARK_FORMS.dark.tile) }],
    groups: [
      {
        layers: [
          {
            "fill-specializations": [
              { value: solid(MARK_FORMS.light.mark) },
              { appearance: "dark", value: solid(MARK_FORMS.dark.mark) },
              { appearance: "tinted", value: solid(MARK_FORMS.dark.mark) },
            ],
            glass: false,
            "image-name": "ibeam.svg",
            name: "I-beam",
            position: { scale: 1, "translation-in-points": [0, 0] },
          },
        ],
        name: "Mark",
        shadow: { kind: "none", opacity: 0 },
        specular: false,
        translucency: { enabled: false, value: 0 },
      },
    ],
    "supported-platforms": { squares: ["macOS"] },
  };
  const inset = (100 - 100 * MARK_BOX) / 2;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 100 100"><polygon points="${MARK_POLYGON}" fill="${MARK_FORMS.light.mark}" transform="translate(${inset} ${inset}) scale(${MARK_BOX})"/></svg>\n`;
  return { json: `${JSON.stringify(icon, null, 2)}\n`, svg };
}

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
  // The I-beam (scripts/mark.ts) in the page's own ground and ink: near black on white; its dark form the white mark
  // alone on nothing, which iOS backs itself.
  const icon = renderMark(1024, { tile: MARK_FORMS.light.tile, ink: MARK_FORMS.light.mark });
  const bare = renderMark(1024, { tile: null, ink: MARK_FORMS.dark.mark });
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
  const mac = macIcon();
  mkdirSync(join(MAC_ICON, "Assets"), { recursive: true });
  writeFileSync(join(MAC_ICON, "icon.json"), mac.json);
  writeFileSync(join(MAC_ICON, "Assets/ibeam.svg"), mac.svg);
  console.log("wrote the Mac's MacIcon.icon (light, dark, tinted; macOS draws the clear ones from it)");
}
