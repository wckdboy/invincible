//! The heartbeat: every so often (`[agent] heartbeat = "30m"`), the agent works through the
//! owner's checklist in `$AUTOBOT_HOME/HEARTBEAT.md` ("is the disk over 90%?", "did last night's
//! backup run?") with its tools, unattended (commands write-confined, or unconfined when
//! `[agent] sandbox = "off"`), and messages the owner on Telegram only when something needs
//! them. A quiet check answers `OK` and says nothing.

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

/// One check: the agent's answer (unattended rules; commands write-confined, or unconfined when
/// `[agent] sandbox = "off"`).
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

/// Checks every [every] until the process stops; what needs the owner goes to the bot's home
/// channel (`/sethome`), else to the Telegram users allowed to use the bot.
pub async fn run(runtime: std::sync::Arc<crate::bots::Runtime>, every: Duration) {
    let home: PathBuf = runtime.home.clone();
    loop {
        tokio::time::sleep(every).await;
        let Some(list) = checklist(&home) else { continue };
        let checked = check(&runtime.agent(), &home, &list).await;
        if checked.is_ok() {
            // It ran, whatever it found.
            crate::alerts::raise(crate::alerts::Alert::cleared(
                crate::alerts::Kind::Job,
                &format!("heartbeat:{}", runtime.name),
                format!("{}'s heartbeat runs again.", runtime.name),
            ));
        }
        match checked {
            Ok(answer) if quiet(&answer) => tracing::info!(bot = %runtime.name, "heartbeat: all quiet"),
            Ok(answer) => {
                tracing::info!(bot = %runtime.name, "heartbeat: something needs the owner");
                let text = format!("💓 {answer}");
                match runtime.home_channel() {
                    Some(address) => runtime.notify(&[address], &text).await,
                    None => runtime.everyone("telegram", &text).await,
                }
            }
            Err(e) => {
                tracing::warn!(bot = %runtime.name, "heartbeat: {e}");
                runtime.error(&format!("heartbeat: {e}"));
                crate::alerts::raise(crate::alerts::Alert::new(
                    crate::alerts::Kind::Job,
                    &format!("heartbeat:{}", runtime.name),
                    format!("{}'s heartbeat check failed: {e}", runtime.name),
                ));
            }
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
