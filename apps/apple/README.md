# Invincible for iPhone, iPad and Mac

A SwiftUI client for an Invincible node: Apple's own components, with Invincible's look. It pairs the way the web app
does and signs every request the way `packages/core` verifies it. The Mac's app is the same sources built for macOS
(`InvincibleMac`). They came from the system Invincible succeeds as it was redesigned on 26 November 2026
(docs/ARCHITECTURE.md §10), and are Invincible's own: every word of the old theme is gone, and the vocabulary check
reads these sources too.

On an iPhone it opens on Home, with no tab bar (the owner's ruling; X2's "Home, a bar and a drawer"): the I-beam (a tap
opens the drawer), the primary's name and one line of how things stand (a tap opens its conversation); the agents in a
strip, their marks the only colour on the page, each a tap from its page; what needs you, decisions only, three at most,
each with its one answer in place and the rest a swipe away; the work by proof (Working, Proven, Failed, the rest of
what's done folded), a lazy list however many tasks there are; and at its foot the bar: search and ask, the primary's
message box, a task to give (`Invincible/UI/HomeView.swift`, `HomeParts.swift`). The drawer (`UI/Drawer.swift`: the
I-beam, or a swipe from the left edge) holds a new chat and your latest five, what needs you, the agents, all chats, keys,
connectors and Settings, so every place is two taps from Home. A task opens as a thread of its own (`UI/TaskView.swift`:
the brief, the work folded, the proof card apart from the agent's words, its details in a sheet). A notification, or an
`invincible://` link (`task/<id>`, `agent/<handle>`, `approval/<id>`, `chat/<id>`), opens its place over Home; one about
what the screen shows is told only in the list, and a task's Ship it asks Face ID first. Every screen beyond Home is
held to Home's bar (I10): its title in SF Pro Display bold on one type scale (`UI/Page.swift`, `Typeset`), sections
named in small capitals over rows split by hairlines (no cards), a state as a still dot with its word, the verdict said
once (the agent's bare "Verified." is never shown beside its proof), one answer in full a screen and the rest in its
menu or a swipe, and Dynamic Type to the largest accessibility size without clipping. Needs you is Home's decisions in
full, with what was noticed below them, counted nowhere. While the primary answers, its chat's message box stays open:
Steer and Queue beside Stop (Return does the one Settings → Chat chose), what you queued above the box with Send now,
Edit and Remove, a held queue saying why with Resume, and a side question asked apart from its menu or with `/btw …`
(`UI/ChatQueue.swift`, the web's words through the vectors' `composer`). While an agent's task runs, its thread's box
steers it: Steer this task and Queue for after it over the box, Return again the one Settings → Chat chose, what you
said on its way to it above the box until its run takes it, then in its trail as yours where it was taken, what an
ended task never took, and its proof saying what its review judged against (`Core/Steer.swift`, the vectors' `steer`;
`TaskSteerTests` taps it against the dev node). An iPad's and a Mac's window are three panes:
the mark and the INVINCIBLE wordmark at the head of a sidebar of the work by attention (`UI/Places.swift`), the place
chosen, and a task's details beside it; ⌘K searches or asks. A tap anywhere but a field closes the keyboard
(`KeyboardCloser`).

The app keeps up with its node over its live stream (`Node/LiveLink.swift`, the web app's lib/live-link.ts ported and
held to its cases): nothing is asked while nothing changes, a change is read within a moment of the node saying so, a
link silent for three of the node's beats is taken for dead and opened again, and a change of network opens a fresh one
at once (`Node/PathWatch.swift`). Each is opened from where the last left off, so a renewal reads only what changed
meanwhile, and a read that got no answer is owed until it does: a stall costs the stream's one request
(`PerfTests.testRequestsThroughAStall`). Home says "Reconnecting" in one line while it is down: a link up a moment ago
is down only if it isn't up again within three seconds of going, so a fresh one that fails at once between networks
says nothing (the vectors' `live.links`, which the web app, this app and Android's play alike).

**An agent's screen** (`UI/AgentScreenView.swift`; its menu's Its screen) is live where its VM's desktop streams (C1):
the node's stream of it (`POST /api/team/desktop/stream`, read whole as its bytes come by `Core/DesktopStream.swift`),
each frame decoded as it comes by VideoToolbox off the main actor (`Core/DesktopVideo.swift`'s DesktopDecoding) and
shown as its own IOSurface, with no copy (`UI/DesktopLive.swift`), while it is on screen and the app is in front. A stream that ends is watched again a little
later each time (0.5, 1, 2 and 4 s), its last frame kept meanwhile; after four ends in a row, or a refusal (an older
node, a VM with no stream), it is a picture every two seconds, as before. A tap clicks there at once and brings back no
picture: the stream shows it. Take over and Give back sit under it from its first frame; your input takes it over too
if no one has it, and the row says until when by the clock, never counting down. It reads the stream as the web app
does (the vectors' `desktopStream`), and `DesktopVideoTests` decodes the glass page's recording
(`InvincibleTests/Fixtures/desktop-glass.frames`) and reads its pixel clock back from each frame.

**The primary's name** is the node's to say: "Invincible" until you name it (`Core/Primary.swift`, from `GET
/api/whoami`'s `primaryName` when a node sends one). Its handle on the wire is `primary`. Where a line is the web app's
own (a room's speaker, "Given to the agents by your agent", a coding plan's line), it says what the web says, held to it
by the parity vectors. The app's words about itself (macOS's permissions, a device's name, notifications) say
"Invincible", whatever the primary is called.

**The look** is monochrome (the owner's word, 26 November 2026): black, white and greys, bold type, the system's own
surfaces; colour is kept for the agents, so they are told apart at a glance, and red for what went wrong, nothing else.
The primary is shown by the I-beam in one ink (`UI/Mark.swift`, a shape held to `scripts/mark.ts` by `MarkTests`), never
a mark and never moving. Each agent is its mark, the Grille (O2, 26 November 2026): a disc in its own colour, one of
eight, cut into slats by two or three slots at its own angle (`Core/AgentMark.swift`, drawn by `UI/AgentMarkView.swift`),
as its node gave it, or, from a node before the marks, the colour chosen for its orb snapped to the eight; held to core's
`agent-mark.ts` by the vectors' `marks` to the last bit (its sines and cosines too, from arithmetic alone). Its state is in
its shape: its top slat in ink when it asks you, its bottom one red and knocked loose when its work failed, pale while
queued, grey while paused. Rows are still; the one you are looking at moves only while its agent works or asks you, and
once as it arrives at done or failed; none moves where the device asks for reduced motion, and nothing is drawn at rest. A state is a still dot beside its word; a task's verdict says what its
proof allows (Proven, Reviewed, not proven, Failed · gate 2), never "Verified" above a warning that its gates proved nothing.

Needs Xcode 27 (Swift 6, the iOS 27 and macOS 27 SDKs) and [XcodeGen](https://github.com/yonaskolb/XcodeGen). It runs on
iOS 26 and later, and on macOS 27.

```sh
cd apps/apple
xcodegen generate                      # writes Invincible.xcodeproj and each app's Info.plist from project.yml (none is committed)
xcodebuild -project Invincible.xcodeproj -scheme Invincible \
  -destination 'platform=iOS Simulator,name=iPhone 17 Pro' -derivedDataPath build test -skip-testing:InvincibleTests/MacShotsTests
xcodebuild -project Invincible.xcodeproj -scheme InvincibleMac -destination 'platform=macOS' -derivedDataPath build build
```

CI runs the first on a simulator made for the run and deleted after, then builds the Mac app without launching it, and
unregisters every app it built from Launch Services (`.github/workflows/ci.yml`, the `apple` job). Don't launch a Mac
build on a Mac whose own device key it would load.

## Beside the app it succeeds

The apps of the system Invincible succeeds stay installed until the cutover, so nothing of these may be theirs:

| | Invincible |
|---|---|
| Bundle IDs | `sh.invincible.bot` (iPhone and iPad; App Store Connect's "Invincible Bot"), its widgets' `sh.invincible.bot.widgets` (the Live Activity), `sh.invincible.bot.mac` (Developer ID, outside the App Store), the tests' `….tests` |
| Push topic | `sh.invincible.bot` (core's `ApplePushKeyInput`), the payload's own part under `invincible`; a Live Activity's `sh.invincible.bot.push-type.liveactivity` |
| Keychain | the device key's tag `sh.invincible.bot.device-key`, the phone's copies of keys under the service `sh.invincible.bot.keys`, a Mac's wrapped key labelled "Invincible: …" |
| Defaults | `sh.invincible.bot.paired-node`, `sh.invincible.bot.mac.place`, `sh.invincible.bot.mac.first-run`, `invincible.awaySeen` (each app's own suite, by its bundle ID) |
| Links | the `invincible:` scheme (`invincible://pair#pair=…`) |
| Notifications | the categories `approval` and `approval-decline`, the node's `APPLE_CATEGORY` (each app registers its own) |
| The Mac | its node's launchd label `sh.invincible.node`, its home `~/.invincible`, its updates from `https://invincible.sh/mac/appcast.xml` |
| App Groups | none |

## Running it against a throwaway node

`scripts/dev-node.ts` starts this repository's node the way `apps/web/measure/first-load.ts` does: a temp home, the file
keystore, a stand-in Docker and stand-in models, on loopback only (never `~/.invincible`). It adds agents named by their
jobs in every state the app shows (Builder at work, Researcher thinking, Writer verified, Coder failed, Reviewer paused,
Operator with a desktop, which proposes a task for your approval), has an agent ask your approval for an outward call,
the primary ask for a key and a rule of yours tell you of a command it ran, and prints a client invite. The simulator
reaches it on 127.0.0.1.

```sh
bun apps/apple/scripts/dev-node.ts --dir /tmp/invincible-dev    # from the repository's root; prints the invite link
```

Paste the link into the app and press Ask to join (on a Mac, opening an `invincible:` link that carries it fills it in
too). The node prints the code the request shows; compare it with the app's, then approve as the node's owner would:
`echo 482913 > /tmp/invincible-dev/approve` (the code, its digits only).

Ask the primary anything with "show" in it, and the stand-in answers with everything an answer can hold: headings, a
list, a quote, a table, code, a chart, figures, a plan's steps, a page and choices to tap. A message with "Take your
time" is never answered, so a turn stays running to leave and come back to. Writer and Coder share a room and answer you
there; Operator's VM has a desktop (its screen shows a browser's blank tab until you open an address, then a page:
`scripts/fixtures/screen-*.jpg`) and a stand-in terminal in the node, never one on this machine. Ask an agent to
"propose" something and its stand-in proposes a task, so its card comes up to approve.

The node lets one app in: give each app a node of its own.

With `--heavy` it holds what a busy fleet does, to use the app hard: ten agents, a hundred more tasks (proven, reviewed
but not proven, failed, queued), long chats with the primary and more approvals waiting. With `--auto-approve` the first
device that asks is let in without a code (the UI tests pair that way). With `--desktop-frames <file>` Operator's screen
is live: a recording of a desktop's stream (core's `desktop-frames.ts`) replayed as its VM's encoder while it is
watched, deskd's sessions stood in for (`bench/desktop/glass-stand-in.ts`), so Take over holds as on a real VM; a
picture of it is its blank tab. The app comes in through a front of the dev
node's own, which counts every request the app sends and, under `/__dev/`, answers the UI tests: the invite, the
requests since a moment, a dead link on demand (nothing goes through either way, as a half-open connection), a poke
(a device asking to join, at once), the fixture's tasks by what they show, and a demo task stepped through for the Live
Activity's pictures (held at its start and at its review until asked on).

## Measured: the performance suite

`InvincibleUITests` uses the app as you would against a dev node with a busy fleet, and holds each number to its budget
in `InvincibleUITests/Budgets.json` (a number over its limit fails the test; where X2's target isn't met yet, its miss is
recorded in every run as an expected failure until it is):

| | Limit | X2's target | Measured, 26 Nov (before → after) |
|---|---|---|---|
| From the app's first line to Home's first frame with what it shows (median of five; the whole launch is reported beside it) | 1.5 s | 0.4 s | the whole: 3.3–3.7 s → 2.0 s launched plainly; the app's part 0.42–0.45 s plainly, 0.83–1.0 s under XCUITest (I9); from its first line as it is now counted, 0.27 s plainly on a quiet Mac and 0.52 s under XCUITest, main and I10 alike (I10) |
| What it asks the node in a minute at rest | 2 | 2 | 144 → 0; 0 (I10) |
| From something needing you on the node to Home counting it (95th percentile) | 0.5 s | 1 s | 4.0–4.3 s → 0.18 s; 0.16–0.21 s (I10) |
| A dead link (the node gone silent) noticed / back once it can be reached | 5 s / 1.5 s | 5 s / 2 s | 63 s / 5.3–6.8 s → 4.0–4.5 s / 0.8 s; 4.2 s / 0.94–1.02 s (I10) |
| CPU at rest on Home | 5 % | 1 % | 14–23 % → 0.0–3.7 %; 0.1 % (I10) |
| Memory at rest on Home | 80 MB | 150 MB | 101–104 MB → 40–41 MB; 42–43 MB (I10) |
| Frames that came late scrolling Home's long list (the limit holds the best of three rounds, the target their median) | 15 ms a second | 5 | 137–145 → 8.8 |

On a simulator Apple's launch metric reports nothing and its scroll metric only a duration, so the app measures those
itself, and only when the suite launches it to be measured (`-InvincibleMeasure YES`; `App/PerfProbe.swift`). Launch is
held from the app's own first line, its `init`, before it reads its key and its kept agents (until I10 those reads were
counted as the platform's): before it, a simulator spends 1.1–1.6 s starting the process (more under XCUITest, whose
libraries go into the app, and on a simulator a device panel's tooling puts its own into), which says nothing of a
device. Launched plainly by the simulator (`scripts/launch-plain.sh <simulator> [launches]`, which prints each launch's
marks), the app's own part is 265–282 ms on the Mac mini's iOS 27.2 simulator while the Mac is quiet (I10: its key +3
ms, its kept agents +11, its root view +87, Home's first body +115, Home on screen +177, usable +272), within X2's 400
ms. While other work holds the Mac's cores every part of it takes about twice as long, the keychain read included, so a
launch is only ever said beside the Mac's load. Under XCUITest it is 0.52 s, so the suite still records the target as
missed. Run it as CI does:

```sh
bun apps/apple/scripts/dev-node.ts --dir /tmp/invincible-dev --heavy --auto-approve &   # writes /tmp/invincible-dev/front.txt
TEST_RUNNER_INVINCIBLE_DEV_NODE=$(cat /tmp/invincible-dev/front.txt) xcodebuild -project Invincible.xcodeproj \
  -scheme Invincible -destination 'platform=iOS Simulator,id=<a simulator of its own>' -derivedDataPath build \
  test -only-testing:InvincibleUITests
```

Without a dev node each UI test says it was skipped, unverified.

## A task's proof on the Lock Screen

A Live Activity and the Dynamic Island (I10; core's `live-activity.ts`): the app starts one when you give a task from the
phone or open one in hand (`App/LiveActivities.swift`), and it shows the agent's mark, still, how the task stands in its
shape, the task's title (given
on the phone: it never goes to Apple), each gate's state, the reviewer when it answers, then the verdict, kept a quarter of
an hour once the task ends. While the app is in front it updates the activity itself from the task's trail
(`TaskActivityState.of`, held to the web lib's `activityOf` by the vectors' `liveActivities`); otherwise the node does,
through Apple's push service: the app hands it the activity's own push token (`POST /api/notify/activity`, `mind:read`, a
paired device's own), and the node sends a `liveactivity` push whenever the team moves and the state changed
(`packages/node/src/apns-send.ts`, `notify.ts`). What it sends is read strictly before it goes: fixed words and counts,
never a title, a goal or an agent's words. A node without the route refuses the token, and the activity is still kept up
from the phone while the app is open; an app without it never asks. The widgets are their own target
(`InvincibleWidgets`, bundle `sh.invincible.bot.widgets`), with the state's type shared from `Core/TaskActivity.swift`.

## Every screen, pictured

`ShotsTests` pictures every iPhone screen against a dev node, in light and dark, at the default text size and at the
largest accessibility size, each an attachment of the run's result bundle (`shot-<n>-<screen>-<look>`); and a task's Live
Activity as it goes, at work and under review in the Dynamic Island (compact and opened) and on the Lock Screen, then
proven, and in a run of its own a gate that failed (`live-<state>-<where>`; an activity that has ended leaves the island).
It runs only when asked, each test alone on a simulator of its own: a fresh one opens on Join, pictured before it pairs,
and a task at work opened in one test starts an activity that would stand in front of the one another pictures. Set the
simulator's appearance first and ask for that one's looks (`TEST_RUNNER_INVINCIBLE_SHOTS=light` or `dark`): XCUITest's
own setting doesn't reach an iOS 27 simulator, whose "dark" pictures came out light.

```sh
xcrun simctl ui <a simulator of its own> appearance dark
TEST_RUNNER_INVINCIBLE_SHOTS=dark TEST_RUNNER_INVINCIBLE_DEV_NODE=$(cat /tmp/invincible-dev/front.txt) xcodebuild \
  -project Invincible.xcodeproj -scheme Invincible -destination 'platform=iOS Simulator,id=<a simulator of its own>' \
  -derivedDataPath build -resultBundlePath shots.xcresult test -only-testing:InvincibleUITests/ShotsTests/testEveryScreen
xcrun xcresulttool export attachments --path shots.xcresult --output-path shots
```

## The iPad and the Mac

The places in a sidebar (`Invincible/UI/Places.swift`, shared by both), the place chosen beside it, and a task's details
in a third pane. Each window keeps its own place across launches; an agent, a room or one of the primary's chats opens in
a window of its own; ⌘N a new chat, ⌥⌘N a new window (iPad), ⌘K a task for the agents, ⌘1 to ⌘4 the places, ⌘, Settings
(Mac), and the agents in the Mac's menu bar. What only one platform has is marked `#if os(iOS)` or `#if os(macOS)`; the
Mac's own views are in `Invincible/Mac` (left out of the iOS target).

A Mac's key is made in the Secure Enclave and kept, wrapped by it, in the login keychain (`Core/DeviceKey.swift`). The
app is also the node: its first run makes a Mac with no `~/.invincible` a node (start a fleet, join yours, or just the
app), and its binary is the node's launcher. An everyday build carries no node, and says so;
`scripts/mac-node-bundle.sh` puts it into a built app and signs it (with the Developer ID for a release).
`scripts/mac-release.sh` makes a release: built, its node bundled, notarized and stapled, the zip signed with the
owner's Sparkle key (the login keychain's account `invincible`), and `apps/site/public/mac/appcast.xml` written for it.
**Invincible's Sparkle key** was made on 26 November 2026 (Sparkle's `generate_keys --account invincible`): its private
half is in the owner's login keychain, its public half in `project.yml`'s `INVINCIBLE_SPARKLE_PUBLIC_KEY`. A build
without that key leaves its updater off.

The Mac's notifications are its own (`Invincible/Mac/MacNotices.swift`): no Apple push service, no entitlement. Turned
on in Settings, the node keeps for the Mac what it would send it, by the rules every device is told by, and the app
collects it over its own signed connection when the live stream says `notify` changed (as the Android app collects),
while it runs, its window or only the agents in the menu bar; coming to the front, it takes what was kept and lets it go,
as the window shows it all. Each is read as strictly as core reads it (`Core/NotifyPayload.swift`, held to the vectors'
`notifyPayload`) and shown as the iPhone is sent it (`App/NoticeAnswers.swift`, shared with the iPhone): its buttons,
thread and sound. Approve… opens its card in the main window, its yes behind Touch ID or the Mac's password; Decline is
answered from the notification, signed by the Mac's key; the Dock's badge is what needs you. Quit, the Mac is told
nothing: the iPhone and the web still are.

`MacShotsTests` pictures the Mac app against a dev node; it launches the Mac app, so it runs only on a Mac set aside for
it, never in CI or on a laptop whose own key the app would load.

## TestFlight

`scripts/testflight.sh` archives the app for devices, signs it for your team (Xcode's automatic signing makes the
distribution certificate and profile with the key, the first time) and uploads it to App Store Connect, where TestFlight
offers it to your testers once Apple has processed it. It needs an App Store Connect API team key with the Admin role
(its `.p8` file, key ID and issuer ID; the script keeps nothing of it), your team id (given when you run it, never
committed), and the app in App Store Connect: "Invincible Bot", bundle ID `sh.invincible.bot`.

```sh
TEAM_ID=… ASC_KEY_ID=… ASC_ISSUER_ID=… ASC_KEY_PATH=/path/to/AuthKey.p8 apps/apple/scripts/testflight.sh
```

Each upload is a new build, numbered by the time (UTC, `yyyymmddHHMM`). `Invincible/PrivacyInfo.xcprivacy` says what the
App Store asks: the app tracks no one and collects nothing, and the one "required reason" API it uses is UserDefaults.

## What the tests are held to

The Swift tests (on iOS and, the same ones, on macOS) read `InvincibleTests/Fixtures/core-vectors.json`: vectors made by
this repository's own `packages/core` and `apps/web/src/lib`, each checked against them before it is written. The
Android app's tests read the same file. After a change to either, write them again; CI checks them:

```sh
bun apps/apple/scripts/vectors.ts           # from the repository's root
bun apps/apple/scripts/vectors.ts --check   # exits 1 if the file isn't what this repository's code makes now
```

## The brand

`bun apps/apple/scripts/brand.ts` writes the app's colours (the ink: black on light, white on dark; what is written on
it; the red of what went wrong) and its icon, the I-beam, from `scripts/mark.ts`, the mark of the web app's and Android's
icons: iOS's tile edge to edge (iOS rounds it), its dark form the mark alone on nothing (iOS backs it itself), its tinted
form that mark in grey, and the Mac's tile at each size. The app's mark inside the app (Settings' About, joining, a Mac's
first run, Home's header, the drawer's head, the sidebar's head) is the I-beam alone in the page's ink (`AppMark`), beside
the INVINCIBLE wordmark (`Wordmark`) where a sidebar begins.
