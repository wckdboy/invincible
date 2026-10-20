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
    /// Type into a web page in the browser (or submit its form): what, where, on which page.
    Type {
        page: String,
        field: String,
        text: String,
        submit: bool,
    },
    /// Call a Home Assistant service ([crate::homeassistant]): `light.turn_on`, on which
    /// entities, with what else (JSON, empty for nothing).
    Home {
        service: String,
        entities: String,
        data: String,
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
            Self::Type { .. } => "type",
            Self::Home { .. } => "home",
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
            Self::Type { page, field, text, submit } => {
                let text: String = text.chars().take(200).collect();
                match (text.is_empty(), submit) {
                    (true, _) => format!("submit the form at {field} on {page}"),
                    (false, false) => format!("type \"{text}\" into {field} on {page}"),
                    (false, true) => format!("type \"{text}\" into {field} on {page}, and send it"),
                }
            }
            Self::Home { service, entities, data } => {
                let mut line = format!("home: {service}");
                if !entities.is_empty() {
                    line.push_str(&format!(" {entities}"));
                }
                if !data.is_empty() {
                    line.push_str(&format!(" {}", data.chars().take(200).collect::<String>()));
                }
                line
            }
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Answer {
    Once,
    /// Yes, and the same action again in this session without asking.
    Always,
    Deny,
    /// No, and what to do instead (the owner's words, handed to the model with the refusal).
    Instead(String),
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
    // `cloud`: turns with nobody to ask (schedules, hooks, the board) may use a cloud model
    // that keeps prompts; the owner said so ahead of time.
    if matches!(action, Action::Cloud(_)) && config.allow.iter().any(|a| a.trim() == "cloud") {
        return Verdict::Run;
    }
    // `mcp:<server>/<tool>` allows that tool, whatever its arguments.
    if let Action::Mcp { tool, .. } = action
        && config.allow.iter().any(|a| a.trim().strip_prefix("mcp:") == Some(tool.as_str()))
    {
        return Verdict::Run;
    }
    // `home:light.turn_on` allows that service, `home:light.*` the domain's, whatever entity.
    if let Action::Home { service, .. } = action
        && config
            .allow
            .iter()
            .filter_map(|a| a.trim().strip_prefix("home:"))
            .any(|a| a == service || a.strip_suffix(".*").is_some_and(|d| service.split('.').next() == Some(d)))
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
        // `cloud` is a permission, not a command.
        .filter(|a| !a.is_empty() && *a != "cloud")
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
    fn cloud_in_the_allowlist_lets_unattended_turns_use_cloud_models() {
        let mut c = config(ApprovalMode::Allowlist);
        let cloud = Action::Cloud("deepseek keeps prompts".into());
        assert!(matches!(check(&c, &cloud), Verdict::Refuse(_)));
        c.allow.push("cloud".into());
        assert_eq!(check(&c, &cloud), Verdict::Run);
        assert!(!allowlisted(&c.allow, "cloud"), "not a command");
    }

    #[test]
    fn home_services_are_allowlisted_by_name_or_domain() {
        let home = |service: &str| Action::Home {
            service: service.into(),
            entities: "light.kitchen".into(),
            data: String::new(),
        };
        let mut c = config(ApprovalMode::Allowlist);
        assert!(matches!(check(&c, &home("light.turn_on")), Verdict::Refuse(_)));
        assert_eq!(check(&config(ApprovalMode::Ask), &home("light.turn_on")), Verdict::Ask);
        c.allow.push("home:light.*".into());
        c.allow.push("home:switch.toggle".into());
        assert_eq!(check(&c, &home("light.turn_off")), Verdict::Run);
        assert_eq!(check(&c, &home("switch.toggle")), Verdict::Run);
        assert!(matches!(check(&c, &home("switch.turn_on")), Verdict::Refuse(_)));
        assert!(matches!(check(&c, &home("lightx.turn_on")), Verdict::Refuse(_)));
        assert_eq!(home("light.turn_on").describe(), "home: light.turn_on light.kitchen");
        assert_eq!(home("x.y").kind(), "home");
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
