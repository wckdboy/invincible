//! Health alerts to the owner, on a channel the bots already use (`[alerts]`).
//!
//! While `autobot serve` runs, it tells the owner when: it was started again after stopping
//! without shutting down (a crash, the watchdog, a kill), the gateway stops answering, a model
//! backend goes unhealthy, the disk runs low, a scheduled task, the heartbeat or a backup fails,
//! and when an update is available or was applied. Each alert has a key: the same one again is
//! not sent within `repeat`, at most `per_hour` go in an hour, a problem that goes away says so
//! (only when it was sent), and in quiet hours they wait and go together when those end.
//! State (what was sent, what waits, whether serve shut down cleanly) is in
//! `$AUTOBOT_HOME/alerts.json`.

use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};
use std::sync::{Arc, OnceLock};
use std::time::Duration;

use chrono::{DateTime, Local, Timelike};
use serde::{Deserialize, Serialize};

use crate::bots::Runtime;

/// ```toml
/// [alerts]
/// to = ["telegram:123456", "email:me@example.org"]  # [default: the home channel, /sethome]
/// events = ["crash", "gateway", "backend", "disk", "job", "backup", "update"]  # [default: all]
/// quiet_hours = "23:00-07:00"   # held, then sent together
/// repeat = "6h"                 # the same alert again no sooner
/// per_hour = 10                 # at most this many an hour
/// disk_free_gib = 2             # alert under this much free space (0: off)
/// update_check = "1d"           # how often to look for a new release ("off")
/// ```
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct AlertsConfig {
    #[serde(default = "yes")]
    pub enabled: bool,
    #[serde(default)]
    pub to: Vec<String>,
    #[serde(default)]
    pub events: Option<Vec<String>>,
    #[serde(default)]
    pub quiet_hours: Option<String>,
    #[serde(default = "repeat")]
    pub repeat: String,
    #[serde(default = "per_hour")]
    pub per_hour: usize,
    #[serde(default = "disk_free_gib")]
    pub disk_free_gib: u64,
    #[serde(default = "update_check")]
    pub update_check: String,
}

fn yes() -> bool {
    true
}
fn repeat() -> String {
    "6h".to_owned()
}
fn per_hour() -> usize {
    10
}
fn disk_free_gib() -> u64 {
    2
}
fn update_check() -> String {
    "1d".to_owned()
}

impl Default for AlertsConfig {
    fn default() -> Self {
        Self {
            enabled: true,
            to: Vec::new(),
            events: None,
            quiet_hours: None,
            repeat: repeat(),
            per_hour: per_hour(),
            disk_free_gib: disk_free_gib(),
            update_check: update_check(),
        }
    }
}

/// What an alert is about.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub enum Kind {
    Crash,
    Gateway,
    Backend,
    Disk,
    Job,
    Backup,
    Update,
    /// `autobot alerts test`: always sent.
    Test,
}

pub const KINDS: &[(&str, Kind)] = &[
    ("crash", Kind::Crash),
    ("gateway", Kind::Gateway),
    ("backend", Kind::Backend),
    ("disk", Kind::Disk),
    ("job", Kind::Job),
    ("backup", Kind::Backup),
    ("update", Kind::Update),
];

impl Kind {
    pub fn name(self) -> &'static str {
        KINDS.iter().find(|(_, k)| *k == self).map_or("test", |(n, _)| n)
    }
}

/// One alert, or (with [Alert::clear]) the news that its problem went away.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Alert {
    pub kind: Kind,
    /// The same problem has the same key (`gateway`, `backend:qwen3`, `job:a1b2`).
    pub key: String,
    pub text: String,
    pub clear: bool,
    /// Addresses already told (a failed task's own answer went there).
    pub except: Vec<String>,
}

impl Alert {
    pub fn new(kind: Kind, key: &str, text: impl Into<String>) -> Self {
        Self { kind, key: key.to_owned(), text: text.into(), clear: false, except: Vec::new() }
    }

    pub fn cleared(kind: Kind, key: &str, text: impl Into<String>) -> Self {
        Self { kind, key: key.to_owned(), text: text.into(), clear: true, except: Vec::new() }
    }

    pub fn except(mut self, addresses: Vec<String>) -> Self {
        self.except = addresses;
        self
    }
}

/// [AlertsConfig], checked.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Policy {
    pub enabled: bool,
    pub events: Option<BTreeSet<Kind>>,
    /// Minutes after midnight: from, to.
    pub quiet: Option<(u32, u32)>,
    pub repeat: Duration,
    pub per_hour: usize,
}

impl AlertsConfig {
    pub fn policy(&self) -> Result<Policy, String> {
        let events = match &self.events {
            None => None,
            Some(names) => Some(
                names
                    .iter()
                    .map(|n| {
                        KINDS.iter().find(|(k, _)| k == n).map(|(_, k)| *k).ok_or_else(|| {
                            let all: Vec<&str> = KINDS.iter().map(|(n, _)| *n).collect();
                            format!("[alerts] events: {n:?} is not one of {}", all.join(", "))
                        })
                    })
                    .collect::<Result<BTreeSet<Kind>, String>>()?,
            ),
        };
        let quiet = self.quiet_hours.as_deref().map(quiet_hours).transpose()?;
        let repeat =
            interval(&self.repeat).map_err(|_| format!("[alerts] repeat = {:?}: like 6h or 30m", self.repeat))?;
        Ok(Policy { enabled: self.enabled, events, quiet, repeat, per_hour: self.per_hour.max(1) })
    }

    /// How often to look for an update; None when off.
    pub fn update_every(&self) -> Result<Option<Duration>, String> {
        if self.update_check.trim() == "off" {
            return Ok(None);
        }
        interval(&self.update_check)
            .map(|d| Some(d.max(Duration::from_secs(3600))))
            .map_err(|_| format!("[alerts] update_check = {:?}: like 1d or 12h, or off", self.update_check))
    }
}

fn interval(text: &str) -> Result<Duration, String> {
    match crate::cron::When::parse(&format!("every {}", text.trim()))? {
        crate::cron::When::Every(d) => Ok(d),
        _ => Err("not an interval".to_owned()),
    }
}

/// `23:00-07:00` → minutes after midnight.
pub fn quiet_hours(text: &str) -> Result<(u32, u32), String> {
    let bad = || format!("[alerts] quiet_hours = {text:?}: like \"23:00-07:00\"");
    let (from, to) = text.split_once('-').ok_or_else(bad)?;
    let minute = |t: &str| -> Option<u32> {
        let (h, m) = t.trim().split_once(':')?;
        let (h, m): (u32, u32) = (h.parse().ok()?, m.parse().ok()?);
        (h < 24 && m < 60).then_some(h * 60 + m)
    };
    Ok((minute(from).ok_or_else(bad)?, minute(to).ok_or_else(bad)?))
}

impl Policy {
    pub fn quiet_at(&self, now: DateTime<Local>) -> bool {
        let Some((from, to)) = self.quiet else { return false };
        let m = now.hour() * 60 + now.minute();
        match from.cmp(&to) {
            std::cmp::Ordering::Less => from <= m && m < to,
            std::cmp::Ordering::Greater => m >= from || m < to,
            std::cmp::Ordering::Equal => false,
        }
    }
}

/// What has been sent and what waits: `$AUTOBOT_HOME/alerts.json`.
#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq, Eq)]
pub struct State {
    /// When each key was last sent.
    #[serde(default)]
    pub last: BTreeMap<String, i64>,
    /// Problems sent and not yet gone.
    #[serde(default)]
    pub open: BTreeSet<String>,
    /// Waiting for quiet hours to end.
    #[serde(default)]
    pub held: Vec<Held>,
    /// When messages went, the last hour's.
    #[serde(default)]
    pub sent: Vec<i64>,
    /// Alerts the hourly limit kept back since the last message.
    #[serde(default)]
    pub dropped: usize,
    /// The latest alerts and what became of them, newest last.
    #[serde(default)]
    pub log: Vec<Logged>,
    #[serde(default)]
    pub serve: Option<Serve>,
    /// The newest release an alert said is available.
    #[serde(default)]
    pub update_seen: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct Held {
    pub key: String,
    pub text: String,
    pub at: i64,
    /// [Kind::name] (empty: not known, from an older state).
    #[serde(default)]
    pub kind: String,
    /// Addresses not to send it to ([Alert::except]).
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub except: Vec<String>,
}

impl Held {
    fn of(alert: &Alert, key: String, at: i64) -> Self {
        Self { key, text: alert.text.clone(), at, kind: alert.kind.name().to_owned(), except: alert.except.clone() }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct Logged {
    pub at: i64,
    pub kind: String,
    pub key: String,
    pub text: String,
    pub outcome: String,
}

/// The running `autobot serve`.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct Serve {
    pub pid: u32,
    pub started: i64,
    pub version: String,
    /// False once it shut down cleanly.
    pub running: bool,
}

const LOG: usize = 50;

impl State {
    pub fn path(root: &Path) -> PathBuf {
        root.join("alerts.json")
    }

    pub fn load(root: &Path) -> Self {
        std::fs::read_to_string(Self::path(root)).ok().and_then(|t| serde_json::from_str(&t).ok()).unwrap_or_default()
    }

    pub fn save(&self, root: &Path) -> Result<(), String> {
        let text = serde_json::to_string_pretty(self).map_err(|e| e.to_string())?;
        invincible::fsutil::replace_private(&Self::path(root), &text)
    }

    fn note(&mut self, alert: &Alert, at: i64, outcome: &str) {
        self.log.push(Logged {
            at,
            kind: alert.kind.name().to_owned(),
            key: alert.key.clone(),
            text: alert.text.chars().take(400).collect(),
            outcome: outcome.to_owned(),
        });
        let extra = self.log.len().saturating_sub(LOG);
        self.log.drain(..extra);
    }
}

/// What to do with an alert.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Decision {
    /// Send this text now.
    Send(String),
    /// Quiet hours: it waits.
    Hold,
    /// Not sent, and why.
    Skip(&'static str),
}

/// A clearing of what was never sent.
pub const NOTHING_SENT: &str = "nothing was sent about it";

/// Decides about [alert] at [now] under [policy], updating [state] as if it was sent.
pub fn decide(state: &mut State, policy: &Policy, alert: &Alert, now: DateTime<Local>) -> Decision {
    let t = now.timestamp();
    let decision = decide_inner(state, policy, alert, now);
    let outcome = match &decision {
        Decision::Send(_) => "sent",
        Decision::Hold => "held for quiet hours",
        // The usual "it worked" of a task or a check: not worth a line.
        Decision::Skip(NOTHING_SENT) => return decision,
        Decision::Skip(why) => why,
    };
    state.note(alert, t, outcome);
    decision
}

fn decide_inner(state: &mut State, policy: &Policy, alert: &Alert, now: DateTime<Local>) -> Decision {
    let t = now.timestamp();
    if alert.kind == Kind::Test {
        state.sent.push(t);
        return Decision::Send(alert.text.clone());
    }
    if !policy.enabled {
        return Decision::Skip("alerts are off");
    }
    if policy.events.as_ref().is_some_and(|e| !e.contains(&alert.kind)) {
        return Decision::Skip("not one of [alerts] events");
    }
    if alert.clear {
        if let Some(at) = state.held.iter().position(|h| h.key == alert.key) {
            state.held.remove(at);
            return Decision::Skip("gone before it was sent");
        }
        if !state.open.remove(&alert.key) {
            return Decision::Skip(NOTHING_SENT);
        }
    } else {
        if let Some(held) = state.held.iter_mut().find(|h| h.key == alert.key) {
            held.text = alert.text.clone();
            held.except = alert.except.clone();
            return Decision::Hold;
        }
        let repeat = policy.repeat.as_secs() as i64;
        if state.last.get(&alert.key).is_some_and(|last| t - last < repeat) {
            return Decision::Skip("sent lately");
        }
    }
    if policy.quiet_at(now) {
        // A clearing's alert was sent; that it is over can wait too.
        state.held.push(Held::of(alert, held_key(alert), t));
        return Decision::Hold;
    }
    state.sent.retain(|at| t - at < 3600);
    if state.sent.len() >= policy.per_hour {
        state.dropped += 1;
        return Decision::Skip("over the hourly limit");
    }
    state.sent.push(t);
    if !alert.clear {
        state.last.insert(alert.key.clone(), t);
        state.open.insert(alert.key.clone());
    }
    let mut text = if alert.clear { format!("✅ {}", alert.text) } else { format!("⚠️ {}", alert.text) };
    if state.dropped > 0 {
        text.push_str(&format!("\n({} more alert(s) were held back by the hourly limit)", state.dropped));
        state.dropped = 0;
    }
    Decision::Send(text)
}

/// How long an alert waits, for quiet hours to end or a channel to take it, before it is dropped.
const HELD_FOR: i64 = 2 * 86400;

/// The key [alert] waits under (a clearing has its own).
fn held_key(alert: &Alert) -> String {
    if alert.clear { format!("{}:cleared", alert.key) } else { alert.key.clone() }
}

/// What waited (quiet hours, a channel that failed), once it may go: one message for each of
/// [targets], without what it is not to go to; [state] updated as if they were sent. Alerts the
/// policy no longer wants, or that waited too long, are dropped.
pub fn flush(state: &mut State, policy: &Policy, targets: &[String], now: DateTime<Local>) -> Vec<(String, String)> {
    if state.held.is_empty() || policy.quiet_at(now) || targets.is_empty() {
        return Vec::new();
    }
    let t = now.timestamp();
    let held: Vec<Held> = std::mem::take(&mut state.held)
        .into_iter()
        .filter(|h| {
            let kind = KINDS.iter().find(|(n, _)| *n == h.kind).map(|(_, k)| *k);
            let wanted = policy.enabled
                && kind.is_none_or(|k| policy.events.as_ref().is_none_or(|e| e.contains(&k)))
                && t - h.at < HELD_FOR;
            if !wanted {
                state.log.push(Logged {
                    at: t,
                    kind: h.kind.clone(),
                    key: h.key.clone(),
                    text: h.text.clone(),
                    outcome: "dropped while waiting".to_owned(),
                });
            }
            wanted
        })
        .collect();
    let extra = state.log.len().saturating_sub(LOG);
    state.log.drain(..extra);
    let mut out = Vec::new();
    for address in targets {
        let mine: Vec<&Held> = held.iter().filter(|h| !h.except.contains(address)).collect();
        if mine.is_empty() {
            continue;
        }
        let mut lines = vec![format!("Held back ({}):", mine.len())];
        for h in mine {
            let at = crate::cron::local(h.at).format("%H:%M");
            let mark = if h.key.ends_with(":cleared") { "✅" } else { "⚠️" };
            lines.push(format!("{mark} {at} {}", h.text));
        }
        out.push((address.clone(), lines.join("\n")));
    }
    for h in &held {
        if !h.key.ends_with(":cleared") {
            state.last.insert(h.key.clone(), t);
            state.open.insert(h.key.clone());
        }
    }
    if !out.is_empty() {
        state.sent.push(t);
    }
    out
}

/// At start: what the last run left (a crash, an update), with [state] marked as running now.
pub fn started(state: &mut State, pid: u32, version: &str, now: i64) -> Vec<Alert> {
    let mut alerts = Vec::new();
    if let Some(last) = &state.serve {
        if last.running && last.pid != pid {
            alerts.push(Alert::new(
                Kind::Crash,
                "crash",
                format!(
                    "autobot serve stopped without shutting down (it had run since {}) and was started again.",
                    crate::cron::local(last.started).format("%d %b %H:%M")
                ),
            ));
        }
        if !last.version.is_empty() && last.version != version {
            alerts.push(Alert::new(
                Kind::Update,
                &format!("updated:{version}"),
                format!("Updated: autobot {} → {version}.", last.version),
            ));
        }
    }
    state.serve = Some(Serve { pid, started: now, version: version.to_owned(), running: true });
    alerts
}

/// The version `invincible update --check` says is available, if one is.
pub fn available(output: &str) -> Option<String> {
    let plain = strip_ansi(output);
    let line = plain.lines().find(|l| l.contains(" is available"))?;
    let before = &line[..line.find(" is available")?];
    if before.ends_with("a new build") {
        return Some("a new build".to_owned());
    }
    let version = before.split_whitespace().last()?.trim_start_matches('v');
    (!version.is_empty()).then(|| version.to_owned())
}

fn strip_ansi(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut chars = text.chars().peekable();
    while let Some(c) = chars.next() {
        if c == '\u{1b}' {
            if chars.peek() == Some(&'[') {
                chars.next();
                for c in chars.by_ref() {
                    if c.is_ascii_alphabetic() {
                        break;
                    }
                }
            }
            continue;
        }
        out.push(c);
    }
    out
}

/// The bots running now, the default one first.
pub type Bots = Arc<dyn Fn() -> Vec<Arc<Runtime>> + Send + Sync>;

struct Alerter {
    root: PathBuf,
    bots: Bots,
    sink: tokio::sync::mpsc::UnboundedSender<Alert>,
    /// One alert decided and sent at a time (the state file is read and written whole).
    lock: tokio::sync::Mutex<()>,
}

static ALERTER: OnceLock<Arc<Alerter>> = OnceLock::new();

/// Raises [alert] (when `autobot serve` runs alerts; otherwise nothing happens).
pub fn raise(alert: Alert) {
    if let Some(alerter) = ALERTER.get() {
        let _ = alerter.sink.send(alert);
    }
}

fn host() -> String {
    static HOST: OnceLock<String> = OnceLock::new();
    HOST.get_or_init(|| {
        std::process::Command::new("hostname")
            .arg("-s")
            .output()
            .ok()
            .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_owned())
            .filter(|h| !h.is_empty())
            .unwrap_or_else(|| "this machine".to_owned())
    })
    .clone()
}

/// Where alerts go: `[alerts] to`, else the default bot's home channel.
pub fn targets(config: &AlertsConfig, bots: &[Arc<Runtime>]) -> Vec<String> {
    if !config.to.is_empty() {
        return config.to.clone();
    }
    bots.first().and_then(|b| b.home_channel()).into_iter().collect()
}

/// Sends [text] to each of [targets], each through the first bot with that platform
/// connected (the default bot, waiting for it to connect, when none is): how each went.
pub async fn send(bots: &[Arc<Runtime>], targets: &[String], text: &str) -> Vec<(String, Result<(), String>)> {
    let mut results = Vec::new();
    for address in targets {
        let result = async {
            let (platform, _) = crate::channel::parse_address(address)?;
            let bot =
                bots.iter().find(|b| b.transport(&platform).is_some()).or(bots.first()).ok_or("no bot is running")?;
            bot.deliver(address, text).await
        }
        .await;
        results.push((address.clone(), result));
    }
    results
}

impl Alerter {
    fn config(&self) -> AlertsConfig {
        crate::bots::load_default(&self.root).map(|d| d.config.alerts).unwrap_or_default()
    }

    async fn handle(&self, alert: Alert) {
        let _one = self.lock.lock().await;
        let config = self.config();
        let policy = match config.policy() {
            Ok(p) => p,
            Err(e) => {
                tracing::warn!("alerts: {e}");
                return;
            }
        };
        let mut state = State::load(&self.root);
        let now = Local::now();
        let all = targets(&config, &(self.bots)());
        if all.is_empty() || all.iter().all(|a| alert.except.contains(a)) {
            let why = if all.is_empty() {
                "nowhere to send it ([alerts] to, or /sethome)"
            } else {
                "its own answer went there"
            };
            tracing::info!(key = %alert.key, "alert not sent: {why}");
            state.note(&alert, now.timestamp(), why);
            let _ = state.save(&self.root);
            return;
        }
        let before = state.clone();
        let decision = decide(&mut state, &policy, &alert, now);
        let Decision::Send(text) = decision else {
            tracing::info!(key = %alert.key, "alert not sent now: {:?}", decision);
            if let Err(e) = state.save(&self.root) {
                tracing::warn!("alerts: {e}");
            }
            return;
        };
        // The lock is held: nothing else changes the state meanwhile.
        let results = self.deliver(&config, &text, &alert.except).await;
        let failed: Vec<String> =
            results.iter().filter_map(|(to, r)| r.as_ref().err().map(|e| format!("{to}: {e}"))).collect();
        let outcome = if results.iter().any(|(_, r)| r.is_ok()) {
            if let Some(version) = alert.key.strip_prefix("available:") {
                state.update_seen = Some(version.to_owned());
            }
            (!failed.is_empty()).then(|| format!("sent, but not to {}", failed.join("; ")))
        } else {
            // Nobody has it: not sent after all. It waits, and goes with the next round.
            if !alert.clear {
                state.last = before.last;
                state.open = before.open;
            }
            state.sent = before.sent;
            state.dropped = before.dropped;
            state.held.push(Held::of(&alert, held_key(&alert), now.timestamp()));
            Some(format!("not delivered ({}); waiting to be sent again", failed.join("; ")))
        };
        if let Some(outcome) = outcome
            && let Some(last) = state.log.iter_mut().rev().find(|l| l.key == alert.key)
        {
            last.outcome = outcome;
        }
        if let Err(e) = state.save(&self.root) {
            tracing::warn!("alerts: {e}");
        }
    }

    async fn deliver(&self, config: &AlertsConfig, text: &str, except: &[String]) -> Vec<(String, Result<(), String>)> {
        let bots = (self.bots)();
        let all = targets(config, &bots);
        if all.is_empty() {
            tracing::warn!("alert with nowhere to go (set [alerts] to, or /sethome): {text}");
            return Vec::new();
        }
        let to: Vec<String> = all.into_iter().filter(|a| !except.contains(a)).collect();
        if to.is_empty() {
            return Vec::new();
        }
        let text = format!("{text}\n— autobot on {}", host());
        let results = send(&bots, &to, &text).await;
        for (address, result) in &results {
            match result {
                Ok(()) => tracing::info!("alert sent to {address}"),
                Err(e) => tracing::warn!("alert to {address}: {e}"),
            }
        }
        results
    }

    async fn tick(&self) {
        let _one = self.lock.lock().await;
        let config = self.config();
        let Ok(policy) = config.policy() else { return };
        let mut state = State::load(&self.root);
        let before = state.clone();
        let all = targets(&config, &(self.bots)());
        let messages = flush(&mut state, &policy, &all, Local::now());
        if messages.is_empty() {
            if state != before {
                let _ = state.save(&self.root);
            }
            return;
        }
        let bots = (self.bots)();
        let mut any = false;
        for (address, text) in messages {
            let text = format!("{text}\n— autobot on {}", host());
            for (address, result) in send(&bots, &[address], &text).await {
                match result {
                    Ok(()) => {
                        any = true;
                        tracing::info!("held alerts sent to {address}");
                    }
                    Err(e) => tracing::warn!("held alerts to {address}: {e}"),
                }
            }
        }
        if !any {
            // All of it waits for the next round (what the policy dropped is dropped again then).
            state = before;
        }
        if let Err(e) = state.save(&self.root) {
            tracing::warn!("alerts: {e}");
        }
    }
}

/// `autobot alerts test` (through the agent API): a test alert to every target, now, whatever
/// the limits and quiet hours say; how each went.
pub async fn test() -> Result<Vec<(String, Result<(), String>)>, String> {
    let alerter = ALERTER.get().ok_or("alerts are not running in this process")?;
    let config = alerter.config();
    let to = targets(&config, &(alerter.bots)());
    if to.is_empty() {
        return Err("no address: set [alerts] to = [\"telegram:<chat>\"] or a home channel (/sethome)".to_owned());
    }
    let alert = Alert::new(Kind::Test, "test", "Test alert: this is where autobot's health alerts come.");
    let _one = alerter.lock.lock().await;
    let mut state = State::load(&alerter.root);
    let Decision::Send(text) =
        decide(&mut state, &config.policy().unwrap_or_else(|_| default_policy()), &alert, Local::now())
    else {
        return Err("the test alert was not sent".to_owned());
    };
    let _ = state.save(&alerter.root);
    Ok(alerter.deliver(&config, &text, &[]).await)
}

fn default_policy() -> Policy {
    AlertsConfig::default().policy().expect("the defaults are valid")
}

/// Starts alerts for `autobot serve` in [root]: what the last run left, then the alerts as they
/// come, quiet hours' end, and the watches (disk, model backends, updates). The tasks.
pub fn start(root: &Path, bots: Bots) -> Vec<tokio::task::JoinHandle<()>> {
    let (sink, mut inbox) = tokio::sync::mpsc::unbounded_channel();
    let alerter = Arc::new(Alerter { root: root.to_owned(), bots, sink, lock: Default::default() });
    if ALERTER.set(alerter.clone()).is_err() {
        return Vec::new();
    }
    let mut state = State::load(root);
    let on_start = started(&mut state, std::process::id(), invincible::version::VERSION, Local::now().timestamp());
    if let Err(e) = state.save(root) {
        tracing::warn!("alerts: {e}");
    }
    for alert in on_start {
        raise(alert);
    }
    let a = alerter.clone();
    let inbox_task = tokio::spawn(async move {
        let mut tick = tokio::time::interval(Duration::from_secs(60));
        loop {
            tokio::select! {
                alert = inbox.recv() => match alert {
                    Some(alert) => a.handle(alert).await,
                    None => return,
                },
                _ = tick.tick() => a.tick().await,
            }
        }
    });
    let a = alerter.clone();
    let disk = tokio::spawn(async move {
        // Unknown at first: an alert the last run sent is cleared once there is room.
        let mut low: Option<bool> = None;
        loop {
            let limit = a.config().disk_free_gib << 30;
            if let Some(free) = crate::doctor::free_space(&a.root)
                && limit > 0
            {
                let gib = invincible::models::gib(free);
                if free < limit && low != Some(true) {
                    low = Some(true);
                    raise(Alert::new(
                        Kind::Disk,
                        "disk",
                        format!("The disk is low: {gib} free where {} is.", a.root.display()),
                    ));
                } else if free >= limit + (limit / 4) && low != Some(false) {
                    low = Some(false);
                    raise(Alert::cleared(Kind::Disk, "disk", format!("The disk has room again: {gib} free.")));
                }
            }
            tokio::time::sleep(Duration::from_secs(300)).await;
        }
    });
    let a = alerter.clone();
    let backends = tokio::spawn(async move {
        let mut down: BTreeMap<String, u32> = BTreeMap::new();
        // What the last run said is failing: its clearing is owed too.
        let mut told: BTreeSet<String> =
            State::load(&a.root).open.iter().filter_map(|k| k.strip_prefix("backend:")).map(str::to_owned).collect();
        loop {
            tokio::time::sleep(Duration::from_secs(60)).await;
            let Some(bot) = (a.bots)().into_iter().next() else { continue };
            let Ok(models) = bot.agent().gateway.model_info().await else { continue };
            for (alert, now_down) in backend_changes(&models, &mut down, &mut told) {
                tracing::info!(down = now_down, "backend: {}", alert.text);
                raise(alert);
            }
        }
    });
    let a = alerter;
    let updates = tokio::spawn(async move {
        tokio::time::sleep(Duration::from_secs(600)).await;
        loop {
            let every = a.config().update_every().ok().flatten();
            if every.is_some()
                && let Some(version) = check_update().await
            {
                // Marked as told once the alert is delivered ([Alerter::handle]).
                if State::load(&a.root).update_seen.as_deref() != Some(&version) {
                    raise(Alert::new(
                        Kind::Update,
                        &format!("available:{version}"),
                        format!("Update available: {version} (`autobot update` installs it)."),
                    ));
                }
            }
            tokio::time::sleep(every.unwrap_or(Duration::from_secs(3600))).await;
        }
    });
    vec![inbox_task, disk, backends, updates]
}

/// A model backend down two checks running is an alert; up again after one, its clearing.
pub fn backend_changes(
    models: &[crate::gateway::ModelInfo],
    down: &mut BTreeMap<String, u32>,
    told: &mut BTreeSet<String>,
) -> Vec<(Alert, bool)> {
    let mut changes = Vec::new();
    for model in models {
        let key = format!("backend:{}", model.id);
        if model.healthy {
            down.remove(&model.id);
            if told.remove(&model.id) {
                changes.push((
                    Alert::cleared(Kind::Backend, &key, format!("The model {} is healthy again.", model.id)),
                    false,
                ));
            }
        } else {
            let n = down.entry(model.id.clone()).or_default();
            *n += 1;
            if *n == 2 && told.insert(model.id.clone()) {
                changes.push((
                    Alert::new(
                        Kind::Backend,
                        &key,
                        format!("The model {} ({}) is failing its health checks.", model.id, model.tier),
                    ),
                    true,
                ));
            }
        }
    }
    changes
}

/// `invincible update --check`: the version available, if one is.
async fn check_update() -> Option<String> {
    let program = crate::find_program("invincible")?;
    let out = tokio::process::Command::new(program).args(["update", "--check"]).output().await.ok()?;
    available(&String::from_utf8_lossy(&out.stdout))
}

/// `autobot serve` shut down cleanly (once no alert is being decided or sent).
pub async fn stopped(root: &Path) {
    let _one = match ALERTER.get() {
        Some(alerter) => Some(alerter.lock.lock().await),
        None => None,
    };
    mark_stopped(root);
}

fn mark_stopped(root: &Path) {
    let mut state = State::load(root);
    if let Some(serve) = &mut state.serve
        && serve.pid == std::process::id()
    {
        serve.running = false;
        let _ = state.save(root);
    }
}

/// `autobot alerts`: where they go, which, and the latest.
pub fn status(root: &Path, config: &AlertsConfig) -> Vec<String> {
    let mut lines = Vec::new();
    match config.policy() {
        Err(e) => lines.push(format!("✗ {e}")),
        Ok(p) if !p.enabled => lines.push("alerts are off ([alerts] enabled = false)".to_owned()),
        Ok(p) => {
            let home = std::fs::read_to_string(root.join("home-channel.json"))
                .ok()
                .and_then(|t| serde_json::from_str::<serde_json::Value>(&t).ok())
                .and_then(|v| v["address"].as_str().map(str::to_owned));
            let to = if config.to.is_empty() {
                match home {
                    Some(h) => format!("{h} (the home channel)"),
                    None => "nowhere yet: set [alerts] to = [\"telegram:<chat>\"], or /sethome in a chat".to_owned(),
                }
            } else {
                config.to.join(", ")
            };
            lines.push(format!("to: {to}"));
            let events = match &p.events {
                None => "all".to_owned(),
                Some(e) => e.iter().map(|k| k.name()).collect::<Vec<_>>().join(", "),
            };
            lines.push(format!("events: {events}"));
            lines.push(format!(
                "the same alert at most every {}, at most {} an hour{}",
                config.repeat.trim(),
                p.per_hour,
                match &config.quiet_hours {
                    Some(q) => format!(", quiet {q}"),
                    None => String::new(),
                }
            ));
        }
    }
    let state = State::load(root);
    if !state.held.is_empty() {
        lines.push(format!("{} waiting to be sent (quiet hours, or a channel that failed)", state.held.len()));
    }
    if state.log.is_empty() {
        lines.push("no alerts yet".to_owned());
    } else {
        lines.push("latest:".to_owned());
        for l in state.log.iter().rev().take(10) {
            lines.push(format!(
                "  {} {} {}: {}",
                crate::cron::local(l.at).format("%d %b %H:%M"),
                l.kind,
                l.outcome,
                l.text.lines().next().unwrap_or_default()
            ));
        }
    }
    lines
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::TimeZone;

    fn at(h: u32, m: u32) -> DateTime<Local> {
        Local.with_ymd_and_hms(2026, 10, 20, h, m, 0).single().unwrap()
    }

    fn policy(text: &str) -> Policy {
        let config: AlertsConfig = toml::from_str(text).unwrap();
        config.policy().unwrap()
    }

    #[test]
    fn config_is_checked() {
        let p = policy("");
        assert!(p.enabled && p.events.is_none() && p.quiet.is_none());
        assert_eq!(p.repeat, Duration::from_secs(6 * 3600));
        let p = policy("events = [\"crash\", \"disk\"]\nquiet_hours = \"23:00-07:30\"\nrepeat = \"30m\"");
        assert_eq!(p.events, Some([Kind::Crash, Kind::Disk].into()));
        assert_eq!(p.quiet, Some((23 * 60, 7 * 60 + 30)));
        let bad = |t: &str| toml::from_str::<AlertsConfig>(t).unwrap().policy().unwrap_err();
        assert!(bad("events = [\"weather\"]").contains("not one of"));
        assert!(bad("quiet_hours = \"late\"").contains("quiet_hours"));
        assert!(bad("quiet_hours = \"25:00-07:00\"").contains("quiet_hours"));
        assert!(bad("repeat = \"often\"").contains("repeat"));
        assert!(toml::from_str::<AlertsConfig>("loud = true").is_err());
        assert_eq!(AlertsConfig::default().update_every().unwrap(), Some(Duration::from_secs(86400)));
        let off: AlertsConfig = toml::from_str("update_check = \"off\"").unwrap();
        assert_eq!(off.update_every().unwrap(), None);
    }

    #[test]
    fn quiet_hours_across_midnight() {
        let p = policy("quiet_hours = \"23:00-07:00\"");
        assert!(p.quiet_at(at(23, 0)) && p.quiet_at(at(2, 0)) && p.quiet_at(at(6, 59)));
        assert!(!p.quiet_at(at(7, 0)) && !p.quiet_at(at(12, 0)) && !p.quiet_at(at(22, 59)));
        let day = policy("quiet_hours = \"09:00-17:00\"");
        assert!(day.quiet_at(at(9, 0)) && !day.quiet_at(at(17, 0)) && !day.quiet_at(at(8, 0)));
    }

    #[test]
    fn the_same_alert_is_sent_once_in_a_while() {
        let p = policy("repeat = \"1h\"");
        let mut s = State::default();
        let down = Alert::new(Kind::Gateway, "gateway", "The gateway does not answer.");
        assert!(matches!(decide(&mut s, &p, &down, at(10, 0)), Decision::Send(t) if t.starts_with("⚠️ The gateway")));
        assert_eq!(decide(&mut s, &p, &down, at(10, 30)), Decision::Skip("sent lately"));
        // Over, then down again within the hour: the clearing goes, the second down does not.
        let up = Alert::cleared(Kind::Gateway, "gateway", "The gateway answers again.");
        assert!(matches!(decide(&mut s, &p, &up, at(10, 31)), Decision::Send(t) if t.starts_with("✅")));
        assert_eq!(decide(&mut s, &p, &up, at(10, 32)), Decision::Skip("nothing was sent about it"));
        assert_eq!(decide(&mut s, &p, &down, at(10, 40)), Decision::Skip("sent lately"));
        assert!(matches!(decide(&mut s, &p, &down, at(11, 1)), Decision::Send(_)));
        // A clearing of what was never sent says nothing.
        let mut fresh = State::default();
        assert_eq!(decide(&mut fresh, &p, &up, at(9, 0)), Decision::Skip("nothing was sent about it"));
        // Clearings of what was never sent are not logged.
        assert_eq!(s.log.len(), 5);
        assert!(fresh.log.is_empty());
        assert_eq!(s.log[1].outcome, "sent lately");
    }

    #[test]
    fn at_most_so_many_an_hour_then_a_count() {
        let p = policy("per_hour = 2");
        let mut s = State::default();
        let job = |n: u32| Alert::new(Kind::Job, &format!("job:{n}"), format!("Task {n} failed."));
        assert!(matches!(decide(&mut s, &p, &job(1), at(10, 0)), Decision::Send(_)));
        assert!(matches!(decide(&mut s, &p, &job(2), at(10, 1)), Decision::Send(_)));
        assert_eq!(decide(&mut s, &p, &job(3), at(10, 2)), Decision::Skip("over the hourly limit"));
        assert_eq!(decide(&mut s, &p, &job(4), at(10, 3)), Decision::Skip("over the hourly limit"));
        let Decision::Send(text) = decide(&mut s, &p, &job(5), at(11, 1)) else { panic!() };
        assert!(text.contains("2 more alert(s) were held back"), "{text}");
        // A test always goes.
        let test = Alert::new(Kind::Test, "test", "Test.");
        assert!(matches!(decide(&mut s, &p, &test, at(11, 2)), Decision::Send(_)));
    }

    #[test]
    fn events_and_off() {
        let mut s = State::default();
        let only = policy("events = [\"crash\"]");
        let disk = Alert::new(Kind::Disk, "disk", "Low.");
        assert_eq!(decide(&mut s, &only, &disk, at(10, 0)), Decision::Skip("not one of [alerts] events"));
        let off = policy("enabled = false");
        assert_eq!(decide(&mut s, &off, &disk, at(10, 0)), Decision::Skip("alerts are off"));
    }

    #[test]
    fn quiet_hours_hold_then_one_message() {
        let p = policy("quiet_hours = \"23:00-07:00\"");
        let mut s = State::default();
        let disk = Alert::new(Kind::Disk, "disk", "The disk is low.");
        let gw = Alert::new(Kind::Gateway, "gateway", "The gateway does not answer.");
        let gw_up = Alert::cleared(Kind::Gateway, "gateway", "The gateway answers again.");
        assert_eq!(decide(&mut s, &p, &disk, at(23, 30)), Decision::Hold);
        assert_eq!(decide(&mut s, &p, &disk, at(23, 40)), Decision::Hold, "once");
        assert_eq!(decide(&mut s, &p, &gw, at(1, 0)), Decision::Hold);
        // Gone before morning: neither goes.
        assert_eq!(decide(&mut s, &p, &gw_up, at(1, 5)), Decision::Skip("gone before it was sent"));
        assert_eq!(s.held.len(), 1);
        let to = ["telegram:1".to_owned()];
        assert!(flush(&mut s, &p, &to, at(6, 0)).is_empty(), "still quiet");
        let sent = flush(&mut s, &p, &to, at(7, 1));
        let text = &sent[0].1;
        assert!(text.starts_with("Held back (1):") && text.contains("The disk is low."), "{text}");
        assert!(s.held.is_empty() && s.open.contains("disk"));
        assert!(flush(&mut s, &p, &to, at(7, 2)).is_empty());
        // Sent from the digest: not again soon.
        assert_eq!(decide(&mut s, &p, &disk, at(8, 0)), Decision::Skip("sent lately"));
    }

    #[test]
    fn held_alerts_keep_their_exclusions_and_follow_the_policy() {
        let p = policy("quiet_hours = \"23:00-07:00\"");
        let to = ["telegram:1".to_owned(), "email:me@example.org".to_owned()];
        let mut s = State::default();
        let job = Alert::new(Kind::Job, "job:t1", "The task failed.").except(vec!["telegram:1".into()]);
        assert_eq!(decide(&mut s, &p, &job, at(23, 30)), Decision::Hold);
        let sent = flush(&mut s, &p, &to, at(7, 1));
        assert_eq!(sent.len(), 1);
        assert_eq!(sent[0].0, "email:me@example.org");
        // Turned off overnight: what waited is dropped.
        let mut s = State::default();
        assert_eq!(decide(&mut s, &p, &job, at(23, 30)), Decision::Hold);
        let off = policy("quiet_hours = \"23:00-07:00\"\nevents = [\"disk\"]");
        assert!(flush(&mut s, &off, &to, at(7, 1)).is_empty());
        assert!(s.held.is_empty() && !s.open.contains("job:t1"));
        assert_eq!(s.log.last().unwrap().outcome, "dropped while waiting");
    }

    #[test]
    fn a_crash_and_an_update_are_noticed_at_start() {
        let mut s = State::default();
        assert!(started(&mut s, 10, "0.0.15", 1000).is_empty(), "first run");
        // Shut down cleanly, then started again.
        s.serve.as_mut().unwrap().running = false;
        assert!(started(&mut s, 11, "0.0.15", 2000).is_empty());
        // Killed: still marked running.
        let alerts = started(&mut s, 12, "0.0.16", 3000);
        assert_eq!(alerts.iter().map(|a| a.kind).collect::<Vec<_>>(), vec![Kind::Crash, Kind::Update]);
        assert!(alerts[1].text.contains("0.0.15 → 0.0.16"));
        assert_eq!(s.serve.as_ref().unwrap().pid, 12);
    }

    #[test]
    fn stopped_marks_a_clean_shutdown() {
        let root = std::env::temp_dir().join(format!("autobot-alerts-stop-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).unwrap();
        let mut s = State::default();
        started(&mut s, std::process::id(), "0.0.15", 1);
        s.save(&root).unwrap();
        mark_stopped(&root);
        assert!(!State::load(&root).serve.unwrap().running);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn update_output_and_backends() {
        assert_eq!(
            available("\u{1b}[33m!\u{1b}[0m 0.0.16 is available: `invincible update` installs it\n").as_deref(),
            Some("0.0.16")
        );
        assert_eq!(available("checking the stable channel\nup to date: 0.0.15\n"), None);
        assert_eq!(available("a new build is available: …").as_deref(), Some("a new build"));
        let model = |healthy| crate::gateway::ModelInfo {
            id: "qwen3".into(),
            tier: "node".into(),
            context: None,
            healthy,
            vision: None,
        };
        let (mut down, mut told) = (BTreeMap::new(), BTreeSet::new());
        assert!(backend_changes(&[model(false)], &mut down, &mut told).is_empty(), "one failed check is not enough");
        let changes = backend_changes(&[model(false)], &mut down, &mut told);
        assert_eq!(changes.len(), 1);
        assert!(changes[0].1 && changes[0].0.key == "backend:qwen3");
        assert!(backend_changes(&[model(false)], &mut down, &mut told).is_empty(), "once");
        let back = backend_changes(&[model(true)], &mut down, &mut told);
        assert!(back[0].0.clear);
    }
}
