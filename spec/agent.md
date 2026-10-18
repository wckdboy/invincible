# Agent API, v0

The Autobot Agent (`autobot serve`) answers on loopback (default `127.0.0.1:7792`). Invincible
Gateway passes every request under `/v1/agent` through to it, for local clients with the gateway's
token and for paired devices over their Noise session. A paired phone can therefore start agent
turns on the owner's machine, watch them and answer approvals, with nothing exposed beyond what
pairing already exposes.

The agent accepts only requests that carry the gateway's token (`Authorization: Bearer <token>`,
the file `$INVINCIBLE_HOME/token`). The gateway adds it when it passes a device's request through.
If the agent is not running, the gateway answers `503` with error type `agent_unavailable`.

Errors use the gateway's shape: `{"error": {"message": "...", "type": "...", "code": "..."}}`.

## Endpoints

| Method and path | Body | Answer |
|---|---|---|
| `GET /v1/agent` | | `{"name", "model", "workdir", "approvals": "ask"\|"allowlist"\|"trust", "private": bool}` |
| `GET /v1/agent/sessions` | | `{"sessions": [{"id", "modified"}]}`, newest first; `modified` in Unix seconds |
| `GET /v1/agent/sessions/{id}` | | `{"id", "messages": [...]}`: the conversation in the OpenAI chat shape |
| `POST /v1/agent/sessions/{id}/turns` | `{"text": "..."}` | An event stream (below) |
| `POST /v1/agent/sessions/{id}/reset` | | `{"id"}`: the conversation starts over; the old one is kept on disk |
| `POST /v1/agent/approvals/{approval}` | `{"answer": "once"\|"always"\|"deny"}` | `{"ok": true}`, or `404` when no such question is waiting |
| `GET /v1/agent/schedules` | | `{"schedules": [{"id", "when", "task", "telegram", "next", "last"}]}`; `next` in Unix seconds or null, `last` null or `{"at", "ok", "result"}` |
| `POST /v1/agent/schedules` | `{"when": "...", "task": "...", "telegram": bool}` | `{"id"}`, or `400` when `when` does not parse |
| `DELETE /v1/agent/schedules/{id}` | | `{"ok": true}`, or `404` |

A session id is 1 to 64 characters from letters, digits, `-` and `_`. A turn on a session that is
already running one answers `409` with type `session_busy`.

## Turn events

`text/event-stream`: one `data: <json>` line per event, each followed by a blank line. Every event
has a `type`:

| `type` | Fields | Meaning |
|---|---|---|
| `tool` | `text` | A tool is about to run (`run: ls -la`, `write 120 bytes to /…`) |
| `refused` | `text` | A tool call was refused, by policy or by the owner |
| `receipt` | `id`, `model`, `tier` | A model call finished; its signed receipt is at `GET /v1/receipts/{id}` |
| `approval` | `id`, `text`, `action` | The agent waits for the owner: answer with `POST /v1/agent/approvals/{id}` |
| `answer` | `text`, `receipts` | The turn's answer; the last event |
| `error` | `text` | The turn failed; the last event |

`action` says what is asked, so a client can show it properly:

```json
{"kind": "command", "command": "rm -rf build"}
{"kind": "write", "path": "/home/me/work/notes.md", "bytes": 120, "inside": true}
{"kind": "read", "path": "/etc/hosts"}
{"kind": "cloud", "reason": "cloud use needs confirmation"}
```

A question nobody answers within 10 minutes counts as `deny`. The turn goes on if the client
disconnects. It is saved in the session, and its approvals can still be answered by id until they
expire.

## Scheduled tasks

`when` is a cron expression in the machine's local time (five fields: minute, hour, day of month,
month, day of week, where 0 and 7 are Sunday; `*`, lists, ranges and `/steps`), one of `@hourly`,
`@daily`, `@weekly` and `@monthly`, or `every <n>m|h|d`. Nobody is there to approve a scheduled
run, so it follows `allowlist` rules: allowlisted commands and writes in the working directory,
nothing else, unless the agent's approval mode is `trust`. Each schedule has its own conversation,
`cron-<id>`, readable with `GET /v1/agent/sessions/cron-<id>`. With `telegram`, every answer also goes
to the Telegram users allowed to use the bot.
