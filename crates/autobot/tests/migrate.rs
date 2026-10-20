//! `autobot migrate`: a Hermes Agent and an OpenClaw home, made up here, brought over into an
//! Autobot home; nothing overwritten, no secrets unless asked, and a dry run changes nothing.

use std::path::{Path, PathBuf};

use autobot::config::Config;
use autobot::migrate::{Options, Source, run};

fn temp(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("autobot-migrate-{name}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

fn write(path: &Path, text: &str) {
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    std::fs::write(path, text).unwrap();
}

fn options(home: &Path, dry_run: bool, with_secrets: bool) -> Options {
    Options {
        dry_run,
        with_secrets,
        models: Some(vec!["claude-sonnet-4".into(), "qwen3".into()]),
        workdir: home.join("work"),
    }
}

/// Every file under [dir], relative, sorted.
fn files(dir: &Path) -> Vec<String> {
    let mut out = Vec::new();
    fn walk(base: &Path, dir: &Path, out: &mut Vec<String>) {
        for e in std::fs::read_dir(dir).into_iter().flatten().flatten() {
            if e.path().is_dir() {
                walk(base, &e.path(), out);
            } else {
                out.push(e.path().strip_prefix(base).unwrap().display().to_string());
            }
        }
    }
    walk(dir, dir, &mut out);
    out.sort();
    out
}

#[test]
fn a_hermes_home_comes_over() {
    let root = temp("hermes");
    let (hermes, home) = (root.join("hermes"), root.join("autobot"));
    std::fs::create_dir_all(&home).unwrap();
    write(&hermes.join("SOUL.md"), "You are dry, exact and kind.\n");
    write(
        &hermes.join("memories/MEMORY.md"),
        "The build box is called forge§Backups run at 02:00§the deploy token is ghp_abcdefghijklmnopqrstuvwxyz0123\n",
    );
    write(&hermes.join("memories/USER.md"), "Prefers terse answers§Works in Rust and Kotlin");
    write(
        &hermes.join("skills/devops/deploy/SKILL.md"),
        "---\nname: deploy\ndescription: Deploy the site\n---\nRun the deploy script.\n",
    );
    write(&hermes.join("skills/devops/deploy/scripts/go.sh"), "echo go\n");
    write(
        &hermes.join("config.yaml"),
        "model:\n  default: anthropic/claude-sonnet-4\n  provider: anthropic\nterminal:\n  timeout: 300\ncommand_allowlist:\n  - git status\n  - rm -rf *\n",
    );
    write(&hermes.join(".env"), "ANTHROPIC_API_KEY=sk-ant-fake-key-for-tests\nTELEGRAM_BOT_TOKEN=123:fake\n");
    let config = Config::parse("[approvals]\nallow = [\"ls\"]").unwrap();

    // A dry run says what it would do and changes nothing.
    let report = run(Source::Hermes, &hermes, &home, &config, &options(&home, true, true)).unwrap();
    assert!(report.lines[0].ends_with("(dry run: nothing is changed)"));
    assert!(report.lines.iter().any(|l| l.starts_with("SOUL.md: would keep it")), "{:?}", report.lines);
    assert!(report.lines.iter().any(
        |l| *l == "skills in ".to_owned() + &hermes.join("skills").display().to_string() + ": would install deploy"
    ));
    assert!(files(&home).is_empty(), "{:?}", files(&home));

    let report = run(Source::Hermes, &hermes, &home, &config, &options(&home, false, false)).unwrap();
    let text = report.lines.join("\n");
    assert_eq!(autobot::personality::soul(&home).unwrap(), "You are dry, exact and kind.");
    let facts: Vec<String> = autobot::memory::Memory::new(&home).list().into_iter().map(|f| f.text).collect();
    assert_eq!(facts, ["The build box is called forge", "Backups run at 02:00"], "never a secret");
    assert!(text.contains("memory: keep 2 facts, 1 left out (secrets or personal data)"), "{text}");
    assert_eq!(autobot::profile::entries(&home), ["Prefers terse answers", "Works in Rust and Kotlin"]);
    assert_eq!(autobot::skills::read_with(&home, "deploy", Some("scripts/go.sh")).unwrap(), "echo go\n");
    let saved = Config::load(&home.join("config.toml")).unwrap();
    assert_eq!(saved.approvals.allow, ["ls", "git status"], "a pattern is not a command");
    assert!(text.contains("left out rm -rf *"), "{text}");
    assert_eq!(saved.gateway.model, "claude-sonnet-4");
    assert_eq!(saved.agent.command_timeout, 300);
    assert!(text.contains("keys: found ANTHROPIC_API_KEY, TELEGRAM_BOT_TOKEN (not copied"), "{text}");
    assert!(!home.join("telegram.token").exists() && !home.join("secrets").exists());

    // Again, with the secrets: known things are not doubled, keys go into 0600 files.
    let saved = Config::load(&home.join("config.toml")).unwrap();
    let report = run(Source::Hermes, &hermes, &home, &saved, &options(&home, false, true)).unwrap();
    let text = report.lines.join("\n");
    assert!(text.contains("memory: keep 0 facts, 2 known already"), "{text}");
    assert_eq!(autobot::memory::Memory::new(&home).list().len(), 2);
    assert!(text.contains("SOUL.md: there is one here already; keep theirs as the personality hermes"), "{text}");
    let key = home.join("secrets/anthropic.key");
    assert_eq!(std::fs::read_to_string(&key).unwrap(), "sk-ant-fake-key-for-tests\n");
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(std::fs::metadata(&key).unwrap().permissions().mode() & 0o777, 0o600);
    }
    assert!(text.contains("invincible cloud add anthropic --key-stdin <"), "{text}");
    assert_eq!(std::fs::read_to_string(home.join("telegram.token")).unwrap(), "123:fake\n");
    assert_eq!(Config::load(&home.join("config.toml")).unwrap().approvals.allow, ["ls", "git status"]);
    std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn an_openclaw_home_comes_over() {
    let root = temp("openclaw");
    let (claw, home) = (root.join("openclaw"), root.join("autobot"));
    std::fs::create_dir_all(home.join("work")).unwrap();
    write(&claw.join("workspace/SOUL.md"), "Warm and brief.");
    write(&claw.join("workspace/MEMORY.md"), "# Memory\n\n- Uses a Pixel phone\n- Lives near the coast\n");
    write(&claw.join("workspace/memory/2026-10-01.md"), "- Started the Nightfall rewrite\n");
    write(&claw.join("workspace/USER.md"), "# User\n\n- Likes tables over prose\n");
    write(&claw.join("workspace/AGENTS.md"), "Always run the tests.");
    write(&claw.join("skills/weather/SKILL.md"), "---\nname: weather\ndescription: The forecast\n---\nAsk wttr.in.");
    write(
        &claw.join("openclaw.json"),
        r#"{"agents": {"defaults": {"model": {"primary": "deepseek/deepseek-chat"}}}, "tools": {"exec": {"timeoutSec": 90}}}"#,
    );
    write(&claw.join("exec-approvals.json"), r#"{"agents": {"main": {"allowlist": [{"pattern": "npm test"}]}}}"#);
    let config = Config::parse("").unwrap();
    let report = run(Source::OpenClaw, &claw, &home, &config, &options(&home, false, false)).unwrap();
    let text = report.lines.join("\n");
    assert_eq!(autobot::personality::soul(&home).unwrap(), "Warm and brief.");
    let facts: Vec<String> = autobot::memory::Memory::new(&home).list().into_iter().map(|f| f.text).collect();
    assert_eq!(facts, ["Uses a Pixel phone", "Lives near the coast", "Started the Nightfall rewrite"]);
    assert_eq!(autobot::profile::entries(&home), ["Likes tables over prose"]);
    assert_eq!(std::fs::read_to_string(home.join("work/AGENTS.md")).unwrap(), "Always run the tests.");
    assert!(autobot::skills::find(&home, "weather").is_some());
    let saved = Config::load(&home.join("config.toml")).unwrap();
    assert_eq!(saved.approvals.allow, ["npm test"]);
    assert_eq!(saved.agent.command_timeout, 90);
    assert_eq!(saved.gateway.model, "auto", "a model the gateway does not serve is only named");
    assert!(
        text.contains("model: deepseek/deepseek-chat is not on the gateway; add it (`invincible cloud add deepseek`)"),
        "{text}"
    );
    assert!(run(Source::OpenClaw, &root.join("nope"), &home, &config, &options(&home, true, false)).is_err());
    assert!(Source::parse("chatgpt").is_err());
    std::fs::remove_dir_all(root).unwrap();
}
