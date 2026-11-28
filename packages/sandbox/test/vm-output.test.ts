import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { type DockerRunner, SandboxHost } from "../src/index.ts";

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
    // (Its probe is given a long deadline, not the node's 8 s: this case is about reading 100 MB, see vm-output-case.ts.)
    expect(docker!.available).toBe(true);
    expect(stream!.lines).toBe(0);
  }, 60_000);
});

describe("the engine's answer to whether it is there", () => {
  test("is waited for 8 s, as the node waits for it, or as long as the host is given", async () => {
    const asked: (number | undefined)[] = [];
    const runner: DockerRunner = async (args, timeoutMs) => {
      if (args[0] === "info") asked.push(timeoutMs);
      return { code: 0, stdout: "29.0.0", stderr: "" };
    };
    const host = (more: object = {}) => new SandboxHost({ node: "test", maxCpus: 8, maxMemoryGb: 16, runner, tokens: { mint: () => ({ token: "t", info: { hash: "h" } }), revoke: () => true }, ledger: () => {}, ...more } as never);
    expect(await host().available()).toBe(true);
    expect(await host({ availableMs: 600_000 }).available()).toBe(true);
    expect(asked).toEqual([8000, 600_000]);
  });
});
