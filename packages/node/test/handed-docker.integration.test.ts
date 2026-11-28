import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkpointCommand, HANDED_CHANGES_BYTES, handedApply, handedGive, handedNonce, handedReceive, handedSend, handedTake, handedTree } from "@invincible/agents";
import type { SandboxView } from "@invincible/core";
import { KATA_RUNTIME, SandboxHost } from "@invincible/sandbox";

/*
 * Another node's task's clone of its own, and its changes back (R5-3), on real Docker: SandboxHost.pipe between two VMs
 * made from the sandbox image, an agent's and its task's, each with a /work of its own, in containers (runc) and, where
 * the Docker host runs Kata, in microVMs as an agent's and a task's VM are. What the agent's side gives is cloned in the
 * task's VM; what the task changes there comes back as one patch, kept on the agent's side and applied to its worktree
 * with the node's held git, and the step is kept; a pipe past its cap is cut, and a side past its deadline is ended. And
 * the image's git is one whose apply refuses a write through a link a patch renames (CVE-2023-23946's fix, 2.39.2).
 *
 * The VMs are named by this test (q5-handed-…), never as the host names its own (invincible-sbx-…): a stand-in for the
 * docker binary takes that prefix off the names the host gives, so nothing here can meet a node's VM. A Linux host with
 * Docker and invincible/sandbox:1, its socket reachable from here; skipped, and so unverified, anywhere else.
 */

const IMAGE = "invincible/sandbox:1";
const docker = (...args: string[]) => spawnSync("docker", args, { encoding: "utf8", timeout: 180_000 });
const available = process.platform === "linux" && docker("version", "--format", "{{.Server.Version}}").status === 0 && docker("image", "inspect", IMAGE).status === 0;
if (!available) console.log(`${import.meta.file} SKIPPED, unverified: it needs Linux, a Docker it can reach, and ${IMAGE}.`);
/** Whether the Docker host runs Kata microVMs: asked of it, as a one-off (this process may be in a container of its own). */
const kata = available && docker("run", "--rm", "--runtime", KATA_RUNTIME, "--network", "none", IMAGE, "true").status === 0;
if (available && !kata) console.log(`${import.meta.file}: its Kata half SKIPPED, unverified: the Docker host runs no Kata microVM.`);

const made: { containers: string[]; volumes: string[] } = { containers: [], volumes: [] };
const dir = mkdtempSync(join(tmpdir(), "q5-handed-"));
/** This test's VMs removed, and their volumes: by their own names, never by a pattern. */
function drop(): void {
  for (const name of made.containers.splice(0)) docker("rm", "-f", name);
  for (const name of made.volumes.splice(0)) docker("volume", "rm", "-f", name);
}
afterAll(() => {
  drop();
  rmSync(dir, { recursive: true, force: true });
});

/** The docker binary as the host runs it, with the host's prefix taken off each VM's name: this test's VMs are its own. */
const bin = join(dir, "docker");
writeFileSync(bin, `#!/bin/bash\nargs=()\nfor a in "$@"; do args+=("\${a#invincible-sbx-}"); done\nexec docker "\${args[@]}"\n`);
chmodSync(bin, 0o755);

/** A VM as the host makes an agent's or a task's: the VMs' user, nothing of the host, a /work of its own, running. */
function vm(runtime: "runc" | "kata"): string {
  const name = `q5-handed-${randomBytes(5).toString("hex")}`;
  made.containers.push(name);
  made.volumes.push(`${name}-work`);
  const ran = docker("run", "--detach", "--name", name, ...(runtime === "kata" ? ["--runtime", KATA_RUNTIME] : []), "--network", "none", "--user", "1000:1000", "--cap-drop", "ALL", "--security-opt", "no-new-privileges:true", "--read-only", "--tmpfs", "/tmp:rw,nosuid,nodev,size=64m", "--mount", `type=volume,src=${name}-work,dst=/work`, "--env", "HOME=/work", IMAGE, "sleep", "900");
  expect([ran.status, ran.stderr.trim()]).toEqual([0, ""]);
  return name;
}
/** A command in a VM, as the node's exec runs one (bash -lc in /work). */
const inside = (name: string, command: string, input?: string) => spawnSync("docker", ["exec", "--interactive", "--workdir", "/work", name, "bash", "-lc", command], { encoding: "utf8", timeout: 180_000, ...(input !== undefined ? { input } : {}) });

/** The host, as the node has it, its listing of VMs a stand-in that knows these two are running (what Docker says of them). */
function host(names: string[]): SandboxHost {
  const made = new SandboxHost({ node: "test", maxCpus: 8, maxMemoryGb: 16, docker: bin, runner: async () => ({ code: 1, stdout: "", stderr: "" }), ledger: () => {}, tokens: { mint: () => ({ token: "t", info: { hash: "h" } }), revoke: () => true } } as never);
  Object.assign(made, { get: async (id: string) => (names.includes(id) && docker("inspect", "--format", "{{.State.Running}}", id).stdout.trim() === "true" ? ({ id, status: "running" } as unknown as SandboxView) : null) });
  return made;
}
const side = (id: string, command: string) => ({ id, cmd: ["bash", "-lc", command] });
/** Whether no process whose command line matches `pattern` (bracketed, so it can't match its own search) runs in a VM, within 10 s. */
async function gone(name: string, pattern: string): Promise<boolean> {
  for (let i = 0; i < 100; i++) {
    if (inside(name, `pgrep -f '${pattern}' >/dev/null`).status === 1) return true;
    await Bun.sleep(100);
  }
  return false;
}

describe.skipIf(!available)("the sandbox image's git", () => {
  test("is 2.39.2 or later: its apply refuses a write through a link a patch renames (CVE-2023-23946)", () => {
    const said = docker("run", "--rm", "--network", "none", "--entrypoint", "git", IMAGE, "--version").stdout.trim();
    const [major = 0, minor = 0, patch = 0] = (/(\d+)\.(\d+)\.(\d+)/.exec(said) ?? []).slice(1).map(Number);
    console.log(`${IMAGE}: ${said}`);
    expect(major * 1e6 + minor * 1e3 + patch).toBeGreaterThanOrEqual(2_039_002);
  });
});

for (const runtime of ["runc", "kata"] as const) {
  describe.skipIf(!available || (runtime === "kata" && !kata))(`another node's task's clone and its changes, between two VMs ${runtime === "kata" ? "in Kata microVMs" : "in containers"}`, () => {
    test("its clone is made through the pipe, its changes come back as a patch, are applied, and its step is kept", async () => {
      try {
        const [agent, task] = [vm(runtime), vm(runtime)];
        const pipes = host([agent, task]);
        const id = "task-q5handed";
        const root = `/work/tasks/${id}`;
        // The agent's repository, and the task's worktree at its base, as REPO_TASK_START leaves them.
        const setUp = inside(agent, `set -e; export GIT_CONFIG_GLOBAL=/dev/null GIT_AUTHOR_NAME=t GIT_AUTHOR_EMAIL=t@t.invalid GIT_COMMITTER_NAME=t GIT_COMMITTER_EMAIL=t@t.invalid
          git init -q /work/repo; cd /work/repo; printf 'one\\n' > app.txt; printf 'the readme\\n' > README.md; git add -A; git commit -q -m first
          git worktree add -q --detach ${root} HEAD; git -C ${root} rev-parse HEAD`);
        expect(setUp.status).toBe(0);
        const base = setUp.stdout.trim().split("\n").at(-1)!;
        expect(base).toMatch(/^[0-9a-f]{40}$/);

        const given = await pipes.pipe(side(agent, handedGive(root, id)), side(task, handedTake(root, base, "Ada", "ada@agents.invalid")), { timeoutSec: 120, maxBytes: Number.POSITIVE_INFINITY });
        expect([given.cut, given.from.exitCode, given.to.exitCode, given.from.stderr.trim()]).toEqual([false, 0, 0, ""]);
        expect(given.to.stdout.trim()).toBe(base);
        expect(given.bytes).toBeGreaterThan(0);
        expect(inside(task, `git -C ${root} rev-parse HEAD && cat ${root}/app.txt`).stdout.trim().split("\n")).toEqual([base, "one"]);

        // The task's work in its clone: a change, a deletion, a new file in a new folder, a binary file, and a link.
        const work = inside(task, `set -e; cd ${root}; printf 'two\\n' > app.txt; rm README.md; mkdir -p src; printf 'export const x = 1;\\n' > src/new.ts; printf '\\000\\001\\377' > logo.bin; ln -s src/new.ts link.ts`);
        expect(work.status).toBe(0);
        const nonce = handedNonce();
        const back = await pipes.pipe(side(task, handedSend(root, base)), side(agent, handedReceive(id, nonce, HANDED_CHANGES_BYTES)), { timeoutSec: 120, maxBytes: HANDED_CHANGES_BYTES });
        expect([back.cut, back.from.exitCode, back.to.exitCode, back.from.stderr.trim()]).toEqual([false, 0, 0, ""]);
        // All of it kept, as many bytes as were carried: only then is it applied.
        expect(Number(back.to.stdout.trim())).toBe(back.bytes);
        const applied = inside(agent, handedApply(root, base, id, nonce, back.bytes, HANDED_CHANGES_BYTES));
        expect([applied.status, applied.stderr.trim()]).toEqual([0, ""]);
        // (It prints the tree it made the worktree, which the agent's side then reads there as it stands: the image's git.)
        const made = applied.stdout.trim().split(" ")[1];
        expect(made).toMatch(/^[0-9a-f]{40}$/);
        expect(inside(agent, handedTree(root, base, id)).stdout.trim()).toBe(made!);
        const seen = inside(agent, `cd ${root} && cat app.txt src/new.ts && od -An -tx1 logo.bin && readlink link.ts && test ! -e README.md && echo gone && git diff --cached --name-status ${base} | sort`);
        expect(seen.stdout.trim().split("\n").map((line) => line.trim())).toEqual(["two", "export const x = 1;", "00 01 ff", "src/new.ts", "gone", "A\tlink.ts", "A\tlogo.bin", "A\tsrc/new.ts", "D\tREADME.md", "M\tapp.txt"]);
        // Its step kept from the agent's worktree, as the node keeps one after a step of the task's.
        const kept = inside(agent, checkpointCommand(root, id, 1, ""));
        expect([kept.status, kept.stdout.trim()]).toMatchObject([0, expect.stringMatching(/^[0-9a-f]{40} [0-9a-f]{40} [0-9a-f]{40}$/)]);
      } finally {
        drop();
      }
    }, 300_000);

    test("a pipe past its cap is cut and its other side ended; a side past its deadline is ended", async () => {
      try {
        const [from, to] = [vm(runtime), vm(runtime)];
        const pipes = host([from, to]);
        const cut = await pipes.pipe(side(from, "head -c 50000000 /dev/zero"), side(to, "wc -c"), { timeoutSec: 120, maxBytes: 1_000_000 });
        expect(cut.cut).toBe(true);
        expect(cut.bytes).toBeGreaterThan(1_000_000);
        expect(cut.bytes).toBeLessThan(50_000_000);
        // (Ended in the VMs too, not only their docker clients: nothing of either side runs there after.)
        expect(await gone(from, "[h]ead -c 50000000")).toBe(true);
        expect(await gone(to, "[w]c -c")).toBe(true);
        const began = Date.now();
        const late = await pipes.pipe(side(from, "sleep 60; echo late"), side(to, "cat"), { timeoutSec: 3, maxBytes: 1_000_000 });
        expect([late.cut, late.from.exitCode, late.to.stdout]).toEqual([false, 137, ""]);
        expect(Date.now() - began).toBeLessThan(30_000);
        expect(await gone(from, "[s]leep 60")).toBe(true);
      } finally {
        drop();
      }
    }, 300_000);

    test("a pipe cut at its cap leaves no process of either side in either VM: what each started there is ended too, by the pipe's tag and the group its timeout leads (I-c)", async () => {
      try {
        const [from, to] = [vm(runtime), vm(runtime)];
        // (Its ends are asked of Docker as the node asks them, through the binary its sides run by: the host above answers
        // all but the sides with a stand-in, which would never reach these VMs.)
        const pipes = new SandboxHost({ node: "test", maxCpus: 8, maxMemoryGb: 16, docker: bin, ledger: () => {}, tokens: { mint: () => ({ token: "t", info: { hash: "h" } }), revoke: () => true } } as never);
        Object.assign(pipes, { get: async (id: string) => ([from, to].includes(id) ? ({ id, status: "running" } as unknown as SandboxView) : null) });
        // Neither side would end on its own within the test. Each starts a child without the pipe's tag, as the node's git
        // runs with an environment of its own, in the group its timeout leads; the sender floods past the cap, the receiver
        // reads its input to its end, and both then wait on their children.
        const cut = await pipes.pipe(side(from, "env -u INVINCIBLE_PIPE sleep 271 & head -c 50000000 /dev/zero; wait"), side(to, "env -u INVINCIBLE_PIPE sleep 272 & cat >/dev/null; wait"), { timeoutSec: 120, maxBytes: 1_000_000 });
        expect(cut.cut).toBe(true);
        // Once it has returned, nothing of either side runs in either VM: not the untagged children, not the sides' own
        // timeout, and nothing with a pipe's tag in its environment.
        for (const [name, pattern] of [[from, "[s]leep 271"], [from, "[h]ead -c 50000000"], [from, "[t]imeout --signal=KILL 120s"], [to, "[s]leep 272"], [to, "[t]imeout --signal=KILL 120s"]] as const) {
          expect([name, pattern, await gone(name, pattern)]).toEqual([name, pattern, true]);
        }
        for (const name of [from, to]) expect([name, inside(name, "grep -lsF INVINCIBLE_PIPE= /proc/[0-9]*/environ | wc -l").stdout.trim()]).toEqual([name, "0"]);
      } finally {
        drop();
      }
    }, 300_000);
  });
}
