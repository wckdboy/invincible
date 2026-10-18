//! The engine supervisor against a stand-in engine (a small Python server that answers `/health`
//! and then crashes), so the test needs neither llama.cpp nor a model.

use std::time::Duration;

use invincible::engine::{Engine, Launch, free_port, supervise};
use tokio::time::{Instant, sleep};

const STAND_IN: &str = r#"
import http.server, sys, threading, os
class H(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        self.send_response(200 if self.path == "/health" else 404)
        self.end_headers()
    def log_message(self, *a): pass
server = http.server.HTTPServer(("127.0.0.1", int(sys.argv[1])), H)
server.allow_reuse_address = True
threading.Timer(float(sys.argv[2]), lambda: os._exit(1)).start()
server.serve_forever()
"#;

async fn wait_until(what: &str, deadline: Duration, condition: impl Fn() -> bool) {
    let start = Instant::now();
    while !condition() {
        assert!(start.elapsed() < deadline, "timed out waiting until {what}");
        sleep(Duration::from_millis(50)).await;
    }
}

#[tokio::test]
async fn restarts_a_crashed_engine_and_tracks_its_health() {
    let port = free_port().unwrap();
    let dir = std::env::temp_dir().join(format!("invincible-supervisor-{}", std::process::id()));
    let launch = Launch {
        program: "python3".into(),
        args: vec!["-I".into(), "-c".into(), STAND_IN.into(), port.to_string(), "1.5".into()],
        log: dir.join("stand-in.log"),
    };
    let engine = Engine::attached("stand-in", &format!("http://127.0.0.1:{port}"), None, false);
    let task = supervise(engine.clone(), launch);

    wait_until("the engine is healthy", Duration::from_secs(10), || engine.healthy()).await;
    wait_until("the crash is noticed", Duration::from_secs(10), || !engine.healthy()).await;
    wait_until("the restarted engine is healthy", Duration::from_secs(10), || engine.healthy()).await;

    task.abort();
    let _ = task.await;
    let _ = std::fs::remove_dir_all(dir);
}

#[tokio::test]
async fn an_engine_that_cannot_start_stays_unhealthy() {
    let dir = std::env::temp_dir().join(format!("invincible-missing-{}", std::process::id()));
    let launch = Launch { program: "/nonexistent/llama-server".into(), args: vec![], log: dir.join("x.log") };
    let engine = Engine::attached("missing", "http://127.0.0.1:9", None, false);
    let task = supervise(engine.clone(), launch);
    sleep(Duration::from_millis(1500)).await;
    assert!(!engine.healthy());
    task.abort();
    let _ = std::fs::remove_dir_all(dir);
}
