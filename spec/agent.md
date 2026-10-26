# Agent API, v0

The Autobot Agent (`autobot serve`) answers on loopback (default `127.0.0.1:7792`). Invincible
Gateway passes every request under `/v1/agent` through to it, for local clients with the gateway's
token, and for a paired device only when the node granted that device the `agent` capability
(spec/pairing.md, Capabilities) — never by default.

The reason it is a capability and not a route every device has: the proxy carries the node's own
bearer token, so a device that can call it takes agent turns with the node's tools, writes
schedules on the node and spends its cloud models — operator-equivalent, not what pairing grants.
A device without the capability is answered exactly as a path that does not exist (404, same body),
so it cannot even learn the route is there. Granting is the operator's: `POST /v1/cluster/pair
{"capabilities": ["shard", "agent"]}` pre-grants a code, `PATCH /v1/admin/devices/{name}
{"capabilities": [...]}` (`invincible devices grant <name> shard,agent`, or the same body on `PATCH
/v1/cluster/nodes/{name}`) grants or revokes a device already paired, and `GET /v1/admin/devices`
shows what each holds. A device cannot widen its own set: the pairing hello is not an input, and
the device API has no route that changes it.

The agent accepts only requests that carry the gateway's token (`Authorization: Bearer ***
the file `$INVINCIBLE_HOME/token`). The gateway adds it when it passes a request through,
with `invincible-caller: local` or `invincible-caller: device:<name>` saying who is asking (the
agent uses it for a recipe's origin).
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
| `GET /v1/agent` | | `{"name", "model", "workdir", "approvals": "ask"\|"edits"\|"allowlist"\|"trust", "private": bool, "bot", "bots": [names]}`: about the bot `?bot=` names (the default one without it) |
| `GET /v1/agent/bots` | | `{"bots": [...]}`: every bot on the machine, running or not ([Bots](#bots)) |
| `POST /v1/agent/bots/{name}/enable`, `POST /v1/agent/bots/{name}/disable` | | `{"ok": true, "enabled", "restart": false, "status": "running"\|"stopped"\|"error", "error"?}`: kept in the bot's config, and `autobot serve` starts or stops it at once (`restart: true` and no `status` from an agent that cannot). `404` (`unknown_bot`) |
| `POST /v1/agent/bots/reload` | `{}` | `{"started", "stopped", "restarted", "persona", "failed": [{"name", "error"}], "running"}` (names): the running bots brought in line with their configuration now, as `autobot serve` does on its own within seconds of a change. `persona`: bots whose `SOUL.md` changed (read at every turn; nothing restarts). `409` (`not_configurable`) without bots to reload, `400` (`invalid_config`) when `config.toml` does not load |
| `GET /v1/agent/sessions?bot=` | | `{"sessions": [{"id", "modified", "bot"}]}`: every bot's conversations (only `bot`'s with it), newest first; `modified` in Unix seconds |
| `GET /v1/agent/sessions/{id}` | | `{"id", "messages": [...]}`: the conversation in the OpenAI chat shape; a user message with images keeps them by reference in `autobot_images` (`[{"path", "name", "sha256", "bytes", "mime", "width", "height"}]`), never their bytes |
| `POST /v1/agent/sessions/{id}/turns` | `{"text": "..."}`, optional `"personality"` (a name from `/v1/agent/personalities`, or `"none"`, for this turn), `"bot"` and `"images"` (below) | An event stream (below); `400` for an unknown personality, or images that are not taken (`model_cannot_see_images` when the model cannot see). `bot` says which bot answers a new conversation; one that exists keeps its bot. `404` (`unknown_bot`) when there is no such bot |
| `POST /v1/agent/sessions/{id}/retry` | `{}` | An event stream, like a turn: the last turn leaves the conversation and its request (with its images) runs again; files it changed stay. `404` when there is no turn to retry, `409` while one runs |
| `POST /v1/agent/sessions/{id}/fork` | `{"to"?, "at"?}` | `{"id", "messages"}`: a new conversation starting as this one did, up to message `at` (rounded to the end of that turn; all of it by default) |
| `POST /v1/agent/sessions/{id}/steer` | `{"text": "..."}` | `{"ok": true}`: a message for the turn running in the session, taken in before the agent's next step; `409` (`no_turn`) when none is running |
| `POST /v1/agent/sessions/{id}/reset` | | `{"id"}`: the conversation starts over; the old one is kept on disk |
| `GET /v1/agent/approvals` | | `{"approvals": [{"id", "session", "text", "action", "agent"?, "bot", "asked_at", "expires_at"}]}`: the questions waiting now, every bot's, oldest first (times in Unix seconds) |
| `POST /v1/agent/approvals/{approval}` | `{"answer": "once"\|"always"\|"deny"}`, or `{"answer": "instead", "text"}` (no, and do this instead) | `{"ok": true}`, or `404` when no such question is waiting |
| `GET /v1/agent/schedules` | | `{"schedules": [{"id", "when", "task", "telegram", "enabled", "running", "next", "last"}]}`, plus `name`, `tools`, `origin` and `to` when set; `next` in Unix seconds or null, `last` null or `{"at", "ok", "result"}` |
| `POST /v1/agent/schedules` | `{"when", "task"}`, optional `"telegram"`, `"to"` (addresses where answers go: `["slack:#ops", "email:me@example.com"]`), `"id"`, `"name"`, `"tools"`, `"enabled"` | `{"id"}`, or `400` when `when` does not parse. With `id`, creates or replaces that schedule (a recipe, below) |
| `DELETE /v1/agent/schedules/{id}` | | `{"ok": true}`, or `404` |
| `POST /v1/agent/schedules/{id}/run` | | `202 {"started": true}`: runs it now, in the background; `409` (`schedule_running`) if it is running |
| `GET /v1/agent/schedules/{id}/runs?after=` | | `{"runs": [{"at", "finished", "ok", "result", "receipts", "trigger"}]}`: finished runs that started after `after` (Unix seconds), oldest first; the newest 100 are kept |
| `GET /v1/agent/board` | | `{"tasks": [{"id", "plan", "agent", "goal", "context", "depends_on", "status", "result", "question", "answers", "receipts", "origin", "notify", "created", "updated"}]}`: the team board; `status` is `todo`, `running`, `blocked` (waiting for the owner's answer to `question`), `done` or `failed` |
| `POST /v1/agent/board/{id}/answer` | `{"text": "…"}` | `{"ok": true}`: a blocked task runs again with the answer; `404` when it is not waiting |
| `GET /v1/agent/actions?since=&limit=` | | `{"actions": [{"at", "session", "kind", "action", "ran", "by", "sandbox", "bot"}]}`: the action log ([audit.md](audit.md); `sandbox` on commands that ran), newest `limit` (default 100, at most 500), oldest first |
| `GET /v1/agent/memory` | | `{"facts": [{"id", "at", "text"}]}`: what the agent remembered (`remember`) |
| `DELETE /v1/agent/memory/{id}` | | `{"ok": true}`, or `404` |
| `GET /v1/agent/skills` | | `{"skills": [{"name", "description", "allowed_tools", "files"}], "proposed": [{"name", "description", "text", "improves", "diff"}]}`: the owner's skills in `$AUTOBOT_HOME/skills` (`files`: a skill directory's supporting files; `allowed_tools`: its front matter's, shown, never granted), and those the agent proposed (`create_skill`, or `improve_skill`: then `improves` is true and `diff` what it changes), which it does not use until accepted |
| `POST /v1/agent/skills/{name}/accept` | | `{"ok": true}`: the proposal becomes a skill (an improvement replaces the skill's SKILL.md); `404` when there is none, or a new one has the name of a skill |
| `POST /v1/agent/skills/{name}/reject` | | `{"ok": true}`, or `404` |
| `GET /v1/agent/personalities` | | `{"active", "soul", "personalities": [{"name", "description", "builtin"}]}`: the personality in use (null for none), SOUL.md's text (null when there is none), and the ones there are |
| `POST /v1/agent/personality` | `{"name"}` (`"none"` or null for none) | `{"active"}`: the personality for every turn from now on; `400` for an unknown one |
| `GET /v1/agent/profile` | | `{"entries": [...], "text"}`: what the agent keeps about how the owner works (`USER.md`) |
| `GET /v1/agent/usage?session=&bot=` | | `{"today": totals, "session"?: totals, "bot"}` from the bot's turn log (the default bot's without `bot`): `totals` is `{"turns", "calls", "cloud_calls", "input", "output", "cached", "cloud_tokens", "seconds", "cost", "unpriced"}` (`cost` in dollars for the models with a `[prices]` entry; `unpriced`: cloud models without one) |
| `POST /v1/agent/openai/v1/chat/completions?bot=` | an OpenAI chat request | An OpenAI `chat.completion` (or, with `"stream": true`, its chunks and `[DONE]`): the last user message is a turn of the bot `model` names (else `?bot=`, else the default one) in its conversation `homeassistant-<user>`. For Home Assistant's conversation agent; nobody can approve, so its turns follow the unattended rules |
| `GET /v1/agent/openai/v1/models` | | `{"object": "list", "data": [{"id"}]}`: the running bots |
| `GET /v1/agent/stats` | | `{"tasks", "open_sessions", "waiting"}`: what the process holds now (tasks on its runtime, conversations kept in memory, every bot's; questions waiting), for monitoring. At most 64 idle conversations per bot stay in memory; past that the one used longest ago is let go (it is on disk), and with it what the owner said "always" to in it |
| `POST /v1/agent/alerts/test` | `{}` | A test alert, now, to where `[alerts]` sends them (`to`, else the default bot's home channel), whatever the limits and quiet hours: `{"sent": [{"to", "error"?}]}`; 409 `no_alerts` when there is no address (`autobot alerts test`) |
| `GET /v1/agent/insights?days=&bot=` | | What the bot did over the last `days` (default 7), with `"bot"`: `{"days", "turns", "seconds", "calls", "tokens", "cost", "unpriced", "local_share": {"calls", "tokens"}, "tools": [{"name", "count"}], "projects": [{"name", "count"}], "models": [{"model", "calls", "tokens", "cloud"}], "failures": {"errors", "stopped", "tool_errors", "refused"}}` |

A session id is 1 to 64 characters from letters, digits, `-` and `_`. A turn on a session that is
already running one answers `409` with type `session_busy`.

## Bots

One `autobot serve` runs several bots, each with its own persona, model, memory, conversations
and schedules (README, "Bots and channels"). Every path takes `?bot=<name>`; without it, a path
under `/v1/agent/sessions/{id}` is for the bot that holds that conversation, and anything else for
the default bot, named `default` (the configuration in `config.toml`). An unknown bot is `404` with
code `unknown_bot`. A node from before bots answers `404` on `/v1/agent/bots`: one bot.

`GET /v1/agent/bots` lists each bot as:

| Field | Meaning |
|---|---|
| `name` | `default`, or the bot's directory name |
| `persona` | The first non-empty line of its `SOUL.md`; `""` without one |
| `model` | The model it uses now (`/model` can change it while it runs) |
| `approvals` | `ask`, `edits`, `allowlist` or `trust` |
| `enabled` | Whether `autobot serve` runs it |
| `status` | `running`, `stopped` (disabled, or not started), or `error` (it could not start; `error` says why) |
| `error`? | Why it could not start |
| `channels` | `[{"kind", "account", "status", "error"?}]`: `kind` is `telegram`, `discord`, `slack`, `email`, `signal`, `matrix`, `whatsapp` or `api`; `account` what it is reached as (`@mybot`, `@U0BOT`, `bot@example.org`, `+15551234567`, `+1 555-0100`); `status` `connected`, `connecting` or `down` |
| `sessions` | How many conversations it has |
| `last_active` | When its newest conversation changed (Unix seconds), or null |
| `queue` | Messages sent to running turns, not yet taken in |

Running bots also carry `description`, `default`, `running` (turns now), `turns`, `uptime` (seconds),
`waiting` (questions), `home_channel`, `last_error` (`{"at", "text"}` or null) and `homeassistant`
(the address its `home` tool reaches, or null).

The list is of the bots running now: `autobot serve` starts, stops and restarts bots as their
configuration changes, and a restarted bot starts with no questions waiting in its chats.

## Addresses

Where a schedule's answers (`to`), a hook's (`to`) or the bot's notices (its home channel,
`/sethome`) go: `platform:where`. `telegram:<chat id>`, `discord:<channel id>`,
`slack:<channel id or #name>` (`slack:C123/<thread ts>` for a thread), `email:<address>` (or the
thread a conversation is in), `signal:<number>`, `matrix:<room id>`, `whatsapp:<number, digits
only>` (delivered only within 24 hours of that person's last message). A schedule with none of `to`,
`telegram` or a chat that asked for it answers to the home channel; a phone's recipe never does
(the phone collects its runs).

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
| `answer` | `text`, `receipts` | The turn's answer; the last event of the turn |
| `error` | `text`, `code`? | The turn failed; the last event. `code` is `model_cannot_see_images` when the model the router picked refused the turn's images |
| `kept` | `text` | After `answer`, when the turn was at a nudge: what the agent kept on its own (`profile: …`, `memory: …`), one event each. The stream stays open for it at most 30 seconds; the conversation is free for the next turn already |

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
{"kind": "home", "service": "light.turn_on", "entities": "light.kitchen", "data": "{\"brightness_pct\":40}"}
```

`home` is a Home Assistant service call (`data`: its other fields as JSON, `""` for none).
`[approvals] allow` entries `home:<domain>.<service>` and `home:<domain>.*` let one run unasked.

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
| `memory` | `remember`, `search_sessions` (with a summary of the best matches, [Recall](#recall)), `create_skill`, `improve_skill`, `update_user_profile` |
| `terminal` | `terminal` (allowlisted commands only), `process`, `execute_code` (a script, asked for like a command) |
| `mcp` | every configured MCP server's tools (`<server>__<tool>`; unattended, only `mcp:<server>/<tool>` allowlisted) |
| `plan` | `todo` |
| `home` | `home` (Home Assistant, where it is set up) |
| `schedule` | `schedule_task`, `list_schedules`, `cancel_schedule` |
| `media` | `speak`, `generate_image`, where the node has a speech or image backend (one off the machine asks like a cloud model, and is refused unattended) |
| `vault` | none: this machine has no such tool |

No `tools` means every tool, as for schedules made here; a schedule from a device must name its
`tools`, and a device can replace only schedules it made itself (`400` otherwise). An interval is
at most `every 366d`. The phone sends its schedule in UTC
(`CRON_TZ=UTC 0 5 * * *` for 07:00 at UTC+2), so it runs at the phone's time wherever the
machine is, and sends it again when its UTC offset changes. The schedule records its `origin`
(`device:<name>`, from `invincible-caller`; no device reaches `/v1/agent` yet, so in practice a
local client posts one). Posting it again with the same `id` replaces it and keeps its creation
time; `enabled: false` keeps it without running it. The phone collects results
with `GET …/runs?after=<last run it has>`, so nothing is lost while it is away.

On this machine, `[agent] tools` keeps a bot to some groups and `[agent] disabled_tools` turns
single tools off (`autobot tools`); a recipe's `tools` work within what is left.

## Images in a turn

A turn may carry images beside its text, as OpenAI-style parts:

```json
{"text": "what is on this label?", "images": [
  {"type": "image_url", "image_url": {"url": "data:image/jpeg;base64,…"}}
]}
```

- Each is a `data:` URL in base64 of a PNG, JPEG, WebP or GIF (by its bytes); at most **4** in a
  turn and **10 MiB** each, decoded (the body as a whole at most 64 MiB, through the gateway
  too). The text may be empty when there are images.
- They are kept in `$AUTOBOT_HOME/attachments` (`sent-<time>-<random>.<ext>`, 0600), and the
  conversation keeps a reference to each (`autobot_images` on the user message), as with an image
  pasted in the terminal: it goes to the model with every call while its message is in the window,
  scaled down to 1568 pixels on the longest side when larger.
- When the gateway says the bot's model cannot see (`vision: false` in `/v1/models`; `auto`
  when none of its models can), the turn is refused with `400` and the code
  `model_cannot_see_images`, before anything runs. When that is only found out later (the router
  picked a model that refused the images), the stream's last event is an `error` with that
  `code`.
- Anything else wrong (more than 4, too large, not an image, not a `data:` URL) is a `400`
  (`invalid_request_error`) saying which.

## Recall

`search_sessions` (and `/recall`) answer with, for each of the three conversations that match
best, `[<id> · <date>]`, a short summary of what it holds about the query, and up to three of
its matching messages (`user: …`, `assistant: …`); then `Also mentioned in:` and other matches.
The summary is a model call on the gateway (the bot's model, or `[agent] recall_model`), with a
`receipt` event, and is kept until that conversation changes. Without it (the model is down, or
`recall_model = "off"`) the messages alone come back.

## Files a turn makes

A turn that used `speak` or `generate_image` keeps the file in `$AUTOBOT_HOME/attachments`, and
the tool's result (in the `tool` events and the conversation) says where. Chat platforms get it
with the answer: Telegram as a voice message or a photo, Discord as an attachment, Slack as a file
in the thread (the app needs `files:write`), Signal as an attachment, Matrix as uploaded media
(`m.audio`, marked a voice message, and `m.image`), WhatsApp as an audio or image message
(MP3, OGG, AAC, PNG or JPEG; WhatsApp takes no other type that way) and email attached to the
answer (up to 18 MB in all; more goes in a mail of its own). A file a platform cannot take, or
whose upload fails, is named with its path instead.

## Editors: the Agent Client Protocol

`autobot acp` speaks [ACP](https://agentclientprotocol.com) version 1 on standard input and
output (JSON-RPC 2.0, one message per line; its log goes to standard error), so an editor can
use the agent directly, without the API above. How Autobot fills the protocol in:

| ACP | Autobot |
|---|---|
| `initialize` | `loadSession: true`; prompts take text, images and embedded files; no MCP transports; no authentication |
| `session/new` `{cwd}` | A conversation `acp-<12 hex>` coding in `cwd` (absolute), as `autobot code` there; its `modes` are the approval modes `ask`, `edits`, `allowlist`, `trust`, the configured one current |
| `session/load` | The conversation told again as `user_message_chunk`, `agent_message_chunk`, `tool_call` and `tool_call_update`, then `{}` with its modes |
| `session/prompt` | One turn: `agent_message_chunk` as the answer streams (the whole answer at the end when it did not), `agent_thought_chunk` for reasoning, and per tool a `tool_call` (an edit with `content: [{type: "diff", path, oldText, newText}]` before it is asked about) and its `tool_call_update` (`in_progress`, then `completed` or `failed` with the output); `stopReason` `end_turn`, `max_turn_requests` (the step budget) or `cancelled` |
| `session/request_permission` | What the mode asks about, with `allow-once`, `allow-always` (this session) and `reject-once`; cancelled or unanswered is no |
| `fs/read_text_file`, `fs/write_text_file` | `read_file`, `write_file` and `edit_file` go through the editor when it offers them |
| `session/set_mode` | The approval mode, from the next turn |
| `session/cancel` | The turn stops where it is; a tool call that was running may have partly run |
