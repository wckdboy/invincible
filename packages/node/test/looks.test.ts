import { describe, expect, test } from "bun:test";
import { LOOK_LIMITS } from "@galahad/core";
import { ChatStore, type KeptLook, type QueuedBy } from "../src/chats.ts";
import { lookAt, LookLaterError, lookMessage, LookRunner, lookTime } from "../src/looks.ts";
import { TurnError, TurnHub, type TurnSpec } from "../src/turns.ts";

/*
 * His own looks (looks.ts): when one comes, as he said it would; the message it comes back as, kept as his and never as
 * yours; and the runner that takes each once, waiting while its chat is busy, never one called off, and saying why it
 * couldn't take one.
 */

const T = Date.parse("2026-11-24T20:07:31Z");
const phone: QueuedBy = { kind: "client", device: "phone-1" };

describe("when a look comes", () => {
  test("in a while, or at a time in the zone he was told: no sooner than a minute, no later than 30 days", () => {
    expect(lookAt({ in: "2h" }, "UTC", T)).toBe(T + 2 * 3_600_000);
    expect(lookAt({ in: "45m" }, "UTC", T)).toBe(T + 45 * 60_000);
    expect(lookAt({ in: "1d" }, "UTC", T)).toBe(T + 86_400_000);
    // 09:00 in Copenhagen is 08:00 UTC in November.
    expect(new Date(lookAt({ at: "2026-11-25 09:00" }, "Europe/Copenhagen", T)).toISOString()).toBe("2026-11-25T08:00:00.000Z");
    expect(() => lookAt({ in: "30s" }, "UTC", T)).toThrow(LookLaterError);
    expect(() => lookAt({ at: "2026-11-24 21:00" }, "Europe/Copenhagen", T)).toThrow("that is past: give a time to come");
    expect(() => lookAt({ in: "31d" }, "UTC", T)).toThrow(/more than 30 days away/);
    expect(() => lookAt({ at: "2026-02-30 09:00" }, "UTC", T)).toThrow("2026-02-30 09:00 is not a time there is");
    expect(() => lookAt({}, "UTC", T)).toThrow(/say when/);
  });

  test("said as a time of day today, and with its day on another", () => {
    expect(lookTime(T + 2 * 3_600_000, "Europe/Copenhagen", T)).toBe("23:07");
    expect(lookTime(Date.parse("2026-11-25T08:00:00Z"), "Europe/Copenhagen", T)).toBe("Wed 25 Nov, 09:00");
  });

  test("it comes back as his own note, not your words, with what to do; and says so when it is late", () => {
    const look = { set: T, note: "Did the deploy finish?", at: T + 3_600_000, zone: "Europe/Copenhagen" };
    expect(lookMessage(look, T + 3_600_000)).toBe("(A look you set yourself at 21:07, not your liege's words: Did the deploy finish?) Look now, with your tools, and say what you found and what comes next: your liege reads it here.");
    // Half an hour late, the same evening; past midnight there, the day is said too.
    expect(lookMessage(look, T + 90 * 60_000)).toContain(" It came due at 22:07, while this node was away: it is late. Look now");
    expect(lookMessage(look, T + 5 * 3_600_000)).toStartWith("(A look you set yourself at Tue 24 Nov, 21:07, not your liege's words: Did the deploy finish?) It came due at Tue 24 Nov, 22:07");
  });
});

describe("the runner", () => {
  function world() {
    let now = T;
    const chats = new ChatStore(":memory:", () => now);
    const turns = new TurnHub({ chats, now: () => now });
    const runner = new LookRunner({ chats, turns, now: () => now });
    const started: TurnSpec[] = [];
    let refuse: Error | null = null;
    runner.setPrepare((look: KeptLook) => {
      if (refuse) throw refuse;
      const kept = chats.summary(look.conversation)!;
      const spec: TurnSpec = {
        by: look.by,
        bank: false,
        role: "planner",
        conversation: { id: kept.id, title: kept.title, project: kept.project },
        question: lookMessage(look, now),
        messages: [{ role: "user", content: lookMessage(look, now) }],
        waits: { actions: [], secrets: [] },
        run: async function* () {
          yield { type: "text", text: "It finished." };
          yield { type: "done", ref: "test/m" };
        },
      };
      started.push(spec);
      return spec;
    });
    const chat = chats.create({ title: "Deploy", project: null, role: "planner" }).id;
    const set = (at: number, note = "Did the deploy finish?") => chats.lookAdd({ conversation: chat, at, note, zone: "UTC", by: phone, held: null });
    return { chats, turns, runner, started, chat, set, clock: (t: number) => void (now = t), refuseWith: (error: Error | null) => void (refuse = error) };
  }

  test("a look that comes is a turn of his in its chat, its message kept as his; taken once", async () => {
    const w = world();
    const look = w.set(T + 3_600_000);
    w.runner.tick();
    expect(w.started).toHaveLength(0);
    w.clock(T + 3_600_000);
    w.runner.tick();
    w.runner.tick();
    expect(w.started).toHaveLength(1);
    await w.turns.drain();
    const kept = w.chats.get(w.chat)!;
    expect(kept.messages.map((m) => [m.role, m.look ?? null])).toEqual([
      ["user", { set: T, note: "Did the deploy finish?" }],
      ["assistant", null],
    ]);
    expect(kept.messages[1]!.content).toBe("It finished.");
    expect(w.chats.look(look.id)).toMatchObject({ state: "done", why: null });
    expect(w.chats.looksWaiting(w.chat)).toEqual([]);
  });

  test("while its chat is busy it waits; when the node is at its limit too; one called off is never taken", async () => {
    const w = world();
    const busy = w.set(T + 60_000);
    const off = w.set(T + 60_000, "Something else");
    w.chats.lookEnd(off.id, "cancelled", "called off by you");
    w.clock(T + 60_000);
    w.refuseWith(new TurnError(409, "He's still working in this chat."));
    w.runner.tick();
    w.refuseWith(new TurnError(429, "This node is already working on 4 turns, its limit."));
    w.runner.tick();
    expect(w.chats.look(busy.id)!.state).toBe("waiting");
    w.refuseWith(null);
    w.runner.tick();
    await w.turns.drain();
    expect(w.started.map((s) => s.question)).toEqual([expect.stringContaining("Did the deploy finish?")]);
    expect(w.chats.look(off.id)).toMatchObject({ state: "cancelled", why: "called off by you" });
  });

  test("one that can't be taken says why: its device gone, or more than a week late", () => {
    const w = world();
    const gone = w.set(T + 60_000);
    w.clock(T + 60_000);
    w.refuseWith(new TurnError(403, "the device that queued it is no longer paired", "device"));
    w.runner.tick();
    expect(w.chats.look(gone.id)).toMatchObject({ state: "failed", why: "the device that queued it is no longer paired" });
    w.refuseWith(null);
    const stale = w.set(T + 120_000);
    w.clock(T + 120_000 + LOOK_LIMITS.lateMs + 1);
    w.runner.tick();
    expect(w.chats.look(stale.id)).toMatchObject({ state: "failed", why: expect.stringContaining("more than a week ago, while this node was away") });
    expect(w.started).toHaveLength(0);
  });

  test("a chat deleted takes its looks with it", () => {
    const w = world();
    const look = w.set(T + 60_000);
    w.chats.delete(w.chat);
    expect(w.chats.look(look.id)).toBeNull();
  });
});
