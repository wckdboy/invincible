//! The agent API (spec/agent.md) through the real gateway: a turn streams its events, an approval
//! is answered on its own request, and the token, busy sessions and a stopped agent are handled.

use std::collections::VecDeque;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use autobot::agent::Agent;
use autobot::api::{ApiState, app};
use autobot::config::{ApprovalConfig, ApprovalMode};
use autobot::gateway::Gateway;
use autobot::tools::Tools;
use axum::Json;
use axum::extract::State;
use futures_util::StreamExt;
use invincible::server::AppState;
use invincible_policy::{Egress, NetworkMode, NodeSettings};
use serde_json::{Value, json};

const TOKEN: &str = "node-token";

async fn listen(router: axum::Router) -> String {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}", listener.local_addr().unwrap());
    tokio::spawn(async move { axum::serve(listener, router).await.unwrap() });
    url
}

/// A model that answers each call with the next scripted message, after [delay].
async fn model(answers: Vec<Value>, delay: Duration) -> String {
    let answers = Arc::new(Mutex::new(VecDeque::from(answers)));
    listen(
        axum::Router::new()
            .route(
                "/v1/chat/completions",
                axum::routing::post(move |State(a): State<Arc<Mutex<VecDeque<Value>>>>| async move {
                    tokio::time::sleep(delay).await;
                    let message = a.lock().unwrap().pop_front().unwrap();
                    ([("invincible-request-id", "r1")], Json(json!({ "choices": [{ "message": message }] })))
                }),
            )
            .with_state(answers),
    )
    .await
}

fn temp(name: &str) -> std::path::PathBuf {
    let dir = std::env::temp_dir().join(format!("autobot-api-{name}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

/// The agent API on a stand-in model, and a gateway in front of it; returns the gateway's URL.
async fn stack(name: &str, answers: Vec<Value>, delay: Duration) -> (String, String, std::path::PathBuf) {
    let dir = temp(name);
    let model = model(answers, delay).await;
    let agent = Arc::new(Agent {
        gateway: Gateway::new(&format!("{model}/v1"), TOKEN, "auto", true).unwrap(),
        tools: Tools::new(dir.join("work"), Duration::from_secs(5)),
        approvals: ApprovalConfig { mode: ApprovalMode::Ask, allow: Vec::new() },
        max_steps: 5,
    });
    let info = json!({ "name": "Autobot", "approvals": "ask" });
    let agent_url = listen(app(Arc::new(ApiState::new(agent, TOKEN.into(), dir.clone(), info)))).await;
    let settings = NodeSettings { network: NetworkMode::Offline, egress: Egress::Never };
    let gateway =
        invincible::server::app(Arc::new(AppState::new(Vec::new(), settings, TOKEN.into()).with_agent(&agent_url)));
    (listen(gateway).await, agent_url, dir)
}

/// The events of a turn's stream, as they come; [on] can act on each.
async fn turn(client: &reqwest::Client, url: &str, text: &str, mut on: impl AsyncFnMut(&Value)) -> Vec<Value> {
    let response = client.post(url).bearer_auth(TOKEN).json(&json!({ "text": text })).send().await.unwrap();
    assert_eq!(response.status(), 200);
    assert_eq!(response.headers()["content-type"], "text/event-stream");
    let mut stream = response.bytes_stream();
    let mut buffer = String::new();
    let mut events = Vec::new();
    while let Some(chunk) = tokio::time::timeout(Duration::from_secs(10), stream.next()).await.unwrap() {
        buffer.push_str(&String::from_utf8_lossy(&chunk.unwrap()));
        while let Some(end) = buffer.find("\n\n") {
            let line = buffer[..end].to_owned();
            buffer.drain(..end + 2);
            let event: Value = serde_json::from_str(line.strip_prefix("data: ").unwrap()).unwrap();
            on(&event).await;
            events.push(event);
        }
    }
    events
}

#[tokio::test]
async fn a_turn_through_the_gateway_with_an_approval() {
    let (gateway, _, dir) = stack(
        "turn",
        vec![
            json!({ "role": "assistant", "content": "", "tool_calls": [{ "id": "c1", "type": "function",
                "function": { "name": "terminal", "arguments": "{\"command\":\"echo hi > out.txt\"}" } }] }),
            json!({ "role": "assistant", "content": "Wrote out.txt." }),
        ],
        Duration::ZERO,
    )
    .await;
    let client = reqwest::Client::new();
    let info: Value =
        client.get(format!("{gateway}/v1/agent")).bearer_auth(TOKEN).send().await.unwrap().json().await.unwrap();
    assert_eq!(info["approvals"], "ask");

    let approvals = format!("{gateway}/v1/agent/approvals");
    let events =
        turn(&client, &format!("{gateway}/v1/agent/sessions/phone-1/turns"), "make a file", async |event: &Value| {
            if event["type"] == "approval" {
                assert_eq!(event["action"], json!({ "kind": "command", "command": "echo hi > out.txt" }));
                let url = format!("{approvals}/{}", event["id"].as_str().unwrap());
                let reply =
                    client.post(&url).bearer_auth(TOKEN).json(&json!({ "answer": "once" })).send().await.unwrap();
                assert_eq!(reply.status(), 200);
                // Answered once: a second answer finds nothing waiting.
                let again =
                    client.post(&url).bearer_auth(TOKEN).json(&json!({ "answer": "once" })).send().await.unwrap();
                assert_eq!(again.status(), 404);
            }
        })
        .await;
    let kinds: Vec<_> = events.iter().map(|e| e["type"].as_str().unwrap()).collect();
    assert_eq!(kinds, ["receipt", "approval", "tool", "receipt", "answer"]);
    assert_eq!(events.last().unwrap()["text"], "Wrote out.txt.");
    assert_eq!(events.last().unwrap()["receipts"], json!(["r1", "r1"]));
    assert_eq!(std::fs::read_to_string(dir.join("work/out.txt")).unwrap(), "hi\n");

    let history: Value = client
        .get(format!("{gateway}/v1/agent/sessions/phone-1"))
        .bearer_auth(TOKEN)
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(history["messages"].as_array().unwrap().len(), 4);
    let list: Value = client
        .get(format!("{gateway}/v1/agent/sessions"))
        .bearer_auth(TOKEN)
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(list["sessions"][0]["id"], "phone-1");
    let reset =
        client.post(format!("{gateway}/v1/agent/sessions/phone-1/reset")).bearer_auth(TOKEN).send().await.unwrap();
    assert_eq!(reset.status(), 200);
    let history: Value = client
        .get(format!("{gateway}/v1/agent/sessions/phone-1"))
        .bearer_auth(TOKEN)
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert!(history["messages"].as_array().unwrap().is_empty());
}

#[tokio::test]
async fn the_token_is_required_on_both_sides() {
    let (gateway, agent, _) = stack("token", Vec::new(), Duration::ZERO).await;
    let client = reqwest::Client::new();
    assert_eq!(client.get(format!("{gateway}/v1/agent")).send().await.unwrap().status(), 401);
    assert_eq!(client.get(format!("{agent}/v1/agent")).send().await.unwrap().status(), 401);
    assert_eq!(client.get(format!("{agent}/v1/agent")).bearer_auth("wrong").send().await.unwrap().status(), 401);
    assert_eq!(client.get(format!("{agent}/v1/agent")).bearer_auth(TOKEN).send().await.unwrap().status(), 200);
}

#[tokio::test]
async fn a_busy_session_and_bad_ids_are_refused() {
    let slow = json!({ "role": "assistant", "content": "slow" });
    let (gateway, _, _) = stack("busy", vec![slow], Duration::from_millis(500)).await;
    let client = reqwest::Client::new();
    let url = format!("{gateway}/v1/agent/sessions/s/turns");
    let first = client.post(&url).bearer_auth(TOKEN).json(&json!({ "text": "a" })).send().await.unwrap();
    let second = client.post(&url).bearer_auth(TOKEN).json(&json!({ "text": "b" })).send().await.unwrap();
    assert_eq!(second.status(), 409);
    assert_eq!(second.json::<Value>().await.unwrap()["error"]["type"], "session_busy");
    assert!(first.text().await.unwrap().contains("\"answer\""));
    let bad = client
        .post(format!("{gateway}/v1/agent/sessions/..%2Fx/turns"))
        .bearer_auth(TOKEN)
        .json(&json!({ "text": "a" }))
        .send()
        .await
        .unwrap();
    assert_eq!(bad.status(), 400);
}

#[tokio::test]
async fn a_stopped_agent_is_reported_and_devices_reach_the_agent_too() {
    let settings = NodeSettings { network: NetworkMode::Offline, egress: Egress::Never };
    let state = Arc::new(AppState::new(Vec::new(), settings, TOKEN.into()).with_agent("http://127.0.0.1:9"));
    let gateway = listen(invincible::server::app(state.clone())).await;
    let reply = reqwest::Client::new().get(format!("{gateway}/v1/agent")).bearer_auth(TOKEN).send().await.unwrap();
    assert_eq!(reply.status(), 503);
    assert_eq!(reply.json::<Value>().await.unwrap()["error"]["type"], "agent_unavailable");
    // The device app (what a paired device reaches over Noise) has the route as well.
    let device = listen(invincible::server::device_app(state)).await;
    assert_eq!(reqwest::Client::new().get(format!("{device}/v1/agent")).send().await.unwrap().status(), 503);
}

#[tokio::test]
async fn schedules_are_managed_through_the_gateway() {
    let (gateway, _, dir) = stack("schedules", Vec::new(), Duration::ZERO).await;
    let client = reqwest::Client::new();
    let url = format!("{gateway}/v1/agent/schedules");
    let bad = client.post(&url).bearer_auth(TOKEN).json(&json!({ "when": "0 99 * * *", "task": "x" })).send().await.unwrap();
    assert_eq!(bad.status(), 400);
    let added: Value = client
        .post(&url)
        .bearer_auth(TOKEN)
        .json(&json!({ "when": "@daily", "task": "check the backups" }))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(added["id"], "t1");
    let list: Value = client.get(&url).bearer_auth(TOKEN).send().await.unwrap().json().await.unwrap();
    let schedule = &list["schedules"][0];
    assert_eq!((schedule["when"].as_str(), schedule["task"].as_str()), (Some("@daily"), Some("check the backups")));
    assert!(schedule["next"].as_i64().unwrap() > 0 && schedule["last"].is_null());
    assert!(dir.join("schedules.json").exists());
    assert_eq!(client.delete(format!("{url}/t1")).bearer_auth(TOKEN).send().await.unwrap().status(), 200);
    assert_eq!(client.delete(format!("{url}/t1")).bearer_auth(TOKEN).send().await.unwrap().status(), 404);
}
