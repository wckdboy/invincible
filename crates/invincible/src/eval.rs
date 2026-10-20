//! `invincible eval` (spec/evals.md): a task file run against models the gateway serves, every
//! answer checked by rule, so local and frontier models are compared on the same work, the same
//! way every time.

use std::collections::BTreeMap;
use std::time::Instant;

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Task {
    pub id: String,
    pub prompt: String,
    #[serde(default)]
    pub system: Option<String>,
    pub checks: Vec<Check>,
    #[serde(default)]
    pub tags: Vec<String>,
    #[serde(default)]
    pub max_tokens: Option<u64>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case", deny_unknown_fields)]
pub enum Check {
    Contains {
        value: String,
        #[serde(default = "yes")]
        ignore_case: bool,
    },
    NotContains {
        value: String,
        #[serde(default = "yes")]
        ignore_case: bool,
    },
    Equals {
        value: String,
        #[serde(default = "yes")]
        ignore_case: bool,
    },
    Regex {
        pattern: String,
    },
    Json {
        path: String,
        equals: Value,
    },
    MaxWords {
        value: usize,
    },
}

fn yes() -> bool {
    true
}

/// Reads a task file: JSON Lines, `#` comments and blank lines skipped, ids unique.
pub fn parse_tasks(text: &str) -> Result<Vec<Task>, String> {
    let mut tasks: Vec<Task> = Vec::new();
    for (n, line) in text.lines().enumerate() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let task: Task = serde_json::from_str(line).map_err(|e| format!("line {}: {e}", n + 1))?;
        if task.checks.is_empty() {
            return Err(format!("line {}: task {:?} has no checks", n + 1, task.id));
        }
        for check in &task.checks {
            if let Check::Regex { pattern } = check {
                regex::Regex::new(pattern).map_err(|e| format!("line {}: {e}", n + 1))?;
            }
        }
        if tasks.iter().any(|t| t.id == task.id) {
            return Err(format!("line {}: the id {:?} is used twice", n + 1, task.id));
        }
        tasks.push(task);
    }
    Ok(tasks)
}

/// The answer as checks see it: thinking removed, whitespace trimmed.
pub fn clean(answer: &str) -> String {
    let mut out = String::new();
    let mut rest = answer;
    while let Some(start) = rest.find("<think>") {
        out.push_str(&rest[..start]);
        match rest[start..].find("</think>") {
            Some(end) => rest = &rest[start + end + "</think>".len()..],
            None => {
                rest = "";
                break;
            }
        }
    }
    out.push_str(rest);
    out.trim().to_owned()
}

/// Ok, or why [check] fails on [answer].
pub fn check(check: &Check, answer: &str) -> Result<(), String> {
    let fold = |s: &str, ignore: bool| if ignore { s.to_lowercase() } else { s.to_owned() };
    match check {
        Check::Contains { value, ignore_case } => {
            if fold(answer, *ignore_case).contains(&fold(value, *ignore_case)) {
                Ok(())
            } else {
                Err(format!("does not contain {value:?}"))
            }
        }
        Check::NotContains { value, ignore_case } => {
            if fold(answer, *ignore_case).contains(&fold(value, *ignore_case)) {
                Err(format!("contains {value:?}"))
            } else {
                Ok(())
            }
        }
        Check::Equals { value, ignore_case } => {
            let a = answer.trim().trim_end_matches('.');
            if fold(a, *ignore_case) == fold(value.trim(), *ignore_case) {
                Ok(())
            } else {
                Err(format!("is not {value:?}"))
            }
        }
        Check::Regex { pattern } => match regex::Regex::new(pattern) {
            Ok(re) if re.is_match(answer) => Ok(()),
            Ok(_) => Err(format!("does not match /{pattern}/")),
            Err(e) => Err(e.to_string()),
        },
        Check::Json { path, equals } => {
            let value = json_in(answer).ok_or("has no JSON")?;
            let found =
                path.split('.').filter(|p| !p.is_empty()).try_fold(&value, |v, part| match part.parse::<usize>() {
                    Ok(i) => v.get(i),
                    Err(_) => v.get(part),
                });
            match found {
                Some(found) if same(found, equals) => Ok(()),
                Some(found) => Err(format!("{path} is {found}, not {equals}")),
                None => Err(format!("has no {path}")),
            }
        }
        Check::MaxWords { value } => {
            let words = answer.split_whitespace().count();
            if words <= *value { Ok(()) } else { Err(format!("{words} words, more than {value}")) }
        }
    }
}

/// JSON values compared as values: 4412 equals 4412.0, strings ignore case and surrounding space.
fn same(a: &Value, b: &Value) -> bool {
    match (a, b) {
        (Value::Number(x), Value::Number(y)) => x.as_f64() == y.as_f64(),
        (Value::String(x), Value::String(y)) => x.trim().eq_ignore_ascii_case(y.trim()),
        _ => a == b,
    }
}

/// The answer's JSON: all of it, a fenced block, or the span from the first `{`/`[` to the last.
fn json_in(answer: &str) -> Option<Value> {
    if let Ok(v) = serde_json::from_str(answer.trim()) {
        return Some(v);
    }
    if let Some(start) = answer.find("```") {
        let body = &answer[start + 3..];
        let body = body.strip_prefix("json").unwrap_or(body);
        if let Some(end) = body.find("```")
            && let Ok(v) = serde_json::from_str(body[..end].trim())
        {
            return Some(v);
        }
    }
    let start = answer.find(['{', '['])?;
    let end = answer.rfind(['}', ']'])?;
    (end > start).then(|| serde_json::from_str(&answer[start..=end]).ok()).flatten()
}

/// One task's outcome on one model.
#[derive(Clone, Debug, Serialize)]
pub struct Outcome {
    pub task: String,
    pub pass: bool,
    pub failed: Vec<String>,
    pub answer: String,
    pub latency_ms: u128,
    pub input_tokens: Option<u64>,
    pub output_tokens: Option<u64>,
    pub receipt: Option<String>,
    pub error: Option<String>,
}

/// How a run asks the models.
#[derive(Clone, Copy, Debug, Default)]
pub struct RunOptions {
    /// Answer the router's "ask" for cloud models; without it they are refused.
    pub confirmed: bool,
    /// Let thinking models think (with a larger budget); off, they are asked not to
    /// (llama.cpp's `enable_thinking`), so a task's budget goes to the answer.
    pub thinking: bool,
}

/// Answer tokens when a task sets none: room for the answer, or for thinking first.
const DEFAULT_MAX_TOKENS: u64 = 1024;
const THINKING_MAX_TOKENS: u64 = 8192;

/// Runs [tasks] on [model] through the gateway at [base] (`http://127.0.0.1:7777/v1`).
pub async fn run_model(
    client: &reqwest::Client,
    base: &str,
    token: &str,
    model: &str,
    tasks: &[Task],
    options: RunOptions,
    mut progress: impl FnMut(&Outcome),
) -> Vec<Outcome> {
    let mut outcomes = Vec::new();
    for task in tasks {
        let mut messages = Vec::new();
        if let Some(system) = &task.system {
            messages.push(json!({ "role": "system", "content": system }));
        }
        messages.push(json!({ "role": "user", "content": task.prompt }));
        let max_tokens = match (options.thinking, task.max_tokens) {
            (true, n) => n.unwrap_or(0).max(THINKING_MAX_TOKENS),
            (false, n) => n.unwrap_or(DEFAULT_MAX_TOKENS),
        };
        let mut body = json!({ "model": model, "messages": messages, "max_tokens": max_tokens, "temperature": 0, "stream": false });
        if !options.thinking {
            body["chat_template_kwargs"] = json!({ "enable_thinking": false });
        }
        let started = Instant::now();
        let mut request = client.post(format!("{base}/chat/completions")).bearer_auth(token).json(&body);
        if options.confirmed {
            request = request.header("invincible-confirmed", "1");
        }
        let result = async {
            let response = request.send().await.map_err(|e| {
                if e.is_connect() {
                    format!("the gateway is not running at {base} (start it with `invincible serve`)")
                } else {
                    e.to_string()
                }
            })?;
            let receipt = response
                .headers()
                .get(crate::receipts::REQUEST_ID_HEADER)
                .and_then(|v| v.to_str().ok())
                .map(str::to_owned);
            let status = response.status();
            let reply: Value = response.json().await.map_err(|e| e.to_string())?;
            if !status.is_success() {
                return Err(reply["error"]["message"].as_str().unwrap_or("failed").to_owned());
            }
            Ok((reply, receipt))
        }
        .await;
        let latency_ms = started.elapsed().as_millis();
        let outcome = match result {
            Ok((reply, receipt)) => {
                let answer = clean(reply["choices"][0]["message"]["content"].as_str().unwrap_or_default());
                let mut failed: Vec<String> = task.checks.iter().filter_map(|c| check(c, &answer).err()).collect();
                // Not a wrong answer: no answer, because the budget ran out (thinking, usually).
                if answer.is_empty() && reply["choices"][0]["finish_reason"] == "length" {
                    failed = vec![format!(
                        "ran out of tokens before answering ({max_tokens}){}",
                        if options.thinking { "" } else { "; try --thinking" }
                    )];
                }
                Outcome {
                    task: task.id.clone(),
                    pass: failed.is_empty(),
                    failed,
                    answer,
                    latency_ms,
                    input_tokens: reply["usage"]["prompt_tokens"].as_u64(),
                    output_tokens: reply["usage"]["completion_tokens"].as_u64(),
                    receipt,
                    error: None,
                }
            }
            Err(e) => Outcome {
                task: task.id.clone(),
                pass: false,
                failed: Vec::new(),
                answer: String::new(),
                latency_ms,
                input_tokens: None,
                output_tokens: None,
                receipt: None,
                error: Some(e),
            },
        };
        progress(&outcome);
        outcomes.push(outcome);
    }
    outcomes
}

/// The report: pass rate and median latency per model, per tag, and the tasks the models disagree on.
pub fn report(tasks: &[Task], results: &[(String, Vec<Outcome>)]) -> String {
    let mut out = String::new();
    let width = results.iter().map(|(m, _)| m.len()).max().unwrap_or(5).max(5);
    out.push_str(&format!("{:width$}  pass        median\n", "model"));
    for (model, outcomes) in results {
        let passed = outcomes.iter().filter(|o| o.pass).count();
        let mut latencies: Vec<u128> = outcomes.iter().filter(|o| o.error.is_none()).map(|o| o.latency_ms).collect();
        latencies.sort_unstable();
        let median =
            latencies.get(latencies.len() / 2).map_or("-".to_owned(), |ms| format!("{:.1} s", *ms as f64 / 1000.0));
        out.push_str(&format!(
            "{model:width$}  {passed:>3}/{:<3} {:>3}%  {median}\n",
            outcomes.len(),
            percent(passed, outcomes.len())
        ));
    }
    let mut tags: BTreeMap<&str, Vec<&str>> = BTreeMap::new();
    for task in tasks {
        for tag in &task.tags {
            tags.entry(tag).or_default().push(&task.id);
        }
    }
    if !tags.is_empty() {
        out.push_str("\nby tag\n");
        for (tag, ids) in &tags {
            let cells: Vec<String> = results
                .iter()
                .map(|(model, outcomes)| {
                    let passed = outcomes.iter().filter(|o| o.pass && ids.contains(&o.task.as_str())).count();
                    format!("{model} {passed}/{}", ids.len())
                })
                .collect();
            out.push_str(&format!("  {tag:14} {}\n", cells.join(" · ")));
        }
    }
    if results.len() > 1 {
        let differ: Vec<String> = tasks
            .iter()
            .filter_map(|task| {
                let passes: Vec<bool> =
                    results.iter().filter_map(|(_, o)| o.iter().find(|o| o.task == task.id).map(|o| o.pass)).collect();
                (passes.iter().any(|p| *p) && passes.iter().any(|p| !*p)).then(|| {
                    let who: Vec<String> = results
                        .iter()
                        .map(|(m, o)| {
                            format!("{m} {}", if o.iter().any(|o| o.task == task.id && o.pass) { "✓" } else { "✗" })
                        })
                        .collect();
                    format!("  {}: {}", task.id, who.join(", "))
                })
            })
            .collect();
        if !differ.is_empty() {
            out.push_str(&format!("\nwhere they differ ({})\n{}\n", differ.len(), differ.join("\n")));
        }
    }
    out
}

fn percent(n: usize, of: usize) -> usize {
    if of == 0 { 0 } else { n * 100 / of }
}

/// One run of a suite, kept in `$INVINCIBLE_HOME/evals/history.jsonl` so the gap between the
/// node's models and the cloud's can be followed over time.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Run {
    /// When it ran (RFC 3339).
    pub at: String,
    /// The task file's name, without its extension (`projects`).
    pub suite: String,
    /// The tasks as written, hashed ([digest]): runs of the same tasks compare; a task that
    /// changed starts anew.
    pub digest: String,
    pub tasks: usize,
    /// `answers` (`invincible eval`) or `agent` (`autobot eval`).
    #[serde(default = "answers")]
    pub kind: String,
    /// The version that ran it.
    pub version: String,
    pub models: Vec<ModelRun>,
}

fn answers() -> String {
    "answers".to_owned()
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct ModelRun {
    pub model: String,
    /// `node`, `cloud`, …, as the gateway lists it (None: not listed, `auto` for one).
    #[serde(default)]
    pub tier: Option<String>,
    pub passed: usize,
    pub total: usize,
    #[serde(default)]
    pub median_ms: Option<u64>,
    /// Tasks it gave no answer to (refused, unreachable, failed): it is left out of the gap then.
    #[serde(default)]
    pub errors: usize,
}

/// The digest of the tasks [ids] in the task file [text]: each one as written (its prompt,
/// checks, files, limits), in the file's order, as JSON with sorted keys, one per line.
pub fn digest(text: &str, ids: &[&str]) -> String {
    use sha2::{Digest, Sha256};
    let mut hasher = Sha256::new();
    for line in text.lines().map(str::trim).filter(|l| !l.is_empty() && !l.starts_with('#')) {
        let Ok(task) = serde_json::from_str::<Value>(line) else { continue };
        if task["id"].as_str().is_some_and(|id| ids.contains(&id)) {
            hasher.update(task.to_string().as_bytes());
            hasher.update(b"\n");
        }
    }
    crate::token::hex(&hasher.finalize()[..6])
}

/// A model's line in a [Run]: how many passed and the median time of those that answered.
pub fn model_run(model: &str, tier: Option<String>, outcomes: &[Outcome]) -> ModelRun {
    let mut latencies: Vec<u128> = outcomes.iter().filter(|o| o.error.is_none()).map(|o| o.latency_ms).collect();
    latencies.sort_unstable();
    ModelRun {
        model: model.to_owned(),
        tier,
        passed: outcomes.iter().filter(|o| o.pass).count(),
        total: outcomes.len(),
        median_ms: latencies.get(latencies.len() / 2).map(|ms| *ms as u64),
        errors: outcomes.iter().filter(|o| o.error.is_some()).count(),
    }
}

/// Where the history is.
pub fn history_path(home: &std::path::Path) -> std::path::PathBuf {
    home.join("evals").join("history.jsonl")
}

/// Adds [run] to the history in [home].
pub fn record(home: &std::path::Path, run: &Run) -> Result<(), String> {
    use std::io::Write as _;
    let path = history_path(home);
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| format!("{}: {e}", dir.display()))?;
    }
    let line = serde_json::to_string(run).map_err(|e| e.to_string())?;
    let mut file = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
        .map_err(|e| format!("{}: {e}", path.display()))?;
    writeln!(file, "{line}").map_err(|e| format!("{}: {e}", path.display()))
}

/// The runs in [home]'s history, oldest first (lines that do not read are skipped).
pub fn history(home: &std::path::Path) -> Vec<Run> {
    std::fs::read_to_string(history_path(home))
        .unwrap_or_default()
        .lines()
        .filter_map(|line| serde_json::from_str(line).ok())
        .collect()
}

fn rate(m: &ModelRun) -> f64 {
    if m.total == 0 { 0.0 } else { m.passed as f64 / m.total as f64 }
}

/// The best model on this machine and the best in the cloud in [run], when it had both (that
/// answered every task): the gap is the second's pass rate less the first's.
pub fn gap(run: &Run) -> Option<(&ModelRun, &ModelRun)> {
    let best = |tier: &str| {
        run.models
            .iter()
            .filter(|m| m.tier.as_deref() == Some(tier) && m.errors == 0)
            .max_by(|a, b| rate(a).total_cmp(&rate(b)))
    };
    Some((best("node")?, best("cloud")?))
}

/// `invincible eval --history`: each suite's runs, oldest first, every model's score, and the
/// gap between the best local and the best cloud model; [suite] for one suite only.
pub fn history_report(runs: &[Run], suite: Option<&str>) -> String {
    let mut groups: BTreeMap<(&str, &str, &str), Vec<&Run>> = BTreeMap::new();
    // A file's runs include those of some of its tasks (`name#tag`), unless a tag is asked for.
    let wanted = |r: &Run| {
        suite.is_none_or(|s| {
            r.suite == s || (!s.contains('#') && r.suite.strip_prefix(s).is_some_and(|t| t.starts_with('#')))
        })
    };
    for run in runs.iter().filter(|r| wanted(r)) {
        groups.entry((run.kind.as_str(), run.suite.as_str(), run.digest.as_str())).or_default().push(run);
    }
    if groups.is_empty() {
        return match suite {
            Some(s) => format!("no runs of {s} yet"),
            None => "no runs yet: `invincible eval FILE --model …` keeps each one".to_owned(),
        };
    }
    let mut out = String::new();
    for ((kind, name, digest), runs) in groups {
        let tasks = runs[0].tasks;
        let what = if kind == "agent" { "agent tasks" } else { "tasks" };
        out.push_str(&format!("{name} ({tasks} {what}, {digest})\n"));
        for run in &runs {
            let day = run.at.get(..16).unwrap_or(&run.at).replace('T', " ");
            let cells: Vec<String> = run
                .models
                .iter()
                .map(|m| {
                    let tier = m.tier.as_deref().map(|t| format!(" [{t}]")).unwrap_or_default();
                    let errors = if m.errors > 0 { format!(" ({} unanswered)", m.errors) } else { String::new() };
                    format!("{}{tier} {}/{}{errors}", m.model, m.passed, m.total)
                })
                .collect();
            let gap = gap(run)
                .map(|(local, cloud)| {
                    let points = ((rate(cloud) - rate(local)) * 100.0).round() as i64;
                    format!("  gap {points:+} points ({} → {})", local.model, cloud.model)
                })
                .unwrap_or_default();
            out.push_str(&format!("  {day}  {}{gap}\n", cells.join(" · ")));
        }
        // Across the runs that had both: where it started and where it is.
        let gaps: Vec<i64> =
            runs.iter().filter_map(|r| gap(r).map(|(l, c)| ((rate(c) - rate(l)) * 100.0).round() as i64)).collect();
        if gaps.len() > 1 {
            out.push_str(&format!("  the gap: {:+} points then, {:+} now\n", gaps[0], gaps[gaps.len() - 1]));
        }
        out.push('\n');
    }
    out.trim_end().to_owned()
}

#[cfg(test)]
mod tests {
    use super::{
        Check, ModelRun, Run, check, clean, digest, gap, history, history_report, parse_tasks, record, report,
    };
    use serde_json::json;

    fn c(v: serde_json::Value) -> Check {
        serde_json::from_value(v).unwrap()
    }

    #[test]
    fn checks() {
        assert!(check(&c(json!({"type": "contains", "value": "PARIS"})), "It is Paris.").is_ok());
        assert!(
            check(&c(json!({"type": "contains", "value": "PARIS", "ignore_case": false})), "It is Paris.").is_err()
        );
        assert!(check(&c(json!({"type": "not_contains", "value": "sorry"})), "Sure.").is_ok());
        assert!(check(&c(json!({"type": "equals", "value": "42"})), " 42.\n").is_ok());
        assert!(check(&c(json!({"type": "equals", "value": "42"})), "It is 42").is_err());
        assert!(check(&c(json!({"type": "regex", "pattern": "^\\d{4}-\\d{2}-\\d{2}$"})), "2026-10-19").is_ok());
        assert!(check(&c(json!({"type": "max_words", "value": 3})), "one two three four").is_err());
        let fenced = "Here:\n```json\n{\"order\": 4412, \"items\": [{\"sku\": \"a\"}]}\n```";
        assert!(check(&c(json!({"type": "json", "path": "order", "equals": 4412})), fenced).is_ok());
        assert!(check(&c(json!({"type": "json", "path": "items.0.sku", "equals": "A"})), fenced).is_ok());
        assert_eq!(
            check(&c(json!({"type": "json", "path": "city", "equals": "Oslo"})), fenced).unwrap_err(),
            "has no city"
        );
        assert!(check(&c(json!({"type": "json", "path": "n", "equals": 3})), "the result is {\"n\": 3.0} ok").is_ok());
        assert!(check(&c(json!({"type": "json", "path": "n", "equals": 3})), "no json here").is_err());
    }

    #[test]
    fn thinking_is_removed() {
        assert_eq!(clean("<think>hmm\nlet me see</think>\n\n  Paris  "), "Paris");
        assert_eq!(clean("a<think>x</think>b<think>unfinished"), "ab");
    }

    #[test]
    fn task_files_are_checked() {
        let ok = "# a comment\n\n{\"id\": \"a\", \"prompt\": \"p\", \"checks\": [{\"type\": \"contains\", \"value\": \"x\"}], \"tags\": [\"t\"]}\n";
        assert_eq!(parse_tasks(ok).unwrap().len(), 1);
        assert!(parse_tasks("{\"id\": \"a\", \"prompt\": \"p\", \"checks\": []}").is_err());
        assert!(parse_tasks(&format!("{ok}{ok}")).unwrap_err().contains("used twice"));
        assert!(
            parse_tasks("{\"id\": \"a\", \"prompt\": \"p\", \"checks\": [{\"type\": \"regex\", \"pattern\": \"(\"}]}")
                .is_err()
        );
        assert!(parse_tasks("{\"id\": \"a\", \"prompt\": \"p\", \"checks\": [{\"type\": \"vibes\"}]}").is_err());
    }

    #[test]
    fn the_report_compares_models() {
        let tasks = parse_tasks(
            "{\"id\": \"a\", \"prompt\": \"p\", \"checks\": [{\"type\": \"contains\", \"value\": \"x\"}], \"tags\": [\"t\"]}\n\
             {\"id\": \"b\", \"prompt\": \"p\", \"checks\": [{\"type\": \"contains\", \"value\": \"x\"}], \"tags\": [\"t\"]}",
        )
        .unwrap();
        let outcome = |task: &str, pass: bool| super::Outcome {
            task: task.into(),
            pass,
            failed: vec![],
            answer: String::new(),
            latency_ms: 1500,
            input_tokens: None,
            output_tokens: None,
            receipt: None,
            error: None,
        };
        let text = report(
            &tasks,
            &[
                ("local".into(), vec![outcome("a", true), outcome("b", false)]),
                ("cloud".into(), vec![outcome("a", true), outcome("b", true)]),
            ],
        );
        assert!(text.contains("local    1/2    50%  1.5 s"), "{text}");
        assert!(text.contains("t              local 1/2 · cloud 2/2"), "{text}");
        assert!(text.contains("b: local ✗, cloud ✓"), "{text}");
    }

    const TASKS: &str = "{\"id\": \"a\", \"prompt\": \"2 + 2?\", \"checks\": []}\n{\"id\": \"b\", \"prompt\": \"3 + 3?\", \"checks\": []}";

    #[test]
    fn history_keeps_runs_and_the_gap() {
        let home = std::env::temp_dir().join(format!("invincible-eval-history-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&home);
        let m = |model: &str, tier: Option<&str>, passed| ModelRun {
            model: model.into(),
            tier: tier.map(str::to_owned),
            passed,
            total: 50,
            median_ms: Some(200),
            errors: 0,
        };
        let run = |at: &str, local: usize| Run {
            at: at.into(),
            suite: "projects".into(),
            digest: digest(TASKS, &["a", "b"]),
            tasks: 50,
            kind: "answers".into(),
            version: "0.0.18".into(),
            models: vec![m("qwen3.5-4b", Some("node"), local), m("deepseek", Some("cloud"), 45), m("auto", None, 40)],
        };
        assert!(history(&home).is_empty());
        assert!(history_report(&[], None).starts_with("no runs yet"));
        record(&home, &run("2026-10-01T10:00:00+02:00", 30)).unwrap();
        record(&home, &run("2026-10-20T10:00:00+02:00", 35)).unwrap();
        // A changed suite is a suite of its own.
        let mut other = run("2026-10-21T10:00:00+02:00", 1);
        other.digest = digest(TASKS, &["a"]);
        record(&home, &other).unwrap();
        let runs = history(&home);
        assert_eq!(runs.len(), 3);
        let (local, cloud) = gap(&runs[0]).unwrap();
        assert_eq!((local.model.as_str(), cloud.model.as_str()), ("qwen3.5-4b", "deepseek"));
        let text = history_report(&runs, Some("projects"));
        assert!(text.contains("gap +30 points (qwen3.5-4b → deepseek)"), "{text}");
        assert!(text.contains("gap +20 points"), "{text}");
        assert!(text.contains("the gap: +30 points then, +20 now"), "{text}");
        assert!(text.contains("auto 40/50") && !text.contains("auto ["), "{text}");
        assert_eq!(text.matches("projects (50 tasks").count(), 2, "two suites by digest: {text}");
        assert_eq!(history_report(&runs, Some("seed")), "no runs of seed yet");
        // A task that changed (same id) is a suite of its own; a comment or another task is not.
        let edited = TASKS.replace("2 + 2?", "2 + 3?");
        assert_ne!(digest(&edited, &["a", "b"]), digest(TASKS, &["a", "b"]));
        let more = format!("# a comment\n{TASKS}\n{{\"id\": \"c\", \"prompt\": \"x\"}}");
        assert_eq!(digest(&more, &["a", "b"]), digest(TASKS, &["a", "b"]));
        // Tagged runs come with their file's, unless a tag is asked for.
        let mut tagged = run("2026-10-23T10:00:00+02:00", 30);
        tagged.suite = "projects#rust".into();
        let with = [runs.clone(), vec![tagged]].concat();
        assert!(history_report(&with, Some("projects")).contains("projects#rust"));
        assert!(!history_report(&with, Some("projects#rust")).contains("projects (50"));
        // A cloud model that did not answer is no side of a gap.
        let mut refused = run("2026-10-24T10:00:00+02:00", 30);
        refused.models[1].errors = 50;
        assert!(gap(&refused).is_none());
        assert!(history_report(&[refused], None).contains("(50 unanswered)"));
        // Without a model of both kinds: no gap.
        let mut local_only = run("2026-10-22T10:00:00+02:00", 30);
        local_only.models.remove(1);
        assert!(gap(&local_only).is_none());
        std::fs::remove_dir_all(home).unwrap();
    }
}
