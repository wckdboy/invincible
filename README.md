# Invincible

**Intelligence that never relies solely on frontier labs, corporations or countries.**

Invincible is a self-hosted AI node. Install it on hardware you own (a desktop, a GPU box, a rack in
your hackerspace) and it gives every device you own one endpoint for intelligence. It runs open
models itself, reaches frontier models when you allow it, and keeps working when they are gone.

Frontier models are welcome here. Being dependent on them is not. Everything works without them;
they make it faster when you choose to use them.

> Status: **early build.** A node serves open models through llama.cpp behind an OpenAI-compatible
> API, every request goes through the routing rules ([spec/routing.md](spec/routing.md), pinned by 51
> conformance vectors), and devices pair with it over Noise ([spec/pairing.md](spec/pairing.md),
> implemented but not yet independently reviewed). Cloud backends are used only as the rules allow,
> with personal data redacted before anything leaves ([spec/redaction.md](spec/redaction.md)). Not
> yet: Autobot's side of pairing, receipts, agents, evals, the installer. Work is tracked in Plane (project **INV** in the
> WCKD workspace).

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
| `:agent:core` (Kotlin Multiplatform, JVM + iOS) | The node runs a Rust agent host with the same semantics (session log, ReAct loop, permission presets, fail-closed approvals), so a session can move between phone and node |

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
 Autobot (Android / iOS)          other tools (any OpenAI / Anthropic client)
        │ Noise channel                     │ HTTPS + local token
        └──────────────┬────────────────────┘
               invincible node (control plane)
   pairing · policy router · agent host · receipts · audit log · evals          (Rust)
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

## Install (target)

```sh
curl -fsSL https://invincible.sh | sh     # or: download, verify signature, run
invincible model add <open-model>         # pull, verify, serve
invincible provider add anthropic         # optional frontier backend
invincible route add private → local
invincible pair                           # show the QR code for Autobot
```

The installer and every release are signed, and builds are reproducible, so you can check what you
run without trusting us.

## v0 milestone

Done when, with the internet unplugged:

1. One node, installed by the script, serves one strong open model.
2. Autobot pairs with it and runs a real agent session on it, end to end.
3. A recipe handed to the node runs past Autobot's 8-minute on-device limit and delivers its result.
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
- Before a request leaves, emails, IBANs, card numbers and phone numbers become placeholders
  (`[EMAIL_1]`); the answer gets the real values back, streams included. The
  `invincible-redacted` header counts what was hidden. Names and addresses are not detected on the
  node yet (Autobot does detect them on the phone).
- A backend that fails (no connection, 429, 5xx) is skipped for 30 seconds, and the request is
  routed again: usually to a local model, with `"fallback": true` and the reason `cloud-down`.

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
invincible devices                   # on the node: who is paired
invincible devices --remove laptop   # unpair: refused at the next handshake or frame
```

Paired devices reach the inference API with no token (their key authenticates them) and never the
admin endpoints. Autobot will pair by scanning the same QR code (INV-14). The protocol is in
[spec/pairing.md](spec/pairing.md). It is tested, including the refusal cases, but it has **not been
independently reviewed yet**.

## Repository

| Path | What |
|---|---|
| [`spec/`](spec/) | The rules Invincible and Autobot share, with conformance vectors |
| `crates/invincible-policy` | The routing rules as a pure Rust library, tested against `spec/vectors/` |
| `crates/invincible` | The node: config, engine supervisor, local API, pairing and remote access, and the `invincible` command |

```sh
cargo test --workspace                                  # includes every conformance vector
cargo clippy --workspace --all-targets -- -D warnings
cargo run -- route input.json                           # where would this request run?
cargo run -- serve --config path/to/config.toml         # run a node
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
- License: Autobot ships under Apache-2.0; Invincible likely the same.
