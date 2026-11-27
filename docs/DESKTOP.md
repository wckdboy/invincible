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
  - **deskd** (`deskd.py`): the one process that holds the desktop. It is reached only through sockets in a directory
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
- The apps on real devices: the decoding was run on simulators, an emulator and a Mac, and both phone apps were watched
  live against a dev node in a simulator and an emulator. No iPhone, iPad or Android phone, nor the Mac app's own live
  screen.
- The iPad's layout of the agent's screen.
- H.264's patents: the encoder is built against OpenH264 from source, which carries no patent licence. Which build the
  images carry is the owner's decision (ARCHITECTURE §6).
