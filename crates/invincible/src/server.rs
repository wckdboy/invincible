//! The node's OpenAI-compatible API. Every request goes through the router
//! (`invincible_policy::decide`); the decision travels back in the `invincible-decision` header.
//!
//! Clients that know about Invincible can say more about a request with headers:
//! - `invincible-private: 1` — must never leave hardware the user owns. Any value except `0`,
//!   `false` or `no` counts as private.
//! - `invincible-risk: health,personal` — risk codes (spec/routing.md).
//! - `invincible-confirmed: 1` — the user approved a cloud run (the answer to an `ask`).

use std::sync::Arc;

use axum::body::{Body, Bytes};
use axum::extract::{Path, Request as HttpRequest, State};
use axum::http::{HeaderMap, HeaderValue, StatusCode, header};
use axum::middleware::{self, Next};
use axum::response::{IntoResponse, Response};
use axum::routing::{delete, get, post};
use axum::{Json, Router};
use invincible_policy::{Action, DataPolicy, Decision, Model, NodeSettings, Reason, Request, RouteInput, Tier, decide};
use serde_json::{Value, json};

use crate::cloud::{CloudError, CloudModel};
use crate::engine::Engine;
use crate::remote::{CODE_LIFETIME, Pairing};

pub const DECISION_HEADER: &str = "invincible-decision";

pub struct AppState {
    pub engines: Vec<Engine>,
    pub node: NodeSettings,
    pub token: String,
    pub client: reqwest::Client,
    /// Remote access; `None` when the config does not enable it.
    pub pairing: Option<Arc<Pairing>>,
    pub cloud: Vec<CloudModel>,
    /// For requests that leave the node; `None` when the node is offline.
    pub egress: Option<reqwest::Client>,
}

impl AppState {
    pub fn new(engines: Vec<Engine>, node: NodeSettings, token: String) -> Self {
        // No overall timeout: a long generation is not a hung one. Connecting to a loopback
        // engine is instant or it is down.
        let client =
            reqwest::Client::builder().connect_timeout(std::time::Duration::from_secs(2)).build().expect("HTTP client");
        let egress = crate::egress::client(&node.network).ok();
        Self { engines, node, token, client, pairing: None, cloud: Vec::new(), egress }
    }

    pub fn with_cloud(mut self, cloud: Vec<CloudModel>) -> Self {
        self.cloud = cloud;
        self
    }

    /// Every model the router can choose from: the node's engines, then the cloud backends.
    fn route_models(&self) -> Vec<Model> {
        let node = self.engines.iter().map(|e| Model {
            id: e.id.clone(),
            tier: Tier::Node,
            healthy: e.healthy(),
            context: e.context,
            data_policy: DataPolicy::Owned,
        });
        let cloud = self.cloud.iter().map(|c| Model {
            id: c.id.clone(),
            tier: Tier::Cloud,
            healthy: c.healthy() && self.egress.is_some(),
            context: c.context,
            data_policy: c.data_policy,
        });
        node.chain(cloud).collect()
    }

    pub fn with_pairing(mut self, pairing: Arc<Pairing>) -> Self {
        self.pairing = Some(pairing);
        self
    }
}

/// The inference API, the same for every caller.
fn api() -> Router<Arc<AppState>> {
    Router::new().route("/v1/models", get(models)).route("/v1/chat/completions", post(chat_completions))
}

/// The loopback app: the API and the admin endpoints behind the token, plus `/health`.
pub fn app(state: Arc<AppState>) -> Router {
    let admin = Router::new()
        .route("/v1/admin/pairing", post(start_pairing))
        .route("/v1/admin/devices", get(list_devices))
        .route("/v1/admin/devices/{name}", delete(remove_device));
    let guarded = api().merge(admin).route_layer(middleware::from_fn_with_state(state.clone(), require_token));
    Router::new().route("/health", get(|| async { Json(json!({ "status": "ok" })) })).merge(guarded).with_state(state)
}

/// What paired devices reach through their encrypted session: the API only. They are
/// authenticated by their pinned key, so no token, and they cannot administer the node.
pub fn device_app(state: Arc<AppState>) -> Router {
    api().with_state(state)
}

async fn start_pairing(State(state): State<Arc<AppState>>) -> Response {
    let Some(pairing) = &state.pairing else {
        return error(
            StatusCode::CONFLICT,
            "remote_disabled",
            "remote access is off: set [remote] listen in the config",
        );
    };
    match pairing.start() {
        Ok(code) => Json(json!({
            "code": code.encode(),
            "node": pairing.name,
            "fingerprint": crate::devices::fingerprint(&pairing.key.public),
            "expires_in": CODE_LIFETIME.as_secs(),
        }))
        .into_response(),
        Err(e) => error(StatusCode::INTERNAL_SERVER_ERROR, "internal_error", &e),
    }
}

async fn list_devices(State(state): State<Arc<AppState>>) -> Json<Value> {
    let devices = state.pairing.as_ref().map(|p| p.devices.list()).unwrap_or_default();
    Json(json!({ "devices": devices }))
}

async fn remove_device(State(state): State<Arc<AppState>>, Path(name): Path<String>) -> Response {
    let Some(pairing) = &state.pairing else {
        return error(StatusCode::NOT_FOUND, "not_found", "no such device");
    };
    match pairing.devices.remove(&name) {
        Ok(true) => {
            tracing::info!(device = %name, "device unpaired");
            StatusCode::NO_CONTENT.into_response()
        }
        Ok(false) => error(StatusCode::NOT_FOUND, "not_found", "no such device"),
        Err(e) => error(StatusCode::INTERNAL_SERVER_ERROR, "internal_error", &e),
    }
}

async fn require_token(State(state): State<Arc<AppState>>, request: HttpRequest, next: Next) -> Response {
    let given = request
        .headers()
        .get(header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "))
        .unwrap_or("");
    if crate::token::matches(&state.token, given) {
        next.run(request).await
    } else {
        error(StatusCode::UNAUTHORIZED, "invalid_api_key", "missing or wrong token (see `invincible token`)")
    }
}

async fn models(State(state): State<Arc<AppState>>) -> Json<Value> {
    let data: Vec<Value> = state
        .route_models()
        .iter()
        .map(|m| {
            json!({
                "id": m.id,
                "object": "model",
                "owned_by": "invincible",
                "invincible": {
                    "tier": m.tier,
                    "healthy": m.healthy,
                    "context": m.context,
                    "data_policy": data_policy_code(m.data_policy),
                },
            })
        })
        .collect();
    Json(json!({ "object": "list", "data": data }))
}

fn data_policy_code(policy: DataPolicy) -> String {
    match policy {
        DataPolicy::Owned => "owned".into(),
        DataPolicy::NoRetention => "no-retention".into(),
        DataPolicy::Retention { days } => format!("retention:{days}"),
        DataPolicy::Trains => "trains".into(),
        DataPolicy::Unknown => "unknown".into(),
    }
}

async fn chat_completions(State(state): State<Arc<AppState>>, headers: HeaderMap, body: Bytes) -> Response {
    let Ok(parsed) = serde_json::from_slice::<Value>(&body) else {
        return error(StatusCode::BAD_REQUEST, "invalid_request_error", "the body is not JSON");
    };
    let request = route_request(&headers, &parsed);
    // A cloud backend that fails is marked down and the request is routed again; each round
    // takes one backend out, so this ends.
    let mut rounds = 0;
    let (decision, mut response) = loop {
        rounds += 1;
        let input = RouteInput { request: request.clone(), node: state.node.clone(), models: state.route_models() };
        let decision = decide(&input);
        let response = match (&decision.action, decision.tier) {
            (Action::Run, Some(Tier::Node)) => {
                let engine =
                    state.engines.iter().find(|e| Some(&e.id) == decision.model.as_ref()).expect("decided model");
                forward(&state.client, engine, body.clone()).await
            }
            (Action::Run, _) => {
                let cloud = state.cloud.iter().find(|c| Some(&c.id) == decision.model.as_ref()).expect("decided model");
                let client = state.egress.as_ref().expect("a healthy cloud model implies an egress client");
                match crate::cloud::forward(client, cloud, parsed.clone()).await {
                    Ok(response) => response,
                    Err(CloudError::Failover(why)) => {
                        tracing::warn!(model = %cloud.id, "cloud backend failed ({why}); routing again");
                        cloud.mark_down();
                        if rounds <= state.cloud.len() {
                            continue;
                        }
                        error(StatusCode::BAD_GATEWAY, "cloud_unavailable", "the cloud backend failed")
                    }
                }
            }
            (Action::Ask, _) => error(StatusCode::CONFLICT, "confirmation_required", ask_message(&decision)),
            (Action::Block, _) => error(
                block_status(decision.reason),
                "request_blocked",
                &format!("blocked: {}", reason_code(decision.reason)),
            ),
        };
        break (decision, response);
    };
    let decision_json = serde_json::to_string(&decision).expect("decision serialises");
    if let Ok(value) = HeaderValue::from_str(&decision_json) {
        response.headers_mut().insert(DECISION_HEADER, value);
    }
    response
}

/// The routing request for one chat completion.
fn route_request(headers: &HeaderMap, body: &Value) -> Request {
    let text = |name: &str| headers.get(name).and_then(|v| v.to_str().ok()).map(str::trim);
    let model = body.get("model").and_then(Value::as_str).filter(|m| !m.is_empty()).unwrap_or("auto");
    Request {
        model: model.to_owned(),
        private: text("invincible-private")
            .is_some_and(|v| !matches!(v.to_ascii_lowercase().as_str(), "0" | "false" | "no")),
        risk: text("invincible-risk")
            .map(|v| v.split(',').map(str::trim).filter(|r| !r.is_empty()).map(str::to_owned).collect())
            .unwrap_or_default(),
        prompt_tokens: estimate_tokens(body),
        confirmed: text("invincible-confirmed")
            .is_some_and(|v| matches!(v.to_ascii_lowercase().as_str(), "1" | "true")),
    }
}

/// Tokens the request needs: the messages at about four characters a token, plus the answer's
/// limit when the client sets one. Rough, and errs high.
fn estimate_tokens(body: &Value) -> u64 {
    let chars: usize = body
        .get("messages")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .map(|message| match message.get("content") {
            Some(Value::String(s)) => s.chars().count(),
            Some(Value::Array(parts)) => {
                parts.iter().filter_map(|p| p.get("text").and_then(Value::as_str)).map(|t| t.chars().count()).sum()
            }
            _ => 0,
        })
        .sum();
    let answer = ["max_completion_tokens", "max_tokens"].iter().find_map(|k| body.get(*k).and_then(Value::as_u64));
    (chars as u64).div_ceil(4) + answer.unwrap_or(0)
}

/// Sends the request to the engine unchanged and streams its answer back unchanged (SSE included).
async fn forward(client: &reqwest::Client, engine: &Engine, body: Bytes) -> Response {
    let url = format!("{}/v1/chat/completions", engine.base_url);
    let upstream = match client.post(&url).header(header::CONTENT_TYPE, "application/json").body(body).send().await {
        Ok(upstream) => upstream,
        Err(e) => {
            tracing::warn!(model = %engine.id, "engine unreachable: {e}");
            return error(StatusCode::BAD_GATEWAY, "engine_unreachable", "the engine did not answer");
        }
    };
    let status = StatusCode::from_u16(upstream.status().as_u16()).unwrap_or(StatusCode::BAD_GATEWAY);
    let content_type = upstream.headers().get(header::CONTENT_TYPE).cloned();
    let mut response = Response::new(Body::from_stream(upstream.bytes_stream()));
    *response.status_mut() = status;
    if let Some(content_type) = content_type.and_then(|v| HeaderValue::from_bytes(v.as_bytes()).ok()) {
        response.headers_mut().insert(header::CONTENT_TYPE, content_type);
    }
    response
}

fn block_status(reason: Reason) -> StatusCode {
    match reason {
        Reason::UnknownModel => StatusCode::NOT_FOUND,
        Reason::ModelUnavailable | Reason::NoModel => StatusCode::SERVICE_UNAVAILABLE,
        _ => StatusCode::FORBIDDEN,
    }
}

fn reason_code(reason: Reason) -> String {
    serde_json::to_value(reason).ok().and_then(|v| v.as_str().map(str::to_owned)).unwrap_or_default()
}

fn ask_message(decision: &Decision) -> &'static str {
    match decision.reason {
        Reason::Trains => "this model trains on prompts; send again with `invincible-confirmed: 1` to use it",
        Reason::Sensitive => "this request looks sensitive; send again with `invincible-confirmed: 1` to use the cloud",
        _ => "cloud use needs confirmation; send again with `invincible-confirmed: 1`",
    }
}

/// An error in the OpenAI shape.
fn error(status: StatusCode, code: &str, message: &str) -> Response {
    (status, Json(json!({ "error": { "message": message, "type": code, "code": code } }))).into_response()
}

#[cfg(test)]
mod tests {
    use super::estimate_tokens;
    use serde_json::json;

    #[test]
    fn estimates_text_and_parts_and_answer_limit() {
        let body = json!({
            "messages": [
                { "role": "system", "content": "12345678" },
                { "role": "user", "content": [{ "type": "text", "text": "abcd" }, { "type": "image_url" }] }
            ],
            "max_tokens": 100
        });
        assert_eq!(estimate_tokens(&body), 3 + 100);
        assert_eq!(estimate_tokens(&json!({})), 0);
    }
}
