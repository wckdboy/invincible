//! `spec/vectors/noise.json`: full pairing and session transcripts produced by snow with fixed
//! keys, so a device's Noise implementation (Autobot's, in Kotlin) can be checked byte for byte.
//!
//! The test regenerates the transcripts and compares them with the file; run with
//! `INVINCIBLE_WRITE_VECTORS=1` to rewrite the file after a deliberate protocol change.

use std::path::PathBuf;

use invincible::remote::{PAIR_PATTERN, SESSION_PATTERN};
use serde_json::{Value, json};

// RFC 7748 §6.1 X25519 test keys: Alice is the device, Bob the node.
const DEVICE_STATIC: &str = "77076d0a7318a57d3c16c17251b26645df4c2f87ebc0992ab177fba51db92c2a";
const DEVICE_STATIC_PUBLIC: &str = "8520f0098930a754748b7ddcb43ef75a0dbf3a0d26381af4eba4a98eaa9b4e6a";
const NODE_STATIC: &str = "5dab087e624a8a4b79e17f8b83800ee66f3bb1292618b6fd1c2f8b27ff88e0eb";
const NODE_STATIC_PUBLIC: &str = "de9edb7d7b7dc1b4d35b61c2ece435373f8343c85b78674dadfc7e146f882b4f";
const DEVICE_EPHEMERAL: &str = "1111111111111111111111111111111111111111111111111111111111111111";
const NODE_EPHEMERAL: &str = "2222222222222222222222222222222222222222222222222222222222222222";
const PSK: &str = "0909090909090909090909090909090909090909090909090909090909090909";

fn hex(bytes: &[u8]) -> String {
    invincible::token::hex(bytes)
}

fn unhex(text: &str) -> Vec<u8> {
    (0..text.len()).step_by(2).map(|i| u8::from_str_radix(&text[i..i + 2], 16).unwrap()).collect()
}

/// One transcript: the two handshake messages, then one transport message each way.
fn transcript(name: &str, pattern: &str, prologue: &[u8], psk: Option<&str>, payloads: [&[u8]; 4]) -> Value {
    let (device_static, node_static) = (unhex(DEVICE_STATIC), unhex(NODE_STATIC));
    let (device_e, node_e) = (unhex(DEVICE_EPHEMERAL), unhex(NODE_EPHEMERAL));
    let node_public = unhex(NODE_STATIC_PUBLIC);
    let psk_bytes: Option<[u8; 32]> = psk.map(|p| unhex(p).try_into().unwrap());

    let mut initiator = snow::Builder::new(pattern.parse().unwrap())
        .local_private_key(&device_static)
        .and_then(|b| b.remote_public_key(&node_public))
        .and_then(|b| b.prologue(prologue))
        .unwrap()
        .fixed_ephemeral_key_for_testing_only(&device_e);
    let mut responder = snow::Builder::new(pattern.parse().unwrap())
        .local_private_key(&node_static)
        .and_then(|b| b.prologue(prologue))
        .unwrap()
        .fixed_ephemeral_key_for_testing_only(&node_e);
    if let Some(psk) = &psk_bytes {
        initiator = initiator.psk(1, psk).unwrap();
        responder = responder.psk(1, psk).unwrap();
    }
    let mut initiator = initiator.build_initiator().unwrap();
    let mut responder = responder.build_responder().unwrap();
    let mut out = vec![0u8; 65535];
    let mut back = vec![0u8; 65535];
    let mut messages = Vec::new();

    let n = initiator.write_message(payloads[0], &mut out).unwrap();
    messages.push(json!({ "from": "device", "payload": hex(payloads[0]), "ciphertext": hex(&out[..n]) }));
    let m = responder.read_message(&out[..n], &mut back).unwrap();
    assert_eq!(&back[..m], payloads[0]);
    assert_eq!(hex(responder.get_remote_static().unwrap()), DEVICE_STATIC_PUBLIC);

    let n = responder.write_message(payloads[1], &mut out).unwrap();
    messages.push(json!({ "from": "node", "payload": hex(payloads[1]), "ciphertext": hex(&out[..n]) }));
    let m = initiator.read_message(&out[..n], &mut back).unwrap();
    assert_eq!(&back[..m], payloads[1]);

    let mut initiator = initiator.into_transport_mode().unwrap();
    let mut responder = responder.into_transport_mode().unwrap();
    let n = initiator.write_message(payloads[2], &mut out).unwrap();
    messages.push(json!({ "from": "device", "payload": hex(payloads[2]), "ciphertext": hex(&out[..n]) }));
    let m = responder.read_message(&out[..n], &mut back).unwrap();
    assert_eq!(&back[..m], payloads[2]);
    let n = responder.write_message(payloads[3], &mut out).unwrap();
    messages.push(json!({ "from": "node", "payload": hex(payloads[3]), "ciphertext": hex(&out[..n]) }));
    let m = initiator.read_message(&out[..n], &mut back).unwrap();
    assert_eq!(&back[..m], payloads[3]);

    json!({
        "name": name,
        "input": {
            "protocol": pattern,
            "prologue": hex(prologue),
            "psk": psk,
            "device_static": DEVICE_STATIC,
            "device_ephemeral": DEVICE_EPHEMERAL,
            "node_static": NODE_STATIC,
            "node_ephemeral": NODE_EPHEMERAL,
            "node_static_public": NODE_STATIC_PUBLIC,
        },
        "expect": { "device_static_public": DEVICE_STATIC_PUBLIC, "messages": messages },
    })
}

#[test]
fn noise_transcripts_match_the_spec() {
    let request = b"GET /v1/models HTTP/1.1\r\nhost: node\r\n\r\n";
    let answer = b"HTTP/1.1 200 OK\r\ncontent-length: 2\r\n\r\n{}";
    // The pairing reply carries the capability set the code granted (spec/pairing.md,
    // Capabilities) — `["shard"]` for a code with no other grant. A reply without the field comes
    // from a node before 0.0.22, which gave a paired device its whole API.
    let pair_reply = br#"{"capabilities":["shard"],"device":"phone","node":"studio","receipts":"key"}"#;
    let file = json!({
        "spec": "noise",
        "version": 0,
        "cases": [
            transcript(
                "pairing: IKpsk1 with the code's secret",
                PAIR_PATTERN,
                b"invincible/0 pair",
                Some(PSK),
                [br#"{"name":"phone"}"#, pair_reply, request, answer],
            ),
            transcript(
                "a session: IK with pinned keys",
                SESSION_PATTERN,
                b"invincible/0 session",
                None,
                [b"", b"", request, answer],
            ),
        ],
    });
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../spec/vectors/noise.json");
    let text = serde_json::to_string_pretty(&file).unwrap() + "\n";
    if std::env::var_os("INVINCIBLE_WRITE_VECTORS").is_some() {
        std::fs::write(&path, &text).unwrap();
    }
    let pinned =
        std::fs::read_to_string(&path).expect("spec/vectors/noise.json (write it with INVINCIBLE_WRITE_VECTORS=1)");
    assert_eq!(pinned, text, "snow no longer produces the pinned transcripts");
}
