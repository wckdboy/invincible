//! The local API end to end, against a stub engine that speaks llama.cpp's OpenAI-compatible API.

use std::sync::Arc;

use axum::Router;
use axum::body::Bytes;
use axum::response::IntoResponse;
use axum::routing::post;
use invincible::engine::Engine;
use invincible::server::{AppState, DECISION_HEADER, app};
use invincible_policy::{Egress, NetworkMode, NodeSettings};
use serde_json::{Value, json};

const TOKEN: &str = "test-token";

/// A stub engine: answers with the body it was sent, or streams three SSE events when asked to.
async fn stub_engine() -> String {
    let router = Router::new().route(
        "/v1/chat/completions",
        post(|body: Bytes| async move {
            let request: Value = serde_json::from_slice(&body).unwrap();
            if request["stream"] == json!(true) {
                let events = "data: {\"n\":1}\n\ndata: {\"n\":2}\n\ndata: [DONE]\n\n";
                ([("content-type", "text/event-stream")], events).into_response()
            } else {
                axum::Json(json!({ "engine_saw": request })).into_response()
            }
        }),
    );
    serve(router).await
}

async fn serve(router: Router) -> String {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move { axum::serve(listener, router).await.unwrap() });
    format!("http://{addr}")
}

/// A node with [engines], offline and closed to the cloud (the defaults).
async fn node(engines: Vec<Engine>) -> String {
    let settings = NodeSettings { network: NetworkMode::Offline, egress: Egress::Never };
    serve(app(Arc::new(AppState::new(engines, settings, TOKEN.to_owned())))).await
}

fn chat(node: &str, body: Value) -> reqwest::RequestBuilder {
    reqwest::Client::new().post(format!("{node}/v1/chat/completions")).bearer_auth(TOKEN).json(&body)
}

fn decision(response: &reqwest::Response) -> Value {
    serde_json::from_str(response.headers()[DECISION_HEADER].to_str().unwrap()).unwrap()
}

fn hello() -> Value {
    json!({ "messages": [{ "role": "user", "content": "hello" }] })
}

#[tokio::test]
async fn the_token_is_required() {
    let node = node(vec![]).await;
    let client = reqwest::Client::new();
    let none = client.get(format!("{node}/v1/models")).send().await.unwrap();
    assert_eq!(none.status(), 401);
    let wrong = client.get(format!("{node}/v1/models")).bearer_auth("nope").send().await.unwrap();
    assert_eq!(wrong.status(), 401);
    let chat = client.post(format!("{node}/v1/chat/completions")).json(&hello()).send().await.unwrap();
    assert_eq!(chat.status(), 401);
    // Health says nothing about the node, so it needs no token.
    assert_eq!(client.get(format!("{node}/health")).send().await.unwrap().status(), 200);
}

#[tokio::test]
async fn models_lists_the_engines() {
    let node = node(vec![Engine::attached("small", "http://127.0.0.1:9", Some(8192), true)]).await;
    let body: Value = reqwest::Client::new()
        .get(format!("{node}/v1/models"))
        .bearer_auth(TOKEN)
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(body["data"][0]["id"], "small");
    assert_eq!(
        body["data"][0]["invincible"],
        json!({ "tier": "node", "healthy": true, "context": 8192, "data_policy": "owned" })
    );
}

#[tokio::test]
async fn auto_runs_on_the_node_and_forwards_the_body_unchanged() {
    let engine = stub_engine().await;
    let node = node(vec![Engine::attached("small", &engine, Some(8192), true)]).await;
    let response = chat(&node, hello()).send().await.unwrap();
    assert_eq!(response.status(), 200);
    assert_eq!(
        decision(&response),
        json!({ "action": "run", "model": "small", "tier": "node", "reason": "local-first" })
    );
    let body: Value = response.json().await.unwrap();
    assert_eq!(body["engine_saw"], hello());
}

#[tokio::test]
async fn streams_pass_through() {
    let engine = stub_engine().await;
    let node = node(vec![Engine::attached("small", &engine, None, true)]).await;
    let mut body = hello();
    body["stream"] = json!(true);
    let response = chat(&node, body).send().await.unwrap();
    assert_eq!(response.headers()["content-type"], "text/event-stream");
    assert_eq!(response.text().await.unwrap(), "data: {\"n\":1}\n\ndata: {\"n\":2}\n\ndata: [DONE]\n\n");
}

#[tokio::test]
async fn routing_follows_the_order_and_size_of_models() {
    let engine = stub_engine().await;
    let node = node(vec![
        Engine::attached("small", &engine, Some(100), true),
        Engine::attached("large", &engine, Some(100_000), true),
    ])
    .await;
    let short = chat(&node, hello()).send().await.unwrap();
    assert_eq!(decision(&short)["model"], "small");
    let mut long = hello();
    long["max_tokens"] = json!(4096);
    assert_eq!(decision(&chat(&node, long).send().await.unwrap())["model"], "large");
    let named = chat(&node, json!({ "model": "large", "messages": [] })).send().await.unwrap();
    assert_eq!(decision(&named), json!({ "action": "run", "model": "large", "tier": "node", "reason": "requested" }));
}

#[tokio::test]
async fn private_requests_run_locally() {
    let engine = stub_engine().await;
    let node = node(vec![Engine::attached("small", &engine, None, true)]).await;
    let response = chat(&node, hello()).header("invincible-private", "1").send().await.unwrap();
    assert_eq!(response.status(), 200);
    assert_eq!(decision(&response)["reason"], "local-first");
}

#[tokio::test]
async fn blocked_requests_say_why() {
    let node = node(vec![Engine::attached("down", "http://127.0.0.1:9", None, false)]).await;

    let unknown = chat(&node, json!({ "model": "gpt-9", "messages": [] })).send().await.unwrap();
    assert_eq!(unknown.status(), 404);
    assert_eq!(decision(&unknown), json!({ "action": "block", "reason": "unknown-model" }));

    let unavailable = chat(&node, json!({ "model": "down", "messages": [] })).send().await.unwrap();
    assert_eq!(unavailable.status(), 503);
    assert_eq!(decision(&unavailable)["reason"], "model-unavailable");

    let nothing = chat(&node, hello()).send().await.unwrap();
    assert_eq!(nothing.status(), 503);
    assert_eq!(decision(&nothing)["reason"], "no-model");
    let body: Value = nothing.json().await.unwrap();
    assert_eq!(body["error"]["type"], "request_blocked");
}

#[tokio::test]
async fn a_dead_engine_is_a_bad_gateway() {
    // Reported healthy, but nothing listens there.
    let node = node(vec![Engine::attached("ghost", "http://127.0.0.1:9", None, true)]).await;
    let response = chat(&node, hello()).send().await.unwrap();
    assert_eq!(response.status(), 502);
    assert_eq!(decision(&response)["model"], "ghost");
}

#[tokio::test]
async fn a_body_that_is_not_json_is_refused() {
    let node = node(vec![]).await;
    let response = reqwest::Client::new()
        .post(format!("{node}/v1/chat/completions"))
        .bearer_auth(TOKEN)
        .body("not json")
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), 400);
}
