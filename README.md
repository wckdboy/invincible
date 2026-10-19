# Invincible

**Intelligence that never relies solely on frontier labs, corporations or countries.**

Invincible is a self-hosted AI node. Install it on hardware you own (a desktop, a GPU box, a rack in
your hackerspace) and it gives every device you own one endpoint for intelligence. It runs open
models itself, reaches frontier models when you allow it, and keeps working when they are gone.

Frontier models are welcome here. Being dependent on them is not. Everything works without them;
they make it faster when you choose to use them.

> Status: **early build.** Invincible Gateway (the node) serves open models through llama.cpp
> behind OpenAI- and Anthropic-compatible APIs, every request goes through the routing rules
> ([spec/routing.md](spec/routing.md), pinned by 51 conformance vectors), and devices pair with it
> over Noise ([spec/pairing.md](spec/pairing.md), implemented but not yet independently reviewed).
> Cloud backends are used only as the rules allow, with personal data redacted before anything
> leaves ([spec/redaction.md](spec/redaction.md)), and every request gets a signed receipt saying
> where it ran and what left the node ([spec/receipts.md](spec/receipts.md)). The **Autobot Agent**
> runs on the gateway on a VPS or desktop, with tools, approvals, a terminal chat and a Telegram
> bot, and one script installs both. Autobot's protocol layer matches the node byte for byte and
> pairs with a live node ([autobot#2](https://github.com/wckdboy/autobot/pull/2)), and the Android
> app drives the agent through the paired gateway, approvals and scheduled tasks included, and
> shows the node's signed receipts in each turn's privacy receipt
> ([autobot#3](https://github.com/wckdboy/autobot/pull/3), released in
> [Autobot 1.9.0](https://github.com/wckdboy/autobot/releases/tag/v1.9.0); iOS, agent screen
> included, in 1.10.0). Every request lands in a hash-chained audit log
> ([spec/audit.md](spec/audit.md)) the phone can read, and a phone recipe can be handed to the node
> to run there with its results collected back
> ([Autobot 1.10.0](https://github.com/wckdboy/autobot/releases/tag/v1.10.0), Android and iOS). Latest release:
> [v0.0.5](https://github.com/wckdboy/invincible/releases/tag/v0.0.5) (static Linux and macOS
> binaries, reproducible, with build attestations, signed with a pinned key; it includes fixes
> from an internal security review, while the independent one is still to come). An eval suite of
> 50 tasks built from Autobot, Omnie and Nightfall code runs on local models; the comparison with
> a frontier model is still to do. Work is tracked in Plane (project **INV** in the WCKD workspace).

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

Model training, a chat UI, identity systems, federation between strangers. Each may come later or
become its own project.

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
  behaviour.
- **Conformance vectors:** input → expected output cases in plain JSON. Invincible's Rust tests and
  Autobot's Kotlin tests both run them, so a rule change that only lands on one side fails CI on the
  other.

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

One script installs **Invincible Gateway** (`invincible`) and the **Autobot Agent** (`autobot`) as
one product, on macOS (Apple silicon) or Linux (x86_64, arm64), without root:

```sh
curl -fsSL https://raw.githubusercontent.com/wckdboy/invincible/main/install.sh | sh
```

It puts both commands in `~/.local/bin`: the latest release's static binaries (macOS arm64, Linux
x86_64 and arm64). The release's `SHA256SUMS` must carry a valid signature from the release key
pinned in the script (an SSH signature, checked with `ssh-keygen`), and the archive must match
it; when the GitHub CLI is signed in, the archive's Sigstore build attestation is checked too.
Without a signed release it builds them from source (installing Rust with rustup if needed). It installs llama.cpp if it is missing (Homebrew on macOS; otherwise a pinned upstream build checked
against its SHA-256, the CUDA build when an NVIDIA GPU is present), then runs `autobot setup`:

1. **Network** for the whole machine: `offline`, `direct`, or Tor / SOCKS5. The gateway's cloud
   backends and the agent's Telegram bot both follow it.
2. **Model**: a Qwen open-weights model sized to the machine's memory (Qwen3.5 4B, Qwen3.5 9B,
   Qwen3.8 27B), downloaded and checked, or any `hf:` GGUF.
3. **Agent**: its working directory, and whether its turns stay on local models (the default).
4. **Telegram** (optional): a bot token from @BotFather.
5. **Background**: the gateway and the agent as launchd agents on macOS or systemd user units on
   Linux (with linger, so they run after you log out of a VPS).

Then:

```sh
autobot              # chat in the terminal
autobot code         # code in this directory (see "Code with Autobot")
autobot run "task"   # one task, no questions: anything not allowlisted is refused
autobot doctor       # check the gateway, the model, the tools, Telegram and the services
autobot cron add "@daily" "check disk space and warn me if a disk is over 90% full" --telegram
```

Releases are built by [`release.yml`](.github/workflows/release.yml) on a `v*` tag; each archive
carries a build-provenance attestation (`gh attestation verify <archive> --repo wckdboy/invincible`).
The Linux builds are reproducible: before publishing, the workflow builds the x86_64 archive a
second time on another machine and refuses to publish unless the bytes match. To check one
yourself, build the tagged commit from `/tmp/invincible-src` with the flags in `release.yml`.
`SHA256SUMS` is signed with the release key, which lives only as a GitHub secret. To check a
download by hand:

```sh
echo 'invincible-release ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAII/0fXPq1j51BcfGY0Jp9QfPGy6kHVQQ+W282VFPR/Qo' > allowed_signers
ssh-keygen -Y verify -f allowed_signers -I invincible-release -n invincible-release -s SHA256SUMS.sig < SHA256SUMS
shasum -a 256 -c SHA256SUMS
```

## Code with Autobot

`autobot code` works on the project in the current directory, next to Claude Code or opencode,
with its model behind your own gateway: every call receipted and in the audit log, cloud use
confirmed once per session, private work on local models.

```sh
cd ~/src/my-project
autobot code --model deepseek --approvals edits
```

- **The terminal:** answers stream in as Markdown (headings, lists, code blocks); each tool call is a line
  (`⏺ Read src/main.rs`, `⏺ Run cargo test`) with what it gave back (`⎿ 3 matches in 2 files`,
  the last lines of a command and its exit code); every change shows as a colored diff before
  it is made; the agent's task list (`todo`) shows as checkboxes; a spinner shows what it is
  thinking. Approvals take one key: `y`, `a` (always, this session), `n`. ctrl+c stops a turn;
  the conversation stays usable.
- **The project:** its `AGENTS.md`, `CLAUDE.md` or `.autobot/AGENTS.md` become part of the
  agent's instructions; in a git repository it works like a careful engineer (find, read, change
  in small edits, run the build and tests, never commit unless asked). `search` (regular
  expressions over the files, `.gitignore` respected) and `find_files` (globs) find code without a
  shell command to approve; `read_file` reads long files in parts.
- **Control:** `edits` approvals let changes in the project run without asking (commands still
  ask); `/undo` puts back every file the last turn changed and hands its request back to edit.
  `@path` attaches a file (tab completes), `!command` runs one yourself and hands its output to
  the next message, alt+enter starts a new line.
- **Commands:** `/model` (list, or switch: a cloud model lets turns leave the machine, and the
  conversation sent per call grows with its context), `/approvals`, `/private`, `/tools`,
  `/context`, `/diff`, `/undo`, `/status`, `/new`, `/fork`, `/sessions`, `/resume`, `/memory`,
  `/skills`, `/team`, `/board`, `/help`. One conversation per project (`code-<name>-<hash>`).
- **From other tools:** `autobot run -C DIR --model M --approvals edits --cloud "task"` does one
  task with nobody to ask (`--cloud` confirms cloud use for that run, nothing else); `--json`
  prints every event as a JSON line (text, tool calls, outputs, diffs, receipts) and the answer
  last, so Claude Code, opencode or a CI job can hand Autobot work and read what it did.

## The Autobot Agent

The same agent as on the phone, for a machine that is always on. It is written in Rust
([`crates/autobot`](crates/autobot)) and uses the gateway on the same machine as its only model
provider, so the gateway's rules hold for every agent turn: routing, redaction, receipts.

- **Tools:** `terminal` (a shell command in the working directory, with a timeout), `read_file`,
  `write_file`, `edit_file` (replace an exact piece of a file), `list_dir`, `web_fetch` (a page as
  text, through the gateway: under the node's network mode, so offline means no fetch and Tor
  carries it; HTTPS only; receipted and in the audit log; it asks first, and unattended runs may
  fetch only sites in the allowlist, written `https://docs.rs`), `search` and `find_files`
  (ripgrep's walker: `.gitignore` respected), `todo` (its task list for a longer job). Results
  are cut to a size small local models can take, larger for models with large contexts
  (`[agent] context_kib`, or set by `/model`). Answers stream (`[agent] stream`).
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
  of it is summarized first, on the gateway like any call, and the summary leads the next prompt,
  so a long conversation is condensed, not forgotten.
- **Memory:** the agent keeps short facts with `remember` (your preferences, where things are,
  decisions) in `~/.autobot/memory.jsonl`, and every later conversation starts with them, newest
  first. `autobot memory` lists them; `autobot memory --forget 3` removes one.
- **Skills:** how-to notes you give it, one Markdown file each in `~/.autobot/skills/` (a
  `description:` line in front matter, or the first line, says what it is for). The agent sees
  their names and descriptions, and reads one with `read_skill` when it fits the task.
  `autobot skills` lists them. The agent can also **propose** one (`propose_skill`) after a
  multi-step task that worked and will come up again; a proposal is never used until you keep it
  (`autobot skills accept <name>`, `/skills accept <name>` in Telegram, or the app), since a skill
  is instructions the agent will follow.
- **Search over past conversations:** `search_sessions` finds what was said or decided before
  (words in your messages, its answers and conversation summaries).
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
- **Agent API** ([spec/agent.md](spec/agent.md)): `autobot serve` also listens on loopback
  (`127.0.0.1:7792`), and the gateway passes `/v1/agent` through to it with its token. A paired
  device can therefore start turns, watch their events (tool runs, receipts, approval questions,
  the answer) and answer approvals, all inside its Noise session. Nothing new is exposed: the
  agent is reachable only from this machine and from devices you paired.

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
- Engines run as child processes with their logs in `~/.invincible/logs/`. A crashed engine is
  restarted with backoff, and stopping the node stops its engines.

### Cloud backends (optional)

Any OpenAI-compatible endpoint works: OpenAI, Anthropic's compatibility endpoint, DeepSeek,
OpenRouter, a friend's node. Keys live in files or environment variables, never in the config.

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

### Receipts

Every chat completion answers with `invincible-request-id`. Once the answer is complete,
`GET /v1/receipts/<id>` returns a receipt signed with the node's Ed25519 key (`GET /v1/node` has the
public key; paired devices receive it when they pair). It records the routing decision, tokens, what
was redacted, and every attempt to reach a host off the node, with bytes sent and received. An empty
`egress` list is a signed statement that nothing left the node. Receipts never contain prompt or
answer text.

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
invincible join '<code>' --name laptop   # on the other machine: pairs, pins the node's key
invincible tunnel                    # on that machine: http://127.0.0.1:7780 now leads to the node
                                     # (with that machine's token, `invincible token`: web pages cannot use it)
invincible devices                   # on the node: who is paired
invincible devices --remove laptop   # unpair: refused at the next handshake or frame
```

On macOS with the application firewall on, the first remote connection can wait for the "accept
incoming connections?" prompt for `invincible` (or `System Settings › Network › Firewall`): allow it,
or pairing hangs until it times out.

Paired devices reach the inference API with no token (their key authenticates them) and never the
admin endpoints. Autobot pairs by scanning the same QR code: its protocol layer is in
[autobot#2](https://github.com/wckdboy/autobot/pull/2), and the screens are INV-14. The protocol is in
[spec/pairing.md](spec/pairing.md). It is tested, including the refusal cases, but it has **not been
independently reviewed yet**.

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
differ; `--out results.json` keeps every answer, check and receipt id. Thinking models are asked
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
| `crates/invincible` | Invincible Gateway (the node): config, engine supervisor, local API, pairing and remote access, and the `invincible` command |
| `crates/autobot` | The Autobot Agent: agent loop, tools, approvals, sessions, Telegram, setup, doctor, services, and the `autobot` command |
| [`install.sh`](install.sh) | The installer for both |
| [`evals/`](evals/) | Task files for `invincible eval` |

```sh
cargo test --workspace                                  # includes every conformance vector
cargo clippy --workspace --all-targets -- -D warnings
cargo run -p invincible -- route input.json             # where would this request run?
cargo run -p invincible -- serve --config path/to/config.toml   # run a node
cargo run -p autobot -- doctor                          # check an agent install
```

## Principles

- **Local is the default.** Leaving hardware you own is always a choice, visible and reversible.
- **No phoning home.** No telemetry, no update checks you did not ask for, no accounts.
- **Owned means owned.** Your keys, your weights, your logs, your machine.
- **Frontier-optional, never frontier-dependent.** Every feature has a path that works without a
  third party.
- **Open source, reproducible, signed.**

## Open questions

- Region tier: trusted operators only, or a design that is safe with strangers' compute?
- How Autobot consumes `spec/`: a git submodule, or vectors vendored by a sync script.

## License

[MIT](LICENSE). Every dependency is under a license compatible with it (MIT, Apache-2.0, BSD,
ISC, Unicode), which `cargo deny` checks in CI.
