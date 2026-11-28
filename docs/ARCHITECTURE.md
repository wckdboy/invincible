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
| Node ↔ node: ledger sync, pushes, forwarded work (a sandbox on another node) | Q-AMP, one connection per peer; HTTP with signed requests as the fallback, on the tailnet alone to a peer that speaks Q-AMP | Phase 2 |
| An agent outside the fleet using the primary's tools | Q-AMP grants (carried, §10) | Phase 2 |
| A run on another node calling the primary's tools; one agent handing work to another | Q-AMP, the run's own key and chain | Phase 2 |
| Native clients (iPhone, iPad, Mac, Android) ↔ their node | Q-AMP through Swift and Kotlin bindings, signing with the device's hardware key | Phase 5 |
| The browser ↔ its node | WebTransport (HTTP/3), the same frames; HTTPS with signed requests until then | Phase 5 |
| Devices away from your network (a phone on mobile data) | relays and NAT traversal in Q-AMP; a tailnet until then | Phase 5 |

**How a node uses Q-AMP:** a sidecar, the `qamp` binary, beside the Bun process, spoken to over a local socket. The
daemon holds the vault, so no native QUIC stack is loaded into it (the reasoning is in the carried Q-AMP design, 25
November 2026). The sidecar holds no secret but the node's transport key.

**As built** (26 November 2026, [FABRIC.md](FABRIC.md); pinned to Q-AMP 0.3.0, after 0.2.0, the first release with the sidecar, and
off on each node until its own setting says so):
- **The sidecar.** Each node starts its sidecar on UDP 7410, under a transport key of its own that its signed profile
  names, and watches and restarts it.
- **The link.** Its sync, pushes and forwarded work go over Q-AMP, each call signed by the node's device key; over HTTP
  with signed requests where Q-AMP can't be had (never in clear off the tailnet to a peer that speaks Q-AMP), each
  peer saying which path it is on.
- **A task handed to another node's agents** runs there and streams back over one call. It can be stopped from either
  end. Its run calls the giver's tools under a grant to the run's own key, held to the task and ended with it, and it
  comes back with a proof the runner signs with its device key, which the giver checks before it says Proven.

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
  over: docs/AGENTS.md), connectors you add.
- **Orchestration:** the primary's tools for work are give, check, steer, approve or decline, stop, take up again,
  again-from-a-step, ship and merge (a merge lands only this node's own pushes of proven work, into your default branch,
  once its checks pass: SECURITY.md), each on its own word with a trail and within its money (its steer is
  `team_steer`: its words reach a task that is running, as yours do, §6). It decides who does what:
  - small work it does itself;
  - work in a repository it gives to a coding agent;
  - research to a research agent;
  - a review always to a reviewer on a different model from the one that did the work.

  It follows each task to its proof, and comes back to you with the result, not the play-by-play. What it gives or
  approves on its own word spends at most $3 a task, within what is left of your budget past what approved work holds,
  or, while you set no budget, within $10 a day, which you set; past that the money is yours.
- **Initiative:** it writes first when something happened while you were away, and it proposes the next step when a
  task ends: each task it gives from a chat of yours comes with a look there for when it ends, the node's, a turn of its
  in that chat as the device that gave it, which says what came of it and starts the next step where that is its to do
  (`write-first.ts`). It is told once when the task ends, and again only after an interruption. Work you stopped, paused
  or declined it only says is yours; what the task's run said reaches it fenced as the task's output; a node writes first
  at most 6 times an hour; and it is yours to turn off (`invincible agents first off`). Loops and triggers (a schedule, a
  webhook, a failed CI run) wake it.

## 6. Agents, tasks and runs

The run loop is carried and renamed (§10), the most proven part of it:
- **The loop:** restate the task as acceptance criteria, plan, work, verify, report.
- **Gates:** the gates run before any work, so a gate that already passes proves nothing and is said to. Test files a
  gate names are locked. Yours run exactly as given. The planner may propose up to three of its own, and they are only
  its proposal: work that gives up with them in force has them withdrawn, once, and goes on under yours (26 November
  2026: two it proposed asked for a 10-byte file and an 11-byte one, and the task ended though yours could pass).
- **The reviewer:** independent. It is asked apart from every model that did the work (across a coding agent's
  fallbacks), and for a coding tool on its own sign-in from every model of that vendor's (Claude Code's claude-*,
  Codex's GPT models): a review by one of them after all is marked as by the same model. What the work wrote and
  printed reaches it fenced as data, under a mark that is the digest of those words, and what it is asked comes after:
  the work's own words are evidence, never instructions. It sees the run's evidence as asked (a task's whole diff, its
  cuts said) and its latest forty commands, the rest in the ledger. An audit is asked the same way, its steer telling
  the work it grants nothing; inside a task an audit is asked in the roster's order, as its run asks it.
- **Tripwires, checks and tells:** rules of yours at fixed points of the work.
- **Audited, never capped:** no command count and no time limit. An independent audit steers the run, and only your
  budget stops it.
- **Steered while it runs:** your words to a running task (`POST /api/team/steer`, `fleet:admin`, as giving and stopping
  one are), or your agent's (`team_steer`, through `POST /api/team/primary-steer`, `mind:write`), reach it at its next
  safe point.
  - In the native loop: a command that's running finishes first, and one it asked for but hasn't started isn't run.
  - A coding harness that can be told as it works (Claude Code and Codex: their drivers say `steer: live`) is told at
    once, on its own input (`packages/agents/src/vendor-cli.ts`): one sent during a tool call reaches it once that call
    ends, in the same turn, and one after its turn starts another. Claude Code takes words that come while it answers
    once that answer ends; Codex 0.172.0 takes them at once. Words it never took are said in its next run.
  - Any other harness's run is ended between its tool calls (a call it is in finishes first, for up to 15 minutes; its
    stream says when one begins, but OpenCode's only when one ends) and its own session is told.
  - An audit's steer is a steer as these are: one rule for every steer. It reaches a coding harness's run at the same
    safe points, told on a live one's input or ending another's between its calls, and never cuts a call it is in.
  - The trail says it where it was taken ("You: …", "Your agent: …"), and every audit is told it.
  - The reviewer judges the work against its goal and every steer, in order, and the trail says so before its verdict.
    A steer changes what is wanted; it is never a way around the gates or the review. One that comes while the work is
    judged comes before its end: the work takes it up and is judged again.
  - A task takes 20 at most, of 4,000 characters each, your agent's at most half of them, so yours always reach it.
    One that isn't running is refused in words ("It has ended: give it again from a step instead"); one resting until
    its plan's window resets, or waiting out a planned restart, goes on by itself, and keeps what you say for then. A
    message to a busy agent is queued, as ever: it waits until the agent is free.
  - Each steer's words are its speaker's alone: every line after its first is set in, so none begins as a steer does,
    and the reviewer is told the owner's words stand over the primary's where they differ. A harness that keeps no
    session is told them too: its next run starts again from its briefing with them.
- **The work as commits:** each step a commit, so a task can be given again from a step.
- **Effort per step,** and escalation when stuck: the same gate failing twice in a row, the reviewer sending the work
  back twice, two audits in a row steering it, or the work going round (`REREADS` of its commands showing again files it
  had shown, nothing changed since: seen in its commands, with no model asked) moves the rest of the work from the
  engineer's models to the planner's, once (`packages/agents/src/run.ts`, `escalate`). Work held to models (an agent's
  own, or sensitive mode's) stays on them.
  - The ladder has one rung, and nothing ends work going round on it (the owner's word, 19 November 2026: no limits,
    and no audit ends work). At the climb, the planner's models count their own going round. When they too read the
    same files again `REREADS` times with nothing changed, the run says so (`round`). The node tells you at once with
    a notice of its own ("Ada's task went round on both tiers", source `routing`, told now, one a task: core's
    `routing.ts`, `roundNotice`). It says this once, and again only once the work has changed something and goes
    round anew. The work goes on until you stop it or its budget ends it, and its notice is cleared as it ends.
  - Each task's record keeps whose models did its work (`routing`: where it began and why, why it moved up, and its
    kind), and the agent's next task of the same kind begins by it. That is the memory, by kind of task. A task is a fix
    (of a pull request's checks), desktop work (its VM has a desktop), code (its agent has a repository) or a task, the
    first that fits (`taskKindOf` in `packages/core/src/routing.ts`).
    - The next task of a kind begins on the tier that last verified one of that kind: the planner's where that one began
      on them or moved up to them, else the engineer's. Until one of its kind is verified, it begins on the engineer's,
      and work begun there that goes round moves up again, as any does.
    - After two in a row of its kind begun on the planner's by the memory, the next tries the engineer's again, so work
      the cheaper models can do now goes back to them (`beginFor` and `PROBE_AFTER`, there).
    - Each kind is remembered apart: a code task that needed the planner's never moves the agent's fixes or its desktop
      work there. The cheaper models do Computer Use well (C1, 28 November 2026: Qwen 20 of 20, Kimi 19 of 20, GLM 15 of
      15), so desktop work begins on the engineer's until one of its own needed the planner's.
    - The run says so when its work begins on the planner's or tries the engineer's again ("Routed · …"), and its record
      keeps it. `invincible agents routing <id>` says where its next task of each kind begins, and why, by the same rule.
      In the app it is one quiet line per kind in the agent's details beside its timeline, the why on hover. That panel
      is never on a phone.
  - How a node's routing went, from its own finished tasks' records alone, read-only (core's `routingReport`):
    `invincible agents routing`, with no agent, gives this by kind, then by where each task's work began (the
    engineer's, a try of them, the planner's by the memory or by its plan):
    - how many tasks, and how many were verified;
    - how many moved up, and why;
    - how many went round on both tiers (its record keeps `round`, as its notice goes when it ends);
    - money at your prices (a coding plan's calls are paid for already) and minutes, every task's per verified
      task, never guessed where a call has no price;
    - the north star: each time you stepped in on them (as `northStar` counts it), on how many, and per verified
      task;
    - the tries of the engineer's that held.
    `--json` is the report itself (`v` 1), a contract held by fixtures. Its fields only grow: interventions and `--since`
    were added to v 1, and the first form's fixture is held whole in the new. `--since <day or time>` reads only the
    tasks that finished then or after (a time needs its zone). The agents' page shows a quiet line per kind
    at a desk's width, never on a phone. It reads the latest finished tasks the node lists, up to 512 less those in
    hand.
- **Harnesses:**
  - the native tools loop (the default, measured level with OpenCode);
  - Claude Code, Codex and OpenCode through the key gateway (a run uses your keys without seeing them);
  - any ACP agent.
  - Each driver declares what its tool can do as it runs, and nothing it can't: `steer` (`live`, `restart` or `none`),
    `streams`, `resumes`, `readsWindows` (`packages/agents/src/harnesses.ts`).
  - A coding agent's run is followed as it goes: its events reach the node as they are written, by one long-lived
    command in its VM that runs a fixed script from where the last one stopped (`POST /api/sandboxes/follow`, `sandbox`;
    on the VM's own node, or forwarded there), renewed every ten minutes. Where none can be kept, it is looked at every
    ten seconds, as before.
  - Claude Code runs on its stream-json input and Codex on its app server, each with an input of its own in its VM (a
    FIFO): the node tells it your words and its stop there, and it says back what it took. A stop is the tool's own
    interrupt (SIGINT, `turn/interrupt`), given three seconds, then the end of its process group as before.
  - Measured on 26 November 2026 with the real pinned tools against a loopback model (10 runs each): the first event on
    the node 0.44 s after the start (it was 10.2 s), an event on the node 7 to 20 ms after the tool printed it, and your
    words accepted by the tool in 70 ms (they were taken in 6.5 s, by ending the run).
  - A run cut off before it ended (its process stopped without an exit code: killed, its VM restarted) is taken up again
    once, on the same model, in its own session, told it was cut off. Claude Code is given its own setting for that
    (`CLAUDE_CODE_RESUME_INTERRUPTED_TURN`), so the turn it was in is taken up again with the message in it; Codex resumes
    its thread. Measured with the real tools, each killed mid-command: working again 1.5 to 1.6 s after (3 runs each).
  - A plan's windows as each tool says them as it runs: Claude Code's `rate_limit_event` on a claude.ai sign-in, each
    window it names (five hours, seven days); Codex's `account/rateLimits/updated`, its two windows named by their
    length. Each with its status (allowed, warning, refused), how much of it is used and when it resets.
  - A tool's own sign-in whose window it refused is remembered until its reset, through a restart and apart from the
    providers' windows (an account, not a provider): its agent's next task begins on the roster's models and asks it
    last. It is never moved to another account of the vendor's (D1, D2): there is no switch between them.
  - A task whose every model is spent, its plan saying when it resets, rests until then and is taken up again by itself
    in its own session, its agent's other work going on meanwhile. Spent again after three rests, it waits for you.
    Claude's usage credits and ChatGPT's credit use are never turned on: they are money, and yours to decide.
  - Too many calls at once is no spent window: a 429 that names no allowance, its wait a minute at most or unsaid
    (OpenCode Go's past about 25 calls a minute, 28 November 2026). It is waited out where the call is made, at the
    gateway for a tool's call and a look and in chat for a run's own turn: as long as the provider said, and at least 2,
    4, 8, 16 and 30 s, a minute in all at most. Still refused after that, the caller is told plainly (too many calls at
    once, not its allowance: ask again in a minute), and the turn passes the plan's other models over instead of waiting
    on them again.
  - Measured with the real tools against a loopback model that refused the first model as each vendor does (10 runs
    each): working again on the next model 0.61 s after the refusal (p50; 1.68 s p95) for Claude Code, 1.03 s (1.54 s)
    for Codex. A run on a seat says its windows to the seat (below).
  - A node that stops on purpose (a deploy, an update) stops its tasks' runs by each tool's own interrupt, and takes the
    tasks up again by itself once it is back, each tool in its own session. Following a run that outlived its node, its
    run loop's own state (its plan, its gates' first run, the steers it had taken) kept beside it, is not built yet.
- **Seats:** an account you hold with a vendor, added once, that serves the agents you choose
  (`packages/core/src/seats.ts`):
  - the kinds: a Claude plan, a ChatGPT plan (through Codex, or Sign in with ChatGPT), a Mistral plan, a Gemini plan
    (Google AI Pro or Ultra, through Google's Antigravity CLI, agy), a coding plan's key, an API key;
  - a seat of a kind some node of the fleet can't read yet is never added: that node would refuse its `seat.added`,
    and hold back its sync of everything the adding node writes after it. Each node says in its profile which kinds it
    reads (`caps.seats`, core's `SEATS_READ`, as `caps.requests` says which requests it reads); one that says nothing is
    older and reads the first six alone. The add is refused (409) naming the nodes to update first ("Update mini first:
    it runs a release that doesn't know Gemini plans"), before anything is written (`seatKindBehind`);
  - a seat of a kind a replica doesn't know, a later release's, is kept, never refused: in the log a seat's kind and its
    sign-in's method are words (`SeatKindWord`, `SignInMethodWord`), so no replica holds back what its node writes after
    it. It is shown as "a kind this version doesn't know" (the ledger's `unknownSeats`, the seats listing's `unknown`)
    and used for nothing there: never chosen for work, signed in, set or given agents; a method word it doesn't know is
    read as none. A release that knows the kind replays the seats it kept, so what was refused of it is decided anew;
  - a subscription seat's sign-in lives in its own home on its node, made there by the vendor's own tool in the vendor's
    own flow. The node never reads its files: only the tool's own status command, and five things of what it says;
  - in the ledger (`seat.added`, `seat.policy`, `seat.serves`, `seat.removed` on your word alone; `seat.signin`,
    `seat.window`, `seat.rested`, `seat.back` from the seat's own node alone). None of them carries a sign-in's address,
    its code or a token. A seat's email is sealed in the vault, and the account its first sign-in was to is kept: a
    sign-in to another is refused on every replica;
  - the rule, your word (26 November 2026, "All, never switch"): every account works side by side, and work running on
    one never moves to a second subscription seat of the same vendor. A spent seat's work waits for its reset, goes to
    another vendor's tool, or uses that plan's own sanctioned capacity. No setting switches accounts (`mayCarryOn`);
  - the agents a seat serves, your word (27 November 2026, "One trust domain"): one, the one you choose, and others only
    when you share it. Its home is shared by every run on it, and what one run leaves there (its tool's settings, hooks
    and notes) the next runs with, so the agents sharing a seat are one trust domain. A seat names each agent as itself,
    its handle and when its node's team made it (`seat.serves`), so an agent you remove, or a later one given its
    handle, is never served: which agents it serves now is worked out from its node's roster wherever it is used or
    shown (`servedBy`, `seatServes`), and nothing is written for you when an agent goes. A seat added without one serves
    none, and so does a key's seat, which has no home (a key reaches the agents you grant it);
  - runs at once on one subscription seat: one until shared runs are shown safe, then three, your word given
    (`SHARED_RUNS_PROVEN`); Codex's homes and a Gemini plan's stay one at a time (`ONE_VM_AT_A_TIME`: a Gemini
    seat's runs share agy's profile, which each start empties and gives the sealed sign-in);
  - a seat's home is a volume of its own (`invincible-seat-<id>`), mounted at `/seats/<id>` only in a VM made for that
    seat from the pinned tools' image (`createSeatVm`): for its sign-in, its status, or a run on it, which shares the
    agent's own `/work`. Its tool is told the home by the variable its vendor documents (`seatEnv`). The host refuses a
    VM more than the seat takes at once, counted from its own containers' labels, so a restart forgets nothing. Only the
    node's own team service makes one, never the sandbox route, and only on a Linux host with Docker (a Mac's volumes are
    disk images only one VM may mount). A Gemini seat has a second volume beside it, its sealed sign-in
    (`invincible-seat-<id>.sealed`, at `/seats/<id>.sealed`: `seatSealed`), writable only in the VM made for its sign-in
    and read-only in a status check's and a run's. Removing a seat removes its home, and a Gemini seat's sealed sign-in,
    never while a VM has it;
  - its status is asked of its own tool in such a VM (`askSeat`), with the fleet's salt from the vault; the log is told
    only what changes (`recordSeatStatus`), and a sign-in to another account than the seat's, or to another seat's, is
    refused;
  - signed in on the vendor's own page, by the vendor's own tool in a VM made for the seat (`seat-sign-in.ts`): Codex's
    app server by ChatGPT's device code, Claude Code's `auth login` on a terminal of its own, its page's code relayed
    to it once (D7), and Antigravity's `agy acp --login` in a profile of its own in the VM's memory, the code the page
    after Google's shows relayed to it once, and agy's sign-in sealed for the seat only once it took. The
    card (its page, and Codex's code) is answered to you and kept nowhere; it shows only an address on the vendor's own
    hosts (`signInUrlOk`: Google's accounts page alone for Antigravity, and agy's own sign-in there, `AGY_SIGN_IN`).
    Ten minutes, then it lapses. Then the tool's own status says how it stands; another account than the seat's is
    refused and signed out again by the tool's own command (agy says no account without its token read, so an
    Antigravity seat keeps none to hold a later sign-in to).
    A Mistral plan is a key seat (Vibe's sign-in ends in an API key), and Sign in with ChatGPT is the node's own (to come);
  - Antigravity on a Gemini plan, driven as T3 Code drives agy (the owner's choice, 27 November 2026, accepting that
    Google's Antigravity terms call it a breach that may suspend the account: core's `SEAT_TERMS`): `agy acp` in the
    seat's own profile (`--gemini-dir`), emptied at each start and given the seat's sealed sign-in, whole, never
    read (agy's own in an agent's own VM is kept as the rest goes), its client named truthfully, signed in with it before
    anything else, its updates and telemetry off, and never an agy older than 1.5.1 (`packages/agents/src/antigravity.ts`).
    Each run is a new agy session, so a steer ends a run between its calls, and a new run, told the task's briefing,
    where the work stands and the steer, carries on (`steer: "anew"`). Its command carries its bridge whole (nothing in
    `/work` is run for it), and on a seat each start is in the seat's VM cleared of every process an earlier run of the
    task left there but its init's (`seatVmClearCommand`).
    It speaks Gemini's API, which no provider of the gateway's does: it runs on its Google sign-in alone, never on a
    roster model. Its sign-in is a key to the owner's Google Cloud that any command agy runs can read, so it works only
    on the owner's own repositories (core's `ownWorkRefusal`, as a task starts), as does an ACP agent whose command runs
    agy: the primary directs it as any plan, but a task runs only on its agent's repository, and never another node's;
  - which seat a run takes is Invincible's to choose, and nothing asks you (`chooseSeat`, `seat-runs.ts`): of its node's
    seats that serve its agent, whose plan runs the agent's tool (Claude Code on a Claude plan, Codex on a ChatGPT
    plan, Antigravity on a Gemini plan), signed in, not resting, with a run to spare and some of their plan left, the one with the most headroom (the
    share its most used open window has used), then the soonest reset. A task's first run takes a free seat; with none
    free it runs in its agent's own VM as before seats; with no other way to go on it waits for a busy seat (it has it
    the moment that one is let go) or rests until a spent one opens. Work in sensitive mode never takes one;
  - a run on a seat is in a VM made for it from the pinned tools' image, with the seat's home and the agent's own
    `/work`, as big as the agent's VM. In layout 2 that is the workspace's tree and the notes' tree, with a HOME of its
    own in memory and a lease of its own there, as the agent's VM's is (SECURITY.md). The tool's check, launch, follow and stop are there; the work's gates, its
    evidence and its review stay in the agent's own VM, on the same files. It has no desktop: the agent's stays in its
    own VM, and its tool is told its commands are out of its reach. The seat is let go as the run ends (its VM
    removed); one whose tool says it isn't signed in there is let go, asked again in a VM of its own (no agent's `/work`
    beside it, so nothing of the agent's speaks for it) and marked as that says, and the work goes on without it. A node
    removes every seat's VM an earlier process of it left before its first run takes a seat (one it made itself, a
    sign-in's, it leaves). No route reaches into a seat's VM;
  - the account a task's work began on (its seat, or its own VM's sign-in) is kept with the task: taken up again (a rest,
    a restart, your resume), it goes on on that account alone among its vendor's, and not on its own VM's sign-in of
    that vendor's either. Its tool's session is kept per account (a seat's sessions are in that seat's home);
  - what a run on a seat says of its plan's windows is the seat's (`seat.window`, when its state, its reset or its share
    by five points or more is new); a window used whole rests the seat until it resets (`seat.rested`; with no reset
    said, five hours; never longer than a week and a day), and one said open again before then ends the rest
    (`seat.back`);
  - measured (`bun run bench seats`: a seeded week in virtual time, the real choice, three seats): 13 tasks proven a day
    when the week asks about what the seats hold, 22.6 with a backlog of three times that; each week's window 62.7 %
    and 88.7 % used by its reset; 26 and 61 runs cut off by a spent window; 0.42 and 0 seat-minutes idle while work
    waited (what is left is the controller's 15-second look for resting work). Choosing the seat whose remaining share
    expires soonest instead used 66.7 % of each week's window, with 31 runs cut off rather than 26 and the same tasks
    proven; the first seat free, 58.3 %. A run waiting for a busy seat has it 0.19 ms after it is let go;
  - the meter (I15 step 10): a coding tool on its own sign-in says the model it ran on with what it spent, and Claude
    Code its session's own count of cost (`total_cost_usd`). A task's record counts those calls in `spent` under `own
    sign-in/<model>`, which costs no money (its plan's, `moneyPrices`), and keeps `plan`: the seat (or its VM's own
    sign-in), the share of each window the run took, and what its calls would have cost at API prices (Claude Code's own
    count, from the total its last run on that account ended on; else its tokens at your list price for that model; else
    unknown), said on every surface as "on your Claude plan, 7% of its five hours" and "≈$0.0014 at API prices, covered
    by the plan" (`taskPlanFacts`). `GET /api/seats` says each of the node's seats' use lately (`use`: its tasks and
    their tokens over seven days, and its runs now); the Seats page and `inv seats` show each seat's open windows and
    that use, and a ChatGPT plan's use is read in ChatGPT's own settings, as OpenAI asks (Settings → Usage);
  - seats live on a node: a run takes one of its node's, for an agent whose VM is on that node. A project's pin of a
    seat (`chooseSeat`'s `pinned`) has no setting yet;
  - routes: `GET /api/seats` (`mind:read`); `POST /api/seats`, `/api/seats/remove`, `/api/seats/policy`,
    `/api/seats/serves`, `/api/seats/sign-in`, `/api/seats/sign-in/answer` and `/api/seats/sign-in/cancel`
    (`fleet:admin`, yours alone).
- **Sandboxes:**
  - Kata microVMs on Linux and Apple containers on macOS;
  - a command in one is given nothing to read: no `--interactive`, and its input /dev/null inside the VM (spec.ts's
    `execArgs`). Given `--interactive` with nothing to read, Kata 4.3.1 held each command of a VM until the one before
    it ended: a second command 2 s into a 12 s one took 10,066 ms, and takes 53 ms now (Ultra, 28 November 2026; 51 to
    53 ms in runc either way). One given input as it runs (a pipe's receiving side, a stream held open) keeps
    `--interactive`, and holds nothing while it is fed (55 ms beside it in Kata). Apple's `container` (1.7.1, the Mac
    mini) held nothing either way, and is as it was;
  - **a known limit of Kata's (4.3.1):** what a stream held open (`host.stream`, given input as it runs) prints once its
    input has ended for half a second or more never comes back, though it exits as it should (Ultra, 28 November 2026:
    three runs of three printing 5 s after; one printing at 0.2 to 8 s after, of which 0.2 s came back and 0.5 s on
    didn't; runc gave all of it). None of the node's streams waits for output past its input's end: a seat's sign-in
    is told what it needs and then cancelled or killed, and a run's output followed is killed; a pipe's receiving side
    (`pipeArgs`) is no such stream, and its output 1, 3 and 6 s after its input came back in Kata. A stream that ends
    its input and then waits for an answer must not be written;
  - one per run;
  - a firewall that lets a run reach its node's bridge and nothing it wasn't granted;
  - **their images**, the node's own (the workshop's, the Lab's, the desktop's, the hardware's and the tools': spec.ts's
    `OWN_IMAGES`), built on a node the first time a VM needs one (the first three by the deploy too), each held in use
    against pruning by a keeper container. At the first start of a new release, the node makes again each one it has
    built, from that release's contexts (`SandboxHost.refreshImages`): from cache, so one whose context didn't change
    stays as it was in seconds, and bases first, so a base made anew makes the ones made from it anew too. It is done
    in the background a minute after the start, one image at a time, and none is begun while a VM is being made. A
    rebuild moves its keeper to the new build, and the old one goes once no VM runs on it. One whose build fails keeps
    its last build, and so does each one made from it; the log and `invincible doctor` say which and why, and the next
    start tries again, once. A VM keeps the image it was made from until it is made again: `invincible agents provision
    <id> --remake` makes it again from its image as it is built now, its `/work` kept, with whatever an older image put
    there when that volume was first made;
  - **a desktop in every agent's VM** unless it is made without one (`--no-desktop`, the forms' **No desktop**): a
    display, a browser, a terminal, an editor and the accessibility bus, which the agent operates with its `desktop`
    command and you watch and take over (the owner's standard, 26 November 2026). One process in the VM holds it
    (deskd: input by XTEST, pictures by MIT-SHM, settling by DAMAGE, the browser over its loopback port), its actions
    named as Anthropic's computer toolset names them; the host speaks to it over one held session per VM, and an
    agent's plain `desktop …` goes there too. It keeps the window manager and the browser running, gives a window that
    appears the focus (never the browser's first, from the desktop's own start, over a window the agent opened after
    that start), brings the browser forward with the keyboard in its page for a `desktop open`, says a page's dialog
    as it opens, and closes apps as a person does before it stops them. Light by default (C1 step 10): the desktop
    starts on its first use (a desktop task's as its work begins, beside its first model call, so its cold
    start is behind that call: core's `looksToNeedAScreen`), and stops, as `desktop stop` stops it, after 10 minutes
    with nothing asked of it, no one holding it and no one watching it; the next command starts it again, and the
    agent's next command says why its screen is fresh. The VM is made with 2 GB, desktop or not, and grown, live, to 4
    GB just before its desktop's first use (the sandbox host's desktopRoom), never made again for it: so an agent that
    never looks holds of the ceiling what one without a desktop does ([DESKTOP.md](DESKTOP.md)). Beside the pixels,
    the accessibility tree (AT-SPI): `desktop tree` lists what can be acted on in the window with the focus, and what
    each field holds (an entry's text, a combo box's chosen option; never a password field's), with a last line
    counting what is off the screen, `desktop find` gives
    where one is (one above or below the screen, or across its edge, scrolled into view the page's own way, AT-SPI's
    ScrollTo), and `desktop click ref=N` clicks it where it is at that moment. A node keeps its ref from one tree
    to the next, and a ref whose node is gone fails, so several actions on one tree's refs are safe in one command;
    `desktop fill` fills a form in one, each field read back before the next, and never sends it. An agent is told to
    do several actions in one command where each one's target is known before it starts, and to check a form by the
    tree, not by a look. An agent's model that takes Claude's computer toolset is offered it in the engineer's tool
    loop: each action is one of its commands, the VM's `desktop` verb of the
    same name; the actions after one that fails aren't run; and a turn that acted ends with what can be acted on, as
    text, then a picture of the screen. Any other model works the desktop by the command: `desktop find`, then `desktop
    tree`, then its eyes (`desktop look`). The eyes' check measures the space they answer places in (the picture's
    pixels, their own 0 to 1000, or a frame of their own), and their places come back in the screen's pixels: the space
    goes beside their name to every command (`INVINCIBLE_EYES_SPACE`, or `--space` to the held session). Desktop work
    is proven by a gate that reads what it was for (what a form received, a file's content, a stored setting, an
    export read back): work whose trail acted on the desktop, with no gate, is never verified. Each batch of its
    actions on the desktop is pictured before and after, each picture kept in the VM's `/work/.evidence/desktop` by
    its SHA-256, the hashes in the task's trail, and the latest shown to the reviewer with the criteria: evidence,
    never the proof (a run of yours through a node's chat route sends them as files the node keeps, by the same
    hash). A task whose gate looks
    at the desktop is an eval case as any other is: its eval's sandboxes are made from the desktop image. A Mac makes
    none yet: there an agent's VM is made without one, and the
    ledger says why. The hardware tools (C1 step 11) are a choice per agent as the desktop is (`--hardware`, the forms'
    **KiCad and FreeCAD**): the hardware image, the desktop's with KiCad 9.0.8 (trixie-backports) and FreeCAD 1.0.0 and
    kipy, built on its host the first time an agent needs it, their first run done in the agent's own home as its VM
    starts, and the agent told to script them first (kicad-cli, kipy on the open board editor, freecadcmd) and to use
    their windows only where they have no other way in ([DESKTOP.md](DESKTOP.md)). What it costs and how fast it is: the scorecard's desktop suite ([BENCHMARKS.md](BENCHMARKS.md)).
  - **The stream you watch** ([DESKTOP.md](DESKTOP.md): what runs where, its protocol, how each device watches it, and
    its numbers):
    - `desktop stream` is the screen as H.264 Constrained Baseline, encoded in the VM only while someone watches. The
      node runs it in a held exec of its own, so the encoder lives as long as its reader and nothing listens in the VM.
    - It sends 10 frames a second while the screen changes, and nothing while it is still. A `fast` on its stdin, which
      your input sends, makes it 25 for 2 s. Each frame is the whole screen with the pointer drawn in, its capture time
      beside it (core's `desktop-frames.ts`: the format, and its parser).
    - **One exec a VM, however many of your devices watch** (the sandbox package's `desktop-stream.ts`):
      - each device that joins after the first asks for a keyframe, and is sent from one on;
      - one that falls 1 MB behind is let go, since what it hasn't read is screens gone by, and starts again from a
        keyframe when it comes back;
      - while the screen is still, each device gets a beat every 1.5 s, so whatever carries the stream knows it lives;
      - when the last one goes, the encoder's stdin is closed, which ends it;
      - an encoder that ends before it shows anything is an error that says how, never an empty stream;
      - while it runs, its VM's threads count as work, as a terminal's do.
    - **Its routes, yours alone** (`sandbox`, and never an agent's): `teamDesktopStream` answers with the frames as they
      come; `teamDesktopTake` and `teamDesktopRelease` take the desktop over and give it back; `teamDesktop` with
      `picture: false` does a thing and brings back no picture, for while you watch. Each says whether you have it
      (`held`). Your node asks the node the VM is on, signed as itself (`…On`, which answer only you or a full node), and
      relays the stream as it comes: a signed fetch, as a sandbox's followed lines are relayed.
    - **Take-over:** your looks and your input go to deskd through a held session of the node's own, an exec as a uid
      that is never the agent's, opened beside the agent's session (which starts deskd, as the agent). Your input
      takes the desktop over if no one has it, and is done under your hold. While you hold it, the agent's desktop
      requests wait, and are told. Each answer of yours says whether you have it (SECURITY.md: how it is yours alone,
      and what it can't promise). An image older than take-over is asked the agent's way, as before, and refuses a take.
    - **The codec's licence:** its encoder, `desktop-stream`, is built against OpenH264 (BSD-2-Clause), Debian's
      `libopenh264-8`.
    - **H.264's patents:**
      - H.264 is covered by patents, licensed as a pool by Via LA (MPEG LA's, until it joined Via Licensing in 2023).
      - Cisco pays those royalties only for its own prebuilt OpenH264 binaries, downloaded from Cisco on its
        conditions, and an attribution is one of them.
      - A build from source, as Debian's is, carries no patent licence; nor does x264, which is GPL besides.
      - Which one the images carry is the owner's decision: a build from source, Cisco's binary fetched at install time
        (Debian's `libopenh264-cisco8`, from contrib), or another codec.
- **Shipping:** a run's verified changes become a pull request. Its CI and the review comments come back to the same
  task.
- **Each agent's glass:** its shape and its colour (core's `glass.ts`; the look in DESIGN.md), the node's to give, once,
  as the agent joins (after the agents here before it, by the designer's rule: `assignGlass`), and saved as its avatar,
  `{v: 4, color, shape}`. Agents from before the glass get theirs once, in the order they joined (the team store's
  `glassEveryone`), keeping the colour of their mark (`{v: 3, color, form}`) or the one chosen before the marks
  (`{v: 2, color}`), snapped to the eight, so a team's glass is the same wherever it is read. The node still takes a v 2
  or v 3 avatar, as an app from before the glass sends it: its colour, snapped, with the agent's shape kept. Every app
  draws the glass from core's numbers, held by the vectors' `glass`; an app from before the glass reads a v 4 avatar as
  none and draws the agent from its handle, as it did.

## 7. Models

The models layer, carried (§10):
- providers, with coding plans held to each vendor's terms;
- a roster of models by role, with fallback. The roles are tiers (the owner's word, 28 November 2026: "orchestrator
  (big beefy models), workers/builders/subagents (fast cheaper models)"):
  - the planner and the reviewer default to the strongest models first (`LEAD` in `packages/models/src/roster.ts`);
  - the engineer, and the agents' own roles, to the coding plans and the cheaper open models first;
  - swift's chores to local and fast ones;
  - an audit of an agent's running task, a chore of its own (`audit`): on the reviewer's models until you hire some,
    so the reviewer's strongest answer for the review that decides, and a cheaper one can look in every 20 commands.
  - A roster you set is never reordered. Work stuck on the engineer's models goes up to the planner's (§6, escalation);
- a plan's pace, kept by every caller on a node: a provider whose preset says how many calls a minute it takes before
  it refuses a burst (OpenCode Go: 24) is called within that by the node's one pacer. Its chats, its agents' runs and
  its tools' calls through the gateway each wait their turn rather than meet the plan's 429s (`Pacer` in
  `packages/models/src/bursts.ts`);
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
  - Streams are renewed at least every 255 s by the server's idle limit, and clients resume. Bun closes a request at its
    listener's idleTimeout however many bytes it has streamed (daemon.ts: 255 s; measured on Bun 1.4.4, 27 November
    2026), so the live stream and a turn's stream are cut that often and taken up again from where they left off, by
    the resume and the handover rule. That is by design until a measurement shows a cost. Only answers made long on
    purpose (longRunning: making an agent's computer, a project's first clone) are let run past it (`listening`).
  - The Mac app tells you what the node tells your other devices while it runs, its window or the agents in the menu
    bar: it collects them from the node as the Android app does, when the live stream says `notify` changed, and shows
    them as its own notifications with the iPhone's buttons. Nothing goes through Apple's push service for a Mac.
  - The iPhone shows a task's proof on its Lock Screen and in its Dynamic Island (core's live-activity.ts): one Live
    Activity for the team, for the task it gave or opened in hand last, with how many of the others are at work, kept up
    by the app while it's in front and by the node through Apple's `liveactivity` pushes otherwise (each gate, the
    reviewer, the verdict, the count; fixed words, never a title; one for each device).
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
| `packages/link` | Pairing and sync (the node's side of the Q-AMP sidecar is in `packages/node` for now: its fabric, `src/fabric/`, and its grants, `qamp-grants.ts`) |
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
- ports: 7400 (node), 7401 (behind `tailscale serve`), 7402 (the sandboxes' bridge, `inv0`), 7410–7419/udp (Q-AMP:
  7410 the node's sidecar, 7411–7419 grants' bridges).

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
