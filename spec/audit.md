# Audit log (v0)

A node keeps a log of every request it answered: when, who asked, and the request's signed
receipt ([receipts.md](receipts.md)). The receipt says where it ran and what left the node; the log
adds the time and the caller, and links each entry to the one before it, so an entry removed or
changed later breaks the chain, unless whoever changed it also rewrote every later entry (see
[what it proves](#what-it-proves)). Like a receipt, it never holds prompt or answer text.

The Autobot Agent keeps a second log, of its actions ([below](#the-agents-action-log)).

## Where it is

`$INVINCIBLE_HOME/audit.jsonl`, mode 0600, one JSON object per line, oldest first. Past 16 MiB it
is renamed `audit.1.jsonl` (replacing an older one) and a new file continues the chain. There is no
telemetry: the log is only ever read on the node, or by a paired device that asks for it.

## An entry

```json
{
  "at": 1792400000,
  "caller": "device:My-Phone",
  "client": "autobot-agent",
  "api": "chat",
  "prev": "3f1c…",
  "receipt": { "receipt": { … }, "signature": "…" }
}
```

| Field | Present | Meaning |
|---|---|---|
| `at` | always | Unix seconds when the answer finished |
| `caller` | always | `local` (the loopback API, with the token) or `device:<name>` (a paired device, by the name it was pinned under) |
| `client` | when sent | What the caller says it is, from the `invincible-client` request header (64 printable ASCII characters at most). The Autobot Agent sends `autobot-agent`. Not authenticated: `caller` is. |
| `api` | always | `chat` (`/v1/chat/completions`) or `messages` (`/v1/messages`) |
| `prev` | always | Lowercase hex SHA-256 of the previous entry's line (its exact bytes, without the newline); 64 zeros for the first entry ever written |
| `receipt` | always | The signed receipt envelope, exactly as `GET /v1/receipts/{id}` returns it |

Requests the router asked about or refused are logged too: their receipt's decision says so.

## Checking it

`invincible audit --verify` reads the log oldest first and checks, for every entry:

1. its `prev` is the hash of the line before it (the first entry in the files is taken as given,
   since its predecessor may have been rotated away);
2. its receipt is signed by this node's receipt key, and the signature verifies.

A removed, reordered or edited entry breaks (1) or (2), unless the later entries were rewritten too.

## What it proves

The chain is plain SHA-256, not keyed, and the node's receipt key lives on the same machine. So:

- **Receipts cannot be forged** without the receipt key: what a receipt says (where a request ran,
  what left the node) holds for any entry that verifies, and a device that kept its own receipts
  can check them against the log.
- **The time, the caller and the order** are not signed. Someone who can write the log can change
  them, or delete entries, and recompute every later `prev`; `--verify` then still passes.
  Removing the newest entries, or the rotated file, is never caught by the chain.

The log is a record kept for the owner, protected by the machine's file permissions; it is not
evidence against someone who controls the machine. Sending checkpoints of the chain's head to a
paired device (so a later rewrite shows) is a planned addition.

## Reading it

- `invincible audit`: the newest entries, one line each (time, caller, where it ran, tokens, what
  left). `--since 24h`, `--limit N`, `--summary` (totals per model and per host reached), `--json`.
- `GET /v1/audit?since=<unix seconds>&limit=<n>` on the loopback API (behind the token) and the
  device API: `{"entries": [...], "summary": {...}, "kept": true}`. The newest `limit` entries at or
  after `since` (default 100, at most 500), oldest first. Every paired device can read every entry:
  pairing is for the owner's own devices.

`summary` is:

```json
{
  "requests": 12, "ran": 11, "refused": 1,
  "models": [{ "model": "qwen3.5-4b", "requests": 10, "tokens_in": 8200, "tokens_out": 1900 }],
  "egress": [{ "host": "api.anthropic.com", "requests": 1, "bytes_sent": 14200, "bytes_received": 3900 }]
}
```

`refused` counts every request that did not run (asked or blocked). An empty `egress` means
nothing left the node in that time.

## The agent's action log

The Autobot Agent logs every action that goes through its approval rules (a command, a file write,
a read outside the working directory, sending a turn to a cloud model), in
`$AUTOBOT_HOME/actions.jsonl` (mode 0600, rotated at 8 MiB to `actions.1.jsonl`):

```json
{"at": 1792400000, "session": "phone-1", "kind": "command", "action": "run: ls -la", "ran": true, "by": "app"}
```

`by` says who decided: `policy` (the approval rules allowed or refused it), `grant` (the owner said
"always" earlier in the session), or the channel the owner answered on (`cli`, `app`, `telegram`).
A scheduled run has no one to ask: `unattended`. Read it with `autobot actions` or
`GET /v1/agent/actions?since=&limit=` ([agent.md](agent.md)).
