import { describe, expect, test } from "bun:test";
import { type DockerRunner, SandboxHost } from "../src/index.ts";

/*
 * Kata's rootless runtime gives each microVM a user of its own and hands a UID out again as soon as it is free. A VM
 * started while a finished one's teardown is still removing that UID's runtime directory loses its files, and Docker
 * says "failed to create shim task: no such file or directory" (seen on ultra, 16 November 2026, under parallel trials).
 * That is the runtime's race, not the sandbox's fault: the start is tried once more, after a moment. Anything else that
 * stops a sandbox starting fails it, as ever.
 */

const KATA_LOST =
  "docker: Error response from daemon: failed to create task for container: NotFound: failed to create shim task: no such file or directory\n\nRun 'docker run --help' for more information";

function host(firstRun: { code: number; stderr: string }) {
  const calls: string[][] = [];
  let runs = 0;
  const runner: DockerRunner = async (args) => {
    calls.push(args);
    if (args[0] === "info") return { code: 0, stdout: "26.0.0", stderr: "" };
    if (args[0] === "run") {
      runs += 1;
      return runs === 1 ? { code: firstRun.code, stdout: "", stderr: firstRun.stderr } : { code: 0, stdout: "c0ffee", stderr: "" };
    }
    if (args[0] === "ps") return { code: 0, stdout: "", stderr: "" };
    return { code: 0, stdout: "", stderr: "" };
  };
  const paused: number[] = [];
  const sandboxes = new SandboxHost({
    node: "test",
    tokens: { mint: () => ({ token: "test-token", info: { hash: "test-hash" } }), revoke: () => true },
    ledger: () => {},
    maxCpus: 4,
    maxMemoryGb: 4,
    runner,
    pause: async (ms) => void paused.push(ms),
  });
  return { sandboxes, calls, paused, runs: () => runs };
}

describe("a microVM that lost its files as it started", () => {
  test("is started once more, after the failed one is removed and a moment has passed", async () => {
    const h = host({ code: 125, stderr: KATA_LOST });
    // (Started: it doesn't throw. The stand-in Docker keeps no containers to read back.)
    await h.sandboxes.create({ network: "isolated", cpus: 1, memoryGb: 1, ttlMinutes: 30, persistent: false, quest: "q-kata1", isolation: "container" });
    expect(h.runs()).toBe(2);
    const between = h.calls.slice(h.calls.findIndex((c) => c[0] === "run") + 1, h.calls.findLastIndex((c) => c[0] === "run"));
    expect(between.some((c) => c[0] === "rm" && c.includes("--force"))).toBe(true);
    expect(h.paused).toEqual([2_000]);
  });

  test("any other failure to start fails the sandbox, as it did, and isn't tried again", async () => {
    const h = host({ code: 125, stderr: "docker: Error response from daemon: pull access denied for galahad/sandbox" });
    await expect(h.sandboxes.create({ network: "isolated", cpus: 1, memoryGb: 1, ttlMinutes: 30, persistent: false, quest: "q-kata2", isolation: "container" })).rejects.toThrow(/could not start sandbox: docker: Error response from daemon: pull access denied/);
    expect(h.runs()).toBe(1);
    expect(h.paused).toEqual([]);
  });
});
