//! `autobot migrate hermes|openclaw`: brings over what another agent learned and was told, from
//! Hermes Agent (`~/.hermes`) or OpenClaw (`~/.openclaw`): its SOUL.md, its memory and user
//! profile (MEMORY.md, USER.md), the owner's skills, the command allowlist, AGENTS.md, the
//! model and the command timeout. Nothing already here is overwritten, and every entry goes
//! through the same checks as the agent's own (no secrets or personal data in memory or the
//! profile). API keys and bot tokens are never copied unless `--with-secrets` says so, and then
//! only into Autobot's own secret files (mode 0600). `--dry-run` says what it would do.

use std::path::{Path, PathBuf};

use crate::config::Config;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Source {
    Hermes,
    OpenClaw,
}

impl Source {
    pub fn parse(name: &str) -> Result<Self, String> {
        match name.to_lowercase().as_str() {
            "hermes" | "hermes-agent" => Ok(Self::Hermes),
            "openclaw" | "claw" => Ok(Self::OpenClaw),
            other => Err(format!("{other:?}: hermes or openclaw")),
        }
    }

    pub fn name(self) -> &'static str {
        match self {
            Self::Hermes => "Hermes",
            Self::OpenClaw => "OpenClaw",
        }
    }

    /// Where it keeps its files: `$HERMES_HOME` or `~/.hermes`; `~/.openclaw`.
    pub fn root(self) -> Option<PathBuf> {
        if self == Self::Hermes
            && let Some(home) = std::env::var_os("HERMES_HOME")
        {
            return Some(PathBuf::from(home));
        }
        let home = PathBuf::from(std::env::var_os("HOME")?);
        Some(home.join(match self {
            Self::Hermes => ".hermes",
            Self::OpenClaw => ".openclaw",
        }))
    }
}

pub struct Options {
    pub dry_run: bool,
    pub with_secrets: bool,
    /// The models the gateway serves (None: it could not say); a model is taken over only when
    /// it is one of them.
    pub models: Option<Vec<String>>,
    /// Where the agent works (AGENTS.md goes there).
    pub workdir: PathBuf,
}

/// What the migration did (or would do), a line each.
#[derive(Default)]
pub struct Report {
    pub lines: Vec<String>,
}

impl Report {
    fn say(&mut self, line: impl Into<String>) {
        self.lines.push(line.into());
    }
}

/// Environment keys that hold model provider keys, and the provider each is for.
const PROVIDER_KEYS: &[(&str, &str)] = &[
    ("ANTHROPIC_API_KEY", "anthropic"),
    ("OPENAI_API_KEY", "openai"),
    ("DEEPSEEK_API_KEY", "deepseek"),
    ("OPENROUTER_API_KEY", "openrouter"),
    ("GEMINI_API_KEY", "gemini"),
    ("GOOGLE_API_KEY", "gemini"),
    ("MISTRAL_API_KEY", "mistral"),
    ("GROQ_API_KEY", "groq"),
    ("XAI_API_KEY", "xai"),
    ("NOUS_API_KEY", "nous"),
];

pub fn run(source: Source, from: &Path, home: &Path, config: &Config, options: &Options) -> Result<Report, String> {
    if !from.is_dir() {
        return Err(format!("no {} here: {} is not a directory (--from DIR)", source.name(), from.display()));
    }
    let mut r = Report::default();
    let would = if options.dry_run { "would " } else { "" };
    r.say(format!(
        "{} at {}{}",
        source.name(),
        from.display(),
        if options.dry_run { " (dry run: nothing is changed)" } else { "" }
    ));
    let (soul, memory, user, agents, skill_dirs, env) = match source {
        Source::Hermes => (
            from.join("SOUL.md"),
            vec![from.join("memories/MEMORY.md")],
            from.join("memories/USER.md"),
            from.join("AGENTS.md"),
            vec![from.join("skills")],
            from.join(".env"),
        ),
        Source::OpenClaw => {
            let ws = from.join("workspace");
            let mut memory = vec![ws.join("MEMORY.md")];
            let mut daily: Vec<PathBuf> = std::fs::read_dir(ws.join("memory"))
                .into_iter()
                .flatten()
                .flatten()
                .map(|e| e.path())
                .filter(|p| p.extension().is_some_and(|x| x == "md"))
                .collect();
            daily.sort();
            memory.extend(daily);
            let mut skills = vec![ws.join("skills"), from.join("skills"), ws.join(".agents/skills")];
            if let Some(user_home) = std::env::var_os("HOME").map(PathBuf::from)
                && from == user_home.join(".openclaw")
            {
                skills.push(user_home.join(".agents/skills"));
            }
            (ws.join("SOUL.md"), memory, ws.join("USER.md"), ws.join("AGENTS.md"), skills, from.join(".env"))
        }
    };

    // SOUL.md: the agent's character; kept as a personality when there is one here already.
    if let Some(text) = read(&soul) {
        let ours = crate::personality::soul_path(home);
        let alt = home.join("personalities").join(format!("{}.md", source.name().to_lowercase()));
        if !ours.exists() {
            write(&ours, &text, options.dry_run)?;
            r.say(format!("SOUL.md: {would}keep it as {}", ours.display()));
        } else if !alt.exists() {
            write(&alt, &text, options.dry_run)?;
            r.say(format!(
                "SOUL.md: there is one here already; {would}keep theirs as the personality {} (/personality to try it)",
                source.name().to_lowercase()
            ));
        } else {
            r.say("SOUL.md: there is one here already, and the personality too; left out");
        }
    }

    // Memory: one fact per entry.
    let facts: Vec<String> = memory.iter().filter_map(|p| read(p)).flat_map(|t| entries(&t)).collect();
    if !facts.is_empty() {
        let store = crate::memory::Memory::new(home);
        let known: Vec<String> = store.list().into_iter().map(|f| f.text).collect();
        let (mut kept, mut secret, mut dup) = (0, 0, 0);
        for fact in facts {
            if known.contains(&fact) {
                dup += 1;
            } else if crate::profile::sensitive(&fact).is_some() {
                secret += 1;
            } else {
                if !options.dry_run {
                    store.add(&fact)?;
                }
                kept += 1;
            }
        }
        r.say(format!(
            "memory: {would}keep {kept} facts{}{}",
            if dup > 0 { format!(", {dup} known already") } else { String::new() },
            if secret > 0 { format!(", {secret} left out (secrets or personal data)") } else { String::new() }
        ));
    }

    // The user profile.
    if let Some(text) = read(&user) {
        let mut profile = crate::profile::read(home);
        let (mut kept, mut skipped) = (0, 0);
        for entry in entries(&text) {
            let entry: String = entry.chars().take(crate::profile::MAX_ENTRY).collect();
            match crate::profile::apply(&profile, &crate::profile::Change::Add(entry)) {
                Ok(next) if next != profile => {
                    profile = next;
                    kept += 1;
                }
                Ok(_) => {}
                Err(_) => skipped += 1,
            }
        }
        if kept > 0 && !options.dry_run {
            invincible::fsutil::replace_private(&crate::profile::path(home), &profile)?;
        }
        r.say(format!(
            "USER.md: {would}keep {kept} entries in {}{}",
            crate::profile::path(home).display(),
            if skipped > 0 {
                format!(" ({skipped} left out: secrets, personal data, or no room)")
            } else {
                String::new()
            }
        ));
    }

    // AGENTS.md: the instructions for the agent's own working directory.
    if let Some(text) = read(&agents) {
        let to = options.workdir.join("AGENTS.md");
        if to.exists() {
            r.say(format!("AGENTS.md: {} has one already; left out", options.workdir.display()));
        } else {
            write(&to, &text, options.dry_run)?;
            r.say(format!("AGENTS.md: {would}put it in {}", options.workdir.display()));
        }
    }

    // Skills: every directory with a SKILL.md (and flat .md skills), not over ours.
    for dir in skill_dirs.iter().filter(|d| d.is_dir()) {
        if options.dry_run {
            let names: Vec<String> = skill_names(dir);
            let (new, known): (Vec<String>, Vec<String>) =
                names.into_iter().partition(|n| crate::skills::find(home, n).is_none());
            r.say(format!(
                "skills in {}: would install {}{}",
                dir.display(),
                if new.is_empty() { "none".to_owned() } else { new.join(", ") },
                if known.is_empty() { String::new() } else { format!(" ({} here already)", known.join(", ")) }
            ));
            continue;
        }
        match crate::skills::install(home, &dir.display().to_string()) {
            Ok((installed, skipped)) => r.say(format!(
                "skills in {}: installed {}{}",
                dir.display(),
                if installed.is_empty() { "none".to_owned() } else { installed.join(", ") },
                if skipped.is_empty() { String::new() } else { format!(" ({} left out)", skipped.len()) }
            )),
            Err(e) => r.say(format!("skills in {}: {e}", dir.display())),
        }
        // Plain Markdown skills (`name.md`), as some keep them.
        for entry in std::fs::read_dir(dir).into_iter().flatten().flatten() {
            let path = entry.path();
            let Some(name) = path.file_name().and_then(|n| n.to_str()).and_then(|n| n.strip_suffix(".md")) else {
                continue;
            };
            let readme = name.eq_ignore_ascii_case("readme");
            if !readme && crate::skills::valid(name) && crate::skills::find(home, name).is_none() && path.is_file() {
                let text = std::fs::read_to_string(&path).unwrap_or_default();
                if crate::profile::sensitive(&text).is_none() {
                    write(&home.join("skills").join(format!("{name}.md")), &text, false)?;
                    r.say(format!("skill {name}: installed"));
                }
            }
        }
    }

    // Settings: the allowlist, the model, the command timeout.
    let settings = match source {
        Source::Hermes => hermes_settings(&from.join("config.yaml")),
        Source::OpenClaw => openclaw_settings(from),
    };
    let config_path = home.join("config.toml");
    let new_allow: Vec<String> = settings
        .allow
        .iter()
        .map(|a| a.trim().to_owned())
        .filter(|a| !a.is_empty() && !config.approvals.allow.contains(a))
        .collect();
    let (safe, unsafe_): (Vec<String>, Vec<String>) = new_allow.into_iter().partition(|a| plain_command(a));
    if !safe.is_empty() {
        if !options.dry_run {
            let mut all = config.approvals.allow.clone();
            all.extend(safe.iter().cloned());
            let mut array = toml_edit::Array::new();
            for a in &all {
                array.push(a.as_str());
            }
            crate::setup::set(&config_path, "approvals", "allow", toml_edit::value(array))?;
        }
        r.say(format!("allowlist: {would}add {} ([approvals] allow)", safe.join(", ")));
    }
    if !unsafe_.is_empty() {
        r.say(format!(
            "allowlist: left out {} (patterns or chained commands; an Autobot entry is a plain command)",
            unsafe_.join(", ")
        ));
    }
    if let Some(model) = &settings.model {
        let id = model.rsplit('/').next().unwrap_or(model);
        match &options.models {
            Some(models) if models.iter().any(|m| m == id || m == model) => {
                let chosen = if models.iter().any(|m| m == model) { model.as_str() } else { id };
                if !options.dry_run {
                    crate::setup::set(&config_path, "gateway", "model", toml_edit::value(chosen))?;
                }
                r.say(format!("model: {would}use {chosen} ([gateway] model)"));
            }
            Some(_) => r.say(format!(
                "model: {model} is not on the gateway; add it (`invincible cloud add {}`), then /model",
                settings.provider.as_deref().unwrap_or_else(|| model.split('/').next().unwrap_or(model))
            )),
            None => r.say(format!("model: {model} (the gateway did not answer; /model to choose it later)")),
        }
    }
    if let Some(secs) = settings.timeout.filter(|s| *s > 0 && *s != config.agent.command_timeout) {
        if !options.dry_run {
            crate::setup::set(&config_path, "agent", "command_timeout", toml_edit::value(secs as i64))?;
        }
        r.say(format!("command timeout: {would}set {secs} seconds ([agent] command_timeout)"));
    }

    // Keys and tokens: only with --with-secrets, into Autobot's files.
    let env = read(&env).map(|t| env_pairs(&t)).unwrap_or_default();
    let secrets: Vec<(String, PathBuf, String)> = env
        .iter()
        .filter_map(|(k, v)| {
            let to = match k.as_str() {
                "TELEGRAM_BOT_TOKEN" => home.join("telegram.token"),
                "DISCORD_BOT_TOKEN" => home.join("discord.token"),
                _ => {
                    let (_, provider) = PROVIDER_KEYS.iter().find(|(key, _)| key == k)?;
                    home.join("secrets").join(format!("{provider}.key"))
                }
            };
            Some((k.clone(), to, v.clone()))
        })
        .collect();
    if !secrets.is_empty() && !options.with_secrets {
        let names: Vec<&str> = secrets.iter().map(|(k, _, _)| k.as_str()).collect();
        r.say(format!(
            "keys: found {} (not copied; --with-secrets copies them into Autobot's files, 0600)",
            names.join(", ")
        ));
    } else {
        for (key, to, value) in &secrets {
            if to.exists() {
                r.say(format!("{key}: {} exists; left as it is", to.display()));
                continue;
            }
            if !options.dry_run {
                invincible::fsutil::replace_private(to, &format!("{value}\n"))?;
            }
            let next = match to.file_name().and_then(|n| n.to_str()) {
                Some("telegram.token") => "set [telegram] enabled = true".to_owned(),
                Some("discord.token") => "set [discord] enabled = true".to_owned(),
                _ => {
                    let provider = to.file_stem().and_then(|s| s.to_str()).unwrap_or_default();
                    format!("give it to the gateway: invincible cloud add {provider} --key-stdin < {}", to.display())
                }
            };
            r.say(format!("{key}: {would}keep it in {} (0600); then {next}", to.display()));
        }
    }
    if r.lines.len() == 1 {
        r.say("nothing to bring over");
    }
    Ok(r)
}

/// The text of [path], when it has any.
fn read(path: &Path) -> Option<String> {
    std::fs::read_to_string(path).ok().filter(|t| !t.trim().is_empty())
}

fn write(path: &Path, text: &str, dry_run: bool) -> Result<(), String> {
    if dry_run {
        return Ok(());
    }
    invincible::fsutil::replace_private(path, text)
}

/// The entries of a memory file: Hermes separates them with `§`; Markdown lists and paragraphs
/// otherwise. Headings and front matter are left out.
pub fn entries(text: &str) -> Vec<String> {
    let text = text.strip_prefix("---").and_then(|r| r.find("\n---").map(|e| &r[e + 4..])).unwrap_or(text);
    let chunks: Vec<String> = if text.contains('§') {
        text.split('§').map(str::to_owned).collect()
    } else {
        let mut out = Vec::new();
        let mut para = String::new();
        for line in text.lines() {
            let t = line.trim();
            if let Some(item) = t.strip_prefix("- ").or_else(|| t.strip_prefix("* ")) {
                if !para.is_empty() {
                    out.push(std::mem::take(&mut para));
                }
                out.push(item.to_owned());
            } else if t.is_empty() || t.starts_with('#') {
                if !para.is_empty() {
                    out.push(std::mem::take(&mut para));
                }
            } else {
                if !para.is_empty() {
                    para.push(' ');
                }
                para.push_str(t);
            }
        }
        if !para.is_empty() {
            out.push(para);
        }
        out
    };
    chunks
        .into_iter()
        .map(|c| c.split_whitespace().collect::<Vec<_>>().join(" "))
        .map(|c| c.trim_start_matches(['-', '*', ' ']).to_owned())
        .filter(|c| !c.is_empty() && !c.starts_with('#'))
        .map(|c| c.chars().take(crate::memory::MAX_FACT).collect())
        .collect()
}

/// A command an Autobot allowlist entry can be: no patterns, nothing that chains.
fn plain_command(entry: &str) -> bool {
    !entry.contains(['*', '?', '[', '^', '$', ';', '&', '|', '`', '>', '<', '(', ')', '\\', '\n'])
}

fn skill_names(dir: &Path) -> Vec<String> {
    let mut names = Vec::new();
    for entry in std::fs::read_dir(dir).into_iter().flatten().flatten() {
        let path = entry.path();
        if path.join("SKILL.md").is_file() {
            names.push(entry.file_name().to_string_lossy().into_owned());
        } else if path.is_dir() {
            names.extend(skill_names(&path));
        }
    }
    names.sort();
    names
}

/// Settings found in the other agent's config.
#[derive(Debug, Default, PartialEq, Eq)]
pub struct Settings {
    pub model: Option<String>,
    pub provider: Option<String>,
    pub allow: Vec<String>,
    pub timeout: Option<u64>,
}

/// Hermes' `config.yaml`, read for what is taken over: `model` (a string, or `default` and
/// `provider` under it), `command_allowlist`, `terminal.timeout`. A small reader for that
/// much YAML, not a YAML parser.
pub fn hermes_settings(path: &Path) -> Settings {
    let Some(text) = read(path) else { return Settings::default() };
    let mut s = Settings::default();
    let mut section = String::new();
    let unquote = |v: &str| v.split(" #").next().unwrap_or(v).trim().trim_matches(['"', '\'']).to_owned();
    for line in text.lines() {
        if line.trim_start().starts_with('#') || line.trim().is_empty() {
            continue;
        }
        let indent = line.len() - line.trim_start().len();
        let t = line.trim();
        if indent == 0 {
            let (key, value) = t.split_once(':').unwrap_or((t, ""));
            section = key.trim().to_owned();
            let value = unquote(value);
            match section.as_str() {
                "model" if !value.is_empty() => s.model = Some(value),
                "command_allowlist" if value.starts_with('[') => {
                    s.allow.extend(value.trim_matches(['[', ']']).split(',').map(unquote).filter(|v| !v.is_empty()));
                }
                _ => {}
            }
            continue;
        }
        if let Some(item) = t.strip_prefix("- ") {
            if section == "command_allowlist" {
                s.allow.push(unquote(item));
            }
            continue;
        }
        let Some((key, value)) = t.split_once(':') else { continue };
        let value = unquote(value);
        match (section.as_str(), key.trim()) {
            ("model", "default" | "model" | "name") if !value.is_empty() => s.model = Some(value),
            ("model", "provider") if !value.is_empty() => s.provider = Some(value),
            ("terminal", "timeout") => s.timeout = value.parse().ok(),
            _ => {}
        }
    }
    s
}

/// OpenClaw's `openclaw.json` (`agents.defaults.model`, `tools.exec.timeoutSec`) and
/// `exec-approvals.json` (the commands allowed).
pub fn openclaw_settings(root: &Path) -> Settings {
    let mut s = Settings::default();
    let json = |name: &str| -> serde_json::Value {
        read(&root.join(name)).and_then(|t| serde_json::from_str(&t).ok()).unwrap_or_default()
    };
    let config = json("openclaw.json");
    let model = &config["agents"]["defaults"]["model"];
    s.model = model.as_str().or(model["primary"].as_str()).map(str::to_owned);
    s.provider = s.model.as_deref().and_then(|m| m.split_once('/')).map(|(p, _)| p.to_owned());
    s.timeout = config["tools"]["exec"]["timeoutSec"].as_u64();
    // Whatever shape it has: the strings under allowlist-like keys, or objects' patterns.
    fn collect(v: &serde_json::Value, inside: bool, out: &mut Vec<String>) {
        match v {
            serde_json::Value::String(text) if inside => out.push(text.clone()),
            serde_json::Value::Array(items) => items.iter().for_each(|i| collect(i, inside, out)),
            serde_json::Value::Object(map) => {
                for (k, v) in map {
                    let key = k.to_lowercase();
                    let here = inside || key.contains("allow") || key == "commands";
                    if here && matches!(key.as_str(), "pattern" | "command" | "cmd") {
                        if let Some(text) = v.as_str() {
                            out.push(text.to_owned());
                        }
                    } else if !matches!(key.as_str(), "id" | "lastusedat" | "createdat" | "lastresolvedpath") {
                        collect(v, here, out);
                    }
                }
            }
            _ => {}
        }
    }
    collect(&json("exec-approvals.json"), false, &mut s.allow);
    s.allow.dedup();
    s
}

/// `KEY=value` lines of a `.env` file (quotes and `export ` taken off).
fn env_pairs(text: &str) -> Vec<(String, String)> {
    text.lines()
        .filter_map(|l| {
            let l = l.trim();
            let l = l.strip_prefix("export ").unwrap_or(l);
            if l.starts_with('#') {
                return None;
            }
            let (k, v) = l.split_once('=')?;
            let v = v.trim().trim_matches(['"', '\'']);
            (!v.is_empty()).then(|| (k.trim().to_owned(), v.to_owned()))
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn memory_files_split_into_entries() {
        assert_eq!(entries("Uses Rust§ Deploys on Fridays\n§\n"), ["Uses Rust", "Deploys on Fridays"]);
        assert_eq!(
            entries("# Memory\n\n- Uses Rust\n- Backups at 02:00\n\nA paragraph\nthat goes on.\n"),
            ["Uses Rust", "Backups at 02:00", "A paragraph that goes on."]
        );
        assert!(entries("---\ntitle: x\n---\n# Only a heading\n").is_empty());
    }

    #[test]
    fn hermes_and_openclaw_settings_are_read() {
        let dir = std::env::temp_dir().join(format!("autobot-migrate-settings-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(
            dir.join("config.yaml"),
            "# Hermes\nmodel:\n  default: \"anthropic/claude-sonnet-4\"  # the main one\n  provider: anthropic\nterminal:\n  backend: local\n  timeout: 300\ncommand_allowlist:\n  - git status\n  - \"rm -rf *\"\n",
        )
        .unwrap();
        let s = hermes_settings(&dir.join("config.yaml"));
        assert_eq!(s.model.as_deref(), Some("anthropic/claude-sonnet-4"));
        assert_eq!(s.provider.as_deref(), Some("anthropic"));
        assert_eq!(s.timeout, Some(300));
        assert_eq!(s.allow, ["git status", "rm -rf *"]);
        std::fs::write(dir.join("config.yaml"), "model: qwen3\ncommand_allowlist: [ls, 'git log']\n").unwrap();
        let s = hermes_settings(&dir.join("config.yaml"));
        assert_eq!(
            (s.model.as_deref(), s.allow.as_slice()),
            (Some("qwen3"), ["ls".to_owned(), "git log".to_owned()].as_slice())
        );
        std::fs::write(
            dir.join("openclaw.json"),
            r#"{"agents": {"defaults": {"model": {"primary": "deepseek/deepseek-chat"}}}, "tools": {"exec": {"timeoutSec": 90}}}"#,
        )
        .unwrap();
        std::fs::write(
            dir.join("exec-approvals.json"),
            r#"{"agents": {"main": {"allowlist": [{"id": "1", "pattern": "npm test"}, {"pattern": "/usr/bin/ls"}]}}}"#,
        )
        .unwrap();
        let s = openclaw_settings(&dir);
        assert_eq!(s.model.as_deref(), Some("deepseek/deepseek-chat"));
        assert_eq!(s.provider.as_deref(), Some("deepseek"));
        assert_eq!(s.timeout, Some(90));
        assert_eq!(s.allow, ["npm test", "/usr/bin/ls"]);
        assert!(plain_command("npm test") && !plain_command("rm -rf *") && !plain_command("ls; rm x"));
        assert_eq!(
            env_pairs("# x\nexport A=\"1\"\nB=\nC='two'"),
            [("A".into(), "1".into()), ("C".into(), "two".into())]
        );
        std::fs::remove_dir_all(dir).unwrap();
    }
}
