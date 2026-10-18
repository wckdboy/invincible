# Receipts (draft)

> **Draft.** Not normative and not implemented (INV-12). No vectors yet.

For every request a node signs a receipt saying where it ran and what left the node. Autobot verifies
it with the node's pinned Ed25519 key and merges it into its own per-turn receipt (`Receipt` in
Autobot's `shared/session/Receipts.kt`).

## Fields

```json
{
  "version": 0,
  "request_id": "01JB…",
  "node": "<ed25519 public key, base64url>",
  "decision": { "action": "run", "model": "qwen3-32b", "tier": "node", "reason": "local-first" },
  "engine": "llama.cpp",
  "tokens": { "input": 1200, "output": 410, "cached": 0 },
  "egress": [
    { "host": "api.anthropic.com", "route": "tor", "bytes_sent": 14200, "bytes_received": 3900 }
  ],
  "redactions": [ { "kind": "PERSON", "count": 2 } ],
  "data_policy": "retention:30"
}
```

- `decision` is the routing decision exactly as [routing.md](routing.md) defines it.
- `egress` is empty when nothing left the node. That is the claim the receipt exists to make.
- `redactions` names kinds and counts as Autobot does, never the values.
- No timestamps finer than the request id already carries, and no prompt or answer content.

## Signature

The signature covers the receipt serialised with the JSON Canonicalization Scheme (RFC 8785), and
travels beside it:

```json
{ "receipt": { … }, "signature": "<ed25519 signature, base64url>" }
```
