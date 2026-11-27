import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HANDED_PROCESS_PY, handedCommand, handedEndCommand } from "../src/handed-process.ts";

/*
 * The processes of another node's task (the fabric's second re-review, N7): a gate's own run was bounded, but what it
 * started in the background, its output redirected, went on in the agent's VM after it, past the gates' bound and the
 * task. Now each of its commands runs under a fixed helper: a gate's processes end with it, and what another command
 * leaves running ends with the task. The real processes run here; the list's identity rules run against procfs-shaped
 * fixtures, as agent-process.test.ts does.
 */

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
async function gone(pid: number, ms = 5_000): Promise<boolean> {
  const until = Date.now() + ms;
  while (alive(pid) && Date.now() < until) await Bun.sleep(20);
  return !alive(pid);
}
function scratch() {
  const dir = mkdtempSync(join(tmpdir(), "handed-"));
  return { path: (name: string) => join(dir, name), done: () => rmSync(dir, { recursive: true, force: true }) };
}
const shell = (command: string) => spawnSync("bash", ["-c", command], { encoding: "utf8", timeout: 30_000 });
const pidIn = (path: string) => Number(readFileSync(path, "utf8").trim());

test("without it, what a gate starts in the background outlives the gate", () => {
  const s = scratch();
  try {
    expect(shell(`sleep 30 >/dev/null 2>&1 & echo $! > ${s.path("pid")}`).status).toBe(0);
    const pid = pidIn(s.path("pid"));
    expect(alive(pid)).toBe(true);
    process.kill(pid, "SIGKILL");
  } finally {
    s.done();
  }
});

test("a gate's processes end with it, and its exit code and output pass through", async () => {
  const s = scratch();
  try {
    const gate = `sleep 30 >/dev/null 2>&1 & echo $! > ${s.path("bg")}; nohup sleep 30 >/dev/null 2>&1 & echo $! > ${s.path("nohup")}; echo said; exit 3`;
    const ran = shell(handedCommand(gate, { task: "task-test", limitSec: 20, ends: "gate" }));
    expect(ran.status).toBe(3);
    expect(ran.stdout).toContain("said");
    expect(await gone(pidIn(s.path("bg")))).toBe(true);
    expect(await gone(pidIn(s.path("nohup")))).toBe(true);
  } finally {
    s.done();
  }
});

test("a gate whose time runs out is ended with what it started, exit 137", async () => {
  const s = scratch();
  try {
    const began = Date.now();
    const ran = shell(handedCommand(`sleep 30 >/dev/null 2>&1 & echo $! > ${s.path("bg")}; sleep 30`, { task: "task-test", limitSec: 1, ends: "gate" }));
    expect(ran.status).toBe(137);
    expect(ran.stderr).toContain("time ran out");
    expect(Date.now() - began).toBeLessThan(15_000);
    expect(await gone(pidIn(s.path("bg")))).toBe(true);
  } finally {
    s.done();
  }
});

test.skipIf(process.platform !== "linux")("on Linux a gate's process that left its group (setsid) is ended too: the helper is its subreaper", async () => {
  const s = scratch();
  try {
    const ran = shell(handedCommand(`setsid sleep 30 >/dev/null 2>&1 & echo $! > ${s.path("bg")}`, { task: "task-test", limitSec: 20, ends: "gate" }));
    expect(ran.status).toBe(0);
    expect(await gone(pidIn(s.path("bg")))).toBe(true);
  } finally {
    s.done();
  }
});

test("a command of the task keeps what it leaves running, by identity, and the task's end ends only that", () => {
  // Signals are intercepted, so no real process can be killed by this test.
  const scenario = String.raw`
import tempfile
with tempfile.TemporaryDirectory(prefix="handed-") as root:
    PROC = Path(root) / "proc"
    D = Path(root) / "handed"
    (PROC / "sys/kernel/random").mkdir(parents=True)
    (PROC / "sys/kernel/random/boot_id").write_text("boot-A")
    def process(pid, parent, group, start):
        path = PROC / str(pid)
        path.mkdir(exist_ok=True)
        # Fields 3 through 22; the command itself can contain a parenthesis.
        (path / "stat").write_text(str(pid) + " (sh) x) " + " ".join(["S", str(parent), str(group)] + ["0"] * 16 + [str(start)]))
    def gone(pid):
        (PROC / str(pid) / "stat").unlink(missing_ok=True)
    killed = []
    def fake_kill(pid, sig):
        assert sig == signal.SIGKILL
        killed.append(pid)
        gone(pid)
    os.kill = fake_kill
    time.sleep = lambda _: None
    me = os.getpid()
    process(me, 1, me, 50)
    # The command ran in group 400: its server (401) is left running, and 402 left the group with setsid and was
    # reparented here. 500 is another's, older, in the VM.
    process(401, 1, 400, 100)
    process(402, me, 402, 101)
    process(500, 1, 500, 10)
    keep("task-a", 400)
    kept = sorted(json.loads(line)["pid"] for line in (D / "task-a.jsonl").read_text().splitlines())
    assert kept == [401, 402], kept
    # Later: 401 started 403; 401 exited and its child 405, in its group, was reparented away; 402 is gone and its pid
    # is another process now (another start, its own group).
    process(403, 401, 400, 120)
    process(405, 1, 400, 125)
    gone(402)
    process(402, 1, 600, 999)
    assert end_task("task-a") == 0
    assert sorted(set(killed)) == [401, 403, 405], killed
    assert not (D / "task-a.jsonl").exists()
    # A list from another boot names nothing of this one.
    process(700, 1, 700, 200)
    (D / "task-b.jsonl").write_text(json.dumps({"pid": 700, "start": "200", "group": 700, "boot": "boot-B"}) + "\n")
    killed.clear()
    assert end_task("task-b") == 0
    assert killed == [], killed
    # No list: nothing to end.
    assert end_task("task-c") == 0
print("ok")
`;
  const ran = spawnSync("python3", ["-c", `${HANDED_PROCESS_PY}\n${scenario}`], { encoding: "utf8" });
  expect(ran.stderr).toBe("");
  expect(ran.stdout.trim()).toBe("ok");
});

test("its commands are fixed: the command and the task are arguments, and a task id is checked", () => {
  const made = handedCommand("echo 'quoted' $HOME", { task: "task-abc_1", limitSec: 42.9, ends: "task" });
  expect(made.startsWith("python3 -c '")).toBe(true);
  expect(made).toContain(" task 'task-abc_1' 42 'echo '\\''quoted'\\'' $HOME'");
  expect(handedEndCommand("task-abc_1").endsWith(" 'task-abc_1'")).toBe(true);
  for (const bad of ["../x", "a b", "", "x".repeat(81)]) {
    expect(() => handedCommand("true", { task: bad, limitSec: 1, ends: "gate" })).toThrow("not a task id");
    expect(() => handedEndCommand(bad)).toThrow("not a task id");
  }
});
