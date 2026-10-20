//! The owner's commands for what shapes the agent: `autobot personality`, `autobot profile`,
//! `autobot skills`, `autobot usage` and `autobot insights`. Each prints for a person and returns
//! an error as text.

use std::path::Path;

use crate::config::Config;

/// `autobot personality [list | show [name] | set <name|none>]`.
pub fn personality(home: &Path, action: &str, name: Option<&str>) -> Result<(), String> {
    match (action, name) {
        ("list", _) => {
            let active = crate::personality::active(home);
            for p in crate::personality::list(home) {
                let mark = if active.as_deref() == Some(p.name.as_str()) { "●" } else { " " };
                let whose = if p.path.is_some() { "  (yours)" } else { "" };
                println!("{mark} {:<12} {}{whose}", p.name, p.description);
            }
            let none = if active.is_none() { "●" } else { " " };
            println!("{none} {:<12} no personality", "none");
            let soul = crate::personality::soul_path(home);
            if crate::personality::soul(home).is_some() {
                println!("\nSOUL.md: {}", soul.display());
            } else {
                println!("\nno SOUL.md yet: write the agent's character in {}", soul.display());
            }
            println!("your own: a Markdown file each in {}", home.join("personalities").display());
        }
        ("show", None) => {
            match crate::personality::soul(home) {
                Some(soul) => println!("SOUL.md ({}):\n\n{soul}\n", crate::personality::soul_path(home).display()),
                None => println!("no SOUL.md ({})\n", crate::personality::soul_path(home).display()),
            }
            match crate::personality::active(home) {
                Some(name) => println!("personality {name}:\n\n{}", crate::personality::text(home, &name)?),
                None => println!("no personality (`autobot personality set <name>`)"),
            }
        }
        ("show", Some(name)) => println!("{}", crate::personality::text(home, name)?),
        ("set", Some(name)) => {
            crate::personality::set(home, name)?;
            if crate::personality::is_none(name) {
                println!("no personality from now on (SOUL.md still holds)");
            } else {
                println!("personality {name} from now on, in every conversation (/personality changes one)");
            }
        }
        ("set", None) => return Err("autobot personality set <name> (or none)".to_owned()),
        (other, _) => return Err(format!("{other:?}: list, show or set")),
    }
    Ok(())
}

/// `autobot profile [--clear]`.
pub fn profile(home: &Path, clear: bool) -> Result<(), String> {
    let path = crate::profile::path(home);
    if clear {
        match std::fs::remove_file(&path) {
            Ok(()) => println!("cleared {}", path.display()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => println!("there is no profile yet"),
            Err(e) => return Err(format!("{}: {e}", path.display())),
        }
        return Ok(());
    }
    let entries = crate::profile::entries(home);
    if entries.is_empty() {
        println!("nothing yet: the agent keeps how you work in {} as it learns it", path.display());
        return Ok(());
    }
    for entry in entries {
        println!("• {entry}");
    }
    println!("\n{} (edit it freely)", path.display());
    Ok(())
}

/// `autobot skills` and its actions.
pub fn skills(home: &Path, action: Option<(&str, &str)>) -> Result<(), String> {
    match action {
        Some(("accept", name)) => {
            crate::skills::accept(home, name)?;
            println!("kept {name}: the agent uses it from now on");
            return Ok(());
        }
        Some(("reject", name)) => {
            if !crate::skills::reject(home, name)? {
                return Err(format!("there is no proposed skill {name:?}"));
            }
            println!("threw {name} away");
            return Ok(());
        }
        Some(("remove", name)) => {
            if !crate::skills::remove(home, name)? {
                return Err(format!("there is no skill {name:?}"));
            }
            println!("removed {name}");
            return Ok(());
        }
        Some(("install", source)) => {
            let (installed, skipped) = crate::skills::install(home, source)?;
            for name in &installed {
                let description = crate::skills::find(home, name).map(|s| s.description).unwrap_or_default();
                println!("installed {name}  {description}");
            }
            for why in &skipped {
                println!("left out {why}");
            }
            if installed.is_empty() {
                return Err("nothing installed".to_owned());
            }
            println!(
                "\na skill is instructions the agent follows: read what you installed ({})",
                home.join("skills").display()
            );
            return Ok(());
        }
        Some((other, _)) => return Err(format!("{other:?}: list, install, remove, accept or reject")),
        None => {}
    }
    let skills = crate::skills::list(home);
    if skills.is_empty() {
        println!(
            "no skills yet: `autobot skills install <git-url|path>`, or a SKILL.md in a directory of {}",
            home.join("skills").display()
        );
    }
    for skill in skills {
        let tools = if skill.allowed_tools.is_empty() {
            String::new()
        } else {
            format!("  (allowed-tools: {})", skill.allowed_tools.join(" "))
        };
        println!("{}  {}{tools}", skill.name, skill.description);
    }
    let proposals = crate::skills::proposals(home);
    if !proposals.is_empty() {
        println!("\nproposed by the agent (`autobot skills accept <name>`, or reject):");
        for skill in proposals {
            let kind = if skill.improves { "improves" } else { "new" };
            println!("{}  [{kind}] {}  ({})", skill.name, skill.description, skill.path.display());
            if let Some(diff) = crate::skills::proposal_diff(home, &skill.name) {
                print!("{}", crate::tui::ui::render_diff(&diff, 60));
            }
        }
    }
    Ok(())
}

/// `autobot usage [--session ID]`.
pub fn usage(home: &Path, config: &Config, session: Option<&str>) -> Result<(), String> {
    let rows = crate::insights::usage(home, session, &config.prices);
    let rows: Vec<(&str, String)> = rows.iter().map(|(k, v)| (k.as_str(), v.clone())).collect();
    print!("{}", invincible::brand::rows(&rows));
    Ok(())
}

/// `autobot migrate hermes|openclaw [--from DIR] [--dry-run] [--with-secrets]`.
pub async fn migrate(
    home: &Path,
    config: &Config,
    source: &str,
    from: Option<std::path::PathBuf>,
    dry_run: bool,
    with_secrets: bool,
) -> Result<(), String> {
    let source = crate::migrate::Source::parse(source)?;
    let from = from.or_else(|| source.root()).ok_or("HOME is not set; say where with --from")?;
    // The gateway says which models it serves; without it, the model is only named.
    let models = match crate::agent(config, home) {
        Ok(agent) => agent.gateway.models().await.ok(),
        Err(_) => None,
    };
    let options = crate::migrate::Options { dry_run, with_secrets, models, workdir: config.agent.workdir(home) };
    let report = crate::migrate::run(source, &from, home, config, &options)?;
    for line in report.lines {
        println!("{line}");
    }
    if !dry_run {
        println!("\n`autobot memory`, `autobot profile` and `autobot skills` show what came over");
    }
    Ok(())
}

/// `autobot insights [--days N] [--json]`.
pub fn insights(home: &Path, config: &Config, days: u32, json: bool) -> Result<(), String> {
    let report = crate::insights::insights(home, days, &config.prices);
    if json {
        println!("{}", serde_json::to_string_pretty(&report).map_err(|e| e.to_string())?);
        return Ok(());
    }
    let rows = crate::insights::insights_rows(&report);
    let rows: Vec<(&str, String)> = rows.iter().map(|(k, v)| (k.as_str(), v.clone())).collect();
    print!("{}", invincible::brand::rows(&rows));
    Ok(())
}
