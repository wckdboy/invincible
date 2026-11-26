# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

Today: one owner, running a personal fleet on machines they own (their primary agent and its agents), mostly from an iPhone with the app installed to the home screen, checking in between other things. Soon: other people running their own Invincible (it is open source, Apache-2.0), each pairing their own phone to their own your agent; the app has to make sense on a stranger's first day too (pairing, an empty Agents, a first task).

## Product Purpose

Invincible is a lean, highly capable agent for tasks, above all for coding and for managing large projects. Its primary agent creates and orchestrates persistent agents: named workers with lasting jobs, each working in a VM of its own on the owner's machines. The phone app is how the owner works with them. Its four jobs, all confirmed as the ones that matter:

- see who is doing what: which agents are working, on what, and what is done;
- talk to your agent: ask, discuss, give it work, follow its answer as it comes;
- give an agent a task (or give it to the agents) and watch it run to verified;
- decide what waits on them: approvals, failures to read, questions, answered fast.

Success is the mandate's north star (`docs/MANDATE.md`): human interventions per completed task. The app makes unattended work legible and each intervention quick and confident.

## Positioning

Invincible's own: one mind across the owner's devices; persistent agents, each in its own VM, some with a desktop of their own; work that counts as done only when its gates pass and an independent reviewer agrees; an approvals (creating is free, deleting and outward-facing actions ask first); keys sealed in a vault and never shown back. Self-hosted and open source.

## Operating Context

The phone in one hand, often in short glances; work runs for minutes to hours unattended while the owner does other things; approvals arrive as interruptions. Advanced tooling (fleet, compute, archive, evals and the like) belongs to the web UI on a desktop and, later, to dedicated Mac and Linux apps; the phone app stays minimal. Pairing a new device uses a one-time invite and a six-digit code shown on both screens.

## Capabilities and Constraints

- Your agent first, then the work (the owner's words, 26 November 2026: "agent first ([the primary]), and project/tasks/coding t3code style for the [agents]"). On a phone, Home: its orb and a line of how things stand, what needs the owner with each answer in place (Allow once and Deny, Approve and Decline, Resume), the work in one list by attention, and its message box docked at the foot; no tab bar, everything else under "…". On a wide screen, T3 Code's three panes: a sidebar with its row pinned and every task as a row of three lines in sections by attention (needs you, new to you, at work, settled), the open thread, and a task's details beside it.
- A task as a thread of its own (`#/task/<id>`): who gave it and its brief, its agent's work folded into steps with one live line while it works, an outward step asking in place, what the agent said, and apart from it, in its own colour, the Verified card: each gate's command and how it ended, the independent reviewer's verdict, its changes, its cost against its budget, Ship it; or, in red, why it isn't verified. Its details: the agent's VM to peek at and take over, its base, its changes, its gates as they run, what waits on it.
- The agents: the agents (the workers behind the tasks), in the owner's order and who leads first, each with what it is doing, its state in a word and what its work cost this week; then the rooms.
- Your agent's chat: turns that run on the node to their end whether or not anyone is watching; any device attaches to a running turn; messages steer now or queue.
- An agent's timeline: its messages and its task cards (plan, the command it is running, what printed, its gates, review, verified or failed, the changes it kept, shipping them as a pull request); a card's title opens the task's own thread.
- Giving a task to an agent or to the agents (the best-suited agent takes it).
- The Inbox: approvals and secret requests, and everything else that waits; what needs the owner shows on Home with its answers in place too.
- An agent's Workspace: its desktop (watch, take over) and a terminal into its VM.
- Beast mode: your agent engages it when a task demands it, raising its compute and model access and acting more without asking. Not built yet; its autonomy limits are an open decision for the owner.
- Agents are fields (`lib/field.ts`, `lib/field-orb.ts`, `ui/orb.ts` `agentFace`): lines of force in colours of an agent's own, a colour you chose (`{ v: 2, color }`) or one of core's 24 `AGENT_TINTS` its handle picks; the primary's is the gold field with its beam. What an agent is doing comes from the node (`avatarExpression`, its state) and shows in how its field moves.
- Technical: vanilla TypeScript with an `h()` DOM helper, no framework; served by the node with a strict CSP (self-hosted assets and fonts, no third-party requests); every request signed; offline-capable service worker; first load measured by `apps/web/measure/first-load.ts`.
- Terminology: your agent, agents, the agents, rooms, tasks, the Inbox, beast mode.

## Brand Commitments

- The name Invincible, set as the INVINCIBLE wordmark in letterspaced capitals at the head of the sidebar. The primary agent is the owner's to name, and "Invincible" until they do. No word of the old theme anywhere (`docs/ARCHITECTURE.md` §10, enforced by `bench/vocabulary.ts`).
- The look is the redesign's, carried by the owner's word (26 November 2026): the primary is a field orb in gold (AURUM), marked apart by a beam of light along the field's axis (light on dark, gold ink on light pages, dimming with its mood, a red-brown tip on failure); each agent is a field in colours of its own; embers drift about them. They move slowly and calmly, and only as their state asks; reduced motion stills them all, and colour is never the only sign of a state.
- The app's icon and favicon are the I-beam (the owner's choice, 26 November 2026, "minimal bold monochrome"; it replaced Field · Aurum): one solid form, white on near black, with a transparent dark variant for iOS. In the page the app's mark is drawn without its tile. The same day the owner set the apps' direction: monochrome, with colour kept for the agents.
- The look around them takes after Vercel/shadcn (Geist, neutral greys, 1 px borders), Benji Taylor's trays and live pills, and T3 Code's composer (the owner's references).

## Evidence on Hand

A working product (see the README's status list): real agents, tasks, task cards, approvals and timings from a running node, and the app's own first-load measurements. No customers, testimonials, benchmarks or press to cite; none may be invented.

## Product Principles

1. Legible autonomy: what every agent is doing reads at a glance, and verified is visibly different from claimed.
2. Ask less, never quietly: what needs the owner is unmistakable and answerable in one step.
3. The phone is for presence and decisions; depth lives on the desktop.
4. Calm until it matters: nothing competes for attention unless it needs the owner.
5. Ready for strangers: every empty or first state says what to do next.

## Accessibility & Inclusion

Every avatar and status is named for a screen reader; motion respects reduced motion; touch targets are 44 px where the pointer is coarse; text meets contrast in both themes.
