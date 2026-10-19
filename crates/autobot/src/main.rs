//! The `autobot` command.

use std::collections::HashSet;
use std::future::Future;
use std::io::Write;
use std::path::PathBuf;
use std::pin::Pin;
use std::process::ExitCode;
use std::sync::Arc;

use autobot::agent::Event;
use autobot::approval::{Action, Answer, Approver, Refuse};
use autobot::config::{self, Config};
use autobot::session::Session;
use autobot::{doctor, service, setup, telegram};
use clap::{Parser, Subcommand};
use tokio::sync::{Mutex, mpsc};

#[derive(Parser)]
#[command(version, about = "The Autobot Agent, on Invincible Gateway. With no command: chat.")]
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
    },
    /// Do one task and print the answer. Anything that needs approval is refused unless allowlisted.
    Run {
        task: String,
        #[arg(long, default_value = "run")]
        session: String,
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
    /// Run the gateway and the agent in the background (launchd on macOS, systemd on Linux).
    Service {
        #[command(subcommand)]
        action: ServiceAction,
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
    },
    /// What the agent asked to do and who allowed it (the action log).
    Actions {
        /// At most this many (the newest).
        #[arg(long, default_value_t = 30)]
        limit: usize,
    },
    /// The owner's skills: how-to notes for the agent, one Markdown file each in $AUTOBOT_HOME/skills.
    Skills {
        #[command(subcommand)]
        action: Option<SkillsAction>,
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
    /// Keep a skill the agent proposed: it uses it from now on.
    Accept { name: String },
    /// Throw a proposed skill away.
    Reject { name: String },
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
enum ServiceAction {
    Install,
    Uninstall,
    Status,
}

fn main() -> ExitCode {
    match run(Cli::parse()) {
        Ok(()) => ExitCode::SUCCESS,
        Err(message) => {
            eprintln!("autobot: {message}");
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
    match cli.command.unwrap_or(Command::Chat { session: "cli".into(), new: false }) {
        Command::Setup => setup::run(&mut setup::Prompt::new(std::io::stdin().lock()), &home),
        Command::Chat { session, new } => runtime()?.block_on(chat(&config, home, &session, new)),
        Command::Run { task, session } => runtime()?.block_on(async {
            let agent = autobot::agent(&config, &home)?;
            let mut session = Session::open(&home.join("sessions"), &session)?;
            let outcome = agent.turn(&mut session, &task, &Refuse, &mut HashSet::new(), &print_event).await?;
            println!("{}", outcome.text);
            Ok(())
        }),
        Command::Serve => {
            tracing_subscriber::fmt().with_target(false).init();
            runtime()?.block_on(serve(&config, home))
        }
        Command::Doctor => {
            let checks = runtime()?.block_on(doctor::run(&config, &home));
            let failed = checks.iter().filter(|c| !c.ok).count();
            for check in &checks {
                println!("{} {}", if check.ok { "✓" } else { "✗" }, check.what);
            }
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
        Command::Service { action } => {
            let platform = service::Platform::current()?;
            let user_home = setup::user_home()?;
            let services = setup::services(&home)?;
            let lines = match action {
                ServiceAction::Install => service::install(platform, &user_home, &services)?,
                ServiceAction::Uninstall => service::uninstall(platform, &user_home, &services)?,
                ServiceAction::Status => service::status(platform, &user_home, &services)
                    .into_iter()
                    .map(|(name, installed, running)| {
                        format!(
                            "{name}: {}",
                            if running {
                                "running"
                            } else if installed {
                                "stopped"
                            } else {
                                "not installed"
                            }
                        )
                    })
                    .collect(),
            };
            for line in lines {
                println!("{line}");
            }
            Ok(())
        }
        Command::Cron { action } => cron(action, &config, &home),
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
        Command::Eval { tasks, models, cloud, tools, tag, out } => {
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
                        outcomes.push(outcome);
                    }
                }
                outcomes
            });
            print!("{}", autobot::eval::report(&outcomes, &models));
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
            match action {
                Some(SkillsAction::Accept { name }) => {
                    autobot::skills::accept(&home, &name)?;
                    println!("kept {name}: the agent uses it from now on");
                    return Ok(());
                }
                Some(SkillsAction::Reject { name }) => {
                    if !autobot::skills::reject(&home, &name)? {
                        return Err(format!("there is no proposed skill {name:?}"));
                    }
                    println!("threw {name} away");
                    return Ok(());
                }
                None => {}
            }
            let skills = autobot::skills::list(&home);
            if skills.is_empty() {
                println!("no skills yet: put Markdown files in {}", home.join("skills").display());
            }
            for skill in skills {
                println!("{}  {}", skill.name, skill.description);
            }
            let proposals = autobot::skills::proposals(&home);
            if !proposals.is_empty() {
                println!("\nproposed by the agent (`autobot skills accept <name>`, or reject):");
                for skill in proposals {
                    println!("{}  {}  ({})", skill.name, skill.description, skill.path.display());
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
    }
}

/// Terminal lines, read on their own thread so the prompt and approvals share one stdin.
type Lines = Arc<Mutex<mpsc::UnboundedReceiver<String>>>;

fn stdin_lines() -> Lines {
    let (tx, rx) = mpsc::unbounded_channel();
    std::thread::spawn(move || {
        for line in std::io::stdin().lines() {
            let Ok(line) = line else { break };
            if tx.send(line).is_err() {
                break;
            }
        }
    });
    Arc::new(Mutex::new(rx))
}

struct TerminalApprover {
    lines: Lines,
}

impl Approver for TerminalApprover {
    fn channel(&self) -> &'static str {
        "cli"
    }

    fn approve<'a>(&'a self, action: &'a Action) -> Pin<Box<dyn Future<Output = Answer> + Send + 'a>> {
        Box::pin(async move {
            loop {
                eprint!(
                    "{}\x1b[1mApprove?\x1b[0m {}  [y]es / [a]lways this session / [N]o: ",
                    autobot::approval::asker(),
                    action.describe()
                );
                std::io::stderr().flush().ok();
                let Some(line) = self.lines.lock().await.recv().await else { return Answer::Deny };
                match line.trim().to_ascii_lowercase().as_str() {
                    "y" | "yes" => return Answer::Once,
                    "a" | "always" => return Answer::Always,
                    "" | "n" | "no" => return Answer::Deny,
                    _ => {}
                }
            }
        })
    }
}

async fn chat(config: &Config, home: PathBuf, name: &str, new: bool) -> Result<(), String> {
    let agent = autobot::agent(config, &home)?;
    let mut session = Session::open(&home.join("sessions"), name)?;
    if new {
        session.reset()?;
    }
    let lines = stdin_lines();
    let approver = TerminalApprover { lines: lines.clone() };
    let mut grants = HashSet::new();
    eprintln!(
        "Autobot · {} via Invincible Gateway · tools in {} · /new, /exit",
        agent.gateway.model(),
        agent.tools.workdir().display()
    );
    if !session.messages.is_empty() {
        eprintln!("(continuing \"{}\", {} messages; /new to start over)", session.id, session.messages.len());
    }
    loop {
        eprint!("\n\x1b[1m›\x1b[0m ");
        std::io::stderr().flush().ok();
        let Some(line) = lines.lock().await.recv().await else { return Ok(()) };
        let text = line.trim();
        match text {
            "" => continue,
            "/exit" | "/quit" => return Ok(()),
            "/new" => {
                session.reset()?;
                grants.clear();
                eprintln!("new conversation");
                continue;
            }
            _ => {}
        }
        match agent.turn(&mut session, text, &approver, &mut grants, &print_event).await {
            Ok(outcome) => println!("\n{}", outcome.text),
            Err(e) => eprintln!("✗ {e}"),
        }
    }
}

async fn serve(config: &Config, home: PathBuf) -> Result<(), String> {
    let listen = config.serve.listen;
    if !listen.ip().is_loopback() {
        return Err(format!(
            "[serve] listen = {listen}: the agent API must be on loopback (devices reach it through the gateway)"
        ));
    }
    let agent = Arc::new(autobot::agent(config, &home)?);
    let info = serde_json::json!({
        "name": "Autobot",
        "model": config.gateway.model,
        "workdir": agent.tools.workdir().display().to_string(),
        "approvals": format!("{:?}", config.approvals.mode).to_lowercase(),
        "private": config.gateway.private,
    });
    let state = Arc::new(autobot::api::ApiState::new(agent.clone(), config.gateway.token()?, home.clone(), info));
    let listener = tokio::net::TcpListener::bind(listen).await.map_err(|e| format!("listen on {listen}: {e}"))?;
    tracing::info!("agent API on http://{listen} (paired apps reach it through the gateway)");
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
        () = shutdown() => Ok(()),
    }
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
