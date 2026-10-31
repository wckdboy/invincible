#!/usr/bin/env python3
"""Evolve a small project harness from failed checks: the Harness² loop, locally.

Run the task suite, collect the failures, give them to Autobot and ask for a general `AGENTS.md`,
then rerun the suite with that file in every project. Keep the profile only when it improves the
number of passing tasks. Repeat for a few rounds if asked. Nothing is graded by a model: the
suite's own checks decide whether a change helped.

    python3 evals/harness/evolve.py --tasks evals/harness/tasks-hard.jsonl
    python3 evals/harness/evolve.py --rounds 2 --timeout-scale 1.5

The feedback and every run stay under `evals/harness/runs/evolve-<timestamp>/`. The generated
profile is a normal `AGENTS.md`; you can read it, edit it, or use it outside this loop.
"""

from __future__ import annotations

import argparse
import json
import shutil
import subprocess
import sys
from datetime import datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parent
RUN = ROOT / "run.py"


def suite(
    tasks: Path,
    out: Path,
    profile: Path | None,
    timeout_scale: float,
    model: str,
    agent: str,
) -> dict:
    command = [
        sys.executable,
        str(RUN),
        "--agents",
        agent,
        "--tasks",
        str(tasks),
        "--out",
        str(out),
        "--timeout-scale",
        str(timeout_scale),
    ]
    if profile:
        command += ["--profile", str(profile)]
    if model and agent == "autobot":
        # run.py reads the model from the environment for Autobot.
        import os

        os.environ["HARNESS_AUTOBOT_MODEL"] = model
    result = subprocess.run(command, capture_output=True, text=True)
    (out / "suite.log").write_text(result.stdout + result.stderr, encoding="utf-8")
    data_path = out / "results.json"
    if not data_path.exists():
        raise SystemExit(f"the suite wrote no results: {out}")
    return json.loads(data_path.read_text(encoding="utf-8"))


def passes(data: dict) -> int:
    return sum(1 for result in data.get("results", []) if result["status"] == "pass")


def selected(data: dict, slow_seconds: float) -> list[dict]:
    """Failures, and passes slow enough to be worth improving."""
    return [
        result
        for result in data.get("results", [])
        if result["status"] != "pass" or result.get("duration", 0) > slow_seconds
    ]


def seconds(data: dict) -> float:
    return sum(result.get("duration", 0) for result in data.get("results", []))


def tail(path: Path, lines: int = 40) -> str:
    if not path.exists():
        return ""
    text = path.read_text(encoding="utf-8", errors="replace").splitlines()
    return "\n".join(text[-lines:])


def feedback(
    data: dict,
    task_by_id: dict[str, dict],
    work_root: Path,
    dest: Path,
    previous: Path | None,
    slow_seconds: float,
) -> None:
    dest.mkdir(parents=True, exist_ok=True)
    if previous and (previous / "AGENTS.md").exists():
        shutil.copy2(previous / "AGENTS.md", dest / "AGENTS.md")
    blocks = []
    for result in selected(data, slow_seconds):
        task = task_by_id[result["task"]]
        failed = [check for check in result.get("checks", []) if not check["ok"]]
        evidence = dest / "evidence" / result["task"]
        source = Path(result["workdir"])
        if source.is_dir():
            shutil.copytree(source, evidence, dirs_exist_ok=True)
        block = [
            f"## {result['task']}",
            "",
            f"Prompt: {task['prompt']}",
            "",
            f"Result: {result['status']} in {result.get('duration', 0):.1f}s "
            f"(exit {result.get('exit_code')}); {result.get('summary', '')}",
            "",
        ]
        if result["status"] == "pass":
            block += [f"This passed, but it took more than {slow_seconds:.0f}s. Improve the process, not the answer.", ""]
        if failed:
            block += ["Failed checks:", ""]
            block += [f"- {check['type']}: {check['detail']}" for check in failed]
            block += [""]
        output = tail(work_root / result["agent"] / result["task"] / "stdout.log")
        errors = tail(work_root / result["agent"] / result["task"] / "stderr.log")
        if output:
            block += ["Last of the agent's output:", "", "```", output, "```", ""]
        if errors:
            block += ["Last of its errors:", "", "```", errors, "```", ""]
        blocks.append("\n".join(block))
    (dest / "feedback.md").write_text(
        "# Failed checks and slow passes\n\nThe evidence for each item is under `evidence/`.\n\n"
        + "\n".join(blocks),
        encoding="utf-8",
    )


def ask_for_profile(dest: Path, model: str, autobot: str, round_number: int) -> None:
    prompt = (
        "Read feedback.md and the evidence/ directory. These are failures or slow runs from a "
        "coding-agent evaluation. Write a concise project AGENTS.md (at most 40 lines) with general "
        "rules that would prevent this class of failure and shorten the work: inspect the relevant "
        "files before editing, read the tests and the specification, make the smallest change, run "
        "only the relevant test once, keep unrelated files unchanged, and stop when the checks pass. "
        "If AGENTS.md already exists, improve it rather than starting over. Do not "
        "include task-specific filenames, values, test names or answers. Write only AGENTS.md; do not "
        "modify anything under evidence/ or create other files. Do not ask questions."
    )
    command = [
        autobot,
        "run",
        "-C",
        str(dest),
        "--approvals",
        "auto",
        "--session",
        f"harness-evolve-{round_number}",
        "--model",
        model,
        prompt,
    ]
    print(f"  asking Autobot for a profile (round {round_number})...", flush=True)
    try:
        result = subprocess.run(command, capture_output=True, text=True, timeout=900)
        output = result.stdout + result.stderr
    except subprocess.TimeoutExpired as expired:
        output = (expired.stdout or "") + (expired.stderr or "")
        (dest / "autobot.log").write_text(str(output), encoding="utf-8")
        raise SystemExit(f"Autobot did not finish the profile in 900s; see {dest / 'autobot.log'}")
    (dest / "autobot.log").write_text(output, encoding="utf-8")
    if not (dest / "AGENTS.md").exists():
        (dest / "AGENTS.md").write_text("", encoding="utf-8")
        raise SystemExit(f"Autobot wrote no AGENTS.md; see {dest / 'autobot.log'}")


def report(rounds: list[dict], accepted: list[dict], out: Path) -> str:
    lines = ["# Harness evolution", ""]
    lines.append(f"Run: {datetime.now().astimezone().isoformat(timespec='seconds')}")
    lines.append("")
    lines.append("| Round | Profile | Passed | Total | Seconds | Kept |")
    lines.append("| --- | --- | ---: | ---: | ---: | --- |")
    for item in rounds:
        lines.append(
            f"| {item['round']} | {item['profile']} | {item['passed']} | {item['total']} | "
            f"{item.get('seconds', 0):.1f} | {'yes' if item.get('kept') else 'no'} |"
        )
    lines += ["", "## Profiles", ""]
    if accepted:
        for item in accepted:
            lines.append(f"- round {item['round']}: `{item['path']}`")
    else:
        lines.append("- no profile improved the suite; the baseline is unchanged")
    lines.append("")
    lines.append(
        "A profile is kept when it passes more tasks than the run before it, or passes the same "
        "number at least 10% faster."
    )
    lines.append("")
    return "\n".join(lines)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--tasks", type=Path, default=ROOT / "tasks-hard.jsonl")
    parser.add_argument("--rounds", type=int, default=1, help="how many improvement rounds to try")
    parser.add_argument("--timeout-scale", type=float, default=1.5)
    parser.add_argument("--slow-seconds", type=float, default=180, help="passes slower than this are feedback too")
    parser.add_argument("--baseline", type=Path, default=None, help="reuse a run directory with results.json")
    parser.add_argument("--model", default="qwen3.8-27b", help="the Autobot model that writes the profile")
    parser.add_argument("--agent", default="autobot", help="the agent the suite runs (default: autobot)")
    parser.add_argument("--autobot", default=shutil.which("autobot") or "autobot")
    parser.add_argument("--out", type=Path, default=None)
    args = parser.parse_args()

    tasks = []
    with args.tasks.open(encoding="utf-8") as handle:
        for line in handle:
            if line.strip() and not line.startswith("#"):
                tasks.append(json.loads(line))
    task_by_id = {task["id"]: task for task in tasks}

    stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
    out = (args.out or (ROOT / "runs" / f"evolve-{stamp}")).resolve()
    out.mkdir(parents=True, exist_ok=True)
    print(f"evolution: {out}")
    print(f"tasks: {args.tasks} ({len(tasks)})")

    if args.baseline:
        baseline_root = args.baseline.resolve()
        baseline = json.loads((baseline_root / "results.json").read_text(encoding="utf-8"))
    else:
        baseline_root = out / "baseline"
        baseline = suite(args.tasks, baseline_root, None, args.timeout_scale, args.model, args.agent)
    baseline_passes = passes(baseline)
    baseline_seconds = seconds(baseline)
    total = len(baseline.get("results", []))
    print(f"baseline: {baseline_passes}/{total} pass in {baseline_seconds:.1f}s")
    rounds = [
        {
            "round": 0,
            "profile": "none",
            "passed": baseline_passes,
            "total": total,
            "seconds": baseline_seconds,
            "kept": True,
        }
    ]
    accepted = []
    current = baseline
    current_root = baseline_root
    current_passes = baseline_passes
    current_seconds = baseline_seconds
    profile = None

    for number in range(1, args.rounds + 1):
        if not selected(current, args.slow_seconds):
            print("nothing to evolve: every task passed quickly")
            break
        suggestion = out / f"round-{number}" / "feedback"
        feedback(current, task_by_id, current_root, suggestion, profile, args.slow_seconds)
        try:
            ask_for_profile(suggestion, args.model, args.autobot, number)
        except SystemExit as why:
            print(f"  {why}")
            break
        candidate = out / f"round-{number}" / "profile"
        candidate.mkdir(parents=True, exist_ok=True)
        shutil.copy2(suggestion / "AGENTS.md", candidate / "AGENTS.md")
        print(f"  profile: {candidate / 'AGENTS.md'}")
        after_root = out / f"round-{number}" / "after"
        after = suite(args.tasks, after_root, candidate, args.timeout_scale, args.model, args.agent)
        after_passes = passes(after)
        after_seconds = seconds(after)
        kept = after_passes > current_passes or (
            after_passes == current_passes and after_seconds < current_seconds * 0.9
        )
        rounds.append(
            {
                "round": number,
                "profile": str(candidate / "AGENTS.md"),
                "passed": after_passes,
                "total": len(after.get("results", [])),
                "seconds": after_seconds,
                "kept": kept,
            }
        )
        print(
            f"  round {number}: {after_passes}/{len(after.get('results', []))} pass in "
            f"{after_seconds:.1f}s; {'kept' if kept else 'rejected'}"
        )
        if not kept:
            rejected = out / f"round-{number}" / "profile-rejected"
            shutil.move(str(candidate), str(rejected))
            rounds[-1]["profile"] = str(rejected / "AGENTS.md")
            break
        accepted.append({"round": number, "path": str(candidate / "AGENTS.md")})
        profile = candidate
        current = after
        current_root = after_root
        current_passes = after_passes
        current_seconds = after_seconds

    text = report(rounds, accepted, out)
    (out / "report.md").write_text(text, encoding="utf-8")
    (out / "results.json").write_text(json.dumps({"rounds": rounds, "accepted": accepted, "dir": str(out)}, indent=2), encoding="utf-8")
    print()
    print(text)
    print(f"report: {out / 'report.md'}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
