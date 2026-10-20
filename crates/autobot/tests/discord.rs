//! The Discord channel against a stand-in REST API, a stand-in gateway websocket and a stand-in
//! model gateway: a stranger gets a pairing code, the owner approves it, a task runs, a tool is
//! approved by button (by the right person only), and progress is one edited message.

use std::collections::VecDeque;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use autobot::agent::Agent;
use autobot::config::{ApprovalConfig, ApprovalMode};
use autobot::discord::{Bot, serve};
use autobot::gateway::Gateway;
use autobot::pairing::Users;
use autobot::tools::Tools;
use axum::Json;
use axum::extract::{Path, State};
use futures_util::{SinkExt, StreamExt};
use serde_json::{Value, json};
use tokio_tungstenite::tungstenite::Message;

#[derive(Default)]
struct Discord {
    /// Dispatches for the gateway to send: (event name, data).
    events: VecDeque<(String, Value)>,
    /// (method, path, body) of every REST call but typing.
    calls: Vec<(String, String, Value)>,
    next_id: u64,
    identified: Option<Value>,
}

type Shared = Arc<Mutex<Discord>>;

async fn listen(app: axum::Router) -> String {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}", listener.local_addr().unwrap());
    tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    url
}

/// The gateway: hello, identify, ready, then whatever is queued; heartbeats acked.
async fn gateway(d: Shared) -> String {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("ws://{}", listener.local_addr().unwrap());
    tokio::spawn(async move {
        loop {
            let (stream, _) = listener.accept().await.unwrap();
            let d = d.clone();
            tokio::spawn(async move {
                let mut ws = tokio_tungstenite::accept_async(stream).await.unwrap();
                ws.send(Message::text(json!({ "op": 10, "d": { "heartbeat_interval": 2000 } }).to_string()))
                    .await
                    .unwrap();
                let mut seq = 0;
                loop {
                    tokio::select! {
                        incoming = ws.next() => {
                            let Some(Ok(Message::Text(text))) = incoming else { return };
                            let v: Value = serde_json::from_str(text.as_str()).unwrap();
                            match v["op"].as_u64() {
                                Some(2) => {
                                    d.lock().unwrap().identified = Some(v["d"].clone());
                                    seq += 1;
                                    let ready = json!({ "op": 0, "s": seq, "t": "READY", "d": {
                                        "user": { "id": "999", "username": "autobot-test" }, "session_id": "s" } });
                                    ws.send(Message::text(ready.to_string())).await.unwrap();
                                }
                                Some(1) => ws.send(Message::text(json!({ "op": 11 }).to_string())).await.unwrap(),
                                _ => {}
                            }
                        }
                        () = tokio::time::sleep(Duration::from_millis(20)) => {
                            let next = d.lock().unwrap().events.pop_front();
                            if let Some((t, data)) = next {
                                seq += 1;
                                let event = json!({ "op": 0, "s": seq, "t": t, "d": data });
                                ws.send(Message::text(event.to_string())).await.unwrap();
                            }
                        }
                    }
                }
            });
        }
    });
    url
}

async fn rest(
    State((d, ws)): State<(Shared, String)>,
    method: axum::http::Method,
    Path(path): Path<String>,
    body: axum::body::Bytes,
) -> Json<Value> {
    let body: Value = serde_json::from_slice(&body).unwrap_or(Value::Null);
    if path == "gateway/bot" {
        return Json(json!({ "url": ws }));
    }
    if path == "users/@me" {
        return Json(json!({ "id": "999", "username": "autobot-test" }));
    }
    let mut d = d.lock().unwrap();
    if path.ends_with("/typing") {
        return Json(Value::Null);
    }
    d.next_id += 1;
    let id = d.next_id;
    d.calls.push((method.to_string(), path.clone(), body.clone()));
    Json(json!({ "id": format!("m{id}"), "channel_id": "c1", "content": body["content"] }))
}

fn dm(id: &str, author: &str, text: &str) -> (String, Value) {
    (
        "MESSAGE_CREATE".into(),
        json!({
            "id": id, "channel_id": "c1", "content": text,
            "author": { "id": author, "username": "ann" },
        }),
    )
}

/// Waits until a call matches [pred]; returns its body.
async fn called(d: &Shared, pred: impl Fn(&str, &str, &Value) -> bool) -> Value {
    for _ in 0..400 {
        if let Some((_, _, body)) = d.lock().unwrap().calls.iter().find(|(m, p, b)| pred(m, p, b)) {
            return body.clone();
        }
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
    panic!("never called; calls: {:#?}", d.lock().unwrap().calls);
}

#[tokio::test]
async fn pairing_then_a_task_with_an_approval_by_button() {
    let home = std::env::temp_dir().join(format!("autobot-discord-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&home);
    std::fs::create_dir_all(&home).unwrap();

    let answers = Arc::new(Mutex::new(VecDeque::from([
        json!({ "role": "assistant", "content": "", "tool_calls": [{ "id": "c1", "type": "function",
            "function": { "name": "terminal", "arguments": "{\"command\":\"echo from-the-tool\"}" } }] }),
        json!({ "role": "assistant", "content": "All done." }),
    ])));
    let model = listen(
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
    .await;

    let discord: Shared = Arc::default();
    let ws = gateway(discord.clone()).await;
    let api =
        listen(axum::Router::new().route("/api/{*path}", axum::routing::any(rest)).with_state((discord.clone(), ws)))
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
    let bot = Bot::new(reqwest::Client::new(), &format!("{api}/api"), "TOKEN", invincible_policy::NetworkMode::Direct)
        .unwrap();
    tokio::spawn(serve(bot, agent, home.clone()));

    // Identified with the token and the intents for direct and server messages.
    for _ in 0..200 {
        if discord.lock().unwrap().identified.is_some() {
            break;
        }
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
    let identify = discord.lock().unwrap().identified.clone().expect("identified");
    assert_eq!(identify["token"], "TOKEN");
    assert_eq!(identify["intents"], 4608);

    // A stranger gets a code, and nothing else.
    discord.lock().unwrap().events.push_back(dm("1", "7", "hello?"));
    let reply = called(&discord, |_, _, b| b["content"].as_str().is_some_and(|t| t.contains("approve"))).await;
    let mut users = Users::load(&home, "discord").unwrap();
    let code = users.pending[0].code.clone();
    assert!(reply["content"].as_str().unwrap().contains(&format!("autobot discord approve {code}")));

    // A server message from the stranger, even mentioning the bot, is ignored.
    users.approve(&code).unwrap();
    users.save(&home, "discord").unwrap();
    discord.lock().unwrap().events.push_back((
        "MESSAGE_CREATE".into(),
        json!({ "id": "2", "channel_id": "g1", "guild_id": "G", "content": "<@999> hi",
            "author": { "id": "8", "username": "eve" }, "mentions": [{ "id": "999" }] }),
    ));
    // The owner's message runs a task; the command needs a button.
    discord.lock().unwrap().events.push_back(dm("3", "7", "run something"));
    let question = called(&discord, |_, _, b| b.get("components").is_some_and(|c| c.is_array())).await;
    assert!(question["content"].as_str().unwrap().contains("run: echo from-the-tool"));
    let allow = question["components"][0]["components"][0]["custom_id"].as_str().unwrap().to_owned();

    // Someone else's press: a note only they see.
    discord.lock().unwrap().events.push_back((
        "INTERACTION_CREATE".into(),
        json!({ "id": "i1", "token": "tk1", "type": 3, "data": { "custom_id": allow },
            "member": { "user": { "id": "8" } }, "message": { "content": "Approve? run: echo from-the-tool" } }),
    ));
    let note = called(&discord, |_, p, _| p == "interactions/i1/tk1/callback").await;
    assert_eq!(note["type"], 4);
    assert_eq!(note["data"]["flags"], 64);

    // The owner's press counts.
    discord.lock().unwrap().events.push_back((
        "INTERACTION_CREATE".into(),
        json!({ "id": "i2", "token": "tk2", "type": 3, "data": { "custom_id": allow },
            "user": { "id": "7" }, "message": { "content": "Approve? run: echo from-the-tool" } }),
    ));
    let pressed = called(&discord, |_, p, _| p == "interactions/i2/tk2/callback").await;
    assert_eq!(pressed["type"], 7);
    assert!(pressed["data"]["content"].as_str().unwrap().ends_with("→ Allowed"));

    let answer = called(&discord, |_, _, b| b["content"].as_str().is_some_and(|t| t.starts_with("All done."))).await;
    assert_eq!(answer["content"], "All done.\n\n-# qwen · node · receipt abcdef12");
    let calls = discord.lock().unwrap().calls.clone();
    assert!(
        calls.iter().any(|(_, _, b)| b["content"].as_str().is_some_and(|t| t.contains("› run: echo from-the-tool"))),
        "progress: {calls:#?}"
    );
    // Nothing went to the server channel.
    assert!(!calls.iter().any(|(_, p, _)| p.starts_with("channels/g1")), "{calls:#?}");
    std::fs::remove_dir_all(home).unwrap();
}
