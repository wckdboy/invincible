//! Embeddings through the node (`/v1/embeddings`), against a stub engine on loopback: the engine
//! is chosen by the router, chat routing never sees it, nothing leaves, and the receipt says so.

use std::sync::{Arc, Mutex};

use axum::Router;
use axum::body::Bytes;
use axum::response::IntoResponse;
use axum::routing::{get, post};
use invincible::engine::Engine;
use invincible::receipts::REQUEST_ID_HEADER;
use invincible::server::{AppState, DECISION_HEADER, app};
use invincible_policy::{Egress, NetworkMode, NodeSettings};
use serde_json::{Value, json};

type Seen = Arc<Mutex<Vec<Value>>>;

/// A stand-in for `llama-server --embeddings`: `/health`, and `/v1/embeddings` answering one
/// vector per input.
async fn engine() -> (String, Seen) {
    let seen: Seen = Arc::default();
    let s = seen.clone();
    let router = Router::new().route("/health", get(|| async { "ok" })).route(
        "/v1/embeddings",
        post(move |body: Bytes| {
            let seen = s.clone();
            async move {
                let body: Value = serde_json::from_slice(&body).unwrap();
                let n = match &body["input"] {
                    Value::Array(items) => items.len(),
                    _ => 1,
                };
                seen.lock().unwrap().push(body.clone());
                let data: Vec<Value> =
                    (0..n).map(|i| json!({ "object": "embedding", "index": i, "embedding": [0.1, 0.2, 0.3] })).collect();
                axum::Json(json!({ "object": "list", "model": body["model"], "data": data, "usage": { "prompt_tokens": 3, "total_tokens": 3 } }))
                    .into_response()
            }
        }),
    );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move { axum::serve(listener, router).await.unwrap() });
    (format!("http://{addr}"), seen)
}

async fn node(engines: Vec<Engine>) -> String {
    let settings = NodeSettings { network: NetworkMode::Offline, egress: Egress::Never };
    let state = AppState::new(engines, settings, "t".into());
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move { axum::serve(listener, app(Arc::new(state))).await.unwrap() });
    format!("http://{addr}")
}

async fn post_json(url: &str, body: Value, headers: &[(&str, &str)]) -> reqwest::Response {
    let mut request = reqwest::Client::new().post(url).bearer_auth("t").json(&body);
    for (name, value) in headers {
        request = request.header(*name, *value);
    }
    request.send().await.unwrap()
}

async fn get_json(url: &str) -> Value {
    reqwest::Client::new().get(url).bearer_auth("t").send().await.unwrap().json().await.unwrap()
}

#[tokio::test]
async fn embeddings_run_on_the_node_with_a_receipt_and_never_leave() {
    let (url, seen) = engine().await;
    let embed = Engine::attached("nomic", &url, Some(8192), true).with_embeddings(true);
    let chat = Engine::attached("qwen", &url, Some(8192), true);
    let node = node(vec![chat, embed]).await;

    let info = get_json(&format!("{node}/v1/node")).await;
    assert_eq!(info["embeddings"], json!([{ "id": "nomic", "healthy": true }]));
    assert_eq!(info["transcription"], json!([]));

    let response = post_json(
        &format!("{node}/v1/embeddings"),
        json!({ "input": ["The build is green.", "anna.berg@proton.me"] }),
        &[("invincible-private", "1")],
    )
    .await;
    assert_eq!(response.status(), 200);
    let decision: Value = serde_json::from_str(response.headers()[DECISION_HEADER].to_str().unwrap()).unwrap();
    assert_eq!(decision["model"], "nomic", "`auto` takes the embedding engine, never the chat one");
    assert_eq!(decision["tier"], "node");
    let id = response.headers()[REQUEST_ID_HEADER].to_str().unwrap().to_owned();
    let body: Value = response.json().await.unwrap();
    assert_eq!(body["data"].as_array().unwrap().len(), 2);
    let envelope = get_json(&format!("{node}/v1/receipts/{id}")).await;
    let receipt = &envelope["receipt"];
    assert_eq!(receipt["data_policy"], "owned");
    assert_eq!(receipt["egress"], json!([]), "nothing left the machine");
    assert!(receipt.get("redactions").is_none(), "nothing to redact on the node");
    let sent = seen.lock().unwrap()[0].clone();
    assert_eq!(sent["model"], "nomic", "the engine's alias");
    assert_eq!(sent["input"][1], "anna.berg@proton.me", "the text goes to the node's own engine as it is");
}

#[tokio::test]
async fn an_embedding_engine_is_not_a_chat_model() {
    let (url, _) = engine().await;
    let embed = Engine::attached("nomic", &url, None, true).with_embeddings(true);
    let node = node(vec![embed]).await;

    let models = get_json(&format!("{node}/v1/models")).await;
    let listed = models["data"].as_array().unwrap();
    assert_eq!(listed.len(), 1);
    assert_eq!(listed[0]["invincible"]["embeddings"], true);

    // A chat finds no model: the embedding engine is not offered to the chat router.
    let chat = post_json(
        &format!("{node}/v1/chat/completions"),
        json!({ "messages": [{ "role": "user", "content": "hi" }] }),
        &[],
    )
    .await;
    assert_eq!(chat.status(), 503);
    let error: Value = chat.json().await.unwrap();
    assert!(error["error"]["message"].as_str().unwrap().contains("no-model"), "{error}");

    // A named chat model is asked for embeddings: unknown to the embedding router.
    let wrong = post_json(&format!("{node}/v1/embeddings"), json!({ "input": "x", "model": "qwen" }), &[]).await;
    assert_eq!(wrong.status(), 404);
}

#[tokio::test]
async fn bad_input_and_no_engine_are_refused_before_anything_runs() {
    let (url, seen) = engine().await;
    let with = node(vec![Engine::attached("nomic", &url, None, true).with_embeddings(true)]).await;
    for body in [json!({ "input": "" }), json!({ "input": [] }), json!({ "input": { "x": 1 } }), json!({})] {
        let response = post_json(&format!("{with}/v1/embeddings"), body, &[]).await;
        assert_eq!(response.status(), 400);
    }
    assert!(seen.lock().unwrap().is_empty());

    let bare = node(Vec::new()).await;
    let response = post_json(&format!("{bare}/v1/embeddings"), json!({ "input": "x" }), &[]).await;
    assert_eq!(response.status(), 404);
    let error: Value = response.json().await.unwrap();
    assert_eq!(error["error"]["code"], "no_backend");
}
