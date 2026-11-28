import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { outputOf } from "./processes.ts";

/** How long git may take to describe the checkout before the revision is "unknown". */
const DESCRIBE_MS = 10_000;

let asked: Promise<string> | null = null;

/**
 * This checkout's revision: the deploy's REVISION file, else git's describe, else "unknown". Asked once a process, as
 * the code it runs is the code it began with, and never by a synchronous spawn: Bun.spawnSync holds the JS thread until
 * its child is seen to end, and on the Mac mini (bun 1.4.2, 28 November 2026) one lost git's end and went round its wait
 * for 58 minutes at 91 % of a core. The child was long gone, never reaped, and no timeout could fire. That held the whole
 * `bun run check`, where every eval run asked this.
 */
export function primaryRevision(): Promise<string> {
  return (asked ??= describe());
}

async function describe(): Promise<string> {
  const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
  try {
    const rev = readFileSync(join(root, "REVISION"), "utf8").trim();
    if (/^[0-9a-f]{7,40}$/.test(rev)) return rev;
  } catch {
    /* not a deployed release */
  }
  // (No git, or one that took past DESCRIBE_MS: unknown.)
  const git = await outputOf(["git", "describe", "--always", "--dirty=+dirty", "--abbrev=12"], { cwd: root, timeoutMs: DESCRIBE_MS });
  const rev = git?.code === 0 ? git.stdout.trim() : "";
  return rev ? rev.slice(0, 64) : "unknown";
}
