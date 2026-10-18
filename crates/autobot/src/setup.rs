//! `autobot setup`: one wizard for the gateway and the agent. Every step can be run again; what
//! is already set up is kept.

use std::io::{BufRead, Write};
use std::path::Path;
use std::process::Command;

use crate::config;

/// A model the wizard offers: Qwen open weights, sized for the machine.
pub struct Choice {
    pub id: &'static str,
    pub source: &'static str,
    /// File size, for the fit check.
    pub bytes: u64,
    pub note: &'static str,
}

pub const CHOICES: &[Choice] = &[
    Choice {
        id: "qwen3.5-4b",
        source: "hf:unsloth/Qwen3.5-4B-GGUF/Qwen3.5-4B-Q4_K_M.gguf",
        bytes: 2_740_937_888,
        note: "small and quick; 8 GB machines and small VPSs",
    },
    Choice {
        id: "qwen3.5-9b",
        source: "hf:unsloth/Qwen3.5-9B-GGUF/Qwen3.5-9B-Q4_K_M.gguf",
        bytes: 5_680_522_464,
        note: "better tool use; 16 GB",
    },
    Choice {
        id: "qwen3.8-27b",
        source: "hf:unsloth/Qwen3.8-27B-GGUF/Qwen3.8-27B-UD-Q4_K_M.gguf",
        bytes: 16_464_440_224,
        note: "strong agent model; 32 GB Apple silicon or a 24 GB GPU",
    },
];

/// The largest choice that fits in [budget] bytes; the smallest when none does.
pub fn suggest(budget: Option<u64>) -> usize {
    let Some(budget) = budget else { return 0 };
    CHOICES.iter().rposition(|c| invincible::models::needed(c.bytes) <= budget).unwrap_or(0)
}

/// Reads answers from stdin; the installer points it at the terminal.
pub struct Prompt<R: BufRead> {
    input: R,
}

impl<R: BufRead> Prompt<R> {
    pub fn new(input: R) -> Self {
        Self { input }
    }

    pub fn ask(&mut self, question: &str, default: &str) -> Result<String, String> {
        if default.is_empty() {
            eprint!("{question}: ");
        } else {
            eprint!("{question} [{default}]: ");
        }
        std::io::stderr().flush().ok();
        let mut line = String::new();
        let n = self.input.read_line(&mut line).map_err(|e| e.to_string())?;
        if n == 0 {
            return Err("setup needs answers, but input ended (run `autobot setup` in a terminal)".to_owned());
        }
        let line = line.trim();
        Ok(if line.is_empty() { default.to_owned() } else { line.to_owned() })
    }

    pub fn yes(&mut self, question: &str, default: bool) -> Result<bool, String> {
        loop {
            let answer = self.ask(question, if default { "Y/n" } else { "y/N" })?;
            match answer.to_ascii_lowercase().as_str() {
                "y/n" | "y/n " => return Ok(default),
                "y" | "yes" => return Ok(true),
                "n" | "no" => return Ok(false),
                _ => eprintln!("  y or n"),
            }
        }
    }
}

/// Sets `[table] key = value` in the TOML file at [path], keeping everything else as it is.
pub fn set(path: &Path, table: &str, key: &str, value: toml_edit::Item) -> Result<(), String> {
    let text = invincible::fsutil::read_optional(path)?.unwrap_or_default();
    let mut doc: toml_edit::DocumentMut = text.parse().map_err(|e| format!("{}: {e}", path.display()))?;
    let entry = doc.entry(table).or_insert_with(|| toml_edit::Item::Table(toml_edit::Table::new()));
    let table = entry.as_table_mut().ok_or(format!("{}: [{table}] is not a table", path.display()))?;
    table.insert(key, value);
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| format!("{}: {e}", dir.display()))?;
    }
    let tmp = path.with_extension("toml.tmp");
    std::fs::write(&tmp, doc.to_string()).map_err(|e| format!("{}: {e}", tmp.display()))?;
    std::fs::rename(&tmp, path).map_err(|e| format!("{}: {e}", path.display()))
}

pub fn run<R: BufRead>(prompt: &mut Prompt<R>, home: &Path) -> Result<(), String> {
    let invincible_bin = crate::find_program("invincible").ok_or(
        "the `invincible` command is not installed (run the installer, or `cargo install --path crates/invincible`)",
    )?;
    let gateway_path = crate::gateway_config_path()?;
    let agent_path = home.join("config.toml");

    eprintln!("\nAutobot Agent + Invincible Gateway setup\n");
    eprintln!("1. Network");
    eprintln!("   offline: nothing leaves this machine (no cloud models, no Telegram)");
    eprintln!("   direct:  normal internet");
    eprintln!("   tor:     through Tor at 127.0.0.1:9050 (Tor must be running)");
    let gateway_text = invincible::fsutil::read_optional(&gateway_path)?.unwrap_or_default();
    let gateway =
        invincible::config::Config::parse(&gateway_text).map_err(|e| format!("{}: {e}", gateway_path.display()))?;
    let network = loop {
        let answer = prompt.ask("   network", &gateway.node.network)?;
        let mode = match answer.as_str() {
            "tor" => "tor:127.0.0.1:9050".to_owned(),
            other => other.to_owned(),
        };
        if mode == "offline" || mode == "direct" || mode.starts_with("tor:") || mode.starts_with("socks5:") {
            if invincible_policy::NetworkMode::decode(&mode).is_offline() && mode != "offline" {
                eprintln!("   {mode:?} is not a valid address (tor:<host>:<port>, socks5:<host>:<port>)");
                continue;
            }
            break mode;
        }
        eprintln!("   one of offline, direct, tor, tor:<host>:<port>, socks5:<host>:<port>");
    };
    set(&gateway_path, "node", "network", toml_edit::value(&network))?;
    // The agent reads the gateway's API token; make it now rather than on the gateway's first start.
    invincible::token::load_or_create(&gateway_path.with_file_name("token"))?;

    eprintln!("\n2. Model");
    if gateway.models.is_empty() {
        let budget = invincible::models::memory_budget();
        if let Some(b) = &budget {
            eprintln!("   this machine: about {} for models ({})", invincible::models::gib(b.bytes), b.source);
        }
        let suggested = suggest(budget.as_ref().map(|b| b.bytes));
        for (i, c) in CHOICES.iter().enumerate() {
            eprintln!("   {}) {} ({}) {}", i + 1, c.id, invincible::models::gib(c.bytes), c.note);
        }
        eprintln!("   or hf:<owner>/<repo>/<file.gguf>, or skip");
        let answer = prompt.ask("   model", &(suggested + 1).to_string())?;
        let (id, source) = match answer.parse::<usize>() {
            Ok(n) if (1..=CHOICES.len()).contains(&n) => {
                (CHOICES[n - 1].id.to_owned(), CHOICES[n - 1].source.to_owned())
            }
            _ if answer == "skip" => (String::new(), String::new()),
            _ => {
                let id = prompt.ask("   an id for it", "local")?;
                (id, answer)
            }
        };
        if !id.is_empty() {
            // The weights download once; offline after that is fine.
            let download = if network == "offline" { "direct".to_owned() } else { network.clone() };
            if network == "offline" {
                eprintln!("   (the download itself goes direct; the gateway stays offline afterwards)");
            }
            let status = Command::new(&invincible_bin)
                .args(["model", "add", &id, &source, "--network", &download, "--context", "32768"])
                .status()
                .map_err(|e| format!("{}: {e}", invincible_bin.display()))?;
            if !status.success() {
                return Err("the model download failed; run `autobot setup` again to retry".to_owned());
            }
        }
    } else {
        let ids: Vec<_> = gateway.models.iter().map(|m| m.id.as_str()).collect();
        eprintln!("   serving {} (add more with `invincible model add`)", ids.join(", "));
    }
    let engine = &gateway.engine.llama_server;
    if crate::find_on_path(&engine.display().to_string()).is_none() {
        eprintln!(
            "   ! llama.cpp's {} is not installed: the installer sets it up, or see the README",
            engine.display()
        );
    }

    eprintln!("\n3. Agent");
    let current = config::Config::load(&agent_path)?;
    let workdir = prompt.ask("   working directory for tools", &current.agent.workdir(home).display().to_string())?;
    set(&agent_path, "agent", "workdir", toml_edit::value(&workdir))?;
    eprintln!("   Commands and file writes ask you first (change with [approvals] in {}).", agent_path.display());
    let private = prompt.yes("   keep agent work on this machine only (no cloud models)?", current.gateway.private)?;
    set(&agent_path, "gateway", "private", toml_edit::value(private))?;

    eprintln!("\n4. Telegram (optional)");
    eprintln!("   Talk to the agent from your phone through a Telegram bot. Telegram's servers see these");
    eprintln!("   chats (bots are not end-to-end encrypted); the Autobot app, paired with the gateway, is private.");
    let telegram = prompt.yes("   connect a Telegram bot?", current.telegram.enabled)?;
    if telegram {
        if network == "offline" {
            eprintln!("   ! the network is offline, so the bot cannot reach Telegram until you pick direct or tor");
        }
        let token_path = home.join("telegram.token");
        if current.telegram.token(home).is_err() {
            eprintln!("   Make a bot with @BotFather in Telegram (/newbot) and paste its token here.");
            let token = prompt.ask("   bot token", "")?;
            if token.is_empty() || !token.contains(':') {
                return Err("that does not look like a bot token (123456:ABC…)".to_owned());
            }
            let _ = std::fs::remove_file(&token_path);
            invincible::fsutil::create_private(&token_path, &format!("{token}\n"))?;
        }
        eprintln!(
            "   Message the bot; it answers with a code; approve it here with `autobot telegram approve <code>`."
        );
    }
    set(&agent_path, "telegram", "enabled", toml_edit::value(telegram))?;

    eprintln!("\n5. Background");
    if prompt.yes("   run the gateway (and the Telegram bot) in the background, also after reboots?", true)? {
        let config = config::Config::load(&agent_path)?;
        for line in
            crate::service::install(crate::service::Platform::current()?, &user_home()?, &services(&config, home)?)?
        {
            eprintln!("   {line}");
        }
    } else {
        eprintln!("   start by hand: `invincible serve`, then `autobot` to chat");
    }
    eprintln!("\nDone. `autobot doctor` checks everything; `autobot` starts a chat.");
    Ok(())
}

pub fn user_home() -> Result<std::path::PathBuf, String> {
    std::env::var_os("HOME").map(std::path::PathBuf::from).ok_or("HOME is not set".to_owned())
}

/// The services this configuration runs.
pub fn services(config: &config::Config, home: &Path) -> Result<Vec<crate::service::Service>, String> {
    use crate::service::{AGENT, GATEWAY, Service};
    let gateway_bin = crate::find_program("invincible").ok_or("the `invincible` command is not installed")?;
    let gateway_home = invincible::config::home()?;
    let mut services = vec![Service {
        name: GATEWAY,
        description: "Invincible Gateway",
        program: absolute(&gateway_bin)?,
        args: vec!["serve".into()],
        log: gateway_home.join("logs/gateway.log"),
        after: None,
    }];
    if config.telegram.enabled {
        services.push(Service {
            name: AGENT,
            description: "Autobot Agent",
            program: absolute(&std::env::current_exe().map_err(|e| e.to_string())?)?,
            args: vec!["serve".into()],
            log: home.join("logs/agent.log"),
            after: Some(GATEWAY),
        });
    }
    Ok(services)
}

fn absolute(path: &Path) -> Result<std::path::PathBuf, String> {
    path.canonicalize().map_err(|e| format!("{}: {e}", path.display()))
}

#[cfg(test)]
mod tests {
    use super::{CHOICES, Prompt, set, suggest};

    #[test]
    fn suggests_the_largest_model_that_fits() {
        assert_eq!(suggest(None), 0);
        assert_eq!(suggest(Some(1 << 30)), 0);
        assert_eq!(suggest(Some(12 << 30)), 1);
        assert_eq!(suggest(Some(64 << 30)), CHOICES.len() - 1);
    }

    #[test]
    fn prompts_take_defaults_and_refuse_eof() {
        let mut p = Prompt::new(std::io::Cursor::new("\nno\nmaybe\ny\n"));
        assert_eq!(p.ask("q", "d").unwrap(), "d");
        assert!(!p.yes("q", true).unwrap());
        assert!(p.yes("q", false).unwrap());
        assert!(p.ask("q", "").is_err());
    }

    #[test]
    fn set_keeps_the_rest_of_the_file() {
        let dir = std::env::temp_dir().join(format!("autobot-setup-{}", std::process::id()));
        let path = dir.join("config.toml");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(&path, "# mine\n[node]\negress = \"never\"\n\n[[models]]\nid = \"a\"\npath = \"/a\"\n").unwrap();
        set(&path, "node", "network", toml_edit::value("direct")).unwrap();
        let text = std::fs::read_to_string(&path).unwrap();
        assert!(
            text.contains("# mine") && text.contains("network = \"direct\"") && text.contains("id = \"a\""),
            "{text}"
        );
        invincible::config::Config::parse(&text).unwrap();
        std::fs::remove_dir_all(dir).unwrap();
    }
}
