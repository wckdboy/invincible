//! The `invincible` command.

use std::io::Read;
use std::path::PathBuf;
use std::process::ExitCode;
use std::sync::Arc;

use clap::{Parser, Subcommand};
use invincible::config::{self, Config};
use invincible::devices::{Devices, StaticKey, fingerprint};
use invincible::engine::{self, Engine, Launch};
use invincible::remote::{self, Pairing, PairingCode};
use invincible::server::{self, AppState};
use invincible::{fsutil, models, token};
use invincible_policy::{RouteInput, decide};
use serde::{Deserialize, Serialize};

#[derive(Parser)]
#[command(version, about = "Intelligence that never relies solely on frontier labs, corporations or countries.")]
struct Cli {
    #[command(subcommand)]
    command: Command,
}

#[derive(Subcommand)]
enum Command {
    /// Run the node: start the engines and serve the local API.
    Serve {
        /// The configuration file [default: $INVINCIBLE_HOME/config.toml].
        #[arg(long)]
        config: Option<PathBuf>,
    },
    /// Print the local API token (created on first use).
    Token,
    /// Show a one-time code (and QR code) that pairs a device with this node.
    Pair {
        #[arg(long)]
        config: Option<PathBuf>,
    },
    /// List the paired devices, or unpair one.
    Devices {
        #[arg(long)]
        config: Option<PathBuf>,
        /// Unpair the device with this name.
        #[arg(long)]
        remove: Option<String>,
    },
    /// Pair this machine, as a device, with a node, using the code the node showed.
    Join {
        code: String,
        /// The name the node lists this device under.
        #[arg(long, default_value = "device")]
        name: String,
    },
    /// Reach a paired node through a local, plain-HTTP door (each connection is an encrypted session).
    Tunnel {
        /// Which node, by name [default: the only one].
        #[arg(long)]
        node: Option<String>,
        #[arg(long, default_value = "127.0.0.1:7780")]
        listen: std::net::SocketAddr,
    },
    /// Add or list the models this node serves.
    Model {
        #[command(subcommand)]
        action: ModelAction,
    },
    /// Print where a request would run, given a routing input (spec/routing.md) as JSON.
    Route {
        /// The input file; reads stdin when absent or `-`.
        file: Option<PathBuf>,
    },
}

#[derive(Subcommand)]
enum ModelAction {
    /// Download a model, verify its SHA-256, check it fits, and add it to the config.
    Add {
        /// The id requests use for it.
        id: String,
        /// `hf:<owner>/<repo>/<file>` or an HTTPS URL.
        source: String,
        /// The expected SHA-256. Required for a URL; for Hugging Face it pins the hash instead of
        /// trusting the listing.
        #[arg(long)]
        sha256: Option<String>,
        /// Context window to serve it with.
        #[arg(long)]
        context: Option<u64>,
        /// Network for this download (offline, direct, tor:<host>:<port>, socks5:<host>:<port>)
        /// [default: the config's [node] network].
        #[arg(long)]
        network: Option<String>,
        /// Add it even when it looks too big for this machine.
        #[arg(long)]
        force: bool,
        #[arg(long)]
        config: Option<PathBuf>,
    },
    /// List the configured models.
    List {
        #[arg(long)]
        config: Option<PathBuf>,
    },
}

fn main() -> ExitCode {
    match run(Cli::parse()) {
        Ok(()) => ExitCode::SUCCESS,
        Err(message) => {
            eprintln!("invincible: {message}");
            ExitCode::FAILURE
        }
    }
}

fn run(cli: Cli) -> Result<(), String> {
    match cli.command {
        Command::Serve { config } => {
            let home = config::home()?;
            let config = Config::load(&config.unwrap_or_else(|| home.join("config.toml")))?;
            let token = token::load_or_create(&home.join("token"))?;
            tracing_subscriber::fmt().with_target(false).init();
            let runtime = tokio::runtime::Runtime::new().map_err(|e| format!("runtime: {e}"))?;
            runtime.block_on(serve(config, token, home))
        }
        Command::Token => {
            println!("{}", token::load_or_create(&config::home()?.join("token"))?);
            Ok(())
        }
        Command::Pair { config } => {
            let reply = admin(config, reqwest::Method::POST, "/v1/admin/pairing")?;
            let code = reply["code"].as_str().ok_or("the node sent no code")?;
            let qr = qrcode::QrCode::new(code.as_bytes()).map_err(|e| e.to_string())?;
            println!("{}", qr.render::<qrcode::render::unicode::Dense1x2>().quiet_zone(true).build());
            println!("{code}\n");
            println!(
                "Node \"{}\", key {}. The code works once, for {} minutes.",
                reply["node"].as_str().unwrap_or("?"),
                reply["fingerprint"].as_str().unwrap_or("?"),
                reply["expires_in"].as_u64().unwrap_or(0) / 60
            );
            Ok(())
        }
        Command::Devices { config, remove } => {
            if let Some(name) = remove {
                admin(config, reqwest::Method::DELETE, &format!("/v1/admin/devices/{name}"))?;
                println!("unpaired {name}");
                return Ok(());
            }
            let reply = admin(config, reqwest::Method::GET, "/v1/admin/devices")?;
            let devices = reply["devices"].as_array().cloned().unwrap_or_default();
            if devices.is_empty() {
                println!("no paired devices");
            }
            for device in devices {
                let key = device["key"].as_str().and_then(|k| {
                    use base64::Engine as _;
                    base64::engine::general_purpose::URL_SAFE_NO_PAD.decode(k).ok()
                });
                println!(
                    "{}  {}",
                    device["name"].as_str().unwrap_or("?"),
                    key.map(|k| fingerprint(&k)).unwrap_or_default()
                );
            }
            Ok(())
        }
        Command::Join { code, name } => {
            let code = PairingCode::decode(&code)?;
            let home = config::home()?;
            let device = StaticKey::load_or_create(&home.join("device.key"))?;
            let runtime = tokio::runtime::Runtime::new().map_err(|e| format!("runtime: {e}"))?;
            let paired = runtime.block_on(remote::pair(&code, &device, &name))?;
            let mut nodes = KnownNodes::load(&home)?;
            nodes.0.retain(|n| n.name != paired.node);
            nodes.0.push(KnownNode {
                name: paired.node.clone(),
                key: {
                    use base64::Engine as _;
                    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(code.node_key)
                },
                addrs: code.addrs.clone(),
            });
            nodes.save(&home)?;
            println!(
                "paired with node \"{}\" (key {}) as \"{}\"",
                paired.node,
                fingerprint(&code.node_key),
                paired.device
            );
            Ok(())
        }
        Command::Tunnel { node, listen } => {
            if !listen.ip().is_loopback() {
                return Err("the tunnel's door must be on loopback".to_owned());
            }
            let home = config::home()?;
            let nodes = KnownNodes::load(&home)?;
            let known = match node {
                Some(name) => {
                    nodes.0.into_iter().find(|n| n.name == name).ok_or(format!("no paired node \"{name}\""))?
                }
                None => match nodes.0.len() {
                    1 => nodes.0.into_iter().next().expect("one node"),
                    0 => return Err("no paired node (see `invincible join`)".to_owned()),
                    _ => return Err("more than one paired node: pick one with --node".to_owned()),
                },
            };
            let key = {
                use base64::Engine as _;
                base64::engine::general_purpose::URL_SAFE_NO_PAD.decode(&known.key).map_err(|e| e.to_string())?
            };
            let device = StaticKey::load_or_create(&home.join("device.key"))?;
            tracing_subscriber::fmt().with_target(false).init();
            let runtime = tokio::runtime::Runtime::new().map_err(|e| format!("runtime: {e}"))?;
            runtime.block_on(async {
                let listener = tokio::net::TcpListener::bind(listen).await.map_err(|e| format!("{listen}: {e}"))?;
                tracing::info!("node \"{}\" reachable at http://{listen}", known.name);
                tokio::select! {
                    () = remote::tunnel(listener, known.addrs, key, device) => {}
                    _ = tokio::signal::ctrl_c() => {}
                }
                Ok(())
            })
        }
        Command::Model { action: ModelAction::List { config } } => {
            let home = config::home()?;
            let config = Config::load(&config.unwrap_or_else(|| home.join("config.toml")))?;
            if config.models.is_empty() {
                println!("no models (add one with `invincible model add`)");
            }
            for model in &config.models {
                let size = std::fs::metadata(&model.path).map(|m| models::gib(m.len())).unwrap_or("missing".into());
                let context = model.context.map(|c| format!("context {c}")).unwrap_or_default();
                println!("{}  {}  {size}  {context}", model.id, model.path.display());
            }
            Ok(())
        }
        Command::Model { action: ModelAction::Add { id, source, sha256, context, network, force, config } } => {
            let home = config::home()?;
            let config_path = config.unwrap_or_else(|| home.join("config.toml"));
            let current = match fsutil::read_optional(&config_path)? {
                Some(text) => Config::parse(&text).map_err(|e| format!("{}: {e}", config_path.display()))?,
                None => Config::parse("")?,
            };
            if current.models.iter().any(|m| m.id == id) {
                return Err(format!("a model with id {id:?} is already configured"));
            }
            let mode = invincible_policy::NetworkMode::decode(network.as_deref().unwrap_or(&current.node.network));
            let client =
                invincible::egress::client(&mode).map_err(|e| format!("{e}; pass --network to download anyway"))?;
            let source = models::Source::parse(&source)?;
            let runtime = tokio::runtime::Runtime::new().map_err(|e| format!("runtime: {e}"))?;
            runtime.block_on(async {
                let (sha, size) = match (&source, sha256) {
                    (models::Source::HuggingFace { repo, file }, pinned) => {
                        let (listed, size) = models::hugging_face_listing(&client, repo, file).await?;
                        match pinned {
                            Some(p) if !p.eq_ignore_ascii_case(&listed) => {
                                return Err(format!("Hugging Face lists SHA-256 {listed}, not the pinned {p}"));
                            }
                            Some(p) => (p.to_ascii_lowercase(), size),
                            None => {
                                eprintln!("SHA-256 {listed} (from Hugging Face's listing; pin it with --sha256)");
                                (listed, size)
                            }
                        }
                    }
                    (models::Source::Url(_), Some(p)) => (p.to_ascii_lowercase(), None),
                    (models::Source::Url(_), None) => return Err("a URL source needs --sha256".to_owned()),
                };
                if sha.len() != 64 || !sha.bytes().all(|b| b.is_ascii_hexdigit()) {
                    return Err(format!("{sha:?} is not a SHA-256"));
                }
                let fit = |size: u64| -> Result<(), String> {
                    let Some(budget) = models::memory_budget() else { return Ok(()) };
                    let need = models::needed(size);
                    if need > budget.bytes && !force {
                        return Err(format!(
                            "needs about {}, more than this machine's budget ({}); pass --force to add it anyway",
                            models::gib(need),
                            budget.source
                        ));
                    }
                    eprintln!("needs about {} of {}", models::gib(need), budget.source);
                    Ok(())
                };
                if let Some(size) = size {
                    fit(size)?;
                }
                let dest = home.join("models").join(source.file_name()?);
                if dest.exists() {
                    return Err(format!(
                        "{} exists already; add it to the config by hand or remove it",
                        dest.display()
                    ));
                }
                let mut last = std::time::Instant::now() - std::time::Duration::from_secs(1);
                models::download(&client, &source.url(), &dest, &sha, |have, total| {
                    if last.elapsed().as_millis() >= 500 || total == Some(have) {
                        last = std::time::Instant::now();
                        match total {
                            Some(t) if t > 0 => {
                                eprint!("\r{} / {} ({}%)   ", models::gib(have), models::gib(t), have * 100 / t)
                            }
                            _ => eprint!("\r{}   ", models::gib(have)),
                        }
                    }
                })
                .await?;
                eprintln!();
                if size.is_none() {
                    let size = std::fs::metadata(&dest).map_err(|e| e.to_string())?.len();
                    fit(size)?;
                }
                models::add_to_config(&config_path, &id, &dest, context)?;
                println!("added {id} ({}); restart the node to serve it", dest.display());
                Ok(())
            })
        }
        Command::Route { file } => {
            let text = match file.filter(|f| f.as_os_str() != "-") {
                Some(path) => std::fs::read_to_string(&path).map_err(|e| format!("{}: {e}", path.display()))?,
                None => {
                    let mut text = String::new();
                    std::io::stdin().read_to_string(&mut text).map_err(|e| format!("stdin: {e}"))?;
                    text
                }
            };
            let input: RouteInput = serde_json::from_str(&text).map_err(|e| format!("routing input: {e}"))?;
            let decision = serde_json::to_string_pretty(&decide(&input)).map_err(|e| e.to_string())?;
            println!("{decision}");
            Ok(())
        }
    }
}

async fn serve(config: Config, token: String, home: PathBuf) -> Result<(), String> {
    let logs = home.join("logs");
    let mut engines = Vec::new();
    // Held until shutdown: dropping a supervisor kills its engine.
    let mut supervisors = Vec::new();
    for model in &config.models {
        let port = engine::free_port().map_err(|e| format!("no free port: {e}"))?;
        let engine = Engine::attached(&model.id, &format!("http://127.0.0.1:{port}"), model.context, false);
        supervisors.push(engine::supervise(engine.clone(), Launch::llama_server(&config.engine, model, port, &logs)));
        engines.push(engine);
    }
    if engines.is_empty() {
        tracing::warn!("no models configured: every request will be blocked (add [[models]] to the config)");
    }

    let mut state = AppState::new(engines, config.node.settings(), token);
    if config.remote.enabled() {
        let pairing = Arc::new(Pairing::new(
            StaticKey::load_or_create(&home.join("node.key"))?,
            config.remote.name(),
            config.remote.advertised(),
            Devices::load(&home.join("devices.json"))?,
        ));
        state = state.with_pairing(pairing);
    }
    let state = Arc::new(state);
    if let Some(pairing) = state.pairing.clone() {
        for addr in &config.remote.listen {
            let listener =
                tokio::net::TcpListener::bind(addr).await.map_err(|e| format!("remote listen on {addr}: {e}"))?;
            tracing::info!(key = %fingerprint(&pairing.key.public), "paired devices can connect on {addr}");
            tokio::spawn(remote::serve(listener, pairing.clone(), server::device_app(state.clone())));
        }
    }
    let listener =
        tokio::net::TcpListener::bind(config.listen).await.map_err(|e| format!("listen on {}: {e}", config.listen))?;
    tracing::info!("serving on http://{}", config.listen);
    axum::serve(listener, server::app(state))
        .with_graceful_shutdown(async {
            let _ = tokio::signal::ctrl_c().await;
        })
        .await
        .map_err(|e| e.to_string())?;
    for supervisor in supervisors {
        supervisor.abort();
    }
    Ok(())
}

/// Calls the running node's admin API on loopback, with the local token.
fn admin(config: Option<PathBuf>, method: reqwest::Method, path: &str) -> Result<serde_json::Value, String> {
    let home = config::home()?;
    let config = Config::load(&config.unwrap_or_else(|| home.join("config.toml")))?;
    let token = token::load_or_create(&home.join("token"))?;
    let runtime = tokio::runtime::Runtime::new().map_err(|e| format!("runtime: {e}"))?;
    runtime.block_on(async {
        let response = reqwest::Client::new()
            .request(method, format!("http://{}{path}", config.listen))
            .bearer_auth(token)
            .send()
            .await
            .map_err(|e| format!("is the node running (`invincible serve`)? {e}"))?;
        let status = response.status();
        let body: serde_json::Value = response.json().await.unwrap_or_default();
        if !status.is_success() {
            return Err(body["error"]["message"].as_str().map_or_else(|| status.to_string(), str::to_owned));
        }
        Ok(body)
    })
}

/// Nodes this machine paired with as a device (`nodes.json`).
#[derive(Default, Serialize, Deserialize)]
struct KnownNodes(Vec<KnownNode>);

#[derive(Serialize, Deserialize)]
struct KnownNode {
    name: String,
    /// Static public key, base64url, pinned at pairing.
    key: String,
    addrs: Vec<String>,
}

impl KnownNodes {
    fn load(home: &std::path::Path) -> Result<Self, String> {
        let path = home.join("nodes.json");
        match fsutil::read_optional(&path)? {
            Some(text) => serde_json::from_str(&text).map_err(|e| format!("{}: {e}", path.display())),
            None => Ok(Self::default()),
        }
    }

    fn save(&self, home: &std::path::Path) -> Result<(), String> {
        fsutil::replace_private(&home.join("nodes.json"), &serde_json::to_string_pretty(self).expect("nodes serialise"))
    }
}
