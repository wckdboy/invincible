# Invincible for Android

A native client for an Invincible node: Kotlin and Jetpack Compose, Android's own components with Invincible's look, as
the Apple app is Apple's. It pairs the way the web app and the Apple app do and signs every request the way
`packages/core` verifies it, with a device key made in the phone's secure hardware (the Keystore: StrongBox where the
phone has one) that never leaves it. It came from the system Invincible succeeds as it was redesigned on 26 November
2026, at parity with the iPhone's (docs/ARCHITECTURE.md §10), and is Invincible's own: application ID
`sh.invincible.bot` (a debug build is `sh.invincible.bot.debug`), the `invincible:` scheme, its Keystore alias
`sh.invincible.bot.device-key`, its own notification channels, preferences and UnifiedPush registration, so it installs
beside the app it succeeds until the cutover.

It's small on purpose: it carries no pictures of the agents, which it draws itself, and needs no Google services. Every
orb is a field, lines of force round a dark core (`core/Field.kt`, `core/FieldOrb.kt`, drawn by `ui/Field.kt`), the web
app's `lib/field.ts` and `lib/field-orb.ts`, held to them by the parity vectors' `field` section. The primary's is in
gold with its beam of light along its axis, its embers drifting while it works; each agent's is in the colour you chose
for it or the one of 24 its handle picks (`core/Avatar.kt`, core's `avatar.ts`). Where orbs are many they are still; the
one in focus moves only while something is going on, and never while the phone's animations are off. In the light theme
a field is ink on paper. Its launcher icon is the I-beam (`scripts/brand.ts --png` writes its adaptive and themed
layers), and its sidebar begins with the mark and the INVINCIBLE wordmark.

It opens on the primary, the one agent you talk to, named by the node ("Invincible" until you name it: `core/Primary.kt`),
with no tab bar: Home (`ui/Home.kt`) is its orb, its name, the line at a glance and "…" for everything else, then what
needs you with each answer in place, the work by attention, and its message box docked. A task opens as a thread of its
own (`ui/TaskScreen.kt`). A tablet (720 dp and wider) has the panes: the sidebar (`ui/Sidebar.kt`) beside the page.

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
agents' rows, the orbs and how each mood moves, the work by attention, a task's steps, and every answer block.

## Running it against a throwaway node

The Apple app's dev node serves this app too (a temp home, stand-in models, loopback only). An emulator reaches its
host's loopback through `adb reverse`:

```sh
bun apps/apple/scripts/dev-node.ts --dir /tmp/invincible-dev      # from the repository's root; prints the invite link
adb reverse tcp:<port> tcp:<port>                                 # the port in the link, and the one before it
```

Paste the link into the app, press Ask to join, compare the codes, then approve: `echo <code> > /tmp/invincible-dev/approve`.
Plain HTTP is allowed only to this phone itself or an emulator's host (`network_security.xml`); a real node is reached
over HTTPS, its `tailscale serve` address. A freshly made emulator can boot with its clock behind the Mac's, and the node
then refuses its signed requests: set its time (`adb shell cmd time_detector set_time_state_for_tests …`) before pairing.
