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

fn alive(pid: &str) -> bool {
    std::process::Command::new("kill")
        .args(["-0", pid])
        .stderr(std::process::Stdio::null())
        .status()
        .is_ok_and(|s| s.success())
}

#[tokio::test]
async fn a_stopped_agent_leaves_no_background_process_behind() {
    let dir = temp("shutdown");
    let homes = Homes::new(&dir);
    let pids = dir.join("pids");
    // A shell that starts a child of its own: both must go.
    let command = format!("sleep 300 & echo $$ $! > {}; wait", pids.display());
    let gateway = model(command).await;
    let port = free_port();
    homes.agent_config(&format!("http://{gateway}"), port, false);
    let config = homes.autobot.join("config.toml");
    let mut text = std::fs::read_to_string(&config).unwrap();
    text.push_str("\n[approvals]\nmode = \"trust\"\n");
    std::fs::write(&config, text).unwrap();
    std::fs::create_dir_all(homes.home.join("work")).unwrap();
    let mut proc = spawn(
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
    let started: Vec<&str> = line.split_whitespace().collect();
    assert!(started.iter().all(|pid| alive(pid)), "running: {started:?}");

    let status = std::process::Command::new("kill").args(["-TERM", &proc.pid().to_string()]).status().unwrap();
    assert!(status.success());
    let until = std::time::Instant::now() + Duration::from_secs(20);
    while proc.0.try_wait().unwrap().is_none() {
        assert!(std::time::Instant::now() < until, "the agent did not stop on SIGTERM");
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    // Stopped with it, not after: no grace period for the process to linger in.
    let left: Vec<&&str> = started.iter().filter(|pid| alive(pid)).collect();
    let log = std::fs::read_to_string(dir.join("agent.log")).unwrap_or_default();
    assert!(left.is_empty(), "left running after the agent stopped: {left:?}\n{log}");
}
