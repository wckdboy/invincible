# Agents as installed

Autobot's row is from the isolated run after the session and prompt fixes (`autobot-isolated.md`).
The external agents do not use Autobot's session store; their rows are from the first run.

| Agent | Model | Passed | Wall time |
| --- | --- | ---: | ---: |
| Autobot | `qwen3.8-27b` (local) | 6/6 | 770.7s |
| Claude Code | account default | 6/6 | 57.1s |
| Codex | account default | 6/6 | 136.1s |
| Hermes Agent | `glm-5.3-flash` | 6/6 | 206.1s |
| OpenCode | `openai/gpt-6.1-terra` | 6/6 | 59.7s |
| Pi | `deepseek/deepseek-v4-pro` | 6/6 | 62.7s |

Per-task checks passed for every row. This is not a ranking: the models differ, and Autobot runs
a 27B model on this machine while the others used cloud models.
