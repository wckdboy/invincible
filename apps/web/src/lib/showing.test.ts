import { describe, expect, test } from "bun:test";
import { showsEveryPush, showsThatVeryThing } from "./showing.ts";

const PAGE = "https://node.test/";
const TASK = "task-abc123def456";
const CHAT = "cv_1234567890123456789012";

describe("a notification about what the page in front shows", () => {
  test("a task's, while its own thread is in front; never another task's, or the list", () => {
    expect(showsThatVeryThing({ open: "task", task: TASK }, `${PAGE}#/task/${TASK}`)).toBe(true);
    expect(showsThatVeryThing({ open: "task", task: TASK }, `${PAGE}#/task/task-zzz999zzz999`)).toBe(false);
    expect(showsThatVeryThing({ open: "task", task: TASK }, `${PAGE}#/task`)).toBe(false);
    expect(showsThatVeryThing({ open: "task", task: TASK }, `${PAGE}#/home`)).toBe(false);
    // A task's notification that names no task is about nothing in particular.
    expect(showsThatVeryThing({ open: "task" }, `${PAGE}#/task`)).toBe(false);
  });

  test("an ask (it opens the Inbox), while the Inbox is in front", () => {
    expect(showsThatVeryThing({ open: "inbox" }, `${PAGE}#/inbox`)).toBe(true);
    expect(showsThatVeryThing({ open: "inbox" }, `${PAGE}#/inbox?focus=a`)).toBe(true);
    expect(showsThatVeryThing({ open: "inbox" }, `${PAGE}#/inboxes`)).toBe(false);
    expect(showsThatVeryThing({ open: "inbox" }, `${PAGE}#/home`)).toBe(false);
  });

  test("a chat's, only while that very chat is named in front", () => {
    expect(showsThatVeryThing({ open: "chat", conversation: CHAT }, `${PAGE}#/chat?c=${CHAT}`)).toBe(true);
    // The chat page alone doesn't say which chat it shows (and a turn someone watches is never told: the node knows).
    expect(showsThatVeryThing({ open: "chat", conversation: CHAT }, `${PAGE}#/chat`)).toBe(false);
    expect(showsThatVeryThing({ open: "chat" }, `${PAGE}#/chat`)).toBe(false);
  });

  test("a test always shows, Settings in front or not; the Overview is a place, not a thing", () => {
    expect(showsThatVeryThing({ open: "settings" }, `${PAGE}#/settings`)).toBe(false);
    expect(showsThatVeryThing({ open: "overview" }, `${PAGE}#/overview`)).toBe(false);
  });

  test("an address that can't be read is about nothing", () => {
    expect(showsThatVeryThing({ open: "inbox" }, undefined)).toBe(false);
    expect(showsThatVeryThing({ open: "inbox" }, "not a url")).toBe(false);
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
