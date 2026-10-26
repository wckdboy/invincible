//! Engines: inference servers the node runs as child processes and never links in, so a crashing
//! engine cannot take the node down. v0 has one kind, llama.cpp's `llama-server`.
//!
//! An engine answers the node and no one else. Its port is on loopback, which every process and
//! every user on the machine can reach, so each engine gets its own random key ([new_key]), in a
//! file only the node's user can read ([Launch::llama_server]), and refuses requests without it;
//! the node sends it on every request ([Engine::authorized]). An engine that answers without it
//! is stopped and its model not served ([run_once]): the key is checked, not assumed. And an
//! engine gets only the environment it needs to run ([inherited_env]), never the node's secrets
//! or llama.cpp settings the node did not choose.

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
    /// The key the engine requires ([KEY_FILE_FLAG]); None for one that requires none.
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

/// How llama-server is given its key: the path of a file that holds it. Both llama.cpp and
/// ik_llama.cpp read it (ik_llama.cpp reads no `LLAMA_API_KEY`), and the key is never on the
/// command line, which every user on the machine can read (`ps`): the file is mode 0600.
pub const KEY_FILE_FLAG: &str = "--api-key-file";

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
    /// A key and the file it goes in ([KEY_FILE_FLAG]), written (mode 0600) before each start.
    pub key_file: Option<(PathBuf, String)>,
}

impl Launch {
    /// `llama-server` for [model] on loopback [port], answering only requests that carry [key],
    /// which it reads from [key_file].
    pub fn llama_server(
        engine: &EngineConfig,
        model: &ModelConfig,
        port: u16,
        key: &str,
        key_file: &Path,
        logs: &Path,
    ) -> Self {
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
            KEY_FILE_FLAG.to_owned(),
            key_file.display().to_string(),
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
            env: Vec::new(),
            key_file: Some((key_file.to_owned(), key.to_owned())),
        }
    }
}

/// Where the key of the [n]th configured model's engine goes: in the node's home, one file per
/// engine.
pub fn key_file(home: &Path, n: usize) -> PathBuf {
    home.join("engines").join(format!("{n}.key"))
}

// By hand, so the key never reaches a log: the environment's names only, the key file's path.
impl std::fmt::Debug for Launch {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let env: Vec<&str> = self.env.iter().map(|(name, _)| name.as_str()).collect();
        f.debug_struct("Launch")
            .field("program", &self.program)
            .field("args", &self.args)
            .field("log", &self.log)
            .field("env", &env)
            .field("key_file", &self.key_file.as_ref().map(|(path, _)| path))
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
/// `ZES_ENABLE_SYSMAN`), and ggml's own switches (`GGML_VK_VISIBLE_DEVICES`, `GGML_METAL_*`), but
/// not those that say where to load code from ([WITHHELD]).
/// The model, its flags and the key are the node's to give, on the command line, in
/// [Launch::env] or in the key file.
const INHERITED_PREFIXES: &[&str] =
    &["LC_", "CUDA_", "HIP_", "ROCR_", "HSA_", "ROCM_", "VK_", "ONEAPI_", "SYCL_", "ZE_", "ZES_", "GGML_"];

/// Words that mark a secret: a name with one is withheld even under a prefix above, since a
/// provider key can be given any name in `api_key_env`.
const SECRET_WORDS: &[&str] = &["KEY", "TOKEN", "SECRET", "PASSWORD", "CREDENTIAL"];

/// Names withheld even under a prefix above: those that say where to load code from, since no
/// engine needs code put into it. ggml's own (as of b11887): `GGML_BACKEND_PATH` names a backend
/// library ggml `dlopen()`s (`ggml_backend_load_all`); the other `GGML_` names a directory or
/// file of compiled device code it loads: ET kernels, Metal shaders, cached OpenCL programs and
/// OpenVINO models. The runtimes': CUDA's `CUDA_INJECTION64_PATH` and ROCm's `HSA_TOOLS_LIB` name
/// a library the runtime loads into the process; the `VK_` names are where the Vulkan loader
/// finds layers, code it loads into the process (an implicit layer into every one, unasked).
/// Which driver to use (`VK_ICD_FILENAMES`) is still inherited: some machines need it to find
/// their GPU at all.
const WITHHELD: &[&str] = &[
    "GGML_BACKEND_PATH",
    "GGML_ET_KERNELS_PATH",
    "GGML_METAL_PATH_RESOURCES",
    "GGML_OPENCL_KERNEL_CACHE_DIR",
    "GGML_OPENVINO_CACHE_DIR",
    "GGML_OPENVINO_COMPILED_MODEL_CACHE_DIR",
    "CUDA_INJECTION64_PATH",
    "HSA_TOOLS_LIB",
    "VK_LAYER_PATH",
    "VK_ADD_LAYER_PATH",
    "VK_IMPLICIT_LAYER_PATH",
    "VK_ADD_IMPLICIT_LAYER_PATH",
];

/// Whether an engine inherits the variable [name] ([INHERITED], [INHERITED_PREFIXES], less
/// [SECRET_WORDS] and [WITHHELD]).
pub fn inherits(name: &str) -> bool {
    let name = name.to_ascii_uppercase();
    (INHERITED.contains(&name.as_str()) || INHERITED_PREFIXES.iter().any(|p| name.starts_with(p)))
        && !SECRET_WORDS.iter().any(|w| name.contains(w))
        && !WITHHELD.contains(&name.as_str())
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
/// [engine]'s health current by polling `GET /health` (200 once the model is loaded). An engine
/// that does not enforce its key is not restarted ([Ended::Unkeyed]): its model stays unhealthy.
/// Dropping or aborting the returned task kills the engine.
pub fn supervise(engine: Engine, launch: Launch) -> JoinHandle<()> {
    tokio::spawn(async move {
        let client = health_client();
        let mut backoff = FIRST_BACKOFF;
        loop {
            let started = Instant::now();
            if run_once(&engine, &launch, &client).await == Ended::Unkeyed {
                return;
            }
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

/// Why [run_once] returned.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Ended {
    /// The engine exited, or did not start: start it again.
    Exited,
    /// It answered a request without its key ([key_check]) and was stopped: it must not be
    /// started again, since it would answer anything on the machine the same way.
    Unkeyed,
}

/// Runs [launch] once, keeping [engine]'s health current, until it exits (or never starts). The
/// probe carries the key too, though llama-server leaves `/health` open. An engine with a key is
/// not healthy until it has refused a request without it; one that answers is stopped.
pub async fn run_once(engine: &Engine, launch: &Launch, client: &reqwest::Client) -> Ended {
    let health = format!("{}/health", engine.base_url);
    let mut child = match spawn(launch) {
        Ok(child) => child,
        Err(e) => {
            tracing::error!(model = %engine.id, "engine did not start: {e}");
            return Ended::Exited;
        }
    };
    tracing::info!(model = %engine.id, url = %engine.base_url, "engine started");
    // Asked once per start, when it is first healthy, and before it serves anything.
    let mut keyed = engine.key().is_none();
    loop {
        tokio::select! {
            status = child.wait() => {
                engine.set_healthy(false);
                tracing::warn!(model = %engine.id, "engine exited: {status:?}");
                return Ended::Exited;
            }
            _ = sleep(HEALTH_INTERVAL) => {
                let probe = engine.authorized(client.get(&health)).send().await;
                let mut ok = matches!(probe, Ok(r) if r.status().is_success());
                if ok && !keyed {
                    match key_check(engine, client).await {
                        KeyCheck::Enforced => keyed = true,
                        KeyCheck::Unknown => ok = false,
                        KeyCheck::Ignored(status) => {
                            engine.set_healthy(false);
                            tracing::error!(
                                model = %engine.id,
                                program = %launch.program.display(),
                                answer = %status,
                                "the engine does not enforce its key: it answered a request without it, \
                                 so anything on this machine could call it past receipts, redaction and \
                                 audit. It is stopped and this model is not served: use a llama-server \
                                 that honours {KEY_FILE_FLAG}"
                            );
                            let _ = child.kill().await;
                            return Ended::Unkeyed;
                        }
                    }
                }
                if ok != engine.healthy() {
                    tracing::info!(model = %engine.id, healthy = ok, "engine health changed");
                }
                engine.set_healthy(ok);
            }
        }
    }
}

/// What an engine did with a request that did not carry its key.
enum KeyCheck {
    /// Refused it (401): the key is enforced.
    Enforced,
    /// Answered it some other way: the key is not enforced.
    Ignored(reqwest::StatusCode),
    /// No answer yet, or not ready (503): ask again.
    Unknown,
}

/// Asks [engine], without its key, for what the key is there to protect: a chat completion.
/// Not `/v1/models`, which ik_llama.cpp leaves open as llama-server leaves `/health`. The body is
/// empty, so an engine that lets the request through rejects it before running anything.
async fn key_check(engine: &Engine, client: &reqwest::Client) -> KeyCheck {
    let url = format!("{}/v1/chat/completions", engine.base_url);
    match client.post(url).json(&serde_json::json!({})).send().await {
        Ok(r) if r.status() == reqwest::StatusCode::UNAUTHORIZED => KeyCheck::Enforced,
        Ok(r) if r.status() == reqwest::StatusCode::SERVICE_UNAVAILABLE => KeyCheck::Unknown,
        Ok(r) => KeyCheck::Ignored(r.status()),
        Err(_) => KeyCheck::Unknown,
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
    if let Some((path, key)) = &launch.key_file {
        crate::fsutil::replace_private(path, &format!("{key}\n")).map_err(std::io::Error::other)?;
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
            "GGML_METAL_DEVICES",
            "GGML_RPC_NO_RDMA",
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
            "GGML_BACKEND_PATH",
            "ggml_backend_path",
            "GGML_ET_KERNELS_PATH",
            "GGML_METAL_PATH_RESOURCES",
            "GGML_OPENCL_KERNEL_CACHE_DIR",
            "GGML_OPENVINO_CACHE_DIR",
            "GGML_OPENVINO_COMPILED_MODEL_CACHE_DIR",
            "CUDA_INJECTION64_PATH",
            "HSA_TOOLS_LIB",
            "VK_LAYER_PATH",
            "VK_ADD_LAYER_PATH",
            "VK_IMPLICIT_LAYER_PATH",
            "VK_ADD_IMPLICIT_LAYER_PATH",
            "vk_layer_path",
            "PYTHONPATH",
            "INVINCIBLE_HOME",
            "NOTIFY_SOCKET",
            "HTTPS_PROXY",
        ] {
            assert!(!inherits(name), "{name}");
        }
    }

    #[test]
    fn the_key_goes_in_a_file_and_on_every_request() {
        let config = crate::config::Config::parse("[[models]]\nid = \"m\"\npath = \"/m.gguf\"\n").unwrap();
        let file = key_file(Path::new("/home"), 0);
        let launch = Launch::llama_server(&config.engine, &config.models[0], 4000, "k3y", &file, Path::new("/logs"));
        let at = launch.args.iter().position(|a| a == KEY_FILE_FLAG).expect("--api-key-file");
        assert_eq!(launch.args[at + 1], "/home/engines/0.key");
        assert_eq!(launch.key_file, Some((file, "k3y".to_owned())));
        // Never on the command line, and not in the environment either.
        assert!(!launch.args.iter().any(|a| a.contains("k3y") || a == "--api-key"), "{:?}", launch.args);
        assert!(launch.env.is_empty(), "{:?}", launch.env);

        let client = reqwest::Client::new();
        let keyed = Engine::attached("m", "http://127.0.0.1:4000", None, false).with_key("k3y");
        let request = keyed.authorized(client.get("http://127.0.0.1:4000/health")).build().unwrap();
        assert_eq!(request.headers()["authorization"], "Bearer k3y");
        // An engine the node did not launch is sent no key.
        let open = Engine::attached("m", "http://127.0.0.1:4000", None, false);
        let request = open.authorized(client.get("http://127.0.0.1:4000/health")).build().unwrap();
        assert!(request.headers().get("authorization").is_none());
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn the_key_file_is_written_for_the_owner_alone_before_each_start() {
        use std::os::unix::fs::PermissionsExt;
        let dir = std::env::temp_dir().join(format!("invincible-key-file-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let file = key_file(&dir, 3);
        let launch = Launch {
            program: "/nonexistent/llama-server".into(),
            args: vec![KEY_FILE_FLAG.into(), file.display().to_string()],
            log: dir.join("logs/m.log"),
            env: vec![],
            key_file: Some((file.clone(), "k3y".into())),
        };
        // Written even when the program then cannot start, and again (whole) at the next start.
        assert!(spawn(&launch).is_err());
        std::fs::write(&file, "stale").unwrap();
        assert!(spawn(&launch).is_err());
        assert_eq!(std::fs::read_to_string(&file).unwrap(), "k3y\n");
        assert_eq!(std::fs::metadata(&file).unwrap().permissions().mode() & 0o777, 0o600);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn the_key_is_never_printed() {
        let config = crate::config::Config::parse("[[models]]\nid = \"m\"\npath = \"/m.gguf\"\n").unwrap();
        let file = key_file(Path::new("/home"), 0);
        let launch = Launch::llama_server(&config.engine, &config.models[0], 4000, "k3y", &file, Path::new("/logs"));
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
