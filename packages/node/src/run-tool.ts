/*
 * `galahad run -- <tool>`: the tool's gateway token lives exactly as long as the tool.
 * It's revoked when the tool exits, however galahad run is asked to stop:
 *
 * - SIGTERM or SIGHUP (a kill, a closed terminal): the tool is stopped with the same
 *   signal, and the token revoked, before galahad run exits.
 * - SIGINT (Ctrl+C): the terminal already sends it to the tool, which is in the
 *   foreground, and an interactive tool may take it as "cancel" and carry on. So galahad
 *   run waits for the tool, as a shell does, instead of dying with the token still live.
 */

/** Signals that stop the tool. */
export const STOP_SIGNALS = ["SIGTERM", "SIGHUP"] as const;
/** Signals the tool decides about: galahad run outlives them, and revokes when the tool exits. */
export const WAIT_SIGNALS = ["SIGINT"] as const;

interface Tool {
  exited: Promise<number>;
  kill(signal?: NodeJS.Signals): void;
}

interface Signals {
  on(signal: string, listener: (signal: NodeJS.Signals) => void): unknown;
  off(signal: string, listener: (signal: NodeJS.Signals) => void): unknown;
}

/**
 * Starts the tool and waits for it, revoking its token once whichever way it ends (never
 * waiting longer than `patienceMs` for the node). The signals are taken before the tool
 * starts, so none can arrive in between and end galahad run the old way.
 */
export async function runWithToken(start: () => Tool, revoke: () => Promise<unknown>, signals: Signals = process, patienceMs = 5000): Promise<number> {
  let revoking: Promise<unknown> | null = null;
  const revokeOnce = () => {
    if (!revoking) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const patience = new Promise((resolve) => (timer = setTimeout(resolve, patienceMs)));
      revoking = Promise.race([revoke().catch(() => {}), patience]).finally(() => clearTimeout(timer));
    }
    return revoking;
  };
  // Handlers run between events, never inside the synchronous part below: tool is set before any can run.
  let tool: Tool | undefined;
  const stop = (signal: NodeJS.Signals) => {
    tool?.kill(signal);
    void revokeOnce();
  };
  const wait = () => {};
  for (const signal of STOP_SIGNALS) signals.on(signal, stop);
  for (const signal of WAIT_SIGNALS) signals.on(signal, wait);
  try {
    tool = start();
    return await tool.exited;
  } finally {
    for (const signal of STOP_SIGNALS) signals.off(signal, stop);
    for (const signal of WAIT_SIGNALS) signals.off(signal, wait);
    await revokeOnce();
  }
}
