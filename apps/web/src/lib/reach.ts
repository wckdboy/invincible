/*
 * Whether the app says it can reach Galahad. One request that failed (a busy node's slow answer, a hiccup in the proxy
 * in front of it) is doubted, not believed: the node is asked once more a moment later, and only if it doesn't answer
 * then either does the app say it can't be reached. Before, one failure raised the banner that says so at once, which
 * pushed the page down and said what wasn't so. The browser saying it's offline is taken at its word, at once.
 */

export interface ReachOptions {
  /** Says so: true, reached; false, the banner that says Galahad can't be reached. */
  set(ok: boolean): void;
  /** What it says now. */
  says(): boolean;
  /** The browser itself says it's offline. */
  browserOffline(): boolean;
  /** Asks the node once whether it answers at all (api.ts nodeReachable). */
  probe(): Promise<boolean>;
  /** Runs `run` after `ms`; returns how to call it off. */
  after(ms: number, run: () => void): () => void;
}

/** How long a failed request is doubted before the node is asked again. */
export const REACH_DOUBT_MS = 2000;

/** The handler for each request's outcome (api.ts setNetworkHandler). */
export function reachability(o: ReachOptions): (ok: boolean) => void {
  /** Calls off the doubt under way, when there is one. */
  let doubt: (() => void) | null = null;
  const settle = () => {
    doubt?.();
    doubt = null;
  };
  return (ok) => {
    if (ok) {
      settle();
      o.set(true);
      return;
    }
    if (o.browserOffline()) {
      settle();
      o.set(false);
      return;
    }
    // Already in doubt, or already said: nothing more to do until a request gets through.
    if (doubt || !o.says()) return;
    doubt = o.after(REACH_DOUBT_MS, () => {
      doubt = null;
      void o.probe().then((reached) => {
        // (A request that got through meanwhile has said so already.)
        if (!reached && o.says()) o.set(false);
      });
    });
  };
}
