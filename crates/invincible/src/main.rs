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
    /// Check the node: engines, devices, links, services, with what to do about each. Reads only;
    /// `✗` means configured-but-cannot-work and exits 1, `!` is something to look at.
    Doctor {
        #[arg(long)]
        config: Option<PathBuf>,
        #[arg(long)]
        json: bool,
    },
    /// Show a one-time code (and QR code) that pairs a device with this node.
    Pair {
        #[arg(long)]
        config: Option<PathBuf>,
        /// What the device that joins with this code may reach: any of `shard`, `agent`, `audit`,
        /// `dispatch`, `rent`, comma-separated. The list is the whole set, so keep `shard` for
        /// chat (`shard,agent,audit` for the Autobot app) [default: shard, the least].
        #[arg(long, value_delimiter = ',')]
        capabilities: Vec<String>,
    },
    /// List the paired devices and what each may reach, unpair one, or grant one a set.
    Devices {
        #[arg(long, global = true)]
        config: Option<PathBuf>,
        /// Unpair the device with this name.
        #[arg(long)]
        remove: Option<String>,
        #[command(subcommand)]
        action: Option<DevicesAction>,
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
    /// Rent a cloud GPU through the in-process engine (spec/rent.md). Nothing starts
    /// until `start --confirm`; the caps in `[rent]` are a ceiling, not a permission.
    Rent {
        #[command(subcommand)]
        action: RentAction,
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
enum DevicesAction {
    /// Set exactly what a paired device may reach, from its next request on, with no re-pairing:
    /// `invincible devices grant phone shard,agent,audit`. The list is the whole set, so a code
    /// left out is revoked.
    Grant {
        /// The device, by the name `invincible devices` lists.
        name: String,
        /// Any of `shard` (chat, and what a cluster head needs of this node), `agent` (the
        /// Autobot Agent, which runs with this node's token), `audit` (its own audit entries),
        /// `dispatch` (a hop into your other nodes) and `rent` (cloud GPUs), comma-separated.
        #[arg(value_delimiter = ',', required = true)]
        capabilities: Vec<String>,
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
        #[arg(long)]
        config: Option<PathBuf>,
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

#[derive(Subcommand)]
enum RentAction {
    /// The presets the node ships, and any added under rent/presets.
    Presets {
        #[arg(long)]
        config: Option<PathBuf>,
    },
    /// Project ids that have a session on this node.
    Projects {
        #[arg(long)]
        config: Option<PathBuf>,
    },
    /// List offers for a preset. Does not start a pod.
    Offers {
        /// The preset id (`vllm`, `comfyui-minimax-h3`, `dev-box`, or one added under rent/presets).
        #[arg(long)]
        preset: String,
        /// How long the rental would run, in hours, in (0, 24].
        #[arg(long)]
        hours: f64,
        /// How many offers to ask for.
        #[arg(long)]
        limit: Option<u32>,
        /// Region filter, comma-separated. Omit it and the node's `[rent] require_regions` applies.
        #[arg(long)]
        require_regions: Option<String>,
        #[arg(long)]
        config: Option<PathBuf>,
        #[arg(long)]
        json: bool,
    },
    /// Ask to start a rental. Without `--confirm` the node returns the cost and starts nothing.
    Start {
        /// Project id, a single path segment.
        #[arg(long)]
        project: String,
        #[arg(long)]
        preset: String,
        #[arg(long)]
        hours: f64,
        /// Lock this offer. Without it, the node may fail over inside the priced window, then pins the preview.
        #[arg(long)]
        offer: Option<String>,
        /// The owner's approval. Required to provision; the caps are checked either way.
        #[arg(long)]
        confirm: bool,
        #[arg(long)]
        require_regions: Option<String>,
        #[arg(long)]
        config: Option<PathBuf>,
        #[arg(long)]
        json: bool,
    },
    /// One session, or every session when no id is given.
    Status {
        id: Option<String>,
        #[arg(long)]
        config: Option<PathBuf>,
        #[arg(long)]
        json: bool,
    },
    /// Stop a session. `--force` deletes the pod even when the drain does not finish.
    Stop {
        id: String,
        #[arg(long)]
        force: bool,
        #[arg(long)]
        config: Option<PathBuf>,
        #[arg(long)]
        json: bool,
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
                api_key_env: None,
                context,
                data_policy: &policy,
                vision: None,
                include_usage: None,
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
            let config_path = config.clone().unwrap_or_else(|| home.join("config.toml"));
            let config = config_for(config, &home)?;
            let token = token::load_or_create(&home.join("token"))?;
            tracing_subscriber::fmt().with_target(false).init();
            // Asked before anything starts ([hangup_ignored]).
            #[cfg(unix)]
            hangup_ignored();
            let runtime = tokio::runtime::Runtime::new().map_err(|e| format!("runtime: {e}"))?;
            runtime.block_on(serve(config, token, home, config_path))
        }
        Command::Token => {
            println!("{}", token::load_or_create(&config::home()?.join("token"))?);
            Ok(())
        }
        Command::Doctor { config: path, json } => {
            let home = config::home()?;
            let report = invincible::doctor::run(&home, path.as_deref());
            if json {
                println!("{}", serde_json::to_string_pretty(&report.json()).map_err(|e| e.to_string())?);
            } else {
                print!("{}", report.report());
            }
            // The report is the message; the exit code is for the shell. A `✗` is a thing that was
            // configured and cannot work, so a script or a CI step can lean on this without
            // parsing the glyphs.
            if report.exit_code() != 0 {
                std::process::exit(1);
            }
            Ok(())
        }
        Command::Pair { config, capabilities } => {
            // The set the code carries (spec/pairing.md, Capabilities): named here, it is the
            // operator's grant; left out, the code grants `shard` only.
            let body =
                if capabilities.is_empty() { None } else { Some(serde_json::json!({ "capabilities": capabilities })) };
            let reply = admin_with(config, reqwest::Method::POST, "/v1/admin/pairing", body)?;
            let code = reply["code"].as_str().ok_or("the node sent no code")?;
            let qr = qrcode::QrCode::new(code.as_bytes()).map_err(|e| e.to_string())?;
            println!("{}", qr.render::<qrcode::render::unicode::Dense1x2>().quiet_zone(true).build());
            println!("{code}\n");
            let reaches = reply["capabilities"]
                .as_array()
                .map(|set| set.iter().filter_map(|c| c.as_str()).collect::<Vec<_>>().join(", "))
                .unwrap_or_else(|| "shard".to_owned());
            println!(
                "Node \"{}\", key {}. The code works once, for {} minutes.",
                reply["node"].as_str().unwrap_or("?"),
                reply["fingerprint"].as_str().unwrap_or("?"),
                reply["expires_in"].as_u64().unwrap_or(0) / 60
            );
            println!("The device that joins reaches: {reaches}.");
            Ok(())
        }
        Command::Devices { remove: Some(_), action: Some(_), .. } => {
            Err("`--remove` unpairs a device on its own; run it without `grant`".to_owned())
        }
        Command::Devices { config, remove: None, action: Some(DevicesAction::Grant { name, capabilities }) } => {
            let capabilities: Vec<&str> = capabilities.iter().map(|c| c.trim()).filter(|c| !c.is_empty()).collect();
            let reply = admin_with(
                config,
                reqwest::Method::PATCH,
                &format!("/v1/admin/devices/{name}"),
                Some(serde_json::json!({ "capabilities": capabilities })),
            )?;
            let set = |value: &serde_json::Value| {
                value.as_array().map(|set| set.iter().filter_map(|c| c.as_str()).collect::<Vec<_>>().join(", "))
            };
            println!(
                "{}",
                brand::ok(&format!(
                    "{} now reaches: {} (was: {})",
                    reply["device"].as_str().unwrap_or(&name),
                    set(&reply["capabilities"]).unwrap_or_default(),
                    set(&reply["was"]).unwrap_or_else(|| "?".to_owned())
                ))
            );
            Ok(())
        }
        Command::Devices { config, remove, action: None } => {
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
                        // What it may reach (spec/pairing.md, Capabilities): a set of one (`shard`)
                        // unless you granted more.
                        device["capabilities"]
                            .as_array()
                            .map(|set| set.iter().filter_map(|c| c.as_str()).collect::<Vec<_>>().join(", "))
                            .unwrap_or_else(|| "shard".to_owned()),
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
            // What the node granted this machine (spec/pairing.md, Capabilities): the least unless
            // it was granted more, which the node's operator changes there.
            println!("it grants this machine: {}", paired.capabilities.codes().join(", "));
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
        Command::Rent { action } => rent_command(action),
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
                    let server = probe.llama_server.clone().ok_or_else(|| {
                        format!(
                            "the engine `{}` is not there: install llama.cpp (`brew install llama.cpp`, or your CUDA build) and set [engine] llama_server",
                            cfg.engine.llama_server.display()
                        )
                    })?;
                    let program = probe.llama_bench.clone().ok_or_else(|| {
                        format!("llama-bench is not next to {server} or on PATH: it ships with llama.cpp, beside llama-server")
                    })?;
                    // A profile holds for one llama.cpp build: one that names none would be kept
                    // for whichever build runs next.
                    let build = probe
                        .llama_build
                        .clone()
                        .ok_or_else(|| format!("`{server} --version` names no llama.cpp build, so a measurement could not say which build it holds for"))?;
                    let device = device
                        .or_else(|| probe.devices.first().map(|d| d.name.clone()))
                        .unwrap_or_else(|| "CPU".to_owned());
                    println!("measuring {model} on {device} with {program} (this takes a minute)…");
                    let bench = invincible::tune::bench(std::path::Path::new(&program), &entry.path, Some(&device))?;
                    match bench.build.as_deref() {
                        Some(measured) if measured == build => {}
                        Some(measured) => {
                            return Err(format!(
                                "{program} is llama.cpp {measured} and the engine {server} is {build}: its numbers would not be the engine's (use the llama-bench that came with it); nothing kept"
                            ));
                        }
                        None => {
                            return Err(format!(
                                "{program} named no llama.cpp build, so its numbers could be another build's than the engine's {build} (use the llama-bench that came with it); nothing kept"
                            ));
                        }
                    }
                    let (pp, tg) = (bench.pp_tps, bench.tg_tps);
                    let profile = invincible::tune::Profile {
                        device: device.clone(),
                        tg_tps: tg,
                        pp_tps: pp,
                        engine: format!("llama-bench {build}"),
                        at: chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Secs, true),
                    };
                    let set = invincible::tune::record(&home, &model, &probe.hardware_tag(), profile)?;
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
                TuneAction::Show { model, config: path } => {
                    let sets: Vec<_> = match model {
                        Some(model) => invincible::tune::load(&home, &model).into_iter().collect(),
                        None => invincible::tune::load_all(&home),
                    };
                    if sets.is_empty() {
                        println!("{}", brand::ash("nothing measured yet (`invincible tune bench <model>`)"));
                        return Ok(());
                    }
                    // What a profile taken now would be valid for: the engine is asked its devices
                    // and build, so a new GPU or llama.cpp shows as other hardware.
                    let cfg = load(path)?;
                    let runtime = tokio::runtime::Runtime::new().map_err(|e| format!("runtime: {e}"))?;
                    let now = runtime.block_on(invincible::tune::hardware_now(&cfg.engine.llama_server));
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

async fn serve(config: Config, token: String, home: PathBuf, config_path: PathBuf) -> Result<(), String> {
    let logs = home.join("logs");
    let mut engines = Vec::new();
    // Aborted at shutdown, which kills their engines (a handle dropped would leave its task running).
    let mut supervisors = Vec::new();
    let heads_split = config.models.iter().any(|m| !m.cluster.is_empty());
    let peers = KnownNodes::load(&home)?.0;
    // The key this machine paired with other nodes under: a head's shard links use it.
    let device_key = if heads_split || !peers.is_empty() {
        Some(StaticKey::load_or_create(&home.join("device.key"))?)
    } else {
        None
    };
    // Asked once, and only when a split, a shard, a dispatcher over paired nodes or a measurement
    // of this machine's reads it: the devices, the RPC backend, and the build that, with them, is
    // what profiles are valid for.
    let measured = config.models.iter().any(|model| invincible::tune::load(&home, &model.id).is_some());
    let probed = heads_split || config.cluster.serve || !peers.is_empty() || measured;
    let (head_devices, rpc_backend, llama_build) = if probed {
        let llama = &config.engine.llama_server;
        tokio::join!(
            invincible::cluster::probe_devices(llama),
            invincible::cluster::probe_rpc_backend(llama),
            invincible::cluster::probe_build(llama)
        )
    } else {
        (Vec::new(), None, None)
    };
    let hardware =
        invincible::tune::hardware_tag(&invincible::tune::machine_now(), &head_devices, llama_build.as_deref());
    let mut runs = Vec::new();
    for (n, model) in config.models.iter().enumerate() {
        let port = engine::free_port().map_err(|e| format!("no free port: {e}"))?;
        // Its own key: the engine answers the node, not whatever else on the machine finds its port.
        let key = engine::new_key()?;
        let mut engine = Engine::attached(&model.id, &format!("http://127.0.0.1:{port}"), model.context, false)
            .with_vision(model.vision(&config.engine))
            .with_embeddings(model.embeddings)
            .with_key(&key);
        let launch = Launch::llama_server(&config.engine, model, port, &key, &engine::key_file(&home, n), &logs);
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
                hardware: hardware.clone(),
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
    let rent = invincible::rent::start(&config.rent, &home)?;
    if rent.is_some() {
        tracing::info!("rent engine in-process");
    }
    if engines.is_empty() && config.cloud.is_empty() {
        tracing::warn!(
            "no models configured: every request will be blocked (`invincible model add` or `invincible cloud add`)"
        );
    } else if engines.is_empty() {
        tracing::info!("no local models: requests go to cloud models only, so private ones are refused");
    }

    let cloud = invincible::cloud::models(&config, &home);
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
    let dispatch = if probed { dispatch.with_hardware(hardware.clone()) } else { dispatch };
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
    let transcription = invincible::synth::from_config(&config.transcription, &home);
    for backend in transcription.iter().filter(|b| b.tier != invincible_policy::Tier::Node) {
        tracing::warn!(backend = %backend.id, "a transcription backend off this machine is never used: audio cannot be redacted");
    }
    let mut state = AppState::new(engines, config.node.settings(), token)
        .with_max_buffered_bytes(config.node.max_buffered_bytes)
        .with_cloud(cloud)
        .with_media(speech, images)
        .with_transcription(transcription)
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
    if let Some(gateway) = rent {
        state = state.with_rent(gateway);
    }
    let clouds = state.cloud.clone();
    state = state.with_provider_admin(Arc::new(invincible::providers_admin::ProviderAdmin::new(
        home.clone(),
        config_path.clone(),
        clouds,
    )));
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
            llama_build,
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
    // Answers in flight may finish, for 15 s: then the engine supervisors are aborted, which stops
    // the engines and ends the answers they were giving. An answer this node is getting from
    // elsewhere (a cloud model, a node it dispatched to) is not ended by it: the node waits for it,
    // its engines stopped, until a service manager's SIGKILL (at 20 s) if need be. Paired devices'
    // sessions (`remote::serve`, spawned above) are not waited for: they end with the node.
    let stop_engines: Vec<_> = supervisors.iter().map(|s| s.abort_handle()).collect();
    axum::serve(listener, server::app(state))
        .with_graceful_shutdown(async move {
            shutdown_signal().await;
            tokio::spawn(async move {
                tokio::time::sleep(std::time::Duration::from_secs(15)).await;
                for supervisor in stop_engines {
                    supervisor.abort();
                }
            });
        })
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
                        .stderr(std::process::Stdio::piped())
                        .output();
                    match refreshed {
                        Ok(out) if out.status.success() => {}
                        Ok(out) => {
                            let why = String::from_utf8_lossy(&out.stderr);
                            let why = why.lines().last().unwrap_or("no error text").trim();
                            say(brand::warn(&format!(
                                "the service definitions did not update: {why} (run `autobot service install`)"
                            )));
                        }
                        Err(e) => say(brand::warn(&format!(
                            "could not run the new autobot: {e} (run `autobot service install`)"
                        ))),
                    }
                }
                let restarted = invincible::service::restart(
                    platform,
                    &user,
                    &[invincible::service::GATEWAY, invincible::service::AGENT],
                );
                if !restarted.is_empty() {
                    say(brand::ok(&format!("restarted {}", restarted.join(" and "))));
                } else if installed {
                    say(brand::warn("the services are installed but not running: `autobot service install`"));
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
    let what = if let Some(action) = entry["rent"]["action"].as_str() {
        let id = entry["rent"]["session_id"].as_str().unwrap_or("?");
        match entry["rent"]["cost_estimate_usd"].as_f64() {
            Some(usd) => format!("rent {action} {id} (${usd:.2})"),
            None => format!("rent {action} {id}"),
        }
    } else {
        match decision["action"].as_str() {
            Some("run") => {
                format!("{} on {}", decision["model"].as_str().unwrap_or("?"), decision["tier"].as_str().unwrap_or("?"))
            }
            Some(action) => format!("{action}: {}", decision["reason"].as_str().unwrap_or("?")),
            None => "?".to_owned(),
        }
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

/// `invincible rent`: the node's `/v1/rent/*`, with the local token. Provider keys stay on the node.
fn rent_command(action: RentAction) -> Result<(), String> {
    match action {
        RentAction::Presets { config } => {
            let home = rent_home(config)?;
            for (id, name) in invincible::rent::preset_names(&home)? {
                if name.is_empty() {
                    println!("{id}");
                } else {
                    println!("{id}\t{name}");
                }
            }
            Ok(())
        }
        RentAction::Projects { config } => {
            let home = rent_home(config)?;
            let projects = invincible::rent::project_ids(&home)?;
            if projects.is_empty() {
                println!("{}", brand::ash("no projects"));
            }
            for id in projects {
                println!("{id}");
            }
            Ok(())
        }
        RentAction::Offers { preset, hours, limit, require_regions, config, json } => {
            let mut path = format!("/v1/rent/offers?preset={}&hours={hours}", query_escape(&preset));
            if let Some(limit) = limit {
                path.push_str(&format!("&limit={limit}"));
            }
            if let Some(regions) = require_regions {
                path.push_str(&format!("&require_regions={}", query_escape(&regions)));
            }
            let (status, body) = rent_call(config, reqwest::Method::GET, &path, None, false)?;
            if json {
                println!("{body}");
            } else if !status.is_success() {
                return Err(rent_message(&body, status));
            } else {
                println!("{}", rent_offers_text(&body));
            }
            Ok(())
        }
        RentAction::Start { project, preset, hours, offer, confirm, require_regions, config, json } => {
            let mut payload = serde_json::json!({ "project_id": project, "preset_id": preset, "hours": hours });
            if let Some(offer) = offer {
                payload["offer_id"] = serde_json::json!(offer);
            }
            if let Some(regions) = require_regions {
                let regions: Vec<&str> =
                    regions.split(',').map(str::trim).filter(|region| !region.is_empty()).collect();
                payload["require_regions"] = serde_json::json!(regions);
            }
            let (status, body) = rent_call(config, reqwest::Method::POST, "/v1/rent/sessions", Some(payload), confirm)?;
            if json {
                println!("{body}");
                return if status.is_success() { Ok(()) } else { Err(rent_message(&body, status)) };
            }
            if status.as_u16() == 409 {
                let estimate = body["cost_estimate_usd"].as_f64();
                let offer = body["offer"]["id"].as_str().unwrap_or("the top offer");
                println!(
                    "{}",
                    brand::warn(&format!(
                        "not started. {} for {offer}. Run the same command with --confirm to rent it.",
                        estimate.map_or_else(|| "cost unknown".to_owned(), |usd| format!("estimate ${usd:.4}"))
                    ))
                );
                return Ok(());
            }
            if !status.is_success() {
                return Err(rent_message(&body, status));
            }
            println!(
                "{}",
                brand::ok(&format!(
                    "session {} is {} (estimate ${})",
                    body["id"].as_str().unwrap_or("?"),
                    body["phase"].as_str().unwrap_or("?"),
                    body["cost_estimate_usd"].as_f64().unwrap_or(0.0)
                ))
            );
            Ok(())
        }
        RentAction::Status { id, config, json } => {
            let path = match &id {
                Some(id) => format!("/v1/rent/sessions/{id}"),
                None => "/v1/rent/sessions".to_owned(),
            };
            let (status, body) = rent_call(config, reqwest::Method::GET, &path, None, false)?;
            if !status.is_success() {
                return Err(rent_message(&body, status));
            }
            if json {
                println!("{body}");
            } else if id.is_some() {
                println!("{}", rent_session_line(&body));
            } else {
                let sessions = body["sessions"].as_array().cloned().unwrap_or_default();
                if sessions.is_empty() {
                    println!("{}", brand::ash("no sessions"));
                }
                for session in sessions {
                    println!("{}", rent_session_line(&session));
                }
            }
            Ok(())
        }
        RentAction::Stop { id, force, config, json } => {
            let (status, body) = rent_call(
                config,
                reqwest::Method::POST,
                &format!("/v1/rent/sessions/{id}/stop"),
                Some(serde_json::json!({ "force": force })),
                false,
            )?;
            if json {
                println!("{body}");
            }
            if !status.is_success() {
                return Err(rent_message(&body, status));
            }
            if !json {
                println!("{}", brand::ok(&rent_session_line(&body)));
            }
            Ok(())
        }
    }
}

fn rent_offers_text(body: &serde_json::Value) -> String {
    let regions = body["require_regions"]
        .as_array()
        .map(|regions| regions.iter().filter_map(|region| region.as_str()).collect::<Vec<_>>().join(","))
        .unwrap_or_default();
    let mut lines = vec![format!(
        "{}  {}h  regions {regions}",
        body["preset_id"].as_str().unwrap_or("?"),
        body["hours"].as_f64().unwrap_or(0.0)
    )];
    let offers = body["offers"].as_array().cloned().unwrap_or_default();
    if offers.is_empty() {
        lines.push(brand::ash("no offers"));
    }
    for offer in offers {
        lines.push(format!(
            "  {}  ${}/h  estimate ${}  {}",
            offer["id"].as_str().unwrap_or("?"),
            offer["usd_per_hr"].as_f64().unwrap_or(0.0),
            offer["estimate_usd"].as_f64().unwrap_or(0.0),
            offer["region"].as_str().unwrap_or("")
        ));
    }
    lines.join("\n")
}

fn rent_session_line(session: &serde_json::Value) -> String {
    format!(
        "{}  {}  {}  {}h  estimate ${}",
        session["id"].as_str().unwrap_or("?"),
        session["phase"].as_str().unwrap_or("?"),
        session["preset_id"].as_str().unwrap_or("?"),
        session["hours"].as_f64().unwrap_or(0.0),
        session["cost_estimate_usd"].as_f64().unwrap_or(0.0)
    )
}

fn rent_message(body: &serde_json::Value, status: reqwest::StatusCode) -> String {
    body["error"]["message"].as_str().map(str::to_owned).unwrap_or_else(|| status.to_string())
}

fn query_escape(value: &str) -> String {
    let mut out = String::new();
    for byte in value.bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => out.push(byte as char),
            _ => out.push_str(&format!("%{byte:02X}")),
        }
    }
    out
}

/// The rent API, including a 409 the caller wants to print rather than treat as a transport error.
fn rent_home(config: Option<PathBuf>) -> Result<PathBuf, String> {
    match config {
        Some(config) => Ok(config.parent().map(std::path::Path::to_path_buf).unwrap_or_else(|| PathBuf::from("."))),
        None => config::home(),
    }
}

fn rent_call(
    config: Option<PathBuf>,
    method: reqwest::Method,
    path: &str,
    body: Option<serde_json::Value>,
    confirm: bool,
) -> Result<(reqwest::StatusCode, serde_json::Value), String> {
    let home = config::home()?;
    let config = Config::load(&config.unwrap_or_else(|| home.join("config.toml")))?;
    let token = token::load_or_create(&home.join("token"))?;
    let runtime = tokio::runtime::Runtime::new().map_err(|e| format!("runtime: {e}"))?;
    runtime.block_on(async {
        let mut request = invincible::egress::local()
            .build()
            .map_err(|e| e.to_string())?
            .request(method, format!("http://{}{path}", config.listen))
            .bearer_auth(token);
        if confirm {
            request = request.header(invincible::server::CONFIRMED_HEADER, "1");
        }
        if let Some(body) = body {
            request = request.json(&body);
        }
        let response = request.send().await.map_err(|e| format!("is the node running (`invincible serve`)? {e}"))?;
        let status = response.status();
        let body = response.json().await.unwrap_or_else(|_| serde_json::json!({}));
        Ok((status, body))
    })
}

/// Calls the running node's admin API on loopback, with the local token.
fn admin(config: Option<PathBuf>, method: reqwest::Method, path: &str) -> Result<serde_json::Value, String> {
    admin_with(config, method, path, None)
}

/// [admin], with a JSON body when the route takes one.
fn admin_with(
    config: Option<PathBuf>,
    method: reqwest::Method,
    path: &str,
    body: Option<serde_json::Value>,
) -> Result<serde_json::Value, String> {
    let home = config::home()?;
    let config = Config::load(&config.unwrap_or_else(|| home.join("config.toml")))?;
    let token = token::load_or_create(&home.join("token"))?;
    let runtime = tokio::runtime::Runtime::new().map_err(|e| format!("runtime: {e}"))?;
    runtime.block_on(async {
        let mut request = invincible::egress::local()
            .build()
            .map_err(|e| e.to_string())?
            .request(method, format!("http://{}{path}", config.listen))
            .bearer_auth(token);
        if let Some(body) = body {
            request = request.json(&body);
        }
        let response = request.send().await.map_err(|e| format!("is the node running (`invincible serve`)? {e}"))?;
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

/// Ctrl-C; SIGTERM, what launchd, systemd and `kill` send to stop a service; or SIGHUP, the
/// terminal it runs in closing, unless the node was started with SIGHUP ignored (`nohup`), which
/// it then keeps ignoring. All shut down cleanly, so the engines the node started are stopped with
/// it: they run in process groups of their own, which a terminal's signals do not reach.
async fn shutdown_signal() {
    #[cfg(unix)]
    {
        use tokio::signal::unix::{SignalKind, signal};
        // Each listened for on its own: one that cannot be leaves the others.
        let mut term = signal(SignalKind::terminate()).ok();
        let mut hangup = if hangup_ignored() { None } else { signal(SignalKind::hangup()).ok() };
        tokio::select! {
            _ = tokio::signal::ctrl_c() => {}
            () = next(term.as_mut()) => {}
            () = next(hangup.as_mut()) => {}
        }
    }
    #[cfg(not(unix))]
    {
        let _ = tokio::signal::ctrl_c().await;
    }
}

/// The next of [signal], or never when it is not listened for.
#[cfg(unix)]
async fn next(signal: Option<&mut tokio::signal::unix::Signal>) {
    match signal {
        Some(signal) => {
            signal.recv().await;
        }
        None => std::future::pending().await,
    }
}

/// Whether SIGHUP was ignored when the node started (`nohup`). Asked once, before a handler would
/// replace that; for `serve`, before the runtime and the engines start.
#[cfg(unix)]
fn hangup_ignored() -> bool {
    static IGNORED: std::sync::OnceLock<bool> = std::sync::OnceLock::new();
    *IGNORED.get_or_init(|| {
        // A shell started from here inherits an ignored SIGHUP, and sends it to itself: it lives
        // only if it is ignored. Asked so as the node has no unsafe code to ask `sigaction`; not
        // known, and so false, when no shell runs or its status cannot be had (SIGCHLD ignored).
        std::process::Command::new("/bin/sh")
            .args(["-c", "kill -HUP $$"])
            .env_clear()
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status()
            .is_ok_and(|status| status.success())
    })
}
