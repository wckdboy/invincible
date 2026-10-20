//! Bots: two at once, each with its own persona, model and memory, a slow one not holding up
//! the other; one conversation across platforms for a linked person; a home channel; and the
//! agent API's bot listing, enabling, and turns that name their bot.

use std::collections::VecDeque;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use autobot::agent::Agent;
use autobot::bots::Runtime;
use autobot::channel::{Asking, BoxFuture, Incoming, Progress, Question, Transport};
use autobot::config::{ApprovalConfig, ApprovalMode};
use autobot::gateway::Gateway;
use autobot::tools::Tools;
use axum::Json;
use axum::extract::State;
use serde_json::{Value, json};

const TOKEN: &str = "test-token";

/// A platform that keeps what it was given.
struct Recorder {
    platform: &'static str,
    sent: Mutex<Vec<(String, String)>>,
}

impl Recorder {
    fn new(platform: &'static str) -> Arc<Self> {
        Arc::new(Self { platform, sent: Mutex::default() })
    }

    fn texts(&self) -> Vec<String> {
        self.sent.lock().unwrap().iter().map(|(_, t)| t.clone()).collect()
    }
}

impl Transport for Recorder {
    fn platform(&self) -> &'static str {
        self.platform
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
    fn send<'a>(&'a self, chat: &'a str, text: &'a str) -> BoxFuture<'a, Result<Option<String>, String>> {
        Box::pin(async move {
            self.sent.lock().unwrap().push((chat.to_owned(), text.to_owned()));
            Ok(None)
        })
    }
    fn ask<'a>(&'a self, chat: &'a str, question: &'a Question) -> BoxFuture<'a, Result<(), String>> {
        Box::pin(async move { self.send(chat, &question.text).await.map(drop) })
    }
}

async fn listen(app: axum::Router) -> String {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}", listener.local_addr().unwrap());
    tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    url
}

type Seen = Arc<Mutex<Vec<Value>>>;

/// A model that answers [answers] in order after [delay], keeping each request in [seen].
async fn model(answers: Vec<Value>, delay: Duration, seen: Seen) -> String {
    let state = (Arc::new(Mutex::new(VecDeque::from(answers))), seen);
    listen(
        axum::Router::new()
            .route(
                "/v1/chat/completions",
                axum::routing::post(
                    move |State((a, seen)): State<(Arc<Mutex<VecDeque<Value>>>, Seen)>, Json(body): Json<Value>| async move {
                        seen.lock().unwrap().push(body);
                        tokio::time::sleep(delay).await;
                        let message = a.lock().unwrap().pop_front().unwrap_or(json!({ "role": "assistant", "content": "(out of answers)" }));
                        Json(json!({ "choices": [{ "message": message }] }))
                    },
                ),
            )
            .with_state(state),
    )
    .await
}

fn temp(name: &str) -> std::path::PathBuf {
    let dir = std::env::temp_dir().join(format!("autobot-bots-it-{name}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

fn agent(url: &str, home: &std::path::Path, persona: Option<autobot::agent::Persona>) -> Agent {
    Agent {
        gateway: Gateway::new(&format!("{url}/v1"), TOKEN, "auto", true).unwrap(),
        tools: Tools::new(home.join("work"), Duration::from_secs(5)).with_home(home.to_owned()),
        approvals: ApprovalConfig { mode: ApprovalMode::Ask, allow: Vec::new() },
        max_steps: 5,
        team: Default::default(),
        mcp: Default::default(),
        trajectories: None,
        options: autobot::agent::Options { persona, ..Default::default() },
    }
}

fn allow(home: &std::path::Path, platform: &str, id: &str) {
    let code =
        autobot::pairing::code_for(home, platform, &autobot::pairing::User { id: id.into(), name: "ann".into() })
            .unwrap();
    autobot::pairing::approve_in(&[home], platform, &code).unwrap();
}

fn message(chat: &str, user: &str, text: &str, place: &str) -> Incoming {
    Incoming {
        chat: chat.into(),
        place: place.into(),
        user: autobot::pairing::User { id: user.into(), name: "ann".into() },
        text: text.into(),
        direct: true,
        audio: None,
    }
}

async fn until(what: &str, check: impl Fn() -> bool) {
    for _ in 0..400 {
        if check() {
            return;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    panic!("never: {what}");
}

#[tokio::test]
async fn two_bots_at_once_each_its_own() {
    let (a_home, b_home) = (temp("a"), temp("b"));
    std::fs::write(b_home.join("SOUL.md"), "Terse. Watches the servers.\n").unwrap();
    let (a_seen, b_seen): (Seen, Seen) = Default::default();
    // The default bot's model is slow; ops' remembers something and answers at once.
    let a_model =
        model(vec![json!({ "role": "assistant", "content": "A here." })], Duration::from_millis(1500), a_seen.clone())
            .await;
    let b_model = model(
        vec![
            json!({ "role": "assistant", "content": "", "tool_calls": [{ "id": "c1", "type": "function",
                "function": { "name": "remember", "arguments": "{\"text\":\"the backup runs at 3\"}" } }] }),
            json!({ "role": "assistant", "content": "Ops here." }),
        ],
        Duration::ZERO,
        b_seen.clone(),
    )
    .await;
    let a = Runtime::standalone("default", &a_home, Arc::new(agent(&a_model, &a_home, None)));
    // Its SOUL.md comes from its own home; its name from its config.
    let persona = autobot::agent::Persona { name: Some("ops".into()) };
    let b = Runtime::standalone("ops", &b_home, Arc::new(agent(&b_model, &b_home, Some(persona))));
    let (a_slack, b_slack) = (Recorder::new("slack"), Recorder::new("slack"));
    allow(&a_home, "slack", "U1");
    allow(&b_home, "slack", "U1");
    let (ta, tb): (Arc<dyn Transport>, Arc<dyn Transport>) = (a_slack.clone(), b_slack.clone());
    let (ra, rb) = (a.clone(), b.clone());
    tokio::spawn(
        async move { autobot::channel::handle(&ra, &ta, message("D1", "U1", "hi A", "slack-D1")).await.unwrap() },
    );
    tokio::spawn(async move {
        autobot::channel::handle(&rb, &tb, message("D2", "U1", "hi ops", "slack-D2")).await.unwrap()
    });

    // Ops answers while the default bot's model still thinks.
    until("ops answers", || b_slack.texts().iter().any(|t| t == "Ops here.")).await;
    assert!(a_slack.texts().is_empty(), "the slow bot holds up nobody: {:?}", a_slack.texts());
    until("the default bot answers", || a_slack.texts().iter().any(|t| t == "A here.")).await;

    // Each remembered only its own; each spoke as itself.
    assert_eq!(autobot::memory::Memory::new(&b_home).list()[0].text, "the backup runs at 3");
    assert!(autobot::memory::Memory::new(&a_home).list().is_empty());
    let b_system = b_seen.lock().unwrap()[0]["messages"][0]["content"].as_str().unwrap().to_owned();
    assert!(b_system.starts_with("You are ops, an Autobot agent"), "{b_system}");
    assert!(b_system.contains("Terse. Watches the servers."));
    let a_system = a_seen.lock().unwrap()[0]["messages"][0]["content"].as_str().unwrap().to_owned();
    assert!(a_system.starts_with("You are Autobot") && !a_system.contains("Watches the servers"));
    assert!(b_system.contains(&b_home.join("work").display().to_string()), "its own working directory");
    // Its conversation is in its own directory.
    assert!(b_home.join("sessions/slack-D2.jsonl").is_file());
    assert!(!a_home.join("sessions/slack-D2.jsonl").exists());
    std::fs::remove_dir_all(a_home).unwrap();
    std::fs::remove_dir_all(b_home).unwrap();
}

#[tokio::test]
async fn one_conversation_across_platforms_and_a_home_channel() {
    let home = temp("linked");
    let seen: Seen = Default::default();
    let url = model(
        vec![
            json!({ "role": "assistant", "content": "Hello Ann." }),
            json!({ "role": "assistant", "content": "You are Ann." }),
        ],
        Duration::ZERO,
        seen.clone(),
    )
    .await;
    let runtime = Runtime::standalone("default", &home, Arc::new(agent(&url, &home, None)));
    let (telegram, slack) = (Recorder::new("telegram"), Recorder::new("slack"));
    runtime.register(slack.clone());
    allow(&home, "telegram", "42");
    allow(&home, "slack", "U1");
    let mut ids = autobot::identity::Identities::default();
    ids.link(&["telegram:42".into(), "slack:U1".into()], None).unwrap();
    ids.save(&home).unwrap();
    let (tg, sl): (Arc<dyn Transport>, Arc<dyn Transport>) = (telegram.clone(), slack.clone());

    autobot::channel::handle(&runtime, &tg, message("42", "42", "my name is Ann", "telegram-42")).await.unwrap();
    assert_eq!(telegram.texts(), ["Hello Ann."]);
    autobot::channel::handle(&runtime, &sl, message("D1", "U1", "what is my name?", "slack-D1")).await.unwrap();
    assert_eq!(slack.texts(), ["You are Ann."]);
    // The second turn, on Slack, carried the first one, from Telegram.
    let second = seen.lock().unwrap()[1]["messages"].to_string();
    assert!(second.contains("my name is Ann") && second.contains("Hello Ann."), "{second}");
    assert!(home.join("sessions/dm-owner.jsonl").is_file());

    // /sethome: notices with nowhere else to go come here; /status and /bots answer at once.
    autobot::channel::handle(&runtime, &sl, message("D1", "U1", "/sethome", "slack-D1")).await.unwrap();
    assert_eq!(runtime.home_channel().as_deref(), Some("slack:D1"));
    runtime.notify(&[], "the nightly check is done").await;
    assert_eq!(slack.sent.lock().unwrap().last().unwrap(), &("D1".to_owned(), "the nightly check is done".to_owned()));
    autobot::channel::handle(&runtime, &sl, message("D1", "U1", "!status", "slack-D1")).await.unwrap();
    assert!(slack.texts().last().unwrap().starts_with("default · model auto"));
    // Someone not linked as the owner may not set the home.
    allow(&home, "slack", "U2");
    autobot::channel::handle(&runtime, &sl, message("D9", "U2", "/sethome", "slack-D9")).await.unwrap();
    assert_eq!(slack.texts().last().unwrap(), "Only the owner can do that.");
    assert_eq!(runtime.home_channel().as_deref(), Some("slack:D1"));

    // A schedule answers where it says, else home.
    let mut schedules = autobot::cron::Schedules::default();
    schedules.add("@daily", "x", false).unwrap();
    let (to, everyone, home_channel) = autobot::cron::targets(&schedules.schedules[0], &home);
    assert!(to.is_empty() && !everyone && home_channel);
    schedules.schedules[0].to = vec!["email:me@example.com".into()];
    let (to, _, home_channel) = autobot::cron::targets(&schedules.schedules[0], &home);
    assert_eq!((to, home_channel), (vec!["email:me@example.com".to_owned()], false));
    std::fs::remove_dir_all(home).unwrap();
}

#[tokio::test]
async fn the_api_lists_bots_enables_them_and_routes_turns() {
    let root = temp("api");
    std::fs::write(root.join("config.toml"), "").unwrap();
    std::fs::write(root.join("SOUL.md"), "\n# The house agent\nKind.\n").unwrap();
    autobot::bots::add(
        &root,
        "ops",
        &autobot::bots::NewBot { soul: Some("Watches the servers.\n".into()), ..Default::default() },
    )
    .unwrap();
    autobot::bots::add(&root, "off", &autobot::bots::NewBot::default()).unwrap();
    autobot::bots::set_enabled(&root, "off", false).unwrap();
    let (main_seen, ops_seen): (Seen, Seen) = Default::default();
    let main_model =
        model(vec![json!({ "role": "assistant", "content": "from default" })], Duration::ZERO, main_seen).await;
    let ops_model =
        model(vec![json!({ "role": "assistant", "content": "from ops" })], Duration::ZERO, ops_seen.clone()).await;
    let main = autobot::bots::load(&root, "default").unwrap();
    let ops = autobot::bots::load(&root, "ops").unwrap();
    let runtimes = vec![
        Runtime::new(&main, agent(&main_model, &main.home, None)),
        Runtime::new(&ops, agent(&ops_model, &ops.home, None)),
    ];
    runtimes[1].register(Recorder::new("slack"));
    runtimes[1].channel_account("slack", "@ops-bot");
    let state = autobot::api::ApiState::for_bots(TOKEN.into(), &runtimes, Some(root.clone()), Vec::new());
    let url = listen(autobot::api::app(Arc::new(state))).await;
    let client = reqwest::Client::new();
    let get = |path: &str| {
        let request = client.get(format!("{url}{path}")).bearer_auth(TOKEN);
        async move { request.send().await.unwrap().json::<Value>().await.unwrap() }
    };

    let info = get("/v1/agent").await;
    assert_eq!(info["bots"], json!(["default", "ops"]));
    let bots = get("/v1/agent/bots").await;
    let list = bots["bots"].as_array().unwrap();
    let names: Vec<&str> = list.iter().map(|b| b["name"].as_str().unwrap()).collect();
    assert_eq!(names, ["default", "off", "ops"]);
    let by = |name: &str| list.iter().find(|b| b["name"] == name).unwrap().clone();
    assert_eq!(
        (by("default")["status"].as_str(), by("default")["persona"].as_str()),
        (Some("running"), Some("The house agent"))
    );
    assert_eq!((by("off")["status"].as_str(), by("off")["enabled"].as_bool()), (Some("stopped"), Some(false)));
    let ops_item = by("ops");
    assert_eq!(ops_item["persona"], "Watches the servers.");
    assert_eq!(ops_item["approvals"], "ask");
    assert_eq!(ops_item["queue"], 0);
    assert_eq!(ops_item["channels"][0], json!({ "kind": "slack", "account": "@ops-bot", "status": "connected" }));
    assert!(ops_item["channels"].as_array().unwrap().iter().any(|c| c["kind"] == "api"));

    // Enabling is kept in its config.
    let post = |path: &str, body: Value| {
        let request = client.post(format!("{url}{path}")).bearer_auth(TOKEN).json(&body);
        async move {
            let response = request.send().await.unwrap();
            (response.status().as_u16(), response.text().await.unwrap())
        }
    };
    assert_eq!(post("/v1/agent/bots/off/enable", json!({})).await.0, 200);
    assert!(autobot::bots::load(&root, "off").unwrap().enabled());
    let (status, body) = post("/v1/agent/bots/nope/disable", json!({})).await;
    assert_eq!(status, 404);
    assert!(body.contains("unknown_bot"));

    // A new conversation names its bot; it keeps it; an unknown bot is refused.
    let (status, stream) = post("/v1/agent/sessions/phone-7/turns", json!({ "text": "hi", "bot": "ops" })).await;
    assert_eq!(status, 200);
    assert!(stream.contains("from ops"), "{stream}");
    let (_, again) = post("/v1/agent/sessions/phone-7/turns", json!({ "text": "and?", "bot": "default" })).await;
    assert!(again.contains("(out of answers)"), "ops answered again: {again}");
    assert_eq!(ops_seen.lock().unwrap().len(), 2);
    let (status, body) = post("/v1/agent/sessions/phone-8/turns", json!({ "text": "hi", "bot": "nope" })).await;
    assert_eq!(status, 404);
    assert!(body.contains("\"code\":\"unknown_bot\""));
    let sessions = get("/v1/agent/sessions").await;
    assert_eq!(
        sessions["sessions"][0],
        json!({ "id": "phone-7", "modified": sessions["sessions"][0]["modified"], "bot": "ops" })
    );
    assert_eq!(get("/v1/agent/sessions?bot=default").await["sessions"], json!([]));
    let history = get("/v1/agent/sessions/phone-7").await;
    assert_eq!(history["messages"].as_array().unwrap().len(), 4, "found in ops' directory without ?bot");

    // Each bot's turns are in its own log: usage and insights by ?bot=.
    let usage = get("/v1/agent/usage?bot=ops&session=phone-7").await;
    assert_eq!((usage["bot"].as_str(), usage["today"]["turns"].as_u64()), (Some("ops"), Some(2)), "{usage}");
    assert_eq!(usage["session"]["turns"], 2);
    assert_eq!(get("/v1/agent/usage").await["today"]["turns"], 0, "the default bot ran no turn");
    assert!(ops.home.join("turns.jsonl").is_file() && !main.home.join("turns.jsonl").exists());
    let insights = get("/v1/agent/insights?bot=ops&days=1").await;
    assert_eq!((insights["bot"].as_str(), insights["turns"].as_u64()), (Some("ops"), Some(2)), "{insights}");
    assert_eq!(get("/v1/agent/usage?bot=nope").await["error"]["code"], "unknown_bot");
    std::fs::remove_dir_all(root).unwrap();
}

#[tokio::test]
async fn alerts_go_where_they_are_set_through_the_bot_with_that_channel() {
    let root = temp("alerts");
    let (main_home, ops_home) = (root.join("main"), root.join("ops"));
    let none = "http://127.0.0.1:9";
    let main = Runtime::standalone("main", &main_home, Arc::new(agent(none, &main_home, None)));
    let ops = Runtime::standalone("ops", &ops_home, Arc::new(agent(none, &ops_home, None)));
    let (telegram, slack) = (Recorder::new("telegram"), Recorder::new("slack"));
    main.register(telegram.clone());
    ops.register(slack.clone());
    let bots = vec![main.clone(), ops.clone()];

    // Nothing set: the default bot's home channel, else nowhere.
    let defaults = autobot::alerts::AlertsConfig::default();
    assert!(autobot::alerts::targets(&defaults, &bots).is_empty());
    main.set_home_channel("telegram:42").unwrap();
    assert_eq!(autobot::alerts::targets(&defaults, &bots), vec!["telegram:42".to_owned()]);

    let config: autobot::alerts::AlertsConfig = toml::from_str("to = [\"slack:C1\", \"telegram:7\"]").unwrap();
    let to = autobot::alerts::targets(&config, &bots);
    let sent = autobot::alerts::send(&bots, &to, "⚠️ The disk is low.").await;
    assert!(sent.iter().all(|(_, r)| r.is_ok()), "{sent:?}");
    assert_eq!(*slack.sent.lock().unwrap(), vec![("C1".to_owned(), "⚠️ The disk is low.".to_owned())]);
    assert_eq!(*telegram.sent.lock().unwrap(), vec![("7".to_owned(), "⚠️ The disk is low.".to_owned())]);
    let bad = autobot::alerts::send(&bots, &["pager".to_owned()], "x").await;
    assert!(bad[0].1.is_err());
    std::fs::remove_dir_all(root).unwrap();
}
