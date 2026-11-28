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

/**
 * The mark as a standalone SVG on nothing, its ink the page's: `light`, or `dark` where the page is dark
 * (prefers-color-scheme); the box cut to the mark's height, so it fills a square such as a tab's.
 */
export function markSvg({ light, dark }: { light: string; dark: string }): string {
  const ys = markCorners().map(([, y]) => y);
  const top = Math.min(...ys), side = Math.max(...ys) - top, left = MARK.box / 2 - side / 2;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${left} ${top} ${side} ${side}"><style>polygon{fill:${light}}@media (prefers-color-scheme:dark){polygon{fill:${dark}}}</style><polygon points="${MARK.points}"/></svg>`;
}
