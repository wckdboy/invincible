# Routing (v0)

Decides where one request runs. It is a pure function from an input to a decision: no I/O, no
clock, no randomness, so both implementations can be checked against the same vectors.

## Input

```json
{
  "request": {
    "model": "auto",
    "private": false,
    "risk": [],
    "prompt_tokens": 1200,
    "confirmed": false
  },
  "node": {
    "network": "direct",
    "egress": "auto"
  },
  "models": [
    { "id": "qwen3-32b", "tier": "node", "healthy": true, "context": 32768, "data_policy": "owned" },
    { "id": "claude-opus-5-5", "tier": "cloud", "healthy": true, "context": 200000, "data_policy": "retention:30" }
  ]
}
```

### `request`

| Field | Type | Meaning |
|---|---|---|
| `model` | string | `"auto"` lets the router choose; anything else names one model by `id` |
| `private` | bool | Must never leave hardware the user owns. Default `false` |
| `risk` | string[] | Risk codes found in the request (below). Default `[]` |
| `prompt_tokens` | int | Estimated size of the request. Default `0` |
| `confirmed` | bool | The user has already approved a cloud run for this request (the answer to an `ask`). Default `false` |

Risk codes are Autobot's (`CascadeRisk`): `personal`, `health`, `finance`, `attachment`, `memory`.
Unknown codes still count as risk.

### `node`

| Field | Values | Meaning |
|---|---|---|
| `network` | `offline`, `direct`, `tor:<host>:<port>`, `socks5:<host>:<port>` | The node's egress mode, encoded as Autobot's `NetworkMode.encode`. Unknown or malformed → `offline` |
| `egress` | `never`, `ask`, `auto` | Whether requests may leave for the cloud (below). Unknown → `never` |

`egress` follows Autobot's `CascadePolicy`:

- `never`: nothing leaves the node, even when a local answer is impossible.
- `ask`: every cloud run needs the user's confirmation.
- `auto`: cloud runs go ahead, except that an automatic choice with risk needs confirmation.

### `models`

The models the node can use, **in order of preference**. Order matters: the first match wins.

| Field | Type | Meaning |
|---|---|---|
| `id` | string | Unique model id |
| `tier` | `node`, `cloud` | `node`: runs on hardware the user owns. `cloud`: anything else. Unknown (including the reserved `region`) → `cloud` |
| `healthy` | bool | The engine or provider is up |
| `context` | int or absent | Context window in tokens; absent means unknown and never too small |
| `data_policy` | `owned`, `no-retention`, `retention:<days>`, `trains`, `unknown` | What the operator does with prompts (Autobot's `ModelDataPolicy`, plus `owned`) |

## Decision

```json
{ "action": "run", "model": "qwen3-32b", "tier": "node", "reason": "local-first" }
```

| Field | Present | Meaning |
|---|---|---|
| `action` | always | `run`, `ask` or `block` |
| `model` | `run`, `ask` | The model that runs, or would run once confirmed |
| `tier` | `run`, `ask` | That model's tier |
| `reason` | always | Why (codes below) |
| `fallback` | only when `true` | A node model runs **instead of** the cloud model that was asked for |
| `redact` | only when `true` | Redaction must run before the request leaves. Always `true` on a `run` with tier `cloud`, never on `ask` |

The client acts on `ask` by asking the user and, on approval, sending the same request again with
`confirmed: true` (on the node's API, the `invincible-confirmed: 1` header: [Over HTTP](#over-http)).

## Rules

Definitions used below:

- A model **fits** when it is `healthy` and either has no `context` or `prompt_tokens <= context`.
- The **local pick** is the first model in `models` with tier `node` that fits.
- The **cloud block** of a cloud model is the first of these that applies, or none:
  1. `private` when `request.private`
  2. `offline` when `network` is `offline`
  3. `egress-never` when `egress` is `never`
  4. `cloud-down` when the model is not `healthy`

### 1. A named model (`model` is not `"auto"`)

1. No model has that `id` → `block`, reason `unknown-model`.
2. It is a `node` model:
   - It fits → `run` it, reason `requested`.
   - Otherwise, if there is a local pick → `run` the local pick, reason `model-unavailable`.
   - Otherwise → `block`, reason `model-unavailable`.
3. It is a `cloud` model with a cloud block:
   - If there is a local pick → `run` the local pick, `fallback: true`, reason = the cloud block.
   - Otherwise → `block`, reason = the cloud block.
4. It is a `cloud` model and `confirmed` is `false`:
   - Its `data_policy` is `trains` → `ask`, reason `trains`.
   - `egress` is `ask` → `ask`, reason `egress-ask`.
5. Otherwise → `run` it, `redact: true`, reason `requested`.

Naming a model is the client's consent to that model, so risk alone does not ask here. Asking still
applies to a model that trains on prompts and under `egress: ask`.

### 2. `"auto"`

1. There is a local pick → `run` it, reason `local-first`.
2. The **cloud pick** is the first `cloud` model that is `healthy` and whose `data_policy` is not
   `trains`. Automatic choices never pick a model that trains on prompts. None → `block`, reason
   `no-model`.
3. The cloud pick has a cloud block → `block`, reason = the cloud block.
4. `confirmed` is `false` and:
   - `egress` is `ask` → `ask`, reason `egress-ask`.
   - `risk` is not empty → `ask`, reason `sensitive`.
5. Otherwise → `run` the cloud pick, `redact: true`, reason `too-long` when some `node` model is
   healthy (it was too small for the request), else `no-local-model`.

## Reason codes

| Code | Action | Meaning |
|---|---|---|
| `local-first` | run | Auto routing chose a node model |
| `requested` | run | The named model runs |
| `model-unavailable` | run, block | The named node model is down or too small |
| `private`, `offline`, `egress-never`, `cloud-down` | run (fallback), block | Why the cloud model could not be used |
| `trains`, `egress-ask`, `sensitive` | ask | Why the user must confirm |
| `too-long`, `no-local-model` | run | Why auto routing went to the cloud |
| `unknown-model`, `no-model` | block | Nothing to run |

## Over HTTP

Where the node's OpenAI- and Anthropic-compatible API carries the input and the decision. The rules
above do not change here; this is how a client reaches them. It holds for every routed endpoint:
`/v1/chat/completions`, `/v1/messages`, `/v1/audio/speech` and `/v1/images/generations`.

- **`models`** is `GET /v1/models`. Each entry's `invincible` block carries `tier`, `healthy`,
  `context` and `data_policy` as above, plus `vision` (and `cluster` for a model split across
  nodes). A known `context` is also the entry's top-level `context_length`, where OpenAI-compatible
  clients look for it. An unknown one is `null` in the block and absent at the top level, never
  guessed. The node states no `max_completion_tokens`, because it does not know a model's output
  limit.
- **`private`**, **`risk`** and **`confirmed`** are the headers `invincible-private: 1`,
  `invincible-risk: health,personal` and `invincible-confirmed: 1`.
- **The decision** is the JSON in the `invincible-decision` header, on every answer the router
  decided.
- **`ask`** answers `409`, in OpenAI's error shape with two more fields:

  ```json
  {
    "error": {
      "message": "cloud use needs confirmation; send again with `invincible-confirmed: 1`",
      "type": "confirmation_required",
      "code": "confirmation_required",
      "decision": { "action": "ask", "model": "claude", "tier": "cloud", "reason": "egress-ask" },
      "confirm_header": "invincible-confirmed"
    }
  }
  ```

  `decision` is the header's decision, for clients whose SDK shows only the error body.
  `confirm_header` names the header that answers it, sent with the value `1`. `message` is for
  people and may change; a program acts on `decision.reason`.
- **`block`** answers `404` for `unknown-model`, `503` for `model-unavailable` and `no-model`, and
  `403` for the rest, with type `request_blocked`.

## Not in v0

Eval-driven routing, cost limits, per-tool rules, the `region` tier. Each will be a new version of
this document with its own vectors.
