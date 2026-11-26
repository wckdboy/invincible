import { activeAfter, type Choice, type ChoiceGroup, filterChoices, moveActive, optionCount, type Shown, typeahead } from "../lib/selector.ts";
import { dot, type Tone } from "./controls.ts";
import { openSheet, type Sheet } from "./dialog.ts";
import { type Child, h, nextId, prefersReducedMotion, replace, type Scope } from "./dom.ts";
import { icon, type IconName } from "./icons.ts";

/*
 * The smart selector: one compact control that says what's chosen now in plain
 * words ("Planner · Opus 5.5 · Galahad"), and opens the choices grouped, the likely
 * ones first. A popover under the control with a fine pointer, a bottom sheet on
 * phones. Type to filter (or, without a search field, to jump), arrows to move,
 * Enter to choose, Escape to close. Groups choose one, toggle many, or run an
 * action. It replaces clusters of chips, toggles and segmented controls, so the
 * content gets the screen.
 *
 *   const pick = selector({
 *     label: "Chat options",
 *     current: () => `${roleName} · ${model}`,
 *     groups: () => [{ id: "role", label: "Who answers", options: roles.map(…) }],
 *     onSelect: (group, option) => { … change state …; pick.refresh(); },
 *     scope,
 *   });
 *   toolbar.append(pick.el);
 */

export interface SelectorOption extends Choice {
  icon?: IconName;
  /** A status dot in this tone (online, at risk, failed…). */
  tone?: Tone;
}

export type SelectorGroup = ChoiceGroup<SelectorOption>;

export interface SelectorCurrent {
  text: string;
  icon?: IconName;
  /** A status dot before the text. */
  tone?: Tone;
  /** Something other than the default is chosen (a filter is on): the control shows it in ink. */
  active?: boolean;
}

export interface SelectorConfig {
  /** Names the control and heads its popover: "Chat options", "Filter activity". */
  label: string;
  /** What's chosen now, in plain words. Called on refresh(). */
  current(): SelectorCurrent | string;
  /** The choices, read each time they're shown (so they always reflect the current state). */
  groups(): SelectorGroup[];
  /** A choice was made. Change your state, then call refresh(). */
  onSelect(group: string, option: SelectorOption): void;
  /** A search field: always, never, or "auto" (more than seven options). */
  search?: boolean | "auto";
  placeholder?: string;
  /** A quiet line under the choices (a hint, where else this lives). */
  footer?: () => Child;
  /** Closed when this ends (a view's lifetime). */
  scope?: Scope;
  /** "ghost": no border until hovered, for toolbars. */
  variant?: "default" | "ghost";
  /** Extra class names for the control. */
  className?: string;
}

export interface Selector {
  el: HTMLButtonElement;
  /** Re-reads current() (and the open list's groups). */
  refresh(): void;
  open(): void;
  close(): void;
}

const phone = () => matchMedia("(max-width: 639px)").matches;
const coarse = () => matchMedia("(pointer: coarse)").matches;
const TYPEAHEAD_MS = 700;

export function selector(config: SelectorConfig): Selector {
  const text = h("span", { class: "sel-current" });
  const lead = h("span", { class: "sel-lead" });
  const el = h(
    "button",
    { class: `selector-trigger${config.variant === "ghost" ? " ghost" : ""}${config.className ? ` ${config.className}` : ""}`, type: "button", "aria-haspopup": "dialog", "aria-expanded": "false" },
    lead,
    text,
    icon("chevron-down", { size: 14, class: "sel-chev" }),
  );
  let close: () => void = () => {};
  let rerender: () => void = () => {};
  let isOpen = false;

  function refresh(): void {
    const raw = config.current();
    const current: SelectorCurrent = typeof raw === "string" ? { text: raw } : raw;
    text.textContent = current.text;
    replace(lead, current.tone ? dot(current.tone) : null, current.icon ? icon(current.icon, { size: 15 }) : null);
    lead.hidden = !current.tone && !current.icon;
    const name = current.text ? `${config.label}: ${current.text}` : config.label;
    el.setAttribute("aria-label", name);
    el.title = name;
    el.dataset.active = String(Boolean(current.active));
    if (isOpen) rerender();
  }

  function open(): void {
    if (isOpen) return;
    isOpen = true;
    el.setAttribute("aria-expanded", "true");
    const titleId = nextId("sel-title");
    const listId = nextId("sel-list");
    const status = h("div", { class: "sr-only", role: "status", "aria-live": "polite" });
    const total = optionCount(config.groups());
    const withSearch = config.search === true || (config.search !== false && total > 7);
    const input = withSearch
      ? h("input", {
          type: "text",
          role: "combobox",
          "aria-expanded": "true",
          "aria-controls": listId,
          "aria-autocomplete": "list",
          "aria-label": `Search ${config.label.toLowerCase()}`,
          placeholder: config.placeholder ?? "Type to filter…",
          autocomplete: "off",
          autocapitalize: "off",
          autocorrect: "off",
          spellcheck: "false",
          enterkeyhint: "done",
        })
      : null;
    const list = h("div", { class: "sel-list", role: "listbox", id: listId, tabindex: 0, "aria-labelledby": titleId });
    const search = input ? h("div", { class: "sel-search" }, icon("search", { size: 15 }), input) : null;
    const foot = config.footer ? h("div", { class: "sel-foot" }, config.footer()) : null;

    let items: { shown: Shown<SelectorOption>; group: SelectorGroup; el: HTMLElement }[] = [];
    let active = -1;
    let typed = "";
    let typedAt = 0;
    let shownQuery: string | null = null;

    const mark = (label: string, indices: number[]): Child[] => {
      if (!indices.length) return [label];
      const set = new Set(indices);
      const out: Child[] = [];
      let run = "";
      let marked = false;
      for (let i = 0; i <= label.length; i++) {
        const m = set.has(i);
        if (i === label.length || m !== marked) {
          if (run) out.push(marked ? h("mark", {}, run) : run);
          run = "";
          marked = m;
        }
        if (i < label.length) run += label[i];
      }
      return out;
    };

    function setActive(index: number, scroll = true): void {
      active = index;
      items.forEach((item, i) => (i === index ? item.el.setAttribute("data-active", "true") : item.el.removeAttribute("data-active")));
      const current = items[index];
      const owner = input ?? list;
      if (current) {
        owner.setAttribute("aria-activedescendant", current.el.id);
        if (scroll) current.el.scrollIntoView({ block: "nearest" });
      } else owner.removeAttribute("aria-activedescendant");
    }

    rerender = () => {
      const query = input?.value ?? "";
      const groups = config.groups();
      const shown = filterChoices(groups, query);
      const keep = items[active]?.shown.option.value;
      const keepGroup = items[active]?.group.id;
      items = [];
      list.setAttribute("aria-multiselectable", String(groups.some((g) => g.mode === "many")));
      const nodes: HTMLElement[] = [];
      for (const { group, options } of shown) {
        const mode = group.mode ?? "one";
        const labelId = group.label ? nextId("sel-group") : null;
        const groupEl = h("div", { role: "group", "aria-labelledby": labelId, class: "sel-group" }, group.label ? h("div", { class: "sel-group-label", id: labelId, role: "presentation" }, group.label) : null);
        for (const shownOption of options) {
          const { option, indices } = shownOption;
          const selected = mode !== "action" && Boolean(option.selected);
          const reason = typeof option.disabled === "string" ? option.disabled : null;
          const optionEl = h(
            "div",
            {
              class: "sel-option",
              role: "option",
              id: nextId("sel-opt"),
              "data-mode": mode,
              "aria-selected": String(selected),
              "aria-disabled": option.disabled ? "true" : null,
              title: reason,
            },
            mode === "many"
              ? h("span", { class: "sel-box", "aria-hidden": "true" }, selected ? icon("check", { size: 12 }) : null)
              : mode === "one"
                ? h("span", { class: "sel-mark", "aria-hidden": "true" }, selected ? icon("check", { size: 15 }) : null)
                : null,
            option.icon ? icon(option.icon, { size: 16 }) : null,
            h(
              "span",
              { class: "sel-text" },
              h("span", { class: "sel-label" }, ...mark(option.label, indices)),
              option.meta || reason ? h("span", { class: "sel-meta" }, reason ?? option.meta) : null,
            ),
            option.tone ? dot(option.tone) : null,
          );
          const index = items.length;
          optionEl.addEventListener("pointermove", () => active !== index && setActive(index, false));
          optionEl.addEventListener("click", () => choose(index));
          items.push({ shown: shownOption, group, el: optionEl });
          groupEl.append(optionEl);
        }
        nodes.push(groupEl);
      }
      if (!items.length) nodes.push(h("div", { class: "sel-empty" }, "Nothing matches. Try another word."));
      replace(list, ...nodes);
      if (query) status.textContent = `${items.length} result${items.length === 1 ? "" : "s"}`;
      // A new query: its best match; a toggle: the same option; opening: the one chosen now.
      const queryChanged = shownQuery === null || query !== shownQuery;
      shownQuery = query;
      const kept = new Set(items.filter((i) => i.shown.option.value === keep && i.group.id === keepGroup).map((i) => i.shown));
      setActive(activeAfter(items.map((i) => i.shown), { query, queryChanged, keep: (s) => kept.has(s) }));
    };

    function choose(index: number): void {
      const item = items[index];
      if (!item || item.shown.option.disabled) return;
      const mode = item.group.mode ?? "one";
      if (mode === "many") {
        config.onSelect(item.group.id, item.shown.option);
        refresh();
        setActive(Math.min(active, items.length - 1), false);
        return;
      }
      // Choosing one is frequent: leave at once, focus back on the control, then act.
      finish();
      config.onSelect(item.group.id, item.shown.option);
      refresh();
    }

    function onKey(event: KeyboardEvent): void {
      const inInput = event.target === input;
      const flat = items.map((i) => i.shown);
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        setActive(moveActive(flat, active, event.key === "ArrowDown" ? 1 : -1));
      } else if ((event.key === "Home" || event.key === "End") && (!inInput || event.ctrlKey)) {
        event.preventDefault();
        setActive(moveActive(flat, -1, event.key === "Home" ? 1 : -1));
      } else if (event.key === "Enter" && !event.isComposing) {
        event.preventDefault();
        choose(active);
      } else if (event.key === " " && !inInput) {
        event.preventDefault();
        choose(active);
      } else if (!inInput && event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) {
        if (input) {
          // The letter goes on into the search field.
          input.focus();
          return;
        }
        const now = Date.now();
        typed = now - typedAt > TYPEAHEAD_MS ? event.key : typed + event.key;
        typedAt = now;
        const hit = typeahead(flat, typed, active);
        if (hit >= 0) setActive(hit);
      }
    }

    let finished = false;
    let sheet: Sheet | null = null;
    let pop: HTMLDialogElement | null = null;
    const listeners = new AbortController();
    function finish(): void {
      if (finished) return;
      finished = true;
      isOpen = false;
      listeners.abort();
      el.setAttribute("aria-expanded", "false");
      rerender = () => {};
      close = () => {};
      if (sheet) sheet.close();
      if (pop?.isConnected) {
        if (pop.open) pop.close();
        pop.remove();
        if (el.isConnected) el.focus({ preventScroll: true });
      }
    }
    close = finish;

    input?.addEventListener("input", () => rerender());
    const body = [search, list, foot, status];

    if (phone()) {
      sheet = openSheet({
        title: config.label,
        size: "small",
        body,
        // On a touch screen the keyboard waits until you tap the search field.
        initialFocus: () => (input && !coarse() ? input : list),
        onClose: () => finish(),
      });
      sheet.el.classList.add("selector-sheet");
      list.setAttribute("aria-labelledby", sheet.el.getAttribute("aria-labelledby") ?? titleId);
      sheet.el.addEventListener("keydown", onKey, { signal: listeners.signal });
    } else {
      pop = h("dialog", { class: "selector-pop", "aria-labelledby": titleId }, h("div", { class: "sr-only", id: titleId }, config.label), ...body);
      pop.addEventListener("keydown", onKey);
      pop.addEventListener("cancel", (event) => {
        event.preventDefault();
        hide();
      });
      // A click outside lands on the (transparent) backdrop, which is the dialog itself.
      pop.addEventListener("click", (event) => {
        if (event.target === pop) hide();
      });
      document.body.append(pop);
      pop.showModal();
      place();
      addEventListener("resize", place, { signal: listeners.signal });
      addEventListener("scroll", place, { signal: listeners.signal, passive: true });
      (input ?? list).focus({ preventScroll: true });
      requestAnimationFrame(() => pop?.classList.add("shown"));
    }
    rerender();

    function hide(): void {
      if (!pop || prefersReducedMotion()) return finish();
      pop.classList.remove("shown");
      setTimeout(finish, 130);
    }

    /** Under the control (or over it, when there's more room above), inside the window. */
    function place(): void {
      if (!pop) return;
      const r = el.getBoundingClientRect();
      const margin = 8;
      const width = Math.min(Math.max(r.width, 300), 380, innerWidth - 2 * margin);
      const below = innerHeight - r.bottom - margin;
      const above = r.top - margin;
      const up = below < 260 && above > below;
      const room = Math.max(160, Math.min(440, (up ? above : below) - 6));
      pop.style.width = `${width}px`;
      pop.style.maxHeight = `${room}px`;
      pop.style.left = `${Math.round(Math.max(margin, Math.min(r.left, innerWidth - width - margin)))}px`;
      if (up) {
        pop.style.top = "auto";
        pop.style.bottom = `${Math.round(innerHeight - r.top + 6)}px`;
      } else {
        pop.style.bottom = "auto";
        pop.style.top = `${Math.round(r.bottom + 6)}px`;
      }
      pop.classList.toggle("above", up);
    }
  }

  el.addEventListener("click", () => (isOpen ? close() : open()));
  el.addEventListener("keydown", (event: KeyboardEvent) => {
    if ((event.key === "ArrowDown" || event.key === "ArrowUp") && !isOpen) {
      event.preventDefault();
      open();
    }
  });
  config.scope?.add(() => close());
  refresh();
  return { el, refresh, open, close: () => close() };
}
