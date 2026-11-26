import { describe, expect, test } from "bun:test";
import type { ChatStreamEvent, QuestView, TurnView } from "@galahad/core";
import { type Io, printTurn, questLines, queueLines, turnLine } from "../src/turn-cli.ts";

const now = 10_000_000;
const turn = (over: Partial<TurnView> = {}): TurnView => ({
  id: "tn_aaaaaaaaaaaaaaaaaaaaaa",
  conversation: "cv_bbbbbbbbbbbbbbbbbbbbbb",
  title: "The report",
  role: "planner",
  state: "running",
  startedAt: now - 3 * 60_000,
  endedAt: null,
  deadline: now + 27 * 60_000,
  model: "anthropic/claude-opus-5-5",
  step: "Answering",
  tools: 2,
  watchers: 0,
  steering: 0,
  watchable: true,
  ...over,
});

describe("a running turn in a line", () => {
  test("which chat, what he's doing, what it has cost, who's watching, when it stops by itself", () => {
    expect(turnLine(turn(), now)).toBe("tn_aaaaaaaaaaaaaaaaaaaaaa · The report (cv_bbbbbbbbbbbbbbbbbbbbbb) · planner · 3 min so far · Answering · 2 tools · nobody watching · stops by itself in 27 min");
    expect(turnLine(turn({ conversation: null, title: null, tools: 0, watchers: 2, steering: 1, step: null }), now)).toBe(
      "tn_aaaaaaaaaaaaaaaaaaaaaa · a temporary chat · planner · 3 min so far · starting · 1 of your messages waiting to reach him · 2 watching · stops by itself in 27 min",
    );
    expect(turnLine(turn({ watchable: false, step: null, model: null, watchers: 1 }), now)).toContain("may read the bank: not shown to this device · 2 tools · 1 watching");
  });
});

describe("a running turn's own words", () => {
  test("its chat's title and the step he is on are plain in the line", () => {
    const line = turnLine(turn({ title: "The\u001b[2K report\nfake · line", step: "Recalling\u001b[1A\r memories\u0007" }), now);
    expect(line).toContain("The[2K report fake · line (cv_bbbbbbbbbbbbbbbbbbbbbb)");
    expect(line).toContain(" · Recalling[1A memories · ");
    expect(line).not.toMatch(/[\u0000-\u001f\u007f-\u009f]/);
  });
});

describe("a chat's queue in words", () => {
  const queue = [
    { id: 7, text: "Then tidy\nup the branch.", role: null, at: now, by: "phone" },
    { id: 9, text: "And tell me when it's done.", role: null, at: now, by: null },
  ];
  test("in order, numbered as you'd name them; held says why and what lets it go", () => {
    expect(queueLines(queue, null)).toEqual(["2 queued: each is sent as the next turn when the one before it ends well.", "  1. Then tidy up the branch.  (from phone)", "  2. And tell me when it's done."]);
    expect(queueLines(queue, "stopped")[0]).toBe("2 queued, held: you stopped him. Nothing is sent until you resume (or send one now).");
    expect(queueLines([], null)).toEqual(["Nothing queued."]);
  });
});

describe("a quest in hand in words", () => {
  const quest = (over: Partial<QuestView> = {}): QuestView => ({
    quest: "q-abc",
    by: "you",
    goal: "Write the report",
    state: "working",
    plan: "1. Read the notes.\n2. Write it.\nDone when: the report exists.",
    step: 3,
    maxSteps: 30,
    doing: "$ cat notes.md",
    revisions: 1,
    gates: [
      { command: "test -s /work/out/report.md", by: "owner", exitCode: 1, excerpt: "" },
      { command: "grep -q Summary /work/out/report.md", by: "planner", exitCode: null },
    ],
    startedAt: now,
    updatedAt: now,
    silent: false,
    ...over,
  });

  test("where it stands, the plan, the step he's on, each gate's last result and whose it is", () => {
    expect(questLines(quest())).toEqual([
      "Write the report  (q-abc · run by you)",
      "  working · command 3 of 30 · sent back 1 time",
      "  now: $ cat notes.md",
      "    1. Read the notes.",
      "    2. Write it.",
      "    Done when: the report exists.",
      "  gate 1: failed (exit 1)  $ test -s /work/out/report.md  (yours)",
      "  gate 2: not run yet  $ grep -q Summary /work/out/report.md  (proposed by the planner)",
    ]);
  });

  test("an attempt says which; a silent one says so; an ended one shows how, not what it was doing", () => {
    expect(questLines(quest({ attempt: { of: "q-abc", index: 2, attempts: 3 }, quest: "q-abc.2" }))[0]).toBe("Write the report  (q-abc.2 · attempt 2 of 3 · run by you)");
    expect(questLines(quest({ silent: true }))[1]).toContain("no word from its runner for a while");
    const ended = questLines(quest({ state: "unverified", revisions: 2, summary: "Wrote it, but the gate never passed.", gates: [{ command: "false", by: "owner", exitCode: 1 }] }), { plan: false });
    expect(ended).toEqual(["Write the report  (q-abc · run by you)", "  finished, but not accepted · command 3 of 30 · sent back 2 times", "  gate 1: failed (exit 1)  $ false  (yours)", "  Wrote it, but the gate never passed."]);
  });
  test("its goal, what it is doing and its plan are a model's or an agent's words: plain, each on the line it was given", () => {
    const lines = questLines(quest({ goal: "Write\u001b[2J the report\r\nq-zzz · run by you", doing: "$ cat notes\u001b[1A.md\u0007", plan: "1. Read\u001b[31m the notes.\r\n2. Write it.\u2028Done when: it exists.\u202e" }));
    expect(lines.slice(0, 2)).toEqual(["Write[2J the report q-zzz · run by you  (q-abc · run by you)", "  working · command 3 of 30 · sent back 1 time"]);
    expect(lines.slice(2, 6)).toEqual(["  now: $ cat notes[1A.md", "    1. Read[31m the notes.", "    2. Write it.", "    Done when: it exists."]);
    for (const line of lines) expect(line).not.toMatch(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u202e]/);
  });
  test("a gate's command and a summary in a line carry nothing hidden", () => {
    const ended = questLines(quest({ state: "unverified", summary: "Wrote it\u001b[1A\u202e.", gates: [{ command: "test -s out\u001b[2K", by: "owner", exitCode: 0 }] }), { plan: false });
    expect(ended.slice(2)).toEqual(["  gate 1: passed  $ test -s out[2K  (yours)", "  Wrote it[1A."]);
  });
});

describe("his words at a terminal", () => {
  // What a terminal acts on rather than shows: escapes, carriage returns, bells, backspaces, the one-character CSI.
  const STEERS = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/;
  const shown = async (events: ChatStreamEvent[]) => {
    const out: string[] = [];
    const err: string[] = [];
    const io: Io = { out: (text) => void out.push(text), err: (text) => void err.push(text), tty: false };
    const result = await printTurn((async function* () { yield* events; })(), io);
    return { out: out.join(""), err: err.join(""), result };
  };

  test("an answer keeps its words and its lines, and nothing in it steers the terminal", async () => {
    const { out } = await shown([
      { type: "text", text: "Here it is:\n\n```sh\nls -la\n```\n" },
      { type: "text", text: "Done.\u001b[2J\u001b[H\rYou asked for this\u0007 \u009b31m\u202egnp.exe\u202c\u200b" },
      { type: "done", ref: "stand-in/m" },
    ]);
    expect(out).toBe("Here it is:\n\n```sh\nls -la\n```\nDone.[2J[H\nYou asked for this 31mgnp.exe\n");
    expect(out).not.toMatch(STEERS);
  });

  test("what he does beside it is plain too: a tool's title, what it was given, how it went, what came from the archive, why a model was skipped", async () => {
    const { err, result } = await shown([
      { type: "tool", id: "t1", name: "recall", title: "Recalling\u001b[1A", input: "the round\u001b]0;x\u0007 table" },
      { type: "tool_result", id: "t1", name: "recall", ok: true, summary: "3 memories\r\u001b[2Kall gates passed" },
      { type: "archive", entries: [{ id: "ar_1", title: "Notes\u001b[31m\nfake · line", kind: "note", trust: "untrusted" } as never] },
      { type: "fallback", from: "a/b", error: "429\u001b[2J too many" },
      { type: "steer", text: "and\u001b[1A check the gate" },
      { type: "error", error: "it broke" },
    ]);
    expect(err).not.toMatch(STEERS);
    expect(err).toBe("→ Recalling[1A the round]0;x table\n  ✓ 3 memories [2Kall gates passed\n[from the archive: ar_1 Notes[31m fake · line (untrusted)]\n[skipped a/b: 429[2J too many]\n\n↳ your message reached him: and[1A check the gate\n");
    expect(result).toEqual({ how: "error", error: "it broke" });
  });

  test("a queued message in a line carries nothing hidden", () => {
    expect(queueLines([{ id: "q1", text: "do\u001b[2J this\r\nnext", at: 1, by: null } as never], null)[1]).toBe("  1. do[2J this next");
  });
});
