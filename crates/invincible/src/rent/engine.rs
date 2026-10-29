//! Session engine: quote, provision, hydrate, drain, delete. A quote writes nothing. A stop puts
//! the drain marker and only then deletes the pod. The sweeper does the same for a deadline, for
//! idle, and for a month that has gone over its cap, and it deletes even when the marker never
//! arrives: a pod does not outlive the hours it was paid for.

use std::sync::Arc;
use std::time::Duration;

use chrono::{DateTime, Datelike, TimeDelta, Utc};
use serde_json::{Value, json};

use super::broker::{self, Cache};
use super::preset::{Catalog, Preset};
use super::provider::{Offer, Provider, ProviderError, ProvisionRequest, Query};
use super::secrets::scrub;
use super::session::{self, Phase, Session, Store};
use super::sync::ObjectStore;

const DRAIN_WAIT: Duration = Duration::from_secs(120);
const DRAIN_POLL: Duration = Duration::from_millis(500);
const HYDRATE_WAIT: Duration = Duration::from_secs(20);

/// What [Engine::open] needs. One value, so the constructor does not take a long argument list.
pub struct Open {
    pub provider: Arc<dyn Provider>,
    pub objects: Arc<dyn ObjectStore>,
    pub home: std::path::PathBuf,
    pub secrets: Vec<String>,
    pub bucket: String,
    pub endpoint: String,
    pub access_key: String,
    pub secret_key: String,
    pub idle_minutes: u64,
    pub monthly_cap_usd: Option<f64>,
}

pub struct Engine {
    provider: Arc<dyn Provider>,
    objects: Arc<dyn ObjectStore>,
    sessions: Store,
    presets: Catalog,
    secrets: Vec<String>,
    bucket: String,
    endpoint: String,
    access_key: String,
    secret_key: String,
    cache: tokio::sync::Mutex<Cache>,
    life: tokio::sync::Mutex<()>,
    drain_wait: Duration,
    drain_poll: Duration,
    hydrate_wait: Duration,
    idle_minutes: u64,
    monthly_cap_usd: Option<f64>,
    clock: Arc<dyn Fn() -> DateTime<Utc> + Send + Sync>,
}

#[derive(Clone, Debug)]
pub struct Ask {
    pub project_id: String,
    pub preset_id: String,
    pub hours: f64,
    pub offer_id: Option<String>,
    pub regions: Vec<String>,
}

pub enum RentError {
    Bad(String),
    NoOffers(String),
    NotFound,
    Drain(Value),
    Unavailable(String),
}

impl Engine {
    pub fn open(parts: Open) -> Result<Self, String> {
        Ok(Self {
            sessions: Store::open(&parts.home.join("rent/state"))?,
            presets: Catalog::load(&parts.home)?,
            provider: parts.provider,
            objects: parts.objects,
            secrets: parts.secrets,
            bucket: parts.bucket,
            endpoint: parts.endpoint,
            access_key: parts.access_key,
            secret_key: parts.secret_key,
            cache: tokio::sync::Mutex::new(Cache::new()),
            life: tokio::sync::Mutex::new(()),
            drain_wait: DRAIN_WAIT,
            drain_poll: DRAIN_POLL,
            hydrate_wait: HYDRATE_WAIT,
            idle_minutes: parts.idle_minutes,
            monthly_cap_usd: parts.monthly_cap_usd,
            clock: Arc::new(Utc::now),
        })
    }

    fn now(&self) -> DateTime<Utc> {
        (self.clock)()
    }

    fn scrubbed(&self, err: impl std::fmt::Display) -> String {
        scrub(&err.to_string(), &self.secrets)
    }

    pub async fn offers(
        &self,
        preset_id: &str,
        hours: f64,
        regions: &[String],
        limit: usize,
    ) -> Result<Value, RentError> {
        let preset = self.preset(preset_id)?;
        let query = self.query(preset, regions)?;
        let ranked = self.ranked(&query).await?;
        let offers: Vec<Offer> = ranked.into_iter().take(limit.clamp(1, 100)).collect();
        Ok(json!({
            "preset_id": preset.id,
            "hours": hours,
            "require_regions": regions,
            "require_secure": query.require_secure,
            "cost_basis": "catalog_usd_per_hr_times_hours",
            "offers": offers.iter().map(|offer| offer_row(offer, hours)).collect::<Vec<_>>(),
        }))
    }

    /// The 409 preview. No session file, no pod, no object.
    pub async fn preview(&self, ask: &Ask) -> Result<Value, RentError> {
        self.check_project(&ask.project_id)?;
        let preset = self.preset(&ask.preset_id)?;
        let query = self.query(preset, &ask.regions)?;
        let ranked = self.ranked(&query).await?;
        let window = broker::select(&ranked, ask.offer_id.as_deref()).map_err(RentError::NoOffers)?;
        let first = &window[0];
        let estimate = first.usd_per_hr * ask.hours;
        Ok(json!({
            "error": {
                "code": "confirmation_required",
                "message": "confirmation required; resend with confirm true to rent the chosen offer. Nothing was created.",
            },
            "project_id": ask.project_id,
            "preset_id": preset.id,
            "hours": ask.hours,
            "cost_basis": "catalog_usd_per_hr_times_hours",
            "cost_estimate_usd": estimate,
            "require_regions": ask.regions,
            "require_secure": query.require_secure,
            "offer": offer_row(first, ask.hours),
            "failover": window.iter().map(|offer| offer_row(offer, ask.hours)).collect::<Vec<_>>(),
        }))
    }

    pub async fn provision(&self, ask: &Ask) -> Result<Value, RentError> {
        let _guard = self.life.lock().await;
        self.check_project(&ask.project_id)?;
        let preset = self.preset(&ask.preset_id)?.clone();
        let query = self.query(&preset, &ask.regions)?;
        let ranked = self.ranked(&query).await?;
        let window = broker::select(&ranked, ask.offer_id.as_deref()).map_err(RentError::NoOffers)?;
        let now = self.now();
        let id = session::new_id().map_err(|e| RentError::Unavailable(self.scrubbed(e)))?;
        let mut session = Session {
            id: id.clone(),
            project_id: ask.project_id.clone(),
            preset_id: preset.id.clone(),
            hours: ask.hours,
            created_at: now,
            deadline_at: now + TimeDelta::milliseconds((ask.hours * 3_600_000.0).round() as i64),
            last_active: now,
            phase: Phase::Provisioning,
            offer: window[0].clone(),
            instance_id: String::new(),
            pod_status: String::new(),
            data_center: String::new(),
            endpoints: Vec::new(),
            cost_estimate_usd: window[0].usd_per_hr * ask.hours,
            cost_actual_usd: 0.0,
            drain_ok: false,
            forced: false,
            error: String::new(),
            warning: String::new(),
            events: Vec::new(),
            ended_at: None,
        };
        session.note(now, "session created");
        self.sessions.save(&session).map_err(|e| RentError::Unavailable(self.scrubbed(e)))?;
        if let Err(err) = self.write_project(&session).await {
            session.error = err.clone();
            let _ = session.go(Phase::Failed, self.now(), err.clone());
            let _ = self.sessions.save(&session);
            return Err(RentError::Unavailable(err));
        }
        let mut last = String::from("provision failed");
        for candidate in &window {
            let request = self.provision_request(&session, &preset, candidate);
            match self.provider.provision(&request).await {
                Ok(instance) => {
                    if !placement_ok(&query.require_regions, &instance.data_center) {
                        last = format!(
                            "provision {}: data center {:?} is outside require_regions",
                            candidate.id, instance.data_center
                        );
                        if let Err(err) = self.provider.terminate(&instance.id).await {
                            session.instance_id = instance.id;
                            session.data_center = instance.data_center;
                            let message = self.scrubbed(err);
                            session.error = format!("{last} (terminate: {message})");
                            let _ = session.go(Phase::Failed, self.now(), session.error.clone());
                            let _ = self.sessions.save(&session);
                            return Err(RentError::Unavailable(session.error.clone()));
                        }
                        continue;
                    }
                    session.offer = candidate.clone();
                    if instance.cost_per_hour > session.offer.usd_per_hr {
                        session.offer.usd_per_hr = instance.cost_per_hour;
                        session.cost_estimate_usd = instance.cost_per_hour * session.hours;
                    }
                    session.instance_id = instance.id.clone();
                    session.pod_status = instance.status;
                    session.data_center = instance.data_center;
                    session.endpoints = instance.endpoints;
                    session.error.clear();
                    session
                        .go(Phase::Hydrating, self.now(), format!("pod {} created", instance.id))
                        .map_err(RentError::Unavailable)?;
                    let _ = self.sessions.save(&session);
                    break;
                }
                Err(err) => last = self.scrubbed(err),
            }
        }
        if session.instance_id.is_empty() {
            session.error = last.clone();
            let _ = session.go(Phase::Failed, self.now(), last.clone());
            let _ = self.sessions.save(&session);
            return Err(RentError::Unavailable(last));
        }
        if let Err(err) = self.hydrate(&mut session).await {
            let _ = self.provider.terminate(&session.instance_id).await;
            session.error = err.clone();
            let _ = session.go(Phase::Failed, self.now(), err.clone());
            let _ = self.sessions.save(&session);
            return Err(RentError::Unavailable(err));
        }
        let _ = self.sessions.save(&session);
        Ok(session.public())
    }

    pub async fn list(&self) -> Result<Value, RentError> {
        let sessions = self.sessions.list().map_err(|e| RentError::Unavailable(self.scrubbed(e)))?;
        Ok(json!({ "sessions": sessions.iter().map(Session::public).collect::<Vec<_>>() }))
    }

    pub async fn sessions(&self) -> Result<Vec<Session>, RentError> {
        self.sessions.list().map_err(|e| RentError::Unavailable(self.scrubbed(e)))
    }

    pub async fn get(&self, id: &str) -> Result<Value, RentError> {
        let _guard = self.life.lock().await;
        let Some(mut session) = self.sessions.get(id).map_err(|e| RentError::Unavailable(self.scrubbed(e)))? else {
            return Err(RentError::NotFound);
        };
        self.refresh(&mut session).await;
        if session.phase.active() {
            session.last_active = self.now();
        }
        self.sessions.save(&session).map_err(|e| RentError::Unavailable(self.scrubbed(e)))?;
        Ok(session.public())
    }

    /// Drain, then delete. `must_delete` is the sweeper: the pod is removed after the drain
    /// attempt even when the marker never arrives.
    pub async fn stop(&self, id: &str, force: bool, must_delete: bool) -> Result<Value, RentError> {
        let _guard = self.life.lock().await;
        self.stop_locked(id, force, must_delete).await
    }

    async fn stop_locked(&self, id: &str, force: bool, must_delete: bool) -> Result<Value, RentError> {
        let Some(mut session) = self.sessions.get(id).map_err(|e| RentError::Unavailable(self.scrubbed(e)))? else {
            return Err(RentError::NotFound);
        };
        if session.phase == Phase::Stopped {
            return Ok(session.public());
        }
        if session.phase == Phase::Failed && session.instance_id.is_empty() {
            return Err(RentError::Bad(if session.error.is_empty() {
                format!("session {} failed", session.id)
            } else {
                format!("session {} failed: {}", session.id, session.error)
            }));
        }
        if session.phase != Phase::Draining {
            session.go(Phase::Draining, self.now(), "drain requested").map_err(RentError::Unavailable)?;
            self.sessions.save(&session).map_err(|e| RentError::Unavailable(self.scrubbed(e)))?;
        }
        if session.instance_id.is_empty() {
            self.finish(&mut session, true, false).await?;
            return Ok(session.public());
        }
        let control = json!({ "action": "drain", "requested_at": self.now().to_rfc3339() });
        let bytes = serde_json::to_vec(&control).map_err(|e| RentError::Unavailable(e.to_string()))?;
        self.objects
            .put(&control_key(&session.id), &bytes)
            .await
            .map_err(|e| RentError::Unavailable(self.scrubbed(e)))?;
        let drained =
            self.wait_marker(&drain_key(&session.id), self.drain_wait).await.map_err(RentError::Unavailable)?;
        if !drained && !force && !must_delete {
            session.error = "drain did not finish; pod left running".to_owned();
            session.note(self.now(), session.error.clone());
            self.sessions.save(&session).map_err(|e| RentError::Unavailable(self.scrubbed(e)))?;
            return Err(RentError::Drain(session.public()));
        }
        self.provider.terminate(&session.instance_id).await.map_err(|e| RentError::Unavailable(self.scrubbed(e)))?;
        let forced = !drained && (force || must_delete);
        self.finish(&mut session, drained, forced).await?;
        Ok(session.public())
    }

    pub async fn sweep(&self) {
        let Ok(sessions) = self.sessions.list() else { return };
        let now = self.now();
        let over_month = self.month_over(&sessions, now);
        for session in sessions {
            if !session.phase.active() {
                continue;
            }
            let expired = now >= session.deadline_at;
            let quiet = matches!(session.phase, Phase::Ready | Phase::Hydrating)
                && now.signed_duration_since(session.last_active) >= TimeDelta::minutes(self.idle_minutes as i64);
            if (expired || quiet || over_month || session.phase == Phase::Draining || session.phase == Phase::Failed)
                && let Err(err) = self.stop(&session.id, true, true).await
            {
                tracing::warn!(session = %session.id, "{}", self.scrubbed(err));
            }
        }
    }

    fn month_over(&self, sessions: &[Session], now: DateTime<Utc>) -> bool {
        let Some(cap) = self.monthly_cap_usd else { return false };
        let spent: f64 = sessions
            .iter()
            .filter(|session| session.created_at.year() == now.year() && session.created_at.month() == now.month())
            .map(|session| session.cost_estimate_usd)
            .filter(|cost| cost.is_finite() && *cost >= 0.0)
            .sum();
        spent > cap
    }

    async fn refresh(&self, session: &mut Session) {
        if !session.phase.active() || session.instance_id.is_empty() {
            return;
        }
        if let Ok(instance) = self.provider.status(&session.instance_id).await {
            session.pod_status = instance.status;
            if !instance.data_center.is_empty() {
                session.data_center = instance.data_center;
            }
            if !instance.endpoints.is_empty() {
                session.endpoints = instance.endpoints;
            }
        }
        if session.phase == Phase::Hydrating && self.objects.exists(&hydrate_ok_key(&session.id)).await.unwrap_or(false)
        {
            let _ = session.go(Phase::Ready, self.now(), "hydrate marker found");
        }
    }

    async fn hydrate(&self, session: &mut Session) -> Result<(), String> {
        let prefix = format!("projects/{}/workspace/", session.project_id);
        let keys = self.objects.list_prefix(&prefix).await.map_err(|e| self.scrubbed(e))?;
        let plan = json!({ "keys": keys, "prefix": prefix });
        let bytes = serde_json::to_vec(&plan).map_err(|e| e.to_string())?;
        self.objects.put(&hydrate_key(&session.id), &bytes).await.map_err(|e| self.scrubbed(e))?;
        if self.wait_marker(&hydrate_ok_key(&session.id), self.hydrate_wait).await? {
            session.go(Phase::Ready, self.now(), "hydrate marker found").map_err(|e| self.scrubbed(e))?;
        }
        Ok(())
    }

    async fn wait_marker(&self, key: &str, wait: Duration) -> Result<bool, String> {
        let deadline = std::time::Instant::now() + wait;
        loop {
            if self.objects.exists(key).await.map_err(|e| self.scrubbed(e))? {
                return Ok(true);
            }
            if std::time::Instant::now() >= deadline {
                return Ok(false);
            }
            tokio::time::sleep(self.drain_poll).await;
        }
    }

    async fn finish(&self, session: &mut Session, drain_ok: bool, forced: bool) -> Result<(), RentError> {
        let now = self.now();
        session.go(Phase::Stopped, now, "terminated").map_err(RentError::Unavailable)?;
        session.drain_ok = drain_ok;
        session.forced = forced;
        session.ended_at = Some(now);
        let elapsed = now.signed_duration_since(session.created_at).num_milliseconds().max(0) as f64 / 3_600_000.0;
        session.cost_actual_usd = session.offer.usd_per_hr * elapsed;
        session.error = if forced { "terminated before drain completed".to_owned() } else { String::new() };
        let receipt = json!({
            "session_id": session.id,
            "project_id": session.project_id,
            "preset_id": session.preset_id,
            "vendor": session.offer.vendor,
            "sku": session.offer.sku,
            "cloud": session.offer.cloud,
            "usd_per_hr": session.offer.usd_per_hr,
            "hours_requested": session.hours,
            "cost_estimate_usd": session.cost_estimate_usd,
            "started_at": session.created_at.to_rfc3339(),
            "ended_at": now.to_rfc3339(),
            "cost_actual_usd": session.cost_actual_usd,
            "cost_basis": "catalog_usd_per_hr_times_elapsed",
            "drain_ok": drain_ok,
            "forced": forced,
            "instance_id": session.instance_id,
        });
        if let Ok(bytes) = serde_json::to_vec_pretty(&receipt)
            && let Err(err) = self.objects.put(&receipt_key(&session.id), &bytes).await
        {
            session.warning = format!("pod terminated but receipt upload failed: {}", self.scrubbed(err));
        }
        self.sessions.save(session).map_err(|e| RentError::Unavailable(self.scrubbed(e)))
    }

    async fn write_project(&self, session: &Session) -> Result<(), String> {
        let doc = json!({
            "id": session.project_id,
            "default_preset_id": session.preset_id,
            "s3": { "bucket": self.bucket, "prefix": format!("projects/{}/", session.project_id) },
        });
        let bytes = serde_json::to_vec_pretty(&doc).map_err(|e| e.to_string())?;
        self.objects
            .put(&format!("projects/{}/.wckd/project.json", session.project_id), &bytes)
            .await
            .map_err(|e| self.scrubbed(e))?;
        let last = json!({ "session_id": session.id });
        let bytes = serde_json::to_vec_pretty(&last).map_err(|e| e.to_string())?;
        self.objects
            .put(&format!("projects/{}/.wckd/last_session.json", session.project_id), &bytes)
            .await
            .map_err(|e| self.scrubbed(e))
    }

    fn provision_request(&self, session: &Session, preset: &Preset, offer: &Offer) -> ProvisionRequest {
        let mut env = preset.env.clone();
        env.insert("INVINCIBLE_SESSION_ID".into(), session.id.clone());
        env.insert("INVINCIBLE_PROJECT_ID".into(), session.project_id.clone());
        env.insert("INVINCIBLE_BUCKET".into(), self.bucket.clone());
        env.insert("INVINCIBLE_ENDPOINT".into(), self.endpoint.clone());
        env.insert("INVINCIBLE_PREFIX".into(), format!("projects/{}/", session.project_id));
        env.insert("AWS_ACCESS_KEY_ID".into(), self.access_key.clone());
        env.insert("AWS_SECRET_ACCESS_KEY".into(), self.secret_key.clone());
        env.insert("AWS_DEFAULT_REGION".into(), "auto".into());
        ProvisionRequest {
            name: format!("invincible-{}", session.id),
            image: preset.image.clone(),
            cloud: offer.cloud.clone(),
            gpu_id: offer.sku.clone(),
            min_ram_gb: preset.min_ram_gb,
            disk_gb: preset.min_disk_gb.max(1),
            ports: preset.ports.clone(),
            env,
            data_center_ids: offer.data_center_ids.clone(),
            entrypoint: preset.entrypoint.clone(),
        }
    }

    async fn ranked(&self, query: &Query) -> Result<Vec<Offer>, RentError> {
        let key = broker::cache_key(query);
        if let Some(hit) = self.cache.lock().await.get(&key) {
            return Ok(hit.to_vec());
        }
        let quotes = self.provider.list_quotes(query).await.map_err(|err| {
            let ProviderError::Vendor(message) = err;
            RentError::Unavailable(self.scrubbed(message))
        })?;
        let offers = broker::rank(&quotes, query);
        self.cache.lock().await.put(key, offers.clone());
        Ok(offers)
    }

    fn preset(&self, id: &str) -> Result<&Preset, RentError> {
        self.presets.get(id).ok_or_else(|| RentError::Bad(format!("unknown preset {id}")))
    }

    fn query(&self, preset: &Preset, regions: &[String]) -> Result<Query, RentError> {
        let (require_regions, require_secure) = broker::parse_require(regions).map_err(RentError::Bad)?;
        Ok(Query {
            min_vram_gb: preset.min_vram_gb,
            gpu_families: preset.gpu_families.clone(),
            reliability: preset.reliability.clone(),
            prefer_regions: preset.prefer_regions.clone(),
            require_regions,
            require_secure,
            workload_class: preset.workload_class.clone(),
        })
    }

    fn check_project(&self, id: &str) -> Result<(), RentError> {
        if !id.is_empty() && id.len() <= 64 && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-') {
            Ok(())
        } else {
            Err(RentError::Bad("project_id is [A-Za-z0-9_-]+, at most 64 characters".to_owned()))
        }
    }
}

fn offer_row(offer: &Offer, hours: f64) -> Value {
    json!({
        "id": offer.id,
        "vendor": offer.vendor,
        "sku": offer.sku,
        "name": offer.name,
        "vram_gb": offer.vram_gb,
        "usd_per_hr": offer.usd_per_hr,
        "cloud": offer.cloud,
        "region": offer.region,
        "data_center_ids": offer.data_center_ids,
        "estimate_usd": offer.usd_per_hr * hours,
        "score": offer.score,
    })
}

fn placement_ok(regions: &[String], data_center: &str) -> bool {
    regions.is_empty() || (!data_center.trim().is_empty() && broker::matches_region(data_center, "", regions))
}

fn control_key(id: &str) -> String {
    format!("sessions/{id}/control.json")
}
fn hydrate_key(id: &str) -> String {
    format!("sessions/{id}/hydrate.json")
}
fn hydrate_ok_key(id: &str) -> String {
    format!("sessions/{id}/hydrate-ok.json")
}
fn drain_key(id: &str) -> String {
    format!("sessions/{id}/drain-ok.json")
}
fn receipt_key(id: &str) -> String {
    format!("sessions/{id}/receipt.json")
}

impl std::fmt::Display for RentError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Bad(message) | Self::NoOffers(message) | Self::Unavailable(message) => f.write_str(message),
            Self::NotFound => f.write_str("no such session"),
            Self::Drain(_) => f.write_str("drain did not finish; pod left running"),
        }
    }
}
