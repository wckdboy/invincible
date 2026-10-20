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
//! - Audio attachments are transcribed ([crate::voice]).
//!
//! ```toml
//! [discord]
//! enabled = true      # token in $AUTOBOT_HOME/discord.token
//! ```
//!
//! Discord's servers see bot messages. The private channel is the Autobot app, paired over Noise.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use serde::Deserialize;
use serde_json::{Value, json};
use tokio_tungstenite::tungstenite::Message;

use crate::agent::Agent;
use crate::approval::Answer;
use crate::bots::Runtime;
use crate::channel::{BoxFuture, Incoming, Pressed, Progress, Question, Transport};
use crate::net::Socket;

/// Discord's limit for one message is 2000 characters; some room for a footer.
const MESSAGE_LIMIT: usize = 1900;
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
        let path = if path.is_absolute() { path } else { home.join(path) };
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
        let channel = self.channel(channel).await?;
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

    /// [chat] as a channel: `user:<id>` is that user's direct-message channel.
    async fn channel(&self, chat: &str) -> Result<String, String> {
        match chat.strip_prefix("user:") {
            Some(user) => self.dm(user).await,
            None => Ok(chat.to_owned()),
        }
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

/// Splits [text] into messages Discord takes, at line breaks where it can.
fn split(text: &str) -> Vec<String> {
    let mut parts = crate::markdown::split(text, MESSAGE_LIMIT);
    if parts.iter().all(|p| p.trim().is_empty()) {
        parts = vec!["(empty)".to_owned()];
    }
    parts
}

fn cut_line(text: &str) -> String {
    crate::channel::cut(text, MESSAGE_LIMIT)
}

/// Discord as [crate::channel] sees it.
struct Channel {
    bot: Bot,
}

impl Transport for Channel {
    fn platform(&self) -> &'static str {
        "discord"
    }

    fn limit(&self) -> usize {
        MESSAGE_LIMIT
    }

    fn progress(&self) -> Progress {
        Progress::Edited
    }

    fn footer(&self, route: &str) -> String {
        format!("\n\n-# {route}")
    }

    fn send<'a>(&'a self, chat: &'a str, text: &'a str) -> BoxFuture<'a, Result<Option<String>, String>> {
        Box::pin(async move { Ok(self.bot.send(chat, text).await?["id"].as_str().map(str::to_owned)) })
    }

    fn answer<'a>(&'a self, chat: &'a str, markdown: &'a str) -> BoxFuture<'a, Result<(), String>> {
        Box::pin(async move { self.bot.send(chat, markdown).await.map(drop) })
    }

    fn edit<'a>(&'a self, chat: &'a str, id: &'a str, text: &'a str) -> BoxFuture<'a, Result<(), String>> {
        Box::pin(async move { self.bot.edit(chat, id, text).await })
    }

    fn typing<'a>(&'a self, chat: &'a str) -> BoxFuture<'a, ()> {
        Box::pin(async move { self.bot.typing(chat).await })
    }

    fn ask<'a>(&'a self, chat: &'a str, question: &'a Question) -> BoxFuture<'a, Result<(), String>> {
        Box::pin(async move {
            let id = &question.id;
            let button = |label: &str, style: u8, choice: &str| json!({ "type": 2, "style": style, "label": label, "custom_id": format!("{id}:{choice}") });
            let body = json!({
                "content": cut_line(&question.text),
                "allowed_mentions": { "parse": [] },
                "components": [{ "type": 1, "components": [
                    button("Allow", 3, "once"),
                    button("Always (this chat)", 1, "always"),
                    button("Deny", 4, "deny"),
                ]}],
            });
            let channel = self.bot.channel(chat).await?;
            self.bot.call(reqwest::Method::POST, &format!("/channels/{channel}/messages"), Some(body)).await.map(drop)
        })
    }

    fn pairing_text(&self, code: &str) -> String {
        format!(
            "This agent is private. To let this account in, its owner runs on the machine:\n\n`autobot discord approve {code}`\n\nThe code works for {} minutes.",
            crate::pairing::CODE_LIFETIME / 60
        )
    }

    fn user_chat(&self, user: &str) -> String {
        format!("user:{user}")
    }
}

/// Everything one connection needs.
struct Shared {
    bot: Bot,
    runtime: Arc<Runtime>,
    channel: Arc<dyn Transport>,
    /// The bot's own user id, once Discord said it.
    me: Mutex<Option<String>>,
}

/// Answers messages until the process stops (one bot on its own: tests, and older callers).
pub async fn serve(bot: Bot, agent: Arc<Agent>, home: PathBuf) {
    serve_bot(bot, Runtime::standalone(crate::bots::DEFAULT, &home, agent)).await;
}

/// The Discord channel of [runtime], as its config says: off (Err) when it cannot start.
pub async fn run(runtime: Arc<Runtime>) -> Result<(), String> {
    let network = crate::network()?;
    let client = invincible::egress::client(&network)
        .map_err(|e| format!("Discord needs the network: {e}; set [node] network in the gateway's config"))?;
    let config = &runtime.config.discord;
    let bot = Bot::new(client, &config.api(), &config.token(&runtime.home)?, network.clone())?;
    let me = bot.me().await?;
    tracing::info!(
        bot = %runtime.name,
        "Discord bot {} answering (network: {})",
        me["username"].as_str().unwrap_or("?"),
        invincible::egress::route(&network)
    );
    serve_bot(bot, runtime).await;
    Ok(())
}

/// Answers [runtime]'s messages through [bot], reconnecting when the connection drops.
pub async fn serve_bot(bot: Bot, runtime: Arc<Runtime>) {
    let channel: Arc<dyn Transport> = Arc::new(Channel { bot: bot.clone() });
    runtime.register(channel.clone());
    let shared = Arc::new(Shared { bot, runtime, channel, me: Mutex::default() });
    let mut backoff = Duration::from_secs(1);
    loop {
        let started = std::time::Instant::now();
        match connection(&shared).await {
            Ok(()) => tracing::info!("discord: reconnecting"),
            Err(e) => {
                tracing::warn!(bot = %shared.runtime.name, "discord: {e}; reconnecting in {}s", backoff.as_secs());
                shared.runtime.channel_state("discord", &format!("reconnecting: {e}"));
            }
        }
        if started.elapsed() > Duration::from_secs(60) {
            backoff = Duration::from_secs(1);
        }
        tokio::time::sleep(backoff).await;
        backoff = (backoff * 2).min(Duration::from_secs(60));
    }
}

/// One gateway connection: hello, identify, then events until Discord asks to reconnect.
async fn connection(shared: &Arc<Shared>) -> Result<(), String> {
    let url = shared.bot.gateway_url().await?;
    let url = format!("{}/?v=10&encoding=json", url.trim_end_matches('/'));
    let mut socket = crate::net::websocket(&url, &shared.bot.network).await?;
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
            shared.runtime.channel_state("discord", "connected");
            shared.runtime.channel_account("discord", data["user"]["username"].as_str().unwrap_or_default());
        }
        "MESSAGE_CREATE" => {
            let (shared, message) = (shared.clone(), data.clone());
            tokio::spawn(async move {
                if let Err(e) = handle(&shared, &message).await {
                    tracing::warn!(bot = %shared.runtime.name, "discord: {e}");
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
    let pressed = match answer {
        Some(answer) => shared.runtime.conversations.press(id, from, answer),
        None => Pressed::Expired,
    };
    let note = match pressed {
        Pressed::Done(note) => note,
        Pressed::Expired => "This question has expired",
        Pressed::NotYours => {
            // Someone else in the channel: only they see the note.
            let body = json!({ "type": 4, "data": { "content": "This question is not for you.", "flags": 64 } });
            shared.bot.respond(interaction, body).await;
            return;
        }
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
    let user = crate::pairing::User {
        id: message["author"]["id"].as_str().ok_or("a message without an author")?.to_owned(),
        name: message["author"]["username"].as_str().unwrap_or_default().to_owned(),
    };
    let raw = message["content"].as_str().unwrap_or_default();
    if in_server {
        // Allowed users only, and only messages for the bot: a mention or a reply to it.
        let mentioned = message["mentions"].as_array().is_some_and(|m| m.iter().any(|u| u["id"] == me.as_str()));
        let replied = message["referenced_message"]["author"]["id"] == me.as_str();
        if !crate::pairing::allows(&shared.runtime.home, "discord", &user.id)? || !(mentioned || replied) {
            return Ok(());
        }
    }
    let text = raw.replace(&format!("<@{me}>"), "").replace(&format!("<@!{me}>"), "");
    // The first audio attachment (a voice message is one).
    let audio = message["attachments"]
        .as_array()
        .into_iter()
        .flatten()
        .find(|a| {
            crate::voice::is_audio(a["content_type"].as_str().unwrap_or(""), a["filename"].as_str().unwrap_or(""))
        })
        .map(|a| {
            let client = shared.bot.client.clone();
            let url = a["url"].as_str().unwrap_or_default().to_owned();
            let mime = a["content_type"].as_str().unwrap_or("audio/ogg").to_owned();
            let name = a["filename"].as_str().unwrap_or("voice.ogg").to_owned();
            Box::pin(async move {
                if !url.starts_with("https://") {
                    return Err("the audio is not on https".to_owned());
                }
                crate::voice::download(&client, &url, None, &mime, &name).await
            }) as BoxFuture<'static, _>
        });
    let incoming =
        Incoming { chat: channel.clone(), place: format!("discord-{channel}"), user, text, direct: !in_server, audio };
    crate::channel::handle(&shared.runtime, &shared.channel, incoming).await
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Reaches the real gateway over TLS (network): `cargo test -p autobot -- --ignored discord`.
    #[tokio::test]
    #[ignore]
    async fn discord_gateway_says_hello_over_tls() {
        let mut socket = crate::net::websocket(
            "wss://gateway.discord.gg/?v=10&encoding=json",
            &invincible_policy::NetworkMode::Direct,
        )
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
}
