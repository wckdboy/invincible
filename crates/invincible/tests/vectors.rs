//! The conformance vectors in `spec/vectors/` that the node crate implements (spec/README.md).

use std::path::PathBuf;

use base64::Engine as _;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use invincible::redact::Vault;
use invincible::remote::PairingCode;
use serde_json::{Value, json};

fn cases(name: &str) -> Vec<Value> {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../spec/vectors").join(format!("{name}.json"));
    let file: Value = serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
    assert_eq!(file["spec"], name);
    file["cases"].as_array().unwrap().clone()
}

#[test]
fn pairing_code() {
    let cases = cases("pairing-code");
    assert!(!cases.is_empty());
    let failures: Vec<String> = cases
        .iter()
        .filter_map(|case| {
            let got = match PairingCode::decode(case["input"].as_str().unwrap()) {
                Ok(code) => json!({
                    "node_key": URL_SAFE_NO_PAD.encode(code.node_key),
                    "secret": URL_SAFE_NO_PAD.encode(code.secret),
                    "addrs": code.addrs,
                }),
                Err(_) => json!({ "error": true }),
            };
            (got != case["expect"])
                .then(|| format!("{}\n  expected {}\n  got      {got}", case["name"], case["expect"]))
        })
        .collect();
    assert!(failures.is_empty(), "{} pairing-code cases failed:\n{}", failures.len(), failures.join("\n"));
}

#[test]
fn redaction() {
    let cases = cases("redaction");
    assert!(!cases.is_empty());
    let failures: Vec<String> = cases
        .iter()
        .filter_map(|case| {
            let input = case["input"].as_str().unwrap();
            let mut vault = Vault::default();
            vault.reserve(input);
            let text = vault.redact(input);
            let got = json!({ "text": text, "found": vault.found() });
            (got != case["expect"])
                .then(|| format!("{}\n  expected {}\n  got      {got}", case["name"], case["expect"]))
        })
        .collect();
    assert!(
        failures.is_empty(),
        "{} of {} redaction cases failed:\n{}",
        failures.len(),
        cases.len(),
        failures.join("\n")
    );
}
