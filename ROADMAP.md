# Invincible roadmap

The plan for the architecture in [ARCHITECTURE.md](ARCHITECTURE.md): milestones in the order they
ship, each with the exit criteria that make it done and the Plane items that track it (project
**INV**). A milestone is done when its criteria hold on real hardware, the README and
invincible.sh say so, and Plane has it.

## Rules

- **Local first, honest second.** Nothing ships that needs a third party, and the site says what
  works and what does not, with the numbers.
- **Spec before code** for anything Autobot must agree with: a document in `spec/` and vectors
  that fail under the old rule.
- **Measured, not claimed.** A speed or a quality is a number from `bench/run.sh` or
  `invincible eval`, kept, with the hardware it came from.
- **Engines are processes.** No engine is linked into the node. Ever.

## Milestone 0 · 0.0.x: the node, hardened *(now)*

What ships today and is being finished.

| | Item | Plane |
|---|---|---|
| ✅ | Gateway, routing, redaction, receipts, audit, pairing, always-on, bots, channels, evals, backups, alerts | shipped through v0.0.21 |
| 🔶 | Cluster phase 1: one model split across two paired nodes, merged to main (edge, not yet in a stable release), off unless a model's `cluster` list (on a head) or `[cluster] serve` (on a shard, which also needs `[remote] listen` and the heads it allows in `[cluster] heads`) turns it on, measured; left: clean numbers on a quiet machine, review, a stable release | INV-58, INV-59 |
| 🔶 | Windows: builds, Task Scheduler services, `install.ps1`, CI on windows-latest (PR #14); left: the full test run, release builds, ACLs, a real install | INV-50 |
| ✅ | `invincible doctor`: every subsystem, with what to do about each, `✗` exits 1 | made plain |
| ⬜ | Independent security review of pairing and remote access | INV-21 |
| ⬜ | Encrypt node and agent data at rest, key in keychain / TPM / Secure Enclave | INV-26 |
| ⬜ | Native packaging: Homebrew, `.deb` / `.rpm`, signed MSIX + winget, Intel Mac | INV-54 |

**Exit:** v0.1.0: Windows in the release matrix, the cluster in a stable release and still off
unless configured, the review scheduled, packages for at least macOS and Debian.

## Milestone 1 · 0.2: every kind of model

Managed engines for the modalities that are passthrough today, and the API routes the other
modalities lack.

| | Item | Exit criterion |
|---|---|---|
| ⬜ | The engine contract: manifest, launch, health, supervision, metrics, receipt fields; `llama-server` moved onto it | a second engine kind runs through the same code path with no special cases in the router |
| ⬜ | whisper.cpp managed; `/v1/audio/transcriptions` | a voice note on any channel is transcribed by an engine the node installed, with a receipt |
| ⬜ | Kokoro managed | `[[speech]]` needs no external server |
| ⬜ | stable-diffusion.cpp managed: SD 1.5, SDXL, Flux (GGUF), LoRA, upscalers; `invincible model add` for image models | `generate_image` from a bot runs on the node's own engine; Autobot's phone catalog and the node's agree on formats |
| ⬜ | `/v1/embeddings` through llama.cpp | the phone's vault syncs to the node and searches there |
| ⬜ | Video: research, then one managed engine and `/v1/video/generations` as a job returning a file | a short clip generated on one Apple silicon or NVIDIA machine, delivered on a channel, with a receipt |

**Exit:** the status table on invincible.sh shows text, speech in and out, images and embeddings
as *working*, video as *working* or *one engine, slow*, each with a measured number.

## Milestone 2 · 0.3: auto-tune

The node measures itself and picks the settings.

| | Item | Exit criterion |
|---|---|---|
| ⬜ | `invincible tune probe`: devices, memory, builds, disk, links; the same shape as Autobot's Compute report | the report from any machine says which engines can run and why |
| ⬜ | `invincible tune`: `llama-bench` calibration per engine and quantization family; a bounded search per installed model (gpu layers, context, batch, flash attention, KV type, threads); speculative draft when available | on three machines (Apple silicon, NVIDIA, CPU-only), tuned settings beat the defaults on tokens per second without lowering the eval score |
| ⬜ | Profiles in `$INVINCIBLE_HOME/tune/`, referenced by model entries, invalidated by hardware change; `invincible tune show`, `invincible model add --auto` | a fresh install serves a model with one command and no flags |
| ⬜ | Faster engines behind the contract where they win: MLX on Apple silicon, vLLM or SGLang on NVIDIA; `tune` chooses | the chooser prefers them only where the measured number is better |

**Exit:** `curl … | sh`, `invincible model add --auto hf:…`, `invincible serve` is the whole
setup on every supported platform, and the numbers it chose are shown and kept.

## Milestone 3 · 0.4: the cluster, usable

Cluster phases 2 to 4.

| | Item | Plane |
|---|---|---|
| ⬜ | Phase 2: mDNS rediscovery of pinned peers, calibration numbers in capabilities, speed-aware plans, shards reading weights from their own disk, the installer shipping `ggml-rpc-server` | INV-60 |
| ⬜ | Phase 3: resume after a reshard, relaunch when a peer returns, micro-batched prefill | INV-61 |
| ⬜ | Phase 4: placement: a whole model on a peer, the router choosing head, peer or split per request | INV-62 |
| ⬜ | `invincible cluster plan <model>`: the split and the expected speed before it runs | made plain |

**Exit:** on a desk with two owned machines on Ethernet, a model that fits neither runs at
≥ 70% of what a single machine that could hold it would do, with the number published; a peer
pulled mid-answer ends that answer cleanly and the next request succeeds.

## Milestone 4 · 0.5: training on one device, then across devices

| | Item | Plane |
|---|---|---|
| ⬜ | T1: `invincible train` (LoRA on one device), dataset manifests, adapters as models, the eval gate, training receipts | INV-65 |
| ⬜ | T2: data-parallel LoRA across owned devices, DiLoCo-style outer steps | INV-66 |
| ⬜ | `invincible adapters`, `invincible explain` | made plain |

**Exit:** a LoRA trained on a thousand records from your own sessions beats its base on your
eval tasks and is served under a new id; the same run across two machines finishes with the
same result and less wall time.

## Milestone 5 · 0.6 and later

| | Item | Plane |
|---|---|---|
| ⬜ | Cluster phase 5: tensor parallel over 10 GbE and opt-in RDMA, owned machines only | INV-63 |
| ⬜ | Cluster phase 6: phones as shards (charging, Wi-Fi, cool). **Deferred:** phones and tablets are clients, not nodes ([ARCHITECTURE.md](ARCHITECTURE.md) section 4) | INV-64 |
| ⬜ | T3: federated LoRA, data stays on the device. **Deferred** with phones as participants, for the same reason | INV-67 |
| ⬜ | T4: pipeline-parallel training across machines, DeMo compression | INV-68 |
| ⬜ | The written threat model, with the independent review's findings | security program |
| ⬜ | A fleet config for many machines, with the keys kept out of it | made plain |
| ❓ | Region tier: trusted operators only, or a design safe with strangers' compute | the README's open question |

## Across every milestone: made plain

Each milestone adds its command to the table in ARCHITECTURE.md section 8 and its row to the
status tables in the README and on invincible.sh, with the state written as it is. A feature
without a plain command, a reason code and a number is not done.
