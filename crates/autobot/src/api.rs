//! The agent's loopback API (spec/agent.md): Invincible Gateway passes `/v1/agent` through to it,
//! so paired devices can run turns and answer approvals on this machine.
//!
//! With several bots ([crate::bots]), every path takes `?bot=<name>` (the default bot without
//! it); `GET /v1/agent/bots` lists them, and approvals say which bot asks. Served with a
//! [Fleet], the bots are the ones running now: started and stopped while the API runs.

use std::collections::{HashMap, HashSet};
use std::future::Future;
use std::pin::Pin;
use std::sync::atomic::{AtomicU32, Ordering};
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

/// Conversations kept open in memory at most, beyond those in use: past it, the idle ones are
/// let go (they are on disk; "always" answers given in them end with them).
const MAX_OPEN: usize = 64;

/// How long a question waits for an answer.
const APPROVAL_WAIT: Duration = Duration::from_secs(10 * 60);
/// How long a turn's stream stays open after its answer for what the nudge kept.
const NUDGE_WAIT: Duration = Duration::from_secs(30);
/// A turn's body at most: its text and [crate::images::MAX_SENT_IMAGES] images in base64.
const TURN_BODY_LIMIT: usize = crate::images::MAX_SENT_IMAGES * crate::images::MAX_SENT_IMAGE / 3 * 4 + 1024 * 1024;

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
    /// Conversations in memory, with when each was last asked for.
    open: Mutex<HashMap<String, (Shared, std::time::Instant)>>,
    /// Messages for a session's running turn (`…/steer`).
    inboxes: Mutex<HashMap<String, crate::tools::Inbox>>,
    /// Threads in this bot's home: the session-to-worktree map.
    threads: Arc<crate::threads::Threads>,
}

/// The questions turns are waiting on, by id: where to send the answer, and the question as
/// `GET /v1/agent/approvals` lists it.
type Waiting = Arc<Mutex<HashMap<String, (oneshot::Sender<Answer>, Value)>>>;

/// A conversation open in memory, shared by the requests on it.
type Shared = Arc<tokio::sync::Mutex<Open>>;

/// A conversation and what the owner said "always" to in it.
struct Open {
    session: Session,
    grants: HashSet<Action>,
}

impl BotApi {
    fn new(runtime: Arc<Runtime>, info: Value) -> Arc<Self> {
        let threads = Arc::new(crate::threads::Threads::new(runtime.home.clone()));
        Arc::new(Self { runtime, info, open: Mutex::default(), inboxes: Mutex::default(), threads })
    }

    fn agent(&self) -> Arc<Agent> {
        self.runtime.agent()
    }

    /// The bot as the settings editor sees it: its file, home and current configuration.
    fn def(&self) -> crate::bots::Def {
        crate::bots::Def {
            name: self.runtime.name.clone(),
            root: self.runtime.root.clone(),
            home: self.runtime.home.clone(),
            config: self.runtime.config.clone(),
            default: self.runtime.default,
        }
    }

    /// The agent for [session]: the bot's own, or a copy whose tools and project map run in a
    /// thread's worktree.
    fn agent_for(&self, session: &str) -> Result<Arc<Agent>, String> {
        let base = self.agent();
        let Some(thread) = self.threads.get(session)? else {
            if self.threads.is_removed(session)? {
                return Err(format!("thread {session} was removed; its worktree is gone"));
            }
            return Ok(base);
        };
        if !thread.worktree.is_dir() {
            return Err(format!("the worktree for thread {} is gone ({})", thread.id, thread.worktree.display()));
        }
        let mut agent = (*base).clone();
        agent.tools = agent.tools.clone().with_workdir(thread.worktree.clone());
        agent.options.repo_map = crate::repo_map::render(&thread.worktree, 4096);
        Ok(Arc::new(agent))
    }

    fn home(&self) -> &std::path::Path {
        &self.runtime.home
    }

    fn sessions_dir(&self) -> std::path::PathBuf {
        self.runtime.home.join("sessions")
    }

    fn inbox(&self, id: &str) -> crate::tools::Inbox {
        let mut inboxes = self.inboxes.lock().expect("inboxes");
        if inboxes.len() >= MAX_OPEN && !inboxes.contains_key(id) {
            // Only running turns hold theirs.
            inboxes.retain(|_, inbox| Arc::strong_count(inbox) > 1);
        }
        inboxes.entry(id.to_owned()).or_default().clone()
    }

    fn open(&self, id: &str) -> Result<Arc<tokio::sync::Mutex<Open>>, String> {
        let mut open = self.open.lock().expect("open sessions");
        let now = std::time::Instant::now();
        if let Some((session, used)) = open.get_mut(id) {
            *used = now;
            return Ok(session.clone());
        }
        // Full: the idle one asked for longest ago goes (nobody holds it: a running turn holds
        // its own).
        while open.len() >= MAX_OPEN {
            let oldest = open
                .iter()
                .filter(|(_, (session, _))| Arc::strong_count(session) == 1)
                .min_by_key(|(_, (_, used))| *used)
                .map(|(id, _)| id.clone());
            match oldest {
                Some(id) => open.remove(&id),
                None => break,
            };
        }
        let session = Session::open(&self.sessions_dir(), id)?;
        let entry = Arc::new(tokio::sync::Mutex::new(Open { session, grants: HashSet::new() }));
        open.insert(id.to_owned(), (entry.clone(), now));
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
        "version": invincible::version::VERSION,
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
        .route("/v1/agent/bots", get(bots).post(add_bot))
        .route("/v1/agent/bots/{name}/enable", post(enable_bot))
        .route("/v1/agent/bots/{name}/disable", post(disable_bot))
        .route("/v1/agent/bots/reload", post(reload_bots))
        .route("/v1/agent/openai/v1/models", get(openai_models))
        .route("/v1/agent/openai/v1/chat/completions", post(openai_chat))
        .route("/v1/agent/sessions", get(sessions))
        .route("/v1/agent/sessions/{id}", get(history))
        // A turn may carry images (base64: a third larger than they are).
        .route("/v1/agent/sessions/{id}/turns", post(turn).layer(axum::extract::DefaultBodyLimit::max(TURN_BODY_LIMIT)))
        .route("/v1/agent/sessions/{id}/retry", post(retry))
        .route("/v1/agent/sessions/{id}/reset", post(reset))
        .route("/v1/agent/sessions/{id}/steer", post(steer))
        .route("/v1/agent/sessions/{id}/fork", post(fork))
        .route("/v1/agent/threads", get(list_threads).post(new_thread))
        .route("/v1/agent/threads/{id}", get(thread_info).delete(remove_thread))
        .route("/v1/agent/threads/{id}/diff", get(thread_diff))
        .route("/v1/agent/threads/{id}/pr", post(thread_pr))
        .route("/v1/agent/settings", get(settings).post(set_setting))
        .route("/v1/agent/model", post(set_model))
        .route("/v1/agent/tools", post(set_tool))
        .route("/v1/agent/secrets", post(set_secret))
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
        .route("/v1/agent/stats", get(stats))
        .route("/v1/agent/alerts/test", post(alerts_test))
        .route_layer(middleware::from_fn_with_state(state.clone(), require_token));
    health.merge(guarded).with_state(state)
}

/// What the process holds now, for monitoring and the soak test: tasks on its runtime, and
/// conversations kept open per bot.
async fn stats(State(state): State<Arc<ApiState>>) -> Json<Value> {
    let tasks = tokio::runtime::Handle::current().metrics().num_alive_tasks();
    let open: usize = state.bots().iter().map(|b| b.open.lock().expect("open sessions").len()).sum();
    let waiting = state.waiting.lock().expect("waiting").len();
    Json(json!({ "tasks": tasks, "open_sessions": open, "waiting": waiting }))
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

/// `POST /v1/agent/alerts/test`: a test alert to where alerts go, now ([crate::alerts::test]).
async fn alerts_test() -> Response {
    match crate::alerts::test().await {
        Ok(sent) => Json(json!({
            "sent": sent
                .into_iter()
                .map(|(to, result)| match result {
                    Ok(()) => json!({ "to": to }),
                    Err(e) => json!({ "to": to, "error": e }),
                })
                .collect::<Vec<_>>(),
        }))
        .into_response(),
        Err(e) => error(StatusCode::CONFLICT, "no_alerts", &e),
    }
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

/// `GET /v1/agent/settings`: what an operator can change, without any secret value.
async fn settings(Bot(bot, _): Bot) -> Json<Value> {
    let config = &bot.runtime.config;
    let home = &bot.runtime.home;
    let channels: Vec<Value> = [
        ("telegram", config.telegram.enabled),
        ("discord", config.discord.enabled),
        ("slack", config.slack.enabled),
        ("email", config.email.enabled),
        ("signal", config.signal.enabled),
        ("matrix", config.matrix.enabled),
        ("whatsapp", config.whatsapp.enabled),
    ]
    .into_iter()
    .map(|(name, on)| json!({ "name": name, "on": on }))
    .collect();
    let tools: Vec<Value> = crate::settings::tool_states(config)
        .into_iter()
        .map(|(group, on, items)| {
            json!({
                "group": group,
                "on": on,
                "tools": items.into_iter().map(|(name, on)| json!({ "name": name, "on": on })).collect::<Vec<_>>(),
            })
        })
        .collect();
    Json(json!({
        "bot": bot.runtime.name,
        "default": bot.runtime.default,
        "description": config.bot.description,
        "gateway": {
            "url": config.gateway.url,
            "model": config.gateway.model,
            "private": config.gateway.private,
        },
        "agent": {
            "workdir": config.agent.workdir(home).display().to_string(),
            "max_steps": config.agent.max_steps,
            "sandbox": config.agent.sandbox,
            "context_kib": config.agent.context_kib,
            "tools": tools,
            "disabled_tools": config.agent.disabled_tools,
        },
        "approvals": { "mode": config.approvals.mode, "allow": config.approvals.allow },
        "personality": crate::personality::active(home),
        "channels": channels,
        "mcp": config.mcp.keys().collect::<Vec<_>>(),
        "serve": config.serve.listen.to_string(),
    }))
}

#[derive(Deserialize)]
struct SettingBody {
    key: String,
    #[serde(default)]
    value: String,
    /// Store the value as a string, even when it looks like a number or an array (a token).
    #[serde(default)]
    literal: bool,
}

/// `POST /v1/agent/settings {"key", "value", "literal"?}`: a dotted configuration key. The
/// result is checked as a whole before it is written; `autobot serve` reloads it within seconds.
async fn set_setting(State(state): State<Arc<ApiState>>, Bot(bot, _): Bot, Json(body): Json<SettingBody>) -> Response {
    let key = body.key.trim();
    if key.is_empty() {
        return error(StatusCode::BAD_REQUEST, "invalid_request_error", "the key is empty");
    }
    let item = if body.literal { crate::settings::literal(&body.value) } else { crate::settings::value(&body.value) };
    match crate::settings::change(&bot.def(), key, Some(item)) {
        Ok(_) => {
            let warning = state.fleet.as_ref().and_then(|fleet| fleet.reload().err().map(|e| e.to_string()));
            let effective = crate::settings::effective(&bot.def(), key).ok();
            let mut answer = json!({ "ok": true, "key": key });
            if let Some((value, from)) = effective {
                answer["value"] = json!(value);
                answer["from"] = json!(from);
            }
            if let Some(warning) = warning {
                answer["warning"] = json!(warning);
            }
            Json(answer).into_response()
        }
        Err(e) => error(StatusCode::BAD_REQUEST, "invalid_config", &e),
    }
}

#[derive(Deserialize)]
struct ModelBody {
    model: String,
}

/// `POST /v1/agent/model {"model"}`: the model this bot uses (a gateway id, or `auto`).
async fn set_model(State(state): State<Arc<ApiState>>, Bot(bot, _): Bot, Json(body): Json<ModelBody>) -> Response {
    let models = bot.agent().gateway.model_info().await.unwrap_or_default();
    match crate::settings::set_model(&bot.def(), body.model.trim(), Some(&models)) {
        Ok(said) => {
            let warning = state.fleet.as_ref().and_then(|fleet| fleet.reload().err().map(|e| e.to_string()));
            let mut answer = json!({ "ok": true, "model": body.model.trim(), "said": said });
            if let Some(warning) = warning {
                answer["warning"] = json!(warning);
            }
            Json(answer).into_response()
        }
        Err(e) => error(StatusCode::BAD_REQUEST, "invalid_request_error", &e),
    }
}

#[derive(Deserialize)]
struct ToolBody {
    target: String,
    on: bool,
}

/// `POST /v1/agent/tools {"target", "on"}`: turn a tool group or a tool on or off.
async fn set_tool(State(state): State<Arc<ApiState>>, Bot(bot, _): Bot, Json(body): Json<ToolBody>) -> Response {
    match crate::settings::set_tool(&bot.def(), body.target.trim(), body.on) {
        Ok(said) => {
            let warning = state.fleet.as_ref().and_then(|fleet| fleet.reload().err().map(|e| e.to_string()));
            let mut answer = json!({ "ok": true, "said": said });
            if let Some(warning) = warning {
                answer["warning"] = json!(warning);
            }
            Json(answer).into_response()
        }
        Err(e) => error(StatusCode::BAD_REQUEST, "invalid_request_error", &e),
    }
}

#[derive(Deserialize)]
struct NewBotBody {
    name: String,
    #[serde(default)]
    description: String,
    #[serde(default)]
    soul: Option<String>,
    #[serde(default)]
    model: Option<String>,
    #[serde(default)]
    tools: Option<Vec<String>>,
    #[serde(default)]
    approvals: Option<String>,
    #[serde(default)]
    workdir: Option<std::path::PathBuf>,
    #[serde(default)]
    telegram_token: Option<String>,
    #[serde(default)]
    discord_token: Option<String>,
    #[serde(default)]
    slack_app_token: Option<String>,
    #[serde(default)]
    slack_bot_token: Option<String>,
}

/// `POST /v1/agent/bots`: add a bot; it starts with the next fleet reload.
async fn add_bot(State(state): State<Arc<ApiState>>, Json(body): Json<NewBotBody>) -> Response {
    let Some(root) = &state.root else {
        return error(StatusCode::CONFLICT, "not_configurable", "this agent has no bot configuration to change");
    };
    let new = crate::bots::NewBot {
        description: body.description,
        soul: body.soul,
        model: body.model,
        tools: body.tools,
        approvals: body.approvals,
        workdir: body.workdir,
        telegram_token: body.telegram_token,
        discord_token: body.discord_token,
        slack_app_token: body.slack_app_token,
        slack_bot_token: body.slack_bot_token,
    };
    match crate::bots::add(root, body.name.trim(), &new) {
        Ok(path) => {
            let warning = state.fleet.as_ref().and_then(|fleet| fleet.reload().err().map(|e| e.to_string()));
            let mut answer = json!({ "ok": true, "name": body.name.trim(), "path": path.display().to_string() });
            if let Some(warning) = warning {
                answer["warning"] = json!(warning);
            }
            Json(answer).into_response()
        }
        Err(e) => error(StatusCode::BAD_REQUEST, "invalid_request_error", &e),
    }
}

#[derive(Deserialize)]
struct SecretBody {
    /// A file name in the bot's home: `telegram.token`, `slack-bot.token`, `email.password`.
    file: String,
    value: String,
}

/// `POST /v1/agent/secrets {"file", "value"}`: write a connector token (or password) into the
/// bot's home with mode 0600. The value is never returned or logged. Only a plain file name is
/// accepted: not a path, so it cannot leave the home.
async fn set_secret(Bot(bot, _): Bot, Json(body): Json<SecretBody>) -> Response {
    let file = body.file.trim();
    if file.is_empty()
        || file == "."
        || file == ".."
        || file.contains('/')
        || file.contains('\\')
        || file.contains('\0')
    {
        return error(
            StatusCode::BAD_REQUEST,
            "invalid_request_error",
            "the file must be a name in the bot's home, like telegram.token",
        );
    }
    let value = body.value.trim();
    if value.is_empty() {
        return error(StatusCode::BAD_REQUEST, "invalid_request_error", "the value is empty");
    }
    let path = bot.home().join(file);
    match invincible::fsutil::replace_private(&path, &format!("{value}\n")) {
        Ok(()) => Json(json!({ "ok": true, "file": file })).into_response(),
        Err(e) => error(StatusCode::INTERNAL_SERVER_ERROR, "internal_error", &e),
    }
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

/// `GET /v1/agent/threads`: every thread in the bot's home.
async fn list_threads(Bot(bot, _): Bot) -> Response {
    match bot.threads.list() {
        Ok(list) => Json(json!({
            "threads": list.iter().map(|thread| bot.threads.view(thread)).collect::<Vec<_>>(),
        }))
        .into_response(),
        Err(e) => error(StatusCode::INTERNAL_SERVER_ERROR, "internal_error", &e),
    }
}

#[derive(Deserialize)]
struct NewThread {
    #[serde(default)]
    name: String,
    #[serde(default)]
    base: Option<String>,
}

/// `POST /v1/agent/threads`: a new worktree and conversation from the bot's project.
async fn new_thread(Bot(bot, _): Bot, Json(body): Json<NewThread>) -> Response {
    let agent = bot.agent();
    if agent.tools.ssh().is_some() || agent.tools.docker().is_some() {
        return error(
            StatusCode::CONFLICT,
            "not_supported",
            "threads need a local project; this agent runs commands over SSH or in a container",
        );
    }
    let repo = agent.tools.workdir().to_path_buf();
    let threads = bot.threads.clone();
    let name = body.name;
    let base = body.base;
    let made = tokio::task::spawn_blocking(move || threads.create(&repo, base.as_deref(), &name)).await;
    match made {
        Ok(Ok(thread)) => Json(bot.threads.view(&thread)).into_response(),
        Ok(Err(e)) => error(StatusCode::BAD_REQUEST, "invalid_request_error", &e),
        Err(e) => error(StatusCode::INTERNAL_SERVER_ERROR, "internal_error", &format!("the thread task: {e}")),
    }
}

/// `GET /v1/agent/threads/<id>`.
async fn thread_info(Bot(bot, _): Bot, Path(id): Path<String>) -> Response {
    if !valid(&id) {
        return error(StatusCode::BAD_REQUEST, "invalid_request_error", "not a thread id");
    }
    match bot.threads.get(&id) {
        Ok(Some(thread)) => Json(bot.threads.view(&thread)).into_response(),
        Ok(None) => error(StatusCode::NOT_FOUND, "not_found", &format!("there is no thread {id:?}")),
        Err(e) => error(StatusCode::INTERNAL_SERVER_ERROR, "internal_error", &e),
    }
}

/// `GET /v1/agent/threads/<id>/diff`: the worktree against its base, new files included.
async fn thread_diff(Bot(bot, _): Bot, Path(id): Path<String>) -> Response {
    if !valid(&id) {
        return error(StatusCode::BAD_REQUEST, "invalid_request_error", "not a thread id");
    }
    let threads = bot.threads.clone();
    let wanted = id.clone();
    match bot.threads.get(&id) {
        Ok(Some(_)) => {}
        Ok(None) => return error(StatusCode::NOT_FOUND, "not_found", &format!("there is no thread {id:?}")),
        Err(e) => return error(StatusCode::INTERNAL_SERVER_ERROR, "internal_error", &e),
    }
    let made = tokio::task::spawn_blocking(move || threads.diff(&wanted, false)).await;
    match made {
        Ok(Ok(diff)) => Json(json!({ "id": id, "diff": diff })).into_response(),
        Ok(Err(e)) => error(StatusCode::BAD_REQUEST, "invalid_request_error", &e),
        Err(e) => error(StatusCode::INTERNAL_SERVER_ERROR, "internal_error", &format!("the diff task: {e}")),
    }
}

#[derive(Default, Deserialize)]
struct PrBody {
    #[serde(default)]
    title: Option<String>,
    #[serde(default)]
    body: Option<String>,
    #[serde(default)]
    base: Option<String>,
}

/// `POST /v1/agent/threads/<id>/pr`: stage, commit, push and open the pull request. A branch
/// can be pushed without a PR (no remote, no `gh`, no token); the compare link comes back.
async fn thread_pr(Bot(bot, _): Bot, Path(id): Path<String>, Json(body): Json<PrBody>) -> Response {
    if !valid(&id) {
        return error(StatusCode::BAD_REQUEST, "invalid_request_error", "not a thread id");
    }
    if let Ok(None) = bot.threads.get(&id) {
        return error(StatusCode::NOT_FOUND, "not_found", &format!("there is no thread {id:?}"));
    }
    let threads = bot.threads.clone();
    let wanted = id.clone();
    let prepared = tokio::task::spawn_blocking(move || {
        threads.prepare_pr(&wanted, body.title.as_deref(), body.body.as_deref(), body.base.as_deref())
    })
    .await;
    let prepared = match prepared {
        Ok(Ok(prepared)) => prepared,
        Ok(Err(e)) => return error(StatusCode::BAD_REQUEST, "invalid_request_error", &e),
        Err(e) => return error(StatusCode::INTERNAL_SERVER_ERROR, "internal_error", &format!("the PR task: {e}")),
    };
    let outcome = crate::threads::open_pr(&prepared).await;
    let warning = bot.threads.record_pr(&id, &outcome).err();
    let mut value = serde_json::to_value(&outcome).unwrap_or_else(|_| json!({}));
    if let Some(warning) = warning {
        value["warning"] = json!(warning);
    }
    Json(value).into_response()
}

/// `DELETE /v1/agent/threads/<id>[?force=1]`: remove the worktree and the branch.
async fn remove_thread(
    Bot(bot, _): Bot,
    Path(id): Path<String>,
    Query(query): Query<HashMap<String, String>>,
) -> Response {
    if !valid(&id) {
        return error(StatusCode::BAD_REQUEST, "invalid_request_error", "not a thread id");
    }
    let force = query.get("force").is_some_and(|v| v == "1" || v.eq_ignore_ascii_case("true"));
    let threads = bot.threads.clone();
    let wanted = id.clone();
    let removed = tokio::task::spawn_blocking(move || threads.remove(&wanted, force)).await;
    match removed {
        Ok(Ok(_)) => Json(json!({ "removed": id })).into_response(),
        Ok(Err(e)) => error(StatusCode::BAD_REQUEST, "invalid_request_error", &e),
        Err(e) => error(StatusCode::INTERNAL_SERVER_ERROR, "internal_error", &format!("the remove task: {e}")),
    }
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
    /// Images beside the text, as OpenAI-style parts:
    /// `{"type": "image_url", "image_url": {"url": "data:image/jpeg;base64,…"}}`.
    #[serde(default)]
    images: Vec<Value>,
    /// Run the turn in delegated mode: `true`, or `{"max_nudges": 2, "stall_seconds": 600,
    /// "until": "…"}` ([crate::delegate]).
    #[serde(default)]
    delegated: Option<crate::delegate::Request>,
}

/// The data: URL of an image part (`image_url` an object with `url`, or the URL itself).
fn image_url(part: &Value) -> Option<&str> {
    part["image_url"]["url"].as_str().or(part["image_url"].as_str()).or(part["url"].as_str())
}

/// The turn's images, kept in the bot's attachments; why not, when one is not an image, too
/// large, or there are too many.
fn sent_images(bot: &BotApi, parts: &[Value]) -> Result<Vec<crate::images::Attachment>, String> {
    if parts.len() > crate::images::MAX_SENT_IMAGES {
        return Err(format!("at most {} images in a turn", crate::images::MAX_SENT_IMAGES));
    }
    let urls = parts
        .iter()
        .map(|part| {
            image_url(part).ok_or_else(|| {
                "an image is {\"type\": \"image_url\", \"image_url\": {\"url\": \"data:image/…;base64,…\"}}".to_owned()
            })
        })
        .collect::<Result<Vec<_>, _>>()?;
    let dir = bot.home().join("attachments");
    let mut kept = Vec::new();
    for url in urls {
        match crate::images::from_data_url(url, &dir) {
            Ok(image) => kept.push(image),
            Err(e) => {
                // A refused turn keeps none of its images.
                for image in kept {
                    let _ = std::fs::remove_file(image.path);
                }
                return Err(e);
            }
        }
    }
    Ok(kept)
}

/// What one turn changes in its bot's agent.
#[derive(Default)]
struct Overrides {
    personality: Option<String>,
    vision: Option<bool>,
}

/// Whether the bot's model can see images, as the gateway says (None: not known, or the gateway
/// did not answer in time).
async fn sees(agent: &Agent) -> Option<bool> {
    let infos = tokio::time::timeout(Duration::from_secs(3), agent.gateway.model_info()).await.ok()?.ok()?;
    crate::vision(&infos, agent.gateway.model())
}

fn cannot_see(model: &str) -> Response {
    error(
        StatusCode::BAD_REQUEST,
        "model_cannot_see_images",
        &format!("{model} can't see images; pick a model that can (`autobot model`), or send the text alone"),
    )
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
    let Ok(TurnBody { text, bot: named, personality, images, delegated }) = serde_json::from_slice(&body) else {
        return error(StatusCode::BAD_REQUEST, "invalid_request_error", "the body must be {\"text\": \"...\"}");
    };
    let delegated = match delegated {
        Some(request) => match request.scope() {
            Ok(scope) => scope,
            Err(e) => return error(StatusCode::BAD_REQUEST, "invalid_request_error", &e),
        },
        None => None,
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
    if text.trim().is_empty() && images.is_empty() {
        return error(StatusCode::BAD_REQUEST, "invalid_request_error", "the text is empty");
    }
    if let Some(name) = personality.as_deref().filter(|p| !crate::personality::is_none(p))
        && let Err(e) = crate::personality::text(bot.home(), name)
    {
        return error(StatusCode::BAD_REQUEST, "invalid_request_error", &e);
    }
    // Images: only to a model that can see (as far as the gateway knows), and within the caps.
    let vision = if images.is_empty() {
        None
    } else {
        let agent = bot.agent();
        let vision = match agent.options.vision {
            Some(known) => Some(known),
            None => sees(&agent).await,
        };
        if vision == Some(false) {
            return cannot_see(agent.gateway.model());
        }
        vision
    };
    let open = match bot.open(&id) {
        Ok(open) => open,
        Err(e) => return error(StatusCode::INTERNAL_SERVER_ERROR, "internal_error", &e),
    };
    let Ok(guard) = open.clone().try_lock_owned() else {
        return error(StatusCode::CONFLICT, "session_busy", "a turn is running in this session");
    };
    let images = match sent_images(&bot, &images) {
        Ok(images) => images,
        Err(e) => return error(StatusCode::BAD_REQUEST, "invalid_request_error", &e),
    };
    stream_turn(&state, bot, id, guard, text, images, delegated, Overrides { personality, vision })
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
    stream_turn(&state, bot, id, guard, text, crate::images::of(&request), None, Overrides::default())
}

/// One event in the stable turn stream (`spec/agent.md`, Turn events). Text and reasoning arrive
/// as deltas; a diff and a tool result are capped so one event cannot flood a client.
fn stream_event(event: Event) -> Value {
    let mut value = match event {
        Event::Text(text) => json!({ "type": "text", "delta": text }),
        Event::Reasoning(text) => json!({ "type": "reasoning", "delta": text }),
        Event::Tool(text) => json!({ "type": "tool", "text": text }),
        Event::Refused(text) => json!({ "type": "refused", "text": text }),
        Event::Diff(diff) => json!({ "type": "diff", "text": cap_event(diff, 64 * 1024) }),
        Event::Change { path, before, after } => json!({
            "type": "change",
            "path": path.display().to_string(),
            "before_bytes": before.len(),
            "after_bytes": after.len(),
        }),
        Event::Output { name, text } => json!({
            "type": "tool_output",
            "name": name,
            "text": cap_event(text, 8 * 1024),
        }),
        Event::Usage { input, output, cached } => {
            json!({ "type": "usage", "input": input, "output": output, "cached": cached })
        }
        Event::Receipt { id, model, tier } => {
            json!({ "type": "receipt", "id": id, "model": model, "tier": tier })
        }
        Event::Member { name, text } => json!({ "type": "member", "agent": name, "text": text }),
    };
    value["v"] = json!(1);
    value
}

fn cap_event(text: &str, max: usize) -> String {
    if text.len() <= max {
        return text.to_owned();
    }
    let mut cut = max;
    while cut > 0 && !text.is_char_boundary(cut) {
        cut -= 1;
    }
    format!(
        "{}\n… {} bytes more (truncated in the event; the full result is in the conversation)",
        &text[..cut],
        text.len() - cut
    )
}

/// Runs a turn of [bot] on its own task and streams its events. A delegated turn may run more
/// than one turn ([crate::delegate]); its events use the same grammar.
#[allow(clippy::too_many_arguments)]
fn stream_turn(
    state: &Arc<ApiState>,
    bot: Arc<BotApi>,
    id: String,
    guard: tokio::sync::OwnedMutexGuard<Open>,
    text: String,
    images: Vec<crate::images::Attachment>,
    delegated: Option<crate::delegate::Scope>,
    Overrides { personality, vision }: Overrides,
) -> Response {
    let inbox = bot.inbox(&id);
    let (tx, rx) = mpsc::unbounded_channel::<Value>();
    let mut agent = match bot.agent_for(&id) {
        Ok(agent) => (*agent).clone(),
        Err(e) => return error(StatusCode::INTERNAL_SERVER_ERROR, "internal_error", &e),
    };
    if personality.is_some() {
        agent.options.personality = personality;
    }
    if vision.is_some() {
        agent.options.vision = vision;
    }
    let agent = Arc::new(agent);
    let with_images = !images.is_empty();
    let waiting = state.waiting.clone();
    let runtime = bot.runtime.clone();
    let _ = tx.send(json!({ "v": 1, "type": "turn.started", "session": id }));
    if let Some(scope) = &delegated {
        let _ = tx.send(scope.started());
    }
    // The turn runs on its own: a client that goes away does not stop it.
    tokio::spawn(async move {
        match delegated {
            Some(scope) => {
                let approver = DelegatedApprover {
                    events: tx.clone(),
                    bot: bot.runtime.name.clone(),
                    declined: Arc::new(AtomicU32::new(0)),
                };
                run_delegated(agent, guard, text, images, scope, approver, tx, inbox, runtime, with_images).await;
            }
            None => {
                let approver =
                    ApiApprover { events: tx.clone(), waiting, session: id.clone(), bot: bot.runtime.name.clone() };
                run_single(agent, guard, text, images, approver, tx, inbox, runtime, with_images).await;
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

/// One ordinary turn: the answer, then what the profile nudge kept.
#[allow(clippy::too_many_arguments)]
async fn run_single(
    agent: Arc<Agent>,
    mut guard: tokio::sync::OwnedMutexGuard<Open>,
    text: String,
    images: Vec<crate::images::Attachment>,
    approver: ApiApprover,
    tx: mpsc::UnboundedSender<Value>,
    inbox: crate::tools::Inbox,
    runtime: Arc<Runtime>,
    with_images: bool,
) {
    let events = {
        let tx = tx.clone();
        move |event: Event| {
            let _ = tx.send(stream_event(event));
        }
    };
    let Open { session, grants } = &mut *guard;
    let context = crate::tools::TurnContext { inbox: Some(inbox), ..Default::default() };
    let turn = agent.turn_with(session, &text, &images, &approver, grants, &events);
    let last = match crate::tools::TURN.scope(context, turn).await {
        Ok(outcome) => json!({
            "v": 1, "type": "answer", "text": outcome.text, "receipts": outcome.receipts
        }),
        // The router picked a model that cannot see, found out only now.
        Err(e) if with_images && crate::images::refuses_images(&e) => {
            json!({ "v": 1, "type": "error", "code": "model_cannot_see_images", "text": e })
        }
        Err(e) => json!({ "v": 1, "type": "error", "text": e }),
    };
    // The nudge, when it is time, on its own copy: the conversation is free again; what it
    // kept follows the answer as `kept` events before the stream ends.
    let nudge = runtime.nudge(agent, &guard.session.messages);
    drop(guard);
    let _ = tx.send(last);
    if let Some(nudge) = nudge
        && let Ok(Ok(kept)) = tokio::time::timeout(NUDGE_WAIT, nudge).await
    {
        for line in kept {
            let _ = tx.send(json!({ "v": 1, "type": "kept", "text": line }));
        }
    }
}

/// A delegated run: bounded turns, no accepted approvals, a stall limit and a short limit wait.
#[allow(clippy::too_many_arguments)]
async fn run_delegated(
    agent: Arc<Agent>,
    mut guard: tokio::sync::OwnedMutexGuard<Open>,
    text: String,
    images: Vec<crate::images::Attachment>,
    scope: crate::delegate::Scope,
    approver: DelegatedApprover,
    tx: mpsc::UnboundedSender<Value>,
    inbox: crate::tools::Inbox,
    runtime: Arc<Runtime>,
    with_images: bool,
) {
    let started = std::time::Instant::now();
    let session_id = guard.session.id.clone();
    let mut current = text;
    let mut attempts = 0u8;
    let mut nudges = 0u8;
    let mut receipts: Vec<String> = Vec::new();
    let mut fatal: Option<String> = None;
    let mut code: Option<&'static str> = None;
    let mut last_text = String::new();
    let mut finished = false;
    let mut waiting_for_owner = false;
    let mut paused: Option<Value> = None;
    while attempts < crate::delegate::MAX_ATTEMPTS {
        attempts += 1;
        let (activity, ticks) = mpsc::unbounded_channel();
        let (stall_tx, mut stalled) = oneshot::channel();
        let seconds = scope.stall_seconds;
        let in_tool = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let watching = in_tool.clone();
        let watchdog = tokio::spawn(async move {
            crate::delegate::idle_limit(ticks, Duration::from_secs(seconds), watching).await;
            let _ = stall_tx.send(());
        });
        let events = {
            let tx = tx.clone();
            let in_tool = in_tool.clone();
            move |event: Event| {
                match &event {
                    Event::Tool(_) => in_tool.store(true, Ordering::Relaxed),
                    Event::Output { .. } | Event::Refused(_) => in_tool.store(false, Ordering::Relaxed),
                    _ => {}
                }
                let _ = activity.send(());
                let _ = tx.send(stream_event(event));
            }
        };
        let context = crate::tools::TurnContext { inbox: Some(inbox.clone()), ..Default::default() };
        // The owner's images belong to the request, not to each resumed turn.
        let sent = if attempts == 1 { images.as_slice() } else { &[] };
        let outcome = {
            let Open { session, grants } = &mut *guard;
            let turn = agent.turn_with(session, &current, sent, &approver, grants, &events);
            tokio::select! {
                outcome = crate::tools::TURN.scope(context, turn) => Some(outcome),
                _ = &mut stalled => None,
            }
        };
        watchdog.abort();
        let Some(outcome) = outcome else {
            // The turn was stopped mid-step: give the session a coherent tail before the nudge.
            if let Err(e) = guard.session.close_dangling() {
                fatal = Some(e);
                break;
            }
            let _ = tx.send(json!({
                "v": 1, "type": "delegate.stalled", "seconds": scope.stall_seconds,
            }));
            if nudges >= scope.max_nudges {
                fatal = Some(format!("the delegated turn produced nothing for {} s", scope.stall_seconds));
                break;
            }
            nudges += 1;
            current = crate::delegate::stall_nudge(scope.stall_seconds);
            let _ = tx.send(json!({
                "v": 1, "type": "delegate.nudge", "number": nudges, "of": scope.max_nudges,
                "reason": "stalled", "text": current,
            }));
            continue;
        };
        match outcome {
            Ok(outcome) => {
                receipts.extend(outcome.receipts.iter().cloned());
                let waiting = crate::delegate::waiting_reason(&outcome.text);
                // A declined approval is the owner's decision, not a routine question: never nudge
                // the agent to find a way around it. Stop and report it instead.
                let declined = approver.declined.load(Ordering::Relaxed);
                if let Some(reason) = waiting
                    && nudges < scope.max_nudges
                    && declined == 0
                {
                    nudges += 1;
                    current = crate::delegate::nudge(&scope, nudges, reason);
                    let _ = tx.send(json!({
                        "v": 1, "type": "delegate.nudge", "number": nudges, "of": scope.max_nudges,
                        "reason": reason, "text": current,
                    }));
                    continue;
                }
                waiting_for_owner = waiting.is_some() || crate::delegate::needs_owner(&outcome.text);
                let _ = tx.send(json!({
                    "v": 1, "type": "delegate.finished",
                    "nudges": nudges,
                    "declined": declined,
                    "turns": attempts,
                    "seconds": started.elapsed().as_secs(),
                    "waiting_on_owner": waiting_for_owner,
                }));
                last_text = outcome.text.clone();
                finished = true;
                let _ = tx.send(json!({
                    "v": 1, "type": "answer", "text": outcome.text, "receipts": receipts.clone(),
                }));
                break;
            }
            Err(e) => {
                if with_images && crate::images::refuses_images(&e) {
                    code = Some("model_cannot_see_images");
                    fatal = Some(e);
                    break;
                }
                if let Some(seconds) = crate::delegate::wait_seconds(&e) {
                    if seconds <= crate::delegate::MAX_LIMIT_WAIT {
                        let _ = tx.send(json!({
                            "v": 1, "type": "delegate.waiting", "reason": "usage_limit", "seconds": seconds,
                        }));
                        wait_out(seconds, &tx).await;
                        current = crate::delegate::resume_nudge();
                        continue;
                    }
                    let event = crate::delegate::paused(Some(seconds));
                    let at = event["retry_at_local"].as_str().unwrap_or("later").to_owned();
                    paused = Some(event.clone());
                    let _ = tx.send(event);
                    fatal = Some(format!(
                        "the provider's usage limit is reached; retry after {at} (or send the task again then)"
                    ));
                    break;
                }
                if crate::delegate::is_usage_limit(&e) {
                    let event = crate::delegate::paused(None);
                    paused = Some(event.clone());
                    let _ = tx.send(event);
                    fatal = Some(e);
                    break;
                }
                fatal = Some(e);
                break;
            }
        }
    }
    if fatal.is_none() && attempts >= crate::delegate::MAX_ATTEMPTS {
        fatal = Some("the delegated run used its turn budget".to_owned());
    }
    // The report for the operator's webhook, if one is configured. It is sent on its own task,
    // so a slow endpoint never delays the answer; a failure is logged, not retried.
    let report = json!({
        "v": 1,
        "event": if finished { "delegate.finished" } else { "delegate.stopped" },
        "bot": runtime.name,
        "session": session_id,
        "text": if finished { last_text.clone() } else { fatal.clone().unwrap_or_default() },
        "nudges": nudges,
        "declined": approver.declined.load(Ordering::Relaxed),
        "turns": attempts,
        "seconds": started.elapsed().as_secs(),
        "waiting_on_owner": waiting_for_owner,
        "paused": paused.is_some(),
        "retry_at": paused.as_ref().map(|p| p["retry_at"].clone()).unwrap_or(Value::Null),
        "retry_at_local": paused.as_ref().map(|p| p["retry_at_local"].clone()).unwrap_or(Value::Null),
        "receipts": receipts,
        "at": std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_or(0, |d| d.as_secs()),
    });
    if let Some(url) = runtime.config.delegate.webhook.clone() {
        let home = runtime.home.clone();
        let config = runtime.config.delegate.clone();
        let bot = runtime.name.clone();
        tokio::spawn(async move {
            if let Err(e) = crate::delegate::post(&url, &home, &config, &report).await {
                tracing::warn!(bot = %bot, "{e}");
            }
        });
    }
    // The profile/memory nudge, as a normal turn has; it is not part of the answer.
    let nudge = runtime.nudge(agent, &guard.session.messages);
    drop(guard);
    if let Some(e) = fatal {
        let reason = if crate::delegate::is_usage_limit(&e) {
            "usage_limit"
        } else if e.contains("stalled") || e.contains("produced nothing") {
            "stalled"
        } else {
            "error"
        };
        let _ = tx.send(json!({
            "v": 1, "type": "delegate.stopped", "reason": reason, "text": e,
            "nudges": nudges, "declined": approver.declined.load(Ordering::Relaxed),
        }));
        let mut error = json!({ "v": 1, "type": "error", "text": e });
        if let Some(code) = code {
            error["code"] = json!(code);
        }
        let _ = tx.send(error);
    }
    if let Some(nudge) = nudge
        && let Ok(Ok(kept)) = tokio::time::timeout(NUDGE_WAIT, nudge).await
    {
        for line in kept {
            let _ = tx.send(json!({ "v": 1, "type": "kept", "text": line }));
        }
    }
}

/// Waits out a short usage limit, keeping the event stream alive while it does.
async fn wait_out(seconds: u64, tx: &mpsc::UnboundedSender<Value>) {
    let mut left = seconds;
    while left > 0 {
        let step = left.min(30);
        tokio::time::sleep(Duration::from_secs(step)).await;
        left -= step;
        if left > 0 {
            let _ = tx.send(json!({
                "v": 1, "type": "delegate.waiting", "reason": "usage_limit", "seconds": left,
            }));
        }
    }
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

/// What a delegated run tells the agent when a safety check asks for permission. It never says
/// yes, and it never waits: the run keeps moving on a safer path, and the owner sees the refusal.
const DELEGATED_REDIRECT: &str = "Delegated mode: the owner did not approve this, so it is not allowed. \
     Do not retry it or work around it; use a safer way or skip this step and keep going.";

/// In a delegated run: never accept an approval, say why, and keep going.
struct DelegatedApprover {
    events: mpsc::UnboundedSender<Value>,
    bot: String,
    declined: Arc<AtomicU32>,
}

impl Approver for DelegatedApprover {
    fn channel(&self) -> &'static str {
        "delegated"
    }

    fn approve<'a>(&'a self, action: &'a Action) -> Pin<Box<dyn Future<Output = Answer> + Send + 'a>> {
        Box::pin(async move {
            self.declined.fetch_add(1, Ordering::Relaxed);
            let _ = self.events.send(json!({
                "v": 1,
                "type": "delegate.declined",
                "text": format!("{}{}", crate::approval::asker(), action.describe()),
                "action": describe(action),
                "reason": "delegated mode never accepts approvals",
                "redirect": DELEGATED_REDIRECT,
                "bot": self.bot,
            }));
            Answer::Instead(DELEGATED_REDIRECT.to_owned())
        })
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
                "v": 1,
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

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;

    #[test]
    fn events_are_versioned_and_typed() {
        let text = stream_event(Event::Text("hi"));
        assert_eq!(text["v"], 1);
        assert_eq!(text["type"], "text");
        assert_eq!(text["delta"], "hi");

        let usage = stream_event(Event::Usage { input: 1, output: 2, cached: 3 });
        assert_eq!(usage["v"], 1);
        assert_eq!(usage["type"], "usage");
        assert_eq!(usage["cached"], 3);

        let change = stream_event(Event::Change { path: Path::new("a.txt"), before: "x", after: "xy" });
        assert_eq!(change["type"], "change");
        assert_eq!(change["before_bytes"], 1);
        assert_eq!(change["after_bytes"], 2);
    }

    #[test]
    fn a_large_tool_result_is_capped() {
        let text = "x".repeat(9_000);
        let event = stream_event(Event::Output { name: "read_file", text: &text });
        let output = event["text"].as_str().unwrap();
        assert!(output.len() < 9_000);
        assert!(output.contains("truncated in the event"));
    }
}
