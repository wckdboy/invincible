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
    /// Cloud backends, used only as the routing rules allow (spec/routing.md).
    #[serde(default)]
    pub cloud: Vec<CloudConfig>,
    /// The Autobot Agent on this machine, which `/v1/agent` passes through to (spec/agent.md).
    #[serde(default)]
    pub agent: AgentLink,
    /// Updates: none unless asked for (`invincible update`), or daily when `auto` is on.
    #[serde(default)]
    pub update: UpdateConfig,
    /// Text-to-speech backends: `POST /v1/audio/speech` ([crate::synth]).
    #[serde(default)]
    pub speech: Vec<MediaConfig>,
    /// Image generation backends: `POST /v1/images/generations` ([crate::synth]).
    #[serde(default)]
    pub images: Vec<MediaConfig>,
    /// This node as a shard for paired heads (spec/cluster.md).
    #[serde(default)]
    pub cluster: ClusterConfig,
}

/// ```toml
/// [cluster]
/// serve = true                        # run ggml-rpc-server on loopback for the heads below
/// heads = ["laptop"]                  # paired devices (by name) that may use this node as a shard
/// rpc_server = "ggml-rpc-server"      # default: next to llama_server, else on PATH
/// cache = true                        # keep weights a head sent (fast reloads), in $INVINCIBLE_HOME/cache/rpc
/// ```
#[derive(Clone, Debug, Default, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ClusterConfig {
    #[serde(default)]
    pub serve: bool,
    #[serde(default)]
    pub heads: Vec<String>,
    #[serde(default)]
    pub rpc_server: Option<PathBuf>,
    #[serde(default = "yes")]
    pub cache: bool,
}

fn yes() -> bool {
    true
}

/// ```toml
/// [[speech]]                                 # or [[images]]
/// id = "kokoro"                              # what requests name
/// base_url = "http://127.0.0.1:8880/v1"      # OpenAI-compatible; on loopback: the node's own
/// upstream_model = "kokoro"                  # what the server calls it (default: id)
/// voice = "af_heart"                         # speech: when a request names none
/// api_key_file = "keys/openai"               # or api_key_env; none for a local server
/// data_policy = "retention:30"               # off the machine: as for [[cloud]]
/// ```
#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct MediaConfig {
    pub id: String,
    pub base_url: String,
    #[serde(default)]
    pub upstream_model: Option<String>,
    #[serde(default)]
    pub voice: Option<String>,
    #[serde(default)]
    pub api_key_file: Option<PathBuf>,
    #[serde(default)]
    pub api_key_env: Option<String>,
    #[serde(default)]
    pub data_policy: Option<String>,
}

impl MediaConfig {
    /// The API key, as for [CloudConfig::key].
    pub fn key(&self, home: &Path) -> Result<Option<String>, String> {
        CloudConfig {
            id: self.id.clone(),
            upstream_model: None,
            base_url: self.base_url.clone(),
            api_key_file: self.api_key_file.clone(),
            api_key_env: self.api_key_env.clone(),
            context: None,
            data_policy: String::new(),
            vision: None,
        }
        .key(home)
    }
}

/// ```toml
/// [update]
/// auto = "off"   # off, stable, edge: a daily `invincible update` on that channel
/// ```
#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct UpdateConfig {
    #[serde(default = "auto_off")]
    pub auto: String,
}

fn auto_off() -> String {
    "off".to_owned()
}

impl Default for UpdateConfig {
    fn default() -> Self {
        Self { auto: auto_off() }
    }
}

impl UpdateConfig {
    /// The channel automatic updates follow, or `None` when they are off.
    pub fn channel(&self) -> Result<Option<crate::version::Channel>, String> {
        match self.auto.as_str() {
            "off" => Ok(None),
            other => crate::version::Channel::parse(other)
                .map(Some)
                .map_err(|_| format!("[update] auto = {other:?}: one of off, stable, edge")),
        }
    }
}

/// ```toml
/// [agent]
/// url = "http://127.0.0.1:7792"   # where `autobot serve` listens
/// ```
#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AgentLink {
    #[serde(default = "agent_url")]
    pub url: String,
}

fn agent_url() -> String {
    "http://127.0.0.1:7792".to_owned()
}

impl Default for AgentLink {
    fn default() -> Self {
        Self { url: agent_url() }
    }
}

/// ```toml
/// [[cloud]]
/// id = "claude"                              # what requests name
/// upstream_model = "claude-sonnet-5-5"       # what the provider calls it (default: id)
/// base_url = "https://api.anthropic.com/v1"  # an OpenAI-compatible endpoint
/// api_key_file = "keys/anthropic"            # relative to $INVINCIBLE_HOME; or api_key_env
/// context = 200000
/// data_policy = "retention:30"               # owned, no-retention, retention:<days>, trains, unknown
/// vision = true                              # takes images (default: known for common models)
/// ```
#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CloudConfig {
    pub id: String,
    #[serde(default)]
    pub upstream_model: Option<String>,
    pub base_url: String,
    #[serde(default)]
    pub api_key_file: Option<PathBuf>,
    #[serde(default)]
    pub api_key_env: Option<String>,
    #[serde(default)]
    pub context: Option<u64>,
    #[serde(default = "unknown_policy")]
    pub data_policy: String,
    /// Whether it takes images; unset: guessed from the model's name ([crate::cloud::guess_vision]).
    #[serde(default)]
    pub vision: Option<bool>,
}

fn unknown_policy() -> String {
    "unknown".to_owned()
}

impl CloudConfig {
    /// The API key, from the file (relative to [home]) or the environment variable.
    pub fn key(&self, home: &Path) -> Result<Option<String>, String> {
        if let Some(file) = &self.api_key_file {
            let path = if file.is_absolute() { file.clone() } else { home.join(file) };
            let key = std::fs::read_to_string(&path).map_err(|e| format!("{}: {e}", path.display()))?;
            return Ok(Some(key.trim().to_owned()).filter(|k| !k.is_empty()));
        }
        if let Some(var) = &self.api_key_env {
            return std::env::var(var).map(Some).map_err(|_| format!("{var} is not set"));
        }
        Ok(None)
    }
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
    /// The model's multimodal projector (an `mmproj` GGUF): with it, the model sees images.
    #[serde(default)]
    pub mmproj: Option<PathBuf>,
    /// Whether it takes images; unset: when it has an `mmproj`.
    #[serde(default)]
    pub vision: Option<bool>,
    /// Paired nodes (by name, as `invincible join` saved them) this model may be split across
    /// (spec/cluster.md). Empty: this machine only.
    #[serde(default)]
    pub cluster: Vec<String>,
    /// When to split: `auto` (only when it does not fit here) or `always`.
    #[serde(default = "auto_split")]
    pub split: invincible_policy::SplitMode,
}

fn auto_split() -> invincible_policy::SplitMode {
    invincible_policy::SplitMode::Auto
}

impl ModelConfig {
    /// Whether the model takes images: as set, else with a projector yes; else no, unless the
    /// engine's extra arguments may give it one (then unknown).
    pub fn vision(&self, engine: &EngineConfig) -> Option<bool> {
        if self.vision.is_some() {
            return self.vision;
        }
        if self.mmproj.is_some() {
            return Some(true);
        }
        if engine.extra_args.iter().any(|a| a.starts_with("--mmproj") || a == "-mm" || a == "-mmu") {
            return None;
        }
        Some(false)
    }
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
        for id in self.models.iter().map(|m| &m.id).chain(self.cloud.iter().map(|c| &c.id)) {
            if id.is_empty() || id == "auto" {
                return Err(format!("model id {id:?} is reserved"));
            }
            if !seen.insert(id) {
                return Err(format!("model id {id:?} appears twice"));
            }
        }
        self.update.channel()?;
        if self.cluster.serve && !self.remote.enabled() {
            return Err("[cluster] serve needs [remote] listen: heads reach this node over its paired link".to_owned());
        }
        if self.cluster.serve && self.cluster.heads.is_empty() {
            return Err("[cluster] serve: name the paired devices that may use this node in `heads`".to_owned());
        }
        for cloud in &self.cloud {
            crate::egress::check(&cloud.base_url).map_err(|e| format!("[[cloud]] {}: {e}", cloud.id))?;
            if cloud.api_key_file.is_some() && cloud.api_key_env.is_some() {
                return Err(format!("[[cloud]] {}: set api_key_file or api_key_env, not both", cloud.id));
            }
        }
        for (section, list) in [("speech", &self.speech), ("images", &self.images)] {
            let mut ids = std::collections::HashSet::new();
            for m in list {
                if m.id.is_empty() || m.id == "auto" {
                    return Err(format!("[[{section}]] id {:?} is reserved", m.id));
                }
                if !ids.insert(&m.id) {
                    return Err(format!("[[{section}]] id {:?} appears twice", m.id));
                }
                crate::egress::check(&m.base_url).map_err(|e| format!("[[{section}]] {}: {e}", m.id))?;
                if m.api_key_file.is_some() && m.api_key_env.is_some() {
                    return Err(format!("[[{section}]] {}: set api_key_file or api_key_env, not both", m.id));
                }
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
    fn cloud_entries_are_checked() {
        let ok = "[[cloud]]\nid = \"claude\"\nbase_url = \"https://api.anthropic.com/v1\"\napi_key_env = \"K\"\n";
        let config = Config::parse(ok).unwrap();
        assert_eq!(config.cloud[0].data_policy, "unknown");
        let http = "[[cloud]]\nid = \"c\"\nbase_url = \"http://api.example.org/v1\"\n";
        assert!(Config::parse(http).unwrap_err().contains("HTTPS"));
        let clash =
            "[[models]]\nid = \"c\"\npath = \"m.gguf\"\n[[cloud]]\nid = \"c\"\nbase_url = \"https://x.org/v1\"\n";
        assert!(Config::parse(clash).unwrap_err().contains("twice"));
        let both =
            "[[cloud]]\nid = \"c\"\nbase_url = \"https://x.org/v1\"\napi_key_env = \"K\"\napi_key_file = \"k\"\n";
        assert!(Config::parse(both).unwrap_err().contains("not both"));
    }

    #[test]
    fn vision_follows_the_projector_unless_set() {
        let config = Config::parse(
            "[[models]]\nid = \"a\"\npath = \"a.gguf\"\n[[models]]\nid = \"b\"\npath = \"b.gguf\"\nmmproj = \"b-mmproj.gguf\"\n[[models]]\nid = \"c\"\npath = \"c.gguf\"\nvision = true\n[[cloud]]\nid = \"d\"\nbase_url = \"https://x.org/v1\"\nvision = false\n",
        )
        .unwrap();
        let seen: Vec<Option<bool>> = config.models.iter().map(|m| m.vision(&config.engine)).collect();
        assert_eq!(seen, [Some(false), Some(true), Some(true)]);
        assert_eq!(config.cloud[0].vision, Some(false));
        let mut engine = config.engine.clone();
        engine.extra_args = vec!["--mmproj".into(), "p.gguf".into()];
        assert_eq!(config.models[0].vision(&engine), None, "the engine's own arguments may give it one");
    }

    #[test]
    fn speech_and_image_backends_are_checked() {
        let ok = Config::parse(
            "[[speech]]\nid = \"kokoro\"\nbase_url = \"http://127.0.0.1:8880/v1\"\nvoice = \"af\"\n[[images]]\nid = \"img\"\nbase_url = \"https://api.example.org/v1\"\napi_key_env = \"K\"\n",
        )
        .unwrap();
        assert_eq!(ok.speech[0].voice.as_deref(), Some("af"));
        assert_eq!(ok.images[0].id, "img");
        let http = "[[images]]\nid = \"i\"\nbase_url = \"http://images.example.org/v1\"\n";
        assert!(Config::parse(http).unwrap_err().contains("HTTPS"));
        let twice = "[[speech]]\nid = \"a\"\nbase_url = \"http://127.0.0.1:1\"\n[[speech]]\nid = \"a\"\nbase_url = \"http://127.0.0.1:2\"\n";
        assert!(Config::parse(twice).unwrap_err().contains("twice"));
        assert!(Config::parse("[[speech]]\nid = \"auto\"\nbase_url = \"http://127.0.0.1:1\"\n").is_err());
    }

    #[test]
    fn refuses_unknown_keys() {
        assert!(Config::parse("listen_on = \"127.0.0.1:1\"").is_err());
    }
}
