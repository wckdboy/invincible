/*
 * The DOM layer. Everything is built with createElement / createElementNS and
 * textContent: model output, memories, device names and anything else that is
 * not a constant are never parsed as HTML. There is deliberately no helper
 * here that accepts an HTML string.
 */

export type Child = Node | string | number | null | undefined | false | Child[];

// Bivariant so handlers can name their concrete event type (KeyboardEvent…) without `any`.
type Listener = { bivarianceHack(event: Event): void }["bivarianceHack"];
export type AttrValue = string | number | boolean | null | undefined | Listener;
export type Attrs = Record<string, AttrValue>;

const PROPS = new Set(["value", "checked", "indeterminate", "selected", "disabled", "hidden"]);

function applyAttrs(el: Element, attrs: Attrs): void {
  for (const [key, value] of Object.entries(attrs)) {
    if (value === null || value === undefined) continue;
    if (key.startsWith("on") && typeof value === "function") {
      el.addEventListener(key.slice(2).toLowerCase(), value);
    } else if (typeof value === "function") {
      continue;
    } else if (key === "class") {
      if (value !== false) el.setAttribute("class", String(value));
    } else if (PROPS.has(key) && key in el) {
      (el as unknown as Record<string, unknown>)[key] = key === "value" ? String(value) : Boolean(value);
    } else if (value === false) {
      continue;
    } else if (value === true) {
      el.setAttribute(key, "");
    } else {
      el.setAttribute(key, String(value));
    }
  }
}

export function h<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Attrs = {}, ...children: Child[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  applyAttrs(el, attrs);
  append(el, ...children);
  return el;
}

const SVG_NS = "http://www.w3.org/2000/svg";

export function svg<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Attrs = {}, ...children: Child[]): SVGElementTagNameMap[K] {
  const el = document.createElementNS(SVG_NS, tag) as SVGElementTagNameMap[K];
  applyAttrs(el, attrs);
  append(el, ...children);
  return el;
}

export function append(parent: Node, ...children: Child[]): void {
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue;
    if (Array.isArray(child)) append(parent, ...child);
    else parent.appendChild(typeof child === "string" || typeof child === "number" ? document.createTextNode(String(child)) : child);
  }
}

export function clear(node: Element): void {
  while (node.firstChild) node.removeChild(node.firstChild);
}

export function replace(node: Element, ...children: Child[]): void {
  clear(node);
  append(node, ...children);
}

/**
 * Puts `next` in `parent`, in that order, moving as little as it can: children not in it are taken out, those already
 * in their place are left alone, the rest go in where they belong. A list that refreshes in the background keeps what
 * hasn't changed (focus, opened details, a live child's own state) by handing back the same elements.
 */
export function syncChildren(parent: Element, next: readonly Node[]): void {
  const keep = new Set(next);
  for (let child = parent.firstChild; child; ) {
    const after = child.nextSibling;
    if (!keep.has(child)) parent.removeChild(child);
    child = after;
  }
  let at = parent.firstChild;
  for (const node of next) {
    if (node === at) at = at.nextSibling;
    else parent.insertBefore(node, at);
  }
}

const placeKey = (el: Element): string => el.getAttribute("data-key") ?? el.getAttribute("aria-label") ?? (el.id || el.textContent?.trim().slice(0, 80) || "");

/**
 * Re-render `root` without losing the user's place: keyboard focus and opened
 * <details> are restored by matching key (data-key, aria-label, id or text).
 * For views that refresh live data in the background.
 */
export function keepPlace(root: Element, render: () => void): void {
  const active = document.activeElement instanceof HTMLElement && root.contains(document.activeElement) ? document.activeElement : null;
  const focusKey = active ? placeKey(active) : null;
  const open = new Set([...root.querySelectorAll("details[open]")].map((d) => placeKey(d.querySelector("summary") ?? d)));
  render();
  for (const details of root.querySelectorAll("details")) if (open.has(placeKey(details.querySelector("summary") ?? details))) details.open = true;
  if (active && focusKey && !active.isConnected) {
    const match = [...root.querySelectorAll<HTMLElement>(active.tagName)].find((el) => placeKey(el) === focusKey);
    match?.focus({ preventScroll: true });
  }
}

/** Joins class names, skipping falsy ones. */
export const cx = (...names: (string | false | null | undefined)[]): string => names.filter(Boolean).join(" ");

let uid = 0;
export const nextId = (prefix = "g"): string => `${prefix}-${++uid}`;

/**
 * A view's lifetime: timers, listeners and in-flight requests registered here
 * are cleaned up when the view goes away. `signal` aborts pending fetches.
 */
export class Scope {
  private readonly cleanups: (() => void)[] = [];
  private readonly controller = new AbortController();
  disposed = false;

  get signal(): AbortSignal {
    return this.controller.signal;
  }

  add(cleanup: () => void): void {
    if (this.disposed) cleanup();
    else this.cleanups.push(cleanup);
  }

  interval(fn: () => void, ms: number): void {
    const id = setInterval(fn, ms);
    this.add(() => clearInterval(id));
  }

  timeout(fn: () => void, ms: number): void {
    const id = setTimeout(fn, ms);
    this.add(() => clearTimeout(id));
  }

  listen<K extends keyof WindowEventMap>(target: Window, type: K, fn: (event: WindowEventMap[K]) => void, options?: AddEventListenerOptions): void;
  listen<K extends keyof DocumentEventMap>(target: Document, type: K, fn: (event: DocumentEventMap[K]) => void, options?: AddEventListenerOptions): void;
  listen(target: EventTarget, type: string, fn: (event: Event) => void, options?: AddEventListenerOptions): void;
  listen(target: EventTarget, type: string, fn: (event: Event) => void, options?: AddEventListenerOptions): void {
    target.addEventListener(type, fn, options);
    this.add(() => target.removeEventListener(type, fn, options));
  }

  /** A child scope that is disposed with this one (or earlier, on its own). */
  child(): Scope {
    const scope = new Scope();
    this.add(() => scope.dispose());
    return scope;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.controller.abort();
    for (const cleanup of this.cleanups.splice(0).reverse()) {
      try {
        cleanup();
      } catch {
        /* cleanup must never break navigation */
      }
    }
  }
}

export function prefersReducedMotion(): boolean {
  const pref = document.documentElement.dataset.motion;
  if (pref === "reduce") return true;
  if (pref === "full") return false;
  return matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/** Debounce for search-as-you-type. */
export function debounce<A extends unknown[]>(fn: (...args: A) => void, ms: number): ((...args: A) => void) & { cancel(): void } {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const run = (...args: A) => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      fn(...args);
    }, ms);
  };
  return Object.assign(run, {
    cancel() {
      if (timer) clearTimeout(timer);
      timer = null;
    },
  });
}

/** True when focus is in something that takes text, so single-key shortcuts stay out of the way. */
export function isTyping(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName);
}

export const isMac = (): boolean => /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
