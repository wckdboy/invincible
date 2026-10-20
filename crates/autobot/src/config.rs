//! The agent's configuration: `$AUTOBOT_HOME/config.toml` (default `~/.autobot`).

use std::path::{Path, PathBuf};

use serde::Deserialize;

/// ```toml
/// [gateway]
/// url = "http://127.0.0.1:7777/v1"   # Invincible Gateway on this machine
/// model = "auto"                     # what the gateway's router picks, or a model id
/// private = true                     # agent turns stay on your hardware (no cloud models)
///
/// [agent]
/// workdir = "~/work"                 # where tools run; relative paths resolve here
/// max_steps = 24                     # model calls per turn, tool rounds included
///
/// [approvals]
/// mode = "ask"                       # ask, edits, allowlist, trust
/// allow = ["git status", "ls"]       # commands that run without asking (exact or prefix + space)
///
/// [telegram]
/// enabled = true                     # token in $AUTOBOT_HOME/telegram.token
///
/// [serve]
/// listen = "127.0.0.1:7792"          # the agent API (spec/agent.md); loopback only
///
/// [terminal]
/// notify = "auto"                    # a long turn ended, a question waits: auto, bell, off
/// ```
#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Config {
    #[serde(default)]
    pub gateway: GatewayConfig,
    #[serde(default)]
    pub agent: AgentConfig,
    #[serde(default)]
    pub approvals: ApprovalConfig,
    #[serde(default)]
    pub telegram: TelegramConfig,
    #[serde(default)]
    pub serve: ServeConfig,
    /// Team members the main agent can hand work to ([crate::team]).
    #[serde(default)]
    pub agents: std::collections::BTreeMap<String, crate::team::RoleConfig>,
    #[serde(default)]
    pub team: crate::team::TeamConfig,
    /// MCP servers whose tools the agent can use ([crate::mcp]).
    #[serde(default)]
    pub mcp: std::collections::BTreeMap<String, crate::mcp::ServerConfig>,
    #[serde(default)]
    pub discord: crate::discord::DiscordConfig,
    /// Webhooks that start tasks ([crate::hooks]).
    #[serde(default)]
    pub hooks: crate::hooks::HooksConfig,
    /// The terminal chat (`autobot chat`, `autobot code`).
    #[serde(default)]
    pub terminal: TerminalConfig,
    /// Dollars per million tokens, by model id, for `/usage` ([crate::insights::Price]).
    #[serde(default)]
    pub prices: crate::insights::Prices,
}

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct TerminalConfig {
    /// How the terminal tells you a turn longer than 10 seconds ended or a question waits, while
    /// its window is not in front.
    #[serde(default)]
    pub notify: NotifyMode,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum NotifyMode {
    /// A desktop notification where the terminal shows them (iTerm2, Ghostty, WezTerm, kitty),
    /// the bell elsewhere.
    #[default]
    Auto,
    Bell,
    Off,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ServeConfig {
    /// Where the agent API listens; the gateway passes `/v1/agent` through to it.
    #[serde(default = "agent_listen")]
    pub listen: std::net::SocketAddr,
}

fn agent_listen() -> std::net::SocketAddr {
    std::net::SocketAddr::from(([127, 0, 0, 1], 7792))
}

impl Default for ServeConfig {
    fn default() -> Self {
        Self { listen: agent_listen() }
    }
}

#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct GatewayConfig {
    #[serde(default = "gateway_url")]
    pub url: String,
    #[serde(default = "auto")]
    pub model: String,
    /// Marks every turn private, so the router keeps it on local models: tool results carry
    /// files and command output. `false` lets the router use cloud models (redacted, receipted,
    /// and confirmed by the owner when the rules say so).
    #[serde(default = "yes")]
    pub private: bool,
    /// The gateway's API token [default: `$INVINCIBLE_HOME/token`].
    #[serde(default)]
    pub token_file: Option<PathBuf>,
}

fn yes() -> bool {
    true
}

fn gateway_url() -> String {
    "http://127.0.0.1:7777/v1".to_owned()
}

fn auto() -> String {
    "auto".to_owned()
}

impl Default for GatewayConfig {
    fn default() -> Self {
        Self { url: gateway_url(), model: auto(), private: true, token_file: None }
    }
}

impl GatewayConfig {
    pub fn token(&self) -> Result<String, String> {
        let path = match &self.token_file {
            Some(path) => expand(path),
            None => invincible::config::home()?.join("token"),
        };
        let token = std::fs::read_to_string(&path)
            .map_err(|e| format!("the gateway token {}: {e} (run `invincible token` once)", path.display()))?;
        Ok(token.trim().to_owned())
    }
}

#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AgentConfig {
    #[serde(default)]
    pub workdir: Option<PathBuf>,
    #[serde(default = "max_steps")]
    pub max_steps: usize,
    /// Seconds a command may run before it is stopped.
    #[serde(default = "command_timeout")]
    pub command_timeout: u64,
    /// Which commands run sandboxed (writes only in the working directory): unattended (default),
    /// always, off ([crate::sandbox]).
    #[serde(default)]
    pub sandbox: crate::sandbox::Mode,
    /// Only these tool groups for the main agent ([crate::tools::GROUPS]; default: all). A
    /// shorter tool list makes a small local model's calls faster.
    #[serde(default)]
    pub tools: Option<Vec<String>>,
    /// KiB of recent conversation sent per model call (default 48: small local models have small
    /// contexts). Frontier models take far more: `context_kib = 400`.
    #[serde(default)]
    pub context_kib: Option<usize>,
    /// Stream answers as they are written (the terminal shows them live).
    #[serde(default = "yes")]
    pub stream: bool,
    /// How often the heartbeat works through `HEARTBEAT.md` (`30m`, `2h`; `off`).
    #[serde(default = "heartbeat")]
    pub heartbeat: String,
    /// Keep every finished turn in `$AUTOBOT_HOME/trajectories`, for fine-tuning a local model
    /// on the agent's own work ([crate::trajectory]).
    #[serde(default)]
    pub trajectories: bool,
    /// Commands run in a container ([crate::docker]): `[agent.docker] image = "…"`.
    #[serde(default)]
    pub docker: Option<crate::docker::Docker>,
    /// Every this many turns of a conversation in the terminal, a short extra call looks back
    /// over it for what is worth keeping in memory or the owner's profile (0: never).
    #[serde(default = "nudge_every")]
    pub nudge_every: usize,
    /// Commands and files on another machine ([crate::ssh]): `[agent.ssh] host = "me@box"`.
    #[serde(default)]
    pub ssh: Option<crate::ssh::Ssh>,
    /// The `browser` tool, when a Chrome, Chromium, Edge or Brave is installed ([crate::browser]).
    #[serde(default = "yes")]
    pub browser: bool,
}

fn nudge_every() -> usize {
    8
}

fn heartbeat() -> String {
    "30m".to_owned()
}

impl AgentConfig {
    /// The heartbeat's interval; None when it is off.
    pub fn heartbeat_every(&self) -> Result<Option<std::time::Duration>, String> {
        let text = self.heartbeat.trim();
        if text == "off" {
            return Ok(None);
        }
        match crate::cron::When::parse(&format!("every {text}"))? {
            crate::cron::When::Every(every) => Ok(Some(every.max(std::time::Duration::from_secs(300)))),
            _ => Err(format!("[agent] heartbeat = {text:?}: an interval like 30m, or off")),
        }
    }
}

fn max_steps() -> usize {
    24
}

fn command_timeout() -> u64 {
    120
}

impl Default for AgentConfig {
    fn default() -> Self {
        Self {
            workdir: None,
            max_steps: max_steps(),
            command_timeout: command_timeout(),
            sandbox: Default::default(),
            tools: None,
            heartbeat: heartbeat(),
            trajectories: false,
            context_kib: None,
            stream: true,
            docker: None,
            nudge_every: nudge_every(),
            ssh: None,
            browser: true,
        }
    }
}

impl AgentConfig {
    /// The working directory [default: `$AUTOBOT_HOME/work`].
    pub fn workdir(&self, home: &Path) -> PathBuf {
        self.workdir.as_deref().map(expand).unwrap_or_else(|| home.join("work"))
    }
}

/// How tool calls that change things (commands, file writes) are approved.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ApprovalMode {
    /// Ask, unless allowlisted. The default.
    Ask,
    /// Like ask, but writes and edits in the working directory (not under dot names) run
    /// without asking: for coding, where every change is shown as a diff and `/undo` puts it
    /// back.
    Edits,
    /// Run allowlisted commands and writes in the working directory; refuse everything else
    /// without asking (unattended use).
    Allowlist,
    /// Run everything. Only for a sandboxed machine you can throw away.
    Trust,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ApprovalConfig {
    #[serde(default = "ask")]
    pub mode: ApprovalMode,
    #[serde(default)]
    pub allow: Vec<String>,
}

fn ask() -> ApprovalMode {
    ApprovalMode::Ask
}

impl Default for ApprovalConfig {
    fn default() -> Self {
        Self { mode: ask(), allow: Vec::new() }
    }
}

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct TelegramConfig {
    #[serde(default)]
    pub enabled: bool,
    /// The bot token [default: `$AUTOBOT_HOME/telegram.token`].
    #[serde(default)]
    pub token_file: Option<PathBuf>,
    /// The Bot API [default: `https://api.telegram.org`]; tests point it at a stand-in.
    #[serde(default)]
    pub api: Option<String>,
}

impl TelegramConfig {
    pub fn token(&self, home: &Path) -> Result<String, String> {
        let path = self.token_file.as_deref().map(expand).unwrap_or_else(|| home.join("telegram.token"));
        let token =
            std::fs::read_to_string(&path).map_err(|e| format!("the Telegram bot token {}: {e}", path.display()))?;
        let token = token.trim();
        if token.is_empty() {
            return Err(format!("{} is empty", path.display()));
        }
        Ok(token.to_owned())
    }

    pub fn api(&self) -> String {
        self.api.clone().unwrap_or_else(|| "https://api.telegram.org".to_owned())
    }
}

impl Config {
    pub fn parse(text: &str) -> Result<Self, String> {
        toml::from_str(text).map_err(|e| e.to_string())
    }

    /// The config at [path]; the defaults when there is none.
    pub fn load(path: &Path) -> Result<Self, String> {
        match invincible::fsutil::read_optional(path)? {
            Some(text) => Self::parse(&text).map_err(|e| format!("{}: {e}", path.display())),
            None => Self::parse(""),
        }
    }
}

/// `$AUTOBOT_HOME`, else `~/.autobot`.
pub fn home() -> Result<PathBuf, String> {
    if let Some(home) = std::env::var_os("AUTOBOT_HOME") {
        return Ok(PathBuf::from(home));
    }
    std::env::var_os("HOME")
        .map(|h| PathBuf::from(h).join(".autobot"))
        .ok_or_else(|| "neither AUTOBOT_HOME nor HOME is set".to_owned())
}

/// `~/x` → `$HOME/x`.
pub fn expand(path: &Path) -> PathBuf {
    match (path.strip_prefix("~"), std::env::var_os("HOME")) {
        (Ok(rest), Some(home)) => PathBuf::from(home).join(rest),
        _ => path.to_owned(),
    }
}

#[cfg(test)]
mod tests {
    use super::{ApprovalMode, Config};

    #[test]
    fn defaults_are_closed() {
        let config = Config::parse("").unwrap();
        assert_eq!(config.gateway.url, "http://127.0.0.1:7777/v1");
        assert_eq!(config.gateway.model, "auto");
        assert!(config.gateway.private);
        assert_eq!(config.approvals.mode, ApprovalMode::Ask);
        assert!(config.approvals.allow.is_empty());
        assert!(!config.telegram.enabled);
        assert_eq!(config.terminal.notify, super::NotifyMode::Auto);
        let quiet = Config::parse("[terminal]\nnotify = \"off\"").unwrap();
        assert_eq!(quiet.terminal.notify, super::NotifyMode::Off);
        assert!(Config::parse("[terminal]\nnotify = \"loud\"").is_err());
    }

    #[test]
    fn unknown_keys_and_modes_are_refused() {
        assert!(Config::parse("[approvals]\nmode = \"yolo\"").is_err());
        assert!(Config::parse("[agent]\nshell = \"bash\"").is_err());
        let config = Config::parse("[approvals]\nmode = \"allowlist\"\nallow = [\"ls\"]").unwrap();
        assert_eq!(config.approvals.mode, ApprovalMode::Allowlist);
    }
}
