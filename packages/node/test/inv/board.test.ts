import { expect, test } from "bun:test";
import type { RouteName } from "@invincible/core";
import { boardCommand } from "../../src/inv/board.ts";
import type { NodeClient } from "../../src/inv/client.ts";
import type { Connection } from "../../src/inv/connect.ts";
import { EXIT } from "../../src/inv/exit.ts";
import type { Flags } from "../../src/inv/io.ts";
import { snapshot, task, testIo } from "./fixtures.ts";

/*
 * The board in a terminal (docs/CLI.md): drawn, then drawn again in place only when the node's live stream says the work
 * changed, and never at rest; the cursor hidden while it shows, so nothing blinks, and given back when you leave.
 */

const flags: Flags = { json: false, stream: false, wait: false, noAsk: false, gate: [], forTask: false, needsYou: false, working: false, done: false, week: false, forget: false, help: false };

test("in a terminal it is drawn once, again in place when the work changes (and only then), and Ctrl-C leaves it as it was found", async () => {
  let title = "Fix the flaky link sync test";
  let changed: (() => void) | null = null;
  const client: NodeClient = {
    label: "a scripted node",
    async call<T>(name: RouteName): Promise<T> {
      if (name === "team") return snapshot([task({ title })]) as T;
      throw Object.assign(new Error("not here"), { exit: 30 });
    },
    async *events(_name: RouteName, _input?: unknown, signal?: AbortSignal): AsyncGenerator<string> {
      // Hello first (read everything once), then one change, then quiet until it is closed.
      yield JSON.stringify({ type: "hello", topics: ["team", "actions"] });
      await new Promise<void>((resolve) => (changed = resolve));
      yield JSON.stringify({ type: "changed", topics: ["team"] });
      await new Promise<void>((resolve) => signal?.addEventListener("abort", () => resolve(), { once: true }));
    },
  };
  const conn = async (): Promise<Connection> => ({ client, how: "paired", pairing: null });
  const stop = new AbortController();
  const io = { ...testIo({}), style: { color: true, width: 80 }, rows: 40, signal: stop.signal, pollMs: 10 };
  const drawings = () => io.stdout().split("\x1b[J").length - 1;
  const shown = boardCommand(conn, [], flags, io);
  // (Bun.sleep: the board's own loop takes its turns in between; nothing here is timed but the test's patience.)
  for (let n = 0; n < 2000 && !changed; n++) await Bun.sleep(5);
  // The hello was read, and nothing had changed: one drawing.
  await Bun.sleep(30);
  expect(drawings()).toBe(1);
  title = "Ship the fix";
  changed!();
  for (let n = 0; n < 2000 && drawings() < 2; n++) await Bun.sleep(5);
  expect(drawings()).toBe(2);
  stop.abort();
  expect(await shown).toBe(EXIT.ok);
  const out = io.stdout();
  const first = out.slice(0, out.indexOf("\x1b[J", 10)).split("\n").length - 1;
  expect(out.startsWith("\x1b[?25l")).toBe(true);
  // Drawn again over itself: the cursor goes up as many lines as were drawn, and what was there is cleared.
  expect(out).toContain(`\x1b[${first}F\x1b[J`);
  expect(out).toContain("Ship the fix");
  expect(out.endsWith("\x1b[?25h")).toBe(true);
  expect(out).not.toMatch(/\x07|\x1b\[5m/);
});
