//! The agent loop against a stand-in gateway that answers with scripted messages: tool calls,
//! approvals, refusals, and the router's request for confirmation.

use std::collections::{HashSet, VecDeque};
use std::future::Future;
use std::pin::Pin;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use autobot::agent::{Agent, Event};
use autobot::approval::{Action, Answer, Approver};
use autobot::config::{ApprovalConfig, ApprovalMode};
use autobot::gateway::Gateway;
use autobot::session::Session;
use autobot::tools::Tools;
use axum::Json;
use axum::extract::State;
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use serde_json::{Value, json};

#[derive(Default)]
struct Script {
    /// What each call answers, in order: (status, body).
    answers: VecDeque<(u16, Value)>,
    /// What each call was sent: (headers, body).
    seen: Vec<(HeaderMap, Value)>,
}

type Shared = Arc<Mutex<Script>>;

async fn completions(State(script): State<Shared>, headers: HeaderMap, Json(body): Json<Value>) -> Response {
    let mut script = script.lock().unwrap();
    script.seen.push((headers, body));
    let (status, answer) = script.answers.pop_front().expect("an answer for every call");
    let mut response = (StatusCode::from_u16(status).unwrap(), Json(answer)).into_response();
    if status == 200 {
        let n = script.seen.len();
        response.headers_mut().insert("invincible-request-id", format!("req{n}").parse().unwrap());
        response
            .headers_mut()
            .insert("invincible-decision", r#"{"action":"run","model":"qwen","tier":"node"}"#.parse().unwrap());
    }
    response
}

async fn gateway(answers: Vec<(u16, Value)>) -> (String, Shared) {
    let script: Shared = Arc::new(Mutex::new(Script { answers: answers.into(), seen: Vec::new() }));
    let app =
        axum::Router::new().route("/v1/chat/completions", axum::routing::post(completions)).with_state(script.clone());
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}/v1", listener.local_addr().unwrap());
    tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    (url, script)
}

fn say(text: &str) -> (u16, Value) {
    (200, json!({ "choices": [{ "message": { "role": "assistant", "content": text } }] }))
}

fn call(name: &str, arguments: Value) -> (u16, Value) {
    (
        200,
        json!({ "choices": [{ "message": {
            "role": "assistant",
            "content": "",
            "reasoning_content": "thinking…",
            "tool_calls": [{ "id": "c1", "type": "function", "function": { "name": name, "arguments": arguments.to_string() } }],
        } }] }),
    )
}

/// Answers every question with [answer] and remembers what was asked.
struct Owner {
    answer: Answer,
    asked: Mutex<Vec<Action>>,
}

impl Approver for Owner {
    fn approve<'a>(&'a self, action: &'a Action) -> Pin<Box<dyn Future<Output = Answer> + Send + 'a>> {
        self.asked.lock().unwrap().push(action.clone());
        Box::pin(async { self.answer })
    }
}

fn owner(answer: Answer) -> Owner {
    Owner { answer, asked: Mutex::new(Vec::new()) }
}

fn temp(name: &str) -> std::path::PathBuf {
    let dir = std::env::temp_dir().join(format!("autobot-it-{name}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    dir.canonicalize().unwrap()
}

fn agent(url: &str, dir: &std::path::Path, mode: ApprovalMode, private: bool) -> Agent {
    Agent {
        gateway: Gateway::new(url, "secret", "auto", private).unwrap(),
        tools: Tools::new(dir.join("work"), Duration::from_secs(5)),
        approvals: ApprovalConfig { mode, allow: vec!["echo".into()] },
        max_steps: 6,
    }
}

fn quiet(_: Event) {}

#[tokio::test]
async fn an_approved_command_runs_and_its_output_goes_back() {
    let (url, script) =
        gateway(vec![call("terminal", json!({"command": "printf hi > f.txt; cat f.txt"})), say("Done: hi")]).await;
    let dir = temp("approved");
    let agent = agent(&url, &dir, ApprovalMode::Ask, true);
    let mut session = Session::open(&dir.join("sessions"), "t").unwrap();
    let owner = owner(Answer::Once);
    let outcome = agent.turn(&mut session, "make a file", &owner, &mut HashSet::new(), &quiet).await.unwrap();
    assert_eq!(outcome.text, "Done: hi");
    assert_eq!(outcome.receipts, vec!["req1", "req2"]);
    assert_eq!(*owner.asked.lock().unwrap(), vec![Action::Command("printf hi > f.txt; cat f.txt".into())]);
    assert_eq!(std::fs::read_to_string(dir.join("work/f.txt")).unwrap(), "hi");

    let script = script.lock().unwrap();
    let (headers, first) = &script.seen[0];
    assert_eq!(headers["authorization"], "Bearer secret");
    assert_eq!(headers["invincible-private"], "1", "agent turns are private by default");
    assert_eq!(first["tools"].as_array().unwrap().len(), 4);
    assert_eq!(first["messages"][0]["role"], "system");
    // The second call carries the tool call and its result, without the reasoning.
    let messages = script.seen[1].1["messages"].as_array().unwrap();
    let tool = messages.iter().find(|m| m["role"] == "tool").unwrap();
    assert_eq!(tool["tool_call_id"], "c1");
    assert_eq!(tool["content"], "hi\n[exit code 0]");
    assert!(messages.iter().all(|m| m.get("reasoning_content").is_none()));
    // Everything is on disk.
    assert_eq!(Session::open(&dir.join("sessions"), "t").unwrap().messages.len(), 4);
}

#[tokio::test]
async fn a_denied_command_does_not_run() {
    let (url, script) = gateway(vec![call("terminal", json!({"command": "touch nope"})), say("ok, I won't")]).await;
    let dir = temp("denied");
    let agent = agent(&url, &dir, ApprovalMode::Ask, true);
    let mut session = Session::open(&dir.join("sessions"), "t").unwrap();
    let outcome = agent.turn(&mut session, "x", &owner(Answer::Deny), &mut HashSet::new(), &quiet).await.unwrap();
    assert_eq!(outcome.text, "ok, I won't");
    assert!(!dir.join("work/nope").exists());
    let result = &script.lock().unwrap().seen[1].1["messages"];
    assert!(result.to_string().contains("refused: the owner did not approve"));
}

#[tokio::test]
async fn allowlist_mode_runs_allowed_commands_and_workdir_writes_and_refuses_the_rest_without_asking() {
    let (url, script) = gateway(vec![
        call("terminal", json!({"command": "echo allowed"})),
        call("write_file", json!({"path": "x", "content": "y"})),
        call("write_file", json!({"path": "../outside", "content": "y"})),
        say("done"),
    ])
    .await;
    let dir = temp("allowlist");
    let agent = agent(&url, &dir, ApprovalMode::Allowlist, true);
    let mut session = Session::open(&dir.join("sessions"), "t").unwrap();
    let owner = owner(Answer::Once);
    agent.turn(&mut session, "x", &owner, &mut HashSet::new(), &quiet).await.unwrap();
    assert!(owner.asked.lock().unwrap().is_empty());
    assert!(dir.join("work/x").exists(), "a write in the working directory runs");
    assert!(!dir.join("outside").exists(), "one outside it does not");
    let script = script.lock().unwrap();
    assert!(script.seen[1].1.to_string().contains("allowed\\n[exit code 0]"));
    assert!(script.seen[3].1.to_string().contains("refused"));
}

#[tokio::test]
async fn always_is_remembered_for_the_session() {
    let command = json!({"command": "true"});
    let (url, _) = gateway(vec![call("terminal", command.clone()), call("terminal", command), say("twice")]).await;
    let dir = temp("always");
    let agent = agent(&url, &dir, ApprovalMode::Ask, true);
    let mut session = Session::open(&dir.join("sessions"), "t").unwrap();
    let owner = owner(Answer::Always);
    let mut grants = HashSet::new();
    agent.turn(&mut session, "x", &owner, &mut grants, &quiet).await.unwrap();
    assert_eq!(owner.asked.lock().unwrap().len(), 1);
}

#[tokio::test]
async fn the_routers_question_goes_to_the_owner_and_a_yes_resends_confirmed() {
    let ask = (409, json!({"error": {"message": "cloud use needs confirmation", "type": "confirmation_required"}}));
    let (url, script) = gateway(vec![ask.clone(), say("from the cloud")]).await;
    let dir = temp("confirm");
    let agent = agent(&url, &dir, ApprovalMode::Ask, false);
    let mut session = Session::open(&dir.join("sessions"), "t").unwrap();
    let owner = owner(Answer::Once);
    let outcome = agent.turn(&mut session, "x", &owner, &mut HashSet::new(), &quiet).await.unwrap();
    assert_eq!(outcome.text, "from the cloud");
    assert_eq!(*owner.asked.lock().unwrap(), vec![Action::Cloud("cloud use needs confirmation".into())]);
    {
        let script = script.lock().unwrap();
        assert!(script.seen[0].0.get("invincible-confirmed").is_none());
        assert!(script.seen[0].0.get("invincible-private").is_none());
        assert_eq!(script.seen[1].0["invincible-confirmed"], "1");
    }

    let (url, _) = gateway(vec![ask]).await;
    let agent = self::agent(&url, &dir, ApprovalMode::Ask, false);
    let error =
        agent.turn(&mut session, "x", &self::owner(Answer::Deny), &mut HashSet::new(), &quiet).await.err().unwrap();
    assert!(error.contains("not approved"), "{error}");
}

#[tokio::test]
async fn the_step_budget_ends_a_loop() {
    let calls = (0..6).map(|_| call("list_dir", json!({}))).collect();
    let (url, _) = gateway(calls).await;
    let dir = temp("budget");
    let agent = agent(&url, &dir, ApprovalMode::Ask, true);
    let mut session = Session::open(&dir.join("sessions"), "t").unwrap();
    let outcome = agent.turn(&mut session, "x", &owner(Answer::Deny), &mut HashSet::new(), &quiet).await.unwrap();
    assert!(outcome.text.contains("Stopped after 6 steps"), "{}", outcome.text);
}

#[tokio::test]
async fn an_unreachable_gateway_says_how_to_start_it() {
    let dir = temp("down");
    let agent = agent("http://127.0.0.1:9/v1", &dir, ApprovalMode::Ask, true);
    let mut session = Session::open(&dir.join("sessions"), "t").unwrap();
    let error = agent.turn(&mut session, "x", &owner(Answer::Deny), &mut HashSet::new(), &quiet).await.err().unwrap();
    assert!(error.contains("invincible serve"), "{error}");
}

#[test]
fn a_remote_gateway_must_use_https() {
    assert!(Gateway::new("http://192.168.1.2:7777/v1", "t", "auto", true).is_err());
    assert!(Gateway::new("https://gateway.example/v1", "t", "auto", true).is_ok());
}

#[tokio::test]
async fn a_scheduled_run_follows_allowlist_rules_with_nobody_to_ask() {
    let (url, _) = gateway(vec![
        call("terminal", json!({"command": "rm -rf /tmp/never"})),
        call("write_file", json!({"path": "report.md", "content": "ok"})),
        say("Report written."),
    ])
    .await;
    let dir = temp("cron");
    // The owner's mode is "ask", but there is nobody to ask.
    let agent = agent(&url, &dir, ApprovalMode::Ask, true);
    let mut schedules = autobot::cron::Schedules::default();
    schedules.add("@daily", "write the report", false).unwrap();
    let run = autobot::cron::run(&agent, &dir, &schedules.schedules[0]).await;
    assert!(run.ok, "{}", run.result);
    assert_eq!(run.result, "Report written.");
    assert_eq!(std::fs::read_to_string(dir.join("work/report.md")).unwrap(), "ok");
    let session = Session::open(&dir.join("sessions"), "cron-t1").unwrap();
    assert!(session.messages.iter().any(|m| m["content"].as_str().is_some_and(|c| c.starts_with("refused"))));
}

#[tokio::test]
async fn the_agent_remembers_and_reads_skills_from_its_home() {
    let (url, script) = gateway(vec![
        call("remember", json!({"text": "The owner deploys on Fridays."})),
        call("read_skill", json!({"name": "deploy"})),
        say("Noted, and I have the deploy steps."),
        say("You deploy on Fridays."),
    ])
    .await;
    let dir = temp("memory");
    std::fs::create_dir_all(dir.join("skills")).unwrap();
    std::fs::write(dir.join("skills/deploy.md"), "---\ndescription: Deploy the site\n---\n1. git pull\n2. restart")
        .unwrap();
    let mut agent = agent(&url, &dir, ApprovalMode::Ask, true);
    agent.tools = agent.tools.clone().with_home(dir.clone());
    let owner = owner(Answer::Deny);
    let mut session = Session::open(&dir.join("sessions"), "t").unwrap();
    agent.turn(&mut session, "Remember that I deploy on Fridays", &owner, &mut HashSet::new(), &quiet).await.unwrap();
    assert!(owner.asked.lock().unwrap().is_empty(), "nothing to approve");
    let mut later = Session::open(&dir.join("sessions"), "later").unwrap();
    agent.turn(&mut later, "When do I deploy?", &owner, &mut HashSet::new(), &quiet).await.unwrap();

    let script = script.lock().unwrap();
    let first = &script.seen[0].1;
    assert_eq!(first["tools"].as_array().unwrap().len(), 6);
    assert!(first["messages"][0]["content"].as_str().unwrap().contains("- deploy: Deploy the site"));
    assert!(script.seen[1].1.to_string().contains("remembered (#1)"));
    assert!(script.seen[2].1.to_string().contains("git pull"));
    // A new conversation starts with what was remembered.
    assert!(script.seen[3].1["messages"][0]["content"].as_str().unwrap().contains("- The owner deploys on Fridays."));
}
