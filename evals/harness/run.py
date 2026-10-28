#!/usr/bin/env python3
"""Run the same coding tasks through different agent harnesses, in fresh directories.

Each task is a prompt, a set of files to write first, and checks that are run after the agent
finishes. The checks are deterministic and local: file bytes, unchanged files, a test command,
JSON fields, and text that must no longer appear. Nothing is graded by a model.

Agents are external CLIs, not the models behind them. `autobot` is the home harness; the others
are here to compare it with Claude Code, Hermes Agent, OpenCode and Pi. Missing or signed-out
agents are skipped, not failed.

    python3 evals/harness/run.py --agents autobot,claude,hermes,opencode,pi

The agents run with their permissions open, in throwaway directories. Use a disposable machine
or a container if you do not trust the agent. Claude Code spends subscription or API credit.
"""

from __future__ import annotations

import argparse
import glob
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import time
from datetime import datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parent
DEFAULT_TASKS = ROOT / "tasks.jsonl"
ANSI = re.compile(r"\x1b\[[0-9;?]*[ -/]*[@-~]")


def clean(text: str) -> str:
    return ANSI.sub("", text)


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1 << 20), b""):
            digest.update(chunk)
    return digest.hexdigest()


def run_command(command: list[str], cwd: Path | None = None, env: dict[str, str] | None = None, timeout: int = 30):
    try:
        return subprocess.run(
            command,
            cwd=str(cwd) if cwd else None,
            env=env,
            capture_output=True,
            text=True,
            errors="replace",
            timeout=timeout,
        )
    except (OSError, subprocess.TimeoutExpired) as error:
        return error


def first_line(text: str) -> str:
    for line in clean(text).splitlines():
        line = line.strip()
        if line:
            return line[:120]
    return ""


# --- agents ---------------------------------------------------------------------------------

AGENTS = {
    "autobot": {
        "label": "Autobot",
        "exe": "autobot",
        "model": os.environ.get("HARNESS_AUTOBOT_MODEL", "qwen3.8-27b"),
    },
    "claude": {
        "label": "Claude Code",
        "exe": "claude",
        "model": os.environ.get("HARNESS_CLAUDE_MODEL", "(account default)"),
    },
    "hermes": {
        "label": "Hermes Agent",
        "exe": "hermes",
        "model": os.environ.get("HARNESS_HERMES_MODEL", "glm-5.3-flash"),
    },
    "opencode": {
        "label": "OpenCode",
        "exe": "opencode",
        "model": os.environ.get("HARNESS_OPENCODE_MODEL", "openai/gpt-6.1-terra"),
    },
    "pi": {
        "label": "Pi",
        "exe": "pi",
        "model": os.environ.get("HARNESS_PI_MODEL", "deepseek/deepseek-v4-pro"),
    },
    "cursor": {
        "label": "Cursor Agent",
        "exe": "cursor-agent",
        "model": os.environ.get("HARNESS_CURSOR_MODEL", "(account default)"),
    },
}


def detect(name: str) -> tuple[bool, str, str]:
    """Whether an agent can run here, why not, and its version string."""
    spec = AGENTS[name]
    exe = shutil.which(spec["exe"])
    if not exe:
        return False, f"{spec['exe']} is not installed", ""
    version = ""
    if name == "claude":
        status = run_command([exe, "auth", "status"], timeout=20)
        if isinstance(status, Exception) or status.returncode != 0:
            return False, "claude auth status failed", ""
        try:
            if not json.loads(status.stdout).get("loggedIn"):
                return False, "not logged in", ""
        except json.JSONDecodeError:
            return False, "claude auth status was not JSON", ""
        result = run_command([exe, "--version"], timeout=20)
        version = first_line(result.stdout if not isinstance(result, Exception) else "")
    elif name == "cursor":
        status = run_command([exe, "status"], timeout=20)
        if isinstance(status, Exception) or status.returncode != 0 or "not logged in" in clean(status.stdout).lower():
            return False, "not logged in", ""
        version = first_line(status.stdout)
    elif name == "pi":
        status = run_command([exe, "auth", "check", "--provider", "deepseek", "--json"], timeout=20)
        if isinstance(status, Exception) or status.returncode != 0:
            return False, "deepseek credentials are not configured", ""
        try:
            if json.loads(status.stdout).get("status") != "ready":
                return False, "deepseek credentials are not ready", ""
        except json.JSONDecodeError:
            return False, "pi auth check was not JSON", ""
        result = run_command([exe, "--version"], timeout=20)
        version = first_line(result.stdout if not isinstance(result, Exception) else "")
    else:
        result = run_command([exe, "--version"], timeout=20)
        if isinstance(result, Exception):
            return False, f"{spec['exe']} --version failed", ""
        version = first_line(result.stdout or result.stderr)
    return True, "", version


def command_for(name: str, prompt: str, workdir: Path) -> tuple[list[str], dict[str, str]]:
    exe = shutil.which(AGENTS[name]["exe"]) or AGENTS[name]["exe"]
    model = AGENTS[name]["model"]
    env = dict(os.environ)
    env["NO_COLOR"] = "1"
    # `cwd=` changes the real cwd but not PWD; some agents (OpenCode) read PWD as the workspace.
    env["PWD"] = str(workdir)
    if name == "autobot":
        command = [exe, "run", "-C", str(workdir), "--approvals", "auto", "--session", "harness"]
        if model:
            command += ["--model", model]
        command.append(prompt)
    elif name == "claude":
        command = [exe, "-p", prompt, "--permission-mode", "bypassPermissions", "--output-format", "json"]
        if model and model != "(account default)":
            command += ["--model", model]
    elif name == "hermes":
        command = [exe, "--in", str(workdir), "--no-restore-cwd", "-z", prompt, "--yolo"]
        if model:
            command += ["-m", model]
        env["TERMINAL_CWD"] = str(workdir)
    elif name == "opencode":
        # A shared background server keeps its own cwd; a private one starts in the task directory.
        command = [exe, "run", "--standalone", "--auto"]
        if model:
            command += ["--model", model]
        command.append(prompt)
    elif name == "pi":
        command = [exe, "-p", prompt, "--provider", "deepseek", "--model", model, "--approve", "--no-session"]
    else:
        command = [exe, "-p", "--force", prompt]
        if model and model != "(account default)":
            command += ["--model", model]
    return command, env


# --- tasks and checks -----------------------------------------------------------------------

def load_tasks(path: Path) -> list[dict]:
    tasks = []
    with path.open(encoding="utf-8") as handle:
        for number, line in enumerate(handle, 1):
            line = line.strip()
            if not line or line.startswith("#"):
                continue
            try:
                task = json.loads(line)
            except json.JSONDecodeError as error:
                raise SystemExit(f"{path}:{number}: {error}") from error
            for key in ("id", "prompt", "checks"):
                if key not in task:
                    raise SystemExit(f"{path}:{number}: task has no {key}")
            tasks.append(task)
    return tasks


def write_setup(workdir: Path, setup: dict[str, str]) -> dict[str, str]:
    hashes = {}
    for relative, content in setup.items():
        path = workdir / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(content, encoding="utf-8")
        hashes[relative] = sha256(path)
    return hashes


def check_one(check: dict, workdir: Path, before: dict[str, str]) -> tuple[bool, str]:
    kind = check["type"]
    if kind == "file_equals":
        path = workdir / check["path"]
        if not path.exists():
            return False, f"{check['path']} is missing"
        actual = path.read_text(encoding="utf-8")
        if actual != check["value"]:
            return False, f"{check['path']} is {actual!r}, expected {check['value']!r}"
        return True, "ok"
    if kind == "file_unchanged":
        path = workdir / check["path"]
        wanted = before.get(check["path"])
        if wanted is None:
            return False, f"{check['path']} was not in the setup"
        if not path.exists():
            return False, f"{check['path']} was deleted"
        same = sha256(path) == wanted
        return (same, "unchanged" if same else f"{check['path']} was modified")
    if kind == "json_fields":
        path = workdir / check["path"]
        if not path.exists():
            return False, f"{check['path']} is missing"
        try:
            value = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as error:
            return False, f"{check['path']} is not JSON: {error}"
        wrong = [f"{key}={value.get(key)!r}, expected {wanted!r}" for key, wanted in check["fields"].items() if value.get(key) != wanted]
        return (not wrong, "ok" if not wrong else "; ".join(wrong))
    if kind == "no_text":
        found = []
        for path in glob.glob(str(workdir / check["glob"]), recursive=True):
            try:
                if check["text"] in Path(path).read_text(encoding="utf-8"):
                    found.append(Path(path).relative_to(workdir).as_posix())
            except (OSError, UnicodeDecodeError):
                continue
        return (not found, "ok" if not found else f"still contains {check['text']!r}: {', '.join(found)}")
    if kind == "command":
        result = run_command(check["command"], cwd=workdir, timeout=check.get("timeout", 90))
        if isinstance(result, Exception):
            return False, f"command failed to run: {result}"
        detail = f"exit {result.returncode}"
        output = clean(result.stdout + result.stderr).strip()
        if output:
            detail += f": {output.splitlines()[-1][:200]}"
        if result.returncode != 0:
            return False, detail
        wanted = check.get("contains")
        if wanted and wanted not in clean(result.stdout + result.stderr):
            return False, f"output does not contain {wanted!r}"
        return True, "ok"
    return False, f"unknown check {kind!r}"


def checks_for(task: dict, workdir: Path, before: dict[str, str]) -> list[dict]:
    results = []
    for check in task["checks"]:
        ok, detail = check_one(check, workdir, before)
        results.append({"type": check["type"], "ok": ok, "detail": detail})
    return results


# --- running --------------------------------------------------------------------------------

def run_one(agent: str, task: dict, out: Path, timeout_scale: float) -> dict:
    workdir = (out / "work").resolve()
    if workdir.exists():
        shutil.rmtree(workdir)
    workdir.mkdir(parents=True)
    before = write_setup(workdir, task.get("setup", {}))
    command, env = command_for(agent, task["prompt"], workdir)
    timeout = max(30, int(task.get("timeout", 300) * timeout_scale))
    started = time.monotonic()
    timed_out = False
    error = ""
    try:
        result = subprocess.run(
            command,
            cwd=str(workdir),
            env=env,
            capture_output=True,
            text=True,
            errors="replace",
            timeout=timeout,
        )
        exit_code = result.returncode
        stdout, stderr = result.stdout, result.stderr
    except subprocess.TimeoutExpired as expired:
        timed_out = True
        exit_code = None
        stdout = expired.stdout or ""
        stderr = expired.stderr or ""
        if isinstance(stdout, bytes):
            stdout = stdout.decode("utf-8", "replace")
        if isinstance(stderr, bytes):
            stderr = stderr.decode("utf-8", "replace")
        error = f"timed out after {timeout}s"
    except OSError as why:
        timed_out = False
        exit_code = None
        stdout, stderr = "", ""
        error = str(why)
    duration = time.monotonic() - started

    (out / "stdout.log").write_text(stdout, encoding="utf-8")
    (out / "stderr.log").write_text(stderr, encoding="utf-8")
    checks = checks_for(task, workdir, before) if not error else []
    passed = not error and not timed_out and exit_code == 0 and all(check["ok"] for check in checks)
    failed = [check for check in checks if not check["ok"]]
    if timed_out:
        status = "timeout"
    elif error:
        status = "error"
    elif passed:
        status = "pass"
    else:
        status = "fail"
    summary = error
    if not summary and failed:
        summary = "; ".join(check["detail"] for check in failed)[:300]
    if not summary and exit_code not in (0, None):
        summary = f"agent exited {exit_code}: {first_line(stderr or stdout)}"
    return {
        "agent": agent,
        "task": task["id"],
        "status": status,
        "duration": round(duration, 2),
        "exit_code": exit_code,
        "timed_out": timed_out,
        "checks": checks,
        "summary": summary,
        "workdir": str(workdir),
    }


def markdown_report(results: list[dict], agents: dict[str, dict], tasks: list[dict], skipped: dict[str, str]) -> str:
    lines = ["# Coding-agent harness comparison", ""]
    lines.append(f"Run: {datetime.now().astimezone().isoformat(timespec='seconds')}")
    lines.append("")
    lines.append("| Agent | Model | Version | Passed | Total | Time |")
    lines.append("| --- | --- | --- | ---: | ---: | ---: |")
    for name, info in agents.items():
        runs = [result for result in results if result["agent"] == name]
        passed = sum(1 for result in runs if result["status"] == "pass")
        seconds = sum(result["duration"] for result in runs)
        version = (info.get("version") or "").replace("|", "/")
        lines.append(f"| {AGENTS[name]['label']} | `{info['model']}` | {version or '-'} | {passed} | {len(runs)} | {seconds:.1f}s |")
    if skipped:
        lines += ["", "Skipped: " + "; ".join(f"{AGENTS[name]['label']} ({why})" for name, why in skipped.items())]
    lines += ["", "## Per task", "", "| Task | " + " | ".join(AGENTS[name]["label"] for name in agents) + " |"]
    lines.append("| --- | " + " | ".join("---" for _ in agents) + " |")
    for task in tasks:
        cells = []
        for name in agents:
            result = next((item for item in results if item["agent"] == name and item["task"] == task["id"]), None)
            cells.append(result["status"] if result else "-")
        lines.append(f"| `{task['id']}` | " + " | ".join(cells) + " |")
    failures = [result for result in results if result["status"] != "pass"]
    if failures:
        lines += ["", "## Failures", ""]
        for result in failures:
            lines.append(f"- **{AGENTS[result['agent']]['label']} / {result['task']}**: {result['status']}; {result['summary'] or 'checks failed'}")
    lines.append("")
    lines.append("A pass means the agent exited 0 and every check passed. Durations include the agent's own thinking and tool time.")
    lines.append("")
    return "\n".join(lines)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--agents", default="autobot", help="comma-separated: " + ", ".join(AGENTS))
    parser.add_argument("--tasks", type=Path, default=DEFAULT_TASKS, help="JSON Lines task file")
    parser.add_argument("--only", default="", help="comma-separated task ids")
    parser.add_argument("--out", type=Path, default=None, help="run directory (default: runs/<timestamp>)")
    parser.add_argument("--timeout-scale", type=float, default=1.0, help="multiply each task's timeout")
    parser.add_argument("--dry-run", action="store_true", help="print the commands; run nothing")
    parser.add_argument("--list-agents", action="store_true", help="show which agents are ready and exit")
    args = parser.parse_args()

    names = [name.strip() for name in args.agents.split(",") if name.strip()]
    unknown = [name for name in names if name not in AGENTS]
    if unknown:
        parser.error(f"unknown agent(s): {', '.join(unknown)}")
    tasks = load_tasks(args.tasks)
    if args.only:
        wanted = {name.strip() for name in args.only.split(",") if name.strip()}
        tasks = [task for task in tasks if task["id"] in wanted]
        missing = wanted - {task["id"] for task in tasks}
        if missing:
            parser.error(f"no such task(s): {', '.join(sorted(missing))}")

    ready = {}
    skipped = {}
    for name in names:
        ok, why, version = detect(name)
        if ok:
            ready[name] = {"model": AGENTS[name]["model"], "version": version}
        else:
            skipped[name] = why
    if args.list_agents:
        for name in names:
            if name in ready:
                print(f"{name}: ready ({ready[name]['version'] or 'no version'}) model={ready[name]['model']}")
            else:
                print(f"{name}: skipped ({skipped[name]})")
        return 0
    if not ready:
        print("No agent is ready:", "; ".join(f"{name}: {why}" for name, why in skipped.items()), file=sys.stderr)
        return 1
    if args.dry_run:
        for name in ready:
            example = Path("/tmp/example")
            command, _ = command_for(name, "<task prompt>", example)
            print(f"{name}: {' '.join(command)}")
        return 0

    stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
    out = args.out or (ROOT / "runs" / stamp)
    out.mkdir(parents=True, exist_ok=True)
    print(f"run: {out}")
    print(f"agents: {', '.join(AGENTS[name]['label'] for name in ready)}")
    print(f"tasks: {len(tasks)}")
    print("Agents run with permissions open in throwaway directories.")

    results = []
    for name in ready:
        for task in tasks:
            run_dir = out / name / task["id"]
            print(f"  {AGENTS[name]['label']:14} {task['id']:20} ", end="", flush=True)
            result = run_one(name, task, run_dir, args.timeout_scale)
            results.append(result)
            print(f"{result['status']:7} {result['duration']:6.1f}s  {result['summary'][:90]}")

    report = markdown_report(results, ready, tasks, skipped)
    (out / "report.md").write_text(report, encoding="utf-8")
    (out / "results.json").write_text(
        json.dumps({"agents": ready, "skipped": skipped, "tasks": [task["id"] for task in tasks], "results": results}, indent=2),
        encoding="utf-8",
    )
    print()
    print(report)
    print(f"report: {out / 'report.md'}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
