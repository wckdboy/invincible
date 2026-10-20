//! The Autobot Agent: Autobot's agent on a VPS or a desktop, with Invincible Gateway on the same
//! machine as its model provider. Installed, configured and run together with the gateway.

pub mod acp;
pub mod actions;
pub mod agent;
pub mod alerts;
pub mod api;
pub mod approval;
pub mod backup;
pub mod board;
pub mod bots;
pub mod browser;
pub mod channel;
pub mod commands;
pub mod config;
pub mod context;
pub mod cron;
pub mod diff;
pub mod discord;
pub mod docker;
pub mod doctor;
pub mod email;
pub mod eval;
pub mod gateway;
pub mod guard;
pub mod heartbeat;
pub mod homeassistant;
pub mod hooks;
pub mod hub;
pub mod identity;
pub mod images;
pub mod insights;
pub mod logs;
pub mod mail;
pub mod manage;
pub mod markdown;
pub mod matrix;
pub mod mcp;
pub mod media;
pub mod memory;
pub mod migrate;
pub mod net;
pub mod pairing;
pub mod personality;
pub mod procs;
pub mod profile;
pub mod recall;
pub mod sandbox;
pub mod script;
pub mod search;
pub mod service;
pub mod session;
pub mod settings;
pub mod setup;
pub mod signal;
pub mod skills;
pub mod slack;
pub mod ssh;
pub mod team;
pub mod telegram;
pub mod tools;
pub mod trajectory;
pub mod tui;
pub mod voice;
pub mod whatsapp;

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
    // On another machine: its working directory is there (by default the same path).
    let workdir = match &config.agent.ssh {
        Some(ssh) => {
            ssh.check()?;
            ssh.workdir.clone().unwrap_or(workdir)
        }
        None => {
            std::fs::create_dir_all(&workdir).map_err(|e| format!("{}: {e}", workdir.display()))?;
            workdir
        }
    };
    let mut tools = tools::Tools::new(workdir, Duration::from_secs(config.agent.command_timeout))
        .with_home(home.to_owned())
        .with_sandbox(config.agent.sandbox)
        .with_browser(config.agent.browser);
    if let Some(kib) = config.agent.context_kib {
        tools = tools.with_context(kib);
    }
    if let Some(docker) = &config.agent.docker {
        if config.agent.ssh.is_some() {
            return Err("[agent.docker] and [agent.ssh] are both set; commands run in one place".to_owned());
        }
        tools = tools.with_docker(docker.clone());
    }
    if let Some(ssh) = &config.agent.ssh {
        tools = tools.with_ssh(ssh.clone());
    }
    // Home Assistant, when it is set up; a token that does not work leaves the tool out.
    match homeassistant::Home::from_config(&config.homeassistant, home) {
        Ok(Some(ha)) => tools = tools.with_home_assistant(ha),
        Ok(None) => {}
        Err(e) => tracing::warn!("no home tool: {e}"),
    }
    if let Some(groups) = &config.agent.tools {
        if let Some(unknown) = groups.iter().find(|g| !tools::GROUPS.iter().any(|(n, _)| n == g)) {
            return Err(format!("[agent] tools: unknown group {unknown:?}"));
        }
        tools = tools.only(tools::tools_for(groups));
    }
    if let Some(unknown) = config.agent.disabled_tools.iter().find(|t| settings::group_of(t).is_none()) {
        return Err(format!("[agent] disabled_tools: unknown tool {unknown:?}"));
    }
    tools = tools.without(config.agent.disabled_tools.clone());
    Ok(agent::Agent {
        gateway,
        tools,
        approvals: config.approvals.clone(),
        max_steps: config.agent.max_steps,
        team: std::sync::Arc::new(team::Team::from_config(&config.agents, &config.team)?),
        mcp: std::sync::Arc::new(mcp::Hub::new(config.mcp.clone())?),
        trajectories: config.agent.trajectories.then(|| std::sync::Arc::new(trajectory::Recorder::dir(home))),
        options: agent::Options {
            context_kib: config.agent.context_kib,
            nudge_every: config.agent.nudge_every,
            persona: persona(config),
            recall_model: config.agent.recall_model.clone(),
            ..Default::default()
        },
    })
}

/// Who the bot is: its name, when it is not the default one (its `SOUL.md`, `USER.md` and skills
/// are in its own home, [Tools::with_home](tools::Tools::with_home)).
pub fn persona(config: &Config) -> Option<agent::Persona> {
    let name = config.bot.name.clone().filter(|n| n != bots::DEFAULT);
    name.is_some().then_some(agent::Persona { name })
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
    agent.options.vision = vision(models, id);
    if config.agent.context_kib.is_none() {
        let kib = info.map_or(session::CHAR_BUDGET / 1024, gateway::ModelInfo::context_kib);
        agent.options.context_kib = Some(kib);
        agent.tools = agent.tools.clone().with_context(kib);
    }
    Ok(())
}

/// Whether model [id] of [models] takes images: as the gateway says; for `auto`, no when no
/// model does, else not known (the router picks).
pub fn vision(models: &[gateway::ModelInfo], id: &str) -> Option<bool> {
    if id == "auto" {
        let blind = !models.is_empty() && models.iter().all(|m| m.vision == Some(false));
        return blind.then_some(false);
    }
    models.iter().find(|m| m.id == id).and_then(|m| m.vision)
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
