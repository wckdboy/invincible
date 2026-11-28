# The fabric: nodes and their agents over Q-AMP

Phase 2 of [PLAN.md](PLAN.md), as built (26 November 2026). [ARCHITECTURE](ARCHITECTURE.md) §3 says why;
[SECURITY](SECURITY.md) says what it defends against and how each claim is tested. This page says what runs where, the
protocol for proof across nodes, the numbers, and how to switch it on.

**State:** on main, dormant. It is off on every node until that node's own setting says so (`invincible fabric on`). The
pin is Q-AMP 0.3.0 (`scripts/qamp-pin.sh`), whose sidecar the node speaks as it does 0.2.0's, the first release with one: a node with that binary and its setting
on runs its sidecar, and one without either stays on HTTP with signed requests, its Doctor saying why.

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
   - **Within it** (an agent it names, or any when it names none; tools it names; a budget that fits what is left of
     its day, $3 when the hand-off names none) the runner gives it to that agent at once, as the best suited among
     those it names when the hand-off names none. Each hand-off counts at least $0.10 against the day, whatever
     smaller budget it asks for (and keeps), so the day bounds how many there are as well as what they spend. Its work
     runs only on models its budget counts at more than $0 (one you've priced above nothing, on no coding plan): its
     agent's own loop, its coding tool, and its commands, whose VM's lease is good for those models' calls alone. The
     gateway refuses any other model (the third re-review's R3-4), and on that lease any route but its protocol's
     model calls (a POST, embeddings among them: the fifth re-review's R5-7) and their listing (a GET), so nothing
     else of yours with that provider (its files, stored responses, batches, vector stores) is read with your key, by a
     route or by its id in a call's body (the fifth re-review's R5-5), nor a batch made (the fourth re-review's R4-3).
     That lease carries nothing else: not the keys of yours its agent may use, nor its agent's repository, which are its
     agent's own work's. Never on one it counts as nothing, nor on a coding tool's own sign-in in the VM (a seat), nor
     in an ACP agent of yours. Every call on that lease is counted, whether or not its answer says its usage (the fourth
     re-review's I-l): a streamed OpenAI-style call is asked to say it (`stream_options.include_usage`), and one whose
     answer says none all the same is counted at the most it could have been, every byte it sent an input token and
     every byte it was answered with an output token. A call cut before its answer ends is counted as it ends (the fifth
     re-review's R5-2): each byte sent an input token, and the most output it allowed itself, for each answer it asked
     for, or what was answered if more. What its budget can't count is taken out of a call where the call means the same
     without it (R5-4): the providers' own tools, billed per use or run by another model, a fallback to another model,
     and a dearer speed or tier. Codex, which declares OpenAI's web search in every call, goes on without it. A
     background response, chat's web search, a tool_choice for a tool taken out and US-only inference are refused. Every
     held call is sent as it was read. Nor is this: a command can start a coding tool itself on that tool's own sign-in
     in the VM, if it has one, which no lease reaches (a task's own VM starts with an empty HOME, so it has none).
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
       re-review's R3-1). That VM is made from the agent's VM's image, as big as it (its disk too, where the host
       holds one to a size) and on its network: beside an online agent it can reach what that agent can, and send its
       clone, all of HEAD's ancestry, anywhere (the seventh re-review's I-f). It shares nothing of the agent's store
       (the fifth re-review's R5-3, by
       its first option): its `/work` is a volume of its own, removed with it, and its HOME is its own, in memory. Its
       lease is the task's paid models alone (never your keys, nor its repository), counted under its agent's label, so
       its budget counts what it spends. None of its commands runs in the agent's own VM.
     - **Its repository is a clone of its own** (`packages/agents/src/handed-repo.ts`). As the task starts, the agent's
       side gives the task's worktree as it stands (its changes so far, for a task taken up again) as a git bundle of
       that commit and all of HEAD's ancestry (every commit of the branch the work began on, and whatever it ever held:
       the seventh re-review's I-e), never the repository's other branches, tasks or checkpoints, and the task's VM
       clones it at the same place, its HEAD where the work began. After each step it keeps, before each review, and as
       it ends, its changes since then come back as one patch. The agent's side keeps it in a file of that receive's own
       and applies it with the node's held git: `git apply --cached` to where the work began alone, in an index of its
       own, which reads and writes nothing of the worktree and takes no path outside it, into a `.git`, or through a
       link; then the tree that makes, and nothing else, is made the worktree, a link in the way of one of its paths
       replaced by a folder, never written through (R7-3, I-a). Each binary part must carry the content of the object it
       names, checked before git reads the patch, so nothing of it comes from the agent's store, and it counts at what
       git inflates it to (R7-1, R7-2); a copy or a rename, which carries none of its content and which its send never
       makes, is refused. A patch is refused for any of these: a `copy` or `rename` header line of any kind (git's
       older `rename old`/`new` among them), a `diff --git` whose two names aren't one path, or a `---` or `+++` naming
       another than its section's (the eighth re-review's R8-1). A /dev/null there names no file only after the same
       header's `new file mode` (for `---`) or `deleted file mode` (for `+++`) line: git reads any other as the file
       `dev/null`, and one section renamed the base's file there and each later one copied it, 946 MB from a 1 MiB
       patch (the ninth re-review's R9-1). And git's own reading of the patch (`git apply --numstat -z`) must name each
       file it touches by one name, a path a `diff --git` line names: so a spelling git takes and the lines above miss
       is refused too. A patch is applied
       only once all of it came (its sender done, the pipe not cut, as many bytes kept in its own file as were carried),
       and only up to 512 MiB, its bytes and its binary parts as they inflate. One that is cut short, or bigger, is
       dropped, and the task says its changes couldn't be brought back. Every step of the agent's side on that worktree
       (a bring-back, a checkpoint, a review's evidence, the changes' read) runs one at a time, in order (R7-3). Both
       ways go through the node, one side's output the other's input, never kept on the host (`SandboxHost.pipe`); a
       pipe cut at its cap or past its deadline ends both sides' commands in their VMs, not only the node's two clients,
       and one whose receiving side is gone ends its sender's (I-c). In a Kata microVM, an interactive exec given
       nothing, its input ended before its command started, never sees that end: it runs to its deadline, and no other
       exec of its VM starts meanwhile (the Kata audit, 28 November 2026). One that was fed holds nothing, after its
       input ends too: an exec beside it took 35 to 45 ms (the eighth re-review's P2). So a pipe's receiving side starts
       with its input: at the sending side's first chunk, or, if that gives none, with no input at all, its stdin
       `/dev/null` in its VM; started with the pipe and given nothing, one ran to its 120 s deadline behind an 8 s
       command of its VM's. One that runs on past its input's end is ended by the pipe's end, in Kata too (174 ms, P4).
       A task with no repository keeps its files in its own VM, and they go with it.
     - **What its review passes is what is shipped** (the seventh re-review's I-b). In a repository, its review's
       evidence is read on its agent's side, on the tree its last bring-back made there, never in its VM, whose
       processes are the task's own. A task with no repository reads it on a copy of its folder as its gates' copies are
       made (below), or, with no gates, in its VM, and nothing is shipped from one. When the review passes, that tree is
       what is kept and shipped as verified, and nothing its VM had after it; the worktree there is checked to be that
       tree still, and short of that the task isn't verified, and says why.
     - **Its gates say what its tree does, never what the task says they did** (the eighth re-review's R8-3, and the
       eleventh's ruling). Before each run of them (before the work, a contract's, a submission's), everything of the
       task's in its VM is ended (a task whose gates need a server starts it in the gate) and the tree they judge is
       read: its clone's, or with no repository its folder's. The review's tree must be that one, so nothing of the
       task's changes a file under its gates, or between them and the review, and is shipped as verified (the lead's
       decision for I-b's gates). That run of them is a round of its own, in a VM of the round's own:
       - made for it from the task's VM's image, as big as it, with no network at all and no lease, beside its agent's
         VM, and removed when the next round begins or the task ends. Nothing of the task's ever runs there: not its
         commands, nor its coding tool, nor anything its end missed;
       - given the tree once, through the node. In a repository, the tree's objects are packed in the task's VM
         (`pack-objects`) and taken in the round's VM by that VM's own user (`index-pack`). Each is hashed as it comes,
         and every object of the tree is checked to be there, so the round holds that tree whatever the task's VM did.
         With no repository, the folder's tar is taken instead: each entry must be a file, a folder or a link inside it
         (no name or link out of it, nothing written through a link, no device, no `.git` at any level, which git would
         hash the folder without and a gate's git would obey: the twelfth re-review's I-12a, and no folder laid out as a
         git directory, `HEAD`, `objects` and `refs`, which a gate's git would take for a repository: the thirteenth's
         I-13a), and its tree is hashed as git hashes it. The store is the round VM's user's: a gate's user reads it and
         never writes it. A file the task's VM's user can't read fails the round, and says which: nothing is left out
         unsaid (the ninth re-review's I-2);
       - each gate, each check of the node's on what they judge (the digests of the test files they name) and, with no
         repository, the review's evidence then run there, each as a user of its own that no other of the round's has
         (`gate1`, `gate2` and on, uids 61001 to 61256, named in the VM's `/etc/passwd`, which the node mounts
         read-only; the twelfth re-review's R12-1). A round runs 256 of them at most, and refuses one more. Each runs on
         a copy of that store of its own, in a folder of its own user's alone (0700) in the sticky gates' folder
         (`/gates`), with a HOME and a temporary folder of its own there. It gets nothing of the VM's environment but a
         PATH of its read-only folders, and of the login profiles only the image's own (`/etc/profile`). Its git takes
         no bare repository it isn't named (`safe.bareRepository=explicit`, from its environment, which no repository's
         config overrides) and looks for none above its copy (`GIT_CEILING_DIRECTORIES`), so a tree laid out as a git
         directory, or a `.git` planted in the gates' folder, is never its repository (I-13a);
       - and nothing a gate before it left reaches it.
         - A gate's command runs the task's code as that gate's user (its test, say), and that code may leave anything
           running. The re-reviews found four kinds: a process that ended the gate's helper (the ninth's R9-2); a thread
           group whose leader thread has exited while another runs on, which `/proc` shows as a zombie; a chain of
           processes, each forking its next (the eleventh's R11-1); and, in Kata, a process that traced the round's
           sweep, which ran as its own user, and turned its `kill` into its own exit (the twelfth's R12-1). Kata's guest
           kernel has no Yama, which in runc refuses one process's trace of another of the same user. Each came back
           verified while every gate ran as one user.
         - Now no process one gate's user left can trace, signal, read or write anything of a later gate's: the kernel
           refuses a trace or a signal across users without a capability, which no process of a round's VM has or can
           gain (no-new-privileges), and each copy is its user's alone. Tried in Kata and in runc
           (`gate-sweep.integration.test.ts`): a seize, a signal, a read, a write and a rename across users are refused,
           and in Kata a seize of a process of its own user succeeds.
         - After each gate, what its user left is ended and tidied: `kill(-1, SIGKILL)` as that user, from an exec of
           its own with nothing of that user's above it, repeated until `/proc` shows none with a thread alive (20 tries
           of a zombie-led group and of a fork chain came back with nothing left, in Kata and in runc), then its files
           in `/tmp`, `/dev/shm` and `/dev/mqueue`, its folders in `/gates`, and its System V IPC objects. That keeps
           the round's VM from filling. It decides nothing: in Kata a process of that user can trace its sweep and
           outlive it, and then it stays that user's alone, which no later gate of the round is;
       - a check that can't be made sends the work back, never "no change" (the eleventh re-review's R11-2). That covers
         a round whose tree can't be given, a copy that can't be made, and a check that didn't end as it does. Before, a
         process the freeze missed closed the clone's `.git` to the gates' user around the check's copy alone, and the
         rewritten locked test then passed. Before any work, a check that can't be made ends the run, since nothing
         could be locked.

       Every other command of the node's in the task's VM runs in a shell that reads no profile. The handed helper and its
       end run as `/usr/bin/python3 -I`, named by its path. The task's own commands keep their login shell, inside the
       helper. What they leave running ends with the task, a thread group whose leader has exited among it. In Kata and
       in runc, the PoCs below all come back not verified, with every gate, copy and sweep in a round's VM and none in the
       task's (`handed-real.integration.test.ts`):
       - the eighth review's: a profile whose python3 says each gate passed, and a process that ended its own helper and
         writes the gate's file while a gate looks for it;
       - the ninth's: a first gate's run of the task's test leaving a process that writes the second gate's file;
       - the eleventh's: the same with a zombie-led group, a fork chain, one locked gate beaten by what round 1 left,
         and the locked check's copy failed;
       - the twelfth's: a process that traces its gate's helper and each later sweep, and writes the second gate's file
         into each later copy it finds. It came back verified in Kata before each gate had a user of its own.
     - **What a gate gets is what CI gives a job: a checkout of the tree that comes back, offline.**
       - Nothing the task installed or built in its worktree that isn't in that tree: a gate that needs `node_modules`
         makes them (`bun install --frozen-lockfile && bun test`).
       - No network, no lease (no model), and nothing of the task's HOME or VM.
       - Its packages from the node's install cache, mounted read-only at `/cache/bun` (bun's `BUN_INSTALL_CACHE_DIR`).
         - The node fills it as each round begins, before the round's VM is made, in a filler container of its own: no
           capability, a read-only root, a user of its own, the cache as its one writable mount, and no network. Its one
           way out is the node's proxy, on a socket of the fill's own mounted into it, which opens a tunnel to the
           registry (`CONNECT registry.npmjs.org:443`) and refuses anything else (the twelfth re-review's R12-2).
           Before, the filler ran on Docker's default bridge, and bun fetched what a manifest's catalog named, a URL or
           a git repository, from whatever the host reaches, and kept it in the cache.
         - The filler is given the tree's `bun.lock` alone: no `package.json`, `bunfig.toml`, `.npmrc` or script. It
           refuses a lockfile package that isn't the default registry's (an npm name, an exact version, a sha512 hash)
           or a workspace's own, a patch, and a key twice. It checks the lockfile's workspaces' dependencies, its
           catalogs and its overrides as strictly, though bun never reads them there: each a table of npm names, asked
           of the default registry by a version, a range, a tag or an `npm:` alias.
         - It fills from the lockfile's packages alone: it writes a manifest of its own that asks for each of them by
           name and version. Bun resolves that manifest from the registry's metadata to a lockfile of the fill's own,
           which must name each of them by the tree's hash before any tarball is fetched. Bun then installs it, checking
           each tarball against that hash, and runs no package's script.
         - A gate that needs a package that wasn't filled fails offline, and says why. Bun doesn't check a hash of what
           it takes from its cache, which holds what the registry gave, each package checked as it was fetched;
       - A `.git` of its own, whose HEAD is a commit of that tree with no history.

       A link in the tree that points out of it, by its words or by where it resolves through other links, is refused.
       Its copies count in its gates' 15 minutes, and a copy is at most 2 GiB. A gate whose command runs the task's code
       (`bun test`) runs that code as its own user, for its own run alone: its verdict is that code's, as ever (in Kata
       that code can trace its gate's helper too), and the review reads what it is.

       With no repository, a process the task's end missed can still change what is tarred for a round. Its gates and
       its evidence then both read that, and the same, and nothing is shipped (a task with no repository ships nothing).

       Within a round, its gates still share its VM's kernel: its loopback network, its CPU and memory, and what can be
       made by name in its `/tmp` and `/dev/shm`. A process a gate's run of the task's code left (which, in Kata, can
       outlive its sweep) can listen on a port of the loopback, or leave a file of a fixed name there, which a later
       gate's command trusts only if it reads that port or name without making it. A gate's own HOME and `TMPDIR` are
       its own, in its own folder.
     - The VM goes as the task ends, however it ends (done, failed, stopped, its agent paused), and with it everything
       the task started there. When its work ends (a revocation among its ends: your brake), its lease ends and the VM
       is removed at once, the command in flight there with it, never once that command returns (the fifth re-review's
       I-1). Its lease ends as the task does, whatever becomes of the VM (R4-7): one whose removal fails spends
       nothing more of yours, reaches nothing of its agent's store, is never renewed with its agent's lease again, and
       is tried again on a timer until it goes, as well as before the next is made. One an earlier process of the node
       left is removed as the node starts. No route reaches into it, yours included.
     - It is made on a Linux host with Docker, beside its agent's VM in either layout (SECURITY.md): sharing nothing of
       that VM's store, it needs no layout 2 (the fifth re-review's I-d, gone with R5-3). On a node with no room beside
       its agent's VM for one as big, the task waits for room as any sandbox does, within its life: a task that ends
       while it waits leaves the queue, and no VM is made for it (the fourth re-review's I-2).
     - **A Mac takes no other node's task.** Its VM of its own, and the pipe its clone and its changes go through, are
       made only by a Linux host with Docker. So a Mac refuses it at once, before it reads anything of it
       (`MAC_TAKES_NO_TASK`, `handoff.ts`). You see its words on the hand-off, as that node's: "This node is a Mac, and
       a Mac takes no other node's task: such a task runs in a VM of its own, with a clone of its own of the
       repository, which only a Linux node with Docker makes. Hand it to one of your Linux nodes with Docker." A grant
       to a Mac gives nothing, since every task handed to it is refused so.
     - Its gates are its giver's commands, run in its VM: all of them together get as long as one command may (15
       minutes), every round counted, and once that is spent they aren't run and the work isn't done.
     - Each shell command of its agent, its coding tool and its gates runs under a fixed helper (`handed-process.ts`),
       in a process group of its own under its own deadline, its `desktop` verbs too (the third re-review's R3-3). What
       a gate starts ends with the gate, and what its other commands leave running is listed and ended with the task
       (R3-5). A command that ends or stops its own helper, or a process that double-forks out of it, escapes that
       bound, but not the task's VM, which goes as the task ends, and nothing of what escapes reaches its gates (above).
     - The runner stops it at its call's deadline or after 24 hours, whichever comes first, waiting for your approval
       included. A stop that can't be written (the node stopping, or a write that fails) ends its call all the same,
       answered as failed (the third re-review's R3-2). A task you take up again by its id lives no longer than the
       longest a hand-off may last, from then (R3-6).
     - Not bounded: the VM time its work takes isn't counted itself (its budget's dollars and its life bound it), and
       what its changes put in its worktree (the repository's scripts among them, and a link, which stays a link) is
       there for the agent's later work, which runs it by its own choice, as it would any change it takes. Nothing else
       of the task's reaches its agent's store: not its clone's `.git` (its configuration, its hooks, a repository
       nested in it), and nothing outside its worktree (each patch is kept under `/work/.agent`, in a file of its own,
       only until it is applied or dropped; what a run cut off left there is swept as the task starts again, and as the
       node starts for each task it can't be running, one that has ended or one it doesn't know: I-d). The node's own
       git in the agent's repository (a task's setup, its steps' checkpoints, its evidence,
       what it keeps to ship, the patch's apply) holds the repository's configuration off (the fourth re-review's R4-4,
       and the fifth's R5-6): no hook, fsmonitor or signing program written there runs, nor a filter its configuration
       names when the command starts, and a fetch with the agent's lease goes to the gateway alone, nor to a
       submodule's own remote, nor does an alternate's refs command run; the backlog look's git is held too.

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
a handed task, which no row here times. Nor does any row time the VM each hand-off now has of its own (R3-1): it is made
from its agent's VM's image as the task starts, and removed as it ends, and the benches' Docker is a stand-in that makes
no VM. On a real node that is a microVM's start (Kata's) and its clone of the repository (a bundle of its history,
through the node) before the task's first command runs, and a patch brought back for each step it keeps.

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
   (linux-x64, linux-arm64, darwin-arm64), from the release's SHA256SUMS.
2. **The binary, on each node.** Either way the binary is checked against the pin and put at `<home>/bin/qamp` by a
   rename, so a sidecar running the old one keeps running.
   - **With a deploy:** `scripts/deploy.sh <host> --qamp <the release's binary for that machine>`. The node is restarted
     as every deploy restarts it.
   - **Without one:** on the host, as the node's user, `source scripts/qamp-pin.sh && install_qamp <the binary>
     ~/.invincible/bin`. The node needs no restart.

   The binary alone switches nothing on.

   **From Q-AMP 0.2.0 to 0.3.0, keep the way back.** Before the new binary goes in, copy the sidecar's state file aside:
   `state.json` beside its socket (`<home>/run/state.json`), its grants and revocations. 0.3.0 soon writes that file as
   its version 2: at its first change (a grant made, renewed or revoked) while it holds 0.2.0's grants, and at a token's
   revocation in any case. 0.2.0's sidecar refuses to start on version 2 ("state file …: unknown version 2"). To go back
   to 0.2.0, put the copy back with 0.2.0's binary. Every revocation made since is lost with it: a token revoked since is
   taken again until it expires, a day at most (the sidecar's `--max-ttl`).
3. **Switch it on, on each node:** `invincible fabric on`. A running node starts its sidecar at once (and asks the binary
   whether it has one); a stopped one does when it starts. A node that takes other nodes' tasks is a Linux one with
   Docker (a Mac takes none), and it needs no other setting: layout 2 isn't one of the fabric's.
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
- **A handed task's clone of its own (R5-3) has run on real Docker, not yet on a node.** Its scripts give, clone,
  send, receive and apply on real repositories (`handed-repo.test.ts`). On Ultra's Docker 29.10.0, in containers and
  in Kata microVMs, `SandboxHost.pipe` carried a task's clone and its patch between two VMs made from the sandbox image,
  the patch was applied and the step kept, a pipe past its cap was cut and a side past its deadline ended, and the
  image's git is 2.47.3, past CVE-2023-23946's fix to `git apply`'s checks of links
  (`handed-docker.integration.test.ts`, 27 November 2026). A pipe cut at its cap left nothing of either side running
  in either VM, the children a side started without the pipe's tag among them, in 0.7 s in containers and 4.2 s in
  Kata, with the sides' own deadline past the test's (I-c, 28 November 2026). A task that changed nothing came back at
  once, empty, and applied as its base, also while its agent's VM ran an 8 s command of its own: in Kata it had run to
  its 120 s deadline before its receiving side started with its input. Two scratch nodes on one host have since taken a
  handed task through it end to end, over Q-AMP, its gates, review and bring-back among it, in Kata and in runc, on
  stand-in models (`handed-real.integration.test.ts`, 28 November 2026): not yet two machines, real models, or a node's
  gateway and lease.
- **Relays and NAT traversal** (Q-AMP's `feat/relays`) aren't used: nodes reach each other on the tailnet, directly.
