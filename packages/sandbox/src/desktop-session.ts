/*
 * One held session with an agent's desktop (deskd, in its VM), from the VM's host: `desktop --session` under a
 * `docker exec -i` kept open, JSON lines both ways, so an action costs a line each way instead of an exec, a login
 * shell and a Python start (C0, 26 November 2026: 111 ms of path before a click; BRIEF-C1 step 3 measured both). It is
 * started on first use, and again after it ends (the VM stopped, deskd restarted); a VM whose image has no deskd ends
 * it at once, and says so. Nothing listens in the VM: the session is the host's own process, as an exec is.
 */

/** A long-lived process: what it is sent, what it prints a line at a time, and its end. */
export interface SessionProcess {
  write(text: string): void;
  onLine(take: (line: string) => void): void;
  kill(): void;
  exited: Promise<number>;
  /** Why the host ended it, when the host did (a line longer than any answer). */
  readonly why?: string | null;
}

/**
 * The longest line a desktop's session may answer with: a picture of its screen (a PNG where it can't make a JPEG) fits
 * well within it. deskd runs as the agent, so the line is the agent's to make: past this, the session is ended, never
 * held.
 */
export const SESSION_LINE_MAX = 16 * 1024 * 1024;

export type SpawnSession = (args: string[]) => SessionProcess;

/** The engine's binary run with `args`, its stdout read a line at a time (Bun's own process). */
export const spawnSession = (bin: string): SpawnSession => (args) => {
  const proc = Bun.spawn([bin, ...args], { stdin: "pipe", stdout: "pipe", stderr: "ignore" });
  proc.unref();
  const takers: ((line: string) => void)[] = [];
  let why: string | null = null;
  void (async () => {
    const decoder = new TextDecoder();
    // (A line held as its pieces until its end, each searched once: a long one costs its length, never its square.)
    let held: string[] = [];
    let heldLength = 0;
    for await (const chunk of proc.stdout) {
      let text = decoder.decode(chunk, { stream: true });
      let at: number;
      while ((at = text.indexOf("\n")) >= 0) {
        const line = held.length ? held.join("") + text.slice(0, at) : text.slice(0, at);
        held = [];
        heldLength = 0;
        text = text.slice(at + 1);
        for (const take of takers) take(line);
      }
      if (text) {
        held.push(text);
        heldLength += text.length;
      }
      if (heldLength > SESSION_LINE_MAX) {
        why = `its desktop answered with a line of more than ${SESSION_LINE_MAX / 2 ** 20} MB, longer than any answer`;
        held = [];
        proc.kill();
        return;
      }
    }
  })().catch(() => {});
  return {
    write: (text) => {
      proc.stdin.write(text);
      void proc.stdin.flush();
    },
    onLine: (take) => void takers.push(take),
    kill: () => proc.kill(),
    exited: proc.exited,
    get why() {
      return why;
    },
  };
};

/** The session ended before it answered: `code` is the exec's (127, or 2 from the older `desktop` that took no --session: no deskd in this VM's image). */
export class SessionEnded extends Error {
  constructor(
    readonly code: number,
    why?: string | null,
  ) {
    super(why ? `the desktop session was ended: ${why}` : code === 127 ? "this VM's desktop has no session (its image is older than deskd)" : `the desktop session ended (exit ${code})`);
  }
}

export class DesktopSession {
  private proc: SessionProcess | null = null;
  private next = 0;
  private readonly waiting = new Map<number, { resolve: (answer: Record<string, unknown>) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  /** How the last one ended, when it ended. */
  ended: number | null = null;
  /** Whether it has ever answered: one that ended before it did was no session (an image older than deskd). */
  answered = false;

  constructor(private readonly start: () => SessionProcess) {}

  get open(): boolean {
    return this.proc !== null;
  }

  call(request: Record<string, unknown>, timeoutMs: number): Promise<Record<string, unknown>> {
    if (!this.proc) {
      const proc = this.start();
      this.proc = proc;
      this.ended = null;
      proc.onLine((line) => this.answer(line));
      void proc.exited.then((code) => {
        if (this.proc !== proc) return;
        this.proc = null;
        this.ended = code;
        for (const w of this.waiting.values()) {
          clearTimeout(w.timer);
          w.reject(new SessionEnded(code, proc.why));
        }
        this.waiting.clear();
      });
    }
    const id = ++this.next;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiting.delete(id);
        reject(new Error(`the desktop didn't answer within ${Math.round(timeoutMs / 1000)} s`));
      }, timeoutMs);
      this.waiting.set(id, { resolve, reject, timer });
      this.proc!.write(`${JSON.stringify({ ...request, id })}\n`);
    });
  }

  private answer(line: string): void {
    let answer: Record<string, unknown>;
    try {
      answer = JSON.parse(line) as Record<string, unknown>;
    } catch {
      return;
    }
    this.answered = true;
    const w = this.waiting.get(answer.id as number);
    if (!w) return;
    clearTimeout(w.timer);
    this.waiting.delete(answer.id as number);
    w.resolve(answer);
  }

  close(): void {
    const proc = this.proc;
    this.proc = null;
    proc?.kill();
    for (const w of this.waiting.values()) {
      clearTimeout(w.timer);
      w.reject(new SessionEnded(-1));
    }
    this.waiting.clear();
  }
}
