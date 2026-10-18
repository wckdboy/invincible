# Invincible spec

The rules Invincible (Rust) and Autobot (Kotlin) must agree on. The two share no code, so they
share this instead: prose that defines each rule, and **conformance vectors** that pin it down.

| Document | Status | What it defines |
|---|---|---|
| [routing.md](routing.md) | **v0, normative** | Where one request runs: node model, cloud model, ask first, or refuse |
| [pairing.md](pairing.md) | **v0, implemented, unaudited** | How a device and a node pair and talk (Noise); pairing-code vectors |
| [redaction.md](redaction.md) | **v0, normative** | What is replaced before a request leaves for the cloud, and how it is restored |
| [receipts.md](receipts.md) | **v0, normative** | The signed receipt for every request: where it ran, what left the node; vectors from an independent Ed25519 |

## Conformance vectors

`vectors/<document>.json` holds cases for a document:

```json
{
  "spec": "routing",
  "version": 0,
  "cases": [
    { "name": "…", "input": { … }, "expect": { … } }
  ]
}
```

- `name` is unique within the file and says what the case proves.
- `input` and `expect` follow the schemas in the document.
- An implementation conforms when, for every case, its output equals `expect` exactly: the same
  fields, the same values, with absent fields absent.

Invincible runs them in `cargo test` (`crates/invincible-policy/tests/vectors.rs` for routing,
`crates/invincible/tests/vectors.rs` for the rest). Autobot runs the same files in its JVM tests.

## Changing a rule

1. Change the document.
2. Add or change vectors that fail under the old rule and pass under the new one.
3. Bump `version` in the vector file when an existing case's expectation changes.
4. Neither side is done until both pass. A rule that exists in only one implementation is a bug.

## Conventions

- **Fail closed.** An unknown or malformed value takes the most private reading: an unknown network
  mode is `offline`, an unknown egress policy is `never`, an unknown tier is `cloud`.
- **Codes, never content.** Reasons and receipts carry stable lowercase codes, never prompt text.
- Field names are `snake_case`.
