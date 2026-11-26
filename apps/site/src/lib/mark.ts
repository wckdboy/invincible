/*
 * Invincible's mark: the I-beam, one solid shape, the steel section and the letter I, in one ink (white on black, black
 * on white). The owner's, 26 November 2026. Its shape has one place in the repository, scripts/mark.ts (the app icons
 * are drawn from it too); this is where the site takes it: Mark.astro draws it, and the icons (the favicon, the touch
 * icon, a link's preview) are made from it when the site is built (icons.ts).
 */
import { MARK_POLYGON } from "../../../../scripts/mark.ts";

/** The mark in its square: a polygon in a `box`-wide viewBox. */
export const MARK = { box: 100, points: MARK_POLYGON } as const;

/** The polygon's corners, in the viewBox's units. */
export const markCorners = (): [number, number][] => MARK.points.split(" ").map((pair) => pair.split(",").map(Number) as [number, number]);

/** The mark as a standalone SVG: its ink on a ground (a rounded tile, `radius` of its width), or on nothing. */
export function markSvg({ ink, ground, radius = 0 }: { ink: string; ground?: string; radius?: number }): string {
  const tile = ground ? `<rect width="${MARK.box}" height="${MARK.box}" rx="${radius * MARK.box}" fill="${ground}"/>` : "";
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${MARK.box} ${MARK.box}">${tile}<polygon points="${MARK.points}" fill="${ink}"/></svg>`;
}
