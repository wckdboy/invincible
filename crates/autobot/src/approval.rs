//! Approvals: nothing that changes the machine, reads outside the working directory, or sends
//! work to a cloud model happens without the owner's yes, unless they allowlisted it.

use std::future::Future;
use std::path::PathBuf;
use std::pin::Pin;

use crate::config::{ApprovalConfig, ApprovalMode};

/// What the agent wants to do.
#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub enum Action {
    Command(String),
    /// [inside]: in the working directory. [hidden]: under a dot name there (`.git/config`,
    /// `.envrc`), where a write can make a later command run something else; never unattended.
    Write {
        path: PathBuf,
        bytes: usize,
        inside: bool,
        hidden: bool,
    },
    /// Read or list outside the working directory.
    Read(PathBuf),
    /// The gateway's router asks before using a cloud model; the text says why.
    Cloud(String),
    /// Fetch a web page (through the gateway, under the node's network policy).
    Fetch(String),
    /// Call an MCP server's tool: `server/tool`, and the arguments (JSON).
    Mcp {
        tool: String,
        arguments: String,
    },
}

impl Action {
    /// The kind, for the action log.
    pub fn kind(&self) -> &'static str {
        match self {
            Self::Command(_) => "command",
            Self::Write { .. } => "write",
            Self::Read(_) => "read",
            Self::Cloud(_) => "cloud",
            Self::Fetch(_) => "fetch",
            Self::Mcp { .. } => "mcp",
        }
    }

    /// One line for a prompt or a chat message.
    pub fn describe(&self) -> String {
        match self {
            Self::Command(c) => format!("run: {c}"),
            Self::Write { path, bytes, .. } => format!("write {bytes} bytes to {}", path.display()),
            Self::Read(path) => format!("read {} (outside the working directory)", path.display()),
            Self::Cloud(why) => format!("send this turn to a cloud model: {why}"),
            Self::Fetch(url) => format!("fetch {url}"),
            Self::Mcp { tool, arguments } => {
                format!("use {tool} {}", arguments.chars().take(300).collect::<String>())
            }
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Answer {
    Once,
    /// Yes, and the same action again in this session without asking.
    Always,
    Deny,
}

/// The team member asking, when it is not the main agent: `[coder] ` to put before a question.
pub fn asker() -> String {
    crate::tools::TURN.try_with(|t| t.agent.clone()).ok().flatten().map(|a| format!("[{a}] ")).unwrap_or_default()
}

/// Whoever can say yes: the terminal, a Telegram chat, a paired app.
pub trait Approver: Send + Sync {
    fn approve<'a>(&'a self, action: &'a Action) -> Pin<Box<dyn Future<Output = Answer> + Send + 'a>>;

    /// Where the owner answers, for the action log: `cli`, `app`, `telegram`.
    fn channel(&self) -> &'static str {
        "owner"
    }
}

/// Says no to everything (one-shot runs with no one to ask).
pub struct Refuse;

impl Approver for Refuse {
    fn approve<'a>(&'a self, _: &'a Action) -> Pin<Box<dyn Future<Output = Answer> + Send + 'a>> {
        Box::pin(async { Answer::Deny })
    }

    fn channel(&self) -> &'static str {
        "unattended"
    }
}

#[derive(Debug, PartialEq, Eq)]
pub enum Verdict {
    Run,
    Ask,
    Refuse(String),
}

/// The policy's answer before anyone is asked.
pub fn check(config: &ApprovalConfig, action: &Action) -> Verdict {
    if config.mode == ApprovalMode::Trust {
        return Verdict::Run;
    }
    if let Action::Command(command) = action
        && allowlisted(&config.allow, command)
    {
        return Verdict::Run;
    }
    // `mcp:<server>/<tool>` allows that tool, whatever its arguments.
    if let Action::Mcp { tool, .. } = action
        && config.allow.iter().any(|a| a.trim().strip_prefix("mcp:") == Some(tool.as_str()))
    {
        return Verdict::Run;
    }
    // A URL allowlist entry (`https://docs.rs`) covers that site: the URL is it, or under it.
    if let Action::Fetch(url) = action
        && config
            .allow
            .iter()
            .map(|a| a.trim().trim_end_matches('/'))
            .filter(|a| a.starts_with("https://"))
            .any(|a| url == a || url.strip_prefix(a).is_some_and(|rest| rest.starts_with('/') || rest.starts_with('?')))
    {
        return Verdict::Run;
    }
    match (config.mode, action) {
        // Unattended, the agent may still work in its own directory.
        (ApprovalMode::Allowlist | ApprovalMode::Edits, Action::Write { inside: true, hidden: false, .. }) => {
            Verdict::Run
        }
        (ApprovalMode::Ask | ApprovalMode::Edits, _) => Verdict::Ask,
        _ => Verdict::Refuse(format!("not allowlisted ([approvals] mode = \"allowlist\"): {}", action.describe())),
    }
}

/// [command] is an allowed entry, or one followed by arguments, with nothing that could chain a
/// second command or redirect output (`git status; rm -rf ~` does not match `git status`).
pub fn allowlisted(allow: &[String], command: &str) -> bool {
    let command = command.trim();
    if command.chars().any(|c| matches!(c, ';' | '&' | '|' | '`' | '$' | '>' | '<' | '\n' | '\r' | '(' | ')' | '\\')) {
        return false;
    }
    allow
        .iter()
        .map(|a| a.trim())
        .filter(|a| !a.is_empty())
        .any(|a| command == a || command.strip_prefix(a).is_some_and(|rest| rest.starts_with(' ')))
}

#[cfg(test)]
mod tests {
    use super::{Action, Verdict, allowlisted, check};
    use crate::config::{ApprovalConfig, ApprovalMode};

    fn config(mode: ApprovalMode) -> ApprovalConfig {
        ApprovalConfig { mode, allow: vec!["git status".into(), "ls".into()] }
    }

    #[test]
    fn allowlist_matches_whole_commands_only() {
        let allow = config(ApprovalMode::Ask).allow;
        assert!(allowlisted(&allow, "git status"));
        assert!(allowlisted(&allow, "ls -la src"));
        assert!(!allowlisted(&allow, "lsof"));
        assert!(!allowlisted(&allow, "git status; rm -rf ~"));
        assert!(!allowlisted(&allow, "ls && curl evil"));
        assert!(!allowlisted(&allow, "ls $(cat ~/.ssh/id_ed25519)"));
        assert!(!allowlisted(&allow, "ls > /etc/passwd"));
        assert!(!allowlisted(&allow, "ls\nrm x"));
        assert!(!allowlisted(&[], "ls"));
    }

    #[test]
    fn modes() {
        let command = Action::Command("rm -rf build".into());
        assert_eq!(check(&config(ApprovalMode::Ask), &command), Verdict::Ask);
        assert!(matches!(check(&config(ApprovalMode::Allowlist), &command), Verdict::Refuse(_)));
        assert_eq!(check(&config(ApprovalMode::Trust), &command), Verdict::Run);
        assert_eq!(check(&config(ApprovalMode::Allowlist), &Action::Command("ls".into())), Verdict::Run);
        // Writes ask; unattended, only those in the working directory run.
        let write = Action::Write { path: "x".into(), bytes: 1, inside: true, hidden: false };
        assert_eq!(check(&config(ApprovalMode::Ask), &write), Verdict::Ask);
        assert_eq!(check(&config(ApprovalMode::Allowlist), &write), Verdict::Run);
        let outside = Action::Write { path: "/etc/x".into(), bytes: 1, inside: false, hidden: false };
        assert!(matches!(check(&config(ApprovalMode::Allowlist), &outside), Verdict::Refuse(_)));
        // `.git/config` can make an allowlisted `git status` run anything: never unattended.
        let hidden = Action::Write { path: ".git/config".into(), bytes: 1, inside: true, hidden: true };
        assert!(matches!(check(&config(ApprovalMode::Allowlist), &hidden), Verdict::Refuse(_)));
        assert_eq!(check(&config(ApprovalMode::Ask), &hidden), Verdict::Ask);
        assert!(matches!(check(&config(ApprovalMode::Allowlist), &Action::Cloud("x".into())), Verdict::Refuse(_)));
        // Edits: writes in the working directory run, everything else asks.
        assert_eq!(check(&config(ApprovalMode::Edits), &write), Verdict::Run);
        assert_eq!(check(&config(ApprovalMode::Edits), &hidden), Verdict::Ask);
        assert_eq!(check(&config(ApprovalMode::Edits), &outside), Verdict::Ask);
        assert_eq!(check(&config(ApprovalMode::Edits), &command), Verdict::Ask);
    }
}
