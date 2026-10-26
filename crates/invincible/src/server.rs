//! The node's OpenAI-compatible API. Every request goes through the router
//! (`invincible_policy::decide`); the decision travels back in the `invincible-decision` header.
//!
//! Clients that know about Invincible can say more about a request with headers:
//! - `invincible-private: 1` — must never leave hardware the user owns. Any value except `0`,
//!   `false` or `no` counts as private.
//! - `invincible-risk: health,personal` — risk codes (spec/routing.md).
//! - `invincible-confirmed: 1` — the user approved a cloud run (the answer to an `ask`).

use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};

use axum::body::{Body, Bytes};
use axum::extract::{FromRequest, Path, Request as HttpRequest, State};
use axum::http::{HeaderMap, HeaderValue, StatusCode, header};
use axum::middleware::{self, Next};
use axum::response::{IntoResponse, Response};
use axum::routing::{MethodRouter, any, get, patch, post};
use axum::{Extension, Json, Router};
use bytes::BytesMut;
use futures_util::StreamExt;
use invincible_policy::{Action, DataPolicy, Decision, Model, NodeSettings, Reason, Request, RouteInput, Tier, decide};
use serde_json::{Value, json};

use crate::audit::{AuditLog, Caller};
use crate::cloud::{CloudError, CloudModel};
use crate::devices::{Capabilities as DeviceCapabilities, Capability};
use crate::engine::Engine;
use crate::receipts::{Attempt, Draft, ReceiptKey, ReceiptStore};
use crate::remote::{CODE_LIFETIME, Pairing};

pub const DECISION_HEADER: &str = "invincible-decision";
/// Set by the gateway on requests it passes to the agent: `local` or `device:<name>`.
pub const CALLER_HEADER: &str = "invincible-caller";
/// Names the program sending a request (`autobot-agent`), for the audit log.
pub const CLIENT_HEADER: &str = "invincible-client";
/// The largest body a route takes, per route, because what a route needs is what it should take:
/// one number copied across the API is memory a caller can ask the node for.
///
/// | route | limit | why |
/// |---|---|---|
/// | `/v1/chat/completions` | [`MAX_REQUEST`] | a conversation's text plus its images |
/// | `/v1/messages` | [`MAX_REQUEST`] | the same conversation, Anthropic's shape |
/// | `/v1/agent` | `AGENT_TURN_BODY` (turns), 1 MiB (everything else) | the agent's own caps |
///
/// On the device listener a limit is only ever reached by a device the operator admitted: the
/// capability gate runs first ([`device_app`]), so an unauthorised device gets the fallback's 404
/// and never learns a number from here.
///
/// The chat number is **not** a context window. A conversation's text is bounded by the model's
/// context — 128k tokens is ~512 KiB at four characters a token (`estimate_tokens`) — but its
/// images are not: they travel as base64 `data:` URLs (a third larger than the bytes they carry),
/// `estimate_tokens` charges 1_600 tokens an image whatever its size, and a provider takes up to
/// 20 MB an image. So the byte limit is what bounds an image and 32 MiB is room for a few of them
/// (the README says "a request may be up to 32 MiB"). It is also the operator's documented number,
/// so the device listener cannot hold it lower without refusing a request the operator's own API
/// accepted.
pub const MAX_REQUEST: usize = 32 * 1024 * 1024;
/// The largest agent turn passed through: its text and a few images in base64 (the agent takes
/// four of 10 MiB at most).
const AGENT_TURN_BODY: usize = 64 * 1024 * 1024;

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
    /// What the device listener will hold of request bodies at once (`[node]
    /// max_buffered_bytes`, spec/pairing.md, Limits). The operator's own loopback requests are
    /// not counted: the ceiling is for the callers the node does not sit behind.
    pub buffered: Arc<Budget>,
}

impl AppState {
    pub fn new(engines: Vec<Engine>, node: NodeSettings, token: String) -> Self {
        // No overall timeout: a long generation is not a hung one. Connecting to a loopback
        // engine is instant or it is down. How long an engine may stay silent is the relay's
        // ([crate::relay]), which can say so to the client.
        let client =
            crate::egress::local().connect_timeout(std::time::Duration::from_secs(2)).build().expect("HTTP client");
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
            buffered: Arc::new(Budget::new(crate::config::DEFAULT_MAX_BUFFERED_BYTES)),
        }
    }

    /// How many bytes of device request bodies this node holds at once (`[node]
    /// max_buffered_bytes`): the ceiling the device listener admits requests against.
    pub fn with_max_buffered_bytes(mut self, bytes: u64) -> Self {
        self.buffered = Arc::new(Budget::new(bytes));
        self
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

// ---------------------------------------------------------------------------------------------
// What a request may cost the node

/// Bytes of request bodies held at once: `[node] max_buffered_bytes` (spec/pairing.md, Limits).
///
/// Per-request limits alone are not a bound on memory. A paired device holds up to 32 sessions
/// (`remote::MAX_SESSIONS_PER_DEVICE`) and could open one body of [`MAX_REQUEST`] on each — 1 GiB
/// on a 4 GB box — and the allocator, not the limit, would decide what happens next. So the
/// device listener reserves a request's declared size here *before* it reads a byte of it, and
/// gives it back when the request is answered: past the ceiling, a request is refused with 503
/// and a retry hint instead of being accepted and taking the node down with it.
#[derive(Debug)]
pub struct Budget {
    ceiling: u64,
    held: AtomicU64,
}

impl Budget {
    pub fn new(ceiling: u64) -> Self {
        Self { ceiling, held: AtomicU64::new(0) }
    }

    /// The ceiling in bytes (`[node] max_buffered_bytes`).
    pub fn ceiling(&self) -> u64 {
        self.ceiling
    }

    /// Bytes reserved now, across every request in flight.
    pub fn held(&self) -> u64 {
        self.held.load(Ordering::Acquire)
    }

    /// Room for [bytes] more, or `None` when that would pass the ceiling. What was reserved is
    /// given back when the returned reservation drops.
    pub fn reserve(self: &Arc<Self>, bytes: u64) -> Option<Reservation> {
        let mut held = self.held.load(Ordering::Acquire);
        loop {
            let after = held.checked_add(bytes)?;
            if after > self.ceiling {
                return None;
            }
            match self.held.compare_exchange_weak(held, after, Ordering::AcqRel, Ordering::Acquire) {
                Ok(_) => return Some(Reservation { budget: self.clone(), bytes }),
                Err(current) => held = current,
            }
        }
    }
}

/// Bytes a request is holding in a [`Budget`]; given back when dropped.
#[derive(Debug)]
pub struct Reservation {
    budget: Arc<Budget>,
    bytes: u64,
}

impl Drop for Reservation {
    fn drop(&mut self) {
        self.budget.held.fetch_sub(self.bytes, Ordering::AcqRel);
    }
}

/// The body limit of the route a request is on, put there by the router
/// (`Extension(BodyLimit(..))` on each route) and read by [`Bounded`].
#[derive(Clone, Copy, Debug)]
pub struct BodyLimit(pub usize);

/// A request body, read up to the limit its route declares: over it, a 413 whose message names
/// the number, so an operator who hits it can see what the route takes.
#[derive(Debug)]
pub struct Bounded(pub Bytes);

impl std::ops::Deref for Bounded {
    type Target = Bytes;

    fn deref(&self) -> &Bytes {
        &self.0
    }
}

/// Why a body was not read: over the route's limit, or cut short.
#[derive(Debug)]
pub enum Refusal {
    /// Over the route's limit, which this names in bytes.
    TooLarge(usize),
    /// The client stopped sending, or sent something that was not the body it declared.
    Unreadable,
}

impl IntoResponse for Refusal {
    fn into_response(self) -> Response {
        match self {
            Self::TooLarge(limit) => too_large(limit),
            Self::Unreadable => error(
                StatusCode::BAD_REQUEST,
                "invalid_request_error",
                "the body could not be read (it ended early, or was not what its Content-Length said)",
            ),
        }
    }
}

impl<S: Send + Sync> FromRequest<S> for Bounded {
    type Rejection = Refusal;

    async fn from_request(request: HttpRequest, _state: &S) -> Result<Self, Self::Rejection> {
        let limit = request.extensions().get::<BodyLimit>().map_or(MAX_REQUEST, |limit| limit.0);
        let declared = content_length(request.headers()).unwrap_or(0);
        // A body that says how big it is, and says more than the route takes, is refused before
        // a byte of it is kept: what it sends is read and dropped, so the client gets the refusal
        // rather than a connection torn down mid-body.
        if declared > limit as u64 {
            drain(request.into_body(), limit);
            return Err(Refusal::TooLarge(limit));
        }
        read_limited(request.into_body(), limit, declared).await.map(Self)
    }
}

/// Reads [body] to its end, keeping it, up to [limit] bytes: the limit applies while reading too,
/// so a body that lied about its length (or came without one) cannot buffer more than the route
/// takes. [declared] is what the request said it would send, so the buffer is allocated once.
async fn read_limited(body: Body, limit: usize, declared: u64) -> Result<Bytes, Refusal> {
    let capacity = usize::try_from(declared).unwrap_or(limit).min(limit);
    let mut bytes = BytesMut::with_capacity(capacity);
    let mut stream = body.into_data_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|_| Refusal::Unreadable)?;
        if bytes.len() + chunk.len() > limit {
            return Err(Refusal::TooLarge(limit));
        }
        bytes.extend_from_slice(&chunk);
    }
    Ok(bytes.freeze())
}

/// The length a request declares, if any: `Content-Length` as a number, or `None` for a body
/// that arrives in chunks (an unreadable one counts as none, and is bounded by the route).
fn content_length(headers: &HeaderMap) -> Option<u64> {
    headers.get(header::CONTENT_LENGTH)?.to_str().ok()?.trim().parse().ok()
}

/// 413: the body is over the route's limit, and the message says which.
fn too_large(limit: usize) -> Response {
    error(
        StatusCode::PAYLOAD_TOO_LARGE,
        "payload_too_large",
        &format!("the body is over this route's limit of {limit} bytes ({} MiB)", limit >> 20),
    )
}

/// 503: the node is at its ceiling for held request bodies, with a hint that it is worth retrying.
fn out_of_room(held: u64, ceiling: u64) -> Response {
    let mut response = error(
        StatusCode::SERVICE_UNAVAILABLE,
        "buffered_out_of_room",
        &format!(
            "the node is holding {held} of its {ceiling} bytes of device request bodies ([node] max_buffered_bytes); retry in a moment"
        ),
    );
    response.headers_mut().insert(header::RETRY_AFTER, HeaderValue::from_static("2"));
    response
}

/// Admission control for a device route that buffers its body: reserve what the request can hold
/// before reading it, and give it back when the request is answered.
///
/// What it can hold is its `Content-Length` (hyper holds a fixed-length body to it) or, for a body
/// that declares none, the route's limit — the most it could ever buffer. That limit is read from
/// the route's own [`BodyLimit`], the same extension [`Bounded`] reads, so a route's number is
/// written once, in the router, and neither this check nor [`Bounded`] restates it.
async fn admit(State(budget): State<Arc<Budget>>, request: HttpRequest, next: Next) -> Response {
    let limit = request.extensions().get::<BodyLimit>().map_or(MAX_REQUEST, |limit| limit.0);
    let holding = content_length(request.headers()).unwrap_or(limit as u64);
    let Some(_room) = budget.reserve(holding) else {
        tracing::debug!(
            held = budget.held(),
            ceiling = budget.ceiling(),
            "device body ceiling reached; refusing without holding a byte of it"
        );
        // Nothing of the body is kept; it is read and dropped so the client gets the 503.
        drain(request.into_body(), limit);
        return out_of_room(budget.held(), budget.ceiling());
    };
    next.run(request).await
}

/// The inference API, the same for every caller.
///
/// Each route that buffers a body declares its own limit ([`MAX_REQUEST`] and the table there);
/// the loopback listener is not admitted against [`Budget`], which is the device listener's.
fn api() -> Router<Arc<AppState>> {
    Router::new()
        .route("/v1/models", get(models))
        .route("/v1/chat/completions", post(chat_completions).layer(Extension(BodyLimit(MAX_REQUEST))))
        .route("/v1/messages", post(messages).layer(Extension(BodyLimit(MAX_REQUEST))))
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
    // A turn may carry images (the agent caps them itself); anything else is small.
    let turn = path.split('?').next().is_some_and(|p| p.ends_with("/turns"));
    let limit = if turn { AGENT_TURN_BODY } else { 1 << 20 };
    let declared = content_length(request.headers()).unwrap_or(0);
    if declared > limit as u64 {
        return too_large(limit);
    }
    let body = match read_limited(request.into_body(), limit, declared).await {
        Ok(body) => body,
        Err(refusal) => return refusal.into_response(),
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
///
/// The operator reads every caller's. A paired device (granted `audit`) reads only its own: the
/// entries that carry the key it was pinned with, so neither another device's records nor the
/// operator's, nor those of an earlier device that went by the same name, and none written before
/// entries carried the key (spec/audit.md, Reading it). A device's entries come without `prev`: it
/// is the hash of whichever line came before, often another caller's, so it would say whether
/// someone used the node between two of the device's requests.
async fn audit(
    State(state): State<Arc<AppState>>,
    caller: Option<Extension<Caller>>,
    axum::extract::Query(q): axum::extract::Query<AuditQuery>,
) -> Response {
    let Some(log) = state.audit.clone() else {
        return Json(json!({ "entries": [], "summary": crate::audit::summary(&[]), "kept": false })).into_response();
    };
    let limit = q.limit.unwrap_or(100).clamp(1, 500);
    let device = caller.and_then(|Extension(caller)| caller.key().map(str::to_owned));
    let entries = tokio::task::spawn_blocking(move || match device {
        Some(key) => {
            let mut entries =
                log.read_where(q.since, limit, |entry| entry["caller_key"].as_str() == Some(key.as_str()));
            // The chain is the operator's to check: a device never sees the lines it links.
            for entry in &mut entries {
                if let Some(entry) = entry.as_object_mut() {
                    entry.remove("prev");
                }
            }
            entries
        }
        None => log.read(q.since, limit),
    })
    .await
    .unwrap_or_default();
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

/// Reads and drops what a refused request is still sending (up to [limit] bytes, the most its
/// route takes), in the background, so the refusal is written without waiting for the upload.
///
/// This is not politeness: an HTTP/1.1 request whose body is dropped mid-flight loses its
/// connection, and a client (or `invincible tunnel`, which relays a device session) then sees a
/// broken pipe instead of the 413 or 503 the node meant to send. The bytes are counted and
/// discarded — a chunk at a time, nothing kept — so the node's memory is untouched either way.
fn drain(body: Body, limit: usize) {
    tokio::spawn(async move {
        let _ = discard(body, limit).await;
    });
}

/// Reads [body] to its end without keeping it, returning how many bytes arrived. Over [limit], or
/// cut short, the read stops there.
async fn discard(body: Body, limit: usize) -> Result<usize, Refusal> {
    let mut received = 0usize;
    let mut stream = body.into_data_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|_| Refusal::Unreadable)?;
        received = received.saturating_add(chunk.len());
        if received > limit {
            return Err(Refusal::TooLarge(limit));
        }
        drop(chunk);
    }
    Ok(received)
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
        // `PATCH` sets what a device may reach (spec/pairing.md, Capabilities); `DELETE` unpairs.
        .route("/v1/admin/devices/{name}", patch(grant_device).delete(remove_device));
    let guarded = api().merge(admin).route_layer(middleware::from_fn_with_state(state.clone(), require_token));
    Router::new()
        .route("/health", get(|| async { Json(json!({ "status": "ok" })) }))
        .route("/healthz", get(healthz))
        .merge(guarded)
        .with_state(state)
}

/// What a device request is admitted by: the route's capability, and the set that device was
/// granted at pairing (spec/pairing.md, Capabilities).
///
/// One table, one place. Every device route is here or nowhere; `None` means the device API does
/// not mount the path at all, so the router's fallback answers — the same 404 for a path that
/// never existed. A path whose capability the device does not hold is answered by
/// [`require_capability`] with exactly that 404, so a grant is invisible from outside until it
/// is held, and a revocation is invisible after it.
fn capability_for(path: &str) -> Option<Capability> {
    let path = path.split('?').next().unwrap_or_default();
    match path {
        // What the app's chat needs of this node: the models, a turn, and the node itself.
        "/v1/models" | "/v1/chat/completions" | "/v1/node" => Some(Capability::Shard),
        "/v1/audit" => Some(Capability::Audit),
        "/v1/agent" => Some(Capability::Agent),
        path if path.starts_with("/v1/agent/") => Some(Capability::Agent),
        path if path.starts_with("/v1/receipts/") => Some(Capability::Shard),
        _ => None,
    }
}

/// The device API's one gate: a request is admitted only when the capability its route needs is
/// in the set the device was granted at pairing.
///
/// A device that lacks it gets the router's fallback answer, byte for byte (status, body and
/// headers), including its `content-type`: `404` with `{"error":{"message":"no such endpoint",
/// "type":"not_found","code":"not_found"}}`. Deliberately not a 403 — a 403 would map which
/// routes exist, and to whom.
async fn require_capability(
    State(state): State<Arc<AppState>>,
    caller: Option<Extension<Caller>>,
    request: HttpRequest,
    next: Next,
) -> Response {
    let Some(needed) = capability_for(request.uri().path()) else {
        // Not a route of the device API: the fallback answers, as for any path.
        return next.run(request).await;
    };
    let granted = match caller {
        Some(Extension(Caller::Device { key, .. })) => {
            state.pairing.as_ref().and_then(|pairing| pairing.devices.capabilities_of(&key))
        }
        // No device session behind this request (a bare `device_app` in a test, say): nothing is
        // granted. In service the session always says who is asking.
        _ => None,
    };
    match granted {
        Some(capabilities) if capabilities.contains(needed) => next.run(request).await,
        _ => error(StatusCode::NOT_FOUND, "not_found", "no such endpoint"),
    }
}

/// A device route that buffers its body, with the two checks such a route takes, in the order they
/// run: the route's limit outside (so the number is in the extensions when [`admit`] reads it, and
/// is written here once), admission against the node's ceiling inside (so the reservation is made
/// before a byte of the body is read).
fn admitted(route: MethodRouter<Arc<AppState>>, budget: Arc<Budget>, limit: usize) -> MethodRouter<Arc<AppState>> {
    // The error type is named because `Extension` never fails, and two layers where one cannot fail
    // is a shape the compiler will not guess.
    route
        .layer::<_, std::convert::Infallible>(middleware::from_fn_with_state(budget, admit))
        .layer(Extension(BodyLimit(limit)))
}

/// What paired devices reach through their encrypted session: an allowlist, not the API, and per
/// device — each route needs a capability recorded for that device at pairing
/// (spec/pairing.md, Capabilities).
///
/// A paired device is authenticated by its pinned key, not by the node's token, and it is not the
/// operator: a phone, say. It gets the inference its app runs and the node's own description —
/// the four routes `spec/pairing.md` (Transport) documents — and only `/v1/agent` and `/v1/audit`
/// when the operator granted them. Every other path is a 404 from the fallback below, which is
/// also what a path that does not exist gets, and so is a route the device lacks the capability
/// for: a device cannot tell an operator route from no route at all, nor which grants another
/// device holds.
///
/// Deliberately absent from every set (each would be operator-equivalent beyond a capability):
/// - `/v1/messages`, `/v1/audio/speech`, `/v1/images/generations` — inference the device protocol
///   does not document.
/// - `/v1/fetch`, `/v1/admin/*` — outbound fetch and administration.
fn device_api(budget: Arc<Budget>) -> Router<Arc<AppState>> {
    Router::new()
        // The app: which models it may ask for, one turn, and the receipt for it. It buffers a
        // body, so it is admitted against the node's ceiling: 32 sessions could each hold
        // `MAX_REQUEST` otherwise (`[node] max_buffered_bytes`).
        .route("/v1/chat/completions", admitted(post(chat_completions), budget, MAX_REQUEST))
        .route("/v1/models", get(models))
        .route("/v1/receipts/{id}", get(receipt))
        // What this node is.
        .route("/v1/node", get(node_info))
        // Granted by capability, never by the router: the Autobot proxy (which runs with this
        // node's own token) and the audit log, which a device reads only its own entries of. They
        // are mounted here so that [`require_capability`] — not the router's fallback — is what
        // answers a device the operator did not grant them, with the fallback's own 404.
        .route("/v1/agent", any(agent))
        .route("/v1/agent/{*rest}", any(agent))
        .route("/v1/audit", get(audit))
        .fallback(|| async { error(StatusCode::NOT_FOUND, "not_found", "no such endpoint") })
}

/// What a paired device reaches: the capability gate, then each route's own admission and limit.
///
/// The order is the property, not an implementation detail:
///
/// 1. **Capability** ([`require_capability`], the outer `route_layer`): a device the operator did
///    not grant the route's capability gets the fallback's 404 and nothing else runs — it never
///    reaches the budget, never reads a byte of its body, and cannot tell this route from one the
///    node does not have.
/// 2. **Budget** ([`admit`], on each route that buffers a body): what the body can hold is
///    reserved against `[node] max_buffered_bytes` before it is read; past the ceiling it is 503
///    with `Retry-After`.
/// 3. **Size** ([`Bounded`], under the route's [`BodyLimit`]): the body is read up to its route's
///    limit; over it, 413 naming the number.
///
/// Capability first is what keeps the other two from being observable to a device that may not be
/// here at all: 413 and 503 are statements about this node's configuration, and only a device the
/// operator admitted may learn them — or make the node spend a byte on its behalf. Budget before
/// size because the ceiling is the bound on memory: a body refused for its size must never have
/// been reserved.
pub fn device_app(state: Arc<AppState>) -> Router {
    let gate = middleware::from_fn_with_state(state.clone(), require_capability);
    let budget = state.buffered.clone();
    device_api(budget).route_layer(gate).with_state(state)
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
        route: crate::egress::route(&state.node.network, &host),
        host,
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

/// `POST /v1/admin/pairing`: opens a pairing code. Body optional; `{"capabilities": [...]}`
/// pre-grants the device that consumes it (spec/pairing.md, Capabilities), and without it the
/// code grants `shard` only — which the answer says, so the default is visible where the code is.
async fn start_pairing(State(state): State<Arc<AppState>>, body: Bytes) -> Response {
    let Some(pairing) = &state.pairing else {
        return error(
            StatusCode::CONFLICT,
            "remote_disabled",
            "remote access is off: set [remote] listen in the config",
        );
    };
    let body = match json_body(&body) {
        Ok(body) => body,
        Err(message) => return error(StatusCode::BAD_REQUEST, "invalid_request_error", message),
    };
    let capabilities = match body.get("capabilities") {
        Some(value) => match DeviceCapabilities::from_json(value) {
            Ok(capabilities) => capabilities,
            Err(message) => return error(StatusCode::BAD_REQUEST, "invalid_capabilities", &message),
        },
        None => DeviceCapabilities::shard(),
    };
    match pairing.start_granting(CODE_LIFETIME, capabilities.clone()) {
        Ok(code) => Json(json!({
            "code": code.encode(),
            "node": pairing.name,
            "fingerprint": crate::devices::fingerprint(&pairing.key.public),
            "expires_in": CODE_LIFETIME.as_secs(),
            "capabilities": capabilities.codes(),
        }))
        .into_response(),
        Err(e) => error(StatusCode::INTERNAL_SERVER_ERROR, "internal_error", &e),
    }
}

async fn list_devices(State(state): State<Arc<AppState>>) -> Json<Value> {
    // Each device with what it may reach (spec/pairing.md, Capabilities): the operator's view of
    // the grants, and how one checks what a device holds before revoking it.
    let devices = state.pairing.as_ref().map(|p| p.devices.list()).unwrap_or_default();
    Json(json!({ "devices": devices }))
}

/// A body that may be left out: `{}` when there is none.
fn json_body(body: &Bytes) -> Result<Value, &'static str> {
    if body.iter().all(u8::is_ascii_whitespace) {
        return Ok(json!({}));
    }
    serde_json::from_slice(body).map_err(|_| "the body is not JSON")
}

/// `PATCH /v1/admin/devices/{name} {"capabilities": ["shard", "agent"]}`: grants the paired device
/// called {name} exactly that set (spec/pairing.md, Capabilities), so a grant and a revocation are
/// the same write. Enforced from the next request: the device gate reads `devices.json`'s list on
/// every request, so no re-pairing is involved. The answer names the set before and after, and
/// whether it changed.
async fn grant_device(State(state): State<Arc<AppState>>, Path(name): Path<String>, body: Bytes) -> Response {
    let body = match json_body(&body) {
        Ok(body) => body,
        Err(message) => return error(StatusCode::BAD_REQUEST, "invalid_request_error", message),
    };
    let Some(value) = body.get("capabilities") else {
        return error(
            StatusCode::BAD_REQUEST,
            "invalid_request_error",
            &format!("the body is {{\"capabilities\": [...]}}, of {}", DeviceCapabilities::known()),
        );
    };
    let capabilities = match DeviceCapabilities::from_json(value) {
        Ok(capabilities) => capabilities,
        Err(message) => return error(StatusCode::BAD_REQUEST, "invalid_capabilities", &message),
    };
    let Some(pairing) = state.pairing.clone() else {
        return error(StatusCode::NOT_FOUND, "not_found", "no such device");
    };
    let was = pairing.devices.named(&name).map(|device| device.capabilities);
    let device = match pairing.devices.set_capabilities(&name, capabilities) {
        Ok(Some(device)) => device,
        Ok(None) => {
            return error(
                StatusCode::NOT_FOUND,
                "not_found",
                &format!("no paired device \"{name}\" (`invincible devices` lists them)"),
            );
        }
        Err(e) => return error(StatusCode::INTERNAL_SERVER_ERROR, "internal_error", &e),
    };
    tracing::info!(device = %name, capabilities = ?device.capabilities.codes(), "device capabilities set");
    let changed = was.as_ref() != Some(&device.capabilities);
    Json(json!({
        "device": device.name,
        "capabilities": device.capabilities.codes(),
        "was": was.map(|was| was.codes()),
        "changed": changed,
    }))
    .into_response()
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
    body: Bounded,
) -> Response {
    infer(state, caller, headers, body, Api::Chat).await
}

async fn messages(
    state: State<Arc<AppState>>,
    caller: Option<Extension<Caller>>,
    headers: HeaderMap,
    body: Bounded,
) -> Response {
    infer(state, caller, headers, body, Api::Messages).await
}

async fn infer(
    State(state): State<Arc<AppState>>,
    caller: Option<Extension<Caller>>,
    headers: HeaderMap,
    body: Bounded,
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
                let streaming = parsed.get("stream").and_then(Value::as_bool) == Some(true);
                forward(&state.client, engine, api.path(), body.0.clone(), streaming).await
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
                    route: crate::egress::route(&state.node.network, &cloud.host()),
                    host: cloud.host(),
                    sent: outgoing.len() as u64,
                    received: received.clone(),
                    ok: true,
                });
                draft.data_policy = Some(data_policy_code(cloud.data_policy));
                let streaming = parsed.get("stream").and_then(Value::as_bool) == Some(true);
                match crate::cloud::forward(client, cloud, outgoing, vault, received, streaming).await {
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
    // Saturating: a client's max_tokens of u64::MAX needs more than any model has, not an overflow.
    ((chars + system) as u64)
        .div_ceil(4)
        .saturating_add(images.saturating_mul(IMAGE_TOKENS))
        .saturating_add(answer.unwrap_or(0))
}

/// Sends the request to the engine unchanged and streams its answer back unchanged (SSE included).
/// [body] to [engine] and its answer back ([crate::relay]: kept alive while streamed, given up
/// on after [crate::egress::LOCAL_SILENCE] of silence).
async fn forward(client: &reqwest::Client, engine: &Engine, path: &str, body: Bytes, streaming: bool) -> Response {
    let url = format!("{}{path}", engine.base_url);
    crate::relay::engine(client, &url, body, streaming, crate::relay::KEEP_ALIVE, crate::egress::LOCAL_SILENCE).await
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
    use std::sync::Arc;

    #[tokio::test]
    async fn a_refused_body_is_read_and_dropped_not_kept() {
        // What `drain` does with a body it refused: read a chunk at a time, counted, nothing kept.
        let body = axum::body::Body::from(vec![7u8; 4096]);
        assert_eq!(super::discard(body, 1 << 20).await.unwrap(), 4096);
        assert_eq!(super::discard(axum::body::Body::empty(), 1 << 20).await.unwrap(), 0);
        // Over the limit the read stops there, with the number that names it.
        let over = axum::body::Body::from(vec![0u8; 8192]);
        match super::discard(over, 4096).await {
            Err(super::Refusal::TooLarge(limit)) => assert_eq!(limit, 4096),
            other => panic!("a body over the limit is refused, not read: {other:?}"),
        }
    }

    #[test]
    fn the_body_budget_refuses_past_the_ceiling_and_gives_it_back() {
        let budget = Arc::new(super::Budget::new(10));
        let first = budget.reserve(6).expect("room for six");
        assert_eq!(budget.held(), 6);
        assert!(budget.reserve(5).is_none(), "eleven would pass ten");
        let second = budget.reserve(4).expect("exactly ten");
        assert_eq!(budget.held(), 10);
        assert!(budget.reserve(1).is_none(), "a full budget has no room");
        drop(first);
        assert_eq!(budget.held(), 4, "a finished request gives its bytes back");
        drop(second);
        assert_eq!(budget.held(), 0);
        // A size that overflows the counter is refused, not wrapped into room.
        assert!(budget.reserve(u64::MAX).is_none());
        assert!(budget.reserve(u64::MAX).is_none());
        assert_eq!(budget.held(), 0);
    }

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
        // A wild limit needs more than any model has; it does not overflow (a panic in a debug
        // build, a tiny wrapped number that fits any model in a release one).
        body["max_tokens"] = json!(u64::MAX);
        assert_eq!(estimate_tokens(&body), u64::MAX);
    }
}
