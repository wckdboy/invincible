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

#[derive(Clone, Debug, Deserialize)]
pub struct PlanInput {
    /// The model's file size.
    pub model_bytes: u64,
    pub split: SplitMode,
    /// In order: the head's devices first, then each peer's.
    pub devices: Vec<PlanDevice>,
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
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct Share {
    pub node: String,
    pub device: String,
    pub permille: u64,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct Plan {
    pub action: PlanAction,
    /// MiB the model needs (weights, 10% on top, 512 MiB of buffers and cache).
    pub need_mib: u64,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub shares: Vec<Share>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<PlanReason>,
}

const MIB: u64 = 1 << 20;

/// What one device can hold: 90% of what it reports free.
fn usable(device: &PlanDevice) -> u64 {
    device.free_mib / 10 * 9 + device.free_mib % 10 * 9 / 10
}

/// Shares a model's layers out over devices in proportion to the memory each can give (spec/cluster.md,
/// Partitioning), as exo does: pipeline (layer) parallel, memory-weighted.
pub fn plan(input: &PlanInput) -> Plan {
    let need_mib = input.model_bytes.saturating_add(input.model_bytes / 10).div_ceil(MIB).saturating_add(512);
    let head = input.devices.first().map(|d| d.node.clone()).unwrap_or_default();
    let head_usable: u64 = input.devices.iter().filter(|d| d.node == head).map(usable).sum();
    let peers = input.devices.iter().any(|d| d.node != head);
    let local = Plan { action: PlanAction::Local, need_mib, shares: Vec::new(), reason: None };
    let fits_alone = need_mib <= head_usable;
    if !peers && fits_alone {
        return local;
    }
    if fits_alone && input.split == SplitMode::Auto {
        return local;
    }
    let total: u64 = input.devices.iter().map(usable).sum();
    if need_mib > total || total == 0 {
        return Plan { action: PlanAction::Block, need_mib, shares: Vec::new(), reason: Some(PlanReason::DoesNotFit) };
    }
    // Largest remainder: floors first, then the leftover thousandths to the largest remainders
    // (earlier devices first on a tie), so the shares always add up to 1000.
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
    let shares: Vec<Share> = input
        .devices
        .iter()
        .zip(permille)
        .filter(|(_, p)| *p > 0)
        .map(|(d, permille)| Share { node: d.node.clone(), device: d.device.clone(), permille })
        .collect();
    if shares.iter().all(|s| s.node == head) {
        return local;
    }
    Plan { action: PlanAction::Split, need_mib, shares, reason: None }
}

#[cfg(test)]
mod tests {
    use super::*;

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
        let plan = plan(&PlanInput { model_bytes: 1 << 30, split: SplitMode::Always, devices });
        assert_eq!(plan.shares.iter().map(|s| s.permille).sum::<u64>(), 1000);
    }
}
