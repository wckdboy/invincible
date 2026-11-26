import { afterAll, beforeAll, expect, test } from "bun:test";
import type { Api } from "../api.ts";
import { openConversation, watchTurns } from "./chat.ts";

/*
 * The chat on screen kept in step with the node while another device changes it: what changed while this one was on
 * another page of the app is read again once the chat is back on screen, as it is after the app was in the background.
 */

const saved = Object.getOwnPropertyDescriptor(globalThis, "document");
beforeAll(() => Object.defineProperty(globalThis, "document", { configurable: true, value: { hidden: false } }));
afterAll(() => {
  if (saved) Object.defineProperty(globalThis, "document", saved);
  else delete (globalThis as { document?: unknown }).document;
});

test("a chat another device answered while this one was on another page is read again when it is back on screen", async () => {
  const id = "cv_AAAAAAAAAAAAAAAAAAAAAA";
  /** Which writing of the chats the node holds. */
  let chats = "lz1.4";
  const asked: string[] = [];
  const summary = { id, title: "Plans", project: null, role: "planner", pinned: false, bank: false, createdAt: 1, updatedAt: 1, count: 0, state: "done", queued: 0, held: null, needs: null };
  const api = {
    peek: () => null,
    get: async (path: string) => (asked.push(`GET ${path}`), path === "/api/turns" ? { turns: [], chats } : { conversations: [summary] }),
    post: async (path: string) => (asked.push(`POST ${path}`), { conversation: { ...summary, messages: [], turn: null, queue: [] } }),
  } as unknown as Api;
  await openConversation(api, id);
  // (What the node's live stream would say changed doesn't come here: only the look on screen is asked.)
  const follow = () => () => {};
  const shown = new AbortController();
  watchTurns(api, shown.signal, follow);
  await Bun.sleep(10);
  // To another page of the app: the chat is off screen, and nothing watches it.
  shown.abort();
  // Meanwhile another device asks in it and is answered: the node holds another writing of the chats.
  chats = "lz1.9";
  asked.length = 0;
  const back = new AbortController();
  watchTurns(api, back.signal, follow);
  await Bun.sleep(10);
  back.abort();
  expect(asked).toContain("POST /api/conversations/get");
});
