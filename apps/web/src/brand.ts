/*
 * The mark: Galahad's helm as the owner drew it, his oxblood cross down its face and across its brow. Two forms of the
 * one drawing. Where it can be a picture, it is the drawing itself (src/knights/galahad-helm.webp, cut out of his
 * drawing along the helm's own bottom edge). Where a mark must be one flat colour (the icon set), it is the helm's
 * silhouette with the cross and the slit cut out of it (MARK_PATH, traced from the same drawing onto the 24-unit icon
 * grid).
 *
 * Pure data and a tiny SVG tree, no DOM: the PWA shows the drawing (ui/emblem.ts) and draws the silhouette
 * (ui/icons.ts); scripts/brand.ts writes the marks' files from them, so every surface carries the same helm. The app's
 * icon is not drawn here: it is Galahad's field in gold, rendered as light (lib/field.ts, scripts/field-icon.ts).
 */

/** The helm's silhouette on the 24-unit icon grid, within a 1.5 inset: the cross and the slit are holes in it, under
 * the even-odd rule. */
export const MARK_PATH = "M11.8 1.59C11.8 1.63 11.43 1.7 10.97 1.73C7.57 2 4.45 4 3.59 6.48C3.06 8 2.48 12.66 2.24 17.21C2.16 18.86 2.22 19.11 2.93 19.77C4.15 20.92 7.17 21.98 9.98 22.26C10.37 22.29 10.7 22.37 10.7 22.41C10.7 22.46 11.29 22.5 12 22.5C12.72 22.5 13.3 22.46 13.3 22.41C13.3 22.37 13.63 22.29 14.03 22.25C17.13 21.95 20.89 20.5 21.62 19.32C21.9 18.87 21.9 18.35 21.61 15.57C20.79 7.86 20.6 6.68 19.98 5.45C19.02 3.56 16.08 1.94 13.23 1.74C12.72 1.7 12.3 1.63 12.3 1.59C12.3 1.54 12.19 1.5 12.05 1.5C11.91 1.5 11.8 1.54 11.8 1.59ZM14.27 3.25C14.49 3.32 14.49 3.33 14.1 3.78C13.52 4.43 13.33 5.16 13.2 7.12C13.15 8.02 13.1 9.14 13.1 9.62C13.1 10.67 12.79 10.57 16.2 10.66C19.03 10.73 19.23 10.7 19.86 10.09C20.04 9.92 20.2 9.83 20.24 9.88C20.29 9.96 20.5 13.76 20.5 14.65L20.5 14.94L20.08 14.53C19.49 13.97 19.19 13.84 18.15 13.71C17.16 13.59 14.56 13.56 13.71 13.67L13.17 13.73L13.23 16.49C13.29 19.7 13.35 20 14.05 20.78L14.51 21.29L14.03 21.37C13.41 21.47 10.82 21.47 10.07 21.37L9.49 21.28L9.94 20.79C10.69 19.96 10.9 18.79 10.9 15.5L10.9 13.73L10.53 13.66C9.94 13.57 6.74 13.59 5.79 13.7C4.73 13.82 4.32 13.99 3.73 14.53L3.27 14.95L3.34 13.85C3.37 13.24 3.45 12.06 3.52 11.22L3.63 9.69L4.04 10.08C4.69 10.71 4.87 10.73 7.94 10.66C9.43 10.62 10.73 10.56 10.83 10.53C11.01 10.48 11.01 10.36 10.95 8.37C10.85 5.2 10.69 4.46 9.93 3.68L9.57 3.31L9.96 3.25C10.18 3.22 10.42 3.17 10.5 3.15C10.76 3.09 14.04 3.17 14.27 3.25ZM6.54 11.2C5.56 11.25 5.03 11.33 4.78 11.44C4.2 11.72 4.03 12.36 4.41 12.84L4.62 13.1L7.78 13.08L10.95 13.05L10.98 12.07L11.01 11.1L9.48 11.12C8.64 11.12 7.32 11.16 6.54 11.2ZM13.1 12.1L13.1 13.1L16.11 13.1C17.9 13.1 19.19 13.06 19.3 13C19.87 12.7 19.7 11.72 19.03 11.44C18.64 11.27 16.31 11.11 14.33 11.1L13.1 11.1L13.1 12.1Z";

/** Galahad's black (the app's ink), white, the inks the flat mark is drawn in on the website, and Galahad's seat's red:
 * the red of the cross on his helm in the owner's drawing, a touch brighter, so it holds on white and on black. */
export const INK = { tile: "#0a0a0b", paper: "#ffffff", light: "#f8ebdc", dark: "#141416", siege: "#c4141b", siegeOnDark: "#ee2c36" } as const;

/**
 * The Roundtable's icon: the Round Table from above, as a floor plan draws one, on the 24-unit icon grid. The table is a
 * ring; six chairs stand round it, and at the top is the Siege Perilous, the seat no knight but Galahad could take: the
 * deeper chair, the one in his red. Pixel-true at 24 px: the ring's outer edge falls at 6 and 18, the chairs at the top
 * and the bottom have their edges on whole pixels, and every chair stands 2 units out from the table. Each chair is the
 * one at the bottom turned about the middle, so the six are exact.
 */
export const ROUNDTABLE = {
  /** The ring: its middle line's radius and its width (edges at 4.5 and 6). */
  table: { r: 5.25, width: 1.5 },
  /** A knight's chair: its centre's distance from the middle, its width along the table, its depth, its corners. */
  chair: { R: 9, w: 4, d: 2, rx: 1 },
  /** Galahad's: as wide, a unit deeper. */
  siege: { R: 9.5, w: 4, d: 3, rx: 1 },
  /** Where the knights' chairs stand, in degrees clockwise from the top (Galahad's is at 0). */
  seats: [60, 120, 180, 240, 300],
} as const;

/* ---------- the tree ---------- */

export interface SvgNode {
  tag: string;
  attrs: Record<string, string | number>;
  children?: SvgNode[];
}

const n = (tag: string, attrs: Record<string, string | number>, ...children: SvgNode[]): SvgNode => ({ tag, attrs, children });
const root = (viewBox: string, title: string, ...children: SvgNode[]): SvgNode =>
  n("svg", { xmlns: "http://www.w3.org/2000/svg", viewBox, fill: "none" }, n("title", {}, { tag: "#text", attrs: { text: title } }), ...children);
/** The flat silhouette, scaled from its 24-unit grid to a 1024 square. */
const silhouette = (fill: string): SvgNode => n("path", { d: MARK_PATH, fill, "fill-rule": "evenodd", transform: "scale(42.6667)" });

/* ---------- icons ---------- */

/** The Roundtable's shapes on the 24-unit grid (roundtableIcon), in `ink`, Galahad's seat in `seat`. Each knight's chair
 * is the bottom one turned about the middle. */
function roundtableShapes(ink: string, seat: string): SvgNode[] {
  const { table, chair, siege, seats } = ROUNDTABLE;
  const at = (c: { R: number; w: number; d: number; rx: number }, top: boolean) => ({ x: 12 - c.w / 2, y: top ? 12 - c.R - c.d / 2 : 12 + c.R - c.d / 2, width: c.w, height: c.d, rx: c.rx });
  return [
    n("circle", { cx: 12, cy: 12, r: table.r, stroke: ink, "stroke-width": table.width }),
    n("g", { fill: ink }, ...seats.map((deg) => n("rect", { ...at(chair, false), ...(deg === 180 ? {} : { transform: `rotate(${(deg + 180) % 360} 12 12)` }) }))),
    n("rect", { ...at(siege, true), fill: seat }),
  ];
}

/** The flat, single-colour mark (currentColor). */
export function flatMark(): SvgNode {
  return root("0 0 1024 1024", "Galahad", silhouette("currentColor"));
}

/** The Roundtable's icon as its own file: the ring and the knights' chairs in currentColor, Galahad's in his red. */
export function roundtableIcon(): SvgNode {
  return n(
    "svg",
    { xmlns: "http://www.w3.org/2000/svg", viewBox: "0 0 24 24", fill: "none" },
    n("title", {}, { tag: "#text", attrs: { text: "The Roundtable" } }),
    ...roundtableShapes("currentColor", INK.siege),
  );
}

const escapeAttr = (value: string | number): string => String(value).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");

/** Serialise a tree as SVG markup (two-space indented). */
export function toSvg(node: SvgNode, depth = 0): string {
  const pad = "  ".repeat(depth);
  if (node.tag === "#text") return escapeAttr(node.attrs.text ?? "");
  const attrs = Object.entries(node.attrs)
    .map(([k, v]) => ` ${k}="${escapeAttr(v)}"`)
    .join("");
  const kids = node.children ?? [];
  if (kids.length === 0) return `${pad}<${node.tag}${attrs}/>`;
  if (kids.length === 1 && kids[0]!.tag === "#text") return `${pad}<${node.tag}${attrs}>${toSvg(kids[0]!)}</${node.tag}>`;
  return `${pad}<${node.tag}${attrs}>\n${kids.map((k) => toSvg(k, depth + 1)).join("\n")}\n${pad}</${node.tag}>`;
}
