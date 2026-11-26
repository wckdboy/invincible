import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import css from "@xterm/xterm/css/xterm.css" with { type: "text" };
import own from "./term.css" with { type: "text" };

/*
 * The terminal emulator (xterm.js), loaded on demand as /term.js when a terminal opens, so the rest of the app never
 * carries it. It draws what the node sends and hands back what is typed; the view (views/terminal.ts) does the rest.
 */

export interface Emulator {
  write(bytes: Uint8Array): void;
  /** Clear it, to draw again what the node sends when it is taken up again. */
  reset(): void;
  /** Its size in characters, fitted to its box as it is now. */
  fit(): { cols: number; rows: number };
  /** What is typed (and pasted) into it. */
  onKeys(listener: (data: string) => void): void;
  focus(): void;
  dispose(): void;
}

export function mountEmulator(box: HTMLElement): Emulator {
  if (!document.getElementById("term-css")) document.head.append(Object.assign(document.createElement("style"), { id: "term-css", textContent: `${css}\n${own}` }));
  const mono = getComputedStyle(document.documentElement).getPropertyValue("--font-mono").trim();
  const term = new Terminal({
    fontFamily: mono || "monospace",
    fontSize: matchMedia("(max-width: 639px)").matches ? 12 : 13,
    cursorBlink: true,
    scrollback: 5000,
    theme: { background: "#060607", foreground: "#e4e4e8", cursor: "#ededef", selectionBackground: "#3a3a42" },
  });
  const fitter = new FitAddon();
  term.loadAddon(fitter);
  term.open(box);
  return {
    write: (bytes) => term.write(bytes),
    reset: () => term.reset(),
    fit() {
      fitter.fit();
      return { cols: term.cols, rows: term.rows };
    },
    onKeys: (listener) => void term.onData(listener),
    focus: () => term.focus(),
    dispose: () => term.dispose(),
  };
}
