//! Cloud GPU rental (spec/rent.md).
//!
//! `wckd serve` is a child process, supervised like any other engine and never linked. It binds
//! loopback, reads its bearer from a mode-0600 file the node wrote, and keeps sessions in the
//! node's rent directory. The node proxies `/v1/rent/*` and attaches that bearer itself. A client
//! of the node, and a line in a log, never sees it.
//!
//! Every create is an ask until the request carries `invincible-confirmed: 1`. The caps are a
//! ceiling, not a permission: under the cap still does not start a pod.

use std::path::{Path, PathBuf};
use std::sync::Arc;

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
    create: tokio::sync::Mutex<()>,
}

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
    let gateway = Arc::new(Gateway { engine, limits: config.clone(), create: tokio::sync::Mutex::new(()) });
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
    ) -> Result<(StatusCode, Value), ()> {
        let url = format!("{}{path}", self.engine.base_url);
        let mut request = self.engine.authorized(state.client.request(method, &url));
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
    match rent.exchange(&state, Method::GET, "/v1/rent/health", None).await {
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

/// `GET /v1/rent/offers`. A missing `require_regions` becomes the node's filter (default `EU`).
pub async fn offers(State(state): State<Arc<AppState>>, request: Request) -> Response {
    let Some(rent) = state.rent.clone() else {
        return disabled();
    };
    let path = offers_target(request.uri().query(), &rent.limits);
    match rent.exchange(&state, Method::GET, &path, None).await {
        Err(()) => unavailable("wckd is not answering"),
        Ok((status, body)) => json_response(status, body),
    }
}

fn offers_target(query: Option<&str>, limits: &RentConfig) -> String {
    let mut pairs: Vec<String> =
        query.unwrap_or("").split('&').filter(|pair| !pair.is_empty()).map(str::to_owned).collect();
    let set = pairs.iter().any(|pair| match pair.split_once('=') {
        Some((key, _)) => key == "require_regions",
        None => pair.as_str() == "require_regions",
    });
    if !set {
        pairs.push(format!("require_regions={}", query_escape(&limits.require_regions.join(","))));
    }
    if pairs.is_empty() { "/v1/rent/offers".to_owned() } else { format!("/v1/rent/offers?{}", pairs.join("&")) }
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
    match rent.exchange(&state, Method::GET, path, None).await {
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
    // A client cannot confirm by talking to wckd's own flag. The node is the one that asks.
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
    if let Some(object) = request.as_object_mut()
        && !object.contains_key("require_regions")
    {
        object.insert("require_regions".to_owned(), json!(rent.limits.require_regions));
    }
    let _one = rent.create.lock().await;
    let (status, preview) = match rent.exchange(&state, Method::POST, "/v1/rent/sessions", Some(&request)).await {
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
            confirm_and_record(&state, &rent, &caller, &headers, &request).await
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
    confirm_and_record(&state, &rent, &caller, &headers, &request).await
}

enum MonthError {
    Down,
    Upstream(StatusCode, Value),
    Unaccounted,
}

async fn month_spent(state: &AppState, rent: &Gateway) -> Result<f64, MonthError> {
    let (status, body) =
        rent.exchange(state, Method::GET, "/v1/rent/sessions", None).await.map_err(|()| MonthError::Down)?;
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

async fn confirm_and_record(
    state: &AppState,
    rent: &Gateway,
    caller: &Option<axum::Extension<Caller>>,
    headers: &HeaderMap,
    request: &Value,
) -> Response {
    let mut confirmed_body = request.clone();
    if let Some(object) = confirmed_body.as_object_mut() {
        object.insert("confirm".to_owned(), json!(true));
    }
    let url = format!("{}/v1/rent/sessions", rent.engine.base_url);
    let response = rent
        .engine
        .authorized(state.client.post(url).json(&confirmed_body))
        .header("X-Wckd-Confirm", "true")
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
    let response = json_response(status, body.clone());
    if status != StatusCode::CREATED {
        return response;
    }
    let extra = json!({
        "rent": {
            "action": "start",
            "session_id": body["id"],
            "preset_id": body["preset_id"],
            "hours": body["hours"],
            "cost_estimate_usd": body["cost_estimate_usd"],
        }
    });
    record(state, caller, headers, "rent.start", request, response, extra)
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
    let request = match read_body(&body) {
        Ok(value) => value,
        Err(err) => return body_error(err),
    };
    let force = match request.get("force") {
        None => false,
        Some(Value::Bool(force)) => *force,
        Some(_) => return error(StatusCode::BAD_REQUEST, "bad_request", "force is a boolean"),
    };
    let sent = json!({"force": force});
    let path = format!("/v1/rent/sessions/{id}/stop");
    let (status, body) = match rent.exchange(&state, Method::POST, &path, Some(&sent)).await {
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
            "session_id": body["id"].as_str().unwrap_or(id),
            "forced": body["forced"],
            "phase": body["phase"],
            "cost_estimate_usd": body["cost_estimate_usd"],
        }
    });
    record(&state, &caller, &headers, "rent.stop", &sent, response, extra)
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
    fn a_missing_region_filter_becomes_the_nodes_default() {
        let limits = RentConfig::default();
        assert_eq!(offers_target(None, &limits), "/v1/rent/offers?require_regions=EU");
        assert_eq!(
            offers_target(Some("preset=comfy&hours=1"), &limits),
            "/v1/rent/offers?preset=comfy&hours=1&require_regions=EU"
        );
        // An explicit empty value is the caller clearing the filter, and is left alone.
        assert_eq!(offers_target(Some("require_regions="), &limits), "/v1/rent/offers?require_regions=");
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
    fn scrub_replaces_the_bearer_and_leaves_the_rest() {
        assert_eq!(scrub("bearer sekret in sekret", "sekret"), "bearer [redacted] in [redacted]");
        assert_eq!(scrub("nothing", ""), "nothing");
    }
}
