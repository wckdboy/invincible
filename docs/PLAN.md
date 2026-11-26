# The plan

What Invincible builds, in order. Each phase ends when its exit checks pass, all of them, measured. A phase names the
[mandate's](MANDATE.md) numbers it moves (correctness, horizon, cost, reversibility; the north star is human
interventions per completed task).

✅ done · 🔨 being built · 🔜 next

## Phase 0: the foundation 🔨

The repository, the rules, and Galahad's proven engine carried in, renamed and green.

- 🔨 These documents, AGENTS.md, the mandate.
- 🔜 The engine carried and reshaped (core, ledger, link, models, agents, sandbox, node). The node runs:
  `invincible start` on a fresh home, a client pairs, the primary answers, a task runs in a sandbox and is verified.
- 🔜 The vocabulary check in CI: no word of the old theme.
- 🔜 sovware.io holds the main copy: a protected main that takes only pull requests whose checks all passed, as
  Galahad's does.
- 🔨 **Q-AMP, built in parallel from today** in its own repository: the sidecar socket API, P-256 identities with
  signing by callback, then the bindings. Phases 2 and 5 stand on these.

**Exit:**
- `bun run check` is green, with the suites carried from Galahad passing in their new places;
- the vocabulary check is clean;
- the scorecard's carried suites hold their Galahad baselines.

## Phase 1: the primary and its agents 🔜

What the owner uses every day, built on the carried engine around the new model.

- Agents as profiles (role, harness, models, sandbox), and projects with their defaults. Each task is a thread with its
  runs, steps, gates, review, proof and cost.
- The primary orchestrates: it decides who does what, gives the work, follows it to its proof, ships it, and comes
  back with the result.
- The web app on the redesign's interface, around your agent (named by you at first run) and the work by attention.
- The new identity on every surface: the name, the mark, the type, the colour. It is designed with the owner and held
  to his bar.

**Exit:**
- a task given in plain words, in a repository the agent has never seen, ends verified and shipped as a pull request,
  with no intervention, on a real node;
- the agentic suite holds Galahad's baseline or beats it;
- the web app passes the owner's bar: the screenshot review beside the benchmarks, no layout shift, nothing moving at
  rest.

## Phase 2: the fabric 🔜

Q-AMP between the nodes and the agents.

- Q-AMP: the sidecar socket API, grants that renew themselves.
- Node ↔ node over Q-AMP: sync, pushes and forwarded work, with HTTPS as the fallback.
- Runs on other nodes, and agents outside the fleet, using the primary's tools with their own keys and chains.

**Exit:** the first answer on a fresh connection, and sync's lag, are measured before and after (Galahad measured 96 vs
504 ms first answer for a grant). Revocation cuts a key off within one round trip. The fuzz targets run clean.

## Phase 3: the apps 🔜

- iPhone, iPad and Mac, and Android, on the new interface, with Galahad's plumbing (device keys, pairing, push) and the
  pure logic ported, held to the vectors.
- New identities in the stores: `industries.invincible.app`. Its App Store Connect record waits on the owner.

**Exit:**
- the vectors pass in both apps;
- each screen is reviewed beside the benchmarks;
- 120 fps scrolling, measured;
- TestFlight and the Android release are in the owner's hands.

## Phase 4: the cutover 🔜

- `invincible import galahad` on the owner's server (Ultra), with Galahad still running beside it. Its memory, vault,
  projects, providers, connectors and chosen chats are checked on the other side.
- The owner's devices pair with Invincible, and Galahad stops. galahad.sh points to invincible.sh.

**Exit:** the owner uses Invincible for a day without opening Galahad.

## Phase 5: Q-AMP everywhere 🔜

- Q-AMP: P-256 `did:key` with signing by callback, Swift and Kotlin bindings, a WebTransport binding, relays and NAT
  traversal.
- The native apps speak Q-AMP to their node, with the device's hardware key, and the browser speaks WebTransport. A phone
  on mobile data reaches its node without a tailnet.

**Exit:** a phone's first answer and its reconnect after a network change are measured against HTTPS. No key leaves its
chip.
