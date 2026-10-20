//! WhatsApp against a stand-in Graph API and a stand-in model: Meta's webhook check, signatures
//! required, a stranger gets a pairing code, the owner approves it, a task runs and its command
//! is approved with a reply button; a call delivered twice is taken in once.

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
use axum::http::{HeaderMap, StatusCode};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

const ACCESS: &str = "wa-access-token";
const APP_SECRET: &str = "the-app-secret-0123";
const VERIFY: &str = "verify-me-please";

async fn listen(app: axum::Router) -> String {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}", listener.local_addr().unwrap());
    tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    url
}

type Sent = Arc<Mutex<Vec<Value>>>;

/// The Graph API for the number 111: who it is, and the messages it is asked to send.
async fn graph(sent: Sent) -> String {
    let app = axum::Router::new()
        .route(
            "/111",
            axum::routing::get(|headers: HeaderMap| async move {
                if headers.get("authorization").and_then(|v| v.to_str().ok()) != Some(&format!("Bearer {ACCESS}")) {
                    return (
                        StatusCode::UNAUTHORIZED,
                        Json(json!({ "error": { "message": "Invalid OAuth access token" } })),
                    );
                }
                (
                    StatusCode::OK,
                    Json(json!({ "display_phone_number": "+1 555-0100", "verified_name": "Bot", "id": "111" })),
                )
            }),
        )
        .route(
            "/111/messages",
            axum::routing::post(|State(sent): State<Sent>, Json(body): Json<Value>| async move {
                sent.lock().unwrap().push(body);
                Json(json!({ "messaging_product": "whatsapp", "messages": [{ "id": "wamid.out" }] }))
            }),
        )
        .with_state(sent);
    listen(app).await
}

async fn model(answers: Vec<Value>) -> String {
    let answers = Arc::new(Mutex::new(VecDeque::from(answers)));
    listen(
        axum::Router::new()
            .route(
                "/v1/chat/completions",
                axum::routing::post(|State(a): State<Arc<Mutex<VecDeque<Value>>>>| async move {
                    let message =
                        a.lock().unwrap().pop_front().unwrap_or(json!({ "role": "assistant", "content": "(out)" }));
                    Json(json!({ "choices": [{ "message": message }] }))
                }),
            )
            .with_state(answers),
    )
    .await
}

fn hmac(key: &[u8], body: &[u8]) -> String {
    let mut block = [0u8; 64];
    block[..key.len()].copy_from_slice(key);
    let pad = |byte: u8| block.iter().map(|b| b ^ byte).collect::<Vec<u8>>();
    let inner = Sha256::new().chain_update(pad(0x36)).chain_update(body).finalize();
    let outer = Sha256::new().chain_update(pad(0x5c)).chain_update(inner).finalize();
    outer.iter().map(|b| format!("{b:02x}")).collect()
}

fn call(id: &str, message: Value) -> Value {
    let mut message = message;
    message["from"] = json!("15550001");
    message["id"] = json!(id);
    json!({ "object": "whatsapp_business_account", "entry": [{ "id": "W1", "changes": [{ "field": "messages", "value": {
        "messaging_product": "whatsapp",
        "metadata": { "display_phone_number": "15550100", "phone_number_id": "111" },
        "contacts": [{ "profile": { "name": "Ann" }, "wa_id": "15550001" }],
        "messages": [message],
    } }] }] })
}

async fn until_sent(sent: &Sent, what: &str, pred: impl Fn(&Value) -> bool) -> Value {
    for _ in 0..400 {
        if let Some(found) = sent.lock().unwrap().iter().find(|m| pred(m)).cloned() {
            return found;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    panic!("never sent {what}: {:#?}", sent.lock().unwrap());
}

fn text_of(message: &Value) -> &str {
    message["text"]["body"].as_str().or(message["interactive"]["body"]["text"].as_str()).unwrap_or("")
}

#[tokio::test]
async fn pairing_then_a_task_approved_with_a_button() {
    let home = std::env::temp_dir().join(format!("autobot-whatsapp-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&home);
    std::fs::create_dir_all(&home).unwrap();
    for (file, secret) in
        [("whatsapp.token", ACCESS), ("whatsapp-app.secret", APP_SECRET), ("whatsapp-verify.token", VERIFY)]
    {
        invincible::fsutil::replace_private(&home.join(file), &format!("{secret}\n")).unwrap();
    }
    let sent = Sent::default();
    let api = graph(sent.clone()).await;
    let url = model(vec![
        json!({ "role": "assistant", "content": "", "tool_calls": [{ "id": "c1", "type": "function",
            "function": { "name": "terminal", "arguments": "{\"command\":\"echo from-the-tool\"}" } }] }),
        json!({ "role": "assistant", "content": "**Done.**" }),
    ])
    .await;
    let config = autobot::config::Config::parse(&format!(
        "[whatsapp]\nenabled = true\nphone_number_id = \"111\"\napi = \"{api}\"\n[hooks]\nlisten = \"127.0.0.1:0\"\n"
    ))
    .unwrap();
    let def =
        autobot::bots::Def { name: "default".into(), root: home.clone(), home: home.clone(), config, default: true };
    let agent = Agent {
        gateway: Gateway::new(&format!("{url}/v1"), "t", "auto", true).unwrap(),
        tools: Tools::new(home.join("work"), Duration::from_secs(5)),
        approvals: ApprovalConfig { mode: ApprovalMode::Ask, allow: Vec::new() },
        max_steps: 5,
        team: Default::default(),
        mcp: Default::default(),
        trajectories: None,
        options: Default::default(),
    };
    let runtime = Runtime::new(&def, agent);
    let parts = autobot::bots::start(&runtime);
    for _ in 0..200 {
        if runtime.transport("whatsapp").is_some() {
            break;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    assert_eq!(runtime.accounts()["whatsapp"], "+1 555-0100");
    let bots: Arc<dyn autobot::bots::Find> = Arc::new(vec![runtime.clone()]);
    let hooks = listen(autobot::hooks::app(bots)).await;
    let client = reqwest::Client::new();
    let webhook = format!("{hooks}/hooks/whatsapp");

    // Meta's check when the webhook is added.
    let check = |token: &str| {
        let request = client.get(&webhook).query(&[
            ("hub.mode", "subscribe"),
            ("hub.verify_token", token),
            ("hub.challenge", "1158201444"),
        ]);
        async move {
            let response = request.send().await.unwrap();
            (response.status().as_u16(), response.text().await.unwrap())
        }
    };
    assert_eq!(check(VERIFY).await, (200, "1158201444".to_owned()));
    assert_eq!(check("guess").await.0, 403);

    let post = |body: Value, signature: Option<String>| {
        let bytes = serde_json::to_vec(&body).unwrap();
        let signature = signature.unwrap_or_else(|| format!("sha256={}", hmac(APP_SECRET.as_bytes(), &bytes)));
        let request = client
            .post(&webhook)
            .header("content-type", "application/json")
            .header("x-hub-signature-256", signature)
            .body(bytes);
        async move { request.send().await.unwrap().status().as_u16() }
    };
    let hello = call("wamid.1", json!({ "type": "text", "text": { "body": "hello?" } }));
    // Unsigned, or signed with something else: refused.
    let unsigned = client.post(&webhook).json(&hello).send().await.unwrap();
    assert_eq!(unsigned.status(), 401);
    assert_eq!(post(hello.clone(), Some(format!("sha256={}", hmac(b"another secret", b"{}")))).await, 401);

    // A stranger gets a code.
    assert_eq!(post(hello.clone(), None).await, 200);
    let pairing = until_sent(&sent, "a pairing code", |m| text_of(m).contains("approve")).await;
    assert_eq!(pairing["to"], "15550001");
    let code = autobot::pairing::Users::load(&home, "whatsapp").unwrap().pending[0].code.clone();
    assert!(text_of(&pairing).contains(&format!("autobot whatsapp approve {code}")));
    // The same call again (Meta retries): taken in once.
    assert_eq!(post(hello, None).await, 200);
    tokio::time::sleep(Duration::from_millis(200)).await;
    assert_eq!(sent.lock().unwrap().len(), 1);
    autobot::pairing::approve_in(&[home.as_path()], "whatsapp", &code).unwrap();

    // A task; its command asks with reply buttons; a press answers it.
    assert_eq!(post(call("wamid.2", json!({ "type": "text", "text": { "body": "run something" } })), None).await, 200);
    let question = until_sent(&sent, "the question", |m| m["type"] == "interactive").await;
    assert!(text_of(&question).contains("run: echo from-the-tool"));
    let buttons = question["interactive"]["action"]["buttons"].as_array().unwrap();
    assert_eq!(buttons.len(), 3);
    let once = buttons[0]["reply"]["id"].as_str().unwrap().to_owned();
    assert!(once.starts_with("once:"));
    let press = call(
        "wamid.3",
        json!({ "type": "interactive",
        "interactive": { "type": "button_reply", "button_reply": { "id": once, "title": "Allow" } } }),
    );
    assert_eq!(post(press, None).await, 200);
    until_sent(&sent, "the note", |m| text_of(m) == "→ Allowed").await;
    let answer = until_sent(&sent, "the answer", |m| text_of(m).starts_with("*Done.*")).await;
    assert_eq!(answer["type"], "text");
    for part in parts {
        part.abort();
    }
    std::fs::remove_dir_all(home).unwrap();
}

#[tokio::test]
async fn a_bad_token_keeps_whatsapp_off() {
    let home = std::env::temp_dir().join(format!("autobot-whatsapp-off-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&home);
    std::fs::create_dir_all(&home).unwrap();
    for (file, secret) in
        [("whatsapp.token", "wrong"), ("whatsapp-app.secret", APP_SECRET), ("whatsapp-verify.token", VERIFY)]
    {
        invincible::fsutil::replace_private(&home.join(file), secret).unwrap();
    }
    let api = graph(Sent::default()).await;
    let config = autobot::config::Config::parse(&format!(
        "[whatsapp]\nenabled = true\nphone_number_id = \"111\"\napi = \"{api}\"\n"
    ))
    .unwrap();
    let def =
        autobot::bots::Def { name: "default".into(), root: home.clone(), home: home.clone(), config, default: true };
    let agent = Agent {
        gateway: Gateway::new("http://127.0.0.1:9/v1", "t", "auto", true).unwrap(),
        tools: Tools::new(home.join("work"), Duration::from_secs(5)),
        approvals: ApprovalConfig { mode: ApprovalMode::Ask, allow: Vec::new() },
        max_steps: 5,
        team: Default::default(),
        mcp: Default::default(),
        trajectories: None,
        options: Default::default(),
    };
    let runtime = Runtime::new(&def, agent);
    let error = autobot::whatsapp::run(runtime.clone()).await.unwrap_err();
    assert!(error.contains("Invalid OAuth access token"), "{error}");
    // Not turned on: the webhook is not there.
    let off = Runtime::standalone("default", &home, runtime.agent());
    let bots: Arc<dyn autobot::bots::Find> = Arc::new(vec![off]);
    let hooks = listen(autobot::hooks::app(bots)).await;
    let status = reqwest::Client::new().get(format!("{hooks}/hooks/whatsapp")).send().await.unwrap().status();
    assert_eq!(status, 404);
    std::fs::remove_dir_all(home).unwrap();
}
