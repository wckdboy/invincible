# Discovery (v0)

> **Implemented, not yet independently reviewed.** `crates/invincible/src/discovery.rs`, with
> `tests/discovery.rs` and unit tests beside the code. Treat it as unaudited until a security
> review signs it off, like [pairing.md](pairing.md).

How a node becomes findable without a human pasting an `invincible://` code — and why finding a
node still authorises nothing.

Discovery is two places a small signed record can be left: a **seed** (a URL the operator lists)
and **mDNS on a LAN** (no configuration, no server). The record is a **descriptor**: what the node
is, where it can be reached, which model ids it serves, how much dispatch it will take, and when
the statement expires. The node signs it with its own key. A seed stores and returns it; mDNS
carries it. Neither can make a node trusted.

## What discovery is not

- **Not trust.** A descriptor is a candidate. Nothing in this module writes `devices.json` or
  `nodes.json`, pins a key, opens a session, or calls pairing.
- **Not a DHT and not a tracker.** A seed has no routing table, no scoring, no gossip, no
  decisions. It stores what it is given and hands it back.
- **Not an address oracle.** A node announces only the addresses in `[discovery] addresses`; it
  never detects an interface and advertises it.

## Keys and identity

A node has two long-lived keys, both already in use:

| Key | File | Used for | In the descriptor |
|---|---|---|---|
| X25519 static | `node.key` | the Noise handshakes in [pairing.md](pairing.md); a pairing code carries its public half | `node`, base64url; `fingerprint`, its first 8 bytes in hex groups |
| Ed25519 receipt | `receipt.key` | signing receipts ([receipts.md](receipts.md)) and now descriptors | `sign_key`, base64url |

`fingerprint` is checked against `node` and refused if it does not match; it is for reading, not a
second identity. The descriptor signs with the receipt key because that is the key `GET /v1/node`
already publishes and a device already pins at pairing, so a paired device can tell that a
discovered record came from the node it paired with.

**The binding before pairing is self-asserted.** Nothing proves that the holder of `sign_key` also
holds the X25519 private key for `node` until the Noise IK handshake. A seed can therefore hand out
a descriptor naming someone else's fingerprint with a key of its own. That forges a *candidate*, not
a *session*: the impostor cannot complete the handshake at the announced address, because it does
not hold the X25519 private key. It can waste one connect attempt and make a discovery list wrong.
It cannot pair, and it cannot impersonate a node that is already paired (that pin is checked in the
handshake and on every frame). This is stated here rather than papered over, and it is the reason a
descriptor is never treated as authorisation.

Two records that claim one fingerprint under different signing keys are both kept and both listed,
with a warning that the fingerprint was claimed twice. A client cannot tell which is genuine before
pairing, so it shows the conflict instead of choosing; a record from a node that is already paired
is labelled `signed by another key` when its signer is not the receipt key pinned at pairing.

## The descriptor

One JSON object, at most 8 KiB:

```json
{
  "v": 1,
  "node": "5H5d…",
  "fingerprint": "3f2a-91c0-77de-0b14",
  "sign_key": "9mQ…",
  "addresses": ["192.168.1.20:7778", "100.101.102.103:7778"],
  "models": ["qwen3-4b", "llama-3-8b"],
  "dispatch": { "max_inflight": 2 },
  "issued": 1793000000,
  "expires": 1793003600,
  "sig": "…"
}
```

| Field | Meaning | Rule |
|---|---|---|
| `v` | format version | must be `1`; unknown fields are refused, so a new field is a new version |
| `node` | X25519 public key, base64url | 32 bytes |
| `fingerprint` | `fingerprint(node)` | must equal the computed value; a mismatch is refused naming `fingerprint` |
| `sign_key` | Ed25519 public key, base64url | 32 bytes, a valid Ed25519 point |
| `addresses` | `host:port` a client may try, in the operator's order | 1–8 entries, no schemes, no paths, no whitespace; IPv6 in brackets |
| `models` | model ids this node serves | at most 32, each 1–128 bytes, no control characters |
| `dispatch.max_inflight` | `[node] dispatch_max_inflight`: requests it will run at once; `0` means spoken for | at most 1024 |
| `issued` | Unix seconds | not more than 5 minutes ahead of the verifier's clock |
| `expires` | Unix seconds | after `issued`, at most 24 hours after it, and after the verifier's clock |
| `sig` | base64url Ed25519 signature | 64 bytes |

No field is a path, a usage count, a peer list, a prompt, a token, or any part of a private key.
The record is exactly what a node would tell a stranger: this is me, this is where I am, these are
the model ids I serve, this is how much work I take, this is when the statement stops being true.

`addresses` usually repeats `[remote] advertise`, but it is a separate decision on purpose: that
list goes into a public record, so announce only the addresses you want strangers to try.
`[discovery] addresses` is never derived from an interface.

### Signing and verification

The signed message is the domain separator, then the canonical JSON (RFC 8785, the same
[canonical form](receipts.md) receipts use) of every field except `sig`:

```
invincible-discovery/1\n{ "addresses":[…],"dispatch":…,…,"v":1 }
```

Verification is one signature check, in this order:

1. `v` is known.
2. `node` and `sign_key` decode; `fingerprint` matches `node`.
3. Shape: address count/syntax, model count/length, dispatch cap.
4. Time: `expires > issued`, lifetime ≤ 24 h, `issued` not in the future (5 min skew), `expires`
   after now.
5. `sig` decodes and verifies under `sign_key` over the canonical body.

The first failure is returned with the field it names (`fingerprint`, `expires`, `issued`,
`addresses`, `models`, `dispatch`, `v`, `sign_key`, `signature`). A signature failure names
`signature` and lists the fields it covers: one signature over a document cannot say *which* byte
was changed, only that the document is not the one that was signed.

A verifier rejects, and a seed may still store: a forged record is caught where it is used, not
where it is cached.

## Seeds

A seed is any HTTP service that answers two paths. `invincible seed` is a reference one; nothing in
the protocol requires it to be this program.

### `POST /v1/discovery/announce`

Body: the signed descriptor object, exactly as minted. At most 8 KiB; a larger body is `413`.

```http
POST /v1/discovery/announce
Content-Type: application/json

{ "v": 1, "node": …, "fingerprint": …, "sign_key": …, "addresses": […], "models": […],
  "dispatch": { "max_inflight": 2 }, "issued": …, "expires": …, "sig": … }
```

```json
200 { "stored": true, "fingerprint": "3f2a-91c0-77de-0b14", "records": 4 }
400 { "error": { "code": "invalid_descriptor", "message": "`signature`: an unsigned record is not stored" } }
413  (body over the limit)
429 { "error": { "code": "rate_limited", "message": "too many announces from this address; try again in a minute" } }
503 { "error": { "code": "seed_full", "message": "`seed`: full: 1000 records" } }
```

A seed checks only what keeps it from being a free file host: it parses the object, requires
`node`/`sign_key`/`addresses`/`expires`/`sig` to be present and shaped, refuses an already expired
record, caps the body, the rate (30 announces per source address per minute by default) and the
record count (1000 by default). It does **not** verify the signature, and it does not decide whether
a node is good: that would make it a trust authority, which a seed is not.

One record per `(node, sign_key)`: a later announcement for the same node replaces the earlier one.

### `GET /v1/discovery/peers?fingerprint=`

Returns every unexpired record, or only that fingerprint's. `fingerprint` is optional.

```json
200 { "peers": [ { "v": 1, "node": …, "sig": … }, … ] }
```

The seed returns records exactly as they were stored, in arrival order. It never re-signs, rewrites
or filters by content.

### What a seed can and cannot do

| Can | Cannot |
|---|---|
| withhold a record | forge one that verifies (it holds no node's signing key) |
| replay an old record until it expires | extend an expiry (the signature covers it) |
| replace a node's record with a different one from the same key | change an address or model list without breaking the signature |
| learn who announces, from where, and when | pair, authorise, or make a client trust a node |
| go down, or be full | see prompts, traffic, keys, usage or peer lists |

**Anonymity is the price.** A seed learns the announcing node's source address, the timing of every
announce, and everything in the descriptor (addresses, model ids, capacity, fingerprint). That is
inherent in asking a third party to hold your record. mDNS has the same consequence one hop closer:
every host on the LAN sees the announcement. A node that cannot pay that price should leave
`announce = false` (the default), use pairing codes, and reach peers over WireGuard or Tor without
discovery. Announcing a *seed URL* over Tor is not implemented; the seed's address is contacted
directly on the node's configured network.

## LAN discovery (mDNS)

With `[discovery] lan = true` (default) and `announce = true`, `invincible announce --lan` registers
a DNS-SD service:

- service type: `_invincible._udp.local.`
- instance name: the fingerprint (`3f2a-91c0-77de-0b14`)
- TXT: `v=1`, `fp=<fingerprint>`, then the descriptor's JSON, base64url, split into `d0`, `d1`, …
  chunks of 200 bytes (at most 8 chunks; a bigger descriptor is not announced over mDNS)
- SRV/A records: from the first `[discovery] addresses` entry written as a literal `ip:port`. A
  hostname cannot be advertised; if no entry is a literal address, mDNS registration fails with
  that reason rather than guessing an interface.

`invincible discover --lan` browses for about three seconds, reassembles the chunks, and verifies
the descriptor. Truncated or gapped chunks are refused (`txt`). A missing chunk is not silently
reassembled short.

Nothing is fetched from the announced address to complete a LAN record: the descriptor is
self-contained, so discovery never makes a request to an unverified node.

The mDNS socket is not exercised by the test suite (no multicast in CI); the TXT payload functions
and the descriptor they carry are unit-tested, and real mDNS is **untested**.

## Commands

```
invincible announce [--lan] [--config PATH]
invincible discover [--model ID] [--seed URL]... [--lan] [--json] [--config PATH]
invincible seed [--listen 127.0.0.1:7789] [--max-records N] [--per-ip-per-min N]
```

- `announce` mints the descriptor from `[discovery] addresses`, `[[models]]`,
  `[node] dispatch_max_inflight` and `[discovery] lifetime`, then POSTs it to every
  `[discovery] seeds` entry. It exits after the posts unless `--lan` is given, in which case it also
  answers mDNS in the foreground and re-mints the record every `lifetime / 3` until Ctrl-C. It
  refuses to run when `announce = false`: publishing is a decision.
- `discover` asks the configured seeds (plus `--seed`), optionally browses mDNS, verifies every
  record, stores the verified ones in `$INVINCIBLE_HOME/discovery.json`, and prints fingerprint,
  addresses, model ids, minutes to expiry, trust state and source. `--model` filters by model id.
  Refused records are printed with the field that failed. It never pairs and never writes
  `devices.json`; the last line says so.
- `seed` runs the reference seed. It prints that it learns who announces.

`GET /v1/discovery` on the **operator** API (token required) shows:

```json
{ "announce": true, "descriptor": { … }, "expires_in": 3120, "seeds": ["https://…"], "held": [ … ] }
```

`held` is the verified store. The route is **not** on the device allowlist: a paired device gets a
404 for it exactly as for any path that does not exist ([pairing.md](pairing.md), Transport).

## What a discovered-but-unpaired node may not do

A discovered node has no session, no token, no route and no receipt trust. Concretely, until the
normal pairing flow completes:

- no Noise session: `POST /v1/chat/completions` over `0x02` needs a pinned key and fails;
- no shard link: `0x03` needs a pin *and* `[cluster] heads`;
- no dispatch: `dispatch` only probes `nodes.json` peers, which discovery never writes;
- no receipt verification: the receipt key is pinned at pairing, not taken from a descriptor;
- no API: the descriptor advertises a `host:port`, not a credential.

Pairing remains the only authorisation. `invincible discover` ends by saying a found node still
needs a code from that node.

## Limits and deliberate omissions

- A descriptor lives at most 24 hours and defaults to 1 hour. There is no revocation gossip: an
  unpair or a key change takes effect at the next expiry, or immediately in pairing (the pin is
  what matters). A descriptor is not a certificate and there is no CRL.
- Seeds are memory-only in the reference implementation; a restart empties them. A node re-announces
  on its own schedule (`invincible announce` from a timer).
- Announcement is one-shot or mDNS-foreground. There is no daemon-side republisher and no push to
  seeds from `serve`; `serve` mints a descriptor at startup so `GET /v1/discovery` can show it,
  but nothing posts it.
- No seed federation, no peer exchange between seeds, no NAT traversal, no relay selection, no
  automatic pairing, no trust on first use. The last one is the point.
- No IPv6-only mDNS interface selection: `mdns-sd` chooses interfaces; the descriptor can carry
  IPv6 `[addr]:port` addresses that clients try.
