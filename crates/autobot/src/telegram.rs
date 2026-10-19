//! Telegram: the agent answers its owner's direct messages through a bot.
//!
//! - Long polling, so the machine needs no public address or webhook.
//! - The Bot API is reached under Invincible Gateway's network mode (`[node] network`): direct,
//!   Tor or SOCKS5, and never when the gateway is offline.
//! - Private chats only. A stranger gets a one-time code; nobody gets in until the owner runs
//!   `autobot telegram approve <code>` on the machine (Hermes-style DM pairing).
//! - Approvals arrive as buttons in the chat.
//!
//! Telegram's servers see bot messages: chats with bots are not end-to-end encrypted. The private
//! channel is the Autobot app, paired over Noise.

use std::collections::{HashMap, HashSet};
use std::future::Future;
use std::path::{Path, PathBuf};
use std::pin::Pin;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use tokio::sync::oneshot;

use crate::agent::{Agent, Event};
use crate::approval::{Action, Answer, Approver};
use crate::session::Session;

/// Telegram's limit for one message.
const MESSAGE_LIMIT: usize = 4000;
/// How long a pairing code works.
const CODE_LIFETIME: u64 = 60 * 60;
/// How long an approval waits for a tap.
const APPROVAL_WAIT: Duration = Duration::from_secs(10 * 60);

#[derive(Clone)]
pub struct Bot {
    client: reqwest::Client,
    base: String,
}

impl Bot {
    pub fn new(client: reqwest::Client, api: &str, token: &str) -> Result<Self, String> {
        invincible::egress::check(api)?;
        Ok(Self { client, base: format!("{}/bot{token}", api.trim_end_matches('/')) })
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

fn now() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or_default()
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
        let now = now();
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
        let now = now();
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

/// 8 characters from an alphabet without look-alikes (no 0/O, 1/I/L), shown as `ABCD-EFGH`.
fn new_code() -> Result<String, String> {
    const ALPHABET: &[u8] = b"ABCDEFGHJKMNPQRSTUVWXYZ23456789";
    let bytes = invincible::token::random::<8>()?;
    let chars: String = bytes.iter().map(|b| ALPHABET[*b as usize % ALPHABET.len()] as char).collect();
    Ok(format!("{}-{}", &chars[..4], &chars[4..]))
}

fn normalize(code: &str) -> String {
    code.chars().filter(char::is_ascii_alphanumeric).map(|c| c.to_ascii_uppercase()).collect()
}

/// A conversation with one allowed user.
struct Chat {
    session: Session,
    grants: HashSet<Action>,
}

/// Approvals waiting for a button, by number.
type Waiting = Arc<Mutex<HashMap<u64, (i64, oneshot::Sender<Answer>)>>>;

struct ChatApprover {
    bot: Bot,
    chat: i64,
    waiting: Waiting,
}

impl Approver for ChatApprover {
    fn channel(&self) -> &'static str {
        "telegram"
    }

    fn approve<'a>(&'a self, action: &'a Action) -> Pin<Box<dyn Future<Output = Answer> + Send + 'a>> {
        Box::pin(async move {
            let id = u64::from_le_bytes(invincible::token::random::<8>().unwrap_or_default());
            let (tx, rx) = oneshot::channel();
            self.waiting.lock().expect("waiting").insert(id, (self.chat, tx));
            let keyboard = json!({ "inline_keyboard": [[
                { "text": "Allow", "callback_data": format!("{id}:once") },
                { "text": "Always (this chat)", "callback_data": format!("{id}:always") },
                { "text": "Deny", "callback_data": format!("{id}:deny") },
            ]]});
            let text = format!("Approve? {}", action.describe());
            let body = json!({ "chat_id": self.chat, "text": cut_line(&text), "reply_markup": keyboard });
            if self.bot.call("sendMessage", body, Duration::from_secs(20)).await.is_err() {
                self.waiting.lock().expect("waiting").remove(&id);
                return Answer::Deny;
            }
            let answer = tokio::time::timeout(APPROVAL_WAIT, rx).await.ok().and_then(Result::ok);
            self.waiting.lock().expect("waiting").remove(&id);
            answer.unwrap_or(Answer::Deny)
        })
    }
}

fn cut_line(text: &str) -> String {
    if text.chars().count() <= MESSAGE_LIMIT {
        text.to_owned()
    } else {
        text.chars().take(MESSAGE_LIMIT).collect::<String>() + "…"
    }
}

/// Answers messages until the process stops.
pub async fn serve(bot: Bot, agent: Arc<Agent>, home: PathBuf) {
    let chats: Arc<Mutex<HashMap<i64, Arc<tokio::sync::Mutex<Chat>>>>> = Arc::default();
    let waiting: Waiting = Arc::default();
    let mut offset = 0;
    let mut backoff = Duration::from_secs(1);
    loop {
        let updates = match bot.updates(offset).await {
            Ok(updates) => {
                backoff = Duration::from_secs(1);
                updates
            }
            Err(e) => {
                tracing::warn!("{e}; retrying in {}s", backoff.as_secs());
                tokio::time::sleep(backoff).await;
                backoff = (backoff * 2).min(Duration::from_secs(60));
                continue;
            }
        };
        for update in updates {
            offset = offset.max(update["update_id"].as_i64().unwrap_or(0) + 1);
            if let Some(query) = update.get("callback_query") {
                answer_button(&bot, query, &waiting).await;
            } else if let Some(message) = update.get("message") {
                let (bot, agent, home, chats, waiting) =
                    (bot.clone(), agent.clone(), home.clone(), chats.clone(), waiting.clone());
                let message = message.clone();
                tokio::spawn(async move {
                    if let Err(e) = handle(&bot, &agent, &home, &chats, &waiting, &message).await {
                        tracing::warn!("telegram: {e}");
                    }
                });
            }
        }
    }
}

async fn answer_button(bot: &Bot, query: &Value, waiting: &Waiting) {
    let data = query["data"].as_str().unwrap_or_default();
    let from = query["from"]["id"].as_i64().unwrap_or(0);
    let (id, choice) = data.split_once(':').unwrap_or_default();
    let answer = match choice {
        "once" => Some(Answer::Once),
        "always" => Some(Answer::Always),
        "deny" => Some(Answer::Deny),
        _ => None,
    };
    // Only the chat the question went to can answer it (private chats: chat id = user id).
    let sender = id.parse::<u64>().ok().and_then(|id| {
        let mut waiting = waiting.lock().expect("waiting");
        match waiting.get(&id) {
            Some((chat, _)) if *chat == from => waiting.remove(&id).map(|(_, tx)| tx),
            _ => None,
        }
    });
    let note = match (sender, answer) {
        (Some(tx), Some(answer)) => {
            let _ = tx.send(answer);
            match answer {
                Answer::Once => "Allowed",
                Answer::Always => "Allowed for this chat",
                Answer::Deny => "Denied",
            }
        }
        _ => "This question has expired",
    };
    let _ = bot
        .call("answerCallbackQuery", json!({ "callback_query_id": query["id"], "text": note }), Duration::from_secs(10))
        .await;
    if let (Some(chat), Some(message)) =
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
    agent: &Arc<Agent>,
    home: &Path,
    chats: &Mutex<HashMap<i64, Arc<tokio::sync::Mutex<Chat>>>>,
    waiting: &Waiting,
    message: &Value,
) -> Result<(), String> {
    if message["chat"]["type"] != "private" {
        return Ok(());
    }
    let chat_id = message["chat"]["id"].as_i64().ok_or("a message without a chat")?;
    let user = User {
        id: message["from"]["id"].as_i64().ok_or("a message without a sender")?,
        name: [
            message["from"]["username"].as_str().map(|u| format!("@{u}")),
            message["from"]["first_name"].as_str().map(str::to_owned),
        ]
        .into_iter()
        .flatten()
        .next()
        .unwrap_or_default(),
    };
    let mut users = Users::load(home)?;
    if !users.allows(user.id) {
        let code = users.code_for(&user)?;
        users.save(home)?;
        tracing::info!(user = user.id, name = %user.name, "telegram: pairing code {code} issued");
        bot.send(
            chat_id,
            &format!(
                "This agent is private. To let this account in, its owner runs on the machine:\n\nautobot telegram approve {code}\n\nThe code works for {} minutes.",
                CODE_LIFETIME / 60
            ),
        )
        .await?;
        return Ok(());
    }
    let Some(text) = message["text"].as_str().map(str::trim).filter(|t| !t.is_empty()) else {
        bot.send(chat_id, "Only text messages for now.").await?;
        return Ok(());
    };
    let chat = {
        let mut chats = chats.lock().expect("chats");
        match chats.get(&chat_id) {
            Some(chat) => chat.clone(),
            None => {
                let session = Session::open(&home.join("sessions"), &format!("telegram-{}", chat_id.unsigned_abs()))?;
                let chat = Arc::new(tokio::sync::Mutex::new(Chat { session, grants: HashSet::new() }));
                chats.insert(chat_id, chat.clone());
                chat
            }
        }
    };
    let mut chat = chat.lock().await;
    match text.split_whitespace().next().unwrap_or_default() {
        "/start" | "/help" => {
            bot.send(
                chat_id,
                "Autobot here, running on your own machine. Send a task. /new starts a new conversation; /cron lists scheduled tasks (/cron add <when> | <task>, /cron rm <id>).",
            )
            .await?;
            return Ok(());
        }
        "/new" => {
            chat.session.reset()?;
            chat.grants.clear();
            bot.send(chat_id, "New conversation.").await?;
            return Ok(());
        }
        "/cron" => {
            bot.send(chat_id, &cron_command(home, text.trim_start_matches("/cron").trim())).await?;
            return Ok(());
        }
        _ => {}
    }

    // Tool progress goes out as short messages, in order, from one task.
    let (progress, mut lines) = tokio::sync::mpsc::unbounded_channel::<String>();
    let sender = {
        let bot = bot.clone();
        tokio::spawn(async move {
            while let Some(line) = lines.recv().await {
                let _ = bot.send(chat_id, &line).await;
            }
        })
    };
    let typing = {
        let bot = bot.clone();
        tokio::spawn(async move {
            loop {
                bot.typing(chat_id).await;
                tokio::time::sleep(Duration::from_secs(4)).await;
            }
        })
    };
    let last_route = Mutex::new(None::<String>);
    let events = |event: Event| match event {
        Event::Tool(what) => {
            let _ = progress.send(format!("› {}", cut_line(what)));
        }
        Event::Refused(why) => {
            let _ = progress.send(format!("✗ {}", cut_line(why)));
        }
        Event::Receipt { id, model, tier } => {
            *last_route.lock().expect("route") = Some(format!(
                "{} · {} · receipt {}",
                model.unwrap_or("?"),
                tier.unwrap_or("?"),
                &id[..id.len().min(8)]
            ));
        }
    };
    let approver = ChatApprover { bot: bot.clone(), chat: chat_id, waiting: waiting.clone() };
    let Chat { session, grants } = &mut *chat;
    let result = agent.turn(session, text, &approver, grants, &events).await;
    typing.abort();
    drop(progress);
    let _ = sender.await;
    let reply = match result {
        Ok(outcome) => match last_route.lock().expect("route").take() {
            Some(route) => format!("{}\n\n— {route}", outcome.text),
            None => outcome.text,
        },
        Err(e) => format!("✗ {e}"),
    };
    bot.send(chat_id, &reply).await?;
    Ok(())
}

/// `/cron`, `/cron add <when> | <task>`, `/cron rm <id>`. Tasks added here report back here.
pub fn cron_command(home: &Path, args: &str) -> String {
    let result = (|| -> Result<String, String> {
        if let Some(rest) = args.strip_prefix("add") {
            let (when, task) = rest.split_once('|').ok_or(
                "/cron add <when> | <task>, for example: /cron add 0 8 * * 1-5 | summarize the overnight logs",
            )?;
            let mut schedules = crate::cron::Schedules::load(home)?;
            let id = schedules.add(when, task, true)?;
            schedules.save(home)?;
            return Ok(format!("Added {id}. Answers come here. It runs with allowlisted commands only."));
        }
        if let Some(id) = args.strip_prefix("rm").map(str::trim) {
            let mut schedules = crate::cron::Schedules::load(home)?;
            if !schedules.remove(id) {
                return Err(format!("No scheduled task {id:?}."));
            }
            schedules.save(home)?;
            return Ok(format!("Removed {id}."));
        }
        let listing = crate::cron::listing(home)?;
        let lines: Vec<String> = listing["schedules"]
            .as_array()
            .into_iter()
            .flatten()
            .map(|s| {
                let next = s["next"]
                    .as_i64()
                    .map(|t| crate::cron::local(t).format("%a %H:%M").to_string())
                    .unwrap_or("-".into());
                format!(
                    "{} [{}] {} (next {next})",
                    s["id"].as_str().unwrap_or("?"),
                    s["when"].as_str().unwrap_or("?"),
                    s["task"].as_str().unwrap_or("")
                )
            })
            .collect();
        Ok(if lines.is_empty() { "No scheduled tasks. /cron add <when> | <task>".to_owned() } else { lines.join("\n") })
    })();
    result.unwrap_or_else(|e| format!("✗ {e}"))
}

#[cfg(test)]
mod tests {
    use super::{MESSAGE_LIMIT, User, Users, cron_command, new_code, split};

    #[test]
    fn cron_from_the_chat() {
        let home = std::env::temp_dir().join(format!("autobot-tg-cron-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&home);
        assert!(cron_command(&home, "").starts_with("No scheduled tasks"));
        assert!(cron_command(&home, "add every 2h").starts_with("✗ /cron add"));
        assert!(cron_command(&home, "add 0 99 * * * | x").starts_with("✗"));
        assert!(cron_command(&home, "add every 2h | check the backups").starts_with("Added t1"));
        assert!(cron_command(&home, "").starts_with("t1 [every 2h] check the backups"));
        assert!(crate::cron::Schedules::load(&home).unwrap().schedules[0].telegram);
        assert_eq!(cron_command(&home, "rm t1"), "Removed t1.");
        assert!(cron_command(&home, "rm t1").starts_with("✗"));
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
