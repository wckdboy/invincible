//! Live bots and nudges: a bot added, edited, disabled or removed while `autobot serve` runs is
//! started, restarted or stopped on its own (its channel connection let go), the others left
//! running; the API does the same at once; and the nudge after a turn runs for every channel and
//! the API, in the background, one at a time per bot, without a word in the chat.

use std::collections::VecDeque;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use autobot::agent::Agent;
use autobot::bots::{Fleet, Runtime};
use autobot::channel::{Asking, BoxFuture, Incoming, Progress, Question, Transport};
use autobot::config::{ApprovalConfig, ApprovalMode};
use autobot::gateway::Gateway;
use autobot::tools::Tools;
use axum::Json;
use axum::extract::State;
use serde_json::{Value, json};

const TOKEN: &str = "test-token";

async fn listen(app: axum::Router) -> String {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}", listener.local_addr().unwrap());
    tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    url
}

type Seen = Arc<Mutex<Vec<Value>>>;

/// A model that answers [answers] in order, keeping each request in [seen].
async fn model(answers: Vec<Value>, seen: Seen) -> String {
    let state = (Arc::new(Mutex::new(VecDeque::from(answers))), seen);
    listen(
        axum::Router::new()
            .route(
                "/v1/chat/completions",
                axum::routing::post(
                    |State((a, seen)): State<(Arc<Mutex<VecDeque<Value>>>, Seen)>, Json(body): Json<Value>| async move {
                        seen.lock().unwrap().push(body);
                        let message = a
                            .lock()
                            .unwrap()
                            .pop_front()
                            .unwrap_or(json!({ "role": "assistant", "content": "(out of answers)" }));
                        Json(json!({ "choices": [{ "message": message }] }))
                    },
                ),
            )
            .with_state(state),
    )
    .await
}

fn temp(name: &str) -> std::path::PathBuf {
    let dir = std::env::temp_dir().join(format!("autobot-live-{name}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

fn agent(url: &str, home: &std::path::Path, nudge_every: usize) -> Agent {
    Agent {
        gateway: Gateway::new(&format!("{url}/v1"), TOKEN, "auto", true).unwrap(),
        tools: Tools::new(home.join("work"), Duration::from_secs(5)).with_home(home.to_owned()),
        approvals: ApprovalConfig { mode: ApprovalMode::Ask, allow: Vec::new() },
        max_steps: 5,
        team: Default::default(),
        mcp: Default::default(),
        trajectories: None,
        options: autobot::agent::Options { nudge_every, ..Default::default() },
    }
}

async fn until(what: &str, check: impl Fn() -> bool) {
    for _ in 0..500 {
        if check() {
            return;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    panic!("never: {what}");
}

/// A stand-in signal-cli daemon: who is connected to its event stream now.
#[derive(Clone, Default)]
struct Daemon {
    streams: Arc<Mutex<Vec<tokio::sync::mpsc::UnboundedSender<Value>>>>,
}

impl Daemon {
    fn connected(&self) -> usize {
        self.streams.lock().unwrap().iter().filter(|tx| !tx.is_closed()).count()
    }
}

async fn events(State(d): State<Daemon>) -> axum::response::Response {
    let (tx, rx) = tokio::sync::mpsc::unbounded_channel::<Value>();
    d.streams.lock().unwrap().push(tx);
    let stream = futures_util::stream::unfold(rx, |mut rx| async move {
        let event = rx.recv().await?;
        Some((Ok::<_, std::convert::Infallible>(axum::body::Bytes::from(format!("data:{event}\n\n"))), rx))
    });
    axum::response::Response::builder()
        .header("content-type", "text/event-stream")
        .body(axum::body::Body::from_stream(stream))
        .unwrap()
}

fn names(fleet: &Fleet) -> Vec<String> {
    fleet.runtimes().iter().map(|r| r.name.clone()).collect()
}

#[tokio::test]
async fn bots_start_stop_and_restart_while_serving() {
    let root = temp("fleet");
    std::fs::write(root.join("config.toml"), "").unwrap();
    let daemon = Daemon::default();
    let signal =
        listen(axum::Router::new().route("/api/v1/events", axum::routing::get(events)).with_state(daemon.clone()))
            .await;
    let url = model(Vec::new(), Seen::default()).await;
    let make = {
        let url = url.clone();
        move |def: &autobot::bots::Def| Ok(agent(&url, &def.home, 0))
    };
    let fleet = Fleet::new(&root, Box::new(make));
    let done = fleet.reload().unwrap();
    assert_eq!(done.started, ["default"]);
    assert!(fleet.reload().unwrap().is_empty(), "nothing changed");
    tokio::spawn(fleet.clone().watch(Duration::from_millis(100)));
    let default = fleet.runtimes()[0].clone();

    // Added on disk: it starts, with its channel (here Signal, through the stand-in daemon).
    autobot::bots::add(&root, "ops", &autobot::bots::NewBot::default()).unwrap();
    let home = root.join("bots/ops");
    let toml = std::fs::read_to_string(home.join("bot.toml")).unwrap();
    std::fs::write(
        home.join("bot.toml"),
        format!("{toml}\n[signal]\nenabled = true\naccount = \"+15550100\"\nurl = \"{signal}\"\n"),
    )
    .unwrap();
    until("ops runs", || names(&fleet) == ["default", "ops"]).await;
    until("ops connects to Signal", || daemon.connected() == 1).await;
    let ops = fleet.runtimes()[1].clone();

    // Its persona changes: read at every turn, so nothing restarts.
    std::fs::write(home.join("SOUL.md"), "Terse.\n").unwrap();
    tokio::time::sleep(Duration::from_millis(900)).await;
    assert!(Arc::ptr_eq(&fleet.runtimes()[1], &ops), "not restarted for its SOUL.md");

    // Its config changes: it alone starts again, connected afresh; the default bot is untouched.
    autobot::setup::set(&home.join("bot.toml"), "bot", "description", toml_edit::value("Watches the servers")).unwrap();
    until("ops restarts", || fleet.runtimes().get(1).is_some_and(|r| !Arc::ptr_eq(r, &ops))).await;
    assert_eq!(fleet.runtimes()[1].config.bot.description, "Watches the servers");
    assert!(Arc::ptr_eq(&fleet.runtimes()[0], &default), "the default bot kept running");
    until("one connection, the new one", || daemon.connected() == 1).await;

    // Disabled: it stops and lets go of its channel.
    autobot::bots::set_enabled(&root, "ops", false).unwrap();
    until("ops stops", || names(&fleet) == ["default"]).await;
    until("Signal let go", || daemon.connected() == 0).await;

    // Enabled again, then removed.
    autobot::bots::set_enabled(&root, "ops", true).unwrap();
    until("ops runs again", || names(&fleet) == ["default", "ops"]).await;
    autobot::bots::remove(&root, "ops").unwrap();
    until("ops is gone", || names(&fleet) == ["default"]).await;
    until("Signal let go again", || daemon.connected() == 0).await;

    // A bot that cannot start is reported; the others run on.
    autobot::bots::add(&root, "bad", &autobot::bots::NewBot::default()).unwrap();
    let failing =
        Fleet::new(
            &root,
            Box::new(|def: &autobot::bots::Def| {
                if def.name == "bad" { Err("no model".to_owned()) } else { Err("not this one either".to_owned()) }
            }),
        );
    let done = failing.reload().unwrap();
    assert_eq!(done.failed.len(), 2);
    assert!(failing.runtimes().is_empty());
    fleet.stop();
    std::fs::remove_dir_all(root).unwrap();
}

#[tokio::test]
async fn the_api_enables_disables_and_reloads_at_once() {
    let root = temp("api");
    std::fs::write(root.join("config.toml"), "").unwrap();
    autobot::bots::add(&root, "ops", &autobot::bots::NewBot::default()).unwrap();
    autobot::bots::set_enabled(&root, "ops", false).unwrap();
    let url = model(vec![json!({ "role": "assistant", "content": "from ops" })], Seen::default()).await;
    let make = {
        let url = url.clone();
        move |def: &autobot::bots::Def| Ok(agent(&url, &def.home, 0))
    };
    let fleet = Fleet::new(&root, Box::new(make));
    fleet.reload().unwrap();
    let state = autobot::api::ApiState::for_fleet(TOKEN.into(), fleet.clone());
    let api = listen(autobot::api::app(Arc::new(state))).await;
    let client = reqwest::Client::new();
    let post = |path: &str| {
        let request = client.post(format!("{api}{path}")).bearer_auth(TOKEN).json(&json!({}));
        async move { request.send().await.unwrap().json::<Value>().await.unwrap() }
    };
    let get = |path: &str| {
        let request = client.get(format!("{api}{path}")).bearer_auth(TOKEN);
        async move { request.send().await.unwrap().json::<Value>().await.unwrap() }
    };
    assert_eq!(get("/v1/agent").await["bots"], json!(["default"]));

    let enabled = post("/v1/agent/bots/ops/enable").await;
    assert_eq!(enabled, json!({ "ok": true, "enabled": true, "restart": false, "status": "running" }));
    assert_eq!(names(&fleet), ["default", "ops"]);
    assert_eq!(get("/v1/agent").await["bots"], json!(["default", "ops"]));
    let stream = client
        .post(format!("{api}/v1/agent/sessions/p1/turns"))
        .bearer_auth(TOKEN)
        .json(&json!({ "text": "hi", "bot": "ops" }))
        .send()
        .await
        .unwrap()
        .text()
        .await
        .unwrap();
    assert!(stream.contains("from ops"), "{stream}");
    let listed = get("/v1/agent/bots").await;
    assert_eq!(listed["bots"].as_array().unwrap().iter().find(|b| b["name"] == "ops").unwrap()["status"], "running");

    let disabled = post("/v1/agent/bots/ops/disable").await;
    assert_eq!(disabled["status"], "stopped");
    assert_eq!(names(&fleet), ["default"]);
    assert_eq!(get("/v1/agent/sessions/p1").await["error"]["code"], json!(null), "its conversation is still on disk");

    // A change made by hand, taken in at once.
    autobot::bots::set_enabled(&root, "ops", true).unwrap();
    let reloaded = post("/v1/agent/bots/reload").await;
    assert_eq!(reloaded["started"], json!(["ops"]));
    assert_eq!(reloaded["running"], json!(["default", "ops"]));
    assert_eq!(post("/v1/agent/bots/reload").await["started"], json!([]));
    fleet.stop();
    std::fs::remove_dir_all(root).unwrap();
}

/// A platform that keeps what it was given.
struct Recorder {
    sent: Mutex<Vec<String>>,
}

impl Transport for Recorder {
    fn platform(&self) -> &'static str {
        "slack"
    }
    fn limit(&self) -> usize {
        4000
    }
    fn progress(&self) -> Progress {
        Progress::Quiet
    }
    fn asking(&self) -> Asking {
        Asking::Reply
    }
    fn send<'a>(&'a self, _chat: &'a str, text: &'a str) -> BoxFuture<'a, Result<Option<String>, String>> {
        Box::pin(async move {
            self.sent.lock().unwrap().push(text.to_owned());
            Ok(None)
        })
    }
    fn ask<'a>(&'a self, chat: &'a str, question: &'a Question) -> BoxFuture<'a, Result<(), String>> {
        Box::pin(async move { self.send(chat, &question.text).await.map(drop) })
    }
}

fn message(text: &str) -> Incoming {
    Incoming {
        chat: "D1".into(),
        place: "slack-D1".into(),
        user: autobot::pairing::User { id: "U1".into(), name: "ann".into() },
        text: text.into(),
        direct: true,
        audio: None,
    }
}

fn nudge(profile: &str) -> Value {
    json!({ "role": "assistant", "content": format!("{{\"profile\": [\"{profile}\"], \"memory\": []}}") })
}

#[tokio::test]
async fn nudges_run_for_channels_in_the_background_once_a_minute_per_bot() {
    let home = temp("nudge-channel");
    let seen = Seen::default();
    let url = model(
        vec![
            json!({ "role": "assistant", "content": "Hi." }),
            nudge("Prefers short answers"),
            json!({ "role": "assistant", "content": "Again." }),
        ],
        seen.clone(),
    )
    .await;
    let runtime = Runtime::standalone("default", &home, Arc::new(agent(&url, &home, 1)));
    let code =
        autobot::pairing::code_for(&home, "slack", &autobot::pairing::User { id: "U1".into(), name: "ann".into() })
            .unwrap();
    autobot::pairing::approve_in(&[home.as_path()], "slack", &code).unwrap();
    let recorder = Arc::new(Recorder { sent: Mutex::default() });
    let transport: Arc<dyn Transport> = recorder.clone();

    autobot::channel::handle(&runtime, &transport, message("hello")).await.unwrap();
    until("the profile keeps it", || autobot::profile::entries(&home) == ["Prefers short answers"]).await;
    // A second turn right after: due again (every turn), but this bot nudged a moment ago.
    autobot::channel::handle(&runtime, &transport, message("again")).await.unwrap();
    tokio::time::sleep(Duration::from_millis(300)).await;
    assert_eq!(seen.lock().unwrap().len(), 3, "two turns and one nudge");
    // Nothing about it in the chat.
    assert_eq!(*recorder.sent.lock().unwrap(), ["Hi.", "Again."]);
    std::fs::remove_dir_all(home).unwrap();
}

#[tokio::test]
async fn an_api_turn_says_what_its_nudge_kept() {
    let home = temp("nudge-api");
    let url =
        model(vec![json!({ "role": "assistant", "content": "Done." }), nudge("Works in Rust")], Seen::default()).await;
    let state = autobot::api::ApiState::new(Arc::new(agent(&url, &home, 1)), TOKEN.into(), home.clone(), json!({}));
    let api = listen(autobot::api::app(Arc::new(state))).await;
    let stream = reqwest::Client::new()
        .post(format!("{api}/v1/agent/sessions/s1/turns"))
        .bearer_auth(TOKEN)
        .json(&json!({ "text": "fix it" }))
        .send()
        .await
        .unwrap()
        .text()
        .await
        .unwrap();
    let events: Vec<Value> = stream
        .split("\n\n")
        .filter_map(|e| e.strip_prefix("data: "))
        .map(|e| serde_json::from_str(e).unwrap())
        .collect();
    let types: Vec<&str> = events.iter().map(|e| e["type"].as_str().unwrap()).collect();
    assert_eq!(types, ["turn.started", "answer", "kept"], "{stream}");
    assert_eq!(events[2]["text"], "profile: Works in Rust");
    assert_eq!(autobot::profile::entries(&home), ["Works in Rust"]);
    std::fs::remove_dir_all(home).unwrap();
}
