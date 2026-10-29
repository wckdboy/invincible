//! Cloud GPU rental (spec/rent.md).
//!
//! The engine is in-process: a RunPod adapter, a price broker, presets, an S3-compatible store
//! and a session sweeper. There is no `wckd` child. A quote writes nothing. A confirmed create
//! is the only call that provisions, and only after the caps hold and the request carries
//! `invincible-confirmed: 1`.
//!
//! Portions of the broker, the session machine and the RunPod calls are ported from wckd-gpu
//! (MIT). Copyright (c) 2026 wckdboy.

mod broker;
mod engine;
mod preset;
mod provider;
mod runpod;
mod secrets;
mod session;
mod sync;

use std::future::Future;
use std::path::Path;
use std::sync::Arc;
use std::time::Duration;

use axum::Json;
use axum::body::Bytes;
use axum::extract::{Path as UrlPath, Request, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use chrono::{DateTime, Datelike, Utc};
use serde_json::{Value, json};

use crate::audit::Caller;
use crate::config::RentConfig;
use crate::server::{AppState, CLIENT_HEADER, CONFIRMED_HEADER, error};

use engine::{Ask, Engine, RentError};

/// Preset id and display name, shipped ones and any the operator added.
pub fn preset_names(home: &Path) -> Result<Vec<(String, String)>, String> {
    Ok(preset::Catalog::load(home)?.names())
}

/// Project ids that have a session file. A file that does not parse is skipped.
pub fn project_ids(home: &Path) -> Result<Vec<String>, String> {
    let state = home.join("rent/state");
    if !state.exists() {
        return Ok(Vec::new());
    }
    let (sessions, _) = session::Store::open(&state)?.list()?;
    let mut ids: Vec<String> = sessions.into_iter().map(|session| session.project_id).collect();
    ids.sort();
    ids.dedup();
    Ok(ids)
}

/// Where sessions and operator presets live: `$INVINCIBLE_HOME/rent`.
pub fn work_dir(home: &Path) -> std::path::PathBuf {
    home.join("rent")
}

/// The in-process engine and the caps the HTTP layer enforces on top of it.
pub struct Gateway {
    engine: Arc<Engine>,
    limits: RentConfig,
    /// One create at a time, so two confirmations cannot both pass the monthly cap.
    create: Arc<tokio::sync::Mutex<()>>,
    /// Dropped with the gateway, which stops the sweeper.
    _sweeper: tokio::sync::watch::Sender<bool>,
}

impl std::fmt::Debug for Gateway {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Gateway").field("limits", &self.limits).finish_non_exhaustive()
    }
}

/// A quote, a list, or a health check.
const READ_TIMEOUT: Duration = Duration::from_secs(30);
/// The confirming create. Provisioning waits on the vendor and on hydrate.
const CREATE_TIMEOUT: Duration = Duration::from_secs(180);
/// Stop waits out the drain before the pod is deleted.
const STOP_TIMEOUT: Duration = Duration::from_secs(180);

/// The provider key and the R2 keys are readable and mode 0600, and the store endpoint is allowed
/// for the region's ceiling. The secrets themselves are not returned.
pub fn secrets_ready(home: &Path, config: &RentConfig) -> Result<(), String> {
    if config.store.endpoint.is_empty() || config.store.bucket.is_empty() {
        return Err("[rent.store] endpoint and bucket are required when rent is enabled".to_owned());
    }
    secrets::endpoint_allowed(&config.store.endpoint, &config.require_regions, config.insecure_endpoint)?;
    let _ = secrets::read_secret(&secrets::resolve(home, &config.runpod_key_file))?;
    let _ = secrets::read_secret(&secrets::resolve(home, &config.store.access_key_file))?;
    let _ = secrets::read_secret(&secrets::resolve(home, &config.store.secret_key_file))?;
    Ok(())
}

/// Builds the engine when [config] enables it. `Ok(None)` when rent is off.
///
/// Called from the serve task: it spawns the sweeper on the running runtime.
pub fn start(config: &RentConfig, home: &Path) -> Result<Option<Arc<Gateway>>, String> {
    if !config.enabled {
        return Ok(None);
    }
    for key in &config.ignored {
        tracing::warn!("[rent] {key} is ignored; the node rents GPUs itself (spec/rent.md)");
    }
    if config.store.endpoint.is_empty() || config.store.bucket.is_empty() {
        return Err("[rent.store] endpoint and bucket are required when rent is enabled".to_owned());
    }
    secrets::endpoint_allowed(&config.store.endpoint, &config.require_regions, config.insecure_endpoint)?;
    if let Some(url) = &config.runpod_url {
        let parsed = reqwest::Url::parse(url).map_err(|e| format!("[rent] runpod_url: {e}"))?;
        let host = parsed.host_str().unwrap_or("");
        let loopback = host == "localhost" || host.parse::<std::net::IpAddr>().is_ok_and(|ip| ip.is_loopback());
        if !loopback && parsed.scheme() != "https" {
            return Err("[rent] runpod_url must be https, or a loopback address".to_owned());
        }
    }
    let runpod_key = secrets::read_secret(&secrets::resolve(home, &config.runpod_key_file))?;
    let access = secrets::read_secret(&secrets::resolve(home, &config.store.access_key_file))?;
    let secret = secrets::read_secret(&secrets::resolve(home, &config.store.secret_key_file))?;
    let provider = Arc::new(runpod::Client::new(config.runpod_url.as_deref(), runpod_key.clone())?);
    let objects = Arc::new(sync::S3::new(
        &config.store.endpoint,
        &config.store.bucket,
        &config.store.region,
        access.clone(),
        secret.clone(),
    )?);
    let engine = Arc::new(engine::Engine::open(engine::Open {
        provider,
        objects,
        home: home.to_owned(),
        secrets: vec![runpod_key, access.clone(), secret.clone()],
        bucket: config.store.bucket.clone(),
        endpoint: config.store.endpoint.clone(),
        access_key: access,
        secret_key: secret,
        idle_minutes: config.idle_minutes,
        monthly_cap_usd: config.monthly_cap_usd,
    })?);
    let (stop, mut stop_rx) = tokio::sync::watch::channel(false);
    let sweep = Arc::clone(&engine);
    tokio::spawn(async move {
        sweep.sweep().await;
        loop {
            tokio::select! {
                changed = stop_rx.changed() => {
                    if changed.is_err() || *stop_rx.borrow() {
                        break;
                    }
                }
                _ = tokio::time::sleep(Duration::from_secs(15)) => sweep.sweep().await,
            }
        }
    });
    Ok(Some(Arc::new(Gateway {
        engine,
        limits: config.clone(),
        create: Arc::new(tokio::sync::Mutex::new(())),
        _sweeper: stop,
    })))
}

fn disabled() -> Response {
    error(StatusCode::SERVICE_UNAVAILABLE, "rent_disabled", "rent is off ([rent] enabled = false)")
}

fn unavailable(message: &str) -> Response {
    error(StatusCode::SERVICE_UNAVAILABLE, "rent_unavailable", message)
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

fn map_err(err: RentError) -> Response {
    match err {
        RentError::Bad(message) => error(StatusCode::BAD_REQUEST, "bad_request", &message),
        RentError::NoOffers(message) => error(StatusCode::UNPROCESSABLE_ENTITY, "no_offers", &message),
        RentError::NotFound => error(StatusCode::NOT_FOUND, "not_found", "no such session"),
        RentError::Unavailable(message) => unavailable(&message),
        RentError::Stale(body) => ask_rent(body),
        RentError::Drain(session) => json_response(
            StatusCode::CONFLICT,
            json!({
                "error": {"code": "drain_failed", "message": "drain did not finish; pod left running"},
                "session": session,
            }),
        ),
    }
}

async fn within<T>(timeout: Duration, work: impl Future<Output = Result<T, RentError>>) -> Result<T, RentError> {
    match tokio::time::timeout(timeout, work).await {
        Ok(result) => result,
        Err(_) => Err(RentError::Unavailable("the rent request timed out".to_owned())),
    }
}

/// `GET /v1/rent/health`.
pub async fn health(State(state): State<Arc<AppState>>) -> Response {
    let Some(rent) = state.rent.clone() else {
        return disabled();
    };
    json_response(
        StatusCode::OK,
        json!({
            "ok": true,
            "engine": "invincible",
            "in_process": true,
            "limits": limits_json(&rent.limits),
        }),
    )
}

/// `GET /v1/rent/offers`. The node's `require_regions` is a ceiling: a missing query uses it, and a
/// query may only narrow it.
pub async fn offers(State(state): State<Arc<AppState>>, request: Request) -> Response {
    let Some(rent) = state.rent.clone() else {
        return disabled();
    };
    let asked = match offers_query(request.uri().query(), &rent.limits) {
        Ok(asked) => asked,
        Err(message) => return error(StatusCode::BAD_REQUEST, "bad_request", &message),
    };
    match within(READ_TIMEOUT, rent.engine.offers(&asked.preset, asked.hours, &asked.regions, asked.limit)).await {
        Ok(body) => json_response(StatusCode::OK, body),
        Err(err) => map_err(err),
    }
}

struct OffersQuery {
    preset: String,
    hours: f64,
    regions: Vec<String>,
    limit: usize,
}

fn offers_query(query: Option<&str>, limits: &RentConfig) -> Result<OffersQuery, String> {
    let mut preset = String::new();
    let mut hours = None;
    let mut limit = 20usize;
    let mut requested: Option<Vec<String>> = None;
    for pair in query.unwrap_or("").split('&').filter(|pair| !pair.is_empty()) {
        let (key, value) = pair.split_once('=').unwrap_or((pair, ""));
        let key = query_decode(key);
        let value = query_decode(value);
        match key.as_str() {
            "preset" => preset = value,
            "hours" => {
                hours = value.parse::<f64>().ok().filter(|hours| hours.is_finite() && *hours > 0.0 && *hours <= 24.0);
            }
            "limit" => limit = value.parse::<usize>().unwrap_or(20).clamp(1, 100),
            "require_regions" => {
                let tokens = split_regions(&value);
                match &mut requested {
                    Some(have) => have.extend(tokens),
                    None => requested = Some(tokens),
                }
            }
            _ => {}
        }
    }
    if preset.is_empty() {
        return Err("preset is required".to_owned());
    }
    let Some(hours) = hours else {
        return Err("hours is a number in (0, 24]".to_owned());
    };
    Ok(OffersQuery { preset, hours, regions: resolve_regions(requested.as_deref(), limits)?, limit })
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

fn offer_id(body: &Value) -> Option<&str> {
    body.get("offer_id").and_then(Value::as_str).map(str::trim).filter(|id| !id.is_empty())
}

/// `GET /v1/rent/sessions`.
pub async fn list(State(state): State<Arc<AppState>>) -> Response {
    let Some(rent) = state.rent.clone() else {
        return disabled();
    };
    match within(READ_TIMEOUT, rent.engine.list()).await {
        Ok(body) => json_response(StatusCode::OK, body),
        Err(err) => map_err(err),
    }
}

/// `GET /v1/rent/sessions/{id}`.
pub async fn session(State(state): State<Arc<AppState>>, UrlPath(id): UrlPath<String>) -> Response {
    let Some(rent) = state.rent.clone() else {
        return disabled();
    };
    let Some(id) = session_id(&id) else {
        return error(StatusCode::BAD_REQUEST, "bad_request", "a session id is [A-Za-z0-9_-]+");
    };
    match within(READ_TIMEOUT, rent.engine.get(id)).await {
        Ok(body) => json_response(StatusCode::OK, body),
        Err(err) => map_err(err),
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
/// after the caps hold. The preview provisions nothing.
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
    let original = request.clone();
    if let Some(object) = request.as_object_mut() {
        object.remove("confirm");
    }
    let hours = match request.get("hours").and_then(Value::as_f64) {
        Some(hours) if hours.is_finite() && hours > 0.0 && hours <= 24.0 => hours,
        _ => return error(StatusCode::BAD_REQUEST, "bad_request", "hours is a number in (0, 24]"),
    };
    if hours > rent.limits.max_hours {
        return cap_denied(&CapBreach::Hours { hours, max: rent.limits.max_hours }, None);
    }
    let project_id = match request.get("project_id").and_then(Value::as_str) {
        Some(id) => id.to_owned(),
        None => return error(StatusCode::BAD_REQUEST, "bad_request", "project_id is required"),
    };
    let preset_id = match request.get("preset_id").and_then(Value::as_str) {
        Some(id) => id.to_owned(),
        None => return error(StatusCode::BAD_REQUEST, "bad_request", "preset_id is required"),
    };
    let regions =
        match regions_in_body(&request).and_then(|requested| resolve_regions(requested.as_deref(), &rent.limits)) {
            Ok(regions) => regions,
            Err(message) => return error(StatusCode::BAD_REQUEST, "bad_request", &message),
        };
    if let Some(object) = request.as_object_mut() {
        object.insert("require_regions".to_owned(), json!(regions.clone()));
    }
    let ask = Ask {
        project_id,
        preset_id,
        hours,
        offer_id: offer_id(&request).map(str::to_owned),
        regions,
        approved_usd_per_hr: request
            .get("approved_usd_per_hr")
            .and_then(Value::as_f64)
            .filter(|n| n.is_finite() && *n >= 0.0),
    };
    let guard = Arc::clone(&rent.create).lock_owned().await;
    let preview = match within(READ_TIMEOUT, rent.engine.preview(&ask, confirmed(&headers))).await {
        Ok(preview) => preview,
        Err(err) => return map_err(err),
    };
    if preview["error"]["code"] != "confirmation_required" {
        return json_response(StatusCode::CONFLICT, preview);
    }
    let Some(quote) = quote_from(&preview, hours) else {
        if rent.limits.max_usd_per_hour.is_some() || rent.limits.monthly_cap_usd.is_some() {
            return cap_denied(&CapBreach::Unaccounted, preview.get("cost_estimate_usd").and_then(Value::as_f64));
        }
        return if confirmed(&headers) {
            confirm_detached(
                guard,
                ConfirmWork { state, rent, caller, headers, original, request, preview, ask, spent: None },
            )
            .await
        } else {
            ask_rent(preview)
        };
    };
    let spent = match rent.limits.monthly_cap_usd {
        Some(_) => match month_spent(&rent).await {
            Ok(spent) => Some(spent),
            Err(RentError::Bad(message)) if message == "unpriced" => return cap_denied(&CapBreach::Unaccounted, None),
            Err(err) => return map_err(err),
        },
        None => None,
    };
    if let Some(breach) = breach(&rent.limits, &quote, spent) {
        return cap_denied(&breach, Some(quote.estimate_usd));
    }
    if confirmed(&headers)
        && let Some(approved) = ask.approved_usd_per_hr
        && (cents(quote.usd_per_hr) > cents(approved)
            || ask.offer_id.as_deref().is_some_and(|id| preview["offer"]["id"].as_str() != Some(id)))
    {
        return ask_rent(preview);
    }
    if !confirmed(&headers) {
        return ask_rent(preview);
    }
    confirm_detached(guard, ConfirmWork { state, rent, caller, headers, original, request, preview, ask, spent }).await
}

struct ConfirmWork {
    state: Arc<AppState>,
    rent: Arc<Gateway>,
    caller: Option<axum::Extension<Caller>>,
    headers: HeaderMap,
    original: Value,
    request: Value,
    preview: Value,
    ask: Ask,
    spent: Option<f64>,
}

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

async fn month_spent(rent: &Gateway) -> Result<f64, RentError> {
    let sessions = rent.engine.sessions().await?;
    let values: Vec<Value> = sessions.iter().map(session::Session::public).collect();
    accounted(&values, Utc::now()).map_err(|()| RentError::Bad("unpriced".to_owned()))
}

async fn confirm_and_record(work: &ConfirmWork) -> Response {
    let mut ask = work.ask.clone();
    let pinned = match offer_id(&work.request) {
        Some(id) => id.to_owned(),
        None => {
            let Some(id) = work
                .preview
                .get("offer")
                .and_then(|offer| offer.get("id"))
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|id| !id.is_empty())
            else {
                return error(
                    StatusCode::BAD_GATEWAY,
                    "rent_unavailable",
                    "the quote did not name an offer, so the price cannot be locked",
                );
            };
            id.to_owned()
        }
    };
    ask.offer_id = Some(pinned.clone());
    let engine = Arc::clone(&work.rent.engine);
    let ask = ask.clone();
    let body = match within(CREATE_TIMEOUT, async move { engine.provision(ask).await }).await {
        Ok(body) => body,
        Err(err) => return map_err(err),
    };
    if let Some(breach) = session_over_cap(&work.rent.limits, &body, work.spent) {
        return stop_over_cap(&work.state, &work.rent, &work.caller, &work.headers, &body, &breach).await;
    }
    let response = json_response(StatusCode::CREATED, body.clone());
    let extra = json!({
        "rent": {
            "action": "start",
            "session_id": body["id"],
            "preset_id": body["preset_id"],
            "hours": body["hours"],
            "cost_estimate_usd": body["cost_estimate_usd"],
        },
        "rewrite": {
            "require_regions": work.request.get("require_regions").cloned().unwrap_or(Value::Null),
            "offer_id": pinned,
        }
    });
    record(&work.state, &work.caller, &work.headers, "rent.start", &work.original, response, extra)
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
    match within(STOP_TIMEOUT, rent.engine.stop(id, true, true)).await {
        Ok(body) => {
            let response = json_response(StatusCode::OK, body.clone());
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
        Err(_) => {
            return error(
                StatusCode::BAD_GATEWAY,
                "rent_cap",
                &format!("the rental {id} came back over the node's cap and it was not stopped"),
            );
        }
    }
    cap_denied(breach, finite_price(session.get("cost_estimate_usd")))
}

/// `POST /v1/rent/sessions/{id}/stop`. An empty body is `force: false`.
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
    let id = id.to_owned();
    finish_in_background(async move {
        let body = match within(STOP_TIMEOUT, rent.engine.stop(&id, force, false)).await {
            Ok(body) => body,
            Err(err) => return map_err(err),
        };
        let response = json_response(StatusCode::OK, body.clone());
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

fn json_response(status: StatusCode, body: Value) -> Response {
    (status, Json(body)).into_response()
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

fn confirmed(headers: &HeaderMap) -> bool {
    headers
        .get(CONFIRMED_HEADER)
        .and_then(|value| value.to_str().ok())
        .is_some_and(|value| matches!(value.trim().to_ascii_lowercase().as_str(), "1" | "true"))
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

fn cents(usd: f64) -> Option<i64> {
    if !usd.is_finite() || !(0.0..=1e12).contains(&usd) {
        return None;
    }
    Some((usd * 100.0).round() as i64)
}

/// The dearest candidate a create might provision. An empty `offer_id` failovers inside the window.
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
    fn a_request_may_narrow_the_nodes_regions_and_may_not_clear_or_widen_them() {
        let limits = RentConfig::default();
        let eu = offers_query(Some("preset=comfyui-minimax-h3&hours=1"), &limits).unwrap();
        assert_eq!(eu.regions, vec!["EU-secure".to_owned()]);
        assert!(offers_query(Some("preset=vllm&hours=1&require_regions=EU"), &limits).is_err());
        let secure = offers_query(Some("preset=vllm&hours=1&require_regions=EU-secure"), &limits).unwrap();
        assert_eq!(secure.regions, vec!["EU-secure".to_owned()]);
        assert!(offers_query(Some("preset=vllm&hours=1&require_regions="), &limits).is_err());
        assert!(offers_query(Some("preset=vllm&hours=1&require_regions=US"), &limits).is_err());
        let secure_ceiling = RentConfig { require_regions: vec!["EU-secure".into()], ..limits };
        assert!(resolve_regions(Some(&["EU".into()]), &secure_ceiling).is_err());
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
        assert!(accounted(&[json!({"created_at": "2026-10-02T00:00:00Z"})], now).is_err());
    }

    #[test]
    fn a_blank_offer_id_is_not_pinned_and_a_region_token_cannot_hold_a_comma() {
        assert!(offer_id(&json!({"offer_id": " "})).is_none());
        assert_eq!(offer_id(&json!({"offer_id": " runpod:1 "})), Some("runpod:1"));
        let err = regions_in_body(&json!({"require_regions": ["EU-x,US"]})).unwrap_err();
        assert!(err.contains("comma"), "{err}");
    }

    #[test]
    fn a_quote_waits_less_long_than_a_create_or_a_stop() {
        assert!(CREATE_TIMEOUT > READ_TIMEOUT);
        assert!(STOP_TIMEOUT >= Duration::from_secs(120));
    }
}
