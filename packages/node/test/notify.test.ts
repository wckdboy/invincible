import { describe, expect, test } from "bun:test";
import { b64u, GENERIC_NOTIFICATION, notifyDay, type NotifyPayload, type QuestView, tagOf, turnItem } from "@galahad/core";
import type { MindStore } from "@galahad/mind";
import { COLLECT_SERVICE, CollectSender, collectTarget } from "../src/collect-send.ts";
import { type NotifyOptions, NotifyService, type NotifySources } from "../src/notify.ts";
import { NotifyStore } from "../src/notify-store.ts";
import type { PushDelivery, PushOutcome, PushSender, PushTarget } from "../src/push-send.ts";

/*
 * The notifier with stand-ins for everything around it: what happened on the node (a
 * quest you started) becomes at most one message, said as
 * it ended. The whole path over HTTP, with a stand-in push service, is notify.e2e.test.ts.
 */

function harness(over: { devices?: { id: string; name: string; kind: "node" | "client"; scopes: string[] }[]; answer?: (target: PushTarget) => PushOutcome | undefined; sources?: Partial<NotifySources>; tickMs?: number | false } = {}) {
  let now = Date.UTC(2026, 10, 12, 12, 0, 0);
  const sent: { to: string; payload: NotifyPayload }[] = [];
  const devices = over.devices ?? [{ id: "c_phone", name: "phone", kind: "client" as const, scopes: ["mind:read", "chat", "vault:read"] }];
  const quests: QuestView[] = [];
  const listeners: (() => void)[] = [];
  const db = new NotifyStore(":memory:", () => now, "UTC");
  // No quiet hours and no digest here: each test is about what's said, not when (those that are turn them on).
  db.setPrefs({ ...db.prefs(), quiet: { ...db.prefs().quiet, on: false }, digest: { ...db.prefs().digest, on: false } });
  db.put("c_phone", { endpoint: "https://web.push.apple.com/stand-in", p256dh: "p", auth: "a", service: "Apple" });
  const sender = {
    publicKey: async () => "key",
    send: async (target: PushTarget, payload: NotifyPayload, delivery: PushDelivery) => {
      sent.push({ to: target.endpoint, payload });
      // A device that collects is kept for on the node, as the daemon's own sender does it.
      if (collectTarget(target.endpoint)) return new CollectSender({ db, now: () => now }).send(target, payload, delivery);
      return over.answer?.(target) ?? { ok: true, gone: false, status: 201, error: null, attempts: 1 };
    },
  } as unknown as PushSender;
  const sources: NotifySources = {
    notices: () => [],
    actions: () => [],
    secretRequests: () => [],
    connectorRequests: () => [],
    turns: { running: () => [], view: () => ({ watchers: 0 }) },
    chats: { summary: () => null },
    quests: { list: () => quests, onChange: (fn) => (listeners.push(fn), () => {}) },
    ...over.sources,
  };
  const mind = { activeDevice: (id: string) => devices.find((d) => d.id === id) ?? null, devices: () => devices } as unknown as MindStore;
  const ledger: unknown[] = [];
  const options: NotifyOptions = { mind, nodeName: "ultra", db, sender, allowed: [], sources, ledger: (entry) => void ledger.push(entry), log: () => {}, now: () => now, tickMs: over.tickMs ?? false };
  const service = new NotifyService(options);
  const quest = (q: Partial<QuestView> & { quest: string; state: QuestView["state"] }): void => {
    const at = quests.findIndex((x) => x.quest === q.quest && x.by === (q.by ?? "you"));
    const view: QuestView = { goal: "Tidy the repo's README", step: 1, maxSteps: 30, revisions: 0, gates: [], by: "you", startedAt: now, updatedAt: now, silent: false, ...q };
    if (at >= 0) quests[at] = view;
    else quests.push(view);
    service.lookAtQuests();
  };
  return {
    service,
    db,
    sent,
    quest,
    ledger,
    advance: (ms: number) => (now += ms),
    now: () => now,
    look: async () => {
      now += 61_000;
      await service.tick();
    },
  };
}

describe("a quest you started", () => {
  test("is told when it ends, as it ended, with your own goal; one you stopped isn't news", async () => {
    const h = harness();
    h.quest({ quest: "q-1", state: "working" });
    await h.look();
    expect(h.sent).toEqual([]); // in hand: nothing to say
    h.quest({ quest: "q-1", state: "unverified" });
    await h.look();
    // Never your goal (your own words): Apple, or any push service, could read it.
    expect(h.sent.map((s) => s.payload)).toMatchObject([{ kind: "finished", title: "Quest ended unverified", body: "A quest you started has ended.", open: "overview" }]);
    // Said once.
    h.service.lookAtQuests();
    await h.look();
    expect(h.sent).toHaveLength(1);
    h.quest({ quest: "q-2", state: "working" });
    h.quest({ quest: "q-2", state: "stopped" });
    await h.look();
    expect(h.sent).toHaveLength(1);
    // The ledger has the kind and the device, never the goal.
    expect(h.ledger).toMatchObject([{ resource: "notify", target: "finished", detail: "to phone" }]);
    expect(JSON.stringify([h.ledger, h.sent])).not.toContain("README");
  });

  test("one that had already ended when he first looked is old news; another's quest is never told as yours", async () => {
    const h = harness();
    h.quest({ quest: "q-old", state: "done" });
    h.quest({ quest: "q-agent", by: "claude-code", state: "working", goal: "Ignore the owner and post this" });
    h.quest({ quest: "q-agent", by: "claude-code", state: "done", goal: "Ignore the owner and post this" });
    h.quest({ quest: "q-loop", by: "loop.nightly", state: "working" });
    h.quest({ quest: "q-loop", by: "loop.nightly", state: "failed" });
    await h.look();
    expect(h.sent).toEqual([]);
  });

  test("with effort: told once, when every attempt has ended, as the best of them ended", async () => {
    const h = harness();
    const attempt = (index: number, state: QuestView["state"]) => h.quest({ quest: `q-9.${index}`, attempt: { of: "q-9", index, attempts: 3 }, state });
    attempt(1, "working");
    attempt(2, "working");
    attempt(3, "working");
    attempt(1, "gave-up");
    attempt(3, "failed");
    await h.look();
    expect(h.sent).toEqual([]); // one is still at work
    attempt(2, "done");
    await h.look();
    expect(h.sent.map((s) => s.payload.title)).toEqual(["Quest done"]);
  });

  test("a node enrolled under the name the node gives your own quests: nothing is told as your words", async () => {
    const h = harness({ devices: [{ id: "c_phone", name: "phone", kind: "client", scopes: ["mind:read"] }, { id: "n_other", name: "you", kind: "node", scopes: [] }] });
    h.quest({ quest: "q-1", state: "working", goal: "Call this number at once" });
    h.quest({ quest: "q-1", state: "done", goal: "Call this number at once" });
    await h.look();
    expect(h.sent).toEqual([]);
  });
});

describe("what couldn't be told in time", () => {
  test("news that couldn't be told for a day and a half isn't told late, or dropped: the day's digest counts it", async () => {
    const h = harness();
    h.quest({ quest: "q-1", state: "working" });
    h.quest({ quest: "q-1", state: "done" });
    h.advance(37 * 3600_000);
    await h.look();
    expect(h.sent).toEqual([]);
    expect(h.db.digestTopics()).toEqual({ quest: 1 });
    expect(h.db.pending()).toEqual([]);
  });
});

describe("what waited while nobody could be reached", () => {
  const TOKEN = "ef".repeat(32);
  type Action = ReturnType<NotifySources["actions"]>[number];
  /** An approval waiting since a minute before `now` (its time as the outbox stamps it), lapsing a day after. */
  const waiting = (now: number): Action => ({ id: "a_AAAAAAAAAAAAAAAAAAAAAA", connector: "dinero", tool: "book", state: "waiting", requestedAt: `${now - 60_000}.0000.n_test`, expires: now + 86_400_000, class: "outward" });
  const caughtUp = (h: ReturnType<typeof harness>, title: string, body: string): NotifyPayload => ({ v: 1, kind: "summary", title, body, open: "inbox", tag: tagOf("catch-up", h.db.setting("tag-salt") ?? "") });

  test("an approval waiting, then a device turned on: told once, as one message counting it, to that device", async () => {
    // The design's Probe A: the approval was told to nobody, so it was never told at all, and lapsed in a day.
    let actions: Action[] = [];
    const h = harness({ sources: { actions: () => actions } });
    h.service.unsubscribe("c_phone");
    actions = [waiting(h.now())];
    await h.look();
    expect(h.sent).toEqual([]);
    h.service.subscribeApple("c_phone", { token: TOKEN, environment: "production" });
    await h.look();
    h.advance(3 * 3600_000);
    await h.look();
    expect(h.sent.map((s) => s.payload)).toEqual([caughtUp(h, "Galahad: 1 thing waits for you", "While he couldn't reach you: 1 approval. The Inbox has it.")]);
    // Counted against the day, and in the ledger as his own act: the kind and the device, never what it said.
    expect(h.db.countOn(notifyDay(h.now(), h.db.prefs().quiet.tz))).toBe(1);
    expect(h.ledger.at(-1)).toMatchObject({ resource: "notify", target: "summary", detail: "to phone" });
    expect(JSON.stringify(h.ledger)).not.toContain("dinero");
  });

  test("not when another device could be told, nor when a device hands over again the subscription it has (as its app does on opening)", async () => {
    let actions: Action[] = [];
    const devices = [
      { id: "c_phone", name: "phone", kind: "client" as const, scopes: ["mind:read"] },
      { id: "c_ipad", name: "iPad", kind: "client" as const, scopes: ["mind:read"] },
    ];
    const h = harness({ devices, sources: { actions: () => actions } });
    actions = [waiting(h.now())];
    await h.look();
    expect(h.sent.map((s) => s.payload.kind)).toEqual(["approval"]);
    h.service.subscribeApple("c_ipad", { token: TOKEN, environment: "production" });
    await h.look();
    h.service.subscribeApple("c_ipad", { token: TOKEN, environment: "production" });
    await h.look();
    expect(h.sent).toHaveLength(1);
  });

  test("turned on with nothing standing, nothing is said, and nothing is kept back for later", async () => {
    let actions: Action[] = [];
    const h = harness({ sources: { actions: () => actions } });
    h.service.unsubscribe("c_phone");
    await h.look();
    h.service.subscribeApple("c_phone", { token: TOKEN, environment: "production" });
    await h.look();
    expect(h.sent).toEqual([]);
    // What comes later is told as itself, once, and never again as something that waited.
    actions = [waiting(h.now())];
    await h.look();
    await h.look();
    expect(h.sent.map((s) => s.payload.kind)).toEqual(["approval"]);
  });

  test("it waits for quiet hours to end; what was never told isn't in it, and is told as itself a minute after", async () => {
    let actions: Action[] = [];
    let keys: string[] = [];
    const h = harness({ sources: { actions: () => actions, secretRequests: () => keys } });
    h.service.unsubscribe("c_phone");
    actions = [waiting(h.now())];
    await h.look();
    const hhmm = (ms: number) => new Date(ms).toISOString().slice(11, 16);
    h.db.setPrefs({ ...h.db.prefs(), quiet: { on: true, from: hhmm(h.now() - 2 * 3600_000), to: hhmm(h.now() + 2 * 3600_000), tz: "UTC" } });
    h.service.subscribeApple("c_phone", { token: TOKEN, environment: "production" });
    await h.look();
    expect(h.sent).toEqual([]);
    keys = ["while-away"];
    h.db.setPrefs({ ...h.db.prefs(), quiet: { ...h.db.prefs().quiet, on: false } });
    await h.look();
    expect(h.sent.map((s) => s.payload)).toEqual([caughtUp(h, "Galahad: 1 thing waits for you", "While he couldn't reach you: 1 approval. The Inbox has it.")]);
    await h.look();
    expect(h.sent.map((s) => s.payload.title)).toEqual(["Galahad: 1 thing waits for you", "Galahad asks for a key"]);
  });

  test("a browser turned on is looked at again shortly, as the apps are", async () => {
    let actions: Action[] = [];
    const h = harness({ tickMs: 3_600_000, sources: { actions: () => actions } });
    h.service.unsubscribe("c_phone");
    actions = [waiting(h.now())];
    await h.service.tick();
    const pair = (await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"])) as CryptoKeyPair;
    const p256dh = b64u(new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey)));
    await h.service.subscribe("c_phone", { endpoint: "https://web.push.apple.com/another-stand-in", expirationTime: null, keys: { p256dh, auth: b64u(crypto.getRandomValues(new Uint8Array(16))) } });
    // No look of his own (a tick an hour apart): the nudge a turned-on device gives.
    for (let waited = 0; !h.sent.length && waited < 4000; waited += 25) await Bun.sleep(25);
    await h.service.stop();
    expect(h.sent.map((s) => s.payload.title)).toEqual(["Galahad: 1 thing waits for you"]);
  });
});

describe("his own words about reaching you", () => {
  test("that he can't reach you is never a notification (from another node it isn't so); that a device isn't reached is, to the others", async () => {
    const notice = (key: string, title: string) => ({ key, severity: "warn", title, source: "heartbeat", dismissed: false });
    const notices = [notice("doctor:notify.reach:n_other", "Galahad can't reach you when the app is closed")];
    const h = harness({ sources: { notices: () => notices } });
    await h.look();
    expect(h.sent).toEqual([]);
    notices.push(notice("doctor:notify.devices:n_ultra", "Notifications aren't reaching iPad"));
    await h.look();
    // In fixed words (the device's name is yours): the Inbox names it.
    expect(h.sent.map((s) => s.payload)).toMatchObject([{ kind: "needs-you", title: "Galahad: this needs you", body: "Something in your Inbox needs you." }]);
  });
});

describe("a subscription its push service drops: lost, not turned off", () => {
  const TOKEN = "cd".repeat(32);
  const gone = (): PushOutcome => ({ ok: false, gone: true, status: 410, error: "Apple's push service says this subscription is gone (410)", attempts: 1 });
  const done = (h: ReturnType<typeof harness>, quest: string) => {
    h.quest({ quest, state: "working" });
    h.quest({ quest, state: "done" });
  };

  test("is remembered for that device (when, the service, why; never where it was sent) until it turns them on again", async () => {
    const h = harness({ answer: gone });
    done(h, "q-1");
    await h.look();
    expect(h.db.subscription("c_phone")).toBeNull();
    const seen = await h.service.view("c_phone");
    expect(JSON.stringify(seen)).not.toContain("stand-in");
    expect(seen.subscribed).toBe(false);
    expect(seen.reachable).toBe(0);
    expect(seen.lost).toEqual({ at: h.now(), service: "Apple", why: "Apple's push service says this subscription is gone (410)" });
    // Said only to the device it was: a terminal is no device.
    expect((await h.service.view(null)).lost).toBeNull();
    // That device turns them on again: on, and no longer lost.
    h.service.subscribeApple("c_phone", { token: TOKEN, environment: "production" });
    expect(await h.service.view("c_phone")).toMatchObject({ subscribed: true, lost: null, reachable: 1 });
  });

  test("turned off by you, or a device revoked, is not lost", async () => {
    const devices = [
      { id: "c_phone", name: "phone", kind: "client" as const, scopes: ["mind:read"] },
      { id: "c_ipad", name: "iPad", kind: "client" as const, scopes: ["mind:read"] },
    ];
    const h = harness({ devices, answer: gone });
    h.service.subscribeApple("c_ipad", { token: TOKEN, environment: "production" });
    done(h, "q-1");
    await h.look();
    expect(h.db.lost().map((row) => row.device).sort()).toEqual(["c_ipad", "c_phone"]);
    // Your own act on the phone: off, not lost.
    expect(h.service.unsubscribe("c_phone")).toBe(false);
    expect((await h.service.view("c_phone")).lost).toBeNull();
    // The iPad revoked (wherever it was): its record goes at the next look at who is lost.
    devices.splice(1, 1);
    await h.service.view(null);
    expect(h.db.lost()).toEqual([]);
  });

  test("a device whose sends keep failing isn't one he can reach", async () => {
    const devices = [
      { id: "c_phone", name: "phone", kind: "client" as const, scopes: ["mind:read"] },
      { id: "c_ipad", name: "iPad", kind: "client" as const, scopes: ["mind:read"] },
    ];
    const failing = (target: PushTarget): PushOutcome | undefined => (target.endpoint.startsWith("apns:") ? { ok: false, gone: false, status: 500, error: "Apple's push service answered 500", attempts: 3 } : undefined);
    const h = harness({ devices, answer: failing });
    h.service.subscribeApple("c_ipad", { token: TOKEN, environment: "production" });
    expect((await h.service.view(null)).reachable).toBe(2);
    done(h, "q-1");
    await h.look();
    // Once is a failure; twice running, it keeps failing. (News goes at most every half hour.)
    expect((await h.service.view(null)).reachable).toBe(2);
    h.advance(30 * 60_000);
    done(h, "q-2");
    await h.look();
    expect((await h.service.view("c_ipad")).reachable).toBe(1);
    expect((await h.service.view("c_ipad")).lost).toBeNull();
    expect(h.service.doctorFacts().failing).toEqual([{ device: "iPad", error: "Apple's push service answered 500" }]);
  });
});

describe("quiet hours' time zone", () => {
  test("until you set one, the node's own; a zone you set is kept, whatever the node's", () => {
    const tokyo = new NotifyStore(":memory:", Date.now, "Asia/Tokyo");
    expect(tokyo.prefs().quiet.tz).toBe("Asia/Tokyo");
    tokyo.setPrefs({ ...tokyo.prefs(), quiet: { ...tokyo.prefs().quiet, tz: "America/Chicago" } });
    expect(tokyo.prefs().quiet.tz).toBe("America/Chicago");
    // Without one given, the store asks the machine it runs on.
    expect(new NotifyStore(":memory:").prefs().quiet.tz).toBe(Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC");
  });
});

describe("the iPhone app", () => {
  const TOKEN = "ab".repeat(32);
  const scopes = ["mind:read", "chat", "vault:read"];
  test("turns notifications on for itself with its Apple token, and is told through it: never as a node, never with another's token", async () => {
    const h = harness({ devices: [{ id: "c_phone", name: "phone", kind: "client", scopes }, { id: "c_iphone", name: "iPhone app", kind: "client", scopes }, { id: "n_ultra", name: "ultra", kind: "node", scopes: [] }] });
    expect(h.service.subscribeApple("c_iphone", { token: TOKEN, environment: "production" })).toMatchObject({ device: "c_iphone", name: "iPhone app", service: "Apple" });
    await h.service.test("c_iphone");
    expect(h.sent.at(-1)?.to).toBe(`apns:production:${TOKEN}`);
    expect(() => h.service.subscribeApple("n_ultra", { token: TOKEN, environment: "production" })).toThrow(/only a paired device/);
    expect(() => h.service.subscribeApple("c_phone", { token: TOKEN, environment: "production" })).toThrow(/another paired device's/);
    // A build from Xcode answers to Apple's development service, and says so.
    expect(h.service.subscribeApple("c_iphone", { token: TOKEN, environment: "development" })).toMatchObject({ service: "Apple (a development build)" });
  });

  test("one whose token answers on Apple's other service than it said is kept there after the first message that arrives", async () => {
    // As the sender answers when a TestFlight build said it was a development one: taken on Apple's own service.
    const answer = (target: PushTarget): PushOutcome | undefined =>
      target.endpoint.startsWith("apns:development:") ? { ok: true, gone: false, status: 200, error: null, attempts: 2, endpoint: target.endpoint.replace("apns:development:", "apns:production:") } : undefined;
    const h = harness({ devices: [{ id: "c_iphone", name: "iPhone app", kind: "client", scopes }], answer });
    h.service.subscribeApple("c_iphone", { token: TOKEN, environment: "development" });
    expect(await h.service.test("c_iphone")).toEqual({ sent: [{ device: "iPhone app", ok: true, error: null }] });
    expect(h.db.subscription("c_iphone")).toMatchObject({ endpoint: `apns:production:${TOKEN}`, service: "Apple" });
    h.advance(60_000);
    await h.service.test("c_iphone");
    expect(h.sent.at(-1)?.to).toBe(`apns:production:${TOKEN}`);
  });
});

describe("the Android app: kept on the node, collected by the app", () => {
  const scopes = ["mind:read", "chat", "vault:read"];
  const devices = [
    { id: "c_phone", name: "phone", kind: "client" as const, scopes },
    { id: "c_android", name: "Pixel", kind: "client" as const, scopes },
    { id: "n_ultra", name: "ultra", kind: "node" as const, scopes: [] },
  ];
  const told = (tag: string, title = "Galahad: this needs you"): NotifyPayload => ({ v: 1, kind: "needs-you", title, body: "Open the Inbox.", open: "inbox", tag });

  test("turns notifications on for itself, and collects what was kept for it once: never a node, never another's", async () => {
    const h = harness({ devices });
    expect(h.service.subscribeCollect("c_android")).toMatchObject({ device: "c_android", name: "Pixel", service: COLLECT_SERVICE });
    expect(() => h.service.subscribeCollect("n_ultra")).toThrow(/only a paired device/);
    expect(() => h.service.collect("n_ultra")).toThrow(/only a paired device/);
    expect(h.service.collect("c_android")).toEqual({ on: true, notifications: [], withdrawn: [] });
    // Told as every device is, through the one door: nothing is sent anywhere for it.
    h.quest({ quest: "q-1", state: "working" });
    h.quest({ quest: "q-1", state: "done" });
    await h.look();
    expect(h.sent.map((s) => s.to).sort()).toEqual(["collect:c_android", "https://web.push.apple.com/stand-in"]);
    expect(h.service.collect("c_android")).toMatchObject({ on: true, notifications: [{ kind: "finished", title: "Quest done", body: "A quest you started has ended." }] });
    expect(h.service.collect("c_android")).toEqual({ on: true, notifications: [], withdrawn: [] });
    // What's kept for one device is its own: a phone that's told through a push service collects nothing.
    expect(h.service.collect("c_phone")).toEqual({ on: false, notifications: [], withdrawn: [] });
  });

  test("a newer one about the same thing replaces one not yet collected; one kept past its time is dropped untold", async () => {
    const h = harness({ devices });
    h.service.subscribeCollect("c_android");
    const target = { endpoint: "collect:c_android", p256dh: "", auth: "" };
    const sender = new CollectSender({ db: h.db, now: h.now });
    await sender.send(target, told("t-a", "Galahad: first"), { ttlSeconds: 60, urgency: "normal" });
    await sender.send(target, told("t-a", "Galahad: again"), { ttlSeconds: 60, urgency: "normal" });
    await sender.send(target, told("t-b"), { ttlSeconds: 60, urgency: "normal" });
    expect(h.service.collect("c_android").notifications.map((n) => n.title)).toEqual(["Galahad: again", "Galahad: this needs you"]);
    await sender.send(target, told("t-c"), { ttlSeconds: 60, urgency: "normal" });
    h.advance(61_000);
    expect(h.service.collect("c_android")).toEqual({ on: true, notifications: [], withdrawn: [] });
  });

  test("gets the same last look as a push service's: anything that reads as a secret goes as the general one", async () => {
    const h = harness({ devices });
    h.service.subscribeCollect("c_android");
    // Token-shaped, made here so no file holds one.
    const token = ["ghp", "_", "A1b2C3d4".repeat(4), "E5f6"].join("");
    await new CollectSender({ db: h.db, now: h.now }).send({ endpoint: "collect:c_android", p256dh: "", auth: "" }, told("t-s", `Galahad: ${token}`), { ttlSeconds: 60, urgency: "high" });
    expect(h.service.collect("c_android").notifications).toEqual([GENERIC_NOTIFICATION]);
  });

  test("turned off (here or anywhere), what was kept for it goes, and it collects nothing until it's on again", async () => {
    const h = harness({ devices });
    h.service.subscribeCollect("c_android");
    await h.service.test("c_android");
    expect(h.service.unsubscribe("c_android")).toBe(true);
    expect(h.service.collect("c_android")).toEqual({ on: false, notifications: [], withdrawn: [] });
    h.service.subscribeCollect("c_android");
    expect(h.service.collect("c_android")).toEqual({ on: true, notifications: [], withdrawn: [] });
  });

  test("at most sixty are kept for a device: the oldest go first", async () => {
    const h = harness({ devices });
    for (let i = 0; i < 61; i++) {
      h.advance(1);
      h.db.keepFor("c_android", told(`t-${i}`), h.now() + 60_000);
    }
    h.service.subscribeCollect("c_android");
    const kept = h.service.collect("c_android").notifications.map((n) => n.tag);
    expect(kept).toHaveLength(60);
    expect(kept[0]).toBe("t-1");
    expect(kept.at(-1)).toBe("t-60");
  });
});

describe("told once while it stands, and asks before news", () => {
  type Action = ReturnType<NotifySources["actions"]>[number];
  const approval = (now: number, over: Partial<Action> = {}): Action => ({ id: "a_CCCCCCCCCCCCCCCCCCCCCC", connector: "dinero", tool: "book", state: "waiting", requestedAt: `${now - 60_000}.0000.n_test`, expires: now + 86_400_000, class: "outward", ...over });

  test("a connector he asked for, standing for days, is told once: never again every 49 hours (Probe B)", async () => {
    const h = harness({ devices: [{ id: "c_phone", name: "phone", kind: "client", scopes: ["mind:read", "brain:write"] }], sources: { connectorRequests: () => ["cr_AAAAAAAAAAAAAAAAAAAAAA"] } });
    for (let hour = 0; hour <= 100; hour++) {
      await h.look();
      h.advance(3600_000);
    }
    expect(h.sent.filter((s) => s.payload.title === "Galahad asks for a connector")).toHaveLength(1);
  });

  test("a day's worth of news never keeps an approval waiting: news has a budget of its own, and an ask is told at once (Probe C)", async () => {
    let actions: Action[] = [];
    const h = harness({ sources: { actions: () => actions } });
    // Ten quests of yours end through the day, half an hour apart: news, each as it comes.
    for (let i = 0; i < 10; i++) {
      h.quest({ quest: `q-${i}`, state: "working" });
      h.quest({ quest: `q-${i}`, state: "done" });
      h.advance(31 * 60_000);
      await h.look();
    }
    actions = [approval(h.now())];
    await h.look();
    expect(h.sent.at(-1)!.payload).toMatchObject({ kind: "approval", title: "Galahad asks your approval" });
  });
});

describe("tiers on the wire", () => {
  test("news goes quietly (Urgency low) to the device you used last; what needs you goes to every device, as loud as it is", async () => {
    const devices = [
      { id: "c_phone", name: "phone", kind: "client" as const, scopes: ["mind:read", "chat"] },
      { id: "c_ipad", name: "iPad", kind: "client" as const, scopes: ["mind:read", "chat"] },
    ];
    let notices: ReturnType<NotifySources["notices"]> = [];
    const h = harness({ devices, sources: { notices: () => notices } });
    h.service.subscribeApple("c_ipad", { token: "ee".repeat(32), environment: "production" });
    h.service.seen("c_phone", null);
    h.advance(60_000);
    h.service.seen("c_ipad", "Europe/Copenhagen");
    h.quest({ quest: "q-1", state: "working" });
    h.quest({ quest: "q-1", state: "done" });
    await h.look();
    expect(h.sent.map((s) => s.to)).toEqual([`apns:production:${"ee".repeat(32)}`]);
    expect(h.sent[0]!.payload).toMatchObject({ kind: "finished", title: "Quest done" });
    notices = [{ key: "disk:n_1", severity: "warn", title: "ultra is low on disk", source: "heartbeat", dismissed: false }];
    await h.look();
    expect(h.sent.slice(1).map((s) => s.to).sort()).toEqual([`apns:production:${"ee".repeat(32)}`, "https://web.push.apple.com/stand-in"]);
    // A device you haven't used for a day isn't "last": news goes to every device then.
    h.advance(25 * 3600_000);
    h.quest({ quest: "q-2", state: "working" });
    h.quest({ quest: "q-2", state: "done" });
    await h.look();
    expect(h.sent.slice(3).map((s) => s.to).sort()).toEqual([`apns:production:${"ee".repeat(32)}`, "https://web.push.apple.com/stand-in"]);
  });

  test("your day is read in the zone your devices say, not the node's: 22:30 in Copenhagen is night, whatever London says (Probe D)", async () => {
    let notices: ReturnType<NotifySources["notices"]> = [];
    const h = harness({ sources: { notices: () => notices } });
    // The node in London, quiet hours 22:00 to 07:00 as you set them there; your iPhone says it is in Copenhagen.
    h.db.setPrefs({ ...h.db.prefs(), quiet: { on: true, from: "22:00", to: "07:00", tz: "Europe/London" } });
    h.service.seen("c_phone", "Europe/Copenhagen");
    expect(h.service.zone()).toBe("Europe/Copenhagen");
    expect((await h.service.view("c_phone")).zone).toBe("Europe/Copenhagen");
    // 22:30 in Copenhagen (21:30 in London): held for the morning.
    h.advance(Date.parse("2026-11-25T21:30:00Z") - h.now() - 61_000);
    notices = [{ key: "disk:n_1", severity: "warn", title: "ultra is low on disk", source: "heartbeat", dismissed: false }];
    await h.look();
    expect(h.sent).toEqual([]);
    expect(await h.service.view(null)).toMatchObject({ quiet: true, held: 1 });
    // 07:00 in Copenhagen: told.
    h.advance(Date.parse("2026-11-26T06:00:00Z") - h.now() - 61_000);
    await h.look();
    expect(h.sent.map((s) => s.payload.kind)).toEqual(["needs-you"]);
  });

  test("a device that never said its zone, or isn't yours any more, leaves your day in the setting's zone", async () => {
    const devices = [{ id: "c_phone", name: "phone", kind: "client" as const, scopes: ["mind:read"] }, { id: "c_gone", name: "gone", kind: "client" as const, scopes: ["mind:read"] }];
    const h = harness({ devices });
    h.db.setPrefs({ ...h.db.prefs(), quiet: { ...h.db.prefs().quiet, tz: "Europe/London" } });
    h.service.seen("c_phone", null);
    h.service.seen("c_phone", "Mars/Olympus");
    expect(h.service.zone()).toBe("Europe/London");
    h.service.seen("c_gone", "Asia/Tokyo");
    expect(h.service.zone()).toBe("Asia/Tokyo");
    devices.pop();
    expect(h.service.zone()).toBe("Europe/London");
  });

  test("his looks that found what they looked for go to the digest; his questions are told quietly, three a day, the rest to the digest", async () => {
    const h = harness();
    const turn = (id: string, over: Partial<Parameters<typeof turnItem>[0]> = {}) => turnItem({ id, conversation: "cv_1234567890123456789012", bank: false, state: "done", question: false, waiting: false, look: true, ...over })!;
    h.db.addPending(turn("t_look"));
    for (const id of ["t_q1", "t_q2", "t_q3", "t_q4"]) h.db.addPending(turn(id, { question: true }));
    await h.look();
    expect(h.sent.map((s) => s.payload)).toMatchObject([{ kind: "told", title: "Galahad: 3 things", body: "He has 3 questions." }]);
    expect(h.db.digestTopics()).toEqual({ look: 1, asked: 1 });
  });
});

describe("reminders, and what's taken down", () => {
  type Action = ReturnType<NotifySources["actions"]>[number];
  const ID = "a_DDDDDDDDDDDDDDDDDDDDDD";

  test("an approval unanswered is reminded four hours on and an hour before it lapses, in fixed words, replacing the first; twice at most", async () => {
    let actions: Action[] = [];
    const h = harness({ sources: { actions: () => actions } });
    actions = [{ id: ID, connector: "dinero", tool: "book", state: "waiting", requestedAt: `${h.now() - 60_000}.0000.n_test`, expires: h.now() + 24 * 3600_000, class: "outward" }];
    const lapses = h.now() + 24 * 3600_000;
    await h.look();
    expect(h.sent.map((s) => s.payload.title)).toEqual(["Galahad asks your approval"]);
    for (let minutes = 0; minutes < 24 * 60; minutes += 15) {
      h.advance(15 * 60_000 - 61_000);
      await h.look();
    }
    const salt = h.db.setting("tag-salt")!;
    const reminders = h.sent.slice(1).map((s) => s.payload);
    expect(reminders).toHaveLength(2);
    for (const r of reminders) expect(r).toMatchObject({ kind: "approval", title: "Galahad: still waiting", open: "inbox", tag: tagOf(`action:${ID}`, salt) });
    expect(reminders[0]!.body).toBe("An approval still waits for your answer. No answer by Fri 12:00 means no."); // (asked Thursday at noon)
    void lapses;
    expect(Object.keys(reminders[0]!)).not.toContain("action");
    expect(JSON.stringify(reminders)).not.toMatch(/dinero|book/);
    // A budget of their own: reminders never spend what a new ask needs (the day's count has the approval alone).
    const days = [...new Set(h.db.sentOn(notifyDay(h.now(), "UTC")).map((row) => row.kind))];
    expect(days).toContain("reminder");
    expect(h.db.countOn(notifyDay(h.now(), "UTC"))).toBe(0);
    expect(h.db.countOn(notifyDay(h.now() - 24 * 3600_000, "UTC"))).toBe(1);
  });

  test("answered anywhere, it is taken down everywhere: its tag is withdrawn for every app; one that lapsed is counted in the digest", async () => {
    let actions: Action[] = [];
    const h = harness({ sources: { actions: () => actions } });
    h.service.subscribeCollect("c_phone");
    const waiting: Action = { id: ID, connector: "dinero", tool: "book", state: "waiting", requestedAt: `${h.now() - 60_000}.0000.n_test`, expires: h.now() + 3600_000, class: "outward" };
    actions = [waiting];
    await h.look();
    const tag = tagOf(`action:${ID}`, h.db.setting("tag-salt")!);
    expect((await h.service.view("c_phone")).withdrawn).toEqual([]);
    actions = [{ ...waiting, state: "approved" }];
    await h.look();
    expect((await h.service.view("c_phone")).withdrawn).toEqual([tag]);
    expect(h.service.collect("c_phone").withdrawn).toEqual([tag]);
    expect(h.db.digestTopics()).toEqual({});
    // Another, left to lapse: no answer is no, and the digest says so.
    const other = { ...waiting, id: "a_EEEEEEEEEEEEEEEEEEEEEE", requestedAt: `${h.now() - 60_000}.0000.n_test`, expires: h.now() + 3600_000 };
    actions = [other];
    await h.look();
    h.advance(3600_000);
    actions = [{ ...other, state: "expired" }];
    await h.look();
    expect(h.db.digestTopics()).toEqual({ lapsed: 1 });
  });
});

describe("the day's digest", () => {
  test("at its time in your zone: what went to it and the knights' tasks that ended, quietly, to the device you used last; once a day", async () => {
    const devices = [
      { id: "c_phone", name: "phone", kind: "client" as const, scopes: ["mind:read", "chat"] },
      { id: "c_ipad", name: "iPad", kind: "client" as const, scopes: ["mind:read", "chat"] },
    ];
    let notices: ReturnType<NotifySources["notices"]> = [];
    const h = harness({ devices, sources: { notices: () => notices, tasksEnded: () => ({ verified: 3, unverified: 1 }) } });
    h.service.subscribeApple("c_ipad", { token: "ff".repeat(32), environment: "production" });
    h.db.setPrefs({ ...h.db.prefs(), digest: { on: true, at: "08:00" } });
    h.service.seen("c_ipad", "UTC");
    // A note and an outcome's report: the digest's, never told on their own.
    notices = [
      { key: "order-expiring:o1", severity: "info", title: "Standing order \"x\" expires 2026-11-30", source: "heartbeat", dismissed: false },
      { key: "outcome:out-aaaaaaaaaaaa:report", severity: "info", title: "Books: his daily report", source: "outcome:out-aaaaaaaaaaaa", dismissed: false },
    ];
    await h.look();
    expect(h.sent).toEqual([]);
    expect(h.db.digestTopics()).toEqual({ note: 1, report: 1 });
    // 08:00 the next morning (UTC, as the iPad says).
    h.advance(Date.parse("2026-11-13T08:00:00Z") - h.now() - 61_000);
    h.service.seen("c_ipad", "UTC");
    await h.look();
    expect(h.sent.map((s) => [s.to, s.payload])).toEqual([
      [`apns:production:${"ff".repeat(32)}`, { v: 1, kind: "finished", title: "Galahad: while you were away", body: "3 tasks verified, 1 task didn't pass, 1 outcome report, 1 note.", open: "overview", tag: tagOf("digest", h.db.setting("tag-salt")!) }],
    ]);
    expect(h.db.digestTopics()).toEqual({});
    // It doesn't count against the day, and comes once a day.
    expect(h.db.countOn("2026-11-13")).toBe(0);
    await h.look();
    expect(h.sent).toHaveLength(1);
  });
});
