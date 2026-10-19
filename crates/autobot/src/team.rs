//! A team: agents with roles that the main agent hands work to (`delegate`). Each is the same
//! agent loop on the same gateway, with its own instructions, a subset of the tools (tool
//! groups, as recipes use), optionally its own model, and its own conversation per task. A
//! member starts each task fresh, with only the goal and context it was given: small models
//! need a small context, and nothing leaks between tasks.
//!
//! Members cannot delegate (depth 1). Their approvals go to the owner through the main turn's
//! approver, labelled with the member's name; they never get more than the main agent may do.
//!
//! ```toml
//! [agents.researcher]
//! description = "Reads files and logs, reports facts with where they came from"
//! instructions = "You research. Read, don't change anything. Answer with findings and paths."
//! tools = ["files-read", "memory"]
//!
//! [agents.coder]
//! description = "Changes code and runs it"
//! tools = ["files-read", "files-write", "terminal"]
//! model = "qwen3.5-4b"               # optional: a model id or `auto` (default: the main agent's)
//! telegram_token_file = "coder.token" # optional: its own Telegram bot, to post in a group
//!
//! [team]
//! max_parallel = 2                   # members working at once (what the local model can serve)
//! ```

use std::collections::BTreeMap;

use serde::Deserialize;

#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RoleConfig {
    /// What it is for: the main agent picks members by this.
    pub description: String,
    /// Its own instructions, before the shared ones.
    #[serde(default)]
    pub instructions: Option<String>,
    /// Tool groups ([crate::tools::GROUPS]); none means it only thinks and answers.
    #[serde(default)]
    pub tools: Vec<String>,
    #[serde(default)]
    pub model: Option<String>,
    /// A Telegram bot of its own (a file holding its token, relative to `$AUTOBOT_HOME`): in a
    /// group with the main bot, it posts its own progress and answers.
    #[serde(default)]
    pub telegram_token_file: Option<std::path::PathBuf>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct TeamConfig {
    #[serde(default = "two")]
    pub max_parallel: usize,
}

fn two() -> usize {
    2
}

impl Default for TeamConfig {
    fn default() -> Self {
        Self { max_parallel: two() }
    }
}

/// A member, ready to work.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Role {
    pub name: String,
    pub description: String,
    pub instructions: Option<String>,
    pub tools: Vec<String>,
    pub model: Option<String>,
}

/// The members, by name.
#[derive(Clone, Debug, Default)]
pub struct Team {
    pub roles: Vec<Role>,
    pub max_parallel: usize,
}

/// A member name: letters, digits, `-` and `_`, as it shows in session names.
pub fn valid_name(name: &str) -> bool {
    (1..=32).contains(&name.len()) && name.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

impl Team {
    pub fn from_config(agents: &BTreeMap<String, RoleConfig>, team: &TeamConfig) -> Result<Self, String> {
        let mut roles = Vec::new();
        for (name, role) in agents {
            if !valid_name(name) {
                return Err(format!("[agents.{name}]: a name is letters, digits, - and _ (at most 32)"));
            }
            if let Some(unknown) = role.tools.iter().find(|g| !crate::tools::GROUPS.iter().any(|(n, _)| n == g)) {
                let known: Vec<&str> = crate::tools::GROUPS.iter().map(|(n, _)| *n).collect();
                return Err(format!("[agents.{name}] tools: unknown group {unknown:?} (groups: {})", known.join(", ")));
            }
            roles.push(Role {
                name: name.clone(),
                description: role.description.trim().to_owned(),
                instructions: role.instructions.clone().filter(|i| !i.trim().is_empty()),
                tools: role.tools.clone(),
                model: role.model.clone().filter(|m| !m.trim().is_empty()),
            });
        }
        Ok(Self { roles, max_parallel: team.max_parallel.clamp(1, 8) })
    }

    pub fn is_empty(&self) -> bool {
        self.roles.is_empty()
    }

    pub fn get(&self, name: &str) -> Option<&Role> {
        self.roles.iter().find(|r| r.name == name)
    }

    /// The members, for the main agent's instructions.
    pub fn prompt(&self) -> String {
        self.roles
            .iter()
            .map(|r| {
                let tools = if r.tools.is_empty() { "no tools".to_owned() } else { r.tools.join(", ") };
                format!("- {}: {} ({tools})", r.name, r.description)
            })
            .collect::<Vec<_>>()
            .join("\n")
    }

    /// The `delegate` tool's definition, naming the members.
    pub fn definition(&self) -> serde_json::Value {
        let names: Vec<&str> = self.roles.iter().map(|r| r.name.as_str()).collect();
        serde_json::json!({ "type": "function", "function": {
            "name": "delegate",
            "description": "Hand a task to a member of your team. It starts fresh: give it the goal and every fact it needs in context. It answers with its result. Several delegate calls in one reply work at the same time.",
            "parameters": { "type": "object", "properties": {
                "agent": { "type": "string", "enum": names },
                "goal": { "type": "string", "description": "What to do, in one or two sentences" },
                "context": { "type": "string", "description": "What it needs to know: paths, findings so far, constraints" },
            }, "required": ["agent", "goal"] },
        }})
    }
}
