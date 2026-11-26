import { describe, expect, test } from "bun:test";
import { NOTIFY_DEFAULTS } from "@galahad/core/notify";
import { clockProblem, digestLine, isIos, keyBytes, pairingNote, perDayProblem, PUSH_STATE_TEXT, type PushEnv, pushState, pushSync, quietLine, REACH_DISMISS_MS, reachCard, reachDismissed, readOpenMessage, sameKey, todayLine, toTakeDown } from "./push.ts";

/* Notifications on this device: the state it's in, and the checks the Settings fields make. */

const env = (over: Partial<PushEnv> = {}): PushEnv => ({ capable: true, ios: false, standalone: false, permission: "default", subscribed: false, ...over });

describe("which state this device is in", () => {
  test("off until you turn it on; on only with the browser's leave and a subscription the node keeps", () => {
    expect(pushState(env())).toBe("off");
    expect(pushState(env({ permission: "granted" }))).toBe("off");
    expect(pushState(env({ permission: "granted", subscribed: true }))).toBe("on");
    // The node may still list this device while the browser has taken its leave back.
    expect(pushState(env({ permission: "default", subscribed: true }))).toBe("off");
  });

  test("blocked when the browser said no; unsupported when it can't at all", () => {
    expect(pushState(env({ permission: "denied" }))).toBe("blocked");
    expect(pushState(env({ permission: "denied", subscribed: true }))).toBe("blocked");
    expect(pushState(env({ capable: false }))).toBe("unsupported");
  });

  test("an iPhone or iPad: only from the Home Screen, and the page says how to get there", () => {
    expect(pushState(env({ ios: true, capable: false }))).toBe("home-screen");
    expect(pushState(env({ ios: true, capable: true }))).toBe("home-screen");
    expect(pushState(env({ ios: true, standalone: true, capable: true }))).toBe("off");
    expect(pushState(env({ ios: true, standalone: true, capable: true, permission: "granted", subscribed: true }))).toBe("on");
    // An iPhone on a system from before web push, even on the Home Screen.
    expect(pushState(env({ ios: true, standalone: true, capable: false }))).toBe("unsupported");
    expect(isIos({ userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X)" })).toBe(true);
    expect(isIos({ userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)", platform: "MacIntel", maxTouchPoints: 5 })).toBe(true);
    expect(isIos({ userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)", platform: "MacIntel", maxTouchPoints: 0 })).toBe(false);
    expect(isIos({ userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Edg/141.0" })).toBe(false);
  });
});

describe("before pairing", () => {
  test("an iPhone in Safari is told to put Galahad on the Home Screen first; the app there, that it pairs on its own", () => {
    // In Safari: the Home Screen app keeps its own key, so pairing the tab first would mean pairing twice.
    expect(pairingNote({ ios: true, standalone: false })).toBe("home-screen-first");
    expect(pairingNote({ ios: true, standalone: true })).toBe("pair-this-app");
    expect(pairingNote({ ios: false, standalone: true })).toBe("pair-this-app");
    // A desktop browser, or Android's, pairs where it is.
    expect(pairingNote({ ios: false, standalone: false })).toBeNull();
  });
});

describe("a tapped notification, as the service worker tells an open page", () => {
  test("one of the app's places, and a kept chat for the chat page; anything else is no message of ours", () => {
    const chat = "cv_1234567890123456789012";
    expect(readOpenMessage({ type: "galahad:open", open: "inbox", conversation: null })).toEqual({ route: "inbox" });
    expect(readOpenMessage({ type: "galahad:open", open: "chat", conversation: chat })).toEqual({ route: "chat", conversation: chat });
    // A chat only goes with the chat page, and only when it reads as one.
    expect(readOpenMessage({ type: "galahad:open", open: "overview", conversation: chat })).toEqual({ route: "overview" });
    expect(readOpenMessage({ type: "galahad:open", open: "chat", conversation: "<script>" })).toEqual({ route: "chat" });
    for (const bad of [null, "galahad:open", { type: "galahad:updated" }, { type: "galahad:open", open: "vault" }, { type: "galahad:open", open: "journal" }, { type: "galahad:open", open: "https://evil.example" }, { type: "galahad:open" }]) {
      expect(readOpenMessage(bad)).toBeNull();
    }
  });
});

describe("the node's key", () => {
  test("base64url to the bytes a browser takes, and whether a subscription was made for it", () => {
    const key = "BA1Hxzyi1RUM1b5wjxsn7nGxAszw2u61m164i3MrAIxHF6YK5h4SDYic-dRuU_RCPCfA5aq9ojSwk5Y2EmClBPs";
    const bytes = keyBytes(key);
    expect(bytes.length).toBe(65);
    expect(bytes[0]).toBe(4);
    expect(sameKey(bytes.buffer, key)).toBe(true);
    const other = bytes.slice();
    other[10]! ^= 1;
    expect(sameKey(other.buffer, key)).toBe(false);
    expect(sameKey(null, key)).toBe(false);
    expect(sameKey(bytes.slice(0, 64).buffer, key)).toBe(false);
  });
});

describe("when he can't reach this device", () => {
  const lost = { at: Date.UTC(2026, 10, 18, 12), service: "Apple", why: "Apple's push service says this subscription is gone (410)" };
  const nobody = { subscribed: false, lost: null, reachable: 0 };
  const title = "He can't reach this device when Galahad is closed.";

  test("a card only while it matters: this device's were lost, or no device of yours can be reached", () => {
    expect(reachCard(env(), nobody)).toEqual({ why: "off", title, detail: null, action: "turn-on" });
    expect(reachCard(env({ permission: "granted" }), { ...nobody, lost, reachable: 2 })).toEqual({ why: "lost", title, detail: "They were on until 18 Nov: Apple's push service stopped taking them.", action: "turn-on" });
    // Off here while another device reaches you: your choice, not nagged.
    expect(reachCard(env(), { ...nobody, reachable: 1 })).toBeNull();
    // On here (or the node can't say: a terminal, a node from before this, not asked yet): nothing to show.
    expect(reachCard(env({ permission: "granted", subscribed: true }), { subscribed: true, lost: null, reachable: 1 })).toBeNull();
    expect(reachCard(env(), { subscribed: null, lost: null, reachable: 0 })).toBeNull();
    expect(reachCard(env(), { subscribed: false })).toBeNull();
    expect(reachCard(env(), null)).toBeNull();
  });

  test("where a tap here can't turn them on, it says what can; a browser that can't be reached at all is offered nothing", () => {
    expect(reachCard(env({ permission: "denied" }), { ...nobody, lost })).toEqual({ why: "blocked", title, detail: "Notifications are blocked for this site in your browser: allow them in its settings for this site, then turn them on here.", action: null });
    expect(reachCard(env({ ios: true }), nobody)).toEqual({ why: "home-screen", title, detail: PUSH_STATE_TEXT["home-screen"], action: null });
    expect(reachCard(env({ capable: false }), nobody)).toBeNull();
    // A stand-in push service a test allowed is named as one.
    expect(reachCard(env(), { ...nobody, lost: { ...lost, service: "a push service you allowed" } })!.detail).toBe("They were on until 18 Nov: the push service you allowed stopped taking them.");
  });

  test("put away for a week (Not now), then shown again while it still matters", () => {
    const now = Date.UTC(2026, 10, 25, 12);
    expect(reachDismissed(null, now)).toBe(false);
    expect(reachDismissed(now - 6 * 24 * 3600_000, now)).toBe(true);
    expect(reachDismissed(now - REACH_DISMISS_MS, now)).toBe(false);
    // A time from a clock set ahead doesn't hide it for good.
    expect(reachDismissed(now + 3600_000, now)).toBe(false);
  });

  test("when the app opens: a lost subscription is made again, asking nothing; what you turned off stays off", () => {
    // Lost: a new one (never the dead one handed back), and only with the browser's leave, which syncPush checks first.
    expect(pushSync({ subscribed: false, lost: true, browser: true, sameKey: true })).toBe("make");
    expect(pushSync({ subscribed: false, lost: true, browser: false, sameKey: false })).toBe("make");
    // Turned off (here, from a terminal, or never on): the browser's copy goes too, so both agree.
    expect(pushSync({ subscribed: false, lost: false, browser: true, sameKey: true })).toBe("drop");
    expect(pushSync({ subscribed: false, lost: false, browser: false, sameKey: false })).toBe("none");
    // On: kept current; made again for a node's new key; nothing to hand over without the browser's own.
    expect(pushSync({ subscribed: true, lost: false, browser: true, sameKey: true })).toBe("hand-over");
    expect(pushSync({ subscribed: true, lost: false, browser: true, sameKey: false })).toBe("make");
    expect(pushSync({ subscribed: true, lost: false, browser: false, sameKey: false })).toBe("none");
  });
});

describe("the settings' own checks, before anything is sent", () => {
  test("a time of day and a day's limit", () => {
    expect(clockProblem("22:00")).toBeNull();
    expect(clockProblem("07:05")).toBeNull();
    for (const bad of ["24:00", "7:00", "22.00", "", "10pm"]) expect(clockProblem(bad)).toBe("A time of day, like 22:00.");
    expect(perDayProblem("12")).toBeNull();
    expect(perDayProblem(" 1 ")).toBeNull();
    for (const bad of ["0", "51", "3.5", "-2", "many", ""]) expect(perDayProblem(bad)).toBe("A whole number from 1 to 50.");
  });

  test("in a line: quiet hours, and today", () => {
    expect(quietLine({ ...NOTIFY_DEFAULTS, quiet: { ...NOTIFY_DEFAULTS.quiet, tz: "Europe/Copenhagen" } })).toBe("From 22:00 to 07:00, Europe/Copenhagen time, everything but an alert waits; then one message says what waited.");
    expect(quietLine({ ...NOTIFY_DEFAULTS, quiet: { ...NOTIFY_DEFAULTS.quiet, on: false } })).toBe("No quiet hours: he tells you whenever it happens.");
    // Read in the zone your devices say, when the node says it is another than the setting's.
    expect(quietLine({ ...NOTIFY_DEFAULTS, quiet: { ...NOTIFY_DEFAULTS.quiet, tz: "Europe/London" } }, "Europe/Copenhagen")).toBe("From 22:00 to 07:00, Europe/Copenhagen time, everything but an alert waits; then one message says what waited.");
    expect(digestLine({ ...NOTIFY_DEFAULTS, quiet: { ...NOTIFY_DEFAULTS.quiet, tz: "America/New_York" } })).toBe("At 08:00, America/New York time, one quiet message says what happened that he didn't buzz you for, and what still waits.");
    expect(digestLine({ ...NOTIFY_DEFAULTS, digest: { on: false, at: "08:00" } })).toBe("No digest: what he doesn't buzz you for waits in your Inbox.");
    expect(todayLine({ today: { day: "2026-11-12", sent: [], count: 0, limit: 12 }, quiet: false, held: 0 })).toBe("Nothing sent today (a test doesn't count).");
    expect(todayLine({ today: { day: "2026-11-12", sent: [], count: 3, limit: 12 }, quiet: true, held: 2 })).toBe("3 of 12 sent today; 2 things wait for quiet hours to end.");
    expect(todayLine({ today: { day: "2026-11-12", sent: [], count: 3, limit: 12 }, quiet: true, held: 1 })).toBe("3 of 12 sent today; 1 thing waits for quiet hours to end.");
  });
});

describe("what was answered elsewhere", () => {
  test("is taken down where it's still shown, by its tag, once; nothing else is", () => {
    const shown = [{ tag: "t-a" }, { tag: "t-b" }, { tag: "t-a" }, { tag: "galahad" }];
    expect(toTakeDown(shown, ["t-a", "t-z"])).toEqual(["t-a"]);
    expect(toTakeDown(shown, [])).toEqual([]);
    // A node from before withdrawals says none.
    expect(toTakeDown(shown, undefined)).toEqual([]);
  });
});

