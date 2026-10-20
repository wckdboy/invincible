//! What the timing benchmarks (`tests/perf.rs`) and the soak test (`tests/soak.rs`) share: a
//! stand-in for an OpenAI-compatible server (a llama.cpp engine behind the gateway, or the
//! gateway behind the agent), isolated homes, the real binaries, and what a process uses.

#![allow(dead_code)]

use std::net::SocketAddr;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, Instant};

use axum::Json;
use axum::body::{Body, Bytes};
use axum::extract::State;
use axum::response::{IntoResponse, Response};
use serde_json::{Value, json};

pub const TOKEN: &str = "bench-token-not-a-secret";

/// How the stand-in answers.
#[derive(Clone, Copy)]
pub struct Shape {
    /// Content pieces in a streamed answer.
    pub chunks: usize,
    /// Wait before each piece (and before a whole answer).
    pub delay: Duration,
}

impl Default for Shape {
    fn default() -> Self {
        Self { chunks: 8, delay: Duration::ZERO }
    }
}

struct MockState {
    shape: Shape,
    requests: Arc<AtomicU64>,
}

/// A stand-in OpenAI-compatible server on loopback.
pub struct Mock {
    pub addr: SocketAddr,
    pub requests: Arc<AtomicU64>,
    stop: Option<tokio::sync::oneshot::Sender<()>>,
    task: tokio::task::JoinHandle<()>,
}

impl Mock {
    /// `http://127.0.0.1:port`.
    pub fn url(&self) -> String {
        format!("http://{}", self.addr)
    }

    /// Stops answering and closes the port (open connections are dropped).
    pub async fn stop(mut self) {
        if let Some(stop) = self.stop.take() {
            let _ = stop.send(());
        }
        self.task.abort();
        let _ = (&mut self.task).await;
    }
}

/// Starts the stand-in on [addr] (port 0: any free port).
pub async fn mock(addr: SocketAddr, shape: Shape) -> Mock {
    mock_counting(addr, shape, Arc::default()).await
}

/// [mock], counting requests in [requests] (kept across restarts on the same port).
pub async fn mock_counting(addr: SocketAddr, shape: Shape, requests: Arc<AtomicU64>) -> Mock {
    let state = Arc::new(MockState { shape, requests: requests.clone() });
    let app = axum::Router::new()
        .route("/health", axum::routing::get(|| async { Json(json!({ "status": "ok" })) }))
        .route("/healthz", axum::routing::get(|| async { Json(json!({ "status": "ok" })) }))
        .route("/v1/models", axum::routing::get(models))
        .route("/v1/chat/completions", axum::routing::post(completions))
        .with_state(state);
    // Rebinding the port a moment ago closed can take a few tries.
    let mut tries = 0;
    let listener = loop {
        match tokio::net::TcpListener::bind(addr).await {
            Ok(listener) => break listener,
            Err(e) if tries < 100 => {
                tries += 1;
                let _ = e;
                tokio::time::sleep(Duration::from_millis(50)).await;
            }
            Err(e) => panic!("bind {addr}: {e}"),
        }
    };
    let addr = listener.local_addr().unwrap();
    let (stop, stopped) = tokio::sync::oneshot::channel::<()>();
    let task = tokio::spawn(async move {
        let _ = axum::serve(listener, app)
            .with_graceful_shutdown(async move {
                let _ = stopped.await;
            })
            .await;
    });
    Mock { addr, requests, stop: Some(stop), task }
}

async fn models() -> Json<Value> {
    Json(json!({ "object": "list", "data": [
        { "id": "mock", "object": "model", "invincible": { "tier": "node", "context": 8192, "healthy": true, "vision": false } },
    ] }))
}

async fn completions(State(state): State<Arc<MockState>>, body: Bytes) -> Response {
    state.requests.fetch_add(1, Ordering::Relaxed);
    let request: Value = serde_json::from_slice(&body).unwrap_or_default();
    let shape = state.shape;
    let usage = json!({ "prompt_tokens": 12, "completion_tokens": shape.chunks, "total_tokens": 12 + shape.chunks });
    if request["stream"] != json!(true) {
        tokio::time::sleep(shape.delay).await;
        let answer = json!({
            "id": "mock-1", "object": "chat.completion", "model": "mock",
            "choices": [{ "index": 0, "finish_reason": "stop", "message": { "role": "assistant", "content": "ok" } }],
            "usage": usage,
        });
        return Json(answer).into_response();
    }
    let pieces = futures_util::stream::unfold(0usize, move |n| {
        let usage = usage.clone();
        async move {
            if n > shape.chunks + 1 {
                return None;
            }
            if n > 0 && !shape.delay.is_zero() {
                tokio::time::sleep(shape.delay).await;
            }
            let line = if n == 0 {
                json!({ "choices": [{ "index": 0, "delta": { "role": "assistant", "content": "" } }] }).to_string()
            } else if n <= shape.chunks {
                json!({ "choices": [{ "index": 0, "delta": { "content": "tok " } }] }).to_string()
            } else {
                json!({ "choices": [{ "index": 0, "delta": {}, "finish_reason": "stop" }], "usage": usage }).to_string()
            };
            let mut out = format!("data: {line}\n\n");
            if n == shape.chunks + 1 {
                out.push_str("data: [DONE]\n\n");
            }
            Some((Ok::<_, std::convert::Infallible>(Bytes::from(out)), n + 1))
        }
    });
    let mut response = Response::new(Body::from_stream(pieces));
    response.headers_mut().insert("content-type", "text/event-stream".parse().unwrap());
    response
}

/// A fresh directory under the system's temp dir.
pub fn temp(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("autobot-bench-{name}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    dir.canonicalize().unwrap()
}

/// A free loopback port.
pub fn free_port() -> u16 {
    std::net::TcpListener::bind("127.0.0.1:0").unwrap().local_addr().unwrap().port()
}

/// A built binary of this workspace: `autobot`, or `invincible` beside it (built by `cargo
/// build`, which `bench/run.sh` does first).
pub fn binary(name: &str) -> PathBuf {
    let autobot = PathBuf::from(env!("CARGO_BIN_EXE_autobot"));
    let path = if name == "autobot" { autobot } else { autobot.with_file_name(name) };
    assert!(path.is_file(), "{} is not built: run `cargo build --release` first (bench/run.sh does)", path.display());
    path
}

/// Homes for one run: `HOME`, `AUTOBOT_HOME` and `INVINCIBLE_HOME` under [dir], never the real
/// ones, with the gateway's token in place.
pub struct Homes {
    pub home: PathBuf,
    pub autobot: PathBuf,
    pub invincible: PathBuf,
}

impl Homes {
    pub fn new(dir: &Path) -> Self {
        let homes = Self { home: dir.join("home"), autobot: dir.join("autobot"), invincible: dir.join("invincible") };
        for d in [&homes.home, &homes.autobot, &homes.invincible] {
            std::fs::create_dir_all(d).unwrap();
        }
        std::fs::write(homes.invincible.join("token"), format!("{TOKEN}\n")).unwrap();
        homes
    }

    pub fn command(&self, program: &Path) -> Command {
        let mut command = Command::new(program);
        command
            .env_clear()
            .env("PATH", std::env::var_os("PATH").unwrap_or_default())
            .env("HOME", &self.home)
            .env("AUTOBOT_HOME", &self.autobot)
            .env("INVINCIBLE_HOME", &self.invincible)
            .env("INVINCIBLE_WATCHDOG", "off")
            .env("NO_COLOR", "1")
            .env("RUST_LOG", "warn");
        command
    }

    /// The agent's config: the gateway at [gateway] (`http://…`), the agent API on [listen].
    pub fn agent_config(&self, gateway: &str, listen: u16, stream: bool) {
        let config = format!(
            "[gateway]\nurl = \"{gateway}/v1\"\nmodel = \"mock\"\ntoken_file = \"{}\"\n\n[serve]\nlisten = \"127.0.0.1:{listen}\"\n\n[agent]\nheartbeat = \"off\"\nstream = {stream}\nworkdir = \"{}\"\n",
            self.invincible.join("token").display(),
            self.home.join("work").display(),
        );
        std::fs::write(self.autobot.join("config.toml"), config).unwrap();
    }

    /// A second bot, `other`, with the default bot's gateway.
    pub fn add_bot(&self, name: &str) {
        let dir = self.autobot.join("bots").join(name);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("bot.toml"), format!("[bot]\nname = \"{name}\"\n")).unwrap();
    }
}

/// A child process killed when dropped.
pub struct Proc(pub Child);

impl Proc {
    pub fn pid(&self) -> u32 {
        self.0.id()
    }
}

impl Drop for Proc {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

pub fn spawn(mut command: Command, log: &Path) -> Proc {
    let out = std::fs::File::create(log).unwrap();
    command.stdin(Stdio::null()).stdout(out.try_clone().unwrap()).stderr(out);
    Proc(command.spawn().unwrap())
}

/// Waits until [url] answers 200 (at most [within]).
pub async fn wait_healthy(url: &str, within: Duration) {
    let client = reqwest::Client::new();
    let until = Instant::now() + within;
    loop {
        if matches!(client.get(url).send().await, Ok(r) if r.status().is_success()) {
            return;
        }
        assert!(Instant::now() < until, "{url} did not answer within {within:?}");
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
}

/// Resident memory of [pid], in KiB.
pub fn rss_kib(pid: u32) -> u64 {
    let out = Command::new("ps").args(["-o", "rss=", "-p", &pid.to_string()]).output().unwrap();
    String::from_utf8_lossy(&out.stdout).trim().parse().unwrap_or(0)
}

/// Open file descriptors of [pid].
pub fn fds(pid: u32) -> usize {
    let proc = PathBuf::from(format!("/proc/{pid}/fd"));
    if proc.is_dir() {
        return std::fs::read_dir(proc).map(|d| d.count()).unwrap_or(0);
    }
    // macOS: lsof, without its header line, and only numbered descriptors.
    let out = Command::new("lsof").args(["-n", "-P", "-p", &pid.to_string()]).output().unwrap();
    String::from_utf8_lossy(&out.stdout)
        .lines()
        .skip(1)
        .filter(|l| l.split_whitespace().nth(3).is_some_and(|fd| fd.starts_with(|c: char| c.is_ascii_digit())))
        .count()
}

/// Threads of [pid].
pub fn threads(pid: u32) -> usize {
    if let Ok(status) = std::fs::read_to_string(format!("/proc/{pid}/status")) {
        return status
            .lines()
            .find_map(|l| l.strip_prefix("Threads:"))
            .and_then(|n| n.trim().parse().ok())
            .unwrap_or(0);
    }
    let out = Command::new("ps").args(["-M", "-p", &pid.to_string()]).output().unwrap();
    String::from_utf8_lossy(&out.stdout).lines().count().saturating_sub(1)
}

/// One benchmark result, in a line `bench/run.sh` collects: `BENCH <name> <value> <unit>`.
pub fn report(name: &str, value: f64, unit: &str) {
    println!("BENCH {name} {value:.3} {unit}");
}

/// The [q] quantile (0..=1) of [samples], in milliseconds.
pub fn quantile_ms(samples: &mut [Duration], q: f64) -> f64 {
    samples.sort();
    let i = ((samples.len() - 1) as f64 * q).round() as usize;
    samples[i].as_secs_f64() * 1000.0
}

/// Turns refused as busy right after the one before ended, and tried again.
pub static BUSY: AtomicU64 = AtomicU64::new(0);

/// One agent turn over the agent API: its answer or error event.
pub async fn api_turn(
    client: &reqwest::Client,
    agent: &str,
    session: &str,
    bot: Option<&str>,
    text: &str,
) -> Result<Value, String> {
    let mut url = format!("{agent}/v1/agent/sessions/{session}/turns");
    if let Some(bot) = bot {
        url.push_str(&format!("?bot={bot}"));
    }
    // A turn that just ended may still hold its conversation for a moment (before 0.0.14).
    let mut busy = 0;
    let response = loop {
        let response = client
            .post(&url)
            .bearer_auth(TOKEN)
            .json(&json!({ "text": text }))
            .send()
            .await
            .map_err(|e| e.to_string())?;
        if response.status() == reqwest::StatusCode::CONFLICT && busy < 100 {
            busy += 1;
            BUSY.fetch_add(1, Ordering::Relaxed);
            tokio::time::sleep(Duration::from_millis(5)).await;
            continue;
        }
        break response;
    };
    if !response.status().is_success() {
        return Err(format!("{}: {}", response.status(), response.text().await.unwrap_or_default()));
    }
    let body = response.text().await.map_err(|e| e.to_string())?;
    body.lines()
        .filter_map(|l| l.strip_prefix("data: "))
        .filter_map(|d| serde_json::from_str::<Value>(d).ok())
        // The answer or the error (`kept` lines may follow it).
        .rfind(|e| e["type"] == "answer" || e["type"] == "error")
        .ok_or_else(|| format!("no events: {body}"))
}

/// [command] on a pseudo-terminal of 120 × 40: the time from its start until its output holds
/// [marker] (the terminal's questions answered as a terminal would), at most [within]; the
/// process is killed then.
pub fn time_to_output(mut command: Command, marker: &str, within: Duration) -> Result<Duration, String> {
    use rustix::pty::{OpenptFlags, grantpt, openpt, ptsname, unlockpt};
    use std::io::{Read, Write};
    let master = openpt(OpenptFlags::RDWR | OpenptFlags::NOCTTY).map_err(|e| e.to_string())?;
    grantpt(&master).map_err(|e| e.to_string())?;
    unlockpt(&master).map_err(|e| e.to_string())?;
    let name = ptsname(&master, Vec::new()).map_err(|e| e.to_string())?;
    let size = rustix::termios::Winsize { ws_row: 40, ws_col: 120, ws_xpixel: 0, ws_ypixel: 0 };
    let slave = std::fs::OpenOptions::new()
        .read(true)
        .write(true)
        .open(name.to_str().map_err(|e| e.to_string())?)
        .map_err(|e| e.to_string())?;
    rustix::termios::tcsetwinsize(&slave, size).map_err(|e| e.to_string())?;
    command.stdin(slave.try_clone().unwrap()).stdout(slave.try_clone().unwrap()).stderr(slave);
    let started = Instant::now();
    let child = Proc(command.spawn().map_err(|e| e.to_string())?);
    drop(command);
    let mut file = std::fs::File::from(master);
    let (tx, rx) = std::sync::mpsc::channel::<Duration>();
    let shown = format!("{marker:?}");
    let marker = marker.to_owned();
    let mut writer = file.try_clone().unwrap();
    std::thread::spawn(move || {
        let mut seen: Vec<u8> = Vec::new();
        let mut buf = [0u8; 8192];
        let mut answered = (0, 0);
        loop {
            let n = match file.read(&mut buf) {
                Ok(0) | Err(_) => return,
                Ok(n) => n,
            };
            seen.extend_from_slice(&buf[..n]);
            let text = String::from_utf8_lossy(&seen);
            // The device attributes and the cursor position, as any terminal answers them.
            let da = text.matches("\x1b[c").count();
            let cpr = text.matches("\x1b[6n").count();
            for _ in answered.0..da {
                let _ = writer.write_all(b"\x1b[?62;22c");
            }
            for _ in answered.1..cpr {
                let _ = writer.write_all(b"\x1b[1;1R");
            }
            answered = (da, cpr);
            if text.contains(&marker) {
                let _ = tx.send(started.elapsed());
                return;
            }
        }
    });
    let found = rx.recv_timeout(within).map_err(|_| format!("{shown} did not show within {within:?}"));
    drop(child);
    found
}
