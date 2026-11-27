# Invincible on the Mac

The Mac app (`sh.invincible.bot.mac`) is a native macOS app, not Mac Catalyst, built from `apps/apple` (project.yml's
`InvincibleMac`: the iPhone's and iPad's views, and its own in `Invincible/Mac`). It's signed with a Developer ID
outside the App Store and updated by Sparkle. It's three things at once:
- a client of your node, as the iPhone is;
- the manager and launcher of a node on this Mac, when the Mac is one;
- the primary's own computer, when you allow it.

This page says what it is and does today. The code cites its sections by name (M1, M2, M4).

## M1: the app

- **One main window.** The sidebar (Home, the primary, Agents, Needs you, More) has This Mac at its foot, with the
  place you chose beside it. A chat, an agent or a room can open in a window of its own, and each is back where it was
  at the next launch.
- **The menus.**
  - The places: ⌘0 Home, ⌘1 the primary, ⌘2 Agents, ⌘3 Needs you, ⌘4 More.
  - ⌘N starts a new chat, ⇧⌘N gives the agents a task, and ⌘K searches or asks.
  - **Settings** (⌘,) has three tabs: This Mac, Keys and Connectors.
- **The menu bar.** It shows the agents at a glance, each in the ring of where it stands, with what needs you and the
  node in a line. It keeps the app running with its windows closed.
- **Build** (docs/BUILD.md). A window of its own: a workbench with the primary, with your projects and their threads,
  what changed in a checkout, and a terminal there.
- **Notifications.** They are the Mac's own: no Apple push service and no entitlement (`Mac/MacNotices.swift`).
  - Turned on in Settings, the node keeps for this Mac what it would send it, by the rules every device is told by. The
    app collects it over its own signed connection when the live stream says `notify` changed.
  - Each is shown as an iPhone is sent it, with the same buttons: Approve… opens its card, where the yes asks Touch ID
    or the Mac's password; Decline is signed by this Mac's key.
  - The Dock's badge is what needs you. Quit, the Mac is told nothing; the iPhone and the web still are.
- **Its key** is made in the Secure Enclave and kept, wrapped by it, in the login keychain (`Core/DeviceKey.swift`).

## M2: the node inside the app

The app's binary is also the node's launcher (`Mac/MacMain.swift`):

| Run as | What it does |
|---|---|
| `--serve-node` | the bundled Bun running the bundled node, as the launchd agent the app registers; its log is `~/.invincible/logs/node.log` |
| `--cli <arguments>` | the bundled CLI |
| `--agent status \| register \| unregister \| restart` | the node's agent |
| `--this-mac` | what This Mac shows |
| `--first-run start \| join` | the first run, with no window |
| `--desktop <op>` | this Mac's screen, as the primary's computer (M4) |

- **Its home** is `~/.invincible`, as on Linux.
- **The `invincible` command.** The app can put it on your PATH as a two-line script in `~/.local/bin` that runs its
  bundled CLI. One that's already there (most likely `install.sh`'s) is left as it is.
- **This Mac** (in Settings, and at the sidebar's foot) shows the node's service, its process and revision, staying on,
  that command, its log and its doctor.
- **Updates.** Sparkle checks once a day, against the public key the build carries, for the signed feed on
  invincible.sh. A new release restarts the node onto it once the app is back.
- **The node in a build.** An everyday build carries no node, and says so. `scripts/mac-node-bundle.sh` puts the node
  in. `scripts/mac-release.sh` makes a release: built, its node bundled, notarized and stapled, with its appcast.

### The screens

On a Mac with no node and an app that isn't paired, the first run is one window with three steps down its side:
1. Make this Mac a node: start a fleet, join yours, or just the app.
2. Keep it on. A Mac with a battery skips this: it works while it's open.
3. Give its agents VMs.

### A Mac that stays on

These are what a node needs to be there when you aren't. Each is read live from the Mac, and the app never changes
them. A line's button opens the pane of System Settings that does, or asks the node for what is its own:

| Line | What it checks |
|---|---|
| Runs at login | its service, kept running by launchd |
| Logs in by itself | after a restart, as the node's user |
| Doesn't sleep | `invincible awake on` |
| Starts after a power cut | the Mac comes back on by itself |
| Reachable from anywhere | Tailscale signed in, with the app published on your tailnet |

### Give its agents VMs

`invincible sandbox setup` does this, as the first run's step 3, from This Mac, or in Terminal (`packages/node/src/sandbox-setup.ts`):
- **Apple's container:** its signed installer at a pinned release and SHA-256.
- **The sandbox firewall:** a root helper that launchd runs every ten seconds, installed once with your password. It
  uses pf's rules and the bridges' member filter.
- **Container's service** and its kernel.
- **The node,** restarted to find container.
- **The sandbox image.**

What the firewall enforces:
- A gateway sandbox reaches only the gateway's port.
- An online sandbox reaches the internet, never the Mac, your network or your tailnet.
- No sandbox reaches another.
- The node makes no sandbox while the firewall isn't on.

This was tried on the Mac mini, 17 November 2026 (`packages/sandbox/src/mac-firewall.ts`).

## M4: a Mac itself

The primary may ask to use a Mac itself, for some minutes: its screen, its apps, and a shell as its user
(`packages/core/src/screen.ts`).
- **Your say.** The Mac is its only once you allow it, in Needs you, for those minutes counted from your answer, until
  you or it ends the session. An ask you don't answer within 15 minutes lapses: no answer is no.
- **How it reaches the screen.** The node runs the app's binary (`--desktop`) for the screen's picture, its pointer
  and its keys. macOS allows that only once you turn on Screen & System Audio Recording and Accessibility for the app;
  `--desktop allow` asks for both.
- **Watching it.** You can watch the session and take over.
- **What notifications say:** for how long, never which Mac or what for.

## Built, never launched

- CI and agents build the Mac app and never launch it. It would load that Mac's own device key.
- `MacShotsTests`, which pictures it, runs only on a Mac set aside for it.
- On the Mac mini, every on-screen Apple run, CI's included, takes one lock: `apps/apple/scripts/ui-lock.sh`.
