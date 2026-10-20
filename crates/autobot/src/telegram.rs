//! Telegram: the agent answers its owner's direct messages through a bot.
//!
//! - Long polling, so the machine needs no public address or webhook.
//! - The Bot API is reached under Invincible Gateway's network mode (`[node] network`): direct,
//!   Tor or SOCKS5, and never when the gateway is offline.
//! - Private chats, and in a group the messages for the bot. A stranger gets a one-time code;
//!   nobody gets in until the owner runs `autobot telegram approve <code>` on the machine
//!   (Hermes-style DM pairing).
//! - Approvals arrive as buttons in the chat; voice notes are transcribed ([crate::voice]).
//! - Everything else (commands, steering, the turn) is [crate::channel]'s.
//!
//! Telegram's servers see bot messages: chats with bots are not end-to-end encrypted. The private
//! channel is the Autobot app, paired over Noise.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use crate::agent::Agent;
use crate::approval::Answer;
use crate::bots::Runtime;
use crate::channel::{Asking, BoxFuture, Incoming, Pressed, Progress, Question, Transport};

/// Telegram's limit for one message.
const MESSAGE_LIMIT: usize = 4000;
/// How long a pairing code works.
const CODE_LIFETIME: u64 = crate::pairing::CODE_LIFETIME;

#[derive(Clone)]
pub struct Bot {
    client: reqwest::Client,
    base: String,
    files: String,
}

impl Bot {
    pub fn new(client: reqwest::Client, api: &str, token: &str) -> Result<Self, String> {
        invincible::egress::check(api)?;
        let api = api.trim_end_matches('/');
        Ok(Self { client, base: format!("{api}/bot{token}"), files: format!("{api}/file/bot{token}") })
    }

    async fn call(&self, method: &str, body: Value, timeout: Duration) -> Result<Value, String> {
        let response = self
            .client
            .post(format!("{}/{method}", self.base))
            .json(&body)
            .timeout(timeout)
            .send()
            .await
            // Not `e.to_string()`: reqwest puts the URL, and so the bot token, in its errors.
            .map_err(|e| format!("Telegram {method}: {}", e.without_url()))?;
        let reply: Value = response.json().await.map_err(|e| format!("Telegram {method}: {}", e.without_url()))?;
        if reply["ok"] != true {
            return Err(format!("Telegram {method}: {}", reply["description"].as_str().unwrap_or("failed")));
        }
        Ok(reply["result"].clone())
    }

    pub async fn me(&self) -> Result<Value, String> {
        self.call("getMe", json!({}), Duration::from_secs(20)).await
    }

    async fn updates(&self, offset: i64) -> Result<Vec<Value>, String> {
        let body = json!({ "offset": offset, "timeout": 50, "allowed_updates": ["message", "callback_query"] });
        Ok(self.call("getUpdates", body, Duration::from_secs(70)).await?.as_array().cloned().unwrap_or_default())
    }

    pub async fn send(&self, chat: i64, text: &str) -> Result<Value, String> {
        let mut last = Value::Null;
        for part in split(text) {
            last = self.call("sendMessage", json!({ "chat_id": chat, "text": part }), Duration::from_secs(20)).await?;
        }
        Ok(last)
    }

    async fn typing(&self, chat: i64) {
        let _ =
            self.call("sendChatAction", json!({ "chat_id": chat, "action": "typing" }), Duration::from_secs(10)).await;
    }

    /// A file a message carries (a voice note), by its id.
    async fn file(&self, id: &str, mime: &str) -> Result<crate::voice::Audio, String> {
        let file = self.call("getFile", json!({ "file_id": id }), Duration::from_secs(20)).await?;
        if file["file_size"].as_u64().is_some_and(|n| n as usize > crate::voice::MAX_AUDIO) {
            return Err("the audio is larger than 25 MB".to_owned());
        }
        let path = file["file_path"].as_str().ok_or("Telegram gave no file path")?;
        let name = path.rsplit('/').next().unwrap_or("voice.ogg").to_owned();
        crate::voice::download(&self.client, &format!("{}/{path}", self.files), None, mime, &name).await
    }
}

/// Splits [text] into messages Telegram accepts, at line breaks where it can.
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
        parts.push(rest.to_owned());
    }
    parts
}

/// Who may talk to the agent, and who asked: `$AUTOBOT_HOME/telegram-users.json`. Read on every
/// message, so `autobot telegram approve` works while the bot runs.
#[derive(Debug, Default, Serialize, Deserialize)]
pub struct Users {
    #[serde(default)]
    pub allowed: Vec<User>,
    #[serde(default)]
    pub pending: Vec<Pending>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct User {
    pub id: i64,
    pub name: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Pending {
    pub code: String,
    pub user: User,
    pub expires: u64,
}

impl Users {
    pub fn path(home: &Path) -> PathBuf {
        home.join("telegram-users.json")
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

    pub fn allows(&self, id: i64) -> bool {
        self.allowed.iter().any(|u| u.id == id)
    }

    /// The code [user] should give the owner: their live one, or a new one.
    pub fn code_for(&mut self, user: &User) -> Result<String, String> {
        let now = crate::pairing::now();
        self.pending.retain(|p| p.expires > now);
        if let Some(p) = self.pending.iter().find(|p| p.user.id == user.id) {
            return Ok(p.code.clone());
        }
        // Few live codes at once, so a flood of strangers cannot grow the file without bound.
        if self.pending.len() >= 10 {
            self.pending.remove(0);
        }
        let code = new_code()?;
        self.pending.push(Pending { code: code.clone(), user: user.clone(), expires: now + CODE_LIFETIME });
        Ok(code)
    }

    /// Lets in the user who was given [code].
    pub fn approve(&mut self, code: &str) -> Result<User, String> {
        let wanted = normalize(code);
        let now = crate::pairing::now();
        let at =
            self.pending.iter().position(|p| p.expires > now && normalize(&p.code) == wanted).ok_or_else(|| {
                format!("no live pairing code {code:?} (codes work for {} minutes)", CODE_LIFETIME / 60)
            })?;
        let user = self.pending.remove(at).user;
        if !self.allows(user.id) {
            self.allowed.push(user.clone());
        }
        Ok(user)
    }

    pub fn revoke(&mut self, id: i64) -> bool {
        let before = self.allowed.len();
        self.allowed.retain(|u| u.id != id);
        before != self.allowed.len()
    }
}

pub(crate) use crate::pairing::{new_code, normalize};

/// The bots the agent speaks through: its own, and optionally one per team member, so in a
/// group the members show up as bots of their own. Telegram bots never see each other's
/// messages, so members are handed work inside the agent; their bots only post.
pub struct Bots {
    /// The main bot's username (without `@`), to tell when a group message is for it.
    pub username: String,
    pub members: HashMap<String, Bot>,
}

/// Telegram as [crate::channel] sees it.
struct Channel {
    bot: Bot,
    bots: Arc<Bots>,
}

fn chat_id(chat: &str) -> Result<i64, String> {
    chat.parse().map_err(|_| format!("not a Telegram chat: {chat:?}"))
}

impl Transport for Channel {
    fn platform(&self) -> &'static str {
        "telegram"
    }

    fn limit(&self) -> usize {
        MESSAGE_LIMIT
    }

    fn progress(&self) -> Progress {
        Progress::Lines
    }

    fn asking(&self) -> Asking {
        Asking::Buttons
    }

    fn send<'a>(&'a self, chat: &'a str, text: &'a str) -> BoxFuture<'a, Result<Option<String>, String>> {
        Box::pin(async move {
            let sent = self.bot.send(chat_id(chat)?, text).await?;
            Ok(sent["message_id"].as_i64().map(|id| id.to_string()))
        })
    }

    /// In Telegram's HTML; a part it cannot read goes again as plain text.
    fn answer<'a>(&'a self, chat: &'a str, markdown: &'a str) -> BoxFuture<'a, Result<(), String>> {
        Box::pin(async move {
            let chat = chat_id(chat)?;
            for part in crate::markdown::split(markdown, MESSAGE_LIMIT - 400) {
                let html = crate::markdown::to_html(&part);
                let body = json!({ "chat_id": chat, "text": cut_line(&html), "parse_mode": "HTML" });
                if let Err(e) = self.bot.call("sendMessage", body, Duration::from_secs(20)).await {
                    tracing::info!("telegram: as plain text ({e})");
                    self.bot.send(chat, &crate::markdown::to_plain(&part)).await?;
                }
            }
            Ok(())
        })
    }

    fn edit<'a>(&'a self, chat: &'a str, id: &'a str, text: &'a str) -> BoxFuture<'a, Result<(), String>> {
        Box::pin(async move {
            let body = json!({ "chat_id": chat_id(chat)?, "message_id": id.parse::<i64>().unwrap_or(0), "text": cut_line(text) });
            self.bot.call("editMessageText", body, Duration::from_secs(10)).await.map(drop)
        })
    }

    fn typing<'a>(&'a self, chat: &'a str) -> BoxFuture<'a, ()> {
        Box::pin(async move {
            if let Ok(chat) = chat_id(chat) {
                self.bot.typing(chat).await;
            }
        })
    }

    fn ask<'a>(&'a self, chat: &'a str, question: &'a Question) -> BoxFuture<'a, Result<(), String>> {
        Box::pin(async move {
            let id = &question.id;
            let keyboard = json!({ "inline_keyboard": [[
                { "text": "Allow", "callback_data": format!("{id}:once") },
                { "text": "Always (this chat)", "callback_data": format!("{id}:always") },
                { "text": "Deny", "callback_data": format!("{id}:deny") },
            ]]});
            let body = json!({ "chat_id": chat_id(chat)?, "text": cut_line(&question.text), "reply_markup": keyboard });
            self.bot.call("sendMessage", body, Duration::from_secs(20)).await.map(drop)
        })
    }

    fn post_as<'a>(&'a self, member: &'a str, chat: &'a str, text: &'a str) -> BoxFuture<'a, bool> {
        Box::pin(async move {
            let (Some(own), Ok(chat)) = (self.bots.members.get(member), chat_id(chat)) else { return false };
            own.send(chat, text).await.is_ok()
        })
    }
}

fn cut_line(text: &str) -> String {
    crate::channel::cut(text, MESSAGE_LIMIT)
}

/// Answers messages until the process stops (one bot on its own: tests, and older callers).
pub async fn serve(bot: Bot, bots: Arc<Bots>, agent: Arc<Agent>, home: PathBuf) {
    let runtime = Runtime::standalone(crate::bots::DEFAULT, &home, agent);
    serve_bot(bot, bots, runtime).await;
}

/// The Telegram channel of [runtime], as its config says: off (Err) when it cannot start.
pub async fn run(runtime: Arc<Runtime>) -> Result<(), String> {
    let (bot, bots) = connect(&runtime.config, &runtime.home).await?;
    serve_bot(bot, bots, runtime).await;
    Ok(())
}

/// The bot, and its team members' bots, checked with Telegram.
pub async fn connect(config: &crate::config::Config, home: &Path) -> Result<(Bot, Arc<Bots>), String> {
    let network = crate::network()?;
    let client = invincible::egress::client(&network)
        .map_err(|e| format!("Telegram needs the network: {e}; set [node] network in the gateway's config"))?;
    let bot = Bot::new(client.clone(), &config.telegram.api(), &config.telegram.token(home)?)?;
    let me = bot.me().await?;
    let username = me["username"].as_str().unwrap_or_default().to_owned();
    tracing::info!("Telegram bot @{username} answering (network: {})", invincible::egress::route(&network));
    // Team members with bots of their own: they post; a broken one is skipped (the main bot
    // posts for it).
    let mut members = HashMap::new();
    for (name, role) in &config.agents {
        let Some(file) = &role.telegram_token_file else { continue };
        let path = if file.is_absolute() { file.clone() } else { home.join(file) };
        let member = std::fs::read_to_string(&path)
            .map_err(|e| format!("{}: {e}", path.display()))
            .and_then(|token| Bot::new(client.clone(), &config.telegram.api(), token.trim()));
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
    Ok((bot, Arc::new(Bots { username, members })))
}

/// Answers [runtime]'s messages through [bot] until the process stops.
pub async fn serve_bot(bot: Bot, bots: Arc<Bots>, runtime: Arc<Runtime>) {
    let channel: Arc<dyn Transport> = Arc::new(Channel { bot: bot.clone(), bots: bots.clone() });
    runtime.register(channel.clone());
    runtime.channel_account("telegram", &format!("@{}", bots.username));
    let mut offset = 0;
    let mut backoff = Duration::from_secs(1);
    loop {
        let updates = match bot.updates(offset).await {
            Ok(updates) => {
                if backoff > Duration::from_secs(1) {
                    runtime.channel_state("telegram", "connected");
                }
                backoff = Duration::from_secs(1);
                updates
            }
            Err(e) => {
                tracing::warn!(bot = %runtime.name, "{e}; retrying in {}s", backoff.as_secs());
                runtime.channel_state("telegram", &format!("retrying: {e}"));
                tokio::time::sleep(backoff).await;
                backoff = (backoff * 2).min(Duration::from_secs(60));
                continue;
            }
        };
        for update in updates {
            offset = offset.max(update["update_id"].as_i64().unwrap_or(0) + 1);
            if let Some(query) = update.get("callback_query") {
                answer_button(&bot, query, &runtime).await;
            } else if let Some(message) = update.get("message") {
                let (bot, bots, runtime, channel) = (bot.clone(), bots.clone(), runtime.clone(), channel.clone());
                let message = message.clone();
                tokio::spawn(async move {
                    if let Err(e) = handle(&bot, &bots, &runtime, &channel, &message).await {
                        tracing::warn!(bot = %runtime.name, "telegram: {e}");
                    }
                });
            }
        }
    }
}

async fn answer_button(bot: &Bot, query: &Value, runtime: &Runtime) {
    let data = query["data"].as_str().unwrap_or_default();
    let from = query["from"]["id"].as_i64().unwrap_or(0).to_string();
    let (id, choice) = data.split_once(':').unwrap_or_default();
    let answer = match choice {
        "once" => Some(Answer::Once),
        "always" => Some(Answer::Always),
        "deny" => Some(Answer::Deny),
        _ => None,
    };
    // Only the user who was asked can answer (in a group, not whoever else is in it).
    let pressed = match answer {
        Some(answer) => runtime.conversations.press(id, &from, answer),
        None => Pressed::Expired,
    };
    let note = match pressed {
        Pressed::Done(note) => note,
        Pressed::NotYours | Pressed::Expired => "This question has expired",
    };
    let _ = bot
        .call("answerCallbackQuery", json!({ "callback_query_id": query["id"], "text": note }), Duration::from_secs(10))
        .await;
    // The question shows what became of it (not when someone else pressed it).
    if pressed != Pressed::NotYours
        && let (Some(chat), Some(message)) =
            (query["message"]["chat"]["id"].as_i64(), query["message"]["message_id"].as_i64())
    {
        let text = format!("{}\n→ {note}", query["message"]["text"].as_str().unwrap_or_default());
        let _ = bot
            .call(
                "editMessageText",
                json!({ "chat_id": chat, "message_id": message, "text": cut_line(&text) }),
                Duration::from_secs(10),
            )
            .await;
    }
}

async fn handle(
    bot: &Bot,
    bots: &Bots,
    runtime: &Arc<Runtime>,
    channel: &Arc<dyn Transport>,
    message: &Value,
) -> Result<(), String> {
    let kind = message["chat"]["type"].as_str().unwrap_or_default();
    let group = matches!(kind, "group" | "supergroup");
    if kind != "private" && !group {
        return Ok(());
    }
    let chat_id = message["chat"]["id"].as_i64().ok_or("a message without a chat")?;
    let user = crate::pairing::User {
        id: message["from"]["id"].as_i64().ok_or("a message without a sender")?.to_string(),
        name: [
            message["from"]["username"].as_str().map(|u| format!("@{u}")),
            message["from"]["first_name"].as_str().map(str::to_owned),
        ]
        .into_iter()
        .flatten()
        .next()
        .unwrap_or_default(),
    };
    // In a group: only allowed users, and only messages for this bot (an @mention, a reply to
    // it, or a command); strangers there get no pairing code.
    let mention = format!("@{}", bots.username);
    let raw = message["text"].as_str().or(message["caption"].as_str()).unwrap_or_default();
    if group {
        if !crate::pairing::allows(&runtime.home, "telegram", &user.id)? {
            return Ok(());
        }
        let replied = message["reply_to_message"]["from"]["username"].as_str() == Some(bots.username.as_str());
        if !(raw.contains(&mention) || replied || raw.starts_with('/')) {
            return Ok(());
        }
    }
    // A voice note, or an audio file.
    let voice =
        ["voice", "audio"].iter().find_map(|k| message.get(*k).filter(|v| v["file_id"].is_string())).or_else(|| {
            message.get("document").filter(|d| {
                crate::voice::is_audio(d["mime_type"].as_str().unwrap_or(""), d["file_name"].as_str().unwrap_or(""))
            })
        });
    let audio = voice.map(|v| {
        let (bot, id) = (bot.clone(), v["file_id"].as_str().unwrap_or_default().to_owned());
        let mime = v["mime_type"].as_str().unwrap_or("audio/ogg").to_owned();
        Box::pin(async move { bot.file(&id, &mime).await }) as BoxFuture<'static, _>
    });
    let incoming = Incoming {
        chat: chat_id.to_string(),
        place: if group { format!("telegram-g{}", chat_id.unsigned_abs()) } else { format!("telegram-{chat_id}") },
        user,
        text: raw.replace(&mention, ""),
        direct: !group,
        audio,
    };
    crate::channel::handle(runtime, channel, incoming).await
}

/// `/actions`: the newest entries of the action log.
pub fn actions_command(home: &Path) -> String {
    let entries = crate::actions::ActionLog::new(home).read(0, 12);
    if entries.is_empty() {
        return "Nothing run yet.".to_owned();
    }
    entries
        .iter()
        .map(|e| {
            let at = crate::cron::local(e.at as i64).format("%d %b %H:%M");
            let verdict = match (e.ran, e.by.as_str()) {
                (true, "policy") => "✓ rules".to_owned(),
                (true, "grant") => "✓ always".to_owned(),
                (true, by) => format!("✓ {by}"),
                (false, "unattended") => "✗ no one to ask".to_owned(),
                (false, by) => format!("✗ {by}"),
            };
            format!("{at}  {verdict}  {}", cut_line(&e.action))
        })
        .collect::<Vec<_>>()
        .join("\n")
}

/// `/board`, `/board answer <id> <text>`.
pub fn board_command(home: &Path, args: &str) -> String {
    if let Some(rest) = args.strip_prefix("answer") {
        let Some((id, answer)) = rest.trim().split_once(' ') else {
            return "/board answer <id> <your answer>, for example: /board answer b2 Markdown, please".to_owned();
        };
        let answered = crate::board::Board::load(home).and_then(|mut board| {
            board.answer(id, answer)?;
            board.save(home)
        });
        return match answered {
            Ok(()) => format!("Thanks: {id} goes on with that."),
            Err(e) => format!("✗ {e}"),
        };
    }
    crate::board::Board::load(home).map_or_else(|e| format!("✗ {e}"), |b| cut_line(&b.listing()))
}

/// `/skills`, `/skills show <name>`, `/skills accept <name>`, `/skills reject <name>`.
pub fn skills_command(home: &Path, args: &str) -> String {
    let (verb, name) = args.split_once(' ').map_or((args, ""), |(v, n)| (v, n.trim()));
    match verb {
        "accept" => match crate::skills::accept(home, name) {
            Ok(()) => format!("Kept {name}: I use it from now on."),
            Err(e) => format!("✗ {e}"),
        },
        "reject" => match crate::skills::reject(home, name) {
            Ok(true) => format!("Threw {name} away."),
            Ok(false) => format!("There is no proposed skill {name:?}."),
            Err(e) => format!("✗ {e}"),
        },
        "show" => {
            let path = home.join("skills/proposed").join(format!("{name}.md"));
            match (crate::skills::valid(name), std::fs::read_to_string(&path)) {
                (true, Ok(text)) => cut_line(&text),
                _ => crate::skills::read(home, name).unwrap_or_else(|e| format!("✗ {e}")),
            }
        }
        _ => {
            let mut lines: Vec<String> =
                crate::skills::list(home).iter().map(|s| format!("{}: {}", s.name, s.description)).collect();
            if lines.is_empty() {
                lines.push("No skills yet: put Markdown how-to notes in ~/.autobot/skills on the machine.".to_owned());
            }
            let proposed = crate::skills::proposals(home);
            if !proposed.is_empty() {
                lines.push("\nProposed by me (/skills show <name>, then /skills accept <name> or reject):".to_owned());
                lines.extend(proposed.iter().map(|s| format!("{}: {}", s.name, s.description)));
            }
            lines.join("\n")
        }
    }
}

/// `/memory`, `/memory forget <id>`.
pub fn memory_command(home: &Path, args: &str) -> String {
    let memory = crate::memory::Memory::new(home);
    if let Some(id) = args.strip_prefix("forget") {
        return match id.trim().trim_start_matches('#').parse::<u64>() {
            Ok(id) => match memory.forget(id) {
                Ok(true) => format!("Forgot #{id}."),
                Ok(false) => format!("There is no #{id}."),
                Err(e) => format!("✗ {e}"),
            },
            Err(_) => "/memory forget <id>, for example /memory forget 3".to_owned(),
        };
    }
    let facts = memory.list();
    if facts.is_empty() {
        return "Nothing remembered yet.".to_owned();
    }
    facts.iter().map(|f| format!("#{} {}", f.id, f.text)).collect::<Vec<_>>().join("\n")
}

/// `/cron`, `/cron add <when> | <task>`, `/cron rm <id>` from a Telegram chat: tasks added here
/// report back here.
pub fn cron_command(home: &Path, args: &str, chat_id: i64) -> String {
    crate::channel::cron_command(home, args, "telegram", &chat_id.to_string())
}

#[cfg(test)]
mod tests {
    use super::{MESSAGE_LIMIT, User, Users, cron_command, new_code, split};

    #[test]
    fn cron_from_the_chat() {
        let home = std::env::temp_dir().join(format!("autobot-tg-cron-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&home);
        assert!(cron_command(&home, "", 7).starts_with("No scheduled tasks"));
        assert!(cron_command(&home, "add every 2h", 7).starts_with("✗ /cron add"));
        assert!(cron_command(&home, "add 0 99 * * * | x", 7).starts_with("✗"));
        assert!(cron_command(&home, "add every 2h | check the backups", 7).starts_with("Added t1"));
        assert!(cron_command(&home, "", 7).starts_with("t1 [every 2h] check the backups"));
        assert!(crate::cron::Schedules::load(&home).unwrap().schedules[0].notify == Some(7));
        assert_eq!(cron_command(&home, "rm t1", 7), "Removed t1.");
        assert!(cron_command(&home, "rm t1", 7).starts_with("✗"));
        // From another platform: the answer goes back by address.
        assert!(crate::channel::cron_command(&home, "add every 2h | x", "slack", "C1/171.2").starts_with("Added t1"));
        let s = &crate::cron::Schedules::load(&home).unwrap().schedules[0];
        assert_eq!((s.notify, s.to.clone()), (None, vec!["slack:C1/171.2".to_owned()]));
        std::fs::remove_dir_all(home).unwrap();
    }

    #[test]
    fn codes_pair_once() {
        let mut users = Users::default();
        let alice = User { id: 7, name: "@alice".into() };
        let code = users.code_for(&alice).unwrap();
        assert_eq!(code.len(), 9);
        assert_eq!(users.code_for(&alice).unwrap(), code, "the same code until it expires");
        assert!(users.approve("WRONG-CODE").is_err());
        assert_eq!(users.approve(&code.to_lowercase().replace('-', " ")).unwrap().id, 7);
        assert!(users.allows(7));
        assert!(users.approve(&code).is_err(), "single use");
        assert!(users.revoke(7));
        assert!(!users.allows(7));
    }

    #[test]
    fn pending_codes_are_bounded() {
        let mut users = Users::default();
        for id in 0..50 {
            users.code_for(&User { id, name: String::new() }).unwrap();
        }
        assert_eq!(users.pending.len(), 10);
        assert!(new_code().unwrap().chars().all(|c| c == '-' || !"01OIL".contains(c)));
    }

    #[test]
    fn long_answers_are_split() {
        assert_eq!(split("hi"), vec!["hi"]);
        let long = format!("{}\n{}", "a".repeat(3000), "b".repeat(3000));
        let parts = split(&long);
        assert_eq!(parts, vec!["a".repeat(3000), "b".repeat(3000)]);
        let parts = split(&"é".repeat(MESSAGE_LIMIT * 2 + 1));
        assert_eq!(parts.len(), 3);
        assert!(parts.iter().all(|p| p.chars().count() <= MESSAGE_LIMIT));
    }
}
