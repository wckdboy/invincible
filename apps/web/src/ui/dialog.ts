import { type Child, h, nextId, prefersReducedMotion, Scope } from "./dom.ts";
import { formActions } from "./controls.ts";
import { icon } from "./icons.ts";

/*
 * Sheets: a centered dialog on wide screens, a bottom sheet you can drag
 * down to dismiss on phones (Vaul-style: follows the finger 1:1, settles with
 * the drawer curve, dismisses on distance or a quick flick). Built on
 * <dialog>.showModal(), so focus is trapped and the page behind is inert.
 *
 * The page behind dims and blurs; a centred one arrives on a short spring and
 * leaves quicker than it came. One that does what can't be taken back (tone
 * "danger", every confirmation but a primary one) has its edge, its mark and
 * its button in red; where its name must be typed, that stays (docs/DESIGN.md,
 * Safety patterns).
 */

export interface SheetOptions {
  title: string;
  description?: Child;
  size?: "small" | "wide";
  body?: Child;
  footer?: Child;
  /** Element to focus first; defaults to the first field, else the close button. */
  initialFocus?: () => HTMLElement | null | undefined;
  onClose?: () => void;
  /** Accessible role; alertdialog for confirmations. */
  role?: "dialog" | "alertdialog";
  /** "danger": what it does can't be taken back; its edge and its mark beside the title are red. */
  tone?: "danger";
}

export interface Sheet {
  el: HTMLDialogElement;
  body: HTMLElement;
  foot: HTMLElement;
  /** Lives as long as the sheet: put polls and timers here. */
  scope: Scope;
  close(): void;
}

const phone = () => matchMedia("(max-width: 639px)").matches;

/** The page an address is on: its first part (`#/chat/cv_…` is the chat page). */
export const pageOf = (hash: string): string => hash.match(/^#\/([a-z][a-z-]*)/)?.[1] ?? "";

/** Whether going from one address to another leaves the page (and so whatever sheet is open on it). */
export const leavesPage = (from: string, to: string): boolean => pageOf(from) !== pageOf(to);

export function openSheet(options: SheetOptions): Sheet {
  const scope = new Scope();
  const titleId = nextId("sheet-title");
  const descId = nextId("sheet-desc");
  const returnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  const closeButton = h("button", { class: "btn ghost sm icon-only", type: "button", "aria-label": "Close" }, icon("x", { size: 16 }));
  const handle = h("div", { class: "sheet-handle", "aria-hidden": "true" });
  const head = h(
    "header",
    { class: "sheet-head" },
    options.tone === "danger" ? h("span", { class: "sheet-mark", "aria-hidden": "true" }, icon("alert", { size: 16 })) : null,
    h("div", { class: "grow" }, h("h2", { id: titleId }, options.title), options.description ? h("div", { class: "sub", id: descId }, options.description) : null),
    closeButton,
  );
  const body = h("div", { class: "sheet-body" }, options.body);
  const foot = h("footer", { class: "sheet-foot", hidden: !options.footer }, options.footer);
  const el = h(
    "dialog",
    {
      class: `sheet${options.size ? ` ${options.size}` : ""}`,
      "aria-labelledby": titleId,
      "aria-describedby": options.description ? descId : null,
      role: options.role ?? null,
      "data-tone": options.tone ?? null,
    },
    handle,
    head,
    body,
    foot,
  );

  let closing = false;
  function close(): void {
    if (closing) return;
    closing = true;
    el.classList.remove("shown");
    el.style.removeProperty("--drag");
    const finish = () => {
      if (!el.isConnected) return;
      el.close();
      el.remove();
      scope.dispose();
      options.onClose?.();
      if (returnFocus?.isConnected) returnFocus.focus({ preventScroll: true });
    };
    if (prefersReducedMotion()) finish();
    else {
      el.addEventListener("transitionend", (event) => event.target === el && finish(), { once: false });
      setTimeout(finish, phone() ? 420 : 240);
    }
  }

  closeButton.addEventListener("click", close);
  el.addEventListener("cancel", (event) => {
    event.preventDefault();
    close();
  });
  // Close on a click that starts and ends on the backdrop (not a drag out of a text field).
  let downOnBackdrop = false;
  el.addEventListener("pointerdown", (event) => {
    downOnBackdrop = event.target === el;
  });
  el.addEventListener("click", (event) => {
    if (event.target === el && downOnBackdrop) close();
    downOnBackdrop = false;
  });

  // Drag to dismiss (phones). The sheet follows the pointer; release decides.
  let startY = 0;
  let startT = 0;
  let dragging = false;
  let lastY = 0;
  const onDown = (event: PointerEvent) => {
    if (!phone() || event.button !== 0) return;
    if (event.target instanceof HTMLElement && event.target.closest("button, input, textarea, select, a")) return;
    dragging = true;
    startY = lastY = event.clientY;
    startT = performance.now();
    el.classList.add("dragging");
    (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
  };
  const onMove = (event: PointerEvent) => {
    if (!dragging) return;
    lastY = event.clientY;
    const delta = Math.max(0, lastY - startY);
    // Slight resistance upward, 1:1 downward.
    el.style.setProperty("--drag", `${delta}px`);
  };
  const onUp = () => {
    if (!dragging) return;
    dragging = false;
    el.classList.remove("dragging");
    const delta = Math.max(0, lastY - startY);
    const velocity = delta / Math.max(1, performance.now() - startT);
    if (delta > el.offsetHeight * 0.3 || (velocity > 0.45 && delta > 24)) close();
    else el.style.setProperty("--drag", "0px");
  };
  for (const target of [handle, head]) {
    target.addEventListener("pointerdown", onDown);
    target.addEventListener("pointermove", onMove);
    target.addEventListener("pointerup", onUp);
    target.addEventListener("pointercancel", onUp);
  }

  // A sheet belongs to the page it was opened on: going to another (the phone's back gesture, a link in the
  // sheet) closes it, instead of leaving it open over a page it has nothing to do with.
  const openedOn = location.hash;
  window.addEventListener("hashchange", () => leavesPage(openedOn, location.hash) && close(), { signal: scope.signal });

  document.body.appendChild(el);
  el.showModal();
  requestAnimationFrame(() => requestAnimationFrame(() => el.classList.add("shown")));
  const first =
    options.initialFocus?.() ?? body.querySelector<HTMLElement>("input:not([type=hidden]):not(:disabled), textarea:not(:disabled), select:not(:disabled)") ?? closeButton;
  first.focus({ preventScroll: true });

  return { el, body, foot, scope, close };
}

export interface ConfirmOptions {
  title: string;
  body?: Child;
  confirmLabel: string;
  cancelLabel?: string;
  tone?: "danger" | "primary";
  /** For the most dangerous actions: the exact text to type before confirming. */
  typeToConfirm?: string;
}

/** Explicit confirmation; resolves true only when the owner confirms. */
export function confirmAction(options: ConfirmOptions): Promise<boolean> {
  return new Promise((resolve) => {
    let decided = false;
    const decide = (value: boolean) => {
      if (decided) return;
      decided = true;
      resolve(value);
      sheet.close();
    };
    const confirm = h(
      "button",
      { class: `btn ${options.tone === "primary" ? "primary" : "danger-solid"}`, type: "submit", disabled: Boolean(options.typeToConfirm) },
      options.confirmLabel,
    );
    const cancel = h("button", { class: "btn", type: "button", onclick: () => decide(false) }, options.cancelLabel ?? "Cancel");
    const inputId = nextId("confirm");
    const typed = options.typeToConfirm
      ? h("input", { class: "input mono", id: inputId, type: "text", autocomplete: "off", autocorrect: "off", spellcheck: "false", autocapitalize: "off" })
      : null;
    typed?.addEventListener("input", () => {
      confirm.disabled = typed.value !== options.typeToConfirm;
    });
    const form = h(
      "form",
      {
        class: "stack",
        onsubmit: (event: Event) => {
          event.preventDefault();
          if (!confirm.disabled) decide(true);
        },
      },
      options.body ? h("div", { class: "stack tight small muted" }, options.body) : null,
      typed
        ? h(
            "div",
            { class: "field" },
            h("label", { for: inputId }, "Type ", h("span", { class: "mono strong" }, options.typeToConfirm ?? ""), " to confirm"),
            typed,
          )
        : null,
      formActions(cancel, confirm),
    );
    const sheet = openSheet({
      title: options.title,
      size: "small",
      role: "alertdialog",
      tone: options.tone === "primary" ? undefined : "danger",
      body: form,
      initialFocus: () => typed ?? cancel,
      onClose: () => decide(false),
    });
  });
}
