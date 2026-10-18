# Evals, v0

How well does a local model do the work you actually give it, next to a frontier one? `invincible
eval` runs a task file against models the gateway serves (its own engines, and cloud backends when
the routing rules allow them) and checks every answer by rule, so the result is the same however
often it runs and whoever runs it. No model grades another.

## Task files

JSON Lines: one task per line; blank lines and lines starting with `#` are skipped.

```json
{"id": "json-extract-1", "tags": ["extraction", "json"],
 "system": "Answer with JSON only.",
 "prompt": "From: 'Order 4412 ships to Oslo on 3 May.' extract {\"order\": number, \"city\": string}",
 "checks": [{"type": "json", "path": "order", "equals": 4412}, {"type": "json", "path": "city", "equals": "Oslo"}],
 "max_tokens": 200}
```

| Field | Required | Meaning |
|---|---|---|
| `id` | yes | Unique in the file |
| `prompt` | yes | The user message |
| `system` | no | A system message |
| `checks` | yes | All must pass (below) |
| `tags` | no | Groups for the report (`coding`, `extraction`, …) |
| `max_tokens` | no | The answer's limit (default 1024) |

Before checking, thinking blocks (`<think>…</think>`) are removed from the answer and surrounding
whitespace is trimmed.

## Checks

| `type` | Fields | Passes when |
|---|---|---|
| `contains` | `value`, `ignore_case` (default true) | the answer contains `value` |
| `not_contains` | `value`, `ignore_case` (default true) | it does not |
| `equals` | `value`, `ignore_case` (default true) | the whole answer equals `value` (after trimming a final `.`) |
| `regex` | `pattern` | the pattern matches somewhere in the answer |
| `json` | `path`, `equals` | the answer is (or contains, in a fenced block) a JSON value whose field at `path` (dots for nesting, numbers for array positions) equals `equals` |
| `max_words` | `value` | the answer has at most `value` words |

## Results

`--out results.json` writes, for each model, each task's `pass`, the checks that failed, the
answer, latency in milliseconds and tokens, and the gateway's receipt id. The report prints the
pass rate per model and per tag, the median latency, and the tasks where the models disagree.
