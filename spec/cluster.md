# Cluster: decentralized intelligence across your own devices (v0)

> **Phase 1 implemented, unaudited.** The link rule and the partitioning rule below are
> normative and pinned by `vectors/cluster.json`. Everything past phase 1 is a design: concrete
> enough to build, open to change when it meets real hardware.

Your devices together can run models none of them can run alone, and later train them. A Mac
Studio, an older MacBook, a GPU box and a phone on the same desk hold 100+ GB between them. This
document covers what Invincible does with that: **inference** split across devices (pipeline
parallel, as exo does, through llama.cpp), and **training** (LoRA fine-tuning on one device, then
across devices with low-communication sync, DiLoCo-style).

## Goals

1. **Bigger models than any one device holds**, on hardware you own, with nothing else changed:
   the same OpenAI- and Anthropic-compatible API, the same router, the same receipts.
2. **Your own devices first.** Only paired devices take part, every link is encrypted and
   mutually authenticated with the keys pairing already pinned, and the kill switch and the
   network policy hold.
3. **Honest receipts.** A receipt names every node that computed part of an answer.
4. **Fail clearly.** A device that leaves mid-answer ends that answer with an error, the model is
   planned again over the devices that remain, and the router uses something else meanwhile.
5. **Training you can run at home.** Fine-tune a model on your own data, on your own devices,
   without the data leaving them.

## Non-goals (for now)

- Strangers' compute. A region tier of other people's nodes is a later, separate design
  (verification, payment, privacy against the operator). Phases here assume every device is yours.
- Speed-ups for models that fit on one device. Splitting a model costs speed (each token crosses
  every link in turn); the cluster is for capacity. A model that fits stays on one device unless
  you ask for `split = "always"`.
- Pretraining from scratch. Fine-tuning and continued training of open models are in scope.
- Tensor parallel over Wi-Fi. Tensor parallel exchanges data at every layer and wants RDMA or at
  least 10 GbE; it is a later phase for wired clusters only.

## What exists, and what we take from it

| Project | What it does | What Invincible takes |
|---|---|---|
| [exo](https://github.com/exo-explore/exo) | Apple-first cluster inference on MLX. Discovery by UDP multicast beacons, zenoh between nodes since June 2026 ([#2132](https://github.com/exo-explore/exo/commits/main/rust/networking/Cargo.toml)); an elected master places models; pipeline or tensor sharding, RDMA over Thunderbolt 5 on macOS 26.2 | Memory-weighted layer allocation with largest-remainder rounding ([placement_utils.py](https://github.com/exo-explore/exo/blob/main/src/exo/master/placement_utils.py)); "the smallest set of devices that holds it"; RDMA as a later transport |
| [llama.cpp RPC](https://github.com/ggml-org/llama.cpp/blob/master/tools/rpc/README.md) | `ggml-rpc-server` exposes a machine's ggml devices; `llama-server --rpc` puts layers on them (layer split, `--tensor-split`); weights cached by hash (`-c`); RDMA negotiated when both sides can | **The phase 1 engine.** It already runs every GGUF the node serves, on Metal, CUDA, ROCm, Vulkan and CPU. Its README: "Never run the RPC server on an open network" — there is no authentication and no encryption, so Invincible wraps it |
| [Petals](https://github.com/bigscience-workshop/petals) | Swarm of servers each holding consecutive blocks; the client keeps the activations it sent and re-routes around a failed server ([paper](https://arxiv.org/abs/2312.08361)) | Resume after a failure by replaying from the client's side (phase 3) |
| [distributed-llama](https://github.com/b4rtaz/distributed-llama) | Tensor parallel over Ethernet, 2^n nodes, Q80 sync buffers | Numbers: an 8B model syncs 0.5–3.8 MB per token in tensor parallel, against kilobytes in pipeline parallel |
| [DiLoCo](https://arxiv.org/abs/2311.08105), [OpenDiLoCo](https://arxiv.org/abs/2407.07852), [INTELLECT-1](https://arxiv.org/abs/2412.01152) | Many local steps (AdamW), then an outer step (Nesterov) on the averaged change: 500× less communication than data parallel, robust to workers coming and going | **The training sync** across devices (phase T2) |
| [DeMo / DisTrO](https://arxiv.org/abs/2411.19870), [Psyche](https://nousresearch.com/nous-psyche/) | Decoupled momentum with DCT + top-k compression, 85× less than AdamW-DDP; Psyche coordinates over a chain with Iroh P2P | Later compression for slow links; not the first choice (DiLoCo is simpler and proven at LoRA scale) |
| [Hivemind](https://github.com/learning-at-home/hivemind), [Gensyn Verde](https://arxiv.org/abs/2502.19405), [TOPLOC](https://arxiv.org/abs/2501.16007) | DHT and averaging for volunteer training; verification of untrusted compute | Only for a future strangers' tier; not needed among your own devices |
| [FedIT](https://arxiv.org/abs/2305.05644), [FedSA-LoRA](https://arxiv.org/abs/2410.01463), [FLoRA](https://arxiv.org/abs/2409.05976), [Flower](https://flower.ai/docs/examples/flowertune-llm-code.html) | Federated LoRA: clients train adapters on private data, a server averages them | Phones as federated participants (phase T3), adapters only |
| [MLX distributed](https://ml-explore.github.io/mlx/build/html/usage/distributed.html), [mlx-lm LoRA](https://github.com/ml-explore/mlx-lm/blob/main/mlx_lm/LORA.md) | `mx.distributed` over ring (TCP) or JACCL (RDMA over Thunderbolt 5); `mlx_lm.lora` with QLoRA and gradient checkpointing; pipeline and tensor sharded generation | **The training engine on Apple silicon** (phase T1) and a later inference engine for Apple-only clusters |

What runs where:

- **Apple silicon:** llama.cpp (Metal) for inference, split over RPC today; MLX for training and
  for RDMA clusters later (TB5, macOS 26.2+, full mesh, `rdma_ctl enable` once).
- **NVIDIA / AMD:** llama.cpp (CUDA, ROCm, Vulkan) for inference, the same RPC; PyTorch + PEFT for
  training (phase T2), launched as an engine like llama-server.
- **CPU-only machines:** `ggml-rpc-server` exposes one CPU device; useful as a memory shard for
  small parts of a model, slow.
- **Phones:** llama.cpp and MNN already run on Autobot's devices. As inference shards only on
  charge and on Wi-Fi (below); as federated LoRA participants (phase T3).

## Trust model

- **Only paired devices.** A node takes part in a cluster only with devices it paired with
  ([pairing.md](pairing.md)): the head paired with each shard as a device (`invincible join`), so
  each side has pinned the other's static key.
- **Shards choose their heads.** Being paired is not enough to run work on a shard: the shard
  names, in `[cluster] heads`, the devices that may. A paired phone cannot use your GPU box as a
  shard unless you say so. `ggml-rpc-server` parses graphs from its client in C++ with no
  authentication; whoever reaches it can make it allocate memory and compute, and a parsing bug
  there is remote code execution. So only heads you named reach it.
- **llama.cpp RPC is never on the network.** `ggml-rpc-server` listens on a loopback port only.
  The only way in from another machine is a **shard link**: a Noise session (`Noise_IK_25519_
  ChaChaPoly_SHA256`, prologue `invincible/0 shard`, mode byte `0x03`), the same handshake and
  framing as a device session, but the byte stream inside goes to the RPC server instead of the
  HTTP API. The shard refuses the handshake, before answering it, from a key that is not pinned or
  not a head. Unpairing a head, or removing it from `heads`, drops its open links at the next frame.
- **The head's side.** The head runs one loopback door per peer (`127.0.0.1:<port>`); `llama-server
  --rpc 127.0.0.1:<port>` connects to it and each connection becomes one shard link. (Phase 1
  limit: any process of any user on the head machine can connect to that loopback port, as with
  any loopback service; phase 2 restricts it to the head's own llama-server.)
- **Owned means owned.** A model split across your paired devices is still `tier: node`, data
  policy `owned`: a request marked `invincible-private` may run on it. What a shard receives is
  activations, not text, but activations can be inverted to recover much of a prompt, so the
  receipt says which machines took part and the rule stays "your devices only". Trusted peers that
  are not yours (a friend's node) will be a separate tier, refused for private requests.
- **The network policy holds.** Shard links follow the link rule below: never through a proxy,
  never off the local network, and not at all under the kill switch.

## Links (normative)

Whether a node may open a shard link to one address of a paired peer. Input: the encoded `network`
mode ([egress.md](egress.md)) and the address's `host`. The first rule that applies decides:

1. Loopback ([egress.md](egress.md), Loopback) is always direct.
2. `offline` (the kill switch, and any mode that decodes as offline) blocks: reason `offline`.
3. A host that is not on a local network blocks: reason `not_lan`. Local network, without any
   lookup: IPv4 `10/8`, `172.16/12`, `192.168/16`, link-local `169.254/16` (the Thunderbolt bridge),
   `100.64/10` (shared address space, where Tailscale puts its nodes); IPv6 `fc00::/7` and
   `fe80::/10`; a name ending in `.local` (mDNS) with no empty label.
4. Otherwise direct, **whatever the mode**: a shard link is never sent through Tor or SOCKS5 (a
   pipeline stage through Tor would be unusable, and a LAN address through a proxy is wrong
   anyway). A public peer under Tor is refused, not proxied.

```json
{ "action": "direct" }
{ "action": "block", "reason": "offline" }
{ "action": "block", "reason": "not_lan" }
```

Why the kill switch stops LAN links too: `offline` means nothing leaves this machine, and the
apps read it that way. A home cluster without internet sets `network = "direct"` with
`egress = "never"` (no cloud). Whether LAN links should survive `offline` is an open question below.

Vectors: `vectors/cluster.json`, the `link` cases.

## Discovery

- **Phase 1: paired peers.** A head's peers are the nodes it paired with (`nodes.json`, written by
  `invincible join`); it reaches each at the addresses pinned at pairing, over a session, and asks
  for its capabilities. Membership is "paired, reachable, and serving as a shard for me".
- **Phase 2: mDNS on the LAN.** Each node with `[remote] listen` advertises `_invincible._tcp.local`
  with a TXT record of its key fingerprint and nothing else (no name, no model list: the record is
  readable by anyone on the LAN). A head matches announcements against keys it already pinned, so
  a peer that changed address is found again; a new node is never trusted from an announcement,
  only from pairing. exo discovers by UDP multicast beacons the same way, and trusts what it finds;
  Invincible does not.
- Addresses learned by mDNS go through the link rule like pinned ones.

## Capabilities

`GET /v1/cluster/node` on the device API (any paired device, over its session):

```json
{
  "name": "mini", "version": "0.0.21",
  "memory_bytes": 38654705664,
  "devices": [{ "name": "MTL0", "description": "Apple M3 Pro", "total_mib": 28753, "free_mib": 28753 }],
  "rpc_backend": true,
  "shard": true
}
```

- `devices`: what `llama-server --list-devices` reports, minus devices with no memory of their own
  (BLAS). Probed afresh on each request: free memory changes.
- `rpc_backend`: whether this node's llama-server was built with `GGML_RPC=ON`, found by asking it
  to reach an RPC server on a closed port (a build without it answers "RPC not supported").
- `shard`: whether this node serves as a shard **for the device asking**.
- Phase 2 adds measured numbers: memory bandwidth and FLOPs from a short calibration run
  (`llama-bench` pp/tg on a tiny model), and link round-trip time and throughput per peer.

## Partitioning (normative)

Layer-wise pipeline sharding sized by memory, as exo does. Input: the model's file size, the split
mode, and the devices in order (the head's first, then each peer's in the order the model lists
its peers):

```json
{ "model_bytes": 4294967296, "split": "auto",
  "devices": [{ "node": "studio", "device": "MTL0", "free_mib": 28000 },
              { "node": "mini", "device": "MTL0", "free_mib": 12000 }] }
```

1. `need_mib` = ⌈(bytes + bytes/10) / MiB⌉ + 512 (weights, a tenth on top, buffers and a small
   KV cache; the same estimate `invincible model add` uses). Each device can give 90% of its free
   memory, rounded down to a whole MiB.
2. If the head's devices can hold it, and the mode is `auto` or no peer device was given: `local`.
3. If all devices together cannot: `block`, reason `does_not_fit`.
4. Otherwise `split`: each device gets thousandths of the layers in proportion to what it can give,
   rounded by largest remainder (floors first; the thousandths left go to the largest remainders,
   the earlier device on a tie), so they add up to 1000. Devices with 0 are left out. If only the
   head's devices remain, it is `local`.

```json
{ "action": "split", "need_mib": 5018,
  "shares": [{ "node": "studio", "device": "MTL0", "permille": 700 },
             { "node": "mini", "device": "MTL0", "permille": 300 }] }
```

The head runs `llama-server --rpc <door per peer> --tensor-split <shares>`: llama.cpp puts RPC
devices first, in `--rpc` order and each server's own device order, then the local ones, and
splits layers in those proportions. The first layers sit on the shards and the last, with the
output head, on the head, which is what llama.cpp chooses to minimise transfers.

Vectors: `vectors/cluster.json`, the `plan` cases.

**Later (phase 2).** Speed-aware weights: proportional to measured throughput, capped by memory,
so a fast GPU is not starved because a slower machine has more RAM. Prefer the smallest set of
devices that holds the model (exo's rule), and devices with the weights already cached.
**Tensor parallel** (phase 5): within one wired, RDMA-capable group only, through MLX (JACCL) or
llama.cpp's `--split-mode tensor`; never over Wi-Fi.

## The data path

- **Weights** cross each link once, at load: `ggml-rpc-server --cache` keeps every tensor over
  10 MiB under its hash (in `$INVINCIBLE_HOME/cache/rpc`), so a reload sends hashes, not weights.
  Phase 2: shards read the GGUF from their own disk when they have the same file (checked by
  SHA-256), skipping the transfer entirely.
- **Activations** cross each stage boundary for every token: `hidden_size × 4` bytes in f32
  (8 KiB for a 2048-wide 1.7B model, 32 KiB for a 72B), plus llama.cpp's graph commands. A prompt
  of N tokens sends N times that at once (64 MiB per boundary for a 4096-token prompt on a 72B
  model). Bandwidth is not the limit for generation; **latency is**: each token waits for every
  hop in turn.
- **Latency budget.** Per token, per shard: about 2 round trips plus compute. On 10 GbE a round
  trip is ~0.2 ms ([kjaiswal](https://github.com/kjaiswal/llama-cpp-distributed-benchmarks)), on
  good Wi-Fi 2–5 ms, with spikes. A target of ≥ 70% of single-device speed holds on Ethernet and
  Thunderbolt; on Wi-Fi only for large models whose per-token compute dwarfs the hops. The cluster
  status shows the measured probe time per peer, and phase 2 plans with it.
- **The encrypted link** costs ChaCha20-Poly1305 over each frame and one extra loopback hop on each
  side. Two details matter: snow's default ChaCha20-Poly1305 has no SIMD path on Apple silicon, so
  the node uses ring's (`ring-accelerated`, 3–5× faster, the same algorithm and the same vectors);
  and each direction of a link is its own task, so a bulk transfer encrypts on one core while the
  other decrypts. Measured below.
- **Batching.** llama-server's parallel slots batch requests across the whole pipeline, which
  amortises the hops; phase 3 adds micro-batched prefill (one chunk per stage in flight, as GPipe).
- **KV cache.** Each device keeps the KV cache of its own layers (llama.cpp does this with layer
  split), so the cache is split in the same proportions and never crosses a link. Context length
  is therefore bounded by the sum, not by the head.

## Failure handling

- **A shard leaves mid-answer** (unplugged, asleep, crashed). llama.cpp's RPC client aborts its
  process on a lost server. The answer in flight ends with an error (a streamed one with an error
  event, as for any engine that fails; the receipt records it), the supervisor plans again over
  the peers that still answer: with the rest able to hold the model it is relaunched there
  (resharded), else it stays unhealthy and is planned again every 15 seconds. Meanwhile the router
  treats it as an unhealthy node model and falls back to the next model that fits. **Phase 1:
  fail clearly, then reshard.**
- **Phase 3: resume.** The head keeps the tokens of every running answer; after a reshard it
  replays prompt + tokens so far into the new layout (a prefill, not a regeneration) and the client
  sees a pause, not an error (Petals does this with cached activations).
- **A peer comes back** with `split = "always"`: used at the model's next relaunch. Phase 2
  relaunches when the model is idle.
- **Version skew.** llama.cpp's RPC protocol is versioned (8.0.1 today; the client refuses a
  different major or a newer minor) and tied to the build's op count: every node must run the same
  llama.cpp build. Capabilities carry the build tag in phase 2, and a mismatch is reported, not
  attempted.

## Scheduling with the router

Routing ([routing.md](routing.md)) is unchanged: a split model is a node model, owned, healthy
when its llama-server answers. What the cluster adds is placement, decided before routing:

1. A model that fits on the head runs there (`auto`).
2. One that does not is split over the fewest, then fastest, devices that hold it.
3. One that cannot be placed is unhealthy, so the router falls back (another local model, or the
   cloud where the rules allow): exactly the existing "model unavailable" path.

Phase 4 adds **remote placement**: the head may run a model entirely on one peer (the GPU box)
rather than splitting it, forwarding requests over a session; the receipt then names that peer.

## Receipts

A receipt for an answer from a split model carries `cluster` ([receipts.md](receipts.md)): every
node that held layers, head first, with its share of the layers in thousandths; for each peer its
static key (as pinned at pairing) and the bytes through its links while the request ran.

```json
"cluster": [
  { "name": "studio", "share": 700 },
  { "name": "mini", "share": 300, "key": "<peer static key>", "bytes_sent": 51200, "bytes_received": 49800 }
]
```

Byte counts are of the link, not the request: with several requests on one model at once, each
receipt counts the others' traffic too (an upper bound). Shard traffic is not `egress`: `egress`
lists hosts off hardware you own, and `cluster` lists your own machines that took part.

## API, CLI, configuration

- The OpenAI- and Anthropic-compatible API is unchanged. `/v1/models` adds `"cluster": ["mini"]`
  to a split model's `invincible` block.
- `GET /v1/cluster/node`: capabilities (device API and loopback).
- `GET /v1/cluster` (loopback, token): this node, its peers probed now (reachable, probe time,
  capabilities, which addresses the link rule allows), the heads it serves and the bytes they
  moved, and each split model's plan, notes and links.
- `invincible cluster status [--json]`.
- Later: `invincible cluster plan <model>` (dry run), `invincible cluster bench` (calibration),
  `invincible cluster train ...` (below).

On a shard:

```toml
[remote]
name = "mini"
listen = ["0.0.0.0:7778"]
advertise = ["192.168.1.21:7778"]

[cluster]
serve = true
heads = ["studio"]                   # paired devices that may use this node as a shard
# rpc_server = "/path/ggml-rpc-server"   # default: next to llama_server, else on PATH
# cache = true                       # weights heads sent, kept for fast reloads
```

On the head (after `invincible join '<mini's code>' --name studio`):

```toml
[[models]]
id = "big"
path = "/models/Big-70B-Q4_K_M.gguf"
cluster = ["mini"]                   # paired nodes it may be split across
split = "auto"                       # or "always"
```

## Observability

- `invincible cluster status`: who is up, the probe time, free memory per device, each model's
  placement in thousandths, and why a peer was left out.
- Logs: `cluster: split` with the shares, every link opened and closed on both sides
  (`shard link open`, with the head's name), refusals with the reason.
- Per-link byte counters in the status and in receipts. Phase 2: tokens/s per model in the status,
  and per-stage timings from llama.cpp (`GGML_RPC_DEBUG`).

## Phones

- **Inference shards: only when charging, on Wi-Fi, and cool.** A phone gives a few GB of memory
  and its NPU/GPU, but sleeps, roams and throttles. Autobot would run `ggml-rpc-server` (it already
  embeds llama.cpp) behind the same shard link, and announce itself as a shard only while plugged
  in, on an unmetered network, and below a thermal threshold; it stops on any of those changing,
  and the head reshards. Worth it for models just past the desktop's memory; not for speed.
- **Federated LoRA participants** (phase T3): a phone fine-tunes an adapter on its own data (MNN or
  llama.cpp on-device, MLX on iOS later) overnight on charge, and sends only the adapter delta to
  the node, which averages. The data never leaves the phone.
- Phones never serve as shards for anyone but their owner's paired head.

## Training

The same trust model: your devices, paired links, receipts for runs.

**T1 — LoRA on one device.** `invincible train` runs a fine-tuning job as an engine (a child
process): `mlx_lm.lora` on Apple silicon (QLoRA on quantized models, gradient checkpointing), PEFT
on CUDA. llama.cpp's own trainer is still a work in progress (FP32 models only, no merged LoRA
training: [examples/training](https://github.com/ggml-org/llama.cpp/blob/master/examples/training/README.md)),
so it is not the first engine. The result is a LoRA adapter served with the base model
(`llama-server --lora`) as a new model id, after an eval run against the base
(`invincible eval`): a trained model that does not beat the base on your own tasks is not routed to.

**T2 — Data-parallel LoRA across devices, DiLoCo-style.** Every device holds the base model (or its
own pipeline-split share of it), trains the adapter on its slice of the data for H local steps
(AdamW), then the devices exchange only the change in the adapter (a few MB for rank 16 on a 7B
model) and apply an outer Nesterov step. With H = 100–500 that is hundreds of times less traffic
than syncing every step ([DiLoCo](https://arxiv.org/abs/2311.08105)), so Wi-Fi is enough, and a
device that drops out misses rounds without stopping the run. The head is the coordinator; deltas
travel over shard links (a training mode of the same Noise session); a ring all-reduce among
wired devices in phase T4.

**T3 — Federated LoRA with phones.** As T2, but devices keep their data: each round sends only
adapter deltas; FedSA-LoRA's rule (average A, keep B local) when personalisation matters. Optional
clipping and noise for differential privacy, off by default between your own devices.

**T4 — Larger.** Full fine-tuning and continued pretraining of mid-size models across wired
machines: pipeline parallel training (MLX, PyTorch) with DiLoCo outer steps between groups; DeMo
compression for slow links. Distillation from frontier traces (the eval harness's training data
export) is a natural first dataset.

**Datasets and privacy.**

- Datasets are files in `$INVINCIBLE_HOME/datasets/` (JSONL chat format), with a manifest: source,
  SHA-256, record count, and the redaction state. Building one from your audit log or agent
  sessions is explicit (`invincible dataset from-sessions`), never automatic.
- Data is sharded by record to devices that already hold it where possible; otherwise a shard of
  it is sent over the paired link and deleted at the end of the run.
- A training receipt (signed like any other) names the base model, the dataset by hash, the
  devices and their steps, and the result's hash. No record text is in it.
- Nothing about training leaves your devices; no model weights are uploaded anywhere.

## Shipping llama.cpp's RPC server

- The node runs `ggml-rpc-server` (renamed from `rpc-server` in late 2026; both names are found).
  llama.cpp's official release archives include it: `llama-b11799-bin-macos-arm64.tar.gz` has
  `ggml-rpc-server` and `libggml-rpc.dylib` next to `llama-server` (checked for macOS arm64; the
  Linux archives are checked in phase 2). `install.sh` installs that archive into `~/.invincible/llama.cpp` and will set
  `[cluster] rpc_server` from it when it does.
- **Homebrew's llama.cpp has no RPC backend** (its ggml is built without `GGML_RPC`: `llama-server
  --rpc` answers "RPC not supported in this build", and there is no `ggml-rpc-server`). A node on
  Homebrew's llama.cpp can still be a member and is told why it cannot split; `invincible cluster
  status` says so. The installer will prefer the release archive when the cluster is turned on.
- Every node in a cluster must run the same llama.cpp build (the RPC protocol is tied to it). The
  installer pins one tag (`LLAMA_TAG`) for every machine, which gives this for free when they are
  on the same Invincible version.
- RDMA (Thunderbolt 5, macOS 26.2+) bypasses the tunnel and is unencrypted; phase 1 disables it
  (`GGML_RPC_NO_RDMA=1`). Allowing it over a direct cable between two of your machines, as an
  explicit opt-in, is an open question.

## Roadmap, with acceptance tests

| Phase | What | Accepted when |
|---|---|---|
| **1. Proof (built)** | Shard links (Noise, mode `0x03`, heads only), `ggml-rpc-server` on loopback, the head's doors, capabilities, `GET /v1/cluster` and `invincible cluster status`, memory-weighted plans, split models in the router, `cluster` in receipts, reshard after a shard leaves | Two `invincible serve` on one Mac with separate homes: one GGUF split across both answers through the gateway; receipt names both; ciphertext on the wire; a non-head paired device is refused; killing the shard mid-answer ends that answer with an error and the model comes back on the head alone; vectors pass |
| 2. Two real machines | mDNS discovery of pinned keys; calibration (FLOPs, bandwidth, RTT) in capabilities and speed-aware plans; shards load weights from their own copy (by SHA-256); door restricted to the head's own llama-server; build-tag check; installer ships `ggml-rpc-server` | A 70B Q4 model on a 36 GB Mac + a 24 GB GPU box over Ethernet answers at ≥ 70% of the slower machine's tokens/s for a model that fits it, loads in < 1 min after the first time |
| 3. Resilience | Resume after reshard (replay prompt + tokens); relaunch when idle when a peer returns; micro-batched prefill | Pulling a shard's cable mid-answer gives a pause and a complete answer; no request errors in a 1-hour soak with a shard toggling every 5 minutes |
| 4. Placement | Whole-model placement on a peer (forwarded over a session), the router picking head, peer or split by measured speed | A model that fits only on the GPU box is served from there via the head, its receipt naming the box |
| 5. Wired fast paths | Tensor parallel within RDMA/10 GbE groups (MLX JACCL or llama.cpp `--split-mode tensor`), opt-in RDMA between owned machines | 4 Macs over TB5 beat one Mac on a model that fits one (exo's claim: 1.8× on 2) |
| 6. Phones as shards | Autobot runs `ggml-rpc-server` behind a shard link when charging, on Wi-Fi, cool | A phone holds 10% of a model's layers; unplugging it reshards within 30 s |
| T1. LoRA on one device | `invincible train` (mlx-lm / PEFT as an engine), datasets with manifests, adapters served as models, eval gate, training receipts | A LoRA trained on 1k records from your sessions beats its base on your eval tasks, served under a new id |
| T2. DiLoCo LoRA | Data-parallel LoRA over shard links with outer steps every H steps | Two Macs reach the same eval score as one in ≤ 60% of the wall time, moving < 1% of the bytes per-step sync would |
| T3. Federated with phones | Adapter deltas from phones, FedSA-LoRA option | Three devices (one phone) improve a shared adapter without any record leaving its device (checked by receipts) |
| T4. Larger | Pipeline-parallel training across machines, DeMo compression | A 7B full fine-tune across two machines that neither fits alone |

## Phase 1: what was measured

On one Apple M3 Pro (36 GB), Qwen3 1.7B Q4_K_M (1.26 GiB), two `invincible serve` processes with
separate homes on loopback, the shard's `ggml-rpc-server` on the same GPU; medians:

MEASUREMENTS

Both "devices" share one GPU here, so the split numbers measure the overhead of the pipeline and
the link, not a gain: on two machines the shard's layers run on its own GPU, and each token also
pays the network's round trips.

## Known limits of phase 1

- One head per shard at a time (`ggml-rpc-server` serves one client at a time).
- The head's loopback doors accept any local process (as any loopback service does).
- A peer that comes back is used at the model's next relaunch, not at once.
- Byte counts in receipts are per link, so concurrent requests on one model share them.
- Heads must have a GPU device of their own to anchor a split; CPU-only heads come later.

## Open questions for the owner

1. **Kill switch and the LAN.** Should `network = "offline"` also stop shard links to your own
   machines on the LAN (phase 1: yes, fail closed), or should offline mean "no internet" for
   cluster links?
2. **RDMA over Thunderbolt** is unencrypted. Allow it as an opt-in between two of your machines on
   a direct cable (much faster: µs instead of ms), or always keep the encrypted tunnel?
3. **Friends' nodes.** When trusted peers that are not yours join (a region tier), should private
   requests be refused on them outright (the plan), or allowed per peer?
4. **Training engine.** MLX + PyTorch as child processes means Python on the node for training
   only. Acceptable, or wait for a native trainer (llama.cpp's, still FP32-only)?
