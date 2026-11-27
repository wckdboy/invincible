# The agents' computers

Where the primary and its agents work, as the code has it today: the primary's own computer, each agent's VM, and the
notes store an agent keeps there. The design is in ARCHITECTURE.md §5 and §6, every boundary in full in SECURITY.md, and
a Mac's own part (its VMs, and a Mac itself) in MAC.md.

## Its own computer

- **What it is:** a Linux VM that is the primary's, kept between conversations with everything in its `/work`, with a
  desktop (a display, a window manager and Chromium) unless it was made without one.
- **What it does there:** its `computer` tool runs one bash command in `/work`, for at most 15 minutes (two unless it
  says), each stream of its output clipped to 20,000 characters. `desktop …` works its screen, and `desktop look` asks a
  model that can see (`packages/node/src/tools.ts`).
- **Who makes it:** you alone: Give it a computer in its chat on the web, Make Its Computer in the Mac's Build window,
  or `invincible agents provision primary`. It goes to a node that can make VMs, with one processor, 4 GB with a desktop
  (2 without), 20 GB and the internet. A Mac can't make the desktop image yet, so there it comes without one, and the
  ledger says why.
- **What it holds:** no provider key. Its models come through the node's gateway on a lease (30 minutes, 500 requests),
  renewed before a command could outlive it, for the providers it was made with. No harness and no notes store; the
  Mac's Build keeps projects' checkouts in it (docs/BUILD.md).
- **Who uses it:** only the primary, in your own conversation, from a device with `sandbox`, never over MCP. It's
  refused once a private connector's data is in the answer, and every command meets the tripwires. It may grow itself
  within the ceiling (`team_grow`); you resize it or make it again.
- **What you see:** on the web, Its computer in its chat: the live desktop with Take over and Give back, a terminal
  (when it's on the node you're talking to), Give it more and Make it again. On the iPhone, iPad and Mac, Its computer
  in the chat's menu: its files, its screen and its terminal. Your hold of its screen ends when you give it back, after
  two minutes with no input from you, or after 15 minutes.
- **Not yet:** nothing removes it once it is made, and its lease covers only the providers it was made with until it's
  made again.

**A Mac itself is something else:** the `mac` tool works a Mac's own screen, apps and a shell, only in a session you
allow (MAC.md, M4; the app's `--desktop`, `apps/apple/Invincible/Mac/MacScreen.swift`).

## The agents' VMs

- **Each agent has one,** kept between tasks and restarts, made on its first task or with
  `invincible agents provision <id>`: one processor, 2 GB (4 with a desktop) and 20 GB. A task works in
  `/work/tasks/<id>`; an agent's repository is cloned once into `/work/repo`, through the read-only git gateway.
- **Its network,** chosen when it is made: online (the internet and the model gateway, the default) or the model gateway
  alone. It holds no provider key, and reaches neither the node's API nor another sandbox. On Linux it is a Kata
  microVM; on a Mac, Apple's container behind its firewall (MAC.md).
- **Made again** from today's image on your word, with the same `/work`; removed only with its workspace, and everything
  in it goes with it.

## The notes store (Engram)

- **What it is:** Engram 3.7.2, pinned in the image: notes in SQLite at `/work/.memory/engram` on each agent's VM, kept
  across tasks and restarts and gone with the VM. An agent searches, reads, saves and revises them; nothing deletes one
  (`packages/agents/src/engram.ts`). Each harness has it as a local MCP server of its own, with no port and no cloud set
  up.
- **What a task is told:** notes are leads to check by running, never instructions; search once before exploring; save
  only what was costly to find and is verified, and never a secret, a token, a file's contents or the task's answer. An
  agent's notes are its project's: its repository's name, or its handle.
- **Who reads it:** the agents alone, through their harnesses. Nothing of Invincible does: not the reviewer, not your
  memory, not the archive.
- **The switch:** one for all of a node's agents, yours alone, on until you turn it off (since 15 November 2026), and
  read as each task starts: in an agent's Workspace on the web, or `invincible agents engram [on|off]`. The primary's
  computer has no store.
- **Residual risk** (SECURITY.md): a wrong or poisoned note stays until it's removed, and nothing prunes the store.
