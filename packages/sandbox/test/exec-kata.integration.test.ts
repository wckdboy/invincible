import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SandboxView } from "@invincible/core";
import { SandboxHost } from "../src/host.ts";
import { KATA_RUNTIME } from "../src/spec.ts";

/*
 * A command in a VM holds none of its VM's other commands (Q5's audit of Computer Use's speed, Ultra, 28 November 2026).
 * Given `-i` with nothing to read (the node gives `docker exec` /dev/null), Kata 4.3.1's shim closes the command's input
 * while holding the lock every exec of its VM takes, and waits there for the copy of that input, which ends only with the
 * command's output: so each command held every other of its VM until it ended. A second `true` 2 s into a 12 s command
 * took 10 s in Kata, 38 ms in runc; and a command that reads its input never saw it end in Kata, `cat` running to its
 * deadline. Here, through the host's own exec, on real Docker: in containers (runc), and in microVMs where the host runs
 * Kata, as an agent's VM is.
 *
 * The VMs are named by this test (c1-exec-…), never as the host names its own (invincible-sbx-…): a stand-in for the
 * docker binary takes that prefix off the names the host gives, so nothing here can meet a node's VM. A Linux host with
 * Docker and the sandbox image (INVINCIBLE_TEST_SANDBOX_IMAGE, else invincible/sandbox:1); skipped, and so unverified,
 * anywhere else.
 */

const IMAGE = process.env.INVINCIBLE_TEST_SANDBOX_IMAGE ?? "invincible/sandbox:1";
const docker = (...args: string[]) => spawnSync("docker", args, { encoding: "utf8", timeout: 180_000 });
const available = process.platform === "linux" && docker("version", "--format", "{{.Server.Version}}").status === 0 && docker("image", "inspect", IMAGE).status === 0;
if (!available) console.log(`${import.meta.file} SKIPPED, unverified: it needs Linux, a Docker it can reach, and ${IMAGE}.`);
/** Whether the Docker host runs Kata microVMs: asked of it, as a one-off. */
const kata = available && docker("run", "--rm", "--runtime", KATA_RUNTIME, "--network", "none", IMAGE, "true").status === 0;
if (available && !kata) console.log(`${import.meta.file}: its Kata half SKIPPED, unverified: the Docker host runs no Kata microVM.`);

const made: string[] = [];
const dir = mkdtempSync(join(tmpdir(), "c1-exec-"));
afterAll(() => {
  // This test's VMs removed, and their volumes: by their own names, never by a pattern.
  for (const name of made.splice(0)) {
    docker("rm", "-f", name);
    docker("volume", "rm", "-f", `${name}-work`);
  }
  rmSync(dir, { recursive: true, force: true });
});

/** The docker binary as the host runs it, with the host's prefix taken off each VM's name: this test's VMs are its own. */
const bin = join(dir, "docker");
writeFileSync(bin, `#!/bin/bash\nargs=()\nfor a in "$@"; do args+=("\${a#invincible-sbx-}"); done\nexec docker "\${args[@]}"\n`);
chmodSync(bin, 0o755);

/** A VM as the host makes an agent's: the VMs' user, nothing of the host, a /work of its own, running. */
function vm(runtime: "runc" | "kata"): string {
  const name = `c1-exec-${randomBytes(5).toString("hex")}`;
  made.push(name);
  const ran = docker("run", "--detach", "--name", name, ...(runtime === "kata" ? ["--runtime", KATA_RUNTIME] : []), "--network", "none", "--user", "1000:1000", "--cap-drop", "ALL", "--security-opt", "no-new-privileges:true", "--read-only", "--tmpfs", "/tmp:rw,nosuid,nodev,size=64m", "--mount", `type=volume,src=${name}-work,dst=/work`, "--env", "HOME=/work", IMAGE, "sleep", "900");
  expect([ran.status, ran.stderr.trim()]).toEqual([0, ""]);
  return name;
}

/** The host, as the node has it, its listing a stand-in that knows this VM is running (what Docker says of it). */
function host(name: string): SandboxHost {
  const made = new SandboxHost({ node: "test", maxCpus: 8, maxMemoryGb: 16, docker: bin, ledger: () => {}, tokens: { mint: () => ({ token: "t", info: { hash: "h" } }), revoke: () => true } } as never);
  const view = { id: name, name, status: "running", image: IMAGE, run: null } as unknown as SandboxView;
  Object.assign(made, { get: async (id: string) => (id === name && docker("inspect", "--format", "{{.State.Running}}", id).stdout.trim() === "true" ? view : null) });
  return made;
}

for (const runtime of ["runc", "kata"] as const) {
  describe.skipIf(!available || (runtime === "kata" && !kata))(`commands in one VM, ${runtime === "kata" ? "a Kata microVM" : "a container"}`, () => {
    test("a command beside a long one is answered at once, never when the long one ends", async () => {
      const name = vm(runtime);
      const h = host(name);
      const long = h.exec(name, ["sleep", "12"], 60);
      await Bun.sleep(2000);
      const t0 = performance.now();
      const quick = await h.exec(name, ["true"], 60);
      const ms = Math.round(performance.now() - t0);
      console.log(`${runtime}: a command 2 s into a 12 s one took ${ms} ms`);
      expect(quick.exitCode).toBe(0);
      // (Held by the long one, it took 10 s in Kata; on its own, 40 ms or so.)
      expect(ms).toBeLessThan(2000);
      expect((await long).exitCode).toBe(0);
    }, 120_000);

    test("a command that reads its input is given none: it ends at once, never at its deadline", async () => {
      const name = vm(runtime);
      const h = host(name);
      const t0 = performance.now();
      const read = await h.exec(name, ["cat"], 20);
      const ms = Math.round(performance.now() - t0);
      console.log(`${runtime}: cat took ${ms} ms`);
      expect([read.exitCode, read.stdout]).toEqual([0, ""]);
      expect(ms).toBeLessThan(5000);
    }, 120_000);
  });
}
