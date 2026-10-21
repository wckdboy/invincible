//! `autobot serve` stopping (SIGTERM, as launchd and systemd stop it) stops what its turns left
//! running in the background, and the process group it started: no orphans.

mod support;

use std::sync::{Arc, Mutex};
use std::time::Duration;

use axum::Json;
use serde_json::{Value, json};
use support::*;

/// A model that first runs [command] in the background, then answers.
async fn model(command: String) -> std::net::SocketAddr {
    let calls = Arc::new(Mutex::new(0u32));
    let app = axum::Router::new()
        .route("/v1/models", axum::routing::get(|| async { Json(json!({ "object": "list", "data": [] })) }))
        .route(
            "/v1/chat/completions",
            axum::routing::post(move || {
                let calls = calls.clone();
                let command = command.clone();
                async move {
                    let n = {
                        let mut calls = calls.lock().unwrap();
                        *calls += 1;
                        *calls
                    };
                    let message = if n == 1 {
                        let arguments = json!({ "command": command, "background": true }).to_string();
                        json!({ "role": "assistant", "content": null, "tool_calls": [{ "id": "c1", "type": "function",
                            "function": { "name": "terminal", "arguments": arguments } }] })
                    } else {
                        json!({ "role": "assistant", "content": "started" })
                    };
                    Json(json!({ "choices": [{ "index": 0, "finish_reason": "stop", "message": message }] }))
                }
            }),
        );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    addr
}

/// Whether [pid] is a live process (a zombie, killed but not yet reaped, is not).
fn alive(pid: &str) -> bool {
    let out = std::process::Command::new("ps").args(["-o", "stat=", "-p", pid]).output().unwrap();
    let state = String::from_utf8_lossy(&out.stdout);
    let state = state.trim();
    !state.is_empty() && !state.starts_with('Z')
}

/// `autobot serve` in a home under [name], whose first turn starts [command] in the background
/// ($PIDS in it: a file to write pids to); the agent, its directory, and the pids written.
async fn agent_running(name: &str, command: &str) -> (Proc, std::path::PathBuf, Vec<String>) {
    let dir = temp(name);
    let homes = Homes::new(&dir);
    let pids = dir.join("pids");
    let gateway = model(command.replace("$PIDS", &pids.display().to_string())).await;
    let port = free_port();
    homes.agent_config(&format!("http://{gateway}"), port, false);
    let config = homes.autobot.join("config.toml");
    let mut text = std::fs::read_to_string(&config).unwrap();
    text.push_str("\n[approvals]\nmode = \"trust\"\n");
    std::fs::write(&config, text).unwrap();
    std::fs::create_dir_all(homes.home.join("work")).unwrap();
    let proc = spawn(
        {
            let mut c = homes.command(&binary("autobot"));
            c.arg("serve").current_dir(&homes.home);
            c
        },
        &dir.join("agent.log"),
    );
    let agent = format!("http://127.0.0.1:{port}");
    wait_healthy(&format!("{agent}/healthz"), Duration::from_secs(20)).await;
    let client = reqwest::Client::new();
    let last: Value = api_turn(&client, &agent, "s", None, "start it").await.unwrap();
    assert_eq!(last["text"], "started", "{last}");
    let until = std::time::Instant::now() + Duration::from_secs(10);
    let line = loop {
        if let Ok(line) = std::fs::read_to_string(&pids)
            && line.split_whitespace().count() == 2
        {
            break line;
        }
        assert!(std::time::Instant::now() < until, "the background command did not start");
        tokio::time::sleep(Duration::from_millis(50)).await;
    };
    let started: Vec<String> = line.split_whitespace().map(str::to_owned).collect();
    assert!(started.iter().all(|pid| alive(pid)), "running: {started:?}");
    (proc, dir, started)
}

fn term(proc: &Proc) {
    let status = std::process::Command::new("kill").args(["-TERM", &proc.pid().to_string()]).status().unwrap();
    assert!(status.success());
}

/// Waits (at most [within]) for [proc] to end; how long it took.
async fn ended(proc: &mut Proc, within: Duration) -> Duration {
    let started = std::time::Instant::now();
    while proc.0.try_wait().unwrap().is_none() {
        assert!(started.elapsed() < within, "the agent did not stop within {within:?}");
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    started.elapsed()
}

#[tokio::test]
async fn a_stopped_agent_leaves_no_background_process_behind() {
    // A shell that starts a child of its own: both must go.
    let (mut proc, dir, started) = agent_running("shutdown", "sleep 300 & echo $$ $! > $PIDS; wait").await;
    term(&proc);
    ended(&mut proc, Duration::from_secs(20)).await;
    // Stopped with it: gone within a few seconds (polled: a killed process not yet reaped still
    // answers for a moment).
    let until = std::time::Instant::now() + Duration::from_secs(10);
    loop {
        let left: Vec<&String> = started.iter().filter(|pid| alive(pid)).collect();
        if left.is_empty() {
            break;
        }
        let log = std::fs::read_to_string(dir.join("agent.log")).unwrap_or_default();
        assert!(std::time::Instant::now() < until, "left running after the agent stopped: {left:?}\n{log}");
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
}

/// Asked to stop again while it cleans up (a command that ignores TERM holds it a few
/// seconds), the agent stops at once.
#[tokio::test]
async fn asked_twice_the_agent_stops_at_once() {
    let (mut proc, _dir, started) =
        agent_running("shutdown-twice", "trap '' TERM; sleep 300 & echo $$ $! > $PIDS; wait").await;
    term(&proc);
    tokio::time::sleep(Duration::from_millis(300)).await;
    assert!(proc.0.try_wait().unwrap().is_none(), "still cleaning up (TERM is ignored for 3 s)");
    term(&proc);
    let took = ended(&mut proc, Duration::from_secs(20)).await;
    assert!(took < Duration::from_millis(1500), "took {took:?} after the second ask");
    for pid in started {
        let _ = std::process::Command::new("kill").args(["-KILL", &pid]).status();
    }
}

/// Once the agent began to stop, nothing new starts: a background process or a command started
/// then would outlive the sweep.
#[tokio::test]
async fn nothing_starts_once_stopping_began() {
    autobot::procs::shut_down().await;
    let mut cmd = tokio::process::Command::new("sh");
    cmd.arg("-c").arg("sleep 300");
    let error = autobot::procs::start("late", cmd, &std::env::temp_dir(), None).unwrap_err();
    assert!(error.contains("stopping"), "{error}");
    let tools = autobot::tools::Tools::new(std::env::temp_dir(), Duration::from_secs(5));
    let call = tools.parse("terminal", r#"{"command": "echo late"}"#).unwrap();
    let out = tools.run(&call).await;
    assert!(out.contains("stopping") && !out.contains("late\n"), "{out}");
}
