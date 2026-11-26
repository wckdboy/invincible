import { stackPlaces } from "../lib/alerts.ts";
import { h } from "./dom.ts";
import { icon, type IconName } from "./icons.ts";

/*
 * Stacked toasts in the Sonner manner: newest in front, older ones tucked behind and scaled back, the whole stack
 * fanning out on hover or focus. Timers pause while you're reading. Errors stay longer and are announced
 * assertively; everything else politely.
 *
 * Their look (26 November 2026, to sit with Galahad's field): a precise surface with a hairline edge, its tone in that
 * edge and in a faint light behind its mark, never a coloured slab; one about a knight or Galahad may lead with their
 * orb, small and still. One comes into focus as it rises (a few pixels, out of a slight blur, with a whisper of
 * scale) and leaves with a short fade and drop. Where motion is reduced it only appears, and goes.
 *
 * By keyboard: Alt+T (⌥T) goes to the newest toast's first control, Tab moves among them, Esc puts away the one you are
 * on; focus then goes to the next, or back where it was before. On a page with a message box docked at its foot, the
 * stack rises above it rather than covering it.
 */

export type ToastTone = "info" | "ok" | "warn" | "error";

export interface ToastOptions {
  description?: string;
  tone?: ToastTone;
  action?: { label: string; run: () => void };
  /** ms; 0 keeps it until dismissed. */
  duration?: number;
  /** Who it is about, in place of the tone's mark: a knight's face or Galahad's orb (ui/orb.ts knightFace, orb), 28 px
   * and still, its name in the title beside it. */
  lead?: HTMLElement;
}

interface Live {
  el: HTMLElement;
  /** Its height drawn whole: the stack, tucked, draws those behind the front one as tall as it (by a scale). */
  height: number;
  remaining: number;
  started: number;
  timer: ReturnType<typeof setTimeout> | null;
}

const TONE_ICON: Record<ToastTone, IconName> = { info: "info", ok: "check-circle", warn: "alert", error: "x-circle" };
/** Its colours, by index.html's [data-tone]: an error's are the danger tone's. */
const TONE_DATA: Record<ToastTone, string> = { info: "info", ok: "ok", warn: "warn", error: "danger" };
/** How long one takes to go, at most (its fade is --d-2; it is taken out of the page by then, transition or not). */
const LEAVING_MS = 400;
/** A message box docked at the screen's foot (Home's, a chat's, a task's, a room's): the toasts rise clear of it. */
const DOCKED = ".composer, .home-composer";

let toaster: HTMLElement | null = null;
let politeRegion: HTMLElement | null = null;
let assertiveRegion: HTMLElement | null = null;
const live: Live[] = [];
let paused = false;
/** Where focus was before it came into the toasts, to go back to once they are put away. */
let cameFrom: HTMLElement | null = null;

function ensureToaster(): HTMLElement {
  if (toaster?.isConnected) return toaster;
  toaster = h("section", { class: "toaster", "aria-label": "Notifications", "aria-keyshortcuts": "Alt+T" });
  politeRegion = h("div", { class: "sr-only", role: "status", "aria-live": "polite" });
  assertiveRegion = h("div", { class: "sr-only", role: "alert", "aria-live": "assertive" });
  toaster.addEventListener("pointerenter", pause);
  toaster.addEventListener("pointerleave", resume);
  toaster.addEventListener("focusin", (event) => {
    pause();
    const from = event.relatedTarget;
    if (from instanceof HTMLElement && !toaster?.contains(from)) cameFrom = from;
  });
  toaster.addEventListener("focusout", resume);
  // Esc puts away the toast you are on (and nothing else hears it: it doesn't also stop him).
  toaster.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") return;
    const item = live.find((each) => each.el.contains(event.target as Node));
    if (!item) return;
    event.preventDefault();
    event.stopPropagation();
    dismiss(item);
  });
  document.body.append(toaster, politeRegion, assertiveRegion);
  // Alt+T (⌥T): to the newest toast's first control, wherever focus is. (Listened for from the first toast on, not on
  // import: a bundle that never raises one, the pairing page's, leaves this module out.)
  if (!reaching) {
    reaching = true;
    document.addEventListener("keydown", reach);
  }
  return toaster;
}

let reaching = false;
function reach(event: KeyboardEvent): void {
  if (!event.altKey || event.metaKey || event.ctrlKey || event.code !== "KeyT" || !live.length) return;
  const control = live.at(-1)!.el.querySelector<HTMLElement>("button");
  if (!control) return;
  event.preventDefault();
  control.focus();
}

/** Rises clear of a message box docked at the screen's foot, where the page has one (`--dock-h`: from its top down). */
function clearOfDock(host: HTMLElement): void {
  let lift = 0;
  for (const box of document.querySelectorAll<HTMLElement>(DOCKED)) {
    const at = box.getBoundingClientRect();
    if (at.height > 0 && at.top > innerHeight / 2 && at.top < innerHeight) lift = Math.max(lift, innerHeight - at.top);
  }
  host.style.setProperty("--dock-h", `${Math.round(lift)}px`);
}

/** Each toast in its place (lib/alerts.ts stackPlaces): `--i` its step back while tucked, `--fit` its height then
 * (the front one's, by a scale), `--offset` its height above the foot when fanned out; the front one marked. */
function layout(): void {
  const places = stackPlaces(live.map((item) => item.height));
  live.forEach((item, index) => {
    const place = places[index]!;
    item.el.style.setProperty("--i", String(place.step));
    item.el.style.setProperty("--offset", `${place.offset}px`);
    item.el.style.setProperty("--fit", String(place.fit));
    item.el.style.zIndex = String(place.z);
    item.el.dataset.hidden = String(place.hidden);
    item.el.toggleAttribute("data-front", place.depth === 0);
  });
}

function schedule(item: Live): void {
  if (item.remaining <= 0 || paused) return;
  item.started = Date.now();
  item.timer = setTimeout(() => dismiss(item), item.remaining);
}

function pause(): void {
  paused = true;
  for (const item of live) {
    if (item.timer) {
      clearTimeout(item.timer);
      item.timer = null;
      item.remaining -= Date.now() - item.started;
    }
  }
}

function resume(): void {
  paused = false;
  for (const item of live) if (!item.timer && item.remaining > 0) schedule(item);
}

function dismiss(item: Live): void {
  const index = live.indexOf(item);
  if (index < 0) return;
  const hadFocus = item.el.contains(document.activeElement);
  live.splice(index, 1);
  if (item.timer) clearTimeout(item.timer);
  item.el.classList.add("leaving");
  const remove = () => item.el.remove();
  // (Its own transition's end, not one of its words' fading inside it.)
  item.el.addEventListener("transitionend", (event) => event.target === item.el && remove());
  setTimeout(remove, LEAVING_MS);
  layout();
  // Focus on it goes on to the next one, or back where it came from: never lost with the toast.
  if (hadFocus) {
    const next = live.at(-1)?.el.querySelector<HTMLElement>("button") ?? (cameFrom?.isConnected ? cameFrom : null);
    next?.focus({ preventScroll: true });
  }
}

/** A toast as it is drawn: `done` puts it away (its close button, and its action once run). toast() raises one; the
 * gallery (apps/web/design/gallery.ts) draws them in place. */
export function toastCard(title: string, options: ToastOptions = {}, done: () => void = () => {}): HTMLElement {
  const tone = options.tone ?? "info";
  const close = h("button", { class: "btn ghost sm icon-only toast-close", type: "button", "aria-label": "Dismiss", onclick: done }, icon("x", { size: 14 }));
  return h(
    "div",
    { class: "toast", "data-tone": TONE_DATA[tone] },
    options.lead ? h("span", { class: "toast-lead is-face" }, options.lead) : h("span", { class: "toast-lead" }, icon(TONE_ICON[tone], { size: 16 })),
    h("div", { class: "toast-body" }, h("div", { class: "toast-title" }, title), options.description ? h("div", { class: "toast-desc" }, options.description) : null),
    options.action
      ? h(
          "button",
          {
            class: "btn sm toast-action",
            type: "button",
            onclick: () => {
              options.action?.run();
              done();
            },
          },
          options.action.label,
        )
      : null,
    close,
  );
}

export function toast(title: string, options: ToastOptions = {}): () => void {
  // A modal dialog makes the rest of the page inert and covers it, so a toast raised
  // now would be hidden and unannounced. Show it once the dialog has closed instead;
  // feedback that belongs inside a dialog is shown inline there.
  const modal = [...document.querySelectorAll<HTMLDialogElement>("dialog:modal")].at(-1);
  if (modal) {
    let cancelled = false;
    let dismissLater: (() => void) | null = null;
    modal.addEventListener("close", () => {
      if (!cancelled) dismissLater = toast(title, options);
    }, { once: true });
    return () => {
      cancelled = true;
      dismissLater?.();
    };
  }
  const host = ensureToaster();
  const tone = options.tone ?? "info";
  const duration = options.duration ?? (tone === "error" ? 8000 : options.action ? 6000 : 4000);
  clearOfDock(host);
  const el = toastCard(title, options, () => dismiss(item));
  // It comes in at the front, drawn whole: its height is its own (the tucked ones are drawn as tall, by a scale).
  el.classList.add("entering");
  el.toggleAttribute("data-front", true);
  const item: Live = { el, height: 0, remaining: duration, started: Date.now(), timer: null };
  host.appendChild(el);
  item.height = el.offsetHeight;
  live.push(item);
  layout();
  requestAnimationFrame(() => requestAnimationFrame(() => el.classList.remove("entering")));
  const region = tone === "error" ? assertiveRegion : politeRegion;
  if (region) region.textContent = options.description ? `${title}. ${options.description}` : title;
  schedule(item);
  while (live.length > 8) dismiss(live[0]!);
  return () => dismiss(item);
}
