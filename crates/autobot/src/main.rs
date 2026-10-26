//! The `autobot` command.

use std::collections::HashSet;
use std::path::PathBuf;
use std::process::ExitCode;
use std::sync::Arc;

use autobot::agent::Event;
use autobot::config::{self, Config};
use autobot::session::Session;
use autobot::{doctor, service, setup, telegram};
use clap::{Parser, Subcommand};

#[derive(Parser)]
#[command(
    version = invincible::version::VERSION,
    about = "The Autobot Agent, on Invincible Gateway. With no command: `autobot code` in a git repository, the chat anywhere else."
)]
struct Cli {
    /// The bot to act as or on (`autobot bots`; also $AUTOBOT_BOT); the default bot without it.
    #[arg(long, global = true)]
    bot: Option<String>,
    #[command(subcommand)]
    command: Option<Command>,
}

#[derive(Subcommand)]
enum Command {
    /// Set up the gateway and the agent (network, model, approvals, Telegram, background services).
    Setup,
    /// Chat in the terminal.
    Chat {
        /// The conversation to continue.
        #[arg(long, default_value = "cli")]
        session: String,
        /// Start the conversation over.
        #[arg(long)]
        new: bool,
        /// The model to use (an id the gateway serves; a cloud model allows cloud use).
        #[arg(long)]
        model: Option<String>,
    },
    /// Code in a project: the agent works in DIR (default: here), with the project's AGENTS.md or
    /// CLAUDE.md, search tools, diffs of every change and /undo. One conversation per project.
    Code {
        /// The project [default: the current directory].
        dir: Option<PathBuf>,
        /// The model to use: an id the gateway serves (a cloud model allows cloud use), or a
        /// provider to set up now (anthropic, deepseek, …). Remembered for next time.
        #[arg(long)]
        model: Option<String>,
        /// ask, edits (changes in the project run without asking), allowlist or trust.
        /// Remembered for next time.
        #[arg(long)]
        approvals: Option<String>,
        /// The conversation [default: one per project].
        #[arg(long)]
        session: Option<String>,
        /// Start the conversation over.
        #[arg(long)]
        new: bool,
    },
    /// Do one task and print the answer. Anything that needs approval is refused unless allowlisted.
    Run {
        task: String,
        #[arg(long, default_value = "run")]
        session: String,
        /// Work in this directory (a project: its AGENTS.md, search tools, undo).
        #[arg(long, short = 'C')]
        dir: Option<PathBuf>,
        /// The model to use (an id the gateway serves; a cloud model allows cloud use).
        #[arg(long)]
        model: Option<String>,
        /// ask (nothing is asked here, so: refused), edits (changes in the directory run),
        /// allowlist or trust. Allowlisted commands run in every mode.
        #[arg(long)]
        approvals: Option<String>,
        /// Print every event as a JSON line (text deltas, tool calls, outputs, diffs, receipts)
        /// and the answer last, for programs that drive the agent.
        #[arg(long)]
        json: bool,
        /// Say yes, for this run, when the gateway asks before using a cloud model (nobody is
        /// there to ask). Nothing else is approved by it.
        #[arg(long)]
        cloud: bool,
        /// Commands unconfined, for this run only: they can write anywhere you can. Otherwise a
        /// command run on this machine is write-confined, like a scheduled task's (one run over
        /// `[agent.ssh]` or in `[agent.docker]` is held only by that machine or container); this
        /// is for a machine you can throw away (a CI container without bubblewrap). Said on
        /// standard error and in the action log.
        #[arg(long)]
        no_sandbox: bool,
    },
    /// Serve every enabled bot: the agent API (for paired apps, through the gateway), their
    /// channels, schedules, board, heartbeat and hooks.
    Serve,
    /// Be the agent of an editor (Zed, or any Agent Client Protocol client): ACP on standard
    /// input and output, sessions coding in the folder the editor opens.
    Acp,
    /// Check the install, the gateway, the model and the channels.
    Doctor,
    /// The bots on this machine: list, add, show, edit, remove, enable, disable, status.
    Bots {
        #[command(subcommand)]
        action: Option<BotsAction>,
    },
    /// The same person on several platforms (one conversation everywhere): list, link, unlink.
    Identities {
        #[command(subcommand)]
        action: Option<IdentitiesAction>,
    },
    /// Telegram access: approve a pairing code, list or remove users.
    Telegram {
        #[command(subcommand)]
        action: TelegramAction,
    },
    /// Discord access: approve a pairing code, list or remove users.
    Discord {
        #[command(subcommand)]
        action: AccessAction,
    },
    /// Slack access: approve a pairing code, list or remove users.
    Slack {
        #[command(subcommand)]
        action: AccessAction,
    },
    /// Email access: approve a pairing code, list or remove senders.
    Email {
        #[command(subcommand)]
        action: AccessAction,
    },
    /// Signal access: approve a pairing code, list or remove users.
    Signal {
        #[command(subcommand)]
        action: AccessAction,
    },
    /// Matrix access: approve a pairing code, list or remove users.
    Matrix {
        #[command(subcommand)]
        action: AccessAction,
    },
    /// WhatsApp access (the Business Cloud API): approve a pairing code, list or remove users.
    Whatsapp {
        #[command(subcommand)]
        action: AccessAction,
    },
    /// Home Assistant for the `home` tool: set it up, or check it.
    #[command(name = "homeassistant")]
    HomeAssistant {
        #[command(subcommand)]
        action: Option<HomeAssistantAction>,
    },
    /// Run the gateway and the agent in the background (launchd on macOS, systemd on Linux).
    Service {
        #[command(subcommand)]
        action: ServiceAction,
    },
    /// Update autobot and invincible to the newest release (`invincible update`, with the same
    /// options: --channel stable|edge, --version, --check, --auto).
    #[command(disable_help_flag = true)]
    Update {
        #[arg(trailing_var_arg = true, allow_hyphen_values = true)]
        args: Vec<String>,
    },
    /// Back up the autobot home to one archive: config, personas, skills, conversations, memory,
    /// the recall index, who may use the bots. Secrets only with --include-secrets.
    Backup {
        /// Where to write it [default: ./autobot-backup-<time>.tar.gz].
        #[arg(long)]
        out: Option<PathBuf>,
        /// The tokens, passwords and keys too (keep the file as safe as they are).
        #[arg(long)]
        include_secrets: bool,
    },
    /// Restore the autobot home from a backup: checked first, what changes shown, asked; the
    /// home as it was is kept beside it.
    Restore {
        file: PathBuf,
        /// Only check it and say what would change.
        #[arg(long)]
        dry_run: bool,
        /// Without asking.
        #[arg(long)]
        yes: bool,
    },
    /// Health alerts to the owner (`[alerts]`): where they go and the latest; `test` sends one.
    Alerts {
        #[command(subcommand)]
        action: Option<AlertsAction>,
    },
    /// The services' logs: the last lines, or as they come with --follow.
    Logs {
        /// agent (`autobot serve`), gateway, or update.
        #[arg(default_value = "agent")]
        which: String,
        /// How many lines.
        #[arg(short = 'n', long, default_value_t = 50)]
        lines: usize,
        /// Keep printing what comes.
        #[arg(short, long)]
        follow: bool,
        /// Only lines with this text (case does not matter).
        #[arg(long)]
        grep: Option<String>,
    },
    /// The saved conversations: list them, or prune the old ones.
    Sessions {
        #[command(subcommand)]
        action: Option<SessionsAction>,
    },
    /// What the agent remembered between conversations (`remember`): list, or forget one.
    Memory {
        /// The id of a fact to forget.
        #[arg(long)]
        forget: Option<u64>,
    },
    /// Run agent tasks for real in throwaway directories and check what they did, per model.
    Eval {
        /// The tasks (JSON Lines; see `crates/autobot/src/eval.rs`).
        tasks: std::path::PathBuf,
        /// A model to run them on (an id the gateway serves, or `auto`); repeat to compare.
        #[arg(long = "model", required = true)]
        models: Vec<String>,
        /// Let turns use cloud models (they are private, local only, otherwise).
        #[arg(long)]
        cloud: bool,
        /// Only these tool groups (comma-separated, e.g. files-read,files-write,terminal), to see
        /// how the tool list affects a model.
        #[arg(long, value_delimiter = ',')]
        tools: Option<Vec<String>>,
        /// Only tasks with this tag.
        #[arg(long)]
        tag: Option<String>,
        /// Write every outcome here (JSON).
        #[arg(long)]
        out: Option<std::path::PathBuf>,
        /// Append the passing runs here as trajectories (fine-tuning data; see `autobot trajectories`).
        #[arg(long)]
        trajectories: Option<std::path::PathBuf>,
        /// Do not keep this run in the eval history (`invincible eval --history`).
        #[arg(long)]
        no_record: bool,
    },
    /// Finished turns kept as fine-tuning data ([agent] trajectories = true, or `eval
    /// --trajectories`): count them, or export them for training a local model.
    Trajectories {
        /// Read this file instead of $AUTOBOT_HOME/trajectories.
        #[arg(long)]
        from: Option<std::path::PathBuf>,
        /// Write them here (JSON Lines); without it, just count.
        #[arg(long)]
        out: Option<std::path::PathBuf>,
        /// openai ({"messages", "tools"}) or sharegpt (Hermes' <tool_call> format).
        #[arg(long, default_value = "openai")]
        format: autobot::trajectory::Format,
        /// Only turns that ended in an answer with nothing refused (and passed, from an eval).
        #[arg(long)]
        clean: bool,
        /// Only turns this model answered in.
        #[arg(long)]
        model: Option<String>,
        /// Only turns since this date (2026-10-01, or RFC 3339).
        #[arg(long)]
        since: Option<String>,
        /// Only the lead's turns (`lead`) or one team member's.
        #[arg(long)]
        agent: Option<String>,
    },
    /// What the agent asked to do and who allowed it (the action log).
    Actions {
        /// At most this many (the newest).
        #[arg(long, default_value_t = 30)]
        limit: usize,
    },
    /// The owner's skills: how-to notes for the agent in $AUTOBOT_HOME/skills (agentskills.io
    /// SKILL.md directories, or a Markdown file each): list, install, remove, accept proposals.
    Skills {
        #[command(subcommand)]
        action: Option<SkillsAction>,
    },
    /// Who the agent is: SOUL.md, and the personality in use (list, show, set).
    Personality {
        #[command(subcommand)]
        action: Option<PersonalityAction>,
    },
    /// What the agent keeps about how you work ($AUTOBOT_HOME/USER.md).
    Profile {
        /// Empty it.
        #[arg(long)]
        clear: bool,
    },
    /// Tokens, time and cost today (and in one conversation), from the turn log.
    Usage {
        /// Also this conversation.
        #[arg(long)]
        session: Option<String>,
    },
    /// What the agent did lately: turns, tools, projects, failures, local against cloud.
    Insights {
        #[arg(long, default_value_t = 7)]
        days: u32,
        #[arg(long)]
        json: bool,
    },
    /// Bring over another agent's SOUL.md, memory, profile, skills, allowlist and model:
    /// `hermes` (Hermes Agent, ~/.hermes) or `openclaw` (~/.openclaw).
    Migrate {
        source: String,
        /// Its directory [default: ~/.hermes ($HERMES_HOME), ~/.openclaw].
        #[arg(long)]
        from: Option<PathBuf>,
        /// Say what would be done; change nothing.
        #[arg(long)]
        dry_run: bool,
        /// Also copy API keys and bot tokens, into Autobot's secret files (0600).
        #[arg(long)]
        with_secrets: bool,
    },
    /// The tool groups and tools, on or off for the bot: list, enable or disable a group or a tool.
    Tools {
        #[command(subcommand)]
        action: Option<ToolsAction>,
    },
    /// The bot's configuration (config.toml, or bots/<name>/bot.toml): show it, or get, set and
    /// unset one dotted key (agent.max_steps, gateway.model). Checked before it is written.
    Config {
        #[command(subcommand)]
        action: Option<ConfigAction>,
    },
    /// The bot's default model: pick one of those the gateway serves, or set it (`auto`: the router
    /// picks).
    Model {
        /// The model id; without it, pick from the list.
        id: Option<String>,
    },
    /// Webhooks that start tasks in `autobot serve` ([hooks] in the config): list them, or make
    /// a secret for a new one.
    Hooks {
        #[command(subcommand)]
        action: Option<HooksAction>,
    },
    /// Scheduled tasks, run by `autobot serve` without anyone to ask: allowlisted commands and
    /// writes in the working directory only.
    Cron {
        #[command(subcommand)]
        action: CronAction,
    },
}

#[derive(Subcommand)]
enum AlertsAction {
    /// Where alerts go, which, and the latest.
    Status,
    /// Send a test alert now, through the running `autobot serve`.
    Test,
}

#[derive(Subcommand)]
enum SessionsAction {
    /// List the saved conversations, newest first.
    List,
    /// Remove the conversations untouched for DAYS days or more (with their undo logs and the
    /// rest kept beside them). They are gone for `recall` too.
    Prune {
        #[arg(long)]
        days: u64,
        /// Only say which would go.
        #[arg(long)]
        dry_run: bool,
    },
}

#[derive(Subcommand)]
enum SkillsAction {
    /// List the skills and the proposals waiting.
    List,
    /// Find skills in the hub (skills.sh, the agentskills.io directory; else GitHub's
    /// agent-skills topic).
    Search {
        query: Vec<String>,
        #[arg(long, default_value_t = 10)]
        limit: usize,
    },
    /// Install skills: from the hub (a name, owner/repo/skill or owner/repo: shown first, installed
    /// when you say yes), a git URL, or a directory.
    Install {
        source: String,
        /// Install from the hub without asking (after reading it).
        #[arg(long, short)]
        yes: bool,
        /// With --yes: install even what the scan calls dangerous (from anyone but an official
        /// source).
        #[arg(long)]
        force: bool,
    },
    /// Whether the skills from the hub (or one) changed where they are pinned, and whether they
    /// were edited here.
    Check { name: Option<String> },
    /// Update skills from the hub (or one) that changed: each shown with what changes, replaced
    /// when you say yes.
    Update {
        name: Option<String>,
        /// Update without asking (after reading it); a skill edited here is left alone.
        #[arg(long, short)]
        yes: bool,
        /// With --yes: update even what the scan calls dangerous, or was edited here.
        #[arg(long)]
        force: bool,
    },
    /// Scan the installed skills (or one) for risky scripts and instructions, with where each
    /// comes from (official, known publisher, community, local).
    Audit { name: Option<String> },
    /// Remove a skill.
    #[command(visible_alias = "uninstall")]
    Remove { name: String },
    /// Keep a skill the agent proposed (or its improvement): it uses it from now on.
    Accept { name: String },
    /// Throw a proposed skill away.
    Reject { name: String },
}

#[derive(Subcommand)]
enum ToolsAction {
    /// Every group and tool, and whether it is on.
    List,
    /// Turn on a tool group (files-read, terminal, …) or one tool (browser).
    Enable { name: String },
    /// Turn off a tool group or one tool.
    Disable { name: String },
}

#[derive(Subcommand)]
enum ConfigAction {
    /// Print a key's value as the bot runs with it, defaults included, and whether it is the
    /// default, set in its file, or inherited from config.toml.
    Get { key: String },
    /// Set a key: VALUE is TOML (true, 24, ["ls"], "text") or else a plain string.
    Set { key: String, value: String },
    /// Take a key out: the default applies.
    Unset { key: String },
}

#[derive(Subcommand)]
enum PersonalityAction {
    /// The personalities: yours, the built-in ones, and which is in use.
    List,
    /// SOUL.md and the one in use, or the text of NAME.
    Show { name: Option<String> },
    /// Use NAME in every conversation from now on (none: no personality).
    Set { name: String },
}

#[derive(Subcommand)]
enum HooksAction {
    /// Make (or replace) the secret for hook NAME and print it, with the config to add.
    New { name: String },
}

#[derive(Subcommand)]
enum CronAction {
    /// Add a task: WHEN is a cron expression ("0 8 * * 1-5", local time), @daily, or "every 30m".
    Add {
        when: String,
        task: String,
        /// Send each answer to Telegram.
        #[arg(long)]
        telegram: bool,
        /// Send each answer here: slack:#ops, email:me@example.com, telegram:123, signal:+1555…
        /// (repeat for several). Without any, answers go to the bot's home channel (/sethome).
        #[arg(long)]
        to: Vec<String>,
    },
    /// List the scheduled tasks, when they run next, and how their last run went.
    List,
    /// Remove a scheduled task.
    Remove { id: String },
    /// Run a scheduled task now, here, the way the scheduler would.
    Run { id: String },
}

#[derive(Subcommand)]
enum TelegramAction {
    /// Let in the Telegram account that was given this code.
    Approve { code: String },
    /// List who may use the bot, and who asked.
    Users,
    /// Remove an account's access, by its numeric id.
    Revoke { id: i64 },
}

#[derive(Subcommand)]
enum HomeAssistantAction {
    /// Keep Home Assistant's address in the config and its long-lived access token (read from
    /// stdin) in a file only you can read, then check them.
    Setup {
        /// http://homeassistant.local:8123
        url: String,
    },
    /// Whether it answers, and how many entities the agent sees.
    Check,
}

#[derive(Subcommand)]
enum AccessAction {
    /// Let in the account that was given this code (whichever bot gave it, unless --bot).
    Approve { code: String },
    /// List who may use the bot, and who asked.
    Users,
    /// Remove an account's access, by its id.
    Revoke { id: String },
}

#[derive(Subcommand)]
#[allow(clippy::large_enum_variant)]
enum BotsAction {
    /// List the bots, and how the running ones are doing.
    List,
    /// Add a bot: a directory of its own in $AUTOBOT_HOME/bots, with bot.toml and SOUL.md.
    /// Asks for what is not given, in a terminal.
    Add {
        name: String,
        /// What it is for.
        #[arg(long)]
        description: Option<String>,
        /// Its persona: SOUL.md's text.
        #[arg(long)]
        soul: Option<String>,
        /// SOUL.md from this file.
        #[arg(long)]
        soul_file: Option<PathBuf>,
        /// Its model: an id the gateway serves, or auto.
        #[arg(long)]
        model: Option<String>,
        /// Only these tool groups (comma-separated: files-read,files-write,terminal,web,memory,mcp,plan).
        #[arg(long, value_delimiter = ',')]
        tools: Option<Vec<String>>,
        /// ask, edits, allowlist or trust.
        #[arg(long)]
        approvals: Option<String>,
        /// Where its tools work [default: its own directory's work/].
        #[arg(long)]
        workdir: Option<PathBuf>,
        /// A Telegram bot token of its own (from @BotFather).
        #[arg(long)]
        telegram_token: Option<String>,
        /// A Discord bot token of its own.
        #[arg(long)]
        discord_token: Option<String>,
        /// A Slack app-level token (xapp-…), with --slack-bot-token.
        #[arg(long)]
        slack_app_token: Option<String>,
        /// A Slack bot token (xoxb-…).
        #[arg(long)]
        slack_bot_token: Option<String>,
        /// Ask nothing: take only what is given.
        #[arg(long, short)]
        yes: bool,
    },
    /// Show a bot's configuration and persona.
    Show { name: String },
    /// Open a bot's bot.toml (or SOUL.md) in $EDITOR.
    Edit {
        name: String,
        /// Its persona instead.
        #[arg(long)]
        soul: bool,
    },
    /// Remove a bot: moved to $AUTOBOT_HOME/bots-removed, with its memory and conversations.
    Remove { name: String },
    /// Let `autobot serve` run it.
    Enable { name: String },
    /// Keep it, but do not run it.
    Disable { name: String },
    /// How the running bots are doing: channels, turns, queue, last error.
    Status,
}

#[derive(Subcommand)]
enum IdentitiesAction {
    /// List who is linked to whom.
    List,
    /// Link ids of one person: `autobot identities link telegram:123 slack:U456`. The first
    /// person linked is the owner.
    Link {
        ids: Vec<String>,
        /// The person's name (default: theirs already, or `owner` for the first).
        #[arg(long)]
        name: Option<String>,
    },
    /// Take an id out.
    Unlink { id: String },
}

#[derive(Subcommand)]
enum ServiceAction {
    /// Install the services (or bring them up to date) and start them; run again, it changes
    /// only what is out of date.
    Install,
    /// Stop and remove them (the data stays).
    Uninstall,
    /// Whether each is installed, enabled and running, and how it last stopped.
    Status,
    /// Restart the running ones (after new binaries or a config change).
    Restart,
}

fn main() -> ExitCode {
    invincible::brand::init();
    match run(Cli::parse()) {
        Ok(()) => ExitCode::SUCCESS,
        Err(message) => {
            eprintln!("{}", invincible::brand::error_line(invincible::brand::Product::Autobot, &message));
            ExitCode::FAILURE
        }
    }
}

fn runtime() -> Result<tokio::runtime::Runtime, String> {
    tokio::runtime::Runtime::new().map_err(|e| format!("runtime: {e}"))
}

fn run(mut cli: Cli) -> Result<(), String> {
    let root = config::home()?;
    if cli.bot.is_none() {
        cli.bot = std::env::var("AUTOBOT_BOT").ok().filter(|b| !b.is_empty());
    }
    // Before reading the configuration: a broken one is what a restore may be for.
    if let Some(Command::Restore { file, dry_run, yes }) = &cli.command {
        return restore(&root, file, *dry_run, *yes);
    }
    // `--bot ops`: its directory and configuration; the default bot's otherwise.
    let def = match &cli.bot {
        Some(name) => autobot::bots::load(&root, name)?,
        None => autobot::bots::load_default(&root)?,
    };
    let home = def.home.clone();
    let config = def.config.clone();
    // Where `approve` looks for a code: this bot, or every bot.
    let homes: Vec<PathBuf> = match &cli.bot {
        Some(_) => vec![home.clone()],
        None => {
            let (defs, _) = autobot::bots::load_all(&root)?;
            defs.into_iter().map(|d| d.home).collect()
        }
    };
    // `autobot` alone: coding, in a git repository; the chat anywhere else.
    let in_repo = std::env::current_dir().is_ok_and(|d| d.join(".git").exists());
    let default = if in_repo {
        Command::Code { dir: None, model: None, approvals: None, session: None, new: false }
    } else {
        Command::Chat { session: "cli".into(), new: false, model: None }
    };
    match cli.command.unwrap_or(default) {
        Command::Setup => setup::run(&mut setup::Prompt::new(std::io::stdin().lock()), &home),
        Command::Chat { session, new, model } => runtime()?.block_on(async {
            let agent = autobot::agent(&config, &home)?;
            let options = autobot::tui::chat::Options { session, new, model, code: false };
            let done = autobot::tui::chat::run(&config, home, agent, options).await;
            autobot::procs::shut_down().await;
            done
        }),
        Command::Code { dir, model, approvals, session, new } => {
            let dir = match dir {
                Some(dir) => dir,
                None => std::env::current_dir().map_err(|e| format!("the current directory: {e}"))?,
            };
            let dir = dir.canonicalize().map_err(|e| format!("{}: {e}", dir.display()))?;
            if !dir.is_dir() {
                return Err(format!("{} is not a directory", dir.display()));
            }
            // What the last `autobot code` used, unless named here.
            let remembered = autobot::tui::chat::Remembered::load(&home);
            let model = model.or(remembered.model);
            let mut config = config;
            if let Some(mode) = approvals.or(remembered.approvals) {
                config.approvals.mode = approval_mode(&mode)?;
            }
            let session = session.unwrap_or_else(|| project_session(&dir));
            runtime()?.block_on(async {
                let mut agent = autobot::agent_in(&config, &home, Some(dir))?;
                autobot::for_coding(&mut agent);
                let options = autobot::tui::chat::Options { session, new, model, code: true };
                let done = autobot::tui::chat::run(&config, home, agent, options).await;
                autobot::procs::shut_down().await;
                done
            })
        }
        Command::Run { task, session, dir, model, approvals, json, cloud, no_sandbox } => runtime()?.block_on(async {
            let mut config = config;
            if let Some(mode) = approvals {
                config.approvals.mode = approval_mode(&mode)?;
            }
            if no_sandbox {
                config.agent.sandbox = autobot::sandbox::Mode::Off;
            }
            let dir = dir.map(|d| d.canonicalize().map_err(|e| format!("{}: {e}", d.display()))).transpose()?;
            let coding = dir.is_some();
            let mut agent = autobot::agent_in(&config, &home, dir)?;
            // Nobody watches a run: its commands are confined like a scheduled task's.
            agent.tools = agent.tools.clone().unattended();
            if let Some(warning) = run_sandbox_warning(&agent.tools, no_sandbox) {
                eprintln!("{}", invincible::brand::warn(&warning));
            }
            if coding {
                autobot::for_coding(&mut agent);
            }
            if let Some(model) = &model {
                let models = agent.gateway.model_info().await.unwrap_or_default();
                autobot::use_model(&mut agent, &config, &models, model)?;
            }
            let mut session = Session::open(&home.join("sessions"), &session)?;
            let streamed = std::sync::atomic::AtomicBool::new(false);
            // Streamed text that has not ended its line yet.
            let open = std::sync::atomic::AtomicBool::new(false);
            let events = |event: Event| {
                if json {
                    println!("{}", event_json(&event));
                    return;
                }
                use std::sync::atomic::Ordering::Relaxed;
                if let Event::Text(text) = event {
                    streamed.store(true, Relaxed);
                    open.store(!text.ends_with('\n'), Relaxed);
                    print!("{text}");
                    let _ = std::io::Write::flush(&mut std::io::stdout());
                } else {
                    if open.swap(false, Relaxed) && !matches!(event, Event::Reasoning(_)) {
                        println!();
                    }
                    // The answer is what streams after the last tool call.
                    if matches!(event, Event::Tool(_) | Event::Output { .. }) {
                        streamed.store(false, Relaxed);
                    }
                    print_event(event);
                }
            };
            let approver = Unattended { cloud };
            let outcome = agent.turn(&mut session, &task, &approver, &mut HashSet::new(), &events).await;
            autobot::procs::shut_down().await;
            match outcome {
                Ok(outcome) if json => {
                    println!(
                        "{}",
                        serde_json::json!({ "type": "answer", "text": outcome.text, "receipts": outcome.receipts })
                    );
                    Ok(())
                }
                Ok(outcome) => {
                    if streamed.load(std::sync::atomic::Ordering::Relaxed) {
                        println!();
                    } else {
                        println!("{}", outcome.text);
                    }
                    Ok(())
                }
                Err(e) if json => {
                    println!("{}", serde_json::json!({ "type": "error", "text": e }));
                    Err(e)
                }
                Err(e) => Err(e),
            }
        }),
        Command::Acp => {
            // Standard output is the protocol's: the log goes to standard error.
            tracing_subscriber::fmt().with_writer(std::io::stderr).with_target(false).init();
            runtime()?.block_on(async {
                let done = autobot::acp::serve(config, home, tokio::io::stdin(), tokio::io::stdout()).await;
                autobot::procs::shut_down().await;
                done
            })
        }
        Command::Serve => {
            tracing_subscriber::fmt().with_target(false).init();
            runtime()?.block_on(serve(root))
        }
        Command::Bots { action } => bots(action.unwrap_or(BotsAction::List), &root),
        Command::Identities { action } => identities(action.unwrap_or(IdentitiesAction::List), &root),
        Command::Discord { action } => access("discord", action, &homes),
        Command::Slack { action } => access("slack", action, &homes),
        Command::Email { action } => access("email", action, &homes),
        Command::Signal { action } => access("signal", action, &homes),
        Command::Matrix { action } => access("matrix", action, &homes),
        Command::Whatsapp { action } => access("whatsapp", action, &homes),
        Command::HomeAssistant { action } => home_assistant(action.unwrap_or(HomeAssistantAction::Check), &def),
        Command::Doctor => {
            let (checks, ready) = runtime()?.block_on(async {
                let checks = doctor::run(&config, &home).await;
                (checks, doctor::readiness(&config, &home).await)
            });
            let failed = checks.iter().chain(&ready).filter(|c| !c.ok).count();
            println!("{}\n", invincible::brand::Product::Autobot.header(invincible::version::VERSION));
            for check in &checks {
                println!("  {}", check.line());
            }
            println!("\n  {}\n", invincible::brand::bold("24/7 readiness"));
            for check in &ready {
                println!("  {}", check.line());
            }
            println!();
            if failed > 0 { Err(format!("{failed} problem(s)")) } else { Ok(()) }
        }
        Command::Telegram { action } => {
            let mut users = telegram::Users::load(&home)?;
            match action {
                TelegramAction::Approve { code } => {
                    let refs: Vec<&std::path::Path> = homes.iter().map(PathBuf::as_path).collect();
                    let (at, user) = autobot::pairing::approve_in(&refs, "telegram", &code)?;
                    println!("{} ({}) can now use {} on Telegram", user.name, user.id, bot_name(&root, at));
                }
                TelegramAction::Users => {
                    for u in &users.allowed {
                        println!("{}  {}", u.id, u.name);
                    }
                    if users.allowed.is_empty() {
                        println!("nobody yet: message the bot, then approve the code it gives you");
                    }
                    for p in &users.pending {
                        println!("waiting: {}  {} ({})", p.code, p.user.name, p.user.id);
                    }
                }
                TelegramAction::Revoke { id } => {
                    if !users.revoke(id) {
                        return Err(format!("{id} is not an allowed user"));
                    }
                    users.save(&home)?;
                    println!("removed {id}");
                }
            }
            Ok(())
        }
        Command::Service { action } => {
            let platform = service::Platform::current()?;
            let user_home = setup::user_home()?;
            let lines = match action {
                ServiceAction::Install => setup::install_services(&home)?,
                ServiceAction::Uninstall => setup::uninstall_services(&home)?,
                ServiceAction::Restart => {
                    let restarted = service::restart(platform, &user_home, &[service::GATEWAY, service::AGENT]);
                    if restarted.is_empty() {
                        vec!["nothing running to restart".to_owned()]
                    } else {
                        restarted.into_iter().map(|name| format!("restarted {name}")).collect()
                    }
                }
                ServiceAction::Status => {
                    let mut services = setup::services(&home)?;
                    services.push(setup::update_job()?.0);
                    service::status(platform, &user_home, &services).iter().map(status_line).collect()
                }
            };
            for line in lines {
                println!("{line}");
            }
            Ok(())
        }
        Command::Update { args } => {
            let program = autobot::find_program("invincible").ok_or("the `invincible` command is not installed")?;
            let mut command = std::process::Command::new(&program);
            command.arg("update").args(&args);
            #[cfg(unix)]
            {
                use std::os::unix::process::CommandExt;
                Err(format!("{}: {}", program.display(), command.exec()))
            }
            #[cfg(not(unix))]
            {
                let status = command.status().map_err(|e| format!("{}: {e}", program.display()))?;
                if status.success() { Ok(()) } else { Err("the update failed".to_owned()) }
            }
        }
        Command::Cron { action } => cron(action, &config, &home),
        Command::Hooks { action } => hooks(action, &config, &home),
        Command::Memory { forget } => {
            let memory = autobot::memory::Memory::new(&home);
            if let Some(id) = forget {
                if !memory.forget(id)? {
                    return Err(format!("no remembered fact #{id}"));
                }
                println!("forgot #{id}");
                return Ok(());
            }
            let facts = memory.list();
            if facts.is_empty() {
                println!("nothing remembered yet");
            }
            for fact in facts {
                println!("#{}  {}", fact.id, fact.text);
            }
            Ok(())
        }
        Command::Eval { tasks, models, cloud, tools, tag, out, trajectories, no_record } => {
            let text = std::fs::read_to_string(&tasks).map_err(|e| format!("{}: {e}", tasks.display()))?;
            let mut list = autobot::eval::parse(&text).map_err(|e| format!("{}: {e}", tasks.display()))?;
            if let Some(tag) = &tag {
                list.retain(|t| t.tags.contains(tag));
            }
            let mut agent = autobot::agent(&config, &home)?;
            if cloud {
                agent.gateway = agent.gateway.with_private(false);
            }
            let scratch = std::env::temp_dir().join(format!("autobot-eval-{}", std::process::id()));
            let only = tools.map(|groups| autobot::tools::tools_for(&groups));
            let (outcomes, tiers) = runtime()?.block_on(async {
                // Which models are on this machine and which in the cloud, for the history.
                // Only for the history: a gateway slow to list them does not hold up the run.
                let listed = tokio::time::timeout(std::time::Duration::from_secs(5), agent.gateway.model_info()).await;
                let tiers: std::collections::BTreeMap<String, String> =
                    listed.ok().and_then(Result::ok).unwrap_or_default().into_iter().map(|m| (m.id, m.tier)).collect();
                let mut outcomes = Vec::new();
                for model in &models {
                    eprintln!("{model}: {} tasks", list.len());
                    for task in &list {
                        let outcome = autobot::eval::run(&agent, model, task, &scratch, only.clone()).await;
                        let mark = if outcome.pass { "✓" } else { "✗" };
                        eprintln!(
                            "  {mark} {} ({:.1} s, {} steps){}",
                            outcome.id,
                            outcome.seconds,
                            outcome.steps,
                            if outcome.pass { String::new() } else { format!(": {}", outcome.failures.join("; ")) }
                        );
                        if let Some(file) = &trajectories
                            && outcome.pass
                        {
                            for t in &outcome.trajectories {
                                autobot::trajectory::append(file, t)?;
                            }
                        }
                        outcomes.push(outcome);
                    }
                }
                Ok::<_, String>((outcomes, tiers))
            })?;
            print!("{}", autobot::eval::report(&outcomes, &models));
            // Kept unless the agent never got to work (the gateway refused, or was not there).
            if !no_record && outcomes.iter().any(|o| !o.error) {
                let stem =
                    tasks.file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_else(|| "tasks".to_owned());
                let run = invincible::eval::Run {
                    at: chrono::Local::now().to_rfc3339_opts(chrono::SecondsFormat::Secs, false),
                    suite: match &tag {
                        Some(tag) => format!("{stem}#{tag}"),
                        None => stem,
                    },
                    digest: invincible::eval::digest(&text, &list.iter().map(|t| t.id.as_str()).collect::<Vec<_>>()),
                    tasks: list.len(),
                    kind: "agent".to_owned(),
                    version: invincible::version::VERSION.to_owned(),
                    models: models
                        .iter()
                        .map(|model| {
                            let mine: Vec<&autobot::eval::Outcome> =
                                outcomes.iter().filter(|o| &o.model == model).collect();
                            let mut seconds: Vec<f64> = mine.iter().map(|o| o.seconds).collect();
                            seconds.sort_by(f64::total_cmp);
                            invincible::eval::ModelRun {
                                model: model.clone(),
                                tier: tiers.get(model).cloned(),
                                passed: mine.iter().filter(|o| o.pass).count(),
                                total: mine.len(),
                                median_ms: seconds.get(seconds.len() / 2).map(|s| (s * 1000.0) as u64),
                                errors: mine.iter().filter(|o| o.error).count(),
                            }
                        })
                        .collect(),
                };
                let kept = invincible::config::home().and_then(|home| {
                    invincible::eval::record(&home, &run)?;
                    Ok(invincible::eval::history_path(&home))
                });
                match kept {
                    Ok(path) => eprintln!("kept in {} (`invincible eval --history`)", path.display()),
                    Err(e) => eprintln!("not kept: {e}"),
                }
            }
            if let Some(file) = &trajectories {
                let kept: usize = outcomes.iter().filter(|o| o.pass).map(|o| o.trajectories.len()).sum();
                println!("{kept} passing runs appended to {}", file.display());
            }
            if let Some(out) = out {
                let json = serde_json::to_string_pretty(&outcomes).map_err(|e| e.to_string())?;
                std::fs::write(&out, json).map_err(|e| format!("{}: {e}", out.display()))?;
            }
            let _ = std::fs::remove_dir_all(scratch);
            Ok(())
        }
        Command::Actions { limit } => {
            let entries = autobot::actions::ActionLog::new(&home).read(0, limit);
            if entries.is_empty() {
                println!("no actions yet");
            }
            for e in entries {
                let at = chrono::DateTime::from_timestamp(e.at as i64, 0)
                    .map(|t| t.with_timezone(&chrono::Local).format("%Y-%m-%d %H:%M").to_string())
                    .unwrap_or_default();
                let verdict = match (e.ran, e.by.as_str()) {
                    (true, "policy") => "allowed by the rules".to_owned(),
                    (true, "grant") => "allowed (always, this session)".to_owned(),
                    (true, by) => format!("approved on {by}"),
                    (false, "policy") => "refused by the rules".to_owned(),
                    (false, "unattended") => "refused (no one to ask)".to_owned(),
                    (false, by) => format!("denied on {by}"),
                };
                // A command that ran also says where and how confined (`sandbox bwrap`, `sandbox off`).
                let verdict = match &e.sandbox {
                    Some(sandbox) => format!("{verdict}, sandbox {sandbox}"),
                    None => verdict,
                };
                println!("{at}  {:<14} {:<44} {}", e.session, verdict, e.action);
            }
            Ok(())
        }
        Command::Skills { action: Some(SkillsAction::Search { query, limit }) } => {
            runtime()?.block_on(autobot::manage::hub_search(&query.join(" "), limit))
        }
        Command::Skills { action: Some(SkillsAction::Install { source, yes, force }) }
            if autobot::manage::from_hub(&source) =>
        {
            runtime()?.block_on(autobot::manage::hub_install(&home, &source, yes, force))
        }
        Command::Skills { action: Some(SkillsAction::Check { name }) } => {
            runtime()?.block_on(autobot::manage::hub_check(&home, name.as_deref()))
        }
        Command::Skills { action: Some(SkillsAction::Update { name, yes, force }) } => {
            runtime()?.block_on(autobot::manage::hub_update(&home, name.as_deref(), yes, force))
        }
        Command::Skills { action: Some(SkillsAction::Audit { name }) } => {
            autobot::manage::skills_audit(&home, name.as_deref())
        }
        Command::Skills { action } => {
            let action = match &action {
                None | Some(SkillsAction::List) => None,
                Some(
                    SkillsAction::Search { .. }
                    | SkillsAction::Check { .. }
                    | SkillsAction::Update { .. }
                    | SkillsAction::Audit { .. },
                ) => None,
                Some(SkillsAction::Install { source, .. }) => Some(("install", source.as_str())),
                Some(SkillsAction::Remove { name }) => Some(("remove", name.as_str())),
                Some(SkillsAction::Accept { name }) => Some(("accept", name.as_str())),
                Some(SkillsAction::Reject { name }) => Some(("reject", name.as_str())),
            };
            autobot::manage::skills(&home, action)
        }
        Command::Personality { action } => match action {
            None | Some(PersonalityAction::List) => autobot::manage::personality(&home, "list", None),
            Some(PersonalityAction::Show { name }) => autobot::manage::personality(&home, "show", name.as_deref()),
            Some(PersonalityAction::Set { name }) => autobot::manage::personality(&home, "set", Some(&name)),
        },
        Command::Tools { action } => match action {
            None | Some(ToolsAction::List) => {
                print!("{}", autobot::settings::tools_listing(&def));
                Ok(())
            }
            Some(ToolsAction::Enable { name }) => {
                println!("{}", autobot::settings::set_tool(&def, &name, true)?);
                Ok(())
            }
            Some(ToolsAction::Disable { name }) => {
                println!("{}", autobot::settings::set_tool(&def, &name, false)?);
                Ok(())
            }
        },
        Command::Config { action } => match &action {
            None => autobot::settings::config(&def, None),
            Some(ConfigAction::Get { key }) => autobot::settings::config(&def, Some(("get", key, None))),
            Some(ConfigAction::Set { key, value }) => {
                autobot::settings::config(&def, Some(("set", key, Some(value.as_str()))))
            }
            Some(ConfigAction::Unset { key }) => autobot::settings::config(&def, Some(("unset", key, None))),
        },
        Command::Model { id } => model_command(&def, id),
        Command::Profile { clear } => autobot::manage::profile(&home, clear),
        Command::Usage { session } => autobot::manage::usage(&home, &config, session.as_deref()),
        Command::Insights { days, json } => autobot::manage::insights(&home, &config, days, json),
        Command::Migrate { source, from, dry_run, with_secrets } => {
            runtime()?.block_on(autobot::manage::migrate(&home, &config, &source, from, dry_run, with_secrets))
        }
        Command::Trajectories { from, out, format, clean, model, since, agent } => {
            use autobot::trajectory;
            let all = match &from {
                Some(file) => trajectory::read(file),
                None => trajectory::load(&home.join("trajectories")),
            };
            if all.is_empty() && from.is_none() && !config.agent.trajectories {
                println!(
                    "no trajectories: turn them on with `trajectories = true` under [agent], or keep an eval's with `autobot eval --trajectories FILE`"
                );
                return Ok(());
            }
            let filter = trajectory::Filter { clean, model, since, agent };
            let kept: Vec<&serde_json::Value> = all.iter().filter(|t| filter.keeps(t)).collect();
            match out {
                None => {
                    print!("{}", trajectory::stats(&all));
                    println!("{} match the filter (export them with --out FILE)", kept.len());
                }
                Some(out) => {
                    let mut text = String::new();
                    for t in &kept {
                        text.push_str(&trajectory::export(t, format).to_string());
                        text.push('\n');
                    }
                    invincible::fsutil::replace_private(&out, &text)?;
                    println!("{} trajectories written to {}", kept.len(), out.display());
                }
            }
            Ok(())
        }
        Command::Backup { out, include_secrets } => {
            let out = out.unwrap_or_else(|| PathBuf::from(autobot::backup::file_name(chrono::Local::now())));
            let manifest = autobot::backup::write(&root, &out, include_secrets, &backup_dirs(&root))?;
            for line in autobot::backup::summary(&out, &manifest) {
                println!("{line}");
            }
            if !include_secrets && config.mcp.values().any(|server| !server.env.is_empty()) {
                println!(
                    "note: config.toml sets environment values for MCP servers; they are in the backup as written"
                );
            }
            Ok(())
        }
        Command::Restore { .. } => unreachable!("dispatched before the configuration is read"),
        Command::Alerts { action: None | Some(AlertsAction::Status) } => {
            let main = autobot::bots::load_default(&root)?;
            for line in autobot::alerts::status(&root, &main.config.alerts) {
                println!("{line}");
            }
            Ok(())
        }
        Command::Alerts { action: Some(AlertsAction::Test) } => alerts_test(&root),
        Command::Logs { which, lines, follow, grep } => {
            let path = autobot::logs::path(&which, &root)?;
            let grep = grep.as_deref();
            let (last, mut pos) = match autobot::logs::tail(&path, lines, grep) {
                Ok(found) => found,
                Err(_) if follow => (Vec::new(), 0),
                Err(e) => return Err(format!("{e} (is the service installed? `autobot service status`)")),
            };
            for line in last {
                println!("{line}");
            }
            if !follow {
                return Ok(());
            }
            loop {
                std::thread::sleep(std::time::Duration::from_millis(500));
                let (new, at) = autobot::logs::read_new(&path, pos)?;
                pos = at;
                for line in new.iter().filter(|l| autobot::logs::matches(l, grep)) {
                    println!("{line}");
                }
            }
        }
        Command::Sessions { action: None | Some(SessionsAction::List) } => {
            for (name, modified) in autobot::session::list(&home.join("sessions")) {
                let ago = modified.elapsed().map(|d| d.as_secs()).unwrap_or(0);
                println!("{name}  {}", human(ago));
            }
            Ok(())
        }
        Command::Sessions { action: Some(SessionsAction::Prune { days, dry_run }) } => {
            if days == 0 {
                return Err("--days 1 at least".to_owned());
            }
            let age = std::time::Duration::from_secs(days * 86400);
            let gone = autobot::session::prune(&home.join("sessions"), age, dry_run)?;
            let bytes: u64 = gone.iter().map(|(_, b)| b).sum();
            for (name, _) in &gone {
                println!("{}{name}", if dry_run { "would remove " } else { "removed " });
            }
            println!("{} conversations, {} KiB, untouched for {days} days or more", gone.len(), bytes.div_ceil(1024));
            Ok(())
        }
    }
}

/// The backup directory `[backup] dir` sets, when the configuration reads (backups leave it out).
fn backup_dirs(root: &std::path::Path) -> Vec<PathBuf> {
    autobot::bots::load_default(root).map(|main| vec![main.config.backup.dir(root)]).unwrap_or_default()
}

/// `autobot restore FILE`.
fn restore(root: &std::path::Path, file: &std::path::Path, dry_run: bool, yes: bool) -> Result<(), String> {
    let skip = backup_dirs(root);
    let (manifest, plan) = autobot::backup::plan(file, root, &skip)?;
    println!(
        "{}: {} file(s) from {}, made {} by autobot {}; every checksum matches",
        file.display(),
        manifest.files.len(),
        manifest.home,
        manifest.created.get(..16).unwrap_or(&manifest.created).replace('T', " "),
        manifest.version
    );
    let show = |what: &str, list: &[String]| {
        if list.is_empty() {
            return;
        }
        println!("{what} ({}):", list.len());
        for path in list.iter().take(20) {
            println!("  {path}");
        }
        if list.len() > 20 {
            println!("  … and {} more", list.len() - 20);
        }
    };
    show("new", &plan.added);
    show("changed", &plan.changed);
    show("gone after the restore (not in the backup)", &plan.removed);
    if !plan.kept.is_empty() {
        println!("kept as they are (not in the backup): {}", plan.kept.join(", "));
    }
    if plan.is_empty() {
        println!("{} already matches it: nothing to do", root.display());
        return Ok(());
    }
    if dry_run {
        println!("dry run: nothing changed");
        return Ok(());
    }
    if !yes {
        if !std::io::IsTerminal::is_terminal(&std::io::stdin()) {
            return Err("not restored: run again with --yes".to_owned());
        }
        let mut prompt = setup::Prompt::new(std::io::stdin().lock());
        if !prompt.yes(&format!("Restore {} from it?", root.display()), false)? {
            return Err("not restored".to_owned());
        }
    }
    let running = live_bots(root).is_some();
    let done = autobot::backup::restore(file, root, &skip)?;
    match &done.previous {
        Some(previous) => {
            println!("restored {}; the home as it was is {} (move it back to undo)", root.display(), previous.display())
        }
        None => println!("restored {}", root.display()),
    }
    if !done.moved.is_empty() {
        println!("moved over from the home as it was: {}", done.moved.join(", "));
    }
    for left in &done.left {
        println!("warning: not moved over, still in the home as it was: {left}");
    }
    if running {
        println!("`autobot serve` is running: `autobot service restart` starts it on the restored home");
    }
    Ok(())
}

/// `autobot alerts test`: through the running `autobot serve`, which has the channels.
fn alerts_test(root: &std::path::Path) -> Result<(), String> {
    let main = autobot::bots::load_default(root)?;
    let token = main.config.gateway.token()?;
    let url = format!("http://{}/v1/agent/alerts/test", main.config.serve.listen);
    let reply: serde_json::Value = runtime()?.block_on(async {
        let reply = reqwest::Client::new()
            .post(url)
            .bearer_auth(token)
            .json(&serde_json::json!({}))
            .timeout(std::time::Duration::from_secs(90))
            .send()
            .await
            .map_err(|_| "`autobot serve` is not running here: alerts go through it".to_owned())?;
        reply.json().await.map_err(|e| e.to_string())
    })?;
    if let Some(e) = reply["error"]["message"].as_str() {
        return Err(e.to_owned());
    }
    let mut failed = false;
    for sent in reply["sent"].as_array().into_iter().flatten() {
        let to = sent["to"].as_str().unwrap_or("?");
        match sent["error"].as_str() {
            None => println!("sent to {to}"),
            Some(e) => {
                failed = true;
                println!("not sent to {to}: {e}");
            }
        }
    }
    if failed { Err("some alerts did not go".to_owned()) } else { Ok(()) }
}

fn cron(action: CronAction, config: &Config, home: &std::path::Path) -> Result<(), String> {
    use autobot::cron::{Schedules, State, When, local};
    let mut schedules = Schedules::load(home)?;
    match action {
        CronAction::Add { when, task, telegram, to } => {
            if telegram && !config.telegram.enabled {
                return Err("Telegram is not set up (`autobot setup`)".to_owned());
            }
            for address in &to {
                autobot::channel::parse_address(address)?;
            }
            let id = schedules.add(&when, &task, telegram)?;
            if let Some(s) = schedules.schedules.iter_mut().find(|s| s.id == id) {
                s.to = to;
            }
            schedules.save(home)?;
            let schedule = schedules.schedules.iter().find(|s| s.id == id).expect("just added");
            let next = When::parse(&schedule.when)?.next(None, local(schedule.created), chrono::Local::now());
            println!(
                "added {id}; next run {}",
                next.map_or("never (within a year)".to_owned(), |t| t.format("%a %Y-%m-%d %H:%M").to_string())
            );
            println!("it runs in `autobot serve` (the background service), with allowlisted commands only");
        }
        CronAction::List => {
            let state = State::load(home)?;
            if schedules.schedules.is_empty() {
                println!("no scheduled tasks (add one with `autobot cron add`)");
            }
            let now = chrono::Local::now();
            for s in &schedules.schedules {
                let last = state.last(s);
                let next =
                    When::parse(&s.when).ok().and_then(|w| w.next(last.map(|r| local(r.at)), local(s.created), now));
                let recipe = s.name.as_ref().map(|n| {
                    let from = match s.origin.as_deref() {
                        Some(o) if o.starts_with("device:") => format!("recipe from {}", &o[7..]),
                        Some(o) if o.starts_with("agent:") => format!("asked in {}", &o[6..]),
                        Some(o) => o.to_owned(),
                        None => "made here".to_owned(),
                    };
                    let tools = s.tools.as_ref().map_or("all tools".to_owned(), |t| format!("tools: {}", t.join(", ")));
                    format!("\"{n}\" ({from} · {tools}) · ")
                });
                println!(
                    "{}  [{}]  {}{}{}{}\n    next: {}",
                    s.id,
                    s.when,
                    recipe.unwrap_or_default(),
                    s.task,
                    if s.telegram { "  → Telegram".to_owned() } else { String::new() }
                        + &s.to.iter().map(|t| format!("  → {t}")).collect::<String>(),
                    if s.enabled { "" } else { "  (off)" },
                    next.map_or("-".to_owned(), |t| t.format("%a %Y-%m-%d %H:%M").to_string())
                );
                if let Some(run) = last.filter(|r| r.result == "running") {
                    println!("    running since {}", local(run.at).format("%Y-%m-%d %H:%M"));
                } else if let Some(run) = last {
                    let line = run.result.lines().next().unwrap_or_default();
                    println!(
                        "    last: {} {} {}",
                        local(run.at).format("%Y-%m-%d %H:%M"),
                        if run.ok { "✓" } else { "✗" },
                        line
                    );
                }
            }
        }
        CronAction::Remove { id } => {
            if !schedules.remove(&id) {
                return Err(format!("no scheduled task {id}"));
            }
            schedules.save(home)?;
            println!("removed {id}");
        }
        CronAction::Run { id } => {
            let schedule =
                schedules.schedules.iter().find(|s| s.id == id).ok_or(format!("no scheduled task {id}"))?.clone();
            runtime()?.block_on(async {
                let agent = autobot::agent(config, home)?;
                let (run, receipts) = autobot::cron::run(&agent, home, &schedule).await;
                println!("{}{}", if run.ok { "" } else { "✗ " }, run.result);
                let kept = autobot::cron::RunRecord {
                    at: run.at,
                    finished: chrono::Local::now().timestamp(),
                    ok: run.ok,
                    result: run.result,
                    receipts,
                    trigger: "manual".to_owned(),
                };
                autobot::cron::record(home, &schedule.id, &kept)?;
                Ok::<_, String>(())
            })?;
        }
    }
    Ok(())
}

/// `autobot model [id]`.
fn model_command(def: &autobot::bots::Def, id: Option<String>) -> Result<(), String> {
    use autobot::settings;
    let gateway = autobot::gateway::Gateway::new(
        &def.config.gateway.url,
        &def.config.gateway.token()?,
        &def.config.gateway.model,
        def.config.gateway.private,
    )?;
    let served = runtime()?.block_on(gateway.model_info());
    if let Some(id) = id {
        let models = match &served {
            Ok(models) => Some(models.as_slice()),
            Err(e) => {
                eprintln!("the gateway did not answer ({e}); {id} is set without checking");
                None
            }
        };
        println!("{}", settings::set_model(def, &id, models)?);
        return Ok(());
    }
    let models = served.map_err(|e| format!("the gateway's models: {e}"))?;
    let rows = settings::model_rows(&models);
    let current = def.config.gateway.model.as_str();
    for (n, (id, what)) in rows.iter().enumerate() {
        let mark =
            if id == current { invincible::brand::paint(invincible::brand::LILAC, "›") } else { " ".to_owned() };
        println!("{mark} {:>2}  {}  {}", n + 1, invincible::brand::bold(id), invincible::brand::ash(what));
    }
    if !std::io::IsTerminal::is_terminal(&std::io::stdin()) {
        println!("\n`autobot model <id>` sets one");
        return Ok(());
    }
    let mut prompt = setup::Prompt::new(std::io::stdin().lock());
    let answer = prompt.ask("\nmodel (number or id)", current)?;
    let id = settings::pick(&answer, &rows).ok_or(format!("{answer:?} is not one of these"))?;
    if id == current {
        println!("model {id}, as it was");
        return Ok(());
    }
    println!("{}", settings::set_model(def, &id, Some(&models))?);
    Ok(())
}

fn human(secs: u64) -> String {
    match secs {
        0..60 => "just now".to_owned(),
        60..3600 => format!("{} min ago", secs / 60),
        3600..86400 => format!("{} h ago", secs / 3600),
        _ => format!("{} days ago", secs / 86400),
    }
}

/// The conversation for the project in [dir]: `code-<name>-<hash of the path>`.
fn project_session(dir: &std::path::Path) -> String {
    let name: String = dir
        .file_name()
        .map(|n| {
            n.to_string_lossy()
                .chars()
                .filter(|c| c.is_ascii_alphanumeric() || *c == '-' || *c == '_')
                .take(32)
                .collect()
        })
        .unwrap_or_default();
    // FNV-1a: stable across runs and versions (std's hasher is not).
    let mut hash: u32 = 0x811c9dc5;
    for b in dir.as_os_str().as_encoded_bytes() {
        hash = (hash ^ u32::from(*b)).wrapping_mul(0x01000193);
    }
    format!("code-{}-{:06x}", if name.is_empty() { "root" } else { &name }, hash & 0xffffff)
}

/// Nobody to ask: no, except to a cloud model when the run said so (`--cloud`).
struct Unattended {
    cloud: bool,
}

impl autobot::approval::Approver for Unattended {
    fn approve<'a>(
        &'a self,
        action: &'a autobot::approval::Action,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = autobot::approval::Answer> + Send + 'a>> {
        let yes = self.cloud && matches!(action, autobot::approval::Action::Cloud(_));
        Box::pin(async move { if yes { autobot::approval::Answer::Once } else { autobot::approval::Answer::Deny } })
    }

    fn channel(&self) -> &'static str {
        "unattended"
    }
}

fn approval_mode(mode: &str) -> Result<config::ApprovalMode, String> {
    Ok(match mode {
        "ask" => config::ApprovalMode::Ask,
        "edits" => config::ApprovalMode::Edits,
        "allowlist" => config::ApprovalMode::Allowlist,
        "trust" => config::ApprovalMode::Trust,
        other => return Err(format!("--approvals {other:?}: ask, edits, allowlist or trust")),
    })
}

/// [event] as a JSON line (`autobot run --json`).
fn event_json(event: &Event) -> serde_json::Value {
    use serde_json::json;
    match event {
        Event::Tool(text) => json!({ "type": "tool", "text": text }),
        Event::Refused(text) => json!({ "type": "refused", "text": text }),
        Event::Receipt { id, model, tier } => json!({ "type": "receipt", "id": id, "model": model, "tier": tier }),
        Event::Member { name, text } => json!({ "type": "member", "agent": name, "text": text }),
        Event::Text(text) => json!({ "type": "text", "text": text }),
        Event::Reasoning(text) => json!({ "type": "reasoning", "text": text }),
        Event::Diff(diff) => json!({ "type": "diff", "diff": diff }),
        Event::Change { path, .. } => json!({ "type": "change", "path": path.display().to_string() }),
        Event::Output { name, text } => json!({ "type": "output", "tool": name, "text": text }),
        Event::Usage { input, output, cached } => {
            json!({ "type": "usage", "input": input, "output": output, "cached": cached })
        }
    }
}

/// What `autobot run` says before it starts when its commands will not run confined: unconfined
/// as asked, or refused for want of a sandbox (as a scheduled task's are).
fn run_sandbox_warning(tools: &autobot::tools::Tools, no_sandbox: bool) -> Option<String> {
    if !tools.offers("terminal") && !tools.offers("execute_code") {
        return None;
    }
    match tools.confinement() {
        "ssh" | "container" => None,
        "off" => Some(format!(
            "commands in this run are not sandboxed ({}): they can write anywhere you can",
            if no_sandbox { "--no-sandbox" } else { "[agent] sandbox = \"off\"" }
        )),
        _ => autobot::sandbox::command(":", tools.workdir()).err().map(|e| {
            format!(
                "commands in this run will be refused: {e}; on a machine you can throw away (a CI container), --no-sandbox runs them unconfined"
            )
        }),
    }
}

fn print_event(event: Event) {
    match event {
        Event::Tool(what) => eprintln!("\x1b[2m› {what}\x1b[0m"),
        Event::Refused(why) => eprintln!("\x1b[2m✗ {why}\x1b[0m"),
        Event::Receipt { id, model, tier } => {
            eprintln!(
                "\x1b[2m  {} · {} · receipt {}\x1b[0m",
                model.unwrap_or("?"),
                tier.unwrap_or("?"),
                &id[..id.len().min(8)]
            )
        }
        Event::Member { name, text } => eprintln!("\x1b[2m[{name}] → {}\x1b[0m", text.replace('\n', " ")),
        Event::Diff(diff) => eprint!("{}", autobot::tui::ui::render_diff(diff, 80)),
        Event::Text(_) | Event::Reasoning(_) | Event::Output { .. } | Event::Usage { .. } | Event::Change { .. } => {}
    }
}

/// Every enabled bot, each in tasks of its own, behind one agent API and one hooks listener.
async fn serve(root: PathBuf) -> Result<(), String> {
    use autobot::bots;
    let main = bots::load_default(&root)?;
    let listen = main.config.serve.listen;
    if !listen.ip().is_loopback() {
        return Err(format!(
            "[serve] listen = {listen}: the agent API must be on loopback (devices reach it through the gateway)"
        ));
    }
    // Started together (at boot, after an upgrade), the gateway may not have made its token yet:
    // wait for it rather than exit into a restart loop.
    let mut waiting = false;
    while let Err(e) = main.config.gateway.token() {
        if !waiting {
            tracing::info!("waiting for the gateway: {e}");
            waiting = true;
        }
        tokio::time::sleep(std::time::Duration::from_secs(5)).await;
    }
    // The bots, live: started now, then kept as their configuration says while this runs.
    let fleet = bots::Fleet::new(&root, Box::new(|def: &bots::Def| autobot::agent(&def.config, &def.home)));
    let (all, _) = bots::load_all(&root)?;
    for def in all.iter().filter(|d| !d.enabled()) {
        tracing::info!("bot {} is disabled (`autobot bots enable {}`)", def.name, def.name);
    }
    fleet.reload()?;
    let runtimes = fleet.runtimes();
    if runtimes.is_empty() {
        return Err("no bot can run (see above)".to_owned());
    }
    let names: Vec<&str> = runtimes.iter().map(|r| r.name.as_str()).collect();
    tracing::info!(
        "serving {} bot(s): {}; bots added or changed are picked up as they are",
        runtimes.len(),
        names.join(", ")
    );

    let state = Arc::new(autobot::api::ApiState::for_fleet(main.config.gateway.token()?, fleet.clone()));
    let listener = tokio::net::TcpListener::bind(listen).await.map_err(|e| format!("listen on {listen}: {e}"))?;
    tracing::info!(
        "agent API on http://{listen} ({}; paired apps reach it through the gateway)",
        invincible::version::VERSION
    );
    invincible::watchdog::spawn("agent", listen, root.join("logs"));
    // Health alerts to the owner, and scheduled backups.
    let alert_bots = fleet.clone();
    let mut background = autobot::alerts::start(&root, Arc::new(move || alert_bots.runtimes()));
    if let Err(e) = main.config.backup.every() {
        tracing::error!("{e}");
    }
    background.push(tokio::spawn(autobot::backup::scheduler(root.clone())));
    // All bots use the one gateway on this machine.
    let gateway = runtimes[0].agent().gateway.clone();
    drop(runtimes);
    let watch_gateway = async move { gateway.watch(std::time::Duration::from_secs(15)).await };
    let api = async move {
        if let Err(e) = axum::serve(listener, autobot::api::app(state)).await {
            tracing::error!("agent API: {e}");
        }
    };
    let watch_bots = fleet.clone().watch(std::time::Duration::from_secs(2));

    // Hooks (and WhatsApp's webhook, Home Assistant's conversation agent): on every address a
    // bot's `[hooks] listen` names, each serving every running bot; the default bot's at
    // /hooks/<name>, another's at /hooks/<bot>/<name>.
    let mut parts = Vec::new();
    let addresses: std::collections::BTreeSet<std::net::SocketAddr> =
        all.iter().filter_map(|d| d.config.hooks.listen).collect();
    for def in all.iter().filter(|d| d.enabled()) {
        let hooks = &def.config.hooks;
        if let Some(bad) = hooks.hooks.keys().find(|n| !autobot::hooks::valid_name(n)) {
            tracing::error!(bot = %def.name, "[hooks.{bad}]: not a hook name (letters, digits, - and _; not whatsapp or homeassistant)");
        }
        if def.config.whatsapp.enabled && addresses.is_empty() {
            tracing::error!(bot = %def.name, "WhatsApp's webhook needs the hooks listener: set [hooks] listen");
        }
        if let Some(at) = hooks.listen.or(addresses.first().copied())
            && !hooks.hooks.is_empty()
        {
            let prefix = if def.default { "/hooks".to_owned() } else { format!("/hooks/{}", def.name) };
            let names: Vec<&String> = hooks.hooks.keys().collect();
            tracing::info!(bot = %def.name, "webhooks on http://{at}{prefix}/<name> ({names:?})");
        }
    }
    let find: Arc<dyn bots::Find> = fleet.clone();
    for at in addresses {
        match tokio::net::TcpListener::bind(at).await {
            Ok(listener) => {
                let app = autobot::hooks::app(find.clone());
                parts.push(tokio::spawn(async move {
                    if let Err(e) = axum::serve(listener, app).await {
                        tracing::error!("hooks: {e}");
                    }
                }))
            }
            Err(e) => tracing::error!("hooks: listen on {at}: {e}"),
        }
    }
    tokio::select! {
        () = api => {}
        () = watch_gateway => {}
        () = watch_bots => {}
        _ = shutdown() => {}
    }
    // Stopping takes a few seconds (what turns left running is asked to stop first); asked
    // again meanwhile, it stops at once.
    tokio::spawn(async {
        let code = shutdown().await;
        tracing::warn!("asked again to stop: stopping now");
        // What runs is killed, not asked: no grace period, and nothing left behind.
        autobot::procs::kill_now();
        std::process::exit(code);
    });
    for part in parts.into_iter().chain(background) {
        part.abort();
    }
    fleet.stop();
    // What the turns left running (a dev server, the browser) stops with the agent, not after:
    // nothing else would stop it, and launchd stops only the agent's own process group.
    let _ = tokio::time::timeout(std::time::Duration::from_secs(10), autobot::procs::shut_down()).await;
    autobot::alerts::stopped(&root).await;
    Ok(())
}

/// `sh.invincible.gateway: running (enabled; last stop: exit code 1; 2 restarts)`.
fn status_line(s: &service::Status) -> String {
    let state = match (s.installed, s.running) {
        (false, _) => return format!("{}: not installed", s.name),
        (true, true) => "running",
        (true, false) => "stopped",
    };
    let mut notes = vec![if s.enabled { "enabled" } else { "not enabled" }.to_owned()];
    if let Some(last) = &s.last_exit {
        notes.push(format!("last stop: {last}"));
    }
    if let Some(n) = s.restarts.filter(|n| *n > 0) {
        notes.push(format!("{n} restart{}", if n == 1 { "" } else { "s" }));
    }
    format!("{}: {state} ({})", s.name, notes.join("; "))
}

/// The name of the bot whose directory is [home].
fn bot_name(root: &std::path::Path, home: &std::path::Path) -> String {
    match autobot::bots::load_all(root) {
        Ok((defs, _)) => defs.into_iter().find(|d| d.home == home).map_or_else(|| "the agent".to_owned(), |d| d.name),
        Err(_) => "the agent".to_owned(),
    }
}

/// `autobot <platform> approve|users|revoke`.
fn access(platform: &str, action: AccessAction, homes: &[PathBuf]) -> Result<(), String> {
    let root = config::home()?;
    let title = {
        let mut name = platform.to_owned();
        name[..1].make_ascii_uppercase();
        name
    };
    match action {
        AccessAction::Approve { code } => {
            let refs: Vec<&std::path::Path> = homes.iter().map(PathBuf::as_path).collect();
            let (at, user) = autobot::pairing::approve_in(&refs, platform, &code)?;
            println!("{} ({}) can now use {} on {title}", user.name, user.id, bot_name(&root, at));
        }
        AccessAction::Users => {
            for home in homes {
                let users = autobot::pairing::Users::load(home, platform)?;
                if homes.len() > 1 && (!users.allowed.is_empty() || !users.pending.is_empty()) {
                    println!("{}:", bot_name(&root, home));
                }
                for u in &users.allowed {
                    println!("  {}  {}", u.id, u.name);
                }
                for p in &users.pending {
                    println!("  waiting: {}  {} ({})", p.code, p.user.name, p.user.id);
                }
            }
            if homes.iter().all(|h| autobot::pairing::Users::load(h, platform).is_ok_and(|u| u.allowed.is_empty())) {
                println!("nobody yet: message the bot, then approve the code it gives you");
            }
        }
        AccessAction::Revoke { id } => {
            let mut removed = false;
            for home in homes {
                let mut users = autobot::pairing::Users::load(home, platform)?;
                if users.revoke(&id) {
                    users.save(home, platform)?;
                    removed = true;
                }
            }
            if !removed {
                return Err(format!("{id} is not an allowed user"));
            }
            println!("removed {id}");
        }
    }
    Ok(())
}

/// The bots, as `autobot serve` reports them now (None when it is not running).
fn live_bots(root: &std::path::Path) -> Option<Vec<serde_json::Value>> {
    let main = autobot::bots::load_default(root).ok()?;
    let token = main.config.gateway.token().ok()?;
    let url = format!("http://{}/v1/agent/bots", main.config.serve.listen);
    runtime().ok()?.block_on(async {
        let reply = invincible::egress::local()
            .build()
            .ok()?
            .get(url)
            .bearer_auth(token)
            .timeout(std::time::Duration::from_secs(3))
            .send()
            .await
            .ok()?;
        let value: serde_json::Value = reply.json().await.ok()?;
        value["bots"].as_array().cloned()
    })
}

/// Asks the running `autobot serve` to bring its bots in line with the configuration now (it
/// would within seconds on its own); what it did, None when it is not running.
fn reload_live(root: &std::path::Path) -> Option<serde_json::Value> {
    let main = autobot::bots::load_default(root).ok()?;
    let token = main.config.gateway.token().ok()?;
    let url = format!("http://{}/v1/agent/bots/reload", main.config.serve.listen);
    runtime().ok()?.block_on(async {
        let reply = reqwest::Client::new()
            .post(url)
            .bearer_auth(token)
            .json(&serde_json::json!({}))
            .timeout(std::time::Duration::from_secs(20))
            .send()
            .await
            .ok()?;
        reply.status().is_success().then_some(())?;
        reply.json().await.ok()
    })
}

/// What the running `autobot serve` did about [name] after a change.
fn live_note(root: &std::path::Path, name: &str) -> String {
    let Some(done) = reload_live(root) else {
        return "`autobot serve` is not running here: it takes this in when it starts".to_owned();
    };
    let named = |key: &str| done[key].as_array().is_some_and(|l| l.iter().any(|n| n == name));
    if let Some(e) = done["failed"].as_array().and_then(|l| l.iter().find(|f| f["name"] == name)) {
        return format!("`autobot serve` could not start it: {}", e["error"].as_str().unwrap_or("?"));
    }
    if named("started") {
        "`autobot serve` runs it now".to_owned()
    } else if named("restarted") {
        "`autobot serve` restarted it with this".to_owned()
    } else if named("stopped") {
        "`autobot serve` stopped it".to_owned()
    } else if named("running") {
        "`autobot serve` runs it".to_owned()
    } else {
        "`autobot serve` does not run it".to_owned()
    }
}

/// `autobot homeassistant setup <url>` and `check`.
fn home_assistant(action: HomeAssistantAction, def: &autobot::bots::Def) -> Result<(), String> {
    use autobot::homeassistant::Home;
    if let HomeAssistantAction::Setup { url } = &action {
        Home::new(url, "-", None)?;
        let tty = std::io::IsTerminal::is_terminal(&std::io::stdin());
        if tty {
            eprintln!("A long-lived access token: Home Assistant, your profile, Security, Create token.");
            eprint!("token: ");
        }
        let mut token = String::new();
        std::io::stdin().read_line(&mut token).map_err(|e| format!("stdin: {e}"))?;
        let token = token.trim();
        if token.is_empty() {
            return Err("no token given".to_owned());
        }
        let path = def.home.join("homeassistant.token");
        invincible::fsutil::replace_private(&path, &format!("{token}\n"))?;
        setup::set(&def.file(), "homeassistant", "url", toml_edit::value(url.trim_end_matches('/')))?;
        println!("kept the address in {} and the token in {} (0600)", def.file().display(), path.display());
    }
    let def = autobot::bots::load(&def.root, &def.name)?;
    let Some(home) = Home::from_config(&def.config.homeassistant, &def.home)? else {
        return Err(
            "Home Assistant is not set up: `autobot homeassistant setup http://homeassistant.local:8123`".to_owned()
        );
    };
    let (about, entities) = runtime()?.block_on(async { (home.about().await, home.list(None, None).await) });
    let about = about?;
    let count = entities.map(|e| e.lines().filter(|l| !l.starts_with('…')).count()).unwrap_or(0);
    println!("{about} at {}: the agent sees {count} entities", home.url());
    println!("changes ask first; allowlist services for unattended runs: [approvals] allow = [\"home:light.*\"]");
    Ok(())
}

fn bots(action: BotsAction, root: &std::path::Path) -> Result<(), String> {
    use autobot::bots;
    match action {
        BotsAction::List | BotsAction::Status => {
            let (defs, problems) = bots::load_all(root)?;
            let live = live_bots(root);
            if live.is_none() {
                println!("autobot serve is not running here (or not reachable on its API)\n");
            }
            for def in &defs {
                let status = live.as_ref().and_then(|l| l.iter().find(|b| b["name"] == def.name.as_str()).cloned());
                let state = match (&status, def.enabled()) {
                    (_, false) => "disabled".to_owned(),
                    (Some(s), true) => format!(
                        "running {} · {} turn(s) now",
                        bots::human(s["uptime"].as_u64().unwrap_or(0)),
                        s["running"]
                    ),
                    (None, true) if live.is_some() => "not running (see the serve log)".to_owned(),
                    (None, true) => "stopped".to_owned(),
                };
                let channels = def.channels();
                println!(
                    "{}{}  {}",
                    def.name,
                    if def.default && def.name != autobot::bots::DEFAULT { " (default)" } else { "" },
                    state
                );
                if !def.config.bot.description.is_empty() {
                    println!("    {}", def.config.bot.description);
                }
                println!(
                    "    model {} · approvals {} · channels {}",
                    status.as_ref().and_then(|s| s["model"].as_str().map(str::to_owned)).unwrap_or_else(|| def
                        .config
                        .gateway
                        .model
                        .clone()),
                    format!("{:?}", def.config.approvals.mode).to_lowercase(),
                    if channels.is_empty() { "none".to_owned() } else { channels.join(", ") }
                );
                if let Some(s) = &status {
                    let states: Vec<String> = s["channels"]
                        .as_object()
                        .into_iter()
                        .flatten()
                        .filter(|(_, v)| v != &"connected")
                        .map(|(k, v)| format!("{k}: {}", v.as_str().unwrap_or("?")))
                        .collect();
                    if !states.is_empty() {
                        println!("    ! {}", states.join("; "));
                    }
                    if matches!(action, BotsAction::Status) {
                        println!(
                            "    queue: {} waiting to be taken in · {} question(s) waiting",
                            s["queued"], s["waiting"]
                        );
                        if let Some(home) = s["home_channel"].as_str() {
                            println!("    home channel: {home}");
                        }
                    }
                    if let Some(e) = s["last_error"].as_object() {
                        println!(
                            "    last error {}: {}",
                            autobot::cron::local(e["at"].as_i64().unwrap_or(0)).format("%Y-%m-%d %H:%M"),
                            e["text"].as_str().unwrap_or("")
                        );
                    }
                }
            }
            for (name, problem) in problems {
                println!("{name}  ✗ {problem}");
            }
            if defs.len() == 1 && matches!(action, BotsAction::List) {
                println!("\nadd another with `autobot bots add <name>`");
            }
            Ok(())
        }
        BotsAction::Add {
            name,
            description,
            soul,
            soul_file,
            model,
            tools,
            approvals,
            workdir,
            telegram_token,
            discord_token,
            slack_app_token,
            slack_bot_token,
            yes,
        } => {
            let soul = match soul_file {
                Some(file) => Some(std::fs::read_to_string(&file).map_err(|e| format!("{}: {e}", file.display()))?),
                None => soul,
            };
            let mut new = bots::NewBot {
                description: description.clone().unwrap_or_default(),
                soul,
                model,
                tools,
                approvals,
                workdir,
                telegram_token,
                discord_token,
                slack_app_token,
                slack_bot_token,
            };
            // Guided, in a terminal: what was not given.
            let ask = !yes && std::io::IsTerminal::is_terminal(&std::io::stdin());
            if ask {
                let mut prompt = setup::Prompt::new(std::io::stdin().lock());
                eprintln!("A new bot, {name}. Enter keeps the default.\n");
                if description.is_none() {
                    new.description = prompt.ask("  what it is for (one line)", "")?;
                }
                if new.soul.is_none() {
                    let persona = prompt.ask("  its persona, in a sentence (SOUL.md; edit it later)", "")?;
                    if !persona.is_empty() {
                        new.soul = Some(format!("{persona}\n"));
                    }
                }
                if new.model.is_none() {
                    let model = prompt.ask("  model (an id the gateway serves)", "auto")?;
                    new.model = (model != "auto").then_some(model);
                }
                if new.approvals.is_none() {
                    let mode = prompt.ask("  approvals: ask, edits, allowlist or trust", "ask")?;
                    new.approvals = (mode != "ask").then_some(mode);
                }
                if new.telegram_token.is_none() && prompt.yes("  a Telegram bot of its own?", false)? {
                    eprintln!("    Make one with @BotFather (/newbot) and paste its token.");
                    new.telegram_token = Some(prompt.ask("    token", "")?);
                }
                if new.slack_bot_token.is_none() && prompt.yes("  a Slack app of its own (Socket Mode)?", false)? {
                    new.slack_app_token = Some(prompt.ask("    app-level token (xapp-…)", "")?);
                    new.slack_bot_token = Some(prompt.ask("    bot token (xoxb-…)", "")?);
                }
            }
            let dir = bots::add(root, &name, &new)?;
            println!("added {name} in {}", dir.display());
            println!("  persona: {} (who it is: its job, its tone, what it never does)", dir.join("SOUL.md").display());
            println!("  config:  {}", dir.join("bot.toml").display());
            println!("{}; `autobot --bot {name} chat` talks to it here", live_note(root, &name));
            Ok(())
        }
        BotsAction::Show { name } => {
            println!("{}", bots::show(&bots::load(root, &name)?));
            Ok(())
        }
        BotsAction::Edit { name, soul } => {
            let def = bots::load(root, &name)?;
            let file = if soul { def.home.join("SOUL.md") } else { def.file() };
            let editor =
                std::env::var("VISUAL").or_else(|_| std::env::var("EDITOR")).unwrap_or_else(|_| "vi".to_owned());
            let status = std::process::Command::new(&editor)
                .arg(&file)
                .status()
                .map_err(|e| format!("{editor}: {e} (set EDITOR)"))?;
            if !status.success() {
                return Err(format!("{editor} exited with {status}"));
            }
            // Say now when the edit does not load.
            bots::load(root, &name)?;
            println!(
                "saved; {}",
                if soul { "its persona applies from its next message".to_owned() } else { live_note(root, &name) }
            );
            Ok(())
        }
        BotsAction::Remove { name } => {
            let to = bots::remove(root, &name)?;
            println!("removed {name}: its directory is now {} (move it back to restore it)", to.display());
            println!("{}", live_note(root, &name));
            Ok(())
        }
        BotsAction::Enable { name } => {
            bots::set_enabled(root, &name, true)?;
            println!("{name} is enabled; {}", live_note(root, &name));
            Ok(())
        }
        BotsAction::Disable { name } => {
            bots::set_enabled(root, &name, false)?;
            println!("{name} is disabled; {}", live_note(root, &name));
            Ok(())
        }
    }
}

fn identities(action: IdentitiesAction, root: &std::path::Path) -> Result<(), String> {
    use autobot::identity::Identities;
    let mut ids = Identities::load(root)?;
    match action {
        IdentitiesAction::List => {
            if ids.people.is_empty() {
                println!(
                    "nobody linked: `autobot identities link telegram:<id> slack:<id>` (ids from `autobot <platform> users`)"
                );
            }
            for person in &ids.people {
                println!("{}  {}", person.name, person.ids.join("  "));
            }
        }
        IdentitiesAction::Link { ids: list, name } => {
            let person = ids.link(&list, name.as_deref())?;
            ids.save(root)?;
            let linked = ids.people.iter().find(|p| p.name == person).map(|p| p.ids.join(", ")).unwrap_or_default();
            println!("{person}: {linked}");
            println!("a direct conversation with {person} is now one conversation on all of these");
        }
        IdentitiesAction::Unlink { id } => {
            if !ids.unlink(&id)? {
                return Err(format!("{id} is not linked"));
            }
            ids.save(root)?;
            println!("unlinked {id}");
        }
    }
    Ok(())
}

/// Waits for SIGTERM or Ctrl-C; the exit code that goes with it (143, 130).
async fn shutdown() -> i32 {
    #[cfg(unix)]
    {
        let mut term = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate()).expect("SIGTERM");
        tokio::select! {
            _ = tokio::signal::ctrl_c() => 130,
            _ = term.recv() => 143,
        }
    }
    #[cfg(not(unix))]
    {
        let _ = tokio::signal::ctrl_c().await;
        130
    }
}

fn hooks(action: Option<HooksAction>, config: &Config, home: &std::path::Path) -> Result<(), String> {
    match action {
        Some(HooksAction::New { name }) => {
            let secret = autobot::hooks::new_secret(home, &name)?;
            let listen = config.hooks.listen.map_or("127.0.0.1:7794".to_owned(), |l| l.to_string());
            println!(
                "secret for {name} (kept in {}):\n\n  {secret}\n",
                autobot::hooks::secret_path(home, &name).display()
            );
            if !config.hooks.hooks.contains_key(&name) {
                println!("add to {}:\n", home.join("config.toml").display());
                if config.hooks.listen.is_none() {
                    println!("  [hooks]\n  listen = \"{listen}\"\n");
                }
                println!("  [hooks.{name}]\n  task = \"What to do when it is called\"\n  telegram = true\n");
            }
            println!(
                "then restart `autobot serve`. Callers sign the body like GitHub (X-Hub-Signature-256) or send\n\
                 Authorization: Bearer <secret> to POST http://{listen}/hooks/{name}"
            );
            Ok(())
        }
        None => {
            if config.hooks.hooks.is_empty() {
                println!("no hooks: `autobot hooks new <name>` makes one");
                return Ok(());
            }
            let listen = config.hooks.listen.map_or("(no [hooks] listen: off)".to_owned(), |l| format!("http://{l}"));
            for (name, hook) in &config.hooks.hooks {
                let secret = if autobot::hooks::secret_path(home, name).exists() || hook.secret_file.is_some() {
                    ""
                } else {
                    " (no secret yet: `autobot hooks new` it)"
                };
                println!("{name}  {listen}/hooks/{name}{secret}");
                println!("    {}", hook.task.trim().chars().take(100).collect::<String>());
                if let Some(run) = autobot::hooks::last_run(home, name) {
                    let when = autobot::cron::local(run.at).format("%Y-%m-%d %H:%M");
                    let first = run.result.lines().next().unwrap_or_default().chars().take(100).collect::<String>();
                    println!("    last run {when}: {}{first}", if run.ok { "" } else { "✗ " });
                }
            }
            Ok(())
        }
    }
}
