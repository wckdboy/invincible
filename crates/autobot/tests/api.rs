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
        tools: Tools::new(dir.join("work"), Duration::from_secs(5)).with_home(dir.clone()),
        approvals: ApprovalConfig { mode: ApprovalMode::Ask, allow: Vec::new() },
        max_steps: 5,
        team: Default::default(),
        mcp: Default::default(),
        trajectories: None,
        options: Default::default(),
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
                // The question is also listed, for a client that was not watching the stream.
                let waiting: Value =
                    client.get(&approvals).bearer_auth(TOKEN).send().await.unwrap().json().await.unwrap();
                let listed = &waiting["approvals"][0];
                assert_eq!(waiting["approvals"].as_array().unwrap().len(), 1, "{waiting}");
                assert_eq!((&listed["id"], &listed["session"]), (&event["id"], &json!("phone-1")));
                assert_eq!(listed["action"], event["action"]);
                assert!(listed["expires_at"].as_u64().unwrap() > listed["asked_at"].as_u64().unwrap());
                let url = format!("{approvals}/{}", event["id"].as_str().unwrap());
                let reply =
                    client.post(&url).bearer_auth(TOKEN).json(&json!({ "answer": "once" })).send().await.unwrap();
                assert_eq!(reply.status(), 200);
                // Answered once: a second answer finds nothing waiting.
                let again =
                    client.post(&url).bearer_auth(TOKEN).json(&json!({ "answer": "once" })).send().await.unwrap();
                assert_eq!(again.status(), 404);
                let waiting: Value =
                    client.get(&approvals).bearer_auth(TOKEN).send().await.unwrap().json().await.unwrap();
                assert_eq!(waiting["approvals"], json!([]), "answered: no longer listed");
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
    let reset = client
        .post(format!("{gateway}/v1/agent/sessions/phone-1/reset"))
        .bearer_auth(TOKEN)
        .header("content-type", "application/json")
        .send()
        .await
        .unwrap();
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

    // The action log has the command, approved on the app.
    let get = async |path: &str| -> Value {
        client.get(format!("{gateway}{path}")).bearer_auth(TOKEN).send().await.unwrap().json().await.unwrap()
    };
    let actions = get("/v1/agent/actions").await;
    assert_eq!(actions["actions"].as_array().unwrap().len(), 1);
    let action = &actions["actions"][0];
    assert_eq!(action["session"], "phone-1");
    assert_eq!(action["kind"], "command");
    assert_eq!(action["action"], "run: echo hi > out.txt");
    assert_eq!((action["ran"].clone(), action["by"].clone()), (json!(true), json!("app")));

    // Memory and skills, as the app shows them.
    autobot::memory::Memory::new(&dir).add("Backups run at 02:00.").unwrap();
    std::fs::create_dir_all(dir.join("skills")).unwrap();
    std::fs::write(dir.join("skills/deploy.md"), "# Deploy the site\n1. git pull").unwrap();
    assert_eq!(get("/v1/agent/memory").await["facts"][0]["text"], "Backups run at 02:00.");
    assert_eq!(
        get("/v1/agent/skills").await["skills"],
        json!([{ "name": "deploy", "description": "Deploy the site", "allowed_tools": [], "files": [] }])
    );
    let forget = client.delete(format!("{gateway}/v1/agent/memory/1")).bearer_auth(TOKEN).send().await.unwrap();
    assert_eq!(forget.status(), 200);
    assert_eq!(get("/v1/agent/memory").await["facts"], json!([]));
    let again = client.delete(format!("{gateway}/v1/agent/memory/1")).bearer_auth(TOKEN).send().await.unwrap();
    assert_eq!(again.status(), 404);
}

#[tokio::test]
async fn the_token_is_required_on_both_sides() {
    let (gateway, agent, _) = stack("token", Vec::new(), Duration::ZERO).await;
    let client = reqwest::Client::new();
    assert_eq!(client.get(format!("{gateway}/v1/agent")).send().await.unwrap().status(), 401);
    assert_eq!(client.get(format!("{agent}/v1/agent")).send().await.unwrap().status(), 401);
    assert_eq!(client.get(format!("{agent}/v1/agent")).bearer_auth("wrong").send().await.unwrap().status(), 401);
    assert_eq!(client.get(format!("{agent}/v1/agent")).bearer_auth(TOKEN).send().await.unwrap().status(), 200);
    // Health needs none, and says only that it answers and its version.
    for side in [&gateway, &agent] {
        let root = side.trim_end_matches("/v1");
        let health: Value = client.get(format!("{root}/healthz")).send().await.unwrap().json().await.unwrap();
        assert_eq!(health, json!({ "status": "ok", "version": invincible::version::VERSION }), "{side}");
    }
    // What the agent's watch on the gateway asks.
    let root = gateway.trim_end_matches("/v1");
    assert!(Gateway::new(&format!("{root}/v1"), TOKEN, "auto", true).unwrap().healthy().await);
    assert!(!Gateway::new("http://127.0.0.1:9/v1", TOKEN, "auto", true).unwrap().healthy().await);
}

#[tokio::test]
async fn a_busy_session_and_bad_ids_are_refused() {
    let slow = json!({ "role": "assistant", "content": "slow" });
    let (gateway, agent, _) = stack("busy", vec![slow], Duration::from_millis(500)).await;
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
    // The gateway refuses it before the agent sees it.
    assert_eq!(bad.status(), 404);
    let direct = client
        .post(format!("{agent}/v1/agent/sessions/bad.id/turns"))
        .bearer_auth(TOKEN)
        .json(&json!({ "text": "a" }))
        .send()
        .await
        .unwrap();
    assert_eq!(direct.status(), 400);
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
    let bad =
        client.post(&url).bearer_auth(TOKEN).json(&json!({ "when": "0 99 * * *", "task": "x" })).send().await.unwrap();
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

#[tokio::test]
async fn a_recipe_is_handed_over_run_now_and_its_runs_collected() {
    let (gateway, _, dir) =
        stack("recipe", vec![json!({ "role": "assistant", "content": "Disk is 41% full." })], Duration::ZERO).await;
    let client = reqwest::Client::new();
    let recipe = json!({
        "id": "r-disk", "name": "Disk check", "when": "0 7 * * *", "task": "check the disk",
        "tools": ["files-read"], "enabled": true,
    });
    let put: Value = client
        .post(format!("{gateway}/v1/agent/schedules"))
        .bearer_auth(TOKEN)
        .json(&recipe)
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(put["id"], "r-disk");
    let list: Value = client
        .get(format!("{gateway}/v1/agent/schedules"))
        .bearer_auth(TOKEN)
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let item = &list["schedules"][0];
    assert_eq!((item["name"].clone(), item["tools"].clone()), (json!("Disk check"), json!(["files-read"])));
    // From the loopback API: no device origin.
    assert!(item.get("origin").is_none());

    let started = client
        .post(format!("{gateway}/v1/agent/schedules/r-disk/run"))
        .bearer_auth(TOKEN)
        .header("content-type", "application/json")
        .send()
        .await
        .unwrap();
    assert_eq!(started.status(), 202);
    let mut runs = Value::Null;
    for _ in 0..100 {
        runs = client
            .get(format!("{gateway}/v1/agent/schedules/r-disk/runs?after=0"))
            .bearer_auth(TOKEN)
            .send()
            .await
            .unwrap()
            .json()
            .await
            .unwrap();
        if !runs["runs"].as_array().unwrap().is_empty() {
            break;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    let run = &runs["runs"][0];
    assert_eq!(run["result"], "Disk is 41% full.");
    assert_eq!(run["trigger"], "manual");
    assert_eq!(run["receipts"], json!(["r1"]));
    let at = run["at"].as_i64().unwrap();
    let later: Value = client
        .get(format!("{gateway}/v1/agent/schedules/r-disk/runs?after={at}"))
        .bearer_auth(TOKEN)
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(later["runs"], json!([]));
    let missing = client
        .post(format!("{gateway}/v1/agent/schedules/nope/run"))
        .bearer_auth(TOKEN)
        .header("content-type", "application/json")
        .send()
        .await
        .unwrap();
    assert_eq!(missing.status(), 404);
    // Not JSON (a form, a no-cors fetch): refused.
    let form = client
        .post(format!("{gateway}/v1/agent/schedules"))
        .bearer_auth(TOKEN)
        .header("content-type", "text/plain")
        .body(r#"{"when":"every 1m","task":"x"}"#)
        .send()
        .await
        .unwrap();
    assert_eq!(form.status(), 415);
    assert!(dir.join("runs/r-disk.jsonl").exists());
}

#[tokio::test]
async fn an_approval_answered_with_what_to_do_instead() {
    let (gateway, _, _dir) = stack(
        "instead",
        vec![
            json!({ "role": "assistant", "content": "", "tool_calls": [{ "id": "c1", "type": "function",
                "function": { "name": "terminal", "arguments": "{\"command\":\"rm -rf build\"}" } }] }),
            json!({ "role": "assistant", "content": "Left build alone." }),
        ],
        Duration::ZERO,
    )
    .await;
    let client = reqwest::Client::new();
    let approvals = format!("{gateway}/v1/agent/approvals");
    let events =
        turn(&client, &format!("{gateway}/v1/agent/sessions/phone-2/turns"), "clean up", async |event: &Value| {
            if event["type"] == "approval" {
                let url = format!("{approvals}/{}", event["id"].as_str().unwrap());
                let empty =
                    client.post(&url).bearer_auth(TOKEN).json(&json!({ "answer": "instead" })).send().await.unwrap();
                assert_eq!(empty.status(), 400, "instead needs a text");
                let reply = client
                    .post(&url)
                    .bearer_auth(TOKEN)
                    .json(&json!({ "answer": "instead", "text": "only delete build/tmp" }))
                    .send()
                    .await
                    .unwrap();
                assert_eq!(reply.status(), 200);
            }
        })
        .await;
    assert_eq!(events.last().unwrap()["text"], "Left build alone.");
    let actions: Value = client
        .get(format!("{gateway}/v1/agent/actions"))
        .bearer_auth(TOKEN)
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(actions["actions"][0]["ran"], json!(false), "{actions}");
}

#[tokio::test]
async fn retry_personalities_profile_usage_and_insights() {
    let (gateway, _, dir) = stack(
        "parity",
        vec![
            json!({ "role": "assistant", "content": "First answer." }),
            json!({ "role": "assistant", "content": "Second answer." }),
        ],
        Duration::ZERO,
    )
    .await;
    let client = reqwest::Client::new();
    let get = async |path: &str| -> Value {
        client.get(format!("{gateway}{path}")).bearer_auth(TOKEN).send().await.unwrap().json().await.unwrap()
    };
    let events = turn(&client, &format!("{gateway}/v1/agent/sessions/p1/turns"), "say something", async |_| {}).await;
    assert_eq!(events.last().unwrap()["text"], "First answer.");
    // Retry: the last answer goes, the same request runs again.
    let response = client
        .post(format!("{gateway}/v1/agent/sessions/p1/retry"))
        .bearer_auth(TOKEN)
        .json(&json!({}))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), 200);
    let body = response.text().await.unwrap();
    assert!(body.contains("Second answer."), "{body}");
    let history = get("/v1/agent/sessions/p1").await;
    let messages = history["messages"].as_array().unwrap();
    assert_eq!(messages.len(), 2, "{messages:?}");
    assert_eq!(messages[0]["content"], "say something");
    assert_eq!(messages[1]["content"], "Second answer.");
    let none = client
        .post(format!("{gateway}/v1/agent/sessions/empty/retry"))
        .bearer_auth(TOKEN)
        .json(&json!({}))
        .send()
        .await
        .unwrap();
    assert_eq!(none.status(), 404);

    // Personalities: listed, one set for every turn, a bad one refused.
    let list = get("/v1/agent/personalities").await;
    assert!(list["active"].is_null());
    assert!(list["personalities"].as_array().unwrap().iter().any(|p| p["name"] == "concise" && p["builtin"] == true));
    let set = |name: Value| {
        let client = client.clone();
        let url = format!("{gateway}/v1/agent/personality");
        async move { client.post(url).bearer_auth(TOKEN).json(&json!({ "name": name })).send().await.unwrap() }
    };
    assert_eq!(set(json!("teacher")).await.status(), 200);
    assert_eq!(autobot::personality::active(&dir).as_deref(), Some("teacher"));
    assert_eq!(set(json!("nope")).await.status(), 400);
    assert_eq!(set(Value::Null).await.status(), 200);
    assert!(autobot::personality::active(&dir).is_none());
    let bad = client
        .post(format!("{gateway}/v1/agent/sessions/p2/turns"))
        .bearer_auth(TOKEN)
        .json(&json!({ "text": "hi", "personality": "nope" }))
        .send()
        .await
        .unwrap();
    assert_eq!(bad.status(), 400);

    autobot::profile::update(&dir, &autobot::profile::Change::Add("Likes tables".into())).unwrap();
    assert_eq!(get("/v1/agent/profile").await["entries"], json!(["Likes tables"]));
    let usage = get("/v1/agent/usage?session=p1").await;
    assert_eq!(usage["today"]["turns"], 2);
    assert_eq!(usage["session"]["turns"], 2);
    let insights = get("/v1/agent/insights?days=1").await;
    assert_eq!(insights["turns"], 2);
    assert_eq!(insights["local_share"]["calls"], 1.0);
}

/// A model server that knows which models see: `/v1/models` says so, and each chat call is
/// recorded and answered with [answer] (a status and its body).
async fn seeing_model(answer: (u16, Value)) -> (String, Arc<Mutex<Vec<Value>>>) {
    let asked: Arc<Mutex<Vec<Value>>> = Arc::default();
    let record = asked.clone();
    let url = listen(
        axum::Router::new()
            .route(
                "/v1/models",
                axum::routing::get(|| async {
                    Json(json!({ "data": [
                        { "id": "seer", "invincible": { "tier": "node", "vision": true } },
                        { "id": "blind", "invincible": { "tier": "node", "vision": false } },
                    ] }))
                }),
            )
            .route(
                "/v1/chat/completions",
                axum::routing::post(move |Json(body): Json<Value>| {
                    let (record, answer) = (record.clone(), answer.clone());
                    async move {
                        record.lock().unwrap().push(body);
                        let status = axum::http::StatusCode::from_u16(answer.0).unwrap();
                        (status, [("invincible-request-id", "r1")], Json(answer.1))
                    }
                }),
            )
            .layer(axum::extract::DefaultBodyLimit::max(64 << 20)),
    )
    .await;
    (url, asked)
}

/// The agent on [model] (answering [answer]) behind a gateway: the gateway's URL, the model's
/// calls, the agent's home.
async fn vision_stack(
    name: &str,
    model: &str,
    answer: (u16, Value),
) -> (String, Arc<Mutex<Vec<Value>>>, std::path::PathBuf) {
    let dir = temp(name);
    let (url, asked) = seeing_model(answer).await;
    let agent = Arc::new(Agent {
        gateway: Gateway::new(&format!("{url}/v1"), TOKEN, model, true).unwrap(),
        tools: Tools::new(dir.join("work"), Duration::from_secs(5)).with_home(dir.clone()),
        approvals: ApprovalConfig { mode: ApprovalMode::Ask, allow: Vec::new() },
        max_steps: 5,
        team: Default::default(),
        mcp: Default::default(),
        trajectories: None,
        options: Default::default(),
    });
    let info = json!({ "name": "Autobot", "approvals": "ask" });
    let agent_url = listen(app(Arc::new(ApiState::new(agent, TOKEN.into(), dir.clone(), info)))).await;
    let settings = NodeSettings { network: NetworkMode::Offline, egress: Egress::Never };
    let gateway =
        invincible::server::app(Arc::new(AppState::new(Vec::new(), settings, TOKEN.into()).with_agent(&agent_url)));
    (listen(gateway).await, asked, dir)
}

/// A PNG of [side]² pixels of noise (it does not compress: about 3 bytes a pixel).
fn noise_png(side: u32) -> Vec<u8> {
    let mut seed: u32 = 0x9E37_79B9;
    let picture = image::RgbImage::from_fn(side, side, |_, _| {
        seed ^= seed << 13;
        seed ^= seed >> 17;
        seed ^= seed << 5;
        image::Rgb([seed as u8, (seed >> 8) as u8, (seed >> 16) as u8])
    });
    let mut out = std::io::Cursor::new(Vec::new());
    picture.write_to(&mut out, image::ImageFormat::Png).unwrap();
    out.into_inner()
}

fn image_part(bytes: &[u8], mime: &str) -> Value {
    use base64::Engine as _;
    let data = base64::engine::general_purpose::STANDARD.encode(bytes);
    json!({ "type": "image_url", "image_url": { "url": format!("data:{mime};base64,{data}") } })
}

#[tokio::test]
async fn a_turn_with_images_reaches_a_model_that_sees() {
    let answer = json!({ "choices": [{ "message": { "role": "assistant", "content": "Noise, mostly." } }] });
    let (gateway, asked, dir) = vision_stack("images", "seer", (200, answer)).await;
    let client = reqwest::Client::new();
    let png = noise_png(700);
    assert!(png.len() > 1 << 20, "larger than the gateway's usual 1 MiB: {}", png.len());
    let url = format!("{gateway}/v1/agent/sessions/i1/turns");
    let response = client
        .post(&url)
        .bearer_auth(TOKEN)
        .json(&json!({ "text": "what is this?", "images": [image_part(&png, "image/png")] }))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), 200);
    let body = response.text().await.unwrap();
    assert!(body.contains("Noise, mostly."), "{body}");
    // The model got the text and the image as parts; the session keeps a reference to the file.
    let call = asked.lock().unwrap()[0].clone();
    let last = call["messages"].as_array().unwrap().last().unwrap().clone();
    assert_eq!(last["content"][0], json!({ "type": "text", "text": "what is this?" }));
    assert_eq!(last["content"][1]["type"], "image_url");
    assert!(last["content"][1]["image_url"]["url"].as_str().unwrap().starts_with("data:image/png;base64,"));
    let history: Value = client
        .get(format!("{gateway}/v1/agent/sessions/i1"))
        .bearer_auth(TOKEN)
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let kept = history["messages"][0]["autobot_images"][0]["path"].as_str().unwrap().to_owned();
    assert!(kept.contains("attachments") && std::path::Path::new(&kept).exists(), "{kept}");

    // Too many, not an image, not a data: URL: refused before the turn.
    let tiny = image_part(&noise_png(4), "image/png");
    let attachments = std::path::Path::new(&kept).parent().unwrap().to_owned();
    let files = || std::fs::read_dir(&attachments).unwrap().count();
    let before = files();
    for (images, says) in [
        (json!(vec![tiny.clone(); 5]), "at most 4 images"),
        (json!([image_part(b"not a picture", "image/png")]), "not a PNG"),
        // A good one, then a bad one: neither is kept.
        (json!([tiny.clone(), image_part(b"not a picture", "image/png")]), "not a PNG"),
        (json!([{ "type": "image_url", "image_url": { "url": "https://example.org/x.png" } }]), "data: URL"),
    ] {
        let response =
            client.post(&url).bearer_auth(TOKEN).json(&json!({ "text": "x", "images": images })).send().await.unwrap();
        assert_eq!(response.status(), 400);
        let error: Value = response.json().await.unwrap();
        assert!(error["error"]["message"].as_str().unwrap().contains(says), "{error}");
    }
    assert_eq!(files(), before, "a refused turn leaves no files");
    assert_eq!(asked.lock().unwrap().len(), 1);
    std::fs::remove_dir_all(dir).unwrap();
}

#[tokio::test]
async fn a_model_that_cannot_see_is_said_so_before_or_during_the_turn() {
    let answer = json!({ "choices": [{ "message": { "role": "assistant", "content": "never" } }] });
    let (gateway, asked, dir) = vision_stack("blind", "blind", (200, answer)).await;
    let client = reqwest::Client::new();
    let tiny = image_part(&noise_png(4), "image/png");
    let response = client
        .post(format!("{gateway}/v1/agent/sessions/b1/turns"))
        .bearer_auth(TOKEN)
        .json(&json!({ "text": "look", "images": [tiny.clone()] }))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), 400);
    let error: Value = response.json().await.unwrap();
    assert_eq!(error["error"]["code"], "model_cannot_see_images");
    assert!(asked.lock().unwrap().is_empty());
    std::fs::remove_dir_all(dir).unwrap();

    // Not known before (the router picks): the model's refusal comes as an `error` event.
    let refusal =
        json!({ "error": { "message": "this model does not support image input", "type": "invalid_request_error" } });
    let (gateway, _, dir) = vision_stack("late", "unlisted", (400, refusal)).await;
    let response = client
        .post(format!("{gateway}/v1/agent/sessions/b2/turns"))
        .bearer_auth(TOKEN)
        .json(&json!({ "text": "look", "images": [tiny] }))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), 200);
    let body = response.text().await.unwrap();
    let last: Value =
        serde_json::from_str(body.trim().lines().last().unwrap().strip_prefix("data: ").unwrap()).unwrap();
    assert_eq!(
        (last["type"].as_str(), last["code"].as_str()),
        (Some("error"), Some("model_cannot_see_images")),
        "{body}"
    );
    std::fs::remove_dir_all(dir).unwrap();
}
