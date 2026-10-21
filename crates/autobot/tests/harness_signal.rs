//! Stopping the agent (a signal to the chat, the end of a run) stops the commands its tools
//! are running. Its own test binary: [autobot::procs::stop_all] stops every command in the
//! process, so it must not run beside other tests' commands.

mod scripted;

use std::time::{Duration, Instant};

use autobot::approval::Answer;
use autobot::config::ApprovalMode;
use autobot::session::Session;
use scripted::*;
use serde_json::json;

fn sessions(dir: &std::path::Path) -> std::path::PathBuf {
    dir.join("home/sessions")
}

/// Whether process [pid] is gone (or a zombie on its way out), waiting up to two seconds.
fn gone(pid: u32) -> bool {
    let until = Instant::now() + Duration::from_secs(2);
    loop {
        let out = std::process::Command::new("ps").args(["-o", "stat=", "-p", &pid.to_string()]).output().unwrap();
        let stat = String::from_utf8_lossy(&out.stdout).trim().to_owned();
        if stat.is_empty() || stat.starts_with('Z') {
            return true;
        }
        if Instant::now() > until {
            return false;
        }
        std::thread::sleep(Duration::from_millis(50));
    }
}

#[tokio::test]
async fn when_the_agent_is_stopped_the_commands_it_runs_stop_too() {
    let model = model(|n, _| match n {
        0 => call("t", "terminal", json!({ "command": "sleep 300 & echo $! > child.pid; sleep 300" })),
        _ => say("ok"),
    })
    .await;
    let dir = dir("stop-all");
    let mut agent = agent(&model.url, &dir, ApprovalMode::Ask);
    agent.tools = autobot::tools::Tools::new(dir.join("work"), Duration::from_secs(600)).with_home(dir.join("home"));
    let mut session = Session::open(&sessions(&dir), "s").unwrap();
    let owner = Owner::new(Answer::Once);
    let mut granted = grants();
    let turn = agent.turn(&mut session, "go", &owner, &mut granted, &quiet);
    // What the TUI's SIGTERM/SIGHUP handler (and the CLI's) does before it exits.
    let stop = async {
        while !dir.join("work/child.pid").exists() {
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
        assert!(autobot::tools::running_commands() >= 1);
        autobot::procs::stop_all().await;
    };
    let started = Instant::now();
    let (outcome, ()) = tokio::join!(turn, stop);
    outcome.unwrap();
    let child: u32 = std::fs::read_to_string(dir.join("work/child.pid")).unwrap().trim().parse().unwrap();
    assert!(gone(child), "what the command started is stopped too");
    assert!(last_result(&model.requests()[1].body).contains("killed by a signal"));
    assert!(started.elapsed() < Duration::from_secs(10));
}
