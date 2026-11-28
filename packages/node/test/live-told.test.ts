import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import type { NotifyPayload } from "@invincible/core";
import { ChatStore, type QueuedBy } from "../src/chats.ts";
import { ConnectorRequests } from "../src/connector-requests.ts";
import { LoopDrafts } from "../src/loop-drafts.ts";
import { NotifyStore } from "../src/notify-store.ts";
import { Questions } from "../src/questions.ts";

/*
 * What the node writes of its own tells your devices' live stream as it writes it (speed, 4b-2, 28 November 2026):
 * each store a stamp reads tells its watchers after a write that may move that stamp, so the stream reads it again
 * within SOON_MS. The stream's look every LOOK_MS is only the net under these.
 */

describe("your chats, as the node writes them (the stream's `turns`)", () => {
  test("every write moves the version the stream reads and tells it; every other method only reads", () => {
    let now = 1_000;
    const chats = new ChatStore(":memory:", () => now);
    let tells = 0;
    chats.onChange(() => void tells++);
    const by: QueuedBy = { kind: "client", device: "c_phone" };
    const chat = chats.create({ title: "Plan the shed", project: "garden", role: "planner" });
    let answer = 0;
    let unanswered = 0;
    let look = "";
    let queued = 0;
    // Each write, with what it needs before it (not counted), in an order where each has something to change.
    const writes: [string, () => unknown, (() => unknown)?][] = [
      ["create", () => chats.create({ title: "Another", project: null, role: "planner" })],
      ["addUser", () => chats.addUser(chat.id, "What's left?")],
      ["startAnswer", () => (answer = chats.startAnswer(chat.id))],
      ["finishAnswer", () => chats.finishAnswer(chat.id, answer, { content: "Two things.", model: null, steps: [], status: "done", error: null })],
      ["see", () => chats.see(chat.id)],
      ["keepStory", () => chats.keepStory(chat.id, "They planned the shed.", answer)],
      ["setWaits", () => chats.setWaits(chat.id, { actions: ["a_1"], secrets: [], question: false })],
      ["update", () => chats.update(chat.id, { pinned: true })],
      ["lookAdd", () => (look = chats.lookAdd({ conversation: chat.id, at: now + 60_000, note: "Look again", zone: "Europe/London", by, held: null }).id)],
      ["lookEnd", () => chats.lookEnd(look, "done", null)],
      ["handoff", () => chats.handoff(chat.id, "task-1", { by, zone: "Europe/London" })],
      ["handoffTold", () => chats.handoffTold(chat.id, "task-1", "interrupted")],
      ["handoffsLetGo", () => chats.handoffsLetGo(now + 1)],
      ["queueAdd", () => (queued = chats.queueAdd(chat.id, { text: "Then this.", role: null, by }).id)],
      ["queueEdit", () => chats.queueEdit(chat.id, queued, "Then that.", by)],
      ["hold", () => chats.hold(chat.id, "stopped")],
      ["queueTake", () => chats.queueTake(chat.id, queued)],
      ["queueClear", () => chats.queueClear(chat.id), () => chats.queueAdd(chat.id, { text: "And this.", role: null, by })],
      ["dropAnswer", () => chats.dropAnswer(chat.id, unanswered), () => (unanswered = chats.startAnswer(chat.id))],
      ["dropLastExchange", () => chats.dropLastExchange(chat.id, "What's left?")],
      ["projectRemoved", () => chats.projectRemoved("garden")],
      ["delete", () => chats.delete(chat.id)],
      ["adopt", () => chats.adopt({ id: "cv_AAAAAAAAAAAAAAAAAAAAAA", title: "Kept", project: null, role: "chat", pinned: false, createdAt: 1, updatedAt: 1, answeredAt: null, seenAt: null }, [])],
    ];
    for (const [name, write, before] of writes) {
      before?.();
      now += 1_000;
      const version = chats.version();
      const told = tells;
      write();
      expect([name, chats.version() !== version, tells > told]).toEqual([name, true, true]);
    }
    // A method added later is a read or one of the writes above: a write that doesn't tell fails here first.
    const reads = ["version", "summary", "list", "get", "told", "history", "attachmentIds", "unread", "looksWrittenFirst", "look", "looksWaiting", "looksDue", "handoffsToTell", "handoffs", "queue", "held", "queuedConversations", "onChange", "close"];
    const helpers = ["changed", "releaseIfEmpty", "touch"];
    const methods = Object.getOwnPropertyNames(ChatStore.prototype).filter((name) => name !== "constructor");
    expect(methods.filter((name) => !reads.includes(name) && !helpers.includes(name)).sort()).toEqual(writes.map(([name]) => name).sort());
    // And a read moves nothing and tells nothing.
    const version = chats.version();
    const told = tells;
    for (const read of [() => chats.list(), () => chats.unread(), () => chats.looksDue(now), () => chats.handoffsToTell(), () => chats.queuedConversations()]) read();
    expect([chats.version(), tells]).toEqual([version, told]);
    chats.close();
  });

  test("a watcher that throws is its own trouble, and one that stopped watching is told nothing", () => {
    const chats = new ChatStore(":memory:");
    let tells = 0;
    chats.onChange(() => {
      throw new Error("a watcher's own");
    });
    const stop = chats.onChange(() => void tells++);
    chats.create({ title: "One", project: null, role: "planner" });
    stop();
    chats.create({ title: "Two", project: null, role: "planner" });
    expect(tells).toBe(1);
    chats.close();
  });
});

describe("your notifications, as the node keeps them (the stream's `notify`)", () => {
  const payload = (tag: string): NotifyPayload => ({ v: 1, kind: "needs-you", title: "Your agent: this needs you", body: "Open Needs you.", open: "inbox", tag });

  test("every write that moves the stamp the stream reads tells it, and what the stamp doesn't read moves nothing", () => {
    let now = Date.parse("2026-11-28T12:00:00Z");
    const db = new NotifyStore(":memory:", () => now, "Europe/London");
    let tells = 0;
    db.onChange(() => void tells++);
    const moves: [string, () => unknown][] = [
      ["put", () => db.put("c_phone", { endpoint: "https://push.example/one", p256dh: "k", auth: "a", service: "Web" })],
      ["move", () => db.move("c_phone", "https://push.example/two", "Web")],
      ["mark, sent", () => db.mark("c_phone", { ok: true })],
      ["mark, refused", () => db.mark("c_phone", { ok: false, error: "410 gone" })],
      ["lose", () => db.lose("c_phone", { service: "Web", why: "its push service dropped it" })],
      ["forgetLost", () => db.forgetLost("c_phone")],
      ["putActivity", () => db.putActivity("c_phone", "task-1", "token", "production")],
      ["dropActivity", () => db.dropActivity("c_phone", "task-1")],
      ["see", () => db.see("c_phone", "Europe/Paris")],
      ["forgetPresence", () => db.forgetPresence("c_phone")],
      ["withdraw", () => db.withdraw("tag-1")],
      ["unwithdraw", () => db.unwithdraw("tag-1")],
      ["keepFor", () => db.keepFor("c_phone", payload("tag-2"), now + 60_000)],
      ["setPrefs", () => db.setPrefs({ ...db.prefs(), perDay: 7 })],
      ["setSetting, prefs", () => db.setSetting("prefs", JSON.stringify({ ...db.prefs(), perDay: 8 }))],
      ["logSent", () => db.logSent("2026-11-28", "finished", ["c_phone"], true)],
      ["remove", () => db.remove("c_phone")],
    ];
    for (const [name, write] of moves) {
      now += 1_000;
      const stamp = db.stamp();
      const told = tells;
      write();
      expect([name, db.stamp() !== stamp, tells > told]).toEqual([name, true, true]);
    }
    // What it keeps for its own use: the stamp doesn't read it, so nothing moves for the stream (and nothing need tell).
    const kept: [string, () => unknown][] = [
      ["saidActivity", () => db.saidActivity("c_phone", "task-1", "running")],
      ["setCollects", () => db.setCollects("c_android")],
      ["asked", () => db.asked([{ key: "action:a_1", expires: now + 3_600_000 }])],
      ["reminded", () => db.reminded(["action:a_1"])],
      ["toDigest", () => db.toDigest([{ key: "look:l_1", topic: "look" }])],
      ["catchUp", () => db.catchUp("c_phone")],
      ["tell", () => db.tell([{ key: "action:a_1", alert: true }])],
      ["setGone", () => db.setGone("action:a_1", now)],
      ["setSetting, another", () => db.setSetting("limit-said", "2026-11-28")],
    ];
    for (const [name, write] of kept) {
      now += 1_000;
      const stamp = db.stamp();
      write();
      expect([name, db.stamp()]).toEqual([name, stamp]);
    }
    db.close();
  });
});

describe("what waits in your Inbox, as the node's agents and servers ask (the stream's `loopDrafts`, `connectorRequests`, `questions`)", () => {
  test("a loop's draft tells as it is kept and as it goes", () => {
    const drafts = new LoopDrafts(new Database(":memory:"));
    let tells = 0;
    drafts.onChange(() => void tells++);
    const draft = drafts.add({ name: "Morning look", schedule: "0 8 * * *", tz: "Europe/London", on: null, task: { kind: "heartbeat" }, wakes: [], cooldownMs: null, label: null, why: null, by: "primary" });
    expect(tells).toBeGreaterThanOrEqual(1);
    const told = tells;
    expect(drafts.remove(draft.id)).toBe(true);
    expect(tells).toBeGreaterThan(told);
    // One that isn't there any more moves nothing.
    const after = tells;
    expect(drafts.remove(draft.id)).toBe(false);
    expect(tells).toBe(after);
  });

  test("an agent's request for a connector tells as it is kept and as it is answered", () => {
    const requests = new ConnectorRequests(new Database(":memory:"));
    let tells = 0;
    requests.onChange(() => void tells++);
    requests.add({ connector: "github", access: true, why: "To open the pull request.", by: "max" });
    expect(tells).toBeGreaterThanOrEqual(1);
    const told = tells;
    expect(requests.resolveAccess("github", "max")).toBe(1);
    expect(tells).toBeGreaterThan(told);
  });

  test("a server's question tells as it begins to wait and as it ends, besides what its maker asked to be told", async () => {
    const said: string[] = [];
    const questions = new Questions({ now: () => 1_000, changed: () => void said.push("maker") });
    questions.onChange(() => void said.push(`watcher:${questions.list().length}`));
    const asked = questions.ask({ id: "dinero", label: "Dinero" }, { message: "Which account?", requestedSchema: { type: "object", properties: { account: { type: "string", title: "Account" } } } });
    expect(said).toEqual(["maker", "watcher:1"]);
    questions.answer(questions.list()[0]!.id, false);
    expect(await asked).toEqual({ action: "decline" });
    expect(said).toEqual(["maker", "watcher:1", "maker", "watcher:0"]);
  });
});
