import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { GATE_SWEEP_PY, GATE_VM_ENV, gateSweepArgs, KATA_RUNTIME } from "../src/index.ts";

/*
 * The sweep between another node's task's gates, on real containers and Kata microVMs (gate.ts GATE_SWEEP_PY; the
 * eleventh fabric review's R11-1). Two ways a process of the gates' user outlived the sweep it replaces, each tried 20
 * times in each runtime, and each must lose every time:
 * - a thread group whose leader thread has exited (`SYS_exit`, its thread alone) while another thread runs on, which
 *   /proc shows as a zombie: the old sweep skipped every zombie;
 * - a chain of processes, each forking its next and exiting: the old sweep listed pids and then killed them, and the chain
 *   outran it in 3 of 10 sweeps in runc and 9 of 10 in Kata.
 * Each VM is made with a gate VM's flags (--init, uid 1000, no capability, no-new-privileges, a read-only root, the gates'
 * tmpfs, no network), named this run's own (`gate-sweep-<hex>-`), never as the node names its own, and removed by its
 * own name. A Linux host with Docker and the sandbox image; Kata for its second half. Skipped, and so unverified,
 * anywhere else.
 */

setDefaultTimeout(600_000);

const IMAGE = process.env.INVINCIBLE_TEST_SANDBOX_IMAGE ?? "invincible/sandbox:1";
const docker = (...args: string[]) => spawnSync("docker", args, { encoding: "utf8", timeout: 180_000 });
const available = process.platform === "linux" && docker("version", "--format", "{{.Server.Version}}").status === 0 && docker("image", "inspect", IMAGE).status === 0;
if (!available) console.log(`${import.meta.file} SKIPPED, unverified: it needs Linux, a Docker it can reach, and ${IMAGE}.`);
const kata = available && docker("run", "--rm", "--runtime", KATA_RUNTIME, "--network", "none", IMAGE, "true").status === 0;
if (available && !kata) console.log(`${import.meta.file}: its Kata half SKIPPED, unverified: the Docker host runs no Kata microVM.`);

const PREFIX = `gate-sweep-${randomBytes(3).toString("hex")}-`;
const made: string[] = [];
afterAll(() => {
  for (const name of made.splice(0)) docker("rm", "-f", name);
});

/** Each of the 20 tries: whether anything of the gates' user lived on, and how long the sweep took. */
const ROUNDS = 20;
/** `SYS_exit`, a thread's own exit, on this machine's architecture. */
const SYS_EXIT = process.arch === "arm64" ? 93 : 60;

for (const runtime of ["runc", "kata"] as const) {
  describe.skipIf(!available || (runtime === "kata" && !kata))(`the sweep between gates: ${runtime === "kata" ? "Kata microVMs" : "containers (runc)"}`, () => {
    let name = "";
    const as = (...a: string[]) => docker("exec", "--user", "65534:65534", "--workdir", "/gates", name, ...a);
    /** Whether a marker its writer touches every 10 ms is still being touched: alive if it is newer than 150 ms, 300 ms on. */
    const touched = (marker: string) =>
      as("/usr/bin/python3", "-I", "-c", `import os, time\ntime.sleep(0.3)\ntry:\n    print("alive" if time.time() - os.stat(${JSON.stringify(marker)}).st_mtime < 0.15 else "gone")\nexcept OSError:\n    print("gone")`).stdout.trim();
    /**
     * Every process of the gates' user in the VM that is alive, as the VM's own user sees them: pid, state, threads. A
     * zombie of one thread is dead, waiting for the VM's init to reap it; one with a thread running isn't.
     */
    const left = () =>
      docker("exec", name, "sh", "-c", `for p in /proc/[0-9]*; do u=$(awk '/^Uid:/{print $2}' $p/status 2>/dev/null); [ "$u" = 65534 ] || continue; s=$(cut -d' ' -f3 $p/stat 2>/dev/null); t=$(awk '/^Threads:/{print $2}' $p/status 2>/dev/null); [ "$s" = Z ] && [ "$t" = 1 ] && continue; printf '%s:%s:%s ' "\${p#/proc/}" "$s" "$t"; done; true`).stdout.trim();
    const sweep = () => {
      const began = performance.now();
      const ran = docker(...gateSweepArgs(name));
      return { code: ran.status, said: ran.stderr.trim(), ms: Math.round(performance.now() - began) };
    };

    test(`made as a gate VM is (${runtime})`, () => {
      name = `${PREFIX}${runtime}`;
      made.push(name);
      const ran = docker("run", "--detach", "--name", name, ...(runtime === "kata" ? ["--runtime", KATA_RUNTIME] : []), "--init", "--user", "1000:1000", "--cap-drop", "ALL", "--security-opt", "no-new-privileges:true", "--read-only", "--tmpfs", "/tmp:rw,nosuid,nodev,size=64m,mode=1777", "--tmpfs", "/gates:rw,exec,nosuid,nodev,size=64m,uid=65534,gid=65534,mode=0700", "--network", "none", "--pids-limit", "512", "--memory", "2g", "--env", `${GATE_VM_ENV}=1`, IMAGE, "sleep", "900");
      expect([ran.status, ran.stderr.trim()]).toEqual([0, ""]);
      // (With nothing of the gates' user in it, the sweep finds none at once.)
      expect(sweep().code).toBe(0);
    });

    test(`a group whose leader has exited, its other thread running on, never outlives it: ${ROUNDS} of ${ROUNDS} (${runtime})`, () => {
      const lived: string[] = [];
      const took: number[] = [];
      for (let i = 0; i < ROUNDS; i++) {
        as("sh", "-c", `setsid /usr/bin/python3 -c 'import ctypes, threading, time
def work():
    while True:
        open("/gates/zombie", "w").close()
        time.sleep(0.01)
threading.Thread(target=work).start()
time.sleep(0.2)
ctypes.CDLL(None).syscall(${SYS_EXIT}, 0)' </dev/null >/dev/null 2>&1 &`);
        Bun.sleepSync(400);
        // (It is there, a zombie whose other thread runs: what the old sweep never signalled.)
        if (i === 0) expect(left()).toMatch(/:Z:2/);
        const swept = sweep();
        took.push(swept.ms);
        expect([swept.code, swept.said]).toEqual([0, ""]);
        const after = touched("/gates/zombie");
        const still = left();
        if (after !== "gone" || still !== "") lived.push(`try ${i + 1}: ${after}, ${still}`);
      }
      console.log(`${runtime}: a leader-exited group, ${ROUNDS} tries: ${lived.length} lived on; the sweep took ${Math.min(...took)} to ${Math.max(...took)} ms`);
      expect(lived).toEqual([]);
    });

    test(`a chain of processes, each forking its next and exiting, never outruns it: ${ROUNDS} of ${ROUNDS} (${runtime})`, () => {
      const lived: string[] = [];
      const took: number[] = [];
      for (let i = 0; i < ROUNDS; i++) {
        as("sh", "-c", `setsid /usr/bin/python3 -c 'import os
while True:
    open("/gates/chain", "w").close()
    if os.fork():
        os._exit(0)' </dev/null >/dev/null 2>&1 &`);
        Bun.sleepSync(400);
        const swept = sweep();
        took.push(swept.ms);
        expect([swept.code, swept.said]).toEqual([0, ""]);
        const after = touched("/gates/chain");
        const still = left();
        if (after !== "gone" || still !== "") lived.push(`try ${i + 1}: ${after}, ${still}`);
      }
      console.log(`${runtime}: a fork chain, ${ROUNDS} tries: ${lived.length} lived on; the sweep took ${Math.min(...took)} to ${Math.max(...took)} ms`);
      expect(lived).toEqual([]);
    });

    test(`it runs only as the gates' user, in a gate VM: as the VM's own user it does nothing (${runtime})`, () => {
      const ran = docker("exec", name, "/usr/bin/python3", "-I", "-c", GATE_SWEEP_PY);
      expect([ran.status, ran.stderr.trim()]).toEqual([1, "this sweep runs only as the gates' own user, in a gate VM"]);
      // (And the VM is still up: nothing of its own user's was signalled.)
      expect(docker("inspect", "--format", "{{.State.Running}}", name).stdout.trim()).toBe("true");
    });
  });
}
