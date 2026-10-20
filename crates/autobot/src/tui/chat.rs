//! The terminal chat (`autobot chat`, and `autobot code` in a project). On a terminal: the
//! scrollback as usual, and at the bottom a composer (several lines, history, the editing keys,
//! long pastes folded), a palette for `/` commands and `@` files, what the agent is doing with a
//! spinner, approvals as a card that takes one key, and a status line. Esc stops a turn; typing
//! while it works steers it. Without a terminal (a pipe, a script) it reads lines and prints
//! plain text.

use std::collections::HashSet;
use std::future::Future;
use std::path::{Path, PathBuf};
use std::pin::Pin;
use std::sync::{Arc, OnceLock};
use std::time::{Duration, Instant};

use crossterm::event::{Event as Key, KeyCode, KeyEvent, KeyEventKind, KeyModifiers};

use super::editor::Editor;
use super::palette::{self, Kind, Palette};
use super::style;
use super::term::{self, say};
use super::ui::{Card, Ui, render_diff};
use super::wrap::{pad, truncate};
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

/// What `autobot code` remembers between runs: the model and the approvals last chosen
/// (`$AUTOBOT_HOME/code.json`), so a plain `autobot code` starts as the last one ended.
#[derive(Clone, Debug, Default, serde::Serialize, serde::Deserialize)]
pub struct Remembered {
    #[serde(default)]
    pub model: Option<String>,
    #[serde(default)]
    pub approvals: Option<String>,
}

impl Remembered {
    pub fn load(home: &Path) -> Self {
        std::fs::read_to_string(home.join("code.json"))
            .ok()
            .and_then(|t| serde_json::from_str(&t).ok())
            .unwrap_or_default()
    }

    pub fn save(&self, home: &Path) {
        if let Ok(text) = serde_json::to_string_pretty(self) {
            let _ = invincible::fsutil::replace_private(&home.join("code.json"), &text);
        }
    }
}

/// The slash commands, for `/help` and the palette.
const COMMANDS: &[(&str, &str)] = &[
    ("/help", "commands and keys"),
    ("/model", "show the models, or switch: /model deepseek"),
    ("/approvals", "show or set: ask, edits (changes in the project run), allowlist, trust"),
    ("/private", "on: local models only; off: cloud models allowed"),
    ("/tools", "show the tools, or keep only some groups: /tools files-read,terminal (or all)"),
    ("/context", "how much of the conversation each call sends, or set it in KiB"),
    ("/undo", "put back the files the last turn changed, and take the turn back"),
    ("/diff", "the project's uncommitted changes (git diff)"),
    ("/init", "write or improve the project's AGENTS.md"),
    ("/compact", "fold the conversation so far into a summary (keeps the last turn)"),
    ("/ps", "background processes: /ps, /ps <n> (its output), /ps stop <n>"),
    ("/commands", "your own commands (.autobot/commands, .claude/commands, ~/.autobot/commands)"),
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

/// The keys, for `/help`.
const KEYS: &[(&str, &str)] = &[
    ("enter", "send (while it works: steer it, read before its next step)"),
    ("alt+enter, ctrl+j", "a new line (or end a line with \\)"),
    ("↑ ↓", "history, or lines in a longer message"),
    ("tab", "complete a /command or @path from the list"),
    ("esc", "stop the turn; close the list"),
    ("ctrl+c", "clear the composer; stop the turn; twice to quit"),
    ("ctrl+d", "quit (on an empty composer)"),
    ("ctrl+a ctrl+e", "start and end of the line"),
    ("ctrl+w ctrl+u ctrl+k", "delete a word back, to the start, to the end (ctrl+y puts it back)"),
    ("alt+b alt+f", "a word back and forward"),
    ("ctrl+l", "clear the screen"),
    ("ctrl+z", "suspend (fg to come back)"),
];

/// One-line tips, one under the banner per start.
const TIPS: &[&str] = &[
    "type / for commands, @ to attach a file, ! to run a command yourself",
    "type while the agent works to steer it; esc stops the turn",
    "alt+enter (or ctrl+j) starts a new line; ↑ brings back what you sent",
    "long pastes fold into one line and go out in full",
    "/undo puts back what the last turn changed",
];

/// Asks in the terminal, one key: y, a (always, this session), n.
struct KeyApprover {
    ui: Arc<Ui>,
    /// Without a terminal: answers come as lines.
    lines: Option<Lines>,
}

type Lines = Arc<tokio::sync::Mutex<tokio::sync::mpsc::UnboundedReceiver<String>>>;

/// The question for [action]: its title and what it is about.
fn question(action: &Action, workdir: &Path) -> (String, String) {
    let who = crate::approval::asker();
    let (title, what) = match action {
        Action::Command(c) => ("Run this command?", style::code(c)),
        Action::Write { path, inside, .. } => (
            "Make this change?",
            format!(
                "{}{}",
                path.strip_prefix(workdir).unwrap_or(path).display(),
                if *inside { String::new() } else { style::yellow(" (outside the project)") }
            ),
        ),
        Action::Read(p) => ("Read outside the project?", p.display().to_string()),
        Action::Cloud(why) => {
            // The gateway's reason, without its note for API clients.
            let why = why.split("; send again").next().unwrap_or(why).trim();
            ("Send this conversation to a cloud model?", format!("{why} {}", style::gray("(a: for this session)")))
        }
        Action::Fetch(url) => ("Fetch this page?", style::underline(url)),
        Action::Mcp { tool, arguments } => {
            ("Use this tool?", format!("{tool} {}", style::gray(&arguments.chars().take(400).collect::<String>())))
        }
    };
    (format!("{who}{title}"), what)
}

impl Approver for KeyApprover {
    fn channel(&self) -> &'static str {
        "cli"
    }

    fn approve<'a>(&'a self, action: &'a Action) -> Pin<Box<dyn Future<Output = Answer> + Send + 'a>> {
        Box::pin(async move {
            let (title, what) = question(action, self.ui.workdir());
            let Some(lines) = &self.lines else {
                // On the terminal: a card above the composer, answered by the next key.
                let (tx, rx) = tokio::sync::oneshot::channel();
                self.ui.ask(Card { title, what }, tx);
                return rx.await.unwrap_or(Answer::Deny);
            };
            self.ui.flush();
            for line in super::ui::card_lines(&Card { title, what }, style::columns()) {
                say(&line);
            }
            // A line: y, a or n; anything else (or the end of the input) is no.
            let answer = match lines.lock().await.recv().await.and_then(|l| l.trim().chars().next()) {
                Some('y' | 'Y') => Answer::Once,
                Some('a' | 'A') => Answer::Always,
                _ => Answer::Deny,
            };
            say(&style::gray(match answer {
                Answer::Once => "→ yes",
                Answer::Always => "→ always, this session",
                Answer::Deny => "→ no",
            }));
            answer
        })
    }
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
    /// `autobot code`: the model and approvals are remembered for next time.
    code: bool,
}

/// What a key asks for.
#[derive(Debug, PartialEq, Eq)]
enum Did {
    Nothing,
    /// Send this: as shown (pastes as labels), as sent (pastes in full).
    Submit(String, String),
    Exit,
    /// Stop the turn.
    Interrupt,
    /// The answer to the question shown.
    Answer(Answer),
}

/// The line under the composer.
#[derive(Clone, Debug, Default)]
struct Status {
    model: String,
    approvals: &'static str,
    project: String,
    branch: Option<String>,
    /// Of the conversation sent per call.
    context: Option<usize>,
    tokens: (u64, u64),
}

/// The composer, the palette, the status line, and where keys and lines come from.
struct App {
    editor: Editor,
    history: PathBuf,
    commands: Vec<(String, String)>,
    /// The project's files, for `@` (filled in the background).
    files: Arc<OnceLock<Vec<String>>>,
    palette: Option<Palette>,
    /// The palette was closed (esc) for this text.
    dismissed: Option<String>,
    /// ctrl+c on an empty composer, waiting for a second.
    exit_armed: Option<Instant>,
    /// A short note for the status line, and until when.
    notice: Option<(String, Instant)>,
    status: Status,
    terminal: Option<term::Terminal>,
    keys: Option<tokio::sync::mpsc::UnboundedReceiver<Key>>,
    /// Without a terminal: lines from stdin.
    lines: Option<Lines>,
    code: bool,
    /// Sent while a turn ran but not for it (commands): run after it.
    queued: Vec<(String, String)>,
}

impl App {
    fn new(home: &Path, workdir: &Path, code: bool) -> Self {
        let history = home.join("history");
        let commands: Vec<(String, String)> = COMMANDS
            .iter()
            .map(|(c, d)| ((*c).to_owned(), (*d).to_owned()))
            .chain(crate::commands::list(workdir, home).into_iter().map(|c| (format!("/{}", c.name), c.description)))
            .collect();
        let files = Arc::new(OnceLock::new());
        {
            let (files, workdir) = (files.clone(), workdir.to_owned());
            std::thread::spawn(move || {
                let _ = files.set(palette::files(&workdir, 20_000));
            });
        }
        let terminal = term::Terminal::take();
        let (keys, lines) = if terminal.is_some() {
            (Some(term::keys()), None)
        } else {
            (None, Some(Arc::new(tokio::sync::Mutex::new(stdin_lines()))))
        };
        Self {
            editor: Editor::with_history(super::editor::load_history(&history)),
            history,
            commands,
            files,
            palette: None,
            dismissed: None,
            exit_armed: None,
            notice: None,
            status: Status::default(),
            terminal,
            keys,
            lines,
            code,
            queued: Vec::new(),
        }
    }

    fn tty(&self) -> bool {
        self.terminal.is_some()
    }

    fn notice(&mut self, text: &str) {
        self.notice = Some((text.to_owned(), Instant::now() + Duration::from_millis(2500)));
    }

    /// The next key (never, without a terminal).
    async fn key(&mut self) -> Option<Key> {
        match &mut self.keys {
            Some(keys) => keys.recv().await,
            None => std::future::pending().await,
        }
    }

    /// The next line without a terminal (None at the end of the input).
    async fn line(&mut self) -> Option<String> {
        let lines = self.lines.clone()?;
        lines.lock().await.recv().await
    }

    /// What is typed, sent (and kept in the history).
    fn submit(&mut self) -> Did {
        let (shown, sent) = self.editor.take();
        super::editor::save_history(&self.history, self.editor.history());
        self.palette = None;
        self.dismissed = None;
        Did::Submit(shown, sent)
    }

    /// The palette for what is typed now.
    fn suggest(&mut self) {
        let text = self.editor.text();
        if self.dismissed.as_deref() == Some(text) {
            self.palette = None;
            return;
        }
        self.dismissed = None;
        let next = palette::suggest(text, self.editor.cursor(), &self.commands, self.files.get().map(Vec::as_slice));
        // The same list keeps its selection.
        let selected = match (&self.palette, &next) {
            (Some(old), Some(new)) if old.items == new.items => old.selected,
            _ => 0,
        };
        self.palette = next.map(|p| Palette { selected, ..p });
    }

    /// Puts the chosen item in; true when it is a command to send now.
    fn complete(&mut self, send: bool) -> bool {
        let Some(palette) = self.palette.take() else { return false };
        let Some(item) = palette.chosen() else { return false };
        match palette.kind {
            Kind::Command => {
                if send {
                    self.editor.set(&item.text);
                    return true;
                }
                self.editor.replace(palette.range.clone(), &format!("{} ", item.text));
            }
            Kind::Path => {
                // A directory stays open for the next part of the path.
                let space = if item.text.ends_with('/') { "" } else { " " };
                self.editor.replace(palette.range.clone(), &format!("{}{space}", item.text));
            }
        }
        self.suggest();
        false
    }

    /// What [key] does, while a turn runs ([running]) or a question waits ([asking]).
    fn press(&mut self, key: Key, running: bool, asking: bool) -> Did {
        let key = match key {
            Key::Key(key) if key.kind != KeyEventKind::Release => key,
            Key::Paste(text) if !asking => {
                self.editor.paste(&text);
                self.suggest();
                return Did::Nothing;
            }
            Key::Resize(width, _) => {
                term::resized(usize::from(width));
                return Did::Nothing;
            }
            _ => return Did::Nothing,
        };
        let KeyEvent { code, modifiers, .. } = key;
        let ctrl = modifiers.contains(KeyModifiers::CONTROL);
        let alt = modifiers.contains(KeyModifiers::ALT);
        if asking {
            return match code {
                KeyCode::Char('c') if ctrl => Did::Interrupt,
                KeyCode::Char('y' | 'Y') if !ctrl => Did::Answer(Answer::Once),
                KeyCode::Char('a' | 'A') if !ctrl => Did::Answer(Answer::Always),
                // Any other key is someone typing, not answering: no (a sentence typed at the
                // prompt must not approve anything with an `a` in it).
                KeyCode::Char(_) | KeyCode::Esc | KeyCode::Enter => Did::Answer(Answer::Deny),
                _ => Did::Nothing,
            };
        }
        if !(ctrl && code == KeyCode::Char('c')) {
            self.exit_armed = None;
        }
        let e = &mut self.editor;
        match code {
            KeyCode::Char('c') if ctrl => {
                if self.palette.is_some() {
                    self.dismissed = Some(e.text().to_owned());
                    self.palette = None;
                } else if !e.is_empty() {
                    e.clear();
                } else if running {
                    return Did::Interrupt;
                } else if self.exit_armed.is_some_and(|t| t.elapsed() < Duration::from_secs(3)) {
                    return Did::Exit;
                } else {
                    self.exit_armed = Some(Instant::now());
                    self.notice("ctrl+c again to quit");
                }
                return Did::Nothing;
            }
            KeyCode::Char('d') if ctrl => {
                if e.is_empty() && !running {
                    return Did::Exit;
                }
                e.delete();
            }
            KeyCode::Esc => {
                if self.palette.is_some() {
                    self.dismissed = Some(e.text().to_owned());
                    self.palette = None;
                    return Did::Nothing;
                }
                if running {
                    return Did::Interrupt;
                }
            }
            KeyCode::Enter if alt || modifiers.contains(KeyModifiers::SHIFT) => e.insert_char('\n'),
            KeyCode::Char('j') if ctrl => e.insert_char('\n'),
            KeyCode::Enter => {
                if self.palette.is_some() {
                    if self.complete(true) {
                        return self.submit();
                    }
                    return Did::Nothing;
                }
                // `\` at the end of a line goes on to the next.
                if e.text()[..e.cursor()].ends_with('\\') {
                    e.backspace();
                    e.insert_char('\n');
                } else if !e.text().trim().is_empty() {
                    return self.submit();
                }
            }
            KeyCode::Tab => {
                self.complete(false);
                return Did::Nothing;
            }
            KeyCode::BackTab => {
                if let Some(p) = &mut self.palette {
                    p.up();
                }
                return Did::Nothing;
            }
            KeyCode::Up | KeyCode::Char('p') if code == KeyCode::Up || ctrl => {
                if let Some(p) = &mut self.palette {
                    p.up();
                    return Did::Nothing;
                }
                e.up();
            }
            KeyCode::Down | KeyCode::Char('n') if code == KeyCode::Down || ctrl => {
                if let Some(p) = &mut self.palette {
                    p.down();
                    return Did::Nothing;
                }
                e.down();
            }
            KeyCode::Left if ctrl || alt => e.word_left(),
            KeyCode::Right if ctrl || alt => e.word_right(),
            KeyCode::Left => e.left(),
            KeyCode::Right => e.right(),
            KeyCode::Char('b') if ctrl => e.left(),
            KeyCode::Char('f') if ctrl => e.right(),
            KeyCode::Char('b') if alt => e.word_left(),
            KeyCode::Char('f') if alt => e.word_right(),
            KeyCode::Home => e.home(),
            KeyCode::End => e.end(),
            KeyCode::Char('a') if ctrl => e.home(),
            KeyCode::Char('e') if ctrl => e.end(),
            KeyCode::Backspace if alt || ctrl => e.kill_word(),
            KeyCode::Char('w') if ctrl => e.kill_word(),
            KeyCode::Char('h') if ctrl => e.backspace(),
            KeyCode::Backspace => e.backspace(),
            KeyCode::Delete => e.delete(),
            KeyCode::Char('d') if alt => e.kill_word_forward(),
            KeyCode::Char('u') if ctrl => e.kill_to_start(),
            KeyCode::Char('k') if ctrl => e.kill_to_end(),
            KeyCode::Char('y') if ctrl => e.yank(),
            KeyCode::Char('l') if ctrl => term::clear(),
            KeyCode::Char('z') if ctrl => {
                if let Some(t) = &self.terminal {
                    t.stop();
                }
            }
            KeyCode::Char(c) if !ctrl => e.insert_char(c),
            _ => {}
        }
        self.suggest();
        Did::Nothing
    }

    /// The live region: what the agent is doing, the composer, the palette or status line.
    fn draw(&mut self, ui: &Ui) {
        if !self.tty() {
            return;
        }
        if self.notice.as_ref().is_some_and(|(_, until)| Instant::now() > *until) {
            self.notice = None;
        }
        let width = style::columns().saturating_sub(1).max(20);
        let height = style::rows();
        let running = ui.running();
        let asking = ui.card().is_some();
        // The composer: `│ › text │`, at most 8 rows of it, scrolled to the cursor.
        let inner = width.saturating_sub(6).max(4);
        let (rows, (crow, ccol)) = self.editor.layout(inner);
        let shown = 8.min(rows.len());
        let first = (crow + 1).saturating_sub(shown).min(rows.len() - shown);
        let mut composer = vec![style::faint(&format!("╭{}╮", "─".repeat(width - 2)))];
        let empty = self.editor.is_empty();
        for (i, row) in rows.iter().enumerate().skip(first).take(shown) {
            let lead = if i == 0 { format!("{} ", style::bold(&style::accent("›"))) } else { "  ".to_owned() };
            let text = if empty {
                let hint = match (running, self.code) {
                    _ if asking => "y, a or n answers the question above",
                    (true, _) => "type to steer it; enter sends before its next step",
                    (false, true) => "ask for a change, / for commands, @ to attach a file",
                    (false, false) => "ask anything, / for commands, @ to attach a file",
                };
                style::faint(&truncate(hint, inner))
            } else {
                let mut row = row.clone();
                for label in self.editor.paste_labels() {
                    row = row.replace(label, &style::gray(label));
                }
                row
            };
            composer.push(format!("{} {lead}{} {}", style::faint("│"), pad(&text, inner), style::faint("│")));
        }
        composer.push(style::faint(&format!("╰{}╯", "─".repeat(width - 2))));
        // Under it: the palette, or the status line.
        let under: Vec<String> = match &self.palette {
            Some(p) if !asking => palette_lines(p, width),
            _ => vec![self.status_line(width, running, asking)],
        };
        let fixed = 1 + composer.len() + under.len() + 1;
        let room = height.saturating_sub(fixed + 2).max(1);
        let mut head = if term::after_blank() || ui.streaming() { Vec::new() } else { vec![String::new()] };
        let live = ui.live(width, room);
        if !live.is_empty() {
            head.extend(live);
            head.push(String::new());
        }
        // Never taller than the screen: what the agent is doing gives way first.
        let over = (head.len() + composer.len() + under.len() + 1).saturating_sub(height);
        head.drain(..over.min(head.len()));
        let box_top = head.len();
        let cursor = (!asking).then_some((box_top + 1 + crow - first, 4 + if empty { 0 } else { ccol }));
        let lines = head.into_iter().chain(composer).chain(under).map(|l| truncate(&l, width)).collect();
        term::draw(lines, cursor);
    }

    fn status_line(&self, width: usize, running: bool, asking: bool) -> String {
        let hint = match &self.notice {
            Some((notice, _)) => style::yellow(notice),
            None => style::faint(hint(asking, running, self.editor.is_empty())),
        };
        status_line(&self.status, &hint, width)
    }
}

/// What the keys do now, for the right of the status line.
fn hint(asking: bool, running: bool, empty: bool) -> &'static str {
    match (asking, running, empty) {
        (true, ..) => "y yes · a always · n no",
        (_, true, true) => "esc to interrupt",
        (_, true, false) => "enter steers · esc interrupts",
        (_, false, true) => "/ commands · @ files · ! shell",
        (_, false, false) => "enter send · alt+enter new line",
    }
}

/// `model · approvals · project branch · context · tokens` on the left, [hint] on the right; what
/// does not fit goes, from the end of the left.
fn status_line(s: &Status, hint: &str, width: usize) -> String {
    let approvals = if s.approvals == "trust" { style::yellow(s.approvals) } else { style::gray(s.approvals) };
    let mut parts = vec![style::gray(&s.model), format!("{} {approvals}", style::faint("approvals"))];
    if !s.project.is_empty() {
        let branch = s.branch.as_ref().map(|b| format!(" {}", style::faint(b))).unwrap_or_default();
        parts.push(format!("{}{branch}", style::gray(&s.project)));
    }
    if let Some(pct) = s.context {
        parts.push(format!("{} {}", style::faint("context"), style::gray(&format!("{pct}%"))));
    }
    if s.tokens.0 > 0 {
        parts.push(style::faint(&format!(
            "{} in · {} out",
            super::ui::short(s.tokens.0),
            super::ui::short(s.tokens.1)
        )));
    }
    let sep = style::faint(" · ");
    loop {
        let left = format!("  {}", parts.join(&sep));
        let gap = width.saturating_sub(style::width(&left) + style::width(hint));
        if gap >= 2 || parts.len() <= 1 {
            return truncate(&format!("{left}{}{hint}", " ".repeat(gap.max(2))), width);
        }
        parts.pop();
    }
}

/// The palette's rows: the chosen one marked, each with its line about it.
fn palette_lines(p: &Palette, width: usize) -> Vec<String> {
    let (start, items) = p.window(7);
    let name_width = items.iter().map(|i| style::width(&i.text)).max().unwrap_or(0).clamp(8, 24);
    let mut out: Vec<String> = items
        .iter()
        .enumerate()
        .map(|(i, item)| {
            let chosen = start + i == p.selected;
            let mark = if chosen { style::accent("›") } else { " ".to_owned() };
            let name = pad(&item.text, name_width);
            let name = if chosen { style::bold(&name) } else { style::gray(&name) };
            let detail = truncate(&item.detail, width.saturating_sub(name_width + 6));
            truncate(&format!("  {mark} {name}  {}", style::faint(&detail)), width)
        })
        .collect();
    if p.items.len() > items.len() {
        out.push(style::faint(&format!("    {} of {} · tab completes · esc closes", p.selected + 1, p.items.len())));
    }
    out
}

/// Lines from stdin, without a terminal (a `\` at the end of a line goes on to the next).
fn stdin_lines() -> tokio::sync::mpsc::UnboundedReceiver<String> {
    let (tx, rx) = tokio::sync::mpsc::unbounded_channel();
    std::thread::spawn(move || {
        use std::io::BufRead;
        let mut pending = String::new();
        for line in std::io::stdin().lock().lines() {
            let Ok(line) = line else { break };
            if let Some(start) = line.strip_suffix('\\') {
                pending.push_str(start);
                pending.push('\n');
                continue;
            }
            pending.push_str(&line);
            if tx.send(std::mem::take(&mut pending)).is_err() {
                break;
            }
        }
    });
    rx
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
        code: false,
    };
    if let Some(model) = &options.model {
        chat.choose_model(model).await?;
    }
    chat.code = options.code;
    chat.remember();
    let mut app = App::new(&home, chat.agent.tools.workdir(), options.code);
    if app.tty() {
        // Killed or hung up: the terminal is put back first.
        tokio::spawn(async {
            use tokio::signal::unix::{SignalKind, signal};
            let (Ok(mut terminate), Ok(mut hangup)) = (signal(SignalKind::terminate()), signal(SignalKind::hangup()))
            else {
                return;
            };
            tokio::select! {
                _ = terminate.recv() => {}
                _ = hangup.recv() => {}
            }
            term::restore();
            crate::procs::stop_all().await;
            std::process::exit(143);
        });
    }
    chat.banner(options.code);
    app.status = chat.status();
    let mut tick = tokio::time::interval(Duration::from_millis(70));
    loop {
        let (shown, sent) = if app.tty() {
            app.draw(&ui);
            tokio::select! {
                key = app.key() => {
                    let Some(key) = key else { return Ok(()) };
                    match app.press(key, false, false) {
                        Did::Submit(shown, sent) => (shown, sent),
                        Did::Exit => break,
                        _ => continue,
                    }
                }
                _ = tick.tick() => continue,
            }
        } else {
            match app.line().await {
                Some(line) => (line.clone(), line),
                None => break,
            }
        };
        match chat.handle(&mut app, &shown, &sent).await {
            Some(Next::Exit) => break,
            Some(Next::Prefill(text)) => app.editor.set(&text),
            _ => {}
        }
        app.status = chat.status();
    }
    // The composer goes; the scrollback stays as it was.
    drop(app);
    Ok(())
}

enum Next {
    Exit,
    /// Start the next prompt with this text (an undone request, to change and send again).
    Prefill(String),
    /// Send this as the owner's message (a command's prompt).
    Send(String),
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

    /// The project's path for people: `~/src/app`, its middle left out when long.
    fn shown_workdir(&self, room: usize) -> String {
        let workdir = self.agent.tools.workdir();
        let shown = match std::env::var_os("HOME").map(PathBuf::from) {
            Some(home) => match workdir.strip_prefix(&home) {
                Ok(rest) => format!("~/{}", rest.display()),
                Err(_) => workdir.display().to_string(),
            },
            None => workdir.display().to_string(),
        };
        if shown.chars().count() <= room {
            return shown;
        }
        let chars: Vec<char> = shown.chars().collect();
        let keep = room / 2 - 1;
        format!(
            "{}…{}",
            chars[..keep].iter().collect::<String>(),
            chars[chars.len() - keep..].iter().collect::<String>()
        )
    }

    fn banner(&self, code: bool) {
        // Long paths keep their start and end.
        let shown = self.shown_workdir(style::columns().saturating_sub(40).max(24));
        let branch = self.agent.tools.git_branch().map(|b| format!("  {}", style::gray(&b))).unwrap_or_default();
        let notes = if self.agent.tools.project_notes().is_some() {
            format!("  {}", style::faint("AGENTS.md"))
        } else {
            String::new()
        };
        let messages = self.session.messages.len();
        // `■ autobot 0.0.9 · via invincible`, then what this session is, as quiet rows.
        // Beside the symbol the name stands alone; without it (no color) the mark leads.
        let symbol = invincible::brand::Product::Autobot.symbol();
        let name = if symbol.is_empty() {
            invincible::brand::Product::Autobot.header(env!("CARGO_PKG_VERSION"))
        } else {
            format!("{} {}", style::bold("autobot"), style::gray(env!("CARGO_PKG_VERSION")))
        };
        let header = format!("{name} {}", style::faint("· via invincible"));
        let private = if self.agent.gateway.private() { style::faint("  private") } else { String::new() };
        let rows = [
            ("model", format!("{}{private}", self.model_label())),
            ("approvals", self.approvals().to_owned()),
            ("project", format!("{shown}{branch}{notes}")),
            (
                "session",
                format!(
                    "{}{}",
                    self.session.id,
                    if messages > 0 { style::faint(&format!("  {messages} messages")) } else { String::new() }
                ),
            ),
        ];
        // The symbol beside the first three lines (only with color; half blocks need it).
        let lines: Vec<String> =
            std::iter::once(header).chain(invincible::brand::rows(&rows).lines().map(str::to_owned)).collect();
        let mut out = String::new();
        for (i, line) in lines.iter().enumerate() {
            match (symbol.is_empty(), symbol.get(i)) {
                (true, _) => out.push_str(&format!("{line}\n")),
                (false, Some(art)) => out.push_str(&format!("{art}  {line}\n")),
                (false, None) => out.push_str(&format!("        {line}\n")),
            }
        }
        // One tip, a different one each start (/undo only where there is a project); none
        // without a terminal, where there are no keys.
        if !term::active() {
            term::print(&out);
            return;
        }
        let tips: Vec<&str> = TIPS.iter().copied().filter(|t| code || !t.contains("/undo")).collect();
        let n = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.as_secs() as usize);
        out.push_str(&format!("\n{}\n", style::faint(&format!("  tip: {}", tips[n % tips.len()]))));
        term::print(&out);
    }

    /// What the status line says now.
    fn status(&self) -> Status {
        let mut model = self.model_label();
        // What `auto` chose last.
        let used = self.ui.models();
        if self.agent.gateway.model() == "auto" && !used.is_empty() {
            model = format!("auto → {}", used.join(", "));
        }
        let budget = self.agent.options.context_kib.map_or(crate::session::CHAR_BUDGET, |k| k * 1024);
        let window: usize = self.session.window().iter().map(|m| m.to_string().len()).sum();
        let project =
            self.agent.tools.workdir().file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
        Status {
            model,
            approvals: self.approvals(),
            project,
            branch: self.agent.tools.git_branch(),
            context: (window > 0).then(|| (window * 100 / budget.max(1)).min(100)),
            tokens: self.ui.total_tokens(),
        }
    }

    /// What was sent at the composer: shown in the scrollback, then a command, a shell command
    /// or a turn.
    async fn handle(&mut self, app: &mut App, shown: &str, sent: &str) -> Option<Next> {
        let text = sent.trim();
        if text.is_empty() {
            return None;
        }
        if app.tty() {
            let mut lines = shown.trim_end().lines();
            let mut echo = format!("\n{} {}\n", style::bold(&style::accent("›")), lines.next().unwrap_or_default());
            for line in lines {
                echo.push_str(&format!("  {line}\n"));
            }
            term::print(&echo);
        }
        if let Some(command) = text.strip_prefix('!') {
            self.shell(command.trim()).await;
            return None;
        }
        if text.starts_with('/') {
            match self.command(text).await {
                Ok(Some(Next::Send(text))) => self.turn(app, &text).await,
                Ok(next) => return next,
                Err(e) => say(&style::red(&e)),
            }
            return None;
        }
        self.turn(app, text).await;
        None
    }

    async fn turn(&mut self, app: &mut App, text: &str) {
        let mut request = expand_mentions(text, self.agent.tools.workdir(), &self.ui);
        let shell = std::mem::take(&mut self.shell);
        if !shell.is_empty() {
            request = format!("{shell}\n\n{request}");
        }
        let ui = self.ui.clone();
        ui.begin();
        let inbox: crate::tools::Inbox = Arc::default();
        let approver = KeyApprover { ui: ui.clone(), lines: app.lines.clone() };
        let events = |event: crate::agent::Event| ui.event(event);
        let mut tick = tokio::time::interval(Duration::from_millis(70));
        let tty = app.tty();
        let outcome = {
            let context = crate::tools::TurnContext { inbox: Some(inbox.clone()), ..Default::default() };
            let turn = crate::tools::TURN
                .scope(context, self.agent.turn(&mut self.session, &request, &approver, &mut self.grants, &events));
            let mut turn = std::pin::pin!(turn);
            loop {
                app.draw(&ui);
                tokio::select! {
                    outcome = &mut turn => break Some(outcome),
                    // Without a terminal (with one, ctrl+c is a key).
                    _ = async {
                        match tty {
                            true => std::future::pending().await,
                            false => tokio::signal::ctrl_c().await,
                        }
                    } => break None,
                    Some(key) = app.key() => match app.press(key, true, ui.card().is_some()) {
                        Did::Interrupt => break None,
                        Did::Answer(answer) => {
                            ui.respond(answer);
                        }
                        Did::Submit(shown, sent) => {
                            if sent.trim_start().starts_with(['/', '!']) {
                                ui.note(&format!("{} {}  {}", style::faint("↳"), shown.trim(), style::faint("(runs when this turn ends)")));
                                app.queued.push((shown, sent));
                            } else {
                                ui.note(&format!("{} {}  {}", style::accent("↳"), shown.trim(), style::faint("(it reads this before its next step)")));
                                inbox.lock().expect("inbox").push(sent.trim().to_owned());
                            }
                        }
                        _ => {}
                    },
                    _ = tick.tick() => {}
                }
            }
        };
        drop(approver);
        match outcome {
            Some(Ok(outcome)) => {
                ui.answer(&outcome.text);
                ui.end(None);
                // Typed while it finished: the agent never saw it, so it is the next request.
                let unread: Vec<String> = std::mem::take(&mut *inbox.lock().expect("inbox"));
                if !unread.is_empty() {
                    let next = unread.join("\n");
                    say(&format!("\n{} {}", style::bold(&style::accent("›")), next));
                    Box::pin(self.turn(app, &next)).await;
                }
            }
            Some(Err(e)) => {
                ui.end(None);
                say(&format!("{} {}", style::red("✗"), e));
            }
            None => {
                // The conversation stays one a model accepts (its open calls get an answer), and
                // what `!command` printed goes with the next request instead.
                let _ = self.session.close_dangling();
                self.shell = shell;
                ui.end(Some("stopped"));
            }
        }
        app.status = self.status();
        // What was sent for after the turn.
        for (shown, sent) in std::mem::take(&mut app.queued) {
            if let Some(Next::Prefill(text)) = Box::pin(self.handle(app, &shown, &sent)).await {
                app.editor.set(&text);
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
                term::print(&text);
                if !text.ends_with('\n') && !text.is_empty() {
                    say("");
                }
                let code = out.status.code().map_or("killed".to_owned(), |c| format!("exit code {c}"));
                say(&style::gray(&format!("  ─ {code} · goes with your next message")));
                let text = crate::tools::cut(text);
                self.shell.push_str(&format!("(I ran `{command}` myself; {code}:)\n```\n{}\n```\n", text.trim_end()));
            }
            Err(e) => say(&style::red(&format!("{command}: {e}"))),
        }
    }

    /// `autobot code` remembers the model and approvals for next time.
    fn remember(&self) {
        if self.code {
            let remembered = Remembered {
                model: Some(self.agent.gateway.model().to_owned()).filter(|m| m != "auto"),
                approvals: Some(self.approvals().to_owned()),
            };
            remembered.save(&self.home);
        }
    }

    /// Switches to [id]; a provider the gateway does not have yet (`anthropic`, `deepseek`, …)
    /// is offered to be set up first: its key asked for here, added with `invincible cloud add`
    /// (which restarts the gateway service).
    async fn choose_model(&mut self, id: &str) -> Result<(), String> {
        // What the gateway serves now (when it cannot say, the switch itself finds out).
        let known = match self.agent.gateway.model_info().await {
            Ok(models) => {
                self.models = models;
                id == "auto" || self.models.iter().any(|m| m.id == id)
            }
            Err(_) => true,
        };
        let Some(preset) = invincible::cloud::preset(id).filter(|_| !known) else { return self.switch_model(id) };
        if !std::io::IsTerminal::is_terminal(&std::io::stdin()) {
            return Err(format!("{id} is not set up on the gateway: `invincible cloud add {id}`"));
        }
        let model =
            preset.model.ok_or(format!("{id} needs a model name: `invincible cloud add {id} --model <name>`"))?;
        say(&format!(
            "{} {}",
            style::bold(&format!("{id} is not set up on this gateway yet.")),
            style::gray(&format!("It would use {model} at {}, data policy {}.", preset.base_url, preset.data_policy))
        ));
        // The terminal goes back to lines while the key is typed.
        let ours = term::active();
        if ours {
            term::suspend();
        }
        let key = invincible::term::read_hidden(&format!("  {id} API key (not shown; empty to cancel): "));
        if ours {
            term::resume();
        }
        let key = key.map_err(|_| "cancelled".to_owned())?;
        let invincible = crate::find_program("invincible").ok_or("the `invincible` command is not installed")?;
        let mut child = std::process::Command::new(invincible)
            .args(["cloud", "add", id, "--key-stdin", "--quiet"])
            .stdin(std::process::Stdio::piped())
            .spawn()
            .map_err(|e| e.to_string())?;
        if let Some(mut stdin) = child.stdin.take() {
            use std::io::Write as _;
            let _ = writeln!(stdin, "{key}");
        }
        if !child.wait().is_ok_and(|s| s.success()) {
            return Err(format!("{id} was not added"));
        }
        // The gateway comes back with it.
        let started = std::time::Instant::now();
        while started.elapsed() < std::time::Duration::from_secs(20) {
            if let Ok(models) = self.agent.gateway.model_info().await
                && models.iter().any(|m| m.id == id)
            {
                self.models = models;
                return self.switch_model(id);
            }
            tokio::time::sleep(std::time::Duration::from_millis(500)).await;
        }
        Err(format!("{id} is added; restart the gateway (`invincible serve`), then /model {id}"))
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
                    say(&format!("  {} {}", style::bold(&format!("{command:<11}")), style::gray(what)));
                }
                say(&format!(
                    "  {} {}",
                    style::bold(&format!("{:<11}", "@path")),
                    style::gray("attach a file (tab completes)")
                ));
                say(&format!(
                    "  {} {}",
                    style::bold(&format!("{:<11}", "!command")),
                    style::gray("run it yourself; its output goes with your next message")
                ));
                for c in crate::commands::list(self.agent.tools.workdir(), &self.home) {
                    say(&format!("  {} {}", style::bold(&format!("/{:<10}", c.name)), style::gray(&c.description)));
                }
                if term::active() {
                    say(&format!("\n  {}", style::gray("keys")));
                    for (keys, what) in KEYS {
                        say(&format!("  {} {}", style::bold(&format!("{keys:<21}")), style::gray(what)));
                    }
                }
            }
            "/init" => return Ok(Some(Next::Send(crate::commands::INIT.to_owned()))),
            "/compact" => {
                say(&style::gray("summarizing…"));
                let confirmed = arg == "yes" || self.grants.iter().any(|a| matches!(a, Action::Cloud(_)));
                let folded = match self.agent.compact_now(&mut self.session, confirmed, &|_| {}).await {
                    Ok(folded) => folded,
                    Err(crate::gateway::GatewayError::Confirm(why)) => {
                        return Err(format!("{why}: `/compact yes` sends the conversation to it to summarize"));
                    }
                    Err(e) => return Err(e.to_string()),
                };
                if folded == 0 {
                    say(&style::gray("nothing to fold yet"));
                } else {
                    say(&style::gray(&format!(
                        "folded {folded} messages into the summary; the last turn stays as it is"
                    )));
                }
            }
            "/ps" => {
                let (action, id) = match arg.split_once(' ') {
                    Some((action, id)) => (action, id.trim()),
                    None if arg.is_empty() => ("list", ""),
                    None => ("output", arg),
                };
                let id = || id.parse::<u32>().map_err(|_| "/ps <n> or /ps stop <n> (see /ps)".to_owned());
                let text = match action {
                    "list" => crate::procs::list(),
                    "stop" | "kill" => crate::procs::stop(id()?).await?,
                    _ => crate::procs::output(id()?, std::time::Duration::ZERO).await?,
                };
                say(&style::gray(text.trim_end()));
            }
            "/commands" => {
                let all = crate::commands::list(self.agent.tools.workdir(), &self.home);
                if all.is_empty() {
                    say(&style::gray(
                        "no commands yet: a Markdown file in .autobot/commands (this project) or ~/.autobot/commands is one; $ARGUMENTS takes what follows",
                    ));
                }
                for c in all {
                    say(&format!("  {} {}", style::bold(&format!("/{:<10}", c.name)), style::gray(&c.description)));
                }
            }
            "/clear" => term::clear(),
            "/new" => {
                self.session.reset()?;
                self.grants.clear();
                say(&style::gray("a new conversation"));
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
                    say(&format!(
                        "  {mark} {} {}{health}",
                        style::bold(&m.id),
                        style::gray(&format!("{}{context}", m.tier))
                    ));
                }
                let auto = if current == "auto" { style::accent("●") } else { " ".to_owned() };
                say(&format!("  {auto} {} {}", style::bold("auto"), style::gray("the gateway's router picks")));
            }
            "/model" | "/models" => {
                self.choose_model(arg).await?;
                self.remember();
                say(&format!(
                    "{} {}{}",
                    style::gray("model"),
                    self.model_label(),
                    if self.agent.gateway.private() { "" } else { " · cloud allowed" }
                ));
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
                    self.remember();
                }
                let what = match self.agent.approvals.mode {
                    ApprovalMode::Ask => "everything that changes something asks first",
                    ApprovalMode::Edits => "changes in the project run (diffs shown, /undo puts back); commands ask",
                    ApprovalMode::Allowlist => "allowlisted commands and project changes run; the rest is refused",
                    ApprovalMode::Trust => "everything runs without asking",
                };
                say(&format!("{} {}", style::bold(self.approvals()), style::gray(what)));
            }
            "/private" => {
                match arg {
                    "on" => self.agent.gateway = self.agent.gateway.with_private(true),
                    "off" => self.agent.gateway = self.agent.gateway.with_private(false),
                    "" => {}
                    other => return Err(format!("{other:?}: on or off")),
                }
                say(if self.agent.gateway.private() {
                    "private: local models only"
                } else {
                    "not private: the router may use cloud models"
                });
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
                say(&names.join(", "));
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
                say(&format!(
                    "{} messages · {} KiB sent per call of {} KiB{}",
                    self.session.messages.len(),
                    window / 1024,
                    budget / 1024,
                    if self.session.summary().is_some() { " · older part summarized" } else { "" }
                ));
            }
            "/status" => {
                let mut rows = vec![
                    ("model", self.model_label()),
                    ("approvals", self.approvals().to_owned()),
                    ("private", self.agent.gateway.private().to_string()),
                    ("project", self.agent.tools.workdir().display().to_string()),
                    ("session", format!("{} ({} messages)", self.session.id, self.session.messages.len())),
                ];
                let running = crate::procs::running();
                if running > 0 {
                    rows.push(("processes", format!("{running} running (/ps)")));
                }
                let grants: Vec<String> = self.grants.iter().map(Action::describe).collect();
                if !grants.is_empty() {
                    rows.push(("always", grants.join("; ")));
                }
                term::print(&invincible::brand::rows(&rows));
            }
            "/undo" => {
                let (request, files) = self.session.undo()?;
                for file in &files {
                    let shown = Path::new(file)
                        .strip_prefix(self.agent.tools.workdir())
                        .map(|p| p.display().to_string())
                        .unwrap_or_else(|_| file.clone());
                    say(&format!("  {} {}", style::gray("↺"), shown));
                }
                say(&style::gray(if files.is_empty() {
                    "the last turn changed no files; it is taken back"
                } else {
                    "put back; the turn is taken back"
                }));
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
                    say(&style::gray("no uncommitted changes"));
                }
                term::print(&render_diff(&diff, 2000));
                for file in untracked.lines() {
                    say(&format!("    {} {file}", style::green("new")));
                }
            }
            "/fork" => {
                let to = if arg.is_empty() { format!("{}-fork", self.session.id) } else { arg.to_owned() };
                let copy = self.session.fork(&self.home.join("sessions"), &to, None)?;
                say(&style::gray(&format!("now in {to} (a copy of {})", self.session.id)));
                self.session = copy;
            }
            "/sessions" => {
                for (name, modified) in crate::session::list(&self.home.join("sessions")).into_iter().take(15) {
                    let ago = modified.elapsed().map(|d| d.as_secs()).unwrap_or(0);
                    let mark = if name == self.session.id { style::accent("●") } else { " ".to_owned() };
                    say(&format!("  {mark} {name} {}", style::gray(&ago_text(ago))));
                }
            }
            "/resume" => {
                if arg.is_empty() {
                    return Err("/resume <name> (see /sessions)".to_owned());
                }
                self.session = Session::open(&self.home.join("sessions"), arg)?;
                self.grants.clear();
                say(&style::gray(&format!("now in {arg} ({} messages)", self.session.messages.len())));
            }
            "/memory" => {
                let facts = crate::memory::Memory::new(&self.home).list();
                if facts.is_empty() {
                    say(&style::gray("nothing remembered yet"));
                }
                for fact in facts {
                    say(&format!("  {} {}", style::gray(&format!("#{}", fact.id)), fact.text));
                }
            }
            "/skills" => {
                let skills = crate::skills::list(&self.home);
                if skills.is_empty() {
                    say(&style::gray("no skills yet (the agent proposes them; `autobot skills`)"));
                }
                for skill in skills {
                    say(&format!("  {} {}", style::bold(&skill.name), style::gray(&skill.description)));
                }
                for skill in crate::skills::proposals(&self.home) {
                    say(&format!(
                        "  {} {} {}",
                        style::yellow("proposed"),
                        style::bold(&skill.name),
                        style::gray(&skill.description)
                    ));
                }
            }
            "/team" => {
                if self.agent.team.is_empty() {
                    say(&style::gray("no team: add members under [agents.<name>] in the config"));
                } else {
                    term::print(&self.agent.team.prompt());
                }
            }
            "/board" => term::print(&crate::board::Board::load(&self.home)?.listing()),
            other => {
                let custom = crate::commands::list(self.agent.tools.workdir(), &self.home);
                let Some(command) = custom.iter().find(|c| other.strip_prefix('/') == Some(c.name.as_str())) else {
                    return Err(format!("{other}: not a command (/help)"));
                };
                let prompt = crate::commands::expand(command, arg)?;
                say(&style::gray(&format!("  └ /{} ({} characters)", command.name, prompt.len())));
                return Ok(Some(Next::Send(prompt)));
            }
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
        // In the project only: anything else is the agent's to read, with the owner's approval.
        let Some(path) =
            workdir.join(name).canonicalize().ok().filter(|p| workdir.canonicalize().is_ok_and(|w| p.starts_with(w)))
        else {
            if std::fs::symlink_metadata(workdir.join(name)).is_ok() {
                say(&style::yellow(&format!(
                    "  └ @{name} is outside the project; not attached (the agent can ask to read it)"
                )));
            }
            continue;
        };
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
            say(&style::gray(&format!("  └ attached @{name} ({} entries)", names.len())));
            attached.push_str(&format!("\n\n[Attached @{name}: a directory]\n{}", names.join("\n")));
            continue;
        }
        let Ok(meta) = std::fs::metadata(&path) else { continue };
        if !meta.is_file() {
            continue;
        }
        if meta.len() > 256 * 1024 {
            say(&style::yellow(&format!("  └ @{name} is over 256 KiB; not attached (the agent can read it)")));
            continue;
        }
        let Ok(content) = std::fs::read_to_string(&path) else {
            say(&style::yellow(&format!("  └ @{name} is not a text file; not attached")));
            continue;
        };
        say(&style::gray(&format!("  └ attached @{name} ({} lines)", content.lines().count())));
        attached.push_str(&format!("\n\n[Attached @{name}]\n```\n{}\n```", content.trim_end()));
    }
    format!("{text}{attached}")
}

#[cfg(test)]
mod tests {
    use super::{Status, expand_mentions, hint, status_line};

    #[test]
    fn the_status_line_fits_and_its_hints_follow_the_state() {
        let status = Status {
            model: "auto → qwen (node)".into(),
            approvals: "edits",
            project: "app".into(),
            branch: Some("main".into()),
            context: Some(12),
            tokens: (18_200, 412),
        };
        let wide = status_line(&status, hint(false, false, true), 120);
        assert_eq!(super::style::width(&wide), 120);
        assert!(
            wide.starts_with("  auto → qwen (node) · approvals edits · app main · context 12% · 18.2k in · 412 out ")
        );
        assert!(wide.ends_with("  / commands · @ files · ! shell"));
        // Narrower: the tokens go first, then the context, then the project.
        let narrow = status_line(&status, hint(false, true, true), 70);
        assert_eq!(narrow, "  auto → qwen (node) · approvals edits · app main     esc to interrupt");
        assert!(super::style::width(&status_line(&status, "x", 30)) <= 30);
        assert_eq!(hint(true, true, false), "y yes · a always · n no");
        assert_eq!(hint(false, true, false), "enter steers · esc interrupts");
    }

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
        // Nothing outside the project, by path or through a link.
        let outside = std::env::temp_dir().join(format!("autobot-mention-out-{}", std::process::id()));
        std::fs::write(&outside, "secret").unwrap();
        std::os::unix::fs::symlink(&outside, dir.join("link")).unwrap();
        for mention in [format!("@{}", outside.display()), "@../x".into(), "@link".into(), "@/dev/zero".into()] {
            assert!(!expand_mentions(&mention, &dir, &ui).contains("[Attached"), "{mention}");
        }
        std::fs::remove_file(outside).unwrap();
        // `@` offers the project's files, hidden ones left out.
        let files = crate::tui::palette::files(&dir, 100);
        assert_eq!(files, ["link", "src/", "src/main.rs"]);
        let offered = crate::tui::palette::suggest("@sr", 3, &[], Some(&files)).unwrap();
        assert_eq!(offered.items[0].text, "@src/");
        std::fs::remove_dir_all(dir).unwrap();
    }
}
