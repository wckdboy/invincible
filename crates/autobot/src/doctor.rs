//! `autobot doctor`: checks the whole install, gateway included, and says what to do about
//! each problem.

use std::path::Path;

use serde_json::json;

use crate::config::Config;

pub struct Check {
    pub ok: bool,
    pub what: String,
}

fn ok(what: impl Into<String>) -> Check {
    Check { ok: true, what: what.into() }
}

fn bad(what: impl Into<String>) -> Check {
    Check { ok: false, what: what.into() }
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
    if config.telegram.enabled {
        match telegram(config, home).await {
            Ok(name) => {
                let users = crate::telegram::Users::load(home).map(|u| u.allowed.len()).unwrap_or(0);
                checks.push(ok(format!("Telegram bot @{name} ({users} allowed users)")));
            }
            Err(e) => checks.push(bad(format!("Telegram: {e}"))),
        }
    }
    if let (Ok(platform), Ok(user_home)) = (crate::service::Platform::current(), crate::setup::user_home())
        && let Ok(services) = crate::setup::services(home)
    {
        for (name, installed, running) in crate::service::status(platform, &user_home, &services) {
            checks.push(match (installed, running) {
                (true, true) => ok(format!("service {name} running")),
                (true, false) => bad(format!("service {name} installed but not running (see its log)")),
                (false, _) => {
                    ok(format!("service {name} not installed (`autobot service install` to run in the background)"))
                }
            });
        }
    }
    checks
}

async fn telegram(config: &Config, home: &Path) -> Result<String, String> {
    let token = config.telegram.token(home)?;
    let client = invincible::egress::client(&crate::network()?)?;
    let me = crate::telegram::Bot::new(client, &config.telegram.api(), &token)?.me().await?;
    Ok(me["username"].as_str().unwrap_or("?").to_owned())
}
