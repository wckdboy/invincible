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
        let answer = self.answer.clone();
        Box::pin(async move { answer })
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
        team: Default::default(),
        mcp: Default::default(),
        trajectories: None,
        options: Default::default(),
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
    assert_eq!(
        first["tools"].as_array().unwrap().len(),
        10,
        "terminal, process, read, todo, write, edit, fetch, search, find, list"
    );
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
async fn what_the_owner_says_instead_goes_to_the_model_with_the_refusal() {
    let (url, script) = gateway(vec![call("terminal", json!({"command": "rm -rf build"})), say("ok, cleaning")]).await;
    let dir = temp("instead");
    let agent = agent(&url, &dir, ApprovalMode::Ask, true);
    let mut session = Session::open(&dir.join("sessions"), "t").unwrap();
    let owner = owner(Answer::Instead("use cargo clean".into()));
    agent.turn(&mut session, "x", &owner, &mut HashSet::new(), &quiet).await.unwrap();
    let result = script.lock().unwrap().seen[1].1["messages"].to_string();
    assert!(
        result.contains(
            "refused: the owner did not approve this (run: rm -rf build). Instead, the owner says: use cargo clean"
        ),
        "{result}"
    );
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
    let (run, receipts) = autobot::cron::run(&agent, &dir, &schedules.schedules[0]).await;
    assert!(run.ok, "{}", run.result);
    assert_eq!(run.result, "Report written.");
    assert_eq!(receipts, ["req1", "req2", "req3"]);
    assert_eq!(std::fs::read_to_string(dir.join("work/report.md")).unwrap(), "ok");
    let session = Session::open(&dir.join("sessions"), "cron-t1").unwrap();
    assert!(session.messages.iter().any(|m| m["content"].as_str().is_some_and(|c| c.starts_with("refused"))));
}

#[tokio::test]
async fn a_recipe_gets_only_its_tool_groups() {
    let (url, script) = gateway(vec![
        call("write_file", json!({"path": "notes.md", "content": "x"})),
        call("list_dir", json!({})),
        say("Listed."),
    ])
    .await;
    let dir = temp("recipe");
    let agent = agent(&url, &dir, ApprovalMode::Trust, true);
    let mut schedules = autobot::cron::Schedules::default();
    let spec = autobot::cron::ScheduleSpec {
        id: Some("r-morning".into()),
        when: "0 7 * * *".into(),
        task: "list my files".into(),
        name: Some("Morning files".into()),
        tools: Some(vec!["files-read".into(), "web".into()]),
        enabled: true,
        ..Default::default()
    };
    assert_eq!(schedules.put(spec.clone(), Some("device:phone".into())).unwrap(), "r-morning");
    // Put again: replaced, not added.
    assert_eq!(schedules.put(spec, None).unwrap(), "r-morning");
    assert_eq!(schedules.schedules.len(), 1);
    let (run, _) = autobot::cron::run(&agent, &dir, &schedules.schedules[0]).await;
    assert_eq!(run.result, "Listed.");
    // Even in trust mode, a tool outside the recipe's groups is neither offered nor run.
    let seen = script.lock().unwrap().seen.clone();
    let offered: Vec<&str> =
        seen[0].1["tools"].as_array().unwrap().iter().map(|t| t["function"]["name"].as_str().unwrap()).collect();
    // The recipe's `web` group: web_fetch, on the node too.
    assert_eq!(offered, ["read_file", "web_fetch", "search", "find_files", "list_dir"]);
    assert!(!dir.join("work/notes.md").exists());
    let session = Session::open(&dir.join("sessions"), "cron-r-morning").unwrap();
    assert!(
        session.messages.iter().any(|m| m["content"].as_str().is_some_and(|c| c.contains("not allowed in this task")))
    );
    assert!(
        schedules
            .put(
                autobot::cron::ScheduleSpec {
                    tools: Some(vec!["teleport".into()]),
                    when: "@daily".into(),
                    task: "x".into(),
                    ..Default::default()
                },
                None
            )
            .is_err()
    );
    assert!(
        schedules
            .put(
                autobot::cron::ScheduleSpec {
                    id: Some("../x".into()),
                    when: "@daily".into(),
                    task: "x".into(),
                    ..Default::default()
                },
                None
            )
            .is_err()
    );
    // A device must name the tools, and cannot replace a schedule made here or by another device.
    let local = schedules
        .put(autobot::cron::ScheduleSpec { when: "@daily".into(), task: "local".into(), ..Default::default() }, None)
        .unwrap();
    let from_phone = |id: &str, tools: Option<Vec<String>>| autobot::cron::ScheduleSpec {
        id: Some(id.into()),
        when: "@daily".into(),
        task: "x".into(),
        tools,
        ..Default::default()
    };
    assert!(schedules.put(from_phone("r-new", None), Some("device:phone".into())).is_err());
    assert!(schedules.put(from_phone(&local, Some(vec![])), Some("device:phone".into())).is_err());
    assert!(schedules.put(from_phone("r-morning", Some(vec![])), Some("device:other".into())).is_err());
    assert!(schedules.put(from_phone("r-phone", Some(vec![])), Some("device:phone".into())).is_ok());
    assert!(schedules.put(from_phone("r-phone", Some(vec![])), Some("device:phone".into())).is_ok());
    assert!(schedules.put(from_phone("r-phone", Some(vec![])), Some("device:other".into())).is_err());
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
    let names: Vec<&str> =
        first["tools"].as_array().unwrap().iter().map(|t| t["function"]["name"].as_str().unwrap()).collect();
    assert_eq!(
        names,
        [
            "terminal",
            "process",
            "read_file",
            "todo",
            "write_file",
            "edit_file",
            "web_fetch",
            "search",
            "find_files",
            "list_dir",
            "remember",
            "schedule_task",
            "propose_skill",
            "search_sessions",
            "list_schedules",
            "cancel_schedule",
            "read_skill"
        ]
    );
    assert!(first["messages"][0]["content"].as_str().unwrap().contains("- deploy: Deploy the site"));
    assert!(script.seen[1].1.to_string().contains("remembered (#1)"));
    assert!(script.seen[2].1.to_string().contains("git pull"));
    // A new conversation starts with what was remembered.
    assert!(script.seen[3].1["messages"][0]["content"].as_str().unwrap().contains("- The owner deploys on Fridays."));
}

#[tokio::test]
async fn the_agent_schedules_its_own_tasks_for_the_chat_that_asked() {
    let (url, _) = gateway(vec![
        call(
            "schedule_task",
            json!({"when": "in 2m", "task": "Tell the owner: hi, it has been 2 minutes", "name": "Hi"}),
        ),
        call("list_schedules", json!({})),
        say("Done: in 2 minutes."),
    ])
    .await;
    let dir = temp("schedule-tool");
    let mut agent = agent(&url, &dir, ApprovalMode::Ask, true);
    agent.tools = agent.tools.with_home(dir.clone());
    let mut session = Session::open(&dir.join("sessions"), "telegram-42").unwrap();
    let owner = owner(Answer::Deny);
    let context = autobot::tools::TurnContext { session: String::new(), telegram_chat: Some(42), ..Default::default() };
    let before = chrono::Local::now();
    autobot::tools::TURN
        .scope(context, agent.turn(&mut session, "remind me in 2 minutes", &owner, &mut HashSet::new(), &quiet))
        .await
        .unwrap();
    assert!(owner.asked.lock().unwrap().is_empty(), "scheduling asks nothing");
    let schedules = autobot::cron::Schedules::load(&dir).unwrap();
    let s = &schedules.schedules[0];
    assert_eq!(s.notify, Some(42));
    assert_eq!(s.origin.as_deref(), Some("agent:telegram-42"));
    assert_eq!(s.name.as_deref(), Some("Hi"));
    // Made absolute: once, about two minutes after it was asked.
    let autobot::cron::When::Once(at) = autobot::cron::When::parse(&s.when).unwrap() else { panic!("{}", s.when) };
    let minutes = (at - before).num_seconds();
    assert!((60..=121).contains(&minutes), "{} ({minutes}s)", s.when);
    assert!(
        session
            .messages
            .iter()
            .any(|m| m["content"].as_str().is_some_and(|c| c.contains("its answer comes to this chat")))
    );
    assert!(session.messages.iter().any(|m| m["content"].as_str().is_some_and(|c| c.contains("(once "))));

    // A scheduled run cannot schedule more.
    let mut cron = Session::open(&dir.join("sessions"), "cron-t1").unwrap();
    let (url, _) = gateway(vec![call("schedule_task", json!({"when": "every 1m", "task": "again"})), say("ok")]).await;
    let mut again = agent.clone();
    again.gateway = Gateway::new(&url, "secret", "auto", true).unwrap();
    again.turn(&mut cron, "x", &owner, &mut HashSet::new(), &quiet).await.unwrap();
    assert!(cron.messages.iter().any(|m| m["content"].as_str().is_some_and(|c| c.contains("cannot schedule more"))));
    assert_eq!(autobot::cron::Schedules::load(&dir).unwrap().schedules.len(), 1);
}

#[tokio::test]
async fn a_long_conversation_is_summarized_not_forgotten() {
    let (url, script) = gateway(vec![
        say("The owner set up backups to /srv/backup and wants a weekly check."),
        say("Weekly, as agreed."),
    ])
    .await;
    let dir = temp("compact");
    let agent = agent(&url, &dir, ApprovalMode::Ask, true);
    let mut session = Session::open(&dir.join("sessions"), "long").unwrap();
    for i in 0..10 {
        session.push(json!({ "role": "user", "content": format!("step {i}: back up to /srv/backup") })).unwrap();
        session.push(json!({ "role": "assistant", "content": "z".repeat(10 * 1024) })).unwrap();
    }
    let outcome = agent
        .turn(&mut session, "How often do we check?", &owner(Answer::Deny), &mut HashSet::new(), &quiet)
        .await
        .unwrap();
    assert_eq!(outcome.text, "Weekly, as agreed.");
    let seen = script.lock().unwrap().seen.clone();
    // First the summary (no tools), then the turn, with the summary in its system prompt.
    assert!(seen[0].1.get("tools").is_none());
    assert!(seen[0].1["messages"][1]["content"].as_str().unwrap().contains("step 0"));
    let system = seen[1].1["messages"][0]["content"].as_str().unwrap();
    assert!(system.contains("Earlier in this conversation") && system.contains("/srv/backup"), "{system}");
    assert!(!seen[1].1["messages"].to_string().contains("step 0:"), "the old part is not resent");
    assert_eq!(session.summary(), Some("The owner set up backups to /srv/backup and wants a weekly check."));
    assert!(Session::open(&dir.join("sessions"), "long").unwrap().compaction().is_none());
}

fn calls(list: &[(&str, Value)]) -> (u16, Value) {
    let tool_calls: Vec<Value> = list
        .iter()
        .enumerate()
        .map(|(i, (name, arguments))| {
            json!({ "id": format!("c{i}"), "type": "function", "function": { "name": name, "arguments": arguments.to_string() } })
        })
        .collect();
    (200, json!({ "choices": [{ "message": { "role": "assistant", "content": "", "tool_calls": tool_calls } }] }))
}

#[tokio::test]
async fn the_lead_hands_work_to_its_team_in_parallel() {
    let (url, script) = gateway(vec![
        calls(&[
            (
                "delegate",
                json!({"agent": "researcher", "goal": "Find where backups go", "context": "Look in notes.md"}),
            ),
            ("delegate", json!({"agent": "coder", "goal": "Print the date", "context": "Use the terminal"})),
        ]),
        // The two members, in whichever order they ask.
        say("member done"),
        say("member done"),
        say("Backups go to /srv/backup; the date was printed."),
    ])
    .await;
    let dir = temp("team");
    let mut lead = agent(&url, &dir, ApprovalMode::Ask, true);
    lead.tools = lead.tools.with_home(dir.clone());
    let roles = std::collections::BTreeMap::from([
        (
            "researcher".to_owned(),
            autobot::team::RoleConfig {
                description: "Reads and reports".into(),
                instructions: Some("Never change files.".into()),
                tools: vec!["files-read".into()],
                model: Some("qwen3-0.6b".into()),
                telegram_token_file: None,
            },
        ),
        (
            "coder".to_owned(),
            autobot::team::RoleConfig {
                description: "Runs commands".into(),
                instructions: None,
                tools: vec!["terminal".into()],
                model: None,
                telegram_token_file: None,
            },
        ),
    ]);
    lead.team = std::sync::Arc::new(autobot::team::Team::from_config(&roles, &Default::default()).unwrap());
    let progress = Mutex::new(Vec::<String>::new());
    let events = |e: Event| {
        if let Event::Tool(t) = e {
            progress.lock().unwrap().push(t.to_owned());
        }
    };
    let mut session = Session::open(&dir.join("sessions"), "lead").unwrap();
    let outcome = lead
        .turn(
            &mut session,
            "Where do backups go, and what time is it?",
            &owner(Answer::Deny),
            &mut HashSet::new(),
            &events,
        )
        .await
        .unwrap();
    assert_eq!(outcome.text, "Backups go to /srv/backup; the date was printed.");
    // The lead's own receipt plus each member's.
    assert_eq!(outcome.receipts.len(), 4);

    let seen = script.lock().unwrap().seen.clone();
    let names = |body: &Value| -> Vec<String> {
        body["tools"]
            .as_array()
            .map_or(Vec::new(), |t| t.iter().map(|t| t["function"]["name"].as_str().unwrap().to_owned()).collect())
    };
    // The lead has `delegate` and knows its team.
    assert!(names(&seen[0].1).contains(&"delegate".to_owned()));
    assert!(
        seen[0].1["messages"][0]["content"].as_str().unwrap().contains("- researcher: Reads and reports (files-read)")
    );
    // Each member: its own instructions and tools, no `delegate`, only the goal and context.
    let member = |who: &str| {
        seen[1..3]
            .iter()
            .find(|(_, b)| b["messages"][0]["content"].as_str().unwrap().contains(&format!("You are {who}")))
            .unwrap()
            .1
            .clone()
    };
    let researcher = member("researcher");
    assert_eq!(names(&researcher), ["read_file", "search", "find_files", "list_dir", "read_skill"]);
    assert_eq!(researcher["model"], "qwen3-0.6b");
    assert!(researcher["messages"][0]["content"].as_str().unwrap().contains("Never change files."));
    assert_eq!(researcher["messages"][1]["content"], "Goal: Find where backups go\n\nContext:\nLook in notes.md");
    assert!(
        !researcher["messages"].to_string().contains("what time is it"),
        "the lead's conversation stays with the lead"
    );
    let coder = member("coder");
    assert_eq!(names(&coder), ["terminal", "process"]);
    assert_eq!(coder["model"], "auto");
    // Both answers went back to the lead, by name.
    let back = seen[3].1["messages"].to_string();
    assert!(back.contains("researcher answered") && back.contains("coder answered"), "{back}");
    // Progress is tagged with who did what.
    let progress = progress.lock().unwrap();
    assert!(progress.iter().any(|p| p.starts_with("[researcher] ← Find where backups go")), "{progress:?}");
    // Members have their own conversations, named after the lead's.
    let sessions = autobot::session::list(&dir.join("sessions"));
    assert!(sessions.iter().any(|(n, _)| n.starts_with("lead--researcher-")), "{sessions:?}");
}

#[tokio::test]
async fn a_members_actions_ask_the_owner_and_it_cannot_delegate() {
    let (url, _) = gateway(vec![
        calls(&[("delegate", json!({"agent": "coder", "goal": "Run printf team-ok"}))]),
        call("terminal", json!({"command": "printf team-ok"})),
        call("delegate", json!({"agent": "coder", "goal": "again"})),
        say("ran it"),
        say("The coder ran it."),
    ])
    .await;
    let dir = temp("team-approve");
    let mut lead = agent(&url, &dir, ApprovalMode::Ask, true);
    lead.tools = lead.tools.with_home(dir.clone());
    let roles = std::collections::BTreeMap::from([(
        "coder".to_owned(),
        autobot::team::RoleConfig {
            description: "Runs commands".into(),
            instructions: None,
            tools: vec!["terminal".into()],
            model: None,
            telegram_token_file: None,
        },
    )]);
    lead.team = std::sync::Arc::new(autobot::team::Team::from_config(&roles, &Default::default()).unwrap());
    let owner = owner(Answer::Once);
    let mut session = Session::open(&dir.join("sessions"), "lead").unwrap();
    lead.turn(&mut session, "have the coder run it", &owner, &mut HashSet::new(), &quiet).await.unwrap();
    // The owner was asked for the member's command, once, and it is logged as the member's.
    assert_eq!(*owner.asked.lock().unwrap(), vec![Action::Command("printf team-ok".into())]);
    let log = autobot::actions::ActionLog::new(&dir).read(0, 10);
    assert!(log[0].session.starts_with("lead--coder-") && log[0].ran, "{log:?}");
    // A member has no `delegate`: the call is refused, not run.
    let member = autobot::session::list(&dir.join("sessions"))
        .into_iter()
        .find(|(n, _)| n.starts_with("lead--coder-"))
        .unwrap()
        .0;
    let member = Session::open(&dir.join("sessions"), &member).unwrap();
    assert!(
        member.messages.iter().any(|m| m["content"]
            .as_str()
            .is_some_and(|c| c.contains("no tool named \"delegate\"") || c.contains("not allowed"))),
        "{:?}",
        member.messages
    );
}

#[test]
fn a_team_config_is_checked() {
    let bad = |name: &str, tools: &[&str]| {
        let roles = std::collections::BTreeMap::from([(
            name.to_owned(),
            autobot::team::RoleConfig {
                description: "x".into(),
                instructions: None,
                tools: tools.iter().map(|t| (*t).to_owned()).collect(),
                model: None,
                telegram_token_file: None,
            },
        )]);
        autobot::team::Team::from_config(&roles, &Default::default()).is_err()
    };
    assert!(bad("has space", &[]));
    assert!(bad("coder", &["vault"]));
    assert!(!bad("coder", &["files-read", "terminal"]));
    let config: autobot::config::Config =
        toml::from_str("[agents.r]\ndescription = \"reads\"\ntools = [\"files-read\"]\n[team]\nmax_parallel = 3\n")
            .unwrap();
    assert_eq!(config.team.max_parallel, 3);
    assert_eq!(config.agents["r"].tools, ["files-read"]);
}

#[tokio::test]
async fn a_web_page_comes_through_the_gateway_after_asking() {
    // A stand-in gateway that serves /v1/fetch as well as completions.
    let script: Shared = Arc::new(Mutex::new(Script {
        answers: VecDeque::from([
            call("web_fetch", json!({"url": "https://example.com/notes"})),
            say("It says hello."),
        ]),
        seen: Vec::new(),
    }));
    let fetched: Arc<Mutex<Vec<Value>>> = Arc::default();
    let seen_fetch = fetched.clone();
    let app = axum::Router::new()
        .route("/v1/chat/completions", axum::routing::post(completions))
        .with_state(script.clone())
        .route(
            "/v1/fetch",
            axum::routing::post(move |Json(body): Json<Value>| {
                let seen = seen_fetch.clone();
                async move {
                    seen.lock().unwrap().push(body);
                    (
                        [("invincible-request-id", "f00d")],
                        Json(json!({ "status": 200, "content_type": "text/html", "text": "Hello from the page", "truncated": false })),
                    )
                }
            }),
        );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}/v1", listener.local_addr().unwrap());
    tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    let dir = temp("fetch");
    let agent = agent(&url, &dir, ApprovalMode::Ask, true);
    let owner = owner(Answer::Once);
    let mut session = Session::open(&dir.join("sessions"), "f").unwrap();
    let outcome =
        agent.turn(&mut session, "what does the page say?", &owner, &mut HashSet::new(), &quiet).await.unwrap();
    assert_eq!(outcome.text, "It says hello.");
    assert_eq!(*owner.asked.lock().unwrap(), vec![Action::Fetch("https://example.com/notes".into())]);
    assert_eq!(fetched.lock().unwrap()[0]["url"], "https://example.com/notes");
    let tool = session.messages.iter().find(|m| m["role"] == "tool").unwrap();
    assert!(tool["content"].as_str().unwrap().contains("200 · text/html\n\nHello from the page"));
}

#[test]
fn unattended_fetches_need_the_site_allowlisted() {
    use autobot::approval::{Verdict, check};
    let config = ApprovalConfig { mode: ApprovalMode::Allowlist, allow: vec!["https://docs.rs".into(), "ls".into()] };
    assert_eq!(check(&config, &Action::Fetch("https://docs.rs/serde".into())), Verdict::Run);
    assert_eq!(check(&config, &Action::Fetch("https://docs.rs".into())), Verdict::Run);
    for url in ["https://docs.rs.evil.example/x", "https://evil.example/https://docs.rs", "http://docs.rs/x"] {
        assert!(matches!(check(&config, &Action::Fetch(url.into())), Verdict::Refuse(_)), "{url}");
    }
    let ask = ApprovalConfig { mode: ApprovalMode::Ask, allow: Vec::new() };
    assert_eq!(check(&ask, &Action::Fetch("https://example.com".into())), Verdict::Ask);
}

fn mcp_hub(only: Option<Vec<String>>) -> autobot::mcp::Hub {
    let script = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/mcp_server.py");
    autobot::mcp::Hub::new(std::collections::BTreeMap::from([(
        "calc".to_owned(),
        autobot::mcp::ServerConfig {
            command: "python3".into(),
            args: vec![script.display().to_string()],
            env: Default::default(),
            tools: only,
        },
    )]))
    .unwrap()
}

#[tokio::test]
async fn an_mcp_servers_tools_are_the_agents_own_approved_like_commands() {
    let (url, script) = gateway(vec![call("calc__add", json!({"a": 2, "b": 40})), say("It is 42.")]).await;
    let dir = temp("mcp");
    let mut agent = agent(&url, &dir, ApprovalMode::Ask, true);
    agent.mcp = Arc::new(mcp_hub(Some(vec!["add".into()])));
    let owner = owner(Answer::Once);
    let mut session = Session::open(&dir.join("sessions"), "m").unwrap();
    let outcome = agent.turn(&mut session, "2 + 40?", &owner, &mut HashSet::new(), &quiet).await.unwrap();
    assert_eq!(outcome.text, "It is 42.");
    assert_eq!(
        *owner.asked.lock().unwrap(),
        vec![Action::Mcp { tool: "calc/add".into(), arguments: r#"{"a":2,"b":40}"#.into() }]
    );
    assert!(session.messages.iter().any(|m| m["role"] == "tool" && m["content"] == "42"));
    // Only the tools it was told to offer.
    let names: Vec<String> = script.lock().unwrap().seen[0].1["tools"]
        .as_array()
        .unwrap()
        .iter()
        .map(|t| t["function"]["name"].as_str().unwrap().to_owned())
        .collect();
    assert!(names.contains(&"calc__add".to_owned()) && !names.contains(&"calc__secret".to_owned()), "{names:?}");
}

#[tokio::test]
async fn mcp_results_errors_and_the_allowlist() {
    let hub = mcp_hub(None);
    assert_eq!(hub.call("calc", "add", json!({"a": 1, "b": 2})).await.unwrap(), "3");
    assert_eq!(hub.call("calc", "secret", json!({})).await.unwrap_err(), "nope");
    assert!(hub.call("calc", "missing", json!({})).await.unwrap_err().contains("no tool"));
    assert!(hub.call("nope", "add", json!({})).await.is_err());
    let broken = autobot::mcp::Hub::new(std::collections::BTreeMap::from([(
        "gone".to_owned(),
        autobot::mcp::ServerConfig {
            command: "/nonexistent/server".into(),
            args: vec![],
            env: Default::default(),
            tools: None,
        },
    )]))
    .unwrap();
    let (tools, problems) = broken.tools().await;
    assert!(tools.is_empty() && problems[0].contains("MCP server gone"));
    use autobot::approval::{Verdict, check};
    let config = ApprovalConfig { mode: ApprovalMode::Allowlist, allow: vec!["mcp:calc/add".into()] };
    let call = |tool: &str| Action::Mcp { tool: tool.into(), arguments: "{}".into() };
    assert_eq!(check(&config, &call("calc/add")), Verdict::Run);
    assert!(matches!(check(&config, &call("calc/secret")), Verdict::Refuse(_)));
}

#[tokio::test]
async fn a_plan_on_the_board_runs_in_order_asks_the_owner_and_finishes() {
    let (url, script) = gateway(vec![
        // The lead plans: find, then draft (which needs find's result).
        call(
            "board_plan",
            json!({"tasks": [
                {"key": "find", "agent": "researcher", "goal": "Find where backups go"},
                {"key": "draft", "agent": "writer", "goal": "Draft a backup note", "depends_on": ["find"]}
            ]}),
        ),
        say("Planned: the team is on it."),
        // The researcher.
        say("Backups go to /srv/backup."),
        // The writer asks the owner first.
        call("ask_owner", json!({"question": "Markdown or plain text?"})),
        say("Waiting for the owner."),
        // After the answer, it runs again.
        say("Wrote the note in Markdown."),
    ])
    .await;
    let dir = temp("board");
    let mut lead = agent(&url, &dir, ApprovalMode::Ask, true);
    lead.tools = lead.tools.with_home(dir.clone());
    let role = |d: &str| autobot::team::RoleConfig {
        description: d.into(),
        instructions: None,
        tools: vec![],
        model: None,
        telegram_token_file: None,
    };
    let roles = std::collections::BTreeMap::from([
        ("researcher".to_owned(), role("finds")),
        ("writer".to_owned(), role("writes")),
    ]);
    lead.team = Arc::new(autobot::team::Team::from_config(&roles, &Default::default()).unwrap());
    let lead = Arc::new(lead);
    let mut session = Session::open(&dir.join("sessions"), "owner").unwrap();
    let outcome = lead
        .turn(
            &mut session,
            "Write up our backups, in the background",
            &owner(Answer::Deny),
            &mut HashSet::new(),
            &quiet,
        )
        .await
        .unwrap();
    assert_eq!(outcome.text, "Planned: the team is on it.");
    assert!(
        session
            .messages
            .iter()
            .any(|m| m["content"].as_str().is_some_and(|c| c.starts_with("planned p1: find = b1, draft = b2")))
    );

    tokio::spawn(autobot::board::dispatcher(lead.clone(), dir.clone(), None));
    let wait = |status: autobot::board::Status, id: &'static str| {
        let dir = dir.clone();
        async move {
            for _ in 0..200 {
                if autobot::board::Board::load(&dir).unwrap().get(id).is_some_and(|t| t.status == status) {
                    return;
                }
                tokio::time::sleep(Duration::from_millis(50)).await;
            }
            panic!("{id} never became {status:?}: {}", autobot::board::Board::load(&dir).unwrap().listing());
        }
    };
    wait(autobot::board::Status::Blocked, "b2").await;
    let board = autobot::board::Board::load(&dir).unwrap();
    assert_eq!(board.get("b1").unwrap().result.as_deref(), Some("Backups go to /srv/backup."));
    assert_eq!(board.get("b2").unwrap().question.as_deref(), Some("Markdown or plain text?"));
    // The writer was handed the researcher's result.
    let writer_first = script
        .lock()
        .unwrap()
        .seen
        .iter()
        .find(|(_, b)| b["messages"][0]["content"].as_str().unwrap().contains("You are writer"))
        .unwrap()
        .1
        .clone();
    assert!(
        writer_first["messages"][1]["content"]
            .as_str()
            .unwrap()
            .contains("Result of b1 (researcher: Find where backups go):\nBackups go to /srv/backup.")
    );
    assert!(writer_first["tools"].as_array().unwrap().iter().any(|t| t["function"]["name"] == "ask_owner"));

    let mut board = board;
    board.answer("b2", "Markdown").unwrap();
    board.save(&dir).unwrap();
    wait(autobot::board::Status::Done, "b2").await;
    let board = autobot::board::Board::load(&dir).unwrap();
    assert_eq!(board.get("b2").unwrap().result.as_deref(), Some("Wrote the note in Markdown."));
    assert!(board.finished("p1"));
    let again = script.lock().unwrap().seen.last().unwrap().1.clone();
    assert!(
        again["messages"][1]["content"]
            .as_str()
            .unwrap()
            .contains("You asked the owner: Markdown or plain text?\nThe owner answered: Markdown")
    );
}

/// Approves, and while asked, the owner also sends a message to the running turn.
struct Steering {
    inbox: autobot::tools::Inbox,
}

impl Approver for Steering {
    fn approve<'a>(&'a self, _: &'a Action) -> Pin<Box<dyn Future<Output = Answer> + Send + 'a>> {
        self.inbox.lock().unwrap().push("Use Markdown for the note.".into());
        Box::pin(async { Answer::Once })
    }
}

#[tokio::test]
async fn a_message_sent_while_the_agent_works_steers_its_next_step() {
    let (url, script) =
        gateway(vec![call("terminal", json!({"command": "printf draft"})), say("Wrote it in Markdown.")]).await;
    let dir = temp("steer");
    let agent = agent(&url, &dir, ApprovalMode::Ask, true);
    let inbox: autobot::tools::Inbox = Arc::default();
    let owner = Steering { inbox: inbox.clone() };
    let mut session = Session::open(&dir.join("sessions"), "s").unwrap();
    let context = autobot::tools::TurnContext { inbox: Some(inbox.clone()), ..Default::default() };
    let outcome = autobot::tools::TURN
        .scope(context, agent.turn(&mut session, "write a note", &owner, &mut HashSet::new(), &quiet))
        .await
        .unwrap();
    assert_eq!(outcome.text, "Wrote it in Markdown.");
    let second = script.lock().unwrap().seen[1].1["messages"].to_string();
    assert!(second.contains("(The owner adds, while you work:) Use Markdown for the note."), "{second}");
    assert!(inbox.lock().unwrap().is_empty(), "taken in once");
}

#[tokio::test]
async fn the_heartbeat_checks_the_list_and_is_quiet_when_all_is_well() {
    let (url, script) = gateway(vec![call("terminal", json!({"command": "echo disk 42%"})), say("OK")]).await;
    let dir = temp("heartbeat");
    let mut agent = agent(&url, &dir, ApprovalMode::Ask, true);
    agent.tools = agent.tools.with_home(dir.clone());
    assert!(autobot::heartbeat::checklist(&dir).is_none(), "no checklist, no check");
    std::fs::write(dir.join("HEARTBEAT.md"), "- Is the disk over 90% full? (echo the usage)\n").unwrap();
    let list = autobot::heartbeat::checklist(&dir).unwrap();
    let answer = autobot::heartbeat::check(&agent, &dir, &list).await.unwrap();
    assert!(autobot::heartbeat::quiet(&answer));
    // The checklist went to the model; the allowlisted command ran (unattended rules).
    let first = script.lock().unwrap().seen[0].1.to_string();
    assert!(first.contains("Is the disk over 90% full"));
    let log = autobot::actions::ActionLog::new(&dir).read(0, 5);
    assert_eq!((log[0].action.as_str(), log[0].ran, log[0].by.as_str()), ("run: echo disk 42%", true, "policy"));
}

#[tokio::test]
async fn a_member_keeps_its_own_memory_and_sees_the_shared_one() {
    let (url, script) = gateway(vec![
        calls(&[("delegate", json!({"agent": "researcher", "goal": "Note where logs go"}))]),
        call("remember", json!({"text": "Logs are in /var/log/app."})),
        say("Noted."),
        say("The researcher noted it."),
    ])
    .await;
    let dir = temp("member-memory");
    let mut lead = agent(&url, &dir, ApprovalMode::Ask, true);
    lead.tools = lead.tools.with_home(dir.clone());
    autobot::memory::Memory::new(&dir).add("The owner prefers short answers.").unwrap();
    let roles = std::collections::BTreeMap::from([(
        "researcher".to_owned(),
        autobot::team::RoleConfig {
            description: "r".into(),
            instructions: None,
            tools: vec!["memory".into()],
            model: None,
            telegram_token_file: None,
        },
    )]);
    lead.team = Arc::new(autobot::team::Team::from_config(&roles, &Default::default()).unwrap());
    let mut session = Session::open(&dir.join("sessions"), "lead").unwrap();
    lead.turn(&mut session, "x", &owner(Answer::Deny), &mut HashSet::new(), &quiet).await.unwrap();
    // Its own file, not the shared one.
    assert_eq!(autobot::memory::Memory::member(&dir, "researcher").list()[0].text, "Logs are in /var/log/app.");
    assert_eq!(autobot::memory::Memory::new(&dir).list().len(), 1);
    // It saw what the agent knows about the owner.
    let member = script.lock().unwrap().seen[1].1["messages"][0]["content"].as_str().unwrap().to_owned();
    assert!(member.contains("What the agent knows about the owner:\n- The owner prefers short answers."), "{member}");
}

#[tokio::test]
async fn a_finished_turn_is_kept_as_a_trajectory_with_what_the_model_saw() {
    let (url, _script) = gateway(vec![
        call("terminal", json!({"command": "rm -rf /tmp/x"})),
        call("terminal", json!({"command": "echo ok"})),
        say("It is ok."),
        call("terminal", json!({"command": "echo again"})),
        call("terminal", json!({"command": "echo again"})),
    ])
    .await;
    let dir = temp("trajectory");
    let mut agent = agent(&url, &dir, ApprovalMode::Allowlist, true);
    let recorder = Arc::new(autobot::trajectory::Recorder::memory());
    agent.trajectories = Some(recorder.clone());
    let mut session = Session::open(&dir.join("sessions"), "t").unwrap();
    let owner = owner(Answer::Deny);
    agent.turn(&mut session, "check it", &owner, &mut HashSet::new(), &quiet).await.unwrap();
    let kept = recorder.take();
    assert_eq!(kept.len(), 1);
    let t = &kept[0];
    let roles: Vec<&str> = t["messages"].as_array().unwrap().iter().map(|m| m["role"].as_str().unwrap()).collect();
    assert_eq!(roles, ["system", "user", "assistant", "tool", "assistant", "tool", "assistant"]);
    assert_eq!(t["messages"][6]["content"], "It is ok.");
    assert_eq!(t["tools"].as_array().unwrap().len(), 10);
    assert_eq!(t["meta"]["outcome"], "answer");
    assert_eq!(t["meta"]["refused"], 1, "rm was not allowlisted");
    assert_eq!(t["meta"]["models"], json!(["qwen"]));
    assert_eq!(t["meta"]["receipts"], json!(["req1", "req2", "req3"]));
    assert_eq!(t["meta"]["session"], "t");
    assert!(!autobot::trajectory::Filter { clean: true, ..Default::default() }.keeps(t));

    // A turn that runs out of steps is kept as stopped, with its last calls and results.
    agent.max_steps = 2;
    agent.turn(&mut session, "again", &owner, &mut HashSet::new(), &quiet).await.unwrap();
    let t = &recorder.take()[0];
    assert_eq!(t["meta"]["outcome"], "stopped");
    let messages = t["messages"].as_array().unwrap();
    assert!(messages.last().unwrap()["content"].as_str().unwrap().starts_with("Stopped after 2 steps"));
    assert_eq!(messages[messages.len() - 2]["role"], "tool");
    assert_eq!(messages.iter().filter(|m| m["role"] == "system").count(), 1);
}

/// A gateway that streams: each call answers with the next list of SSE chunks.
async fn streaming_gateway(answers: Vec<Vec<Value>>) -> String {
    let answers = Arc::new(Mutex::new(VecDeque::from(answers)));
    let app = axum::Router::new().route(
        "/v1/chat/completions",
        axum::routing::post(move |Json(body): Json<Value>| {
            let answers = answers.clone();
            async move {
                assert_eq!(body["stream"], true);
                let chunks = answers.lock().unwrap().pop_front().expect("an answer for every call");
                let mut text = String::new();
                for chunk in chunks {
                    text.push_str(&format!("data: {chunk}\n\n"));
                }
                text.push_str("data: [DONE]\n\n");
                let mut response = text.into_response();
                response.headers_mut().insert("content-type", "text/event-stream".parse().unwrap());
                response.headers_mut().insert("invincible-request-id", "req-s".parse().unwrap());
                response
            }
        }),
    );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}/v1", listener.local_addr().unwrap());
    tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    url
}

#[tokio::test]
async fn a_streamed_turn_shows_its_text_and_diffs_and_can_be_undone() {
    let dir = temp("stream");
    std::fs::create_dir_all(dir.join("work")).unwrap();
    std::fs::write(dir.join("work/a.txt"), "one\ntwo\n").unwrap();
    let edit = json!({ "path": "a.txt", "old_text": "two", "new_text": "TWO" }).to_string();
    let url = streaming_gateway(vec![
        vec![
            json!({ "choices": [{ "delta": { "content": "Editing" } }] }),
            json!({ "choices": [{ "delta": { "tool_calls": [{ "index": 0, "id": "e1", "function": { "name": "edit_file", "arguments": &edit[..10] } }] } }] }),
            json!({ "choices": [{ "delta": { "tool_calls": [{ "index": 0, "function": { "arguments": &edit[10..] } }] } }] }),
        ],
        vec![
            json!({ "choices": [{ "delta": { "content": "Done: " } }] }),
            json!({ "choices": [{ "delta": { "content": "two is TWO." } }] }),
        ],
    ])
    .await;
    let mut agent = agent(&url, &dir, ApprovalMode::Edits, true);
    agent.gateway = agent.gateway.with_stream(true);
    agent.tools = Tools::new(dir.join("work"), Duration::from_secs(5)).with_home(dir.join("home"));
    let seen = Mutex::new(Vec::<String>::new());
    let events = |e: Event| {
        let line = match e {
            Event::Text(t) => format!("text {t}"),
            Event::Diff(d) => {
                format!("diff {}", d.lines().filter(|l| l.starts_with(['+', '-'])).collect::<Vec<_>>().join("|"))
            }
            Event::Output { name, text } => format!("output {name}: {text}"),
            Event::Tool(t) => format!("tool {}", t.split(" to ").next().unwrap()),
            _ => return,
        };
        seen.lock().unwrap().push(line);
    };
    let mut session = Session::open(&dir.join("home/sessions"), "s").unwrap();
    // Edits: a change in the working directory runs without asking.
    let outcome =
        agent.turn(&mut session, "make it loud", &owner(Answer::Deny), &mut HashSet::new(), &events).await.unwrap();
    assert_eq!(outcome.text, "Done: two is TWO.");
    assert_eq!(std::fs::read_to_string(dir.join("work/a.txt")).unwrap(), "one\nTWO\n");
    let seen = seen.into_inner().unwrap();
    assert_eq!(seen[0], "text Editing");
    assert_eq!(seen[1], "diff --- a/a.txt|+++ b/a.txt|-two|+TWO");
    assert_eq!(seen[2], "tool write 3 bytes");
    assert!(seen[3].starts_with("output edit_file: replaced 1 occurrence"));
    assert_eq!(&seen[4..], ["text Done: ", "text two is TWO."]);
    // The streamed call was put back together for the conversation.
    assert_eq!(session.messages[1]["tool_calls"][0]["function"]["arguments"], edit);
    // Undo puts the file back and takes the turn away.
    let (request, files) = session.undo().unwrap();
    assert_eq!(request, "make it loud");
    assert_eq!(files.len(), 1);
    assert_eq!(std::fs::read_to_string(dir.join("work/a.txt")).unwrap(), "one\ntwo\n");
    assert!(session.messages.is_empty());
}

#[tokio::test]
async fn reads_in_one_reply_run_together_and_come_back_in_order() {
    let mut first = calls(&[
        ("read_file", json!({ "path": "a.txt" })),
        ("search", json!({ "pattern": "two" })),
        ("terminal", json!({ "command": "echo hi" })),
    ]);
    first.1["usage"] = json!({ "prompt_tokens": 1200, "completion_tokens": 30, "prompt_cache_hit_tokens": 1000 });
    let (url, _script) = gateway(vec![first, say("done")]).await;
    let dir = temp("parallel");
    std::fs::create_dir_all(dir.join("work")).unwrap();
    std::fs::write(dir.join("work/a.txt"), "one\n").unwrap();
    std::fs::write(dir.join("work/b.txt"), "two\n").unwrap();
    let agent = agent(&url, &dir, ApprovalMode::Ask, true);
    let seen = Mutex::new(Vec::<String>::new());
    let events = |e: Event| {
        let line = match e {
            Event::Tool(t) => format!("tool {}", t.split(' ').next().unwrap()),
            Event::Output { name, .. } => format!("output {name}"),
            Event::Usage { input, output, cached } => format!("usage {input}/{output}/{cached}"),
            _ => return,
        };
        seen.lock().unwrap().push(line);
    };
    let mut session = Session::open(&dir.join("sessions"), "p").unwrap();
    agent.turn(&mut session, "look", &owner(Answer::Once), &mut HashSet::new(), &events).await.unwrap();
    assert_eq!(
        seen.into_inner().unwrap(),
        [
            "usage 1200/30/1000",
            "tool read_file",
            "output read_file",
            "tool search",
            "output search",
            "tool run:",
            "output terminal",
        ]
    );
    let results: Vec<&str> =
        session.messages.iter().filter(|m| m["role"] == "tool").map(|m| m["content"].as_str().unwrap()).collect();
    assert_eq!(results[0], "one\n");
    assert_eq!(results[1], "b.txt:1: two\n");
    assert!(results[2].starts_with("hi"));
}

#[tokio::test]
async fn images_go_as_parts_while_the_session_and_trajectories_keep_references() {
    let (url, script) = gateway(vec![say("A gradient."), say("Still a gradient."), say("Gone."), say("Blind.")]).await;
    let dir = temp("images");
    let mut agent = agent(&url, &dir, ApprovalMode::Ask, true);
    let recorder = Arc::new(autobot::trajectory::Recorder::memory());
    agent.trajectories = Some(recorder.clone());
    let path = dir.join("shot.png");
    let rgb = image::RgbImage::from_fn(48, 24, |x, y| image::Rgb([x as u8 * 5, y as u8 * 9, 120]));
    rgb.save(&path).unwrap();
    let shot = autobot::images::attach(&path).unwrap();
    let mut session = Session::open(&dir.join("sessions"), "img").unwrap();
    let owner = owner(Answer::Deny);
    let text = "what is [image 1: shot.png]?";
    let outcome = agent
        .turn_with(&mut session, text, std::slice::from_ref(&shot), &owner, &mut HashSet::new(), &quiet)
        .await
        .unwrap();
    assert_eq!(outcome.text, "A gradient.");
    // A follow-up: the image is still in the window, and still on disk, so it goes again.
    agent.turn(&mut session, "and now?", &owner, &mut HashSet::new(), &quiet).await.unwrap();
    std::fs::remove_file(&path).unwrap();
    agent.turn(&mut session, "and now it is gone?", &owner, &mut HashSet::new(), &quiet).await.unwrap();
    agent.options.vision = Some(false);
    std::fs::write(&path, b"").unwrap();
    agent.turn(&mut session, "blind?", &owner, &mut HashSet::new(), &quiet).await.unwrap();

    let script = script.lock().unwrap();
    let user = |call: usize| script.seen[call].1["messages"][1].clone();
    let first = user(0);
    assert!(first.get("autobot_images").is_none(), "the reference stays home");
    assert_eq!(first["content"][0], json!({ "type": "text", "text": text }));
    let url = first["content"][1]["image_url"]["url"].as_str().unwrap();
    assert!(url.starts_with("data:image/png;base64,iVBORw0KGgo"), "{}", &url[..40]);
    assert_eq!(user(1)["content"][1], first["content"][1], "sent again while on disk");
    assert_eq!(user(2)["content"], format!("{text}\n([image 1: shot.png] not sent: no longer on disk)"));
    assert!(user(3)["content"].as_str().unwrap().ends_with("not sent: this model can't see images)"));

    // On disk: the path, hash and size, never the bytes.
    let file = std::fs::read_to_string(dir.join("sessions/img.jsonl")).unwrap();
    let stored: Value = serde_json::from_str(file.lines().next().unwrap()).unwrap();
    assert_eq!(stored["content"], text);
    assert_eq!(stored["autobot_images"][0]["sha256"], shot.sha256);
    assert_eq!(stored["autobot_images"][0]["path"], path.display().to_string());
    assert!(!file.contains("base64,"));
    let kept = recorder.take();
    assert_eq!(kept.len(), 4);
    assert!(!serde_json::to_string(&kept).unwrap().contains("base64,"), "trajectories keep references too");
}
