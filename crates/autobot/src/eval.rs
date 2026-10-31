//! `autobot eval`: agent tasks run for real, checked by rule. Each task gets a fresh working
//! directory with its files, the agent works it with its tools (commands write-confined, approvals
//! answered yes: the directory is a throwaway), and checks look at the files it left and its
//! answer. The same tasks run on any model the gateway serves, so a local model's agent work is
//! compared with a frontier model's, on this machine. `--trajectories FILE` keeps the passing
//! runs as fine-tuning data ([crate::trajectory]): a frontier model's good work, to teach a
//! local one.
//!
//! A task file is JSON Lines (`#` comments allowed):
//!
//! ```json
//! {"id": "fix-script", "prompt": "count.sh should print 3; fix it and run it",
//!  "files": {"count.sh": "echo $((1 + 1))\n"},
//!  "checks": [{"type": "file_contains", "path": "count.sh", "value": "+ 2"},
//!             {"type": "answer", "check": {"type": "contains", "value": "3"}}]}
//! ```

use std::collections::{BTreeMap, HashSet};
use std::future::Future;
use std::path::Path;
use std::pin::Pin;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};

use crate::approval::{Action, Answer, Approver};

#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Task {
    pub id: String,
    pub prompt: String,
    /// Files to start with, by path in the working directory.
    #[serde(default)]
    pub files: BTreeMap<String, String>,
    pub checks: Vec<Check>,
    #[serde(default)]
    pub tags: Vec<String>,
    /// Model calls allowed (default 12).
    #[serde(default)]
    pub max_steps: Option<usize>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case", deny_unknown_fields)]
pub enum Check {
    /// The file exists and contains [value] (case-sensitive).
    FileContains {
        path: String,
        value: String,
    },
    /// The file exists and its contents, trimmed, are [value].
    FileEquals {
        path: String,
        value: String,
    },
    FileAbsent {
        path: String,
    },
    /// The file exists and does not contain [value].
    FileNotContains {
        path: String,
        value: String,
    },
    /// [command] (sh, in the working directory, after the agent is done) exits 0: a task's own
    /// tests, say.
    CommandOk {
        command: String,
    },
    /// The agent's answer passes [check] (the checks of `invincible eval`).
    Answer {
        check: invincible::eval::Check,
    },
    /// It called this tool at least once.
    UsedTool {
        name: String,
    },
}

#[derive(Clone, Debug, Serialize)]
pub struct Outcome {
    pub id: String,
    pub model: String,
    pub pass: bool,
    pub failures: Vec<String>,
    pub answer: String,
    pub tools: Vec<String>,
    pub steps: usize,
    pub seconds: f64,
    /// The agent never got to work it (the gateway refused or was not there).
    pub error: bool,
    /// The run's turn as a trajectory ([crate::trajectory]), marked with the task and whether it
    /// passed.
    #[serde(skip)]
    pub trajectories: Vec<serde_json::Value>,
}

/// Reads a task file.
pub fn parse(text: &str) -> Result<Vec<Task>, String> {
    let mut tasks: Vec<Task> = Vec::new();
    for (n, line) in text.lines().enumerate() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let task: Task = serde_json::from_str(line).map_err(|e| format!("line {}: {e}", n + 1))?;
        if tasks.iter().any(|t| t.id == task.id) {
            return Err(format!("line {}: the id {:?} is used twice", n + 1, task.id));
        }
        if let Some(bad) = task.files.keys().find(|p| Path::new(p).is_absolute() || p.contains("..")) {
            return Err(format!("line {}: {bad:?}: files are relative paths in the working directory", n + 1));
        }
        tasks.push(task);
    }
    Ok(tasks)
}

/// Says yes to everything but a GPU rental: the working directory is a throwaway, and commands'
/// own writes go only there and to temporary directories ([crate::sandbox]; reads, the network and
/// the programs a command talks to are not confined).
struct Yes;

impl Approver for Yes {
    fn approve<'a>(&'a self, action: &'a Action) -> Pin<Box<dyn Future<Output = Answer> + Send + 'a>> {
        let rent = matches!(action, Action::Rent { .. });
        Box::pin(async move { if rent { Answer::Deny } else { Answer::Once } })
    }

    fn channel(&self) -> &'static str {
        "eval"
    }
}

/// Runs [task] with [agent] (its gateway asking for [model]) in a fresh directory under [scratch].
pub async fn run(
    agent: &crate::agent::Agent,
    model: &str,
    task: &Task,
    scratch: &Path,
    only: Option<Vec<String>>,
) -> Outcome {
    let dir = scratch.join(format!("{}-{}", task.id, model.replace(['/', ':'], "_")));
    let _ = std::fs::remove_dir_all(&dir);
    let work = dir.join("work");
    let mut failures = Vec::new();
    let mut error = false;
    for (path, content) in &task.files {
        let file = work.join(path);
        if let Some(parent) = file.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        if let Err(e) = std::fs::write(&file, content) {
            failures.push(format!("setup {path}: {e}"));
        }
    }
    let _ = std::fs::create_dir_all(&work);
    let mut worker = agent.clone();
    worker.gateway = worker.gateway.with_model(model);
    worker.tools = crate::tools::Tools::new(work.clone(), Duration::from_secs(60))
        .with_home(dir.join("home"))
        .with_sandbox(crate::sandbox::Mode::Always);
    if let Some(only) = only {
        worker.tools = worker.tools.only(only);
    }
    worker.approvals = crate::config::ApprovalConfig { mode: crate::config::ApprovalMode::Ask, allow: Vec::new() };
    worker.max_steps = task.max_steps.unwrap_or(12);
    worker.team = Default::default();
    let recorder = std::sync::Arc::new(crate::trajectory::Recorder::memory());
    worker.trajectories = Some(recorder.clone());
    let tools = std::sync::Mutex::new(Vec::<String>::new());
    let events = |event: crate::agent::Event| {
        if let crate::agent::Event::Tool(what) = event {
            tools.lock().expect("tools").push(what.split([' ', ':']).next().unwrap_or_default().to_owned());
        }
    };
    let started = Instant::now();
    let mut session = match crate::session::Session::open(&dir.join("sessions"), "eval") {
        Ok(session) => session,
        Err(e) => return Outcome::failed(task, model, e),
    };
    let answer = match worker.turn(&mut session, &task.prompt, &Yes, &mut HashSet::new(), &events).await {
        Ok(outcome) => outcome.text,
        Err(e) => {
            failures.push(format!("the turn failed: {e}"));
            error = true;
            String::new()
        }
    };
    let steps = session.messages.iter().filter(|m| m["role"] == "assistant").count();
    let tools = tools.into_inner().unwrap_or_default();
    // Tool names as the model called them (the events describe actions: `run`, `write`, …).
    let called: Vec<String> = session
        .messages
        .iter()
        .filter_map(|m| m["tool_calls"].as_array())
        .flatten()
        .filter_map(|c| c["function"]["name"].as_str().map(str::to_owned))
        .collect();
    for check in &task.checks {
        if let Err(e) = verify(check, &work, &answer, &called) {
            failures.push(e);
        }
    }
    let pass = failures.is_empty();
    let mut trajectories = recorder.take();
    for t in &mut trajectories {
        t["meta"]["source"] = "eval".into();
        t["meta"]["task"] = task.id.clone().into();
        t["meta"]["pass"] = pass.into();
    }
    Outcome {
        id: task.id.clone(),
        model: model.to_owned(),
        pass,
        failures,
        answer,
        tools: if called.is_empty() { tools } else { called },
        steps,
        seconds: started.elapsed().as_secs_f64(),
        error,
        trajectories,
    }
}

impl Outcome {
    fn failed(task: &Task, model: &str, why: String) -> Self {
        Self {
            id: task.id.clone(),
            model: model.to_owned(),
            pass: false,
            failures: vec![why],
            answer: String::new(),
            tools: Vec::new(),
            steps: 0,
            seconds: 0.0,
            error: true,
            trajectories: Vec::new(),
        }
    }
}

fn verify(check: &Check, work: &Path, answer: &str, called: &[String]) -> Result<(), String> {
    let read = |path: &str| std::fs::read_to_string(work.join(path)).map_err(|_| format!("{path} is missing"));
    match check {
        Check::FileContains { path, value } => {
            let text = read(path)?;
            if text.contains(value.as_str()) { Ok(()) } else { Err(format!("{path} does not contain {value:?}")) }
        }
        Check::FileEquals { path, value } => {
            let text = read(path)?;
            if text.trim() == value.trim() {
                Ok(())
            } else {
                Err(format!("{path} is {:?}, not {value:?}", text.trim()))
            }
        }
        Check::FileAbsent { path } => {
            if work.join(path).exists() {
                Err(format!("{path} should not exist"))
            } else {
                Ok(())
            }
        }
        Check::FileNotContains { path, value } => {
            let text = read(path)?;
            if text.contains(value.as_str()) { Err(format!("{path} still contains {value:?}")) } else { Ok(()) }
        }
        Check::CommandOk { command } => {
            // The command comes from the operator-authored eval spec and running it is
            // the check's purpose; the spec is trusted input, not agent output.
            // nosemgrep: agents.config.eng-rust-command-shell
            let out = std::process::Command::new("sh")
                .arg("-c")
                .arg(command)
                .current_dir(work)
                .output()
                .map_err(|e| format!("{command}: {e}"))?;
            if out.status.success() {
                Ok(())
            } else {
                let err = String::from_utf8_lossy(&out.stderr);
                Err(format!("`{command}` failed: {}", err.lines().last().unwrap_or_default()))
            }
        }
        Check::Answer { check } => invincible::eval::check(check, answer).map_err(|e| format!("the answer {e}")),
        Check::UsedTool { name } => {
            if called.iter().any(|c| c == name) {
                Ok(())
            } else {
                Err(format!("never called {name}"))
            }
        }
    }
}

/// The table `autobot eval` prints: pass rate, median time and steps per model.
pub fn report(outcomes: &[Outcome], models: &[String]) -> String {
    let mut out = format!("{:<20} {:>7} {:>9} {:>7}\n", "model", "pass", "median", "steps");
    for model in models {
        let mine: Vec<&Outcome> = outcomes.iter().filter(|o| &o.model == model).collect();
        let passed = mine.iter().filter(|o| o.pass).count();
        let mut times: Vec<f64> = mine.iter().map(|o| o.seconds).collect();
        times.sort_by(|a, b| a.total_cmp(b));
        let median = times.get(times.len() / 2).copied().unwrap_or_default();
        let steps: usize = mine.iter().map(|o| o.steps).sum();
        out.push_str(&format!(
            "{model:<20} {:>7} {:>8.1}s {:>7.1}\n",
            format!("{passed}/{}", mine.len()),
            median,
            steps as f64 / mine.len().max(1) as f64
        ));
    }
    out
}

#[cfg(test)]
mod tests {
    use super::{Check, parse, verify};

    #[test]
    fn tasks_parse_and_checks_look_at_files_and_the_answer() {
        let tasks = parse(
            "# a comment\n{\"id\": \"t\", \"prompt\": \"p\", \"files\": {\"a.txt\": \"x\"}, \"checks\": [{\"type\": \"file_contains\", \"path\": \"a.txt\", \"value\": \"x\"}, {\"type\": \"answer\", \"check\": {\"type\": \"contains\", \"value\": \"done\"}}]}\n",
        )
        .unwrap();
        assert_eq!(tasks[0].files["a.txt"], "x");
        assert!(parse("{\"id\": \"t\", \"prompt\": \"p\", \"files\": {\"../x\": \"\"}, \"checks\": []}").is_err());
        let dir = std::env::temp_dir().join(format!("autobot-eval-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("a.txt"), " 42 \n").unwrap();
        let ok = |c: Check| verify(&c, &dir, "All done.", &["edit_file".into()]);
        assert!(ok(Check::FileEquals { path: "a.txt".into(), value: "42".into() }).is_ok());
        assert!(ok(Check::FileContains { path: "a.txt".into(), value: "43".into() }).is_err());
        assert!(ok(Check::FileAbsent { path: "a.txt".into() }).is_err());
        assert!(ok(Check::FileAbsent { path: "b.txt".into() }).is_ok());
        assert!(ok(Check::UsedTool { name: "edit_file".into() }).is_ok());
        assert!(ok(Check::UsedTool { name: "terminal".into() }).is_err());
        assert!(
            ok(Check::Answer { check: invincible::eval::Check::Contains { value: "done".into(), ignore_case: true } })
                .is_ok()
        );
        std::fs::remove_dir_all(dir).unwrap();
    }
}
