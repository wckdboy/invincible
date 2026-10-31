# Receipts (v1)

For every request a node answers, it keeps a signed receipt: where the request ran, what left the
node, and — since version 1 — **the exchange itself**: the request and the answer by hash, when it
happened, and who asked. Autobot verifies it with the node's pinned receipt key and merges it into
its own per-turn receipt (`Receipt` in Autobot's `shared/session/Receipts.kt`).

The point is a claim you can check offline, holding nothing but the node's public key:

- **"nothing left the node"** is an empty `egress` list, signed;
- **"this answer is the answer to this request, from this node, to this caller, at this time"** is
  `request_sha256`, `answer_sha256`, `at`, `caller` and `node`, signed together.

## Getting a receipt

1. Every response to `POST /v1/chat/completions` carries `invincible-request-id: <id>` (32
   lowercase hex digits, random).
2. When the answer has been fully sent (or the client went away), the node finishes the receipt.
3. `GET /v1/receipts/<id>` returns it. A request that is still running is waited for (up to 10
   seconds); an unknown id answers 404. A node keeps the most recent 4096 receipts in memory, and
   finds older ones (and ones from before a restart) in its audit log ([audit.md](audit.md)) by the
   id its entry records; an id that log matches to more than one entry answers 409
   (`ambiguous_receipt`) instead of one of them.
4. `GET /v1/node` returns `{"name": "…", "receipt_key": "<public key>", "speech": [...], "images": [...]}`
   (the speech and image backends: `{"id", "tier", "host", "healthy"}` each). A paired device also gets
   the receipt key in the pairing reply ([pairing.md](pairing.md)), over the authenticated channel,
   and pins it.

Both endpoints are on the loopback API (behind the token) and on the device API.

## The receipt

```json
{
  "receipt": {
    "version": 1,
    "request_id": "9f2c…",
    "node": "<receipt public key, base64url>",
    "at": 1761123456,
    "api": "chat",
    "caller": { "kind": "device", "name": "phone", "key": "<static public key, base64url>", "fingerprint": "abab-abab-abab-abab" },
    "request_sha256": "<hex>",
    "answer_sha256": "<hex>",
    "answer_bytes": 125,
    "answer_complete": true,
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

| Field | Present | Meaning | What it proves |
|---|---|---|---|
| `version` | always | `1` | Which of the two signed formats this is; it selects the domain prefix, so it cannot be changed without breaking the signature |
| `request_id` | always | as in the response header | Which response this receipt belongs to |
| `node` | always | the node's receipt public key | Which key signed it — and the only key that can verify it |
| `at` | always | unix seconds when the receipt was signed | The node asserts this time. It is inside the signature, so it cannot be edited; whether the clock was right is another matter (below) |
| `api` | always | `chat`, `messages`, `fetch`, `speech`, `images`, `dispatch`, `rent.start` or `rent.stop` | Which endpoint received the request; part of the request hash |
| `caller` | always | `{"kind": "local"}` for the node's own API; `{"kind": "device", "name", "key", "fingerprint"}` for a paired device | That **this device's key** asked. `key` is the static key pinned at pairing; `fingerprint` is the readable form of it (`devices::fingerprint`, the first 8 bytes in hex groups). `name` is a label the owner may change and is not an identity |
| `request_sha256` | always | SHA-256 (hex) of the canonical request (below) | That the node is talking about one exact request, byte for byte, including every parameter |
| `answer_sha256` | always | SHA-256 (hex) of the answer body bytes the client received | That the node is talking about one exact answer — the bytes that arrived, not a re-serialisation of them |
| `answer_bytes` | always | the answer body's length | That the answer you hold is whole, and how big it was |
| `answer_complete` | always | `true` when the body ended on its own | `false` means the client went away (or the transport failed) mid-answer: the hash covers only the prefix that was sent |
| `decision` | always | the final routing decision, exactly as [routing.md](routing.md) defines it (after any failover) | Where it ran and why, as the node decided |
| `data_policy` | when a model ran | that model's data policy (`owned` on the node) | — |
| `tokens` | when the answer reported usage | `input` and `output` tokens | — |
| `redactions` | when something was hidden | distinct values hidden per kind ([redaction.md](redaction.md)) | — |
| `images` | when the request carried images | one `{"sha256", "bytes", "mime"}` per image, in order: the SHA-256 (hex) and size of its decoded bytes and its type; for an image given by link, the hash of the URL, `bytes` 0 and `mime` `url` | — |
| `dispatch` | when this node forwarded the request to another (`POST /v1/dispatch/chat/completions`, [dispatch.md](dispatch.md)) | `{"via": "<head name>", "node": "<node name>"}` — this node and the node that answered | That the head stands behind **which machine answered**, and that it did not run the model itself. The answer's hash is the same in both receipts; the answering node's own receipt remains the record of the model's work |
| `cluster` | when a model split across paired nodes ran ([cluster.md](cluster.md)) | every node that held layers, head first: `{"name", "share"}` (its share of the layers in thousandths), and for each peer also `"key"` (its static key, base64url, as pinned at pairing), `"bytes_sent"` and `"bytes_received"` (through its shard links while the request ran; links are shared, so concurrent requests count each other's traffic) | — |
| `egress` | always | every attempt to reach a host off the node, in order; `[]` when nothing left | That nothing (or what) left the node |
| `error` | when the answer was an error | `{"status"}`, the answer's HTTP status; or, for a stream that had begun (kept alive while a local engine read a long prompt), the error event that ended it: `{"status", "code"}` (`context_length_exceeded`, `rate_limit_exceeded`, `engine_stalled`, `upstream_stalled`, …) | That the answer was a failure, and which |

Shard links to your own paired nodes are not egress: `cluster` lists them, `egress` lists hosts
off hardware you own.

An egress entry has the host, the route (`direct`, `tor`, `socks5`), the request bytes sent, the
answer bytes received, and `ok` (false for an attempt that failed and was routed elsewhere). A failed
attempt is listed with its full request size, because it may have been sent before the failure.

A receipt never contains prompt or answer text, image bytes, values that were redacted, or the
request and answer themselves — only their hashes. Images are passed on as they came (redaction
covers text only); a model known not to take images (`"vision": false` in `/v1/models`) is not sent
them: the request is refused with `400 model_cannot_see_images`.

## What is bound

### The request

`request_sha256` is the SHA-256 (hex) of the canonical JSON (below) of

```json
{ "api": "<the api field above>", "body": <the request body as the client sent it, parsed as JSON> }
```

The **whole body**, with nothing dropped and nothing added: `model`, `messages` or `input`, and every
parameter that can change the answer (`temperature`, `max_tokens`, `stream`, tool definitions, …) are
covered because they are in the body. `api` is included because the same body means a different
answer at `/v1/chat/completions` than at `/v1/messages`. A verifier holding the body the client sent
recomputes the hash and compares — see [Verifying](#verifying).

Not bound: HTTP headers, including the routing headers `invincible-private`, `invincible-risk` and
`invincible-confirmed`. They are not body content, and the node's decision that resulted from them
is signed instead.

### The answer

`answer_sha256` is the SHA-256 (hex) of **the body bytes the client receives, exactly**, in order,
concatenated:

- no HTTP framing — status line, headers and chunked-transfer framing are not in it (a client hashes
  the de-chunked body its HTTP library yields), and chunk boundaries are not part of it either;
- for a streamed answer (SSE), the event text as it went out — `data: {…}\n\n` and the rest — in the
  order it was sent. Nothing is re-serialised, re-encoded or approximated: two clients that receive
  the same bytes compute the same hash, and a node that changed one byte of the stream would have to
  change `answer_sha256`, which it cannot do without the signing key;
- `answer_bytes` is the length of that byte sequence, and `answer_complete` says whether it is the
  whole body (`true`) or only what was sent before the client went away (`false`).

Errors are answers too: a `400`, a `503` or a stream that ended in an `event: error` has its body
hashed the same way, with `error` naming the failure.

## Canonical JSON

The canonical form is **RFC 8785 (JCS)**. Both the signed receipt and the request hash use the same
function, so two implementations agree on the bytes:

1. **No whitespace** anywhere. UTF-8 output, no BOM.
2. **Object keys sorted by their UTF-16 code units** (unsigned, so by code point for the BMP and by
   surrogate pair above it — *not* by UTF-8 bytes: `U+1F600` sorts before `U+E000`).
3. **Strings** escaped minimally: `\"`, `\\`, `\b`, `\f`, `\n`, `\r`, `\t`, other characters below
   `U+0020` as lowercase `\u00xx`; everything else literal UTF-8 (no `\/`, no escaping of non-ASCII,
   no upper-case hex).
4. **Numbers** as ECMAScript writes them: integers plainly (`-2`, `0`, `4096`); any other finite
   value as the shortest decimal that round-trips to the same `f64`, in plain notation when
   `1e-6 ≤ |x| < 1e21` and as `d.dddde±n` outside it (`0.1`, `2.5`, `1e+21`, `1e-7`, `-0` → `0`).
   `NaN` and infinities cannot appear in JSON and are refused.
5. Duplicate keys cannot appear (the body is parsed before hashing; the last one wins, as any JSON
   parser does).

### Known-answer vector

The value

```json
{"z":"line\nbreak\t\"quoted\"\\","a":[1,-2,0.1,1e21,1e-7,true,null],"é":"é","😀":"grin","\ue000":"private","nested":{"b":2.5,"a":{}}}
```

canonicalises to (one line, 135 bytes). Below, `\uE000` stands for the single private-use character
`U+E000` (UTF-8 `EE 80 80`), which appears literally in the bytes — it is the key that sorts *after*
`😀` (`U+1F600`) because UTF-16 compares the surrogate pair `D83D DE00` first:

```
{"a":[1,-2,0.1,1e+21,1e-7,true,null],"nested":{"a":{},"b":2.5},"z":"line\nbreak\t\"quoted\"\\","é":"é","😀":"grin","\uE000":"private"}
```

and its SHA-256 is

```
50b0aa6d0d87c54d9fe76e73683e1ae361a5ee991ce8ef8cb1674ee3f0bd44ef
```

An implementation that produces a different string for that value is not producing JCS and will not
agree with this node on any hash. The same vector is a `canonical` case in `vectors/receipts.json`
(checked by `crates/invincible/tests/vectors.rs`), and was computed with JavaScript's
`JSON.stringify` over sorted keys — not with Invincible.

## Signature

- Keys are Ed25519 (RFC 8032). The node keeps its 32-byte seed in `receipt.key` (mode 0600).
  Public keys and signatures are base64url without padding.
- The signed message is the UTF-8 bytes of `invincible-receipt/1\n` followed by the canonical JSON of
  `receipt`. Version 0 receipts sign under `invincible-receipt/0\n` instead: the version inside the
  receipt selects the prefix, so a signature made for one version never verifies as the other, and a
  version 0 receipt cannot be relabelled as version 1 (`version` is inside the signed bytes).
- `verify_strict` is used: small-order keys and non-canonical signatures are rejected.

### Version 0

Version 0 receipts (routing and accounting only: `request_id`, `node`, `decision`, `egress`, tokens,
redactions, images, cluster, error) still verify, as version 0, with the `invincible-receipt/0\n`
prefix — nothing about them is invented or upgraded. `invincible receipt verify` says so plainly:
"version 0: routing and accounting only — no request, answer, caller or time is bound". A node writes
version 1 from this release on.

## Verifying

`invincible receipt verify <file|id>` does the offline check. `<file>` is a receipt envelope (or a
line from `audit.jsonl`, which holds it under `receipt`), `-` is stdin, and anything else is a request
id looked up in this node's audit log: the id the client was given in the `invincible-request-id`
header, which the entry records in its `request_id` field (and its receipt inside). An id names one
receipt, so a log in which more than one entry carries it is refused — with how many and when — rather
than answered with one of them; entries written before the log recorded ids are passed over and are
not reachable by id. `--key` is the node's receipt public key (base64url); without
it, this node's own key is used. `--request <body.json>` and `--answer <file>` are the request body
as the client sent it and the answer bytes as the client received them; giving them makes the check
compare hashes instead of only reporting them.

```
receipt 9f2c…: version 1
  node     A6EHv_POEL4dcN0Y50vAmWfk1jCbpQ1fHdyGZBJVMbg
  api      chat
  caller   device "phone", key q6ur…, fingerprint abab-abab-abab-abab
  at       1761123456 (12s ago)
  request  sha256 8fd8…
  answer   sha256 1325… (125 bytes, whole)
signature: valid
checked:
  - the receipt names the key given as its node
  - the Ed25519 signature over the canonical form
  - the timestamp is a unix time, not more than 300s ahead of this clock
  - the request body given hashes to `request_sha256`
  - the answer bytes given hash to `answer_sha256`, and are `answer_bytes` long
not checked:
  - that the model in `decision` ran at all, or on the hardware the node names
  - that the answer is correct, or came from that model
  - that the node's clock was right when it signed
  - that the caller is the device named (`caller.key` is the key the node pinned at pairing)
```

`--json` prints the same report as an object (`checked`, `not_checked`, and the claims read out of
the receipt). The command exits non-zero on the first thing that fails, naming it: the key is another
node's, the signature does not verify, a version 1 receipt is missing a field it must carry, the
timestamp is more than 300 s in the future, the request hashes to something else, or the answer does.

## What a verifier can and cannot conclude

With only the node's public key, `receipt verify` establishes:

- **the node's key signed this receipt**, and everything in it is the node's claim: the hashes, the
  time, the caller, the decision, the egress list;
- **this exact request produced this exact answer**: given the body the client sent and the bytes it
  received, both hashes match. Change one byte of either and the check fails, naming the hash. A
  returned answer cannot be swapped for another, and a request cannot be edited after the fact;
- **who asked**: `caller.key` is inside the signature. A paired device can show its receipt to a
  third party, who checks the key against the one the node pinned at pairing (`invincible devices`);
- **when**: `at` is inside the signature, and not in the verifier's future.

It does **not** establish, and no receipt can:

- that the model named in `decision` ran, or ran on the hardware claimed — a node with the signing
  key can sign a receipt for work it did not do, including a fabricated answer. The receipt binds
  what the caller received to what the node says it did; it does not audit the node's honesty about
  its internals. (That is what `decision` + `egress` + the pinned key + the operator's own audit log
  are for: a node that lies also has to lie consistently in its audit chain, on hardware you own.)
- that the answer is **correct**, or came from the model it names;
- that the node's clock was right when it signed (only that the signature covers the time claimed);
- that `caller` is who really used the device — the device key is the identity, and whoever holds the
  device holds the key;
- that the request's routing headers were what the receipt's decision suggests (headers are not in
  the hash);
- that nothing else left the node: `egress` is the node's own account of what it connected to.

## Fetches

`POST /v1/fetch {"url": "https://…"}` (loopback API only, not the device API) reads a web page for
the agent under the node's network mode (refused while offline; through Tor or SOCKS5 when set;
HTTPS only, redirects held to the same rule) and answers `{"url", "status", "content_type",
"text", "truncated"}`, the text readable (tags, scripts and styles gone; at most 32 KiB). It gets a
receipt like a chat completion, with `api` `fetch`, `decision` null and one `egress` entry for the
page's host, and is in the audit log with `api` `fetch`.

## Speech and images

`POST /v1/audio/speech {"input", "voice"?, "model"?, …}` and `POST /v1/images/generations
{"prompt", "size"?, "model"?, …}` (OpenAI's shapes; on the loopback and the device API) go to the
node's `[[speech]]` and `[[images]]` backends, routed by [routing.md](routing.md) with each
backend a model (one on loopback is `node`, `owned`; any other `cloud`), the text's length for
its tokens. They get a receipt like a chat completion, with `api` `speech` or `images`, the decision,
the data policy, an `egress` entry when the backend is off the machine, and `redactions` when the
text that left was redacted; the answer (audio bytes, or the images' JSON) comes back as the backend
gave it, and is hashed as those bytes.

## Vectors

`vectors/receipts.json`. A `sign` case gives a `seed` and a `receipt` and expects the `public_key`,
the `canonical` JSON and the `signature`. A `verify` case gives a `public_key`, a `receipt` and a
`signature` and expects `valid`. A `canonical` case gives a `value` and expects the `canonical` JSON
and its `sha256`. The expected values were computed with independent implementations (Node's
`JSON.stringify` for canonical JSON, OpenSSL through Node's `crypto` for Ed25519), not with
Invincible.
