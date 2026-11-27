/*
 * The processes of another node's task (fabric/handoff.ts) in its agent's VM: none outlives what it was started for.
 *
 * Each command of such a task runs under this fixed helper, in a process group of its own and under its own deadline.
 * On Linux (the VMs) the helper is also the command's subreaper, so a process the command started that left its group
 * (setsid) and was orphaned is reparented to it rather than to init, and is still found.
 *
 * - A gate ("gate"): when its command ends, or its time does, every process it started is ended with it.
 * - Any other command ("task"): what it leaves running (a server the next command uses) may go on while the task does.
 *   The helper writes each one's identity (pid, start time, boot) to the task's list, and when the task ends,
 *   `end_task` ends every process on that list that is still the same process, what each of them started since, and
 *   what has joined their process groups since.
 *
 * No shell command, process id or path in it comes from a model: the command is an argument, and the task's list is
 * named by its id, which `handedCommand` checks.
 */
export const HANDED_PROCESS_PY = String.raw`import json, os, signal, sys, time
from pathlib import Path
PROC = Path("/proc")
D = Path("/work/.agent/handed")

def proc_ok():
    return (PROC / "sys/kernel/random/boot_id").exists()

def boot():
    return (PROC / "sys/kernel/random/boot_id").read_text().strip()

def identity(pid):
    try:
        fields = (PROC / str(pid) / "stat").read_text().rsplit(")", 1)[1].split()
    except (FileNotFoundError, ProcessLookupError, PermissionError, IndexError):
        return None
    if fields[0] in ("Z", "X"):
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

def run(mode, task, limit, command):
    if sys.platform.startswith("linux"):
        try:
            import ctypes
            ctypes.CDLL(None, use_errno=True).prctl(36, 1, 0, 0, 0)  # PR_SET_CHILD_SUBREAPER
        except Exception:
            pass
    child = os.fork()
    if child == 0:
        try:
            os.setpgid(0, 0)
            os.execvp("bash", ["bash", "-c", command])
        finally:
            os._exit(127)
    try:
        os.setpgid(child, child)
    except OSError:
        pass
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
    if code is None or mode == "gate":
        if not end_command(child):
            sys.stderr.write("(Processes it started could not all be ended.)\n")
    else:
        keep(task, child)
    if code is None:
        sys.stderr.write("(Its time ran out after %g s: it was ended, and every process it started with it.)\n" % limit)
        return 137
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

/**
 * `command` as another node's task runs it: in a process group of its own, under its own deadline, its processes
 * ended with it (a gate) or kept on the task's list for its end (any other command).
 */
export function handedCommand(command: string, opts: { task: string; limitSec: number; ends: "gate" | "task" }): string {
  if (!TASK_ID.test(opts.task)) throw new Error("not a task id");
  const limit = Math.max(1, Math.floor(opts.limitSec));
  return `python3 -c ${quote(`${HANDED_PROCESS_PY}\nsys.exit(run(sys.argv[1], sys.argv[2], float(sys.argv[3]), sys.argv[4]))`)} ${opts.ends} ${quote(opts.task)} ${limit} ${quote(command)}`;
}

/** Ends what another node's task left running in its VM, once the task has ended (its list, by identity). */
export function handedEndCommand(task: string): string {
  if (!TASK_ID.test(task)) throw new Error("not a task id");
  return `python3 -c ${quote(`${HANDED_PROCESS_PY}\nsys.exit(end_task(sys.argv[1]))`)} ${quote(task)}`;
}
