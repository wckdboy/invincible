import { EXIT, usageError } from "./exit.ts";
import { Waker } from "./follow.ts";
import type { Command, Io } from "./io.ts";
import { boardLines, DONE_SHOWN, faint, fit, styleFor } from "./render.ts";
import { type BoardView, boardView, readBoard, rowJson, type Section, SECTIONS } from "./view.ts";

/*
 * inv, alone: the board (docs/CLI.md). Your agent's line, then what needs you, what is new to you, what is at work and
 * what is done, the nodes, and what today cost. Piped, it prints plain lines once. In a terminal it stays, and is drawn
 * again in place when the node's live stream says the work changed (and only then: at rest nothing moves, the cursor
 * hidden so not even it blinks), never taller than the terminal, until Ctrl-C.
 */

export const boardJson = (view: BoardView) => {
  const rows = (section: Section) => view.work[section].map((row) => rowJson(row, section));
  return {
    primary: { name: view.primary.name, line: view.primary.line },
    needs: rows("needs"),
    active: rows("active"),
    working: rows("working"),
    done: rows("done"),
    nodes: view.nodes,
    cost: view.cost ? { todayUsd: Math.round(view.cost.usd * 1e6) / 1e6, complete: view.cost.complete, atMost: view.cost.atMost === true } : null,
  };
};

/** What a drawing shows, less what only time changes (each row's age): a new one of these is a reason to draw again. */
const versionOf = (view: BoardView): string => JSON.stringify({ ...boardJson(view), ...Object.fromEntries(SECTIONS.map((section) => [section, view.work[section].map((row) => [row.id, row.word, row.detail, row.title])])) });

/** The board's lines for a terminal `rows` tall: fewer of what is done first, then cut, so it is never taller. */
function fitted(view: BoardView, io: Io): string[] {
  for (let done = DONE_SHOWN; done >= 0; done--) {
    const lines = boardLines(view, io.style, { doneShown: done });
    if (io.rows === null || lines.length <= io.rows - 1) return lines;
    if (done === 0) return [...lines.slice(0, Math.max(1, io.rows - 2)), faint(io.style, " … more: inv tasks")];
  }
  return [];
}

export const boardCommand: Command = async (conn, args, flags, io) => {
  if (args.length) throw usageError("usage: inv [--json]");
  const { client } = await conn();
  let view = boardView(await readBoard(client, io.now));
  if (flags.json) {
    io.out(`${JSON.stringify(boardJson(view))}\n`);
    return EXIT.ok;
  }
  if (io.style.width === null) {
    io.out(`${boardLines(view, io.style).join("\n")}\n`);
    return EXIT.ok;
  }
  // In a terminal: drawn, then drawn again in place over itself when the work changes.
  let drawn = 0;
  let shown = "";
  const draw = (force = false): void => {
    const version = versionOf(view);
    if (!force && version === shown) return;
    shown = version;
    const lines = fitted(view, io);
    io.out(`${drawn ? `\x1b[${drawn}F` : ""}\x1b[J${lines.join("\n")}\n`);
    drawn = lines.length;
  };
  io.out("\x1b[?25l");
  const resized = io.onResize((size) => {
    io.style.width = styleFor({ isTTY: true, columns: size.columns }, io.env).width;
    io.rows = size.rows;
    draw(true);
  });
  const waker = new Waker(client, ["team", "actions", "fleet", "turns", "runs"], io.signal);
  let down = false;
  try {
    draw(true);
    while (!io.signal.aborted) {
      await waker.next(60_000);
      if (io.signal.aborted) break;
      try {
        view = boardView(await readBoard(client, io.now));
      } catch (error) {
        // The node stopped answering: said once under the board, which stays as it was until it answers again.
        if (!down) {
          io.out(`${faint(io.style, fit(` ${(error as Error).message} · trying again`, (io.style.width ?? 80) - 1))}\n`);
          drawn += 1;
          down = true;
        }
        continue;
      }
      draw(down);
      down = false;
    }
  } finally {
    waker.close();
    resized();
    io.out("\x1b[?25h");
  }
  return EXIT.ok;
};
