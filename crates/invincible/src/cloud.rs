//! Cloud backends: OpenAI-compatible chat completion endpoints (OpenAI, Anthropic's compatibility
//! endpoint, DeepSeek, OpenRouter, …). Every request is redacted before it leaves
//! (spec/redaction.md) and restored when it comes back. A backend that fails is marked down for a
//! while, and the router sends its requests elsewhere (spec/routing.md, `cloud-down`).

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use axum::body::{Body, Bytes};
use axum::http::{HeaderValue, StatusCode, header};
use axum::response::Response;
use invincible_policy::DataPolicy;
use serde_json::Value;
use tokio::time::Instant;

use crate::redact::{StreamRestorer, Vault, redact_request, restore_response};

/// How long a failed backend is skipped.
pub const DOWN_FOR: Duration = Duration::from_secs(30);

pub const REDACTED_HEADER: &str = "invincible-redacted";

pub struct CloudModel {
    pub id: String,
    /// The model name the provider expects.
    pub upstream_model: String,
    /// The OpenAI-compatible base, e.g. `https://api.anthropic.com/v1`.
    pub base_url: String,
    pub key: Option<String>,
    pub context: Option<u64>,
    pub data_policy: DataPolicy,
    /// Unusable for good (no key): never healthy.
    pub disabled: bool,
    down_until: Mutex<Option<Instant>>,
}

impl CloudModel {
    pub fn new(
        id: &str,
        upstream_model: &str,
        base_url: &str,
        key: Option<String>,
        context: Option<u64>,
        data_policy: DataPolicy,
    ) -> Self {
        Self {
            id: id.to_owned(),
            upstream_model: upstream_model.to_owned(),
            base_url: base_url.trim_end_matches('/').to_owned(),
            key,
            context,
            data_policy,
            disabled: false,
            down_until: Mutex::new(None),
        }
    }

    pub fn disabled(mut self) -> Self {
        self.disabled = true;
        self
    }

    pub fn healthy(&self) -> bool {
        !self.disabled && self.down_until.lock().expect("cloud lock").is_none_or(|until| Instant::now() >= until)
    }

    pub fn mark_down(&self) {
        *self.down_until.lock().expect("cloud lock") = Some(Instant::now() + DOWN_FOR);
    }
}

/// How a cloud call ended when it did not produce an answer to pass on.
pub enum CloudError {
    /// Unreachable, overloaded or failing (no connection, 429, 5xx): route elsewhere.
    Failover(String),
}

impl CloudModel {
    /// The host requests go to (for receipts and logs).
    pub fn host(&self) -> String {
        reqwest::Url::parse(&self.base_url).ok().and_then(|u| u.host_str().map(str::to_owned)).unwrap_or_default()
    }
}

/// The request [forward] sends to [model]: redacted, with the provider's model name, serialised;
/// and the vault that restores the answer.
pub fn prepare(model: &CloudModel, mut body: Value) -> (Vec<u8>, Vault) {
    let vault = redact_request(&mut body);
    body["model"] = Value::String(model.upstream_model.clone());
    (serde_json::to_vec(&body).expect("JSON serialises"), vault)
}

/// Sends a [prepare]d request to [model] and returns the restored answer. Bytes received from the
/// provider are added to [received].
pub async fn forward(
    client: &reqwest::Client,
    model: &CloudModel,
    body: Vec<u8>,
    vault: Vault,
    received: Arc<AtomicU64>,
) -> Result<Response, CloudError> {
    let streaming = serde_json::from_slice::<Value>(&body).ok().and_then(|b| b.get("stream").and_then(Value::as_bool))
        == Some(true);
    let mut request = client
        .post(format!("{}/chat/completions", model.base_url))
        .header(reqwest::header::CONTENT_TYPE, "application/json")
        .body(body);
    if let Some(key) = &model.key {
        request = request.bearer_auth(key);
    }
    let upstream = request.send().await.map_err(|e| CloudError::Failover(format!("unreachable: {e}")))?;
    let status = upstream.status();
    if status == reqwest::StatusCode::TOO_MANY_REQUESTS || status.is_server_error() {
        return Err(CloudError::Failover(format!("answered {status}")));
    }
    let found = vault.found();
    tracing::info!(model = %model.id, status = status.as_u16(), redacted = ?found, "cloud request");

    let content_type = upstream.headers().get(header::CONTENT_TYPE).cloned();
    let mut response = if streaming && status.is_success() {
        let state = (upstream, StreamRestorer::new(vault), false, received);
        let stream = futures_util::stream::unfold(state, |(mut upstream, mut restorer, done, received)| async move {
            if done {
                return None;
            }
            match upstream.chunk().await {
                Ok(Some(bytes)) => {
                    received.fetch_add(bytes.len() as u64, Ordering::Relaxed);
                    let out = Bytes::from(restorer.push(&bytes));
                    Some((Ok::<_, std::io::Error>(out), (upstream, restorer, false, received)))
                }
                Ok(None) => Some((Ok(Bytes::from(restorer.finish())), (upstream, restorer, true, received))),
                Err(e) => Some((Err(std::io::Error::other(e)), (upstream, restorer, true, received))),
            }
        });
        Response::new(Body::from_stream(stream))
    } else {
        let bytes = upstream.bytes().await.map_err(|e| CloudError::Failover(format!("answer cut off: {e}")))?;
        received.fetch_add(bytes.len() as u64, Ordering::Relaxed);
        let body = match serde_json::from_slice::<Value>(&bytes) {
            Ok(mut answer) => {
                restore_response(&vault, &mut answer);
                Body::from(answer.to_string())
            }
            // Not JSON (an error page): pass it on as it came.
            Err(_) => Body::from(bytes),
        };
        Response::new(body)
    };
    *response.status_mut() = StatusCode::from_u16(status.as_u16()).unwrap_or(StatusCode::BAD_GATEWAY);
    if let Some(content_type) = content_type.and_then(|v| HeaderValue::from_bytes(v.as_bytes()).ok()) {
        response.headers_mut().insert(header::CONTENT_TYPE, content_type);
    }
    if !found.is_empty()
        && let Ok(value) = HeaderValue::from_str(&serde_json::to_string(&found).expect("counts serialise"))
    {
        response.headers_mut().insert(REDACTED_HEADER, value);
    }
    Ok(response)
}
