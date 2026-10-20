//! Bots: several agents on one machine, each with its own persona, model, tools, approvals,
//! working directory, memory, skills, schedules and channels, all served by one `autobot serve`.
//!
//! The configuration you already have is the default bot (`$AUTOBOT_HOME`, `config.toml`), and
//! keeps working as it is. Every other bot is a directory of its own:
//!
//! ```text
//! ~/.autobot/bots/ops/
//!   bot.toml        # what differs from config.toml: [bot], [gateway] model, [agent], [approvals], channels
//!   SOUL.md         # its persona, given to the model first
//!   memory.jsonl, skills/, sessions/, schedules.json, telegram.token, slack-users.json, work/ …
//! ```
//!
//! A bot inherits `config.toml` (the gateway, `[agent]`, `[approvals]`, `[mcp]`, the team,
//! `[voice]`) except its channels, `[hooks]` and `[serve]`, and `bot.toml` overrides any of it.
//! Its memory, skills, conversations, schedules and channel users live in its own directory, so
//! nothing leaks between bots. A channel's token belongs to one bot: a second bot with the same
//! token gets that channel turned off.
//!
//! Each bot runs in tasks of its own: a bot whose model is slow, or whose channel fails, does not
//! hold up another; a part that stops is started again.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, RwLock, Weak};
use std::time::{Duration, Instant};

use serde::Deserialize;
use serde_json::{Value, json};

use crate::agent::Agent;
use crate::channel::{Conversations, Transport};
use crate::config::Config;

/// The default bot's name, unless `[bot] name` says otherwise.
pub const DEFAULT: &str = "default";

/// Sections of `config.toml` a bot does not inherit: its channels, hooks and the API are its own.
const OWN: &[&str] = &["telegram", "discord", "slack", "email", "signal", "matrix", "hooks", "serve", "bot"];

/// `[bot]`: about this bot.
#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct BotConfig {
    /// The default bot's name (a named bot is called as its directory).
    #[serde(default)]
    pub name: Option<String>,
    /// What it is for, for `autobot bots` and `/bots`.
    #[serde(default)]
    pub description: String,
    /// `autobot serve` runs it.
    #[serde(default = "yes")]
    pub enabled: bool,
}

fn yes() -> bool {
    true
}

impl Default for BotConfig {
    fn default() -> Self {
        Self { name: None, description: String::new(), enabled: true }
    }
}

/// A bot name: lowercase letters, digits, `-` and `_`, starting with a letter, at most 32.
pub fn valid_name(name: &str) -> bool {
    (1..=32).contains(&name.len())
        && name.starts_with(|c: char| c.is_ascii_lowercase())
        && name.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-' || c == '_')
}

/// A bot as configured.
#[derive(Clone, Debug)]
pub struct Def {
    pub name: String,
    /// `$AUTOBOT_HOME`: identities and the bots' directories are here.
    pub root: PathBuf,
    /// Its own directory (the default bot's is `$AUTOBOT_HOME`).
    pub home: PathBuf,
    pub config: Config,
    pub default: bool,
}

impl Def {
    pub fn enabled(&self) -> bool {
        self.config.bot.enabled
    }

    /// Its configuration file.
    pub fn file(&self) -> PathBuf {
        if self.default { self.home.join("config.toml") } else { self.home.join("bot.toml") }
    }

    /// Its persona, when it has one.
    pub fn soul(&self) -> Option<String> {
        soul(&self.home)
    }

    /// The channels it has turned on.
    pub fn channels(&self) -> Vec<&'static str> {
        let c = &self.config;
        [
            ("telegram", c.telegram.enabled),
            ("discord", c.discord.enabled),
            ("slack", c.slack.enabled),
            ("email", c.email.enabled),
            ("signal", c.signal.enabled),
            ("matrix", c.matrix.enabled),
        ]
        .into_iter()
        .filter(|(_, on)| *on)
        .map(|(name, _)| name)
        .collect()
    }

    /// What identifies each channel's account (a token's hash), to find two bots on one account.
    pub fn accounts(&self) -> Vec<(&'static str, String)> {
        let c = &self.config;
        let hash = |text: &str| invincible::token::hex(&<sha2::Sha256 as sha2::Digest>::digest(text.trim().as_bytes()));
        let mut accounts = Vec::new();
        if c.telegram.enabled
            && let Ok(token) = c.telegram.token(&self.home)
        {
            accounts.push(("telegram", hash(&token)));
        }
        if c.discord.enabled
            && let Ok(token) = c.discord.token(&self.home)
        {
            accounts.push(("discord", hash(&token)));
        }
        if c.slack.enabled
            && let Ok(token) = c.slack.bot_token(&self.home)
        {
            accounts.push(("slack", hash(&token)));
        }
        if c.email.enabled && !c.email.address.is_empty() {
            accounts.push(("email", hash(&c.email.address.to_ascii_lowercase())));
        }
        if c.signal.enabled && !c.signal.account.is_empty() {
            accounts.push(("signal", hash(&c.signal.account)));
        }
        if c.matrix.enabled
            && let Ok(token) = c.matrix.token(&self.home)
        {
            accounts.push(("matrix", hash(&token)));
        }
        accounts
    }
}

/// `SOUL.md` in [home]: who the bot is, in the owner's words.
pub fn soul(home: &Path) -> Option<String> {
    let text = std::fs::read_to_string(home.join("SOUL.md")).ok()?;
    let text = text.trim();
    (!text.is_empty()).then(|| text.chars().take(8000).collect())
}

pub fn dir(root: &Path) -> PathBuf {
    root.join("bots")
}

/// The configuration of a bot: `config.toml` without the sections it does not inherit, with
/// `bot.toml` over it.
pub fn merge(main: &str, bot: &str) -> Result<Config, String> {
    let mut base: toml::Table = toml::from_str(main).map_err(|e| format!("config.toml: {e}"))?;
    for key in OWN {
        base.remove(*key);
    }
    let over: toml::Table = toml::from_str(bot).map_err(|e| e.to_string().trim().to_owned())?;
    deep_merge(&mut base, over);
    toml::Value::Table(base).try_into::<Config>().map_err(|e| e.to_string().trim().to_owned())
}

fn deep_merge(base: &mut toml::Table, over: toml::Table) {
    for (key, value) in over {
        match (base.get_mut(&key), value) {
            (Some(toml::Value::Table(b)), toml::Value::Table(o)) => deep_merge(b, o),
            (_, value) => {
                base.insert(key, value);
            }
        }
    }
}

/// The default bot.
pub fn load_default(root: &Path) -> Result<Def, String> {
    let config = Config::load(&root.join("config.toml"))?;
    let name = config.bot.name.clone().filter(|n| valid_name(n)).unwrap_or_else(|| DEFAULT.to_owned());
    Ok(Def { name, root: root.to_owned(), home: root.to_owned(), config, default: true })
}

/// The bot called [name] (the default bot by its name, too).
pub fn load(root: &Path, name: &str) -> Result<Def, String> {
    let default = load_default(root)?;
    if name == default.name {
        return Ok(default);
    }
    if !valid_name(name) {
        return Err(format!("{name:?} is not a bot name (lowercase letters, digits, - and _)"));
    }
    let home = dir(root).join(name);
    let file = home.join("bot.toml");
    let bot =
        std::fs::read_to_string(&file).map_err(|_| format!("there is no bot {name:?} (`autobot bots add {name}`)"))?;
    let main = invincible::fsutil::read_optional(&root.join("config.toml"))?.unwrap_or_default();
    let mut config = merge(&main, &bot).map_err(|e| format!("{}: {e}", file.display()))?;
    config.bot.name = Some(name.to_owned());
    Ok(Def { name: name.to_owned(), root: root.to_owned(), home, config, default: false })
}

/// Bots that could not be read, and why.
pub type Problems = Vec<(String, String)>;

/// Every bot: the default one first, then the others by name; and the bots that could not be
/// read, with why.
pub fn load_all(root: &Path) -> Result<(Vec<Def>, Problems), String> {
    let mut defs = vec![load_default(root)?];
    let mut problems = Vec::new();
    let mut names: Vec<String> = std::fs::read_dir(dir(root))
        .map(|entries| {
            entries
                .flatten()
                .filter(|e| e.path().join("bot.toml").is_file())
                .filter_map(|e| e.file_name().to_str().map(str::to_owned))
                .collect()
        })
        .unwrap_or_default();
    names.sort();
    for name in names {
        if name == defs[0].name {
            problems.push((name, "has the default bot's name; rename its directory".to_owned()));
            continue;
        }
        match load(root, &name) {
            Ok(def) => defs.push(def),
            Err(e) => problems.push((name, e)),
        }
    }
    Ok((defs, problems))
}

/// Channels that two bots share an account on: (the later bot, the platform, the earlier bot).
/// The later one's channel stays off.
pub fn shared_accounts(defs: &[Def]) -> Vec<(String, &'static str, String)> {
    let mut seen: Vec<(&'static str, String, String)> = Vec::new();
    let mut shared = Vec::new();
    for def in defs.iter().filter(|d| d.enabled()) {
        for (platform, account) in def.accounts() {
            match seen.iter().find(|(p, a, _)| *p == platform && *a == account) {
                Some((_, _, first)) => shared.push((def.name.clone(), platform, first.clone())),
                None => seen.push((platform, account, def.name.clone())),
            }
        }
    }
    shared
}

/// A running bot: its agent, its conversations on every platform, and where it can send.
pub struct Runtime {
    pub name: String,
    pub root: PathBuf,
    pub home: PathBuf,
    pub config: Config,
    pub default: bool,
    agent: RwLock<Arc<Agent>>,
    started: Instant,
    pub conversations: Conversations,
    transports: Mutex<BTreeMap<&'static str, Arc<dyn Transport>>>,
    channels: Mutex<BTreeMap<String, String>>,
    /// Each channel's account (`@mybot`, `bot@example.org`), once it is known.
    accounts: Mutex<BTreeMap<String, String>>,
    turns: AtomicU64,
    running: AtomicUsize,
    last_error: Mutex<Option<(i64, String)>>,
    peers: Mutex<Vec<Weak<Runtime>>>,
}

impl Runtime {
    pub fn new(def: &Def, agent: Agent) -> Arc<Self> {
        Arc::new(Self {
            name: def.name.clone(),
            root: def.root.clone(),
            home: def.home.clone(),
            config: def.config.clone(),
            default: def.default,
            agent: RwLock::new(Arc::new(agent)),
            started: Instant::now(),
            conversations: Conversations::default(),
            transports: Mutex::default(),
            channels: Mutex::default(),
            accounts: Mutex::default(),
            turns: AtomicU64::new(0),
            running: AtomicUsize::new(0),
            last_error: Mutex::default(),
            peers: Mutex::default(),
        })
    }

    /// One bot on its own, with the default configuration (tests, and callers with an agent of
    /// their own).
    pub fn standalone(name: &str, home: &Path, agent: Arc<Agent>) -> Arc<Self> {
        let def = Def {
            name: name.to_owned(),
            root: home.to_owned(),
            home: home.to_owned(),
            config: Config::parse("").expect("the defaults parse"),
            default: true,
        };
        let runtime = Self::new(&def, (*agent).clone());
        *runtime.agent.write().expect("agent") = agent;
        runtime
    }

    /// The agent as it is now (`/model` can change it between turns).
    pub fn agent(&self) -> Arc<Agent> {
        self.agent.read().expect("agent").clone()
    }

    pub fn set_agent(&self, agent: Agent) {
        *self.agent.write().expect("agent") = Arc::new(agent);
    }

    /// The bots served with this one.
    pub fn link_peers(all: &[Arc<Runtime>]) {
        for runtime in all {
            *runtime.peers.lock().expect("peers") = all.iter().map(Arc::downgrade).collect();
        }
    }

    pub fn register(&self, transport: Arc<dyn Transport>) {
        let platform = transport.platform();
        self.transports.lock().expect("transports").insert(platform, transport);
        self.channel_state(platform, "connected");
    }

    pub fn transport(&self, platform: &str) -> Option<Arc<dyn Transport>> {
        self.transports.lock().expect("transports").get(platform).cloned()
    }

    /// The account [platform] is connected as.
    pub fn channel_account(&self, platform: &str, account: &str) {
        self.accounts.lock().expect("accounts").insert(platform.to_owned(), account.to_owned());
    }

    pub fn accounts(&self) -> BTreeMap<String, String> {
        self.accounts.lock().expect("accounts").clone()
    }

    pub fn channel_state(&self, platform: &str, state: &str) {
        self.channels.lock().expect("channels").insert(platform.to_owned(), state.to_owned());
    }

    pub fn error(&self, text: &str) {
        let at = chrono::Local::now().timestamp();
        *self.last_error.lock().expect("last error") = Some((at, text.chars().take(400).collect()));
    }

    pub fn turn_started(&self) {
        self.running.fetch_add(1, Ordering::Relaxed);
        self.turns.fetch_add(1, Ordering::Relaxed);
    }

    pub fn turn_ended(&self) {
        self.running.fetch_sub(1, Ordering::Relaxed);
    }

    pub fn uptime(&self) -> Duration {
        self.started.elapsed()
    }

    /// Where scheduled results and notices go when nothing else is said (`/sethome`).
    pub fn home_channel(&self) -> Option<String> {
        let text = std::fs::read_to_string(self.home.join("home-channel.json")).ok()?;
        serde_json::from_str::<Value>(&text).ok()?["address"].as_str().map(str::to_owned)
    }

    pub fn set_home_channel(&self, address: &str) -> Result<(), String> {
        crate::channel::parse_address(address)?;
        let text = json!({ "address": address }).to_string();
        invincible::fsutil::replace_private(&self.home.join("home-channel.json"), &text)
    }

    /// Sends [text] to [address] (`slack:#ops`), waiting a little for the channel to connect.
    pub async fn deliver(&self, address: &str, text: &str) -> Result<(), String> {
        let (platform, target) = crate::channel::parse_address(address)?;
        let mut transport = self.transport(&platform);
        for _ in 0..30 {
            if transport.is_some() {
                break;
            }
            tokio::time::sleep(Duration::from_secs(1)).await;
            transport = self.transport(&platform);
        }
        let transport = transport.ok_or_else(|| format!("{platform} is not connected for {}", self.name))?;
        transport.answer(&target, text).await
    }

    /// Sends [text] to every allowed user on [platform] (`telegram = true` in a hook).
    pub async fn everyone(&self, platform: &str, text: &str) {
        let Some(transport) = self.transport(platform) else { return };
        for user in crate::pairing::allowed(&self.home, platform) {
            if let Err(e) = transport.answer(&transport.user_chat(&user.id), text).await {
                tracing::warn!(bot = %self.name, "{platform}: {e}");
            }
        }
    }

    /// Sends [text] to each of [addresses]; with none, to the home channel when one is set.
    pub async fn notify(&self, addresses: &[String], text: &str) {
        let mut targets: Vec<String> = Vec::new();
        for address in addresses {
            if !targets.contains(address) {
                targets.push(address.clone());
            }
        }
        if targets.is_empty()
            && let Some(home) = self.home_channel()
        {
            targets.push(home);
        }
        for address in targets {
            if let Err(e) = self.deliver(&address, text).await {
                tracing::warn!(bot = %self.name, "{address}: {e}");
            }
        }
    }

    pub fn status(&self) -> Value {
        let agent = self.agent();
        let (busy, queued) = self.conversations.load();
        let last = self.last_error.lock().expect("last error").clone();
        json!({
            "name": self.name,
            "default": self.default,
            "description": self.config.bot.description,
            "model": agent.gateway.model(),
            "approvals": format!("{:?}", agent.approvals.mode).to_lowercase(),
            "workdir": agent.tools.workdir().display().to_string(),
            "private": self.config.gateway.private,
            "channels": *self.channels.lock().expect("channels"),
            "home_channel": self.home_channel(),
            "running": busy.max(self.running.load(Ordering::Relaxed)),
            "queued": queued,
            "waiting": self.conversations.waiting(),
            "turns": self.turns.load(Ordering::Relaxed),
            "uptime": self.uptime().as_secs(),
            "last_error": last.map(|(at, text)| json!({ "at": at, "text": text })),
        })
    }

    /// `/status`.
    pub fn status_text(&self) -> String {
        let s = self.status();
        let channels: Vec<String> = s["channels"]
            .as_object()
            .into_iter()
            .flatten()
            .map(|(name, state)| match state.as_str() {
                Some("connected") => format!("{name} ✓"),
                Some(other) => format!("{name} ✗ ({other})"),
                None => name.clone(),
            })
            .collect();
        let mut lines = vec![
            format!(
                "{} · model {} · approvals {}",
                self.name,
                s["model"].as_str().unwrap_or("?"),
                s["approvals"].as_str().unwrap_or("?")
            ),
            format!(
                "up {} · {} turn(s) running · {} message(s) waiting to be taken in · {} question(s) waiting",
                human(s["uptime"].as_u64().unwrap_or(0)),
                s["running"],
                s["queued"],
                s["waiting"]
            ),
            format!("channels: {}", if channels.is_empty() { "none".to_owned() } else { channels.join(", ") }),
        ];
        if let Some(home) = s["home_channel"].as_str() {
            lines.push(format!("home: {home}"));
        }
        match s["last_error"].as_object() {
            Some(e) => lines.push(format!(
                "last error ({}): {}",
                crate::cron::local(e["at"].as_i64().unwrap_or(0)).format("%d %b %H:%M"),
                e["text"].as_str().unwrap_or("")
            )),
            None => lines.push("no errors".to_owned()),
        }
        lines.join("\n")
    }

    /// `/bots`: the bots served with this one.
    pub fn fleet_text(&self) -> String {
        let peers: Vec<Arc<Runtime>> = self.peers.lock().expect("peers").iter().filter_map(Weak::upgrade).collect();
        let peers = if peers.is_empty() { vec![] } else { peers };
        if peers.is_empty() {
            return format!("{} is the only bot here.", self.name);
        }
        peers
            .iter()
            .map(|bot| {
                let s = bot.status();
                let channels: Vec<&str> =
                    s["channels"].as_object().into_iter().flatten().map(|(n, _)| n.as_str()).collect();
                let this = if bot.name == self.name { " (this one)" } else { "" };
                format!(
                    "{}{this} · {} · {} · {} running{}",
                    bot.name,
                    s["model"].as_str().unwrap_or("?"),
                    if channels.is_empty() { "no channels".to_owned() } else { channels.join(", ") },
                    s["running"],
                    match s["description"].as_str() {
                        Some(d) if !d.is_empty() => format!("\n  {d}"),
                        _ => String::new(),
                    }
                )
            })
            .collect::<Vec<_>>()
            .join("\n")
    }
}

pub fn human(secs: u64) -> String {
    match secs {
        0..60 => format!("{secs}s"),
        60..3600 => format!("{}m", secs / 60),
        3600..86400 => format!("{}h {}m", secs / 3600, secs % 3600 / 60),
        _ => format!("{}d {}h", secs / 86400, secs % 86400 / 3600),
    }
}

/// Runs [part] of [runtime] until it says it cannot (Err: its channel stays off, with why), and
/// starts it again when it ends or panics, so one failing part never stops the others.
pub fn supervise<F, Fut>(runtime: Arc<Runtime>, part: &'static str, make: F) -> tokio::task::JoinHandle<()>
where
    F: Fn() -> Fut + Send + 'static,
    Fut: std::future::Future<Output = Result<(), String>> + Send + 'static,
{
    tokio::spawn(async move {
        let mut backoff = Duration::from_secs(1);
        loop {
            let started = Instant::now();
            match tokio::spawn(make()).await {
                Ok(Ok(())) => tracing::warn!(bot = %runtime.name, "{part} stopped; starting it again"),
                Ok(Err(e)) => {
                    tracing::error!(bot = %runtime.name, "{part} is off: {e}");
                    runtime.channel_state(part, &format!("off: {e}"));
                    runtime.error(&format!("{part}: {e}"));
                    return;
                }
                Err(e) => {
                    tracing::error!(bot = %runtime.name, "{part} failed ({e}); starting it again");
                    runtime.error(&format!("{part} failed: {e}"));
                }
            }
            if started.elapsed() > Duration::from_secs(60) {
                backoff = Duration::from_secs(1);
            }
            tokio::time::sleep(backoff).await;
            backoff = (backoff * 2).min(Duration::from_secs(60));
        }
    })
}

/// Starts every part of [runtime] its configuration turns on, each in tasks of its own: its
/// channels, schedules, board and heartbeat. Hooks are served apart ([crate::hooks::app]).
pub fn start(runtime: &Arc<Runtime>) -> Vec<tokio::task::JoinHandle<()>> {
    type Part = fn(Arc<Runtime>) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<(), String>> + Send>>;
    let c = &runtime.config;
    let channels: [(&'static str, bool, Part); 6] = [
        ("telegram", c.telegram.enabled, |r| Box::pin(crate::telegram::run(r))),
        ("discord", c.discord.enabled, |r| Box::pin(crate::discord::run(r))),
        ("slack", c.slack.enabled, |r| Box::pin(crate::slack::run(r))),
        ("email", c.email.enabled, |r| Box::pin(crate::email::run(r))),
        ("signal", c.signal.enabled, |r| Box::pin(crate::signal::run(r))),
        ("matrix", c.matrix.enabled, |r| Box::pin(crate::matrix::run(r))),
    ];
    let mut parts = Vec::new();
    for (name, on, part) in channels {
        if on {
            runtime.channel_state(name, "starting");
            let r = runtime.clone();
            parts.push(supervise(runtime.clone(), name, move || part(r.clone())));
        }
    }
    let r = runtime.clone();
    parts.push(supervise(runtime.clone(), "schedules", move || {
        let r = r.clone();
        async move {
            crate::cron::scheduler(r).await;
            Ok(())
        }
    }));
    let r = runtime.clone();
    parts.push(supervise(runtime.clone(), "board", move || {
        let r = r.clone();
        async move {
            crate::board::dispatcher(r.agent(), r.home.clone(), Some(r.clone())).await;
            Ok(())
        }
    }));
    match c.agent.heartbeat_every() {
        Ok(Some(every)) => {
            let r = runtime.clone();
            parts.push(supervise(runtime.clone(), "heartbeat", move || {
                let r = r.clone();
                async move {
                    crate::heartbeat::run(r, every).await;
                    Ok(())
                }
            }));
        }
        Ok(None) => {}
        Err(e) => tracing::error!(bot = %runtime.name, "{e}"),
    }
    parts
}

/// What `autobot bots add` writes.
#[derive(Debug, Default)]
pub struct NewBot {
    pub description: String,
    /// SOUL.md: who it is.
    pub soul: Option<String>,
    pub model: Option<String>,
    pub tools: Option<Vec<String>>,
    pub approvals: Option<String>,
    pub workdir: Option<PathBuf>,
    pub telegram_token: Option<String>,
    pub discord_token: Option<String>,
    pub slack_app_token: Option<String>,
    pub slack_bot_token: Option<String>,
}

/// `[table] key = value` in [doc], the table made when it is not there.
fn put(doc: &mut toml_edit::DocumentMut, table: &str, key: &str, value: toml_edit::Item) {
    let entry = doc.entry(table).or_insert_with(|| toml_edit::Item::Table(toml_edit::Table::new()));
    if let Some(table) = entry.as_table_mut() {
        table.insert(key, value);
    }
}

/// Makes the bot [name] in [root]; its directory.
pub fn add(root: &Path, name: &str, new: &NewBot) -> Result<PathBuf, String> {
    if !valid_name(name) {
        return Err(format!("{name:?} is not a bot name: lowercase letters, digits, - and _, starting with a letter"));
    }
    if load_default(root)?.name == name {
        return Err(format!("{name} is the default bot (config.toml)"));
    }
    let home = dir(root).join(name);
    if home.join("bot.toml").exists() {
        return Err(format!("there is a bot {name} already (`autobot bots edit {name}`)"));
    }
    if let Some(mode) = &new.approvals
        && !["ask", "edits", "allowlist", "trust"].contains(&mode.as_str())
    {
        return Err(format!("--approvals {mode:?}: ask, edits, allowlist or trust"));
    }
    if let Some(groups) = &new.tools
        && let Some(unknown) = groups.iter().find(|g| !crate::tools::GROUPS.iter().any(|(n, _)| n == g))
    {
        return Err(format!("--tools: unknown group {unknown:?}"));
    }
    std::fs::create_dir_all(&home).map_err(|e| format!("{}: {e}", home.display()))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&home, std::fs::Permissions::from_mode(0o700));
    }
    let mut doc = toml_edit::DocumentMut::new();
    put(&mut doc, "bot", "description", toml_edit::value(new.description.trim()));
    if let Some(model) = &new.model {
        put(&mut doc, "gateway", "model", toml_edit::value(model.as_str()));
    }
    if let Some(tools) = &new.tools {
        put(
            &mut doc,
            "agent",
            "tools",
            toml_edit::value(tools.iter().map(String::as_str).collect::<toml_edit::Array>()),
        );
    }
    if let Some(workdir) = &new.workdir {
        put(&mut doc, "agent", "workdir", toml_edit::value(workdir.display().to_string()));
    }
    if let Some(mode) = &new.approvals {
        put(&mut doc, "approvals", "mode", toml_edit::value(mode.as_str()));
    }
    let secret = |file: &str, token: &Option<String>| -> Result<bool, String> {
        let Some(token) = token.as_ref().map(|t| t.trim()).filter(|t| !t.is_empty()) else { return Ok(false) };
        invincible::fsutil::replace_private(&home.join(file), &format!("{token}\n"))?;
        Ok(true)
    };
    if secret("telegram.token", &new.telegram_token)? {
        put(&mut doc, "telegram", "enabled", toml_edit::value(true));
    }
    if secret("discord.token", &new.discord_token)? {
        put(&mut doc, "discord", "enabled", toml_edit::value(true));
    }
    let app = secret("slack-app.token", &new.slack_app_token)?;
    let bot = secret("slack-bot.token", &new.slack_bot_token)?;
    if app && bot {
        put(&mut doc, "slack", "enabled", toml_edit::value(true));
    } else if app || bot {
        return Err("Slack needs both tokens: --slack-app-token xapp-… and --slack-bot-token xoxb-…".to_owned());
    }
    let text = format!(
        "# The bot {name}: what differs from {}. Any section of config.toml can go here;\n\
         # its channels ([telegram], [discord], [slack], [email], [signal], [matrix]) are its own.\n{doc}",
        root.join("config.toml").display()
    );
    invincible::fsutil::replace_private(&home.join("bot.toml"), &text)?;
    let soul = new.soul.clone().unwrap_or_else(|| {
        format!(
            "You are {name}. {}\n",
            if new.description.trim().is_empty() {
                String::new()
            } else {
                format!("{}.", new.description.trim().trim_end_matches('.'))
            }
        )
    });
    std::fs::write(home.join("SOUL.md"), soul).map_err(|e| format!("{}: {e}", home.display()))?;
    // Check that what was written loads.
    load(root, name)?;
    Ok(home)
}

/// Turns [name] on or off for `autobot serve`.
pub fn set_enabled(root: &Path, name: &str, enabled: bool) -> Result<(), String> {
    let def = load(root, name)?;
    crate::setup::set(&def.file(), "bot", "enabled", toml_edit::value(enabled))
}

/// Moves the bot [name] (and its memory, conversations and channel users) to
/// `$AUTOBOT_HOME/bots-removed/`, from where it can be put back; where it went.
pub fn remove(root: &Path, name: &str) -> Result<PathBuf, String> {
    let def = load(root, name)?;
    if def.default {
        return Err(format!("{name} is the default bot (config.toml); `autobot bots disable {name}` turns it off"));
    }
    let away = root.join("bots-removed");
    std::fs::create_dir_all(&away).map_err(|e| format!("{}: {e}", away.display()))?;
    let to = away.join(format!("{name}-{}", chrono::Local::now().format("%Y%m%d-%H%M%S")));
    std::fs::rename(&def.home, &to).map_err(|e| format!("{}: {e}", def.home.display()))?;
    Ok(to)
}

/// `autobot bots show`.
pub fn show(def: &Def) -> String {
    let c = &def.config;
    let mut lines = vec![
        format!("{}{}", def.name, if def.default { " (the default bot)" } else { "" }),
        format!("  enabled      {}", if def.enabled() { "yes" } else { "no" }),
    ];
    if !c.bot.description.is_empty() {
        lines.push(format!("  description  {}", c.bot.description));
    }
    lines.push(format!(
        "  model        {}{}",
        c.gateway.model,
        if c.gateway.private { " (private: local models)" } else { "" }
    ));
    lines.push(format!("  approvals    {}", format!("{:?}", c.approvals.mode).to_lowercase()));
    lines.push(format!("  tools        {}", c.agent.tools.as_ref().map_or("all".to_owned(), |t| t.join(", "))));
    lines.push(format!("  workdir      {}", c.agent.workdir(&def.home).display()));
    let channels = def.channels();
    lines.push(format!("  channels     {}", if channels.is_empty() { "none".to_owned() } else { channels.join(", ") }));
    lines.push(format!("  home         {}", def.home.display()));
    lines.push(format!("  config       {}", def.file().display()));
    let schedules = crate::cron::Schedules::load(&def.home).map(|s| s.schedules.len()).unwrap_or(0);
    let facts = crate::memory::Memory::new(&def.home).list().len();
    lines.push(format!(
        "  schedules    {schedules} · remembered facts {facts} · skills {}",
        crate::skills::list(&def.home).len()
    ));
    match def.soul() {
        Some(soul) => {
            lines.push("  persona (SOUL.md)".to_owned());
            lines.extend(soul.lines().take(12).map(|l| format!("    {l}")));
        }
        None => lines.push(format!("  persona      none (write {})", def.home.join("SOUL.md").display())),
    }
    lines.join("\n")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn root(tag: &str) -> PathBuf {
        let root = std::env::temp_dir().join(format!("autobot-bots-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).unwrap();
        root
    }

    #[test]
    fn names() {
        assert!(valid_name("ops"));
        assert!(valid_name("night-shift_2"));
        for bad in ["", "Ops", "2ops", "a b", "../x", &"a".repeat(33)] {
            assert!(!valid_name(bad), "{bad}");
        }
    }

    #[test]
    fn a_bot_inherits_all_but_channels() {
        let main = "[gateway]\nmodel = \"qwen\"\nprivate = false\n[approvals]\nmode = \"edits\"\nallow = [\"ls\"]\n[telegram]\nenabled = true\n[hooks]\nlisten = \"127.0.0.1:7794\"\n[voice]\nurl = \"http://127.0.0.1:8080/v1/audio/transcriptions\"";
        let config = merge(main, "[gateway]\nmodel = \"llama\"\n[slack]\nenabled = true").unwrap();
        assert_eq!(config.gateway.model, "llama");
        assert!(!config.gateway.private, "the rest of [gateway] stays");
        assert_eq!(config.approvals.mode, crate::config::ApprovalMode::Edits);
        assert_eq!(config.approvals.allow, ["ls"]);
        assert!(!config.telegram.enabled, "channels are the bot's own");
        assert!(config.slack.enabled);
        assert!(config.hooks.listen.is_none());
        assert!(config.voice.url.is_some(), "voice is the machine's");
        assert!(merge(main, "[agent]\nshell = 1").is_err());
    }

    #[test]
    fn add_list_disable_remove() {
        let root = root("add");
        std::fs::write(root.join("config.toml"), "[telegram]\nenabled = true\n").unwrap();
        std::fs::write(root.join("telegram.token"), "123:abc\n").unwrap();
        let new = NewBot {
            description: "Watches the servers".into(),
            model: Some("qwen".into()),
            tools: Some(vec!["files-read".into(), "terminal".into()]),
            approvals: Some("allowlist".into()),
            telegram_token: Some("123:abc".into()),
            ..Default::default()
        };
        let home = add(&root, "ops", &new).unwrap();
        assert!(add(&root, "ops", &new).is_err(), "once");
        assert!(add(&root, "default", &new).is_err(), "the default's name");
        assert!(add(&root, "x", &NewBot { tools: Some(vec!["lasers".into()]), ..Default::default() }).is_err());
        assert!(
            std::fs::read_to_string(home.join("SOUL.md")).unwrap().starts_with("You are ops. Watches the servers.")
        );
        let (defs, problems) = load_all(&root).unwrap();
        assert!(problems.is_empty(), "{problems:?}");
        assert_eq!(defs.iter().map(|d| d.name.as_str()).collect::<Vec<_>>(), ["default", "ops"]);
        let ops = &defs[1];
        assert_eq!(ops.config.gateway.model, "qwen");
        assert_eq!(ops.config.approvals.mode, crate::config::ApprovalMode::Allowlist);
        assert_eq!(ops.config.agent.workdir(&ops.home), home.join("work"), "its own working directory");
        assert_eq!(ops.channels(), ["telegram"]);
        // The same Telegram token as the default bot: the second one's Telegram stays off.
        assert_eq!(shared_accounts(&defs), vec![("ops".to_owned(), "telegram", "default".to_owned())]);
        assert!(show(ops).contains("persona (SOUL.md)"));
        set_enabled(&root, "ops", false).unwrap();
        assert!(!load(&root, "ops").unwrap().enabled());
        assert!(shared_accounts(&load_all(&root).unwrap().0).is_empty(), "a disabled bot shares nothing");
        assert!(remove(&root, "default").is_err());
        let away = remove(&root, "ops").unwrap();
        assert!(away.join("bot.toml").is_file());
        assert_eq!(load_all(&root).unwrap().0.len(), 1);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn a_broken_bot_does_not_hide_the_others() {
        let root = root("broken");
        std::fs::create_dir_all(dir(&root).join("bad")).unwrap();
        std::fs::write(dir(&root).join("bad/bot.toml"), "[agent]\nnope = 1").unwrap();
        add(&root, "good", &NewBot::default()).unwrap();
        let (defs, problems) = load_all(&root).unwrap();
        assert_eq!(defs.len(), 2);
        assert_eq!(problems[0].0, "bad");
        std::fs::remove_dir_all(root).unwrap();
    }
}
