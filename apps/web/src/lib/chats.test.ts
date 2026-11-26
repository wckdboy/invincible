import { describe, expect, test } from "bun:test";
import type { ConversationSummary, StoredMessage } from "@galahad/core";
import { chatActions, CHATS_MENU, filterConversations, groupConversations, mostRecent, projectIdFrom, stepsOf } from "./chats.ts";

const now = new Date(2026, 10, 10, 15, 0).getTime();
const HOUR = 3_600_000;
const chat = (over: Partial<ConversationSummary> = {}): ConversationSummary => ({
  id: "cv_0000000000000000000000",
  title: "A chat",
  project: null,
  role: "planner",
  pinned: false,
  createdAt: now,
  updatedAt: now,
  count: 2,
  bank: false,
  state: "done",
  queued: 0,
  held: null,
  needs: null,
  ...over,
});

describe("your chats", () => {
  test("pinned first, then today, yesterday, this week and earlier, newest first in each", () => {
    const groups = groupConversations(
      [
        chat({ id: "old", updatedAt: now - 30 * 24 * HOUR }),
        chat({ id: "today-early", updatedAt: now - 5 * HOUR }),
        chat({ id: "today-late", updatedAt: now - HOUR }),
        chat({ id: "yesterday", updatedAt: now - 20 * HOUR }),
        chat({ id: "week", updatedAt: now - 4 * 24 * HOUR }),
        chat({ id: "pinned-old", pinned: true, updatedAt: now - 60 * 24 * HOUR }),
      ],
      now,
    );
    expect(groups.map((g) => [g.label, g.items.map((c) => c.id)])).toEqual([
      ["Pinned", ["pinned-old"]],
      ["Today", ["today-late", "today-early"]],
      ["Yesterday", ["yesterday"]],
      ["This week", ["week"]],
      ["Earlier", ["old"]],
    ]);
  });

  test("search: every word, in the title or the project, any case", () => {
    const list = [chat({ id: "a", title: "Rocket nozzle sizing", project: "rocket" }), chat({ id: "b", title: "Groceries in October" }), chat({ id: "c", title: "Weekly plan", project: "rocket" })];
    expect(filterConversations(list, "ROCKET").map((c) => c.id)).toEqual(["a", "c"]);
    expect(filterConversations(list, "rocket plan").map((c) => c.id)).toEqual(["c"]);
    expect(filterConversations(list, "  ")).toHaveLength(3);
  });

  test("a chat is found by the project name its row shows, not only the project's id", () => {
    const list = [chat({ id: "a", title: "Uptime", project: "site" }), chat({ id: "b", title: "Backups", project: "homelab" })];
    const names: Record<string, string> = { site: "The site", homelab: "Home lab" };
    expect(filterConversations(list, "home lab", (id) => names[id] ?? id).map((c) => c.id)).toEqual(["b"]);
    expect(filterConversations(list, "the site", (id) => names[id] ?? id).map((c) => c.id)).toEqual(["a"]);
  });

  test("a kept answer's steps read as they did while it streamed", () => {
    const answer: StoredMessage = {
      id: 2,
      role: "assistant",
      content: "Three.",
      model: "anthropic/claude-opus-5-5",
      steps: [
        { kind: "fallback", from: "anthropic/claude-opus-5-5", error: "no key" },
        { kind: "model", ref: "orcarouter/anthropic/claude-opus-5.5" },
        { kind: "tool", id: "t1", name: "bank_transactions", title: "Bank transactions", input: '{"limit":1}', ok: true, summary: "648 characters of data" },
        { kind: "tool", id: "t2", name: "web_search", title: "Search the web", input: "", ok: false, summary: "refused: bank data is in this answer" },
      ],
      status: "done",
      error: null,
      createdAt: now,
      endedAt: now + 5000,
    };
    expect(stepsOf(answer, "planner").map((s) => [s.kind, s.text, s.state, s.detail ?? ""])).toEqual([
      ["asked", "Asked as planner", "done", ""],
      ["fallback", "anthropic/claude-opus-5-5 didn't answer", "warn", "no key"],
      ["model", "Thinking with orcarouter/anthropic/claude-opus-5.5", "done", ""],
      ["tool", "Bank transactions", "done", '{"limit":1} → 648 characters of data'],
      ["tool", "Search the web", "warn", "refused: bank data is in this answer"],
      ["answer", "Answering", "done", ""],
    ]);
    expect(stepsOf({ ...answer, content: "", steps: [], status: "stopped" }, "swift").map((s) => s.kind)).toEqual(["asked", "stopped"]);
  });
});

describe("project ids", () => {
  test("from the name: lowercase, dashes, Danish letters spelled out, unique", () => {
    expect(projectIdFrom("Rocket Engine v2")).toBe("rocket-engine-v2");
    expect(projectIdFrom("Ærø Sø-Både")).toBe("aero-so-bade");
    expect(projectIdFrom("  !!! ")).toBe("project");
    expect(projectIdFrom("Rocket", ["rocket", "rocket-2"])).toBe("rocket-3");
  });
});

describe("the conversation Galahad's row opens", () => {
  test("is the one last active, whatever order the node lists them in, and a pin doesn't make one more recent", () => {
    const list = [chat({ id: "cv_old", updatedAt: now - 5 * HOUR, pinned: true }), chat({ id: "cv_latest", updatedAt: now - HOUR }), chat({ id: "cv_middle", updatedAt: now - 2 * HOUR })];
    expect(mostRecent(list)?.id).toBe("cv_latest");
    expect(mostRecent([...list].reverse())?.id).toBe("cv_latest");
  });
  test("with nothing kept yet there is none: a new chat", () => {
    expect(mostRecent([])).toBeNull();
  });
});

describe("a chat's one menu", () => {
  test("a new chat and every kept one are always in it: his history is never hidden", () => {
    expect(CHATS_MENU.map((action) => [action.value, action.label])).toEqual([["new", "New chat"], ["history", "All chats…"]]);
  });
  const values = (chat: Parameters<typeof chatActions>[0]) => chatActions(chat).map((action) => action.value);
  test("a kept chat can be asked about on the side, renamed, pinned and deleted", () => {
    expect(values({ kept: true, pinned: false, aside: true, node: "keep" })).toEqual(["aside", "rename", "pin", "delete"]);
    const actions = chatActions({ kept: true, pinned: false, aside: true, node: "keep" });
    expect(actions.find((action) => action.value === "pin")!.label).toBe("Pin to the top of your chats");
    expect(actions.find((action) => action.value === "delete")!.meta).toBe("For good, on keep");
    expect(chatActions({ kept: true, pinned: true, aside: true, node: "keep" }).find((action) => action.value === "pin")!.label).toBe("Unpin");
  });
  test("a temporary chat he's working in can only be asked about on the side; a new chat has nothing to do yet", () => {
    expect(values({ kept: false, pinned: false, aside: true, node: "keep" })).toEqual(["aside"]);
    expect(values({ kept: false, pinned: false, aside: false, node: "keep" })).toEqual([]);
  });
  test("a device that may not chat is offered no side question", () => {
    expect(values({ kept: true, pinned: false, aside: false, node: "keep" })).toEqual(["rename", "pin", "delete"]);
  });
});
