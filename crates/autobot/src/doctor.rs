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
            if g.models.is_empty() {
                checks.push(bad("the gateway has no models (`autobot setup` or `invincible model add`)"));
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
            let started = std::time::Instant::now();
            match agent.gateway.chat(&messages, &json!([]), false).await {
                Ok(reply) => {
                    let model = reply.decision.as_ref().and_then(|d| d["model"].as_str().map(str::to_owned));
                    checks.push(ok(format!(
                        "a test answer from {} in {:.1}s{}",
                        model.unwrap_or_else(|| "?".into()),
                        started.elapsed().as_secs_f64(),
                        if config.gateway.private { " (agent turns are private: local models only)" } else { "" }
                    )));
                }
                Err(e) => checks.push(bad(format!("a test answer failed: {e}"))),
            }
            checks.push(ok(format!(
                "tools work in {} (approvals: {:?})",
                agent.tools.workdir().display(),
                config.approvals.mode
            )));
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
        && let Ok(services) = crate::setup::services(config, home)
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
