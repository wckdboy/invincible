//! The audit log (spec/audit.md): every request the node answered, on disk, in order. Each entry
//! holds the request's signed receipt plus when it was and who asked, and the hash of the entry
//! before it, so an entry removed or changed after the fact breaks the chain `invincible audit
//! --verify` checks. It never holds prompt or answer text.

use std::collections::BTreeMap;
use std::io::BufRead;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde_json::{Value, json};
use sha2::{Digest, Sha256};

/// The `prev` of the first entry ever written.
pub const GENESIS: &str = "0000000000000000000000000000000000000000000000000000000000000000";
/// The log is rotated (to `audit.1.jsonl`, replacing an older one) past this size.
const ROTATE_AT: u64 = 16 * 1024 * 1024;

/// Who sent a request: the local API (with the token) or a paired device over its session.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Caller {
    Local,
    /// A paired device: the name it is listed under, its pinned static key (base64url), and the
    /// fingerprint people compare ([crate::devices::fingerprint]). The key is the identity; the
    /// name is a label the owner can change.
    Device {
        name: String,
        key: String,
        fingerprint: String,
    },
}

impl Caller {
    /// A paired device, from its static public key as the session handshake gave it.
    pub fn device(name: &str, key: &[u8]) -> Self {
        Self::Device {
            name: name.to_owned(),
            key: base64::Engine::encode(&base64::engine::general_purpose::URL_SAFE_NO_PAD, key),
            fingerprint: crate::devices::fingerprint(key),
        }
    }

    pub fn code(&self) -> String {
        match self {
            Self::Local => "local".to_owned(),
            Self::Device { name, .. } => format!("device:{name}"),
        }
    }

    /// A device's pinned key (base64url); `None` for the operator's own API.
    pub fn key(&self) -> Option<&str> {
        match self {
            Self::Local => None,
            Self::Device { key, .. } => Some(key),
        }
    }
}

pub struct AuditLog {
    path: PathBuf,
    /// The hash of the last entry written, once known.
    last: Mutex<Option<String>>,
}

fn hash(line: &str) -> String {
    crate::token::hex(&Sha256::digest(line.as_bytes()))
}

fn now() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or_default()
}

impl AuditLog {
    /// The log in [home] (`audit.jsonl`).
    pub fn new(home: &Path) -> Self {
        Self { path: home.join("audit.jsonl"), last: Mutex::new(None) }
    }

    fn rotated(&self) -> PathBuf {
        self.path.with_file_name("audit.1.jsonl")
    }

    /// The hash of the last line of [path], if it has one.
    fn tail_hash(path: &Path) -> Option<String> {
        let file = std::fs::File::open(path).ok()?;
        std::io::BufReader::new(file)
            .lines()
            .map_while(Result::ok)
            .filter(|l| !l.trim().is_empty())
            .last()
            .map(|l| hash(&l))
    }

    /// Appends one entry for [envelope] (a signed receipt).
    pub fn append(&self, caller: &Caller, client: Option<&str>, api: &str, envelope: &Value) -> Result<(), String> {
        let mut last = self.last.lock().expect("audit lock");
        if std::fs::metadata(&self.path).is_ok_and(|m| m.len() >= ROTATE_AT) {
            let prev = Self::tail_hash(&self.path);
            std::fs::rename(&self.path, self.rotated()).map_err(|e| format!("{}: {e}", self.path.display()))?;
            *last = prev;
        }
        let prev = match last.clone() {
            Some(prev) => prev,
            None => Self::tail_hash(&self.path)
                .or_else(|| Self::tail_hash(&self.rotated()))
                .unwrap_or_else(|| GENESIS.to_owned()),
        };
        let mut entry = json!({ "at": now(), "caller": caller.code(), "api": api, "prev": prev, "receipt": envelope });
        if let Some(client) = client {
            entry["client"] = json!(client);
        }
        // The device's pinned key, not its name: the name is a label a later device may take, and
        // the key is what a device's own read of the log is filtered by ([AuditLog::read_where]).
        if let Caller::Device { key, .. } = caller {
            entry["caller_key"] = json!(key);
        }
        let line = entry.to_string();
        crate::fsutil::append_private(&self.path, &line)?;
        *last = Some(hash(&line));
        Ok(())
    }

    /// Every entry's line, oldest first (the rotated file, then the current one).
    fn lines(&self) -> Vec<String> {
        [self.rotated(), self.path.clone()]
            .iter()
            .filter_map(|p| std::fs::File::open(p).ok())
            .flat_map(|f| std::io::BufReader::new(f).lines().map_while(Result::ok))
            .filter(|l| !l.trim().is_empty())
            .collect()
    }

    /// Entries at or after [since] (unix seconds), newest last, at most [limit] (the newest ones).
    pub fn read(&self, since: u64, limit: usize) -> Vec<Value> {
        self.read_where(since, limit, |_| true)
    }

    /// [AuditLog::read], of the entries [keep] accepts: the newest [limit] of those, so a filter
    /// never comes back short because other callers' entries were newer.
    pub fn read_where(&self, since: u64, limit: usize, keep: impl Fn(&Value) -> bool) -> Vec<Value> {
        let entries: Vec<Value> = self
            .lines()
            .iter()
            .filter_map(|l| serde_json::from_str::<Value>(l).ok())
            .filter(|e| e["at"].as_u64().unwrap_or(0) >= since)
            .filter(|e| keep(e))
            .collect();
        let skip = entries.len().saturating_sub(limit);
        entries.into_iter().skip(skip).collect()
    }

    /// The signed receipt of request [id], newest entries first.
    pub fn find(&self, id: &str) -> Option<Value> {
        let needle = format!("\"request_id\":\"{id}\"");
        self.lines()
            .iter()
            .rev()
            .filter(|l| l.contains(&needle))
            .filter_map(|l| serde_json::from_str::<Value>(l).ok())
            .find(|e| e["receipt"]["receipt"]["request_id"] == id)
            .map(|e| e["receipt"].clone())
    }

    /// Checks the chain and every receipt's signature against [receipt_key]: the number of entries,
    /// or the first one that fails and why. A log that starts mid-chain (its oldest part rotated
    /// away) is checked from its first entry on.
    pub fn verify(&self, receipt_key: &str) -> Result<usize, String> {
        let lines = self.lines();
        let mut prev: Option<String> = None;
        for (n, line) in lines.iter().enumerate() {
            let entry: Value = serde_json::from_str(line).map_err(|_| format!("entry {}: not JSON", n + 1))?;
            let claimed = entry["prev"].as_str().unwrap_or_default();
            if let Some(prev) = &prev
                && claimed != prev
            {
                return Err(format!(
                    "entry {}: the chain is broken (an entry before it was changed or removed)",
                    n + 1
                ));
            }
            let receipt = &entry["receipt"];
            if receipt["receipt"]["node"].as_str() != Some(receipt_key) {
                return Err(format!("entry {}: signed by another key", n + 1));
            }
            if !crate::receipts::verify(
                receipt_key,
                &receipt["receipt"],
                receipt["signature"].as_str().unwrap_or_default(),
            ) {
                return Err(format!("entry {}: the receipt's signature does not verify", n + 1));
            }
            prev = Some(hash(line));
        }
        Ok(lines.len())
    }
}

/// Totals over [entries]: requests, tokens and bytes that left, per model, and per host reached.
pub fn summary(entries: &[Value]) -> Value {
    let mut models: BTreeMap<String, (u64, u64, u64)> = BTreeMap::new();
    let mut hosts: BTreeMap<String, (u64, u64, u64)> = BTreeMap::new();
    let (mut ran, mut refused) = (0u64, 0u64);
    for entry in entries {
        let receipt = &entry["receipt"]["receipt"];
        let decision = &receipt["decision"];
        if decision["action"] != "run" {
            refused += 1;
            continue;
        }
        ran += 1;
        let model = decision["model"].as_str().unwrap_or("?").to_owned();
        let m = models.entry(model).or_default();
        m.0 += 1;
        m.1 += receipt["tokens"]["input"].as_u64().unwrap_or(0);
        m.2 += receipt["tokens"]["output"].as_u64().unwrap_or(0);
        for egress in receipt["egress"].as_array().into_iter().flatten() {
            let h = hosts.entry(egress["host"].as_str().unwrap_or("?").to_owned()).or_default();
            h.0 += 1;
            h.1 += egress["bytes_sent"].as_u64().unwrap_or(0);
            h.2 += egress["bytes_received"].as_u64().unwrap_or(0);
        }
    }
    json!({
        "requests": ran + refused,
        "ran": ran,
        "refused": refused,
        "models": models.into_iter().map(|(id, (n, i, o))| json!({ "model": id, "requests": n, "tokens_in": i, "tokens_out": o })).collect::<Vec<_>>(),
        "egress": hosts.into_iter().map(|(host, (n, s, r))| json!({ "host": host, "requests": n, "bytes_sent": s, "bytes_received": r })).collect::<Vec<_>>(),
    })
}

#[cfg(test)]
mod tests {
    use super::{AuditLog, Caller, summary};
    use crate::receipts::ReceiptKey;
    use serde_json::json;

    fn receipt(key: &ReceiptKey, id: &str, model: &str, egress: serde_json::Value) -> serde_json::Value {
        key.sign(json!({
            "version": 0, "request_id": id, "node": key.public(),
            "decision": { "action": "run", "model": model, "tier": "node", "reason": "requested" },
            "tokens": { "input": 10, "output": 5 }, "egress": egress,
        }))
        .unwrap()
    }

    #[test]
    fn chains_reads_verifies_and_catches_tampering() {
        let home = std::env::temp_dir().join(format!("invincible-audit-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&home);
        let key = ReceiptKey::from_seed(&[3; 32]);
        let log = AuditLog::new(&home);
        assert_eq!(log.verify(&key.public()), Ok(0));
        log.append(&Caller::Local, Some("autobot-agent"), "chat", &receipt(&key, "a1", "qwen", json!([]))).unwrap();
        log.append(&Caller::device("phone", &[7; 32]), None, "chat", &receipt(&key, "a2", "qwen", json!([]))).unwrap();
        // A fresh handle (a restarted node) continues the chain from the file.
        let log = AuditLog::new(&home);
        let egress =
            json!([{ "host": "api.example.com", "route": "tor", "bytes_sent": 100, "bytes_received": 40, "ok": true }]);
        log.append(&Caller::Local, None, "chat", &receipt(&key, "a3", "claude", egress)).unwrap();
        assert_eq!(log.verify(&key.public()), Ok(3));
        let entries = log.read(0, 2);
        assert_eq!(entries.len(), 2);
        assert_eq!(entries[0]["caller"], "device:phone");
        // A device's entry carries the key it was pinned with; the operator's carries none.
        assert_eq!(entries[0]["caller_key"], Caller::device("phone", &[7; 32]).key().unwrap());
        assert!(entries[1].get("caller_key").is_none());
        // Filtered, the newest entries are the filter's, not whatever was newest overall.
        let mine = log.read_where(0, 1, |e| e["caller"] == "device:phone");
        assert_eq!(mine.len(), 1);
        assert_eq!(mine[0]["receipt"]["receipt"]["request_id"], "a2");
        assert_eq!(entries[1]["receipt"]["receipt"]["request_id"], "a3");
        assert_eq!(log.read(0, 10)[0]["client"], "autobot-agent");
        assert_eq!(log.find("a2").unwrap()["receipt"]["request_id"], "a2");
        assert!(log.find("zz").is_none());
        let totals = summary(&log.read(0, 10));
        assert_eq!(totals["ran"], 3);
        assert_eq!(totals["models"][1], json!({ "model": "qwen", "requests": 2, "tokens_in": 20, "tokens_out": 10 }));
        assert_eq!(totals["egress"][0]["bytes_sent"], 100);
        assert!(log.verify(&ReceiptKey::from_seed(&[4; 32]).public()).is_err());

        // Removing the middle entry breaks the chain.
        let path = home.join("audit.jsonl");
        let text = std::fs::read_to_string(&path).unwrap();
        let lines: Vec<&str> = text.lines().collect();
        std::fs::write(&path, format!("{}\n{}\n", lines[0], lines[2])).unwrap();
        assert!(log.verify(&key.public()).unwrap_err().contains("entry 2: the chain is broken"));
        // Changing a receipt breaks its signature.
        std::fs::write(&path, format!("{}\n", lines[0].replace("\"qwen\"", "\"other\""))).unwrap();
        assert!(log.verify(&key.public()).unwrap_err().contains("signature"));
        std::fs::remove_dir_all(home).unwrap();
    }
}
