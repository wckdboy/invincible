# `inv`: the command line

`inv` is a client of a node, as the apps are. It gives work, shows it and shows its proof. It never owns work: every
task runs on a node, in its agent's VM, and closing the terminal stops nothing. `inv stop` stops a task. Ctrl-C only
leaves.

This page is the contract: the commands, their output and their exit codes are promises. A script may rely on what is
written here. Anything not written here (the text for people, its spacing, its colours) may change.

`invincible`, the node's own command line, is a separate program and keeps its own commands, output and exit codes.

## Reaching a node

**Paired.** `inv pair <invite>` makes `inv` a client of a node on another machine, as a phone or a browser is.
- The node makes the invite: `invincible invite --client` there, or Settings → Devices in an app.
- `inv` shows a code of six digits. The node shows the same code for this device. Compare them before you approve.
- The owner approves it on the node, with `invincible approve <invite> <device>` (`invincible pairings` lists both), or
  in the waiting `invincible invite`, or in an app's Inbox.
- Once approved, `inv` signs every request with its own P-256 key, over (method, path, time, nonce, the body's hash),
  as the apps do (`packages/core/src/request-auth.ts`). It holds the scopes the invite gave it: by default, everything a
  phone may do.
- The key never leaves this machine:
  - on a Mac, it is kept in the login keychain (service `dev.invincible.cli`);
  - elsewhere, it is kept in `key.json`, mode 0600, beside the pairing;
  - `INVINCIBLE_KEYSTORE=file` keeps it in the file on a Mac too, which the tests use.
- The pairing is kept in `cli.json` under `$INVINCIBLE_CLI_HOME`, else `$XDG_CONFIG_HOME/invincible`, else
  `~/.config/invincible`. It holds the node's address, the fleet, this device's id and its name. It holds no secret.
- `inv pair` with no invite says what `inv` is paired with. `inv pair --forget` forgets the pairing and the key here.
  The node still lists the device until you revoke it there (`invincible revoke <device>`).

**On a node's own machine, unpaired,** `inv` talks to that node as `invincible` does: through its home (`--home <dir>`,
else `INVINCIBLE_HOME`, else `~/.invincible`) and its admin token, over loopback only.

**Which one.** A pairing wins over the local node. `--node local` uses the local node even when paired.

## Commands

Every command that prints a list or a result takes `--json`.

| Command | What it does |
|---|---|
| `inv` | The board: your agent's line, then NEEDS YOU, ACTIVE, WORKING and DONE, the nodes, and the cost today. In a terminal it is redrawn in place when the node's live stream says something changed, until Ctrl-C. Piped, it prints plain lines once. |
| `inv "…"` | Asks your agent, in a new chat kept in your history, and streams its answer. `--chat <id>` goes on in a chat. `--json` prints one answer object when it has finished. Ctrl-C stops the answer, as Stop does in the apps. |
| `inv give "…"` | Gives a task. It returns at once with the task's id, and the work goes on without the terminal. |
| `inv tasks` | Every task as a row, by attention. `--needs-you`, `--working` or `--done` shows one section (`--done` shows ACTIVE and DONE). `--project <p>` shows one project. |
| `inv watch <task>` | Attaches to a task: its steps fold as they finish, and one line says what it is doing now. Ctrl-C leaves and never stops the task. When the task ends, its proof is shown and `watch` exits with the verdict. |
| `inv peek <task>` | The task's last lines, or the approval it waits on. |
| `inv proof <task>` | The gates and the reviewer's verdict, framed apart from the agent's own words. The exit code is the verdict. |
| `inv stop <task>` | Stops a task. |
| `inv again <task> [--from <step>] ["…"]` | Gives a task again, as a new task: from its start, or from one of its steps (`--from`), its workspace as it stood then. New words replace its goal. |
| `inv asks` | What waits for your approval: each operation exactly, in mono, with any character you can't see made visible. |
| `inv allow <id> [--for-task]` | Allows one. `--for-task` also answers that agent's same call, exactly, without asking again, for a day (below). A task that an agent proposed is allowed to start. |
| `inv deny <id> ["why"]` | Denies one, with your reason. A task an agent proposed is declined. |
| `inv cost` | What the work cost, at your prices, against its budgets: today's and this node's model calls, and the tasks. `--task <id>`, `--agent <id>` or `--project <p>` narrows it. `--week` takes the last seven days. |
| `inv pair [<invite>] [--name <name>] [--forget]` | Pairs with a node, says what it is paired with, or forgets the pairing. |
| `inv help` | This list, briefly. |

**`inv give "…"` takes:**
- `--project <p>`: a project of yours. An agent that works in its repository takes it.
- `--agent <id>`: that agent takes it. Without `--agent`, the agent best suited to it takes it, and `inv` says who and
  why.
- `--gate "<command>"`, repeatable: done means this command passes in the agent's VM. Gates run before the work too, so
  a gate that already passes shows nothing about the work, and the proof says so.
- `--budget <usd>`: what its model calls may spend, at your prices. Past four fifths it wraps up, and at the budget it
  stops.
- `--on <node>`: only an agent whose VM is on that node takes it.
- `--wait`: blocks until the task ends, shows the proof, and exits with the verdict.
- `--stream`: prints the task's events as NDJSON until it ends, then exits with the verdict. Implies `--wait`.
- `--json`: prints one object: at once, `{"task", "agent", "room", "why"}`; with `--wait`, the proof.
- `--no-ask`: if the task comes to need you (an approval, a proposal, work cut short), `inv` stops it and exits 20, so
  nothing waits forever for a person. It implies `--wait`.
- `--timeout <duration>` (`90s`, `20m`, `2h`): with `--wait`, leaves when it runs out and exits 21. The task goes on.
- `--title "…"`: the task's title (its goal's start, otherwise).

**`--for-task`, as the node keeps it today:** besides allowing this call, `inv` signs a standing order for it. The order
covers the asking agent alone and this tool with these exact arguments, and it lasts one day, the shortest the node
keeps. It shows in `invincible order ls`, and `invincible order revoke <id>` ends it. An order bound to the task itself
comes with grants ("What comes later").

## The words

The rows, their words and the proof are the apps' own pure logic, imported from `apps/web/src/lib` (`work.ts`,
`steps.ts`, `now.ts`), never ported. So `inv` says exactly what the apps say:
- **A row's word:** Allow?, Approve?, Interrupted, Agent paused, Working · 4m, Queued, Verified, Not verified,
  Failed · gate 2, Failed, Stopped.
- **The sections:** Needs you, Active (a result new to you), Working, Done.
- **Your agent's name:** the node's to say (`whoami`'s `primaryName` when a node sends one), else "Invincible".

A terminal acts on what it is sent. So every name, title, command and line a model or a device wrote is printed as plain
text (`packages/core/src/plain.ts`). In `inv asks` and `inv peek`, a character that can't be seen is shown as
`⟨U+202E⟩`, and the count of them is said.

## Output

There are three layers:
1. **Text, for people.**
   - In a terminal: the state words in their colours (amber needs you, red failed, blue at work, green verified, grey
     queued or stopped), and the board redrawn in place.
   - Piped, or with `NO_COLOR`: plain lines, no escape codes, printed once.
   - Nothing moves at rest, there is no bell, and nothing blinks.
2. **`--json`:** one JSON object on stdout, and nothing else there. A list is an object holding an array
   (`{"tasks": […]}`).
3. **`--stream`:** NDJSON events on stdout, one object a line (below).

Errors go to stderr as `inv: <what went wrong>`. With `--json` or `--stream`, stdout also gets one object:
`{"error": "<what went wrong>", "exit": <code>}`.

**The objects `--json` prints:**
- **A row** (in `inv tasks` and the board): `{"id", "title", "section", "state", "word", "agent", "project", "detail",
  "age", "at"}`.
  - `section` is `needs`, `active`, `working` or `done`.
  - `state` is the row's state as the apps colour it (`needs`, `working`, `queued`, `failed`, `verified`, `paused`,
    `resting`).
  - `age` is how long since it last moved (`"12m"`), or null while it is at work.
- **`inv`:** `{"primary": {"name", "line"}, "needs": [rows], "active": [rows], "working": [rows], "done": [rows],
  "nodes": [{"name", "online", "self"}], "cost": {"todayUsd", "complete"}}`.
- **`inv tasks`:** `{"tasks": [rows]}`.
- **`inv asks`:** `{"asks": [{"id", "kind", "op", "inputs", "class", "by", "task", "why", "expires", "hidden"}]}`.
  - `kind` is `approval` (an operation waiting for your answer) or `proposal` (a task an agent proposed).
  - `hidden` counts the characters in it that can't be seen.
- **`inv give`:** `{"task", "agent", "room", "why"}`, or with `--wait` the proof.
- **`inv watch`, `inv proof`:** the proof.
- **`inv peek`:** `{"task", "state", "word", "lines": [{"n", "at", "text"}], "asks": [asks]}`.
- **`inv stop`, `inv again`, `inv allow`, `inv deny`:** `{"task"}`, or `{"id", "state"}` for an approval.
- **`inv cost`:** `{"since", "today": {"usd", "complete"}, "calls": {"usd", "complete"}, "tasks": [{"id", "title",
  "agent", "project", "usd", "complete", "budgetUsd"}], "total": {"usd", "complete"}}`.
- **`inv "…"`:** `{"chat", "turn", "model", "text", "stopped"}`.
- **`inv pair`:** `{"node", "fleet", "device", "name", "paired"}`.

## Exit codes

A promise: a code keeps its meaning, and a new one is added only with a new meaning.

| Code | Meaning |
|---|---|
| 0 | **Verified:** every gate passed, at least one of them failed before the work (so it shows the work was done), and a reviewer that didn't write it passed it. For a command that gives no verdict, it succeeded. |
| 1 | **An error:** the command couldn't be done (the node refused it, or no such task). Or a task ended in a way none of the codes below names: its agent gave up before any gate or review, or its run broke. |
| 2 | **Bad usage:** an unknown command or flag, or a missing or malformed argument. |
| 10 | **A gate failed:** the task ended with a gate that didn't pass. |
| 11 | **The reviewer rejected it:** every gate passed, and the reviewer sent it back until its revisions ran out. |
| 12 | **Finished without proof:** the reviewer passed it, but no gate shows the work: it had no gate, or only gates that already passed before the work. |
| 13 | **Stopped:** by you, by its budget, or by a rule of yours. For `inv "…"`, you stopped the answer with Ctrl-C. |
| 20 | **Needs you:** with `--no-ask`, it came to need you, and `inv` stopped it. For `inv proof`, it waits on you now. |
| 21 | **Still running:** `--timeout` ran out, or you left with Ctrl-C, and the task goes on. For `inv proof`, it has no verdict yet. |
| 30 | **Refused:** the pairing was refused, or this device's key is no longer enrolled (revoked), or it lacks the scope the command needs. |
| 31 | **The node is unreachable:** nothing answered at its address, or what answered wasn't the node (a proxy whose node is down). |

`inv watch`, `inv proof` and `inv give --wait` exit with the task's verdict. Every other command exits 0 when it did
what it says, or with 1, 2, 30 or 31.

## The proof

`inv proof <task> --json`, and the end of `inv give --wait --json`, print the proof:

```json
{
  "v": 1,
  "task": "task-8f2c0a91d3e4",
  "title": "Fix the flaky link sync test",
  "state": "verified",
  "exit": 0,
  "word": "Verified",
  "agent": "coder",
  "node": "ultra",
  "project": "invincible",
  "gates": [
    { "cmd": "bun test packages/link", "exit": 0, "ms": 41200, "before": 1, "failedBefore": true, "said": "38 pass" },
    { "cmd": "bun run typecheck", "exit": 0, "ms": 18900, "before": 0, "failedBefore": false, "said": "" }
  ],
  "review": { "verdict": "pass", "sameModel": false, "notes": 2 },
  "changes": { "files": 2, "artifact": "art_3hVZ0iW2kq6mJx0sY1aB4c" },
  "costUsd": 0.31,
  "costComplete": true,
  "budgetUsd": 2,
  "ms": 372000,
  "said": "Fixed the race in retry(); all tests pass."
}
```

- **`state`** is one of `verified` (0), `failed` (10), `rejected` (11), `unproven` (12), `stopped` (13), `needs-you`
  (20), `working` or `queued` (21), and `error` (1). `exit` is its code.
- **`word`** is the apps' word for the task, as its row says it.
- **`gates`** are as the latest round left them, from the runner's own lines on the task's trail, never the agent's
  account.
  - `exit` is null when a gate didn't run in that round.
  - `ms` is the time from the line before its result to its result.
  - `before` is how it exited before any work; `failedBefore` is whether that exit was non-zero.
- **`review`** is null when there was no review. `verdict` is `pass` or `revise`. `sameModel` says that no other model
  could review it, so the model that did the work reviewed it. `notes` is how many lines of notes it wrote.
- **`node`, `project`, `changes`, `costUsd`, `budgetUsd` and `ms`** are null when not known.
  - `costUsd` is at your prices and is a lower bound when `costComplete` is false.
  - It is known once the task has ended: the runner records its spend then.
- **`said`** is the first line of the agent's own report: its words, not proof.

Fields may be added; a field never changes its meaning or its type.

## Events (`--stream`)

One JSON object a line, each with `v` (1), `type`, `task` and `at` (ms). A reader ignores fields and types it doesn't
know. Fields and types may be added; none changes its meaning.

| `type` | Carries |
|---|---|
| `task.started` | `title`, `agent`, `room`, `node`, `project`, `budgetUsd`, `gates` (commands), `why` (why that agent) |
| `task.state` | `state` (queued, running, needs-you, …), `word` (the apps' word) |
| `step.started` | `n` (its line on the trail), `kind` (plan, read, edit, run, submitted, note), `text` |
| `step.completed` | `n`, `kind`, `text`, `exit` (a command's exit, or null) |
| `gate.result` | `phase` (`before` or `after`), `index` and `of` (from 1), `cmd`, `exit`, `ms` (null for `before`) |
| `review.verdict` | `verdict` (`pass` or `revise`), `sameModel`, `notes` |
| `approval.requested` | `id`, `op` (`connector.tool`), `inputs` (its arguments), `class`, `by` |
| `approval.decided` | `id`, `state` (approved, denied, expired, done, failed, lapsed) |
| `cost.update` | `usd`, `budgetUsd`, `complete` |
| `task.verified`, `task.unproven`, `task.failed`, `task.stopped` | `exit`, and `proof` (the object above). The last event when the task ends. |
| `left` | `reason` (`timeout`, `needs-you`, or `interrupted` for Ctrl-C), `exit`. The last event when `inv` leaves first. |

## What comes later

The first slice talks HTTPS with signed requests, as the browser does. Later:
- **Q-AMP as the transport,** with the CLI's key in the Secure Enclave on a Mac, signing by callback so it never leaves
  its chip.
- **Grants and peers:** `inv grants`, `inv grant`, `inv revoke` and `inv peers`, and `--for-task` as a grant bound to
  the task.
- **The diff pager:** `inv diff`, and `inv review` (←/→ files, ↑/↓ hunks, `i` a note back to the agent), and
  `inv ship`.
- **Keys in the board:** ↵ open, space peek, `a` allow, `d` deny, `g` give, and `inv watch`'s approvals inline.
- **The rest of §5 of the study:** `inv steer`, `inv logs`, `inv agents`, `inv projects`, `inv nodes`, `inv doctor`,
  and `--schema` for answers in a shape you give.
- **The installer's `inv`:** it still links `inv` to `invincible`. Until it installs this client, run it as
  `bun run inv` or `bun packages/node/src/inv/main.ts`.
