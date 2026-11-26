import { NOTIFY_DEFAULTS, NOTIFY_KIND_INFO, NOTIFY_KINDS, NOTIFY_PER_DAY, type NotifyKind, type NotifyPrefs, type NotifyView } from "@galahad/core/notify";
import { type Api, isUnavailable } from "../api.ts";
import { type Ctx, errorMessage } from "../context.ts";
import { clockProblem, digestLine, isIos, keyBytes, lostLine, perDayProblem, PUSH_STATE_TEXT, type PushEnv, type PushState, pushState, pushSync, quietLine, reachCard, reachDismissed, sameKey, todayLine, toTakeDown, WHAT_IS_SENT } from "../lib/push.ts";
import { relativeTime } from "../lib/time.ts";
import { putReachAway, reachPutAway } from "../prefs.ts";
import { busy, button, callout, list, listRow, note as noteLine, section, switchControl } from "../ui/controls.ts";
import { h, replace, type Scope } from "../ui/dom.ts";
import { icon } from "../ui/icons.ts";

/*
 * Settings → Notifications: he comes to you, on this device.
 *
 * Turning it on is your act on this device: the browser's permission is asked only from
 * that tap, never when a page opens. The subscription the browser makes is handed to the
 * node as this device's, and removed when you turn it off here. What he tells you, quiet
 * hours and the day's limit are the node's settings, the same from every device.
 */

/* ---------- the browser's side ---------- */

const capable = (): boolean => isSecureContext && "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
const standalone = (): boolean => matchMedia("(display-mode: standalone)").matches || (navigator as { standalone?: boolean }).standalone === true;

/** The service worker's registration, or null when there isn't one in time (no worker, a private window). */
async function registration(): Promise<ServiceWorkerRegistration | null> {
  if (!capable()) return null;
  return Promise.race([navigator.serviceWorker.ready, new Promise<null>((resolve) => setTimeout(() => resolve(null), 4000))]);
}

async function browserSubscription(): Promise<PushSubscription | null> {
  try {
    return (await (await registration())?.pushManager.getSubscription()) ?? null;
  } catch {
    return null;
  }
}

/** What the node is handed: where this browser's push service takes messages for it, and the two keys they're encrypted to. */
function handOver(sub: PushSubscription): unknown {
  const json = sub.toJSON();
  return { endpoint: json.endpoint, expirationTime: json.expirationTime ?? null, keys: { p256dh: json.keys?.p256dh, auth: json.keys?.auth } };
}

async function readEnv(nodeHasThisDevice: boolean): Promise<PushEnv> {
  const can = capable();
  const sub = can ? await browserSubscription() : null;
  return { capable: can, ios: isIos(navigator), standalone: standalone(), permission: can ? Notification.permission : "default", subscribed: nodeHasThisDevice && sub !== null };
}

/**
 * This device as the card that says he can't reach it reads it, without waiting for the service worker (the Inbox,
 * drawn whole, would wait with it, as long as a first visit takes to start one): whether it's on is the node's word.
 */
function nodeEnv(nodeHasThisDevice: boolean): PushEnv {
  const can = capable();
  return { capable: can, ios: isIos(navigator), standalone: standalone(), permission: can ? Notification.permission : "default", subscribed: nodeHasThisDevice };
}

/**
 * From your tap only: ask the browser's leave, subscribe to this node's key, hand the subscription to the node. `fresh`:
 * this device's was lost, so whatever the browser still holds is dead at its push service and a new one is made.
 */
async function turnOn(api: Api, key: string, signal?: AbortSignal, fresh = false): Promise<"on" | "blocked" | "dismissed"> {
  const permission = await Notification.requestPermission();
  if (permission === "denied") return "blocked";
  if (permission !== "granted") return "dismissed";
  const reg = await registration();
  if (!reg) throw new Error("The app's service worker isn't running yet. Reload the app, then turn this on.");
  let sub = await reg.pushManager.getSubscription();
  // A subscription made for another key (the node has a new one), or a lost one, can't be used: it's replaced.
  if (sub && (fresh || !sameKey(sub.options.applicationServerKey, key))) {
    await sub.unsubscribe();
    sub = null;
  }
  sub ??= await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(key) });
  await api.post("/api/notify/subscribe", handOver(sub), signal);
  return "on";
}

async function turnOff(api: Api, signal?: AbortSignal): Promise<void> {
  await api.post("/api/notify/unsubscribe", {}, signal);
  await (await browserSubscription())?.unsubscribe().catch(() => {});
}

/** This browser's subscription is dropped (it's being forgotten). The node drops its own when the push service says it's gone. */
export async function dropBrowserSubscription(): Promise<void> {
  await (await browserSubscription())?.unsubscribe().catch(() => {});
}

/** The last syncPush under way: the card below waits for it, so a subscription it is making again isn't offered too. */
let syncing: Promise<void> = Promise.resolve();

/**
 * What this browser still shows whose matter was answered, dismissed, cleared or lapsed, on this device or another (the
 * node's `withdrawn`): taken down. Asks nothing of you; a convenience, so a failure is silent.
 */
async function takeDown(reg: ServiceWorkerRegistration, withdrawn: readonly string[] | undefined): Promise<void> {
  if (!withdrawn?.length) return;
  try {
    const shown = await reg.getNotifications();
    const tags = new Set(toTakeDown(shown, withdrawn));
    for (const n of shown) if (tags.has(n.tag)) n.close();
  } catch {
    /* nothing shown, or a browser that can't list them */
  }
}

/** When the app comes back into view: what was answered elsewhere meanwhile is taken down here (at most once a minute). */
let lastTakeDown = 0;
export async function takeDownWithdrawn(api: Api): Promise<void> {
  if (!capable() || Notification.permission !== "granted" || Date.now() - lastTakeDown < 60_000) return;
  lastTakeDown = Date.now();
  try {
    const reg = await registration();
    if (reg) await takeDown(reg, (await api.get<NotifyView>("/api/notify")).withdrawn);
  } catch {
    /* a convenience */
  }
}

/**
 * When the app opens (and when the browser replaced the subscription): keep the node's copy current. Never asks
 * for permission, and never turns back on what you turned off: if the node no longer lists this device, the
 * browser's subscription is dropped too, so both agree. One the push service dropped (the node says lost: it was
 * on, and you didn't turn it off) is made again and handed over, while the browser's leave still stands: your own
 * choice, restored (lib/push.ts pushSync). A browser that won't make one without a tap leaves it to the card.
 */
export function syncPush(api: Api): Promise<void> {
  syncing = (async () => {
    try {
      if (!capable() || Notification.permission !== "granted") return;
      const reg = await registration();
      if (!reg) return;
      let sub = await reg.pushManager.getSubscription();
      const view = await api.get<NotifyView>("/api/notify");
      lastTakeDown = Date.now();
      await takeDown(reg, view.withdrawn);
      const action = pushSync({ subscribed: view.subscribed === true, lost: !!view.lost, browser: sub !== null, sameKey: sameKey(sub?.options.applicationServerKey, view.key) });
      if (action === "none") return;
      if (action === "drop") {
        await sub?.unsubscribe().catch(() => {});
        return;
      }
      if (action === "make") {
        // (A lost one is dead at its push service, and one made for another key can't be used: neither is handed back.)
        await sub?.unsubscribe().catch(() => {});
        sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(view.key) });
      }
      await api.post("/api/notify/subscribe", handOver(sub!));
    } catch {
      /* a convenience: Settings, and the card below, show where things stand */
    }
  })();
  return syncing;
}

/* ---------- the card that says he can't reach this device ---------- */

/**
 * At the top of "Galahad asks you" and the Inbox, while it matters (lib/push.ts reachCard): he can't reach this device
 * when Galahad is closed, why, and the one thing to do from your tap, then a test to see one arrive. Not now puts it
 * away for a week, on this device. `changed`: it was shown or hidden (the place it's in is drawn again).
 */
export function reachNote(ctx: Ctx, scope: Scope, changed: () => void = () => {}): { el: HTMLElement; shown: () => boolean } {
  const el = h("div", { class: "reach-note", hidden: true, "aria-busy": "true" });
  let card: ReturnType<typeof reachCard> = null;
  let key = "";
  let on = false;
  let note: { text: string; wrong: boolean } | null = null;

  const draw = (): void => {
    const was = !el.hidden;
    el.removeAttribute("aria-busy");
    el.hidden = !card && !on;
    const said = note ? h("div", { class: note.wrong ? "error" : "tiny subtle", role: note.wrong ? "alert" : "status" }, note.text) : null;
    if (on) {
      const test = button("Send a test", { size: "sm", icon: "bell", onClick: () => void busy(test, sendTest) });
      replace(el, callout("ok", h("div", { class: "stack tight" }, h("div", {}, "He can reach this device when Galahad is closed. Send a test to see one arrive."), said), { title: "Notifications are on", actions: test }));
    } else if (card) {
      const turnOn = card.action === "turn-on" ? button("Turn on notifications", { size: "sm", variant: "primary", icon: "bell", onClick: () => void busy(turnOn!, flip) }) : null;
      const later = button("Not now", { size: "sm", variant: "ghost", onClick: () => putAway() });
      replace(el, callout("warn", h("div", { class: "stack tight" }, card.detail ? h("div", {}, card.detail) : null, said), { title: card.title, icon: "bell", actions: [turnOn, later] }));
    } else replace(el);
    if (was !== !el.hidden) changed();
  };

  async function look(): Promise<void> {
    let view: NotifyView | null = null;
    try {
      await syncing;
      view = await ctx.api.get<NotifyView>("/api/notify", scope.signal);
    } catch {
      view = null; // a node from before notifications, or not answering: nothing to say here (Settings says more)
    }
    if (scope.disposed) return;
    card = reachDismissed(reachPutAway(), Date.now()) ? null : reachCard(nodeEnv(view?.subscribed === true), view);
    key = view?.key ?? key;
    draw();
  }

  async function flip(): Promise<void> {
    try {
      const outcome = await turnOn(ctx.api, key, scope.signal, card?.why === "lost");
      if (outcome === "on") {
        on = true;
        note = null;
      } else note = outcome === "blocked" ? null : { text: "Your browser didn't give its leave, so nothing changed. Tap again when you'd like to be asked.", wrong: false };
    } catch (error) {
      if (scope.disposed) return;
      note = { text: `Couldn't turn them on: ${errorMessage(error)}`, wrong: true };
    }
    if (scope.disposed) return;
    if (on) draw();
    else await look();
  }

  async function sendTest(): Promise<void> {
    try {
      const { sent } = await ctx.api.post<{ sent: { device: string; ok: boolean; error: string | null }[] }>("/api/notify/test", {}, scope.signal);
      note = sent[0]?.ok ? { text: "Sent. It should be on this device in a moment (look in the notification centre if the app is open).", wrong: false } : { text: `It didn't arrive: ${sent[0]?.error ?? "no device was reached"}.`, wrong: true };
    } catch (error) {
      if (scope.disposed) return;
      note = { text: errorMessage(error), wrong: true };
    }
    if (!scope.disposed) draw();
  }

  function putAway(): void {
    putReachAway();
    card = null;
    on = false;
    draw();
  }

  // (A device that can't read the mind couldn't open what a notification points to: nothing to offer it.)
  if (ctx.can("mind:read")) void look();
  else draw();
  return { el, shown: () => !el.hidden };
}

/* ---------- the section ---------- */

const SWITCHABLE: Record<PushState, boolean> = { unsupported: false, "home-screen": false, blocked: false, off: true, on: true };

export function notificationsSection(ctx: Ctx, scope: Scope): HTMLElement | null {
  // A device that can't read the mind couldn't open anything a notification points to.
  if (!ctx.can("mind:read")) return null;
  const maySet = ctx.can("brain:write");
  // Drawn whole from the first frame, its controls off until the node has said how things stand (the node's defaults
  // meanwhile): nothing under the section moves when it answers.
  const deviceCard = h("div", { class: "card rows" });
  const nodeCards = h("div", { class: "stack" });
  const el = section("Notifications", {}, deviceCard, nodeCards);
  let view: NotifyView | null = null;
  let state: PushState = "off";
  /** What the last thing you did here came to, said under the switch. */
  let note: { text: string; wrong: boolean } | null = null;

  const say = (text: string, wrong = false): void => {
    note = { text, wrong };
  };

  function renderDevice(): void {
    const on = state === "on";
    const me = view?.devices.find((d) => d.device === ctx.identity.device);
    const toggle = switchControl("Notifications on this device", on, (checked) => void flip(checked), {
      hint: !view ? "Looking at this device…" : on && me ? `${PUSH_STATE_TEXT.on} Through ${me.service}, turned on ${relativeTime(me.since)}.` : view.lost && state === "off" ? `${lostLine(view.lost)} Turn this on to have them again.` : PUSH_STATE_TEXT[state],
      disabled: !SWITCHABLE[state] || !view,
    });
    toggle.classList.add("notify-device");
    const test = button("Send a test", { size: "sm", icon: "bell", onClick: () => void busy(test, sendTest) });
    replace(
      deviceCard,
      h("div", { class: "item notify-row", "data-state": state }, toggle),
      on ? h("div", { class: "item center notify-row" }, h("div", { class: "grow tiny subtle" }, me?.lastError ? `The last one didn't arrive: ${me.lastError}.` : "A notification to this device, now, to see that it arrives."), test) : null,
      note ? h("div", { class: "item" }, h("div", { class: note.wrong ? "error" : "tiny subtle", role: note.wrong ? "alert" : "status" }, note.text)) : null,
      h("div", { class: "item" }, icon("shield-check", { size: 16 }), h("div", { class: "grow tiny subtle" }, WHAT_IS_SENT)),
    );
  }

  function renderNode(): void {
    const prefs = view?.prefs ?? NOTIFY_DEFAULTS;
    const ready = view !== null;
    const may = maySet && ready;
    const locked = maySet ? null : "This device can't change these: it was paired without the brain:write scope.";
    const kindRow = (kind: NotifyKind) =>
      h("div", { class: "item notify-row" }, switchControl(NOTIFY_KIND_INFO[kind].label, prefs.kinds[kind], (checked) => void save({ kinds: { [kind]: checked } }), { hint: NOTIFY_KIND_INFO[kind].hint, disabled: !may }));

    const from = h("input", { class: "input notify-time", type: "time", value: prefs.quiet.from, disabled: !may || !prefs.quiet.on, "aria-label": "Quiet hours begin" });
    const to = h("input", { class: "input notify-time", type: "time", value: prefs.quiet.to, disabled: !may || !prefs.quiet.on, "aria-label": "Quiet hours end" });
    const hoursNote = h("div", { class: "tiny subtle", role: "status" }, quietLine(prefs, view?.zone));
    const setClock = (which: "from" | "to", input: HTMLInputElement) => {
      const problem = clockProblem(input.value);
      if (problem) {
        hoursNote.textContent = problem;
        hoursNote.className = "error";
        return;
      }
      if (input.value !== prefs.quiet[which]) void save({ quiet: { [which]: input.value } });
    };
    from.addEventListener("change", () => setClock("from", from));
    to.addEventListener("change", () => setClock("to", to));

    const digest = prefs.digest ?? NOTIFY_DEFAULTS.digest;
    const digestAt = h("input", { class: "input notify-time", type: "time", value: digest.at, disabled: !may || !digest.on, "aria-label": "The digest comes at" });
    const digestNote = h("div", { class: "tiny subtle", role: "status" }, digestLine({ ...prefs, digest }, view?.zone));
    digestAt.addEventListener("change", () => {
      const problem = clockProblem(digestAt.value);
      if (problem) {
        digestNote.textContent = problem;
        digestNote.className = "error";
        return;
      }
      if (digestAt.value !== digest.at) void save({ digest: { at: digestAt.value } });
    });

    const perDay = h("input", { class: "input notify-count", type: "number", inputmode: "numeric", min: NOTIFY_PER_DAY.min, max: NOTIFY_PER_DAY.max, step: 1, value: prefs.perDay, disabled: !may, id: "notify-per-day", "aria-describedby": "notify-per-day-note" });
    const perDayNote = h("div", { class: "tiny subtle", id: "notify-per-day-note", role: "status" }, view ? todayLine(view) : "Nothing sent today (a test doesn't count).");
    perDay.addEventListener("change", () => {
      const problem = perDayProblem(perDay.value);
      if (problem) {
        perDayNote.textContent = problem;
        perDayNote.className = "error";
        return;
      }
      if (Number(perDay.value) !== prefs.perDay) void save({ perDay: Number(perDay.value) });
    });

    replace(
      nodeCards,
      h("div", { class: "stack tight" }, h("div", { class: "label" }, "What he tells you"), h("div", { class: "card rows" }, ...NOTIFY_KINDS.map(kindRow)), noteLine("He's silent when there's nothing to say: “all quiet” is never a notification.")),
      h(
        "div",
        { class: "stack tight" },
        h("div", { class: "label" }, "When he stays silent"),
        h(
          "div",
          { class: "card rows" },
          h(
            "div",
            { class: "item notify-row wrap" },
            switchControl("Quiet hours", prefs.quiet.on, (checked) => void save({ quiet: { on: checked } }), { hint: "Everything but an alert waits until they end.", disabled: !may }),
            h("div", { class: "notify-hours" }, from, h("span", { class: "tiny subtle" }, "to"), to),
          ),
          h("div", { class: "item" }, hoursNote),
          h(
            "div",
            { class: "item notify-row wrap" },
            switchControl("The day's digest", digest.on, (checked) => void save({ digest: { on: checked } }), { hint: "What he didn't buzz you for, once a day, quietly.", disabled: !may }),
            h("div", { class: "notify-hours" }, digestAt),
          ),
          h("div", { class: "item" }, digestNote),
          listRow({ title: h("label", { for: "notify-per-day" }, "At most a day"), sub: "So a fault can't buzz you all day. News alone has a share of its own, so it never spends what an ask needs; the last one or two are kept for alerts; when what needs you reaches the limit, one message says so.", trail: perDay, wrap: true }),
          h("div", { class: "item" }, perDayNote),
        ),
        locked ? noteLine(locked) : null,
      ),
      view?.devices.length
        ? h(
            "div",
            { class: "stack tight" },
            h("div", { class: "label" }, "Devices he can reach"),
            list(
              view.devices.map((d) =>
                listRow({
                  lead: /iPhone|iPad|Android|phone/i.test(d.name) ? "phone" : "laptop",
                  title: [d.name, d.device === ctx.identity.device ? h("span", { class: "subtle" }, " · this device") : null],
                  sub: d.lastError ? `Not arriving: ${d.lastError}` : `Through ${d.service}, turned on ${relativeTime(d.since)}`,
                }),
              ),
            ),
          )
        : null,
    );
  }

  const render = (): void => {
    renderDevice();
    renderNode();
  };

  async function refresh(): Promise<void> {
    try {
      view = await ctx.api.get<NotifyView>("/api/notify", scope.signal);
    } catch (error) {
      if (scope.disposed) return;
      // A node from before notifications: nothing to set here yet.
      if (isUnavailable(error)) {
        el.hidden = true;
        return;
      }
      say(`Couldn't read the notification settings: ${errorMessage(error)}`, true);
    }
    state = pushState(await readEnv(view?.subscribed === true));
    if (!scope.disposed) render();
  }

  async function flip(on: boolean): Promise<void> {
    if (!view) return;
    try {
      if (on) {
        const outcome = await turnOn(ctx.api, view.key, scope.signal, !!view.lost);
        if (outcome === "on") say("On. Send a test to see one arrive.");
        else if (outcome === "dismissed") say("Your browser didn't give its leave, so nothing changed. Turn this on again when you'd like to be asked.");
        else note = null;
      } else {
        await turnOff(ctx.api, scope.signal);
        say("Off. He won't reach this device until you turn it on again.");
      }
    } catch (error) {
      if (scope.disposed) return;
      say(`Couldn't turn notifications ${on ? "on" : "off"}: ${errorMessage(error)}`, true);
    }
    if (!scope.disposed) await refresh();
  }

  async function sendTest(): Promise<void> {
    try {
      const { sent } = await ctx.api.post<{ sent: { device: string; ok: boolean; error: string | null }[] }>("/api/notify/test", {}, scope.signal);
      const mine = sent[0];
      if (mine?.ok) say("Sent. It should be on this device in a moment (look in the notification centre if the app is open).");
      else say(`It didn't arrive: ${mine?.error ?? "no device was reached"}.`, true);
    } catch (error) {
      if (scope.disposed) return;
      say(errorMessage(error), true);
    }
    if (!scope.disposed) await refresh();
  }

  async function save(change: { kinds?: Partial<Record<NotifyKind, boolean>>; quiet?: Partial<NotifyPrefs["quiet"]>; perDay?: number; digest?: Partial<NotifyPrefs["digest"]> }): Promise<void> {
    try {
      const { prefs } = await ctx.api.post<{ prefs: NotifyPrefs }>("/api/notify", change, scope.signal);
      if (view) view = { ...view, prefs, today: { ...view.today, limit: prefs.perDay } };
    } catch (error) {
      if (scope.disposed) return;
      say(`Couldn't save that: ${errorMessage(error)}`, true);
    }
    if (!scope.disposed) render();
  }

  render();
  void refresh();
  return el;
}
