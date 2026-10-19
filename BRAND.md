# Brand

Invincible and Autobot are two tools from one lab, [Sovware](https://sovware.io). Each has its
own color and its own job; everything else is shared, so they read as one lab's work wherever
they appear: a terminal, a phone, a README, a web page.

This file is the reference. The Autobot app keeps the same rules in
`shared/design/tokens.json`; the terminal palette lives in
[`crates/invincible/src/brand.rs`](crates/invincible/src/brand.rs), used by both CLIs.

## The two products

| | Invincible | Autobot |
| --- | --- | --- |
| What it is | The node you own: a gateway that routes, redacts, receipts and audits every model call | The agent: on your phone, and on your machine through the node |
| Signal | **Orange** `#9E4C0C` (text on paper) · `#C2651A` (marks on paper) · `#F0882E` (on ink) | **Lilac** `#5444BA` (on paper) · `#A99BF5` (on ink) |
| Character | Calm infrastructure: tables, receipts, states | A capable colleague: conversation, work in progress, questions |
| Wordmark | `■ invincible` | `■ autobot` |
| Mascot | none: only the mark | Pip (below) |

Orange and lilac are a pair on purpose: complements, opposite each other on the wheel, the same
weight, both on the same warm paper. Invincible is the warm one (the node, steady, always on),
Autobot the cool one (the agent, curious). A warning is yellow and an error red, so neither
product's color ever means "something is wrong". Code in a terminal is sand, a warm neutral.

## What they share

- **Neutrals.** Ink `#121211`, paper `#EFEAE2`, ash `#8E8A84` for what is secondary, and a fainter
  ash `#6E6A64` for structure (gutters, rules, hints). Almost everything is in these.
- **Type.** JetBrains Mono for anything a machine says (commands, paths, ids, numbers, labels);
  the platform's sans for prose. Antonio, the condensed display face, only for the wordmark and
  a page's single headline.
- **The mark.** A small solid square, `■`, in the product's signal, before the lowercase name.
  In running text the name is plain: Invincible, Autobot.
- **States.** Words first, then a plain glyph: `✓` in ash when fine, `!` in yellow `#E2C044` when
  it needs a look, `✗` in the error color `#FF6A47` when it failed. Color never carries meaning
  alone, so a screen reader, a log file and `NO_COLOR` lose nothing.
- **The signal is rare.** It marks the product, the prompt, and what needs you now (an approval,
  a running step, the primary action). Not headings, not bullets, not decoration. If more than a
  few things on a screen are in the signal, most of them should not be.
- **Voice.** Short plain sentences that say what happened and what to do next. No exclamation
  marks, no emoji, no superlatives. Numbers and paths over adjectives. A limit is stated as a
  limit ("not yet run on that hardware"), never hidden.

## In a terminal

Both CLIs and the installer speak one grammar:

```
■ autobot 0.0.9 · via invincible
  model      claude-sonnet (cloud)
  approvals  edits
  project    ~/src/app  main  AGENTS.md

› fix the failing test

▪ Search parse_header
  └ 3 matches in 2 files
▪ Run cargo test -p parser
  │ test result: FAILED. 41 passed; 1 failed
  └ exit 101
▪ Change src/header.rs
    -    let len = buf[0] as usize;
    +    let len = usize::from(buf[0]);
  └ +1 −1

  ─ claude-sonnet (cloud) · 3 tool calls · 18.2k in · 412 out · 9.4s
```

- First line: `■ name version`, then quiet `label  value` rows.
- `▪` (a smaller square) starts each step; `│` and `└` hang what it gave back, in faint ash.
- The prompt `›` and the mark are the only signal-colored characters at rest.
- Truecolor when the terminal says so (`COLORTERM`), the nearest 256-color otherwise, nothing
  when output is not a terminal or `NO_COLOR` is set. Errors print as `✗ message` on a terminal
  and `invincible: message` in logs and scripts.

## In apps and on the web

- Dark is ink, light is paper; the signal is the only saturated color on either.
- Surfaces are flat. Hairline rules (`#2F2F2E` on ink, `#CFC8BC` on paper) instead of shadows;
  corners small (4–8 px) or none.
- One accent element per view. Halftones and registration marks are print references: at most one
  per page, never behind text.
- Autobot's screens about the node ("My node", receipts from it) use Invincible's orange for
  the node's mark, so the user sees which product is speaking.

## The mascot

> In design: Pip is being replaced by **Buddy and its drone**, a lilac-plated robot on a charcoal
> frame with one white eye, and a small orange drone beside it (the node). Pip stays here until
> Buddy's sprites land.

Autobot's mascot is **Pip**: a small capsule robot, drawn on a 14×14 grid so it works as pixel
art and in a terminal (half blocks, two pixels to a cell; the 7×6 mini sits beside `autobot`'s
header). Its face and its antenna carry the feeling; the body never changes.

```
..............
........RR....   R  antenna light: lilac; orange when it works on your node;
........S.....      dark (O) when something failed
.......S......   S  stem, ash; bent, never straight
...BBBBBBBB...   B  body: #C9C3BA on ink, #3A3632 on paper
..BBBBBBBBBB..   K  visor: ink
.BBKKKKKKKKBB.   E  eyes: bone, one pixel wide, two tall, close together
.BBKKEKKEKKBB.   C  cheeks: the light's color, half into the visor; only when content
.BBKKEKKEKKBB.
.BBKCKKKKCKBB.
..BBBBBBBBBB..
...BBBBBBBB...
....BB..BB....
..............
```

- `idle`, `blink`: eyes open and shut, cheeks on.
- `happy` (done): `^ ^` eyes, cheeks on, the light sparks.
- `think`: eyes up and to the side, the antenna tilts, no cheeks.
- `work`: eyes down (reading), no cheeks.
- `oops` (failed): small eyes under slanted brows, the antenna droops, the light is off.
- `mini`: for the terminal header.

The light and the cheeks are the only signal pixels. SVGs for ink (`-dark`) and paper (`-light`)
are in [`assets/brand/mascot/`](assets/brand/mascot) (`pip-*`); `pip-on-node-*` has the orange light. Use Pip small: an empty
state, a welcome, the terminal header. Never behind text, never animated for its own sake (a
blink every few seconds at most), and never on Invincible's own surfaces: the node has no
mascot, only its mark.

## Writing the names

- `Invincible`, `Autobot`, `Sovware`: capitalized in prose, lowercase in the wordmark and in
  commands.
- "the node" for an Invincible install; "the agent" for Autobot working.
- No taglines in product UI. On the web: Invincible, "the node you own"; Autobot, "private AI on
  your phone and your machine".
