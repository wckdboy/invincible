#!/usr/bin/env bun
import { EXIT } from "./exit.ts";
import type { Io } from "./io.ts";
import { styleFor } from "./render.ts";
import { run } from "./run.ts";

/*
 * inv, the command line (docs/CLI.md): `bun run inv`, or `bun packages/node/src/inv/main.ts`. This file only joins the
 * commands (run.ts) to this process: its output, its terminal, its environment and Ctrl-C. Pressed once, Ctrl-C does
 * what the command says it does (a follower leaves and the work goes on; an answer is asked to stop); pressed twice,
 * inv leaves at once, with 1.
 */

const controller = new AbortController();
const interrupts: (() => void)[] = [];
const resizes: ((size: { columns: number; rows: number }) => void)[] = [];
const tty = process.stdout.isTTY === true;
let presses = 0;

process.on("SIGINT", () => {
  presses += 1;
  if (presses > 1) {
    if (tty) process.stdout.write("\x1b[?25h\n");
    process.exit(EXIT.error);
  }
  const handler = interrupts.at(-1);
  if (handler) handler();
  else controller.abort();
});
process.on("SIGWINCH", () => {
  for (const handler of resizes) handler({ columns: process.stdout.columns ?? 80, rows: process.stdout.rows ?? 24 });
});

const io: Io = {
  out: (text) => void process.stdout.write(text),
  err: (text) => void process.stderr.write(text),
  style: styleFor(process.stdout, process.env),
  errStyle: styleFor(process.stderr, process.env),
  rows: tty ? (process.stdout.rows ?? 24) : null,
  env: process.env,
  now: Date.now,
  signal: controller.signal,
  onInterrupt(handler) {
    interrupts.push(handler);
    return () => void interrupts.splice(interrupts.indexOf(handler), 1);
  },
  onResize(handler) {
    resizes.push(handler);
    return () => void resizes.splice(resizes.indexOf(handler), 1);
  },
  // (A line typed here: only where stdin is a terminal, so a pipe is never read as one.)
  ...(process.stdin.isTTY
    ? {
        readLine: async (prompt: string) => {
          const { createInterface } = await import("node:readline");
          const lines = createInterface({ input: process.stdin, output: process.stderr });
          try {
            return await new Promise<string | null>((resolve) => {
              lines.question(prompt, resolve);
              lines.once("close", () => resolve(null));
            });
          } finally {
            lines.close();
          }
        },
      }
    : {}),
};

const code = await run(Bun.argv.slice(2), io);
// What was written goes out before inv does.
await new Promise<void>((resolve) => process.stdout.write("", () => resolve()));
await new Promise<void>((resolve) => process.stderr.write("", () => resolve()));
process.exit(code);
