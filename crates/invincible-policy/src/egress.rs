//! Where one outbound request may go (spec/egress.md): refused before any lookup or socket, sent
//! directly, or through a SOCKS proxy. Autobot's kill switch makes the same decision.

use serde::{Deserialize, Serialize};

use crate::NetworkMode;

/// One request, as spec/egress.md takes it.
#[derive(Clone, Debug, Deserialize)]
pub struct EgressInput {
    /// The encoded network mode ([NetworkMode::decode]).
    pub network: String,
    /// `http` or `https`.
    pub scheme: String,
    pub host: String,
    /// Whether loopback is allowed while offline (the node: never; its own services are reached
    /// without this check).
    pub loopback_when_offline: bool,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum EgressAction {
    Block,
    Direct,
    Socks,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum EgressReason {
    Offline,
    Cleartext,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct EgressDecision {
    /// The mode decoded, encoded again.
    pub mode: String,
    pub action: EgressAction,
    /// `host:port` of the proxy, for [EgressAction::Socks].
    #[serde(skip_serializing_if = "Option::is_none")]
    pub proxy: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<EgressReason>,
}

/// Whether [host] is this machine's loopback, without any lookup: `localhost`, `*.localhost`,
/// `127.0.0.0/8` (four decimal numbers, no leading zeros), `::1` in any spelling.
pub fn is_loopback(host: &str) -> bool {
    let host = host.trim().to_ascii_lowercase();
    let host = host.strip_prefix('[').and_then(|h| h.strip_suffix(']')).unwrap_or(&host);
    if host == "localhost" || host.ends_with(".localhost") {
        return true;
    }
    // Rust's parsers take neither leading zeros in IPv4 nor anything but plain decimal.
    match host.parse::<std::net::IpAddr>() {
        Ok(std::net::IpAddr::V4(ip)) => ip.is_loopback(),
        Ok(std::net::IpAddr::V6(ip)) => ip.is_loopback(),
        Err(_) => false,
    }
}

/// The decision for one request (spec/egress.md, Decision).
pub fn decide_egress(input: &EgressInput) -> EgressDecision {
    let mode = NetworkMode::decode(&input.network);
    let loopback = is_loopback(&input.host);
    let decision = |action, proxy, reason| EgressDecision { mode: mode.encode(), action, proxy, reason };
    if mode.is_offline() && !(loopback && input.loopback_when_offline) {
        return decision(EgressAction::Block, None, Some(EgressReason::Offline));
    }
    if input.scheme != "https" && !loopback {
        return decision(EgressAction::Block, None, Some(EgressReason::Cleartext));
    }
    match &mode {
        _ if loopback => decision(EgressAction::Direct, None, None),
        NetworkMode::Tor { host, port } | NetworkMode::Socks5 { host, port } => {
            decision(EgressAction::Socks, Some(format!("{host}:{port}")), None)
        }
        NetworkMode::Offline | NetworkMode::Direct => decision(EgressAction::Direct, None, None),
    }
}
