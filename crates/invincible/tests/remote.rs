//! Remote access end to end: pairing, sessions through the tunnel, and the ways in that must stay
//! shut (wrong secret, unpaired device, impostor node, revoked device, used or expired code).

use std::sync::Arc;
use std::time::Duration;

use axum::Router;
use axum::body::Bytes;
use axum::response::IntoResponse;
use axum::routing::post;
use invincible::devices::{Devices, StaticKey};
use invincible::engine::Engine;
use invincible::remote::{self, Pairing, PairingCode};
use invincible::server::{AppState, DECISION_HEADER, device_app};
use invincible_policy::{Egress, NetworkMode, NodeSettings};
use serde_json::{Value, json};
use tokio::net::TcpListener;

struct Node {
    pairing: Arc<Pairing>,
    addr: String,
    dir: std::path::PathBuf,
}

impl Drop for Node {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

fn temp_dir(tag: &str) -> std::path::PathBuf {
    let n: u64 = u64::from_le_bytes(invincible::token::random::<8>().unwrap());
    std::env::temp_dir().join(format!("invincible-remote-{tag}-{n:x}"))
}

async fn stub_engine() -> String {
    let router = Router::new().route(
        "/v1/chat/completions",
        post(|body: Bytes| async move {
            let request: Value = serde_json::from_slice(&body).unwrap();
            if request["stream"] == json!(true) {
                ([("content-type", "text/event-stream")], "data: {\"n\":1}\n\ndata: [DONE]\n\n").into_response()
            } else {
                axum::Json(json!({ "engine_saw": request })).into_response()
            }
        }),
    );
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move { axum::serve(listener, router).await.unwrap() });
    format!("http://{addr}")
}

/// A node with one healthy engine and remote access on a loopback port.
async fn node() -> Node {
    let dir = temp_dir("node");
    let engine = Engine::attached("small", &stub_engine().await, None, true);
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap().to_string();
    let pairing = Arc::new(Pairing::new(
        StaticKey::load_or_create(&dir.join("node.key")).unwrap(),
        "studio".into(),
        vec![addr.clone()],
        Devices::load(&dir.join("devices.json")).unwrap(),
    ));
    let settings = NodeSettings { network: NetworkMode::Offline, egress: Egress::Never };
    let state = Arc::new(AppState::new(vec![engine], settings, "token".into()).with_pairing(pairing.clone()));
    tokio::spawn(remote::serve(listener, pairing.clone(), device_app(state)));
    Node { pairing, addr, dir }
}

fn device(tag: &str) -> (StaticKey, std::path::PathBuf) {
    let dir = temp_dir(tag);
    (StaticKey::load_or_create(&dir.join("device.key")).unwrap(), dir)
}

/// A local door to [node] for [device]; returns its base URL.
async fn tunnel(node: &Node, device: &StaticKey) -> String {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let door = listener.local_addr().unwrap();
    tokio::spawn(remote::tunnel(listener, vec![node.addr.clone()], node.pairing.key.public.clone(), device.clone()));
    format!("http://{door}")
}

#[tokio::test]
async fn a_paired_device_uses_the_api_through_the_tunnel() {
    let node = node().await;
    let (phone, dir) = device("phone");
    let code = node.pairing.start().unwrap();
    let paired = remote::pair(&PairingCode::decode(&code.encode()).unwrap(), &phone, "My Phone").await.unwrap();
    assert_eq!(paired.node, "studio");
    assert_eq!(paired.device, "My-Phone");
    assert!(node.pairing.devices.is_pinned(&phone.public));

    let door = tunnel(&node, &phone).await;
    let client = reqwest::Client::new();
    // No token: the device is authenticated by its key.
    let models: Value = client.get(format!("{door}/v1/models")).send().await.unwrap().json().await.unwrap();
    assert_eq!(models["data"][0]["id"], "small");

    let chat = client
        .post(format!("{door}/v1/chat/completions"))
        .json(&json!({ "messages": [{ "role": "user", "content": "hi" }] }))
        .send()
        .await
        .unwrap();
    assert_eq!(chat.status(), 200);
    assert_eq!(
        chat.headers()[DECISION_HEADER],
        r#"{"action":"run","model":"small","tier":"node","reason":"local-first"}"#
    );
    let body: Value = chat.json().await.unwrap();
    assert_eq!(body["engine_saw"]["messages"][0]["content"], "hi");

    let stream = client
        .post(format!("{door}/v1/chat/completions"))
        .json(&json!({ "stream": true, "messages": [] }))
        .send()
        .await
        .unwrap();
    assert_eq!(stream.text().await.unwrap(), "data: {\"n\":1}\n\ndata: [DONE]\n\n");

    // A large body crosses many frames intact.
    let big = "x".repeat(300_000);
    let echoed: Value = client
        .post(format!("{door}/v1/chat/completions"))
        .json(&json!({ "messages": [{ "role": "user", "content": big }] }))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(echoed["engine_saw"]["messages"][0]["content"].as_str().unwrap().len(), 300_000);

    // Devices cannot administer the node.
    let admin = client.get(format!("{door}/v1/admin/devices")).send().await.unwrap();
    assert_eq!(admin.status(), 404);
    let _ = std::fs::remove_dir_all(dir);
}

#[tokio::test]
async fn a_code_pairs_once() {
    let node = node().await;
    let code = node.pairing.start().unwrap();
    let (first, d1) = device("first");
    let (second, d2) = device("second");
    remote::pair(&code, &first, "first").await.unwrap();
    assert!(remote::pair(&code, &second, "second").await.is_err());
    assert!(!node.pairing.devices.is_pinned(&second.public));
    let _ = (std::fs::remove_dir_all(d1), std::fs::remove_dir_all(d2));
}

#[tokio::test]
async fn a_wrong_secret_does_not_pair() {
    let node = node().await;
    let mut code = node.pairing.start().unwrap();
    code.secret[0] ^= 1;
    let (phone, dir) = device("wrong-secret");
    assert!(remote::pair(&code, &phone, "phone").await.is_err());
    assert!(node.pairing.devices.list().is_empty());
    let _ = std::fs::remove_dir_all(dir);
}

#[tokio::test]
async fn guessing_burns_the_code() {
    let node = node().await;
    let code = node.pairing.start().unwrap();
    let (phone, dir) = device("guess");
    for _ in 0..5 {
        let mut guess = code.clone();
        guess.secret = invincible::token::random::<32>().unwrap();
        assert!(remote::pair(&guess, &phone, "phone").await.is_err());
    }
    // The real code no longer works either.
    assert!(remote::pair(&code, &phone, "phone").await.is_err());
    let _ = std::fs::remove_dir_all(dir);
}

#[tokio::test]
async fn an_expired_code_does_not_pair() {
    let node = node().await;
    let code = node.pairing.start_for(Duration::ZERO).unwrap();
    let (phone, dir) = device("expired");
    assert!(remote::pair(&code, &phone, "phone").await.is_err());
    let _ = std::fs::remove_dir_all(dir);
}

#[tokio::test]
async fn an_unpaired_device_gets_no_session() {
    let node = node().await;
    let (stranger, dir) = device("stranger");
    let result = remote::connect(std::slice::from_ref(&node.addr), &node.pairing.key.public, &stranger).await;
    assert!(result.is_err());
    let _ = std::fs::remove_dir_all(dir);
}

#[tokio::test]
async fn an_impostor_node_is_not_trusted() {
    let node = node().await;
    let (phone, dir) = device("victim");
    let mut code = node.pairing.start().unwrap();
    // The device expects a different node key than the one answering (a machine in the middle).
    let (impostor, idir) = device("impostor");
    code.node_key = impostor.public.as_slice().try_into().unwrap();
    assert!(remote::pair(&code, &phone, "phone").await.is_err());
    assert!(!node.pairing.devices.is_pinned(&phone.public));
    let _ = (std::fs::remove_dir_all(dir), std::fs::remove_dir_all(idir));
}

#[tokio::test]
async fn an_unpaired_device_is_cut_off() {
    let node = node().await;
    let (phone, dir) = device("revoked");
    remote::pair(&node.pairing.start().unwrap(), &phone, "phone").await.unwrap();
    let door = tunnel(&node, &phone).await;
    let client = reqwest::Client::new();
    assert_eq!(client.get(format!("{door}/v1/models")).send().await.unwrap().status(), 200);

    assert!(node.pairing.devices.remove("phone").unwrap());
    // A fresh connection is refused at the handshake.
    assert!(reqwest::Client::new().get(format!("{door}/v1/models")).send().await.is_err());
    // A connection opened before the unpairing dies at its next request.
    assert!(client.get(format!("{door}/v1/models")).send().await.is_err());
    let _ = std::fs::remove_dir_all(dir);
}
