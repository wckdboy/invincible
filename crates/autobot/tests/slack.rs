//! Slack against a stand-in Web API and a stand-in Socket Mode websocket, and a stand-in model
//! gateway: a stranger gets a pairing code, the owner approves it, a task runs, a tool is
//! approved by a Block Kit button (by the right person only), the answer is mrkdwn, a channel
//! mention is answered in its thread, and every envelope is acknowledged.

use std::collections::VecDeque;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use autobot::agent::Agent;
use autobot::bots::Runtime;
use autobot::config::{ApprovalConfig, ApprovalMode};
use autobot::gateway::Gateway;
use autobot::tools::Tools;
use axum::Json;
use axum::extract::{Path, State};
use futures_util::{SinkExt, StreamExt};
use serde_json::{Value, json};
use tokio_tungstenite::tungstenite::Message;

#[derive(Default)]
struct Slack {
    /// Envelopes for the socket to send.
    envelopes: VecDeque<Value>,
    /// Envelope ids the bot acknowledged.
    acks: Vec<String>,
    /// (method, token, body) of every Web API call.
    calls: Vec<(String, String, Value)>,
    next_ts: u64,
}

type Shared = Arc<Mutex<Slack>>;

async fn listen(app: axum::Router) -> String {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}", listener.local_addr().unwrap());
    tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    url
}

/// Socket Mode: hello, then whatever is queued; acks recorded.
async fn socket(s: Shared) -> String {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("ws://{}/link", listener.local_addr().unwrap());
    tokio::spawn(async move {
        loop {
            let (stream, _) = listener.accept().await.unwrap();
            let s = s.clone();
            tokio::spawn(async move {
                let mut ws = tokio_tungstenite::accept_async(stream).await.unwrap();
                ws.send(Message::text(json!({ "type": "hello", "num_connections": 1 }).to_string())).await.unwrap();
                loop {
                    tokio::select! {
                        incoming = ws.next() => {
                            let Some(Ok(message)) = incoming else { return };
                            if let Message::Text(text) = message {
                                let v: Value = serde_json::from_str(text.as_str()).unwrap();
                                s.lock().unwrap().acks.push(v["envelope_id"].as_str().unwrap().to_owned());
                            }
                        }
                        () = tokio::time::sleep(Duration::from_millis(20)) => {
                            let next = s.lock().unwrap().envelopes.pop_front();
                            if let Some(envelope) = next {
                                ws.send(Message::text(envelope.to_string())).await.unwrap();
                            }
                        }
                    }
                }
            });
        }
    });
    url
}

async fn web_api(
    State((s, ws)): State<(Shared, String)>,
    Path(method): Path<String>,
    headers: axum::http::HeaderMap,
    Json(body): Json<Value>,
) -> Json<Value> {
    let token = headers["authorization"].to_str().unwrap().trim_start_matches("Bearer ").to_owned();
    let mut s = s.lock().unwrap();
    s.calls.push((method.clone(), token, body));
    s.next_ts += 1;
    match method.as_str() {
        "auth.test" => Json(json!({ "ok": true, "user_id": "UBOT" })),
        "apps.connections.open" => Json(json!({ "ok": true, "url": ws })),
        _ => Json(json!({ "ok": true, "ts": format!("100.{}", s.next_ts) })),
    }
}

async fn model(answers: Vec<Value>) -> String {
    let answers = Arc::new(Mutex::new(VecDeque::from(answers)));
    listen(
        axum::Router::new()
            .route(
                "/v1/chat/completions",
                axum::routing::post(|State(a): State<Arc<Mutex<VecDeque<Value>>>>| async move {
                    let message = a.lock().unwrap().pop_front().unwrap();
                    (
                        [
                            ("invincible-request-id", "abcdef123456"),
                            ("invincible-decision", r#"{"model":"qwen","tier":"node"}"#),
                        ],
                        Json(json!({ "choices": [{ "message": message }] })),
                    )
                }),
            )
            .with_state(answers),
    )
    .await
}

/// Waits until a Web API call matches [pred]; returns its body.
async fn called(s: &Shared, pred: impl Fn(&str, &Value) -> bool) -> Value {
    for _ in 0..400 {
        if let Some((_, _, body)) = s.lock().unwrap().calls.iter().find(|(m, _, b)| pred(m, b)) {
            return body.clone();
        }
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
    panic!("never called; calls: {:#?}", s.lock().unwrap().calls);
}

fn dm(n: u32, user: &str, text: &str) -> Value {
    json!({ "envelope_id": format!("e{n}"), "type": "events_api", "payload": { "event_id": format!("Ev{n}"), "event": {
        "type": "message", "channel_type": "im", "channel": "D1", "user": user, "text": text, "ts": format!("1.{n}"),
    } } })
}

#[tokio::test]
async fn pairing_a_task_a_button_and_a_thread() {
    let home = std::env::temp_dir().join(format!("autobot-slack-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&home);
    std::fs::create_dir_all(&home).unwrap();
    let model = model(vec![
        json!({ "role": "assistant", "content": "", "tool_calls": [{ "id": "c1", "type": "function",
            "function": { "name": "terminal", "arguments": "{\"command\":\"echo from-the-tool\"}" } }] }),
        json!({ "role": "assistant", "content": "**All done.** See [the log](https://x.org/log)." }),
    ])
    .await;
    let slack: Shared = Arc::default();
    let ws = socket(slack.clone()).await;
    let api = listen(
        axum::Router::new().route("/api/{method}", axum::routing::post(web_api)).with_state((slack.clone(), ws)),
    )
    .await;
    let agent = Arc::new(Agent {
        gateway: Gateway::new(&format!("{model}/v1"), "t", "auto", true).unwrap(),
        tools: Tools::new(home.join("work"), Duration::from_secs(5)),
        approvals: ApprovalConfig { mode: ApprovalMode::Ask, allow: Vec::new() },
        max_steps: 5,
        team: Default::default(),
        mcp: Default::default(),
        trajectories: None,
        options: Default::default(),
    });
    let runtime = Runtime::standalone("autobot", &home, agent);
    let client =
        autobot::slack::Client::new(reqwest::Client::new(), &format!("{api}/api"), "xapp-APP", "xoxb-BOT").unwrap();
    tokio::spawn(autobot::slack::serve(client, runtime.clone(), invincible_policy::NetworkMode::Direct));

    // A stranger gets a code, and nothing else.
    slack.lock().unwrap().envelopes.push_back(dm(1, "U7", "hello?"));
    let reply = called(&slack, |m, b| m == "chat.postMessage" && b["text"].as_str().unwrap().contains("approve")).await;
    let users = autobot::pairing::Users::load(&home, "slack").unwrap();
    let code = users.pending[0].code.clone();
    assert!(reply["text"].as_str().unwrap().contains(&format!("`autobot slack approve {code}`")));
    assert_eq!(reply["channel"], "D1");

    // The owner approves on the machine; the next message runs a task, whose command needs a button.
    autobot::pairing::approve_in(&[home.as_path()], "slack", &code).unwrap();
    slack.lock().unwrap().envelopes.push_back(dm(2, "U7", "run something"));
    let question = called(&slack, |_, b| b.get("blocks").is_some_and(|b| b[1]["type"] == "actions")).await;
    assert!(question["text"].as_str().unwrap().contains("run: echo from-the-tool"));
    let allow = question["blocks"][1]["elements"][0]["value"].as_str().unwrap().to_owned();
    let press = |n: u32, user: &str| {
        json!({ "envelope_id": format!("e{n}"), "type": "interactive", "payload": {
            "type": "block_actions", "user": { "id": user }, "actions": [{ "action_id": "autobot_once", "value": allow }],
            "channel": { "id": "D1" }, "message": { "ts": "100.9", "text": "Approve? run: echo from-the-tool" },
        } })
    };
    // Someone else's press: a note only they see; the owner's counts.
    slack.lock().unwrap().envelopes.push_back(press(3, "U8"));
    let note = called(&slack, |m, _| m == "chat.postEphemeral").await;
    assert_eq!((note["user"].as_str(), note["text"].as_str()), (Some("U8"), Some("This question is not for you.")));
    slack.lock().unwrap().envelopes.push_back(press(4, "U7"));
    let pressed = called(&slack, |m, b| m == "chat.update" && b.get("blocks").is_some()).await;
    assert!(pressed["text"].as_str().unwrap().ends_with("→ Allowed"));
    assert_eq!(pressed["ts"], "100.9");
    let answer =
        called(&slack, |m, b| m == "chat.postMessage" && b["text"].as_str().unwrap().starts_with("*All done.*")).await;
    assert_eq!(answer["text"], "*All done.* See <https://x.org/log|the log>.\n\n_qwen · node · receipt abcdef12_");
    let calls = slack.lock().unwrap().calls.clone();
    assert!(
        calls.iter().any(|(_, _, b)| b["text"].as_str().is_some_and(|t| t.contains("› run: echo from-the-tool"))),
        "progress: {calls:#?}"
    );

    // A mention in a channel: answered in its thread, by an allowed user only.
    slack
        .lock()
        .unwrap()
        .envelopes
        .push_back(json!({ "envelope_id": "e5", "type": "events_api", "payload": { "event_id": "Ev5", "event": {
        "type": "app_mention", "channel": "C1", "user": "U9", "text": "<@UBOT> !status", "ts": "5.5" } } }));
    slack
        .lock()
        .unwrap()
        .envelopes
        .push_back(json!({ "envelope_id": "e6", "type": "events_api", "payload": { "event_id": "Ev6", "event": {
        "type": "app_mention", "channel": "C1", "user": "U7", "text": "<@UBOT> !status", "ts": "6.6" } } }));
    let status = called(&slack, |m, b| m == "chat.postMessage" && b["thread_ts"] == "6.6").await;
    assert!(status["text"].as_str().unwrap().starts_with("autobot · model auto"), "{status}");
    assert!(status["text"].as_str().unwrap().contains("slack ✓"));
    // The same envelope twice (a late ack): handled once.
    slack
        .lock()
        .unwrap()
        .envelopes
        .push_back(json!({ "envelope_id": "e7", "type": "events_api", "payload": { "event_id": "Ev6", "event": {
        "type": "app_mention", "channel": "C1", "user": "U7", "text": "<@UBOT> !status", "ts": "6.6" } } }));
    for _ in 0..100 {
        if slack.lock().unwrap().acks.len() >= 7 {
            break;
        }
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
    tokio::time::sleep(Duration::from_millis(200)).await;
    let s = slack.lock().unwrap();
    assert_eq!(s.acks, ["e1", "e2", "e3", "e4", "e5", "e6", "e7"]);
    assert!(!s.calls.iter().any(|(_, _, b)| b["thread_ts"] == "5.5"), "a stranger in a channel gets nothing");
    assert_eq!(s.calls.iter().filter(|(_, _, b)| b["thread_ts"] == "6.6").count(), 1);
    // The app-level token only opens the socket; everything else is the bot's.
    assert!(s.calls.iter().all(|(m, t, _)| (m == "apps.connections.open") == (t == "xapp-APP")));
    drop(s);
    std::fs::remove_dir_all(home).unwrap();
}
