//! The agent's tools. Each call is first described as an [Action] when it needs approval, then
//! run; results go back to the model as text, cut to a size a small local model can take.

use std::path::{Component, Path, PathBuf};
use std::time::Duration;

use serde_json::{Value, json};
use tokio::io::AsyncReadExt;

use crate::approval::Action;

/// Most text one result hands back to the model.
pub const RESULT_LIMIT: usize = 16 * 1024;

#[derive(Clone)]
pub struct Tools {
    workdir: PathBuf,
    timeout: Duration,
    /// `$AUTOBOT_HOME`: with it, the agent remembers (memory) and reads skills.
    home: Option<PathBuf>,
    /// Only these tools (by name), when set: a recipe's tool groups ([groups]).
    only: Option<Vec<String>>,
}

/// Tool groups, as Autobot recipes name them, and the tools each allows here. Groups the node has
/// no tools for (`web`, `vault`) allow nothing.
pub const GROUPS: &[(&str, &[&str])] = &[
    ("files-read", &["read_file", "list_dir", "read_skill"]),
    ("web", &["web_fetch"]),
    ("files-write", &["write_file", "edit_file"]),
    ("memory", &["remember", "search_sessions", "propose_skill"]),
    ("terminal", &["terminal"]),
];

/// The tool names [groups] allow.
pub fn tools_for(groups: &[String]) -> Vec<String> {
    GROUPS
        .iter()
        .filter(|(g, _)| groups.iter().any(|x| x == g))
        .flat_map(|(_, tools)| tools.iter().map(|t| (*t).to_owned()))
        .collect()
}

/// Who a turn is for, for tools that act later (`schedule_task`): its conversation, and the
/// Telegram chat it came from (answers to a scheduled task go back there).
#[derive(Clone, Debug, Default)]
pub struct TurnContext {
    pub session: String,
    pub telegram_chat: Option<i64>,
    /// The team member doing this turn; None for the main agent.
    pub agent: Option<String>,
}

tokio::task_local! {
    pub static TURN: TurnContext;
}

/// One tool call, parsed.
#[derive(Debug, PartialEq, Eq)]
pub enum Call {
    Terminal {
        command: String,
    },
    ReadFile {
        path: PathBuf,
    },
    WriteFile {
        path: PathBuf,
        content: String,
    },
    EditFile {
        path: PathBuf,
        old: String,
        new: String,
        all: bool,
    },
    ListDir {
        path: PathBuf,
    },
    Remember {
        text: String,
    },
    ReadSkill {
        name: String,
    },
    Schedule {
        when: String,
        task: String,
        name: Option<String>,
    },
    ProposeSkill {
        name: String,
        description: String,
        steps: String,
    },
    /// Run by the agent itself (it has the gateway).
    Fetch {
        url: String,
    },
    SearchSessions {
        query: String,
    },
    ListSchedules,
    CancelSchedule {
        id: String,
    },
}

impl Tools {
    pub fn new(workdir: PathBuf, timeout: Duration) -> Self {
        Self { workdir, timeout, home: None, only: None }
    }

    /// With memory and skills from [home] (`$AUTOBOT_HOME`).
    pub fn with_home(mut self, home: PathBuf) -> Self {
        self.home = Some(home);
        self
    }

    /// Offers and runs only [tools] (by name).
    pub fn only(mut self, tools: Vec<String>) -> Self {
        self.only = Some(tools);
        self
    }

    fn offered(&self, name: &str) -> bool {
        self.only.as_ref().is_none_or(|only| only.iter().any(|t| t == name))
    }

    pub fn workdir(&self) -> &Path {
        &self.workdir
    }

    pub fn home(&self) -> Option<&Path> {
        self.home.as_deref()
    }

    /// The tools this agent has, in the OpenAI `tools` shape.
    pub fn definitions(&self) -> Value {
        let mut tools = Self::base_definitions();
        if self.home.is_some()
            && let Some(list) = tools.as_array_mut()
        {
            list.push(json!({ "type": "function", "function": {
                "name": "remember",
                "description": "Keep a short fact for later conversations (the owner's preferences, where things are, decisions). Not for secrets.",
                "parameters": { "type": "object", "properties": { "text": { "type": "string" } }, "required": ["text"] },
            }}));
            list.push(json!({ "type": "function", "function": {
                "name": "schedule_task",
                "description": "Do something later or regularly, with this agent's own scheduler (never the system crontab, at or launchd). The task runs as a new turn with nobody to ask (allowlisted commands and writes in the working directory only), and its answer goes to the owner where they asked. For a reminder, make the task the message, e.g. \"Tell the owner: time to stretch\".",
                "parameters": { "type": "object", "properties": {
                    "when": { "type": "string", "description": "in 10m, in 2h, at 18:30 (once, local time); every 30m, every 1d; or a cron expression like 0 8 * * 1-5 (local time)" },
                    "task": { "type": "string", "description": "What to do then, as an instruction to yourself" },
                    "name": { "type": "string", "description": "A short name for the list" },
                }, "required": ["when", "task"] },
            }}));
            list.push(json!({ "type": "function", "function": {
                "name": "propose_skill",
                "description": "After a multi-step task that worked and will come up again, write down how to do it as a skill. The owner reviews it before you can use it.",
                "parameters": { "type": "object", "properties": {
                    "name": { "type": "string", "description": "short-name-with-dashes" },
                    "description": { "type": "string", "description": "One line: what it is for" },
                    "steps": { "type": "string", "description": "The steps, commands and paths, in Markdown" },
                }, "required": ["name", "description", "steps"] },
            }}));
            list.push(json!({ "type": "function", "function": {
                "name": "search_sessions",
                "description": "Search earlier conversations for what was said or decided (keywords).",
                "parameters": { "type": "object", "properties": { "query": { "type": "string" } }, "required": ["query"] },
            }}));
            list.push(json!({ "type": "function", "function": {
                "name": "list_schedules",
                "description": "List the scheduled tasks: id, when, next run, name.",
                "parameters": { "type": "object", "properties": {} },
            }}));
            list.push(json!({ "type": "function", "function": {
                "name": "cancel_schedule",
                "description": "Cancel a scheduled task by id (from list_schedules).",
                "parameters": { "type": "object", "properties": { "id": { "type": "string" } }, "required": ["id"] },
            }}));
            list.push(json!({ "type": "function", "function": {
                "name": "read_skill",
                "description": "Read one of the owner's skills (how-to notes listed in your instructions) by name.",
                "parameters": { "type": "object", "properties": { "name": { "type": "string" } }, "required": ["name"] },
            }}));
        }
        if let Some(list) = tools.as_array_mut() {
            list.retain(|t| self.offered(t["function"]["name"].as_str().unwrap_or_default()));
        }
        tools
    }

    /// The tools every agent has.
    fn base_definitions() -> Value {
        let function = |name: &str, description: &str, properties: Value, required: &[&str]| {
            json!({
                "type": "function",
                "function": {
                    "name": name,
                    "description": description,
                    "parameters": { "type": "object", "properties": properties, "required": required },
                },
            })
        };
        json!([
            function(
                "terminal",
                "Run a shell command (sh -c) in the working directory and return its output and exit code.",
                json!({ "command": { "type": "string", "description": "The command line." } }),
                &["command"],
            ),
            function(
                "read_file",
                "Read a text file. Relative paths are in the working directory.",
                json!({ "path": { "type": "string" } }),
                &["path"],
            ),
            function(
                "write_file",
                "Create or replace a text file with the given content. Relative paths are in the working directory.",
                json!({ "path": { "type": "string" }, "content": { "type": "string" } }),
                &["path", "content"],
            ),
            function(
                "edit_file",
                "Change part of a text file: replace old_text (copied exactly from the file, with enough lines around it to be unique) with new_text. Prefer this to rewriting a whole file.",
                json!({
                    "path": { "type": "string" },
                    "old_text": { "type": "string", "description": "Exactly as in the file, once." },
                    "new_text": { "type": "string" },
                    "replace_all": { "type": "boolean", "description": "Replace every occurrence instead (default false)." },
                }),
                &["path", "old_text", "new_text"],
            ),
            function(
                "web_fetch",
                "Read a web page (https), as text. Goes through the owner's network rules; asks first.",
                json!({ "url": { "type": "string" } }),
                &["url"],
            ),
            function(
                "list_dir",
                "List a directory's entries. Relative paths are in the working directory.",
                json!({ "path": { "type": "string", "description": "Default: the working directory." } }),
                &[],
            ),
        ])
    }

    /// [name] with its JSON [arguments], as a [Call].
    pub fn parse(&self, name: &str, arguments: &str) -> Result<Call, String> {
        let args: Value = if arguments.trim().is_empty() {
            json!({})
        } else {
            serde_json::from_str(arguments).map_err(|e| format!("the arguments are not JSON: {e}"))?
        };
        if !self.offered(name) {
            return Err(format!("the tool {name:?} is not allowed in this task"));
        }
        let text = |key: &str| -> Result<String, String> {
            args.get(key).and_then(Value::as_str).map(str::to_owned).ok_or(format!("`{key}` is missing"))
        };
        Ok(match name {
            "terminal" => Call::Terminal { command: text("command")? },
            "read_file" => Call::ReadFile { path: self.resolve(&text("path")?) },
            "write_file" => Call::WriteFile { path: self.resolve(&text("path")?), content: text("content")? },
            "edit_file" => Call::EditFile {
                path: self.resolve(&text("path")?),
                old: text("old_text")?,
                new: text("new_text")?,
                all: args.get("replace_all").and_then(Value::as_bool).unwrap_or(false),
            },
            "web_fetch" => Call::Fetch { url: text("url")?.trim().to_owned() },
            "list_dir" => Call::ListDir { path: self.resolve(&text("path").unwrap_or_else(|_| ".".to_owned())) },
            "remember" if self.home.is_some() => Call::Remember { text: text("text")? },
            "read_skill" if self.home.is_some() => Call::ReadSkill { name: text("name")? },
            "schedule_task" if self.home.is_some() => Call::Schedule {
                when: text("when")?,
                task: text("task")?,
                name: args.get("name").and_then(Value::as_str).map(str::to_owned).filter(|n| !n.trim().is_empty()),
            },
            "list_schedules" if self.home.is_some() => Call::ListSchedules,
            "propose_skill" if self.home.is_some() => {
                Call::ProposeSkill { name: text("name")?, description: text("description")?, steps: text("steps")? }
            }
            "search_sessions" if self.home.is_some() => Call::SearchSessions { query: text("query")? },
            "cancel_schedule" if self.home.is_some() => Call::CancelSchedule { id: text("id")? },
            other => return Err(format!("there is no tool named {other:?}")),
        })
    }

    /// What [call] needs approved, if anything. Reading inside the working directory does not.
    pub fn action(&self, call: &Call) -> Option<Action> {
        match call {
            Call::Terminal { command } => Some(Action::Command(command.clone())),
            Call::Fetch { url } => Some(Action::Fetch(url.clone())),
            Call::WriteFile { path, content } => Some(Action::Write {
                path: path.clone(),
                bytes: content.len(),
                inside: self.inside(path),
                hidden: self.hidden(path),
            }),
            // Asked for like a write of the replacement (what changes in the file).
            Call::EditFile { path, new, .. } => Some(Action::Write {
                path: path.clone(),
                bytes: new.len(),
                inside: self.inside(path),
                hidden: self.hidden(path),
            }),
            Call::ReadFile { path } | Call::ListDir { path } => {
                (!self.inside(path)).then(|| Action::Read(path.clone()))
            }
            // Its own notes and the owner's skills, in its home: nothing to approve.
            // Its own notes, the owner's skills, its own scheduler (whose runs follow the
            // unattended rules): nothing to approve.
            Call::Remember { .. }
            | Call::ReadSkill { .. }
            | Call::Schedule { .. }
            | Call::ProposeSkill { .. }
            | Call::SearchSessions { .. }
            | Call::ListSchedules
            | Call::CancelSchedule { .. } => None,
        }
    }

    pub async fn run(&self, call: &Call) -> String {
        let result = match call {
            Call::Terminal { command } => self.terminal(command).await,
            Call::ReadFile { path } => read(path).await,
            Call::WriteFile { path, content } => write(path, content).await,
            Call::EditFile { path, old, new, all } => edit(path, old, new, *all).await,
            Call::ListDir { path } => list(path).await,
            Call::Remember { text } => match &self.home {
                Some(home) => crate::memory::Memory::new(home).add(text).map(|id| format!("remembered (#{id})")),
                None => Err("no memory here".to_owned()),
            },
            Call::ReadSkill { name } => match &self.home {
                Some(home) => crate::skills::read(home, name),
                None => Err("no skills here".to_owned()),
            },
            Call::Schedule { when, task, name } => match &self.home {
                Some(home) => schedule(home, when, task, name.as_deref()),
                None => Err("no scheduler here".to_owned()),
            },
            Call::Fetch { .. } => Err("web_fetch runs in the agent".to_owned()),
            Call::ProposeSkill { name, description, steps } => match &self.home {
                Some(home) => crate::skills::propose(home, name, description, steps),
                None => Err("no skills here".to_owned()),
            },
            Call::SearchSessions { query } => match &self.home {
                Some(home) => {
                    let found = crate::session::search(&home.join("sessions"), query, 8, &turn_context().session);
                    Ok(if found.is_empty() {
                        "nothing found".to_owned()
                    } else {
                        found.iter().map(|(s, snippet)| format!("[{s}] {snippet}")).collect::<Vec<_>>().join("\n")
                    })
                }
                None => Err("no conversations here".to_owned()),
            },
            Call::ListSchedules => match &self.home {
                Some(home) => list_schedules(home),
                None => Err("no scheduler here".to_owned()),
            },
            Call::CancelSchedule { id } => match &self.home {
                Some(home) => cancel_schedule(home, id),
                None => Err("no scheduler here".to_owned()),
            },
        };
        cut(result.unwrap_or_else(|e| format!("error: {e}")))
    }

    async fn terminal(&self, command: &str) -> Result<String, String> {
        tokio::fs::create_dir_all(&self.workdir).await.map_err(|e| format!("{}: {e}", self.workdir.display()))?;
        let mut child = tokio::process::Command::new("sh")
            .arg("-c")
            .arg(command)
            .current_dir(&self.workdir)
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .kill_on_drop(true)
            .spawn()
            .map_err(|e| format!("sh: {e}"))?;
        let mut stdout = child.stdout.take().expect("piped");
        let mut stderr = child.stderr.take().expect("piped");
        let run = async {
            let (mut out, mut err) = (Vec::new(), Vec::new());
            let (a, b) = tokio::join!(stdout.read_to_end(&mut out), stderr.read_to_end(&mut err));
            a.and(b).map_err(|e| e.to_string())?;
            let status = child.wait().await.map_err(|e| e.to_string())?;
            Ok::<_, String>((out, err, status))
        };
        match tokio::time::timeout(self.timeout, run).await {
            Err(_) => Err(format!("stopped after {} seconds", self.timeout.as_secs())),
            Ok(result) => {
                let (out, err, status) = result?;
                let mut text = String::from_utf8_lossy(&out).into_owned();
                if !err.is_empty() {
                    text.push_str(&String::from_utf8_lossy(&err));
                }
                let code = status.code().map_or("killed by a signal".to_owned(), |c| format!("exit code {c}"));
                Ok(format!("{text}{}[{code}]", if text.is_empty() || text.ends_with('\n') { "" } else { "\n" }))
            }
        }
    }

    /// [path] relative to the working directory, with `~` expanded and `.`/`..` folded.
    pub fn resolve(&self, path: &str) -> PathBuf {
        let path = crate::config::expand(Path::new(path.trim()));
        let joined = if path.is_absolute() { path } else { self.workdir.join(path) };
        let mut clean = PathBuf::new();
        for part in joined.components() {
            match part {
                Component::ParentDir => {
                    clean.pop();
                }
                Component::CurDir => {}
                other => clean.push(other),
            }
        }
        clean
    }

    /// [path] is in the working directory, symlinks followed as far as the path exists. A
    /// symlink that leads nowhere (it could be created through) counts as outside.
    fn inside(&self, path: &Path) -> bool {
        let real = |p: &Path| -> Option<PathBuf> {
            let mut existing = p.to_path_buf();
            let mut rest = Vec::new();
            // symlink_metadata, not exists(): a dangling link is there, and must resolve.
            while existing.symlink_metadata().is_err() {
                match (existing.file_name().map(ToOwned::to_owned), existing.parent()) {
                    (Some(name), Some(parent)) => {
                        rest.push(name);
                        existing = parent.to_path_buf();
                    }
                    _ => break,
                }
            }
            let mut full = match existing.canonicalize() {
                Ok(full) => full,
                Err(_) if existing.symlink_metadata().is_ok() => return None,
                Err(_) => existing,
            };
            full.extend(rest.into_iter().rev());
            Some(full)
        };
        match (real(path), real(&self.workdir)) {
            (Some(path), Some(workdir)) => path.starts_with(workdir),
            _ => false,
        }
    }

    /// [path] is under a name starting with a dot, inside the working directory.
    fn hidden(&self, path: &Path) -> bool {
        path.strip_prefix(&self.workdir).ok().is_some_and(|rel| {
            rel.components().any(|c| matches!(c, Component::Normal(name) if name.to_string_lossy().starts_with('.')))
        })
    }
}

fn turn_context() -> TurnContext {
    TURN.try_with(Clone::clone).unwrap_or_default()
}

/// `schedule_task`: a schedule made by the agent, answering to the chat it was asked in.
fn schedule(home: &Path, when: &str, task: &str, name: Option<&str>) -> Result<String, String> {
    let turn = turn_context();
    // A scheduled run does not schedule more: no task spawns itself forever.
    if turn.session.starts_with("cron-") {
        return Err("a scheduled task cannot schedule more tasks".to_owned());
    }
    let mut schedules = crate::cron::Schedules::load(home)?;
    let origin = Some(format!("agent:{}", turn.session));
    let id = schedules.add_for(when, task, false, origin, turn.telegram_chat)?;
    if let Some(name) = name
        && let Some(s) = schedules.schedules.iter_mut().find(|s| s.id == id)
    {
        s.name = Some(name.trim().chars().take(120).collect());
    }
    schedules.save(home)?;
    let s = schedules.schedules.iter().find(|s| s.id == id).ok_or("lost the schedule")?;
    let next = crate::cron::When::parse(&s.when)
        .ok()
        .and_then(|w| w.next(None, crate::cron::local(s.created), chrono::Local::now()))
        .map_or("-".to_owned(), |t| t.format("%a %Y-%m-%d %H:%M").to_string());
    let reply = if turn.telegram_chat.is_some() { "; its answer comes to this chat" } else { "" };
    Ok(format!("scheduled {id} ({}), next run {next}{reply}", s.when))
}

fn list_schedules(home: &Path) -> Result<String, String> {
    let listing = crate::cron::listing(home)?;
    let lines: Vec<String> = listing["schedules"]
        .as_array()
        .into_iter()
        .flatten()
        .map(|s| {
            let next =
                s["next"].as_i64().map_or("-".to_owned(), |t| crate::cron::local(t).format("%a %H:%M").to_string());
            format!(
                "{} [{}] next {next}: {}",
                s["id"].as_str().unwrap_or("?"),
                s["when"].as_str().unwrap_or("?"),
                s["name"].as_str().or(s["task"].as_str()).unwrap_or("")
            )
        })
        .collect();
    Ok(if lines.is_empty() { "no scheduled tasks".to_owned() } else { lines.join("\n") })
}

fn cancel_schedule(home: &Path, id: &str) -> Result<String, String> {
    let mut schedules = crate::cron::Schedules::load(home)?;
    let Some(s) = schedules.schedules.iter().find(|s| s.id == id) else {
        return Err(format!("there is no scheduled task {id:?}"));
    };
    // A phone's recipe is changed on the phone (it would send it again anyway).
    if let Some(device) = s.origin.as_deref().and_then(|o| o.strip_prefix("device:")) {
        return Err(format!("{id} is a recipe from {device}; change it there"));
    }
    schedules.remove(id);
    schedules.save(home)?;
    Ok(format!("cancelled {id}"))
}

async fn read(path: &Path) -> Result<String, String> {
    let bytes = tokio::fs::read(path).await.map_err(|e| format!("{}: {e}", path.display()))?;
    if bytes.iter().take(8192).any(|b| *b == 0) {
        return Err(format!("{} is not a text file ({} bytes)", path.display(), bytes.len()));
    }
    Ok(String::from_utf8_lossy(&bytes).into_owned())
}

async fn write(path: &Path, content: &str) -> Result<String, String> {
    if let Some(dir) = path.parent() {
        tokio::fs::create_dir_all(dir).await.map_err(|e| format!("{}: {e}", dir.display()))?;
    }
    // Never through a link: the approval was for this path, not where a link points.
    if let Ok(meta) = tokio::fs::symlink_metadata(path).await {
        if meta.file_type().is_symlink() {
            return Err(format!("{} is a symbolic link; not writing through it", path.display()));
        }
        #[cfg(unix)]
        if std::os::unix::fs::MetadataExt::nlink(&meta) > 1 {
            return Err(format!("{} has other hard links; not writing to it", path.display()));
        }
    }
    let mut options = tokio::fs::OpenOptions::new();
    options.write(true).create(true).truncate(true);
    #[cfg(unix)]
    options.custom_flags(libc::O_NOFOLLOW);
    let mut file = options.open(path).await.map_err(|e| format!("{}: {e}", path.display()))?;
    // Flushed before it is dropped: a tokio file writes in the background, and an unflushed
    // write can be lost (the file stays empty).
    use tokio::io::AsyncWriteExt as _;
    file.write_all(content.as_bytes()).await.map_err(|e| format!("{}: {e}", path.display()))?;
    file.flush().await.map_err(|e| format!("{}: {e}", path.display()))?;
    Ok(format!("wrote {} bytes to {}", content.len(), path.display()))
}

/// Replaces [old] with [new] in the file at [path]: exactly once unless [all].
async fn edit(path: &Path, old: &str, new: &str, all: bool) -> Result<String, String> {
    if old.is_empty() {
        return Err("old_text is empty".to_owned());
    }
    let text = read(path).await?;
    let found = text.matches(old).count();
    let changed = match (found, all) {
        (0, _) => {
            return Err(format!(
                "old_text is not in {} (copy it exactly, spaces and line breaks included; read_file shows the file)",
                path.display()
            ));
        }
        (1, _) | (_, true) => text.replace(old, new),
        (n, false) => {
            return Err(format!(
                "old_text is in {} {n} times; include more lines around it so it is unique, or set replace_all",
                path.display()
            ));
        }
    };
    write(path, &changed).await?;
    Ok(format!(
        "replaced {} in {}",
        if found == 1 { "1 occurrence".to_owned() } else { format!("{found} occurrences") },
        path.display()
    ))
}

async fn list(path: &Path) -> Result<String, String> {
    let mut entries = tokio::fs::read_dir(path).await.map_err(|e| format!("{}: {e}", path.display()))?;
    let mut names = Vec::new();
    while let Some(entry) = entries.next_entry().await.map_err(|e| e.to_string())? {
        let dir = entry.file_type().await.is_ok_and(|t| t.is_dir());
        names.push(format!("{}{}", entry.file_name().to_string_lossy(), if dir { "/" } else { "" }));
    }
    names.sort();
    Ok(if names.is_empty() { "(empty)".to_owned() } else { names.join("\n") })
}

/// Keeps the start and the end of a long result: errors tend to be at the end.
pub fn cut(text: String) -> String {
    if text.len() <= RESULT_LIMIT {
        return text;
    }
    let half = RESULT_LIMIT / 2;
    let start = floor(&text, half);
    let end = ceil(&text, text.len() - half);
    format!("{}\n[… {} bytes cut …]\n{}", &text[..start], end - start, &text[end..])
}

fn floor(s: &str, mut i: usize) -> usize {
    while !s.is_char_boundary(i) {
        i -= 1;
    }
    i
}

fn ceil(s: &str, mut i: usize) -> usize {
    while !s.is_char_boundary(i) {
        i += 1;
    }
    i
}

#[cfg(test)]
mod tests {
    use super::{Call, RESULT_LIMIT, Tools, cut};
    use crate::approval::Action;
    use std::time::Duration;

    fn tools() -> (Tools, std::path::PathBuf) {
        let dir = std::env::temp_dir().join(format!("autobot-tools-{}-{}", std::process::id(), rand()));
        std::fs::create_dir_all(&dir).unwrap();
        let dir = dir.canonicalize().unwrap();
        (Tools::new(dir.clone(), Duration::from_secs(5)), dir)
    }

    /// Unique per call: tests run in parallel and must not share a directory.
    fn rand() -> u64 {
        static NEXT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
        let n = NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        (std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().subsec_nanos() as u64) << 16 | n
    }

    #[test]
    fn paths_resolve_in_the_workdir() {
        let (tools, dir) = tools();
        assert_eq!(tools.resolve("a/b.txt"), dir.join("a/b.txt"));
        assert_eq!(tools.resolve("a/../b.txt"), dir.join("b.txt"));
        assert_eq!(tools.resolve("/etc/hosts"), std::path::PathBuf::from("/etc/hosts"));
    }

    #[test]
    fn reads_outside_the_workdir_need_approval() {
        let (tools, dir) = tools();
        let inside = tools.parse("read_file", r#"{"path":"notes.txt"}"#).unwrap();
        assert_eq!(tools.action(&inside), None);
        let escape = tools.parse("read_file", r#"{"path":"../../etc/passwd"}"#).unwrap();
        assert!(matches!(tools.action(&escape), Some(Action::Read(_))));
        // A symlink out of the working directory counts as outside.
        std::os::unix::fs::symlink("/etc", dir.join("link")).unwrap();
        let through = tools.parse("list_dir", r#"{"path":"link"}"#).unwrap();
        assert!(matches!(tools.action(&through), Some(Action::Read(_))));
        let write = tools.parse("write_file", r#"{"path":"x","content":"hi"}"#).unwrap();
        assert!(matches!(tools.action(&write), Some(Action::Write { bytes: 2, inside: true, .. })));
        assert!(tools.parse("rm", "{}").is_err());
        assert!(tools.parse("terminal", "{}").is_err());
    }

    #[tokio::test]
    async fn edits_replace_exactly_once_or_say_why_not() {
        let (tools, dir) = tools();
        std::fs::write(dir.join("a.rs"), "fn a() {}\nfn b() {}\nfn b() {}\n").unwrap();
        let run = |args: &str| {
            let call = tools.parse("edit_file", args).unwrap();
            let tools = tools.clone();
            async move { tools.run(&call).await }
        };
        assert!(
            run(r#"{"path":"a.rs","old_text":"fn a() {}","new_text":"fn a() { 1 }"}"#).await.starts_with("replaced 1")
        );
        assert!(run(r#"{"path":"a.rs","old_text":"fn b() {}","new_text":"x"}"#).await.contains("2 times"));
        assert!(run(r#"{"path":"a.rs","old_text":"nope","new_text":"x"}"#).await.contains("is not in"));
        assert!(
            run(r#"{"path":"a.rs","old_text":"fn b() {}","new_text":"fn c() {}","replace_all":true}"#)
                .await
                .contains("2 occurrences")
        );
        assert_eq!(std::fs::read_to_string(dir.join("a.rs")).unwrap(), "fn a() { 1 }\nfn c() {}\nfn c() {}\n");
        // Asked for like a write.
        let call = tools.parse("edit_file", r#"{"path":"a.rs","old_text":"a","new_text":"bb"}"#).unwrap();
        assert!(matches!(tools.action(&call), Some(Action::Write { bytes: 2, inside: true, .. })));
    }

    #[tokio::test]
    async fn writes_never_go_through_links_or_into_dot_names_unseen() {
        let (tools, dir) = tools();
        let outside = std::env::temp_dir().join(format!("autobot-escape-{}", rand()));
        // A dangling link in the working directory, pointing out: outside, and never written through.
        std::os::unix::fs::symlink(&outside, dir.join("dangling")).unwrap();
        let call = tools.parse("write_file", r#"{"path":"dangling","content":"pwned"}"#).unwrap();
        assert!(matches!(tools.action(&call), Some(Action::Write { inside: false, .. })));
        assert!(tools.run(&call).await.contains("symbolic link"));
        assert!(!outside.exists());
        // A link to a file inside is refused too (the approval named the link).
        std::fs::write(dir.join("real.txt"), "a").unwrap();
        std::os::unix::fs::symlink(dir.join("real.txt"), dir.join("alias.txt")).unwrap();
        let alias = tools.parse("write_file", r#"{"path":"alias.txt","content":"b"}"#).unwrap();
        assert!(tools.run(&alias).await.contains("symbolic link"));
        // A hard link to a file elsewhere.
        std::fs::write(&outside, "keep").unwrap();
        std::fs::hard_link(&outside, dir.join("hard.txt")).unwrap();
        let hard = tools.parse("write_file", r#"{"path":"hard.txt","content":"x"}"#).unwrap();
        assert!(tools.run(&hard).await.contains("hard links"));
        assert_eq!(std::fs::read_to_string(&outside).unwrap(), "keep");
        // Dot names in the working directory are marked.
        let git = tools.parse("write_file", r#"{"path":".git/config","content":"x"}"#).unwrap();
        assert!(matches!(tools.action(&git), Some(Action::Write { inside: true, hidden: true, .. })));
        let plain = tools.parse("write_file", r#"{"path":"notes/a.md","content":"x"}"#).unwrap();
        assert!(matches!(tools.action(&plain), Some(Action::Write { inside: true, hidden: false, .. })));
        let _ = std::fs::remove_file(outside);
    }

    #[tokio::test]
    async fn terminal_reports_output_and_exit_code() {
        let (tools, dir) = tools();
        let out = tools.run(&Call::Terminal { command: "echo hi; echo oops >&2; exit 3".into() }).await;
        assert_eq!(out, "hi\noops\n[exit code 3]");
        let out = tools.run(&Call::Terminal { command: "pwd".into() }).await;
        assert!(out.starts_with(dir.to_str().unwrap()), "{out}");
        let tools = Tools::new(dir, Duration::from_millis(200));
        let out = tools.run(&Call::Terminal { command: "sleep 5".into() }).await;
        assert!(out.contains("stopped after"), "{out}");
    }

    #[tokio::test]
    async fn files_round_trip() {
        let (tools, _) = tools();
        let write = tools.parse("write_file", r#"{"path":"d/n.txt","content":"héllo"}"#).unwrap();
        assert!(tools.run(&write).await.starts_with("wrote 6 bytes"));
        assert_eq!(tools.run(&tools.parse("read_file", r#"{"path":"d/n.txt"}"#).unwrap()).await, "héllo");
        assert_eq!(tools.run(&tools.parse("list_dir", "{}").unwrap()).await, "d/");
        assert!(tools.run(&tools.parse("read_file", r#"{"path":"nope"}"#).unwrap()).await.starts_with("error:"));
    }

    #[test]
    fn long_results_keep_both_ends() {
        let text = format!("start{}end", "é".repeat(RESULT_LIMIT));
        let cut = cut(text);
        assert!(cut.starts_with("start") && cut.ends_with("end") && cut.contains("bytes cut"));
        assert!(cut.len() < RESULT_LIMIT + 100);
    }
}
