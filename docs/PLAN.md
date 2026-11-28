# The plan

What Invincible builds, in order. Each phase ends when its exit checks pass, all of them, measured. A phase names the
[mandate's](MANDATE.md) numbers it moves (correctness, horizon, cost, reversibility; the north star is human
interventions per completed task).

✅ done · 🔨 being built · 🔜 next

## Phase 0: the foundation 🔨

The repository, the rules, and the proven engine carried in ([ARCHITECTURE §10](ARCHITECTURE.md)), renamed and green.

- 🔨 These documents, AGENTS.md, the mandate.
- 🔜 The engine carried and reshaped (core, ledger, link, models, agents, sandbox, node). The node runs:
  `invincible start` on a fresh home, a client pairs, the primary answers, a task runs in a sandbox and is verified.
- 🔜 The vocabulary check in CI: no word of the old theme.
- 🔜 sovware.io holds the main copy: a protected main that takes only pull requests whose checks all passed, as
  the system it succeeds has.
- 🔨 **Q-AMP, built in parallel from today** in its own repository: the sidecar socket API, P-256 identities with
  signing by callback, then the bindings. Phases 2 and 5 stand on these.

**Exit:**
- `bun run check` is green, with the carried suites passing in their new places;
- the vocabulary check is clean;
- the scorecard's carried suites hold the baselines they came with.

## Phase 1: the primary and its agents 🔜

What the owner uses every day, built on the carried engine around the new model.

- Agents as profiles (role, harness, models, sandbox), and projects with their defaults. Each task is a thread with its
  runs, steps, gates, review, proof and cost.
- The primary orchestrates: it decides who does what, gives the work, follows it to its proof, ships it, and comes
  back with the result.
- The web app on the redesign's interface, around your agent (named by you at first run) and the work by attention.
- 🔨 `inv`, the command line as a client of a node ([CLI.md](CLI.md)): the first slice is built. It pairs as the apps do,
  shows the board and each task's proof in the apps' own words, and its exit code is the verdict (0 means verified).
  Q-AMP as its transport, grants and peers, the diff pager and keys in the board come later.
- The look on every surface: the new look carried from the system Invincible succeeds ([ARCHITECTURE §10](ARCHITECTURE.md)),
  by the owner's word of 26 November 2026: the field orb (gold, with its beam) for the primary, fields in their own
  colours for agents, the embers, and the INVINCIBLE wordmark. Then, the same day: the I-beam as the icon (with a
  transparent dark variant for iOS), and the apps monochrome, colour kept for the agents.
- A Gemini API key for agents on Antigravity: dropped (the owner, 28 November 2026). They sign in with their own Google
  account and use their AI Ultra plan, and want nothing else to do; a seat of it is the product.
- 🔜 The Gemini seat's open items, from its re-checks of 28 November 2026, each its own change:
  - the sealed sign-in's two dependencies, seen signed in: agy starts from its copy and refreshes into it, and a later
    start from the same sealed copy still signs in once an access token's life has passed (no rotation); and the account
    checked at each start, beside it, only if agy names its account after a start;
  - agy signed in by hand in an agent's own VM has no sealed copy: a run there can still swap it for that agent's later
    runs;
  - where agy's plugin MCP servers come from for the signed-in user (from the account, a swap within a run brings
    commands): signed in;
  - `/work/tasks/.codeium.yaml`, which agy reads above a task's workspace: settle what it holds, or refuse to start;
  - an ACP command that runs agy under another name isn't held to the plan's rule;
  - R6's forms still read in pieces: `KEY=<base64>` (it can come without intent), `0x<hex>`, a JWT wrapped with its
    label, xxd's own dump;
  - R6's over-redaction: a URL that shows a secret is shown decoded, and a base64 lockfile is hidden whole;
  - another node's words: the fleet's shared memory, recalled for a task's goal, now (the log syncs between nodes with
    the fabric off); a dependency's result and a refused hand-off its agent gives itself, once the fabric is on;
  - a `docker info` slower than 8 s skips the seats' sweep without a word.

**Exit:**
- a task given in plain words, in a repository the agent has never seen, ends verified and shipped as a pull request,
  with no intervention, on a real node;
- the agentic suite holds the baseline it came with, or beats it;
- the web app passes the owner's bar: the screenshot review beside the benchmarks, no layout shift, nothing moving at
  rest.

## Phase 2: the fabric 🔨

Q-AMP between the nodes and the agents ([FABRIC.md](FABRIC.md)). On main and dormant, and off on every node until its
own setting says so (`invincible fabric on`), and pinned to Q-AMP 0.3.0, after 0.2.0, the first release with the sidecar.

- 🔨 Q-AMP: the sidecar socket API ✅ (Q-AMP main); grants that renew themselves: the giver renews a run's grant and sends
  it in on the hand-off's call, and Q-AMP's own, holder-driven renewal, spec first, is next.
- ✅ Node ↔ node over Q-AMP: sync, pushes and forwarded work, each call signed by its node's device key, with HTTP as
  the fallback (on the tailnet alone, to a peer that speaks Q-AMP), each peer saying its path.
- ✅ A task handed to another node's agents, at once under your grant for the pair (else a proposal there, for your
  approval): streamed back, stopped from either end, its run using the giver's tools with its own key and chain, its
  proof signed by the node that ran it and checked before "Proven". Agents outside the fleet keep their grants (Q-AMP
  0.1's bridges).
- 🔨 The security review's findings (H1, M1, L1 to L8, I1 to I6): fixed, each with a failing test first; their
  independent re-review is next.
- 🔜 A signed request names the node it is for (the second re-review's I-g), before the first limited node.
  - Today its signing input is the method, the path, the time, the nonce and the body's digest.
  - So a limited node that a full node syncs with over HTTP receives that node's signed `POST /link/sync` every 5 s.
    Within its minute it could replay it to a third node as the full node, and read the answer.
  - Over Q-AMP the door already holds the signer to the transport key's node.
  - The target's id goes into the signing input. It is a contract change, with fixtures for the old form and the new.
- ✅ The pin: Q-AMP 0.3.0, after 0.2.0, the first release with the sidecar (`scripts/qamp-pin.sh`).
- 🔜 The owner's pair switched on (FABRIC.md, the runbook).
- 🔜 Coding plans for another node's tasks, bounded by calls or tokens a day (the lead, 28 November 2026). A hand-off
  runs only on models its budget counts above $0, so that its budget bounds its spend (`handedLease`, `paidFor`).
  A coding plan's models (OpenCode Go's, Z.ai's, MiMo's) count at $0, their calls paid already, so a hand-off to an
  agent whose models are all plans calls nothing.
  - What would let a plan serve one: a bound of its own, a number of calls or tokens a day for each hand-off, counted at
    the gateway as its lease's, and refused past it, as its dollars are now.
  - It would also have to share the plan's own windows (its five-hour and monthly allowances, `windows.ts`) with your
    own work, which comes first.
  - The plan's terms decide which may serve another node's work at all: unattended use, as the provider list says.

**Exit:** the first answer on a fresh connection, and sync's lag, are measured before and after (the carried grants measured 96 vs
504 ms first answer). Revocation cuts a key off within one round trip. The fuzz targets run clean.

## Phase 3: the apps 🔨

- 🔨 iPhone, iPad and Mac, and Android, on the new interface, with the carried plumbing (device keys, pairing, push) and
  the pure logic ported, held to the vectors. Carried from the old system's redesign (26 November 2026) and made
  Invincible's: its words, its API, its vectors and dev node, its icon and wordmark (`apps/apple/README.md`,
  `apps/android/README.md`). Their tests, the Mac build and the vectors run in CI; the Apple job waits for the owner's
  Mac runner (label `macos-xcode`).
- 🔨 invincible.sh (`apps/site`): the installer, the apps' update feeds and their downloads, in Invincible's look. It
  replaces the site there today on the owner's word, by the CLOUDFLARE_API_TOKEN secret that CI's deploy job waits for.
- New identities in the stores: `sh.invincible.bot` (iPhone and iPad; App Store Connect's "Invincible Bot", push on),
  `sh.invincible.bot.mac` (Developer ID), and Android's `sh.invincible.bot`. TestFlight has the first build
  (202611261105, 26 November 2026); the Android release key and the Mac's Sparkle key are made (26 November), in the
  owner's keychain and outside the repository.

**Exit:**
- the vectors pass in both apps;
- each screen is reviewed beside the benchmarks;
- 120 fps scrolling, measured;
- TestFlight and the Android release are in the owner's hands.

## Phase 4: the cutover 🔜

- 🔨 The one-time import ([ARCHITECTURE §10](ARCHITECTURE.md)) on the owner's server (Ultra), with the old system still
  running beside it. Its memory, vault, projects, providers, connectors and chosen chats are checked on the other side.
  The importer is built, and tested against a home the old system's own code made; its run on Ultra is next.
- The owner's devices pair with Invincible, and the old system stops. Its website points to invincible.sh.

**Exit:** the owner uses Invincible for a day without opening the old system.

## Phase 5: Q-AMP everywhere 🔜

- Q-AMP: P-256 `did:key` with signing by callback, Swift and Kotlin bindings, a WebTransport binding, relays and NAT
  traversal.
- The native apps speak Q-AMP to their node, with the device's hardware key, and the browser speaks WebTransport. A phone
  on mobile data reaches its node without a tailnet.

**Exit:** a phone's first answer and its reconnect after a network change are measured against HTTPS. No key leaves its
chip.
