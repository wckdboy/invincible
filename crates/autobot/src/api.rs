//! The agent's loopback API (spec/agent.md): Invincible Gateway passes `/v1/agent` through to it,
//! so paired devices can run turns and answer approvals on this machine.

use std::collections::{HashMap, HashSet};
use std::future::Future;
use std::path::PathBuf;
use std::pin::Pin;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use axum::body::{Body, Bytes};
use axum::extract::{Path, Query, Request, State};
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
    /// Messages for a session's running turn (`…/steer`).
    inboxes: Mutex<HashMap<String, crate::tools::Inbox>>,
    waiting: Waiting,
    /// For costs in `/usage` and `/insights` (`[prices]` in the config).
    prices: crate::insights::Prices,
}

/// The questions turns are waiting on, by id: where to send the answer, and the question as
/// `GET /v1/agent/approvals` lists it.
type Waiting = Arc<Mutex<HashMap<String, (oneshot::Sender<Answer>, Value)>>>;

/// A conversation and what the owner said "always" to in it.
struct Open {
    session: Session,
    grants: HashSet<Action>,
}

impl ApiState {
    fn inbox(&self, id: &str) -> crate::tools::Inbox {
        self.inboxes.lock().expect("inboxes").entry(id.to_owned()).or_default().clone()
    }

    /// [home]: `$AUTOBOT_HOME` (conversations in `sessions/`, schedules beside them).
    pub fn new(agent: Arc<Agent>, token: String, home: PathBuf, info: Value) -> Self {
        let sessions_dir = home.join("sessions");
        Self {
            agent,
            token,
            home,
            sessions_dir,
            info,
            open: Mutex::default(),
            inboxes: Mutex::default(),
            waiting: Arc::default(),
            prices: Default::default(),
        }
    }

    /// With the config's prices, for costs.
    pub fn with_prices(mut self, prices: crate::insights::Prices) -> Self {
        self.prices = prices;
        self
    }
}

pub fn app(state: Arc<ApiState>) -> Router {
    // Unauthenticated, and only that the agent answers and its version (the watchdog asks it).
    let health = Router::new()
        .route("/healthz", get(|| async { Json(json!({ "status": "ok", "version": invincible::version::VERSION })) }));
    let guarded = Router::new()
        .route("/v1/agent", get(info))
        .route("/v1/agent/sessions", get(sessions))
        .route("/v1/agent/sessions/{id}", get(history))
        .route("/v1/agent/sessions/{id}/turns", post(turn))
        .route("/v1/agent/sessions/{id}/retry", post(retry))
        .route("/v1/agent/sessions/{id}/reset", post(reset))
        .route("/v1/agent/sessions/{id}/steer", post(steer))
        .route("/v1/agent/sessions/{id}/fork", post(fork))
        .route("/v1/agent/approvals", get(approvals))
        .route("/v1/agent/approvals/{id}", post(approve))
        .route("/v1/agent/schedules", get(schedules).post(add_schedule))
        .route("/v1/agent/schedules/{id}", axum::routing::delete(remove_schedule))
        .route("/v1/agent/schedules/{id}/runs", get(schedule_runs))
        .route("/v1/agent/schedules/{id}/run", post(run_schedule))
        .route("/v1/agent/actions", get(actions))
        .route("/v1/agent/board", get(board))
        .route("/v1/agent/board/{id}/answer", post(answer_board))
        .route("/v1/agent/memory", get(memory))
        .route("/v1/agent/memory/{id}", axum::routing::delete(forget))
        .route("/v1/agent/skills", get(skills))
        .route("/v1/agent/skills/{name}/accept", post(accept_skill))
        .route("/v1/agent/skills/{name}/reject", post(reject_skill))
        .route("/v1/agent/personalities", get(personalities))
        .route("/v1/agent/personality", post(set_personality))
        .route("/v1/agent/profile", get(profile))
        .route("/v1/agent/usage", get(usage))
        .route("/v1/agent/insights", get(insights))
        .route_layer(middleware::from_fn_with_state(state.clone(), require_token));
    health.merge(guarded).with_state(state)
}

async fn require_token(State(state): State<Arc<ApiState>>, request: Request, next: Next) -> Response {
    let given = request
        .headers()
        .get(header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "))
        .unwrap_or_default();
    if !invincible::token::matches(&state.token, given) {
        return error(StatusCode::UNAUTHORIZED, "unauthorized", "the gateway's token is required");
    }
    // Every POST says it is JSON: a form or a no-cors fetch from a web page cannot.
    let json = request
        .headers()
        .get(header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .is_some_and(|v| v.split(';').next().is_some_and(|t| t.trim().eq_ignore_ascii_case("application/json")));
    if request.method() == axum::http::Method::POST && !json {
        return error(
            StatusCode::UNSUPPORTED_MEDIA_TYPE,
            "invalid_request_error",
            "send Content-Type: application/json",
        );
    }
    next.run(request).await
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
    /// A personality for this turn (`none` for none); the one in use otherwise.
    #[serde(default)]
    personality: Option<String>,
}

/// `POST …/fork {"to"?, "at"?}`: a new conversation that starts as this one did (up to
/// message `at`); its id.
async fn fork(State(state): State<Arc<ApiState>>, Path(id): Path<String>, body: Bytes) -> Response {
    let args: Value = serde_json::from_slice(&body).unwrap_or_default();
    let to = args["to"].as_str().map(str::to_owned).unwrap_or_else(|| {
        let stamp = chrono::Local::now().format("%H%M%S");
        format!("{}-fork-{stamp}", id.chars().take(48).collect::<String>())
    });
    let at = args["at"].as_u64().map(|n| n as usize);
    let forked =
        crate::session::Session::open(&state.sessions_dir, &id).and_then(|s| s.fork(&state.sessions_dir, &to, at));
    match forked {
        Ok(copy) => Json(json!({ "id": copy.id, "messages": copy.messages.len() })).into_response(),
        Err(e) => error(StatusCode::BAD_REQUEST, "invalid_request_error", &e),
    }
}

/// `POST …/steer {"text"}`: a message for the turn running in the session, taken in before
/// the agent's next step; `409` when no turn is running.
async fn steer(State(state): State<Arc<ApiState>>, Path(id): Path<String>, body: Bytes) -> Response {
    let Ok(TurnBody { text, .. }) = serde_json::from_slice(&body) else {
        return error(StatusCode::BAD_REQUEST, "invalid_request_error", "the body must be {\"text\": \"...\"}");
    };
    let open = match state.open(&id) {
        Ok(open) => open,
        Err(e) => return error(StatusCode::BAD_REQUEST, "invalid_request_error", &e),
    };
    if open.try_lock().is_ok() {
        return error(StatusCode::CONFLICT, "no_turn", "no turn is running in this session; start one");
    }
    state.inbox(&id).lock().expect("inbox").push(text);
    Json(json!({ "ok": true })).into_response()
}

async fn turn(State(state): State<Arc<ApiState>>, Path(id): Path<String>, body: Bytes) -> Response {
    if !valid(&id) {
        return error(StatusCode::BAD_REQUEST, "invalid_request_error", "not a session id");
    }
    let Ok(TurnBody { text, personality }) = serde_json::from_slice(&body) else {
        return error(StatusCode::BAD_REQUEST, "invalid_request_error", "the body must be {\"text\": \"...\"}");
    };
    if text.trim().is_empty() {
        return error(StatusCode::BAD_REQUEST, "invalid_request_error", "the text is empty");
    }
    if let Some(name) = personality.as_deref().filter(|p| !crate::personality::is_none(p))
        && let Err(e) = crate::personality::text(&state.home, name)
    {
        return error(StatusCode::BAD_REQUEST, "invalid_request_error", &e);
    }
    let open = match state.open(&id) {
        Ok(open) => open,
        Err(e) => return error(StatusCode::INTERNAL_SERVER_ERROR, "internal_error", &e),
    };
    let Ok(guard) = open.clone().try_lock_owned() else {
        return error(StatusCode::CONFLICT, "session_busy", "a turn is running in this session");
    };
    stream_turn(&state, id, guard, text, Vec::new(), personality)
}

/// `POST …/retry`: the last turn leaves the conversation and its request runs again, streamed
/// like a turn; `404` when there is no turn to retry.
async fn retry(State(state): State<Arc<ApiState>>, Path(id): Path<String>) -> Response {
    if !valid(&id) {
        return error(StatusCode::BAD_REQUEST, "invalid_request_error", "not a session id");
    }
    let open = match state.open(&id) {
        Ok(open) => open,
        Err(e) => return error(StatusCode::INTERNAL_SERVER_ERROR, "internal_error", &e),
    };
    let Ok(mut guard) = open.clone().try_lock_owned() else {
        return error(StatusCode::CONFLICT, "session_busy", "a turn is running in this session");
    };
    let request = match guard.session.take_back() {
        Ok(request) => request,
        Err(e) => return error(StatusCode::NOT_FOUND, "not_found", &e),
    };
    let text = request["content"].as_str().unwrap_or_default().to_owned();
    stream_turn(&state, id, guard, text, crate::images::of(&request), None)
}

/// Runs a turn on its own task and streams its events.
fn stream_turn(
    state: &Arc<ApiState>,
    id: String,
    mut guard: tokio::sync::OwnedMutexGuard<Open>,
    text: String,
    images: Vec<crate::images::Attachment>,
    personality: Option<String>,
) -> Response {
    let inbox = state.inbox(&id);
    let (tx, rx) = mpsc::unbounded_channel::<Value>();
    let agent = match personality {
        Some(personality) => {
            let mut agent = (*state.agent).clone();
            agent.options.personality = Some(personality);
            Arc::new(agent)
        }
        None => state.agent.clone(),
    };
    let waiting = state.waiting.clone();
    // The turn runs on its own: a client that goes away does not stop it.
    tokio::spawn(async move {
        let approver = ApiApprover { events: tx.clone(), waiting, session: id.clone() };
        let events = {
            let tx = tx.clone();
            move |event: Event| {
                let _ = tx.send(match event {
                    // The app shows the answer when it is done, and tool lines.
                    Event::Text(_)
                    | Event::Reasoning(_)
                    | Event::Diff(_)
                    | Event::Output { .. }
                    | Event::Usage { .. } => return,
                    Event::Tool(text) => json!({ "type": "tool", "text": text }),
                    Event::Refused(text) => json!({ "type": "refused", "text": text }),
                    Event::Receipt { id, model, tier } => {
                        json!({ "type": "receipt", "id": id, "model": model, "tier": tier })
                    }
                    Event::Member { name, text } => json!({ "type": "member", "agent": name, "text": text }),
                });
            }
        };
        let Open { session, grants } = &mut *guard;
        let context = crate::tools::TurnContext { inbox: Some(inbox), ..Default::default() };
        let turn = agent.turn_with(session, &text, &images, &approver, grants, &events);
        let last = match crate::tools::TURN.scope(context, turn).await {
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
    /// With `"instead"`: what the owner wants done instead.
    #[serde(default)]
    text: String,
}

/// The questions waiting for the owner now, oldest first.
async fn approvals(State(state): State<Arc<ApiState>>) -> Response {
    let mut list: Vec<Value> = state.waiting.lock().expect("waiting").values().map(|(_, q)| q.clone()).collect();
    list.sort_by_key(|q| q["asked_at"].as_u64().unwrap_or(0));
    Json(json!({ "approvals": list })).into_response()
}

async fn approve(State(state): State<Arc<ApiState>>, Path(id): Path<String>, body: Bytes) -> Response {
    let answer = match serde_json::from_slice::<ApproveBody>(&body) {
        Ok(b) if b.answer == "once" => Answer::Once,
        Ok(b) if b.answer == "always" => Answer::Always,
        Ok(b) if b.answer == "deny" => Answer::Deny,
        Ok(b) if b.answer == "instead" && !b.text.trim().is_empty() => Answer::Instead(b.text.trim().to_owned()),
        _ => {
            return error(
                StatusCode::BAD_REQUEST,
                "invalid_request_error",
                "answer must be once, always, deny, or instead with a text",
            );
        }
    };
    match state.waiting.lock().expect("waiting").remove(&id) {
        Some((tx, _)) => {
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

async fn add_schedule(State(state): State<Arc<ApiState>>, headers: axum::http::HeaderMap, body: Bytes) -> Response {
    let Ok(spec) = serde_json::from_slice::<crate::cron::ScheduleSpec>(&body) else {
        return error(
            StatusCode::BAD_REQUEST,
            "invalid_request_error",
            "the body must be {\"when\", \"task\"} with optional \"telegram\", \"id\", \"name\", \"tools\", \"enabled\"",
        );
    };
    // The gateway says which device handed it over.
    let origin = headers
        .get(invincible::server::CALLER_HEADER)
        .and_then(|v| v.to_str().ok())
        .filter(|v| v.starts_with("device:"))
        .map(str::to_owned);
    let added = crate::cron::Schedules::load(&state.home).and_then(|mut schedules| {
        let id = schedules.put(spec, origin)?;
        schedules.save(&state.home)?;
        Ok(id)
    });
    match added {
        Ok(id) => Json(json!({ "id": id })).into_response(),
        Err(e) => error(StatusCode::BAD_REQUEST, "invalid_request_error", &e),
    }
}

#[derive(Deserialize)]
struct ActionsQuery {
    #[serde(default)]
    since: u64,
    limit: Option<usize>,
}

async fn actions(State(state): State<Arc<ApiState>>, Query(q): Query<ActionsQuery>) -> Json<Value> {
    let log = crate::actions::ActionLog::new(&state.home);
    Json(json!({ "actions": log.read(q.since, q.limit.unwrap_or(100).clamp(1, 500)) }))
}

async fn board(State(state): State<Arc<ApiState>>) -> Response {
    match crate::board::Board::load(&state.home) {
        Ok(board) => Json(json!({ "tasks": board.tasks })).into_response(),
        Err(e) => error(StatusCode::INTERNAL_SERVER_ERROR, "internal_error", &e),
    }
}

async fn answer_board(State(state): State<Arc<ApiState>>, Path(id): Path<String>, body: Bytes) -> Response {
    let Some(text) = serde_json::from_slice::<Value>(&body).ok().and_then(|b| b["text"].as_str().map(str::to_owned))
    else {
        return error(StatusCode::BAD_REQUEST, "invalid_request_error", "the body is {\"text\": \"…\"}");
    };
    let answered = crate::board::Board::load(&state.home).and_then(|mut board| {
        board.answer(&id, &text)?;
        board.save(&state.home)
    });
    match answered {
        Ok(()) => Json(json!({ "ok": true })).into_response(),
        Err(e) => error(StatusCode::NOT_FOUND, "not_found", &e),
    }
}

async fn memory(State(state): State<Arc<ApiState>>) -> Json<Value> {
    Json(json!({ "facts": crate::memory::Memory::new(&state.home).list() }))
}

async fn forget(State(state): State<Arc<ApiState>>, Path(id): Path<u64>) -> Response {
    match crate::memory::Memory::new(&state.home).forget(id) {
        Ok(true) => Json(json!({ "ok": true })).into_response(),
        Ok(false) => error(StatusCode::NOT_FOUND, "not_found", "no such fact"),
        Err(e) => error(StatusCode::INTERNAL_SERVER_ERROR, "internal_error", &e),
    }
}

async fn skills(State(state): State<Arc<ApiState>>) -> Json<Value> {
    let skills: Vec<Value> = crate::skills::list(&state.home)
        .into_iter()
        .map(|s| {
            json!({ "name": s.name, "description": s.description, "allowed_tools": s.allowed_tools, "files": s.dir().is_some() })
        })
        .collect();
    let proposed: Vec<Value> = crate::skills::proposals(&state.home)
        .into_iter()
        .map(|s| {
            let text = std::fs::read_to_string(&s.path).unwrap_or_default();
            let diff = crate::skills::proposal_diff(&state.home, &s.name);
            json!({ "name": s.name, "description": s.description, "text": text, "improves": s.improves, "diff": diff })
        })
        .collect();
    Json(json!({ "skills": skills, "proposed": proposed }))
}

async fn personalities(State(state): State<Arc<ApiState>>) -> Json<Value> {
    let list: Vec<Value> = crate::personality::list(&state.home)
        .into_iter()
        .map(|p| json!({ "name": p.name, "description": p.description, "builtin": p.path.is_none() }))
        .collect();
    Json(json!({
        "active": crate::personality::active(&state.home),
        "soul": crate::personality::soul(&state.home),
        "personalities": list,
    }))
}

/// `POST /v1/agent/personality {"name"}`: the one in use from now on (`none`, or null, for none).
async fn set_personality(State(state): State<Arc<ApiState>>, body: Bytes) -> Response {
    let Ok(args) = serde_json::from_slice::<Value>(&body) else {
        return error(StatusCode::BAD_REQUEST, "invalid_request_error", "the body is {\"name\": \"…\"}");
    };
    let name = args["name"].as_str().unwrap_or("none");
    match crate::personality::set(&state.home, name) {
        Ok(()) => Json(json!({ "active": crate::personality::active(&state.home) })).into_response(),
        Err(e) => error(StatusCode::BAD_REQUEST, "invalid_request_error", &e),
    }
}

async fn profile(State(state): State<Arc<ApiState>>) -> Json<Value> {
    Json(json!({ "entries": crate::profile::entries(&state.home), "text": crate::profile::read(&state.home) }))
}

#[derive(Deserialize)]
struct UsageQuery {
    session: Option<String>,
}

/// Today (and one conversation): turns, model calls, tokens, time, cost.
async fn usage(State(state): State<Arc<ApiState>>, Query(q): Query<UsageQuery>) -> Json<Value> {
    use crate::insights::{Log, today, totals};
    let log = Log::new(&state.home);
    let mut out = json!({ "today": totals(&log.read(today()), &state.prices) });
    if let Some(session) = q.session.filter(|s| valid(s)) {
        let mine: Vec<_> = log.read(0).into_iter().filter(|r| r.session == session).collect();
        out["session"] = json!(totals(&mine, &state.prices));
    }
    Json(out)
}

#[derive(Deserialize)]
struct InsightsQuery {
    days: Option<u32>,
}

async fn insights(State(state): State<Arc<ApiState>>, Query(q): Query<InsightsQuery>) -> Json<Value> {
    Json(crate::insights::insights(&state.home, q.days.unwrap_or(7).clamp(1, 3650), &state.prices))
}

async fn accept_skill(State(state): State<Arc<ApiState>>, Path(name): Path<String>) -> Response {
    match crate::skills::accept(&state.home, &name) {
        Ok(()) => Json(json!({ "ok": true })).into_response(),
        Err(e) => error(StatusCode::NOT_FOUND, "not_found", &e),
    }
}

async fn reject_skill(State(state): State<Arc<ApiState>>, Path(name): Path<String>) -> Response {
    match crate::skills::reject(&state.home, &name) {
        Ok(true) => Json(json!({ "ok": true })).into_response(),
        Ok(false) => error(StatusCode::NOT_FOUND, "not_found", "no such proposed skill"),
        Err(e) => error(StatusCode::INTERNAL_SERVER_ERROR, "internal_error", &e),
    }
}

#[derive(Deserialize)]
struct RunsQuery {
    #[serde(default)]
    after: i64,
}

/// A schedule's finished runs after `after` (unix seconds), oldest first: the whole answers and
/// their receipt ids, for a phone collecting a recipe's results.
async fn schedule_runs(
    State(state): State<Arc<ApiState>>,
    Path(id): Path<String>,
    Query(q): Query<RunsQuery>,
) -> Response {
    if !crate::cron::valid_id(&id) {
        return error(StatusCode::NOT_FOUND, "not_found", "no such scheduled task");
    }
    Json(json!({ "runs": crate::cron::runs(&state.home, &id, q.after) })).into_response()
}

/// Runs a schedule now, in the background; its run shows up in `/runs` when it is done.
async fn run_schedule(State(state): State<Arc<ApiState>>, Path(id): Path<String>) -> Response {
    let schedule = match crate::cron::Schedules::load(&state.home) {
        Ok(schedules) => schedules.schedules.into_iter().find(|s| s.id == id),
        Err(e) => return error(StatusCode::INTERNAL_SERVER_ERROR, "internal_error", &e),
    };
    let Some(schedule) = schedule else { return error(StatusCode::NOT_FOUND, "not_found", "no such scheduled task") };
    if crate::cron::start(state.agent.clone(), state.home.clone(), schedule, "manual", None) {
        (StatusCode::ACCEPTED, Json(json!({ "started": true }))).into_response()
    } else {
        error(StatusCode::CONFLICT, "schedule_running", "it is running already")
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
    waiting: Waiting,
    /// The conversation the turn runs in.
    session: String,
}

impl Approver for ApiApprover {
    fn channel(&self) -> &'static str {
        "app"
    }

    fn approve<'a>(&'a self, action: &'a Action) -> Pin<Box<dyn Future<Output = Answer> + Send + 'a>> {
        Box::pin(async move {
            let Ok(bytes) = invincible::token::random::<16>() else { return Answer::Deny };
            let id = invincible::token::hex(&bytes);
            let (tx, rx) = oneshot::channel();
            let mut event = json!({
                "type": "approval",
                "id": id,
                "text": format!("{}{}", crate::approval::asker(), action.describe()),
                "action": describe(action),
            });
            // A team member's question says whose it is.
            if let Some(agent) = crate::tools::TURN.try_with(|t| t.agent.clone()).ok().flatten() {
                event["agent"] = json!(agent);
            }
            let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.as_secs());
            let mut question = event.clone();
            if let Some(q) = question.as_object_mut() {
                q.remove("type");
                q.insert("session".into(), json!(self.session));
                q.insert("asked_at".into(), json!(now));
                q.insert("expires_at".into(), json!(now + APPROVAL_WAIT.as_secs()));
            }
            self.waiting.lock().expect("waiting").insert(id.clone(), (tx, question));
            let _ = self.events.send(event);
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
        Action::Write { path, bytes, inside, .. } => {
            json!({ "kind": "write", "path": path.display().to_string(), "bytes": bytes, "inside": inside })
        }
        Action::Read(path) => json!({ "kind": "read", "path": path.display().to_string() }),
        Action::Cloud(reason) => json!({ "kind": "cloud", "reason": reason }),
        Action::Fetch(url) => json!({ "kind": "fetch", "url": url }),
        Action::Mcp { tool, arguments } => json!({ "kind": "mcp", "tool": tool, "arguments": arguments }),
        Action::Type { page, field, text, submit } => {
            json!({ "kind": "type", "page": page, "field": field, "text": text, "submit": submit })
        }
    }
}
