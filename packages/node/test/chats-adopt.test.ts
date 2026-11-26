import { expect, test } from "bun:test";
import { ChatStore } from "../src/chats.ts";

/* A chat brought whole from the system Invincible succeeds: its id, its messages in order, its story, as they were. */

const conversation = { id: "cv_AAAAAAAAAAAAAAAAAAAAAA", title: "Plan it", project: "app", role: "chat", pinned: true, createdAt: 1_000, updatedAt: 4_000, answeredAt: 4_000, seenAt: 4_000 };
const message = (role: "user" | "assistant", content: string, at: number, status: "done" | "streaming" = "done") => ({ role, content, model: role === "assistant" ? "p/m" : null, steps: [], status, error: null, createdAt: at, endedAt: status === "done" ? at : null });

test("keeps its id, its messages in order, when it was read, and its story at the message it covered", () => {
  const chats = new ChatStore(":memory:", () => 9_000);
  chats.create({ title: "One of this node's", project: null, role: "chat" });
  const kept = chats.adopt(conversation, [message("user", "First?", 1_000), message("assistant", "First.", 2_000), message("user", "Then?", 3_000), message("assistant", "", 4_000, "streaming")], { text: "They began.", through: 1, updatedAt: 2_500 });
  expect([kept.id, kept.title, kept.project, kept.pinned, kept.unread, kept.createdAt, kept.updatedAt]).toEqual([conversation.id, "Plan it", "app", true, false, 1_000, 4_000]);
  const full = chats.get(conversation.id)!;
  expect(full.messages.map((m) => [m.role, m.content, m.status, m.createdAt])).toEqual([
    ["user", "First?", "done", 1_000],
    ["assistant", "First.", "done", 2_000],
    ["user", "Then?", "done", 3_000],
    // One that was being written when that node stopped can't finish here.
    ["assistant", "", "stopped", 4_000],
  ]);
  expect(chats.told(conversation.id).story).toEqual({ text: "They began.", through: full.messages[1]!.id });
  chats.close();
});

test("only ever under an id nobody here has, and only one that is a chat's", () => {
  const chats = new ChatStore(":memory:");
  chats.adopt(conversation, []);
  expect(() => chats.adopt(conversation, [])).toThrow(/is here already/);
  expect(() => chats.adopt({ ...conversation, id: "cv_short" }, [])).toThrow();
  expect(chats.list()).toHaveLength(1);
  chats.close();
});
