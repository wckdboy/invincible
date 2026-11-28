import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { GATE_LEFT_PY, GATE_SWEEP_PY, GATE_VM_ENV, gateLeftArgs, gateSweepArgs, KATA_RUNTIME } from "../src/index.ts";

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
    /** As gate user 61001, the one these tries leave processes as, and the sweep ends. */
    const as = (...a: string[]) => docker("exec", "--user", "61001:61001", "--workdir", "/gates", name, ...a);
    /** Whether a marker its writer touches every 10 ms is still being touched: alive if it is newer than 150 ms, 300 ms on. */
    const touched = (marker: string) =>
      as("/usr/bin/python3", "-I", "-c", `import os, time\ntime.sleep(0.3)\ntry:\n    print("alive" if time.time() - os.stat(${JSON.stringify(marker)}).st_mtime < 0.15 else "gone")\nexcept OSError:\n    print("gone")`).stdout.trim();
    /**
     * Every process of the gates' user in the VM that is alive, as the VM's own user sees them: pid, state, threads. A
     * zombie of one thread is dead, waiting for the VM's init to reap it; one with a thread running isn't.
     */
    const left = () =>
      docker("exec", name, "sh", "-c", `for p in /proc/[0-9]*; do u=$(awk '/^Uid:/{print $2}' $p/status 2>/dev/null); [ "$u" = 61001 ] || continue; s=$(cut -d' ' -f3 $p/stat 2>/dev/null); t=$(awk '/^Threads:/{print $2}' $p/status 2>/dev/null); [ "$s" = Z ] && [ "$t" = 1 ] && continue; printf '%s:%s:%s ' "\${p#/proc/}" "$s" "$t"; done; true`).stdout.trim();
    const sweep = () => {
      const began = performance.now();
      const ran = docker(...gateSweepArgs(name, 61001));
      return { code: ran.status, said: ran.stderr.trim(), ms: Math.round(performance.now() - began) };
    };

    test(`made as a gate VM is (${runtime})`, () => {
      name = `${PREFIX}${runtime}`;
      made.push(name);
      const ran = docker("run", "--detach", "--name", name, ...(runtime === "kata" ? ["--runtime", KATA_RUNTIME] : []), "--init", "--user", "1000:1000", "--cap-drop", "ALL", "--security-opt", "no-new-privileges:true", "--read-only", "--tmpfs", "/tmp:rw,nosuid,nodev,size=64m,mode=1777", "--tmpfs", "/gates:rw,exec,nosuid,nodev,size=64m,mode=1777", "--network", "none", "--pids-limit", "512", "--memory", "2g", "--env", `${GATE_VM_ENV}=1`, IMAGE, "sleep", "900");
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

    test(`a process of one gate's user can't trace, signal or write another's, where the VM's kernel lets it trace its own user's (${runtime})`, () => {
      // Gate user 61002's work: a process, and its folder (0700) in the sticky gates' folder.
      expect(docker("exec", "--user", "61002:61002", "--workdir", "/gates", name, "sh", "-c", "mkdir -m 0700 /gates/b && echo theirs > /gates/b/f").status).toBe(0);
      docker("exec", "-d", "--user", "61002:61002", name, "sleep", "300");
      docker("exec", "-d", "--user", "61001:61001", name, "sleep", "300");
      Bun.sleepSync(300);
      const pid = (uid: number) => docker("exec", name, "sh", "-c", `for p in /proc/[0-9]*; do [ "$(awk '/^Uid:/{print $2}' $p/status 2>/dev/null)" = ${uid} ] && grep -qx 'sleep' $p/comm && echo \${p#/proc/} && break; done`).stdout.trim();
      const theirs = pid(61002), mine = pid(61001);
      expect(theirs).toMatch(/^\d+$/);
      // What gate user 61001 tries: to trace each (PTRACE_SEIZE), to signal theirs, to read and write their files.
      const tried = as("/usr/bin/python3", "-I", "-c", `import ctypes, os, sys
libc = ctypes.CDLL(None, use_errno=True)
libc.ptrace.restype = ctypes.c_long
libc.ptrace.argtypes = [ctypes.c_long, ctypes.c_long, ctypes.c_void_p, ctypes.c_void_p]
def seize(pid):
    r = libc.ptrace(0x4206, pid, None, None)
    return "seized" if r == 0 else os.strerror(ctypes.get_errno())
def attempt(fn):
    try:
        fn()
        return "done"
    except OSError as e:
        return e.strerror
print("theirs:", seize(${theirs}))
print("mine:", seize(${mine || 0}))
print("signal:", attempt(lambda: os.kill(${theirs}, 0)))
print("read:", attempt(lambda: open("/gates/b/f").read()))
print("write:", attempt(lambda: open("/gates/b/g", "w").write("x")))
print("remove:", attempt(lambda: os.rename("/gates/b", "/gates/c")))`).stdout.trim();
      console.log(`${runtime}: gate user 61001 against 61002's work: ${tried.split("\n").join("; ")}`);
      const said = Object.fromEntries(tried.split("\n").map((line) => line.split(": ")) as [string, string][]);
      expect(said).toMatchObject({ theirs: "Operation not permitted", signal: "Operation not permitted", read: "Permission denied", write: "Permission denied", remove: "Operation not permitted" });
      // (Where the VM's kernel has no Yama, Kata's, a process traces another of its own user: a user of its own is what holds.)
      if (runtime === "kata") expect(said.mine).toBe("seized");
    });

    /*
     * The twelfth review's Info: after the sweep, a System V segment and a POSIX queue that one gate's user left were still
     * there. Now its sweep tidies what its user left in the VM's shared places, and nothing of another gate's user's.
     */
    test(`what a gate's user leaves in the VM's shared places goes with its sweep, and another's stays: /tmp, /dev/shm, /dev/mqueue, its folders, System V IPC (${runtime})`, () => {
      const leave = (uid: number) =>
        docker("exec", "--user", `${uid}:${uid}`, "--workdir", "/gates", name, "/usr/bin/python3", "-I", "-c", `import ctypes, os
libc = ctypes.CDLL(None, use_errno=True)
try:
    mq_open = libc.mq_open
except AttributeError:
    mq_open = ctypes.CDLL("librt.so.1", use_errno=True).mq_open
tag = "left-${uid}"
open("/tmp/" + tag, "w").write("x")
open("/dev/shm/" + tag, "w").write("x")
os.mkdir("/gates/" + tag, 0o700)
made = [libc.shmget(${uid}, 4096, 0o1000 | 0o600), libc.msgget(${uid}, 0o1000 | 0o600), libc.semget(${uid}, 1, 0o1000 | 0o600), mq_open(("/" + tag).encode(), os.O_CREAT | os.O_RDWR, 0o600, None)]
print(" ".join(str(m) for m in made))`);
      /** What of user `uid`'s is in the VM's shared places, as the VM's own user lists them. */
      const held = (uid: number) =>
        docker("exec", name, "/usr/bin/python3", "-I", "-c", `import os
uid, out = ${uid}, []
for kind in ("shm", "msg", "sem"):
    lines = open("/proc/sysvipc/" + kind).read().splitlines()
    head = lines[0].split()
    out += [kind for line in lines[1:] if int(line.split()[head.index("uid")]) == uid]
for top in ("/tmp", "/dev/shm", "/dev/mqueue", "/gates"):
    out += [top + "/" + n for n in sorted(os.listdir(top)) if os.lstat(os.path.join(top, n)).st_uid == uid]
print(" ".join(out))`).stdout.trim();
      for (const uid of [61001, 61002]) {
        const made = leave(uid);
        expect([made.status, made.stderr.trim()]).toEqual([0, ""]);
        expect(made.stdout.trim().split(" ").every((id) => Number(id) >= 0)).toBe(true);
      }
      const all = (uid: number) => `shm msg sem /tmp/left-${uid} /dev/shm/left-${uid} /dev/mqueue/left-${uid} /gates/left-${uid}`;
      expect(held(61001)).toBe(all(61001));
      const swept = sweep();
      expect([swept.code, swept.said]).toEqual([0, ""]);
      expect(held(61001)).toBe("");
      // (Gate user 61002's, its /gates/b of the test before among them, are its own sweep's.)
      expect(held(61002)).toBe(all(61002).replace(" /gates/left-61002", " /gates/b /gates/left-61002"));
      expect(docker(...gateSweepArgs(name, 61002)).status).toBe(0);
      expect(held(61002)).toBe("");
    });

    /*
     * The thirteenth review's Info: after each sweep the node counts, as the VM's own user, what of the gate's user is
     * still alive, and a round with any left ends there (team-runtime). The count is the VM's own user's: no process of a
     * gate's can trace it.
     */
    test(`what a gate's user left alive is counted as the VM's own user: what it leaves, and none once it is swept; never as a gate's user (${runtime})`, () => {
      docker("exec", "-d", "--user", "61001:61001", name, "sleep", "300");
      Bun.sleepSync(300);
      const count = () => docker(...gateLeftArgs(name, 61001));
      const before = count();
      expect([before.status, before.stderr.trim(), before.stdout.trim()]).toEqual([0, "", "1"]);
      expect(sweep().code).toBe(0);
      const after = count();
      expect([after.status, after.stdout.trim()]).toEqual([0, "0"]);
      const asGate = docker("exec", "--user", "61002:61002", "--workdir", "/gates", name, "/usr/bin/python3", "-I", "-c", GATE_LEFT_PY, "61001");
      expect([asGate.status, asGate.stderr.trim()]).toEqual([1, "this count runs only as a gate VM's own user, in a gate VM"]);
    });

    test(`it runs only as a gate's user, in a gate VM: as the VM's own user it does nothing (${runtime})`, () => {
      const ran = docker("exec", name, "/usr/bin/python3", "-I", "-c", GATE_SWEEP_PY);
      expect([ran.status, ran.stderr.trim()]).toEqual([1, "this sweep runs only as a gate's own user, in a gate VM"]);
      // (And the VM is still up: nothing of its own user's was signalled.)
      expect(docker("inspect", "--format", "{{.State.Running}}", name).stdout.trim()).toBe("true");
    });
  });
}
