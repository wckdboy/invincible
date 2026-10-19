//! The heartbeat: every so often (`[agent] heartbeat = "30m"`), the agent works through the
//! owner's checklist in `$AUTOBOT_HOME/HEARTBEAT.md` ("is the disk over 90%?", "did last night's
//! backup run?") with its tools, unattended and sandboxed, and messages the owner on Telegram
//! only when something needs them. A quiet check answers `OK` and says nothing.

use std::path::{Path, PathBuf};
use std::time::Duration;

/// The checklist, when there is one with something in it.
pub fn checklist(home: &Path) -> Option<String> {
    let text = std::fs::read_to_string(home.join("HEARTBEAT.md")).ok()?;
    let text = text.trim();
    (!text.is_empty()).then(|| text.chars().take(8000).collect())
}

/// Whether [answer] means "nothing needs the owner".
pub fn quiet(answer: &str) -> bool {
    let a = answer.trim().trim_matches(|c: char| c.is_ascii_punctuation() || c.is_whitespace()).to_ascii_lowercase();
    a == "ok" || a == "all ok" || a == "nothing" || a.is_empty()
}

/// One check: the agent's answer (unattended rules, sandboxed commands).
pub async fn check(agent: &crate::agent::Agent, home: &Path, list: &str) -> Result<String, String> {
    let mut unattended = agent.clone();
    if unattended.approvals.mode != crate::config::ApprovalMode::Trust {
        unattended.approvals.mode = crate::config::ApprovalMode::Allowlist;
    }
    unattended.tools = unattended.tools.clone().unattended();
    unattended.team = Default::default();
    let mut session = crate::session::Session::open(&home.join("sessions"), "heartbeat")?;
    // Each check starts fresh: the checklist is the whole context.
    session.reset()?;
    let prompt = format!(
        "Heartbeat check. Go through the owner's checklist below with your tools. If nothing needs \
         the owner's attention, answer exactly OK and nothing else. Otherwise answer with only what \
         needs attention, briefly, with the facts.\n\nChecklist:\n{list}"
    );
    let context = crate::tools::TurnContext { session: "heartbeat".into(), ..Default::default() };
    let mut grants = std::collections::HashSet::new();
    let run = unattended.turn(&mut session, &prompt, &crate::approval::Refuse, &mut grants, &|_| {});
    crate::tools::TURN.scope(context, run).await.map(|o| o.text)
}

/// Checks every [every] until the process stops; what needs the owner goes to the Telegram
/// users allowed to use the bot.
pub async fn run(
    agent: std::sync::Arc<crate::agent::Agent>,
    home: PathBuf,
    every: Duration,
    telegram: Option<crate::telegram::Bot>,
) {
    loop {
        tokio::time::sleep(every).await;
        let Some(list) = checklist(&home) else { continue };
        match check(&agent, &home, &list).await {
            Ok(answer) if quiet(&answer) => tracing::info!("heartbeat: all quiet"),
            Ok(answer) => {
                tracing::info!("heartbeat: something needs the owner");
                let Some(bot) = &telegram else { continue };
                for user in crate::telegram::Users::load(&home).map(|u| u.allowed).unwrap_or_default() {
                    if let Err(e) = bot.send(user.id, &format!("💓 {answer}")).await {
                        tracing::warn!("heartbeat: Telegram: {e}");
                    }
                }
            }
            Err(e) => tracing::warn!("heartbeat: {e}"),
        }
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn quiet_answers() {
        for q in ["OK", "ok.", " OK! ", "All OK", "Nothing"] {
            assert!(super::quiet(q), "{q}");
        }
        for loud in ["The disk is 95% full", "OK, but the backup failed"] {
            assert!(!super::quiet(loud), "{loud}");
        }
    }
}
