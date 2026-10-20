//! Signed receipts (spec/receipts.md): for every chat completion, where it ran and what left the
//! node, signed with the node's Ed25519 receipt key.

use std::collections::{BTreeMap, HashMap, VecDeque};
use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, LazyLock, Mutex};
use std::time::Duration;

use axum::body::{Body, Bytes};
use axum::response::Response;
use base64::Engine as _;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use ed25519_dalek::{Signature, Signer, SigningKey, VerifyingKey};
use futures_util::StreamExt;
use invincible_policy::Decision;
use regex::Regex;
use serde_json::{Value, json};

use crate::audit::AuditLog;
use crate::fsutil;

pub const REQUEST_ID_HEADER: &str = "invincible-request-id";
const PREFIX: &[u8] = b"invincible-receipt/0\n";
const KEEP: usize = 4096;
/// Bytes of the answer kept to find its token usage (it comes last).
const TAIL: usize = 64 * 1024;

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

    /// The signed envelope `{"receipt": …, "signature": …}`.
    pub fn sign(&self, receipt: Value) -> Result<Value, String> {
        let message = [PREFIX, canonical(&receipt)?.as_bytes()].concat();
        let signature = self.signing.sign(&message);
        Ok(json!({ "receipt": receipt, "signature": URL_SAFE_NO_PAD.encode(signature.to_bytes()) }))
    }
}

/// RFC 8785 canonical JSON for the values receipts contain: integers, strings, booleans, arrays and
/// objects with ASCII keys. For those, serde_json's compact form with sorted keys (its default map
/// is ordered) is exactly JCS.
pub fn canonical(value: &Value) -> Result<String, String> {
    fn check(value: &Value) -> Result<(), String> {
        match value {
            Value::Number(n) if !(n.is_i64() || n.is_u64()) => Err("receipts hold integers only".to_owned()),
            Value::Array(items) => items.iter().try_for_each(check),
            Value::Object(map) => map.iter().try_for_each(|(k, v)| {
                if k.is_ascii() { check(v) } else { Err("receipt keys must be ASCII".to_owned()) }
            }),
            _ => Ok(()),
        }
    }
    check(value)?;
    // Re-collect into a fresh value so the keys are sorted whatever map built the input.
    let sorted: Value = serde_json::from_str(&value.to_string()).map_err(|e| e.to_string())?;
    Ok(sorted.to_string())
}

/// Whether [signature] is [public_key]'s signature of [receipt] (spec/receipts.md).
pub fn verify(public_key: &str, receipt: &Value, signature: &str) -> bool {
    let Some(key) = URL_SAFE_NO_PAD
        .decode(public_key)
        .ok()
        .and_then(|b| <[u8; 32]>::try_from(b).ok())
        .and_then(|b| VerifyingKey::from_bytes(&b).ok())
    else {
        return false;
    };
    let Some(signature) = URL_SAFE_NO_PAD
        .decode(signature)
        .ok()
        .and_then(|b| <[u8; 64]>::try_from(b).ok())
        .map(|b| Signature::from_bytes(&b))
    else {
        return false;
    };
    let Ok(canonical) = canonical(receipt) else { return false };
    key.verify_strict(&[PREFIX, canonical.as_bytes()].concat(), &signature).is_ok()
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
    pub id: String,
    pub decision: Option<Decision>,
    pub data_policy: Option<String>,
    pub redactions: BTreeMap<&'static str, usize>,
    pub attempts: Vec<Attempt>,
    /// The images the request carried, by hash, size and type ([crate::media::Image]); never
    /// their bytes.
    pub images: Vec<Value>,
    /// For the audit log, not the receipt: who asked, the client they named, which API.
    pub caller: crate::audit::Caller,
    pub client: Option<String>,
    pub api: &'static str,
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
            caller: crate::audit::Caller::Local,
            client: None,
            api: "chat",
            tail: Vec::new(),
        })
    }

    fn observe(&mut self, bytes: &[u8]) {
        self.tail.extend_from_slice(bytes);
        // Cut back only when it is twice the size kept: not a 64 KiB move for every chunk of a
        // long stream.
        if self.tail.len() > 2 * TAIL {
            let cut = self.tail.len() - TAIL;
            self.tail.drain(..cut);
        }
    }

    /// The receipt as spec/receipts.md shapes it.
    fn receipt(&self, node: &str) -> Value {
        let mut receipt = json!({
            "version": 0,
            "request_id": self.id,
            "node": node,
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
        if let Some((input, output)) = usage(&self.tail) {
            receipt["tokens"] = json!({ "input": input, "output": output });
        }
        receipt
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
        match self.key.sign(draft.receipt(&self.key.public())) {
            Ok(envelope) => {
                if let Some(audit) = &self.audit
                    && let Err(e) = audit.append(&draft.caller, draft.client.as_deref(), draft.api, &envelope)
                {
                    tracing::error!("audit log not written: {e}");
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
                None => None,
            }
        });
    Response::from_parts(parts, Body::from_stream(stream))
}

#[cfg(test)]
mod tests {
    use super::{ReceiptKey, canonical, usage, verify};
    use serde_json::json;

    #[test]
    fn signs_and_verifies() {
        let key = ReceiptKey::from_seed(&[7; 32]);
        let receipt = json!({ "version": 0, "egress": [], "b": "x", "a": 1 });
        let envelope = key.sign(receipt.clone()).unwrap();
        let signature = envelope["signature"].as_str().unwrap();
        assert!(verify(&key.public(), &receipt, signature));
        assert!(!verify(&key.public(), &json!({ "version": 0, "egress": [], "b": "y", "a": 1 }), signature));
    }

    #[test]
    fn canonical_json_refuses_floats() {
        assert_eq!(canonical(&json!({ "b": 1, "a": [true, "é"] })).unwrap(), r#"{"a":[true,"é"],"b":1}"#);
        assert!(canonical(&json!({ "a": 1.5 })).is_err());
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
            let receipt = json!({ "version": 0, "body": value(g, 3) });
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
