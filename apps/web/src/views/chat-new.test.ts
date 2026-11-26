import { expect, test } from "bun:test";
import type { Api } from "../api.ts";
import { restoreOpenChat, startNewChat } from "./chat.ts";

/*
 * "New chat" from outside the chat (the palette, a phone's floating button) before any chat was shown since the app
 * opened: a new chat, not the one you had open last, which the chat brings back when it's first shown otherwise.
 */

test("asked for a new chat before any was shown, a new one starts: the chat you had last isn't brought back", async () => {
  const asked: string[] = [];
  const last = { id: "cv_AAAAAAAAAAAAAAAAAAAAAA", title: "Set up my OpenAI key, please", project: null, updatedAt: 2, createdAt: 1, pinned: false, bank: false, state: "done", queued: 0, held: 0, needs: [] };
  const api = {
    peek: () => null,
    get: async (path: string) => (asked.push(`GET ${path}`), { conversations: [last] }),
    post: async (path: string) => (asked.push(`POST ${path}`), { conversation: { ...last, messages: [], role: "planner", turn: null } }),
  } as unknown as Api;
  startNewChat();
  restoreOpenChat(api);
  await new Promise((done) => setTimeout(done, 20));
  expect(asked.filter((call) => call.startsWith("POST /api/conversations/get"))).toEqual([]);
});
