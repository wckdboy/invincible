//! Speech to text: `POST /v1/audio/transcriptions` in OpenAI's shape (multipart: `file`, and
//! optionally `model`, `language`, `response_format`), passed through to a speech-to-text server
//! on this machine:
//!
//! ```toml
//! [[transcription]]
//! id = "whisper"
//! base_url = "http://127.0.0.1:8080/v1"      # whisper.cpp's server, faster-whisper, …
//! upstream_model = "whisper-1"               # what the server calls it (default: id)
//! ```
//!
//! Audio cannot be redacted the way text is, so a transcription backend off this machine is
//! never used: one is listed (the node says it is there) and refused with `audio_not_redactable`.
//! The router decides among the node's own backends, every request gets a signed receipt and an
//! audit line (`api: "transcriptions"`), and the audio itself is never kept.

use std::sync::Arc;

use axum::Extension;
use axum::body::{Body, Bytes};
use axum::extract::State;
use axum::http::{HeaderMap, HeaderValue, StatusCode, header};
use axum::response::Response;
use invincible_policy::{Action, Model, RouteInput, Tier, decide};

use crate::audit::Caller;
use crate::receipts::Draft;
use crate::server::{AppState, CLIENT_HEADER, DECISION_HEADER, error};
use crate::synth::Backend;

/// The largest recording taken: an hour of speech in a compressed format, with room.
pub const MAX_AUDIO: usize = 64 * 1024 * 1024;

pub async fn transcriptions(
    State(state): State<Arc<AppState>>,
    caller: Option<Extension<Caller>>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let Some(content_type) = headers.get(header::CONTENT_TYPE).cloned() else {
        return error(StatusCode::BAD_REQUEST, "invalid_request_error", "send the audio as multipart/form-data");
    };
    if !content_type.to_str().is_ok_and(|v| v.to_ascii_lowercase().starts_with("multipart/form-data")) {
        return error(StatusCode::BAD_REQUEST, "invalid_request_error", "send the audio as multipart/form-data");
    }
    if body.is_empty() {
        return error(StatusCode::BAD_REQUEST, "invalid_request_error", "the body is empty");
    }
    if state.transcription.is_empty() {
        return error(
            StatusCode::NOT_FOUND,
            "no_backend",
            "no transcription backend: add one under [[transcription]] in the node's config",
        );
    }
    let backends: Vec<&Backend> = state.transcription.iter().filter(|b| b.tier == Tier::Node).collect();
    if backends.is_empty() {
        return error(
            StatusCode::FORBIDDEN,
            "request_blocked",
            "blocked: audio_not_redactable (only a transcription backend on this machine is used)",
        );
    }
    // The model, if named, is in the multipart body; the router gets `auto` and the node's own
    // backends only, so a private request and a public one are treated the same.
    let request = crate::server::route_request(&headers, &serde_json::Value::Null);
    let mut draft = match Draft::new() {
        Ok(draft) => draft,
        Err(e) => return error(StatusCode::INTERNAL_SERVER_ERROR, "internal_error", &e),
    };
    draft.api = "transcriptions";
    draft.caller = caller.map_or(Caller::Local, |Extension(c)| c);
    draft.client = headers
        .get(CLIENT_HEADER)
        .and_then(|v| v.to_str().ok())
        .map(|v| v.chars().filter(|c| c.is_ascii_graphic() || *c == ' ').take(64).collect::<String>())
        .filter(|v| !v.is_empty());
    let models: Vec<Model> = backends
        .iter()
        .map(|b| Model {
            id: b.id.clone(),
            tier: Tier::Node,
            healthy: b.healthy(),
            context: None,
            data_policy: b.data_policy,
        })
        .collect();
    let decision = decide(&RouteInput { request, node: state.node.clone(), models });
    let mut response = match &decision.action {
        Action::Run => {
            let backend = backends.iter().find(|b| Some(&b.id) == decision.model.as_ref()).expect("decided");
            draft.data_policy = Some(crate::server::data_policy_code(backend.data_policy));
            match send(&state.client, backend, content_type, body).await {
                Ok(response) => response,
                Err(why) => {
                    tracing::warn!(backend = %backend.id, "transcription backend failed ({why})");
                    error(StatusCode::BAD_GATEWAY, "backend_unavailable", "the transcription backend failed")
                }
            }
        }
        Action::Ask => error(StatusCode::CONFLICT, "confirmation_required", crate::server::ask_message(&decision)),
        Action::Block => error(
            crate::server::block_status(decision.reason),
            "request_blocked",
            &format!("blocked: {}", crate::server::reason_code(decision.reason)),
        ),
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

/// The multipart body passed on as it came, with its boundary; the backend's answer as it came.
async fn send(
    client: &reqwest::Client,
    backend: &Backend,
    content_type: HeaderValue,
    body: Bytes,
) -> Result<Response, String> {
    let mut request = client
        .post(format!("{}/audio/transcriptions", backend.base_url))
        .header(reqwest::header::CONTENT_TYPE, content_type.as_bytes())
        .timeout(std::time::Duration::from_secs(600))
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
    let mut response = Response::new(Body::from(bytes));
    *response.status_mut() = StatusCode::from_u16(status.as_u16()).unwrap_or(StatusCode::BAD_GATEWAY);
    if let Some(content_type) = content_type.and_then(|v| HeaderValue::from_bytes(v.as_bytes()).ok()) {
        response.headers_mut().insert(header::CONTENT_TYPE, content_type);
    }
    Ok(response)
}
