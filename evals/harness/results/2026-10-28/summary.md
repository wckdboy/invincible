# Coding-agent comparison, 28 October 2026

The same tasks, fresh directories, deterministic checks. This is a smoke suite, not a ranking:
the small tasks are meant to be solvable; the useful signal is where an agent gets stuck, how
long it takes, and what it leaves behind. Reports for each run are beside this file.

## Agents as installed

Each agent used its own configured model, except the controlled OpenCode run below. This compares
products as a user would run them, not harnesses with the model held fixed.

| Agent | Model | Passed | Wall time |
| --- | --- | ---: | ---: |
| Autobot | `qwen3.8-27b` (local, one node) | 6/6 | 770.7s |
| Claude Code | account default | 6/6 | 57.1s |
| Codex | account default | 6/6 | 136.1s |
| Hermes Agent | `glm-5.3-flash` | 6/6 | 206.1s |
| OpenCode | `openai/gpt-6.1-terra` | 6/6 | 59.7s |
| Pi | `deepseek/deepseek-v4-pro` | 6/6 | 62.7s |

Autobot is the slowest because its model is a 27B model on one local machine; the other agents
reached cloud models. That is a difference between the ways they are run, not a harness result.
The Autobot row is the isolated run after the fixes below; the first run shared one Autobot
session across tasks and is not used for timing.

## Session isolation

The first harness run gave every Autobot task the same `--session harness`, so each task saw the
last one's conversation. The harness now names a session per run and task, and `autobot run` now
starts a fresh conversation by default (`--session NAME` continues one on purpose). The fix is in
`crates/autobot/src/main.rs`; two live runs each used their own `run-*` session and saw only their
own task. All numbers here are from isolated runs.

## Harder tasks

`tasks-hard.jsonl` adds a change buried in a 177-line module (`large-file-edit`), an implementation
against a written specification (`spec-implementation`), and a bug across two files
(`cross-file-bug`). On the first isolated baseline Autobot passed two of three; `spec-implementation`
ran the tests successfully but did not exit within 450s.

The generated project profile (`AGENTS.md`: read once, make the smallest change, run the relevant
test once, stop) took that task to a **pass in 156.8s**. A distilled version of the same rule is now
in Autobot's coding system prompt; with it, `spec-implementation` passed in **267.5s** with no
profile. The profile remains at `runs/evolve-hard/profile/AGENTS.md` in the working tree; the
measured reports are `hard.md`, `spec-prompt.md` and `spec-profile.md`.

## OpenCode on the same model

`--opencode-invincible` points OpenCode at this node's `qwen3.8-27b`, with a 32768 context and an
8192-token output limit. On `write-exact` both passed:

| Harness + model | Result | Time |
| --- | --- | ---: |
| Autobot + `qwen3.8-27b` (current prompt) | pass | 69.0s |
| OpenCode + `qwen3.8-27b` | pass | 123.5s |

One task is not enough to rank the harnesses. The OpenCode run needed `--timeout-scale 2` because
it took over the default 180 seconds to exit after writing the correct file.

## Claude Code through the node

Not usable with this node's current chat template: Claude Code sends a system message after the
conversation has begun, and llama.cpp's template refuses it ("System message must be at the
beginning"). That is a template limitation, not an Autobot result. A template that accepts
mid-conversation system messages, or a client that keeps one system block, would make that
comparison possible.

## Harness²

Harness² (Apache 2.0, `google-research/harness2`, commit `1cfe254`) is a harness-improvement
framework, not another executor. It was installed and run here:

- **Official local demo** (`harness2-demo --output runs/demo --k 2`): 2 tasks, 0 failed, 28 real
  Python executions, 32 editor calls. It exercises both parallel and sequential recursion with
  deterministic editors and no model credentials.
- **A model-backed JobBench task** (`biostatisticians/task1`) ran through the pinned OpenCode with
  DeepSeek v4 Pro as solver and improver. The base rollout produced the three requested `.xlsx`
  deliverables; the invariant (`inv1`) and domain (`dom1`) proposals each produced their own
  candidate rollouts; the aggregate composer produced `agg1`. The blind selection/judge phase did
  not finish within the one-hour shell cap, so there is no final score in this report. The
  per-rollout outputs and trajectories are under `harness2/runs/jb-deepseek/` in the working tree.

The pinned OpenCode 1.14.18 cannot parse this machine's newer global OpenCode config
(`mcp.servers`), so the run used an isolated `XDG_CONFIG_HOME` and an `OPENCODE_CONFIG_CONTENT`
DeepSeek provider. That is a setup detail, not a Harness² result. The exact labels and outputs are
in `harness2.md`.

## The local evolution loop

`evolve.py` applies the same idea without Harness²'s Python/Vertex stack: failures and slow passes
become a general `AGENTS.md`, the suite is rerun with that profile, and the profile is kept only
when it passes more tasks or is at least 10% faster. The generated profile is what produced the
156.8s result above. The automatic compare step was completed by hand because the first profile
generation was slow enough to hit the shell cap; `evolve.py` now has a 900-second profile timeout.
