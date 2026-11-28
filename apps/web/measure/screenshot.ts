/*
 * A screenshot over the DevTools protocol, never waited for forever. Chrome answers Page.captureScreenshot with the next
 * frame it draws, and one that draws none answers never: first-load.ts --shots waited 30 minutes for one, silent, until
 * its shell stopped it (28 November 2026, while another job held the machine at a load of 145). So each is given
 * SCREENSHOT_MS to come and is asked for once more if it doesn't; both are said. A second silence fails it, saying which
 * it was, for its caller to go on without it (or to stop, where nothing can go on without it). Chrome's own refusal
 * fails it at once: only silence is asked again.
 */

/** How long a screenshot is given to come: a page as far down as it goes, on a loaded machine, takes a few seconds. */
export const SCREENSHOT_MS = 30_000;

/** A screenshot that didn't come, asked for twice: its message says which, and that it wasn't taken. */
export class NoScreenshot extends Error {}

/**
 * The picture (base64) that `capture` (Page.captureScreenshot, asked) answers; `what` names it in what is said. An ask
 * that gets no answer is given up: its `signal` aborts, so its asker forgets it.
 */
export async function screenshot(
  capture: (signal: AbortSignal) => Promise<{ data: string }>,
  what: string,
  { ms = SCREENSHOT_MS, say = (line: string) => console.error(line) }: { ms?: number; say?: (line: string) => void } = {},
): Promise<string> {
  for (let asked = 1; ; asked++) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const silence = new Promise<null>((done) => (timer = setTimeout(() => done(null), ms)));
    const ask = new AbortController();
    try {
      const answer = await Promise.race([capture(ask.signal), silence]);
      if (answer) return answer.data;
      ask.abort(new Error(`${what}: no screenshot came in ${ms / 1000} s`));
    } finally {
      clearTimeout(timer);
    }
    if (asked === 2) throw new NoScreenshot(`${what}: no screenshot came in ${ms / 1000} s, twice: not taken`);
    say(`${what}: no screenshot came in ${ms / 1000} s; asking once more`);
  }
}
