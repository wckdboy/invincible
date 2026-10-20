//! Images through the gateway: passed on to local engines and cloud backends as they came (only
//! text is redacted), refused for a model known not to see them, noted on receipts and in the
//! audit log by hash, size and type (never their bytes), and big requests are taken.

use std::sync::{Arc, Mutex};

use axum::Router;
use axum::body::Bytes;
use axum::routing::post;
use base64::Engine as _;
use invincible::audit::AuditLog;
use invincible::cloud::CloudModel;
use invincible::engine::Engine;
use invincible::receipts::{REQUEST_ID_HEADER, ReceiptKey, verify};
use invincible::server::{AppState, MAX_REQUEST, app};
use invincible_policy::{DataPolicy, Egress, NetworkMode, NodeSettings};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

async fn serve(router: Router) -> String {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move { axum::serve(listener, router).await.unwrap() });
    format!("http://{addr}")
}

/// A backend (engine or provider) that keeps every body it gets and answers "seen".
async fn backend() -> (String, Arc<Mutex<Vec<Value>>>) {
    let seen = Arc::new(Mutex::new(Vec::new()));
    let record = seen.clone();
    let url = serve(
        Router::new()
            .route(
                "/v1/chat/completions",
                post(move |body: Bytes| {
                    let record = record.clone();
                    async move {
                        record.lock().unwrap().push(serde_json::from_slice::<Value>(&body).unwrap());
                        axum::Json(json!({ "choices": [{ "message": { "role": "assistant", "content": "seen" } }] }))
                    }
                }),
            )
            // Real engines take big bodies (axum's default would refuse past 2 MB).
            .layer(axum::extract::DefaultBodyLimit::disable()),
    )
    .await;
    (url, seen)
}

struct Node {
    url: String,
    engine: Arc<Mutex<Vec<Value>>>,
    cloud: Arc<Mutex<Vec<Value>>>,
    home: std::path::PathBuf,
}

/// A node with a local model that sees (`eyes`), one that does not (`blind`) and a cloud model
/// that sees; an audit log in a home of its own.
async fn node(name: &str) -> Node {
    let (engine_url, engine) = backend().await;
    let (cloud_url, cloud) = backend().await;
    let home = std::env::temp_dir().join(format!("invincible-images-{name}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&home);
    std::fs::create_dir_all(&home).unwrap();
    let engines = vec![
        Engine::attached("blind", &engine_url, None, true).with_vision(Some(false)),
        Engine::attached("eyes", &engine_url, None, true).with_vision(Some(true)),
    ];
    let claude =
        CloudModel::new("claude", "claude-sonnet-5-5", &format!("{cloud_url}/v1"), None, None, DataPolicy::NoRetention);
    assert_eq!(claude.vision, Some(true), "known by its name");
    let state = AppState::new(engines, NodeSettings { network: NetworkMode::Direct, egress: Egress::Auto }, "t".into())
        .with_cloud(vec![claude])
        .with_receipt_key("studio", ReceiptKey::from_seed(&[3; 32]))
        .with_audit(AuditLog::new(&home));
    Node { url: serve(app(Arc::new(state))).await, engine, cloud, home }
}

fn png() -> Vec<u8> {
    // Any bytes do: the gateway does not decode images.
    let mut bytes = b"\x89PNG\r\n\x1a\n".to_vec();
    bytes.extend((0..2000u32).map(|i| (i % 251) as u8));
    bytes
}

fn data_url(bytes: &[u8]) -> String {
    format!("data:image/png;base64,{}", base64::engine::general_purpose::STANDARD.encode(bytes))
}

fn with_image(model: &str, text: &str, url: &str) -> Value {
    json!({ "model": model, "messages": [
        { "role": "system", "content": "you see images" },
        { "role": "user", "content": [
            { "type": "text", "text": text },
            { "type": "image_url", "image_url": { "url": url } },
        ]},
    ]})
}

async fn send(node: &str, body: &Value) -> reqwest::Response {
    reqwest::Client::new().post(format!("{node}/v1/chat/completions")).bearer_auth("t").json(body).send().await.unwrap()
}

#[tokio::test]
async fn images_reach_local_and_cloud_models_unchanged_and_only_text_is_redacted() {
    let node = node("pass").await;
    let url = data_url(&png());
    let local = send(&node.url, &with_image("eyes", "what is this?", &url)).await;
    assert_eq!(local.status(), 200);
    let sent = node.engine.lock().unwrap()[0].clone();
    assert_eq!(sent, with_image("eyes", "what is this?", &url), "the engine gets the body as it was sent");

    let cloud = send(&node.url, &with_image("claude", "send it to alice@proton.me", &url)).await;
    assert_eq!(cloud.status(), 200);
    let sent = node.cloud.lock().unwrap()[0].clone();
    let parts = &sent["messages"][1]["content"];
    assert_eq!(parts[0]["text"], "send it to [EMAIL_1]", "text is redacted");
    assert_eq!(parts[1], json!({ "type": "image_url", "image_url": { "url": url } }), "the image is not touched");
    let _ = std::fs::remove_dir_all(&node.home);
}

#[tokio::test]
async fn a_model_that_cannot_see_is_not_sent_images() {
    let node = node("blind").await;
    let response = send(&node.url, &with_image("blind", "what is this?", &data_url(&png()))).await;
    assert_eq!(response.status(), 400);
    let body: Value = response.json().await.unwrap();
    assert_eq!(body["error"]["code"], "model_cannot_see_images");
    assert!(body["error"]["message"].as_str().unwrap().starts_with("blind can't see images"), "{body}");
    assert!(node.engine.lock().unwrap().is_empty());
    // Text alone is fine.
    let text = json!({ "model": "blind", "messages": [{ "role": "user", "content": "hi" }] });
    assert_eq!(send(&node.url, &text).await.status(), 200);
    // And /v1/models says who sees.
    let models: Value = reqwest::Client::new()
        .get(format!("{}/v1/models", node.url))
        .bearer_auth("t")
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let vision: Vec<(String, Value)> = models["data"]
        .as_array()
        .unwrap()
        .iter()
        .map(|m| (m["id"].as_str().unwrap().to_owned(), m["invincible"]["vision"].clone()))
        .collect();
    assert_eq!(vision, [("blind".into(), json!(false)), ("eyes".into(), json!(true)), ("claude".into(), json!(true))]);
    let _ = std::fs::remove_dir_all(&node.home);
}

#[tokio::test]
async fn receipts_and_the_audit_log_note_images_by_hash_never_their_bytes() {
    let node = node("receipt").await;
    let bytes = png();
    let url = data_url(&bytes);
    let response = send(&node.url, &with_image("claude", "what is this?", &url)).await;
    let id = response.headers()[REQUEST_ID_HEADER].to_str().unwrap().to_owned();
    let _ = response.text().await.unwrap();
    let envelope: Value = reqwest::Client::new()
        .get(format!("{}/v1/receipts/{id}", node.url))
        .bearer_auth("t")
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let receipt = &envelope["receipt"];
    let sha: String = Sha256::digest(&bytes).iter().map(|b| format!("{b:02x}")).collect();
    assert_eq!(receipt["images"], json!([{ "sha256": sha, "bytes": bytes.len(), "mime": "image/png" }]));
    let key = ReceiptKey::from_seed(&[3; 32]).public();
    assert!(verify(&key, receipt, envelope["signature"].as_str().unwrap()));
    // The audit log has the receipt, and nothing of the image itself.
    let mut log = String::new();
    for _ in 0..50 {
        log = std::fs::read_to_string(node.home.join("audit.jsonl")).unwrap_or_default();
        if !log.is_empty() {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(20)).await;
    }
    assert!(log.contains(&sha), "{log}");
    let payload = url.split_once(',').unwrap().1;
    assert!(!log.contains(&payload[..64]), "no base64 in the log");
    assert!(!log.contains("what is this"), "no prompt text either");
    // A request without images has no `images` on its receipt.
    let plain = send(&node.url, &json!({ "model": "eyes", "messages": [{ "role": "user", "content": "hi" }] })).await;
    let id = plain.headers()[REQUEST_ID_HEADER].to_str().unwrap().to_owned();
    let _ = plain.text().await.unwrap();
    let envelope: Value = reqwest::Client::new()
        .get(format!("{}/v1/receipts/{id}", node.url))
        .bearer_auth("t")
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert!(envelope["receipt"].get("images").is_none());
    let _ = std::fs::remove_dir_all(&node.home);
}

#[tokio::test]
async fn requests_with_several_big_images_are_taken_up_to_the_limit() {
    let node = node("big").await;
    // About 6 MB of base64: over axum's 2 MB default, well under the limit.
    let big: Vec<u8> = (0..4_500_000u32).map(|i| (i * 7 % 256) as u8).collect();
    let response = send(&node.url, &with_image("eyes", "and this?", &data_url(&big))).await;
    assert_eq!(response.status(), 200);
    assert_eq!(node.engine.lock().unwrap().len(), 1);
    // Past the limit: refused before anything is sent on.
    let huge = "x".repeat(MAX_REQUEST + 1);
    let response = send(&node.url, &with_image("eyes", "too big", &huge)).await;
    assert_eq!(response.status(), 413);
    assert_eq!(node.engine.lock().unwrap().len(), 1);
    let _ = std::fs::remove_dir_all(&node.home);
}
