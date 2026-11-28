import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

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
  try {
    const git = Bun.spawn(["git", "describe", "--always", "--dirty=+dirty", "--abbrev=12"], { cwd: root, stdin: "ignore", stdout: "pipe", stderr: "ignore" });
    const late = setTimeout(() => git.kill(), DESCRIBE_MS);
    late.unref?.();
    try {
      const [out, code] = await Promise.all([new Response(git.stdout).text(), git.exited]);
      const rev = out.trim();
      if (code === 0 && rev) return rev.slice(0, 64);
    } finally {
      clearTimeout(late);
    }
  } catch {
    /* no git */
  }
  return "unknown";
}
