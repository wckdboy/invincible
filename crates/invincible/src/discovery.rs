//! Discovery (spec/discovery.md): signed, expiring descriptors, seed URLs, and mDNS on a LAN.
//!
//! Discovery answers "where might a node be". It never answers "is it trusted". A descriptor is
//! minted and signed by the node itself; a seed only stores and returns it; mDNS only carries it.
//! Nothing here pins a key or opens a session: a discovered node is usable only after the pairing
//! flow in [crate::remote], whose Noise IK handshake is the only thing that authorises one.
//!
//! The signature is the node's Ed25519 receipt key (`receipt.key`), the key `GET /v1/node` already
//! publishes and a device pins at pairing. The descriptor names the node's X25519 static key — the
//! fingerprint a person compares, and the key pairing actually checks — so the two identities are
//! in one signed record. Before pairing that binding is self-asserted: a seed can hand out a
//! descriptor that names someone else's fingerprint with a key of its own. That is why a descriptor
//! is a candidate and never a trust decision, and why pairing is still required.

use std::collections::HashMap;
use std::net::{IpAddr, SocketAddr};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use axum::body::Bytes;
use axum::extract::{ConnectInfo, Query, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use base64::Engine as _;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use ed25519_dalek::{Signature, VerifyingKey};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use crate::devices::{Devices, KnownNodes, StaticKey, fingerprint};
use crate::fsutil;
use crate::receipts::ReceiptKey;

/// The descriptor version this build mints and the only one it accepts. A new field means a new
/// version; unknown fields are refused rather than dropped, because dropping them would verify a
/// different document from the one that was signed.
pub const VERSION: u64 = 1;
/// Domain separation for the signed bytes: a descriptor signature cannot be replayed as a receipt
/// (those sign `invincible-receipt/<n>`), nor the other way round.
const DOMAIN: &[u8] = b"invincible-discovery/1\n";
/// The default validity: long enough that a seed is useful, short enough that a stale address or
/// a retired model id does not outlive its node by much.
pub const LIFETIME: u64 = 3600;
/// The longest validity a descriptor may claim. A node that wants its record to live longer than
/// this announces again; that keeps every record in the store a recent statement.
pub const MAX_LIFETIME: u64 = 24 * 3600;
/// How far a descriptor's `issued` may be ahead of the verifier's clock.
const CLOCK_SKEW: u64 = 300;
pub const MAX_ADDRESSES: usize = 8;
pub const MAX_MODELS: usize = 32;
pub const MAX_MODEL_LEN: usize = 128;
/// A dispatch capacity beyond this is not a plausible node; it is refused rather than believed.
pub const MAX_INFLIGHT: u64 = 1024;
/// Descriptors the node's own store keeps (`$INVINCIBLE_HOME/discovery.json`).
pub const STORE_LIMIT: usize = 128;
/// The largest record a seed accepts, and the node's own store writes.
pub const MAX_DESCRIPTOR_BYTES: usize = 8 * 1024;
/// A seed's defaults: records held, announces per source address per minute.
pub const SEED_RECORDS: usize = 1000;
pub const SEED_PER_IP: u32 = 30;
/// One TXT string is at most 255 bytes (RFC 6763 §6.1); 200 leaves room for the `d<n>=` key.
pub const TXT_CHUNK: usize = 200;
/// Eight chunks is 1600 bytes of base64: a descriptor that needs more is not announced over mDNS.
pub const MAX_TXT_CHUNKS: usize = 8;

/// The service type paired nodes are found under on a LAN.
pub const LAN_SERVICE: &str = "_invincible._udp.local.";

// ---------------------------------------------------------------------------------------------
// The descriptor

/// `[node] dispatch_max_inflight` as a descriptor states it: how many dispatched requests this
/// node will run at once. Zero means "spoken for" and is a true statement, not an absence.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Dispatch {
    pub max_inflight: u64,
}

/// What a node tells a stranger. No paths, no usage, no peer list, no key material: every field
/// here is something the node would answer `GET /v1/models` or a pairing hello with.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Descriptor {
    pub v: u64,
    /// The node's X25519 static public key, base64url — the identity a pairing code carries and
    /// [fingerprint] names. Pairing checks possession of this key; the descriptor cannot.
    pub node: String,
    /// `fingerprint(node)`, carried for reading and checked against `node`, never trusted as an
    /// identity of its own.
    pub fingerprint: String,
    /// The node's Ed25519 receipt key, base64url: what signed this record, and what a paired
    /// device already pinned at pairing.
    pub sign_key: String,
    /// `host:port` pairs a client may try, in the operator's order. Explicit: nothing is guessed.
    pub addresses: Vec<String>,
    /// Model ids this node serves. Ids only.
    pub models: Vec<String>,
    pub dispatch: Dispatch,
    /// Unix seconds, and the end of the validity.
    pub issued: u64,
    pub expires: u64,
    /// Base64url Ed25519 signature over [Descriptor::body] under `sign_key`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sig: Option<String>,
}

/// Why a descriptor was refused, and which check refused it. `field` is a descriptor field name
/// (`node`, `fingerprint`, `expires`, `signature`, …) or `txt` for the mDNS reassembly.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Invalid {
    pub field: String,
    pub reason: String,
}

impl Invalid {
    pub fn at(field: impl Into<String>, reason: impl Into<String>) -> Self {
        Self { field: field.into(), reason: reason.into() }
    }
}

impl std::fmt::Display for Invalid {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "`{}`: {}", self.field, self.reason)
    }
}

impl std::error::Error for Invalid {}

/// Seconds since the Unix epoch.
pub fn now() -> Result<u64, String> {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).map_err(|e| format!("clock: {e}"))
}

/// What a node puts in its own descriptor, from config: nothing here is detected.
pub struct Advert {
    pub addresses: Vec<String>,
    pub models: Vec<String>,
    pub max_inflight: u64,
    pub lifetime: u64,
}

/// Mints and signs this node's descriptor for [Advert]. `issued` is now, `expires` now + lifetime.
pub fn mint(node: &StaticKey, signer: &ReceiptKey, advert: Advert) -> Result<Descriptor, String> {
    let issued = now()?;
    let lifetime = advert.lifetime.clamp(60, MAX_LIFETIME);
    let mut descriptor = Descriptor {
        v: VERSION,
        node: URL_SAFE_NO_PAD.encode(&node.public),
        fingerprint: fingerprint(&node.public),
        sign_key: signer.public(),
        addresses: advert.addresses,
        models: advert.models,
        dispatch: Dispatch { max_inflight: advert.max_inflight },
        issued,
        expires: issued.saturating_add(lifetime),
        sig: None,
    };
    descriptor.sign(signer)?;
    // Refuse to publish something we would refuse ourselves.
    descriptor.verify(issued).map_err(|e| format!("this node's descriptor would not verify: {e}"))?;
    Ok(descriptor)
}

impl Descriptor {
    /// The bytes `sig` signs: the domain prefix, then the canonical JSON (RFC 8785) of every field
    /// but `sig`. Canonical, so two encoders produce the same bytes; every field, so none of them
    /// can be altered.
    pub fn body(&self) -> Result<String, String> {
        let mut value = serde_json::to_value(self).map_err(|e| e.to_string())?;
        if let Some(object) = value.as_object_mut() {
            object.remove("sig");
        }
        crate::receipts::canonical(&value)
    }

    /// Signs this descriptor in place with the node's receipt key.
    pub fn sign(&mut self, signer: &ReceiptKey) -> Result<(), String> {
        self.sign_key = signer.public();
        let message = [DOMAIN, self.body()?.as_bytes()].concat();
        self.sig = Some(signer.sign_bytes(&message));
        Ok(())
    }

    /// Every rule a descriptor must pass, in one place, naming the field that failed.
    ///
    /// Cheap structural and time checks come first, so an expired or misaddressed record is
    /// refused with a useful message; the signature is checked last, over the whole body. A
    /// signature failure cannot say *which* field was altered — that is what a single signature
    /// over a document means — so it names `signature` and lists the covered fields.
    pub fn verify(&self, at: u64) -> Result<(), Invalid> {
        if self.v != VERSION {
            return Err(Invalid::at("v", format!("version {} is not known (this build knows {VERSION})", self.v)));
        }
        let node = decode32(&self.node).ok_or_else(|| Invalid::at("node", "not 32 base64url bytes"))?;
        let actual = fingerprint(&node);
        if self.fingerprint != actual {
            return Err(Invalid::at(
                "fingerprint",
                format!("{} does not match the node key, whose fingerprint is {actual}", self.fingerprint),
            ));
        }
        let sign_key = decode32(&self.sign_key).ok_or_else(|| Invalid::at("sign_key", "not 32 base64url bytes"))?;
        let verifying = VerifyingKey::from_bytes(&sign_key)
            .map_err(|e| Invalid::at("sign_key", format!("not an Ed25519 key: {e}")))?;

        if self.addresses.is_empty() {
            return Err(Invalid::at("addresses", "a descriptor with no address is useless"));
        }
        if self.addresses.len() > MAX_ADDRESSES {
            return Err(Invalid::at(
                "addresses",
                format!("{} addresses (at most {MAX_ADDRESSES})", self.addresses.len()),
            ));
        }
        for address in &self.addresses {
            if let Some(problem) = address_problem(address) {
                return Err(Invalid::at("addresses", format!("{address:?}: {problem}")));
            }
        }
        if self.models.len() > MAX_MODELS {
            return Err(Invalid::at("models", format!("{} models (at most {MAX_MODELS})", self.models.len())));
        }
        for model in &self.models {
            if model.is_empty() || model.len() > MAX_MODEL_LEN {
                return Err(Invalid::at("models", format!("{model:?}: a model id is 1-{MAX_MODEL_LEN} bytes")));
            }
            if model.chars().any(char::is_control) {
                return Err(Invalid::at("models", format!("{model:?}: control characters")));
            }
        }
        if self.dispatch.max_inflight > MAX_INFLIGHT {
            return Err(Invalid::at(
                "dispatch",
                format!("max_inflight {} is above {MAX_INFLIGHT}", self.dispatch.max_inflight),
            ));
        }
        // The same cap a seed applies to its body: a record that cannot be announced is not valid.
        let size = serde_json::to_vec(self).map_err(|e| Invalid::at("body", e.to_string()))?.len();
        if size > MAX_DESCRIPTOR_BYTES {
            return Err(Invalid::at("body", format!("{size} bytes (at most {MAX_DESCRIPTOR_BYTES})")));
        }
        if self.expires <= self.issued {
            return Err(Invalid::at("expires", format!("expiry {} is not after issue {}", self.expires, self.issued)));
        }
        if self.expires - self.issued > MAX_LIFETIME {
            return Err(Invalid::at(
                "expires",
                format!("lifetime {} s is above {MAX_LIFETIME} s", self.expires - self.issued),
            ));
        }
        if self.issued > at.saturating_add(CLOCK_SKEW) {
            return Err(Invalid::at("issued", format!("issued {} s in the future", self.issued - at)));
        }
        if self.expires <= at {
            return Err(Invalid::at("expires", format!("expired {} s ago", at - self.expires)));
        }

        let sig = self.sig.as_ref().ok_or_else(|| Invalid::at("signature", "the descriptor is not signed"))?;
        let sig = URL_SAFE_NO_PAD
            .decode(sig)
            .ok()
            .and_then(|bytes| <[u8; 64]>::try_from(bytes).ok())
            .ok_or_else(|| Invalid::at("signature", "not 64 base64url bytes"))?;
        let body = self.body().map_err(|e| Invalid::at("body", e))?;
        let message = [DOMAIN, body.as_bytes()].concat();
        let signature = Signature::from_bytes(&sig);
        verifying.verify_strict(&message, &signature).map_err(|_| {
            Invalid::at(
                "signature",
                "does not verify over the body: a signed field was altered (node, fingerprint, sign_key, \
                 addresses, models, dispatch, issued, expires)",
            )
        })?;
        Ok(())
    }

    /// Seconds of validity left at [at]; zero when expired.
    pub fn remaining(&self, at: u64) -> u64 {
        self.expires.saturating_sub(at)
    }

    /// How this node is trusted from here, if at all. Read-only and for display: nothing in this
    /// module changes either list. A pinned node whose record is signed by a different key than
    /// the receipt key pinned at pairing is called out: that record cannot have come from it.
    pub fn trust(&self, devices: &Devices, known: &KnownNodes) -> String {
        if let Some(node) = known.0.iter().find(|node| node.key == self.node) {
            return match node.receipt_key.as_deref() {
                Some(pinned) if pinned != self.sign_key => {
                    format!("paired as node \"{}\" — signed by another key", node.name)
                }
                _ => format!("paired as node \"{}\"", node.name),
            };
        }
        if let Some(name) = devices.list().iter().find(|device| device.key == self.node).map(|d| d.name.clone()) {
            return format!("paired device \"{name}\"");
        }
        "unpaired".to_owned()
    }
}

fn decode32(text: &str) -> Option<[u8; 32]> {
    URL_SAFE_NO_PAD.decode(text).ok().and_then(|bytes| <[u8; 32]>::try_from(bytes).ok())
}

/// Why [address] is not a usable `host:port`, or `None` when it is. Syntax only: discovery does
/// not resolve names, and a name that does not resolve is a failed connect attempt, not a lie.
pub fn address_problem(address: &str) -> Option<String> {
    if address.len() > 255 {
        return Some("longer than 255 bytes".to_owned());
    }
    if address.chars().any(|c| c.is_whitespace() || c.is_control()) {
        return Some("whitespace".to_owned());
    }
    if address.contains("://") || address.contains('/') {
        return Some("a bare host:port, not a URL".to_owned());
    }
    let Some((host, port)) = address.rsplit_once(':') else {
        return Some("no port".to_owned());
    };
    if host.is_empty() {
        return Some("no host".to_owned());
    }
    if host.starts_with('[') != host.ends_with(']') {
        return Some("an IPv6 host is written [::1]:7778".to_owned());
    }
    match port.parse::<u16>() {
        Ok(0) | Err(_) => Some(format!("{port:?} is not a port")),
        Ok(_) => None,
    }
}

// ---------------------------------------------------------------------------------------------
// The store: descriptors this node has verified

/// `$INVINCIBLE_HOME/discovery.json`: the descriptors this node has seen and verified. Expired
/// ones are dropped on load and on every write, so the file is a statement of what might be
/// reachable now, not a history. Nothing here is a trust list.
pub struct Store {
    path: PathBuf,
    list: Mutex<Vec<Descriptor>>,
}

impl Store {
    pub fn path(home: &Path) -> PathBuf {
        home.join("discovery.json")
    }

    pub fn load(path: &Path) -> Result<Self, String> {
        let at = now()?;
        let list: Vec<Descriptor> = match fsutil::read_optional(path)? {
            Some(text) => serde_json::from_str(&text).map_err(|e| format!("{}: {e}", path.display()))?,
            None => Vec::new(),
        };
        // A store is not a source of truth: a record that no longer verifies (or expired while the
        // process was down) is dropped rather than shown.
        let mut kept: Vec<Descriptor> = list.into_iter().filter(|descriptor| descriptor.verify(at).is_ok()).collect();
        sort_newest_first(&mut kept);
        kept.truncate(STORE_LIMIT);
        Ok(Self { path: path.to_owned(), list: Mutex::new(kept) })
    }

    pub fn list(&self) -> Vec<Descriptor> {
        // Expiry is checked at read time too: a node that has been up for hours must not show a
        // descriptor that stopped being true.
        let at = now().unwrap_or(0);
        let list = self.list.lock().expect("discovery store lock");
        list.iter().filter(|descriptor| descriptor.expires > at).cloned().collect()
    }

    /// Verifies [descriptor] at [at] and keeps it if it passes. One record per (node, sign_key):
    /// a newer announcement replaces the older one.
    pub fn insert_at(&self, descriptor: &Descriptor, at: u64) -> Result<(), Invalid> {
        descriptor.verify(at)?;
        let mut list = self.list.lock().expect("discovery store lock");
        list.retain(|held| held.verify(at).is_ok());
        list.retain(|held| !(held.node == descriptor.node && held.sign_key == descriptor.sign_key));
        list.push(descriptor.clone());
        sort_newest_first(&mut list);
        list.truncate(STORE_LIMIT);
        let text = serde_json::to_string_pretty(&*list).expect("descriptors serialise");
        drop(list);
        self.save(&text).map_err(|e| Invalid::at("store", e))
    }

    pub fn insert(&self, descriptor: &Descriptor) -> Result<(), Invalid> {
        let at = now().map_err(|e| Invalid::at("store", e))?;
        self.insert_at(descriptor, at)
    }

    fn save(&self, text: &str) -> Result<(), String> {
        fsutil::replace_private(&self.path, text)
    }
}

fn sort_newest_first(list: &mut [Descriptor]) {
    list.sort_by(|a, b| b.issued.cmp(&a.issued).then_with(|| a.fingerprint.cmp(&b.fingerprint)));
}

// ---------------------------------------------------------------------------------------------
// Seeds: a dumb store for signed records

/// A seed holds records and hands them back. It does not sign, score, verify or decide; the
/// checks it applies are the ones that keep it from being a free file host — size, shape, rate,
/// count — and a consumer must verify every record it receives anyway.
pub struct Seed {
    records: Mutex<Vec<Descriptor>>,
    max: usize,
    per_ip_per_min: u32,
    rate: Mutex<HashMap<IpAddr, Bucket>>,
}

#[derive(Clone, Copy)]
struct Bucket {
    start: Instant,
    count: u32,
}

impl Seed {
    pub fn new(max: usize) -> Self {
        Self::with_rate(max, SEED_PER_IP)
    }

    pub fn with_rate(max: usize, per_ip_per_min: u32) -> Self {
        Self {
            records: Mutex::new(Vec::new()),
            max: max.max(1),
            per_ip_per_min: per_ip_per_min.max(1),
            rate: Mutex::new(HashMap::new()),
        }
    }

    pub fn records(&self) -> Vec<Descriptor> {
        self.records.lock().expect("seed lock").clone()
    }

    /// One announce from [ip] at [at]: false when that address is over its minute's allowance.
    fn allowed(&self, ip: IpAddr, at: Instant) -> bool {
        let mut rate = self.rate.lock().expect("seed rate lock");
        let bucket = rate.entry(ip).or_insert(Bucket { start: at, count: 0 });
        if at.duration_since(bucket.start) >= Duration::from_secs(60) {
            *bucket = Bucket { start: at, count: 0 };
        }
        if bucket.count >= self.per_ip_per_min {
            return false;
        }
        bucket.count += 1;
        true
    }

    /// Shape checks only, no signature: the record is stored exactly as given.
    fn accept(&self, descriptor: &Descriptor, at: u64) -> Result<(), Invalid> {
        if descriptor.sig.is_none() {
            return Err(Invalid::at("signature", "an unsigned record is not stored"));
        }
        for (field, value) in [("node", &descriptor.node), ("sign_key", &descriptor.sign_key)] {
            if decode32(value).is_none() {
                return Err(Invalid::at(field, "not 32 base64url bytes"));
            }
        }
        if descriptor.addresses.is_empty() {
            return Err(Invalid::at("addresses", "no address"));
        }
        if descriptor.expires <= at {
            return Err(Invalid::at("expires", "already expired"));
        }
        let mut records = self.records.lock().expect("seed lock");
        records.retain(|held| held.expires > at);
        let key = |d: &Descriptor| (d.node.clone(), d.sign_key.clone());
        if let Some(slot) = records.iter_mut().find(|held| key(held) == key(descriptor)) {
            *slot = descriptor.clone();
            return Ok(());
        }
        if records.len() >= self.max {
            return Err(Invalid::at("seed", format!("full: {} records", self.max)));
        }
        records.push(descriptor.clone());
        Ok(())
    }
}

/// The seed's two endpoints: `POST /v1/discovery/announce` and
/// `GET /v1/discovery/peers?fingerprint=`.
pub fn seed_app(seed: Arc<Seed>) -> Router {
    Router::new()
        .route(
            "/v1/discovery/announce",
            post(seed_announce).layer(axum::extract::DefaultBodyLimit::max(MAX_DESCRIPTOR_BYTES)),
        )
        .route("/v1/discovery/peers", get(seed_peers))
        .with_state(seed)
}

async fn seed_announce(
    State(seed): State<Arc<Seed>>,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    body: Bytes,
) -> Response {
    if !seed.allowed(addr.ip(), Instant::now()) {
        return failure(
            StatusCode::TOO_MANY_REQUESTS,
            "rate_limited",
            "too many announces from this address; try again in a minute",
        );
    }
    let Ok(at) = now() else {
        return failure(StatusCode::INTERNAL_SERVER_ERROR, "clock", "the seed's clock is before the epoch");
    };
    let descriptor: Descriptor = match serde_json::from_slice(&body) {
        Ok(descriptor) => descriptor,
        Err(e) => return failure(StatusCode::BAD_REQUEST, "invalid_descriptor", &format!("body: {e}")),
    };
    if let Err(invalid) = seed.accept(&descriptor, at) {
        if invalid.field == "seed" {
            return failure(StatusCode::SERVICE_UNAVAILABLE, "seed_full", &invalid.to_string());
        }
        return failure(StatusCode::BAD_REQUEST, "invalid_descriptor", &invalid.to_string());
    }
    Json(json!({
        "stored": true,
        "fingerprint": descriptor.fingerprint,
        "records": seed.records.lock().expect("seed lock").len(),
    }))
    .into_response()
}

#[derive(Deserialize)]
struct PeersQuery {
    #[serde(default)]
    fingerprint: Option<String>,
}

async fn seed_peers(State(seed): State<Arc<Seed>>, Query(query): Query<PeersQuery>) -> Response {
    let at = now().unwrap_or(0);
    let records = seed.records.lock().expect("seed lock");
    let peers: Vec<&Descriptor> = records
        .iter()
        .filter(|descriptor| descriptor.expires > at)
        .filter(|descriptor| query.fingerprint.as_ref().is_none_or(|wanted| &descriptor.fingerprint == wanted))
        .collect();
    Json(json!({ "peers": peers })).into_response()
}

fn failure(status: StatusCode, code: &str, message: &str) -> Response {
    (status, Json(json!({ "error": { "code": code, "message": message } }))).into_response()
}

/// Runs a seed until the process is stopped.
pub async fn serve_seed(seed: Arc<Seed>, listen: SocketAddr) -> Result<(), String> {
    let listener = tokio::net::TcpListener::bind(listen).await.map_err(|e| format!("seed listen on {listen}: {e}"))?;
    axum::serve(listener, seed_app(seed).into_make_service_with_connect_info::<SocketAddr>())
        .await
        .map_err(|e| e.to_string())
}

// ---------------------------------------------------------------------------------------------
// The node's side of a seed: announce, fetch

/// `POST {seed}/v1/discovery/announce` with this node's signed descriptor.
pub async fn announce_to_seed(client: &reqwest::Client, seed: &str, descriptor: &Descriptor) -> Result<(), String> {
    let url = endpoint(seed, "/v1/discovery/announce")?;
    let response = client
        .post(&url)
        .json(descriptor)
        .timeout(Duration::from_secs(10))
        .send()
        .await
        .map_err(|e| format!("{url}: {e}"))?;
    let status = response.status();
    let body: Value = response.json().await.unwrap_or(Value::Null);
    if status.is_success() {
        return Ok(());
    }
    Err(format!("{url}: {status}: {}", body["error"]["message"].as_str().unwrap_or("no reason given")))
}

/// `GET {seed}/v1/discovery/peers?fingerprint=` — every record, or one fingerprint's.
pub async fn fetch_peers(
    client: &reqwest::Client,
    seed: &str,
    fingerprint: Option<&str>,
) -> Result<Vec<Descriptor>, String> {
    let path = match fingerprint {
        Some(fingerprint) => format!("/v1/discovery/peers?fingerprint={}", urlencode(fingerprint)),
        None => "/v1/discovery/peers".to_owned(),
    };
    let url = endpoint(seed, &path)?;
    let response = client.get(&url).timeout(Duration::from_secs(10)).send().await.map_err(|e| format!("{url}: {e}"))?;
    let status = response.status();
    let body: Value = response.json().await.map_err(|e| format!("{url}: {e}"))?;
    if !status.is_success() {
        return Err(format!("{url}: {status}: {}", body["error"]["message"].as_str().unwrap_or("no reason given")));
    }
    serde_json::from_value(body["peers"].clone()).map_err(|e| format!("{url}: peers: {e}"))
}

/// [seed] with [path] appended, insisting on http(s): a seed URL is a place to send a signed
/// record, not a file path or another scheme.
fn endpoint(seed: &str, path: &str) -> Result<String, String> {
    let seed = seed.trim_end_matches('/');
    let parsed = reqwest::Url::parse(seed).map_err(|e| format!("seed {seed:?}: {e}"))?;
    if !matches!(parsed.scheme(), "http" | "https") {
        return Err(format!("seed {seed:?}: only http:// and https:// seeds"));
    }
    Ok(format!("{seed}{path}"))
}

fn urlencode(value: &str) -> String {
    value
        .bytes()
        .map(|b| match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => char::from(b).to_string(),
            other => format!("%{other:02X}"),
        })
        .collect()
}

// ---------------------------------------------------------------------------------------------
// mDNS on a LAN: the descriptor travels in TXT records, nothing is fetched

/// The TXT records for [descriptor]: `v`, `fp`, then the signed JSON base64url in `d0..dN`.
/// Pure, so it is testable without multicast; the mDNS socket itself is untested here.
pub fn txt_records(descriptor: &Descriptor) -> Result<Vec<(String, String)>, String> {
    let json = serde_json::to_string(descriptor).map_err(|e| e.to_string())?;
    let encoded = URL_SAFE_NO_PAD.encode(json.as_bytes());
    let chunks = encoded.len().div_ceil(TXT_CHUNK);
    if chunks > MAX_TXT_CHUNKS {
        return Err(format!(
            "descriptor is {} bytes of TXT (at most {} chunks of {TXT_CHUNK})",
            encoded.len(),
            MAX_TXT_CHUNKS
        ));
    }
    let mut records = vec![("v".to_owned(), VERSION.to_string()), ("fp".to_owned(), descriptor.fingerprint.clone())];
    for (index, chunk) in encoded.as_bytes().chunks(TXT_CHUNK).enumerate() {
        records.push((format!("d{index}"), String::from_utf8_lossy(chunk).into_owned()));
    }
    Ok(records)
}

/// The descriptor carried by a resolved service's TXT records. Missing, gapped or malformed
/// chunks are refused with `txt` named; verification is the caller's ([Descriptor::verify]).
pub fn descriptor_from_txt(get: impl Fn(&str) -> Option<String>) -> Result<Descriptor, Invalid> {
    let count = (0..MAX_TXT_CHUNKS).take_while(|index| get(&format!("d{index}")).is_some()).count();
    if count == 0 {
        return Err(Invalid::at("txt", "no descriptor chunks"));
    }
    let mut encoded = String::new();
    for index in 0..count {
        let chunk =
            get(&format!("d{index}")).ok_or_else(|| Invalid::at("txt", format!("chunk d{index} is missing")))?;
        if chunk.len() > TXT_CHUNK {
            return Err(Invalid::at("txt", format!("chunk d{index} is longer than {TXT_CHUNK} bytes")));
        }
        encoded.push_str(&chunk);
    }
    let json = URL_SAFE_NO_PAD.decode(encoded).map_err(|e| Invalid::at("txt", format!("not base64url: {e}")))?;
    if json.len() > MAX_DESCRIPTOR_BYTES {
        return Err(Invalid::at("txt", format!("{} bytes (at most {MAX_DESCRIPTOR_BYTES})", json.len())));
    }
    serde_json::from_slice(&json).map_err(|e| Invalid::at("txt", format!("not a descriptor: {e}")))
}

/// A live mDNS registration. Dropping it stops the daemon, which withdraws the record.
pub struct LanAdvert {
    daemon: mdns_sd::ServiceDaemon,
    pub fullname: String,
}

impl LanAdvert {
    /// Registers [descriptor] under `_invincible._udp.local`, using the first configured address
    /// that is a literal `ip:port` (mDNS resolves names, so it cannot carry one it has not been
    /// told). The addresses in the descriptor itself are what clients try; the SRV/A records only
    /// make the service discoverable.
    pub fn register(descriptor: &Descriptor) -> Result<Self, String> {
        let daemon = mdns_sd::ServiceDaemon::new().map_err(|e| format!("mDNS daemon: {e}"))?;
        let info = lan_info(descriptor)?;
        let fullname = info.get_fullname().to_owned();
        daemon.register(info).map_err(|e| format!("mDNS register: {e}"))?;
        Ok(Self { daemon, fullname })
    }

    /// Replaces the record with a freshly minted one (same instance name, later expiry).
    pub fn refresh(&self, descriptor: &Descriptor) -> Result<(), String> {
        self.daemon.register(lan_info(descriptor)?).map_err(|e| format!("mDNS register: {e}"))
    }
}

fn lan_info(descriptor: &Descriptor) -> Result<mdns_sd::ServiceInfo, String> {
    let (ip, port) = descriptor
        .addresses
        .iter()
        .filter_map(|address| address.parse::<SocketAddr>().ok())
        .find(|addr| !addr.ip().is_unspecified())
        .map(|addr| (addr.ip(), addr.port()))
        .ok_or_else(|| {
            "mDNS needs one [discovery] addresses entry written as ip:port (a hostname cannot be advertised)".to_owned()
        })?;
    let host = format!("{}.local.", descriptor.fingerprint.replace('-', ""));
    let records = txt_records(descriptor)?;
    let properties: Vec<(&str, &str)> = records.iter().map(|(key, value)| (key.as_str(), value.as_str())).collect();
    mdns_sd::ServiceInfo::new(LAN_SERVICE, &descriptor.fingerprint, &host, ip, port, properties.as_slice())
        .map_err(|e| format!("mDNS service info: {e}"))
}

/// Browses for [wait] and returns every descriptor the LAN carried. Records are not verified
/// here; the caller verifies each one. Real multicast is not covered by the test suite.
pub fn browse_lan(wait: Duration) -> Result<Vec<Descriptor>, String> {
    let daemon = mdns_sd::ServiceDaemon::new().map_err(|e| format!("mDNS daemon: {e}"))?;
    let receiver = daemon.browse(LAN_SERVICE).map_err(|e| format!("mDNS browse: {e}"))?;
    let deadline = Instant::now() + wait;
    let mut found: Vec<Descriptor> = Vec::new();
    while let Some(left) = deadline.checked_duration_since(Instant::now()) {
        let step = left.min(Duration::from_millis(500));
        match receiver.recv_timeout(step) {
            Ok(mdns_sd::ServiceEvent::ServiceResolved(resolved)) => {
                let properties = resolved.get_properties();
                let get = |key: &str| properties.get_property_val_str(key).map(str::to_owned);
                if let Ok(descriptor) = descriptor_from_txt(get)
                    && !found.iter().any(|held| held.fingerprint == descriptor.fingerprint)
                {
                    found.push(descriptor);
                }
            }
            Ok(_) => {}
            Err(_) => {}
        }
    }
    let _ = daemon.stop_browse(LAN_SERVICE);
    let _ = daemon.shutdown();
    Ok(found)
}

/// What the local API shows: this node's own descriptor (when it announces one), and the verified
/// records it holds.
pub struct Discovery {
    pub own: Option<Descriptor>,
    pub store: Store,
    pub seeds: Vec<String>,
}

#[cfg(test)]
mod tests {
    use std::net::IpAddr;

    use super::*;

    fn node(byte: u8) -> StaticKey {
        StaticKey { private: vec![byte; 32], public: vec![byte.wrapping_add(1); 32] }
    }

    fn descriptor() -> Descriptor {
        let at = 1_800_000_000;
        let mut descriptor = Descriptor {
            v: VERSION,
            node: URL_SAFE_NO_PAD.encode([10u8; 32]),
            fingerprint: fingerprint(&[10u8; 32]),
            sign_key: String::new(),
            addresses: vec!["192.0.2.10:7778".to_owned()],
            models: vec!["qwen3-4b".to_owned(), "llama-3-8b".to_owned()],
            dispatch: Dispatch { max_inflight: 2 },
            issued: at,
            expires: at + LIFETIME,
            sig: None,
        };
        descriptor.sign(&ReceiptKey::from_seed(&[7u8; 32])).unwrap();
        descriptor
    }

    #[test]
    fn a_descriptor_round_trips_sign_and_verify() {
        let descriptor = descriptor();
        descriptor.verify(1_800_000_010).unwrap();
        // The body is canonical JSON: key order and whitespace cannot change what was signed.
        assert!(descriptor.body().unwrap().starts_with("{\"addresses\":"));
        let reparsed: Descriptor = serde_json::from_str(&serde_json::to_string(&descriptor).unwrap()).unwrap();
        assert_eq!(reparsed, descriptor);
        reparsed.verify(1_800_000_010).unwrap();
    }

    #[test]
    fn a_tampered_field_is_refused() {
        // One signature over the whole body cannot say which byte changed; it names `signature`
        // and lists the covered fields.
        let changes: [fn(&mut Descriptor); 4] = [
            |d: &mut Descriptor| d.addresses = vec!["198.51.100.9:7778".to_owned()],
            |d: &mut Descriptor| d.models.push("smuggled".to_owned()),
            |d: &mut Descriptor| d.dispatch.max_inflight = 99,
            |d: &mut Descriptor| d.expires += 60,
        ];
        for change in changes {
            let mut tampered = descriptor();
            change(&mut tampered);
            let error = tampered.verify(1_800_000_010).unwrap_err();
            assert_eq!(error.field, "signature", "{error}");
            assert!(error.to_string().contains("models"), "{error}");
        }
    }

    #[test]
    fn an_expired_descriptor_is_refused_naming_expires() {
        let descriptor = descriptor();
        let error = descriptor.verify(descriptor.expires).unwrap_err();
        assert_eq!(error.field, "expires");
        assert!(error.to_string().contains("expired"), "{error}");
        descriptor.verify(descriptor.expires - 1).unwrap();
    }

    #[test]
    fn a_descriptor_signed_by_a_different_key_is_refused() {
        let mut descriptor = descriptor();
        // Signed by key B, while `sign_key` still names key A: the signature is under the wrong
        // key for this identity.
        let body = descriptor.body().unwrap();
        let other = ReceiptKey::from_seed(&[9u8; 32]);
        descriptor.sig = Some(other.sign_bytes(&[DOMAIN, body.as_bytes()].concat()));
        let error = descriptor.verify(1_800_000_010).unwrap_err();
        assert_eq!(error.field, "signature", "{error}");
    }

    #[test]
    fn a_fingerprint_that_does_not_match_the_node_key_is_refused() {
        let mut descriptor = descriptor();
        descriptor.fingerprint = fingerprint(&[99u8; 32]);
        descriptor.sign(&ReceiptKey::from_seed(&[7u8; 32])).unwrap();
        let error = descriptor.verify(1_800_000_010).unwrap_err();
        assert_eq!(error.field, "fingerprint", "{error}");
    }

    #[test]
    fn a_future_or_overlong_descriptor_is_refused() {
        let mut future = descriptor();
        future.issued += 3600;
        future.expires = future.issued + 60;
        future.sign(&ReceiptKey::from_seed(&[7u8; 32])).unwrap();
        assert_eq!(future.verify(1_800_000_010).unwrap_err().field, "issued");

        let mut long = descriptor();
        long.expires = long.issued + MAX_LIFETIME + 1;
        long.sign(&ReceiptKey::from_seed(&[7u8; 32])).unwrap();
        assert_eq!(long.verify(1_800_000_010).unwrap_err().field, "expires");
    }

    #[test]
    fn an_unknown_version_or_shape_is_refused() {
        let mut version = descriptor();
        version.v = 2;
        version.sign(&ReceiptKey::from_seed(&[7u8; 32])).unwrap();
        assert_eq!(version.verify(1_800_000_010).unwrap_err().field, "v");

        let mut address = descriptor();
        address.addresses = vec!["http://192.0.2.10:7778/".to_owned()];
        address.sign(&ReceiptKey::from_seed(&[7u8; 32])).unwrap();
        assert_eq!(address.verify(1_800_000_010).unwrap_err().field, "addresses");

        let mut routes = descriptor();
        routes.addresses = (0..=MAX_ADDRESSES).map(|n| format!("192.0.2.1:{}", 7000 + n)).collect();
        routes.sign(&ReceiptKey::from_seed(&[7u8; 32])).unwrap();
        assert_eq!(routes.verify(1_800_000_010).unwrap_err().field, "addresses");

        let mut unsigned = descriptor();
        unsigned.sig = None;
        assert_eq!(unsigned.verify(1_800_000_010).unwrap_err().field, "signature");
    }

    #[test]
    fn mint_refuses_to_publish_what_it_would_refuse() {
        let signer = ReceiptKey::from_seed(&[7u8; 32]);
        let advert = Advert {
            addresses: vec!["192.0.2.10:7778".to_owned()],
            models: vec!["m".to_owned()],
            max_inflight: 1,
            lifetime: LIFETIME,
        };
        let descriptor = mint(&node(1), &signer, advert).unwrap();
        assert!(descriptor.sig.is_some());
        descriptor.verify(descriptor.issued).unwrap();
        // An address that is not host:port is refused before anything is signed.
        let bad = Advert {
            addresses: vec!["https://192.0.2.10:7778".to_owned()],
            models: vec![],
            max_inflight: 1,
            lifetime: LIFETIME,
        };
        assert!(mint(&node(1), &signer, bad).is_err());
    }

    #[test]
    fn the_store_keeps_verified_descriptors_and_drops_expired_ones() {
        let dir = std::env::temp_dir().join(format!("invincible-discovery-{}", std::process::id()));
        let path = dir.join("discovery.json");
        // Real time, because `Store::load` re-verifies against the wall clock.
        let base = now().unwrap();
        let mut descriptor = descriptor();
        descriptor.issued = base;
        descriptor.expires = base + LIFETIME;
        descriptor.sign(&ReceiptKey::from_seed(&[7u8; 32])).unwrap();
        let store = Store::load(&path).unwrap();
        store.insert_at(&descriptor, base).unwrap();
        assert_eq!(store.list(), vec![descriptor.clone()]);

        // A newer announcement for the same node replaces the old one.
        let mut newer = descriptor.clone();
        newer.issued += 10;
        newer.expires += 10;
        newer.sign(&ReceiptKey::from_seed(&[7u8; 32])).unwrap();
        store.insert_at(&newer, base + 20).unwrap();
        assert_eq!(store.list().len(), 1);
        assert_eq!(store.list()[0].expires, newer.expires);

        // Reloading keeps it.
        assert_eq!(Store::load(&path).unwrap().list().len(), 1);
        // A record that expired while the process was down is dropped on load, not shown.
        let mut expired = descriptor.clone();
        expired.issued = base - 7200;
        expired.expires = base - 3600;
        expired.sign(&ReceiptKey::from_seed(&[7u8; 32])).unwrap();
        std::fs::write(&path, serde_json::to_string_pretty(&vec![expired]).unwrap()).unwrap();
        assert!(Store::load(&path).unwrap().list().is_empty());
        std::fs::remove_dir_all(dir).unwrap();

        let empty = Store::load(Path::new("/nonexistent/invincible/discovery.json")).unwrap();
        assert!(empty.list().is_empty());
    }

    #[test]
    fn a_paired_node_signed_by_another_key_is_flagged() {
        use crate::devices::KnownNode;
        let descriptor = descriptor();
        let devices = Devices::load(Path::new("/nonexistent/invincible/devices.json")).unwrap();
        let known = |receipt: String| {
            KnownNodes(vec![KnownNode {
                name: "studio".to_owned(),
                key: descriptor.node.clone(),
                addrs: vec!["192.0.2.1:7778".to_owned()],
                receipt_key: Some(receipt),
                device: None,
                capabilities: Default::default(),
            }])
        };
        assert_eq!(descriptor.trust(&devices, &known(descriptor.sign_key.clone())), "paired as node \"studio\"");
        let other = URL_SAFE_NO_PAD.encode([42u8; 32]);
        assert!(descriptor.trust(&devices, &known(other)).contains("another key"));
    }

    #[test]
    fn a_descriptor_round_trips_through_txt_chunks() {
        let descriptor = descriptor();
        let records = txt_records(&descriptor).unwrap();
        let get = |key: &str| records.iter().find(|(k, _)| k == key).map(|(_, v)| v.clone());
        let back = descriptor_from_txt(get).unwrap();
        assert_eq!(back, descriptor);
        assert!(records.iter().all(|(key, value)| key.len() + value.len() < 255));

        // A gap is refused rather than silently reassembled short.
        let gapped =
            |key: &str| if key == "d1" { None } else { records.iter().find(|(k, _)| k == key).map(|(_, v)| v.clone()) };
        assert_eq!(descriptor_from_txt(gapped).unwrap_err().field, "txt");
    }

    #[test]
    fn a_seed_refuses_an_unsigned_or_expired_record_but_not_a_bad_signature() {
        let seed = Seed::with_rate(4, 100);
        let at = 1_800_000_010;
        let mut unsigned = descriptor();
        unsigned.sig = None;
        assert_eq!(seed.accept(&unsigned, at).unwrap_err().field, "signature");
        seed.accept(&descriptor(), at).unwrap();
        // The seed is dumb on purpose: a forged signature is stored and returned, and the
        // consumer is what refuses it.
        let mut forged = descriptor();
        forged.node = URL_SAFE_NO_PAD.encode([8u8; 32]);
        forged.fingerprint = fingerprint(&[8u8; 32]);
        forged.sig = Some(URL_SAFE_NO_PAD.encode([0u8; 64]));
        seed.accept(&forged, at).unwrap();
        assert_eq!(seed.records().len(), 2);
        assert!(forged.verify(at).is_err());
        assert_eq!(seed.accept(&descriptor(), at + LIFETIME).unwrap_err().field, "expires");
        let _: IpAddr = IpAddr::from([127, 0, 0, 1]);
    }
}
