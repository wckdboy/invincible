//! Signed receipts (spec/receipts.md): for every chat completion, where it ran, what left the node,
//! and — since version 1 — the exchange itself: the request and the answer by hash, when, and who
//! asked. Signed with the node's Ed25519 receipt key.

use std::collections::{BTreeMap, HashMap, VecDeque};
use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, LazyLock, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use axum::body::{Body, Bytes};
use axum::response::Response;
use base64::Engine as _;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use ed25519_dalek::{Signature, Signer, SigningKey, VerifyingKey};
use futures_util::StreamExt;
use invincible_policy::Decision;
use regex::Regex;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

use crate::audit::{AuditLog, Caller};
use crate::fsutil;

pub const REQUEST_ID_HEADER: &str = "invincible-request-id";
/// The receipt version this node writes. A receipt's version is inside the signed message, and
/// picks the domain-separation prefix, so a version 0 receipt verifies as version 0 or not at all.
pub const VERSION: u64 = 1;
/// One per receipt version: the signed message starts with this, so a signature made for one
/// version (or for another protocol's canonical JSON) cannot be replayed as another's.
const PREFIX: [&[u8]; 2] = [b"invincible-receipt/0\n", b"invincible-receipt/1\n"];
const KEEP: usize = 4096;
/// Bytes of the answer kept to find its token usage (it comes last).
const TAIL: usize = 64 * 1024;
/// How far a receipt's timestamp may be ahead of the verifier's clock before it is refused.
const CLOCK_SKEW: u64 = 300;

/// The node's receipt signing key.
pub struct ReceiptKey {
    signing: SigningKey,
    /// The public key, encoded once (every receipt names it).
    public: String,
}

impl ReceiptKey {
    /// Reads the 32-byte seed at [path] (base64url), creating it (mode 0600) when absent.
    pub fn load_or_create(path: &Path) -> Result<Self, String> {
        let seed: [u8; 32] = match fsutil::read_optional(path)? {
            Some(text) => URL_SAFE_NO_PAD
                .decode(text.trim())
                .ok()
                .and_then(|b| b.try_into().ok())
                .ok_or_else(|| format!("{}: not a receipt key", path.display()))?,
            None => {
                let seed = crate::token::random::<32>()?;
                fsutil::create_private(path, &format!("{}\n", URL_SAFE_NO_PAD.encode(seed)))?;
                seed
            }
        };
        Ok(Self::from_seed(&seed))
    }

    pub fn from_seed(seed: &[u8; 32]) -> Self {
        let signing = SigningKey::from_bytes(seed);
        let public = URL_SAFE_NO_PAD.encode(signing.verifying_key().to_bytes());
        Self { signing, public }
    }

    /// The public key, base64url.
    pub fn public(&self) -> String {
        self.public.clone()
    }

    /// Signs raw bytes (the caller supplies domain separation) and returns the signature,
    /// base64url. Used by discovery descriptors; receipts go through [ReceiptKey::sign].
    pub fn sign_bytes(&self, message: &[u8]) -> String {
        URL_SAFE_NO_PAD.encode(self.signing.sign(message).to_bytes())
    }

    /// The signed envelope `{"receipt": …, "signature": …}`.
    pub fn sign(&self, receipt: Value) -> Result<Value, String> {
        let message = [domain(&receipt)?, canonical(&receipt)?.as_bytes()].concat();
        let signature = self.signing.sign(&message);
        Ok(json!({ "receipt": receipt, "signature": URL_SAFE_NO_PAD.encode(signature.to_bytes()) }))
    }
}

/// The domain-separation prefix for [receipt]'s version (spec/receipts.md).
fn domain(receipt: &Value) -> Result<&'static [u8], String> {
    let version = receipt["version"].as_u64().ok_or("a receipt has a numeric `version`")?;
    PREFIX
        .get(usize::try_from(version).unwrap_or(usize::MAX))
        .copied()
        .ok_or_else(|| format!("receipt version {version} is not known (this verifier knows 0 and 1)"))
}

/// Canonical JSON: RFC 8785 (JCS). No whitespace, object keys sorted by their UTF-16 code units,
/// strings escaped minimally (`\"`, `\\`, `\b`, `\f`, `\n`, `\r`, `\t`, other control characters as
/// lowercase `\u00xx`, everything else as UTF-8), and numbers in ECMAScript's form (integers
/// plainly; other values as the shortest decimal that round-trips, in plain notation for
/// 1e-6 ≤ |x| < 1e21 and as `d.ddde±n` outside it). Receipts themselves hold integers only; request
/// bodies may hold any JSON number, so numbers are fully specified here.
pub fn canonical(value: &Value) -> Result<String, String> {
    let mut out = String::new();
    write(value, &mut out)?;
    Ok(out)
}

/// [canonical], written into [out].
fn write(value: &Value, out: &mut String) -> Result<(), String> {
    match value {
        Value::Null => out.push_str("null"),
        Value::Bool(true) => out.push_str("true"),
        Value::Bool(false) => out.push_str("false"),
        Value::Number(n) => out.push_str(&number(n)?),
        Value::String(s) => string(s, out),
        Value::Array(items) => {
            out.push('[');
            for (n, item) in items.iter().enumerate() {
                if n > 0 {
                    out.push(',');
                }
                write(item, out)?;
            }
            out.push(']');
        }
        Value::Object(map) => {
            // JCS sorts by UTF-16 code units, which is not the same order as UTF-8 bytes above
            // U+FFFF; sorting the keys here is what makes two implementations agree.
            let mut keys: Vec<&String> = map.keys().collect();
            keys.sort_by(|a, b| a.encode_utf16().cmp(b.encode_utf16()));
            out.push('{');
            for (n, key) in keys.into_iter().enumerate() {
                if n > 0 {
                    out.push(',');
                }
                string(key, out);
                out.push(':');
                write(&map[key], out)?;
            }
            out.push('}');
        }
    }
    Ok(())
}

fn string(s: &str, out: &mut String) {
    out.push('"');
    for c in s.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\u{8}' => out.push_str("\\b"),
            '\u{c}' => out.push_str("\\f"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if (c as u32) < 0x20 => out.push_str(&format!("\\u{:04x}", c as u32)),
            c => out.push(c),
        }
    }
    out.push('"');
}

fn number(n: &serde_json::Number) -> Result<String, String> {
    if let Some(i) = n.as_i64() {
        return Ok(i.to_string());
    }
    if let Some(u) = n.as_u64() {
        return Ok(u.to_string());
    }
    let f = n.as_f64().ok_or("a number outside the ranges JSON can carry")?;
    if !f.is_finite() {
        return Err("a number is not finite".to_owned());
    }
    if f == 0.0 {
        // -0 and 0 are the same number, and ECMAScript writes both as `0`.
        return Ok("0".to_owned());
    }
    Ok(ecmascript(f))
}

/// ECMAScript's Number::toString for a finite non-zero f64 (RFC 8785 §3.2.2.3), from the shortest
/// digit string that round-trips. Rust's `Display` for f64 is that digit string, in plain notation.
fn ecmascript(f: f64) -> String {
    let text = format!("{f}");
    let text = match text.strip_prefix('-') {
        Some(rest) => rest.to_owned(),
        None => text,
    };
    let negative = f.is_sign_negative();
    let text = text.as_str();
    let (int, frac) = text.split_once('.').unwrap_or((text, ""));
    let digits = format!("{int}{frac}");
    let trimmed = digits.trim_start_matches('0');
    let point = int.len() as i64 - (digits.len() - trimmed.len()) as i64;
    let digits = trimmed.trim_end_matches('0');
    let (k, n) = (digits.len() as i64, point);
    let body = if k <= n && n <= 21 {
        format!("{digits}{}", "0".repeat((n - k) as usize))
    } else if 0 < n && n <= 21 {
        format!("{}.{}", &digits[..n as usize], &digits[n as usize..])
    } else if -6 < n && n <= 0 {
        format!("0.{}{digits}", "0".repeat((-n) as usize))
    } else {
        let mantissa = if k > 1 { format!("{}.{}", &digits[..1], &digits[1..]) } else { digits.to_owned() };
        format!("{mantissa}e{}{}", if n > 0 { '+' } else { '-' }, (n - 1).abs())
    };
    format!("{}{body}", if negative { "-" } else { "" })
}

/// SHA-256 (hex) of [value]'s canonical form.
pub fn hash(value: &Value) -> Result<String, String> {
    Ok(crate::token::hex(&Sha256::digest(canonical(value)?.as_bytes())))
}

/// The request a receipt binds: `{"api": api, "body": body}` canonicalised and hashed. The whole
/// body as the client sent it, so every parameter that can change the answer is covered; the API
/// is included because the same body means a different answer at `/v1/chat/completions` than at
/// `/v1/messages` (spec/receipts.md, "What is bound").
pub fn request_hash(api: &str, body: &Value) -> Result<String, String> {
    hash(&json!({ "api": api, "body": body }))
}

/// The answer a receipt binds: SHA-256 (hex) of the body bytes the client receives, exactly as
/// they leave this node — de-chunked, no HTTP framing, and for a stream the events' text in order.
pub fn answer_hash(bytes: &[u8]) -> String {
    crate::token::hex(&Sha256::digest(bytes))
}

/// What a verified receipt turned out to be.
#[derive(Debug, PartialEq, Eq)]
pub struct Verified {
    pub version: u64,
    /// Whether it binds the exchange (request, answer, time, caller): version 1 does.
    pub bound: bool,
}

/// Checks [receipt] against [public_key] (spec/receipts.md): its version, that it names this key as
/// its node, the signature over its canonical form, and — for version 1 — that it carries the
/// fields that bind the exchange. Nothing is recomputed from a request or answer here; [inspect]
/// does that, and says so.
pub fn check(public_key: &str, receipt: &Value, signature: &str) -> Result<Verified, String> {
    let prefix = domain(receipt)?;
    let version = receipt["version"].as_u64().unwrap_or_default();
    match receipt["node"].as_str() {
        Some(node) if node == public_key => {}
        Some(node) => return Err(format!("the receipt is node {node}'s, not the key it was checked against")),
        None => return Err("the receipt does not name its node".to_owned()),
    }
    let key = URL_SAFE_NO_PAD
        .decode(public_key)
        .ok()
        .and_then(|b| <[u8; 32]>::try_from(b).ok())
        .and_then(|b| VerifyingKey::from_bytes(&b).ok())
        .ok_or("the public key is not an Ed25519 key (base64url, 32 bytes)")?;
    let signature = URL_SAFE_NO_PAD
        .decode(signature)
        .ok()
        .and_then(|b| <[u8; 64]>::try_from(b).ok())
        .map(|b| Signature::from_bytes(&b))
        .ok_or("the signature is not Ed25519 (base64url, 64 bytes)")?;
    let canonical = canonical(receipt)?;
    key.verify_strict(&[prefix, canonical.as_bytes()].concat(), &signature)
        .map_err(|_| "the signature does not verify: the receipt was changed after it was signed".to_owned())?;
    if version < VERSION {
        return Ok(Verified { version, bound: false });
    }
    // Signed, but it must also carry what version 1 promises: a receipt that was stripped of its
    // bindings is not one this verifier will call bound.
    for field in ["at", "caller", "request_sha256", "answer_sha256", "answer_bytes", "answer_complete"] {
        if receipt.get(field).is_none() {
            return Err(format!("a version {version} receipt must carry `{field}`"));
        }
    }
    Ok(Verified { version, bound: true })
}

/// Whether [signature] is [public_key]'s signature of [receipt] (spec/receipts.md).
pub fn verify(public_key: &str, receipt: &Value, signature: &str) -> bool {
    check(public_key, receipt, signature).is_ok()
}

/// A hexadecimal SHA-256, as receipts carry them.
fn hex_hash(value: &Value, field: &str) -> Result<String, String> {
    let text = value.as_str().ok_or_else(|| format!("`{field}` is not a string"))?;
    if text.len() == 64 && text.chars().all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase()) {
        Ok(text.to_owned())
    } else {
        Err(format!("`{field}` is not a SHA-256 in lowercase hex"))
    }
}

fn now() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or_default()
}

/// The offline check `invincible receipt verify` prints (spec/receipts.md, "Verifying"): what it
/// checked, what it could not check, and the claims it read. [request] is the request body as the
/// client sent it and [answer] the body bytes as the client received them; without them the hashes
/// are reported, not checked — and the report says so.
pub fn inspect(
    public_key: &str,
    envelope: &Value,
    request: Option<&Value>,
    answer: Option<&[u8]>,
) -> Result<Value, String> {
    let receipt = &envelope["receipt"];
    let signature = envelope["signature"].as_str().ok_or("the envelope has no `signature`")?;
    let verified = check(public_key, receipt, signature)?;
    let mut checked = vec![
        json!("the receipt names the key given as its node"),
        json!("the Ed25519 signature over the canonical form"),
    ];
    let mut not_checked = vec![
        json!("that the model in `decision` ran at all, or on the hardware the node names"),
        json!("that the answer is correct, or came from that model"),
        json!("that the node's clock was right when it signed"),
        json!("that the caller is the device named (`caller.key` is the key the node pinned at pairing)"),
    ];
    let mut report = json!({
        "version": verified.version,
        "bound": verified.bound,
        "request_id": receipt["request_id"],
        "node": receipt["node"],
        "checked": checked,
        "not_checked": not_checked,
    });
    if !verified.bound {
        // A version 0 receipt signs routing and accounting only: there is nothing to recompute.
        report["not_checked"] = json!([
            "anything about the exchange: a version 0 receipt binds no request, answer, caller or time",
            "that the model in `decision` ran at all, or on the hardware the node names",
            "that the answer is correct, or came from that model",
            "that the node's clock was right when it signed",
        ]);
        return Ok(report);
    }
    let at = receipt["at"].as_u64().ok_or("`at` is not a unix time in seconds")?;
    let now = now();
    if at > now + CLOCK_SKEW {
        return Err(format!(
            "the timestamp is {}s in the future: the node's clock, or the receipt, is wrong",
            at - now
        ));
    }
    checked.push(json!("the timestamp is a unix time, not more than 300s ahead of this clock"));
    report["at"] = json!(at);
    report["at_ago"] = json!(now.saturating_sub(at));
    report["api"] = receipt["api"].clone();
    report["caller"] = receipt["caller"].clone();
    match &receipt["caller"] {
        Value::Object(caller) if caller.get("kind").is_some() => {}
        _ => return Err("`caller` is not an object with a `kind`".to_owned()),
    }
    report["answer_bytes"] = receipt["answer_bytes"].clone();
    report["answer_complete"] = receipt["answer_complete"].clone();
    let claimed_request = hex_hash(&receipt["request_sha256"], "request_sha256")?;
    let claimed_answer = hex_hash(&receipt["answer_sha256"], "answer_sha256")?;
    report["request_sha256"] = json!(claimed_request);
    report["answer_sha256"] = json!(claimed_answer);
    match request {
        Some(body) => {
            let api = receipt["api"].as_str().ok_or("`api` is not a string")?;
            let actual = request_hash(api, body)?;
            if actual != claimed_request {
                return Err(format!(
                    "the request is not the one this receipt binds: it hashes to {actual}, the receipt says {claimed_request}"
                ));
            }
            checked.push(json!("the request body given hashes to `request_sha256`"));
        }
        None => not_checked.push(json!("the request: pass the body the client sent to recompute `request_sha256`")),
    }
    match answer {
        Some(bytes) => {
            let actual = answer_hash(bytes);
            if actual != claimed_answer {
                return Err(format!(
                    "the answer is not the one this receipt binds: it hashes to {actual}, the receipt says {claimed_answer}"
                ));
            }
            if receipt["answer_bytes"].as_u64() != Some(bytes.len() as u64) {
                return Err(format!(
                    "the answer is {} bytes, the receipt says {}",
                    bytes.len(),
                    receipt["answer_bytes"]
                ));
            }
            checked.push(json!("the answer bytes given hash to `answer_sha256`, and are `answer_bytes` long"));
        }
        None => not_checked.push(json!("the answer: pass the bytes the client received to recompute `answer_sha256`")),
    }
    report["checked"] = json!(checked);
    report["not_checked"] = json!(not_checked);
    Ok(report)
}

/// The most recent receipts, in memory only.
#[derive(Default)]
pub struct ReceiptStore {
    inner: Mutex<StoreInner>,
}

#[derive(Default)]
struct StoreInner {
    done: HashMap<String, Value>,
    order: VecDeque<String>,
    pending: HashMap<String, ()>,
}

impl ReceiptStore {
    fn begin(&self, id: &str) {
        self.inner.lock().expect("receipts lock").pending.insert(id.to_owned(), ());
    }

    fn finish(&self, id: &str, envelope: Value) {
        let mut inner = self.inner.lock().expect("receipts lock");
        inner.pending.remove(id);
        inner.done.insert(id.to_owned(), envelope);
        inner.order.push_back(id.to_owned());
        while inner.order.len() > KEEP {
            if let Some(old) = inner.order.pop_front() {
                inner.done.remove(&old);
            }
        }
    }

    /// The receipt for [id], waiting up to 10 seconds for a request that is still running.
    pub async fn get(&self, id: &str) -> Option<Value> {
        for _ in 0..200 {
            {
                let inner = self.inner.lock().expect("receipts lock");
                if let Some(envelope) = inner.done.get(id) {
                    return Some(envelope.clone());
                }
                if !inner.pending.contains_key(id) {
                    return None;
                }
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        None
    }
}

/// One attempt to reach a host off the node.
pub struct Attempt {
    pub host: String,
    pub route: &'static str,
    pub sent: u64,
    pub received: Arc<AtomicU64>,
    pub ok: bool,
}

/// A receipt being written while its request runs.
pub struct Draft {
    /// The request id, already decided before the answer starts: the one in the `invincible-request-id`
    /// response header, in the signed receipt, and on the audit line (crate::receipts::attach sets
    /// the header from it; no second id is ever made for the same request).
    pub id: String,
    pub decision: Option<Decision>,
    pub data_policy: Option<String>,
    pub redactions: BTreeMap<&'static str, usize>,
    pub attempts: Vec<Attempt>,
    /// The images the request carried, by hash, size and type ([crate::media::Image]); never
    /// their bytes.
    pub images: Vec<Value>,
    /// The nodes that computed the answer, when a model split across paired nodes ran
    /// (spec/cluster.md).
    pub cluster: Vec<crate::cluster::ShardUse>,
    /// For the audit log, not the receipt: who asked, the client they named, which API.
    pub caller: crate::audit::Caller,
    pub client: Option<String>,
    pub api: &'static str,
    /// The head this request was dispatched through and the node that answered it
    /// (spec/dispatch.md, `dispatch`). It is in the signed receipt as well as the audit line: a
    /// client that cannot learn which machine answered cannot check the claim, and a dispatch
    /// receipt naming only the head reads as if the head did the work.
    pub dispatch: Option<Value>,
    /// The request as bound: `{"api", "body"}` canonicalised and hashed, then dropped — a receipt
    /// holds the hash of the request, never the prompt.
    request_sha256: Option<String>,
    /// The answer as it is sent: every byte in order, hashed as it goes.
    answer: Sha256,
    answer_bytes: u64,
    /// Whether the answer's body ended on its own, rather than the client going away mid-stream.
    complete: bool,
    /// The usage a streamed cloud answer reported in a chunk kept back from the client (the node
    /// asked for it, the client did not: crate::cloud::prepare). The answer's tokens.
    pub withheld_usage: Arc<Mutex<Option<Value>>>,
    /// The answer's status ([attach]).
    status: u16,
    tail: Vec<u8>,
}

impl Draft {
    pub fn new() -> Result<Self, String> {
        Ok(Self {
            id: crate::token::hex(&crate::token::random::<16>()?),
            decision: None,
            data_policy: None,
            redactions: BTreeMap::new(),
            attempts: Vec::new(),
            images: Vec::new(),
            cluster: Vec::new(),
            caller: crate::audit::Caller::Local,
            client: None,
            api: "chat",
            dispatch: None,
            request_sha256: None,
            answer: Sha256::new(),
            answer_bytes: 0,
            complete: false,
            withheld_usage: Arc::default(),
            status: 200,
            tail: Vec::new(),
        })
    }

    /// Binds the request this receipt is for: [body] as the client sent it, at [api]'s endpoint
    /// (spec/receipts.md, "What is bound").
    pub fn bind_request(&mut self, api: &'static str, body: &Value) {
        self.api = api;
        match request_hash(api, body) {
            Ok(hash) => self.request_sha256 = Some(hash),
            Err(e) => tracing::error!("request not bound to its receipt: {e}"),
        }
    }

    fn observe(&mut self, bytes: &[u8]) {
        self.answer.update(bytes);
        self.answer_bytes += bytes.len() as u64;
        self.tail.extend_from_slice(bytes);
        // Cut back only when it is twice the size kept: not a 64 KiB move for every chunk of a
        // long stream.
        if self.tail.len() > 2 * TAIL {
            let cut = self.tail.len() - TAIL;
            self.tail.drain(..cut);
        }
    }

    /// The receipt as spec/receipts.md shapes it, at [at] (unix seconds). Refused when the request
    /// was not bound: a version 1 receipt without its request hash would not be what it says.
    fn receipt(&self, node: &str, at: u64) -> Result<Value, String> {
        let request_sha256 = self.request_sha256.as_deref().ok_or("the request was not bound")?;
        let mut receipt = json!({
            "version": VERSION,
            "request_id": self.id,
            "node": node,
            "at": at,
            "api": self.api,
            "caller": caller(&self.caller),
            "request_sha256": request_sha256,
            "answer_sha256": crate::token::hex(&self.answer.clone().finalize()),
            "answer_bytes": self.answer_bytes,
            "answer_complete": self.complete,
            "decision": self.decision,
            "egress": self.attempts.iter().map(|a| json!({
                "host": a.host,
                "route": a.route,
                "bytes_sent": a.sent,
                "bytes_received": a.received.load(Ordering::Relaxed),
                "ok": a.ok,
            })).collect::<Vec<_>>(),
        });
        if let Some(policy) = &self.data_policy {
            receipt["data_policy"] = json!(policy);
        }
        if !self.redactions.is_empty() {
            receipt["redactions"] = json!(self.redactions);
        }
        if !self.images.is_empty() {
            receipt["images"] = json!(self.images);
        }
        if !self.cluster.is_empty() {
            receipt["cluster"] = self.cluster.iter().map(crate::cluster::ShardUse::to_json).collect();
        }
        // The worker, when this node forwarded the request to another one. Only then: a receipt
        // from a node that answered itself keeps the shape it always had.
        if let Some(dispatch) = &self.dispatch {
            receipt["dispatch"] = dispatch.clone();
        }
        let withheld = self.withheld_usage.lock().expect("usage lock").as_ref().map(Value::to_string);
        if let Some((input, output)) = withheld.and_then(|u| usage(u.as_bytes())).or_else(|| usage(&self.tail)) {
            receipt["tokens"] = json!({ "input": input, "output": output });
        }
        if let Some(error) = self.error() {
            receipt["error"] = error;
        }
        Ok(receipt)
    }

    /// What went wrong, when the answer was an error: its status, or the error event that ended
    /// a stream that had begun (with its status and code).
    fn error(&self) -> Option<Value> {
        if !(200..300).contains(&self.status) {
            return Some(json!({ "status": self.status }));
        }
        let text = String::from_utf8_lossy(&self.tail);
        let at = text.rfind("event: error\ndata: ")?;
        let data = text[at + "event: error\ndata: ".len()..].lines().next()?;
        let event: Value = serde_json::from_str(data).ok()?;
        let mut error = json!({ "status": event["status"].as_u64().unwrap_or(502) });
        if let Some(code) = event["error"]["code"].as_str() {
            error["code"] = json!(code);
        }
        Some(error)
    }
}

// OpenAI's names, or Anthropic's (`input_tokens` in message_start, the final `output_tokens` in
// message_delta when streaming).
static PROMPT_TOKENS: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r#""(?:prompt_tokens|input_tokens)"\s*:\s*([0-9]+)"#).expect("regex"));
static COMPLETION_TOKENS: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r#""(?:completion_tokens|output_tokens)"\s*:\s*([0-9]+)"#).expect("regex"));

/// The last token usage an OpenAI-style answer reported (the whole body, or the last SSE chunk).
fn usage(tail: &[u8]) -> Option<(u64, u64)> {
    let text = String::from_utf8_lossy(tail);
    let last = |re: &Regex| re.captures_iter(&text).last().and_then(|c| c[1].parse().ok());
    Some((last(&PROMPT_TOKENS)?, last(&COMPLETION_TOKENS)?))
}

/// The caller as the receipt names it: the device's pinned static key (and the fingerprint people
/// compare it by), or `local` for this node's own loopback API. The name is a label that can be
/// changed; the key is the identity.
fn caller(caller: &Caller) -> Value {
    match caller {
        Caller::Local => json!({ "kind": "local" }),
        Caller::Device { name, key, fingerprint } => json!({
            "kind": "device",
            "name": name,
            "key": key,
            "fingerprint": fingerprint,
        }),
    }
}

/// Signs and stores the receipt when dropped: when the answer was fully sent, or when the client
/// went away and the body was dropped.
struct Finisher {
    draft: Arc<Mutex<Draft>>,
    key: Arc<ReceiptKey>,
    store: Arc<ReceiptStore>,
    audit: Option<Arc<AuditLog>>,
}

impl Drop for Finisher {
    fn drop(&mut self) {
        let draft = self.draft.lock().expect("draft lock");
        let signed = draft.receipt(&self.key.public(), now()).and_then(|receipt| self.key.sign(receipt));
        match signed {
            Ok(envelope) => {
                if let Some(audit) = &self.audit {
                    // The request's id rides on the entry (the handle the client was given in
                    // `invincible-request-id`, and the id inside the receipt), with the dispatch
                    // record when there was one: never inside the signed receipt.
                    let mut extra = json!({ "request_id": &draft.id });
                    if let Some(dispatch) = &draft.dispatch {
                        extra["dispatch"] = dispatch.clone();
                    }
                    if let Err(e) =
                        audit.append_tagged(&draft.caller, draft.client.as_deref(), draft.api, &envelope, Some(&extra))
                    {
                        tracing::error!("audit log not written: {e}");
                    }
                }
                self.store.finish(&draft.id, envelope)
            }
            Err(e) => tracing::error!("receipt not signed: {e}"),
        }
    }
}

/// Registers [draft] as running, and returns [response] with the request id header and a body
/// that finishes the receipt when it ends.
pub fn attach(
    response: Response,
    draft: Arc<Mutex<Draft>>,
    key: Arc<ReceiptKey>,
    store: Arc<ReceiptStore>,
    audit: Option<Arc<AuditLog>>,
) -> Response {
    let id = draft.lock().expect("draft lock").id.clone();
    store.begin(&id);
    let (mut parts, body) = response.into_parts();
    draft.lock().expect("draft lock").status = parts.status.as_u16();
    if let Ok(value) = axum::http::HeaderValue::from_str(&id) {
        parts.headers.insert(REQUEST_ID_HEADER, value);
    }
    let finisher = Finisher { draft, key, store, audit };
    let stream =
        futures_util::stream::unfold((body.into_data_stream(), Some(finisher)), |(mut inner, finisher)| async move {
            let finisher = finisher?;
            match inner.next().await {
                Some(Ok(bytes)) => {
                    finisher.draft.lock().expect("draft lock").observe(&bytes);
                    Some((Ok::<Bytes, axum::Error>(bytes), (inner, Some(finisher))))
                }
                Some(Err(e)) => Some((Err(e), (inner, None))),
                None => {
                    // The body ended on its own: every byte the answer had has been hashed.
                    finisher.draft.lock().expect("draft lock").complete = true;
                    None
                }
            }
        });
    Response::from_parts(parts, Body::from_stream(stream))
}

#[cfg(test)]
mod tests {
    use super::{
        Draft, ReceiptKey, VERSION, Verified, answer_hash, canonical, check, hash, inspect, request_hash, usage, verify,
    };
    use crate::audit::Caller;
    use serde_json::json;

    /// A dispatch receipt names the machine that answered, and the name is inside the signature:
    /// otherwise a client verifying it learns nothing about who did the work, and a receipt that
    /// says nothing can be relabelled without touching the signature.
    #[test]
    fn the_worker_is_inside_the_signed_bytes() {
        let key = ReceiptKey::from_seed(&[7; 32]);
        let mut draft = Draft::new().expect("draft");
        draft.bind_request("dispatch", &json!({ "model": "qwen3-0.6b", "messages": [] }));
        draft.dispatch = Some(json!({ "via": "head", "node": "peer" }));
        let receipt = draft.receipt(&key.public(), 1_700_000_000).expect("a bound draft receipts");
        assert_eq!(receipt["dispatch"]["node"], "peer");
        let envelope = key.sign(receipt.clone()).expect("sign");
        let signature = envelope["signature"].as_str().expect("signature");
        assert!(verify(&key.public(), &receipt, signature));
        // A different worker is a different receipt, and the old signature does not cover it.
        let mut changed = receipt.clone();
        changed["dispatch"]["node"] = json!("someone-else");
        assert!(!verify(&key.public(), &changed, signature));
        // A node that answered itself names no worker: the old shape, unchanged.
        let mut local = Draft::new().expect("draft");
        local.bind_request("chat", &json!({ "model": "qwen3-0.6b" }));
        let plain = local.receipt(&key.public(), 1_700_000_000).expect("receipt");
        assert!(plain.get("dispatch").is_none(), "a receipt that was not forwarded names no worker");
    }

    /// An answer that was an error is receipted as one: its status, or the error event that
    /// ended a stream that had begun, never as a normal answer.
    #[test]
    fn an_error_is_receipted_as_one() {
        let mut draft = bound_draft();
        draft.observe(b"data: {\"choices\":[]}\n\n");
        assert!(draft.receipt("k", 0).unwrap().get("error").is_none());
        draft.observe(br#": keep-alive

event: error
data: {"type":"error","status":400,"error":{"type":"invalid_request_error","code":"context_length_exceeded","message":"too long"}}

"#);
        assert_eq!(
            draft.receipt("k", 0).unwrap()["error"],
            json!({ "status": 400, "code": "context_length_exceeded" })
        );
        let mut draft = bound_draft();
        draft.status = 503;
        assert_eq!(draft.receipt("k", 0).unwrap()["error"], json!({ "status": 503 }));
    }

    /// A draft with a request bound, as every endpoint binds one before answering.
    fn bound_draft() -> Draft {
        let mut draft = Draft::new().unwrap();
        draft.bind_request("chat", &json!({ "model": "auto", "messages": [{ "role": "user", "content": "hi" }] }));
        draft
    }

    #[test]
    fn signs_and_verifies() {
        let key = ReceiptKey::from_seed(&[7; 32]);
        let receipt = json!({ "version": 0, "node": key.public(), "egress": [], "b": "x", "a": 1 });
        let envelope = key.sign(receipt.clone()).unwrap();
        let signature = envelope["signature"].as_str().unwrap();
        assert!(verify(&key.public(), &receipt, signature));
        assert!(!verify(&key.public(), &json!({ "version": 0, "node": key.public(), "b": "y", "a": 1 }), signature));
    }

    /// The canonical form, pinned: a second implementation must produce exactly this, byte for
    /// byte, and its SHA-256. It covers the parts that are easy to get wrong — key order, keys
    /// above U+FFFF in UTF-16 order, escapes, and numbers (0.1, 2.5, 1e21, 1e-7).
    #[test]
    fn canonical_json_matches_the_known_answer() {
        let value = json!({
            "z": "line\nbreak\t\"quoted\"\\",
            "a": [1, -2, 0.1, 1e21, 1e-7, true, null],
            "é": "é",
            "😀": "grin",
            "\u{e000}": "private",
            "nested": { "b": 2.5, "a": {} },
        });
        let text = "{\"a\":[1,-2,0.1,1e+21,1e-7,true,null],\"nested\":{\"a\":{},\"b\":2.5},\"z\":\"line\\nbreak\\t\\\"quoted\\\"\\\\\",\"é\":\"é\",\"😀\":\"grin\",\"\u{e000}\":\"private\"}";
        assert_eq!(canonical(&value).unwrap(), text);
        // Computed independently: JavaScript's JSON.stringify over the same sorted keys.
        assert_eq!(hash(&value).unwrap(), "50b0aa6d0d87c54d9fe76e73683e1ae361a5ee991ce8ef8cb1674ee3f0bd44ef");
        // The same value built in another order is the same bytes.
        let reordered = json!({
            "nested": { "a": {}, "b": 2.5 },
            "\u{e000}": "private",
            "😀": "grin",
            "é": "é",
            "a": [1, -2, 0.1, 1e21, 1e-7, true, null],
            "z": "line\nbreak\t\"quoted\"\\",
        });
        assert_eq!(canonical(&reordered).unwrap(), text);
        // Numbers keep ECMAScript's form, not Rust's: 1e21 has a `+`, 1e-7 has none.
        assert_eq!(canonical(&json!([1e21, 1e-7, 0.7, 4096.0, -0.0])).unwrap(), "[1e+21,1e-7,0.7,4096,0]");
    }

    /// A version 1 receipt binds the exchange: the request hash is the one the request produces,
    /// the answer hash the one the answer bytes produce, and the caller, time and node are in it.
    #[test]
    fn a_receipt_binds_the_exchange() {
        let key = ReceiptKey::from_seed(&[4; 32]);
        let body = json!({ "model": "auto", "messages": [{ "role": "user", "content": "hi" }] });
        let answer = br#"{"choices":[{"message":{"content":"hi"}}]}"#;
        let mut draft = bound_draft();
        draft.bind_request("chat", &body);
        draft.observe(answer);
        draft.complete = true;
        let receipt = draft.receipt(&key.public(), 1_700_000_000).unwrap();
        assert_eq!(receipt["version"], json!(VERSION));
        assert_eq!(receipt["request_sha256"], json!(request_hash("chat", &body).unwrap()));
        assert_eq!(receipt["answer_sha256"], json!(answer_hash(answer)));
        assert_eq!(receipt["answer_bytes"], json!(answer.len()));
        assert_eq!(receipt["answer_complete"], json!(true));
        assert_eq!(receipt["at"], json!(1_700_000_000));
        assert_eq!(receipt["caller"], json!({ "kind": "local" }));
        // The prompt is never in it.
        assert!(!receipt.to_string().contains("hi\",\"role"));
        let envelope = key.sign(receipt).unwrap();
        assert_eq!(
            check(&key.public(), &envelope["receipt"], envelope["signature"].as_str().unwrap()),
            Ok(Verified { version: 1, bound: true })
        );
    }

    /// The device that asked is named by the key it was pinned with, not by its mutable name.
    #[test]
    fn the_caller_is_the_pinned_device_key() {
        let key = ReceiptKey::from_seed(&[5; 32]);
        let mut draft = bound_draft();
        draft.caller = Caller::device("phone", &[0xAB; 32]);
        let receipt = draft.receipt(&key.public(), 1_700_000_000).unwrap();
        assert_eq!(receipt["caller"]["kind"], "device");
        assert_eq!(receipt["caller"]["name"], "phone");
        assert_eq!(receipt["caller"]["fingerprint"], "abab-abab-abab-abab");
        assert_eq!(
            receipt["caller"]["key"],
            base64::Engine::encode(&base64::engine::general_purpose::URL_SAFE_NO_PAD, [0xAB; 32])
        );
    }

    /// Every single byte of the answer matters: change one, and the check says which hash no
    /// longer matches rather than just "invalid".
    #[test]
    fn a_changed_answer_fails_with_a_specific_error() {
        let key = ReceiptKey::from_seed(&[6; 32]);
        let body = json!({ "model": "auto", "messages": [{ "role": "user", "content": "hi" }] });
        let answer = b"{\"choices\":[{\"message\":{\"content\":\"hi\"}}]}".to_vec();
        let mut draft = bound_draft();
        draft.observe(&answer);
        let envelope = key.sign(draft.receipt(&key.public(), 1_700_000_000).unwrap()).unwrap();
        assert!(inspect(&key.public(), &envelope, Some(&body), Some(&answer)).is_ok());
        for at in 0..answer.len() {
            let mut changed = answer.clone();
            changed[at] ^= 0x01;
            let error = inspect(&key.public(), &envelope, Some(&body), Some(&changed)).unwrap_err();
            assert!(error.contains("the answer is not the one this receipt binds"), "byte {at}: {error}");
        }
        // One byte appended is a different answer too.
        let mut longer = answer.clone();
        longer.push(b' ');
        assert!(inspect(&key.public(), &envelope, Some(&body), Some(&longer)).is_err());
        // So is another request.
        let mut other = body.clone();
        other["messages"][0]["content"] = json!("bye");
        let error = inspect(&key.public(), &envelope, Some(&other), Some(&answer)).unwrap_err();
        assert!(error.contains("the request is not the one this receipt binds"), "{error}");
    }

    /// A receipt is the key that signed it and no other: node A's cannot be passed off as B's.
    #[test]
    fn a_receipt_cannot_be_passed_off_as_another_node() {
        let a = ReceiptKey::from_seed(&[1; 32]);
        let b = ReceiptKey::from_seed(&[2; 32]);
        let draft = bound_draft();
        let envelope = a.sign(draft.receipt(&a.public(), 1_700_000_000).unwrap()).unwrap();
        let signature = envelope["signature"].as_str().unwrap();
        let error = check(&b.public(), &envelope["receipt"], signature).unwrap_err();
        assert!(error.contains("not the key it was checked against"), "{error}");
        // Nor under another node's name with the same signature.
        let mut renamed = envelope["receipt"].clone();
        renamed["node"] = json!(b.public());
        assert!(!verify(&b.public(), &renamed, signature));
    }

    /// Version 0 verifies as version 0 — routing and accounting only — and cannot be passed off as
    /// version 1: the version is inside the signed message, so changing it breaks the signature.
    #[test]
    fn a_version_0_receipt_verifies_as_version_0_and_is_never_upgraded() {
        let key = ReceiptKey::from_seed(&[3; 32]);
        let receipt = json!({
            "version": 0, "request_id": "0".repeat(32), "node": key.public(),
            "decision": { "action": "run", "model": "qwen", "tier": "node", "reason": "requested" },
            "egress": [],
        });
        let envelope = key.sign(receipt.clone()).unwrap();
        let signature = envelope["signature"].as_str().unwrap();
        assert_eq!(check(&key.public(), &receipt, signature), Ok(Verified { version: 0, bound: false }));
        let report = inspect(&key.public(), &envelope, None, None).unwrap();
        assert_eq!(report["version"], json!(0));
        assert_eq!(report["bound"], json!(false));
        assert!(report.get("request_sha256").is_none(), "nothing to report about a version 0 binding");
        // Upgraded in place: the signature no longer covers it, so it is refused, not upgraded.
        let mut upgraded = receipt.clone();
        upgraded["version"] = json!(1);
        assert!(!verify(&key.public(), &upgraded, signature));
        assert!(check(&key.public(), &upgraded, signature).is_err());
        // And a version 1 receipt stripped of its bindings is refused as version 1.
        let mut stripped = draft_v1(&key);
        stripped["receipt"]["answer_sha256"] = json!(null);
        stripped["receipt"].as_object_mut().unwrap().remove("request_sha256");
        let resigned = key.sign(stripped["receipt"].clone()).unwrap();
        let error = check(&key.public(), &resigned["receipt"], resigned["signature"].as_str().unwrap()).unwrap_err();
        assert!(error.contains("must carry `request_sha256`"), "{error}");
    }

    /// A signed version 1 receipt, for the tests above.
    fn draft_v1(key: &ReceiptKey) -> serde_json::Value {
        let mut draft = bound_draft();
        draft.observe(b"{}");
        key.sign(draft.receipt(&key.public(), 1_700_000_000).unwrap()).unwrap()
    }

    /// Numbers, as ECMAScript writes them: the table's expected strings were produced by
    /// JavaScript's `JSON.stringify`, which is what RFC 8785 mandates, across every range.
    #[test]
    fn numbers_follow_ecmascript_in_every_range() {
        let cases: [(u64, &str); 55] = [
            (0x3fb999999999999a, "0.1"),
            (0x3fc999999999999a, "0.2"),
            (0x3fd3333333333333, "0.3"),
            (0x3ff0000000000000, "1"),
            (0x3ff8000000000000, "1.5"),
            (0x4004000000000000, "2.5"),
            (0x3fe6666666666666, "0.7"),
            (0x3eb0c6f7a0b5ed8d, "0.000001"),
            (0x3e7ad7f29abcaf48, "1e-7"),
            (0x3e8421f5f40d8376, "1.5e-7"),
            (0x444b1ae4d6e2ef50, "1e+21"),
            (0x4415af1d78b58c40, "100000000000000000000"),
            (0x4341c37937e08000, "10000000000000000"),
            (0x441ac53a7e04bcda, "123456789012345680000"),
            (0x0000000000000001, "5e-324"),
            (0x7fefffffffffffff, "1.7976931348623157e+308"),
            (0x0010000000000000, "2.2250738585072014e-308"),
            (0x3f201f31f46ed246, "0.000123"),
            (0x3fd5555555555555, "0.3333333333333333"),
            (0x400921fb54442d18, "3.141592653589793"),
            (0x4005bf0a8b145769, "2.718281828459045"),
            (0x8000000000000000, "0"),
            (0xbff8000000000000, "-1.5"),
            (0xbe7ad7f29abcaf48, "-1e-7"),
            (0xbdf12e0be826d695, "-2.5e-10"),
            (0x40b0000000000000, "4096"),
            (0x44dfde9f10a8d361, "6.02e+23"),
            (0x3ee711947cfa26a2, "0.000011"),
            (0x414c8f30862a0000, "3743329.0481567383"),
            (0x412e6789f1f40000, "996292.9725646973"),
            (0x4190d3edb97c2000, "70581102.37121582"),
            (0x3d39301bdb16f53a, "8.948548585176468e-14"),
            (0x41c92d2b165fff00, "844781100.7499695"),
            (0x41ee1911d92c0980, "4039675593.3761597"),
            (0x424fc7b55227bf98, "272989070415.49683"),
            (0x40a83fb76a400000, "3103.858232498169"),
            (0x3da1c93aefdeab62, "8.088161647319794e-12"),
            (0x43086e54c1b64f15, "859588718414306.6"),
            (0x3cc2db0a4611b623, "5.233487397432327e-16"),
            (0x41effe629babad80, "4294120669.364929"),
            (0x3e32879f5759ea3e, "4.3142994642257696e-9"),
            (0x43739f2f81e3e33e, "88368815183639520"),
            (0x3f3fd633f7ced917, "0.000485789954662323"),
            (0x42829632ee1f6acf, "2554538607597.351"),
            (0x3d25bc0c502816eb, "3.8608339428901675e-14"),
            (0x3f0d0c4d1b71758f, "0.000055404761433601385"),
            (0x43d2117719bb61b9, "5207810878753662000"),
            (0x421c32a060e9f580, "30277113914.489746"),
            (0x3f8225ae10624dd3, "0.008860931277275086"),
            (0x428b6fb2e036c167, "3770819544792.1753"),
            (0x40558c40eb000000, "86.19146227836609"),
            (0x41a7d64bba401c00, "199960029.12521362"),
            (0x0000000000000000, "0"),
            (0x3ff0000000000001, "1.0000000000000002"),
            (0xbfefffffffffffff, "-0.9999999999999999"),
        ];
        for (bits, expected) in cases {
            let value = json!(f64::from_bits(bits));
            assert_eq!(canonical(&value).unwrap(), expected, "{bits:#018x}");
        }
    }

    #[test]
    fn finds_usage_in_bodies_and_streams() {
        assert_eq!(usage(br#"{"choices":[],"usage":{"prompt_tokens":19,"completion_tokens":8}}"#), Some((19, 8)));
        let sse = b"data: {\"usage\":null}\n\ndata: {\"usage\":{\"completion_tokens\":3,\"prompt_tokens\":4}}\n\ndata: [DONE]\n\n";
        assert_eq!(usage(sse), Some((4, 3)));
        assert_eq!(usage(b"no usage"), None);
        // Anthropic Messages, whole and streamed.
        assert_eq!(usage(br#"{"usage":{"input_tokens":14,"output_tokens":20}}"#), Some((14, 20)));
    }

    /// A streamed cloud answer whose usage chunk the client did not get still has its tokens.
    #[test]
    fn usage_kept_back_from_the_client_is_counted() {
        let mut draft = bound_draft();
        draft.observe(b"data: {\"choices\":[{\"delta\":{\"content\":\"hi\"}}],\"usage\":null}\n\ndata: [DONE]\n\n");
        assert_eq!(draft.receipt("k", 0).unwrap().get("tokens"), None);
        *draft.withheld_usage.lock().unwrap() = Some(
            json!({ "prompt_tokens": 11, "completion_tokens": 2, "prompt_tokens_details": { "cached_tokens": 3 } }),
        );
        assert_eq!(draft.receipt("k", 0).unwrap()["tokens"], json!({ "input": 11, "output": 2 }));
    }

    /// A random receipt-shaped value: integers, strings, booleans, arrays and objects.
    fn value(g: &mut crate::testgen::Gen, depth: usize) -> serde_json::Value {
        match if depth == 0 { g.below(4) } else { g.below(6) } {
            0 => json!(g.number() as i64 >> g.below(64)),
            1 => json!(g.text(12)),
            2 => json!(g.one_in(2)),
            3 => serde_json::Value::Null,
            4 => serde_json::Value::Array((0..g.below(4)).map(|_| value(g, depth - 1)).collect()),
            _ => {
                let mut map = serde_json::Map::new();
                for _ in 0..g.below(5) {
                    let key: String = g.text(6).chars().filter(char::is_ascii).collect();
                    map.insert(key, value(g, depth - 1));
                }
                serde_json::Value::Object(map)
            }
        }
    }

    #[test]
    fn any_receipt_verifies_and_any_change_or_garbage_does_not() {
        let key = ReceiptKey::from_seed(&[9; 32]);
        crate::testgen::cases("receipts", |g| {
            let receipt = json!({ "version": 0, "node": key.public(), "body": value(g, 3) });
            let envelope = key.sign(receipt.clone()).unwrap();
            let signature = envelope["signature"].as_str().unwrap();
            assert!(verify(&key.public(), &receipt, signature));
            // The same after a trip through text (the canonical form does not depend on it).
            let again: serde_json::Value = serde_json::from_str(&envelope.to_string()).unwrap();
            assert!(verify(&key.public(), &again["receipt"], again["signature"].as_str().unwrap()));
            let mut changed = receipt.clone();
            changed["body"] = json!([changed["body"].clone()]);
            assert!(!verify(&key.public(), &changed, signature));
            // Garbage keys and signatures are refused, never a panic.
            assert!(!verify(&g.text(50), &receipt, signature));
            assert!(!verify(&key.public(), &receipt, &g.text(90)));
        });
    }

    #[test]
    fn usage_is_read_from_any_bytes_without_panicking() {
        crate::testgen::cases("usage", |g| {
            let pieces = [
                "\"prompt_tokens\":",
                "\"completion_tokens\": ",
                "\"input_tokens\":",
                "12",
                "99999999999999999999999",
                "data: ",
                "{",
                "}",
                "\n",
            ];
            let mut bytes = g.assemble(&pieces, 30).into_bytes();
            bytes.extend(g.bytes(20));
            let _ = usage(&bytes);
        });
    }
}
