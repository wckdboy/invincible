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
use axum::extract::{DefaultBodyLimit, Path, Request as HttpRequest, State};
use axum::http::{HeaderMap, HeaderValue, StatusCode, header};
use axum::middleware::{self, Next};
use axum::response::{IntoResponse, Response};
use axum::routing::{any, delete, get, post};
use axum::{Extension, Json, Router};
use invincible_policy::{Action, DataPolicy, Decision, Model, NodeSettings, Reason, Request, RouteInput, Tier, decide};
use serde_json::{Value, json};

use crate::audit::{AuditLog, Caller};
use crate::cloud::{CloudError, CloudModel};
use crate::engine::Engine;
use crate::receipts::{Attempt, Draft, ReceiptKey, ReceiptStore};
use crate::remote::{CODE_LIFETIME, Pairing};

pub const DECISION_HEADER: &str = "invincible-decision";
/// Set by the gateway on requests it passes to the agent: `local` or `device:<name>`.
pub const CALLER_HEADER: &str = "invincible-caller";
/// Names the program sending a request (`autobot-agent`), for the audit log.
pub const CLIENT_HEADER: &str = "invincible-client";
/// The largest inference request taken: room for a conversation with several images (a
/// downscaled screenshot is a few hundred KiB in base64; providers take up to 20 MB each).
pub const MAX_REQUEST: usize = 32 * 1024 * 1024;

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
    pub name: String,
    pub receipt_key: Arc<ReceiptKey>,
    pub receipts: Arc<ReceiptStore>,
    /// Where every answered request is logged (spec/audit.md); `None` keeps no log.
    pub audit: Option<Arc<AuditLog>>,
    /// The Autobot Agent's API on this machine (spec/agent.md).
    pub agent_url: String,
    /// Speech and image backends ([crate::synth]).
    pub speech: Vec<crate::synth::Backend>,
    pub images: Vec<crate::synth::Backend>,
}

impl AppState {
    pub fn new(engines: Vec<Engine>, node: NodeSettings, token: String) -> Self {
        // No overall timeout: a long generation is not a hung one. Connecting to a loopback
        // engine is instant or it is down.
        let client =
            reqwest::Client::builder().connect_timeout(std::time::Duration::from_secs(2)).build().expect("HTTP client");
        let egress = crate::egress::client(&node.network).ok();
        // An ephemeral receipt key until the node's own is set ([AppState::with_receipt_key]).
        let receipt_key = Arc::new(ReceiptKey::from_seed(&crate::token::random::<32>().expect("random bytes")));
        Self {
            engines,
            node,
            token,
            client,
            pairing: None,
            cloud: Vec::new(),
            egress,
            name: "invincible".to_owned(),
            receipt_key,
            receipts: Arc::default(),
            audit: None,
            agent_url: "http://127.0.0.1:7792".to_owned(),
            speech: Vec::new(),
            images: Vec::new(),
        }
    }

    /// With speech and image backends ([crate::synth]).
    pub fn with_media(mut self, speech: Vec<crate::synth::Backend>, images: Vec<crate::synth::Backend>) -> Self {
        self.speech = speech;
        self.images = images;
        self
    }

    pub fn with_agent(mut self, url: &str) -> Self {
        self.agent_url = url.trim_end_matches('/').to_owned();
        self
    }

    pub fn with_audit(mut self, audit: AuditLog) -> Self {
        self.audit = Some(Arc::new(audit));
        self
    }

    pub fn with_receipt_key(mut self, name: &str, key: ReceiptKey) -> Self {
        self.name = name.to_owned();
        self.receipt_key = Arc::new(key);
        self
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

    /// Whether model [id] takes images (None: not known, or no such model).
    pub fn vision(&self, id: &str) -> Option<bool> {
        let engine = self.engines.iter().find(|e| e.id == id).map(|e| e.vision);
        engine.or_else(|| self.cloud.iter().find(|c| c.id == id).map(|c| c.vision)).flatten()
    }

    pub fn with_pairing(mut self, pairing: Arc<Pairing>) -> Self {
        self.pairing = Some(pairing);
        self
    }
}

/// The inference API, the same for every caller.
fn api() -> Router<Arc<AppState>> {
    Router::new()
        .route("/v1/models", get(models))
        .route("/v1/chat/completions", post(chat_completions).layer(DefaultBodyLimit::max(MAX_REQUEST)))
        .route("/v1/messages", post(messages).layer(DefaultBodyLimit::max(MAX_REQUEST)))
        .route("/v1/audio/speech", post(crate::synth::speech))
        .route("/v1/images/generations", post(crate::synth::images))
        .route("/v1/receipts/{id}", get(receipt))
        .route("/v1/audit", get(audit))
        .route("/v1/node", get(node_info))
        .route("/v1/agent", any(agent))
        .route("/v1/agent/{*rest}", any(agent))
}

/// A path the agent proxy passes on: under `/v1/agent`, plain segments only (no `.`/`..`, no
/// encoded dots or slashes, no backslashes), so it cannot be steered at another path there.
fn agent_path(path_and_query: &str) -> bool {
    let path = path_and_query.split('?').next().unwrap_or_default();
    let lower = path.to_ascii_lowercase();
    (path == "/v1/agent" || path.starts_with("/v1/agent/"))
        && !lower.contains("%2e")
        && !lower.contains("%2f")
        && !lower.contains("%5c")
        && !path.contains('\\')
        && path.split('/').skip(1).all(|segment| !segment.is_empty() && segment != "." && segment != "..")
}

/// Passes `/v1/agent` through to the Autobot Agent on this machine, with the node's token, and
/// streams its answer back (turns are event streams). Callers here are already trusted: the
/// local app checked the token, a device was checked by its pinned key.
async fn agent(
    State(state): State<Arc<AppState>>,
    caller: Option<Extension<Caller>>,
    request: HttpRequest,
) -> Response {
    let path = request.uri().path_and_query().map_or("/v1/agent", |p| p.as_str()).to_owned();
    if !agent_path(&path) {
        return error(StatusCode::NOT_FOUND, "not_found", "no such agent path");
    }
    let method = request.method().clone();
    let content_type = request.headers().get(header::CONTENT_TYPE).cloned();
    let body = match axum::body::to_bytes(request.into_body(), 1 << 20).await {
        Ok(body) => body,
        Err(_) => return error(StatusCode::PAYLOAD_TOO_LARGE, "invalid_request_error", "the body is too large"),
    };
    let mut forward =
        state.client.request(method, format!("{}{path}", state.agent_url)).bearer_auth(&state.token).body(body);
    if let Some(content_type) = content_type {
        forward = forward.header(header::CONTENT_TYPE, content_type);
    }
    // Who is asking, for the agent's records (a recipe's origin); only the gateway can say.
    forward = forward.header(CALLER_HEADER, caller.map_or(Caller::Local, |Extension(c)| c).code());
    let upstream = match forward.send().await {
        Ok(upstream) => upstream,
        Err(e) => {
            tracing::debug!("agent unreachable: {e}");
            return error(
                StatusCode::SERVICE_UNAVAILABLE,
                "agent_unavailable",
                "the Autobot Agent is not running on this machine (`autobot serve`)",
            );
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

async fn receipt(State(state): State<Arc<AppState>>, Path(id): Path<String>) -> Response {
    if let Some(envelope) = state.receipts.get(&id).await {
        return Json(envelope).into_response();
    }
    // Older than the ones kept in memory (or from before a restart): the audit log has it.
    let found = match state.audit.clone() {
        Some(log) if id.len() == 32 && id.bytes().all(|b| b.is_ascii_hexdigit()) => {
            tokio::task::spawn_blocking(move || log.find(&id)).await.ok().flatten()
        }
        _ => None,
    };
    match found {
        Some(envelope) => Json(envelope).into_response(),
        None => error(StatusCode::NOT_FOUND, "not_found", "no such receipt"),
    }
}

#[derive(serde::Deserialize)]
struct AuditQuery {
    /// Unix seconds.
    #[serde(default)]
    since: u64,
    limit: Option<usize>,
}

/// The newest audit entries (at most 500), oldest first, with totals over them.
async fn audit(
    State(state): State<Arc<AppState>>,
    axum::extract::Query(q): axum::extract::Query<AuditQuery>,
) -> Response {
    let Some(log) = state.audit.clone() else {
        return Json(json!({ "entries": [], "summary": crate::audit::summary(&[]), "kept": false })).into_response();
    };
    let limit = q.limit.unwrap_or(100).clamp(1, 500);
    let entries = tokio::task::spawn_blocking(move || log.read(q.since, limit)).await.unwrap_or_default();
    let summary = crate::audit::summary(&entries);
    Json(json!({ "entries": entries, "summary": summary, "kept": true })).into_response()
}

async fn node_info(State(state): State<Arc<AppState>>) -> Json<Value> {
    let list =
        |backends: &[crate::synth::Backend]| backends.iter().map(crate::synth::Backend::to_json).collect::<Vec<_>>();
    Json(json!({
        "name": state.name,
        "receipt_key": state.receipt_key.public(),
        "speech": list(&state.speech),
        "images": list(&state.images),
    }))
}

/// `GET /healthz`: unauthenticated, and says only that the node answers and its version (for the
/// watchdog, the installer and monitoring).
pub async fn healthz() -> Json<Value> {
    Json(json!({ "status": "ok", "version": crate::version::VERSION }))
}

/// The loopback app: the API and the admin endpoints behind the token, plus `/health` and
/// `/healthz`.
pub fn app(state: Arc<AppState>) -> Router {
    let admin = Router::new()
        .route("/v1/fetch", post(fetch))
        .route("/v1/admin/pairing", post(start_pairing))
        .route("/v1/admin/devices", get(list_devices))
        .route("/v1/admin/devices/{name}", delete(remove_device));
    let guarded = api().merge(admin).route_layer(middleware::from_fn_with_state(state.clone(), require_token));
    Router::new()
        .route("/health", get(|| async { Json(json!({ "status": "ok" })) }))
        .route("/healthz", get(healthz))
        .merge(guarded)
        .with_state(state)
}

/// What paired devices reach through their encrypted session: the API only. They are
/// authenticated by their pinned key, so no token, and they cannot administer the node.
pub fn device_app(state: Arc<AppState>) -> Router {
    api().with_state(state)
}

/// `POST /v1/fetch {"url"}`: a web page through the node's network policy, receipted
/// (crate::fetch). Loopback API only.
async fn fetch(State(state): State<Arc<AppState>>, headers: HeaderMap, Json(body): Json<Value>) -> Response {
    let Some(url) = body["url"].as_str() else {
        return error(StatusCode::BAD_REQUEST, "invalid_request_error", "the body is {\"url\": \"https://…\"}");
    };
    let Some(client) = state.egress.clone() else {
        return error(StatusCode::FORBIDDEN, "offline", "the node is offline ([node] network = \"offline\")");
    };
    let host = match crate::egress::check(url) {
        Ok(parsed) if parsed.scheme() == "https" => parsed.host_str().unwrap_or_default().to_owned(),
        _ => return error(StatusCode::BAD_REQUEST, "invalid_request_error", "only https:// URLs"),
    };
    let mut draft = match Draft::new() {
        Ok(draft) => draft,
        Err(e) => return error(StatusCode::INTERNAL_SERVER_ERROR, "internal_error", &e),
    };
    draft.api = "fetch";
    draft.client = headers.get(CLIENT_HEADER).and_then(|v| v.to_str().ok()).map(|v| v.chars().take(64).collect());
    let received = Arc::new(std::sync::atomic::AtomicU64::new(0));
    let result = crate::fetch::get(&client, url, received.clone()).await;
    draft.attempts.push(Attempt {
        host,
        route: crate::egress::route(&state.node.network),
        sent: url.len() as u64,
        received,
        ok: result.is_ok(),
    });
    let response = match result {
        Ok(page) => Json(json!({
            "url": url,
            "status": page.status,
            "content_type": page.content_type,
            "text": page.text,
            "truncated": page.truncated,
        }))
        .into_response(),
        Err(e) => error(StatusCode::BAD_GATEWAY, "fetch_failed", &e),
    };
    crate::receipts::attach(
        response,
        Arc::new(std::sync::Mutex::new(draft)),
        state.receipt_key.clone(),
        state.receipts.clone(),
        state.audit.clone(),
    )
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
                    "vision": state.vision(&m.id),
                },
            })
        })
        .collect();
    Json(json!({ "object": "list", "data": data }))
}

pub(crate) fn data_policy_code(policy: DataPolicy) -> String {
    match policy {
        DataPolicy::Owned => "owned".into(),
        DataPolicy::NoRetention => "no-retention".into(),
        DataPolicy::Retention { days } => format!("retention:{days}"),
        DataPolicy::Trains => "trains".into(),
        DataPolicy::Unknown => "unknown".into(),
    }
}

/// The two inference APIs the node speaks.
#[derive(Clone, Copy, PartialEq, Eq)]
enum Api {
    /// OpenAI chat completions: node engines and cloud backends.
    Chat,
    /// Anthropic Messages: node engines only (llama.cpp speaks it natively), so it never leaves
    /// the node until cloud backends can be reached in that format.
    Messages,
}

impl Api {
    fn path(self) -> &'static str {
        match self {
            Self::Chat => "/v1/chat/completions",
            Self::Messages => "/v1/messages",
        }
    }
}

async fn chat_completions(
    state: State<Arc<AppState>>,
    caller: Option<Extension<Caller>>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    infer(state, caller, headers, body, Api::Chat).await
}

async fn messages(
    state: State<Arc<AppState>>,
    caller: Option<Extension<Caller>>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    infer(state, caller, headers, body, Api::Messages).await
}

async fn infer(
    State(state): State<Arc<AppState>>,
    caller: Option<Extension<Caller>>,
    headers: HeaderMap,
    body: Bytes,
    api: Api,
) -> Response {
    let Ok(parsed) = serde_json::from_slice::<Value>(&body) else {
        return error(StatusCode::BAD_REQUEST, "invalid_request_error", "the body is not JSON");
    };
    let request = route_request(&headers, &parsed);
    let mut draft = match Draft::new() {
        Ok(draft) => draft,
        Err(e) => return error(StatusCode::INTERNAL_SERVER_ERROR, "internal_error", &e),
    };
    // Images go on as they came; the receipt notes each by hash, size and type.
    let images = crate::media::images(&parsed);
    draft.images = images.iter().map(crate::media::Image::to_json).collect();
    draft.caller = caller.map_or(Caller::Local, |Extension(c)| c);
    draft.client = headers
        .get(CLIENT_HEADER)
        .and_then(|v| v.to_str().ok())
        .map(|v| v.chars().filter(|c| c.is_ascii_graphic() || *c == ' ').take(64).collect::<String>())
        .filter(|v| !v.is_empty());
    draft.api = match api {
        Api::Chat => "chat",
        Api::Messages => "messages",
    };
    // A cloud backend that fails is marked down and the request is routed again; each round
    // takes one backend out, so this ends.
    let mut rounds = 0;
    let (decision, mut response) = loop {
        rounds += 1;
        let mut models: Vec<Model> = match api {
            Api::Chat => state.route_models(),
            Api::Messages => state.route_models().into_iter().filter(|m| m.tier == Tier::Node).collect(),
        };
        // An automatic choice with images only considers models that may see them; a model
        // asked for by name is kept, and refused below if it is known to be blind.
        if !images.is_empty() && request.model == "auto" {
            models.retain(|m| state.vision(&m.id) != Some(false));
        }
        let input = RouteInput { request: request.clone(), node: state.node.clone(), models };
        let decision = decide(&input);
        // A model known not to take images is not sent them: it would fail, or answer blind.
        if let (Action::Run, Some(model)) = (&decision.action, &decision.model)
            && !images.is_empty()
            && state.vision(model) == Some(false)
        {
            let message = format!(
                "{model} can't see images; ask for a model that can (`vision = true` in its config, or a projector, `mmproj`, for a local model)"
            );
            break (decision, error(StatusCode::BAD_REQUEST, "model_cannot_see_images", &message));
        }
        let response = match (&decision.action, decision.tier) {
            (Action::Run, Some(Tier::Node)) => {
                let engine =
                    state.engines.iter().find(|e| Some(&e.id) == decision.model.as_ref()).expect("decided model");
                draft.data_policy = Some("owned".to_owned());
                forward(&state.client, engine, api.path(), body.clone()).await
            }
            (Action::Run, _) => {
                let cloud = state.cloud.iter().find(|c| Some(&c.id) == decision.model.as_ref()).expect("decided model");
                let client = state.egress.as_ref().expect("a healthy cloud model implies an egress client");
                let (outgoing, vault) = crate::cloud::prepare(cloud, parsed.clone());
                for (kind, n) in vault.found() {
                    let seen = draft.redactions.entry(kind).or_insert(0);
                    *seen = (*seen).max(n);
                }
                let received = Arc::new(std::sync::atomic::AtomicU64::new(0));
                draft.attempts.push(Attempt {
                    host: cloud.host(),
                    route: crate::egress::route(&state.node.network),
                    sent: outgoing.len() as u64,
                    received: received.clone(),
                    ok: true,
                });
                draft.data_policy = Some(data_policy_code(cloud.data_policy));
                match crate::cloud::forward(client, cloud, outgoing, vault, received).await {
                    Ok(response) => response,
                    Err(CloudError::Failover(why)) => {
                        tracing::warn!(model = %cloud.id, "cloud backend failed ({why}); routing again");
                        cloud.mark_down();
                        if let Some(attempt) = draft.attempts.last_mut() {
                            attempt.ok = false;
                        }
                        draft.data_policy = None;
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
    draft.decision = Some(decision);
    crate::receipts::attach(
        response,
        Arc::new(std::sync::Mutex::new(draft)),
        state.receipt_key.clone(),
        state.receipts.clone(),
        state.audit.clone(),
    )
}

/// The routing request for one chat completion.
pub(crate) fn route_request(headers: &HeaderMap, body: &Value) -> Request {
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

/// Tokens one image counts for in [estimate_tokens] (a downscaled image is 1–2k).
const IMAGE_TOKENS: u64 = 1_600;

/// Tokens the request needs: the messages at about four characters a token, images at
/// [IMAGE_TOKENS], plus the answer's limit when the client sets one. Rough, and errs high.
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
    // Anthropic Messages puts the system prompt beside the messages (a string or text blocks).
    let system: usize = match body.get("system") {
        Some(Value::String(s)) => s.chars().count(),
        Some(Value::Array(parts)) => {
            parts.iter().filter_map(|p| p.get("text").and_then(Value::as_str)).map(|t| t.chars().count()).sum()
        }
        _ => 0,
    };
    let answer = ["max_completion_tokens", "max_tokens"].iter().find_map(|k| body.get(*k).and_then(Value::as_u64));
    let images = crate::media::images(body).len() as u64;
    ((chars + system) as u64).div_ceil(4) + images * IMAGE_TOKENS + answer.unwrap_or(0)
}

/// Sends the request to the engine unchanged and streams its answer back unchanged (SSE included).
async fn forward(client: &reqwest::Client, engine: &Engine, path: &str, body: Bytes) -> Response {
    let url = format!("{}{path}", engine.base_url);
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

pub(crate) fn block_status(reason: Reason) -> StatusCode {
    match reason {
        Reason::UnknownModel => StatusCode::NOT_FOUND,
        Reason::ModelUnavailable | Reason::NoModel => StatusCode::SERVICE_UNAVAILABLE,
        _ => StatusCode::FORBIDDEN,
    }
}

pub(crate) fn reason_code(reason: Reason) -> String {
    serde_json::to_value(reason).ok().and_then(|v| v.as_str().map(str::to_owned)).unwrap_or_default()
}

pub(crate) fn ask_message(decision: &Decision) -> &'static str {
    match decision.reason {
        Reason::Trains => "this model trains on prompts; send again with `invincible-confirmed: 1` to use it",
        Reason::Sensitive => "this request looks sensitive; send again with `invincible-confirmed: 1` to use the cloud",
        _ => "cloud use needs confirmation; send again with `invincible-confirmed: 1`",
    }
}

/// An error in the OpenAI shape.
pub(crate) fn error(status: StatusCode, code: &str, message: &str) -> Response {
    (status, Json(json!({ "error": { "message": message, "type": code, "code": code } }))).into_response()
}

#[cfg(test)]
mod tests {
    use super::estimate_tokens;
    use serde_json::json;

    #[test]
    fn the_agent_proxy_passes_plain_agent_paths_only() {
        for ok in ["/v1/agent", "/v1/agent/sessions/x/turns", "/v1/agent/actions?since=0&limit=5"] {
            assert!(super::agent_path(ok), "{ok}");
        }
        for bad in [
            "/v1/agent/../admin/devices",
            "/v1/agent/%2e%2e/x",
            "/v1/agent/%2E%2E/x",
            "/v1/agent/a%2fb",
            "/v1/agent/./x",
            "/v1/agent//x",
            "/v1/agentx",
            "/v1/agent/a\\b",
        ] {
            assert!(!super::agent_path(bad), "{bad}");
        }
    }

    #[test]
    fn estimates_text_and_parts_and_answer_limit() {
        let mut body = json!({
            "messages": [
                { "role": "system", "content": "12345678" },
                { "role": "user", "content": [{ "type": "text", "text": "abcd" }, { "type": "image_url" }] }
            ],
            "max_tokens": 100
        });
        assert_eq!(estimate_tokens(&body), 3 + 100, "an image part without a URL is not an image");
        body["messages"][1]["content"][1] =
            json!({ "type": "image_url", "image_url": { "url": "data:image/png;base64,aGVsbG8=" } });
        assert_eq!(estimate_tokens(&body), 3 + super::IMAGE_TOKENS + 100);
        assert_eq!(estimate_tokens(&json!({})), 0);
    }
}
