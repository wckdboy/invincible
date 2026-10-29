# Rent

The node can rent a cloud GPU by supervising [`wckd`](https://github.com/wckdboy/wckd-gpu)
`serve` and proxying `/v1/rent/*` to it. `wckd` is a separate process. It is not linked into the
gateway. A crash in it does not take the node down, and the node never puts wckd's bearer on a
command line, in a client response, or in a log line.

This is the gateway half of that integration. It does not add a Tailscale sidecar, short-lived
R2 credentials, or a vLLM preset. Those are later.

## Process

When `[rent] enabled` is true, `invincible serve` starts `wckd serve` the way it starts
`llama-server` ([engine.rs](../crates/invincible/src/engine.rs)):

- a loopback port the node chose (`--listen 127.0.0.1:<port>`);
- a fresh bearer in `$INVINCIBLE_HOME/rent/wckd.key`, mode 0600, passed as `--api-key-file` (the
  path, never the key);
- a cleared environment, plus `WCKD_STATE_DIR=$INVINCIBLE_HOME/rent/state` and the variables every
  engine inherits (PATH, HOME, GPU library paths). Provider keys, tokens and `LLAMA_*` are not
  inherited;
- working directory `$INVINCIBLE_HOME/rent`, so wckd can read `.env` or `wckd.yaml` there itself.
  RunPod and S3 credentials belong in that file (mode 0600). The node does not copy them.

wckd refuses a non-loopback bind, a group-readable key file, and a request without the bearer
(401, including `/health`). The supervisor treats a process that answers without its key the same
way it treats an unkeyed llama-server: it stops it and does not serve it.

Sessions live in the state directory. wckd sweeps deadlines in-process. On a node restart the
supervisor starts wckd again on the same directory and the same style of key file; wckd loads the
sessions and sweeps anything already past its deadline. The node's proxy follows the new process.

## Configuration

```toml
[rent]
enabled = false                 # off until set; starting wckd is what makes spending possible
binary = "wckd"                 # name on PATH, or a path
max_usd_per_hour = 1.0          # omit for no hourly cap
max_hours = 24                  # a single rental; wckd's own ceiling, and the default
monthly_cap_usd = 50            # omit for no monthly cap; UTC month, catalog estimates
idle_minutes = 15               # recorded and reported; see Idle
require_regions = ["EU"]        # the default hard filter
```

`require_regions` is the node's ceiling. A request that omits it uses this list (`EU` by default).
A request may only narrow it: `EU` allows `EU`, `EU-secure`, and a finer token such as `EU-RO-1`.
`EU-secure` does not allow a token that drops the secure mode. An empty list, `any`, `*`, or a
region outside the ceiling is **400**. The client cannot clear or widen the filter. `any` or `*`
in the config (the only token) is the operator turning the ceiling off. A quote with no usable
data center in the set is dropped by wckd, not by the node.

A confirmed create pins `offer_id` to the offer the preview named, when the request did not pin
one itself, so wckd cannot re-rank onto a dearer row between the two calls. If the created
session's price is still over the cap, the node stops that session (`force`) and answers **403**
`rent_cap`. The pod does not stay up at a price the caps were not checked against.

`idle_minutes` is the owner's idle budget. This version records it and returns it on
`GET /v1/rent/health`. It does not stop a pod for idleness: wckd's sweeper stops a pod at the
deadline `hours` sets, and the node cannot see whether a pod is idle. Idle stop waits until a
later step can see traffic.

## API

Loopback, behind the node's token. A paired device reaches the same routes with the `rent` scope
([pairing.md](pairing.md)); without it the answer is **403** `forbidden`, not the 404 used for
other missing grants. Spending is refused in the open.

| Method | Path | |
|---|---|---|
| `GET` | `/v1/rent/health` | wckd's `{"ok", "engine"}` plus `limits` (the caps, `idle_minutes`, `require_regions`) and `supervised: true` |
| `GET` | `/v1/rent/offers` | query `preset`, `hours`, optional `limit` and `require_regions` |
| `POST` | `/v1/rent/sessions` | create, below |
| `GET` | `/v1/rent/sessions` | newest first |
| `GET` | `/v1/rent/sessions/{id}` | one session |
| `POST` | `/v1/rent/sessions/{id}/stop` | `{"force": false}` when the body is empty |

The node attaches wckd's bearer. It does not forward the caller's `Authorization`, and it strips a
`confirm` field and `X-Wckd-Confirm` from the caller. Paths are the same strings wckd serves; the
proxy does not rewrite them.

Rent off: **503** `rent_disabled`. wckd down: **503** `rent_unavailable`.

## Confirmation

There is no auto-start. A cap is a ceiling, not a permission. A create without
`invincible-confirmed: 1` (the same header as [routing.md](routing.md); `true` is also accepted)
is **409**:

```json
{
  "error": {
    "message": "renting a GPU needs confirmation; send again with `invincible-confirmed: 1`",
    "type": "confirmation_required",
    "code": "confirmation_required",
    "confirm_header": "invincible-confirmed"
  },
  "cost_estimate_usd": 0.34,
  "cost_basis": "catalog_usd_per_hr_times_hours",
  "offer": {"id": "runpod:community:NVIDIA GeForce RTX 4090", "usd_per_hr": 0.34, "estimate_usd": 0.34},
  "hours": 1,
  "require_regions": ["EU"]
}
```

`cost_estimate_usd` is the catalog hourly price times `hours`, the figure wckd returns. It is not
a vendor invoice. The node gets it by calling wckd with confirmation off. That call provisions
nothing: no session file, no pod.

The node then calls wckd with `confirm: true` and `X-Wckd-Confirm: true` only when the header is
present and the caps hold. A body that says `confirm: true` without the header is not approval.

## Caps

Checked on the node, before that confirming call:

| Cap | Refusal |
|---|---|
| `hours` above `max_hours` | **403** `rent_cap`, `limit: "max_hours"`. wckd is not called. |
| the dearest candidate's `usd_per_hr` above `max_usd_per_hour` | **403** `rent_cap`, `limit: "max_usd_per_hour"`, with that estimate. An empty `offer_id` can fail over to a dearer row in the same window, so the cap is checked against the whole window, not only the first row. |
| this month's estimates plus this one above `monthly_cap_usd` | **403** `rent_cap`, `limit: "monthly_cap_usd"`. The sum is `cost_estimate_usd` of sessions whose `created_at` is in the current UTC month, plus the dearest candidate in the window. |
| a money cap is set and a figure cannot be read | **403** `rent_cap`, `limit: "unaccounted"`. The node does not start a rental it cannot price. |

A refusal does not provision. Creates run one at a time so two confirmations cannot both pass the
monthly cap.

## Audit

A create that returns 201 and a stop that returns 200 each append an audit entry (`api`
`rent.start` or `rent.stop`) with a signed receipt ([receipts.md](receipts.md), [audit.md](audit.md)).
The entry's `rent` object names the action, the session id and the catalog estimate. It does not
name the bearer. The receipt's `egress` is empty: the node talked to loopback, and the vendor call
is wckd's. A 409 or a cap refusal is not a start, and is not logged as one.

## Doctor and CLI

`invincible doctor` has a `rent` line. Off: ok. Enabled and the binary is missing: fail. Enabled,
the node is up, and `/v1/rent/health` is not ok: fail. Enabled and the node is not up: warn, because
the doctor does not start wckd and does not read the bearer.

```sh
invincible rent offers --preset <id> --hours <n>
invincible rent start --project <id> --preset <id> --hours <n> [--offer <id>] [--confirm]
invincible rent status [session-id]
invincible rent stop <session-id> [--force]
```

`start` without `--confirm` prints the estimate and does not provision. `--json` prints the API body.

## Owned for routing — next step

An EU Secure-cloud pod on the owner's account is hardware the owner is paying for, in a region
the owner required. When such a session is registered as a backend, routing should treat it as
tier `node` and `data_policy` `owned`: a private request may run there, and it is a local pick.

That registration is not this change. A later step adds a vLLM preset that auto-registers through
`Clouds::replace`. The classification belongs with that step, and only for a session that was
started `EU-secure` (or an equivalent require-secure filter), whose data center is in the EU set,
on the owner's account. Community cloud and any non-EU pod stay tier `cloud` and keep the ask and
redact rules.

It is not a new `region` tier. [routing.md](routing.md) v0 reserves `region` and maps every unknown
tier to `cloud`, and the conformance vectors lock that. Adding the tier, or reclassifying a cloud
row that the vectors already decide, would be a new version of the router. Using the existing
`node` / `owned` pair when a rented backend appears does not change those vectors, because nothing
in them is a rented pod. Until a session can become a model, the router is unchanged.

## Not in this version

- Tailscale sidecar, ephemeral keys, no public ports on the pod.
- Short-lived R2 (EU) credentials scoped per project. wckd still injects the operator's S3 key
  into the pod; the node never sees it.
- A vLLM preset that registers the pod as a backend.
- Stopping a pod because it has been idle for `idle_minutes`.
