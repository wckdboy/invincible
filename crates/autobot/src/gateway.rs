//! The agent's only model provider: Invincible Gateway's OpenAI-compatible API on this machine.
//! Every turn goes through the gateway's router, so its rules hold for the agent as for any app:
//! private work stays local, cloud use is redacted and receipted, and a request the router wants
//! confirmed comes back here as a question for the owner.

use std::time::Duration;

use serde_json::{Value, json};

#[derive(Clone)]
pub struct Gateway {
    client: reqwest::Client,
    url: String,
    token: String,
    model: String,
    private: bool,
    /// Ask for the answer as a stream (server-sent events) and hand on its parts as they come.
    stream: bool,
    /// Tries again after a failure that passes (the gateway restarting, a rate limit, a 5xx, a
    /// stream cut before anything of it was shown): at most this many times more.
    retries: u32,
    /// The first wait before trying again (doubled each time; a `Retry-After` wins, to a point).
    backoff: Duration,
    /// How long a call may go without a byte from the gateway (its answer's start, or the next
    /// piece of a stream) before it counts as hung.
    idle: Duration,
}

/// Retries after a failure that passes ([Gateway::retries]).
const RETRIES: u32 = 3;
/// The first wait before a retry.
const BACKOFF: Duration = Duration::from_secs(1);
/// The longest wait a `Retry-After` gets.
const MAX_RETRY_AFTER: Duration = Duration::from_secs(30);
/// A call with no byte for this long is hung (a local model reading a long prompt, or writing a
/// long answer whole, takes minutes; ten is past any of that).
const IDLE: Duration = Duration::from_secs(600);

/// A chat completion request, as the gateway takes it.
#[derive(serde::Serialize)]
struct Body<'a> {
    model: &'a str,
    messages: &'a [Value],
    stream: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    stream_options: Option<StreamOptions>,
    #[serde(skip_serializing_if = "Option::is_none")]
    tools: Option<&'a Value>,
}

#[derive(serde::Serialize)]
struct StreamOptions {
    include_usage: bool,
}

/// Part of an answer as it streams in.
#[derive(Debug)]
pub enum Delta<'a> {
    Text(&'a str),
    Reasoning(&'a str),
}

/// One answer: the assistant message, and what the gateway says about it.
#[derive(Debug)]
pub struct Reply {
    pub message: Value,
    /// The receipt's id (`GET /v1/receipts/{id}`).
    pub request_id: Option<String>,
    /// The routing decision (spec/routing.md).
    pub decision: Option<Value>,
    /// Tokens: the provider's `usage` (prompt_tokens, completion_tokens, cached ones).
    pub usage: Option<Value>,
}

/// (input, output, cached input) tokens from a `usage` object; cached from DeepSeek's
/// `prompt_cache_hit_tokens` or OpenAI's `prompt_tokens_details.cached_tokens`.
pub fn tokens(usage: &Value) -> Option<(u64, u64, u64)> {
    let input = usage["prompt_tokens"].as_u64()?;
    let output = usage["completion_tokens"].as_u64().unwrap_or(0);
    let cached = usage["prompt_cache_hit_tokens"]
        .as_u64()
        .or_else(|| usage["prompt_tokens_details"]["cached_tokens"].as_u64())
        .unwrap_or(0);
    Some((input, output, cached))
}

/// A model the gateway serves.
#[derive(Clone, Debug)]
pub struct ModelInfo {
    pub id: String,
    /// `node` (this machine), `cloud`, …
    pub tier: String,
    /// Its context, in tokens.
    pub context: Option<u64>,
    pub healthy: bool,
    /// Whether it takes images (None: the gateway does not know).
    pub vision: Option<bool>,
}

impl ModelInfo {
    /// KiB of conversation to send it per call: about half its context (at ~4 characters a
    /// token, leaving room for the tools, the system prompt and the answer); at least 48.
    pub fn context_kib(&self) -> usize {
        self.context.map_or(48, |tokens| ((tokens as usize * 2) / 1024).max(48))
    }

    pub fn is_cloud(&self) -> bool {
        self.tier != "node"
    }
}

/// Why a call did not produce an answer.
#[derive(Debug)]
pub enum GatewayError {
    /// The router wants the owner to confirm (cloud use, a training provider, …).
    Confirm(String),
    Failed(String),
}

impl std::fmt::Display for GatewayError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Confirm(m) | Self::Failed(m) => f.write_str(m),
        }
    }
}

impl Gateway {
    pub fn new(url: &str, token: &str, model: &str, private: bool) -> Result<Self, String> {
        let parsed = invincible::egress::check(url)?;
        if parsed.scheme() != "http" && parsed.scheme() != "https" {
            return Err(format!("{url}: not an HTTP URL"));
        }
        // Plain HTTP (the gateway on this machine) needs no trust roots, and loading the
        // system's takes most of the agent's start (~100 ms on macOS).
        let client = reqwest::Client::builder()
            .no_proxy()
            .connect_timeout(Duration::from_secs(10))
            .tls_built_in_root_certs(parsed.scheme() == "https")
            .build()
            .map_err(|e| e.to_string())?;
        Ok(Self {
            client,
            url: url.trim_end_matches('/').to_owned(),
            token: token.to_owned(),
            model: model.to_owned(),
            private,
            stream: false,
            retries: RETRIES,
            backoff: BACKOFF,
            idle: IDLE,
        })
    }

    /// The same gateway, trying a failed call that may pass [retries] times more, first after
    /// [backoff].
    pub fn with_retries(&self, retries: u32, backoff: Duration) -> Self {
        Self { retries, backoff, ..self.clone() }
    }

    /// The same gateway, giving up on a call that sends nothing for [idle].
    pub fn with_idle_timeout(&self, idle: Duration) -> Self {
        Self { idle, ..self.clone() }
    }

    /// Whether the gateway answers its health check (`GET /health`, no token needed).
    pub async fn healthy(&self) -> bool {
        let root = self.url.strip_suffix("/v1").unwrap_or(&self.url);
        let request = self.client.get(format!("{root}/health")).timeout(Duration::from_secs(5));
        matches!(request.send().await, Ok(r) if r.status().is_success())
    }

    /// Keeps an eye on the gateway for a long-running agent: says when it goes away and when it
    /// is back. Every call reconnects anyway, so nothing else has to change when it restarts
    /// (an upgrade, a crash); turns in between fail with the gateway's error and can be retried.
    /// Gone for a minute or more is an alert ([crate::alerts]); back, its clearing.
    pub async fn watch(&self, every: Duration) {
        let mut up = true;
        let mut down_since: Option<std::time::Instant> = None;
        // Whether this watch said it was down; and, until it first answers, the clearing of
        // what the last run may have sent (dropped when nothing is open).
        let mut told = false;
        let mut first = true;
        loop {
            let now = self.healthy().await;
            if now != up {
                if now {
                    tracing::info!("the gateway at {} answers again", self.url);
                } else {
                    tracing::warn!("the gateway at {} does not answer; waiting for it", self.url);
                }
                up = now;
            }
            if now {
                down_since = None;
                if std::mem::take(&mut told) | std::mem::take(&mut first) {
                    crate::alerts::raise(crate::alerts::Alert::cleared(
                        crate::alerts::Kind::Gateway,
                        "gateway",
                        format!("The gateway at {} answers again.", self.url),
                    ));
                }
            } else {
                let since = *down_since.get_or_insert_with(std::time::Instant::now);
                if !told && since.elapsed() >= Duration::from_secs(60) {
                    told = true;
                    crate::alerts::raise(crate::alerts::Alert::new(
                        crate::alerts::Kind::Gateway,
                        "gateway",
                        format!(
                            "The gateway at {} has not answered for a minute: the bots cannot reach a model.",
                            self.url
                        ),
                    ));
                }
            }
            tokio::time::sleep(every).await;
        }
    }

    pub fn model(&self) -> &str {
        &self.model
    }

    /// The same gateway, with turns private (local models only) or not.
    pub fn with_private(&self, private: bool) -> Self {
        Self { private, ..self.clone() }
    }

    pub fn private(&self) -> bool {
        self.private
    }

    /// The same gateway, streaming answers or not.
    pub fn with_stream(&self, stream: bool) -> Self {
        Self { stream, ..self.clone() }
    }

    /// The same gateway, asking for [model].
    pub fn with_model(&self, model: &str) -> Self {
        Self { model: model.to_owned(), ..self.clone() }
    }

    /// One chat completion with [tools]; [confirmed] answers a [GatewayError::Confirm].
    pub async fn chat(&self, messages: &[Value], tools: &Value, confirmed: bool) -> Result<Reply, GatewayError> {
        self.chat_with(messages, tools, confirmed, &|_| {}).await
    }

    /// [Gateway::chat], handing [on] the answer's parts as they stream in (when streaming).
    /// A failure that may pass is tried again, a few times, waiting longer each time: the
    /// gateway restarting, a rate limit, an overloaded server, a stream cut before any of it was
    /// handed on (once text is shown, it is not sent twice).
    pub async fn chat_with(
        &self,
        messages: &[Value],
        tools: &Value,
        confirmed: bool,
        on: &(dyn Fn(Delta) + Send + Sync),
    ) -> Result<Reply, GatewayError> {
        let shown = std::sync::atomic::AtomicBool::new(false);
        let watched = |delta: Delta| {
            shown.store(true, std::sync::atomic::Ordering::Relaxed);
            on(delta)
        };
        let mut tried = 0;
        loop {
            match self.attempt(messages, tools, confirmed, &watched).await {
                Err(Attempt::Again(e, after))
                    if tried < self.retries && !shown.load(std::sync::atomic::Ordering::Relaxed) =>
                {
                    let wait = after.map_or(self.backoff * 2u32.pow(tried), |a| a.min(MAX_RETRY_AFTER));
                    tried += 1;
                    tracing::warn!("{e}; trying again in {} ms ({tried} of {})", wait.as_millis(), self.retries);
                    tokio::time::sleep(wait).await;
                }
                Err(Attempt::Again(e, _) | Attempt::Final(e)) => return Err(e),
                Ok(reply) => return Ok(reply),
            }
        }
    }

    /// One try of [Gateway::chat_with].
    async fn attempt(
        &self,
        messages: &[Value],
        tools: &Value,
        confirmed: bool,
        on: &(dyn Fn(Delta) + Send + Sync),
    ) -> Result<Reply, Attempt> {
        // Serialized from what it borrows: no copy of the conversation and the tools per call.
        let body = Body {
            model: &self.model,
            messages,
            stream: self.stream,
            stream_options: self.stream.then_some(StreamOptions { include_usage: true }),
            tools: tools.as_array().filter(|t| !t.is_empty()).map(|_| tools),
        };
        let mut request =
            self.client.post(format!("{}/chat/completions", self.url)).bearer_auth(&self.token).json(&body);
        request = request.header(invincible::server::CLIENT_HEADER, "autobot-agent");
        if self.private {
            request = request.header("invincible-private", "1");
        }
        if confirmed {
            request = request.header("invincible-confirmed", "1");
        }
        let failed = |e: String| Attempt::Final(GatewayError::Failed(e));
        let hung = || failed(format!("the gateway sent nothing for {}; stopped waiting", seconds(self.idle)));
        let response = match tokio::time::timeout(self.idle, request.send()).await {
            Err(_) => return Err(hung()),
            // Not there (restarting, say): worth another try; anything else is not.
            Ok(Err(e)) if e.is_connect() => {
                return Err(Attempt::Again(GatewayError::Failed(self.unreachable(e)), None));
            }
            Ok(Err(e)) => return Err(failed(self.unreachable(e))),
            Ok(Ok(response)) => response,
        };
        let status = response.status();
        let header = |name: &str| response.headers().get(name).and_then(|v| v.to_str().ok()).map(str::to_owned);
        let request_id = header(invincible::receipts::REQUEST_ID_HEADER);
        let decision = header(invincible::server::DECISION_HEADER).and_then(|d| serde_json::from_str(&d).ok());
        let retry_after = header("retry-after").and_then(|v| v.trim().parse::<u64>().ok()).map(Duration::from_secs);
        let streamed = response
            .headers()
            .get(reqwest::header::CONTENT_TYPE)
            .and_then(|v| v.to_str().ok())
            .is_some_and(|t| t.starts_with("text/event-stream"));
        if status.is_success() && streamed {
            return match read_stream(response, on, self.idle).await {
                Ok((message, usage)) => Ok(Reply { message, request_id, decision, usage }),
                // Cut off (not the model's own error, not a hang): again, unless some was shown.
                Err(Stream::Broken(e)) => Err(Attempt::Again(GatewayError::Failed(e), None)),
                Err(Stream::Failed(e)) => Err(failed(e)),
            };
        }
        let text = match tokio::time::timeout(self.idle, response.text()).await {
            Err(_) => return Err(hung()),
            Ok(Err(e)) => return Err(Attempt::Again(GatewayError::Failed(format!("the gateway's answer: {e}")), None)),
            Ok(Ok(text)) => text,
        };
        let parsed: Value = serde_json::from_str(&text).unwrap_or(Value::Null);
        if !status.is_success() {
            let message = parsed["error"]["message"].as_str().map(str::to_owned).unwrap_or(text);
            if message.contains("no-model") {
                let hint = if self.private {
                    "no local model is ready, and this turn is private (local only): wait for the model to load, or allow cloud models (`/private off`, `--model <cloud model>`, or [gateway] private = false)"
                } else {
                    "no model is ready: wait for a local one to load, or add a cloud model (`invincible cloud add`)"
                };
                return Err(failed(format!("the gateway refused ({status}): {message}: {hint}")));
            }
            if status == reqwest::StatusCode::CONFLICT {
                return Err(Attempt::Final(GatewayError::Confirm(message)));
            }
            let error = GatewayError::Failed(format!("the gateway refused ({status}): {message}"));
            // Too many requests, or a server that is overloaded or between restarts.
            let passing = matches!(status.as_u16(), 429 | 500 | 502 | 503 | 504) && !overflow(&message);
            return Err(if passing { Attempt::Again(error, retry_after) } else { Attempt::Final(error) });
        }
        let message = parsed["choices"][0]["message"].clone();
        if !message.is_object() {
            return Err(failed(format!("the gateway's answer has no message: {text}")));
        }
        let usage = parsed.get("usage").filter(|u| u.is_object()).cloned();
        Ok(Reply { message, request_id, decision, usage })
    }

    /// A web page through the gateway (its `/v1/fetch`: the node's network policy, receipted):
    /// the page's text, and the receipt id.
    pub async fn fetch(&self, url: &str) -> Result<(String, Option<String>), String> {
        let response = self
            .client
            .post(format!("{}/fetch", self.url))
            .bearer_auth(&self.token)
            .header(invincible::server::CLIENT_HEADER, "autobot-agent")
            .json(&json!({ "url": url }))
            .send()
            .await
            .map_err(|e| self.unreachable(e))?;
        let request_id = response
            .headers()
            .get(invincible::receipts::REQUEST_ID_HEADER)
            .and_then(|v| v.to_str().ok())
            .map(str::to_owned);
        let status = response.status();
        let body: Value = response.json().await.map_err(|e| e.to_string())?;
        if !status.is_success() {
            return Err(body["error"]["message"].as_str().unwrap_or("the gateway could not fetch it").to_owned());
        }
        let text = format!(
            "{} · {}{}\n\n{}",
            body["status"],
            body["content_type"].as_str().unwrap_or("?"),
            if body["truncated"] == true { " · cut short" } else { "" },
            body["text"].as_str().unwrap_or_default()
        );
        Ok((text, request_id))
    }

    /// Speech or a picture from the node (`/audio/speech`, `/images/generations`) for [body]:
    /// the answer's bytes and type, the receipt id and the routing decision. [private] keeps it
    /// on the machine; [confirmed] is the owner's yes to a backend off it.
    pub async fn make(
        &self,
        path: &str,
        body: &Value,
        private: bool,
        confirmed: bool,
    ) -> Result<(Vec<u8>, String, Option<String>, Option<Value>), GatewayError> {
        let mut request = self
            .client
            .post(format!("{}{path}", self.url))
            .bearer_auth(&self.token)
            .header(invincible::server::CLIENT_HEADER, "autobot-agent")
            .timeout(Duration::from_secs(300))
            .json(body);
        if private {
            request = request.header("invincible-private", "1");
        }
        if confirmed {
            request = request.header("invincible-confirmed", "1");
        }
        let response = request.send().await.map_err(|e| GatewayError::Failed(self.unreachable(e)))?;
        let status = response.status();
        let header = |name: &str| response.headers().get(name).and_then(|v| v.to_str().ok()).map(str::to_owned);
        let request_id = header(invincible::receipts::REQUEST_ID_HEADER);
        let decision = header(invincible::server::DECISION_HEADER).and_then(|d| serde_json::from_str(&d).ok());
        let mime = header("content-type").unwrap_or_default();
        let bytes = response.bytes().await.map_err(|e| GatewayError::Failed(format!("the gateway's answer: {e}")))?;
        if !status.is_success() {
            let parsed: Value = serde_json::from_slice(&bytes).unwrap_or(Value::Null);
            let message = parsed["error"]["message"]
                .as_str()
                .map(str::to_owned)
                .unwrap_or_else(|| String::from_utf8_lossy(&bytes).chars().take(300).collect());
            return Err(if status == reqwest::StatusCode::CONFLICT {
                GatewayError::Confirm(message)
            } else {
                GatewayError::Failed(format!("the gateway refused ({status}): {message}"))
            });
        }
        Ok((bytes.to_vec(), mime, request_id, decision))
    }

    /// The models the gateway serves.
    pub async fn models(&self) -> Result<Vec<String>, String> {
        let reply = self.get("/models").await?;
        Ok(reply["data"].as_array().into_iter().flatten().filter_map(|m| m["id"].as_str().map(str::to_owned)).collect())
    }

    /// The models the gateway serves, with where they run and their context size.
    pub async fn model_info(&self) -> Result<Vec<ModelInfo>, String> {
        let reply = self.get("/models").await?;
        Ok(reply["data"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(|m| {
                Some(ModelInfo {
                    id: m["id"].as_str()?.to_owned(),
                    tier: m["invincible"]["tier"].as_str().unwrap_or("node").to_owned(),
                    context: m["invincible"]["context"].as_u64(),
                    healthy: m["invincible"]["healthy"].as_bool().unwrap_or(true),
                    vision: m["invincible"]["vision"].as_bool(),
                })
            })
            .collect())
    }

    /// The gateway's name and receipt key.
    pub async fn node(&self) -> Result<Value, String> {
        self.get("/node").await
    }

    async fn get(&self, path: &str) -> Result<Value, String> {
        let response = self
            .client
            .get(format!("{}{path}", self.url))
            .bearer_auth(&self.token)
            .send()
            .await
            .map_err(|e| self.unreachable(e))?;
        let status = response.status();
        let text = response.text().await.map_err(|e| e.to_string())?;
        if !status.is_success() {
            return Err(format!("{path}: {status}: {text}"));
        }
        serde_json::from_str(&text).map_err(|e| format!("{path}: {e}"))
    }

    fn unreachable(&self, e: reqwest::Error) -> String {
        if e.is_connect() {
            format!("Invincible Gateway is not running at {} (start it with `invincible serve`)", self.url)
        } else {
            format!("the gateway: {e}")
        }
    }
}

/// Whether a gateway's or a provider's error [message] says the request was longer than the
/// model's context (llama.cpp, OpenAI, Anthropic, DeepSeek and others word it differently).
pub fn overflow(message: &str) -> bool {
    let m = message.to_ascii_lowercase();
    [
        "exceeds the available context",
        "exceed_context_size",
        "context_length_exceeded",
        "maximum context length",
        "context length exceeded",
        "context window",
        "prompt is too long",
        "too many tokens",
        "reduce the length",
        "input is too long",
    ]
    .iter()
    .any(|p| m.contains(p))
}

/// [d] for a message: `600 s`, `300 ms`.
fn seconds(d: Duration) -> String {
    if d >= Duration::from_secs(1) { format!("{} s", d.as_secs()) } else { format!("{} ms", d.as_millis()) }
}

/// One try at the gateway that did not answer: try again (after the wait it asked for, if it
/// did), or not.
enum Attempt {
    Again(GatewayError, Option<Duration>),
    Final(GatewayError),
}

/// Why a stream did not end well: cut off (worth another try), or failed (the model's own
/// error, a hang).
enum Stream {
    Broken(String),
    Failed(String),
}

/// An answer streamed as server-sent events (OpenAI's chunk shape), put back together as one
/// message: its text, reasoning and tool calls (whose names and arguments come in pieces, by
/// index). Nothing for [idle] is a hang.
async fn read_stream(
    response: reqwest::Response,
    on: &(dyn Fn(Delta) + Send + Sync),
    idle: Duration,
) -> Result<(Value, Option<Value>), Stream> {
    use futures_util::StreamExt;
    let mut stream = response.bytes_stream();
    let mut pending: Vec<u8> = Vec::new();
    let mut assembled = Assembled::default();
    loop {
        let chunk = match tokio::time::timeout(idle, stream.next()).await {
            Err(_) => {
                return Err(Stream::Failed(format!("the model's answer stalled: nothing for {}", seconds(idle))));
            }
            Ok(None) => break,
            Ok(Some(chunk)) => chunk.map_err(|e| Stream::Broken(format!("the gateway's answer stopped: {e}")))?,
        };
        if assembled.feed(&mut pending, &chunk, on).map_err(Stream::Failed)? {
            let usage = assembled.usage.take();
            return Ok((assembled.message(), usage));
        }
    }
    let rest = String::from_utf8_lossy(&pending).into_owned();
    assembled.line(rest.trim(), on).map_err(Stream::Failed)?;
    let usage = assembled.usage.take();
    Ok((assembled.message(), usage))
}

/// How far past the tool calls so far a streamed call's index may point.
const MAX_CALL_GAP: usize = 64;

#[derive(Default)]
struct Assembled {
    text: String,
    reasoning: String,
    calls: Vec<(String, String, String)>,
    usage: Option<Value>,
}

impl Assembled {
    /// Takes in a [chunk] of the stream, [pending] holding a line not yet whole; true at its end.
    fn feed(
        &mut self,
        pending: &mut Vec<u8>,
        chunk: &[u8],
        on: &(dyn Fn(Delta) + Send + Sync),
    ) -> Result<bool, String> {
        pending.extend_from_slice(chunk);
        // Every whole line in what came, then what is left moved to the front once.
        let mut start = 0;
        while let Some(end) = pending[start..].iter().position(|b| *b == b'\n') {
            let line = String::from_utf8_lossy(&pending[start..start + end]);
            start += end + 1;
            if self.line(line.trim(), on)? {
                pending.clear();
                return Ok(true);
            }
        }
        pending.drain(..start);
        Ok(false)
    }

    /// Takes in one line of the stream; true at its end.
    fn line(&mut self, line: &str, on: &(dyn Fn(Delta) + Send + Sync)) -> Result<bool, String> {
        let Some(data) = line.strip_prefix("data:").map(str::trim) else { return Ok(false) };
        if data == "[DONE]" {
            return Ok(true);
        }
        let Ok(chunk) = serde_json::from_str::<Value>(data) else { return Ok(false) };
        if let Some(error) = chunk.get("error") {
            return Err(format!("the model failed: {}", error["message"].as_str().unwrap_or("error")));
        }
        if let Some(usage) = chunk.get("usage").filter(|u| u.is_object()) {
            self.usage = Some(usage.clone());
        }
        let delta = &chunk["choices"][0]["delta"];
        if let Some(text) = delta["content"].as_str().filter(|t| !t.is_empty()) {
            self.text.push_str(text);
            on(Delta::Text(text));
        }
        if let Some(text) = delta["reasoning_content"].as_str().filter(|t| !t.is_empty()) {
            self.reasoning.push_str(text);
            on(Delta::Reasoning(text));
        }
        for call in delta["tool_calls"].as_array().into_iter().flatten() {
            let id = call["id"].as_str().filter(|i| !i.is_empty());
            let name = call["function"]["name"].as_str().filter(|n| !n.is_empty());
            let index = match call["index"].as_u64() {
                Some(index) => index as usize,
                // No index (some servers send whole calls): a new call when it brings an id of its
                // own, or a name with no id after a named call; else more of the last one.
                None => match self.calls.last() {
                    None => 0,
                    Some((last_id, last_name, _)) => {
                        let new = match id {
                            Some(id) => !last_id.is_empty() && last_id != id,
                            None => name.is_some() && !last_name.is_empty(),
                        };
                        if new { self.calls.len() } else { self.calls.len() - 1 }
                    }
                },
            };
            // A server's index is not trusted with memory: far past the calls so far, it is noise.
            if index > self.calls.len() + MAX_CALL_GAP {
                continue;
            }
            while self.calls.len() <= index {
                self.calls.push(Default::default());
            }
            let slot = &mut self.calls[index];
            // An id comes once (some servers repeat it in every piece).
            if let Some(id) = id
                && slot.0.is_empty()
            {
                id.clone_into(&mut slot.0);
            }
            // So does a name, though some send it repeated, or in pieces.
            if let Some(name) = name
                && slot.1 != name
            {
                slot.1.push_str(name);
            }
            if let Some(arguments) = call["function"]["arguments"].as_str() {
                slot.2.push_str(arguments);
            }
        }
        Ok(false)
    }

    fn message(self) -> Value {
        let mut message = json!({ "role": "assistant", "content": self.text });
        if !self.reasoning.is_empty() {
            message["reasoning_content"] = self.reasoning.into();
        }
        let calls: Vec<Value> = self
            .calls
            .into_iter()
            .filter(|(_, name, _)| !name.is_empty())
            .map(|(id, name, arguments)| {
                json!({ "id": id, "type": "function", "function": { "name": name, "arguments": arguments } })
            })
            .collect();
        if !calls.is_empty() {
            message["tool_calls"] = calls.into();
        }
        message
    }
}

#[cfg(test)]
mod tests {
    use super::{Assembled, Delta};

    #[test]
    fn a_stream_is_put_back_together() {
        let seen = std::sync::Mutex::new(String::new());
        let on = |d: Delta| {
            if let Delta::Text(t) = d {
                seen.lock().unwrap().push_str(t);
            }
        };
        let mut a = Assembled::default();
        for line in [
            r#"data: {"choices":[{"delta":{"role":"assistant","content":"Hel"}}]}"#,
            r#"data: {"choices":[{"delta":{"content":"lo"}}]}"#,
            r#"data: {"choices":[{"delta":{"reasoning_content":"hm"}}]}"#,
            r#"data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"c1","function":{"name":"read_","arguments":"{\"pa"}}]}}]}"#,
            r#"data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"name":"file","arguments":"th\":\"a\"}"}}]}}]}"#,
            r#"data: {"choices":[{"delta":{"tool_calls":[{"index":1,"id":"c2","function":{"name":"list_dir","arguments":"{}"}}]}}]}"#,
            ": keep-alive",
        ] {
            assert!(!a.line(line, &on).unwrap());
        }
        assert!(a.line("data: [DONE]", &on).unwrap());
        assert_eq!(*seen.lock().unwrap(), "Hello");
        let m = a.message();
        assert_eq!(m["content"], "Hello");
        assert_eq!(m["reasoning_content"], "hm");
        assert_eq!(m["tool_calls"][0]["function"]["name"], "read_file");
        assert_eq!(m["tool_calls"][0]["function"]["arguments"], r#"{"path":"a"}"#);
        assert_eq!(m["tool_calls"][1]["id"], "c2");
        assert!(Assembled::default().line(r#"data: {"error":{"message":"boom"}}"#, &on).is_err());
        // Whole calls without an index, and ids and names repeated in every piece.
        let mut b = Assembled::default();
        for line in [
            r#"data: {"choices":[{"delta":{"tool_calls":[{"id":"a","function":{"name":"read_file","arguments":"{\"path\":\"x\"}"}}]}}]}"#,
            r#"data: {"choices":[{"delta":{"tool_calls":[{"id":"b","function":{"name":"list_dir","arguments":"{}"}}]}}]}"#,
            r#"data: {"choices":[{"delta":{"tool_calls":[{"index":2,"id":"c","function":{"name":"search","arguments":"{\"pat"}}]}}]}"#,
            r#"data: {"choices":[{"delta":{"tool_calls":[{"index":2,"id":"c","function":{"name":"search","arguments":"tern\":\"q\"}"}}]}}]}"#,
        ] {
            b.line(line, &on).unwrap();
        }
        let m = b.message();
        let calls = m["tool_calls"].as_array().unwrap();
        assert_eq!(calls.len(), 3, "{m}");
        assert_eq!(calls[0]["function"]["name"], "read_file");
        assert_eq!(calls[1]["function"]["name"], "list_dir");
        assert_eq!(calls[2]["id"], "c");
        assert_eq!(calls[2]["function"]["name"], "search");
        assert_eq!(calls[2]["function"]["arguments"], r#"{"pattern":"q"}"#);
    }

    /// A stream of random text, reasoning and tool-call pieces, as a server sends it.
    fn stream(g: &mut invincible::testgen::Gen) -> Vec<u8> {
        let mut out = String::new();
        for _ in 0..g.below(12) {
            let delta = match g.below(4) {
                0 => serde_json::json!({ "content": g.text(10) }),
                1 => serde_json::json!({ "reasoning_content": g.text(10) }),
                2 => {
                    let name = *g.pick(&["read_file", "list_dir", ""]);
                    serde_json::json!({ "tool_calls": [{
                        "index": g.below(3), "id": format!("c{}", g.below(3)),
                        "function": { "name": name, "arguments": g.text(8) },
                    }] })
                }
                _ => serde_json::json!({}),
            };
            let line = serde_json::json!({ "choices": [{ "index": 0, "delta": delta }] });
            out.push_str(&format!("data: {line}\n"));
            if g.one_in(2) {
                out.push('\n');
            }
            if g.one_in(8) {
                out.push_str(": keep-alive\n\n");
            }
            if g.one_in(10) {
                out.push_str("\r\n");
            }
        }
        if g.one_in(2) {
            out.push_str("data: {\"choices\":[],\"usage\":{\"prompt_tokens\":3,\"completion_tokens\":4}}\n\n");
        }
        out.push_str("data: [DONE]\n\n");
        out.into_bytes()
    }

    /// The message [parts] of a stream make, and the text handed on as it came.
    fn assemble(parts: &[&[u8]]) -> (Option<serde_json::Value>, String) {
        let seen = std::sync::Mutex::new(String::new());
        let on = |d: Delta| {
            if let Delta::Text(t) = d {
                seen.lock().unwrap().push_str(t);
            }
        };
        let mut a = Assembled::default();
        let mut pending = Vec::new();
        for part in parts {
            match a.feed(&mut pending, part, &on) {
                Ok(true) => return (Some(a.message()), seen.into_inner().unwrap()),
                Ok(false) => {}
                Err(e) => panic!("{e}"),
            }
        }
        (None, seen.into_inner().unwrap())
    }

    #[test]
    fn a_stream_assembles_the_same_however_it_is_cut() {
        invincible::testgen::cases("sse", |g| {
            let bytes = stream(g);
            let (whole, text) = assemble(&[&bytes]);
            let whole = whole.expect("the stream ends at [DONE]");
            assert_eq!(whole["content"].as_str().unwrap(), text, "streamed text is the answer's");
            let (cut, cut_text) = assemble(&g.split(&bytes));
            assert_eq!(cut, Some(whole));
            assert_eq!(cut_text, text);
        });
    }

    #[test]
    fn garbage_in_a_stream_is_skipped_not_fatal() {
        let pieces = [
            "data: ",
            "{",
            "}",
            "\n",
            "[DONE]",
            "\"choices\"",
            "\"delta\":",
            "null",
            "data: {\"choices\":[{\"delta\":{\"tool_calls\":[{\"index\":99999999999}]}}]}\n",
            "data: {\"choices\":[{\"delta\":{\"tool_calls\":[{\"index\":2000}]}}]}\n",
        ];
        invincible::testgen::cases("sse garbage", |g| {
            let mut bytes = g.assemble(&pieces, 20).into_bytes();
            bytes.extend(g.bytes(40));
            let on = |_: Delta| {};
            let mut a = Assembled::default();
            let mut pending = Vec::new();
            for part in g.split(&bytes) {
                if !matches!(a.feed(&mut pending, part, &on), Ok(false)) {
                    break;
                }
            }
            let _ = a.message();
        });
    }
}
