import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/* The app's stylesheet, as rules: a selector list and its declarations. */
const css = readFileSync(join(import.meta.dir, "index.html"), "utf8").match(/<style>([^]*?)<\/style>/)![1]!;
const rules = [...css.replace(/\/\*[^]*?\*\//g, "").matchAll(/([^{}]+)\{([^{}]*)\}/g)].map(([, selectors, body]) => ({
  selectors: selectors!.split(",").map((s) => s.trim().replace(/\s+/g, " ")),
  body: body!,
}));

/* The same rules with the @media conditions they sit in, for what a given screen sees. */
interface Placed { selectors: string[]; body: string; media: string[] }
function placed(text: string, media: string[] = []): Placed[] {
  const out: Placed[] = [];
  let at = 0;
  while (at < text.length) {
    const open = text.indexOf("{", at);
    if (open < 0) break;
    const prelude = text.slice(at, open).trim();
    let depth = 1, end = open + 1;
    for (; depth > 0 && end < text.length; end++) depth += text[end] === "{" ? 1 : text[end] === "}" ? -1 : 0;
    const inside = text.slice(open + 1, end - 1);
    if (prelude.startsWith("@media")) out.push(...placed(inside, [...media, prelude.slice(6).trim()]));
    else if (!prelude.startsWith("@")) out.push({ selectors: prelude.split(",").map((s) => s.trim().replace(/\s+/g, " ")), body: inside, media });
    at = end;
  }
  return out;
}
const all = placed(css.replace(/\/\*[^]*?\*\//g, ""));

interface Screen { width: number; touch: boolean }
/** Whether a media query holds on a screen: width and pointer are known; anything else might hold, so it's taken to. */
const holds = (query: string, screen: Screen) =>
  query.split(",").some((either) =>
    either.split(/\band\b/).every((part) => {
      const [, feature, value] = part.match(/\(\s*([\w-]+)\s*:\s*([^)]+)\)/) ?? [];
      if (feature === "max-width") return screen.width <= parseFloat(value!);
      if (feature === "min-width") return screen.width >= parseFloat(value!);
      if (feature === "pointer") return value!.trim() === (screen.touch ? "coarse" : "fine");
      if (feature === "hover") return value!.trim() === (screen.touch ? "none" : "hover");
      return !/^\s*print\s*$/.test(part);
    }),
  );

/** A font size as a screen computes it, in px: the root's custom properties, calc() sums. */
function px(value: string, vars: Map<string, string>): number {
  const resolved = value.replace(/var\((--[\w-]+)\)/g, (_, name: string) => vars.get(name) ?? "NaN");
  if (resolved.includes("var(")) return px(resolved, vars);
  const sum = resolved.replace(/^calc\((.*)\)$/, "$1").replace(/px/g, "");
  if (!/^[\d.\s+-]+$/.test(sum)) return Number.NaN;
  return sum.split(/\s+(?=[+-]\s)/).reduce((total, term) => total + Number(term.replace(/\s+/g, "")), 0);
}

describe("the stylesheet", () => {
  test("on a phone or a touch screen, no field the keyboard opens for is under 16px (iOS zooms the page into one that is)", () => {
    const field = /(^|[\s>+~])(input|textarea|select)(?![\w-])(?!\[type="(range|checkbox|radio)"\])|\.(input|textarea|select)(?![\w-])/;
    for (const screen of [{ width: 390, touch: true }, { width: 1024, touch: true }, { width: 800, touch: false }] satisfies Screen[]) {
      const seen = all.filter((rule) => rule.media.every((query) => holds(query, screen)));
      const vars = new Map<string, string>();
      for (const rule of seen.filter((r) => r.selectors.includes(":root"))) {
        for (const [, name, value] of rule.body.matchAll(/(--[\w-]+)\s*:\s*([^;]+)/g)) vars.set(name!, value!.trim());
      }
      const small: string[] = [];
      for (const rule of seen) {
        const targets = rule.selectors.filter((s) => field.test(s.split(/::?(?=placeholder|-webkit|-moz|-ms)/)[0]!) && !/::|:(hover|focus|disabled)/.test(s));
        if (!targets.length) continue;
        const size = rule.body.match(/(?:^|;)\s*font-size\s*:\s*([^;]+)/)?.[1] ?? rule.body.match(/(?:^|;)\s*font\s*:\s*(?:[\d]{3}\s+)?((?:var\([^)]+\)|calc\([^;]*?\)|[\d.]+px))/)?.[1];
        if (!size || /inherit/.test(size)) continue;
        const computed = px(size.trim(), vars);
        if (!(computed >= 16)) small.push(`${targets.join(", ")}: ${size.trim()} = ${computed}px`);
      }
      expect({ screen, small }).toEqual({ screen, small: screen.touch || screen.width < 960 ? [] : small });
    }
  });

  test("a double tap never zooms the page (pinching still does), and holding a button, a task's row or a filter brings up no link preview and selects nothing", () => {
    const declares = (selector: string, declaration: RegExp) => all.some((rule) => rule.media.length === 0 && rule.selectors.includes(selector) && declaration.test(rule.body));
    expect(declares("html", /touch-action:\s*manipulation/)).toBe(true);
    // Safari reads only the prefixed user-select.
    for (const control of [".btn", ".sidebar a", ".work-row", ".home-filter", ".selector-trigger"]) {
      expect([control, declares(control, /-webkit-touch-callout:\s*none/), declares(control, /-webkit-user-select:\s*none/)]).toEqual([control, true, true]);
    }
  });

  test("with the keyboard up, nothing keeps clear the home indicator's strip: the keyboard covers it", () => {
    // Seen in the iOS 26.1 simulator: the chat's message box stood the inset's 34 px above the keyboard.
    expect(all.some((rule) => rule.media.length === 0 && rule.selectors.includes(':root[data-keyboard="open"]') && /--safe-bottom:\s*0px/.test(rule.body))).toBe(true);
  });

  test("what a finger presses answers at once: a task's row, Galahad's row, the Inbox's, a fold and More's rows look pressed", () => {
    const pressed = (selector: string) => all.some((rule) => rule.selectors.some((s) => s === `${selector}:active`));
    for (const control of [".work-row", ".side-galahad", ".side-inbox", ".home-fold", ".rows > a.item", ".suggestion"]) expect([control, pressed(control)]).toEqual([control, true]);
  });

  test("on a phone, the palette's field lies exactly over the search button at the top bar's end (which grows into it), and Home's header lines up with the top bar at either side", () => {
    const phone: Screen = { width: 390, touch: true };
    const seen = all.filter((rule) => rule.media.every((query) => holds(query, phone)));
    // A phone held upright: no inset at the sides; the status bar's is the same for the bar and the palette.
    const vars = new Map([["--safe-top", "0px"], ["--safe-right", "0px"], ["--safe-left", "0px"]]);
    for (const rule of seen.filter((r) => r.selectors.includes(":root") || r.selectors.includes("dialog.palette"))) {
      for (const [, name, value] of rule.body.matchAll(/(--[\w-]+)\s*:\s*([^;]+)/g)) if (!name!.startsWith("--safe-")) vars.set(name!, value!.trim());
    }
    const declared = (selector: string, property: string) =>
      seen.filter((r) => r.selectors.includes(selector)).map((r) => r.body.match(new RegExp(`(?:^|;)\\s*${property}\\s*:\\s*([^;]+)`))?.[1]?.trim()).filter(Boolean).at(-1) ?? "";
    // A shorthand's parts (a calc() is one part); a length as arithmetic once its custom properties are filled in.
    const parts = (shorthand: string) => shorthand.match(/(?:[^\s(]+|\((?:[^()]|\([^()]*\))*\))+/g) ?? [];
    const length = (expression: string): number => {
      let e = expression;
      while (e.includes("var(")) e = e.replace(/var\((--[\w-]+)\)/g, (_, name: string) => vars.get(name) ?? "NaN");
      e = e.replace(/calc\(/g, "(").replace(/([\d.]+)vw/g, (_, n: string) => String((Number(n) * phone.width) / 100)).replace(/px/g, "");
      return /^[\d.\s+\-*/()]+$/.test(e) ? Number(Function(`return ${e}`)()) : Number.NaN;
    };
    const control = length("var(--control-h)");
    const button = { top: (length("var(--topbar-h)") - control) / 2, height: control, right: length(parts(declared(".topbar", "padding"))[1]!) };
    const field = { top: length(declared("dialog.palette", "margin-top")), height: length(declared("dialog.palette .palette-input", "height")), right: (phone.width - length(declared("dialog.palette", "width"))) / 2 };
    expect(field).toEqual(button);
    // (Its "…" sits where the top bar's does, at the same distance from either edge.)
    const sides = (selector: string) => { const p = parts(declared(selector, "padding")); return [p[1], p[3]]; };
    expect(sides(".home-head")).toEqual(sides(".topbar"));
  });

  test("Home's message box is docked at the foot, over the list (which fades out under it), and its fade takes no tap meant for a row", () => {
    // (The floating button it replaced covered the row under it; the dock's clear part lets a tap through to the list.)
    const dock = rules.find((r) => r.selectors.includes(".home-dock"));
    expect(dock?.body).toMatch(/position:\s*sticky/);
    expect(dock?.body).toMatch(/bottom:\s*0/);
    expect(dock?.body).toMatch(/pointer-events:\s*none/);
    expect(rules.some((r) => r.selectors.includes(".home-dock > *") && /pointer-events:\s*auto/.test(r.body))).toBe(true);
  });

  test("the bars at the top are solid, so the top of the app is one flat colour however the page under them scrolls", () => {
    // They were frosted glass: what scrolled under them showed through, blurred, as a grey haze just below the status
    // bar, which iOS paints solid in the page's colour (seen in the iOS 26.1 simulator, 15 Nov).
    for (const bar of [".topbar", ".home-head", ".thread-head", ".chat-head::before", ".tl-day"]) {
      const declared = all.filter((r) => r.selectors.includes(bar));
      const ground = declared.map((r) => r.body.match(/(?:^|;)\s*background\s*:\s*([^;]+)/)?.[1]?.trim()).filter(Boolean).at(-1);
      expect([bar, ground, declared.some((r) => /backdrop-filter/.test(r.body))]).toEqual([bar, "var(--bg)", false]);
    }
  });

  test("a text field that drops the browser's focus ring shows focus another way", () => {
    const unringed = rules.filter((r) => /outline:\s*none/.test(r.body)).flatMap((r) => r.selectors.filter((s) => /(^| )(input|textarea)$/.test(s)));
    const focusStyled = (field: string) => {
      const container = field.replace(/ (input|textarea)$/, "");
      return rules.some((r) => r.selectors.some((s) => s.startsWith(`${field}:focus`) || s === `${container}:focus-within`));
    };
    expect(unringed.filter((field) => !focusStyled(field))).toEqual([]);
  });

  test("with the keyboard up, the palette ends above it, so its last result can be reached", () => {
    // Seen in the iOS 26.1 simulator: iOS keeps the page full height under its keyboard, and the palette's lower part,
    // its last results with it, stood behind the keyboard. The palette measures the room above it (palette.ts).
    for (const screen of [{ width: 390, touch: true }, { width: 1024, touch: true }] satisfies Screen[]) {
      const heights = all.filter((r) => r.media.every((q) => holds(q, screen)) && r.selectors.includes("dialog.palette")).map((r) => r.body.match(/(?:^|;)\s*max-height\s*:\s*([^;]+)/)?.[1]?.trim()).filter(Boolean);
      expect([screen, heights.at(-1)?.includes("var(--room")]).toEqual([screen, true]);
    }
  });

  test("the palette's field keeps its height however long the list under it", () => {
    // The palette is a column with a height cap, and what may shrink in one does: with every command listed, it squeezed
    // the field from 54 px to 27 px, the text against its top and the focus line under it (seen in Chrome, 15 Nov).
    const keeps = rules.some((r) => r.selectors.includes(".palette-input") && /(?:^|;)\s*(?:flex\s*:\s*none|flex-shrink\s*:\s*0)\s*(?:;|$)/.test(r.body));
    expect(keeps).toBe(true);
  });

  test("where motion is reduced, nothing goes on moving: every animation that repeats, or takes a breath, is taken away", () => {
    // (Durations become near nothing where motion is reduced, which ends what runs once; what repeats is taken away
    // instead, as a loop made near instant would flicker. A spinner turns on: it is what says work is under way.)
    const lasting = /infinite|var\(--d-(breath|sweep)\)/;
    const moving = all.filter((r) => r.media.length === 0 && /(?:^|;)\s*animation(?:-name)?\s*:/.test(r.body) && lasting.test(r.body)).flatMap((r) => r.selectors);
    const stilled = (selector: string, by: string, media: (m: string[]) => boolean) =>
      all.some((r) => media(r.media) && r.selectors.includes(`${by} ${selector}`) && /(?:^|;)\s*animation\s*:\s*none\s*(?:;|$)/.test(r.body));
    const unstilled = moving
      .filter((selector) => selector !== ".spinner")
      .filter(
        (selector) =>
          !stilled(selector, ':root[data-motion="reduce"]', (m) => m.length === 0) ||
          !stilled(selector, ':root:not([data-motion="full"])', (m) => m.length === 1 && /prefers-reduced-motion:\s*reduce/.test(m[0]!)),
      );
    expect(moving.length).toBeGreaterThan(2);
    expect(unstilled).toEqual([]);
  });

  test("nothing animates at rest: what repeats for ever says only that something is loading or being written", () => {
    // (Your word, 26 November 2026: a hyper-modern interface with nothing animating at rest. A state's dot is lit, still;
    // the banner's line of light passes once as it tries again. Loading and writing are not rest.)
    const ALLOWED = [".spinner", ".skeleton::after", ".caret", ".boot img"];
    const forever = all.filter((r) => /(?:^|;)\s*animation(?:-iteration-count)?\s*:[^;]*\binfinite\b/.test(r.body)).flatMap((r) => r.selectors);
    expect(forever.filter((selector) => !ALLOWED.includes(selector))).toEqual([]);
  });
});
