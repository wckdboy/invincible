import { VM_GATES, VM_GATES_USER } from "@invincible/core";

/*
 * A VM for a round of another node's task's gates (the eleventh fabric review's ruling, 28 November 2026): made from the
 * task's image for the round alone, with no network and no lease, and never a process of the task's in it. Its gates run
 * as their own user (core's VM_GATES_USER), one by one, each on a copy of its own of the task's tree, and between them
 * every process of that user is ended (GATE_SWEEP_PY), so nothing one gate's run of the task's code leaves behind reaches
 * the next one.
 */

/** What a gate VM's environment says it is: the sweep runs nowhere it isn't (a machine of yours, as you, among them). */
export const GATE_VM_ENV = "INVINCIBLE_GATE_VM";

/** The gates' user's uid, as a number. */
const GATES_UID = Number(VM_GATES_USER.split(":")[0]);

/**
 * Every process of the gates' own user in a gate VM ended, until none is left: `kill(-1, SIGKILL)` as that user, which the
 * kernel delivers to every process of theirs at once (a fork is refused once its parent has the signal, so a chain of
 * forks can't outrun it, as it outran a listing of pids: the eleventh review's R11-1), and to every thread of a group
 * whose leader has exited, which `/proc` shows as a zombie that is alive. Then `/proc` says whether any is left: a
 * process of that user one of whose threads isn't a zombie. It is run as the exec's only process (`--user`, no deadline
 * or shell of that user above it), since `kill(-1)` reaches every process of its user but its own. Once none is left,
 * whatever that user left in the VM's shared temporary folders (/tmp, /dev/shm) goes too: a gate's copy, HOME and
 * temporary folder are its own, and nothing else of a gate's is there for the next to read. Exit 0: none is left; else
 * why not. It refuses to run but as that user, where /proc is, in a gate VM's environment.
 */
export const GATE_SWEEP_PY = String.raw`import os, shutil, signal, sys, time
if os.getuid() != ${GATES_UID} or os.environ.get("${GATE_VM_ENV}") != "1" or not os.path.isdir("/proc/self"):
    sys.exit("this sweep runs only as the gates' own user, in a gate VM")
me = os.getpid()
def alive():
    left = []
    for name in os.listdir("/proc"):
        if not name.isdigit() or int(name) == me:
            continue
        try:
            with open("/proc/%s/status" % name) as f:
                uid = next((int(line.split()[1]) for line in f if line.startswith("Uid:")), None)
            if uid != ${GATES_UID}:
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
    for top in ("/tmp", "/dev/shm"):
        try:
            names = os.listdir(top)
        except OSError:
            continue
        for name in names:
            path = os.path.join(top, name)
            try:
                if os.lstat(path).st_uid != ${GATES_UID}:
                    continue
                if os.path.isdir(path) and not os.path.islink(path):
                    shutil.rmtree(path)
                else:
                    os.unlink(path)
            except OSError:
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
sys.exit("processes of the gates' user are still running: %d" % len(alive()))
`;

/** The sweep as Docker runs it: the gates' user, their folder, and the sweep the exec's only process. */
export const gateSweepArgs = (container: string): string[] => ["exec", "--user", VM_GATES_USER, "--workdir", VM_GATES, container, "/usr/bin/python3", "-I", "-c", GATE_SWEEP_PY];
