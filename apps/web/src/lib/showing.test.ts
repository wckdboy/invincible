import { describe, expect, test } from "bun:test";
import { isShowingQuestion, readShowing, SHOWING_QUESTION, showingAnswer, showsEveryPush, showsThatVeryThing } from "./showing.ts";

const TASK = "task-abc123def456";
const CHAT = "cv_1234567890123456789012";

describe("a notification about what the page in front shows", () => {
  test("a task's, while its own thread is in front; never another task's, or the list", () => {
    expect(showsThatVeryThing({ open: "task", task: TASK }, `#/task/${TASK}`)).toBe(true);
    expect(showsThatVeryThing({ open: "task", task: TASK }, `#/task/task-zzz999zzz999`)).toBe(false);
    expect(showsThatVeryThing({ open: "task", task: TASK }, `#/task`)).toBe(false);
    expect(showsThatVeryThing({ open: "task", task: TASK }, `#/home`)).toBe(false);
    // A task's notification that names no task is about nothing in particular.
    expect(showsThatVeryThing({ open: "task" }, `#/task`)).toBe(false);
  });

  test("an ask (it opens the Inbox), while the Inbox is in front", () => {
    expect(showsThatVeryThing({ open: "inbox" }, `#/inbox`)).toBe(true);
    expect(showsThatVeryThing({ open: "inbox" }, `#/inbox?focus=a`)).toBe(true);
    expect(showsThatVeryThing({ open: "inbox" }, `#/inboxes`)).toBe(false);
    expect(showsThatVeryThing({ open: "inbox" }, `#/home`)).toBe(false);
  });

  test("a chat's, only while that very chat is named in front", () => {
    expect(showsThatVeryThing({ open: "chat", conversation: CHAT }, `#/chat?c=${CHAT}`)).toBe(true);
    // The chat page alone doesn't say which chat it shows (and a turn someone watches is never told: the node knows).
    expect(showsThatVeryThing({ open: "chat", conversation: CHAT }, `#/chat`)).toBe(false);
    expect(showsThatVeryThing({ open: "chat" }, `#/chat`)).toBe(false);
  });

  test("a test always shows, Settings in front or not; the Overview is a place, not a thing", () => {
    expect(showsThatVeryThing({ open: "settings" }, `#/settings`)).toBe(false);
    expect(showsThatVeryThing({ open: "overview" }, `#/overview`)).toBe(false);
  });

  test("a page that said nothing it could be read by is showing nothing", () => {
    expect(showsThatVeryThing({ open: "inbox" }, null)).toBe(false);
    expect(showsThatVeryThing({ open: "inbox" }, "")).toBe(false);
  });
});

describe("asking the page in front what it shows", () => {
  test("its answer is its own address, read strictly", () => {
    expect(SHOWING_QUESTION).toEqual({ type: "invincible:showing?" });
    expect([isShowingQuestion(SHOWING_QUESTION), isShowingQuestion({ type: "invincible:open" }), isShowingQuestion(null)]).toEqual([true, false, false]);
    expect(showingAnswer("#/task/task-abc123def456")).toEqual({ type: "invincible:showing", hash: "#/task/task-abc123def456" });
    expect(readShowing(showingAnswer("#/inbox"))).toBe("#/inbox");
    // Only the app's own kind of address, and nothing that isn't one.
    for (const strange of [null, "#/inbox", { type: "invincible:showing" }, { type: "invincible:showing", hash: 4 }, { type: "other", hash: "#/inbox" }, { type: "invincible:showing", hash: "javascript:alert(1)" }, { type: "invincible:showing", hash: `#/${"x".repeat(300)}` }]) {
      expect(readShowing(strange)).toBeNull();
    }
    // A page with no hash yet is at its home: it says "" and that is read as nothing in particular.
    expect(readShowing(showingAnswer(""))).toBe("");
  });
});

describe("a browser that must show every push", () => {
  test("Apple's push service (Safari, a Home Screen app) takes away a subscription whose pushes show nothing", () => {
    expect(showsEveryPush("https://web.push.apple.com/QO6eYv9")).toBe(true);
    expect(showsEveryPush("https://api.push.apple.com/3/device/x")).toBe(true);
    expect(showsEveryPush("https://fcm.googleapis.com/fcm/send/abc")).toBe(false);
    expect(showsEveryPush("https://updates.push.services.mozilla.com/wpush/v2/abc")).toBe(false);
    expect(showsEveryPush("https://wns2-db5p.notify.windows.com/w/?token=abc")).toBe(false);
    // Unknown, or no subscription at all: shown, to be safe.
    expect(showsEveryPush(undefined)).toBe(true);
    expect(showsEveryPush("not a url")).toBe(true);
    expect(showsEveryPush("https://push.apple.com.evil.example/x")).toBe(true);
  });
});
