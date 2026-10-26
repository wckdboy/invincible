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
telemetry: the log is read on the node, by `GET /v1/audit` on loopback with the token. A paired
device reads it only when the operator granted it `audit` ([pairing.md](pairing.md),
Capabilities), which no device has by default, and then only its own entries, without `prev`
([Reading it](#reading-it)): the log holds every caller's model, decision, tokens, egress hosts
and the cluster's topology.

## An entry

```json
{
  "at": 1792400000,
  "caller": "device:My-Phone",
  "client": "autobot-agent",
  "api": "chat",
  "prev": "3f1c…",
  "receipt": { "receipt": { … }, "signature": "…" },
  "request_id": "9f2c8a…",
  "caller_key": "q6ur…"
}
```

| Field | Present | Meaning |
|---|---|---|
| `at` | always | Unix seconds when the answer finished |
| `caller` | always | `local` (the loopback API, with the token) or `device:<name>` (a paired device, by the name it was pinned under; a node that sends work here, as a cluster head or a dispatcher, paired the same way and is one too) |
| `client` | when sent | What the caller says it is, from the `invincible-client` request header (64 printable ASCII characters at most). The Autobot Agent sends `autobot-agent`. Not authenticated: `caller` is. |
| `api` | always | `chat` (`/v1/chat/completions`), `messages` (`/v1/messages`), `speech` (`/v1/audio/speech`), `images` (`/v1/images/generations`) or `fetch` (`/v1/fetch`) |
| `prev` | always, but not in a device's read | Lowercase hex SHA-256 of the previous entry's line (its exact bytes, without the newline); 64 zeros for the first entry ever written. A device reading its own entries is not given it ([Reading it](#reading-it)) |
| `receipt` | always | The signed receipt envelope, exactly as `GET /v1/receipts/{id}` returns it |
| `request_id` | since ids were recorded | The request's id, the same one the client was given in the `invincible-request-id` response header and the same one inside its receipt's `request_id`. It is what `invincible receipt verify <id>` looks the entry up by. Entries written before this field existed carry no id: they still verify, but only the id inside their receipt (absent on a version 0 receipt) can reach them |
| `caller_key` | a device's request, since 0.0.22 | The static key (base64url) the device was pinned with. The name in `caller` is a label a later device may take; this is the identity a device's own read of the log is filtered by. Not signed, like `caller`. Never on the operator's entries, and never taken from anything but the session the request came in on |

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
  what left the node, and — since [receipts.md](receipts.md) version 1 — the request and answer
  hashes, the caller and the time) holds for any entry that verifies, and a device that kept its own
  receipts can check them against the log.
- **The entry's `at`, `caller` and `caller_key` fields are not signed** — the receipt's own `at` and
  `caller` are (version 1), and those are the ones to read. Someone who can write the log can
  change the entry's fields, or delete entries, and recompute every later `prev`; `--verify` then
  still passes. Removing the newest entries, or the rotated file, is never caught by the chain.

The log is a record kept for the owner, protected by the machine's file permissions; it is not
evidence against someone who controls the machine. Sending checkpoints of the chain's head to a
paired device (so a later rewrite shows) is a planned addition.

## Reading it

- `invincible audit`: the newest entries, one line each (time, caller, where it ran, tokens, what
  left). `--since 24h`, `--limit N`, `--summary` (totals per model and per host reached), `--json`.
- `GET /v1/audit?since=<unix seconds>&limit=<n>` on the loopback API (behind the token) and the
  device API: `{"entries": [...], "summary": {...}, "kept": true}`. The newest `limit` entries at or
  after `since` (default 100, at most 500), oldest first. On a device session this needs the
  `audit` capability (spec/pairing.md, Capabilities), and a device without it is answered as though
  the route did not exist. A device that holds it reads **its own entries only**: those whose
  `caller_key` is the key it was pinned with. Not the operator's, not another device's, not those
  of an earlier device that went by the same name, and none written before entries carried the key
  (0.0.21 and earlier, and edge builds from before it). `limit`, `since` and `summary` count those
  entries alone: `limit=1` is the device's newest entry, not the log's. A completion a device had
  this node dispatch is its own entry (with `dispatch` on it); a request a head dispatched here is
  the head's, since the head is the paired device that sent it. A device's entries come without
  `prev`, and are otherwise as the log holds them: `prev` is the hash of whichever line came
  before, often another caller's, so a device that hashed its own entry and compared it with the
  next one's `prev` would learn whether anyone used the node in between. It could not check the
  chain with it anyway, never seeing the lines it links. The operator's read, on loopback, is every
  caller's, with the chain.

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
{"at": 1792400000, "session": "phone-1", "kind": "command", "action": "run: ls -la", "ran": true, "by": "app", "sandbox": "off"}
```

`by` says who decided: `policy` (the approval rules allowed or refused it), `grant` (the owner said
"always" earlier in the session), or the channel the owner answered on (`cli`, `app`, `telegram`).
A run with no one to ask (a schedule, `autobot run`): `unattended`. Read it with `autobot actions`
or `GET /v1/agent/actions?since=&limit=` ([agent.md](agent.md)).

`sandbox`, on a command that ran, says where it ran and how it was confined:

| Value | The command ran |
|---|---|
| `bwrap` (Linux), `sandbox-exec` (macOS) | on this machine, write-confined: its own writes only in the working directory and temporary directories |
| `off` | on this machine, unconfined |
| `container` | in the `[agent.docker]` container |
| `ssh` | on the `[agent.ssh]` machine |

Commands with nobody watching (schedules, board work, recipes, hooks, Home Assistant's
conversation agent, the heartbeat, `autobot run`) are write-confined unless
`[agent] sandbox = "off"` or `autobot run --no-sandbox` turned that off, so `off` on one of them
is that choice on record; interactive turns are unconfined unless `[agent] sandbox = "always"`.
`bwrap` or `sandbox-exec` says the command was write-confined (its reads, the network and the
programs it talks to are not limited), not that it succeeded: where bubblewrap is missing or
cannot run, it is refused or fails as it starts. The field is absent on other kinds and on
entries written before it was recorded.
