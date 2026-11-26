/*
 * A Mac set to stay on (a Mac mini serving the fleet: docs/MAC.md) is kept from sleeping while its node runs, by macOS's
 * own `caffeinate`: `-s` holds off system sleep while it is on mains power (a laptop on its battery isn't kept up), and
 * `-w` ties the assertion to the node's own process, so it is let go when the node stops, however it stops. The display
 * may sleep. On anything but a Mac there is nothing to hold: a Linux server doesn't sleep.
 */

export interface Awake {
  /** Let the Mac sleep again. */
  stop(): void;
}

export interface KeepAwakeDeps {
  platform?: string;
  which?: (cmd: string) => string | null;
  spawn?: (argv: string[]) => { kill(): void };
  pid?: number;
}

/** Holds this Mac awake while the node runs, or null where it can't (not a Mac, or no caffeinate). */
export function keepAwake(deps: KeepAwakeDeps = {}): Awake | null {
  const platform = deps.platform ?? process.platform;
  const which = deps.which ?? Bun.which;
  if (platform !== "darwin" || !which("caffeinate")) return null;
  const spawn = deps.spawn ?? ((argv: string[]) => Bun.spawn(argv, { stdin: "ignore", stdout: "ignore", stderr: "ignore" }));
  const held = spawn(["caffeinate", "-s", "-w", String(deps.pid ?? process.pid)]);
  return { stop: () => held.kill() };
}
