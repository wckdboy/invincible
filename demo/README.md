# The demo

Six acts, each printing a number measured in that run, and the last one breaks the system. It
exists because a claim about a cluster is worth nothing without a run behind it: every figure here
was measured on hardware, and each answer had to be HTTP 200 with at least one completion token and
non-empty text before it was counted.

```
sh demo/run.py --token "$(invincible token on the head)" \
    --head http://127.0.0.1:17777 \
    --head-host root@<head> --peer-host root@<peer> \
    --verify-bin ./target/debug/invincible --requests 8
```

| act | what it shows | what the number means |
| --- | --- | --- |
| 1 | two machines, one build | the same commit **and the same binary bytes** on both — a cluster of two builds measures nothing |
| 2 | one node, the same load | what one machine does alone, with `--requests` clients in flight at once |
| 3 | the same work through **one** URL | dispatch: both nodes answer, the split is counted per answer from `invincible-dispatched-to`, and the speedup is act 3 against act 2 |
| 4 | a node nobody configured | `announce` → seed → `discover`, and the line that matters: `paired as node "…"` only when the fingerprint matches a key pinned in `nodes.json` |
| 5 | a receipt checked off-box | the envelope and the node's public key are fetched, then `receipt verify` runs here: `checked` and `not checked` printed side by side |
| 6 | break it | the peer is killed mid-flight and the same load is sent again: every request must still be answered |

Prerequisites: two machines that are already paired and serving the same model (see
`spec/cluster.md` and `references/test-lab.md` in the node skill), a discovery seed reachable from
both on the private network, and a local `invincible` binary for the offline receipt check. The
head's API is loopback-only, so the driver reaches it through `ssh -N -L 17777:127.0.0.1:7777`.

## Reading the numbers honestly

- **Concurrency is held equal on purpose.** An early transcript reported `2.48x` for dispatch
  against a *sequential* single-node baseline (`0.52 -> 1.28 req/s`). Most of that was the
  dispatcher's two slots against one client at a time, not two machines against one. Act 2 now sends
  the same number of clients as act 3, so the speedup is two nodes against one at the same load —
  measured on two 2-vCPU boxes at `0.96 -> 1.32 req/s`, **1.37x**, with a 4/4 split. The engine
  batches queued requests on one node, which is why the second machine adds less than double.
- **A CPU-only head cannot anchor a sharded token rate.** These acts prove pairing, the plan,
  dispatch, discovery and receipts. They do not prove pipeline sharding, which needs a GPU.
- **A dead peer costs throughput.** With the peer killed, the same load answered at `0.69 req/s`
  against `0.96` for a single healthy node: the dispatcher spends a probe on the node that is gone
  before falling back. Availability held; rate did not.
- **`bench/run.sh` is the other thing.** That one measures start-up, per-turn and gateway latency on
  stand-ins on loopback. This one measures a real cluster.

`runs/` keeps what each demo printed, with public addresses replaced by roles. A number in a report
that is not in one of those files was not measured.
