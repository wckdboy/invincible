import { b64u, type NotifyPayload, notifyReach, tagOf, zonedParts } from "../../packages/core/src/index.ts";
import type { MindStore } from "../../packages/mind/src/index.ts";
import { FAILING_AFTER, NotifyService, type NotifySources } from "../../packages/node/src/notify.ts";
import { NotifyStore, type Subscription } from "../../packages/node/src/notify-store.ts";
import type { PushDelivery, PushOutcome, PushTarget } from "../../packages/node/src/push-send.ts";
import type { LiveTurn } from "../../packages/node/src/turns.ts";
import { pushSync } from "../../apps/web/src/lib/push.ts";
import { intBelow, rng, subSeed } from "../lib.ts";

/*
 * A week of notifications, in virtual time (docs/BENCHMARKS.md, notify): the real rules (core's notify.ts) and the real
 * notifier (NotifyService, with its own push.db in memory) look every virtual minute at what a node holds, while a
 * seeded week happens to it: approvals and keys he asks for, his own looks (some ending by asking you), chats you left
 * him working in, CI failures a knight is already fixing and ones that are yours, the tells of a loop and a rule, an
 * outcome's reports and questions, a node that goes offline, an alert in the night, and knights' tasks that end.
 *
 * The owner lives in Copenhagen and the node in London, as the owner's do. They have two devices: the iPhone app and the
 * web app on a laptop. Midweek the iPhone's token goes (Apple answers that it no longer knows it), and on Friday the
 * laptop's push service fails for six hours. What the apps do about it is what they do: the web app makes its
 * subscription again when it opens (lib/push.ts pushSync); the iPhone app does whatever its build does (`phoneHeals`).
 *
 * A stand-in owner answers an ask only once it was delivered to them: they open the app on the device that buzzed
 * 2 to 40 minutes later in their waking hours (07:00 to 23:00 their time), and answer every ask a delivery told them
 * of. They also open the iPhone app each morning and the laptop's on weekday mornings. Nothing else brings them: an
 * ask never delivered is never answered.
 *
 * Only the counting is the simulation's: whether a delivery sounded is what the node asked of the platforms (a push
 * of Urgency low is passive everywhere: no sound, no banner over what you're doing).
 */

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
/** Monday 23 November 2026, 00:00 in Copenhagen. */
export const SIM_START = Date.parse("2026-11-22T23:00:00Z");
export const OWNER_ZONE = "Europe/Copenhagen";
export const NODE_ZONE = "Europe/London";
const PHONE = "c_sim-phone";
const LAPTOP = "c_sim-laptop";
const SCOPES = ["mind:read", "mind:write", "chat", "vault:read", "brain:write", "fleet:admin", "connect", "bank:read"];

export interface NotifySimOptions {
  seed: number;
  /** How many days (a week by default). */
  days?: number;
}

export interface NotifySimResult {
  /** Deliveries that sounded (the node asked for more than Urgency low), tests and the day's-limit message aside. */
  buzzes: number;
  /** Every delivery that arrived, quiet or not. */
  delivered: number;
  /** Knights' tasks that ended verified: the north star's denominator. */
  completed: number;
  asks: number;
  answered: number;
  /** Asks that lapsed unanswered (no answer is no). */
  missed: number;
  /** Minutes in which an ask stood and no device of yours could be reached. */
  unreachableMinutes: number;
  /** From an ask to its answer, in virtual minutes, each answered ask. */
  answerMinutes: number[];
  /** Buzzes in the owner's night (22:00 to 07:00 their time) that weren't alerts. */
  nightBuzzes: number;
  /** Buzzes about something that resolved without the owner (a CI failure a knight fixed, a node back online). */
  selfResolvedBuzzes: number;
  /** A notification that replaced another (the same tag) on a device while that one told of an ask still waiting. */
  summaryOverwroteAsk: number;
  /** The same thing told as new again while it stood. */
  duplicates: number;
  /** Buzzes that told of what his own judgment raised (a look or an outcome that ends by asking you). */
  modelBuzzes: number;
  problems: string[];
}

interface Ask {
  key: string;
  at: number;
  /** When it lapses (no answer is no); null: it stands until answered. */
  expires: number | null;
  state: "waiting" | "answered" | "lapsed";
  /** One the owner leaves standing: a connector they don't want yet stands until it lapses, a week on. */
  left?: true;
}

interface Notice {
  key: string;
  severity: "info" | "warn" | "alert";
  title: string;
  source: string;
  dismissed: boolean;
}

interface SimEvent {
  at: number;
  /** Lower first among events of the same minute. */
  order: number;
  run: () => void | Promise<void>;
}

const pad22 = (n: number, prefix: string): string => `${prefix}${String(n).padStart(22, "0")}`;
const localHour = (ms: number): number => {
  const p = zonedParts(ms, OWNER_ZONE);
  return p.hour + p.minute / 60;
};
const awake = (ms: number): boolean => {
  const h = localHour(ms);
  return h >= 7 && h < 23;
};
const night = (ms: number): boolean => {
  const h = localHour(ms);
  return h >= 22 || h < 7;
};
/** The owner's next waking minute at or after `ms`. */
function nextWaking(ms: number): number {
  let t = ms;
  while (!awake(t)) t += MINUTE;
  return t;
}
/** A push of Urgency low: passive on every platform (no sound, no banner over what you're doing). */
const passive = (delivery: PushDelivery): boolean => (delivery.urgency as string) === "low";
/** An instant on day `day` (0: the first) at a local time of day in the owner's zone, in minutes from midnight. */
const localAt = (day: number, minutes: number): number => SIM_START + day * DAY + minutes * MINUTE;

export async function runNotifySim(o: NotifySimOptions): Promise<NotifySimResult> {
  const days = o.days ?? 7;
  const problems: string[] = [];
  let now = SIM_START - HOUR;

  /* ---------- what the node holds ---------- */
  const approvals: { id: string; ask: Ask; class: string }[] = [];
  const keys: { name: string; ask: Ask }[] = [];
  const connectors: { id: string; ask: Ask }[] = [];
  const notices: Notice[] = [];
  const running: LiveTurn[] = [];
  const summaries = new Map<string, { title: string; bank: boolean; waits: { actions: string[]; secrets: string[]; question: boolean } | null }>();
  const asks = new Map<string, Ask>();
  /** What resolved without the owner, and what his own judgment raised. */
  const selfResolved = new Set<string>();
  const modelKeys = new Set<string>();
  let completed = 0;

  const db = new NotifyStore(":memory:", () => now, NODE_ZONE);
  const devices = [
    { id: PHONE, name: "iPhone", kind: "client" as const, scopes: SCOPES },
    { id: LAPTOP, name: "MacBook", kind: "client" as const, scopes: SCOPES },
  ];
  const mind = { activeDevice: (id: string) => devices.find((d) => d.id === id) ?? null, devices: () => devices } as unknown as MindStore;

  /* ---------- the push services, as the devices' are this week ---------- */
  let phoneToken = "ab".repeat(32);
  /** From when Apple no longer knows the phone's token (until the app hands over another). */
  let phoneGone: { from: number; token: string } | null = null;
  const laptopDown = { from: localAt(4, 9 * 60), to: localAt(4, 15 * 60) };
  let laptopEndpoint = 1;
  interface Delivery {
    device: string;
    payload: NotifyPayload;
    delivery: PushDelivery;
    ok: boolean;
  }
  const sends: Delivery[] = [];
  const answer = (device: string, endpoint: string): PushOutcome => {
    if (device === PHONE && phoneGone && now >= phoneGone.from && endpoint === `apns:production:${phoneGone.token}`) {
      return { ok: false, gone: true, status: 410, error: "Apple's push service no longer knows this iPhone for the app (410 Unregistered)", attempts: 1 };
    }
    if (device === LAPTOP && now >= laptopDown.from && now < laptopDown.to) return { ok: false, gone: false, status: 500, error: "Apple's push service answered 500", attempts: 3 };
    return { ok: true, gone: false, status: 201, error: null, attempts: 1 };
  };
  const sender = {
    publicKey: async () => "BHsim",
    send: async (target: PushTarget, payload: NotifyPayload, delivery: PushDelivery): Promise<PushOutcome> => {
      const device = (target as Subscription).device;
      const outcome = answer(device, target.endpoint);
      sends.push({ device, payload, delivery, ok: outcome.ok });
      return outcome;
    },
  };

  const sources: NotifySources = {
    notices: () => notices.map((n) => ({ ...n })),
    actions: () =>
      approvals.map((a) => ({
        id: a.id,
        connector: "dinero",
        tool: "book",
        state: a.ask.state === "waiting" ? "waiting" : a.ask.state === "lapsed" ? "expired" : "approved",
        requestedAt: `${a.ask.at}.0000.n_sim`,
        expires: a.ask.expires!,
        class: a.class,
      })),
    secretRequests: () => keys.filter((k) => k.ask.state === "waiting").map((k) => k.name),
    connectorRequests: () => connectors.filter((c) => c.ask.state === "waiting").map((c) => c.id),
    turns: { running: () => running, view: () => ({ watchers: 0 }) },
    chats: { summary: (id: string) => (summaries.get(id) ?? null) as never },
    quests: { list: () => [], onChange: () => () => {} },
  };
  const service = new NotifyService({ mind, nodeName: "ultra", db, sender, allowed: [], sources, ledger: () => {}, log: () => {}, now: () => now, tickMs: false });

  /* ---------- the owner's apps ---------- */
  const pair = (await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"])) as CryptoKeyPair;
  const p256dh = b64u(new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey)));
  const auth = b64u(new Uint8Array(16).fill(7));
  let laptopBrowserHas = true;
  const laptopSubscription = () => ({ endpoint: `https://web.push.apple.com/sim-laptop-${laptopEndpoint}`, expirationTime: null, keys: { p256dh, auth } });
  service.subscribeApple(PHONE, { token: phoneToken, environment: "production" });
  await service.subscribe(LAPTOP, laptopSubscription());

  /** What each app does when it opens: it asks the node from where it is (each request says its zone, and the node
   * keeps it), then the web app's sync (lib/push.ts); the iPhone app, as its build does. */
  async function appOpens(device: string): Promise<void> {
    service.seen(device, OWNER_ZONE);
    const view = await service.view(device);
    if (device === LAPTOP) {
      const step = pushSync({ subscribed: view.subscribed === true, lost: !!view.lost, browser: laptopBrowserHas, sameKey: true });
      if (step === "drop") laptopBrowserHas = false;
      if (step === "make") {
        laptopEndpoint += 1;
        laptopBrowserHas = true;
      }
      if (step === "make" || step === "hand-over") await service.subscribe(LAPTOP, laptopSubscription());
    } else if (phoneHeals(view)) {
      // Registering with Apple again gives the same token, unless Apple dropped it: then a new one.
      if (phoneGone && phoneToken === phoneGone.token) phoneToken = "cd".repeat(32);
      service.subscribeApple(PHONE, { token: phoneToken, environment: "production" });
    }
  }

  /* ---------- the owner ---------- */
  /** The asks a delivery has told the owner of, when. */
  const known = new Map<string, number>();
  const openAt = new Map<string, number>();
  const answerMinutes: number[] = [];
  /** What each device shows, by tag: the asks each notification told of. */
  const shown = new Map<string, Map<string, Set<string>>>([
    [PHONE, new Map()],
    [LAPTOP, new Map()],
  ]);
  const ownerRandom = rng(subSeed(o.seed, "notify.owner"));

  async function open(device: string): Promise<void> {
    await appOpens(device);
    for (const [key] of known) {
      const ask = asks.get(key);
      if (!ask || ask.state !== "waiting" || ask.left) continue;
      ask.state = "answered";
      answerMinutes.push(Math.round((now - ask.at) / MINUTE));
    }
    // CI failures that are yours: you see them in the Inbox, and take them from there.
    for (const n of notices) if (n.source === "ci" && !selfResolved.has(`notice:${n.key}`)) n.dismissed = true;
    shown.get(device)!.clear();
  }

  /* ---------- the week, drawn from the seed ---------- */
  const events: SimEvent[] = [];
  const at = (when: number, order: number, run: SimEvent["run"]) => events.push({ at: Math.floor(when / MINUTE) * MINUTE, order, run });
  const draw = (label: string) => rng(subSeed(o.seed, `notify.${label}`));
  /** A local minute of the day between two hours, drawn. */
  const between = (random: () => number, fromH: number, toH: number) => Math.floor(fromH * 60 + random() * (toH - fromH) * 60);
  let serial = 0;

  for (let day = 0; day < days; day++) {
    const weekday = day < 5;

    // Approvals: mostly in the day, now and then in the night. Each lapses a day after it's asked.
    const ap = draw(`approvals.${day}`);
    for (let i = 0, n = 1 + intBelow(ap, 3); i < n; i++) {
      const when = localAt(day, ap() < 0.25 ? between(ap, 0, 6) : between(ap, 6, 24));
      const cls = ap() < 0.2 ? "delete" : "outward";
      const id = pad22(++serial, "a_");
      at(when, 1, () => {
        const ask: Ask = { key: `action:${id}`, at: now, expires: now + DAY, state: "waiting" };
        approvals.push({ id, ask, class: cls });
        asks.set(ask.key, ask);
      });
    }
    // A key he asks for, every other day; a connector, once in the week, which you leave standing (it lapses a week on).
    if (day % 2 === 1) {
      const kr = draw(`keys.${day}`);
      const name = `sim-key-${day}`;
      at(localAt(day, between(kr, 8, 20)), 1, () => {
        const ask: Ask = { key: `secret:${name}`, at: now, expires: null, state: "waiting" };
        keys.push({ name, ask });
        asks.set(ask.key, ask);
      });
    }
    if (day === 1) {
      const id = pad22(++serial, "cr_");
      at(localAt(day, 10 * 60 + 20), 1, () => {
        const ask: Ask = { key: `connector:${id}`, at: now, expires: null, state: "waiting", left: true };
        connectors.push({ id, ask });
        asks.set(ask.key, ask);
      });
    }

    // His looks: each a turn of his in a chat of yours that nobody watches; some end by asking you.
    const lk = draw(`looks.${day}`);
    for (let i = 0, n = 4 + intBelow(lk, 5); i < n; i++) {
      const start = localAt(day, between(lk, 6, 24));
      const roll = lk();
      const question = roll < 0.2;
      const waiting = !question && roll < 0.3;
      turn(start, 1 + intBelow(lk, 9), { look: true, question, waiting });
    }
    // Chats you left him working in.
    const ch = draw(`chats.${day}`);
    for (let i = 0, n = 1 + intBelow(ch, 3); i < n; i++) turn(localAt(day, between(ch, 8, 23)), 2 + intBelow(ch, 20), { look: false, question: ch() < 0.15, waiting: false });

    // Knights' tasks that end verified.
    const tk = draw(`tasks.${day}`);
    for (let i = 0, n = 5 + intBelow(tk, 6); i < n; i++) at(localAt(day, between(tk, 0, 24)), 2, () => void (completed += 1));

    // CI failures on weekdays: most go back to the knight whose work it was, who fixes them; some are yours.
    if (weekday) {
      const ci = draw(`ci.${day}`);
      const fixing = ci() < 0.7;
      const key = `ci:sim-${day}`;
      const raised = localAt(day, between(ci, 9, 18));
      // As ci-watch raises it: a note while the knight's fix is under way, a warning when it's yours.
      at(raised, 1, () => raise({ key, severity: fixing ? "info" : "warn", title: `CI failed on owner/repo#${10 + day}`, source: "ci" }));
      if (fixing) {
        selfResolved.add(`notice:${key}`);
        at(raised + (60 + intBelow(ci, 180)) * MINUTE, 0, () => clear(key));
      }
    }

    // A loop that tells you, and a rule of yours.
    const tl = draw(`tells.${day}`);
    for (let i = 0, n = 2 + intBelow(tl, 3); i < n; i++) {
      const key = `tell:boss-mail:${day}-${i}`;
      at(localAt(day, between(tl, 7, 22)), 1, () => {
        raise({ key, severity: "info", title: "boss-mail: a mail from your boss", source: "tell:boss-mail" });
        // The heartbeat keeps five of a loop's tells standing.
        const mine = notices.filter((n) => n.source === "tell:boss-mail");
        if (mine.length > 5) clear(mine[0]!.key);
      });
    }
    if (tl() < 0.6) {
      const key = `rule:pushes:sim-${day}`;
      at(localAt(day, between(tl, 9, 19)), 1, () => raise({ key, severity: "info", title: "Your rule pushes: a command it matches has run", source: "rule:pushes" }));
    }

    // An outcome of his: its daily report (the same key every day), and now and then a question for you.
    const oc = draw(`outcome.${day}`);
    at(localAt(day, 18 * 60 + intBelow(oc, 60)), 1, () => {
      const report = notices.find((n) => n.key === "outcome:out-simulated00:report");
      if (report) report.dismissed = false;
      else raise({ key: "outcome:out-simulated00:report", severity: "info", title: "Books: his daily report", source: "outcome:out-simulated00" });
    });
    if (oc() < 0.4) {
      const key = `outcome:out-simulated00:ask:${day}`;
      modelKeys.add(`notice:${key}`);
      at(localAt(day, between(oc, 9, 21)), 1, () => raise({ key, severity: "warn", title: "Books: a decision for you", source: "outcome:out-simulated00" }));
    }
  }

  // A loop fails on Tuesday evening and is fine by its next run; a server goes offline for two hours on Thursday.
  const fault = draw("faults");
  at(localAt(1, 21 * 60 + intBelow(fault, 50)), 1, () => raise({ key: "loop:nightly", severity: "warn", title: "Loop nightly failed", source: "loop:nightly" }));
  selfResolved.add("notice:loop:nightly");
  at(localAt(2, 3 * 60), 0, () => clear("loop:nightly"));
  at(localAt(3, 14 * 60), 1, () => raise({ key: "node-offline:n_rack", severity: "warn", title: "rack is offline", source: "heartbeat" }));
  selfResolved.add("notice:node-offline:n_rack");
  at(localAt(3, 16 * 60), 0, () => clear("node-offline:n_rack"));
  // A disk nearly full in Saturday's small hours: an alert, which no night holds.
  at(localAt(5, 3 * 60 + 10), 1, () => raise({ key: "disk:n_ultra", severity: "alert", title: "ultra is low on disk", source: "heartbeat" }));
  at(localAt(5, 11 * 60), 0, () => clear("disk:n_ultra"));
  // Wednesday noon: Apple no longer knows the iPhone's token.
  at(localAt(2, 12 * 60), 0, () => void (phoneGone = { from: now, token: phoneToken }));
  // The owner's own habits: the iPhone app every morning, the laptop's on weekday mornings.
  for (let day = 0; day < days; day++) {
    at(localAt(day, 7 * 60 + 30 + intBelow(ownerRandom, 30)), 3, () => schedule(PHONE, now));
    if (day < 5) at(localAt(day, 9 * 60 + intBelow(ownerRandom, 30)), 3, () => schedule(LAPTOP, now));
  }

  function raise(notice: Omit<Notice, "dismissed">): void {
    notices.push({ ...notice, dismissed: false });
  }

  function clear(key: string): void {
    const i = notices.findIndex((n) => n.key === key);
    if (i >= 0) notices.splice(i, 1);
  }

  function turn(start: number, minutes: number, how: { look: boolean; question: boolean; waiting: boolean }): void {
    const id = `t_sim${++serial}`;
    const conversation = pad22(serial, "cv_");
    if (how.look && (how.question || how.waiting)) modelKeys.add(`turn:${id}`);
    let end: () => void = () => {};
    const ended = new Promise<void>((resolve) => (end = resolve));
    const live = {
      id,
      spec: { conversation: { id: conversation, title: how.look ? "Watch the deploy" : "Plan the garden shed", project: null }, ...(how.look ? { look: { set: start - HOUR, note: "look again" } } : {}) },
      state: "working",
      ended,
    } as unknown as LiveTurn;
    at(start, 1, () => {
      summaries.set(conversation, { title: how.look ? "Watch the deploy" : "Plan the garden shed", bank: false, waits: { actions: [], secrets: [], question: how.question } });
      running.push(live);
      service.lookAtTurns();
      // A look that ends waiting on you filed an approval as it ran.
      if (how.waiting) {
        const aid = pad22(++serial, "a_");
        const ask: Ask = { key: `action:${aid}`, at: now, expires: now + DAY, state: "waiting" };
        approvals.push({ id: aid, ask, class: "outward" });
        asks.set(ask.key, ask);
        summaries.get(conversation)!.waits!.actions.push(aid);
      }
    });
    at(start + minutes * MINUTE, 0, () => {
      (live as { state: string }).state = "done";
      running.splice(running.indexOf(live), 1);
      end();
    });
  }

  function schedule(device: string, when: number): void {
    const t = nextWaking(when);
    const already = openAt.get(device);
    if (already === undefined || t < already) openAt.set(device, t);
  }

  events.sort((a, b) => a.at - b.at || a.order - b.order);

  /* ---------- the run: one look a minute ---------- */
  let told = db.told();
  const everTold = new Set<string>(told.keys());
  let buzzes = 0;
  let delivered = 0;
  let nightBuzzes = 0;
  let summaryOverwroteAsk = 0;
  let duplicates = 0;
  let modelBuzzes = 0;
  let unreachableMinutes = 0;
  /** Each buzz, with what was newly told in its look: which resolved without the owner is known only at the end. */
  const buzzed: Set<string>[] = [];
  const salt = () => db.setting("tag-salt") ?? "";

  let next = 0;
  const end = SIM_START + days * DAY;
  for (now = SIM_START; now < end; now += MINUTE) {
    while (next < events.length && events[next]!.at <= now) await events[next++]!.run();
    // A turn's end is told to the notifier as its promise settles.
    await Promise.resolve();
    await Promise.resolve();
    for (const ask of asks.values()) {
      if (ask.state === "waiting" && ask.expires !== null && ask.expires <= now) ask.state = "lapsed";
    }
    for (const [device, when] of [...openAt]) {
      if (when > now) continue;
      openAt.delete(device);
      await open(device);
    }

    const before = told;
    sends.length = 0;
    await service.tick();
    told = db.told();
    // Told as new in this look: a key that wasn't told, or was forgotten and told again (its time is new). An alert told
    // again because it was told only as a warning is the same thing, louder: not new.
    const newly = new Set(
      [...told].filter(([key, row]) => {
        const was = before.get(key);
        return !was || (was.at !== row.at && !(row.alert && !was.alert));
      }).map(([key]) => key),
    );
    for (const key of newly) {
      if (everTold.has(key)) duplicates += 1;
      everTold.add(key);
    }
    const askTags = new Map([...asks.values()].filter((a) => a.state === "waiting").map((a) => [tagOf(a.key, salt()), a.key]));
    const catchUp = tagOf("catch-up", salt());
    for (const d of sends) {
      if (!d.ok) continue;
      delivered += 1;
      const tells = new Set([...newly].filter((key) => asks.get(key)?.state === "waiting"));
      const one = askTags.get(d.payload.tag);
      if (one) tells.add(one);
      if (d.payload.tag === catchUp) for (const a of asks.values()) if (a.state === "waiting" && everTold.has(a.key)) tells.add(a.key);
      for (const key of tells) if (!known.has(key)) known.set(key, now);
      // What it replaced on that device: a notification that told of an ask still waiting, which this one doesn't.
      const screen = shown.get(d.device)!;
      const was = screen.get(d.payload.tag);
      if (was && [...was].some((key) => asks.get(key)?.state === "waiting" && !tells.has(key))) summaryOverwroteAsk += 1;
      screen.set(d.payload.tag, tells);
      const sounded = !passive(d.delivery) && d.payload.kind !== "test" && d.payload.kind !== "limit";
      if (!sounded) continue;
      buzzes += 1;
      if (night(now) && d.payload.title !== "Galahad: alert") nightBuzzes += 1;
      if ([...newly].some((key) => modelKeys.has(key))) modelBuzzes += 1;
      buzzed.push(newly);
      schedule(d.device, now + (2 + intBelow(ownerRandom, 39)) * MINUTE);
    }
    const waiting = [...asks.values()].some((a) => a.state === "waiting");
    if (waiting && !db.subscriptions().some((s) => s.failures < FAILING_AFTER)) unreachableMinutes += 1;
  }

  const all = [...asks.values()];
  const missed = all.filter((a) => a.state === "lapsed").length;
  if (all.some((a) => a.state === "answered" && !known.has(a.key))) problems.push("an ask was answered that was never delivered");
  await service.stop();
  db.close();
  return {
    buzzes,
    delivered,
    completed,
    asks: all.length,
    answered: all.filter((a) => a.state === "answered").length,
    missed,
    unreachableMinutes,
    answerMinutes,
    nightBuzzes,
    selfResolvedBuzzes: buzzed.filter((keys) => [...keys].some((key) => selfResolved.has(key))).length,
    summaryOverwroteAsk,
    duplicates,
    modelBuzzes,
    problems,
  };
}

/**
 * What the iPhone app does with the node's word when it opens (Core/Push.swift, held to core's notifyReach by the
 * vectors): with iOS's leave given, it registers with Apple again and hands the token over while they're on or were lost
 * (Apple's advice, since tokens change). Before 25 November 2026 it registered only when you flipped its switch, so a token
 * Apple dropped stayed dead until you found More → Notifications.
 */
function phoneHeals(view: { subscribed: boolean | null; lost: unknown; reachable: number }): boolean {
  return notifyReach({ permission: "granted", subscribed: view.subscribed === true, lost: !!view.lost, reachable: view.reachable }) === "renew";
}
