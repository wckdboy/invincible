//! The Anthropic Messages endpoint: routed by the same rules, served by node engines only.

use std::sync::{Arc, Mutex};

use axum::Router;
use axum::body::Bytes;
use axum::routing::post;
use invincible::cloud::CloudModel;
use invincible::engine::Engine;
use invincible::receipts::REQUEST_ID_HEADER;
use invincible::server::{AppState, DECISION_HEADER, app};
use invincible_policy::{DataPolicy, Egress, NetworkMode, NodeSettings};
use serde_json::{Value, json};

async fn serve(router: Router) -> String {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move { axum::serve(listener, router).await.unwrap() });
    format!("http://{addr}")
}

/// A node with a local engine that speaks Messages (as llama.cpp does) and a cloud model that
/// must never see a Messages request.
async fn node() -> (String, Arc<Mutex<Vec<Value>>>) {
    let seen = Arc::new(Mutex::new(Vec::new()));
    let record = seen.clone();
    let engine = serve(Router::new().route(
        "/v1/messages",
        post(move |body: Bytes| {
            let record = record.clone();
            async move {
                record.lock().unwrap().push(serde_json::from_slice::<Value>(&body).unwrap());
                axum::Json(json!({
                    "type": "message", "role": "assistant",
                    "content": [{ "type": "text", "text": "ok" }],
                    "usage": { "input_tokens": 14, "output_tokens": 2 }
                }))
            }
        }),
    ))
    .await;
    let cloud = CloudModel::new("claude", "c", "http://127.0.0.1:9/v1", None, None, DataPolicy::NoRetention);
    let state = AppState::new(
        vec![Engine::attached("local", &engine, Some(64), true)],
        NodeSettings { network: NetworkMode::Direct, egress: Egress::Auto },
        "t".into(),
    )
    .with_cloud(vec![cloud]);
    (serve(app(Arc::new(state))).await, seen)
}

fn messages(node: &str, body: Value) -> reqwest::RequestBuilder {
    reqwest::Client::new().post(format!("{node}/v1/messages")).bearer_auth("t").json(&body)
}

#[tokio::test]
async fn messages_run_on_the_node_engine() {
    let (node, seen) = node().await;
    let body = json!({ "model": "local", "max_tokens": 10, "system": "be brief", "messages": [{ "role": "user", "content": "hi" }] });
    let response = messages(&node, body.clone()).send().await.unwrap();
    assert_eq!(response.status(), 200);
    assert_eq!(
        response.headers()[DECISION_HEADER],
        r#"{"action":"run","model":"local","tier":"node","reason":"requested"}"#
    );
    let id = response.headers()[REQUEST_ID_HEADER].to_str().unwrap().to_owned();
    let answer: Value = response.json().await.unwrap();
    assert_eq!(answer["content"][0]["text"], "ok");
    assert_eq!(seen.lock().unwrap()[0], body);
    // Receipts read Anthropic's token names.
    let receipt: Value = reqwest::Client::new()
        .get(format!("{node}/v1/receipts/{id}"))
        .bearer_auth("t")
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(receipt["receipt"]["tokens"], json!({ "input": 14, "output": 2 }));
}

#[tokio::test]
async fn messages_never_go_to_the_cloud() {
    let (node, seen) = node().await;
    let named = messages(&node, json!({ "model": "claude", "max_tokens": 10, "messages": [] })).send().await.unwrap();
    assert_eq!(named.status(), 404);
    assert_eq!(named.headers()[DECISION_HEADER], r#"{"action":"block","reason":"unknown-model"}"#);
    // Too long for the node: auto has no cloud to go to on this endpoint.
    let long = "long ".repeat(100);
    let auto = messages(&node, json!({ "max_tokens": 10, "messages": [{ "role": "user", "content": long }] }))
        .send()
        .await
        .unwrap();
    assert_eq!(auto.status(), 503);
    assert_eq!(auto.headers()[DECISION_HEADER], r#"{"action":"block","reason":"no-model"}"#);
    assert!(seen.lock().unwrap().is_empty());
}
