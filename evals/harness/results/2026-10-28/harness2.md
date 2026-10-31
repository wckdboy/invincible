# Harness², 28 October 2026

Repository: `google-research/harness2`, commit `1cfe254` (Apache 2.0), installed at
`~/wckdboy/harness2` with Python 3.12 and `uv`.

## Official local demo

```sh
harness2-demo --output runs/demo --k 2
```

Result: **2 tasks, 0 failed**, 28 real Python executions, 32 editor calls, both parallel and
sequential recursion. The demo uses deterministic editors and needs no model credentials.

## A model-backed JobBench task

One task, `biostatisticians/task1`, with DeepSeek v4 Pro as solver, improver and judge, through the
pinned OpenCode 1.14.18. The run store is `~/wckdboy/harness2/runs/jb-deepseek/jb/`.

| Label | What it is | Files in `model_output` |
| --- | --- | ---: |
| `base1` | the initial harness | 3 |
| `inv1` | invariant candidate | 3 |
| `dom1` | domain candidate | 1 |
| `agg1` | aggregate composition | 3 |

The base rollout produced the three requested `.xlsx` deliverables. The two proposer channels
produced their own candidate harnesses and rollouts, and the aggregate composer produced a final
candidate. The blind selection/judge phase did not finish within the one-hour shell cap, and a
resume was still waiting when it was stopped, so there is no final JobBench score here. The raw
outputs and trajectories remain in the run store.

## Setup notes

- The pinned OpenCode cannot parse this machine's newer global config (`mcp.servers`). The run used
  an isolated `XDG_CONFIG_HOME` with `{}` and an `OPENCODE_CONFIG_CONTENT` provider for DeepSeek.
- `HARNESS2_SOLVER_MODEL` and `HARNESS2_IMPROVER_MODEL` were `deepseek/deepseek-v4-pro`;
  `HARNESS2_JUDGE_MODEL` was `deepseek-v4-pro` with `HARNESS2_JUDGE_BASE_URL=https://api.deepseek.com/v1`.
- The local model could not be used as the solver: the pinned OpenCode's OpenCode Zen model list is
  older than this machine's, and the harness's 64k output ceiling exceeds the node's 32k context.
  DeepSeek was used to exercise the framework end to end.

This is a Harness² run, not a score for Autobot or Invincible. The comparison against Autobot is in
`summary.md`.
