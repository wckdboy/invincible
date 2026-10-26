# Invincible: the architecture

One gateway for every model you run, on the hardware you have, across the machines you own,
with the training to make the models yours. Frontier models only by your policy, a signed receipt
for every call, and the hard parts of AI made plain. This document is the target shape of the
node and how today's code grows into it. The plan, with exit criteria, is [ROADMAP.md](ROADMAP.md).
The rules both Invincible and Autobot must agree on are normative in [spec/](spec/) and pinned
by conformance vectors; this document is not normative, and where the two differ the spec wins.

**Reading the states.** *Shipping* is in a stable release. *Edge* is on main and in the edge
builds, not yet in a stable release. *Branch* is implemented on a branch and not yet merged.
*Planned* is designed here and nowhere else yet. *Deferred* is designed but set aside, with the
reason given.

## The one picture

```
 clients ───────────────────────────────────────────────────────────────────────────────────
  Autobot (phone, terminal, Zed)   other apps (planned)     any OpenAI / Anthropic client
        │ Noise session                  │ Noise or token          │ HTTPS + local token
        └──────────────────────┬─────────┴──────────────────────────┘
 control plane ─────────────────┴─────────────────────────── invincible (Rust, one static binary)
  pairing · policy router · redaction · receipts · audit · evals · tune · cluster · train · ops
        │ loopback only                 │ shard links (Noise)            │ redaction + egress
 engine plane ───────────────   cluster plane ──────────────   cloud ──────────────────────────
  child processes on loopback    paired nodes you own           frontier providers, by policy
  text · speech · images ·       heads and shards, layer split  OpenAI, Anthropic, DeepSeek, …
  video · embeddings · training  (llama.cpp RPC today)
```

Six planes, one process in the middle. Everything that holds a key or faces a network is the
control plane; everything that does arithmetic is an engine the control plane supervises and can
lose without going down; everything that crosses a machine boundary is a Noise session between
keys pinned at pairing.

## 1. Control plane: the node

Rust, one static binary, `invincible`. It owns ports, tokens, keys, logs and every policy
decision. Its modules today, and what they become:

| Module | Today (shipping) | Target |
|---|---|---|
| `server` | OpenAI and Anthropic APIs: `/v1/models`, `/v1/chat/completions`, `/v1/messages`, `/v1/audio/speech`, `/v1/images/generations`, receipts, audit, node info, the agent passthrough | adds `/v1/embeddings`, `/v1/audio/transcriptions`, `/v1/video/generations`, `/v1/cluster`, `/v1/train`, `/v1/tune`; the same shapes for every modality, so a client changes one URL |
| `engine` | one kind, `llama-server`, supervised with restart | one contract for every engine kind (section 2) |
| `models` | GGUF by source (`hf:`, URL, path), hash-verified, a memory fit rule, `model add` | a catalog per modality (text, speech, image, video, embedding, adapter), each entry with its engine, format, licence and the measured numbers from `tune` |
| `invincible-policy` | routing, egress, network mode; vectors shared with Autobot | adds cluster links and partitioning (edge), tune profiles, training receipts |
| `redact`, `receipts`, `audit` | personal data replaced before the cloud; a signed receipt per request; a hash-chained log | unchanged in kind; receipts gain the nodes, engines and adapters that took part |
| `devices`, `remote`, `relay` | Noise pairing, sessions, the encrypted pipe carrying HTTP | the same pipe carries shard links (mode `0x03`) and, later, training sync |
| `eval` | `invincible eval`: your tasks against local and frontier models, every run kept | the gate for `tune` (a setting that is faster but worse does not win) and for `train` (an adapter that does not beat its base is not served) |
| `service`, `update`, `watchdog`, `token` | launchd and systemd, self-update from signed releases, health, the local token | Windows Task Scheduler (branch), packages (planned) |
| `cloud` | frontier providers through redaction and the route | unchanged; data-policy labels per model |

Invariants the control plane keeps, whatever grows around it:

- **Local is the default.** Every request runs on hardware you own unless the route says otherwise.
- **Nothing is exposed.** Listens on loopback and paired interfaces; engines on loopback only; no
  port of an engine is ever reachable from another machine except through a Noise session.
- **Codes, never content.** Receipts, audit lines, reasons and errors carry stable codes, not
  prompt text.
- **Fail closed.** An unknown mode is offline, an unknown policy is never, an unknown tier is
  cloud, an errored verifier is a refusal.
- **One rule, two languages.** Anything Autobot must agree with is a spec with vectors, not code.

## 2. Engine plane: every kind of model

An engine is a child process the node launches on a loopback port, speaks a known API to, and can
kill. It is never linked in. Today there is one kind; the target is one contract and many kinds.

**The contract** (planned; `llama-server` is the first implementation):

| Part | What the node asks of an engine |
|---|---|
| Manifest | modalities (text, speech-in, speech-out, image, video, embedding, train), formats (GGUF, safetensors, Core ML, ONNX), devices it can use, the API shape it speaks |
| Launch | a command line from the model entry and the tune profile; a loopback port the node chose; the node's own working directory and cache |
| Health | a readiness probe, a liveness probe, a bounded silence rule (an engine that sends nothing for too long is hung, and the answer ends with an error the client can tell from a cut connection) |
| Supervision | restart with back-off, crash counted, the model marked unavailable after too many; stopping leaves nothing running |
| Metrics | tokens or frames per second, time to first token, memory, per request; written to the receipt and the tune store |
| Receipt fields | engine, version, devices, adapter |

**Engines by modality.** Managed means the node installs, launches and supervises it like
`llama-server`; passthrough means the node forwards to a server you run, with receipts.

| Modality | Today | Target engines | State |
|---|---|---|---|
| Text | llama.cpp (`llama-server`): Metal, CUDA, ROCm, Vulkan, CPU; GGUF | llama.cpp stays the universal engine; MLX on Apple silicon and vLLM / SGLang on NVIDIA as faster engines behind the same contract, chosen by `tune` | shipping; faster engines planned |
| Speech in | passthrough to whisper.cpp's server or faster-whisper (`[voice]`) | whisper.cpp managed; `/v1/audio/transcriptions` | passthrough shipping; managed planned |
| Speech out | passthrough to Kokoro (`[[speech]]`) | Kokoro managed | passthrough shipping; managed planned |
| Images | passthrough to an OpenAI-shaped image server (`[[images]]`) | stable-diffusion.cpp managed (SD 1.5, SDXL, Flux in GGUF), the same models Autobot runs on the phone; LoRA and upscalers | passthrough shipping; managed planned |
| Video | none | one managed engine first (an open video model with a GGUF or safetensors runtime that fits on a single GPU or Apple silicon), `/v1/video/generations` returning a job and a file; delivered as a file on every channel | planned |
| Embeddings | none through the API | llama.cpp embeddings, `/v1/embeddings`; the vault on the phone syncs to it | planned |
| Training | none | `mlx_lm.lora` on Apple silicon, PEFT on CUDA, launched as engines (section 4) | planned |

Every modality follows the same three rules: your own engine first, the cloud only when the route
allows, a receipt either way. A request that names `auto` gets the engine `tune` chose for this
machine.

## 3. Auto-tune: the node measures itself

Running a model well is the weekend of glue the node exists to remove: which quantization, how
many layers on the GPU, how much context, which batch size, flash attention or not, which KV cache
type, whether a draft model helps. Today the node has a memory fit rule (`models::memory_budget`,
`needed`), `--list-devices`, and benchmarks that run on demand; on edge, `invincible tune probe`
reports the machine and its engines, and `invincible tune bench <model>` keeps `llama-bench`'s
numbers in `$INVINCIBLE_HOME/tune/`, which the cluster's planner reads. The target is a profile
per machine that the node measures, stores and uses. State: the probe and the bench on edge; the
search, the profile and the choice planned.

**Probe** (`invincible tune probe`): CPU, memory, every accelerator with its own memory, the
engine builds present (Metal, CUDA, ROCm, Vulkan, RPC), disk and its read speed, the links to each
paired peer (round trip, throughput). No personal data; the same shape as Autobot's Compute report.

**Calibrate** (`invincible tune`): a short `llama-bench` run per engine and quantization family
on a small model (prompt processing and generation tokens per second), then for each installed
model a search over the few settings that matter (gpu layers, context, batch and micro-batch,
flash attention, KV cache type, threads), bounded in time, on the real model. Speculative decoding
with a draft model is tried when one is available. Every run is kept with its numbers.

**Choose**: the fastest setting that fits with headroom and does not lower the eval score (the
eval gate: a quantization that answers faster but worse on your tasks does not win). The profile
is a file in `$INVINCIBLE_HOME/tune/` the model entries reference; `invincible tune show` prints
it in plain words with the numbers; `invincible model add --auto` uses it. A hardware change
(a new GPU, a peer joining) invalidates the parts that depend on it, not the whole profile.

**Across the cluster** the same numbers feed partitioning (speed-aware shares, phase 2 of the
cluster spec) and placement (which node runs a model whole).

## 4. Cluster plane: many nodes, one model

Designed in [spec/cluster.md](spec/cluster.md); phase 1 is on main (edge), unaudited, and off
unless configured: a model's `cluster` list makes this node split that model across the paired
nodes it names (a head), and `[cluster] serve = true` lends this node to the heads in
`[cluster] heads` (a shard). Either works without the other. The short form, so this document
stands on its own:

- **Only paired devices**, and shards name the heads that may run work on them. llama.cpp's RPC
  server (no authentication, no encryption) listens on loopback only; the only way in from another
  machine is a shard link: a Noise session with the same keys pairing pinned, mode byte `0x03`,
  carrying the RPC byte stream.
- **The link rule** is normative: loopback is direct; `offline` blocks; a host that is not on a
  local network blocks; otherwise direct, never through Tor or SOCKS5.
- **Partitioning** is normative: layer-wise pipeline split sized by memory, largest-remainder
  rounding, the head keeps the last layers; a model that fits on one device stays there.
- **Receipts name every node** that computed part of an answer; the model is still `tier: node`,
  data policy `owned`, so private requests may run on it.
- **Failure** ends the answer with an error event, replans over the devices that remain, and the
  router uses something else meanwhile.
- **Phases**: 1 two paired nodes (edge) · 2 real machines: mDNS, calibration, speed-aware plans,
  local weights · 3 resilience · 4 placement · 5 wired fast paths (tensor parallel over 10 GbE and
  RDMA, owned machines only) · 6 phones as shards (charging, Wi-Fi, cool): **deferred**, because
  phones and tablets pair as clients, never as heads or shards. iOS does not let an app start a
  child process at all, and on Android a phone would be a node only while awake, plugged in and
  cool; serving them would need an engine linked in, against the rule that engines are processes.

What Invincible takes from the field: exo's memory-weighted allocation and "the smallest set of
devices that holds it"; llama.cpp RPC as the phase 1 engine; Petals' replay-on-failure; MLX's
distributed primitives for Apple-only clusters later. What it does not take: trusting what
discovery finds, running RPC on the network, tensor parallel over Wi-Fi.

## 5. Training plane: decentralized fine-tuning

The same cluster that serves a model trains one. Designed in the cluster spec's training section;
all of it planned.

| Phase | What | Engine | Sync |
|---|---|---|---|
| T1 | `invincible train`: LoRA on one device, datasets in `$INVINCIBLE_HOME/datasets` with manifests (hash, source, redaction state), adapters served under a new id after an eval run against the base, signed training receipts (base, dataset hash, devices, result hash) | `mlx_lm.lora` (Apple silicon), PEFT (CUDA), launched as engines | none |
| T2 | data-parallel LoRA across the machines you own | the same | DiLoCo-style: many local steps, an outer step on the averaged change; a slow or absent worker does not stall the run |
| T3 | federated LoRA with phones: each phone trains on its own data and sends only the adapter update; the data stays on the device. **Deferred**: phones are clients (section 4); a laptop that sleeps could take the phone's place | Autobot's on-device engines | adapter averaging over the paired session |
| T4 | larger runs: pipeline-parallel training across machines | PyTorch, MLX distributed | DeMo compression on slow links |

The runs exist today: `invincible eval` keeps every frontier and local run, and `autobot eval
--trajectories` exports the passing ones in a trainer's format. Training a local model on a
frontier model's runs is **pending a licence gate**, which is not built: a provider's terms can
forbid using its outputs to train another model, so the gate is to check each model's terms
before its runs become training data. The eval gate decides whether an adapter ships: an adapter
that does not beat its base on your tasks is kept with its numbers and not served.

## 6. Platforms

| Platform | State |
|---|---|
| macOS (Apple silicon) | shipping: static binary, launchd, Metal |
| Linux (x86_64, arm64) | shipping: static binary, systemd, CUDA, ROCm, Vulkan, CPU |
| Windows (x86_64, arm64) | branch (PR #14): PowerShell where `sh -c` was, Task Scheduler services, ACLs where files were 0600, `install.ps1`, CI on windows-latest |
| Packages | planned: Homebrew formulas, `.deb` and `.rpm`, signed MSIX and winget, an Intel Mac build |
| Phones | through Autobot: paired devices that drive a node, as clients; shards and federated trainers deferred (section 4) |

One engine and one model format on every platform is why llama.cpp stays the universal engine
even when faster ones exist for one vendor.

## 7. Security, speed, anonymity, stability

These are the four properties the rest serves. Each has a mechanism today and a measure.

| Property | Mechanism | Measured by |
|---|---|---|
| Security | Noise pairing with pinned keys; engines and RPC on loopback only; redaction before the cloud; signed receipts; a hash-chained audit log; reproducible, attested releases signed with a pinned key; `cargo deny` on licences and advisories; secrets in the OS keychain or TPM / Secure Enclave (planned) | the conformance vectors; the internal review (done); the independent review of pairing and remote access (planned, INV-21); a written threat model (planned) |
| Speed | the fastest engine build the machine has; `tune probe` and `tune bench` (edge), the tuned profile (planned); speculative decoding (planned); micro-batched prefill and speed-aware partitioning in the cluster (planned) | `bench/run.sh` every night, its numbers in that CI run's summary; tokens per second and time to first token in every receipt (planned) |
| Anonymity | offline by default; Tor and SOCKS5 as routes with the kill switch as a shared, tested rule; no accounts, no telemetry; an onion service to reach home (not built) | the egress vectors; the audit log showing nothing left |
| Stability | always on under launchd, systemd or Task Scheduler; health checks; self-update from signed releases; one-file backups with checksums; stopping leaves nothing running; alerts to your chat | the ten-minute soak test every night; the restart counters in the service status |

The threat model, written down (planned, with the independent review): who the attacker is (a
device on your LAN, a compromised peer, a cloud provider, a malicious model file, a prompt
injection), what each can reach, and which rule stops them.

## 8. Made plain

The rule for every feature: one command per job, plain words, a number you can check, and when
it cannot, it says so. The commands, today and planned:

| Job | Today | Planned |
|---|---|---|
| Serve a model | `invincible model add hf:…`, `invincible serve` | `invincible model add --auto` picks engine and settings from the tune profile |
| Know what it costs you | `invincible receipts`, `/v1/receipts/{id}`, the audit log | a `cost` line per receipt in tokens, seconds and, for the cloud, money |
| Measure before believing | `invincible eval` | the gate wired into `tune` and `train` |
| Find out what is wrong | `autobot doctor`; `invincible doctor` (edge) for the node: engines, devices, links, services, with what to do about each | none |
| Run a model bigger than one box | `invincible join`; on edge, `invincible cluster status` | `invincible cluster plan <model>` shows the split and the expected speed before it runs |
| Teach it your work | the eval history | `invincible train`, `invincible adapters` |
| Understand a decision | reason codes in receipts | `invincible explain <receipt>`: why this route, this engine, these nodes, in sentences |
| Deploy at scale | one static binary, `install.sh`, `invincible update` | packages; a config a fleet can share with the keys kept out |

Documentation follows the same rule: the README states the limit as plainly as the feature, and
the site shows the same status table the README does.

## 9. Non-goals

- Strangers' compute. A region tier of other people's nodes needs verification, payment and
  privacy against the operator; it is a separate design and the open question in the README.
- Pretraining from scratch. Fine-tuning and continued training of open models are in scope.
- A chat UI. Autobot is the client; other apps, Niobium among them, are planned.
- Identity systems and accounts. Pairing is the identity.
