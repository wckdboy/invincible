//! Home Assistant against a stand-in server: the `home` tool reads without asking and asks
//! before it changes anything (allowlisted services run unattended, others are refused), only
//! the entities allowed are seen, the token must be private; and Home Assistant's conversation
//! agent talks to a bot through the OpenAI-compatible endpoints.

use std::collections::VecDeque;
use std::future::Future;
use std::pin::Pin;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use autobot::agent::Agent;
use autobot::approval::{Action, Answer, Approver};
use autobot::bots::Runtime;
use autobot::config::{ApprovalConfig, ApprovalMode};
use autobot::gateway::Gateway;
use autobot::homeassistant::Home;
use autobot::tools::Tools;
use axum::Json;
use axum::extract::{Path, State};
use axum::http::{HeaderMap, StatusCode};
use serde_json::{Value, json};

const HA_TOKEN: &str = "ha-long-lived-token";

async fn listen(app: axum::Router) -> String {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}", listener.local_addr().unwrap());
    tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    url
}

type Calls = Arc<Mutex<Vec<(String, Value)>>>;

fn authorized(headers: &HeaderMap) -> bool {
    headers.get("authorization").and_then(|v| v.to_str().ok()) == Some(&format!("Bearer {HA_TOKEN}"))
}

fn states() -> Value {
    json!([
        { "entity_id": "light.kitchen", "state": "off", "attributes": { "friendly_name": "Kitchen" } },
        { "entity_id": "switch.fan", "state": "off", "attributes": { "friendly_name": "Fan" } },
        { "entity_id": "lock.front_door", "state": "locked", "attributes": { "friendly_name": "Front door" } },
    ])
}

/// A stand-in Home Assistant: its REST API, the service calls it was sent kept in [calls].
async fn home_assistant(calls: Calls) -> String {
    let app = axum::Router::new()
        .route(
            "/api/config",
            axum::routing::get(|headers: HeaderMap| async move {
                if !authorized(&headers) {
                    return (StatusCode::UNAUTHORIZED, Json(json!({ "message": "401: Unauthorized" })));
                }
                (StatusCode::OK, Json(json!({ "location_name": "Home", "version": "2026.10.1" })))
            }),
        )
        .route(
            "/api/states",
            axum::routing::get(|headers: HeaderMap| async move {
                if !authorized(&headers) {
                    return (StatusCode::UNAUTHORIZED, Json(json!({})));
                }
                (StatusCode::OK, Json(states()))
            }),
        )
        .route(
            "/api/services",
            axum::routing::get(|| async {
                Json(json!([{ "domain": "light", "services": { "turn_on": {}, "turn_off": {} } }]))
            }),
        )
        .route(
            "/api/services/{domain}/{service}",
            axum::routing::post(
                |State(calls): State<Calls>,
                 Path((domain, service)): Path<(String, String)>,
                 Json(body): Json<Value>| async move {
                    calls.lock().unwrap().push((format!("{domain}.{service}"), body.clone()));
                    Json(json!([{ "entity_id": body["entity_id"], "state": "on" }]))
                },
            ),
        )
        .with_state(calls);
    listen(app).await
}

type Seen = Arc<Mutex<Vec<Value>>>;

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

fn tool_call(name: &str, args: Value) -> Value {
    json!({ "role": "assistant", "content": "", "tool_calls": [{ "id": "c1", "type": "function",
        "function": { "name": name, "arguments": args.to_string() } }] })
}

fn temp(name: &str) -> std::path::PathBuf {
    let dir = std::env::temp_dir().join(format!("autobot-ha-{name}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

fn agent(url: &str, home: &std::path::Path, ha: Option<Home>, approvals: ApprovalConfig) -> Agent {
    let mut tools = Tools::new(home.join("work"), Duration::from_secs(5)).with_home(home.to_owned());
    if let Some(ha) = ha {
        tools = tools.with_home_assistant(ha);
    }
    Agent {
        gateway: Gateway::new(&format!("{url}/v1"), "t", "auto", true).unwrap(),
        tools,
        approvals,
        max_steps: 6,
        team: Default::default(),
        mcp: Default::default(),
        trajectories: None,
        options: Default::default(),
    }
}

/// Says yes to everything, keeping what it was asked.
#[derive(Default)]
struct Yes(Mutex<Vec<Action>>);

impl Approver for Yes {
    fn approve<'a>(&'a self, action: &'a Action) -> Pin<Box<dyn Future<Output = Answer> + Send + 'a>> {
        self.0.lock().unwrap().push(action.clone());
        Box::pin(async { Answer::Once })
    }
}

#[tokio::test]
async fn the_home_tool_reads_freely_and_asks_before_changing() {
    let home = temp("tool");
    let calls = Calls::default();
    let ha = home_assistant(calls.clone()).await;
    let seen = Seen::default();
    let url = model(
        vec![
            tool_call("home", json!({ "action": "list", "domain": "light" })),
            tool_call("home", json!({ "action": "call", "service": "light.turn_on", "entity_id": "light.kitchen", "data": { "brightness_pct": 40 } })),
            json!({ "role": "assistant", "content": "The kitchen light is on." }),
        ],
        seen.clone(),
    )
    .await;
    let ask = ApprovalConfig { mode: ApprovalMode::Ask, allow: Vec::new() };
    let agent = agent(&url, &home, Some(Home::new(&ha, HA_TOKEN, None).unwrap()), ask);
    let mut session = autobot::session::Session::open(&home.join("sessions"), "s1").unwrap();
    let approver = Yes::default();
    let outcome =
        agent.turn(&mut session, "kitchen light on, 40%", &approver, &mut Default::default(), &|_| {}).await.unwrap();
    assert_eq!(outcome.text, "The kitchen light is on.");
    // The list asked nothing; the call asked once, as a `home` action.
    assert_eq!(
        *approver.0.lock().unwrap(),
        [Action::Home {
            service: "light.turn_on".into(),
            entities: "light.kitchen".into(),
            data: "{\"brightness_pct\":40}".into()
        }]
    );
    assert_eq!(
        *calls.lock().unwrap(),
        [("light.turn_on".to_owned(), json!({ "entity_id": "light.kitchen", "brightness_pct": 40 }))]
    );
    let second = seen.lock().unwrap()[1]["messages"].to_string();
    assert!(second.contains("light.kitchen: off (Kitchen)") && !second.contains("switch.fan"), "{second}");
    let tools = seen.lock().unwrap()[0]["tools"].to_string();
    assert!(tools.contains("\"name\":\"home\""));
    std::fs::remove_dir_all(home).unwrap();
}

#[tokio::test]
async fn unattended_only_allowlisted_services_run_and_only_allowed_entities_are_seen() {
    let home = temp("unattended");
    let calls = Calls::default();
    let ha = home_assistant(calls.clone()).await;
    let url = model(
        vec![
            tool_call("home", json!({ "action": "call", "service": "light.turn_off", "entity_id": "light.kitchen" })),
            tool_call("home", json!({ "action": "call", "service": "switch.turn_on", "entity_id": "switch.fan" })),
            json!({ "role": "assistant", "content": "ok" }),
        ],
        Seen::default(),
    )
    .await;
    let allowlist = ApprovalConfig { mode: ApprovalMode::Allowlist, allow: vec!["home:light.*".into()] };
    let ha_client = Home::new(&ha, HA_TOKEN, Some(&["light.*".to_owned(), "switch.*".to_owned()])).unwrap();
    let agent = agent(&url, &home, Some(ha_client), allowlist);
    let mut session = autobot::session::Session::open(&home.join("sessions"), "cron-x").unwrap();
    agent.turn(&mut session, "night mode", &autobot::approval::Refuse, &mut Default::default(), &|_| {}).await.unwrap();
    assert_eq!(calls.lock().unwrap().iter().map(|(s, _)| s.as_str()).collect::<Vec<_>>(), ["light.turn_off"]);
    assert!(session.messages.iter().any(|m| m["content"].as_str().is_some_and(|c| c.starts_with("refused"))));

    // `entities` limits what is seen and changed.
    let only_lights = Home::new(&ha, HA_TOKEN, Some(&["light.*".to_owned()])).unwrap();
    let listed = only_lights.list(None, None).await.unwrap();
    assert_eq!(listed, "light.kitchen: off (Kitchen)");
    assert!(only_lights.state("lock.front_door").await.is_err());
    assert!(only_lights.call("lock.unlock", &json!({ "entity_id": "lock.front_door" })).await.is_err());
    assert!(only_lights.call("light.turn_on", &json!({})).await.is_err(), "the entity must be named");
    assert_eq!(only_lights.about().await.unwrap(), "Home (Home Assistant 2026.10.1)");
    let wrong = Home::new(&ha, "nope", None).unwrap();
    assert!(wrong.about().await.unwrap_err().contains("not accepted"));
    std::fs::remove_dir_all(home).unwrap();
}

#[cfg(unix)]
#[test]
fn the_token_must_be_private() {
    use std::os::unix::fs::PermissionsExt;
    let home = temp("token");
    let config =
        autobot::homeassistant::HomeAssistantConfig { url: Some("http://127.0.0.1:8123".into()), ..Default::default() };
    let path = home.join("homeassistant.token");
    std::fs::write(&path, "abc\n").unwrap();
    std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o644)).unwrap();
    assert!(config.token(&home).unwrap_err().contains("chmod 600"));
    std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600)).unwrap();
    assert_eq!(config.token(&home).unwrap(), "abc");
    assert!(Home::from_config(&config, &home).unwrap().is_some());
    assert!(Home::from_config(&Default::default(), &home).unwrap().is_none(), "no url, no tool");
    std::fs::remove_dir_all(home).unwrap();
}

#[tokio::test]
async fn home_assistants_conversation_agent_talks_to_a_bot() {
    let (home, ops_home) = (temp("conv"), temp("conv-ops"));
    let url = model(
        vec![
            json!({ "role": "assistant", "content": "The kitchen light is on." }),
            json!({ "role": "assistant", "content": "Streamed." }),
            json!({ "role": "assistant", "content": "From the API." }),
        ],
        Seen::default(),
    )
    .await;
    let ops_url = model(vec![json!({ "role": "assistant", "content": "Ops here." })], Seen::default()).await;
    let ask = ApprovalConfig { mode: ApprovalMode::Ask, allow: Vec::new() };
    let runtime = Runtime::standalone("default", &home, Arc::new(agent(&url, &home, None, ask.clone())));
    let ops = Runtime::new(
        &autobot::bots::Def {
            name: "ops".into(),
            root: home.clone(),
            home: ops_home.clone(),
            config: autobot::config::Config::parse("").unwrap(),
            default: false,
        },
        agent(&ops_url, &ops_home, None, ask),
    );
    let secret = autobot::hooks::new_secret(&home, "homeassistant").unwrap();
    let ops_secret = autobot::hooks::new_secret(&ops_home, "homeassistant").unwrap();
    assert!(!autobot::hooks::valid_name("homeassistant") && !autobot::hooks::valid_name("whatsapp"));
    let bots: Arc<dyn autobot::bots::Find> = Arc::new(vec![runtime.clone(), ops]);
    let hooks = listen(autobot::hooks::app(bots)).await;
    let client = reqwest::Client::new();
    let ask = |path: &str, key: &str, body: Value| {
        let request = client.post(format!("{hooks}{path}")).bearer_auth(key).json(&body);
        async move {
            let response = request.send().await.unwrap();
            (response.status().as_u16(), response.text().await.unwrap())
        }
    };
    let request = json!({ "model": "autobot", "user": "kitchen-speaker", "messages": [
        { "role": "system", "content": "You are Home Assistant's voice." },
        { "role": "user", "content": "is the kitchen light on?" },
    ] });
    let (status, body) = ask("/hooks/homeassistant/v1/chat/completions", &secret, request.clone()).await;
    assert_eq!(status, 200, "{body}");
    let answer: Value = serde_json::from_str(&body).unwrap();
    assert_eq!(answer["object"], "chat.completion");
    assert_eq!(answer["choices"][0]["message"]["content"], "The kitchen light is on.");
    assert!(home.join("sessions/homeassistant-kitchen-speaker.jsonl").is_file());
    // The wrong key, or none.
    assert_eq!(ask("/hooks/homeassistant/v1/chat/completions", "wrong-key-0123456789", request.clone()).await.0, 401);
    // Streamed, as OpenAI clients ask for it.
    let mut streamed = request.clone();
    streamed["stream"] = json!(true);
    let (_, body) = ask("/hooks/homeassistant/v1/chat/completions", &secret, streamed).await;
    assert!(body.contains("\"content\":\"Streamed.\"") && body.ends_with("data: [DONE]\n\n"), "{body}");
    // Another bot at its own path, with its own key.
    let (status, body) = ask("/hooks/ops/homeassistant/v1/chat/completions", &ops_secret, request.clone()).await;
    assert_eq!(status, 200, "{body}");
    assert!(body.contains("Ops here."));
    assert_eq!(ask("/hooks/ops/homeassistant/v1/chat/completions", &secret, request.clone()).await.0, 401);
    let models: Value = client
        .get(format!("{hooks}/hooks/homeassistant/v1/models"))
        .bearer_auth(&secret)
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(models["data"][0]["id"], "default");

    // On the agent API, with the gateway's token; `model` may name the bot.
    let state = autobot::api::ApiState::new(runtime.agent(), "gw".into(), home.clone(), json!({}));
    let api = listen(autobot::api::app(Arc::new(state))).await;
    let reply: Value = client
        .post(format!("{api}/v1/agent/openai/v1/chat/completions"))
        .bearer_auth("gw")
        .json(&request)
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(reply["choices"][0]["message"]["content"], "From the API.");
    let models: Value = client
        .get(format!("{api}/v1/agent/openai/v1/models"))
        .bearer_auth("gw")
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(models["data"][0]["id"], "default");
    std::fs::remove_dir_all(home).unwrap();
    std::fs::remove_dir_all(ops_home).unwrap();
}

#[tokio::test]
async fn a_voice_request_runs_its_commands_confined_like_a_scheduled_task() {
    let home = temp("confined");
    std::fs::create_dir_all(home.join("work")).unwrap();
    // Outside the working directory and the temporary directories.
    let outside = std::path::PathBuf::from(std::env::var("HOME").unwrap())
        .join(format!(".autobot-ha-sandbox-test-{}", std::process::id()));
    let _ = std::fs::remove_file(&outside);
    let command = format!("echo out > '{}'; echo done", outside.display());
    let url = model(
        vec![tool_call("terminal", json!({ "command": command })), json!({ "role": "assistant", "content": "Done." })],
        Seen::default(),
    )
    .await;
    // Every command allowed: what bounds this one is the sandbox, as on a schedule.
    let trust = ApprovalConfig { mode: ApprovalMode::Trust, allow: Vec::new() };
    let mut agent = agent(&url, &home, None, trust);
    // As a config without `[agent] sandbox` has it.
    agent.tools = agent.tools.with_sandbox(autobot::sandbox::Mode::Unattended);
    let runtime = Runtime::standalone("default", &home, Arc::new(agent));
    let secret = autobot::hooks::new_secret(&home, "homeassistant").unwrap();
    let bots: Arc<dyn autobot::bots::Find> = Arc::new(vec![runtime]);
    let hooks = listen(autobot::hooks::app(bots)).await;
    let response = reqwest::Client::new()
        .post(format!("{hooks}/hooks/homeassistant/v1/chat/completions"))
        .bearer_auth(&secret)
        .json(&json!({ "model": "autobot", "messages": [{ "role": "user", "content": "clean up" }] }))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), 200);
    let wrote_outside = outside.exists();
    let _ = std::fs::remove_file(&outside);
    assert!(!wrote_outside, "a voice request's command wrote outside its working directory");
    let log = std::fs::read_to_string(home.join("actions.jsonl")).unwrap();
    let entry: Value = serde_json::from_str(log.lines().last().unwrap()).unwrap();
    assert_eq!(entry["sandbox"], autobot::sandbox::name(), "{entry}");
}
