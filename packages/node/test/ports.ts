/*
 * Ports for a test's servers that no other server is handed. A port taken with `port: 0` and let go, to be used a moment
 * later, can be handed to the next server that asks for any port before the test uses it, and the daemon then fails to
 * start ("Is port … in use?", as CI saw on 17 November 2026). These come from below the range the OS hands out for
 * `port: 0` (Linux 32768–60999, macOS 49152–65535), one after another from a random start, each checked free as it is
 * given.
 */
export const TEST_PORTS = { first: 20_000, last: 31_999 } as const;
let next = TEST_PORTS.first + Math.floor(Math.random() * (TEST_PORTS.last - TEST_PORTS.first + 1));

export function freePort(): number {
  for (let tried = 0; tried <= TEST_PORTS.last - TEST_PORTS.first; tried++) {
    const port = next;
    next = next === TEST_PORTS.last ? TEST_PORTS.first : next + 1;
    try {
      Bun.serve({ port, hostname: "127.0.0.1", fetch: () => new Response() }).stop(true);
      return port;
    } catch {
      // Something else on this machine has it: the next one.
    }
  }
  throw new Error(`no port free for a test between ${TEST_PORTS.first} and ${TEST_PORTS.last}`);
}
