# Rent

The node rents a cloud GPU itself. `/v1/rent/*` is served in-process: a RunPod adapter, a price
broker, presets, an S3-compatible store and a session sweeper. There is no `wckd` binary and no
supervised child. The HTTP contract is the one this file describes.

The logic is ported from the MIT-licensed [wckd-gpu](https://github.com/wckdboy/wckd-gpu) engine
(offer ranking, the RunPod pod API, presets, the drain-before-delete stop). It is not a dependency
and not a submodule.

## Engine

When `[rent] enabled` is true, `invincible serve` opens the engine. It does not spawn a process.

- The RunPod API key is a mode-0600 file, default `$INVINCIBLE_HOME/secrets/runpod.key`. It is an
  `Authorization` header, never a query parameter, a command-line argument, a log line, or a field
  in a client response. Errors are scrubbed before they are logged or returned.
- R2 (or any S3-compatible store) credentials are two more mode-0600 files. They are not read from
  the environment. With an EU ceiling the endpoint must be a Cloudflare R2 EU-jurisdiction host
  (`*.eu.r2.cloudflarestorage.com`) or loopback.
- Presets ship with the binary: `vllm`, `comfyui-minimax-h3`, `dev-box`. Files in
  `$INVINCIBLE_HOME/rent/presets/*.yaml` add or replace one. The schema is wckd-gpu's.
- Sessions live in `$INVINCIBLE_HOME/rent/state/*.json` (mode 0600). A restart loads them and the
  sweeper drains and deletes anything past its deadline, idle, or over the monthly cap.
- The pod is named `invincible-<session>`. Its environment receives the project prefix and the
  operator's object-store key so the image can hydrate and drain. See the tradeoff below.

Phases: `provisioning` → `hydrating` → `ready` → `draining` → `stopped`, or `failed`. A quote
(`quoting`) writes nothing: no session file, no object, no pod.

A stop writes `sessions/<id>/control.json` (`action: drain`), waits for `drain-ok.json`, and only
then deletes the pod. `force` deletes after that wait even when the marker never arrives. The
sweeper always deletes after the drain attempt: a pod does not outlive the hours it was paid for,
and an idle ready or hydrating pod (no status read for `idle_minutes`) is stopped the same way.
Going over `monthly_cap_usd` stops whatever is still running.

Hydrate, on start, lists `projects/<id>/workspace/` and writes `sessions/<id>/hydrate.json`, then
waits for `hydrate-ok.json` before marking the session ready. The bytes move on the pod. The node
gates delete on the drain marker.

The broker caches the catalog for 30 seconds and ranks offers that fit the preset by catalog
$/hr, then by the labeled fit score. Secure cloud and EU data centers only when the ceiling says
so. A quote that has no usable data center in the set is dropped.

## Configuration

```toml
[rent]
enabled = false                 # off until set; this is what makes spending possible
max_usd_per_hour = 1.0          # omit for no hourly cap
max_hours = 24                  # a single rental; the engine's own ceiling, and the default
monthly_cap_usd = 50            # omit for no monthly cap; UTC month, catalog estimates
idle_minutes = 15               # stop a ready or hydrating pod nobody has asked about
require_regions = ["EU"]        # the default hard filter
runpod_key_file = "secrets/runpod.key"
runpod_url = "https://api.runpod.io"   # omit for this default

[rent.store]
endpoint = "https://<account>.eu.r2.cloudflarestorage.com"
bucket = "invincible"
region = "auto"
access_key_file = "secrets/r2.access"
secret_key_file = "secrets/r2.secret"
```

An old `binary` key, and any other key `[rent]` does not know, is ignored. The node logs the key
name, not the value.

`require_regions` is the node's ceiling. A request that omits it uses this list (`EU` by default).
A request may only narrow it: `EU` allows `EU`, `EU-secure`, and a finer token such as `EU-RO-1`.
A token may not contain a comma: in the JSON body a comma is not a separator.
`EU-secure` does not allow a token that drops the secure mode. An empty list, `any`, `*`, or a
region outside the ceiling is **400**. The client cannot clear or widen the filter. `any` or `*`
in the config (the only token) is the operator turning the ceiling off. A quote with no usable
data center in the set is dropped.

A confirmed create pins `offer_id` to the offer the preview named, when the request did not pin
one itself, so the engine cannot re-rank onto a dearer row between the two calls. If the created
session's price is still over the cap (the vendor reported a higher hourly cost than the catalog
row the caps were checked against), the node force-stops that session and answers **403**
`rent_cap`. The pod does not stay up at a price the caps were not checked against.

## API

Loopback, behind the node's token. A paired device reaches the same routes with the `rent` scope
([pairing.md](pairing.md)); without it the answer is **403** `forbidden`, not the 404 used for
other missing grants. Spending is refused in the open.

| Method | Path | |
|---|---|---|
| `GET` | `/v1/rent/health` | `{"ok", "engine": "invincible", "in_process": true}` plus `limits` (the caps, `idle_minutes`, `require_regions`) |
| `GET` | `/v1/rent/offers` | query `preset`, `hours`, optional `limit` and `require_regions` |
| `POST` | `/v1/rent/sessions` | create, below |
| `GET` | `/v1/rent/sessions` | newest first |
| `GET` | `/v1/rent/sessions/{id}` | one session; refreshes the vendor and counts as activity for idle |
| `POST` | `/v1/rent/sessions/{id}/stop` | `{"force": false}` when the body is empty |

The caller's `confirm` field is ignored. Paths are these strings. Rent off: **503**
`rent_disabled`. The engine cannot price or reach the vendor: **503** `rent_unavailable`. No
matching offer: **422** `no_offers`. Drain did not finish and `force` is false: **409**
`drain_failed`, and the pod stays up.

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

`cost_estimate_usd` is the catalog hourly price times `hours`. It is not a vendor invoice. The
preview provisions nothing: no session file, no pod.

The node provisions only when the header is present and the caps hold. A body that says
`confirm: true` without the header is not approval. `failover` on the preview is the window an
unpinned create would try (up to 3). The caps use the dearest row in that window.

## Caps

Checked on the node, before the confirming provision:

| Cap | Refusal |
|---|---|
| `hours` above `max_hours` | **403** `rent_cap`, `limit: "max_hours"`. The vendor is not called. |
| the dearest candidate's `usd_per_hr` above `max_usd_per_hour` | **403** `rent_cap`, `limit: "max_usd_per_hour"`, with that estimate. An empty `offer_id` can fail over to a dearer row in the same window, so the cap is checked against the whole window, not only the first row. |
| this month's estimates plus this one above `monthly_cap_usd` | **403** `rent_cap`, `limit: "monthly_cap_usd"`. The sum is `cost_estimate_usd` of sessions whose `created_at` is in the current UTC month, plus the dearest candidate in the window. |
| a money cap is set and a figure cannot be read | **403** `rent_cap`, `limit: "unaccounted"`. The node does not start a rental it cannot price. |

A refusal does not provision. Creates run one at a time so two confirmations cannot both pass the
monthly cap.

## Audit

A create that returns 201 and a stop that returns 200 each append an audit entry (`api`
`rent.start` or `rent.stop`) with a signed receipt ([receipts.md](receipts.md), [audit.md](audit.md)).
The entry's `rent` object names the action, the session id and the catalog estimate. It does not
name a provider key. The receipt hashes the body the client sent. The node's rewrite
(`require_regions` filled in, `offer_id` pinned) is the entry's `rewrite` field, not part of that
hash. A 409 or a cap refusal is not a start, and is not logged as one.

A quote or a health check is given 30 seconds. The confirming create and a stop are given three
minutes (a stop waits out the drain, two minutes). Those two keep running if the client
disconnects, and the audit entry is still written.

## Doctor and CLI

`invincible doctor` has a `rent` line. Off: ok. Enabled and the provider key or the R2 config is
missing or not mode 0600: fail. An EU ceiling with a non-EU endpoint: fail. Enabled, the node is
up, and `/v1/rent/health` is not ok: fail. Enabled and the node is not up: warn, because the
doctor does not start the engine. An ignored old key is named in the detail.

```sh
invincible rent offers --preset <id> --hours <n>
invincible rent start --project <id> --preset <id> --hours <n> [--offer <id>] [--confirm]
invincible rent status [session-id]
invincible rent stop <session-id> [--force]
```

`start` without `--confirm` prints the estimate and does not provision. `--json` prints the API body.

Autobot's `rent_gpu_offers`, `rent_gpu_start`, `rent_gpu_status` and `rent_gpu_stop` call these
routes. `start` surfaces this 409 and resends with the header only after the owner approves that
estimate. The model cannot confirm itself. See [agent.md](agent.md).

## Owned for routing — next step

An EU Secure-cloud pod on the owner's account is hardware the owner is paying for, in a region
the owner required. When such a session is registered as a backend, routing should treat it as
tier `node` and `data_policy` `owned`: a private request may run there, and it is a local pick.

That registration is not this change. The `vllm` preset does not register the pod. The
classification belongs with that step, and only for a session that was started `EU-secure` (or an
equivalent require-secure filter), whose data center is in the EU set, on the owner's account.
Community cloud and any non-EU pod stay tier `cloud` and keep the ask and redact rules.

It is not a new `region` tier. [routing.md](routing.md) v0 reserves `region` and maps every unknown
tier to `cloud`, and the conformance vectors lock that. Adding the tier, or reclassifying a cloud
row that the vectors already decide, would be a new version of the router. Using the existing
`node` / `owned` pair when a rented backend appears does not change those vectors, because nothing
in them is a rented pod. Until a session can become a model, the router is unchanged.

## Not in this version

- A second vendor. The provider is a trait; only RunPod is implemented.
- Tailscale sidecar, ephemeral keys, no public ports on the pod.
- Short-lived R2 credentials scoped per project. The pod still receives the operator's key so it
  can hydrate and drain. The node reads that key from a file and scrubs it from errors; it does
  not mint a prefix-scoped token.
- Registering a vLLM pod as a backend.
- Quarantine hold when a drain fails on an interactive stop without `force` (the pod stays, 409).
  The sweeper, a deadline, idle, the monthly cap, and `force` still delete after the drain attempt.
