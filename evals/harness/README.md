# Coding-agent harness comparison

The same tasks, run through different coding agents in fresh throwaway directories, checked by
rules rather than by a model. It answers a narrow question: **with the same task and a clean
project, does the agent leave the project in the state the task asked for?**

This is not a benchmark of the models behind the agents. Each agent runs with the model it is
configured with, and the report records that model. To compare harnesses instead of models,
point the agents at the same model first (see [Same model](#same-model)).

## Run it

```sh
python3 evals/harness/run.py --agents autobot
python3 evals/harness/run.py --agents autobot,claude,codex,hermes,opencode,pi
python3 evals/harness/run.py --agents autobot --only write-exact,fix-failing-test
```

The report is printed and written to `evals/harness/runs/<timestamp>/report.md`, with each run's
`stdout.log`, `stderr.log`, final project tree and `results.json`. `runs/` is ignored. A
recorded first run is in [`results/2026-10-28/summary.md`](results/2026-10-28/summary.md).

Agents run with their permission checks bypassed, in directories under the run folder. Use a
disposable machine or container for an agent you do not trust. Claude Code spends subscription or
API credit; start with `--agents autobot` if you only want the local comparison.

`--list-agents` shows what is installed and signed in. Missing or signed-out agents are skipped,
not counted as failures. `--dry-run` prints the commands.

## Agents

| Name | Command | Default model | Notes |
| --- | --- | --- | --- |
| `autobot` | `autobot run -C DIR --approvals auto` | `qwen3.8-27b` | Local model through Invincible |
| `claude` | `claude -p --permission-mode bypassPermissions` | account default | Needs `claude auth login` |
| `hermes` | `hermes -z --yolo --in DIR` | `glm-5.3-flash` | `TERMINAL_CWD` keeps its shell in the task directory |
| `opencode` | `opencode run --standalone --auto` | `openai/gpt-6.1-terra` | A private server keeps its cwd in the task directory |
| `pi` | `pi -p --approve --no-session` | `deepseek/deepseek-v4-pro` | Needs DeepSeek credentials |
| `codex` | `codex exec --dangerously-bypass-approvals-and-sandbox` | account default | Needs `codex login`; one of Harness²'s executors |
| `cursor` | `cursor-agent -p --force` | account default | Skipped until `cursor-agent login` |

Override a model without editing the script:

```sh
HARNESS_AUTOBOT_MODEL=qwen3.8-27b \
HARNESS_CLAUDE_MODEL=claude-sonnet-5 \
HARNESS_HERMES_MODEL=glm-5.3-flash \
HARNESS_OPENCODE_MODEL=anthropic/claude-sonnet-5 \
HARNESS_PI_MODEL=deepseek/deepseek-v4-pro \
python3 evals/harness/run.py --agents autobot,claude
```

## Tasks and checks

`tasks.jsonl` is one JSON object per line:

```json
{"id": "write-exact", "timeout": 180, "prompt": "...", "setup": {"hello.txt": "..."},
 "checks": [{"type": "file_equals", "path": "hello.txt", "value": "hello agent"}]}
```

Checks:

- `file_equals`: exact UTF-8 bytes.
- `file_unchanged`: the file still has the hash it had after setup.
- `json_fields`: top-level JSON fields have the wanted values.
- `no_text`: no file matching a glob still contains a string.
- `command`: a command exits 0 (and optionally contains a string). The test commands are the
  project's own `python3 -m unittest -q`.

A pass requires exit code 0 **and** every check. The tasks are deliberately small and
single-purpose: write exact bytes, fix a sign bug, add and export a function, rename across
files, respect a one-file constraint, fix an off-by-one. They are not a substitute for a real
repository, but they are cheap enough to run after every harness change.

## Harder tasks and fixtures

`tasks-hard.jsonl` holds three tasks that take longer and need more than one step: a change buried
in a 177-line module, an implementation against a written specification, and a bug that crosses
two files. Their starting projects live in `fixtures/` and are copied in before the run; a task
can also use an inline `setup` object.

```sh
python3 evals/harness/run.py --agents autobot --tasks evals/harness/tasks-hard.jsonl --timeout-scale 2
```

## Evolving the harness

`evolve.py` runs the Harness² loop locally: it takes the failures and slow passes, gives them to
Autobot as `feedback.md` plus a copy of each failed project, and asks for a general `AGENTS.md`.
It then reruns the suite with that file in every project and keeps the profile only when it passes
more tasks, or passes the same number at least 10% faster.

```sh
python3 evals/harness/evolve.py --tasks evals/harness/tasks-hard.jsonl --rounds 1
python3 evals/harness/evolve.py --baseline evals/harness/runs/hard-baseline --slow-seconds 180
```

The generated `AGENTS.md` is a normal file; read it, edit it, or reject it. Every round's feedback,
runs and the kept profile stay under `evals/harness/runs/evolve-<timestamp>/`. `--baseline` reuses
an existing run's `results.json` instead of paying for the baseline again.

## Same model

The fair harness comparison holds the model fixed and changes only the loop around it. Two ways:

1. **Use Invincible as the model backend.** Invincible serves `/v1/chat/completions` and
   `/v1/messages` on `127.0.0.1:7777`. OpenCode is wired for this:

   ```sh
   python3 evals/harness/run.py --agents opencode --opencode-invincible
   ```

   It sets a private OpenCode provider to the node's `qwen3.8-27b` with a 32768 context and an
   8192-token output limit, using `invincible token`. Claude Code accepts `ANTHROPIC_BASE_URL`
   and a model name, but this node's current chat template refuses the mid-conversation system
   message Claude Code sends; a template that accepts one is needed. Hermes accepts
   OpenAI-compatible providers through its config. Put the same model behind each and rerun;
   tool-call and long-context differences are then properties of the harness.
2. **Use the same cloud model everywhere.** Set `HARNESS_CLAUDE_MODEL` and the provider configs to
   the same model, then rerun all agents.

Without either, read the report as "what a user gets from each agent as installed", not as a
controlled harness study.

## Harness²

[Harness²](https://github.com/google-research/harness2) is a research framework for recursive
harness improvement, not a coding CLI. It improves the prompts, tools, memory, skills,
subagents and guardrails around a frozen model; its executors are OpenCode and Codex. It does not
belong in the table as another row.

There are two useful ways to test Autobot against it:

1. **Evolved executor vs Autobot.** Let Harness² improve an OpenCode or Codex harness on these
   tasks, then run the evolved executor here. The comparison is then "Autobot's fixed harness vs
   an evolved one", on identical checks.
2. **Apply the loop to Autobot.** Run the suite, collect the failures, give them to Autobot and
   ask it to write project-level `AGENTS.md`, skills or scripts that address them, then rerun the
   suite with that harness in place. The before/after delta is the same measurement Harness²
   makes, without its Python/Vertex stack. A useful rule: keep changes that are backed by a failed
   check and remove changes that do not improve one, so the harness does not grow an ever-longer
   prompt.

The suite is intentionally execution-based, so it can score an evolved harness the same way it
scores a stock one.
