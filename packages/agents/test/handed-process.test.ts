import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { endLeftovers, HANDED_LISTS_COMMAND, HANDED_PROCESS_PY, handedCommand, handedEndCommand } from "../src/handed-process.ts";

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

/**
 * A gate as handedCommand runs it, its helper's clock held (this test's, never the node's): no time passes until the gate's
 * command has written in `said` what it started, and then its time is out at once. On the real clock a gate of 1 s raced
 * its own shell: under load the shell hadn't started anything when its time ran out, and the test read a pid file that
 * wasn't there (the mini, 27 November 2026; made up below by pausing the shell).
 */
function heldUntil(said: string, gate: string): string {
  const run = "\nsys.exit(run(";
  const command = handedCommand(gate, { task: "task-test", limitSec: 1, ends: "gate" });
  if (command.split(run).length !== 2) throw new Error("handedCommand no longer ends with run(): hold its clock anew");
  const clock = `\n_real = time.monotonic\ndef _held():\n    try:\n        return _real() + 1e9 if os.path.getsize(${JSON.stringify(said)}) > 0 else 0.0\n    except OSError:\n        return 0.0\ntime.monotonic = _held`;
  return command.replace(run, `${clock}${run}`);
}

test("a gate whose time runs out is ended, exit 137, on its own clock: whatever it got to do", () => {
  const began = Date.now();
  const ran = shell(handedCommand("sleep 30", { task: "task-test", limitSec: 1, ends: "gate" }));
  expect(ran.status).toBe(137);
  expect(ran.stderr).toContain("time ran out after 1 s");
  expect(Date.now() - began).toBeLessThan(15_000);
});

test("a gate whose time runs out is ended with what it started, exit 137", async () => {
  const s = scratch();
  try {
    const began = Date.now();
    const ran = shell(heldUntil(s.path("bg"), `sleep 30 >/dev/null 2>&1 & echo $! > ${s.path("bg")}; sleep 30`));
    expect(ran.status).toBe(137);
    expect(ran.stderr).toContain("time ran out");
    expect(Date.now() - began).toBeLessThan(15_000);
    expect(await gone(pidIn(s.path("bg")))).toBe(true);
  } finally {
    s.done();
  }
});

/** A process's state, as ps says it ("T" stopped), or "" once it is gone. */
const state = (pid: number) => spawnSync("ps", ["-o", "state=", "-p", String(pid)], { encoding: "utf8" }).stdout.trim();
async function until(what: () => boolean, ms = 10_000): Promise<void> {
  const end = Date.now() + ms;
  while (!what()) {
    if (Date.now() > end) throw new Error("it never came");
    await Bun.sleep(10);
  }
}

test("a gate whose time runs out is ended with what it started, even when its shell was held up first, as load holds it", async () => {
  const s = scratch();
  try {
    // Load, made up: the gate's shell is paused (SIGSTOP) before it starts anything, for longer than the gate's time.
    const gate = `echo $$ > ${s.path("shell")}; kill -STOP $$; sleep 30 >/dev/null 2>&1 & echo $! > ${s.path("bg")}; sleep 30`;
    const run = Bun.spawn(["bash", "-c", heldUntil(s.path("bg"), gate)], { stdout: "pipe", stderr: "pipe" });
    await until(() => existsSync(s.path("shell")) && readFileSync(s.path("shell"), "utf8").endsWith("\n"));
    const shell_ = pidIn(s.path("shell"));
    await until(() => state(shell_).startsWith("T") || state(shell_) === "");
    await Bun.sleep(1_500);
    try {
      process.kill(shell_, "SIGCONT");
    } catch {}
    const [code, stderr] = await Promise.all([run.exited, new Response(run.stderr).text()]);
    expect(code).toBe(137);
    expect(stderr).toContain("time ran out");
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

/* A node coming back after a crash, or after its own stop cut a task's end off, ends what that task left running in its
 * agent's VM (the third re-review's R3-5): the lists of tasks that have ended, and no other. */
test("what tasks that have ended left running is ended as the node comes back; an open task's list, and a name that isn't a task's, are left alone", async () => {
  const ran: string[] = [];
  const exec = async (command: string) => {
    ran.push(command);
    if (command === HANDED_LISTS_COMMAND) return { exitCode: 0, stdout: "task-ended1\ntask-open\n../../etc/passwd\ntask-ended2\n" };
    // The second one's processes outlast its end.
    return { exitCode: command.includes("task-ended2") ? 1 : 0, stdout: "" };
  };
  const swept = await endLeftovers(exec, (task) => task !== "task-open");
  expect(swept).toEqual({ ended: ["task-ended1"], failed: ["task-ended2"] });
  expect(ran).toEqual([HANDED_LISTS_COMMAND, handedEndCommand("task-ended1"), handedEndCommand("task-ended2")]);
});
