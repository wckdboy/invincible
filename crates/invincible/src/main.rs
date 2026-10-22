//! The `invincible` command.

use std::io::Read;
use std::path::PathBuf;
use std::process::ExitCode;
use std::sync::Arc;

use clap::{Parser, Subcommand};
use invincible::brand;
use invincible::config::{self, Config};
use invincible::devices::{Devices, KnownNodes, StaticKey, fingerprint};
use invincible::engine::{self, Engine, Launch};
use invincible::remote::{self, Pairing, PairingCode};
use invincible::server::{self, AppState};
use invincible::{fsutil, models, token};
use invincible_policy::{RouteInput, decide};

#[derive(Parser)]
#[command(version = invincible::version::VERSION, about = "Intelligence that never relies solely on frontier labs, corporations or countries.")]
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
        /// The name the node lists this device under [default: this node's own [remote] name].
        #[arg(long)]
        name: Option<String>,
    },
    /// Reach a paired node through a local, plain-HTTP door (each connection is an encrypted session).
    Tunnel {
        /// Which node, by name [default: the only one].
        #[arg(long)]
        node: Option<String>,
        #[arg(long, default_value = "127.0.0.1:7780")]
        listen: std::net::SocketAddr,
    },
    /// Publish this node's signed descriptor to its seeds. With --lan, also answer mDNS until
    /// stopped. Discovery never pairs anything (spec/discovery.md).
    Announce {
        #[arg(long)]
        config: Option<PathBuf>,
        /// Also answer mDNS on this network, and stay in the foreground while doing it.
        #[arg(long)]
        lan: bool,
    },
    /// Look for Invincible nodes: from [discovery] seeds (or --seed) and, with --lan, this
    /// network. Every record is verified; nothing is paired.
    Discover {
        /// Only nodes that advertise this model id.
        #[arg(long)]
        model: Option<String>,
        /// A seed to ask, in addition to [discovery] seeds. Repeatable.
        #[arg(long = "seed")]
        seeds: Vec<String>,
        /// Also browse mDNS on this network (waits about three seconds).
        #[arg(long)]
        lan: bool,
        #[arg(long)]
        json: bool,
        #[arg(long)]
        config: Option<PathBuf>,
    },
    /// Run a discovery seed: it stores signed descriptors and returns them. It cannot sign or
    /// vouch for anything, and it learns who announces (spec/discovery.md).
    Seed {
        #[arg(long, default_value = "127.0.0.1:7789")]
        listen: std::net::SocketAddr,
        /// How many records it holds (expired ones are dropped as it goes).
        #[arg(long, default_value_t = invincible::discovery::SEED_RECORDS)]
        max_records: usize,
        /// Announces accepted per source address per minute.
        #[arg(long, default_value_t = invincible::discovery::SEED_PER_IP)]
        per_ip_per_min: u32,
    },
    /// The cluster: this node, its paired peers, and the models split across them (spec/cluster.md).
    Cluster {
        #[command(subcommand)]
        action: ClusterAction,
    },
    /// Dispatch: which of the nodes this machine owns would answer a request, and why
    /// (spec/dispatch.md).
    Dispatch {
        #[command(subcommand)]
        action: DispatchAction,
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
    /// Each run is kept in $INVINCIBLE_HOME/evals/history.jsonl; `--history` shows them.
    Eval {
        /// The tasks (JSON Lines).
        #[arg(required_unless_present = "history")]
        tasks: Option<PathBuf>,
        /// A model to run them on, by id or `auto`; repeat to compare.
        #[arg(long = "model", required_unless_present = "history")]
        models: Vec<String>,
        /// Show the runs kept so far (of the task file given, or all) and the local–cloud gap.
        #[arg(long)]
        history: bool,
        /// Do not keep this run in the history.
        #[arg(long)]
        no_record: bool,
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
    /// Measure this machine and what a model runs at on it: `probe`, `bench`, `show`.
    Tune {
        #[command(subcommand)]
        action: TuneAction,
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
    /// Check a receipt offline (spec/receipts.md): its signature, what it binds, and — given the
    /// request and the answer — that they are the ones it names.
    Receipt {
        #[command(subcommand)]
        action: ReceiptAction,
    },
    /// Print where a request would run, given a routing input (spec/routing.md) as JSON.
    Route {
        /// The input file; reads stdin when absent or `-`.
        file: Option<PathBuf>,
    },
    /// Update invincible and autobot to the newest release, checked as the installer checks it
    /// (the release key's signature, then the SHA-256), and restart the services. Nothing checks
    /// for updates unless you run this, or turn on the daily update with --auto.
    Update {
        /// stable (tagged releases) or edge (every commit on main that passed CI) [default:
        /// [update] auto when on, else the channel of the version installed].
        #[arg(long)]
        channel: Option<String>,
        /// Install this version instead of the newest (to go back, too): 0.0.11.
        #[arg(long, conflicts_with = "channel")]
        version: Option<String>,
        /// Only say whether there is an update.
        #[arg(long)]
        check: bool,
        /// Reinstall even when the version installed is the newest.
        #[arg(long)]
        force: bool,
        /// Network for this update (direct, tor:<host>:<port>, socks5:<host>:<port>) [default: the
        /// config's [node] network].
        #[arg(long)]
        network: Option<String>,
        /// Leave the running services as they are (they keep the old binaries until restarted).
        #[arg(long)]
        no_restart: bool,
        /// Update daily on this channel (stable or edge), or `off`: sets [update] auto and
        /// installs or removes the daily job.
        #[arg(long, value_name = "off|stable|edge")]
        auto: Option<String>,
        /// The daily job: updates only when [update] auto is on.
        #[arg(long, hide = true)]
        scheduled: bool,
    },
}

#[derive(Subcommand)]
enum ReceiptAction {
    /// Verify a receipt from a file (or `-` for stdin), or by request id from this node's audit log.
    Verify {
        /// The signed envelope as JSON (a file, `-`, or a request id in this node's audit log).
        receipt: String,
        /// The node's receipt public key, base64url [default: this node's own].
        #[arg(long)]
        key: Option<String>,
        /// The request body as the client sent it: its hash is recomputed and compared.
        #[arg(long)]
        request: Option<PathBuf>,
        /// The answer bytes exactly as the client received them: their hash is recomputed.
        #[arg(long)]
        answer: Option<PathBuf>,
        /// Print the report as JSON.
        #[arg(long)]
        json: bool,
    },
}

#[derive(Subcommand)]
enum ClusterAction {
    /// This node's devices, its peers (probed now, over their paired links), the heads it serves
    /// as a shard, and where each split model runs.
    Status {
        #[arg(long)]
        config: Option<PathBuf>,
        /// Print JSON.
        #[arg(long)]
        json: bool,
    },
}

#[derive(Subcommand)]
enum DispatchAction {
    /// Every candidate node — this one, then each paired node as a fresh probe finds it — and the
    /// node a request for this model would go to.
    Status {
        /// The model the request would name [default: none, an automatic choice].
        #[arg(long)]
        model: Option<String>,
        #[arg(long)]
        config: Option<PathBuf>,
        /// Print JSON.
        #[arg(long)]
        json: bool,
    },
}

#[derive(Subcommand)]
enum TuneAction {
    /// Report the machine, its accelerators and its engines. No personal data.
    Probe {
        /// The JSON, for another program to read.
        #[arg(long)]
        json: bool,
        #[arg(long)]
        config: Option<PathBuf>,
    },
    /// Run llama-bench on one model and keep the numbers the cluster planner reads.
    Bench {
        /// The model id, as `invincible model list` shows it.
        model: String,
        /// The device to measure on [default: the first llama.cpp reports, else CPU].
        #[arg(long)]
        device: Option<String>,
        #[arg(long)]
        config: Option<PathBuf>,
    },
    /// Show what has been measured on this machine.
    Show {
        /// One model id; without it, every model measured here.
        model: Option<String>,
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

/// The home the gateway service uses (its INVINCIBLE_HOME, or ~/.invincible), when there is a
/// service.
fn service_home() -> Option<std::path::PathBuf> {
    use invincible::service;
    let user = std::path::PathBuf::from(std::env::var_os("HOME")?);
    let text =
        std::fs::read_to_string(service::path(service::Platform::current().ok()?, &user, service::GATEWAY)).ok()?;
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
    use invincible::service;
    let default = config_path == home.join("config.toml") && service_home().is_some_and(|served| same(&served, home));
    let restarted = default
        && match (service::Platform::current(), std::env::var_os("HOME")) {
            (Ok(platform), Some(user)) => {
                !service::restart(platform, std::path::Path::new(&user), &[service::GATEWAY]).is_empty()
            }
            _ => false,
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
            let config = config_for(config, &home)?;
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
            // Default to this node's own [remote] name: that is the string the peer's
            // `[cluster] heads` compares against, and "device" can never match what a person
            // would have written there. Passing the *peer's* name here is the mistake that made
            // two correctly configured nodes disagree (spec/cluster.md).
            let name = invincible::config::join_name(name, &home);
            let runtime = tokio::runtime::Runtime::new().map_err(|e| format!("runtime: {e}"))?;
            let paired = runtime.block_on(remote::pair(&code, &device, &name))?;
            // The same record the local API writes for `POST /v1/cluster/join`.
            invincible::membership::record(&home, &code, &paired)?;
            println!(
                "paired with node \"{}\" (key {}) as \"{}\"",
                paired.node,
                fingerprint(&code.node_key),
                paired.device
            );
            println!("on \"{}\", [cluster] heads must name this device as \"{}\"", paired.node, paired.device);
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
        Command::Announce { config, lan } => announce_command(config, lan),
        Command::Discover { model, seeds, lan, json, config } => discover_command(config, model, seeds, lan, json),
        Command::Seed { listen, max_records, per_ip_per_min } => {
            let runtime = tokio::runtime::Runtime::new().map_err(|e| format!("runtime: {e}"))?;
            let seed = std::sync::Arc::new(invincible::discovery::Seed::with_rate(max_records, per_ip_per_min));
            println!(
                "discovery seed on http://{listen} (at most {max_records} records, {per_ip_per_min} announces per address per minute)"
            );
            println!("this seed learns the address and timing of every node that announces to it");
            runtime.block_on(invincible::discovery::serve_seed(seed, listen))
        }
        Command::Cloud { action } => cloud_command(action),
        Command::Cluster { action: ClusterAction::Status { config, json } } => {
            let status = admin(config, reqwest::Method::GET, "/v1/cluster")?;
            if json {
                println!("{}", serde_json::to_string_pretty(&status).expect("json"));
            } else {
                print!("{}", cluster_text(&status));
            }
            Ok(())
        }
        Command::Dispatch { action: DispatchAction::Status { model, config, json } } => {
            let path = match &model {
                Some(model) => format!("/v1/dispatch?model={}", query_value(model)),
                None => "/v1/dispatch".to_owned(),
            };
            let status = admin(config, reqwest::Method::GET, &path)?;
            if json {
                println!("{}", serde_json::to_string_pretty(&status).expect("json"));
            } else {
                print!("{}", dispatch_text(&status));
            }
            Ok(())
        }
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
            let client = invincible::egress::download_client(&mode)
                .map_err(|e| format!("{e}; pass --network to download anyway"))?;
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
        Command::Eval { tasks, models, history, no_record, confirm, thinking, out, tag, config } => {
            let home = config::home()?;
            let suite_of = |path: &std::path::Path| {
                path.file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_else(|| "tasks".to_owned())
            };
            if history {
                let suite = tasks.as_deref().map(|path| match &tag {
                    Some(tag) => format!("{}#{tag}", suite_of(path)),
                    None => suite_of(path),
                });
                println!("{}", invincible::eval::history_report(&invincible::eval::history(&home), suite.as_deref()));
                return Ok(());
            }
            let tasks = tasks.ok_or("a task file to run")?;
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
            let client = invincible::egress::local().build().map_err(|e| e.to_string())?;
            let runtime = tokio::runtime::Runtime::new().map_err(|e| format!("runtime: {e}"))?;
            let (results, tiers) = runtime.block_on(async {
                // Which models are on this machine and which in the cloud, for the history.
                let tiers: std::collections::BTreeMap<String, String> = async {
                    let listed: serde_json::Value = client
                        .get(format!("{base}/models"))
                        .bearer_auth(&token)
                        // Only for the history: a gateway slow to list them does not hold up the run.
                        .timeout(std::time::Duration::from_secs(5))
                        .send()
                        .await
                        .ok()?
                        .json()
                        .await
                        .ok()?;
                    Some(
                        listed["data"]
                            .as_array()?
                            .iter()
                            .filter_map(|m| {
                                Some((m["id"].as_str()?.to_owned(), m["invincible"]["tier"].as_str()?.to_owned()))
                            })
                            .collect(),
                    )
                }
                .await
                .unwrap_or_default();
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
                (results, tiers)
            });
            println!("{}", invincible::eval::report(&list, &results));
            // Kept unless nothing ran (the gateway was not there, say).
            let answered = results.iter().flat_map(|(_, o)| o).any(|o| o.error.is_none());
            if !no_record && answered {
                let run = invincible::eval::Run {
                    at: chrono::Local::now().to_rfc3339_opts(chrono::SecondsFormat::Secs, false),
                    suite: match &tag {
                        Some(tag) => format!("{}#{tag}", suite_of(&tasks)),
                        None => suite_of(&tasks),
                    },
                    digest: invincible::eval::digest(&text, &list.iter().map(|t| t.id.as_str()).collect::<Vec<_>>()),
                    tasks: list.len(),
                    kind: "answers".to_owned(),
                    version: invincible::version::VERSION.to_owned(),
                    models: results
                        .iter()
                        .map(|(m, o)| invincible::eval::model_run(m, tiers.get(m).cloned(), o))
                        .collect(),
                };
                match invincible::eval::record(&home, &run) {
                    Ok(()) => eprintln!(
                        "kept in {} (`invincible eval --history`)",
                        invincible::eval::history_path(&home).display()
                    ),
                    Err(e) => eprintln!("not kept: {e}"),
                }
            }
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
        Command::Tune { action } => {
            let home = config::home()?;
            // A probe is about the machine, so a missing config is not an error.
            let load = |path: Option<PathBuf>| -> Result<Config, String> {
                let path = path.unwrap_or_else(|| home.join("config.toml"));
                match fsutil::read_optional(&path)? {
                    Some(text) => Config::parse(&text).map_err(|e| format!("{}: {e}", path.display())),
                    None => Config::parse(""),
                }
            };
            match action {
                TuneAction::Probe { json, config: path } => {
                    let cfg = load(path)?;
                    let runtime = tokio::runtime::Runtime::new().map_err(|e| format!("runtime: {e}"))?;
                    let probe = runtime.block_on(invincible::tune::probe(Some(&cfg.engine.llama_server)));
                    if json {
                        println!("{}", serde_json::to_string_pretty(&probe).map_err(|e| e.to_string())?);
                    } else {
                        println!("{}", probe.report());
                    }
                }
                TuneAction::Bench { model, device, config: path } => {
                    let cfg = load(path)?;
                    let entry = cfg.models.iter().find(|m| m.id == model).ok_or_else(|| {
                        format!("no model {model:?} in the config (`invincible model list` shows them)")
                    })?;
                    let runtime = tokio::runtime::Runtime::new().map_err(|e| format!("runtime: {e}"))?;
                    let probe = runtime.block_on(invincible::tune::probe(Some(&cfg.engine.llama_server)));
                    let program = probe.llama_bench.clone().ok_or(
                        "llama-bench not found: it ships with llama.cpp (`brew install llama.cpp`, or your CUDA build)",
                    )?;
                    let device = device
                        .or_else(|| probe.devices.first().map(|d| d.name.clone()))
                        .unwrap_or_else(|| "CPU".to_owned());
                    println!("measuring {model} on {device} (this takes a minute)…");
                    let (pp, tg) = invincible::tune::bench(std::path::Path::new(&program), &entry.path, Some(&device))?;
                    let profile = invincible::tune::Profile {
                        device: device.clone(),
                        tg_tps: tg,
                        pp_tps: pp,
                        engine: "llama-bench".to_owned(),
                        at: chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Secs, true),
                    };
                    let set = invincible::tune::record(&home, &model, &invincible::tune::hardware_now(), profile)?;
                    let prompt = pp.map(|p| format!(", prompt {p:.1} tok/s")).unwrap_or_default();
                    println!(
                        "{model} on {device}: {tg:.1} tok/s{prompt} — kept in {} ({} device(s) measured on this machine)",
                        invincible::tune::set_path(&home, &model).display(),
                        set.profiles.len()
                    );
                    println!(
                        "the cluster planner uses these numbers on the next plan; `invincible cluster status` shows it"
                    );
                }
                TuneAction::Show { model } => {
                    let sets = match model {
                        Some(model) => invincible::tune::load(&home, &model).into_iter().collect(),
                        None => invincible::tune::load_all(&home),
                    };
                    if sets.is_empty() {
                        println!("{}", brand::ash("nothing measured yet (`invincible tune bench <model>`)"));
                    }
                    let now = invincible::tune::hardware_now();
                    for set in sets {
                        let current = if set.hardware == now { "this machine" } else { "other hardware, ignored" };
                        println!("{} · {} · {current}", set.model, set.hardware);
                        for p in &set.profiles {
                            let pp = p.pp_tps.map(|v| format!(" · prompt {v:.1}")).unwrap_or_default();
                            println!("  {:<8} {:>8.1} tok/s{pp}  {}", p.device, p.tg_tps, brand::ash(&p.engine));
                        }
                    }
                }
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
        Command::Receipt { action: ReceiptAction::Verify { receipt, key, request, answer, json } } => {
            verify_receipt(&receipt, key, request, answer, json)
        }
        Command::Update { channel, version, check, force, network, no_restart, auto, scheduled } => {
            update_command(UpdateArgs { channel, version, check, force, network, no_restart, auto, scheduled })
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
    let heads_split = config.models.iter().any(|m| !m.cluster.is_empty());
    let peers = KnownNodes::load(&home)?.0;
    // The key this machine paired with other nodes under: a head's shard links use it.
    let device_key = if heads_split || !peers.is_empty() {
        Some(StaticKey::load_or_create(&home.join("device.key"))?)
    } else {
        None
    };
    let (head_devices, rpc_backend) = if heads_split || config.cluster.serve {
        let llama = &config.engine.llama_server;
        let (devices, rpc) =
            tokio::join!(invincible::cluster::probe_devices(llama), invincible::cluster::probe_rpc_backend(llama));
        (devices, rpc)
    } else {
        (Vec::new(), None)
    };
    let mut runs = Vec::new();
    for model in &config.models {
        let port = engine::free_port().map_err(|e| format!("no free port: {e}"))?;
        let mut engine = Engine::attached(&model.id, &format!("http://127.0.0.1:{port}"), model.context, false)
            .with_vision(model.vision(&config.engine));
        let launch = Launch::llama_server(&config.engine, model, port, &logs);
        if model.cluster.is_empty() {
            supervisors.push(engine::supervise(engine.clone(), launch));
        } else {
            let network = config.node.settings().network.encode();
            let device = device_key.clone().expect("a device key for a split model");
            let mut links = Vec::new();
            for name in &model.cluster {
                // One unresolved name must not take every other model down with it: drop that
                // peer, say which name space to look in, and let the model run where it can.
                let Some(peer) = peers.iter().find(|p| &p.name == name).cloned() else {
                    tracing::warn!(
                        model = %model.id,
                        peer = %name,
                        "no node by that name: `invincible join` saves the node's own [remote] name, \
                         not the name given with --name; running this model without it"
                    );
                    continue;
                };
                links.push(invincible::cluster::open_link(peer, device.clone(), network.clone()).await?);
            }
            let run =
                Arc::new(invincible::cluster::ClusterRun::new(&model.id, model.split, &config.remote.name(), links));
            engine = engine.with_cluster(run.clone());
            let head = invincible::cluster::Head {
                devices: head_devices.clone(),
                rpc_backend,
                device_key: device,
                network,
                model_bytes: std::fs::metadata(&model.path).map(|m| m.len()).unwrap_or(0),
            };
            supervisors.push(invincible::cluster::supervise(engine.clone(), launch, run.clone(), head));
            runs.push(run);
        }
        engines.push(engine);
    }
    // This node as a shard: ggml-rpc-server on loopback, reached only through shard links.
    let shard = if config.cluster.serve {
        let program =
            invincible::cluster::find_rpc_server(config.cluster.rpc_server.as_deref(), &config.engine.llama_server)
                .ok_or("[cluster] serve: no ggml-rpc-server (set [cluster] rpc_server; see spec/cluster.md)")?;
        let port = engine::free_port().map_err(|e| format!("no free port: {e}"))?;
        let cache = home.join("cache/rpc");
        let launch =
            invincible::cluster::rpc_launch(&program, port, config.cluster.cache.then_some(cache.as_path()), &logs);
        supervisors.push(engine::keep_running("ggml-rpc-server", launch));
        tracing::info!(heads = ?config.cluster.heads, "serving as a shard");
        Some(remote::ShardService { port, heads: config.cluster.heads.clone(), traffic: Arc::default() })
    } else {
        None
    };
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
        }
        .with_vision(c.vision);
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
    // Dispatch (spec/dispatch.md): this node always a candidate, plus the nodes it paired with.
    let dispatch = invincible::dispatch::Dispatch::new(
        config.remote.name(),
        config.models.iter().map(|model| model.id.clone()).collect(),
        config.node.dispatch_max_inflight,
        home.clone(),
        peers.clone(),
        device_key.clone(),
        config.node.settings().network.encode(),
    );
    let receipt_key = invincible::receipts::ReceiptKey::load_or_create(&home.join("receipt.key"))?;
    let receipt_public = receipt_key.public();
    // The static key exists when either side of the node's network does: paired devices, or a
    // published descriptor, which points at that same paired-device port.
    let node_key = if config.remote.enabled() || config.discovery.announce {
        Some(StaticKey::load_or_create(&home.join("node.key"))?)
    } else {
        None
    };
    let own_descriptor = if config.discovery.announce {
        let key = node_key.as_ref().ok_or("no static key for the descriptor")?;
        Some(invincible::discovery::mint(
            key,
            &receipt_key,
            invincible::discovery::Advert {
                addresses: config.discovery.addresses.clone(),
                models: config.models.iter().map(|model| model.id.clone()).collect(),
                max_inflight: config.node.dispatch_max_inflight,
                lifetime: config.discovery.lifetime,
            },
        )?)
    } else {
        None
    };
    let speech = invincible::synth::from_config(&config.speech, &home);
    let images = invincible::synth::from_config(&config.images, &home);
    let mut state = AppState::new(engines, config.node.settings(), token)
        .with_cloud(cloud)
        .with_media(speech, images)
        .with_receipt_key(&config.remote.name(), receipt_key)
        .with_audit(invincible::audit::AuditLog::new(&home))
        .with_agent(&config.agent.url)
        .with_membership(home.clone())
        .with_discovery(invincible::discovery::Discovery {
            own: own_descriptor,
            store: invincible::discovery::Store::load(&invincible::discovery::Store::path(&home))?,
            seeds: config.discovery.seeds.clone(),
        })
        .with_dispatch(dispatch);
    if config.remote.enabled() {
        let key = node_key.ok_or("no static key for pairing")?;
        let mut pairing = Pairing::new(
            key,
            config.remote.name(),
            config.remote.advertised(),
            Devices::load(&home.join("devices.json"))?,
        )
        .with_receipt_key(receipt_public);
        if let Some(shard) = shard {
            pairing = pairing.with_shard(shard);
        }
        let pairing = Arc::new(pairing);
        state = state.with_pairing(pairing);
    }
    if heads_split || config.cluster.serve || !peers.is_empty() {
        state = state.with_cluster(invincible::cluster::ClusterState {
            name: config.remote.name(),
            llama_server: config.engine.llama_server.clone(),
            rpc_backend,
            peers,
            device_key,
            runs,
            shard: config.cluster.serve,
            models: config.models.iter().map(|model| model.id.clone()).collect(),
            dispatch_max_inflight: config.node.dispatch_max_inflight,
        });
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
    tracing::info!("serving on http://{} ({})", config.listen, invincible::version::VERSION);
    invincible::watchdog::spawn("gateway", config.listen, logs.clone());
    axum::serve(listener, server::app(state))
        .with_graceful_shutdown(shutdown_signal())
        .await
        .map_err(|e| e.to_string())?;
    for supervisor in supervisors {
        supervisor.abort();
    }
    Ok(())
}

struct UpdateArgs {
    channel: Option<String>,
    version: Option<String>,
    check: bool,
    force: bool,
    network: Option<String>,
    no_restart: bool,
    auto: Option<String>,
    scheduled: bool,
}

/// `invincible update`: see [invincible::update].
fn update_command(args: UpdateArgs) -> Result<(), String> {
    use invincible::update::{self, Outcome, Target};
    use invincible::version::{Channel, VERSION, Version};
    let home = config::home()?;
    let config_path = home.join("config.toml");
    if let Some(auto) = &args.auto {
        return set_auto_update(&config_path, &home, auto);
    }
    let config = match fsutil::read_optional(&config_path)? {
        Some(text) => Config::parse(&text).map_err(|e| format!("{}: {e}", config_path.display()))?,
        None => Config::parse("")?,
    };
    // The daily job writes to its log: each line with the time.
    let say = |line: String| {
        if args.scheduled {
            println!("{} {line}", chrono::Local::now().format("%Y-%m-%dT%H:%M:%S"));
        } else {
            println!("{line}");
        }
    };
    let auto = config.update.channel()?;
    if args.scheduled && auto.is_none() {
        say("automatic updates are off ([update] auto = \"off\"); nothing to do".to_owned());
        return Ok(());
    }
    let target = match (&args.version, &args.channel) {
        (Some(v), _) => {
            Version::parse(v)?;
            Target::Version(v.trim_start_matches('v').to_owned())
        }
        (None, Some(c)) => Target::Latest(Channel::parse(c)?),
        (None, None) => {
            Target::Latest(auto.unwrap_or_else(|| Version::parse(VERSION).map_or(Channel::Stable, |v| v.channel())))
        }
    };
    let network = match &args.network {
        Some(n) => invincible_policy::NetworkMode::decode(n),
        None => config.node.settings().network,
    };
    if network.is_offline() {
        return Err(
            "the node is offline ([node] network = \"offline\"): `invincible update --network direct` (or tor:…) goes online for this update only"
                .to_owned(),
        );
    }
    let client = invincible::egress::download_client(&network)?;
    let exe = std::env::current_exe().and_then(|e| e.canonicalize()).map_err(|e| format!("this program: {e}"))?;
    let bin = exe.parent().map(std::path::Path::to_path_buf).ok_or("this program has no directory")?;
    let platform = update::platform()?;
    let source = update::Source::from_env()?;
    if !args.scheduled {
        println!("{}\n", brand::Product::Invincible.header(VERSION));
    }
    let what = match &target {
        Target::Latest(c) => format!("the {c} channel"),
        Target::Version(v) => format!("v{v}"),
    };
    say(brand::step(&format!("checking {what} for {platform}")));
    let runtime = tokio::runtime::Runtime::new().map_err(|e| format!("runtime: {e}"))?;
    let outcome = runtime.block_on(update::run(update::Options {
        client: &client,
        source: &source,
        target,
        platform,
        bin: bin.clone(),
        home: home.clone(),
        current: VERSION.to_owned(),
        check: args.check,
        force: args.force,
    }))?;
    match outcome {
        Outcome::UpToDate { version, ahead: false } => say(brand::ok(&format!("up to date: {version}"))),
        Outcome::UpToDate { version, ahead: true } => {
            say(brand::ok(&format!("{version} is newer than the channel's latest release; kept")))
        }
        Outcome::Available { version } => say(brand::warn(&format!(
            "{} is available: `invincible update{}` installs it",
            version.unwrap_or_else(|| "a new build".to_owned()),
            args.channel.as_ref().map(|c| format!(" --channel {c}")).unwrap_or_default()
        ))),
        Outcome::Updated { from, to, changed } => {
            say(brand::ok(&format!("updated {} in {}: {from} -> {to}", changed.join(" and "), bin.display())));
            if args.no_restart {
                say(brand::warn("the services run the old binaries until they restart"));
            } else if let Ok(platform) = invincible::service::Platform::current() {
                let user = std::path::PathBuf::from(std::env::var_os("HOME").ok_or("HOME is not set")?);
                // The new autobot brings the service definitions up to date (a newer release may
                // write them differently). Not from the daily job: that would reload the job
                // itself while it runs.
                let installed = invincible::service::path(platform, &user, invincible::service::GATEWAY).exists();
                if installed && !args.scheduled {
                    let refreshed = std::process::Command::new(bin.join("autobot"))
                        .args(["service", "install"])
                        .stdout(std::process::Stdio::null())
                        .stderr(std::process::Stdio::null())
                        .status();
                    if !refreshed.is_ok_and(|s| s.success()) {
                        say(brand::warn("the service definitions did not update (`autobot service install` says why)"));
                    }
                }
                let restarted = invincible::service::restart(
                    platform,
                    &user,
                    &[invincible::service::GATEWAY, invincible::service::AGENT],
                );
                if !restarted.is_empty() {
                    say(brand::ok(&format!("restarted {}", restarted.join(" and "))));
                }
            }
        }
    }
    Ok(())
}

/// `invincible update --auto off|stable|edge`: the config, and the daily job to match.
fn set_auto_update(config_path: &std::path::Path, home: &std::path::Path, auto: &str) -> Result<(), String> {
    use invincible::service;
    let channel = invincible::config::UpdateConfig { auto: auto.to_owned() }.channel()?;
    invincible::cloud::set_update_auto(config_path, auto)?;
    let platform = service::Platform::current()?;
    let user = std::path::PathBuf::from(std::env::var_os("HOME").ok_or("HOME is not set")?);
    let exe = std::env::current_exe().and_then(|e| e.canonicalize()).map_err(|e| format!("this program: {e}"))?;
    let job = service::update_job(exe, home);
    let lines = if channel.is_some() {
        service::install(platform, &user, &[job])?
    } else {
        service::uninstall(platform, &user, &[job])?
    };
    for line in lines {
        println!("{}", brand::ash(&line));
    }
    match channel {
        Some(c) => println!(
            "{}",
            brand::ok(&format!(
                "updates daily on the {c} channel (around 04:17; the log is {})",
                home.join("logs/update.log").display()
            ))
        ),
        None => println!("{}", brand::ok("automatic updates are off (`invincible update` updates by hand)")),
    }
    if channel.is_some() && Config::load(config_path).is_ok_and(|c| c.node.settings().network.is_offline()) {
        println!(
            "{}",
            brand::warn(
                "[node] network is \"offline\": the daily update cannot reach the releases until it is direct (or tor/socks5)"
            )
        );
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

/// `invincible receipt verify` (spec/receipts.md, "Verifying"): the offline check. Everything it
/// says it checked was checked here; what it could not check is listed as such.
fn verify_receipt(
    source: &str,
    key: Option<String>,
    request: Option<PathBuf>,
    answer: Option<PathBuf>,
    json: bool,
) -> Result<(), String> {
    let envelope = load_envelope(source)?;
    let public = match key {
        Some(key) => key,
        None => own_receipt_key()?,
    };
    let request = request.as_deref().map(read_json).transpose()?;
    let answer = match answer.as_deref() {
        Some(path) => Some(std::fs::read(path).map_err(|e| format!("{}: {e}", path.display()))?),
        None => None,
    };
    let report = invincible::receipts::inspect(&public, &envelope, request.as_ref(), answer.as_deref())?;
    if json {
        println!("{}", serde_json::to_string_pretty(&report).expect("json"));
        return Ok(());
    }
    println!("receipt {}: version {}", report["request_id"].as_str().unwrap_or("?"), report["version"]);
    println!("  node     {public}");
    if report["bound"] == serde_json::json!(true) {
        println!("  api      {}", report["api"].as_str().unwrap_or("?"));
        let caller = &report["caller"];
        if caller["kind"] == serde_json::json!("device") {
            println!(
                "  caller   device {:?}, key {}, fingerprint {}",
                caller["name"].as_str().unwrap_or("?"),
                caller["key"].as_str().unwrap_or("?"),
                caller["fingerprint"].as_str().unwrap_or("?")
            );
        } else {
            println!("  caller   local (the node's own API, behind its token)");
        }
        println!("  at       {} ({}s ago)", report["at"], report["at_ago"]);
        println!("  request  sha256 {}", report["request_sha256"].as_str().unwrap_or("?"));
        println!(
            "  answer   sha256 {} ({} bytes, {})",
            report["answer_sha256"].as_str().unwrap_or("?"),
            report["answer_bytes"],
            if report["answer_complete"] == serde_json::json!(true) { "whole" } else { "cut short" }
        );
    } else {
        println!("  version 0: routing and accounting only — no request, answer, caller or time is bound");
    }
    println!("signature: valid");
    for (title, key) in [("checked", "checked"), ("not checked", "not_checked")] {
        println!("{title}:");
        for item in report[key].as_array().into_iter().flatten() {
            println!("  - {}", item.as_str().unwrap_or("?"));
        }
    }
    Ok(())
}

/// The envelope `receipt verify` was given: a file, `-` for stdin, or an id in this node's audit log
/// (where the envelope sits under `receipt`).
fn load_envelope(source: &str) -> Result<serde_json::Value, String> {
    let text = if source == "-" {
        let mut text = String::new();
        std::io::stdin().read_to_string(&mut text).map_err(|e| format!("stdin: {e}"))?;
        Some(text)
    } else if std::path::Path::new(source).is_file() {
        Some(std::fs::read_to_string(source).map_err(|e| format!("{source}: {e}"))?)
    } else {
        None
    };
    let value: serde_json::Value = match text {
        Some(text) => serde_json::from_str(&text).map_err(|e| format!("{source}: not JSON: {e}"))?,
        None => {
            let log = invincible::audit::AuditLog::new(&config::home()?);
            match log.find(source) {
                Ok(Some(envelope)) => envelope,
                Ok(None) => {
                    return Err(format!("no receipt {source}: not a file, and not in this node's audit log"));
                }
                // More than one entry names it: which receipt that id is cannot be told from here.
                Err(why) => return Err(format!("not verifying {source}: {why}")),
            }
        }
    };
    if value.get("signature").is_none() && value["receipt"].get("signature").is_some() {
        return Ok(value["receipt"].clone());
    }
    Ok(value)
}

/// This node's receipt public key, for verifying its own receipts without `--key`.
fn own_receipt_key() -> Result<String, String> {
    use base64::Engine as _;
    let path = config::home()?.join("receipt.key");
    let text = fsutil::read_optional(&path)?
        .ok_or_else(|| "this node has no receipt key: pass --key <the node's receipt public key>".to_owned())?;
    let seed: [u8; 32] = base64::engine::general_purpose::URL_SAFE_NO_PAD
        .decode(text.trim())
        .ok()
        .and_then(|b| b.try_into().ok())
        .ok_or_else(|| format!("{}: not a receipt key", path.display()))?;
    Ok(invincible::receipts::ReceiptKey::from_seed(&seed).public())
}

fn read_json(path: &std::path::Path) -> Result<serde_json::Value, String> {
    let text = std::fs::read_to_string(path).map_err(|e| format!("{}: {e}", path.display()))?;
    serde_json::from_str(&text).map_err(|e| format!("{}: not JSON: {e}", path.display()))
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

/// The config `serve`, `announce` and `discover` read: a path on the command line must exist;
/// without one, a node that was never set up starts with the defaults (offline, no models)
/// instead of failing in a restart loop.
fn config_for(path: Option<PathBuf>, home: &std::path::Path) -> Result<Config, String> {
    match path {
        Some(path) => Config::load(&path),
        None => match fsutil::read_optional(&home.join("config.toml"))? {
            Some(text) => Config::parse(&text).map_err(|e| format!("{}: {e}", home.join("config.toml").display())),
            None => Config::parse(""),
        },
    }
}

/// This node's signed descriptor, from config and its own keys. Nothing is detected: the address
/// list is the operator's, and the model ids are the ones this node serves.
fn own_descriptor(config: &Config, home: &std::path::Path) -> Result<invincible::discovery::Descriptor, String> {
    let node = StaticKey::load_or_create(&home.join("node.key"))?;
    let signer = invincible::receipts::ReceiptKey::load_or_create(&home.join("receipt.key"))?;
    invincible::discovery::mint(
        &node,
        &signer,
        invincible::discovery::Advert {
            addresses: config.discovery.addresses.clone(),
            models: config.models.iter().map(|model| model.id.clone()).collect(),
            max_inflight: config.node.dispatch_max_inflight,
            lifetime: config.discovery.lifetime,
        },
    )
}

/// `invincible announce`: mint, POST to every configured seed, and with `--lan` answer mDNS until
/// stopped. It never writes a pairing.
fn announce_command(config_path: Option<PathBuf>, lan: bool) -> Result<(), String> {
    use invincible::discovery;
    let home = config::home()?;
    let config = config_for(config_path, &home)?;
    if !config.discovery.announce {
        return Err("[discovery] announce = false: announcing is a decision; set it to true (with `addresses`) first"
            .to_owned());
    }
    if lan && !config.discovery.lan {
        return Err("[discovery] lan = false: set it to true to answer mDNS".to_owned());
    }
    let descriptor = own_descriptor(&config, &home)?;
    println!(
        "{}",
        brand::step(&format!(
            "node {} at {} ({} model(s), expires in {}m)",
            descriptor.fingerprint,
            descriptor.addresses.join(", "),
            descriptor.models.len(),
            descriptor.remaining(discovery::now()?) / 60
        ))
    );
    let seeds = &config.discovery.seeds;
    if seeds.is_empty() && !lan {
        return Err("nothing to announce to: set [discovery] seeds, or pass --lan".to_owned());
    }
    let runtime = tokio::runtime::Runtime::new().map_err(|e| format!("runtime: {e}"))?;
    let client =
        reqwest::Client::builder().timeout(std::time::Duration::from_secs(15)).build().map_err(|e| e.to_string())?;
    let mut failed = 0usize;
    for seed in seeds {
        match runtime.block_on(discovery::announce_to_seed(&client, seed, &descriptor)) {
            Ok(()) => println!("{}", brand::ok(&format!("announced to {seed}"))),
            Err(e) => {
                failed += 1;
                eprintln!("{}", brand::fail(&e));
            }
        }
    }
    if lan {
        let advert = discovery::LanAdvert::register(&descriptor)?;
        println!("{}", brand::step(&format!("announcing as {} over mDNS; Ctrl-C to stop", advert.fullname)));
        let period = std::time::Duration::from_secs((config.discovery.lifetime / 3).max(60));
        loop {
            let stopped = runtime.block_on(async {
                tokio::select! {
                    _ = tokio::signal::ctrl_c() => true,
                    _ = tokio::time::sleep(period) => false,
                }
            });
            if stopped {
                break;
            }
            // Keep the record's expiry as fresh as the process: a descriptor that outlives the
            // node is exactly the stale address this format exists to avoid.
            advert.refresh(&own_descriptor(&config, &home)?)?;
        }
    }
    if failed == 0 { Ok(()) } else { Err(format!("{failed} of {} seeds did not take the descriptor", seeds.len())) }
}

/// `invincible discover`: ask the seeds, browse the LAN with `--lan`, verify every record, and
/// print what is out there. Pairing is not something this command can do.
fn discover_command(
    config_path: Option<PathBuf>,
    model: Option<String>,
    extra: Vec<String>,
    lan: bool,
    json: bool,
) -> Result<(), String> {
    use invincible::discovery;
    let home = config::home()?;
    let config = config_for(config_path, &home)?;
    if lan && !config.discovery.lan {
        return Err("[discovery] lan = false: set it to true to browse mDNS".to_owned());
    }
    let mut seeds = config.discovery.seeds.clone();
    seeds.extend(extra);
    if seeds.is_empty() && !lan {
        return Err("no seeds to ask: set [discovery] seeds, pass --seed <url>, or use --lan".to_owned());
    }
    let at = discovery::now()?;
    let mut found: Vec<(discovery::Descriptor, String)> = Vec::new();
    let mut problems: Vec<String> = Vec::new();
    if lan {
        match discovery::browse_lan(std::time::Duration::from_secs(3)) {
            Ok(list) => found.extend(list.into_iter().map(|descriptor| (descriptor, "lan".to_owned()))),
            Err(e) => problems.push(format!("lan: {e}")),
        }
    }
    if !seeds.is_empty() {
        let runtime = tokio::runtime::Runtime::new().map_err(|e| format!("runtime: {e}"))?;
        let client = reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(15))
            .build()
            .map_err(|e| e.to_string())?;
        for seed in &seeds {
            match runtime.block_on(discovery::fetch_peers(&client, seed, None)) {
                Ok(list) => found.extend(list.into_iter().map(|descriptor| (descriptor, seed.clone()))),
                Err(e) => problems.push(e),
            }
        }
    }
    let devices = Devices::load(&home.join("devices.json"))?;
    let known = KnownNodes::load(&home)?;
    // Kept only if it verifies, so the store stays "what might be reachable now", not a log.
    let store = discovery::Store::load(&discovery::Store::path(&home))?;
    let mut rows: Vec<Vec<String>> = Vec::new();
    let mut kept: Vec<serde_json::Value> = Vec::new();
    let mut refused = 0usize;
    let mut filtered = 0usize;
    let mut seen = std::collections::HashSet::new();
    let mut claims: std::collections::HashMap<String, usize> = std::collections::HashMap::new();
    for (descriptor, source) in found {
        if let Err(invalid) = descriptor.verify(at) {
            refused += 1;
            problems.push(format!("{} (from {source}): {invalid}", descriptor.fingerprint));
            continue;
        }
        // One row per (identity, signing key): two records claiming the same fingerprint with
        // different keys are both shown, so a seed cannot hide the genuine one behind a forged
        // record of the same name.
        if !seen.insert((descriptor.fingerprint.clone(), descriptor.sign_key.clone())) {
            continue;
        }
        *claims.entry(descriptor.fingerprint.clone()).or_default() += 1;
        if let Err(invalid) = store.insert_at(&descriptor, at) {
            problems.push(format!("{}: not stored: {invalid}", descriptor.fingerprint));
        }
        if let Some(wanted) = &model
            && !descriptor.models.iter().any(|advertised| advertised == wanted)
        {
            filtered += 1;
            continue;
        }
        let trust = descriptor.trust(&devices, &known);
        rows.push(vec![
            descriptor.fingerprint.clone(),
            descriptor.addresses.join(", "),
            descriptor.models.join(", "),
            format!("{}m", descriptor.remaining(at) / 60),
            trust.clone(),
            source.clone(),
        ]);
        kept.push(serde_json::json!({ "descriptor": descriptor, "trust": trust, "source": source }));
    }
    if json {
        println!("{}", serde_json::to_string_pretty(&kept).expect("json"));
    } else if rows.is_empty() {
        println!("{}", brand::ash("no node found"));
    } else {
        let mut table = vec![vec![
            "fingerprint".to_owned(),
            "addresses".to_owned(),
            "models".to_owned(),
            "expires".to_owned(),
            "trust".to_owned(),
            "source".to_owned(),
        ]];
        table.extend(rows);
        print!("{}", brand::table(&table));
    }
    if let Some(wanted) = &model
        && filtered > 0
    {
        // `--json` writes one document to stdout: the advisory goes to stderr instead.
        let line = brand::ash(&format!("{filtered} node(s) did not advertise {wanted}"));
        if json {
            eprintln!("{line}");
        } else {
            println!("{line}");
        }
    }
    for problem in &problems {
        eprintln!("{}", brand::warn(problem));
    }
    if refused > 0 {
        eprintln!("{}", brand::warn(&format!("{refused} descriptor(s) refused")));
    }
    let conflicting = claims.values().filter(|count| **count > 1).count();
    if conflicting > 0 {
        eprintln!(
            "{}",
            brand::warn(&format!(
                "{conflicting} fingerprint(s) arrived with more than one signing key: a seed can replay \
                 a forged record, and only pairing decides which node is real"
            ))
        );
    }
    let advice =
        brand::ash("a found node is not a paired node: pairing needs a code from it (`invincible join <code>`)");
    if json {
        eprintln!("{advice}");
    } else {
        println!("{advice}");
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
        let response = invincible::egress::local()
            .build()
            .map_err(|e| e.to_string())?
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

/// `invincible cluster status` as text.
fn cluster_text(status: &serde_json::Value) -> String {
    use std::fmt::Write as _;
    let mut out = String::new();
    let mib = |v: &serde_json::Value| v.as_u64().map(|m| format!("{:.1} GiB", m as f64 / 1024.0)).unwrap_or_default();
    let devices = |caps: &serde_json::Value| {
        caps["devices"]
            .as_array()
            .into_iter()
            .flatten()
            .map(|d| {
                format!(
                    "{} {} ({} free)",
                    d["name"].as_str().unwrap_or("?"),
                    d["description"].as_str().unwrap_or(""),
                    mib(&d["free_mib"])
                )
            })
            .collect::<Vec<_>>()
            .join(", ")
    };
    let node = &status["node"];
    let _ = writeln!(out, "{}", brand::ok(&format!("{} (this node)", node["name"].as_str().unwrap_or("?"))));
    let _ = writeln!(out, "  devices: {}", devices(node));
    let rpc = match node["rpc_backend"].as_bool() {
        Some(true) => "llama-server can use shards",
        Some(false) => "llama-server has no RPC backend: it cannot use shards",
        None => "RPC backend not checked",
    };
    let _ = writeln!(out, "  {rpc}");
    if let Some(shard) = status["shard"].as_object() {
        let heads: Vec<&str> = shard["heads"].as_array().into_iter().flatten().filter_map(|h| h.as_str()).collect();
        let _ = writeln!(out, "  serves as a shard for: {}", heads.join(", "));
    }
    let peers = status["peers"].as_array().cloned().unwrap_or_default();
    if peers.is_empty() {
        let _ = writeln!(out, "{}", brand::ash("no peers (pair with another node: `invincible join` with its code)"));
    }
    let rows: Vec<Vec<String>> = peers
        .iter()
        .map(|p| {
            let state = if p["reachable"].as_bool() == Some(true) {
                let caps = &p["capabilities"];
                // A node can serve as a shard and still hold nothing: say so, rather than showing
                // a shard with an empty device list and leaving the reason to guesswork.
                let role = match (caps["shard"].as_bool(), devices(caps).is_empty()) {
                    (Some(true), true) => "shard, no usable device",
                    (Some(true), false) => "shard",
                    _ => "not a shard for us",
                };
                format!("up {} ms, {role}: {}", p["probe_ms"], devices(caps))
            } else {
                format!("down: {}", p["error"].as_str().unwrap_or("?"))
            };
            vec![
                p["name"].as_str().unwrap_or("?").to_owned(),
                brand::ash(p["fingerprint"].as_str().unwrap_or("")),
                state,
            ]
        })
        .collect();
    out.push_str(&brand::table(&rows));
    for model in status["models"].as_array().into_iter().flatten() {
        let state = &model["state"];
        let plan = &state["plan"];
        let placement = match plan["action"].as_str() {
            Some("split") => plan["shares"]
                .as_array()
                .into_iter()
                .flatten()
                .map(|s| {
                    format!(
                        "{}/{} {}‰",
                        s["node"].as_str().unwrap_or("?"),
                        s["device"].as_str().unwrap_or("?"),
                        s["permille"]
                    )
                })
                .collect::<Vec<_>>()
                .join(" + "),
            Some("local") => "this node alone".to_owned(),
            Some("block") => match plan["reason"].as_str() {
                Some("no_devices") => "cannot run: no device to place it on (`llama-server --list-devices`)".to_owned(),
                _ => format!("cannot run: needs {} MiB", plan["need_mib"]),
            },
            _ => "starting".to_owned(),
        };
        let _ = writeln!(out, "model {}: {placement}", model["id"].as_str().unwrap_or("?"));
        for note in state["notes"].as_array().into_iter().flatten() {
            let _ = writeln!(out, "  {}", brand::ash(note.as_str().unwrap_or("")));
        }
    }
    out
}

/// `invincible dispatch status` as text: one row per candidate node, then the choice.
fn dispatch_text(status: &serde_json::Value) -> String {
    use std::fmt::Write as _;
    let mut out = String::new();
    let head = status["name"].as_str().unwrap_or("this node");
    let model = status["model"].as_str();
    let _ = writeln!(
        out,
        "{}",
        brand::ok(&format!("{} dispatches {}", head, model.map_or_else(|| "any model".to_owned(), brand::bold)))
    );
    let chosen = status["choice"]["name"].as_str();
    let mut rows = vec![vec![
        brand::ash("node"),
        brand::ash("models"),
        brand::ash("in flight"),
        brand::ash("tg/s"),
        brand::ash("rtt"),
        brand::ash("state"),
    ]];
    for node in status["nodes"].as_array().into_iter().flatten() {
        let models: Vec<&str> = node["models"].as_array().into_iter().flatten().filter_map(|m| m.as_str()).collect();
        let models = if models.is_empty() { brand::ash("—") } else { models.join(",") };
        let tps = node["tg_tps"].as_f64().map_or_else(|| brand::ash("—"), |tps| format!("{tps:.1}"));
        let rtt = node["rtt_ms"].as_f64().map_or_else(
            || brand::ash("—"),
            |ms| if ms >= 1000.0 { format!("{:.1} s", ms / 1000.0) } else { format!("{ms:.1} ms") },
        );
        let state = match node["note"].as_str() {
            Some(note) => brand::ash(note),
            None if chosen == node["name"].as_str() => brand::ok("answers"),
            None => "could answer".to_owned(),
        };
        rows.push(vec![
            node["name"].as_str().unwrap_or("?").to_owned(),
            models,
            format!("{}/{}", node["inflight"].as_u64().unwrap_or(0), node["max_inflight"].as_u64().unwrap_or(0)),
            tps,
            rtt,
            state,
        ]);
    }
    out.push_str(&brand::table(&rows));
    let _ = writeln!(
        out,
        "\n{}",
        match status["choice"]["action"].as_str() {
            Some("run") => format!("choice: run on {}", brand::bold(chosen.unwrap_or("?"))),
            Some("queue") => brand::warn("choice: queue: every eligible node is at capacity"),
            _ => brand::fail("choice: no capacity: no node can take this request"),
        }
    );
    out
}

/// A query value: letters, digits and `-._~` as they are, everything else percent-encoded.
fn query_value(value: &str) -> String {
    value
        .bytes()
        .map(|b| match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'.' | b'_' | b'~' => (b as char).to_string(),
            _ => format!("%{b:02X}"),
        })
        .collect()
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
