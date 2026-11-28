/* Linux process identity for a background worker in its own VM. A PID alone can
 * belong to a different process after a restart or a long idle period. */
export const AGENT_PROCESS_PY = String.raw`import json, os, signal, sys, time
from pathlib import Path
D = Path("/work/.agent")
PROC = Path("/proc")

def identity(pid):
    try:
        fields = (PROC / str(pid) / "stat").read_text().rsplit(")", 1)[1].split()
    except FileNotFoundError:
        return None
    if fields[0] == "Z":
        return None
    return {"start": fields[19], "group": int(fields[2]),
            "boot": (PROC / "sys/kernel/random/boot_id").read_text().strip()}

def marker():
    try:
        raw = (D / "process.json").read_text()
    except FileNotFoundError:
        return None
    if len(raw) > 4096:
        raise RuntimeError("Worker process marker is invalid")
    item = json.loads(raw)
    if (not isinstance(item, dict) or type(item.get("pid")) is not int or item["pid"] <= 1
            or item.get("group") != item["pid"] or not isinstance(item.get("run"), str)
            or not all(isinstance(item.get(k), str) and item[k] for k in ("start", "boot"))):
        raise RuntimeError("Worker process marker is invalid")
    return item

def matches(item, seen):
    return seen is not None and all(seen[k] == item[k] for k in ("start", "group", "boot"))

def namespace():
    # Which pid namespace this is: a VM's own, or another's that shares its /work (a seat's VM).
    try:
        return os.readlink(PROC / "self" / "ns" / "pid")
    except OSError:
        return ""

def ours(item):
    # Whether the marker's group, while any member of it lives, is still its run's: in the same boot and pid namespace a
    # group's number is never another's while it has members. One with no namespace said (an older marker) never is.
    ns = item.get("ns")
    try:
        same_boot = (PROC / "sys/kernel/random/boot_id").read_text().strip() == item["boot"]
    except OSError:
        same_boot = False
    return isinstance(ns, str) and bool(ns) and ns == namespace() and same_boot

def end(group, owned):
    # TERM, a second's grace, then KILL: only while one of its first members still says it is that group.
    try:
        os.killpg(group, signal.SIGTERM)
    except ProcessLookupError:
        return
    time.sleep(1)
    remaining = members(group)
    if remaining:
        # The shell may exit on TERM before an ignoring child does. At least one
        # original member must still identify this group before the final signal.
        if not any(owned.get(pid) == state for pid, state in remaining.items()):
            raise RuntimeError("Worker process group identity changed during cleanup")
        try:
            os.killpg(group, signal.SIGKILL)
        except ProcessLookupError:
            pass
        until = time.monotonic() + 2
        while members(group):
            if time.monotonic() >= until:
                raise RuntimeError("Worker process group did not stop")
            time.sleep(0.02)

def clear(item):
    current = marker()
    if current != item:
        return
    (D / "process.json").unlink(missing_ok=True)
    try:
        if (D / "pid").read_text().strip() == str(item["pid"]):
            (D / "pid").unlink(missing_ok=True)
    except FileNotFoundError:
        pass

def record(run):
    pid = os.getppid()
    seen = identity(pid)
    if seen is None or seen["group"] != pid:
        raise RuntimeError("Worker did not start in its own process group")
    item = dict(seen, pid=pid, run=run, ns=namespace())
    temp = D / ("process." + run + ".tmp")
    temp.write_text(json.dumps(item))
    os.replace(temp, D / "process.json")

def wait_record(run):
    until = time.monotonic() + 10
    while time.monotonic() < until:
        current = marker()
        if current and current["run"] == run:
            return
        if (D / "exit").exists():
            return
        time.sleep(0.01)
    raise RuntimeError("Worker did not record its process identity")

def members(group):
    found = {}
    for path in PROC.iterdir():
        if path.name.isdigit():
            seen = identity(int(path.name))
            if seen and seen["group"] == group:
                found[int(path.name)] = seen
    return found

def cleanup(run=None):
    item = marker()
    if item is None:
        # Legacy PID-only workers cannot be identified safely. A stopped VM may
        # discard this file; a live VM needs explicit recovery, not a guessed kill.
        if (D / "pid").exists():
            raise RuntimeError("Worker has a legacy PID marker; stop the VM before resuming")
        return
    if run is not None and item["run"] != run:
        return
    seen = identity(item["pid"])
    if seen is not None and not matches(item, seen):
        clear(item)
        return
    if seen is None:
        # The recorded leader is gone. What is left of its group (a server it started, say) is ended as its run's in its
        # own boot and namespace; another's (a marker from a VM sharing /work) names nothing here. An unidentified
        # surviving group is never signalled: with no namespace said, its marker refuses.
        left = members(item["pid"])
        if left and ours(item):
            end(item["pid"], left)
        elif left and not item.get("ns"):
            raise RuntimeError("Worker leader is gone but its process group remains; stop the VM before resuming")
        clear(item)
        return
    end(item["pid"], members(item["pid"]))
    clear(item)

def finish(run):
    item = marker()
    if item and item["run"] == run:
        seen = identity(item["pid"])
        if matches(item, seen):
            raise RuntimeError("Worker process group remains after completion")
        # What it left running once its leader ended (a server it started) is ended with it, as its own.
        left = members(item["pid"]) if seen is None else {}
        if left and ours(item):
            end(item["pid"], left)
        elif left and not item.get("ns"):
            raise RuntimeError("Worker process group remains after completion")
        clear(item)
`;

const quote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

/**
 * A seat's VM made ready for a run of a tool whose every run is a new one (Antigravity's): every process in it ended but
 * the VM's init (1), its container's own command (init's oldest child, `sleep infinity`), and this script with what
 * it runs under (the node's exec). A run's stop ends its own process group alone, so a process a run started in a session
 * of its own lived on into the task's later runs in the same VM, and could put a swapped sign-in back after a start
 * copied the seat's sealed one in (the fourth re-check of 28 November 2026, L1). Nothing hides from /proc in its VM's own
 * pid namespace (one made inside it is seen there too), and one forked while it looks is found at its next look. A
 * zombie is done (init reaps it). One that won't end refuses the start. It prints how many it ended.
 */
export const SEAT_VM_CLEAR_PY = String.raw`import os, signal, sys, time
from pathlib import Path

def facts(proc, pid):
    # Its state, its parent and its start (stat's fields 3, 4 and 22: its name may hold a parenthesis), or None: gone.
    try:
        fields = (proc / str(pid) / "stat").read_text().rsplit(")", 1)[1].split()
        return fields[0], int(fields[1]), int(fields[19])
    except (OSError, IndexError, ValueError):
        return None

def argv(proc, pid):
    try:
        return (proc / str(pid) / "cmdline").read_bytes().split(b"\0")[:-1]
    except OSError:
        return []

def kept(proc, me):
    lives = {}
    for path in proc.iterdir():
        if path.name.isdigit():
            seen = facts(proc, int(path.name))
            if seen:
                lives[int(path.name)] = seen
    keep = {1}
    # The container's own command: the oldest of init's children, as it was made (sleep infinity); none younger is it.
    children = sorted((start, pid) for pid, (_, parent, start) in lives.items() if parent == 1)
    if children and argv(proc, children[0][1]) == [b"sleep", b"infinity"]:
        keep.add(children[0][1])
    # This script, and what it runs under in this VM, up to the node's exec (whose parent is outside it).
    pid = me
    while pid > 1 and pid not in keep:
        keep.add(pid)
        pid = lives[pid][1] if pid in lives else 0
    return keep, lives

def clear(proc="/proc", passes=50):
    proc, me, ended = Path(proc), os.getpid(), set()
    for _ in range(passes):
        keep, lives = kept(proc, me)
        killed = []
        for pid, (state, _, _) in lives.items():
            if pid in keep or state in ("Z", "X"):
                continue
            try:
                os.kill(pid, signal.SIGKILL)
            except ProcessLookupError:
                continue
            except PermissionError:
                # (Not this VM's user's: none should be. Still there at the last look, it refuses the start.)
                pass
            killed.append(pid)
        if not killed:
            return len(ended)
        ended.update(killed)
        time.sleep(0.05)
    raise RuntimeError("the seat's VM still runs what an earlier run left")
`;

/** The seat's VM cleared before a run starts (SEAT_VM_CLEAR_PY): fixed and trusted, nothing in it from a model. */
export function seatVmClearCommand(): string {
  return `python3 -I -c ${quote(`${SEAT_VM_CLEAR_PY}\nprint(clear())`)}`;
}

/** Fixed, trusted VM cleanup. No shell command or process id comes from a model. */
export function agentCleanupCommand(run?: string): string {
  return `python3 -I -c ${quote(`${AGENT_PROCESS_PY}\ncleanup(${run ? "sys.argv[1]" : ""})`)}${run ? ` ${quote(run)}` : ""}`;
}

export function agentProcessCommand(action: "record" | "wait_record" | "finish", run: string): string {
  return `python3 -I -c ${quote(`${AGENT_PROCESS_PY}\n${action}(sys.argv[1])`)} ${quote(run)}`;
}
