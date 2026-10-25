//! Engines: inference servers the node runs as child processes and never links in, so a crashing
//! engine cannot take the node down. v0 has one kind, llama.cpp's `llama-server`.
//!
//! An engine answers the node and no one else. Its port is on loopback, which every process and
//! every user on the machine can reach, so each engine gets its own random key ([new_key]) and
//! refuses requests without it; the node sends it on every request ([Engine::authorized]). And
//! an engine gets only the environment it needs to run ([inherited_env]), never the node's
//! secrets or llama.cpp settings the node did not choose.

use std::ffi::OsString;
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
#[derive(Clone)]
pub struct Engine {
    pub id: String,
    pub context: Option<u64>,
    /// Where the engine's OpenAI-compatible API is, e.g. `http://127.0.0.1:41234`.
    pub base_url: String,
    /// Whether it takes images (None: not known).
    pub vision: Option<bool>,
    /// For a model split across paired nodes: which devices hold it now (spec/cluster.md).
    pub cluster: Option<Arc<crate::cluster::ClusterRun>>,
    /// The key the engine requires ([KEY_ENV]); None for one that requires none.
    key: Option<String>,
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
            cluster: None,
            key: None,
            healthy: Arc::new(AtomicBool::new(healthy)),
        }
    }

    /// The same engine, requiring [key] (the one its [Launch] was given).
    pub fn with_key(mut self, key: &str) -> Self {
        self.key = Some(key.to_owned());
        self
    }

    /// The key the engine requires, if any.
    pub fn key(&self) -> Option<&str> {
        self.key.as_deref()
    }

    /// [request] with the engine's key, as llama-server reads it (`Authorization: Bearer`). Every
    /// request the node makes to an engine goes through here.
    pub fn authorized(&self, request: reqwest::RequestBuilder) -> reqwest::RequestBuilder {
        match &self.key {
            Some(key) => request.bearer_auth(key),
            None => request,
        }
    }

    /// The same engine, split across paired nodes as [run] says.
    pub fn with_cluster(mut self, run: Arc<crate::cluster::ClusterRun>) -> Self {
        self.cluster = Some(run);
        self
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

// By hand, so the key never reaches a log.
impl std::fmt::Debug for Engine {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Engine")
            .field("id", &self.id)
            .field("base_url", &self.base_url)
            .field("keyed", &self.key.is_some())
            .field("healthy", &self.healthy())
            .finish_non_exhaustive()
    }
}

/// Where llama-server reads its key from (`--api-key`'s variable in llama.cpp's `common/arg.cpp`).
/// The environment, not the command line: every user on the machine can read a process's
/// arguments (`ps`), and only its own user (and root) its environment.
pub const KEY_ENV: &str = "LLAMA_API_KEY";

/// A fresh key for one engine: 32 random bytes, hex.
pub fn new_key() -> Result<String, String> {
    Ok(crate::token::hex(&crate::token::random::<32>()?))
}

/// What to run for one engine.
#[derive(Clone)]
pub struct Launch {
    pub program: PathBuf,
    pub args: Vec<String>,
    /// The engine's stdout and stderr go here.
    pub log: PathBuf,
    /// Its environment beyond what it inherits ([inherited_env]).
    pub env: Vec<(String, String)>,
}

impl Launch {
    /// `llama-server` for [model] on loopback [port], answering only requests that carry [key].
    pub fn llama_server(engine: &EngineConfig, model: &ModelConfig, port: u16, key: &str, logs: &Path) -> Self {
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
        Self {
            program: engine.llama_server.clone(),
            args,
            log: logs.join(format!("{}.log", model.id)),
            env: vec![(KEY_ENV.to_owned(), key.to_owned())],
        }
    }
}

// By hand, so the key never reaches a log: the environment's names only.
impl std::fmt::Debug for Launch {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let env: Vec<&str> = self.env.iter().map(|(name, _)| name.as_str()).collect();
        f.debug_struct("Launch")
            .field("program", &self.program)
            .field("args", &self.args)
            .field("log", &self.log)
            .field("env", &env)
            .finish()
    }
}

/// Names an engine inherits from the node's environment, compared without case (as Windows
/// does); anything else is withheld. An engine serves HTTP and runs code nobody here reviewed, so
/// it gets no secret (a provider key set for `api_key_env`, a token the shell holds) and no
/// `LLAMA_*`: llama.cpp reads `LLAMA_ARG_*` as its flags (`LLAMA_ARG_TOOLS` and
/// `LLAMA_ARG_AGENT` turn on its file and shell tools), and the node chooses those.
///
/// - `PATH`, `HOME`, the temporary directory, the locale: what any program expects.
/// - The library paths: where GPU runtimes are when not in the system's (CUDA in
///   `/usr/local/cuda`, ROCm in `/opt/rocm`). Not `LD_PRELOAD` or `DYLD_INSERT_LIBRARIES`: no
///   engine needs code put into it.
/// - `SYSTEMROOT`, `WINDIR`, `USERPROFILE`: Windows does not start a process without them.
const INHERITED: &[&str] = &[
    "PATH",
    "HOME",
    "TMPDIR",
    "TMP",
    "TEMP",
    "LANG",
    "LD_LIBRARY_PATH",
    "DYLD_LIBRARY_PATH",
    "DYLD_FALLBACK_LIBRARY_PATH",
    "SYSTEMROOT",
    "WINDIR",
    "USERPROFILE",
];

/// Prefixes an engine inherits: the locale's parts, and which devices the GPU runtimes use and
/// where their drivers are (`CUDA_VISIBLE_DEVICES`; ROCm's `HIP_VISIBLE_DEVICES`,
/// `HSA_OVERRIDE_GFX_VERSION`; Vulkan's `VK_ICD_FILENAMES`; oneAPI's `ONEAPI_DEVICE_SELECTOR`,
/// `ZES_ENABLE_SYSMAN`), and ggml's own switches (`GGML_VK_VISIBLE_DEVICES`, `GGML_METAL_*`).
/// The model, its flags and the key are the node's to give, on the command line or in
/// [Launch::env].
const INHERITED_PREFIXES: &[&str] =
    &["LC_", "CUDA_", "HIP_", "ROCR_", "HSA_", "ROCM_", "VK_", "ONEAPI_", "SYCL_", "ZE_", "ZES_", "GGML_"];

/// Words that mark a secret: a name with one is withheld even under a prefix above, since a
/// provider key can be given any name in `api_key_env`.
const SECRET_WORDS: &[&str] = &["KEY", "TOKEN", "SECRET", "PASSWORD", "CREDENTIAL"];

/// Whether an engine inherits the variable [name] ([INHERITED], [INHERITED_PREFIXES]).
pub fn inherits(name: &str) -> bool {
    let name = name.to_ascii_uppercase();
    (INHERITED.contains(&name.as_str()) || INHERITED_PREFIXES.iter().any(|p| name.starts_with(p)))
        && !SECRET_WORDS.iter().any(|w| name.contains(w))
}

/// The part of the node's environment an engine inherits ([inherits]): what every engine child
/// (`llama-server`, `ggml-rpc-server`, `llama-bench`, the device probes) starts with, after
/// `env_clear`.
pub fn inherited_env() -> Vec<(OsString, OsString)> {
    std::env::vars_os().filter(|(name, _)| name.to_str().is_some_and(inherits)).collect()
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
        let client = health_client();
        let mut backoff = FIRST_BACKOFF;
        loop {
            let started = Instant::now();
            run_once(&engine, &launch, &client).await;
            if started.elapsed() >= STABLE_RUN {
                backoff = FIRST_BACKOFF;
            }
            sleep(backoff).await;
            backoff = (backoff * 2).min(MAX_BACKOFF);
        }
    })
}

/// The client that polls engines' health.
pub fn health_client() -> reqwest::Client {
    crate::egress::local()
        .connect_timeout(Duration::from_secs(1))
        .timeout(Duration::from_secs(2))
        .build()
        .expect("HTTP client")
}

/// Runs [launch] once, keeping [engine]'s health current, until it exits (or never starts). The
/// probe carries the key too, though llama-server leaves `/health` open.
pub async fn run_once(engine: &Engine, launch: &Launch, client: &reqwest::Client) {
    let health = format!("{}/health", engine.base_url);
    match spawn(launch) {
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
                        let probe = engine.authorized(client.get(&health)).send().await;
                        let ok = matches!(probe, Ok(r) if r.status().is_success());
                        if ok != engine.healthy() {
                            tracing::info!(model = %engine.id, healthy = ok, "engine health changed");
                        }
                        engine.set_healthy(ok);
                    }
                }
            }
        }
    }
}

/// Runs [launch] and restarts it whenever it exits, with backoff: for helpers with no health
/// endpoint (`ggml-rpc-server`). Dropping or aborting the task kills the process.
pub fn keep_running(name: &str, launch: Launch) -> JoinHandle<()> {
    let name = name.to_owned();
    tokio::spawn(async move {
        let mut backoff = FIRST_BACKOFF;
        loop {
            let started = Instant::now();
            match spawn(&launch) {
                Err(e) => tracing::error!("{name} did not start: {e}"),
                Ok(mut child) => {
                    tracing::info!("{name} started");
                    let status = child.wait().await;
                    tracing::warn!("{name} exited: {status:?}");
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
        .env_clear()
        .envs(inherited_env())
        .envs(launch.env.iter().map(|(k, v)| (k, v)))
        .stdin(Stdio::null())
        .stdout(log.try_clone()?)
        .stderr(log)
        .kill_on_drop(true)
        .spawn()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_engine_inherits_what_runs_it_and_nothing_else() {
        for name in [
            "PATH",
            "Path",
            "HOME",
            "TMPDIR",
            "LANG",
            "LC_ALL",
            "LD_LIBRARY_PATH",
            "DYLD_FALLBACK_LIBRARY_PATH",
            "SystemRoot",
            "CUDA_VISIBLE_DEVICES",
            "HIP_VISIBLE_DEVICES",
            "HSA_OVERRIDE_GFX_VERSION",
            "VK_ICD_FILENAMES",
            "ONEAPI_DEVICE_SELECTOR",
            "ZES_ENABLE_SYSMAN",
            "GGML_VK_VISIBLE_DEVICES",
        ] {
            assert!(inherits(name), "{name}");
        }
        for name in [
            // Secrets, under any name a shell or `api_key_env` gives them.
            "OPENAI_API_KEY",
            "ANTHROPIC_API_KEY",
            "HF_TOKEN",
            "GH_TOKEN",
            "AWS_SECRET_ACCESS_KEY",
            "CUDA_API_KEY",
            "GGML_TOKEN",
            // llama.cpp settings the node did not choose, a key it did not make among them.
            "LLAMA_ARG_TOOLS",
            "LLAMA_ARG_AGENT",
            "llama_arg_tools",
            "LLAMA_ARG_MCP_SERVERS_JSON",
            "LLAMA_API_KEY",
            "LLAMA_CACHE",
            "MTMD_BACKEND_DEVICE",
            // Code put into the engine, and the node's own settings.
            "LD_PRELOAD",
            "DYLD_INSERT_LIBRARIES",
            "PYTHONPATH",
            "INVINCIBLE_HOME",
            "NOTIFY_SOCKET",
            "HTTPS_PROXY",
        ] {
            assert!(!inherits(name), "{name}");
        }
    }

    #[test]
    fn the_key_goes_in_the_environment_and_on_every_request() {
        let config = crate::config::Config::parse("[[models]]\nid = \"m\"\npath = \"/m.gguf\"\n").unwrap();
        let launch = Launch::llama_server(&config.engine, &config.models[0], 4000, "k3y", Path::new("/logs"));
        assert_eq!(launch.env, [(KEY_ENV.to_owned(), "k3y".to_owned())]);
        assert!(!launch.args.iter().any(|a| a.contains("k3y") || a.starts_with("--api-key")), "{:?}", launch.args);

        let client = reqwest::Client::new();
        let keyed = Engine::attached("m", "http://127.0.0.1:4000", None, false).with_key("k3y");
        let request = keyed.authorized(client.get("http://127.0.0.1:4000/health")).build().unwrap();
        assert_eq!(request.headers()["authorization"], "Bearer k3y");
        // An engine the node did not launch is sent no key.
        let open = Engine::attached("m", "http://127.0.0.1:4000", None, false);
        let request = open.authorized(client.get("http://127.0.0.1:4000/health")).build().unwrap();
        assert!(request.headers().get("authorization").is_none());
    }

    #[test]
    fn the_key_is_never_printed() {
        let config = crate::config::Config::parse("[[models]]\nid = \"m\"\npath = \"/m.gguf\"\n").unwrap();
        let launch = Launch::llama_server(&config.engine, &config.models[0], 4000, "k3y", Path::new("/logs"));
        let engine = Engine::attached("m", "http://127.0.0.1:4000", None, false).with_key("k3y");
        for printed in [format!("{launch:?}"), format!("{engine:?}")] {
            assert!(!printed.contains("k3y"), "{printed}");
        }
    }

    #[test]
    fn every_engine_gets_its_own_key() {
        let (a, b) = (new_key().unwrap(), new_key().unwrap());
        assert_eq!(a.len(), 64);
        assert_ne!(a, b);
    }
}
