//! Discord: the agent answers its owner through a bot, in direct messages and when mentioned in
//! a server channel.
//!
//! - The bot connects out to Discord's gateway (a websocket), so the machine needs no public
//!   address. It goes under Invincible Gateway's network mode: direct, or through Tor/SOCKS5.
//! - A stranger who messages the bot gets a one-time code; nobody gets in until the owner runs
//!   `autobot discord approve <code>` on the machine. In a server, only allowed users are
//!   answered, and only when they mention the bot or reply to it.
//! - Approvals come as buttons, which only the person asked can press.
//! - Progress is one message, edited as the agent works; the answer is a message of its own.
//!
//! ```toml
//! [discord]
//! enabled = true      # token in $AUTOBOT_HOME/discord.token
//! ```
//!
//! Discord's servers see bot messages. The private channel is the Autobot app, paired over Noise.

use std::collections::{HashMap, HashSet};
use std::future::Future;
use std::path::{Path, PathBuf};
use std::pin::Pin;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use tokio::sync::oneshot;
use tokio_tungstenite::tungstenite::Message;

use crate::agent::{Agent, Event};
use crate::approval::{Action, Answer, Approver};
use crate::session::Session;

/// Discord's limit for one message is 2000 characters; some room for a footer.
const MESSAGE_LIMIT: usize = 1900;
const CODE_LIFETIME: u64 = 60 * 60;
const APPROVAL_WAIT: Duration = Duration::from_secs(10 * 60);
/// Direct messages and server messages (mentions carry their text without the privileged
/// message-content intent).
const INTENTS: u64 = (1 << 12) | (1 << 9);

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct DiscordConfig {
    #[serde(default)]
    pub enabled: bool,
    /// The bot token [default: `$AUTOBOT_HOME/discord.token`].
    #[serde(default)]
    pub token_file: Option<PathBuf>,
    /// The REST API [default: `https://discord.com/api/v10`]; tests point it at a stand-in.
    #[serde(default)]
    pub api: Option<String>,
}

impl DiscordConfig {
    pub fn token(&self, home: &Path) -> Result<String, String> {
        let path = self.token_file.as_deref().map(crate::config::expand).unwrap_or_else(|| home.join("discord.token"));
        let token =
            std::fs::read_to_string(&path).map_err(|e| format!("the Discord bot token {}: {e}", path.display()))?;
        let token = token.trim();
        if token.is_empty() {
            return Err(format!("{} is empty", path.display()));
        }
        Ok(token.to_owned())
    }

    pub fn api(&self) -> String {
        self.api.clone().unwrap_or_else(|| "https://discord.com/api/v10".to_owned())
    }
}

#[derive(Clone)]
pub struct Bot {
    client: reqwest::Client,
    api: String,
    token: String,
    network: invincible_policy::NetworkMode,
    /// Direct-message channels, by user id.
    dms: Arc<Mutex<HashMap<String, String>>>,
}

/// The running bot, for answers that come later (schedules, hooks).
static RUNNING: OnceLock<Bot> = OnceLock::new();

impl Bot {
    pub fn new(
        client: reqwest::Client,
        api: &str,
        token: &str,
        network: invincible_policy::NetworkMode,
    ) -> Result<Self, String> {
        invincible::egress::check(api)?;
        Ok(Self {
            client,
            api: api.trim_end_matches('/').to_owned(),
            token: token.to_owned(),
            network,
            dms: Arc::default(),
        })
    }

    async fn call(&self, method: reqwest::Method, path: &str, body: Option<Value>) -> Result<Value, String> {
        for attempt in 0..3 {
            let mut request = self
                .client
                .request(method.clone(), format!("{}{path}", self.api))
                .header("authorization", format!("Bot {}", self.token))
                .header("user-agent", "DiscordBot (https://github.com/wckdboy/invincible, 1)")
                .timeout(Duration::from_secs(20));
            if let Some(body) = &body {
                request = request.json(body);
            }
            let response = request.send().await.map_err(|e| format!("Discord {path}: {}", e.without_url()))?;
            let status = response.status();
            // Rate limited: wait as long as it says, then once more.
            if status.as_u16() == 429 && attempt < 2 {
                let wait = response.json::<Value>().await.ok().and_then(|v| v["retry_after"].as_f64()).unwrap_or(1.0);
                tokio::time::sleep(Duration::from_secs_f64(wait.clamp(0.1, 30.0))).await;
                continue;
            }
            let text = response.text().await.map_err(|e| format!("Discord {path}: {}", e.without_url()))?;
            if !status.is_success() {
                let why = serde_json::from_str::<Value>(&text)
                    .ok()
                    .and_then(|v| v["message"].as_str().map(str::to_owned))
                    .unwrap_or_else(|| status.to_string());
                return Err(format!("Discord {path}: {why}"));
            }
            return Ok(if text.is_empty() { Value::Null } else { serde_json::from_str(&text).unwrap_or(Value::Null) });
        }
        Err(format!("Discord {path}: rate limited"))
    }

    pub async fn me(&self) -> Result<Value, String> {
        self.call(reqwest::Method::GET, "/users/@me", None).await
    }

    async fn gateway_url(&self) -> Result<String, String> {
        let reply = self.call(reqwest::Method::GET, "/gateway/bot", None).await?;
        reply["url"].as_str().map(str::to_owned).ok_or_else(|| "Discord gave no gateway address".to_owned())
    }

    /// Sends [text] to [channel], in parts if it is long; the last message.
    pub async fn send(&self, channel: &str, text: &str) -> Result<Value, String> {
        let mut last = Value::Null;
        for part in split(text) {
            last = self
                .call(
                    reqwest::Method::POST,
                    &format!("/channels/{channel}/messages"),
                    Some(json!({ "content": part, "allowed_mentions": { "parse": [] } })),
                )
                .await?;
        }
        Ok(last)
    }

    async fn edit(&self, channel: &str, message: &str, text: &str) -> Result<(), String> {
        self.call(
            reqwest::Method::PATCH,
            &format!("/channels/{channel}/messages/{message}"),
            Some(json!({ "content": cut_line(text), "allowed_mentions": { "parse": [] } })),
        )
        .await
        .map(drop)
    }

    async fn typing(&self, channel: &str) {
        let _ = self.call(reqwest::Method::POST, &format!("/channels/{channel}/typing"), None).await;
    }

    /// The direct-message channel with [user].
    async fn dm(&self, user: &str) -> Result<String, String> {
        if let Some(channel) = self.dms.lock().expect("dms").get(user) {
            return Ok(channel.clone());
        }
        let reply =
            self.call(reqwest::Method::POST, "/users/@me/channels", Some(json!({ "recipient_id": user }))).await?;
        let channel = reply["id"].as_str().ok_or("Discord gave no channel")?.to_owned();
        self.dms.lock().expect("dms").insert(user.to_owned(), channel.clone());
        Ok(channel)
    }

    async fn respond(&self, interaction: &Value, body: Value) {
        let (Some(id), Some(token)) = (interaction["id"].as_str(), interaction["token"].as_str()) else { return };
        if let Err(e) =
            self.call(reqwest::Method::POST, &format!("/interactions/{id}/{token}/callback"), Some(body)).await
        {
            tracing::warn!("discord: {e}");
        }
    }
}

/// Sends [text] to a Discord channel, when the bot runs (a schedule's answer).
pub async fn notify(channel: &str, text: &str) {
    if let Some(bot) = RUNNING.get()
        && let Err(e) = bot.send(channel, text).await
    {
        tracing::warn!("discord: {e}");
    }
}

/// Sends [text] to every allowed Discord user, when the bot runs (a hook's answer).
pub async fn notify_users(home: &Path, text: &str) {
    let Some(bot) = RUNNING.get() else { return };
    for user in Users::load(home).map(|u| u.allowed).unwrap_or_default() {
        match bot.dm(&user.id).await {
            Ok(channel) => {
                if let Err(e) = bot.send(&channel, text).await {
                    tracing::warn!("discord: {e}");
                }
            }
            Err(e) => tracing::warn!("discord: {e}"),
        }
    }
}

/// Splits [text] into messages Discord takes, at line breaks where it can.
fn split(text: &str) -> Vec<String> {
    let mut parts = Vec::new();
    let mut rest = text;
    while rest.chars().count() > MESSAGE_LIMIT {
        let limit = rest.char_indices().nth(MESSAGE_LIMIT).map_or(rest.len(), |(i, _)| i);
        let at = rest[..limit].rfind('\n').filter(|&i| i > limit / 2).unwrap_or(limit);
        parts.push(rest[..at].to_owned());
        rest = rest[at..].trim_start_matches('\n');
    }
    if !rest.is_empty() || parts.is_empty() {
        parts.push(if rest.is_empty() { "(empty)".to_owned() } else { rest.to_owned() });
    }
    parts
}

fn cut_line(text: &str) -> String {
    if text.chars().count() <= MESSAGE_LIMIT {
        text.to_owned()
    } else {
        text.chars().take(MESSAGE_LIMIT).collect::<String>() + "…"
    }
}

/// Who may talk to the agent, and who asked: `$AUTOBOT_HOME/discord-users.json`, read on every
/// message so `autobot discord approve` works while the bot runs.
#[derive(Debug, Default, Serialize, Deserialize)]
pub struct Users {
    #[serde(default)]
    pub allowed: Vec<User>,
    #[serde(default)]
    pub pending: Vec<Pending>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct User {
    /// Discord's id (a snowflake, kept as text).
    pub id: String,
    pub name: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Pending {
    pub code: String,
    pub user: User,
    pub expires: u64,
}

fn now() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or_default()
}

impl Users {
    pub fn path(home: &Path) -> PathBuf {
        home.join("discord-users.json")
    }

    pub fn load(home: &Path) -> Result<Self, String> {
        let path = Self::path(home);
        match invincible::fsutil::read_optional(&path)? {
            Some(text) => serde_json::from_str(&text).map_err(|e| format!("{}: {e}", path.display())),
            None => Ok(Self::default()),
        }
    }

    pub fn save(&self, home: &Path) -> Result<(), String> {
        let text = serde_json::to_string_pretty(self).map_err(|e| e.to_string())?;
        invincible::fsutil::replace_private(&Self::path(home), &text)
    }

    pub fn allows(&self, id: &str) -> bool {
        self.allowed.iter().any(|u| u.id == id)
    }

    pub fn code_for(&mut self, user: &User) -> Result<String, String> {
        let now = now();
        self.pending.retain(|p| p.expires > now);
        if let Some(p) = self.pending.iter().find(|p| p.user.id == user.id) {
            return Ok(p.code.clone());
        }
        if self.pending.len() >= 10 {
            self.pending.remove(0);
        }
        let code = crate::telegram::new_code()?;
        self.pending.push(Pending { code: code.clone(), user: user.clone(), expires: now + CODE_LIFETIME });
        Ok(code)
    }

    pub fn approve(&mut self, code: &str) -> Result<User, String> {
        let wanted = crate::telegram::normalize(code);
        let now = now();
        let at = self
            .pending
            .iter()
            .position(|p| p.expires > now && crate::telegram::normalize(&p.code) == wanted)
            .ok_or_else(|| format!("no live pairing code {code:?} (codes work for {} minutes)", CODE_LIFETIME / 60))?;
        let user = self.pending.remove(at).user;
        if !self.allows(&user.id) {
            self.allowed.push(user.clone());
        }
        Ok(user)
    }

    pub fn revoke(&mut self, id: &str) -> bool {
        let before = self.allowed.len();
        self.allowed.retain(|u| u.id != id);
        before != self.allowed.len()
    }
}

struct Chat {
    session: Session,
    grants: HashSet<Action>,
}

#[derive(Clone)]
struct Slot {
    chat: Arc<tokio::sync::Mutex<Chat>>,
    inbox: crate::tools::Inbox,
}

/// Approvals waiting for a button: the user who may press it, and where the answer goes.
type Waiting = Arc<Mutex<HashMap<u64, (String, oneshot::Sender<Answer>)>>>;

struct ButtonApprover {
    bot: Bot,
    channel: String,
    user: String,
    waiting: Waiting,
}

impl Approver for ButtonApprover {
    fn channel(&self) -> &'static str {
        "discord"
    }

    fn approve<'a>(&'a self, action: &'a Action) -> Pin<Box<dyn Future<Output = Answer> + Send + 'a>> {
        Box::pin(async move {
            let id = u64::from_le_bytes(invincible::token::random::<8>().unwrap_or_default());
            let (tx, rx) = oneshot::channel();
            self.waiting.lock().expect("waiting").insert(id, (self.user.clone(), tx));
            let button = |label: &str, style: u8, choice: &str| json!({ "type": 2, "style": style, "label": label, "custom_id": format!("{id}:{choice}") });
            let body = json!({
                "content": cut_line(&format!("{}Approve? {}", crate::approval::asker(), action.describe())),
                "allowed_mentions": { "parse": [] },
                "components": [{ "type": 1, "components": [
                    button("Allow", 3, "once"),
                    button("Always (this chat)", 1, "always"),
                    button("Deny", 4, "deny"),
                ]}],
            });
            let path = format!("/channels/{}/messages", self.channel);
            if self.bot.call(reqwest::Method::POST, &path, Some(body)).await.is_err() {
                self.waiting.lock().expect("waiting").remove(&id);
                return Answer::Deny;
            }
            let answer = tokio::time::timeout(APPROVAL_WAIT, rx).await.ok().and_then(Result::ok);
            self.waiting.lock().expect("waiting").remove(&id);
            answer.unwrap_or(Answer::Deny)
        })
    }
}

/// Everything one connection needs.
struct Shared {
    bot: Bot,
    agent: Arc<Agent>,
    home: PathBuf,
    chats: Mutex<HashMap<String, Slot>>,
    waiting: Waiting,
    /// The bot's own user id, once Discord said it.
    me: Mutex<Option<String>>,
}

/// Answers messages until the process stops, reconnecting when the connection drops.
pub async fn serve(bot: Bot, agent: Arc<Agent>, home: PathBuf) {
    let _ = RUNNING.set(bot.clone());
    let shared =
        Arc::new(Shared { bot, agent, home, chats: Mutex::default(), waiting: Arc::default(), me: Mutex::default() });
    let mut backoff = Duration::from_secs(1);
    loop {
        let started = std::time::Instant::now();
        match connection(&shared).await {
            Ok(()) => tracing::info!("discord: reconnecting"),
            Err(e) => tracing::warn!("discord: {e}; reconnecting in {}s", backoff.as_secs()),
        }
        if started.elapsed() > Duration::from_secs(60) {
            backoff = Duration::from_secs(1);
        }
        tokio::time::sleep(backoff).await;
        backoff = (backoff * 2).min(Duration::from_secs(60));
    }
}

type Socket = tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>;

/// Opens the websocket at [url] under the node's network mode.
async fn open(url: &str, network: &invincible_policy::NetworkMode) -> Result<Socket, String> {
    let parsed = reqwest::Url::parse(url).map_err(|e| format!("{url}: {e}"))?;
    let host = parsed.host_str().ok_or("the gateway address has no host")?.to_owned();
    let loopback = host == "localhost" || host.parse::<std::net::IpAddr>().is_ok_and(|ip| ip.is_loopback());
    let port = parsed.port_or_known_default().unwrap_or(443);
    match parsed.scheme() {
        "wss" => {}
        "ws" if loopback => {}
        _ => return Err(format!("{url}: only wss:// (or ws:// to loopback) is allowed")),
    }
    let stream = match network {
        invincible_policy::NetworkMode::Offline => {
            return Err("the node is offline ([node] network = \"offline\")".to_owned());
        }
        invincible_policy::NetworkMode::Direct => {
            tokio::net::TcpStream::connect((host.as_str(), port)).await.map_err(|e| format!("{host}: {e}"))?
        }
        invincible_policy::NetworkMode::Tor { host: proxy, port: proxy_port }
        | invincible_policy::NetworkMode::Socks5 { host: proxy, port: proxy_port } => {
            let mut stream = tokio::net::TcpStream::connect((proxy.as_str(), *proxy_port))
                .await
                .map_err(|e| format!("the proxy {proxy}:{proxy_port}: {e}"))?;
            socks5_connect(&mut stream, &host, port).await?;
            stream
        }
    };
    let (socket, _) = tokio_tungstenite::client_async_tls(url, stream).await.map_err(|e| format!("{host}: {e}"))?;
    Ok(socket)
}

/// A SOCKS5 CONNECT to [host] (resolved by the proxy, so lookups stay inside Tor).
async fn socks5_connect(stream: &mut tokio::net::TcpStream, host: &str, port: u16) -> Result<(), String> {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let fail = |e: std::io::Error| format!("SOCKS5: {e}");
    stream.write_all(&[5, 1, 0]).await.map_err(fail)?;
    let mut reply = [0u8; 2];
    stream.read_exact(&mut reply).await.map_err(fail)?;
    if reply != [5, 0] {
        return Err("SOCKS5: the proxy wants a login".to_owned());
    }
    let name = host.as_bytes();
    if name.len() > 255 {
        return Err("SOCKS5: host name too long".to_owned());
    }
    let mut request = vec![5, 1, 0, 3, name.len() as u8];
    request.extend_from_slice(name);
    request.extend_from_slice(&port.to_be_bytes());
    stream.write_all(&request).await.map_err(fail)?;
    let mut head = [0u8; 4];
    stream.read_exact(&mut head).await.map_err(fail)?;
    if head[1] != 0 {
        return Err(format!("SOCKS5: the proxy could not connect (code {})", head[1]));
    }
    let rest = match head[3] {
        1 => 4,
        4 => 16,
        3 => {
            let mut len = [0u8; 1];
            stream.read_exact(&mut len).await.map_err(fail)?;
            usize::from(len[0])
        }
        other => return Err(format!("SOCKS5: unknown address type {other}")),
    };
    let mut skip = vec![0u8; rest + 2];
    stream.read_exact(&mut skip).await.map_err(fail)?;
    Ok(())
}

/// One gateway connection: hello, identify, then events until Discord asks to reconnect.
async fn connection(shared: &Arc<Shared>) -> Result<(), String> {
    let url = shared.bot.gateway_url().await?;
    let url = format!("{}/?v=10&encoding=json", url.trim_end_matches('/'));
    let mut socket = open(&url, &shared.bot.network).await?;
    let hello = next_json(&mut socket).await?.ok_or("Discord closed the connection")?;
    if hello["op"] != 10 {
        return Err(format!("Discord began with op {} instead of hello", hello["op"]));
    }
    let interval = Duration::from_millis(hello["d"]["heartbeat_interval"].as_u64().unwrap_or(41_250).max(1000));
    let identify = json!({ "op": 2, "d": {
        "token": shared.bot.token,
        "intents": INTENTS,
        "properties": { "os": std::env::consts::OS, "browser": "autobot", "device": "autobot" },
    }});
    socket.send(Message::text(identify.to_string())).await.map_err(|e| e.to_string())?;
    let mut sequence: Value = Value::Null;
    let mut beat = tokio::time::interval_at(tokio::time::Instant::now() + interval / 2, interval);
    let mut acked = true;
    loop {
        tokio::select! {
            _ = beat.tick() => {
                if !acked {
                    return Err("Discord stopped answering heartbeats".to_owned());
                }
                acked = false;
                socket.send(Message::text(json!({ "op": 1, "d": sequence }).to_string())).await.map_err(|e| e.to_string())?;
            }
            event = next_json(&mut socket) => {
                let Some(event) = event? else { return Ok(()) };
                if !event["s"].is_null() {
                    sequence = event["s"].clone();
                }
                match event["op"].as_u64() {
                    Some(0) => dispatch(shared, event["t"].as_str().unwrap_or_default(), &event["d"]),
                    Some(1) => {
                        socket.send(Message::text(json!({ "op": 1, "d": sequence }).to_string())).await.map_err(|e| e.to_string())?;
                    }
                    Some(11) => acked = true,
                    // Reconnect, or the session is invalid: start over.
                    Some(7) | Some(9) => return Ok(()),
                    _ => {}
                }
            }
        }
    }
}

/// The next JSON message; None when the socket closed.
async fn next_json(socket: &mut Socket) -> Result<Option<Value>, String> {
    loop {
        match socket.next().await {
            None => return Ok(None),
            Some(Err(e)) => return Err(e.to_string()),
            Some(Ok(Message::Text(text))) => {
                return serde_json::from_str(text.as_str()).map(Some).map_err(|e| e.to_string());
            }
            Some(Ok(Message::Close(frame))) => {
                // 4004: a wrong token; reconnecting will not help, but the log says why.
                if let Some(frame) = frame {
                    return Err(format!("Discord closed the connection: {} {}", u16::from(frame.code), frame.reason));
                }
                return Ok(None);
            }
            Some(Ok(_)) => {}
        }
    }
}

fn dispatch(shared: &Arc<Shared>, kind: &str, data: &Value) {
    match kind {
        "READY" => {
            let id = data["user"]["id"].as_str().map(str::to_owned);
            tracing::info!("Discord bot {} ready", data["user"]["username"].as_str().unwrap_or("?"));
            *shared.me.lock().expect("me") = id;
        }
        "MESSAGE_CREATE" => {
            let (shared, message) = (shared.clone(), data.clone());
            tokio::spawn(async move {
                if let Err(e) = handle(&shared, &message).await {
                    tracing::warn!("discord: {e}");
                }
            });
        }
        "INTERACTION_CREATE" => {
            let (shared, interaction) = (shared.clone(), data.clone());
            tokio::spawn(async move { answer_button(&shared, &interaction).await });
        }
        _ => {}
    }
}

async fn answer_button(shared: &Shared, interaction: &Value) {
    // 3: a button.
    if interaction["type"] != 3 {
        return;
    }
    let from = interaction["member"]["user"]["id"].as_str().or(interaction["user"]["id"].as_str()).unwrap_or_default();
    let data = interaction["data"]["custom_id"].as_str().unwrap_or_default();
    let (id, choice) = data.split_once(':').unwrap_or_default();
    let answer = match choice {
        "once" => Some(Answer::Once),
        "always" => Some(Answer::Always),
        "deny" => Some(Answer::Deny),
        _ => None,
    };
    let (sender, mine) = match id.parse::<u64>().ok() {
        Some(id) => {
            let mut waiting = shared.waiting.lock().expect("waiting");
            match waiting.get(&id) {
                Some((user, _)) if user == from => (waiting.remove(&id).map(|(_, tx)| tx), true),
                Some(_) => (None, false),
                None => (None, true),
            }
        }
        None => (None, true),
    };
    if !mine {
        // Someone else in the channel: only they see the note.
        let body = json!({ "type": 4, "data": { "content": "This question is not for you.", "flags": 64 } });
        shared.bot.respond(interaction, body).await;
        return;
    }
    let note = match (sender, answer) {
        (Some(tx), Some(answer)) => {
            let note = match answer {
                Answer::Once => "Allowed",
                Answer::Always => "Allowed for this chat",
                Answer::Deny | Answer::Instead(_) => "Denied",
            };
            let _ = tx.send(answer);
            note
        }
        _ => "This question has expired",
    };
    let question = interaction["message"]["content"].as_str().unwrap_or_default();
    let body =
        json!({ "type": 7, "data": { "content": cut_line(&format!("{question}\n→ {note}")), "components": [] } });
    shared.bot.respond(interaction, body).await;
}

async fn handle(shared: &Shared, message: &Value) -> Result<(), String> {
    if message["author"]["bot"] == true {
        return Ok(());
    }
    let me = shared.me.lock().expect("me").clone().unwrap_or_default();
    let channel = message["channel_id"].as_str().ok_or("a message without a channel")?.to_owned();
    let in_server = message["guild_id"].is_string();
    let user = User {
        id: message["author"]["id"].as_str().ok_or("a message without an author")?.to_owned(),
        name: message["author"]["username"].as_str().unwrap_or_default().to_owned(),
    };
    let home = &shared.home;
    let mut users = Users::load(home)?;
    let raw = message["content"].as_str().unwrap_or_default();
    if in_server {
        // Allowed users only, and only messages for the bot: a mention or a reply to it.
        let mentioned = message["mentions"].as_array().is_some_and(|m| m.iter().any(|u| u["id"] == me.as_str()));
        let replied = message["referenced_message"]["author"]["id"] == me.as_str();
        if !users.allows(&user.id) || !(mentioned || replied) {
            return Ok(());
        }
    }
    let text = raw.replace(&format!("<@{me}>"), "").replace(&format!("<@!{me}>"), "");
    let text = text.trim();
    if !users.allows(&user.id) {
        let code = users.code_for(&user)?;
        users.save(home)?;
        tracing::info!(user = %user.id, name = %user.name, "discord: pairing code {code} issued");
        shared
            .bot
            .send(
                &channel,
                &format!(
                    "This agent is private. To let this account in, its owner runs on the machine:\n\n`autobot discord approve {code}`\n\nThe code works for {} minutes.",
                    CODE_LIFETIME / 60
                ),
            )
            .await?;
        return Ok(());
    }
    if text.is_empty() {
        shared.bot.send(&channel, "Only text messages for now.").await?;
        return Ok(());
    }
    let slot = {
        let mut chats = shared.chats.lock().expect("chats");
        match chats.get(&channel) {
            Some(slot) => slot.clone(),
            None => {
                let session = Session::open(&home.join("sessions"), &format!("discord-{channel}"))?;
                let slot = Slot {
                    chat: Arc::new(tokio::sync::Mutex::new(Chat { session, grants: HashSet::new() })),
                    inbox: Arc::default(),
                };
                chats.insert(channel.clone(), slot.clone());
                slot
            }
        }
    };
    let mut chat = match slot.chat.try_lock() {
        Ok(chat) => chat,
        Err(_) if !text.starts_with('/') => {
            slot.inbox.lock().expect("inbox").push(text.to_owned());
            shared.bot.send(&channel, "↪ Noted: I'll take that in before my next step.").await?;
            return Ok(());
        }
        Err(_) => slot.chat.lock().await,
    };
    let (command, args) = text.split_once(char::is_whitespace).map_or((text, ""), |(c, a)| (c, a.trim()));
    let reply = match command {
        "/help" | "/start" => Some(
            "Autobot here, running on your own machine. Send a task, or ask for one later (\"remind me in 10 minutes to …\").\n\n`/new` a new conversation · `/board` the team's work · `/actions` what I ran · `/memory` what I remember · `/skills` your how-to notes"
                .to_owned(),
        ),
        "/new" => {
            chat.session.reset()?;
            chat.grants.clear();
            Some("New conversation.".to_owned())
        }
        "/board" => Some(crate::telegram::board_command(home, args)),
        "/actions" => Some(crate::telegram::actions_command(home)),
        "/memory" => Some(crate::telegram::memory_command(home, args)),
        "/skills" => Some(crate::telegram::skills_command(home, args)),
        _ => None,
    };
    if let Some(reply) = reply {
        shared.bot.send(&channel, &reply).await?;
        return Ok(());
    }

    // Progress: one message, edited as lines come (at most about once a second).
    let (progress, mut lines) = tokio::sync::mpsc::unbounded_channel::<String>();
    let editor = {
        let (bot, channel) = (shared.bot.clone(), channel.clone());
        tokio::spawn(async move {
            let mut shown: Vec<String> = Vec::new();
            let mut message: Option<String> = None;
            while let Some(line) = lines.recv().await {
                shown.push(line);
                // Whatever else arrived meanwhile goes in the same edit.
                tokio::time::sleep(Duration::from_millis(900)).await;
                while let Ok(line) = lines.try_recv() {
                    shown.push(line);
                }
                let start = shown.len().saturating_sub(15);
                let text = shown[start..].join("\n");
                message = match message {
                    Some(id) => {
                        let _ = bot.edit(&channel, &id, &text).await;
                        Some(id)
                    }
                    None => bot.send(&channel, &text).await.ok().and_then(|m| m["id"].as_str().map(str::to_owned)),
                };
            }
        })
    };
    let typing = {
        let (bot, channel) = (shared.bot.clone(), channel.clone());
        tokio::spawn(async move {
            loop {
                bot.typing(&channel).await;
                tokio::time::sleep(Duration::from_secs(8)).await;
            }
        })
    };
    let last_route = Mutex::new(None::<String>);
    let events = |event: Event| match event {
        Event::Tool(what) => {
            let _ = progress.send(format!("› {}", what.chars().take(300).collect::<String>()));
        }
        Event::Refused(why) => {
            let _ = progress.send(format!("✗ {}", why.chars().take(300).collect::<String>()));
        }
        Event::Member { name, text } => {
            let _ = progress.send(format!("[{name}] → {}", text.chars().take(300).collect::<String>()));
        }
        Event::Receipt { id, model, tier } => {
            *last_route.lock().expect("route") = Some(format!(
                "{} · {} · receipt {}",
                model.unwrap_or("?"),
                tier.unwrap_or("?"),
                &id[..id.len().min(8)]
            ));
        }
        _ => {}
    };
    let approver = ButtonApprover {
        bot: shared.bot.clone(),
        channel: channel.clone(),
        user: user.id.clone(),
        waiting: shared.waiting.clone(),
    };
    let Chat { session, grants } = &mut *chat;
    let context = crate::tools::TurnContext {
        session: session.id.clone(),
        discord_channel: Some(channel.clone()),
        inbox: Some(slot.inbox.clone()),
        ..Default::default()
    };
    let result = crate::tools::TURN.scope(context, shared.agent.turn(session, text, &approver, grants, &events)).await;
    typing.abort();
    drop(progress);
    let _ = editor.await;
    let reply = match result {
        Ok(outcome) => match last_route.lock().expect("route").take() {
            Some(route) => format!("{}\n\n-# {route}", outcome.text),
            None => outcome.text,
        },
        Err(e) => format!("✗ {e}"),
    };
    shared.bot.send(&channel, &reply).await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Reaches the real gateway over TLS (network): `cargo test -p autobot -- --ignored discord`.
    #[tokio::test]
    #[ignore]
    async fn discord_gateway_says_hello_over_tls() {
        let mut socket = open("wss://gateway.discord.gg/?v=10&encoding=json", &invincible_policy::NetworkMode::Direct)
            .await
            .unwrap();
        let hello = next_json(&mut socket).await.unwrap().unwrap();
        assert_eq!(hello["op"], 10, "{hello}");
    }

    #[test]
    fn long_answers_split_under_the_limit() {
        let text = format!("{}\n{}", "a".repeat(1500), "b".repeat(1500));
        let parts = split(&text);
        assert_eq!(parts.len(), 2);
        assert!(parts.iter().all(|p| p.chars().count() <= MESSAGE_LIMIT));
        assert_eq!(split(""), ["(empty)"]);
    }

    #[test]
    fn pairing_codes_let_one_user_in() {
        let mut users = Users::default();
        let ann = User { id: "123456789012345678".into(), name: "ann".into() };
        let code = users.code_for(&ann).unwrap();
        assert_eq!(users.code_for(&ann).unwrap(), code, "the same live code");
        assert!(users.approve("nope").is_err());
        users.approve(&code.to_lowercase()).unwrap();
        assert!(users.allows(&ann.id));
        assert!(users.revoke(&ann.id));
        assert!(!users.allows(&ann.id));
    }
}
