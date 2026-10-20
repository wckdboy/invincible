//! The Telegram channel against a stand-in Bot API and a stand-in gateway: a stranger gets a
//! pairing code, the owner approves it, a task runs, and a tool is approved by button, by the
//! right person only.

use std::collections::VecDeque;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use autobot::agent::Agent;
use autobot::config::{ApprovalConfig, ApprovalMode};
use autobot::gateway::Gateway;
use autobot::telegram::{Bot, Bots, Users, serve};
use autobot::tools::Tools;
use axum::Json;
use axum::extract::{Path, State};
use serde_json::{Value, json};

#[derive(Default)]
struct Telegram {
    updates: VecDeque<Value>,
    /// (method, body) of every call but getUpdates.
    calls: Vec<(String, Value)>,
    next_id: i64,
}

type Shared = Arc<Mutex<Telegram>>;

async fn bot_api(
    State(t): State<Shared>,
    Path((bot, method)): Path<(String, String)>,
    Json(body): Json<Value>,
) -> Json<Value> {
    if method == "getUpdates" {
        assert_eq!(bot, "botTOKEN", "only the main bot polls");
        for _ in 0..20 {
            let next = t.lock().unwrap().updates.pop_front();
            if let Some(update) = next {
                return Json(json!({ "ok": true, "result": [update] }));
            }
            tokio::time::sleep(Duration::from_millis(25)).await;
        }
        return Json(json!({ "ok": true, "result": [] }));
    }
    if method == "getFile" {
        assert_eq!(body["file_id"], "VOICE1");
        return Json(
            json!({ "ok": true, "result": { "file_id": "VOICE1", "file_path": "voice/file_1.oga", "file_size": 7 } }),
        );
    }
    let mut t = t.lock().unwrap();
    t.next_id += 1;
    let id = t.next_id;
    if method != "sendChatAction" {
        // Which bot sent it.
        let mut body = body.clone();
        body["_bot"] = json!(bot);
        t.calls.push((method, body));
    }
    Json(json!({ "ok": true, "result": { "message_id": id, "chat": body["chat_id"], "text": body["text"] } }))
}

async fn listen(app: axum::Router) -> String {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}", listener.local_addr().unwrap());
    tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    url
}

fn message(update: i64, from: i64, text: &str) -> Value {
    json!({ "update_id": update, "message": {
        "message_id": update,
        "from": { "id": from, "first_name": "Ann", "username": "ann" },
        "chat": { "id": from, "type": "private" },
        "text": text,
    } })
}

/// Waits until a sent message matches [pred]; returns it.
async fn sent(t: &Shared, pred: impl Fn(&str, &Value) -> bool) -> Value {
    for _ in 0..400 {
        if let Some((_, body)) = t.lock().unwrap().calls.iter().find(|(m, b)| pred(m, b)) {
            return body.clone();
        }
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
    panic!("never sent; calls: {:#?}", t.lock().unwrap().calls);
}

#[tokio::test]
async fn pairing_then_a_task_with_an_approval_by_button() {
    let home = std::env::temp_dir().join(format!("autobot-tg-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&home);
    std::fs::create_dir_all(&home).unwrap();

    let gateway_answers = Arc::new(Mutex::new(VecDeque::from([
        json!({ "role": "assistant", "content": "", "tool_calls": [{ "id": "c1", "type": "function",
            "function": { "name": "terminal", "arguments": "{\"command\":\"echo from-the-tool\"}" } }] }),
        json!({ "role": "assistant", "content": "All done." }),
    ])));
    let gateway_url = listen(
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
            .with_state(gateway_answers),
    )
    .await;

    let telegram: Shared = Arc::default();
    let api =
        listen(axum::Router::new().route("/{bot}/{method}", axum::routing::post(bot_api)).with_state(telegram.clone()))
            .await;
    let agent = Arc::new(Agent {
        gateway: Gateway::new(&format!("{gateway_url}/v1"), "t", "auto", true).unwrap(),
        tools: Tools::new(home.join("work"), Duration::from_secs(5)),
        approvals: ApprovalConfig { mode: ApprovalMode::Ask, allow: Vec::new() },
        max_steps: 5,
        team: Default::default(),
        mcp: Default::default(),
        trajectories: None,
        options: Default::default(),
    });
    let bot = Bot::new(reqwest::Client::new(), &api, "TOKEN").unwrap();
    let bots = Arc::new(Bots { username: "test_bot".into(), members: Default::default() });
    tokio::spawn(serve(bot, bots, agent, home.clone()));

    // A stranger gets a code, and nothing else.
    telegram.lock().unwrap().updates.push_back(message(1, 7, "hello?"));
    let reply = sent(&telegram, |m, b| m == "sendMessage" && b["text"].as_str().unwrap().contains("approve")).await;
    let mut users = Users::load(&home).unwrap();
    let code = users.pending[0].code.clone();
    assert!(reply["text"].as_str().unwrap().contains(&format!("autobot telegram approve {code}")));
    assert!(!users.allows(7));

    // The owner approves on the machine; the bot sees it on the next message, without a restart.
    users.approve(&code).unwrap();
    users.save(&home).unwrap();
    telegram.lock().unwrap().updates.push_back(message(2, 7, "run something"));
    let question = sent(&telegram, |_, b| b.get("reply_markup").is_some()).await;
    assert!(question["text"].as_str().unwrap().contains("run: echo from-the-tool"));
    let buttons = &question["reply_markup"]["inline_keyboard"][0];
    let allow = buttons[0]["callback_data"].as_str().unwrap().to_owned();

    // Someone else's tap does not count.
    telegram.lock().unwrap().updates.push_back(json!({ "update_id": 3, "callback_query": {
        "id": "q1", "from": { "id": 8 }, "data": allow, "message": { "message_id": 99, "chat": { "id": 8 }, "text": "x" } } }));
    let expired = sent(&telegram, |m, b| m == "answerCallbackQuery" && b["callback_query_id"] == "q1").await;
    assert_eq!(expired["text"], "This question has expired");

    // The owner's tap does.
    telegram.lock().unwrap().updates.push_back(json!({ "update_id": 4, "callback_query": {
        "id": "q2", "from": { "id": 7 }, "data": allow, "message": { "message_id": 5, "chat": { "id": 7 }, "text": "Approve? run: echo from-the-tool" } } }));
    let answer =
        sent(&telegram, |m, b| m == "sendMessage" && b["text"].as_str().unwrap().starts_with("All done.")).await;
    assert_eq!(answer["text"], "All done.\n\n— qwen · node · receipt abcdef12");
    let calls = telegram.lock().unwrap().calls.clone();
    assert!(calls.iter().any(|(m, b)| m == "answerCallbackQuery" && b["text"] == "Allowed"));
    assert!(calls.iter().any(|(m, b)| m == "sendMessage" && b["text"] == "› run: echo from-the-tool"));
    assert!(calls.iter().any(|(m, b)| m == "editMessageText" && b["text"].as_str().unwrap().ends_with("→ Allowed")));
    std::fs::remove_dir_all(home).unwrap();
}

fn group_message(update: i64, from: i64, text: &str) -> Value {
    json!({ "update_id": update, "message": {
        "message_id": update,
        "from": { "id": from, "first_name": "Ann", "username": "ann" },
        "chat": { "id": -1001, "type": "supergroup", "title": "Team" },
        "text": text,
    } })
}

#[tokio::test]
async fn a_team_works_in_a_group_each_member_on_its_own_bot() {
    let home = std::env::temp_dir().join(format!("autobot-tg-team-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&home);
    std::fs::create_dir_all(&home).unwrap();
    let mut users = Users::load(&home).unwrap();
    users.code_for(&autobot::telegram::User { id: 7, name: "@ann".into() }).unwrap();
    let code = users.pending[0].code.clone();
    users.approve(&code).unwrap();
    users.save(&home).unwrap();

    let gateway_answers = Arc::new(Mutex::new(VecDeque::from([
        json!({ "role": "assistant", "content": "", "tool_calls": [{ "id": "c1", "type": "function",
            "function": { "name": "delegate", "arguments": "{\"agent\":\"researcher\",\"goal\":\"Find the status\"}" } }] }),
        json!({ "role": "assistant", "content": "Status: kernel in progress." }),
        json!({ "role": "assistant", "content": "The kernel is in progress." }),
    ])));
    let gateway_url = listen(
        axum::Router::new()
            .route(
                "/v1/chat/completions",
                axum::routing::post(|State(a): State<Arc<Mutex<VecDeque<Value>>>>| async move {
                    let message = a.lock().unwrap().pop_front().unwrap();
                    Json(json!({ "choices": [{ "message": message }] }))
                }),
            )
            .with_state(gateway_answers),
    )
    .await;
    let telegram: Shared = Arc::default();
    let api =
        listen(axum::Router::new().route("/{bot}/{method}", axum::routing::post(bot_api)).with_state(telegram.clone()))
            .await;
    let roles = std::collections::BTreeMap::from([(
        "researcher".to_owned(),
        autobot::team::RoleConfig {
            description: "Reads and reports".into(),
            instructions: None,
            tools: vec!["files-read".into()],
            model: None,
            telegram_token_file: None,
        },
    )]);
    let agent = Arc::new(Agent {
        gateway: Gateway::new(&format!("{gateway_url}/v1"), "t", "auto", true).unwrap(),
        tools: Tools::new(home.join("work"), Duration::from_secs(5)).with_home(home.clone()),
        approvals: ApprovalConfig { mode: ApprovalMode::Ask, allow: Vec::new() },
        max_steps: 5,
        team: Arc::new(autobot::team::Team::from_config(&roles, &Default::default()).unwrap()),
        mcp: Default::default(),
        trajectories: None,
        options: Default::default(),
    });
    let bot = Bot::new(reqwest::Client::new(), &api, "TOKEN").unwrap();
    let members = std::collections::HashMap::from([(
        "researcher".to_owned(),
        Bot::new(reqwest::Client::new(), &api, "MEMBER").unwrap(),
    )]);
    let bots = Arc::new(Bots { username: "test_bot".into(), members });
    tokio::spawn(serve(bot, bots, agent, home.clone()));

    // Not addressed to the bot: ignored. A stranger in the group: ignored too, no code.
    telegram.lock().unwrap().updates.push_back(group_message(1, 7, "lunch at noon?"));
    telegram.lock().unwrap().updates.push_back(group_message(2, 9, "@test_bot let me in"));
    // Addressed: the lead hands it to the researcher, who posts as its own bot.
    telegram.lock().unwrap().updates.push_back(group_message(3, 7, "@test_bot what is the status?"));
    let done = sent(&telegram, |m, b| {
        m == "sendMessage" && b["text"].as_str().unwrap().starts_with("The kernel is in progress.")
    })
    .await;
    assert_eq!(done["_bot"], "botTOKEN");
    assert_eq!(done["chat_id"], -1001);
    let calls = telegram.lock().unwrap().calls.clone();
    let by = |bot: &str| -> Vec<String> {
        calls
            .iter()
            .filter(|(m, b)| m == "sendMessage" && b["_bot"] == bot)
            .map(|(_, b)| b["text"].as_str().unwrap().to_owned())
            .collect()
    };
    assert_eq!(by("botMEMBER"), ["› ← Find the status", "→ Status: kernel in progress."]);
    assert!(by("botTOKEN").iter().all(|t| !t.contains("lunch") && !t.contains("approve")), "{:?}", by("botTOKEN"));
    assert_eq!(by("botTOKEN").len(), 1, "only the lead's answer: {:?}", by("botTOKEN"));
    std::fs::remove_dir_all(home).unwrap();
}

#[tokio::test]
async fn a_voice_note_is_heard_and_answered() {
    let home = std::env::temp_dir().join(format!("autobot-tg-voice-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&home);
    std::fs::create_dir_all(&home).unwrap();
    let mut users = Users::load(&home).unwrap();
    users.code_for(&autobot::telegram::User { id: 7, name: "@ann".into() }).unwrap();
    let code = users.pending[0].code.clone();
    users.approve(&code).unwrap();
    users.save(&home).unwrap();

    // The model sees the transcript as the owner's words.
    let asked: Arc<Mutex<Vec<Value>>> = Arc::default();
    let gateway_url = listen(
        axum::Router::new()
            .route(
                "/v1/chat/completions",
                axum::routing::post(|State(asked): State<Arc<Mutex<Vec<Value>>>>, Json(body): Json<Value>| async move {
                    asked.lock().unwrap().push(body);
                    Json(json!({ "choices": [{ "message": { "role": "assistant", "content": "The disk is fine." } }] }))
                }),
            )
            .with_state(asked.clone()),
    )
    .await;
    let telegram: Shared = Arc::default();
    let api = listen(
        axum::Router::new()
            .route("/{bot}/{method}", axum::routing::post(bot_api))
            .route(
                "/file/{bot}/{*path}",
                axum::routing::get(|Path((bot, path)): Path<(String, String)>| async move {
                    assert_eq!((bot.as_str(), path.as_str()), ("botTOKEN", "voice/file_1.oga"));
                    &b"OggS..."[..]
                }),
            )
            .with_state(telegram.clone()),
    )
    .await;
    // Speech-to-text on this machine.
    let stt = listen(axum::Router::new().route(
        "/v1/audio/transcriptions",
        axum::routing::post(|body: axum::body::Bytes| async move {
            assert!(String::from_utf8_lossy(&body).contains("OggS..."));
            Json(json!({ "text": "how full is the disk" }))
        }),
    ))
    .await;
    let config = autobot::config::Config::parse(&format!("[voice]\nurl = \"{stt}/v1/audio/transcriptions\"")).unwrap();
    let def =
        autobot::bots::Def { name: "default".into(), root: home.clone(), home: home.clone(), config, default: true };
    let agent = Agent {
        gateway: Gateway::new(&format!("{gateway_url}/v1"), "t", "auto", true).unwrap(),
        tools: Tools::new(home.join("work"), Duration::from_secs(5)),
        approvals: ApprovalConfig { mode: ApprovalMode::Ask, allow: Vec::new() },
        max_steps: 5,
        team: Default::default(),
        mcp: Default::default(),
        trajectories: None,
        options: Default::default(),
    };
    let runtime = autobot::bots::Runtime::new(&def, agent);
    let bot = Bot::new(reqwest::Client::new(), &api, "TOKEN").unwrap();
    let bots = Arc::new(Bots { username: "test_bot".into(), members: Default::default() });
    tokio::spawn(autobot::telegram::serve_bot(bot, bots, runtime));

    telegram.lock().unwrap().updates.push_back(json!({ "update_id": 1, "message": {
        "message_id": 1, "from": { "id": 7, "first_name": "Ann" }, "chat": { "id": 7, "type": "private" },
        "voice": { "file_id": "VOICE1", "mime_type": "audio/ogg", "duration": 2 },
    } }));
    let heard = sent(&telegram, |m, b| m == "sendMessage" && b["text"].as_str().unwrap().starts_with("heard:")).await;
    assert_eq!(heard["text"], "heard: \"how full is the disk\"");
    sent(&telegram, |m, b| m == "sendMessage" && b["text"] == "The disk is fine.").await;
    let asked = asked.lock().unwrap();
    assert_eq!(asked[0]["messages"].as_array().unwrap().last().unwrap()["content"], "how full is the disk");
    drop(asked);
    std::fs::remove_dir_all(home).unwrap();
}
