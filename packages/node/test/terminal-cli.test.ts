import { expect, test } from "bun:test";
import type { RouteName, TeamSnapshot, Teammate, TerminalEvent, TerminalView } from "@galahad/core";
import { defaultAvatar } from "@galahad/core/avatar";
import { type Screen, terminalCommand } from "../src/terminal-cli.ts";

/* `galahad terminal` at a terminal, against what the node would answer. */

const member = (id: string, over: Partial<Teammate> = {}): Teammate => ({ id, name: id[0]!.toUpperCase() + id.slice(1), instructions: "", role: "engineer", harness: "native", enabled: true, dailyTurns: 40, turnsToday: 0, repository: null, workspaceNode: null, workspace: null, memory: "", avatar: defaultAvatar(id), createdBy: "owner", instructionsBy: "owner", createdAt: 1, updatedAt: 1, ...over });
const view = (id: string, over: Partial<TerminalView> = {}): TerminalView => ({ id, sandbox: "0123456789", name: "galahad-sbx-0123456789", cols: 80, rows: 24, opened: 1, exitCode: null, watchers: 0, ...over });
const out = (text: string): TerminalEvent => ({ type: "output", data: Buffer.from(text).toString("base64") });

/** The node: what the command asked of it, a terminal's events as the test sends them, and how long an input takes. */
function node(teammates: Teammate[] = [], terminals: TerminalView[] = []) {
  const asked: { name: RouteName; input: any }[] = [];
  /** Events sent before the command asked for the next one wait here; null is the stream's end. */
  const queue: (TerminalEvent | null)[] = [];
  let waiting: ((event: TerminalEvent | null) => void) | null = null;
  let release: (() => void) | null = null;
  const node = {
    asked,
    /** Inputs wait until this is called (to see what is typed meanwhile go together). */
    holdInputs: false,
    send(event: TerminalEvent | null) {
      const taker = waiting;
      waiting = null;
      if (taker) taker(event);
      else queue.push(event);
    },
    releaseInput() {
      release?.();
    },
    api: {
      async call<T>(name: RouteName, input?: unknown): Promise<T> {
        asked.push({ name, input });
        if (name === "team") return { teammates, rooms: [], tasks: [], deliveries: [] } satisfies TeamSnapshot as T;
        if (name === "terminals") return { terminals } as T;
        if (name === "openTerminal") return { terminal: view("tm_opened0000000000", { sandbox: (input as { sandbox: string }).sandbox }) } as T;
        if (name === "terminalInput" && node.holdInputs) await new Promise<void>((resolve) => (release = resolve));
        return { ok: true } as T;
      },
      async *stream<T>(name: RouteName, input: unknown, signal?: AbortSignal): AsyncGenerator<T> {
        asked.push({ name, input });
        for (;;) {
          const next = queue.length
            ? queue.shift()!
            : await new Promise<TerminalEvent | null>((resolve, reject) => {
                waiting = resolve;
                signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
              });
          if (next === null) return;
          yield next as T;
        }
      },
    },
  };
  return node;
}

/** This terminal, as a test drives it: keys typed, a resize, what was shown and said, whether it is in raw mode. */
function screen(cols = 120, rows = 40) {
  let typed: (data: string) => void = () => {};
  let resized: () => void = () => {};
  let size = { cols, rows };
  const state = { raw: false, shown: [] as string[], said: [] as string[] };
  const own: Screen = {
    size: () => size,
    keys(onKeys) {
      state.raw = true;
      typed = onKeys;
      return () => {
        state.raw = false;
        typed = () => {};
      };
    },
    onResize(listener) {
      resized = listener;
      return () => (resized = () => {});
    },
    write: (bytes) => void state.shown.push(new TextDecoder().decode(bytes)),
    say: (line) => void state.said.push(line),
  };
  return {
    screen: own,
    get raw() {
      return state.raw;
    },
    shown: state.shown,
    said: state.said,
    type: (data: string) => typed(data),
    resize(c: number, r: number) {
      size = { cols: c, rows: r };
      resized();
    },
  };
}

const tick = () => Bun.sleep(1);

test("a knight by name: its VM's terminal at this one's size; keys go in order, what is typed meanwhile goes next together; the shell's exit is the command's", async () => {
  const n = node([member("gawain", { workspace: { id: "abcdef0123", node: "ultra" } as Teammate["workspace"] })]);
  const s = screen(120, 40);
  const done = terminalCommand(n.api, "Gawain", [], s.screen, () => {});
  await tick();
  expect(n.asked.find((a) => a.name === "openTerminal")?.input).toEqual({ sandbox: "abcdef0123", size: { cols: 120, rows: 40 } });
  expect(s.raw).toBe(true);
  n.send(out("$ "));
  n.holdInputs = true;
  s.type("l");
  await tick();
  s.type("s");
  s.type(" -la\r");
  s.resize(100, 30);
  n.holdInputs = false;
  n.releaseInput();
  await tick();
  await tick();
  expect(n.asked.filter((a) => a.name === "terminalInput").map((a) => a.input)).toEqual([
    { terminal: "tm_opened0000000000", data: "l" },
    { terminal: "tm_opened0000000000", data: "s -la\r", size: { cols: 100, rows: 30 } },
  ]);
  n.send(out("total 0\r\n"));
  n.send({ type: "exit", code: 3 });
  expect(await done).toBe(3);
  expect(s.shown.join("")).toBe("$ total 0\r\n");
  expect(s.raw).toBe(false);
  expect(s.said.at(-1)).toBe("[its shell ended: exit 3]");
  // Ended by its shell: nothing to close.
  expect(n.asked.some((a) => a.name === "closeTerminal")).toBe(false);
});

test("Ctrl-] leaves: what was typed before it is sent; a terminal opened here is closed, one taken up from elsewhere left open", async () => {
  const opened = node();
  const s = screen();
  const here = terminalCommand(opened.api, "0123456789", [], s.screen, () => {});
  await tick();
  s.type("echo bye\x1d");
  expect(await here).toBe(0);
  expect(opened.asked.filter((a) => a.name === "terminalInput").map((a) => a.input.data)).toEqual(["echo bye"]);
  expect(opened.asked.at(-1)).toEqual({ name: "closeTerminal", input: { terminal: "tm_opened0000000000" } });
  expect(s.raw).toBe(false);

  const elsewhere = node([], [view("tm_fromthephone0000")]);
  const t = screen();
  const attached = terminalCommand(elsewhere.api, "attach", ["tm_fromthephone0000"], t.screen, () => {});
  await tick();
  expect(elsewhere.asked.find((a) => a.name === "watchTerminal")?.input).toEqual({ terminal: "tm_fromthephone0000" });
  // Taken up at this terminal's size.
  expect(elsewhere.asked.find((a) => a.name === "terminalInput")?.input).toEqual({ terminal: "tm_fromthephone0000", size: { cols: 120, rows: 40 } });
  t.type("\x1d");
  expect(await attached).toBe(0);
  expect(elsewhere.asked.some((a) => a.name === "closeTerminal")).toBe(false);
  expect(t.said.at(-1)).toBe("[left: it is still open · galahad terminal attach tm_fromthephone0000]");
});

test("the node letting go of a terminal says how to take it up again", async () => {
  const n = node();
  const s = screen();
  const done = terminalCommand(n.api, "0123456789", [], s.screen, () => {});
  await tick();
  n.send(null);
  expect(await done).toBe(1);
  expect(s.said.at(-1)).toBe("[the node let go of this terminal: take it up again with galahad terminal attach tm_opened0000000000]");
});

test("a knight with no VM, or a name that is nothing: what to do instead; ls and close", async () => {
  const n = node([member("percival")], [view("tm_aaaaaaaaaaaaaaaa", { name: "galahad-sbx-abcdef0123", cols: 90, rows: 30, watchers: 1 }), view("tm_bbbbbbbbbbbbbbbb", { exitCode: 0 })]);
  const s = screen();
  await expect(terminalCommand(n.api, "percival", [], s.screen, () => {})).rejects.toThrow("Percival has no VM yet: galahad roundtable provision percival");
  await expect(terminalCommand(n.api, "lancelot", [], s.screen, () => {})).rejects.toThrow(/no knight or sandbox "lancelot"/);
  const lines: string[] = [];
  expect(await terminalCommand(n.api, "ls", [], s.screen, (line) => lines.push(line))).toBe(0);
  expect(lines).toEqual(["tm_aaaaaaaaaaaaaaaa · galahad-sbx-abcdef0123 · 90×30 · watched by 1", "tm_bbbbbbbbbbbbbbbb · galahad-sbx-0123456789 · its shell ended (exit 0)"]);
  expect(await terminalCommand(n.api, "close", ["tm_aaaaaaaaaaaaaaaa"], s.screen, () => {})).toBe(0);
  expect(n.asked.at(-1)).toEqual({ name: "closeTerminal", input: { terminal: "tm_aaaaaaaaaaaaaaaa" } });
  await expect(terminalCommand(n.api, "close", ["nonsense"], s.screen, () => {})).rejects.toThrow(/usage/);
});
