import { VM_GATES } from "@invincible/core";

/*
 * The processes of another node's task (fabric/handoff.ts) in its agent's VM: none outlives what it was started for.
 *
 * Each command of such a task runs under this fixed helper, in a process group of its own and under its own deadline.
 * On Linux (the VMs) the helper is also the command's subreaper, so a process the command started that left its group
 * (setsid) and was orphaned is reparented to it rather than to init, and is still found.
 *
 * - A gate ("gate"): when its command ends, or its time does, every process it started is ended with it. On its copy
 *   (`on`, in its round's VM: sandbox gate.ts), it runs in that copy's tree, in a shell given an environment of its own
 *   alone (that copy's HOME and temporary folder, and a PATH of the VM's folders on a read-only filesystem) and of the
 *   login profiles only the image's own, /etc/profile, which puts the image's tools on that PATH: none from a HOME. What
 *   it left past this helper is ended by the sweep its round's VM gets before each copy.
 * - Any other command ("task"): what it leaves running (a server the next command uses) may go on while the task does.
 *   The helper writes each one's identity (pid, start time, boot) to the task's list, and when the task ends,
 *   `end_task` ends every process on that list that is still the same process, what each of them started since, and
 *   what has joined their process groups since. A process whose leader thread has exited while another runs is one.
 *
 * No shell command, process id or path in it comes from a model: the command is an argument, and the task's list is
 * named by its id, which `handedCommand` checks. It runs as `/usr/bin/python3 -I`, named by its path: no shell function,
 * PATH or module of the task's (a `json.py` where it starts, a `.pth` of its user's) stands in for it or runs in it.
 */
export const HANDED_PROCESS_PY = String.raw`import json, os, signal, sys, time
from pathlib import Path
PROC = Path("/proc")
D = Path("/work/.agent/handed")

def proc_ok():
    return (PROC / "sys/kernel/random/boot_id").exists()

def boot():
    return (PROC / "sys/kernel/random/boot_id").read_text().strip()

def running(pid):
    # Whether any thread of its runs: /proc says "Z" of a group whose leader thread alone has exited, its others running
    # on (the eleventh fabric review's R11-1), so its leader's state alone isn't whether it is alive.
    try:
        for thread in (PROC / str(pid) / "task").iterdir():
            if (thread / "stat").read_text().rsplit(")", 1)[1].split()[0] not in ("Z", "X"):
                return True
    except (FileNotFoundError, ProcessLookupError, PermissionError, NotADirectoryError, IndexError):
        pass
    return False

def identity(pid):
    try:
        fields = (PROC / str(pid) / "stat").read_text().rsplit(")", 1)[1].split()
    except (FileNotFoundError, ProcessLookupError, PermissionError, IndexError):
        return None
    if fields[0] in ("Z", "X") and not running(pid):
        return None
    return {"parent": int(fields[1]), "group": int(fields[2]), "start": fields[19]}

def table():
    found = {}
    for path in PROC.iterdir():
        if path.name.isdigit():
            seen = identity(int(path.name))
            if seen:
                found[int(path.name)] = seen
    return found

def descendants(procs, roots):
    kids = {}
    for pid, seen in procs.items():
        kids.setdefault(seen["parent"], []).append(pid)
    found, todo = set(), list(roots)
    while todo:
        for kid in kids.get(todo.pop(), []):
            if kid not in found:
                found.add(kid)
                todo.append(kid)
    return found

def kill(pids):
    for pid in pids:
        try:
            os.kill(pid, signal.SIGKILL)
        except (ProcessLookupError, PermissionError):
            pass

def reap():
    while True:
        try:
            pid, _ = os.waitpid(-1, os.WNOHANG)
        except ChildProcessError:
            return
        if pid == 0:
            return

def group_alive(group):
    try:
        os.killpg(group, 0)
        return True
    except (ProcessLookupError, PermissionError):
        return False

def end_command(group):
    # Its process group, and every process reparented to this one (where it is the subreaper), until none is left.
    for _ in range(100):
        try:
            os.killpg(group, signal.SIGKILL)
        except (ProcessLookupError, PermissionError):
            pass
        rest = descendants(table(), [os.getpid()]) if proc_ok() else set()
        kill(rest)
        reap()
        if not rest and not group_alive(group):
            return True
        time.sleep(0.02)
    return False

def keep(task, group):
    # What the command left running, by identity, for its task's end.
    if not proc_ok():
        return
    procs = table()
    left = {pid for pid, seen in procs.items() if seen["group"] == group} | descendants(procs, [os.getpid()])
    left.discard(os.getpid())
    if not left:
        return
    D.mkdir(mode=0o700, parents=True, exist_ok=True)
    b = boot()
    with open(D / (task + ".jsonl"), "a") as out:
        for pid in sorted(left):
            out.write(json.dumps({"pid": pid, "start": procs[pid]["start"], "group": procs[pid]["group"], "boot": b}) + "\n")

def held_path():
    # The VM's PATH, its folders on a read-only filesystem alone, in order: none the task's user can write (its HOME,
    # /work and /tmp are each a filesystem of their own), so nothing of the task's stands in for a tool a gate runs.
    # With none, a folder that isn't there: an empty PATH would be read as the gate's own folder, the task's tree.
    kept = []
    for d in os.environ.get("PATH", "").split(":"):
        if d.startswith("/") and d not in kept:
            try:
                if os.statvfs(d).f_flag & os.ST_RDONLY:
                    kept.append(d)
            except OSError:
                pass
    return ":".join(kept) or "/nonexistent"

# A gate's shell, before its command: the image's /etc/profile, then each folder of the PATH it was given (the VM's
# read-only ones) that the profile left off, after what the profile set. No word of the gate's is in it.
GATE_PATH = """__held=$PATH
[ -r /etc/profile ] && . /etc/profile >/dev/null 2>&1
set -f; __ifs=$IFS; IFS=:
for __d in $__held; do case ":$PATH:" in *":$__d:"*) ;; *) PATH="$PATH:$__d" ;; esac; done
IFS=$__ifs; set +f; unset __held __d __ifs; export PATH
"""

def run(mode, task, limit, command, on=""):
    if sys.platform.startswith("linux"):
        try:
            import ctypes
            ctypes.CDLL(None, use_errno=True).prctl(36, 1, 0, 0, 0)  # PR_SET_CHILD_SUBREAPER
        except Exception:
            pass
    # Its command makes its process group itself, before it runs, as CPython's subprocess does; its parent makes no call
    # of its own, which on macOS can meet the child's in the kernel and fail it (EPERM). The parent learns that it runs,
    # or why it couldn't start, through a pipe that closes as it runs (os.pipe's ends are close-on-exec).
    told, tell = os.pipe()
    child = os.fork()
    if child == 0:
        try:
            os.close(told)
            os.setpgid(0, 0)
            if on:
                # A gate on its copy (R8-3): in its tree, with nothing of the VM's environment but its read-only PATH, and of
                # its login profiles only the image's own (/etc/profile, on its read-only root), which puts its tools on it.
                # Where that profile sets PATH afresh and puts none back (Debian's does; the lab image adds none), each
                # read-only folder of the VM's own PATH it left off comes after what it set (GATE_PATH).
                os.chdir(os.path.join(on, "tree"))
                # And the node's install cache, where its round's VM has it (core's VM_BUN_CACHE, read-only, named in that VM's
                # own environment as the node made it): bun takes its packages from there.
                cache = {"BUN_INSTALL_CACHE_DIR": "/cache/bun"} if os.environ.get("BUN_INSTALL_CACHE_DIR") == "/cache/bun" else {}
                os.execve("/bin/bash", ["bash", "--noprofile", "--norc", "-c", GATE_PATH + command], {"PATH": held_path(), "HOME": os.path.join(on, "home"), "TMPDIR": os.path.join(on, "tmp"), "LANG": "C.UTF-8", **cache})
            os.execvp("bash", ["bash", "-c", command])
        except BaseException as e:
            try:
                os.write(tell, (getattr(e, "strerror", None) or str(e) or type(e).__name__).encode(errors="replace")[:300])
            except BaseException:
                pass
        finally:
            os._exit(127)
    os.close(tell)
    why = b""
    while True:
        chunk = os.read(told, 512)
        if not chunk:
            break
        why += chunk
    os.close(told)
    if why:
        os.waitpid(child, 0)
        sys.stderr.write("(Its command couldn't be started: %s.)\n" % why.decode(errors="replace"))
        return 127
    deadline = time.monotonic() + limit
    code = None
    while True:
        done, status = os.waitpid(child, os.WNOHANG)
        if done == child:
            code = os.WEXITSTATUS(status) if os.WIFEXITED(status) else 128 + os.WTERMSIG(status)
            break
        if time.monotonic() >= deadline:
            break
        time.sleep(0.05)
    ended = True
    if code is None or mode == "gate":
        # (What its command left past this helper, having ended it, is ended by the sweep of its round's VM before the next
        # gate's copy is made: every process of the gates' user, from an exec of its own. sandbox gate.ts.)
        ended = end_command(child)
        if not ended:
            sys.stderr.write("(Processes it started could not all be ended.)\n")
    else:
        keep(task, child)
    if code is None:
        sys.stderr.write("(Its time ran out after %g s: it was ended, and every process it started with it.)\n" % limit)
        return 137
    # (A gate whose processes outlive it doesn't pass: what it left could answer for a later one.)
    if mode == "gate" and not ended and code == 0:
        sys.stderr.write("(So it doesn't pass.)\n")
        return 1
    return code

def end_task(task):
    ledger = D / (task + ".jsonl")
    try:
        items = [json.loads(line) for line in ledger.read_text().splitlines() if line.strip()]
    except FileNotFoundError:
        return 0
    if not proc_ok():
        return 0
    b = boot()
    items = [item for item in items if item.get("boot") == b]
    groups = {item["group"] for item in items}
    since = min((int(item["start"]) for item in items), default=None)
    for _ in range(100):
        procs = table()
        known = {item["pid"] for item in items if procs.get(item["pid"], {}).get("start") == item["start"]}
        joined = {pid for pid, seen in procs.items() if seen["group"] in groups and since is not None and int(seen["start"]) >= since}
        doomed = (known | descendants(procs, known) | joined) - {os.getpid()}
        if not doomed:
            ledger.unlink()
            return 0
        kill(doomed)
        time.sleep(0.02)
    sys.stderr.write("Processes this task started are still running after it ended\n")
    return 1
`;

const quote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
const TASK_ID = /^[A-Za-z0-9_-]{1,80}$/;

/** The seconds a handed command's helper gets past its own deadline before the VM's own one (execArgs) ends it. */
export const HANDED_MARGIN_SECONDS = 10;

/** The helper's Python, named by its path and isolated (-I: no PYTHON* variable, user site or module where it starts). */
const PY = "/usr/bin/python3 -I";
/** A gate's copy of its task's tree (VM_GATES, handed-repo.ts handedCopy): a folder of its own there. */
const ON = new RegExp(`^${VM_GATES}/[0-9a-f]{32}$`);

/**
 * `command` as another node's task runs it: in a process group of its own, under its own deadline, its processes
 * ended with it (a gate) or kept on the task's list for its end (any other command). A gate `on` its copy runs in that
 * copy's tree with an environment of its own alone (R8-3).
 */
export function handedCommand(command: string, opts: { task: string; limitSec: number; ends: "gate" | "task"; on?: string }): string {
  if (!TASK_ID.test(opts.task)) throw new Error("not a task id");
  if (opts.on !== undefined && (opts.ends !== "gate" || !ON.test(opts.on))) throw new Error("not a gate's copy");
  const limit = Math.max(1, Math.floor(opts.limitSec));
  return `${PY} -c ${quote(`${HANDED_PROCESS_PY}\nsys.exit(run(*sys.argv[1:3], float(sys.argv[3]), *sys.argv[4:6]))`)} ${opts.ends} ${quote(opts.task)} ${limit} ${quote(command)}${opts.on ? ` ${opts.on}` : ""}`;
}

/** Ends what another node's task left running in its VM, once the task has ended (its list, by identity). */
export function handedEndCommand(task: string): string {
  if (!TASK_ID.test(task)) throw new Error("not a task id");
  return `${PY} -c ${quote(`${HANDED_PROCESS_PY}\nsys.exit(end_task(sys.argv[1]))`)} ${quote(task)}`;
}

/** The tasks whose lists a VM keeps (what they left running): their ids, one a line. */
export const HANDED_LISTS_COMMAND = "ls -1 /work/.agent/handed 2>/dev/null | sed -n 's/\\.jsonl$//p'";

/**
 * Ends, in one agent's VM, what tasks other nodes handed over left running there that nothing ended since: a node that
 * comes back after a crash, or after its own stop cut a task's end off, finds them (the third re-review's R3-5). Only
 * the lists of tasks that have ended (`ended`) are read; one of a task still open is left alone. Every name the VM
 * gives is checked as a task id first. `exec`: a command in that VM that a pause of its agent doesn't refuse.
 */
export async function endLeftovers(exec: (command: string, timeout: number) => Promise<{ exitCode: number; stdout: string }>, ended: (task: string) => boolean): Promise<{ ended: string[]; failed: string[] }> {
  const listed = await exec(HANDED_LISTS_COMMAND, 30);
  const tasks = listed.stdout.split("\n").map((line) => line.trim()).filter((id) => TASK_ID.test(id) && ended(id));
  const done: string[] = [];
  const failed: string[] = [];
  for (const task of tasks) ((await exec(handedEndCommand(task), 60)).exitCode === 0 ? done : failed).push(task);
  return { ended: done, failed };
}
