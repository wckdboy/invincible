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
one. After 5 failed pairing handshakes the code is burned.

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
2. The node uses up the code, then pins the device's static key under the name. Using up the code
   is atomic: of two handshakes that both prove the same code, only the first pins a device, and a
   handshake whose code was replaced, burned or expired while it ran pins nothing. Names are
   cleaned to ASCII letters, digits, `-` and `_`, at most 40 characters. A name already in use by another key gets a number (`phone-2`). A
   key that paired before keeps one entry, renamed.
3. Node → device, handshake message 2. Payload:
   `{"node": "<node name>", "device": "<name pinned>", "receipts": "<receipt public key>"}`. The device
   pins the receipt key and uses it to verify the node's receipts ([receipts.md](receipts.md)).
4. The connection continues as a session (below).

### Session (`0x02`)

1. Device → node, handshake message 1, empty payload.
2. If the device's static key is not pinned, the node closes the connection without replying.
3. Node → device, handshake message 2, empty payload.

### Transport

After the handshake each frame holds one Noise transport message carrying at most 65519 bytes of
plaintext. In each direction the plaintexts, concatenated, form a byte stream, and that stream is
plain **HTTP/1.1** to the node's API. A device reaches `/v1/models`, `/v1/chat/completions`,
`/v1/receipts/<id>` and `/v1/node`
(the same endpoints, headers and behaviour as on loopback) with no token, because its key already
authenticates it. A device cannot reach the admin endpoints.

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
- A panic wipe in Autobot deletes `device.key`, and with it every pairing.

## Limits

- At most 64 handshakes are in progress at once, from anyone; further connections are dropped
  until one finishes (each has 10 seconds).
- A paired device holds at most 32 sessions at once.
- Request headers must arrive within 30 seconds.

## The tunnel

`invincible tunnel` on a paired machine opens a plain-HTTP door on loopback; each request through
it is its own session. The door asks for that machine's local token (`Authorization: Bearer`, the
same file as a node's `invincible token`) and a loopback `Host` header, so a web page open in a
browser on that machine cannot use it, by cross-site request or DNS rebinding.

## Open questions

- Key rotation, and re-pairing without a fresh code.
- Reaching a phone that is asleep (recipes delivering results): polling only, or an optional push
  path that reveals nothing.
