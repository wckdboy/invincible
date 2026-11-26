/*
 * One clock for everything on the page that moves while a state lasts (ui/orb.ts' orbs; your word, 24 November 2026:
 * "pulsing/moving when doing a task, sitting idle, waiting, done"). It draws one animation frame at a time for all of
 * them, only what is on screen, only as often as each asks (none, once it has come to rest), and nothing while the
 * page is hidden. When motion is reduced (the device asks for it, or Settings → Motion says so), each is drawn once,
 * still, and the clock stops until that changes.
 */

import { prefersReducedMotion } from "./dom.ts";

/** Draws a moment: `t` in seconds (from any fixed moment), and whether it may move (false: draw it still). */
export type Draw = (t: number, moving: boolean) => void;

interface Mover {
  el: Element;
  draw: Draw;
  /** How many frames a second it needs now. */
  fps: () => number;
  /** When it was last drawn (or, not yet on the page, looked for), in ms. */
  last: number;
  /** Whether it has been on the page; one that leaves it is forgotten. */
  seen: boolean;
  /** How many times it has been looked for on the page, not yet there. */
  waited: number;
  onScreen: boolean;
  still: boolean;
}

const movers = new Map<Element, Mover>();
/** One not yet on the page is looked for this often (ms), this many times. */
const LOOK_EVERY = 100;
const LOOKS = 50;
let request = 0;
let timer: ReturnType<typeof setTimeout> | 0 = 0;
let watching = false;
let observer: IntersectionObserver | null = null;

/** Whether things may move: the app's own setting first (Settings → Motion), then the device's (ui/dom.ts). */
export function motionAllowed(): boolean {
  return typeof document !== "undefined" && typeof matchMedia === "function" && !prefersReducedMotion();
}

/** Draws `el` with `draw` `fps()` times a second while it is on the page and on screen; forgets it once it has left
 * the page (drawn again, or its page left). Its first moment is drawn already, as it was made: still, where motion is
 * reduced. */
export function move(el: Element, draw: Draw, fps: () => number): void {
  movers.set(el, { el, draw, fps, last: Number.NEGATIVE_INFINITY, seen: false, waited: 0, onScreen: true, still: !motionAllowed() });
  if (typeof IntersectionObserver === "function") {
    observer ??= new IntersectionObserver((entries) => {
      for (const entry of entries) {
        const mover = movers.get(entry.target);
        if (mover) mover.onScreen = entry.isIntersecting;
      }
      wake();
    });
    observer.observe(el);
  }
  watch();
  wake();
}

/** Asks for a frame now (something new to draw, or to look at again). */
function wake(): void {
  if (timer) clearTimeout(timer);
  timer = 0;
  if (request || !movers.size || typeof requestAnimationFrame !== "function" || document.hidden) return;
  request = requestAnimationFrame(tick);
}

/** Asks for the frame `delay` ms from now: by a timer until it is nearly due, so the page draws no frame between (a
 * frame asked for at every refresh of the screen would make the page do its other animations' work at every one). */
function later(delay: number): void {
  if (delay <= 20) return wake();
  if (timer || request) return;
  timer = setTimeout(() => {
    timer = 0;
    wake();
  }, delay - 12);
}

function tick(now: number): void {
  request = 0;
  const moving = motionAllowed();
  const t = now / 1000;
  let again = false;
  let next = Number.POSITIVE_INFINITY;
  for (const mover of movers.values()) {
    if (!mover.el.isConnected) {
      // One that was on the page and has left it is forgotten. One not yet put on it is looked for ten times a second
      // for five seconds, not at every frame: each frame the page draws runs its other animations too (the knights'
      // eyes, on every seat).
      if (!mover.seen && now - mover.last >= LOOK_EVERY - 6) {
        mover.last = now;
        mover.waited++;
      }
      if (mover.seen || mover.waited > LOOKS) {
        movers.delete(mover.el);
        observer?.unobserve(mover.el);
      } else {
        again = true;
        next = Math.min(next, mover.last + LOOK_EVERY);
      }
      continue;
    }
    mover.seen = true;
    if (!moving) {
      if (!mover.still) mover.draw(t, false);
      mover.still = true;
      continue;
    }
    mover.still = false;
    if (!mover.onScreen) continue;
    // One with nothing to move now (an orb come to rest) asks for no frame; it is looked at again when the clock wakes.
    const fps = mover.fps();
    if (!(fps > 0)) continue;
    again = true;
    // (A frame early by less than a refresh of the screen is drawn now, not a whole refresh late.)
    const every = 1000 / fps;
    if (now - mover.last >= every - 6) {
      mover.last = now;
      mover.draw(t, true);
    }
    next = Math.min(next, mover.last + every);
  }
  // Still, or nothing on screen: the clock waits for motion to be allowed, for one to come on screen, or a new one.
  if (again) later(next - now);
}

function watch(): void {
  if (watching || typeof document === "undefined") return;
  watching = true;
  document.addEventListener?.("visibilitychange", wake);
  if (typeof matchMedia === "function") matchMedia("(prefers-reduced-motion: reduce)").addEventListener?.("change", wake);
  if (typeof MutationObserver === "function") new MutationObserver(wake).observe(document.documentElement, { attributes: true, attributeFilter: ["data-motion"] });
}
