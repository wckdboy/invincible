//! The `invincible` command.

use std::io::Read;
use std::path::PathBuf;
use std::process::ExitCode;
use std::sync::Arc;

use clap::{Parser, Subcommand};
use invincible::brand;
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
    /// Cloud models (OpenAI-compatible APIs): add one with its key, list, remove.
    Cloud {
        #[command(subcommand)]
        action: CloudAction,
    },
    /// Run a task file against models the node serves, checking every answer by rule (spec/evals.md).
    Eval {
        /// The tasks (JSON Lines).
        tasks: PathBuf,
        /// A model to run them on, by id or `auto`; repeat to compare.
        #[arg(long = "model", required = true)]
        models: Vec<String>,
        /// Answer the router's "ask" for cloud models (they are refused otherwise).
        #[arg(long)]
        confirm: bool,
        /// Let thinking models think first (with an 8192-token budget); by default they are asked
        /// to answer directly.
        #[arg(long)]
        thinking: bool,
        /// Write every answer and check here (JSON).
        #[arg(long)]
        out: Option<PathBuf>,
        /// Only tasks with this tag.
        #[arg(long)]
        tag: Option<String>,
        #[arg(long)]
        config: Option<PathBuf>,
    },
    /// Show what the node answered and what left it (the audit log, spec/audit.md).
    Audit {
        /// Only entries this recent: `30m`, `24h`, `7d`.
        #[arg(long)]
        since: Option<String>,
        /// At most this many entries (the newest).
        #[arg(long, default_value_t = 30)]
        limit: usize,
        /// Totals per model and per host reached, instead of the entries.
        #[arg(long)]
        summary: bool,
        /// Check the log's chain and every receipt's signature.
        #[arg(long)]
        verify: bool,
        /// Print JSON.
        #[arg(long)]
        json: bool,
    },
    /// Print where a request would run, given a routing input (spec/routing.md) as JSON.
    Route {
        /// The input file; reads stdin when absent or `-`.
        file: Option<PathBuf>,
    },
}

#[derive(Subcommand)]
enum CloudAction {
    /// Add a cloud model: PROVIDER is deepseek, anthropic, openai, openrouter, or custom (with
    /// --base-url). The API key is read from --key-file, or asked for (not shown as you type),
    /// and kept in $INVINCIBLE_HOME/keys (0600). Requests to it are redacted and receipted, and
    /// the router asks before using it unless [node] egress = "auto".
    Add {
        provider: String,
        /// The id requests and `autobot code --model` use [default: the provider's name].
        #[arg(long)]
        id: Option<String>,
        /// The provider's model name [default: the provider's usual one, where there is one].
        #[arg(long)]
        model: Option<String>,
        /// The OpenAI-compatible API base (for custom).
        #[arg(long)]
        base_url: Option<String>,
        /// Its context, in tokens.
        #[arg(long)]
        context: Option<u64>,
        /// What it does with requests: no-retention, retention:<days>, trains, unknown.
        #[arg(long)]
        policy: Option<String>,
        /// Read the key from this file (it is copied into the gateway's keys).
        #[arg(long)]
        key_file: Option<PathBuf>,
        #[arg(long)]
        config: Option<PathBuf>,
        /// Without the next steps (for `autobot setup`, which goes on to them).
        #[arg(long, hide = true)]
        quiet: bool,
        /// Read the key as a line from stdin (for programs).
        #[arg(long, hide = true)]
        key_stdin: bool,
    },
    /// List the cloud models.
    List {
        #[arg(long)]
        config: Option<PathBuf>,
    },
    /// Remove a cloud model, and its key.
    Remove {
        id: String,
        #[arg(long)]
        config: Option<PathBuf>,
    },
}

/// How to restart the gateway so it reads its config again.
/// The home the gateway service uses (its INVINCIBLE_HOME, or ~/.invincible), when there is a
/// service.
fn service_home() -> Option<std::path::PathBuf> {
    let user = std::path::PathBuf::from(std::env::var_os("HOME")?);
    let file = if cfg!(target_os = "macos") {
        user.join("Library/LaunchAgents/sh.invincible.gateway.plist")
    } else {
        user.join(".config/systemd/user/invincible.service")
    };
    let text = std::fs::read_to_string(file).ok()?;
    // `INVINCIBLE_HOME=/x` (systemd) or `<key>INVINCIBLE_HOME</key><string>/x</string>` (launchd).
    let set = text.split_once("INVINCIBLE_HOME").map(|(_, rest)| {
        let rest = rest.trim_start_matches(['=', '<', '/', 'k', 'e', 'y', '>']).trim_start();
        let rest = rest.strip_prefix("<string>").unwrap_or(rest);
        rest.split(['<', '"', '\n']).next().unwrap_or_default().trim().to_owned()
    });
    Some(set.filter(|h| !h.is_empty()).map(std::path::PathBuf::from).unwrap_or_else(|| user.join(".invincible")))
}

fn same(a: &std::path::Path, b: &std::path::Path) -> bool {
    match (a.canonicalize(), b.canonicalize()) {
        (Ok(a), Ok(b)) => a == b,
        _ => a == b,
    }
}

/// The gateway reads its config when it starts: restarts it when it runs as a service with
/// [config_path] (the default config), and says how otherwise.
fn restart_gateway(config_path: &std::path::Path, home: &std::path::Path) {
    use std::process::{Command, Stdio};
    let quiet = |c: &mut Command| c.stdout(Stdio::null()).stderr(Stdio::null()).status().is_ok_and(|s| s.success());
    let default = config_path == home.join("config.toml") && service_home().is_some_and(|served| same(&served, home));
    let restarted = default
        && if cfg!(target_os = "macos") {
            let uid =
                Command::new("id").arg("-u").output().map(|o| String::from_utf8_lossy(&o.stdout).trim().to_owned());
            uid.is_ok_and(|uid| {
                let label = format!("gui/{uid}/sh.invincible.gateway");
                quiet(Command::new("launchctl").args(["print", &label]))
                    && quiet(Command::new("launchctl").args(["kickstart", "-k", &label]))
            })
        } else {
            quiet(Command::new("systemctl").args(["--user", "is-active", "--quiet", "invincible.service"]))
                && quiet(Command::new("systemctl").args(["--user", "restart", "invincible.service"]))
        };
    if restarted {
        println!("{}", brand::ok("restarted the gateway service; it uses the change now"));
    } else {
        println!("{}", brand::warn("restart the gateway (`invincible serve`) for this to take effect"));
    }
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

fn cloud_command(action: CloudAction) -> Result<(), String> {
    use invincible::cloud;
    let home = config::home()?;
    match action {
        CloudAction::Add { provider, id, model, base_url, context, policy, key_file, config, quiet, key_stdin } => {
            let config_path = config.unwrap_or_else(|| home.join("config.toml"));
            let preset = cloud::preset(&provider);
            if preset.is_none() && provider != "custom" {
                let names: Vec<&str> = cloud::PRESETS.iter().map(|p| p.name).collect();
                return Err(format!("{provider:?}: one of {}, or custom with --base-url", names.join(", ")));
            }
            let base_url = base_url
                .or(preset.map(|p| p.base_url.to_owned()))
                .ok_or("custom needs --base-url (an OpenAI-compatible API, e.g. https://host/v1)")?;
            let model = model
                .or(preset.and_then(|p| p.model.map(str::to_owned)))
                .ok_or(format!("{provider} needs --model (the provider's model name)"))?;
            invincible::egress::check(&base_url).map_err(|e| format!("--base-url: {e}"))?;
            let id = id.unwrap_or_else(|| provider.clone());
            if id.is_empty() || !id.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.')) {
                return Err(format!("{id:?}: an id is letters, digits, -, _ and ."));
            }
            let policy = policy.or(preset.map(|p| p.data_policy.to_owned())).unwrap_or_else(|| "unknown".to_owned());
            let context = context.or(preset.and_then(|p| p.context));
            let current = match fsutil::read_optional(&config_path)? {
                Some(text) => Config::parse(&text).map_err(|e| format!("{}: {e}", config_path.display()))?,
                None => Config::parse("")?,
            };
            if current.cloud.iter().any(|c| c.id == id) || current.models.iter().any(|m| m.id == id) {
                return Err(format!("there is a model {id:?} already (--id to name this one differently)"));
            }
            if model.trim().is_empty() {
                return Err(format!("{provider} needs --model (the provider's model name)"));
            }
            let key = match key_file {
                Some(file) => {
                    let key = std::fs::read_to_string(&file).map_err(|e| format!("{}: {e}", file.display()))?;
                    key.trim().to_owned()
                }
                None if key_stdin => {
                    let mut line = String::new();
                    std::io::stdin().read_line(&mut line).map_err(|e| e.to_string())?;
                    line.trim().to_owned()
                }
                None => invincible::term::read_hidden(&format!("API key for {id} ({base_url}): "))?,
            };
            let dir = config_path.parent().map(std::path::Path::to_path_buf).unwrap_or_else(|| home.clone());
            let keys = dir.join("keys");
            std::fs::create_dir_all(&keys).map_err(|e| format!("{}: {e}", keys.display()))?;
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                let _ = std::fs::set_permissions(&keys, std::fs::Permissions::from_mode(0o700));
            }
            if key.is_empty() {
                return Err("the key is empty".to_owned());
            }
            // Absolute: the gateway finds it whichever config it is started with.
            let key_path = keys.join(&id);
            let key_rel = key_path.display().to_string();
            fsutil::replace_private(&key_path, &key)?;
            let entry = cloud::Entry {
                id: &id,
                upstream_model: &model,
                base_url: &base_url,
                api_key_file: Some(&key_rel),
                context,
                data_policy: &policy,
            };
            if let Err(e) = cloud::add_to_config(&config_path, &entry) {
                let _ = std::fs::remove_file(&key_path);
                return Err(e);
            }
            println!(
                "{}",
                brand::ok(&format!(
                    "added {} {}",
                    brand::bold(&id),
                    brand::ash(&format!(
                        "{model} at {base_url} · data policy {policy} · key in {}",
                        key_path.display()
                    ))
                ))
            );
            if current.node.egress == "never" {
                cloud::set_egress(&config_path, "ask")?;
                println!(
                    "{}",
                    brand::warn(
                        "[node] egress was \"never\"; now \"ask\": the router asks before a turn goes to a cloud model"
                    )
                );
            }
            if current.node.network == "offline" {
                println!(
                    "{}",
                    brand::warn(
                        "[node] network is \"offline\", so nothing reaches it until you set network = \"direct\" (or tor/socks5)"
                    )
                );
            }
            restart_gateway(&config_path, &home);
            if !quiet {
                println!("\n  {} {}", brand::ash("next"), format_args!("autobot code --model {id}"));
            }
            Ok(())
        }
        CloudAction::List { config } => {
            let config = Config::load(&config.unwrap_or_else(|| home.join("config.toml")))?;
            if config.cloud.is_empty() {
                println!("{}", brand::ash("no cloud models (add one with `invincible cloud add anthropic`)"));
            }
            let rows: Vec<Vec<String>> = config
                .cloud
                .iter()
                .map(|c| {
                    let key = match c.key(&home) {
                        Ok(Some(_)) => brand::ash("key set"),
                        Ok(None) => brand::warn("no key"),
                        Err(_) => brand::fail("key missing"),
                    };
                    vec![
                        c.id.clone(),
                        c.upstream_model.clone().unwrap_or_else(|| c.id.clone()),
                        brand::ash(&c.base_url),
                        brand::ash(&c.data_policy.to_string()),
                        key,
                    ]
                })
                .collect();
            print!("{}", brand::table(&rows));
            println!(
                "\n{}",
                brand::rows(&[
                    ("egress", config.node.egress.to_string()),
                    ("network", config.node.network.to_string())
                ])
                .trim_end()
            );
            Ok(())
        }
        CloudAction::Remove { id, config } => {
            let config_path = config.unwrap_or_else(|| home.join("config.toml"));
            let current = Config::load(&config_path)?;
            let key = current.cloud.iter().find(|c| c.id == id).and_then(|c| c.api_key_file.clone());
            if !cloud::remove_from_config(&config_path, &id)? {
                return Err(format!("no cloud model {id:?}"));
            }
            // Its key, when `cloud add` put it in the keys directory.
            let dir = config_path.parent().map(std::path::Path::to_path_buf).unwrap_or_else(|| home.clone());
            if let Some(key) = key {
                let key = if key.is_absolute() { key } else { dir.join(key) };
                if key.parent() == Some(dir.join("keys").as_path()) {
                    let _ = std::fs::remove_file(key);
                }
            }
            println!("{}", brand::ok(&format!("removed {id}")));
            restart_gateway(&config_path, &home);
            Ok(())
        }
    }
}

fn main() -> ExitCode {
    brand::init();
    match run(Cli::parse()) {
        Ok(()) => ExitCode::SUCCESS,
        Err(message) => {
            eprintln!("{}", brand::error_line(brand::Product::Invincible, &message));
            ExitCode::FAILURE
        }
    }
}

fn run(cli: Cli) -> Result<(), String> {
    match cli.command {
        Command::Serve { config } => {
            let home = config::home()?;
            // A path given on the command line must exist; without one, a node that was never set up
            // starts with the defaults (offline, no models) instead of failing in a restart loop.
            let config = match config {
                Some(path) => Config::load(&path)?,
                None => match fsutil::read_optional(&home.join("config.toml"))? {
                    Some(text) => {
                        Config::parse(&text).map_err(|e| format!("{}: {e}", home.join("config.toml").display()))?
                    }
                    None => Config::parse("")?,
                },
            };
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
                println!("{}", brand::ash("no paired devices (`invincible pair` shows a code)"));
            }
            let rows: Vec<Vec<String>> = devices
                .iter()
                .map(|device| {
                    let key = device["key"].as_str().and_then(|k| {
                        use base64::Engine as _;
                        base64::engine::general_purpose::URL_SAFE_NO_PAD.decode(k).ok()
                    });
                    vec![
                        device["name"].as_str().unwrap_or("?").to_owned(),
                        brand::ash(&key.map(|k| fingerprint(&k)).unwrap_or_default()),
                    ]
                })
                .collect();
            print!("{}", brand::table(&rows));
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
                receipt_key: paired.receipt_key.clone(),
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
            let token = token::load_or_create(&home.join("token"))?;
            tracing_subscriber::fmt().with_target(false).init();
            let runtime = tokio::runtime::Runtime::new().map_err(|e| format!("runtime: {e}"))?;
            runtime.block_on(async {
                let listener = tokio::net::TcpListener::bind(listen).await.map_err(|e| format!("{listen}: {e}"))?;
                tracing::info!(
                    "node \"{}\" reachable at http://{listen}, with this machine's token (`invincible token`)",
                    known.name
                );
                tokio::select! {
                    () = remote::tunnel(listener, known.addrs, key, device, token) => {}
                    () = shutdown_signal() => {}
                }
                Ok(())
            })
        }
        Command::Cloud { action } => cloud_command(action),
        Command::Model { action: ModelAction::List { config } } => {
            let home = config::home()?;
            let config = Config::load(&config.unwrap_or_else(|| home.join("config.toml")))?;
            if config.models.is_empty() {
                println!("{}", brand::ash("no models (add one with `invincible model add`)"));
            }
            let rows: Vec<Vec<String>> = config
                .models
                .iter()
                .map(|model| {
                    let size = std::fs::metadata(&model.path).map(|m| models::gib(m.len())).unwrap_or("missing".into());
                    let context = model.context.map(|c| format!("context {c}")).unwrap_or_default();
                    vec![model.id.clone(), size, brand::ash(&context), brand::ash(&model.path.display().to_string())]
                })
                .collect();
            print!("{}", brand::table(&rows));
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
        Command::Eval { tasks, models, confirm, thinking, out, tag, config } => {
            let home = config::home()?;
            let path = config.unwrap_or_else(|| home.join("config.toml"));
            let config = match fsutil::read_optional(&path)? {
                Some(text) => Config::parse(&text).map_err(|e| format!("{}: {e}", path.display()))?,
                None => Config::parse("")?,
            };
            let text = std::fs::read_to_string(&tasks).map_err(|e| format!("{}: {e}", tasks.display()))?;
            let mut list = invincible::eval::parse_tasks(&text).map_err(|e| format!("{}: {e}", tasks.display()))?;
            if let Some(tag) = &tag {
                list.retain(|t| t.tags.contains(tag));
            }
            let token = token::load_or_create(&home.join("token"))?;
            let base = format!("http://{}/v1", config.listen);
            let client = reqwest::Client::builder().no_proxy().build().map_err(|e| e.to_string())?;
            let runtime = tokio::runtime::Runtime::new().map_err(|e| format!("runtime: {e}"))?;
            let results = runtime.block_on(async {
                let mut results = Vec::new();
                for model in &models {
                    eprintln!("{model}: {} tasks", list.len());
                    let options = invincible::eval::RunOptions { confirmed: confirm, thinking };
                    let outcomes = invincible::eval::run_model(&client, &base, &token, model, &list, options, |o| {
                        let mark = if o.pass { "✓" } else { "✗" };
                        let why = o.error.clone().unwrap_or_else(|| o.failed.join("; "));
                        eprintln!(
                            "  {mark} {} ({:.1} s){}",
                            o.task,
                            o.latency_ms as f64 / 1000.0,
                            if why.is_empty() { String::new() } else { format!(": {why}") }
                        );
                    })
                    .await;
                    results.push((model.clone(), outcomes));
                }
                results
            });
            println!("{}", invincible::eval::report(&list, &results));
            if let Some(out) = out {
                let json: serde_json::Value = results
                    .iter()
                    .map(|(m, o)| (m.clone(), serde_json::to_value(o).unwrap_or_default()))
                    .collect::<serde_json::Map<_, _>>()
                    .into();
                std::fs::write(&out, serde_json::to_string_pretty(&json).map_err(|e| e.to_string())?)
                    .map_err(|e| format!("{}: {e}", out.display()))?;
            }
            Ok(())
        }
        Command::Audit { since, limit, summary, verify, json } => {
            let home = config::home()?;
            let log = invincible::audit::AuditLog::new(&home);
            if verify {
                let key = invincible::receipts::ReceiptKey::load_or_create(&home.join("receipt.key"))?;
                let n = log.verify(&key.public())?;
                println!("audit log intact: {n} entries, every receipt signed by this node");
                return Ok(());
            }
            let since = match since {
                Some(s) => {
                    let seconds = parse_age(&s).ok_or_else(|| format!("--since {s:?}: use 30m, 24h or 7d"))?;
                    let now = std::time::SystemTime::now()
                        .duration_since(std::time::UNIX_EPOCH)
                        .map(|d| d.as_secs())
                        .unwrap_or_default();
                    now.saturating_sub(seconds)
                }
                None => 0,
            };
            let entries = log.read(since, if summary { usize::MAX } else { limit });
            if summary {
                let totals = invincible::audit::summary(&entries);
                if json {
                    println!("{}", serde_json::to_string_pretty(&totals).map_err(|e| e.to_string())?);
                    return Ok(());
                }
                println!(
                    "{} requests: {} ran, {} refused or asked",
                    totals["requests"], totals["ran"], totals["refused"]
                );
                for m in totals["models"].as_array().into_iter().flatten() {
                    println!(
                        "  {:<24} {:>6} requests  {:>9} tokens in  {:>9} out",
                        m["model"].as_str().unwrap_or("?"),
                        m["requests"],
                        m["tokens_in"],
                        m["tokens_out"]
                    );
                }
                let egress = totals["egress"].as_array().cloned().unwrap_or_default();
                if egress.is_empty() {
                    println!("nothing left the node");
                }
                for h in &egress {
                    println!(
                        "  left for {:<20} {:>6} requests  {:>10} bytes sent  {:>10} received",
                        h["host"].as_str().unwrap_or("?"),
                        h["requests"],
                        h["bytes_sent"],
                        h["bytes_received"]
                    );
                }
                return Ok(());
            }
            if json {
                println!("{}", serde_json::to_string_pretty(&entries).map_err(|e| e.to_string())?);
                return Ok(());
            }
            if entries.is_empty() {
                println!("no requests logged{}", if since > 0 { " in that time" } else { " yet" });
            }
            for entry in &entries {
                println!("{}", audit_line(entry));
            }
            Ok(())
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
    if engines.is_empty() && config.cloud.is_empty() {
        tracing::warn!(
            "no models configured: every request will be blocked (`invincible model add` or `invincible cloud add`)"
        );
    } else if engines.is_empty() {
        tracing::info!("no local models: requests go to cloud models only, so private ones are refused");
    }

    let mut cloud = Vec::new();
    for c in &config.cloud {
        let policy = invincible_policy::DataPolicy::parse(&c.data_policy);
        let upstream = c.upstream_model.clone().unwrap_or_else(|| c.id.clone());
        let model = match c.key(&home) {
            Ok(key) => invincible::cloud::CloudModel::new(&c.id, &upstream, &c.base_url, key, c.context, policy),
            Err(e) => {
                tracing::warn!(model = %c.id, "cloud backend disabled: {e}");
                invincible::cloud::CloudModel::new(&c.id, &upstream, &c.base_url, None, c.context, policy).disabled()
            }
        };
        cloud.push(model);
    }
    if !config.cloud.is_empty() && config.node.settings().network.is_offline() {
        tracing::info!("the node is offline: cloud backends are configured but will not be used");
    }
    // The node's token goes to the agent with every request: only to this machine.
    let agent = reqwest::Url::parse(&config.agent.url).map_err(|e| format!("[agent] url: {e}"))?;
    if agent.scheme() != "http"
        || !agent.host_str().is_some_and(|h| {
            h == "localhost" || h.trim_matches(['[', ']']).parse::<std::net::IpAddr>().is_ok_and(|ip| ip.is_loopback())
        })
    {
        return Err(format!(
            "[agent] url = {:?}: must be http on loopback (the agent runs on this machine)",
            config.agent.url
        ));
    }
    let receipt_key = invincible::receipts::ReceiptKey::load_or_create(&home.join("receipt.key"))?;
    let receipt_public = receipt_key.public();
    let mut state = AppState::new(engines, config.node.settings(), token)
        .with_cloud(cloud)
        .with_receipt_key(&config.remote.name(), receipt_key)
        .with_audit(invincible::audit::AuditLog::new(&home))
        .with_agent(&config.agent.url);
    if config.remote.enabled() {
        let pairing = Arc::new(
            Pairing::new(
                StaticKey::load_or_create(&home.join("node.key"))?,
                config.remote.name(),
                config.remote.advertised(),
                Devices::load(&home.join("devices.json"))?,
            )
            .with_receipt_key(receipt_public),
        );
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
        .with_graceful_shutdown(shutdown_signal())
        .await
        .map_err(|e| e.to_string())?;
    for supervisor in supervisors {
        supervisor.abort();
    }
    Ok(())
}

/// `30m`, `24h`, `7d` in seconds.
fn parse_age(text: &str) -> Option<u64> {
    let text = text.trim();
    let (n, unit) = text.split_at(text.find(|c: char| !c.is_ascii_digit())?);
    let n: u64 = n.parse().ok()?;
    Some(
        n * match unit {
            "s" => 1,
            "m" => 60,
            "h" => 3600,
            "d" => 86_400,
            _ => return None,
        },
    )
}

/// One audit entry as a line: when, who, where it ran, tokens, what left.
fn audit_line(entry: &serde_json::Value) -> String {
    let at = entry["at"]
        .as_i64()
        .and_then(|t| chrono::DateTime::from_timestamp(t, 0))
        .map_or_else(|| "?".to_owned(), |t| t.with_timezone(&chrono::Local).format("%Y-%m-%d %H:%M:%S").to_string());
    let receipt = &entry["receipt"]["receipt"];
    let decision = &receipt["decision"];
    let mut who = entry["caller"].as_str().unwrap_or("?").to_owned();
    if let Some(client) = entry["client"].as_str() {
        who = format!("{who} ({client})");
    }
    let what = match decision["action"].as_str() {
        Some("run") => {
            format!("{} on {}", decision["model"].as_str().unwrap_or("?"), decision["tier"].as_str().unwrap_or("?"))
        }
        Some(action) => format!("{action}: {}", decision["reason"].as_str().unwrap_or("?")),
        None => "?".to_owned(),
    };
    let tokens =
        receipt["tokens"].as_object().map(|t| format!("{}→{} tokens", t["input"], t["output"])).unwrap_or_default();
    let egress: Vec<String> = receipt["egress"]
        .as_array()
        .into_iter()
        .flatten()
        .map(|e| {
            format!(
                "{} via {}{}",
                e["host"].as_str().unwrap_or("?"),
                e["route"].as_str().unwrap_or("?"),
                if e["ok"] == false { " (failed)" } else { "" }
            )
        })
        .collect();
    let left = if egress.is_empty() { "nothing left".to_owned() } else { format!("left: {}", egress.join(", ")) };
    format!("{at}  {who:<22} {what:<32} {tokens:<18} {left}")
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
    /// The node's receipt key, pinned at pairing.
    #[serde(default)]
    receipt_key: Option<String>,
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

/// Ctrl-C, or SIGTERM: what launchd, systemd and `kill` send to stop a service. Both shut down
/// cleanly, so the engines the node started are stopped with it.
async fn shutdown_signal() {
    #[cfg(unix)]
    {
        let mut term = match tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate()) {
            Ok(term) => term,
            Err(_) => {
                let _ = tokio::signal::ctrl_c().await;
                return;
            }
        };
        tokio::select! {
            _ = tokio::signal::ctrl_c() => {}
            _ = term.recv() => {}
        }
    }
    #[cfg(not(unix))]
    {
        let _ = tokio::signal::ctrl_c().await;
    }
}
