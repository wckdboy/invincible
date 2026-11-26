import { rank } from "../lib/fuzzy.ts";
import { h, nextId, prefersReducedMotion, replace } from "./dom.ts";
import { icon, type IconName } from "./icons.ts";

/*
 * The command palette (⌘K / Ctrl+K): fuzzy search over everywhere you can go
 * and everything you can do. A combobox + listbox, fully keyboard-driven;
 * opens instantly (it is used often, so it barely animates). On a phone it is
 * the top bar's search: opened from the button there, it grows out of it.
 */

export interface Command {
  id: string;
  label: string;
  group: string;
  icon: IconName;
  keywords?: string[];
  /** Shortcut hint shown on the right, e.g. "G C". */
  hint?: string;
  run(): void;
}

export interface PaletteSource {
  commands(): Command[];
  /** Extra items computed from the query, e.g. "Search memory for …". */
  dynamic?(query: string): Command[];
}

let openDialog: HTMLDialogElement | null = null;

/** Where the palette is the top bar's search, its field lying over the bar's search button (index.html). */
const BAR_SEARCH = "(max-width: 639px)";

interface Box {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

/** The clip that shows only the button's part of the palette (both boxes in the viewport's px): what it grows from. */
export function clipTo(button: Box, palette: Box, radius: number): string {
  const inset = [button.top - palette.top, palette.right - button.right, palette.bottom - button.bottom, button.left - palette.left];
  return `inset(${inset.map((n) => `${Math.max(0, Math.round(n))}px`).join(" ")} round ${radius}px)`;
}

export function isPaletteOpen(): boolean {
  return Boolean(openDialog?.open);
}

export function openPalette(source: PaletteSource, initialQuery = "", from?: Element | null): void {
  if (openDialog?.open) {
    openDialog.querySelector("input")?.focus();
    return;
  }
  const returnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  const listId = nextId("palette-list");
  const input = h("input", {
    type: "text",
    role: "combobox",
    "aria-expanded": "true",
    "aria-controls": listId,
    "aria-autocomplete": "list",
    "aria-label": "Search commands and pages",
    placeholder: "Search or jump to…",
    autocomplete: "off",
    autocorrect: "off",
    spellcheck: "false",
    value: initialQuery,
  });
  const list = h("div", { class: "palette-list", role: "listbox", id: listId, "aria-label": "Results" });
  const status = h("div", { class: "sr-only", role: "status", "aria-live": "polite" });
  // A touch screen has no Esc: it gets Cancel instead (index.html shows one or the other).
  const cancel = h("button", { class: "palette-cancel", type: "button" }, "Cancel");
  const field = h("div", { class: "palette-input" }, icon("search", { size: 18 }), input, h("kbd", {}, "Esc"), cancel);
  const dialog = h(
    "dialog",
    { class: "palette", "aria-label": "Command palette" },
    field,
    list,
    h(
      "div",
      { class: "palette-foot", "aria-hidden": "true" },
      h("span", {}, h("kbd", {}, "↑"), h("kbd", {}, "↓"), "to move"),
      h("span", {}, h("kbd", {}, "↵"), "to choose"),
      h("span", {}, h("kbd", {}, "Esc"), "to close"),
    ),
    status,
  );
  openDialog = dialog;

  let items: { command: Command; el: HTMLElement }[] = [];
  let active = 0;
  /** The button it grew out of, if it did: it goes back into it. */
  let grewFrom: Element | null = null;
  let closing = false;

  function select(index: number, scroll = true): void {
    if (!items.length) {
      input.removeAttribute("aria-activedescendant");
      return;
    }
    active = (index + items.length) % items.length;
    items.forEach((item, i) => item.el.setAttribute("aria-selected", String(i === active)));
    const el = items[active]!.el;
    input.setAttribute("aria-activedescendant", el.id);
    if (scroll) el.scrollIntoView({ block: "nearest" });
  }

  function labelWithMatches(label: string, indices: number[]): HTMLElement {
    const span = h("span", { class: "pl-label" });
    const set = new Set(indices);
    let run = "";
    let marked = false;
    const flush = () => {
      if (!run) return;
      span.append(marked ? h("mark", {}, run) : run);
      run = "";
    };
    for (let i = 0; i < label.length; i++) {
      const m = set.has(i);
      if (m !== marked) {
        flush();
        marked = m;
      }
      run += label[i];
    }
    flush();
    return span;
  }

  function render(): void {
    const query = input.value;
    const ranked = rank(query, source.commands());
    const extra = query.trim() ? (source.dynamic?.(query.trim()) ?? []) : [];
    const results = [...ranked.map((r) => ({ command: r.item, indices: r.match.indices })), ...extra.map((command) => ({ command, indices: [] as number[] }))];
    items = [];
    const nodes: HTMLElement[] = [];
    let group = "";
    // Without a query, keep the curated grouping; with one, a flat best-first list.
    const grouped = !query.trim();
    for (const { command, indices } of results) {
      if (grouped && command.group !== group) {
        group = command.group;
        nodes.push(h("div", { class: "palette-group", role: "presentation" }, group));
      }
      const el = h(
        "div",
        { class: "palette-item", role: "option", id: nextId("pl"), "aria-selected": "false" },
        icon(command.icon, { size: 16 }),
        labelWithMatches(command.label, indices),
        command.hint ? h("span", { class: "pl-hint" }, command.hint) : null,
      );
      const index = items.length;
      el.addEventListener("pointermove", () => active !== index && select(index, false));
      el.addEventListener("click", () => choose(index));
      items.push({ command, el });
      nodes.push(el);
    }
    if (!items.length) nodes.push(h("div", { class: "empty compact" }, h("p", {}, "Nothing matches. Try another word.")));
    replace(list, ...nodes);
    status.textContent = `${items.length} result${items.length === 1 ? "" : "s"}`;
    select(0);
  }

  // A phone's keyboard covers the page's lower part (iOS keeps the page full height under it): the palette ends above
  // it, so its last result can be reached (--room, index.html).
  const viewport = window.visualViewport;
  const fit = (): void => {
    if (viewport) dialog.style.setProperty("--room", `${Math.floor(viewport.offsetTop + viewport.height - dialog.getBoundingClientRect().top - 8)}px`);
  };

  function finish(): void {
    if (!dialog.isConnected) return;
    viewport?.removeEventListener("resize", fit);
    if (dialog.open) dialog.close();
    dialog.remove();
    if (openDialog === dialog) openDialog = null;
    // Only once the palette has left the top layer can focus go back where it was.
    if (returnFocus?.isConnected) returnFocus.focus({ preventScroll: true });
  }

  function close(): void {
    if (!dialog.open || closing) return;
    closing = true;
    const into = grewFrom?.isConnected ? grewFrom : null;
    if (!into) delete dialog.dataset.grow;
    dialog.classList.remove("shown");
    if (into) {
      // Back into the button (where it is now: what was typed may have made the palette shorter), the keyboard going down
      // with it. What it holds goes first, then its shape, fading as it arrives.
      input.blur();
      for (const animation of dialog.getAnimations({ subtree: true })) animation.cancel();
      const time = motion("--d-3");
      for (const part of [field, list]) part.animate([{ opacity: 1 }, { opacity: 0 }], { duration: time / 4, easing: "ease-out", fill: "forwards" });
      const shrink = dialog.animate([{ clipPath: whole(), opacity: 1 }, { opacity: 1, offset: 0.7 }, { clipPath: shapeOf(into), opacity: 0 }], { duration: time, easing: motionEase("--ease-drawer"), fill: "forwards" });
      shrink.finished.then(finish, finish);
    } else if (prefersReducedMotion()) finish();
    else setTimeout(finish, 130);
  }

  /** The clip that shows all of it, its shadow too. */
  function whole(): string {
    return `inset(-48px round ${48 + (parseFloat(getComputedStyle(dialog).borderTopLeftRadius) || 0)}px)`;
  }

  /** The clip that shows only the button's part of it, as both are now. */
  function shapeOf(button: Element): string {
    return clipTo(button.getBoundingClientRect(), dialog.getBoundingClientRect(), parseFloat(getComputedStyle(button).borderTopLeftRadius) || 0);
  }

  function choose(index: number): void {
    const item = items[index];
    if (!item) return;
    // Choosing is frequent: leave at once, restore focus, then run (a command may open its own dialog).
    finish();
    item.command.run();
  }

  cancel.addEventListener("click", close);
  input.addEventListener("input", render);
  input.addEventListener("keydown", (event: KeyboardEvent) => {
    if (event.key === "ArrowDown" || (event.ctrlKey && event.key === "n")) {
      event.preventDefault();
      select(active + 1);
    } else if (event.key === "ArrowUp" || (event.ctrlKey && event.key === "p")) {
      event.preventDefault();
      select(active - 1);
    } else if (event.key === "Enter" && !event.isComposing) {
      event.preventDefault();
      choose(active);
    } else if (event.key === "Home" && event.ctrlKey) {
      select(0);
    }
  });
  dialog.addEventListener("cancel", (event) => {
    event.preventDefault();
    close();
  });
  dialog.addEventListener("click", (event) => {
    if (event.target === dialog) close();
  });

  document.body.appendChild(dialog);
  dialog.showModal();
  fit();
  viewport?.addEventListener("resize", fit);
  render();
  input.focus();
  input.select();
  // On a phone, opened from the top bar's search button, it is that button grown, as a sheet moves: across the bar into
  // the field (which lies over it) and down into what it finds, which fades in as it arrives.
  if (from && from.getBoundingClientRect().width > 0 && matchMedia(BAR_SEARCH).matches && !prefersReducedMotion()) {
    grewFrom = from;
    dialog.dataset.grow = "";
    const time = motion("--d-sheet");
    dialog.animate([{ clipPath: shapeOf(from), opacity: 0 }, { opacity: 1, offset: 0.15 }, { clipPath: whole() }], { duration: time, easing: motionEase("--ease-drawer") });
    for (const part of [field, list]) part.animate([{ opacity: 0 }, { opacity: 1 }], { duration: time / 2, delay: time / 6, fill: "backwards" });
  }
  requestAnimationFrame(() => dialog.classList.add("shown"));
}

/** A duration token from the stylesheet, in ms. */
function motion(token: string): number {
  return parseFloat(getComputedStyle(document.documentElement).getPropertyValue(token)) || 0;
}

/** An easing token from the stylesheet, for an animation run from script. */
function motionEase(token: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(token).trim() || "ease-out";
}
