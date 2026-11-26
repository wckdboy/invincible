import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { rmSync } from "node:fs";
import type { Steering } from "@galahad/brain";
import type { ChatStreamEvent } from "@galahad/core";
import { ChatStore, type Queued, type QueuedBy } from "../src/chats.ts";
import { asideMessages, broughtBack, TurnError, TurnHub, type TurnSpec } from "../src/turns.ts";

/*
 * The turn hub on its own: a real chat store (in memory) and scripted answers. A turn
 * runs to its end whoever listens; a page that attaches sees it from its start; only a
 * stop, the limit or the node stops it; a steer becomes part of the kept chat; a queue
 * is sent in order, held after a stop or a failure, and never sent by a restart.
 */

const admin: QueuedBy = { kind: "admin", device: "node-1" };
const phone: QueuedBy = { kind: "client", device: "phone-1" };

/** An answer the test drives: it yields what it's given, sees the steers, and ends when told to. */
function scriptedAnswer() {
  const waiting: ((event: ChatStreamEvent | "end") => void)[] = [];
  const backlog: (ChatStreamEvent | "end")[] = [];
  let steering: Steering | null = null;
  let signal: AbortSignal | null = null;
  const push = (event: ChatStreamEvent | "end") => {
    const next = waiting.shift();
    if (next) next(event);
    else backlog.push(event);
  };
  const run: TurnSpec["run"] = async function* (s, sig) {
    steering = s;
    signal = sig;
    yield { type: "model", ref: "test/m" };
    for (;;) {
      // As a model call does: a signal that's already aborted ends it at once.
      const event = sig.aborted
        ? ({ type: "error", error: "The operation was aborted." } as const)
        : (backlog.shift() ??
          (await new Promise<ChatStreamEvent | "end">((resolve) => {
            waiting.push(resolve);
            sig.addEventListener("abort", () => resolve({ type: "error", error: "The operation was aborted." }), { once: true });
          })));
      if (sig.aborted) {
        yield { type: "error", error: "The operation was aborted." };
        return;
      }
      if (event === "end") {
        // As chat() does: what arrived in time is answered; nothing waiting, and it's over.
        const late = s.finish();
        if (late.length) {
          for (const text of late) yield { type: "steer", text };
          continue;
        }
        yield { type: "done", ref: "test/m" };
        return;
      }
      if (event.type === "error") {
        yield event;
        return;
      }
      yield event;
    }
  };
  return {
    run,
    say: (text: string) => push({ type: "text", text }),
    emit: (event: ChatStreamEvent) => push(event),
    /** As chat() does at a safe point: hand over what's waiting. */
    handOver: () => {
      for (const text of steering!.take()) push({ type: "steer", text });
    },
    end: () => push("end"),
    fail: (error: string) => push({ type: "error", error }),
    get aborted() {
      return signal?.aborted ?? false;
    },
  };
}

function setup(limits: ConstructorParameters<typeof TurnHub>[0]["limits"] = {}) {
  let clock = 1_000_000;
  const chats = new ChatStore(":memory:", () => clock++);
  const logs: string[] = [];
  const hub = new TurnHub({ chats, limits, now: () => clock, log: (m) => logs.push(m) });
  const answers: ReturnType<typeof scriptedAnswer>[] = [];
  const prepared: { conversation: string; queued: Queued }[] = [];
  let refuse: TurnError | null = null;
  const spec = (conversation: string | null, question: string, extra: Partial<TurnSpec> = {}): TurnSpec => {
    const answer = scriptedAnswer();
    answers.push(answer);
    const kept = conversation ? chats.summary(conversation)! : null;
    return { by: admin, bank: false, role: "planner", conversation: kept ? { id: kept.id, title: kept.title, project: kept.project } : null, question, messages: [{ role: "user", content: question }], waits: { actions: [], secrets: [] }, run: answer.run, ...extra };
  };
  hub.setPrepare((conversation, queued) => {
    if (refuse) throw refuse;
    prepared.push({ conversation, queued });
    return spec(conversation, queued.text, { by: queued.by });
  });
  const chat = (title = "A chat") => chats.create({ title, project: null, role: "planner" }).id;
  return { hub, chats, spec, chat, answers, prepared, logs, refuseNext: (error: TurnError | null) => (refuse = error), tick: (ms: number) => (clock += ms) };
}

/** Everything a watcher is told, until the turn ends. */
function watch(hub: TurnHub, id: string) {
  const events: ChatStreamEvent[] = [];
  let ended = false;
  const leave = hub.subscribe(hub.get(id)!, (event) => (event ? events.push(event) : (ended = true)));
  return { events, leave, get ended() { return ended; }, types: () => events.map((e) => e.type) };
}

const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 5));

describe("a turn the node owns", () => {
  test("runs to its end with nobody listening, and is in the kept chat like any other", async () => {
    const t = setup();
    const id = t.chat();
    const turn = t.hub.start(t.spec(id, "What's the weather?"));
    t.answers[0]!.say("Dry ");
    t.answers[0]!.say("and cold.");
    t.answers[0]!.end();
    await turn.ended;
    expect(turn.state).toBe("done");
    const kept = t.chats.get(id)!;
    expect(kept.messages.map((m) => [m.role, m.content, m.status])).toEqual([
      ["user", "What's the weather?", "done"],
      ["assistant", "Dry and cold.", "done"],
    ]);
    expect(kept.messages[1]!.model).toBe("test/m");
    expect(t.hub.running()).toEqual([]);
  });

  test("a page that attaches mid-turn sees it from its start, then live; leaving stops nothing", async () => {
    const t = setup();
    const id = t.chat();
    const turn = t.hub.start(t.spec(id, "Tell me a story."));
    const first = watch(t.hub, turn.id);
    t.answers[0]!.say("Once ");
    t.answers[0]!.say("upon a time");
    await settle();
    expect(first.types()).toEqual(["turn", "conversation", "model", "text", "text"]);
    expect(first.events[0]).toMatchObject({ type: "turn", id: turn.id, conversation: id, replay: true, answer: turn.firstAnswer });
    // The first page goes away (a locked phone): the turn doesn't notice.
    first.leave();
    t.answers[0]!.emit({ type: "tool", id: "c1", name: "recall", title: "Recall from the shared mind", input: "" });
    t.answers[0]!.emit({ type: "tool_result", id: "c1", name: "recall", ok: true, summary: "2 memories" });
    await settle();
    expect(t.hub.view(turn, true)).toMatchObject({ state: "running", watchers: 0, tools: 1, step: "Thinking it over", model: "test/m" });
    // Another device attaches: everything so far (the words as one run), then what happens next.
    const second = watch(t.hub, turn.id);
    expect(second.events.slice(1)).toEqual([
      { type: "conversation", id, title: "A chat", project: null },
      { type: "model", ref: "test/m" },
      { type: "text", text: "Once upon a time" },
      { type: "tool", id: "c1", name: "recall", title: "Recall from the shared mind", input: "" },
      { type: "tool_result", id: "c1", name: "recall", ok: true, summary: "2 memories" },
    ]);
    expect(t.hub.view(turn, true).watchers).toBe(1);
    t.answers[0]!.say(", the end.");
    t.answers[0]!.end();
    await turn.ended;
    expect(second.types().slice(-2)).toEqual(["text", "done"]);
    expect(second.ended).toBe(true);
    expect(first.events).toHaveLength(5);
    expect(t.chats.get(id)!.messages[1]).toMatchObject({ content: "Once upon a time, the end.", status: "done" });
    // A page that comes back just after it ended still sees how it went.
    const late = watch(t.hub, turn.id);
    expect(late.ended).toBe(true);
    expect(late.types().at(-1)).toBe("done");
  });

  test("an answer nobody watched to its end is new to you until you read it; one a device watched was read there", async () => {
    const t = setup();
    const id = t.chat();
    const alone = t.hub.start(t.spec(id, "What's the weather?"));
    t.answers[0]!.say("Dry.");
    t.answers[0]!.end();
    await alone.ended;
    expect(t.chats.summary(id)).toMatchObject({ unread: true });
    expect(t.chats.unread().map((c) => c.id)).toEqual([id]);
    // Read on some device: no longer new anywhere, and reading it again changes nothing.
    expect(t.chats.see(id)).toBe(true);
    expect(t.chats.summary(id)!.unread).toBe(false);
    expect(t.chats.see(id)).toBe(false);
    expect(t.chats.unread()).toEqual([]);
    // Watched to its end: read where it was watched.
    const watched = t.hub.start(t.spec(id, "And tomorrow?"));
    const page = watch(t.hub, watched.id);
    t.answers[1]!.say("Wet.");
    t.answers[1]!.end();
    await watched.ended;
    expect(page.ended).toBe(true);
    expect(t.chats.summary(id)!.unread).toBe(false);
    // Watched for a while, then left before it ended: new again.
    const left = t.hub.start(t.spec(id, "And the day after?"));
    watch(t.hub, left.id).leave();
    t.answers[2]!.say("Windy.");
    t.answers[2]!.end();
    await left.ended;
    expect(t.chats.summary(id)!.unread).toBe(true);
  });

  test("a device that may not watch it is told only that it's running", () => {
    const t = setup();
    const turn = t.hub.start(t.spec(t.chat(), "hi", { bank: true }));
    expect(t.hub.view(turn, false)).toMatchObject({ state: "running", watchable: false, step: null, model: null });
    t.answers[0]!.end();
  });

  test("Stop is explicit: the answer so far is kept as stopped, and the abort's own error isn't shown", async () => {
    const t = setup();
    const id = t.chat();
    const turn = t.hub.start(t.spec(id, "Write a long report."));
    const seen = watch(t.hub, turn.id);
    t.answers[0]!.say("Chapter one");
    await settle();
    expect(t.hub.stop(turn.id)).toBe(true);
    await turn.ended;
    expect(t.answers[0]!.aborted).toBe(true);
    expect(turn.state).toBe("stopped");
    expect(seen.types()).toEqual(["turn", "conversation", "model", "text", "stopped"]);
    expect(seen.events.at(-1)).toEqual({ type: "stopped", reason: "you" });
    expect(t.chats.get(id)!.messages[1]).toMatchObject({ content: "Chapter one", status: "stopped", error: null });
    expect(t.hub.stop(turn.id)).toBe(false);
  });

  test("a failure is kept as one", async () => {
    const t = setup();
    const id = t.chat();
    const turn = t.hub.start(t.spec(id, "hi"));
    t.answers[0]!.fail("no model in the roster could answer");
    await turn.ended;
    expect(turn.state).toBe("error");
    expect(t.chats.get(id)!.messages[1]).toMatchObject({ status: "error", error: "no model in the roster could answer" });
  });

  test("a temporary chat's turn is kept nowhere", async () => {
    const t = setup();
    const turn = t.hub.start(t.spec(null, "A passing thought"));
    const seen = watch(t.hub, turn.id);
    t.answers[0]!.say("Noted.");
    t.answers[0]!.end();
    await turn.ended;
    expect(seen.events[0]).toMatchObject({ type: "turn", conversation: null, answer: null });
    expect(seen.types()).toEqual(["turn", "model", "text", "done"]);
    expect(t.chats.list()).toEqual([]);
  });
});

describe("a temporary chat's turn nobody watches", () => {
  test("is stopped after a while (it's kept nowhere, so nobody could read it); a kept chat's turn never is", async () => {
    const t = setup({ unwatchedMs: 40 });
    const temp = t.hub.start(t.spec(null, "A passing thought"));
    const kept = t.hub.start(t.spec(t.chat(), "Write the report."));
    t.answers[0]!.say("Thinking");
    await temp.ended;
    expect(temp.state).toBe("stopped");
    expect(t.answers[0]!.aborted).toBe(true);
    // The kept chat's turn goes on with nobody watching: its answer will be in the chat.
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(kept.state).toBe("running");
    t.answers[1]!.end();
    await kept.ended;
    expect(kept.state).toBe("done");
  });

  test("watching keeps it; a page that drops and comes back in time loses nothing; one that never does, stops it", async () => {
    const t = setup({ unwatchedMs: 60 });
    const turn = t.hub.start(t.spec(null, "A passing thought"));
    const first = watch(t.hub, turn.id);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(turn.state).toBe("running");
    // The connection drops, and the page finds the turn again before the time is up.
    first.leave();
    await new Promise((resolve) => setTimeout(resolve, 25));
    const again = watch(t.hub, turn.id);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(turn.state).toBe("running");
    // Then it's gone for good.
    again.leave();
    await turn.ended;
    expect(turn.state).toBe("stopped");
    expect(again.events.at(-1)).not.toEqual({ type: "stopped", reason: "unwatched" });
    const late = watch(t.hub, turn.id);
    expect(late.events.at(-1)).toEqual({ type: "stopped", reason: "unwatched" });
  });
});

describe("a stop always ends", () => {
  /** An answer stuck in something that never returns and ignores the stop (a tool that hangs). */
  const hung = (): TurnSpec["run"] =>
    async function* () {
      yield { type: "model", ref: "test/m" };
      yield { type: "tool", id: "c1", name: "connector_call", title: "Call a connector tool", input: "" };
      await new Promise(() => {});
    };

  test("a tool that never returns can't hold a stopped turn: it's recorded as it stands, and its place is given up", async () => {
    const t = setup({ windDownMs: 40, maxTurns: 1 });
    const id = t.chat();
    const turn = t.hub.start(t.spec(id, "Fetch the report.", { run: hung() }));
    const seen = watch(t.hub, turn.id);
    await settle();
    t.hub.stop(turn.id);
    await turn.ended;
    expect(turn.state).toBe("stopped");
    expect(seen.events.at(-1)).toEqual({ type: "stopped", reason: "you" });
    expect(seen.ended).toBe(true);
    // The tool's outcome was never known, and the kept answer says exactly that: called, no result.
    const kept = t.chats.get(id)!.messages[1]!;
    expect(kept.status).toBe("stopped");
    expect(kept.steps.at(-1)).toMatchObject({ kind: "tool", id: "c1", ok: null, summary: null });
    // Its place on the node is free again.
    expect(t.hub.running()).toEqual([]);
    expect(() => t.hub.start(t.spec(t.chat("next"), "Something else."))).not.toThrow();
  });

  test("a stopping node doesn't wait on it either", async () => {
    const t = setup({ windDownMs: 40 });
    const turn = t.hub.start(t.spec(t.chat(), "Fetch the report.", { run: hung() }));
    await settle();
    const started = Date.now();
    await t.hub.close();
    expect(Date.now() - started).toBeLessThan(2000);
    expect(turn.state).toBe("stopped");
  });

  test("a chat deleted while he works in it: the turn stops, and nothing is written for a chat that's gone", async () => {
    const t = setup();
    const id = t.chat();
    const turn = t.hub.start(t.spec(id, "A long one."));
    t.answers[0]!.say("Half");
    await settle();
    t.hub.steer(turn.id, "never delivered", admin);
    t.chats.delete(id);
    t.hub.stop(turn.id);
    await turn.ended;
    expect(turn.state).toBe("stopped");
    expect(t.logs).toEqual([]);
    expect(t.chats.summary(id)).toBeNull();
  });
});

describe("limits, said plainly", () => {
  test("so many turns at once; one per chat; refused before anything is written", () => {
    const t = setup({ maxTurns: 2 });
    const a = t.chat("a");
    t.hub.start(t.spec(a, "one"));
    expect(() => t.hub.admit(a)).toThrow(/still working in this chat/);
    try {
      t.hub.start(t.spec(a, "again"));
      throw new Error("should have been refused");
    } catch (error) {
      expect(error).toBeInstanceOf(TurnError);
      expect((error as TurnError).status).toBe(409);
    }
    // Nothing of the refused one was written.
    expect(t.chats.get(a)!.messages.filter((m) => m.role === "user")).toHaveLength(1);
    t.hub.start(t.spec(t.chat("b"), "two"));
    const c = t.chat("c");
    try {
      t.hub.start(t.spec(c, "three"));
      throw new Error("should have been refused");
    } catch (error) {
      expect((error as TurnError).status).toBe(429);
      expect((error as TurnError).message).toBe("This node is already working on 2 turns, its limit. Wait for one to end or stop one; a message queued behind a chat is sent when there's room.");
    }
    expect(t.chats.get(c)!.messages).toEqual([]);
    expect(t.hub.limits()).toEqual({ maxTurns: 2, maxMinutes: 30, maxQueued: 20 });
  });

  test("so long for one turn: past it the turn is stopped, says so, and nothing is retried", async () => {
    const t = setup({ maxMinutes: 0.0005 });
    const id = t.chat();
    const turn = t.hub.start(t.spec(id, "Think for a very long time."));
    const seen = watch(t.hub, turn.id);
    t.answers[0]!.say("Still thinking");
    await turn.ended;
    expect(turn.state).toBe("error");
    const last = seen.events.at(-1)!;
    expect(last).toMatchObject({ type: "error", error: expect.stringContaining("reached this node's limit of 0.0005 minutes for one turn and was stopped. Nothing is retried") });
    expect(t.chats.get(id)!.messages[1]).toMatchObject({ content: "Still thinking", status: "error" });
    expect(t.answers).toHaveLength(1);
  });
});

describe("steering a turn", () => {
  test("the message becomes part of the kept chat where it reached him: answer so far, your message, the rest", async () => {
    const t = setup();
    const id = t.chat();
    const turn = t.hub.start(t.spec(id, "What do you know about my bank?"));
    const seen = watch(t.hub, turn.id);
    t.answers[0]!.say("Your bank, as I recall, ");
    await settle();
    t.hub.steer(turn.id, "Never mind. The weather?", phone);
    expect(t.hub.view(turn, true).steering).toBe(1);
    t.answers[0]!.handOver();
    t.answers[0]!.say("Dry and cold.");
    t.answers[0]!.end();
    await turn.ended;
    expect(seen.types()).toEqual(["turn", "conversation", "model", "text", "steer", "text", "done"]);
    expect(t.chats.get(id)!.messages.map((m) => [m.role, m.content, m.status])).toEqual([
      ["user", "What do you know about my bank?", "done"],
      ["assistant", "Your bank, as I recall, ", "steered"],
      ["user", "Never mind. The weather?", "done"],
      ["assistant", "Dry and cold.", "done"],
    ]);
    // What the model sees next time is exactly what it saw then.
    expect(t.chats.history(id).map((m) => m.role)).toEqual(["user", "assistant", "user", "assistant"]);
    // The first answer's row is where a page starts rebuilding from.
    expect(turn.firstAnswer).toBe(t.chats.get(id)!.messages[1]!.id);
  });

  test("a steer before he'd said or done anything leaves no empty answer behind", async () => {
    const t = setup();
    const id = t.chat();
    const turn = t.hub.start(t.spec(id, "Plan my week."));
    t.hub.steer(turn.id, "Only Monday.", admin);
    t.hub.steer(turn.id, "And briefly.", admin);
    t.answers[0]!.handOver();
    t.answers[0]!.say("Monday: rest.");
    t.answers[0]!.end();
    await turn.ended;
    expect(t.chats.get(id)!.messages.map((m) => [m.role, m.content, m.status])).toEqual([
      ["user", "Plan my week.", "done"],
      ["user", "Only Monday.", "done"],
      ["user", "And briefly.", "done"],
      ["assistant", "Monday: rest.", "done"],
    ]);
    expect(t.chats.get(id)!.messages.at(-1)!.steps).toEqual([{ kind: "model", ref: "test/m" }]);
  });

  test("once he has finished, a steer is refused: it's a new turn's", async () => {
    const t = setup();
    const turn = t.hub.start(t.spec(t.chat(), "hi"));
    t.answers[0]!.end();
    await turn.ended;
    expect(() => t.hub.steer(turn.id, "one more thing", admin)).toThrow(/finished that turn/);
    expect(() => t.hub.steer("tn_nope", "x", admin)).toThrow(TurnError);
  });

  test("a steer that never reached him (he was stopped first) isn't lost: it's queued, first in line and held", async () => {
    const t = setup();
    const id = t.chat();
    const turn = t.hub.start(t.spec(id, "Post the report."));
    const seen = watch(t.hub, turn.id);
    t.hub.enqueue(id, { text: "Then tidy up.", role: null, by: admin });
    t.hub.steer(turn.id, "Wait, not that one.", phone);
    t.hub.stop(turn.id);
    await turn.ended;
    expect(seen.events.at(-1)).toEqual({ type: "undelivered", texts: ["Wait, not that one."], queued: true });
    expect(t.chats.queue(id).map((q) => [q.text, q.by.device])).toEqual([
      ["Wait, not that one.", "phone-1"],
      ["Then tidy up.", "node-1"],
    ]);
    expect(t.chats.held(id)).toBe("stopped");
    expect(t.answers).toHaveLength(1);
  });

  test("so many steers for one turn", () => {
    const t = setup({ maxSteers: 2 });
    const turn = t.hub.start(t.spec(t.chat(), "hi"));
    t.hub.steer(turn.id, "a", admin);
    t.hub.steer(turn.id, "b", admin);
    expect(() => t.hub.steer(turn.id, "c", admin)).toThrow(/steered 2 times, its limit/);
  });
});

describe("the queue", () => {
  test("queued messages are sent in order, one turn at a time, each as whoever queued it", async () => {
    const t = setup();
    const id = t.chat();
    const first = t.hub.start(t.spec(id, "One."));
    expect(t.hub.enqueue(id, { text: "Two.", role: null, by: phone }).started).toBeNull();
    t.hub.enqueue(id, { text: "Three.", role: "swift", by: admin });
    expect(t.chats.summary(id)).toMatchObject({ queued: 2, held: null });
    expect(t.answers).toHaveLength(1);
    t.answers[0]!.say("1");
    t.answers[0]!.end();
    await first.ended;
    // The second is running now, as the phone that queued it; the third still waits.
    expect(t.prepared.map((p) => [p.queued.text, p.queued.by.device])).toEqual([["Two.", "phone-1"]]);
    expect(t.chats.queue(id).map((q) => q.text)).toEqual(["Three."]);
    const second = t.hub.runningIn(id)!;
    t.answers[1]!.say("2");
    t.answers[1]!.end();
    await second.ended;
    expect(t.prepared[1]!.queued).toMatchObject({ text: "Three.", role: "swift" });
    const third = t.hub.runningIn(id)!;
    t.answers[2]!.say("3");
    t.answers[2]!.end();
    await third.ended;
    expect(t.chats.get(id)!.messages.map((m) => m.content)).toEqual(["One.", "1", "Two.", "2", "Three.", "3"]);
    expect(t.chats.summary(id)).toMatchObject({ queued: 0, held: null, state: "done" });
    expect(t.hub.running()).toEqual([]);
  });

  test("queued with nothing running and nothing holding it: its turn is now", () => {
    const t = setup();
    const id = t.chat();
    const { started } = t.hub.enqueue(id, { text: "Go.", role: null, by: admin });
    expect(started).not.toBeNull();
    expect(t.hub.runningIn(id)!.id).toBe(started!.id);
    expect(t.chats.queue(id)).toEqual([]);
  });

  test("after a Stop the queue is held until you resume; resuming sends it", async () => {
    const t = setup();
    const id = t.chat();
    const first = t.hub.start(t.spec(id, "One."));
    t.hub.enqueue(id, { text: "Two.", role: null, by: admin });
    t.hub.stop(first.id);
    await first.ended;
    expect(t.chats.summary(id)).toMatchObject({ queued: 1, held: "stopped", state: "queued" });
    expect(t.hub.runningIn(id)).toBeNull();
    // A turn ending elsewhere doesn't let it slip out.
    const other = t.hub.start(t.spec(t.chat("other"), "x"));
    t.answers.at(-1)!.end();
    await other.ended;
    expect(t.hub.runningIn(id)).toBeNull();
    t.hub.resume(id);
    expect(t.hub.runningIn(id)).not.toBeNull();
    expect(t.chats.summary(id)).toMatchObject({ queued: 0, held: null });
  });

  test("after a failure the queue is held too: nothing is retried, nothing burns through it", async () => {
    const t = setup();
    const id = t.chat();
    const first = t.hub.start(t.spec(id, "One."));
    t.hub.enqueue(id, { text: "Two.", role: null, by: admin });
    t.hub.enqueue(id, { text: "Three.", role: null, by: admin });
    t.answers[0]!.fail("provider is down");
    await first.ended;
    expect(t.chats.summary(id)).toMatchObject({ queued: 2, held: "error" });
    expect(t.answers).toHaveLength(1);
  });

  test("Send now: steers the turn under way; with nothing running, starts it and leaves the rest held", async () => {
    const t = setup();
    const id = t.chat();
    const first = t.hub.start(t.spec(id, "One."));
    const a = t.hub.enqueue(id, { text: "Two.", role: null, by: admin }).queued;
    const b = t.hub.enqueue(id, { text: "Three.", role: null, by: admin }).queued;
    expect(t.hub.sendNow(id, a.id, phone)).toMatchObject({ how: "steered", turn: { id: first.id } });
    expect(t.chats.queue(id).map((q) => q.text)).toEqual(["Three."]);
    t.hub.stop(first.id);
    await first.ended;
    // The steer never reached him: it's back in the queue, first, held with the other.
    expect(t.chats.queue(id).map((q) => q.text)).toEqual(["Two.", "Three."]);
    expect(t.chats.held(id)).toBe("stopped");
    const sent = t.hub.sendNow(id, b.id, phone);
    expect(sent.how).toBe("started");
    expect(t.prepared.at(-1)!.queued).toMatchObject({ text: "Three.", by: phone });
    expect(t.chats.queue(id).map((q) => q.text)).toEqual(["Two."]);
    expect(t.chats.held(id)).toBe("stopped");
    t.answers.at(-1)!.end();
    await sent.turn.ended;
    // It ended well, and the other is still held: only Resume lets it go.
    expect(t.hub.runningIn(id)).toBeNull();
    expect(t.chats.queue(id).map((q) => q.text)).toEqual(["Two."]);
    expect(() => t.hub.sendNow(id, 999_999, admin)).toThrow(/no longer queued/);
  });

  test("a queued message whose device is gone isn't sent: the queue is held and says why", async () => {
    const t = setup();
    const id = t.chat();
    const first = t.hub.start(t.spec(id, "One."));
    t.hub.enqueue(id, { text: "Two.", role: null, by: phone });
    t.refuseNext(new TurnError(403, "the device that queued it is no longer paired", "device"));
    t.answers[0]!.end();
    await first.ended;
    expect(t.chats.summary(id)).toMatchObject({ queued: 1, held: "device" });
    expect(t.answers).toHaveLength(1);
    expect(t.logs.join("\n")).toContain("no longer paired");
  });

  test("a queued message someone else rewrites is theirs: it runs as the device that last wrote it", async () => {
    const t = setup();
    const id = t.chat();
    const first = t.hub.start(t.spec(id, "One."));
    const { queued } = t.hub.enqueue(id, { text: "Two.", role: null, by: admin });
    expect(t.chats.queueEdit(id, queued.id, "Two, but as the phone would ask it.", phone)).toBe(true);
    expect(t.chats.queueEdit(id, 999_999, "nothing", phone)).toBe(false);
    t.answers[0]!.end();
    await first.ended;
    expect(t.prepared[0]!.queued).toMatchObject({ text: "Two, but as the phone would ask it.", by: phone });
  });

  test("so many messages queued behind one chat", () => {
    const t = setup({ maxQueued: 2 });
    const id = t.chat();
    t.hub.start(t.spec(id, "One."));
    t.hub.enqueue(id, { text: "a", role: null, by: admin });
    t.hub.enqueue(id, { text: "b", role: null, by: admin });
    expect(() => t.hub.enqueue(id, { text: "c", role: null, by: admin })).toThrow(/2 messages are already queued behind this chat, the limit/);
  });

  test("a full node: the queued message waits for room, and goes when a turn ends", async () => {
    const t = setup({ maxTurns: 1 });
    const a = t.chat("a");
    const b = t.chat("b");
    const first = t.hub.start(t.spec(a, "One."));
    // b has nothing running, but the node is full: it waits (not held).
    expect(t.hub.enqueue(b, { text: "For b.", role: null, by: admin }).started).toBeNull();
    expect(t.chats.summary(b)).toMatchObject({ queued: 1, held: null });
    t.answers[0]!.end();
    await first.ended;
    expect(t.hub.runningIn(b)).not.toBeNull();
  });
});

describe("when the node stops, and comes back", () => {
  test("turns are stopped and kept as stopped, the queue is held, and a restart sends nothing by itself", async () => {
    const path = `${process.env.TEMP ?? "/tmp"}/galahad-turns-${Date.now()}-${Math.random().toString(36).slice(2)}.db`;
    const chats = new ChatStore(path);
    const hub = new TurnHub({ chats });
    const answer = scriptedAnswer();
    const starts: string[] = [];
    const make = (conversation: string, question: string, by: QueuedBy): TurnSpec => ({ by, bank: false, role: "planner", conversation: { id: conversation, title: "t", project: null }, question, messages: [{ role: "user", content: question }], waits: { actions: [], secrets: [] }, run: answer.run });
    hub.setPrepare((conversation, queued) => {
      starts.push(queued.text);
      return make(conversation, queued.text, queued.by);
    });
    const id = chats.create({ title: "t", project: null, role: "planner" }).id;
    const turn = hub.start(make(id, "One.", admin));
    hub.enqueue(id, { text: "Two.", role: null, by: phone });
    answer.say("Half an ans");
    await settle();
    const seen: (ChatStreamEvent | null)[] = [];
    hub.subscribe(turn, (e) => seen.push(e));
    await hub.close();
    expect(turn.state).toBe("stopped");
    expect(seen.at(-2)).toEqual({ type: "stopped", reason: "node" });
    expect(seen.at(-1)).toBeNull();
    expect(() => hub.start(make(id, "x", admin))).toThrow(/stopping/);
    chats.close();

    // The node comes back.
    const again = new ChatStore(path);
    const hub2 = new TurnHub({ chats: again });
    hub2.setPrepare((conversation, queued) => {
      starts.push(queued.text);
      return make(conversation, queued.text, queued.by);
    });
    hub2.pump();
    expect(starts).toEqual([]);
    expect(again.get(id)!.messages[1]).toMatchObject({ content: "Half an ans", status: "stopped" });
    expect(again.summary(id)).toMatchObject({ queued: 1, held: "restart", state: "queued" });
    expect(again.queue(id)[0]).toMatchObject({ text: "Two.", by: phone });
    // You resume: now it's sent.
    hub2.resume(id);
    expect(starts).toEqual(["Two."]);
    await hub2.close();
    again.close();
    // (Its file goes with it, as the next test's does: a run left it in the system's temporary directory.)
    for (const file of [path, `${path}-wal`, `${path}-shm`]) rmSync(file, { force: true });
  });
});

describe("a chat store from before read and unread", () => {
  test("counts everything he answered before it as read; what he answers after is new", () => {
    const path = `${process.env.TEMP ?? "/tmp"}/galahad-unread-${Date.now()}-${Math.random().toString(36).slice(2)}.db`;
    let clock = 1_000;
    const before = new ChatStore(path, () => clock++);
    const id = before.create({ title: "Old", project: null, role: "planner" }).id;
    before.addUser(id, "Hello?");
    before.finishAnswer(id, before.startAnswer(id), { content: "Hi.", model: null, steps: [], status: "done", error: null, bank: false });
    before.close();
    // As an older node left it: no columns for when he answered, or when you read it.
    const raw = new Database(path);
    raw.exec("ALTER TABLE conversations DROP COLUMN seen_at; ALTER TABLE conversations DROP COLUMN answered_at;");
    raw.close();
    const after = new ChatStore(path, () => clock++);
    expect(after.summary(id)!.unread).toBe(false);
    expect(after.unread()).toEqual([]);
    after.finishAnswer(id, after.startAnswer(id), { content: "And again.", model: null, steps: [], status: "done", error: null, bank: false });
    expect(after.summary(id)!.unread).toBe(true);
    after.close();
    rmSync(path, { force: true });
  });
});

describe("a side question", () => {
  test("is answered from what the turn was given and what it has said and done so far, and is marked as an aside", async () => {
    const t = setup();
    const turn = t.hub.start(t.spec(null, "Fetch the report and summarise it."));
    t.answers[0]!.say("Fetching ");
    t.answers[0]!.emit({ type: "tool", id: "c1", name: "connector_call", title: "Call a connector", input: '{"tool":"report"}' });
    t.answers[0]!.emit({ type: "tool_result", id: "c1", name: "connector_call", ok: true, summary: "42 pages" });
    t.answers[0]!.say("it now.");
    await settle();
    const sofar = t.hub.sofar(turn);
    expect(sofar).toEqual({ exchange: [], said: "Fetching it now.", steps: ['Call a connector {"tool":"report"} → 42 pages'] });
    const messages = asideMessages(turn.spec.messages, sofar, "How many pages was it?");
    expect(messages.map((m) => m.role)).toEqual(["user", "assistant", "user"]);
    expect(messages[1]!.content).toBe("Fetching it now.");
    expect(messages[2]!.content).toContain("An aside from your liege, while the work above goes on.");
    expect(messages[2]!.content).toContain('- Call a connector {"tool":"report"} → 42 pages');
    expect(messages[2]!.content).toMatch(/not an instruction to change course/);
    expect(messages[2]!.content.endsWith("The aside: How many pages was it?")).toBe(true);
    t.answers[0]!.end();
  });

  test("after a steer, what was cut and the steer are part of it; only what he's done since counts as now", async () => {
    const t = setup();
    const turn = t.hub.start(t.spec(null, "Plan the week."));
    t.answers[0]!.say("Monday: ");
    await settle();
    t.hub.steer(turn.id, "Only Friday.", admin);
    t.answers[0]!.handOver();
    await settle();
    expect(t.hub.sofar(turn)).toEqual({
      exchange: [
        { role: "assistant", content: "Monday: " },
        { role: "user", content: "Only Friday." },
      ],
      said: "",
      steps: [],
    });
    const messages = asideMessages(turn.spec.messages, t.hub.sofar(turn), "Why?");
    expect(messages.map((m) => m.role)).toEqual(["user", "assistant", "user", "assistant", "user"]);
    expect(messages[3]!.content).toBe("(Still working on it: nothing said yet.)");
    t.answers[0]!.end();
  });

  test("about a chat with nothing running: its history, then the aside; the two voices always in turn", () => {
    const held = [
      { role: "user" as const, content: "What's the weather?" },
      { role: "assistant" as const, content: "Dry and cold." },
    ];
    const idle = asideMessages(held, null, "In which city?");
    expect(idle.map((m) => m.role)).toEqual(["user", "assistant", "user"]);
    expect(idle[2]!.content).toContain("about the conversation above");
    // A chat whose last answer never came (stopped before a word): the aside joins your question.
    expect(asideMessages([{ role: "user", content: "Hello?" }], null, "Still there?").map((m) => m.role)).toEqual(["user"]);
    expect(asideMessages([{ role: "assistant", content: "An answer." }], null, "Why?").map((m) => m.role)).toEqual(["user", "assistant", "user"]);
    expect(broughtBack("How many pages?", "42.")).toBe("While you worked I asked you something on the side, and you answered. Take it into account from here.\n\nMy aside: How many pages?\n\nYour answer: 42.");
  });
});

describe("what a turn leaves waiting on you", () => {
  test("approvals it filed, keys it asked for, and an answer that ends by asking are recorded with the chat; your next message clears them", async () => {
    const t = setup();
    const id = t.chat();
    const spec = t.spec(id, "Post it.");
    const turn = t.hub.start(spec);
    spec.waits.actions.push("act_1", "act_1");
    spec.waits.secrets.push("forge");
    t.answers[0]!.say("I've filed it for your approval. Shall I also tidy up?");
    t.answers[0]!.end();
    await turn.ended;
    expect(t.chats.summary(id)!.waits).toEqual({ actions: ["act_1"], secrets: ["forge"], question: true });
    const next = t.hub.start(t.spec(id, "No."));
    expect(t.chats.summary(id)!.waits).toBeNull();
    t.answers[1]!.say("Very well.");
    t.answers[1]!.end();
    await next.ended;
    expect(t.chats.summary(id)!.waits).toBeNull();
  });
});
