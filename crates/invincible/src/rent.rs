//! Cloud GPU rental (spec/rent.md).
//!
//! `wckd serve` is a child process, supervised like any other engine and never linked. It binds
//! loopback, reads its bearer from a mode-0600 file the node wrote, and keeps sessions in the
//! node's rent directory. The node proxies `/v1/rent/*` and attaches that bearer itself. A client
//! of the node, and a line in a log, never sees it.
//!
//! Every create is an ask until the request carries `invincible-confirmed: 1`. The caps are a
//! ceiling, not a permission: under the cap still does not start a pod.

use std::future::Future;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use axum::Json;
use axum::body::Bytes;
use axum::extract::{Path as UrlPath, Request, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use chrono::{DateTime, Datelike, Utc};
use reqwest::Method;
use serde_json::{Value, json};

use crate::audit::Caller;
use crate::config::RentConfig;
use crate::engine::{Engine, KEY_FILE_FLAG, Launch};
use crate::server::{AppState, CLIENT_HEADER, CONFIRMED_HEADER, error};

/// Where `wckd` runs and where its `.env` is read from: `$INVINCIBLE_HOME/rent`.
pub fn work_dir(home: &Path) -> PathBuf {
    home.join("rent")
}

/// Session files. A restarted `wckd` on this directory loads them (spec/rent.md, Restart).
pub fn state_dir(home: &Path) -> PathBuf {
    work_dir(home).join("state")
}

/// The bearer file. The node writes it (mode 0600) before each start; the path is the argument,
/// never the key.
pub fn key_file(home: &Path) -> PathBuf {
    work_dir(home).join("wckd.key")
}

/// The supervised engine and the caps the node enforces on top of it.
pub struct Gateway {
    engine: Engine,
    limits: RentConfig,
    /// One create at a time, so two confirmations cannot both pass the monthly cap.
    /// An `Arc` so the guard can outlive the HTTP request ([`lock_create`]).
    create: Arc<tokio::sync::Mutex<()>>,
}

/// A quote, a list, or a health check. Short enough that a silent `wckd` cannot hold
/// [`Gateway::create`] for the life of the process.
const READ_TIMEOUT: Duration = Duration::from_secs(30);
/// The confirming create. Provisioning waits on the vendor, so it is allowed longer than a quote.
const CREATE_TIMEOUT: Duration = Duration::from_secs(180);
/// Stop waits out wckd's drain (two minutes by default) before the pod is deleted.
const STOP_TIMEOUT: Duration = Duration::from_secs(180);

impl std::fmt::Debug for Gateway {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Gateway").field("engine", &self.engine).field("limits", &self.limits).finish_non_exhaustive()
    }
}

/// What [start] returns when rent is enabled: the gateway the API holds, and the launch the
/// supervisor runs.
pub struct Started {
    pub gateway: Arc<Gateway>,
    pub launch: Launch,
}

/// Prepares `wckd serve` when [config] enables it. `Ok(None)` when rent is off: nothing is
/// spawned and `/v1/rent/*` answers that it is off.
pub fn start(config: &RentConfig, home: &Path, logs: &Path) -> Result<Option<Started>, String> {
    if !config.enabled {
        return Ok(None);
    }
    let program = crate::cluster::resolve_program(&config.binary)
        .ok_or_else(|| format!("[rent] binary {} is not on PATH and not a file", config.binary.display()))?;
    let port = crate::engine::free_port().map_err(|e| format!("no free port for wckd: {e}"))?;
    let key = crate::engine::new_key()?;
    let key_path = key_file(home);
    let state = state_dir(home);
    std::fs::create_dir_all(&state).map_err(|e| format!("{}: {e}", state.display()))?;
    let launch = wckd_launch(&program, port, &key, &key_path, &state, &work_dir(home), logs);
    let engine = Engine::attached("wckd", &format!("http://127.0.0.1:{port}"), None, false).with_key(&key);
    let gateway = Arc::new(Gateway { engine, limits: config.clone(), create: Arc::new(tokio::sync::Mutex::new(())) });
    Ok(Some(Started { gateway, launch }))
}

fn wckd_launch(
    program: &Path,
    port: u16,
    key: &str,
    key_file: &Path,
    state: &Path,
    work: &Path,
    logs: &Path,
) -> Launch {
    Launch {
        program: program.to_owned(),
        args: vec![
            "serve".to_owned(),
            "--listen".to_owned(),
            format!("127.0.0.1:{port}"),
            KEY_FILE_FLAG.to_owned(),
            key_file.display().to_string(),
        ],
        log: logs.join("wckd.log"),
        // The state directory only. Credentials stay in `.env` or `wckd.yaml`, which `wckd`
        // reads itself from [work]; they are not copied out of the node's environment.
        env: vec![("WCKD_STATE_DIR".to_owned(), state.display().to_string())],
        key_file: Some((key_file.to_owned(), key.to_owned())),
        cwd: Some(work.to_owned()),
    }
}

fn disabled() -> Response {
    error(StatusCode::SERVICE_UNAVAILABLE, "rent_disabled", "rent is off ([rent] enabled = false)")
}

fn unavailable(message: &str) -> Response {
    error(StatusCode::SERVICE_UNAVAILABLE, "rent_unavailable", message)
}

fn scrub(text: &str, key: &str) -> String {
    if key.is_empty() { text.to_owned() } else { text.replace(key, "[redacted]") }
}

fn warn_scrubbed(key: &str, err: &impl std::fmt::Display) {
    let text = scrub(&err.to_string(), key);
    tracing::warn!(engine = "wckd", "{text}");
}

/// USD to whole cents, for a comparison that does not depend on binary fractions.
fn cents(usd: f64) -> Option<i64> {
    if !usd.is_finite() || !(0.0..=1e12).contains(&usd) {
        return None;
    }
    Some((usd * 100.0).round() as i64)
}

fn confirmed(headers: &HeaderMap) -> bool {
    headers
        .get(CONFIRMED_HEADER)
        .and_then(|value| value.to_str().ok())
        .is_some_and(|value| matches!(value.trim().to_ascii_lowercase().as_str(), "1" | "true"))
}

fn limits_json(limits: &RentConfig) -> Value {
    json!({
        "max_usd_per_hour": limits.max_usd_per_hour,
        "max_hours": limits.max_hours,
        "monthly_cap_usd": limits.monthly_cap_usd,
        "idle_minutes": limits.idle_minutes,
        "require_regions": limits.require_regions,
    })
}

impl Gateway {
    /// The supervised process, for the supervisor. The key stays inside [Engine].
    pub fn engine(&self) -> &Engine {
        &self.engine
    }

    fn bearer(&self) -> &str {
        self.engine.key().unwrap_or("")
    }

    async fn exchange(
        &self,
        state: &AppState,
        method: Method,
        path: &str,
        body: Option<&Value>,
        timeout: Duration,
    ) -> Result<(StatusCode, Value), ()> {
        let url = format!("{}{path}", self.engine.base_url);
        let mut request = self.engine.authorized(state.client.request(method, &url)).timeout(timeout);
        if let Some(body) = body {
            request = request.json(body);
        }
        let response = match request.send().await {
            Ok(response) => response,
            Err(err) => {
                warn_scrubbed(self.bearer(), &err);
                return Err(());
            }
        };
        let status = StatusCode::from_u16(response.status().as_u16()).unwrap_or(StatusCode::BAD_GATEWAY);
        let bytes = match response.bytes().await {
            Ok(bytes) => bytes,
            Err(err) => {
                warn_scrubbed(self.bearer(), &err);
                return Err(());
            }
        };
        Ok(parse_upstream(status, &bytes, self.bearer()))
    }
}

fn parse_upstream(status: StatusCode, bytes: &[u8], key: &str) -> (StatusCode, Value) {
    let text = scrub(&String::from_utf8_lossy(bytes), key);
    match serde_json::from_str::<Value>(&text) {
        Ok(value) => (status, value),
        Err(_) => (
            StatusCode::BAD_GATEWAY,
            json!({"error": {"message": "wckd returned a body that was not JSON", "type": "rent_unavailable", "code": "rent_unavailable"}}),
        ),
    }
}

fn json_response(status: StatusCode, body: Value) -> Response {
    (status, Json(body)).into_response()
}

/// `GET /v1/rent/health`: wckd's health, plus the caps the node is enforcing.
pub async fn health(State(state): State<Arc<AppState>>) -> Response {
    let Some(rent) = state.rent.clone() else {
        return disabled();
    };
    match rent.exchange(&state, Method::GET, "/v1/rent/health", None, READ_TIMEOUT).await {
        Err(()) => unavailable("wckd is not answering"),
        Ok((status, mut body)) if status.is_success() => {
            if let Some(object) = body.as_object_mut() {
                object.insert("limits".to_owned(), limits_json(&rent.limits));
                object.insert("supervised".to_owned(), json!(true));
            }
            json_response(status, body)
        }
        Ok((status, body)) => json_response(status, body),
    }
}

/// `GET /v1/rent/offers`. The node's `require_regions` is a ceiling: a missing query uses it, and a
/// query may only narrow it.
pub async fn offers(State(state): State<Arc<AppState>>, request: Request) -> Response {
    let Some(rent) = state.rent.clone() else {
        return disabled();
    };
    let path = match offers_target(request.uri().query(), &rent.limits) {
        Ok(path) => path,
        Err(message) => return error(StatusCode::BAD_REQUEST, "bad_request", &message),
    };
    match rent.exchange(&state, Method::GET, &path, None, READ_TIMEOUT).await {
        Err(()) => unavailable("wckd is not answering"),
        Ok((status, body)) => json_response(status, body),
    }
}

fn offers_target(query: Option<&str>, limits: &RentConfig) -> Result<String, String> {
    let mut pairs: Vec<(String, String)> = Vec::new();
    let mut requested: Option<Vec<String>> = None;
    for pair in query.unwrap_or("").split('&').filter(|pair| !pair.is_empty()) {
        let (key, value) = pair.split_once('=').unwrap_or((pair, ""));
        let key = query_decode(key);
        if key == "require_regions" {
            let tokens = split_regions(&query_decode(value));
            match &mut requested {
                Some(have) => have.extend(tokens),
                None => requested = Some(tokens),
            }
        } else {
            pairs.push((key, query_decode(value)));
        }
    }
    let regions = resolve_regions(requested.as_deref(), limits)?;
    pairs.push(("require_regions".to_owned(), regions.join(",")));
    let query = pairs
        .iter()
        .map(|(key, value)| format!("{}={}", query_escape(key), query_escape(value)))
        .collect::<Vec<_>>()
        .join("&");
    Ok(format!("/v1/rent/offers?{query}"))
}

fn query_decode(value: &str) -> String {
    let bytes = value.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'%' && index + 2 < bytes.len() {
            let hex = std::str::from_utf8(&bytes[index + 1..index + 3]).unwrap_or("");
            if let Ok(byte) = u8::from_str_radix(hex, 16) {
                out.push(byte);
                index += 3;
                continue;
            }
        }
        out.push(bytes[index]);
        index += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

fn split_regions(value: &str) -> Vec<String> {
    value.split(',').map(str::trim).filter(|token| !token.is_empty()).map(str::to_owned).collect()
}

fn regions_in_body(body: &Value) -> Result<Option<Vec<String>>, String> {
    match body.get("require_regions") {
        None => Ok(None),
        Some(Value::Array(items)) => {
            let mut tokens = Vec::with_capacity(items.len());
            for item in items {
                let Some(token) = item.as_str() else {
                    return Err("require_regions is a list of region names".to_owned());
                };
                let token = token.trim();
                if token.contains(',') {
                    return Err("require_regions is a list of region names, without commas".to_owned());
                }
                if !token.is_empty() {
                    tokens.push(token.to_owned());
                }
            }
            // Present, including `[]` and `[""]`: the caller set the filter, and an empty result
            // is a clear, which [resolve_regions] refuses unless the node itself has none.
            Ok(Some(tokens))
        }
        Some(_) => Err("require_regions is a list of region names".to_owned()),
    }
}

/// The node's `[rent] require_regions` is the ceiling. Omitted means that list. A request may
/// name a subset (EU covers `EU-secure` and a finer `EU-…` token) and may not clear the filter
/// or name a region the node did not allow.
fn resolve_regions(requested: Option<&[String]>, limits: &RentConfig) -> Result<Vec<String>, String> {
    let Some(requested) = requested else {
        return Ok(limits.require_regions.clone());
    };
    let filter = if limits.require_regions.is_empty() {
        "no region filter".to_owned()
    } else {
        limits.require_regions.join(", ")
    };
    if requested.is_empty() {
        if unconstrained(&limits.require_regions) {
            return Ok(limits.require_regions.clone());
        }
        return Err(format!("require_regions cannot be cleared; this node requires {filter}"));
    }
    let mut narrowed = Vec::with_capacity(requested.len());
    for token in requested {
        if !token_allowed(token, &limits.require_regions) {
            return Err(format!(
                "require_regions {token} is outside this node's filter ({filter}); a request may only narrow it"
            ));
        }
        if !narrowed.iter().any(|have: &String| have == token) {
            narrowed.push(token.clone());
        }
    }
    Ok(narrowed)
}

fn unconstrained(configured: &[String]) -> bool {
    configured.is_empty() || configured.iter().any(|token| token == "any" || token == "*")
}

fn token_allowed(token: &str, configured: &[String]) -> bool {
    unconstrained(configured) || configured.iter().any(|configured| covers(configured, token))
}

/// `configured` allows `requested` when the request is that token or a stricter one: `EU` allows
/// `EU-secure` and `EU-RO-1`, and `EU-secure` does not allow a token that drops the secure mode.
fn covers(configured: &str, requested: &str) -> bool {
    if configured == requested || configured == "any" || configured == "*" {
        return true;
    }
    let (config_region, config_secure) = split_mode(configured);
    let (request_region, request_secure) = split_mode(requested);
    if config_secure && !request_secure {
        return false;
    }
    request_region == config_region
        || request_region.starts_with(&format!("{config_region}-"))
        || request_region.starts_with(&format!("{config_region}_"))
}

fn split_mode(token: &str) -> (&str, bool) {
    match token.strip_suffix("-secure") {
        Some(region) if !region.is_empty() => (region, true),
        _ => (token, false),
    }
}

/// A pinned offer id, with surrounding space removed. Whitespace alone is not an id: `wckd`
/// would treat it as unset and might provision a dearer row than the preview.
fn offer_id(body: &Value) -> Option<&str> {
    body.get("offer_id").and_then(Value::as_str).map(str::trim).filter(|id| !id.is_empty())
}

fn session_over_cap(limits: &RentConfig, session: &Value, spent: Option<f64>) -> Option<CapBreach> {
    let hours = session.get("hours").and_then(Value::as_f64).filter(|hours| hours.is_finite() && *hours > 0.0);
    let estimate = finite_price(session.get("cost_estimate_usd"));
    let usd_per_hr = finite_price(session.get("offer").and_then(|offer| offer.get("usd_per_hr")))
        .or_else(|| hours.zip(estimate).map(|(hours, estimate)| estimate / hours));
    match (hours, usd_per_hr) {
        (Some(hours), Some(usd_per_hr)) => {
            let estimate_usd = estimate.unwrap_or(usd_per_hr * hours);
            breach(limits, &Quote { hours, usd_per_hr, estimate_usd }, spent)
        }
        // A money cap with no price on the created session is not a pass.
        _ if limits.max_usd_per_hour.is_some() || limits.monthly_cap_usd.is_some() => Some(CapBreach::Unaccounted),
        _ => None,
    }
}

async fn stop_over_cap(
    state: &AppState,
    rent: &Gateway,
    caller: &Option<axum::Extension<Caller>>,
    headers: &HeaderMap,
    session: &Value,
    breach: &CapBreach,
) -> Response {
    let Some(id) = session.get("id").and_then(Value::as_str).and_then(session_id) else {
        return error(
            StatusCode::BAD_GATEWAY,
            "rent_cap",
            "the rental came back over the node's cap and it has no session id to stop",
        );
    };
    let sent = json!({"force": true});
    let path = format!("/v1/rent/sessions/{id}/stop");
    match rent.exchange(state, Method::POST, &path, Some(&sent), STOP_TIMEOUT).await {
        Ok((status, body)) if status.is_success() => {
            let response = json_response(status, body.clone());
            let extra = json!({
                "rent": {
                    "action": "stop",
                    "session_id": id,
                    "forced": true,
                    "over_cap": breach.limit(),
                    "cost_estimate_usd": session.get("cost_estimate_usd").cloned().unwrap_or(Value::Null),
                }
            });
            let _ = record(state, caller, headers, "rent.stop", &sent, response, extra);
        }
        _ => {
            return error(
                StatusCode::BAD_GATEWAY,
                "rent_cap",
                &format!("the rental {id} came back over the node's cap and wckd did not stop it"),
            );
        }
    }
    let estimate = finite_price(session.get("cost_estimate_usd"));
    cap_denied(breach, estimate)
}

fn query_escape(value: &str) -> String {
    let mut out = String::new();
    for byte in value.bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' | b',' => out.push(byte as char),
            _ => out.push_str(&format!("%{byte:02X}")),
        }
    }
    out
}

/// `GET /v1/rent/sessions`.
pub async fn list(State(state): State<Arc<AppState>>) -> Response {
    proxy_get(state, "/v1/rent/sessions").await
}

/// `GET /v1/rent/sessions/{id}`.
pub async fn session(State(state): State<Arc<AppState>>, UrlPath(id): UrlPath<String>) -> Response {
    let Some(id) = session_id(&id) else {
        return error(StatusCode::BAD_REQUEST, "bad_request", "a session id is [A-Za-z0-9_-]+");
    };
    proxy_get(state, &format!("/v1/rent/sessions/{id}")).await
}

async fn proxy_get(state: Arc<AppState>, path: &str) -> Response {
    let Some(rent) = state.rent.clone() else {
        return disabled();
    };
    match rent.exchange(&state, Method::GET, path, None, READ_TIMEOUT).await {
        Err(()) => unavailable("wckd is not answering"),
        Ok((status, body)) => json_response(status, body),
    }
}

fn session_id(id: &str) -> Option<&str> {
    if !id.is_empty() && id.len() <= 128 && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-') {
        Some(id)
    } else {
        None
    }
}

const BODY_LIMIT: usize = 64 * 1024;

enum BodyError {
    TooLarge,
    NotJson,
}

fn read_body(bytes: &Bytes) -> Result<Value, BodyError> {
    if bytes.len() > BODY_LIMIT {
        return Err(BodyError::TooLarge);
    }
    if bytes.iter().all(u8::is_ascii_whitespace) {
        return Ok(json!({}));
    }
    serde_json::from_slice(bytes).map_err(|_| BodyError::NotJson)
}

fn body_error(err: BodyError) -> Response {
    match err {
        BodyError::TooLarge => error(StatusCode::PAYLOAD_TOO_LARGE, "too_large", "a rent body is at most 64 KiB"),
        BodyError::NotJson => error(StatusCode::BAD_REQUEST, "bad_request", "the body is not JSON"),
    }
}

/// `POST /v1/rent/sessions`.
///
/// The client's `confirm` field is ignored. Confirmation is `invincible-confirmed: 1`, and only
/// after the caps hold. The first call to wckd is always unconfirmed, so a refusal here has not
/// provisioned anything.
pub async fn create(
    State(state): State<Arc<AppState>>,
    caller: Option<axum::Extension<Caller>>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let Some(rent) = state.rent.clone() else {
        return disabled();
    };
    let mut request = match read_body(&body) {
        Ok(value) if value.is_object() => value,
        Ok(_) => return error(StatusCode::BAD_REQUEST, "bad_request", "the body is a JSON object"),
        Err(err) => return body_error(err),
    };
    // The receipt binds this, before the node rewrites it. `confirm` is not approval, but it is
    // what the client sent.
    let original = request.clone();
    if let Some(object) = request.as_object_mut() {
        object.remove("confirm");
    }
    let hours = match request.get("hours").and_then(Value::as_f64) {
        Some(hours) if hours.is_finite() && hours > 0.0 => hours,
        _ => return error(StatusCode::BAD_REQUEST, "bad_request", "hours is a number in (0, 24]"),
    };
    if hours > rent.limits.max_hours {
        return cap_denied(&CapBreach::Hours { hours, max: rent.limits.max_hours }, None);
    }
    let regions =
        match regions_in_body(&request).and_then(|requested| resolve_regions(requested.as_deref(), &rent.limits)) {
            Ok(regions) => regions,
            Err(message) => return error(StatusCode::BAD_REQUEST, "bad_request", &message),
        };
    if let Some(object) = request.as_object_mut() {
        object.insert("require_regions".to_owned(), json!(regions));
    }
    let guard = Arc::clone(&rent.create).lock_owned().await;
    let (status, preview) =
        match rent.exchange(&state, Method::POST, "/v1/rent/sessions", Some(&request), READ_TIMEOUT).await {
            Err(()) => return unavailable("wckd is not answering"),
            Ok(response) => response,
        };
    if status != StatusCode::CONFLICT || preview["error"]["code"] != "confirmation_required" {
        return json_response(status, preview);
    }
    let Some(quote) = quote_from(&preview, hours) else {
        if rent.limits.max_usd_per_hour.is_some() || rent.limits.monthly_cap_usd.is_some() {
            return cap_denied(&CapBreach::Unaccounted, preview.get("cost_estimate_usd").and_then(Value::as_f64));
        }
        return if confirmed(&headers) {
            confirm_detached(
                guard,
                ConfirmWork { state, rent, caller, headers, original, request, preview, spent: None },
            )
            .await
        } else {
            ask_rent(preview)
        };
    };
    let spent = match rent.limits.monthly_cap_usd {
        Some(_) => match month_spent(&state, &rent).await {
            Ok(spent) => Some(spent),
            Err(err) => return month_error(err),
        },
        None => None,
    };
    if let Some(breach) = breach(&rent.limits, &quote, spent) {
        return cap_denied(&breach, Some(quote.estimate_usd));
    }
    if !confirmed(&headers) {
        return ask_rent(preview);
    }
    confirm_detached(guard, ConfirmWork { state, rent, caller, headers, original, request, preview, spent }).await
}

/// What the confirming task owns. The create lock is held beside it, not inside it, so the guard
/// can be dropped only after the receipt is written.
struct ConfirmWork {
    state: Arc<AppState>,
    rent: Arc<Gateway>,
    caller: Option<axum::Extension<Caller>>,
    headers: HeaderMap,
    /// The body the client sent, which the receipt binds.
    original: Value,
    /// The body the node forwards: `confirm` removed, regions narrowed, offer not yet pinned.
    request: Value,
    preview: Value,
    spent: Option<f64>,
}

/// The confirming call, and the audit entry for it, outlive the HTTP request. Dropping the
/// handler (the client went away) drops the [`JoinHandle`] only: the task keeps the create lock
/// until the pod's receipt is written.
async fn confirm_detached(guard: tokio::sync::OwnedMutexGuard<()>, work: ConfirmWork) -> Response {
    finish_in_background(async move {
        let _hold = guard;
        confirm_and_record(&work).await
    })
    .await
}

async fn finish_in_background(work: impl Future<Output = Response> + Send + 'static) -> Response {
    match tokio::spawn(work).await {
        Ok(response) => response,
        Err(_) => unavailable("the rent request was interrupted"),
    }
}

enum MonthError {
    Down,
    Upstream(StatusCode, Value),
    Unaccounted,
}

async fn month_spent(state: &AppState, rent: &Gateway) -> Result<f64, MonthError> {
    let (status, body) = rent
        .exchange(state, Method::GET, "/v1/rent/sessions", None, READ_TIMEOUT)
        .await
        .map_err(|()| MonthError::Down)?;
    if !status.is_success() {
        return Err(MonthError::Upstream(status, body));
    }
    let sessions = body["sessions"].as_array().cloned().unwrap_or_default();
    accounted(&sessions, Utc::now()).map_err(|()| MonthError::Unaccounted)
}

fn month_error(err: MonthError) -> Response {
    match err {
        MonthError::Down => unavailable("wckd is not answering"),
        MonthError::Upstream(status, body) => json_response(status, body),
        MonthError::Unaccounted => cap_denied(&CapBreach::Unaccounted, None),
    }
}

async fn confirm_and_record(work: &ConfirmWork) -> Response {
    let state = &*work.state;
    let rent = &*work.rent;
    let caller = &work.caller;
    let headers = &work.headers;
    let original = &work.original;
    let request = &work.request;
    let preview = &work.preview;
    let spent = work.spent;
    let mut confirmed_body = request.clone();
    if let Some(object) = confirmed_body.as_object_mut() {
        object.insert("confirm".to_owned(), json!(true));
    }
    // An empty or blank offer id lets wckd re-rank between this preview and the create, and the
    // new row can cost more than the window the caps were checked against. Pin the previewed offer.
    let pinned = match offer_id(&confirmed_body) {
        Some(id) => id.to_owned(),
        None => {
            let Some(id) = preview
                .get("offer")
                .and_then(|offer| offer.get("id"))
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|id| !id.is_empty())
            else {
                return error(
                    StatusCode::BAD_GATEWAY,
                    "rent_unavailable",
                    "wckd did not name an offer, so the price cannot be locked",
                );
            };
            id.to_owned()
        }
    };
    if let Some(object) = confirmed_body.as_object_mut() {
        object.insert("offer_id".to_owned(), json!(pinned));
    }
    let url = format!("{}/v1/rent/sessions", rent.engine.base_url);
    let response = rent
        .engine
        .authorized(state.client.post(url).json(&confirmed_body))
        .header("X-Wckd-Confirm", "true")
        .timeout(CREATE_TIMEOUT)
        .send()
        .await;
    let response = match response {
        Ok(response) => response,
        Err(err) => {
            warn_scrubbed(rent.bearer(), &err);
            return unavailable("wckd is not answering");
        }
    };
    let status = StatusCode::from_u16(response.status().as_u16()).unwrap_or(StatusCode::BAD_GATEWAY);
    let bytes = match response.bytes().await {
        Ok(bytes) => bytes,
        Err(err) => {
            warn_scrubbed(rent.bearer(), &err);
            return unavailable("wckd closed the response");
        }
    };
    let (status, body) = parse_upstream(status, &bytes, rent.bearer());
    if status != StatusCode::CREATED {
        return json_response(status, body);
    }
    if let Some(breach) = session_over_cap(&rent.limits, &body, spent) {
        return stop_over_cap(state, rent, caller, headers, &body, &breach).await;
    }
    let response = json_response(status, body.clone());
    let extra = json!({
        "rent": {
            "action": "start",
            "session_id": body["id"],
            "preset_id": body["preset_id"],
            "hours": body["hours"],
            "cost_estimate_usd": body["cost_estimate_usd"],
        },
        // What the node actually sent, beside the receipt of what the client sent.
        "rewrite": {
            "require_regions": request.get("require_regions").cloned().unwrap_or(Value::Null),
            "offer_id": confirmed_body.get("offer_id").cloned().unwrap_or(Value::Null),
        }
    });
    record(state, caller, headers, "rent.start", original, response, extra)
}

/// `POST /v1/rent/sessions/{id}/stop`. An empty body is `force: false`, as wckd reads it.
pub async fn stop(
    State(state): State<Arc<AppState>>,
    caller: Option<axum::Extension<Caller>>,
    headers: HeaderMap,
    UrlPath(id): UrlPath<String>,
    body: Bytes,
) -> Response {
    let Some(rent) = state.rent.clone() else {
        return disabled();
    };
    let Some(id) = session_id(&id) else {
        return error(StatusCode::BAD_REQUEST, "bad_request", "a session id is [A-Za-z0-9_-]+");
    };
    let original = match read_body(&body) {
        Ok(value) => value,
        Err(err) => return body_error(err),
    };
    let force = match original.get("force") {
        None => false,
        Some(Value::Bool(force)) => *force,
        Some(_) => return error(StatusCode::BAD_REQUEST, "bad_request", "force is a boolean"),
    };
    let state = state.clone();
    let rent = rent.clone();
    let caller = caller.clone();
    let headers = headers.clone();
    let id = id.to_owned();
    // Same as a confirming create: the stop, and its audit entry, finish if the client leaves.
    finish_in_background(async move {
        let sent = json!({"force": force});
        let path = format!("/v1/rent/sessions/{id}/stop");
        let (status, body) = match rent.exchange(&state, Method::POST, &path, Some(&sent), STOP_TIMEOUT).await {
            Err(()) => return unavailable("wckd is not answering"),
            Ok(response) => response,
        };
        let response = json_response(status, body.clone());
        if !status.is_success() {
            return response;
        }
        let extra = json!({
            "rent": {
                "action": "stop",
                "session_id": body["id"].as_str().unwrap_or(&id),
                "forced": body["forced"],
                "phase": body["phase"],
                "cost_estimate_usd": body["cost_estimate_usd"],
            }
        });
        record(&state, &caller, &headers, "rent.stop", &original, response, extra)
    })
    .await
}

fn record(
    state: &AppState,
    caller: &Option<axum::Extension<Caller>>,
    headers: &HeaderMap,
    api: &'static str,
    request: &Value,
    response: Response,
    extra: Value,
) -> Response {
    let mut draft = match crate::receipts::Draft::new() {
        Ok(draft) => draft,
        Err(err) => return error(StatusCode::INTERNAL_SERVER_ERROR, "internal_error", &err),
    };
    draft.caller = caller.clone().map(|axum::Extension(caller)| caller).unwrap_or(Caller::Local);
    draft.client =
        headers.get(CLIENT_HEADER).and_then(|value| value.to_str().ok()).map(|value| value.chars().take(64).collect());
    draft.bind_request(api, request);
    draft.audit_extra = Some(extra);
    crate::receipts::attach(
        response,
        Arc::new(std::sync::Mutex::new(draft)),
        state.receipt_key.clone(),
        state.receipts.clone(),
        state.audit.clone(),
    )
}

fn ask_rent(preview: Value) -> Response {
    let mut body = preview;
    body["error"] = json!({
        "message": "renting a GPU needs confirmation; send again with `invincible-confirmed: 1`",
        "type": "confirmation_required",
        "code": "confirmation_required",
        "confirm_header": CONFIRMED_HEADER,
    });
    json_response(StatusCode::CONFLICT, body)
}

/// Why a rental was refused before wckd was asked to provision it.
enum CapBreach {
    Hours { hours: f64, max: f64 },
    Hourly { usd_per_hr: f64, max: f64 },
    Monthly { spent: f64, next: f64, cap: f64 },
    Unaccounted,
}

impl CapBreach {
    fn limit(&self) -> &'static str {
        match self {
            Self::Hours { .. } => "max_hours",
            Self::Hourly { .. } => "max_usd_per_hour",
            Self::Monthly { .. } => "monthly_cap_usd",
            Self::Unaccounted => "unaccounted",
        }
    }

    fn message(&self) -> String {
        match self {
            Self::Hours { hours, max } => format!("this rental is {hours} hours, over the node's max of {max}"),
            Self::Hourly { usd_per_hr, max } => {
                format!("this offer is {usd_per_hr} USD/hour, over the node's max of {max}")
            }
            Self::Monthly { spent, next, cap } => {
                format!("this rental would take the month from {spent:.2} to {next:.2} USD, over the cap of {cap:.2}")
            }
            Self::Unaccounted => {
                "the node cannot price this rental against its cap, so it will not start one".to_owned()
            }
        }
    }
}

fn cap_denied(breach: &CapBreach, estimate: Option<f64>) -> Response {
    let mut error = json!({
        "message": breach.message(),
        "type": "rent_cap",
        "code": "rent_cap",
        "limit": breach.limit(),
    });
    if let Some(estimate) = estimate {
        error["cost_estimate_usd"] = json!(estimate);
    }
    json_response(StatusCode::FORBIDDEN, json!({"error": error}))
}

#[derive(Clone, Copy)]
struct Quote {
    hours: f64,
    usd_per_hr: f64,
    estimate_usd: f64,
}

fn finite_price(value: Option<&Value>) -> Option<f64> {
    value.and_then(Value::as_f64).filter(|price| price.is_finite() && *price >= 0.0)
}

/// The dearest candidate wckd might provision. An empty `offer_id` failovers inside the window,
/// and a later row can cost more than the one named in `cost_estimate_usd`.
fn quote_from(preview: &Value, hours: f64) -> Option<Quote> {
    let mut usd_per_hr = finite_price(preview.get("offer").and_then(|offer| offer.get("usd_per_hr")));
    let mut estimate_usd = finite_price(preview.get("cost_estimate_usd"));
    for row in preview.get("failover").and_then(Value::as_array).into_iter().flatten() {
        if let Some(price) = finite_price(row.get("usd_per_hr")) {
            usd_per_hr = Some(usd_per_hr.map_or(price, |have| have.max(price)));
        }
        if let Some(price) = finite_price(row.get("estimate_usd")) {
            estimate_usd = Some(estimate_usd.map_or(price, |have| have.max(price)));
        }
    }
    let estimate_usd = estimate_usd?;
    let usd_per_hr = usd_per_hr.or_else(|| (hours > 0.0).then(|| estimate_usd / hours))?;
    (usd_per_hr.is_finite() && usd_per_hr >= 0.0).then_some(Quote { hours, usd_per_hr, estimate_usd })
}

fn breach(limits: &RentConfig, quote: &Quote, spent: Option<f64>) -> Option<CapBreach> {
    if quote.hours > limits.max_hours {
        return Some(CapBreach::Hours { hours: quote.hours, max: limits.max_hours });
    }
    if let Some(max) = limits.max_usd_per_hour {
        match (cents(quote.usd_per_hr), cents(max)) {
            (Some(price), Some(cap)) if price > cap => {
                return Some(CapBreach::Hourly { usd_per_hr: quote.usd_per_hr, max });
            }
            (Some(_), Some(_)) => {}
            _ => return Some(CapBreach::Unaccounted),
        }
    }
    if let Some(cap) = limits.monthly_cap_usd {
        let Some(spent) = spent else {
            return Some(CapBreach::Unaccounted);
        };
        let next = spent + quote.estimate_usd;
        match (cents(next), cents(cap)) {
            (Some(next_cents), Some(cap_cents)) if next_cents > cap_cents => {
                return Some(CapBreach::Monthly { spent, next, cap });
            }
            (Some(_), Some(_)) => {}
            _ => return Some(CapBreach::Unaccounted),
        }
    }
    None
}

/// The sum of `cost_estimate_usd` for sessions created this UTC month. A session in that month
/// with no readable cost is an error: the cap cannot be checked, so the caller refuses.
fn accounted(sessions: &[Value], now: DateTime<Utc>) -> Result<f64, ()> {
    let mut spent = 0.0;
    for session in sessions {
        let Some(at) = session.get("created_at").and_then(created_at) else {
            return Err(());
        };
        if at.year() != now.year() || at.month() != now.month() {
            continue;
        }
        let Some(cost) = session.get("cost_estimate_usd").and_then(Value::as_f64) else {
            return Err(());
        };
        if !cost.is_finite() || cost < 0.0 {
            return Err(());
        }
        spent += cost;
    }
    Ok(spent)
}

fn created_at(value: &Value) -> Option<DateTime<Utc>> {
    if let Some(seconds) = value.as_i64() {
        return DateTime::from_timestamp(seconds, 0);
    }
    value.as_str().and_then(|text| DateTime::parse_from_rfc3339(text).ok()).map(|at| at.with_timezone(&Utc))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn limits() -> RentConfig {
        RentConfig {
            enabled: true,
            max_usd_per_hour: Some(1.0),
            max_hours: 2.0,
            monthly_cap_usd: Some(0.75),
            ..RentConfig::default()
        }
    }

    #[test]
    fn the_launch_keeps_the_key_off_the_command_line_and_out_of_the_environment() {
        let launch = wckd_launch(
            Path::new("/usr/local/bin/wckd"),
            8787,
            "sekret",
            Path::new("/home/rent/wckd.key"),
            Path::new("/home/rent/state"),
            Path::new("/home/rent"),
            Path::new("/home/logs"),
        );
        let printed = format!("{launch:?}");
        assert!(!printed.contains("sekret"), "{printed}");
        assert!(!launch.args.iter().any(|arg| arg.contains("sekret")));
        assert!(launch.args.windows(2).any(|pair| pair == ["--api-key-file", "/home/rent/wckd.key"]));
        assert_eq!(launch.args[2], "127.0.0.1:8787");
        assert_eq!(launch.env, vec![("WCKD_STATE_DIR".to_owned(), "/home/rent/state".to_owned())]);
        assert_eq!(launch.cwd.as_deref(), Some(Path::new("/home/rent")));
        assert_eq!(launch.key_file.as_ref().map(|(_, key)| key.as_str()), Some("sekret"));
    }

    #[test]
    fn a_request_may_narrow_the_nodes_regions_and_may_not_clear_or_widen_them() {
        let limits = RentConfig::default();
        assert_eq!(offers_target(None, &limits).unwrap(), "/v1/rent/offers?require_regions=EU");
        assert_eq!(
            offers_target(Some("preset=comfy&hours=1"), &limits).unwrap(),
            "/v1/rent/offers?preset=comfy&hours=1&require_regions=EU"
        );
        assert_eq!(
            offers_target(Some("preset=comfy&require_regions=EU-secure"), &limits).unwrap(),
            "/v1/rent/offers?preset=comfy&require_regions=EU-secure"
        );
        assert_eq!(resolve_regions(Some(&["EU-RO-1".into()]), &limits).unwrap(), vec!["EU-RO-1".to_owned()]);
        let cleared = offers_target(Some("require_regions="), &limits).unwrap_err();
        assert!(cleared.contains("cannot be cleared"), "{cleared}");
        let widened = offers_target(Some("require_regions=US"), &limits).unwrap_err();
        assert!(widened.contains("US") && widened.contains("EU"), "{widened}");
        assert!(resolve_regions(Some(&["EU".into(), "US".into()]), &limits).is_err());
        // Secure is stricter than EU. Dropping it, when that is what the node required, widens.
        let secure = RentConfig { require_regions: vec!["EU-secure".into()], ..limits };
        assert!(resolve_regions(Some(&["EU".into()]), &secure).is_err());
        assert_eq!(resolve_regions(Some(&["EU-secure".into()]), &secure).unwrap(), vec!["EU-secure".to_owned()]);
    }

    #[test]
    fn caps_refuse_hours_price_and_the_month_and_allow_what_fits() {
        let limits = limits();
        let quote = Quote { hours: 1.0, usd_per_hr: 0.5, estimate_usd: 0.5 };
        assert!(breach(&limits, &quote, Some(0.0)).is_none());
        assert!(matches!(breach(&limits, &Quote { hours: 3.0, ..quote }, Some(0.0)), Some(CapBreach::Hours { .. })));
        assert!(matches!(
            breach(&limits, &Quote { usd_per_hr: 1.5, estimate_usd: 1.5, ..quote }, Some(0.0)),
            Some(CapBreach::Hourly { .. })
        ));
        assert!(matches!(breach(&limits, &quote, Some(0.5)), Some(CapBreach::Monthly { .. })));
    }

    #[test]
    fn the_cap_uses_the_dearest_failover_not_only_the_first_offer() {
        let preview = json!({
            "cost_estimate_usd": 0.34,
            "offer": {"usd_per_hr": 0.34, "estimate_usd": 0.34},
            "failover": [
                {"usd_per_hr": 0.34, "estimate_usd": 0.34},
                {"usd_per_hr": 1.5, "estimate_usd": 1.5}
            ]
        });
        let quote = quote_from(&preview, 1.0).unwrap();
        assert_eq!(quote.usd_per_hr, 1.5);
        assert_eq!(quote.estimate_usd, 1.5);
        assert!(matches!(breach(&limits(), &quote, Some(0.0)), Some(CapBreach::Hourly { .. })));
    }

    #[test]
    fn the_monthly_sum_is_this_utc_month_and_fails_closed_without_a_price() {
        let now = DateTime::parse_from_rfc3339("2026-10-29T12:00:00Z").unwrap().with_timezone(&Utc);
        let sessions = vec![
            json!({"created_at": "2026-10-01T00:00:00Z", "cost_estimate_usd": 0.34}),
            json!({"created_at": "2026-09-30T23:00:00Z", "cost_estimate_usd": 9.0}),
        ];
        assert_eq!(accounted(&sessions, now).unwrap(), 0.34);
        let blind = vec![json!({"created_at": "2026-10-02T00:00:00Z"})];
        assert!(accounted(&blind, now).is_err());
    }

    #[test]
    fn a_blank_offer_id_is_not_pinned_and_a_region_token_cannot_hold_a_comma() {
        assert!(offer_id(&json!({"offer_id": " "})).is_none());
        assert!(offer_id(&json!({"offer_id": ""})).is_none());
        assert_eq!(offer_id(&json!({"offer_id": " runpod:1 "})), Some("runpod:1"));
        let err = regions_in_body(&json!({"require_regions": ["EU-x,US"]})).unwrap_err();
        assert!(err.contains("comma"), "{err}");
        assert!(regions_in_body(&json!({"require_regions": ["EU-secure"]})).is_ok());
    }

    #[test]
    fn a_quote_waits_less_long_than_a_create_or_a_stop() {
        assert!(CREATE_TIMEOUT > READ_TIMEOUT);
        assert!(STOP_TIMEOUT > READ_TIMEOUT);
        // wckd's drain waits two minutes before it will delete the pod.
        assert!(STOP_TIMEOUT >= Duration::from_secs(120));
    }

    #[tokio::test]
    async fn a_silent_wckd_is_given_up_on() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let held = Arc::new(tokio::sync::Mutex::new(Vec::new()));
        let keep = held.clone();
        tokio::spawn(async move {
            loop {
                if let Ok((socket, _)) = listener.accept().await {
                    keep.lock().await.push(socket);
                }
            }
        });
        let state = crate::server::AppState::new(
            Vec::new(),
            invincible_policy::NodeSettings {
                network: invincible_policy::NetworkMode::Offline,
                egress: invincible_policy::Egress::Never,
            },
            "token".into(),
        );
        let gateway = Gateway {
            engine: Engine::attached("wckd", &format!("http://{addr}"), None, true).with_key("k"),
            limits: RentConfig::default(),
            create: Arc::new(tokio::sync::Mutex::new(())),
        };
        let started = std::time::Instant::now();
        let result = gateway.exchange(&state, Method::GET, "/v1/rent/health", None, Duration::from_millis(300)).await;
        let elapsed = started.elapsed();
        assert!(result.is_err(), "a silent wckd is not a healthy one");
        assert!(elapsed >= Duration::from_millis(200), "gave up without waiting: {elapsed:?}");
        assert!(elapsed < Duration::from_secs(2), "waited past the timeout: {elapsed:?}");
        drop(held);
    }

    #[test]
    fn scrub_replaces_the_bearer_and_leaves_the_rest() {
        assert_eq!(scrub("bearer sekret in sekret", "sekret"), "bearer [redacted] in [redacted]");
        assert_eq!(scrub("nothing", ""), "nothing");
    }
}
