# Invincible

**Intelligence that never relies solely on frontier labs, corporations or countries.**

Invincible is a self-hosted AI node. Install it on hardware you own (a desktop, a GPU box, a rack in
your hackerspace) and it gives every device you own one endpoint for intelligence. It runs open
models itself, reaches frontier models when you allow it, and keeps working when they are gone.

Frontier models are welcome here. Being dependent on them is not. Everything works without them;
they make it faster when you choose to use them.

> Status: **design.** Nothing is built yet. This document is the plan.

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
| `:agent:core` (Kotlin Multiplatform, JVM + iOS) | The same agent runtime runs **on the node** on the JVM: one agent loop, three hosts (Android, iOS, node) |

The last row is the key decision. Autobot's policy layer is already shared Kotlin Multiplatform
code: wire formats, network policy, redaction, data policies, receipts, the agent loop. If the node's
control plane is Kotlin/JVM and depends on that shared code, a privacy fix lands on the phone and the
node at once, and the two can never disagree about a rule.

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
   pairing · policy router · agent host (:agent:core on JVM) · receipts · audit log · evals
        │                    │                         │
  engines (child processes)  frontier providers         other nodes (later: region tier)
  llama.cpp · MLX · vLLM     through redaction + route
```

- **Control plane:** Kotlin/JVM, depending on Autobot's `:shared` and `:agent:core`.
- **Engines:** separate processes that the control plane supervises, never linked in. A crashing
  engine cannot take the node down, and engines can be swapped freely.
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

## Principles

- **Local is the default.** Leaving hardware you own is always a choice, visible and reversible.
- **No phoning home.** No telemetry, no update checks you did not ask for, no accounts.
- **Owned means owned.** Your keys, your weights, your logs, your machine.
- **Frontier-optional, never frontier-dependent.** Every feature has a path that works without a
  third party.
- **Open source, reproducible, signed.**

## Open questions

- Hardware targets for v0: Apple silicon (MLX), NVIDIA (vLLM), or both?
- Region tier: trusted operators only, or a design that is safe with strangers' compute?
- Whether Autobot's `:shared` is consumed as a Maven artifact or a git submodule.
- License: Autobot ships under Apache-2.0; Invincible likely the same.
