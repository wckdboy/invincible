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
    },
    /// Serve the agent API (for paired apps, through the gateway) and Telegram if enabled.
    Serve,
    /// Check the install, the gateway, the model and the channels.
    Doctor,
    /// Telegram access: approve a pairing code, list or remove users.
    Telegram {
        #[command(subcommand)]
        action: TelegramAction,
    },
    /// Discord access: approve a pairing code, list or remove users.
    Discord {
        #[command(subcommand)]
        action: DiscordAction,
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
    /// List the saved conversations.
    Sessions,
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
enum SkillsAction {
    /// List the skills and the proposals waiting.
    List,
    /// Install skills from a git URL or a directory (one with a SKILL.md, or skill directories).
    Install { source: String },
    /// Remove a skill.
    Remove { name: String },
    /// Keep a skill the agent proposed (or its improvement): it uses it from now on.
    Accept { name: String },
    /// Throw a proposed skill away.
    Reject { name: String },
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
enum DiscordAction {
    /// Let in the Discord account that was given this code.
    Approve { code: String },
    /// List who may use the bot, and who asked.
    Users,
    /// Remove an account's access, by its id.
    Revoke { id: String },
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

fn run(cli: Cli) -> Result<(), String> {
    let home = config::home()?;
    let config_path = home.join("config.toml");
    let config = Config::load(&config_path)?;
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
            autobot::procs::stop_all().await;
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
                autobot::procs::stop_all().await;
                done
            })
        }
        Command::Run { task, session, dir, model, approvals, json, cloud } => runtime()?.block_on(async {
            let mut config = config;
            if let Some(mode) = approvals {
                config.approvals.mode = approval_mode(&mode)?;
            }
            let dir = dir.map(|d| d.canonicalize().map_err(|e| format!("{}: {e}", d.display()))).transpose()?;
            let coding = dir.is_some();
            let mut agent = autobot::agent_in(&config, &home, dir)?;
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
            autobot::procs::stop_all().await;
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
        Command::Serve => {
            tracing_subscriber::fmt().with_target(false).init();
            runtime()?.block_on(serve(&config, home))
        }
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
                    let user = users.approve(&code)?;
                    users.save(&home)?;
                    println!("{} ({}) can now use the agent on Telegram", user.name, user.id);
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
        Command::Discord { action } => {
            let mut users = autobot::discord::Users::load(&home)?;
            match action {
                DiscordAction::Approve { code } => {
                    let user = users.approve(&code)?;
                    users.save(&home)?;
                    println!("{} ({}) can now use the agent on Discord", user.name, user.id);
                }
                DiscordAction::Users => {
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
                DiscordAction::Revoke { id } => {
                    if !users.revoke(&id) {
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
        Command::Eval { tasks, models, cloud, tools, tag, out, trajectories } => {
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
            let outcomes = runtime()?.block_on(async {
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
                Ok::<_, String>(outcomes)
            })?;
            print!("{}", autobot::eval::report(&outcomes, &models));
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
                println!("{at}  {:<14} {:<30} {}", e.session, verdict, e.action);
            }
            Ok(())
        }
        Command::Skills { action } => {
            let action = match &action {
                None | Some(SkillsAction::List) => None,
                Some(SkillsAction::Install { source }) => Some(("install", source.as_str())),
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
        Command::Sessions => {
            for (name, modified) in autobot::session::list(&home.join("sessions")) {
                let ago = modified.elapsed().map(|d| d.as_secs()).unwrap_or(0);
                println!("{name}  {}", human(ago));
            }
            Ok(())
        }
    }
}

fn cron(action: CronAction, config: &Config, home: &std::path::Path) -> Result<(), String> {
    use autobot::cron::{Schedules, State, When, local};
    let mut schedules = Schedules::load(home)?;
    match action {
        CronAction::Add { when, task, telegram } => {
            if telegram && !config.telegram.enabled {
                return Err("Telegram is not set up (`autobot setup`)".to_owned());
            }
            let id = schedules.add(&when, &task, telegram)?;
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
                    if s.telegram { "  → Telegram" } else { "" },
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
        Event::Output { name, text } => json!({ "type": "output", "tool": name, "text": text }),
        Event::Usage { input, output, cached } => {
            json!({ "type": "usage", "input": input, "output": output, "cached": cached })
        }
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
        Event::Text(_) | Event::Reasoning(_) | Event::Output { .. } | Event::Usage { .. } => {}
    }
}

async fn serve(config: &Config, home: PathBuf) -> Result<(), String> {
    let listen = config.serve.listen;
    if !listen.ip().is_loopback() {
        return Err(format!(
            "[serve] listen = {listen}: the agent API must be on loopback (devices reach it through the gateway)"
        ));
    }
    // Started together (at boot, after an upgrade), the gateway may not have made its token yet:
    // wait for it rather than exit into a restart loop.
    let mut waiting = false;
    while let Err(e) = config.gateway.token() {
        if !waiting {
            tracing::info!("waiting for the gateway: {e}");
            waiting = true;
        }
        tokio::time::sleep(std::time::Duration::from_secs(5)).await;
    }
    let agent = Arc::new(autobot::agent(config, &home)?);
    let info = serde_json::json!({
        "name": "Autobot",
        "model": config.gateway.model,
        "workdir": agent.tools.workdir().display().to_string(),
        "approvals": format!("{:?}", config.approvals.mode).to_lowercase(),
        "private": config.gateway.private,
    });
    let state = Arc::new(
        autobot::api::ApiState::new(agent.clone(), config.gateway.token()?, home.clone(), info)
            .with_prices(config.prices.clone()),
    );
    let listener = tokio::net::TcpListener::bind(listen).await.map_err(|e| format!("listen on {listen}: {e}"))?;
    tracing::info!(
        "agent API on http://{listen} ({}; paired apps reach it through the gateway)",
        invincible::version::VERSION
    );
    invincible::watchdog::spawn("agent", listen, home.join("logs"));
    let gateway = agent.gateway.clone();
    let watch_gateway = async move { gateway.watch(std::time::Duration::from_secs(15)).await };
    let api = async move {
        if let Err(e) = axum::serve(listener, autobot::api::app(state)).await {
            tracing::error!("agent API: {e}");
        }
    };

    let bot = if config.telegram.enabled {
        match telegram_bot(config, &home).await {
            Ok(bots) => Some(bots),
            Err(e) => {
                // The agent API and schedules keep running; Telegram waits for a fix and a restart.
                tracing::error!("Telegram is off: {e}");
                None
            }
        }
    } else {
        None
    };
    let telegram = async {
        match bot.clone() {
            Some((bot, bots)) => telegram::serve(bot, bots, agent.clone(), home.clone()).await,
            None => std::future::pending::<()>().await,
        }
    };
    let discord = async {
        if !config.discord.enabled {
            return std::future::pending::<()>().await;
        }
        match discord_bot(config, &home).await {
            Ok(bot) => autobot::discord::serve(bot, agent.clone(), home.clone()).await,
            Err(e) => {
                tracing::error!("Discord is off: {e}");
                std::future::pending::<()>().await
            }
        }
    };
    let hooks = async {
        let Some(listen) = config.hooks.listen.filter(|_| !config.hooks.hooks.is_empty()) else {
            return std::future::pending::<()>().await;
        };
        if let Some(bad) = config.hooks.hooks.keys().find(|n| !autobot::hooks::valid_name(n)) {
            tracing::error!("[hooks.{bad}]: not a hook name (letters, digits, - and _); hooks are off");
            return std::future::pending::<()>().await;
        }
        let listener = match tokio::net::TcpListener::bind(listen).await {
            Ok(listener) => listener,
            Err(e) => {
                tracing::error!("hooks: listen on {listen}: {e}");
                return std::future::pending::<()>().await;
            }
        };
        let names: Vec<&String> = config.hooks.hooks.keys().collect();
        tracing::info!("webhooks on http://{listen}/hooks/<name> ({names:?})");
        let app = autobot::hooks::app(
            agent.clone(),
            home.clone(),
            config.hooks.hooks.clone(),
            bot.as_ref().map(|(bot, _)| bot.clone()),
        );
        if let Err(e) = axum::serve(listener, app).await {
            tracing::error!("hooks: {e}");
        }
    };
    let schedules = autobot::cron::scheduler(agent.clone(), home.clone(), bot.as_ref().map(|(bot, _)| bot.clone()));
    let board = autobot::board::dispatcher(agent.clone(), home.clone(), bot.clone());
    let heartbeat = async {
        match config.agent.heartbeat_every() {
            Ok(Some(every)) => {
                autobot::heartbeat::run(agent.clone(), home.clone(), every, bot.as_ref().map(|(b, _)| b.clone())).await
            }
            Ok(None) => std::future::pending::<()>().await,
            Err(e) => {
                tracing::error!("{e}");
                std::future::pending::<()>().await
            }
        }
    };
    tokio::select! {
        () = board => Ok(()),
        () = heartbeat => Ok(()),
        () = api => Ok(()),
        () = telegram => Ok(()),
        () = schedules => Ok(()),
        () = hooks => Ok(()),
        () = discord => Ok(()),
        () = watch_gateway => Ok(()),
        () = shutdown() => Ok(()),
    }
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

async fn discord_bot(config: &Config, home: &std::path::Path) -> Result<autobot::discord::Bot, String> {
    let network = autobot::network()?;
    let client = invincible::egress::client(&network)
        .map_err(|e| format!("Discord needs the network: {e}; set [node] network in the gateway's config"))?;
    let bot = autobot::discord::Bot::new(client, &config.discord.api(), &config.discord.token(home)?, network.clone())?;
    let me = bot.me().await?;
    tracing::info!(
        "Discord bot {} answering (network: {})",
        me["username"].as_str().unwrap_or("?"),
        invincible::egress::route(&network)
    );
    Ok(bot)
}

async fn telegram_bot(config: &Config, home: &std::path::Path) -> Result<(telegram::Bot, Arc<telegram::Bots>), String> {
    let network = autobot::network()?;
    let client = invincible::egress::client(&network)
        .map_err(|e| format!("Telegram needs the network: {e}; set [node] network in the gateway's config"))?;
    let bot = telegram::Bot::new(client.clone(), &config.telegram.api(), &config.telegram.token(home)?)?;
    let me = bot.me().await?;
    let username = me["username"].as_str().unwrap_or_default().to_owned();
    tracing::info!("Telegram bot @{username} answering (network: {})", invincible::egress::route(&network));
    // Team members with bots of their own: they post; a broken one is skipped (the main bot
    // posts for it).
    let mut members = std::collections::HashMap::new();
    for (name, role) in &config.agents {
        let Some(file) = &role.telegram_token_file else { continue };
        let path = if file.is_absolute() { file.clone() } else { home.join(file) };
        let member = std::fs::read_to_string(&path)
            .map_err(|e| format!("{}: {e}", path.display()))
            .and_then(|token| telegram::Bot::new(client.clone(), &config.telegram.api(), token.trim()));
        let checked = match member {
            Ok(member) => member.me().await.map(|me| (member, me)),
            Err(e) => Err(e),
        };
        match checked {
            Ok((member, me)) => {
                tracing::info!("team member {name} posts as @{}", me["username"].as_str().unwrap_or("?"));
                members.insert(name.clone(), member);
            }
            Err(e) => tracing::warn!("team member {name}: its Telegram bot is off: {e}"),
        }
    }
    Ok((bot, Arc::new(telegram::Bots { username, members })))
}

async fn shutdown() {
    #[cfg(unix)]
    {
        let mut term = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate()).expect("SIGTERM");
        tokio::select! {
            _ = tokio::signal::ctrl_c() => {}
            _ = term.recv() => {}
        }
    }
    #[cfg(not(unix))]
    let _ = tokio::signal::ctrl_c().await;
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
