<picture>
  <source media="(prefers-color-scheme: dark)" srcset="assets/brand/invincible-dark.svg">
  <img alt="invincible" src="assets/brand/invincible-light.svg" height="44">
</picture>

**The node you own.** A self-hosted AI gateway: open models on your hardware, frontier models
only when you allow it, and a signed receipt for every call. It ships with **Autobot**, an agent
that works through it.

[Install](#install-vps-or-desktop) · [Code with Autobot](#code-with-autobot) ·
[The agent](#the-autobot-agent) · [Specifications](spec/) · [Releases](https://github.com/wckdboy/invincible/releases) · [Brand](BRAND.md)

```sh
curl -fsSL https://invincible.sh/install.sh | sh
```

Intelligence that never relies solely on frontier labs, corporations or countries. Install it on
hardware you own (a desktop, a GPU box, a rack in your hackerspace) and every device you own gets
one endpoint for intelligence. It runs open models itself, reaches frontier models when you allow
it, and keeps working when they are gone.

## Status

Early, and used daily. What is built, and what is not yet:

| Part | State |
| --- | --- |
| Gateway | Open models through llama.cpp behind OpenAI- and Anthropic-compatible APIs; every request through the routing rules ([spec/routing.md](spec/routing.md), 51 conformance vectors) |
| Privacy | Personal data redacted before anything leaves ([spec/redaction.md](spec/redaction.md)); a signed receipt per request ([spec/receipts.md](spec/receipts.md)); a hash-chained audit log ([spec/audit.md](spec/audit.md)) |
| Pairing | Devices pair over Noise ([spec/pairing.md](spec/pairing.md)): implemented, **not yet independently reviewed** |
| Discovery | Signed, expiring descriptors published to seeds and mDNS, so a node is found without a pasted code — and still only usable after pairing ([spec/discovery.md](spec/discovery.md)): implemented, unaudited |
| Cluster | **Phase 1, in review:** one model split layer-wise across your paired nodes through llama.cpp's RPC backend, inside encrypted shard links; `invincible cluster status`; receipts name the nodes ([spec/cluster.md](spec/cluster.md), with the plan for training across devices) |
| Autobot Agent | On the gateway on a VPS or desktop: coding in the terminal (images included) and in editors (Zed, over ACP), tools, approvals, a team, schedules, webhooks, several bots (live), Telegram, Discord, Slack, email, Signal, Matrix, WhatsApp, Home Assistant; backups and restore, health alerts to your chat, `autobot logs` |
| Autobot app | Android and iOS drive the agent through the paired node, approvals and schedules included, and show the node's receipts ([Autobot 1.10.0](https://github.com/wckdboy/autobot/releases/tag/v1.10.0)) |
| Releases | Static Linux and macOS binaries, reproducible, with build attestations, signed with a pinned key: stable from tags ([latest](https://github.com/wckdboy/invincible/releases/latest)), edge from every green commit on main; `invincible update` and a rerunnable installer; fixes from an internal security review are in, the independent review is still to come |
| Evals | 50 tasks from real code and 26 agent tasks, on local models and a frontier one (DeepSeek V3): 30/50 against 45/50 on the code tasks; every run kept, so the gap is followed over time |

Work is tracked in Plane (project **INV**). Invincible and Autobot are made by
[Sovware](https://sovware.io).

## Why

Today, capable AI is something you rent. A company, or the country it sits in, can change the
price, the policy, the model or the terms, read what you send, or switch you off. Open-weight models
and cheap accelerators make another path possible, but running them well is still a weekend of glue
per machine, and nothing ties them into the tools people actually use.

Invincible is that glue, with sovereignty as the design rule rather than a feature.

## The tiers

One interface, four places intelligence can run. If a tier disappears, things get slower, but
nothing breaks.

| Tier | Runs on | Owned by | Built by |
|---|---|---|---|
| **This phone** | NPU / GPU / CPU of the device in your hand | you | Autobot (shipping) |
| **My node** | your desktop, GPU box or server | you | **Invincible** |
| **Our region** | pooled nodes of people you trust: a co-op, a city, a country | your community | Invincible (federation, later) |
| **Cloud** | frontier and hosted providers | someone else | (their APIs) |

Autobot already covers the first tier and the last: on-device models, the phone-first cascade,
redaction before cloud calls, receipts and the kill switch. What it lacks is the middle: a machine
you own that is far stronger than a phone. Autobot's roadmap names it ("Pair your own devices … borrow
a desktop GPU as *my own cloud*", and "a `dsh` sidecar for desktop pairing"). **Invincible is that
middle tier**, and later the regional one.

## What a node does

1. **Serves open models.** It pulls open weights, verifies them by hash, picks an engine for the
   hardware (llama.cpp, MLX, vLLM / SGLang) and serves them. One command per model.
2. **Speaks the standard APIs.** OpenAI-compatible and Anthropic-compatible endpoints, so any tool
   works by changing one URL. Autobot gets a richer native protocol (below).
3. **Routes by policy.** Rules decide where each request runs: "tagged `private` never leaves
   hardware I own", "planning to frontier, bulk edits local", "if the cloud fails or is cut off,
   fall back to local". The defaults are local.
4. **Runs agents that never sleep.** Headless agent sessions with no battery, no background-task
   limit and the whole GPU: long recipes, overnight jobs, agents that work while the phone is off.
5. **Measures the gap.** An eval harness replays your real tasks against every model on every tier
   and shows which ones are good enough for which job. The scores drive routing; "how close is open
   to frontier" becomes a number you track instead of a feeling.
6. **Keeps the records you own.** Every request, route, model, token count and cost, in an
   encrypted local log. Nothing is reported anywhere.

### Not in v1

A chat UI, identity systems, federation between strangers. Each may come later or become its own
project. Training (LoRA fine-tuning on your devices, then across them) is planned in
[spec/cluster.md](spec/cluster.md).

## Deep integration with Autobot

Invincible is built for Autobot first, and shares its rules instead of re-implementing them.

| Autobot today | With an Invincible node |
|---|---|
| Providers: presets with API keys (`ProviderPresets`) | A new **"My node"** provider kind, added by **pairing** (QR code, Noise handshake), never an API key |
| Cascade: phone → cloud (`CascadePolicy`) | Phone → **node** → cloud. "Never" means "never beyond hardware I own", and the node counts as owned |
| Network policy: Offline / Direct / Tor / SOCKS5, kill switch, audit log | The node is reached over LAN, WireGuard / Tailscale or a Tor onion service; its requests appear in the phone's audit log, and the node's own egress log is viewable from the phone |
| Data policy per model (`ModelDataPolicy`) | Node models read as **owned · zero retention**, and the claim is checkable: it's your machine |
| Redaction before cloud calls | Phone → node needs no redaction (you own both ends). Node → cloud passes the same redaction gateway, running a larger detection model than a phone can |
| Receipts per answer | The node signs a receipt per request (tier, model, engine, tokens, whether anything left the node); Autobot merges it into its own receipt |
| Recipes: on-device only, 8-minute limit | Recipes can be **handed to the node**: always on, no time limit, results delivered to the phone |
| Private vault (on-device RAG) | The vault can sync end-to-end encrypted to the node for larger indexes and faster embedding; the index still never leaves hardware you own |
| `:agent:core` (Kotlin Multiplatform, JVM + iOS) | The **Autobot Agent** (`autobot`, Rust) runs next to the gateway with the same semantics (session log, tool loop, fail-closed approvals); next, the app drives it through the paired gateway |

### One set of rules, two languages

The node is written in **Rust**: one static binary, no runtime to install, a small attack surface
for the process that holds your keys and faces the network. Autobot stays Kotlin Multiplatform.

Because the two cannot share code, they share a **spec** instead. `spec/` in this repo is the source of
truth for everything both sides must agree on:

- **Node protocol:** pairing handshake, the native API Autobot speaks, receipt format.
- **Policy semantics:** routing and cascade decisions, data-policy labels, redaction rules, kill-switch
  behaviour ([spec/egress.md](spec/egress.md): an outbound request blocked, sent direct or through
  Tor or SOCKS5; loopback always direct, so a local backend is reached even behind Tor).
- **Conformance vectors:** input → expected output cases in plain JSON. Invincible's Rust tests and
  Autobot's Kotlin tests both run them (Autobot copies them in with `scripts/sync-invincible-spec.sh`,
  which records the commit they came from), so a rule change that only lands on one side fails CI on
  the other. Autobot runs the pairing, Noise, receipt, redaction and egress vectors; routing is decided on
  the node alone (the app sends node requests to it), so only Invincible runs those.

A privacy fix starts as a spec change with a new vector, and neither side is done until both pass it.

### Pairing, in short

1. `invincible pair` on the node shows a QR code (the node's static public key plus addresses).
2. Autobot scans it; the two complete a Noise handshake and pin each other's keys.
3. The node appears in Autobot under Providers as **My node** with its live model list.
4. Unpairing from either side revokes the key. A panic wipe on the phone forgets the node.

There are no accounts, no passwords and no third-party relay.

## Architecture (proposed)

```
 Autobot (Android / iOS)     Autobot Agent (autobot)        other tools (any OpenAI / Anthropic client)
        │ Noise channel        │ terminal · Telegram            │ HTTPS + local token
        │                      │ tools, approvals, sessions     │
        └───────────────┬──────┴────────────────────────────────┘
               Invincible Gateway (invincible, the node)
   pairing · policy router · receipts · audit log · evals                       (Rust)
        │                    │                         │
  engines (child processes)  frontier providers         other nodes (later: region tier)
  llama.cpp · MLX · vLLM     through redaction + route
```

- **Control plane:** Rust, a single static binary (`invincible`). It follows `spec/` and is checked
  against the same conformance vectors as Autobot.
- **Engines:** separate processes that the control plane supervises, never linked in. A crashing
  engine cannot take the node down, and engines can be swapped freely.
- **Hardware:** local-grade Apple silicon and NVIDIA machines. llama.cpp is the v0 engine on both
  (Metal on Apple silicon, CUDA on NVIDIA), so one engine and one model format cover every node.
  MLX (Apple) and vLLM (NVIDIA) follow as optional faster engines behind the same interface.
- **Storage:** encrypted at rest; keys in the OS keychain or a TPM / Secure Enclave where present.
- **Network:** listens on loopback and paired interfaces only; nothing is exposed to the open
  internet by default; optional Tor onion service for reaching home from anywhere.

## Install (VPS or desktop)

macOS (Apple silicon) or Linux (x86_64, arm64), no root needed:

```sh
curl -fsSL https://invincible.sh/install.sh | sh
autobot setup        # network, model, cloud models, agent, Telegram, background services
```

It puts `invincible` (the gateway) and `autobot` (the agent) in `~/.local/bin` and llama.cpp
where it is missing. Run it again any time: it converges. The same version downloads nothing,
another one replaces the binaries atomically and restarts the running services, and your config
and data are never touched. Piped like this it asks nothing; `autobot setup` asks the questions.

| Flag (after `sh -s --`) | |
| --- | --- |
| `--channel stable\|edge` | stable: tagged releases (default). edge: every commit on main that passed CI |
| `--version 0.0.11` | that release, also to go back |
| `--prefix DIR` | binaries in `DIR/bin` (default `~/.local`) |
| `--no-service` | leave the background services alone |
| `--yes` | yes to everything, sudo installs of build tools and bubblewrap included |
| `--uninstall` | remove the binaries and the services; keep the data (`--purge` removes it too) |

```sh
curl -fsSL https://invincible.sh/install.sh | sh -s -- --channel edge --yes
```

**Updating.** `invincible update` (or `autobot update`) installs the newest release of the channel
you are on, checked exactly as the installer checks it, and restarts the services. `--check` only
says whether there is one, `--channel edge` switches, `--version 0.0.11` goes back. Nothing checks
for updates unless you ask (no phoning home), or turn on the daily update:
`invincible update --auto stable` (or `edge`, or `off`), which sets `[update] auto` in
`~/.invincible/config.toml` and installs a daily job (a launchd calendar job, a systemd timer).
Edge builds say what they are: `invincible --version` prints `0.0.12-edge.1a2b3c4`.

**24/7.** `autobot setup` (or `autobot service install`) runs the gateway and the agent as
launchd agents on macOS, systemd user units on Linux (with linger, so they outlive your SSH
session) or systemd system units when installed as root on a VPS. They start at boot, restart
whenever they exit, and restart themselves when their health check (`GET /healthz`) stops
answering for 3 minutes (also systemd's `WatchdogSec`). The agent waits for the gateway and picks
it up again after a restart. Logs are in `~/.invincible/logs/` and `~/.autobot/logs/`, each capped
at 16 MiB with one old copy. `autobot service status` says whether each runs, starts at boot and
how it last stopped; `autobot doctor` ends with a **24/7 readiness** section: the services, linger,
whether the Mac sleeps (`sudo pmset -a sleep 0` keeps it awake), disk space, the gateway, the
models, the agent API, clock sync and the update channel. `autobot logs` prints the last lines
of the agent's log (`gateway` or `update` for the others; `-n 200`, `--grep warn`, `--follow`).

**Alerts.** While `autobot serve` runs, it tells you on a channel the bots already use when it
was started again after a crash (it stopped without shutting down: a panic, the watchdog, a
kill), the gateway has not answered for a minute, a model backend fails its health checks, the
disk runs low, a scheduled task, the heartbeat or a scheduled backup fails, and when an update is
available or was applied. A problem that goes away says so. The same alert goes at most once in
`repeat`, at most `per_hour` go in an hour (the next one says how many were held back), and in
quiet hours they wait and go together when those end. With no `to`, they go to the home channel
(`/sethome`). A failed task's alert skips the place its own answer already went.

```toml
[alerts]                          # in ~/.autobot/config.toml
to = ["telegram:123456", "email:me@example.org"]   # any channel address; [default: the home channel]
events = ["crash", "gateway", "backend", "disk", "job", "backup", "update"]   # [default: all]
quiet_hours = "23:00-07:00"
repeat = "6h"
per_hour = 10
disk_free_gib = 2                 # 0: no disk alerts
update_check = "1d"               # `invincible update --check` this often; "off"
```

`autobot alerts` says where they go and lists the latest (sent, held, or why not);
`autobot alerts test` sends one now through the running service, whatever the limits say, and
says how each address went.

**Backups.** `autobot backup` writes the whole agent home to one `.tar.gz` (plain tar, so `tar
tzf` lists it): the configuration, personas, skills, conversations, memory, the recall index,
who may use the bots, every bot's own directory, and a `MANIFEST.json` with each file's size,
mode and SHA-256. Secrets (`*.token`, `*.password`, `*.secret`, `*.key`, `*.pem`, `.env`,
`secrets/`) stay out unless you add `--include-secrets`, and the summary lists the ones left
out; logs, the working directory (`work/`), backups, downloaded speech models and links stay out
always. The file is readable by you only. The gateway's own home (`~/.invincible`: its token,
paired devices, receipts) is not in it.

`autobot restore FILE` checks every file against the manifest before it touches anything, lists
what is new, changed and gone, asks (`--yes` not to, `--dry-run` to stop there), builds the new
home beside the old one and swaps it in. What the backup does not cover stays as it is: the
secrets it left out, `work/`, the logs. The old home is kept as `~/.autobot.before-restore-<time>`;
move it back to undo. Restart the service afterwards (`autobot service restart`).

```toml
[backup]                          # scheduled, while `autobot serve` runs
every = "1d"                      # [default: off]
keep = 7                          # the newest 7; older ones are removed
dir = "~/backups"                 # [default: ~/.autobot/backups]
secrets = false
```

```sh
autobot              # chat in the terminal
autobot code         # code in this directory (see "Code with Autobot")
autobot run "task"   # one task, no questions: anything not allowlisted is refused
autobot doctor       # check everything, 24/7 readiness included
```

**What is checked.** Every release's `SHA256SUMS` (the archives and `VERSION`) is signed with
the release key, which lives only as a GitHub secret; the installer and `invincible update` pin
its public key and refuse anything else, then check the archive against the list. With a
signed-in GitHub CLI the installer also checks the archive's Sigstore build attestation. Releases
are built by [`release.yml`](.github/workflows/release.yml): a `v*` tag publishes stable, every
green push to main refreshes the `edge` prerelease. The Linux builds are reproducible: the
workflow builds the x86_64 archive again on another machine and publishes only if the bytes match
(to check one yourself, build the commit from `/tmp/invincible-src` with the flags in
`release.yml`). By hand:

```sh
echo 'invincible-release ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAII/0fXPq1j51BcfGY0Jp9QfPGy6kHVQQ+W282VFPR/Qo' > allowed_signers
ssh-keygen -Y verify -f allowed_signers -I invincible-release -n invincible-release -s SHA256SUMS.sig < SHA256SUMS
shasum -a 256 -c SHA256SUMS
gh attestation verify invincible-linux-x64.tar.gz --repo wckdboy/invincible
```

Without a release for the machine, or with `INVINCIBLE_FROM_SOURCE=1`, the installer builds from
source (Rust from rustup if there is none).

## Code with Autobot

`autobot code` works on the project in the current directory, next to Claude Code or opencode,
with its model behind your own gateway: every call receipted and in the audit log, cloud use
confirmed once per session, private work on local models.

```sh
cd ~/src/my-project
autobot code --model anthropic --approvals edits   # the first time
autobot                                            # after that, in any git repository
```

Naming a provider the gateway does not have yet (`anthropic`, `deepseek`, …) sets it up there and
then: the key is asked for (not shown), added with `invincible cloud add`, and the gateway
service restarted. The model and approvals are remembered (`~/.autobot/code.json`), and plain
`autobot` in a git repository is `autobot code`.

- **The terminal:** your scrollback stays your terminal's own (no alternate screen); only the
  bottom is drawn in place: a composer in a box, and under it a status line with the model (and
  what `auto` chose), approvals, project and branch, how full the context is, and the tokens so
  far, with what the keys do now on the right. Answers stream in as Markdown wrapped to the
  width (headings, lists, quotes, aligned tables, code blocks with their language and a light
  tint). Each tool call is a step (`▪ Read src/main.rs`, `▪ Run cargo test`) with what it gave
  back hanging under it (`└ 3 matches in 2 files`, the last lines of a command and its exit
  code, `… N more lines`); while it runs, a spinner and its seconds stand in for the `▪`, and
  while the model thinks, the end of its reasoning shows beside the spinner. Every change shows
  as a colored diff with line numbers before it is made; the agent's task list (`todo`) shows as
  checkboxes; a `─` footer ends each turn with the models, tool calls, tokens (and how many were
  cached) and time. Approvals are a card above the composer that takes one key: `y`, `a`
  (always, this session), `n`, or `e`: no, and tell it what to do instead (typed in the
  composer, Enter sends it with the refusal, esc goes back to the keys); any other key is no.
  The window's title says `autobot · <project>` while it runs (and is put back after). When a
  turn that took more than 10 seconds ends, or a question waits, and the window is not in front,
  the terminal tells you: a desktop notification in iTerm2, Ghostty, WezTerm and kitty, the bell
  elsewhere (`[terminal] notify = "auto"`, `"bell"` or `"off"` in the config). Without a
  terminal (a pipe, a script) it reads plain lines and prints plain text (a question takes `y`,
  `a`, `n` or `e what to do instead`); `NO_COLOR` turns color off.
- **Steer while it works:** type while the agent works; Enter hands your words to the agent
  before its next step ("use the existing helper instead"), and what arrives as it finishes
  becomes the next request. A `/command` or `!command` sent then runs when the turn ends. Esc
  (or ctrl+c on an empty composer) stops a turn; the conversation stays usable.
- **Keys:** Enter sends; shift+enter (in terminals with the kitty keyboard protocol: kitty,
  Ghostty, WezTerm, iTerm2, foot), alt+enter or ctrl+j starts a new line (so does a `\` at the
  end of a line); ↑/↓ bring back what you sent (or move between lines); ctrl+r searches what you
  sent as you type (`search: …` in the status line; ctrl+r again for older matches, Enter keeps
  the match to change or send, esc puts back what was there); ctrl+a/e start and end of line,
  ctrl+w/u/k delete a word, to the start, to the end (ctrl+y puts it back), alt+b/f move by
  words; ctrl+l clears the screen; ctrl+z suspends; ctrl+c clears the composer, and twice on an
  empty one quits, as does ctrl+d. A long paste folds into `[pasted 120 lines]` and goes out in
  full. `/help` lists the keys too.
- **Images:** show the agent a screenshot or a design. Drag the file into the terminal (it
  pastes the path; one or more PNG, JPEG, WebP or GIF files, quoted, escaped or as `file://`
  URLs, become images), paste one with ctrl+v (macOS: `pngpaste` if installed, else
  `osascript`; Linux: `wl-paste` or `xclip`; kept in `~/.autobot/attachments`), type
  `/image <path>`, or `@shot.png` for one in the project (the `@` list tags images). In the
  composer an image is a token, `[image 1: shot.png 1280×720]`, that backspace deletes whole; it
  goes out as an OpenAI-style image part beside your text, scaled down to 1568 px on its longest
  side (PNG with transparency, JPEG otherwise) when bigger. Only a model that can see takes
  them: `/model` lists them as the gateway reports (`vision` in `/v1/models`), and with one known
  not to (a local model without a projector, `deepseek-chat`) the message is not sent: `✗ qwen3
  can't see images; /model to pick one that can`, with your message back in the composer. The
  conversation keeps each image's path, SHA-256 and size, never its bytes; while the message is
  in the window the image goes with every call, read from its file, and when the file is gone or
  changed a note goes instead (`[image 1: shot.png] not sent: no longer on disk`). `/resume`
  shows the last requests with their images (`[image: shot.png]`, `· gone` when the file is
  not there). Without a terminal, `/image <path>` attaches to the next line.
- **The project:** its `AGENTS.md`, `CLAUDE.md`, `HERMES.md` (or `.hermes.md`, Hermes Agent's)
  and `.autobot/AGENTS.md` become part of the agent's instructions (`.cursorrules` where there
  is none of those), from the repository's root down to the directory it works in, each text
  once. A subdirectory's own `AGENTS.md` (a package in a monorepo) comes with the first tool
  result that reaches that directory, once per conversation (a write or an edit there waits for
  it), and a restart does not give it again (`sessions/<id>.context.json`). Every file is
  scanned first: one with text that looks like a prompt injection (ignore the previous
  instructions, keep this from the user, send the keys somewhere, a hidden comment with orders, invisible
  characters) is quarantined, not dropped: the model gets it quoted as data under a note saying
  what was found, and `/context` marks it. `/context` lists the files in
  play. In a git repository it works like a careful engineer (find, read, change
  in small edits, run the build and tests, never commit unless asked). `search` (regular
  expressions over the files, `.gitignore` respected) and `find_files` (globs) find code without a
  shell command to approve; `read_file` reads long files in parts.
- **Control:** `edits` approvals let changes in the project run without asking (commands still
  ask); `/undo` puts back every file the last turn changed and hands its request back to edit.
  `@path` attaches a file (typing `@` lists the project's files, matched as you type; tab
  completes), `!command` runs one yourself and hands its output to the next message.
- **Commands:** typing `/` opens a list of them with a line about each, narrowed as you type
  (↑/↓ or tab to choose, Enter runs, esc closes): `/model` (alone, a list of the gateway's models
  to pick from as you type; or switch: `/model deepseek`; a cloud model lets turns leave the
  machine, and the conversation sent per call grows with its context), `/approvals`,
  `/private`, `/tools`, `/context`, `/diff`, `/undo`, `/status`, `/new`, `/fork`, `/sessions`,
  `/resume` (alone, the recent conversations with what each is about and when, to pick from),
  `/image <path>` (show it an image),
  `/copy` (the last answer's Markdown onto the clipboard, through the terminal: OSC 52, passed
  through tmux), `/memory`, `/profile`, `/personality` (alone, a list to pick from; for this
  conversation), `/skills` (alone, a list of skills to run; `/skills accept <name>`), `/team`,
  `/board`, `/help`. One conversation per project (`code-<name>-<hash>`).
  `/retry` runs the last request again without its answer (files it changed stay; `/undo` puts
  them back); `/stop` is esc, typed; `/new` (or `/reset`) starts over. `/usage` shows the tokens,
  time and cost of this conversation and of today; `/insights [--days N]` what the agent did:
  turns, the tools it used, projects, failures, and how much ran on your own hardware.
  `/init` has the agent write (or improve) the project's `AGENTS.md`; `/compact` folds the
  conversation so far into a summary, keeping the last turn; `/ps` shows background processes
  (`/ps 2` its output, `/ps stop 2`).
- **Skills as commands:** every skill is a command too: `/deploy staging` sends the skill's
  instructions with what you typed after it; the `/` list has them as `skill: …`.
- **Your own commands:** a Markdown file is a slash command: `.autobot/commands/review.md` in the
  project (or `~/.autobot/commands/`) is `/review`, its text the prompt, `$ARGUMENTS` (or `$1`…`$9`)
  what you type after it; a subdirectory makes a prefix (`git/pr.md` is `/git:pr`), and a
  `description:` in front matter shows in `/help`. Commands in `.claude/commands` work as they
  are, so a project's Claude Code commands come along. `/commands` lists them; the `/` list has
  them with the rest.
- **Servers and watchers:** the agent starts what keeps running (`npm run dev`, `cargo watch`, a
  test database) with `terminal` and `background: true`, then reads its new output, waits for it
  or stops it with the `process` tool; stopping takes its whole process group. They end with the
  session.
- **Big jobs:** coding turns get at least 100 steps; an `explorer` team member takes read-only
  research (where is this used, how does that work) in a fresh context and answers with
  file:line references, so the main conversation keeps what it found and not every file it
  read; reads in one reply run at the same time.
- **From other tools:** `autobot run -C DIR --model M --approvals edits --cloud "task"` does one
  task with nobody to ask (`--cloud` confirms cloud use for that run, nothing else); `--json`
  prints every event as a JSON line (text, tool calls, outputs, diffs, receipts) and the answer
  last, so Claude Code, opencode or a CI job can hand Autobot work and read what it did.

### In your editor: Zed and other ACP editors

`autobot acp` is Autobot as an editor's agent, over the
[Agent Client Protocol](https://agentclientprotocol.com) (version 1, on standard input and
output). In Zed, add it to `settings.json` and pick **Autobot** in the agent panel's new-thread
menu:

```json
{
  "agent_servers": {
    "Autobot": {
      "type": "custom",
      "command": "autobot",
      "args": ["acp"],
      "env": {}
    }
  }
}
```

(Use the full path, `~/.local/bin/autobot`, if Zed does not find it on its `PATH`; add
`"--bot", "ops"` to the args for another bot.) It works as `autobot code` does in the folder Zed
opened, with the same gateway, model, receipts and memory:

- **What you see:** the answer and its reasoning stream into the thread; each tool call is a
  card with what it does, an edit shows as Zed's own diff before it is made, and the agent's
  task list is Zed's plan.
- **Approvals:** what your approval mode asks about becomes Zed's permission prompt: allow once,
  always allow (for the session), or reject. The modes are the approval modes (`ask`, `edits`,
  `allowlist`, `trust`), switched from Zed's mode menu; the model is picked there too, from
  the gateway's models.
- **Files and commands through the editor:** reads and edits go through Zed's open buffers
  (unsaved changes included), so the agent's edits land in the editor and its undo. Commands
  run in Zed's terminal, shown in the tool call, when they run on this machine (in its
  container, the sandbox or over SSH they run there, as configured).
- **MCP servers:** the servers configured in Zed (stdio and HTTP) add their tools beside
  Autobot's own `[mcp]` servers.
- **Commands:** `/help`, `/context`, `/recall …`, `/retry`, `/compact`, `/usage`, `/status` and
  the rest, your own commands and your skills (`/<skill> what for`) are in Zed's `/` menu.
- **Voice:** a spoken prompt is transcribed with the node's speech-to-text (`[voice]`), when
  it has one.
- **Sessions:** each thread is an Autobot conversation (`acp-…` in `~/.autobot/sessions`); Zed
  can load one again, and the stop button cancels the turn where it is.

## The Autobot Agent

The same agent as on the phone, for a machine that is always on. It is written in Rust
([`crates/autobot`](crates/autobot)) and uses the gateway on the same machine as its only model
provider, so the gateway's rules hold for every agent turn: routing, redaction, receipts.

- **Tools:** `terminal` (a shell command in the working directory, with a timeout that stops
  what it started too, the start and end of its output kept, or left running in the background;
  `process` reads, waits for or stops it; `autobot serve` stops them when it stops), `read_file`,
  `write_file`, `edit_file` (replace an exact piece of a file), `list_dir`, `web_fetch` (a page as
  text, through the gateway: under the node's network mode, so offline means no fetch and Tor
  carries it; HTTPS only; receipted and in the audit log; it asks first, and unattended runs may
  fetch only sites in the allowlist, written `https://docs.rs`), `search` and `find_files`
  (ripgrep's walker: `.gitignore` respected), `todo` (its task list for a longer job). Results
  are cut to a size small local models can take, larger for models with large contexts
  (`[agent] context_kib`, or set by `/model`). Answers stream (`[agent] stream`).
- **Under a model that misbehaves:** `edit_file` forgives line-end spaces, `\r\n` and a block
  indented differently when that finds one place, and a miss shows the closest lines; malformed
  tool arguments are read as meant where that is safe, and errors say what the tool takes. The
  same call with the same result is pointed out at the third time in a turn and ends the turn at
  the sixth (a wait, such as `sleep` or `process wait`, at the twelfth).
  A turn longer than the context clears its older tool results (in batches, so a prompt cache
  keeps most of each request); a "context exceeded" error sends less and summarizes, and later turns with the model the router
  chose start at the size that fit. Gateway
  calls are tried again after a restart, a 429 or a 5xx (not once an answer has started to show);
  a command runs without a terminal (a password prompt fails at once) and, when it hangs or the
  agent stops, is stopped with what it printed, and what it started goes with it.
- **Scripts that use the tools:** `execute_code` runs a short Python 3 (or `sh`) script, asked
  for like a command with its code shown and run where commands run (sandboxed when confined,
  in the container, over SSH). In it, `search`, `read_file`, `find_files`, `list_dir`,
  `search_sessions`, `read_skill` and `web_fetch` are functions, so twenty searches and reads
  cost one step and only what the script prints comes back. They talk over the script's own
  stdin and stdout; reads outside the working directory are refused, a fetch is asked for like
  any fetch, at most 200 calls per script.
- **A browser:** where Chrome, Chromium, Edge or Brave is installed (or `AUTOBOT_BROWSER` names
  one), the `browser` tool drives it headless over the DevTools Protocol, for pages that need
  scripts, a login or a form, and for a dev server: `navigate`, `text`, `snapshot` (what can be
  clicked or typed into, numbered), `click`, `type`, `submit`, `screenshot`, `close`. A new site
  asks first, like a fetch (the URL allowlist and "always" cover a site); typing into a page and
  submitting a form ask every time and are refused unattended; a click never submits a form or
  follows a link to another site. Its traffic follows the gateway's network mode (Tor or SOCKS5
  as its proxy; nothing but loopback while offline); it is not receipted. A screenshot goes to
  a model that can see as an image, and stays in `~/.autobot/attachments`. One browser per
  process, with a throwaway profile (a minute allowed for a cold start), closed with the session
  or after ten idle minutes;
  `[agent] browser = false` turns it off.
- **MCP servers:** any [Model Context Protocol](https://modelcontextprotocol.io) server over stdio
  adds its tools (`<server>__<tool>`), each call asked for like a command, logged, and allowed
  unattended only with `mcp:<server>/<tool>` in the allowlist:

  ```toml
  [mcp.github]
  command = "npx"
  args = ["-y", "@modelcontextprotocol/server-github"]
  env = { GITHUB_PERSONAL_ACCESS_TOKEN = "…" }
  tools = ["search_repositories", "get_issue"]   # optional: only these
  ```
- **Approvals** (`[approvals]` in `~/.autobot/config.toml`):
  - `ask` (default): commands, file writes and reads outside the working directory ask first:
    yes, always for this session, or no.
  - `edits`: like `ask`, but writes and edits in the working directory (not under dot names) run
    without asking; each is shown as a diff, and `/undo` puts it back. For coding.
  - `allowlist`: for unattended use. Allowlisted commands and writes in the working directory run;
    everything else is refused without asking. An allowlist entry matches the whole command or the
    command plus arguments, never a chained one (`git status; rm -rf ~` does not match
    `git status`). Arguments are not checked: an allowlisted `cat` reads any file you can, so
    allow only commands that are safe with any arguments. Writes never follow symbolic links or
    touch hard-linked files, and writes under dot names (`.git/config`, `.envrc`) always ask,
    since they can make a later allowlisted command run something else.
  - `trust`: everything runs. Only for a machine you can throw away.
- **Sandbox:** commands with nobody watching (scheduled tasks, board work, phone recipes) run
  sandboxed: they read what you can, but write only in the working directory and temporary
  directories (macOS `sandbox-exec`; Linux `bwrap`, i.e. bubblewrap, which `install.sh` users
  may need to install). Without a sandbox they are refused, not run unconfined.
  `[agent] sandbox = "always"` confines interactive turns too; `"off"` turns it off.
- **Commands in a container:** on a VPS, `[agent.docker]` runs the agent's commands in a Linux
  container instead of on the host: one per working directory (`autobot-<hash>`), made on first
  use and kept, with the working directory mounted at the same path, so file tools and commands
  see the same files while whatever a command installs or breaks stays in the container
  (`docker rm -f` it to start over). `autobot doctor` checks it.

  ```toml
  [agent.docker]
  image = "rust:1.91"      # any image with sh
  network = "bridge"       # or "none"
  args = ["--memory", "4g"]
  ```
- **Commands on another machine:** `[agent.ssh]` runs the terminal and the file tools on a
  machine you reach with `ssh`, in a working directory there: a build box, a GPU machine, the
  server you are fixing. It uses the system's `ssh` with one shared connection (ControlMaster,
  kept ten minutes), never prompts for a login (BatchMode: a key the ssh agent or
  `~/.ssh/config` gives), stops a command there after its timeout, and never writes through a
  link. Diffs come from the file there; files there have no `/undo`. Search uses ripgrep there
  when it is installed, `grep -E` otherwise. `autobot doctor` checks it.

  ```toml
  [agent.ssh]
  host = "me@build-box"      # or a Host from ~/.ssh/config
  workdir = "/home/me/work"  # default: the same path as here
  ```
- **Private by default:** agent turns carry `invincible-private`, so the router keeps them on local
  models; tool results carry your files and command output. With `[gateway] private = false` the
  router may use cloud models, and when its rules want a confirmation, the agent asks you.
- **Heartbeat:** put a checklist in `~/.autobot/HEARTBEAT.md` ("is the disk over 90%?", "did
  last night's backup run?") and every 30 minutes (`[agent] heartbeat`, or `off`) the agent works
  through it, unattended and sandboxed, and messages you on Telegram only when something needs
  you; a quiet check stays quiet.
- **Trajectories:** with `[agent] trajectories = true`, every finished turn is kept as the model
  saw it (system prompt, tool list, calls, results, answer) in `~/.autobot/trajectories`, as
  fine-tuning data for a local model; `autobot trajectories` counts them and exports them
  (`--clean`, `--model`, `--since`, `--agent`; `--format openai` or `sharegpt`).
- **Fork a conversation:** `POST …/sessions/{id}/fork` starts a new one as the old one was, up to
  a point, to try another direction without losing the first.
- **Steer while it works:** a message you send while a turn runs (Telegram, or the app with
  `POST …/steer`) is taken in before the agent's next step, so "use Markdown instead" changes the
  work in progress rather than waiting for it to end.
- **Sessions:** one JSONL file per conversation in `~/.autobot/sessions`. Each model call gets the
  recent part (at most about 12k tokens, so small local models keep room to think); what falls out
  of it is summarized on the gateway like any call, and the summary leads the next prompt, so a
  long conversation is condensed, not forgotten. It is summarized in batches, once an eighth of
  that budget has fallen out (until then the recent part keeps it), so a long conversation costs
  one summary call every few turns, not one every turn.
- **Who it is:** `~/.autobot/SOUL.md` is the agent's character, in every conversation (tone,
  directness, how it disagrees). On top of it, a **personality**: four are built in (`concise`,
  `technical`, `teacher`, `creative`), and a Markdown file in `~/.autobot/personalities/` is one
  of yours. `autobot personality list|show|set <name|none>` picks the one in use; `/personality`
  picks one for a conversation; the app sends `personality` with a turn or sets it. Both come
  after the agent's working rules in its instructions: they change how it answers, never what it
  may do.
- **Memory:** the agent keeps short facts with `remember` (your preferences, where things are,
  decisions) in `~/.autobot/memory.jsonl`, and every later conversation starts with them, newest
  first. `autobot memory` lists them; `autobot memory --forget 3` removes one. Never secrets:
  a fact with a key, a token, a password or personal data (an email, a phone or card number) is
  refused.
- **How you work:** `~/.autobot/USER.md` is the agent's short profile of you (preferences, your
  tools, how you want answers), at most 2000 characters, kept with `update_user_profile`: one
  small change at a time (add, replace, remove), shown to you as a diff, checked like memory.
  Every eighth turn of a conversation (`[agent] nudge_every`, 0 for never), in the terminal, in
  a chat on any platform and through the API, a short extra call, as private as the turns, looks
  back for what is worth keeping. It runs in the background, at most one a minute per bot. In the
  terminal a faint line says what it kept (`↳ kept profile: …`), and the API's turn stream ends
  with a `kept` event; a chat gets no message about it (the serve log has a line).
  `autobot profile` (or `/profile`) shows it; edit the file as you like.
- **Skills:** how-to notes for the agent in `~/.autobot/skills/`, in the
  [agentskills.io](https://agentskills.io) format: a directory per skill with a `SKILL.md`
  (front matter with `name`, `description` and optionally `allowed-tools`, shown but never
  granted: approvals hold) and any files it needs beside it (scripts, references); a plain
  `<name>.md` is a skill too. The agent sees their names and descriptions, and reads one (or one
  of its files) with `read_skill` when it fits the task. `autobot skills search pdf` looks in the
  hub: [skills.sh](https://skills.sh), the public directory of skills in this format
  (agentskills.io itself is the specification and has no index), else GitHub repositories with
  the `agent-skills` topic. `autobot skills install pdf` (a name, `owner/repo/skill` or
  `owner/repo`) fetches the skill's directory from GitHub and shows where it comes from, its
  files (scripts marked) and its SKILL.md in full, and installs it only when you say yes
  (`--yes` after reading). Nothing in it runs: files are written plain, and a script is
  something the agent may ask to run like any command. The hub follows the node's network mode.
  Every review carries a scan of the skill's files (scripts that download and run code, read
  keys or send them away, delete beyond the skill, start themselves at login, open a shell to
  somewhere; text in its Markdown that looks like a prompt injection) and its trust level:
  `official` (Autobot's own, or the format's authors), `known publisher` (an organization
  publishing skills for its own product), `community` (anyone else), `local` (from a path or a
  git URL). With `--yes`, a skill the scan calls dangerous from anyone but an official source
  needs `--force` too. An install is pinned (`.source`: repository, commit, the directory's tree,
  a digest of its files): `autobot skills check` says which skills changed upstream and which you
  edited here, `autobot skills update [name]` shows what an update changes (files added, removed
  and changed, SKILL.md's diff, the scan) and replaces the skill when you say yes (an edited one
  is left alone under `--yes`), and `autobot skills audit [name]` scans what is installed.
  `autobot skills install <git-url|path>`
  adds the skills in a repository or directory (regular files only, never over one you have),
  `autobot skills` lists them, `autobot skills uninstall <name>` (or `remove`). The agent writes skills itself:
  after a task that took many steps and worked, `create_skill`; when a skill it followed was
  wrong, `improve_skill`, shown to you as a diff. Neither is used until you keep it
  (`autobot skills accept <name>`, `/skills accept <name>` in the terminal or Telegram, or the
  app), since a skill is instructions the agent will follow.
- **Usage and insights:** every turn of the main agent, on any channel, goes into
  `~/.autobot/turns.jsonl`: its model calls with their models, tiers and tokens (from the
  gateway's receipts), the tools it used, how long, how it ended; never prompts or answers.
  `autobot usage` (or `/usage`) sums today and a conversation, `autobot insights --days 30` (or
  `/insights`) shows turns, tools, projects, failures and the share that ran on your own
  hardware. Local models cost nothing; for cloud ones, give prices per million tokens:

  ```toml
  [prices."deepseek-chat"]
  input = 0.27
  output = 1.10
  ```
- **Tools on and off:** `autobot tools` lists the tool groups and their tools, on or off for the
  bot (`--bot ops` for another); `autobot tools disable browser` turns one tool off
  (`[agent] disabled_tools`), `autobot tools disable terminal` a whole group (`[agent] tools`),
  `enable` turns them back on.
- **Configuration from the command line:** `autobot config` shows the bot's file;
  `autobot config get agent.max_steps` shows the value the bot runs with, defaults included
  (`24  (default)`, `40  (set in config.toml)`, `inherited from config.toml` for a named bot),
  with what the bot works out from it (the working directory, the heartbeat's 5-minute floor);
  `autobot config set approvals.mode edits` and
  `autobot config unset gateway.model` change one dotted key in `config.toml` (or a bot's
  `bot.toml`), with its comments kept. A change that would not load (an unknown key, a value of
  the wrong kind, a tool group that does not exist) is refused and the file stays as it was;
  `autobot serve` takes a good one within seconds. `autobot model` lists the models the gateway
  serves and sets the one you pick (`autobot model qwen3.5-9b`, or `auto`).
- **Coming from Hermes Agent or OpenClaw:** `autobot migrate hermes` (or `openclaw`) brings over
  its SOUL.md (as a personality when you have one already), memory and user profile entries
  (through the same checks), your skills, AGENTS.md, the plain commands of its allowlist
  (patterns are named and left out), the model when the gateway serves it, and the command
  timeout. Nothing here is overwritten; `--dry-run` says what it would do; `--from DIR` for
  another place. API keys and bot tokens come only with `--with-secrets`, into Autobot's own
  files (mode 0600: `~/.autobot/secrets/<provider>.key`, `telegram.token`, `discord.token`),
  with the command that gives a key to the gateway.
- **Recall:** `search_sessions` finds what was said or decided in earlier conversations (words
  in your messages, its answers and the summaries), and for the three conversations that match
  best, a short call to the model says what each holds about it: decisions, names, paths, what
  was left open. Each conversation has a small word index beside it (`sessions/.index`), so a
  search does not read every transcript; summaries are kept by the conversation's hash and the
  query (`sessions/.recall`), so asking again costs nothing until the conversation changes. They
  run on the bot's model, or a smaller one with `[agent] recall_model = "qwen3.5-4b"` (`off`
  for the matching messages only), as private as the turns. `/recall <what>` does the same for
  you, in the terminal (the result goes with your next message) and, for the owner, in a chat.
  On a node that runs for months, `autobot sessions prune --days 90` removes the conversations
  untouched that long, with their undo logs and recall index (`--dry-run` says which first).
- **Speech and pictures:** when the node has a speech or an image backend
  ([below](#speech-and-images-optional)), the agent has `speak` (text to an audio file) and
  `generate_image`. They go with the answer in the platform's own way: a voice message and a photo
  on Telegram, an attachment on Discord, Signal and email, a file in the thread on Slack (the app
  needs `files:write`), uploaded media on Matrix (a voice message, a picture), an audio or image
  message on WhatsApp (MP3, OGG, AAC, PNG, JPEG). An email answer carries up to 15 MiB of files;
  when the mail server refuses that, the answer goes without them and the files follow one by
  one. What a platform cannot take, the chat names with its path (`~/.autobot/attachments`).
  A backend on the node runs without asking; one off the machine is asked for first, like a cloud
  model, and then the text goes out redacted, with a receipt.
- **A team of agents:** define members in `config.toml`, and the agent hands them work with its
  `delegate` tool. Each member has its own instructions, only the tool groups you give it, and
  optionally its own model; it starts every task fresh, with just the goal and context it was
  handed (small models need small contexts, and nothing leaks between tasks). Several hand-offs
  in one reply work at the same time (`[team] max_parallel`, what your model can serve). Their
  progress shows under their names, their questions come to you as `[coder] Approve? …` on
  whatever channel you use, they never get more than the agent may do, and their receipts are
  part of the turn's.

  **The team board** is for work that outlives a conversation: the agent plans tasks for members
  (`board_plan`), with what each depends on; `autobot serve` runs each as soon as its
  dependencies are done (independent ones at the same time), handing a member the results it
  builds on. A member that needs you asks (`ask_owner`): its task waits, the question comes to
  the chat, and `/board answer b2 Markdown, please` sends it on. When the plan is done, the
  results come to that chat. Board work runs unattended, so it follows the allowlist rules.
  `/board` (Telegram) and `GET /v1/agent/board` show it.

  **In a Telegram group,** add the bot and talk to it with an @mention or a reply (only users you
  approved; the rest of the group is ignored, and only the person who asked can press an approval
  button). Give a member a bot of its own (`telegram_token_file = "coder.token"`, a token from
  @BotFather; add that bot to the group too) and it posts its own progress and answers there, so
  the team shows up as bots working together. Telegram bots never see each other's messages, so
  the hand-offs happen inside the agent; the members' bots only post.

  ```toml
  [agents.researcher]
  description = "Reads files and logs, reports facts with paths"
  instructions = "Never change anything."
  tools = ["files-read"]

  [agents.coder]
  description = "Changes code and runs it"
  tools = ["files-read", "files-write", "terminal"]
  model = "qwen3.5-4b"

  [team]
  max_parallel = 2
  ```
- **The agent schedules its own work:** "remind me in 10 minutes to stretch" or "check the disk
  every morning" becomes a schedule through its `schedule_task` tool (also `list_schedules`,
  `cancel_schedule`), never the system crontab. One-off times (`in 10m`, `at 18:30`) run once and
  are gone; the answer comes back to the chat that asked.
- **Scheduled tasks:** `autobot cron add "0 8 * * 1-5" "summarize the overnight logs" --telegram`
  (cron in local time, `@daily`, or `every 30m`); `autobot cron list` shows the next and last
  runs. They run inside `autobot serve` with nobody to ask, so they follow `allowlist` rules
  (allowlisted commands and writes in the working directory, nothing else) unless the mode is
  `trust`. Each schedule has its own conversation (`cron-<id>`), and `--telegram` sends every
  answer to the bot's allowed users. They can also be managed from Telegram (`/cron`,
  `/cron add 0 8 * * 1-5 | summarize the overnight logs`, `/cron rm t1`; answers come to that
  chat; also `/actions`, `/memory`, `/skills`) and from the Autobot app,
  through the agent API. Every run is kept with its whole answer and receipt ids
  (`~/.autobot/runs/`).
- **Recipes from the phone:** an Autobot recipe can run here instead of on the phone: always on,
  no 8-minute limit. It arrives as a schedule with the recipe's tool groups, and only those tools
  are offered (`files-read`, `files-write`, `memory`, `terminal`; the phone's `web` and `vault`
  have nothing here). The phone collects each run's answer and checks its signed receipts.
- **Receipts:** each model call shows its model, tier and receipt id.
- **Action log:** every command, file write, outside read and cloud send the agent asked for, whether
  it ran, and who decided (the rules, an "always" earlier in the session, or you on the CLI, the
  app or Telegram), in `~/.autobot/actions.jsonl`. `autobot actions` shows it; the app reads it
  through the agent API.
- **Telegram:** `autobot serve` answers direct messages through long polling, so the machine needs
  no public address. Strangers get a one-time code, and nobody gets in until you run
  `autobot telegram approve <code>` on the machine. Approvals arrive as buttons, and only the chat
  that was asked can answer. Telegram's servers see bot chats, which are not end-to-end
  encrypted. The private channel is the Autobot app, paired with the gateway over Noise.
- **Discord:** with `[discord] enabled = true` and a bot token in `~/.autobot/discord.token`,
  `autobot serve` answers direct messages, and in a server channel the messages that mention the
  bot or reply to it. The bot connects out to Discord's gateway (no public address; under the
  node's network mode, Tor included). Strangers get a one-time code (`autobot discord approve
  <code>`; `autobot discord users`, `revoke`), approvals are buttons only the person asked can
  press, progress is one message edited as the agent works, and a message sent while it works
  steers it. A task scheduled from Discord answers there. Discord's servers see bot messages.
- **Webhooks:** something outside starts a task: GitHub, a monitor, a form, a script.
  `autobot hooks new github` makes a secret; then

  ```toml
  [hooks]
  listen = "127.0.0.1:7794"     # behind a reverse proxy or tunnel for the outside to reach
  [hooks.github]
  task = "A GitHub event arrived. Tell me what happened; for a failed CI run, find why."
  telegram = true               # or discord = true: the answer to your allowed users
  tools = ["files-read", "web"] # optional
  ```

  `POST /hooks/github` must be signed like GitHub signs (`X-Hub-Signature-256`, an HMAC of the
  body with the secret) or carry `Authorization: Bearer <secret>`. The body reaches the agent
  fenced as data, never as instructions, and the task runs like a scheduled one (allowlisted
  commands and writes in the working directory only); one run per hook at a time.
  `autobot hooks` lists them with their last runs.
- **Cloud models with nobody to ask:** a scheduled task, a hook or board work that would go to a
  cloud model that keeps prompts is refused, since nobody can confirm it; `allow = ["cloud"]` in
  `[approvals]` says yes ahead of time.
- **Agent API** ([spec/agent.md](spec/agent.md)): `autobot serve` also listens on loopback
  (`127.0.0.1:7792`), and the gateway passes `/v1/agent` through to it with its token. A paired
  device granted the `agent` capability can therefore start turns, watch their events (tool runs,
  receipts, approval questions, the answer) and answer approvals, all inside its Noise session.
  Granting it is explicit — `invincible pair --capabilities agent`, or `PATCH
  /v1/cluster/nodes/<name>` on the device already paired — because the proxy speaks with the
  node's own token: a device granted nothing reaches a 404 there, exactly as for a route that does
  not exist. A turn may carry up to four
  images (`"images"`: `data:` URLs, 10 MiB each), seen by the model as in the terminal; a model
  that cannot see answers `400 model_cannot_see_images`. Nothing new is exposed: the
  agent is reachable from this machine, and over a device session only where you granted it.

## Bots and channels

One `autobot serve` runs several bots. The configuration you have is the default bot
(`~/.autobot/config.toml`, named `default`) and keeps working as it is. Every other bot is a
directory of its own, `~/.autobot/bots/<name>/`: `bot.toml` (what differs from `config.toml`:
model, tools, approvals, working directory, its channels), `SOUL.md` (its persona), and its own
memory, `USER.md` profile, skills, personality, conversations, turn log (`/usage`, `/insights`), schedules and channel users. Bots share only the gateway and
`[voice]`. Each runs in tasks of its own: a slow model or a failing channel holds up no other
bot, and a part that stops is started again.

```sh
autobot bots add ops --description "Watches the servers" --model qwen3.5-4b \
  --tools files-read,terminal --approvals allowlist --telegram-token 123:abc   # or answer questions
autobot bots                      # list, with how the running ones are doing (also: bots status)
autobot bots show ops             # its config and persona
autobot bots edit ops [--soul]    # bot.toml or SOUL.md in $EDITOR
autobot bots disable ops          # enable; remove (moved to ~/.autobot/bots-removed)
autobot --bot ops chat            # any command for one bot: cron, memory, skills, sessions …
```

**Live.** `autobot serve` watches `config.toml` and `~/.autobot/bots/`. A bot added or enabled
starts, one disabled or removed stops and lets go of its channels, and one whose `bot.toml` (or
`config.toml`, or a token file) changed starts again, within a few seconds and without touching
the others. `SOUL.md` is read at every turn, so a new persona applies from the next message.
`autobot bots add|enable|disable|remove|edit` and the API's enable and disable ask for it at
once and say what happened. A restarted bot's questions waiting in its chats lapse (answer
again). `[serve]` and `[hooks] listen` addresses still need a restart.

**Channels.** Each is a section in the bot's config, its token in the bot's directory. A token
belongs to one bot: a second bot with the same one keeps that channel off. Strangers get a
one-time code in a direct message and nothing else until you run `autobot <platform> approve
<code>` (whichever bot gave it; `users` and `revoke` too). On every platform: approvals (buttons
where there are any, else a reply: `yes`, `always`, `no`, `no, do X instead`), a message while it
works steers it, long answers in parts, Markdown as the platform writes it, voice messages
transcribed, and `/help`, `/status` (model, uptime, queue, last error), `/new`, `/stop`,
`/model [id]`, `/sethome`, `/bots`, `/cron`, `/board`, `/actions`, `/memory`, `/skills` (also
written `!status`: Slack keeps `/` for its own commands).

| Platform | Config | Notes |
|---|---|---|
| Telegram | `[telegram] enabled = true`, token in `telegram.token` | Long polling; groups by @mention |
| Discord | `[discord] enabled = true`, token in `discord.token` | Gateway websocket; servers by mention |
| Slack | `[slack] enabled = true`, `slack-app.token` (`xapp-`, Socket Mode) and `slack-bot.token` (`xoxb-`) | No public URL; DMs and mentions; a thread is a conversation; Block Kit buttons. Scopes: `chat:write`, `im:history`, `app_mentions:read`, `files:read` |
| Email | `[email] enabled = true`, `address`, `imap = "host:993"`, `smtp = "host:465"`, `allow = ["me@x.org"]`, password in `email.password` | IMAP IDLE (or polling) and SMTP, TLS or STARTTLS; a thread is a conversation, replies quote. Only `allow`ed senders that pass SPF, DKIM or DMARC; approval by a reply that keeps the code in the subject; auto-replies and lists are never answered |
| Signal | `[signal] enabled = true`, `account = "+1555…"` | Through signal-cli's daemon (started for you, or `url = "http://127.0.0.1:7583"`); link or register the number with signal-cli first; direct messages |
| Matrix | `[matrix] enabled = true`, `homeserver`, access token in `matrix.token` | `/sync` long poll; direct rooms, mentions elsewhere; unencrypted rooms only |
| WhatsApp | `[whatsapp] enabled = true`, `phone_number_id`; `whatsapp.token`, `whatsapp-app.secret`, `whatsapp-verify.token` | The Business Cloud API, off by default. Needs a public HTTPS URL to the hooks listener (below); direct messages; approvals by reply buttons |

**One conversation everywhere.** `autobot identities link telegram:123 slack:U456 email:me@x.org`
makes them one person (the first one linked is `owner`): a direct conversation with them is the
same conversation on every platform. Linking lets nobody in; each platform still pairs. Once an
owner is linked, only the owner uses `/bots`, `/model <id>` and `/sethome`.

**Where results go.** `/sethome` in a chat makes it the bot's home: heartbeat notices, hooks and
schedules with nowhere else to go are sent there. A schedule can name places of its own:
`autobot cron add @daily "summarize the logs" --to slack:#ops --to email:me@x.org`; a hook takes
`to = ["slack:#ops"]`; a task scheduled from a chat answers in that chat. Another bot's hooks are
at `/hooks/<bot>/<name>`.

**Voice.** Telegram voice notes and audio in Discord, Slack, Signal, Matrix and email are
transcribed on this machine, echoed briefly (`heard: "…"`), then handled as text. Set `[voice] url`
to a local speech-to-text server in the OpenAI shape (whisper.cpp's server, faster-whisper), or
install whisper.cpp (`whisper-cli`) and ffmpeg, with a model at `~/.autobot/whisper/ggml-base.bin`.
The gateway has no speech-to-text of its own yet.

**WhatsApp.** It is the one channel that needs the outside to reach this machine: Meta calls a
webhook. In Meta's developer console make an app with the WhatsApp product, a business number
and a system user's access token. Then, in the bot's directory (each file 0600):
`whatsapp.token` (the access token), `whatsapp-app.secret` (the app secret, which signs every
call: `X-Hub-Signature-256`, checked), `whatsapp-verify.token` (any string you choose), and

```toml
[whatsapp]
enabled = true
phone_number_id = "123456789012345"   # WhatsApp Manager, API setup: the id, not the number
[hooks]
listen = "127.0.0.1:7794"
```

Expose the hooks listener over HTTPS (`cloudflared tunnel --url http://127.0.0.1:7794`,
`tailscale funnel 7794`, or a reverse proxy) and give Meta `https://<host>/hooks/whatsapp`
(another bot's: `/hooks/<bot>/whatsapp`) with your verify token, subscribed to `messages`.
Pairing is as everywhere (`autobot whatsapp approve <code>`). WhatsApp takes free-form messages
only within 24 hours of the person's last one, so a home channel on WhatsApp gets notices only
then. Meta sees the messages.

**Home Assistant.** As tools: `autobot homeassistant setup http://homeassistant.local:8123`
reads a long-lived access token (your profile in Home Assistant, Security) from stdin, keeps it
in `homeassistant.token` (0600; the bot's own directory, else `~/.autobot`) and the address in
the config. The agent's `home` tool then lists entities and their states, reads one, lists the
services, and calls one; reading asks nothing, a call asks first (an approval of kind `home`).
For schedules and other runs with nobody to ask, allowlist services: `[approvals] allow =
["home:light.*", "home:climate.set_temperature"]`. `[homeassistant] entities = ["light.*"]`
limits what the agent sees and changes. Home Assistant is reached directly on your network.
`autobot homeassistant` checks it.

As a channel, Home Assistant's conversation agent (Assist, voice) can talk to a bot through an
OpenAI-compatible endpoint, for an integration that takes a base URL (for example Extended
OpenAI Conversation): `autobot hooks new homeassistant` makes its API key, and the base URL is
`http://<this machine>:7794/hooks/homeassistant/v1` on the hooks listener (another bot's:
`/hooks/<bot>/homeassistant/v1`). On this machine the agent API serves it too, at
`/v1/agent/openai/v1` with the gateway's token (`model` names the bot). Its turns follow the
unattended rules: what is allowlisted runs, the rest is refused.

`autobot doctor` checks WhatsApp (its secrets, the number, the hooks listener) and Home Assistant
(the token, how many entities the agent sees), and lists the bots `autobot serve` runs with any
channel that is down; `/status` in a chat says whether the `home` tool works.

The agent API lists the bots (`GET /v1/agent/bots`), turns them on and off, reloads them, and
takes `?bot=` on every path ([spec/agent.md](spec/agent.md)).

## v0 milestone

Done when, with the internet unplugged:

1. One node, installed by the script, serves one strong open model.
2. Autobot pairs with it and runs a real agent session on it, end to end.
3. A recipe handed to the node runs past Autobot's 8-minute on-device limit and delivers its result.
   (Shipped in Autobot 1.10.0; shown live: a recipe ran 9 min 54 s on the node and delivered.)
4. The eval harness scores node vs. frontier on 50 real tasks from Autobot, Omnie and Nightfall.

## Running a node (today)

You need llama.cpp's `llama-server` (`brew install llama.cpp`, or a CUDA build on NVIDIA). Then add a
model; it is downloaded, checked against its SHA-256, checked to fit this machine, and added to
`~/.invincible/config.toml`:

```sh
invincible model add qwen3-0.6b hf:Qwen/Qwen3-0.6B-GGUF/Qwen3-0.6B-Q8_0.gguf --context 4096 --network direct
invincible model list
```

- Downloads follow the config's `[node] network` (offline refuses, Tor and SOCKS5 go through the
  proxy); `--network` overrides it for one download.
- For `hf:` sources the hash comes from Hugging Face's listing unless you pin it with `--sha256`; an
  HTTPS URL always needs `--sha256`. A mismatch deletes the download.
- Interrupted downloads resume. Models that look too big for the machine are refused unless you
  pass `--force` (the estimate is rough: weights + 10% + 512 MiB, against 90% of NVIDIA VRAM, 70% of
  Apple unified memory or 80% of RAM).

Or write the config by hand:

```toml
listen = "127.0.0.1:7777"   # loopback only until pairing exists

[node]
network = "offline"          # offline, direct, tor:<host>:<port>, socks5:<host>:<port>
egress = "never"             # never, ask, auto

[[models]]                   # in order of preference
id = "qwen3-0.6b"
path = "/models/Qwen3-0.6B-Q8_0.gguf"
context = 4096
```

```sh
cargo run --release -- serve      # starts one llama-server per model and keeps it running
cargo run --release -- token      # the API token (created on first run, mode 0600)
```

Any OpenAI-compatible client on the same machine works against `http://127.0.0.1:7777/v1` with that
token as the API key. `model: "auto"` (or no model) lets the router choose.

- Anthropic Messages clients can use `POST /v1/messages` the same way. It is served by the node's
  engines only (llama.cpp speaks it natively), so a Messages request never goes to the cloud.
- Every response carries the routing decision in an `invincible-decision` header.
- `invincible-private: 1` marks a request that must never leave hardware you own;
  `invincible-risk: health,personal` passes risk codes; `invincible-confirmed: 1` answers an `ask`.
- Blocked requests answer 403, 404 or 503 with the reason, an `ask` answers 409.
- A streamed answer from a local engine is kept alive while the engine reads a long prompt
  (`: keep-alive` comments every 20 s, which SSE clients skip); an engine silent for 30 minutes
  is given up on with an `engine_stalled` error event (a 504 when not streamed, where 30 minutes
  is the whole answer's limit).
- Engines run as child processes with their logs in `~/.invincible/logs/`. A crashed engine is
  restarted with backoff, and stopping the node stops its engines.
- Images (OpenAI `image_url` parts, Messages `image` blocks) pass through to the model as they
  came; a request may be up to 32 MiB. A local model sees images when it has its multimodal
  projector: `mmproj = "/models/mmproj-….gguf"` in its `[[models]]` entry (passed to
  `llama-server --mmproj`), or `vision = true` when the engine is given one otherwise. A cloud
  model's `vision` is known for the common families (Claude, GPT-4o/4.1/5, o1/o3/o4, Gemini,
  Pixtral, Qwen-VL; DeepSeek's chat models cannot) and can be set with `vision = true|false`.
  `/v1/models` reports it (`"vision": true`, `false`, or `null` when not known), and a request
  with images for a model known not to see them answers `400 model_cannot_see_images` instead of
  being sent.

### Cloud backends (optional)

Any OpenAI-compatible endpoint works: OpenAI, Anthropic's compatibility endpoint, DeepSeek,
OpenRouter, a friend's node. Keys live in files or environment variables, never in the config.
`autobot setup` offers one; `invincible cloud` adds more:

```sh
invincible cloud add anthropic                 # asks for the key (not shown), keeps it in ~/.invincible/keys
invincible cloud add deepseek --id ds
invincible cloud add openai --model <model> --key-file ~/openai.key
invincible cloud add custom --id mine --model m --base-url https://llm.example.com/v1 --policy no-retention
invincible cloud list
invincible cloud remove ds
```

Presets know each provider's API, a model to start with, its context and its data policy;
`egress = "never"` becomes `"ask"` with the first cloud model, and the gateway service is
restarted to use it (a gateway started by hand needs a restart). Automatic routing never picks a model that trains on prompts (DeepSeek's API does), so with
no local model, name one: `autobot code --model deepseek`, or `[gateway] model` in the agent's
config (setup does this for a gateway with only cloud models).

Or by hand:

```toml
[node]
network = "direct"   # or tor:127.0.0.1:9050: cloud requests then go through Tor
egress = "auto"      # never (default), ask, auto: see spec/routing.md

[[cloud]]
id = "claude"
upstream_model = "claude-sonnet-5-5"
base_url = "https://api.anthropic.com/v1"
api_key_file = "keys/anthropic"     # relative to ~/.invincible; or api_key_env = "ANTHROPIC_API_KEY"
context = 200000
data_policy = "retention:30"        # what the provider does with prompts
```

- The cloud is used only as [spec/routing.md](spec/routing.md) allows: never for
  `invincible-private` requests, never while offline or under `egress = "never"`; `ask` (and models
  that train on prompts) answer 409 until the request is sent again with `invincible-confirmed: 1`.
- Before a request leaves, names, emails, phone numbers, street addresses, card numbers, IBANs and
  account numbers become placeholders (`[PERSON_1]`, `[EMAIL_1]`), with the same rules as Autobot
  ([spec/redaction.md](spec/redaction.md)); later mentions of a known value are hidden too. The
  answer gets the real values back, streams included, and the `invincible-redacted` header counts
  what was hidden.
- A backend that fails (no connection, 429, 5xx) is skipped for 30 seconds, and the request is
  routed again: usually to a local model, with `"fallback": true` and the reason `cloud-down`.

### Speech and images (optional)

`POST /v1/audio/speech` and `POST /v1/images/generations`, in OpenAI's shapes, go to the
backends you give, under the same routing rules as chat:

```toml
[[speech]]
id = "kokoro"
base_url = "http://127.0.0.1:8880/v1"   # an OpenAI-compatible speech server here (Kokoro-FastAPI, …)
voice = "af_heart"                      # when a request names none

[[images]]
id = "gpt-image"
base_url = "https://api.openai.com/v1"  # off the machine: HTTPS, and the cloud rules
upstream_model = "gpt-image-1"
api_key_file = "keys/openai"
data_policy = "retention:30"
```

A backend on loopback is the node's own and is taken first; any other is a cloud backend: never
for a private request, offline or under `egress = "never"`, and asked about when the rules ask.
The text that leaves (what to say, the prompt) is redacted first. Every request gets a receipt
(`api` `speech` or `images` in the audit log). `GET /v1/node` lists the backends, and the agent
offers `speak` and `generate_image` when there are some.

### Receipts

Every chat completion answers with `invincible-request-id`. Once the answer is complete,
`GET /v1/receipts/<id>` returns a receipt signed with the node's Ed25519 key (`GET /v1/node` has the
public key; paired devices receive it when they pair). It records the routing decision, tokens, what
was redacted, and every attempt to reach a host off the node, with bytes sent and received. An empty
`egress` list is a signed statement that nothing left the node. Receipts never contain prompt or
answer text; images are listed by SHA-256, size and type (`"images": [{"sha256", "bytes",
"mime"}]`), never their bytes, and redaction never touches them (it covers text only).

### Audit log

Every request the node answered is also written to `~/.invincible/audit.jsonl`
([spec/audit.md](spec/audit.md)): its signed receipt, when, and who asked (`local`, or the paired
device by name). Each entry carries the hash of the one before it, so an entry removed or edited
later breaks the chain.

```sh
invincible audit                    # the newest requests: when, who, where it ran, tokens, what left
invincible audit --since 7d --summary   # totals per model, and every host anything was sent to
invincible audit --verify           # check the chain and every receipt's signature
```

Paired devices read the same log with `GET /v1/audit`. There is no telemetry: nothing about your
requests leaves the node unless you send it.

### Pairing other machines

Other devices reach the node over an encrypted, mutually authenticated Noise channel, never over
plain HTTP. Turn it on in the node's config:

```toml
[remote]
name = "studio"
listen = ["0.0.0.0:7778"]
advertise = ["192.168.1.20:7778", "100.101.102.103:7778"]   # LAN, Tailscale, …
```

```sh
invincible pair                      # on the node: prints a QR code and a one-time code (10 minutes)
invincible pair --capabilities agent,audit   # …pre-granting those to the device that joins
invincible join '<code>' --name laptop   # on the other machine: pairs, pins the node's key
invincible tunnel                    # on that machine: http://127.0.0.1:7780 now leads to the node
                                     # (with that machine's token, `invincible token`: web pages cannot use it)
invincible devices                   # on the node: who is paired, and what each may reach
invincible devices --remove laptop   # unpair: refused at the next handshake or frame
```

On macOS with the application firewall on, the first remote connection can wait for the "accept
incoming connections?" prompt for `invincible` (or `System Settings › Network › Firewall`): allow it,
or pairing hangs until it times out.

Every paired device is granted a small set of capabilities when it pairs
([spec/pairing.md](spec/pairing.md), Capabilities). `shard` (the default, and the least) is the six
routes above: `/v1/models`, `/v1/chat/completions`, `/v1/receipts/<id>`, `/v1/node` and the
cluster's `/v1/cluster/node` and `/v1/cluster/meter`, with no token (the device's key
authenticates it). `agent` adds `/v1/agent` — the Autobot proxy, which runs with the node's own
token — `audit` adds the audit log, and `dispatch` adds `/v1/dispatch`, a hop into your other
nodes. Nothing else is reachable, and a route the device was not granted answers exactly as a path
that does not exist, so a device cannot even learn it is there. Past that check, each route takes
only the body it needs (32 MiB for a chat completion, 5 MiB for the meter), and the node holds at
most `[node] max_buffered_bytes` of device request bodies at once — 256 MiB unless set, refusing
with 503 and `Retry-After: 2` past it instead of running itself out of memory. A device outside its
grant never reaches either check, so its 404 says nothing about them
([spec/pairing.md](spec/pairing.md), Limits). Grant and revoke on the node's own
API, with no re-pairing:

```sh
curl -X PATCH localhost:7777/v1/cluster/nodes/laptop \
     -H "authorization: Bearer $(invincible token)" \
     -d '{"capabilities": ["shard", "agent"]}'
```

The list is in [spec/pairing.md](spec/pairing.md) (Transport). Autobot
pairs by scanning the same QR code: its protocol layer is in
[autobot#2](https://github.com/wckdboy/autobot/pull/2), and the screens are INV-14. The protocol is in
[spec/pairing.md](spec/pairing.md). It is tested, including the refusal cases, but it has **not been
independently reviewed yet**.

### Finding a node without a pasted code

Pairing starts from a code, which means a human pastes or scans it. Discovery removes *that* step
and nothing else: a node can publish a small signed record of where it is, and another machine can
look for it. Finding a node does not trust it; the first connection still needs the node's code.

```toml
[discovery]
announce = true                        # off by default: publishing is a decision
addresses = ["192.168.1.20:7778"]      # what the record says; never detected for you
seeds = ["https://seed.example"]       # optional: where `invincible announce` posts it
lan = true                             # let `announce --lan` answer mDNS
```

```sh
invincible announce                  # sign this node's descriptor; POST it to [discovery] seeds
invincible announce --lan            # also answer mDNS on this network, until Ctrl-C
invincible discover                  # ask the seeds (add --seed URL to ask another), verify, list
invincible discover --lan            # also browse mDNS for ~3 s; --model ID filters
invincible seed --listen 127.0.0.1:7789   # run a dumb seed yourself: it stores and returns records
```

Every record is signed by the node (Ed25519, `receipt.key`) and expires within 24 hours; a seed
stores and returns it without verifying, so the consumer always checks the signature. `discover`
prints fingerprints, addresses, model ids and expiry, and marks everything `unpaired` unless a
pairing already exists. A seed learns who announces, from what address and when — that is the price
of discovery, and a node that will not pay it leaves `announce = false`. Details and the request
shapes: [spec/discovery.md](spec/discovery.md).

### A cluster of your own devices

A model too big for one machine can be split across nodes you paired, layer by layer, as exo
does ([spec/cluster.md](spec/cluster.md)). llama.cpp's RPC server does the work on each shard; it
has no authentication, so it only ever listens on loopback, and the head reaches it through an
encrypted shard link (Noise, with the keys pairing pinned), never over the network directly.

On the machine that lends its GPU (the shard), with `[remote]` set up as above:

```toml
[cluster]
serve = true
heads = ["studio"]            # the paired devices that may use this node as a shard
```

On the machine that serves the model (the head), pair with the shard (`invincible join '<its
code>' --name studio`), then:

```toml
[[models]]
id = "big"
path = "/models/Big-70B-Q4_K_M.gguf"
cluster = ["mini"]            # paired nodes it may be split across
split = "auto"                # only when it does not fit here; "always" to split anyway
```

```sh
invincible cluster status     # devices, peers (probed now), heads served, where each model runs
```

- The split is sized by each device's free memory, or by measured speed once every device taking
  part has been benchmarked (`invincible tune bench <model>`); receipts list the nodes that took
  part (`cluster`).
- Shard links stay on the local network (private, link-local, Tailscale or `.local` addresses),
  never go through Tor or SOCKS5, and stop under `network = "offline"`.
- A shard that leaves mid-answer ends that answer with an error event; the model is planned again
  over what is left (or waits, unhealthy, while the router uses another model).
- Every node needs the same llama.cpp build with the RPC backend: llama.cpp's release archives have
  `ggml-rpc-server`; Homebrew's llama.cpp has no RPC backend.
- A pipeline split needs a GPU device on the head: `llama-server --list-devices` has to report one.
  Without it the model runs on the head alone, with a note saying why, and a CPU-only peer is kept
  out of the split ([spec/cluster.md](spec/cluster.md), Known limits of phase 1).

## Evals: local against frontier, on your own work

`invincible eval` runs a task file against models the gateway serves and checks every answer by
rule ([spec/evals.md](spec/evals.md)): contains, equals, regex, a JSON field, a word limit. No
model grades another, so a result is the same however often it runs.

```sh
invincible eval evals/seed.jsonl --model qwen3.5-4b --model qwen3-0.6b          # local models
invincible eval evals/seed.jsonl --model qwen3.5-4b --model claude --confirm     # and a cloud one
invincible eval evals/seed.jsonl --model qwen3.5-4b --thinking --tag reasoning   # let it think
```

It prints the pass rate and median time per model and per tag, and the tasks where the models
differ; `--out results.json` keeps every answer, check and receipt id. Every run is kept in
`~/.invincible/evals/history.jsonl` (`--no-record` leaves one out), `autobot eval`'s too, and
`invincible eval --history` shows each suite's runs and the gap between the best local and the
best cloud model, then and now:

```
projects (50 tasks, 3f9a1c2b7d01)
  2026-10-20 21:00  qwen3.5-4b [node] 30/50 · deepseek [cloud] 45/50  gap +30 points (qwen3.5-4b → deepseek)
``` Thinking models are asked
to answer directly unless you pass `--thinking` (then they get an 8192-token budget), and an
answer that runs out of tokens says so instead of counting as wrong. Cloud models go through the
gateway like any request: redacted, receipted, and only with `--confirm`.

[`evals/seed.jsonl`](evals/seed.jsonl) has 40 tasks with one right answer each (extraction to
JSON, arithmetic and units, CAD and engineering, Swift / Kotlin / Rust / shell, following
instructions, not making things up). On a MacBook (M-series, Metal), October 2026:

| model | pass | median |
|---|---|---|
| Qwen3.5 4B (Q4_K_M) | 34/40 | 0.2 s |
| Qwen3 0.6B (Q8_0) | 13/40 | 0.2 s |
| Qwen3.5 4B, thinking, reasoning tasks only | 4/4 (2/4 without) | 8.3 s |

[`evals/projects.jsonl`](evals/projects.jsonl) has 50 tasks built from the code of Autobot,
Omnie and Nightfall: each carries a real excerpt (Kotlin, Swift, TypeScript, C++, docs) and asks
what it returns, which line is wrong, for one line of code, a JSON extraction, or the kind of unit
and geometry arithmetic Nightfall does. Every expected answer was checked by running the code.

| model | all | Autobot | Omnie | Nightfall |
|---|---|---|---|---|
| Qwen3.5 4B (Q4_K_M), on the node | 30/50 | 9/17 | 10/16 | 11/17 |
| Qwen3 0.6B (Q8_0), on the node | 8/50 | 2/17 | 4/16 | 2/17 |
| DeepSeek V3 (`deepseek-chat`, cloud) | 45/50 | 16/17 | 15/16 | 14/17 |

On the 40 seed tasks DeepSeek passes 40/40 against Qwen3.5 4B's 34/40. So a 4B model on a
laptop is at two thirds of a frontier model on this code, and level with it on extraction,
shell and instructions; the gap is in multi-step reading and arithmetic. Each of DeepSeek's 90
requests went through the gateway like any other: confirmed, redacted, receipted, and listed by
`invincible audit --summary` (62 KB sent to `api.deepseek.com` for both suites).

The 4B model's misses are real ones, for example a glob whose `**/` needs a slash, a module
resolver that tries `.js` before `/index.*`, `2 in + 3 mm` answered as 254.

### Agent evals: whole tasks, not single answers

`autobot eval` runs agent tasks for real: each in a fresh directory with its files, the agent
working it with its tools (commands sandboxed), then checks on the files it left, the task's own
tests, the tools it called and its answer.

```sh
autobot eval evals/agent.jsonl --model qwen3.5-4b --model deepseek --cloud
```

| model | everyday (16) | hard (10) | median time (everyday / hard) |
|---|---|---|---|
| Qwen3.5 4B, on the node | 16/16 | 8/10 | 8 s / 32 s |
| Qwen3 0.6B, on the node | 6/16 | | 15 s |
| DeepSeek V3, cloud | 16/16 | 10/10 | 3 s / 5 s |

With only the core tool groups (`--tools files-read,files-write,terminal`), Qwen3.5 4B passes
the hard set just as often (8/10) in half the time (17 s median instead of 32 s): every model
call carries the tool list, and a small model reads a shorter one faster. `[agent] tools =
["files-read", "files-write", "terminal", "web"]` sets that for the agent itself.

Everyday tasks: write, edit and rename files, fix a one-line bug, sum a CSV column, find a TODO,
sort a file in place, bump a version, run a script, remember, schedule, read without changing.
Hard ones: rename a function across files, make failing tests pass, find the IP with most
errors in a log, convert INI to JSON, join two CSVs, implement a function to a spec, delete only
`.tmp` files, count files by extension, fix a failing shell script, collect TODOs with line
numbers. The 4B model's two misses are real: a nested `.tmp` file left behind, and line numbers
off by one.

### From a frontier model's work to a local model's training data

`--trajectories FILE` keeps an eval's passing runs, in the shape `autobot trajectories` exports:
let a frontier model do the tasks once, keep what passed, and fine-tune the local model on it.

```sh
autobot eval evals/agent-hard.jsonl --model deepseek --cloud --trajectories runs.jsonl
autobot trajectories --from runs.jsonl --clean --format sharegpt --out train.jsonl
```

DeepSeek's runs of both suites gave 26 clean trajectories (26 of 26 passed), 5 to 13 messages
each, ready for a trainer that reads OpenAI's chat format or ShareGPT's with Hermes-style
`<tool_call>` tags.

## Repository

| Path | What |
|---|---|
| [`spec/`](spec/) | The rules Invincible and Autobot share, with conformance vectors |
| `crates/invincible-policy` | The routing rules as a pure Rust library, tested against `spec/vectors/` |
| `crates/invincible` | Invincible Gateway (the node): config, engine supervisor, local API, pairing and remote access, services, updates, and the `invincible` command |
| `crates/autobot` | The Autobot Agent: agent loop, tools, approvals, sessions, Telegram, setup, doctor, and the `autobot` command |
| [`install.sh`](install.sh) | The installer for both; [`tests/install/`](tests/install/) runs it against a fake signed release |
| [`evals/`](evals/) | Task files for `invincible eval` |
| [`bench/`](bench/) | `bench/run.sh`: start-up, per-turn and gateway latency, memory and binary sizes, on stand-ins |

```sh
cargo test --workspace                                  # includes every conformance vector
cargo clippy --workspace --all-targets -- -D warnings
sh tests/install/test.sh                                # the installer, end to end, in a sandbox
cargo run -p invincible -- route input.json             # where would this request run?
cargo run -p invincible -- serve --config path/to/config.toml   # run a node
cargo run -p autobot -- doctor                          # check an agent install
sh bench/run.sh                                         # the benchmarks, on a release build
cargo test --release -p autobot --test soak -- --ignored --nocapture   # the soak test (SOAK_SECS)
```

The parsers that read what comes from outside (model streams, receipts, redaction, email,
Markdown for the chat platforms, pastes) have property tests over generated input
(`INVINCIBLE_FUZZ_CASES=5000 cargo test` runs more cases; a failure names its
`INVINCIBLE_FUZZ_SEED`). Every night CI runs the benchmarks and a ten-minute soak test: two bots
under steady traffic with the gateway restarting, every message answered, and no growth in
memory, file descriptors, tasks or threads (compared at rest: traffic paused, nothing in flight).

**Numbers** (an Apple M-series Mac, release builds, against stand-ins on loopback that answer at
once; `bench/run.sh`, medians):

| | 0.0.13 | now |
| --- | ---: | ---: |
| `autobot` start to the first composer frame | 105 ms | 6.3 ms |
| `autobot run "…"`, one turn, the whole process | 107 ms | 6.7 ms |
| Agent loop, per turn, in a 1000-turn conversation | 0.80 ms | 0.39 ms |
| Model calls per turn, in a long conversation | 2.0 | 1.1 |
| `autobot serve`, turns a second (16 at once) | 7,300 | 14,800 |
| Gateway latency added, p50; to the first streamed token | 0.3 ms; 0.3 ms | 0.3 ms; 0.25 ms |
| `invincible serve` memory, idle / after 1000 requests | 16.5 / 21.6 MiB | 9.9 / 15.9 MiB |
| `autobot serve` (two bots) memory, idle / after 1000 turns | 16.9 / 26.0 MiB | 12.0 / 21.1 MiB |
| Binary sizes, `invincible` / `autobot` | 6.4 / 11.3 MiB | 6.4 / 11.9 MiB |

(Most of the start was loading the system's trust roots for a plain-HTTP connection to this
machine; `autobot` grew with the editor protocol, Home Assistant and WhatsApp.)

## Principles

- **Local is the default.** Leaving hardware you own is always a choice, visible and reversible.
- **No phoning home.** No telemetry, no update checks you did not ask for, no accounts.
- **Owned means owned.** Your keys, your weights, your logs, your machine.
- **Frontier-optional, never frontier-dependent.** Every feature has a path that works without a
  third party.
- **Open source, reproducible, signed.**

## Open questions

- Region tier: trusted operators only, or a design that is safe with strangers' compute?

## License

[MIT](LICENSE). Every dependency is under a license compatible with it (MIT, Apache-2.0, BSD,
ISC, Unicode), which `cargo deny` checks in CI.
