import { describe, expect, test } from "bun:test";
import { ChatStore, FOLD, foldAt } from "../src/chats.ts";

/*
 * A long chat is folded: its older messages summed up into a story, the newest said whole, from one of yours. Rarely
 * (what a provider caches is the beginning), and never so that the conversation a model is given starts with an answer.
 */

const words = (n: number) => "x".repeat(n);
const exchange = (yours: number, answer: number) => [{ role: "user", content: words(yours) }, { role: "assistant", content: words(answer) }];

describe("where a chat is folded", () => {
  test("not until what follows its story passes the threshold", () => {
    expect(foldAt([])).toBeNull();
    expect(foldAt(exchange(10, FOLD.high - 10))).toBeNull();
    expect(foldAt([...exchange(10, FOLD.high - 10), ...exchange(1, 1)])).not.toBeNull();
  });

  test("the newest that fit stay whole, starting with one of yours", () => {
    const small = { high: 100, keep: 30 };
    // Five exchanges of 20 characters: the last one (20) fits in 30, the last two (40) don't.
    const chat = [...exchange(10, 10), ...exchange(10, 10), ...exchange(10, 10), ...exchange(10, 10), ...exchange(10, 10), ...exchange(10, 10)];
    expect(foldAt(chat, small)).toBe(10);
    expect(chat[10]!.role).toBe("user");
  });

  test("when even your last exchange doesn't fit, it stays whole anyway, and everything before it is folded", () => {
    const small = { high: 100, keep: 30 };
    const chat = [...exchange(40, 40), ...exchange(40, 40)];
    expect(foldAt(chat, small)).toBe(2);
  });

  test("a chat with only one message of yours has nothing it could fold", () => {
    expect(foldAt([{ role: "user", content: words(FOLD.high + 1) }])).toBeNull();
    expect(foldAt([{ role: "user", content: "hi" }, { role: "assistant", content: words(FOLD.high + 1) }])).toBeNull();
  });
});

describe("a chat's story", () => {
  test("covers its older messages; what follows it is said whole; it goes with its chat", () => {
    const chats = new ChatStore(":memory:");
    const kept = chats.create({ title: "Long", project: null, role: "planner" });
    const ids: number[] = [];
    for (let n = 0; n < 3; n++) {
      ids.push(chats.addUser(kept.id, `question ${n}`));
      chats.finishAnswer(kept.id, chats.startAnswer(kept.id), { content: `answer ${n}`, model: null, steps: [], status: "done", error: null, bank: false });
    }
    expect(chats.told(kept.id)).toMatchObject({ story: null });
    expect(chats.told(kept.id).recent.map((m) => m.content)).toEqual(["question 0", "answer 0", "question 1", "answer 1", "question 2", "answer 2"]);
    chats.keepStory(kept.id, "You asked twice; he answered twice.", ids[2]! - 1);
    const told = chats.told(kept.id);
    expect(told.story).toEqual({ text: "You asked twice; he answered twice.", through: ids[2]! - 1 });
    expect(told.recent.map((m) => m.content)).toEqual(["question 2", "answer 2"]);
    // Told again, it replaces what it said.
    chats.keepStory(kept.id, "Folded further.", ids[2]!);
    expect(chats.told(kept.id)).toMatchObject({ story: { text: "Folded further." }, recent: [{ content: "answer 2" }] });
    // The whole history is still kept, to read.
    expect(chats.history(kept.id)).toHaveLength(6);
    chats.delete(kept.id);
    expect(chats.told(kept.id)).toEqual({ story: null, recent: [] });
  });
});
