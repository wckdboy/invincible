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

/// Whether `skills install` takes [source] from the hub: not a directory here, not a git URL.
pub fn from_hub(source: &str) -> bool {
    let source = source.trim();
    let git = ["https://", "http://", "git@", "ssh://", "file://"].iter().any(|p| source.starts_with(p))
        || source.ends_with(".git");
    let path = source.starts_with(['/', '.', '~']) || crate::config::expand(Path::new(source)).exists();
    !git && !path && !source.is_empty()
}

/// `autobot skills search <query>`.
pub async fn hub_search(query: &str, limit: usize) -> Result<(), String> {
    if query.trim().is_empty() {
        return Err("autobot skills search <what for>".to_owned());
    }
    let hub = crate::hub::Hub::public()?;
    let found = hub.search(query, limit.clamp(1, 50)).await?;
    if found.is_empty() {
        println!("nothing in the hub for {query:?}");
        return Ok(());
    }
    let width = found.iter().map(|f| f.id.chars().count()).max().unwrap_or(0);
    for f in &found {
        let about = if f.description.is_empty() { String::new() } else { format!("  {}", f.description) };
        println!("{:<width$}  {} {}{about}", f.id, f.count, f.what);
    }
    println!(
        "
`autobot skills install <id>` shows a skill in full before it is installed"
    );
    Ok(())
}

/// `autobot skills install <name>` from the hub: fetched, shown, installed on a yes.
pub async fn hub_install(home: &Path, id: &str, yes: bool, force: bool) -> Result<(), String> {
    let hub = crate::hub::Hub::public()?;
    let fetched = hub.fetch(id, &std::env::temp_dir()).await?;
    println!("{}", crate::hub::review(&fetched));
    let question = format!("install {} (instructions the agent will follow)", fetched.name);
    if !confirm(&fetched, &question, yes, force)? {
        println!("not installed");
        return Ok(());
    }
    let (installed, skipped) = crate::hub::install(home, &fetched)?;
    for name in &installed {
        println!("installed {name} in {}", home.join("skills").join(name).display());
    }
    for why in &skipped {
        println!("left out {why}");
    }
    if installed.is_empty() {
        return Err("nothing installed".to_owned());
    }
    Ok(())
}

/// The owner's yes for [fetched]: asked at a terminal, or given with `--yes` (and, for what the
/// scan calls dangerous, `--force`).
fn confirm(fetched: &crate::hub::Fetched, question: &str, yes: bool, force: bool) -> Result<bool, String> {
    if yes {
        if fetched.needs_force() && !force {
            return Err(format!(
                "not done: the scan calls {} dangerous ({}); read it at {}, then add --force if you trust it",
                fetched.name,
                fetched.trust().label(),
                fetched.url
            ));
        }
        return Ok(true);
    }
    if !std::io::IsTerminal::is_terminal(&std::io::stdin()) {
        return Err(format!("not done: read it at {}, then run again with --yes", fetched.url));
    }
    let mut prompt = crate::setup::Prompt::new(std::io::stdin().lock());
    prompt.yes(question, false)
}

/// `autobot skills check [name]`.
pub async fn hub_check(home: &Path, name: Option<&str>) -> Result<(), String> {
    let hub = crate::hub::Hub::public();
    let checked = crate::hub::check(hub.as_ref().map_err(String::as_str), home, name).await?;
    if checked.is_empty() {
        println!("no skills yet");
        return Ok(());
    }
    print!("{}", check_rows(&checked));
    if checked.iter().any(|c| matches!(c.status, crate::hub::Status::Changed(_))) {
        println!("\n`autobot skills update` shows what changes before it replaces anything");
    }
    Ok(())
}

/// What `skills check` prints: a skill a line.
pub fn check_rows(checked: &[crate::hub::Checked]) -> String {
    use crate::hub::Status;
    let width = checked.iter().map(|c| c.name.chars().count()).max().unwrap_or(0);
    let mut out = String::new();
    for c in checked {
        let status = match &c.status {
            Status::Current => "up to date".to_owned(),
            Status::Changed(rev) => format!("update available ({})", &rev[..rev.len().min(7)]),
            Status::Gone => "gone from its source".to_owned(),
            Status::Unpinned => "local (not from the hub)".to_owned(),
            Status::Failed(why) => format!("could not check: {why}"),
        };
        let edited = if c.modified { "; edited here" } else { "" };
        let from =
            c.source.as_ref().map(|s| format!("  {} @ {}", s.id, &s.rev[..s.rev.len().min(7)])).unwrap_or_default();
        out.push_str(&format!("{:<width$}  {status}{edited}  [{}]{from}\n", c.name, c.trust.label()));
    }
    out
}

/// `autobot skills update [name] [--yes] [--force]`.
pub async fn hub_update(home: &Path, name: Option<&str>, yes: bool, force: bool) -> Result<(), String> {
    let hub = crate::hub::Hub::public();
    let checked = crate::hub::check(hub.as_ref().map_err(String::as_str), home, name).await?;
    let due: Vec<&crate::hub::Checked> =
        checked.iter().filter(|c| matches!(c.status, crate::hub::Status::Changed(_))).collect();
    if let Some(one) = name
        && let Some(c) = checked.first()
        && due.is_empty()
    {
        return match &c.status {
            crate::hub::Status::Unpinned => Err(format!("{one} is not from the hub: nothing to update it from")),
            crate::hub::Status::Failed(why) => Err(why.clone()),
            crate::hub::Status::Gone => Err(format!("{one} is gone from its source")),
            _ => {
                println!("{one} is up to date");
                Ok(())
            }
        };
    }
    if due.is_empty() {
        println!("every skill from the hub is up to date");
        return Ok(());
    }
    let mut failed = Vec::new();
    for c in due {
        let Some(pin) = &c.source else { continue };
        let result: Result<bool, String> = async {
            let fetched = hub.as_ref().map_err(Clone::clone)?.fetch(&pin.id, &std::env::temp_dir()).await?;
            println!("{}", crate::hub::changes(home, &c.name, &fetched));
            println!("{}", crate::hub::guard(&fetched));
            if c.modified {
                println!("  {} was edited here since it was installed: updating replaces those edits\n", c.name);
                if yes && !force {
                    println!("left {} alone (edited here; add --force, or update it without --yes)", c.name);
                    return Ok(false);
                }
            }
            if !confirm(&fetched, &format!("update {}", c.name), yes, force)? {
                return Ok(false);
            }
            crate::hub::update(home, &c.name, &fetched)?;
            Ok(true)
        }
        .await;
        match result {
            Ok(true) => println!("updated {}", c.name),
            Ok(false) => println!("not updated: {}", c.name),
            Err(e) => {
                println!("{}: {e}", c.name);
                failed.push(c.name.clone());
            }
        }
    }
    if failed.is_empty() { Ok(()) } else { Err(format!("not updated: {}", failed.join(", "))) }
}

/// `autobot skills audit [name]`.
pub fn skills_audit(home: &Path, name: Option<&str>) -> Result<(), String> {
    let out = audit_report(home, name)?;
    print!("{out}");
    Ok(())
}

/// What `skills audit` prints: each skill's trust level and findings.
pub fn audit_report(home: &Path, name: Option<&str>) -> Result<String, String> {
    let skills: Vec<crate::skills::Skill> =
        crate::skills::list(home).into_iter().filter(|s| name.is_none_or(|n| s.name == n)).collect();
    if let Some(name) = name
        && skills.is_empty()
    {
        return Err(format!("there is no skill {name:?}"));
    }
    if skills.is_empty() {
        return Ok("no skills yet\n".to_owned());
    }
    let mut out = String::new();
    for skill in skills {
        let pin = crate::hub::source(home, &skill.name);
        let trust = crate::guard::Trust::of(pin.as_ref().map(|p| p.owner.as_str()));
        let findings = crate::guard::audit(skill.dir().unwrap_or(&skill.path));
        let from = pin.map(|p| format!("  {}", p.id)).unwrap_or_default();
        out.push_str(&format!("{}{from}\n{}", skill.name, crate::guard::report(trust, &findings, 30)));
    }
    Ok(out)
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
