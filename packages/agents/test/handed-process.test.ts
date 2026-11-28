import { expect, setDefaultTimeout, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { endLeftovers, HANDED_LISTS_COMMAND, HANDED_PROCESS_PY, handedCommand, handedEndCommand } from "../src/handed-process.ts";

// Every test here runs the real helper, a shell and its processes, so its time is the machine's to give: "the 127" took
// 0.34 s on the Mac mini at a load of 50 on 18 cores, failed in a full run at a load of 77 (27 November 2026), and ran
// past bun's 5 s with its runner given 2 % of a core. Its work is in processes that make their own groups, so a load
// of about 585 on 12 cores (2 % of a core each) can make all of it fifty times as long: 17 s. The limit is how long a
// busy machine may take, never what a test checks; the clocks a test checks (a gate ended within 15 s) are its own.
setDefaultTimeout(60_000);

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

/**
 * A gate as handedCommand runs it, its kernel's race made certain (this test's, never the node's): the child's own
 * setpgid fails, EPERM, once its parent has set the child's group too. On macOS the two calls can meet in the kernel and
 * fail the child's: 4 of 3,000 forks at a load of 82 on 12 cores, and none of 3,000 with the child's call alone. The
 * helper's child then exited 127 without a word, in the time of one poll (I15's full check, 27 November 2026: a gate
 * whose time runs out, 127 in 88 ms).
 */
function raced(said: string, gate: string): string {
  const run = "\nsys.exit(run(";
  const command = handedCommand(gate, { task: "task-test", limitSec: 20, ends: "gate" });
  if (command.split(run).length !== 2) throw new Error("handedCommand no longer ends with run(): race it anew");
  const race = `\nimport errno as _errno\n_setpgid = os.setpgid\ndef _raced(pid, pgid):\n    if pid != 0:\n        open(${JSON.stringify(said)}, "w").close()\n        return _setpgid(pid, pgid)\n    for _ in range(40):\n        if os.path.exists(${JSON.stringify(said)}):\n            raise PermissionError(_errno.EPERM, "Operation not permitted")\n        time.sleep(0.005)\n    return _setpgid(pid, pgid)\nos.setpgid = _raced`;
  return command.replace(run, `${race}${run}`);
}

test("a gate's command makes its process group itself before it runs, so no call of its parent's can fail it (the 127)", () => {
  const s = scratch();
  try {
    const ran = shell(raced(s.path("parent-set"), "echo started; exit 4"));
    expect([ran.status, ran.stdout.trim(), ran.stderr.trim()]).toEqual([4, "started", ""]);
    // (Its parent never set the child's group itself.)
    expect(existsSync(s.path("parent-set"))).toBe(false);
  } finally {
    s.done();
  }
});

test("a command it can't start is said, and is 127", () => {
  // (No bash where its PATH looks, as an exec the kernel refuses would be: the helper's own python3 named by its path.)
  const command = handedCommand("exit 0", { task: "task-test", limitSec: 20, ends: "gate" });
  const ran = spawnSync("/bin/bash", ["-c", command], { encoding: "utf8", timeout: 30_000, env: { PATH: "/nonexistent" } });
  expect([ran.status, ran.stderr.trim()]).toEqual([127, "(Its command couldn't be started: No such file or directory.)"]);
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
  expect(made.startsWith("/usr/bin/python3 -I -c '")).toBe(true);
  expect(made).toContain(" task 'task-abc_1' 42 'echo '\\''quoted'\\'' $HOME'");
  expect(handedEndCommand("task-abc_1").endsWith(" 'task-abc_1'")).toBe(true);
  for (const bad of ["../x", "a b", "", "x".repeat(81)]) {
    expect(() => handedCommand("true", { task: bad, limitSec: 1, ends: "gate" })).toThrow("not a task id");
    expect(() => handedEndCommand(bad)).toThrow("not a task id");
  }
  // A gate's copy is one of GATES_DIR's, by a name the node made, and only a gate runs on one.
  const on = `/gates/${"0a".repeat(16)}`;
  expect(handedCommand("true", { task: "task-abc_1", limitSec: 5, ends: "gate", on }).endsWith(` 'true' ${on}`)).toBe(true);
  for (const bad of ["/gates/x", "/tmp/0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a", `${on}/..`, `${on} ; true`]) expect(() => handedCommand("true", { task: "task-abc_1", limitSec: 5, ends: "gate", on: bad })).toThrow("not a gate's copy");
  expect(() => handedCommand("true", { task: "task-abc_1", limitSec: 5, ends: "task", on })).toThrow("not a gate's copy");
});

/*
 * The eighth fabric review's R8-3: the task's VM is its own to write, its HOME and its workspace among it, so nothing the
 * node runs there may take a program or a setting from either. The review's PoC wrote a ~/.bash_profile whose python3
 * said each gate passed; a json.py where the helper starts would do the same, imported before the helper's own.
 */
test("a gate's helper is the VM's own python3, by its path: a python3 the task's login profile defines doesn't answer for it (R8-3)", () => {
  const s = scratch();
  try {
    writeFileSync(s.path(".bash_profile"), 'python3() { echo "passed, said the task"; return 0; }\n');
    const ran = spawnSync("bash", ["-lc", handedCommand("echo ran; exit 3", { task: "task-test", limitSec: 20, ends: "gate" })], { encoding: "utf8", timeout: 30_000, env: { ...process.env, HOME: s.path("") } });
    expect([ran.status, ran.stdout.trim()]).toEqual([3, "ran"]);
  } finally {
    s.done();
  }
});

test("a module where its helper starts isn't run by it: it is python3 -I (R8-3)", () => {
  const s = scratch();
  try {
    writeFileSync(s.path("json.py"), `import os\nopen(${JSON.stringify(s.path("planted-ran"))}, "w").close()\nos._exit(0)\n`);
    const ran = spawnSync("bash", ["-c", handedCommand("echo ran; exit 3", { task: "task-test", limitSec: 20, ends: "gate" })], { cwd: s.path(""), encoding: "utf8", timeout: 30_000 });
    expect([ran.status, ran.stdout.trim(), existsSync(s.path("planted-ran"))]).toEqual([3, "ran", false]);
  } finally {
    s.done();
  }
});

test("a gate on its copy keeps its VM's read-only PATH where the image's /etc/profile sets PATH afresh, as Debian's does (the lab image's /opt/lab/bin)", () => {
  const s = scratch();
  try {
    const on = realpathSync(s.path(""));
    for (const sub of ["tree", "home", "tmp"]) mkdirSync(join(on, sub));
    // (The image's profile, as the lab image's is: Debian's /etc/profile, which sets PATH afresh and puts nothing back.)
    writeFileSync(join(on, "profile"), 'PATH="/usr/local/games"\nexport PATH\n');
    const helper = HANDED_PROCESS_PY.replaceAll("/etc/profile", join(on, "profile"));
    const env = { ...process.env, PATH: process.env.PATH ?? "/usr/bin:/bin" };
    const held = spawnSync("python3", ["-I", "-c", `${helper}\nprint(held_path())`], { encoding: "utf8", env }).stdout.trim().split(":");
    const ran = spawnSync("python3", ["-I", "-c", `${helper}\nsys.exit(run("gate", "task-test", 20.0, sys.argv[1], sys.argv[2]))`, 'printf "%s" "$PATH"', on], { encoding: "utf8", timeout: 30_000, env });
    expect(ran.stderr).toBe("");
    const path = ran.stdout.split(":");
    // What the profile put first stays first; each of the VM's read-only folders comes after it, none lost.
    expect(path[0]).toBe("/usr/local/games");
    expect(held.filter((dir) => !path.includes(dir))).toEqual([]);
  } finally {
    s.done();
  }
});

test("a gate on its copy runs in the copy's tree, its HOME and TMPDIR the copy's own, with nothing else of the VM's environment (R8-3)", () => {
  const s = scratch();
  try {
    // (handedCommand's `on` is a folder of GATES_DIR's, which only a task's VM has: here the helper's own run() is given a scratch one.)
    const on = realpathSync(s.path(""));
    for (const sub of ["tree", "home", "tmp", "bin"]) mkdirSync(join(on, sub));
    // What the task could leave for it: a profile and an rc in that HOME, a BASH_ENV, and a tool of its own first on the PATH.
    writeFileSync(join(on, "home", ".bash_profile"), "ls() { echo profile; }\n");
    writeFileSync(join(on, "home", ".bashrc"), "ls() { echo rc; }\n");
    writeFileSync(join(on, "bin", "ls"), "#!/bin/sh\necho planted\n", { mode: 0o755 });
    writeFileSync(join(on, "env.sh"), "ls() { echo bash_env; }\n");
    const gate = 'printf "%s\\n" "$PWD" "$HOME" "$TMPDIR" "$LANG" "${FOO-unset}" "${BASH_ENV-unset}"; type -t ls; command -v ls || echo none; case ":$PATH:" in *":' + join(on, "bin") + ':"*) echo "planted on PATH";; esac';
    const ran = spawnSync("python3", ["-I", "-c", `${HANDED_PROCESS_PY}\nsys.exit(run("gate", "task-test", 20.0, sys.argv[1], sys.argv[2]))`, gate, on], {
      encoding: "utf8",
      timeout: 30_000,
      env: { ...process.env, FOO: "bar", BASH_ENV: join(on, "env.sh"), HOME: join(on, "home"), PATH: `${join(on, "bin")}:${process.env.PATH}` },
    });
    expect(ran.stderr).toBe("");
    const said = ran.stdout.trim().split("\n");
    expect(said.slice(0, 6)).toEqual([join(on, "tree"), join(on, "home"), join(on, "tmp"), "C.UTF-8", "unset", "unset"]);
    // (Its ls is the system's, a file: where every folder on the PATH is read-only, as a VM's are; none here is planted.)
    expect(said.slice(6).filter((line) => /profile|rc|bash_env|planted/.test(line))).toEqual([]);
    expect(said[6]).not.toBe("function");
  } finally {
    s.done();
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
