import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SandboxView } from "@invincible/core";
import { SandboxError, SandboxHost } from "../src/index.ts";

/*
 * A pipe between two of a host's sandboxes (SandboxHost.pipe; the fifth fabric review's R5-3): what one side prints is
 * the other's input, as it is printed, through the host alone and never kept there; past its cap both sides are ended
 * and it says it was cut. Docker is a stand-in that runs each side's command here, as `docker exec` runs it in its VM.
 */

const dir = mkdtempSync(join(tmpdir(), "pipe-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
/** `docker exec --interactive --workdir /work <container> timeout --signal=KILL <n>s bash -lc <command>`, run here. */
const docker = join(dir, "docker");
writeFileSync(
  docker,
  `#!/bin/bash
[ "$1" = exec ] || exit 99
shift; [ "$1" = --interactive ] && shift
[ "$1" = --workdir ] && shift 2
shift
[ "$1" = timeout ] && shift 3
[ "$1" = bash ] && [ "$2" = -lc ] && exec bash -c "$3"
exec "$@"
`,
);
chmodSync(docker, 0o755);

function host(status: Record<string, string> = { a: "running", b: "running" }, engine?: "container") {
  const made = new SandboxHost({ node: "test", maxCpus: 8, maxMemoryGb: 16, docker, runner: async () => ({ code: 1, stdout: "", stderr: "" }), ledger: () => {}, ...(engine ? { engine } : {}), tokens: { mint: () => ({ token: "t", info: { hash: "h" } }), revoke: () => true } } as never);
  // (Which VMs are here, and how they stand: what a listing of Docker's would say.)
  Object.assign(made, { get: async (id: string) => (status[id] ? ({ id, status: status[id] } as unknown as SandboxView) : null) });
  return made;
}
const side = (id: string, command: string) => ({ id, cmd: ["bash", "-lc", command] });

describe("a pipe between two of a host's sandboxes", () => {
  test("gives what one side prints to the other as its input, all of it; what the other prints comes back, the first's never", async () => {
    const piped = await host().pipe(side("a", "printf 'given:'; head -c 3000000 /dev/zero; echo said >&2"), side("b", "wc -c | tr -d ' '"), { timeoutSec: 30, maxBytes: 64 << 20 });
    expect(piped.bytes).toBe(3_000_006);
    expect(piped.cut).toBe(false);
    expect([piped.from.exitCode, piped.from.stdout, piped.from.stderr.trim()]).toEqual([0, "", "said"]);
    expect([piped.to.exitCode, piped.to.stdout.trim()]).toEqual([0, "3000006"]);
  });

  test("past its cap ends both sides and says it was cut, the cap's worth at most given on", async () => {
    const out = join(dir, "kept");
    const piped = await host().pipe(side("a", "head -c 200000000 /dev/zero"), side("b", `cat > ${out}`), { timeoutSec: 30, maxBytes: 100_000 });
    expect(piped.cut).toBe(true);
    expect(piped.bytes).toBeGreaterThan(100_000);
    expect(piped.bytes).toBeLessThan(200_000_000);
    expect(Bun.file(out).size).toBeLessThanOrEqual(100_000);
  });

  test("says how each side ended: one that fails, and the other given an input that ended there", async () => {
    const piped = await host().pipe(side("a", "printf part; echo 'could not read it' >&2; exit 3"), side("b", "cat; echo ' and its end'"), { timeoutSec: 30, maxBytes: 64 << 20 });
    expect([piped.from.exitCode, piped.from.stderr.trim()]).toEqual([3, "could not read it"]);
    expect([piped.to.exitCode, piped.to.stdout]).toEqual([0, "part and its end\n"]);
    expect([piped.bytes, piped.cut]).toEqual([4, false]);
  });

  test("is refused before anything runs: on a Mac, for a VM not on this node, or for one that isn't running", async () => {
    const refused = async (made: SandboxHost) => (await made.pipe(side("a", "exit 0"), side("b", "exit 0"), { timeoutSec: 30, maxBytes: 1 }).catch((error: SandboxError) => error)) as SandboxError;
    expect((await refused(host(undefined, "container"))).status).toBe(424);
    expect((await refused(host({ a: "running" }))).status).toBe(404);
    expect((await refused(host({ a: "running", b: "exited" }))).status).toBe(409);
  });
});
