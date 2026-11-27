import type { Agent } from "@invincible/core/team";
import { ApiError, isAbort, isUnavailable } from "../api.ts";
import { type Ctx, errorMessage } from "../context.ts";
import { DESKTOP_KEYS, type DesktopDo, type DesktopDone, desktopAddress, type DesktopView, saysNoDesktop, screenPoint, shotSource } from "../lib/desktop.ts";
import { againIn, BEHIND, type Behinds, behindAgain, behindTooOften, chunkOf, codecOf, type DesktopHold, holdEnds, LIVE_TRIES } from "../lib/desktop-stream.ts";
import { clockTime } from "../lib/time.ts";
import { button, callout, switchControl } from "../ui/controls.ts";
import { h, replace } from "../ui/dom.ts";

/*
 * An agent's desktop, watched and taken over from its Workspace.
 * - Live where this browser decodes H.264 (WebCodecs): the node's stream of the screen (POST /api/team/desktop/stream,
 *   lib/desktop-stream.ts), drawn as it comes while the desktop is in view and the app in front, and ended when it
 *   isn't (the encoder in the VM runs only while someone watches). Elsewhere, or when the stream doesn't come through
 *   after a few tries, a picture of the screen about every two seconds (POST /api/team/desktop { id, action? }).
 * - What you do there: a click on the screen clicks at that place on the agent's screen; typed text is typed (and never
 *   written to the ledger); keys, an address and scrolling are one press each. While it is live, nothing comes back but
 *   whether you have the desktop: the stream shows what you did. Otherwise each thing done brings back the screen.
 * - Your take-over: your first input takes the desktop over if no one has it, as Take over does; while you have it, the
 *   agent's own desktop commands and its looks wait. It ends when you give it back, two minutes after your last input,
 *   or fifteen minutes in all. Each answer says whether you have it, and until when.
 * lib/desktop.ts holds the arithmetic.
 */

/** The picture is asked for this often while it is on screen and not live. */
const EVERY_MS = 2000;
/** How far one press of Scroll goes, in the wheel's own steps. */
const SCROLL_STEPS = 3;

export interface DesktopViewer {
  el: HTMLElement;
  dispose(): void;
}

/** Whether this browser has a video decoder of its own (WebCodecs): without one, the desktop is a picture. */
const decodes = (): boolean => typeof globalThis.VideoDecoder === "function" && typeof globalThis.EncodedVideoChunk === "function";

/** `viewport`: what scrolls the panel (the desktop is watched only while it is in view). `makeAgain`: its VM made again with a desktop. */
export function desktopViewer(ctx: Ctx, person: Pick<Agent, "id" | "name">, viewport: Element | null, makeAgain: (() => void) | null): DesktopViewer {
  const controller = new AbortController();
  const picture = h("img", { alt: `${person.name}'s screen`, draggable: "false" });
  const screen = h("canvas", { role: "img", "aria-label": `${person.name}'s screen, live` });
  const frame = h("div", { class: "desktop-shot", title: `A click here clicks at that place on ${person.name}'s screen` }, picture, screen);
  const seen = h("span", { class: "tiny subtle tnum" }, "Looking…");
  const problem = h("div", { role: "status" });
  /** The screen's size in its own pixels, as last drawn: where a click lands. */
  let size: { width: number; height: number } | null = null;
  let shown = false;
  let over = false;
  let halted = false;
  let asking = 0;
  let queue: Promise<void> = Promise.resolve();
  let timer: ReturnType<typeof setTimeout> | undefined;

  // ---- live: the node's stream, decoded here
  /** The stream is what the box shows. */
  let live = false;
  /** Given up for pictures: no decoder here, a node or a VM with no stream, or one that didn't come through. */
  let pictures = !decodes();
  let watching: AbortController | null = null;
  let tries = 0;
  /** Behinds in a row, counted apart from the ends (lib/desktop-stream.ts behindAgain). */
  let behinds: Behinds | null = null;
  let again: ReturnType<typeof setTimeout> | undefined;

  const sized = (next: { width: number; height: number }): void => {
    // (The box takes the screen's own proportions, so a place on it is that place on the screen.)
    if (!size || size.width !== next.width || size.height !== next.height) frame.style.aspectRatio = `${next.width} / ${next.height}`;
    size = next;
  };

  /** Watch the stream while the desktop is in view and the app in front; watch again after it ends, a few times. */
  async function watch(): Promise<void> {
    if (watching || pictures || over || !shown || document.hidden) return;
    const mine = new AbortController();
    watching = mine;
    const end = (): void => mine.abort();
    controller.signal.addEventListener("abort", end, { once: true });
    let decoder: VideoDecoder | null = null;
    let refused = false;
    let behind = false;
    try {
      const draw = screen.getContext("2d");
      if (!draw) throw new Error("no canvas to draw on");
      for await (const got of ctx.api.frames("/api/team/desktop/stream", { id: person.id }, mine.signal)) {
        const chunk = chunkOf(got);
        if (!chunk) continue;
        if (!decoder) {
          // (The decoder is made on the first keyframe, by what its SPS says it is.)
          if (chunk.type !== "key") continue;
          const config = { codec: codecOf(chunk.data) ?? "", optimizeForLatency: true };
          if (!config.codec || !(await VideoDecoder.isConfigSupported(config)).supported) {
            refused = true;
            break;
          }
          decoder = new VideoDecoder({
            output: (decoded) => {
              if (screen.width !== decoded.displayWidth || screen.height !== decoded.displayHeight) {
                screen.width = decoded.displayWidth;
                screen.height = decoded.displayHeight;
              }
              draw.drawImage(decoded, 0, 0);
              decoded.close();
              if (!live) shownLive({ width: screen.width, height: screen.height });
            },
            error: end,
          });
          decoder.configure(config);
        }
        // (A device that decodes slower than the screen changes falls behind: it starts again from a fresh keyframe, and
        // after three such in a row, each within 30 s of the last, it is shown the picture every two seconds instead.)
        if (decoder.decodeQueueSize > BEHIND) {
          behind = true;
          break;
        }
        decoder.decode(new EncodedVideoChunk(chunk));
      }
    } catch (error) {
      // A refusal (an older node, a VM with no stream, no `sandbox`) isn't mended by asking again.
      if (!isAbort(error) && error instanceof ApiError && (isUnavailable(error) || error.status < 500)) refused = true;
    } finally {
      controller.signal.removeEventListener("abort", end);
      if (decoder && decoder.state !== "closed") decoder.close();
      if (watching === mine) watching = null;
    }
    if (over) return;
    if (live) {
      live = false;
      seen.textContent = "As it was last seen";
    }
    // Left (out of view, the app behind): watched again when it is back, as a fresh start.
    if (mine.signal.aborted && (!shown || document.hidden)) return;
    if (behind) {
      behinds = behindAgain(behinds, Date.now());
      if (behindTooOften(behinds)) return toPictures("behind");
    }
    tries += 1;
    if (refused || tries >= LIVE_TRIES) return toPictures(refused ? null : "tried");
    clearTimeout(again);
    again = setTimeout(() => void watch(), againIn(tries));
  }

  function shownLive(next: { width: number; height: number }): void {
    live = true;
    tries = 0;
    sized(next);
    screen.dataset.shown = "";
    delete picture.dataset.shown;
    seen.textContent = `Live · ${next.width}×${next.height}`;
    clearTimeout(timer);
    halted = false;
    replace(problem);
  }

  /**
   * The stream given up: the picture every two seconds, as before. Said why, once, when it was tried and didn't come
   * through, or when this device kept falling behind it; a refusal says nothing.
   */
  function toPictures(why: "tried" | "behind" | null): void {
    pictures = true;
    live = false;
    delete screen.dataset.shown;
    if (why === "tried") replace(problem, callout("info", `The live picture of ${person.name}'s screen isn't coming through, so it is shown every two seconds instead.`));
    if (why === "behind") replace(problem, callout("info", `This device can't keep up with ${person.name}'s screen live, so it is shown every two seconds instead.`));
    void ask();
  }

  // ---- your take-over
  const holdLine = h("span", { class: "tiny tnum" });
  const take = button("Take over", { size: "sm", onClick: () => void holding(true) });
  const give = button("Give back", { size: "sm", onClick: () => void holding(false) });
  // (There from the first frame, so nothing moves when the node first says whether you have it. The app is its node's
  // own, so the routes are there; a VM whose image is older than take-over refuses Take over, saying so.)
  const holdRow = h("div", { class: "row between desktop-hold" }, holdLine, take, give);
  let ends: ReturnType<typeof setTimeout> | undefined;
  /** What the node said of your take-over: undefined says nothing (an image older than take-over: the row stays as it was). */
  function heard(held: DesktopHold | null | undefined): void {
    if (held === undefined) return;
    clearTimeout(ends);
    take.hidden = held !== null;
    give.hidden = held === null;
    if (!held) {
      holdLine.textContent = `While you have it, ${person.name}'s own desktop commands wait.`;
      return;
    }
    const at = holdEnds(held, Date.now());
    holdLine.textContent = `You have it until ${clockTime(at)}. ${person.name}'s desktop commands wait.`;
    // (Once, when it ends with nothing more done there: nothing on the page counts down.)
    ends = setTimeout(() => heard(null), Math.max(0, at - Date.now()));
  }
  heard(null);
  async function holding(yes: boolean): Promise<void> {
    try {
      const answer = await ctx.api.post<{ held: DesktopHold | null }>(yes ? "/api/team/desktop/take" : "/api/team/desktop/release", { id: person.id }, controller.signal);
      heard(answer.held ?? null);
      replace(problem);
    } catch (error) {
      if (isAbort(error)) return;
      replace(problem, callout("warn", errorMessage(error), { title: yes ? `Couldn't take ${person.name}'s desktop over just now` : "Couldn't give it back just now" }));
    }
  }

  // ---- looks and things done
  const later = (): void => {
    clearTimeout(timer);
    if (!over && !halted && !live && shown && !document.hidden && asking === 0) timer = setTimeout(() => void ask(), EVERY_MS);
  };
  /** One look, or one thing done and then a look: in turn, never two at once. While live, no picture comes back. */
  function ask(action?: DesktopDo): Promise<void> {
    clearTimeout(timer);
    asking++;
    if (action && !live) seen.textContent = "Sending…";
    const run = queue.then(async () => {
      if (over) return;
      const quiet = live;
      try {
        const next = await ctx.api.post<DesktopView | DesktopDone>("/api/team/desktop", { id: person.id, ...(action ? { action } : {}), ...(quiet ? { picture: false } : {}) }, controller.signal);
        heard(next.held);
        if ("done" in next) return;
        const source = shotSource(next);
        if (!source) throw new Error("The desktop sent a picture this app doesn't show.");
        sized(next);
        // (A picture that comes back while the stream is drawn is not shown over it.)
        if (!live) {
          picture.src = source;
          picture.dataset.shown = "";
          seen.textContent = `Seen just now · ${next.width}×${next.height}`;
        }
        halted = false;
        replace(problem);
      } catch (error) {
        if (isAbort(error)) return;
        // Nothing more is asked until you ask: a refusal is said once, not every two seconds.
        halted = true;
        if (!live) seen.textContent = size ? "As it was last seen" : "Not seen";
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

  // A click on the screen is a click at the same place on the agent's screen, whatever size it is drawn at.
  const clicked = (event: MouseEvent): void => {
    if (!size) return;
    const point = screenPoint({ x: event.clientX, y: event.clientY }, (live ? screen : picture).getBoundingClientRect(), size);
    if (point) void ask({ do: "click", ...point });
  };
  picture.addEventListener("click", clicked);
  screen.addEventListener("click", clicked);

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
    holdRow,
    h("p", { class: "tiny subtle" }, `A click on the screen clicks there on ${person.name}'s screen at once, and takes it over if you don't have it.`),
    problem,
    keys,
    open,
    addressProblem,
    type,
    hide,
    h("p", { class: "tiny subtle" }, `What you type goes to ${person.name}'s desktop and is never written to the ledger: it records only how many characters.`),
  );

  /** In view and in front: a look (which says whether you have it), and the stream. Out of either: nothing runs. */
  const look = (): void => {
    if (!shown || document.hidden) {
      clearTimeout(timer);
      clearTimeout(again);
      watching?.abort();
      return;
    }
    if (!halted && asking === 0) void ask();
    tries = 0;
    void watch();
  };
  const observer = new IntersectionObserver(
    ([entry]) => {
      shown = Boolean(entry?.isIntersecting);
      look();
    },
    { root: viewport },
  );
  observer.observe(frame);
  document.addEventListener("visibilitychange", look);

  return {
    el,
    dispose() {
      over = true;
      clearTimeout(timer);
      clearTimeout(again);
      clearTimeout(ends);
      controller.abort();
      observer.disconnect();
      document.removeEventListener("visibilitychange", look);
      typed.value = "";
    },
  };
}
