import { describe, expect, test } from "bun:test";
import type { TerminalEvent } from "@galahad/core";
import { type LedgerEntryInput, spawnTerminal, type TerminalProcess } from "@galahad/sandbox";
import { Terminals, type TerminalsOptions } from "../src/terminals.ts";

/*
 * Terminals in a node's sandboxes: a shell on a real terminal, kept while it is used, with what it showed lately
 * for whoever comes back to it. The shell here is a local one (a sandbox's is `docker exec --tty`, the same to this).
 */

const text = (events: TerminalEvent[]): string =>
  events.map((e) => (e.type === "output" ? Buffer.from(e.data, "base64").toString("utf8") : `[exit ${e.code}]`)).join("");

async function until(what: () => boolean, ms = 5000): Promise<void> {
  const end = Date.now() + ms;
  while (!what()) {
    if (Date.now() > end) throw new Error("timed out");
    await Bun.sleep(10);
  }
}

/** A stand-in for a terminal's process: it says what it is told to, and ends when told. */
function standIn() {
  const made: { written: string[]; sizes: [number, number][]; killed: boolean; say: (s: string) => void; end: (code: number) => void }[] = [];
  const start: TerminalsOptions["start"] = async (sandbox, _size, onData) => {
    let end: (code: number) => void = () => {};
    const exited = new Promise<number>((resolve) => (end = resolve));
    const one = { written: [] as string[], sizes: [] as [number, number][], killed: false, say: (s: string) => onData(new TextEncoder().encode(s)), end };
    made.push(one);
    const process: TerminalProcess = {
      write: (data) => void one.written.push(data),
      resize: (cols, rows) => void one.sizes.push([cols, rows]),
      kill: () => {
        one.killed = true;
        end(137);
      },
      exited,
    };
    return { name: `box-${sandbox}`, quest: "owner", process };
  };
  return { made, start };
}

function terminals(start: TerminalsOptions["start"], now = () => Date.now()) {
  const ledger: LedgerEntryInput[] = [];
  const service = new Terminals({ start, ledger: (entry) => void ledger.push(entry), now });
  return { service, ledger };
}

describe("a terminal", () => {
  test("a real one: what you type reaches the shell, what it prints comes back, and a resize reaches it", async () => {
    const { service } = terminals(async (_sandbox, size, onData) => ({ name: "local", quest: null, process: spawnTerminal(["sh"], size, onData) }));
    const opened = await service.open("0123456789", { cols: 100, rows: 30 });
    expect(opened).toMatchObject({ sandbox: "0123456789", name: "local", cols: 100, rows: 30, exitCode: null });
    const seen: TerminalEvent[] = [];
    const leave = service.watch(opened.id, (event) => void seen.push(event));
    service.input(opened.id, { data: "echo $((6 * 7)); stty size\n" });
    await until(() => /42\r?\n30 100/.test(text(seen)));
    service.input(opened.id, { size: { cols: 120, rows: 40 }, data: "stty size\n" });
    await until(() => /40 120/.test(text(seen)));
    expect(service.list()[0]).toMatchObject({ cols: 120, rows: 40, watchers: 1 });
    service.input(opened.id, { data: "exit 3\n" });
    await until(() => text(seen).endsWith("[exit 3]"));
    leave();
    service.closeAll();
  });

  test("closing a real one ends its shell at once, though an interactive shell ignores SIGTERM", async () => {
    const { service, ledger } = terminals(async (_sandbox, size, onData) => ({ name: "local", quest: null, process: spawnTerminal(["sh"], size, onData) }));
    const opened = await service.open("0123456789", { cols: 80, rows: 24 });
    const seen: TerminalEvent[] = [];
    service.watch(opened.id, (event) => void seen.push(event));
    service.input(opened.id, { data: "echo ready\n" });
    await until(() => text(seen).includes("ready"));
    service.close(opened.id);
    // Well before the two seconds after which it would be killed outright.
    await until(() => seen.at(-1)?.type === "exit", 1500);
    expect(ledger.at(-1)?.detail).toMatch(/: you closed it$/);
  });

  test("a device that comes later sees what it showed lately, then what comes", async () => {
    const { made, start } = standIn();
    const { service } = terminals(start);
    const opened = await service.open("0123456789", { cols: 80, rows: 24 });
    made[0]!.say("Open this address and enter the code ABCD-1234\r\n");
    const late: TerminalEvent[] = [];
    service.watch(opened.id, (event) => void late.push(event));
    made[0]!.say("Signed in.\r\n");
    expect(text(late)).toBe("Open this address and enter the code ABCD-1234\r\nSigned in.\r\n");
    service.closeAll();
  });

  test("what it showed lately is its last 256 KB, never more", async () => {
    const { made, start } = standIn();
    const { service } = terminals(start);
    const opened = await service.open("0123456789", { cols: 80, rows: 24 });
    for (let i = 0; i < 100; i++) made[0]!.say(`${String(i).padStart(2, "0")}${"x".repeat(9998)}`);
    const seen: TerminalEvent[] = [];
    service.watch(opened.id, (event) => void seen.push(event));
    const shown = text(seen);
    expect(shown.length).toBe(256 * 1024);
    expect(shown.endsWith(`99${"x".repeat(9998)}`)).toBe(true);
    service.closeAll();
  });

  test("keys and sizes go to its process in order; a size it already has changes nothing", async () => {
    const { made, start } = standIn();
    const { service } = terminals(start);
    const opened = await service.open("0123456789", { cols: 80, rows: 24 });
    service.input(opened.id, { data: "l" });
    service.input(opened.id, { data: "s\r", size: { cols: 80, rows: 24 } });
    service.input(opened.id, { size: { cols: 90, rows: 30 } });
    expect(made[0]!.written).toEqual(["l", "s\r"]);
    expect(made[0]!.sizes).toEqual([[90, 30]]);
    service.closeAll();
  });
});

describe("how long one stays open, and how many", () => {
  test("at most four at once on a node: a fifth is refused until one closes", async () => {
    const { start } = standIn();
    const { service } = terminals(start);
    const four = await Promise.all([1, 2, 3, 4].map(() => service.open("0123456789", { cols: 80, rows: 24 })));
    await expect(service.open("0123456789", { cols: 80, rows: 24 })).rejects.toMatchObject({ status: 429 });
    service.close(four[0]!.id);
    await service.open("0123456789", { cols: 80, rows: 24 });
    service.closeAll();
  });

  test("nobody watching it for fifteen minutes closes it; being watched or typed into keeps it open", async () => {
    let now = 1_000_000;
    const { made, start } = standIn();
    const { service, ledger } = terminals(start, () => now);
    const watched = await service.open("0123456789", { cols: 80, rows: 24 });
    const typed = await service.open("0123456789", { cols: 80, rows: 24 });
    const left = await service.open("0123456789", { cols: 80, rows: 24 });
    service.watch(watched.id, () => {});
    now += 10 * 60_000;
    service.input(typed.id, { data: "x" });
    now += 6 * 60_000;
    service.sweep();
    await Bun.sleep(0);
    expect(made.map((m) => m.killed)).toEqual([false, false, true]);
    expect(service.list().find((t) => t.id === left.id)?.exitCode).toBe(137);
    expect(ledger.at(-1)).toMatchObject({ resource: "sandbox.terminal", target: "box-0123456789", detail: "closed after 16m 0s: nobody watched it for 15 minutes" });
    // Ended, it is listed for a minute (a device coming back learns how it ended), then gone.
    now += 61_000;
    service.sweep();
    expect(service.list().map((t) => t.id)).toEqual([watched.id, typed.id]);
    service.closeAll();
  });

  test("its shell ending tells every device watching; then it takes no more keys", async () => {
    const { made, start } = standIn();
    const { service, ledger } = terminals(start);
    const opened = await service.open("0123456789", { cols: 80, rows: 24 });
    const a: TerminalEvent[] = [];
    const b: TerminalEvent[] = [];
    service.watch(opened.id, (event) => void a.push(event));
    service.watch(opened.id, (event) => void b.push(event));
    made[0]!.say("bye\r\n");
    made[0]!.end(0);
    await Bun.sleep(0);
    expect(a.at(-1)).toEqual({ type: "exit", code: 0 });
    expect(b.at(-1)).toEqual({ type: "exit", code: 0 });
    // A device coming back now is shown the end of it, and how it ended.
    const late: TerminalEvent[] = [];
    service.watch(opened.id, (event) => void late.push(event));
    expect(text(late)).toBe("bye\r\n[exit 0]");
    expect(() => service.input(opened.id, { data: "ls\r" })).toThrow(/ended/);
    expect(ledger.at(-1)?.detail).toMatch(/^closed after 0m 0s: its shell ended \(exit 0\)$/);
    service.closeAll();
  });
});

describe("what is kept of it", () => {
  test("the ledger says when it opened and closed and who closed it, never what was typed or shown", async () => {
    const { made, start } = standIn();
    const { service, ledger } = terminals(start);
    const opened = await service.open("0123456789", { cols: 80, rows: 24 });
    service.input(opened.id, { data: "export SECRET=sk-test-not-a-real-key\r" });
    made[0]!.say("sk-test-not-a-real-key\r\n");
    service.close(opened.id);
    await Bun.sleep(0);
    expect(made[0]!.killed).toBe(true);
    expect(ledger.map((e) => [e.resource, e.class, e.verdict, e.target, e.quest, e.detail])).toEqual([
      ["sandbox.terminal", "modify", "allow", "box-0123456789", "owner", "opened (80×24)"],
      ["sandbox.terminal", "modify", "allow", "box-0123456789", "owner", "closed after 0m 0s: you closed it"],
    ]);
    expect(JSON.stringify(ledger)).not.toContain("sk-test");
    // Closed by you, it is gone at once.
    expect(service.list()).toEqual([]);
    expect(() => service.watch(opened.id, () => {})).toThrow(/no such terminal/);
  });

  test("a terminal that isn't open here is not found; a sandbox that can't be reached is refused as the host says", async () => {
    const { service } = terminals(async () => {
      throw Object.assign(new Error("no such sandbox on this node"), { status: 404 });
    });
    await expect(service.open("0123456789", { cols: 80, rows: 24 })).rejects.toMatchObject({ status: 404 });
    expect(() => service.input("tm_aaaaaaaaaaaaaaaa", { data: "x" })).toThrow(/no such terminal/);
    // A failed start takes no slot.
    expect(service.list()).toEqual([]);
  });
});
