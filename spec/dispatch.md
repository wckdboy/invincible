# Dispatch: many requests, many nodes (v0, proposed)

> **Not implemented in the node.** The rules exist as a tested policy
> (`invincible_policy::choose`, `crates/invincible-policy/src/dispatch.rs`), and a node now
> advertises them in its capabilities as `dispatch: { max_inflight, queue }` (both fixed: 1 and 0;
> a shard advertises none, `crates/invincible/src/cluster.rs`). Nothing on the head reads that yet:
> no request is dispatched, queued or retried. This document stays normative for what will be
> built.

Cluster sharding (spec/cluster.md) splits *one* model across devices, and a token crosses every
stage, so more nodes make a bigger model possible and every token slower. Dispatch is the other
direction and the one that scales: **independent requests spread across the nodes you own**, each
answered whole by one of them.

The unit of work is a request, not a layer. That is what makes it parallel, and it is why the
client can verify the result — an answer is right or wrong on its own.

## What a node advertises

`GET /v1/cluster/node` already reports devices, models and hardware. Dispatch adds:

```json
{ "dispatch": { "max_inflight": 4, "queue": 0 } }
```

- `max_inflight`: requests this node will run at once. Default 1 on a single-GPU node, 0 when the
  node is a shard for someone else (its capacity is spoken for).
- `queue`: how many are waiting now. Refreshed on every probe; a stale number costs one slow
  request, never a wrong answer.

## Choosing a node

The head keeps one row per candidate node: the models it serves, its `max_inflight`, its measured
`tg_tps` for the model (spec/cluster.md, Capabilities), its link `rtt_ms` and `mib_s`, and how
many requests it is running for us.

A request may be dispatched when the node is **eligible**: it serves a model the request names (or
`auto`), it is `up`, and its link is usable. Among eligible nodes, order by:

1. **fewest in-flight relative to `max_inflight`** (`inflight / max_inflight`, lowest first) —
   this is the load balancer; a big node earns more requests and never gets a queue while a small
   one idles;
2. then **highest predicted rate** for the model — `tg_tps` adjusted by the link cost, the same
   arithmetic the planner uses;
3. then the node's name, so a tie is stable across runs and never flaps.

If every eligible node is at its `max_inflight`, the request waits in the head's queue; it is not
refused. If no node is eligible, it answers `503 no_capacity` with the reason per node.

## Lifecycle and failure

- The head opens one session per request (as `/v1/agent` already does) and streams the answer
  through, headers and receipt id included.
- **Before the first token**, a failed node is retried on the next eligible node, up to one retry.
  **After** the first token the request is committed: the stream ends with an error event and the
  request appears in the receipt with `error.code = "dispatched_node_failed"`. Half an answer from
  a second node would be a lie.
- The answering node's receipt stays the receipt of record. The head adds
  `dispatch: { "via": "<head name>", "node": "<node name>" }` to its audit line only — never to
  the signed receipt, which must describe one machine's work.
- `invincible-private` requests go only to nodes on the owner's hardware (all paired nodes are),
  and never to a node whose model is cloud-backed.

## What it is not

- Not a queue with priorities, retries by policy, or fairness between users — one owner, one
  queue.
- Not a scheduler for the cluster plane: pipeline splits are planned per model as they are now.
- Not a load balancer for strangers. Eligibility is pairing; there is no discovery.

## Why this shape

The BitTorrent-shaped opportunity in this project is not one model across many devices — that is
serial — it is many independent requests across many devices. It needs no verification scheme
between owned nodes, it works on CPU boxes, and its failure mode is a slow queue rather than a
wrong tensor.

## Vectors (with the implementation)

1. three nodes, none busy, different `tg_tps` → highest predicted rate first.
2. one node at `max_inflight` → the next eligible node wins despite being slower.
3. all at capacity → queued, not refused; one frees → dispatched in the stable order.
4. node fails before the first token → retried once on the next; fails after → error event, no
   silent half-answer.
5. `dispatch.max_inflight = 0` (a shard) → never eligible.
