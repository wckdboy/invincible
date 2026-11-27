import { describe, expect, test } from "bun:test";
import { join } from "node:path";

/*
 * What a VM's process writes, as the node reads it (the review's F3, 27 November 2026): never into memory without
 * bound. Each case is a stand-in for a VM's process that writes 100 MB on stdout and stderr (vm-output-case.ts), read
 * as the node reads it, in a process of its own so that its peak memory (maxRSS) is its own: kept within BOUND_MB,
 * whatever it was sent. A reader that keeps everything grows past 100 MB.
 */

/** How far a reader may grow on 100 MB: what it keeps (at most a picture's 16 MB line), and the garbage it has yet to collect. */
const BOUND_MB = 64;

async function run(name: string): Promise<Record<string, unknown> & { grewMB: number }> {
  const proc = Bun.spawn([process.execPath, join(import.meta.dir, "vm-output-case.ts"), name], { stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  if (code !== 0) throw new Error(`case ${name} exited ${code}: ${err.slice(-600)}`);
  return JSON.parse(out.trim().split("\n").at(-1)!);
}

describe("what a VM's process writes, read within bounds", () => {
  test("100 MB on each of its streams leaves the node's memory bounded, wherever the node reads it", async () => {
    const [collectErr, collectOut, session, probe, docker, stream] = await Promise.all(["collect-stderr", "collect-stdout", "session", "probe", "docker", "stream"].map(run));
    const grown = [collectErr, collectOut, session, probe, docker, stream].map((c) => [String(c!.case), c!.grewMB] as const);
    expect(grown.filter(([, mb]) => mb >= BOUND_MB)).toEqual([]);
    // And each still does its work: a collect keeps its folder, past its stderr's 100 MB; a tar past the limit is refused.
    expect(collectErr!.files).toEqual(["report.md"]);
    expect(collectOut!.said).toBe("more than 1 MB");
    // A desktop session that writes a line longer than any answer is ended, and says why; no line of it is taken.
    expect(session!.lines).toEqual([]);
    expect(session!.why).toMatch(/more than 16 MB/);
    expect(probe!.running).toBe(false);
    expect(docker!.available).toBe(true);
    expect(stream!.lines).toBe(0);
  }, 60_000);
});
