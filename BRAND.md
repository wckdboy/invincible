# Brand

Invincible and Autobot are two tools from one lab, [WCKD](https://wckd.ai). The whole family
(WCKD, Sovware, Autobot, Invincible, Omnie, Nightfall) shares one kit: its source is
[`brand/kit.json`](https://github.com/wckdboy/autobot-www/blob/main/brand/kit.json) in the
sites' repository, and each site shows its version at `/brand/`. This file is the product side
of it. Each has its
own color and its own job; everything else is shared, so they read as one lab's work wherever
they appear: a terminal, a phone, a README, a web page.

This file is the reference. The Autobot app keeps the same rules in
`shared/design/tokens.json`; the terminal palette lives in
[`crates/invincible/src/brand.rs`](crates/invincible/src/brand.rs), used by both CLIs.

## The two products

| | Invincible | Autobot |
| --- | --- | --- |
| What it is | The node you own: a gateway that routes, redacts, receipts and audits every model call | The agent: on your phone, and on your machine through the node |
| Signal | **Signal orange** `#FF8A1E`, the same on ink and on paper | **Purple** `#7C5CFF`, the same on ink and on paper |
| Character | Calm infrastructure: tables, receipts, states | A capable colleague: conversation, work in progress, questions |
| Symbol | a pixel lowercase **i** | a pixel lowercase **a** |
| Wordmark | the i, then `invincible` | the a, then `autobot` |

Orange and purple are a pair on purpose: complements, opposite each other on the wheel, the same
weight, both on the same warm paper. Invincible is the warm one (the node, steady, always on),
Autobot the cool one (the agent, curious). A warning is yellow and an error red, so neither
product's color ever means "something is wrong". Code in a terminal is sand, a warm neutral.

The signals are vivid on purpose (high saturation, high brightness) and used only for marks: the
symbol, the prompt, focus, selection, a running step. Text is never in the signal. Where an app
needs readable purple for a button or a link, it uses lilac `#9373FF` on ink and `#5A36E6` on
paper, both above 4.5:1 on every surface.

## What they share

- **Neutrals.** Ink `#121211`, paper `#EFEAE2`, ash `#8E8A84` for what is secondary, and a fainter
  ash `#6E6A64` for structure (gutters, rules, hints). Almost everything is in these.
- **Type.** JetBrains Mono for anything a machine says (commands, paths, ids, numbers, labels,
  the wordmarks); the platform's sans for prose and headings.
- **The symbols.** A lowercase letter drawn in pixels, in the product's signal: an **a** for
  Autobot (6 × 6), an **i** for Invincible (2 × 6). Two-pixel strokes, square corners, nothing
  else: the one pixel touch in a functional system. They are the app icons (the symbol on white),
  the wordmarks' marks, and in a terminal three rows of half blocks beside the header.
  In running text a small square `■` in the signal stands for them, and the names are plain:
  Invincible, Autobot.
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
 ▀▀▀█▄  autobot 0.0.9 · via invincible
▄█▀▀██    model      claude-sonnet (cloud)
▀█▄▄██    approvals  edits
          project    ~/src/app  main  AGENTS.md

  tip: type while the agent works to steer it; esc stops the turn

› fix the failing test

▪ Search parse_header
  └ 3 matches in 2 files
▪ Run cargo test -p parser
  │ test result: FAILED. 41 passed; 1 failed
  └ exit 101
▪ Change src/header.rs
       2 -     let len = buf[0] as usize;
       2 +     let len = usize::from(buf[0]);
  └ +1 −1

  ─ claude-sonnet (cloud) · 3 tool calls · 18.2k in · 412 out · 9.4s

╭──────────────────────────────────────────────────────────────────────────╮
│ › ask for a change, / for commands, @ to attach a file                   │
╰──────────────────────────────────────────────────────────────────────────╯
  claude-sonnet (cloud) · approvals edits     / commands · @ files · ! shell
```

- First lines: the symbol in half blocks (with color) beside `name version`, then quiet
  `label  value` rows; without color, `■ name version`.
- `▪` (a smaller square) starts each step; `│` and `└` hang what it gave back, in faint ash.
  Outputs are short: the last lines of a command and its exit code, `… N more lines` for the
  rest. Diffs carry line numbers, added and removed lines in their muted colors.
- The prompt `›` and the symbol are the only signal-colored characters at rest. The signal also
  marks what is happening or wants you now, and nothing else: the spinner (a pixel going round a
  square, `▖ ▘ ▝ ▗`, beside the running step and its seconds), the `■` of a question, the chosen
  row of a list. Never a paragraph.
- Interactive: the scrollback stays the terminal's own (no alternate screen). Only the bottom is
  drawn in place: what is happening, then the composer in a rounded box of faint ash, then one
  status line (model, approvals, project and branch, context, tokens on the left; what the keys
  do now on the right). A question is a card above the composer: `■ title`, what it is about
  hanging under it, and `└ y yes   a always, this session   n no   e no, and say what instead`.
  A picker (`/model`, `/resume` alone) and the `/` and `@` lists sit under the composer: the
  chosen row marked `›` in the signal, the rest ash, a faint count and keys last. Searching what
  was sent (ctrl+r) turns the status line into `search: query` (the query bold) with its keys on
  the right. What stands in for something in the composer is quieter than what is typed, in
  ash: a folded paste `[pasted 120 lines]`, an image `[image 1: shot.png 1280×720]`; in the `@`
  list an image file carries a faint `image` beside it.
- The terminal is told, never shown: the window title `autobot · <project>` (the old one put
  back after), a notification (OSC 9, else the bell) only when a long turn ends or a question
  waits and the window is not in front, the clipboard by OSC 52.
- Answers are Markdown, wrapped to the width: bold headings, `•` lists with hanging indents,
  `▎` quotes, aligned tables, code in sand, code blocks framed `╭── lang ──` … `╰────` with a
  light tint (keywords, strings, numbers; comments faint).
- `─ model · N tool calls · in · out · time` closes each turn, in faint ash.
- Truecolor when the terminal says so (`COLORTERM`), the nearest 256-color otherwise, nothing
  when output is not a terminal or `NO_COLOR` is set. Without a terminal there is no composer
  or spinner: plain lines in, plain lines out. Errors print as `✗ message` on a terminal and
  `invincible: message` in logs and scripts.

## In apps and on the web

- Dark is ink, light is paper; the signal is the only saturated color on either.
- Surfaces are flat. Hairline rules (`#2F2F2E` on ink, `#CFC8BC` on paper) instead of shadows;
  corners small (4–8 px) or none.
- One accent element per view. No halftones, no textures, no illustration: the pixel symbols
  are the only ornament.
- Autobot's screens about the node ("My node", receipts from it) carry Invincible's orange i,
  so the user sees which product is speaking.
- Files: SVG wordmarks for paper (`-light`) and ink (`-dark`), the symbols alone
  (`*-symbol-*`), and 1024 px app icons (`*-icon.svg`) in `assets/brand/`.

## Writing the names

- `Invincible`, `Autobot`, `Sovware`: capitalized in prose, lowercase in the wordmark and in
  commands.
- "the node" for an Invincible install; "the agent" for Autobot working.
- No taglines in product UI. On the web: Invincible, "the node you own"; Autobot, "private AI on
  your phone and your machine".
