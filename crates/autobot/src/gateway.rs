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
        let client = reqwest::Client::builder()
            .no_proxy()
            .connect_timeout(Duration::from_secs(10))
            .build()
            .map_err(|e| e.to_string())?;
        Ok(Self {
            client,
            url: url.trim_end_matches('/').to_owned(),
            token: token.to_owned(),
            model: model.to_owned(),
            private,
            stream: false,
        })
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
    pub async fn chat_with(
        &self,
        messages: &[Value],
        tools: &Value,
        confirmed: bool,
        on: &(dyn Fn(Delta) + Send + Sync),
    ) -> Result<Reply, GatewayError> {
        let mut body = json!({ "model": self.model, "messages": messages, "stream": self.stream });
        if self.stream {
            body["stream_options"] = json!({ "include_usage": true });
        }
        if tools.as_array().is_some_and(|t| !t.is_empty()) {
            body["tools"] = tools.clone();
        }
        let mut request =
            self.client.post(format!("{}/chat/completions", self.url)).bearer_auth(&self.token).json(&body);
        request = request.header(invincible::server::CLIENT_HEADER, "autobot-agent");
        if self.private {
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
        let streamed = response
            .headers()
            .get(reqwest::header::CONTENT_TYPE)
            .and_then(|v| v.to_str().ok())
            .is_some_and(|t| t.starts_with("text/event-stream"));
        if status.is_success() && streamed {
            let (message, usage) = read_stream(response, on).await.map_err(GatewayError::Failed)?;
            return Ok(Reply { message, request_id, decision, usage });
        }
        let text = response.text().await.map_err(|e| GatewayError::Failed(format!("the gateway's answer: {e}")))?;
        let parsed: Value = serde_json::from_str(&text).unwrap_or(Value::Null);
        if !status.is_success() {
            let message = parsed["error"]["message"].as_str().map(str::to_owned).unwrap_or(text);
            if message.contains("no-model") {
                let hint = if self.private {
                    "no local model is ready, and this turn is private (local only): wait for the model to load, or allow cloud models (`/private off`, `--model <cloud model>`, or [gateway] private = false)"
                } else {
                    "no model is ready: wait for a local one to load, or add a cloud model (`invincible cloud add`)"
                };
                return Err(GatewayError::Failed(format!("the gateway refused ({status}): {message}: {hint}")));
            }
            return Err(if status == reqwest::StatusCode::CONFLICT {
                GatewayError::Confirm(message)
            } else {
                GatewayError::Failed(format!("the gateway refused ({status}): {message}"))
            });
        }
        let message = parsed["choices"][0]["message"].clone();
        if !message.is_object() {
            return Err(GatewayError::Failed(format!("the gateway's answer has no message: {text}")));
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

/// An answer streamed as server-sent events (OpenAI's chunk shape), put back together as one
/// message: its text, reasoning and tool calls (whose names and arguments come in pieces, by
/// index).
async fn read_stream(
    response: reqwest::Response,
    on: &(dyn Fn(Delta) + Send + Sync),
) -> Result<(Value, Option<Value>), String> {
    use futures_util::StreamExt;
    let mut stream = response.bytes_stream();
    let mut pending: Vec<u8> = Vec::new();
    let mut assembled = Assembled::default();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| format!("the gateway's answer stopped: {e}"))?;
        pending.extend_from_slice(&chunk);
        while let Some(end) = pending.iter().position(|b| *b == b'\n') {
            let line: Vec<u8> = pending.drain(..=end).collect();
            let line = String::from_utf8_lossy(&line);
            if assembled.line(line.trim(), on)? {
                let usage = assembled.usage.take();
                return Ok((assembled.message(), usage));
            }
        }
    }
    let rest = String::from_utf8_lossy(&pending).into_owned();
    assembled.line(rest.trim(), on)?;
    let usage = assembled.usage.take();
    Ok((assembled.message(), usage))
}

#[derive(Default)]
struct Assembled {
    text: String,
    reasoning: String,
    calls: Vec<(String, String, String)>,
    usage: Option<Value>,
}

impl Assembled {
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
}
