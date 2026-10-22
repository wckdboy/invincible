//! `invincible receipt verify <id>`: the handle a client already holds — the id in the response
//! header — resolves to that request's receipt in the audit log. Logs written before the id was
//! recorded in the entry still verify (their entries are simply not reachable by id), and an id that
//! is not exactly one receipt is refused with a reason rather than answered with a guess.

use std::path::{Path, PathBuf};
use std::process::{Command, Output};

use invincible::audit::{AuditLog, Caller};
use invincible::receipts::ReceiptKey;
use serde_json::{Value, json};

/// A node's home with its receipt key, and nothing else.
fn home(name: &str) -> (PathBuf, ReceiptKey) {
    let dir = std::env::temp_dir().join(format!("invincible-lookup-{name}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    let key = ReceiptKey::load_or_create(&dir.join("receipt.key")).unwrap();
    (dir, key)
}

/// A version 1 receipt for request [id], as this node signs it: everything the offline check reads.
fn bound(key: &ReceiptKey, id: &str) -> Value {
    key.sign(json!({
        "version": 1,
        "request_id": id,
        "node": key.public(),
        "at": 1_700_000_000,
        "api": "chat",
        "caller": { "kind": "local" },
        "request_sha256": "a".repeat(64),
        "answer_sha256": "b".repeat(64),
        "answer_bytes": 2,
        "answer_complete": true,
        "decision": { "action": "run", "model": "qwen", "tier": "node", "reason": "requested" },
        "egress": [],
    }))
    .unwrap()
}

/// A version 0 receipt: routing and accounting only. It names no request at all, like every receipt
/// written before receipts carried the exchange.
fn unbound(key: &ReceiptKey) -> Value {
    key.sign(json!({
        "version": 0,
        "node": key.public(),
        "decision": { "action": "run", "model": "qwen", "tier": "node", "reason": "requested" },
        "egress": [],
    }))
    .unwrap()
}

/// `invincible receipt verify <id>` against [home], as a client would run it.
fn verify(home: &Path, id: &str) -> Output {
    Command::new(env!("CARGO_BIN_EXE_invincible"))
        .args(["receipt", "verify", id])
        .env("INVINCIBLE_HOME", home)
        .output()
        .unwrap()
}

fn stdout(output: &Output) -> String {
    String::from_utf8_lossy(&output.stdout).into_owned()
}

fn stderr(output: &Output) -> String {
    String::from_utf8_lossy(&output.stderr).into_owned()
}

/// The id the client holds finds its receipt; an entry written before the id was recorded in the
/// log is not reachable by id but does not break the ones that are; and every entry still verifies.
#[test]
fn an_id_from_the_log_verifies_and_old_entries_still_do() {
    let (dir, key) = home("mixed");
    let log = AuditLog::new(&dir);
    // Written by this build: the id is on the entry.
    log.append_tagged(&Caller::Local, None, "chat", &bound(&key, "new1"), Some(&json!({ "request_id": "new1" })))
        .unwrap();
    // Written before the change: the id is only inside the signed receipt.
    log.append(&Caller::Local, None, "chat", &bound(&key, "old1")).unwrap();
    // Written before receipts carried the exchange: no id anywhere.
    log.append(&Caller::Local, None, "chat", &unbound(&key)).unwrap();
    assert_eq!(log.verify(&key.public()), Ok(3));
    assert_eq!(log.read(0, 10).len(), 3);

    let new = verify(&dir, "new1");
    assert!(new.status.success(), "{}", stderr(&new));
    assert!(stdout(&new).contains("receipt new1: version 1"), "{}", stdout(&new));
    assert!(stdout(&new).contains("signature: valid"), "{}", stdout(&new));

    // A receipt from before the change resolves too: the id is in the receipt it signed.
    let old = verify(&dir, "old1");
    assert!(old.status.success(), "{}", stderr(&old));
    assert!(stdout(&old).contains("receipt old1: version 1"), "{}", stdout(&old));

    // The entry without an id is not a dead end: it breaks nothing, and it is not reachable.
    let unknown = verify(&dir, "none");
    assert!(!unknown.status.success());
    assert!(
        stderr(&unknown).contains("no receipt none: not a file, and not in this node's audit log"),
        "{}",
        stderr(&unknown)
    );

    let _ = std::fs::remove_dir_all(dir);
}

/// One id is one receipt: an id that names two entries is refused, and says why.
#[test]
fn an_ambiguous_id_is_refused_rather_than_guessed() {
    let (dir, key) = home("tie");
    let log = AuditLog::new(&dir);
    log.append_tagged(&Caller::Local, None, "chat", &bound(&key, "tie"), Some(&json!({ "request_id": "tie" })))
        .unwrap();
    log.append_tagged(
        &Caller::Local,
        Some("autobot-agent"),
        "chat",
        &bound(&key, "tie"),
        Some(&json!({ "request_id": "tie" })),
    )
    .unwrap();
    let output = verify(&dir, "tie");
    assert!(!output.status.success());
    let error = stderr(&output);
    assert!(error.contains("request id tie"), "{error}");
    assert!(error.contains("2 entries"), "{error}");
    assert!(error.contains("none is chosen"), "{error}");
    assert!(stdout(&output).is_empty(), "nothing verified: {}", stdout(&output));
    let _ = std::fs::remove_dir_all(dir);
}
