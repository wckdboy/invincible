use serde::{Deserialize, Deserializer};

/// The node's egress mode, encoded as Autobot's `NetworkMode.encode`
/// (`offline`, `direct`, `tor:<host>:<port>`, `socks5:<host>:<port>`).
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub enum NetworkMode {
    /// Nothing leaves the node. The default, and the reading of anything unknown.
    #[default]
    Offline,
    Direct,
    Tor {
        host: String,
        port: u16,
    },
    Socks5 {
        host: String,
        port: u16,
    },
}

impl NetworkMode {
    /// Parses an encoded mode. Unknown or malformed values are [NetworkMode::Offline] (fail closed),
    /// as in Autobot's `NetworkMode.decode`.
    pub fn decode(value: &str) -> Self {
        let (kind, rest) = value.split_once(':').unwrap_or((value, ""));
        let endpoint = || {
            let (host, port) = rest.rsplit_once(':')?;
            let port = port.parse::<u16>().ok().filter(|p| *p != 0)?;
            (!host.trim().is_empty()).then(|| (host.to_owned(), port))
        };
        match kind {
            "direct" => Self::Direct,
            "tor" => endpoint().map_or(Self::Offline, |(host, port)| Self::Tor { host, port }),
            "socks5" => endpoint().map_or(Self::Offline, |(host, port)| Self::Socks5 { host, port }),
            _ => Self::Offline,
        }
    }

    pub fn is_offline(&self) -> bool {
        matches!(self, Self::Offline)
    }
}

impl<'de> Deserialize<'de> for NetworkMode {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        Ok(Self::decode(&String::deserialize(deserializer)?))
    }
}

#[cfg(test)]
mod tests {
    use super::NetworkMode;

    #[test]
    fn decodes_autobot_encodings() {
        assert_eq!(NetworkMode::decode("offline"), NetworkMode::Offline);
        assert_eq!(NetworkMode::decode("direct"), NetworkMode::Direct);
        assert_eq!(
            NetworkMode::decode("tor:127.0.0.1:9050"),
            NetworkMode::Tor { host: "127.0.0.1".into(), port: 9050 }
        );
        assert_eq!(NetworkMode::decode("socks5:::1:1080"), NetworkMode::Socks5 { host: "::1".into(), port: 1080 });
    }

    #[test]
    fn anything_malformed_is_offline() {
        for value in
            ["", "tor", "tor:", "tor:9050", "tor::9050", "tor:host:0", "socks5:host:65536", "socks5:host:x", "Direct"]
        {
            assert_eq!(NetworkMode::decode(value), NetworkMode::Offline, "{value:?}");
        }
    }
}
