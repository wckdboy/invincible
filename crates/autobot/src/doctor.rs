//! `autobot doctor`: checks the whole install, gateway included, and says what to do about
//! each problem.

use std::path::Path;

use serde_json::json;

use crate::config::Config;

pub struct Check {
    /// False: a problem (`autobot doctor` fails).
    pub ok: bool,
    /// Fine to run with, but worth a look.
    pub warn: bool,
    pub what: String,
}

impl Check {
    /// `✓ what`, `! what` or `✗ what`.
    pub fn line(&self) -> String {
        if !self.ok {
            invincible::brand::fail(&self.what)
        } else if self.warn {
            invincible::brand::warn(&self.what)
        } else {
            invincible::brand::ok(&self.what)
        }
    }
}

fn ok(what: impl Into<String>) -> Check {
    Check { ok: true, warn: false, what: what.into() }
}

fn warn(what: impl Into<String>) -> Check {
    Check { ok: true, warn: true, what: what.into() }
}

fn bad(what: impl Into<String>) -> Check {
    Check { ok: false, warn: false, what: what.into() }
}

pub async fn run(config: &Config, home: &Path) -> Vec<Check> {
    let mut checks = Vec::new();
    match crate::find_program("invincible") {
        Some(path) => checks.push(ok(format!("invincible at {}", path.display()))),
        None => checks.push(bad("the `invincible` command is not installed (run the installer)")),
    }

    let gateway_path = match crate::gateway_config_path() {
        Ok(path) => path,
        Err(e) => {
            checks.push(bad(e));
            return checks;
        }
    };
    let gateway = invincible::fsutil::read_optional(&gateway_path)
        .and_then(|t| invincible::config::Config::parse(&t.unwrap_or_default()));
    match &gateway {
        Ok(g) => {
            checks.push(ok(format!("gateway network: {} (egress: {})", g.node.network, g.node.egress)));
            if g.models.is_empty() && g.cloud.is_empty() {
                checks.push(bad(
                    "the gateway has no models (`autobot setup`, `invincible model add` or `invincible cloud add`)",
                ));
            }
            for c in &g.cloud {
                match c.key(&gateway_path.parent().map(Path::to_path_buf).unwrap_or_default()) {
                    Ok(Some(_)) => checks.push(ok(format!(
                        "cloud model {} ({} at {}, data policy {})",
                        c.id,
                        c.upstream_model.as_deref().unwrap_or(&c.id),
                        c.base_url,
                        c.data_policy
                    ))),
                    Ok(None) => {
                        checks.push(bad(format!("cloud model {}: no API key (`invincible cloud add` again)", c.id)))
                    }
                    Err(e) => checks.push(bad(format!("cloud model {}: {e}", c.id))),
                }
            }
            for m in &g.models {
                if m.path.is_file() {
                    checks.push(ok(format!("model {} ({})", m.id, m.path.display())));
                } else {
                    checks.push(bad(format!("model {}: {} is missing", m.id, m.path.display())));
                }
            }
            let engine = g.engine.llama_server.display().to_string();
            match crate::find_on_path(&engine) {
                Some(p) => checks.push(ok(format!("llama.cpp at {}", p.display()))),
                None => checks.push(bad(format!("llama.cpp's {engine} is not installed (see the README)"))),
            }
        }
        Err(e) => checks.push(bad(format!("gateway config {}: {e}", gateway_path.display()))),
    }

    match crate::agent(config, home) {
        Err(e) => checks.push(bad(e)),
        Ok(agent) => {
            match agent.gateway.models().await {
                Ok(models) => {
                    checks.push(ok(format!("gateway answers at {} ({})", config.gateway.url, models.join(", "))))
                }
                Err(e) => {
                    checks.push(bad(e));
                    return finish(checks, config, home).await;
                }
            }
            let messages = [json!({ "role": "user", "content": "Reply with just the word ok." })];
            let infos = agent.gateway.model_info().await.unwrap_or_default();
            // Cloud models are not sent a test (that would be the owner's call); the answer is
            // from a local one, or, when the agent's model is a cloud model, not tried.
            if let Some(cloud) = infos.iter().find(|m| m.id == agent.gateway.model() && m.is_cloud()) {
                checks.push(ok(format!(
                    "the agent's model is {} ({}): not sent a test from here; `autobot run --cloud \"say ok\"` tries it",
                    cloud.id, cloud.tier
                )));
                return finish(checks, config, home).await;
            }
            let loading = infos.iter().any(|m| !m.is_cloud() && !m.healthy);
            let mut started = std::time::Instant::now();
            let mut answer = agent.gateway.chat(&messages, &json!([]), false).await;
            // Just started (a reboot, an upgrade): the model is still loading. Wait for it a while.
            let waiting = std::time::Instant::now();
            while loading
                && matches!(&answer, Err(e) if e.to_string().contains("no-model"))
                && waiting.elapsed() < std::time::Duration::from_secs(90)
            {
                if waiting.elapsed() < std::time::Duration::from_millis(100) {
                    eprintln!("… the model is not ready yet (loading?); waiting up to 90 s");
                }
                tokio::time::sleep(std::time::Duration::from_secs(3)).await;
                started = std::time::Instant::now();
                answer = agent.gateway.chat(&messages, &json!([]), false).await;
            }
            match answer {
                Ok(reply) => {
                    let model = reply.decision.as_ref().and_then(|d| d["model"].as_str().map(str::to_owned));
                    checks.push(ok(format!(
                        "a test answer from {} in {:.1}s{}",
                        model.unwrap_or_else(|| "?".into()),
                        started.elapsed().as_secs_f64(),
                        if config.gateway.private { " (agent turns are private: local models only)" } else { "" }
                    )));
                }
                Err(e)
                    if e.to_string().contains("no-model") && infos.iter().all(crate::gateway::ModelInfo::is_cloud) =>
                {
                    let ids: Vec<&str> = infos.iter().map(|m| m.id.as_str()).collect();
                    checks.push(bad(format!(
                        "no local model, and the gateway's automatic choice never uses a cloud model that trains on prompts: name one for the agent ([gateway] model = \"{}\" in {}), or `autobot code --model {}`",
                        ids.first().copied().unwrap_or("…"),
                        home.join("config.toml").display(),
                        ids.first().copied().unwrap_or("…")
                    )));
                }
                Err(e) => checks.push(bad(format!("a test answer failed: {e}"))),
            }
            checks.push(ok(format!(
                "tools work in {} (approvals: {:?})",
                agent.tools.workdir().display(),
                config.approvals.mode
            )));
            // Unattended commands need a working sandbox (or they are refused).
            if let Some(docker) = &config.agent.docker {
                let out = agent.tools.run(&crate::tools::Call::Terminal { command: "uname -sm".into() }).await;
                if out.contains("[exit code 0]") {
                    checks.push(ok(format!(
                        "commands run in the container {} ({}): {}",
                        docker.name(agent.tools.workdir()),
                        docker.image,
                        out.lines().next().unwrap_or_default()
                    )));
                } else {
                    checks.push(bad(format!("[agent.docker]: {}", out.lines().next().unwrap_or_default())));
                }
            } else if config.agent.sandbox == crate::sandbox::Mode::Off {
                checks.push(ok("sandbox off: unattended commands run unconfined ([agent] sandbox)"));
            } else {
                let probe = agent.tools.clone().unattended();
                let out = probe.run(&crate::tools::Call::Terminal { command: "echo sandboxed".into() }).await;
                if out.starts_with("sandboxed") {
                    checks.push(ok(format!(
                        "sandbox works ({:?}: unattended commands write only in the working directory)",
                        config.agent.sandbox
                    )));
                } else {
                    checks.push(bad(format!(
                        "the sandbox does not work here, so unattended commands are refused: {}",
                        out.lines().next().unwrap_or_default()
                    )));
                }
            }
        }
    }
    finish(checks, config, home).await
}

async fn finish(mut checks: Vec<Check>, config: &Config, home: &Path) -> Vec<Check> {
    if config.discord.enabled {
        match discord(config, home).await {
            Ok(name) => {
                let users = crate::discord::Users::load(home).map(|u| u.allowed.len()).unwrap_or(0);
                checks.push(ok(format!("Discord bot {name} ({users} allowed users)")));
            }
            Err(e) => checks.push(bad(format!("Discord: {e}"))),
        }
    }
    if config.telegram.enabled {
        match telegram(config, home).await {
            Ok(name) => {
                let users = crate::telegram::Users::load(home).map(|u| u.allowed.len()).unwrap_or(0);
                checks.push(ok(format!("Telegram bot @{name} ({users} allowed users)")));
            }
            Err(e) => checks.push(bad(format!("Telegram: {e}"))),
        }
    }
    checks
}

/// The "24/7 readiness" section: what it takes for the node to keep running unattended on a Mac
/// or a VPS. Nothing here leaves the machine.
pub async fn readiness(config: &Config, home: &Path) -> Vec<Check> {
    let mut checks = Vec::new();
    let platform = crate::service::Platform::current();
    let user_home = crate::setup::user_home();
    if let (Ok(platform), Ok(user_home)) = (&platform, &user_home) {
        match crate::setup::services(home) {
            Ok(services) => {
                for s in crate::service::status(*platform, user_home, &services) {
                    checks.push(service_check(&s));
                }
            }
            Err(e) => checks.push(bad(format!("services: {e}"))),
        }
        match platform {
            crate::service::Platform::SystemdUser => {
                let user = crate::service::user();
                if crate::service::linger(&user) {
                    checks.push(ok(format!("linger is on for {user}: the services run without a login")));
                } else {
                    checks.push(warn(format!(
                        "linger is off for {user}: the services stop when you log out (`sudo loginctl enable-linger {user}`)"
                    )));
                }
            }
            crate::service::Platform::SystemdSystem => {
                checks.push(ok("systemd system units: the services run without a login"));
            }
            crate::service::Platform::Launchd => {
                let out = std::process::Command::new("pmset").arg("-g").output();
                if let Ok(out) = out {
                    checks.push(match mac_sleep(&String::from_utf8_lossy(&out.stdout)) {
                        Some(0) => ok("the Mac does not sleep (pmset sleep 0)"),
                        Some(minutes) => warn(format!(
                            "the Mac sleeps after {minutes} min idle, and the services with it: `sudo pmset -a sleep 0` (or System Settings, Energy: prevent automatic sleeping)"
                        )),
                        None => ok("the Mac does not sleep"),
                    });
                }
            }
        }
    }

    match free_space(home) {
        Some(free) if free < 1 << 30 => checks.push(bad(format!(
            "disk: {} free where {} is; logs, receipts and updates need room",
            invincible::models::gib(free),
            home.display()
        ))),
        Some(free) if free < 5 << 30 => {
            checks.push(warn(format!("disk: {} free where {} is", invincible::models::gib(free), home.display())))
        }
        Some(free) => checks.push(ok(format!("disk: {} free", invincible::models::gib(free)))),
        None => {}
    }

    if let Ok(agent) = crate::agent(config, home) {
        if agent.gateway.healthy().await {
            checks.push(ok(format!("gateway reachable at {}", config.gateway.url)));
            if let Ok(models) = agent.gateway.model_info().await {
                let local: Vec<_> = models.iter().filter(|m| !m.is_cloud()).collect();
                let ready = local.iter().filter(|m| m.healthy).count();
                if local.is_empty() {
                    checks.push(ok(format!("models: {} cloud, no local model", models.len())));
                } else if ready == local.len() {
                    checks.push(ok(format!("models: {ready} of {} local loaded", local.len())));
                } else {
                    checks.push(warn(format!(
                        "models: {ready} of {} local loaded (loading, or see the engine logs)",
                        local.len()
                    )));
                }
            }
        } else {
            checks.push(bad(format!("the gateway does not answer at {}", config.gateway.url)));
        }
    }
    let agent_addr = invincible::watchdog::local(config.serve.listen);
    if invincible::watchdog::healthy(agent_addr, std::time::Duration::from_secs(3)) {
        checks.push(ok(format!("agent API answers on {agent_addr}")));
    } else {
        checks.push(warn(format!("the agent API does not answer on {agent_addr} (`autobot serve`, or the service)")));
    }

    if let Some(check) = clock() {
        checks.push(check);
    }

    let version = invincible::version::VERSION;
    let channel =
        invincible::version::Version::parse(version).map_or(invincible::version::Channel::Stable, |v| v.channel());
    let auto = crate::gateway_config_path()
        .ok()
        .and_then(|p| invincible::fsutil::read_optional(&p).ok().flatten())
        .and_then(|t| invincible::config::Config::parse(&t).ok())
        .map(|c| c.update.auto)
        .unwrap_or_else(|| "off".to_owned());
    if auto == "off" {
        checks.push(ok(format!(
            "version {version} ({channel} channel); updates by hand (`invincible update`, or `--auto stable` for daily)"
        )));
    } else {
        let job = match (&platform, &user_home) {
            (Ok(p), Ok(h)) => crate::setup::update_job().ok().map(|(job, _)| crate::service::status(*p, h, &[job])),
            _ => None,
        };
        match job.as_ref().and_then(|j| j.first()) {
            Some(s) if s.installed => checks.push(ok(format!(
                "version {version} ({channel} channel); updates daily on {auto} (log: {})",
                invincible::config::home().map(|h| h.join("logs/update.log").display().to_string()).unwrap_or_default()
            ))),
            _ => checks.push(warn(format!(
                "[update] auto = {auto:?}, but the daily job is not installed (`invincible update --auto {auto}`)"
            ))),
        }
    }
    checks
}

fn service_check(s: &crate::service::Status) -> Check {
    let mut notes = Vec::new();
    if let Some(n) = s.restarts.filter(|n| *n > 0) {
        notes.push(format!("{n} restart{}", if n == 1 { "" } else { "s" }));
    }
    if let Some(last) = s.last_exit.as_ref().filter(|l| l.as_str() != "never exited") {
        notes.push(format!("last stop: {last}"));
    }
    let notes = if notes.is_empty() { String::new() } else { format!(" ({})", notes.join(", ")) };
    match (s.installed, s.enabled, s.running) {
        (false, _, _) => warn(format!(
            "service {} not installed: `autobot service install` runs it in the background, also after reboots",
            s.name
        )),
        (true, true, true) => ok(format!("service {} running, starts at boot{notes}", s.name)),
        (true, false, true) => warn(format!("service {} running, but does not start at boot{notes}", s.name)),
        (true, _, false) => bad(format!("service {} installed but not running{notes} (see its log)", s.name)),
    }
}

/// Minutes until the Mac sleeps when idle, from `pmset -g` (0: never).
pub fn mac_sleep(pmset: &str) -> Option<u64> {
    let field = |name: &str| {
        pmset.lines().find_map(|l| {
            let mut words = l.split_whitespace();
            (words.next() == Some(name)).then(|| words.next().and_then(|v| v.parse::<u64>().ok())).flatten()
        })
    };
    if field("SleepDisabled") == Some(1) {
        return Some(0);
    }
    field("sleep")
}

fn free_space(path: &Path) -> Option<u64> {
    let mut dir = path;
    while !dir.exists() {
        dir = dir.parent()?;
    }
    let stat = rustix::fs::statvfs(dir).ok()?;
    Some(stat.f_bavail.saturating_mul(stat.f_frsize))
}

/// Whether the clock follows network time (receipts, schedules and TLS need it right).
fn clock() -> Option<Check> {
    if cfg!(target_os = "linux") {
        let out = std::process::Command::new("timedatectl")
            .args(["show", "-p", "NTPSynchronized", "--value"])
            .output()
            .ok()?;
        return match String::from_utf8_lossy(&out.stdout).trim() {
            "yes" => Some(ok("the clock is synchronized (NTP)")),
            "no" => Some(warn("the clock is not synchronized: `sudo timedatectl set-ntp true`")),
            _ => None,
        };
    }
    if cfg!(target_os = "macos") {
        let running = std::process::Command::new("pgrep").args(["-x", "timed"]).output().ok()?.status.success();
        return Some(if running {
            ok("the clock follows network time (timed)")
        } else {
            warn("network time looks off: System Settings, General, Date & Time: set time automatically")
        });
    }
    None
}

async fn discord(config: &Config, home: &Path) -> Result<String, String> {
    let token = config.discord.token(home)?;
    let network = crate::network()?;
    let client = invincible::egress::client(&network)?;
    let me = crate::discord::Bot::new(client, &config.discord.api(), &token, network)?.me().await?;
    Ok(me["username"].as_str().unwrap_or("?").to_owned())
}

async fn telegram(config: &Config, home: &Path) -> Result<String, String> {
    let token = config.telegram.token(home)?;
    let client = invincible::egress::client(&crate::network()?)?;
    let me = crate::telegram::Bot::new(client, &config.telegram.api(), &token)?.me().await?;
    Ok(me["username"].as_str().unwrap_or("?").to_owned())
}

#[cfg(test)]
mod tests {
    use super::mac_sleep;

    #[test]
    fn reads_the_macs_sleep_setting() {
        let pmset = "System-wide power settings:\n SleepDisabled\t\t0\nCurrently in use:\n standby              1\n disksleep            10\n sleep                1 (sleep prevented by powerd)\n displaysleep         10\n";
        assert_eq!(mac_sleep(pmset), Some(1));
        assert_eq!(mac_sleep(" sleep                0\n displaysleep 10\n"), Some(0));
        assert_eq!(mac_sleep(" SleepDisabled\t\t1\n sleep 10\n"), Some(0));
        assert_eq!(mac_sleep("nothing here"), None);
    }
}
