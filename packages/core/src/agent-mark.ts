import { type AvatarExpression, handleSeed, isOrbProfile } from "./avatar.ts";

/*
 * An agent's mark: the Grille (O2: shown five directions on 26 November 2026, the owner chose "2 · Grille"). A solid
 * disc in the agent's own colour, cut into slats by two or three slots at its own angle, the I-beam's bars through the
 * orb. The primary (your agent) stays the I-beam in one ink: never a Grille.
 *
 * Its colour and its form are the node's to give, once, as the agent joins (assignMark, in the order agents joined:
 * joinOrder), and are saved as its avatar ({v: 3, color, form}: markProfile), so every device draws the same mark and
 * no mark shifts when another agent comes or goes. Everything here is data and pure geometry: every app draws the mark
 * from these numbers, held to them by the vectors' `marks`. Its design, the palette and the motion are O1's
 * (o1-grille/src/marks.ts), the sheet the owner chose from being the specification.
 */

export type MarkTheme = "light" | "dark";

/**
 * The palette: eight hues (OKLCH 72 to 334 degrees; none between pink-red and red-orange, which are failure's red),
 * each a light-page form at least 3:1 against the page and a dark-page form, neighbours alternating in lightness so they
 * part further. A colour is saved and compared as its light form.
 */
export const MARK_PALETTE = [
  { name: "Amber", light: "#c88200", dark: "#ffbc63" },
  { name: "Lime", light: "#699700", dark: "#b1ef4a" },
  { name: "Green", light: "#007745", dark: "#18c376" },
  { name: "Teal", light: "#04a19b", dark: "#34eee5" },
  { name: "Sky", light: "#0084ba", dark: "#3bb7f7" },
  { name: "Blue", light: "#3453d3", dark: "#5b81fe" },
  { name: "Violet", light: "#9a68da", dark: "#ccabff" },
  { name: "Magenta", light: "#a23493", dark: "#e26ace" },
] as const;

/** The page a mark is drawn on, the ink (the owner's own, what asks you turns), and the shared red (what failed). */
export const MARK_PAGE: Record<MarkTheme, string> = { light: "#ffffff", dark: "#000000" };
export const MARK_INK: Record<MarkTheme, string> = { light: "#0a0a0b", dark: "#ffffff" };
export const MARK_RED: Record<MarkTheme, string> = { light: "#c4141b", dark: "#ee2c36" };

/**
 * Each hue while queued: pale, 60 % of the way to the light page and 50 % to the dark one; and every mark while paused:
 * grey, 42 % and 40 % of the way from the page to the ink. Mixed in OKLab (as CSS color-mix(in oklab) does) once, here,
 * so every app draws the same colours without doing the mixing itself (agent-mark.test.ts mixes them again).
 */
export const MARK_QUEUED: readonly { light: string; dark: string }[] = [
  { light: "#ebcdaa", dark: "#634721" }, { light: "#c1d6a9", dark: "#425c17" }, { light: "#a5c8b1", dark: "#044a29" }, { light: "#b0d9d6", dark: "#0e5c58" },
  { light: "#aacee5", dark: "#114560" }, { light: "#a7bdf2", dark: "#1e2e63" }, { light: "#d5c3f3", dark: "#4e4063" }, { light: "#deafd4", dark: "#57244e" },
];
export const MARK_PAUSED: Record<MarkTheme, string> = { light: "#8c8c8d", dark: "#484848" };

/** The forms: the slots' angle, one of six, and two or three slots: form n is MARK_ANGLES[n % 6] with MARK_SLOTS[n / 6]. */
export const MARK_ANGLES = [-40, -27, -14, 14, 27, 40] as const;
export const MARK_SLOTS = [2, 3] as const;
export const MARK_FORMS = MARK_ANGLES.length * MARK_SLOTS.length;

export function markForm(form: number): { slots: 2 | 3; angle: number } {
  return { slots: MARK_SLOTS[Math.floor(form / MARK_ANGLES.length) % MARK_SLOTS.length]!, angle: MARK_ANGLES[form % MARK_ANGLES.length]! };
}

/** An agent's mark: its colour (an index into MARK_PALETTE) and its form (0 to 11). */
export interface AgentMark {
  color: number;
  form: number;
}

/** A mark as an agent's avatar saves it: its colour as its light form, and its form. */
export interface MarkProfile {
  v: 3;
  color: string;
  form: number;
}

const paletteIndex = (hex: string): number => MARK_PALETTE.findIndex((hue) => hue.light === hex);

/** A saved mark, read strictly: exactly v 3, a colour that is one of the eight (its light form, lowercase) and a whole form. */
export function isMarkProfile(profile: unknown): profile is MarkProfile {
  if (!profile || typeof profile !== "object" || Array.isArray(profile)) return false;
  const p = profile as Record<string, unknown>;
  return Object.keys(p).length === 3 && p.v === 3 && typeof p.color === "string" && paletteIndex(p.color) >= 0 && Number.isInteger(p.form) && (p.form as number) >= 0 && (p.form as number) < MARK_FORMS;
}

export function readMarkProfile(profile: unknown): AgentMark | null {
  return isMarkProfile(profile) ? { color: paletteIndex(profile.color), form: profile.form } : null;
}

export function markProfile(mark: AgentMark): MarkProfile {
  return { v: 3, color: MARK_PALETTE[mark.color]!.light, form: mark.form };
}

/* ---------- the snap: a colour you pick, to the nearest hue of the eight ---------- */

/**
 * sRGB's 256 levels in linear light: its transfer function's values, written out in the shortest form that reads back
 * exactly, so no app raises to a power (pow differs between platforms in its last bits). agent-mark.test.ts holds them
 * to the function.
 */
export const MARK_LINEAR: readonly number[] = [
  0, 0.0003035269835488375, 0.000607053967097675, 0.0009105809506465125, 0.00121410793419535, 0.0015176349177441874,
  0.001821161901293025, 0.0021246888848418626, 0.0024282158683907, 0.0027317428519395373, 0.003035269835488375, 0.003346535763899161,
  0.003676507324047436, 0.004024717018496307, 0.004391442037410293, 0.004776953480693729, 0.005181516702338386, 0.005605391624202723,
  0.006048833022857054, 0.006512090792594475, 0.006995410187265387, 0.007499032043226175, 0.008023192985384994, 0.008568125618069307,
  0.009134058702220787, 0.00972121732023785, 0.010329823029626936, 0.010960094006488246, 0.011612245179743885, 0.012286488356915872,
  0.012983032342173012, 0.013702083047289686, 0.014443843596092545, 0.01520851442291271, 0.01599629336550963, 0.016807375752887384,
  0.017641954488384078, 0.018500220128379697, 0.019382360956935723, 0.0202885630566524, 0.021219010376003555, 0.02217388479338738,
  0.02315336617811041, 0.024157632448504756, 0.02518685962736163, 0.026241221894849898, 0.027320891639074894, 0.028426039504420793,
  0.0295568344378088, 0.030713443732993635, 0.03189603307301153, 0.033104766570885055, 0.03433980680868217, 0.03560131487502034,
  0.03688945040110004, 0.0382043715953465, 0.03954623527673284, 0.04091519690685319, 0.042311410620809675, 0.043735029256973465,
  0.04518620438567554, 0.046665086336880095, 0.04817182422688942, 0.04970656598412723, 0.05126945837404324, 0.052860647023180246,
  0.05448027644244237, 0.05612849004960009, 0.05780543019106723, 0.0595112381629812, 0.06124605423161761, 0.06301001765316767,
  0.06480326669290577, 0.06662593864377289, 0.06847816984440017, 0.07036009569659588, 0.07227185068231748, 0.07421356838014963,
  0.07618538148130785, 0.07818742180518633, 0.08021982031446832, 0.0822827071298148, 0.08437621154414882, 0.08650046203654976,
  0.08865558628577294, 0.09084171118340768, 0.09305896284668745, 0.0953074666309647, 0.09758734714186246, 0.09989872824711389,
  0.10224173308810132, 0.10461648409110419, 0.10702310297826761, 0.10946171077829933, 0.1119324278369056, 0.11443537382697373,
  0.11697066775851084, 0.11953842798834562, 0.12213877222960187, 0.12477181756095049, 0.12743768043564743, 0.1301364766903643,
  0.13286832155381798, 0.13563332965520566, 0.13843161503245183, 0.14126329114027164, 0.14412847085805777, 0.14702726649759498,
  0.14995978981060856, 0.15292615199615017, 0.1559264637078274, 0.1589608350608804, 0.162029375639111, 0.1651321945016676,
  0.16826940018969075, 0.1714411007328226, 0.17464740365558504, 0.17788841598362912, 0.18116424424986022, 0.184474994500441,
  0.18782077230067787, 0.19120168274079138, 0.1946178304415758, 0.19806931955994886, 0.20155625379439707, 0.20507873639031693,
  0.20863687014525575, 0.21223075741405523, 0.21586050011389926, 0.2195261997292692, 0.2232279573168085, 0.22696587351009836,
  0.23074004852434915, 0.23455058216100522, 0.238397573812271, 0.24228112246555486, 0.24620132670783548, 0.25015828472995344,
  0.25415209433082675, 0.2581828529215958, 0.26225065752969623, 0.26635560480286247, 0.2704977910130658, 0.27467731206038465,
  0.2788942634768104, 0.2831487404299921, 0.2874408377269175, 0.29177064981753587, 0.2961382707983211, 0.3005437944157765,
  0.3049873140698863, 0.30946892281750854, 0.31398871337571754, 0.31854677812509186, 0.32314320911295075, 0.3277780980565422,
  0.33245153634617935, 0.33716361504833037, 0.3419144249086609, 0.3467040563550296, 0.35153259950043936, 0.3564001441459435,
  0.3613067797835095, 0.3662525955988395, 0.3712376804741491, 0.3762621229909065, 0.38132601143253014, 0.386429433787049,
  0.39157247774972326, 0.39675523072562685, 0.4019777798321958, 0.4072402119017367, 0.41254261348390375, 0.4178850708481375,
  0.4232676699860717, 0.4286904966139066, 0.43415363617474895, 0.4396571738409188, 0.44520119451622786, 0.45078578283822346,
  0.45641102318040466, 0.4620769996544071, 0.467783796112159, 0.47353149614800955, 0.4793201831008268, 0.4851499400560704,
  0.4910208498478356, 0.4969329950608704, 0.5028864580325687, 0.5088813208549338, 0.5149176653765214, 0.5209955732043543,
  0.5271151257058131, 0.5332764040105052, 0.5394794890121072, 0.5457244613701866, 0.5520114015120001, 0.5583403896342679,
  0.5647115057049292, 0.5711248294648731, 0.5775804404296506, 0.5840784178911641, 0.5906188409193369, 0.5972017883637634,
  0.6038273388553378, 0.6104955708078648, 0.6172065624196511, 0.6239603916750761, 0.6307571363461468, 0.6375968739940326,
  0.6444796819705821, 0.6514056374198242, 0.6583748172794485, 0.665387298282272, 0.6724431569576875, 0.6795424696330938,
  0.6866853124353135, 0.6938717612919899, 0.7011018919329731, 0.7083757798916868, 0.7156935005064807, 0.7230551289219693,
  0.7304607400903537, 0.7379104087727308, 0.7454042095403874, 0.7529422167760779, 0.7605245046752924, 0.768151147247507,
  0.7758222183174236, 0.7835377915261935, 0.7912979403326302, 0.799102738014409, 0.8069522576692516, 0.8148465722161012,
  0.8227857543962835, 0.8307698767746546, 0.83879901174074, 0.846873231509858, 0.8549926081242338, 0.8631572134541023,
  0.8713671191987972, 0.8796223968878317, 0.8879231178819663, 0.8962693533742664, 0.9046611743911496, 0.9130986517934192,
  0.9215818562772946, 0.9301108583754237, 0.938685728457888, 0.9473065367331999, 0.9559733532492861, 0.9646862478944651,
  0.9734452903984125, 0.9822505503331171, 0.9911020971138298, 1,
];

/** A cube root of [0, 1] by Newton's method: from 1, halved until its cube is within 8 times x, then a fixed 8 steps.
 * + − × ÷ alone, so the same to the last bit in every app (cbrt differs between platforms in its last bits); within a
 * part in 10^15 of the true root. */
export function markCubeRoot(x: number): number {
  if (x <= 0) return 0;
  let y = 1;
  while (y * y * y > 8 * x) y = y / 2;
  for (let n = 0; n < 8; n++) y = (2 * y + x / (y * y)) / 3;
  return y;
}

/** A colour (#rrggbb) in OKLab (Björn Ottosson's): its lightness and its (a, b), with + − × ÷ alone, each sum in this
 * order. */
export function markLab(hex: string): [number, number, number] {
  const r = MARK_LINEAR[parseInt(hex.slice(1, 3), 16)]!, g = MARK_LINEAR[parseInt(hex.slice(3, 5), 16)]!, b = MARK_LINEAR[parseInt(hex.slice(5, 7), 16)]!;
  const l = markCubeRoot(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = markCubeRoot(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = markCubeRoot(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s, 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s, 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s];
}

/** Under this chroma a colour is a grey: it has no hue to snap by. */
export const MARK_GREY = 0.02;

/** Each hue's direction in (a, b), from its light form (its two forms lie within half a degree), and both forms'
 * lightness and chroma, for a tie. */
const HUES = MARK_PALETTE.map((hue) => {
  const [, a, b] = markLab(hue.light);
  const chroma = Math.sqrt(a * a + b * b);
  return {
    a: a / chroma,
    b: b / chroma,
    forms: [hue.light, hue.dark].map((form) => {
      const [L, fa, fb] = markLab(form);
      return { L, C: Math.sqrt(fa * fa + fb * fb) };
    }),
  };
});

/**
 * Which of the eight a colour you pick snaps to: the nearest hue (OKLCH's), its lightness and chroma only breaking a
 * tie, so a pale mint is Teal's and red, which isn't among them, is Amber's. A grey, which has no hue, goes to the form
 * nearest it in lightness. Reckoned with + − × ÷ and √ alone, in a fixed order, on the constants above: each correctly
 * rounded in every language, so every app comes to the same one (no pow, cbrt or atan2, which differ in their last bits).
 */
export function snapColor(hex: string): number {
  const [L, a, b] = markLab(hex.toLowerCase());
  const chroma = Math.sqrt(a * a + b * b);
  let best = 0;
  if (chroma < MARK_GREY) {
    let apart = Infinity;
    HUES.forEach((hue, n) => {
      for (const form of hue.forms) {
        const d = Math.abs(form.L - L);
        if (d < apart) [best, apart] = [n, d];
      }
    });
    return best;
  }
  // The nearest direction is the one (a, b) lies most along; on a tie, the hue whose form is nearer in lightness, then in chroma.
  let along = -Infinity, nearL = Infinity, nearC = Infinity;
  HUES.forEach((hue, n) => {
    const at = a * hue.a + b * hue.b;
    const dL = Math.min(Math.abs(hue.forms[0]!.L - L), Math.abs(hue.forms[1]!.L - L));
    const dC = Math.min(Math.abs(hue.forms[0]!.C - chroma), Math.abs(hue.forms[1]!.C - chroma));
    if (at > along || (at === along && (dL < nearL || (dL === nearL && dC < nearC)))) [best, along, nearL, nearC] = [n, at, dL, dC];
  });
  return best;
}

/** The handle's own mark, before any is given: its seed's colour and form (an agent's, where a node gave it none). */
function seeded(id: string): AgentMark {
  const seed = handleSeed(id);
  return { color: seed % MARK_PALETTE.length, form: (seed >>> 8) % MARK_FORMS };
}

/**
 * An agent's mark, from what it has: its own (v 3); a colour chosen for it before the marks (v 2, an OrbProfile),
 * snapped, with its handle's form; else its handle's. The node gives every agent here its own; the rest are for a
 * profile that came from elsewhere.
 */
export function markOf(id: string, profile?: unknown): AgentMark {
  const own = readMarkProfile(profile);
  if (own) return own;
  const handle = seeded(String(id ?? ""));
  return isOrbProfile(profile) ? { color: snapColor(profile.color), form: handle.form } : handle;
}

/**
 * The mark a node gives an agent as it joins, after `others` (the marks of the agents here before it, in the order they
 * joined): its colour the one its handle's seed points to, or the next one free, so no two share a colour until all
 * eight are taken (or the one you chose, snapped); its form the one its seed points to, or the next one no agent wears,
 * so colour and form both differ while they can; once every form is worn, the next one no agent of its colour wears, so
 * a ninth agent repeats a colour but never a form. O1's assign, as the sheet was drawn: hashing alone collides (three
 * of the dev fleet's ten shared a tint).
 */
export function assignMark(id: string, others: readonly AgentMark[], chosen?: string | null): AgentMark {
  const seed = handleSeed(String(id ?? ""));
  let color = seed % MARK_PALETTE.length;
  if (chosen) color = snapColor(chosen);
  else {
    const taken = new Set(others.map((m) => m.color));
    if (taken.size < MARK_PALETTE.length) while (taken.has(color)) color = (color + 1) % MARK_PALETTE.length;
  }
  const anyWorn = new Set(others.map((m) => m.form));
  const worn = new Set(others.filter((m) => m.color === color).map((m) => m.form));
  let form = (seed >>> 8) % MARK_FORMS;
  if (anyWorn.size < MARK_FORMS) while (anyWorn.has(form)) form = (form + 1) % MARK_FORMS;
  else if (worn.size < MARK_FORMS) while (worn.has(form)) form = (form + 1) % MARK_FORMS;
  return { color, form };
}

/** The order agents joined in: when each was made, then its handle (so a tie comes out the same on every node). */
export function joinOrder<T extends { id: string; createdAt: number }>(agents: readonly T[]): T[] {
  return [...agents].sort((a, b) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/* ---------- its states ---------- */

/**
 * What a mark shows: idle (solid and still); working (its slats slide, each in its own phase, calmly); needs (it asks
 * you: its top slat turns ink and beats); queued (pale); paused (grey); done (its slots close and open once as it
 * arrives, then still); failed (its bottom slat turns the shared red and drops loose: the shape carries the state, never
 * colour alone). Rows are always still, reduced motion stills everything, and nothing is drawn at rest.
 */
export const MARK_STATES = ["idle", "working", "needs", "queued", "paused", "done", "failed"] as const;
export type MarkState = (typeof MARK_STATES)[number];

/** Its motion's numbers: seconds. */
export const MARK_TIMING = { workCycle: 5.5, needsBeat: 4.2, doneSettle: 1.4, failDrop: 0.6 } as const;

/** The state an agent's mark shows for what it is seen doing (core's avatarExpression). */
export function markState(expression: AvatarExpression): MarkState {
  switch (expression) {
    case "thinking": case "working": case "reading": case "browsing": case "checking": return "working";
    case "asking": return "needs";
    case "waiting": return "queued";
    case "resting": return "paused";
    case "pleased": return "done";
    case "concerned": return "failed";
    default: return "idle";
  }
}

/** The colours it is drawn in: its body, and its key slat (the top one in ink when it asks you, the bottom one red when it failed). */
export function markColors(color: number, state: MarkState, theme: MarkTheme): { body: string; key: string } {
  const hue = MARK_PALETTE[color]![theme];
  const body = state === "queued" ? MARK_QUEUED[color]![theme] : state === "paused" ? MARK_PAUSED[theme] : hue;
  return { body, key: state === "needs" ? MARK_INK[theme] : state === "failed" ? MARK_RED[theme] : body };
}

/* ---------- its geometry ---------- */

/**
 * A slat, in a 100-unit box, about the box's middle and turned by the mark's angle: it lies across the disc from `from`
 * to `to` (along the slots' normal, downward before turning), as a band of the disc between those lines; slid `slide`
 * along its slot; filled as the body or the key; and, knocked loose, moved down `drop` units on the page and turned
 * `turn` degrees about `pivot` (a point of the box), the turn applied first.
 */
export interface MarkSlat {
  from: number;
  to: number;
  slide: number;
  fill: "body" | "key";
  drop: number;
  turn: number;
  pivot: [number, number];
}

export interface MarkGeometry {
  /** The slots' angle, degrees, clockwise. */
  angle: number;
  /** The disc's radius, units of the 100-unit box. */
  radius: number;
  slats: MarkSlat[];
}

/* ---------- its arithmetic: the same to the last bit everywhere ---------- */

/*
 * A mark's sines and cosines come from + − × ÷ and floor alone, in one fixed order, never from Math.sin, Math.cos or
 * Math.pow. What those say in their last bit is each platform's own: CI's Linux runner read one frame of the vectors one
 * bit off the Mac's (26 November 2026, a working slat's slide). Each of these operations is correctly rounded in
 * TypeScript, Swift and Kotlin, so every app draws a mark from exactly the vectors' numbers, as its colour is.
 *
 * An angle is taken to its quarter turn, q (the nearest), and what is left, r (|r| ≤ π/4, and a few ulps of reduction),
 * then Taylor's series to the 13th power for sine and the 14th for cosine: within 1e-13 of the true value for any angle
 * of a mark's, and 1e-10 a day into a page's clock (the reduction's share), far finer than any screen draws. The ports
 * copy these lines in this order.
 */
const QUARTER = Math.PI / 2;
const quarterOf = (x: number): { q: number; r: number } => {
  const q = Math.floor(x / QUARTER + 0.5);
  return { q, r: x - q * QUARTER };
};
const sinNear = (r: number): number => {
  const r2 = r * r;
  return r + r * r2 * (-1 / 6 + r2 * (1 / 120 + r2 * (-1 / 5040 + r2 * (1 / 362880 + r2 * (-1 / 39916800 + r2 * (1 / 6227020800))))));
};
const cosNear = (r: number): number => {
  const r2 = r * r;
  return 1 + r2 * (-1 / 2 + r2 * (1 / 24 + r2 * (-1 / 720 + r2 * (1 / 40320 + r2 * (-1 / 3628800 + r2 * (1 / 479001600 + r2 * (-1 / 87178291200)))))));
};
/** Which quarter turn, 0 to 3, of a whole number of them. */
const turnOf = (q: number): number => q - 4 * Math.floor(q / 4);

/** The sine of `x` radians, the same to the last bit on every platform. */
export function markSin(x: number): number {
  const { q, r } = quarterOf(x);
  const m = turnOf(q);
  return m === 0 ? sinNear(r) : m === 1 ? cosNear(r) : m === 2 ? -sinNear(r) : -cosNear(r);
}

/** The cosine of `x` radians, the same to the last bit on every platform. */
export function markCos(x: number): number {
  const { q, r } = quarterOf(x);
  const m = turnOf(q);
  return m === 0 ? cosNear(r) : m === 1 ? -sinNear(r) : m === 2 ? -cosNear(r) : sinNear(r);
}

const TAU = Math.PI * 2;
const beat = (t: number, period: number) => 0.5 - 0.5 * markCos((TAU * t) / period);
const easeOut = (x: number) => {
  const left = 1 - Math.min(1, Math.max(0, x));
  return 1 - left * left * left;
};

/**
 * Its slats as they stand: `size` the mark's square in points (a slot is 7.5 units, or 1.35 pt where that is wider);
 * `t` seconds on the page's clock (null: still, as every row and reduced motion draw it); `since` seconds since it came
 * to its state (null: long ago, settled). `seed`: its handle's (handleSeed), which sets its slats' phase.
 */
export function markGeometry(input: { mark: AgentMark; seed: number; state: MarkState; size: number; t: number | null; since: number | null }): MarkGeometry {
  const { mark, seed, state, size, t, since } = input;
  const { slots, angle } = markForm(mark.form);
  const radius = 44;
  let gap = Math.max(7.5, (1.35 * 100) / size);
  if (state === "done") gap *= 1 - 0.85 * (since !== null && since < MARK_TIMING.doneSettle ? markSin(Math.PI * (since / MARK_TIMING.doneSettle)) : 0);
  const n = slots + 1;
  const width = (2 * radius - slots * gap) / n;
  const turned = (angle * Math.PI) / 180;
  const slats: MarkSlat[] = [];
  for (let i = 0; i < n; i++) {
    const from = -radius + i * (width + gap);
    const to = from + width;
    const key = state === "needs" ? i === 0 : state === "failed" ? i === n - 1 : false;
    let slide = 0;
    if (state === "working" && t !== null) slide = 6 * markSin(TAU * (t / MARK_TIMING.workCycle) + (i * TAU) / n + (seed % 7));
    if (key && state === "needs") slide = t !== null ? 3 + 4 * beat(t, MARK_TIMING.needsBeat) : 5;
    let drop = 0, turn = 0;
    const middle = (from + to) / 2;
    const pivot: [number, number] = [50 - middle * markSin(turned), 50 + middle * markCos(turned)];
    if (key && state === "failed") {
      const k = since === null ? 1 : easeOut(since / MARK_TIMING.failDrop);
      drop = 8 * k;
      turn = 10 * k;
    }
    slats.push({ from, to, slide, fill: key ? "key" : "body", drop, turn, pivot });
  }
  return { angle, radius, slats };
}
