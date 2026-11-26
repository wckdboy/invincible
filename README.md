# Invincible

**Your primary agent, and the agents it runs.**

You talk to one agent: yours, named by you. It plans, gives the work to agents that each run in a sandbox of their
own, checks their work with real commands and a reviewer that didn't write it, and ships what passes. Every server,
device, client and agent talks to the others over [Q-AMP](https://sovware.io/wckdboy/qamp): one encrypted, key-bound
fabric with no passwords.

```sh
curl -fsSL https://invincible.sh | bash
```

**Status:** being built, 26 November 2026. Invincible succeeds the owner's earlier agent system
([docs/ARCHITECTURE.md §10](docs/ARCHITECTURE.md)), and carries over its parts that were already proven: the signed
requests, the vault, sandboxed VMs, model providers, and the gates-and-reviewer verifier.
Everything is designed around the primary agent. [docs/PLAN.md](docs/PLAN.md) says what exists and what comes next.

- [The mandate](docs/MANDATE.md): what "best" means, in four numbers.
- [The architecture](docs/ARCHITECTURE.md): the shape of the system and why.
- [The plan](docs/PLAN.md): the phases, each with how we know it's done.
- [AGENTS.md](AGENTS.md): how any agent, Invincible's own included, works on this repository.

Apache-2.0.
