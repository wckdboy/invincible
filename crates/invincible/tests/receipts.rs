//! Receipts end to end (spec/receipts.md): what each kind of request gets, that the numbers are the
//! real ones, and that the signature checks out against the key the node publishes.

use std::sync::{Arc, Mutex};

use axum::Router;
use axum::body::Bytes;
use axum::http::StatusCode;
use axum::response::IntoResponse;
use axum::routing::post;
use invincible::cloud::CloudModel;
use invincible::engine::Engine;
use invincible::receipts::{REQUEST_ID_HEADER, ReceiptKey, verify};
use invincible::server::{AppState, app};
use invincible_policy::{DataPolicy, Egress, NetworkMode, NodeSettings};
use serde_json::{Value, json};

async fn serve(router: Router) -> String {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move { axum::serve(listener, router).await.unwrap() });
    format!("http://{addr}")
}

/// A local engine that reports usage, streamed or not.
async fn engine() -> String {
    serve(Router::new().route(
        "/v1/chat/completions",
        post(|body: Bytes| async move {
            let request: Value = serde_json::from_slice(&body).unwrap();
            if request["stream"] == json!(true) {
                let events = "data: {\"choices\":[{\"index\":0,\"delta\":{\"content\":\"hi\"}}]}\n\n\
                              data: {\"choices\":[],\"usage\":{\"prompt_tokens\":7,\"completion_tokens\":2}}\n\ndata: [DONE]\n\n";
                ([("content-type", "text/event-stream")], events).into_response()
            } else {
                axum::Json(json!({
                    "choices": [{ "message": { "content": "local" } }],
                    "usage": { "prompt_tokens": 19, "completion_tokens": 8 }
                }))
                .into_response()
            }
        }),
    ))
    .await
}

/// A provider that records the size of each request it receives, or fails when [fail] is set.
async fn provider(fail: bool) -> (String, Arc<Mutex<Vec<usize>>>) {
    let sizes = Arc::new(Mutex::new(Vec::new()));
    let record = sizes.clone();
    let url = serve(Router::new().route(
        "/v1/chat/completions",
        post(move |body: Bytes| {
            let record = record.clone();
            async move {
                record.lock().unwrap().push(body.len());
                if fail {
                    return (StatusCode::SERVICE_UNAVAILABLE, "busy").into_response();
                }
                axum::Json(json!({
                    "choices": [{ "message": { "content": "cloud" } }],
                    "usage": { "prompt_tokens": 30, "completion_tokens": 4 }
                }))
                .into_response()
            }
        }),
    ))
    .await;
    (format!("{url}/v1"), sizes)
}

async fn node(cloud_url: &str) -> String {
    let engine = Engine::attached("local", &engine().await, Some(64), true);
    let cloud = CloudModel::new("claude", "upstream", cloud_url, None, None, DataPolicy::Retention { days: 30 });
    let state =
        AppState::new(vec![engine], NodeSettings { network: NetworkMode::Direct, egress: Egress::Auto }, "t".into())
            .with_cloud(vec![cloud])
            .with_receipt_key("studio", ReceiptKey::from_seed(&[9; 32]));
    serve(app(Arc::new(state))).await
}

#[tokio::test]
async fn the_audit_log_keeps_every_receipt_with_who_asked() {
    let dir = std::env::temp_dir().join(format!("invincible-audit-api-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    let (url, _) = provider(false).await;
    let engine = Engine::attached("local", &engine().await, Some(64), true);
    let cloud = CloudModel::new("claude", "upstream", &url, None, None, DataPolicy::Retention { days: 30 });
    let key = ReceiptKey::from_seed(&[9; 32]);
    let public = key.public();
    let state =
        AppState::new(vec![engine], NodeSettings { network: NetworkMode::Direct, egress: Egress::Auto }, "t".into())
            .with_cloud(vec![cloud])
            .with_receipt_key("studio", key)
            .with_audit(invincible::audit::AuditLog::new(&dir));
    let node = serve(app(Arc::new(state))).await;
    receipt_for(&node, say("auto", "hi"), &[("invincible-client", "autobot-agent")]).await;
    receipt_for(&node, say("claude", "hi"), &[("invincible-confirmed", "1")]).await;
    let audit: Value =
        client().get(format!("{node}/v1/audit")).bearer_auth("t").send().await.unwrap().json().await.unwrap();
    let entries = audit["entries"].as_array().unwrap();
    assert_eq!(entries.len(), 2);
    assert_eq!(entries[0]["caller"], "local");
    assert_eq!(entries[0]["client"], "autobot-agent");
    assert_eq!(entries[0]["api"], "chat");
    assert_eq!(entries[1]["receipt"]["receipt"]["decision"]["model"], "claude");
    assert_eq!(audit["summary"]["ran"], 2);
    assert_eq!(audit["summary"]["egress"][0]["requests"], 1);
    // `since` in the future: nothing.
    let later: Value = client()
        .get(format!("{node}/v1/audit?since=99999999999"))
        .bearer_auth("t")
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(later["entries"], json!([]));
    // Behind the token.
    assert_eq!(client().get(format!("{node}/v1/audit")).send().await.unwrap().status(), 401);
    assert_eq!(invincible::audit::AuditLog::new(&dir).verify(&public), Ok(2));
    std::fs::remove_dir_all(dir).unwrap();
}

fn client() -> reqwest::Client {
    reqwest::Client::new()
}

/// Sends [body], reads the whole answer, and returns the verified receipt.
async fn receipt_for(node: &str, body: Value, headers: &[(&str, &str)]) -> Value {
    let mut request = client().post(format!("{node}/v1/chat/completions")).bearer_auth("t").json(&body);
    for (name, value) in headers {
        request = request.header(*name, *value);
    }
    let response = request.send().await.unwrap();
    let id = response.headers()[REQUEST_ID_HEADER].to_str().unwrap().to_owned();
    assert_eq!(id.len(), 32);
    let _ = response.bytes().await.unwrap();
    let envelope: Value =
        client().get(format!("{node}/v1/receipts/{id}")).bearer_auth("t").send().await.unwrap().json().await.unwrap();
    let key: Value =
        client().get(format!("{node}/v1/node")).bearer_auth("t").send().await.unwrap().json().await.unwrap();
    assert_eq!(key["name"], "studio");
    assert!(
        verify(key["receipt_key"].as_str().unwrap(), &envelope["receipt"], envelope["signature"].as_str().unwrap()),
        "signature does not verify: {envelope}"
    );
    assert_eq!(envelope["receipt"]["request_id"], id);
    assert_eq!(envelope["receipt"]["node"], key["receipt_key"]);
    envelope["receipt"].clone()
}

fn say(model: &str, text: &str) -> Value {
    json!({ "model": model, "messages": [{ "role": "user", "content": text }] })
}

#[tokio::test]
async fn a_local_run_says_nothing_left() {
    let (url, sizes) = provider(false).await;
    let node = node(&url).await;
    let receipt = receipt_for(&node, say("auto", "hi"), &[]).await;
    assert_eq!(
        receipt["decision"],
        json!({ "action": "run", "model": "local", "tier": "node", "reason": "local-first" })
    );
    assert_eq!(receipt["egress"], json!([]));
    assert_eq!(receipt["data_policy"], "owned");
    assert_eq!(receipt["tokens"], json!({ "input": 19, "output": 8 }));
    assert!(receipt.get("redactions").is_none());
    assert!(sizes.lock().unwrap().is_empty());
}

#[tokio::test]
async fn a_streamed_run_counts_tokens_from_the_last_chunk() {
    let (url, _) = provider(false).await;
    let node = node(&url).await;
    let mut body = say("auto", "hi");
    body["stream"] = json!(true);
    let receipt = receipt_for(&node, body, &[]).await;
    assert_eq!(receipt["tokens"], json!({ "input": 7, "output": 2 }));
}

#[tokio::test]
async fn a_cloud_run_lists_its_egress_and_redactions() {
    let (url, sizes) = provider(false).await;
    let node = node(&url).await;
    let receipt = receipt_for(&node, say("claude", "mail alice@proton.me"), &[]).await;
    assert_eq!(receipt["decision"]["tier"], "cloud");
    assert_eq!(receipt["data_policy"], "retention:30");
    assert_eq!(receipt["redactions"], json!({ "EMAIL": 1 }));
    assert_eq!(receipt["tokens"], json!({ "input": 30, "output": 4 }));
    let egress = receipt["egress"].as_array().unwrap();
    assert_eq!(egress.len(), 1);
    assert_eq!(egress[0]["host"], "127.0.0.1");
    assert_eq!(egress[0]["route"], "direct");
    assert_eq!(egress[0]["ok"], true);
    // The numbers are the real ones: what the provider received, and a non-empty answer.
    assert_eq!(egress[0]["bytes_sent"], json!(sizes.lock().unwrap()[0]));
    assert!(egress[0]["bytes_received"].as_u64().unwrap() > 0);
}

#[tokio::test]
async fn a_failed_attempt_is_listed_before_the_fallback() {
    let (url, sizes) = provider(true).await;
    let node = node(&url).await;
    let receipt = receipt_for(&node, say("claude", "hi"), &[]).await;
    assert_eq!(
        receipt["decision"],
        json!({ "action": "run", "model": "local", "tier": "node", "reason": "cloud-down", "fallback": true })
    );
    assert_eq!(receipt["data_policy"], "owned");
    let egress = receipt["egress"].as_array().unwrap();
    assert_eq!(egress.len(), 1);
    assert_eq!(egress[0]["ok"], false);
    assert_eq!(egress[0]["bytes_sent"], json!(sizes.lock().unwrap()[0]));
}

#[tokio::test]
async fn a_blocked_request_gets_a_receipt_too() {
    let (url, sizes) = provider(false).await;
    let node = node(&url).await;
    let long = "long ".repeat(100);
    let receipt = receipt_for(&node, say("auto", &long), &[("invincible-private", "1")]).await;
    assert_eq!(receipt["decision"], json!({ "action": "block", "reason": "private" }));
    assert_eq!(receipt["egress"], json!([]));
    assert!(receipt.get("data_policy").is_none());
    assert!(sizes.lock().unwrap().is_empty());
}

#[tokio::test]
async fn an_unknown_receipt_is_not_found() {
    let (url, _) = provider(false).await;
    let node = node(&url).await;
    let response =
        client().get(format!("{node}/v1/receipts/{}", "0".repeat(32))).bearer_auth("t").send().await.unwrap();
    assert_eq!(response.status(), 404);
}
