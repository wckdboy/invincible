import { expect, test } from "bun:test";
import { AGENT_PROCESS_PY, agentCleanupCommand } from "../src/agent-process.ts";

test("worker cleanup verifies process start and boot identity, keeps another run's marker, and kills an ignoring child", () => {
  // Exercise the actual Python helper against temporary procfs-shaped fixtures;
  // signals are intercepted, so no real process can be killed by this test.
  const scenario = String.raw`
import tempfile
with tempfile.TemporaryDirectory(prefix="galahad-process-") as root:
    D, PROC = Path(root) / "agent", Path(root) / "proc"
    D.mkdir(); PROC.mkdir()
    boot = PROC / "sys/kernel/random/boot_id"
    boot.parent.mkdir(parents=True); boot.write_text("boot-A")
    def process(pid, start, group=321):
        path = PROC / str(pid)
        path.mkdir(exist_ok=True)
        # Fields 3 through 22; the command itself can contain a parenthesis.
        fields = ["S", "1", str(group)] + ["0"] * 16 + [str(start)]
        (path / "stat").write_text(str(pid) + " (worker) name) " + " ".join(fields))
    def saved(run="run-A", start="100", boot_id="boot-A"):
        value = {"pid": 321, "group": 321, "start": start, "boot": boot_id, "run": run}
        (D / "process.json").write_text(json.dumps(value))
        (D / "pid").write_text("321")
        return value
    def gone(pid):
        (PROC / str(pid) / "stat").unlink(missing_ok=True)
    signals = []
    def kill(group, sig):
        signals.append((group, sig))
        if sig == signal.SIGTERM:
            gone(321)  # shell exits; child ignores TERM
        if sig == signal.SIGKILL:
            gone(322)
    os.killpg = kill
    time.sleep = lambda _: None
    process(321, 100); process(322, 101)
    item = saved()
    cleanup("other-run")
    assert signals == [] and marker() == item
    cleanup("run-A")
    assert signals == [(321, signal.SIGTERM), (321, signal.SIGKILL)]
    assert marker() is None and not (D / "pid").exists()
    # A reused PID, or a reboot with identical PID/start ticks, is never signalled.
    for changed in ("pid", "boot"):
        signals.clear(); saved()
        process(321, 999 if changed == "pid" else 100)
        boot.write_text("boot-B" if changed == "boot" else "boot-A")
        cleanup()
        assert signals == [] and marker() is None
    boot.write_text("boot-A")
    gone(321)
    item = saved("new-run")
    finish("old-run")
    assert marker() == item and (D / "pid").exists()
    finish("new-run")
    assert marker() is None and not (D / "pid").exists()
    saved("remaining-child")
    process(322, 102)
    try: finish("remaining-child")
    except RuntimeError as error: assert "remains" in str(error)
    else: raise AssertionError("completion cannot erase a surviving group's marker")
    gone(322); finish("remaining-child")
    # Old PID-only files are not sufficient authority to kill anything.
    (D / "pid").write_text("321")
    try: cleanup()
    except RuntimeError as error: assert "legacy" in str(error)
    else: raise AssertionError("legacy PID-only cleanup must refuse")
    assert signals == []
`;
  const result = Bun.spawnSync(["python3", "-B", "-c", `${AGENT_PROCESS_PY}\n${scenario}`]);
  expect({ exit: result.exitCode, stderr: result.stderr.toString() }).toEqual({ exit: 0, stderr: "" });
  expect(Bun.spawnSync(["bash", "-n", "-c", agentCleanupCommand()]).exitCode).toBe(0);
});

test("cleanup never sends KILL when the process group was replaced during TERM grace", () => {
  const scenario = String.raw`
import tempfile
with tempfile.TemporaryDirectory(prefix="galahad-process-reuse-") as root:
    D = Path(root)
    original = {"pid": 321, "group": 321, "start": "100", "boot": "A", "run": "r"}
    (D / "process.json").write_text(json.dumps(original))
    states = [{321: {"group": 321, "start": "100", "boot": "A"}}, {321: {"group": 321, "start": "200", "boot": "A"}}]
    identity = lambda _: states[0][321]
    members = lambda _: states.pop(0)
    signals = []
    os.killpg = lambda pid, sig: signals.append(sig)
    time.sleep = lambda _: None
    try: cleanup()
    except RuntimeError as error: assert "identity changed" in str(error)
    else: raise AssertionError("replacement group must be refused")
    assert signals == [signal.SIGTERM]
    assert marker() == original
`;
  const result = Bun.spawnSync(["python3", "-B", "-c", `${AGENT_PROCESS_PY}\n${scenario}`]);
  expect({ exit: result.exitCode, stderr: result.stderr.toString() }).toEqual({ exit: 0, stderr: "" });
});

test.skipIf(process.platform !== "linux")("a real Linux worker records its group before work and is stopped by the trusted helper", () => {
  const scenario = String.raw`
import shlex, subprocess, tempfile
with tempfile.TemporaryDirectory(prefix="galahad-real-worker-") as root:
    D = Path(root)
    recorder = SOURCE + "\nD = Path(" + repr(root) + ")\nrecord('real-run')"
    command = "python3 -c " + shlex.quote(recorder) + " && exec sleep 30"
    child = subprocess.Popen(["bash", "-c", command], start_new_session=True, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
    try:
        wait_record("real-run")
        current = marker()
        assert current["pid"] == child.pid and matches(current, identity(child.pid))
        cleanup("real-run")
        child.wait(timeout=3)
        assert child.returncode != 0 and marker() is None
    finally:
        if child.poll() is None:
            child.kill()
            child.wait(timeout=3)
`;
  const script = `SOURCE = ${JSON.stringify(AGENT_PROCESS_PY)}\nexec(SOURCE)\n${scenario}`;
  const result = Bun.spawnSync(["python3", "-B", "-c", script], { timeout: 15000 });
  expect({ exit: result.exitCode, stderr: result.stderr.toString() }).toEqual({ exit: 0, stderr: "" });
});
