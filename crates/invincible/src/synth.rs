//! Speech and images the node makes: `POST /v1/audio/speech` and `POST /v1/images/generations`,
//! in OpenAI's shapes, passed through to the backends in the config:
//!
//! ```toml
//! [[speech]]
//! id = "kokoro"                              # what requests name (`model`), or `auto`
//! base_url = "http://127.0.0.1:8880/v1"      # an OpenAI-compatible server on this machine
//! voice = "af_heart"                         # when a request names none
//!
//! [[images]]
//! id = "gpt-image"
//! base_url = "https://api.openai.com/v1"     # off the machine: HTTPS, and the routing rules
//! upstream_model = "gpt-image-1"
//! api_key_file = "keys/openai"
//! data_policy = "retention:30"
//! ```
//!
//! A backend on loopback is the node's own; any other is a cloud backend. The router decides as
//! for chat (spec/routing.md): local first, never the cloud for a private request, offline or
//! with `egress = "never"`, and only after the owner's yes when the rules ask. What goes to a
//! cloud backend is redacted first (the text to speak, the prompt), and every request gets a
//! signed receipt, as a chat completion does.

use std::sync::Arc;
use std::sync::atomic::AtomicU64;

use axum::Extension;
use axum::body::Body;
use axum::extract::State;
use axum::http::{HeaderMap, HeaderValue, StatusCode, header};
use axum::response::Response;
use invincible_policy::{Action, DataPolicy, Model, RouteInput, Tier, decide};
use serde_json::Value;

use crate::audit::Caller;
use crate::receipts::{Attempt, Draft};
use crate::server::{AppState, CLIENT_HEADER, DECISION_HEADER};

/// The longest text spoken or prompt drawn, in characters.
pub const MAX_TEXT: usize = 4096;

/// What a backend makes.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Kind {
    Speech,
    Images,
}

impl Kind {
    /// Its path under the backend's base URL.
    fn path(self) -> &'static str {
        match self {
            Self::Speech => "/audio/speech",
            Self::Images => "/images/generations",
        }
    }

    /// The field holding the text.
    fn field(self) -> &'static str {
        match self {
            Self::Speech => "input",
            Self::Images => "prompt",
        }
    }

    /// The API name in receipts and the audit log.
    fn api(self) -> &'static str {
        match self {
            Self::Speech => "speech",
            Self::Images => "images",
        }
    }
}

/// One speech or image backend.
pub struct Backend {
    pub id: String,
    pub upstream_model: String,
    pub base_url: String,
    pub key: Option<String>,
    pub tier: Tier,
    pub data_policy: DataPolicy,
    /// The voice when a request names none (speech).
    pub voice: Option<String>,
    disabled: bool,
    down_until: std::sync::Mutex<Option<tokio::time::Instant>>,
}

/// Whether [url] is on this machine.
pub fn on_loopback(url: &str) -> bool {
    reqwest::Url::parse(url).ok().and_then(|u| u.host_str().map(str::to_owned)).is_some_and(|h| {
        h == "localhost" || h.trim_matches(['[', ']']).parse::<std::net::IpAddr>().is_ok_and(|ip| ip.is_loopback())
    })
}

impl Backend {
    /// A backend at [base_url]: the node's own when it is on loopback, a cloud one otherwise.
    pub fn new(id: &str, upstream_model: &str, base_url: &str, key: Option<String>, data_policy: DataPolicy) -> Self {
        let tier = if on_loopback(base_url) { Tier::Node } else { Tier::Cloud };
        Self::with_tier(id, upstream_model, base_url, key, data_policy, tier)
    }

    /// A backend of [tier] wherever it is (tests put a "cloud" one on loopback).
    pub fn with_tier(
        id: &str,
        upstream_model: &str,
        base_url: &str,
        key: Option<String>,
        data_policy: DataPolicy,
        tier: Tier,
    ) -> Self {
        Self {
            id: id.to_owned(),
            upstream_model: upstream_model.to_owned(),
            base_url: base_url.trim_end_matches('/').to_owned(),
            key,
            tier,
            data_policy: if tier == Tier::Node { DataPolicy::Owned } else { data_policy },
            voice: None,
            disabled: false,
            down_until: std::sync::Mutex::new(None),
        }
    }

    pub fn with_voice(mut self, voice: Option<String>) -> Self {
        self.voice = voice;
        self
    }

    /// Unusable for good (its key could not be read).
    pub fn disabled(mut self) -> Self {
        self.disabled = true;
        self
    }

    pub fn healthy(&self) -> bool {
        !self.disabled
            && self.down_until.lock().expect("backend lock").is_none_or(|until| tokio::time::Instant::now() >= until)
    }

    fn mark_down(&self) {
        *self.down_until.lock().expect("backend lock") = Some(tokio::time::Instant::now() + crate::cloud::DOWN_FOR);
    }

    fn host(&self) -> String {
        reqwest::Url::parse(&self.base_url).ok().and_then(|u| u.host_str().map(str::to_owned)).unwrap_or_default()
    }

    /// As `GET /v1/node` lists it.
    pub fn to_json(&self) -> Value {
        serde_json::json!({
            "id": self.id,
            "tier": self.tier,
            "host": self.host(),
            "healthy": self.healthy(),
        })
    }
}

/// The backends in [config] (keys read relative to [home]); one whose key cannot be read is
/// kept, disabled, so the router says why.
pub fn from_config(list: &[crate::config::MediaConfig], home: &std::path::Path) -> Vec<Backend> {
    list.iter()
        .map(|c| {
            let upstream = c.upstream_model.clone().unwrap_or_else(|| c.id.clone());
            let policy = DataPolicy::parse(c.data_policy.as_deref().unwrap_or("unknown"));
            match c.key(home) {
                Ok(key) => Backend::new(&c.id, &upstream, &c.base_url, key, policy),
                Err(e) => {
                    tracing::warn!(backend = %c.id, "disabled: {e}");
                    Backend::new(&c.id, &upstream, &c.base_url, None, policy).disabled()
                }
            }
            .with_voice(c.voice.clone())
        })
        .collect()
}

pub async fn speech(
    state: State<Arc<AppState>>,
    caller: Option<Extension<Caller>>,
    headers: HeaderMap,
    body: axum::body::Bytes,
) -> Response {
    handle(state, caller, headers, body, Kind::Speech).await
}

pub async fn images(
    state: State<Arc<AppState>>,
    caller: Option<Extension<Caller>>,
    headers: HeaderMap,
    body: axum::body::Bytes,
) -> Response {
    handle(state, caller, headers, body, Kind::Images).await
}

async fn handle(
    State(state): State<Arc<AppState>>,
    caller: Option<Extension<Caller>>,
    headers: HeaderMap,
    body: axum::body::Bytes,
    kind: Kind,
) -> Response {
    use crate::server::error;
    let Ok(parsed) = serde_json::from_slice::<Value>(&body) else {
        return error(StatusCode::BAD_REQUEST, "invalid_request_error", "the body is not JSON");
    };
    let Some(text) = parsed.get(kind.field()).and_then(Value::as_str).filter(|t| !t.trim().is_empty()) else {
        return error(StatusCode::BAD_REQUEST, "invalid_request_error", &format!("`{}` is missing", kind.field()));
    };
    if text.chars().count() > MAX_TEXT {
        return error(
            StatusCode::BAD_REQUEST,
            "invalid_request_error",
            &format!("`{}` is longer than {MAX_TEXT} characters", kind.field()),
        );
    }
    let backends = match kind {
        Kind::Speech => &state.speech,
        Kind::Images => &state.images,
    };
    if backends.is_empty() {
        let what = match kind {
            Kind::Speech => "no speech backend: add one under [[speech]] in the node's config",
            Kind::Images => "no image backend: add one under [[images]] in the node's config",
        };
        return error(StatusCode::NOT_FOUND, "no_backend", what);
    }
    let mut request = crate::server::route_request(&headers, &parsed);
    request.prompt_tokens = (text.chars().count() as u64).div_ceil(4);
    let mut draft = match Draft::new() {
        Ok(draft) => draft,
        Err(e) => return error(StatusCode::INTERNAL_SERVER_ERROR, "internal_error", &e),
    };
    draft.api = kind.api();
    draft.caller = caller.map_or(Caller::Local, |Extension(c)| c);
    draft.client = headers
        .get(CLIENT_HEADER)
        .and_then(|v| v.to_str().ok())
        .map(|v| v.chars().filter(|c| c.is_ascii_graphic() || *c == ' ').take(64).collect::<String>())
        .filter(|v| !v.is_empty());
    let mut rounds = 0;
    let (decision, mut response) = loop {
        rounds += 1;
        let models: Vec<Model> = backends
            .iter()
            .map(|b| Model {
                id: b.id.clone(),
                tier: b.tier,
                healthy: b.healthy() && (b.tier == Tier::Node || state.egress.is_some()),
                context: None,
                data_policy: b.data_policy,
            })
            .collect();
        let decision = decide(&RouteInput { request: request.clone(), node: state.node.clone(), models });
        let response = match (&decision.action, decision.tier) {
            (Action::Run, tier) => {
                let backend = backends.iter().find(|b| Some(&b.id) == decision.model.as_ref()).expect("decided");
                let mut outgoing = parsed.clone();
                outgoing["model"] = Value::String(backend.upstream_model.clone());
                if kind == Kind::Speech
                    && outgoing.get("voice").is_none()
                    && let Some(voice) = &backend.voice
                {
                    outgoing["voice"] = Value::String(voice.clone());
                }
                if kind == Kind::Images && outgoing.get("response_format").is_none() {
                    outgoing["response_format"] = Value::String("b64_json".to_owned());
                }
                let cloud = tier != Some(Tier::Node);
                let client = if cloud {
                    state.egress.clone().expect("a healthy cloud backend implies an egress client")
                } else {
                    state.client.clone()
                };
                draft.data_policy = Some(crate::server::data_policy_code(backend.data_policy));
                let received = Arc::new(AtomicU64::new(0));
                if cloud {
                    // Nothing personal leaves: the text is redacted (a spoken placeholder, a prompt
                    // without the name), and the receipt says what was.
                    let mut vault = crate::redact::Vault::default();
                    let redacted = vault.redact(text);
                    for (kind, n) in vault.found() {
                        let seen = draft.redactions.entry(kind).or_insert(0);
                        *seen = (*seen).max(n);
                    }
                    outgoing[kind.field()] = Value::String(redacted);
                }
                let bytes = serde_json::to_vec(&outgoing).expect("JSON serialises");
                if cloud {
                    draft.attempts.push(Attempt {
                        route: crate::egress::route(&state.node.network, &backend.host()),
                        host: backend.host(),
                        sent: bytes.len() as u64,
                        received: received.clone(),
                        ok: true,
                    });
                }
                match send(&client, backend, kind, bytes, received).await {
                    Ok(response) => response,
                    Err(why) => {
                        tracing::warn!(backend = %backend.id, "{} backend failed ({why})", kind.api());
                        backend.mark_down();
                        if let Some(attempt) = draft.attempts.last_mut().filter(|_| cloud) {
                            attempt.ok = false;
                        }
                        draft.data_policy = None;
                        if rounds <= backends.len() {
                            continue;
                        }
                        error(
                            StatusCode::BAD_GATEWAY,
                            "backend_unavailable",
                            &format!("the {} backend failed", kind.api()),
                        )
                    }
                }
            }
            (Action::Ask, _) => {
                error(StatusCode::CONFLICT, "confirmation_required", crate::server::ask_message(&decision))
            }
            (Action::Block, _) => error(
                crate::server::block_status(decision.reason),
                "request_blocked",
                &format!("blocked: {}", crate::server::reason_code(decision.reason)),
            ),
        };
        break (decision, response);
    };
    if let Ok(value) = HeaderValue::from_str(&serde_json::to_string(&decision).expect("decision serialises")) {
        response.headers_mut().insert(DECISION_HEADER, value);
    }
    draft.decision = Some(decision);
    crate::receipts::attach(
        response,
        Arc::new(std::sync::Mutex::new(draft)),
        state.receipt_key.clone(),
        state.receipts.clone(),
        state.audit.clone(),
    )
}

/// The backend's answer, passed on as it came (audio bytes, or the images' JSON); an error to
/// route around when it is unreachable or failing (429, 5xx).
async fn send(
    client: &reqwest::Client,
    backend: &Backend,
    kind: Kind,
    body: Vec<u8>,
    received: Arc<AtomicU64>,
) -> Result<Response, String> {
    let mut request = client
        .post(format!("{}{}", backend.base_url, kind.path()))
        .header(reqwest::header::CONTENT_TYPE, "application/json")
        .timeout(std::time::Duration::from_secs(300))
        .body(body);
    if let Some(key) = &backend.key {
        request = request.bearer_auth(key);
    }
    let upstream = request.send().await.map_err(|e| format!("unreachable: {}", e.without_url()))?;
    let status = upstream.status();
    if status == reqwest::StatusCode::TOO_MANY_REQUESTS || status.is_server_error() {
        return Err(format!("answered {status}"));
    }
    let content_type = upstream.headers().get(header::CONTENT_TYPE).cloned();
    let bytes = upstream.bytes().await.map_err(|e| format!("answer cut off: {}", e.without_url()))?;
    received.fetch_add(bytes.len() as u64, std::sync::atomic::Ordering::Relaxed);
    let mut response = Response::new(Body::from(bytes));
    *response.status_mut() = StatusCode::from_u16(status.as_u16()).unwrap_or(StatusCode::BAD_GATEWAY);
    if let Some(content_type) = content_type.and_then(|v| HeaderValue::from_bytes(v.as_bytes()).ok()) {
        response.headers_mut().insert(header::CONTENT_TYPE, content_type);
    }
    Ok(response)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_backend_on_loopback_is_the_nodes_own() {
        let local = Backend::new("k", "k", "http://127.0.0.1:8880/v1/", None, DataPolicy::Trains);
        assert_eq!(local.tier, Tier::Node);
        assert_eq!(local.data_policy, DataPolicy::Owned, "nothing leaves");
        assert_eq!(local.base_url, "http://127.0.0.1:8880/v1");
        let cloud = Backend::new("o", "gpt-image-1", "https://api.openai.com/v1", None, DataPolicy::NoRetention);
        assert_eq!(cloud.tier, Tier::Cloud);
        assert_eq!(cloud.to_json()["host"], "api.openai.com");
        assert!(on_loopback("http://localhost:1/v1") && on_loopback("http://[::1]:1/v1"));
        assert!(!on_loopback("http://192.168.1.4:1/v1"));
        assert!(!Backend::new("d", "d", "http://127.0.0.1:1", None, DataPolicy::Owned).disabled().healthy());
    }
}
