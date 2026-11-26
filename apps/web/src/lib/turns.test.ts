import { describe, expect, test } from "bun:test";
import type { ChatStreamEvent, StoredMessage } from "@galahad/core";
import { applyEvent, asideOf, beginTurn, composerAction, composerHint, connectorsAskedIn, endTurn, failTurn, keptDiffers, keysAskedIn, shownAgain, stateBadge, type Step, stopsIn, type Thread, type Turn, turnOf } from "./turns.ts";

const fresh = (): Thread => ({ turns: [], nextId: 1, target: null, base: null });
const shape = (thread: Thread) => thread.turns.map((t) => [t.role, t.content, t.status]);
const feed = (thread: Thread, events: ChatStreamEvent[], now = 1000) => events.map((e) => applyEvent(thread, e, now));
const turnEvent = (over: Partial<Extract<ChatStreamEvent, { type: "turn" }>> = {}): ChatStreamEvent => ({ type: "turn", id: "tn_x", conversation: "cv_x", answer: 2, role: "planner", startedAt: 500, deadline: 500 + 30 * 60_000, replay: false, ...over });

describe("what sending does while he works", () => {
  test("nothing running: it sends, whatever the keys", () => {
    for (const enter of ["steer", "queue"] as const) for (const modifier of [false, true]) expect(composerAction({ busy: false, enter, modifier, canQueue: true })).toBe("send");
  });

  test("Enter does what this device chose, the modifier does the other", () => {
    expect(composerAction({ busy: true, enter: "steer", modifier: false, canQueue: true })).toBe("steer");
    expect(composerAction({ busy: true, enter: "steer", modifier: true, canQueue: true })).toBe("queue");
    expect(composerAction({ busy: true, enter: "queue", modifier: false, canQueue: true })).toBe("queue");
    expect(composerAction({ busy: true, enter: "queue", modifier: true, canQueue: true })).toBe("steer");
  });

  test("a temporary chat is kept nowhere, so there's nowhere to queue: both steer", () => {
    expect(composerAction({ busy: true, enter: "queue", modifier: false, canQueue: false })).toBe("steer");
    expect(composerAction({ busy: true, enter: "steer", modifier: true, canQueue: false })).toBe("steer");
  });

  test("the hint says what the keys do now", () => {
    expect(composerHint({ busy: false, enter: "steer", canQueue: true, coarse: false, mac: false })).toBe("Enter to send · Shift+Enter for a new line");
    expect(composerHint({ busy: true, enter: "steer", canQueue: true, coarse: false, mac: false })).toBe("Enter steers him now · Ctrl+Enter queues it · Esc stops him");
    expect(composerHint({ busy: true, enter: "queue", canQueue: true, coarse: false, mac: true })).toBe("Enter queues it · ⌘+Enter steers him now · Esc stops him");
    expect(composerHint({ busy: true, enter: "queue", canQueue: false, coarse: false, mac: false })).toBe("Enter steers him now · Esc stops him");
    expect(composerHint({ busy: false, enter: "steer", canQueue: true, coarse: true, mac: false })).toBe("");
    expect(composerHint({ busy: true, enter: "steer", canQueue: true, coarse: true, mac: false })).toBe("");
  });

  test("a side question typed into the composer", () => {
    expect(asideOf("/btw how long will this take?")).toBe("how long will this take?");
    expect(asideOf("  /aside   where is it?\nand why")).toBe("where is it?\nand why");
    expect(asideOf("/btw")).toBe("");
    expect(asideOf("by the way /btw")).toBeNull();
    expect(asideOf("/btween us")).toBeNull();
  });
});

describe("a chat's state as a badge", () => {
  const none = { queued: 0, held: null, needs: null };
  test("working is live; needs-you and a held queue are amber; failed is red; done says nothing", () => {
    expect(stateBadge({ state: "working", ...none })).toEqual({ text: "Working", tone: "accent", live: true });
    expect(stateBadge({ state: "waiting", ...none, needs: { approvals: 1, keys: 0, question: false } })).toEqual({ text: "Needs you: an approval", tone: "warn", live: false });
    expect(stateBadge({ state: "queued", queued: 2, held: null, needs: null })).toEqual({ text: "2 queued", tone: "info", live: false });
    expect(stateBadge({ state: "queued", queued: 2, held: "restart", needs: null })).toEqual({ text: "2 queued, held (the node restarted)", tone: "warn", live: false });
    expect(stateBadge({ state: "failed", ...none })).toEqual({ text: "Failed", tone: "danger", live: false });
    expect(stateBadge({ state: "stopped", ...none })).toEqual({ text: "Stopped", tone: "neutral", live: false });
    expect(stateBadge({ state: "done", ...none })).toBeNull();
  });
});

describe("a turn's stream, as the thread on screen", () => {
  test("the page that starts it: your message, then the answer as it's written, settled when the stream ends", () => {
    const thread = fresh();
    const answer = beginTurn(thread, "How's the weather?", "planner", 100);
    expect(thread.base).toBe(1);
    const changed = feed(thread, [turnEvent(), { type: "conversation", id: "cv_x", title: "t", project: null }, { type: "model", ref: "a/m" }, { type: "text", text: "Dry " }, { type: "text", text: "and cold." }, { type: "done", ref: "a/m" }]);
    expect(changed).toEqual([null, null, answer, answer, answer, answer]);
    expect(answer.sid).toBe(2);
    expect(endTurn(thread, 2000)).toBe(answer);
    expect(shape(thread)).toEqual([
      ["user", "How's the weather?", "done"],
      ["assistant", "Dry and cold.", "done"],
    ]);
    expect(answer.steps.map((s) => [s.text, s.state])).toEqual([
      ["Asked as planner", "done"],
      ["Thinking with a/m", "done"],
      ["Answering", "done"],
    ]);
    expect(answer.endedAt).toBe(2000);
    expect(thread.target).toBeNull();
    expect(thread.base).toBeNull();
  });

  test("tools show as steps with how they went; a fallback marks the model that didn't answer", () => {
    const thread = fresh();
    const answer = beginTurn(thread, "q", "planner", 0);
    feed(thread, [
      { type: "model", ref: "a/one" },
      { type: "fallback", from: "a/one", error: "overloaded" },
      { type: "model", ref: "a/two" },
      { type: "tool", id: "c1", name: "recall", title: "Recall from the shared mind", input: '{"query":"x"}' },
      { type: "tool_result", id: "c1", name: "recall", ok: true, summary: "2 memories" },
      { type: "tool", id: "c2", name: "connector_call", title: "Call a connector tool", input: "" },
      { type: "tool_result", id: "c2", name: "connector_call", ok: false, summary: "not run: your new message came first" },
    ]);
    expect(answer.fallbacks).toBe(1);
    expect(answer.steps.slice(1).map((s) => [s.text, s.state, s.detail, s.toolName])).toEqual([
      ["a/one didn't answer", "warn", "overloaded", undefined],
      ["Thinking with a/two", "done", undefined, undefined],
      ["Recall from the shared mind", "done", '{"query":"x"} → 2 memories', "recall"],
      ["Call a connector tool", "warn", "not run: your new message came first", "connector_call"],
    ]);
  });

  test("a steer: the answer so far stands, your message follows, and a new answer begins with the same model", () => {
    const thread = fresh();
    beginTurn(thread, "About my bank?", "planner", 0);
    const changed = feed(thread, [{ type: "model", ref: "a/m" }, { type: "text", text: "Your bank, " }, { type: "steer", text: "Never mind. The weather?" }, { type: "text", text: "Dry." }, { type: "done", ref: "a/m" }]);
    expect(changed[2]).toBe("all");
    endTurn(thread, 9);
    expect(shape(thread)).toEqual([
      ["user", "About my bank?", "done"],
      ["assistant", "Your bank, ", "steered"],
      ["user", "Never mind. The weather?", "done"],
      ["assistant", "Dry.", "done"],
    ]);
    expect(thread.turns[1]!.steps.at(-1)).toMatchObject({ text: "Your message reached him here", state: "done" });
    expect(thread.turns[3]!.model).toBe("a/m");
  });

  test("a steer before he'd said or done anything leaves no empty answer", () => {
    const thread = fresh();
    beginTurn(thread, "Plan my week.", "planner", 0);
    feed(thread, [{ type: "model", ref: "a/m" }, { type: "steer", text: "Only Monday." }, { type: "steer", text: "Briefly." }, { type: "text", text: "Rest." }]);
    endTurn(thread, 9);
    expect(shape(thread)).toEqual([
      ["user", "Plan my week.", "done"],
      ["user", "Only Monday.", "done"],
      ["user", "Briefly.", "done"],
      ["assistant", "Rest.", "done"],
    ]);
  });

  test("stopped, and failed, each say so", () => {
    const stopped = fresh();
    beginTurn(stopped, "q", "planner", 0);
    feed(stopped, [{ type: "text", text: "Half" }, { type: "stopped", reason: "you" }]);
    expect(endTurn(stopped, 5)).toMatchObject({ status: "stopped", content: "Half" });
    expect(stopped.turns[1]!.steps.at(-1)).toMatchObject({ text: "Stopped by you", state: "warn" });
    const limit = fresh();
    beginTurn(limit, "q", "planner", 0);
    feed(limit, [{ type: "stopped", reason: "node" }]);
    expect(limit.turns[1]!.steps.at(-1)!.text).toBe("Stopped: the node itself was stopping");
    const failed = fresh();
    beginTurn(failed, "q", "planner", 0);
    feed(failed, [{ type: "error", error: "no model could answer" }]);
    expect(endTurn(failed, 5)).toMatchObject({ status: "error", error: "no model could answer" });
    expect(failed.turns[1]!.steps.at(-1)).toMatchObject({ text: "Couldn't answer", state: "error" });
  });
});

describe("attaching to a turn already under way", () => {
  const stored = (id: number, role: "user" | "assistant", content: string, status: StoredMessage["status"] = "done"): StoredMessage => ({ id, role, content, model: role === "assistant" ? "a/m" : null, steps: [], status, error: null, createdAt: id * 10, endedAt: status === "streaming" ? null : id * 10 + 5 });
  /** A page that just loaded the kept chat from the node. */
  const loaded = (messages: StoredMessage[]): Thread => {
    const thread = fresh();
    for (const m of messages) thread.turns.push(turnOf(m, "planner", thread.nextId++));
    return thread;
  };

  test("after a reload: the kept chat's unfinished answer is rebuilt from the replay, then goes on live", () => {
    const thread = loaded([stored(1, "user", "Earlier."), stored(2, "assistant", "Earlier answer."), stored(3, "user", "Tell me a story."), stored(4, "assistant", "", "streaming")]);
    const changed = feed(thread, [turnEvent({ answer: 4, replay: true }), { type: "model", ref: "a/m" }, { type: "text", text: "Once upon a time" }]);
    expect(changed[0]).toBe("all");
    expect(shape(thread)).toEqual([
      ["user", "Earlier.", "done"],
      ["assistant", "Earlier answer.", "done"],
      ["user", "Tell me a story.", "done"],
      ["assistant", "Once upon a time", "streaming"],
    ]);
    expect(thread.turns[3]!.sid).toBe(4);
    feed(thread, [{ type: "text", text: ", the end." }, { type: "done", ref: "a/m" }]);
    endTurn(thread, 99);
    expect(thread.turns[3]).toMatchObject({ content: "Once upon a time, the end.", status: "done" });
  });

  test("a turn that was steered before the reload: the cut answer and the steer come from the replay, once", () => {
    // The node kept: question, the answer a steer cut, the steer, the answer it's writing now.
    const thread = loaded([stored(1, "user", "About my bank?"), stored(2, "assistant", "Your bank, ", "steered"), stored(3, "user", "The weather?"), stored(4, "assistant", "", "streaming")]);
    feed(thread, [turnEvent({ answer: 2, replay: true }), { type: "model", ref: "a/m" }, { type: "text", text: "Your bank, " }, { type: "steer", text: "The weather?" }, { type: "text", text: "Dry" }]);
    expect(shape(thread)).toEqual([
      ["user", "About my bank?", "done"],
      ["assistant", "Your bank, ", "steered"],
      ["user", "The weather?", "done"],
      ["assistant", "Dry", "streaming"],
    ]);
  });

  test("…and when the first answer came to nothing and wasn't kept, the replay still lands in the right place", () => {
    // Kept: question (1), the steer (3), the answer being written (4). The turn's first answer (2) was never kept.
    const thread = loaded([stored(1, "user", "Plan my week."), stored(3, "user", "Only Monday."), stored(4, "assistant", "", "streaming")]);
    feed(thread, [turnEvent({ answer: 2, replay: true }), { type: "model", ref: "a/m" }, { type: "steer", text: "Only Monday." }, { type: "text", text: "Rest." }]);
    expect(shape(thread)).toEqual([
      ["user", "Plan my week.", "done"],
      ["user", "Only Monday.", "done"],
      ["assistant", "Rest.", "streaming"],
    ]);
  });

  test("the page that started it, after its connection dropped: rebuilt from where its own answers began, nothing twice", () => {
    const thread = fresh();
    beginTurn(thread, "Plan my week.", "planner", 0);
    feed(thread, [turnEvent({ answer: 2 }), { type: "model", ref: "a/m" }, { type: "steer", text: "Only Monday." }, { type: "text", text: "Re" }]);
    // The stream drops; the page attaches again and the node replays the turn from its start.
    feed(thread, [turnEvent({ answer: 2, replay: true }), { type: "model", ref: "a/m" }, { type: "steer", text: "Only Monday." }, { type: "text", text: "Rest." }, { type: "done", ref: "a/m" }]);
    endTurn(thread, 9);
    expect(shape(thread)).toEqual([
      ["user", "Plan my week.", "done"],
      ["user", "Only Monday.", "done"],
      ["assistant", "Rest.", "done"],
    ]);
  });

  test("a temporary chat's turn (kept nowhere) is rebuilt the same way by the page that still holds it", () => {
    const thread = fresh();
    beginTurn(thread, "A passing thought.", "planner", 0);
    feed(thread, [turnEvent({ conversation: null, answer: null }), { type: "model", ref: "a/m" }, { type: "text", text: "Not" }]);
    feed(thread, [turnEvent({ conversation: null, answer: null, replay: true }), { type: "model", ref: "a/m" }, { type: "text", text: "Noted." }]);
    endTurn(thread, 9);
    expect(shape(thread)).toEqual([
      ["user", "A passing thought.", "done"],
      ["assistant", "Noted.", "done"],
    ]);
  });

  test("the watching failing isn't the turn failing: the answer says what happened", () => {
    const thread = fresh();
    beginTurn(thread, "q", "planner", 0);
    feed(thread, [{ type: "text", text: "Half" }]);
    expect(failTurn(thread, "The node restarted while he was answering.", 7)).toMatchObject({ status: "error", content: "Half", error: "The node restarted while he was answering." });
    expect(thread.target).toBeNull();
  });
});

describe("a kept chat that changed elsewhere", () => {
  const kept = (id: number, role: "user" | "assistant", content: string, status: StoredMessage["status"] = "done"): StoredMessage =>
    ({ id, role, content, status, model: role === "assistant" ? "m" : null, steps: [], error: null, createdAt: id, endedAt: id }) as StoredMessage;
  const shown = (messages: StoredMessage[]) => messages.map((m, i) => turnOf(m, "planner", i + 1));
  const chat = [kept(1, "user", "Remember Friday."), kept(2, "assistant", "Noted: Friday.")];

  test("what's on screen is what the node keeps: nothing to show again", () => {
    expect(keptDiffers(shown(chat), chat)).toBe(false);
  });

  test("another device asked and was answered, retried, or stopped him: shown again", () => {
    expect(keptDiffers(shown(chat), [...chat, kept(3, "user", "And Saturday?"), kept(4, "assistant", "Saturday too.")])).toBe(true);
    expect(keptDiffers(shown(chat), [chat[0]!, kept(5, "assistant", "Friday it is.")])).toBe(true);
    expect(keptDiffers(shown([chat[0]!, kept(2, "assistant", "Not", "streaming")]), [chat[0]!, kept(2, "assistant", "Noted: Friday.", "stopped")])).toBe(true);
    expect(keptDiffers(shown(chat), [chat[0]!])).toBe(true);
  });

  test("a turn of this device's, not yet told its kept id, is matched by its words and state: not shown again for that alone", () => {
    const own = shown(chat).map((t) => ({ ...t, sid: undefined }));
    expect(keptDiffers(own, chat)).toBe(false);
    expect(keptDiffers(own, [chat[0]!, kept(2, "assistant", "Noted: Saturday.")])).toBe(true);
  });

  /** The chat on screen after a message of this device's that the node never took (it was full): its question, and why. */
  const refused = (): Thread => {
    const thread: Thread = { turns: shown(chat), nextId: 3, target: null, base: null };
    beginTurn(thread, "And Sunday?", "planner", 10);
    failTurn(thread, "This node is already working on 3 turns, its limit.", 11);
    return thread;
  };
  const again = (thread: Thread, messages: StoredMessage[]) => shownAgain(thread.turns, messages, (m) => turnOf(m, "planner", thread.nextId++));

  test("a message the node never took is kept nowhere else: it stays on screen, with why, when the chat is read again", () => {
    expect(again(refused(), chat)).toBeNull();
  });

  test("what another device asked meanwhile is shown, and the message the node never took stays after it", () => {
    const shownNow = again(refused(), [...chat, kept(3, "user", "And Saturday?"), kept(4, "assistant", "Saturday too.")]);
    expect(shownNow?.map((t) => [t.role, t.content, t.status, t.error ?? null])).toEqual([
      ["user", "Remember Friday.", "done", null],
      ["assistant", "Noted: Friday.", "done", null],
      ["user", "And Saturday?", "done", null],
      ["assistant", "Saturday too.", "done", null],
      ["user", "And Sunday?", "done", null],
      ["assistant", "", "error", "This node is already working on 3 turns, its limit."],
    ]);
  });

  test("a message the node did take after all (it holds that question) is shown as the node keeps it, once", () => {
    const shownNow = again(refused(), [...chat, kept(3, "user", "And Sunday?"), kept(4, "assistant", "Sunday as well.")]);
    expect(shownNow?.map((t) => t.content)).toEqual(["Remember Friday.", "Noted: Friday.", "And Sunday?", "Sunday as well."]);
  });

  test("an answer the node kept (its kept id is known) that failed is never held back: the node's chat is shown as it is", () => {
    const thread: Thread = { turns: shown([...chat, kept(3, "user", "And Sunday?"), kept(4, "assistant", "", "error")]), nextId: 5, target: null, base: null };
    const shownNow = again(thread, [...chat, kept(3, "user", "And Sunday?"), kept(4, "assistant", "", "error"), kept(5, "user", "And Monday?"), kept(6, "assistant", "Monday.")]);
    expect(shownNow?.map((t) => t.content)).toEqual(["Remember Friday.", "Noted: Friday.", "And Sunday?", "", "And Monday?", "Monday."]);
  });
});

describe("small words", () => {
  test("when a turn stops by itself", () => {
    expect(stopsIn(30 * 60_000, 3 * 60_000)).toBe("stops by itself in 27 min");
    expect(stopsIn(1000, 990)).toBe("stops by itself within a minute");
  });
});

describe("keys he asked for in a chat", () => {
  const turn = (steps: Step[]): Turn => ({ id: 1, role: "assistant", content: "", steps, status: "done", fallbacks: 0, startedAt: 0 });
  const asked = (name: string, extra = ""): Step => ({ icon: "zap", text: "Ask the user for a credential", detail: `{"name":"${name}","purpose":"To open the pull request"${extra}} → Requested "${name}".`, state: "done", tool: `call_${name}`, toolName: "request_secret" });

  test("each key named by his request_secret steps, once, in the order he asked", () => {
    expect(keysAskedIn([turn([asked("github-token")]), turn([asked("deepseek"), asked("github-token")])])).toEqual(["github-token", "deepseek"]);
  });

  test("only his requests' names: another tool's arguments, or words that only look like one, aren't keys he asked for", () => {
    const other: Step = { icon: "zap", text: "Recall", detail: '{"name":"github-token"}', state: "done", tool: "call_x", toolName: "recall" };
    expect(keysAskedIn([turn([other])])).toEqual([]);
    expect(keysAskedIn([turn([{ ...asked("ok"), detail: '{"purpose":"a \\"name\\":\\"trick\\""}' }])])).toEqual([]);
    expect(keysAskedIn([])).toEqual([]);
  });
});

describe("connectors he asked for in a chat", () => {
  const turn = (steps: Step[]): Turn => ({ id: 1, role: "assistant", content: "", steps, status: "done", fallbacks: 0, startedAt: 0 });
  const asked = (connector: string): Step => ({ icon: "plug", text: "Ask the user for a connector", detail: `{"connector":"${connector}","why":"To read the invoices"} → Asked for ${connector}.`, state: "done", tool: `call_${connector}`, toolName: "connector_request" });

  test("each connector named by his connector_request steps, once, in the order he asked", () => {
    expect(connectorsAskedIn([turn([asked("gmail")]), turn([asked("slack"), asked("gmail")])])).toEqual(["gmail", "slack"]);
  });

  test("only his requests' connectors: a call to one, or a name no connector can have, isn't a request", () => {
    const call: Step = { icon: "plug", text: "Call a connector tool", detail: '{"connector":"github","tool":"issues"}', state: "done", tool: "call_x", toolName: "connector_call" };
    expect(connectorsAskedIn([turn([call])])).toEqual([]);
    expect(connectorsAskedIn([turn([asked("Not A Connector")])])).toEqual([]);
    expect(connectorsAskedIn([])).toEqual([]);
  });
});
