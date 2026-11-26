import { type Box, dropIndex, dropMark } from "../lib/arrange.ts";
import { h } from "./dom.ts";

/*
 * Moving things by dragging them, with a mouse or a pen (a finger scrolls the page: the Arrange buttons serve a phone,
 * and a keyboard). An item is lifted once the pointer has moved a few pixels holding it, follows the pointer, and a line
 * of ink shows where it would go (lib/arrange.ts says where). Let go, the caller is told the item's key and its place
 * among the others; Escape puts it back. The click that ends a drag opens nothing, and nothing animates: the item is
 * where the pointer is.
 */

export interface Sortable {
  /** Whether something is held or being dragged now (a list that redraws waits until it is let go). */
  dragging(): boolean;
  dispose(): void;
}

export interface SortableOptions {
  /** The items that move among one another, in their order, each with its data-key. */
  items(): HTMLElement[];
  /** How they are laid out now: a list or a board, and the space between two of them, where the line is drawn. */
  layout(): { kind: "rows" | "grid"; gap: number };
  /** Let go: the key of what moved, and its place among the others (the others in their order, it not among them). */
  onDrop(key: string, index: number): void;
  /** However a drag ended (to draw what waited for it). */
  onEnd?(): void;
}

/** How far the pointer moves holding an item before the item is lifted: less is a click. */
const LIFT_PX = 5;

export function sortable(container: HTMLElement, options: SortableOptions): Sortable {
  let held: { item: HTMLElement; key: string; x: number; y: number; pointer: number } | null = null;
  let lifted: { boxes: Box[]; mark: HTMLElement; index: number; kind: "rows" | "grid"; gap: number } | null = null;

  // Where things are inside the container, scrolled with it.
  const inside = (x: number, y: number) => {
    const at = container.getBoundingClientRect();
    return { x: x - at.left + container.scrollLeft, y: y - at.top + container.scrollTop };
  };
  const box = (el: HTMLElement): Box => {
    const rect = el.getBoundingClientRect();
    return { ...inside(rect.left, rect.top), width: rect.width, height: rect.height };
  };

  const listen = (on: boolean) => {
    const method = on ? "addEventListener" : "removeEventListener";
    window[method]("pointermove", move as EventListener);
    window[method]("pointerup", up as EventListener);
    window[method]("pointercancel", cancel);
    window[method]("keydown", escape as EventListener);
  };

  function down(event: PointerEvent): void {
    if (event.button !== 0 || event.pointerType === "touch" || held) return;
    const target = event.target instanceof Element ? event.target : null;
    // (A control in an item keeps its own press.)
    if (!target || target.closest("button, input, textarea, select")) return;
    const item = target.closest<HTMLElement>("[data-key]");
    if (!item || !options.items().includes(item)) return;
    held = { item, key: item.dataset.key!, ...inside(event.clientX, event.clientY), pointer: event.pointerId };
    listen(true);
  }

  function move(event: PointerEvent): void {
    if (!held || event.pointerId !== held.pointer) return;
    const at = inside(event.clientX, event.clientY);
    if (!lifted) {
      if (Math.hypot(at.x - held.x, at.y - held.y) < LIFT_PX) return;
      const mark = h("div", { class: "drop-mark", "aria-hidden": "true", hidden: true });
      container.append(mark);
      lifted = { boxes: options.items().filter((other) => other !== held!.item).map(box), mark, index: -1, ...options.layout() };
      held.item.classList.add("dragging");
      container.dataset.sorting = "";
    }
    event.preventDefault();
    held.item.style.transform = `translate(${Math.round(at.x - held.x)}px, ${Math.round(at.y - held.y)}px)`;
    const index = dropIndex(lifted.boxes, at.x, at.y, lifted.kind);
    if (index === lifted.index) return;
    lifted.index = index;
    const line = dropMark(lifted.boxes, index, lifted.kind, lifted.gap);
    lifted.mark.hidden = !line;
    if (line) lifted.mark.style.cssText = `transform: translate(${line.x}px, ${line.y}px); width: ${line.width}px; height: ${line.height}px`;
  }

  function end(drop: boolean): void {
    const was = held;
    const at = lifted;
    held = null;
    lifted = null;
    listen(false);
    if (!was) return;
    if (at) {
      was.item.classList.remove("dragging");
      was.item.style.transform = "";
      at.mark.remove();
      delete container.dataset.sorting;
      // The click that ends a drag (it comes in the same turn as the pointer's release) opens nothing.
      const swallow = (event: Event) => (event.preventDefault(), event.stopPropagation());
      window.addEventListener("click", swallow, { capture: true, once: true });
      setTimeout(() => window.removeEventListener("click", swallow, { capture: true }));
      if (drop && at.index >= 0) options.onDrop(was.key, at.index);
    }
    options.onEnd?.();
  }

  const up = (event: PointerEvent) => held && event.pointerId === held.pointer && end(true);
  const cancel = () => end(false);
  const escape = (event: KeyboardEvent) => {
    if (event.key !== "Escape" || !lifted) return;
    event.preventDefault();
    event.stopPropagation();
    end(false);
  };

  container.addEventListener("pointerdown", down);
  return {
    dragging: () => held !== null,
    dispose() {
      end(false);
      container.removeEventListener("pointerdown", down);
    },
  };
}
