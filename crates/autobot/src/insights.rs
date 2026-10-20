//! What the agent did, turn by turn: `$AUTOBOT_HOME/turns.jsonl` (mode 0600, rotated at 8 MiB to
//! `turns.1.jsonl`), one line per turn of the main agent on any channel: when, the conversation
//! and project, how long, how it ended, every model call with its model, tier and tokens (from
//! the gateway's receipts and usage), and the tools it used. Never prompt or answer text.
//!
//! `/usage` and `autobot usage` sum it for this conversation and today (with a cost where the
//! config gives prices); `/insights` and `autobot insights` over the last days: turns, tools,
//! projects, failures, local against cloud.

use std::collections::BTreeMap;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use crate::agent::Event;

const ROTATE: u64 = 8 * 1024 * 1024;

/// One model call of a turn.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct ModelCall {
    pub model: String,
    /// `cloud`, or where on the owner's hardware (`node`, …).
    pub tier: String,
    #[serde(default)]
    pub input: u64,
    #[serde(default)]
    pub output: u64,
    #[serde(default)]
    pub cached: u64,
}

impl ModelCall {
    pub fn cloud(&self) -> bool {
        self.tier == "cloud"
    }
}

/// One turn.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct Record {
    /// Unix seconds when it ended.
    pub at: i64,
    pub session: String,
    /// The working directory's name.
    #[serde(default)]
    pub project: String,
    pub seconds: f64,
    /// `answer`, `stopped` (by the owner, or the step budget), `error`.
    pub outcome: String,
    #[serde(default)]
    pub calls: Vec<ModelCall>,
    /// Tool name → times used.
    #[serde(default)]
    pub tools: BTreeMap<String, u32>,
    /// Tool results that were errors.
    #[serde(default)]
    pub tool_errors: u32,
    #[serde(default)]
    pub refused: u32,
}

/// A price per million tokens, in dollars: `[prices."deepseek-chat"] input = 0.27, output = 1.10`.
#[derive(Clone, Copy, Debug, Default, PartialEq, Deserialize, serde::Serialize)]
#[serde(deny_unknown_fields)]
pub struct Price {
    pub input: f64,
    pub output: f64,
    /// For cached input, when it is cheaper (default: as input).
    #[serde(default)]
    pub cached: Option<f64>,
}

pub type Prices = BTreeMap<String, Price>;

pub struct Log {
    path: PathBuf,
}

impl Log {
    pub fn new(home: &Path) -> Self {
        Self { path: home.join("turns.jsonl") }
    }

    pub fn append(&self, record: &Record) -> Result<(), String> {
        if let Some(dir) = self.path.parent() {
            std::fs::create_dir_all(dir).map_err(|e| format!("{}: {e}", dir.display()))?;
        }
        if std::fs::metadata(&self.path).is_ok_and(|m| m.len() > ROTATE) {
            let _ = std::fs::rename(&self.path, self.path.with_file_name("turns.1.jsonl"));
        }
        let mut options = std::fs::OpenOptions::new();
        options.create(true).append(true);
        #[cfg(unix)]
        std::os::unix::fs::OpenOptionsExt::mode(&mut options, 0o600);
        let mut file = options.open(&self.path).map_err(|e| format!("{}: {e}", self.path.display()))?;
        let line = serde_json::to_string(record).map_err(|e| e.to_string())?;
        writeln!(file, "{line}").map_err(|e| format!("{}: {e}", self.path.display()))
    }

    /// The turns that ended at or after [since] (unix seconds), oldest first.
    pub fn read(&self, since: i64) -> Vec<Record> {
        [self.path.with_file_name("turns.1.jsonl"), self.path.clone()]
            .iter()
            .flat_map(|p| std::fs::read_to_string(p).unwrap_or_default().lines().map(str::to_owned).collect::<Vec<_>>())
            .filter_map(|l| serde_json::from_str::<Record>(&l).ok())
            .filter(|r| r.at >= since)
            .collect()
    }
}

/// What a turn did, gathered from its events as it runs.
#[derive(Default)]
pub struct Tally {
    inner: Mutex<Record>,
}

impl Tally {
    pub fn see(&self, event: &Event) {
        let mut r = self.inner.lock().expect("tally");
        match event {
            // Fetches have receipts too; they are not model calls.
            Event::Receipt { model, tier, .. } if *tier != Some("web") => r.calls.push(ModelCall {
                model: model.unwrap_or("?").to_owned(),
                tier: tier.unwrap_or("?").to_owned(),
                ..Default::default()
            }),
            Event::Usage { input, output, cached } => {
                // Usage follows its call's receipt; a call without one (no receipt id) stands alone.
                match r.calls.last_mut().filter(|c| c.input == 0 && c.output == 0) {
                    Some(call) => (call.input, call.output, call.cached) = (*input, *output, *cached),
                    None => r.calls.push(ModelCall {
                        model: "?".into(),
                        tier: "?".into(),
                        input: *input,
                        output: *output,
                        cached: *cached,
                    }),
                }
            }
            Event::Output { name, text } => {
                *r.tools.entry((*name).to_owned()).or_default() += 1;
                if text.starts_with("error:") {
                    r.tool_errors += 1;
                }
            }
            Event::Refused(_) => r.refused += 1,
            _ => {}
        }
    }

    pub fn finish(&self, session: &str, project: &str, seconds: f64, outcome: &str) -> Record {
        let mut r = std::mem::take(&mut *self.inner.lock().expect("tally"));
        r.at = chrono::Utc::now().timestamp();
        r.session = session.to_owned();
        r.project = project.to_owned();
        r.seconds = (seconds * 10.0).round() / 10.0;
        r.outcome = outcome.to_owned();
        r
    }
}

/// Sums of some turns.
#[derive(Clone, Debug, Default, PartialEq, Serialize)]
pub struct Totals {
    pub turns: usize,
    pub calls: usize,
    pub cloud_calls: usize,
    pub input: u64,
    pub output: u64,
    pub cached: u64,
    pub cloud_tokens: u64,
    pub seconds: f64,
    /// Dollars, for the calls with a price (local ones cost nothing).
    pub cost: f64,
    /// Cloud models used without a price in the config.
    pub unpriced: Vec<String>,
}

pub fn totals(records: &[Record], prices: &Prices) -> Totals {
    let mut t = Totals { turns: records.len(), ..Default::default() };
    for r in records {
        t.seconds += r.seconds;
        for c in &r.calls {
            t.calls += 1;
            t.input += c.input;
            t.output += c.output;
            t.cached += c.cached;
            if c.cloud() {
                t.cloud_calls += 1;
                t.cloud_tokens += c.input + c.output;
            }
            match prices.get(&c.model) {
                Some(p) => {
                    let fresh = c.input.saturating_sub(c.cached) as f64;
                    t.cost +=
                        (fresh * p.input + c.cached as f64 * p.cached.unwrap_or(p.input) + c.output as f64 * p.output)
                            / 1_000_000.0;
                }
                None if c.cloud() && !t.unpriced.contains(&c.model) => t.unpriced.push(c.model.clone()),
                None => {}
            }
        }
    }
    t
}

/// Local midnight today, in unix seconds.
pub fn today() -> i64 {
    let now = chrono::Local::now();
    now.date_naive()
        .and_hms_opt(0, 0, 0)
        .and_then(|t| t.and_local_timezone(chrono::Local).earliest())
        .map_or(now.timestamp() - 86_400, |t| t.timestamp())
}

fn tokens(n: u64) -> String {
    match n {
        0..1000 => n.to_string(),
        1000..1_000_000 => format!("{:.1}k", n as f64 / 1000.0),
        _ => format!("{:.2}M", n as f64 / 1_000_000.0),
    }
}

fn duration(secs: f64) -> String {
    let s = secs.round() as u64;
    match s {
        0..60 => format!("{secs:.1}s"),
        60..3600 => format!("{}m {}s", s / 60, s % 60),
        _ => format!("{}h {}m", s / 3600, s % 3600 / 60),
    }
}

/// One line for [t]: turns, calls, tokens, time, cost.
pub fn usage_line(t: &Totals) -> String {
    if t.turns == 0 {
        return "no turns".to_owned();
    }
    let mut line = format!(
        "{} turn{} · {} model call{} · {} in{} · {} out · {}",
        t.turns,
        if t.turns == 1 { "" } else { "s" },
        t.calls,
        if t.calls == 1 { "" } else { "s" },
        tokens(t.input),
        if t.cached > 0 { format!(" ({} cached)", tokens(t.cached)) } else { String::new() },
        tokens(t.output),
        duration(t.seconds),
    );
    if t.cloud_calls == 0 {
        line.push_str(" · all local, $0");
    } else {
        line.push_str(&format!(" · {} cloud call{}", t.cloud_calls, if t.cloud_calls == 1 { "" } else { "s" }));
        line.push_str(&format!(" · ${:.4}", t.cost));
        if !t.unpriced.is_empty() {
            line.push_str(&format!(" + {} unpriced ([prices] in the config)", t.unpriced.join(", ")));
        }
    }
    line
}

/// What `/usage` and `autobot usage` show: this conversation (when named) and today.
pub fn usage(home: &Path, session: Option<&str>, prices: &Prices) -> Vec<(String, String)> {
    let log = Log::new(home);
    let mut rows = Vec::new();
    if let Some(session) = session {
        let mine: Vec<Record> = log.read(0).into_iter().filter(|r| r.session == session).collect();
        rows.push(("conversation".to_owned(), usage_line(&totals(&mine, prices))));
    }
    rows.push(("today".to_owned(), usage_line(&totals(&log.read(today()), prices))));
    rows
}

/// What the agent did over the last [days], as JSON (`GET /v1/agent/insights`).
pub fn insights(home: &Path, days: u32, prices: &Prices) -> Value {
    let since = chrono::Utc::now().timestamp() - i64::from(days.max(1)) * 86_400;
    let records = Log::new(home).read(since);
    let t = totals(&records, prices);
    let mut tools: BTreeMap<&str, u32> = BTreeMap::new();
    let mut projects: BTreeMap<&str, usize> = BTreeMap::new();
    let mut models: BTreeMap<&str, (usize, u64, bool)> = BTreeMap::new();
    let (mut stopped, mut errors, mut tool_errors, mut refused) = (0, 0, 0, 0);
    for r in &records {
        for (name, n) in &r.tools {
            *tools.entry(name).or_default() += n;
        }
        if !r.project.is_empty() {
            *projects.entry(&r.project).or_default() += 1;
        }
        for c in &r.calls {
            let m = models.entry(&c.model).or_default();
            m.0 += 1;
            m.1 += c.input + c.output;
            m.2 |= c.cloud();
        }
        match r.outcome.as_str() {
            "stopped" => stopped += 1,
            "error" => errors += 1,
            _ => {}
        }
        tool_errors += r.tool_errors;
        refused += r.refused;
    }
    let top = |map: Vec<(String, u64)>, n: usize| -> Vec<Value> {
        let mut map = map;
        map.sort_by(|a, b| b.1.cmp(&a.1).then(a.0.cmp(&b.0)));
        map.into_iter().take(n).map(|(name, count)| json!({ "name": name, "count": count })).collect()
    };
    let total_tokens = t.input + t.output;
    json!({
        "days": days.max(1),
        "turns": t.turns,
        "seconds": t.seconds,
        "calls": t.calls,
        "tokens": { "input": t.input, "output": t.output, "cached": t.cached },
        "cost": t.cost,
        "unpriced": t.unpriced,
        "local_share": {
            "calls": if t.calls == 0 { 1.0 } else { 1.0 - t.cloud_calls as f64 / t.calls as f64 },
            "tokens": if total_tokens == 0 { 1.0 } else { 1.0 - t.cloud_tokens as f64 / total_tokens as f64 },
        },
        "tools": top(tools.into_iter().map(|(k, v)| (k.to_owned(), u64::from(v))).collect(), 10),
        "projects": top(projects.into_iter().map(|(k, v)| (k.to_owned(), v as u64)).collect(), 5),
        "models": models.into_iter().map(|(m, (calls, tokens, cloud))| json!({ "model": m, "calls": calls, "tokens": tokens, "cloud": cloud })).collect::<Vec<_>>(),
        "failures": { "errors": errors, "stopped": stopped, "tool_errors": tool_errors, "refused": refused },
    })
}

/// [insights] as `label  value` rows for a terminal.
pub fn insights_rows(v: &Value) -> Vec<(String, String)> {
    let days = v["days"].as_u64().unwrap_or(1);
    let turns = v["turns"].as_u64().unwrap_or(0);
    let mut rows = vec![("period".to_owned(), format!("the last {days} day{}", if days == 1 { "" } else { "s" }))];
    if turns == 0 {
        rows.push(("turns".to_owned(), "none yet".to_owned()));
        return rows;
    }
    let names = |key: &str| -> String {
        v[key]
            .as_array()
            .into_iter()
            .flatten()
            .map(|t| format!("{} {}", t["name"].as_str().unwrap_or("?"), t["count"]))
            .collect::<Vec<_>>()
            .join(" · ")
    };
    rows.push((
        "turns".to_owned(),
        format!(
            "{turns} · {} model calls · {} in · {} out · {}",
            v["calls"],
            tokens(v["tokens"]["input"].as_u64().unwrap_or(0)),
            tokens(v["tokens"]["output"].as_u64().unwrap_or(0)),
            duration(v["seconds"].as_f64().unwrap_or(0.0))
        ),
    ));
    let tools = names("tools");
    rows.push(("tools".to_owned(), if tools.is_empty() { "none".to_owned() } else { tools }));
    let projects = names("projects");
    if !projects.is_empty() {
        rows.push(("projects".to_owned(), projects));
    }
    let f = &v["failures"];
    rows.push((
        "failures".to_owned(),
        format!(
            "{} turns failed · {} stopped · {} tool errors · {} refused",
            f["errors"], f["stopped"], f["tool_errors"], f["refused"]
        ),
    ));
    let pct = |x: &Value| (x.as_f64().unwrap_or(1.0) * 100.0).round() as u64;
    rows.push((
        "local".to_owned(),
        format!(
            "{}% of model calls, {}% of tokens on your own hardware",
            pct(&v["local_share"]["calls"]),
            pct(&v["local_share"]["tokens"])
        ),
    ));
    let models: Vec<String> = v["models"]
        .as_array()
        .into_iter()
        .flatten()
        .map(|m| {
            format!(
                "{} {}{}",
                m["model"].as_str().unwrap_or("?"),
                m["calls"],
                if m["cloud"] == true { " (cloud)" } else { "" }
            )
        })
        .collect();
    if !models.is_empty() {
        rows.push(("models".to_owned(), models.join(" · ")));
    }
    let cost = v["cost"].as_f64().unwrap_or(0.0);
    if cost > 0.0 {
        rows.push(("cost".to_owned(), format!("${cost:.4}")));
    }
    rows
}

/// `--days N` (or `N`) in a command's arguments; 7 by default.
pub fn days_arg(arg: &str) -> Result<u32, String> {
    let words: Vec<&str> = arg.split_whitespace().collect();
    let n = match words.as_slice() {
        [] => return Ok(7),
        ["--days", n] | [n] => n,
        _ => return Err("--days N".to_owned()),
    };
    n.parse::<u32>().ok().filter(|d| (1..=3650).contains(d)).ok_or(format!("{n:?}: a number of days"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn call(model: &str, tier: &str, input: u64, output: u64) -> ModelCall {
        ModelCall { model: model.into(), tier: tier.into(), input, output, cached: 0 }
    }

    #[test]
    fn a_tally_pairs_receipts_with_their_usage() {
        let tally = Tally::default();
        tally.see(&Event::Receipt { id: "r1", model: Some("qwen"), tier: Some("node") });
        tally.see(&Event::Usage { input: 100, output: 20, cached: 50 });
        tally.see(&Event::Receipt { id: "f", model: Some("fetch"), tier: Some("web") });
        tally.see(&Event::Output { name: "read_file", text: "fn main() {}" });
        tally.see(&Event::Output { name: "terminal", text: "error: no such file" });
        tally.see(&Event::Output { name: "read_file", text: "x" });
        tally.see(&Event::Refused("no"));
        tally.see(&Event::Receipt { id: "r2", model: Some("deepseek"), tier: Some("cloud") });
        tally.see(&Event::Usage { input: 1000, output: 10, cached: 0 });
        let r = tally.finish("s", "app", 3.16, "answer");
        assert_eq!(
            r.calls,
            vec![ModelCall { cached: 50, ..call("qwen", "node", 100, 20) }, call("deepseek", "cloud", 1000, 10)]
        );
        assert_eq!(r.tools["read_file"], 2);
        assert_eq!((r.tool_errors, r.refused, r.seconds), (1, 1, 3.2));
    }

    #[test]
    fn usage_and_insights_sum_the_log() {
        let home = std::env::temp_dir().join(format!("autobot-insights-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&home);
        let log = Log::new(&home);
        let now = chrono::Utc::now().timestamp();
        let record = |session: &str, project: &str, outcome: &str, calls: Vec<ModelCall>, at: i64| Record {
            at,
            session: session.into(),
            project: project.into(),
            seconds: 2.0,
            outcome: outcome.into(),
            calls,
            tools: [("search".to_owned(), 3), ("terminal".to_owned(), 1)].into(),
            tool_errors: 1,
            refused: 0,
        };
        log.append(&record("a", "app", "answer", vec![call("qwen", "node", 1000, 100)], now)).unwrap();
        log.append(&record("a", "app", "error", vec![call("deepseek-chat", "cloud", 2_000_000, 1_000_000)], now))
            .unwrap();
        log.append(&record("b", "site", "stopped", vec![call("claude", "cloud", 10, 10)], now)).unwrap();
        log.append(&record("old", "x", "answer", vec![], now - 40 * 86_400)).unwrap();
        let prices: Prices = [("deepseek-chat".to_owned(), Price { input: 0.27, output: 1.1, cached: None })].into();
        let t = totals(&log.read(now - 60), &prices);
        assert_eq!((t.turns, t.calls, t.cloud_calls), (3, 3, 2));
        assert!((t.cost - (0.54 + 1.1)).abs() < 1e-9, "{}", t.cost);
        assert_eq!(t.unpriced, ["claude"]);
        let line = usage_line(&t);
        assert!(
            line.starts_with("3 turns · 3 model calls · 2.00M in · 1.00M out · 6.0s · 2 cloud calls · $1.6400"),
            "{line}"
        );
        assert!(line.ends_with("+ claude unpriced ([prices] in the config)"));
        let rows = usage(&home, Some("a"), &prices);
        assert_eq!(rows[0].0, "conversation");
        assert!(rows[0].1.starts_with("2 turns"), "{:?}", rows);
        let v = insights(&home, 7, &prices);
        assert_eq!(v["turns"], 3);
        assert_eq!(v["tools"][0]["name"], "search");
        assert_eq!(v["tools"][0]["count"], 9);
        assert_eq!(v["projects"][0]["name"], "app");
        assert_eq!(v["failures"]["errors"], 1);
        assert_eq!(v["failures"]["stopped"], 1);
        let rows = insights_rows(&v);
        assert!(rows.iter().any(|(k, v)| k == "local" && v.starts_with("33% of model calls")), "{rows:?}");
        assert_eq!(insights(&home, 60, &prices)["turns"], 4);
        assert_eq!(days_arg("").unwrap(), 7);
        assert_eq!(days_arg("--days 30").unwrap(), 30);
        assert_eq!(days_arg("3").unwrap(), 3);
        assert!(days_arg("--days x").is_err());
        assert_eq!(usage_line(&Totals::default()), "no turns");
        std::fs::remove_dir_all(home).unwrap();
    }
}
