# Security

Invincible holds keys, runs code in sandboxes and virtual machines, and acts for its owner. A flaw in it can cost someone money, data or a machine, so please report one privately.

## Reporting a vulnerability

Report it privately to the owner, who keeps this repository on sovware.io (sign-in only). Please don't open an issue, a pull request or a discussion about it, and never paste a real key, token or sign-in anywhere.

Say what is affected, how to reproduce it, and what an attacker gains. A minimal reproduction against a fresh node (`invincible init` in a scratch home) helps most. You'll get an answer, and when it's fixed you'll be credited if you want to be.

## What is in scope

- The node: its HTTP routes and their scopes, pairing, request signing, the vault, the model gateway and its tokens, approvals, and the ledger.
- Sandboxes and the agents' VMs: escaping one, reaching the host or another sandbox, reaching the network a sandbox wasn't given, or keeping a token after it should have been revoked.
- Secrets: any way a key, a gateway token, a coding plan's key or a vendor tool's sign-in reaches a model, a log, the ledger, an artifact or the app.
- The PWA: anything that lets a page, a model's output or an agent's words act as the owner.

How each of these is meant to hold is written down in [docs/SECURITY.md](docs/SECURITY.md) and [docs/POLICY.md](docs/POLICY.md); a place where the code does less than those say is a finding too.

## Out of scope

- What a model says or does inside a sandbox it was given: that is what sandboxes are for. Breaking out of one is in scope.
- Attacks that need the owner's admin token or an already paired owner device.
- Third-party services Invincible talks to (model providers, GitHub, Tailscale): report those to their vendors.

## Supported versions

Only `main` is supported. There are no releases yet.
