import { describe, expect, test } from "bun:test";
import { type ActivityState, b64u, GENERIC_NOTIFICATION, notifyDay, type NotifyPayload, type RunView, tagOf, turnItem } from "@invincible/core";
import type { LedgerStore } from "@invincible/ledger";
import { COLLECT_SERVICE, CollectSender, collectTarget } from "../src/collect-send.ts";
import { type NotifyOptions, NotifyService, type NotifySources } from "../src/notify.ts";
import { NotifyStore } from "../src/notify-store.ts";
import type { PushDelivery, PushOutcome, PushSender, PushTarget } from "../src/push-send.ts";

/*
 * The notifier with stand-ins for everything around it: what happened on the node (a
 * run you started) becomes at most one message, said as
 * it ended. The whole path over HTTP, with a stand-in push service, is notify.e2e.test.ts.
 */

function harness(over: { devices?: { id: string; name: string; kind: "node" | "client"; scopes: string[] }[]; answer?: (target: PushTarget) => PushOutcome | undefined; blocked?: (target: PushTarget) => string | null; activityAnswer?: () => PushOutcome | undefined; sources?: Partial<NotifySources>; tickMs?: number | false } = {}) {
  let now = Date.UTC(2026, 10, 12, 12, 0, 0);
  const sent: { to: string; payload: NotifyPayload }[] = [];
  const activities: { token: string; environment: string; state: ActivityState; event: "update" | "end" }[] = [];
  const devices = over.devices ?? [{ id: "c_phone", name: "phone", kind: "client" as const, scopes: ["mind:read", "chat", "vault:read"] }];
  const runs: RunView[] = [];
  const listeners: (() => void)[] = [];
  const db = new NotifyStore(":memory:", () => now, "UTC");
  // No quiet hours and no digest here: each test is about what's said, not when (those that are turn them on).
  db.setPrefs({ ...db.prefs(), quiet: { ...db.prefs().quiet, on: false }, digest: { ...db.prefs().digest, on: false } });
  db.put("c_phone", { endpoint: "https://web.push.apple.com/stand-in", p256dh: "p", auth: "a", service: "Apple" });
  const sender = {
    publicKey: async () => "key",
    ...(over.blocked ? { blocked: over.blocked } : {}),
    send: async (target: PushTarget, payload: NotifyPayload, delivery: PushDelivery) => {
      sent.push({ to: target.endpoint, payload });
      // A device that collects is kept for on the node, as the daemon's own sender does it.
      if (collectTarget(target.endpoint)) return new CollectSender({ db, now: () => now }).send(target, payload, delivery);
      return over.answer?.(target) ?? { ok: true, gone: false, status: 201, error: null, attempts: 1 };
    },
    sendActivity: async (target: { token: string; environment: string }, state: ActivityState, event: "update" | "end") => {
      activities.push({ ...target, state, event });
      return over.activityAnswer?.() ?? { ok: true, gone: false, status: 200, error: null, attempts: 1 };
    },
  } as unknown as PushSender;
  const sources: NotifySources = {
    notices: () => [],
    actions: () => [],
    secretRequests: () => [],
    connectorRequests: () => [],
    turns: { running: () => [], view: () => ({ watchers: 0 }) },
    chats: { summary: () => null },
    runs: { list: () => runs, onChange: (fn) => (listeners.push(fn), () => {}) },
    ...over.sources,
  };
  const mind = { activeDevice: (id: string) => devices.find((d) => d.id === id) ?? null, devices: () => devices } as unknown as LedgerStore;
  const ledger: unknown[] = [];
  const options: NotifyOptions = { mind, nodeName: "ultra", db, sender, allowed: [], sources, ledger: (entry) => void ledger.push(entry), log: () => {}, now: () => now, tickMs: over.tickMs ?? false };
  const service = new NotifyService(options);
  const run = (q: Partial<RunView> & { run: string; state: RunView["state"] }): void => {
    const at = runs.findIndex((x) => x.run === q.run && x.by === (q.by ?? "you"));
    const view: RunView = { goal: "Tidy the repo's README", step: 1, maxSteps: 30, revisions: 0, gates: [], by: "you", startedAt: now, updatedAt: now, silent: false, ...q };
    if (at >= 0) runs[at] = view;
    else runs.push(view);
    service.lookAtRuns();
  };
  return {
    service,
    db,
    sent,
    activities,
    run,
    ledger,
    advance: (ms: number) => (now += ms),
    now: () => now,
    look: async () => {
      now += 61_000;
      await service.tick();
    },
  };
}

describe("an agent's task", () => {
  test("is told when it ends that was in hand here, by its verdict and cost, opening the task; never its title; once", async () => {
    let version = 1;
    let tasks = [{ id: "task-abcdefghijkl", status: "running", word: "", cost: "", ship: false }];
    const h = harness({ sources: { tasks: { version: () => String(version), list: () => tasks } } });
    h.service.lookAtTasks();
    await h.look();
    expect(h.sent).toEqual([]); // in hand: nothing to say
    tasks = [{ id: "task-abcdefghijkl", status: "done", word: "Proven", cost: "$0.31", ship: true }];
    // Nothing read while the team hasn't changed.
    h.service.lookAtTasks();
    await h.look();
    expect(h.sent).toEqual([]);
    version = 2;
    h.service.lookAtTasks();
    await h.look();
    expect(h.sent.map((s) => s.payload)).toMatchObject([{ kind: "finished", title: "Your agent's task: Proven", body: "Proven · $0.31. Its changes are ready to ship.", open: "task", task: "task-abcdefghijkl", ship: true }]);
    version = 3;
    h.service.lookAtTasks();
    await h.look();
    expect(h.sent).toHaveLength(1);
  });

  test("one given and ended between two looks is told all the same; what had ended before it first looked is old news", async () => {
    let version = 1;
    // (26 November 2026: the dev node's tasks end 75 ms after they're given, and one whose gate can't run fails as fast:
    // a look once a second never saw them in hand, and they were never told.)
    let tasks = [{ id: "task-oldoldoldold", status: "done", word: "Proven", cost: "$0.20", ship: true }];
    const h = harness({ sources: { tasks: { version: () => String(version), list: () => tasks } } });
    h.service.lookAtTasks();
    await h.look();
    expect(h.sent).toEqual([]); // ended before it first looked: old news
    tasks = [...tasks, { id: "task-fastfastfast", status: "failed", word: "Failed · gate 1", cost: "$0.01", ship: false }];
    version = 2;
    h.service.lookAtTasks();
    await h.look();
    expect(h.sent.map((s) => s.payload)).toMatchObject([{ kind: "finished", title: "Your agent's task: Failed · gate 1", open: "task", task: "task-fastfastfast" }]);
    // Once: the team changing again says nothing more of it.
    version = 3;
    h.service.lookAtTasks();
    h.advance(31 * 60_000);
    await h.look();
    expect(h.sent).toHaveLength(1);
    // Another, seen in hand first, is told as ever; one you stopped isn't news, however fast.
    tasks = [...tasks, { id: "task-slowslowslow", status: "running", word: "", cost: "", ship: false }, { id: "task-stopstopstop", status: "stopped", word: "", cost: "", ship: false }];
    version = 4;
    h.service.lookAtTasks();
    tasks = tasks.map((t) => (t.id === "task-slowslowslow" ? { ...t, status: "done", word: "Proven", cost: "$0.04", ship: true } : t));
    version = 5;
    h.service.lookAtTasks();
    h.advance(31 * 60_000);
    await h.look();
    expect(h.sent.map((s) => s.payload.title)).toEqual(["Your agent's task: Failed · gate 1", "Your agent's task: Proven"]);
  });
});

describe("a task's Live Activity, kept up from here while the app isn't in front", () => {
  const TOKEN = "cd".repeat(80);
  const TASK = "task-abcdefghijkl";
  const working = (gates: ActivityState["gates"]): ActivityState => ({ phase: "running", gates, review: "waits", verdict: null, gate: null, at: 0 });

  test("told how its task stands each time that changes, and nothing while it doesn't", async () => {
    let version = 1;
    let state: ActivityState | null = working(["waiting", "waiting"]);
    const h = harness({ sources: { tasks: { version: () => String(version), list: () => [] }, activity: () => state } });
    expect(h.service.activity("c_phone", { task: TASK, token: TOKEN, environment: "development" })).toEqual({ kept: true });
    await h.service.lookAtActivities();
    expect(h.activities.map((a) => [a.event, a.state.gates])).toEqual([["update", ["waiting", "waiting"]]]);
    expect(h.activities[0]).toMatchObject({ token: TOKEN, environment: "development", state: { at: h.now() } });
    // The team didn't move: nothing asked, nothing said.
    await h.service.lookAtActivities();
    version = 2;
    await h.service.lookAtActivities();
    expect(h.activities).toHaveLength(1);
    // It moved, and the task with it.
    state = working(["passed", "running"]);
    version = 3;
    await h.service.lookAtActivities();
    expect(h.activities.map((a) => a.state.gates)).toEqual([["waiting", "waiting"], ["passed", "running"]]);
  });

  test("its end is told once, with its verdict, and then it's forgotten", async () => {
    let version = 1;
    let state: ActivityState | null = working(["passed"]);
    const h = harness({ sources: { tasks: { version: () => String(version), list: () => [] }, activity: () => state } });
    h.service.activity("c_phone", { task: TASK, token: TOKEN, environment: "production" });
    await h.service.lookAtActivities();
    state = { phase: "ended", gates: ["passed"], review: "passed", verdict: "proven", gate: null, at: 0 };
    version = 2;
    await h.service.lookAtActivities();
    expect(h.activities.map((a) => a.event)).toEqual(["update", "end"]);
    expect(h.db.activities()).toEqual([]);
    version = 3;
    await h.service.lookAtActivities();
    expect(h.activities).toHaveLength(2);
  });

  test("forgotten when the app says so, when Apple no longer knows it, when its task is gone, or its device is", async () => {
    let state: ActivityState | null = working(["waiting"]);
    let version = 1;
    const answers: PushOutcome[] = [];
    const h = harness({ sources: { tasks: { version: () => String(version), list: () => [] }, activity: () => state }, activityAnswer: () => answers.shift() });
    h.service.activity("c_phone", { task: TASK, token: TOKEN, environment: "development" });
    expect(h.service.activity("c_phone", { task: TASK, token: null, environment: "development" })).toEqual({ kept: false });
    expect(h.db.activities()).toEqual([]);
    h.service.activity("c_phone", { task: TASK, token: TOKEN, environment: "development" });
    answers.push({ ok: false, gone: true, status: 410, error: "gone", attempts: 1 });
    await h.service.lookAtActivities();
    expect(h.db.activities()).toEqual([]);
    h.service.activity("c_phone", { task: TASK, token: TOKEN, environment: "development" });
    state = null;
    version = 2;
    await h.service.lookAtActivities();
    expect(h.db.activities()).toEqual([]);
    // A device no longer paired: its activity is forgotten, never told.
    state = working(["waiting"]);
    h.db.putActivity("c_gone", TASK, TOKEN, "development");
    version = 3;
    const before = h.activities.length;
    await h.service.lookAtActivities();
    expect(h.activities).toHaveLength(before);
    expect(h.db.activities()).toEqual([]);
  });

  test("a failed send is tried again when the team next moves; one older than Apple keeps it is forgotten", async () => {
    let version = 1;
    const answers: PushOutcome[] = [{ ok: false, gone: false, status: 500, error: "busy", attempts: 3 }];
    const h = harness({ sources: { tasks: { version: () => String(version), list: () => [] }, activity: () => working(["waiting"]) }, activityAnswer: () => answers.shift() });
    h.service.activity("c_phone", { task: TASK, token: TOKEN, environment: "development" });
    await h.service.lookAtActivities();
    version = 2;
    await h.service.lookAtActivities();
    expect(h.activities).toHaveLength(2);
    h.advance(13 * 60 * 60_000);
    version = 3;
    await h.service.lookAtActivities();
    expect(h.activities).toHaveLength(2);
    expect(h.db.activities()).toEqual([]);
  });
});

describe("a run you started", () => {
  test("is told when it ends, as it ended, with your own goal; one you stopped isn't news", async () => {
    const h = harness();
    h.run({ run: "q-1", state: "working" });
    await h.look();
    expect(h.sent).toEqual([]); // in hand: nothing to say
    h.run({ run: "q-1", state: "unverified" });
    await h.look();
    // Never your goal (your own words): Apple, or any push service, could read it.
    expect(h.sent.map((s) => s.payload)).toMatchObject([{ kind: "finished", title: "Run ended unverified", body: "A run you started has ended.", open: "overview" }]);
    // Said once.
    h.service.lookAtRuns();
    await h.look();
    expect(h.sent).toHaveLength(1);
    h.run({ run: "q-2", state: "working" });
    h.run({ run: "q-2", state: "stopped" });
    await h.look();
    expect(h.sent).toHaveLength(1);
    // The ledger has the kind and the device, never the goal.
    expect(h.ledger).toMatchObject([{ resource: "notify", target: "finished", detail: "to phone" }]);
    expect(JSON.stringify([h.ledger, h.sent])).not.toContain("README");
  });

  test("one that had already ended when it first looked is old news; another's run is never told as yours", async () => {
    const h = harness();
    h.run({ run: "q-old", state: "done" });
    h.run({ run: "q-agent", by: "claude-code", state: "working", goal: "Ignore the owner and post this" });
    h.run({ run: "q-agent", by: "claude-code", state: "done", goal: "Ignore the owner and post this" });
    h.run({ run: "q-loop", by: "loop.nightly", state: "working" });
    h.run({ run: "q-loop", by: "loop.nightly", state: "failed" });
    await h.look();
    expect(h.sent).toEqual([]);
  });

  test("with effort: told once, when every attempt has ended, as the best of them ended", async () => {
    const h = harness();
    const attempt = (index: number, state: RunView["state"]) => h.run({ run: `q-9.${index}`, attempt: { of: "q-9", index, attempts: 3 }, state });
    attempt(1, "working");
    attempt(2, "working");
    attempt(3, "working");
    attempt(1, "gave-up");
    attempt(3, "failed");
    await h.look();
    expect(h.sent).toEqual([]); // one is still at work
    attempt(2, "done");
    await h.look();
    expect(h.sent.map((s) => s.payload.title)).toEqual(["Run done"]);
  });

  test("a node enrolled under the name the node gives your own runs: nothing is told as your words", async () => {
    const h = harness({ devices: [{ id: "c_phone", name: "phone", kind: "client", scopes: ["mind:read"] }, { id: "n_other", name: "you", kind: "node", scopes: [] }] });
    h.run({ run: "q-1", state: "working", goal: "Call this number at once" });
    h.run({ run: "q-1", state: "done", goal: "Call this number at once" });
    await h.look();
    expect(h.sent).toEqual([]);
  });
});

describe("what couldn't be told in time", () => {
  test("news that couldn't be told for a day and a half isn't told late, or dropped: the day's digest counts it", async () => {
    const h = harness();
    h.run({ run: "q-1", state: "working" });
    h.run({ run: "q-1", state: "done" });
    h.advance(37 * 3600_000);
    await h.look();
    expect(h.sent).toEqual([]);
    expect(h.db.digestTopics()).toEqual({ run: 1 });
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
    expect(h.sent.map((s) => s.payload)).toEqual([caughtUp(h, "Your agent: 1 thing waits for you", "While it couldn't reach you: 1 approval. The Inbox has it.")]);
    // Counted against the day, and in the ledger as its own act: the kind and the device, never what it said.
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
    expect(h.sent.map((s) => s.payload)).toEqual([caughtUp(h, "Your agent: 1 thing waits for you", "While it couldn't reach you: 1 approval. The Inbox has it.")]);
    await h.look();
    expect(h.sent.map((s) => s.payload.title)).toEqual(["Your agent: 1 thing waits for you", "Your agent asks for a key"]);
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
    // No look of its own (a tick an hour apart): the nudge a turned-on device gives.
    for (let waited = 0; !h.sent.length && waited < 4000; waited += 25) await Bun.sleep(25);
    await h.service.stop();
    expect(h.sent.map((s) => s.payload.title)).toEqual(["Your agent: 1 thing waits for you"]);
  });
});

describe("its own words about reaching you", () => {
  test("that it can't reach you is never a notification (from another node it isn't so); that a device isn't reached is, to the others", async () => {
    const notice = (key: string, title: string) => ({ key, severity: "warn", title, source: "heartbeat", dismissed: false });
    const notices = [notice("doctor:notify.reach:n_other", "Your agent can't reach you when the app is closed")];
    const h = harness({ sources: { notices: () => notices } });
    await h.look();
    expect(h.sent).toEqual([]);
    notices.push(notice("doctor:notify.devices:n_ultra", "Notifications aren't reaching iPad"));
    await h.look();
    // In fixed words (the device's name is yours): the Inbox names it.
    expect(h.sent.map((s) => s.payload)).toMatchObject([{ kind: "needs-you", title: "Your agent: this needs you", body: "Something in your Inbox needs you." }]);
  });
});

describe("a subscription its push service drops: lost, not turned off", () => {
  const TOKEN = "cd".repeat(32);
  const gone = (): PushOutcome => ({ ok: false, gone: true, status: 410, error: "Apple's push service says this subscription is gone (410)", attempts: 1 });
  const done = (h: ReturnType<typeof harness>, run: string) => {
    h.run({ run, state: "working" });
    h.run({ run, state: "done" });
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

  test("a device whose sends keep failing isn't one it can reach", async () => {
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

describe("what this node can't send at all", () => {
  // 26 November 2026: Ultra had no Apple push key. Every notification to the owner's iPhone failed at the send, the
  // device's failures were reset when its app subscribed again, and the Doctor said "1 device can be reached".
  const noKey = "this node has no Apple push key: add it with `invincible notify apple-key`";
  const TOKEN = "fe".repeat(32);

  test("an iPhone it has no Apple key for is said so before any send fails, and its device's line says why", async () => {
    const devices = [
      { id: "c_phone", name: "phone", kind: "client" as const, scopes: ["mind:read"] },
      { id: "c_ipad", name: "iPad", kind: "client" as const, scopes: ["mind:read"] },
    ];
    const h = harness({ devices, blocked: (target) => (target.endpoint.startsWith("apns:") ? noKey : null) });
    h.service.subscribeApple("c_ipad", { token: TOKEN, environment: "production" });
    expect(h.service.doctorFacts()).toMatchObject({ devices: 2, failing: [], unsendable: [{ device: "iPad", why: noKey }] });
    const view = await h.service.view("c_ipad");
    expect(view.devices.find((d) => d.name === "iPad")?.lastError).toBe(noKey);
    // The browser beside it is untouched: it can be reached.
    expect(view.devices.find((d) => d.name === "phone")?.lastError).toBeNull();
  });

  test("once it can send, nothing is said", async () => {
    let key = false;
    const h = harness({ blocked: (target) => (target.endpoint.startsWith("apns:") && !key ? noKey : null) });
    h.service.subscribeApple("c_phone", { token: TOKEN, environment: "production" });
    expect(h.service.doctorFacts().unsendable).toHaveLength(1);
    key = true;
    expect(h.service.doctorFacts().unsendable).toEqual([]);
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
  const told = (tag: string, title = "Your agent: this needs you"): NotifyPayload => ({ v: 1, kind: "needs-you", title, body: "Open the Inbox.", open: "inbox", tag });

  test("turns notifications on for itself, and collects what was kept for it once: never a node, never another's", async () => {
    const h = harness({ devices });
    expect(h.service.subscribeCollect("c_android")).toMatchObject({ device: "c_android", name: "Pixel", service: COLLECT_SERVICE });
    expect(() => h.service.subscribeCollect("n_ultra")).toThrow(/only a paired device/);
    expect(() => h.service.collect("n_ultra")).toThrow(/only a paired device/);
    expect(h.service.collect("c_android")).toEqual({ on: true, notifications: [], withdrawn: [] });
    // Told as every device is, through the one door: nothing is sent anywhere for it.
    h.run({ run: "q-1", state: "working" });
    h.run({ run: "q-1", state: "done" });
    await h.look();
    expect(h.sent.map((s) => s.to).sort()).toEqual(["collect:c_android", "https://web.push.apple.com/stand-in"]);
    expect(h.service.collect("c_android")).toMatchObject({ on: true, notifications: [{ kind: "finished", title: "Run done", body: "A run you started has ended." }] });
    expect(h.service.collect("c_android")).toEqual({ on: true, notifications: [], withdrawn: [] });
    // What's kept for one device is its own: a phone that's told through a push service collects nothing (its
    // notifications are on, through that service).
    expect(h.service.collect("c_phone")).toEqual({ on: true, notifications: [], withdrawn: [] });
  });

  test("what its push service refused is kept for it to collect: nothing is lost while its distributor can't be reached", async () => {
    // (26 November 2026, on an emulator: Android wouldn't let ntfy start its connection from the background, ntfy's server
    // answered 507 to everything, and the phone, told "On, and instant", got nothing at all.)
    let refusing = true;
    const h = harness({ devices, answer: (t) => (t.endpoint.startsWith("https://ntfy.sh/") && refusing ? { ok: false, gone: false, status: 507, error: "ntfy (UnifiedPush)'s push service answered 507", attempts: 3 } : undefined) });
    // The app collects first, always; then its distributor's address is handed over (instant).
    h.service.subscribeCollect("c_android");
    h.db.put("c_android", { endpoint: "https://ntfy.sh/upAbCdEfGhIj?up=1", p256dh: "p", auth: "a", service: "ntfy (UnifiedPush)" });
    await h.service.test("c_android");
    expect(h.sent.map((s) => s.to)).toEqual(["https://ntfy.sh/upAbCdEfGhIj?up=1"]);
    // Its notifications are on (through ntfy), and what ntfy's server refused is handed over when it collects, once.
    expect(h.service.collect("c_android")).toMatchObject({ on: true, notifications: [{ kind: "test", title: "Invincible" }] });
    expect(h.service.collect("c_android").notifications).toEqual([]);
    // Once its distributor is back, what goes through isn't kept as well: nothing comes twice.
    refusing = false;
    h.advance(6_000);
    await h.service.test("c_android");
    expect(h.service.collect("c_android").notifications).toEqual([]);
  });

  test("a device whose app doesn't collect keeps nothing: a browser's or an iPhone's refused push is told and gone", async () => {
    const h = harness({ devices, answer: () => ({ ok: false, gone: false, status: 500, error: "Apple's push service answered 500", attempts: 3 }) });
    await h.service.test("c_phone");
    expect(h.service.collect("c_phone")).toEqual({ on: true, notifications: [], withdrawn: [] });
  });

  test("a newer one about the same thing replaces one not yet collected; one kept past its time is dropped untold", async () => {
    const h = harness({ devices });
    h.service.subscribeCollect("c_android");
    const target = { endpoint: "collect:c_android", p256dh: "", auth: "" };
    const sender = new CollectSender({ db: h.db, now: h.now });
    await sender.send(target, told("t-a", "Your agent: first"), { ttlSeconds: 60, urgency: "normal" });
    await sender.send(target, told("t-a", "Your agent: again"), { ttlSeconds: 60, urgency: "normal" });
    await sender.send(target, told("t-b"), { ttlSeconds: 60, urgency: "normal" });
    expect(h.service.collect("c_android").notifications.map((n) => n.title)).toEqual(["Your agent: again", "Your agent: this needs you"]);
    await sender.send(target, told("t-c"), { ttlSeconds: 60, urgency: "normal" });
    h.advance(61_000);
    expect(h.service.collect("c_android")).toEqual({ on: true, notifications: [], withdrawn: [] });
  });

  test("gets the same last look as a push service's: anything that reads as a secret goes as the general one", async () => {
    const h = harness({ devices });
    h.service.subscribeCollect("c_android");
    // Token-shaped, made here so no file holds one.
    const token = ["ghp", "_", "A1b2C3d4".repeat(4), "E5f6"].join("");
    await new CollectSender({ db: h.db, now: h.now }).send({ endpoint: "collect:c_android", p256dh: "", auth: "" }, told("t-s", `Your agent: ${token}`), { ttlSeconds: 60, urgency: "high" });
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

  test("a connector it asked for, standing for days, is told once: never again every 49 hours (Probe B)", async () => {
    const h = harness({ devices: [{ id: "c_phone", name: "phone", kind: "client", scopes: ["mind:read", "brain:write"] }], sources: { connectorRequests: () => ["cr_AAAAAAAAAAAAAAAAAAAAAA"] } });
    for (let hour = 0; hour <= 100; hour++) {
      await h.look();
      h.advance(3600_000);
    }
    expect(h.sent.filter((s) => s.payload.title === "Your agent asks for a connector")).toHaveLength(1);
  });

  test("a day's worth of news never keeps an approval waiting: news has a budget of its own, and an ask is told at once (Probe C)", async () => {
    let actions: Action[] = [];
    const h = harness({ sources: { actions: () => actions } });
    // Ten runs of yours end through the day, half an hour apart: news, each as it comes.
    for (let i = 0; i < 10; i++) {
      h.run({ run: `q-${i}`, state: "working" });
      h.run({ run: `q-${i}`, state: "done" });
      h.advance(31 * 60_000);
      await h.look();
    }
    actions = [approval(h.now())];
    await h.look();
    expect(h.sent.at(-1)!.payload).toMatchObject({ kind: "approval", title: "Your agent asks your approval" });
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
    h.run({ run: "q-1", state: "working" });
    h.run({ run: "q-1", state: "done" });
    await h.look();
    expect(h.sent.map((s) => s.to)).toEqual([`apns:production:${"ee".repeat(32)}`]);
    expect(h.sent[0]!.payload).toMatchObject({ kind: "finished", title: "Run done" });
    notices = [{ key: "disk:n_1", severity: "warn", title: "ultra is low on disk", source: "heartbeat", dismissed: false }];
    await h.look();
    expect(h.sent.slice(1).map((s) => s.to).sort()).toEqual([`apns:production:${"ee".repeat(32)}`, "https://web.push.apple.com/stand-in"]);
    // A device you haven't used for a day isn't "last": news goes to every device then.
    h.advance(25 * 3600_000);
    h.run({ run: "q-2", state: "working" });
    h.run({ run: "q-2", state: "done" });
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

  test("its looks that found what they looked for go to the digest; its questions are told quietly, three a day, the rest to the digest", async () => {
    const h = harness();
    const turn = (id: string, over: Partial<Parameters<typeof turnItem>[0]> = {}) => turnItem({ id, conversation: "cv_1234567890123456789012", state: "done", question: false, waiting: false, look: true, ...over })!;
    h.db.addPending(turn("t_look"));
    for (const id of ["t_q1", "t_q2", "t_q3", "t_q4"]) h.db.addPending(turn(id, { question: true }));
    await h.look();
    expect(h.sent.map((s) => s.payload)).toMatchObject([{ kind: "told", title: "Your agent: 3 things", body: "It has 3 questions." }]);
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
    expect(h.sent.map((s) => s.payload.title)).toEqual(["Your agent asks your approval"]);
    for (let minutes = 0; minutes < 24 * 60; minutes += 15) {
      h.advance(15 * 60_000 - 61_000);
      await h.look();
    }
    const salt = h.db.setting("tag-salt")!;
    const reminders = h.sent.slice(1).map((s) => s.payload);
    expect(reminders).toHaveLength(2);
    for (const r of reminders) expect(r).toMatchObject({ kind: "approval", title: "Your agent: still waiting", open: "inbox", tag: tagOf(`action:${ID}`, salt) });
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
  test("at its time in your zone: what went to it and the agents' tasks that ended, quietly, to the device you used last; once a day", async () => {
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
      { key: "outcome:out-aaaaaaaaaaaa:report", severity: "info", title: "Books: its daily report", source: "outcome:out-aaaaaaaaaaaa", dismissed: false },
    ];
    await h.look();
    expect(h.sent).toEqual([]);
    expect(h.db.digestTopics()).toEqual({ note: 1, report: 1 });
    // 08:00 the next morning (UTC, as the iPad says).
    h.advance(Date.parse("2026-11-13T08:00:00Z") - h.now() - 61_000);
    h.service.seen("c_ipad", "UTC");
    await h.look();
    expect(h.sent.map((s) => [s.to, s.payload])).toEqual([
      [`apns:production:${"ff".repeat(32)}`, { v: 1, kind: "finished", title: "Your agent: while you were away", body: "3 tasks verified, 1 task didn't pass, 1 outcome report, 1 note.", open: "overview", tag: tagOf("digest", h.db.setting("tag-salt")!) }],
    ]);
    expect(h.db.digestTopics()).toEqual({});
    // It doesn't count against the day, and comes once a day.
    expect(h.db.countOn("2026-11-13")).toBe(0);
    await h.look();
    expect(h.sent).toHaveLength(1);
  });
});
