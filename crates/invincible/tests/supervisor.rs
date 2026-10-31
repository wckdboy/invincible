//! The engine supervisor against a stand-in engine (a small Python server that answers `/health`
//! and then crashes), so the test needs neither llama.cpp nor a model.

use std::sync::Arc;
use std::time::Duration;

use invincible::cluster::{self, ClusterRun, Head};
use invincible::devices::StaticKey;
use invincible::engine::{Engine, Launch, free_port, supervise};
use invincible_policy::SplitMode;
use tokio::time::{Instant, sleep};

const STAND_IN: &str = r#"
import http.server, socketserver, sys, threading, os
class H(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        self.send_response(200 if self.path == "/health" else 404)
        self.end_headers()
    def log_message(self, *a): pass
class S(http.server.HTTPServer):
    allow_reuse_address = True
    # HTTPServer.server_bind does a reverse DNS lookup, which can take seconds on CI runners.
    def server_bind(self):
        socketserver.TCPServer.server_bind(self)
        self.server_name, self.server_port = self.server_address[:2]
server = S(("127.0.0.1", int(sys.argv[1])), H)
print("listening", flush=True)
threading.Timer(float(sys.argv[2]), lambda: os._exit(1)).start()
server.serve_forever()
"#;

/// Waits for [condition]; on timeout, fails with the stand-in's log (what it printed, how it died).
async fn wait_until(what: &str, log: &std::path::Path, condition: impl Fn() -> bool) {
    let start = Instant::now();
    while !condition() {
        if start.elapsed() > Duration::from_secs(20) {
            let log = std::fs::read_to_string(log).unwrap_or_else(|e| format!("(no log: {e})"));
            panic!("timed out waiting until {what}; stand-in log:\n{log}");
        }
        sleep(Duration::from_millis(50)).await;
    }
}

#[tokio::test]
async fn restarts_a_crashed_engine_and_tracks_its_health() {
    let port = free_port().unwrap();
    let dir = std::env::temp_dir().join(format!("invincible-supervisor-{}", std::process::id()));
    let log = dir.join("stand-in.log");
    let launch = Launch {
        program: "python3".into(),
        args: vec!["-I".into(), "-c".into(), STAND_IN.into(), port.to_string(), "1.5".into()],
        log: log.clone(),
        env: vec![],
        key_file: None,
        cwd: None,
    };
    let engine = Engine::attached("stand-in", &format!("http://127.0.0.1:{port}"), None, false);
    let task = supervise(engine.clone(), launch);

    wait_until("the engine is healthy", &log, || engine.healthy()).await;
    wait_until("the crash is noticed", &log, || !engine.healthy()).await;
    wait_until("the restarted engine is healthy", &log, || engine.healthy()).await;

    task.abort();
    let _ = task.await;
    let _ = std::fs::remove_dir_all(dir);
}

#[tokio::test]
async fn an_engine_that_cannot_start_stays_unhealthy() {
    let dir = std::env::temp_dir().join(format!("invincible-missing-{}", std::process::id()));
    let launch = Launch {
        program: "/nonexistent/llama-server".into(),
        args: vec![],
        log: dir.join("x.log"),
        env: vec![],
        key_file: None,
        cwd: None,
    };
    let engine = Engine::attached("missing", "http://127.0.0.1:9", None, false);
    let task = supervise(engine.clone(), launch);
    sleep(Duration::from_millis(1500)).await;
    assert!(!engine.healthy());
    task.abort();
    let _ = std::fs::remove_dir_all(dir);
}

#[tokio::test]
async fn an_engine_that_answers_without_its_key_is_stopped_for_good() {
    // The stand-in takes no key: whatever it answers a chat completion without one (here 501), it
    // is not a 401.
    let port = free_port().unwrap();
    let dir = std::env::temp_dir().join(format!("invincible-unkeyed-{}", std::process::id()));
    let log = dir.join("stand-in.log");
    let launch = Launch {
        program: "python3".into(),
        args: vec!["-I".into(), "-c".into(), STAND_IN.into(), port.to_string(), "600".into()],
        log: log.clone(),
        env: vec![],
        key_file: Some((dir.join("engine.key"), "k3y".into())),
        cwd: None,
    };
    let engine = Engine::attached("unkeyed", &format!("http://127.0.0.1:{port}"), None, false).with_key("k3y");
    let task = supervise(engine.clone(), launch);

    // It answered /health, and it was still never healthy: the supervisor stopped it and gave up.
    wait_until("the supervisor gives up", &log, || task.is_finished()).await;
    assert!(!engine.healthy());
    let stopped = std::net::TcpStream::connect(("127.0.0.1", port)).is_err();
    // Not started again either, after the first restart's backoff.
    sleep(Duration::from_millis(1500)).await;
    assert!(stopped && std::net::TcpStream::connect(("127.0.0.1", port)).is_err(), "the engine is still running");
    let printed = std::fs::read_to_string(&log).unwrap();
    assert_eq!(printed.matches("listening").count(), 1, "started more than once: {printed}");
    let _ = std::fs::remove_dir_all(dir);
}

#[tokio::test]
async fn a_split_model_whose_engine_answers_without_its_key_is_not_run_again() {
    let port = free_port().unwrap();
    let dir = std::env::temp_dir().join(format!("invincible-unkeyed-split-{}", std::process::id()));
    let log = dir.join("stand-in.log");
    let launch = Launch {
        program: "python3".into(),
        args: vec!["-I".into(), "-c".into(), STAND_IN.into(), port.to_string(), "600".into()],
        log: log.clone(),
        env: vec![],
        key_file: Some((dir.join("engine.key"), "k3y".into())),
        cwd: None,
    };
    let engine = Engine::attached("unkeyed", &format!("http://127.0.0.1:{port}"), None, false).with_key("k3y");
    // No peers and no GPU: the plan is to run on this machine alone.
    let run = Arc::new(ClusterRun::new("unkeyed", SplitMode::Auto, "head", vec![]));
    let head = Head {
        devices: vec![],
        rpc_backend: None,
        hardware: String::new(),
        device_key: StaticKey::load_or_create(&dir.join("device.key")).unwrap(),
        network: "offline".into(),
        model_bytes: 0,
    };
    let task = cluster::supervise(engine.clone(), launch, run.clone(), head);

    // The cluster supervisor gives up as the single-engine one does, and says why where `cluster
    // status` reads it.
    wait_until("the supervisor gives up", &log, || task.is_finished()).await;
    assert!(!engine.healthy());
    let notes = run.state().notes;
    assert!(notes.iter().any(|n| n.contains("does not enforce its key")), "{notes:?}");
    let printed = std::fs::read_to_string(&log).unwrap();
    assert_eq!(printed.matches("listening").count(), 1, "started more than once: {printed}");
    let _ = std::fs::remove_dir_all(dir);
}
