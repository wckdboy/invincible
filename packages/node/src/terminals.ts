import { randomId, type TerminalEvent, type TerminalView } from "@galahad/core";
import { type LedgerEntryInput, SandboxError, type TerminalProcess } from "@galahad/sandbox";

/*
 * Terminals in this node's sandboxes, for you: each a login shell on a real terminal (SandboxHost.terminal), held
 * here while it is open. What it showed lately (its last 256 KB) is kept in memory, so a device that comes back, or a
 * second one, sees the screen as it was; nothing typed or shown is written anywhere, not the ledger, a log or the mind.
 * The ledger says when one opened and when and why it closed.
 *
 * One stays open while a device watches it, and for fifteen minutes after the last one leaves: a phone that goes off
 * to finish a sign-in in its browser comes back to the same shell. Four at once on a node, at most.
 */

const MAX_OPEN = 4;
const MAX_WATCHERS = 4;
const SCROLLBACK_BYTES = 256 * 1024;
const IDLE_MS = 15 * 60_000;
/** How long an ended terminal is still listed, so a device coming back learns how it ended. */
const ENDED_KEEP_MS = 60_000;

type Size = { cols: number; rows: number };

export interface TerminalsOptions {
  /** Starts a shell on a terminal in that sandbox, its output to `onData` (SandboxHost.terminal). */
  start: (sandbox: string, size: Size, onData: (bytes: Uint8Array) => void) => Promise<{ name: string; quest: string | null; process: TerminalProcess }>;
  ledger: (entry: LedgerEntryInput) => void;
  now?: () => number;
}

interface Held {
  view: TerminalView;
  quest: string | null;
  process: TerminalProcess;
  shown: Uint8Array[];
  shownBytes: number;
  watchers: Set<(event: TerminalEvent) => void>;
  /** When it was last watched or typed into. */
  used: number;
  /** When its shell ended; null while it runs. */
  ended: number | null;
  /** Why it is being closed, when it was closed rather than ended by its shell. */
  closing: string | null;
}

const took = (ms: number): string => {
  const s = Math.floor(ms / 1000);
  return s >= 3600 ? `${Math.floor(s / 3600)}h ${Math.floor(s / 60) % 60}m` : `${Math.floor(s / 60)}m ${s % 60}s`;
};

export class Terminals {
  private readonly held = new Map<string, Held>();
  private starting = 0;
  private readonly now: () => number;
  private readonly sweeper: ReturnType<typeof setInterval>;

  constructor(private readonly opts: TerminalsOptions) {
    this.now = opts.now ?? Date.now;
    this.sweeper = setInterval(() => this.sweep(), 30_000);
    this.sweeper.unref?.();
  }

  async open(sandbox: string, size: Size): Promise<TerminalView> {
    const running = [...this.held.values()].filter((t) => t.ended === null).length + this.starting;
    if (running >= MAX_OPEN) throw new SandboxError(`${MAX_OPEN} terminals are open on this node, its limit: close one first`, 429);
    this.starting++;
    let terminal: Held | null = null;
    const early: Uint8Array[] = [];
    try {
      const started = await this.opts.start(sandbox, size, (bytes) => (terminal ? this.output(terminal, bytes) : early.push(bytes.slice())));
      const at = this.now();
      terminal = {
        view: { id: `tm_${randomId(12)}`, sandbox, name: started.name, cols: size.cols, rows: size.rows, opened: at, exitCode: null, watchers: 0 },
        quest: started.quest,
        process: started.process,
        shown: [],
        shownBytes: 0,
        watchers: new Set(),
        used: at,
        ended: null,
        closing: null,
      };
    } finally {
      this.starting--;
    }
    const held = terminal;
    for (const bytes of early) this.output(held, bytes);
    this.held.set(held.view.id, held);
    this.note(held, `opened (${size.cols}×${size.rows})`);
    void held.process.exited.then(
      (code) => this.ended(held, code),
      () => this.ended(held, -1),
    );
    return this.viewOf(held);
  }

  /** Every terminal on this node, open or lately ended, oldest first. */
  list(): TerminalView[] {
    return [...this.held.values()].map((t) => this.viewOf(t));
  }

  /** Watch one: what it showed lately at once, then what it shows; its exit last. Returns how to stop watching. */
  watch(id: string, send: (event: TerminalEvent) => void): () => void {
    const terminal = this.get(id);
    if (terminal.watchers.size >= MAX_WATCHERS) throw new SandboxError(`${MAX_WATCHERS} devices are watching that terminal already`, 429);
    if (terminal.shownBytes) send({ type: "output", data: Buffer.concat(terminal.shown).toString("base64") });
    if (terminal.ended !== null) {
      send({ type: "exit", code: terminal.view.exitCode ?? -1 });
      return () => {};
    }
    terminal.watchers.add(send);
    terminal.used = this.now();
    return () => {
      if (terminal.watchers.delete(send)) terminal.used = this.now();
    };
  }

  /** Keys typed or pasted, and its size now: in the order they come. */
  input(id: string, input: { data?: string | undefined; size?: Size | undefined }): void {
    const terminal = this.get(id);
    if (terminal.ended !== null || terminal.closing) throw new SandboxError("that terminal's shell has ended", 409);
    terminal.used = this.now();
    if (input.size && (input.size.cols !== terminal.view.cols || input.size.rows !== terminal.view.rows)) {
      terminal.process.resize(input.size.cols, input.size.rows);
      terminal.view.cols = input.size.cols;
      terminal.view.rows = input.size.rows;
    }
    if (input.data) terminal.process.write(input.data);
  }

  /** Close one: its shell is ended, and it is gone from the list at once. */
  close(id: string): void {
    const terminal = this.get(id);
    this.held.delete(id);
    this.end(terminal, "you closed it");
  }

  /** The node is stopping: every shell is ended. */
  closeAll(): void {
    clearInterval(this.sweeper);
    for (const terminal of this.held.values()) this.end(terminal, "the node stopped");
    this.held.clear();
  }

  /** Close what nobody has watched for fifteen minutes; forget what ended a minute ago. (Every 30 s, and by tests.) */
  sweep(): void {
    const now = this.now();
    for (const [id, terminal] of this.held) {
      if (terminal.ended !== null) {
        if (now - terminal.ended > ENDED_KEEP_MS) this.held.delete(id);
      } else if (!terminal.watchers.size && !terminal.closing && now - terminal.used > IDLE_MS) {
        this.end(terminal, `nobody watched it for ${IDLE_MS / 60_000} minutes`);
      }
    }
  }

  private get(id: string): Held {
    const terminal = this.held.get(id);
    if (!terminal) throw new SandboxError("no such terminal on this node (one closed or ended a while ago is gone)", 404);
    return terminal;
  }

  private viewOf(terminal: Held): TerminalView {
    return { ...terminal.view, watchers: terminal.watchers.size };
  }

  private output(terminal: Held, bytes: Uint8Array): void {
    const copy = bytes.slice();
    terminal.shown.push(copy);
    terminal.shownBytes += copy.length;
    while (terminal.shownBytes - terminal.shown[0]!.length >= SCROLLBACK_BYTES) terminal.shownBytes -= terminal.shown.shift()!.length;
    if (terminal.shownBytes > SCROLLBACK_BYTES) {
      terminal.shown[0] = terminal.shown[0]!.subarray(terminal.shownBytes - SCROLLBACK_BYTES);
      terminal.shownBytes = SCROLLBACK_BYTES;
    }
    const event: TerminalEvent = { type: "output", data: Buffer.from(copy).toString("base64") };
    for (const send of terminal.watchers) send(event);
  }

  private end(terminal: Held, why: string): void {
    if (terminal.ended !== null || terminal.closing) return;
    terminal.closing = why;
    terminal.process.kill();
  }

  private ended(terminal: Held, code: number): void {
    terminal.ended = this.now();
    terminal.view.exitCode = code;
    this.note(terminal, `closed after ${took(terminal.ended - terminal.view.opened)}: ${terminal.closing ?? `its shell ended (exit ${code})`}`);
    for (const send of terminal.watchers) send({ type: "exit", code });
    terminal.watchers.clear();
  }

  private note(terminal: Held, detail: string): void {
    try {
      this.opts.ledger({ class: "modify", resource: "sandbox.terminal", target: terminal.view.name, verdict: "allow", ...(terminal.quest ? { quest: terminal.quest } : {}), detail });
    } catch {
      // (A shell that ends as the node closes its mind: there is nowhere left to write it.)
    }
  }
}
