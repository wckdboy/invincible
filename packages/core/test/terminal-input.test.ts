import { expect, test } from "bun:test";
import { inputQueue, type TerminalInput } from "../src/terminal-input.ts";

/* What is typed into a terminal reaches it in order: one request at a time, what comes meanwhile next, together. */

function node() {
  const sent: TerminalInput[] = [];
  const waiting: (() => void)[] = [];
  return {
    sent,
    send: (input: TerminalInput) => {
      sent.push(input);
      return new Promise<void>((resolve) => waiting.push(resolve));
    },
    answer: async () => {
      waiting.shift()?.();
      await Bun.sleep(0);
    },
  };
}

test("one request at a time; keys and a size given meanwhile go next, together, the latest size only", async () => {
  const n = node();
  const queue = inputQueue(n.send, () => {});
  queue.type("l");
  queue.type("s");
  queue.resize({ cols: 90, rows: 30 });
  queue.type(" -la\r");
  queue.resize({ cols: 100, rows: 31 });
  expect(n.sent).toEqual([{ data: "l" }]);
  await n.answer();
  expect(n.sent).toEqual([{ data: "l" }, { data: "s -la\r", size: { cols: 100, rows: 31 } }]);
  await n.answer();
  await queue.idle();
  expect(n.sent).toHaveLength(2);
});

test("a paste larger than one request goes in pieces, in order", async () => {
  const n = node();
  const queue = inputQueue(n.send, () => {});
  queue.type("x");
  queue.type("y".repeat(70_000));
  await n.answer();
  await n.answer();
  await n.answer();
  expect(n.sent.map((s) => s.data?.length)).toEqual([1, 65_536, 70_000 - 65_536]);
});

test("a request that fails is told, and nothing more is sent after it", async () => {
  const failures: unknown[] = [];
  let calls = 0;
  const queue = inputQueue(async () => {
    calls++;
    throw new Error("the terminal's shell has ended");
  }, (error) => failures.push(error));
  queue.type("a");
  await queue.idle();
  queue.type("b");
  await queue.idle();
  expect(calls).toBe(1);
  expect(failures).toHaveLength(1);
});
