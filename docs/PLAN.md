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

**Exit:**
- a task given in plain words, in a repository the agent has never seen, ends verified and shipped as a pull request,
  with no intervention, on a real node;
- the agentic suite holds the baseline it came with, or beats it;
- the web app passes the owner's bar: the screenshot review beside the benchmarks, no layout shift, nothing moving at
  rest.

## Phase 2: the fabric 🔨

Q-AMP between the nodes and the agents ([FABRIC.md](FABRIC.md)). On main and dormant: it switches on when the pin moves
to a Q-AMP release with the sidecar, after the fabric's independent security review and its fixes.

- 🔨 Q-AMP: the sidecar socket API ✅ (Q-AMP main); grants that renew themselves: the giver renews a run's grant and sends
  it in on the hand-off's call, and Q-AMP's own, holder-driven renewal, spec first, is next.
- ✅ Node ↔ node over Q-AMP: sync, pushes and forwarded work, with HTTPS as the fallback, each peer saying its path.
- ✅ A task handed to another node's agents: streamed back, stopped from either end, its run using the giver's tools with
  its own key and chain, its proof signed by the node that ran it and checked before "Proven". Agents outside the fleet
  keep their grants (Q-AMP 0.1's bridges).
- 🔜 The pin: a Q-AMP release with the sidecar, and the owner's pair switched on (FABRIC.md, the runbook).

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
