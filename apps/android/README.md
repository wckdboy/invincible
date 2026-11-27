# Invincible for Android

A native client for an Invincible node: Kotlin and Jetpack Compose, Android's own components with Invincible's look, as
the Apple app is Apple's. It pairs the way the web app and the Apple app do and signs every request the way
`packages/core` verifies it, with a device key made in the phone's secure hardware (the Keystore: StrongBox where the
phone has one) that never leaves it. It came from the system Invincible succeeds as it was redesigned on 26 November
2026, at parity with the iPhone's (docs/ARCHITECTURE.md §10), and is Invincible's own: application ID
`sh.invincible.bot` (a debug build is `sh.invincible.bot.debug`), the `invincible:` scheme, its Keystore alias
`sh.invincible.bot.device-key`, its own notification channels, preferences and UnifiedPush registration, so it installs
beside the app it succeeds until the cutover.

It's small on purpose: it carries no pictures of the agents, which it draws itself, and needs no Google services. Its
look is monochrome (`ui/Theme.kt`, as the Apple app's Brand.swift): black, white and greys, red only for what went
wrong, colour kept for the agents. The primary is the I-beam in one ink (`core/IBeam.kt`, drawn by `ui/Mark.kt`, held to
`scripts/mark.ts` by the vectors' `mark`), as the launcher icon is (`scripts/brand.ts --png` writes its layers), and on
a tile of its own where the primary is shown, in ink or, as Settings has it, in pearl glass. Each agent is its glass:
one of 22 shapes in one of eight colour ramps (`core/Glass.kt`, its numbers in `core/GlassData.kt`, core's `glass.ts`;
drawn by `ui/GlassView.kt`, each shape, ramp, size and page drawn once and kept; held to the vectors' `glass` by
`GlassTest`), its state a dot cut out of its corner beside its word. Only a working agent's light moves, and only on its
own page: breathing, 15 frames a second while the app is in front, never while the phone's animations are off. In rows
it is still, as each breath is a frame of the app's own work (`GlassBreathTest`).

While it's on screen it keeps the node's live stream open (`core/LiveLink.kt`: the web's `lib/live-link.ts`, the
iPhone's LiveLink.swift) and reads again only what the stream says changed, so at rest it asks the node nothing; a link
silent for three of the node's beats is said lost at once, and a change of network opens a fresh stream.

An agent's screen (`ui/DesktopScreen.kt`; its page's Its VM, then Its screen) is live where its VM's desktop streams:
the node's stream of it (`core/NodeClient.kt`'s `frames`, read whole as its bytes come by `core/DesktopStream.kt`), each
frame handed to MediaCodec, the phone's own H.264 decoder, and drawn on a SurfaceView as it comes
(`ui/DesktopDecoder.kt`), while it is on screen and the app is in front. It is watched again after an end, its last
frame kept meanwhile, and given up for a picture every two seconds after four ends in a row or a refusal (never a node that
didn't answer), or after falling behind three times in a row, each within 30 s of the last (at most 20 frames wait to be
decoded: past that the stream ends and starts again from a keyframe), as the web app and the iPhone do (the vectors' `desktopStream`; `core/DesktopWatch.kt`, tested on
stand-in streams). A tap clicks there and brings back no picture; Take over and Give back
sit under it from its first frame, the row saying until when by the clock. On an emulator its decoder
(`c2.goldfish.h264.decoder`) gives back each frame of the glass page's recording with the pixels it was drawn with.

It opens on the primary's conversation (the owner's word, 27 November 2026: "something like t3code on desktop, and
openmausbot/grokbot on mobile"), the one agent you talk to, named by the node ("Invincible" until you name it:
`core/Primary.kt`), with almost no chrome: the roster's button, its name and one menu, and a big message box at its foot.
The roster (`ui/RosterList.kt`) is a drawer from that button or the left edge (`ui/Drawer.kt`): what needs you with its
one count, your agent, each agent with its mark and its latest line, the rooms, and at its foot Work, Settings and
everything else ("…"). An agent's timeline (`ui/AgentScreen.kt`) lists its tasks as quiet rows, a card only where one
offers you an answer (Start it, Ship it, Resume), and has the same message box. Work (`ui/Home.kt`, the roster's foot) is
what needs you (three decisions, each with its one answer in place, counted once everywhere) and the work by proof
(Working, Proven, Failed, the rest folded). Needs you (`ui/InboxScreen.kt`: Work's "N more", or the roster) is every one
of those decisions as the same rows under the one count, then what was noticed for you, news counted nowhere; a tap opens
its card in a sheet. A task opens as a thread of its own (`ui/TaskScreen.kt`), its verdict as its proof allows (Proven,
Reviewed, not proven, Failed · gate 2…). A tablet (600 dp and wider) has the roster as a sidebar (`ui/Sidebar.kt`)
beside the page. `invincible://task/<id>`,
`/agent/<handle>`, `/approval/<id>` and `/chat/<id>` open their place, and only navigate (`core/Links.kt`). While your
agent answers, the chat's box stays open to steer it or queue what's next, and a running task can be steered.

**Notifications** come at once through a UnifiedPush distributor of yours (ntfy, Sunup), encrypted to this phone so its
push server can't read them; with none, the phone collects them from the node over its own signed connection, every
fifteen minutes or so as Android allows and each time the app comes to the front. Collecting goes on beside a
distributor too: what its server refuses (Android may not let a distributor connect from the background, and ntfy's
then answers 507) is kept on the node for this phone, and Settings says why. A tap opens the very place: a task's own
thread, the chat, Needs you. An approval carries Approve… (its own card, the whole request in front of you) and
Decline, a task whose work can be shipped carries Ship it…, and each works only behind the phone's unlock. One about
what the app shows that moment comes without a sound or a pop-up. On an emulator against the dev node, through
ntfy.sh: 98–346 ms from the node to the phone (median 176 ms, five tests).

What it keeps on the phone: its pairing, its device key (in the Keystore, never readable), your notification choices,
and the last team it saw, so it shows your agents at once however slow the connection (`app/KeptTable.kt`): only what
the rows read, never an agent's instructions or a task's brief, in the app's own storage, never backed up, and replaced
by the node's first answer. Forgetting the node deletes it.

Needs JDK 17 and the Android SDK (platform 37, build tools); Gradle comes with the wrapper (its checksum pinned).

```sh
cd apps/android
./gradlew testDebugUnitTest        # against apps/apple's parity vectors, and the rest of its pure logic
./gradlew assembleDebug            # app/build/outputs/apk/debug/app-debug.apk (sh.invincible.bot.debug)
scripts/make-key.sh                # once, the owner's: the release key, outside the repository, its password in the keychain
scripts/release.sh                 # the owner's: build/release/Invincible-<build>.apk, tested, shrunk by R8, signed, verified
```

The JVM tests read `apps/apple/InvincibleTests/Fixtures/core-vectors.json` where it is (`bun apps/apple/scripts/vectors.ts`
writes it from this repository's `packages/core` and `apps/web/src/lib`, and CI checks it), so this app is held to the
same bytes as the Apple app: request signing, the device id, canonical JSON, invites, the pairing proofs and codes, the
agents' rows, their marks, the work by attention, a task's steps and verdict, the message box's words, and every answer
block. `bun apps/android/scripts/perf.ts --front http://127.0.0.1:<port>` holds it to its performance budgets
(`perf/Budgets.json`) on an emulator against the dev node below: a limit over fails, a target missed is said.

## Running it against a throwaway node

The Apple app's dev node serves this app too (a temp home, stand-in models, loopback only; with `--desktop-frames
<file>`, Operator's screen is live). An emulator reaches its host's loopback through `adb reverse`:

```sh
bun apps/apple/scripts/dev-node.ts --dir /tmp/invincible-dev      # from the repository's root; prints the invite link
adb reverse tcp:<port> tcp:<port>                                 # the port in the link, and the one before it
```

Paste the link into the app, press Ask to join, compare the codes, then approve: `echo <code> > /tmp/invincible-dev/approve`.
Plain HTTP is allowed only to this phone itself or an emulator's host (`network_security.xml`); a real node is reached
over HTTPS, its `tailscale serve` address. A freshly made emulator can boot with its clock behind the Mac's, and the node
then refuses its signed requests: set its time (`adb shell cmd time_detector set_time_state_for_tests …`) before pairing.
