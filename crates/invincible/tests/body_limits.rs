//! What a request body may cost the node (spec/pairing.md, Limits): one limit per route, and a
//! ceiling on what the device listener holds across every request in flight.
//!
//! The node here is the real listener routers — `device_app` for paired devices, `app` beside it
//! for the operator — in front of an engine that answers at once, or waits when the request says
//! `hold_ms`, so a test can keep a body in flight and see what a second one is told.

use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;

use axum::Router;
use axum::body::Bytes;
use axum::extract::DefaultBodyLimit;
use axum::response::IntoResponse;
use axum::routing::post;
use invincible::engine::Engine;
use invincible::server::{AppState, LOOPBACK_METER_BODY, MAX_REQUEST, METER_BODY, app, device_app};
use invincible_policy::{Egress, NetworkMode, NodeSettings};
use serde_json::{Value, json};

const TOKEN: &str = "operator-token";

struct Node {
    /// The device listener: what a paired device's session reaches.
    device: String,
    /// The operator's loopback API, behind the token.
    operator: String,
    /// Kept for the budget it admits against (`[node] max_buffered_bytes`).
    state: Arc<AppState>,
    /// Chat requests the engine answered (a held request has arrived when this is one higher).
    engine_hits: Arc<AtomicU64>,
}

async fn serve(router: Router) -> String {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move { axum::serve(listener, router).await.unwrap() });
    format!("http://{addr}")
}

/// An engine that answers at once, or after the `hold_ms` its request asks for.
async fn stub_engine() -> (String, Arc<AtomicU64>) {
    let hits = Arc::new(AtomicU64::new(0));
    let counted = hits.clone();
    // The engine takes what the node sends it: this stub is not the limit under test.
    let router = Router::new().route(
        "/v1/chat/completions",
        post(move |body: Bytes| {
            let counted = counted.clone();
            async move {
                let request: Value = serde_json::from_slice(&body).unwrap_or(Value::Null);
                // Counted before the hold: a request that is holding is one the node has read
                // and not yet answered.
                counted.fetch_add(1, Ordering::SeqCst);
                if let Some(ms) = request["hold_ms"].as_u64() {
                    tokio::time::sleep(Duration::from_millis(ms)).await;
                }
                axum::Json(json!({ "seen_bytes": body.len() })).into_response()
            }
        })
        .layer(DefaultBodyLimit::max(64 << 20)),
    );
    let url = serve(router).await;
    (url, hits)
}

/// A node that holds [ceiling] bytes of device request bodies at once.
async fn node(ceiling: u64) -> Node {
    let (engine_url, engine_hits) = stub_engine().await;
    let state = Arc::new(
        AppState::new(
            vec![Engine::attached("small", &engine_url, None, true)],
            NodeSettings { network: NetworkMode::Offline, egress: Egress::Never },
            TOKEN.into(),
        )
        .with_max_buffered_bytes(ceiling),
    );
    let device = serve(device_app(state.clone())).await;
    let operator = serve(app(state.clone())).await;
    Node { device, operator, state, engine_hits }
}

/// A chat completion body of about [bytes] bytes of text, held by the engine for [hold_ms].
fn chat(bytes: usize, hold_ms: u64) -> Value {
    let mut body = json!({
        "model": "small",
        "max_tokens": 16,
        "messages": [{ "role": "user", "content": "x".repeat(bytes) }],
    });
    if hold_ms > 0 {
        body["hold_ms"] = json!(hold_ms);
    }
    body
}

fn client() -> reqwest::Client {
    reqwest::Client::builder().timeout(Duration::from_secs(60)).build().unwrap()
}

fn operator() -> reqwest::Client {
    let mut headers = reqwest::header::HeaderMap::new();
    headers.insert(reqwest::header::AUTHORIZATION, format!("Bearer {TOKEN}").parse().unwrap());
    reqwest::Client::builder().default_headers(headers).timeout(Duration::from_secs(60)).build().unwrap()
}

/// Waits until a request is inside the handler: the engine has the body, so its reservation is
/// held. Polls, because the body has to arrive first.
async fn wait_for_hit(hits: &Arc<AtomicU64>, at_least: u64) {
    let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
    while hits.load(Ordering::SeqCst) < at_least {
        assert!(tokio::time::Instant::now() < deadline, "no request reached the engine");
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
}

async fn healthz(node: &Node) -> u16 {
    client().get(format!("{}/healthz", node.operator)).send().await.unwrap().status().as_u16()
}

#[tokio::test]
async fn a_device_body_over_the_route_limit_is_413_and_names_the_number() {
    let node = node(256 << 20).await;
    let over = chat(MAX_REQUEST + 1, 0);
    let response = client().post(format!("{}/v1/chat/completions", node.device)).json(&over).send().await.unwrap();
    assert_eq!(response.status(), 413, "a chat body over {} bytes", MAX_REQUEST);
    let message = response.json::<Value>().await.unwrap()["error"]["message"].as_str().unwrap().to_owned();
    // An operator hitting this must be able to see what the route takes.
    assert!(message.contains(&MAX_REQUEST.to_string()), "{message}");
    assert!(message.contains("32 MiB"), "{message}");
    // Refused before it went anywhere: the engine never saw it.
    assert_eq!(node.engine_hits.load(Ordering::SeqCst), 0, "an over-limit body reached the engine");

    // The node is healthy afterwards: healthz, a device surface route, and a completion.
    assert_eq!(healthz(&node).await, 200);
    assert_eq!(client().get(format!("{}/v1/models", node.device)).send().await.unwrap().status(), 200);
    let chat_ok =
        client().post(format!("{}/v1/chat/completions", node.device)).json(&chat(1024, 0)).send().await.unwrap();
    assert_eq!(chat_ok.status(), 200);
    assert_eq!(node.engine_hits.load(Ordering::SeqCst), 1);
    // Nothing of the refused request is still reserved.
    assert_eq!(node.state.buffered.held(), 0);
}

#[tokio::test]
async fn a_legitimate_large_body_still_goes_through_unchanged() {
    // The default ceiling: 256 MiB, so a large but legal body is admitted.
    let node = node(256 << 20).await;
    // 8 MiB of device chat, under the 32 MiB route and the ceiling.
    let big = chat(8 << 20, 0);
    let response = client().post(format!("{}/v1/chat/completions", node.device)).json(&big).send().await.unwrap();
    assert_eq!(response.status(), 200, "a device chat of 8 MiB is legal");
    // The engine was handed the body as it came: nothing was truncated to make it fit.
    assert!(response.json::<Value>().await.unwrap()["seen_bytes"].as_u64().unwrap() > 8 << 20);

    // And the operator's larger one, on its own listener.
    let huge = chat(20 << 20, 0);
    let response = operator().post(format!("{}/v1/chat/completions", node.operator)).json(&huge).send().await.unwrap();
    assert_eq!(response.status(), 200, "an operator chat of 20 MiB is legal");
    assert!(response.json::<Value>().await.unwrap()["seen_bytes"].as_u64().unwrap() > 20 << 20);
    assert_eq!(node.state.buffered.held(), 0, "the ceiling is given back");
}

#[tokio::test]
async fn device_bodies_over_the_ceiling_are_503_and_the_node_stays_up() {
    // 8 MiB of device bodies at once: one 6 MiB request fits, a second does not.
    let node = node(8 << 20).await;
    let body = chat(6 << 20, 1_500);
    let holder = tokio::spawn({
        let url = format!("{}/v1/chat/completions", node.device);
        let body = body.clone();
        async move { client().post(url).json(&body).send().await.unwrap().status().as_u16() }
    });
    // The holder has the node's ceiling; a second body of the same size cannot be taken.
    wait_for_hit(&node.engine_hits, 1).await;

    let refused = client().post(format!("{}/v1/chat/completions", node.device)).json(&body).send().await.unwrap();
    assert_eq!(refused.status(), 503, "past the ceiling the node refuses instead of allocating");
    assert_eq!(refused.headers()["retry-after"], "2", "the refusal says when to come back");
    let message = refused.json::<Value>().await.unwrap()["error"]["message"].as_str().unwrap().to_owned();
    assert!(message.contains(&(8 << 20).to_string()), "the refusal names the ceiling: {message}");
    assert!(message.contains("max_buffered_bytes"), "{message}");
    assert!(node.state.buffered.held() <= 8 << 20, "the ceiling is never passed");

    // Refusing one request did not refuse the node: the operator's own API answers while the
    // device's ceiling is still held (its listener is not admitted against it), healthz is up, and
    // the held request finishes normally.
    let operator_chat = operator()
        .post(format!("{}/v1/chat/completions", node.operator))
        .json(&chat(12 << 20, 0))
        .send()
        .await
        .unwrap();
    assert_eq!(operator_chat.status(), 200, "the operator is not held to the device ceiling");
    assert_eq!(healthz(&node).await, 200, "healthz answers while the ceiling is reached");

    assert_eq!(holder.await.unwrap(), 200, "the request that fitted is answered normally");
    assert_eq!(node.state.buffered.held(), 0, "the ceiling is given back when the request ends");
    assert_eq!(
        client()
            .post(format!("{}/v1/chat/completions", node.device))
            .json(&chat(4 << 20, 0))
            .send()
            .await
            .unwrap()
            .status(),
        200
    );
}

#[tokio::test]
async fn the_meter_streams_and_the_two_listeners_keep_their_own_limits() {
    // A ceiling far below the meter's bulk payload: the meter holds nothing, so it is not admitted
    // against the ceiling and a 4 MiB post still works.
    let node = node(2 << 20).await;
    let meter =
        client().post(format!("{}/v1/cluster/meter", node.device)).body(vec![0u8; 4 << 20]).send().await.unwrap();
    assert_eq!(meter.status(), 200, "the meter's bulk payload is not charged to the ceiling");
    assert_eq!(meter.json::<Value>().await.unwrap()["bytes"], json!(4 << 20));

    // One body, two listeners: over the device's 5 MiB route limit and under loopback's 16 MiB.
    let over = vec![0u8; METER_BODY + 1];
    let device = client().post(format!("{}/v1/cluster/meter", node.device)).body(over.clone()).send().await.unwrap();
    assert_eq!(device.status(), 413, "a device meter body is at most {METER_BODY} bytes");
    let message = device.json::<Value>().await.unwrap()["error"]["message"].as_str().unwrap().to_owned();
    assert!(message.contains(&METER_BODY.to_string()), "{message}");

    let loopback = operator().post(format!("{}/v1/cluster/meter", node.operator)).body(over).send().await.unwrap();
    assert_eq!(loopback.status(), 200, "the loopback meter takes up to {LOOPBACK_METER_BODY} bytes");
    assert_eq!(loopback.json::<Value>().await.unwrap()["bytes"], json!(METER_BODY + 1));

    // Both listeners are still up, and the device's ceiling (2 MiB) was never charged.
    assert_eq!(node.state.buffered.held(), 0);
    assert_eq!(healthz(&node).await, 200);
    let chat =
        client().post(format!("{}/v1/chat/completions", node.device)).json(&chat(1 << 20, 0)).send().await.unwrap();
    assert_eq!(chat.status(), 200, "a device chat under the ceiling still runs");
}
