# The fabric: nodes and their agents over Q-AMP

Phase 2 of [PLAN.md](PLAN.md), as built (26 November 2026). [ARCHITECTURE](ARCHITECTURE.md) §3 says why;
[SECURITY](SECURITY.md) says what it defends against and how each claim is tested. This page says what runs where, the
protocol for proof across nodes, the numbers, and how to switch it on.

**State:** on main, dormant. It is off on every node until that node's own setting says so (`invincible fabric on`), and
today's pin is Q-AMP 0.1.0, which has no sidecar, so every node stays on HTTP with signed requests and its Doctor says
why. The pin moves to a Q-AMP release with the sidecar only after the independent security review of the fabric is
answered and its fixes reviewed again.

## The sidecar under every node

- **What it is.** Q-AMP's own binary, `qamp sidecar`, beside the daemon. The daemon holds the vault, so no QUIC stack is
  loaded into it; the sidecar holds no secret but the node's **transport key**.
- **The transport key.** Ed25519, never the device key, which signs the ledger and stays in the daemon. It carries
  calls and nothing more: every link call and hand-off is signed by the device key too (below), so the transport key
  alone, read from a backup or a file, carries nothing.
  - **Kept where the device keys are:** the OS keychain (`dev.invincible.node`, `<home>#qamp`), or a 0600
    `<home>/transport-key.json` where there is none. It is made for the node's id, so a home enrolled again as another
    node gets a key of its own.
  - **It reaches the sidecar on its stdin** (`--key /dev/stdin`, read once to its end), never as a file.
  - **`invincible fabric rotate`** (the `rotateTransportKey` route) makes a new one: the profile stops naming the old
    one at once, the sidecar starts again on the new one, and the peers refuse the old one from then on.
- **Where it listens.** UDP 7410 (`INVINCIBLE_QAMP_PORT`) on the node's advertised address alone. An address that is
  every interface's makes it dial out only.
- **Its socket.** `<home>/run/qamp.sock` (`INVINCIBLE_QAMP_SOCKET` when that path is too long, in a directory of its
  own: one the node makes, or this user's already with mode 0700; a shared one such as `/tmp` is refused, never
  changed). It is 0600 in a 0700
  directory, same-user only (Q-AMP's checks), with its state file (grants, revocations) beside it.
- **How it is started.** `qamp sidecar --key /dev/stdin --socket … --name <node> --max-ttl 86400 --allow-cmd /tool/invincible
  --listen <address>:7410`. The binary is `<home>/bin/qamp` (`INVINCIBLE_QAMP_BIN`).
  - It is asked first whether it has a sidecar (0.1.0 has none), and again only when the file changes.
  - The node watches it, and starts it again when it stops: 1 s, then longer each time, to a minute, and at once after
    one that ran a while. It stops a sidecar a dead node left running, by its pid.
  - **Only when the node's own setting says so:** `invincible fabric on|off|status` (the `fabricSetting` route; `fabric`
    in its `config.json`), off by default. A binary with a sidecar switches nothing on by being there: no sidecar is
    started and no transport key made. A running node applies the setting at once: on starts its sidecar; off stops it,
    and its profile names no endpoint from then on. The grants' bridges run the same binary either way.
  - `INVINCIBLE_QAMP=off`: no sidecar at all, whatever the setting says.
- **Its endpoint in the node's profile.** Once the sidecar has said where it listens, the node's signed profile
  (`node.profile`, `caps.qamp`) names its transport key, its address, and the key's own signature over the node's id
  (`pop`: Ed25519 over `invincible-qamp-key/v1\n<node id>`). A claim without that signature is no endpoint, so no node
  can claim another's key. It is kept while the sidecar is down, so the profile doesn't flap.
- **The Doctor** says it in one line (`node.qamp`):
  - up, with its key, address and version;
  - off (switched off, not installed, or told so), which is no fault;
  - a 0.1.0 binary, which needs you;
  - down, and why.

## The links, and what falls back

| Link | Over Q-AMP | Falls back to | Says its path |
|---|---|---|---|
| The ledger's sync (a pull, every 5 s) | `invincible/link/sync` | `POST /link/sync`, signed | `peers` (PeerStatus `path`, `fallback`), `invincible status`, the Doctor's `mind.sync.<peer>`, the fleet's status line in the web app |
| Pushes (each event as it is written) | `invincible/link/push` | `POST /link/push`, signed | as above |
| Forwarded work (every route `forward` sends: a sandbox on another node, its commands, its files' listing, its spend) | `invincible/link/forward`, the route and its body | the same route, signed, only when the call never reached the peer | as above |
| A task handed to another node's agents | `invincible/task/hand` | none: refused, with why | the hand-off (`path`) |
| A run's calls back to the tools its task was given | `invincible/agent/<tool>`, under the run's own chain | none | the run's answer |

- **Still over HTTP, not moved yet:** a kept file's bytes (`fileFrom`, streamed), local model calls between nodes
  (`localModelCall`, streamed tokens), pairing, and every client's API.
- **The door.** The sidecar proves the caller's transport key in the handshake. The node takes it for the active node
  whose signed profile names it with that key's proof, read afresh on every call. A key nobody names, a key two
  profiles name, or a key a revoked node ever held is refused, whoever names it after.
- **Each call is its node's own word.** Every sync, push, forwarded route and hand-off is a `LinkCall`: its path, its
  body as the JSON text that was signed, and the sending node's device signature over them, made and checked as its
  HTTPS request's (the same time window and body digest, and a nonce cache of the fabric's own, so a call sent twice is
  refused the second time), with the method `QAMP`, so a signature made for either path never passes on the other. It
  must be the transport key's own node's, active, fresh and for the tool's path. A forwarded route then runs through
  the same door as over HTTP (the `fabric` listener), for that node's principal.
- **When Q-AMP is tried again after it wasn't had.** It waits by why:
  - refused (`UNAUTHORIZED`: the peer doesn't know this node's key yet; its next pull of this node's profile cures it), 2 s;
  - busy or draining, 5 s;
  - a node from before the fabric (`UNKNOWN_TOOL`), a minute;
  - unreachable, 5 s, longer each time, to a minute.

  An error the peer answered with over Q-AMP is its answer, not a reason to leave Q-AMP.
- **Never in clear.** The fallback is plain HTTP with signed requests, said as HTTP everywhere (the API's `path` keeps
  its value `https`). To a peer that speaks Q-AMP, while this node's fabric is on, it is refused off the tailnet and
  this machine: the link waits for Q-AMP and says why. "On" is the node's setting, whatever its sidecar's state: one
  that can't start for a fault here (no binary, a key it can't read, a socket directory that isn't private) is
  refused too, and its Doctor says so as a line that needs you. "The tailnet" is an address in RFC 6598's shared
  range (all of it: carriers use the same range for their NAT), Tailscale's IPv6 range, or a MagicDNS name; "this
  machine" is loopback. On the tailnet, a peer that speaks Q-AMP and drops to HTTP raises a notice (the Doctor's
  `mind.sync.<peer>`).
- **Never twice.** A forward goes over HTTP only when its Q-AMP call never reached the peer: this node's sidecar
  couldn't take it or refused it, it couldn't connect, the peer was going away, or the peer's door refused it before
  running anything. Any other failure (a connection lost mid-call, the peer gone silent, its deadline passed) fails
  the forward, saying it may have run there: a route may not be safe to run twice (`execSandbox`, `destroySandbox`,
  a write). The sidecar says `unavailable` both for a peer it couldn't reach and for a connection lost mid-call, and
  only its words tell them apart, so what it doesn't say plainly counts as reached. The link's sync and push are safe
  to send again, and fall back after any failure.
- **The same scopes either way.** A pull needs `mind:read` of its node and a push `mind:write`, over Q-AMP and over
  HTTP alike (a full node holds every scope; a limited node, what it was given).

## Agents across nodes: the hand-off

`invincible hand <node> "<goal>" [--gate "<command>"]… [--agent <id>] [--tools fleet,compute,place,ledger] [--budget 2]
[--follow]`, and `invincible handed [<id> [--follow] | stop <id> | revoke <id>]` (its exit code is the verdict: 0
means proven; `revoke` cuts its run off from this node's tools, the task going on there without them).
The routes are `handTask`, `handedTasks`, `handedTask`, `stopHanded` and `revokeHandedRun`, with `handoffGrants`, `grantHandoffs` and
`revokeHandoffs` for your grants (and `fabricSetting`, the switch). One Q-AMP call between the two nodes'
transport keys carries all of it:

1. **The giver opens the call** with the task: `{handoff, nonce, goal, title, gates, budgetUsd?, agent?, tools}`. The
   hand-off's id and a fresh nonce are the giver's own.
2. **The runner takes it** only from an active full node, and at once only within your grant for that pair of nodes:
   - **Your grant**, given once for the pair: `invincible fabric grant <from> <to> --budget <usd a day> [--agents <id>,…]
     [--tools fleet,…]` (the `grantHandoffs` route; `fabric grants`, `fabric revoke <from> <to>`). It is a
     `handoff.granted` event in the ledger, your word alone, recorded as rules and standing orders are: every replica
     refuses one that isn't your word or wasn't written by a full node, on replay too. Each names the full node that
     recorded it (`invincible fabric grants` says which, and the device of yours it came from, which is that node's
     own word, its `via`), and every grant a node since revoked recorded ends with that node. So does a grant of yours
     for the same pair that it overwrote: the last writer wins, so yours isn't restored, and you grant it again.
   - **Within it** (an agent it names, or any when it names none; tools it names; a budget that fits what is left of its
     day, $3 when the hand-off names none) the runner gives it to that agent at once, as the best suited among those it
     names when the hand-off names none. Each hand-off counts at least $0.10 against the day, whatever smaller budget
     it asks for (and keeps), so the day bounds how many there are as well as what they spend. Its work runs only on
     models its budget counts at more than $0 (one you've priced above nothing, on no coding plan): its agent's own
     loop, its coding tool, and its commands, whose VM's lease is good for those models' calls alone. The gateway
     refuses any other model (the third re-review's R3-4), and on that lease any route but its protocol's model calls
     (a POST) and their listing (a GET), so nothing else of yours with that provider (its files, stored responses,
     batches, vector stores) is read with your key, nor a batch made (the fourth re-review's R4-3). That lease carries
     nothing else: not the keys of yours its agent may use, nor its agent's repository, which are its agent's own
     work's. Never on one it counts as nothing, nor on a coding
     tool's own sign-in in the VM (a seat), nor in an ACP agent of yours. Two things it doesn't bound (I-l): a paid
     model's call that reports no usage counts nothing, whatever the budget, and a command can start a coding tool
     itself on that tool's own sign-in in the VM, if it has one, which no lease reaches.
   - **Beyond it, or with no grant,** the task waits on the runner as a proposal, for your approval there: it says
     `{kind: "proposed", task, agent, why}`, and is taken once you approve it. Its own agent never approves it.
   - **Either way** the task is the giving node's (`givenBy: node:<id>`), never yours, and at most 8 tasks from one node
     are open there at once (waiting for you, queued or running, those still waiting their turn to be given, and
     those you take up again by their id). One node's hand-offs are looked at one at a time: each is counted, given and
     written before the next, so a burst keeps the day's budget and the 8 at once.
   - **It ends with what it was taken under, and with its call.** Your grant revoked stops what was handed under it,
     and so does a grant whose recorder is revoked (below), whether a call still follows the task or not. A pause ends
     it too (its agent, its room or the task paused, or the agent turned off): its call ends then, and nobody follows
     it after, so it stops rather than wait for a resume, and its proof says so. A resume of an agent or a room passes
     over another node's task. Named by its id (the web offers it in one tap) you can still take one up again, while
     its node is an active full node, the grant it was taken under holds (one you approved beyond it needs none), and
     its node has fewer than the 8 open here. This node follows it again then: no call can stream it back, but it is
     held to the longest a hand-off may last from when you took it up, and a revocation ends it as any (the third
     re-review's R3-6). A node that restarts ends what was handed to it before, as nobody follows it any more: a planned
     restart (a deploy, an update) ends it as stopped and never takes it up again, and one a crash cut off ends as the
     node comes back.
   - **Its work is bounded, in a VM of its own.**
     - Every command of it, its agent's, its coding tool's and its gates, runs in a VM made for it beside its agent's
       (`packages/node/src/task-vms.ts`, `createTaskVm`; the owner's decision of 27 November 2026, the third
       re-review's R3-1). That VM is made from the agent's VM's image, as big as it and on its network. It shares the
       agent's workspace alone (its `work/` tree: never its HOME, nor its notes) and has a HOME of its own in memory.
       Its lease is the task's paid models alone (never your keys, nor its repository), counted under its agent's
       label, so its budget counts what it spends. None of its commands runs in the agent's own VM.
     - The VM goes as the task ends, however it ends (done, failed, stopped, its agent paused), and with it everything
       the task started there: nothing it starts outlives the task, your grant or its node's revocation. One an earlier
       process of the node left is removed as the node starts. No route reaches into it, yours included.
     - It is made on a Linux host with Docker, beside an agent's VM whose HOME is apart from its workspace (layout 2,
       SECURITY.md); beside one still in layout 1 it is refused, since that VM's HOME is its workspace. Layout 2 is each
       node's own setting, off by default (`invincible sandbox layout on`): until it is on, every task handed to that
       node is refused so. On a node with
       no room beside its agent's VM for one as big, the task waits for room as any sandbox does, within its life.
     - **A Mac takes no other node's task.** No VM on a Mac shares an agent's workspace: a Mac's workspace is a disk
       image only one VM may mount, and its VMs' HOME is their `/work` (layout 1). A task handed to a Mac would run in
       its agent's own VM, beside what that agent's tools keep for themselves, its sign-ins among them. So a Mac refuses
       it at once, before it reads anything of it (`MAC_TAKES_NO_TASK`, `handoff.ts`). You see its words on the
       hand-off, as that node's: "This node is a Mac, and a Mac takes no other node's task: no VM on a Mac shares an
       agent's workspace, so the task would run in that agent's own VM, beside what its tools keep there, its sign-ins
       among them. Hand it to one of your Linux nodes with Docker." A grant to a Mac gives nothing, since every task
       handed to it is refused so.
     - Its gates are its giver's commands, run in its VM: all of them together get as long as one command may (15
       minutes), every round counted, and once that is spent they aren't run and the work isn't done.
     - Each shell command of its agent, its coding tool and its gates runs under a fixed helper (`handed-process.ts`),
       in a process group of its own under its own deadline, its `desktop` verbs too (the third re-review's R3-3). What
       a gate starts ends with the gate, and what its other commands leave running is listed and ended with the task
       (R3-5). A command that ends or stops its own helper, or a process that double-forks out of it, escapes that
       bound, but not the task's VM, which goes as the task ends.
     - The runner stops it at its call's deadline or after 24 hours, whichever comes first, waiting for your approval
       included. A stop that can't be written (the node stopping, or a write that fails) ends its call all the same,
       answered as failed (the third re-review's R3-2). A task you take up again by its id lives no longer than the
       longest a hand-off may last, from then (R3-6).
     - Not bounded: the VM time its work takes isn't counted itself (its budget's dollars and its life bound it), and
       what it leaves in the workspace it shares (the repository's scripts and hooks among them) is there for the
       agent's later work, as SECURITY.md's layout 2 section says.

   It makes the run a key of its own: Ed25519, in memory alone, destroyed when the run ends.
3. **It streams back** structured chunks:
   - `{kind: "proposed", task, agent, why}`, when it waits for your approval there;
   - `{kind: "accepted", task, agent, run}`, its task there and the run's key, once it is taken;
   - `{kind: "trail", at, text}`, each line of the run's trail the moment its agent writes it;
   - `{kind: "state", status}`.

   The giver keeps the trail: 2,000 lines, each 4,000 characters at most.
4. **The run's grant.** Where the task was given some of the giver's tools, the giver mints a grant from its transport
   key once the task is taken (its first `accepted`; any after it are ignored), renews it at half its life while the
   run lives there, and sends it and each renewal in on the call (`{kind: "chain", chain}`). It follows the task, not
   the call:
   - revoked the moment the runner says the task ended (`state` done, failed, stopped or interrupted), even if the call
     stays open for its proof;
   - renewed no longer than the call's deadline (24 h, waiting for your approval included);
   - and any end its result didn't bring (a failure here, a revoked node, a lost link) cancels the call, so the work
     there stops too.

   The grant:
   - is for the run's key (`aud`), for `/tool/invincible/agent`;
   - has the giver as its subject;
   - is held to the hand-off by its policy, `[["==", ".task", "<handoff>"]]`;
   - lasts 300 s at a time, and is renewable.

   The tools are the read-only ones, `fleet`, `compute`, `place` and `ledger`: your word for agents outside the fleet.
5. **The run calls them** from its VM: `POST ${INVINCIBLE_GATEWAY%/gw}/fabric/tool/<tool>` with
   `Authorization: Bearer $INVINCIBLE_TOKEN` and the tool's input as JSON (1 MiB at most, read as it comes; 60 calls
   a minute at most from one VM). It is told how through its
   task's skills.
   - **The runner's node carries the call.** It signs a link from the run's key to its own transport key (a QDT token:
     the command for that tool, the same policy, never past the grant's end). It then calls the giver with the chain
     `[giver → run, run → runner]`.
   - **The giver's sidecar checks the chain in full:** signatures, revocation, expiry, linkage, binding to the caller's
     key, and policy.
   - **The giver's door checks what only it knows:** this hand-off's current tokens, its run's key, the node it was
     handed to, and the tools it was given.
   - **The tool then runs on the giver** as that run alone, with the scopes its tools' routes need.

   The VM never sees the key or the chain.
6. **Stopping is end to end.** The giver's stop goes in on the call (`{kind: "stop"}`); the runner stops the work and
   answers how it ended. Past 15 s without an answer the giver cancels the call. A call that ends (the giver gone, its
   link lost) stops the work on the runner too.
7. **It ends with the runner's answer:** `{task: {id, status, verified, output, error}, proof}`, the proof described
   next. The grant is revoked, and the run's key is destroyed.

## The protocol for proof across nodes

- **What the runner signs.** When the work ends, the node that ran it signs a statement with its **device key**: its
  fleet identity, never its transport key. The proof is checked by whoever holds it, long after the connection it came
  on.

  ```
  ProofStatement = { v: 1,
    by: <the runner's device id>, for: <the giver's>, handoff, nonce,       ; the giver's, echoed
    task: <its task there>, run: <the run's did:key>,
    goal: base64url(SHA-256(goal as handed)), gates: [<the gates asked for, in order>],
    status: done | failed | stopped | interrupted, verified: bool,
    ended: done | unverified | gave-up | stopped | null,
    proof: { before: [exit…], after: [exit…], review: pass | revise | null, sameModel: bool } | null,
    startedAt, endedAt,
    said: base64url(SHA-256(canonical JSON of {output, error} as sent)) }   ; what it says beside the proof
  signature = Ed25519(runner's device key, "invincible-proof/v1\n" + canonical JSON of the statement)
  attestation = { statement, sig: base64url(signature) }
  ```

- **What the giver checks, before it says anything is proven** (`proofRefusal`):
  - it parses as one;
  - it is signed as the node the task was handed to, and that node is active in the fleet;
  - the signature verifies under that node's device key;
  - it is for this node, this hand-off and its nonce, over this goal;
  - its gates begin with the ones asked for (the planner's own, run after them, follow in `proof` unnamed);
  - it names the task and the run's key it was taken as there (its `accepted`), and one that says verified is refused
    if this node was never told them;
  - it says verified only as its own facts do: done, its end done, an exit of 0 after for every gate it names, no review
    asking for more;
  - its output and error, shown beside the verdict, are the ones it signed (`said`).

  A proof that fails any of these is kept as refused, with why, and the hand-off reads "Not proven: its proof didn't
  check (…)".
- **"Proven"** is then the apps' own verdict, read from the signed facts:
  - verified;
  - a gate that failed before the work passes after it;
  - a reviewer that wasn't the model that did the work passed it.
- **What it proves, and what it doesn't.** It proves which node vouches for the work, and that nobody changed what it
  said. A node that didn't run the work can't make it look proven:
  - another key's signature;
  - the runner's proof of another hand-off, goal or gates;
  - a changed exit;
  - a revoked node's proof.

  It can't prove the runner ran its gates truthfully: a false proof is that node's signed word, and kept.

## The numbers

Measured with `bun bench/fabric/measure.ts --qamp <binary> --samples 30`: three nodes in temporary homes, each with
Q-AMP main's sidecar (`831b845`), on loopback, on an Apple M3 Pro, 26 November 2026. The two Q-AMP columns ran back to
back on the same binary, the code before the security review's fixes (`418b924`) and after them (`f3f46ad`), the
machine's load average 8.4 over one minute and 23 over five through both. HTTP with signed requests is all there was
before the fabric. p50s, in ms (10 samples for the hand-offs, 20 for the revocations). They predate the re-reviews'
fixes, which weren't measured again. Of those, N1's turn (one node's hand-offs looked at one at a time, which a single
hand-off doesn't wait on) and the door's map of keys (N4, cheaper) are on a path measured here, and so is a revocation,
which now also looks through the team's tasks for those it ends. The helper adds a `python3` process to each command of
a handed task, which no row here times.

| | HTTP, signed | Q-AMP, before the review's fixes | Q-AMP, after them |
|---|---|---|---|
| First answer on a fresh connection (beta asks alpha for what follows its frontier) | 0.56 | 1.30 | 1.65 |
| The same, a sidecar process's very first call | — | 24.3 | 24.5 |
| An answer on a warm connection | 0.62 (signed, inside its clock) | 0.29 (unsigned) | 0.75 (signed, inside its clock) |
| Sync's lag (an event written on alpha, until it is in beta's ledger: a push) | 2.57 | 2.31 | 2.84 |
| A forwarded command's answer (a sandbox on beta) | 3.22 | 2.35 | 4.20 |
| A handed task's first output back on the giver | none: no such link | 17 | 20 |
| A handed task, given to Proven (stand-in models) | none | 44.8 | 51.0 |
| A stop's round trip (the giver's stop, the work stopped and said) | none: forwarded work couldn't be stopped from its sender | 2.90 | 3.46 |
| A run's key revoked, until its next call is refused | none | 10.9 | 10.2 |
| A device revoked on alpha, until beta refuses it | 31.6 | 22.8 | 21.0 |

- **What the fixes cost:** each link call now carries its node's device signature (the review's M1), 0.41 ms on this
  machine (Ed25519 in the daemon: 0.16 ms to sign, 0.25 ms to check, timed alone; the door's own cost for a forward,
  timed alone, is the same 0.41 ms). Three more alternating runs of the link's sections put the fresh answer at
  1.23–1.25 ms before and 1.69–1.84 after, the warm one at 0.29–0.64 and 0.74–0.85 (HTTP's, which always signed,
  0.62–1.06), and sync's lag at 2.27–2.70 and 3.08–3.63.
- **The forwarded command** rose more than the signature in those runs (2.18–2.27 ms before, 3.47–4.67 after), while
  HTTP's rose 0.4 to 0.6 ms in the same runs. The signature is 0.41 ms of it; the rest isn't traced yet.
- **On loopback the paths cost about the same, and loopback hides what matters.** On a real network every round trip
  adds the path's latency (about 17 ms between the owner's two machines, below):
  - plain HTTP's first answer is two round trips (TCP, then the request);
  - Q-AMP's is three on a first meeting (a Retry, the handshake, the call), and two once the peer's NEW_TOKEN spares the
    Retry.

  What Q-AMP brings is streams instead of polling, a stop that reaches the work, grants held to a task and checked per
  call, revocation without caching, and a post-quantum key exchange inside the tunnel (WireGuard's own is classical).
- **The hand-off's first output and its stop** were 104 ms and 58 ms before the runner followed its agents' own changes
  (each trail line wakes it), and 12 ms and 2.4 ms after (three runs each; the commit says the medians).

## Across a real network

`bench/fabric/remote.ts` measures between two throwaway test nodes of a fleet of their own, one on each machine, each
with its own sidecar on its tailnet address. It never touches the owner's nodes, homes or ports. The measuring node
times every round trip on its own clock: an event comes back as the other's echo (two pushes, halved), and a device it
revokes comes back as the other's word that it refuses it.

Each takes a directory of its own as `--root`, empty or not there yet, of any mode, and removes it when it ends. It keeps
its node's home there, and its sidecars' sockets in a folder it makes inside with mode 0700, as a sidecar's socket needs.

```sh
# on the serving machine (its tailnet address, a directory of its own, two ports open to the tailnet: 7470/tcp, 7471/udp)
bun bench/fabric/remote.ts serve --qamp <qamp for this machine> --advertise 192.0.2.10 --root /tmp/q5 --port 7470 --qamp-port 7471
# on the measuring machine, with the invite the first one printed
bun bench/fabric/remote.ts measure --qamp <qamp for this machine> --advertise 192.0.2.20 --root /tmp/q5 --invite <invite> --samples 30 --out results.json
```

Measured on 26 November 2026, before the security review's fixes (the code of `04e7c6a`): the measuring node on a Mac
mini (darwin/arm64), the serving node on a Linux server (linux/x64, in a container on the host's network), each with
Q-AMP main's sidecar, over the tailnet, whose round trip between them was about 17 ms. 30 samples each (10 for the
hand-offs); p50 and p90, in ms. The mini's own load was heavy and rising through the run (its 1-minute load average 17.6
before, 187.8 after), so the p90s are noisy; a first run an hour earlier, without the stop and revocation parts, gave the
same p50s within 2 ms.

| | HTTP, signed | Q-AMP |
|---|---|---|
| First answer on a fresh connection | 34.6 (36.5) | 49.9 (52.5): a Retry, the 1-RTT handshake, the call |
| An answer on a warm connection | 16.7 (19.1) | 16.7 (18.6) |
| Sync's lag (a push, half an echo's round trip) | 11.6 (13.0) | 11.3 (13.9) |
| A device revoked here, until the server refuses it (half a round trip) | 31.8 (35.8) | 20.0 (22.6) |
| A forwarded command's answer (a sandbox on the server) | 20.9 (30.4) | 18.5 (20.4) |
| A handed task's first output back here | none: no such link | 24 (38) |
| A handed task, given to its end (stand-in models) | none | 45.5 (76.1) |
| A stop's round trip (this node's stop, the work stopped there and said) | none | 18.8 (24.2) |
| A run's key revoked here, until the server says its next call was refused | none | 53.6 (95.3) |

- **The fresh connection** costs Q-AMP a round trip more than plain HTTP on a first meeting (three against two); every
  answer after it costs the same one.
- **A revocation** reaches the other node sooner over Q-AMP (a push on a connection already open).
- **A run's key revoked** is three crossings: the revocation here, the run's next call there, its refusal said back.

## The runbook: switching it on for a real pair

For two nodes of the owner's fleet. A Linux server stands in for the first (192.0.2.10 below) and the Mac mini for the
second (192.0.2.20); every address here is a documentation address. Do it only once the fabric's security review is
answered and a Q-AMP release with the sidecar is pinned.

1. **The pin.** `scripts/qamp-pin.sh` names the release and the SHA-256 of its binary for each platform a node runs on
   (linux-x64, darwin-arm64), from the release's SHA256SUMS.
2. **The binary, on each node.** Either way the binary is checked against the pin and put at `<home>/bin/qamp` by a
   rename, so a sidecar running the old one keeps running.
   - **With a deploy:** `scripts/deploy.sh <host> --qamp <the release's binary for that machine>`. The node is restarted
     as every deploy restarts it.
   - **Without one:** on the host, as the node's user, `source scripts/qamp-pin.sh && install_qamp <the binary>
     ~/.invincible/bin`. The node needs no restart.

   The binary alone switches nothing on.
3. **Switch it on, on each node:** `invincible fabric on`. A running node starts its sidecar at once (and asks the binary
   whether it has one); a stopped one does when it starts. A Linux node that is to take other nodes' tasks needs layout
   2 too, its own setting (`invincible sandbox layout on`, SECURITY.md): each of its agents' VMs is moved at its next
   prepare while nothing runs in it, and you're told once for each. Until then a task handed to it is refused.
4. **The port.** On a Linux node with UFW, `deploy.sh --open-qamp` (UDP 7410–7419, `tailscale0` alone), or the one rule
   `ufw allow in on tailscale0 to any port 7410 proto udp`. A Mac with its application firewall off needs nothing; with
   it on, allow the qamp binary.
5. **Check, on each node:**
   - `invincible doctor`: `node.qamp` says its sidecar is up on `192.0.2.10:7410` with its version, and
     `mind.sync.<peer>` says "over Q-AMP";
   - `invincible status`: the peer reads `online <n>ms q-amp`;
   - the fleet's page in the app says "· Q-AMP".
6. **Measure the pair** (read-only, or with a test agent and task of your own):
   - `invincible status` on each, for the link's round trip;
   - `invincible hand <the other node> "Write hello.txt" --gate "test -f hello.txt" --agent <a test agent there>
     --follow`, then `invincible handed <id>`: its first output and end are `firstOutputAt` and `endedAt` against
     `createdAt` in `handedTask`.
7. **Back to HTTP alone**, if Q-AMP misbehaves: `invincible fabric off` (at once, no restart), `INVINCIBLE_QAMP=off` in
   the node's service environment and a restart, or close UDP 7410. Each peer falls back within one failed call and
   tries Q-AMP again later, so nothing waits on it.

## What isn't verified yet

- **The owner's real pair has never run it:** those nodes run main, where the fabric is dormant. Across a real network
  only two throwaway test nodes have, on the same two machines, and only with the code from before the review's fixes
  (above).
- **The re-review's findings are fixed, each with a failing test first, and not yet reviewed again.** The independent
  re-review of the first fixes (`8da3916`) found them holding, H1 and L5 in part, and found five more (N1 to N5) and six
  edges (I-a to I-f). Each is fixed on `fabric-2` after `8da3916`; a fresh re-review of those diffs comes before the pin
  moves.
- **A full node is owner-equivalent across the fleet, and nothing in the fabric changes that.** One that turned on you
  can enroll a client of its own, which is you over HTTPS on every node (it can give your agents work there), and it
  can write itself any grant for hand-offs as your word, as it can a rule. What the fabric adds is a record: each
  grant names the node that recorded it, and every grant a revoked node recorded ends with it (and with it any grant of
  yours for a pair it overwrote, which you grant again). The device of yours a grant came from (`via`) is the
  recorder's own word.
- **The native apps** say nothing yet of hand-offs, their grants, or a task a node handed over (the web app and the CLI
  do); their parity vectors are unchanged.
- **Q-AMP's side for grants that renew themselves** (holder-driven, in its spec first) isn't built. The giver renews
  here, and sends each renewal in on the hand-off's call.
- **One connect timeout** in 391 fresh-connection samples on loopback: the first sample of one run, not reproduced in
  the 390 that followed, cause not established.
- **A handed run reaches its giver's tools only when its agent's VM is on the node that runs it.** A VM that placement
  put on another node (the giver itself, say) calls that node's gateway, which holds no run of this one: it answers 404.
  Found by `bench/fabric/remote.ts`, where both test nodes hosted VMs.
- **Not moved to Q-AMP:** kept files' bytes and local model calls between nodes.
- **Not driven:** the hand-off from the web app or the native apps (the CLI and the API only); a VM's real harness
  calling its giver's tools (the gateway path is tested with a stand-in, `callGiver` end to end); Linux with real
  Docker, KVM or the workspace helper beside a sidecar.
- **Relays and NAT traversal** (Q-AMP's `feat/relays`) aren't used: nodes reach each other on the tailnet, directly.
