//! What a turn looks like in the terminal: a spinner while the model thinks, the answer as it
//! streams (Markdown, a line at a time), each tool call as a line with what it gave back, diffs
//! of changes in color, and a status line at the end.

use std::io::Write;
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::Instant;

use serde_json::Value;

use super::markdown::Markdown;
use super::style;
use crate::agent::Event;

const FRAMES: &[&str] = &["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

pub struct Ui {
    state: Mutex<State>,
    workdir: PathBuf,
}

#[derive(Default)]
struct State {
    /// What the spinner says, and since when; None: no spinner.
    spinner: Option<(String, Instant)>,
    /// The last of the model's reasoning, shown after the spinner.
    thought: String,
    shown: bool,
    paused: bool,
    frame: usize,
    /// The answer's current line, printed as it came (rewritten styled when it ends).
    live: String,
    md: Markdown,
    answering: bool,
    /// The last diff's +/− counts, for the edit's result line.
    diff: Option<(usize, usize)>,
    /// The change's line was printed with its diff (the tool line that follows is not).
    headed: bool,
    started: Option<Instant>,
    models: Vec<String>,
    calls: usize,
    /// Tokens this turn: input, output, cached input.
    tokens: (u64, u64, u64),
}

impl Ui {
    pub fn new(workdir: PathBuf) -> Self {
        Self { state: Mutex::default(), workdir }
    }

    pub fn workdir(&self) -> &std::path::Path {
        &self.workdir
    }

    fn out(text: &str) {
        let mut out = std::io::stdout().lock();
        let _ = out.write_all(text.as_bytes());
        let _ = out.flush();
    }

    /// A turn starts: the spinner, and fresh numbers for its status line.
    pub fn begin(&self) {
        let mut s = self.state.lock().expect("ui");
        *s = State { started: Some(Instant::now()), ..State::default() };
        s.spinner = Some(("thinking".into(), Instant::now()));
    }

    /// Redraws the spinner (called a few times a second).
    pub fn tick(&self) {
        let mut s = self.state.lock().expect("ui");
        if s.paused || !s.live.is_empty() {
            return;
        }
        let Some((label, since)) = s.spinner.clone() else { return };
        s.frame = (s.frame + 1) % FRAMES.len();
        let mut line = format!(
            "{} {} {}",
            style::accent(FRAMES[s.frame]),
            style::accent(&label),
            style::gray(&format!("{:.0}s", since.elapsed().as_secs_f64()))
        );
        if !s.thought.is_empty() {
            let room = style::columns().saturating_sub(label.len() + 12);
            let thought: String = s.thought.chars().rev().take(room).collect::<Vec<_>>().into_iter().rev().collect();
            line.push_str(&format!(" {}", style::gray(&style::italic(&thought))));
        }
        line.push_str(&style::gray("  ctrl+c to stop"));
        Self::out(&format!("\r\x1b[2K{line}"));
        s.shown = true;
    }

    fn unspin(s: &mut State) {
        if s.shown {
            Self::out("\r\x1b[2K");
            s.shown = false;
        }
    }

    fn spin(s: &mut State, label: &str) {
        s.spinner = Some((label.to_owned(), Instant::now()));
        s.thought.clear();
    }

    /// Stops the spinner while the owner is asked something.
    pub fn pause(&self) {
        let mut s = self.state.lock().expect("ui");
        Self::finish_line(&mut s);
        Self::unspin(&mut s);
        s.paused = true;
    }

    pub fn resume(&self) {
        self.state.lock().expect("ui").paused = false;
    }

    /// Ends the answer's current line: rewritten with its Markdown.
    fn finish_line(s: &mut State) {
        if s.live.is_empty() {
            return;
        }
        let shown = style::width(&s.live).max(1);
        let rows = shown.div_ceil(style::columns());
        let mut erase = String::from("\r");
        for _ in 1..rows {
            erase.push_str("\x1b[1A");
        }
        erase.push_str("\x1b[J");
        let line = std::mem::take(&mut s.live);
        Self::out(&format!("{erase}{}\n", s.md.line(&line)));
    }

    fn text(&self, delta: &str) {
        let mut s = self.state.lock().expect("ui");
        Self::unspin(&mut s);
        s.spinner = None;
        if !s.answering {
            s.answering = true;
            Self::out("\n");
        }
        let mut parts = delta.split('\n').peekable();
        while let Some(part) = parts.next() {
            if !part.is_empty() {
                s.live.push_str(part);
                Self::out(part);
            }
            if parts.peek().is_some() {
                if s.live.is_empty() {
                    let blank = s.md.line("");
                    Self::out(&format!("{blank}\n"));
                } else {
                    Self::finish_line(&mut s);
                }
            }
        }
    }

    /// The answer, when it did not stream (or the rest of it): printed whole.
    pub fn answer(&self, text: &str) {
        let streamed = {
            let mut s = self.state.lock().expect("ui");
            Self::unspin(&mut s);
            s.spinner = None;
            Self::finish_line(&mut s);
            s.answering
        };
        if !streamed {
            let mut s = self.state.lock().expect("ui");
            Self::out("\n");
            for line in text.lines() {
                let line = s.md.line(line);
                Self::out(&format!("{line}\n"));
            }
        }
    }

    /// The turn ended: the status line (models, calls, time).
    pub fn end(&self, note: Option<&str>) {
        let mut s = self.state.lock().expect("ui");
        Self::unspin(&mut s);
        Self::finish_line(&mut s);
        s.spinner = None;
        let secs = s.started.map(|t| t.elapsed().as_secs_f64()).unwrap_or_default();
        let mut parts = Vec::new();
        if !s.models.is_empty() {
            parts.push(s.models.join(", "));
        }
        if s.calls > 0 {
            parts.push(format!("{} tool call{}", s.calls, if s.calls == 1 { "" } else { "s" }));
        }
        let (input, output, cached) = s.tokens;
        if input > 0 {
            let mut tokens = format!("{} in · {} out", short(input), short(output));
            if cached > 0 {
                tokens.push_str(&format!(" ({} cached)", short(cached)));
            }
            parts.push(tokens);
        }
        parts.push(format!("{secs:.1}s"));
        if let Some(note) = note {
            parts.push(note.to_owned());
        }
        Self::out(&format!("{}\n", style::gray(&format!("  ─ {}", parts.join(" · ")))));
    }

    /// Shows [event].
    pub fn event(&self, event: Event) {
        match event {
            Event::Text(delta) => self.text(delta),
            Event::Reasoning(delta) => {
                let mut s = self.state.lock().expect("ui");
                if let Some((label, _)) = &mut s.spinner {
                    "thinking".clone_into(label);
                }
                let flat = delta.replace(['\n', '\r', '\t'], " ");
                s.thought.push_str(&flat);
                let len = s.thought.chars().count();
                if len > 400 {
                    s.thought = s.thought.chars().skip(len - 200).collect();
                }
            }
            Event::Tool(what) => {
                let mut s = self.state.lock().expect("ui");
                Self::unspin(&mut s);
                Self::finish_line(&mut s);
                s.answering = false;
                s.calls += 1;
                let headed = std::mem::take(&mut s.headed);
                if !(headed && what.starts_with("write ")) {
                    Self::out(&format!("\n{} {}\n", style::accent("⏺"), self.pretty(what)));
                }
                Self::spin(&mut s, "working");
            }
            Event::Diff(diff) => {
                let mut s = self.state.lock().expect("ui");
                Self::unspin(&mut s);
                Self::finish_line(&mut s);
                s.answering = false;
                s.diff = Some(crate::diff::counts(diff));
                let label = diff.lines().find_map(|l| l.strip_prefix("+++ b/")).unwrap_or("a file");
                s.headed = true;
                let body: String = diff.lines().skip(2).map(|l| format!("{l}\n")).collect();
                Self::out(&format!("\n{} {} {}\n", style::accent("⏺"), style::bold("Change"), label));
                Self::out(&render_diff(&body, 60));
            }
            Event::Output { name, text } => {
                let mut s = self.state.lock().expect("ui");
                Self::unspin(&mut s);
                let diff = s.diff.take();
                Self::out(&summary(name, text, diff));
                Self::spin(&mut s, "thinking");
            }
            Event::Refused(why) => {
                let mut s = self.state.lock().expect("ui");
                s.headed = false;
                Self::unspin(&mut s);
                Self::finish_line(&mut s);
                Self::out(&format!("{} {}\n", style::red("✗"), style::red(why)));
            }
            Event::Member { name, text } => {
                let mut s = self.state.lock().expect("ui");
                Self::unspin(&mut s);
                Self::finish_line(&mut s);
                let first: String = text.lines().next().unwrap_or_default().chars().take(160).collect();
                let more = text.lines().count().saturating_sub(1);
                let more = if more > 0 { style::gray(&format!(" (+{more} lines)")) } else { String::new() };
                Self::out(&format!("{} {}{more}\n", style::magenta(&format!("  ⎿ [{name}]")), first));
            }
            Event::Usage { input, output, cached } => {
                let mut s = self.state.lock().expect("ui");
                s.tokens.0 += input;
                s.tokens.1 += output;
                s.tokens.2 += cached;
            }
            Event::Receipt { model, tier, .. } => {
                let mut s = self.state.lock().expect("ui");
                if let Some(model) = model.filter(|m| *m != "fetch") {
                    let label = match tier {
                        Some(tier) => format!("{model} ({tier})"),
                        None => model.to_owned(),
                    };
                    if !s.models.contains(&label) {
                        s.models.push(label);
                    }
                }
            }
        }
    }

    /// A tool line: what it does, readably.
    fn pretty(&self, what: &str) -> String {
        let rel = |p: &str| -> String {
            let path = std::path::Path::new(p);
            path.strip_prefix(&self.workdir).map(|r| r.display().to_string()).unwrap_or_else(|_| p.to_owned())
        };
        if let Some(command) = what.strip_prefix("run: ") {
            return format!("{} {}", style::bold("Run"), style::code(command));
        }
        if let Some(rest) = what.strip_prefix("write ")
            && let Some((_, path)) = rest.split_once(" bytes to ")
        {
            return format!("{} {}", style::bold("Change"), rel(path));
        }
        if let Some(rest) = what.strip_prefix("read ")
            && let Some(path) = rest.strip_suffix(" (outside the working directory)")
        {
            return format!("{} {} {}", style::bold("Read"), path, style::yellow("(outside)"));
        }
        if let Some(url) = what.strip_prefix("fetch ") {
            return format!("{} {}", style::bold("Fetch"), style::underline(url));
        }
        if what.starts_with('[') {
            return style::magenta(what);
        }
        let (name, args) = what.split_once(' ').unwrap_or((what, ""));
        let args: Value = serde_json::from_str(args).unwrap_or(Value::Null);
        let arg = |key: &str| args[key].as_str().unwrap_or_default().to_owned();
        match name {
            "read_file" => {
                let range = match (args["offset"].as_u64(), args["limit"].as_u64()) {
                    (None, None) => String::new(),
                    (from, n) => {
                        let from = from.unwrap_or(1);
                        style::gray(
                            &n.map_or(format!(" from line {from}"), |n| format!(" lines {from}-{}", from + n - 1)),
                        )
                    }
                };
                format!("{} {}{range}", style::bold("Read"), rel(&arg("path")))
            }
            "list_dir" => format!("{} {}", style::bold("List"), rel(args["path"].as_str().unwrap_or("."))),
            "search" => {
                let mut line = format!("{} {}", style::bold("Search"), style::code(&arg("pattern")));
                if let Some(glob) = args["glob"].as_str() {
                    line.push_str(&style::gray(&format!(" in {glob}")));
                }
                line
            }
            "find_files" => format!("{} {}", style::bold("Find"), style::code(&arg("pattern"))),
            "remember" => format!("{} {}", style::bold("Remember"), style::italic(&arg("text"))),
            "read_skill" => format!("{} {}", style::bold("Skill"), arg("name")),
            "search_sessions" => format!("{} {}", style::bold("Recall"), arg("query")),
            "schedule_task" => format!("{} {} {}", style::bold("Schedule"), arg("when"), style::gray(&arg("task"))),
            "board_plan" => style::bold("Plan the board"),
            "todo" => {
                let mut out = style::bold("Tasks");
                for item in args["items"].as_array().into_iter().flatten() {
                    let text = item["text"].as_str().unwrap_or_default();
                    let line = match item["status"].as_str() {
                        Some("done") => format!("{} {}", style::green("☑"), style::gray(text)),
                        Some("doing") => format!("{} {}", style::accent("◼"), style::bold(text)),
                        _ => format!("{} {text}", style::gray("☐")),
                    };
                    out.push_str(&format!("\n    {line}"));
                }
                out
            }
            _ => {
                let short: String = what.chars().take(160).collect();
                style::bold(&short)
            }
        }
    }
}

/// 1234 → 1.2k, 1234567 → 1.2M.
fn short(n: u64) -> String {
    match n {
        0..1000 => n.to_string(),
        1000..1_000_000 => format!("{:.1}k", n as f64 / 1000.0),
        _ => format!("{:.1}M", n as f64 / 1_000_000.0),
    }
}

/// A unified diff in color, at most [max] lines, indented under its tool line.
pub fn render_diff(diff: &str, max: usize) -> String {
    let mut out = String::new();
    let lines: Vec<&str> = diff.lines().collect();
    for line in lines.iter().take(max) {
        let shown = if line.starts_with("+++") || line.starts_with("---") {
            style::bold(line)
        } else if line.starts_with('+') {
            style::green(line)
        } else if line.starts_with('-') {
            style::red(line)
        } else if line.starts_with("@@") {
            style::cyan(line)
        } else {
            style::gray(line)
        };
        out.push_str(&format!("    {shown}\n"));
    }
    if lines.len() > max {
        out.push_str(&style::gray(&format!("    … {} more lines (/diff shows all)\n", lines.len() - max)));
    }
    out
}

/// The line under a tool call: what it gave back, in short.
pub fn summary(name: &str, text: &str, diff: Option<(usize, usize)>) -> String {
    let gutter = style::gray("  ⎿ ");
    let failed = text.starts_with("error:") || text.starts_with("refused:");
    if failed {
        let first: String = text.lines().next().unwrap_or_default().chars().take(200).collect();
        return format!("{gutter}{}\n", style::red(&first));
    }
    let lines: Vec<&str> = text.lines().collect();
    let n = lines.len();
    let plural = |n: usize, one: &str, many: &str| format!("{n} {}", if n == 1 { one } else { many });
    match name {
        "terminal" => {
            let code = lines.last().copied().unwrap_or_default();
            let body = &lines[..n.saturating_sub(1)];
            let mut out = String::new();
            let shown = body.len().min(6);
            if body.len() > shown {
                out.push_str(&format!("{gutter}{}\n", style::gray(&format!("… {} lines", body.len() - shown))));
            }
            for (i, line) in body[body.len() - shown..].iter().enumerate() {
                let line: String = line.chars().take(style::columns().saturating_sub(6)).collect();
                let lead = if i == 0 && body.len() == shown { gutter.clone() } else { "    ".to_owned() };
                out.push_str(&format!("{lead}{}\n", style::gray(&line)));
            }
            let code = if code.contains("exit code 0") { style::gray(code) } else { style::red(code) };
            out.push_str(&format!("{}{code}\n", if out.is_empty() { gutter } else { "    ".to_owned() }));
            out
        }
        "read_file" => format!("{gutter}{}\n", style::gray(&plural(n, "line", "lines"))),
        "list_dir" => format!("{gutter}{}\n", style::gray(&plural(n, "entry", "entries"))),
        "search" if text.starts_with("no matches") => format!("{gutter}{}\n", style::gray("no matches")),
        "search" => {
            let files: std::collections::HashSet<&str> = lines.iter().filter_map(|l| l.split(':').next()).collect();
            format!(
                "{gutter}{}\n",
                style::gray(&format!("{} in {}", plural(n, "match", "matches"), plural(files.len(), "file", "files")))
            )
        }
        "find_files" if text.starts_with("no files") => format!("{gutter}{}\n", style::gray("no files")),
        "find_files" => format!("{gutter}{}\n", style::gray(&plural(n, "file", "files"))),
        "write_file" | "edit_file" => match diff {
            Some((added, removed)) => {
                format!("{gutter}{} {}\n", style::green(&format!("+{added}")), style::red(&format!("−{removed}")))
            }
            None => format!("{gutter}{}\n", style::gray(lines.first().copied().unwrap_or_default())),
        },
        "delegate" | "todo" => String::new(),
        _ => {
            let first: String = lines.first().copied().unwrap_or_default().chars().take(160).collect();
            let more = if n > 1 { format!(" (+{} lines)", n - 1) } else { String::new() };
            format!("{gutter}{}\n", style::gray(&format!("{first}{more}")))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{render_diff, summary};

    #[test]
    fn tool_results_in_short() {
        assert_eq!(summary("read_file", "a\nb\nc", None), "  ⎿ 3 lines\n");
        assert_eq!(summary("search", "src/a.rs:1: x\nsrc/a.rs:9: x\nb.rs:2: x", None), "  ⎿ 3 matches in 2 files\n");
        assert_eq!(summary("edit_file", "replaced 1 occurrence in x", Some((2, 1))), "  ⎿ +2 −1\n");
        assert_eq!(summary("terminal", "error: stopped after 5 seconds", None), "  ⎿ error: stopped after 5 seconds\n");
        let run = summary("terminal", "1\n2\n3\n4\n5\n6\n7\n8\n[exit code 0]", None);
        assert!(run.starts_with("  ⎿ … 2 lines\n    3\n"), "{run}");
        assert!(run.ends_with("    [exit code 0]\n"));
        assert_eq!(summary("terminal", "[exit code 1]", None), "  ⎿ [exit code 1]\n");
    }

    #[test]
    fn long_diffs_are_cut() {
        let diff: String = (0..10).map(|i| format!("+line {i}\n")).collect();
        let shown = render_diff(&diff, 4);
        assert_eq!(shown.lines().count(), 5);
        assert!(shown.ends_with("… 6 more lines (/diff shows all)\n"));
    }
}
