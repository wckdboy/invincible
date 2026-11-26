/*
 * The alerts' arithmetic, pure and unit-tested (their drawing is ui/toast.ts's, ui/banner.ts's and ui/controls.ts'
 * count). The iPhone, iPad, Mac and Android apps can take the same numbers.
 */

/** How many toasts show while the stack is tucked: the newest in front, two behind it. */
export const TOAST_SHOWN = 3;
/** The room between two toasts when the stack fans out, in CSS pixels. */
export const TOAST_GAP = 8;

/** Where one toast stands in the stack. */
export interface StackPlace {
  /** 0 for the newest, in front; 1 for the one behind it, and so on. */
  depth: number;
  /** How far back it is drawn while tucked: its depth, but never past the last that shows. */
  step: number;
  /** How far above the stack's foot it sits when the stack fans out: the newer ones' heights, each with the gap. */
  offset: number;
  /** Tucked behind the ones that show, out of sight until the stack fans out. */
  hidden: boolean;
  /** Its stacking order: the newer in front. */
  z: number;
  /** How tall it is drawn while tucked, against its own height: the front one's height, so only an edge shows behind
   * it. A scale, never a new height: a box that changed height would move on the page. */
  fit: number;
}

/** Each toast's place, given their heights oldest first (as they were raised); the places come in the same order. */
export function stackPlaces(heights: readonly number[], shown = TOAST_SHOWN, gap = TOAST_GAP): StackPlace[] {
  const places: StackPlace[] = new Array(heights.length);
  const front = heights.at(-1) ?? 0;
  let offset = 0;
  for (let index = heights.length - 1; index >= 0; index--) {
    const depth = heights.length - 1 - index;
    const own = heights[index]!;
    places[index] = { depth, step: Math.min(depth, shown), offset, hidden: depth >= shown, z: 100 - depth, fit: depth > 0 && own > 0 && front > 0 ? front / own : 1 };
    offset += own + gap;
  }
  return places;
}

/* ---------- the banner: whether Galahad can be reached ---------- */

/** What the banner says: this device is offline; Galahad can't be reached; he is reached again. */
export type Connection = "offline" | "unreachable" | "reconnected";

/** Each, as the banner says it: its tone, its words, whether it offers Retry, and whether the app is trying again
 * meanwhile (its line of light). Offline is no error: nothing is tried until the device is online again. */
export const CONNECTION: Record<Connection, { tone: "neutral" | "warn" | "ok"; text: string; retry: boolean; trying: boolean }> = {
  offline: { tone: "neutral", text: "You're offline. The app is cached; live data returns when you reconnect.", retry: true, trying: false },
  unreachable: { tone: "warn", text: "Can't reach Galahad right now. What you see may be out of date.", retry: true, trying: true },
  reconnected: { tone: "ok", text: "Reconnected", retry: false, trying: false },
};

/** How long it says he's reached again before it goes, in ms. */
export const RECONNECTED_MS = 1800;

export interface CourseOptions {
  /** Draws it saying this (there already, its words and tone change in place). */
  show(said: Connection): void;
  /** Takes it away. */
  hide(): void;
  /** Runs `run` after `ms`; returns how to call it off. */
  after(ms: number, run: () => void): () => void;
  /** Whether the browser says this device is offline now. */
  offline(): boolean;
}

/**
 * The banner's course. `reach` is each word from the app (lib/reach.ts) whether Galahad is reached; `network` the
 * browser's going offline or coming back. It says he can't be reached (or that this device is offline) while that
 * lasts, then "Reconnected" for a moment, then goes; while all is well it says nothing.
 */
export function connectionCourse(o: CourseOptions): { reach(reached: boolean): void; network(): void } {
  let said: Connection | null = null;
  let going: (() => void) | null = null;
  const say = (next: Connection) => {
    going?.();
    going = null;
    said = next;
    o.show(next);
  };
  return {
    reach(reached) {
      if (!reached) return say(o.offline() ? "offline" : "unreachable");
      if (said === null || said === "reconnected") return;
      say("reconnected");
      going = o.after(RECONNECTED_MS, () => {
        going = null;
        said = null;
        o.hide();
      });
    },
    network() {
      if (said !== "offline" && said !== "unreachable") return;
      const now: Connection = o.offline() ? "offline" : "unreachable";
      if (now !== said) say(now);
    },
  };
}

/* ---------- a count ---------- */

/** A count's figure: its number, up to 99; more is 99+. */
export const countText = (n: number): string => (n > 99 ? "99+" : String(n));

/** Which way a count's figure rolls from `from` (null: drawn the first time) to `to`: up as it grows, down as it
 * shrinks; null when its figure stays the same (99+ to 99+ too) or there was none before. */
export function countRoll(from: number | null, to: number): "up" | "down" | null {
  if (from === null || countText(from) === countText(to)) return null;
  return to > from ? "up" : "down";
}
