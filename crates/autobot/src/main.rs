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
    /// Scheduled tasks, run by `autobot serve` without anyone to ask: allowlisted commands and
    /// writes in the working directory only.
    Cron {
        #[command(subcommand)]
        action: CronAction,
    },
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
                let last = state.runs.get(&s.id);
                let next =
                    When::parse(&s.when).ok().and_then(|w| w.next(last.map(|r| local(r.at)), local(s.created), now));
                println!(
                    "{}  [{}]  {}{}\n    next: {}",
                    s.id,
                    s.when,
                    s.task,
                    if s.telegram { "  → Telegram" } else { "" },
                    next.map_or("-".to_owned(), |t| t.format("%a %Y-%m-%d %H:%M").to_string())
                );
                if let Some(run) = last {
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
                let run = autobot::cron::run(&agent, home, &schedule).await;
                println!("{}{}", if run.ok { "" } else { "✗ " }, run.result);
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
    fn approve<'a>(&'a self, action: &'a Action) -> Pin<Box<dyn Future<Output = Answer> + Send + 'a>> {
        Box::pin(async move {
            loop {
                eprint!("\x1b[1mApprove?\x1b[0m {}  [y]es / [a]lways this session / [N]o: ", action.describe());
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
    let state =
        Arc::new(autobot::api::ApiState::new(agent.clone(), config.gateway.token()?, home.join("sessions"), info));
    let listener = tokio::net::TcpListener::bind(listen).await.map_err(|e| format!("listen on {listen}: {e}"))?;
    tracing::info!("agent API on http://{listen} (paired apps reach it through the gateway)");
    let api = async move {
        if let Err(e) = axum::serve(listener, autobot::api::app(state)).await {
            tracing::error!("agent API: {e}");
        }
    };

    let bot = if config.telegram.enabled {
        match telegram_bot(config, &home).await {
            Ok(bot) => Some(bot),
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
            Some(bot) => telegram::serve(bot, agent.clone(), home.clone()).await,
            None => std::future::pending::<()>().await,
        }
    };
    let schedules = autobot::cron::scheduler(agent.clone(), home.clone(), bot.clone());
    tokio::select! {
        () = api => Ok(()),
        () = telegram => Ok(()),
        () = schedules => Ok(()),
        () = shutdown() => Ok(()),
    }
}

async fn telegram_bot(config: &Config, home: &std::path::Path) -> Result<telegram::Bot, String> {
    let network = autobot::network()?;
    let client = invincible::egress::client(&network)
        .map_err(|e| format!("Telegram needs the network: {e}; set [node] network in the gateway's config"))?;
    let bot = telegram::Bot::new(client, &config.telegram.api(), &config.telegram.token(home)?)?;
    let me = bot.me().await?;
    tracing::info!(
        "Telegram bot @{} answering (network: {})",
        me["username"].as_str().unwrap_or("?"),
        invincible::egress::route(&network)
    );
    Ok(bot)
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
