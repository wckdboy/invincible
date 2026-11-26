import { CONNECTION, type Connection, connectionCourse } from "../lib/alerts.ts";
import { button } from "./controls.ts";
import { h, replace } from "./dom.ts";
import { icon } from "./icons.ts";

/*
 * The banner under the top bar that says Galahad can't be reached, or that this device is offline, and then for a
 * moment that he is reached again (lib/alerts.ts connectionCourse says when). It is a thin capsule floating over the
 * page, its place on the page taking no room, so nothing under it moves when it comes or goes. Offline is no error,
 * so it is grey; can't reach him is amber, and as the app tries again one slow line of light passes along its foot,
 * once as it comes and once more at each Retry (nothing moves while it only waits); reached again it turns green where
 * it is, then goes. It drops in on a short spring, out of a slight blur, and leaves with a short fade; where motion is
 * reduced it only appears, goes, and has no line. Nothing in it blinks.
 */

/** How long one takes to go, at most (its fade is --d-2; it is taken out of the page by then, transition or not). */
const LEAVING_MS = 400;

/** The capsule saying `said`, with Retry where it offers one. The gallery draws them in place. */
export function bannerPill(said: Connection, retry: () => void = () => {}): HTMLElement {
  const pill = h("div", { class: "banner-pill" });
  fill(pill, said, retry);
  return pill;
}

function fill(pill: HTMLElement, said: Connection, retry: () => void): void {
  const how = CONNECTION[said];
  pill.dataset.tone = how.tone;
  pill.dataset.said = said;
  pill.toggleAttribute("data-trying", how.trying);
  replace(
    pill,
    icon(said === "reconnected" ? "check-circle" : "offline", { size: 16 }),
    h("span", { class: "banner-text" }, how.text),
    how.retry
      ? button("Retry", {
          size: "sm",
          variant: "ghost",
          onClick: () => {
            retry();
            sweepAgain(pill);
          },
        })
      : null,
  );
}

/** Its line of light passes once more (at Retry): drawn anew, its one pass starts again. */
function sweepAgain(pill: HTMLElement): void {
  if (!pill.hasAttribute("data-trying")) return;
  pill.removeAttribute("data-trying");
  requestAnimationFrame(() => pill.setAttribute("data-trying", ""));
}

/**
 * Makes `el` (the shell's banner, under the top bar: a polite live region) say whether Galahad is reached: `reach` takes
 * each word of it (lib/reach.ts, through the app's `online`). It listens for the browser going offline or coming back
 * until `signal` ends it (the shell's lifetime). `retry` asks the node again at once.
 */
export function connectionBanner(el: HTMLElement, retry: () => void, signal: AbortSignal): (reached: boolean) => void {
  // (It stays on the page, empty while all is well, so what it says when it comes is read out.)
  el.hidden = false;
  let pill: HTMLElement | null = null;
  const course = connectionCourse({
    show(said) {
      if (pill) return fill(pill, said, retry);
      pill = bannerPill(said, retry);
      pill.classList.add("entering");
      el.append(pill);
      const coming = pill;
      requestAnimationFrame(() => requestAnimationFrame(() => coming.classList.remove("entering")));
    },
    hide() {
      const going = pill;
      pill = null;
      if (!going) return;
      going.classList.add("leaving");
      const remove = () => going.remove();
      going.addEventListener("transitionend", (event) => event.target === going && remove());
      setTimeout(remove, LEAVING_MS);
    },
    after(ms, run) {
      const timer = setTimeout(run, ms);
      return () => clearTimeout(timer);
    },
    offline: () => !navigator.onLine,
  });
  addEventListener("online", course.network, { signal });
  addEventListener("offline", course.network, { signal });
  return course.reach;
}
