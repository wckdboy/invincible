/*
 * What is typed into a terminal, sent in order (the CLI's and the app's alike): one request at a time, and what is typed
 * (or a new size) while one is on its way goes next, together. A terminal is a stream of keys, so nothing may overtake.
 * Zod-free, so the app has it as the node does.
 */

export interface TerminalSize {
  cols: number;
  rows: number;
}

export interface TerminalInput {
  data?: string;
  size?: TerminalSize;
}

/** The most one request carries (the route's limit). */
const MAX_DATA = 65_536;

export interface InputQueue {
  type(data: string): void;
  resize(size: TerminalSize): void;
  /** Resolves when everything given so far has been sent (or sending it failed). */
  idle(): Promise<void>;
}

/** `send` makes one request; `failed` hears a request that failed, after which nothing more is sent. */
export function inputQueue(send: (input: TerminalInput) => Promise<unknown>, failed: (error: unknown) => void): InputQueue {
  let typed = "";
  let size: TerminalSize | null = null;
  let sending: Promise<void> | null = null;
  let broken = false;
  const flush = (): void => {
    if (broken || sending || (!typed && !size)) return;
    const data = typed.slice(0, MAX_DATA);
    typed = typed.slice(data.length);
    const input: TerminalInput = { ...(data ? { data } : {}), ...(size ? { size } : {}) };
    size = null;
    sending = send(input).then(
      () => {
        sending = null;
        flush();
      },
      (error: unknown) => {
        sending = null;
        broken = true;
        failed(error);
      },
    );
  };
  return {
    type(data) {
      typed += data;
      flush();
    },
    resize(next) {
      size = next;
      flush();
    },
    async idle() {
      while (sending) await sending;
    },
  };
}
