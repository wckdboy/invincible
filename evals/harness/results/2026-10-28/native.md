# Coding-agent harness comparison

Run: 2026-10-28T04:12:06+01:00

| Agent | Model | Version | Passed | Total | Time |
| --- | --- | --- | ---: | ---: | ---: |
| Autobot | `qwen3.8-27b` | autobot 0.0.21 | 6 | 6 | 833.1s |
| Claude Code | `(account default)` | 2.1.308 (Claude Code) | 6 | 6 | 57.1s |
| Hermes Agent | `glm-5.3-flash` | Hermes Agent v0.21.1 (2026.9.7) · upstream b2aa855b | 6 | 6 | 206.1s |
| OpenCode | `openai/gpt-6.1-terra` | opencode v2.2.0 | 6 | 6 | 59.7s |
| Pi | `deepseek/deepseek-v4-pro` | 0.85.1 | 6 | 6 | 62.7s |

## Per task

| Task | Autobot | Claude Code | Hermes Agent | OpenCode | Pi |
| --- | --- | --- | --- | --- | --- |
| `write-exact` | pass | pass | pass | pass | pass |
| `fix-failing-test` | pass | pass | pass | pass | pass |
| `multi-file-feature` | pass | pass | pass | pass | pass |
| `rename-refactor` | pass | pass | pass | pass | pass |
| `constraint-edit` | pass | pass | pass | pass | pass |
| `off-by-one` | pass | pass | pass | pass | pass |

A pass means the agent exited 0 and every check passed. Durations include the agent's own thinking and tool time.
