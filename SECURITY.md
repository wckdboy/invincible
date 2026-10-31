# Security policy

## Reporting a vulnerability

Report it privately on GitHub: open this repository's **Security** tab and choose **Report a
vulnerability** ([private vulnerability reporting](https://github.com/wckdboy/invincible/security/advisories/new)).
If the Security tab has no **Report a vulnerability** button, open an issue titled
`security contact` with no details; a maintainer will open a private advisory and invite you to it.
Only the maintainers see the report, and the fix, the advisory and the credit are worked out with
you there.

Please do not describe it in a public issue, pull request or discussion, and keep it private
until the advisory is published.

A useful report says:

- the versions (`invincible --version`, `autobot --version`) and the platform;
- what an attacker needs: a paired device, a device on the same network, a model file, a prompt,
  a message on a channel, an account on the machine;
- what they get;
- the steps, or a proof of concept.

Test on a node you own. Leave other people's nodes alone.

## Scope

In scope, everything in this repository:

- **The node** (`invincible`: `crates/invincible`, `crates/invincible-policy`): the local API and
  its token, pairing and remote access over Noise, device capabilities, discovery, cluster shard
  links, dispatch, routing, redaction, receipts, the audit log, egress and the kill switch, GPU
  rental (`[rent]`, `/v1/rent/*`, the images in `sidecar/`), updates.
- **The agent** (`autobot`: `crates/autobot`): approvals and the allowlist, write confinement of
  unattended commands, the agent API, channels and bots, webhooks, skills, MCP, backups.
- **The installer** (`install.sh`) and `invincible update`: the signature and checksum checks, and
  what they download and run.
- **Release signing**: the release key, the release workflow, `SHA256SUMS` and its signature, the
  build attestations. A suspected compromise of the release key is critical.
- **The spec** (`spec/`): a rule or conformance vector that is unsafe as written, even when both
  implementations follow it.

Not in scope here:

- The Autobot phone app: it has its own repository,
  [wckdboy/autobot](https://github.com/wckdboy/autobot). Until that repository has its own
  security policy, report app issues privately here, as above.
- The websites (invincible.sh, autobot.sh).
- llama.cpp, other engines and model weights themselves: report those to their projects. How the
  node runs them (the ports it opens, what it passes them) is in scope.
- What a cloud provider does with what it receives.
- Settings that do what they say: the `trust` and `auto` approval modes, `[agent] sandbox = "off"`,
  a capability the operator granted.

**Limits that are already documented.** These are known; a way around them that the docs do not
describe is a finding.

- Unattended commands are write-confined only, and only on the agent's own machine: a command's
  own writes go only to its working directory and temp. Reads, the network and the programs it
  can talk to (systemd or launchd, D-Bus, Docker's socket, the node's and agent's local APIs, any
  other socket) are not restricted yet, so it can read what the owner can, reach any host and
  have a program outside the sandbox write for it ([README](README.md), Sandbox). Over
  `[agent.ssh]` the other machine is what holds a command, and in `[agent.docker]` the
  container, which mounts the working directory read-write. A delegated run (**Keep going**) is
  not unattended in this sense: what its approval mode lets run without asking runs as in an
  interactive turn, unconfined unless `[agent] sandbox = "always"`.
- The working directory is shared between unattended and interactive work. A confined command,
  or one in the `[agent.docker]` container, can leave files there (`core.hooksPath` or
  `core.fsmonitor` in `.git/config`, a `Makefile`, `node_modules/.bin`, an `.envrc` once someone
  runs `direnv allow` on it) that a later unconfined interactive turn, or the owner's own shell,
  runs in that directory ([README](README.md), Sandbox). Autobot's own `git` runs there on the
  agent's machine, and in the thread worktrees made from it (which share its `.git/config` and
  hooks), unconfined even with `[agent.docker]` set or `[agent] sandbox = "always"`: `/diff`, the
  project map that `autobot code`, `autobot run -C`, Zed and a thread start with, `autobot map`,
  `autobot review`, and every thread action, from `autobot thread`, the API or the panel:
  starting one (`git worktree add`), listing them or showing one (`git status` in its worktree;
  the panel lists them while it is open), a thread's diff and pull request, and removing one. So
  a `core.fsmonitor` left in `.git/config`, a diff driver or filter there that a `.gitattributes`
  names, or a hook one of them runs (`post-checkout` when a thread starts, those a commit or push
  runs), can run when one of them does.
- The node has had an internal security review, not yet an independent one; pairing, remote
  access and discovery are implemented and unaudited ([README](README.md#status)).
- Data on disk is not encrypted at rest. Keys, tokens and the audit log are files only the owner's
  account can read (mode 0600).
- The node trusts its owner: anything that runs as the owner's account on the node's machine, or
  holds the local token, can do what the owner can.

## Response targets

- **Acknowledge** a report within 3 days.
- **High or critical** (as rated in the advisory): a fix, or a plan with a date, within 14 days.
- **Lower severity:** fixed in a coming release; the advisory thread says which.

These are targets, not guarantees. If one slips, the advisory thread says so.

## How fixes are released

- **A patch release** on the stable channel, and the next edge build, signed and attested like
  every release. Its release notes say it is a security fix. `invincible update` installs it, and
  so does the daily update for those who turned it on (`invincible update --auto stable`).
- **A GitHub security advisory** on this repository, published once the release is out: what is
  affected, which versions, which version fixes it, and credit to the reporter unless they ask
  for none. When a vulnerability in a released version warrants a CVE ID, the project requests
  one through the GitHub advisory and publishes it there once it is assigned.

## Supported versions

| Version | Gets security fixes |
| --- | --- |
| The latest stable release ([latest](https://github.com/wckdboy/invincible/releases/latest)) | yes |
| edge (the newest build from main, `--channel edge`) | yes |
| Older releases | no: update with `invincible update` |

## The release-signing key

Every release's `SHA256SUMS` is signed with this SSH key, in the namespace `invincible-release`.
`install.sh` pins it, `invincible update` checks with it, and
[invincible.sh/verify](https://invincible.sh/verify/) shows it:

```
invincible-release ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAII/0fXPq1j51BcfGY0Jp9QfPGy6kHVQQ+W282VFPR/Qo
```

Its fingerprint is `SHA256:4i+8H37Nm9hiL/ce25aKi+QfYgXMzNfmd4fIidDqBIQ` (ED25519). To check a
release by hand, in an empty directory, set `archive` to your platform's archive as `SHA256SUMS`
names it (`invincible-linux-x64.tar.gz`, `invincible-linux-arm64.tar.gz` or
`invincible-macos-arm64.tar.gz`):

```sh
archive=invincible-linux-x64.tar.gz   # or invincible-linux-arm64.tar.gz, invincible-macos-arm64.tar.gz
base=https://github.com/wckdboy/invincible/releases/latest/download   # or releases/download/<tag>
curl -fLO "$base/SHA256SUMS"
curl -fLO "$base/SHA256SUMS.sig"
curl -fLO "$base/$archive"
echo 'invincible-release ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAII/0fXPq1j51BcfGY0Jp9QfPGy6kHVQQ+W282VFPR/Qo' > allowed_signers
ssh-keygen -lf allowed_signers        # prints the fingerprint above
ssh-keygen -Y verify -f allowed_signers -I invincible-release -n invincible-release -s SHA256SUMS.sig < SHA256SUMS
shasum -a 256 -c SHA256SUMS --ignore-missing
```

`ssh-keygen -Y verify` must print `Good "invincible-release" signature`, and `shasum` must print
your archive's name followed by `: OK` (`invincible-linux-x64.tar.gz: OK`). `--ignore-missing`
skips every file the list names that is not in the directory, the other platforms' archives and
an archive saved under another name alike, so without that `OK` line your archive was not
checked.

A release whose signature does not verify with this key is not ours: do not install it, and report
it as above.
