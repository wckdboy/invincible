# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

Today: one owner, running a personal fleet on machines they own (their Galahad and their knights), mostly from an iPhone with the app installed to the home screen, checking in between other things. Soon: other people running their own Galahad (it is open source, Apache-2.0), each pairing their own phone to their own Galahad; the app has to make sense on a stranger's first day too (pairing, an empty Roundtable, a first task).

## Product Purpose

Galahad is a lean, highly capable agent for tasks, above all for coding and for managing large projects. He creates and orchestrates persistent knights: named workers with lasting jobs, each working in a VM of its own on the owner's machines. The phone app is how the owner works with them. Its four jobs, all confirmed as the ones that matter:

- see who is doing what: which knights are working, on what, and what is done;
- talk to Galahad: ask, discuss, give him work, follow his answer as it comes;
- give a knight a task (or give it to the Roundtable) and watch it run to verified;
- decide what waits on them: approvals, failures to read, questions, answered fast.

Success is the mandate's north star (`docs/MANDATE.md`): human interventions per completed task. The app makes unattended work legible and each intervention quick and confident.

## Positioning

Galahad's own: one mind across the owner's devices; persistent knights, each in its own VM, some with a desktop of their own; work that counts as done only when its gates pass and an independent reviewer agrees; an oath gate (creating is free, deleting and outward-facing actions ask first); keys sealed in a vault and never shown back. Self-hosted and open source.

## Operating Context

The phone in one hand, often in short glances; work runs for minutes to hours unattended while the owner does other things; approvals arrive as interruptions. Advanced tooling (fleet, compute, archive, trials and the like) belongs to the web UI on a desktop and, later, to dedicated Mac and Linux apps; the phone app stays minimal. Pairing a new device uses a one-time invite and a six-digit code shown on both screens.

## Capabilities and Constraints

- Galahad first, then the work (the owner's words, 26 November 2026: "agent first (Galahad), and project/tasks/coding t3code style for the knights"). On a phone, Home: his orb and a line of how things stand, what needs the owner with each answer in place (Allow once and Deny, Approve and Decline, Resume), the work in one list by attention, and his message box docked at the foot; no tab bar, everything else under "…". On a wide screen, T3 Code's three panes: a sidebar with his row pinned and every task as a row of three lines in sections by attention (needs you, new to you, at work, settled), the open thread, and a task's details beside it.
- A task as a thread of its own (`#/task/<id>`): who gave it and its brief, its knight's work folded into steps with one live line while it works, an outward step asking in place, what the knight said, and apart from it, in its own colour, the Verified card: each gate's command and how it ended, the independent reviewer's verdict, its changes, its cost against its budget, Ship it; or, in red, why it isn't verified. Its details: the knight's VM to peek at and take over, its base, its changes, its gates as they run, what waits on it.
- The Roundtable: the knights (the workers behind the tasks), in the owner's order and who leads first, each with what it is doing, its state in a word and what its work cost this week; then the rooms.
- Galahad's chat: turns that run on the node to their end whether or not anyone is watching; any device attaches to a running turn; messages steer now or queue.
- A knight's timeline: its messages and its task cards (plan, the command it is running, what printed, its gates, review, verified or failed, the changes it kept, shipping them as a pull request); a card's title opens the task's own thread.
- Giving a task to a knight or to the Roundtable (the best-suited knight takes it).
- The Inbox: approvals and secret requests, and everything else that waits; what needs the owner shows on Home with its answers in place too.
- A knight's Workspace: its desktop (watch, take over) and a terminal into its VM.
- Beast mode: Galahad engages it when a task demands it, raising his compute and model access and acting more without asking. Not built yet; its autonomy limits are an open decision for the owner.
- Knights are orbs of glyphs (`lib/orb-sphere.ts`, `ui/orb.ts` `knightFace`): a colour you chose (`{ v: 2, color }`) or one of core's 24 `KNIGHT_TINTS` its handle picks, its sphere, glyphs and arcs its handle's. What a knight is doing comes from the node (`avatarExpression`, its state) and shows in how its orb moves and its seat's ring.
- Technical: vanilla TypeScript with an `h()` DOM helper, no framework; served by the node with a strict CSP (self-hosted assets and fonts, no third-party requests); every request signed; offline-capable service worker; first load measured by `apps/web/measure/first-load.ts`.
- Terminology: Galahad, knights, the Roundtable, rooms, tasks, the Inbox, beast mode.

## Brand Commitments

- The name Galahad, and the Arthurian vocabulary above.
- Galahad's colours are oxblood, navy and off-white, used as accents only (binding). Oxblood marks what waits on the owner.
- The knights are orbs of glyphs, each its own colour, moving slowly and calmly; Galahad's orb is his state's colour inside the rings of a heads-up display, with a ring of data (the owner's words, 25 November 2026: "custom/procedurally generated colored particle orbs", "glyph and randomness … like Jarvis/Ultron … and my other project Phren", "slow and calming movement"; this replaces the drawings of 14–15 November).
- Galahad's helm, with the oxblood Templar cross, stays his emblem in the app and the website's crest (binding). The app's icon and favicon are Galahad's field in gold: lines of force round a dark core, white-hot where the light strikes and burning copper at the far rim (the owner's choice, 26 November 2026, replacing the Roundtable of 15 November).
- The look around them takes after Vercel/shadcn (Geist, neutral greys, 1 px borders), Benji Taylor's trays and live pills, and T3 Code's composer (the owner's references).

## Evidence on Hand

A working product (see the README's status list): real knights, tasks, task cards, approvals and timings from a running node, and the app's own first-load measurements. No customers, testimonials, benchmarks or press to cite; none may be invented.

## Product Principles

1. Legible autonomy: what every knight is doing reads at a glance, and verified is visibly different from claimed.
2. Ask less, never quietly: what needs the owner is unmistakable and answerable in one step.
3. The phone is for presence and decisions; depth lives on the desktop.
4. Calm until it matters: nothing competes for attention unless it needs the owner.
5. Ready for strangers: every empty or first state says what to do next.

## Accessibility & Inclusion

Every avatar and status is named for a screen reader; motion respects reduced motion; touch targets are 44 px where the pointer is coarse; text meets contrast in both themes.
