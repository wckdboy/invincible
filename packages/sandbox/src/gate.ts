import { isGateUid, VM_GATE_UID_FIRST, VM_GATE_UIDS, VM_GATES } from "@invincible/core";

/*
 * A VM for a round of another node's task's gates (the eleventh fabric review's ruling, 28 November 2026): made from the
 * task's image for the round alone, with no network and no lease, and never a process of the task's in it. Its gates
 * run one by one, each on a copy of its own of the task's tree, and each as a user of its own that no other gate of the
 * round has (core's VM_GATE_UID_FIRST…: the twelfth fabric re-review's R12-1). So what one gate's run of the task's code
 * leaves behind can't trace, signal or write anything of the next one's, whatever the VM's kernel allows one process of
 * a user against another of the same: Kata's guest kernel has no Yama, and a process left behind traced the sweep that
 * was to end it. After each gate, what its user left is ended and tidied (GATE_SWEEP_PY), so a round's VM doesn't fill.
 */

/** What a gate VM's environment says it is: the sweep runs nowhere it isn't (a machine of yours, as you, among them). */
export const GATE_VM_ENV = "INVINCIBLE_GATE_VM";

/**
 * What one gate's user left in its round's VM, ended and tidied, after its gate: every process of that user ended by
 * `kill(-1, SIGKILL)` as that user, which the kernel delivers to every process of theirs at once (a fork is refused
 * once its parent has the signal, so a chain of forks can't outrun it: the eleventh review's R11-1), and to every thread
 * of a group whose leader has exited, which `/proc` shows as a zombie that is alive; repeated until `/proc` shows none of
 * that user's with a thread alive. Then what that user left in the VM's shared places goes: its files in /tmp, /dev/shm
 * and /dev/mqueue (POSIX queues), its folders in the gates' folder, and its System V IPC objects.
 *
 * It is run as the exec's only process of that user (`--user`, no deadline or shell of theirs above it), since `kill(-1)`
 * reaches every process of its user but its own. A process of that user can trace it and stop it where the kernel
 * lets one process trace another of its user (Kata's, with no Yama): then what is left stays that user's alone, and no
 * later gate of the round is that user. Exit 0: none is left; else why not. It refuses to run but as a gate's user,
 * where /proc is, in a gate VM's environment.
 */
export const GATE_SWEEP_PY = String.raw`import ctypes, os, shutil, signal, sys, time
uid = os.getuid()
if not (${VM_GATE_UID_FIRST} <= uid < ${VM_GATE_UID_FIRST + VM_GATE_UIDS}) or os.environ.get("${GATE_VM_ENV}") != "1" or not os.path.isdir("/proc/self"):
    sys.exit("this sweep runs only as a gate's own user, in a gate VM")
me = os.getpid()
def alive():
    left = []
    for name in os.listdir("/proc"):
        if not name.isdigit() or int(name) == me:
            continue
        try:
            with open("/proc/%s/status" % name) as f:
                owner = next((int(line.split()[1]) for line in f if line.startswith("Uid:")), None)
            if owner != uid:
                continue
            for thread in os.listdir("/proc/%s/task" % name):
                with open("/proc/%s/task/%s/stat" % (name, thread)) as f:
                    if f.read().rsplit(")", 1)[1].split()[0] not in ("Z", "X"):
                        left.append(int(name))
                        break
        except (OSError, StopIteration, ValueError, IndexError):
            pass
    return left
def tidy():
    for top in ("/tmp", "/dev/shm", "/dev/mqueue", "${VM_GATES}"):
        try:
            names = os.listdir(top)
        except OSError:
            continue
        for name in names:
            path = os.path.join(top, name)
            try:
                if os.lstat(path).st_uid != uid:
                    continue
                if os.path.isdir(path) and not os.path.islink(path):
                    def again(fn, p, _):
                        try:
                            os.chmod(os.path.dirname(p), 0o700)
                            fn(p)
                        except OSError:
                            pass
                    shutil.rmtree(path, onerror=again)
                else:
                    os.unlink(path)
            except OSError:
                pass
    # Its System V IPC objects, by the kernel's own list of them: each removed (IPC_RMID) by its owner.
    libc = ctypes.CDLL(None, use_errno=True)
    for kind, key in (("shm", "shmid"), ("msg", "msqid"), ("sem", "semid")):
        try:
            with open("/proc/sysvipc/" + kind) as f:
                lines = f.read().splitlines()
        except OSError:
            continue
        if not lines:
            continue
        head = lines[0].split()
        for line in lines[1:]:
            fields = line.split()
            try:
                if int(fields[head.index("uid")]) != uid:
                    continue
                ident = int(fields[head.index(key)])
                if kind == "sem":
                    libc.semctl(ident, 0, 0)
                elif kind == "shm":
                    libc.shmctl(ident, 0, None)
                else:
                    libc.msgctl(ident, 0, None)
            except (ValueError, IndexError):
                pass
for _ in range(500):
    try:
        os.kill(-1, signal.SIGKILL)
    except ProcessLookupError:
        pass
    if not alive():
        tidy()
        sys.exit(0)
    time.sleep(0.01)
sys.exit("processes of this gate's user are still running: %d" % len(alive()))
`;

/** The sweep as Docker runs it for gate user `uid`: that user, the gates' folder, and the sweep the exec's only process. */
export const gateSweepArgs = (container: string, uid: number): string[] => {
  if (!isGateUid(uid)) throw new Error("not a gate's user");
  return ["exec", "--user", `${uid}:${uid}`, "--workdir", VM_GATES, container, "/usr/bin/python3", "-I", "-c", GATE_SWEEP_PY];
};

/**
 * What of gate user `sys.argv[1]` is still alive in a round's VM once its sweep has run: a process of that user with a
 * thread alive, by `/proc`, counted as the VM's own user, never a gate's, so no process of a gate's user can trace or
 * stop it (the thirteenth fabric re-review's Info). In Kata a process that traces its user's sweep outlives it; a round
 * with any left ends there (team-runtime.ts). One it can't read is counted as left. It prints the count. It refuses to
 * run as a gate's user, or but where /proc is, in a gate VM's environment.
 */
export const GATE_LEFT_PY = String.raw`import os, sys
if ${VM_GATE_UID_FIRST} <= os.getuid() < ${VM_GATE_UID_FIRST + VM_GATE_UIDS} or os.environ.get("${GATE_VM_ENV}") != "1" or not os.path.isdir("/proc/self") or len(sys.argv) != 2 or not sys.argv[1].isdigit():
    sys.exit("this count runs only as a gate VM's own user, in a gate VM")
uid, me, left = int(sys.argv[1]), os.getpid(), 0
for name in os.listdir("/proc"):
    if not name.isdigit() or int(name) == me:
        continue
    try:
        with open("/proc/%s/status" % name) as f:
            owner = next((int(line.split()[1]) for line in f if line.startswith("Uid:")), None)
        if owner != uid:
            continue
        for thread in os.listdir("/proc/%s/task" % name):
            with open("/proc/%s/task/%s/stat" % (name, thread)) as f:
                if f.read().rsplit(")", 1)[1].split()[0] not in ("Z", "X"):
                    left += 1
                    break
    except (FileNotFoundError, ProcessLookupError):
        pass
    except (OSError, StopIteration, ValueError, IndexError):
        left += 1
print(left)
`;

/** The count as Docker runs it for gate user `uid`: as the VM's own user (1000), never a gate's. */
export const gateLeftArgs = (container: string, uid: number): string[] => {
  if (!isGateUid(uid)) throw new Error("not a gate's user");
  return ["exec", "--user", "1000:1000", "--workdir", "/", container, "/usr/bin/python3", "-I", "-c", GATE_LEFT_PY, String(uid)];
};

/**
 * The round's VM's users, as its /etc/passwd and /etc/group say them (mounted read-only over the image's): the image's
 * own, then each gate's user, gate1… (core's VM_GATE_UID_FIRST…), so a tool that asks who it runs as (Node's
 * os.userInfo, Python's getpass, `whoami`) has an answer, as it has for nobody. An image that already has a user or a
 * group of those ids or names is refused: the round couldn't tell its gates apart from it.
 */
export function gateUsers(passwd: string, group: string): { passwd: string; group: string } | { why: string } {
  const gates = Array.from({ length: VM_GATE_UIDS }, (_, i) => ({ name: `gate${i + 1}`, id: VM_GATE_UID_FIRST + i }));
  const names = new Set(gates.map((g) => g.name));
  for (const [file, text] of [
    ["passwd", passwd],
    ["group", group],
  ] as const) {
    for (const line of text.split("\n")) {
      if (!line.trim() || line.startsWith("#")) continue;
      const [name, , id] = line.split(":");
      if (names.has(name ?? "") || isGateUid(Number(id))) return { why: `its image's ${file} already names ${name} (${id}), a gate's user` };
    }
  }
  const end = (text: string) => (text.endsWith("\n") || !text ? text : `${text}\n`);
  return {
    passwd: end(passwd) + gates.map((g) => `${g.name}:x:${g.id}:${g.id}:a gate's user:/nonexistent:/usr/sbin/nologin\n`).join(""),
    group: end(group) + gates.map((g) => `${g.name}:x:${g.id}:\n`).join(""),
  };
}
