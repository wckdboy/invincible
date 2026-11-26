import { MARK_PATH, ROUNDTABLE } from "../brand.ts";
import { svg } from "./dom.ts";

/*
 * Galahad's icon set: drawn for this app on a 24px grid, 1.75px strokes with
 * round caps and joins, built with createElementNS from constant path data.
 * A path prefixed with "!" is filled instead of stroked; one prefixed with "*" is filled in Galahad's red.
 */

const circle = (cx: number, cy: number, r: number): string => `M${cx - r} ${cy}a${r} ${r} 0 1 0 ${2 * r} 0a${r} ${r} 0 1 0 ${-2 * r} 0`;
const rect = (x: number, y: number, w: number, hgt: number, r: number): string =>
  `M${x + r} ${y}h${w - 2 * r}a${r} ${r} 0 0 1 ${r} ${r}v${hgt - 2 * r}a${r} ${r} 0 0 1 ${-r} ${r}h${-(w - 2 * r)}a${r} ${r} 0 0 1 ${-r} ${-r}v${-(hgt - 2 * r)}a${r} ${r} 0 0 1 ${r} ${-r}z`;

/** The mark, flat: Galahad's drawn helm as a silhouette on the icon grid, its cross and slit cut out (the drawing
 * itself is ./emblem.ts). */
export { MARK_PATH };

const round = (n: number): string => String(Math.round(n * 1000) / 1000);
/** A chair of the Round Table (brand.ts's ROUNDTABLE): the rounded rectangle at the bottom of the grid, turned `deg`
 * clockwise about the middle; at 0 and 180 its corners stay on whole units. */
const chair = (c: { R: number; w: number; d: number; rx: number }, deg: number): string => {
  const a = (deg * Math.PI) / 180, cos = Math.round(Math.cos(a) * 1e9) / 1e9, sin = Math.round(Math.sin(a) * 1e9) / 1e9;
  const turn = (x: number, y: number): string => `${round(12 + (x - 12) * cos - (y - 12) * sin)} ${round(12 + (x - 12) * sin + (y - 12) * cos)}`;
  const [x0, y0, x1, y1, r] = [12 - c.w / 2, 12 + c.R - c.d / 2, 12 + c.w / 2, 12 + c.R + c.d / 2, c.rx];
  // (A chair as deep as its corners are round is a pill: its ends are the arcs alone, with no line between them.)
  const side = (x: number, y: number): string => (c.d > 2 * r ? `L${turn(x, y)}` : "");
  return `M${turn(x0 + r, y0)}L${turn(x1 - r, y0)}A${r} ${r} 0 0 1 ${turn(x1, y0 + r)}${side(x1, y1 - r)}A${r} ${r} 0 0 1 ${turn(x1 - r, y1)}L${turn(x0 + r, y1)}A${r} ${r} 0 0 1 ${turn(x0, y1 - r)}${side(x0, y0 + r)}A${r} ${r} 0 0 1 ${turn(x0 + r, y0)}Z`;
};
/** The table: a ring filled between its edges, the inner circle wound the other way so it is a hole. */
const ring = (r: number, width: number): string => {
  const [o, i] = [r + width / 2, r - width / 2];
  return `M${12 - o} 12a${o} ${o} 0 1 0 ${2 * o} 0a${o} ${o} 0 1 0 ${-2 * o} 0ZM${12 - i} 12a${i} ${i} 0 1 1 ${2 * i} 0a${i} ${i} 0 1 1 ${-2 * i} 0Z`;
};

const ICONS = {
  mark: [`!${MARK_PATH}`],
  // The Round Table from above, as a floor plan draws it (brand.ts's ROUNDTABLE): the table, the knights' chairs round
  // it, and at the top the Siege Perilous, Galahad's: the deeper chair, the one in his red.
  roundtable: [`!${ring(ROUNDTABLE.table.r, ROUNDTABLE.table.width)}`, ...ROUNDTABLE.seats.map((deg) => `!${chair(ROUNDTABLE.chair, deg - 180)}`), `*${chair(ROUNDTABLE.siege, 180)}`],
  overview: [rect(3.5, 3.5, 7, 7, 1.75), rect(13.5, 3.5, 7, 7, 1.75), rect(3.5, 13.5, 7, 7, 1.75), circle(17, 17, 3.5)],
  inbox: ["M3.5 13.5h4.25l1.5 2.5h5.5l1.5-2.5h4.25", "M6.6 5h10.8a1.5 1.5 0 0 1 1.45 1.1L20.5 13v5a1.5 1.5 0 0 1-1.5 1.5H5A1.5 1.5 0 0 1 3.5 18v-5l1.65-6.9A1.5 1.5 0 0 1 6.6 5z"],
  chat: ["M5 4.5h14A1.5 1.5 0 0 1 20.5 6v9.5A1.5 1.5 0 0 1 19 17h-7.5l-4.25 3.25V17H5a1.5 1.5 0 0 1-1.5-1.5V6A1.5 1.5 0 0 1 5 4.5z"],
  activity: ["M3 12h3.5l2.5-6.5 5 13 2.5-6.5H21"],
  fleet: [circle(12, 5.5, 2.5), circle(5.5, 17.5, 2.5), circle(18.5, 17.5, 2.5), "M10.9 7.75 6.6 15.25M13.1 7.75l4.3 7.5M8 17.5h8"],
  sandbox: ["M12 3.25l7.75 4.4v8.7L12 20.75l-7.75-4.4v-8.7z", "M4.5 7.8 12 12l7.5-4.2M12 12v8.5"],
  memory: ["M3.5 5.5c2.9-1.1 6-.9 8.5 1 2.5-1.9 5.6-2.1 8.5-1v13c-2.9-1.1-6-.9-8.5 1-2.5-1.9-5.6-2.1-8.5-1z", "M12 6.5v13"],
  vault: [rect(4.5, 10.5, 15, 10, 2), "M8 10.5V8a4 4 0 0 1 8 0v2.5", "M12 14.5v2"],
  models: [rect(6.5, 6.5, 11, 11, 2), rect(9.75, 9.75, 4.5, 4.5, 0.75), "M9.5 3.5v3M14.5 3.5v3M9.5 17.5v3M14.5 17.5v3M3.5 9.5h3M3.5 14.5h3M17.5 9.5h3M17.5 14.5h3"],
  settings: ["M4 7.5h8.5M16.5 7.5H20M4 16.5h3M11 16.5h9", circle(14.5, 7.5, 2), circle(9, 16.5, 2)],
  search: [circle(10.75, 10.75, 6.25), "M15.5 15.5 20 20"],
  plus: ["M12 5v14M5 12h14"],
  minus: ["M5 12h14"],
  x: ["M6.5 6.5l11 11M17.5 6.5l-11 11"],
  check: ["M5 12.5l4.5 4.5L19 7.5"],
  "chevron-right": ["M10 6.5l5.5 5.5-5.5 5.5"],
  "chevron-left": ["M14 6.5 8.5 12l5.5 5.5"],
  "chevron-down": ["M6.5 9.5 12 15l5.5-5.5"],
  "chevron-up": ["M6.5 14.5 12 9l5.5 5.5"],
  "arrow-up": ["M12 19.5V5M6 10.5 12 4.5l6 6"],
  "arrow-down": ["M12 4.5V19M6 13.5l6 6 6-6"],
  stop: [`!${rect(6.5, 6.5, 11, 11, 2.25)}`],
  copy: [rect(8.5, 8.5, 11.5, 11.5, 2), "M15.5 8.5V6A1.5 1.5 0 0 0 14 4.5H6A1.5 1.5 0 0 0 4.5 6v8A1.5 1.5 0 0 0 6 15.5h2.5"],
  retry: ["M4.5 12a7.5 7.5 0 1 0 2.2-5.3L4.5 9", "M4.5 4.5V9H9"],
  refresh: ["M19.5 11A7.5 7.5 0 0 0 6.2 7.2L4.5 9M4.5 13a7.5 7.5 0 0 0 13.3 3.8l1.7-1.8", "M4.5 4.5V9H9M19.5 19.5V15H15"],
  trash: ["M4.5 7h15", "M9.5 7V5.25c0-.7.55-1.25 1.25-1.25h2.5c.7 0 1.25.55 1.25 1.25V7", "M6.5 7l.85 11.6A2 2 0 0 0 9.35 20.5h5.3a2 2 0 0 0 2-1.9L17.5 7", "M10 11v5.5M14 11v5.5"],
  shield: ["M12 3.25l7.25 2.6v5.65c0 4.65-3 8.05-7.25 9.75-4.25-1.7-7.25-5.1-7.25-9.75V5.85z"],
  "shield-check": ["M12 3.25l7.25 2.6v5.65c0 4.65-3 8.05-7.25 9.75-4.25-1.7-7.25-5.1-7.25-9.75V5.85z", "M8.75 12.25l2.25 2.25 4.25-4.5"],
  key: [circle(7.75, 16.25, 3.75), "M10.4 13.6 19.5 4.5M16 8l2.5 2.5M13.75 10.25l2 2"],
  link: ["M10.5 13.5a4 4 0 0 0 5.65 0l2.85-2.85a4 4 0 0 0-5.65-5.65l-1.2 1.2", "M13.5 10.5a4 4 0 0 0-5.65 0L5 13.35A4 4 0 0 0 10.65 19l1.2-1.2"],
  terminal: [rect(3.25, 4.5, 17.5, 15, 2.25), "M7.5 9.5l3 2.5-3 2.5M12.5 15H16"],
  more: [`!${circle(5.5, 12, 1.6)}`, `!${circle(12, 12, 1.6)}`, `!${circle(18.5, 12, 1.6)}`],
  sun: [circle(12, 12, 3.75), "M12 3v1.75M12 19.25V21M3 12h1.75M19.25 12H21M5.65 5.65l1.25 1.25M17.1 17.1l1.25 1.25M5.65 18.35l1.25-1.25M17.1 6.9l1.25-1.25"],
  moon: ["M19.5 14.25A7.75 7.75 0 0 1 9.75 4.5a7.75 7.75 0 1 0 9.75 9.75z"],
  monitor: [rect(3, 4.5, 18, 12, 2), "M9 20h6M12 16.5V20"],
  offline: ["M8.2 6.6A6 6 0 0 1 17.6 11 3.75 3.75 0 0 1 19.4 18M15 18.5H7a4.25 4.25 0 0 1-1.6-8.2", "M3.5 3.5l17 17"],
  alert: ["M10.3 4.6a2 2 0 0 1 3.4 0l7.1 12.4a2 2 0 0 1-1.7 3H4.9a2 2 0 0 1-1.7-3z", "M12 9.5v4", `!${circle(12, 16.75, 1)}`],
  info: [circle(12, 12, 8.75), "M12 11v5.25", `!${circle(12, 7.9, 1)}`],
  clock: [circle(12, 12, 8.75), "M12 7.25V12l3.25 2"],
  folder: ["M3.75 7.5a1.75 1.75 0 0 1 1.75-1.75h4l2 2.25h7a1.75 1.75 0 0 1 1.75 1.75v8.5a1.75 1.75 0 0 1-1.75 1.75H5.5a1.75 1.75 0 0 1-1.75-1.75z"],
  pin: ["M9 4.75h6", "M10 4.75v5.5l-3 3.5h10l-3-3.5v-5.5", "M12 13.75v5.5"],
  play: ["M8 5.25v13.5L18.75 12z"],
  pause: ["M9 6v12M15 6v12"],
  user: [circle(12, 8.25, 3.75), "M4.75 20c.9-3.6 3.75-5.75 7.25-5.75S18.35 16.4 19.25 20"],
  globe: [circle(12, 12, 8.75), "M3.25 12h17.5", "M12 3.25c2.35 2.4 3.5 5.3 3.5 8.75s-1.15 6.35-3.5 8.75c-2.35-2.4-3.5-5.3-3.5-8.75S9.65 5.65 12 3.25z"],
  gateway: ["M4 12h9.5M10 8l4 4-4 4", "M18.5 4.5v15"],
  isolated: [circle(12, 12, 8.75), "M5.8 5.8l12.4 12.4"],
  external: ["M13.5 4.5h6v6M19.5 4.5 11 13", "M17 13.5V18a1.5 1.5 0 0 1-1.5 1.5H6A1.5 1.5 0 0 1 4.5 18V8.5A1.5 1.5 0 0 1 6 7h4.5"],
  filter: ["M4 5.5h16l-6.25 7.25v5.5l-3.5 1.75v-7.25z"],
  phone: [rect(7, 3, 10, 18, 2.25), "M11 17.5h2"],
  laptop: [rect(5, 5, 14, 10, 1.75), "M2.75 18.5h18.5"],
  server: [rect(4, 4, 16, 7, 1.75), rect(4, 13, 16, 7, 1.75), "M7.5 7.5h.01M7.5 16.5h.01"],
  logout: ["M9.5 4.5H6.25c-.95 0-1.75.8-1.75 1.75v11.5c0 .95.8 1.75 1.75 1.75H9.5", "M15 8l4 4-4 4M19 12H9"],
  bell: ["M6.25 16.5V11a5.75 5.75 0 0 1 11.5 0v5.5l1.5 2H4.75z", "M10 20.5a2.1 2.1 0 0 0 4 0"],
  "check-circle": [circle(12, 12, 8.75), "M8.5 12.25l2.4 2.35 4.6-4.85"],
  "x-circle": [circle(12, 12, 8.75), "M9.5 9.5l5 5M14.5 9.5l-5 5"],
  ban: [circle(12, 12, 8.75), "M5.8 5.8l12.4 12.4"],
  battery: [rect(3.25, 7.5, 15.5, 9, 2), "M21 10.75v2.5"],
  zap: ["M13.25 3 5.5 13.25h6L10.75 21l7.75-10.25h-6z"],
  compass: [circle(12, 12, 8.75), "M15.5 8.5l-2 5-5 2 2-5z"],
  code: ["M8.5 7.5 4 12l4.5 4.5M15.5 7.5 20 12l-4.5 4.5", "M13.5 5l-3 14"],
  review: [circle(10.75, 10.75, 6.25), "M15.5 15.5 20 20", "M8.25 10.75l1.75 1.75 3.25-3.25"],
  sidebar: [rect(3.25, 4.5, 17.5, 15, 2.25), "M9.5 4.5v15"],
  // The sidebar's mirror: a panel at the right (a knight's, beside its timeline).
  panel: [rect(3.25, 4.5, 17.5, 15, 2.25), "M14.5 4.5v15"],
  hash: ["M9.5 4 7.5 20M16.5 4l-2 16M4.5 9h15.5M4 15h15.5"],
  cpu: [rect(6.5, 6.5, 11, 11, 2), "M9.5 3.5v3M14.5 3.5v3M9.5 17.5v3M14.5 17.5v3M3.5 9.5h3M3.5 14.5h3M17.5 9.5h3M17.5 14.5h3"],
  ram: [rect(3.25, 7, 17.5, 9.5, 1.5), "M7 16.5v2.5M10.33 16.5v2.5M13.66 16.5v2.5M17 16.5v2.5M7.5 10.5v2.5M12 10.5v2.5M16.5 10.5v2.5"],
  layers: ["M12 4 3.5 8.5 12 13l8.5-4.5z", "M3.5 12.25 12 16.75l8.5-4.5M3.5 16 12 20.5l8.5-4.5"],
  edit: ["M4.5 19.5l1-4.25L15.6 5.15a2 2 0 0 1 2.85 0l.4.4a2 2 0 0 1 0 2.85L8.75 18.5z", "M13.75 7l3.25 3.25"],
  eye: ["M2.75 12S6 5.75 12 5.75 21.25 12 21.25 12 18 18.25 12 18.25 2.75 12 2.75 12z", circle(12, 12, 3)],
  command: ["M9 9V6.75A2.25 2.25 0 1 0 6.75 9H9zm0 0h6m-6 0v6m6-6V6.75A2.25 2.25 0 1 1 17.25 9H15zm0 0v6m0 0h2.25A2.25 2.25 0 1 1 15 17.25V15zm0 0H9m0 0v2.25A2.25 2.25 0 1 1 6.75 15H9z"],
  sparkle: ["M12 3.5c.5 4.25 2.25 6 6.5 6.5-4.25.5-6 2.25-6.5 6.5-.5-4.25-2.25-6-6.5-6.5 4.25-.5 6-2.25 6.5-6.5z"],
  scroll: ["M7 4.5h10.5A2 2 0 0 1 19.5 6.5v11", "M7 4.5a2 2 0 0 0-2 2v11a2 2 0 0 0 2 2h10.5a2 2 0 0 0 2-2", "M9 9h6.5M9 12.5h6.5M9 16h4"],
  "play-circle": [circle(12, 12, 8.75), "M10 8.75v6.5l5.25-3.25z"],
  /** Loops: work on a schedule, round and round. */
  repeat: ["M16.5 3.5l3 3-3 3", "M4.5 11.25V10a3.5 3.5 0 0 1 3.5-3.5h11.5", "M7.5 20.5l-3-3 3-3", "M19.5 12.75V14a3.5 3.5 0 0 1-3.5 3.5H4.5"],
  /** Connectors: how Galahad plugs into the services you use. */
  plug: ["M9.25 3.5v4M14.75 3.5v4", "M6.5 7.5h11v3.75a5.5 5.5 0 0 1-5.5 5.5 5.5 5.5 0 0 1-5.5-5.5z", "M12 16.75v3.75"],
  /** Artifacts: a sandbox's work, kept in a box after it's gone. */
  archive: [rect(3.5, 4.5, 17, 4.5, 1.25), "M5 9v9a1.5 1.5 0 0 0 1.5 1.5h11A1.5 1.5 0 0 0 19 18V9", "M10 12.75h4"],
  // The Archive (everything kept): books on a shelf, one leaning.
  library: [rect(4, 4.5, 4, 15, 1), rect(9.5, 6.5, 4, 13, 1), "M15.4 7.3l3.4-.85 2.85 12.15-3.4.85z", "M3 19.5h12.5"],
  lightbulb: ["M9 17.5h6M10 20.5h4", "M12 3.5a5.75 5.75 0 0 0-3.5 10.3c.6.45 1 1.15 1 1.9v.3h5v-.3c0-.75.4-1.45 1-1.9A5.75 5.75 0 0 0 12 3.5z"],
  file: ["M6.5 3.5h7l4.5 4.5v11a1.5 1.5 0 0 1-1.5 1.5h-10A1.5 1.5 0 0 1 5 19V5a1.5 1.5 0 0 1 1.5-1.5z", "M13.5 3.5V8H18"],
  /** Files with a message: a paperclip. */
  paperclip: ["M15.5 7.5v8a3.5 3.5 0 0 1-7 0V6a2.5 2.5 0 0 1 5 0v9.5a1.5 1.5 0 0 1-3 0V8"],
  download: ["M12 4v11", "M7.5 10.5 12 15l4.5-4.5", "M4.5 19.5h15"],
  /** The Lab: mathematics, physics and engineering. */
  bank: ["M3.5 9.5 12 4.5l8.5 5", "M5 9.5v8M9.67 9.5v8M14.33 9.5v8M19 9.5v8", "M3.5 19.5h17"],
  gauge: ["M4.75 18.5a8.5 8.5 0 1 1 14.5 0", "M12 15l3.75-4.25", circle(12, 15, 1.25)],
  undo: ["M9 5.5 4.5 10 9 14.5", "M4.5 10H15a4.5 4.5 0 0 1 0 9h-3"],
  flask: ["M9.5 3.5h5", "M10.25 3.5v6L5 18.25a1.5 1.5 0 0 0 1.3 2.25h11.4a1.5 1.5 0 0 0 1.3-2.25L13.75 9.5v-6", "M7.25 15h9.5"],
} as const satisfies Record<string, readonly string[]>;

export type IconName = keyof typeof ICONS;

export interface IconOptions {
  size?: number;
  class?: string;
  /** Accessible name. Omit for decorative icons (the default: aria-hidden). */
  label?: string;
}

export function icon(name: IconName, options: IconOptions = {}): SVGSVGElement {
  const size = options.size ?? 18;
  const el = svg("svg", {
    viewBox: "0 0 24 24",
    width: size,
    height: size,
    fill: "none",
    stroke: "currentColor",
    "stroke-width": 1.75,
    "stroke-linecap": "round",
    "stroke-linejoin": "round",
    class: options.class ? `icon ${options.class}` : "icon",
    focusable: "false",
    ...(options.label ? { role: "img", "aria-label": options.label } : { "aria-hidden": "true" }),
  });
  for (const d of ICONS[name]) {
    if (d.startsWith("!")) el.appendChild(svg("path", { d: d.slice(1), fill: "currentColor", stroke: "none" }));
    // Filled in Galahad's red where the page has it (svg.icon .icon-siege); in the icon's own colour where it hasn't.
    else if (d.startsWith("*")) el.appendChild(svg("path", { d: d.slice(1), class: "icon-siege", fill: "currentColor", stroke: "none" }));
    else el.appendChild(svg("path", { d }));
  }
  return el;
}
