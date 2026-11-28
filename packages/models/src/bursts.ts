/*
 * Too many calls at once. A provider that limits how fast it is called answers a burst with 429 while its allowance is
 * far from spent: OpenCode Go's "Rate limit exceeded. Please try again later." past about 25 calls a minute (28 November
 * 2026, the desktop bench), which several agents and looks on one plan reach in real work. Such a refusal (windows.ts
 * isBurst: a 429 that names no allowance, its wait a minute at most or unsaid) is waited out here and asked again, for
 * every caller alike: a tool's call and a look through the gateway, a run's turn and a chat through chat(). It waits as
 * long as its provider said (its retry-after, or its words), and at least 2, 4, 8, 16 and then 30 s: a minute in all at
 * most (BURST_MS). A caller that has gone stops the wait. Never a window (windows.ts): the plan isn't spent.
 *
 * Still refused after that, the call is answered 429 in plain words (burstWords): too many calls at once, how often it
 * was asked and for how long, and its provider's own words, its retry-after kept. Marked as waited out (WAITED), so a
 * caller that would wait again for itself doesn't wait it all over again: chat through another node's gateway, and an
 * SDK's own retries (`x-should-retry: false`, which Anthropic's and OpenAI's read).
 */

import { refusalWords } from "./adapters.ts";
import { BURST_MS, BURST_TYPE, isBurst, retryAfterAt, spentUntil } from "./windows.ts";

/** The header a burst's last refusal carries once it was waited out: how often it was asked, and how long it waited. */
export const WAITED = "x-invincible-waited";

/** The wait before each ask again, at least (its provider's own, when it says one, may be longer). */
const BACKOFF_MS = [2_000, 4_000, 8_000, 16_000, 30_000];

export interface BurstWait {
  /** Whose refusals they are (a provider's id), to say them. */
  provider: string;
  /** Waits `ms`, or until `signal` aborts (tests count the waits instead). */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  /** The clock, for a retry-after given as a date. */
  now?: () => number;
}

const sleeping = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve) => {
    if (signal?.aborted) return resolve();
    const done = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal?.addEventListener("abort", done, { once: true });
  });

/** A burst still refused after it was waited out, said plainly: how often and for how long, and its provider's words. */
export function burstWords(provider: string, said: string, asked: number, waitedMs: number): string {
  const words = refusalWords(`429 ${said}`, 200).replace(/^429:?\s*/, "");
  return `${provider} is taking too many calls at once: asked ${asked} times over ${Math.round(waitedMs / 1000)} s, it still answered 429${words ? ` ("${words}")` : ""}. That's a limit on how fast it's called, not its allowance: ask again in a minute.`;
}

/** Whether a call can be sent again as it was: its address a string or a URL, and its body none, words or bytes. */
const resendable = (input: Parameters<typeof fetch>[0], init?: RequestInit) =>
  !(input instanceof Request) && (init?.body == null || typeof init.body === "string" || init.body instanceof ArrayBuffer || ArrayBuffer.isView(init.body));

/** `base`, waiting out each burst its provider answers and asking again (see above). */
export const waitingOutBursts = (base: typeof fetch, wait: BurstWait): typeof fetch =>
  (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const sleep = wait.sleep ?? sleeping;
    const now = wait.now ?? Date.now;
    const signal = init?.signal ?? undefined;
    let waited = 0;
    for (let asked = 1; ; asked++) {
      const response = await base(input, init);
      if (response.status !== 429 || !resendable(input, init)) return response;
      const said = await response.text();
      const headers = new Headers(response.headers);
      const as = () => new Response(said, { status: 429, statusText: response.statusText, headers });
      const at = now();
      const until = spentUntil(said, at) ?? retryAfterAt(headers.get("retry-after"), at);
      const asks = until === null ? 0 : until - at;
      // An allowance, or a wait past a minute: no burst, as it came (windows.ts reads it).
      if (!isBurst(`429 ${said}`) || asks > BURST_MS) return as();
      // One a gateway has waited out already: as it came, and not to be waited out again by an SDK either.
      if (headers.has(WAITED)) {
        headers.set("x-should-retry", "false");
        return as();
      }
      const gaveUp = () => {
        const out = new Headers({ [WAITED]: `${asked} asks, ${waited} ms`, "x-should-retry": "false" });
        const retryAfter = headers.get("retry-after");
        if (retryAfter) out.set("retry-after", retryAfter);
        return Response.json({ error: { type: BURST_TYPE, message: burstWords(wait.provider, said, asked, waited) } }, { status: 429, headers: out });
      };
      const next = Math.max(asks, BACKOFF_MS[asked - 1] ?? Infinity);
      if (waited + next > BURST_MS || signal?.aborted) return gaveUp();
      await sleep(next, signal);
      waited += next;
      // (Its caller gone meanwhile: not asked again.)
      if (signal?.aborted) return gaveUp();
    }
  }) as typeof fetch;
