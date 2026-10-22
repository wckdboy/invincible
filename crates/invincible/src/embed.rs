//! Embeddings: `POST /v1/embeddings` in OpenAI's shape, answered by an embedding model the node
//! serves itself. A model is an embedding model when its config says so:
//!
//! ```toml
//! [[models]]
//! id = "nomic-embed"
//! path = "/models/nomic-embed-text-v1.5-Q8_0.gguf"
//! embeddings = true                          # llama-server --embeddings: this engine only embeds
//! ```
//!
//! Embeddings never leave the node: there is no cloud embedding backend, so a private request and
//! a public one are treated the same, and the receipt's `egress` is always empty. The router still
//! decides (a model asked for by name must exist and be up; `auto` takes the first healthy one),
//! and every request gets a signed receipt and an audit line, `api: "embeddings"`.

use std::sync::Arc;

use axum::Extension;
use axum::body::{Body, Bytes};
use axum::extract::State;
use axum::http::{HeaderMap, HeaderValue, StatusCode, header};
use axum::response::Response;
use invincible_policy::{Action, DataPolicy, Model, RouteInput, Tier, decide};
use serde_json::Value;

use crate::audit::Caller;
use crate::receipts::Draft;
use crate::server::{AppState, CLIENT_HEADER, DECISION_HEADER, error};

/// The most text embedded in one request, in characters, over every input.
pub const MAX_INPUT: usize = 1 << 20;

/// Characters in `input`: a string, or an array of strings. Token arrays (OpenAI allows them)
/// count nothing and go through as they are.
fn input_chars(input: &Value) -> Option<usize> {
    match input {
        Value::String(s) if !s.trim().is_empty() => Some(s.chars().count()),
        Value::Array(items) if !items.is_empty() => {
            let mut chars = 0;
            for item in items {
                match item {
                    Value::String(s) => chars += s.chars().count(),
                    Value::Number(_) | Value::Array(_) => {}
                    _ => return None,
                }
            }
            Some(chars)
        }
        _ => None,
    }
}

pub async fn embeddings(
    State(state): State<Arc<AppState>>,
    caller: Option<Extension<Caller>>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let Ok(parsed) = serde_json::from_slice::<Value>(&body) else {
        return error(StatusCode::BAD_REQUEST, "invalid_request_error", "the body is not JSON");
    };
    let Some(chars) = parsed.get("input").and_then(input_chars) else {
        return error(StatusCode::BAD_REQUEST, "invalid_request_error", "`input` is a string or an array of strings");
    };
    if chars > MAX_INPUT {
        return error(
            StatusCode::BAD_REQUEST,
            "invalid_request_error",
            &format!("`input` is longer than {MAX_INPUT} characters"),
        );
    }
    let engines: Vec<&crate::engine::Engine> = state.engines.iter().filter(|e| e.embeddings).collect();
    if engines.is_empty() {
        return error(
            StatusCode::NOT_FOUND,
            "no_backend",
            "no embedding model: add one under [[models]] with embeddings = true",
        );
    }
    let mut request = crate::server::route_request(&headers, &parsed);
    request.prompt_tokens = (chars as u64).div_ceil(4);
    let mut draft = match Draft::new() {
        Ok(draft) => draft,
        Err(e) => return error(StatusCode::INTERNAL_SERVER_ERROR, "internal_error", &e),
    };
    draft.api = "embeddings";
    draft.caller = caller.map_or(Caller::Local, |Extension(c)| c);
    draft.client = headers
        .get(CLIENT_HEADER)
        .and_then(|v| v.to_str().ok())
        .map(|v| v.chars().filter(|c| c.is_ascii_graphic() || *c == ' ').take(64).collect::<String>())
        .filter(|v| !v.is_empty());
    let models: Vec<Model> = engines
        .iter()
        .map(|e| Model {
            id: e.id.clone(),
            tier: Tier::Node,
            healthy: e.healthy(),
            context: e.context,
            data_policy: DataPolicy::Owned,
        })
        .collect();
    let decision = decide(&RouteInput { request, node: state.node.clone(), models });
    let mut response = match &decision.action {
        Action::Run => {
            let engine = engines.iter().find(|e| Some(&e.id) == decision.model.as_ref()).expect("decided");
            draft.data_policy = Some(crate::server::data_policy_code(DataPolicy::Owned));
            let mut outgoing = parsed.clone();
            outgoing["model"] = Value::String(engine.id.clone());
            let bytes = serde_json::to_vec(&outgoing).expect("JSON serialises");
            match send(&state.client, engine, bytes).await {
                Ok(response) => response,
                Err(why) => {
                    tracing::warn!(model = %engine.id, "embedding engine failed ({why})");
                    error(StatusCode::BAD_GATEWAY, "backend_unavailable", "the embedding engine failed")
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

/// The engine's answer as it came (the vectors' JSON), or why it could not answer.
async fn send(client: &reqwest::Client, engine: &crate::engine::Engine, body: Vec<u8>) -> Result<Response, String> {
    let upstream = client
        .post(format!("{}/v1/embeddings", engine.base_url))
        .header(reqwest::header::CONTENT_TYPE, "application/json")
        .timeout(std::time::Duration::from_secs(120))
        .body(body)
        .send()
        .await
        .map_err(|e| format!("unreachable: {}", e.without_url()))?;
    let status = upstream.status();
    if status.is_server_error() {
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

#[cfg(test)]
mod tests {
    use super::input_chars;
    use serde_json::json;

    #[test]
    fn input_is_a_string_or_strings_and_token_arrays_count_nothing() {
        assert_eq!(input_chars(&json!("héllo")), Some(5));
        assert_eq!(input_chars(&json!(["ab", "cde"])), Some(5));
        assert_eq!(input_chars(&json!([1, 2, 3])), Some(0));
        assert_eq!(input_chars(&json!([[1, 2], [3]])), Some(0));
        assert_eq!(input_chars(&json!("  ")), None);
        assert_eq!(input_chars(&json!([])), None);
        assert_eq!(input_chars(&json!(["a", true])), None);
        assert_eq!(input_chars(&json!({ "x": 1 })), None);
    }
}
