import { countRoll, countText } from "../lib/alerts.ts";
import { type Child, cx, h, nextId, prefersReducedMotion, replace } from "./dom.ts";
import { icon, type IconName } from "./icons.ts";
import { toast } from "./toast.ts";

/*
 * The app's components: every page is built from these, and they take their colour, type and spacing from the tokens
 * at the top of index.html (docs/DESIGN.md is the system; apps/web/design/gallery.ts draws every one of them, light and
 * dark, at a phone's width and a desktop's). A page made of them lines up with every other: the same head, the same
 * gaps, the same leading edge in every card.
 *
 *   A page      pageHead · pageBody · section · note
 *   Containers  card · list · listRow · rows · disclosure · statTile · kv · meta
 *   Actions     button · linkButton · busy · formActions
 *   Status      badge · dot · count · meter · spinner · callout
 *   States      empty · errorState · skeletonRows · skeletonStat · skeletonBlock
 *   Fields      field · secretInput · segmented · switchControl · rangeControl · chipInput · copyField · sasCode · kbd
 *
 * Sheets and confirmations are dialog.ts's, the smart selector selector.ts's, toasts toast.ts's; the element builder
 * (h) and lifetimes are dom.ts's. Tones map to semantic tokens: a component never picks a colour.
 */

/** A knight's state's tones (lib/knight-state.ts): `work` its blue at work, `needs` amber for what waits on you, `failed` the
 * red of a failure, and `ok` green, also for what is new to you. */
export type Tone = "ok" | "warn" | "danger" | "info" | "accent" | "agent" | "neutral" | "needs" | "work" | "failed";

export function badge(text: string, tone: Tone = "neutral", iconName?: IconName): HTMLElement {
  return h("span", { class: "badge", "data-tone": tone }, iconName ? icon(iconName, { size: 12 }) : null, text);
}

export function dot(tone: Tone | null, options: { live?: boolean; label?: string } = {}): HTMLElement {
  return h("span", {
    class: cx("dot", options.live && "live"),
    "data-tone": tone,
    role: options.label ? "img" : null,
    "aria-label": options.label ?? null,
    "aria-hidden": options.label ? null : "true",
  });
}

/** A count of what waits: ink, `quiet` grey, or in a tone (`needs`: amber, what waits on you). setCount() changes it. */
export function count(n: number, quiet = false, tone?: Tone): HTMLElement {
  return h("span", { class: cx("count", quiet && "quiet"), "data-tone": tone ?? null, "data-count": n, "aria-label": `${n} waiting` }, h("span", { class: "count-is" }, countText(n)));
}

/**
 * Sets a count (count()'s, or any .count) to `n`. Its figure rolls to the new one rather than jumping: up as it grows,
 * down as it shrinks (lib/alerts.ts countRoll), over --d-3; where motion is reduced it only changes. Its name says it.
 */
export function setCount(el: HTMLElement, n: number): void {
  const from = el.dataset.count === undefined ? null : Number(el.dataset.count);
  const roll = countRoll(Number.isFinite(from) ? from : null, n);
  const was = el.querySelector(".count-is")?.textContent ?? el.textContent ?? "";
  el.dataset.count = String(n);
  el.setAttribute("aria-label", `${n} waiting`);
  const is = h("span", { class: "count-is" }, countText(n));
  if (!roll || prefersReducedMotion()) {
    el.removeAttribute("data-roll");
    return replace(el, is);
  }
  // (The figure going is only seen: the count's name says the new one.)
  const going = h("span", { class: "count-was", "aria-hidden": "true" }, was);
  going.addEventListener("animationend", () => going.remove(), { once: true });
  el.dataset.roll = roll;
  replace(el, going, is);
}

/** How long a breath takes (--d-breath), with a moment over: it is called off by then if its end was never seen. */
const BREATH_MS = 2600;

/**
 * Something new that needs you, said by one slow breath of its light (a dot's, a count's, an .alert-card's edge): once, never a loop, and not
 * at all where motion is reduced. Called again while it breathes, the one breath goes on.
 */
export function arrive(el: HTMLElement): void {
  if (prefersReducedMotion() || el.hasAttribute("data-arrived")) return;
  el.setAttribute("data-arrived", "");
  // (Its own breath's end: a count's figure rolling inside it ends too.)
  const ended = (event: AnimationEvent) => event.animationName.startsWith("arrive-") && done();
  const done = () => {
    clearTimeout(timer);
    el.removeAttribute("data-arrived");
    el.removeEventListener("animationend", ended);
  };
  el.addEventListener("animationend", ended);
  const timer = setTimeout(done, BREATH_MS);
}

export function kbd(...keys: string[]): HTMLElement[] {
  return keys.map((k) => h("kbd", {}, k));
}

export interface ButtonOptions {
  variant?: "primary" | "danger" | "danger-solid" | "ghost" | "default";
  size?: "sm" | "lg";
  icon?: IconName;
  iconOnly?: boolean;
  label?: string;
  type?: "button" | "submit";
  disabled?: boolean;
  title?: string;
  block?: boolean;
  onClick?: (event: MouseEvent) => void;
}

export function button(text: string, options: ButtonOptions = {}): HTMLButtonElement {
  const variant = options.variant && options.variant !== "default" ? options.variant : null;
  const el = h(
    "button",
    {
      class: cx("btn", variant, options.size, options.iconOnly && "icon-only", options.block && "block"),
      type: options.type ?? "button",
      disabled: options.disabled ?? false,
      title: options.title ?? (options.iconOnly ? text : null),
      "aria-label": options.iconOnly ? (options.label ?? text) : (options.label ?? null),
    },
    options.icon ? icon(options.icon, { size: options.size === "sm" ? 14 : 16 }) : null,
    options.iconOnly ? null : h("span", {}, text),
  );
  if (options.onClick) el.addEventListener("click", options.onClick);
  return el;
}

/**
 * A link that looks like a button (.btn on an anchor): for going somewhere rather than doing something, as a section's
 * "View all" or a way back does. The same variants and sizes as button(); `next` puts a chevron after the words.
 */
export function linkButton(text: string, href: string, options: { variant?: ButtonOptions["variant"]; size?: "sm"; icon?: IconName; next?: boolean; label?: string } = {}): HTMLAnchorElement {
  const variant = options.variant && options.variant !== "default" ? options.variant : null;
  return h(
    "a",
    { class: cx("btn", variant, options.size), href, "aria-label": options.label ?? null },
    options.icon ? icon(options.icon, { size: options.size === "sm" ? 14 : 16 }) : null,
    h("span", {}, text),
    options.next ? icon("chevron-right", { size: 14 }) : null,
  );
}

/**
 * A form's actions, at its end, the primary one last: right-aligned on a wide screen; in a sheet on a phone, thumb-sized
 * and as wide as the sheet, as its foot's are (.form-actions). Every form ends with one, so every form's buttons are
 * the same size in the same place.
 */
export function formActions(...actions: Child[]): HTMLElement {
  return h("div", { class: "form-actions" }, ...actions);
}

/** Something under way, in the current colour: a 16 px ring, `sm` 12 px (in a line of text), `xs` 10 px (in a badge). */
export function spinner(size?: "sm" | "xs"): HTMLElement {
  return h("span", { class: cx("spinner", size), "aria-hidden": "true" });
}

/** Disables the button and shows a spinner while `work` runs. Returns its result. */
export async function busy<T>(el: HTMLButtonElement, work: () => Promise<T>): Promise<T> {
  if (el.getAttribute("aria-busy") === "true") throw new Error("already running");
  const wasDisabled = el.disabled;
  el.disabled = true;
  el.setAttribute("aria-busy", "true");
  const turning = spinner();
  const firstIcon = el.querySelector("svg.icon");
  if (firstIcon) firstIcon.replaceWith(turning);
  else el.prepend(turning);
  try {
    return await work();
  } finally {
    if (firstIcon) turning.replaceWith(firstIcon);
    else turning.remove();
    el.removeAttribute("aria-busy");
    el.disabled = wasDisabled;
  }
}

export function callout(tone: Tone | "quiet", body: Child, options: { title?: string; icon?: IconName; actions?: Child } = {}): HTMLElement {
  const iconName: IconName = options.icon ?? (tone === "danger" ? "alert" : tone === "warn" ? "alert" : tone === "ok" ? "check-circle" : "info");
  return h(
    "div",
    { class: cx("callout", tone === "quiet" && "quiet"), "data-tone": tone === "quiet" ? null : tone, role: tone === "danger" ? "alert" : null },
    icon(iconName, { size: 16 }),
    h(
      "div",
      { class: "callout-body" },
      options.title ? h("div", { class: "callout-title" }, options.title) : null,
      h("div", {}, body),
      options.actions ? h("div", { class: "row wrap" }, options.actions) : null,
    ),
  );
}

export function empty(options: { icon: IconName; title: string; body?: Child; actions?: Child; compact?: boolean }): HTMLElement {
  return h(
    "div",
    { class: cx("empty", options.compact && "compact") },
    h("div", { class: "empty-icon" }, icon(options.icon, { size: 20 })),
    h("h3", {}, options.title),
    options.body ? h("p", {}, options.body) : null,
    options.actions ? h("div", { class: "btn-group" }, options.actions) : null,
  );
}

/** What each error state on screen would do to try again (see retryFailed). */
const retries = new WeakMap<Element, () => void>();

/** A courteous error with a way forward. When the node comes back, the shell tries it again by itself. */
export function errorState(title: string, error: unknown, retry?: () => void): HTMLElement {
  const el = empty({
    icon: "alert",
    title,
    body: error instanceof Error ? error.message : String(error),
    actions: retry ? button("Try again", { icon: "retry", onClick: retry }) : null,
    compact: true,
  });
  if (retry) {
    el.dataset.retry = "";
    retries.set(el, retry);
  }
  return el;
}

/** Tries again every error state under `root` that can (after a dropped connection comes back). Returns how many. */
export function retryFailed(root: ParentNode): number {
  let n = 0;
  for (const el of root.querySelectorAll("[data-retry]")) {
    const retry = retries.get(el);
    if (!retry) continue;
    retries.delete(el);
    n++;
    retry();
  }
  return n;
}

/** Skeleton rows standing in for a list, the same height as the real thing (no layout jump). */
export function skeletonRows(n = 3, options: { avatar?: boolean } = {}): HTMLElement {
  return h(
    "div",
    { class: "rows", "aria-hidden": "true" },
    ...Array.from({ length: n }, (_, i) =>
      h(
        "div",
        { class: "sk-row" },
        options.avatar ? h("div", { class: "skeleton sk-avatar" }) : null,
        h(
          "div",
          { class: "grow stack tight" },
          h("div", { class: "skeleton sk-line", style: `width:${[62, 48, 70, 55][i % 4]}%` }),
          h("div", { class: "skeleton sk-line", style: `width:${[34, 28, 40, 30][i % 4]}%;height:10px` }),
        ),
      ),
    ),
  );
}

/** A stat tile's place while its figure loads (as tall as the tile, on every screen). */
export function skeletonStat(): HTMLElement {
  return h("div", { class: "skeleton stat-skeleton", "aria-hidden": "true" });
}

export function skeletonBlock(height: number): HTMLElement {
  return h("div", { class: "skeleton sk-block", style: `height:${height}px`, "aria-hidden": "true" });
}

export async function copyText(text: string, what = "Copied", options: { quiet?: boolean } = {}): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    if (!options.quiet) toast(what, { tone: "ok", duration: 2000 });
    return true;
  } catch {
    if (!options.quiet) toast("Couldn't copy automatically", { tone: "warn", description: "Select the text and copy it by hand." });
    return false;
  }
}

/** A value with a copy button that reports on itself (it often lives inside a sheet). For invite links and commands; never for secrets. */
export function copyField(text: string, label = "Copy"): HTMLElement {
  const word = h("span", { "aria-live": "polite" }, "Copy");
  const btn = h("button", { class: "btn sm", type: "button", "aria-label": label }, icon("copy", { size: 14 }), word);
  btn.addEventListener("click", async () => {
    const ok = await copyText(text, label, { quiet: true });
    word.textContent = ok ? "Copied" : "Select it";
    setTimeout(() => (word.textContent = "Copy"), 1600);
  });
  return h("div", { class: "copyfield" }, h("code", {}, text), btn);
}

/**
 * A labelled field. The label, id and hint attach to the form control itself, even when
 * `control` is a wrapper around it (an icon-decorated secret field, for instance).
 */
export function field(label: string, control: HTMLElement, options: { hint?: Child; id?: string; error?: HTMLElement } = {}): HTMLElement {
  const target = control.matches("input, select, textarea") ? control : (control.querySelector<HTMLElement>("input, select, textarea") ?? control);
  const id = options.id ?? (target.id || nextId("f"));
  target.id = id;
  const hintId = options.hint ? `${id}-hint` : null;
  if (hintId) target.setAttribute("aria-describedby", hintId);
  return h("div", { class: "field" }, h("label", { for: id }, label), control, options.hint ? h("div", { class: "hint", id: hintId }, options.hint) : null, options.error ?? null);
}

/**
 * The only way keys are entered: a password field that never autocompletes,
 * spellchecks or capitalises. Callers read it once and clear it immediately.
 */
export function secretInput(options: { id?: string; placeholder?: string; label?: string } = {}): { wrap: HTMLElement; input: HTMLInputElement } {
  const input = h("input", {
    class: "input",
    type: "password",
    id: options.id ?? nextId("secret"),
    autocomplete: "off",
    spellcheck: "false",
    autocapitalize: "off",
    autocorrect: "off",
    "data-1p-ignore": "true",
    "data-lpignore": "true",
    placeholder: options.placeholder ?? "Paste the key here",
    "aria-label": options.label ?? null,
  });
  return { wrap: h("div", { class: "secret-field" }, icon("key", { size: 16 }), input), input };
}

export interface SegmentOption<T extends string> {
  value: T;
  label: string;
  icon?: IconName;
  /** CSS color for the selected icon (semantic tones, e.g. network risk). */
  tone?: string;
  title?: string;
}

/**
 * A radiogroup that looks like a segmented control, with a sliding thumb. Arrow
 * keys move, skipping options that are disabled (with the reason as their tooltip).
 */
export function segmented<T extends string>(
  options: SegmentOption<T>[],
  value: T,
  onChange: (value: T) => void,
  config: { label: string; block?: boolean; small?: boolean } = { label: "Options" },
): { el: HTMLElement; set(value: T): void; disable(value: T, disabled: boolean, reason?: string): void } {
  const thumb = h("span", { class: "thumb", "aria-hidden": "true" });
  let current = value;
  const buttons = options.map((option) =>
    h(
      "button",
      {
        type: "button",
        role: "radio",
        // Labels may be visually hidden on narrow screens; the accessible name never is.
        "aria-label": option.label,
        title: option.title ?? option.label,
        "data-value": option.value,
        style: option.tone ? `--seg-tone:${option.tone}` : null,
      },
      option.icon ? icon(option.icon, { size: 15 }) : null,
      h("span", { class: "seg-label" }, option.label),
    ),
  );
  const el = h("div", { class: cx("segmented", config.block && "block", config.small && "sm"), role: "radiogroup", "aria-label": config.label }, thumb, ...buttons);

  function position(): void {
    const active = buttons.find((b) => b.dataset.value === current);
    if (!active || !active.offsetWidth) return;
    thumb.style.width = `${active.offsetWidth}px`;
    thumb.style.transform = `translateX(${active.offsetLeft}px)`;
  }
  function set(next: T, notify = false): void {
    current = next;
    for (const b of buttons) {
      const on = b.dataset.value === next;
      b.setAttribute("aria-checked", String(on));
      b.tabIndex = on ? 0 : -1;
    }
    position();
    if (notify) onChange(next);
  }
  buttons.forEach((b, i) => {
    b.addEventListener("click", () => set(options[i]!.value, true));
    b.addEventListener("keydown", (event: KeyboardEvent) => {
      const delta = event.key === "ArrowRight" || event.key === "ArrowDown" ? 1 : event.key === "ArrowLeft" || event.key === "ArrowUp" ? -1 : 0;
      if (!delta) return;
      event.preventDefault();
      let next = i;
      do next = (next + delta + buttons.length) % buttons.length;
      while (buttons[next]!.disabled && next !== i);
      if (next === i) return;
      set(options[next]!.value, true);
      buttons[next]!.focus();
    });
  });
  set(value);
  // Measure once laid out, and whenever the control resizes.
  new ResizeObserver(position).observe(el);
  return {
    el,
    set: (v: T) => set(v),
    disable(v: T, disabled: boolean, reason?: string) {
      const i = options.findIndex((o) => o.value === v);
      const b = buttons[i];
      if (!b) return;
      b.disabled = disabled;
      b.title = disabled && reason ? reason : (options[i]!.title ?? options[i]!.label);
    },
  };
}

export function switchControl(label: Child, checked: boolean, onChange: (checked: boolean) => void, options: { hint?: Child; disabled?: boolean } = {}): HTMLElement {
  const input = h("input", { type: "checkbox", role: "switch", checked, disabled: options.disabled ?? false });
  input.addEventListener("change", () => onChange(input.checked));
  return h(
    "label",
    { class: "switch" },
    input,
    h("span", { class: "track", "aria-hidden": "true" }),
    h("span", { class: "switch-text" }, h("span", { class: "small strong" }, label), options.hint ? h("span", { class: "tiny subtle" }, options.hint) : null),
  );
}

export function rangeControl(options: {
  label: string;
  min: number;
  max: number;
  step: number;
  value: number;
  format: (value: number) => string;
  onInput?: (value: number) => void;
  scale?: [string, string];
}): { el: HTMLElement; input: HTMLInputElement; value(): number } {
  const id = nextId("range");
  const input = h("input", { type: "range", id, min: options.min, max: options.max, step: options.step, value: options.value });
  const output = h("output", { for: id });
  const sync = () => {
    const v = Number(input.value);
    output.textContent = options.format(v);
    input.setAttribute("aria-valuetext", options.format(v));
    input.style.setProperty("--fill", `${((v - options.min) / (options.max - options.min || 1)) * 100}%`);
  };
  input.addEventListener("input", () => {
    sync();
    options.onInput?.(Number(input.value));
  });
  sync();
  return {
    el: h(
      "div",
      { class: "range" },
      h("div", { class: "range-top" }, h("label", { for: id, class: "label" }, options.label), output),
      input,
      options.scale ? h("div", { class: "scale", "aria-hidden": "true" }, h("span", {}, options.scale[0]), h("span", {}, options.scale[1])) : null,
    ),
    input,
    value: () => Number(input.value),
  };
}

/** Tags as chips: Enter or comma adds, Backspace on empty removes the last. */
export function chipInput(options: { id?: string; placeholder?: string; max?: number; validate?: (tag: string) => string | null }): {
  el: HTMLElement;
  values(): string[];
  clear(): void;
} {
  const tags: string[] = [];
  const input = h("input", { type: "text", id: options.id ?? nextId("chips"), autocomplete: "off", autocorrect: "off", spellcheck: "false", placeholder: options.placeholder ?? "" });
  const el = h("div", { class: "chip-input" }, input);
  el.addEventListener("click", () => input.focus());
  const render = () => {
    for (const chip of [...el.querySelectorAll(".tag")]) chip.remove();
    tags.forEach((tag, i) => {
      el.insertBefore(
        h(
          "span",
          { class: "tag" },
          `#${tag}`,
          h(
            "button",
            {
              type: "button",
              "aria-label": `Remove tag ${tag}`,
              onclick: () => {
                tags.splice(i, 1);
                render();
                input.focus();
              },
            },
            icon("x", { size: 12 }),
          ),
        ),
        input,
      );
    });
  };
  const problemLine = h("div", { class: "error", role: "alert", hidden: true });
  const commit = () => {
    const raw = input.value.replace(/,/g, " ").trim().replace(/^#/, "");
    problemLine.hidden = true;
    if (!raw) return;
    for (const part of raw.split(/\s+/)) {
      const tag = part.slice(0, 64);
      if (!tag || tags.includes(tag) || tags.length >= (options.max ?? 32)) continue;
      const problem = options.validate?.(tag);
      if (problem) {
        problemLine.textContent = problem;
        problemLine.hidden = false;
        continue;
      }
      tags.push(tag);
    }
    input.value = "";
    render();
  };
  input.addEventListener("keydown", (event: KeyboardEvent) => {
    if ((event.key === "Enter" || event.key === ",") && input.value.trim()) {
      event.preventDefault();
      commit();
    } else if (event.key === "Backspace" && !input.value && tags.length) {
      tags.pop();
      render();
    }
  });
  input.addEventListener("blur", commit);
  return {
    el: h("div", { class: "stack tight" }, el, problemLine),
    values: () => {
      commit();
      return [...tags];
    },
    clear: () => {
      tags.length = 0;
      input.value = "";
      render();
    },
  };
}

/** A six-digit short authentication string ("023 811"), shown large and grouped 3+3. */
export function sasCode(code: string): HTMLElement {
  const digits = code.replace(/\s+/g, "").split("");
  return h("div", { class: "sas", role: "img", "aria-label": `Code ${digits.join(" ")}` }, ...digits.map((d) => h("span", { "aria-hidden": "true" }, d)));
}

export function statTile(options: { label: string; icon: IconName; value: Child; note?: Child; href?: string }): HTMLElement {
  const content = [
    h("div", { class: "stat-label" }, icon(options.icon, { size: 14 }), options.label),
    h("div", { class: "stat-value" }, options.value),
    options.note ? h("div", { class: "stat-note" }, options.note) : null,
  ];
  return options.href ? h("a", { class: "card stat", href: options.href }, ...content) : h("div", { class: "card stat" }, ...content);
}

export function meter(fraction: number, tone?: string, label?: string): HTMLElement {
  const clamped = Math.max(0, Math.min(1, fraction));
  return h(
    "div",
    { class: "meter", role: "meter", "aria-valuemin": 0, "aria-valuemax": 100, "aria-valuenow": Math.round(clamped * 100), "aria-label": label ?? null },
    h("span", { style: `width:${(clamped * 100).toFixed(1)}%${tone ? `;--tone:${tone}` : ""}` }),
  );
}

/* ---------- a page ---------- */

/**
 * Every page starts with this, and only pages do (a timeline's header is whose it is): the title, a line that says what
 * the page is for, and the page's actions at its end, its one primary action among them (.page-head). On a phone the
 * actions go under the line. Its parts are a .page's first child, so the page's gap (--page-gap) follows it.
 */
export function pageHead(title: string, lede?: Child, actions?: Child): HTMLElement {
  return h(
    "header",
    { class: "page-head" },
    h("div", { class: "grow" }, h("h1", {}, title), lede ? h("p", { class: "lede" }, lede) : null),
    actions ? h("div", { class: "actions" }, actions) : null,
  );
}

/**
 * A part of a page under its own small heading (.section, its gap --section-gap): a count beside the heading, links or
 * actions for the whole part at its end, and a note under it that says what is in it or what follows from it.
 */
export function section(title: string, options: { actions?: Child; count?: string; id?: string; note?: Child } = {}, ...children: Child[]): HTMLElement {
  const id = options.id ?? nextId("sec");
  return h(
    "section",
    { class: "section", "aria-labelledby": id },
    h("div", { class: "section-head" }, h("h2", { id }, title), options.count ? h("span", { class: "count-label tnum" }, options.count) : null, options.actions ? h("div", { class: "actions" }, options.actions) : null),
    options.note ? note(options.note) : null,
    ...children,
  );
}

/** A line about what's near it (a section, a list, a form): small, quiet type, never an instruction to the model. */
export function note(...children: Child[]): HTMLElement {
  return h("p", { class: "note" }, ...children);
}

/**
 * A page's body that appears whole (.page-body): its parts are drawn at once, hidden, while one placeholder stands in;
 * when none of them is still loading (no .skeleton, nothing aria-busy) it is shown in one frame, or after 1.5 s whatever
 * is still loading. Parts that answer at different times don't push each other down as they arrive: what you see first
 * is where it stays. A part that loads without a skeleton says so with aria-busy until its first answer.
 */
export function pageBody(...parts: Child[]): HTMLElement {
  const wait = h("div", { class: "skeleton page-body-wait", "aria-hidden": "true" });
  const shown = h("div", { class: "page-body-parts", hidden: true }, ...parts);
  const el = h("div", { class: "page-body" }, wait, shown);
  const loading = () => shown.querySelector('.skeleton, [aria-busy="true"]') !== null;
  const show = () => {
    watch.disconnect();
    clearTimeout(late);
    if (!wait.isConnected) return;
    wait.remove();
    shown.hidden = false;
  };
  const watch = new MutationObserver(() => !loading() && show());
  const late = setTimeout(show, 1500);
  watch.observe(shown, { subtree: true, childList: true, attributes: true, attributeFilter: ["class", "aria-busy"] });
  queueMicrotask(() => !loading() && show());
  return el;
}

/* ---------- containers ---------- */

export interface CardOptions {
  /** A head (.card-head): an icon and a title, with what belongs to the whole card at its end. */
  title?: Child;
  icon?: IconName;
  actions?: Child;
  /** A foot on sunken ground (.card-foot): a line about the card, or its own actions. */
  foot?: Child;
  /** What's in it fills it edge to edge (rows, a picture); otherwise it sits at the card's padding (--card-pad). */
  flush?: boolean;
  /** Its edge says it wants a look: yours (accent), a warning, a danger. */
  tone?: "accent" | "warn" | "danger";
  /** No shadow of its own: a card inside another. */
  flat?: boolean;
  /** One of a list of things (a loop, a node): an article, named for a screen reader. */
  label?: string;
  id?: string;
}

/**
 * A card: content on raised ground (.card). Its head, its rows and its foot all start at --card-pad from its edge, so
 * their leading edges line up, and line up with the next card's. Content not flush sits at that padding, as a stack.
 */
export function card(options: CardOptions = {}, ...children: Child[]): HTMLElement {
  const head = options.title === undefined ? null : h("div", { class: "card-head" }, options.icon ? icon(options.icon, { size: 16 }) : null, h("h3", { class: "grow" }, options.title), options.actions ?? null);
  const foot = options.foot ? h("div", { class: "card-foot" }, options.foot) : null;
  const framed = head !== null || foot !== null;
  const body = options.flush ? children : framed ? h("div", { class: "card-body" }, ...children) : children;
  return h(
    options.label ? "article" : "div",
    { class: cx("card", !options.flush && !framed && "pad", options.tone, options.flat && "flat"), id: options.id ?? null, "aria-label": options.label ?? null },
    head,
    body,
    foot,
  );
}

/** A list's rows, one under another with a hairline between (.rows). In a card, list() says it shorter. */
export function rows(...items: Child[]): HTMLElement {
  return h("div", { class: "rows" }, ...items);
}

/**
 * A list in a card: its rows, or, with none, what will appear there (an empty state in the same card, so the page
 * doesn't change shape when the first one arrives). With `nav` it is a list of places, named by it (a nav card, no head
 * or foot).
 */
export function list(items: Child[], options: Omit<CardOptions, "flush"> & { empty?: Parameters<typeof empty>[0]; nav?: string } = {}): HTMLElement {
  const { empty: none, nav, ...framing } = options;
  const shown = items.filter((item) => item !== null && item !== undefined && item !== false);
  const content = shown.length ? rows(...shown) : none ? empty({ ...none, compact: true }) : null;
  if (nav === undefined) return card({ ...framing, flush: true }, content);
  return h("nav", { class: "card", "aria-label": nav }, content);
}

export interface ListRowOptions {
  /** What leads it: an icon on a small tile (toned when the tone means something), or any element (a face, a dot). */
  lead?: IconName | Node | null;
  leadTone?: Tone;
  title: Child;
  /** One line under the title, in secondary text: what it is, or what it does. */
  sub?: Child;
  /** Small facts under that, side by side: a time, a count, a badge (meta()). */
  meta?: Child[];
  /** More under its text, a step below it: a quotation, a receipt that opens. */
  body?: Child;
  /** At its end: its actions, a badge, a control. */
  trail?: Child;
  /** The whole row goes somewhere (a link) or does something (a button). */
  href?: string;
  onClick?: (event: MouseEvent) => void;
  /** A chevron at its end: it opens something. */
  chevron?: boolean;
  /** Its parts sit at the top (a long body); otherwise the lead and the trail are level with the middle of its text. */
  top?: boolean;
  /** On a narrow screen its trail goes under the text (a setting's control). */
  wrap?: boolean;
  label?: string;
  /** Its identity across a redraw (syncChildren, an opened disclosure kept open). */
  key?: string;
}

/**
 * A row of a list (.rows > .item): a lead, its text (a title, a line under it, a meta line) and a trail, at the row's
 * padding (--row-pad above and below, --card-pad at either end). Every list in the app is made of these.
 */
export function listRow(options: ListRowOptions): HTMLElement {
  const lead =
    options.lead === undefined || options.lead === null
      ? null
      : typeof options.lead === "string"
        ? h("span", { class: "avatar", "data-tone": options.leadTone ?? null }, icon(options.lead, { size: 16 }))
        : options.lead;
  const parts = [
    lead,
    h(
      "div",
      { class: "item-text" },
      h("div", { class: "item-title" }, options.title),
      options.sub ? h("div", { class: "item-sub" }, options.sub) : null,
      options.meta?.some(Boolean) ? meta(...options.meta) : null,
      options.body ? h("div", { class: "item-body" }, options.body) : null,
    ),
    options.trail ? h("div", { class: "item-actions" }, options.trail) : null,
    options.chevron ? icon("chevron-right", { size: 16, class: "item-chevron" }) : null,
  ];
  const attrs = { class: cx("item", !options.top && "center", options.wrap && "wrap"), "aria-label": options.label ?? null, "data-key": options.key ?? null };
  if (options.href) return h("a", { ...attrs, href: options.href }, ...parts);
  if (options.onClick) return h("button", { ...attrs, class: cx(attrs.class, "item-button"), type: "button", onclick: options.onClick }, ...parts);
  return h("div", attrs, ...parts);
}

/** Small facts side by side, in quiet type and tabular figures (a time, a count, who): a row's meta line, a card's. */
export function meta(...parts: Child[]): HTMLElement {
  return h("div", { class: "meta" }, ...parts);
}

/**
 * A card that opens on request (details.card.disclosure): one line, with what it's about and a chevron, until it's
 * wanted. `flush` for a list in it, edge to edge under a hairline. Opened, it stays open across a redraw (keepPlace)
 * when its summary carries a `key`.
 */
export function disclosure(summary: Child, options: { open?: boolean; flush?: boolean; key?: string; hidden?: boolean } = {}, ...body: Child[]): HTMLDetailsElement {
  return h(
    "details",
    { class: cx("card", "disclosure", options.flush && "flush"), open: options.open ?? false, hidden: options.hidden ?? false },
    h("summary", { "data-key": options.key ?? null }, icon("chevron-right", { size: 14, class: "chev" }), summary),
    h("div", { class: "disclosure-body" }, ...body),
  );
}

/** Names and their values, two columns (dl.kv): a device's facts, an entry's. */
export function kv(pairs: [Child, Child][]): HTMLElement {
  return h("dl", { class: "kv" }, ...pairs.flatMap(([name, value]) => [h("dt", {}, name), h("dd", {}, value)]));
}
