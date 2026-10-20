//! WhatsApp, through Meta's WhatsApp Business Cloud API: messages come to a webhook on the hooks
//! listener, answers go out through the Graph API. Direct messages, approvals by reply buttons,
//! voice notes transcribed, speech and pictures the agent makes sent as audio and image messages
//! (MP3/OGG/AAC and PNG/JPEG; another type is left on the machine). Off unless turned on.
//!
//! ```toml
//! [whatsapp]
//! enabled = true
//! phone_number_id = "123456789012345"   # WhatsApp Manager → API setup (an id, not the number)
//!
//! [hooks]
//! listen = "127.0.0.1:7794"             # reached from the internet over HTTPS (a tunnel, a proxy)
//! ```
//!
//! Three secrets in the bot's directory, each in a file of its own (0600): `whatsapp.token` (a
//! system user's access token), `whatsapp-app.secret` (the Meta app's secret: every webhook call
//! is signed with it, `X-Hub-Signature-256`) and `whatsapp-verify.token` (any string; Meta sends
//! it back once when the webhook is added). The webhook's URL is
//! `https://<public host>/hooks/whatsapp` for the default bot, `/hooks/<bot>/whatsapp` for another.
//!
//! WhatsApp needs a public HTTPS URL, which no other channel here does: Meta calls the webhook
//! from outside. Run a tunnel (`cloudflared tunnel`, `tailscale funnel`) or a reverse proxy to the
//! hooks listener. Outside 24 hours of a person's last message, WhatsApp only takes template
//! messages: notices sent to a WhatsApp home channel then do not arrive.

use std::collections::{HashMap, VecDeque};
use std::path::{Path, PathBuf};
use std::sync::{Arc, LazyLock, Mutex};
use std::time::Duration;

use axum::http::{HeaderMap, Method, StatusCode};
use serde::Deserialize;
use serde_json::{Value, json};

use crate::approval::Answer;
use crate::bots::Runtime;
use crate::channel::{Asking, BoxFuture, Incoming, Progress, Question, Transport};

/// Characters per text message.
const MESSAGE_LIMIT: usize = 4096;
/// An interactive message's body.
const BUTTON_TEXT_LIMIT: usize = 1024;

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct WhatsAppConfig {
    #[serde(default)]
    pub enabled: bool,
    /// The business number's id in the Cloud API.
    #[serde(default)]
    pub phone_number_id: String,
    /// The Graph API [default: https://graph.facebook.com/v21.0].
    #[serde(default)]
    pub api: Option<String>,
}

impl WhatsAppConfig {
    pub fn api(&self) -> String {
        self.api
            .clone()
            .unwrap_or_else(|| "https://graph.facebook.com/v21.0".to_owned())
            .trim_end_matches('/')
            .to_owned()
    }

    /// The access token (`whatsapp.token`).
    pub fn access_token(&self, home: &Path) -> Result<String, String> {
        secret(&home.join("whatsapp.token"), "the WhatsApp access token")
    }

    /// The Meta app's secret, which signs every webhook call (`whatsapp-app.secret`).
    pub fn app_secret(&self, home: &Path) -> Result<String, String> {
        secret(&home.join("whatsapp-app.secret"), "the WhatsApp app secret")
    }

    /// What Meta sends back when the webhook is added (`whatsapp-verify.token`).
    pub fn verify_token(&self, home: &Path) -> Result<String, String> {
        secret(&home.join("whatsapp-verify.token"), "the WhatsApp verify token")
    }

    /// The three secrets' files.
    pub fn files(home: &Path) -> [PathBuf; 3] {
        [home.join("whatsapp.token"), home.join("whatsapp-app.secret"), home.join("whatsapp-verify.token")]
    }
}

fn secret(path: &Path, what: &str) -> Result<String, String> {
    let text = std::fs::read_to_string(path).map_err(|e| format!("{what} {}: {e}", path.display()))?;
    let text = text.trim();
    if text.is_empty() {
        return Err(format!("{} is empty", path.display()));
    }
    Ok(text.to_owned())
}

/// The Cloud API for one business number.
#[derive(Clone)]
pub struct Client {
    http: reqwest::Client,
    api: String,
    phone: String,
    token: String,
}

impl Client {
    pub fn new(http: reqwest::Client, api: &str, phone_number_id: &str, token: &str) -> Result<Self, String> {
        let url = reqwest::Url::parse(api).map_err(|e| format!("[whatsapp] api: {e}"))?;
        if url.scheme() != "https" && !url.host_str().is_some_and(crate::net::loopback) {
            return Err("[whatsapp] api: https only".to_owned());
        }
        let phone = phone_number_id.trim();
        if phone.is_empty() || !phone.chars().all(|c| c.is_ascii_digit()) {
            return Err("[whatsapp] phone_number_id: the number's id (digits), from WhatsApp Manager".to_owned());
        }
        Ok(Self { http, api: api.trim_end_matches('/').to_owned(), phone: phone.to_owned(), token: token.to_owned() })
    }

    async fn json(&self, request: reqwest::RequestBuilder, what: &str) -> Result<Value, String> {
        let reply = request
            .bearer_auth(&self.token)
            .timeout(Duration::from_secs(30))
            .send()
            .await
            .map_err(|e| format!("WhatsApp {what}: {e}"))?;
        let status = reply.status();
        let body: Value = reply.json().await.unwrap_or_default();
        if !status.is_success() {
            let message = body["error"]["message"].as_str().unwrap_or("failed");
            return Err(format!("WhatsApp {what}: {status}: {message}"));
        }
        Ok(body)
    }

    async fn message(&self, body: Value) -> Result<Option<String>, String> {
        let url = format!("{}/{}/messages", self.api, self.phone);
        let reply = self.json(self.http.post(url).json(&body), "send").await?;
        Ok(reply["messages"][0]["id"].as_str().map(str::to_owned))
    }

    /// A text message to [to] (a WhatsApp id: the number, digits only); its id.
    pub async fn send(&self, to: &str, text: &str) -> Result<Option<String>, String> {
        self.message(json!({
            "messaging_product": "whatsapp",
            "recipient_type": "individual",
            "to": to,
            "type": "text",
            "text": { "body": text, "preview_url": false },
        }))
        .await
    }

    /// [text] with up to three reply buttons: (id, title).
    pub async fn buttons(&self, to: &str, text: &str, buttons: &[(String, &str)]) -> Result<Option<String>, String> {
        let buttons: Vec<Value> = buttons
            .iter()
            .take(3)
            .map(|(id, title)| json!({ "type": "reply", "reply": { "id": id, "title": title } }))
            .collect();
        self.message(json!({
            "messaging_product": "whatsapp",
            "recipient_type": "individual",
            "to": to,
            "type": "interactive",
            "interactive": {
                "type": "button",
                "body": { "text": crate::channel::cut(text, BUTTON_TEXT_LIMIT - 1) },
                "action": { "buttons": buttons },
            },
        }))
        .await
    }

    /// A media file (a voice note): its bytes and type.
    pub async fn media(&self, id: &str) -> Result<(Vec<u8>, String), String> {
        if !id.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-') {
            return Err("not a media id".to_owned());
        }
        let info = self.json(self.http.get(format!("{}/{id}", self.api)), "media").await?;
        let url = info["url"].as_str().ok_or("WhatsApp media: no url")?;
        let mime = info["mime_type"].as_str().unwrap_or("audio/ogg").to_owned();
        let reply = self
            .http
            .get(url)
            .bearer_auth(&self.token)
            .timeout(Duration::from_secs(60))
            .send()
            .await
            .map_err(|e| format!("WhatsApp media: {e}"))?;
        if !reply.status().is_success() {
            return Err(format!("WhatsApp media: {}", reply.status()));
        }
        let bytes = reply.bytes().await.map_err(|e| format!("WhatsApp media: {e}"))?;
        Ok((bytes.to_vec(), mime))
    }

    /// A file the turn made, sent to [to] as an audio or image message (uploaded to the Cloud
    /// API's media first). Ok(false) for a type WhatsApp does not take that way (a WAV, a WebP).
    pub async fn send_file(&self, to: &str, file: &crate::media::Made) -> Result<bool, String> {
        let mime = file.mime.split(';').next().unwrap_or_default().trim();
        let (kind, takes) = match file.kind {
            crate::media::Kind::Speech => {
                ("audio", ["audio/mpeg", "audio/ogg", "audio/aac", "audio/mp4", "audio/amr"].contains(&mime))
            }
            crate::media::Kind::Image => ("image", ["image/jpeg", "image/png"].contains(&mime)),
        };
        if !takes {
            return Ok(false);
        }
        let bytes = file.bytes()?;
        let (content_type, body) = crate::media::multipart(
            &[("messaging_product", "whatsapp"), ("type", mime)],
            ("file", &file.name(), mime, &bytes),
        )?;
        let url = format!("{}/{}/media", self.api, self.phone);
        let request = self.http.post(url).header("content-type", content_type).body(body);
        let uploaded = self.json(request, "media upload").await?;
        let id = uploaded["id"].as_str().ok_or("WhatsApp media upload: no id")?;
        self.message(json!({
            "messaging_product": "whatsapp",
            "recipient_type": "individual",
            "to": to,
            "type": kind,
            (kind): { "id": id },
        }))
        .await?;
        Ok(true)
    }

    /// The number as WhatsApp shows it (`+1 555-0100`), which also checks the token.
    pub async fn me(&self) -> Result<String, String> {
        let url = format!("{}/{}?fields=display_phone_number,verified_name", self.api, self.phone);
        let me = self.json(self.http.get(url), "phone number").await?;
        Ok(me["display_phone_number"].as_str().unwrap_or(&self.phone).to_owned())
    }
}

/// WhatsApp as [crate::channel] sees it.
struct Channel {
    client: Client,
}

impl Transport for Channel {
    fn platform(&self) -> &'static str {
        "whatsapp"
    }

    fn limit(&self) -> usize {
        MESSAGE_LIMIT
    }

    fn progress(&self) -> Progress {
        Progress::Quiet
    }

    fn asking(&self) -> Asking {
        Asking::Buttons
    }

    fn format(&self, markdown: &str) -> String {
        crate::markdown::to_whatsapp(markdown)
    }

    fn send<'a>(&'a self, chat: &'a str, text: &'a str) -> BoxFuture<'a, Result<Option<String>, String>> {
        Box::pin(async move { self.client.send(chat, text).await })
    }

    fn send_file<'a>(&'a self, chat: &'a str, file: &'a crate::media::Made) -> BoxFuture<'a, Result<bool, String>> {
        Box::pin(async move { self.client.send_file(chat, file).await })
    }

    fn ask<'a>(&'a self, chat: &'a str, question: &'a Question) -> BoxFuture<'a, Result<(), String>> {
        Box::pin(async move {
            let id = &question.id;
            let buttons = [
                (format!("once:{id}"), "Allow"),
                (format!("always:{id}"), "Always (this chat)"),
                (format!("deny:{id}"), "Deny"),
            ];
            self.client.buttons(chat, &question.text, &buttons).await.map(drop)
        })
    }
}

/// The HTTP client WhatsApp is reached with: the node's egress rules, unless the API is a
/// stand-in on this machine.
fn http(api: &str) -> Result<reqwest::Client, String> {
    let local = reqwest::Url::parse(api).ok().and_then(|u| u.host_str().map(crate::net::loopback)).unwrap_or(false);
    if local {
        return Ok(reqwest::Client::new());
    }
    invincible::egress::client(&crate::network()?).map_err(|e| format!("WhatsApp needs the network: {e}"))
}

/// [runtime]'s client, as its config says.
pub fn client(runtime: &Runtime) -> Result<Client, String> {
    let config = &runtime.config.whatsapp;
    let api = config.api();
    Client::new(http(&api)?, &api, &config.phone_number_id, &config.access_token(&runtime.home)?)
}

/// The WhatsApp channel of [runtime]: checks the setup, then waits for the webhook (Err: off).
pub async fn run(runtime: Arc<Runtime>) -> Result<(), String> {
    let config = runtime.config.whatsapp.clone();
    config.app_secret(&runtime.home)?;
    config.verify_token(&runtime.home)?;
    let client = client(&runtime)?;
    let me = client.me().await?;
    tracing::info!(bot = %runtime.name, "WhatsApp answering as {me}; messages come to the webhook");
    runtime.register(Arc::new(Channel { client }));
    runtime.channel_account("whatsapp", &me);
    std::future::pending::<()>().await;
    Ok(())
}

/// What a webhook call brings.
#[derive(Debug, PartialEq, Eq)]
pub enum Inbound {
    /// A message for the bot; with a voice note, its media id and type.
    Message { from: String, name: String, text: String, audio: Option<(String, String)>, id: String },
    /// A reply button pressed on a question.
    Press { from: String, question: String, answer: Answer, id: String },
}

/// The messages in a webhook call for the number [phone_number_id]: texts, voice notes, button
/// presses. Statuses (sent, read), reactions and other numbers' messages are not.
pub fn parse(payload: &Value, phone_number_id: &str) -> Vec<Inbound> {
    let mut found = Vec::new();
    for change in
        payload["entry"].as_array().into_iter().flatten().flat_map(|e| e["changes"].as_array().into_iter().flatten())
    {
        let value = &change["value"];
        if change["field"] != "messages" || value["metadata"]["phone_number_id"].as_str() != Some(phone_number_id) {
            continue;
        }
        let names: HashMap<&str, &str> = value["contacts"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(|c| Some((c["wa_id"].as_str()?, c["profile"]["name"].as_str().unwrap_or(""))))
            .collect();
        for message in value["messages"].as_array().into_iter().flatten() {
            let (Some(from), Some(id)) = (message["from"].as_str(), message["id"].as_str()) else { continue };
            let name = names.get(from).copied().unwrap_or_default().to_owned();
            let (from, id) = (from.to_owned(), id.to_owned());
            match message["type"].as_str() {
                Some("text") => {
                    let text = message["text"]["body"].as_str().unwrap_or_default().to_owned();
                    if !text.trim().is_empty() {
                        found.push(Inbound::Message { from, name, text, audio: None, id });
                    }
                }
                Some("audio") => {
                    let audio = &message["audio"];
                    if let Some(media) = audio["id"].as_str() {
                        let mime = audio["mime_type"].as_str().unwrap_or("audio/ogg").to_owned();
                        found.push(Inbound::Message {
                            from,
                            name,
                            text: String::new(),
                            audio: Some((media.to_owned(), mime)),
                            id,
                        });
                    }
                }
                Some("interactive") => {
                    let reply = &message["interactive"]["button_reply"];
                    let Some((choice, question)) = reply["id"].as_str().and_then(|r| r.split_once(':')) else {
                        continue;
                    };
                    let answer = match choice {
                        "once" => Answer::Once,
                        "always" => Answer::Always,
                        "deny" => Answer::Deny,
                        _ => continue,
                    };
                    found.push(Inbound::Press { from, question: question.to_owned(), answer, id });
                }
                _ => {}
            }
        }
    }
    found
}

/// Message ids already taken in: Meta delivers again when an answer is slow or lost.
static SEEN: LazyLock<Mutex<VecDeque<String>>> = LazyLock::new(Mutex::default);

fn first_time(id: &str) -> bool {
    let mut seen = SEEN.lock().expect("seen");
    if seen.iter().any(|s| s == id) {
        return false;
    }
    seen.push_back(id.to_owned());
    if seen.len() > 1024 {
        seen.pop_front();
    }
    true
}

/// `GET` and `POST` on `/hooks/whatsapp` (`/hooks/<bot>/whatsapp`): Meta's check when the
/// webhook is added, and the calls it makes, each checked against the app secret's signature.
pub async fn webhook(
    runtime: Arc<Runtime>,
    method: &Method,
    query: &HashMap<String, String>,
    headers: &HeaderMap,
    body: &[u8],
) -> (StatusCode, String) {
    let config = &runtime.config.whatsapp;
    if !config.enabled {
        return (StatusCode::NOT_FOUND, "WhatsApp is not turned on for this bot".to_owned());
    }
    if method == Method::GET {
        let Ok(verify) = config.verify_token(&runtime.home) else {
            return (StatusCode::SERVICE_UNAVAILABLE, "no verify token on this node".to_owned());
        };
        let given = query.get("hub.verify_token").map(String::as_str).unwrap_or_default();
        let subscribe = query.get("hub.mode").map(String::as_str) == Some("subscribe");
        return match query.get("hub.challenge") {
            Some(challenge) if subscribe && crate::hooks::same(given.as_bytes(), verify.as_bytes()) => {
                tracing::info!(bot = %runtime.name, "WhatsApp: the webhook was verified");
                (StatusCode::OK, challenge.clone())
            }
            _ => (StatusCode::FORBIDDEN, "verify token mismatch".to_owned()),
        };
    }
    let Ok(secret) = config.app_secret(&runtime.home) else {
        return (StatusCode::SERVICE_UNAVAILABLE, "no app secret on this node".to_owned());
    };
    if !crate::hooks::signed(&secret, headers, body) {
        tracing::warn!(bot = %runtime.name, "WhatsApp: a webhook call without a valid signature");
        return (StatusCode::UNAUTHORIZED, "bad signature".to_owned());
    }
    let Some(transport) = runtime.transport("whatsapp") else {
        return (StatusCode::SERVICE_UNAVAILABLE, "WhatsApp is still starting".to_owned());
    };
    let payload: Value = serde_json::from_slice(body).unwrap_or_default();
    for inbound in parse(&payload, config.phone_number_id.trim()) {
        match inbound {
            Inbound::Press { from, question, answer, id } if first_time(&id) => {
                use crate::channel::Pressed;
                let note = match runtime.conversations.press(&question, &from, answer) {
                    Pressed::Done(note) => format!("→ {note}"),
                    Pressed::NotYours => "That question is someone else's.".to_owned(),
                    Pressed::Expired => "That question was answered already, or expired.".to_owned(),
                };
                let transport = transport.clone();
                tokio::spawn(async move {
                    let _ = transport.send(&from, &note).await;
                });
            }
            Inbound::Message { from, name, text, audio, id } if first_time(&id) => {
                let audio = audio.map(|(media, mime)| {
                    let runtime = runtime.clone();
                    Box::pin(async move {
                        let (bytes, mime_type) = client(&runtime)?.media(&media).await?;
                        Ok(crate::voice::Audio {
                            bytes,
                            mime: if mime_type.is_empty() { mime } else { mime_type },
                            name: media,
                        })
                    }) as BoxFuture<'static, _>
                });
                let incoming = Incoming {
                    chat: from.clone(),
                    place: format!("whatsapp-{from}"),
                    user: crate::pairing::User { id: from, name },
                    text,
                    direct: true,
                    audio,
                };
                let (runtime, transport) = (runtime.clone(), transport.clone());
                tokio::spawn(async move {
                    if let Err(e) = crate::channel::handle(&runtime, &transport, incoming).await {
                        tracing::warn!(bot = %runtime.name, "whatsapp: {e}");
                    }
                });
            }
            _ => {}
        }
    }
    // Meta wants a quick 200; the turns run on their own.
    (StatusCode::OK, "ok".to_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn call(messages: Value) -> Value {
        json!({ "object": "whatsapp_business_account", "entry": [{ "id": "W1", "changes": [{ "field": "messages", "value": {
            "messaging_product": "whatsapp",
            "metadata": { "display_phone_number": "15550100", "phone_number_id": "111" },
            "contacts": [{ "profile": { "name": "Ann" }, "wa_id": "15550001" }],
            "messages": messages,
        } }] }] })
    }

    #[test]
    fn webhook_calls_become_messages_and_presses() {
        let text = call(json!([{ "from": "15550001", "id": "m1", "type": "text", "text": { "body": "hi" } }]));
        assert_eq!(
            parse(&text, "111"),
            [Inbound::Message {
                from: "15550001".into(),
                name: "Ann".into(),
                text: "hi".into(),
                audio: None,
                id: "m1".into()
            }]
        );
        assert!(parse(&text, "222").is_empty(), "another number's");
        let voice = call(
            json!([{ "from": "15550001", "id": "m2", "type": "audio", "audio": { "id": "A9", "mime_type": "audio/ogg; codecs=opus", "voice": true } }]),
        );
        assert!(matches!(&parse(&voice, "111")[0], Inbound::Message { audio: Some((id, _)), .. } if id == "A9"));
        let press = call(json!([{ "from": "15550001", "id": "m3", "type": "interactive",
            "interactive": { "type": "button_reply", "button_reply": { "id": "always:q7", "title": "Always" } } }]));
        assert_eq!(
            parse(&press, "111"),
            [Inbound::Press {
                from: "15550001".into(),
                question: "q7".into(),
                answer: Answer::Always,
                id: "m3".into()
            }]
        );
        // Statuses, reactions, empty texts: nothing.
        let statuses = json!({ "entry": [{ "changes": [{ "field": "messages", "value": {
            "metadata": { "phone_number_id": "111" }, "statuses": [{ "id": "m1", "status": "read" }] } }] }] });
        assert!(parse(&statuses, "111").is_empty());
        let reaction = call(
            json!([{ "from": "1", "id": "m4", "type": "reaction", "reaction": { "emoji": "x" } }, { "from": "1", "id": "m5", "type": "text", "text": { "body": " " } }]),
        );
        assert!(parse(&reaction, "111").is_empty());
        assert!(first_time("x1") && !first_time("x1"));
    }

    #[test]
    fn the_api_is_https_and_the_number_an_id() {
        let http = reqwest::Client::new();
        assert!(Client::new(http.clone(), "https://graph.facebook.com/v21.0", "111", "t").is_ok());
        assert!(Client::new(http.clone(), "http://127.0.0.1:9", "111", "t").is_ok(), "a stand-in here");
        assert!(Client::new(http.clone(), "http://graph.facebook.com", "111", "t").is_err());
        assert!(Client::new(http, "https://graph.facebook.com", "+1 555", "t").is_err());
    }
}
