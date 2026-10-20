//! The agent's loopback API (spec/agent.md): Invincible Gateway passes `/v1/agent` through to it,
//! so paired devices can run turns and answer approvals on this machine.
//!
//! With several bots ([crate::bots]), every path takes `?bot=<name>` (the default bot without
//! it); `GET /v1/agent/bots` lists them, and approvals say which bot asks. Served with a
//! [Fleet], the bots are the ones running now: started and stopped while the API runs.

use std::collections::{HashMap, HashSet};
use std::future::Future;
use std::pin::Pin;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use axum::body::{Body, Bytes};
use axum::extract::{FromRequestParts, Path, Query, Request, State};
use axum::http::{HeaderValue, StatusCode, header, request::Parts};
use axum::middleware::{self, Next};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use serde::Deserialize;
use serde_json::{Value, json};
use tokio::sync::{mpsc, oneshot};

use crate::agent::{Agent, Event};
use crate::approval::{Action, Answer, Approver};
use crate::bots::{Fleet, Runtime};
use crate::session::Session;

/// How long a question waits for an answer.
const APPROVAL_WAIT: Duration = Duration::from_secs(10 * 60);
/// How long a turn's stream stays open after its answer for what the nudge kept.
const NUDGE_WAIT: Duration = Duration::from_secs(30);

pub struct ApiState {
    token: String,
    /// The bots, the default one first: as served now, with a [Fleet].
    bots: Mutex<Vec<Arc<BotApi>>>,
    /// The bots `autobot serve` runs, when it is serving them.
    fleet: Option<Arc<Fleet>>,
    waiting: Waiting,
    /// `$AUTOBOT_HOME`, when serving its bots: the ones not running are listed from there.
    root: Option<std::path::PathBuf>,
    /// Bots that could not start, and why.
    failed: Vec<(String, String)>,
    /// Prices for `/usage` and `/insights`, for every bot; each bot's own `[prices]` without.
    prices: Option<crate::insights::Prices>,
}

/// One bot as the API serves it.
pub struct BotApi {
    runtime: Arc<Runtime>,
    info: Value,
    open: Mutex<HashMap<String, Arc<tokio::sync::Mutex<Open>>>>,
    /// Messages for a session's running turn (`…/steer`).
    inboxes: Mutex<HashMap<String, crate::tools::Inbox>>,
}

/// The questions turns are waiting on, by id: where to send the answer, and the question as
/// `GET /v1/agent/approvals` lists it.
type Waiting = Arc<Mutex<HashMap<String, (oneshot::Sender<Answer>, Value)>>>;

/// A conversation and what the owner said "always" to in it.
struct Open {
    session: Session,
    grants: HashSet<Action>,
}

impl BotApi {
    fn new(runtime: Arc<Runtime>, info: Value) -> Arc<Self> {
        Arc::new(Self { runtime, info, open: Mutex::default(), inboxes: Mutex::default() })
    }

    fn agent(&self) -> Arc<Agent> {
        self.runtime.agent()
    }

    fn home(&self) -> &std::path::Path {
        &self.runtime.home
    }

    fn sessions_dir(&self) -> std::path::PathBuf {
        self.runtime.home.join("sessions")
    }

    fn inbox(&self, id: &str) -> crate::tools::Inbox {
        self.inboxes.lock().expect("inboxes").entry(id.to_owned()).or_default().clone()
    }

    fn open(&self, id: &str) -> Result<Arc<tokio::sync::Mutex<Open>>, String> {
        let mut open = self.open.lock().expect("open sessions");
        if let Some(session) = open.get(id) {
            return Ok(session.clone());
        }
        let session = Session::open(&self.sessions_dir(), id)?;
        let entry = Arc::new(tokio::sync::Mutex::new(Open { session, grants: HashSet::new() }));
        open.insert(id.to_owned(), entry.clone());
        Ok(entry)
    }
}

impl ApiState {
    /// One bot: [agent] with its home [home] (`$AUTOBOT_HOME`: conversations in `sessions/`,
    /// schedules beside them), described by [info].
    pub fn new(agent: Arc<Agent>, token: String, home: std::path::PathBuf, info: Value) -> Self {
        let runtime = Runtime::standalone(crate::bots::DEFAULT, &home, agent);
        Self {
            token,
            bots: Mutex::new(vec![BotApi::new(runtime, info)]),
            fleet: None,
            waiting: Arc::default(),
            root: None,
            failed: Vec::new(),
            prices: None,
        }
    }

    /// The bots [fleet] runs, as it runs them now (`autobot serve`).
    pub fn for_fleet(token: String, fleet: Arc<Fleet>) -> Self {
        let root = Some(fleet.root().to_owned());
        Self {
            token,
            bots: Mutex::default(),
            fleet: Some(fleet),
            waiting: Arc::default(),
            root,
            failed: Vec::new(),
            prices: None,
        }
    }

    /// The bots served now, the default one first. With a [Fleet], a bot keeps its open
    /// conversations while it runs; one started again starts afresh.
    fn bots(&self) -> Vec<Arc<BotApi>> {
        let mut bots = self.bots.lock().expect("bots");
        let Some(fleet) = &self.fleet else { return bots.clone() };
        let next: Vec<Arc<BotApi>> = fleet
            .runtimes()
            .into_iter()
            .map(|r| {
                bots.iter().find(|b| Arc::ptr_eq(&b.runtime, &r)).cloned().unwrap_or_else(|| {
                    let info = info_of(&r);
                    BotApi::new(r, info)
                })
            })
            .collect();
        *bots = next.clone();
        next
    }

    /// Bots that could not start, and why.
    fn failed(&self) -> Vec<(String, String)> {
        match &self.fleet {
            Some(fleet) => fleet.failed(),
            None => self.failed.clone(),
        }
    }

    /// Every bot `autobot serve` runs, the default one first. [root] is `$AUTOBOT_HOME`, where
    /// the bots it does not run are found (disabled ones; [failed] could not start, and why).
    pub fn for_bots(
        token: String,
        runtimes: &[Arc<Runtime>],
        root: Option<std::path::PathBuf>,
        failed: Vec<(String, String)>,
    ) -> Self {
        let bots = runtimes.iter().map(|r| BotApi::new(r.clone(), info_of(r))).collect();
        Self { token, bots: Mutex::new(bots), fleet: None, waiting: Arc::default(), root, failed, prices: None }
    }

    /// With these prices, for costs in `/usage` and `/insights`, instead of each bot's `[prices]`.
    pub fn with_prices(mut self, prices: crate::insights::Prices) -> Self {
        self.prices = Some(prices);
        self
    }

    fn prices_for(&self, bot: &BotApi) -> crate::insights::Prices {
        self.prices.clone().unwrap_or_else(|| bot.runtime.config.prices.clone())
    }

    fn named(&self, name: &str) -> Option<Arc<BotApi>> {
        self.bots().into_iter().find(|b| b.runtime.name == name)
    }

    /// The bot whose conversation [id] is: the first one holding it.
    fn owner(&self, id: &str) -> Option<Arc<BotApi>> {
        if !valid(id) {
            return None;
        }
        self.bots().into_iter().find(|b| {
            b.sessions_dir().join(format!("{id}.jsonl")).is_file() || b.open.lock().expect("open").contains_key(id)
        })
    }
}

fn unknown_bot(name: &str) -> Response {
    error(StatusCode::NOT_FOUND, "unknown_bot", &format!("no bot {name:?} here"))
}

/// `GET /v1/agent` for [runtime].
pub fn info_of(runtime: &Runtime) -> Value {
    let agent = runtime.agent();
    json!({
        "name": if runtime.default { "Autobot".to_owned() } else { runtime.name.clone() },
        "model": agent.gateway.model(),
        "workdir": agent.tools.workdir().display().to_string(),
        "approvals": format!("{:?}", agent.approvals.mode).to_lowercase(),
        "private": runtime.config.gateway.private,
    })
}

/// `?bot=<name>`, when given.
fn wanted(parts: &Parts) -> Option<String> {
    parts.uri.query().and_then(|q| {
        q.split('&').find_map(|pair| pair.strip_prefix("bot=").map(|v| v.to_owned())).filter(|v| !v.is_empty())
    })
}

/// The bot a request is for: `?bot=<name>`; for a conversation's path, the bot holding it; else
/// the default one. The flag: it was chosen by default (a new conversation's turn may name its
/// bot in the body instead).
pub struct Bot(Arc<BotApi>, bool);

impl FromRequestParts<Arc<ApiState>> for Bot {
    type Rejection = Response;

    async fn from_request_parts(parts: &mut Parts, state: &Arc<ApiState>) -> Result<Self, Self::Rejection> {
        if let Some(name) = wanted(parts) {
            return state.named(&name).map(|b| Bot(b, false)).ok_or_else(|| unknown_bot(&name));
        }
        let session =
            parts.uri.path().strip_prefix("/v1/agent/sessions/").map(|rest| rest.split('/').next().unwrap_or(""));
        if let Some(owner) = session.and_then(|id| state.owner(id)) {
            return Ok(Bot(owner, false));
        }
        state.bots().first().cloned().map(|b| Bot(b, true)).ok_or_else(|| unknown_bot(""))
    }
}

/// The first line of a bot's persona.
fn persona(home: &std::path::Path) -> String {
    crate::bots::soul(home)
        .and_then(|s| s.lines().map(|l| l.trim().trim_start_matches('#').trim().to_owned()).find(|l| !l.is_empty()))
        .unwrap_or_default()
}

/// The conversations in [home]: how many, and when the newest changed (Unix seconds).
fn activity(home: &std::path::Path) -> (usize, Option<u64>) {
    let list = crate::session::list(&home.join("sessions"));
    let last = list.first().and_then(|(_, t)| t.duration_since(std::time::UNIX_EPOCH).ok()).map(|d| d.as_secs());
    (list.len(), last)
}

/// A channel's account as configured, for a bot that is not running.
fn configured_account(def: &crate::bots::Def, kind: &str) -> String {
    let c = &def.config;
    match kind {
        "email" => c.email.address.clone(),
        "whatsapp" => c.whatsapp.phone_number_id.clone(),
        "signal" => c.signal.account.clone(),
        "matrix" => c.matrix.homeserver.clone(),
        _ => String::new(),
    }
}

/// One bot as `GET /v1/agent/bots` lists it (spec/agent.md).
fn bot_item(def: Option<&crate::bots::Def>, bot: Option<&BotApi>, failed: Option<&str>) -> Value {
    let (name, home) = match (bot, def) {
        (Some(b), _) => (b.runtime.name.clone(), b.runtime.home.clone()),
        (None, Some(d)) => (d.name.clone(), d.home.clone()),
        (None, None) => return Value::Null,
    };
    let (sessions, last_active) = activity(&home);
    let mut item = match bot {
        Some(b) => b.runtime.status(),
        None => json!({ "name": name, "default": def.is_some_and(|d| d.default) }),
    };
    let channels: Vec<Value> = match bot {
        Some(b) => {
            let s = b.runtime.status();
            let accounts = b.runtime.accounts();
            let mut list: Vec<Value> = s["channels"]
                .as_object()
                .into_iter()
                .flatten()
                .filter(|(kind, _)| crate::pairing::PLATFORMS.contains(&kind.as_str()))
                .map(|(kind, state)| {
                    let state = state.as_str().unwrap_or_default();
                    let (status, error) = match state {
                        "connected" => ("connected", None),
                        "starting" => ("connecting", None),
                        s if s.starts_with("off: ") => ("down", Some(&s[5..])),
                        s => ("connecting", Some(s.split_once(": ").map_or(s, |(_, e)| e))),
                    };
                    let account = accounts
                        .get(kind)
                        .cloned()
                        .unwrap_or_else(|| def.map(|d| configured_account(d, kind)).unwrap_or_default());
                    let mut channel = json!({ "kind": kind, "account": account, "status": status });
                    if let Some(error) = error {
                        channel["error"] = json!(error);
                    }
                    channel
                })
                .collect();
            list.push(json!({ "kind": "api", "account": format!("/v1/agent?bot={name}"), "status": "connected" }));
            list
        }
        None => def
            .map(|d| {
                d.channels()
                    .into_iter()
                    .map(|kind| json!({ "kind": kind, "account": configured_account(d, kind), "status": "down" }))
                    .collect()
            })
            .unwrap_or_default(),
    };
    let model = match (bot, def) {
        (Some(b), _) => b.agent().gateway.model().to_owned(),
        (None, Some(d)) => d.config.gateway.model.clone(),
        _ => String::new(),
    };
    let approvals = match (bot, def) {
        (Some(b), _) => format!("{:?}", b.agent().approvals.mode).to_lowercase(),
        (None, Some(d)) => format!("{:?}", d.config.approvals.mode).to_lowercase(),
        _ => "ask".to_owned(),
    };
    let status = if bot.is_some() {
        "running"
    } else if failed.is_some() {
        "error"
    } else {
        "stopped"
    };
    item["name"] = json!(name);
    item["persona"] = json!(persona(&home));
    item["model"] = json!(model);
    item["approvals"] = json!(approvals);
    item["enabled"] = json!(def.is_none_or(|d| d.enabled()));
    item["status"] = json!(status);
    if let Some(e) = failed {
        item["error"] = json!(e);
    }
    item["channels"] = json!(channels);
    item["sessions"] = json!(sessions);
    item["last_active"] = json!(last_active);
    item["queue"] = json!(item["queued"].as_u64().unwrap_or(0));
    item
}

pub fn app(state: Arc<ApiState>) -> Router {
    // Unauthenticated, and only that the agent answers and its version (the watchdog asks it).
    let health = Router::new()
        .route("/healthz", get(|| async { Json(json!({ "status": "ok", "version": invincible::version::VERSION })) }));
    let guarded = Router::new()
        .route("/v1/agent", get(info))
        .route("/v1/agent/bots", get(bots))
        .route("/v1/agent/bots/{name}/enable", post(enable_bot))
        .route("/v1/agent/bots/{name}/disable", post(disable_bot))
        .route("/v1/agent/bots/reload", post(reload_bots))
        .route("/v1/agent/openai/v1/models", get(openai_models))
        .route("/v1/agent/openai/v1/chat/completions", post(openai_chat))
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

async fn info(State(state): State<Arc<ApiState>>, Bot(bot, _): Bot) -> Json<Value> {
    let mut info = bot.info.clone();
    // The model may have changed (`/model`).
    info["model"] = json!(bot.agent().gateway.model());
    info["bot"] = json!(bot.runtime.name);
    info["bots"] = json!(state.bots().iter().map(|b| b.runtime.name.clone()).collect::<Vec<_>>());
    Json(info)
}

/// `GET /v1/agent/bots`: every bot, running or not, with how it is doing.
async fn bots(State(state): State<Arc<ApiState>>) -> Json<Value> {
    let defs = state.root.as_deref().and_then(|root| crate::bots::load_all(root).ok());
    let mut list: Vec<Value> = Vec::new();
    let mut named: Vec<String> = Vec::new();
    let all_failed = state.failed();
    if let Some((defs, problems)) = &defs {
        for def in defs {
            let bot = state.named(&def.name);
            let failed = all_failed.iter().find(|(n, _)| *n == def.name).map(|(_, e)| e.as_str());
            list.push(bot_item(Some(def), bot.as_deref(), failed));
            named.push(def.name.clone());
        }
        for (name, problem) in problems {
            list.push(json!({
                "name": name, "persona": "", "model": "", "approvals": "ask", "enabled": false,
                "status": "error", "error": problem, "channels": [], "sessions": 0, "last_active": null, "queue": 0,
            }));
            named.push(name.clone());
        }
    }
    // Bots served here whose directory is not under a root (tests, embedded uses).
    for bot in &state.bots() {
        if !named.contains(&bot.runtime.name) {
            list.push(bot_item(None, Some(bot), None));
        }
    }
    Json(json!({ "bots": list }))
}

/// `POST /v1/agent/bots/{name}/enable` and `…/disable`: kept in its config, and with
/// `autobot serve` started or stopped at once.
async fn enable_bot(State(state): State<Arc<ApiState>>, Path(name): Path<String>) -> Response {
    set_bot(&state, &name, true)
}

async fn disable_bot(State(state): State<Arc<ApiState>>, Path(name): Path<String>) -> Response {
    set_bot(&state, &name, false)
}

fn set_bot(state: &ApiState, name: &str, enabled: bool) -> Response {
    let Some(root) = &state.root else {
        return if state.named(name).is_some() {
            error(StatusCode::CONFLICT, "not_configurable", "this agent has no bot configuration to change")
        } else {
            unknown_bot(name)
        };
    };
    if crate::bots::load(root, name).is_err() {
        return unknown_bot(name);
    }
    if let Err(e) = crate::bots::set_enabled(root, name, enabled) {
        return error(StatusCode::INTERNAL_SERVER_ERROR, "internal_error", &e);
    }
    let Some(fleet) = &state.fleet else {
        return Json(json!({ "ok": true, "enabled": enabled, "restart": true })).into_response();
    };
    let reloaded = fleet.reload();
    let status = match (&reloaded, state.named(name).is_some()) {
        (_, true) => "running",
        (Ok(done), false) if done.failed.iter().any(|(n, _)| n == name) => "error",
        _ => "stopped",
    };
    let mut answer = json!({ "ok": true, "enabled": enabled, "restart": false, "status": status });
    match reloaded {
        Ok(done) => {
            if let Some((_, e)) = done.failed.iter().find(|(n, _)| n == name) {
                answer["error"] = json!(e);
            }
        }
        Err(e) => answer["error"] = json!(e),
    }
    Json(answer).into_response()
}

/// `POST /v1/agent/bots/reload`: the running bots brought in line with their configuration now
/// (`autobot serve` also does it on its own when the files change).
async fn reload_bots(State(state): State<Arc<ApiState>>) -> Response {
    let Some(fleet) = &state.fleet else {
        return error(StatusCode::CONFLICT, "not_configurable", "this agent has no bot configuration to reload");
    };
    match fleet.reload() {
        Ok(done) => {
            let mut answer = done.to_json();
            answer["running"] = json!(fleet.runtimes().iter().map(|r| r.name.clone()).collect::<Vec<_>>());
            Json(answer).into_response()
        }
        Err(e) => error(StatusCode::BAD_REQUEST, "invalid_config", &e),
    }
}

/// `GET /v1/agent/openai/v1/models`: the bots, for an OpenAI-compatible client to pick
/// (Home Assistant's conversation agent, [crate::homeassistant]).
async fn openai_models(State(state): State<Arc<ApiState>>) -> Response {
    let names: Vec<String> = state.bots().iter().map(|b| b.runtime.name.clone()).collect();
    crate::homeassistant::models(&names)
}

/// `POST /v1/agent/openai/v1/chat/completions`: a turn of the bot `model` names (`?bot=`, or the
/// default one), in the OpenAI shape.
async fn openai_chat(State(state): State<Arc<ApiState>>, Bot(bot, chosen): Bot, body: Bytes) -> Response {
    let model = serde_json::from_slice::<Value>(&body).ok().and_then(|b| b["model"].as_str().map(str::to_owned));
    let bot = match model.and_then(|m| state.named(&m)) {
        Some(named) if chosen => named,
        _ => bot,
    };
    crate::homeassistant::conversation(bot.runtime.clone(), &body).await
}

/// `GET /v1/agent/sessions`: every bot's conversations, newest first; `?bot=` only one's.
async fn sessions(State(state): State<Arc<ApiState>>, query: Query<HashMap<String, String>>) -> Response {
    let bots: Vec<Arc<BotApi>> = match query.get("bot").filter(|b| !b.is_empty()) {
        Some(name) => match state.named(name) {
            Some(bot) => vec![bot],
            None => return unknown_bot(name),
        },
        None => state.bots(),
    };
    let mut list: Vec<(u64, Value)> = Vec::new();
    for bot in &bots {
        for (id, modified) in crate::session::list(&bot.sessions_dir()) {
            let secs = modified.duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or_default();
            list.push((secs, json!({ "id": id, "modified": secs, "bot": bot.runtime.name })));
        }
    }
    list.sort_by(|a, b| b.0.cmp(&a.0));
    Json(json!({ "sessions": list.into_iter().map(|(_, v)| v).collect::<Vec<_>>() })).into_response()
}

async fn history(Bot(bot, _): Bot, Path(id): Path<String>) -> Response {
    if !valid(&id) {
        return error(StatusCode::BAD_REQUEST, "invalid_request_error", "not a session id");
    }
    let open = match bot.open(&id) {
        Ok(open) => open,
        Err(e) => return error(StatusCode::INTERNAL_SERVER_ERROR, "internal_error", &e),
    };
    // A running turn holds the lock; its messages so far are on disk.
    let messages = match open.try_lock() {
        Ok(open) => open.session.messages.clone(),
        Err(_) => match Session::open(&bot.sessions_dir(), &id) {
            Ok(session) => session.messages,
            Err(e) => return error(StatusCode::INTERNAL_SERVER_ERROR, "internal_error", &e),
        },
    };
    Json(json!({ "id": id, "messages": messages })).into_response()
}

async fn reset(Bot(bot, _): Bot, Path(id): Path<String>) -> Response {
    if !valid(&id) {
        return error(StatusCode::BAD_REQUEST, "invalid_request_error", "not a session id");
    }
    let open = match bot.open(&id) {
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
    /// Which bot answers a new conversation (an existing one keeps its bot).
    #[serde(default)]
    bot: Option<String>,
    /// A personality for this turn (`none` for none); the one in use otherwise.
    #[serde(default)]
    personality: Option<String>,
}

/// `POST …/fork {"to"?, "at"?}`: a new conversation that starts as this one did (up to
/// message `at`); its id.
async fn fork(Bot(bot, _): Bot, Path(id): Path<String>, body: Bytes) -> Response {
    let args: Value = serde_json::from_slice(&body).unwrap_or_default();
    let to = args["to"].as_str().map(str::to_owned).unwrap_or_else(|| {
        let stamp = chrono::Local::now().format("%H%M%S");
        format!("{}-fork-{stamp}", id.chars().take(48).collect::<String>())
    });
    let at = args["at"].as_u64().map(|n| n as usize);
    let forked =
        crate::session::Session::open(&bot.sessions_dir(), &id).and_then(|s| s.fork(&bot.sessions_dir(), &to, at));
    match forked {
        Ok(copy) => Json(json!({ "id": copy.id, "messages": copy.messages.len() })).into_response(),
        Err(e) => error(StatusCode::BAD_REQUEST, "invalid_request_error", &e),
    }
}

/// `POST …/steer {"text"}`: a message for the turn running in the session, taken in before
/// the agent's next step; `409` when no turn is running.
async fn steer(Bot(bot, _): Bot, Path(id): Path<String>, body: Bytes) -> Response {
    let Ok(TurnBody { text, .. }) = serde_json::from_slice(&body) else {
        return error(StatusCode::BAD_REQUEST, "invalid_request_error", "the body must be {\"text\": \"...\"}");
    };
    let open = match bot.open(&id) {
        Ok(open) => open,
        Err(e) => return error(StatusCode::BAD_REQUEST, "invalid_request_error", &e),
    };
    if open.try_lock().is_ok() {
        return error(StatusCode::CONFLICT, "no_turn", "no turn is running in this session; start one");
    }
    bot.inbox(&id).lock().expect("inbox").push(text);
    Json(json!({ "ok": true })).into_response()
}

async fn turn(
    State(state): State<Arc<ApiState>>,
    Bot(bot, chosen): Bot,
    Path(id): Path<String>,
    body: Bytes,
) -> Response {
    if !valid(&id) {
        return error(StatusCode::BAD_REQUEST, "invalid_request_error", "not a session id");
    }
    let Ok(TurnBody { text, bot: named, personality }) = serde_json::from_slice(&body) else {
        return error(StatusCode::BAD_REQUEST, "invalid_request_error", "the body must be {\"text\": \"...\"}");
    };
    // A new conversation may name its bot; one that exists keeps the bot it has.
    let bot = match named.filter(|n| !n.is_empty()) {
        Some(name) => match state.named(&name) {
            Some(named) if chosen => named,
            Some(_) => bot,
            None => return unknown_bot(&name),
        },
        None => bot,
    };
    if text.trim().is_empty() {
        return error(StatusCode::BAD_REQUEST, "invalid_request_error", "the text is empty");
    }
    if let Some(name) = personality.as_deref().filter(|p| !crate::personality::is_none(p))
        && let Err(e) = crate::personality::text(bot.home(), name)
    {
        return error(StatusCode::BAD_REQUEST, "invalid_request_error", &e);
    }
    let open = match bot.open(&id) {
        Ok(open) => open,
        Err(e) => return error(StatusCode::INTERNAL_SERVER_ERROR, "internal_error", &e),
    };
    let Ok(guard) = open.clone().try_lock_owned() else {
        return error(StatusCode::CONFLICT, "session_busy", "a turn is running in this session");
    };
    stream_turn(&state, bot, id, guard, text, Vec::new(), personality)
}

/// `POST …/retry`: the last turn leaves the conversation and its request runs again, streamed
/// like a turn; `404` when there is no turn to retry.
async fn retry(State(state): State<Arc<ApiState>>, Bot(bot, _): Bot, Path(id): Path<String>) -> Response {
    if !valid(&id) {
        return error(StatusCode::BAD_REQUEST, "invalid_request_error", "not a session id");
    }
    let open = match bot.open(&id) {
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
    stream_turn(&state, bot, id, guard, text, crate::images::of(&request), None)
}

/// Runs a turn of [bot] on its own task and streams its events.
fn stream_turn(
    state: &Arc<ApiState>,
    bot: Arc<BotApi>,
    id: String,
    mut guard: tokio::sync::OwnedMutexGuard<Open>,
    text: String,
    images: Vec<crate::images::Attachment>,
    personality: Option<String>,
) -> Response {
    let inbox = bot.inbox(&id);
    let (tx, rx) = mpsc::unbounded_channel::<Value>();
    let agent = match personality {
        Some(personality) => {
            let mut agent = (*bot.agent()).clone();
            agent.options.personality = Some(personality);
            Arc::new(agent)
        }
        None => bot.agent(),
    };
    let waiting = state.waiting.clone();
    let runtime = bot.runtime.clone();
    // The turn runs on its own: a client that goes away does not stop it.
    tokio::spawn(async move {
        let approver = ApiApprover { events: tx.clone(), waiting, session: id.clone(), bot: bot.runtime.name.clone() };
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
        let messages = guard.session.messages.clone();
        drop(guard);
        let _ = tx.send(last);
        // The nudge, when it is time: the conversation is free again; what it kept follows the
        // answer as `kept` events before the stream ends.
        if let Some(nudge) = runtime.nudge(agent, messages)
            && let Ok(Ok(kept)) = tokio::time::timeout(NUDGE_WAIT, nudge).await
        {
            for line in kept {
                let _ = tx.send(json!({ "type": "kept", "text": line }));
            }
        }
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

async fn schedules(Bot(bot, _): Bot) -> Response {
    match crate::cron::listing(bot.home()) {
        Ok(list) => Json(list).into_response(),
        Err(e) => error(StatusCode::INTERNAL_SERVER_ERROR, "internal_error", &e),
    }
}

async fn add_schedule(Bot(bot, _): Bot, headers: axum::http::HeaderMap, body: Bytes) -> Response {
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
    let added = crate::cron::Schedules::load(bot.home()).and_then(|mut schedules| {
        let id = schedules.put(spec, origin)?;
        schedules.save(bot.home())?;
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

async fn actions(Bot(bot, _): Bot, Query(q): Query<ActionsQuery>) -> Json<Value> {
    let log = crate::actions::ActionLog::new(bot.home());
    let mut entries: Vec<Value> = log
        .read(q.since, q.limit.unwrap_or(100).clamp(1, 500))
        .into_iter()
        .filter_map(|e| serde_json::to_value(e).ok())
        .collect();
    for entry in &mut entries {
        entry["bot"] = json!(bot.runtime.name);
    }
    Json(json!({ "actions": entries }))
}

async fn board(Bot(bot, _): Bot) -> Response {
    match crate::board::Board::load(bot.home()) {
        Ok(board) => Json(json!({ "tasks": board.tasks })).into_response(),
        Err(e) => error(StatusCode::INTERNAL_SERVER_ERROR, "internal_error", &e),
    }
}

async fn answer_board(Bot(bot, _): Bot, Path(id): Path<String>, body: Bytes) -> Response {
    let Some(text) = serde_json::from_slice::<Value>(&body).ok().and_then(|b| b["text"].as_str().map(str::to_owned))
    else {
        return error(StatusCode::BAD_REQUEST, "invalid_request_error", "the body is {\"text\": \"…\"}");
    };
    let answered = crate::board::Board::load(bot.home()).and_then(|mut board| {
        board.answer(&id, &text)?;
        board.save(bot.home())
    });
    match answered {
        Ok(()) => Json(json!({ "ok": true })).into_response(),
        Err(e) => error(StatusCode::NOT_FOUND, "not_found", &e),
    }
}

async fn memory(Bot(bot, _): Bot) -> Json<Value> {
    Json(json!({ "facts": crate::memory::Memory::new(bot.home()).list() }))
}

async fn forget(Bot(bot, _): Bot, Path(id): Path<u64>) -> Response {
    match crate::memory::Memory::new(bot.home()).forget(id) {
        Ok(true) => Json(json!({ "ok": true })).into_response(),
        Ok(false) => error(StatusCode::NOT_FOUND, "not_found", "no such fact"),
        Err(e) => error(StatusCode::INTERNAL_SERVER_ERROR, "internal_error", &e),
    }
}

async fn skills(Bot(bot, _): Bot) -> Json<Value> {
    let skills: Vec<Value> = crate::skills::list(bot.home())
        .into_iter()
        .map(|s| {
            json!({ "name": s.name, "description": s.description, "allowed_tools": s.allowed_tools, "files": s.files() })
        })
        .collect();
    let proposed: Vec<Value> = crate::skills::proposals(bot.home())
        .into_iter()
        .map(|s| {
            let text = std::fs::read_to_string(&s.path).unwrap_or_default();
            let diff = crate::skills::proposal_diff(bot.home(), &s.name);
            json!({ "name": s.name, "description": s.description, "text": text, "improves": s.improves, "diff": diff })
        })
        .collect();
    Json(json!({ "skills": skills, "proposed": proposed }))
}

async fn personalities(Bot(bot, _): Bot) -> Json<Value> {
    let list: Vec<Value> = crate::personality::list(bot.home())
        .into_iter()
        .map(|p| json!({ "name": p.name, "description": p.description, "builtin": p.path.is_none() }))
        .collect();
    Json(json!({
        "active": crate::personality::active(bot.home()),
        "soul": crate::personality::soul(bot.home()),
        "personalities": list,
        "bot": bot.runtime.name,
    }))
}

/// `POST /v1/agent/personality {"name"}`: the one in use from now on (`none`, or null, for none).
async fn set_personality(Bot(bot, _): Bot, body: Bytes) -> Response {
    let Ok(args) = serde_json::from_slice::<Value>(&body) else {
        return error(StatusCode::BAD_REQUEST, "invalid_request_error", "the body is {\"name\": \"…\"}");
    };
    let name = args["name"].as_str().unwrap_or("none");
    match crate::personality::set(bot.home(), name) {
        Ok(()) => Json(json!({ "active": crate::personality::active(bot.home()) })).into_response(),
        Err(e) => error(StatusCode::BAD_REQUEST, "invalid_request_error", &e),
    }
}

async fn profile(Bot(bot, _): Bot) -> Json<Value> {
    Json(json!({ "entries": crate::profile::entries(bot.home()), "text": crate::profile::read(bot.home()) }))
}

#[derive(Deserialize)]
struct UsageQuery {
    session: Option<String>,
}

/// Today (and one conversation): turns, model calls, tokens, time, cost; of the bot `?bot=` names.
async fn usage(State(state): State<Arc<ApiState>>, Bot(bot, _): Bot, Query(q): Query<UsageQuery>) -> Json<Value> {
    use crate::insights::{Log, today, totals};
    let prices = state.prices_for(&bot);
    let log = Log::new(bot.home());
    let mut out = json!({ "today": totals(&log.read(today()), &prices), "bot": bot.runtime.name });
    if let Some(session) = q.session.filter(|s| valid(s)) {
        let mine: Vec<_> = log.read(0).into_iter().filter(|r| r.session == session).collect();
        out["session"] = json!(totals(&mine, &prices));
    }
    Json(out)
}

#[derive(Deserialize)]
struct InsightsQuery {
    days: Option<u32>,
}

async fn insights(State(state): State<Arc<ApiState>>, Bot(bot, _): Bot, Query(q): Query<InsightsQuery>) -> Json<Value> {
    let mut out = crate::insights::insights(bot.home(), q.days.unwrap_or(7).clamp(1, 3650), &state.prices_for(&bot));
    out["bot"] = json!(bot.runtime.name);
    Json(out)
}

async fn accept_skill(Bot(bot, _): Bot, Path(name): Path<String>) -> Response {
    match crate::skills::accept(bot.home(), &name) {
        Ok(()) => Json(json!({ "ok": true })).into_response(),
        Err(e) => error(StatusCode::NOT_FOUND, "not_found", &e),
    }
}

async fn reject_skill(Bot(bot, _): Bot, Path(name): Path<String>) -> Response {
    match crate::skills::reject(bot.home(), &name) {
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
async fn schedule_runs(Bot(bot, _): Bot, Path(id): Path<String>, Query(q): Query<RunsQuery>) -> Response {
    if !crate::cron::valid_id(&id) {
        return error(StatusCode::NOT_FOUND, "not_found", "no such scheduled task");
    }
    Json(json!({ "runs": crate::cron::runs(bot.home(), &id, q.after) })).into_response()
}

/// Runs a schedule now, in the background; its run shows up in `/runs` when it is done.
async fn run_schedule(Bot(bot, _): Bot, Path(id): Path<String>) -> Response {
    let schedule = match crate::cron::Schedules::load(bot.home()) {
        Ok(schedules) => schedules.schedules.into_iter().find(|s| s.id == id),
        Err(e) => return error(StatusCode::INTERNAL_SERVER_ERROR, "internal_error", &e),
    };
    let Some(schedule) = schedule else { return error(StatusCode::NOT_FOUND, "not_found", "no such scheduled task") };
    if crate::cron::start(bot.agent(), bot.home().to_owned(), schedule, "manual", Some(bot.runtime.clone())) {
        (StatusCode::ACCEPTED, Json(json!({ "started": true }))).into_response()
    } else {
        error(StatusCode::CONFLICT, "schedule_running", "it is running already")
    }
}

async fn remove_schedule(Bot(bot, _): Bot, Path(id): Path<String>) -> Response {
    let removed = crate::cron::Schedules::load(bot.home()).and_then(|mut schedules| {
        let removed = schedules.remove(&id);
        schedules.save(bot.home())?;
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
    /// The bot asking.
    bot: String,
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
                "bot": self.bot,
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
        Action::Home { service, entities, data } => {
            json!({ "kind": "home", "service": service, "entities": entities, "data": data })
        }
    }
}
