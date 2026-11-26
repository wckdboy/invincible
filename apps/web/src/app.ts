import { ApiError, apiFor, setUnauthorizedHandler } from "./api.ts";
import { errorMessage } from "./context.ts";
import { type BrowserIdentity, createIdentity, KeyStoreUnavailable, loadIdentity } from "./identity.ts";
import { syncThemeColor } from "./prefs.ts";
import { renderClockSkew, renderInsecure, renderKeyStoreUnavailable, renderPairFailed, renderRevoked, renderUnreachable, renderWelcome } from "./screens.ts";
import { openLink } from "./live.ts";
import { renderShell } from "./shell.ts";
import type { WhoAmI } from "./types.ts";
import { toast } from "./ui/toast.ts";
import { readBankCallback } from "./lib/bank.ts";
import { handBankCallback } from "./views/bank.ts";
import { handShared } from "./views/chat.ts";
import { isShare, readShare } from "./lib/share.ts";
import { syncPush, takeDownWithdrawn } from "./views/notifications.ts";

/*
 * Boot: secure context → device key → (pairing | welcome | the app).
 * The pairing flow is a separate bundle (/pair.js, with the invite schema),
 * fetched only when a #pair= link is opened; daily use never loads it.
 */

const PAIR_MODULE = "/pair.js";
/** Signed requests are only accepted within a minute of the node's clock. */
const SKEW_MS = 50_000;
/** How long opening the app waits for the node before saying it can't reach it (and trying again on its own). */
const WHOAMI_TIMEOUT_MS = 12_000;
/** Times in a row the node couldn't be reached, for the back-off of the next try. */
let unreachable = 0;

/** Once per page: theme colour, service worker and its "new version" message. */
function init(): void {
  // iOS shows a control's pressed look (:active) only where something listens for touches: this listens, and does nothing.
  document.addEventListener("touchstart", () => {}, { passive: true });
  syncThemeColor();
  matchMedia("(prefers-color-scheme: dark)").addEventListener("change", syncThemeColor);
  if (!("serviceWorker" in navigator) || !isSecureContext) return;
  let offered = false;
  navigator.serviceWorker.addEventListener("message", (event: MessageEvent) => {
    if (offered || (event.data as { type?: string } | null)?.type !== "galahad:updated") return;
    offered = true;
    toast("A new version of Galahad is ready", { action: { label: "Reload", run: () => location.reload() }, duration: 0 });
  });
  navigator.serviceWorker.register("/sw.js", { scope: "/" }).catch(() => {
    /* offline shell is a convenience, not a requirement */
  });
}

/** A 401 means a revoked or unknown key, unless this device's clock is simply wrong. */
function renderRefused(root: HTMLElement, error: ApiError): void {
  const skew = error.serverTime === null ? 0 : Date.now() - error.serverTime;
  if (Math.abs(skew) > SKEW_MS) renderClockSkew(root, skew, () => location.reload());
  else renderRevoked(root);
}

/**
 * The bank's redirect back (/bank/callback?code=…&state=…): read once, then the code
 * leaves the address bar and history at once; the Bank page finishes it.
 */
const bankReturn = location.pathname === "/bank/callback" ? readBankCallback(location.search) : null;
if (bankReturn) history.replaceState(null, "", "/#/bank");

/** Something shared from another app (Android's share sheet: lib/share.ts): read once, and the chat is where it lands. */
const shared = location.pathname === "/" && isShare(location.search) ? readShare(location.search) : null;
if (location.pathname === "/" && isShare(location.search)) history.replaceState(null, "", "/#/chat");

async function boot(): Promise<void> {
  const root = document.getElementById("app")!;
  if (!isSecureContext || !crypto?.subtle) {
    renderInsecure(root);
    return;
  }

  let identity: BrowserIdentity | null;
  try {
    identity = await loadIdentity();
  } catch (error) {
    // Never treat an unreadable key store as "not paired": pairing would write a new key over the enrolled one.
    if (error instanceof KeyStoreUnavailable) {
      renderKeyStoreUnavailable(root, errorMessage(error.cause));
      return;
    }
    throw error;
  }
  const inviteText = location.hash.match(/[#&]pair=([A-Za-z0-9._-]+)/)?.[1];
  if (inviteText) {
    if (identity?.enrolled) {
      history.replaceState(null, "", `${location.pathname}${location.search}`);
    } else {
      identity ??= await createIdentity();
      try {
        const { renderPairing } = (await import(PAIR_MODULE)) as typeof import("./pair.ts");
        renderPairing(root, identity, inviteText, () => void boot());
      } catch {
        // A cached app may point at a pairing bundle the node has since replaced.
        renderPairFailed(root, "Galahad was just updated. Reload this page to continue pairing.");
      }
      return;
    }
  }
  if (!identity?.enrolled && bankReturn) {
    toast("This browser isn't paired with Galahad", { description: "It can't finish connecting the bank. Pair it first, then connect again from here.", duration: 0 });
  }
  if (!identity?.enrolled) {
    // A pasted invite: the way an app on the Home Screen pairs (links open in the browser, not in it).
    renderWelcome(root, identity, (invite) => {
      history.replaceState(null, "", `${location.pathname}${location.search}#pair=${invite}`);
      void boot();
    });
    return;
  }

  const api = apiFor(identity);
  setUnauthorizedHandler(() => {});
  // The node's live stream (live.ts), opened beside the first question: by the time the shell is drawn it has said
  // what it tells of, and what the shell shows is read once, after that.
  const link = openLink(api);
  let whoami: WhoAmI;
  try {
    whoami = await api.get<WhoAmI>("/api/whoami", AbortSignal.timeout(WHOAMI_TIMEOUT_MS));
    unreachable = 0;
  } catch (error) {
    link.stop();
    if (error instanceof ApiError && error.status === 401) renderRefused(root, error);
    else {
      const timedOut = error instanceof DOMException && error.name === "TimeoutError";
      renderUnreachable(root, timedOut ? `No answer from ${location.host} within ${WHOAMI_TIMEOUT_MS / 1000} s.` : errorMessage(error), () => void boot(), unreachable++);
    }
    return;
  }
  if (bankReturn) handBankCallback(bankReturn);
  if (shared) handShared(shared);
  // Notifications: the node's copy of this device's subscription is kept current (never asks, never turns on what you
  // turned off; one its push service dropped is made again). Begun before the views, whose card says he can't reach
  // this device only once this is done.
  void syncPush(api);
  // What was answered on another device meanwhile is taken down here when the app is looked at again.
  document.addEventListener("visibilitychange", () => void (!document.hidden && takeDownWithdrawn(api)));
  const shell = renderShell(root, { api, identity, whoami, link });

  // One refused request isn't proof of revocation: ask once more before leaving the app.
  let state: "ok" | "checking" | "refused" = "ok";
  setUnauthorizedHandler(() => {
    if (state !== "ok") return;
    state = "checking";
    api
      .get<WhoAmI>("/api/whoami")
      .then(() => {
        state = "ok";
      })
      .catch((error: unknown) => {
        if (error instanceof ApiError && error.status === 401) {
          state = "refused";
          shell.dispose();
          renderRefused(root, error);
        } else state = "ok";
      });
  });
}

init();
void boot();
