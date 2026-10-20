//! Signal, through signal-cli's daemon (JSON-RPC over HTTP, events as a stream): direct
//! messages, approvals by replying (`yes`, `always`, `no`), voice messages transcribed, speech
//! and pictures the agent makes sent as attachments.
//!
//! ```toml
//! [signal]
//! enabled = true
//! account = "+15551234567"           # the number signal-cli is registered or linked with
//! # url = "http://127.0.0.1:7583"    # a daemon already running (signal-cli daemon --http …);
//! #                                  # without it, autobot starts `signal-cli -a ACCOUNT daemon`
//! ```
//!
//! Set up the account with signal-cli first (`signal-cli link` with your phone, or `register`).
//! A stranger who messages the number gets a one-time code (`autobot signal approve <code>`).
//! Signal messages are end-to-end encrypted to this machine; signal-cli keeps the keys.

use std::path::PathBuf;
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;

use base64::Engine as _;
use futures_util::StreamExt;
use serde::Deserialize;
use serde_json::{Value, json};

use crate::bots::Runtime;
use crate::channel::{Asking, BoxFuture, Incoming, Progress, Question, Transport};

/// Signal sends longer texts as an attachment; parts of this size read as messages.
const MESSAGE_LIMIT: usize = 2000;

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SignalConfig {
    #[serde(default)]
    pub enabled: bool,
    /// The bot's number.
    #[serde(default)]
    pub account: String,
    /// A signal-cli daemon's HTTP address; none: start one.
    #[serde(default)]
    pub url: Option<String>,
    /// signal-cli [default: on the PATH].
    #[serde(default)]
    pub command: Option<PathBuf>,
    /// Where a daemon started here listens [default: 7583].
    #[serde(default)]
    pub port: Option<u16>,
}

#[derive(Clone)]
pub struct Client {
    http: reqwest::Client,
    url: String,
    next: Arc<AtomicU64>,
}

impl Client {
    pub fn new(url: &str) -> Result<Self, String> {
        let parsed = reqwest::Url::parse(url).map_err(|e| format!("[signal] url: {e}"))?;
        if !parsed.host_str().is_some_and(crate::net::loopback) {
            return Err("[signal] url: signal-cli's daemon must be on this machine".to_owned());
        }
        Ok(Self { http: reqwest::Client::new(), url: url.trim_end_matches('/').to_owned(), next: Arc::default() })
    }

    /// A JSON-RPC call; its result.
    pub async fn call(&self, method: &str, params: Value) -> Result<Value, String> {
        let id = self.next.fetch_add(1, Ordering::Relaxed);
        let body = json!({ "jsonrpc": "2.0", "method": method, "params": params, "id": id.to_string() });
        let reply: Value = self
            .http
            .post(format!("{}/api/v1/rpc", self.url))
            .json(&body)
            .timeout(Duration::from_secs(60))
            .send()
            .await
            .map_err(|e| format!("signal-cli {method}: {e}"))?
            .json()
            .await
            .map_err(|e| format!("signal-cli {method}: {e}"))?;
        if let Some(error) = reply.get("error") {
            return Err(format!("signal-cli {method}: {}", error["message"].as_str().unwrap_or("failed")));
        }
        Ok(reply["result"].clone())
    }

    /// The recipient of [chat]: a number (or uuid), or `group:<id>`.
    fn to(chat: &str) -> Value {
        match chat.strip_prefix("group:") {
            Some(group) => json!({ "groupId": group }),
            None => json!({ "recipient": [chat] }),
        }
    }

    pub async fn send(&self, chat: &str, text: &str) -> Result<Option<String>, String> {
        let mut params = Self::to(chat);
        params["message"] = json!(text);
        let reply = self.call("send", params).await?;
        Ok(reply["timestamp"].as_u64().map(|t| t.to_string()))
    }

    /// A file the turn made, as an attachment. It goes inline (a `data:` address) rather than
    /// as a path, so a daemon in a container of its own takes it too.
    pub async fn send_file(&self, chat: &str, file: &crate::media::Made) -> Result<(), String> {
        let mut params = Self::to(chat);
        params["attachments"] = json!([attachment(file)?]);
        self.call("send", params).await.map(drop)
    }
}

/// [file] as signal-cli takes an attachment inline: `data:<type>;filename=<name>;base64,<data>`.
fn attachment(file: &crate::media::Made) -> Result<String, String> {
    let bytes = file.bytes()?;
    let name: String = file.name().chars().filter(|c| c.is_ascii_alphanumeric() || ".-_".contains(*c)).collect();
    let mime = if file.mime.is_empty() { "application/octet-stream" } else { file.mime.as_str() };
    Ok(format!("data:{mime};filename={name};base64,{}", base64::engine::general_purpose::STANDARD.encode(bytes)))
}

/// Signal as [crate::channel] sees it.
struct Channel {
    client: Client,
}

impl Transport for Channel {
    fn platform(&self) -> &'static str {
        "signal"
    }

    fn limit(&self) -> usize {
        MESSAGE_LIMIT
    }

    fn progress(&self) -> Progress {
        Progress::Quiet
    }

    fn asking(&self) -> Asking {
        Asking::Reply
    }

    fn format(&self, markdown: &str) -> String {
        crate::markdown::to_plain(markdown)
    }

    fn send<'a>(&'a self, chat: &'a str, text: &'a str) -> BoxFuture<'a, Result<Option<String>, String>> {
        Box::pin(async move { self.client.send(chat, text).await })
    }

    fn send_file<'a>(&'a self, chat: &'a str, file: &'a crate::media::Made) -> BoxFuture<'a, Result<bool, String>> {
        Box::pin(async move { self.client.send_file(chat, file).await.map(|()| true) })
    }

    fn typing<'a>(&'a self, chat: &'a str) -> BoxFuture<'a, ()> {
        Box::pin(async move {
            let _ = self.client.call("sendTyping", Client::to(chat)).await;
        })
    }

    fn ask<'a>(&'a self, chat: &'a str, question: &'a Question) -> BoxFuture<'a, Result<(), String>> {
        Box::pin(async move {
            let text = format!(
                "{}\n\nReply yes, always (for this chat) or no; or \"no, …\" with what to do instead. (code {})",
                question.text, question.code
            );
            self.client.send(chat, &text).await.map(drop)
        })
    }
}

/// The Signal channel of [runtime], as its config says: off (Err) when it cannot start.
pub async fn run(runtime: Arc<Runtime>) -> Result<(), String> {
    let config = runtime.config.signal.clone();
    if config.account.trim().is_empty() {
        return Err("[signal] account is missing (the bot's number)".to_owned());
    }
    // A daemon of its own, stopped with it.
    let mut daemon = None;
    let url = match &config.url {
        Some(url) => url.clone(),
        None => {
            let command = match &config.command {
                Some(c) => crate::config::expand(c),
                None => crate::find_on_path("signal-cli").ok_or("signal-cli is not installed (or set [signal] url)")?,
            };
            let port = config.port.unwrap_or(7583);
            let child = tokio::process::Command::new(&command)
                .args(["-a", config.account.trim(), "daemon", "--http", &format!("127.0.0.1:{port}")])
                .stdin(std::process::Stdio::null())
                .stdout(std::process::Stdio::null())
                .kill_on_drop(true)
                .spawn()
                .map_err(|e| format!("{}: {e}", command.display()))?;
            daemon = Some(child);
            format!("http://127.0.0.1:{port}")
        }
    };
    let client = Client::new(&url)?;
    let served = serve(client, runtime).await;
    drop(daemon);
    served
}

/// Answers [runtime]'s Signal messages through the daemon at [client] until the process stops.
pub async fn serve(client: Client, runtime: Arc<Runtime>) -> Result<(), String> {
    let channel: Arc<dyn Transport> = Arc::new(Channel { client: client.clone() });
    runtime.register(channel.clone());
    let account = runtime.config.signal.account.clone();
    runtime.channel_account("signal", &account);
    let mut backoff = Duration::from_secs(1);
    loop {
        match events(&client, &runtime, &channel).await {
            Ok(()) => {}
            Err(e) => {
                tracing::warn!(bot = %runtime.name, "signal: {e}; again in {}s", backoff.as_secs());
                runtime.channel_state("signal", &format!("retrying: {e}"));
            }
        }
        tokio::time::sleep(backoff).await;
        backoff = (backoff * 2).min(Duration::from_secs(60));
    }
}

/// The daemon's event stream, until it ends.
async fn events(client: &Client, runtime: &Arc<Runtime>, channel: &Arc<dyn Transport>) -> Result<(), String> {
    let response = client
        .http
        .get(format!("{}/api/v1/events", client.url))
        .header("accept", "text/event-stream")
        .send()
        .await
        .map_err(|e| format!("signal-cli events: {e}"))?;
    if !response.status().is_success() {
        return Err(format!("signal-cli events: {}", response.status()));
    }
    runtime.channel_state("signal", "connected");
    let mut stream = response.bytes_stream();
    let mut buffer = String::new();
    let mut data = String::new();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| format!("signal-cli events: {e}"))?;
        buffer.push_str(&String::from_utf8_lossy(&chunk));
        while let Some(at) = buffer.find('\n') {
            let line = buffer[..at].trim_end_matches('\r').to_owned();
            buffer.drain(..=at);
            if let Some(rest) = line.strip_prefix("data:") {
                data.push_str(rest.trim_start());
            } else if line.is_empty() && !data.is_empty() {
                let event: Value = serde_json::from_str(&std::mem::take(&mut data)).unwrap_or_default();
                if let Some(incoming) = message(client, &event) {
                    let (runtime, channel) = (runtime.clone(), channel.clone());
                    tokio::spawn(async move {
                        if let Err(e) = crate::channel::handle(&runtime, &channel, incoming).await {
                            tracing::warn!(bot = %runtime.name, "signal: {e}");
                        }
                    });
                }
            }
        }
        if buffer.len() > 1 << 20 {
            buffer.clear();
        }
    }
    Ok(())
}

/// An event as a message for the bot: direct text or voice; groups, receipts and typing are not.
pub fn message(client: &Client, event: &Value) -> Option<Incoming> {
    let envelope = event.get("envelope").or_else(|| event["params"].get("envelope"))?;
    let data = envelope.get("dataMessage")?;
    if data.get("groupInfo").is_some() || data.get("groupV2").is_some() {
        return None;
    }
    let from = envelope["sourceNumber"].as_str().or(envelope["source"].as_str()).or(envelope["sourceUuid"].as_str())?;
    let text = data["message"].as_str().unwrap_or_default().to_owned();
    let attachment = data["attachments"].as_array().into_iter().flatten().find(|a| {
        crate::voice::is_audio(a["contentType"].as_str().unwrap_or(""), a["filename"].as_str().unwrap_or(""))
    });
    let audio = attachment.map(|a| {
        let (client, id) = (client.clone(), a["id"].as_str().unwrap_or_default().to_owned());
        let mime = a["contentType"].as_str().unwrap_or("audio/aac").to_owned();
        let from = from.to_owned();
        Box::pin(async move {
            let reply = client.call("getAttachment", json!({ "id": id, "recipient": from })).await?;
            let data = reply["data"].as_str().or(reply.as_str()).ok_or("signal-cli gave no attachment")?;
            let bytes = base64::engine::general_purpose::STANDARD.decode(data).map_err(|e| e.to_string())?;
            Ok(crate::voice::Audio { bytes, mime, name: id })
        }) as BoxFuture<'static, _>
    });
    if text.trim().is_empty() && audio.is_none() {
        return None;
    }
    Some(Incoming {
        chat: from.to_owned(),
        place: format!("signal-{}", from.trim_start_matches('+')),
        user: crate::pairing::User {
            id: from.to_owned(),
            name: envelope["sourceName"].as_str().unwrap_or_default().to_owned(),
        },
        text,
        direct: true,
        audio,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn events_become_messages() {
        let client = Client::new("http://127.0.0.1:7583").unwrap();
        assert!(Client::new("http://example.com").is_err(), "the daemon is local");
        let event = json!({ "envelope": { "sourceNumber": "+15550001", "sourceName": "Ann", "dataMessage": { "message": "hi" } } });
        let incoming = message(&client, &event).unwrap();
        assert_eq!(
            (incoming.chat.as_str(), incoming.place.as_str(), incoming.text.as_str()),
            ("+15550001", "signal-15550001", "hi")
        );
        // Receipts, typing and group messages: nothing.
        for not in [
            json!({ "envelope": { "sourceNumber": "+1", "receiptMessage": {} } }),
            json!({ "envelope": { "sourceNumber": "+1", "typingMessage": {} } }),
            json!({ "envelope": { "sourceNumber": "+1", "dataMessage": { "message": "x", "groupInfo": { "groupId": "g" } } } }),
            json!({ "envelope": { "sourceNumber": "+1", "dataMessage": { "message": " " } } }),
        ] {
            assert!(message(&client, &not).is_none(), "{not}");
        }
        let voice = json!({ "envelope": { "sourceNumber": "+1", "dataMessage": { "attachments": [{ "contentType": "audio/aac", "id": "a1.aac" }] } } });
        assert!(message(&client, &voice).unwrap().audio.is_some());
        assert_eq!(Client::to("group:abc"), json!({ "groupId": "abc" }));
    }
}
