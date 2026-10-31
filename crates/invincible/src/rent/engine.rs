//! Session engine: quote, provision, hydrate, drain, delete. A quote writes nothing. A stop puts
//! the drain marker and only then deletes the pod. The sweeper does the same for a deadline, for
//! idle, and for a month that has gone over its cap, and it deletes even when the marker never
//! arrives: a pod does not outlive the hours it was paid for.

use std::collections::{HashMap, HashSet};
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
/// Longer than any create stays in `provisioning` (three offers, each bounded by the vendor's
/// timeouts). A younger session with no saved pod may still be created by another node process
/// on the same home, so only an older one counts as abandoned.
const CREATE_GRACE: Duration = Duration::from_secs(30 * 60);

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
    /// Sessions whose create is still running. A stop that lands before their pod id exists is
    /// settled by that create: the sweeper does not finish it, and reconcile keeps its pod.
    creating: std::sync::Mutex<HashSet<String>>,
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
            creating: std::sync::Mutex::new(HashSet::new()),
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

    /// True while this session's create is still running in this process.
    fn creating(&self, id: &str) -> bool {
        self.creating.lock().unwrap_or_else(|err| err.into_inner()).contains(id)
    }

    /// A create may still be running for this session and has not saved its pod: here, or (while
    /// the session is younger than [CREATE_GRACE]) in another node process on the same home.
    fn in_flight(&self, session: &Session) -> bool {
        let young =
            self.now().signed_duration_since(session.created_at) < TimeDelta::seconds(CREATE_GRACE.as_secs() as i64);
        session.instance_id.is_empty()
            && (self.creating(&session.id) || (young && matches!(session.phase, Phase::Provisioning | Phase::Draining)))
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
        let _creating = Creating::new(&self.creating, &id);
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
            let _ = session.go(Phase::Failed, self.now(), err);
            return self.fail(&session).await;
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
                                return self.fail(&session).await;
                            }
                        }
                        continue;
                    }
                    // A stop can land while the vendor call is in flight. persist() re-reads under
                    // the session lock and hands back that stop instead of saving `hydrating`.
                    adopt(&mut session, candidate, &instance);
                    session.error.clear();
                    if let Err(err) = session.go(Phase::Hydrating, self.now(), format!("pod {} created", instance.id)) {
                        return self.abandon(&instance.id, err).await;
                    }
                    match self.persist(&session).await {
                        Ok(Some(mut stored)) => {
                            return self.discard_after_stop(&mut stored, &instance, candidate).await;
                        }
                        Ok(None) => {}
                        // The pod exists and the session file did not take it. Delete the pod.
                        Err(err) => return self.abandon(&instance.id, err.to_string()).await,
                    }
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
                                return self.fail(&session).await;
                            }
                        }
                    }
                }
            }
        }
        if session.instance_id.is_empty() {
            session.error = last.clone();
            let _ = session.go(Phase::Failed, self.now(), last);
            return self.fail(&session).await;
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

    /// The create failed with no pod running for it, or with one it could not delete
    /// (`session.instance_id`). The caller gets the create's error either way: nothing started.
    /// When a stop already moved the session to draining or stopped, that stop is settled here
    /// instead of being overwritten: a pod that could not be deleted goes on the session so the
    /// next stop and the sweeper retry, and a stop that was waiting for a pod is finished.
    async fn fail(&self, session: &Session) -> Result<Value, RentError> {
        // A pod that could not be deleted is named in the error whenever it cannot be recorded.
        let unrecorded = |why: String| {
            let why = self.scrubbed(why);
            RentError::Unavailable(if session.instance_id.is_empty() {
                format!("{} ({why})", session.error)
            } else {
                format!("{}; the pod {} could not be recorded: {why}", session.error, session.instance_id)
            })
        };
        let _guard = self.session_lock(&session.id).lock_owned().await;
        let stored = self.sessions.get(&session.id).map_err(&unrecorded)?;
        let Some(mut stored) = stored.filter(|s| matches!(s.phase, Phase::Stopped | Phase::Draining)) else {
            self.sessions.save(session).map_err(&unrecorded)?;
            return Err(RentError::Unavailable(session.error.clone()));
        };
        let now = self.now();
        if stored.phase == Phase::Stopped && !stored.instance_id.is_empty() && stored.instance_id == session.instance_id
        {
            // A stop found this pod by its name and deleted it after the create's own delete failed.
        } else if !session.instance_id.is_empty() {
            stored.instance_id = session.instance_id.clone();
            stored.data_center = session.data_center.clone();
            stored.error = session.error.clone();
            if stored.phase == Phase::Stopped {
                reopen(&mut stored, now, session.error.clone());
            } else {
                stored.note(now, session.error.clone());
            }
            self.sessions.save(&stored).map_err(&unrecorded)?;
        } else if stored.phase == Phase::Draining && stored.instance_id.is_empty() {
            // No pod came and none will. Nothing ran: nothing to drain and nothing to charge.
            let forced = stored.forced;
            let why = format!("the create failed before a pod existed: {}", session.error);
            self.close(&mut stored, true, forced, Some(why)).await?;
        }
        Err(RentError::Unavailable(session.error.clone()))
    }

    /// A stop won while the vendor was still creating. Follow that stop: a forced stop deletes
    /// the pod now; a plain stop waits for the drain marker and, if it never arrives, stays
    /// draining so the sweeper can delete it. A failed delete is not recorded as stopped.
    async fn discard_after_stop(
        &self,
        session: &mut Session,
        instance: &Instance,
        candidate: &Offer,
    ) -> Result<Value, RentError> {
        let _guard = self.session_lock(&session.id).lock_owned().await;
        if let Ok(Some(latest)) = self.sessions.get(&session.id) {
            *session = latest;
        }
        // A stop that found this pod by its name has already deleted it. Its record still takes
        // the offer and price the pod was made at.
        if session.phase == Phase::Stopped && session.instance_id == instance.id {
            adopt(session, candidate, instance);
            if let Some(ended_at) = session.ended_at {
                session.cost_actual_usd = elapsed_cost(session, ended_at);
            }
            self.put_receipt(session, true).await;
            self.sessions.save(session).map_err(|e| RentError::Unavailable(self.scrubbed(e)))?;
            return Ok(session.public());
        }
        // The pod that bills is the one the vendor made, at the vendor's price.
        adopt(session, candidate, instance);
        if session.phase == Phase::Stopped {
            reopen(session, self.now(), "late pod arrived after stop");
        } else if session.phase != Phase::Draining {
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
            session.note(self.now(), session.error.clone());
            self.sessions.save(session).map_err(|e| RentError::Unavailable(self.scrubbed(e)))?;
            return Ok(session.public());
        }
        if let Err(err) = self.provider.terminate(&instance.id).await {
            // Still draining with the instance id: another stop and the sweeper retry the delete.
            session.error = format!("stopped during create (terminate: {})", self.scrubbed(err));
            session.note(self.now(), session.error.clone());
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
        // A forced stop that is still under way stays forced, whatever a later stop asks.
        let force = force || (session.phase == Phase::Draining && session.forced);
        let failed = session.phase == Phase::Failed;
        let mut changed = false;
        if session.phase != Phase::Draining && session.phase != Phase::Stopped {
            session.go(Phase::Draining, self.now(), "drain requested").map_err(RentError::Unavailable)?;
            changed = true;
        }
        // Remember a force on disk, so a failed delete leaves it for the next stop and the sweeper.
        if (force || must_delete) && session.phase == Phase::Draining && !session.forced {
            session.forced = true;
            changed = true;
        }
        if changed {
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
            // The vendor call may still return a pod. Stay draining and remember whether that
            // pod may be deleted without a finished drain (`force` already keeps an earlier force).
            session.forced = force || must_delete;
            self.sessions.save(&session).map_err(|e| RentError::Unavailable(self.scrubbed(e)))?;
            // While the create runs it settles this stop, whether a pod comes or not. Otherwise no
            // pod exists under the session's name: none ran, so nothing is charged.
            if must_delete && !self.in_flight(&session) {
                let forced = session.forced;
                self.close(&mut session, true, forced, Some("no pod exists under the session's name".into())).await?;
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

    /// Stop a create that no longer runs, after checking again under the session lock: the list
    /// the sweeper read can be older than a create that just finished.
    async fn stop_abandoned(&self, id: &str) -> Result<(), RentError> {
        let _guard = self.session_lock(id).lock_owned().await;
        let stored = self.sessions.get(id).map_err(|e| RentError::Unavailable(self.scrubbed(e)))?;
        if stored.is_some_and(|session| session.phase == Phase::Provisioning && !self.in_flight(&session)) {
            tracing::warn!(session = id, "stopping a create the node did not finish");
            self.stop_locked(id, true, true).await?;
        }
        Ok(())
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
            // A stop that landed before the pod id existed is the create's to settle. Forcing it
            // here would turn a plain stop into a forced one.
            let stuck = session.phase == Phase::Draining && !self.in_flight(session);
            if (expired || quiet || over_month || stuck || orphan)
                && let Err(err) = self.stop(&session.id, true, true).await
            {
                tracing::warn!(session = %session.id, "{}", self.scrubbed(err));
                continue;
            }
            // Provisioning with no create running: the node stopped mid-create. Its pod, if the
            // vendor made one, bills until it is found by its name and deleted.
            if session.phase == Phase::Provisioning
                && !self.in_flight(session)
                && let Err(err) = self.stop_abandoned(&session.id).await
            {
                tracing::warn!(session = %session.id, "abandoned create: {}", self.scrubbed(err));
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
            // A create still running settles its own pod, a stop that landed meanwhile included.
            if sessions.iter().any(|session| session.id == id && keeps_pod(session, &pod.id, self.in_flight(session))) {
                continue;
            }
            let _guard = self.session_lock(id).lock_owned().await;
            match self.sessions.get(id) {
                Ok(Some(session)) if keeps_pod(&session, &pod.id, self.in_flight(&session)) => continue,
                Ok(None) if self.creating(id) => continue,
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
        self.close(session, drain_ok, forced, None).await
    }

    /// Record the stop and its receipt. `no_pod` says why the session ended without a pod ever
    /// running: nothing is charged for it.
    async fn close(
        &self,
        session: &mut Session,
        drain_ok: bool,
        forced: bool,
        no_pod: Option<String>,
    ) -> Result<(), RentError> {
        let now = self.now();
        session.go(Phase::Stopped, now, "terminated").map_err(RentError::Unavailable)?;
        session.drain_ok = drain_ok;
        session.forced = forced;
        session.ended_at = Some(now);
        let ran = no_pod.is_none();
        session.cost_actual_usd = if ran { elapsed_cost(session, now) } else { 0.0 };
        session.error = match no_pod {
            Some(why) => why,
            None if forced => "terminated before drain completed".to_owned(),
            None => String::new(),
        };
        self.put_receipt(session, ran).await;
        self.sessions.save(session).map_err(|e| RentError::Unavailable(self.scrubbed(e)))
    }

    /// Write `sessions/<id>/receipt.json` from what the stopped session records. `ran` is false
    /// when no pod ever ran for it.
    async fn put_receipt(&self, session: &mut Session, ran: bool) {
        let ended_at = session.ended_at.unwrap_or_else(|| self.now());
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
            "ended_at": ended_at.to_rfc3339(),
            "cost_actual_usd": session.cost_actual_usd,
            "cost_basis": if ran { "catalog_usd_per_hr_times_elapsed" } else { "no_pod" },
            "drain_ok": session.drain_ok,
            "forced": session.forced,
            "instance_id": session.instance_id,
        });
        if let Ok(bytes) = serde_json::to_vec_pretty(&receipt)
            && let Err(err) = self.objects.put(&receipt_key(&session.id), &bytes).await
        {
            session.warning = format!("pod terminated but receipt upload failed: {}", self.scrubbed(err));
        }
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

/// Record the pod the vendor made: the offer it was made from, the vendor's price when that is
/// higher than the quote, and where it runs.
fn adopt(session: &mut Session, candidate: &Offer, instance: &Instance) {
    session.offer = candidate.clone();
    session.cost_estimate_usd = candidate.usd_per_hr * session.hours;
    if instance.cost_per_hour > session.offer.usd_per_hr {
        session.offer.usd_per_hr = instance.cost_per_hour;
        session.cost_estimate_usd = instance.cost_per_hour * session.hours;
    }
    session.instance_id = instance.id.clone();
    session.pod_status = instance.status.clone();
    session.data_center = instance.data_center.clone();
    session.endpoints = instance.endpoints.clone();
}

/// Catalog (or vendor) $/hr times the time from create to `end`.
fn elapsed_cost(session: &Session, end: DateTime<Utc>) -> f64 {
    let hours = end.signed_duration_since(session.created_at).num_milliseconds().max(0) as f64 / 3_600_000.0;
    session.offer.usd_per_hr * hours
}

/// A stop finished before its pod existed, and that pod has to be deleted after all. The session
/// is not over: clear what [Engine::finish] recorded until a delete succeeds.
fn reopen(session: &mut Session, now: DateTime<Utc>, why: impl Into<String>) {
    let _ = session.go(Phase::Draining, now, why);
    session.ended_at = None;
    session.cost_actual_usd = 0.0;
    session.drain_ok = false;
}

/// Marks a session as being created for as long as this value lives.
struct Creating<'a> {
    set: &'a std::sync::Mutex<HashSet<String>>,
    id: String,
}

impl<'a> Creating<'a> {
    fn new(set: &'a std::sync::Mutex<HashSet<String>>, id: &str) -> Self {
        set.lock().unwrap_or_else(|err| err.into_inner()).insert(id.to_owned());
        Self { set, id: id.to_owned() }
    }
}

impl Drop for Creating<'_> {
    fn drop(&mut self) {
        self.set.lock().unwrap_or_else(|err| err.into_inner()).remove(&self.id);
    }
}

/// Only a create that may still be running ([Engine::in_flight]) protects a pod whose id was not
/// saved yet; it settles a stop that landed meanwhile too. An abandoned `provisioning` session (the
/// node stopped mid-create), or a stopped or failed session with an empty id, does not: that pod
/// would bill.
fn keeps_pod(session: &Session, pod_id: &str, in_flight: bool) -> bool {
    if in_flight {
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
        /// Hold each create until notified, the way a slow vendor call does.
        hold: Option<Arc<tokio::sync::Notify>>,
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
            let hold = self.hold.clone();
            let name = request.name.clone();
            Box::pin(async move {
                if let Some(hold) = hold {
                    events.lock().unwrap().push("create-waiting".into());
                    hold.notified().await;
                }
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
        release: Arc<tokio::sync::Notify>,
    }

    fn engine(label: &str, freeze: bool, fail_store: bool) -> Opened {
        open_engine(label, freeze, fail_store, false)
    }

    fn open_engine(label: &str, freeze: bool, fail_store: bool, ghost: bool) -> Opened {
        open_with(label, freeze, fail_store, ghost, false)
    }

    fn open_with(label: &str, freeze: bool, fail_store: bool, ghost: bool, held: bool) -> Opened {
        let path = std::env::temp_dir().join(format!("invincible-rent-engine-{}-{label}", std::process::id()));
        let _ = std::fs::remove_dir_all(&path);
        let node = super::load_node_id(&path).unwrap();
        let state = path.join("rent/state");
        let events = Arc::new(Mutex::new(Vec::new()));
        let pods = Arc::new(Mutex::new(Vec::new()));
        let fail_deletes = Arc::new(std::sync::atomic::AtomicU32::new(0));
        let release = Arc::new(tokio::sync::Notify::new());
        let mut engine = Engine::open(Open {
            provider: Arc::new(Fake {
                state: state.clone(),
                events: Arc::clone(&events),
                freeze,
                ghost,
                fail_deletes: Arc::clone(&fail_deletes),
                pods: Arc::clone(&pods),
                hold: held.then(|| Arc::clone(&release)),
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
        Opened { engine: Arc::new(engine), events, home: Home { path, state }, node, pods, fail_deletes, release }
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
        let _creating = Creating::new(&engine.creating, "sess_fresh");
        engine.sweep().await;
        let events = events.lock().unwrap().clone();
        assert!(!events.iter().any(|line| line.contains("pod-fresh")), "{events:?}");
    }

    #[tokio::test]
    async fn a_create_the_node_did_not_finish_loses_its_pod() {
        let Opened { engine, events, home, node, pods, .. } = engine("abandoned", false, false);
        // The node stopped while the vendor was making this pod: no create runs for the session.
        pods.lock().unwrap().push(PodRef { id: "pod-left".into(), name: format!("invincible-{node}-sess_left") });
        let mut left = sample("sess_left", crate::rent::session::Phase::Provisioning, "");
        left.created_at -= chrono::TimeDelta::hours(1);
        write_session(&home.state, &left);
        // A create younger than any create lasts may belong to another node process on this home.
        pods.lock().unwrap().push(PodRef { id: "pod-young".into(), name: format!("invincible-{node}-sess_young") });
        write_session(&home.state, &sample("sess_young", crate::rent::session::Phase::Provisioning, ""));
        engine.sweep().await;
        let young = read_session(&home.state, "sess_young");
        assert_eq!(young.phase, crate::rent::session::Phase::Provisioning, "{:?}", young.events);
        let events = events.lock().unwrap().clone();
        assert!(events.iter().any(|line| line == "terminate:pod-left"), "the pod bills until its deadline: {events:?}");
        assert!(!events.iter().any(|line| line == "terminate:pod-young"), "{events:?}");
        let stored = read_session(&home.state, "sess_left");
        assert_eq!(stored.phase, crate::rent::session::Phase::Stopped, "{:?}", stored.events);
        assert_eq!(stored.instance_id, "pod-left");
    }

    #[tokio::test]
    async fn an_abandoned_create_with_no_pod_is_charged_nothing() {
        let Opened { engine, home, .. } = engine("abandoned-empty", false, false);
        let mut left = sample("sess_nopod", crate::rent::session::Phase::Provisioning, "");
        left.created_at -= chrono::TimeDelta::hours(1);
        write_session(&home.state, &left);
        engine.sweep().await;
        let stored = read_session(&home.state, "sess_nopod");
        assert_eq!(stored.phase, crate::rent::session::Phase::Stopped, "{:?}", stored.events);
        assert_eq!(stored.cost_actual_usd, 0.0, "an hour was charged for a pod that never existed");
        assert!(stored.error.contains("no pod"), "{}", stored.error);
    }

    #[tokio::test]
    async fn a_forced_stop_whose_delete_failed_stays_forced() {
        let Opened { engine, events, home, fail_deletes, .. } = engine("forced-delete-failed", false, false);
        write_session(&home.state, &sample("sess_fdf", crate::rent::session::Phase::Ready, "pod-fdf"));
        fail_deletes.store(1, std::sync::atomic::Ordering::SeqCst);
        assert!(engine.stop("sess_fdf", true, false).await.is_err(), "the failed delete was not reported");
        let open = read_session(&home.state, "sess_fdf");
        assert_eq!(open.phase, crate::rent::session::Phase::Draining, "{:?}", open.events);
        assert!(open.forced, "the force is not on disk for the next stop");
        let out = engine.stop("sess_fdf", false, false).await.unwrap_or_else(|err| panic!("{err}"));
        assert_eq!(out["phase"], "stopped", "a plain stop undid the force: {out}");
        let seen = events.lock().unwrap().clone();
        assert!(seen.iter().any(|line| line == "terminate:pod-fdf"), "{seen:?}");
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
        let offer = current.offer.clone();
        let instance = Instance { id: "pod-plain".into(), status: "RUNNING".into(), ..Instance::default() };
        let out =
            engine.discard_after_stop(&mut current, &instance, &offer).await.unwrap_or_else(|err| panic!("{err}"));
        assert_eq!(out["phase"], "draining", "{out}");
        assert_eq!(out["instance_id"], "pod-plain");
        let events = events.lock().unwrap().clone();
        assert!(events.iter().any(|line| line == "put:sessions/sess_plain/control.json"), "no drain asked: {events:?}");
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
        let offer = current.offer.clone();
        let instance = Instance { id: "pod-force".into(), status: "RUNNING".into(), ..Instance::default() };
        let out =
            engine.discard_after_stop(&mut current, &instance, &offer).await.unwrap_or_else(|err| panic!("{err}"));
        assert_eq!(out["phase"], "draining", "{out}");
        assert_eq!(out["instance_id"], "pod-force");
        let first = events.lock().unwrap().clone();
        assert_eq!(first.last().map(String::as_str), Some("terminate-fail:pod-force"), "{first:?}");
        assert!(
            !first.iter().any(|line| line.ends_with("/control.json")),
            "a forced stop waited for a drain: {first:?}"
        );
        // The forced path itself deletes and finishes when the vendor answers.
        let mut current = read_session(&home.state, "sess_force");
        let out =
            engine.discard_after_stop(&mut current, &instance, &offer).await.unwrap_or_else(|err| panic!("{err}"));
        assert_eq!(out["phase"], "stopped", "{out}");
        assert_eq!(out["forced"], true, "{out}");
        assert!(out["ended_at"].is_string(), "{out}");
        let events = events.lock().unwrap().clone();
        assert!(events.iter().any(|line| line == "terminate:pod-force"), "{events:?}");
        assert!(!events.iter().any(|line| line.ends_with("/control.json")), "{events:?}");
        assert!(events.iter().any(|line| line == "put:sessions/sess_force/receipt.json"), "{events:?}");
    }

    #[tokio::test]
    async fn a_later_plain_stop_keeps_an_earlier_force() {
        let Opened { engine, home, .. } = engine("sticky-force", false, false);
        write_session(&home.state, &sample("sess_sticky", crate::rent::session::Phase::Provisioning, ""));
        let first = engine.stop("sess_sticky", true, false).await.unwrap_or_else(|err| panic!("{err}"));
        assert_eq!(first["forced"], true, "{first}");
        let second = engine.stop("sess_sticky", false, false).await.unwrap_or_else(|err| panic!("{err}"));
        assert_eq!(second["phase"], "draining", "{second}");
        assert_eq!(second["forced"], true, "a plain stop undid the force: {second}");
    }

    #[tokio::test]
    async fn the_sweeper_leaves_a_stop_during_create_to_the_create() {
        let Opened { engine, events, home, node, pods, .. } = engine("sweep-inflight", false, false);
        let mut older = sample("sess_inflight", crate::rent::session::Phase::Provisioning, "");
        older.created_at -= chrono::TimeDelta::hours(1);
        write_session(&home.state, &older);
        let creating = Creating::new(&engine.creating, "sess_inflight");
        let stopped = engine.stop("sess_inflight", false, false).await.unwrap_or_else(|err| panic!("{err}"));
        assert_eq!(stopped["phase"], "draining", "{stopped}");
        // The vendor has made the pod but the create has not heard back yet.
        pods.lock()
            .unwrap()
            .push(PodRef { id: "pod-inflight".into(), name: format!("invincible-{node}-sess_inflight") });
        engine.sweep().await;
        let held = read_session(&home.state, "sess_inflight");
        assert_eq!(held.phase, crate::rent::session::Phase::Draining, "{:?}", held.events);
        assert!(!held.forced, "the sweeper turned a plain stop into a forced one");
        assert!(held.ended_at.is_none());
        let seen = events.lock().unwrap().clone();
        assert!(!seen.iter().any(|line| line.starts_with("terminate:")), "reconcile took the create's pod: {seen:?}");
        assert!(!seen.iter().any(|line| line.ends_with("/receipt.json")), "{seen:?}");
        // Once no create is running, a draining session is the sweeper's to finish.
        drop(creating);
        engine.sweep().await;
        let done = read_session(&home.state, "sess_inflight");
        assert_eq!(done.phase, crate::rent::session::Phase::Stopped, "{:?}", done.events);
        let seen = events.lock().unwrap().clone();
        assert!(seen.iter().any(|line| line == "terminate:pod-inflight"), "{seen:?}");
    }

    #[tokio::test]
    async fn a_deadline_during_create_forces_the_stop_and_leaves_it_to_the_create() {
        let Opened { engine, home, .. } = engine("deadline-inflight", false, false);
        let mut expired = sample("sess_due", crate::rent::session::Phase::Provisioning, "");
        expired.deadline_at = chrono::Utc::now() - chrono::TimeDelta::minutes(1);
        write_session(&home.state, &expired);
        let _creating = Creating::new(&engine.creating, "sess_due");
        engine.sweep().await;
        let held = read_session(&home.state, "sess_due");
        assert_eq!(held.phase, crate::rent::session::Phase::Draining, "{:?}", held.events);
        assert!(held.forced, "a deadline must delete the late pod without waiting");
        assert!(held.ended_at.is_none(), "the stop was finished before the create settled it");
    }

    #[tokio::test]
    async fn a_late_pod_records_the_offer_and_price_it_was_made_from() {
        let Opened { engine, home, .. } = engine("late-offer", false, false);
        write_session(&home.state, &sample("sess_offer", crate::rent::session::Phase::Provisioning, ""));
        engine.stop("sess_offer", true, false).await.unwrap_or_else(|err| panic!("{err}"));
        let mut current = read_session(&home.state, "sess_offer");
        let mut candidate = current.offer.clone();
        candidate.id = "runpod:community:4090".into();
        candidate.cloud = "community".into();
        candidate.usd_per_hr = 0.7;
        let instance =
            Instance { id: "pod-offer".into(), status: "RUNNING".into(), cost_per_hour: 0.9, ..Instance::default() };
        let out =
            engine.discard_after_stop(&mut current, &instance, &candidate).await.unwrap_or_else(|err| panic!("{err}"));
        assert_eq!(out["phase"], "stopped", "{out}");
        let stored = read_session(&home.state, "sess_offer");
        assert_eq!(stored.offer.id, "runpod:community:4090");
        assert_eq!(stored.offer.cloud, "community");
        assert!((stored.offer.usd_per_hr - 0.9).abs() < 1e-9, "{}", stored.offer.usd_per_hr);
        assert!((stored.cost_estimate_usd - 0.9 * stored.hours).abs() < 1e-9, "{}", stored.cost_estimate_usd);
    }

    #[tokio::test]
    async fn a_reopened_stop_clears_what_finish_recorded() {
        let Opened { engine, home, fail_deletes, .. } = engine("reopen", false, false);
        let mut done = sample("sess_reopen", crate::rent::session::Phase::Stopped, "");
        done.ended_at = Some(chrono::Utc::now());
        done.cost_actual_usd = 1.25;
        done.drain_ok = true;
        done.forced = true;
        write_session(&home.state, &done);
        fail_deletes.store(1, std::sync::atomic::Ordering::SeqCst);
        let mut current = read_session(&home.state, "sess_reopen");
        let offer = current.offer.clone();
        let instance = Instance { id: "pod-reopen".into(), status: "RUNNING".into(), ..Instance::default() };
        let out =
            engine.discard_after_stop(&mut current, &instance, &offer).await.unwrap_or_else(|err| panic!("{err}"));
        assert_eq!(out["phase"], "draining", "{out}");
        assert_eq!(out["instance_id"], "pod-reopen", "{out}");
        assert!(out["ended_at"].is_null(), "{out}");
        assert_eq!(out["cost_actual_usd"], 0.0, "{out}");
        assert_eq!(out["drain_ok"], false, "{out}");
    }

    #[tokio::test]
    async fn a_late_pod_a_stop_already_deleted_is_not_deleted_again() {
        let Opened { engine, events, home, .. } = engine("already-gone", false, false);
        let mut done = sample("sess_gone", crate::rent::session::Phase::Stopped, "pod-gone");
        let ended = done.created_at + chrono::TimeDelta::minutes(30);
        done.ended_at = Some(ended);
        done.drain_ok = true;
        write_session(&home.state, &done);
        let mut current = read_session(&home.state, "sess_gone");
        let mut candidate = current.offer.clone();
        candidate.usd_per_hr = 0.8;
        let instance = Instance { id: "pod-gone".into(), status: "RUNNING".into(), ..Instance::default() };
        let out =
            engine.discard_after_stop(&mut current, &instance, &candidate).await.unwrap_or_else(|err| panic!("{err}"));
        assert_eq!(out["phase"], "stopped", "{out}");
        assert_eq!(out["drain_ok"], true, "{out}");
        let seen = events.lock().unwrap().clone();
        assert!(!seen.iter().any(|line| line.starts_with("terminate") || line.ends_with("/control.json")), "{seen:?}");
        assert!(seen.iter().any(|line| line == "put:sessions/sess_gone/receipt.json"), "{seen:?}");
        let stored = read_session(&home.state, "sess_gone");
        assert_eq!(stored.ended_at, Some(ended), "the stop's end time moved");
        assert!((stored.offer.usd_per_hr - 0.8).abs() < 1e-9);
        assert!((stored.cost_actual_usd - 0.4).abs() < 1e-9, "{}", stored.cost_actual_usd);
    }

    #[tokio::test]
    async fn a_failed_create_does_not_reopen_a_stop_that_deleted_its_pod() {
        let Opened { engine, home, .. } = engine("fail-same-pod", false, false);
        let mut done = sample("sess_same", crate::rent::session::Phase::Stopped, "pod-same");
        done.ended_at = Some(done.created_at + chrono::TimeDelta::minutes(2));
        done.cost_actual_usd = 0.25;
        write_session(&home.state, &done);
        let mut local = sample("sess_same", crate::rent::session::Phase::Provisioning, "pod-same");
        local.error = "provision timed out (terminate: still present after delete)".into();
        local.go(crate::rent::session::Phase::Failed, chrono::Utc::now(), local.error.clone()).unwrap();
        assert!(engine.fail(&local).await.is_err(), "a failed create reported success");
        let stored = read_session(&home.state, "sess_same");
        assert_eq!(stored.phase, crate::rent::session::Phase::Stopped, "{:?}", stored.events);
        assert_eq!(stored.ended_at, done.ended_at);
        assert!((stored.cost_actual_usd - 0.25).abs() < 1e-9);
    }

    #[tokio::test]
    async fn a_plain_stop_after_a_forced_one_still_deletes_the_pod() {
        let Opened { engine, events, home, .. } = engine("forced-then-plain", false, false);
        // A forced stop during create whose delete of the late pod failed.
        let mut open = sample("sess_retry", crate::rent::session::Phase::Draining, "pod-retry");
        open.forced = true;
        write_session(&home.state, &open);
        let out = engine.stop("sess_retry", false, false).await.unwrap_or_else(|err| panic!("{err}"));
        assert_eq!(out["phase"], "stopped", "a plain stop undid the force: {out}");
        assert_eq!(out["forced"], true, "{out}");
        let seen = events.lock().unwrap().clone();
        assert!(seen.iter().any(|line| line == "terminate:pod-retry"), "{seen:?}");
    }

    #[tokio::test]
    async fn a_running_create_keeps_its_stop_and_pod_from_the_sweeper() {
        let Opened { engine, events, home, node, pods, release, .. } = open_with("held", false, false, false, true);
        let task = tokio::spawn({
            let engine = Arc::clone(&engine);
            async move {
                engine
                    .provision(Ask {
                        project_id: "hailuo".into(),
                        preset_id: "comfyui-minimax-h3".into(),
                        hours: 1.0,
                        offer_id: None,
                        regions: vec!["EU-secure".into()],
                        approved_usd_per_hr: None,
                    })
                    .await
            }
        });
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
        while !events.lock().unwrap().iter().any(|line| line == "create-waiting") {
            assert!(std::time::Instant::now() < deadline, "the create did not reach the vendor");
            tokio::time::sleep(std::time::Duration::from_millis(5)).await;
        }
        let id = std::fs::read_dir(&home.state)
            .unwrap()
            .flatten()
            .filter_map(|entry| entry.file_name().to_str()?.strip_suffix(".json").map(str::to_owned))
            .next()
            .expect("the create saved its session");
        assert!(engine.creating(&id), "provision does not mark its session as being created");
        let stopped = engine.stop(&id, false, false).await.unwrap_or_else(|err| panic!("{err}"));
        assert_eq!(stopped["phase"], "draining", "{stopped}");
        // The vendor lists the pod before the create hears back.
        pods.lock().unwrap().push(PodRef { id: "pod-crash".into(), name: format!("invincible-{node}-{id}") });
        engine.sweep().await;
        let held = read_session(&home.state, &id);
        assert_eq!(held.phase, crate::rent::session::Phase::Draining, "{:?}", held.events);
        assert!(!held.forced, "the sweeper turned a plain stop into a forced one");
        assert!(
            !events.lock().unwrap().iter().any(|line| line.starts_with("terminate")),
            "{:?}",
            events.lock().unwrap()
        );
        release.notify_one();
        let out = task.await.unwrap().unwrap_or_else(|err| panic!("{err}"));
        assert_eq!(out["phase"], "draining", "{out}");
        assert_eq!(out["instance_id"], "pod-crash", "{out}");
        assert!(!engine.creating(&id), "the create left its mark behind");
        let seen = events.lock().unwrap().clone();
        assert!(seen.iter().any(|line| line == &format!("put:sessions/{id}/control.json")), "{seen:?}");
    }

    #[tokio::test]
    async fn a_create_that_fails_after_a_stop_reports_the_error_and_finishes_the_stop() {
        let Opened { engine, home, .. } = engine("fail-after-stop", false, false);
        write_session(&home.state, &sample("sess_fail", crate::rent::session::Phase::Provisioning, ""));
        engine.stop("sess_fail", false, false).await.unwrap_or_else(|err| panic!("{err}"));
        let mut local = sample("sess_fail", crate::rent::session::Phase::Provisioning, "");
        local.error = "provision runpod:secure:4090: status 503".into();
        local.go(crate::rent::session::Phase::Failed, chrono::Utc::now(), local.error.clone()).unwrap();
        match engine.fail(&local).await {
            Err(RentError::Unavailable(message)) => assert!(message.contains("status 503"), "{message}"),
            Err(other) => panic!("unexpected error {other}"),
            Ok(body) => panic!("a create with no pod reported success: {body}"),
        }
        let stored = read_session(&home.state, "sess_fail");
        assert_eq!(stored.phase, crate::rent::session::Phase::Stopped, "{:?}", stored.events);
        assert!(stored.drain_ok && !stored.forced, "nothing ran, so nothing was cut short");
        assert!(stored.instance_id.is_empty());
        assert_eq!(stored.cost_actual_usd, 0.0, "no pod ran, so nothing is charged");
        assert!(stored.error.contains("before a pod existed"), "{}", stored.error);
    }

    #[tokio::test]
    async fn a_forced_stop_stays_forced_when_the_create_fails() {
        let Opened { engine, events, home, .. } = engine("fail-forced", false, false);
        write_session(&home.state, &sample("sess_ff", crate::rent::session::Phase::Provisioning, ""));
        let _creating = Creating::new(&engine.creating, "sess_ff");
        engine.stop("sess_ff", true, false).await.unwrap_or_else(|err| panic!("{err}"));
        let mut local = sample("sess_ff", crate::rent::session::Phase::Provisioning, "");
        local.error = "provision runpod:secure:4090: status 500".into();
        local.go(crate::rent::session::Phase::Failed, chrono::Utc::now(), local.error.clone()).unwrap();
        assert!(engine.fail(&local).await.is_err());
        let stored = read_session(&home.state, "sess_ff");
        assert_eq!(stored.phase, crate::rent::session::Phase::Stopped, "{:?}", stored.events);
        assert!(stored.forced, "the receipt contradicts the forced rent.stop");
        assert_eq!(stored.cost_actual_usd, 0.0);
        let seen = events.lock().unwrap().clone();
        assert!(seen.iter().any(|line| line == "put:sessions/sess_ff/receipt.json"), "{seen:?}");
    }

    #[tokio::test]
    async fn a_pod_a_failed_create_could_not_delete_after_a_stop_stays_on_the_session() {
        let Opened { engine, home, .. } = engine("fail-keeps-pod", false, false);
        write_session(&home.state, &sample("sess_stuck", crate::rent::session::Phase::Provisioning, ""));
        engine.stop("sess_stuck", false, false).await.unwrap_or_else(|err| panic!("{err}"));
        let mut local = sample("sess_stuck", crate::rent::session::Phase::Provisioning, "pod-stuck");
        local.error = "provision timed out (terminate: status 409)".into();
        local.go(crate::rent::session::Phase::Failed, chrono::Utc::now(), local.error.clone()).unwrap();
        assert!(engine.fail(&local).await.is_err(), "a failed create reported success");
        let stored = read_session(&home.state, "sess_stuck");
        assert_eq!(stored.phase, crate::rent::session::Phase::Draining, "{:?}", stored.events);
        assert_eq!(stored.instance_id, "pod-stuck", "the sweeper cannot retry a delete it does not know about");
        assert!(stored.ended_at.is_none());
    }
}
