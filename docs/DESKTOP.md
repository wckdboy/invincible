# The desktop: an agent's screen, watched live and taken over

C1 of [PLAN.md](PLAN.md), as built (27 November 2026). [ARCHITECTURE](ARCHITECTURE.md) §6 says what an agent's
desktop is and how it is worked; [SECURITY](SECURITY.md) says what watching and taking it over defend against, and
what they can't promise; [DESIGN](DESIGN.md) says how the web app shows it. This page says what runs where, the stream's
protocol, how each device watches it, the numbers, and how to try it without a VM.

**State:** on main. Every agent's VM has a desktop unless it was made with none. Its screen is live in the web app,
the iPhone, iPad and Mac app, and the Android app, and `inv desktop` looks at it from a terminal. The picture every two
seconds stays as the fallback. Two of the numbers (glass to glass, and your click to seeing it) wait for a run on a
sandbox host: the harness is built (below).

## What runs where

- **In the agent's VM** (the desktop image, `sandbox/desktop/`):
  - **deskd** (`deskd.py`): the one process that holds the desktop. It starts it on its first use, and stops it when it
    is unused (below). It is reached only through sockets in a directory
    of its own in the VM's `/tmp` (0700, each socket 0600): the agent's, and beside it yours (`<run>.owner.sock`),
    which counts a connection as yours only from the uid the kernel names (`SO_PEERCRED`, uid 1001, never the
    agent's).
  - **`desktop`** (`desktop.c`): the verb the agent and the node speak to deskd with. `desktop --session` is the
    agent's held session; `desktop --owner-session` is yours, opened by the node beside it; `desktop stream` is the
    encoder.
  - **The encoder** (`stream.c`, run as `desktop stream`): H.264 Constrained Baseline (OpenH264, Debian's
    `libopenh264-8`), run only while someone watches.
    It sends 10 frames a second while the screen changes and nothing while it is still; a `fast` on its stdin, which
    your input sends, makes it 25 for 2 s. Each frame is the whole screen with the pointer drawn in, and its capture
    time.
- **On the node that hosts the VM** (`packages/sandbox`):
  - **The sessions** (`desktop-session.ts`, `host.ts`): the agent's and yours, each one held exec into the VM.
  - **The hub** (`desktop-stream.ts`): one encoder a VM, however many of your devices watch. A device that joins
    after the first is sent from a keyframe on; one that falls 1 MB behind is let go; each gets a beat every 1.5 s
    while the screen is still; the encoder's first frame must come within 30 s; it is stopped 2 s after the last
    device goes.
- **On the node you talk to** (`packages/node/src/server.ts`): the routes (below), and, when the VM is on another
  node, the request passed there, signed as itself, and the stream relayed back as it comes.
- **On your devices:**
  - **The web app** (`apps/web/src/views/desktop.ts`, `lib/desktop-stream.ts`): WebCodecs, the codec read from the
    keyframe's SPS, decoding for low latency.
  - **The iPhone, iPad and Mac app** (`apps/apple/Invincible/Core/DesktopStream.swift`, `DesktopVideo.swift`,
    `DesktopWatch.swift`, `UI/DesktopLive.swift`): VideoToolbox, decoding off the main actor; each frame's IOSurface
    is the layer's contents, with no copy.
  - **The Android app** (`core/DesktopStream.kt`, `DesktopWatch.kt`, `ui/DesktopDecoder.kt`): MediaCodec (low latency
    where the phone has it), drawn on a SurfaceView, decoding off the main thread.
  - **`inv desktop <agent>`** ([CLI.md](CLI.md)): a look, never live and never input: the screen's size, whether you
    have it, and with `--out` its picture in a file readable by you alone.

## The stream

- **Its frames** (`packages/core/src/desktop-frames.ts`, held by the parity vectors' `desktopStream`). Each frame is:
  - a 4-byte big-endian length of what follows;
  - a kind: 0 a beat, 1 a keyframe, 2 any other frame. A kind a device doesn't know is passed by, never refused;
  - an 8-byte big-endian time, ms since the epoch: when its screen was captured (a beat's, when it was sent);
  - its payload: the H.264 NAL units, Annex B. A keyframe carries its SPS and PPS; a beat carries nothing.

  A length under the kind and the time, or past 8 MB, is no stream of frames, and is refused. The answer's type is
  `application/vnd.invincible.desktop-frames`.
- **Its routes** (`packages/core/src/api.ts`, scope `sandbox`, an agent always refused):
  - `teamDesktopStream`: the frames as they come;
  - `teamDesktopTake` and `teamDesktopRelease`: take the desktop over, and give it back;
  - `teamDesktop`: a look, or a thing done. While you watch, `picture: false` brings back no picture, only whether
    you have it;
  - each answers whether you have it (`held`).
  
  The node you talk to passes them to the node the VM is on by their twins (`teamDesktopOn`, `teamDesktopStreamOn`,
  `teamDesktopHoldOn`), which answer only you or a full node.

## Taking it over

- **How you take it:** Take over, or your first input there (a click, a key, typing), if no one has it. Whatever you do
  is done under your hold, never beside the agent's. A look takes nothing.
- **While you have it:** the agent's desktop requests wait, 30 s at most, then exit 75, saying the desktop is yours. Its
  looks wait too, so no picture taken while you type reaches its model.
- **How it ends:** Give back; 120 s with no input from you; 15 minutes in all; or the node's session ending. The row
  under the screen says until when, by the clock, changing when the node says so and once at the end: nothing counts
  down.

## Light by default

C1 step 10. An agent whose desktop isn't used costs what an agent without one does.
- **It stops when unused.** deskd stops the desktop as `desktop stop` does (each window asked to close as a person would,
  then the display, the browser and the rest) once it has had, for 10 minutes (`INVINCIBLE_DESKTOP_IDLE`):
  - nothing asked of it but whether it is up, or how to use it (`help`, `status`): any other request of the agent's, from
    any path, and any of the owner's, their looks included, is use;
  - no one holding it: a take-over keeps it up for as long as it lasts;
  - no one watching it: the stream's encoder (`desktop-stream`) runs only while someone watches.
- **It starts again on the next command.** The agent's next command that does something is told, once: "this desktop
  was stopped after 10 minutes with nothing done on it and no one watching, its windows closed as a person closes them;
  this command started it again, a fresh screen (the browser's profile, and what is signed in there, are kept in
  /work)". The node's own `status`, and the owner's look, leave the word for the agent. A command that comes as the
  unused desktop stops is answered too: the deskd that stops holds its lock until it has gone, and one started
  meanwhile leaves at once (one deskd at a time), so the command starts deskd again while it waits, at 1, 2, 4 and 8 s of
  its 20 s (`INVINCIBLE_DESKTOP_WAIT`). Started once, it waited out the 20 s for nothing on a busy machine and said "the
  desktop process did not start" (28 November 2026).
- **Its memory comes with its first use.** An agent's VM is made with 2 GB, desktop or not (core's COMPUTER_START).
  Before the first use that may start its desktop (the agent's command, the owner's look, input or take-over, the
  stream), the node grows it, live, to 4 GB (the sandbox host's `desktopRoom`, through the governor, so within the
  ceiling, and in the ledger). It is never made again for it: where it can't grow (no room under the ceiling, a microVM
  that can't take more), its desktop runs with what it has, its work as it was, the ledger says why, and it is tried
  again a minute later at the soonest. A `desktop` verb given in a shell command counts as well: a look, which runs in
  the agent's shell for its eyes' environment, or a verb inside a longer command. The node reads the verb in the
  shell's words (`desktopVerbIn`) and grows the VM before the command runs. One a file runs out of the node's sight (a
  script that calls `desktop`) starts the desktop without the growing: the VM grows at the next command where the node
  sees a desktop verb.
- **A desktop task's starts as its work begins.** A task whose goal speaks of a browser or a screen (core's
  `looksToNeedAScreen`, the words that give it to an agent with a desktop), or one of whose gates runs `desktop`, has
  its VM run its own `desktop start` as the work begins, beside its first model call, never waited for. Its cold start
  (deskd, its memory, the display, the browser's start) is then behind that call. From the work's start to its first
  page shown, with a first call of 2.6 s (a model call's median), it went from 4.8 to 2.9 s on Kata and from 3.7 to
  2.8 s on runc; with a first call that answers at once, 2.6 to 2.1 s and 1.1 to 1.2 s, within the spread (Ultra, 28
  November 2026, five fresh VMs a case). The start is use like any other, so a desktop never used after it stops when
  unused, as above. No other task's desktop starts early: not one that doesn't look to need a screen, not one on a
  seat (its tool's commands run in the seat's VM, out of the desktop's reach), not another node's (its commands all
  run under the handed helper).
- **Held to** (the desktop suite's `desktop.light.*`, [BENCHMARKS.md](BENCHMARKS.md), to be run on a sandbox host): a
  desktop never started at most +50 MB, with 2 GB given; growing to 4 GB within 1 s, its work as it was; after an idle
  stop, nothing of it left running and the guest's memory back, within 50 MB; started again to its first page within
  2 s, the agent told; started and idle at most +600 MB. What the host gets back of the memory the guest frees is
  measured beside them, and not held: QEMU keeps the pages a guest frees unless the guest reports them to it
  (free-page reporting, a setting of Kata's). The +602 MB the host still held after an idle stop (Ultra, 27 November
  2026) is as measured. Free-page reporting is untested: Kata (4.3.1) takes a configuration only by its shipped names,
  so no scratch one could turn it on beside the node's. The way to it, where a smaller host makes those megabytes
  matter: `reclaim_guest_freed_memory = true` in the node's own config, by a reviewed change to what the deploy writes
  (`scripts/remote-setup.sh`), measured after that deploy, with the deploy as the rollback.

## The hardware tools

C1 step 11. KiCad and FreeCAD on an agent's desktop, a choice per agent as its desktop is.
- **The image** (`sandbox/hardware`, `invincible/desktop-hardware:1`, made from the desktop's): KiCad 9.0.8 from Debian
  trixie-backports (pinned) and trixie's FreeCAD 1.0.0, without recommends (no 3D models, no symbol or footprint
  library), each version checked as it is built, and kipy (kicad-python 0.6.0, made from 9.0.8's API) in a venv of its
  own beside pcbnew's own Python module, first on the PATH of the agent's commands: about 1.9 GB more than the
  desktop's. Its name says desktop, as the desktop's does, so whatever asks whether a VM has one says it has.
- **Chosen** with `invincible agents provision <id> --hardware` (and `--remake --hardware` or `--no-hardware`), the web
  app's **KiCad and FreeCAD** beside **No desktop**, or `hardware` on the routes. A desktop comes with them: taking the
  desktop away takes them too, and a Mac, which makes no desktop, makes none of them. A host whose release is older than
  their image isn't asked. The image is built on its host the first time an agent needs it, or by `invincible sandbox
  build --hardware`, and made again, after the desktop's, at the first start of each release that follows
  ([ARCHITECTURE.md](ARCHITECTURE.md) §6, Sandboxes). An agent's VM keeps the build it was made from until `--remake`
  makes it again; its `/work` stays, with whatever the image put there when that volume was first made. The image before
  b4444ba1 put root's KiCad folders there, but no agent was ever made with it, so nothing needs cleaning.
- **Their first run, done:** as the VM starts, its entrypoint (`hardware-seed`) puts in the agent's own home what isn't
  there yet: KiCad's settings at their schema, with its API server on and its update question answered; its global
  footprint and symbol library tables, empty; and FreeCAD's welcome panel and start page, off. What the agent changes
  after is its own.
- **On the screen:** `desktop app kicad`, `pcbnew`, `eeschema` or `freecad`, with a file of /work, starts them as deskd
  starts the terminal, their windows in its tree for `desktop find`, and with TMPDIR at /tmp, so that KiCad's API server
  makes its socket where kipy looks for it (`/tmp/kicad/api.sock`).
- **The agent is told** (agents' `hardwareBriefing`) to script them first: kicad-cli for every output, its DRC and ERC
  as gates; kipy on the open board editor for an edit; freecadcmd for a part, read back; and their windows only for
  what only a screen does.
- **Held to** (the bench's hardware suite, [BENCHMARKS.md](BENCHMARKS.md), to be run on a sandbox host): by script, each
  within a second and through its gate every time; through the screen, every time, KiCad's Plot within 10 s and
  FreeCAD's STEP export within 20 s; the image at most 6 GB.
- **What a newer KiCad or FreeCAD would take** (read 27 November 2026; nothing built). Neither is in Debian for trixie:
  forky's KiCad 10 and FreeCAD 1.1 need its libc 2.43 and Python 3.14. KiCad 10 waits for a need (an edit kipy can't
  make, or a KiCad that drops pcbnew's SWIG module in a release we must follow); then it is built in a stage of our own
  on trixie, as KiCad's own image is, pinned by its tag's commit (e432beac2668) and a snapshot.debian.org timestamp for
  its build dependencies, the tag's signature checked then, its size (about 356 MiB more installed, mostly WebKitGTK)
  and build time measured on a sandbox host first. FreeCAD 1.1.4 for Linux is an unsigned 820 MB AppImage, held by its
  hash alone: not taken without a need.

## Watching, on each device

The three apps hold to one rule (`apps/web/src/lib/desktop-stream.ts`; the vectors' `desktopStream`; each app's
`DesktopWatch`, tested on stand-in streams):
- **When it is watched:** while the screen is in view and the app is in front. Out of view or behind, the watching ends,
  and it starts afresh when the screen is back, nothing counted.
- **A stream that ends** is watched again a little later each time (0.5, 1, 2 and 4 s), its last frame kept meanwhile.
  After four ends in a row with no frame drawn, it gives way to the picture every two seconds, saying the live picture
  isn't coming through. A frame drawn starts the count again.
- **A refusal** (a 4xx, or 501: an older node, a VM with no stream) gives way to the picture at once, saying nothing.
  A node that didn't answer is no refusal: it is asked again.
- **Falling behind:** at most 20 frames wait to be decoded (`BEHIND`). Past that, the device has fallen behind the
  screen, and the stream is ended and watched again from a fresh keyframe. Three times in a row, each within 30 s of the
  last, and it gives way to the picture too, saying the device can't keep up live. Behinds are counted apart from ends.
- **While it is live,** a thing done asks no picture back, and the picture loop rests.

## The numbers

- **Held to** (the scorecard's desktop suite, [BENCHMARKS.md](BENCHMARKS.md)):
  - at least 10 frames a second while the screen moves;
  - at most 6% of a core per watched VM, the encoder and deskd together;
  - at most 100 kbit/s while it is still;
  - glass to glass at most 250 ms, median, on the tailnet;
  - your click to seeing it at most 200 ms.
- **Measured, 27 November 2026, decoding the glass page's recording** (30 frames of a pixel clock, 1280×800; each
  frame's clock read back from its pixels as it was drawn):
  - VideoToolbox, reading the pixels included: 0.113 s for the 30 frames on the Mac mini, 0.204 s on an iPhone
    simulator and 0.328 s on an iPad simulator (iOS 27.0), each through `DesktopDecoder`; off the main actor, through
    `DesktopDecoding`, 0.264 s on another iPhone simulator;
  - MediaCodec, through the app's own `DesktopDecoder`, on an emulator (Android 16, `c2.goldfish.h264.decoder`): the
    first frame 40–79 ms with the decoder made, then a median of 1.8–2.3 ms a frame, at most 11.4 ms. An emulator's,
    not a phone's.
- **Waiting for a sandbox host:**
  - the stream's own numbers (its frames a second, its kbit/s, the encoder's CPU, each frame from capture to arrival),
    which the desktop suite measures on C0's scenes;
  - glass to glass, and your click to seeing it, measured by the harness (`bench/desktop/glass.ts`, its runbook at its
    top):
    - a page on the VM's screen draws its own time and its clicks as a strip of black and white blocks, checked;
    - a browser on another machine of the tailnet reads the strip back out of each frame the app draws, the clocks
      aligned by the least round trip.

## Trying it without a VM

- **The apps:** `bun apps/apple/scripts/dev-node.ts --desktop-frames <recording>` makes Operator's screen live from a
  recording of a desktop's stream, replayed as its VM's encoder, with deskd's sessions stood in for, so Take over holds
  as on a real VM ([apps/apple/README.md](../apps/apple/README.md)). The Android app pairs with it through `adb reverse`.
- **The web app:** `bun apps/web/measure/first-load.ts --desktop-frames <recording>` shows Rio's desktop live, and
  `--shots` pictures it, live and taken over.
- **The harness:** `bench/desktop/glass-node.ts --stand-in --frames <recording>` runs it end to end on one machine. Its
  numbers measure nothing there: the clock is the recording's.

## What isn't verified yet

- Glass to glass, and your click to seeing it: the harness is built and tried on stand-ins, not yet run on a sandbox
  host.
- Light by default's numbers: the bench's cases are built, and its parts tried without a VM, not yet run on a sandbox
  host.
- The hardware tools: their image isn't built yet (that needs a sandbox host's Docker), nor their suite run; kipy
  0.6.0 against KiCad 9.0.8 is checked by reading their sources, not by a run, and the screen's steps are C0's, through
  deskd's own find.
- The apps on real devices: the decoding was run on simulators, an emulator and a Mac, and both phone apps were watched
  live against a dev node in a simulator and an emulator. No iPhone, iPad or Android phone, nor the Mac app's own live
  screen.
- The iPad's layout of the agent's screen.
- H.264's patents: the encoder is built against OpenH264 from source, which carries no patent licence. Which build the
  images carry is the owner's decision (ARCHITECTURE §6).
