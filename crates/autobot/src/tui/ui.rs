//! What a turn looks like in the terminal. Finished things go into the scrollback as they
//! happen: the answer a line at a time (Markdown, wrapped to the width), each tool call as a `▪`
//! step with what it gave back hanging under it (`│`, `└`), diffs in color with line numbers,
//! and a `─` footer at the end. What is still happening is drawn in the live region above the
//! composer ([Ui::live]): the answer's unfinished line, the running step or what the model is
//! thinking with a spinner and the seconds, and an approval waiting for a key.

use std::collections::VecDeque;
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::Instant;

use serde_json::Value;

use super::markdown::Markdown;
use super::style;
use super::term;
use super::wrap::{truncate, wrap};
use crate::agent::Event;
use crate::approval::Answer;

/// The spinner: a pixel going round a square, in the signal.
const FRAMES: &[&str] = &["▖", "▘", "▝", "▗"];

/// A question waiting for one key.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Card {
    pub title: String,
    pub what: String,
}

/// What was printed last, for the blank lines between kinds of output.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
enum Last {
    #[default]
    Nothing,
    Text,
    Step,
}

pub struct Ui {
    state: Mutex<State>,
    workdir: PathBuf,
}

#[derive(Default)]
struct State {
    running: bool,
    /// What the spinner says when no step runs, and since when.
    activity: Option<(String, Instant)>,
    /// The step running now (its line), and since when: drawn live, printed when it ends.
    step: Option<(String, Instant)>,
    /// The last of the model's reasoning, shown after the spinner.
    thought: String,
    /// The answer's unfinished line.
    live: String,
    md: Markdown,
    last: Last,
    /// The last diff's +/− counts, for the edit's result line.
    diff: Option<(usize, usize)>,
    /// The change's line was printed with its diff (the tool line that follows is not).
    headed: bool,
    started: Option<Instant>,
    models: Vec<String>,
    calls: usize,
    /// Tokens this turn: input, output, cached input.
    tokens: (u64, u64, u64),
    /// Tokens since the chat started: input, output.
    total: (u64, u64),
    /// Questions waiting for a key, first first.
    asks: VecDeque<(Card, tokio::sync::oneshot::Sender<Answer>)>,
}

/// The width text is wrapped to: the terminal's, less a column.
fn text_width() -> usize {
    style::columns().saturating_sub(1).max(20)
}

impl Ui {
    pub fn new(workdir: PathBuf) -> Self {
        Self { state: Mutex::default(), workdir }
    }

    pub fn workdir(&self) -> &std::path::Path {
        &self.workdir
    }

    /// A turn starts: the spinner, and fresh numbers for its footer.
    pub fn begin(&self) {
        let mut s = self.state.lock().expect("ui");
        let total = s.total;
        *s = State { started: Some(Instant::now()), running: true, total, ..State::default() };
        s.activity = Some(("Thinking".into(), Instant::now()));
    }

    /// An unfinished line of the answer is live (it goes on from the scrollback, no gap).
    pub fn streaming(&self) -> bool {
        let s = self.state.lock().expect("ui");
        !s.live.is_empty()
    }

    pub fn running(&self) -> bool {
        self.state.lock().expect("ui").running
    }

    /// Tokens since the chat started: input, output.
    pub fn total_tokens(&self) -> (u64, u64) {
        self.state.lock().expect("ui").total
    }

    /// The models the last turn used (`qwen (node)`).
    pub fn models(&self) -> Vec<String> {
        self.state.lock().expect("ui").models.clone()
    }

    fn gap(s: &mut State, now: Last) {
        if s.last != now {
            term::print("\n");
        }
        s.last = now;
    }

    /// A line of its own (what was sent to steer the agent, an answered question).
    /// Goes above what is still live (a running step, an unfinished line), which stays as it is.
    pub fn note(&self, text: &str) {
        let _s = self.state.lock().expect("ui");
        term::say(text);
    }

    /// Ends the answer's unfinished line: printed with its Markdown ([all]: and a held table).
    fn finish_line(s: &mut State, all: bool) {
        let width = text_width();
        let mut lines = Vec::new();
        if !s.live.is_empty() {
            let line = std::mem::take(&mut s.live);
            lines = s.md.push(&line, width);
        }
        if all {
            lines.extend(s.md.finish(width));
        }
        if !lines.is_empty() {
            term::print(&lines.iter().map(|l| format!("{l}\n")).collect::<String>());
        }
    }

    /// Prints the running step's line (it ended, or another began).
    fn finish_step(s: &mut State) {
        if let Some((line, _)) = s.step.take() {
            term::say(&format!("{} {line}", style::gray("▪")));
        }
    }

    fn text(&self, delta: &str) {
        let mut s = self.state.lock().expect("ui");
        Self::finish_step(&mut s);
        s.activity = None;
        if s.last != Last::Text {
            Self::gap(&mut s, Last::Text);
        }
        let width = text_width();
        let mut parts = delta.split('\n').peekable();
        while let Some(part) = parts.next() {
            s.live.push_str(part);
            if parts.peek().is_some() {
                let line = std::mem::take(&mut s.live);
                let lines = s.md.push(&line, width);
                if !lines.is_empty() {
                    term::print(&lines.iter().map(|l| format!("{l}\n")).collect::<String>());
                }
            }
        }
    }

    /// The answer, when it did not stream (or the rest of it): printed whole.
    pub fn answer(&self, text: &str) {
        let mut s = self.state.lock().expect("ui");
        Self::finish_step(&mut s);
        s.activity = None;
        if s.last == Last::Text {
            Self::finish_line(&mut s, true);
            return;
        }
        if text.trim().is_empty() {
            return;
        }
        Self::gap(&mut s, Last::Text);
        let width = text_width();
        let mut out = String::new();
        for line in text.lines() {
            for l in s.md.push(line, width) {
                out.push_str(&l);
                out.push('\n');
            }
        }
        for l in s.md.finish(width) {
            out.push_str(&l);
            out.push('\n');
        }
        term::print(&out);
    }

    /// The turn ended: the footer (models, calls, tokens, time).
    pub fn end(&self, note: Option<&str>) {
        let mut s = self.state.lock().expect("ui");
        Self::finish_step(&mut s);
        Self::finish_line(&mut s, true);
        s.activity = None;
        s.running = false;
        // A question left (the turn was stopped): no.
        for (_, tx) in std::mem::take(&mut s.asks) {
            let _ = tx.send(Answer::Deny);
        }
        term::say(&format!("\n{}", footer(&s, note)));
        s.last = Last::Nothing;
    }

    /// Prints what is still open (the answer's unfinished line, the running step).
    pub fn flush(&self) {
        let mut s = self.state.lock().expect("ui");
        Self::finish_step(&mut s);
        Self::finish_line(&mut s, false);
    }

    /// Asks the owner [card]; the answer comes on [reply] when a key is pressed ([Self::respond]).
    pub fn ask(&self, card: Card, reply: tokio::sync::oneshot::Sender<Answer>) {
        let mut s = self.state.lock().expect("ui");
        Self::finish_step(&mut s);
        Self::finish_line(&mut s, false);
        s.asks.push_back((card, reply));
    }

    /// The question waiting for a key, if one is.
    pub fn card(&self) -> Option<Card> {
        self.state.lock().expect("ui").asks.front().map(|(c, _)| c.clone())
    }

    /// Answers the waiting question; whether there was one.
    pub fn respond(&self, answer: Answer) -> bool {
        let mut s = self.state.lock().expect("ui");
        let Some((card, tx)) = s.asks.pop_front() else { return false };
        Self::gap(&mut s, Last::Step);
        let said = match answer {
            Answer::Once => style::bold("yes"),
            Answer::Always => style::bold("always, this session"),
            Answer::Deny => style::red("no"),
        };
        term::say(&format!("{} {} {said}", style::faint("■"), style::gray(&card.title)));
        let _ = tx.send(answer);
        true
    }

    /// What is happening now, as lines for the live region at [width]: the answer's unfinished
    /// line (at most [room] rows of it), then the running step or the spinner, or the question.
    pub fn live(&self, width: usize, room: usize) -> Vec<String> {
        let s = self.state.lock().expect("ui");
        let mut out = Vec::new();
        if !s.live.is_empty() || s.md.in_code() {
            let mut lines = s.md.preview(&s.live, width);
            if lines.len() > room {
                lines.drain(..lines.len() - room);
            }
            out.extend(lines);
        }
        if let Some((card, _)) = s.asks.front() {
            if !out.is_empty() {
                out.push(String::new());
            }
            out.extend(card_lines(card, width));
            return out;
        }
        if !s.running {
            return out;
        }
        let frame = |since: &Instant| {
            let n = (since.elapsed().as_millis() / 140) as usize % FRAMES.len();
            style::accent(FRAMES[n])
        };
        let secs = |since: &Instant| style::faint(&format!("{}s", since.elapsed().as_secs()));
        if let Some((line, since)) = &s.step {
            let head = format!("{} {line}  {}", frame(since), secs(since));
            out.push(truncate(&head, width));
        } else if let Some((label, since)) = &s.activity {
            let mut head = format!("{} {}  {}", frame(since), style::gray(label), secs(since));
            if !s.thought.is_empty() {
                let room = width.saturating_sub(style::width(&head) + 3);
                if room > 10 {
                    head.push_str(&format!(
                        "  {}",
                        style::faint(&style::italic(&style::last_columns(s.thought.trim(), room)))
                    ));
                }
            }
            out.push(truncate(&head, width));
        }
        out
    }

    /// Shows [event].
    pub fn event(&self, event: Event) {
        match event {
            Event::Text(delta) => self.text(delta),
            Event::Reasoning(delta) => {
                let mut s = self.state.lock().expect("ui");
                if s.activity.is_none() && s.step.is_none() {
                    s.activity = Some(("Thinking".into(), Instant::now()));
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
                Self::finish_step(&mut s);
                Self::finish_line(&mut s, true);
                s.calls += 1;
                let headed = std::mem::take(&mut s.headed);
                if headed && what.starts_with("write ") {
                    // Its line and diff are printed; what is left is the result.
                    s.activity = Some(("Changing".into(), Instant::now()));
                } else {
                    Self::gap(&mut s, Last::Step);
                    let pretty = self.pretty(what);
                    // A multi-line step (the task list) is printed at once.
                    if pretty.contains('\n') {
                        term::say(&format!("{} {pretty}", style::gray("▪")));
                        s.activity = Some(("Working".into(), Instant::now()));
                    } else {
                        s.step = Some((pretty, Instant::now()));
                        s.activity = None;
                    }
                }
                s.thought.clear();
            }
            Event::Diff(diff) => {
                let mut s = self.state.lock().expect("ui");
                Self::finish_step(&mut s);
                Self::finish_line(&mut s, true);
                Self::gap(&mut s, Last::Step);
                s.diff = Some(crate::diff::counts(diff));
                let label = diff.lines().find_map(|l| l.strip_prefix("+++ b/")).unwrap_or("a file");
                s.headed = true;
                let body: String = diff.lines().skip(2).map(|l| format!("{l}\n")).collect();
                term::say(&format!("{} {} {label}", style::gray("▪"), style::bold("Change")));
                term::print(&render_diff(&body, 40));
            }
            Event::Output { name, text } => {
                let mut s = self.state.lock().expect("ui");
                Self::finish_step(&mut s);
                let diff = s.diff.take();
                term::print(&summary(name, text, diff));
                s.activity = Some(("Thinking".into(), Instant::now()));
            }
            Event::Refused(why) => {
                let mut s = self.state.lock().expect("ui");
                s.headed = false;
                Self::finish_step(&mut s);
                Self::finish_line(&mut s, true);
                Self::gap(&mut s, Last::Step);
                term::say(&format!("{} {why}", style::red("✗")));
            }
            Event::Member { name, text } => {
                let mut s = self.state.lock().expect("ui");
                Self::finish_step(&mut s);
                Self::finish_line(&mut s, true);
                let first: String = text.lines().next().unwrap_or_default().chars().take(160).collect();
                let more = text.lines().count().saturating_sub(1);
                let more = if more > 0 { style::gray(&format!(" (+{more} lines)")) } else { String::new() };
                term::say(&format!("{} {} {first}{more}", style::faint("  └"), style::bold(name)));
            }
            Event::Usage { input, output, cached } => {
                let mut s = self.state.lock().expect("ui");
                s.tokens.0 += input;
                s.tokens.1 += output;
                s.tokens.2 += cached;
                s.total.0 += input;
                s.total.1 += output;
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
        if let Some(command) = what.strip_prefix("run in the background: ") {
            return format!("{} {} {}", style::bold("Start"), style::code(command), style::gray("(background)"));
        }
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
        // A member's line: `[explorer] read_file {…}`.
        if let Some(rest) = what.strip_prefix('[')
            && let Some((name, line)) = rest.split_once("] ")
        {
            return format!("{} {}", style::faint(&format!("{name} ·")), self.pretty(line));
        }
        if let Some(rest) = what.strip_prefix('[')
            && let Some((name, goal)) = rest.split_once("] ← ")
        {
            return format!("{} {} {}", style::bold("Hand off"), style::bold(name), style::gray(goal));
        }
        let (name, args) = what.split_once(' ').unwrap_or((what, ""));
        let args: Value = serde_json::from_str(args).unwrap_or(Value::Null);
        let arg = |key: &str| args[key].as_str().unwrap_or_default().to_owned();
        match name {
            "read_file" => {
                let range = match (args["offset"].as_u64(), args["limit"].as_u64()) {
                    (None, None) => String::new(),
                    (from, n) => {
                        let from = from.unwrap_or(1).max(1);
                        style::gray(&n.map_or(format!(" from line {from}"), |n| {
                            format!(" lines {from}-{}", from.saturating_add(n.max(1) - 1))
                        }))
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
            "process" => {
                let id = args["id"].as_u64().map(|n| format!(" {n}")).unwrap_or_default();
                match args["action"].as_str().unwrap_or("list") {
                    "list" => style::bold("Processes"),
                    "stop" => format!("{}{id}", style::bold("Stop process")),
                    "wait" => format!("{}{id}", style::bold("Wait for process")),
                    _ => format!("{}{id}", style::bold("Output of process")),
                }
            }
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
                        Some("done") => format!("{} {}", style::gray("✓"), style::gray(text)),
                        Some("doing") => format!("{} {}", style::accent("■"), style::bold(text)),
                        _ => format!("{} {text}", style::faint("□")),
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

/// `─ model · N tool calls · in · out · time`, quiet.
fn footer(s: &State, note: Option<&str>) -> String {
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
    style::faint(&format!("  ─ {}", parts.join(" · ")))
}

/// A question as lines: `■ title`, what it is about hanging under it, the keys.
pub fn card_lines(card: &Card, width: usize) -> Vec<String> {
    let mut out = vec![truncate(&format!("{} {}", style::accent("■"), style::bold(&card.title)), width)];
    let gutter = style::faint("  │ ");
    let mut what: Vec<String> = card.what.lines().flat_map(|l| wrap(l, width, &gutter, &gutter, true)).collect();
    if what.len() > 6 {
        let more = what.len() - 5;
        what.truncate(5);
        what.push(format!("{gutter}{}", style::faint(&format!("… {more} more lines"))));
    }
    out.extend(what);
    let key = |k: &str, what: &str| format!("{} {}", style::bold(k), style::gray(what));
    out.push(format!(
        "{}{}   {}   {}",
        style::faint("  └ "),
        key("y", "yes"),
        key("a", "always, this session"),
        key("n", "no")
    ));
    out
}

/// 1234 → 1.2k, 1234567 → 1.2M.
pub fn short(n: u64) -> String {
    match n {
        0..1000 => n.to_string(),
        1000..1_000_000 => format!("{:.1}k", n as f64 / 1000.0),
        _ => format!("{:.1}M", n as f64 / 1_000_000.0),
    }
}

/// A unified diff in color, at most [max] lines, indented under its step: each line with its
/// number (the old one for a removed line), hunks apart, files by name.
pub fn render_diff(diff: &str, max: usize) -> String {
    let mut out = String::new();
    let lines: Vec<&str> = diff.lines().collect();
    let (mut old, mut new) = (0usize, 0usize);
    let mut shown = 0;
    let mut hunks = 0;
    for (i, line) in lines.iter().enumerate() {
        if shown >= max {
            let rest = lines[i..].iter().filter(|l| !l.starts_with("@@")).count();
            out.push_str(&style::faint(&format!("    … {rest} more lines (/diff shows all)\n")));
            break;
        }
        if let Some(rest) = line.strip_prefix("diff --git ") {
            let name = rest.split(" b/").nth(1).unwrap_or(rest);
            out.push_str(&format!("  {} {}\n", style::gray("▪"), style::bold(name)));
            hunks = 0;
            continue;
        }
        if line.starts_with("index ") || line.starts_with("+++") || line.starts_with("---") {
            continue;
        }
        if line.starts_with("new file") || line.starts_with("deleted file") || line.starts_with("similarity") {
            out.push_str(&format!("    {}\n", style::faint(line)));
            continue;
        }
        if let Some(rest) = line.strip_prefix("@@ ") {
            // `@@ -12,3 +12,4 @@`
            let mut nums = rest.split_whitespace();
            let start = |s: Option<&str>| {
                s.and_then(|s| s[1..].split(',').next()).and_then(|n| n.parse::<usize>().ok()).unwrap_or(1)
            };
            old = start(nums.next());
            new = start(nums.next());
            if hunks > 0 {
                out.push_str(&format!("    {}\n", style::faint("   ⋮")));
            }
            hunks += 1;
            continue;
        }
        let (number, text) = if let Some(text) = line.strip_prefix('+') {
            new += 1;
            (new - 1, style::green(&format!("+ {text}")))
        } else if let Some(text) = line.strip_prefix('-') {
            old += 1;
            (old - 1, style::removed(&format!("- {text}")))
        } else if line.starts_with('\\') {
            out.push_str(&format!("    {}\n", style::faint(line)));
            continue;
        } else {
            old += 1;
            new += 1;
            (new - 1, style::gray(&format!("  {}", line.strip_prefix(' ').unwrap_or(line))))
        };
        out.push_str(&format!("    {} {text}\n", style::faint(&format!("{number:>4}"))));
        shown += 1;
    }
    out
}

/// The lines under a tool call: what it gave back, in short, on a light gutter (`│`, then `└`).
pub fn summary(name: &str, text: &str, diff: Option<(usize, usize)>) -> String {
    let body = summary_lines(name, text, diff);
    let n = body.len();
    body.iter()
        .enumerate()
        .map(|(i, line)| format!("{}{line}\n", style::faint(if i + 1 == n { "  └ " } else { "  │ " })))
        .collect()
}

fn summary_lines(name: &str, text: &str, diff: Option<(usize, usize)>) -> Vec<String> {
    let failed = text.starts_with("error:") || text.starts_with("refused:");
    if failed {
        let first: String = text.lines().next().unwrap_or_default().chars().take(200).collect();
        return vec![style::red(&first)];
    }
    let lines: Vec<&str> = text.lines().collect();
    let n = lines.len();
    let plural = |n: usize, one: &str, many: &str| format!("{n} {}", if n == 1 { one } else { many });
    let one = |text: String| vec![style::gray(&text)];
    let room = style::columns().saturating_sub(6).max(20);
    match name {
        "terminal" => {
            let last = lines.last().copied().unwrap_or_default();
            let body = &lines[..n.saturating_sub(1)];
            let shown = body.len().min(5);
            let mut out = Vec::new();
            if body.len() > shown {
                out.push(style::faint(&format!("… {} more lines", body.len() - shown)));
            }
            for line in &body[body.len() - shown..] {
                out.push(style::gray(&truncate(&line.replace('\t', "    "), room)));
            }
            // `[exit code 3]` → `exit 3`, quiet when it is 0.
            let code = last.strip_prefix("[exit code ").and_then(|c| c.strip_suffix(']'));
            out.push(match code {
                Some("0") => style::faint("exit 0"),
                Some(code) => style::red(&format!("exit {code}")),
                None => style::red(last.trim_matches(['[', ']'])),
            });
            out
        }
        "read_file" => one(plural(n, "line", "lines")),
        "list_dir" => one(plural(n, "entry", "entries")),
        "search" if text.starts_with("no matches") => one("no matches".to_owned()),
        "search" => {
            let files: std::collections::HashSet<&str> = lines.iter().filter_map(|l| l.split(':').next()).collect();
            one(format!("{} in {}", plural(n, "match", "matches"), plural(files.len(), "file", "files")))
        }
        "find_files" if text.starts_with("no files") => one("no files".to_owned()),
        "find_files" => one(plural(n, "file", "files")),
        "write_file" | "edit_file" => match diff {
            Some((added, removed)) => {
                vec![format!("{} {}", style::green(&format!("+{added}")), style::removed(&format!("−{removed}")))]
            }
            None => one(lines.first().copied().unwrap_or_default().to_owned()),
        },
        "delegate" | "todo" => Vec::new(),
        _ => {
            let shown = n.min(3);
            let mut out: Vec<String> = lines[..shown].iter().map(|l| style::gray(&truncate(l, room))).collect();
            if n > shown {
                out.push(style::faint(&format!("… {} more lines", n - shown)));
            }
            out
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{Card, card_lines, render_diff, summary};

    #[test]
    fn tool_results_in_short() {
        assert_eq!(summary("read_file", "a\nb\nc", None), "  └ 3 lines\n");
        assert_eq!(summary("search", "src/a.rs:1: x\nsrc/a.rs:9: x\nb.rs:2: x", None), "  └ 3 matches in 2 files\n");
        assert_eq!(summary("edit_file", "replaced 1 occurrence in x", Some((2, 1))), "  └ +2 −1\n");
        assert_eq!(summary("terminal", "error: stopped after 5 seconds", None), "  └ error: stopped after 5 seconds\n");
        let run = summary("terminal", "1\n2\n3\n4\n5\n6\n7\n8\n[exit code 0]", None);
        assert!(run.starts_with("  │ … 3 more lines\n  │ 4\n"), "{run}");
        assert!(run.ends_with("  │ 8\n  └ exit 0\n"));
        assert_eq!(summary("terminal", "[exit code 1]", None), "  └ exit 1\n");
        assert_eq!(
            summary("fetch", "one\ntwo\nthree\nfour\nfive", None),
            "  │ one\n  │ two\n  │ three\n  └ … 2 more lines\n"
        );
    }

    #[test]
    fn diffs_have_line_numbers_and_long_ones_are_cut() {
        let diff = "--- a/x.rs\n+++ b/x.rs\n@@ -10,3 +10,3 @@\n keep\n-old\n+new\n@@ -40,1 +40,2 @@\n end\n+more\n";
        let shown = render_diff(diff, 100);
        assert_eq!(
            shown,
            "      10   keep\n      11 - old\n      11 + new\n       ⋮\n      40   end\n      41 + more\n"
        );
        let diff: String = (0..10).map(|i| format!("+line {i}\n")).collect();
        let shown = render_diff(&diff, 4);
        assert_eq!(shown.lines().count(), 5);
        assert!(shown.ends_with("… 6 more lines (/diff shows all)\n"));
        let git = "diff --git a/src/a.rs b/src/a.rs\nindex 1..2 100644\n--- a/src/a.rs\n+++ b/src/a.rs\n@@ -1 +1 @@\n-a\n+b\n";
        assert!(render_diff(git, 100).starts_with("  ▪ src/a.rs\n       1 - a\n       1 + b\n"));
    }

    #[test]
    fn a_question_is_a_card_with_its_keys() {
        let card = Card { title: "Run this command?".into(), what: "cargo test".into() };
        assert_eq!(
            card_lines(&card, 60),
            ["■ Run this command?", "  │ cargo test", "  └ y yes   a always, this session   n no"]
        );
    }
}
