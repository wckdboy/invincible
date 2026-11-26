# The fabric: nodes and their agents over Q-AMP

Phase 2 of [PLAN.md](PLAN.md), as built (26 November 2026). [ARCHITECTURE](ARCHITECTURE.md) §3 says why;
[SECURITY](SECURITY.md) says what it defends against and how each claim is tested. This page says what runs where, the
protocol for proof across nodes, the numbers, and how to switch it on.

**State:** on main, dormant. It is off on every node until that node's own setting says so (`invincible fabric on`), and
today's pin is Q-AMP 0.1.0, which has no sidecar, so every node stays on HTTPS with signed requests and its Doctor says
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
- **Its socket.** `<home>/run/qamp.sock` (`INVINCIBLE_QAMP_SOCKET` when that path is too long). It is 0600 in a 0700
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
| Forwarded work (every route `forward` sends: a sandbox on another node, its commands, its files' listing, its spend) | `invincible/link/forward`, the route and its body | the same route, signed | as above |
| A task handed to another node's agents | `invincible/task/hand` | none: refused, with why | the hand-off (`path`) |
| A run's calls back to the tools its task was given | `invincible/agent/<tool>`, under the run's own chain | none | the run's answer |

- **Still over HTTP, not moved yet:** a kept file's bytes (`fileFrom`, streamed), local model calls between nodes
  (`localModelCall`, streamed tokens), pairing, and every client's API.
- **The door.** The sidecar proves the caller's transport key in the handshake. The node takes it for the active node
  whose signed profile names it with that key's proof, read afresh on every call. A key nobody names, a key two
  profiles name, or a key a revoked node ever held is refused, whoever names it after.
- **Each call is its node's own word.** Every sync, push, forwarded route and hand-off is a `LinkCall`: its path, its
  body as the JSON text that was signed, and the sending node's device signature over them, made and checked exactly as
  its HTTPS request's (the same time window, nonce cache and body digest), with the method `QAMP`, so a signature made
  for either path never passes on the other. It must be the transport key's own node's, active, fresh and for the
  tool's path. A forwarded route then runs through the same door as over HTTPS (the `fabric` listener), for that
  node's principal.
- **When Q-AMP is tried again after it wasn't had.** It waits by why:
  - refused (`UNAUTHORIZED`: the peer doesn't know this node's key yet; its next pull of this node's profile cures it), 2 s;
  - busy or draining, 5 s;
  - a node from before the fabric (`UNKNOWN_TOOL`), a minute;
  - unreachable, 5 s, longer each time, to a minute.

  An error the peer answered with over Q-AMP is its answer, not a reason to leave Q-AMP.

## Agents across nodes: the hand-off

`invincible hand <node> "<goal>" [--gate "<command>"]… [--agent <id>] [--tools fleet,compute,place,ledger] [--budget 2]
[--follow]`, and `invincible handed [<id> [--follow] | stop <id>]` (its exit code is the verdict: 0 means proven).
The routes are `handTask`, `handedTasks`, `handedTask` and `stopHanded`, with `handoffGrants`, `grantHandoffs` and
`revokeHandoffs` for your grants (and `fabricSetting`, the switch). One Q-AMP call between the two nodes'
transport keys carries all of it:

1. **The giver opens the call** with the task: `{handoff, nonce, goal, title, gates, budgetUsd?, agent?, tools}`. The
   hand-off's id and a fresh nonce are the giver's own.
2. **The runner takes it** only from an active full node, and at once only within your grant for that pair of nodes:
   - **Your grant**, given once for the pair: `invincible fabric grant <from> <to> --budget <usd a day> [--agents <id>,…]
     [--tools fleet,…]` (the `grantHandoffs` route; `fabric grants`, `fabric revoke <from> <to>`). It is a
     `handoff.granted` event in the ledger, your word alone, recorded as rules and standing orders are: every replica
     refuses one that isn't your word or wasn't written by a full node, on replay too.
   - **Within it** (an agent it names, or any when it names none; tools it names; a budget that fits what is left of its
     day, $3 when the hand-off names none) the runner gives it to that agent at once, as the best suited among those it
     names when the hand-off names none.
   - **Beyond it, or with no grant,** the task waits on the runner as a proposal, for your approval there: it says
     `{kind: "proposed", task, agent, why}`, and is taken once you approve it. Its own agent never approves it.
   - **Either way** the task is the giving node's (`givenBy: node:<id>`), never yours, and at most 8 tasks from one node
     are open there at once (waiting, queued or running). Your grant revoked stops what was handed under it; a node
     that restarts ends what was handed to it before, as nobody follows it any more.

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
   `Authorization: Bearer $INVINCIBLE_TOKEN` and the tool's input as JSON (1 MiB at most). It is told how through its
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
    goal: base64url(SHA-256(goal as handed)), gates: [<the gates it ran, the giver's first>],
    status: done | failed | stopped | interrupted, verified: bool,
    ended: done | unverified | gave-up | stopped | null,
    proof: { before: [exit…], after: [exit…], review: pass | revise | null, sameModel: bool } | null,
    startedAt, endedAt }
  signature = Ed25519(runner's device key, "invincible-proof/v1\n" + canonical JSON of the statement)
  attestation = { statement, sig: base64url(signature) }
  ```

- **What the giver checks, before it says anything is proven** (`proofRefusal`):
  - it parses as one;
  - it is signed as the node the task was handed to, and that node is active in the fleet;
  - the signature verifies under that node's device key;
  - it is for this node, this hand-off and its nonce, over this goal;
  - its gates begin with the ones asked for (the planner's proposals may follow).

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

Measured with `bun bench/fabric/measure.ts --qamp <binary> --samples 30`. Three nodes in temporary homes, each with
Q-AMP main's sidecar (`831b845`), on loopback. An Apple M3 Pro under a load average of about 5, on 26 November 2026.
"Before" is HTTP with signed requests, which is all there was before the fabric; "after" is Q-AMP. The p50s are
medians of the samples, in ms.

| | Before (HTTP, signed) | After (Q-AMP) |
|---|---|---|
| First answer on a fresh connection (beta asks alpha for what follows its frontier) | 0.44 | 1.35 (a Retry, the 1-RTT handshake, the call) |
| The same, a sidecar process's very first call | — | 24.2 (its crypto library's first use: a long-running sidecar pays it once) |
| An answer on a warm connection | 0.65 | 0.31 |
| Sync's lag (an event written on alpha, until it is in beta's ledger: a push) | 3.80 | 3.29 |
| A forwarded command's answer (a sandbox on beta) | 2.49 | 2.44 |
| A handed task's first output back on the giver | none: no such link | 12 |
| A handed task, given to Proven (stand-in models) | none | 37.7 |
| A stop's round trip (the giver's stop, the work stopped and said) | none: forwarded work couldn't be stopped from its sender | 2.42 |
| A run's key revoked, until its next call is refused | none | 10.0 (most of it the sidecar's durable write) |
| A device revoked on alpha, until beta refuses it | 32.3 | 24.9 |

- **On loopback the paths cost about the same, and loopback hides what matters.** On a real network every round trip
  adds the path's latency:
  - plain HTTP's first answer is two round trips (TCP, then the request);
  - Q-AMP's is three on a first meeting (a Retry, the handshake, the call), and two once the peer's NEW_TOKEN spares the
    Retry.

  What Q-AMP brings is streams instead of polling, a stop that reaches the work, grants held to a task and checked per
  call, revocation without caching, and a post-quantum key exchange inside the tunnel (WireGuard's own is classical).
- **The hand-off's first output and its stop** were 104 ms and 58 ms before the runner followed its agents' own changes
  (each trail line wakes it), and 12 ms and 2.4 ms after (three runs each; the commit says the medians).
- **Across the real network** (two test nodes, one on each of the owner's two machines): the next section, once
  measured.

## Across a real network

`bench/fabric/remote.ts` measures between two throwaway test nodes of a fleet of their own, one on each machine, each
with its own sidecar on its tailnet address. It never touches the owner's nodes, homes or ports. The measuring node
times every round trip on its own clock: an event comes back as the other's echo (two pushes, halved), and a device it
revokes comes back as the other's word that it refuses it.

```sh
# on the serving machine (its tailnet address, an empty directory, two ports open to the tailnet: 7470/tcp, 7471/udp)
bun bench/fabric/remote.ts serve --qamp <qamp for this machine> --advertise 192.0.2.10 --root /tmp/q5 --port 7470 --qamp-port 7471
# on the measuring machine, with the invite the first one printed
bun bench/fabric/remote.ts measure --qamp <qamp for this machine> --advertise 192.0.2.20 --root /tmp/q5 --invite <invite> --samples 30 --out results.json
```

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
   whether it has one); a stopped one does when it starts.
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
7. **Back to HTTPS alone**, if Q-AMP misbehaves: `invincible fabric off` (at once, no restart), `INVINCIBLE_QAMP=off` in
   the node's service environment and a restart, or close UDP 7410. Each peer falls back within one failed call and
   tries Q-AMP again later, so nothing waits on it.

## What isn't verified yet

- **The owner's real pair has never run it:** those nodes run main, where the fabric is dormant. Across a real network
  only two throwaway test nodes have, on the same two machines (above, once measured).
- **The security review of the fabric** is under way; its findings aren't fixed yet.
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
