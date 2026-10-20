//! The terminal chat (`autobot chat`, and `autobot code` in a project). On a terminal: the
//! scrollback as usual, and at the bottom a composer (several lines, history, the editing keys,
//! long pastes folded), a palette for `/` commands and `@` files, what the agent is doing with a
//! spinner, approvals as a card that takes one key (or `e`, and what to do instead), and a
//! status line. Esc stops a turn; typing while it works steers it; ctrl+r searches what was
//! sent. `/model` and `/resume` alone open a picker. Images go with a message as tokens in the
//! composer (`@shot.png`, a dragged-in path, `/image <path>`, ctrl+v) when the model can see them. The window's title names the project, and a
//! long turn's end or a waiting question notifies. Without a terminal (a pipe, a script) it reads
//! lines and prints plain text.

use std::collections::HashSet;
use std::future::Future;
use std::path::{Path, PathBuf};
use std::pin::Pin;
use std::sync::{Arc, OnceLock};
use std::time::{Duration, Instant};

use crossterm::event::{Event as Key, KeyCode, KeyEvent, KeyEventKind, KeyModifiers};

use super::editor::Editor;
use super::osc;
use super::palette::{self, Item, Kind, Palette, Picker};
use super::style;
use super::term::{self, say};
use super::ui::{Card, Ui, render_diff};
use super::wrap::{pad, truncate};
use crate::agent::Agent;
use crate::approval::{Action, Answer, Approver};
use crate::config::{ApprovalMode, Config};
use crate::gateway::ModelInfo;
use crate::images::{self, Attachment};
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
    ("/model", "pick a model, or switch: /model deepseek"),
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
    ("/usage", "tokens, time and cost: this conversation and today"),
    ("/insights", "what the agent did lately: /insights [--days N]"),
    ("/retry", "run the last request again, without its answer"),
    ("/stop", "stop the turn (like esc)"),
    ("/new", "start the conversation over (also /reset)"),
    ("/fork", "continue in a copy of this conversation: /fork [name]"),
    ("/sessions", "the saved conversations"),
    ("/resume", "pick a conversation to continue, or /resume <name>"),
    ("/copy", "copy the last answer (its Markdown) to the clipboard"),
    ("/image", "show the agent an image: /image <path> (or drag one in, ctrl+v, @shot.png)"),
    ("/memory", "what the agent remembered"),
    ("/profile", "what the agent keeps about how you work (USER.md)"),
    ("/personality", "pick how it answers, or /personality <name> (none: SOUL.md only)"),
    ("/skills", "pick a skill to run; /skills accept|reject <name>; or /<skill> directly"),
    ("/team", "the team members it can delegate to"),
    ("/board", "the team's plans and tasks"),
    ("/clear", "clear the screen"),
    ("/exit", "quit (ctrl+d)"),
];

/// The keys, for `/help`.
const KEYS: &[(&str, &str)] = &[
    ("enter", "send (while it works: steer it, read before its next step)"),
    ("shift+enter, alt+enter", "a new line (also ctrl+j, or end a line with \\)"),
    ("↑ ↓", "history, or lines in a longer message"),
    ("ctrl+r", "search what you sent (again: older; enter keeps it, esc puts back)"),
    ("tab", "complete a /command or @path from the list"),
    ("esc", "stop the turn; close the list"),
    ("e (at a question)", "no, and type what to do instead"),
    ("ctrl+c", "clear the composer; stop the turn; twice to quit"),
    ("ctrl+d", "quit (on an empty composer)"),
    ("ctrl+a ctrl+e", "start and end of the line"),
    ("ctrl+w ctrl+u ctrl+k", "delete a word back, to the start, to the end (ctrl+y puts it back)"),
    ("alt+b alt+f", "a word back and forward"),
    ("ctrl+v", "attach the image on the clipboard"),
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
    "drag an image in (or ctrl+v, or /image <path>) to show it to the agent",
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
        Action::Home { service, entities, data } => (
            "Change this in the house?",
            format!("{} {entities} {}", style::code(service), style::gray(&data.chars().take(300).collect::<String>())),
        ),
        Action::Type { page, field, text, submit } => {
            let page = style::underline(page);
            match (text.is_empty(), submit) {
                (true, _) => ("Submit this form?", format!("{field} {} {page}", style::gray("on"))),
                (false, submit) => (
                    if *submit { "Type this and send it?" } else { "Type this into the page?" },
                    format!("{} {} {field} {} {page}", style::code(text), style::gray("into"), style::gray("on")),
                ),
            }
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
            // What to do instead goes back to the model with a refused tool call; a cloud model
            // refused ends the turn, so there it is a plain no.
            let instead = !matches!(action, Action::Cloud(_));
            let Some(lines) = &self.lines else {
                // On the terminal: a card above the composer, answered by the next key.
                term::notify(&format!("autobot: {title}"));
                let (tx, rx) = tokio::sync::oneshot::channel();
                self.ui.ask(Card { title, what, instead }, tx);
                return rx.await.unwrap_or(Answer::Deny);
            };
            self.ui.flush();
            for line in super::ui::card_lines(&Card { title, what, instead }, style::columns(), false) {
                say(&line);
            }
            // A line: y, a, n, or `e what to do instead`; anything else (or the end of the input)
            // is no.
            let answer = answer_line(lines.lock().await.recv().await.as_deref().unwrap_or_default(), instead);
            say(&style::gray(&match &answer {
                Answer::Once => "→ yes".to_owned(),
                Answer::Always => "→ always, this session".to_owned(),
                Answer::Deny => "→ no".to_owned(),
                Answer::Instead(text) => format!("→ no, instead: {text}"),
            }));
            answer
        })
    }
}

/// An answer typed as a line (without a terminal): `y`, `a`, `n`, or `e` and what to do instead
/// (when [instead] is offered); anything else is no.
fn answer_line(line: &str, instead: bool) -> Answer {
    let line = line.trim();
    match line.chars().next() {
        Some('y' | 'Y') => Answer::Once,
        Some('a' | 'A') => Answer::Always,
        // `e`, a space, the words (`everything` is not an `e`).
        Some('e' | 'E') if instead && line[1..].starts_with(char::is_whitespace) => {
            Answer::Instead(line[1..].trim().to_owned())
        }
        _ => Answer::Deny,
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
    /// Images for the next message, attached without a composer (`/image` in line mode).
    pending: Vec<Attachment>,
    /// What a nudge kept, from the background ([Agent::nudge]): printed as quiet lines.
    kept: (tokio::sync::mpsc::UnboundedSender<String>, tokio::sync::mpsc::UnboundedReceiver<String>),
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
    /// `e` at a question: what to do instead is typed in the composer; what it held before.
    instead: Option<String>,
    /// A picker open (`/model`, `/resume`): the composer narrows it.
    picker: Option<Picker>,
    /// Where relative paths pasted in are (where autobot started), and where clipboard images
    /// are kept.
    workdir: PathBuf,
    attachments: PathBuf,
}

impl App {
    fn new(home: &Path, workdir: &Path, code: bool) -> Self {
        let history = home.join("history");
        let mut commands: Vec<(String, String)> = COMMANDS
            .iter()
            .map(|(c, d)| ((*c).to_owned(), (*d).to_owned()))
            .chain(crate::commands::list(workdir, home).into_iter().map(|c| (format!("/{}", c.name), c.description)))
            .collect();
        // Skills run as commands of their own (`/deploy`), when no command has the name.
        for skill in crate::skills::list(home) {
            let name = format!("/{}", skill.name);
            if !commands.iter().any(|(c, _)| *c == name) && !crate::commands::builtin(&skill.name) {
                commands.push((name, format!("skill: {}", skill.description)));
            }
        }
        let files = Arc::new(OnceLock::new());
        {
            let (files, workdir) = (files.clone(), workdir.to_owned());
            std::thread::spawn(move || {
                let _ = files.set(palette::files(&workdir, 20_000));
            });
        }
        let project = workdir.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
        let title = if project.is_empty() { "autobot".to_owned() } else { format!("autobot · {project}") };
        let terminal = term::Terminal::take(&title);
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
            instead: None,
            picker: None,
            workdir: std::env::current_dir().unwrap_or_else(|_| workdir.to_owned()),
            attachments: home.join("attachments"),
        }
    }

    /// Attaches the image at [path] to the message being written, as a token; what went wrong
    /// shows on the status line.
    fn attach_image(&mut self, path: &Path) {
        match images::attach(path) {
            Ok(image) => {
                self.editor.attach(image);
            }
            Err(e) => self.notice(&e),
        }
    }

    /// Opens [picker], the composer empty to narrow it.
    fn open_picker(&mut self, picker: Picker) {
        self.editor.clear();
        self.dismissed = None;
        self.palette = Some(picker.palette(""));
        self.picker = Some(picker);
    }

    fn close_picker(&mut self) {
        if self.picker.take().is_some() {
            self.palette = None;
            self.editor.clear();
        }
    }

    /// Back from typing what to do instead: the composer as it was.
    fn leave_instead(&mut self) {
        if let Some(draft) = self.instead.take() {
            self.editor.set(&draft);
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
        if let Some(picker) = &self.picker {
            let next = picker.palette(self.editor.text());
            // Narrowed further, the same first item stays chosen.
            let selected = match &self.palette {
                Some(old) if old.items == next.items => old.selected,
                _ => next.selected,
            };
            self.palette = Some(Palette { selected, ..next });
            return;
        }
        if self.instead.is_some() || self.editor.searching().is_some() {
            self.palette = None;
            return;
        }
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
            Kind::Pick => return false,
            Kind::Path => {
                // A directory stays open for the next part of the path.
                let space = if item.text.ends_with('/') { "" } else { " " };
                self.editor.replace(palette.range.clone(), &format!("{}{space}", item.text));
            }
        }
        self.suggest();
        false
    }

    /// What [key] does, while a turn runs ([running]) or a question waits ([card]).
    fn press(&mut self, key: Key, running: bool, card: Option<&Card>) -> Did {
        let asking = card.is_some();
        if !asking {
            // The question went (the turn was stopped) while its answer was being typed.
            self.leave_instead();
        }
        let typing = self.instead.is_some();
        let key = match key {
            Key::Key(key) if key.kind != KeyEventKind::Release => key,
            Key::Paste(text) if !asking || typing => {
                // A dragged-in image arrives as its path: it is attached, not typed.
                match images::pasted_paths(&text, &self.workdir).filter(|_| !typing) {
                    Some(paths) => paths.iter().for_each(|path| self.attach_image(path)),
                    None => self.editor.paste(&text),
                }
                self.suggest();
                return Did::Nothing;
            }
            Key::Resize(width, _) => {
                term::resized(usize::from(width));
                return Did::Nothing;
            }
            Key::FocusGained => {
                term::focused(true);
                return Did::Nothing;
            }
            Key::FocusLost => {
                term::focused(false);
                return Did::Nothing;
            }
            _ => return Did::Nothing,
        };
        let KeyEvent { code, modifiers, .. } = key;
        let ctrl = modifiers.contains(KeyModifiers::CONTROL);
        let alt = modifiers.contains(KeyModifiers::ALT);
        if asking && typing {
            // What to do instead, typed in the composer: enter answers with it, esc goes back
            // to the keys.
            match code {
                KeyCode::Esc => {
                    self.leave_instead();
                    return Did::Nothing;
                }
                KeyCode::Char('c') if ctrl => {
                    if self.editor.is_empty() {
                        self.leave_instead();
                    } else {
                        self.editor.clear();
                    }
                    return Did::Nothing;
                }
                KeyCode::Enter if !alt && !modifiers.contains(KeyModifiers::SHIFT) => {
                    if self.editor.text().trim().is_empty() {
                        return Did::Nothing;
                    }
                    let (_, sent) = self.editor.take_as(false);
                    let draft = self.instead.take().unwrap_or_default();
                    self.editor.set(&draft);
                    return Did::Answer(Answer::Instead(sent.trim().to_owned()));
                }
                _ => {}
            }
        } else if let Some(card) = card {
            return match code {
                KeyCode::Char('c') if ctrl => Did::Interrupt,
                KeyCode::Char('y' | 'Y') if !ctrl => Did::Answer(Answer::Once),
                KeyCode::Char('a' | 'A') if !ctrl => Did::Answer(Answer::Always),
                KeyCode::Char('e' | 'E') if !ctrl && card.instead => {
                    self.instead = Some(self.editor.text().to_owned());
                    self.editor.clear();
                    self.palette = None;
                    Did::Nothing
                }
                // Any other key is someone typing, not answering: no (a sentence typed at the
                // prompt must not approve anything with an `a` in it).
                KeyCode::Char(_) | KeyCode::Esc | KeyCode::Enter => Did::Answer(Answer::Deny),
                _ => Did::Nothing,
            };
        }
        if !(ctrl && code == KeyCode::Char('c')) {
            self.exit_armed = None;
        }
        // ctrl+r: searching what was sent. Typing narrows it; a key that moves or edits keeps
        // what was found and does its own thing.
        if self.editor.searching().is_some() {
            let e = &mut self.editor;
            match code {
                KeyCode::Char('r') if ctrl => e.search_back(),
                KeyCode::Char('c' | 'g') if ctrl => e.search_cancel(),
                KeyCode::Esc => e.search_cancel(),
                KeyCode::Enter if !alt && !modifiers.contains(KeyModifiers::SHIFT) => e.search_accept(),
                KeyCode::Backspace if !ctrl && !alt => e.search_backspace(),
                KeyCode::Char(c) if !ctrl && !alt => e.search_type(c),
                _ => {
                    e.search_accept();
                    return self.press(Key::Key(key), running, card);
                }
            }
            self.suggest();
            return Did::Nothing;
        }
        if self.picker.is_some() {
            match code {
                KeyCode::Esc => {
                    self.close_picker();
                    return Did::Nothing;
                }
                KeyCode::Char('c') if ctrl => {
                    self.close_picker();
                    return Did::Nothing;
                }
                KeyCode::Enter | KeyCode::Tab if !alt && !modifiers.contains(KeyModifiers::SHIFT) => {
                    // Nothing matches: the picker stays, to type something else.
                    let Some(item) = self.palette.as_ref().and_then(|p| p.chosen().cloned()) else {
                        return Did::Nothing;
                    };
                    let command = self.picker.as_ref().map(|p| p.command.clone()).unwrap_or_default();
                    self.close_picker();
                    let line = format!("{command} {}", item.text);
                    return Did::Submit(line.clone(), line);
                }
                _ => {}
            }
        }
        let e = &mut self.editor;
        match code {
            KeyCode::Char('r') if ctrl => {
                if self.picker.is_none() {
                    self.palette = None;
                    e.search_back();
                }
                return Did::Nothing;
            }
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
            KeyCode::Char('v') if ctrl => match images::from_clipboard(&self.attachments) {
                Ok(path) => self.attach_image(&path),
                Err(e) => self.notice(&e),
            },
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
        let typing = asking && self.instead.is_some();
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
                    _ if typing => "what should it do instead? enter sends it with the no",
                    _ if asking => "y, a or n answers the question above (e: no, and say what instead)",
                    _ if self.picker.is_some() => "type to narrow the list; enter picks",
                    (true, _) => "type to steer it; enter sends before its next step",
                    (false, true) => "ask for a change, / for commands, @ to attach a file",
                    (false, false) => "ask anything, / for commands, @ to attach a file",
                };
                style::faint(&truncate(hint, inner))
            } else {
                let mut row = row.clone();
                for label in self.editor.labels() {
                    row = row.replace(label, &style::gray(label));
                }
                row
            };
            composer.push(format!("{} {lead}{} {}", style::faint("│"), pad(&text, inner), style::faint("│")));
        }
        composer.push(style::faint(&format!("╰{}╯", "─".repeat(width - 2))));
        // Under it: the palette, the search, or the status line.
        let under: Vec<String> = match (&self.palette, &self.picker, self.editor.searching()) {
            (Some(p), Some(picker), _) if !asking => picker_lines(p, picker, width),
            (Some(p), None, None) if !asking => palette_lines(p, width),
            (_, _, Some(search)) => vec![search_line(&search.query, search.failed, width)],
            _ => vec![self.status_line(width, running, asking, typing)],
        };
        let fixed = 1 + composer.len() + under.len() + 1;
        let room = height.saturating_sub(fixed + 2).max(1);
        let mut head = if term::after_blank() || ui.streaming() { Vec::new() } else { vec![String::new()] };
        let live = ui.live(width, room, typing);
        if !live.is_empty() {
            head.extend(live);
            head.push(String::new());
        }
        // Never taller than the screen: what the agent is doing gives way first.
        let over = (head.len() + composer.len() + under.len() + 1).saturating_sub(height);
        head.drain(..over.min(head.len()));
        let box_top = head.len();
        let cursor = (!asking || typing).then_some((box_top + 1 + crow - first, 4 + if empty { 0 } else { ccol }));
        let lines = head.into_iter().chain(composer).chain(under).map(|l| truncate(&l, width)).collect();
        term::draw(lines, cursor);
    }

    fn status_line(&self, width: usize, running: bool, asking: bool, typing: bool) -> String {
        let hint = match &self.notice {
            Some((notice, _)) => style::yellow(notice),
            None if typing => style::faint("enter sends · esc back to the keys"),
            // Where shift+enter is a key of its own, it is the one to name.
            None if term::kitty() && !asking && !running && !self.editor.is_empty() => {
                style::faint("enter send · shift+enter new line")
            }
            None => style::faint(hint(asking, running, self.editor.is_empty())),
        };
        status_line(&self.status, &hint, width)
    }
}

/// What the keys do now, for the right of the status line.
fn hint(asking: bool, running: bool, empty: bool) -> &'static str {
    match (asking, running, empty) {
        (true, ..) => "y yes · a always · n no · e instead",
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

/// The status line while searching what was sent: `search: query` on the left (and that nothing
/// older matches), the keys on the right.
fn search_line(query: &str, failed: bool, width: usize) -> String {
    let mut left = format!("  {} {}", style::faint("search:"), style::bold(query));
    if failed {
        left.push_str(&format!("  {}", style::yellow("no older match")));
    }
    let hint = style::faint("ctrl+r older · enter keeps · esc puts back");
    let gap = width.saturating_sub(style::width(&left) + style::width(&hint));
    if gap < 2 {
        return truncate(&left, width);
    }
    format!("{left}{}{hint}", " ".repeat(gap))
}

/// A picker's rows: the palette's, then what it is and its keys.
fn picker_lines(p: &Palette, picker: &Picker, width: usize) -> Vec<String> {
    let mut out: Vec<String> = palette_lines(p, width).into_iter().filter(|l| !l.contains("tab completes")).collect();
    if p.items.is_empty() {
        out.push(style::faint(&format!("    no {} match", picker.noun)));
    }
    let count = if p.items.len() == picker.all.len() {
        format!("{} {}", picker.all.len(), picker.noun)
    } else {
        format!("{} of {} {}", p.items.len(), picker.all.len(), picker.noun)
    };
    out.push(truncate(&style::faint(&format!("    {count} · type to narrow · enter picks · esc closes")), width));
    out
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
        pending: Vec::new(),
        kept: tokio::sync::mpsc::unbounded_channel(),
    };
    chat.agent.options.vision = crate::vision(&chat.models, chat.agent.gateway.model());
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
    term::set_notify(match config.terminal.notify {
        crate::config::NotifyMode::Off => osc::Notify::Off,
        crate::config::NotifyMode::Bell => osc::Notify::Bell,
        crate::config::NotifyMode::Auto => osc::notify_kind(|k| std::env::var(k).ok()),
    });
    chat.banner(options.code);
    app.status = chat.status();
    let mut tick = tokio::time::interval(Duration::from_millis(70));
    loop {
        let (shown, sent) = if app.tty() {
            app.draw(&ui);
            tokio::select! {
                key = app.key() => {
                    let Some(key) = key else { return Ok(()) };
                    match app.press(key, false, None) {
                        Did::Submit(shown, sent) => (shown, sent),
                        Did::Exit => break,
                        _ => continue,
                    }
                }
                Some(line) = chat.kept.1.recv() => {
                    say(&style::faint(&format!("  ↳ kept {line}")));
                    continue;
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
            Some(Next::Pick(picker)) => app.open_picker(picker),
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
    /// Open this picker (a command with nothing after it).
    Pick(Picker),
    /// Run this request again as it was sent (`/retry`).
    Retry(String, Vec<Attachment>),
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
            invincible::brand::Product::Autobot.header(invincible::version::VERSION)
        } else {
            format!("{} {}", style::bold("autobot"), style::gray(invincible::version::VERSION))
        };
        let header = format!("{name} {}", style::faint("· via invincible"));
        let private = if self.agent.gateway.private() { style::faint("  private") } else { String::new() };
        let mut rows = vec![
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
        if let Some(character) = self.character() {
            rows.push(("personality", character));
        }
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

    /// The personality in use and whether SOUL.md shapes it: `concise · SOUL.md`; None for
    /// neither.
    fn character(&self) -> Option<String> {
        let name = match self.agent.options.personality.as_deref() {
            Some(p) if crate::personality::is_none(p) => None,
            Some(p) => Some(p.to_owned()),
            None => crate::personality::active(&self.home),
        };
        let soul = crate::personality::soul(&self.home).map(|_| style::faint("SOUL.md"));
        match (name, soul) {
            (None, None) => None,
            (Some(n), None) => Some(n),
            (None, Some(s)) => Some(s),
            (Some(n), Some(s)) => Some(format!("{n} {} {s}", style::faint("·"))),
        }
    }

    /// The nudge, when it is time ([Agent::nudge]): on a terminal in the background, its lines
    /// on [Chat::kept]; without one (nothing to keep drawing), before the next line is read.
    async fn nudge(&self, tty: bool) {
        let every = self.agent.options.nudge_every;
        if every == 0 {
            return;
        }
        if !tty {
            for line in self.agent.nudge(&self.session.messages, &|_| {}).await {
                say(&style::faint(&format!("  ↳ kept {line}")));
            }
            return;
        }
        let (agent, messages, tx) = (self.agent.clone(), self.session.messages.clone(), self.kept.0.clone());
        tokio::spawn(async move {
            for line in agent.nudge(&messages, &|_| {}).await {
                let _ = tx.send(line);
            }
        });
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
        let window: usize = self.session.window().iter().map(crate::session::cost).sum();
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
        if let Some(arg) = text.strip_prefix("/image").filter(|a| a.is_empty() || a.starts_with(' ')) {
            if let Err(e) = self.attach_command(app, arg.trim()) {
                say(&style::red(&e));
            }
            return None;
        }
        if text.starts_with('/') {
            match self.command(text).await {
                Ok(Some(Next::Send(text))) => self.turn(app, &text, Vec::new()).await,
                Ok(Some(Next::Retry(text, images))) => self.run_turn(app, text, images, String::new()).await,
                Ok(next) => return next,
                Err(e) => say(&style::red(&e)),
            }
            return None;
        }
        // The images that go with it: the composer's tokens, `@` mentions of image files, and
        // what `/image` attached.
        let (text, mut images) = app.editor.images_in(text);
        for image in
            mention_images(&text, self.agent.tools.workdir()).into_iter().chain(std::mem::take(&mut self.pending))
        {
            if !images.contains(&image) {
                images.push(image);
            }
        }
        if !images.is_empty()
            && let Some(why) = self.blind()
        {
            // Not sent: the message comes back to send again once a model that can see is picked.
            say(&format!("{} {why}", style::red("✗")));
            if app.tty() {
                return Some(Next::Prefill(shown.trim_end().to_owned()));
            }
            self.pending = images;
            return None;
        }
        self.turn(app, &text, images).await;
        None
    }

    /// Why images cannot be sent now: the model is known not to see them.
    fn blind(&self) -> Option<String> {
        (self.agent.options.vision == Some(false)).then(|| match self.agent.gateway.model() {
            "auto" => {
                "none of the gateway's models can see images; add one that can (see `invincible cloud add`)".to_owned()
            }
            model => format!("{model} can't see images; /model to pick one that can"),
        })
    }

    /// `/image <path>`: the image goes with the next message: as a token in the composer, or
    /// (without a terminal) kept for the next line.
    fn attach_command(&mut self, app: &mut App, arg: &str) -> Result<(), String> {
        if arg.is_empty() {
            return Err("/image <path>: a PNG, JPEG, WebP or GIF (or drag one in, or ctrl+v)".to_owned());
        }
        // Relative to where autobot was started, else to the project (`autobot chat` works in a
        // directory of its own).
        let project = self.agent.tools.workdir().to_owned();
        let here = std::env::current_dir().unwrap_or_else(|_| project.clone());
        let workdir =
            if images::pasted_paths(arg, &here).is_some() || here.join(arg).exists() { here } else { project };
        // Quoted or escaped like a dragged path; else as typed (so its error is the file's).
        let paths = images::pasted_paths(arg, &workdir).unwrap_or_else(|| vec![workdir.join(arg)]);
        for path in paths {
            // Errors name the file as it was typed.
            let image = images::attach(&path).map_err(|e| e.replace(&format!("{}/", workdir.display()), ""))?;
            if app.tty() {
                say(&style::gray(&format!("  └ {} · in the composer; write your message and send", image.describe())));
                app.editor.attach(image);
            } else {
                say(&style::gray(&format!("  └ attached {}; it goes with your next message", image.describe())));
                self.pending.push(image);
            }
        }
        if let Some(why) = self.blind() {
            say(&style::yellow(&format!("  └ {why}")));
        }
        Ok(())
    }

    async fn turn(&mut self, app: &mut App, text: &str, images: Vec<Attachment>) {
        let mut request = expand_mentions(text, self.agent.tools.workdir(), &self.ui);
        let shell = std::mem::take(&mut self.shell);
        if !shell.is_empty() {
            request = format!("{shell}\n\n{request}");
        }
        self.run_turn(app, request, images, shell).await;
    }

    /// Runs [request] as it is (mentions expanded, the shell's output in it); [shell]: that
    /// output, handed to the next request if the turn is stopped.
    async fn run_turn(&mut self, app: &mut App, request: String, images: Vec<Attachment>, shell: String) {
        let ui = self.ui.clone();
        ui.begin();
        let started = Instant::now();
        let inbox: crate::tools::Inbox = Arc::default();
        let approver = KeyApprover { ui: ui.clone(), lines: app.lines.clone() };
        let events = |event: crate::agent::Event| ui.event(event);
        let mut tick = tokio::time::interval(Duration::from_millis(70));
        let tty = app.tty();
        let outcome = {
            let context = crate::tools::TurnContext { inbox: Some(inbox.clone()), ..Default::default() };
            let turn = crate::tools::TURN.scope(
                context,
                self.agent.turn_with(&mut self.session, &request, &images, &approver, &mut self.grants, &events),
            );
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
                    Some(key) = app.key() => match app.press(key, true, ui.card().as_ref()) {
                        Did::Interrupt => break None,
                        Did::Answer(answer) => {
                            ui.respond(answer);
                        }
                        // `/stop` is esc, typed.
                        Did::Submit(_, sent) if sent.trim() == "/stop" => break None,
                        Did::Submit(shown, sent) => {
                            // An image cannot be read in mid-turn: it goes as the next message.
                            let image = !app.editor.images_in(&sent).1.is_empty();
                            if sent.trim_start().starts_with(['/', '!']) || image {
                                let when = if image { "(with its image, when this turn ends)" } else { "(runs when this turn ends)" };
                                ui.note(&format!("{} {}  {}", style::faint("↳"), shown.trim(), style::faint(when)));
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
        app.leave_instead();
        // A long turn: the owner may be elsewhere.
        if started.elapsed() >= Duration::from_secs(10) {
            let how = match &outcome {
                Some(Ok(_)) => "finished",
                Some(Err(_)) => "failed",
                None => "stopped",
            };
            let project = self.agent.tools.workdir().file_name().map(|n| n.to_string_lossy().into_owned());
            let project = project.map(|p| format!(" · {p}")).unwrap_or_default();
            term::notify(&format!("autobot{project}: the turn {how} ({}s)", started.elapsed().as_secs()));
        }
        match outcome {
            Some(Ok(outcome)) => {
                ui.answer(&outcome.text);
                ui.end(None);
                self.nudge(tty).await;
                // Typed while it finished: the agent never saw it, so it is the next request.
                let unread: Vec<String> = std::mem::take(&mut *inbox.lock().expect("inbox"));
                if !unread.is_empty() {
                    let next = unread.join("\n");
                    say(&format!("\n{} {}", style::bold(&style::accent("›")), next));
                    Box::pin(self.turn(app, &next, Vec::new())).await;
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
            match Box::pin(self.handle(app, &shown, &sent)).await {
                Some(Next::Prefill(text)) => app.editor.set(&text),
                Some(Next::Pick(picker)) => app.open_picker(picker),
                _ => {}
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
                    let w = KEYS.iter().map(|(k, _)| k.chars().count()).max().unwrap_or(0);
                    for (keys, what) in KEYS {
                        say(&format!("  {} {}", style::bold(&format!("{keys:<w$}")), style::gray(what)));
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
            "/stop" => say(&style::gray("nothing is running (esc stops a turn while it works)")),
            "/retry" => {
                let request = self.session.take_back()?;
                let text = request["content"].as_str().unwrap_or_default().to_owned();
                let images = images::of(&request);
                let first = text.lines().next().unwrap_or_default();
                say(&style::gray(&format!(
                    "  └ again: {} {}",
                    truncate(first, style::columns().saturating_sub(30).max(20)),
                    style::faint("(files it changed stay; /undo puts them back)")
                )));
                return Ok(Some(Next::Retry(text, images)));
            }
            "/usage" => {
                let mut rows = crate::insights::usage(&self.home, Some(&self.session.id), &self.config.prices);
                let (input, output) = self.ui.total_tokens();
                if input > 0 {
                    rows.insert(
                        0,
                        (
                            "this chat".to_owned(),
                            format!("{} in · {} out", super::ui::short(input), super::ui::short(output)),
                        ),
                    );
                }
                let rows: Vec<(&str, String)> = rows.iter().map(|(k, v)| (k.as_str(), v.clone())).collect();
                term::print(&invincible::brand::rows(&rows));
            }
            "/insights" => {
                let days = crate::insights::days_arg(arg).map_err(|e| format!("/insights {e}"))?;
                let report = crate::insights::insights(&self.home, days, &self.config.prices);
                let rows = crate::insights::insights_rows(&report);
                let rows: Vec<(&str, String)> = rows.iter().map(|(k, v)| (k.as_str(), v.clone())).collect();
                term::print(&invincible::brand::rows(&rows));
            }
            "/profile" => {
                let entries = crate::profile::entries(&self.home);
                if entries.is_empty() {
                    say(&style::gray("nothing yet: the agent keeps how you work here as it learns it (USER.md)"));
                }
                for entry in entries {
                    say(&format!("  {} {entry}", style::faint("•")));
                }
                say(&style::faint(&format!("  {} · edit it freely", crate::profile::path(&self.home).display())));
            }
            "/personality" => {
                if arg.is_empty() {
                    if term::active() {
                        let current = self.agent.options.personality.clone();
                        return Ok(Some(Next::Pick(personality_picker(&self.home, current.as_deref()))));
                    }
                    for p in crate::personality::list(&self.home) {
                        say(&format!("  {} {}", style::bold(&p.name), style::gray(&p.description)));
                    }
                    return Ok(None);
                }
                if !crate::personality::is_none(arg) {
                    crate::personality::text(&self.home, arg)?;
                }
                self.agent.options.personality = Some(arg.to_owned());
                let what = if crate::personality::is_none(arg) { "no personality".to_owned() } else { arg.to_owned() };
                say(&format!(
                    "{} {what} {}",
                    style::gray("personality"),
                    style::faint("for this conversation (`autobot personality set` keeps one)")
                ));
            }
            "/new" | "/reset" => {
                self.session.reset()?;
                self.grants.clear();
                say(&style::gray("a new conversation"));
            }
            "/model" | "/models" if arg.is_empty() => {
                if let Ok(models) = self.agent.gateway.model_info().await {
                    self.models = models;
                }
                let current = self.agent.gateway.model();
                if term::active() {
                    return Ok(Some(Next::Pick(model_picker(&self.models, current))));
                }
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
                let window: usize = self.session.window().iter().map(crate::session::cost).sum();
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
                // A request with images is not handed back: its text alone would not be it.
                let had_images = self
                    .session
                    .messages
                    .iter()
                    .rev()
                    .find(|m| crate::session::is_request(m))
                    .is_some_and(|m| !images::of(m).is_empty());
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
                if had_images || request.contains("(I ran `") || request.contains("[Attached @") {
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
                    if !term::active() {
                        return Err("/resume <name> (see /sessions)".to_owned());
                    }
                    let dir = self.home.join("sessions");
                    let sessions = crate::session::list(&dir);
                    if sessions.is_empty() {
                        return Err("no saved conversations yet".to_owned());
                    }
                    return Ok(Some(Next::Pick(session_picker(&dir, &sessions, &self.session.id))));
                }
                self.session = Session::open(&self.home.join("sessions"), arg)?;
                self.grants.clear();
                say(&style::gray(&format!("now in {arg} ({} messages)", self.session.messages.len())));
                for line in recap(&self.session.messages, style::columns().saturating_sub(4)) {
                    say(&line);
                }
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
            "/skills" if arg.starts_with("accept ") || arg.starts_with("reject ") => {
                let (what, name) = arg.split_once(' ').unwrap_or_default();
                let name = name.trim();
                if what == "accept" {
                    crate::skills::accept(&self.home, name)?;
                    say(&style::gray(&format!("kept {name}: the agent uses it from now on (/{name} runs it)")));
                } else if crate::skills::reject(&self.home, name)? {
                    say(&style::gray(&format!("threw {name} away")));
                } else {
                    return Err(format!("there is no proposed skill {name:?}"));
                }
            }
            "/skills" if !arg.is_empty() => {
                let (name, rest) = arg.split_once(' ').map_or((arg, ""), |(n, r)| (n, r.trim()));
                return self.run_skill(name, rest).map(Some);
            }
            "/skills" if term::active() && !crate::skills::list(&self.home).is_empty() => {
                for skill in crate::skills::proposals(&self.home) {
                    self.show_proposal(&skill);
                }
                return Ok(Some(Next::Pick(skill_picker(&self.home))));
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
                    self.show_proposal(&skill);
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
            "/copy" => {
                let text = crate::session::last_answer(&self.session.messages)
                    .ok_or("no answer to copy yet")?
                    .trim()
                    .to_owned();
                let tmux = std::env::var_os("TMUX").is_some();
                if !term::emit(&osc::clipboard(&text, tmux)) {
                    return Err("/copy needs a terminal (the text goes through it to the clipboard)".to_owned());
                }
                let lines = text.lines().count();
                let mut note = format!(
                    "copied the last answer to the clipboard ({lines} line{}, Markdown)",
                    if lines == 1 { "" } else { "s" }
                );
                // Some terminals keep only so much of what is sent this way.
                if text.len() > 74_000 {
                    note.push_str("; it is long, and some terminals keep only part of it");
                }
                say(&style::gray(&note));
            }
            other => {
                let custom = crate::commands::list(self.agent.tools.workdir(), &self.home);
                let Some(command) = custom.iter().find(|c| other.strip_prefix('/') == Some(c.name.as_str())) else {
                    // A skill, run by its name.
                    if let Some(name) = other.strip_prefix('/').filter(|n| crate::skills::find(&self.home, n).is_some())
                    {
                        return self.run_skill(name, arg).map(Some);
                    }
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

impl Chat {
    /// `/<skill> [what for]`: the skill's instructions as the request, with what was typed.
    fn run_skill(&self, name: &str, task: &str) -> Result<Next, String> {
        let skill = crate::skills::find(&self.home, name).ok_or(format!("there is no skill {name:?} (/skills)"))?;
        let body = crate::skills::body(&self.home, name)?;
        let task = if task.is_empty() { "Do what the skill describes, here." } else { task };
        say(&style::gray(&format!("  └ skill {} ({} characters)", skill.name, body.len())));
        Ok(Next::Send(format!(
            "Use the skill {name} for this. Its instructions:\n\n{body}\n\n(read_skill with file reads its other files.)\n\nTask: {task}"
        )))
    }

    /// A proposal waiting for the owner, with what an improvement changes.
    fn show_proposal(&self, skill: &crate::skills::Skill) {
        let kind = if skill.improves { "improves" } else { "proposed" };
        say(&format!("  {} {} {}", style::yellow(kind), style::bold(&skill.name), style::gray(&skill.description)));
        if let Some(diff) = crate::skills::proposal_diff(&self.home, &skill.name) {
            term::print(&render_diff(&diff, 40));
        }
        say(&style::faint(&format!("    /skills accept {0} keeps it, /skills reject {0} throws it away", skill.name)));
    }
}

/// The owner's skills to pick from (enter runs one).
fn skill_picker(home: &Path) -> Picker {
    let all: Vec<Item> = crate::skills::list(home)
        .into_iter()
        .map(|s| {
            let files = match s.files().len() {
                0 => String::new(),
                1 => " · 1 file".to_owned(),
                n => format!(" · {n} files"),
            };
            Item { text: s.name, detail: format!("{}{files}", s.description) }
        })
        .collect();
    Picker { command: "/skills".into(), noun: "skills".into(), all, current: 0 }
}

/// The personalities to pick from: none, then the owner's and the built-in ones.
fn personality_picker(home: &Path, current: Option<&str>) -> Picker {
    let current = current.map(str::to_owned).or_else(|| crate::personality::active(home));
    let mut all = vec![Item { text: "none".into(), detail: "SOUL.md only (or the plain agent)".into() }];
    for p in crate::personality::list(home) {
        let mine = if p.path.is_some() { " · yours" } else { "" };
        all.push(Item { text: p.name, detail: format!("{}{mine}", p.description) });
    }
    let at = current.as_deref().filter(|c| !crate::personality::is_none(c));
    let current = at.and_then(|c| all.iter().position(|i| i.text == c)).unwrap_or(0);
    Picker { command: "/personality".into(), noun: "personalities".into(), all, current }
}

/// The models to pick from: the gateway's, then `auto`; the current one chosen.
fn model_picker(models: &[ModelInfo], current: &str) -> Picker {
    let mut all: Vec<Item> = models
        .iter()
        .map(|m| {
            let context = m.context.map(|c| format!(" · {}k context", c / 1000)).unwrap_or_default();
            let health = if m.healthy { "" } else { " · unhealthy" };
            let now = if m.id == current { " · now" } else { "" };
            Item { text: m.id.clone(), detail: format!("{}{context}{health}{now}", m.tier) }
        })
        .collect();
    let now = if current == "auto" { " · now" } else { "" };
    all.push(Item { text: "auto".into(), detail: format!("the gateway's router picks{now}") });
    let current = all.iter().position(|i| i.text == current).unwrap_or(0);
    Picker { command: "/model".into(), noun: "models".into(), all, current }
}

/// The conversations to pick from, newest first (at most 50): what each is about, and when.
fn session_picker(dir: &Path, sessions: &[(String, std::time::SystemTime)], current: &str) -> Picker {
    let all: Vec<Item> = sessions
        .iter()
        .take(50)
        .map(|(name, modified)| {
            let ago = ago_text(modified.elapsed().map(|d| d.as_secs()).unwrap_or(0));
            let about = crate::session::title(dir, name, 60).unwrap_or_else(|| "(empty)".to_owned());
            let now = if name == current { " · now" } else { "" };
            Item { text: name.clone(), detail: format!("{about} · {ago}{now}") }
        })
        .collect();
    let current = all.iter().position(|i| i.text == current).unwrap_or(0);
    Picker { command: "/resume".into(), noun: "conversations".into(), all, current }
}

fn ago_text(secs: u64) -> String {
    match secs {
        0..60 => "just now".to_owned(),
        60..3600 => format!("{} min ago", secs / 60),
        3600..86400 => format!("{} h ago", secs / 3600),
        _ => format!("{} days ago", secs / 86400),
    }
}

/// The end of a conversation picked up again: its last few requests and answers, a line each,
/// with the images a request had as `[image: shot.png]` (`gone` when its file is not there now:
/// it is not sent again then).
fn recap(messages: &[serde_json::Value], width: usize) -> Vec<String> {
    let said: Vec<&serde_json::Value> = messages
        .iter()
        .filter(|m| match m["role"].as_str() {
            Some("user") => crate::session::is_request(m),
            Some("assistant") => m["content"].as_str().is_some_and(|c| !c.trim().is_empty()),
            _ => false,
        })
        .collect();
    let mut lines = Vec::new();
    for m in &said[said.len().saturating_sub(4)..] {
        let text = m["content"].as_str().unwrap_or_default();
        let first = text.lines().map(str::trim).find(|l| !l.is_empty()).unwrap_or_default();
        if m["role"] == "user" {
            lines.push(truncate(&format!("{} {}", style::faint("›"), style::gray(first)), width));
            for image in images::of(m) {
                let gone = if image.path.is_file() { "" } else { " · gone" };
                lines.push(style::faint(&format!("  [image: {}]{gone}", image.name)));
            }
        } else {
            lines.push(truncate(&format!("  {}", style::faint(first)), width));
        }
    }
    lines
}

/// `@shot.png` in [text]: image files in the project, attached as images (shown to the model,
/// not pasted in as text).
fn mention_images(text: &str, workdir: &Path) -> Vec<Attachment> {
    let mut found: Vec<Attachment> = Vec::new();
    for word in text.split_whitespace() {
        let Some(name) = word.strip_prefix('@') else { continue };
        let name = name.trim_end_matches([',', ';', ':', ')', '?', '!']).trim_end_matches('.');
        if !images::is_image(Path::new(name)) {
            continue;
        }
        let Some(path) = inside(workdir, name) else { continue };
        match images::attach(&path) {
            Ok(image) => {
                say(&style::gray(&format!("  └ attached @{name} (image · {}×{})", image.width, image.height)));
                if !found.contains(&image) {
                    found.push(image);
                }
            }
            Err(e) => say(&style::yellow(&format!("  └ {e}; not attached"))),
        }
    }
    found
}

/// [name] in [workdir], when it is there (links followed, and still inside).
fn inside(workdir: &Path, name: &str) -> Option<PathBuf> {
    workdir.join(name).canonicalize().ok().filter(|p| workdir.canonicalize().is_ok_and(|w| p.starts_with(w)))
}

/// `@path` in [text]: the files' contents attached (text files in the project, up to 256 KiB
/// each; a directory's listing). Images are [mention_images]'.
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
        let Some(path) = inside(workdir, name) else {
            if std::fs::symlink_metadata(workdir.join(name)).is_ok() {
                let how = if images::is_image(Path::new(name)) {
                    "drag it in, or /image <path>"
                } else {
                    "the agent can ask to read it"
                };
                say(&style::yellow(&format!("  └ @{name} is outside the project; not attached ({how})")));
            }
            continue;
        };
        if images::is_image(&path) && path.is_file() {
            continue;
        }
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
    use super::{App, Did, Status, answer_line, expand_mentions, hint, model_picker, search_line, status_line};
    use crate::approval::Answer;
    use crate::tui::editor::Editor;
    use crate::tui::ui::Card;
    use crossterm::event::{Event, KeyCode, KeyEvent, KeyEventKind, KeyEventState, KeyModifiers};

    fn app(history: &[&str]) -> App {
        App {
            editor: Editor::with_history(history.iter().map(|h| h.to_string()).collect()),
            history: std::env::temp_dir().join(format!("autobot-chat-history-{}", std::process::id())),
            commands: vec![("/model".into(), "pick a model".into())],
            files: Default::default(),
            palette: None,
            dismissed: None,
            exit_armed: None,
            notice: None,
            status: Status::default(),
            terminal: None,
            keys: None,
            lines: None,
            code: false,
            queued: Vec::new(),
            instead: None,
            picker: None,
            workdir: std::env::temp_dir(),
            attachments: std::env::temp_dir(),
        }
    }

    /// A key as the terminal sends it; with the kitty keyboard protocol on, shift+enter and a
    /// lone esc come as themselves (crossterm decodes `CSI 13;2u` and `CSI 27u` to these).
    fn key(code: KeyCode, modifiers: KeyModifiers) -> Event {
        Event::Key(KeyEvent { code, modifiers, kind: KeyEventKind::Press, state: KeyEventState::NONE })
    }

    fn typed(app: &mut App, text: &str) {
        for c in text.chars() {
            app.press(key(KeyCode::Char(c), KeyModifiers::NONE), false, None);
        }
    }

    #[test]
    fn kitty_keys_shift_enter_is_a_new_line_and_esc_stops() {
        let mut a = app(&[]);
        typed(&mut a, "one");
        assert_eq!(a.press(key(KeyCode::Enter, KeyModifiers::SHIFT), false, None), Did::Nothing);
        typed(&mut a, "two");
        assert_eq!(a.editor.text(), "one\ntwo");
        assert_eq!(a.press(key(KeyCode::Enter, KeyModifiers::ALT), false, None), Did::Nothing);
        assert_eq!(a.editor.text(), "one\ntwo\n");
        assert_eq!(a.press(key(KeyCode::Esc, KeyModifiers::NONE), true, None), Did::Interrupt);
        // ctrl+c arrives as `CSI 99;5u`: the same key.
        assert_eq!(a.press(key(KeyCode::Char('c'), KeyModifiers::CONTROL), true, None), Did::Nothing);
        assert!(a.editor.is_empty(), "the composer cleared first");
        let release = Event::Key(KeyEvent {
            code: KeyCode::Char('x'),
            modifiers: KeyModifiers::NONE,
            kind: KeyEventKind::Release,
            state: KeyEventState::NONE,
        });
        a.press(release, false, None);
        assert!(a.editor.is_empty(), "releases are not keys");
        typed(&mut a, "go");
        assert_eq!(
            a.press(key(KeyCode::Enter, KeyModifiers::NONE), false, None),
            Did::Submit("go".into(), "go".into())
        );
        let _ = std::fs::remove_file(&a.history);
    }

    #[test]
    fn ctrl_r_searches_what_was_sent() {
        let mut a = app(&["cargo build", "git status", "cargo test"]);
        typed(&mut a, "dra");
        a.press(key(KeyCode::Char('r'), KeyModifiers::CONTROL), false, None);
        typed(&mut a, "cargo");
        assert_eq!(a.editor.text(), "cargo test");
        assert_eq!(a.editor.searching().unwrap().query, "cargo");
        a.press(key(KeyCode::Char('r'), KeyModifiers::CONTROL), false, None);
        assert_eq!(a.editor.text(), "cargo build");
        assert!(a.palette.is_none());
        // Enter keeps it; the next enter sends it.
        assert_eq!(a.press(key(KeyCode::Enter, KeyModifiers::NONE), false, None), Did::Nothing);
        assert!(a.editor.searching().is_none());
        assert_eq!(
            a.press(key(KeyCode::Enter, KeyModifiers::NONE), false, None),
            Did::Submit("cargo build".into(), "cargo build".into())
        );
        // Esc puts back what was there; a key that moves keeps the match and moves.
        typed(&mut a, "x");
        a.press(key(KeyCode::Char('r'), KeyModifiers::CONTROL), false, None);
        typed(&mut a, "git");
        a.press(key(KeyCode::Esc, KeyModifiers::NONE), false, None);
        assert_eq!(a.editor.text(), "x");
        a.press(key(KeyCode::Char('r'), KeyModifiers::CONTROL), false, None);
        typed(&mut a, "stat");
        a.press(key(KeyCode::End, KeyModifiers::NONE), false, None);
        assert!(a.editor.searching().is_none());
        assert_eq!((a.editor.text(), a.editor.cursor()), ("git status", 10));
        let line = search_line("stat", false, 80);
        assert!(line.starts_with("  search: stat ") && line.ends_with("ctrl+r older · enter keeps · esc puts back"));
        assert!(search_line("zz", true, 80).contains("no older match"));
        let _ = std::fs::remove_file(&a.history);
    }

    #[test]
    fn e_at_a_question_types_what_to_do_instead() {
        let card = Card { title: "Run this command?".into(), what: "rm -rf build".into(), instead: true };
        let mut a = app(&[]);
        a.editor.set("a draft");
        assert_eq!(a.press(key(KeyCode::Char('e'), KeyModifiers::NONE), true, Some(&card)), Did::Nothing);
        assert!(a.editor.is_empty(), "the composer opens empty");
        // Typed letters are the answer's words now, not y/a/n.
        for c in "use cargo clean".chars() {
            assert_eq!(a.press(key(KeyCode::Char(c), KeyModifiers::NONE), true, Some(&card)), Did::Nothing);
        }
        assert_eq!(
            a.press(key(KeyCode::Enter, KeyModifiers::NONE), true, Some(&card)),
            Did::Answer(Answer::Instead("use cargo clean".into()))
        );
        assert_eq!(a.editor.text(), "a draft", "the draft comes back");
        assert!(a.editor.history().is_empty(), "an answer is not history");
        // Esc goes back to the keys; without `e` offered, e is a no like any other letter.
        a.press(key(KeyCode::Char('e'), KeyModifiers::NONE), true, Some(&card));
        a.press(key(KeyCode::Esc, KeyModifiers::NONE), true, Some(&card));
        assert_eq!(a.press(key(KeyCode::Char('y'), KeyModifiers::NONE), true, Some(&card)), Did::Answer(Answer::Once));
        let cloud = Card { instead: false, ..card };
        assert_eq!(a.press(key(KeyCode::Char('e'), KeyModifiers::NONE), true, Some(&cloud)), Did::Answer(Answer::Deny));
        assert_eq!(answer_line("e try the staging box", true), Answer::Instead("try the staging box".into()));
        assert_eq!(answer_line("e", true), Answer::Deny);
        assert_eq!(answer_line("everything", true), Answer::Deny, "a word, not the key");
        assert_eq!(answer_line("e do x", false), Answer::Deny);
        assert_eq!(answer_line(" a", true), Answer::Always);
    }

    #[test]
    fn a_picker_chooses_with_enter() {
        let models = vec![
            crate::gateway::ModelInfo {
                id: "qwen3".into(),
                tier: "node".into(),
                context: Some(32_000),
                healthy: true,
                vision: Some(false),
            },
            crate::gateway::ModelInfo {
                id: "deepseek".into(),
                tier: "cloud".into(),
                context: None,
                healthy: false,
                vision: None,
            },
        ];
        let picker = model_picker(&models, "deepseek");
        assert_eq!(picker.all[1].detail, "cloud · unhealthy · now");
        assert_eq!(picker.all[2].text, "auto");
        assert_eq!(picker.current, 1);
        let mut a = app(&[]);
        a.open_picker(picker.clone());
        assert_eq!(a.palette.as_ref().unwrap().selected, 1);
        typed(&mut a, "qw");
        assert_eq!(a.palette.as_ref().unwrap().items.len(), 1);
        assert_eq!(
            a.press(key(KeyCode::Enter, KeyModifiers::NONE), false, None),
            Did::Submit("/model qwen3".into(), "/model qwen3".into())
        );
        assert!(a.picker.is_none() && a.palette.is_none() && a.editor.is_empty());
        a.open_picker(picker.clone());
        typed(&mut a, "zzz");
        assert_eq!(a.press(key(KeyCode::Enter, KeyModifiers::NONE), false, None), Did::Nothing);
        assert!(a.picker.is_some(), "nothing matches: it stays open");
        a.press(key(KeyCode::Esc, KeyModifiers::NONE), false, None);
        assert!(a.picker.is_none() && a.editor.is_empty());
        a.open_picker(picker);
        a.press(key(KeyCode::Down, KeyModifiers::NONE), false, None);
        assert_eq!(
            a.press(key(KeyCode::Enter, KeyModifiers::NONE), false, None),
            Did::Submit("/model auto".into(), "/model auto".into())
        );
    }

    #[test]
    fn skills_and_personalities_are_picked_and_skills_are_commands() {
        let home = std::env::temp_dir().join(format!("autobot-chat-pick-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&home);
        std::fs::create_dir_all(home.join("skills/deploy")).unwrap();
        std::fs::write(home.join("skills/deploy/SKILL.md"), "---\nname: deploy\ndescription: Ship it\n---\nGo.")
            .unwrap();
        std::fs::write(home.join("skills/deploy/run.sh"), "echo go").unwrap();
        std::fs::write(home.join("skills/retry.md"), "# A skill named like a command\n").unwrap();
        let picker = super::skill_picker(&home);
        assert_eq!(picker.command, "/skills");
        assert_eq!(picker.all[0].text, "deploy");
        assert_eq!(picker.all[0].detail, "Ship it · 1 file");
        let mut a = app(&[]);
        a.open_picker(picker);
        assert_eq!(
            a.press(key(KeyCode::Enter, KeyModifiers::NONE), false, None),
            Did::Submit("/skills deploy".into(), "/skills deploy".into())
        );
        // The palette offers a skill as /<name>, but never over a built-in command.
        let work = home.join("work");
        std::fs::create_dir_all(&work).unwrap();
        let commands = App::new(&home, &work, false).commands;
        assert!(commands.iter().any(|(c, d)| c == "/deploy" && d == "skill: Ship it"));
        assert_eq!(commands.iter().filter(|(c, _)| c == "/retry").count(), 1);
        assert!(crate::commands::builtin("retry") && crate::commands::builtin("personality"));
        crate::personality::set(&home, "teacher").unwrap();
        let picker = super::personality_picker(&home, None);
        assert_eq!(picker.all[0].text, "none");
        assert_eq!(picker.all[picker.current].text, "teacher", "the one in use is chosen");
        assert_eq!(super::personality_picker(&home, Some("none")).current, 0);
        let _ = std::fs::remove_file(&a.history);
        std::fs::remove_dir_all(home).unwrap();
    }

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
        assert_eq!(hint(true, true, false), "y yes · a always · n no · e instead");
        assert_eq!(hint(false, true, false), "enter steers · esc interrupts");
    }

    #[test]
    fn a_dragged_in_image_becomes_a_token_and_goes_as_an_image() {
        let dir = std::env::temp_dir().join(format!("autobot-chat-image-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let shot = dir.join("Screen Shot.png");
        std::fs::write(&shot, crate::images::tests::picture(1280, 720, image::ImageFormat::Png)).unwrap();
        let mut a = app(&[]);
        a.workdir = dir.clone();
        typed(&mut a, "what is");
        // Terminals paste a dragged file's path, quoted or escaped.
        a.press(Event::Paste(format!("'{}'", shot.display())), false, None);
        assert_eq!(a.editor.text(), "what is [image 1: Screen Shot.png 1280×720] ");
        typed(&mut a, "?");
        // Any other paste is text.
        a.press(Event::Paste("plain words".into()), false, None);
        a.press(Event::Paste(dir.join("missing.png").display().to_string()), false, None);
        let Did::Submit(shown, sent) = a.press(key(KeyCode::Enter, KeyModifiers::NONE), false, None) else {
            panic!("sent")
        };
        assert!(shown.starts_with("what is [image 1: Screen Shot.png 1280×720] ?plain words"));
        let (text, images) = a.editor.images_in(&sent);
        assert!(text.starts_with("what is [image 1: Screen Shot.png] ?plain words"), "{text}");
        assert_eq!(images.len(), 1);
        assert_eq!((images[0].width, images[0].height), (1280, 720));
        // `@shot.png` in the project is an image too, not text.
        std::fs::write(dir.join("b.jpg"), crate::images::tests::picture(10, 10, image::ImageFormat::Jpeg)).unwrap();
        let found = super::mention_images("compare @b.jpg, and @missing.png", &dir);
        assert_eq!(found.len(), 1);
        assert_eq!(found[0].mime, "image/jpeg");
        let ui = super::Ui::new(dir.clone());
        assert_eq!(expand_mentions("compare @b.jpg", &dir, &ui), "compare @b.jpg", "not pasted in as text");
        let _ = std::fs::remove_file(&a.history);
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn a_resumed_conversation_shows_its_images_and_which_are_gone() {
        let image = |path: &str| crate::images::Attachment {
            path: path.into(),
            name: "shot.png".into(),
            sha256: "ab".into(),
            bytes: 1,
            mime: "image/png".into(),
            width: 1,
            height: 1,
        };
        let messages = vec![
            serde_json::json!({ "role": "user", "content": "old" }),
            crate::images::message("what is [image 1: shot.png]?", &[image("/definitely/not/here.png")]),
            serde_json::json!({ "role": "assistant", "content": null, "tool_calls": [] }),
            serde_json::json!({ "role": "assistant", "content": "A cat.\nWith a hat." }),
        ];
        let lines = super::recap(&messages, 80);
        assert_eq!(lines, ["› old", "› what is [image 1: shot.png]?", "  [image: shot.png] · gone", "  A cat."]);
        let models = vec![crate::gateway::ModelInfo {
            id: "qwen3".into(),
            tier: "node".into(),
            context: None,
            healthy: true,
            vision: Some(false),
        }];
        assert_eq!(crate::vision(&models, "qwen3"), Some(false));
        assert_eq!(crate::vision(&models, "auto"), Some(false), "no model can");
        assert_eq!(crate::vision(&[], "auto"), None);
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
