//! The Autobot Agent: Autobot's agent on a VPS or a desktop, with Invincible Gateway on the same
//! machine as its model provider. Installed, configured and run together with the gateway.

pub mod actions;
pub mod agent;
pub mod api;
pub mod approval;
pub mod board;
pub mod commands;
pub mod config;
pub mod cron;
pub mod diff;
pub mod discord;
pub mod docker;
pub mod doctor;
pub mod eval;
pub mod gateway;
pub mod heartbeat;
pub mod hooks;
pub mod mcp;
pub mod memory;
pub mod procs;
pub mod sandbox;
pub mod search;
pub mod service;
pub mod session;
pub mod setup;
pub mod skills;
pub mod team;
pub mod telegram;
pub mod tools;
pub mod trajectory;
pub mod tui;

use std::path::{Path, PathBuf};
use std::time::Duration;

use config::Config;

/// The agent [config] describes.
pub fn agent(config: &Config, home: &Path) -> Result<agent::Agent, String> {
    agent_in(config, home, None)
}

/// The agent [config] describes, working in [workdir] instead of the configured one (`autobot
/// code` in a project).
pub fn agent_in(config: &Config, home: &Path, workdir: Option<PathBuf>) -> Result<agent::Agent, String> {
    let token = config.gateway.token()?;
    let gateway = gateway::Gateway::new(&config.gateway.url, &token, &config.gateway.model, config.gateway.private)?
        .with_stream(config.agent.stream);
    let workdir = workdir.unwrap_or_else(|| config.agent.workdir(home));
    std::fs::create_dir_all(&workdir).map_err(|e| format!("{}: {e}", workdir.display()))?;
    let mut tools = tools::Tools::new(workdir, Duration::from_secs(config.agent.command_timeout))
        .with_home(home.to_owned())
        .with_sandbox(config.agent.sandbox);
    if let Some(kib) = config.agent.context_kib {
        tools = tools.with_context(kib);
    }
    if let Some(docker) = &config.agent.docker {
        tools = tools.with_docker(docker.clone());
    }
    if let Some(groups) = &config.agent.tools {
        if let Some(unknown) = groups.iter().find(|g| !tools::GROUPS.iter().any(|(n, _)| n == g)) {
            return Err(format!("[agent] tools: unknown group {unknown:?}"));
        }
        tools = tools.only(tools::tools_for(groups));
    }
    Ok(agent::Agent {
        gateway,
        tools,
        approvals: config.approvals.clone(),
        max_steps: config.agent.max_steps,
        team: std::sync::Arc::new(team::Team::from_config(&config.agents, &config.team)?),
        mcp: std::sync::Arc::new(mcp::Hub::new(config.mcp.clone())?),
        trajectories: config.agent.trajectories.then(|| std::sync::Arc::new(trajectory::Recorder::dir(home))),
        options: agent::Options { context_kib: config.agent.context_kib },
    })
}

/// Coding in a project (`autobot code`, `autobot run -C`): room for long tasks (at least 100
/// steps), and an `explorer` to hand read-only research to, so the main conversation keeps
/// only what it found.
pub fn for_coding(agent: &mut agent::Agent) {
    agent.max_steps = agent.max_steps.max(100);
    agent.team = std::sync::Arc::new((*agent.team).clone().with_explorer());
}

/// Switches [agent] to the model [id] of [models] (what the gateway serves): a cloud model lets
/// turns leave the machine (they are private otherwise, as configured), and the conversation
/// sent per call and the tool results grow with the model's context, unless the config sets it.
pub fn use_model(
    agent: &mut agent::Agent,
    config: &Config,
    models: &[gateway::ModelInfo],
    id: &str,
) -> Result<(), String> {
    let info = models.iter().find(|m| m.id == id);
    if info.is_none() && id != "auto" && !models.is_empty() {
        let ids: Vec<&str> = models.iter().map(|m| m.id.as_str()).collect();
        return Err(format!("no model {id:?} (the gateway serves: {}, and auto)", ids.join(", ")));
    }
    agent.gateway = agent.gateway.with_model(id).with_private(match info {
        Some(m) if m.is_cloud() => false,
        _ => config.gateway.private,
    });
    if config.agent.context_kib.is_none() {
        let kib = info.map_or(session::CHAR_BUDGET / 1024, gateway::ModelInfo::context_kib);
        agent.options.context_kib = Some(kib);
        agent.tools = agent.tools.clone().with_context(kib);
    }
    Ok(())
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
