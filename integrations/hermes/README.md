# Hermes compatibility

Galahad can use Hermes as a sandbox engineering worker (`--agent hermes`) and as a
native memory provider for a separately installed, local Hermes. These are separate
connections with separate credentials.

## Sandbox worker

The workspace image must provide Python 3 and a Hermes installation for which
`hermes acp --check` succeeds. The adapter uses ACP protocol 1 with `session/new`,
`session/load`, `session/set_model`, `session/prompt` and `session/cancel`.
Hermes v0.21.1 supports this interface; its CLI does **not** support the newer
`chat --format stream-json` interface, so the adapter does not depend on it.

The dedicated `/work/.hermes` profile holds Hermes's session database and skills.
Galahad stores the returned session ID and passes it on subsequent runs. A missing
session fails; it is never silently replaced. Old history replay is not counted as
new work. Runs in one workspace must be serialized.

Each run reads `OPENAI_API_KEY` and `GALAHAD_GATEWAY` from the workspace environment,
overridden by `/work/.galahad-gateway.json` when present. That file contains a JSON
object with those two strings; it must be written by the host with mode 0600.
No shell script is sourced. The token is scoped to the workspace gateway, never a
provider key or an owner/arm token. A named custom Hermes provider references the
token by environment variable; no credential is written to `config.yaml`.
Galahad owns this dedicated profile's model config and rewrites it per run.

The VM is the execution boundary. ACP receives no client filesystem or terminal
capabilities. If Hermes advertises its `accept_edits` mode, edits in the workspace
are allowed; remaining permission requests are denied. The bridge stops after 128
completed tools or 15 minutes; Galahad's shorter deadline and gateway request
budget also apply. Cancellation asks ACP to stop; the outer runner terminates the
whole process group. Successful protocol completion is the worker's account, not
an independent verification of its work.

Worker cleanup checks a run ID, Linux process start time, process group and VM boot
ID before signaling. Completed workers clear only their own marker. A legacy
PID-only marker or a surviving group whose leader can no longer be identified
requires stopping that VM before resuming; Galahad does not guess which process to
kill. Linux process tests run on Linux; the development-machine check on macOS
uses procfs-shaped fixtures and does not verify a live Linux VM.

No Hermes installation or update is performed automatically. The installed host
Hermes was probed with a temporary, credential-free home: `acp --check` and the
real initialize handshake passed on v0.21.1. Automated protocol tests use a
stand-in ACP process; they do not prove a model-backed task in a provisioned VM.

## Native memory provider (local Hermes)

Copy the `galahad` directory beside this file into the selected
`$HERMES_HOME/plugins/galahad`, then select it in that profile's `config.yaml`:

```yaml
memory:
  provider: galahad
```

Set these environment variables for Hermes:

```sh
export GALAHAD_MEMORY_URL=http://127.0.0.1:7777
export GALAHAD_MEMORY_TOKEN_FILE=/absolute/path/to/galahad/arms/hermes.token
```

Use a dedicated Galahad arm with `mind:read` and, for notes, `mind:write`. The
existing `galahad mcp install hermes --label hermes` command can provision an arm
and prints its token-file path without printing its token; its default scopes are
broader, so narrow that arm to the two memory scopes for a memory-only setup.
Do not substitute an admin token. The file must be owned by the Hermes user,
private (0600), and a regular file. The plugin reads it afresh for each request.

Only literal loopback origins are accepted. Redirects and ambient proxies are
disabled. Recall is limited to eight records, 12,000 characters, 64 KiB responses
and a two-second HTTP timeout; returned text is fenced as untrusted reference data.
The explicit `galahad_remember` tool adds notes marked untrusted and tagged
`hermes`; Galahad's API enforces the arm scopes and secret scanner. Non-primary
Hermes agents receive recall only. No transcript, compression, session-end or
built-in memory hook automatically writes, replaces or deletes anything.

This provider is for Hermes running beside the local Galahad daemon. A VM's
loopback is the VM itself, and its gateway token is not an arm token. VM workers
receive memory context from their supervising teammate; this plugin does not
expose the daemon's normal memory API to them.

Run the standalone offline memory-provider checks with `python3 -B integrations/hermes/test_memory_provider.py`. The plugin directory itself imports Hermes's `agent.memory_provider` ABI, so recursive unittest discovery also tries to import that installed-only package. These checks do not require an installed Hermes or model credentials.
