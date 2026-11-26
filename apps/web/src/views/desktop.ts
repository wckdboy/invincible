import type { Teammate } from "@galahad/core/team";
import { isAbort } from "../api.ts";
import { type Ctx, errorMessage } from "../context.ts";
import { DESKTOP_KEYS, desktopAddress, type DesktopDo, type DesktopView, saysNoDesktop, screenPoint, shotSource } from "../lib/desktop.ts";
import { button, callout, switchControl } from "../ui/controls.ts";
import { h, replace } from "../ui/dom.ts";

/*
 * A knight's desktop, watched and taken over from its Workspace (POST /api/team/desktop { id, action? }): a picture
 * of its screen, asked for about every two seconds while it is on screen and the app is in front; and what you do
 * there. A click on the picture clicks at that place on the knight's screen; typed text is typed (and never written
 * to the ledger); keys, an address and scrolling are one press each. Each thing done brings back the screen as it
 * then is. lib/desktop.ts holds the arithmetic.
 */

/** The picture is asked for this often while it is on screen. */
const EVERY_MS = 2000;
/** How far one press of Scroll goes, in the wheel's own steps. */
const SCROLL_STEPS = 3;

export interface DesktopViewer {
  el: HTMLElement;
  dispose(): void;
}

/** `viewport`: what scrolls the panel (the picture is asked for only while it is in view). `makeAgain`: its VM made again with a desktop. */
export function desktopViewer(ctx: Ctx, person: Pick<Teammate, "id" | "name">, viewport: Element | null, makeAgain: (() => void) | null): DesktopViewer {
  const controller = new AbortController();
  const picture = h("img", { alt: `${person.name}'s screen`, draggable: "false" });
  const frame = h("div", { class: "desktop-shot", title: `A click here clicks at that place on ${person.name}'s screen` }, picture);
  const seen = h("span", { class: "tiny subtle tnum" }, "Looking…");
  const problem = h("div", { role: "status" });
  let view: DesktopView | null = null;
  let shown = false;
  let over = false;
  let halted = false;
  let asking = 0;
  let queue: Promise<void> = Promise.resolve();
  let timer: ReturnType<typeof setTimeout> | undefined;

  const later = (): void => {
    clearTimeout(timer);
    if (!over && !halted && shown && !document.hidden && asking === 0) timer = setTimeout(() => void ask(), EVERY_MS);
  };
  /** One look, or one thing done and then a look: in turn, never two at once. */
  function ask(action?: DesktopDo): Promise<void> {
    clearTimeout(timer);
    asking++;
    if (action) seen.textContent = "Sending…";
    const run = queue.then(async () => {
      if (over) return;
      try {
        const next = await ctx.api.post<DesktopView>("/api/team/desktop", { id: person.id, ...(action ? { action } : {}) }, controller.signal);
        const source = shotSource(next);
        if (!source) throw new Error("The desktop sent a picture this app doesn't show.");
        // (The picture's box takes the screen's own proportions, so a place on it is that place on the screen.)
        if (!view || view.width !== next.width || view.height !== next.height) frame.style.aspectRatio = `${next.width} / ${next.height}`;
        view = next;
        picture.src = source;
        picture.dataset.shown = "";
        seen.textContent = `Seen just now · ${next.width}×${next.height}`;
        halted = false;
        replace(problem);
      } catch (error) {
        if (isAbort(error)) return;
        // Nothing more is asked until you ask: a refusal is said once, not every two seconds.
        halted = true;
        seen.textContent = view ? "As it was last seen" : "Not seen";
        replace(
          problem,
          saysNoDesktop(error)
            ? callout("warn", `${person.name}'s VM has no desktop just now: its image says it should, but the VM has no screen to show.`, { actions: makeAgain ? button("Make VM again with a desktop", { size: "sm", icon: "retry", onClick: makeAgain }) : null })
            : callout("warn", errorMessage(error), { title: "Couldn't reach the desktop just now", actions: button("Try again", { size: "sm", icon: "refresh", onClick: () => void ask() }) }),
        );
      }
    });
    queue = run.finally(() => {
      asking--;
      later();
    });
    return run;
  }

  // A click on the picture is a click at the same place on the knight's screen, whatever size the picture is drawn at.
  picture.addEventListener("click", (event: MouseEvent) => {
    if (!view) return;
    const point = screenPoint({ x: event.clientX, y: event.clientY }, picture.getBoundingClientRect(), view);
    if (point) void ask({ do: "click", ...point });
  });

  // (Text with a URL keyboard, not type=url: the browser would refuse a bare host, which desktopAddress takes as https.)
  const address = h("input", { class: "input", name: "address", type: "text", inputmode: "url", maxlength: 2000, placeholder: "An address to open", autocomplete: "off", autocorrect: "off", spellcheck: "false", autocapitalize: "off", "aria-label": `An address for ${person.name}'s browser` });
  const addressProblem = h("p", { class: "tiny", role: "status" });
  const open = h(
    "form",
    {
      class: "desktop-line",
      onsubmit: (event: Event) => {
        event.preventDefault();
        const where = desktopAddress(address.value);
        addressProblem.textContent = where ? "" : "That isn't an address: http, https, file or about, or a bare host.";
        if (where) void ask({ do: "open", address: where });
      },
    },
    address,
    button("Open", { size: "sm", type: "submit" }),
  );

  // What you type goes to the VM as it is, and nowhere else: it is not kept here, and the field is emptied once it is sent.
  const typed = h("input", { class: "input", name: "type", type: "text", maxlength: 2000, placeholder: `Text to type on ${person.name}'s screen`, autocomplete: "off", spellcheck: "false", autocapitalize: "off", autocorrect: "off", "data-1p-ignore": "true", "data-lpignore": "true", "aria-label": `Text to type on ${person.name}'s screen` });
  const type = h(
    "form",
    {
      class: "desktop-line",
      onsubmit: (event: Event) => {
        event.preventDefault();
        const text = typed.value;
        typed.value = "";
        if (text) void ask({ do: "type", text });
      },
    },
    typed,
    button("Type", { size: "sm", type: "submit" }),
  );
  const hide = switchControl("Hide what I type", false, (on) => (typed.type = on ? "password" : "text"), { hint: "For a password you type to sign it in." });

  const keys = h(
    "div",
    { class: "row wrap" },
    ...DESKTOP_KEYS.map((key) => button(key.label, { size: "sm", onClick: () => void ask({ do: "key", keys: [key.key] }) })),
    button("Scroll up", { size: "sm", icon: "chevron-up", onClick: () => void ask({ do: "scroll", direction: "up", times: SCROLL_STEPS }) }),
    button("Scroll down", { size: "sm", icon: "chevron-down", onClick: () => void ask({ do: "scroll", direction: "down", times: SCROLL_STEPS }) }),
  );

  const el = h(
    "section",
    { class: "desktop stack", "aria-label": `${person.name}'s desktop` },
    h("div", { class: "row between" }, h("h3", {}, "Desktop"), seen),
    frame,
    h("p", { class: "tiny subtle" }, `A click on the picture clicks there on ${person.name}'s screen, at once, even while ${person.name} is working on it.`),
    problem,
    keys,
    open,
    addressProblem,
    type,
    hide,
    h("p", { class: "tiny subtle" }, `What you type goes to ${person.name}'s desktop and is never written to the ledger: it records only how many characters.`),
  );

  const observer = new IntersectionObserver(
    ([entry]) => {
      shown = Boolean(entry?.isIntersecting);
      if (shown && !halted && asking === 0) void ask();
      else if (!shown) clearTimeout(timer);
    },
    { root: viewport },
  );
  observer.observe(frame);
  const inFront = (): void => {
    if (document.hidden) clearTimeout(timer);
    else if (shown && !halted && asking === 0) void ask();
  };
  document.addEventListener("visibilitychange", inFront);

  return {
    el,
    dispose() {
      over = true;
      clearTimeout(timer);
      controller.abort();
      observer.disconnect();
      document.removeEventListener("visibilitychange", inFront);
      typed.value = "";
    },
  };
}
