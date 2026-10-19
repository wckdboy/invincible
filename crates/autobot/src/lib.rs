//! The Autobot Agent: Autobot's agent on a VPS or a desktop, with Invincible Gateway on the same
//! machine as its model provider. Installed, configured and run together with the gateway.

pub mod actions;
pub mod agent;
pub mod api;
pub mod approval;
pub mod config;
pub mod cron;
pub mod doctor;
pub mod gateway;
pub mod mcp;
pub mod memory;
pub mod service;
pub mod session;
pub mod setup;
pub mod skills;
pub mod team;
pub mod telegram;
pub mod tools;

use std::path::{Path, PathBuf};
use std::time::Duration;

use config::Config;

/// The agent [config] describes.
pub fn agent(config: &Config, home: &Path) -> Result<agent::Agent, String> {
    let token = config.gateway.token()?;
    let gateway = gateway::Gateway::new(&config.gateway.url, &token, &config.gateway.model, config.gateway.private)?;
    let workdir = config.agent.workdir(home);
    std::fs::create_dir_all(&workdir).map_err(|e| format!("{}: {e}", workdir.display()))?;
    Ok(agent::Agent {
        gateway,
        tools: tools::Tools::new(workdir, Duration::from_secs(config.agent.command_timeout)).with_home(home.to_owned()),
        approvals: config.approvals.clone(),
        max_steps: config.agent.max_steps,
        team: std::sync::Arc::new(team::Team::from_config(&config.agents, &config.team)?),
        mcp: std::sync::Arc::new(mcp::Hub::new(config.mcp.clone())?),
    })
}

/// The gateway's configuration file.
pub fn gateway_config_path() -> Result<PathBuf, String> {
    Ok(invincible::config::home()?.join("config.toml"))
}

/// The gateway's network mode: the agent's own traffic (Telegram) follows it too.
pub fn network() -> Result<invincible_policy::NetworkMode, String> {
    let path = gateway_config_path()?;
    let text = invincible::fsutil::read_optional(&path)?.unwrap_or_default();
    let config = invincible::config::Config::parse(&text).map_err(|e| format!("{}: {e}", path.display()))?;
    Ok(config.node.settings().network)
}

/// A program next to this one, else on the PATH.
pub fn find_program(name: &str) -> Option<PathBuf> {
    if let Some(sibling) = std::env::current_exe().ok().and_then(|e| e.parent().map(|d| d.join(name)))
        && sibling.is_file()
    {
        return Some(sibling);
    }
    find_on_path(name)
}

pub fn find_on_path(name: &str) -> Option<PathBuf> {
    let path = Path::new(name);
    if path.components().count() > 1 {
        return path.is_file().then(|| path.to_owned());
    }
    std::env::split_paths(&std::env::var_os("PATH")?).map(|dir| dir.join(name)).find(|p| p.is_file())
}
