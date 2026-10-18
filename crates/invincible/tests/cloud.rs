//! Cloud backends end to end, against a stub provider on loopback: what leaves is redacted, what
//! comes back is restored, failures fall back to the node, and the routing rules keep private,
//! offline and unconfirmed requests away from the cloud.

use std::sync::{Arc, Mutex};

use axum::Router;
use axum::body::Bytes;
use axum::http::{HeaderMap, StatusCode};
use axum::response::IntoResponse;
use axum::routing::post;
use invincible::cloud::{CloudModel, REDACTED_HEADER};
use invincible::engine::Engine;
use invincible::server::{AppState, DECISION_HEADER, app};
use invincible_policy::{DataPolicy, Egress, NetworkMode, NodeSettings};
use serde_json::{Value, json};

/// What the stub provider saw.
#[derive(Default)]
struct Seen {
    bodies: Vec<Value>,
    auth: Vec<String>,
}

/// A stub provider. `mode`: "echo" answers with the last user message; "stream" streams it with a
/// placeholder split across chunks; "fail" answers 500; "deny" answers 401.
async fn provider(mode: &'static str) -> (String, Arc<Mutex<Seen>>) {
    let seen = Arc::new(Mutex::new(Seen::default()));
    let record = seen.clone();
    let router = Router::new().route(
        "/v1/chat/completions",
        post(move |headers: HeaderMap, body: Bytes| {
            let record = record.clone();
            async move {
                let body: Value = serde_json::from_slice(&body).unwrap();
                let said = body["messages"].as_array().unwrap().last().unwrap()["content"].as_str().unwrap_or("").to_owned();
                {
                    let mut seen = record.lock().unwrap();
                    seen.bodies.push(body);
                    seen.auth.push(headers.get("authorization").map(|v| v.to_str().unwrap().to_owned()).unwrap_or_default());
                }
                match mode {
                    "fail" => (StatusCode::INTERNAL_SERVER_ERROR, "down").into_response(),
                    "deny" => (StatusCode::UNAUTHORIZED, axum::Json(json!({ "error": { "message": "bad key" } })))
                        .into_response(),
                    "stream" => {
                        // "You said: [EMAIL_1]" with the placeholder split in three.
                        let (head, tail) = said.split_at(said.find('[').unwrap() + 3);
                        let (mid, end) = tail.split_at(4);
                        let chunk = |s: &str| format!("data: {}\n\n", json!({ "choices": [{ "index": 0, "delta": { "content": s } }] }));
                        let events = format!("{}{}{}{}data: [DONE]\n\n", chunk(&format!("You said: {head}")), chunk(mid), chunk(end), "");
                        ([("content-type", "text/event-stream")], events).into_response()
                    }
                    _ => axum::Json(json!({
                        "choices": [{ "index": 0, "message": { "role": "assistant", "content": format!("You said: {said}") } }]
                    }))
                    .into_response(),
                }
            }
        }),
    );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move { axum::serve(listener, router).await.unwrap() });
    (format!("http://{addr}/v1"), seen)
}

/// A local engine that answers "local".
async fn local_engine() -> String {
    let router = Router::new().route(
        "/v1/chat/completions",
        post(|| async { axum::Json(json!({ "choices": [{ "message": { "content": "local" } }] })) }),
    );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move { axum::serve(listener, router).await.unwrap() });
    format!("http://{addr}")
}

/// A node with a small local model (context 64) and one cloud model.
async fn node(cloud_url: &str, network: NetworkMode, egress: Egress, policy: DataPolicy) -> String {
    let engine = Engine::attached("local", &local_engine().await, Some(64), true);
    let cloud = CloudModel::new("claude", "claude-upstream", cloud_url, Some("sk-test".into()), Some(200_000), policy);
    let state = AppState::new(vec![engine], NodeSettings { network, egress }, "token".into()).with_cloud(vec![cloud]);
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move { axum::serve(listener, app(Arc::new(state))).await.unwrap() });
    format!("http://{addr}")
}

async fn open_node(cloud_url: &str) -> String {
    node(cloud_url, NetworkMode::Direct, Egress::Auto, DataPolicy::Retention { days: 30 }).await
}

fn chat(node: &str, body: Value) -> reqwest::RequestBuilder {
    reqwest::Client::new().post(format!("{node}/v1/chat/completions")).bearer_auth("token").json(&body)
}

fn decision(response: &reqwest::Response) -> Value {
    serde_json::from_str(response.headers()[DECISION_HEADER].to_str().unwrap()).unwrap()
}

fn say(model: &str, text: &str) -> Value {
    json!({ "model": model, "messages": [{ "role": "user", "content": text }] })
}

#[tokio::test]
async fn the_cloud_sees_placeholders_and_the_client_sees_values() {
    let (url, seen) = provider("echo").await;
    let node = open_node(&url).await;
    let response = chat(&node, say("claude", "mail alice@proton.me, call +44 20 7946 0958")).send().await.unwrap();
    assert_eq!(response.status(), 200);
    assert_eq!(
        decision(&response),
        json!({ "action": "run", "model": "claude", "tier": "cloud", "reason": "requested", "redact": true })
    );
    assert_eq!(response.headers()[REDACTED_HEADER], r#"{"EMAIL":1,"PHONE":1}"#);
    let body: Value = response.json().await.unwrap();
    assert_eq!(body["choices"][0]["message"]["content"], "You said: mail alice@proton.me, call +44 20 7946 0958");

    let seen = seen.lock().unwrap();
    assert_eq!(seen.bodies[0]["messages"][0]["content"], "mail [EMAIL_1], call [PHONE_1]");
    assert_eq!(seen.bodies[0]["model"], "claude-upstream");
    assert_eq!(seen.auth[0], "Bearer sk-test");
}

#[tokio::test]
async fn streamed_answers_are_restored_across_chunks() {
    let (url, _) = provider("stream").await;
    let node = open_node(&url).await;
    let mut body = say("claude", "my mail is bob@posteo.de");
    body["stream"] = json!(true);
    let text = chat(&node, body).send().await.unwrap().text().await.unwrap();
    let content: String = text
        .lines()
        .filter_map(|l| l.strip_prefix("data: "))
        .filter(|d| *d != "[DONE]")
        .map(|d| {
            serde_json::from_str::<Value>(d).unwrap()["choices"][0]["delta"]["content"]
                .as_str()
                .unwrap_or("")
                .to_owned()
        })
        .collect();
    assert_eq!(content, "You said: my mail is bob@posteo.de");
    assert!(!text.contains("[EMAIL_1]"));
    assert!(text.trim_end().ends_with("data: [DONE]"));
}

#[tokio::test]
async fn auto_goes_to_the_cloud_only_when_the_node_cannot() {
    let (url, seen) = provider("echo").await;
    let node = open_node(&url).await;
    let short = chat(&node, say("auto", "hi")).send().await.unwrap();
    assert_eq!(decision(&short)["reason"], "local-first");
    let long = chat(&node, say("auto", &"long ".repeat(100))).send().await.unwrap();
    assert_eq!(decision(&long)["reason"], "too-long");
    assert_eq!(decision(&long)["tier"], "cloud");
    assert_eq!(seen.lock().unwrap().bodies.len(), 1);
}

#[tokio::test]
async fn a_failing_cloud_falls_back_to_the_node_and_stays_down() {
    let (url, seen) = provider("fail").await;
    let node = open_node(&url).await;
    let first = chat(&node, say("claude", "hi")).send().await.unwrap();
    assert_eq!(first.status(), 200);
    assert_eq!(
        decision(&first),
        json!({ "action": "run", "model": "local", "tier": "node", "reason": "cloud-down", "fallback": true })
    );
    assert_eq!(first.json::<Value>().await.unwrap()["choices"][0]["message"]["content"], "local");
    // Marked down: the next request does not even try.
    let second = chat(&node, say("claude", "hi")).send().await.unwrap();
    assert_eq!(decision(&second)["reason"], "cloud-down");
    assert_eq!(seen.lock().unwrap().bodies.len(), 1);
}

#[tokio::test]
async fn a_refused_key_is_passed_on_not_failed_over() {
    let (url, _) = provider("deny").await;
    let node = open_node(&url).await;
    let response = chat(&node, say("claude", "hi")).send().await.unwrap();
    assert_eq!(response.status(), 401);
    assert_eq!(decision(&response)["tier"], "cloud");
}

#[tokio::test]
async fn private_requests_never_reach_the_cloud() {
    let (url, seen) = provider("echo").await;
    let node = open_node(&url).await;
    let response = chat(&node, say("claude", "hi")).header("invincible-private", "1").send().await.unwrap();
    assert_eq!(decision(&response)["reason"], "private");
    assert_eq!(decision(&response)["tier"], "node");
    let long = chat(&node, say("auto", &"long ".repeat(100))).header("invincible-private", "1").send().await.unwrap();
    assert_eq!(long.status(), 403);
    assert!(seen.lock().unwrap().bodies.is_empty());
}

#[tokio::test]
async fn an_offline_node_never_reaches_the_cloud() {
    let (url, seen) = provider("echo").await;
    let node = node(&url, NetworkMode::Offline, Egress::Auto, DataPolicy::NoRetention).await;
    let response = chat(&node, say("claude", "hi")).send().await.unwrap();
    assert_eq!(decision(&response)["reason"], "offline");
    assert!(seen.lock().unwrap().bodies.is_empty());
}

#[tokio::test]
async fn asking_first_until_confirmed() {
    let (url, seen) = provider("echo").await;
    let ask = node(&url, NetworkMode::Direct, Egress::Ask, DataPolicy::NoRetention).await;
    let first = chat(&ask, say("claude", "hi")).send().await.unwrap();
    assert_eq!(first.status(), 409);
    assert_eq!(decision(&first)["reason"], "egress-ask");
    assert!(seen.lock().unwrap().bodies.is_empty());
    let confirmed = chat(&ask, say("claude", "hi")).header("invincible-confirmed", "1").send().await.unwrap();
    assert_eq!(confirmed.status(), 200);

    let auto = open_node(&url).await;
    let sensitive =
        chat(&auto, say("auto", &"long ".repeat(100))).header("invincible-risk", "health").send().await.unwrap();
    assert_eq!(sensitive.status(), 409);
    assert_eq!(decision(&sensitive)["reason"], "sensitive");
}

#[tokio::test]
async fn a_model_that_trains_on_prompts_asks_first() {
    let (url, seen) = provider("echo").await;
    let node = node(&url, NetworkMode::Direct, Egress::Auto, DataPolicy::Trains).await;
    let response = chat(&node, say("claude", "hi")).send().await.unwrap();
    assert_eq!(response.status(), 409);
    assert_eq!(decision(&response)["reason"], "trains");
    assert!(seen.lock().unwrap().bodies.is_empty());
}
