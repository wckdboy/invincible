//! The terminal chat (`autobot chat`, and `autobot code` in a project): line editing with
//! history and completion, the answer streamed as Markdown, tool calls and diffs as they happen,
//! approvals with one key, ctrl+c to stop a turn, and slash commands to steer the agent.

use std::collections::HashSet;
use std::future::Future;
use std::path::{Path, PathBuf};
use std::pin::Pin;
use std::sync::Arc;

use super::style;
use super::ui::{Ui, render_diff};
use crate::agent::Agent;
use crate::approval::{Action, Answer, Approver};
use crate::config::{ApprovalMode, Config};
use crate::gateway::ModelInfo;
use crate::session::Session;

pub struct Options {
    /// The conversation to continue.
    pub session: String,
    /// Start it over.
    pub new: bool,
    /// The model to start with (an id the gateway serves).
    pub model: Option<String>,
    /// Coding in a project (the banner says so).
    pub code: bool,
}

/// The slash commands, for `/help` and completion.
const COMMANDS: &[(&str, &str)] = &[
    ("/help", "this list"),
    ("/model", "show the models, or switch: /model deepseek"),
    ("/approvals", "show or set: ask, edits (changes in the project run), allowlist, trust"),
    ("/private", "on: local models only; off: cloud models allowed"),
    ("/tools", "show the tools, or keep only some groups: /tools files-read,terminal (or all)"),
    ("/context", "how much of the conversation each call sends, or set it in KiB"),
    ("/undo", "put back the files the last turn changed, and take the turn back"),
    ("/diff", "the project's uncommitted changes (git diff)"),
    ("/status", "model, approvals, session, context"),
    ("/new", "start the conversation over"),
    ("/fork", "continue in a copy of this conversation: /fork [name]"),
    ("/sessions", "the saved conversations"),
    ("/resume", "continue another conversation: /resume <name>"),
    ("/memory", "what the agent remembered"),
    ("/skills", "the owner's skills"),
    ("/team", "the team members it can delegate to"),
    ("/board", "the team's plans and tasks"),
    ("/clear", "clear the screen"),
    ("/exit", "quit (ctrl+d)"),
];

/// What a read of the prompt gave.
enum Read {
    Line(String),
    Interrupted,
    Eof,
}

/// The line editor, on a thread of its own (it blocks): asked for a line with a prompt and
/// what to start with, it answers on [replies].
struct Input {
    asks: std::sync::mpsc::Sender<String>,
    replies: tokio::sync::mpsc::UnboundedReceiver<Read>,
}

impl Input {
    fn start(home: &Path, workdir: PathBuf) -> Self {
        let (asks, asked) = std::sync::mpsc::channel::<String>();
        let (reply, replies) = tokio::sync::mpsc::unbounded_channel();
        let history = home.join("history");
        std::thread::spawn(move || {
            let config = rustyline::Config::builder()
                .auto_add_history(false)
                .completion_type(rustyline::CompletionType::List)
                .bracketed_paste(true)
                .max_history_size(2000)
                .map(|b| b.build());
            let Ok(config) = config else { return };
            let Ok(mut editor) = rustyline::Editor::<Helper, rustyline::history::DefaultHistory>::with_config(config)
            else {
                return;
            };
            editor.set_helper(Some(Helper { workdir }));
            editor.bind_sequence(
                rustyline::KeyEvent(rustyline::KeyCode::Enter, rustyline::Modifiers::ALT),
                rustyline::Cmd::Newline,
            );
            let _ = editor.load_history(&history);
            while let Ok(initial) = asked.recv() {
                let read = match editor.readline_with_initial("› ", (&initial, "")) {
                    Ok(line) => {
                        if !line.trim().is_empty() {
                            let _ = editor.add_history_entry(line.as_str());
                            let _ = editor.save_history(&history);
                        }
                        Read::Line(line.replace("\\\n", "\n"))
                    }
                    Err(rustyline::error::ReadlineError::Interrupted) => Read::Interrupted,
                    Err(_) => Read::Eof,
                };
                if reply.send(read).is_err() {
                    break;
                }
            }
        });
        Self { asks, replies }
    }

    async fn read(&mut self, initial: &str) -> Read {
        if self.asks.send(initial.to_owned()).is_err() {
            return Read::Eof;
        }
        self.replies.recv().await.unwrap_or(Read::Eof)
    }
}

/// Completion of slash commands and `@` paths, a colored prompt, `\` at the end of a line to
/// go on to the next.
struct Helper {
    workdir: PathBuf,
}

impl rustyline::Helper for Helper {}

impl rustyline::hint::Hinter for Helper {
    type Hint = String;
}

impl rustyline::highlight::Highlighter for Helper {
    fn highlight_prompt<'b, 's: 'b, 'p: 'b>(&'s self, prompt: &'p str, _default: bool) -> std::borrow::Cow<'b, str> {
        std::borrow::Cow::Owned(style::bold(&style::accent(prompt)))
    }
}

impl rustyline::validate::Validator for Helper {
    fn validate(
        &self,
        ctx: &mut rustyline::validate::ValidationContext,
    ) -> rustyline::Result<rustyline::validate::ValidationResult> {
        Ok(if ctx.input().ends_with('\\') {
            rustyline::validate::ValidationResult::Incomplete
        } else {
            rustyline::validate::ValidationResult::Valid(None)
        })
    }
}

impl rustyline::completion::Completer for Helper {
    type Candidate = rustyline::completion::Pair;

    fn complete(
        &self,
        line: &str,
        pos: usize,
        _ctx: &rustyline::Context<'_>,
    ) -> rustyline::Result<(usize, Vec<Self::Candidate>)> {
        let before = &line[..pos];
        if before.starts_with('/') && !before.contains(' ') {
            let pairs = COMMANDS
                .iter()
                .filter(|(c, _)| c.starts_with(before))
                .map(|(c, _)| rustyline::completion::Pair { display: (*c).to_owned(), replacement: format!("{c} ") })
                .collect();
            return Ok((0, pairs));
        }
        let start = before.rfind(char::is_whitespace).map_or(0, |i| i + 1);
        let Some(word) = before[start..].strip_prefix('@') else { return Ok((pos, Vec::new())) };
        Ok((start + 1, complete_path(&self.workdir, word)))
    }
}

/// Paths under [workdir] that [word] could be the start of.
fn complete_path(workdir: &Path, word: &str) -> Vec<rustyline::completion::Pair> {
    let (dir, prefix) = match word.rfind('/') {
        Some(i) => (&word[..=i], &word[i + 1..]),
        None => ("", word),
    };
    let mut found: Vec<rustyline::completion::Pair> = std::fs::read_dir(workdir.join(dir))
        .into_iter()
        .flatten()
        .flatten()
        .filter_map(|e| {
            let name = e.file_name().to_string_lossy().into_owned();
            if !name.starts_with(prefix) || (name.starts_with('.') && !prefix.starts_with('.')) {
                return None;
            }
            let slash = if e.file_type().is_ok_and(|t| t.is_dir()) { "/" } else { "" };
            Some(rustyline::completion::Pair {
                display: format!("{name}{slash}"),
                replacement: format!("{dir}{name}{slash}"),
            })
        })
        .collect();
    found.sort_by(|a, b| a.display.cmp(&b.display));
    found
}

/// Asks in the terminal, one key: y, a (always, this session), n.
struct KeyApprover {
    ui: Arc<Ui>,
}

impl Approver for KeyApprover {
    fn channel(&self) -> &'static str {
        "cli"
    }

    fn approve<'a>(&'a self, action: &'a Action) -> Pin<Box<dyn Future<Output = Answer> + Send + 'a>> {
        Box::pin(async move {
            self.ui.pause();
            let who = crate::approval::asker();
            let (title, what) = match action {
                Action::Command(c) => ("Run this command?", style::code(c)),
                Action::Write { path, inside, .. } => (
                    "Make this change?",
                    format!(
                        "{}{}",
                        path.display(),
                        if *inside { String::new() } else { style::yellow(" (outside the project)") }
                    ),
                ),
                Action::Read(p) => ("Read outside the project?", p.display().to_string()),
                Action::Cloud(why) => {
                    // The gateway's reason, without its note for API clients.
                    let why = why.split("; send again").next().unwrap_or(why).trim();
                    (
                        "Send this conversation to a cloud model?",
                        format!("{why} {}", style::gray("(a: for this session)")),
                    )
                }
                Action::Fetch(url) => ("Fetch this page?", style::underline(url)),
                Action::Mcp { tool, arguments } => (
                    "Use this tool?",
                    format!("{tool} {}", style::gray(&arguments.chars().take(200).collect::<String>())),
                ),
            };
            print!(
                "\n{} {}\n{} {}\n{} {}  {}  {}  ",
                style::yellow("╭─"),
                style::bold(&format!("{who}{title}")),
                style::yellow("│"),
                what,
                style::yellow("╰─"),
                format_args!("{} yes", style::bold("y")),
                format_args!("{} always this session", style::bold("a")),
                format_args!("{} no", style::bold("n")),
            );
            let _ = std::io::Write::flush(&mut std::io::stdout());
            let key = tokio::task::spawn_blocking(read_key).await.ok().flatten();
            let answer = match key {
                Some('y') => Answer::Once,
                Some('a') => Answer::Always,
                _ => Answer::Deny,
            };
            println!(
                "{}",
                match answer {
                    Answer::Once => style::green("yes"),
                    Answer::Always => style::green("always"),
                    Answer::Deny => style::red("no"),
                }
            );
            self.ui.resume();
            answer
        })
    }
}

/// One key from the terminal (a line when it is not one): y, a, n; Esc, ctrl+c and Enter are no.
fn read_key() -> Option<char> {
    use crossterm::event::{Event, KeyCode, KeyEventKind, KeyModifiers};
    use std::io::IsTerminal;
    if !std::io::stdin().is_terminal() {
        let mut line = String::new();
        std::io::stdin().read_line(&mut line).ok()?;
        return line.trim().chars().next().map(|c| c.to_ascii_lowercase());
    }
    crossterm::terminal::enable_raw_mode().ok()?;
    let key = loop {
        match crossterm::event::read() {
            Ok(Event::Key(key)) if key.kind == KeyEventKind::Press => {
                if key.modifiers.contains(KeyModifiers::CONTROL) && key.code == KeyCode::Char('c') {
                    break Some('n');
                }
                match key.code {
                    KeyCode::Char(c @ ('y' | 'Y' | 'a' | 'A' | 'n' | 'N')) => break Some(c.to_ascii_lowercase()),
                    KeyCode::Esc | KeyCode::Enter => break Some('n'),
                    _ => {}
                }
            }
            Ok(_) => {}
            Err(_) => break None,
        }
    };
    let _ = crossterm::terminal::disable_raw_mode();
    key
}

/// What the chat holds between turns.
struct Chat {
    agent: Agent,
    /// The tools before `/tools` narrowed them.
    all_tools: crate::tools::Tools,
    session: Session,
    grants: HashSet<Action>,
    home: PathBuf,
    config: Config,
    ui: Arc<Ui>,
    models: Vec<ModelInfo>,
    /// What `!command` printed, for the next request.
    shell: String,
}

pub async fn run(config: &Config, home: PathBuf, agent: Agent, options: Options) -> Result<(), String> {
    style::set_color(style::detect());
    let mut session = Session::open(&home.join("sessions"), &options.session)?;
    if options.new {
        session.reset()?;
    }
    let ui = Arc::new(Ui::new(agent.tools.workdir().to_owned()));
    let models = agent.gateway.model_info().await.unwrap_or_default();
    let mut chat = Chat {
        all_tools: agent.tools.clone(),
        agent,
        session,
        grants: HashSet::new(),
        home: home.clone(),
        config: config.clone(),
        ui: ui.clone(),
        models,
        shell: String::new(),
    };
    if let Some(model) = &options.model {
        chat.switch_model(model)?;
    }
    chat.banner(options.code);
    let mut input = Input::start(&home, chat.agent.tools.workdir().to_owned());
    let mut initial = String::new();
    let mut interrupted = false;
    loop {
        println!();
        let line = match input.read(&std::mem::take(&mut initial)).await {
            Read::Line(line) => line,
            Read::Interrupted => {
                if interrupted {
                    return Ok(());
                }
                interrupted = true;
                println!("{}", style::gray("(ctrl+c again, ctrl+d or /exit to quit)"));
                continue;
            }
            Read::Eof => return Ok(()),
        };
        interrupted = false;
        let text = line.trim();
        if text.is_empty() {
            continue;
        }
        if let Some(command) = text.strip_prefix('!') {
            chat.shell(command.trim()).await;
            continue;
        }
        if text.starts_with('/') {
            match chat.command(text).await {
                Ok(Some(Next::Exit)) => return Ok(()),
                Ok(Some(Next::Prefill(text))) => initial = text,
                Ok(None) => {}
                Err(e) => println!("{}", style::red(&e)),
            }
            continue;
        }
        chat.turn(text).await;
    }
}

enum Next {
    Exit,
    /// Start the next prompt with this text (an undone request, to change and send again).
    Prefill(String),
}

impl Chat {
    fn model_label(&self) -> String {
        let model = self.agent.gateway.model();
        match self.models.iter().find(|m| m.id == model) {
            Some(m) => format!("{model} ({})", m.tier),
            None => model.to_owned(),
        }
    }

    fn approvals(&self) -> &'static str {
        match self.agent.approvals.mode {
            ApprovalMode::Ask => "ask",
            ApprovalMode::Edits => "edits",
            ApprovalMode::Allowlist => "allowlist",
            ApprovalMode::Trust => "trust",
        }
    }

    fn banner(&self, code: bool) {
        let workdir = self.agent.tools.workdir();
        let shown = match std::env::var_os("HOME").map(PathBuf::from) {
            Some(home) => match workdir.strip_prefix(&home) {
                Ok(rest) => format!("~/{}", rest.display()),
                Err(_) => workdir.display().to_string(),
            },
            None => workdir.display().to_string(),
        };
        // Long paths keep their start and end.
        let room = style::columns().saturating_sub(40).max(24);
        let shown = if shown.chars().count() > room {
            let chars: Vec<char> = shown.chars().collect();
            let keep = room / 2 - 1;
            format!(
                "{}…{}",
                chars[..keep].iter().collect::<String>(),
                chars[chars.len() - keep..].iter().collect::<String>()
            )
        } else {
            shown
        };
        let branch = self.agent.tools.git_branch().map(|b| format!(" · {}", style::green(&b))).unwrap_or_default();
        let notes =
            if self.agent.tools.project_notes().is_some() { style::gray(" · AGENTS.md") } else { String::new() };
        let mut lines = vec![
            format!(
                "{} {} {}",
                style::accent("◆"),
                style::bold("Autobot"),
                style::gray(&format!("{} · on Invincible", env!("CARGO_PKG_VERSION")))
            ),
            format!(
                "  {} {}  {} {}{}",
                style::gray("model"),
                self.model_label(),
                style::gray("approvals"),
                self.approvals(),
                if self.agent.gateway.private() { style::gray(" · private") } else { String::new() }
            ),
            format!("  {}{branch}{notes}", shown),
        ];
        let messages = self.session.messages.len();
        lines.push(format!(
            "  {} {}{}",
            style::gray("session"),
            self.session.id,
            if messages > 0 { style::gray(&format!(" · {messages} messages")) } else { String::new() }
        ));
        let inner = lines.iter().map(|l| style::width(l)).max().unwrap_or(0) + 2;
        println!("{}", style::gray(&format!("╭{}╮", "─".repeat(inner))));
        for line in &lines {
            let pad = inner - 1 - style::width(line);
            println!("{} {line}{}{}", style::gray("│"), " ".repeat(pad), style::gray("│"));
        }
        println!("{}", style::gray(&format!("╰{}╯", "─".repeat(inner))));
        let hint = if code {
            "/help · @file attaches · !cmd runs · /undo takes a turn back · alt+enter for a new line"
        } else {
            "/help · @file attaches · !cmd runs · alt+enter for a new line"
        };
        println!("{}", style::gray(&format!("  {hint}")));
    }

    async fn turn(&mut self, text: &str) {
        let mut request = expand_mentions(text, self.agent.tools.workdir(), &self.ui);
        if !self.shell.is_empty() {
            request = format!("{}\n\n{request}", std::mem::take(&mut self.shell));
        }
        let ui = self.ui.clone();
        ui.begin();
        let ticker = {
            let ui = ui.clone();
            tokio::spawn(async move {
                loop {
                    tokio::time::sleep(std::time::Duration::from_millis(90)).await;
                    ui.tick();
                }
            })
        };
        let approver = KeyApprover { ui: ui.clone() };
        let events = |event: crate::agent::Event| ui.event(event);
        let outcome = {
            let turn = self.agent.turn(&mut self.session, &request, &approver, &mut self.grants, &events);
            tokio::select! {
                outcome = turn => Some(outcome),
                _ = tokio::signal::ctrl_c() => None,
            }
        };
        ticker.abort();
        match outcome {
            Some(Ok(outcome)) => {
                ui.answer(&outcome.text);
                ui.end(None);
            }
            Some(Err(e)) => {
                ui.end(None);
                println!("{} {}", style::red("✗"), e);
            }
            None => {
                // The conversation stays one a model accepts (its open calls get an answer).
                let _ = self.session.close_dangling();
                ui.end(Some("stopped"));
            }
        }
    }

    /// `!command`: run by the owner in the project, shown, and handed to the next request.
    async fn shell(&mut self, command: &str) {
        if command.is_empty() {
            return;
        }
        let output = tokio::process::Command::new("sh")
            .arg("-c")
            .arg(command)
            .current_dir(self.agent.tools.workdir())
            .output()
            .await;
        match output {
            Ok(out) => {
                let mut text = String::from_utf8_lossy(&out.stdout).into_owned();
                text.push_str(&String::from_utf8_lossy(&out.stderr));
                print!("{text}");
                if !text.ends_with('\n') && !text.is_empty() {
                    println!();
                }
                let code = out.status.code().map_or("killed".to_owned(), |c| format!("exit code {c}"));
                println!("{}", style::gray(&format!("  ─ {code} · goes with your next message")));
                let text = crate::tools::cut(text);
                self.shell.push_str(&format!("(I ran `{command}` myself; {code}:)\n```\n{}\n```\n", text.trim_end()));
            }
            Err(e) => println!("{}", style::red(&format!("{command}: {e}"))),
        }
    }

    fn switch_model(&mut self, id: &str) -> Result<(), String> {
        crate::use_model(&mut self.agent, &self.config, &self.models, id)?;
        self.all_tools = self.all_tools.clone().with_context(self.agent.options.context_kib.unwrap_or(48));
        Ok(())
    }

    async fn command(&mut self, line: &str) -> Result<Option<Next>, String> {
        let (name, arg) = line.split_once(' ').map_or((line, ""), |(n, a)| (n, a.trim()));
        match name {
            "/exit" | "/quit" | "/q" => return Ok(Some(Next::Exit)),
            "/help" | "/?" => {
                for (command, what) in COMMANDS {
                    println!("  {} {}", style::accent(&format!("{command:<11}")), style::gray(what));
                }
                println!(
                    "  {} {}",
                    style::accent(&format!("{:<11}", "@path")),
                    style::gray("attach a file (tab completes)")
                );
                println!(
                    "  {} {}",
                    style::accent(&format!("{:<11}", "!command")),
                    style::gray("run it yourself; its output goes with your next message")
                );
            }
            "/clear" => print!("\x1b[2J\x1b[H"),
            "/new" => {
                self.session.reset()?;
                self.grants.clear();
                println!("{}", style::gray("a new conversation"));
            }
            "/model" | "/models" if arg.is_empty() => {
                if let Ok(models) = self.agent.gateway.model_info().await {
                    self.models = models;
                }
                let current = self.agent.gateway.model();
                for m in &self.models {
                    let mark = if m.id == current { style::accent("●") } else { " ".to_owned() };
                    let context = m.context.map(|c| format!(" · {}k context", c / 1000)).unwrap_or_default();
                    let health = if m.healthy { String::new() } else { style::red(" · unhealthy") };
                    println!(
                        "  {mark} {} {}{health}",
                        style::bold(&m.id),
                        style::gray(&format!("{}{context}", m.tier))
                    );
                }
                let auto = if current == "auto" { style::accent("●") } else { " ".to_owned() };
                println!("  {auto} {} {}", style::bold("auto"), style::gray("the gateway's router picks"));
            }
            "/model" | "/models" => {
                self.switch_model(arg)?;
                println!(
                    "{} {}{}",
                    style::gray("model"),
                    self.model_label(),
                    if self.agent.gateway.private() { "" } else { " · cloud allowed" }
                );
            }
            "/approvals" | "/mode" => {
                if !arg.is_empty() {
                    self.agent.approvals.mode = match arg {
                        "ask" => ApprovalMode::Ask,
                        "edits" => ApprovalMode::Edits,
                        "allowlist" => ApprovalMode::Allowlist,
                        "trust" => ApprovalMode::Trust,
                        other => return Err(format!("{other:?}: ask, edits, allowlist or trust")),
                    };
                }
                let what = match self.agent.approvals.mode {
                    ApprovalMode::Ask => "everything that changes something asks first",
                    ApprovalMode::Edits => "changes in the project run (diffs shown, /undo puts back); commands ask",
                    ApprovalMode::Allowlist => "allowlisted commands and project changes run; the rest is refused",
                    ApprovalMode::Trust => "everything runs without asking",
                };
                println!("{} {}", style::bold(self.approvals()), style::gray(what));
            }
            "/private" => {
                match arg {
                    "on" => self.agent.gateway = self.agent.gateway.with_private(true),
                    "off" => self.agent.gateway = self.agent.gateway.with_private(false),
                    "" => {}
                    other => return Err(format!("{other:?}: on or off")),
                }
                println!(
                    "{}",
                    if self.agent.gateway.private() {
                        "private: local models only"
                    } else {
                        "not private: the router may use cloud models"
                    }
                );
            }
            "/tools" => {
                if !arg.is_empty() {
                    self.agent.tools = if arg == "all" {
                        self.all_tools.clone()
                    } else {
                        let groups: Vec<String> = arg.split(',').map(|g| g.trim().to_owned()).collect();
                        if let Some(bad) = groups.iter().find(|g| !crate::tools::GROUPS.iter().any(|(n, _)| n == g)) {
                            let names: Vec<&str> = crate::tools::GROUPS.iter().map(|(n, _)| *n).collect();
                            return Err(format!("{bad:?}: the groups are {}", names.join(", ")));
                        }
                        self.all_tools.clone().only(crate::tools::tools_for(&groups))
                    };
                }
                let names: Vec<String> = self
                    .agent
                    .tools
                    .definitions()
                    .as_array()
                    .into_iter()
                    .flatten()
                    .filter_map(|t| t["function"]["name"].as_str().map(str::to_owned))
                    .collect();
                println!("{}", names.join(", "));
            }
            "/context" => {
                if !arg.is_empty() {
                    let kib: usize =
                        arg.trim_end_matches("k").parse().map_err(|_| format!("{arg:?}: KiB, e.g. 200"))?;
                    self.agent.options.context_kib = Some(kib.max(8));
                }
                let budget = self.agent.options.context_kib.map_or(crate::session::CHAR_BUDGET, |k| k * 1024);
                self.session.budget = budget;
                let window: usize = self.session.window().iter().map(|m| m.to_string().len()).sum();
                println!(
                    "{} messages · {} KiB sent per call of {} KiB{}",
                    self.session.messages.len(),
                    window / 1024,
                    budget / 1024,
                    if self.session.summary().is_some() { " · older part summarized" } else { "" }
                );
            }
            "/status" => {
                println!("  {} {}", style::gray("model    "), self.model_label());
                println!("  {} {}", style::gray("approvals"), self.approvals());
                println!("  {} {}", style::gray("private  "), self.agent.gateway.private());
                println!("  {} {}", style::gray("project  "), self.agent.tools.workdir().display());
                println!(
                    "  {} {} ({} messages)",
                    style::gray("session  "),
                    self.session.id,
                    self.session.messages.len()
                );
                let grants: Vec<String> = self.grants.iter().map(Action::describe).collect();
                if !grants.is_empty() {
                    println!("  {} {}", style::gray("always   "), grants.join("; "));
                }
            }
            "/undo" => {
                let (request, files) = self.session.undo()?;
                for file in &files {
                    let shown = Path::new(file)
                        .strip_prefix(self.agent.tools.workdir())
                        .map(|p| p.display().to_string())
                        .unwrap_or_else(|_| file.clone());
                    println!("  {} {}", style::accent("↺"), shown);
                }
                println!(
                    "{}",
                    style::gray(if files.is_empty() {
                        "the last turn changed no files; it is taken back"
                    } else {
                        "put back; the turn is taken back"
                    })
                );
                if request.contains("(I ran `") || request.contains("[Attached @") {
                    return Ok(None);
                }
                return Ok(Some(Next::Prefill(request)));
            }
            "/diff" => {
                let workdir = self.agent.tools.workdir();
                let run = |args: &[&str]| {
                    std::process::Command::new("git")
                        .args(args)
                        .current_dir(workdir)
                        .output()
                        .ok()
                        .map(|o| String::from_utf8_lossy(&o.stdout).into_owned())
                };
                let diff = run(&["diff", "--no-color"]).unwrap_or_default();
                let untracked = run(&["ls-files", "--others", "--exclude-standard"]).unwrap_or_default();
                if diff.is_empty() && untracked.trim().is_empty() {
                    println!("{}", style::gray("no uncommitted changes"));
                }
                print!("{}", render_diff(&diff, 2000));
                for file in untracked.lines() {
                    println!("    {} {file}", style::green("new"));
                }
            }
            "/fork" => {
                let to = if arg.is_empty() { format!("{}-fork", self.session.id) } else { arg.to_owned() };
                let copy = self.session.fork(&self.home.join("sessions"), &to, None)?;
                println!("{}", style::gray(&format!("now in {to} (a copy of {})", self.session.id)));
                self.session = copy;
            }
            "/sessions" => {
                for (name, modified) in crate::session::list(&self.home.join("sessions")).into_iter().take(15) {
                    let ago = modified.elapsed().map(|d| d.as_secs()).unwrap_or(0);
                    let mark = if name == self.session.id { style::accent("●") } else { " ".to_owned() };
                    println!("  {mark} {name} {}", style::gray(&ago_text(ago)));
                }
            }
            "/resume" => {
                if arg.is_empty() {
                    return Err("/resume <name> (see /sessions)".to_owned());
                }
                self.session = Session::open(&self.home.join("sessions"), arg)?;
                self.grants.clear();
                println!("{}", style::gray(&format!("now in {arg} ({} messages)", self.session.messages.len())));
            }
            "/memory" => {
                let facts = crate::memory::Memory::new(&self.home).list();
                if facts.is_empty() {
                    println!("{}", style::gray("nothing remembered yet"));
                }
                for fact in facts {
                    println!("  {} {}", style::gray(&format!("#{}", fact.id)), fact.text);
                }
            }
            "/skills" => {
                let skills = crate::skills::list(&self.home);
                if skills.is_empty() {
                    println!("{}", style::gray("no skills yet (the agent proposes them; `autobot skills`)"));
                }
                for skill in skills {
                    println!("  {} {}", style::bold(&skill.name), style::gray(&skill.description));
                }
                for skill in crate::skills::proposals(&self.home) {
                    println!(
                        "  {} {} {}",
                        style::yellow("proposed"),
                        style::bold(&skill.name),
                        style::gray(&skill.description)
                    );
                }
            }
            "/team" => {
                if self.agent.team.is_empty() {
                    println!("{}", style::gray("no team: add members under [agents.<name>] in the config"));
                } else {
                    print!("{}", self.agent.team.prompt());
                }
            }
            "/board" => print!("{}", crate::board::Board::load(&self.home)?.listing()),
            other => return Err(format!("{other}: not a command (/help)")),
        }
        Ok(None)
    }
}

fn ago_text(secs: u64) -> String {
    match secs {
        0..60 => "just now".to_owned(),
        60..3600 => format!("{} min ago", secs / 60),
        3600..86400 => format!("{} h ago", secs / 3600),
        _ => format!("{} days ago", secs / 86400),
    }
}

/// `@path` in [text]: the files' contents attached (text files in the project, up to 256 KiB
/// each; a directory's listing).
pub fn expand_mentions(text: &str, workdir: &Path, ui: &Ui) -> String {
    let _ = ui;
    let mut attached = String::new();
    let mut seen = HashSet::new();
    for word in text.split_whitespace() {
        let Some(name) = word.strip_prefix('@') else { continue };
        let name = name.trim_end_matches([',', '.', ';', ':', ')', '?', '!']);
        if name.is_empty() || !seen.insert(name.to_owned()) {
            continue;
        }
        let path = workdir.join(name);
        if path.is_dir() {
            let mut names: Vec<String> = std::fs::read_dir(&path)
                .into_iter()
                .flatten()
                .flatten()
                .map(|e| {
                    let dir = e.file_type().is_ok_and(|t| t.is_dir());
                    format!("{}{}", e.file_name().to_string_lossy(), if dir { "/" } else { "" })
                })
                .collect();
            names.sort();
            println!("{}", style::gray(&format!("  ⎿ attached @{name} ({} entries)", names.len())));
            attached.push_str(&format!("\n\n[Attached @{name}: a directory]\n{}", names.join("\n")));
            continue;
        }
        let Ok(meta) = std::fs::metadata(&path) else { continue };
        if meta.len() > 256 * 1024 {
            println!(
                "{}",
                style::yellow(&format!("  ⎿ @{name} is over 256 KiB; not attached (the agent can read it)"))
            );
            continue;
        }
        let Ok(content) = std::fs::read_to_string(&path) else { continue };
        println!("{}", style::gray(&format!("  ⎿ attached @{name} ({} lines)", content.lines().count())));
        attached.push_str(&format!("\n\n[Attached @{name}]\n```\n{}\n```", content.trim_end()));
    }
    format!("{text}{attached}")
}

#[cfg(test)]
mod tests {
    use super::{complete_path, expand_mentions};

    #[test]
    fn mentions_attach_files_and_paths_complete() {
        let dir = std::env::temp_dir().join(format!("autobot-mention-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join("src")).unwrap();
        std::fs::write(dir.join("src/main.rs"), "fn main() {}\n").unwrap();
        std::fs::write(dir.join(".env"), "SECRET=1\n").unwrap();
        let ui = super::Ui::new(dir.clone());
        let text = expand_mentions("look at @src/main.rs, and @missing.txt", &dir, &ui);
        assert!(
            text.starts_with(
                "look at @src/main.rs, and @missing.txt\n\n[Attached @src/main.rs]\n```\nfn main() {}\n```"
            )
        );
        assert!(!text.contains("missing.txt]"));
        assert!(expand_mentions("@src", &dir, &ui).contains("[Attached @src: a directory]\nmain.rs"));
        let names: Vec<String> = complete_path(&dir, "sr").into_iter().map(|p| p.replacement).collect();
        assert_eq!(names, ["src/"]);
        let names: Vec<String> = complete_path(&dir, "src/m").into_iter().map(|p| p.replacement).collect();
        assert_eq!(names, ["src/main.rs"]);
        assert!(complete_path(&dir, "").iter().all(|p| p.replacement != ".env"), "hidden files need a dot");
        std::fs::remove_dir_all(dir).unwrap();
    }
}
