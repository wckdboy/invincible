//! Dispatch (spec/dispatch.md): independent requests across the nodes this machine owns.
//!
//! The unit of work is a request, not a layer: one node answers it whole, so the nodes run in
//! parallel and nothing has to be stitched back together. This module builds the candidate rows —
//! this machine always, the paired nodes as a fresh probe finds them — hands them to
//! [`invincible_policy::choose`], and forwards one non-streaming chat completion to the node it
//! names. The policy decides; nothing here is a second opinion about it.
//!
//! Costs, stated: a snapshot probes every paired node over its session (one Noise handshake and
//! one `GET /v1/cluster/node` each, in parallel, 5 s timeout), and the round trip it reports is
//! that probe's own time — an upper bound, because the link meter's median costs 4 MiB. A link
//! the cluster already measured is preferred when it is fresh ([`crate::tune::load_links`]).

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use axum::http::header::CONTENT_TYPE;
use invincible_policy::{Choice, LinkSpeed, Node, choose};
use serde_json::{Value, json};

use crate::cluster::{self, Capabilities};
use crate::devices::{KnownNode, StaticKey};

/// The header that names the node whose answer this is.
pub const DISPATCHED_TO: &str = "invincible-dispatched-to";
/// Set when the answer came from the second node tried: the first one did not answer.
pub const RETRIED_HEADER: &str = "invincible-dispatch-retried";
/// The path a dispatched request is forwarded to (the same API on the answering node).
const PATH: &str = "/v1/chat/completions";
/// Attempts per request: the node `choose` names, then one other (spec/dispatch.md, Lifecycle).
const RETRIES: usize = 1;
/// How long a request waits for a free slot when every eligible node is at its `max_inflight`.
/// The spec says it waits rather than being refused; a wait nobody can see is worse than an
/// answer, so it is bounded and the refusal names the reason.
const QUEUE_WAIT: Duration = Duration::from_secs(60);
/// How often a waiting request looks again.
const QUEUE_POLL: Duration = Duration::from_millis(20);
/// How old a measured link may be and still be used for `rtt_ms` (hours).
const LINK_AGE_HOURS: i64 = 24;

// ---------------------------------------------------------------------------------------------
// Rows

/// What this machine knows about itself, for its own row.
#[derive(Clone, Debug)]
pub struct Local {
    pub name: String,
    /// The model ids it serves.
    pub models: Vec<String>,
    /// `[node] dispatch_max_inflight`.
    pub max_inflight: u64,
    /// Requests it is running for the dispatcher now.
    pub inflight: u64,
    /// What `invincible tune bench` measured here for the model, if it measured one.
    pub tg_tps: Option<f64>,
}

/// One paired node as the last probe left it.
#[derive(Clone, Debug)]
pub struct Probed {
    pub name: String,
    /// What it answered; `None` when the probe failed, which makes it down.
    pub caps: Option<Capabilities>,
    /// Why the probe failed, for the status line.
    pub error: Option<String>,
    /// Round trip in milliseconds: the measured link when there is a fresh one, else the probe's
    /// own time (an upper bound).
    pub rtt_ms: Option<f64>,
    /// Requests this head has running there now.
    pub inflight: u64,
}

/// The candidates for one request, this node first (spec/dispatch.md, Choosing a node).
pub fn rows(local: &Local, peers: &[Probed], model: Option<&str>) -> Vec<Node> {
    let me = Node {
        name: local.name.clone(),
        models: local.models.clone(),
        max_inflight: local.max_inflight,
        inflight: local.inflight,
        tg_tps: local.tg_tps,
        // Loopback: the hop costs nothing worth counting.
        rtt_ms: None,
        up: true,
    };
    std::iter::once(me).chain(peers.iter().map(|peer| peer_row(peer, model))).collect()
}

fn peer_row(peer: &Probed, model: Option<&str>) -> Node {
    let Some(caps) = &peer.caps else {
        // Down: still a row, so the status can say why nothing was sent there.
        return Node {
            name: peer.name.clone(),
            models: Vec::new(),
            max_inflight: 0,
            inflight: 0,
            tg_tps: None,
            rtt_ms: peer.rtt_ms,
            up: false,
        };
    };
    Node {
        name: peer.name.clone(),
        models: caps.models.clone(),
        // No `dispatch` block: a node too old to say how much it will take. Read as 0, never as
        // "unlimited" (spec/dispatch.md, What a node advertises).
        max_inflight: caps.dispatch.map_or(0, |d| d.max_inflight),
        inflight: peer.inflight,
        tg_tps: rate(caps, model),
        rtt_ms: peer.rtt_ms,
        up: true,
    }
}

/// What [caps] says this node runs [model] at: the best device's measured generation rate, from
/// the profiles taken on its own hardware. `None` when it measured nothing for this model — or
/// when the request names no model, since a rate for some other model is not a prediction.
pub fn rate(caps: &Capabilities, model: Option<&str>) -> Option<f64> {
    let model = model?;
    caps.profiles
        .iter()
        .filter(|set| set.model == model && set.hardware == caps.hardware)
        .flat_map(|set| set.profiles.iter().map(|profile| profile.tg_tps))
        .filter(|tps| tps.is_finite() && *tps > 0.0)
        .reduce(f64::max)
}

/// What this machine measured for [model], on the hardware it is running on now.
pub fn local_rate(home: &Path, model: &str) -> Option<f64> {
    let set = crate::tune::load(home, model)?;
    if set.hardware != crate::tune::hardware_now() {
        return None;
    }
    set.profiles.iter().map(|profile| profile.tg_tps).filter(|tps| tps.is_finite() && *tps > 0.0).reduce(f64::max)
}

/// Why [row] cannot take this request, in words, or `None` when it can.
fn note(row: &Node, model: Option<&str>) -> Option<String> {
    if !row.up {
        return Some("down".to_owned());
    }
    if row.max_inflight == 0 {
        return Some("takes nothing: dispatch.max_inflight 0 (a shard, or no capacity advertised)".to_owned());
    }
    match model {
        Some(model) if row.models.iter().any(|served| served == model) => {}
        Some(model) if row.models.is_empty() => {
            return Some(format!("names no models, so it cannot say it serves {model}"));
        }
        Some(model) => return Some(format!("does not serve {model}")),
        None => {}
    }
    if row.inflight >= row.max_inflight {
        return Some(format!("at capacity ({} of {})", row.inflight, row.max_inflight));
    }
    match (model, row.tg_tps) {
        (Some(model), None) => Some(format!("no measurement for {model} (sorts after every measured node)")),
        _ => None,
    }
}

// ---------------------------------------------------------------------------------------------
// The dispatcher

/// The head's view of every node it may send a request to.
pub struct Dispatch {
    /// This node's name (`[remote] name`).
    name: String,
    /// The model ids this node serves.
    models: Vec<String>,
    /// `[node] dispatch_max_inflight`.
    max_inflight: u64,
    /// Where this machine's measurements live (`$INVINCIBLE_HOME`).
    home: PathBuf,
    /// The nodes this machine paired with: every candidate but itself.
    peers: Vec<KnownNode>,
    /// This machine's device key, which a paired node knows it by.
    device_key: Option<StaticKey>,
    /// The network the link rule is applied for (`[node] network`).
    network: String,
    /// Links the cluster's meter measured, for `rtt_ms`.
    links: Vec<LinkSpeed>,
    /// Requests this head has running on each node now, by name. In memory only: a restart
    /// forgets them, and a node that kept a request running when the head died is found out by
    /// its next answer, not by a count.
    inflight: Arc<Mutex<BTreeMap<String, u64>>>,
    /// This machine's own hop (loopback, no session, no token: the engine is ours).
    client: reqwest::Client,
}

impl Dispatch {
    pub fn new(
        name: String,
        models: Vec<String>,
        max_inflight: u64,
        home: PathBuf,
        peers: Vec<KnownNode>,
        device_key: Option<StaticKey>,
        network: String,
    ) -> Self {
        let links = crate::tune::load_links(&home, LINK_AGE_HOURS);
        let client = crate::egress::local()
            .connect_timeout(Duration::from_secs(2))
            .build()
            .expect("HTTP client for this machine's engine");
        Self { name, models, max_inflight, home, peers, device_key, network, links, inflight: Arc::default(), client }
    }

    pub fn name(&self) -> &str {
        &self.name
    }

    /// The rows now and the choice over them: what `invincible dispatch status` shows and what
    /// a forwarded request decides on.
    pub async fn snapshot(&self, model: Option<&str>) -> Snapshot {
        let peers = self.probe().await;
        let local = Local {
            name: self.name.clone(),
            models: self.models.clone(),
            max_inflight: self.max_inflight,
            inflight: self.inflight(&self.name),
            tg_tps: model.and_then(|model| local_rate(&self.home, model)),
        };
        let rows = rows(&local, &peers, model);
        let choice = choose(&rows, model);
        Snapshot { model: model.map(str::to_owned), rows, peers, choice }
    }

    /// Requests this head has in flight to [name] now.
    pub fn inflight(&self, name: &str) -> u64 {
        *self.inflight.lock().expect("inflight lock").get(name).unwrap_or(&0)
    }

    /// Counts one request in flight to [name] until the guard is dropped.
    fn slot(&self, name: &str) -> Slot {
        *self.inflight.lock().expect("inflight lock").entry(name.to_owned()).or_insert(0) += 1;
        Slot { counts: self.inflight.clone(), name: name.to_owned() }
    }

    /// Every paired node, probed at once (a slow node costs one timeout, not a round of them).
    async fn probe(&self) -> Vec<Probed> {
        let probes = self.peers.iter().map(|peer| async move {
            let started = Instant::now();
            let (caps, error) = match self.probe_one(peer).await {
                Ok(caps) => (Some(caps), None),
                Err(e) => (None, Some(e)),
            };
            let probed_ms = started.elapsed().as_secs_f64() * 1000.0;
            Probed {
                name: peer.name.clone(),
                caps,
                error,
                rtt_ms: self.measured_rtt(&peer.name).or(Some(probed_ms)),
                inflight: self.inflight(&peer.name),
            }
        });
        futures_util::future::join_all(probes).await
    }

    async fn probe_one(&self, peer: &KnownNode) -> Result<Capabilities, String> {
        let Some(device) = &self.device_key else {
            return Err("this machine has no device key: pair with the node (`invincible join`) first".to_owned());
        };
        cluster::probe_peer(peer, device, &self.network).await
    }

    /// The round trip the link meter measured to [name], while it is fresh.
    fn measured_rtt(&self, name: &str) -> Option<f64> {
        self.links.iter().find(|link| link.node == name).map(|link| link.rtt_ms)
    }

    /// Updates the rows' in-flight counts from the counter: a waiting request must see a slot
    /// free without paying for another probe.
    fn refresh(&self, rows: &mut [Node]) {
        let counts = self.inflight.lock().expect("inflight lock").clone();
        for row in rows.iter_mut() {
            row.inflight = *counts.get(&row.name).unwrap_or(&0);
        }
    }

    /// Sends one non-streaming chat completion to the node [`choose`] names (spec/dispatch.md,
    /// Lifecycle), and to one other node if the first fails before it answers at all.
    ///
    /// [self_url] is this machine's own engine for the model (the caller knows its engines); it is
    /// only used when the choice is this node. All of [body] goes on unchanged, so the request the
    /// answering node sees is the one the client wrote.
    pub async fn answer(&self, self_url: Option<&str>, model: Option<&str>, body: &[u8]) -> Result<Reply, Unavailable> {
        let snapshot = self.snapshot(model).await;
        let mut rows = snapshot.rows;
        let mut failures: Vec<String> = Vec::new();
        let deadline = Instant::now() + QUEUE_WAIT;
        let mut attempt = 0;
        loop {
            let name = match choose(&rows, model) {
                Choice::Run { name, .. } => name,
                Choice::Queue => {
                    // Every eligible node is at its max_inflight: wait for a slot (the spec's
                    // queue), looking again at the count we keep ourselves.
                    if !failures.is_empty() {
                        return Err(Unavailable::Failed(failures));
                    }
                    if Instant::now() >= deadline {
                        return Err(Unavailable::Busy(reasons(&rows, model)));
                    }
                    tokio::time::sleep(QUEUE_POLL).await;
                    self.refresh(&mut rows);
                    continue;
                }
                Choice::NoCapacity => {
                    return Err(if failures.is_empty() {
                        Unavailable::NoCapacity(reasons(&rows, model))
                    } else {
                        Unavailable::Failed(failures)
                    });
                }
            };
            let slot = self.slot(&name);
            let outcome = self.call(&name, self_url, body).await;
            drop(slot);
            let may_retry = attempt < RETRIES;
            match outcome {
                Ok((status, bytes)) if !(may_retry && worth_another_node(status)) => {
                    return Ok(Reply { node: name, status, body: bytes, failures });
                }
                Ok((status, bytes)) => {
                    // It answered, with its own failure: the request never got going there, so
                    // it may be tried elsewhere. The body is the node's, not the client's.
                    tracing::warn!(node = %name, status, answer = %String::from_utf8_lossy(&bytes).chars().take(160).collect::<String>(), "dispatch: no answer here; trying another node");
                    failures.push(format!("{name}: {status}"));
                }
                Err(e) if may_retry => failures.push(format!("{name}: {e}")),
                Err(e) => {
                    failures.push(format!("{name}: {e}"));
                    return Err(Unavailable::Failed(failures));
                }
            }
            // It did not answer: down for this request, so the retry goes elsewhere.
            if let Some(row) = rows.iter_mut().find(|row| row.name == name) {
                row.up = false;
            }
            attempt += 1;
        }
    }

    /// One attempt on [name]: the answer's status and body, or why no answer came.
    async fn call(&self, name: &str, self_url: Option<&str>, body: &[u8]) -> Result<(u16, Vec<u8>), String> {
        if name == self.name {
            let url = self_url.ok_or_else(|| "this node serves no engine for it".to_owned())?;
            let response = self
                .client
                .post(format!("{url}{PATH}"))
                .header(CONTENT_TYPE, "application/json")
                .body(body.to_vec())
                .send()
                .await
                .map_err(|e| e.to_string())?;
            let status = response.status().as_u16();
            let bytes = response.bytes().await.map_err(|e| e.to_string())?;
            return Ok((status, bytes.to_vec()));
        }
        let peer =
            self.peers.iter().find(|peer| peer.name == name).ok_or_else(|| format!("{name}: not a paired node"))?;
        let device = self.device_key.as_ref().ok_or_else(|| "no device key".to_owned())?;
        // The link rule applies to a request as much as to a probe (spec/cluster.md, Links).
        let (addrs, refused) = cluster::link_addrs(peer, &self.network);
        if addrs.is_empty() {
            return Err(format!("no address may carry a link ({})", refused.join("; ")));
        }
        crate::remote::post(&addrs, &peer.key_bytes()?, device, PATH, body.to_vec()).await
    }
}

/// Whether a node's answer is the node's failure rather than the request's: a 4xx would be
/// refused by every node alike, so only 429 and 5xx are worth another node.
fn worth_another_node(status: u16) -> bool {
    status == 429 || (500..600).contains(&status)
}

fn reasons(rows: &[Node], model: Option<&str>) -> Vec<String> {
    rows.iter()
        .map(|row| match note(row, model) {
            Some(why) => format!("{}: {why}", row.name),
            None => row.name.clone(),
        })
        .collect()
}

/// One request counted as in flight to a node until dropped.
struct Slot {
    counts: Arc<Mutex<BTreeMap<String, u64>>>,
    name: String,
}

impl Drop for Slot {
    fn drop(&mut self) {
        let mut counts = self.counts.lock().expect("inflight lock");
        if let Some(n) = counts.get_mut(&self.name) {
            *n = n.saturating_sub(1);
            if *n == 0 {
                counts.remove(&self.name);
            }
        }
    }
}

/// The candidate rows and the choice over them.
pub struct Snapshot {
    pub model: Option<String>,
    pub rows: Vec<Node>,
    pub peers: Vec<Probed>,
    pub choice: Choice,
}

impl Snapshot {
    /// The row the choice names, if any.
    pub fn chosen(&self) -> Option<&Node> {
        match &self.choice {
            Choice::Run { node, .. } => self.rows.get(*node),
            _ => None,
        }
    }

    /// What `GET /v1/dispatch` and `invincible dispatch status` show.
    pub fn to_json(&self) -> Value {
        let chosen = self.chosen().map(|row| row.name.clone());
        let nodes: Vec<Value> = self
            .rows
            .iter()
            .map(|row| {
                let peer = self.peers.iter().find(|peer| peer.name == row.name);
                json!({
                    "name": row.name,
                    "models": row.models,
                    "max_inflight": row.max_inflight,
                    "inflight": row.inflight,
                    "tg_tps": row.tg_tps,
                    "rtt_ms": row.rtt_ms,
                    "up": row.up,
                    "chosen": chosen.as_deref() == Some(row.name.as_str()),
                    "note": match (note(row, self.model.as_deref()), peer.and_then(|p| p.error.clone())) {
                        // A probe that failed says why; the row then only says "down".
                        (Some(why), Some(error)) if why == "down" => Some(format!("down: {error}")),
                        (why, _) => why,
                    },
                })
            })
            .collect();
        let choice = match &self.choice {
            Choice::Run { name, .. } => json!({ "action": "run", "name": name }),
            Choice::Queue => json!({ "action": "queue" }),
            Choice::NoCapacity => json!({ "action": "no_capacity" }),
        };
        json!({ "name": self.head_name(), "model": self.model, "nodes": nodes, "choice": choice })
    }

    /// This machine's name: the first row is always its own.
    fn head_name(&self) -> String {
        self.rows.first().map(|row| row.name.clone()).unwrap_or_default()
    }
}

/// An answer that was made.
pub struct Reply {
    /// The node that answered.
    pub node: String,
    pub status: u16,
    pub body: Vec<u8>,
    /// Nodes tried before it that did not answer, and why.
    pub failures: Vec<String>,
}

impl Reply {
    /// Whether this answer came from the second node tried.
    pub fn retried(&self) -> bool {
        !self.failures.is_empty()
    }
}

/// Why no answer could be made.
pub enum Unavailable {
    /// Every eligible node stayed at its `max_inflight` for [QUEUE_WAIT], with why, per node.
    Busy(Vec<String>),
    /// No node serves this request, with why, per node.
    NoCapacity(Vec<String>),
    /// The eligible nodes were tried and none answered, with why, per node.
    Failed(Vec<String>),
}

impl Unavailable {
    /// The error code an OpenAI-shaped client sees.
    pub fn code(&self) -> &'static str {
        match self {
            Self::Busy(_) => "capacity_timeout",
            Self::NoCapacity(_) => "no_capacity",
            Self::Failed(_) => "dispatched_node_failed",
        }
    }

    pub fn message(&self) -> String {
        let reasons = match self {
            Self::Busy(reasons) | Self::NoCapacity(reasons) | Self::Failed(reasons) => reasons,
        };
        let head = match self {
            Self::Busy(_) => "every node that could take it stayed busy",
            Self::NoCapacity(_) => "no paired node can take this request",
            Self::Failed(_) => "the nodes that could take it did not answer",
        };
        format!("{head}: {}", reasons.join("; "))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::cluster::Dispatch as Capacity;
    use crate::tune::{Profile, Set};

    fn me(max_inflight: u64) -> Local {
        Local { name: "studio".into(), models: vec!["qwen3-4b".into()], max_inflight, inflight: 0, tg_tps: Some(10.0) }
    }

    fn caps(max_inflight: Option<u64>, models: &[&str], tps: Option<f64>) -> Capabilities {
        Capabilities {
            name: "peer".into(),
            models: models.iter().map(|m| (*m).to_owned()).collect(),
            dispatch: max_inflight.map(|max_inflight| Capacity { max_inflight, queue: 0 }),
            hardware: "linux x86_64 8c 32.0 GiB".into(),
            profiles: match tps {
                Some(tg_tps) => vec![Set {
                    model: "qwen3-4b".into(),
                    hardware: "linux x86_64 8c 32.0 GiB".into(),
                    profiles: vec![Profile {
                        device: "CUDA0".into(),
                        tg_tps,
                        pp_tps: None,
                        engine: "llama-bench b1".into(),
                        at: "2026-10-22T00:00:00Z".into(),
                    }],
                }],
                None => Vec::new(),
            },
            ..Capabilities::default()
        }
    }

    fn up(name: &str, caps: Capabilities, inflight: u64) -> Probed {
        Probed { name: name.into(), caps: Some(caps), error: None, rtt_ms: Some(1.0), inflight }
    }

    fn down(name: &str, why: &str) -> Probed {
        Probed { name: name.into(), caps: None, error: Some(why.into()), rtt_ms: Some(5000.0), inflight: 0 }
    }

    fn picked(rows: &[Node], model: Option<&str>) -> String {
        match choose(rows, model) {
            Choice::Run { name, .. } => name,
            other => format!("{other:?}"),
        }
    }

    #[test]
    fn this_node_is_always_a_row_and_a_down_peer_is_one_that_says_why() {
        let list = rows(&me(1), &[down("mini", "timed out")], Some("qwen3-4b"));
        assert_eq!(list.len(), 2);
        assert_eq!(list[0].name, "studio");
        assert!(list[0].up);
        assert!(!list[1].up, "a node that did not answer is down");
        assert_eq!(list[1].max_inflight, 0, "a down node takes nothing");
        // Nothing else is eligible, so this machine answers.
        assert_eq!(picked(&list, Some("qwen3-4b")), "studio");
    }

    #[test]
    fn a_peer_that_will_take_nothing_is_never_eligible() {
        // A shard advertises max_inflight 0: its capacity is spoken for, however fast it is.
        let shard = up("mini", caps(Some(0), &["qwen3-4b"], Some(90.0)), 0);
        let list = rows(&me(1), &[shard], Some("qwen3-4b"));
        assert_eq!(list[1].max_inflight, 0);
        assert_eq!(picked(&list, Some("qwen3-4b")), "studio");
        assert!(note(&list[1], Some("qwen3-4b")).unwrap().contains("dispatch.max_inflight 0"));
    }

    #[test]
    fn a_peer_too_old_to_advertise_capacity_is_read_as_zero_not_unlimited() {
        let old = up("mini", caps(None, &["qwen3-4b"], Some(90.0)), 0);
        let list = rows(&me(1), &[old], Some("qwen3-4b"));
        assert_eq!(list[1].max_inflight, 0, "absent dispatch is unknown, never unlimited");
        assert_eq!(picked(&list, Some("qwen3-4b")), "studio");
    }

    #[test]
    fn an_unmeasured_peer_sorts_behind_a_measured_one() {
        let measured = up("measured", caps(Some(4), &["qwen3-4b"], Some(40.0)), 0);
        let blind = up("unmeasured", caps(Some(4), &["qwen3-4b"], None), 0);
        let list = rows(&me(1), &[blind, measured], Some("qwen3-4b"));
        assert_eq!(picked(&list, Some("qwen3-4b")), "measured");
        assert!(note(&list[1], Some("qwen3-4b")).unwrap().contains("no measurement"));
        // Nothing measured anywhere: the name decides, so the choice is stable across runs.
        let mut unmeasured_local = me(4);
        unmeasured_local.tg_tps = None;
        let both = vec![up("b", caps(Some(4), &["qwen3-4b"], None), 0), up("a", caps(Some(4), &["qwen3-4b"], None), 0)];
        assert_eq!(picked(&rows(&unmeasured_local, &both, Some("qwen3-4b")), Some("qwen3-4b")), "a");
        // With a measurement here, this machine wins: it is the node with a number.
        assert_eq!(picked(&rows(&me(4), &both, Some("qwen3-4b")), Some("qwen3-4b")), "studio");
    }

    #[test]
    fn a_rate_is_only_a_prediction_for_the_model_it_names() {
        let peer = caps(Some(1), &["qwen3-4b"], Some(40.0));
        assert_eq!(rate(&peer, Some("qwen3-4b")), Some(40.0));
        assert_eq!(rate(&peer, Some("llama-70b")), None, "another model's rate is not this one's");
        assert_eq!(rate(&peer, Some("qwen3-4b")), Some(40.0));
        assert_eq!(rate(&peer, None), None, "an automatic choice has no model to predict");
        // A measurement taken on other hardware is not this node's rate.
        let mut moved = peer.clone();
        moved.hardware = "linux aarch64 8c 16.0 GiB".into();
        assert_eq!(rate(&moved, Some("qwen3-4b")), None);
        // A zero or nonsense rate is no measurement at all.
        let mut broken = peer.clone();
        broken.profiles[0].profiles[0].tg_tps = 0.0;
        assert_eq!(rate(&broken, Some("qwen3-4b")), None);
    }

    #[test]
    fn a_request_no_node_serves_is_no_capacity_and_says_why() {
        let list = rows(&me(1), &[up("mini", caps(Some(2), &["qwen3-4b"], Some(40.0)), 0)], Some("llama-70b"));
        assert_eq!(choose(&list, Some("llama-70b")), Choice::NoCapacity);
        let why = reasons(&list, Some("llama-70b"));
        assert!(why[0].contains("does not serve llama-70b"), "{why:?}");
        assert!(why[1].contains("does not serve llama-70b"), "{why:?}");
    }

    #[test]
    fn one_node_at_capacity_yields_to_the_other_even_when_it_is_slower() {
        let busy = up("fast", caps(Some(1), &["qwen3-4b"], Some(90.0)), 1);
        let idle = up("slow", caps(Some(1), &["qwen3-4b"], Some(10.0)), 0);
        // This machine takes nothing here (its capacity is spoken for), so the peers decide.
        let list = rows(&me(0), &[busy, idle], Some("qwen3-4b"));
        assert_eq!(picked(&list, Some("qwen3-4b")), "slow");
        // Every node at capacity waits, it is not refused.
        let list = rows(&me(1), &[up("fast", caps(Some(1), &["qwen3-4b"], Some(90.0)), 1)], Some("qwen3-4b"));
        let mut full = list.clone();
        full[0].inflight = 1;
        assert_eq!(choose(&full, Some("qwen3-4b")), Choice::Queue);
    }

    #[test]
    fn the_snapshot_says_which_row_answers_and_why_the_others_do_not() {
        let peers = [up("mini", caps(Some(2), &["qwen3-4b"], Some(40.0)), 0), down("gone", "no route")];
        let list = rows(&me(1), &peers, Some("qwen3-4b"));
        let choice = choose(&list, Some("qwen3-4b"));
        let snapshot = Snapshot { model: Some("qwen3-4b".into()), rows: list, peers: peers.to_vec(), choice };
        let json = snapshot.to_json();
        assert_eq!(json["name"], "studio");
        assert_eq!(json["choice"], serde_json::json!({ "action": "run", "name": "mini" }));
        assert_eq!(json["nodes"][1]["chosen"], true);
        assert_eq!(json["nodes"][0]["chosen"], false);
        assert_eq!(json["nodes"][2]["note"], "down: no route");
        assert!(snapshot.chosen().is_some_and(|row| row.name == "mini"));
    }
}
