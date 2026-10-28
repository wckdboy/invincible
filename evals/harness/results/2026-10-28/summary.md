# Coding-agent comparison, 28 October 2026

Six tasks, fresh directories, deterministic checks. Every agent below passed all six. The
suite is a smoke test, not a ranking: the tasks are small on purpose, so a capable agent should
finish them; the useful signal is where an agent gets stuck, how long it takes, and what it
leaves behind. Details and per-task times are in the reports beside this file.

## Agents as installed

Each agent used its own configured model. This compares products as a user would run them, not
harnesses with the model held fixed.

| Agent | Model | Passed | Wall time |
| --- | --- | ---: | ---: |
| Autobot | `qwen3.8-27b` (local, one node) | 6/6 | 833.1s |
| Claude Code | account default | 6/6 | 57.1s |
| Codex | account default | 6/6 | 136.1s |
| Hermes Agent | `glm-5.3-flash` | 6/6 | 206.1s |
| OpenCode | `openai/gpt-6.1-terra` | 6/6 | 59.7s |
| Pi | `deepseek/deepseek-v4-pro` | 6/6 | 62.7s |

Autobot is the slowest because its model is a 27B model on one local machine. The other agents
reached cloud models. That is a real difference between the ways they are run, not a harness
result.

## OpenCode on the same model

`--opencode-invincible` points OpenCode at this node's `qwen3.8-27b` through
`/v1/chat/completions`, with the model's context and a 8192-token output limit. On `write-exact`
both passed:

| Harness + model | Result | Time |
| --- | --- | ---: |
| Autobot + `qwen3.8-27b` | pass | 110.1s |
| OpenCode + `qwen3.8-27b` | pass | 123.5s |

One task is not enough to rank the harnesses, but it shows what the controlled comparison is
for: with the model held fixed, the time and failure mode belong to the harness. The OpenCode
run needed `--timeout-scale 2` because the agent took over the default 180 seconds to exit after
writing the correct file.

## Claude Code through the node

Not usable with this node's current chat template: Claude Code sends a system message after the
conversation has begun, and llama.cpp's template refuses it ("System message must be at the
beginning"). That is a template limitation, not an Autobot result. A template that accepts
mid-conversation system messages, or a client that keeps one system block, would make that
comparison possible.

## Harness²

Harness² is not an executor in the table. It improves the harness around a frozen model and uses
OpenCode or Codex as its executor. To measure it here: let it evolve an OpenCode or Codex harness,
then run the evolved executor through this suite; or apply the same failed-check-driven loop to
Autobot's project `AGENTS.md`, skills and scripts and rerun. The before/after delta on these
checks is the measurement.
