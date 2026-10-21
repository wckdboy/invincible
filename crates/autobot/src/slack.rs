//! Slack, through Socket Mode: the app connects out to Slack over a websocket, so the machine
//! needs no public URL.
//!
//! - Direct messages to the app, and in channels the messages that mention it. A thread is a
//!   conversation: a mention in a channel is answered in a thread of its own.
//! - A stranger who messages the app gets a one-time code; nobody gets in until the owner runs
//!   `autobot slack approve <code>` on the machine. In channels, only allowed users are answered.
//! - Approvals are Block Kit buttons only the person asked can press; progress is one message,
//!   edited as the agent works; answers are in Slack's mrkdwn; audio files are transcribed;
//!   speech and pictures the agent makes are uploaded as files in the thread.
//! - Commands: `!status`, `!new` … in a message (Slack keeps `/` for registered commands), or a
//!   slash command registered for the app (`/autobot status`, or `/status` itself).
//!
//! ```toml
//! [slack]
//! enabled = true   # tokens in $AUTOBOT_HOME/slack-app.token (xapp-…) and slack-bot.token (xoxb-…)
//! ```
//!
//! The app needs Socket Mode on, an app-level token with `connections:write`, and a bot token
//! with `chat:write`, `im:history`, `app_mentions:read`, `files:read` (for voice),
//! `files:write` (for speech and pictures), with the
//! `message.im` and `app_mention` events and Interactivity on. Slack's servers see the messages.

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use serde::Deserialize;
use serde_json::{Value, json};
use tokio_tungstenite::tungstenite::Message;

use crate::approval::Answer;
use crate::bots::Runtime;
use crate::channel::{BoxFuture, Incoming, Pressed, Progress, Question, Transport};

/// Slack takes up to 40,000 characters, but shows long messages badly; parts of this size.
const MESSAGE_LIMIT: usize = 3900;

#[derive(Clone, Debug, Default, Deserialize, serde::Serialize)]
#[serde(deny_unknown_fields)]
pub struct SlackConfig {
    #[serde(default)]
    pub enabled: bool,
    /// The app-level token, `xapp-…` [default: `$AUTOBOT_HOME/slack-app.token`].
    #[serde(default)]
    pub app_token_file: Option<PathBuf>,
    /// The bot token, `xoxb-…` [default: `$AUTOBOT_HOME/slack-bot.token`].
    #[serde(default)]
    pub bot_token_file: Option<PathBuf>,
    /// The Web API [default: `https://slack.com/api`]; tests point it at a stand-in.
    #[serde(default)]
    pub api: Option<String>,
}

fn read_token(home: &Path, file: Option<&Path>, default: &str, prefix: &str, what: &str) -> Result<String, String> {
    let path = file.map(crate::config::expand).unwrap_or_else(|| home.join(default));
    let path = if path.is_absolute() { path } else { home.join(path) };
    let token = std::fs::read_to_string(&path).map_err(|e| format!("the Slack {what} {}: {e}", path.display()))?;
    let token = token.trim();
    if !token.starts_with(prefix) {
        return Err(format!("{}: a Slack {what} starts with {prefix}", path.display()));
    }
    Ok(token.to_owned())
}

impl SlackConfig {
    pub fn app_token(&self, home: &Path) -> Result<String, String> {
        read_token(home, self.app_token_file.as_deref(), "slack-app.token", "xapp-", "app-level token")
    }

    pub fn bot_token(&self, home: &Path) -> Result<String, String> {
        read_token(home, self.bot_token_file.as_deref(), "slack-bot.token", "xoxb-", "bot token")
    }

    pub fn api(&self) -> String {
        self.api.clone().unwrap_or_else(|| "https://slack.com/api".to_owned())
    }
}

#[derive(Clone)]
pub struct Client {
    http: reqwest::Client,
    api: String,
    bot_token: String,
    app_token: String,
}

impl Client {
    pub fn new(http: reqwest::Client, api: &str, app_token: &str, bot_token: &str) -> Result<Self, String> {
        invincible::egress::check(api)?;
        Ok(Self {
            http,
            api: api.trim_end_matches('/').to_owned(),
            bot_token: bot_token.to_owned(),
            app_token: app_token.to_owned(),
        })
    }

    /// A Web API call with [token]; its answer, or Slack's error.
    async fn call_with(&self, token: &str, method: &str, body: Value) -> Result<Value, String> {
        for attempt in 0..3 {
            let response = self
                .http
                .post(format!("{}/{method}", self.api))
                .bearer_auth(token)
                .json(&body)
                .timeout(Duration::from_secs(20))
                .send()
                .await
                .map_err(|e| format!("Slack {method}: {}", e.without_url()))?;
            if response.status().as_u16() == 429 && attempt < 2 {
                let wait = response
                    .headers()
                    .get("retry-after")
                    .and_then(|v| v.to_str().ok())
                    .and_then(|v| v.parse::<u64>().ok())
                    .unwrap_or(1);
                tokio::time::sleep(Duration::from_secs(wait.clamp(1, 30))).await;
                continue;
            }
            let reply: Value = response.json().await.map_err(|e| format!("Slack {method}: {}", e.without_url()))?;
            if reply["ok"] != true {
                return Err(format!("Slack {method}: {}", reply["error"].as_str().unwrap_or("failed")));
            }
            return Ok(reply);
        }
        Err(format!("Slack {method}: rate limited"))
    }

    async fn call(&self, method: &str, body: Value) -> Result<Value, String> {
        self.call_with(&self.bot_token, method, body).await
    }

    /// The bot's own user id.
    pub async fn me(&self) -> Result<String, String> {
        let reply = self.call("auth.test", json!({})).await?;
        reply["user_id"].as_str().map(str::to_owned).ok_or_else(|| "Slack gave no user id".to_owned())
    }

    /// A Socket Mode address for one connection.
    async fn socket_url(&self) -> Result<String, String> {
        let reply = self.call_with(&self.app_token, "apps.connections.open", json!({})).await?;
        reply["url"].as_str().map(str::to_owned).ok_or_else(|| "Slack gave no Socket Mode address".to_owned())
    }

    /// Posts [text] (mrkdwn) to [chat] (`C123`, `C123/<thread ts>`, `#ops`, a user id); its ts.
    async fn post(&self, chat: &str, text: &str, blocks: Option<Value>) -> Result<Option<String>, String> {
        let (channel, thread) = place(chat);
        let mut body = json!({ "channel": channel, "text": text, "mrkdwn": true, "unfurl_links": false });
        if let Some(thread) = thread {
            body["thread_ts"] = json!(thread);
        }
        if let Some(blocks) = blocks {
            body["blocks"] = blocks;
        }
        let reply = self.call("chat.postMessage", body).await?;
        Ok(reply["ts"].as_str().map(str::to_owned))
    }

    /// A form-encoded Web API call (for the methods that take no JSON); its answer.
    async fn call_form(&self, method: &str, fields: &[(&str, &str)]) -> Result<Value, String> {
        let response = self
            .http
            .post(format!("{}/{method}", self.api))
            .bearer_auth(&self.bot_token)
            .header("content-type", "application/x-www-form-urlencoded")
            .body(form(fields))
            .timeout(Duration::from_secs(20))
            .send()
            .await
            .map_err(|e| format!("Slack {method}: {}", e.without_url()))?;
        let reply: Value = response.json().await.map_err(|e| format!("Slack {method}: {}", e.without_url()))?;
        if reply["ok"] != true {
            return Err(format!("Slack {method}: {}", reply["error"].as_str().unwrap_or("failed")));
        }
        Ok(reply)
    }

    /// A file the turn made, shared in [chat] (and its thread): Slack's upload in three steps (an
    /// address for it, the bytes there, then shared). Needs the `files:write` scope.
    pub async fn upload(&self, chat: &str, file: &crate::media::Made) -> Result<(), String> {
        let (channel, thread) = place(chat);
        let bytes = file.bytes()?;
        let name = file.name();
        let length = bytes.len().to_string();
        let reply = self.call_form("files.getUploadURLExternal", &[("filename", &name), ("length", &length)]).await?;
        let (Some(url), Some(id)) = (reply["upload_url"].as_str(), reply["file_id"].as_str()) else {
            return Err("Slack files.getUploadURLExternal: no upload address".to_owned());
        };
        // The bytes go only to Slack's own hosts (or to the stand-in the API is).
        let host = reqwest::Url::parse(url).ok().and_then(|u| u.host_str().map(str::to_owned)).unwrap_or_default();
        let api_host = reqwest::Url::parse(&self.api).ok().and_then(|u| u.host_str().map(str::to_owned));
        if !(host == "slack.com" || host.ends_with(".slack.com") || Some(&host) == api_host.as_ref()) {
            return Err(format!("Slack gave an upload address off Slack ({host})"));
        }
        invincible::egress::check(url)?;
        let response = self
            .http
            .post(url)
            .header("content-type", if file.mime.is_empty() { "application/octet-stream" } else { &file.mime })
            .body(bytes)
            .timeout(Duration::from_secs(120))
            .send()
            .await
            .map_err(|e| format!("Slack upload: {}", e.without_url()))?;
        if !response.status().is_success() {
            return Err(format!("Slack upload: {}", response.status()));
        }
        let files = json!([{ "id": id, "title": name }]).to_string();
        let mut fields = vec![("files", files.as_str()), ("channel_id", channel)];
        if let Some(thread) = thread {
            fields.push(("thread_ts", thread));
        }
        self.call_form("files.completeUploadExternal", &fields).await.map(drop)
    }

    async fn update(&self, channel: &str, ts: &str, text: &str, blocks: Value) -> Result<(), String> {
        self.call("chat.update", json!({ "channel": channel, "ts": ts, "text": text, "blocks": blocks }))
            .await
            .map(drop)
    }
}

/// [fields] as an `application/x-www-form-urlencoded` body.
fn form(fields: &[(&str, &str)]) -> String {
    let mut url = reqwest::Url::parse("http://form.invalid/").expect("a valid address");
    url.query_pairs_mut().extend_pairs(fields);
    url.query().unwrap_or_default().to_owned()
}

/// `C123/1712.0001` → (`C123`, Some(`1712.0001`)).
fn place(chat: &str) -> (&str, Option<&str>) {
    match chat.split_once('/') {
        Some((channel, thread)) if !thread.is_empty() => (channel, Some(thread)),
        _ => (chat, None),
    }
}

/// Slack as [crate::channel] sees it.
struct Channel {
    client: Client,
}

impl Transport for Channel {
    fn platform(&self) -> &'static str {
        "slack"
    }

    fn limit(&self) -> usize {
        MESSAGE_LIMIT
    }

    fn progress(&self) -> Progress {
        Progress::Edited
    }

    fn format(&self, markdown: &str) -> String {
        crate::markdown::to_slack(markdown)
    }

    fn footer(&self, route: &str) -> String {
        format!("\n\n_{route}_")
    }

    /// Plain text (progress, notices).
    fn send<'a>(&'a self, chat: &'a str, text: &'a str) -> BoxFuture<'a, Result<Option<String>, String>> {
        Box::pin(async move { self.client.post(chat, &escape(text), None).await })
    }

    /// Markdown, in mrkdwn.
    fn answer<'a>(&'a self, chat: &'a str, markdown: &'a str) -> BoxFuture<'a, Result<(), String>> {
        Box::pin(async move {
            for part in crate::markdown::split(markdown, MESSAGE_LIMIT) {
                self.client.post(chat, &crate::markdown::to_slack(&part), None).await?;
            }
            Ok(())
        })
    }

    fn send_file<'a>(&'a self, chat: &'a str, file: &'a crate::media::Made) -> BoxFuture<'a, Result<bool, String>> {
        Box::pin(async move { self.client.upload(chat, file).await.map(|()| true) })
    }

    fn edit<'a>(&'a self, chat: &'a str, id: &'a str, text: &'a str) -> BoxFuture<'a, Result<(), String>> {
        Box::pin(async move {
            let (channel, _) = place(chat);
            self.client
                .call("chat.update", json!({ "channel": channel, "ts": id, "text": escape(text) }))
                .await
                .map(drop)
        })
    }

    fn ask<'a>(&'a self, chat: &'a str, question: &'a Question) -> BoxFuture<'a, Result<(), String>> {
        Box::pin(async move {
            let id = &question.id;
            let button = |label: &str, choice: &str, style: Option<&str>| {
                let mut b = json!({
                    "type": "button",
                    "text": { "type": "plain_text", "text": label },
                    "action_id": format!("autobot_{choice}"),
                    "value": format!("{id}:{choice}"),
                });
                if let Some(style) = style {
                    b["style"] = json!(style);
                }
                b
            };
            let text = escape(&question.text);
            let blocks = json!([
                { "type": "section", "text": { "type": "mrkdwn", "text": text } },
                { "type": "actions", "elements": [
                    button("Allow", "once", Some("primary")),
                    button("Always (this chat)", "always", None),
                    button("Deny", "deny", Some("danger")),
                ]},
            ]);
            self.client.post(chat, &text, Some(blocks)).await.map(drop)
        })
    }

    fn pairing_text(&self, code: &str) -> String {
        format!(
            "This agent is private. To let this account in, its owner runs on the machine:\n\n`autobot slack approve {code}`\n\nThe code works for {} minutes.",
            crate::pairing::CODE_LIFETIME / 60
        )
    }
}

/// Plain text as Slack shows it: `&`, `<` and `>` escaped.
fn escape(text: &str) -> String {
    text.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;")
}

/// What one connection needs.
struct Shared {
    client: Client,
    runtime: Arc<Runtime>,
    channel: Arc<dyn Transport>,
    me: String,
    network: invincible_policy::NetworkMode,
    /// Events already handled (Slack sends one again when an ack was late).
    seen: Mutex<std::collections::VecDeque<String>>,
}

/// The Slack channel of [runtime], as its config says: off (Err) when it cannot start.
pub async fn run(runtime: Arc<Runtime>) -> Result<(), String> {
    let network = crate::network()?;
    let http = invincible::egress::client(&network)
        .map_err(|e| format!("Slack needs the network: {e}; set [node] network in the gateway's config"))?;
    let config = &runtime.config.slack;
    let client =
        Client::new(http, &config.api(), &config.app_token(&runtime.home)?, &config.bot_token(&runtime.home)?)?;
    serve(client, runtime, network).await
}

/// Answers [runtime]'s messages through [client] until the process stops, reconnecting as Slack
/// asks; Err when the tokens do not work.
pub async fn serve(
    client: Client,
    runtime: Arc<Runtime>,
    network: invincible_policy::NetworkMode,
) -> Result<(), String> {
    let me = client.me().await?;
    tracing::info!(bot = %runtime.name, "Slack app answering as {me} (network: {})", invincible::egress::label(&network));
    let channel: Arc<dyn Transport> = Arc::new(Channel { client: client.clone() });
    runtime.register(channel.clone());
    runtime.channel_account("slack", &format!("@{me}"));
    let shared = Arc::new(Shared { client, runtime, channel, me, network, seen: Mutex::default() });
    let mut backoff = Duration::from_secs(1);
    loop {
        let started = std::time::Instant::now();
        match connection(&shared).await {
            Ok(()) => tracing::info!(bot = %shared.runtime.name, "slack: reconnecting"),
            Err(e) => {
                tracing::warn!(bot = %shared.runtime.name, "slack: {e}; reconnecting in {}s", backoff.as_secs());
                shared.runtime.channel_state("slack", &format!("reconnecting: {e}"));
            }
        }
        if started.elapsed() > Duration::from_secs(60) {
            backoff = Duration::from_secs(1);
        }
        tokio::time::sleep(backoff).await;
        backoff = (backoff * 2).min(Duration::from_secs(60));
    }
}

/// How often the socket is pinged, and how long it may stay silent (no message, no pong) before
/// it is taken for dead: a connection half-open after a network change or a sleep would otherwise
/// wait for the system to give up on it, many minutes of messages lost.
const PING_EVERY: Duration = Duration::from_secs(30);
const SILENT_FOR: Duration = Duration::from_secs(90);

/// Reads a Socket Mode connection, pinging it and noticing when it has gone quiet.
struct Alive {
    ping: tokio::time::Interval,
    heard: tokio::time::Instant,
}

impl Alive {
    fn new() -> Self {
        Self { ping: tokio::time::interval(PING_EVERY), heard: tokio::time::Instant::now() }
    }

    /// The next text message; None when Slack closed the connection.
    async fn next<S>(&mut self, socket: &mut S) -> Result<Option<String>, String>
    where
        S: futures_util::Stream<Item = Result<Message, tokio_tungstenite::tungstenite::Error>>
            + futures_util::Sink<Message, Error = tokio_tungstenite::tungstenite::Error>
            + Unpin,
    {
        loop {
            tokio::select! {
                _ = self.ping.tick() => {
                    if self.heard.elapsed() > SILENT_FOR {
                        return Err(format!("Slack sent nothing in {} seconds, not even a pong", SILENT_FOR.as_secs()));
                    }
                    socket.send(Message::Ping(Vec::new().into())).await.map_err(|e| e.to_string())?;
                }
                message = socket.next() => {
                    self.heard = tokio::time::Instant::now();
                    match message {
                        None | Some(Ok(Message::Close(_))) => return Ok(None),
                        Some(Err(e)) => return Err(e.to_string()),
                        Some(Ok(Message::Text(text))) => return Ok(Some(text.to_string())),
                        Some(Ok(_)) => {}
                    }
                }
            }
        }
    }
}

/// One Socket Mode connection: every envelope acknowledged at once, then handled.
async fn connection(shared: &Arc<Shared>) -> Result<(), String> {
    let url = shared.client.socket_url().await?;
    let mut socket = crate::net::websocket(&url, &shared.network).await?;
    let mut alive = Alive::new();
    loop {
        let Some(text) = alive.next(&mut socket).await? else { return Ok(()) };
        let envelope: Value = serde_json::from_str(&text).map_err(|e| e.to_string())?;
        if let Some(id) = envelope["envelope_id"].as_str() {
            socket.send(Message::text(json!({ "envelope_id": id }).to_string())).await.map_err(|e| e.to_string())?;
        }
        match envelope["type"].as_str().unwrap_or_default() {
            "hello" => shared.runtime.channel_state("slack", "connected"),
            // Slack refreshes connections now and then: open a new one.
            "disconnect" => return Ok(()),
            "events_api" => {
                let (shared, event) = (shared.clone(), envelope["payload"]["event"].clone());
                let id = envelope["payload"]["event_id"].as_str().unwrap_or_default().to_owned();
                if shared.first_time(&id) {
                    tokio::spawn(async move {
                        if let Err(e) = event_message(&shared, &event).await {
                            tracing::warn!(bot = %shared.runtime.name, "slack: {e}");
                        }
                    });
                }
            }
            "interactive" => {
                let (shared, payload) = (shared.clone(), envelope["payload"].clone());
                tokio::spawn(async move { press(&shared, &payload).await });
            }
            "slash_commands" => {
                let (shared, payload) = (shared.clone(), envelope["payload"].clone());
                tokio::spawn(async move {
                    if let Err(e) = slash(&shared, &payload).await {
                        tracing::warn!(bot = %shared.runtime.name, "slack: {e}");
                    }
                });
            }
            _ => {}
        }
    }
}

impl Shared {
    fn first_time(&self, id: &str) -> bool {
        if id.is_empty() {
            return true;
        }
        let mut seen = self.seen.lock().expect("seen");
        if seen.iter().any(|s| s == id) {
            return false;
        }
        if seen.len() >= 200 {
            seen.pop_front();
        }
        seen.push_back(id.to_owned());
        true
    }
}

/// What an event is for the bot: (chat, place, direct), or None when it is not for it.
pub fn route(event: &Value, me: &str) -> Option<(String, String, bool)> {
    let kind = event["type"].as_str()?;
    // Its own messages, other bots, edits and deletions: not for it.
    if event["bot_id"].is_string() || event["user"].as_str() == Some(me) || event["user"].as_str().is_none() {
        return None;
    }
    match event["subtype"].as_str() {
        None | Some("file_share" | "thread_broadcast") => {}
        Some(_) => return None,
    }
    let channel = event["channel"].as_str()?;
    let ts = event["ts"].as_str().unwrap_or_default();
    let thread = event["thread_ts"].as_str();
    match (kind, event["channel_type"].as_str()) {
        // A direct message: the conversation, or its thread when it is in one.
        ("message", Some("im")) => Some(match thread {
            Some(thread) => (format!("{channel}/{thread}"), format!("slack-{channel}-{thread}"), true),
            None => (channel.to_owned(), format!("slack-{channel}"), true),
        }),
        // A mention in a channel: answered in its thread (a new one off the mention).
        ("app_mention", _) => {
            let thread = thread.unwrap_or(ts);
            Some((format!("{channel}/{thread}"), format!("slack-{channel}-{thread}"), false))
        }
        _ => None,
    }
}

async fn event_message(shared: &Shared, event: &Value) -> Result<(), String> {
    let Some((chat, place, direct)) = route(event, &shared.me) else { return Ok(()) };
    let user = crate::pairing::User {
        id: event["user"].as_str().unwrap_or_default().to_owned(),
        name: event["user_profile"]["name"].as_str().unwrap_or_default().to_owned(),
    };
    let text = event["text"].as_str().unwrap_or_default().replace(&format!("<@{}>", shared.me), "");
    let audio = event["files"]
        .as_array()
        .into_iter()
        .flatten()
        .find(|f| crate::voice::is_audio(f["mimetype"].as_str().unwrap_or(""), f["name"].as_str().unwrap_or("")))
        .map(|f| {
            let client = shared.client.clone();
            let url = f["url_private_download"].as_str().or(f["url_private"].as_str()).unwrap_or_default().to_owned();
            let mime = f["mimetype"].as_str().unwrap_or("audio/mp4").to_owned();
            let name = f["name"].as_str().unwrap_or("voice.m4a").to_owned();
            Box::pin(async move {
                // The bot token goes only to Slack's own file hosts.
                let host =
                    reqwest::Url::parse(&url).ok().and_then(|u| u.host_str().map(str::to_owned)).unwrap_or_default();
                let api_host = reqwest::Url::parse(&client.api).ok().and_then(|u| u.host_str().map(str::to_owned));
                if !(host == "files.slack.com" || host.ends_with(".slack.com") || Some(&host) == api_host.as_ref()) {
                    return Err("the audio is not on Slack".to_owned());
                }
                let auth = format!("Bearer {}", client.bot_token);
                crate::voice::download(&client.http, &url, Some(&auth), &mime, &name).await
            }) as BoxFuture<'static, _>
        });
    let incoming = Incoming { chat, place, user, text: unescape(&text), direct, audio };
    crate::channel::handle(&shared.runtime, &shared.channel, incoming).await
}

/// Slack's escapes undone, and links shown as their addresses.
fn unescape(text: &str) -> String {
    static LINKS: std::sync::LazyLock<regex::Regex> = std::sync::LazyLock::new(|| {
        regex::Regex::new(r"<((?:https?|mailto):[^|>]+)(?:\|[^>]*)?>").expect("a valid pattern")
    });
    let text = LINKS.replace_all(text, "$1");
    text.replace("&lt;", "<").replace("&gt;", ">").replace("&amp;", "&")
}

/// A slash command registered for the app: `/autobot status` (or `/status`) runs as `/status`.
async fn slash(shared: &Shared, payload: &Value) -> Result<(), String> {
    let command = payload["command"].as_str().unwrap_or_default().trim_start_matches('/');
    let args = payload["text"].as_str().unwrap_or_default().trim();
    let text = if command == "autobot" || command == shared.runtime.name {
        format!("/{args}")
    } else {
        format!("/{command} {args}")
    };
    let channel = payload["channel_id"].as_str().unwrap_or_default().to_owned();
    let direct = channel.starts_with('D');
    let incoming = Incoming {
        place: format!("slack-{channel}"),
        chat: channel,
        user: crate::pairing::User {
            id: payload["user_id"].as_str().unwrap_or_default().to_owned(),
            name: payload["user_name"].as_str().unwrap_or_default().to_owned(),
        },
        text,
        direct,
        audio: None,
    };
    crate::channel::handle(&shared.runtime, &shared.channel, incoming).await
}

/// A button press: only the person asked counts; the question shows what became of it.
async fn press(shared: &Shared, payload: &Value) {
    if payload["type"] != "block_actions" {
        return;
    }
    let user = payload["user"]["id"].as_str().unwrap_or_default();
    let Some(value) = payload["actions"][0]["value"].as_str() else { return };
    let (id, choice) = value.split_once(':').unwrap_or_default();
    let answer = match choice {
        "once" => Answer::Once,
        "always" => Answer::Always,
        "deny" => Answer::Deny,
        _ => return,
    };
    let channel = payload["channel"]["id"].as_str().or(payload["container"]["channel_id"].as_str()).unwrap_or_default();
    let ts = payload["message"]["ts"].as_str().or(payload["container"]["message_ts"].as_str()).unwrap_or_default();
    let question = payload["message"]["text"].as_str().unwrap_or_default();
    let note = match shared.runtime.conversations.press(id, user, answer) {
        Pressed::Done(note) => note,
        Pressed::Expired => "This question has expired",
        Pressed::NotYours => {
            let _ = shared
                .client
                .call(
                    "chat.postEphemeral",
                    json!({ "channel": channel, "user": user, "text": "This question is not for you." }),
                )
                .await;
            return;
        }
    };
    let text = format!("{question}\n→ {note}");
    let blocks = json!([{ "type": "section", "text": { "type": "mrkdwn", "text": text } }]);
    if let Err(e) = shared.client.update(channel, ts, &text, blocks).await {
        tracing::warn!(bot = %shared.runtime.name, "slack: {e}");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A connection that went half-open (it takes what is sent and never answers, not even a
    /// pong) is given up on, and the reconnect loop opens a new one.
    #[tokio::test(start_paused = true)]
    async fn a_socket_that_goes_silent_is_taken_for_dead() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            let (tcp, _) = listener.accept().await.unwrap();
            let socket = tokio_tungstenite::accept_async(tcp).await.unwrap();
            // Held, never read: no pong goes back.
            std::future::pending::<()>().await;
            drop(socket);
        });
        let tcp = tokio::net::TcpStream::connect(address).await.unwrap();
        let (mut socket, _) = tokio_tungstenite::client_async(format!("ws://{address}/"), tcp).await.unwrap();
        let started = tokio::time::Instant::now();
        let error = Alive::new().next(&mut socket).await.unwrap_err();
        assert!(error.contains("sent nothing in 90 seconds"), "{error}");
        assert!(started.elapsed() >= SILENT_FOR && started.elapsed() <= SILENT_FOR + PING_EVERY * 2);
        server.abort();
    }

    #[test]
    fn events_for_the_bot() {
        let dm = json!({ "type": "message", "channel_type": "im", "channel": "D1", "user": "U1", "text": "hi", "ts": "1.1" });
        assert_eq!(route(&dm, "UBOT"), Some(("D1".into(), "slack-D1".into(), true)));
        let in_thread = json!({ "type": "message", "channel_type": "im", "channel": "D1", "user": "U1", "ts": "1.2", "thread_ts": "1.1" });
        assert_eq!(route(&in_thread, "UBOT").unwrap().0, "D1/1.1");
        let mention =
            json!({ "type": "app_mention", "channel": "C1", "user": "U1", "text": "<@UBOT> hi", "ts": "5.5" });
        assert_eq!(route(&mention, "UBOT"), Some(("C1/5.5".into(), "slack-C1-5.5".into(), false)));
        // Its own messages, bots, edits, and channel chatter without a mention: not for it.
        for not in [
            json!({ "type": "message", "channel_type": "im", "channel": "D1", "user": "UBOT", "ts": "1" }),
            json!({ "type": "message", "channel_type": "im", "channel": "D1", "bot_id": "B1", "user": "U2", "ts": "1" }),
            json!({ "type": "message", "subtype": "message_changed", "channel_type": "im", "channel": "D1", "user": "U1" }),
            json!({ "type": "message", "channel_type": "channel", "channel": "C1", "user": "U1", "ts": "1" }),
        ] {
            assert_eq!(route(&not, "UBOT"), None, "{not}");
        }
        let voice = json!({ "type": "message", "subtype": "file_share", "channel_type": "im", "channel": "D1", "user": "U1", "ts": "1" });
        assert!(route(&voice, "UBOT").is_some());
    }

    #[test]
    fn text_in_and_out() {
        assert_eq!(
            unescape("a &lt;b&gt; &amp; <https://x.org/a|x.org/a> <mailto:a@b.c|a@b.c>"),
            "a <b> & https://x.org/a mailto:a@b.c"
        );
        assert_eq!(escape("a < b & c"), "a &lt; b &amp; c");
        assert_eq!(place("C1/1.2"), ("C1", Some("1.2")));
        assert_eq!(place("#ops"), ("#ops", None));
        assert_eq!(
            form(&[("filename", "a b.mp3"), ("files", "[{\"id\":\"F1\"}]")]),
            "filename=a+b.mp3&files=%5B%7B%22id%22%3A%22F1%22%7D%5D"
        );
    }

    #[test]
    fn tokens_are_checked() {
        let home = std::env::temp_dir().join(format!("autobot-slack-tokens-{}", std::process::id()));
        std::fs::create_dir_all(&home).unwrap();
        std::fs::write(home.join("slack-app.token"), "xoxb-wrong-kind\n").unwrap();
        std::fs::write(home.join("slack-bot.token"), "xoxb-fake\n").unwrap();
        let config = SlackConfig::default();
        assert!(config.app_token(&home).unwrap_err().contains("xapp-"));
        assert_eq!(config.bot_token(&home).unwrap(), "xoxb-fake");
        std::fs::remove_dir_all(home).unwrap();
    }
}
