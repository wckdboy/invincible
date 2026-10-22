//! `invincible doctor`: what this node is missing, in the order that breaks it.
//!
//! The checks are deliberately readable by someone who has never seen the code: one line per
//! subsystem, the state as a glyph, and what to do about it. Two rules shape it:
//!
//! - **A doctor never creates state.** No key is generated, no token written, no config saved: it is
//!   safe to run on a fresh install, on a machine that is serving, and on one that is broken.
//! - **Absent is not the same as broken.** A missing config, token or receipt key on a machine that
//!   has not been started yet is a `!` with the command that creates it, never a `✗`. A `✗` means
//!   something that was configured cannot work.

use std::path::{Path, PathBuf};
use std::process::Command;

use serde_json::{Value, json};

use crate::brand;
use crate::config::Config;
use crate::devices::{KnownNodes, StaticKey, fingerprint};
use crate::fsutil;

#[derive(Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Debug)]
pub enum State {
    Ok,
    Warn,
    Fail,
}

impl State {
    pub fn name(self) -> &'static str {
        match self {
            State::Ok => "ok",
            State::Warn => "warn",
            State::Fail => "fail",
        }
    }

    fn line(self, text: &str) -> String {
        match self {
            State::Ok => brand::ok(text),
            State::Warn => brand::warn(text),
            State::Fail => brand::fail(text),
        }
    }
}

#[derive(Clone, Debug)]
pub struct Check {
    /// The subsystem, one word: `home`, `config`, `engine`, `models`, `cluster`, ...
    pub name: &'static str,
    pub state: State,
    /// What was found, in plain words.
    pub detail: String,
    /// What to do about it, when there is something to do.
    pub fix: Option<String>,
}

impl Check {
    pub fn ok(name: &'static str, detail: impl Into<String>) -> Self {
        Self { name, state: State::Ok, detail: detail.into(), fix: None }
    }

    pub fn warn(name: &'static str, detail: impl Into<String>, fix: Option<&str>) -> Self {
        Self { name, state: State::Warn, detail: detail.into(), fix: fix.map(str::to_owned) }
    }

    pub fn fail(name: &'static str, detail: impl Into<String>, fix: Option<&str>) -> Self {
        Self { name, state: State::Fail, detail: detail.into(), fix: fix.map(str::to_owned) }
    }
}

pub struct Report {
    pub checks: Vec<Check>,
}

impl Report {
    pub fn new(checks: Vec<Check>) -> Self {
        Self { checks }
    }

    /// The worst state any check reached.
    pub fn worst(&self) -> State {
        self.checks.iter().map(|c| c.state).max().unwrap_or(State::Ok)
    }

    /// (ok, warn, fail)
    pub fn counts(&self) -> (usize, usize, usize) {
        let by = |state: State| self.checks.iter().filter(|c| c.state == state).count();
        (by(State::Ok), by(State::Warn), by(State::Fail))
    }

    /// 1 when a configured thing cannot work, 0 otherwise (warnings are not failures).
    pub fn exit_code(&self) -> u8 {
        if self.worst() == State::Fail { 1 } else { 0 }
    }

    /// The report as a person reads it: one line per check, the fix under the ones that need it.
    pub fn report(&self) -> String {
        let width = self.checks.iter().map(|c| c.name.len()).max().unwrap_or(0);
        let mut out = String::new();
        for check in &self.checks {
            out.push_str(&check.state.line(&format!("{:<width$}  {}", check.name, check.detail)));
            out.push('\n');
            if let Some(fix) = &check.fix {
                out.push_str(&format!("{} {}\n", " ".repeat(width), brand::faint(fix)));
            }
        }
        let (ok, warn, fail) = self.counts();
        out.push('\n');
        if fail > 0 {
            out.push_str(&format!("  {ok} ok, {warn} to look at, {fail} failed\n"));
        } else if warn > 0 {
            out.push_str(&format!("  {ok} ok, {warn} to look at, nothing broken\n"));
        } else {
            out.push_str(&format!("  {ok} checks, all clear\n"));
        }
        out
    }

    pub fn json(&self) -> Value {
        let (ok, warn, fail) = self.counts();
        json!({
            "checks": self.checks.iter().map(|c| json!({
                "name": c.name,
                "state": c.state.name(),
                "detail": c.detail,
                "fix": c.fix,
            })).collect::<Vec<_>>(),
            "ok": ok,
            "warn": warn,
            "fail": fail,
            "exit": self.exit_code(),
        })
    }
}

/// Runs every check. Reads only; creates nothing.
pub fn run(home: &Path, config_path: Option<&Path>) -> Report {
    let mut checks = Vec::new();
    let config_path = config_path.map(|p| p.to_path_buf()).unwrap_or_else(|| home.join("config.toml"));

    checks.push(check_home(home));

    match check_config(&config_path) {
        Ok(cfg) => {
            let cloud = if cfg.cloud.is_empty() { String::new() } else { format!(", {} cloud", cfg.cloud.len()) };
            checks.push(Check::ok(
                "config",
                format!("{} parses ({} models{cloud})", config_path.display(), cfg.models.len()),
            ));
            checks.extend(check_node_state(home, &cfg));
        }
        // A missing config is a fresh install: `serve` would run on the defaults, so the machine
        // checks below describe what it would actually do.
        Err((State::Warn, detail, fix)) => {
            checks.push(Check { name: "config", state: State::Warn, detail, fix });
            checks.extend(check_node_state(home, &Config::parse("").expect("the defaults parse")));
        }
        // A config that does not parse is different: `serve` would refuse to start, so reporting
        // the defaults as this node's links, models or capacity would be inventing a machine.
        Err((state, detail, fix)) => {
            checks.push(Check { name: "config", state, detail, fix });
            checks.push(Check::warn(
                "rest",
                "the other checks read the config, so they did not run",
                Some("fix the line above: `invincible serve` reads this file the same way"),
            ));
        }
    }

    Report::new(checks)
}

fn check_home(home: &Path) -> Check {
    if !home.exists() {
        return Check::warn(
            "home",
            format!("{} does not exist yet", home.display()),
            Some("it is created on first use: `invincible serve`, `invincible token`"),
        );
    }
    let probe = home.join(".doctor-write-probe");
    match fsutil::create_private(&probe, "probe\n") {
        Ok(()) => {
            let _ = std::fs::remove_file(&probe);
            Check::ok("home", format!("{} is writable", home.display()))
        }
        Err(e) => Check::fail(
            "home",
            format!("{} cannot be written: {e}", home.display()),
            Some("the node keeps its keys, token and logs there: fix the permissions or set INVINCIBLE_HOME"),
        ),
    }
}

/// `Ok(config)`, or the failed check's parts.
fn check_config(path: &Path) -> Result<Config, (State, String, Option<String>)> {
    match fsutil::read_optional(path) {
        Ok(None) => Err((
            State::Warn,
            format!("{} is not there: a fresh install runs on the defaults", path.display()),
            Some("`invincible model add` writes the first model; the defaults are otherwise fine".to_owned()),
        )),
        Ok(Some(text)) => Config::parse(&text).map_err(|e| {
            (
                State::Fail,
                format!("{}: {e}", path.display()),
                Some("fix the line named above; `invincible doctor` will not touch it for you".to_owned()),
            )
        }),
        Err(e) => Err((State::Fail, format!("{}: {e}", path.display()), None)),
    }
}

fn check_node_state(home: &Path, cfg: &Config) -> Vec<Check> {
    let mut checks = Vec::new();

    // --- the token the API is behind ---------------------------------------------------------
    let token = home.join("token");
    if token.exists() {
        match mode_of(&token) {
            Some(mode) if mode & 0o077 != 0 => checks.push(Check::warn(
                "token",
                format!("{} is readable by others (mode {:o})", token.display(), mode),
                Some(&format!("chmod 600 {}", token.display())),
            )),
            Some(mode) => checks.push(Check::ok("token", format!("{} set, mode {:o}", token.display(), mode))),
            None => checks.push(Check::ok("token", format!("{} present", token.display()))),
        }
    } else {
        checks.push(Check::warn("token", "no API token yet: the first `invincible serve` creates one", None));
    }

    // --- the engine --------------------------------------------------------------------------
    let engine = resolve_program(&cfg.engine.llama_server);
    let probe = engine.as_ref().map(|server| {
        let runtime = tokio::runtime::Runtime::new();
        runtime.map(|rt| rt.block_on(crate::tune::probe(Some(server))))
    });
    match (&engine, &probe) {
        (Some(server), _) => {
            let rpc = probe.as_ref().and_then(|p| p.as_ref().ok()).and_then(|p| p.rpc_backend);
            let shards = match rpc {
                Some(true) => ", built with RPC shards",
                Some(false) => ", no RPC shard support (rebuild llama.cpp with -DGGML_RPC=ON)",
                None => "",
            };
            checks.push(Check::ok("engine", format!("{}{shards}", server.display())));
        }
        (None, _) => checks.push(Check::fail(
            "engine",
            format!("`{}` is not on PATH and not a file", cfg.engine.llama_server.display()),
            Some("install llama.cpp (`brew install llama.cpp`, or your CUDA build) and set [engine] llama_server"),
        )),
    }

    // --- devices -----------------------------------------------------------------------------
    if let Some(Ok(p)) = &probe {
        if p.devices.is_empty() {
            checks.push(Check::warn(
                "devices",
                "no accelerator llama.cpp can use: this machine can answer whole requests, but cannot anchor a shard split",
                Some("spec/cluster.md, Known limits: a split needs a GPU head"),
            ));
        } else {
            let names: Vec<&str> = p.devices.iter().map(|d| d.name.as_str()).collect();
            checks.push(Check::ok("devices", format!("{}, {} cores", names.join(", "), p.cores)));
        }
    }

    // --- models ------------------------------------------------------------------------------
    if cfg.models.is_empty() {
        checks.push(Check::warn(
            "models",
            "no models: every request will be blocked",
            Some("invincible model add <id> --path <file.gguf>"),
        ));
    }
    for model in &cfg.models {
        match std::fs::metadata(&model.path) {
            Ok(meta) if meta.len() == 0 => checks.push(Check::fail(
                "model",
                format!("{} is empty: {}", model.path.display(), model.id),
                Some("re-download it: an empty file is a half-finished copy"),
            )),
            Ok(meta) => {
                let context = model.context.map(|c| format!(", {c} context")).unwrap_or_default();
                let split = if model.cluster.is_empty() {
                    String::new()
                } else {
                    format!(", split across {}", model.cluster.join("+"))
                };
                checks.push(Check::ok(
                    "model",
                    format!(
                        "{} {} ({}{context}{split})",
                        model.id,
                        crate::models::gib(meta.len()),
                        model.path.display()
                    ),
                ));
            }
            Err(e) => checks.push(Check::fail(
                "model",
                format!("{}: {} is not readable ({e})", model.id, model.path.display()),
                Some("check the path in the config; the engine cannot start a model it cannot read"),
            )),
        }
    }

    // --- identity and peers ------------------------------------------------------------------
    match StaticKey::load(&home.join("device.key")) {
        Ok(Some(key)) => checks.push(Check::ok("identity", format!("pairing key {}", fingerprint(&key.public)))),
        Ok(None) => checks.push(Check::warn(
            "identity",
            "no pairing key yet: `invincible serve` creates one",
            Some("pair a device with `invincible pair`, another node with `invincible join <code>`"),
        )),
        Err(e) => checks.push(Check::fail(
            "identity",
            format!("device.key: {e}"),
            Some("delete it and pair again: a corrupt key cannot be repaired"),
        )),
    }
    let peers = KnownNodes::load(home).map(|k| k.0.len()).unwrap_or(0);
    let network = cfg.node.network.as_str();
    if network == "offline" {
        checks.push(Check::warn(
            "links",
            format!("network = \"offline\": this node neither dials nor answers peers ({peers} joined)"),
            Some("set [node] network = \"direct\" on both machines to run a cluster"),
        ));
    } else {
        checks.push(Check::ok("links", format!("network = \"{network}\", {peers} joined node(s)")));
    }

    // --- the cluster contract ----------------------------------------------------------------
    if cfg.cluster.serve {
        checks.push(Check::ok("cluster", format!("serves as a shard for {}", cfg.cluster.heads.join(", "))));
    } else {
        checks.push(Check::ok("cluster", "answers whole requests (not a shard)"));
    }

    let inflight = cfg.node.dispatch_max_inflight;
    if inflight == 0 && !cfg.cluster.serve {
        checks.push(Check::warn(
            "dispatch",
            "max_inflight = 0 but this node is not a shard: nothing will be sent here",
            Some("set [node] dispatch_max_inflight = 1, or [cluster] serve = true if it is a shard"),
        ));
    } else if inflight == 0 {
        checks.push(Check::ok("dispatch", "advertises no capacity: its slots are committed to the split"));
    } else {
        checks.push(Check::ok("dispatch", format!("{inflight} request(s) in flight per model")));
    }

    // --- receipts and the audit log ----------------------------------------------------------
    let receipt_key = home.join("receipt.key");
    match receipt_public(&receipt_key) {
        Some(public) => checks.push(Check::ok("receipts", format!("signing with {}", &public[..16.min(public.len())]))),
        None => checks.push(Check::warn("receipts", "no receipt key yet: the first serve creates one", None)),
    }
    let audit = home.join("audit.jsonl");
    match line_count(&audit) {
        Some(n) if n > 0 => checks.push(Check::ok("audit", format!("{n} entries in {}", audit.display()))),
        Some(_) => checks.push(Check::ok("audit", format!("{} is empty, as a new node's is", audit.display()))),
        None => checks.push(Check::warn("audit", "no audit log yet: the first answered request writes one", None)),
    }

    // --- is it running -----------------------------------------------------------------------
    let listen = cfg.listen;
    let client = crate::engine::health_client();
    let runtime = tokio::runtime::Runtime::new();
    let health = runtime.ok().map(|rt| {
        rt.block_on(async {
            client
                .get(format!("http://{listen}/health"))
                .timeout(std::time::Duration::from_secs(2))
                .send()
                .await
                .map(|r| r.status().is_success())
                .unwrap_or(false)
        })
    });
    match health {
        Some(true) => checks.push(Check::ok("node", format!("answering on http://{listen}"))),
        _ => checks.push(Check::warn("node", format!("not answering on http://{listen}"), Some("invincible serve"))),
    }

    // --- room to work ------------------------------------------------------------------------
    if let Some(free) = free_bytes(home) {
        if free < 2 * 1024 * 1024 * 1024 {
            checks.push(Check::warn(
                "disk",
                format!("{} free under {}", crate::models::gib(free), home.display()),
                Some("a model that does not fit fails at load: move models or free space"),
            ));
        } else {
            checks.push(Check::ok("disk", format!("{} free under {}", crate::models::gib(free), home.display())));
        }
    }

    checks
}

/// A program named without a path is looked up on PATH the way a shell would.
fn resolve_program(program: &Path) -> Option<PathBuf> {
    let text = program.to_string_lossy();
    if text.contains('/') {
        return program.is_file().then(|| program.to_path_buf());
    }
    let path = std::env::var_os("PATH")?;
    std::env::split_paths(&path).map(|dir| dir.join(&*text)).find(|candidate| candidate.is_file())
}

fn mode_of(path: &Path) -> Option<u32> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::metadata(path).ok().map(|m| m.permissions().mode() & 0o777)
    }
    #[cfg(not(unix))]
    {
        let _ = path;
        None
    }
}

/// The receipt public key **without creating one**: a doctor that generated a key would change the
/// node it is inspecting, and the next receipt would name a key nobody had.
fn receipt_public(path: &Path) -> Option<String> {
    use base64::Engine as _;
    let text = fsutil::read_optional(path).ok().flatten()?;
    let seed: [u8; 32] = base64::engine::general_purpose::URL_SAFE_NO_PAD.decode(text.trim()).ok()?.try_into().ok()?;
    Some(crate::receipts::ReceiptKey::from_seed(&seed).public())
}

fn line_count(path: &Path) -> Option<usize> {
    use std::io::BufRead as _;
    let file = std::fs::File::open(path).ok()?;
    Some(std::io::BufReader::new(file).lines().map_while(Result::ok).filter(|l| !l.trim().is_empty()).count())
}

/// Free bytes on the filesystem holding [path], from `df -Pk` (POSIX output).
fn free_bytes(path: &Path) -> Option<u64> {
    let out = Command::new("df").arg("-Pk").arg(path).output().ok()?;
    if !out.status.success() {
        return None;
    }
    let text = String::from_utf8_lossy(&out.stdout);
    let line = text.lines().nth(1)?;
    let kb: u64 = line.split_whitespace().nth(3)?.parse().ok()?;
    Some(kb * 1024)
}

#[cfg(test)]
mod tests {
    use super::{Check, Report, State};

    fn temp_home(tag: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("invincible-doctor-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("temp home");
        dir
    }

    #[test]
    fn a_failure_exits_one_and_a_warning_does_not() {
        let broken = Report::new(vec![Check::ok("home", "fine"), Check::fail("engine", "missing", None)]);
        assert_eq!(broken.exit_code(), 1);
        let warn = Report::new(vec![Check::ok("home", "fine"), Check::warn("config", "fresh", None)]);
        assert_eq!(warn.exit_code(), 0);
        assert_eq!(warn.worst(), State::Warn);
        assert_eq!(Report::new(Vec::new()).exit_code(), 0);
    }

    #[test]
    fn the_report_names_each_state_with_its_glyph() {
        let report = Report::new(vec![
            Check::ok("home", "writable"),
            Check::warn("config", "fresh install", Some("`invincible model add`")),
            Check::fail("engine", "not on PATH", None),
        ]);
        let text = report.report();
        assert!(text.contains("✓ home"), "{text}");
        assert!(text.contains("! config"), "{text}");
        assert!(text.contains("✗ engine"), "{text}");
        assert!(text.contains("`invincible model add`"), "the fix is printed under the check: {text}");
        assert!(text.contains("1 ok, 1 to look at, 1 failed"), "{text}");
    }

    #[test]
    fn the_json_carries_the_state_and_the_fix() {
        let report = Report::new(vec![Check::warn("config", "fresh", Some("model add"))]);
        let json = report.json();
        assert_eq!(json["warn"], 1);
        assert_eq!(json["fail"], 0);
        assert_eq!(json["exit"], 0);
        assert_eq!(json["checks"][0]["name"], "config");
        assert_eq!(json["checks"][0]["state"], "warn");
        assert_eq!(json["checks"][0]["fix"], "model add");
    }

    #[test]
    fn a_fresh_home_warns_about_the_config_and_creates_nothing() {
        let home = temp_home("fresh");
        let report = super::run(&home, None);
        let config = report.checks.iter().find(|c| c.name == "config").expect("a config check");
        assert_eq!(config.state, State::Warn, "a missing config is a fresh install, not a failure");
        let home_check = report.checks.iter().find(|c| c.name == "home").expect("a home check");
        assert_eq!(home_check.state, State::Ok);
        // Reading only: nothing is created by the doctor.
        assert!(!home.join("config.toml").exists());
        assert!(!home.join("receipt.key").exists());
        assert!(!home.join("token").exists());
        let _ = std::fs::remove_dir_all(&home);
    }

    #[test]
    fn a_model_whose_file_is_missing_fails() {
        let home = temp_home("missing-model");
        std::fs::write(home.join("config.toml"), "[[models]]\nid = \"big\"\npath = \"/nonexistent/big.gguf\"\n")
            .expect("config");
        let report = super::run(&home, None);
        let model = report.checks.iter().find(|c| c.name == "model").expect("a model check");
        assert_eq!(model.state, State::Fail);
        assert!(model.detail.contains("/nonexistent/big.gguf"), "{}", model.detail);
        let _ = std::fs::remove_dir_all(&home);
    }

    #[test]
    fn a_shard_that_names_no_head_is_a_config_failure_and_nothing_else_is_invented() {
        let home = temp_home("no-heads");
        std::fs::write(
            home.join("config.toml"),
            "[[models]]\nid = \"small\"\npath = \"/nonexistent/s.gguf\"\n\n\
             [remote]\nname = \"lab-peer\"\nlisten = [\"0.0.0.0:7778\"]\nadvertise = [\"10.0.1.2:7778\"]\n\n\
             [cluster]\nserve = true\n",
        )
        .expect("config");
        let report = super::run(&home, None);
        // The parser is the guard: `serve` without `heads` is refused when the file is read, so the
        // doctor reports it there rather than pretending it has a node to inspect.
        let config = report.checks.iter().find(|c| c.name == "config").expect("a config check");
        assert_eq!(config.state, State::Fail);
        assert!(config.detail.contains("heads"), "{}", config.detail);
        assert_eq!(report.exit_code(), 1);
        assert!(report.checks.iter().all(|c| c.name != "links"), "no link advice from a config that did not parse");
        let _ = std::fs::remove_dir_all(&home);
    }

    #[test]
    fn an_offline_network_is_called_out_for_what_it_is() {
        let home = temp_home("offline");
        std::fs::write(home.join("config.toml"), "[node]\nnetwork = \"offline\"\n").expect("config");
        let report = super::run(&home, None);
        let links = report.checks.iter().find(|c| c.name == "links").expect("a links check");
        assert_eq!(links.state, State::Warn);
        assert!(links.detail.contains("offline"), "{}", links.detail);
        let _ = std::fs::remove_dir_all(&home);
    }
}
