//! The node's configuration: `$INVINCIBLE_HOME/config.toml` (default `~/.invincible`).

use std::net::SocketAddr;
use std::path::{Path, PathBuf};

use invincible_policy::{Egress, NetworkMode, NodeSettings};
use serde::Deserialize;

/// ```toml
/// listen = "127.0.0.1:7777"
///
/// [node]
/// network = "offline"   # offline, direct, tor:<host>:<port>, socks5:<host>:<port>
/// egress = "never"      # never, ask, auto
///
/// [engine]
/// llama_server = "llama-server"
///
/// [[models]]
/// id = "qwen3-4b"
/// path = "/models/Qwen3-4B-Q4_K_M.gguf"
/// context = 8192
/// ```
#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Config {
    #[serde(default = "default_listen")]
    pub listen: SocketAddr,
    #[serde(default)]
    pub node: NodeConfig,
    #[serde(default)]
    pub engine: EngineConfig,
    /// In order of preference: routing takes the first that fits.
    #[serde(default)]
    pub models: Vec<ModelConfig>,
    /// Remote access for paired devices, over Noise (spec/pairing.md). Off unless `listen` is set.
    #[serde(default)]
    pub remote: RemoteConfig,
}

/// ```toml
/// [remote]
/// name = "studio"
/// listen = ["0.0.0.0:7778"]
/// advertise = ["192.168.1.20:7778", "100.101.102.103:7778"]   # LAN, Tailscale, …
/// ```
#[derive(Clone, Debug, Default, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RemoteConfig {
    /// The name devices see. Default `invincible`.
    #[serde(default)]
    pub name: Option<String>,
    /// Where to accept paired devices. Empty: remote access is off.
    #[serde(default)]
    pub listen: Vec<SocketAddr>,
    /// The addresses put in pairing codes. Default: the `listen` addresses that name one interface.
    #[serde(default)]
    pub advertise: Vec<String>,
}

impl RemoteConfig {
    pub fn enabled(&self) -> bool {
        !self.listen.is_empty()
    }

    pub fn name(&self) -> String {
        self.name.clone().unwrap_or_else(|| "invincible".to_owned())
    }

    pub fn advertised(&self) -> Vec<String> {
        if !self.advertise.is_empty() {
            return self.advertise.clone();
        }
        self.listen.iter().filter(|a| !a.ip().is_unspecified()).map(ToString::to_string).collect()
    }
}

fn default_listen() -> SocketAddr {
    SocketAddr::from(([127, 0, 0, 1], 7777))
}

/// Egress settings, in the encodings of spec/routing.md. Both start fully closed.
#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct NodeConfig {
    #[serde(default = "offline")]
    pub network: String,
    #[serde(default = "never")]
    pub egress: String,
}

fn offline() -> String {
    "offline".to_owned()
}

fn never() -> String {
    "never".to_owned()
}

impl Default for NodeConfig {
    fn default() -> Self {
        Self { network: offline(), egress: never() }
    }
}

impl NodeConfig {
    pub fn settings(&self) -> NodeSettings {
        NodeSettings { network: NetworkMode::decode(&self.network), egress: Egress::parse(&self.egress) }
    }
}

#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct EngineConfig {
    /// The llama.cpp server binary (Metal on Apple silicon, CUDA on NVIDIA).
    #[serde(default = "llama_server")]
    pub llama_server: PathBuf,
    /// Extra arguments for every llama.cpp server.
    #[serde(default)]
    pub extra_args: Vec<String>,
}

fn llama_server() -> PathBuf {
    PathBuf::from("llama-server")
}

impl Default for EngineConfig {
    fn default() -> Self {
        Self { llama_server: llama_server(), extra_args: Vec::new() }
    }
}

#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ModelConfig {
    pub id: String,
    /// A GGUF file.
    pub path: PathBuf,
    /// Context window in tokens; also passed to the engine.
    #[serde(default)]
    pub context: Option<u64>,
    /// Layers to offload to the GPU (`999`: all).
    #[serde(default = "all_layers")]
    pub gpu_layers: u32,
}

fn all_layers() -> u32 {
    999
}

impl Config {
    pub fn load(path: &Path) -> Result<Self, String> {
        let text = std::fs::read_to_string(path).map_err(|e| format!("{}: {e}", path.display()))?;
        Self::parse(&text).map_err(|e| format!("{}: {e}", path.display()))
    }

    pub fn parse(text: &str) -> Result<Self, String> {
        let config: Self = toml::from_str(text).map_err(|e| e.to_string())?;
        config.validate()?;
        Ok(config)
    }

    fn validate(&self) -> Result<(), String> {
        // Until pairing exists (INV-13) the node is reachable from this machine only.
        if !self.listen.ip().is_loopback() {
            return Err(format!(
                "listen = \"{}\": only loopback addresses are allowed until device pairing exists",
                self.listen
            ));
        }
        if self.remote.enabled() && self.remote.advertised().is_empty() {
            return Err(
                "[remote] listens on every interface: set `advertise` to the addresses devices should use".to_owned()
            );
        }
        let mut seen = std::collections::HashSet::new();
        for model in &self.models {
            if model.id.is_empty() || model.id == "auto" {
                return Err(format!("model id {:?} is reserved", model.id));
            }
            if !seen.insert(&model.id) {
                return Err(format!("model id {:?} appears twice", model.id));
            }
        }
        Ok(())
    }
}

/// `$INVINCIBLE_HOME`, else `~/.invincible`.
pub fn home() -> Result<PathBuf, String> {
    if let Some(home) = std::env::var_os("INVINCIBLE_HOME") {
        return Ok(PathBuf::from(home));
    }
    std::env::var_os("HOME")
        .map(|h| PathBuf::from(h).join(".invincible"))
        .ok_or_else(|| "neither INVINCIBLE_HOME nor HOME is set".to_owned())
}

#[cfg(test)]
mod tests {
    use super::Config;

    #[test]
    fn empty_config_is_closed() {
        let config = Config::parse("").unwrap();
        assert_eq!(config.listen.to_string(), "127.0.0.1:7777");
        let settings = config.node.settings();
        assert!(settings.network.is_offline());
        assert_eq!(settings.egress, invincible_policy::Egress::Never);
    }

    #[test]
    fn refuses_non_loopback_listen() {
        assert!(Config::parse("listen = \"0.0.0.0:7777\"").unwrap_err().contains("loopback"));
    }

    #[test]
    fn refuses_duplicate_and_reserved_ids() {
        let twice = "[[models]]\nid = \"a\"\npath = \"a.gguf\"\n[[models]]\nid = \"a\"\npath = \"b.gguf\"\n";
        assert!(Config::parse(twice).unwrap_err().contains("twice"));
        assert!(Config::parse("[[models]]\nid = \"auto\"\npath = \"a.gguf\"\n").unwrap_err().contains("reserved"));
    }

    #[test]
    fn remote_is_off_by_default_and_needs_an_address_to_advertise() {
        assert!(!Config::parse("").unwrap().remote.enabled());
        let any = "[remote]\nlisten = [\"0.0.0.0:7778\"]\n";
        assert!(Config::parse(any).unwrap_err().contains("advertise"));
        let lan = Config::parse("[remote]\nlisten = [\"192.168.1.20:7778\"]\n").unwrap();
        assert_eq!(lan.remote.advertised(), vec!["192.168.1.20:7778"]);
        let both = format!("{any}advertise = [\"10.0.0.2:7778\"]\n");
        assert_eq!(Config::parse(&both).unwrap().remote.advertised(), vec!["10.0.0.2:7778"]);
    }

    #[test]
    fn refuses_unknown_keys() {
        assert!(Config::parse("listen_on = \"127.0.0.1:1\"").is_err());
    }
}
