# Receipts (v0)

For every chat completion a node keeps a signed receipt saying where the request ran and what left
the node. Autobot verifies it with the node's pinned receipt key and merges it into its own per-turn
receipt (`Receipt` in Autobot's `shared/session/Receipts.kt`). The point is a claim you can check:
**"nothing left the node"** is an empty `egress` list, signed.

## Getting a receipt

1. Every response to `POST /v1/chat/completions` carries `invincible-request-id: <id>` (32
   lowercase hex digits, random).
2. When the answer has been fully sent (or the client went away), the node finishes the receipt.
3. `GET /v1/receipts/<id>` returns it. A request that is still running is waited for (up to 10
   seconds); an unknown id answers 404. A node keeps the most recent 4096 receipts in memory, and
   finds older ones (and ones from before a restart) in its audit log ([audit.md](audit.md)).
4. `GET /v1/node` returns `{"name": "…", "receipt_key": "<public key>", "speech": [...], "images": [...]}`
   (the speech and image backends: `{"id", "tier", "host", "healthy"}` each). A paired device also gets
   the receipt key in the pairing reply ([pairing.md](pairing.md)), over the authenticated channel,
   and pins it.

Both endpoints are on the loopback API (behind the token) and on the device API.

## The receipt

```json
{
  "receipt": {
    "version": 0,
    "request_id": "9f2c…",
    "node": "<receipt public key, base64url>",
    "decision": { "action": "run", "model": "claude", "tier": "cloud", "reason": "requested", "redact": true },
    "data_policy": "retention:30",
    "tokens": { "input": 1200, "output": 410 },
    "redactions": { "EMAIL": 1, "PERSON": 2 },
    "egress": [
      { "host": "api.anthropic.com", "route": "tor", "bytes_sent": 14200, "bytes_received": 3900, "ok": true }
    ]
  },
  "signature": "<Ed25519 signature, base64url>"
}
```

| Field | Present | Meaning |
|---|---|---|
| `version` | always | `0` |
| `request_id` | always | as in the response header |
| `node` | always | the node's receipt public key |
| `decision` | always | the final routing decision, exactly as [routing.md](routing.md) defines it (after any failover) |
| `data_policy` | when a model ran | that model's data policy (`owned` on the node) |
| `tokens` | when the answer reported usage | `input` and `output` tokens |
| `redactions` | when something was hidden | distinct values hidden per kind ([redaction.md](redaction.md)) |
| `images` | when the request carried images | one `{"sha256", "bytes", "mime"}` per image, in order: the SHA-256 (hex) and size of its decoded bytes and its type; for an image given by link, the hash of the URL, `bytes` 0 and `mime` `url` |
| `cluster` | when a model split across paired nodes ran ([cluster.md](cluster.md)) | every node that held layers, head first: `{"name", "share"}` (its share of the layers in thousandths), and for each peer also `"key"` (its static key, base64url, as pinned at pairing), `"bytes_sent"` and `"bytes_received"` (through its shard links while the request ran; links are shared, so concurrent requests count each other's traffic) |
| `egress` | always | every attempt to reach a host off the node, in order; `[]` when nothing left |
| `error` | when the answer was an error | `{"status"}`, the answer's HTTP status; or, for a stream that had begun (kept alive while a local engine read a long prompt), the error event that ended it: `{"status", "code"}` (`context_length_exceeded`, `rate_limit_exceeded`, `engine_stalled`, `upstream_stalled`, …) |

Shard links to your own paired nodes are not egress: `cluster` lists them, `egress` lists hosts
off hardware you own.

An egress entry has the host, the route (`direct`, `tor`, `socks5`), the request bytes sent, the
answer bytes received, and `ok` (false for an attempt that failed and was routed elsewhere). A failed
attempt is listed with its full request size, because it may have been sent before the failure.

A receipt never contains prompt or answer text, image bytes, values that were redacted, or
timestamps. Images are passed on as they came (redaction covers text only); a model known not to
take images (`"vision": false` in `/v1/models`) is not sent them: the request is refused with
`400 model_cannot_see_images`.

## Signature

- Keys are Ed25519 (RFC 8032). The node keeps its 32-byte seed in `receipt.key` (mode 0600).
  Public keys and signatures are base64url without padding.
- The signed message is the UTF-8 bytes of `invincible-receipt/0\n` followed by the **canonical
  JSON** of `receipt`.
- Canonical JSON is RFC 8785 (JCS). Receipts contain only objects, arrays, strings, booleans and
  integers (never floating-point numbers), and only ASCII keys. For such values JCS reduces to: no
  whitespace, object keys sorted, strings escaped minimally (`\"`, `\\`, `\b`, `\f`, `\n`, `\r`,
  `\t`, other control characters as lowercase `\u00xx`, everything else as UTF-8).

## Vectors

`vectors/receipts.json`. A `sign` case gives a `seed` and a `receipt` and expects the `public_key`,
the `canonical` JSON and the `signature`. A `verify` case gives a `public_key`, a `receipt` and a
`signature` and expects `valid`. The expected values were computed with an independent Ed25519
implementation (Python `cryptography`, OpenSSL), not with Invincible.

## Fetches

`POST /v1/fetch {"url": "https://…"}` (loopback API only, not the device API) reads a web page for
the agent under the node's network mode (refused while offline; through Tor or SOCKS5 when set;
HTTPS only, redirects held to the same rule) and answers `{"url", "status", "content_type",
"text", "truncated"}`, the text readable (tags, scripts and styles gone; at most 32 KiB). It gets a
receipt like a chat completion, with `decision` null and one `egress` entry for the page's host,
and is in the audit log with `api` `fetch`.

## Speech and images

`POST /v1/audio/speech {"input", "voice"?, "model"?, …}` and `POST /v1/images/generations
{"prompt", "size"?, "model"?, …}` (OpenAI's shapes; on the loopback and the device API) go to the
node's `[[speech]]` and `[[images]]` backends, routed by [routing.md](routing.md) with each
backend a model (one on loopback is `node`, `owned`; any other `cloud`), the text's length for
its tokens. They get a receipt like a chat completion, with the decision, the data policy, an
`egress` entry when the backend is off the machine, and `redactions` when the text that left was
redacted; the answer (audio bytes, or the images' JSON) comes back as the backend gave it.
