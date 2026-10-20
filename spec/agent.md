# Agent API, v0

The Autobot Agent (`autobot serve`) answers on loopback (default `127.0.0.1:7792`). Invincible
Gateway passes every request under `/v1/agent` through to it, for local clients with the gateway's
token and for paired devices over their Noise session. A paired phone can therefore start agent
turns on the owner's machine, watch them and answer approvals, with nothing exposed beyond what
pairing already exposes.

The agent accepts only requests that carry the gateway's token (`Authorization: Bearer <token>`,
the file `$INVINCIBLE_HOME/token`). The gateway adds it when it passes a device's request through,
with `invincible-caller: device:<name>` (or `local`) saying who is asking; only the gateway can set
it, since only it has the token.
If the agent is not running, the gateway answers `503` with error type `agent_unavailable`.

One path needs no token: `GET /healthz` on the agent's own address (not under `/v1/agent`, so not
through the gateway) answers `{"status": "ok", "version": "0.0.12"}` and nothing more. The
gateway answers the same at its `GET /healthz`. The services' watchdog, the installer and
monitoring use them.

Every `POST` must say `Content-Type: application/json` (`415` otherwise), so a web page cannot
reach the agent with a form or a no-cors request. The gateway passes on only `/v1/agent` paths made
of plain segments (no `.`, `..`, encoded dots or slashes, or backslashes), and answers `404` for
others.

Errors use the gateway's shape: `{"error": {"message": "...", "type": "...", "code": "..."}}`.

## Endpoints

| Method and path | Body | Answer |
|---|---|---|
| `GET /v1/agent` | | `{"name", "model", "workdir", "approvals": "ask"\|"allowlist"\|"trust", "private": bool}` |
| `GET /v1/agent/sessions` | | `{"sessions": [{"id", "modified"}]}`, newest first; `modified` in Unix seconds |
| `GET /v1/agent/sessions/{id}` | | `{"id", "messages": [...]}`: the conversation in the OpenAI chat shape; a user message with images keeps them by reference in `autobot_images` (`[{"path", "name", "sha256", "bytes", "mime", "width", "height"}]`), never their bytes |
| `POST /v1/agent/sessions/{id}/turns` | `{"text": "..."}`, optional `"personality"` (a name from `/v1/agent/personalities`, or `"none"`, for this turn) | An event stream (below); `400` for an unknown personality |
| `POST /v1/agent/sessions/{id}/retry` | `{}` | An event stream, like a turn: the last turn leaves the conversation and its request (with its images) runs again; files it changed stay. `404` when there is no turn to retry, `409` while one runs |
| `POST /v1/agent/sessions/{id}/fork` | `{"to"?, "at"?}` | `{"id", "messages"}`: a new conversation starting as this one did, up to message `at` (rounded to the end of that turn; all of it by default) |
| `POST /v1/agent/sessions/{id}/steer` | `{"text": "..."}` | `{"ok": true}`: a message for the turn running in the session, taken in before the agent's next step; `409` (`no_turn`) when none is running |
| `POST /v1/agent/sessions/{id}/reset` | | `{"id"}`: the conversation starts over; the old one is kept on disk |
| `GET /v1/agent/approvals` | | `{"approvals": [{"id", "session", "text", "action", "agent"?, "asked_at", "expires_at"}]}`: the questions waiting now, oldest first (times in Unix seconds) |
| `POST /v1/agent/approvals/{approval}` | `{"answer": "once"\|"always"\|"deny"}`, or `{"answer": "instead", "text"}` (no, and do this instead) | `{"ok": true}`, or `404` when no such question is waiting |
| `GET /v1/agent/schedules` | | `{"schedules": [{"id", "when", "task", "telegram", "enabled", "running", "next", "last"}]}`, plus `name`, `tools` and `origin` when set; `next` in Unix seconds or null, `last` null or `{"at", "ok", "result"}` |
| `POST /v1/agent/schedules` | `{"when", "task"}`, optional `"telegram"`, `"id"`, `"name"`, `"tools"`, `"enabled"` | `{"id"}`, or `400` when `when` does not parse. With `id`, creates or replaces that schedule (a recipe, below) |
| `DELETE /v1/agent/schedules/{id}` | | `{"ok": true}`, or `404` |
| `POST /v1/agent/schedules/{id}/run` | | `202 {"started": true}`: runs it now, in the background; `409` (`schedule_running`) if it is running |
| `GET /v1/agent/schedules/{id}/runs?after=` | | `{"runs": [{"at", "finished", "ok", "result", "receipts", "trigger"}]}`: finished runs that started after `after` (Unix seconds), oldest first; the newest 100 are kept |
| `GET /v1/agent/board` | | `{"tasks": [{"id", "plan", "agent", "goal", "context", "depends_on", "status", "result", "question", "answers", "receipts", "origin", "notify", "created", "updated"}]}`: the team board; `status` is `todo`, `running`, `blocked` (waiting for the owner's answer to `question`), `done` or `failed` |
| `POST /v1/agent/board/{id}/answer` | `{"text": "…"}` | `{"ok": true}`: a blocked task runs again with the answer; `404` when it is not waiting |
| `GET /v1/agent/actions?since=&limit=` | | `{"actions": [{"at", "session", "kind", "action", "ran", "by"}]}`: the action log ([audit.md](audit.md)), newest `limit` (default 100, at most 500), oldest first |
| `GET /v1/agent/memory` | | `{"facts": [{"id", "at", "text"}]}`: what the agent remembered (`remember`) |
| `DELETE /v1/agent/memory/{id}` | | `{"ok": true}`, or `404` |
| `GET /v1/agent/skills` | | `{"skills": [{"name", "description", "allowed_tools", "files"}], "proposed": [{"name", "description", "text", "improves", "diff"}]}`: the owner's skills in `$AUTOBOT_HOME/skills` (`files`: a skill directory's supporting files; `allowed_tools`: its front matter's, shown, never granted), and those the agent proposed (`create_skill`, or `improve_skill`: then `improves` is true and `diff` what it changes), which it does not use until accepted |
| `POST /v1/agent/skills/{name}/accept` | | `{"ok": true}`: the proposal becomes a skill (an improvement replaces the skill's SKILL.md); `404` when there is none, or a new one has the name of a skill |
| `POST /v1/agent/skills/{name}/reject` | | `{"ok": true}`, or `404` |
| `GET /v1/agent/personalities` | | `{"active", "soul", "personalities": [{"name", "description", "builtin"}]}`: the personality in use (null for none), SOUL.md's text (null when there is none), and the ones there are |
| `POST /v1/agent/personality` | `{"name"}` (`"none"` or null for none) | `{"active"}`: the personality for every turn from now on; `400` for an unknown one |
| `GET /v1/agent/profile` | | `{"entries": [...], "text"}`: what the agent keeps about how the owner works (`USER.md`) |
| `GET /v1/agent/usage?session=` | | `{"today": totals, "session"?: totals}` from the turn log: `totals` is `{"turns", "calls", "cloud_calls", "input", "output", "cached", "cloud_tokens", "seconds", "cost", "unpriced"}` (`cost` in dollars for the models with a `[prices]` entry; `unpriced`: cloud models without one) |
| `GET /v1/agent/insights?days=` | | What the agent did over the last `days` (default 7): `{"days", "turns", "seconds", "calls", "tokens", "cost", "unpriced", "local_share": {"calls", "tokens"}, "tools": [{"name", "count"}], "projects": [{"name", "count"}], "models": [{"model", "calls", "tokens", "cloud"}], "failures": {"errors", "stopped", "tool_errors", "refused"}}` |

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
| `member` | `agent`, `text` | A team member finished the task it was handed; `text` is its answer to the lead |
| `answer` | `text`, `receipts` | The turn's answer; the last event |
| `error` | `text` | The turn failed; the last event |

An `approval` from a team member also has `agent` (its name), and its `text` starts with
`[<name>] `; `tool` and `refused` texts from a member start the same way.

`action` says what is asked, so a client can show it properly:

```json
{"kind": "command", "command": "rm -rf build"}
{"kind": "write", "path": "/home/me/work/notes.md", "bytes": 120, "inside": true}
{"kind": "read", "path": "/etc/hosts"}
{"kind": "cloud", "reason": "cloud use needs confirmation"}
{"kind": "fetch", "url": "https://docs.rs/serde"}
{"kind": "mcp", "tool": "github/get_issue", "arguments": "{\"number\": 7}"}
{"kind": "type", "page": "https://example.org/login", "field": "element #user", "text": "me", "submit": false}
```

`type` is the browser typing into a page (`text` empty and `submit` true: submitting its form).
Navigating the browser to a new site asks as a `fetch` of the site's origin.

A question nobody answers within 10 minutes counts as `deny`. The turn goes on if the client
disconnects. It is saved in the session, and its approvals can still be answered by id until they
expire.

## Scheduled tasks

`when` is a cron expression in the machine's local time (or in UTC, prefixed `CRON_TZ=UTC `) (five fields: minute, hour, day of month,
month, day of week, where 0 and 7 are Sunday; `*`, lists, ranges and `/steps`), one of `@hourly`,
`@daily`, `@weekly` and `@monthly`, `every <n>m|h|d`, or once: `in <n>m|h|d` or `at HH:MM` (made
absolute when the schedule is saved, as `once <RFC 3339 time>`, and removed after it runs). Nobody is there to approve a scheduled
run, so it follows `allowlist` rules: allowlisted commands and writes in the working directory,
nothing else, unless the agent's approval mode is `trust`. Each schedule has its own conversation,
`cron-<id>`, readable with `GET /v1/agent/sessions/cron-<id>`. With `telegram`, every answer also goes
to the Telegram users allowed to use the bot.

Every run is kept with its whole answer (up to 64 KiB), the receipt ids of its model calls, and its
`trigger` (`schedule` or `manual`). A receipt is `GET /v1/receipts/{id}` on the gateway, which
finds older ones in its audit log ([audit.md](audit.md)).

## Recipes from Autobot

Autobot hands a recipe to the machine as a schedule with its own `id` (`r-<recipe id>`), a
`name`, and `tools`: the tool groups the recipe allows. Only the tools in those groups are offered
to the model and run, whatever the approval mode, and still under the unattended rules:

| Group | Tools here |
|---|---|
| `files-read` | `read_file`, `list_dir`, `read_skill` |
| `web` | `web_fetch` (asks first; unattended, only allowlisted `https://` sites), `browser` where one is installed (a new site asks like a fetch; typing into a page asks, and is refused unattended) |
| `files-write` | `write_file`, `edit_file` (in the working directory) |
| `memory` | `remember`, `search_sessions`, `create_skill`, `improve_skill`, `update_user_profile` |
| `terminal` | `terminal` (allowlisted commands only), `process`, `execute_code` (a script, asked for like a command) |
| `mcp` | every configured MCP server's tools (`<server>__<tool>`; unattended, only `mcp:<server>/<tool>` allowlisted) |
| `vault` | none: this machine has no such tool |

No `tools` means every tool, as for schedules made here; a schedule from a device must name its
`tools`, and a device can replace only schedules it made itself (`400` otherwise). An interval is
at most `every 366d`. The phone sends its schedule in UTC
(`CRON_TZ=UTC 0 5 * * *` for 07:00 at UTC+2), so it runs at the phone's time wherever the
machine is, and sends it again when its UTC offset changes. The schedule records its `origin`
(`device:<name>`, from `invincible-caller`). Posting it again with the same `id` replaces it and
keeps its creation time; `enabled: false` keeps it without running it. The phone collects results
with `GET …/runs?after=<last run it has>`, so nothing is lost while it is away.
