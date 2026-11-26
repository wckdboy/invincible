#!/usr/bin/env bun
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { type ArtifactView, type AwayView, b64u, type LookView, type ChatStreamEvent, decodeInvite, encodeQr, type FleetView, type InvestigationView, qrToTerminal, type RouteName, routes, type SandboxView, type ScreenSessionView, type ScreenStatus, type ScreenView, type TeamOutcome, type SlackView, SLACK_APP_MANIFEST, type TelegramView, type TrialView, type QuestionView, plainLine, type LiveEvent } from "@galahad/core";
import { onPlan, planOf, sseData } from "@galahad/brain";
import { requestPairing, signedPost, type SyncPage, waitForApproval } from "@galahad/link";
import { foundFleet, MindStore } from "@galahad/mind";
import { artifactTarget } from "./artifacts.ts";
import { servedOrigin, tailscaleInfo } from "./capabilities.ts";
import { startDaemon } from "./daemon.ts";
import { activeDevicesMatching } from "./devices.ts";
import { loadEnv } from "./env.ts";
import { Home } from "./home.ts";
import { actionCommand, connectorCommand, heartbeatCommand, loopCommand, noticeCommand, orderCommand, selfActionCommand, statusLine } from "./loop-cli.ts";
import { lookTime } from "./looks.ts";
import { BILAG_QUERY } from "./bilag.ts";
import { runMcpServer } from "./mcp.ts";
import { runAcpAgent } from "./acp-agent.ts";
import { buzzCli, buzzDelivery } from "./buzz.ts";
import { archiveCommand } from "./archive-cli.ts";
import { keyAddCommand, keyElsewhereLine } from "./key-cli.ts";
import { skillsCommand } from "./skills-cli.ts";
import { ruleCommand } from "./rule-cli.ts";
import { qampCommand } from "./qamp-cli.ts";
import { computeCommand, parseEffort } from "./compute-cli.ts";
import { checkGates, githubConnector, githubRepo, investigateFromCli, questFromCli, shipBranch } from "./quest-cli.ts";
import { askCommand, questsCommand, queueCommand, queueLines, turnLine, turnsCommand } from "./turn-cli.ts";
import { ABOUT_YOU_TAG, chatStateWords, checkFacts, type MemoryView, type ModelCheck, THINKING_EFFORTS } from "@galahad/core";
import { ShipManifest } from "./ship.ts";
import { BankService } from "./bank/service.ts";
import type { BankStatusView, ConversationSummary, ConversationView, ProjectGitView, ProjectView, ProviderView, TeamChangesView } from "@galahad/core";
import { runWithToken } from "./run-tool.ts";
import { streamedError } from "./server.ts";
import { priceCommand, trialCommand, usageCommand, UsageError } from "./trial-commands.ts";
import { doctorCommand, stoppedReport } from "./doctor-cli.ts";
import { firewallCommand, systemFirewallDeps } from "./firewall-cli.ts";
import { sandboxSetup, type SetupNode, setupWords, systemSetupDeps } from "./sandbox-setup.ts";
import { notifyCommand } from "./notify-cli.ts";
import { teamCommand } from "./team-cli.ts";
import { terminalCommand, ttyScreen } from "./terminal-cli.ts";

const VERSION = "0.1.0";

const HELP = `galahad — one mind, many bodies

Start here (galahad.sh's installer founds the fleet and keeps the node running where it can; otherwise: serve)
  key add                           a provider's key, typed into a hidden prompt: Anthropic's, OpenAI's, OpenRouter's,
                                    DeepSeek's … his roles answer on it at once
  ask "Good morning, Galahad."      a word with him
  invite --client                   pair your phone or browser (the app does the rest)
  roundtable add <id> --name <name> a knight of your own, with a lasting job and a VM of its own
  doctor                            what's wrong here, and what to do about it

The Roundtable (your knights beside Galahad, none beneath another: each with a lasting job, a room and verified work in a VM
of its own; "roundtable", "squires" and "team" are the same command)
  roundtable                        knights, rooms and tasks (those Galahad seated say so:
                                    ask him in chat to seat and brief a knight)
  roundtable add <id> --name <name> [--instructions text] [--role planner] [--agent native|opencode|hermes|claude|codex|acp]
                                    [--acp "<command>"] [--repo https://github.com/owner/repo] [--limit daily-turns]
                                    --agent acp runs any agent that speaks the Agent Client Protocol, started in its VM
                                    by the command you name (--acp "goose acp", "gemini --acp", "opencode acp")
  roundtable models <id> [provider/model…] [--role]
                                    a knight's own models, in place of its role's: its conversations, its tasks' work
                                    and its harness run on them, in order (a local model on whichever node serves it);
                                    with none named, what it works on and what you may choose; --role gives it back
  roundtable sensitive <id> [on [provider/model…] | off]
                                    sensitive mode: every call of its work (its plan, its review, its conversations,
                                    its coding tool) on its own models and nothing else, never a fallback; with no
                                    on/off, whether it is
  roundtable dm <id> [message]       open/read a direct chat, or send a message
  roundtable room <name> <member…>   create a shared room (--limit bounds its coordination chain)
  roundtable chat <room> [message]   read a room, or send a message; work continues on the node
  roundtable task <room> <assignee> <goal> [--after task-id,task-id] [--gate command] [--budget-usd 0.5]
                                    [--sensitive] [--models provider/model,…]: sensitive mode for this task alone,
                                    on the models named, or with none named its knight's own
  roundtable keys <id> [add <secret> [--header x-api-key] [--write] | rm <secret>]
                                    keys of yours it may use but never see: its scripts call $GALAHAD_KEYS/<secret>/…
                                    and the gateway puts the key in, at the key's pinned address alone (galahad secret
                                    set <secret> --base-url https://api.example.com); reads only unless --write
  roundtable export <id> [--out file.md]
                                    a knight as a file you carry: its job and how it works, never its memory or a key
  roundtable import <file.md> [--id <new id>] [-y]
                                    a knight file in as a new knight here, shown first; the keys it had, yours to give
  roundtable steps <task-id>          the steps of a knight's task in a repository, each kept as it ended
  roundtable again <task-id> [--from <step>] ["<goal>"]
                                    give a task again (your stepping in, counted on it): from its start, or from
                                    one of its steps, its workspace as it stood then and what came after set aside
  roundtable give "<goal>" [--gate command]... [--title text] [--desktop] [--repo url] [--budget-usd 0.5]
                                    a task for the Roundtable: the knight best suited to it takes it (free, its work
                                    verified before, its job about this, a desktop or the repository it needs) and
                                    says why; the others' standing is shown beneath
  outcome [ls]                     outcomes Galahad owns: each one's room, budget and spend, tasks and plan
  outcome add "<title>" --goal "…" --knight <id>… --budget-usd 20 [--done "…"] [--report-hour 9] [--tz Zone]
                                    he owns it for days or weeks: plans it in its own room, gives those knights
                                    tasks on his own within its budget, reports daily, asks you there
  outcome pause|resume|stop <id>   stopping it stops its waiting work
  outcome budget <id> <usd|+usd>   its budget: a new total, or +usd on top; one that had spent what it may goes on
  bilag                            receipts and invoices copied from your mail to Google Drive: how many, the latest,
                                    and what is left to set up (docs/BOOKS.md)
  bilag on [--folder Bilag]        a loop that copies each new mail's bilag on its own, woken by Gmail, Outlook or both
  bilag copy --from gmail|outlook [--query "…"] [--folder Bilag]
                                    copy the bilag of mail that came before, a batch at a time until none is left
  bilag names                      copies of forwarded mail renamed for who first sent them (a bilag you forwarded yourself)
  books attach --org <id> --card <voucher card> --file <Drive file id> | --dinero-file <id> --why "…"
                                    a bilag from Drive into Dinero as it is; attaching it to the payment's card asks you
  books upload --org <id> --file <Drive file id>   a bilag into Dinero's archive alone: its fileGuid, for a draft
  roundtable files <knight> [/work/path]  a folder of its workspace (its VM's /work; galahad: his computer's)
  roundtable read <knight> </work/path>  one file of it (anything like a key redacted)
  roundtable changes <knight> [--task <id>] [--files]  what its latest task (or that one) changed: files, then the diff
  roundtable trail <task-id> [--follow]  what a task did, as it happened: its plan, each command and what it printed,
                                    the gates, the review; --follow keeps reading until the task has ended
  roundtable provision <id> [--on node] [--cpus 1 --mem 2 --disk 20] [--network online|gateway] [--desktop]
                                    its VM: online (the default) it can reach the internet, gateway only the models;
                                    --desktop: with a display, a window manager and a browser, for work that needs a
                                    screen (at least 4 GB; in the VM, desktop help lists what operates it)
  roundtable provision <id> --remake [--network online|gateway] [--desktop|--no-desktop]
                                    its VM made again from the image as it is now (a fix to the image, a newer tool):
                                    the same VM and everything in /work, a new container; not while it is working.
                                    --desktop gives a VM that has none a desktop; --no-desktop takes it away
  roundtable provision galahad       his own computer: made, made again and given more as a knight's VM is
  roundtable resize <id> [--cpus 4] [--mem 8] [--disk 40]
                                    more threads, memory or disk for its VM while it runs, nothing stopped and
                                    its work kept; never less (a smaller size takes effect when it is made again).
                                    On a Mac a VM pauses to take more threads or memory, and its disk can't grow
  roundtable memory <id> [text]      read or replace that knight's notes
  roundtable engram [on|off]         the VMs' notes store (Engram): say whether it is on, or turn it on or off.
                                    On (the default), a knight's harness can search and keep notes in its own
                                    VM, where the VM's image has the pinned Engram; off, nothing is given
  roundtable ci [on|off]             failing checks, or a review asking for changes, on a pull request of a knight's
                                    work: say whether they go back to that knight, or turn it on or off. On, it gets
                                    the fix on that branch (once a failing commit or review, three at most), whose
                                    push Galahad approves in a repository you gave the knight; off (the default), they
                                    are yours, though an outcome gives its own back within its budget
  roundtable backlog [on|off]        work for idle knights: one with a repository and nothing to do is given the next
                                    step of its repository's plan, a task a day at most, on Galahad's own yes within its
                                    budget ($3 at most); one that may spend more than is left of your budget (galahad
                                    usage budget) waits for you (galahad roundtable approve <task>); on until you turn it off
  roundtable order <knight,knight,...>  your order of the knights, on every device (those not named come after)
  roundtable primary <knight|galahad>   who leads the Roundtable: it answers what you say to a room without a name
  roundtable avatar <id> [--color #rrggbb | --reset]
                                    a knight is an orb: choose its colour, or let it go back to the one its
                                    handle gives it; with neither, its orb's colours are printed
  roundtable pause|resume|stop <room|knight|task> <id>
  roundtable remove <id> [--destroy-workspace] [--yes]
                                    remove a knight for good: it leaves its rooms and does no more work; what it
                                    said stays to read, and its handle is never used again. One with a VM is removed
                                    only with --destroy-workspace, which destroys that VM and everything in /work

Set up
  init [--name laptop] [--fleet camelot] [--port 7777]     found a fleet on this machine
  join <invite> [--name server] [--port 7777]              join a fleet with an invite
  serve                                                    run this node (daemon)
  expose [--https 443]                                     publish the PWA over HTTPS on your tailnet (tailscale serve)
  invite [--client] [--origin https://host.ts.net:8443] [--no-qr] [--no-wait]
                                                           add a device (prints an invite, then asks you to approve)
  pairings | approve <invite> <device> | reject <invite> <device>
  revoke <device> [--reason text]
  grant <device> <scope…>                                   give a paired phone/browser more permissions (e.g. sandbox)
  status                                                   fleet, peers, capabilities
  live                                                     what your devices are told as it changes: which of what they
                                                           show changed (their live stream), until Ctrl-C
  away [--since 6h]                                        while you were away: tasks that ended, his outcomes' questions,
                                                           loops that failed, what waits on you (default: the last day)
  looks [cancel <id>]                                      what he set himself to look at again later, in your chats

Mind
  remember <text> [--tag t]      recall [query]
  about [add <fact> | keep <id> [--text …] | rm <id>]   what he knows of you: kept facts go with every answer
  search "<words>" [--page 2]    search the web through Galahad's own SearXNG (also: websearch, in sandboxes)
  decide "<state>" --question "…" [--options a,b,c | --levels low,mid,high]
                                  a typed decision from the decider role (TypeSafe's Jev): yes/no, a choice, a score

Chat apps
  telegram                        whether a bot of yours talks to Galahad through this node, and which account it answers
  telegram connect                link a bot (its token from @BotFather, hidden); send it the code from your own account
  telegram disconnect             its device revoked, its token deleted; its chats stay yours
  slack                           whether an app of yours talks to Galahad through this node, and which account it answers
  slack manifest                  the app to make at api.slack.com/apps (From a manifest): Socket Mode, your DMs alone
  slack connect                   link it (its two tokens, hidden); send it the code in a DM from your own account
  slack disconnect                its device revoked, its tokens deleted; its chats stay yours

Keys & models (keys are typed into a hidden prompt — never into chat, never on the command line)
  key add [--provider id]        paste any API key, or a coding plan's (provider presets marks the plans);
                                  the provider is auto-detected when the key's form says whose it is
  secret set <name> | secret list | secret rm <name> | vault rotate
  secret request <name> --reason "…"   ask for a credential; fill it later from any device
  secret dismiss <name>           dismiss a request: out of the Inbox until he asks for it again
  run [--providers a,b] -- <cmd>  run a tool (opencode, claude, codex…) on a scoped gateway token
  provider add <id> [--preset p] [--base-url url] [--kind openai|anthropic] [--secret name]
  provider list | provider models <id> | provider presets
  roster | roster set <role> <provider/model>... | roster rm <role> | roster check <provider/model>... [--only format,reads,places]
  roster effort <role> <auto|low|medium|high|xhigh|max>
                                  how hard its models think: auto (the default) by the step, routine turns less and hard
                                  ones more; or one level you choose, whatever the step
  ask [--role planner] [--model provider/model] [--project id] [--chat id] [--temp] [--detach] <prompt>
                                  kept in your chat history (the app's too) unless --temp; --chat goes on with one.
                                  The turn runs on the node: Ctrl-C stops it; a terminal that goes away stops
                                  nothing; --detach starts it and leaves him to it (the answer is in the chat)
  ask --attach <file> [--attach <file>]... [<prompt>]
                                  files with your message: pictures (PNG, JPEG, WebP, GIF; a model that sees is shown
                                  them, another told they're there) and text (a log, code: given to him as data)
  ask --chat <id> --steer <msg>   he's working in that chat: tell him now (it reaches him at his next safe point)
  ask --chat <id> --queue <msg>   … or keep it on the node, to send as the next turn when he's done
  ask --chat <id> --aside <question> [--bring]
                                  a side question about that chat: answered apart, without his tools, added to
                                  nothing; --bring hands it to him after all
  turns | turn watch <turn|chat> | turn stop <turn|chat>
                                  the turns he's working on now (what each has cost, who's watching, when it
                                  stops by itself); watch one from its start; stop one
  queue <chat> [add "<msg>" | edit <n> "<msg>" | rm <n|all> | send <n> | resume]
                                  your messages queued behind a chat; after a stop, a failure or a restart
                                  they're held until you resume
  quests [--all]                  the quests in hand on this node: plan, the step he's on, each gate's last result
  chats [--project id] | chat <id> | chat rm <id>
  skills [--all] | skills show <id> | skills approve <id> [-y]
                                  his skills: how he did work that passed review, kept as notes he's given again
                                  (data, never run). One that read the outside world waits for your approval
  skills lock|unlock|retire|restore <id> | skills rollback <id> [-y]
                                  locked: he uses it, never changes it; retired: kept, never offered; one version back
  skills write [<id>] --title "…" --when "…" --step "…" [--proof "cmd => expect"] [--pitfall "…"] | --file skill.json
                                  write one yourself, or a new version of one (yours: he never edits them)
  skills import <github folder>   an Agent Skill's SKILL.md taken in as text (nothing in its folder runs), waiting for you
  skills budget [<tokens a day>]  what he may spend a day distilling skills from passed quests (0: off)
  projects | project set <id> --name "…" [--instructions "…" | --instructions-file f] [--repo url] | project rm <id>
  project git|changes|clone <id> · project branch <id> <name> [--new] · project commit <id> --message "…"
                                  a project's checkout on his computer, as the Mac's Build view has it: its branch and
                                  commits, what changed, its first clone, a branch to switch to or start, a commit
  token mint --label opencode [--providers deepseek,anthropic] [--ttl 60] [--max 1000]

Work
  investigate "<question>" [--net isolated|online] [--workshop] [--steps 40] [--timeout 600] [--keep]
                                  the scientific method: hypothesis and predictions registered before anything
                                  runs, a verified experiment in the Lab, an independent method review
  findings | finding <id>         what investigations concluded (supported, refuted, inconclusive) and why
  trial run [problem|domain …] [--suite engineering|agentic|reviewer|yours] [--level 1..4] [--hardest 5] [--repeat 1]
            [--parallel auto|n] [--effort 1|2|3] [--seed n] [--net …] [--vm|--container]
                                  the Trials: problems posed from a seed, worked as quests, graded by a program: the
                                  Galahad Index. engineering: exact answers, in the Lab. agentic: real work in a small
                                  repository, graded by hidden tests in a fresh sandbox (--level turns the difficulty).
                                  reviewer: a quest's evidence with a known answer, put to the reviewer. yours: your
                                  knights' tasks that passed review, worked again from the commit each began at and
                                  graded by its own gates; named by task id or knight, else the --hardest 5. --effort
                                  makes that many attempts a trial (the reviewer takes one before anything is graded)
     … --pin <role>=<provider/model> [--pin …] --variant <name[:switch=value,…]> --budget 2M --budget-usd 5
                                  hold a role to one model; run under a named set of harness switches; stop cleanly
                                  when the budget is spent (it says first what past runs of these problems cost)
  trial sweep <planner|engineer|reviewer> <provider/model> [<provider/model> …] [--suite s] [--only problem,…]
                                  the same seeded tasks once per candidate, that role held to it: which model is best
                                  in the role, which is best for its cost, and how sure that is
  trial ab <variant> <variant> [problem …] [--suite s]
                                  the same seeded tasks under two variants of the harness: measurably helps, measurably
                                  hurts, or no measurable difference, with what each cost (trial variants lists them)
  trial compare <run> <run>       two recorded runs, the second against the first, by the same rule
  trial estimate [problem …] [--suite s] [--repeat n] [--effort n]   what such a run would cost, going by past runs
  trials [--suite s] [--all] | trial <id|run> | trial problems [--suite s] [--level n] | trial variants
                                  the Index per run with what it cost (tokens, time, money, and the quality each
                                  bought), per effort, per model in each role, per variant; each answer or hidden check;
                                  trial problems --suite yours: your cases, with what each took when it was done
  price | price set <provider/model | provider/*> <$/M in> <$/M out> [--cached x] | price rm <provider/model>
                                  your prices, per million tokens: tokens are always counted, money only where
                                  you've stated a price
  usage [--days 30]               this node's model calls: tokens by model, role, who asked and day, and the meter
  usage budget <usd|off> [--per day|month]  your budget for them, a line to watch (a month's unless --per day)
  do "<goal>" [--net isolated|gateway|online] [--on ultra] [--steps 30] [--timeout 300] [--keep] [--effort auto|1|2|3]
                                  a quest: plan → work in a fresh sandbox → independent review → remembered.
                                  --effort spends more compute for a better answer: that many attempts at once,
                                  each in its own sandbox and reviewed, the best taken by the independent
                                  reviewer on the evidence alone (auto: what the free slots and the budget allow)
     … --fenced                    the engineer sends one shell command a reply, as before 21 November 2026, in place
                                  of its own tools (bash, read, edit, write, several calls a turn)
     … --budget-usd 2              money its model calls may spend at your prices (galahad price), every
                                  attempt's together: past four fifths the work is told to wrap up, and once
                                  it is spent the work stops
     … --gate "<command>" [--gate …] [--no-planner-gates]
                                  done means this passes: each gate runs in the quest's sandbox when the
                                  engineer says DONE, and every one must exit 0 before the reviewer is asked
                                  (a failing gate sends the work back; one that never passes: never done).
                                  The planner may add gates of its own, marked as its proposal; yours stay
                                  exactly as given (--no-planner-gates: yours only)
  do --agent opencode "<goal>" [--minutes 60] [--repo https://…] [--net gateway|online]
                                  the same, with a full coding agent doing the work for up to --minutes
                                  (models through the gateway; --repo clones first and keeps a patch:
                                  GitHub repositories, private ones too, through the read-only git gateway)
     … --repo https://github.com/o/r --ship [--title …] [--base main] [--draft]
                                  once the reviewer passes it, ask you to open a pull request (Inbox)
  ship <artifact> --title "…" [--body …] [--base main] [--branch galahad/…] [--draft] [--ask] [-y]
                                  open a pull request from a quest's kept changes (the node commits them on
                                  a new branch with the connector's key; the sandbox never holds it)
  place [--docker] [--vm] [--gpu] [--mem 16] [--tools git,opencode] [--long] [--untrusted] [--interactive]
  sandbox run [--on ultra] [--net gateway|online|isolated] [--cpus 4] [--mem 8] [--disk 20] [--ttl 120] [--vm|--container] [--lab|--gazebo|--desktop]
              [--providers deepseek,anthropic] [--image img] [--timeout 600] [--keep] -- <command…>
  sandbox ls [--on ultra] | sandbox exec <id> [--on ultra] -- <command…> | sandbox rm <id> [--on ultra]
  sandbox save <id> [/work/dir] [--label …]   keep a sandbox's work (default /work/out) after it's gone
  sandbox build [--on ultra] [--lab|--gazebo|--desktop]
                                  build the sandbox image (or the Lab, Gazebo, or the knights' desktop) on a host
  sandbox setup [status] [--json]
                                  a Mac given its knights' VMs: Apple's container (its signed installer, checked, when
                                  it has none), its service and kernel, the sandbox firewall, the node restarted to host
                                  VMs, the image, and a VM made to be sure. It asks for your password once, and leaves
                                  what holds as it is. status changes nothing: it says what holds and what doesn't
  terminal <knight|sandbox>       a shell in that knight's VM (or that sandbox) on a real terminal: what a vendor's
                                  sign-in or a coding tool's screen needs. Ctrl-] leaves and closes it; so does exit
  terminal ls | terminal attach <terminal> | terminal close <terminal>
                                  the terminals open on this node (one opened in the app can be taken up here, and
                                  leaving it leaves it open)
  artifacts | artifact <id> [file] [--out dir]   what quests and sandboxes kept; print a file or save them all
  ledger [--limit 30]             what Galahad did, and the oath's verdict on each action

Compute (he uses the machines you enrolled, within a ceiling you set; he never acquires any)
  compute                         the census: what each node measured, its ceiling, slots in use and waiting,
                                  his plan, the day's budget, and what more compute would buy
  compute calibrate [node]        a node measures itself now (a few seconds, low priority, within its ceiling)
  compute limit <node> [--cores n] [--mem gb] [--sandboxes n] [--model-calls n] [--reset]
                                  the ceiling: what he may use of that machine (default: half of it)
  compute effort [auto|1|2|3] [--budget n]
                                  how much he spends on a quest by himself, and the day's budget of extra attempts

Archive (this node's: everything kept for good, searched by words and meaning)
  archive                         entries, passages embedded, the backlog, the embedder, the last integrity check, disk
  archive search <words…> [--kind idea,model] [--trust owner,agent] [--source memories] [--since 7d] [--until 2026-11-01] [--limit 10]
  archive show <id> [file]        an entry: summary, facts, lessons, files and links (or one file, to stdout)
  archive idea "<title>" [--text "…"] [--tag t]   keep an idea (the text may come on stdin)
  archive rm <id> --reason "…"    delete for good (a tombstone keeps it from coming back)
  archive reindex [--summaries]   embed everything again (and summarise again, within the budget)
  archive verify                  re-hash every stored file now (it runs daily too)
  archive budget [<n>]            summaries a day by the swift role (unset: a local model only)

Loops (work on a schedule or when something happens, on one node; every run is recorded in the mind)
  loop ls | loop runs [name] | loop run <name> | loop pause|resume|rm <name>
  loop add <name> (--every 30m | --cron "0 7 * * 1-5" | --at "2026-11-25 09:00" | --in 2h) [--tz Europe/Copenhagen]
       [--on ultra] [--label text]   --at and --in run it once (your terminal's zone unless --tz), then never again
       --heartbeat [--checklist "…"]                    look around; notices in your inbox
     | --quest "<goal>" [--net isolated|gateway|online] [--steps 20] [--gate "<command>" …]
     | --call <connector>.<tool> [--arg key=value …]   outward tools file an approval instead
     | --tell [--say "…"]                              tell you: a notice each run, your loop's name on your phone
       [--wake …]… [--cooldown 10m]    what else wakes it (no schedule: only that), as data, never orders:
         --wake webhook                 a POST to /hooks/<name>, signed with its secret (shown once; loop hook <name>: a new one)
         --wake "gmail <search words>"  new mail a search finds (also outlook); read every few minutes
         --wake "github <owner>/<repo> [ci.failed,pushed,issue.opened,pr.opened] [branch]"
                                        a failed CI run (the default), a push, a new issue or pull request
  loop set <name> [same options]  change a loop (what you leave out stays), e.g. loop set heartbeat --every 1h; --no-wakes
  loop drafts                     loops Galahad drafted when you asked for one in chat (they run nothing until added)
  loop add --draft <id> [--on n]  add a draft as he drafted it · loop dismiss <id>: drop it
  heartbeat                       run the heartbeat's checks now and print what they find
  self-action [on|off]            whether he fixes what's safe himself after each heartbeat (on by default):
                                  the allowlist, and what he fixed lately
  notices [--all] | notice dismiss <key>

Notifications (he comes to you: Web Push to your own paired devices, encrypted to each browser)
  notify                          the devices he can reach, what he tells you, quiet hours, the day's limit, and
                                  what was sent today. A device is turned on from that device: the app's
                                  Settings → Notifications (on an iPhone, from the Home Screen app)
  notify test [device]            one test notification, to every device or the one named
  notify kinds [<kind> on|off …]  what he tells you: needs-you, approval, finished, question, told (all on)
  notify quiet [on|off|HH:MM-HH:MM] [--tz Europe/Copenhagen]
                                  quiet hours (22:00-07:00, the node's own time zone until you give one): everything but an alert waits,
                                  then one message says what waited
  notify limit <n>                at most n a day (12), the last two kept for alerts; when ordinary news reaches
                                  the limit, one message says so
  notify off <device>             remove a device's subscription

Connectors (manifests, not code: keys stay in the vault; outward and delete ask you)
  connector ls | connector tools <id> [tool] | connector rm <id>
  connector library [words] [--auth sign-in|key|open] [--category "…"] [--sort popular|name|updated] [--limit 30]
                                                  hosted MCP servers: Galahad's reviewed list and the index at mcp.galahad.sh
  connector add github|cloudflare|home-assistant [--origin url] | connector add --manifest file.json
  connector add github --owner <org>                    one more GitHub owner with its own token (github-<org>)
  connector add <id> --mcp <url> [--auth bearer|header:<name>|oauth] [--only a,b] [--class tool=read …]
                                                         oauth: you sign in to it as you (its own sign-in, no app of yours)
                                  a remote MCP server: its tools are listed once; you choose their classes
  connector refresh <id> [--class tool=class …]   list an MCP server's tools again (your classes stay)
  connector call <id>.<tool> [--arg key=value …] [--why "…"]
  connector requests | connector dismiss <id>      what an agent asked you to connect (it never installs one)
  connector allow|disallow <id> <agent>           let an agent use a connector that's Galahad's alone (mail), or stop it
  connector app <id> --client-id <id>             a connector that signs in (Gmail, Outlook): the app you registered
  connector signin <id> [--redirect <url>]        sign in as you (Google returns to <your app>/oauth/callback) · connector signout <id>
  secret set <name> --connector <id>                    a connector's key, pinned to its origin
  action ls [--all] | action approve <id> [--note …] [--edit key=text …] | action deny <id>
                                  --edit: your own words in its text before your yes (that version is sent; the one
                                  asked is declined, saying which it became)
  questions | questions answer <id> name=value … | questions decline <id>
                                  what an MCP server asked you in the middle of a call (its call waits): your answer

Standing orders (your answer in advance: one tool, narrow arguments, an expiry)
  order ls [--all] | order revoke <id>
  order add <connector>.<tool> --arg key=pattern … [--for loop.name] [--days 30] --label "…"
  order add --from <action-id> [--arg key=pattern] [--free key]   approve it, and answer alike next time
                                  * matches anything; deletes are pinned exactly; at most a year

Tripwires and checks (your rules on the commands his work runs: data, never a model's judgment)
  rule ls | rule rm <name>
  rule add <name> --halt|--refuse <glob>… [--contains text]
                                  a command with a word that matches a glob (and that holds the text) halts the work, or
                                  isn't run and he is told why: * any run but /, ** any run, ? one character ('*.lock',
                                  '.env*', 'migrations/**', rm). Checked before every command of his quests and of a
                                  knight's task on his own runner, and every gate; a coding tool's own commands in its
                                  VM aren't seen. Quote globs; one that begins with - goes after --
                                  (rule add no-force --refuse -- --force)
  rule add <name> --check "<command>" <glob>… [--contains text]
                                  after a command that matches has run and exited 0, your command runs where his work
                                  runs, and he is told at once if it fails (rule add types --check "bunx tsc --noEmit" '*.ts')
  rule add <name> --tell <glob>… [--contains text]
                                  after a command that matches has run, however it ended, you are told: a notice in your
                                  Inbox and a notification, once for each task (rule add pushes --tell git --contains push)

Bank (read-only: balances and transactions of your own accounts, through Enable Banking)
  bank setup --app-id <uuid> --key /path/to/<app-id>.pem --redirect-url https://…/bank/callback
             --aspsp "<bank>" --country <XX>
                                  the bank by the name Enable Banking lists it under, and its country
                                  (try Enable Banking's sandbox first: --aspsp "Mock ASPSP" --country FI)
  bank status | bank connect | bank complete | bank disconnect
                                  connect gives the bank's link (or use the PWA: Bank → Connect);
                                  complete takes the URL the bank sent you back to, in a hidden prompt
  arms grant <agent> bank:read    let one agent read the bank (arms ungrant <agent> bank:read to stop)

Agents (MCP, ACP)
  mcp install claude|opencode|codex|hermes [--label name] [--apply]
                                  give a coding agent Galahad's mind and sandboxes (least privilege)
  mcp --arm <label> [--tools a,b] the MCP server itself (stdio; started by the agent, not by you); --tools: those
                                  tools alone, of what the arm may use
  acp install buzz [--label name] Galahad in a Buzz community: a credential that may only chat (nothing of yours in his
                                  answers there), and how Buzz's harness runs him (docs/BUZZ.md)
  acp --arm <label> [--buzz]      Galahad himself as an ACP agent (stdio; started by the harness, not by you); --buzz
                                  posts each answer where it was asked, with Buzz's CLI
  arms | arms revoke <label>      list or revoke agent credentials
  qamp grant <did:key:z6Mk…> [--tools fleet,compute,place,ledger] [--ttl 1h]
                                  an agent on another of your machines (one that runs no node: Claude Code on a laptop)
                                  calls these read-only tools here over Q-AMP, for that long (24h at most): its own key
                                  alone, through a bridge on this node's tailnet address. Prints what its machine runs
  qamp grants | qamp revoke <id>|--all
                                  the grants in force; end one, or every one, now (each also ends by itself)

Maintenance
  awake on|off|status             a Mac set to stay on (a Mac mini serving the fleet) is kept from sleeping while its
                                  node runs, and counts as always on (no battery); a laptop on its battery never is
  screen [status|allow|look] [--on <node>] [--out shot.jpg]
                                  a Mac's own screen, for Galahad (a Mac whose node runs from the Galahad app): its
                                  size and what macOS lets him do with it; allow shows macOS's prompts on that Mac
                                  (you turn both on there, once); look saves a picture of it
  screen sessions | screen approve|deny|end <session>
                                  his asks to use a Mac itself (each asks you first, for so many minutes from your
                                  answer): where each stands, your answer, and ending one sooner
  firewall [status|rules|install|remove]
                                  a Mac's sandbox firewall (pf, from a helper of root's): a gateway sandbox reaches
                                  the gateway alone, an online one the internet, never the Mac or your networks; no
                                  sandbox is made on a Mac while it is off. install and remove ask for your password
  doctor [--offline] [--quick] [--json]
                                  is everything well? One look at this node's whole installation, in plain lines
                                  (ok, needs you, broken) with what to do: its keys, the mind, its clock, sync and
                                  backups, the vault, each role's model (asked one word), the embedder and the
                                  archive, sandboxes (one is started and removed), compute, loops, connectors, the
                                  app, notifications, disk, the service. It changes nothing. --offline asks no
                                  model and probes no service; --quick looks only at what costs nothing.
                                  Exit code 0: all is well; 1: something needs you; 2: something is broken
  rebuild                         re-materialize the mind from its log and verify the digest

Options: --home <dir> (or GALAHAD_HOME); init and join also take --keystore os|file and --advertise <tailnet ip>
Environment: GALAHAD_PORT, GALAHAD_KEYSTORE=os|file, GALAHAD_ADVERTISE=<tailnet ip>, GALAHAD_ARCHIVE_DIR=<absolute path>, GALAHAD_ARCHIVE=off,
  GALAHAD_BACKUP_DIR=<absolute path> (where the node keeps its daily backups, and the doctor looks), GALAHAD_BACKUPS=off,
  GALAHAD_PUSH_CONTACT=mailto:…|https://… (who operates this node, as push services are told; default names nobody),
  GALAHAD_PUSH_HOSTS=host,*.host (push services to allow beyond Apple, Google, Mozilla, Microsoft and ntfy.sh)`;

const dim = (s: string) => (process.stdout.isTTY ? `\x1b[2m${s}\x1b[0m` : s);
const bold = (s: string) => (process.stdout.isTTY ? `\x1b[1m${s}\x1b[0m` : s);

function fail(message: string): never {
  console.error(`galahad: ${message}`);
  process.exit(1);
}

/** Thrown (never `process.exit`) so `finally` blocks, like sandbox cleanup, always run. */
class CliError extends Error {}

class Admin {
  readonly base: string;
  private readonly token: string;

  constructor(home: Home) {
    const config = home.readConfig();
    this.base = `http://127.0.0.1:${loadEnv().GALAHAD_PORT ?? config.port}`;
    this.token = home.adminToken();
  }

  private async request(name: RouteName, input?: unknown, signal?: AbortSignal): Promise<Response> {
    const route = routes[name];
    let response: Response;
    try {
      response = await fetch(`${this.base}${route.path}`, {
        method: route.method,
        headers: { authorization: `Bearer ${this.token}`, "content-type": "application/json" },
        body: route.method === "POST" ? JSON.stringify(input ?? {}) : undefined,
        ...(signal ? { signal } : {}),
      });
    } catch (error) {
      if (signal?.aborted) throw error;
      throw new CliError(`no daemon on ${this.base} — start it with \`galahad serve\``);
    }
    if (!response.ok) {
      const body = (await response.json().catch(() => ({}))) as { error?: string; issues?: unknown };
      throw new CliError(`${body.error ?? response.statusText}${body.issues ? ` ${JSON.stringify(body.issues)}` : ""}`);
    }
    return response;
  }

  /** A route that answers with bytes (an artifact's file). */
  async bytes(name: RouteName, input?: unknown): Promise<{ bytes: Uint8Array; type: string }> {
    const response = await this.request(name, input);
    return { bytes: new Uint8Array(await response.arrayBuffer()), type: response.headers.get("content-type") ?? "" };
  }

  async call<T = any>(name: RouteName, input?: unknown): Promise<T> {
    const body = await (await this.request(name, input)).json();
    const failed = streamedError(body);
    if (failed) throw new CliError(failed.error);
    return body as T;
  }

  /** A route that answers with events (a turn's, a terminal's), until it ends or `signal` is aborted. */
  async *stream<T = ChatStreamEvent>(name: RouteName, input: unknown, signal?: AbortSignal): AsyncGenerator<T> {
    const response = await this.request(name, input, signal);
    for await (const data of sseData(response.body!)) yield JSON.parse(data) as T;
  }
}

async function readSecret(promptText: string): Promise<string> {
  if (!process.stdin.isTTY) return (await Bun.stdin.text()).trim();
  process.stdout.write(promptText);
  process.stdin.setRawMode(true);
  process.stdin.resume();
  return new Promise((resolve) => {
    let value = "";
    const onData = (chunk: Buffer) => {
      for (const ch of chunk.toString("utf8")) {
        if (ch === "\r" || ch === "\n") {
          process.stdin.off("data", onData);
          process.stdin.setRawMode(false);
          process.stdin.pause();
          process.stdout.write("\n");
          resolve(value.trim());
          return;
        }
        if (ch === "\u0003") process.exit(130);
        if (ch === "\u007f" || ch === "\b") value = value.slice(0, -1);
        else value += ch;
      }
    };
    process.stdin.on("data", onData);
  });
}

function confirm(question: string): boolean {
  const answer = prompt(`${question} [y/N]`);
  return /^y(es)?$/i.test(answer?.trim() ?? "");
}

async function main(): Promise<void> {
  // A word that begins with one dash and is longer than a short option (-y, -h) is a word: an id is base64url, and one in
  // sixty-four begins with a dash. So is one that begins with two but can't be an option's name (lowercase words joined
  // by dashes, as every option here is): one id in 4,096 begins so. It is held aside while the options are read, and put
  // back where it was. (A bare -- still ends the options.)
  const word = (arg: string): boolean => /^-[^-].{2,}$/.test(arg) || (/^--./.test(arg) && !/^--[a-z][a-z0-9-]*(=.*)?$/s.test(arg));
  const words = new Map<string, string>();
  const argv = Bun.argv.slice(2).map((arg, i) => (word(arg) ? (words.set(`\u0000${i}`, arg), `\u0000${i}`) : arg));
  const parsed = parseArgs({
    args: argv,
    allowPositionals: true,
    strict: false,
    options: {
      home: { type: "string" },
      name: { type: "string" },
      fleet: { type: "string" },
      port: { type: "string" },
      https: { type: "string" },
      keystore: { type: "string" },
      advertise: { type: "string" },
      client: { type: "boolean" },
      "client-id": { type: "string" },
      redirect: { type: "string" },
      origin: { type: "string" },
      provider: { type: "string" },
      preset: { type: "string" },
      "base-url": { type: "string" },
      kind: { type: "string" },
      secret: { type: "string" },
      label: { type: "string" },
      role: { type: "string" },
      model: { type: "string" },
      // (Sensitive mode for a task alone: its knight's own models, or those named with --models.)
      sensitive: { type: "boolean" },
      models: { type: "string" },
      // (The command that starts a knight's ACP agent: roundtable add --agent acp --acp "goose acp".)
      acp: { type: "string" },
      // (A key a knight may use but never see: roundtable keys <knight> add <secret> [--header x-api-key] [--write].)
      header: { type: "string" },
      write: { type: "boolean" },
      tag: { type: "string", multiple: true },
      reason: { type: "string" },
      providers: { type: "string" },
      ttl: { type: "string" },
      max: { type: "string" },
      docker: { type: "boolean" },
      vm: { type: "boolean" },
      container: { type: "boolean" },
      lab: { type: "boolean" },
      gazebo: { type: "boolean" },
      desktop: { type: "boolean" },
      "no-desktop": { type: "boolean" },
      out: { type: "string" },
      workshop: { type: "boolean" },
      gpu: { type: "boolean" },
      mem: { type: "string" },
      disk: { type: "string" },
      tools: { type: "string" },
      long: { type: "boolean" },
      untrusted: { type: "boolean" },
      interactive: { type: "boolean" },
      "no-wait": { type: "boolean" },
      "no-qr": { type: "boolean" },
      on: { type: "string" },
      net: { type: "string" },
      // (A knight's VM: `roundtable provision <id> --network gateway`. Undeclared, it was read as a switch and its VM made online.)
      network: { type: "string" },
      look: { type: "string" },
      cpus: { type: "string" },
      image: { type: "string" },
      keep: { type: "boolean" },
      limit: { type: "string" },
      timeout: { type: "string" },
      steps: { type: "string" },
      arm: { type: "string" },
      apply: { type: "boolean" },
      // `acp --buzz [--buzz-cli path]`: his answers posted to Buzz where each was asked (buzz.ts).
      buzz: { type: "boolean" },
      "buzz-cli": { type: "string" },
      every: { type: "string" },
      cron: { type: "string" },
      // A loop once: --at "2026-11-25 09:00" in its zone, or --in 2h from now.
      at: { type: "string" },
      in: { type: "string" },
      // What else wakes a loop: --wake webhook | "gmail <words>" | "github owner/repo [ci.failed,pushed,issue.opened,pr.opened]" (repeatable).
      wake: { type: "string", multiple: true },
      "no-wakes": { type: "boolean" },
      cooldown: { type: "string" },
      // A loop that tells you: --tell, with your words --say "…".
      say: { type: "string" },
      // Bilag to Google Drive: a loop's --bilag [--folder Bilag]; galahad bilag copy --from gmail|outlook [--query "…"].
      bilag: { type: "boolean" },
      folder: { type: "string" },
      query: { type: "string" },
      org: { type: "string" },
      card: { type: "string" },
      "dinero-file": { type: "string" },
      // An outcome he owns: outcome add "<title>" --goal "…" --knight id… --budget-usd 20 [--done "…"] [--report-hour 9].
      goal: { type: "string" },
      done: { type: "string" },
      knight: { type: "string", multiple: true },
      "report-hour": { type: "string" },
      tz: { type: "string" },
      heartbeat: { type: "boolean" },
      checklist: { type: "string" },
      budget: { type: "string" },
      quest: { type: "string" },
      call: { type: "string" },
      arg: { type: "string", multiple: true },
      edit: { type: "string", multiple: true },
      why: { type: "string" },
      note: { type: "string" },
      manifest: { type: "string" },
      all: { type: "boolean" },
      connector: { type: "string" },
      for: { type: "string", multiple: true },
      mcp: { type: "string" },
      id: { type: "string" },
      auth: { type: "string" },
      only: { type: "string" },
      class: { type: "string", multiple: true },
      free: { type: "string", multiple: true },
      days: { type: "string" },
      from: { type: "string" },
      repeat: { type: "string" },
      parallel: { type: "string" },
      seed: { type: "string" },
      // The Trials: `trial run --suite agentic --level 3 --pin engineer=p/m --variant no-gates --budget 2M --budget-usd 5`; `price set … --cached 0.3`.
      suite: { type: "string" },
      level: { type: "string" },
      // `trial run --suite yours --hardest 8`: how many of your own cases a run takes, hardest first.
      hardest: { type: "string" },
      pin: { type: "string", multiple: true },
      variant: { type: "string" },
      "budget-usd": { type: "string" },
      cached: { type: "string" },
      cases: { type: "string" },
      page: { type: "string" },
      question: { type: "string" },
      "app-id": { type: "string" },
      key: { type: "string" },
      "redirect-url": { type: "string" },
      country: { type: "string" },
      aspsp: { type: "string" },
      options: { type: "string" },
      levels: { type: "string" },
      agent: { type: "string" },
      minutes: { type: "string" },
      repo: { type: "string" },
      ship: { type: "boolean" },
      owner: { type: "string" },
      title: { type: "string" },
      body: { type: "string" },
      temp: { type: "boolean" },
      chat: { type: "string" },
      project: { type: "string" },
      instructions: { type: "string" },
      after: { type: "string" },
      form: { type: "string" },
      color: { type: "string" },
      accent: { type: "string" },
      eyes: { type: "string" },
      accessory: { type: "string" },
      temperament: { type: "string" },
      "instructions-file": { type: "string" },
      base: { type: "string" },
      branch: { type: "string" },
      draft: { type: "boolean" },
      ask: { type: "boolean" },
      yes: { type: "boolean", short: "y" },
      help: { type: "boolean", short: "h" },
      // Tripwires, checks and rules that tell you: `rule add <name> --halt|--refuse|--check "command"|--tell <glob>… --contains text`.
      halt: { type: "boolean" },
      refuse: { type: "boolean" },
      check: { type: "string" },
      tell: { type: "boolean" },
      contains: { type: "string" },
      // Quests: gates ("done means this command passes").
      gate: { type: "string", multiple: true },
      "no-planner-gates": { type: "boolean" },
      fenced: { type: "boolean" },
      // Turns the node owns: what `ask` does while he's working in a chat, and leaving him to it.
      steer: { type: "boolean" },
      queue: { type: "boolean" },
      aside: { type: "boolean" },
      bring: { type: "boolean" },
      detach: { type: "boolean" },
      // Compute: effort and ceilings.
      effort: { type: "string" },
      cores: { type: "string" },
      sandboxes: { type: "string" },
      "model-calls": { type: "string" },
      reset: { type: "boolean" },
      "destroy-workspace": { type: "boolean" },
      remake: { type: "boolean" },
      follow: { type: "boolean" },
      // usage budget <usd> [--per day|month]
      per: { type: "string" },
      // roundtable changes <knight> [--task <id>] [--files]: a task of its by name, and the files without the diff.
      task: { type: "string" },
      files: { type: "boolean" },
      // project commit <id> --message "…" · project branch <id> <name> [--new]
      message: { type: "string" },
      new: { type: "boolean" },
      "poll-ms": { type: "string" },
      // The archive's filters and ideas.
      trust: { type: "string" },
      source: { type: "string" },
      since: { type: "string" },
      until: { type: "string" },
      text: { type: "string" },
      summaries: { type: "boolean" },
      // His skills: `skills write --title … --when … --step … --proof "cmd => expect" --pitfall … | --file skill.json`.
      when: { type: "string" },
      step: { type: "string", multiple: true },
      proof: { type: "string", multiple: true },
      pitfall: { type: "string", multiple: true },
      file: { type: "string" },
      // `ask --attach file --attach file`: your files with the message.
      attach: { type: "string", multiple: true },
      // The doctor: `doctor [--offline] [--quick] [--json]`.
      offline: { type: "boolean" },
      quick: { type: "boolean" },
      json: { type: "boolean" },
    },
  });
  const back = (value: unknown): unknown => (typeof value === "string" ? (words.get(value) ?? value) : Array.isArray(value) ? value.map(back) : value);
  const positionals = parsed.positionals.map((p) => words.get(p) ?? p);
  const flags = Object.fromEntries(Object.entries(parsed.values).map(([key, value]) => [key, back(value)])) as typeof parsed.values;
  const [command, sub, ...rest] = positionals;
  const home = Home.resolve(flags.home as string | undefined);
  const str = (key: string) => flags[key] as string | undefined;
  /** --vm or --container: how a sandbox is isolated (default: the host decides). */
  const isolation = (): "vm" | "container" | undefined => (flags.vm ? "vm" : flags.container ? "container" : undefined);

  if (!command || flags.help || command === "help") {
    console.log(HELP);
    return;
  }

  switch (command) {
    case "init": {
      if (home.exists()) fail(`a node already exists at ${home.dir}`);
      const nodeName = str("name") ?? (await import("node:os")).hostname().toLowerCase();
      const keystorePref = (str("keystore") ?? loadEnv().GALAHAD_KEYSTORE ?? "os") as "os" | "file";
      const { identity, keystore } = await home.createIdentity(keystorePref);
      const store = new MindStore(home.mindPath);
      const fleet = foundFleet(store, identity, { fleetName: str("fleet") ?? "camelot", nodeName });
      store.close();
      home.writeConfig({ v: 1, name: nodeName, fleet, port: Number(str("port") ?? 7777), keystore, advertise: str("advertise") ?? null });
      home.adminToken();
      console.log(`${bold("A new fleet is founded.")}
  fleet   ${fleet}
  node    ${nodeName} (${identity.id.slice(0, 12)}…)
  keys    ${keystore === "os" ? "OS keychain" : `${home.keyFilePath} (0600)`}
  home    ${home.dir}

Next:
  galahad serve                 start this node
  galahad expose                serve the PWA at https://<this-machine>.<tailnet>.ts.net
  galahad invite --client       pair your phone or browser (scan the QR code with it)
  galahad invite                add another machine (then run \`galahad join <invite>\` there)
  galahad key add               paste an API key`);
      return;
    }

    case "join": {
      if (!sub) fail("usage: galahad join <invite>");
      if (home.exists()) fail(`a node already exists at ${home.dir}`);
      const invite = decodeInvite(sub);
      if (invite.k !== "node") fail("that invite is for a client; open it in a browser instead");
      const nodeName = str("name") ?? (await import("node:os")).hostname().toLowerCase();
      const port = Number(str("port") ?? loadEnv().GALAHAD_PORT ?? 7777);
      const keystorePref = (str("keystore") ?? loadEnv().GALAHAD_KEYSTORE ?? "os") as "os" | "file";
      const advertise = str("advertise") ?? loadEnv().GALAHAD_ADVERTISE ?? (await tailscaleInfo())?.ip ?? "127.0.0.1";
      const { identity, keystore } = await home.createIdentity(keystorePref);
      const join = await requestPairing(sub, {
        device: identity.id,
        name: nodeName,
        kind: "node",
        box: b64u(identity.boxPublic),
        endpoint: `http://${advertise}:${port}`,
      });
      console.log(`\n  Confirmation code:  ${bold(join.sas)}\n\n  Approve on the inviting node if it shows the same code. Waiting…`);
      const { fleet } = await waitForApproval(join);
      const store = new MindStore(home.mindPath);
      store.expectFleet(fleet);
      for (let page = 0; page < 1000; page++) {
        const result = await signedPost<SyncPage>(identity, invite.e, "/link/sync", { have: store.frontier() });
        store.ingest(result.events);
        if (!result.more) break;
      }
      if (!store.activeDevice(identity.id)) fail("synced, but this node is not enrolled; ask the inviter to retry");
      const fleetName = store.genesis?.name;
      store.close();
      home.writeConfig({ v: 1, name: nodeName, fleet, port, keystore, advertise: str("advertise") ?? null });
      home.adminToken();
      console.log(`\n${bold(`Joined fleet ${fleetName}.`)} The vault and the mind are now shared. Start this node with \`galahad serve\`.`);
      return;
    }

    case "serve":
    case "start": {
      const daemon = await startDaemon(home);
      const shutdown = async () => {
        await daemon.stop();
        process.exit(0);
      };
      process.on("SIGINT", shutdown);
      process.on("SIGTERM", shutdown);
      return;
    }

    case "expose": {
      const config = home.readConfig();
      const ts = await tailscaleInfo();
      if (!ts) fail("tailscale is not running");
      const env = loadEnv();
      const proxyPort = env.GALAHAD_PROXY_PORT ?? (env.GALAHAD_PORT ?? config.port) + 1;
      const https = str("https") ?? "443";
      const proc = Bun.spawn(["tailscale", "serve", "--bg", `--https=${https}`, `http://127.0.0.1:${proxyPort}`], {
        stdout: "inherit",
        stderr: "inherit",
      });
      if ((await proc.exited) !== 0) fail("tailscale serve failed (is HTTPS enabled for your tailnet?)");
      console.log(`PWA: https://${ts.dnsName}${https === "443" ? "" : `:${https}`}/  (tailnet only)`);
      return;
    }

    case "invite": {
      const admin = new Admin(home);
      const kind = flags.client ? "client" : "node";
      let origin = str("origin");
      // A phone opens the PWA where `tailscale serve` publishes it, which may not be 443 (on a server that
      // keeps 443 for something else, it's whatever `galahad expose --https` chose): ask Tailscale.
      let unpublished = false;
      if (kind === "client" && !origin) {
        const env = loadEnv();
        const proxyPort = env.GALAHAD_PROXY_PORT ?? (env.GALAHAD_PORT ?? home.readConfig().port) + 1;
        origin = (await servedOrigin(proxyPort)) ?? undefined;
        if (!origin) {
          unpublished = true;
          const ts = await tailscaleInfo();
          origin = ts?.dnsName ? `https://${ts.dnsName}` : admin.base;
        }
      }
      const created = await admin.call<{ invite: string; url: string | null; expiresAt: number; id: string }>("createInvite", {
        kind,
        ...(origin ? { origin } : {}),
      });
      if (kind === "client" && created.url) {
        console.log("Scan this with the camera of the device you're adding, or open the link on it (valid 10 minutes, single use):\n");
        // Black on white whatever the terminal's colours, so a phone's camera reads it.
        if (process.stdout.isTTY && !flags["no-qr"]) console.log(`${qrToTerminal(encodeQr(created.url, "M"))}\n`);
        console.log(`  ${created.url}\n`);
        if (unpublished) console.log(dim("The PWA doesn't look published on your tailnet: run `galahad expose` first, or pass --origin https://<where it's served>.\n"));
      } else console.log(`On the new machine run (valid 10 minutes, single use):\n\n  galahad join ${created.invite}\n`);
      if (flags["no-wait"]) return;
      console.log(dim("Waiting for the device…"));
      const deadline = created.expiresAt;
      while (Date.now() < deadline) {
        const { pairings } = await admin.call<{ pairings: { invite: string; device: string; name: string; kind: string; sas: string; conflict: boolean }[] }>(
          "pairings",
        );
        const pending = pairings.find((p) => p.invite === created.id);
        if (pending) {
          console.log(`\n  ${bold(pending.name)} (${pending.kind}) wants to join.\n  Code: ${bold(pending.sas)}\n`);
          if (confirm("Does the new device show exactly this code?")) {
            await admin.call("approvePairing", { invite: pending.invite, device: pending.device });
            console.log("Approved. Welcome to the fleet.");
          } else {
            await admin.call("rejectPairing", { invite: pending.invite, device: pending.device });
            console.log("Rejected.");
          }
          return;
        }
        await Bun.sleep(1000);
      }
      fail("invite expired");
    }

    case "pairings": {
      const { pairings } = await new Admin(home).call("pairings");
      if (!pairings.length) console.log("No pending pairings.");
      for (const p of pairings) console.log(`${p.sas}  ${p.name} (${p.kind})  invite=${p.invite} device=${p.device}${p.conflict ? "  ⚠ conflict" : ""}`);
      return;
    }
    case "approve":
    case "reject": {
      if (!sub || !rest[0]) fail(`usage: galahad ${command} <invite> <device>`);
      await new Admin(home).call(command === "approve" ? "approvePairing" : "rejectPairing", { invite: sub, device: rest[0] });
      console.log(command === "approve" ? "Approved." : "Rejected.");
      return;
    }
    case "revoke": {
      if (!sub) fail("usage: galahad revoke <device>");
      const fleet = await new Admin(home).call<FleetView>("fleet");
      const matches = activeDevicesMatching(fleet.devices, sub);
      if (!matches.length) fail(`no active device matches ${sub}`);
      // Never guess which device to cut off: several matches must be told apart by id.
      if (matches.length > 1) fail(`"${sub}" matches ${matches.length} devices; name one by its id:\n${matches.map((d) => `  ${d.id.slice(0, 12)}  ${d.name} (${d.kind})`).join("\n")}`);
      const target = matches[0]!;
      if (!confirm(`Revoke ${target.name} (${target.kind})? This rotates the vault.`)) return;
      const result = await new Admin(home).call("revokeDevice", { device: target.id, reason: str("reason") });
      console.log(`Revoked ${target.name}.`);
      if (result.resealed?.length) {
        console.log(`Vault rotated. ${target.name} could read these before; rotate them at the provider too:\n  ${result.resealed.join("\n  ")}`);
      }
      return;
    }

    case "grant": {
      // galahad grant <device> <scope…>: add permissions to a paired phone or browser.
      if (!sub || !rest.length) fail("usage: galahad grant <device name or id> <scope…>  (e.g. galahad grant iphone sandbox)");
      const admin = new Admin(home);
      const fleet = await admin.call<FleetView>("fleet");
      const matches = fleet.devices.filter(
        (d) => !d.revokedAt && d.kind === "client" && (d.id === sub || d.id.startsWith(sub) || d.name.toLowerCase().includes(sub.toLowerCase())),
      );
      if (!matches.length) fail(`no paired phone or browser matches "${sub}"`);
      // Never guess whom to give powers to: several matches must be told apart by id.
      const pairedOn = (hlc: string) => {
        const ms = Number(hlc.slice(0, 15));
        return Number.isFinite(ms) && ms > 0 ? new Date(ms).toISOString().slice(0, 10) : "?";
      };
      if (matches.length > 1 && !matches.some((d) => d.id === sub)) {
        fail(`"${sub}" matches ${matches.length} devices; name one by its id:\n${matches.map((d) => `  ${d.id.slice(0, 12)}  ${d.name}  paired ${pairedOn(d.enrolledAt)}  ${d.scopes.includes("bank:read") ? "(has bank:read)" : ""}`).join("\n")}`);
      }
      const target = matches.find((d) => d.id === sub) ?? matches[0]!;
      const scopes = [...new Set([...target.scopes, ...rest])];
      await admin.call("setDeviceScopes", { device: target.id, scopes });
      console.log(`${target.name} may now: ${scopes.join(", ")}`);
      return;
    }

    case "looks": {
      // His own looks (looks.ts): what he set himself to look at again, in your chats, until it comes.
      const admin = new Admin(home);
      if (sub === "cancel") {
        if (!rest[0]) fail("usage: galahad looks cancel <id>");
        const { look } = await admin.call<{ look: LookView }>("cancelLook", { id: rest[0] });
        console.log(`Called off: ${look.note}`);
        return;
      }
      if (sub) fail("usage: galahad looks [cancel <id>]");
      const { looks } = await admin.call<{ looks: LookView[] }>("looks");
      if (!looks.length) console.log(dim("No looks of his wait. He sets one in a chat when something isn't done yet (a deploy, a reply), and looks again then."));
      // When, as he said it: in the zone he was told, never this machine's locale.
      for (const look of looks) console.log(`  ${bold(lookTime(look.at, look.zone, Date.now()))}  ${look.note}  ${dim(`${look.id} · ${look.zone}`)}`);
      return;
    }

    case "away": {
      // While you were away (PLAN #37): --since 6h, 30m or 2d (the last day when not said).
      const raw = str("since") ?? "1d";
      const match = /^(\d+)\s*(m|h|d)$/.exec(raw);
      if (!match) fail("usage: galahad away [--since 30m | 6h | 2d]");
      const since = Date.now() - Number(match![1]) * { m: 60_000, h: 3_600_000, d: 86_400_000 }[match![2] as "m" | "h" | "d"];
      const { lines } = await new Admin(home).call<AwayView>("away", { since });
      if (!lines.length) console.log(dim(`Nothing happened since ${new Date(since).toLocaleString()}.`));
      const mark = { ok: "✓", danger: "✗", warn: "!", neutral: "·" } as const;
      for (const line of lines) console.log(`  ${mark[line.tone]} ${line.tone === "neutral" ? line.text : bold(line.text)}`);
      return;
    }

    case "live": {
      // What your devices' live stream tells (core's live.ts): the topics they read again, as they change.
      const at = () => new Date().toLocaleTimeString([], { hour12: false });
      for await (const event of new Admin(home).stream<LiveEvent>("live", undefined)) {
        if (event.type === "hello") console.log(`${dim(at())}  telling of ${event.topics.join(", ")}`);
        else if (event.type === "changed") console.log(`${dim(at())}  changed: ${event.topics.join(", ")}`);
        else console.log(`${dim(at())}  ended: ${event.reason === "stopping" ? "the node is stopping" : event.reason}`);
      }
      return;
    }

    case "status": {
      const fleet = await new Admin(home).call<FleetView>("fleet");
      const peers = new Map(fleet.peers.map((p) => [p.device, p]));
      console.log(`${bold(`Fleet ${fleet.name}`)}  ${dim(fleet.fleet.slice(0, 12))}  events=${fleet.events}  digest=${fleet.digest.slice(0, 10)}`);
      for (const d of fleet.devices) {
        const caps = d.caps as Record<string, any> | null;
        const peer = peers.get(d.id);
        const state = d.revokedAt ? "revoked" : d.id === fleet.self ? "this node" : d.kind === "client" ? "client" : peer?.online ? `online ${peer.rttMs}ms` : "offline";
        const summary = caps
          ? `${caps.os}/${caps.arch} ${caps.cores}c ${caps.memoryGb}GB${caps.gpu?.length ? ` gpu:${caps.gpu[0].name}` : ""}${caps.docker ? " docker" : ""}${caps.vm?.kvm ? " kvm" : ""}${caps.localModels?.some((r: any) => r.models.length) ? " local-ai" : ""}`
          : "";
        console.log(`  ${d.name.padEnd(18)} ${d.kind.padEnd(6)} ${state.padEnd(14)} ${dim(summary)}`);
      }
      await statusLine(new Admin(home));
      return;
    }

    case "remember": {
      const text = [sub, ...rest].filter(Boolean).join(" ");
      if (!text) fail("usage: galahad remember <text>");
      await new Admin(home).call("remember", { text, tags: flags.tag as string[] | undefined });
      console.log("Remembered.");
      return;
    }
    case "about": {
      // What he knows of you: the facts you kept (they go with every answer of his) and the ones he proposed (they wait for you).
      const admin = new Admin(home);
      const facts = async () => (await admin.call("aboutYou")) as { kept: MemoryView[]; proposed: MemoryView[] };
      const which = async (ref: string | undefined): Promise<MemoryView> => {
        if (!ref) fail(`usage: galahad about ${sub} <id>`);
        const { kept, proposed } = await facts();
        const found = [...kept, ...proposed].filter((m) => m.id === ref || m.id.startsWith(ref!));
        if (found.length !== 1) fail(found.length ? `"${ref}" names more than one fact: give more of its id` : `no fact about you is "${ref}" (galahad about lists them)`);
        return found[0]!;
      };
      if (!sub || sub === "ls") {
        const { kept, proposed } = await facts();
        if (!kept.length && !proposed.length) console.log("He keeps nothing about you yet. Tell him in chat, or: galahad about add <fact>");
        if (kept.length) console.log(bold("Kept: with every answer of his"));
        for (const m of kept) console.log(`  ${dim(m.id.slice(0, 12))}  ${m.text}`);
        if (proposed.length) console.log(bold("Proposed by him: waiting for you"));
        for (const m of proposed) console.log(`  ${dim(m.id.slice(0, 12))}  ${m.text}`);
        if (proposed.length) console.log(dim("  galahad about keep <id> [--text …] keeps one (in your words) · galahad about rm <id> drops it"));
        return;
      }
      if (sub === "add") {
        const text = rest.join(" ").trim();
        if (!text) fail("usage: galahad about add <fact>");
        await admin.call("remember", { text, tags: [ABOUT_YOU_TAG] });
        console.log("Kept: it goes with every answer of his.");
        return;
      }
      if (sub === "keep") {
        const fact = await which(rest[0]);
        await admin.call("keepAboutYou", { id: fact.id, ...(str("text") ? { text: str("text") } : {}) });
        console.log("Kept: it goes with every answer of his.");
        return;
      }
      if (sub === "rm") {
        await admin.call("forget", { id: (await which(rest[0])).id });
        console.log("Removed: it goes with his answers no more.");
        return;
      }
      fail("usage: galahad about [add <fact> | keep <id> [--text …] | rm <id>]");
      return;
    }
    case "recall": {
      const q = [sub, ...rest].filter(Boolean).join(" ");
      const { memories } = await new Admin(home).call("recall", { q: q || undefined, limit: 20 });
      if (!memories.length) console.log("Nothing remembered yet.");
      for (const m of memories) console.log(`• ${m.text}${m.tags.length ? dim(`  #${m.tags.join(" #")}`) : ""}${m.trust !== "owner" ? dim(`  [${m.trust}]`) : ""}`);
      return;
    }

    case "key": {
      if (sub !== "add") fail("usage: galahad key add [--provider id]");
      // Recognised, sealed and its provider configured (key-cli.ts).
      await keyAddCommand(new Admin(home), await readSecret("Paste the API key (hidden): "), flags, console.log, dim);
      return;
    }

    case "telegram": {
      const admin = new Admin(home);
      if (sub === "connect") {
        console.log("Make a bot with @BotFather in Telegram (/newbot), and paste the token it gives you.");
        const token = await readSecret("The bot's token (hidden): ");
        const connected = await admin.call<{ bot: string; code: string; expires: number; node: string }>("telegramConnect", { token });
        console.log(`Connected ${bold(connected.bot)} on ${connected.node}: its token is sealed in the vault, and it answers as a device of its own that may chat.`);
        console.log(`Now send it this from your own Telegram account, within 15 minutes (it answers nobody else):\n\n  /start ${bold(connected.code)}\n`);
        return;
      }
      if (sub === "disconnect") {
        if (!flags.yes && !confirm("Disconnect Telegram? Its device is revoked and its token deleted; the chats stay yours.")) return;
        await admin.call("telegramDisconnect", {});
        console.log("Disconnected.");
        return;
      }
      if (sub) fail("usage: galahad telegram [connect | disconnect]");
      const { telegram } = await admin.call<{ telegram: TelegramView }>("telegram");
      if (!telegram.connected) console.log("Not connected on this node. galahad telegram connect links a bot of yours.");
      else {
        console.log(`${bold(telegram.bot ?? "a bot")} on ${telegram.node}: ${telegram.owner ? `answers ${telegram.owner}, and nobody else` : telegram.linkExpires ? `waiting for your code (until ${new Date(telegram.linkExpires).toLocaleTimeString()})` : "no account linked: galahad telegram connect gives a new code"}.`);
        if (telegram.problem) console.log(bold(telegram.problem));
      }
      return;
    }

    case "slack": {
      if (sub === "manifest") {
        console.log(JSON.stringify(SLACK_APP_MANIFEST, null, 2));
        return;
      }
      const admin = new Admin(home);
      if (sub === "connect") {
        console.log("Make the app at api.slack.com/apps: Create New App → From a manifest, your workspace, and what galahad slack manifest prints; then Install to Workspace.");
        console.log("Its two tokens: Basic Information → App-Level Tokens → Generate (with connections:write) makes the first; OAuth & Permissions has the Bot User OAuth Token.");
        // (Not a terminal: the two tokens, a line each, from standard input.)
        const [appToken, botToken] = process.stdin.isTTY
          ? [await readSecret("The app-level token, xapp-… (hidden): "), await readSecret("The bot token, xoxb-… (hidden): ")]
          : (await Bun.stdin.text()).split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
        if (!appToken || !botToken) fail("both tokens are needed: the app-level token (xapp-…) and the bot token (xoxb-…)");
        const connected = await admin.call<{ bot: string; workspace: string; code: string; expires: number; node: string }>("slackConnect", { appToken, botToken });
        console.log(`Connected ${bold(connected.bot)} in ${connected.workspace} on ${connected.node}: its tokens are sealed in the vault, and it answers as a device of its own that may chat.`);
        console.log(`Now send it this in a direct message from your own Slack account, within 15 minutes (it answers nobody else):\n\n  ${bold(connected.code)}\n`);
        return;
      }
      if (sub === "disconnect") {
        if (!flags.yes && !confirm("Disconnect Slack? Its device is revoked and its tokens deleted; the chats stay yours.")) return;
        await admin.call("slackDisconnect", {});
        console.log("Disconnected.");
        return;
      }
      if (sub) fail("usage: galahad slack [manifest | connect | disconnect]");
      const { slack } = await admin.call<{ slack: SlackView }>("slack");
      if (!slack.connected) console.log("Not connected on this node. galahad slack connect links an app of yours (galahad slack manifest says what to make).");
      else {
        console.log(`${bold(slack.bot ?? "an app")} in ${slack.workspace ?? "your workspace"} on ${slack.node}: ${slack.owner ? `answers ${slack.owner}, and nobody else` : slack.linkExpires ? `waiting for your code (until ${new Date(slack.linkExpires).toLocaleTimeString()})` : "no account linked: galahad slack connect gives a new code"}.`);
        if (slack.problem) console.log(bold(slack.problem));
      }
      return;
    }

    case "secret": {
      const admin = new Admin(home);
      if (sub === "set") {
        if (!rest[0]) fail("usage: galahad secret set <name>");
        const value = await readSecret(`Value for ${rest[0]} (hidden): `);
        // (--base-url pins it to that address: the one place it may ever be sent, as for a knight's key, PLAN #17.)
        await admin.call("setSecret", { name: rest[0], value, provider: str("provider"), label: str("label"), connector: str("connector"), ...(str("base-url") ? { baseUrl: str("base-url") } : {}) });
        console.log(str("base-url") ? `Sealed into the vault, pinned to ${new URL(str("base-url")!).origin}.` : "Sealed into the vault.");
      } else if (sub === "rm") {
        if (!rest[0]) fail("usage: galahad secret rm <name>");
        if (!confirm(`Delete secret ${rest[0]} from every node?`)) return;
        await admin.call("deleteSecret", { name: rest[0] });
        console.log("Deleted.");
      } else if (sub === "request") {
        if (!rest[0] || !str("reason")) fail('usage: galahad secret request <name> --reason "what it is for" [--provider id]');
        await admin.call("requestSecret", { name: rest[0], purpose: str("reason"), provider: str("provider") });
        console.log(`Requested. Fill it with \`galahad secret set ${rest[0]}\` or on the PWA's Vault page.`);
      } else if (sub === "dismiss") {
        if (!rest[0]) fail("usage: galahad secret dismiss <name>");
        await admin.call("dismissSecretRequest", { name: rest[0] });
        console.log("Dismissed: it's back in your Inbox only if he asks for it again.");
      } else {
        const [{ secrets, unlocked }, { requests }] = await Promise.all([admin.call("secrets"), admin.call("secretRequests")]);
        if (!unlocked) console.log(dim("(this node cannot decrypt the vault)"));
        for (const s of secrets) console.log(`  ${s.name.padEnd(20)} ${(s.provider ?? "").padEnd(14)} ${s.hint ?? ""}`);
        if (!secrets.length) console.log("The vault is empty. `galahad key add` to add one.");
        for (const r of requests) console.log(`  ${bold("requested")} ${r.name.padEnd(20)} ${dim(r.purpose)}`);
        if (requests.length) console.log(dim("Fill one: galahad secret set <name> · dismiss one: galahad secret dismiss <name>"));
      }
      return;
    }

    case "run": {
      // galahad run [--providers deepseek,anthropic] [--ttl 120] -- opencode …
      const cmd = [sub, ...rest].filter((part): part is string => typeof part === "string");
      if (!cmd.length) fail("usage: galahad run [--providers a,b] [--ttl minutes] -- <command> [args…]");
      const admin = new Admin(home);
      const providers = str("providers")?.split(",").filter(Boolean);
      const minted = await admin.call<{ token: string; info: { hash: string } }>("mintToken", {
        // The tool's name, not its path (a label holds at most 64 characters).
        label: `run:${basename(cmd[0]!).slice(0, 60)}`,
        ...(providers ? { providers } : {}),
        ttlMinutes: Number(str("ttl") ?? 240),
        maxRequests: Number(str("max") ?? 100_000),
      });
      const gateway = `${admin.base}/gw`;
      const openaiProvider = providers?.find((p) => p !== "anthropic") ?? "deepseek";
      const env: Record<string, string | undefined> = {
        ...process.env,
        GALAHAD_GATEWAY: gateway,
        ANTHROPIC_BASE_URL: `${gateway}/anthropic`,
        ANTHROPIC_AUTH_TOKEN: minted.token,
        OPENAI_BASE_URL: `${gateway}/${openaiProvider}`,
        OPENAI_API_KEY: minted.token,
      };
      delete env.ANTHROPIC_API_KEY;
      process.stderr.write(dim(`[galahad] ${cmd[0]} gets a scoped gateway token (revoked on exit); real keys stay in the vault\n`));
      // Revoked when the tool exits, however galahad run is stopped (see run-tool.ts).
      const start = () => Bun.spawn(cmd, { env, stdin: "inherit", stdout: "inherit", stderr: "inherit" });
      process.exit(await runWithToken(start, () => admin.call("revokeToken", { hash: minted.info.hash })));
    }
    case "awake": {
      // A Mac set to stay on (a Mac mini serving the fleet) is kept from sleeping while its node runs (keep-awake.ts).
      if (!existsSync(home.configPath)) fail("this machine isn't a node yet: galahad init, or galahad join <invite>");
      const config = home.readConfig();
      const mac = process.platform === "darwin";
      if (sub === "on" || sub === "off") {
        home.writeConfig({ ...config, keepAwake: sub === "on" });
        if (sub === "off") console.log("It may sleep again once the node next starts.");
        else if (mac) console.log("This Mac will be kept awake while its node runs, from the node's next start (the app restarts it; a node install.sh made: launchctl kickstart -k gui/$(id -u)/sh.galahad.node).");
        else console.log("Kept on. Only a Mac is kept awake this way: a Linux server doesn't sleep.");
        return;
      }
      if (sub && sub !== "status") fail("usage: galahad awake on|off|status");
      const fleet = await new Admin(home).call<FleetView>("fleet").catch(() => null);
      const self = fleet?.devices.find((d) => d.id === fleet.self);
      const holding = self?.caps ? self.caps.awake === true : null;
      console.log(`keep-awake: ${config.keepAwake ? "on" : "off"}${holding === null ? " (the node isn't running, or didn't say)" : holding ? " · the running node is keeping this Mac awake" : config.keepAwake ? " · the running node isn't holding it yet: restart it" : ""}`);
      return;
    }

    case "screen": {
      // A Mac's own screen (mac-screen.ts): the node that has one answers, here or as `--on` names it.
      const at = str("on") ? { on: str("on")! } : {};
      const admin = new Admin(home);
      const say = (s: ScreenStatus) =>
        console.log(
          `${s.width}×${s.height} points · recording the screen: ${s.record ? "allowed" : "not allowed yet"} · controlling the Mac: ${s.control ? "allowed" : "not allowed yet"}${s.front ? ` · in front: ${s.front}` : ""}${s.asking ? ` · macOS is asking a question there (${s.asking}): yours to answer, at that Mac` : ""}`,
        );
      if (!sub || sub === "status") {
        const s = await admin.call<ScreenStatus>("screen", at);
        say(s);
        if (!s.record || !s.control) console.log(dim("galahad screen allow shows macOS's prompts on that Mac; turn both on there, in System Settings → Privacy & Security."));
        return;
      }
      if (sub === "allow") {
        say(await admin.call<ScreenStatus>("screenAllow", at));
        console.log(dim("On that Mac, System Settings → Privacy & Security: turn Galahad on in Screen & System Audio Recording, and in Accessibility. Then galahad screen says both are allowed."));
        return;
      }
      if (sub === "look") {
        const view = await admin.call<ScreenView>("screenDesktop", { ...at, action: { do: "look" } });
        const out = str("out") ?? "screen.jpg";
        writeFileSync(out, Buffer.from(view.shot.data, "base64"));
        console.log(`${out}: ${view.width}×${view.height}`);
        return;
      }
      if (sub === "sessions") {
        const { sessions } = await admin.call<{ sessions: ScreenSessionView[] }>("screenSessions");
        if (!sessions.length) console.log("He hasn't asked to use a Mac itself.");
        for (const s of sessions) {
          const until = s.state === "allowed" && s.until ? ` · his until ${new Date(s.until).toLocaleTimeString()}` : s.state === "waiting" ? ` · answer by ${new Date(s.answerBy).toLocaleTimeString()}` : "";
          console.log(`${s.id}  ${s.state.padEnd(8)} ${s.nodeName} · ${s.minutes} minutes${until}\n  ${dim(s.why)}`);
        }
        return;
      }
      if (sub === "approve" || sub === "deny") {
        if (!rest[0]) fail(`usage: galahad screen ${sub} <session>`);
        const { session } = await admin.call<{ session: ScreenSessionView }>("decideScreen", { id: rest[0], allow: sub === "approve" });
        console.log(session.state === "allowed" ? `Allowed: Galahad may use ${session.nodeName} itself until ${new Date(session.until!).toLocaleTimeString()}. galahad screen end ${session.id} ends it sooner.` : "Said no: nothing of it is his.");
        return;
      }
      if (sub === "end") {
        if (!rest[0]) fail("usage: galahad screen end <session>");
        await admin.call("endScreen", { id: rest[0] });
        console.log("Ended: nothing of that Mac is his now.");
        return;
      }
      fail("usage: galahad screen [status|allow|look] [--on <node>] [--out shot.jpg] | screen sessions | screen approve|deny|end <session>");
      return;
    }

    case "firewall": {
      // A Mac's sandbox firewall (firewall-cli.ts): no node home is needed for it, and none is touched as root.
      process.exitCode = await firewallCommand(sub, systemFirewallDeps());
      return;
    }

    case "vault": {
      if (sub !== "rotate") fail("usage: galahad vault rotate");
      const result = await new Admin(home).call("rotateVault", {});
      console.log(`New vault key ${result.kid}; resealed ${result.resealed.length} secrets.`);
      return;
    }

    case "provider": {
      const admin = new Admin(home);
      if (sub === "add") {
        if (!rest[0]) fail("usage: galahad provider add <id>");
        const { providers } = await admin.call<{ providers: ProviderView[] }>("setProvider", {
          id: rest[0],
          preset: str("preset"),
          baseUrl: str("base-url"),
          kind: str("kind"),
          secret: str("secret") ?? rest[0],
          label: str("label"),
        });
        console.log(`Provider ${rest[0]} configured.`);
        const elsewhere = keyElsewhereLine(providers.find((p) => p.id === rest[0]) ?? { id: rest[0], baseUrl: "" });
        if (elsewhere) console.log(elsewhere);
      } else if (sub === "models") {
        if (!rest[0]) fail("usage: galahad provider models <id>");
        const { models } = await admin.call("providerModels", { id: rest[0] });
        for (const m of models) console.log(`${rest[0]}/${m}`);
      } else if (sub === "presets") {
        const { presets } = await admin.call("providers");
        const wide = Math.max(14, ...presets.map((p: { id: string }) => p.id.length));
        for (const p of presets) console.log(`  ${p.id.padEnd(wide)} ${p.kind.padEnd(10)} ${p.baseUrl || dim(p.note ?? "")}${p.plan ? dim(`  coding plan: ${p.plan.name}`) : ""}`);
      } else {
        const { providers } = await admin.call("providers");
        if (!providers.length) console.log("No providers yet. `galahad key add` configures one.");
        const wide = Math.max(14, ...providers.map((p: { id: string }) => p.id.length));
        for (const p of providers as ProviderView[]) {
          console.log(`  ${p.id.padEnd(wide)} ${p.kind.padEnd(10)} ${p.hasKey ? "key ✓" : p.baseUrl.includes("127.0.0.1") ? "local" : "no key"}  ${dim(p.baseUrl)}${planOf(p.id) ? dim("  coding plan: for coding only") : ""}`);
          const elsewhere = keyElsewhereLine(p);
          if (elsewhere) console.log(dim(`  ${" ".repeat(wide)} ${elsewhere}`));
        }
      }
      return;
    }

    case "roster": {
      const admin = new Admin(home);
      if (sub === "set") {
        if (!rest[0] || rest.length < 2) fail("usage: galahad roster set <role> <provider/model>...");
        await admin.call("setRoster", { role: rest[0], models: rest.slice(1) });
      }
      if (sub === "effort") {
        // How hard a role's models think: by the step (auto, the default), or one level you choose.
        const levels = ["auto", ...THINKING_EFFORTS];
        if (rest.length !== 2 || !levels.includes(rest[1]!)) fail(`usage: galahad roster effort <role> <${levels.join("|")}>`);
        await admin.call("setRosterEffort", { role: rest[0], effort: rest[1] });
        console.log(rest[1] === "auto" ? `${rest[0]} thinks as each step needs: routine turns less, hard ones more.` : `${rest[0]} thinks at ${rest[1]}, whatever the step. galahad roster effort ${rest[0]} auto puts it back.`);
        return;
      }
      if (sub === "rm") {
        // A role you made goes (not while a knight works on it: the node says which); a built-in one goes back to its defaults.
        if (rest.length !== 1) fail("usage: galahad roster rm <role>");
        const { roster } = await admin.call<{ roster: Record<string, unknown> }>("setRoster", { role: rest[0], models: [] });
        console.log(roster[rest[0]!] ? `${rest[0]} is back to its default models.` : `${rest[0]} is removed.`);
        return;
      }
      if (sub === "check") {
        // What each model can do, measured: the quest loop's format, reading a screen, placing a click (about eight calls each).
        if (!rest.length) fail("usage: galahad roster check <provider/model>... [--only format,reads,places]");
        const only = typeof flags.only === "string" ? flags.only.split(",").map((p) => p.trim()).filter(Boolean) : [];
        for (const model of rest) {
          console.log(dim(`… checking ${model}`));
          const { check } = await admin.call<{ check: ModelCheck }>("checkModel", { model, ...(only.length ? { parts: only } : {}) });
          console.log(`  ${model}: ${checkFacts(check).join(" · ") || "nothing could be checked"}`);
        }
        return;
      }
      const { roster, spent = [], checks = {} } = await admin.call<{ roster: Record<string, { models: string[]; configured: boolean; custom?: boolean; effort?: string }>; spent?: { provider: string; until: number }[]; checks?: Record<string, ModelCheck> }>("roster");
      // (A coding plan's window is its id's, every model of it; any other provider's is its one model's: windowScope.)
      const spentUntilOf = (ref: string) => spent.find((w) => ref === w.provider || ref.startsWith(`${w.provider}/`));
      for (const [role, spec] of Object.entries(roster)) {
        // (A coding plan's model does his coding and the knights': he passes it over for anything else.)
        const shown = (ref: string) => {
          const window = spentUntilOf(ref);
          return [ref, onPlan(ref) ? dim("(coding only)") : "", window ? dim(`(spent until ${new Date(window.until).toISOString().slice(11, 16)} UTC)`) : ""].filter(Boolean).join(" ");
        };
        console.log(`  ${role.padEnd(10)} ${spec.models.map(shown).join(" → ")}${spec.configured ? "" : dim("  (default)")}${spec.custom ? dim("  (a role you made)") : ""}${spec.effort && spec.effort !== "auto" ? dim(`  (thinks at ${spec.effort})`) : ""}`);
      }
      // (Each call thinks as its step needs, unless you pinned its role: galahad roster effort <role> <level|auto>.)
      console.log(dim("  Each step thinks as it needs: routine turns less, hard ones more (galahad roster effort <role> <level|auto>)."));
      for (const window of spent) console.log(dim(`  ${window.provider}: its allowance is spent until ${new Date(window.until).toISOString().slice(11, 16)} UTC; ${window.provider.includes("/") ? "it is" : "its models are"} passed over until then, and the next on each role answers.`));
      const checked = Object.entries(checks);
      if (checked.length) {
        console.log(`\n  ${bold("Checked")} ${dim("(what each was seen to do: galahad roster check <provider/model>)")}`);
        for (const [model, check] of checked) console.log(`  ${model}: ${checkFacts(check).join(" · ")} ${dim(`· ${new Date(check.at).toISOString().slice(0, 10)}`)}`);
      }
      return;
    }

    case "ask": {
      const text = [sub, ...rest].filter(Boolean).join(" ");
      const attach = (flags.attach as string[] | undefined) ?? [];
      if (!text && !attach.length) fail("usage: galahad ask [--chat <id> [--steer | --queue | --aside [--bring]]] [--project <id>] [--temp] [--detach] [--attach file]... <prompt>");
      // The turn runs on the node (turn-cli.ts): this terminal watches it, Ctrl-C stops it, --detach leaves him to it.
      const code = await askCommand(new Admin(home), text, {
        role: str("role"),
        model: str("model"),
        chat: str("chat"),
        project: str("project"),
        temp: Boolean(flags.temp),
        steer: Boolean(flags.steer),
        queue: Boolean(flags.queue),
        aside: Boolean(flags.aside),
        bring: Boolean(flags.bring),
        detach: Boolean(flags.detach),
        ...(attach.length ? { attach } : {}),
      });
      if (code) process.exit(code);
      return;
    }

    case "turns":
    case "turn":
      await turnsCommand(new Admin(home), command === "turns" ? undefined : sub, rest);
      return;

    case "queue":
      await queueCommand(new Admin(home), sub, rest[0], rest.slice(1));
      return;

    case "quests":
      await questsCommand(new Admin(home), Boolean(flags.all));
      return;

    case "chats": {
      const { conversations } = await new Admin(home).call<{ conversations: ConversationSummary[] }>("conversations");
      const shown = conversations.filter((c) => !str("project") || c.project === str("project"));
      if (!shown.length) console.log(str("project") ? `No chats in ${str("project")}.` : "No chats yet. `galahad ask …` starts one.");
      for (const c of shown) {
        // Where each stands, at a glance: working, needs you, queued, stopped, failed (nothing to say when it's done); and
        // whether an answer in it is new to you (read it with galahad chat <id>, or on any device).
        const state = chatStateWords(c);
        console.log(`${c.pinned ? "★ " : "  "}${c.title}  ${c.unread ? `${bold("new")}  ` : ""}${state ? `${bold(state)}  ` : ""}${dim(`${c.id} · ${c.count} messages · ${new Date(c.updatedAt).toLocaleString()}${c.project ? ` · ${c.project}` : ""}${c.bank ? " · bank" : ""}`)}`);
      }
      return;
    }

    case "chat": {
      const admin = new Admin(home);
      if (sub === "rm") {
        if (!rest[0]) fail("usage: galahad chat rm <id>");
        if (!flags.yes && !confirm("Delete this chat for good?")) return;
        const { deleted } = await admin.call<{ deleted: boolean }>("deleteConversation", { id: rest[0] });
        console.log(deleted ? "Deleted." : "No such chat.");
        return;
      }
      if (!sub) fail("usage: galahad chat <id> | galahad chat rm <id>   (galahad chats lists them)");
      const { conversation } = await admin.call<{ conversation: ConversationView }>("conversation", { id: sub });
      console.log(`${bold(conversation.title)}  ${dim(`${conversation.id}${conversation.project ? ` · project ${conversation.project}` : ""}`)}\n`);
      const here = Intl.DateTimeFormat().resolvedOptions().timeZone;
      for (const m of conversation.messages) {
        // A look of his come back is his own note, as every app shows it: never your words.
        if (m.role === "user" && m.look) console.log(`${dim(`He looked again, as he said at ${lookTime(m.look.set, here, Date.now())} he would: ${m.look.note}`)}\n`);
        else if (m.role === "user") console.log(`${bold("You:")} ${m.content}\n`);
        else {
          const tools = m.steps.filter((s) => s.kind === "tool").map((s) => (s.kind === "tool" ? s.title : ""));
          console.log(`${bold("Galahad:")} ${m.content || dim(`(${m.status}${m.error ? `: ${m.error}` : ""})`)}`);
          console.log(dim(`  ${[m.model, tools.length ? `tools: ${tools.join(", ")}` : null].filter(Boolean).join(" · ")}\n`));
        }
      }
      // What he's doing in it now, and what you queued behind it.
      if (conversation.turn) console.log(`${bold("He's working on it now:")} ${turnLine(conversation.turn, Date.now())}\n${dim(`  galahad turn watch ${conversation.turn.id} · galahad turn stop ${conversation.turn.id} · galahad ask --chat ${conversation.id} --steer|--queue "…"`)}\n`);
      if (conversation.queue.length) console.log(`${queueLines(conversation.queue, conversation.held).join("\n")}\n${dim(`  galahad queue ${conversation.id} [resume | rm <n|all> | send <n>]`)}\n`);
      console.log(dim(`Go on with: galahad ask --chat ${conversation.id} "…"`));
      // Read here: what he answered in it is no longer new, on any device.
      if (conversation.unread) await admin.call("seeConversation", { id: conversation.id }).catch(() => {});
      return;
    }

    case "projects": {
      const { projects } = await new Admin(home).call<{ projects: ProjectView[] }>("projects");
      if (!projects.length) console.log('No projects yet. `galahad project set <id> --name "…" --instructions "…"` starts one.');
      for (const p of projects) console.log(`  ${p.id.padEnd(20)} ${p.name}${p.repo ? dim(`  ${p.repo}`) : ""}${p.instructions ? dim(`\n  ${"".padEnd(20)} ${p.instructions.split("\n")[0]!.slice(0, 100)}`) : ""}`);
      return;
    }

    case "project": {
      const admin = new Admin(home);
      if (sub === "git" || sub === "branch" || sub === "commit" || sub === "clone" || sub === "changes") {
        const id = rest[0];
        if (!id) fail(`usage: galahad project ${sub} <id>${sub === "branch" ? " <name> [--new]" : sub === "commit" ? ' --message "…"' : ""}`);
        if (sub === "changes") {
          const { projects } = await admin.call<{ projects: ProjectView[] }>("projects");
          const project = projects.find((p) => p.id === id);
          if (!project) fail(`no project ${id}`);
          const changes = await admin.call<TeamChangesView>("teamChanges", { id: "galahad", path: project!.checkout });
          if (!changes.files.length && !changes.untracked.length) console.log(`Nothing changed in ${project!.checkout} since its last commit.`);
          for (const f of changes.files) console.log(`  ${f.status}  ${f.path}${f.added === null ? dim("  binary") : dim(`  +${f.added} −${f.removed}`)}`);
          for (const f of changes.untracked) console.log(`  ?  ${f}`);
          return;
        }
        const view =
          sub === "git"
            ? await admin.call<ProjectGitView>("projectGit", { id })
            : sub === "clone"
              ? await admin.call<ProjectGitView>("projectClone", { id })
              : sub === "branch"
                ? await admin.call<ProjectGitView>("projectBranch", { id, branch: rest[1] ?? fail("usage: galahad project branch <id> <name> [--new]"), create: flags.new === true })
                : await admin.call<ProjectGitView>("projectCommit", { id, message: str("message") ?? fail('usage: galahad project commit <id> --message "…"') });
        if (view.state === "missing") console.log(`${view.checkout} isn't there yet: galahad project clone ${id}, or ask Galahad to start it.`);
        else if (view.state === "not-a-repository") console.log(`${view.checkout} is there, but it isn't a git repository.`);
        else {
          const against = view.upstream ? dim(` · ${view.ahead ?? 0} ahead, ${view.behind ?? 0} behind ${view.upstream}`) : "";
          console.log(`${bold(view.branch ?? "(no branch)")} at ${view.head ?? "?"} · ${view.changed ? `${view.changed} changed` : "nothing to commit"}${against}  ${dim(view.checkout)}`);
          for (const c of view.log.slice(0, 5)) console.log(dim(`  ${c.sha}  ${c.subject}`));
        }
        return;
      }
      if (sub === "rm") {
        if (!rest[0]) fail("usage: galahad project rm <id>");
        if (!flags.yes && !confirm(`Remove project ${rest[0]}? Its chats stay, outside any project.`)) return;
        await admin.call("removeProject", { id: rest[0] });
        console.log("Removed.");
        return;
      }
      if (sub !== "set" || !rest[0]) fail('usage: galahad project set <id> --name "…" [--instructions "…" | --instructions-file path] [--repo https://…]   ·   galahad project rm <id>');
      const file = str("instructions-file");
      const instructions = file ? readFileSync(file, "utf8") : str("instructions");
      const { projects } = await admin.call<{ projects: ProjectView[] }>("projects");
      const existing = projects.find((p) => p.id === rest[0]);
      const name = str("name") ?? existing?.name;
      if (!name) fail("a new project needs --name");
      const { project } = await admin.call<{ project: ProjectView }>("setProject", {
        id: rest[0],
        name,
        ...(instructions !== undefined ? { instructions } : {}),
        ...(str("repo") !== undefined ? { repo: str("repo") || null } : {}),
      });
      console.log(`${bold(project.name)} (${project.id})${project.repo ? `  ${project.repo}` : ""}\n${dim("Chat in it: galahad ask --project " + project.id + ' "…", or the app\'s Projects page.')}`);
      return;
    }

    case "token": {
      if (sub !== "mint") fail("usage: galahad token mint --label <name>");
      const result = await new Admin(home).call("mintToken", {
        label: str("label") ?? "arm",
        providers: str("providers")?.split(",").filter(Boolean),
        ttlMinutes: Number(str("ttl") ?? 60),
        maxRequests: Number(str("max") ?? 1000),
      });
      console.log(`Gateway token (shown once): ${result.token}\n`);
      for (const [k, v] of Object.entries(result.env)) console.log(`  ${k}=${v}`);
      return;
    }

    case "do": {
      const goal = [sub, ...rest].filter(Boolean).join(" ").trim();
      if (!goal) fail('usage: galahad do [--net isolated|gateway|online] [--vm|--container] [--lab] [--on node] [--steps 30] [--timeout 300] [--keep] [--budget-usd 2] [--agent opencode --minutes 60 --repo url] "<goal>"');
      const budgetUsd = str("budget-usd") === undefined ? undefined : Number(str("budget-usd"));
      if (budgetUsd !== undefined && (!Number.isFinite(budgetUsd) || budgetUsd <= 0 || budgetUsd > 100)) fail("--budget-usd takes an amount in US dollars above 0 and at most 100, e.g. --budget-usd 2");
      const agentName = str("agent");
      // An agent calls models itself, so it needs at least the gateway.
      const network = str("net") ?? (agentName ? "gateway" : "isolated");
      if (!["isolated", "gateway", "online"].includes(network)) fail("--net must be isolated, gateway or online");
      const minutes = Number(str("minutes") ?? 60);
      if (agentName && (!Number.isInteger(minutes) || minutes < 1 || minutes > 7 * 24 * 60)) fail("--minutes must be a whole number from 1 to 10080");
      const repo = str("repo");
      if (repo && !agentName) fail("--repo goes with --agent");
      if (repo && !/^https:\/\/[A-Za-z0-9._~:/?#!$&()*+,;=%-]+$/.test(repo)) fail("--repo must be an https:// URL (no user or password in it)");
      if (flags.ship && !(repo && githubRepo(repo))) fail("--ship needs --repo https://github.com/<owner>/<repo>");
      let effort: ReturnType<typeof parseEffort>;
      let gates: string[];
      try {
        effort = parseEffort(str("effort"));
        // Gates are checked before anything is created: commands only, a few, nothing key-shaped.
        gates = checkGates((flags.gate as string[] | undefined) ?? []);
      } catch (error) {
        fail((error as Error).message);
      }
      const outcome = await questFromCli(new Admin(home), {
        goal,
        ...(gates.length ? { gates } : {}),
        // The planner may propose gates of its own (marked as its proposal) unless you say yours only.
        proposeGates: !flags["no-planner-gates"],
        network: network as "isolated" | "gateway" | "online",
        ...(isolation() ? { isolation: isolation() } : {}),
        ...(flags.lab ? { lab: true } : {}),
        on: str("on"),
        maxSteps: str("steps") ? Number(str("steps")) : undefined,
        commandTimeoutSec: str("timeout") ? Number(str("timeout")) : undefined,
        keep: Boolean(flags.keep),
        // The engineer's own tools, several calls a turn (measured +7 over the fenced loop, level with OpenCode: TRIALS.md);
        // --fenced keeps one shell command a reply.
        ...(flags.fenced ? {} : { tools: true }),
        ...(budgetUsd !== undefined ? { budgetUsd } : {}),
        ...(effort !== undefined ? { effort } : {}),
        ...(agentName ? { agent: { name: agentName, minutes, ...(repo ? { repo } : {}) } } : {}),
        ...(flags.ship
          ? { ship: { ...(str("title") ? { title: str("title") } : {}), ...(str("base") ? { base: str("base") } : {}), ...(flags.draft ? { draft: true } : {}), ...(str("connector") ? { connector: str("connector") } : {}) } }
          : {}),
      });
      process.exit(outcome.status === "done" ? 0 : 1);
    }

    case "investigate": {
      const question = [sub, ...rest].filter(Boolean).join(" ").trim();
      if (!question) fail('usage: galahad investigate [--net isolated|gateway|online] [--workshop] [--vm|--container] [--on node] [--steps 40] [--timeout 600] [--keep] "<question>"');
      const network = str("net") ?? "isolated";
      if (!["isolated", "gateway", "online"].includes(network)) fail("--net must be isolated, gateway or online");
      const result = await investigateFromCli(new Admin(home), {
        question,
        network: network as "isolated" | "gateway" | "online",
        ...(isolation() ? { isolation: isolation() } : {}),
        ...(flags.workshop ? { workshop: true } : {}),
        on: str("on"),
        maxSteps: str("steps") ? Number(str("steps")) : undefined,
        commandTimeoutSec: str("timeout") ? Number(str("timeout")) : undefined,
        keep: Boolean(flags.keep),
      });
      process.exit(result.conclusion ? 0 : 1);
    }

    case "findings":
    case "finding": {
      const { investigations } = (await new Admin(home).call("investigations")) as { investigations: InvestigationView[] };
      const mark: Record<string, string> = { supported: "✓", refuted: "✗", inconclusive: "△" };
      if (command === "findings" || !sub) {
        if (!investigations.length) console.log('No investigations yet: galahad investigate "<question>"');
        for (const i of investigations) {
          const state = i.conclusion ? `${mark[i.conclusion]} ${i.conclusion}` : i.status;
          console.log(`  ${i.id}  ${state.padEnd(15)} ${dim(new Date(i.registeredAt).toLocaleString())}`);
          console.log(`      ${i.question.length > 110 ? `${i.question.slice(0, 110)}…` : i.question}`);
        }
        return;
      }
      const i = investigations.find((x) => x.id === sub);
      if (!i) fail(`no investigation ${sub}`);
      const r = i!.registration;
      console.log(`${bold(i!.question)}
${dim(`${i!.id} · registered ${new Date(i!.registeredAt).toLocaleString()} on ${i!.nodeName}, before anything ran`)}`);
      if (r) {
        console.log(`
Hypothesis: ${r.hypothesis}
Alternative: ${r.alternative}`);
        for (const p of r.predictions) {
          const got = i!.predictions.find((x) => x.id === p.id);
          const value = got && typeof got.value === "number" ? ` → ${got.value}${got.units ? ` ${got.units}` : ""}${typeof got.uncertainty === "number" ? ` ± ${got.uncertainty}` : ""}` : "";
          console.log(`  ${p.id}. ${p.statement}
      expected ${p.expected}; refuted if ${p.refutedIf}${got ? `
      ${bold(got.verdict)}${value}` : ""}`);
        }
        console.log(`Verification: ${r.verification.join("; ")}`);
        console.log(`Decision rule: ${r.decision}`);
      }
      console.log(`
${i!.conclusion ? bold(`${mark[i!.conclusion]} ${i!.conclusion.toUpperCase()}`) : bold(i!.status)}${i!.summary ? `
${i!.summary}` : ""}`);
      if (i!.review) console.log(`
Reviewer:
${i!.review}`);
      if (i!.artifact) console.log(dim(`
Evidence: galahad artifact ${i!.artifact}`));
      return;
    }

    case "decide": {
      // One question from the command line: yes/no by default, a choice with --options, a score with --levels.
      const state = [sub, ...rest].filter(Boolean).join(" ").trim();
      const question = str("question");
      if (!state || !question) fail('usage: galahad decide "<state>" --question "<question>" [--options a,b,c | --levels low,medium,high]');
      const options = str("options")?.split(",").map((o) => o.trim()).filter(Boolean);
      const levels = str("levels")?.split(",").map((l) => l.trim()).filter(Boolean);
      const q = options?.length
        ? { type: "choice", instructions: question, criteria: Object.fromEntries(options.map((o) => [o, null])) }
        : levels?.length
          ? { type: "score", instructions: question, criteria: levels }
          : { type: "noul", instructions: question };
      const view = (await new Admin(home).call("decide", { state, questions: { answer: q } })) as { ref: string; model: string; answers: Record<string, any> };
      const a = view.answers.answer;
      if (a?.type === "noul") console.log(`${bold(a.noul >= 0.5 ? "yes" : "no")}  ${dim(`p(yes) = ${a.noul}`)}`);
      else if (a?.type === "choice") console.log(`${bold(a.choice)}  ${dim(`confidence ${a.confidence} · ${JSON.stringify(a.probabilities)}`)}`);
      else if (a?.type === "score") console.log(`${bold(String(a.score))} ${dim(`(0 = ${levels![0]}) · confidence ${a.confidence} · ${JSON.stringify(a.probabilities)}`)}`);
      else console.log(JSON.stringify(view.answers, null, 2));
      console.log(dim(`${view.model} via ${view.ref}`));
      return;
    }

    case "search": {
      const q = [sub, ...rest].filter(Boolean).join(" ").trim();
      if (!q) fail('usage: galahad search "<words>" [--page 2]');
      const page = str("page") ? Number(str("page")) : undefined;
      const { results, suggestions } = (await new Admin(home).call("webSearch", { q, ...(page ? { page } : {}) })) as {
        results: { title: string; url: string; snippet: string; engines: string[] }[];
        suggestions: string[];
      };
      if (!results.length) console.log(`No results for "${q}".`);
      for (const [i, r] of results.entries()) {
        console.log(`${bold(`${i + 1}. ${r.title}`)}\n   ${r.url}${r.snippet ? `\n   ${dim(r.snippet)}` : ""}`);
      }
      if (suggestions.length) console.log(dim(`\nAlso try: ${suggestions.join("; ")}`));
      return;
    }

    case "ship": {
      const id = sub;
      if (!id || !/^art_[A-Za-z0-9_-]{22}$/.test(id) || !str("title")) fail('usage: galahad ship <artifact> --title "…" [--body …] [--base main] [--branch galahad/…] [--draft] [--ask] [-y]');
      const admin = new Admin(home);
      let shipment: ShipManifest;
      try {
        shipment = ShipManifest.parse(JSON.parse(new TextDecoder().decode((await admin.bytes("artifactFile", { id, path: "ship/manifest.json" })).bytes)));
      } catch (error) {
        fail(`${id} holds no shipment (ship/manifest.json): only a quest on a clone (--repo) leaves one. ${(error as Error).message}`);
      }
      const where = githubRepo(shipment!.remote);
      if (!where) fail(`the work was done on ${shipment!.remote}, which isn't a github.com repository`);
      const title = str("title")!;
      const branch = str("branch") ?? shipBranch(title, `q-${id.slice(4, 12).toLowerCase().replace(/[^a-z0-9]/g, "")}`);
      const connector = str("connector") ?? (await githubConnector(admin, where!.owner));
      console.log(`${bold(`${where!.owner}/${where!.repo}`)}: ${shipment!.files.length} file(s) on a new branch ${branch}, from ${shipment!.base.slice(0, 12)}, through ${connector}`);
      for (const f of shipment!.files.slice(0, 30)) console.log(`  ${f.deleted ? "deleted " : ""}${f.path}`);
      if (shipment!.files.length > 30) console.log(dim(`  … ${shipment!.files.length - 30} more (galahad artifact ${id} changes.patch)`));
      if (!flags.ask && !flags.yes && !confirm(`Open this pull request on ${where!.owner}/${where!.repo}?`)) return;
      const result = (await admin.call("callConnector", {
        connector,
        tool: "ship",
        args: {
          owner: where!.owner,
          repo: where!.repo,
          artifact: id,
          branch,
          title,
          ...(str("body") ? { body: str("body") } : {}),
          ...(str("base") ? { base: str("base") } : {}),
          ...(flags.draft ? { draft: true } : {}),
        },
        ...(flags.ask ? { ask: {}, why: `Ship ${shipment!.files.length} file(s) from ${id} to ${where!.owner}/${where!.repo}.` } : {}),
      })) as { status: "asked" | "done"; action?: string; result?: { ok: boolean; body: string } };
      if (result.status === "asked") console.log(`Filed for your approval: galahad action approve ${result.action} (or the Inbox)`);
      else if (result.result?.ok) console.log(`✓ ${result.result.body}`);
      else fail(result.result?.body ?? "not shipped");
      return;
    }

    case "trials":
    case "trial": {
      // The Trials' commands (trial-commands.ts): suites, pins, variants, budgets and the reports.
      try {
        process.exit(await trialCommand({ command, sub, rest, flags, node: () => new Admin(home), ...(isolation() ? { isolation: isolation()! } : {}) }));
      } catch (error) {
        if (error instanceof UsageError) fail(error.message);
        throw error;
      }
    }

    // What model calls cost: your prices, and this node's own count of its calls (usage.ts).
    case "price":
    case "prices":
    case "usage": {
      try {
        process.exit(command === "usage" ? await usageCommand(new Admin(home), flags, sub, rest) : await priceCommand(new Admin(home), sub, rest, flags));
      } catch (error) {
        if (error instanceof UsageError) fail(error.message);
        throw error;
      }
    }

    case "place": {
      const result = await new Admin(home).call("place", {
        ...(flags.docker ? { docker: true } : {}),
        ...(flags.vm ? { vm: true } : {}),
        ...(flags.gpu ? { gpu: true } : {}),
        ...(str("mem") ? { minMemoryGb: Number(str("mem")) } : {}),
        ...(str("tools") ? { tools: str("tools")!.split(",") } : {}),
        ...(flags.long ? { longRunning: true } : {}),
        ...(flags.untrusted ? { untrusted: true } : {}),
        ...(flags.interactive ? { interactive: true } : {}),
      });
      for (const p of result.ranked) console.log(`  ${String(p.score).padStart(4)}  ${p.name.padEnd(18)} ${dim(p.reasons.join(", "))}`);
      for (const r of result.rejected) console.log(dim(`     ✗  ${r.name.padEnd(18)} ${r.reason}`));
      return;
    }

    case "sandbox": {
      if (sub === "setup") {
        // A Mac given what its knights' VMs need (sandbox-setup.ts); a node of its own isn't needed for its first steps.
        const json = !!flags.json;
        const node = (): SetupNode | null => (home.exists() ? { name: home.readConfig().name, call: (route, input) => new Admin(home).call(route, input) } : null);
        if (rest[0] && rest[0] !== "status") fail("usage: galahad sandbox setup [status] [--json]");
        process.exitCode = await sandboxSetup(systemSetupDeps({ node, say: (line) => console.log(json ? JSON.stringify(line) : setupWords(line)) }), { check: rest[0] === "status" });
        return;
      }
      const admin = new Admin(home);
      const on = str("on");
      const printResult = (r: { exitCode: number; stdout: string; stderr: string; durationMs: number; truncated: boolean }) => {
        if (r.stdout) process.stdout.write(r.stdout.endsWith("\n") ? r.stdout : `${r.stdout}\n`);
        if (r.stderr) process.stderr.write(r.stderr.endsWith("\n") ? r.stderr : `${r.stderr}\n`);
        process.stderr.write(dim(`[exit ${r.exitCode} · ${r.durationMs} ms${r.truncated ? " · output truncated" : ""}]\n`));
      };
      if (sub === "build") {
        console.log(dim(flags.lab ? "Building the Lab image (the first build takes 10 minutes or more)…" : flags.gazebo ? "Building the Gazebo image (a few minutes the first time)…" : flags.desktop ? "Building the desktop image (a minute or two the first time; the sandbox image must be built first)…" : "Building the sandbox image (first build takes a few minutes)…"));
        await admin.call("buildSandboxImage", { ...(on ? { on } : {}), ...(flags.lab ? { lab: true } : flags.gazebo ? { gazebo: true } : flags.desktop ? { desktop: true } : {}) });
        console.log(flags.lab ? "Lab image ready." : flags.gazebo ? "Gazebo image ready." : flags.desktop ? "Desktop image ready." : "Sandbox image ready.");
        return;
      }
      const shape = (s: SandboxView) => (s.isolation === "vm" ? "microVM" : "container");
      const diskOf = (s: SandboxView) => (s.disk ? `disk ${s.disk.usedGb ?? "?"}/${s.disk.limitGb} GB` : "disk unlimited");
      if (sub === "ls") {
        const { node, sandboxes } = await admin.call("sandboxes", { ...(on ? { on } : {}) });
        if (!sandboxes.length) console.log(`No sandboxes on ${node}.`);
        for (const s of sandboxes) {
          const left = Math.max(0, Math.round((s.expiresAt - Date.now()) / 60_000));
          console.log(
            `  ${s.id}  ${s.status.padEnd(8)} ${shape(s).padEnd(9)} ${s.network.padEnd(8)} ${String(s.cpus).padStart(3)} cpu ${String(s.memoryGb).padStart(4)} GB  ${diskOf(s)}  ${s.ephemeral ? `${left} min left` : "persistent"}  ${dim(s.quest)}`,
          );
        }
        return;
      }
      if (sub === "exec") {
        const [id, ...cmd] = rest;
        if (!id || !cmd.length) fail("usage: galahad sandbox exec <id> [--on node] -- <command…>");
        const result = await admin.call("execSandbox", { id, cmd, ...(str("timeout") ? { timeoutSec: Number(str("timeout")) } : {}), ...(on ? { on } : {}) });
        printResult(result);
        process.exit(result.exitCode);
      }
      if (sub === "save") {
        if (!rest[0]) fail("usage: galahad sandbox save <id> [/work/dir] [--label text]");
        const { artifact } = await admin.call("saveArtifact", {
          sandbox: rest[0],
          ...(rest[1] ? { path: rest[1] } : {}),
          ...(str("label") ? { label: str("label") } : {}),
          ...(on ? { on } : {}),
        });
        if (!artifact) console.log(`Nothing to keep in ${rest[1] ?? "/work/out"}.`);
        else console.log(`Kept ${artifact.count} file(s), ${Math.max(1, Math.round(artifact.bytes / 1024))} KB: galahad artifact ${artifact.id}`);
        return;
      }
      if (sub === "rm") {
        if (!rest[0]) fail("usage: galahad sandbox rm <id>");
        await admin.call("destroySandbox", { id: rest[0], ...(on ? { on } : {}) });
        console.log("Sandbox destroyed.");
        return;
      }
      if (sub === "run") {
        const cmd = rest;
        if (!cmd.length) fail("usage: galahad sandbox run [options] -- <command…>");
        const { sandbox } = await admin.call("createSandbox", {
          network: str("net") ?? "gateway",
          ...(str("cpus") ? { cpus: Number(str("cpus")) } : {}),
          ...(str("mem") ? { memoryGb: Number(str("mem")) } : {}),
          ...(str("disk") ? { diskGb: Number(str("disk")) } : {}),
          ...(isolation() ? { isolation: isolation() } : {}),
          ...(flags.lab ? { lab: true } : flags.gazebo ? { gazebo: true } : flags.desktop ? { desktop: true } : {}),
          ...(str("ttl") ? { ttlMinutes: Number(str("ttl")) } : {}),
          ...(str("providers") ? { providers: str("providers")!.split(",").filter(Boolean) } : {}),
          ...(str("image") ? { image: str("image") } : {}),
          ...(on ? { on } : {}),
          // Web search wherever there's a network (`websearch` in the sandbox).
          ...((str("net") ?? "gateway") !== "isolated" ? { search: true } : {}),
        });
        const where = on ?? "the best sandbox host";
        process.stderr.write(dim(`[sandbox ${sandbox.id} on ${where} · ${shape(sandbox)} · ${sandbox.network} · ${sandbox.cpus} cpu · ${sandbox.memoryGb} GB · ${diskOf(sandbox)}]\n`));
        let code = 1;
        try {
          const result = await admin.call("execSandbox", {
            id: sandbox.id,
            cmd,
            ...(str("timeout") ? { timeoutSec: Number(str("timeout")) } : {}),
            ...(on ? { on } : {}),
          });
          printResult(result);
          code = result.exitCode;
        } finally {
          if (flags.keep) process.stderr.write(dim(`[kept: galahad sandbox exec ${sandbox.id} -- …]\n`));
          else await admin.call("destroySandbox", { id: sandbox.id, ...(on ? { on } : {}) });
        }
        process.exit(code);
      }
      fail("usage: galahad sandbox run|ls|exec|save|rm|build|setup — see `galahad help`");
    }

    case "artifacts":
    case "artifact": {
      const admin = new Admin(home);
      const { artifacts } = (await admin.call("artifacts")) as { artifacts: ArtifactView[] };
      const size = (bytes: number) => (bytes < 2 ** 20 ? `${Math.max(1, Math.round(bytes / 1024))} KB` : `${(bytes / 2 ** 20).toFixed(1)} MB`);
      const id = command === "artifact" ? sub : undefined;
      if (!id) {
        if (!artifacts.length) console.log("Nothing kept yet. Quests keep /work/out; `galahad sandbox save <id>` keeps any sandbox's.");
        for (const a of artifacts) {
          console.log(`  ${a.id}  ${new Date(a.savedAt).toLocaleString()}  ${String(a.count).padStart(4)} file(s) ${size(a.bytes).padStart(8)}  ${a.nodeName}${a.here ? "" : dim(" (elsewhere)")}`);
          console.log(`      ${a.label}${a.quest ? dim(` · ${a.quest}`) : ""}`);
        }
        return;
      }
      const artifact = artifacts.find((a) => a.id === id);
      if (!artifact) fail(`no artifact ${id}`);
      const file = rest[0];
      const out = str("out");
      if (file && !out) {
        // One file to stdout, as it is.
        const { bytes } = await admin.bytes("artifactFile", { id, path: file });
        process.stdout.write(bytes);
        return;
      }
      if (out) {
        const wanted = file ? artifact!.files.filter((f) => f.path === file) : artifact!.files;
        for (const f of wanted) {
          // The record names the file; it never decides where on this machine it's written.
          const target = artifactTarget(out, f.path);
          const { bytes } = await admin.bytes("artifactFile", { id, path: f.path });
          const sha = new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
          if (sha !== f.sha256) fail(`${f.path}: its SHA-256 doesn't match what was recorded`);
          mkdirSync(dirname(target), { recursive: true });
          writeFileSync(target, bytes);
        }
        console.log(`Saved ${wanted.length} file(s) to ${out}, each checked against its recorded SHA-256.${artifact!.count > artifact!.files.length ? dim(` (${artifact!.count - artifact!.files.length} more aren't listed in the mind; fetch them by name)`) : ""}`);
        return;
      }
      console.log(`${bold(artifact!.label)}  ${dim(`${artifact!.id} · ${artifact!.count} file(s) · ${size(artifact!.bytes)} · on ${artifact!.nodeName}${artifact!.quest ? ` · ${artifact!.quest}` : ""}`)}`);
      for (const f of artifact!.files) console.log(`  ${f.path.padEnd(48)} ${size(f.size).padStart(8)}  ${dim(f.sha256.slice(0, 12))}`);
      console.log(dim(`\n  galahad artifact ${id} <file>  ·  galahad artifact ${id} --out ./results`));
      return;
    }

    case "ledger": {
      const { entries } = await new Admin(home).call("ledger");
      const limit = Number(str("limit") ?? 30);
      if (!entries.length) console.log("The ledger is empty.");
      for (const e of entries.slice(0, limit).reverse()) {
        const when = new Date(Number(e.hlc.slice(0, 15))).toLocaleString();
        const verdict = e.verdict === "allow" || e.verdict === "approved" ? e.verdict : bold(e.verdict);
        console.log(`  ${dim(when)}  ${e.class.padEnd(7)} ${verdict.padEnd(8)} ${e.resource} ${e.target}${e.detail ? dim(`  ${e.detail}`) : ""}`);
      }
      return;
    }

    case "mcp": {
      if (sub !== "install") {
        // The MCP server: stdout belongs to the protocol, so nothing else may print there.
        const label = str("arm") ?? "default";
        const config = home.readConfig();
        const base = `http://127.0.0.1:${loadEnv().GALAHAD_PORT ?? config.port}`;
        // --tools a,b: those alone, of what the arm's scopes allow (a Q-AMP grant's bridge runs it so). Named, and none: none.
        const tools = str("tools");
        const only = tools === undefined ? undefined : tools.split(",").map((t) => t.trim()).filter(Boolean);
        await runMcpServer({ base, token: home.readArmToken(label), version: VERSION, ...(only ? { only } : {}) });
        return;
      }
      const target = rest[0];
      const targets = ["claude", "opencode", "codex", "hermes"];
      if (!target || !targets.includes(target)) fail(`usage: galahad mcp install ${targets.join("|")} [--label name] [--apply]`);
      const label = str("label") ?? (target === "claude" ? "claude-code" : target);
      const minted = await new Admin(home).call<{ token: string; info: { scopes: string[] } }>("mintArm", { label });
      const tokenPath = home.writeArmToken(label, minted.token);
      const cli = fileURLToPath(import.meta.url);
      const args = [cli, "mcp", "--arm", label, ...(flags.home ? ["--home", home.dir] : [])];
      const bunPath = process.execPath;
      console.log(`${bold(`Arm "${label}" ready`)} · scopes: ${minted.info.scopes.join(", ")}\n  token: ${tokenPath} (0600; never shown, never in chat)\n`);
      if (target === "claude") {
        const command = ["claude", "mcp", "add", "--scope", "user", "galahad", "--", bunPath, ...args];
        if (flags.apply) {
          const proc = Bun.spawn(command, { stdout: "inherit", stderr: "inherit" });
          if ((await proc.exited) !== 0) fail("`claude mcp add` failed; run the command below yourself");
          console.log("Added to Claude Code (user scope). Restart Claude Code to load it.");
        } else {
          console.log(`Add it to Claude Code (or re-run with --apply):\n\n  ${command.map((c) => (/\s/.test(c) ? `"${c}"` : c)).join(" ")}\n`);
        }
      } else if (target === "opencode") {
        console.log(
          `Add to opencode.json (project) or ~/.config/opencode/opencode.json:\n\n${JSON.stringify({ mcp: { galahad: { type: "local", command: [bunPath, ...args], enabled: true } } }, null, 2)}\n`,
        );
      } else if (target === "codex") {
        console.log(`Add to ~/.codex/config.toml:\n\n[mcp_servers.galahad]\ncommand = ${JSON.stringify(bunPath)}\nargs = ${JSON.stringify(args)}\n`);
      } else {
        console.log(
          `Add to your Hermes config (mcp_servers):\n\nmcp_servers:\n  galahad:\n    command: ${JSON.stringify(bunPath)}\n    args: ${JSON.stringify(args)}\n\n${dim("Check Hermes's MCP docs for the exact key in your version.")}`,
        );
      }
      return;
    }

    case "acp": {
      if (sub !== "install") {
        // Galahad as an ACP agent (acp-agent.ts): stdout belongs to the protocol, so nothing else may print there.
        const config = home.readConfig();
        const base = `http://127.0.0.1:${loadEnv().GALAHAD_PORT ?? config.port}`;
        const token = home.readArmToken(str("arm") ?? "acp");
        let delivery;
        if (flags.buzz) {
          const cli = buzzCli(str("buzz-cli"));
          if (!cli) fail(`galahad acp --buzz posts with Buzz's CLI, and ${str("buzz-cli") ?? "buzz"} isn't there: name it with --buzz-cli <path>`);
          // The harness gives its agent the community's relay and its key in its environment, as it gives every agent.
          if (!process.env.BUZZ_PRIVATE_KEY || !process.env.BUZZ_RELAY_URL) fail("galahad acp --buzz runs under Buzz's harness (buzz-acp), given BUZZ_RELAY_URL and BUZZ_PRIVATE_KEY in its environment: docs/BUZZ.md");
          delivery = buzzDelivery({ cli: cli!, env: process.env, log: (message) => process.stderr.write(`galahad acp: ${message}\n`) });
        }
        await runAcpAgent({ base, token, ...(delivery ? { delivery } : {}) });
        return;
      }
      if (rest[0] !== "buzz") fail("usage: galahad acp install buzz [--label name]");
      const label = str("label") ?? "buzz";
      // A community is read by others: his answers there carry nothing of yours, and he can do nothing there but answer.
      const minted = await new Admin(home).call<{ token: string; info: { scopes: string[] } }>("mintArm", { label, scopes: ["chat"] });
      const tokenPath = home.writeArmToken(label, minted.token);
      const args = [fileURLToPath(import.meta.url), "acp", "--arm", label, "--buzz", ...(flags.home ? ["--home", home.dir] : [])];
      console.log(`${bold(`Arm "${label}" ready`)} · scopes: ${minted.info.scopes.join(", ")}\n  token: ${tokenPath} (0600; never shown, never in chat)\n`);
      console.log(
        `Buzz's harness runs him, on this machine, given the agent's identity in its environment (docs/BUZZ.md):\n\n` +
          `  BUZZ_RELAY_URL=wss://<your community>  BUZZ_PRIVATE_KEY=<the agent's key>  BUZZ_AUTH_TAG=<your attestation of it>\n` +
          `  buzz-acp --agent-command ${process.execPath} --agent-args ${args.join(",")} \\\n` +
          `    --respond-to owner-only --no-base-prompt --no-memory\n\n` +
          `${dim("In Buzz Desktop on this machine: a new agent with that command and those arguments (comma-separated), answering you only.")}`,
      );
      return;
    }

    case "bank": {
      const admin = new Admin(home);
      if (sub === "setup") {
        // Written by this process, the node's own user, into the node's home: private (600) from the start.
        const service = new BankService({ dir: join(home.dir, "bank") });
        try {
          const config = service.setup({
            appId: str("app-id") ?? "",
            keyPath: str("key") ?? "",
            redirectUrl: str("redirect-url") ?? "",
            aspsp: str("aspsp") ?? "",
            country: str("country") ?? "",
          });
          console.log(`Bank set up: app ${config.appId}, ${config.aspsp} (${config.country}), consent ${config.consentDays} days, callback ${config.redirectUrl}`);
        } catch (error) {
          fail(`bank setup: ${(error as Error).message}\nusage: galahad bank setup --app-id <uuid> --key /path/to/<app-id>.pem --redirect-url https://…/bank/callback --aspsp "<bank>" --country <XX>`);
        }
        const problem = service.problem();
        console.log(problem ? `${bold("Not ready yet:")} ${problem}` : "Key and files are private to this node's user. Next: galahad bank connect (or the PWA: Bank → Connect).");
        return;
      }
      if (sub === "connect") {
        const { url, aspsp, validUntil } = (await admin.call("bankConnect", {})) as { url: string; aspsp: string; validUntil: string };
        console.log(`Open this to authorise ${aspsp} (read-only, until ${validUntil.slice(0, 10)}); it's good for 15 minutes:\n\n  ${url}\n`);
        console.log(dim("The bank sends you back to the PWA, which finishes it. Without the PWA: galahad bank complete"));
        return;
      }
      if (sub === "complete") {
        const pasted = await readSecret("Paste the URL the bank sent you back to (hidden): ");
        let code: string | null = null;
        let state: string | null = null;
        try {
          const url = new URL(pasted.trim());
          code = url.searchParams.get("code");
          state = url.searchParams.get("state");
        } catch {
          fail("that isn't a URL");
        }
        if (!code || !state) fail("the URL has no code and state: copy the whole address the bank sent you back to");
        const done = (await admin.call("bankComplete", { code, state })) as { accounts: number; ibans: string[]; validUntil: string };
        console.log(`Connected: ${done.accounts} account(s) (${done.ibans.join(", ")}), until ${done.validUntil.slice(0, 10)}.`);
        return;
      }
      if (sub === "disconnect") {
        if (!flags.yes && !confirm("End the bank consent and forget the session and the cache?")) return;
        const { ended } = (await admin.call("bankDisconnect", {})) as { ended: boolean };
        console.log(ended ? "Ended at the bank, and forgotten here." : "Forgotten here (the bank didn't confirm ending it; it expires on its own).");
        return;
      }
      const status = (await admin.call("bankStatus")) as BankStatusView;
      console.log(status.message);
      for (const a of status.accounts) {
        const b = status.budget.find((x) => x.account === a.uid);
        console.log(`  ${a.name || "(unnamed)"} ${a.iban ?? ""} ${a.currency ?? ""}  ${dim(`${a.uid} · ${b ? `${b.remaining}/${b.perDay} background fetches left` : ""}${b?.cacheAgeSeconds != null ? ` · cache ${Math.round(b.cacheAgeSeconds / 60)} min old` : ""}`)}`);
      }
      if (status.daysRemaining !== null) console.log(dim(`${status.daysRemaining} day(s) of consent left.`));
      return;
    }

    case "arms": {
      const admin = new Admin(home);
      if (sub === "grant" || sub === "ungrant") {
        const [label, ...scopes] = rest;
        if (!label || !scopes.length) fail(`usage: galahad arms ${sub} <agent> <scope…>   e.g. galahad arms grant claude-code bank:read`);
        const { arm } = (await admin.call("grantArm", sub === "grant" ? { label, add: scopes } : { label, remove: scopes })) as { arm: { label: string; scopes: string[] } };
        console.log(`${arm.label}: ${arm.scopes.join(", ")}`);
        console.log(dim("Its MCP server offers the tools at its next start (restart the agent)."));
        return;
      }
      if (sub === "revoke") {
        if (!rest[0]) fail("usage: galahad arms revoke <label>");
        const { revoked } = await admin.call("revokeArm", { label: rest[0] });
        console.log(revoked ? `Revoked ${rest[0]}. Its MCP server will be refused from now on.` : `No arm named ${rest[0]}.`);
        return;
      }
      const { arms } = await admin.call("arms");
      if (!arms.length) console.log("No agents connected. `galahad mcp install claude` to add one.");
      for (const a of arms) console.log(`  ${a.label.padEnd(18)} ${dim(a.scopes.join(", "))}  since ${new Date(a.createdAt).toLocaleDateString()}`);
      return;
    }

    case "loop":
      await loopCommand(new Admin(home), sub, rest, flags);
      return;
    case "self-action":
      await selfActionCommand(new Admin(home), sub);
      return;
    case "heartbeat":
      await heartbeatCommand(new Admin(home));
      return;
    case "notices":
    case "notice":
      await noticeCommand(new Admin(home), sub, rest, flags);
      return;
    case "connector":
    case "connectors":
      await connectorCommand(new Admin(home), sub, rest, flags, readSecret);
      return;
    case "questions":
    case "question": {
      // An MCP server's question mid-call (questions.ts): read here, answered by you alone, field by field.
      const admin = new Admin(home);
      const { questions } = await admin.call<{ questions: QuestionView[] }>("questions");
      if (sub === "answer" || sub === "decline") {
        const q = questions.find((x) => x.id === rest[0]);
        if (!q) fail(`usage: galahad questions answer <id> name=value … | questions decline <id> (${rest[0] ? `no question ${rest[0]} waits` : "which one?"}: galahad questions lists them)`);
        if (sub === "decline") {
          await admin.call("answerQuestion", { id: q.id, accept: false });
          console.log(`Said no to ${q.label}: its call goes on.`);
          return;
        }
        const content: Record<string, unknown> = {};
        for (const pair of rest.slice(1)) {
          const at = pair.indexOf("=");
          const field = q.fields.find((f) => f.name === pair.slice(0, at));
          if (at < 1 || !field) fail(`${pair}: give a field it asked for as name=value (${q.fields.map((f) => f.name).join(", ")})`);
          const raw = pair.slice(at + 1);
          // (Each by its kind: a comma in a text is the text's.)
          content[field.name] = field.kind === "yes-no" ? /^(y|yes|true|1)$/i.test(raw) : field.kind === "many" ? raw.split(",").map((v) => v.trim()).filter(Boolean) : field.kind === "number" ? Number(raw) : raw;
        }
        await admin.call("answerQuestion", { id: q.id, accept: true, content });
        console.log(`Sent to ${q.label}: its call goes on.`);
        return;
      }
      if (sub) fail("usage: galahad questions [answer <id> name=value … | decline <id>]");
      if (!questions.length) console.log("No service asks you anything now.");
      for (const q of questions) {
        console.log(`${bold(q.id)} · ${plainLine(q.label)} asks (its call waits until ${new Date(q.expires).toLocaleTimeString()}):\n  ${plainLine(q.message)}`);
        for (const f of q.fields) {
          const kind = f.kind === "one" || f.kind === "many" ? ` · ${f.kind === "many" ? "any of" : "one of"} ${f.options.map((o) => o.value).join(", ")}` : f.kind === "yes-no" ? " · yes or no" : f.kind === "number" ? ` · a${f.integer ? " whole" : ""} number` : "";
          console.log(`  ${f.name}${f.required ? "" : " (optional)"}: ${plainLine(f.title)}${kind}${f.description ? dim(` · ${plainLine(f.description)}`) : ""}`);
        }
      }
      if (questions.length) console.log(dim("Answer with galahad questions answer <id> name=value …, or galahad questions decline <id>."));
      return;
    }

    case "action":
    case "actions":
      await actionCommand(new Admin(home), sub, rest, flags);
      return;
    case "order":
    case "orders":
      await orderCommand(new Admin(home), sub, rest, flags);
      return;
    case "rule":
    case "rules":
      await ruleCommand(new Admin(home), sub, rest, flags);
      return;
    case "qamp":
      await qampCommand(new Admin(home), sub, rest, flags);
      return;
    case "archive":
      await archiveCommand(new Admin(home), sub, rest, flags, { confirm, readStdin: () => Bun.stdin.text() });
      return;
    case "skill":
    case "skills":
      await skillsCommand(new Admin(home), sub, rest, flags, { confirm });
      return;
    case "compute":
      await computeCommand(new Admin(home), sub, rest, flags);
      return;
    case "notify":
      await notifyCommand(new Admin(home), sub, rest, flags);
      return;
    case "bilag": {
      // Bilag from your mail to Google Drive (bilag.ts): copied by the node itself, the owner's word of 18 November 2026.
      const admin = new Admin(home);
      if (sub === "copy") {
        const from = str("from");
        if (from !== "gmail" && from !== "outlook") fail('usage: galahad bilag copy --from gmail|outlook [--query "…"] [--folder Bilag]');
        let page: string | undefined;
        const total = { copied: 0, already: 0, skipped: 0, failed: 0, mails: 0 };
        do {
          const batch = await admin.call<{ copied: { name: string; folder: string }[]; already: number; skipped: number; failed: string[]; found: number; next: string | null }>("bilagCopy", {
            from,
            ...(str("query") ? { query: str("query") } : {}),
            ...(str("folder") ? { folder: str("folder") } : {}),
            ...(page ? { page } : {}),
          });
          for (const c of batch.copied) console.log(`  ✓ ${c.folder}/${c.name}`);
          for (const why of batch.failed) console.log(dim(`  ✗ ${why}`));
          total.copied += batch.copied.length;
          total.already += batch.already;
          total.skipped += batch.skipped;
          total.failed += batch.failed.length;
          total.mails += batch.found;
          page = batch.next ?? undefined;
          if (page) console.log(dim(`  … ${total.mails} mails looked at so far`));
        } while (page);
        console.log(`${bold(`${total.copied} bilag copied`)} from ${total.mails} mails${total.already ? `; ${total.already} copied before` : ""}${total.skipped ? `; ${total.skipped} attachments weren't bilag` : ""}${total.failed ? `; ${total.failed} mails couldn't be copied` : ""}.`);
        return;
      }
      const { connectors } = await admin.call<{ connectors: { id: string; installed: boolean; key: string }[] }>("connectors");
      const ready = (id: string) => connectors.some((c) => c.id === id && c.installed && c.key === "ready");
      if (sub === "on") {
        const mail = (["gmail", "outlook"] as const).filter(ready);
        if (!ready("gdrive") || !mail.length) fail(`connect Google Drive and at least one of Gmail and Outlook first (${[!ready("gdrive") ? "gdrive" : null, ...(mail.length ? [] : ["gmail", "outlook"])].filter(Boolean).join(", ")}: docs/BOOKS.md)`);
        const { loop } = await admin.call<{ loop: { name: string } }>("setLoop", {
          name: "bilag",
          schedule: "never",
          task: { kind: "bilag", ...(str("folder") ? { folder: str("folder") } : {}) },
          wakes: mail.map((connector) => ({ kind: "mail", connector, query: BILAG_QUERY[connector] })),
        });
        console.log(`Loop ${bold(loop.name)}: new mail in ${mail.join(" and ")} that holds a receipt or an invoice wakes it, and its bilag go to Google Drive (${str("folder") ?? "Bilag"}/<year>/<month>). Mail already there: galahad bilag copy --from ${mail[0]}`);
        return;
      }
      if (sub === "names") {
        const { renamed, failed } = await admin.call<{ renamed: { from: string; to: string }[]; failed: string[] }>("bilagNames", {});
        for (const r of renamed) console.log(`  ${dim(r.from)}\n  → ${r.to}`);
        for (const why of failed) console.log(dim(`  ✗ ${why}`));
        console.log(`${bold(`${renamed.length} bilag`)} renamed for who first sent them${failed.length ? `; ${failed.length} couldn't be` : ""}.`);
        return;
      }
      if (sub) fail("usage: galahad bilag [on | copy --from gmail|outlook | names]");
      const status = await admin.call<{ copied: number; latest: { name: string; link: string | null; at: number }[] }>("bilag");
      console.log(`${bold(`${status.copied} bilag`)} copied to Google Drive`);
      for (const b of status.latest) console.log(`  ${new Date(b.at).toLocaleDateString()}  ${b.name}${b.link ? dim(`  ${b.link}`) : ""}`);
      const missing = ["gdrive", "gmail", "outlook"].filter((id) => !ready(id));
      if (missing.length) console.log(dim(`\nNot connected yet: ${missing.join(", ")} (docs/BOOKS.md says how).`));
      return;
    }
    case "books": {
      // A bilag from your Drive into Dinero, to the payment it documents (books.ts); attaching it asks you.
      const usage = 'usage: galahad books attach --org <Dinero organization id> --card <voucher card id> --file <Drive file id> | --dinero-file <id in Dinero\'s archive> --why "…"\n       galahad books upload --org <Dinero organization id> --file <Drive file id>';
      if (sub === "upload") {
        const org = Number(str("org"));
        if (!Number.isInteger(org) || org <= 0 || !str("file")) fail(usage);
        const up = await new Admin(home).call<{ name: string; bytes: number; sha256: string; fileGuid: string }>("booksUpload", { organizationId: org, file: str("file") });
        console.log(`${bold(up.name)} is in Dinero's archive (${up.bytes} bytes, SHA-256 ${up.sha256.slice(0, 12)}…): fileGuid ${up.fileGuid}`);
        return;
      }
      if (sub !== "attach") fail(usage);
      const org = Number(str("org"));
      if (!Number.isInteger(org) || org <= 0 || !str("card") || !str("file") === !str("dinero-file") || !str("why")) fail(usage);
      const done = await new Admin(home).call<{ name: string | null; bytes: number | null; sha256: string | null; fileGuid: string; action: string | null }>("booksAttach", {
        organizationId: org,
        card: str("card"),
        ...(str("file") ? { file: str("file") } : { dineroFile: str("dinero-file") }),
        why: str("why"),
      });
      if (done.name) console.log(`${bold(done.name)} is in Dinero's archive (${done.bytes} bytes, SHA-256 ${done.sha256!.slice(0, 12)}…, file ${done.fileGuid}).`);
      console.log(done.action ? `Attaching it to the payment's card waits for you: action ${done.action} (your Inbox, or galahad action approve ${done.action}).` : "It is attached to the payment's card.");
      return;
    }
    case "outcome":
    case "outcomes": {
      const admin = new Admin(home);
      const show = (o: TeamOutcome) => {
        const left = Math.max(0, o.budgetUsd - o.spentUsd - o.committedUsd);
        console.log(`${bold(o.title)} ${dim(o.id)} · ${o.status}${o.ended ? ` (${o.ended})` : ""}`);
        console.log(`  ${o.knights.map((k) => `@${k}`).join(" ")} · spent $${o.spentUsd.toFixed(2)} of $${o.budgetUsd}, held $${o.committedUsd.toFixed(2)}, left $${left.toFixed(2)} · tasks ${o.tasks.done} done, ${o.tasks.running} running, ${o.tasks.queued} waiting, ${o.tasks.failed} not done`);
        console.log(o.northStar.perCompleted === null ? "  none of its tasks done yet" : `  you stepped in ${o.northStar.perCompleted.toFixed(1)} times per completed task (${o.northStar.completed} done)`);
        if (o.notes) console.log(dim(`  plan: ${o.notes.split("\n")[0]!.slice(0, 140)}`));
        console.log(dim(`  follow it: galahad roundtable chat ${o.room}`));
      };
      if (!sub || sub === "ls") {
        const { outcomes } = await admin.call<{ outcomes: TeamOutcome[] }>("teamOutcomes");
        if (!outcomes.length) console.log('No outcomes yet. galahad outcome add "<title>" --goal "…" --knight <id> --budget-usd 20');
        for (const o of outcomes) show(o);
        return;
      }
      if (sub === "add") {
        const title = rest.join(" ").trim();
        const knights = Array.isArray(flags.knight) ? (flags.knight as string[]) : flags.knight ? [String(flags.knight)] : [];
        const budgetUsd = Number(str("budget-usd"));
        if (!title || !str("goal") || !knights.length || !Number.isFinite(budgetUsd)) fail('usage: galahad outcome add "<title>" --goal "…" --knight <id> [--knight <id>…] --budget-usd 20 [--done "…"] [--report-hour 9] [--tz Zone]');
        const { outcome } = await admin.call<{ outcome: TeamOutcome }>("setTeamOutcome", {
          title,
          goal: str("goal"),
          knights,
          budgetUsd,
          ...(str("done") ? { done: str("done") } : {}),
          ...(str("report-hour") ? { reportHour: Number(str("report-hour")) } : {}),
          ...(str("tz") ? { tz: str("tz") } : {}),
        });
        console.log("He owns it now. He works it in its own room, within its budget, and asks you there when a choice is yours.");
        show(outcome);
        return;
      }
      if (sub === "pause" || sub === "resume" || sub === "stop") {
        if (!rest[0]) fail(`usage: galahad outcome ${sub} <id>`);
        if (sub === "stop" && !flags.yes && !confirm("Stop it? Its waiting work is stopped, and it ends.")) return;
        const { outcome } = await admin.call<{ outcome: TeamOutcome }>("controlTeamOutcome", { id: rest[0], action: sub });
        show(outcome);
        return;
      }
      if (sub === "budget") {
        // A new total (7), or more on top of what it has (+2): one that had spent what it may goes on.
        const [id, amount] = rest;
        const raw = amount?.trim() ?? "";
        const by = Number(raw.replace(/^\+/, ""));
        if (!id || !/^\+?\d+(\.\d+)?$/.test(raw) || !Number.isFinite(by)) fail("usage: galahad outcome budget <id> <usd | +usd>   (a new total, or +usd on top of it)");
        const { outcomes } = await admin.call<{ outcomes: TeamOutcome[] }>("teamOutcomes");
        const now = outcomes.find((o) => o.id === id);
        if (!now) fail(`no outcome ${id}: galahad outcome ls`);
        const budgetUsd = Math.round((raw.startsWith("+") ? now!.budgetUsd + by : by) * 100) / 100;
        const { outcome } = await admin.call<{ outcome: TeamOutcome }>("controlTeamOutcome", { id, action: "budget", budgetUsd });
        show(outcome);
        return;
      }
      fail("usage: galahad outcome [ls | add | pause | resume | stop | budget]");
      return;
    }
    case "roundtable":
    case "squires":
    case "squire":
    case "team":
      await teamCommand(new Admin(home), sub, rest, flags, console.log, confirm, process.stdout.isTTY ? process.stdout.columns : undefined);
      return;
    case "terminal":
      process.exitCode = await terminalCommand(new Admin(home), sub, rest, ttyScreen(dim), console.log);
      return;

    case "doctor": {
      const admin = home.exists() ? new Admin(home) : null;
      const base = admin?.base ?? "this machine";
      // Its exit code is the answer for a script: 0 well, 1 needs you, 2 broken.
      process.exitCode = await doctorCommand(admin ?? { call: () => Promise.reject(new CliError("no daemon on this machine")) }, flags, () => stoppedReport(home, base));
      return;
    }

    case "rebuild": {
      const config = home.readConfig();
      const store = new MindStore(home.mindPath);
      store.expectFleet(config.fleet!);
      const before = store.digest();
      store.rebuild();
      const after = store.digest();
      console.log(before === after ? `Rebuilt ${store.eventCount()} events; state identical (${after.slice(0, 12)}).` : `State changed on rebuild: ${before} → ${after}`);
      store.close();
      return;
    }

    default:
      fail(`unknown command "${command}" — try \`galahad help\``);
  }
}

await main().catch((error: unknown) => {
  console.error(`galahad: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
