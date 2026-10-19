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
}

/// One answer: the assistant message, and what the gateway says about it.
#[derive(Debug)]
pub struct Reply {
    pub message: Value,
    /// The receipt's id (`GET /v1/receipts/{id}`).
    pub request_id: Option<String>,
    /// The routing decision (spec/routing.md).
    pub decision: Option<Value>,
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
        })
    }

    pub fn model(&self) -> &str {
        &self.model
    }

    /// The same gateway, asking for [model].
    pub fn with_model(&self, model: &str) -> Self {
        Self { model: model.to_owned(), ..self.clone() }
    }

    /// One chat completion with [tools]; [confirmed] answers a [GatewayError::Confirm].
    pub async fn chat(&self, messages: &[Value], tools: &Value, confirmed: bool) -> Result<Reply, GatewayError> {
        let mut body = json!({ "model": self.model, "messages": messages, "stream": false });
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
        let text = response.text().await.map_err(|e| GatewayError::Failed(format!("the gateway's answer: {e}")))?;
        let parsed: Value = serde_json::from_str(&text).unwrap_or(Value::Null);
        if !status.is_success() {
            let message = parsed["error"]["message"].as_str().map(str::to_owned).unwrap_or(text);
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
        Ok(Reply { message, request_id, decision })
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
