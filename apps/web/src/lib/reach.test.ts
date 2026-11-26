import { describe, expect, test } from "bun:test";
import { REACH_DOUBT_MS, reachability } from "./reach.ts";

/** A handler with its clock and its probe in hand: `later()` runs what's due, `answer()` settles the probe. */
function reach({ offline = false } = {}) {
  let says = true;
  const said: boolean[] = [];
  const timers: { ms: number; run: () => void; off: boolean }[] = [];
  let probes = 0;
  let settle: (reached: boolean) => void = () => {};
  const handle = reachability({
    set: (ok) => {
      says = ok;
      said.push(ok);
    },
    says: () => says,
    browserOffline: () => offline,
    probe: () => {
      probes++;
      return new Promise((resolve) => (settle = resolve));
    },
    after: (ms, run) => {
      const timer = { ms, run, off: false };
      timers.push(timer);
      return () => void (timer.off = true);
    },
  });
  const later = () => {
    for (const t of timers.splice(0)) if (!t.off) t.run();
  };
  const answer = async (reached: boolean) => {
    settle(reached);
    await Promise.resolve();
  };
  return { handle, said, timers, later, answer, probes: () => probes };
}

describe("whether the app says it can reach Galahad", () => {
  test("one failed request is doubted, not believed: nothing is said, and the node is asked once more a moment later", async () => {
    const r = reach();
    r.handle(false);
    expect(r.said).toEqual([]);
    expect(r.timers.map((t) => t.ms)).toEqual([REACH_DOUBT_MS]);
    r.later();
    expect(r.probes()).toBe(1);
    // It answers: it was a busy node's slow answer, and nothing was ever said.
    await r.answer(true);
    expect(r.said).toEqual([]);
  });

  test("a request that succeeds meanwhile ends the doubt: the node isn't asked again", () => {
    const r = reach();
    r.handle(false);
    r.handle(true);
    r.later();
    expect(r.probes()).toBe(0);
    expect(r.said.includes(false)).toBe(false);
  });

  test("the node doesn't answer when asked again either: then it says so, once, until a request gets through", async () => {
    const r = reach();
    r.handle(false);
    r.later();
    await r.answer(false);
    expect(r.said).toEqual([false]);
    // More failures add nothing: it has said so.
    r.handle(false);
    expect(r.timers).toEqual([]);
    r.handle(true);
    expect(r.said).toEqual([false, true]);
  });

  test("several failures in a row are one doubt, asked about once", () => {
    const r = reach();
    r.handle(false);
    r.handle(false);
    r.handle(false);
    expect(r.timers).toHaveLength(1);
  });

  test("the browser saying it's offline is taken at its word, at once", () => {
    const r = reach({ offline: true });
    r.handle(false);
    expect(r.said).toEqual([false]);
    expect(r.timers).toEqual([]);
  });
});
