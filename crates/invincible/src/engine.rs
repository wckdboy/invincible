//! Engines: inference servers the node runs as child processes and never links in, so a crashing
//! engine cannot take the node down. v0 has one kind, llama.cpp's `llama-server`.

use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use tokio::process::Command;
use tokio::task::JoinHandle;
use tokio::time::{Instant, sleep};

use crate::config::{EngineConfig, ModelConfig};

const HEALTH_INTERVAL: Duration = Duration::from_millis(500);
const FIRST_BACKOFF: Duration = Duration::from_secs(1);
const MAX_BACKOFF: Duration = Duration::from_secs(30);
/// A run this long counts as stable: the next crash restarts after [FIRST_BACKOFF] again.
const STABLE_RUN: Duration = Duration::from_secs(60);

/// One model served by one engine, as the router and the API see it.
#[derive(Clone, Debug)]
pub struct Engine {
    pub id: String,
    pub context: Option<u64>,
    /// Where the engine's OpenAI-compatible API is, e.g. `http://127.0.0.1:41234`.
    pub base_url: String,
    /// Whether it takes images (None: not known).
    pub vision: Option<bool>,
    healthy: Arc<AtomicBool>,
}

impl Engine {
    /// An engine whose health someone else reports (tests, and engines the node does not run).
    pub fn attached(id: &str, base_url: &str, context: Option<u64>, healthy: bool) -> Self {
        Self {
            id: id.to_owned(),
            context,
            base_url: base_url.trim_end_matches('/').to_owned(),
            vision: None,
            healthy: Arc::new(AtomicBool::new(healthy)),
        }
    }

    /// The same engine, taking images or not.
    pub fn with_vision(mut self, vision: Option<bool>) -> Self {
        self.vision = vision;
        self
    }

    pub fn healthy(&self) -> bool {
        self.healthy.load(Ordering::Relaxed)
    }

    pub fn set_healthy(&self, healthy: bool) {
        self.healthy.store(healthy, Ordering::Relaxed);
    }
}

/// What to run for one engine.
#[derive(Clone, Debug)]
pub struct Launch {
    pub program: PathBuf,
    pub args: Vec<String>,
    /// The engine's stdout and stderr go here.
    pub log: PathBuf,
}

impl Launch {
    /// `llama-server` for [model] on loopback [port].
    pub fn llama_server(engine: &EngineConfig, model: &ModelConfig, port: u16, logs: &Path) -> Self {
        let mut args = vec![
            "--model".to_owned(),
            model.path.display().to_string(),
            "--alias".to_owned(),
            model.id.clone(),
            "--host".to_owned(),
            "127.0.0.1".to_owned(),
            "--port".to_owned(),
            port.to_string(),
            "--n-gpu-layers".to_owned(),
            model.gpu_layers.to_string(),
        ];
        if let Some(context) = model.context {
            args.extend(["--ctx-size".to_owned(), context.to_string()]);
        }
        if let Some(mmproj) = &model.mmproj {
            args.extend(["--mmproj".to_owned(), mmproj.display().to_string()]);
        }
        args.extend(engine.extra_args.iter().cloned());
        Self { program: engine.llama_server.clone(), args, log: logs.join(format!("{}.log", model.id)) }
    }
}

/// A free loopback port. Another process could take it before the engine binds it; the engine
/// then fails, and the supervisor restarts it.
pub fn free_port() -> std::io::Result<u16> {
    Ok(std::net::TcpListener::bind(("127.0.0.1", 0))?.local_addr()?.port())
}

/// Runs [launch] and keeps it running: restarts it when it exits, with backoff, and keeps
/// [engine]'s health current by polling `GET /health` (200 once the model is loaded).
/// Dropping or aborting the returned task kills the engine.
pub fn supervise(engine: Engine, launch: Launch) -> JoinHandle<()> {
    tokio::spawn(async move {
        let client = crate::egress::local()
            .connect_timeout(Duration::from_secs(1))
            .timeout(Duration::from_secs(2))
            .build()
            .expect("HTTP client");
        let health = format!("{}/health", engine.base_url);
        let mut backoff = FIRST_BACKOFF;
        loop {
            let started = Instant::now();
            match spawn(&launch) {
                Err(e) => tracing::error!(model = %engine.id, "engine did not start: {e}"),
                Ok(mut child) => {
                    tracing::info!(model = %engine.id, url = %engine.base_url, "engine started");
                    loop {
                        tokio::select! {
                            status = child.wait() => {
                                engine.set_healthy(false);
                                tracing::warn!(model = %engine.id, "engine exited: {status:?}");
                                break;
                            }
                            _ = sleep(HEALTH_INTERVAL) => {
                                let ok = matches!(client.get(&health).send().await, Ok(r) if r.status().is_success());
                                if ok != engine.healthy() {
                                    tracing::info!(model = %engine.id, healthy = ok, "engine health changed");
                                }
                                engine.set_healthy(ok);
                            }
                        }
                    }
                }
            }
            if started.elapsed() >= STABLE_RUN {
                backoff = FIRST_BACKOFF;
            }
            sleep(backoff).await;
            backoff = (backoff * 2).min(MAX_BACKOFF);
        }
    })
}

fn spawn(launch: &Launch) -> std::io::Result<tokio::process::Child> {
    if let Some(dir) = launch.log.parent() {
        std::fs::create_dir_all(dir)?;
    }
    let log = std::fs::OpenOptions::new().create(true).append(true).open(&launch.log)?;
    Command::new(&launch.program)
        .args(&launch.args)
        .stdin(Stdio::null())
        .stdout(log.try_clone()?)
        .stderr(log)
        .kill_on_drop(true)
        .spawn()
}
