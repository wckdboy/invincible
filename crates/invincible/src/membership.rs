//! Cluster membership on the node's own API (spec/cluster.md, Membership API): a pairing code, a
//! join, the nodes this machine paired with, renaming one and unpairing it — JSON in, JSON out,
//! behind the node's token, for a client that has no shell on the machine.
//!
//! Nothing here is a second mechanism. A code comes from [crate::remote::Pairing::start_for], the
//! join is [crate::remote::pair], and `nodes.json` is the one record of membership — the same
//! functions `invincible pair`, `invincible join` and `invincible devices` use, so a URI minted
//! here is consumed by an `invincible join` elsewhere and the other way round.
//!
//! What this module deliberately does not do: it never contacts a peer to unpair it (removing a
//! node here is this machine forgetting it, spec/cluster.md), and it does not re-plan a running
//! cluster: `[cluster]` and `[[models]] cluster` are read at start, so a join, rename or unpair
//! reaches dispatch and the split planner at the next `invincible serve`.

use std::path::{Path, PathBuf};
use std::time::Duration;

use axum::http::StatusCode;
use base64::Engine as _;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use serde_json::{Value, json};
use tokio::time::{Instant, timeout};

use crate::devices::{self, KnownNode, KnownNodes, StaticKey};
use crate::remote::{self, PairError, PairingCode};

/// How long a paired node may take to answer the probe behind `GET /v1/cluster/nodes`. Short on
/// purpose: the endpoint is read by an app far more often than a peer is down, and a probe that
/// times out is reported as unknown (`reachable: null`), never waited out.
pub const PROBE_BUDGET: Duration = Duration::from_millis(1500);
/// The shortest and longest life a pairing code may be given through the API.
pub const MIN_TTL_SECONDS: u64 = 1;
pub const MAX_TTL_SECONDS: u64 = 24 * 60 * 60;
/// The longest name a node may be given (`[cluster]` compares names as they are written).
pub const MAX_NAME: usize = 40;

/// Why a membership call did not do what was asked, in the shape the API reports: a status, a
/// code, and a sentence that never contains a secret or a whole pairing URI.
#[derive(Debug)]
pub struct Refusal {
    pub status: StatusCode,
    pub code: &'static str,
    pub message: String,
}

impl Refusal {
    fn new(status: StatusCode, code: &'static str, message: impl Into<String>) -> Self {
        Self { status, code, message: message.into() }
    }

    fn bad_request(code: &'static str, message: impl Into<String>) -> Self {
        Self::new(StatusCode::BAD_REQUEST, code, message)
    }

    pub fn not_found(message: impl Into<String>) -> Self {
        Self::new(StatusCode::NOT_FOUND, "not_found", message)
    }

    fn conflict(code: &'static str, message: impl Into<String>) -> Self {
        Self::new(StatusCode::CONFLICT, code, message)
    }

    fn internal(message: impl Into<String>) -> Self {
        Self::new(StatusCode::INTERNAL_SERVER_ERROR, "internal_error", message)
    }

    /// A route that needs this machine's home directory, in a process that has none.
    pub fn unavailable() -> Self {
        Self::conflict("membership_unavailable", "this node has no home directory to record paired nodes in")
    }

    /// `error`'s shape from server.rs, so a refusal looks like every other error on this API.
    pub fn into_response(self) -> axum::response::Response {
        crate::server::error(self.status, self.code, &self.message)
    }
}

/// This machine's membership: where `device.key` and `nodes.json` live, and the locks that keep
/// two callers from racing each other over them.
pub struct Membership {
    home: PathBuf,
    /// One join at a time. A second `POST /v1/cluster/join` while the first is dialling is told to
    /// wait rather than both writing `nodes.json` and one of them losing.
    joining: tokio::sync::Mutex<()>,
    /// `nodes.json`: read, change, write — one at a time, and never across an await.
    nodes: std::sync::Mutex<()>,
}

impl Membership {
    pub fn new(home: impl Into<PathBuf>) -> Self {
        Self { home: home.into(), joining: tokio::sync::Mutex::new(()), nodes: std::sync::Mutex::new(()) }
    }

    /// Pairs this machine with the node in [uri] and records it, exactly as `invincible join`
    /// does: [name] if given, else this node's own `[remote] name` ([crate::config::join_name]).
    ///
    /// A URI that does not parse, or a code the peer refuses (wrong, used or expired), is the
    /// caller's problem and answers 400 with the reason. A node that cannot be reached is 502, and
    /// the handshake failing part-way is 502 too. Nothing is written unless the pairing completed.
    pub async fn join(&self, uri: &str, name: Option<String>) -> Result<Value, Refusal> {
        let code = PairingCode::decode(uri).map_err(|e| Refusal::bad_request("invalid_pairing_code", e))?;
        // Refused before anything is dialled: only one join runs, and the caller can retry.
        let _alone = match self.joining.try_lock() {
            Ok(guard) => guard,
            Err(_) => {
                return Err(Refusal::conflict(
                    "join_in_progress",
                    "a join is already in flight on this node; wait for it",
                ));
            }
        };
        let device = StaticKey::load_or_create(&self.home.join("device.key")).map_err(Refusal::internal)?;
        let name = crate::config::join_name(name, &self.home);
        let paired = remote::pair(&code, &device, &name).await.map_err(|e| match e {
            PairError::Refused(message) => Refusal::bad_request("pairing_refused", message),
            PairError::Failed(message) => Refusal::new(StatusCode::BAD_GATEWAY, "join_failed", message),
        })?;
        self.record(&code, &paired)?;
        let fingerprint = devices::fingerprint(&code.node_key);
        // `heads_must_name` is the name the *peer* lists this machine under: the one string a
        // person cannot read from here and a shard's `[cluster] heads` must contain.
        // `capabilities` is what the peer granted this machine when it joined (spec/pairing.md,
        // Capabilities): the peer's own record is what it enforces.
        Ok(json!({
            "node": paired.node,
            "device": paired.device,
            "fingerprint": fingerprint,
            "heads_must_name": paired.device,
            "addresses": code.addrs,
            "receipt_key": paired.receipt_key,
            "capabilities": paired.capabilities.codes(),
        }))
    }

    /// Writes the pairing into `nodes.json` (one entry per node; joining again replaces it).
    fn record(&self, code: &PairingCode, paired: &remote::Paired) -> Result<(), Refusal> {
        let _writing = self.nodes.lock().expect("nodes lock");
        record(&self.home, code, paired).map_err(Refusal::internal)
    }

    /// Every node this machine paired with, and whether it answers right now. The probes run at
    /// once, each capped at [PROBE_BUDGET]: a peer that is asleep cannot make this call slow, and
    /// one that did not answer in time is reported `reachable: null` with the reason, not `false`.
    pub async fn nodes(&self, network: &str) -> Result<Value, Refusal> {
        let list = KnownNodes::load(&self.home).map_err(Refusal::internal)?.0;
        // Read, never create: a GET does not set up this machine as a device.
        let device = StaticKey::load(&self.home.join("device.key")).map_err(Refusal::internal)?;
        let device = device.as_ref();
        let probes = list.iter().map(|node| async move {
            let mut entry = json!({
                "name": node.name,
                "fingerprint": node.key_bytes().ok().as_deref().map(devices::fingerprint),
                "addresses": node.addrs,
                // The name this node lists *us* under, as learned at join (a shard's
                // `[cluster] heads` is compared against it).
                "device": node.device,
                "receipt_key": node.receipt_key,
                // What the peer granted this machine at join (spec/pairing.md, Capabilities).
                // The peer enforces its own record, which an operator can change there later;
                // this is the answer it gave here.
                "capabilities": node.capabilities.codes(),
                // No per-node last-seen is recorded anywhere: `reachable` and `probe_ms` are what
                // this node actually knows, and both are from just now.
                "reachable": Value::Null,
            });
            let Some(device) = device else {
                entry["reason"] = json!("no device.key on this machine: it has never joined a node");
                return entry;
            };
            let (addrs, refused) = crate::cluster::link_addrs(node, network);
            entry["link_addresses"] = json!(addrs);
            entry["refused_addresses"] = json!(refused);
            if addrs.is_empty() {
                entry["reason"] = json!(format!("no address may carry a link ({})", refused.join("; ")));
                return entry;
            }
            let Ok(key) = node.key_bytes() else {
                entry["reason"] = json!("the pinned key is not base64url");
                return entry;
            };
            let started = Instant::now();
            match timeout(PROBE_BUDGET, remote::get_json(&addrs, &key, device, "/v1/node")).await {
                Ok(Ok(_)) => {
                    entry["reachable"] = json!(true);
                    entry["probe_ms"] = json!(started.elapsed().as_millis() as u64);
                }
                Ok(Err(e)) => {
                    entry["reachable"] = json!(false);
                    entry["error"] = json!(e);
                }
                Err(_) => {
                    entry["reason"] = json!(format!(
                        "no answer within {} ms: it may be asleep or off the network",
                        PROBE_BUDGET.as_millis()
                    ));
                }
            }
            entry
        });
        let nodes: Vec<Value> = futures_util::future::join_all(probes).await;
        Ok(json!({ "nodes": nodes }))
    }

    /// Forgets [name]: removes it from `nodes.json` and nothing else. The peer keeps its own
    /// record until someone unpairs this machine there — a local unpair is this side's half.
    pub fn unpair(&self, name: &str) -> Result<Value, Refusal> {
        let _writing = self.nodes.lock().expect("nodes lock");
        let mut nodes = KnownNodes::load(&self.home).map_err(Refusal::internal)?;
        let before = nodes.0.len();
        nodes.0.retain(|node| node.name != name);
        if nodes.0.len() == before {
            return Err(Refusal::not_found(format!("no paired node \"{name}\" (GET /v1/cluster/nodes lists them)")));
        }
        nodes.save(&self.home).map_err(Refusal::internal)?;
        Ok(json!({ "unpaired": name, "nodes_remaining": nodes.0.len() }))
    }

    /// Renames [from] to [to] here. A name another node already has is refused (409): `nodes.json`
    /// is keyed by name, and two entries with one name would be one entry that answers for two
    /// machines.
    pub fn rename(&self, from: &str, to: &str) -> Result<Value, Refusal> {
        let to = valid_name(to)?;
        let _writing = self.nodes.lock().expect("nodes lock");
        let mut nodes = KnownNodes::load(&self.home).map_err(Refusal::internal)?;
        let index = nodes.0.iter().position(|node| node.name == from).ok_or_else(|| {
            Refusal::not_found(format!("no paired node \"{from}\" (GET /v1/cluster/nodes lists them)"))
        })?;
        if to == from {
            return Ok(json!({ "name": from, "was": from, "changed": false }));
        }
        if nodes.0.iter().any(|node| node.name == to) {
            return Err(Refusal::conflict("name_taken", format!("a node is already called \"{to}\"")));
        }
        nodes.0[index].name = to.clone();
        nodes.save(&self.home).map_err(Refusal::internal)?;
        Ok(json!({ "name": to, "was": from, "changed": true }))
    }
}

/// A name as `nodes.json` and `[cluster]` hold it: 1–[MAX_NAME] characters of ASCII letters,
/// digits, `-` and `_`. Refused rather than cleaned, so a rename does what was asked or says why.
fn valid_name(name: &str) -> Result<String, Refusal> {
    let trimmed = name.trim();
    if trimmed.is_empty() {
        return Err(Refusal::bad_request("invalid_name", "the name is empty"));
    }
    if trimmed.chars().count() > MAX_NAME {
        return Err(Refusal::bad_request("invalid_name", format!("the name is longer than {MAX_NAME} characters")));
    }
    if !trimmed.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_') {
        return Err(Refusal::bad_request(
            "invalid_name",
            "the name may hold letters, digits, '-' and '_' only (it is compared as written)",
        ));
    }
    Ok(trimmed.to_owned())
}

/// Records a completed pairing in `nodes.json`: one entry per node, keyed by the node's own name.
/// Shared with `invincible join`, so the file has one shape whichever way a machine joined.
pub fn record(home: &Path, code: &PairingCode, paired: &remote::Paired) -> Result<(), String> {
    let mut nodes = KnownNodes::load(home)?;
    nodes.0.retain(|node| node.name != paired.node);
    nodes.0.push(KnownNode {
        device: Some(paired.device.clone()),
        receipt_key: paired.receipt_key.clone(),
        capabilities: paired.capabilities.clone(),
        name: paired.node.clone(),
        key: URL_SAFE_NO_PAD.encode(code.node_key),
        addrs: code.addrs.clone(),
    });
    nodes.save(home)
}

#[cfg(test)]
mod tests {
    use super::{Refusal, valid_name};

    #[test]
    fn names_are_refused_not_rewritten() {
        assert_eq!(valid_name(" studio ").unwrap(), "studio");
        assert_eq!(valid_name("box-2").unwrap(), "box-2");
        for bad in ["", "   ", "a b", "a/b", "café", &"x".repeat(41)] {
            let refusal: Refusal = valid_name(bad).expect_err(bad);
            assert_eq!(refusal.status, axum::http::StatusCode::BAD_REQUEST, "{bad:?}");
            assert_eq!(refusal.code, "invalid_name");
        }
        // The longest name that fits.
        assert_eq!(valid_name(&"y".repeat(40)).unwrap().len(), 40);
    }
}
