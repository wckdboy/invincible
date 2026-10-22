//! Cluster inference, phase 1 (spec/cluster.md): one model split layer-wise across this node (the
//! head) and paired nodes (shards), through llama.cpp's RPC backend.
//!
//! llama.cpp's `ggml-rpc-server` has no authentication and no encryption, so it never listens
//! anywhere but loopback. A shard runs it on a loopback port and reaches it only from inside a
//! shard link: a Noise session from a paired device it names in `[cluster] heads`
//! ([crate::remote::MODE_SHARD]). The head runs a loopback listener per peer; each connection
//! `llama-server --rpc` opens to it becomes one shard link to that peer.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, RwLock};
use std::time::Duration;

use invincible_policy::{
    LinkAction, LinkInput, LinkSpeed, Measurement, Plan, PlanAction, PlanDevice, PlanInput, Share, SplitMode,
    decide_link,
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use tokio::net::TcpListener;
use tokio::task::JoinHandle;

use crate::devices::{KnownNode, StaticKey};
use crate::engine::{Engine, Launch};
use crate::remote::{self, Traffic};

/// How long a peer may take to answer a capability probe.
const PROBE_TIMEOUT: Duration = Duration::from_secs(5);
/// How long the link meter may take before the plan goes ahead without it.
const LINK_METER_TIMEOUT: Duration = Duration::from_secs(15);
/// How long to wait before planning again when a model cannot run.
const REPLAN: Duration = Duration::from_secs(15);

// ---------------------------------------------------------------------------------------------
// Capabilities

/// One device llama.cpp can put layers on, as `llama-server --list-devices` reports it.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Device {
    pub name: String,
    pub description: String,
    pub total_mib: u64,
    pub free_mib: u64,
}

/// The devices in `llama-server --list-devices` output (`  MTL0: Apple M3 Pro (28753 MiB, 28753
/// MiB free)`), leaving out those with no memory of their own (BLAS, which holds no layers).
pub fn parse_devices(text: &str) -> Vec<Device> {
    text.lines()
        .filter_map(|line| {
            let line = line.trim();
            let (name, rest) = line.split_once(": ")?;
            if name.is_empty() || name.contains(char::is_whitespace) {
                return None;
            }
            let open = rest.rfind(" (")?;
            let (description, sizes) = (&rest[..open], rest[open + 2..].strip_suffix(')')?);
            let (total, free) = sizes.split_once(", ")?;
            let total_mib = total.strip_suffix(" MiB")?.trim().parse().ok()?;
            let free_mib = free.strip_suffix(" MiB free")?.trim().parse().ok()?;
            (total_mib > 0).then(|| Device {
                name: name.to_owned(),
                description: description.to_owned(),
                total_mib,
                free_mib,
            })
        })
        .collect()
}

async fn output(program: &Path, args: &[&str]) -> Option<String> {
    let run =
        tokio::process::Command::new(program).args(args).stdin(std::process::Stdio::null()).kill_on_drop(true).output();
    let out = tokio::time::timeout(Duration::from_secs(30), run).await.ok()?.ok()?;
    Some(format!("{}{}", String::from_utf8_lossy(&out.stdout), String::from_utf8_lossy(&out.stderr)))
}

/// This machine's devices, from `llama-server --list-devices`.
pub async fn probe_devices(llama_server: &Path) -> Vec<Device> {
    output(llama_server, &["--list-devices"]).await.map(|o| parse_devices(&o)).unwrap_or_default()
}

/// Whether [llama_server] was built with the RPC backend (`GGML_RPC=ON`): asked to reach an RPC
/// server on a closed port, a build without it says so before trying. None: it did not run.
pub async fn probe_rpc_backend(llama_server: &Path) -> Option<bool> {
    let text = output(llama_server, &["--rpc", "127.0.0.1:9", "--list-devices"]).await?;
    Some(rpc_backend_in(&text))
}

/// [probe_rpc_backend]'s reading of the output.
pub fn rpc_backend_in(text: &str) -> bool {
    !(text.contains("RPC not supported") || text.contains("failed to find RPC backend"))
}

/// The machine's memory in bytes.
pub fn memory_bytes() -> Option<u64> {
    if cfg!(target_os = "macos") {
        let out = std::process::Command::new("sysctl").args(["-n", "hw.memsize"]).output().ok()?;
        return String::from_utf8_lossy(&out.stdout).trim().parse().ok();
    }
    let text = std::fs::read_to_string("/proc/meminfo").ok()?;
    let line = text.lines().find(|l| l.starts_with("MemTotal:"))?;
    let kib: u64 = line.split_whitespace().nth(1)?.parse().ok()?;
    Some(kib * 1024)
}

/// The `ggml-rpc-server` to run: as configured, else next to [llama_server], else on PATH (by
/// its current name, then the one it had until late 2026, `rpc-server`).
pub fn find_rpc_server(configured: Option<&Path>, llama_server: &Path) -> Option<PathBuf> {
    if let Some(path) = configured {
        return Some(path.to_owned());
    }
    let names = ["ggml-rpc-server", "rpc-server"];
    let beside = llama_server.parent().filter(|p| !p.as_os_str().is_empty()).map(Path::to_owned).or_else(|| {
        std::env::var_os("PATH")
            .and_then(|path| std::env::split_paths(&path).find(|dir| dir.join(llama_server).is_file()))
    });
    let dirs: Vec<PathBuf> = beside
        .into_iter()
        .chain(std::env::var_os("PATH").map(|p| std::env::split_paths(&p).collect::<Vec<_>>()).unwrap_or_default())
        .collect();
    dirs.iter().flat_map(|dir| names.iter().map(move |n| dir.join(n))).find(|p| p.is_file())
}

/// What a node can give a cluster: `GET /v1/cluster/node`.
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct Capabilities {
    pub name: String,
    pub version: String,
    #[serde(default)]
    pub memory_bytes: Option<u64>,
    #[serde(default)]
    pub devices: Vec<Device>,
    /// Whether its llama-server can use RPC shards (None: not known).
    #[serde(default)]
    pub rpc_backend: Option<bool>,
    /// Whether it serves as a shard (`[cluster] serve`).
    #[serde(default)]
    pub shard: bool,
    /// What this machine measured about itself (`invincible tune bench`), so a head can plan by
    /// speed rather than only by memory.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub profiles: Vec<crate::tune::Set>,
    /// The machine those profiles are valid for; a head ignores profiles from other hardware.
    #[serde(default)]
    pub hardware: String,
    /// How much this node will take (spec/dispatch.md). Absent on a node too old to say, which a
    /// dispatcher must read as "unknown", never as "unlimited".
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub dispatch: Option<Dispatch>,
    /// The model ids this node serves, for a dispatcher (spec/dispatch.md). A request may only go
    /// to a node that names its model; a node too old to list them names none.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub models: Vec<String>,
}

/// What a node offers a dispatcher: how many requests it will run at once, and how many wait.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Dispatch {
    pub max_inflight: u64,
    pub queue: u64,
}

/// `ggml-rpc-server` on loopback [port] only, caching the weights heads send in [cache].
pub fn rpc_launch(program: &Path, port: u16, cache: Option<&Path>, logs: &Path) -> Launch {
    let mut args = vec!["--host".to_owned(), "127.0.0.1".to_owned(), "--port".to_owned(), port.to_string()];
    let mut env = Vec::new();
    if let Some(cache) = cache {
        args.push("--cache".to_owned());
        env.push(("LLAMA_CACHE".to_owned(), cache.display().to_string()));
    }
    // TCP inside the tunnel: RDMA would go around it.
    env.push(("GGML_RPC_NO_RDMA".to_owned(), "1".to_owned()));
    Launch { program: program.to_owned(), args, log: logs.join("ggml-rpc-server.log"), env }
}

// ---------------------------------------------------------------------------------------------
// Links (head side)

/// The host part of `host:port` (`[fd00::1]:7778` keeps its brackets).
fn host_of(addr: &str) -> &str {
    addr.rsplit_once(':').map_or(addr, |(host, _)| host)
}

/// Times the link to [peer] and reports what it costs per token (spec/cluster.md, Capabilities):
/// the median round trip over five small posts, then the throughput of a 4 MiB post.
pub async fn meter(peer: &KnownNode, device: &StaticKey, network: &str) -> Result<LinkSpeed, String> {
    let (addrs, refused) = link_addrs(peer, network);
    if addrs.is_empty() {
        return Err(if refused.is_empty() {
            format!("{}: no address to reach", peer.name)
        } else {
            refused.join("; ")
        });
    }
    let key = peer.key_bytes()?;
    let (rtt_ms, mib_s) = crate::remote::meter_link(&addrs, &key, device, 5, 4 << 20).await?;
    Ok(LinkSpeed { node: peer.name.clone(), rtt_ms, mib_s })
}

/// The addresses of [peer] a shard link may use under [network] (spec/cluster.md, Links), and why
/// the others may not.
pub fn link_addrs(peer: &KnownNode, network: &str) -> (Vec<String>, Vec<String>) {
    let (mut ok, mut refused) = (Vec::new(), Vec::new());
    for addr in &peer.addrs {
        let decision = decide_link(&LinkInput { network: network.to_owned(), host: host_of(addr).to_owned() });
        match decision.action {
            LinkAction::Direct => ok.push(addr.clone()),
            LinkAction::Block => refused.push(format!(
                "{addr}: {}",
                serde_json::to_value(decision.reason)
                    .ok()
                    .and_then(|v| v.as_str().map(str::to_owned))
                    .unwrap_or_default()
            )),
        }
    }
    (ok, refused)
}

/// A loopback door to one peer's `ggml-rpc-server`: every connection to it is a shard link.
pub struct Link {
    pub peer: KnownNode,
    /// The loopback port `llama-server --rpc` connects to.
    pub port: u16,
    pub traffic: Arc<Traffic>,
    /// Links open now.
    pub open: Arc<std::sync::atomic::AtomicUsize>,
    /// Why the last link failed.
    pub error: Arc<Mutex<Option<String>>>,
}

/// Opens [peer]'s door on a loopback port, with this machine's device key [device], under
/// [network] (the link rule is checked for every connection).
pub async fn open_link(peer: KnownNode, device: StaticKey, network: String) -> Result<Arc<Link>, String> {
    let listener = TcpListener::bind("127.0.0.1:0").await.map_err(|e| e.to_string())?;
    let port = listener.local_addr().map_err(|e| e.to_string())?.port();
    let key = peer.key_bytes()?;
    let link = Arc::new(Link { peer, port, traffic: Arc::default(), open: Arc::default(), error: Arc::default() });
    let (traffic, open, error, peer) = (link.traffic.clone(), link.open.clone(), link.error.clone(), link.peer.clone());
    tokio::spawn(async move {
        loop {
            let Ok((local, _)) = listener.accept().await else {
                tokio::time::sleep(Duration::from_millis(100)).await;
                continue;
            };
            let _ = local.set_nodelay(true);
            let (addrs, refused) = link_addrs(&peer, &network);
            let (key, device, traffic, open, error, name) =
                (key.clone(), device.clone(), traffic.clone(), open.clone(), error.clone(), peer.name.clone());
            tokio::spawn(async move {
                if addrs.is_empty() {
                    let why = format!("no address of {name} may carry a shard link ({})", refused.join("; "));
                    tracing::warn!("{why}");
                    *error.lock().expect("link error lock") = Some(why);
                    return;
                }
                match remote::connect_shard(&addrs, &key, &device).await {
                    Ok((tcp, transport)) => {
                        *error.lock().expect("link error lock") = None;
                        open.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
                        remote::pipe_counted(tcp, transport, local, || true, Some(traffic)).await;
                        open.fetch_sub(1, std::sync::atomic::Ordering::Relaxed);
                    }
                    Err(e) => {
                        tracing::warn!(peer = %name, "shard link refused: {e}");
                        *error.lock().expect("link error lock") = Some(e);
                    }
                }
            });
        }
    });
    Ok(link)
}

/// [peer]'s capabilities, over a session (and only by addresses the link rule allows).
pub async fn probe_peer(peer: &KnownNode, device: &StaticKey, network: &str) -> Result<Capabilities, String> {
    let (addrs, refused) = link_addrs(peer, network);
    if addrs.is_empty() {
        return Err(format!("no address may be used ({})", refused.join("; ")));
    }
    let key = peer.key_bytes()?;
    let probe = remote::get_json(&addrs, &key, device, "/v1/cluster/node");
    let value = tokio::time::timeout(PROBE_TIMEOUT, probe).await.map_err(|_| "timed out".to_owned())??;
    serde_json::from_value(value).map_err(|e| e.to_string())
}

// ---------------------------------------------------------------------------------------------
// A model split across nodes

/// Where a cluster model runs now: its plan, and why not when it cannot.
pub struct ClusterRun {
    pub model: String,
    pub split: SplitMode,
    /// The head's name (the node's `[remote] name`).
    pub head: String,
    pub links: Vec<Arc<Link>>,
    state: RwLock<RunState>,
}

#[derive(Clone, Debug, Default, Serialize)]
pub struct RunState {
    pub plan: Option<Plan>,
    /// Peers left out of the plan, and why.
    pub notes: Vec<String>,
}

/// One node's part in an answer, for its receipt.
pub struct ShardUse {
    pub name: String,
    /// The peer's static key (base64url); none for the head, which signs the receipt.
    pub key: Option<String>,
    pub permille: u64,
    traffic: Option<(Arc<Traffic>, (u64, u64))>,
}

impl ShardUse {
    /// `{"name", "share", "key"?, "bytes_sent"?, "bytes_received"?}` (spec/receipts.md): the
    /// bytes through this peer's links since the request began.
    pub fn to_json(&self) -> Value {
        let mut entry = json!({ "name": self.name, "share": self.permille });
        if let Some(key) = &self.key {
            entry["key"] = json!(key);
        }
        if let Some((traffic, (sent, received))) = &self.traffic {
            let (now_sent, now_received) = traffic.get();
            entry["bytes_sent"] = json!(now_sent.saturating_sub(*sent));
            entry["bytes_received"] = json!(now_received.saturating_sub(*received));
        }
        entry
    }
}

impl std::fmt::Debug for ClusterRun {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "ClusterRun({})", self.model)
    }
}

impl ClusterRun {
    pub fn new(model: &str, split: SplitMode, head: &str, links: Vec<Arc<Link>>) -> Self {
        Self { model: model.to_owned(), split, head: head.to_owned(), links, state: RwLock::default() }
    }

    pub fn state(&self) -> RunState {
        self.state.read().expect("run lock").clone()
    }

    /// Records where the model runs now (the supervisor does; tests may).
    pub fn set(&self, state: RunState) {
        *self.state.write().expect("run lock") = state;
    }

    /// The nodes the current plan puts layers on, head first, with their shares.
    pub fn uses(&self) -> Vec<ShardUse> {
        let state = self.state();
        let Some(plan) = state.plan.filter(|p| p.action == PlanAction::Split) else { return Vec::new() };
        let mut per_node: BTreeMap<usize, (String, u64)> = BTreeMap::new();
        let order = |node: &str| {
            if node == self.head {
                0
            } else {
                1 + self.links.iter().position(|l| l.peer.name == node).unwrap_or(usize::MAX - 1)
            }
        };
        for share in &plan.shares {
            per_node.entry(order(&share.node)).or_insert_with(|| (share.node.clone(), 0)).1 += share.permille;
        }
        per_node
            .into_values()
            .map(|(name, permille)| {
                let link = self.links.iter().find(|l| l.peer.name == name);
                ShardUse {
                    key: link.map(|l| l.peer.key.clone()),
                    traffic: link.map(|l| (l.traffic.clone(), l.traffic.get())),
                    name,
                    permille,
                }
            })
            .collect()
    }
}

/// What the head knows about itself, for planning.
pub struct Head {
    pub devices: Vec<Device>,
    pub rpc_backend: Option<bool>,
    pub device_key: StaticKey,
    pub network: String,
    pub model_bytes: u64,
}

/// The `--rpc` and `--tensor-split` arguments for [plan]: llama.cpp puts RPC devices first, in
/// `--rpc` order and each server's own order, then this machine's.
pub fn split_args(plan: &Plan, head: &str, head_devices: &[Device], peers: &[(Arc<Link>, Vec<Device>)]) -> Vec<String> {
    let share = |node: &str, device: &str| {
        plan.shares.iter().find(|s| s.node == node && s.device == device).map_or(0, |s| s.permille)
    };
    let (mut rpc, mut split) = (Vec::new(), Vec::new());
    for (link, devices) in peers {
        if !plan.shares.iter().any(|s| s.node == link.peer.name) {
            continue;
        }
        rpc.push(format!("127.0.0.1:{}", link.port));
        split.extend(devices.iter().map(|d| share(&link.peer.name, &d.name)));
    }
    split.extend(head_devices.iter().map(|d| share(head, &d.name)));
    if rpc.is_empty() {
        return Vec::new();
    }
    let split: Vec<String> = split.iter().map(u64::to_string).collect();
    vec!["--rpc".to_owned(), rpc.join(","), "--tensor-split".to_owned(), split.join(",")]
}

/// The plan for one round of supervision. With no device to anchor layers on, the model runs here
/// as this node did before the model named a peer: asking the policy would block forever on
/// `PlanReason::NoDevices`, which reads as a memory shortfall and is not one (spec/cluster.md,
/// Known limits). With a device, the policy decides, exactly as it would alone.
fn plan_or_local(head_devices: &[Device], input: &PlanInput) -> Plan {
    if head_devices.is_empty() {
        return Plan { action: PlanAction::Local, need_mib: 0, shares: Vec::new(), reason: None, predicted_tps: None };
    }
    invincible_policy::plan(input)
}

/// The split the next plan is compared against: the one in the run state, which survives the engine
/// exiting so hysteresis has something to compare (spec/cluster.md, Stability). Empty before the
/// first plan.
fn current_shares(state: &RunState) -> Vec<Share> {
    state.plan.as_ref().map(|plan| plan.shares.clone()).unwrap_or_default()
}

/// The run state after the engine exits: the plan is kept, not cleared. Clearing it left
/// `PlanInput::current` empty on every replan, made hysteresis dead, and resharded on each restart.
fn after_run(plan: Plan) -> RunState {
    RunState { plan: Some(plan), notes: vec!["restarting".into()] }
}

/// Whether [caps] can take layers for a model: it serves as a shard, and it names a device to put
/// them on. When it cannot, [peer_refusal] says which of the two failed.
fn can_take_layers(caps: &Capabilities) -> bool {
    caps.shard && !caps.devices.is_empty()
}

/// Why [caps] cannot take layers for a model, in words. A node told not to serve and a node that
/// serves but has no device are different causes: reporting the first for the second hid the real
/// one and sent the reader to `[cluster] serve`, which was already true.
fn peer_refusal(caps: &Capabilities) -> String {
    if !caps.shard {
        "does not serve as a shard for this node (`[cluster] serve` and `heads` on that node)".to_owned()
    } else {
        "serves as a shard but reports no usable device (`llama-server --list-devices`)".to_owned()
    }
}

/// Why this head cannot split a model now, in words; `None` when it can. Kept apart from the peer
/// probing below: a head that cannot shard still asks its peers what they are.
fn head_blocker(rpc_backend: Option<bool>, devices: &[Device]) -> Option<&'static str> {
    if rpc_backend == Some(false) {
        Some("this llama-server has no RPC backend (build it with GGML_RPC=ON; see spec/cluster.md)")
    } else if devices.is_empty() {
        Some(
            "no GPU device (`llama-server --list-devices`): running locally. A split needs a GPU head (spec/cluster.md, Known limits)",
        )
    } else {
        None
    }
}

/// What to record about a peer whose capabilities were just read: `None` when it takes layers and
/// this head can send it some. [here] is this head's own reason for not splitting, when it has one:
/// the peer's real capability is then reported next to it, so "this head cannot shard here" is
/// never read as "the peer is not there".
fn peer_note(caps: &Capabilities, here: Option<&str>) -> Option<String> {
    let usable = can_take_layers(caps);
    if usable && here.is_none() {
        return None;
    }
    let devices: Vec<&str> = caps.devices.iter().map(|d| d.name.as_str()).collect();
    let what = if usable { format!("serves as a shard ({})", devices.join(", ")) } else { peer_refusal(caps) };
    Some(match here {
        Some(why) => format!("{what}; cannot shard here: {why}"),
        None => what,
    })
}

/// Plans [run] over the head and the peers that answer, runs llama-server with that plan, and
/// plans again whenever it exits: a peer that left is planned around (or the model waits,
/// unhealthy, when the rest cannot hold it), so the router sends requests elsewhere meanwhile.
pub fn supervise(engine: Engine, base: Launch, run: Arc<ClusterRun>, head: Head) -> JoinHandle<()> {
    tokio::spawn(async move {
        let client = crate::engine::health_client();
        let mut backoff = Duration::from_secs(1);
        loop {
            let mut notes = Vec::new();
            let mut devices: Vec<PlanDevice> = head
                .devices
                .iter()
                .map(|d| PlanDevice { node: run.head.clone(), device: d.name.clone(), free_mib: d.free_mib })
                .collect();
            let mut peers = Vec::new();
            let mut measured = Vec::new();
            // Probe the peers even when this head cannot split: their capabilities are what
            // `cluster status` reports, and "this head cannot shard here" is not "the peer is not
            // there". They are only used when the head can shard.
            let here = head_blocker(head.rpc_backend, &head.devices);
            if let Some(why) = here {
                notes.push(why.to_owned());
            }
            for link in &run.links {
                match probe_peer(&link.peer, &head.device_key, &head.network).await {
                    Ok(caps) => {
                        if let Some(note) = peer_note(&caps, here) {
                            notes.push(format!("{}: {note}", link.peer.name));
                        }
                        if here.is_some() || !can_take_layers(&caps) {
                            continue;
                        }
                        devices.extend(caps.devices.iter().map(|d| PlanDevice {
                            node: link.peer.name.clone(),
                            device: d.name.clone(),
                            free_mib: d.free_mib,
                        }));
                        // What the peer measured on itself, for this model and this hardware.
                        for set in caps.profiles.iter().filter(|s| s.model == run.model && s.hardware == caps.hardware)
                        {
                            for profile in
                                set.profiles.iter().filter(|p| caps.devices.iter().any(|d| d.name == p.device))
                            {
                                measured.push(Measurement {
                                    node: link.peer.name.clone(),
                                    device: profile.device.clone(),
                                    tg_tps: profile.tg_tps,
                                });
                            }
                        }
                        peers.push((link.clone(), caps.devices));
                    }
                    Err(e) => notes.push(format!("{}: {e}", link.peer.name)),
                }
            }
            // This machine's own measurements, the links, and the split already running.
            let mut links = Vec::new();
            if let Ok(home) = crate::config::home() {
                measured.extend(crate::tune::measured(
                    &home,
                    &run.model,
                    &run.head,
                    &crate::tune::hardware_now(),
                    &head.devices,
                ));
                links = crate::tune::load_links(&home, 1);
                for (peer_link, _) in &peers {
                    if links.iter().any(|l| l.node == peer_link.peer.name) {
                        continue;
                    }
                    // A slow or unreachable peer must not hold up the plan: time the meter out.
                    let metered = tokio::time::timeout(
                        LINK_METER_TIMEOUT,
                        meter(&peer_link.peer, &head.device_key, &head.network),
                    )
                    .await;
                    match metered {
                        Ok(Ok(speed)) => {
                            let _ = crate::tune::record_link(&home, speed.clone());
                            links.push(speed);
                        }
                        Ok(Err(e)) => notes.push(format!("{}: link not measured: {e}", peer_link.peer.name)),
                        Err(_) => notes.push(format!("{}: link meter timed out", peer_link.peer.name)),
                    }
                }
            }
            let mut input = PlanInput::new(head.model_bytes, run.split, devices);
            input.measured = measured;
            input.links = links;
            input.current = current_shares(&run.state());
            let plan = plan_or_local(&head.devices, &input);
            for note in &notes {
                tracing::warn!(model = %run.model, "cluster: {note}");
            }
            let mut launch = base.clone();
            match plan.action {
                PlanAction::Block => {
                    tracing::warn!(model = %run.model, need_mib = plan.need_mib, "cluster: the devices that answered cannot hold it");
                    run.set(RunState { plan: Some(plan), notes });
                    engine.set_healthy(false);
                    tokio::time::sleep(REPLAN).await;
                    continue;
                }
                PlanAction::Split => {
                    launch.args.extend(split_args(&plan, &run.head, &head.devices, &peers));
                    tracing::info!(model = %run.model, shares = ?plan.shares, "cluster: split");
                }
                PlanAction::Local => tracing::info!(model = %run.model, "cluster: runs on this machine alone"),
            }
            run.set(RunState { plan: Some(plan.clone()), notes });
            let started = tokio::time::Instant::now();
            crate::engine::run_once(&engine, &launch, &client).await;
            // Keep the plan: it is what the next replan compares against (spec/cluster.md,
            // Stability). Clearing it made hysteresis dead and resharded on every restart.
            run.set(after_run(plan));
            if started.elapsed() >= Duration::from_secs(60) {
                backoff = Duration::from_secs(1);
            }
            tokio::time::sleep(backoff).await;
            backoff = (backoff * 2).min(Duration::from_secs(30));
        }
    })
}

// ---------------------------------------------------------------------------------------------
// Status

/// What the node knows about its cluster, for `GET /v1/cluster` and `GET /v1/cluster/node`.
pub struct ClusterState {
    pub name: String,
    pub llama_server: PathBuf,
    pub rpc_backend: Option<bool>,
    /// Nodes this machine paired with as a device: the peers it may use.
    pub peers: Vec<KnownNode>,
    pub device_key: Option<StaticKey>,
    pub runs: Vec<Arc<ClusterRun>>,
    /// Whether this node serves as a shard.
    pub shard: bool,
    /// The model ids this node serves, and how many dispatched requests it will run at once
    /// (spec/dispatch.md, `[node] dispatch_max_inflight`).
    pub models: Vec<String>,
    pub dispatch_max_inflight: u64,
}

impl ClusterState {
    /// This node's capabilities now (devices probed afresh: their free memory changes).
    pub async fn capabilities(&self) -> Capabilities {
        Capabilities {
            name: self.name.clone(),
            version: crate::version::VERSION.to_owned(),
            memory_bytes: memory_bytes(),
            devices: probe_devices(&self.llama_server).await,
            rpc_backend: self.rpc_backend,
            shard: self.shard,
            profiles: crate::config::home().map(|home| crate::tune::load_all(&home)).unwrap_or_default(),
            hardware: crate::tune::hardware_now(),
            // One request at a time unless the node is configured otherwise; a shard advertises
            // nothing, because its capacity is spoken for by the model it splits.
            dispatch: (!self.shard).then_some(Dispatch { max_inflight: self.dispatch_max_inflight, queue: 0 }),
            models: self.models.clone(),
        }
    }

    /// The whole picture: this node, its peers (probed now), the heads it serves, its models.
    pub async fn status(&self, network: &str, shard: Option<&remote::ShardService>) -> Value {
        let me = self.capabilities().await;
        let probes = self.peers.iter().map(|peer| async move {
            let (addrs, refused) = link_addrs(peer, network);
            let key = peer.key_bytes().ok();
            let mut entry = json!({
                "name": peer.name,
                "fingerprint": key.as_deref().map(crate::devices::fingerprint),
                "addrs": peer.addrs,
                "link_addrs": addrs,
                "refused_addrs": refused,
            });
            let Some(device) = &self.device_key else { return entry };
            let started = std::time::Instant::now();
            match probe_peer(peer, device, network).await {
                Ok(caps) => {
                    entry["reachable"] = json!(true);
                    entry["probe_ms"] = json!(started.elapsed().as_millis() as u64);
                    entry["capabilities"] = json!(caps);
                }
                Err(e) => {
                    entry["reachable"] = json!(false);
                    entry["error"] = json!(e);
                }
            }
            entry
        });
        let peers: Vec<Value> = futures_util::future::join_all(probes).await;
        let models: Vec<Value> = self
            .runs
            .iter()
            .map(|run| {
                let links: Vec<Value> = run
                    .links
                    .iter()
                    .map(|l| {
                        let (sent, received) = l.traffic.get();
                        json!({
                            "peer": l.peer.name,
                            "port": l.port,
                            "open": l.open.load(std::sync::atomic::Ordering::Relaxed),
                            "bytes_sent": sent,
                            "bytes_received": received,
                            "error": *l.error.lock().expect("link error lock"),
                        })
                    })
                    .collect();
                json!({ "id": run.model, "split": run.split, "state": run.state(), "links": links })
            })
            .collect();
        let serving = shard.map(|s| {
            let (sent, received) = s.traffic.get();
            json!({ "heads": s.heads, "bytes_sent": sent, "bytes_received": received })
        });
        json!({ "node": me, "network": network, "shard": serving, "peers": peers, "models": models })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_llama_server_device_lists() {
        let text = "ggml_metal_device_init: GPU name:   MTL0 (Apple M3 Pro)\nAvailable devices:\n  MTL0: Apple M3 Pro (28753 MiB, 28753 MiB free)\n  BLAS: Accelerate (0 MiB, 0 MiB free)\n  CUDA1: NVIDIA GeForce RTX 4090 (24080 MiB, 23000 MiB free)\n";
        assert_eq!(
            parse_devices(text),
            vec![
                Device { name: "MTL0".into(), description: "Apple M3 Pro".into(), total_mib: 28753, free_mib: 28753 },
                Device {
                    name: "CUDA1".into(),
                    description: "NVIDIA GeForce RTX 4090".into(),
                    total_mib: 24080,
                    free_mib: 23000
                },
            ]
        );
        assert!(parse_devices("").is_empty());
        assert!(parse_devices("  X: y (lots, none)").is_empty());
    }

    #[test]
    fn knows_a_build_without_rpc() {
        assert!(!rpc_backend_in("error while handling argument \"--rpc\": RPC not supported in this build"));
        assert!(rpc_backend_in("ggml-rpc.cpp:650: Failed to connect to 127.0.0.1:9"));
    }

    #[test]
    fn hosts_of_addresses() {
        assert_eq!(host_of("192.168.1.2:7778"), "192.168.1.2");
        assert_eq!(host_of("[fd00::1]:7778"), "[fd00::1]");
        assert_eq!(host_of("mini.local:7778"), "mini.local");
    }

    #[test]
    fn link_addresses_follow_the_rule() {
        let peer = KnownNode {
            device: None,
            name: "mini".into(),
            key: String::new(),
            addrs: vec!["127.0.0.1:7778".into(), "192.168.1.5:7778".into(), "203.0.113.9:7778".into()],
            receipt_key: None,
        };
        let (ok, refused) = link_addrs(&peer, "direct");
        assert_eq!(ok, ["127.0.0.1:7778", "192.168.1.5:7778"]);
        assert_eq!(refused, ["203.0.113.9:7778: not_lan"]);
        let (ok, refused) = link_addrs(&peer, "offline");
        assert_eq!(ok, ["127.0.0.1:7778"]);
        assert_eq!(refused.len(), 2);
    }

    fn link(name: &str, port: u16) -> Arc<Link> {
        Arc::new(Link {
            peer: KnownNode {
                name: name.into(),
                key: format!("key-{name}"),
                addrs: vec![],
                receipt_key: None,
                device: None,
            },
            port,
            traffic: Arc::default(),
            open: Arc::default(),
            error: Arc::default(),
        })
    }

    fn device(name: &str, free_mib: u64) -> Device {
        Device { name: name.into(), description: String::new(), total_mib: free_mib, free_mib }
    }

    #[test]
    fn split_arguments_put_rpc_devices_first() {
        let head = [device("MTL0", 28000)];
        let peers = vec![
            (link("box", 4001), vec![device("CUDA0", 24000), device("CUDA1", 24000)]),
            (link("idle", 4002), vec![device("MTL0", 0)]),
        ];
        let mut devices: Vec<PlanDevice> = head
            .iter()
            .map(|d| PlanDevice { node: "studio".into(), device: d.name.clone(), free_mib: d.free_mib })
            .collect();
        for (l, ds) in &peers {
            devices.extend(ds.iter().map(|d| PlanDevice {
                node: l.peer.name.clone(),
                device: d.name.clone(),
                free_mib: d.free_mib,
            }));
        }
        let plan = invincible_policy::plan(&PlanInput::new(50 << 30, SplitMode::Auto, devices));
        assert_eq!(plan.action, PlanAction::Split);
        // The idle peer holds nothing, so llama-server is not given it.
        assert_eq!(
            split_args(&plan, "studio", &head, &peers),
            ["--rpc", "127.0.0.1:4001", "--tensor-split", "316,316,368"]
        );
        let local = invincible_policy::plan(&PlanInput::new(1 << 30, SplitMode::Auto, vec![]));
        assert!(split_args(&local, "studio", &head, &peers).is_empty());
    }

    #[test]
    fn a_split_names_its_nodes_head_first() {
        let run = ClusterRun::new("big", SplitMode::Always, "studio", vec![link("mini", 1), link("box", 2)]);
        assert!(run.uses().is_empty(), "nothing planned yet");
        let plan = invincible_policy::plan(&PlanInput::new(
            1 << 30,
            SplitMode::Always,
            vec![
                PlanDevice { node: "studio".into(), device: "MTL0".into(), free_mib: 2000 },
                PlanDevice { node: "box".into(), device: "CUDA0".into(), free_mib: 1000 },
                PlanDevice { node: "box".into(), device: "CUDA1".into(), free_mib: 1000 },
            ],
        ));
        run.set(RunState { plan: Some(plan), notes: vec![] });
        let uses: Vec<Value> = run.uses().iter().map(ShardUse::to_json).collect();
        assert_eq!(
            uses,
            [
                json!({ "name": "studio", "share": 500 }),
                json!({ "name": "box", "share": 500, "key": "key-box", "bytes_sent": 0, "bytes_received": 0 }),
            ]
        );
    }

    #[test]
    fn rpc_launch_stays_on_loopback() {
        let launch = rpc_launch(Path::new("/x/ggml-rpc-server"), 5000, Some(Path::new("/c")), Path::new("/logs"));
        assert_eq!(launch.args[..4], ["--host", "127.0.0.1", "--port", "5000"]);
        assert!(launch.args.contains(&"--cache".to_owned()));
        assert!(launch.env.contains(&("LLAMA_CACHE".to_owned(), "/c".to_owned())));
    }

    #[test]
    fn a_head_without_a_device_runs_the_model_here() {
        // A CPU-only head has nothing to anchor layers on. Handing that to the policy blocks
        // (NoDevices), and in the live node a block meant unhealthy and a 15 s sleep for ever: the
        // model must run here instead, and the plan must not claim a memory need it never measured.
        let input = PlanInput::new(8 << 30, SplitMode::Auto, Vec::new());
        assert_eq!(invincible_policy::plan(&input).action, PlanAction::Block, "the policy alone still blocks");
        let plan = plan_or_local(&[], &input);
        assert_eq!(plan.action, PlanAction::Local);
        assert_eq!(plan.need_mib, 0);
        assert!(plan.shares.is_empty());
        assert_eq!(plan.reason, None);

        // With a device the policy decides, and its answer is what runs: too big for the head blocks.
        let head = [device("MTL0", 3000)];
        let devices = vec![PlanDevice { node: "studio".into(), device: "MTL0".into(), free_mib: 3000 }];
        let too_big = PlanInput::new(8 << 30, SplitMode::Always, devices.clone());
        let plan = plan_or_local(&head, &too_big);
        assert_eq!(plan, invincible_policy::plan(&too_big), "with a device, the policy decides");
        assert_eq!(plan.action, PlanAction::Block);
        assert_eq!(plan.reason, Some(invincible_policy::PlanReason::DoesNotFit));
        // And one that fits is local with the policy's own memory figure, not the fallback's zero:
        // through the policy, not around it.
        let fits = PlanInput::new(1 << 30, SplitMode::Auto, devices);
        let plan = plan_or_local(&head, &fits);
        assert_eq!(plan, invincible_policy::plan(&fits));
        assert_eq!(plan.action, PlanAction::Local);
        assert!(plan.need_mib > 512, "the policy measured the model: {}", plan.need_mib);
    }

    #[test]
    fn a_serving_peer_with_no_device_is_not_reported_as_told_not_to_serve() {
        // `[cluster] serve = true` and a llama-server that names no device: the node was told to
        // serve and cannot. Reporting "not serving as a shard ([cluster] serve)" pointed the reader
        // at a setting that was already true and hid the cause.
        let serving = Capabilities { shard: true, devices: Vec::new(), ..Default::default() };
        assert!(!can_take_layers(&serving));
        let note = peer_refusal(&serving);
        assert!(note.contains("no usable device"), "{note}");
        assert!(!note.contains("[cluster] serve"), "it serves; that is not why it is unused: {note}");

        // Told not to serve (or not for this head): say that, and only that.
        let told = Capabilities { shard: false, devices: vec![device("CUDA0", 24_000)], ..Default::default() };
        assert!(!can_take_layers(&told), "a device does not make a node that refuses us usable");
        let note = peer_refusal(&told);
        assert!(note.contains("does not serve as a shard"), "{note}");
        assert!(!note.contains("no usable device"), "it has one; the setting is the cause: {note}");

        // Both: it serves and has a device, so it takes layers and there is nothing to report.
        let ready = Capabilities { shard: true, devices: vec![device("CUDA0", 24_000)], ..Default::default() };
        assert!(can_take_layers(&ready));
    }

    #[test]
    fn a_head_that_cannot_shard_still_says_what_its_peers_are() {
        // A head built without RPC used to skip the peers entirely, so nothing about them reached
        // the plan's notes (`cluster status` prints those). The peers are reachable and capable;
        // what is missing is the head, and the note must say both.
        let no_rpc = head_blocker(Some(false), &[device("MTL0", 28_000)]);
        assert!(no_rpc.unwrap().contains("no RPC backend"));
        let no_device = head_blocker(Some(true), &[]);
        assert!(no_device.unwrap().contains("no GPU device"));
        assert_eq!(head_blocker(Some(true), &[device("MTL0", 28_000)]), None);
        assert_eq!(head_blocker(None, &[device("MTL0", 28_000)]), None, "an unchecked build is tried");

        let peer = Capabilities { shard: true, devices: vec![device("CUDA0", 24_000)], ..Default::default() };
        let note = peer_note(&peer, no_rpc).expect("the peer's capability is reported");
        assert!(note.contains("serves as a shard (CUDA0)"), "{note}");
        assert!(note.contains("cannot shard here: "), "{note}");
        assert!(note.contains("no RPC backend"), "the head's own cause is named: {note}");
        // With a head that can shard, a peer like that is used and there is nothing to say.
        assert_eq!(peer_note(&peer, None), None);

        // A peer that cannot take layers says why, with the head's reason after it when there is one.
        let idle = Capabilities { shard: true, devices: Vec::new(), ..Default::default() };
        let note = peer_note(&idle, no_rpc).unwrap();
        assert!(note.contains("no usable device") && note.contains("cannot shard here"), "{note}");
        assert_eq!(peer_note(&idle, None), Some(peer_refusal(&idle)));
    }

    #[tokio::test]
    async fn the_advertised_dispatch_capacity_is_the_configured_one() {
        // Whatever a node advertises on `GET /v1/cluster/node` is what dispatchers size it by
        // (spec/dispatch.md). It must be `[node] dispatch_max_inflight`, read from the config, not
        // a literal in this module: one request, four, or zero for a node that is spoken for.
        let state = |config: &crate::config::Config| ClusterState {
            name: "studio".into(),
            llama_server: PathBuf::from("/nonexistent/llama-server"),
            rpc_backend: None,
            peers: Vec::new(),
            device_key: None,
            runs: Vec::new(),
            shard: false,
            models: vec!["qwen3-4b".into()],
            dispatch_max_inflight: config.node.dispatch_max_inflight,
        };
        let default = crate::config::Config::parse("").unwrap();
        assert_eq!(default.node.dispatch_max_inflight, 1, "the default is one at a time");
        let caps = state(&default).capabilities().await;
        assert_eq!(caps.dispatch.map(|d| d.max_inflight), Some(1));

        let four = crate::config::Config::parse("[node]\ndispatch_max_inflight = 4\n").unwrap();
        let caps = state(&four).capabilities().await;
        assert_eq!(caps.dispatch.map(|d| d.max_inflight), Some(4), "the configured number, not a literal");

        let zero = crate::config::Config::parse("[node]\ndispatch_max_inflight = 0\n").unwrap();
        let caps = state(&zero).capabilities().await;
        assert_eq!(caps.dispatch.map(|d| d.max_inflight), Some(0), "zero is spoken for, not unset");
    }

    #[test]
    fn the_plan_is_kept_after_the_engine_exits() {
        let plan = invincible_policy::plan(&PlanInput::new(
            16 << 30,
            SplitMode::Always,
            vec![
                PlanDevice { node: "studio".into(), device: "MTL0".into(), free_mib: 30_000 },
                PlanDevice { node: "box".into(), device: "MTL0".into(), free_mib: 4_000 },
            ],
        ));
        let state = after_run(plan.clone());
        assert_eq!(state.plan, Some(plan.clone()), "the plan survives the restart");
        assert_eq!(state.notes, ["restarting"]);
        // Which is what the next round hands the policy as `current` (spec/cluster.md, Stability).
        assert_eq!(current_shares(&state), plan.shares);
        assert!(current_shares(&RunState::default()).is_empty(), "nothing planned yet");
    }

    #[test]
    fn the_node_hands_the_policy_the_split_it_is_running() {
        // Two rounds as the supervisor runs them, over a peer that got slower between replans.
        // The fresh best is then all on the head (Local), but the running split is still within
        // HYSTERESIS of it, so a node that feeds `current` keeps the split and one that does not
        // reshards. This is the wiring commit efb5b7f restored, made observable.
        let head = [device("MTL0", 30_000)];
        let round = |head_tps: f64, peer_tps: f64| {
            let mut input = PlanInput::new(
                16 << 30,
                SplitMode::Always,
                vec![
                    PlanDevice { node: "studio".into(), device: "MTL0".into(), free_mib: 30_000 },
                    PlanDevice { node: "box".into(), device: "MTL0".into(), free_mib: 4_000 },
                ],
            );
            input.measured = vec![
                Measurement { node: "studio".into(), device: "MTL0".into(), tg_tps: head_tps },
                Measurement { node: "box".into(), device: "MTL0".into(), tg_tps: peer_tps },
            ];
            input.links = vec![LinkSpeed { node: "box".into(), rtt_ms: 0.3, mib_s: 120.0 }];
            input
        };

        // First round: nothing running, so the policy splits by speed.
        let first = plan_or_local(&head, &round(50.0, 100.0));
        assert_eq!(first.action, PlanAction::Split);
        assert_eq!(first.shares.iter().map(|s| s.permille).collect::<Vec<_>>(), [806, 194]);
        let running = current_shares(&after_run(first.clone()));

        // Second round: the peer now measures slower than the head, so the fresh best is Local.
        let slower = round(50.0, 45.0);
        assert_eq!(plan_or_local(&head, &slower).action, PlanAction::Local, "the fresh best is all head");
        let mut next = slower;
        next.current = running.clone();
        let plan = plan_or_local(&head, &next);
        assert_eq!(plan.shares, running, "the running split is kept, not resharded");
        assert_eq!(plan.action, PlanAction::Split);
        assert_eq!(plan.predicted_tps, Some(47.5));
    }
}
