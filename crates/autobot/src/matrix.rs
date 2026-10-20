//! Matrix, through the client-server API: the bot long-polls `/sync`, so it needs no public
//! address. It answers direct rooms (two members), and in larger rooms the messages that
//! mention it; it joins rooms it is invited to directly. Approvals by replying; progress is one
//! message, edited (`m.replace`); answers carry HTML; voice messages (`m.audio`) are transcribed.
//!
//! ```toml
//! [matrix]
//! enabled = true
//! homeserver = "https://matrix.example.org"
//! # access token in $AUTOBOT_HOME/matrix.token (or token_file)
//! ```
//!
//! Encrypted rooms are not read: the bot says so once and answers only unencrypted rooms.

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde::Deserialize;
use serde_json::{Value, json};

use crate::bots::Runtime;
use crate::channel::{Asking, BoxFuture, Incoming, Progress, Question, Transport};

const MESSAGE_LIMIT: usize = 16_000;

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct MatrixConfig {
    #[serde(default)]
    pub enabled: bool,
    #[serde(default)]
    pub homeserver: String,
    /// The access token [default: `$AUTOBOT_HOME/matrix.token`].
    #[serde(default)]
    pub token_file: Option<PathBuf>,
}

impl MatrixConfig {
    pub fn token(&self, home: &Path) -> Result<String, String> {
        let path = self.token_file.as_deref().map(crate::config::expand).unwrap_or_else(|| home.join("matrix.token"));
        let path = if path.is_absolute() { path } else { home.join(path) };
        let token = std::fs::read_to_string(&path).map_err(|e| format!("the Matrix token {}: {e}", path.display()))?;
        let token = token.trim();
        if token.is_empty() {
            return Err(format!("{} is empty", path.display()));
        }
        Ok(token.to_owned())
    }
}

#[derive(Clone)]
pub struct Client {
    http: reqwest::Client,
    base: String,
    token: String,
    txn: Arc<AtomicU64>,
}

fn escape(segment: &str) -> String {
    segment
        .bytes()
        .map(|b| {
            if b.is_ascii_alphanumeric() || b"-_.~".contains(&b) {
                (b as char).to_string()
            } else {
                format!("%{b:02X}")
            }
        })
        .collect()
}

impl Client {
    pub fn new(http: reqwest::Client, homeserver: &str, token: &str) -> Result<Self, String> {
        invincible::egress::check(homeserver)?;
        let started =
            std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.as_millis() as u64);
        Ok(Self {
            http,
            base: homeserver.trim_end_matches('/').to_owned(),
            token: token.to_owned(),
            txn: Arc::new(AtomicU64::new(started)),
        })
    }

    async fn call(
        &self,
        method: reqwest::Method,
        path: &str,
        body: Option<Value>,
        timeout: Duration,
    ) -> Result<Value, String> {
        let mut request =
            self.http.request(method, format!("{}{path}", self.base)).bearer_auth(&self.token).timeout(timeout);
        if let Some(body) = body {
            request = request.json(&body);
        }
        let response = request.send().await.map_err(|e| format!("Matrix: {}", e.without_url()))?;
        let status = response.status();
        let value: Value = response.json().await.unwrap_or_default();
        if !status.is_success() {
            return Err(format!("Matrix: {}", value["error"].as_str().unwrap_or(status.as_str())));
        }
        Ok(value)
    }

    pub async fn me(&self) -> Result<String, String> {
        let reply =
            self.call(reqwest::Method::GET, "/_matrix/client/v3/account/whoami", None, Duration::from_secs(20)).await?;
        reply["user_id"].as_str().map(str::to_owned).ok_or_else(|| "Matrix gave no user id".to_owned())
    }

    async fn sync(&self, since: Option<&str>, wait: u64) -> Result<Value, String> {
        let filter = json!({ "room": { "timeline": { "limit": 50 }, "state": { "lazy_load_members": true } }, "presence": { "types": [] } });
        let mut path = format!("/_matrix/client/v3/sync?timeout={wait}&filter={}", escape(&filter.to_string()));
        if let Some(since) = since {
            path.push_str(&format!("&since={}", escape(since)));
        }
        self.call(reqwest::Method::GET, &path, None, Duration::from_millis(wait + 30_000)).await
    }

    async fn join(&self, room: &str) -> Result<(), String> {
        self.call(
            reqwest::Method::POST,
            &format!("/_matrix/client/v3/join/{}", escape(room)),
            Some(json!({})),
            Duration::from_secs(20),
        )
        .await
        .map(drop)
    }

    async fn send_event(&self, room: &str, content: Value) -> Result<Option<String>, String> {
        let txn = self.txn.fetch_add(1, Ordering::Relaxed);
        let path = format!("/_matrix/client/v3/rooms/{}/send/m.room.message/autobot{txn}", escape(room));
        let reply = self.call(reqwest::Method::PUT, &path, Some(content), Duration::from_secs(20)).await?;
        Ok(reply["event_id"].as_str().map(str::to_owned))
    }

    async fn download(&self, url: &str, mime: &str, name: &str) -> Result<crate::voice::Audio, String> {
        let rest = url.strip_prefix("mxc://").ok_or("not a Matrix media address")?;
        let (server, id) = rest.split_once('/').ok_or("not a Matrix media address")?;
        let path = format!("{}/_matrix/client/v1/media/download/{}/{}", self.base, escape(server), escape(id));
        crate::voice::download(&self.http, &path, Some(&format!("Bearer {}", self.token)), mime, name).await
    }
}

/// Matrix as [crate::channel] sees it.
struct Channel {
    client: Client,
    me: String,
}

impl Transport for Channel {
    fn platform(&self) -> &'static str {
        "matrix"
    }

    fn limit(&self) -> usize {
        MESSAGE_LIMIT
    }

    fn progress(&self) -> Progress {
        Progress::Edited
    }

    fn asking(&self) -> Asking {
        Asking::Reply
    }

    fn send<'a>(&'a self, chat: &'a str, text: &'a str) -> BoxFuture<'a, Result<Option<String>, String>> {
        Box::pin(async move { self.client.send_event(chat, json!({ "msgtype": "m.notice", "body": text })).await })
    }

    fn answer<'a>(&'a self, chat: &'a str, markdown: &'a str) -> BoxFuture<'a, Result<(), String>> {
        Box::pin(async move {
            for part in crate::markdown::split(markdown, MESSAGE_LIMIT) {
                let content = json!({
                    "msgtype": "m.text",
                    "body": crate::markdown::to_plain(&part),
                    "format": "org.matrix.custom.html",
                    "formatted_body": crate::markdown::to_html(&part).replace('\n', "<br>"),
                });
                self.client.send_event(chat, content).await?;
            }
            Ok(())
        })
    }

    fn edit<'a>(&'a self, chat: &'a str, id: &'a str, text: &'a str) -> BoxFuture<'a, Result<(), String>> {
        Box::pin(async move {
            let content = json!({
                "msgtype": "m.notice",
                "body": format!("* {text}"),
                "m.new_content": { "msgtype": "m.notice", "body": text },
                "m.relates_to": { "rel_type": "m.replace", "event_id": id },
            });
            self.client.send_event(chat, content).await.map(drop)
        })
    }

    fn typing<'a>(&'a self, chat: &'a str) -> BoxFuture<'a, ()> {
        Box::pin(async move {
            let path = format!("/_matrix/client/v3/rooms/{}/typing/{}", escape(chat), escape(&self.me));
            let _ = self
                .client
                .call(
                    reqwest::Method::PUT,
                    &path,
                    Some(json!({ "typing": true, "timeout": 8000 })),
                    Duration::from_secs(10),
                )
                .await;
        })
    }

    fn ask<'a>(&'a self, chat: &'a str, question: &'a Question) -> BoxFuture<'a, Result<(), String>> {
        Box::pin(async move {
            let text = format!(
                "{}\n\nReply yes, always (for this room) or no; or \"no, …\" with what to do instead. (code {})",
                question.text, question.code
            );
            self.client.send_event(chat, json!({ "msgtype": "m.text", "body": text })).await.map(drop)
        })
    }
}

/// The Matrix channel of [runtime], as its config says: off (Err) when it cannot start.
pub async fn run(runtime: Arc<Runtime>) -> Result<(), String> {
    let config = &runtime.config.matrix;
    if config.homeserver.trim().is_empty() {
        return Err("[matrix] homeserver is missing".to_owned());
    }
    let network = crate::network()?;
    let local = reqwest::Url::parse(&config.homeserver)
        .ok()
        .and_then(|u| u.host_str().map(crate::net::loopback))
        .unwrap_or(false);
    let http = if local {
        reqwest::Client::new()
    } else {
        invincible::egress::client(&network).map_err(|e| format!("Matrix needs the network: {e}"))?
    };
    let client = Client::new(http, &config.homeserver, &config.token(&runtime.home)?)?;
    serve(client, runtime).await
}

/// Answers [runtime]'s Matrix rooms through [client] until the process stops; Err when the
/// token does not work.
pub async fn serve(client: Client, runtime: Arc<Runtime>) -> Result<(), String> {
    let me = client.me().await?;
    tracing::info!(bot = %runtime.name, "Matrix answering as {me}");
    let channel = Arc::new(Channel { client: client.clone(), me: me.clone() });
    let transport: Arc<dyn Transport> = channel.clone();
    runtime.register(transport.clone());
    runtime.channel_account("matrix", &me);
    // What came before the bot started is not answered: the first sync only says where it is.
    let mut since: Option<String> = None;
    let mut first = true;
    let members: Mutex<HashMap<String, u64>> = Mutex::default();
    let mut told_encrypted: HashSet<String> = HashSet::new();
    let mut backoff = Duration::from_secs(1);
    loop {
        let reply = match client.sync(since.as_deref(), if first { 0 } else { 30_000 }).await {
            Ok(reply) => {
                backoff = Duration::from_secs(1);
                runtime.channel_state("matrix", "connected");
                reply
            }
            Err(e) => {
                tracing::warn!(bot = %runtime.name, "matrix: {e}; again in {}s", backoff.as_secs());
                runtime.channel_state("matrix", &format!("retrying: {e}"));
                tokio::time::sleep(backoff).await;
                backoff = (backoff * 2).min(Duration::from_secs(60));
                continue;
            }
        };
        since = reply["next_batch"].as_str().map(str::to_owned).or(since);
        // Invitations to a direct room: joined (a stranger then gets a pairing code there).
        for (room, invite) in reply["rooms"]["invite"].as_object().into_iter().flatten() {
            let direct = invite["invite_state"]["events"].as_array().into_iter().flatten().any(|e| {
                e["type"] == "m.room.member" && e["state_key"] == me.as_str() && e["content"]["is_direct"] == true
            });
            if direct && let Err(e) = client.join(room).await {
                tracing::warn!(bot = %runtime.name, "matrix: joining {room}: {e}");
            }
        }
        for (room, joined) in reply["rooms"]["join"].as_object().into_iter().flatten() {
            if let Some(count) = joined["summary"]["m.joined_member_count"].as_u64() {
                members.lock().expect("members").insert(room.clone(), count);
            }
            if first {
                continue;
            }
            let count = members.lock().expect("members").get(room).copied().unwrap_or(2);
            for event in joined["timeline"]["events"].as_array().into_iter().flatten() {
                if event["sender"] == me.as_str() {
                    continue;
                }
                if event["type"] == "m.room.encrypted" {
                    if told_encrypted.insert(room.clone()) {
                        let _ =
                            transport.send(room, "This room is encrypted, and I read only unencrypted rooms.").await;
                    }
                    continue;
                }
                let Some(incoming) = message(&client, &me, room, count, event) else { continue };
                let (runtime, transport) = (runtime.clone(), transport.clone());
                tokio::spawn(async move {
                    if let Err(e) = crate::channel::handle(&runtime, &transport, incoming).await {
                        tracing::warn!(bot = %runtime.name, "matrix: {e}");
                    }
                });
            }
        }
        first = false;
    }
}

/// A room event as a message for the bot: in a direct room (two members) any message, in a
/// larger one only those that mention it.
pub fn message(client: &Client, me: &str, room: &str, members: u64, event: &Value) -> Option<Incoming> {
    if event["type"] != "m.room.message" || event["content"]["m.relates_to"]["rel_type"] == "m.replace" {
        return None;
    }
    let sender = event["sender"].as_str()?;
    let content = &event["content"];
    let body = content["body"].as_str().unwrap_or_default();
    let direct = members <= 2;
    let local = me.trim_start_matches('@').split(':').next().unwrap_or(me);
    let mentioned = body.contains(me)
        || body.to_lowercase().starts_with(&local.to_lowercase())
        || content["m.mentions"]["user_ids"].as_array().is_some_and(|ids| ids.iter().any(|i| i == me));
    if !direct && !mentioned {
        return None;
    }
    let (text, audio) = match content["msgtype"].as_str() {
        Some("m.text" | "m.notice" | "m.emote") => {
            (body.replace(me, "").trim_start_matches([':', ',', ' ']).to_owned(), None)
        }
        Some("m.audio") => {
            let (client, url) = (client.clone(), content["url"].as_str().unwrap_or_default().to_owned());
            let mime = content["info"]["mimetype"].as_str().unwrap_or("audio/ogg").to_owned();
            let name = body.to_owned();
            (
                String::new(),
                Some(Box::pin(async move { client.download(&url, &mime, &name).await }) as BoxFuture<'static, _>),
            )
        }
        _ => return None,
    };
    Some(Incoming {
        chat: room.to_owned(),
        place: format!("matrix-{room}"),
        user: crate::pairing::User { id: sender.to_owned(), name: sender.to_owned() },
        text,
        direct,
        audio,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn room_events() {
        let client = Client::new(reqwest::Client::new(), "http://127.0.0.1:8008", "t").unwrap();
        let me = "@bot:x.org";
        let text = json!({ "type": "m.room.message", "sender": "@ann:x.org", "content": { "msgtype": "m.text", "body": "hi" } });
        let incoming = message(&client, me, "!r:x.org", 2, &text).unwrap();
        assert_eq!((incoming.chat.as_str(), incoming.text.as_str(), incoming.direct), ("!r:x.org", "hi", true));
        assert!(message(&client, me, "!r:x.org", 5, &text).is_none(), "a group, not mentioned");
        let mention = json!({ "type": "m.room.message", "sender": "@ann:x.org", "content": { "msgtype": "m.text", "body": "@bot:x.org: status?" } });
        assert_eq!(message(&client, me, "!r:x.org", 5, &mention).unwrap().text, "status?");
        let edit = json!({ "type": "m.room.message", "sender": "@ann:x.org", "content": { "msgtype": "m.text", "body": "x", "m.relates_to": { "rel_type": "m.replace" } } });
        assert!(message(&client, me, "!r:x.org", 2, &edit).is_none());
        let voice = json!({ "type": "m.room.message", "sender": "@ann:x.org", "content": { "msgtype": "m.audio", "body": "v.ogg", "url": "mxc://x.org/abc" } });
        assert!(message(&client, me, "!r:x.org", 2, &voice).unwrap().audio.is_some());
        assert_eq!(escape("!r:x.org"), "%21r%3Ax.org");
    }
}
