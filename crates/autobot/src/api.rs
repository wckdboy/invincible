//! The agent's loopback API (spec/agent.md): Invincible Gateway passes `/v1/agent` through to it,
//! so paired devices can run turns and answer approvals on this machine.

use std::collections::{HashMap, HashSet};
use std::future::Future;
use std::path::PathBuf;
use std::pin::Pin;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use axum::body::{Body, Bytes};
use axum::extract::{Path, Request, State};
use axum::http::{HeaderValue, StatusCode, header};
use axum::middleware::{self, Next};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use serde::Deserialize;
use serde_json::{Value, json};
use tokio::sync::{mpsc, oneshot};

use crate::agent::{Agent, Event};
use crate::approval::{Action, Answer, Approver};
use crate::session::Session;

/// How long a question waits for an answer.
const APPROVAL_WAIT: Duration = Duration::from_secs(10 * 60);

pub struct ApiState {
    agent: Arc<Agent>,
    token: String,
    home: PathBuf,
    sessions_dir: PathBuf,
    info: Value,
    open: Mutex<HashMap<String, Arc<tokio::sync::Mutex<Open>>>>,
    waiting: Arc<Mutex<HashMap<String, oneshot::Sender<Answer>>>>,
}

/// A conversation and what the owner said "always" to in it.
struct Open {
    session: Session,
    grants: HashSet<Action>,
}

impl ApiState {
    /// [home]: `$AUTOBOT_HOME` (conversations in `sessions/`, schedules beside them).
    pub fn new(agent: Arc<Agent>, token: String, home: PathBuf, info: Value) -> Self {
        let sessions_dir = home.join("sessions");
        Self { agent, token, home, sessions_dir, info, open: Mutex::default(), waiting: Arc::default() }
    }
}

pub fn app(state: Arc<ApiState>) -> Router {
    Router::new()
        .route("/v1/agent", get(info))
        .route("/v1/agent/sessions", get(sessions))
        .route("/v1/agent/sessions/{id}", get(history))
        .route("/v1/agent/sessions/{id}/turns", post(turn))
        .route("/v1/agent/sessions/{id}/reset", post(reset))
        .route("/v1/agent/approvals/{id}", post(approve))
        .route("/v1/agent/schedules", get(schedules).post(add_schedule))
        .route("/v1/agent/schedules/{id}", axum::routing::delete(remove_schedule))
        .route_layer(middleware::from_fn_with_state(state.clone(), require_token))
        .with_state(state)
}

async fn require_token(State(state): State<Arc<ApiState>>, request: Request, next: Next) -> Response {
    let given = request
        .headers()
        .get(header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "))
        .unwrap_or_default();
    if invincible::token::matches(&state.token, given) {
        next.run(request).await
    } else {
        error(StatusCode::UNAUTHORIZED, "unauthorized", "the gateway's token is required")
    }
}

fn error(status: StatusCode, code: &str, message: &str) -> Response {
    (status, Json(json!({ "error": { "message": message, "type": code, "code": code } }))).into_response()
}

fn valid(id: &str) -> bool {
    (1..=64).contains(&id.len()) && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

async fn info(State(state): State<Arc<ApiState>>) -> Json<Value> {
    Json(state.info.clone())
}

async fn sessions(State(state): State<Arc<ApiState>>) -> Json<Value> {
    let list: Vec<Value> = crate::session::list(&state.sessions_dir)
        .into_iter()
        .map(|(id, modified)| {
            let secs = modified.duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or_default();
            json!({ "id": id, "modified": secs })
        })
        .collect();
    Json(json!({ "sessions": list }))
}

impl ApiState {
    fn open(&self, id: &str) -> Result<Arc<tokio::sync::Mutex<Open>>, String> {
        let mut open = self.open.lock().expect("open sessions");
        if let Some(session) = open.get(id) {
            return Ok(session.clone());
        }
        let session = Session::open(&self.sessions_dir, id)?;
        let entry = Arc::new(tokio::sync::Mutex::new(Open { session, grants: HashSet::new() }));
        open.insert(id.to_owned(), entry.clone());
        Ok(entry)
    }
}

async fn history(State(state): State<Arc<ApiState>>, Path(id): Path<String>) -> Response {
    if !valid(&id) {
        return error(StatusCode::BAD_REQUEST, "invalid_request_error", "not a session id");
    }
    let open = match state.open(&id) {
        Ok(open) => open,
        Err(e) => return error(StatusCode::INTERNAL_SERVER_ERROR, "internal_error", &e),
    };
    // A running turn holds the lock; its messages so far are on disk.
    let messages = match open.try_lock() {
        Ok(open) => open.session.messages.clone(),
        Err(_) => match Session::open(&state.sessions_dir, &id) {
            Ok(session) => session.messages,
            Err(e) => return error(StatusCode::INTERNAL_SERVER_ERROR, "internal_error", &e),
        },
    };
    Json(json!({ "id": id, "messages": messages })).into_response()
}

async fn reset(State(state): State<Arc<ApiState>>, Path(id): Path<String>) -> Response {
    if !valid(&id) {
        return error(StatusCode::BAD_REQUEST, "invalid_request_error", "not a session id");
    }
    let open = match state.open(&id) {
        Ok(open) => open,
        Err(e) => return error(StatusCode::INTERNAL_SERVER_ERROR, "internal_error", &e),
    };
    let Ok(mut open) = open.try_lock() else {
        return error(StatusCode::CONFLICT, "session_busy", "a turn is running in this session");
    };
    if let Err(e) = open.session.reset() {
        return error(StatusCode::INTERNAL_SERVER_ERROR, "internal_error", &e);
    }
    open.grants.clear();
    Json(json!({ "id": id })).into_response()
}

#[derive(Deserialize)]
struct TurnBody {
    text: String,
}

async fn turn(State(state): State<Arc<ApiState>>, Path(id): Path<String>, body: Bytes) -> Response {
    if !valid(&id) {
        return error(StatusCode::BAD_REQUEST, "invalid_request_error", "not a session id");
    }
    let Ok(TurnBody { text }) = serde_json::from_slice(&body) else {
        return error(StatusCode::BAD_REQUEST, "invalid_request_error", "the body must be {\"text\": \"...\"}");
    };
    if text.trim().is_empty() {
        return error(StatusCode::BAD_REQUEST, "invalid_request_error", "the text is empty");
    }
    let open = match state.open(&id) {
        Ok(open) => open,
        Err(e) => return error(StatusCode::INTERNAL_SERVER_ERROR, "internal_error", &e),
    };
    let Ok(mut guard) = open.clone().try_lock_owned() else {
        return error(StatusCode::CONFLICT, "session_busy", "a turn is running in this session");
    };

    let (tx, rx) = mpsc::unbounded_channel::<Value>();
    let agent = state.agent.clone();
    let waiting = state.waiting.clone();
    // The turn runs on its own: a client that goes away does not stop it.
    tokio::spawn(async move {
        let approver = ApiApprover { events: tx.clone(), waiting };
        let events = {
            let tx = tx.clone();
            move |event: Event| {
                let _ = tx.send(match event {
                    Event::Tool(text) => json!({ "type": "tool", "text": text }),
                    Event::Refused(text) => json!({ "type": "refused", "text": text }),
                    Event::Receipt { id, model, tier } => {
                        json!({ "type": "receipt", "id": id, "model": model, "tier": tier })
                    }
                });
            }
        };
        let Open { session, grants } = &mut *guard;
        let last = match agent.turn(session, &text, &approver, grants, &events).await {
            Ok(outcome) => json!({ "type": "answer", "text": outcome.text, "receipts": outcome.receipts }),
            Err(e) => json!({ "type": "error", "text": e }),
        };
        let _ = tx.send(last);
    });

    let stream = futures_util::stream::unfold(rx, |mut rx| async move {
        let event = rx.recv().await?;
        Some((Ok::<_, std::convert::Infallible>(Bytes::from(format!("data: {event}\n\n"))), rx))
    });
    let mut response = Response::new(Body::from_stream(stream));
    response.headers_mut().insert(header::CONTENT_TYPE, HeaderValue::from_static("text/event-stream"));
    response.headers_mut().insert(header::CACHE_CONTROL, HeaderValue::from_static("no-cache"));
    response
}

#[derive(Deserialize)]
struct ApproveBody {
    answer: String,
}

async fn approve(State(state): State<Arc<ApiState>>, Path(id): Path<String>, body: Bytes) -> Response {
    let answer = match serde_json::from_slice::<ApproveBody>(&body).map(|b| b.answer) {
        Ok(a) if a == "once" => Answer::Once,
        Ok(a) if a == "always" => Answer::Always,
        Ok(a) if a == "deny" => Answer::Deny,
        _ => return error(StatusCode::BAD_REQUEST, "invalid_request_error", "answer must be once, always or deny"),
    };
    match state.waiting.lock().expect("waiting").remove(&id) {
        Some(tx) => {
            let _ = tx.send(answer);
            Json(json!({ "ok": true })).into_response()
        }
        None => error(StatusCode::NOT_FOUND, "not_found", "no such question is waiting (answered or expired)"),
    }
}

async fn schedules(State(state): State<Arc<ApiState>>) -> Response {
    match crate::cron::listing(&state.home) {
        Ok(list) => Json(list).into_response(),
        Err(e) => error(StatusCode::INTERNAL_SERVER_ERROR, "internal_error", &e),
    }
}

#[derive(Deserialize)]
struct ScheduleBody {
    when: String,
    task: String,
    #[serde(default)]
    telegram: bool,
}

async fn add_schedule(State(state): State<Arc<ApiState>>, body: Bytes) -> Response {
    let Ok(ScheduleBody { when, task, telegram }) = serde_json::from_slice(&body) else {
        return error(
            StatusCode::BAD_REQUEST,
            "invalid_request_error",
            "the body must be {\"when\", \"task\", \"telegram\"}",
        );
    };
    let added = crate::cron::Schedules::load(&state.home).and_then(|mut schedules| {
        let id = schedules.add(&when, &task, telegram)?;
        schedules.save(&state.home)?;
        Ok(id)
    });
    match added {
        Ok(id) => Json(json!({ "id": id })).into_response(),
        Err(e) => error(StatusCode::BAD_REQUEST, "invalid_request_error", &e),
    }
}

async fn remove_schedule(State(state): State<Arc<ApiState>>, Path(id): Path<String>) -> Response {
    let removed = crate::cron::Schedules::load(&state.home).and_then(|mut schedules| {
        let removed = schedules.remove(&id);
        schedules.save(&state.home)?;
        Ok(removed)
    });
    match removed {
        Ok(true) => Json(json!({ "ok": true })).into_response(),
        Ok(false) => error(StatusCode::NOT_FOUND, "not_found", "no such scheduled task"),
        Err(e) => error(StatusCode::INTERNAL_SERVER_ERROR, "internal_error", &e),
    }
}

/// Asks through the turn's event stream; the answer comes back on `POST /v1/agent/approvals/{id}`.
struct ApiApprover {
    events: mpsc::UnboundedSender<Value>,
    waiting: Arc<Mutex<HashMap<String, oneshot::Sender<Answer>>>>,
}

impl Approver for ApiApprover {
    fn approve<'a>(&'a self, action: &'a Action) -> Pin<Box<dyn Future<Output = Answer> + Send + 'a>> {
        Box::pin(async move {
            let Ok(bytes) = invincible::token::random::<16>() else { return Answer::Deny };
            let id = invincible::token::hex(&bytes);
            let (tx, rx) = oneshot::channel();
            self.waiting.lock().expect("waiting").insert(id.clone(), tx);
            let _ = self.events.send(json!({
                "type": "approval",
                "id": id,
                "text": action.describe(),
                "action": describe(action),
            }));
            let answer = tokio::time::timeout(APPROVAL_WAIT, rx).await.ok().and_then(Result::ok);
            self.waiting.lock().expect("waiting").remove(&id);
            answer.unwrap_or(Answer::Deny)
        })
    }
}

/// [action] as spec/agent.md shows it to clients.
pub fn describe(action: &Action) -> Value {
    match action {
        Action::Command(command) => json!({ "kind": "command", "command": command }),
        Action::Write { path, bytes, inside } => {
            json!({ "kind": "write", "path": path.display().to_string(), "bytes": bytes, "inside": inside })
        }
        Action::Read(path) => json!({ "kind": "read", "path": path.display().to_string() }),
        Action::Cloud(reason) => json!({ "kind": "cloud", "reason": reason }),
    }
}
