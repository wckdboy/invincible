//! Session engine: quote, provision, hydrate, drain, delete. A quote writes nothing. A stop puts
//! the drain marker and only then deletes the pod. The sweeper does the same for a deadline, for
//! idle, and for a month that has gone over its cap, and it deletes even when the marker never
//! arrives: a pod does not outlive the hours it was paid for.

use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;

use chrono::{DateTime, Datelike, TimeDelta, Utc};
use serde_json::{Value, json};

use super::broker::{self, Cache};
use super::preset::{Catalog, Preset};
use super::provider::{Instance, Offer, Provider, ProviderError, ProvisionRequest, Query};
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
    /// RunPod container-registry credential id. Sent as `registry`. Never logged.
    pub registry_auth: Option<String>,
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
    /// One lock per session. A drain does not block a status read of another session. This
    /// session's status read takes the lock only to re-read and save, after the vendor call.
    session_locks: std::sync::Mutex<HashMap<String, Arc<tokio::sync::Mutex<()>>>>,
    node_id: String,
    registry_auth: Option<String>,
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
    /// The $/hr the owner approved. A confirming create refuses when the offer now costs more.
    pub approved_usd_per_hr: Option<f64>,
}

pub enum RentError {
    Bad(String),
    NoOffers(String),
    NotFound,
    Drain(Value),
    /// The offer moved or got dearer than the approved preview. The value is a fresh 409 body.
    Stale(Value),
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
            session_locks: std::sync::Mutex::new(HashMap::new()),
            node_id: load_node_id(&parts.home)?,
            registry_auth: parts.registry_auth.and_then(|id| {
                let id = id.trim().to_owned();
                (!id.is_empty()).then_some(id)
            }),
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

    fn session_lock(&self, id: &str) -> Arc<tokio::sync::Mutex<()>> {
        self.session_locks
            .lock()
            .unwrap_or_else(|err| err.into_inner())
            .entry(id.to_owned())
            .or_insert_with(|| Arc::new(tokio::sync::Mutex::new(())))
            .clone()
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
        let ranked = self.ranked(&query, false).await?;
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

    /// The 409 preview. No session file, no pod, no object. `fresh` skips the catalog cache so a
    /// confirming call sees the price the owner is about to pay.
    pub async fn preview(&self, ask: &Ask, fresh: bool) -> Result<Value, RentError> {
        self.check_project(&ask.project_id)?;
        let preset = self.preset(&ask.preset_id)?;
        let query = self.query(preset, &ask.regions)?;
        let ranked = self.ranked(&query, fresh).await?;
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

    /// Provisions on a task the caller's timeout cannot cancel. Dropping this future (the HTTP
    /// timeout) leaves that task running: it still persists `instance_id` or terminates the pod.
    pub async fn provision(self: Arc<Self>, ask: Ask) -> Result<Value, RentError> {
        let (tx, rx) = tokio::sync::oneshot::channel();
        let this = Arc::clone(&self);
        tokio::spawn(async move {
            let _ = tx.send(this.provision_body(ask).await);
        });
        match rx.await {
            Ok(result) => result,
            Err(_) => Err(RentError::Unavailable("the rent create stopped before it could report".into())),
        }
    }

    async fn provision_body(&self, ask: Ask) -> Result<Value, RentError> {
        let _guard = self.session_lock(&format!("create-{}", &ask.project_id)).lock_owned().await;
        self.check_project(&ask.project_id)?;
        let preset = self.preset(&ask.preset_id)?.clone();
        let query = self.query(&preset, &ask.regions)?;
        let ranked = self.ranked(&query, true).await?;
        let window = broker::select(&ranked, ask.offer_id.as_deref()).map_err(RentError::NoOffers)?;
        if let Some(approved) = ask.approved_usd_per_hr
            && (cents(window[0].usd_per_hr) > cents(approved)
                || ask.offer_id.as_deref().is_some_and(|id| id != window[0].id))
        {
            return Err(RentError::Stale(preview_body(&ask, &window)));
        }
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
        if let Some(stored) = self.persist(&session).await? {
            return Ok(stored.public());
        }
        if let Err(err) = self.write_project(&session).await {
            session.error = err.clone();
            let _ = session.go(Phase::Failed, self.now(), err.clone());
            if let Some(stored) = self.persist(&session).await? {
                return Ok(stored.public());
            }
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
                        match self.provider.terminate(&instance.id).await {
                            Ok(()) => {}
                            Err(err) => {
                                session.instance_id = instance.id;
                                session.data_center = instance.data_center;
                                session.error = format!("{last} (terminate: {})", self.scrubbed(err));
                                let _ = session.go(Phase::Failed, self.now(), session.error.clone());
                                if let Some(stored) = self.persist(&session).await? {
                                    return Ok(stored.public());
                                }
                                return Err(RentError::Unavailable(session.error.clone()));
                            }
                        }
                        continue;
                    }
                    // Stop can land while the vendor call is in flight and mark the session
                    // draining. Saving this in-memory copy would put it back to hydrating.
                    let created = instance.clone();
                    let mut current = match self.sessions.get(&session.id) {
                        Ok(Some(current)) => current,
                        Ok(None) => {
                            let _ = self.provider.terminate(&instance.id).await;
                            return Err(RentError::Unavailable("the session disappeared during create".into()));
                        }
                        Err(err) => {
                            let _ = self.provider.terminate(&instance.id).await;
                            return Err(RentError::Unavailable(self.scrubbed(err)));
                        }
                    };
                    if matches!(current.phase, Phase::Stopped | Phase::Draining) {
                        return self.discard_after_stop(&mut current, &instance).await;
                    }
                    current.offer = candidate.clone();
                    if instance.cost_per_hour > current.offer.usd_per_hr {
                        current.offer.usd_per_hr = instance.cost_per_hour;
                        current.cost_estimate_usd = instance.cost_per_hour * current.hours;
                    }
                    current.instance_id = instance.id.clone();
                    current.pod_status = instance.status;
                    current.data_center = instance.data_center;
                    current.endpoints = instance.endpoints;
                    current.error.clear();
                    current
                        .go(Phase::Hydrating, self.now(), format!("pod {} created", instance.id))
                        .map_err(RentError::Unavailable)?;
                    match self.persist(&current).await {
                        Ok(Some(mut stored)) => return self.discard_after_stop(&mut stored, &created).await,
                        Ok(None) => {}
                        // The pod exists and the session file did not take it. Delete the pod.
                        Err(err) => return self.abandon(&created.id, err.to_string()).await,
                    }
                    session = current;
                    break;
                }
                Err(err) => {
                    last = self.scrubbed(err);
                    // The vendor can create the pod and then time out before the id comes back.
                    if let Ok(Some(pod_id)) = self.named_pod(&session.id).await {
                        match self.provider.terminate(&pod_id).await {
                            Ok(()) => {}
                            Err(term) => {
                                session.instance_id = pod_id;
                                session.error = format!("{last} (terminate: {})", self.scrubbed(term));
                                let _ = session.go(Phase::Failed, self.now(), session.error.clone());
                                if let Some(stored) = self.persist(&session).await? {
                                    return Ok(stored.public());
                                }
                                return Err(RentError::Unavailable(session.error.clone()));
                            }
                        }
                    }
                }
            }
        }
        if session.instance_id.is_empty() {
            session.error = last.clone();
            let _ = session.go(Phase::Failed, self.now(), last.clone());
            if let Some(stored) = self.persist(&session).await? {
                return Ok(stored.public());
            }
            return Err(RentError::Unavailable(last));
        }
        if let Err(err) = self.hydrate(&mut session).await {
            if let Some(stored) = self.persisted_stop(&session.id).await? {
                return Ok(stored.public());
            }
            session.error = match self.provider.terminate(&session.instance_id).await {
                Ok(()) => {
                    session.instance_id.clear();
                    err.clone()
                }
                Err(term) => format!("{err} (terminate: {})", self.scrubbed(term)),
            };
            let _ = session.go(Phase::Failed, self.now(), session.error.clone());
            if let Some(stored) = self.persist(&session).await? {
                return Ok(stored.public());
            }
            return Err(RentError::Unavailable(session.error.clone()));
        }
        if let Some(stored) = self.persist(&session).await? {
            return Ok(stored.public());
        }
        Ok(session.public())
    }

    /// Save [session] unless a stop already moved it to draining or stopped.
    /// The stored session is returned in that case and nothing is written.
    async fn persist(&self, session: &Session) -> Result<Option<Session>, RentError> {
        let _guard = self.session_lock(&session.id).lock_owned().await;
        if let Some(stored) = self.sessions.get(&session.id).map_err(|e| RentError::Unavailable(self.scrubbed(e)))? {
            let stopping = matches!(stored.phase, Phase::Stopped | Phase::Draining);
            let writing_stop = matches!(session.phase, Phase::Stopped | Phase::Draining);
            if stopping && !writing_stop {
                return Ok(Some(stored));
            }
        }
        self.sessions.save(session).map_err(|e| RentError::Unavailable(self.scrubbed(e)))?;
        Ok(None)
    }

    async fn persisted_stop(&self, id: &str) -> Result<Option<Session>, RentError> {
        let _guard = self.session_lock(id).lock_owned().await;
        let stored = self.sessions.get(id).map_err(|e| RentError::Unavailable(self.scrubbed(e)))?;
        Ok(stored.filter(|session| matches!(session.phase, Phase::Stopped | Phase::Draining)))
    }

    /// A stop won while the vendor was still creating. Follow that stop: a forced stop deletes
    /// the pod now; a plain stop waits for the drain marker and, if it never arrives, stays
    /// draining so the sweeper can delete it. A failed delete is not recorded as stopped.
    async fn discard_after_stop(&self, session: &mut Session, instance: &Instance) -> Result<Value, RentError> {
        let _guard = self.session_lock(&session.id).lock_owned().await;
        if let Ok(Some(latest)) = self.sessions.get(&session.id) {
            *session = latest;
        }
        session.instance_id = instance.id.clone();
        session.pod_status = instance.status.clone();
        session.data_center = instance.data_center.clone();
        session.endpoints = instance.endpoints.clone();
        if session.phase != Phase::Draining && session.phase != Phase::Stopped {
            session.go(Phase::Draining, self.now(), "late pod arrived after stop").map_err(RentError::Unavailable)?;
        }
        let force = session.forced;
        self.sessions.save(session).map_err(|e| RentError::Unavailable(self.scrubbed(e)))?;
        let drained = if force {
            false
        } else {
            let control = json!({ "action": "drain", "requested_at": self.now().to_rfc3339() });
            let bytes = serde_json::to_vec(&control).map_err(|e| RentError::Unavailable(e.to_string()))?;
            match self.objects.put(&control_key(&session.id), &bytes).await {
                Ok(()) => self.wait_marker(&drain_key(&session.id), self.drain_wait).await.unwrap_or(false),
                Err(err) => {
                    tracing::warn!(session = %session.id, "drain before a late pod: {}", self.scrubbed(err));
                    false
                }
            }
        };
        if !force && !drained {
            session.error = "drain did not finish; the pod stays until the sweeper deletes it".into();
            if session.phase == Phase::Stopped {
                session.go(Phase::Draining, self.now(), session.error.clone()).map_err(RentError::Unavailable)?;
            } else {
                session.note(self.now(), session.error.clone());
            }
            self.sessions.save(session).map_err(|e| RentError::Unavailable(self.scrubbed(e)))?;
            return Ok(session.public());
        }
        if let Err(err) = self.provider.terminate(&instance.id).await {
            session.error = format!("stopped during create (terminate: {})", self.scrubbed(err));
            if session.phase == Phase::Stopped {
                session.go(Phase::Draining, self.now(), session.error.clone()).map_err(RentError::Unavailable)?;
            } else if session.phase != Phase::Draining && session.phase != Phase::Failed {
                session.go(Phase::Failed, self.now(), session.error.clone()).map_err(RentError::Unavailable)?;
            } else {
                session.note(self.now(), session.error.clone());
            }
            self.sessions.save(session).map_err(|e| RentError::Unavailable(self.scrubbed(e)))?;
            return Ok(session.public());
        }
        self.finish(session, drained, force && !drained).await?;
        Ok(session.public())
    }

    /// The pod exists and we could not record it. Terminate, and say so if that also fails.
    async fn abandon(&self, instance_id: &str, err: String) -> Result<Value, RentError> {
        match self.provider.terminate(instance_id).await {
            Ok(()) => Err(RentError::Unavailable(format!(
                "the pod was deleted because its session could not be saved: {}",
                self.scrubbed(&err)
            ))),
            Err(term) => Err(RentError::Unavailable(format!(
                "the pod {instance_id} could not be saved ({}) or deleted ({})",
                self.scrubbed(&err),
                self.scrubbed(term)
            ))),
        }
    }

    pub async fn list(&self) -> Result<Value, RentError> {
        let (sessions, warnings) = self.sessions.list().map_err(|e| RentError::Unavailable(self.scrubbed(e)))?;
        for warning in warnings {
            tracing::warn!(target: "rent", "{warning}");
        }
        Ok(json!({ "sessions": sessions.iter().map(Session::public).collect::<Vec<_>>() }))
    }

    pub async fn sessions(&self) -> Result<Vec<Session>, RentError> {
        let (sessions, warnings) = self.sessions.list().map_err(|e| RentError::Unavailable(self.scrubbed(e)))?;
        for warning in warnings {
            tracing::warn!(target: "rent", "{warning}");
        }
        Ok(sessions)
    }

    pub async fn get(&self, id: &str) -> Result<Value, RentError> {
        let Some(mut seen) = self.sessions.get(id).map_err(|e| RentError::Unavailable(self.scrubbed(e)))? else {
            return Err(RentError::NotFound);
        };
        self.refresh(&mut seen).await;
        // A drain holds this lock for up to two minutes. Status must not wait on it.
        let Ok(_guard) = self.session_lock(id).try_lock_owned() else {
            return Ok(seen.public());
        };
        let Some(mut stored) = self.sessions.get(id).map_err(|e| RentError::Unavailable(self.scrubbed(e)))? else {
            return Err(RentError::NotFound);
        };
        if stored.phase == Phase::Stopped {
            return Ok(stored.public());
        }
        stored.pod_status = seen.pod_status;
        stored.endpoints = seen.endpoints;
        stored.data_center = seen.data_center;
        if stored.phase == Phase::Hydrating && seen.phase == Phase::Ready {
            let _ = stored.go(Phase::Ready, self.now(), "hydrate marker found");
        }
        if stored.phase.active() {
            stored.last_active = self.now();
        }
        self.sessions.save(&stored).map_err(|e| RentError::Unavailable(self.scrubbed(e)))?;
        Ok(stored.public())
    }

    /// Drain, then delete. `must_delete` is the sweeper: the pod is removed after the drain
    /// attempt even when the marker never arrives.
    pub async fn stop(&self, id: &str, force: bool, must_delete: bool) -> Result<Value, RentError> {
        let _guard = self.session_lock(id).lock_owned().await;
        self.stop_locked(id, force, must_delete).await
    }

    async fn stop_locked(&self, id: &str, force: bool, must_delete: bool) -> Result<Value, RentError> {
        let Some(mut session) = self.sessions.get(id).map_err(|e| RentError::Unavailable(self.scrubbed(e)))? else {
            return Err(RentError::NotFound);
        };
        if session.phase == Phase::Stopped && !session.instance_id.is_empty() {
            return Ok(session.public());
        }
        let failed = session.phase == Phase::Failed;
        if session.phase != Phase::Draining && session.phase != Phase::Stopped {
            session.go(Phase::Draining, self.now(), "drain requested").map_err(RentError::Unavailable)?;
            self.sessions.save(&session).map_err(|e| RentError::Unavailable(self.scrubbed(e)))?;
        }
        if session.instance_id.is_empty()
            && let Some(pod_id) = self.named_pod(&session.id).await?
        {
            session.instance_id = pod_id;
            self.sessions.save(&session).map_err(|e| RentError::Unavailable(self.scrubbed(e)))?;
        }
        if session.instance_id.is_empty() {
            if failed {
                return Err(RentError::Bad(if session.error.is_empty() {
                    format!("session {} failed", session.id)
                } else {
                    format!("session {} failed: {}", session.id, session.error)
                }));
            }
            if session.phase == Phase::Stopped {
                return Ok(session.public());
            }
            // The vendor call may still return a pod. Stay draining and remember whether
            // that pod may be deleted without a finished drain.
            session.forced = force || must_delete;
            self.sessions.save(&session).map_err(|e| RentError::Unavailable(self.scrubbed(e)))?;
            if must_delete {
                self.finish(&mut session, false, true).await?;
            }
            return Ok(session.public());
        }
        let control = json!({ "action": "drain", "requested_at": self.now().to_rfc3339() });
        let bytes = serde_json::to_vec(&control).map_err(|e| RentError::Unavailable(e.to_string()))?;
        let mut drained = false;
        let mut drain_error = None;
        match self.objects.put(&control_key(&session.id), &bytes).await {
            Ok(()) => match self.wait_marker(&drain_key(&session.id), self.drain_wait).await {
                Ok(ok) => drained = ok,
                Err(err) => drain_error = Some(err),
            },
            Err(err) => drain_error = Some(self.scrubbed(err)),
        }
        if let Some(err) = &drain_error {
            tracing::warn!(session = %session.id, "drain did not start: {err}");
        }
        if !drained && !force && !must_delete {
            let why = drain_error.unwrap_or_else(|| {
                "drain did not finish; the pod is still running. It stays until you stop it again, or until its hours, idle time, or the monthly cap ends it".to_owned()
            });
            session.error = why.clone();
            if session.phase.can_go(Phase::Ready) {
                let _ = session.go(Phase::Ready, self.now(), why);
            } else {
                session.note(self.now(), session.error.clone());
            }
            self.sessions.save(&session).map_err(|e| RentError::Unavailable(self.scrubbed(e)))?;
            return Err(RentError::Drain(session.public()));
        }
        let instance_id = session.instance_id.clone();
        self.provider.terminate(&instance_id).await.map_err(|e| RentError::Unavailable(self.scrubbed(e)))?;
        let forced = !drained && (force || must_delete);
        self.finish(&mut session, drained, forced).await?;
        Ok(session.public())
    }

    pub async fn sweep(&self) {
        let (sessions, warnings) = match self.sessions.list() {
            Ok(listed) => listed,
            Err(err) => {
                tracing::warn!("{}", self.scrubbed(err));
                return;
            }
        };
        for warning in warnings {
            tracing::warn!(target: "rent", "{warning}");
        }
        let now = self.now();
        let over_month = self.month_over(&sessions, now);
        for session in &sessions {
            let orphan = session.phase == Phase::Failed && !session.instance_id.is_empty();
            if !session.phase.active() && !orphan {
                continue;
            }
            if session.phase.active()
                && !session.instance_id.is_empty()
                && let Ok(instance) = self.provider.status(&session.instance_id).await
                && container_stopped(&instance.status)
            {
                if let Err(err) = self.stop(&session.id, true, true).await {
                    tracing::warn!(session = %session.id, "exited pod: {}", self.scrubbed(err));
                }
                continue;
            }
            let expired = now >= session.deadline_at;
            let quiet = matches!(session.phase, Phase::Ready | Phase::Hydrating)
                && now.signed_duration_since(session.last_active) >= TimeDelta::minutes(self.idle_minutes as i64);
            if (expired || quiet || over_month || session.phase == Phase::Draining || orphan)
                && let Err(err) = self.stop(&session.id, true, true).await
            {
                tracing::warn!(session = %session.id, "{}", self.scrubbed(err));
            }
        }
        self.reconcile().await;
    }

    /// Pods named `invincible-<this node's id>-<session>` with no live tracked session are
    /// drained, then deleted. Another node's prefix, and a name that is only `invincible-…`,
    /// are left alone.
    async fn reconcile(&self) {
        let pods = match self.provider.list_pods().await {
            Ok(pods) => pods,
            Err(err) => {
                tracing::warn!("could not list pods to reconcile: {}", self.scrubbed(err));
                return;
            }
        };
        let (sessions, warnings) = match self.sessions.list() {
            Ok(listed) => listed,
            Err(err) => {
                tracing::warn!("could not read sessions to reconcile: {}", self.scrubbed(err));
                return;
            }
        };
        for warning in warnings {
            tracing::warn!(target: "rent", "{warning}");
        }
        let prefix = format!("invincible-{}-", self.node_id);
        for pod in pods {
            let Some(id) = pod.name.strip_prefix(&prefix).filter(|id| !id.is_empty()) else { continue };
            if sessions.iter().any(|session| session.id == id && keeps_pod(session, &pod.id)) {
                continue;
            }
            let _guard = self.session_lock(id).lock_owned().await;
            match self.sessions.get(id) {
                Ok(Some(session)) if keeps_pod(&session, &pod.id) => continue,
                Ok(_) => {}
                Err(err) => {
                    tracing::warn!(
                        session = id,
                        "not terminating; the session file could not be read: {}",
                        self.scrubbed(err)
                    );
                    continue;
                }
            }
            tracing::warn!(pod = %pod.id, session = id, "terminating a pod with no live session");
            let _ = self.objects.put(&control_key(id), br#"{"action":"drain"}"#).await;
            if let Err(err) = self.provider.terminate(&pod.id).await {
                tracing::warn!(pod = %pod.id, "reconcile terminate: {}", self.scrubbed(err));
            }
        }
    }

    async fn named_pod(&self, session_id: &str) -> Result<Option<String>, RentError> {
        let want = format!("invincible-{}-{session_id}", self.node_id);
        let pods = self.provider.list_pods().await.map_err(|e| RentError::Unavailable(self.scrubbed(e)))?;
        Ok(pods.into_iter().find(|pod| pod.name == want).map(|pod| pod.id))
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
        env.insert("INVINCIBLE_ACCESS_KEY_ID".into(), self.access_key.clone());
        env.insert("INVINCIBLE_SECRET_ACCESS_KEY".into(), self.secret_key.clone());
        env.insert("INVINCIBLE_REGION".into(), "auto".into());
        env.insert("AWS_ACCESS_KEY_ID".into(), self.access_key.clone());
        env.insert("AWS_SECRET_ACCESS_KEY".into(), self.secret_key.clone());
        env.insert("AWS_DEFAULT_REGION".into(), "auto".into());
        env.insert("INVINCIBLE_DEADLINE_AT".into(), session.deadline_at.to_rfc3339());
        env.insert("INVINCIBLE_HYDRATE_MAP".into(), format!("projects/{}/workspace|/workspace", session.project_id));
        env.insert("INVINCIBLE_DRAIN_MAP".into(), format!("/workspace|projects/{}/workspace", session.project_id));
        env.insert("INVINCIBLE_DRAIN_EXCLUDES".into(), "**/.cache/**".into());
        if !preset.entrypoint.is_empty() {
            env.insert("INVINCIBLE_WORKLOAD".into(), shell_join(&preset.entrypoint));
        }
        // The image ENTRYPOINT is the sidecar. RunPod's `entrypoint` field would replace it
        // (OpenAPI BaseContainerConfig), so the workload stays in the environment.
        ProvisionRequest {
            name: format!("invincible-{}-{}", self.node_id, session.id),
            image: preset.image.clone(),
            registry: self.registry_auth.clone(),
            cloud: offer.cloud.clone(),
            gpu_id: offer.sku.clone(),
            min_ram_gb: preset.min_ram_gb,
            disk_gb: preset.min_disk_gb.max(1),
            ports: preset.ports.clone(),
            env,
            data_center_ids: offer.data_center_ids.clone(),
            entrypoint: Vec::new(),
        }
    }

    async fn ranked(&self, query: &Query, fresh: bool) -> Result<Vec<Offer>, RentError> {
        let key = broker::cache_key(query);
        if !fresh && let Some(hit) = self.cache.lock().await.get(&key) {
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

fn load_node_id(home: &std::path::Path) -> Result<String, String> {
    let path = home.join("rent/node-id");
    if let Ok(text) = std::fs::read_to_string(&path) {
        let id = text.trim();
        if is_node_id(id) {
            return Ok(id.to_owned());
        }
    }
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("{}: {e}", parent.display()))?;
    }
    let id = crate::token::hex(&crate::token::random::<8>()?);
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create(true).truncate(true);
    #[cfg(unix)]
    std::os::unix::fs::OpenOptionsExt::mode(&mut options, 0o600);
    use std::io::Write;
    let mut file = options.open(&path).map_err(|e| format!("{}: {e}", path.display()))?;
    writeln!(file, "{id}").map_err(|e| format!("{}: {e}", path.display()))?;
    Ok(id)
}

fn is_node_id(id: &str) -> bool {
    (8..=64).contains(&id.len()) && id.chars().all(|c| c.is_ascii_hexdigit())
}

/// Only a create still in `provisioning` protects a pod whose id was not saved yet.
/// A stopped or failed session with an empty id does not: that pod would bill forever.
fn keeps_pod(session: &Session, pod_id: &str) -> bool {
    if session.phase == Phase::Provisioning {
        return true;
    }
    session.instance_id == pod_id && (session.phase.active() || session.phase == Phase::Failed)
}

fn container_stopped(status: &str) -> bool {
    matches!(status.to_ascii_uppercase().as_str(), "EXITED" | "STOPPED" | "DEAD" | "TERMINATED")
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

fn preview_body(ask: &Ask, window: &[Offer]) -> Value {
    let first = &window[0];
    json!({
        "error": {
            "code": "confirmation_required",
            "message": "the offer changed since it was approved; send again with `invincible-confirmed: 1`",
        },
        "project_id": ask.project_id,
        "preset_id": ask.preset_id,
        "hours": ask.hours,
        "cost_basis": "catalog_usd_per_hr_times_hours",
        "cost_estimate_usd": first.usd_per_hr * ask.hours,
        "require_regions": ask.regions,
        "offer": offer_row(first, ask.hours),
        "failover": window.iter().map(|offer| offer_row(offer, ask.hours)).collect::<Vec<_>>(),
    })
}

fn cents(usd: f64) -> i64 {
    if !usd.is_finite() { i64::MAX } else { (usd * 100.0).round() as i64 }
}

fn shell_join(args: &[String]) -> String {
    args.iter().map(|arg| shell_quote(arg)).collect::<Vec<_>>().join(" ")
}

fn shell_quote(arg: &str) -> String {
    if arg.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.' | '/' | ':' | '=')) {
        arg.to_owned()
    } else {
        format!("'{}'", arg.replace('\'', "'\\''"))
    }
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
            Self::Drain(_) => f.write_str(
                "drain did not finish; the pod is still running until its hours, idle time, or the monthly cap",
            ),
            Self::Stale(_) => f.write_str("the offer changed since it was approved"),
        }
    }
}

#[cfg(all(test, unix))]
mod tests {
    use std::sync::{Arc, Mutex};

    use super::*;
    use crate::rent::provider::{DataCenter, Instance, PodRef, Quote};
    use crate::rent::sync::StoreFut;

    struct Fake {
        state: std::path::PathBuf,
        events: Arc<Mutex<Vec<String>>>,
        freeze: bool,
        ghost: bool,
        fail_deletes: Arc<std::sync::atomic::AtomicU32>,
        pods: Arc<Mutex<Vec<PodRef>>>,
    }

    impl Provider for Fake {
        fn list_quotes<'a>(&'a self, _query: &'a Query) -> super::super::provider::ProviderFut<'a, Vec<Quote>> {
            Box::pin(async {
                Ok(vec![Quote {
                    gpu_id: "NVIDIA GeForce RTX 4090".into(),
                    name: "RTX 4090".into(),
                    vram_gb: 24,
                    cloud: "secure".into(),
                    usd_per_hour: 0.5,
                    availability: "HIGH".into(),
                    data_centers: vec![DataCenter {
                        id: "EU-RO-1".into(),
                        name: "EU Romania".into(),
                        availability: "HIGH".into(),
                    }],
                }])
            })
        }

        fn provision<'a>(&'a self, request: &'a ProvisionRequest) -> super::super::provider::ProviderFut<'a, Instance> {
            let state = self.state.clone();
            let events = Arc::clone(&self.events);
            let pods = Arc::clone(&self.pods);
            let freeze = self.freeze;
            let ghost = self.ghost;
            let name = request.name.clone();
            Box::pin(async move {
                if ghost {
                    pods.lock().unwrap().push(PodRef { id: "pod-ghost".into(), name });
                    events.lock().unwrap().push("create-timeout".into());
                    return Err(crate::rent::provider::ProviderError::Vendor("timed out".into()));
                }
                if freeze {
                    let mut perms = std::fs::metadata(&state).unwrap().permissions();
                    std::os::unix::fs::PermissionsExt::set_mode(&mut perms, 0o555);
                    std::fs::set_permissions(&state, perms).unwrap();
                }
                events.lock().unwrap().push("create".into());
                Ok(Instance {
                    id: "pod-crash".into(),
                    status: "RUNNING".into(),
                    cost_per_hour: 0.5,
                    data_center: "EU-RO-1".into(),
                    ..Instance::default()
                })
            })
        }

        fn status<'a>(&'a self, id: &'a str) -> super::super::provider::ProviderFut<'a, Instance> {
            let id = id.to_owned();
            Box::pin(async move { Ok(Instance { id, status: "RUNNING".into(), ..Instance::default() }) })
        }

        fn terminate<'a>(&'a self, id: &'a str) -> super::super::provider::ProviderFut<'a, ()> {
            let events = Arc::clone(&self.events);
            let fail_deletes = Arc::clone(&self.fail_deletes);
            let id = id.to_owned();
            Box::pin(async move {
                if fail_deletes.load(std::sync::atomic::Ordering::SeqCst) > 0 {
                    fail_deletes.fetch_sub(1, std::sync::atomic::Ordering::SeqCst);
                    events.lock().unwrap().push(format!("terminate-fail:{id}"));
                    return Err(crate::rent::provider::ProviderError::Vendor("runpod api status 409: conflict".into()));
                }
                events.lock().unwrap().push(format!("terminate:{id}"));
                Ok(())
            })
        }

        fn list_pods<'a>(&'a self) -> super::super::provider::ProviderFut<'a, Vec<PodRef>> {
            let pods = Arc::clone(&self.pods);
            Box::pin(async move { Ok(pods.lock().unwrap().clone()) })
        }
    }

    struct Mem {
        events: Arc<Mutex<Vec<String>>>,
        fail: bool,
    }

    impl ObjectStore for Mem {
        fn put<'a>(&'a self, key: &'a str, _body: &'a [u8]) -> StoreFut<'a, ()> {
            let events = Arc::clone(&self.events);
            let key = key.to_owned();
            let fail = self.fail;
            Box::pin(async move {
                if fail {
                    return Err("store down".to_owned());
                }
                events.lock().unwrap().push(format!("put:{key}"));
                Ok(())
            })
        }

        fn exists<'a>(&'a self, _key: &'a str) -> StoreFut<'a, bool> {
            let fail = self.fail;
            Box::pin(async move { if fail { Err("store down".to_owned()) } else { Ok(false) } })
        }

        fn list_prefix<'a>(&'a self, _prefix: &'a str) -> StoreFut<'a, Vec<String>> {
            Box::pin(async { Ok(Vec::new()) })
        }
    }

    struct Home {
        path: std::path::PathBuf,
        state: std::path::PathBuf,
    }

    impl Drop for Home {
        fn drop(&mut self) {
            if let Ok(meta) = std::fs::metadata(&self.state) {
                let mut perms = meta.permissions();
                std::os::unix::fs::PermissionsExt::set_mode(&mut perms, 0o755);
                let _ = std::fs::set_permissions(&self.state, perms);
            }
            let _ = std::fs::remove_dir_all(&self.path);
        }
    }

    struct Opened {
        engine: Arc<Engine>,
        events: Arc<Mutex<Vec<String>>>,
        home: Home,
        node: String,
        pods: Arc<Mutex<Vec<PodRef>>>,
        fail_deletes: Arc<std::sync::atomic::AtomicU32>,
    }

    fn engine(label: &str, freeze: bool, fail_store: bool) -> Opened {
        open_engine(label, freeze, fail_store, false)
    }

    fn open_engine(label: &str, freeze: bool, fail_store: bool, ghost: bool) -> Opened {
        let path = std::env::temp_dir().join(format!("invincible-rent-engine-{}-{label}", std::process::id()));
        let _ = std::fs::remove_dir_all(&path);
        let node = super::load_node_id(&path).unwrap();
        let state = path.join("rent/state");
        let events = Arc::new(Mutex::new(Vec::new()));
        let pods = Arc::new(Mutex::new(Vec::new()));
        let fail_deletes = Arc::new(std::sync::atomic::AtomicU32::new(0));
        let mut engine = Engine::open(Open {
            provider: Arc::new(Fake {
                state: state.clone(),
                events: Arc::clone(&events),
                freeze,
                ghost,
                fail_deletes: Arc::clone(&fail_deletes),
                pods: Arc::clone(&pods),
            }),
            objects: Arc::new(Mem { events: Arc::clone(&events), fail: fail_store }),
            home: path.clone(),
            secrets: Vec::new(),
            bucket: "rent".into(),
            endpoint: "http://127.0.0.1:9".into(),
            access_key: "access".into(),
            secret_key: "secret".into(),
            idle_minutes: 15,
            monthly_cap_usd: None,
            registry_auth: None,
        })
        .unwrap();
        engine.drain_wait = std::time::Duration::from_millis(30);
        engine.drain_poll = std::time::Duration::from_millis(5);
        Opened { engine: Arc::new(engine), events, home: Home { path, state }, node, pods, fail_deletes }
    }

    fn sample(id: &str, phase: crate::rent::session::Phase, instance: &str) -> crate::rent::session::Session {
        let now = chrono::Utc::now();
        crate::rent::session::Session {
            id: id.to_owned(),
            project_id: "hailuo".into(),
            preset_id: "vllm".into(),
            hours: 1.0,
            created_at: now,
            deadline_at: now + chrono::TimeDelta::hours(2),
            last_active: now,
            phase,
            offer: crate::rent::provider::Offer {
                id: "runpod:secure:4090".into(),
                vendor: "runpod".into(),
                sku: "NVIDIA GeForce RTX 4090".into(),
                name: "RTX 4090".into(),
                family: "4090".into(),
                vram_gb: 24,
                usd_per_hr: 0.5,
                cloud: "secure".into(),
                region: "EU-RO-1".into(),
                data_center_ids: vec!["EU-RO-1".into()],
                availability: "HIGH".into(),
                perf_index: 48.0,
                perf_table: "2026-09-29".into(),
                reliability_factor: 1.0,
                region_factor: 1.0,
                score: 96.0,
            },
            instance_id: instance.to_owned(),
            pod_status: String::new(),
            data_center: String::new(),
            endpoints: Vec::new(),
            cost_estimate_usd: 0.5,
            cost_actual_usd: 0.0,
            drain_ok: false,
            forced: false,
            error: String::new(),
            warning: String::new(),
            events: Vec::new(),
            ended_at: None,
        }
    }

    fn write_session(state: &std::path::Path, session: &crate::rent::session::Session) {
        std::fs::create_dir_all(state).unwrap();
        let path = state.join(format!("{}.json", session.id));
        std::fs::write(path, serde_json::to_vec_pretty(session).unwrap()).unwrap();
    }

    #[tokio::test]
    async fn a_save_failure_after_create_terminates_the_pod() {
        let Opened { engine, events, home: _home, .. } = engine("save", true, false);
        let err = engine
            .provision(Ask {
                project_id: "hailuo".into(),
                preset_id: "comfyui-minimax-h3".into(),
                hours: 1.0,
                offer_id: None,
                regions: vec!["EU-secure".into()],
                approved_usd_per_hr: None,
            })
            .await
            .unwrap_err();
        let text = err.to_string();
        assert!(text.contains("could not be saved") || text.contains("deleted"), "{text}");
        let events = events.lock().unwrap().clone();
        assert!(events.iter().any(|line| line == "create"), "{events:?}");
        assert!(events.iter().any(|line| line == "terminate:pod-crash"), "{events:?}");
    }

    #[tokio::test]
    async fn a_sweep_terminates_only_this_nodes_untracked_pod() {
        let Opened { engine, events, home: _home, node, pods, .. } = engine("scope", false, false);
        pods.lock().unwrap().extend([
            PodRef { id: "pod-orphan".into(), name: format!("invincible-{node}-sess_gone") },
            PodRef { id: "pod-other".into(), name: "invincible-0123456789abcdef-sess_other".into() },
            PodRef { id: "pod-hand".into(), name: "invincible-foo".into() },
        ]);
        engine.sweep().await;
        let events = events.lock().unwrap().clone();
        assert!(events.iter().any(|line| line == "terminate:pod-orphan"), "{events:?}");
        assert!(!events.iter().any(|line| line.contains("pod-other") || line.contains("pod-hand")), "{events:?}");
    }

    #[tokio::test]
    async fn a_create_in_flight_is_not_reconciled_away() {
        let Opened { engine, events, home, node, pods, .. } = engine("race", false, false);
        pods.lock().unwrap().push(PodRef { id: "pod-fresh".into(), name: format!("invincible-{node}-sess_fresh") });
        write_session(&home.state, &sample("sess_fresh", crate::rent::session::Phase::Provisioning, ""));
        engine.sweep().await;
        let events = events.lock().unwrap().clone();
        assert!(!events.iter().any(|line| line.contains("pod-fresh")), "{events:?}");
    }

    #[tokio::test]
    async fn a_failed_session_is_swept_and_a_corrupt_file_is_skipped() {
        let Opened { engine, events, home, .. } = engine("failed", false, false);
        write_session(&home.state, &sample("sess_bad", crate::rent::session::Phase::Failed, "pod-failed"));
        std::fs::write(home.state.join("corrupt.json"), b"not json").unwrap();
        engine.sweep().await;
        let events = events.lock().unwrap().clone();
        assert!(events.iter().any(|line| line == "terminate:pod-failed"), "{events:?}");
    }

    #[tokio::test]
    async fn a_failing_store_still_lets_a_forced_stop_terminate() {
        let Opened { engine, events, home, .. } = engine("store", false, true);
        write_session(&home.state, &sample("sess_up", crate::rent::session::Phase::Ready, "pod-up"));
        engine.stop("sess_up", true, true).await.unwrap_or_else(|err| panic!("force stop deletes the pod: {err}"));
        let events = events.lock().unwrap().clone();
        assert!(events.iter().any(|line| line == "terminate:pod-up"), "{events:?}");
    }

    #[tokio::test]
    async fn an_empty_id_on_a_stopped_or_failed_session_does_not_keep_the_pod() {
        let Opened { engine, events, home, node, pods, .. } = engine("empty", false, false);
        write_session(&home.state, &sample("sess_stopped", crate::rent::session::Phase::Stopped, ""));
        write_session(&home.state, &sample("sess_failed", crate::rent::session::Phase::Failed, ""));
        pods.lock().unwrap().extend([
            PodRef { id: "pod-stopped".into(), name: format!("invincible-{node}-sess_stopped") },
            PodRef { id: "pod-failed-empty".into(), name: format!("invincible-{node}-sess_failed") },
        ]);
        engine.stop("sess_failed", true, true).await.unwrap_or_else(|err| panic!("failed session: {err}"));
        engine.sweep().await;
        let events = events.lock().unwrap().clone();
        assert!(events.iter().any(|line| line == "terminate:pod-stopped"), "{events:?}");
        assert!(events.iter().any(|line| line == "terminate:pod-failed-empty"), "{events:?}");
    }

    #[tokio::test]
    async fn a_provisioning_session_past_its_deadline_loses_its_unnamed_pod() {
        let Opened { engine, events, home, node, pods, .. } = engine("deadline", false, false);
        let mut session = sample("sess_late", crate::rent::session::Phase::Provisioning, "");
        session.deadline_at = chrono::Utc::now() - chrono::TimeDelta::minutes(1);
        write_session(&home.state, &session);
        pods.lock().unwrap().push(PodRef { id: "pod-late".into(), name: format!("invincible-{node}-sess_late") });
        engine.sweep().await;
        let events = events.lock().unwrap().clone();
        assert!(events.iter().any(|line| line == "terminate:pod-late"), "{events:?}");
    }

    #[tokio::test]
    async fn a_create_timeout_after_the_pod_exists_does_not_leave_it_untracked() {
        let Opened { engine, events, home, .. } = open_engine("ghost", false, false, true);
        let err = engine
            .provision(Ask {
                project_id: "hailuo".into(),
                preset_id: "comfyui-minimax-h3".into(),
                hours: 1.0,
                offer_id: None,
                regions: vec!["EU-secure".into()],
                approved_usd_per_hr: None,
            })
            .await
            .unwrap_err();
        let events = events.lock().unwrap().clone();
        let terminated = events.iter().any(|line| line == "terminate:pod-ghost");
        let tracked = std::fs::read_dir(&home.state)
            .unwrap()
            .flatten()
            .any(|entry| std::fs::read_to_string(entry.path()).unwrap_or_default().contains("pod-ghost"));
        assert!(terminated || tracked, "{err}\n{events:?}");
    }

    fn read_session(state: &std::path::Path, id: &str) -> crate::rent::session::Session {
        let text = std::fs::read_to_string(state.join(format!("{id}.json"))).unwrap();
        serde_json::from_str(&text).unwrap()
    }

    #[tokio::test]
    async fn a_plain_stop_leaves_a_late_pod_draining_until_the_marker() {
        let Opened { engine, events, home, .. } = engine("plain-late", false, false);
        write_session(&home.state, &sample("sess_plain", crate::rent::session::Phase::Provisioning, ""));
        let stopped = engine.stop("sess_plain", false, false).await.unwrap_or_else(|err| panic!("{err}"));
        assert_eq!(stopped["phase"], "draining", "{stopped}");
        let mut current = read_session(&home.state, "sess_plain");
        let instance = Instance { id: "pod-plain".into(), status: "RUNNING".into(), ..Instance::default() };
        let out = engine.discard_after_stop(&mut current, &instance).await.unwrap_or_else(|err| panic!("{err}"));
        assert_eq!(out["phase"], "draining", "{out}");
        assert_eq!(out["instance_id"], "pod-plain");
        let events = events.lock().unwrap().clone();
        assert!(!events.iter().any(|line| line.starts_with("terminate:")), "{events:?}");
    }

    #[tokio::test]
    async fn a_forced_stop_deletes_a_late_pod_and_a_failed_delete_stays_open() {
        let Opened { engine, events, home, fail_deletes, .. } = engine("force-late", false, false);
        write_session(&home.state, &sample("sess_force", crate::rent::session::Phase::Provisioning, ""));
        let stopped = engine.stop("sess_force", true, false).await.unwrap_or_else(|err| panic!("{err}"));
        assert_eq!(stopped["phase"], "draining", "{stopped}");
        assert_eq!(stopped["forced"], true, "{stopped}");
        fail_deletes.store(1, std::sync::atomic::Ordering::SeqCst);
        let mut current = read_session(&home.state, "sess_force");
        let instance = Instance { id: "pod-force".into(), status: "RUNNING".into(), ..Instance::default() };
        let out = engine.discard_after_stop(&mut current, &instance).await.unwrap_or_else(|err| panic!("{err}"));
        assert_ne!(out["phase"], "stopped", "{out}");
        assert_eq!(out["instance_id"], "pod-force");
        let again = engine.stop("sess_force", true, false).await.unwrap_or_else(|err| panic!("{err}"));
        assert_eq!(again["phase"], "stopped", "{again}");
        assert!(again["cost_actual_usd"].as_f64().is_some(), "{again}");
        let events = events.lock().unwrap().clone();
        assert!(events.iter().any(|line| line == "terminate-fail:pod-force"), "{events:?}");
        assert!(events.iter().any(|line| line == "terminate:pod-force"), "{events:?}");
    }
}
