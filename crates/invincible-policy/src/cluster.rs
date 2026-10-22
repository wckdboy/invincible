//! Cluster rules (spec/cluster.md): whether a node may open a shard link to a paired peer, and
//! how a model's layers are shared out over the devices of the nodes taking part.

use serde::{Deserialize, Serialize};

use crate::{NetworkMode, is_loopback};

/// One shard link, as spec/cluster.md takes it.
#[derive(Clone, Debug, Deserialize)]
pub struct LinkInput {
    /// The encoded network mode ([NetworkMode::decode]).
    pub network: String,
    /// The peer's host, as pinned at pairing (an address, or a `.local` name).
    pub host: String,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum LinkAction {
    Direct,
    Block,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum LinkReason {
    /// The kill switch: `[node] network = "offline"`.
    Offline,
    /// Not a local-network address: shard links stay on the LAN (and never go through a proxy).
    NotLan,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct LinkDecision {
    pub action: LinkAction,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<LinkReason>,
}

/// Whether [host] is on a local network, without any lookup: private IPv4 (10/8, 172.16/12,
/// 192.168/16), link-local (169.254/16, fe80::/10, the Thunderbolt bridge), shared/CGNAT space
/// (100.64/10, where Tailscale puts its nodes), unique-local IPv6 (fc00::/7), or a `.local` name.
pub fn is_lan(host: &str) -> bool {
    let host = host.trim().to_ascii_lowercase();
    let host = host.strip_prefix('[').and_then(|h| h.strip_suffix(']')).unwrap_or(&host);
    if let Some(name) = host.strip_suffix(".local") {
        return !name.is_empty() && name.split('.').all(|label| !label.is_empty());
    }
    match host.parse::<std::net::IpAddr>() {
        Ok(std::net::IpAddr::V4(ip)) => {
            let [a, b, ..] = ip.octets();
            ip.is_private() || ip.is_link_local() || (a == 100 && (64..128).contains(&b))
        }
        Ok(std::net::IpAddr::V6(ip)) => {
            let first = ip.segments()[0];
            (first & 0xfe00) == 0xfc00 || (first & 0xffc0) == 0xfe80
        }
        Err(_) => false,
    }
}

/// The decision for one shard link (spec/cluster.md, Links).
pub fn decide_link(input: &LinkInput) -> LinkDecision {
    let block = |reason| LinkDecision { action: LinkAction::Block, reason: Some(reason) };
    if is_loopback(&input.host) {
        return LinkDecision { action: LinkAction::Direct, reason: None };
    }
    if NetworkMode::decode(&input.network).is_offline() {
        return block(LinkReason::Offline);
    }
    if !is_lan(&input.host) {
        return block(LinkReason::NotLan);
    }
    LinkDecision { action: LinkAction::Direct, reason: None }
}

/// When to share a model out.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum SplitMode {
    /// Only when it does not fit on the head's own devices.
    Auto,
    /// Over every device given, whenever there is more than the head's.
    Always,
}

/// One device that can hold layers.
#[derive(Clone, Debug, PartialEq, Eq, Deserialize, Serialize)]
pub struct PlanDevice {
    /// The node it is on (the head's devices come first).
    pub node: String,
    /// The device's name on that node (`MTL0`, `CUDA0`).
    pub device: String,
    pub free_mib: u64,
}

/// A device's measured generation rate for this model, alone on that device (tokens/s), from a
/// calibration run (`invincible tune probe`). Joined to [`PlanDevice`] by (node, device): a device
/// with no entry is uncalibrated, and one uncalibrated device makes the whole plan memory-only.
#[derive(Clone, Debug, PartialEq, Deserialize, Serialize)]
pub struct Measurement {
    pub node: String,
    pub device: String,
    pub tg_tps: f64,
}

/// What a shard link costs per token, measured over the link itself. Phase 1's numbers: a head
/// sends a shard about 31 KiB and gets 8.4 KiB back per generated token, so a remote stage adds a
/// round trip plus ~40 KiB of transfer to every token. Joined by node; a remote node with no entry
/// means no prediction, never a guess of zero.
#[derive(Clone, Debug, PartialEq, Deserialize, Serialize)]
pub struct LinkSpeed {
    pub node: String,
    pub rtt_ms: f64,
    pub mib_s: f64,
}

/// Activation traffic per generated token through one remote stage, in MiB: (31 + 8.4) KiB.
pub const TOKEN_MIB: f64 = 0.0385;

#[derive(Clone, Debug, Deserialize)]
pub struct PlanInput {
    /// The model's file size.
    pub model_bytes: u64,
    pub split: SplitMode,
    /// In order: the head's devices first, then each peer's.
    pub devices: Vec<PlanDevice>,
    /// What the nodes measured about themselves. Empty or partial: plan by memory (v0).
    #[serde(default)]
    pub measured: Vec<Measurement>,
    /// What the shard links cost per token (`invincible tune link`). Without an entry for a remote
    /// node the plan still picks shares by device speed, but reports no prediction.
    #[serde(default)]
    pub links: Vec<LinkSpeed>,
    /// The split running now, if any: kept unless another predicts at least [`HYSTERESIS`] better,
    /// because a reshard reloads the model on every node.
    #[serde(default)]
    pub current: Vec<Share>,
}

impl PlanInput {
    /// What a node knows before anything is calibrated: memory only, no running split.
    pub fn new(model_bytes: u64, split: SplitMode, devices: Vec<PlanDevice>) -> Self {
        Self { model_bytes, split, devices, measured: Vec::new(), links: Vec::new(), current: Vec::new() }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum PlanAction {
    /// On the head's own devices: no shards.
    Local,
    Split,
    Block,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum PlanReason {
    DoesNotFit,
}

/// One device's part of a split: thousandths of the layers.
#[derive(Clone, Debug, PartialEq, Eq, Deserialize, Serialize)]
pub struct Share {
    pub node: String,
    pub device: String,
    pub permille: u64,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct Plan {
    pub action: PlanAction,
    /// MiB the model needs (weights, 10% on top, 512 MiB of buffers and cache).
    pub need_mib: u64,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub shares: Vec<Share>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<PlanReason>,
    /// The generation rate these shares predict (tokens/s): a token crosses every stage, so stage
    /// times add. Absent when a device taking part is uncalibrated.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub predicted_tps: Option<f64>,
}

const MIB: u64 = 1 << 20;

/// A reshard reloads the model on every node and ends the requests in flight, so a running split is
/// kept unless another predicts at least 10% more tokens/s.
pub const HYSTERESIS: f64 = 0.9;

/// What one device can hold: 90% of what it reports free.
fn usable(device: &PlanDevice) -> u64 {
    device.free_mib / 10 * 9 + device.free_mib % 10 * 9 / 10
}

fn round2(x: f64) -> f64 {
    (x * 100.0).round() / 100.0
}

fn measured_tps(input: &PlanInput, device: &PlanDevice) -> Option<f64> {
    input
        .measured
        .iter()
        .find(|m| m.node == device.node && m.device == device.device)
        .map(|m| m.tg_tps)
        .filter(|t| t.is_finite() && *t > 0.0)
}

/// Thousandths of the model each device can hold, from its usable memory.
fn capacities(input: &PlanInput, need_mib: u64) -> Vec<u64> {
    input.devices.iter().map(|d| (usable(d).saturating_mul(1000) / need_mib.max(1)).min(1000)).collect()
}

/// Tokens/s predicted for these shares: `1 / (Σ share_i / tps_i + Σ links)`. Every token crosses
/// every stage, so throughputs do not add — times do — and every remote stage adds a round trip and
/// its activation traffic to every token.
fn pipeline_tps(shares: &[Share], input: &PlanInput) -> Option<f64> {
    if shares.is_empty() || shares.iter().map(|s| s.permille).sum::<u64>() != 1000 {
        return None;
    }
    let head = &input.devices.first()?.node;
    let mut seconds = 0.0;
    let mut remotes: Vec<&str> = Vec::new();
    for share in shares {
        let device = input.devices.iter().find(|d| d.node == share.node && d.device == share.device)?;
        seconds += (share.permille as f64 / 1000.0) / measured_tps(input, device)?;
        if &share.node != head && !remotes.contains(&share.node.as_str()) {
            remotes.push(&share.node);
        }
    }
    for node in remotes {
        let link = input.links.iter().find(|l| l.node == node)?;
        if !(link.rtt_ms.is_finite() && link.mib_s.is_finite() && link.mib_s > 0.0) {
            return None;
        }
        seconds += link.rtt_ms / 1000.0 + TOKEN_MIB / link.mib_s;
    }
    (seconds > 0.0).then(|| 1.0 / seconds)
}

/// Whether a given split still fits the devices as they are now (a peer may have gone, or lost
/// memory since the split was made).
fn fits_within_caps(input: &PlanInput, shares: &[Share], need_mib: u64) -> bool {
    if shares.iter().map(|s| s.permille).sum::<u64>() != 1000 {
        return false;
    }
    let caps = capacities(input, need_mib);
    shares.iter().all(|s| {
        input
            .devices
            .iter()
            .position(|d| d.node == s.node && d.device == s.device)
            .is_some_and(|i| s.permille <= caps[i])
    })
}

/// Shares by memory, as exo does: proportional to what each device can give, largest remainder —
/// floors first, then the leftover thousandths to the largest remainders (earlier devices first on
/// a tie), so the shares always add up to 1000.
fn memory_permille(input: &PlanInput, total: u64) -> Vec<u64> {
    let exact: Vec<(u64, u64)> = input
        .devices
        .iter()
        .map(|d| {
            let scaled = u128::from(usable(d)) * 1000;
            ((scaled / u128::from(total)) as u64, (scaled % u128::from(total)) as u64)
        })
        .collect();
    let mut permille: Vec<u64> = exact.iter().map(|(floor, _)| *floor).collect();
    let mut left = 1000 - permille.iter().sum::<u64>();
    let mut order: Vec<usize> = (0..exact.len()).collect();
    order.sort_by(|a, b| exact[*b].1.cmp(&exact[*a].1).then(a.cmp(b)));
    for i in order {
        if left == 0 {
            break;
        }
        permille[i] += 1;
        left -= 1;
    }
    permille
}

/// Shares by measured speed: fill the fastest device to what its memory allows, then the next.
///
/// For a pipeline a token's time is `Σ share_i / tps_i`, so the best split puts layers where a layer
/// is cheapest — on the fastest device, up to its memory — not in proportion to throughput. The
/// head keeps at least one thousandth: its own device runs the output block.
fn speed_permille(input: &PlanInput, need_mib: u64) -> Vec<u64> {
    let caps = capacities(input, need_mib);
    let mut permille = vec![0u64; input.devices.len()];
    let mut order: Vec<usize> = (0..input.devices.len()).collect();
    order.sort_by(|a, b| {
        let ta = measured_tps(input, &input.devices[*a]).unwrap_or(0.0);
        let tb = measured_tps(input, &input.devices[*b]).unwrap_or(0.0);
        tb.total_cmp(&ta).then(a.cmp(b))
    });

    let mut left = 1000u64;
    for &i in &order {
        if left == 0 {
            break;
        }
        let take = caps[i].min(left);
        permille[i] = take;
        left -= take;
    }
    // Flooring the capacities can leave a thousandth or two: the fastest devices take them.
    for &i in &order {
        if left == 0 {
            break;
        }
        permille[i] += 1;
        left -= 1;
    }

    let head = input.devices.first().map(|d| d.node.clone()).unwrap_or_default();
    let on_head: u64 = input.devices.iter().zip(&permille).filter(|(d, _)| d.node == head).map(|(_, p)| *p).sum();
    if on_head == 0 {
        let largest = (0..permille.len()).max_by_key(|i| permille[*i]);
        if let (Some(from), Some(to)) = (largest, input.devices.iter().position(|d| d.node == head))
            && permille[from] > 1
        {
            permille[from] -= 1;
            permille[to] += 1;
        }
    }
    permille
}

fn shares_of(input: &PlanInput, permille: Vec<u64>) -> Vec<Share> {
    input
        .devices
        .iter()
        .zip(permille)
        .filter(|(_, p)| *p > 0)
        .map(|(d, permille)| Share { node: d.node.clone(), device: d.device.clone(), permille })
        .collect()
}

/// Shares a model's layers out over devices (spec/cluster.md, Partitioning): by measured speed when
/// every device has been calibrated, else by memory as exo does. Either way pipeline (layer)
/// parallel, and the split already running is kept while it is close to the best.
pub fn plan(input: &PlanInput) -> Plan {
    let need_mib = input.model_bytes.saturating_add(input.model_bytes / 10).div_ceil(MIB).saturating_add(512);
    let head = input.devices.first().map(|d| d.node.clone()).unwrap_or_default();
    let head_usable: u64 = input.devices.iter().filter(|d| d.node == head).map(usable).sum();
    let peers = input.devices.iter().any(|d| d.node != head);
    let local = Plan { action: PlanAction::Local, need_mib, shares: Vec::new(), reason: None, predicted_tps: None };
    let fits_alone = need_mib <= head_usable;
    if !peers && fits_alone {
        return local;
    }
    if fits_alone && input.split == SplitMode::Auto {
        return local;
    }
    let total: u64 = input.devices.iter().map(usable).sum();
    if need_mib > total || total == 0 {
        return Plan {
            action: PlanAction::Block,
            need_mib,
            shares: Vec::new(),
            reason: Some(PlanReason::DoesNotFit),
            predicted_tps: None,
        };
    }
    let calibrated = input.devices.iter().all(|d| measured_tps(input, d).is_some());
    let permille = if calibrated { speed_permille(input, need_mib) } else { memory_permille(input, total) };
    let mut shares = shares_of(input, permille);
    let mut predicted = if calibrated { pipeline_tps(&shares, input).map(round2) } else { None };

    // Keep the split already running unless another predicts at least HYSTERESIS better.
    if calibrated
        && !input.current.is_empty()
        && fits_within_caps(input, &input.current, need_mib)
        && let (Some(running), Some(best)) = (pipeline_tps(&input.current, input), predicted)
        && running >= best * HYSTERESIS
    {
        shares = input.current.clone();
        predicted = Some(round2(running));
    }

    if shares.iter().all(|s| s.node == head) {
        return local;
    }
    Plan { action: PlanAction::Split, need_mib, shares, reason: None, predicted_tps: predicted }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn device(node: &str, free_mib: u64) -> PlanDevice {
        PlanDevice { node: node.into(), device: "MTL0".into(), free_mib }
    }

    fn link(node: &str) -> LinkSpeed {
        LinkSpeed { node: node.into(), rtt_ms: 0.3, mib_s: 120.0 }
    }

    fn measured(node: &str, tps: f64) -> Measurement {
        Measurement { node: node.into(), device: "MTL0".into(), tg_tps: tps }
    }

    fn input(model_bytes: u64, devices: Vec<PlanDevice>) -> PlanInput {
        PlanInput {
            model_bytes,
            split: SplitMode::Always,
            devices,
            measured: Vec::new(),
            links: Vec::new(),
            current: Vec::new(),
        }
    }

    #[test]
    fn lan_addresses() {
        for lan in [
            "10.0.0.2",
            "192.168.1.20",
            "172.16.0.1",
            "169.254.3.4",
            "100.101.102.103",
            "[fd00::1]",
            "fe80::1",
            "mini.local",
        ] {
            assert!(is_lan(lan), "{lan}");
        }
        for not in ["8.8.8.8", "100.128.0.1", "172.32.0.1", "example.com", "2001:db8::1", ".local", "a..local", ""] {
            assert!(!is_lan(not), "{not}");
        }
    }

    #[test]
    fn shares_add_up() {
        let devices = (0..7)
            .map(|i| PlanDevice { node: format!("n{i}"), device: "GPU".into(), free_mib: 1000 + i * 37 })
            .collect();
        let plan = plan(&input(1 << 30, devices));
        assert_eq!(plan.shares.iter().map(|s| s.permille).sum::<u64>(), 1000);
        assert_eq!(plan.predicted_tps, None);
    }

    #[test]
    fn the_fastest_device_fills_first() {
        // 8 GiB model: 9404 MiB needed. The peer is six times faster, so it takes every layer it
        // can hold; the head keeps its output block.
        let mut i = input(8 << 30, vec![device("studio", 8_000), device("box", 48_000)]);
        i.measured = vec![measured("studio", 10.0), measured("box", 60.0)];
        i.links = vec![link("box")];
        let plan = plan(&i);
        assert_eq!(plan.action, PlanAction::Split);
        let shares: Vec<(&str, u64)> = plan.shares.iter().map(|s| (s.node.as_str(), s.permille)).collect();
        assert_eq!(shares, vec![("studio", 1), ("box", 999)]);
        // 1 / (0.001/10 + 0.999/60 + 0.0003 + 0.0385/120) = 57.57
        assert_eq!(plan.predicted_tps, Some(57.57));
    }

    #[test]
    fn memory_caps_a_fast_device() {
        // 16 GiB model: 18535 MiB needed. The peer is twice as fast but can hold only 0.194 of it.
        let mut i = input(16 << 30, vec![device("studio", 30_000), device("box", 4_000)]);
        i.measured = vec![measured("studio", 50.0), measured("box", 100.0)];
        i.links = vec![link("box")];
        let plan = plan(&i);
        let shares: Vec<(&str, u64)> = plan.shares.iter().map(|s| (s.node.as_str(), s.permille)).collect();
        assert_eq!(shares, vec![("studio", 806), ("box", 194)]);
        // 1 / (0.194/100 + 0.806/50 + 0.0003 + 0.0385/120) = 53.53
        assert_eq!(plan.predicted_tps, Some(53.53));
    }

    #[test]
    fn the_running_split_is_kept_when_it_is_close() {
        let mut i = input(16 << 30, vec![device("studio", 30_000), device("box", 4_000)]);
        i.measured = vec![measured("studio", 50.0), measured("box", 100.0)];
        i.links = vec![link("box")];
        i.current = vec![
            Share { node: "studio".into(), device: "MTL0".into(), permille: 900 },
            Share { node: "box".into(), device: "MTL0".into(), permille: 100 },
        ];
        let plan = plan(&i);
        // 1 / (0.9/50 + 0.1/100 + 0.0003 + 0.0385/120) = 50.97, within 10% of 53.53.
        assert_eq!(plan.shares, i.current);
        assert_eq!(plan.predicted_tps, Some(50.97));
    }

    #[test]
    fn a_running_split_that_no_longer_fits_is_replanned() {
        let mut i = input(16 << 30, vec![device("studio", 30_000), device("box", 4_000)]);
        i.measured = vec![measured("studio", 50.0), measured("box", 100.0)];
        i.current = vec![
            Share { node: "studio".into(), device: "MTL0".into(), permille: 500 },
            Share { node: "box".into(), device: "MTL0".into(), permille: 500 },
        ];
        let plan = plan(&i);
        assert_eq!(plan.shares.iter().map(|s| s.permille).collect::<Vec<_>>(), vec![806, 194]);
    }

    #[test]
    fn without_a_link_number_there_is_no_prediction() {
        let mut i = input(16 << 30, vec![device("studio", 30_000), device("box", 4_000)]);
        i.measured = vec![measured("studio", 50.0), measured("box", 100.0)];
        let plan = plan(&i);
        // The shares still follow the measurements; the rate would be a guess, so it is not given.
        assert_eq!(plan.shares.iter().map(|s| s.permille).collect::<Vec<_>>(), vec![806, 194]);
        assert_eq!(plan.predicted_tps, None);
    }

    #[test]
    fn an_unmeasured_device_plans_by_memory() {
        let mut i = input(16 << 30, vec![device("studio", 30_000), device("box", 4_000)]);
        i.measured = vec![measured("studio", 50.0)]; // the peer never calibrated
        let plan = plan(&i);
        assert_eq!(plan.predicted_tps, None);
        // 27000 : 3600 by memory.
        assert_eq!(plan.shares.iter().map(|s| s.permille).collect::<Vec<_>>(), vec![882, 118]);
    }
}
