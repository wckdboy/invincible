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
    item = dict(seen, pid=pid, run=run)
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
        # The recorded leader is gone. Never signal an unidentified surviving group.
        if members(item["pid"]):
            raise RuntimeError("Worker leader is gone but its process group remains; stop the VM before resuming")
        clear(item)
        return
    owned = members(item["pid"])
    try:
        os.killpg(item["pid"], signal.SIGTERM)
    except ProcessLookupError:
        clear(item)
        return
    time.sleep(1)
    remaining = members(item["pid"])
    if remaining:
        # The shell may exit on TERM before an ignoring child does. At least one
        # original member must still identify this group before the final signal.
        if not any(owned.get(pid) == state for pid, state in remaining.items()):
            raise RuntimeError("Worker process group identity changed during cleanup")
        try:
            os.killpg(item["pid"], signal.SIGKILL)
        except ProcessLookupError:
            pass
        until = time.monotonic() + 2
        while members(item["pid"]):
            if time.monotonic() >= until:
                raise RuntimeError("Worker process group did not stop")
            time.sleep(0.02)
    clear(item)

def finish(run):
    item = marker()
    if item and item["run"] == run:
        seen = identity(item["pid"])
        if matches(item, seen) or (seen is None and members(item["pid"])):
            raise RuntimeError("Worker process group remains after completion")
        clear(item)
`;

const quote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

/** Fixed, trusted VM cleanup. No shell command or process id comes from a model. */
export function agentCleanupCommand(run?: string): string {
  return `python3 -c ${quote(`${AGENT_PROCESS_PY}\ncleanup(${run ? "sys.argv[1]" : ""})`)}${run ? ` ${quote(run)}` : ""}`;
}

export function agentProcessCommand(action: "record" | "wait_record" | "finish", run: string): string {
  return `python3 -c ${quote(`${AGENT_PROCESS_PY}\n${action}(sys.argv[1])`)} ${quote(run)}`;
}
