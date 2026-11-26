import { describe, expect, test } from "bun:test";
import { boardJson } from "../../src/inv/board.ts";
import { proofFor } from "../../src/inv/proof.ts";
import { askLines, type AskView, boardLines, PLAIN, proofLines, styleFor } from "../../src/inv/render.ts";
import { askView } from "../../src/inv/asks.ts";
import { boardView, type BoardData } from "../../src/inv/view.ts";
import { action, agent, gated, judged, reviewed, snapshot, T0, task, trail, worked } from "./fixtures.ts";

/*
 * What inv prints for people (docs/CLI.md, "Output"): in a terminal, the apps' words in their colours, frames, and no line
 * wider than it; piped, the same lines plain, with no escape code at all. An approval is shown exactly: what can't be
 * seen in it is shown, and counted.
 */

const NOW = T0 + 10 * 60_000;
const ESC = "\x1b";
const TTY = { color: true, width: 100 } as const;
const width = (line: string) => Bun.stringWidth(line);

function board(over: Partial<BoardData> = {}): BoardData {
  const tasks = [
    task({ id: "task-needs0000001", status: "proposed", proposedBy: "ada", title: "Raise the cache's size" }),
    task({ id: "task-work00000001", status: "running", progress: "Running · bun test packages/link", createdAt: NOW - 4 * 60_000, updatedAt: NOW - 60_000 }),
    task({ id: "task-fail00000001", status: "failed", error: "unverified", progress: "Gate 2/3 · exit 1 · bun run typecheck", updatedAt: NOW - 30 * 60_000, title: "Hero copy, three variants" }),
    task({ id: "task-done00000001", status: "done", verified: true, updatedAt: T0 - 2 * 86_400_000, title: "P-256 did:key for hardware keys" }),
  ];
  return {
    whoami: { device: "c_x", kind: "client", scopes: [], node: "n_x", nodeName: "ultra", fleet: null, fleetName: "home" },
    snapshot: { ...snapshot(tasks, [agent()]), seen: { "agent:ada": T0 - 86_400_000 } },
    actions: [action({ by: "arm:primary", id: `a_${"p".repeat(22)}` })],
    projects: [{ id: "invincible", name: "invincible", instructions: "", repo: "https://github.com/example-owner/invincible", checkout: "/work/invincible", updatedAt: T0 }],
    fleet: { fleet: "f", name: "home", self: "n_u", devices: [{ id: "n_u", name: "ultra", kind: "node", role: "full", scopes: [], enrolledAt: "", revokedAt: null, endpoint: null, caps: null }, { id: "n_m", name: "mini", kind: "node", role: "full", scopes: [], enrolledAt: "", revokedAt: null, endpoint: null, caps: null }], peers: [{ device: "n_m", online: false, lastSeen: null, rttMs: null, error: null }], events: 1, digest: "d" },
    usage: { node: "ultra", since: "2026-11-26", rows: [{ day: "2026-11-26", who: "you", role: "engineer", model: "stand-in/engineer", calls: 4, unknown: 0, input: 1_000_000, output: 500_000, cached: 0, reasoning: 0 }], prices: { "stand-in/engineer": { input: 1, output: 2 } } },
    turns: [],
    unread: [],
    runs: [],
    now: NOW,
    ...over,
  };
}

describe("the board", () => {
  test("in a terminal: your agent's line, the nodes and today's cost, then NEEDS YOU, ACTIVE, WORKING and DONE in the apps' words and colours", () => {
    const lines = boardLines(boardView(board()), TTY);
    const text = lines.join("\n");
    expect(lines[0]).toContain("Invincible");
    expect(lines[0]).toContain("● ultra");
    expect(lines[0]).toContain("○ mini");
    expect(lines[0]).toContain("$2.00 today");
    const titles = lines.map((line) => line.replace(/\x1b\[[0-9;]*m/g, "").trim()).filter((line) => /^[A-Z ]{4,}( ·|$)/.test(line));
    expect(titles).toEqual(["NEEDS YOU", "ACTIVE", "WORKING", "DONE"]);
    // The apps' words, each in its state's colour: amber needs you, red failed, blue at work, green verified.
    expect(text).toContain(`${ESC}[33mApprove?`);
    expect(text).toContain(`${ESC}[31mFailed · gate 2`);
    expect(text).toContain(`${ESC}[34mWorking · 4m`);
    expect(text).toContain(`${ESC}[32mVerified`);
    expect(text).toContain("1 more waits for your approval: inv asks");
    for (const line of lines) expect(width(line)).toBeLessThanOrEqual(TTY.width - 1);
    // Nothing that blinks, rings or moves: no bell, no blink, no cursor moved by the drawing itself.
    expect(text).not.toMatch(/\x07|\x1b\[5m|\x1b\[\d*[ABCDEFGHJ]/);
  });

  test("narrow, it cuts and drops what matters least, and no line is wider than the terminal", () => {
    for (const columns of [40, 60, 80, 132]) {
      for (const line of boardLines(boardView(board()), { color: true, width: columns })) expect([columns, width(line)]).toEqual([columns, Math.min(width(line), columns - 1)]);
    }
  });

  test("piped: the same, as plain lines with no escape code, and nothing cut", () => {
    const style = styleFor({ isTTY: false }, {});
    expect(style).toEqual(PLAIN);
    const lines = boardLines(boardView(board()), style);
    const text = lines.join("\n");
    expect(text).not.toContain(ESC);
    expect(lines[0]).toBe("Invincible · 2 need you · 1 at work · nodes: ultra (online, this one), mini (offline) · $2.00 today");
    expect(lines).toContain("  Approve?  Raise the cache's size  Ada · proposed by its agent  9m  task-needs0000001");
    expect(lines).toContain("  Working · 4m  Fix the flaky link sync test  Ada · bun test packages/link  task-work00000001");
    expect(text).toContain("Failed · gate 2  Hero copy, three variants  Ada · not verified  30m  task-fail00000001");
    // NO_COLOR, or a terminal that can't: plain.
    expect(styleFor({ isTTY: true, columns: 90 }, { NO_COLOR: "1" })).toEqual({ color: false, width: 90 });
  });

  test("with nothing to show, it says what would be here, and how to give a task", () => {
    const lines = boardLines(boardView(board({ snapshot: snapshot([]), actions: [] })), PLAIN);
    expect(lines.join("\n")).toContain('inv give "…" gives one.');
  });

  test("--json: every row by its section, the nodes and the cost, as docs/CLI.md has them", () => {
    const shown = boardJson(boardView(board()));
    expect(Object.keys(shown)).toEqual(["primary", "needs", "active", "working", "done", "nodes", "cost"]);
    expect(shown.needs[0]).toEqual({ id: "task-needs0000001", title: "Raise the cache's size", section: "needs", state: "needs", word: "Approve?", agent: "ada", project: "invincible", detail: "proposed by its agent", age: "9m", at: T0 + 60_000 });
    expect(shown.working[0]).toMatchObject({ word: "Working · 4m", age: null, detail: "bun test packages/link" });
    expect(shown.nodes).toEqual([{ name: "ultra", online: true, self: true }, { name: "mini", online: false, self: false }]);
    expect(shown.cost).toEqual({ todayUsd: 2, complete: true });
  });
});

describe("the proof's frame", () => {
  const verified = proofFor(task({ status: "done", verified: true, budgetUsd: 2, output: "Fixed the race in retry(); all tests pass." }), trail([...worked([1]), ...gated([0]), ...reviewed("pass")]), { word: "Verified", node: "ultra", project: "invincible", prices: {}, asking: false });

  test("in a terminal, framed apart from the agent's own words, which follow it and say they are not proof", () => {
    const lines = proofLines(verified, TTY);
    expect(lines[0]).toMatch(/^ ┌─ .*Verified · by its gates and a reviewer that didn't do the work/);
    expect(lines.at(-2)).toMatch(/^ └─+┘$/);
    expect(lines.at(-1)).toContain("ada said: “Fixed the race in retry(); all tests pass.”");
    expect(lines.at(-1)).toContain("its words, not proof");
    expect(lines.join("\n")).toContain("failed before the work: it shows the work ✓");
    for (const line of lines) expect(width(line)).toBeLessThanOrEqual(TTY.width - 1);
  });

  test("piped, the same lines plain; a failure says which gate, and what to do next", () => {
    const failed = proofFor(task({ status: "failed", error: "unverified" }), trail([...worked([1]), ...gated([2])]), { word: "Failed · gate 1", node: null, project: null, prices: {}, asking: false });
    const lines = proofLines(failed, PLAIN);
    expect(lines[0]).toBe("Failed · gate 1 · gate 1 of 1 didn't pass");
    expect(lines).toContain("  gate    bun test packages/link  exit 2 · 1.0 s  failed");
    expect(lines).toContain("  inv again task-a1b2c3d4e5f6");
    expect(lines.join("\n")).not.toContain(ESC);
  });
});

describe("a steered task's proof, for people", () => {
  const steered = (steers: NonNullable<Parameters<typeof task>[0]>["steers"], count = 1, events = [...worked([1]), { type: "steered" as const, step: 2, by: "owner" as const, text: "Use the new schema." }, ...gated([0]), ...reviewed("pass")]) =>
    proofLines(proofFor(task({ status: "done", verified: true, steers }), judged(trail(events), count), { word: "Verified", node: null, project: null, prices: {}, asking: false }), PLAIN);

  test("its frame says how often it was steered, whose words they were, and what its review judged the work against", () => {
    expect(steered([{ by: "owner", text: "Use the new schema.", at: T0, taken: { at: T0, step: 2 } }])).toContain("  steered once, yours · the review judged the work against it");
    const both = steered([{ by: "owner", text: "Use the new schema.", at: T0, taken: { at: T0, step: 2 } }, { by: "primary", text: "Keep the old reader.", at: T0 }]);
    expect(both).toContain("  steered 2 times, yours and your agent's · the review judged the work against it · 1 never reached it");
    // A review that came before the steer judged the work without it.
    expect(steered([{ by: "owner", text: "Use the new schema.", at: T0, taken: { at: T0, step: 2 } }], 0)).toContain("  steered once, yours · its review came before it");
    // One the task ended before taking was judged by no one, and is said to be.
    expect(steered([{ by: "primary", text: "Keep the old reader.", at: T0 }], 0)).toContain("  steered once, your agent's · it never reached the work");
  });

  test("a task nothing was said to has no such line", () => {
    expect(steered(undefined, 0, [...worked([1]), ...gated([0]), ...reviewed("pass")]).some((line) => line.includes("steered"))).toBe(false);
  });
});

describe("an approval, shown exactly", () => {
  test("its operation and inputs whole, and a character you can't see shown as its code point and counted", () => {
    const hidden = action({ args: { owner: "example-owner", title: "Fix the race\u202e in retry()", body: "line one\nline two" } });
    const ask: AskView = askView(hidden, snapshot([task()]));
    expect(ask).toMatchObject({ kind: "approval", op: "github.create_pull_request", by: "ada", task: "task-a1b2c3d4e5f6", hidden: 1 });
    const lines = askLines(ask, PLAIN);
    const text = lines.join("\n");
    expect(lines[0]).toBe("ada asks · task task-a1b2c3d4e5f6 “Fix the flaky link sync test”");
    expect(text).toContain("github.create_pull_request (outward)");
    expect(text).toContain("title: Fix the race⟨U+202E⟩ in retry()");
    expect(text).toContain("body: line one\n      line two");
    expect(text).toContain("⚠ 1 character you can't see, shown as ⟨U+202E⟩");
    expect(text).not.toContain("\u202e");
    expect(lines).toContain(`  inv allow ${hidden.id} [--for-task]`);
    expect(lines).toContain(`  inv deny ${hidden.id} "why"`);
  });

  test("in a terminal, in a frame of its own in amber, never wider than it", () => {
    const lines = askLines(askView(action(), snapshot([task()])), TTY);
    expect(lines[0]).toContain(`${ESC}[33m`);
    for (const line of lines) expect(width(line)).toBeLessThanOrEqual(TTY.width - 1);
  });
});
