import { describe, expect, test } from "bun:test";
import { chatState, chatStateWords, endsWithQuestion, holdAfter, holdWords, mayDrain, needsWords, TURN_ID } from "../src/turns.ts";

const none = { approvals: 0, keys: 0, question: false };

describe("a chat's state at a glance", () => {
  test("a running turn comes first, then what needs you, then the queue, then how the last answer ended", () => {
    expect(chatState({ running: true, needs: { ...none, approvals: 1 }, queued: 2, last: "error" })).toBe("working");
    expect(chatState({ running: false, needs: { ...none, approvals: 1 }, queued: 2, last: "done" })).toBe("waiting");
    expect(chatState({ running: false, needs: { ...none, keys: 1 }, queued: 0, last: "done" })).toBe("waiting");
    expect(chatState({ running: false, needs: { ...none, question: true }, queued: 0, last: "done" })).toBe("waiting");
    expect(chatState({ running: false, needs: none, queued: 2, last: "stopped" })).toBe("queued");
    expect(chatState({ running: false, needs: null, queued: 0, last: "error" })).toBe("failed");
    expect(chatState({ running: false, needs: null, queued: 0, last: "stopped" })).toBe("stopped");
    // The node went down mid-answer: it can't finish any more.
    expect(chatState({ running: false, needs: null, queued: 0, last: "streaming" })).toBe("stopped");
    expect(chatState({ running: false, needs: null, queued: 0, last: "done" })).toBe("done");
    expect(chatState({ running: false, needs: null, queued: 0, last: "steered" })).toBe("done");
    expect(chatState({ running: false, needs: null, queued: 0, last: null })).toBe("done");
  });

  test("in words", () => {
    expect(chatStateWords({ state: "working", queued: 0, held: null, needs: null })).toBe("Working");
    expect(chatStateWords({ state: "working", queued: 2, held: null, needs: null })).toBe("Working · 2 queued");
    expect(chatStateWords({ state: "waiting", queued: 0, held: null, needs: { approvals: 2, keys: 1, question: true } })).toBe("Needs you: 2 approvals and a key");
    expect(chatStateWords({ state: "waiting", queued: 0, held: null, needs: { ...none, question: true } })).toBe("Needs you: an answer");
    expect(chatStateWords({ state: "queued", queued: 1, held: "stopped", needs: null })).toBe("1 queued, held (you stopped him)");
    expect(chatStateWords({ state: "queued", queued: 3, held: null, needs: null })).toBe("3 queued");
    expect(chatStateWords({ state: "stopped", queued: 0, held: null, needs: null })).toBe("Stopped");
    expect(chatStateWords({ state: "failed", queued: 0, held: null, needs: null })).toBe("Failed");
    expect(chatStateWords({ state: "done", queued: 0, held: null, needs: null })).toBe("");
    expect(needsWords({ approvals: 1, keys: 0, question: false })).toBe("an approval");
    expect(holdWords("restart")).toBe("the node restarted");
    expect(holdWords("device")).toBe("the device that queued the next one is no longer paired, or may not see this chat");
  });
});

describe("the queue's rules", () => {
  test("a turn that ended well holds nothing; a stop or a failure holds what's queued behind it", () => {
    expect(holdAfter("done", 3)).toBeNull();
    expect(holdAfter("stopped", 3)).toBe("stopped");
    expect(holdAfter("error", 1)).toBe("error");
    expect(holdAfter("stopped", 0)).toBeNull();
    expect(holdAfter("running", 2)).toBeNull();
  });

  test("the next message goes only when nothing runs in the chat, nothing holds it, and the node has room", () => {
    const node = { running: 1, maxTurns: 4 };
    expect(mayDrain({ running: false, held: null, queued: 1 }, node)).toBe(true);
    expect(mayDrain({ running: true, held: null, queued: 1 }, node)).toBe(false);
    expect(mayDrain({ running: false, held: "stopped", queued: 1 }, node)).toBe(false);
    expect(mayDrain({ running: false, held: "restart", queued: 1 }, node)).toBe(false);
    expect(mayDrain({ running: false, held: null, queued: 0 }, node)).toBe(false);
    expect(mayDrain({ running: false, held: null, queued: 1 }, { running: 4, maxTurns: 4 })).toBe(false);
  });
});

describe("small things", () => {
  test("an answer that ends by asking", () => {
    expect(endsWithQuestion("I found two. Which one shall I take?")).toBe(true);
    expect(endsWithQuestion("Done.\n\n**Shall I go on?**")).toBe(true);
    expect(endsWithQuestion("Is it done? Yes.")).toBe(false);
    expect(endsWithQuestion("")).toBe(false);
  });

  test("a turn's id", () => {
    expect(TURN_ID.test(`tn_${"a".repeat(22)}`)).toBe(true);
    expect(TURN_ID.test("tn_short")).toBe(false);
    expect(TURN_ID.test(`cv_${"a".repeat(22)}`)).toBe(false);
  });
});
