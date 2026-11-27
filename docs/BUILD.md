# Build

The Mac app's Build window (`apps/apple/Invincible/Mac/BuildWindow.swift`) is a workbench with the primary. Your
projects are down its side, each with its threads; beside a thread are what it changed in the project's checkout and a
terminal there. It's on the Mac alone, and everything in it happens in the primary's own computer (docs/AGENTS.md).

## The window

- **Open it** with File ▸ Build with Invincible (⇧⌘B), or Build in the sidebar, under Home. It needs the Mac paired.
- **A project** is a repository it works on: a name, its repository and your instructions (New Project). Its checkout is
  `/work/projects/<id>` in its computer (core's `projectCheckout`); with no repository, it starts one there.
- **A thread** is a kept chat in that project, one for each piece of work (New Thread). Each answer there is told the
  project, its repository, your instructions and up to ten of its memories, and that its checkout is there: to work on a
  branch of its own for each piece of work, and to leave its changes uncommitted until you ask. The chat is its usual
  one, with the queue, steering and the composer; the model menu picks its usual models or any on the roster.
- **Changes** (⌘D) is the checkout's diff since its last commit, new files too, read with the repository's own
  configuration held off and within `/work` alone; **Files** is its folder. Both only read (`teamChanges`, `teamFiles`,
  `teamFile`).
- **The branch menu** lists its branches and New Branch… (started where it stands, with what isn't committed carried
  over); Set Up Checkout clones its repository the first time. **Commit** takes everything changed or new, with your
  message.
- **The terminal** (⌘J) is a shell in its computer, in the checkout: one of the node's terminals, four at most, each
  closed after 15 minutes with nobody at it.
- **No computer yet:** the window says so, and Make Its Computer makes one.

## Under it

- Four routes, each `sandbox` and yours alone (an agent or a node is refused): `projectGit`, `projectBranch`,
  `projectCommit` and `projectClone` (`packages/core/src/api.ts`). Each runs a fixed script in its computer on whichever
  node that is, its arguments passed as they are, never through a shell (`packages/node/src/project-git.ts`).
- The CLI has the same: `invincible project git|changes|clone <id>`, `project branch <id> <name> [--new]` and
  `project commit <id> --message "…"`.
- What each part needs: the projects `mind:read`, a thread `chat`, a new project `brain:write`, the checkout and the
  terminal `sandbox`, a computer `fleet:admin`. A newly paired device holds them all.

## Not yet

- No push, pull, merge or pull request: what it commits stays in the checkout.
- One checkout per project, so its threads share one branch at a time.
- A commit runs the repository's own hooks, in its computer: only Changes holds the repository's configuration off.
- The terminal opens only when its computer is on the node this Mac is paired with; terminals aren't relayed.
- The iPhone, the iPad, the web and Android have no Build. The web has Projects, and its computer's sheet in the chat.
