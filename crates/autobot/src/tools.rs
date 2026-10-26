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
    /// Never these tools (by name): turned off one by one ([crate::settings::set_tool]).
    off: Vec<String>,
    sandbox: crate::sandbox::Mode,
    /// Commands run sandboxed now: always, or unattended in a run with nobody watching.
    confined: bool,
    /// Most text one result hands back ([RESULT_LIMIT] unless the model takes more).
    limit: usize,
    /// Commands run in this container instead of here ([crate::docker]).
    docker: Option<std::sync::Arc<crate::docker::Docker>>,
    /// The `browser` tool is offered (when a browser is installed).
    browser: bool,
    /// Commands and files on another machine ([crate::ssh]).
    ssh: Option<std::sync::Arc<crate::ssh::Ssh>>,
    /// Home Assistant, for the `home` tool ([crate::homeassistant]).
    ha: Option<std::sync::Arc<crate::homeassistant::Home>>,
    /// What speech and image backends the node has ([crate::media]).
    media: crate::media::Cache,
    /// Files read and written through someone else: an editor that holds them open
    /// ([crate::acp]).
    files: Option<std::sync::Arc<dyn Files>>,
}

/// A future a [Files] hands back.
pub type FilesFuture<'a, T> =
    std::pin::Pin<Box<dyn std::future::Future<Output = Option<Result<T, String>>> + Send + 'a>>;

/// Where the file tools read and write when not on the disk directly: an editor's open buffers
/// ([crate::acp], over the Agent Client Protocol). None from a method: not handled there (the
/// disk then).
pub trait Files: Send + Sync {
    fn read<'a>(&'a self, path: &'a Path) -> FilesFuture<'a, String>;
    fn write<'a>(&'a self, path: &'a Path, text: &'a str) -> FilesFuture<'a, ()>;

    /// Runs the `terminal` tool's [command] (`sh -c`) in [cwd] there (an editor's terminal),
    /// stopped after [timeout], keeping the last [limit] bytes of what it printed. Asked only
    /// when commands run on this machine unconfined (not in a container, the sandbox or over
    /// SSH).
    fn terminal<'a>(
        &'a self,
        _command: &'a str,
        _cwd: &'a Path,
        _timeout: Duration,
        _limit: usize,
    ) -> FilesFuture<'a, String> {
        Box::pin(async { None })
    }
}

/// Tool groups, as Autobot recipes name them, and the tools each allows here. Groups the node has
/// no tools for (`web`, `vault`) allow nothing.
pub const GROUPS: &[(&str, &[&str])] = &[
    ("files-read", &["read_file", "list_dir", "search", "find_files", "read_skill"]),
    ("web", &["web_fetch", "browser"]),
    // Every MCP server's tools.
    ("mcp", &["mcp"]),
    ("files-write", &["write_file", "edit_file"]),
    ("memory", &["remember", "search_sessions", "create_skill", "improve_skill", "update_user_profile"]),
    ("terminal", &["terminal", "process", "execute_code"]),
    ("plan", &["todo"]),
    ("home", &["home"]),
    ("schedule", &["schedule_task", "list_schedules", "cancel_schedule"]),
    // Made by the node's speech and image backends.
    ("media", &["speak", "generate_image"]),
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
    /// The Discord channel it came from (answers to a scheduled task go back there).
    pub discord_channel: Option<String>,
    /// Where it came from on any platform (`slack:C123/1712.0001`, `email:<thread>`): answers to
    /// a scheduled task go back there ([crate::channel::parse_address]).
    pub reply_to: Option<String>,
    /// The team member doing this turn; None for the main agent.
    pub agent: Option<String>,
    /// The board task it works on, when it is one ([crate::board]).
    pub board_task: Option<String>,
    /// What the owner sent while the turn runs: taken in before its next step.
    pub inbox: Option<Inbox>,
    /// Files the turn made (speech, images), to go with its answer in the chat ([crate::media]).
    pub outbox: Option<crate::media::Outbox>,
}

/// Messages for a running turn ([TurnContext::inbox]).
pub type Inbox = std::sync::Arc<std::sync::Mutex<Vec<String>>>;

tokio::task_local! {
    pub static TURN: TurnContext;
}

/// One tool call, parsed.
#[derive(Debug, PartialEq, Eq)]
pub enum Call {
    Terminal {
        command: String,
    },
    /// A command left running ([crate::procs]): a server, a watcher.
    Background {
        command: String,
    },
    /// A background process: list, output, wait or stop.
    Process {
        action: String,
        id: Option<u32>,
        seconds: u64,
    },
    ReadFile {
        path: PathBuf,
        /// The first line to read (1-based).
        offset: Option<usize>,
        /// How many lines.
        limit: Option<usize>,
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
        /// One of its supporting files instead of its SKILL.md.
        file: Option<String>,
    },
    Schedule {
        when: String,
        task: String,
        name: Option<String>,
    },
    /// A new skill, proposed to the owner (`create_skill`; `propose_skill` before).
    CreateSkill {
        name: String,
        description: String,
        steps: String,
        /// Supporting files: (relative path, text).
        files: Vec<(String, String)>,
    },
    /// A change to an existing skill, proposed to the owner: a new body, or one exact edit.
    ImproveSkill {
        name: String,
        description: Option<String>,
        body: Option<String>,
        edit: Option<(String, String)>,
    },
    /// A small change to the owner's profile (USER.md).
    UpdateProfile(crate::profile::Change),
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
    /// File contents matching a regular expression, under [path] (`.gitignore` respected).
    Search {
        pattern: String,
        path: PathBuf,
        glob: Option<String>,
        ignore_case: bool,
    },
    /// Files whose path matches a glob, under the working directory.
    FindFiles {
        pattern: String,
        path: PathBuf,
    },
    /// The agent's task list for a longer job: the whole list each time.
    Todo {
        items: Value,
    },
    /// The headless browser ([crate::browser]).
    Browser(crate::browser::Act),
    /// A script that can call the read-only tools ([crate::script]); run by the agent.
    ExecuteCode {
        language: crate::script::Language,
        code: String,
    },
    /// Home Assistant ([crate::homeassistant]).
    Home(crate::homeassistant::HomeCall),
    /// Speech from the node ([crate::media]); run by the agent.
    Speak {
        text: String,
        voice: Option<String>,
    },
    /// A picture from the node ([crate::media]); run by the agent.
    Image {
        prompt: String,
        size: Option<String>,
    },
}

impl Tools {
    pub fn new(workdir: PathBuf, timeout: Duration) -> Self {
        Self {
            workdir,
            timeout,
            home: None,
            only: None,
            off: Vec::new(),
            sandbox: crate::sandbox::Mode::Off,
            confined: false,
            limit: RESULT_LIMIT,
            docker: None,
            browser: false,
            ssh: None,
            ha: None,
            media: Default::default(),
            files: None,
        }
    }

    /// What the node can make, asked at most once a minute ([crate::media]).
    pub fn media(&self) -> &crate::media::Cache {
        &self.media
    }

    /// The file tools through [files] (an editor's buffers) where it handles them.
    pub fn with_files(mut self, files: std::sync::Arc<dyn Files>) -> Self {
        self.files = Some(files);
        self
    }

    /// With the `home` tool on [ha].
    pub fn with_home_assistant(mut self, ha: crate::homeassistant::Home) -> Self {
        self.ha = Some(std::sync::Arc::new(ha));
        self
    }

    /// The Home Assistant the `home` tool reaches, if any.
    pub fn home_assistant(&self) -> Option<&crate::homeassistant::Home> {
        self.ha.as_deref()
    }

    /// Commands and files on another machine ([crate::ssh]).
    pub fn with_ssh(mut self, ssh: crate::ssh::Ssh) -> Self {
        self.ssh = Some(std::sync::Arc::new(ssh));
        self
    }

    /// The machine commands and files are on, when it is another one.
    pub fn ssh(&self) -> Option<&crate::ssh::Ssh> {
        self.ssh.as_deref()
    }

    /// With the `browser` tool, when there is a browser to drive ([crate::browser::find]).
    pub fn with_browser(mut self, on: bool) -> Self {
        self.browser = on;
        self
    }

    /// Commands in a container ([crate::docker]).
    pub fn with_docker(mut self, docker: crate::docker::Docker) -> Self {
        self.docker = Some(std::sync::Arc::new(docker));
        self
    }

    /// The container commands run in, if any.
    pub fn docker(&self) -> Option<&crate::docker::Docker> {
        self.docker.as_deref()
    }

    /// With memory and skills from [home] (`$AUTOBOT_HOME`).
    pub fn with_home(mut self, home: PathBuf) -> Self {
        self.home = Some(home);
        self
    }

    /// Commands sandboxed as [mode] says.
    pub fn with_sandbox(mut self, mode: crate::sandbox::Mode) -> Self {
        self.sandbox = mode;
        self.confined = mode == crate::sandbox::Mode::Always;
        self
    }

    /// Results up to about a sixth of [context_kib] (16 to 96 KiB): a frontier model reads a
    /// whole source file at once, a small local one gets the start and the end.
    pub fn with_context(mut self, context_kib: usize) -> Self {
        self.limit = (context_kib * 1024 / 6).clamp(RESULT_LIMIT, 96 * 1024);
        self
    }

    /// For a run with nobody watching: commands are confined unless the sandbox is off.
    pub fn unattended(mut self) -> Self {
        self.confined = self.sandbox != crate::sandbox::Mode::Off;
        self
    }

    /// Where commands run and how they are confined, as the action log says it: `ssh` or
    /// `container` when they run there, this machine's sandbox ([crate::sandbox::name]) when
    /// confined here, `off` otherwise.
    pub fn confinement(&self) -> &'static str {
        if self.ssh.is_some() {
            "ssh"
        } else if self.docker.is_some() {
            "container"
        } else if self.confined {
            crate::sandbox::name()
        } else {
            "off"
        }
    }

    /// Offers and runs only [tools] (by name).
    pub fn only(mut self, tools: Vec<String>) -> Self {
        self.only = Some(tools);
        self
    }

    /// Never offers or runs [tools] (by name).
    pub fn without(mut self, tools: Vec<String>) -> Self {
        self.off = tools;
        self
    }

    /// Whether [name] is offered ("mcp" stands for every MCP tool).
    pub fn offers(&self, name: &str) -> bool {
        self.offered(name)
    }

    fn offered(&self, name: &str) -> bool {
        self.only.as_ref().is_none_or(|only| only.iter().any(|t| t == name)) && !self.off.iter().any(|t| t == name)
    }

    pub fn workdir(&self) -> &Path {
        &self.workdir
    }

    pub fn home(&self) -> Option<&Path> {
        self.home.as_deref()
    }

    /// How long a command may run.
    pub fn timeout(&self) -> Duration {
        self.timeout
    }

    /// Most text one result hands back.
    pub fn limit(&self) -> usize {
        self.limit
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
                "name": "create_skill",
                "description": "After a task that took many steps, worked, and will come up again, write down how to do it as a skill (an agentskills.io SKILL.md, with optional supporting files such as a script). The owner reviews it before you can use it. Never put secrets in it.",
                "parameters": { "type": "object", "properties": {
                    "name": { "type": "string", "description": "short-name-with-dashes" },
                    "description": { "type": "string", "description": "One line: what it is for and when to use it" },
                    "steps": { "type": "string", "description": "The instructions: steps, commands and paths, in Markdown" },
                    "files": { "type": "object", "description": "Optional supporting files: relative path to text (e.g. scripts/check.sh)", "additionalProperties": { "type": "string" } },
                }, "required": ["name", "description", "steps"] },
            }}));
            list.push(json!({ "type": "function", "function": {
                "name": "improve_skill",
                "description": "Improve one of the owner's skills after using it (a step was wrong, missing or out of date): either one exact edit (old_text, new_text) or the whole new body. The owner sees the diff and decides.",
                "parameters": { "type": "object", "properties": {
                    "name": { "type": "string" },
                    "old_text": { "type": "string", "description": "Exactly as in the skill, once." },
                    "new_text": { "type": "string" },
                    "body": { "type": "string", "description": "Instead of an edit: the whole new instructions." },
                    "description": { "type": "string", "description": "A new one-line description (optional)." },
                }, "required": ["name"] },
            }}));
            list.push(json!({ "type": "function", "function": {
                "name": "update_user_profile",
                "description": "Keep the owner's profile (USER.md, in your instructions) current: how they work and want things done (preferences, tools, style, recurring context). One small change per call: add an entry, replace the one containing old_text, or remove it. Never secrets or personal data; the owner sees every change.",
                "parameters": { "type": "object", "properties": {
                    "action": { "type": "string", "enum": ["add", "replace", "remove"] },
                    "text": { "type": "string", "description": "The entry (add, replace): one short line." },
                    "old_text": { "type": "string", "description": "Part of the entry to replace or remove." },
                }, "required": ["action"] },
            }}));
            list.push(json!({ "type": "function", "function": {
                "name": "search_sessions",
                "description": "Recall earlier conversations: what was said, decided or left open about something (keywords). Gives a short summary of each conversation that matches best, then the matching messages.",
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
                "description": "Read one of the owner's skills (how-to notes listed in your instructions) by name; with file, one of its supporting files.",
                "parameters": { "type": "object", "properties": {
                    "name": { "type": "string" },
                    "file": { "type": "string", "description": "A supporting file the skill lists (relative path)." },
                }, "required": ["name"] },
            }}));
        }
        // The browser, where there is one to drive (and commands run here, not elsewhere).
        if self.browser
            && self.docker.is_none()
            && self.ssh.is_none()
            && crate::browser::find().is_some()
            && let Some(list) = tools.as_array_mut()
        {
            list.push(crate::browser::definition());
        }
        if self.ha.is_some()
            && let Some(list) = tools.as_array_mut()
        {
            list.push(crate::homeassistant::definition());
        }
        if let Some(list) = tools.as_array_mut() {
            list.retain(|t| self.offered(t["function"]["name"].as_str().unwrap_or_default()));
        }
        tools
    }

    /// The tools every agent has.
    fn base_definitions() -> Value {
        let mut all = Self::plain_definitions();
        if let Some(list) = all.as_array_mut() {
            list.insert(2, crate::script::definition());
        }
        all
    }

    fn plain_definitions() -> Value {
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
                "Run a shell command (sh -c) in the working directory and return its output and exit code. For something that keeps running (a dev server, a watcher, a long build), set background: it returns at once with a process number for the process tool.",
                json!({
                    "command": { "type": "string", "description": "The command line." },
                    "background": { "type": "boolean", "description": "Leave it running and return at once (default false)." },
                }),
                &["command"],
            ),
            function(
                "process",
                "The commands left running in the background: list them, read what one printed since you last looked (output), wait up to seconds for it to end and read (wait), or stop it and what it started (stop).",
                json!({
                    "action": { "type": "string", "enum": ["list", "output", "wait", "stop"] },
                    "id": { "type": "integer", "description": "The process number (not for list)." },
                    "seconds": { "type": "integer", "description": "For wait: at most this long (default 30)." },
                }),
                &["action"],
            ),
            function(
                "read_file",
                "Read a text file. Relative paths are in the working directory. A long file comes in parts: offset and limit (lines) read the rest.",
                json!({
                    "path": { "type": "string" },
                    "offset": { "type": "integer", "description": "The first line to read (1-based)." },
                    "limit": { "type": "integer", "description": "How many lines (default: to the end)." },
                }),
                &["path"],
            ),
            function(
                "todo",
                "Keep a task list for a job with several steps: send the whole list each time, with each item's status. Mark an item doing when you start it and done when it is finished. The owner sees it.",
                json!({ "items": { "type": "array", "items": { "type": "object", "properties": {
                    "text": { "type": "string" },
                    "status": { "type": "string", "enum": ["pending", "doing", "done"] },
                }, "required": ["text", "status"] } } }),
                &["items"],
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
                "search",
                "Search file contents with a regular expression, like ripgrep (.gitignore respected, binary files skipped). Returns path:line: text, at most 200 matches. Use it to find where something is defined or used before reading files.",
                json!({
                    "pattern": { "type": "string", "description": "A regular expression (Rust regex syntax)." },
                    "path": { "type": "string", "description": "A directory or file to search. Default: the working directory." },
                    "glob": { "type": "string", "description": "Only files matching this glob, e.g. *.rs or src/**/*.ts." },
                    "ignore_case": { "type": "boolean" },
                }),
                &["pattern"],
            ),
            function(
                "find_files",
                "Find files by path glob, e.g. **/*.rs, src/**/test_*.py, **/Cargo.toml (.gitignore respected). Returns paths relative to the working directory, at most 500.",
                json!({
                    "pattern": { "type": "string" },
                    "path": { "type": "string", "description": "Where to look. Default: the working directory." },
                }),
                &["pattern"],
            ),
            function(
                "list_dir",
                "List a directory's entries. Relative paths are in the working directory.",
                json!({ "path": { "type": "string", "description": "Default: the working directory." } }),
                &[],
            ),
        ])
    }

    /// [name] with its JSON [arguments], as a [Call]. Arguments a model got slightly wrong
    /// (in a code fence, a raw line break in a string, a trailing comma) are read as meant; what
    /// cannot be read says what the tool takes, so the next try can be right.
    pub fn parse(&self, name: &str, arguments: &str) -> Result<Call, String> {
        // `functions.read_file`: some models name tools as their template shows them.
        let name = name.trim();
        let name = name.strip_prefix("functions.").unwrap_or(name);
        let args: Value = if arguments.trim().is_empty() {
            json!({})
        } else {
            match serde_json::from_str(arguments) {
                Ok(args) => args,
                Err(e) => match repair_json(arguments) {
                    Some(args) => args,
                    None => {
                        return Err(format!(
                            "the arguments are not JSON ({e}); send one JSON object{}",
                            self.takes(name).map(|t| format!(" ({t})")).unwrap_or_default()
                        ));
                    }
                },
            }
        };
        let args = if args.is_null() { json!({}) } else { args };
        if !args.is_object() {
            return Err(format!(
                "the arguments must be a JSON object{}",
                self.takes(name).map(|t| format!(" ({t})")).unwrap_or_default()
            ));
        }
        self.parse_args(name, &args).map_err(|e| {
            if e.starts_with("there is no tool") || e.contains("not allowed") {
                return e;
            }
            match self.takes(name) {
                Some(takes) => format!("{e}; {takes}"),
                None => e,
            }
        })
    }

    /// What tool [name] takes, from its definition: `edit_file takes path, old_text, new_text
    /// (required), replace_all`.
    fn takes(&self, name: &str) -> Option<String> {
        let definitions = self.definitions();
        let tool = definitions.as_array()?.iter().find(|d| d["function"]["name"] == name)?;
        let parameters = &tool["function"]["parameters"];
        let required: Vec<&str> =
            parameters["required"].as_array().into_iter().flatten().filter_map(Value::as_str).collect();
        let optional: Vec<&str> = parameters["properties"]
            .as_object()
            .into_iter()
            .flatten()
            .map(|(k, _)| k.as_str())
            .filter(|k| !required.contains(k))
            .collect();
        let mut out = format!("{name} takes ");
        if !required.is_empty() {
            out.push_str(&format!("{} (required)", required.join(", ")));
        }
        if !optional.is_empty() {
            if !required.is_empty() {
                out.push_str(", ");
            }
            out.push_str(&optional.join(", "));
        }
        if required.is_empty() && optional.is_empty() {
            out.push_str("no arguments");
        }
        Some(out)
    }

    /// The tool names this agent offers, for a model that asked for one it does not have.
    fn names(&self) -> Vec<String> {
        self.definitions()
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(|d| d["function"]["name"].as_str().map(str::to_owned))
            .collect()
    }

    fn parse_args(&self, name: &str, args: &Value) -> Result<Call, String> {
        // The old name of create_skill, for models (and trajectories) that know it.
        let name = if name == "propose_skill" { "create_skill" } else { name };
        if !self.offered(name) {
            return Err(format!("the tool {name:?} is not allowed in this task"));
        }
        let text = |key: &str| -> Result<String, String> {
            args.get(key).and_then(Value::as_str).map(str::to_owned).ok_or(format!("`{key}` is missing"))
        };
        Ok(match name {
            "terminal" if args.get("background").and_then(Value::as_bool) == Some(true) => {
                Call::Background { command: text("command")? }
            }
            "terminal" => Call::Terminal { command: text("command")? },
            "process" => {
                let action = text("action")?;
                if !matches!(action.as_str(), "list" | "output" | "wait" | "stop") {
                    return Err(format!("unknown action {action:?} (list, output, wait or stop)"));
                }
                let id = args.get("id").and_then(Value::as_u64).map(|n| n.min(u32::MAX as u64) as u32);
                if action != "list" && id.is_none() {
                    return Err("`id` is missing".to_owned());
                }
                let seconds = args.get("seconds").and_then(Value::as_u64).unwrap_or(30);
                Call::Process { action, id, seconds }
            }
            "read_file" => Call::ReadFile {
                path: self.resolve(&text("path")?),
                offset: args.get("offset").and_then(Value::as_u64).map(|n| n.max(1) as usize),
                limit: args.get("limit").and_then(Value::as_u64).map(|n| n.max(1) as usize),
            },
            "todo" => Call::Todo { items: args.get("items").cloned().unwrap_or_else(|| json!([])) },
            "write_file" => Call::WriteFile { path: self.resolve(&text("path")?), content: text("content")? },
            "edit_file" => Call::EditFile {
                path: self.resolve(&text("path")?),
                old: text("old_text")?,
                new: text("new_text")?,
                all: args.get("replace_all").and_then(Value::as_bool).unwrap_or(false),
            },
            "web_fetch" => Call::Fetch { url: text("url")?.trim().to_owned() },
            "list_dir" => Call::ListDir { path: self.resolve(&text("path").unwrap_or_else(|_| ".".to_owned())) },
            "search" => Call::Search {
                pattern: text("pattern")?,
                path: self.resolve(&text("path").unwrap_or_else(|_| ".".to_owned())),
                glob: args.get("glob").and_then(Value::as_str).map(str::to_owned).filter(|g| !g.trim().is_empty()),
                ignore_case: args.get("ignore_case").and_then(Value::as_bool).unwrap_or(false),
            },
            "find_files" => Call::FindFiles {
                pattern: text("pattern")?,
                path: self.resolve(&text("path").unwrap_or_else(|_| ".".to_owned())),
            },
            "remember" if self.home.is_some() => Call::Remember { text: text("text")? },
            "read_skill" if self.home.is_some() => Call::ReadSkill {
                name: text("name")?,
                file: args.get("file").and_then(Value::as_str).map(str::to_owned).filter(|f| !f.trim().is_empty()),
            },
            "schedule_task" if self.home.is_some() => Call::Schedule {
                when: text("when")?,
                task: text("task")?,
                name: args.get("name").and_then(Value::as_str).map(str::to_owned).filter(|n| !n.trim().is_empty()),
            },
            "list_schedules" if self.home.is_some() => Call::ListSchedules,
            "create_skill" if self.home.is_some() => Call::CreateSkill {
                name: text("name")?,
                description: text("description")?,
                steps: text("steps")?,
                files: args
                    .get("files")
                    .and_then(Value::as_object)
                    .map(|o| o.iter().filter_map(|(k, v)| Some((k.clone(), v.as_str()?.to_owned()))).collect())
                    .unwrap_or_default(),
            },
            "improve_skill" if self.home.is_some() => {
                let opt = |key: &str| args.get(key).and_then(Value::as_str).map(str::to_owned);
                let edit = match (opt("old_text"), opt("new_text")) {
                    (Some(old), Some(new)) => Some((old, new)),
                    _ => None,
                };
                let body = opt("body").filter(|b| !b.trim().is_empty());
                if edit.is_none() && body.is_none() {
                    return Err("give old_text and new_text, or the whole body".to_owned());
                }
                Call::ImproveSkill { name: text("name")?, description: opt("description"), body, edit }
            }
            "update_user_profile" if self.home.is_some() => {
                use crate::profile::Change;
                Call::UpdateProfile(match text("action")?.as_str() {
                    "add" => Change::Add(text("text")?),
                    "replace" => Change::Replace(text("old_text")?, text("text")?),
                    "remove" => Change::Remove(text("old_text")?),
                    other => return Err(format!("unknown action {other:?} (add, replace or remove)")),
                })
            }
            "search_sessions" if self.home.is_some() => Call::SearchSessions { query: text("query")? },
            "cancel_schedule" if self.home.is_some() => Call::CancelSchedule { id: text("id")? },
            "browser" if self.browser => Call::Browser(crate::browser::Act::parse(args)?),
            "home" if self.ha.is_some() => Call::Home(crate::homeassistant::HomeCall::parse(args)?),
            "speak" => Call::Speak {
                text: text("text")?,
                voice: args.get("voice").and_then(Value::as_str).map(str::to_owned).filter(|v| !v.trim().is_empty()),
            },
            "generate_image" => Call::Image {
                prompt: text("prompt")?,
                size: args.get("size").and_then(Value::as_str).map(str::to_owned).filter(|s| !s.trim().is_empty()),
            },
            "execute_code" => Call::ExecuteCode {
                language: crate::script::Language::parse(
                    args.get("language").and_then(Value::as_str).unwrap_or_default(),
                )?,
                code: text("code")?,
            },
            other => {
                return Err(format!("there is no tool named {other:?}; the tools are: {}", self.names().join(", ")));
            }
        })
    }

    /// What [call] needs approved, if anything. Reading inside the working directory does not.
    pub fn action(&self, call: &Call) -> Option<Action> {
        match call {
            Call::Terminal { command } | Call::Background { command } => Some(Action::Command(command.clone())),
            Call::ExecuteCode { language, code } => Some(Action::Command(crate::script::shown(*language, code))),
            Call::Browser(act) => {
                use crate::browser::{Act, current_url, origin};
                let page = || current_url().unwrap_or_else(|| "about:blank".to_owned());
                match act {
                    // A new site is an outside read, like a fetch; the page's own site is not.
                    Act::Navigate { url } => match origin(url) {
                        Some(to) if current_url().and_then(|c| origin(&c)).as_deref() != Some(to.as_str()) => {
                            Some(Action::Fetch(to))
                        }
                        _ => None,
                    },
                    Act::Type { target, text, submit } => Some(Action::Type {
                        page: page(),
                        field: target.describe(),
                        text: text.clone(),
                        submit: *submit,
                    }),
                    Act::Submit { target } => {
                        Some(Action::Type { page: page(), field: target.describe(), text: String::new(), submit: true })
                    }
                    _ => None,
                }
            }
            Call::Fetch { url } => Some(Action::Fetch(url.clone())),
            // Reading the house asks nothing; changing it does.
            Call::Home(call) => call.action(),
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
            Call::ReadFile { path, .. }
            | Call::ListDir { path }
            | Call::Search { path, .. }
            | Call::FindFiles { path, .. } => (!self.inside(path)).then(|| Action::Read(path.clone())),
            // Its own notes and the owner's skills, in its home: nothing to approve.
            // Its own notes, the owner's skills, its own scheduler (whose runs follow the
            // unattended rules): nothing to approve.
            Call::Remember { .. }
            | Call::ReadSkill { .. }
            | Call::Schedule { .. }
            | Call::CreateSkill { .. }
            | Call::ImproveSkill { .. }
            | Call::UpdateProfile(_)
            | Call::SearchSessions { .. }
            | Call::ListSchedules
            | Call::CancelSchedule { .. }
            | Call::Process { .. }
            | Call::Todo { .. } => None,
            // Asked for in the agent, when it leaves the machine ([crate::media]).
            Call::Speak { .. } | Call::Image { .. } => None,
        }
    }

    pub async fn run(&self, call: &Call) -> String {
        if let Some(files) = &self.files
            && let Some(result) = through(files.as_ref(), call).await
        {
            return cut_to(result.unwrap_or_else(|e| format!("error: {e}")), self.limit);
        }
        if let (Call::Terminal { command }, Some(files)) = (call, &self.files)
            && self.ssh.is_none()
            && self.docker.is_none()
            && !self.confined
            && let Some(result) = files.terminal(command, &self.workdir, self.timeout, self.limit).await
        {
            return cut_to(result.unwrap_or_else(|e| format!("error: {e}")), self.limit);
        }
        if let Some(ssh) = &self.ssh
            && let Some(result) = self.remote(ssh, call).await
        {
            return cut_to(result.unwrap_or_else(|e| format!("error: {e}")), self.limit);
        }
        let result = match call {
            Call::Terminal { command } => self.terminal(command).await,
            Call::Background { command } => self.background(command).await,
            Call::Process { action, id, seconds } => {
                let wait = Duration::from_secs((*seconds).min(self.timeout.as_secs().max(1)));
                match (action.as_str(), id) {
                    ("output", Some(id)) => crate::procs::output(*id, Duration::ZERO).await,
                    ("wait", Some(id)) => crate::procs::output(*id, wait).await,
                    ("stop", Some(id)) => crate::procs::stop(*id).await,
                    _ => Ok(crate::procs::list()),
                }
            }
            Call::ReadFile { path, offset, limit } => read_lines(path, *offset, *limit, self.limit).await,
            Call::Todo { items } => todo(items),
            Call::WriteFile { path, content } => write(path, content).await,
            Call::EditFile { path, old, new, all } => edit(path, old, new, *all).await,
            Call::ListDir { path } => list(path).await,
            Call::Search { pattern, path, glob, ignore_case } => {
                let (pattern, path, glob, ignore_case, root) =
                    (pattern.clone(), path.clone(), glob.clone(), *ignore_case, self.workdir.clone());
                tokio::task::spawn_blocking(move || {
                    crate::search::grep(&root, &path, &pattern, glob.as_deref(), ignore_case)
                })
                .await
                .map_err(|e| e.to_string())
                .and_then(|r| r)
            }
            Call::FindFiles { pattern, path } => {
                let (pattern, path, root) = (pattern.clone(), path.clone(), self.workdir.clone());
                tokio::task::spawn_blocking(move || crate::search::find(&root, &path, &pattern))
                    .await
                    .map_err(|e| e.to_string())
                    .and_then(|r| r)
            }
            Call::Remember { text } => match (&self.home, crate::profile::sensitive(text)) {
                (Some(_), Some(why)) => {
                    Err(format!("not remembered: it contains {why}; memory is never for secrets or personal data"))
                }
                (Some(home), None) => {
                    crate::memory::Memory::current(home).add(text).map(|id| format!("remembered (#{id})"))
                }
                (None, _) => Err("no memory here".to_owned()),
            },
            Call::ReadSkill { name, file } => match &self.home {
                Some(home) => crate::skills::read_with(home, name, file.as_deref()),
                None => Err("no skills here".to_owned()),
            },
            Call::Schedule { when, task, name } => match &self.home {
                Some(home) => schedule(home, when, task, name.as_deref()),
                None => Err("no scheduler here".to_owned()),
            },
            Call::Fetch { .. } => Err("web_fetch runs in the agent".to_owned()),
            Call::Speak { .. } | Call::Image { .. } => Err("speak and generate_image run in the agent".to_owned()),
            Call::Home(call) => match &self.ha {
                Some(ha) => call.run(ha).await,
                None => Err("Home Assistant is not set up here ([homeassistant] url)".to_owned()),
            },
            Call::ExecuteCode { .. } => Err("execute_code runs in the agent".to_owned()),
            Call::Browser(act) => {
                let shots = self.home.as_ref().map_or_else(std::env::temp_dir, |h| h.join("attachments"));
                crate::browser::run(act, &shots, self.limit).await.map(|(text, _)| text)
            }
            Call::CreateSkill { name, description, steps, files } => match &self.home {
                Some(home) => crate::skills::propose(home, name, description, steps, files),
                None => Err("no skills here".to_owned()),
            },
            Call::ImproveSkill { name, description, body, edit } => match &self.home {
                Some(home) => crate::skills::improve(
                    home,
                    name,
                    description.as_deref(),
                    body.as_deref(),
                    edit.as_ref().map(|(o, n)| (o.as_str(), n.as_str())),
                ),
                None => Err("no skills here".to_owned()),
            },
            Call::UpdateProfile(change) => match &self.home {
                // A team member does not change the owner's profile: it reports to the lead.
                Some(_) if turn_context().agent.is_some() => {
                    Err("only the lead agent keeps the owner's profile; tell the lead instead".to_owned())
                }
                Some(home) => crate::profile::update(home, change),
                None => Err("no profile here".to_owned()),
            },
            Call::SearchSessions { query } => match &self.home {
                Some(home) => {
                    let (dir, query, skip) = (home.join("sessions"), query.clone(), turn_context().session);
                    tokio::task::spawn_blocking(move || {
                        crate::recall::plain(&crate::recall::search(&dir, &query, 8, &skip))
                    })
                    .await
                    .map_err(|e| e.to_string())
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
        cut_to(result.unwrap_or_else(|e| format!("error: {e}")), self.limit)
    }

    /// What a write or an edit changes: the file, its text before (empty when it is new) and
    /// after, as it is here or on the machine commands run on; None for other calls, and for an
    /// edit that would not apply.
    pub fn change(&self, call: &Call) -> Option<(PathBuf, String, String)> {
        let now = |path: &Path| match &self.ssh {
            Some(ssh) => ssh.read_now(path),
            None => std::fs::read_to_string(path).ok(),
        };
        match call {
            Call::WriteFile { path, content } => Some((path.clone(), now(path).unwrap_or_default(), content.clone())),
            Call::EditFile { path, old, new, all } => {
                let text = now(path)?;
                let (after, _, _) = crate::edit::apply(&text, old, new, *all).ok().filter(|_| !old.is_empty())?;
                Some((path.clone(), text, after))
            }
            _ => None,
        }
    }

    /// The file tools on the machine [ssh] reaches; None for the calls that run here anyway.
    async fn remote(&self, ssh: &crate::ssh::Ssh, call: &Call) -> Option<Result<String, String>> {
        let text = |bytes: Vec<u8>, path: &Path| -> Result<String, String> {
            if bytes.iter().take(8192).any(|b| *b == 0) {
                return Err(format!("{} is not a text file ({} bytes)", path.display(), bytes.len()));
            }
            Ok(String::from_utf8_lossy(&bytes).into_owned())
        };
        Some(match call {
            Call::ReadFile { path, offset, limit } => {
                ssh.read(path).await.and_then(|b| text(b, path)).map(|t| lines(&t, *offset, *limit))
            }
            Call::WriteFile { path, content } => ssh
                .write(path, content.as_bytes())
                .await
                .map(|()| format!("wrote {} bytes to {}", content.len(), path.display())),
            Call::EditFile { path, old, new, all } => {
                let before = match ssh.read(path).await.and_then(|b| text(b, path)) {
                    Ok(before) => before,
                    Err(e) => return Some(Err(e)),
                };
                match edited_off(before, old, new, *all, path).await {
                    Ok((after, said)) => ssh.write(path, after.as_bytes()).await.map(|()| said),
                    Err(e) => Err(e),
                }
            }
            Call::ListDir { path } => ssh.list(path).await,
            Call::Search { pattern, path, glob, ignore_case } => {
                ssh.search(path, pattern, glob.as_deref(), *ignore_case).await
            }
            Call::FindFiles { pattern, path } => ssh.find(path, pattern).await,
            _ => return None,
        })
    }

    /// [command] left running; its number, and what it printed in its first second.
    async fn background(&self, command: &str) -> Result<String, String> {
        if let Some(ssh) = &self.ssh {
            let stamp = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or_default();
            let pidfile = format!("/tmp/autobot-bg-{stamp}.pid");
            let child = ssh.background(command, &self.workdir, &pidfile);
            let id = crate::procs::start(command, child, &std::env::temp_dir(), Some(ssh.stop_command(&pidfile)))?;
            return Ok(format!(
                "started background process {id} on {}; read its output with process {{\"action\": \"output\", \"id\": {id}}}, stop it with action stop",
                ssh.host
            ));
        }
        std::fs::create_dir_all(&self.workdir).map_err(|e| format!("{}: {e}", self.workdir.display()))?;
        let mut stopper = None;
        let child = if let Some(docker) = &self.docker {
            let name = docker.ensure(&self.workdir).await?;
            let stamp = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or_default();
            let pidfile = format!("/tmp/autobot-bg-{stamp}.pid");
            stopper = Some(crate::docker::Docker::stop_command(&name, &pidfile));
            docker.background(&name, command, &self.workdir, &pidfile)
        } else if self.confined {
            crate::sandbox::command(command, &self.workdir)?
        } else {
            let mut plain = tokio::process::Command::new("sh");
            plain.arg("-c").arg(command);
            plain
        };
        let id = crate::procs::start(command, child, &self.workdir, stopper)?;
        Ok(format!(
            "started background process {id}; read its output with process {{\"action\": \"output\", \"id\": {id}}}, stop it with action stop"
        ))
    }

    async fn terminal(&self, command: &str) -> Result<String, String> {
        if crate::procs::stopping() {
            return Err("the agent is stopping; nothing new starts".to_owned());
        }
        // A session of its own (no terminal: a password prompt fails at once instead of
        // waiting on one it cannot read), and so a group that is stopped with it.
        let mut child = detached(self.shell_command(command).await?);
        let mut child = child
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .kill_on_drop(true)
            .spawn()
            .map_err(|e| format!("sh: {e}"))?;
        // Stopped (a timeout, or the turn dropped while it runs): what it started goes too.
        let mut tree = Group::new(child.id());
        let mut stdout = child.stdout.take().expect("piped");
        let mut stderr = child.stderr.take().expect("piped");
        // Only the start and the end of what it prints are kept (the model gets no more), so a
        // command that prints gigabytes takes no more memory than one that prints a page.
        let (mut out, mut err) = (Capture::new(self.limit), Capture::new(self.limit));
        let deadline = tokio::time::Instant::now() + self.timeout;
        let status = {
            let mut reads = std::pin::pin!(async {
                tokio::join!(out.pump(&mut stdout), err.pump(&mut stderr));
            });
            let mut read = false;
            let status = loop {
                tokio::select! {
                    () = &mut reads, if !read => read = true,
                    status = child.wait() => {
                        // Reaped: its number may be given to another process from now on.
                        tree.reaped();
                        break Some(status.map_err(|e| e.to_string())?);
                    }
                    () = tokio::time::sleep_until(deadline) => break None,
                }
            };
            // Done, but something it started still holds its output open (`server &`): what is
            // there already, without waiting for that to end.
            if status.is_some() && !read {
                let grace = deadline.min(tokio::time::Instant::now() + Duration::from_millis(500));
                let _ = tokio::time::timeout_at(grace, &mut reads).await;
            }
            status
        };
        let mut text = out.text();
        let err = err.text();
        if !err.is_empty() {
            text.push_str(&err);
        }
        let end = if text.is_empty() || text.ends_with('\n') { "" } else { "\n" };
        match status {
            None => {
                tree.kill();
                // What it printed before it was stopped: often where it hung.
                if text.is_empty() {
                    return Err(format!("stopped after {} seconds", self.timeout.as_secs()));
                }
                Ok(format!(
                    "{text}{end}[stopped after {} seconds; for something that keeps running, use background: true]",
                    self.timeout.as_secs()
                ))
            }
            Some(status) => {
                let code = status.code().map_or("killed by a signal".to_owned(), |c| format!("exit code {c}"));
                Ok(format!("{text}{end}[{code}]"))
            }
        }
    }

    /// What runs [command] (`sh -c`) where commands run: here (sandboxed when confined), in the
    /// container, or on the SSH machine; stopped there after the timeout.
    pub async fn shell_command(&self, command: &str) -> Result<tokio::process::Command, String> {
        if self.ssh.is_none() {
            tokio::fs::create_dir_all(&self.workdir).await.map_err(|e| format!("{}: {e}", self.workdir.display()))?;
        }
        let mut child = if let Some(ssh) = &self.ssh {
            ssh.command(command, &self.workdir, Some(self.timeout.as_secs()))
        } else if let Some(docker) = &self.docker {
            let name = docker.ensure(&self.workdir).await?;
            docker.command(&name, command, &self.workdir, Some(self.timeout.as_secs()))
        } else if self.confined {
            crate::sandbox::command(command, &self.workdir)?
        } else {
            let mut plain = tokio::process::Command::new("sh");
            plain.arg("-c").arg(command);
            plain
        };
        if self.ssh.is_none() {
            child.current_dir(&self.workdir);
        }
        Ok(child)
    }

    /// What a write or an edit would change, as a unified diff (paths relative to the working
    /// directory); None for other calls, or an edit that would fail.
    pub fn preview(&self, call: &Call) -> Option<String> {
        // The owner's profile and skills: what changes, before it does.
        match (call, self.home.as_deref()) {
            (Call::UpdateProfile(change), Some(home)) => return crate::profile::preview(home, change),
            (Call::ImproveSkill { name, description, body, edit }, Some(home)) => {
                let edit = edit.as_ref().map(|(o, n)| (o.as_str(), n.as_str()));
                let (before, after) =
                    crate::skills::improved(home, name, description.as_deref(), body.as_deref(), edit).ok()?;
                let after = after.replacen("proposed: improvement\n", "", 1);
                return Some(crate::diff::unified(&before, &after, &format!("skills/{name}/SKILL.md (proposed)")));
            }
            _ => {}
        }
        let (path, before, after) = self.change(call)?;
        Some(self.diff(&path, &before, &after))
    }

    /// [before] to [after] of [path] as a unified diff, the path relative to the working
    /// directory.
    pub fn diff(&self, path: &Path, before: &str, after: &str) -> String {
        let label = path.strip_prefix(&self.workdir).unwrap_or(path).display().to_string();
        crate::diff::unified(before, after, &label)
    }

    /// [Tools::change], from the file as the write or edit will find it: through [Files] (an
    /// editor's buffer, unsaved changes included) when they are set, else as [Tools::change]
    /// reads it.
    pub async fn change_now(&self, call: &Call) -> Option<(PathBuf, String, String)> {
        let Some(files) = &self.files else { return self.change(call) };
        let (path, now) = match call {
            Call::WriteFile { path, .. } | Call::EditFile { path, .. } => (path, files.read(path).await),
            _ => return None,
        };
        let text = match now {
            Some(Ok(text)) => text,
            // A new file, for a write; an edit there would fail.
            Some(Err(_)) if matches!(call, Call::WriteFile { .. }) => String::new(),
            Some(Err(_)) => return None,
            None => return self.change(call),
        };
        match call {
            Call::WriteFile { content, .. } => Some((path.clone(), text, content.clone())),
            Call::EditFile { old, new, all, .. } => {
                let (after, _, _) = crate::edit::apply(&text, old, new, *all).ok().filter(|_| !old.is_empty())?;
                Some((path.clone(), text, after))
            }
            _ => None,
        }
    }

    /// The file a write or an edit changes and its bytes now (None: it does not exist), to put
    /// it back on undo; nothing when it cannot be read (then there is no undo for it).
    pub fn before(&self, call: &Call) -> Option<(PathBuf, Option<Vec<u8>>)> {
        // Undo puts files back here; files on another machine have no undo.
        if self.ssh.is_some() {
            return None;
        }
        match call {
            Call::WriteFile { path, .. } | Call::EditFile { path, .. } => match std::fs::read(path) {
                Ok(bytes) => Some((path.clone(), Some(bytes))),
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => Some((path.clone(), None)),
                Err(_) => None,
            },
            _ => None,
        }
    }

    /// The project's instructions for agents ([crate::context]): the working directory's
    /// `AGENTS.md`, `CLAUDE.md`, `HERMES.md` …, and its repository's above it; with their names, at
    /// most 24 KiB in all. None on another machine (they are read there by the agent itself).
    pub fn project_notes(&self) -> Option<String> {
        if self.ssh.is_some() {
            return None;
        }
        crate::context::prompt(&self.context_files())
    }

    /// The context files the start takes ([crate::context::project]).
    pub fn context_files(&self) -> Vec<crate::context::File> {
        if self.ssh.is_some() {
            return Vec::new();
        }
        crate::context::project(&self.workdir)
    }

    /// The nested context files [call] reaches that [session] has not had, as they go with its
    /// result ([crate::context::nested]); empty for other calls.
    pub fn nested_notes(&self, call: &Call, session: &str) -> String {
        let path = match call {
            Call::ReadFile { path, .. }
            | Call::WriteFile { path, .. }
            | Call::EditFile { path, .. }
            | Call::ListDir { path }
            | Call::Search { path, .. }
            | Call::FindFiles { path, .. } => path,
            _ => return String::new(),
        };
        if self.ssh.is_some() || !path.starts_with(&self.workdir) {
            return String::new();
        }
        let store = self.home.as_ref().map(|h| h.join("sessions"));
        crate::context::hint(&crate::context::nested(&self.workdir, path, store.as_deref(), session))
    }

    /// The git branch, when the working directory is a repository.
    pub fn git_branch(&self) -> Option<String> {
        let head = std::fs::read_to_string(self.workdir.join(".git/HEAD")).ok()?;
        Some(head.trim().strip_prefix("ref: refs/heads/").unwrap_or("(detached)").to_owned())
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
    if let Some(s) = schedules.schedules.iter_mut().find(|s| s.id == id) {
        if let Some(name) = name {
            s.name = Some(name.trim().chars().take(120).collect());
        }
        s.discord = turn.discord_channel.clone();
        // Elsewhere than Telegram and Discord, the answer goes back by address.
        if turn.telegram_chat.is_none()
            && turn.discord_channel.is_none()
            && let Some(to) = &turn.reply_to
        {
            s.to = vec![to.clone()];
        }
    }
    schedules.save(home)?;
    let s = schedules.schedules.iter().find(|s| s.id == id).ok_or("lost the schedule")?;
    let next = crate::cron::When::parse(&s.when)
        .ok()
        .and_then(|w| w.next(None, crate::cron::local(s.created), chrono::Local::now()))
        .map_or("-".to_owned(), |t| t.format("%a %Y-%m-%d %H:%M").to_string());
    let reply = if turn.telegram_chat.is_some() || turn.discord_channel.is_some() || turn.reply_to.is_some() {
        "; its answer comes to this chat"
    } else {
        ""
    };
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

/// The file tools through [files], where it takes them; None for the rest.
async fn through(files: &dyn Files, call: &Call) -> Option<Result<String, String>> {
    match call {
        Call::ReadFile { path, offset, limit } => {
            Some(files.read(path).await?.map(|text| lines(&text, *offset, *limit)))
        }
        Call::WriteFile { path, content } => Some(
            files.write(path, content).await?.map(|()| format!("wrote {} bytes to {}", content.len(), path.display())),
        ),
        Call::EditFile { path, old, new, all } => {
            let before = match files.read(path).await? {
                Ok(before) => before,
                Err(e) => return Some(Err(e)),
            };
            let (after, said) = match edited_off(before, old, new, *all, path).await {
                Ok(done) => done,
                Err(e) => return Some(Err(e)),
            };
            Some(files.write(path, &after).await?.map(|()| said))
        }
        _ => None,
    }
}

async fn read(path: &Path) -> Result<String, String> {
    let bytes = tokio::fs::read(path).await.map_err(|e| format!("{}: {e}", path.display()))?;
    if bytes.iter().take(8192).any(|b| *b == 0) {
        return Err(format!("{} is not a text file ({} bytes)", path.display(), bytes.len()));
    }
    Ok(String::from_utf8_lossy(&bytes).into_owned())
}

/// Tool arguments a model got slightly wrong, read as it meant them: inside a code fence or
/// with words around the object, raw line breaks and tabs inside strings, a trailing comma.
/// None when that does not make them JSON either.
pub fn repair_json(text: &str) -> Option<Value> {
    let (start, end) = (text.find('{')?, text.rfind('}')?);
    if start >= end {
        return None;
    }
    let text = &text[start..=end];
    let mut out = String::with_capacity(text.len() + 16);
    let (mut in_string, mut escaped) = (false, false);
    let chars: Vec<char> = text.chars().collect();
    // The next character that is not a space, after each one.
    let mut next = vec![None; chars.len()];
    for i in (0..chars.len().saturating_sub(1)).rev() {
        next[i] = if chars[i + 1].is_whitespace() { next[i + 1] } else { Some(chars[i + 1]) };
    }
    for (i, &c) in chars.iter().enumerate() {
        if in_string {
            match c {
                _ if escaped => {
                    escaped = false;
                    out.push(c);
                }
                '\\' => {
                    escaped = true;
                    out.push(c);
                }
                '"' => {
                    in_string = false;
                    out.push(c);
                }
                '\n' => out.push_str("\\n"),
                '\r' => out.push_str("\\r"),
                '\t' => out.push_str("\\t"),
                c if (c as u32) < 0x20 => out.push_str(&format!("\\u{:04x}", c as u32)),
                c => out.push(c),
            }
            continue;
        }
        match c {
            '"' => {
                in_string = true;
                out.push(c);
            }
            // A comma with nothing after it but the end of the object or list.
            ',' if matches!(next[i], Some('}' | ']')) => {}
            c => out.push(c),
        }
    }
    serde_json::from_str::<Value>(&out).ok().filter(Value::is_object)
}

/// Files larger than this are not read whole by `read_file` (a log of gigabytes).
const LARGE_FILE: u64 = 16 * 1024 * 1024;

/// `read_file`: the file's text, or lines [offset].. of it ([limit] of them). A large file is
/// never held whole: without lines asked for, its start and its end ([keep] bytes in all);
/// with them, read line by line.
async fn read_lines(path: &Path, offset: Option<usize>, limit: Option<usize>, keep: usize) -> Result<String, String> {
    let size = tokio::fs::metadata(path).await.map(|m| m.len()).unwrap_or(0);
    if size <= LARGE_FILE {
        return read(path).await.map(|text| lines(&text, offset, limit));
    }
    use tokio::io::AsyncSeekExt;
    let shown = |e: std::io::Error| format!("{}: {e}", path.display());
    let mut file = tokio::fs::File::open(path).await.map_err(shown)?;
    let mut head = vec![0u8; 8192.min(size as usize)];
    file.read_exact(&mut head).await.map_err(shown)?;
    if head.contains(&0) {
        return Err(format!("{} is not a text file ({size} bytes)", path.display()));
    }
    file.seek(std::io::SeekFrom::Start(0)).await.map_err(shown)?;
    if offset.is_none() && limit.is_none() {
        let half = (keep / 2) as u64;
        let mut start = vec![0u8; half as usize];
        file.read_exact(&mut start).await.map_err(shown)?;
        file.seek(std::io::SeekFrom::Start(size - half)).await.map_err(shown)?;
        let mut end = vec![0u8; half as usize];
        file.read_exact(&mut end).await.map_err(shown)?;
        return Ok(format!(
            "{}\n[… {} bytes cut: the file is {size} bytes; read the part you need with offset and limit (lines), or search it …]\n{}",
            String::from_utf8_lossy(&start),
            size - 2 * half,
            String::from_utf8_lossy(&end)
        ));
    }
    let first = offset.unwrap_or(1).max(1);
    let wanted = limit.unwrap_or(usize::MAX);
    let mut reader = tokio::io::BufReader::new(file);
    let (mut line, mut n, mut out, mut taken) = (Vec::new(), 0usize, String::new(), 0usize);
    let mut ended = false;
    loop {
        // Enough: the lines asked for, or as much text as a result takes.
        if taken >= wanted || out.len() >= keep {
            break;
        }
        let Some(cut) = next_line(&mut reader, &mut line, LONG_LINE).await.map_err(shown)? else {
            ended = true;
            break;
        };
        n += 1;
        if n >= first {
            if taken > 0 {
                out.push('\n');
            }
            out.push_str(String::from_utf8_lossy(&line).trim_end_matches(['\n', '\r']));
            if cut {
                out.push_str(" [… line cut]");
            }
            taken += 1;
        }
    }
    let start = first.min(n + 1);
    // Counting the rest would mean reading the whole file: only said when it was read anyway.
    let of = if ended { format!("{n}") } else { format!("more than {n}") };
    out.push_str(&format!("\n[lines {start}-{} of {of}]", (start + taken).saturating_sub(1)));
    Ok(out)
}

/// Most of one line `read_file` keeps from a large file (minified code, a log line of
/// megabytes): the rest of it is skipped, not held.
const LONG_LINE: usize = 8 * 1024;

/// The next line of [reader] into [line] (at most [cap] bytes of it, the rest skipped to its
/// end): whether it was cut; None at the end.
async fn next_line(
    reader: &mut (impl tokio::io::AsyncBufRead + Unpin),
    line: &mut Vec<u8>,
    cap: usize,
) -> std::io::Result<Option<bool>> {
    use tokio::io::AsyncBufReadExt;
    line.clear();
    let (mut any, mut cut) = (false, false);
    loop {
        let buffer = reader.fill_buf().await?;
        if buffer.is_empty() {
            return Ok(any.then_some(cut));
        }
        any = true;
        let (used, done) = match buffer.iter().position(|b| *b == b'\n') {
            Some(i) => (i + 1, true),
            None => (buffer.len(), false),
        };
        let room = cap.saturating_sub(line.len());
        if room < used {
            cut = true;
        }
        line.extend_from_slice(&buffer[..used.min(room)]);
        reader.consume(used);
        if done {
            return Ok(Some(cut));
        }
    }
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

/// [text] with [old] replaced by [new]: exactly once unless [all] (whitespace the model got
/// wrong forgiven where that finds one place, [crate::edit]); and what to tell the model.
fn edited(text: &str, old: &str, new: &str, all: bool, path: &Path) -> Result<(String, String), String> {
    if old.is_empty() {
        return Err("old_text is empty".to_owned());
    }
    match crate::edit::apply(text, old, new, all) {
        Ok((after, found, loose)) => {
            let n = if found == 1 { "1 occurrence".to_owned() } else { format!("{found} occurrences") };
            let how = loose.map(|l| format!(" ({})", l.describe())).unwrap_or_default();
            Ok((after, format!("replaced {n} in {}{how}", path.display())))
        }
        Err(0) => {
            let mut why =
                format!("old_text is not in {} (copy it exactly, spaces and line breaks included)", path.display());
            match crate::edit::closest(text, old) {
                Some((line, shown)) => {
                    why.push_str(&format!("; the closest is at line {line}, as it is in the file now:\n{shown}"))
                }
                None => why.push_str("; read_file shows the file"),
            }
            Err(why)
        }
        Err(crate::edit::NO_CHANGE) => Err(format!(
            "the edit changes nothing in {} (new_text is what is there already); nothing was written",
            path.display()
        )),
        Err(n) => Err(format!(
            "old_text is in {} {n} times; include more lines around it so it is unique, or set replace_all",
            path.display()
        )),
    }
}

/// [edited], off the async workers (a large file, and the search for the closest lines on a
/// miss, take a while).
async fn edited_off(text: String, old: &str, new: &str, all: bool, path: &Path) -> Result<(String, String), String> {
    let (old, new, path) = (old.to_owned(), new.to_owned(), path.to_owned());
    tokio::task::spawn_blocking(move || edited(&text, &old, &new, all, &path)).await.map_err(|e| e.to_string())?
}

/// Replaces [old] with [new] in the file at [path]: exactly once unless [all].
async fn edit(path: &Path, old: &str, new: &str, all: bool) -> Result<String, String> {
    if old.is_empty() {
        return Err("old_text is empty".to_owned());
    }
    let text = read(path).await?;
    let (changed, said) = edited_off(text, old, new, all, path).await?;
    write(path, &changed).await?;
    Ok(said)
}

/// Lines [offset].. of [text] ([limit] of them), with a note of where the rest is.
fn lines(text: &str, offset: Option<usize>, limit: Option<usize>) -> String {
    if offset.is_none() && limit.is_none() {
        return text.to_owned();
    }
    let all: Vec<&str> = text.lines().collect();
    let start = offset.unwrap_or(1).saturating_sub(1).min(all.len());
    let end = limit.map_or(all.len(), |n| start.saturating_add(n).min(all.len()));
    let mut out = all[start..end].join("\n");
    if start > 0 || end < all.len() {
        out.push_str(&format!("\n[lines {}-{end} of {}]", start + 1, all.len()));
    }
    out
}

/// The task list as the owner and the model see it.
fn todo(items: &Value) -> Result<String, String> {
    let items = items.as_array().ok_or("`items` is a list")?;
    let mut out = String::new();
    for item in items {
        let text = item["text"].as_str().unwrap_or_default();
        let mark = match item["status"].as_str() {
            Some("done") => "[x]",
            Some("doing") => "[>]",
            _ => "[ ]",
        };
        out.push_str(&format!("{mark} {text}\n"));
    }
    let done = items.iter().filter(|i| i["status"] == "done").count();
    out.push_str(&format!("({done} of {} done)", items.len()));
    Ok(out)
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

/// What a command prints, as it comes: its first [Capture::keep] bytes and its last, and how
/// many there were in all.
struct Capture {
    keep: usize,
    head: Vec<u8>,
    tail: Vec<u8>,
    total: usize,
}

impl Capture {
    fn new(keep: usize) -> Self {
        Self { keep, head: Vec::new(), tail: Vec::new(), total: 0 }
    }

    fn take(&mut self, mut bytes: &[u8]) {
        self.total += bytes.len();
        let room = self.keep.saturating_sub(self.head.len());
        if room > 0 {
            let n = room.min(bytes.len());
            self.head.extend_from_slice(&bytes[..n]);
            bytes = &bytes[n..];
        }
        self.tail.extend_from_slice(bytes);
        // Trimmed now and then, not at every read.
        if self.tail.len() > 2 * self.keep {
            self.tail.drain(..self.tail.len() - self.keep);
        }
    }

    /// Reads [from] to its end.
    async fn pump(&mut self, from: &mut (impl tokio::io::AsyncRead + Unpin)) {
        let mut buffer = vec![0u8; 64 * 1024];
        while let Ok(n @ 1..) = from.read(&mut buffer).await {
            self.take(&buffer[..n]);
        }
    }

    /// What was kept, as text: whole when it all was, else its start and its end with how much
    /// is not there.
    fn text(mut self) -> String {
        if self.tail.len() > self.keep {
            self.tail.drain(..self.tail.len() - self.keep);
        }
        let dropped = self.total - self.head.len() - self.tail.len();
        let mut text = String::from_utf8_lossy(&self.head).into_owned();
        if dropped > 0 {
            text.push_str(&format!("\n[… {dropped} bytes cut …]\n"));
        }
        text.push_str(&String::from_utf8_lossy(&self.tail));
        text
    }
}

/// [command], to start in a session of its own: no controlling terminal (opening `/dev/tty`
/// fails, so `sudo` or `ssh` asking for a password stop with an error rather than wait until
/// the timeout), and its own process group, numbered as it is. Through `perl` (POSIX `setsid`,
/// then the command in its place: the same process), which macOS and Linux have; without it,
/// only a group of its own.
fn detached(command: tokio::process::Command) -> tokio::process::Command {
    static PERL: std::sync::OnceLock<Option<PathBuf>> = std::sync::OnceLock::new();
    let Some(perl) = PERL.get_or_init(|| crate::find_on_path("perl")) else {
        let mut command = command;
        #[cfg(unix)]
        command.process_group(0);
        return command;
    };
    let std = command.as_std();
    let mut wrapped = tokio::process::Command::new(perl);
    wrapped
        .arg("-e")
        .arg("use POSIX (); POSIX::setsid(); exec { $ARGV[0] } @ARGV or die \"$ARGV[0]: $!\\n\";")
        .arg(std.get_program())
        .args(std.get_args());
    for (key, value) in std.get_envs() {
        match value {
            Some(value) => wrapped.env(key, value),
            None => wrapped.env_remove(key),
        };
    }
    if let Some(dir) = std.get_current_dir() {
        wrapped.current_dir(dir);
    }
    wrapped
}

/// The process groups of the commands running now, to stop them when the agent is killed
/// ([stop_running]).
static RUNNING: std::sync::Mutex<Vec<u32>> = std::sync::Mutex::new(Vec::new());

/// Stops every command a tool is running (the agent is going: a signal, the end of a run),
/// with what they started.
pub fn stop_running() {
    let groups = std::mem::take(&mut *RUNNING.lock().unwrap_or_else(std::sync::PoisonError::into_inner));
    for pid in groups {
        if let Some(pid) = rustix::process::Pid::from_raw(pid as i32) {
            let _ = rustix::process::kill_process_group(pid, rustix::process::Signal::KILL);
        }
    }
}

/// How many commands a tool is running now.
pub fn running_commands() -> usize {
    RUNNING.lock().map_or(0, |r| r.len())
}

/// A command's process group (it and what it started), killed together by [Group::kill] or
/// when dropped (the turn stopped while it ran); `None` once the command was reaped.
struct Group(Option<u32>);

impl Group {
    fn new(pid: Option<u32>) -> Self {
        if let (Some(pid), Ok(mut running)) = (pid, RUNNING.lock()) {
            running.push(pid);
        }
        let mut group = Self(pid);
        // Started as the agent began to stop (after its sweep, maybe): stopped now.
        if crate::procs::stopping() {
            group.kill();
        }
        group
    }

    fn forget(pid: u32) {
        if let Ok(mut running) = RUNNING.lock() {
            running.retain(|p| *p != pid);
        }
    }

    /// The command was reaped: its number may go to another process from now on.
    fn reaped(&mut self) {
        if let Some(pid) = self.0.take() {
            Self::forget(pid);
        }
    }

    fn kill(&mut self) {
        let Some(pid) = self.0.take() else { return };
        Self::forget(pid);
        if let Some(pid) = rustix::process::Pid::from_raw(pid as i32) {
            let _ = rustix::process::kill_process_group(pid, rustix::process::Signal::KILL);
        }
    }
}

impl Drop for Group {
    fn drop(&mut self) {
        self.kill();
    }
}

/// Keeps the start and the end of a long result: errors tend to be at the end.
pub fn cut(text: String) -> String {
    cut_to(text, RESULT_LIMIT)
}

/// [cut] to [limit] bytes.
pub fn cut_to(text: String, limit: usize) -> String {
    if text.len() <= limit {
        return text;
    }
    let half = limit / 2;
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
        // A command's timeout is not what these tests test (those that do set their own): a
        // generous one, so a loaded machine does not cut a command short.
        (Tools::new(dir.clone(), Duration::from_secs(60)), dir)
    }

    /// Unique per call: tests run in parallel and must not share a directory.
    fn rand() -> u64 {
        static NEXT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
        let n = NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        (std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().subsec_nanos() as u64) << 16 | n
    }

    #[test]
    fn long_files_read_in_parts_and_todos_list() {
        let text = "a\nb\nc\nd";
        assert_eq!(super::lines(text, None, None), text);
        assert_eq!(super::lines(text, Some(2), Some(2)), "b\nc\n[lines 2-3 of 4]");
        assert_eq!(super::lines(text, Some(4), None), "d\n[lines 4-4 of 4]");
        let items = serde_json::json!([{ "text": "read", "status": "done" }, { "text": "fix", "status": "doing" }, { "text": "test", "status": "pending" }]);
        assert_eq!(super::todo(&items).unwrap(), "[x] read\n[>] fix\n[ ] test\n(1 of 3 done)");
        let (tools, _) = tools();
        assert_eq!(tools.clone().with_context(48).limit, RESULT_LIMIT);
        assert_eq!(tools.with_context(1000).limit, 96 * 1024);
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
    async fn unattended_commands_write_only_in_the_working_directory() {
        let (tools, dir) = tools();
        let outside = std::env::var("HOME")
            .map(std::path::PathBuf::from)
            .unwrap()
            .join(format!(".autobot-sandbox-test-{}", rand()));
        let confined = tools.clone().with_sandbox(crate::sandbox::Mode::Unattended).unattended();
        assert_eq!(confined.confinement(), crate::sandbox::name());
        assert_eq!(tools.clone().with_sandbox(crate::sandbox::Mode::Off).unattended().confinement(), "off");
        let command = format!("echo in > inside.txt; echo out > '{}'; echo done", outside.display());
        let out = confined.run(&Call::Terminal { command: command.clone() }).await;
        if out.contains("bwrap") {
            // No usable sandbox here (not installed, or user namespaces disallowed): refused or
            // failed, never run unconfined.
            assert!(!dir.join("inside.txt").exists());
            return;
        }
        assert_eq!(std::fs::read_to_string(dir.join("inside.txt")).unwrap(), "in\n", "{out}");
        assert!(!outside.exists(), "a confined command wrote outside: {out}");
        assert!(out.contains("done"), "{out}");
        // Interactive turns are not confined unless the sandbox is \"always\".
        let plain = tools.with_sandbox(crate::sandbox::Mode::Unattended);
        assert_eq!(plain.confinement(), "off");
        let out = plain.run(&Call::Terminal { command }).await;
        assert!(outside.exists(), "{out}");
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

    /// A command that timed out is stopped with what it started: nothing is left running, and
    /// the call ends at its timeout even when a child holds the output open.
    #[tokio::test]
    async fn a_timed_out_command_is_stopped_with_its_children() {
        let (_, dir) = tools();
        let pid = dir.join("pid");
        // Time enough for the shell to start its child on a loaded machine.
        let tools = Tools::new(dir.clone(), Duration::from_secs(5));
        let command = format!("sleep 300 & echo $! > {}; wait", pid.display());
        let started = std::time::Instant::now();
        let out = tools.run(&Call::Terminal { command }).await;
        assert!(out.contains("stopped after"), "{out}");
        assert!(started.elapsed() < Duration::from_secs(120), "waited for the child");
        let pid = std::fs::read_to_string(&pid).unwrap();
        // Gone within a while: polled, since a killed process not yet reaped (a zombie) still
        // answers kill -0 for a moment.
        let until = std::time::Instant::now() + Duration::from_secs(10);
        while running(pid.trim()) {
            assert!(std::time::Instant::now() < until, "the command's child {} is still running", pid.trim());
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
    }

    /// Whether [pid] is a live process (not a zombie).
    fn running(pid: &str) -> bool {
        let out = std::process::Command::new("ps").args(["-o", "stat=", "-p", pid]).output().unwrap();
        let state = String::from_utf8_lossy(&out.stdout);
        let state = state.trim();
        !state.is_empty() && !state.starts_with('Z')
    }

    /// A command that prints without end is kept to what the model gets (its start and its
    /// end), not to the agent's memory: the end of a long build log is still there.
    #[tokio::test]
    async fn terminal_output_is_capped() {
        let (_, dir) = tools();
        let tools = Tools::new(dir, Duration::from_secs(600));
        let out = tools
            .run(&Call::Terminal { command: "head -c 6000000 /dev/zero | tr '\\0' x; echo; echo done >&2".into() })
            .await;
        let end: String = out.chars().rev().take(200).collect::<Vec<_>>().into_iter().rev().collect();
        assert!(out.len() <= 4 * tools.limit + 1024, "{} bytes for a limit of {}: {end}", out.len(), tools.limit);
        assert!(end.contains("done") && out.ends_with("[exit code 0]"), "{end}");
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
    fn an_edit_that_changes_nothing_says_so() {
        let path = std::path::Path::new("a.txt");
        let e = super::edited("foo \nbar\n", "foo\nbar", "foo \nbar", false, path).unwrap_err();
        assert!(e.starts_with("the edit changes nothing in a.txt"), "{e}");
        let e = super::edited("x = 1\n", "x = 1", "x = 1", false, path).unwrap_err();
        assert!(e.starts_with("the edit changes nothing"), "{e}");
        assert!(super::edited("x = 1\n", "y", "z", false, path).unwrap_err().starts_with("old_text is not in"));
    }

    #[tokio::test]
    async fn a_huge_file_is_read_in_parts_without_holding_a_huge_line() {
        let (_, dir) = tools();
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("big.log");
        let mut text = "x".repeat(20 * 1024 * 1024);
        text.push_str("\nsecond\nthird\n");
        std::fs::write(&path, &text).unwrap();
        let part = super::read_lines(&path, Some(2), Some(1), RESULT_LIMIT).await.unwrap();
        assert_eq!(part, "second\n[lines 2-2 of more than 2]");
        let first = super::read_lines(&path, Some(1), Some(1), RESULT_LIMIT).await.unwrap();
        assert!(first.len() < 9 * 1024 && first.contains("[… line cut]"), "{}", first.len());
        let all = super::read_lines(&path, Some(2), None, RESULT_LIMIT).await.unwrap();
        assert_eq!(all, "second\nthird\n[lines 2-3 of 3]");
        let whole = super::read_lines(&path, None, None, RESULT_LIMIT).await.unwrap();
        assert!(whole.len() < RESULT_LIMIT + 300 && whole.contains("bytes cut"));
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn long_results_keep_both_ends() {
        let text = format!("start{}end", "é".repeat(RESULT_LIMIT));
        let cut = cut(text);
        assert!(cut.starts_with("start") && cut.ends_with("end") && cut.contains("bytes cut"));
        assert!(cut.len() < RESULT_LIMIT + 100);
    }
}
