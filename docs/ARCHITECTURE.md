# Invincible: the architecture

The target shape of the system, and why. [PLAN.md](PLAN.md) says what exists today and in what order the rest comes.
The owner's words, 26 November 2026: *"focused on the Primary Agent, and the other agents for tasks/coding/projects
which the primary can orchestrate … using QAMP for speed, secure agent collaboration across servers, devices,
clients … super modern, sleek, and future focused."*

## Principles

1. **One agent you talk to.** The primary agent is yours, and you name it ("Invincible" until you do). It decides,
   remembers, and does the work itself or gives it to agents. You never have to manage a team.
2. **Agents are workers, not characters.** An agent is a job (coding, research, operations, review) done by a harness
   and a model in a sandbox. It is named by what it does. It has no persona, face or seat.
3. **Done means proven.** A task is finished when its gates pass and a reviewer that didn't write it agrees. The
   proof is shown apart from what the agent says about itself. This is the moat ([MANDATE.md](MANDATE.md)).
4. **One fabric.** Every server, device, client and agent is a key. Every permission is a delegation from a key you
   trust, narrowed at each hop, and every connection is Q-AMP over QUIC. There are no passwords and no bearer tokens
   worth stealing.
5. **Yours.** It runs on hardware you own, on models you choose, with secrets sealed in your vault. It keeps working
   when any one provider is gone.
6. **Fast, and calm.** Streams instead of polling, and the first answer in two round trips. Nothing moves on screen
   that doesn't need you. Interventions per completed task is the number that matters.

## The model

| Word | What it is |
|---|---|
| **Primary** | Your agent: one per fleet, named by you. It holds the conversations, the memory, the tools, and the orchestration. |
| **Agent** | A profile the primary runs work with: a role (coder, researcher, reviewer, planner, operator), a harness (the native loop, Claude Code, Codex, OpenCode, any ACP agent), models, and a sandbox. |
| **Task** | A unit of work: a goal, a project, its gates, a budget. Its states are proposed, queued, running, asking, verified, failed, stopped and done. |
| **Run** | One agent working one task in one sandbox: its steps, its gates' results, the review, the cost, the changes. A task may take several runs (again from a step, on another node). |
| **Project** | A repository or workspace, with its default agent, gates and budget. |
| **Chat** | A conversation with the primary. A task is a thread of its own, opened from the chat it came from. |
| **Node** | A machine running Invincible: a server, a desktop, a Mac mini. It hosts the primary, agents' sandboxes, or both. |
| **Client** | An app on a device of yours: iPhone, iPad, Mac, Android, the web, the CLI. |
| **Fleet** | Your nodes and clients, enrolled by your keys. |
| **Grant** | A capability given to a key: a delegation chain with its tools, its scope, its budget and its expiry. |
| **Approval** | What the primary or an agent wants to do that only you may allow: money, legal, destructive, outward. |
| **Proof** | Each gate's command, exit and time, and the reviewer's verdict, as the runner recorded them. |

No word of the old theme appears anywhere: code, routes, events, copy or docs. CI fails on one (§10).

## 1. The big picture

```
 clients    iPhone · iPad · Mac · Android · web · CLI
              │  Q-AMP (native apps, CLI)  ·  WebTransport or HTTPS with signed requests (browser, fallback)
 nodes      ┌─────────────────────────── node: one Bun process + its Q-AMP sidecar ───────────────────────────┐
            │  primary: chats · memory · tools · orchestration      ledger: the log every node replicates    │
            │  agents: the run loop · gates · reviewer · shipping   vault: sealed secrets · key gateway       │
            │  models: providers · plans · fallback · gateway       approvals · notify · projects · placement │
            └───────────────┬───────────────────────────────────────────────┬────────────────────────────────┘
                            │ Q-AMP: sync, forwarded work, agents' tools    │ local bridge (same host)
            other nodes ◀───┘                                              sandboxes: one microVM per run
```

## 2. Principals and capabilities

- **Every principal is a key,** and its `did:key` is its name:
  - a node: Ed25519, made at install, in the OS keystore;
  - a client: P-256 in the device's secure hardware (Secure Enclave, StrongBox), never exported;
  - a run: Ed25519, made by its node for that run alone and destroyed after;
  - an agent outside the fleet (Claude Code on a laptop, say): its own key, admitted by a grant.
- **Your fleet's root is you.** The first node is founded with your root key. Every node is enrolled and every
  client paired by a delegation from it. Revoking a key cuts it off everywhere, since the revocation is an event in the
  ledger.
- **Capabilities are delegations, narrowed at every hop.** You → a node: enrolled. The primary → a run: this
  project's tools, the key gateway for these providers, this budget, these hours. A run → a sub-agent: less again. The
  HTTP routes' scopes (one per route, carried) become the caveats of these chains, so a route and a Q-AMP tool
  check the same thing.
- **The door decides.** The node checks every call: the signature or the chain, the time, the nonce, the scope. Q-AMP
  carries a call and proves who sent it; it never decides alone.
- **Approvals at real trust boundaries only.** The primary approves its own work and its agents' (the owner's ruling of
  23 November 2026). What moves money, signs something legal, or destroys data asks you, and the asking is never quiet.

## 3. The fabric: Q-AMP

[Q-AMP](https://sovware.io/wckdboy/qamp) is the owner's QUIC Agent Mesh Protocol:
- one QUIC connection between two keys;
- one stream per call, with streamed results;
- cancellation that stops the remote work;
- authorization by delegation chains bound to the caller's key;
- post-quantum key exchange.

Invincible is built on it, and **Q-AMP is developed alongside Invincible** (the owner, 26 November 2026: "keep building
out QAMP"). What runs over it, in order:

| Link | Over | Since |
|---|---|---|
| Node ↔ node: ledger sync, pushes, forwarded work (a sandbox on another node) | Q-AMP, one connection per peer; HTTPS with signed requests as the fallback | Phase 2 |
| An agent outside the fleet using the primary's tools | Q-AMP grants (carried, §10) | Phase 2 |
| A run on another node calling the primary's tools; one agent handing work to another | Q-AMP, the run's own key and chain | Phase 2 |
| Native clients (iPhone, iPad, Mac, Android) ↔ their node | Q-AMP through Swift and Kotlin bindings, signing with the device's hardware key | Phase 5 |
| The browser ↔ its node | WebTransport (HTTP/3), the same frames; HTTPS with signed requests until then | Phase 5 |
| Devices away from your network (a phone on mobile data) | relays and NAT traversal in Q-AMP; a tailnet until then | Phase 5 |

**How a node uses Q-AMP:** a sidecar, the `qamp` binary, beside the Bun process, spoken to over a local socket. The
daemon holds the vault, so no native QUIC stack is loaded into it (the reasoning is in the carried Q-AMP design, 25
November 2026). The sidecar holds no secret but the node's transport key.

**What Q-AMP gains for this, in its own repository, spec first:**
- the sidecar socket API;
- P-256 `did:key` and signing by callback, so a hardware key never leaves its chip;
- Swift and Kotlin bindings;
- a WebTransport binding;
- relays and NAT traversal;
- grants that renew themselves.

Each comes with its tests, a fuzz target where it parses input, and before-and-after numbers.

## 4. The ledger

The ledger is carried whole in kind (§10):
- an append-only log of signed events, one hash chain per device;
- ordered by a hybrid logical clock;
- views rebuilt from the log.

**Convergence is sacred.** The same events in any order give the same state, and a rebuild gives the same state. A new
event kind must be deterministic under replay, and an unknown kind is kept and ignored, never fatal.

Its event kinds are Invincible's own (`chat.*`, `task.*`, `run.*`, `project.*`, `agent.*`, `grant.*`, `approval.*`,
`fleet.*`), so there is nothing to read from the old log. A one-time importer reads the old home instead (§10).

## 5. The primary

- **Conversation:**
  - turns the node owns, streamed;
  - steer, queue, or ask aside while it works;
  - answers that show more than words: charts, figures, steps, choices, pages;
  - photos and files.
- **Memory:** what it learned about you (each fact yours to keep or drop), notes, and the archive it searches.
- **Tools:** search and fetch, files, code in its own computer (a persistent VM with a desktop you can watch and take
  over), connectors you add.
- **Orchestration:** the primary's tools for work are give, check, steer, stop, again-from-a-step, and ship (its steer is
  `team_steer`: its words reach a task that is running, as yours do, §6). It decides who does what:
  - small work it does itself;
  - work in a repository it gives to a coding agent;
  - research to a research agent;
  - a review always to a reviewer on a different model from the one that did the work.

  It follows each task to its proof, and comes back to you with the result, not the play-by-play.
- **Initiative:** it writes first when something happened while you were away, and it proposes the next step when a
  task ends. Loops and triggers (a schedule, a webhook, a failed CI run) wake it.

## 6. Agents, tasks and runs

The run loop is carried and renamed (§10), the most proven part of it:
- **The loop:** restate the task as acceptance criteria, plan, work, verify, report.
- **Gates:** the gates run before any work, so a gate that already passes proves nothing and is said to. Test files a
  gate names are locked. Yours run exactly as given. The planner may propose up to three of its own, and they are only
  its proposal: work that gives up with them in force has them withdrawn, once, and goes on under yours (26 November
  2026: two it proposed asked for a 10-byte file and an 11-byte one, and the task ended though yours could pass).
- **The reviewer:** independent. A review by the model that did the work is marked as one.
- **Tripwires, checks and tells:** rules of yours at fixed points of the work.
- **Audited, never capped:** no command count and no time limit. An independent audit steers the run, and only your
  budget stops it.
- **Steered while it runs:** your words to a running task (`POST /api/team/steer`, `fleet:admin`, as giving and stopping
  one are), or your agent's (`team_steer`, through `POST /api/team/primary-steer`, `mind:write`), reach it at its next
  safe point.
  - In the native loop: a command that's running finishes first, and one it asked for but hasn't started isn't run.
  - A coding harness's run is ended between its tool calls (a call it is in finishes first, for up to 15 minutes; its
    stream says when one begins, but OpenCode's only when one ends) and its own session is told, as the audit's steer is.
  - The trail says it where it was taken ("You: …", "Your agent: …"), and every audit is told it.
  - The reviewer judges the work against its goal and every steer, in order, and the trail says so before its verdict.
    A steer changes what is wanted; it is never a way around the gates or the review. One that comes while the work is
    judged comes before its end: the work takes it up and is judged again.
  - A task takes 20 at most, of 4,000 characters each. One that isn't running is refused in words ("It has ended: give
    it again from a step instead"). A message to a busy agent is queued, as ever: it waits until the agent is free.
- **The work as commits:** each step a commit, so a task can be given again from a step.
- **Effort per step,** and escalation when stuck.
- **Harnesses:**
  - the native tools loop (the default, measured level with OpenCode);
  - Claude Code, Codex and OpenCode through the key gateway (a run uses your keys without seeing them);
  - any ACP agent.
- **Seats:** an account you hold with a vendor, added once, that any agent may use (`packages/core/src/seats.ts`):
  - the kinds: a Claude plan, a ChatGPT plan (through Codex, or Sign in with ChatGPT), a Mistral plan, a coding plan's
    key, an API key;
  - a subscription seat's sign-in lives in its own home on its node, made there by the vendor's own tool in the vendor's
    own flow. The node never reads its files: only the tool's own status command, and five things of what it says;
  - in the ledger (`seat.added`, `seat.policy`, `seat.removed` on your word alone; `seat.signin`, `seat.window`,
    `seat.rested`, `seat.back` from the seat's own node alone). None of them carries a sign-in's address, its code or a
    token. A seat's email is sealed in the vault, and the account its first sign-in was to is kept: a sign-in to
    another is refused on every replica;
  - the rule, your word (26 November 2026, "All, never switch"): every account works side by side, and work running on
    one never moves to a second subscription seat of the same vendor. A spent seat's work waits for its reset, goes to
    another vendor's tool, or uses that plan's own sanctioned capacity. No setting switches accounts (`mayCarryOn`);
  - runs at once on one subscription seat: one until shared runs are shown safe, then three, your word given
    (`SHARED_RUNS_PROVEN`); Codex's homes stay one at a time;
  - a seat's home is a volume of its own (`invincible-seat-<id>`), mounted at `/seats/<id>` only in a VM made for that
    seat from the pinned tools' image (`createSeatVm`): for its sign-in, its status, or a run on it, which shares the
    agent's own `/work`. Its tool is told the home by the variable its vendor documents (`seatEnv`). The host refuses a
    VM more than the seat takes at once, counted from its own containers' labels, so a restart forgets nothing. Only the
    node's own team service makes one, never the sandbox route, and only on a Linux host with Docker (a Mac's volumes are
    disk images only one VM may mount). Removing a seat removes its home, never while a VM has it;
  - its status is asked of its own tool in such a VM (`askSeat`), with the fleet's salt from the vault; the log is told
    only what changes (`recordSeatStatus`), and a sign-in to another account than the seat's, or to another seat's, is
    refused;
  - signed in on the vendor's own page, by the vendor's own tool in a VM made for the seat (`seat-sign-in.ts`): Codex's
    app server by ChatGPT's device code, Claude Code's `auth login` on a terminal of its own, its page's code relayed
    to it once (D7). The card (its page, and Codex's code) is answered to you and kept nowhere; it shows only an address
    on the vendor's own hosts (`signInUrlOk`). Ten minutes, then it lapses. Then the tool's own status says how it
    stands; another account than the seat's is refused and signed out again by the tool's own command. A Mistral plan
    is a key seat (Vibe's sign-in ends in an API key), and Sign in with ChatGPT is the node's own (to come);
  - routes: `GET /api/seats` (`mind:read`); `POST /api/seats`, `/api/seats/remove`, `/api/seats/policy`,
    `/api/seats/sign-in`, `/api/seats/sign-in/answer` and `/api/seats/sign-in/cancel` (`fleet:admin`, yours alone).
- **Sandboxes:**
  - Kata microVMs on Linux and Apple containers on macOS;
  - one per run;
  - a firewall that lets a run reach its node's bridge and nothing it wasn't granted;
  - **a desktop in every agent's VM** unless it is made without one (`--no-desktop`, the forms' **No desktop**): a
    display, a browser, a terminal, an editor and the accessibility bus, which the agent operates with its `desktop`
    command and you watch and take over (the owner's standard, 26 November 2026). One process in the VM holds it
    (deskd: input by XTEST, pictures by MIT-SHM, settling by DAMAGE, the browser over its loopback port), its actions
    named as Anthropic's computer toolset names them; the host speaks to it over one held session per VM, and an
    agent's plain `desktop …` goes there too. It keeps the window manager and the browser running, says a page's
    dialog as it opens, and closes apps as a person does before it stops them. A Mac makes none yet: there an agent's VM is made without one, and the
    ledger says why. What it costs and how fast it is: the scorecard's desktop suite ([BENCHMARKS.md](BENCHMARKS.md)).
- **Shipping:** a run's verified changes become a pull request. Its CI and the review comments come back to the same
  task.
- **Each agent's mark:** the Grille (core's `agent-mark.ts`; the look in DESIGN.md), the node's to give, once, as the
  agent joins (its colour and form after the agents here before it), and saved as its avatar, `{v: 3, color, form}`.
  Agents from before the marks get theirs once, in the order they joined (the team store's `markEveryone`), so a team's
  marks are the same wherever it is read. A colour you pick (`{v: 2, color}`, as the pickers send it) is snapped to
  the eight, its form kept. Every app draws the mark from core's numbers, held by the vectors' `marks`; an app from
  before the marks reads a v 3 avatar as none and draws the agent as it did.

## 7. Models

The models layer, carried (§10):
- providers, with coding plans held to each vendor's terms;
- a roster of models by role, with fallback;
- the gateway that meters every call at your prices;
- local models across the fleet (MLX and Ollama);
- sensitive mode, which holds a task to its own models.

## 8. Clients

- **One interface, every device.**
  - Phones: no tab bar. Home is your agent: the agents in a strip, what needs you (decisions only, each with its one
    answer in place), then the work by proof; a bar at its foot to search, ask and give; a drawer for every other place,
    two taps from Home; notifications and `invincible://` links that land on the exact task, agent, approval or chat.
  - Every client keeps up over the node's live stream (core's live.ts): nothing asked while nothing changes, a dead link
    told within three of the node's beats (4.5 s), and the stream opened again from where it left off, so a renewal
    reads only what changed meanwhile.
  - The iPhone shows a task's proof on its Lock Screen and in its Dynamic Island (core's live-activity.ts): a Live
    Activity the app starts for a task it gives or opens in hand, kept up by the app while it's in front and by the node
    through Apple's `liveactivity` pushes otherwise (each gate, the reviewer, the verdict; fixed words, never a title).
  - While the primary answers, its chat's message box stays open: a message steers it or is queued on the node, a held
    queue says why with Resume, and a side question is answered apart (lib/turns.ts, the apps held to its words).
  - Wide screens: three panes. Your agent pinned atop the work, a task's thread, and its details: the VM, the
    changes, the proof, the cost.
  - It was designed and measured in the last redesign before the carry (§10), and carried over without the old theme.
- **The look** is the new look carried from the system Invincible succeeds (§10), by the owner's word of 26 November
  2026: the field orb (gold, with its beam) for the primary, fields in their own colours for agents, the embers, and the
  INVINCIBLE wordmark. The owner's later word that day: the I-beam as the icon (scripts/mark.ts, with a transparent dark
  variant for iOS), and the apps monochrome, with colour kept for the agents.
- **Its bar** is the owner's: hyper modern and super usable, measured.
  - One focal point per screen.
  - Layered hairline surfaces in each platform's own materials.
  - State in words and colour, never colour alone.
  - Motion that never moves layout; nothing moving at rest.
  - Targets of at least 44 pt.
  - Every screen beside Grok Bot, OpenMausBot and T3 Code before it ships.
- **The apps:**
  - web (a PWA the node serves);
  - iPhone, iPad and Mac in SwiftUI (`apps/apple`: `sh.invincible.bot`, App Store Connect's "Invincible Bot", and
    the Mac's `sh.invincible.bot.mac`, signed with a Developer ID outside the App Store);
  - Android in Kotlin and Compose (`apps/android`: `sh.invincible.bot`);
  - the command line: `invincible` on a node's own machine, and `inv`, a client of a node from anywhere, paired and
    signing with its own key as the apps do ([CLI.md](CLI.md): its commands, and its exit codes as the verdict).
- **Parity:** the pure logic is written once, in TypeScript. The native apps port it, held to vectors the TypeScript
  writes (`apps/apple/scripts/vectors.ts`, from `packages/core` and `apps/web/src/lib`; CI checks them).
- **The primary's name** is the node's to say: "Invincible" until you name it. The apps take it from `whoami`'s
  `primaryName` where a node sends one, and the app itself is called Invincible whatever the primary is named. Everything
  that names an app (bundle IDs, the `invincible:` scheme, keychain services and tags, defaults, the update feed) is
  Invincible's own, so its apps run beside the old system's on one device until the cutover (§10).
- **Install:** `curl -fsSL https://invincible.sh | bash`.

## 9. Packages

| Path | Owns |
|---|---|
| `packages/core` | Contracts (routes, scopes, events, all zod), crypto, canonical JSON, the clock, pairing math, request signing, secret scanning |
| `packages/ledger` | The log and its views, the vault, the fleet's enrolment and revocation |
| `packages/link` | Pairing and sync (the node's side of the Q-AMP sidecar is in `packages/node` for now: its grants, `qamp-grants.ts`) |
| `packages/models` | Providers, plans, the roster, fallback, the gateway, prices and usage; the primary's chat and its prompt, connectors and their sign-ins, decisions, embeddings, and the evals' suites |
| `packages/agents` | The run loop: harnesses, gates, the reviewer, rules, audits, checkpoints, shipping, the team runtime, investigations |
| `packages/sandbox` | VM drivers and their firewall |
| `packages/node` | The daemon, the server, the CLI (`invincible`, and `inv` in `src/inv/`: a client of a node, [CLI.md](CLI.md)), the primary, approvals, notifications, projects, placement |
| `apps/web` | The web client (the PWA the node serves) |
| `apps/apple` | The iPhone, iPad and Mac apps (SwiftUI), the parity vectors' script and fixture, the dev node they run against, their brand assets and release scripts |
| `apps/android` | The Android app (Kotlin and Compose), held to the same vectors |
| `apps/site` | invincible.sh: the page, the installer (`curl -fsSL https://invincible.sh \| bash`), the apps' update feeds and downloads; Astro and one Cloudflare Worker, its own project and lockfile, everything on it read from this repository when it is built |
| `bench/` | The scorecard: every suite against its recorded baseline; the vocabulary check |

**Coexisting with the system it succeeds on one host** (§10) until the cutover:
- the home is `~/.invincible` and the service user is `invincible`;
- ports: 7400 (node), 7401 (behind `tailscale serve`), 7402 (the sandboxes' bridge, `inv0`), 7410–7419/udp (Q-AMP).

## 10. From Galahad

Invincible starts from Galahad `main` at `292e98a6` (26 November 2026), in a repository of its own with a history of
its own.

| | |
|---|---|
| **Carried** | core (crypto, signing, canonical JSON, clock, pairing, secret scanning), the Mind (as the ledger), the link, the vault and key gateway, the brain (as models), sandboxes, the run loop and everything that verifies, approvals, notifications, the live stream, projects and shipping, placement, the scorecard, the apps' plumbing (device keys, pairing, push), the redesign's interface |
| **Reshaped** | Knights become agents (profiles: role, harness, models), each task a thread of its own. The Roundtable becomes the work, by attention. Quests become runs, trials become evals, and the oath gate becomes approvals. Galahad becomes the primary, named by you. |
| **Left behind** | Personas (looks, temperaments, faces, seats, arranging), squires, the bookkeeping, bank, Buzz and MCP-index features, and every word of the theme. Anything else returns only when a task needs it. |
| **Imported once** | `invincible import galahad` reads a Galahad home: your memory and what it learned about you, the vault's secrets (resealed), your projects, providers and keys, connectors, and the chats if you want them. Knights become agent profiles. |

**The import, as built** (`packages/node/src/import/`, its tests in `packages/node/test/import/`):
`invincible import galahad <its home> [--dry-run] [--chats all|none|<id>,<id>]`.
- It reads the home as Galahad keeps it (its config, its node's key file, `mind.db`, `team.db`, `chats.db`, its uploads)
  without writing a byte there, and writes here as this node: new events on its ledger, and its agents' and chats'
  stores.
- What comes:
  - providers (the coding plans among them), the roster, how hard each role thinks, and prices;
  - the vault's keys, opened with its node's key file and sealed anew here, never shown;
  - memory, with its trust and where it came from (what it learned about you, kept and proposed);
  - projects;
  - connectors: one Invincible ships as it ships it, with your address, key and access; one of yours as you made it;
    the knights' labels mapped to the agents' here;
  - each knight as an agent's profile, its job still in whose words it was;
  - chats only as `--chats` says.
- What stays behind: its identity, devices and fleet; its chat apps' bots and device keys; its Apple push key; its loops
  (with their webhook keys), rules, skills and standing orders; the knights' looks, temperaments, seating, rooms, tasks
  and VMs; and a chat that read the bank.
- What this node already holds by a name (or removed) is never written over or brought back, so a second run brings
  nothing.
- A run writes with this node stopped; a dry run writes nothing anywhere and may run beside it.

**Beside it until the cutover:** Galahad keeps running on the owner's machines. Its home (`~/.galahad`), its service,
its ports (7777–7779, and 7781–7789/udp for Q-AMP) and its bridges are left alone; Invincible's own are in §9.

**Enforced:** `bench/vocabulary.ts` fails CI on any word of the old theme outside this section and the importer.
