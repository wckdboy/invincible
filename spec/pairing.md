# Pairing (v0)

> **Implemented, not yet independently reviewed.** Invincible implements this document
> (`crates/invincible/src/remote.rs`, with tests for the refusal cases). Treat it as unaudited
> until a security review signs it off (INV-13). Autobot's side is INV-14.

How a device (a phone running Autobot, or another computer) and an Invincible node come to trust
each other with no accounts, no passwords and no third-party relay, and how the device then reaches
the node's API.

## Keys

Each side has a long-lived X25519 static key: `node.key` on the node, `device.key` on a device
(mode 0600, two base64url lines: private, public). Private keys never leave the machine that made
them.

A key's **fingerprint**, for people to compare, is its first 8 bytes in hex, in groups of four
digits: `3f2a-91c0-77de-0b14`.

## Pairing code

The node shows a code as text and as a QR code:

```
invincible://pair?v=0&k=<node public key>&s=<secret>&a=<host:port>,<host:port>
```

- `k`: the node's static public key, 32 bytes, base64url without padding.
- `s`: a one-time secret, 32 random bytes, base64url without padding.
- `a`: where to reach the node (LAN, WireGuard / Tailscale, …), comma-separated, tried in order.
- `v` must be `0`. Unknown parameters are ignored; a missing or malformed `k`, `s` or `a` makes the
  code invalid.

A code is valid for 10 minutes and for one successful pairing. Opening a new code replaces the old
one. After 5 failed pairing handshakes the code is burned. Both ends of this are also on the node's
API, for a client with no shell: `POST /v1/cluster/pair` mints a code and `POST /v1/cluster/join`
consumes one, with the same parsing and the same handshake (spec/cluster.md, Membership API).

## Connection

A device opens a TCP connection and sends one byte, in the clear: `0x01` to pair, `0x02` for a
session. Every message after that is a **frame**: a big-endian `u16` length, then that many bytes.

| Mode | Noise protocol | Prologue |
|---|---|---|
| `0x01` pair | `Noise_IKpsk1_25519_ChaChaPoly_SHA256`, PSK = the code's secret | `invincible/0 pair` |
| `0x02` session | `Noise_IK_25519_ChaChaPoly_SHA256` | `invincible/0 session` |
| `0x03` shard link | `Noise_IK_25519_ChaChaPoly_SHA256` | `invincible/0 shard` |

`0x03` is a session whose stream goes to the node's `ggml-rpc-server` instead of its API, for the
devices the node names as cluster heads ([cluster.md](cluster.md)); any other device is refused
before the node answers the first message.

The prologue binds the mode byte into the handshake, so changing it in transit breaks the handshake.

**Why SHA-256, not BLAKE2s.** Devices implement Noise on their platform's own, well-reviewed crypto
(Java's `javax.crypto` on Android, CryptoKit on iOS). Both have X25519, ChaCha20-Poly1305, SHA-256
and HMAC-SHA256; neither has BLAKE2s.

Both are IK: the device already knows the node's static key (from the code, or pinned at pairing)
and sends its own static key encrypted in the first message. The handshake fails unless the node
holds the private key for the key the device expects, so an impostor node cannot answer.

**Why `psk1`.** The secret has to be mixed in by the end of the device's first message. With `psk1`,
a device that does not know the secret cannot produce a first message the node can decrypt, so the
node refuses it before pinning anything. (`psk2` puts the secret in the node's reply, and the node
would read the first message, and learn and pin the device's key, without proof that the device saw
the code. The first implementation had exactly this bug, and a test caught it.)

### Pairing (`0x01`)

1. Device → node, handshake message 1. Payload: `{"name": "<device name>"}` (UTF-8 JSON, at most
   1024 bytes; a longer one is refused).
2. The node uses up the code, then pins the device's static key under the name, with the
   **capability set** the code grants (below). Using up the code
   is atomic: of two handshakes that both prove the same code, only the first pins a device, and a
   handshake whose code was replaced, burned or expired while it ran pins nothing. Names are
   cleaned to ASCII letters, digits, `-` and `_`, at most 40 characters. A name already in use by another key gets a number (`phone-2`). A
   key that paired before keeps one entry, renamed.
3. Node → device, handshake message 2. Payload:
   `{"node": "<node name>", "device": "<name pinned>", "receipts": "<receipt public key>", "capabilities": ["shard"]}`. The device
   pins the receipt key and uses it to verify the node's receipts ([receipts.md](receipts.md)), and
   reads its own set: what it may reach over the session. A node from before capabilities sends no
   `capabilities`, which a device must read as `shard` — the least, and what a session reached then.
   **The device's hello is not an input to this.** Only `name` is read from message 1; a device that
   puts `capabilities` in its hello is granted the code's set, so asking is not a way to escalate.
4. The connection continues as a session (below).

### Session (`0x02`)

1. Device → node, handshake message 1, empty payload.
2. If the device's static key is not pinned, the node closes the connection without replying.
3. Node → device, handshake message 2, empty payload.

### Transport

After the handshake each frame holds one Noise transport message carrying at most 65519 bytes of
plaintext. In each direction the plaintexts, concatenated, form a byte stream, and that stream is
plain **HTTP/1.1** to a fixed list of node endpoints — not the node's whole API. A device reaches
these with no token, because its key already authenticates it; headers and behaviour are the same
as on loopback. Which of them it reaches is decided by the capability set recorded for it at
pairing ([Capabilities](#capabilities)):

| Route | Capability | Why a device has it |
|---|---|---|
| `GET /v1/models` | `shard` | The app picks the `model` it asks for from this list. |
| `POST /v1/chat/completions` | `shard` | One turn, streamed or whole. A request a head dispatches to this node arrives here too. |
| `GET /v1/receipts/<id>` | `shard` | The signed receipt for a request it made ([receipts.md](receipts.md)). |
| `GET /v1/node` | `shard` | The node's name and receipt key: the probe a peer makes before listing it as reachable. |
| `GET /v1/cluster/node` | `shard` | What this node can give a cluster, so a head can size a split here; a device this node does not name in `[cluster] heads` is told `shard: false`. |
| `POST /v1/cluster/meter` | `shard` | Times the link: small round trips, then one bulk payload ([cluster.md](cluster.md), Capabilities). |
| `GET /v1/audit` | `audit` | That device's own entries in the audit log, and no one else's ([audit.md](audit.md), Reading it). |
| `GET /v1/dispatch`, `POST /v1/dispatch/chat/completions` | `dispatch` | The peers the operator owns, and a hop into them ([dispatch.md](dispatch.md)). |
| `/v1/agent`, `/v1/agent/{path}` (any method) | `agent` | The Autobot Agent proxy, which runs with the node's own token (spec/agent.md). |

Nothing else is mounted. Every other path — `/v1/fetch`, `/v1/messages`, `/v1/audio/speech`,
`/v1/images/generations`, the rest of `/v1/cluster*`, `/v1/admin/*` — answers exactly as a path
that does not exist: the same 404 and the same body. **A route whose capability the device does not
hold answers with that same 404, byte for byte.** Deliberately not a 403: a 403 would map which
routes exist and which grants the caller lacks, and a device has no business learning either. So a
device cannot tell an operator route from no route at all, nor whether another device holds more.

## Capabilities

What a device may reach is a small closed set, recorded **at pairing** with the device in
`devices.json` on the node it paired with, and changed only by the operator. A node that joined
this one — a cluster head, a dispatcher — is a paired device in the same file, with a set of its
own.

| Code | What it grants |
|---|---|
| `shard` | The six routes a head needs of this node: models, chat completions, receipts, node, cluster/node, meter. |
| `agent` | `/v1/agent*`: the Autobot proxy on this machine, with this node's token — agent turns with its tools, schedules, bots. |
| `audit` | `GET /v1/audit`: that device's own audit entries, found by the key recorded in each as `caller_key` ([audit.md](audit.md)). |
| `dispatch` | `GET /v1/dispatch` and `POST /v1/dispatch/chat/completions`: the operator's other nodes. |

- **The default is `shard`, and only `shard`.** A code minted with no capabilities grants it, and
  every answer that hands out a code says which set it carries, so the default is visible where the
  decision is made. A device that pairs and is granted nothing else is exactly what a paired device
  was before capabilities existed.
- **A set is the whole set**, never an addition to `shard`: `["agent"]` is a device that reaches the
  agent and not chat. The Autobot app's chat, agent and activity screens need
  `["shard", "agent", "audit"]`.
- **A code may pre-grant a set** — `POST /v1/cluster/pair {"capabilities": ["shard", "agent"]}` on
  the node's own API, `{"capabilities": ["shard", "agent"]}` on `POST /v1/admin/pairing`
  (`invincible pair --capabilities shard,agent`). Only there: the device API has no route that
  mints a code, and the pairing hello cannot add to what the code grants. A code that grants less
  resets the device to less if it pairs again.
- **Grants and revocations need no re-pairing.** `PATCH /v1/admin/devices/{name}
  {"capabilities": [...]}` on the node's own API (`invincible devices grant <name> <codes>`)
  replaces the set of the device of that name and answers `{"device", "capabilities", "was",
  "changed"}`; the next request is admitted by the new set. `PATCH /v1/cluster/nodes/{name}` with
  the same `capabilities` is the same write, with the same refusals (`400 invalid_capabilities`,
  `404 not_found` for a name the node hosts no device under) and the same answer, for the node
  that joined under that name ([cluster.md](cluster.md), Membership API). Neither is a device
  route. `GET /v1/admin/devices` (`invincible devices`) reports the sets this node grants, the
  record both routes write, and a pairing reply says what the joining device got. `GET
  /v1/cluster/nodes` reports the other direction: what each peer granted this machine when it
  joined.
- **A missing set is `shard`.** A `devices.json` written before capabilities existed has no set for
  its devices, and the safe reading of "nothing recorded" is the least: `shard`, which is what those
  devices could reach. Nothing is migrated ahead of time; the entry is written back with its set the
  next time it changes.
- The set governs the HTTP surface. A shard *link* (mode `0x03`, [cluster.md](cluster.md)) is
  admitted by `[cluster] heads`, which names the devices that may run work on this machine — being
  granted `shard` is not being named a head, and `GET /v1/cluster/node` says `shard: false` to a
  device that is not one.

## Vectors

- `vectors/pairing-code.json`: parsing pairing codes.
- `vectors/noise.json`: full transcripts (both handshake messages, then one transport message each
  way) for pairing and for a session, produced by snow with the RFC 7748 X25519 test keys and fixed
  ephemeral keys. A device's Noise implementation, run with the same keys, must produce the same
  bytes. Invincible's CI re-checks them against snow.

## Revocation

- `invincible devices --remove <name>` on the node unpins a device. Its next handshake fails, and an
  open connection is dropped at the next frame in either direction (a stream the device is only
  reading stops too).
- Revoking a capability (not the pairing) is `invincible devices grant <name> <codes>` with fewer
  codes (`PATCH /v1/admin/devices/{name}`, or `PATCH /v1/cluster/nodes/{name}`, with
  `{"capabilities": [...]}`): the device stays paired, keeps its key and its sessions, and the route
  that capability held answers as an unknown path from the next request. A grant is the same call
  with more.
- A panic wipe in Autobot deletes `device.key`, and with it every pairing.

## Limits

- At most 64 handshakes are in progress at once, from anyone; further connections are dropped
  until one finishes (each has 10 seconds).
- A paired device holds at most 32 sessions at once.
- Request headers must arrive within 30 seconds.
- Body limits, per route, on both listeners — a route takes what it needs and no more. A body over
  its route's limit is refused with **413** and a message that names the limit in bytes, before the
  body is read:

  | Route | Device session | Loopback | Why that number |
  |---|---|---|---|
  | `POST /v1/chat/completions` | 32 MiB (33554432) | 32 MiB | a conversation's text plus its images (below) |
  | `POST /v1/dispatch/chat/completions` | 32 MiB | 32 MiB | a chat completion, forwarded whole; a device reaches it with the `dispatch` capability |
  | `POST /v1/messages` | — | 32 MiB | the same conversation, Anthropic's shape |
  | `POST /v1/cluster/meter` | 5 MiB (5242880) | 16 MiB | the 4 MiB bulk payload the link meter sends, and room for a larger post on the operator's own bench |
  | `POST /v1/agent*` | 64 MiB for a turn, 1 MiB otherwise | 64 MiB for a turn, 1 MiB otherwise | the agent's own caps (spec/agent.md) |

  A route a device was not granted is not limited on its way to a 404: it is refused there. The
  checks run in one order — **capability, then the node's ceiling, then the route's limit** —
  because a 413 or a 503 answers with a number from this node's configuration, and a device the
  operator did not admit may not learn that number, nor make the node reserve a byte for a body it
  will never read ([Capabilities](#capabilities), `require_capability`).

- The chat limit is not a context window, because a chat body is not bounded by one. Its text is
  (128k tokens is about 512 KiB at four characters a token), but its images arrive as base64
  `data:` URLs — a third larger than the bytes they carry — the token estimate charges 1 600 tokens
  an image whatever its size, and a provider takes 20 MB an image. So bytes bound an image, and
  32 MiB holds a few of them. It is also the operator's documented ceiling and the size a head
  dispatches to a paired node unchanged, which is why a device session's chat limit cannot be
  lower than loopback's: a request the operator's API accepted must still arrive over a session.
- The node holds at most `[node] max_buffered_bytes` of device request bodies at once, across every
  request in flight: **256 MiB (268435456)** unless the operator sets it. Each device request
  reserves what its body can hold — its `Content-Length`, or the route's limit when it declares
  none — before the first byte is read, and gives it back when the request is answered. A request
  that would pass the ceiling is refused with **503** and `Retry-After: 2`, before anything is
  allocated, so 32 sessions × 32 MiB is refused at the ceiling rather than taking the node down
  with it; the node keeps answering everything else (healthz, the operator's API, a completion
  that fits). Nothing else is counted: the meter reads and discards its body as it arrives (no more
  than one frame of it is held at a time), and the operator's own loopback bodies are not charged to
  a ceiling meant for the callers the node does not sit behind.

## The tunnel

`invincible tunnel` on a paired machine opens a plain-HTTP door on loopback; each request through
it is its own session. The door asks for that machine's local token (`Authorization: Bearer` or
`x-api-key`, as on a node's own API, from the same file as a node's `invincible token`) and a
loopback `Host` header, so a web page open in a browser on that machine cannot use it, by
cross-site request or DNS rebinding. It removes both headers before the request enters the
session: the node knows the device by its key, and the local token stays on that machine.

## Open questions

- Key rotation, and re-pairing without a fresh code.
- Reaching a phone that is asleep (recipes delivering results): polling only, or an optional push
  path that reveals nothing.
