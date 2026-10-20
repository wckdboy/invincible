//! Signal against a stand-in signal-cli daemon (JSON-RPC and an event stream) and a stand-in
//! model gateway: a stranger gets a pairing code, the owner approves it, a task runs, and its
//! command is approved by replying "yes".

use std::collections::VecDeque;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use autobot::agent::Agent;
use autobot::bots::Runtime;
use autobot::config::{ApprovalConfig, ApprovalMode};
use autobot::gateway::Gateway;
use autobot::tools::Tools;
use axum::Json;
use axum::extract::State;
use serde_json::{Value, json};

#[derive(Clone, Default)]
struct Daemon {
    events: Arc<Mutex<Option<tokio::sync::mpsc::UnboundedSender<Value>>>>,
    calls: Arc<Mutex<Vec<Value>>>,
}

async fn listen(app: axum::Router) -> String {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}", listener.local_addr().unwrap());
    tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    url
}

async fn events(State(d): State<Daemon>) -> axum::response::Response {
    let (tx, rx) = tokio::sync::mpsc::unbounded_channel::<Value>();
    *d.events.lock().unwrap() = Some(tx);
    let stream = futures_util::stream::unfold(rx, |mut rx| async move {
        let event = rx.recv().await?;
        Some((
            Ok::<_, std::convert::Infallible>(axum::body::Bytes::from(format!("event:receive\ndata:{event}\n\n"))),
            rx,
        ))
    });
    axum::response::Response::builder()
        .header("content-type", "text/event-stream")
        .body(axum::body::Body::from_stream(stream))
        .unwrap()
}

async fn rpc(State(d): State<Daemon>, Json(body): Json<Value>) -> Json<Value> {
    d.calls.lock().unwrap().push(body.clone());
    Json(json!({ "jsonrpc": "2.0", "id": body["id"], "result": { "timestamp": 1 } }))
}

impl Daemon {
    async fn say(&self, from: &str, text: &str) {
        for _ in 0..200 {
            if let Some(tx) = self.events.lock().unwrap().as_ref() {
                tx.send(json!({ "envelope": { "sourceNumber": from, "sourceName": "Ann", "dataMessage": { "message": text } } }))
                    .unwrap();
                return;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        panic!("nobody listens to the events");
    }

    async fn sent(&self, pred: impl Fn(&str) -> bool) -> Value {
        for _ in 0..400 {
            let found = self
                .calls
                .lock()
                .unwrap()
                .iter()
                .find(|c| c["method"] == "send" && pred(c["params"]["message"].as_str().unwrap_or("")))
                .cloned();
            if let Some(call) = found {
                return call["params"].clone();
            }
            tokio::time::sleep(Duration::from_millis(25)).await;
        }
        panic!("never sent: {:#?}", self.calls.lock().unwrap());
    }
}

#[tokio::test]
async fn pairing_then_a_task_approved_by_a_reply() {
    let home = std::env::temp_dir().join(format!("autobot-signal-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&home);
    std::fs::create_dir_all(&home).unwrap();
    let answers = Arc::new(Mutex::new(VecDeque::from([
        json!({ "role": "assistant", "content": "", "tool_calls": [{ "id": "c1", "type": "function",
            "function": { "name": "terminal", "arguments": "{\"command\":\"echo from-the-tool\"}" } }] }),
        json!({ "role": "assistant", "content": "**Done.**" }),
    ])));
    let model = listen(
        axum::Router::new()
            .route(
                "/v1/chat/completions",
                axum::routing::post(|State(a): State<Arc<Mutex<VecDeque<Value>>>>| async move {
                    Json(json!({ "choices": [{ "message": a.lock().unwrap().pop_front().unwrap() }] }))
                }),
            )
            .with_state(answers),
    )
    .await;
    let daemon = Daemon::default();
    let url = listen(
        axum::Router::new()
            .route("/api/v1/events", axum::routing::get(events))
            .route("/api/v1/rpc", axum::routing::post(rpc))
            .with_state(daemon.clone()),
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
    let runtime = Runtime::standalone("default", &home, agent);
    tokio::spawn(autobot::signal::serve(autobot::signal::Client::new(&url).unwrap(), runtime));

    daemon.say("+15550001", "hello?").await;
    let reply = daemon.sent(|t| t.contains("approve")).await;
    assert_eq!(reply["recipient"], json!(["+15550001"]));
    let code = autobot::pairing::Users::load(&home, "signal").unwrap().pending[0].code.clone();
    assert!(reply["message"].as_str().unwrap().contains(&format!("autobot signal approve {code}")));
    autobot::pairing::approve_in(&[home.as_path()], "signal", &code).unwrap();

    daemon.say("+15550001", "run something").await;
    let question = daemon.sent(|t| t.starts_with("Approve?")).await;
    assert!(question["message"].as_str().unwrap().contains("run: echo from-the-tool"));
    // The owner's "yes", while one question waits there, answers it.
    daemon.say("+15550001", "yes").await;
    daemon.sent(|t| t == "→ Allowed").await;
    let answer = daemon.sent(|t| t.starts_with("Done.")).await;
    assert_eq!(answer["message"], "Done.", "plain text: no Markdown marks");
    let calls = daemon.calls.lock().unwrap();
    assert!(calls.iter().any(|c| c["method"] == "sendTyping"));
    drop(calls);
    std::fs::remove_dir_all(home).unwrap();
}
