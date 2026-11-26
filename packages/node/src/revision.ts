import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** This checkout's revision: the deploy's REVISION file, else git, else "unknown". */
export function galahadRevision(): string {
  const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
  try {
    const rev = readFileSync(join(root, "REVISION"), "utf8").trim();
    if (/^[0-9a-f]{7,40}$/.test(rev)) return rev;
  } catch {
    /* not a deployed release */
  }
  try {
    const git = Bun.spawnSync(["git", "describe", "--always", "--dirty=+dirty", "--abbrev=12"], { cwd: root, stderr: "ignore" });
    const rev = git.stdout.toString().trim();
    if (git.exitCode === 0 && rev) return rev.slice(0, 64);
  } catch {
    /* no git */
  }
  return "unknown";
}
