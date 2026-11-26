import { greeting } from "./lib/time.ts";
import { isIos, pairingNote } from "./lib/push.ts";
import { shortId } from "./lib/text.ts";
import { button, callout, copyField } from "./ui/controls.ts";
import { confirmAction } from "./ui/dialog.ts";
import { type Child, h, replace } from "./ui/dom.ts";
import { emblem } from "./ui/emblem.ts";
import { icon } from "./ui/icons.ts";
import { type BrowserIdentity, forgetIdentity, runningAsApp } from "./identity.ts";

/*
 * Full-screen states outside the app shell: welcome (unpaired), revoked,
 * insecure context, unreachable node. Calm, centred, one clear next step.
 */

export function solo(...children: Child[]): HTMLElement {
  return h("div", { class: "solo" }, h("main", { class: "solo-card" }, ...children));
}

export function hero(title: string, lede: Child): HTMLElement {
  return h("header", { class: "hero" }, h("div", { class: "hero-mark" }, emblem({ size: 72 })), h("h1", {}, title), h("p", {}, lede));
}

export function trustStrip(): HTMLElement {
  return h(
    "div",
    { class: "trust-strip" },
    h("span", {}, icon("key"), "Key never leaves this device"),
    h("span", {}, icon("shield-check"), "You approve every device"),
    h("span", {}, icon("vault"), "Secrets stay in the vault"),
  );
}

const footer = () => h("footer", { class: "solo-foot" }, h("span", {}, "Galahad · one mind, many bodies"));

/** The invite inside whatever was pasted: a whole #pair= link, or just the invite itself. */
export function inviteFrom(text: string): string | null {
  const trimmed = text.trim();
  const fromLink = trimmed.match(/[#&]pair=([A-Za-z0-9._-]+)/)?.[1];
  if (fromLink) return fromLink;
  return /^gi\d+\.[A-Za-z0-9_-]+$/.test(trimmed) ? trimmed : null;
}

/** Running as an app added to the Home Screen (which keeps its own storage, apart from the browser's). */
const installed = runningAsApp;

export function renderWelcome(root: HTMLElement, identity: BrowserIdentity | null, onInvite?: (invite: string) => void): void {
  document.title = "Welcome · Galahad";
  const field = h("input", { class: "input", type: "url", id: "invite-link", placeholder: "https://…#pair=gi1.…", autocomplete: "off", autocapitalize: "off", autocorrect: "off", spellcheck: "false" });
  const problem = h("div", { class: "hint", "aria-live": "polite" });
  const pasteForm = onInvite
    ? h(
        "form",
        {
          class: "stack",
          onsubmit: (event: Event) => {
            event.preventDefault();
            const invite = inviteFrom(field.value);
            if (!invite) {
              problem.textContent = "That isn't an invite link. Copy the whole link `galahad invite --client` prints.";
              return;
            }
            onInvite(invite);
          },
        },
        h("label", { for: "invite-link", class: "strong" }, "Have an invite? Paste the link"),
        field,
        problem,
        button("Continue", { variant: "primary", type: "submit", block: true }),
      )
    : null;
  const note = pairingNote({ ios: isIos(navigator), standalone: installed() });
  replace(
    root,
    solo(
      hero(`${greeting()}.`, installed() ? "This app isn't part of your fleet yet." : "This browser isn't part of your fleet yet. Pairing takes a minute and needs one of your nodes."),
      note === "pair-this-app"
        ? callout(
            "info",
            "An app on your Home Screen keeps its own key, apart from the browser's, so it pairs on its own even if the browser already did. Links open in the browser, not here: paste the invite below instead.",
            { title: "Pair this app itself" },
          )
        : note === "home-screen-first"
          ? callout(
              "info",
              "In Safari, tap Share (in the ⋯ menu on iOS 26), then Add to Home Screen (under More if it isn't listed), and open Galahad from there to pair it. The app on your Home Screen keeps its own key, apart from Safari's, and only it can get notifications: paired here first, you'd pair it twice.",
              { title: "On an iPhone, add it to your Home Screen first" },
            )
          : null,
      h(
        "section",
        { class: "card", "aria-label": "How to pair" },
        h(
          "ol",
          { class: "steps-num" },
          h("li", {}, h("div", {}, h("span", { class: "strong plain" }, "On any of your nodes, run"), copyField("galahad invite --client"))),
          h("li", {}, h("div", {}, h("span", {}, installed() ? "Copy the link it prints and paste it below. It works once and expires in ten minutes." : ["Open the link it prints ", h("strong", {}, "on this device"), ", or paste it below. It works once and expires in ten minutes."]))),
          h("li", {}, h("div", {}, h("span", {}, "Both screens show a six-digit code. Approve on the node ", h("strong", {}, "only if the codes match"), "."))),
        ),
        pasteForm,
        identity ? h("p", { class: "tiny subtle centered" }, installed() ? "This app's key " : "This browser's key ", h("span", { class: "mono" }, shortId(identity.device, 12))) : null,
      ),
      trustStrip(),
      footer(),
    ),
  );
  if (installed()) field.focus();
}

export function renderRevoked(root: HTMLElement): void {
  document.title = "Not recognised · Galahad";
  const forget = button("Forget this browser's key", {
    variant: "primary",
    onClick: async () => {
      const ok = await confirmAction({
        title: "Forget this browser's key?",
        body: "The key is deleted from this browser and can't be recovered. You can pair again with a fresh invite.",
        confirmLabel: "Forget key",
      });
      if (!ok) return;
      await forgetIdentity();
      location.reload();
    },
  });
  replace(
    root,
    solo(
      hero("This browser is no longer recognised.", "Its key may have been revoked, or this node doesn't know it."),
      h(
        "section",
        { class: "card" },
        h("p", { class: "small muted" }, "To pair again, forget this browser's key, then open a fresh invite from ", h("span", { class: "mono" }, "galahad invite --client"), "."),
        h("p", { class: "tiny subtle" }, "If this browser was approved on another node only moments ago, the news may still be on its way here: try again first."),
        h("div", { class: "row wrap centered" }, forget, button("Try again", { icon: "retry", onClick: () => location.reload() })),
      ),
      footer(),
    ),
  );
}

export function renderInsecure(root: HTMLElement): void {
  document.title = "Secure connection needed · Galahad";
  replace(
    root,
    solo(
      hero("A secure connection is needed.", "Device keys only work over HTTPS (or on localhost)."),
      h("section", { class: "card" }, h("p", { class: "small muted" }, "On the node, run this and open the HTTPS address it prints:"), copyField("galahad expose")),
      footer(),
    ),
  );
}

/** How long the unreachable screen waits before trying again on its own: 3 s, then doubling, at most 30 s. */
export const retryDelayMs = (attempt: number): number => Math.min(30_000, 3000 * 2 ** Math.max(0, attempt));

/**
 * The node can't be reached: say so, and keep trying on our own (sooner when the network
 * comes back or the app is brought to the front), so a node restart heals by itself.
 */
export function renderUnreachable(root: HTMLElement, message: string, retry: () => void, attempt = 0): void {
  document.title = "Unreachable · Galahad";
  const offline = !navigator.onLine;
  const lifetime = new AbortController();
  let left = Math.round(retryDelayMs(attempt) / 1000);
  const status = h("p", { class: "tiny subtle tnum centered" });
  const again = () => {
    if (lifetime.signal.aborted) return;
    lifetime.abort();
    retry();
  };
  const tick = () => {
    status.textContent = navigator.onLine ? `Trying again in ${left} s…` : "Waiting for a connection…";
  };
  const timer = setInterval(() => {
    if (!status.isConnected) return lifetime.abort();
    left -= 1;
    if (left <= 0 && navigator.onLine) again();
    else tick();
  }, 1000);
  lifetime.signal.addEventListener("abort", () => clearInterval(timer));
  addEventListener("online", again, { signal: lifetime.signal });
  document.addEventListener("visibilitychange", () => !document.hidden && again(), { signal: lifetime.signal });
  tick();
  replace(
    root,
    solo(
      hero(
        offline ? "You're offline." : "Galahad can't be reached just now.",
        offline ? "The app is cached on this device; your fleet's live data returns when you reconnect." : "The node may be restarting, or your tailnet may be down. This page keeps trying.",
      ),
      h(
        "section",
        { class: "card" },
        callout("quiet", message, { icon: offline ? "offline" : "alert" }),
        h("div", { class: "row centered" }, button("Try again now", { variant: "primary", icon: "retry", onClick: again })),
        status,
      ),
      footer(),
    ),
  );
}

/** The browser's storage didn't answer: the key is almost certainly still there, so pairing again is the wrong advice. */
export function renderKeyStoreUnavailable(root: HTMLElement, message: string): void {
  document.title = "Key unavailable · Galahad";
  replace(
    root,
    solo(
      hero("This browser's key can't be read just now.", "Its storage didn't answer. The key itself is almost certainly fine: reloading usually brings it back."),
      h(
        "section",
        { class: "card" },
        callout("quiet", message, { icon: "key" }),
        h("p", { class: "small muted" }, "Don't pair this browser again yet: a new pairing would replace its key. If reloading doesn't help, close the app completely and open it again."),
        h("div", { class: "row centered" }, button("Reload", { variant: "primary", icon: "retry", onClick: () => location.reload() })),
      ),
      footer(),
    ),
  );
}

export function renderClockSkew(root: HTMLElement, skewMs: number, retry: () => void): void {
  document.title = "Check the clock · Galahad";
  const minutes = Math.max(1, Math.round(Math.abs(skewMs) / 60_000));
  replace(
    root,
    solo(
      hero("This device's clock is off.", `It's about ${minutes} minute${minutes === 1 ? "" : "s"} ${skewMs > 0 ? "ahead of" : "behind"} your node.`),
      h(
        "section",
        { class: "card" },
        h("p", { class: "small muted" }, "Every request is signed with the time, and your node only accepts signatures within a minute of its own clock. Set this device's clock to update automatically, then try again. Your key is fine."),
        h("div", { class: "row centered" }, button("Try again", { variant: "primary", icon: "retry", onClick: retry })),
      ),
      footer(),
    ),
  );
}

export function renderPairFailed(root: HTMLElement, message: string): void {
  replace(root, solo(hero("That invite didn't work.", message), footer()));
}
