//! `autobot acp`: the agent for an editor, over the Agent Client Protocol
//! (<https://agentclientprotocol.com>, version 1): JSON-RPC 2.0 on stdin and stdout, one message
//! per line. Zed (and any ACP client) starts it, opens sessions in a project, sends prompts and
//! shows what comes back: the answer as it streams, its reasoning, each tool call with its diff
//! or output, the agent's task list as the editor's plan, and the agent's questions as the
//! editor's permission prompts.
//!
//! - A session is an Autobot conversation (`acp-…` in `$AUTOBOT_HOME/sessions`), coding in the
//!   folder the editor names, like `autobot code` there; `session/load` replays one.
//! - Approvals: what the configured mode asks about becomes `session/request_permission`
//!   (allow once, always allow for the session, reject). The modes are the approval modes:
//!   `ask`, `edits`, `allowlist`, `trust` (`session/set_mode`, or the `mode` config option);
//!   the `model` config option picks one of the gateway's models.
//! - Files are read and written through the editor (`fs/read_text_file`, `fs/write_text_file`)
//!   when it offers them, so unsaved buffers are what the agent sees and its edits land in them;
//!   commands run in the editor's terminals (`terminal/*`) when it offers them, shown in the
//!   tool call.
//! - The MCP servers the editor passes (stdio and HTTP) add their tools, beside the agent's own.
//! - Slash commands (`/context`, `/recall …`, `/retry`, the owner's own commands and skills) are
//!   advertised and answered here.
//! - `session/cancel` stops the turn where it is.

use std::collections::{BTreeMap, HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde_json::{Value, json};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt};
use tokio::sync::{mpsc, oneshot};

use crate::agent::{Agent, Event};
use crate::approval::{Action, Answer, Approver};
use crate::config::{ApprovalMode, Config};
use crate::gateway::ModelInfo;
use crate::session::Session;

/// The protocol version spoken here.
pub const PROTOCOL_VERSION: u64 = 1;

/// Most of a tool's output shown in the editor.
const SHOWN: usize = 8 * 1024;

/// JSON-RPC error codes.
const PARSE_ERROR: i64 = -32700;
const INVALID_REQUEST: i64 = -32600;
const NO_METHOD: i64 = -32601;
const INVALID_PARAMS: i64 = -32602;
const INTERNAL: i64 = -32603;

type Failure = (i64, String);

/// The line to the editor: what goes out, and the requests waiting for its answer.
struct Conn {
    out: mpsc::UnboundedSender<String>,
    next: AtomicU64,
    waiting: Mutex<HashMap<u64, oneshot::Sender<Result<Value, String>>>>,
}

impl Conn {
    /// One message, on one line (serialized JSON has no raw line breaks).
    fn send(&self, message: Value) {
        let _ = self.out.send(message.to_string());
    }

    fn notify(&self, method: &str, params: Value) {
        self.send(json!({ "jsonrpc": "2.0", "method": method, "params": params }));
    }

    fn update(&self, session: &str, update: Value) {
        self.notify("session/update", json!({ "sessionId": session, "update": update }));
    }

    fn respond(&self, id: Value, result: Result<Value, Failure>) {
        self.send(match result {
            Ok(result) => json!({ "jsonrpc": "2.0", "id": id, "result": result }),
            Err((code, message)) => {
                json!({ "jsonrpc": "2.0", "id": id, "error": { "code": code, "message": message } })
            }
        });
    }

    /// Asks the editor [method]; its result, or its error's message.
    async fn request(&self, method: &str, params: Value) -> Result<Value, String> {
        // Gone from the waiting list however this ends: answered, or dropped with a cancelled
        // turn (an editor need not answer those).
        struct Waiting<'a>(&'a Conn, u64);
        impl Drop for Waiting<'_> {
            fn drop(&mut self) {
                self.0.waiting.lock().expect("waiting").remove(&self.1);
            }
        }
        let id = self.next.fetch_add(1, Ordering::Relaxed);
        let (tx, rx) = oneshot::channel();
        self.waiting.lock().expect("waiting").insert(id, tx);
        let _waiting = Waiting(self, id);
        self.send(json!({ "jsonrpc": "2.0", "id": id, "method": method, "params": params }));
        rx.await.map_err(|_| "the editor went away".to_owned())?
    }

    /// The editor's answer to one of our requests.
    fn answered(&self, message: &Value) {
        let Some(id) = message["id"].as_u64() else { return };
        let Some(waiter) = self.waiting.lock().expect("waiting").remove(&id) else { return };
        let result = match message.get("error") {
            Some(error) => Err(error["message"].as_str().unwrap_or("the editor refused").to_owned()),
            None => Ok(message.get("result").cloned().unwrap_or(Value::Null)),
        };
        let _ = waiter.send(result);
    }
}

/// The turn running in a session, for the editor's terminals to show themselves in its call.
type Slot = Arc<Mutex<Option<Arc<Mutex<Turn>>>>>;

/// One conversation the editor opened.
struct Open {
    id: String,
    cwd: PathBuf,
    mode: Mutex<ApprovalMode>,
    /// The model picked in the editor (None: the configured one).
    model: Mutex<Option<String>>,
    /// What the gateway served when the session opened.
    models: Vec<ModelInfo>,
    /// The agent's own MCP servers and the editor's.
    hub: Arc<crate::mcp::Hub>,
    agent: Mutex<Arc<Agent>>,
    state: Arc<tokio::sync::Mutex<(Session, HashSet<Action>)>>,
    running: Mutex<Option<tokio::task::AbortHandle>>,
    /// Tool calls shown so far ([Turn::next_id]).
    calls: Arc<AtomicU64>,
    turn: Slot,
    /// What `/recall` found, to go with the next prompt.
    recalled: Mutex<String>,
}

struct Acp {
    conn: Arc<Conn>,
    config: Config,
    home: PathBuf,
    /// What the editor offers: reading and writing its files, its terminals.
    fs_read: AtomicBool,
    fs_write: AtomicBool,
    terminal: AtomicBool,
    sessions: Mutex<HashMap<String, Arc<Open>>>,
}

/// Speaks ACP on [input] and [output] until the input ends, as the agent [config] describes in
/// [home].
pub async fn serve<R, W>(config: Config, home: PathBuf, input: R, mut output: W) -> Result<(), String>
where
    R: tokio::io::AsyncRead + Unpin,
    W: tokio::io::AsyncWrite + Unpin + Send + 'static,
{
    let (tx, mut rx) = mpsc::unbounded_channel::<String>();
    let writer = tokio::spawn(async move {
        while let Some(line) = rx.recv().await {
            let mut bytes = line.into_bytes();
            bytes.push(b'\n');
            if output.write_all(&bytes).await.is_err() || output.flush().await.is_err() {
                return;
            }
        }
    });
    let acp = Arc::new(Acp {
        conn: Arc::new(Conn { out: tx, next: AtomicU64::new(1), waiting: Mutex::default() }),
        config,
        home,
        fs_read: AtomicBool::new(false),
        fs_write: AtomicBool::new(false),
        terminal: AtomicBool::new(false),
        sessions: Mutex::default(),
    });
    let mut lines = tokio::io::BufReader::new(input).lines();
    while let Some(line) = lines.next_line().await.map_err(|e| format!("stdin: {e}"))? {
        if line.trim().is_empty() {
            continue;
        }
        let message: Value = match serde_json::from_str(&line) {
            Ok(message) => message,
            Err(e) => {
                acp.conn.respond(Value::Null, Err((PARSE_ERROR, format!("not JSON: {e}"))));
                continue;
            }
        };
        if !message.is_object() {
            acp.conn.respond(Value::Null, Err((INVALID_REQUEST, "not a JSON-RPC message".to_owned())));
            continue;
        }
        let Some(method) = message["method"].as_str().map(str::to_owned) else {
            // An answer to one of ours.
            acp.conn.answered(&message);
            continue;
        };
        let params = message.get("params").cloned().unwrap_or(Value::Null);
        match message.get("id").cloned() {
            // A request: answered on its own task, so a long prompt does not hold up the rest
            // (a cancel, the editor's answers to our questions).
            Some(id) if !id.is_null() => {
                let acp = acp.clone();
                tokio::spawn(async move {
                    let result = acp.clone().handle(&method, &params).await;
                    // A session the editor now knows: the commands it has.
                    let opened = match (&result, method.as_str()) {
                        (Ok(result), "session/new") => result["sessionId"].as_str().map(str::to_owned),
                        (Ok(_), "session/load") => params["sessionId"].as_str().map(str::to_owned),
                        _ => None,
                    };
                    acp.conn.respond(id, result);
                    if let Some(open) = opened.and_then(|id| acp.open(&id).ok()) {
                        acp.conn.update(
                            &open.id,
                            json!({ "sessionUpdate": "available_commands_update", "availableCommands": acp.commands(&open) }),
                        );
                    }
                });
            }
            _ => acp.notified(&method, &params),
        }
    }
    // The editor closed the line: running turns stop.
    for open in acp.sessions.lock().expect("sessions").values() {
        if let Some(running) = open.running.lock().expect("running").take() {
            running.abort();
        }
    }
    drop(acp);
    let _ = writer.await;
    Ok(())
}

/// The approval modes: id, name, what it does.
const MODES: &[(&str, &str, &str)] = &[
    ("ask", "Ask", "Ask before commands, writes and reads outside the project"),
    ("edits", "Edits", "Changes in the project without asking; ask for the rest"),
    ("allowlist", "Allowlist", "Allowlisted commands and project changes; refuse the rest"),
    ("trust", "Trust", "Everything without asking"),
];

fn mode_name(mode: ApprovalMode) -> &'static str {
    match mode {
        ApprovalMode::Ask => "ask",
        ApprovalMode::Edits => "edits",
        ApprovalMode::Allowlist => "allowlist",
        ApprovalMode::Trust => "trust",
    }
}

fn mode_of(name: &str) -> Result<ApprovalMode, Failure> {
    Ok(match name {
        "ask" => ApprovalMode::Ask,
        "edits" => ApprovalMode::Edits,
        "allowlist" => ApprovalMode::Allowlist,
        "trust" => ApprovalMode::Trust,
        other => return Err((INVALID_PARAMS, format!("no mode {other:?}"))),
    })
}

/// The approval modes, as the editor's session modes.
fn modes(current: ApprovalMode) -> Value {
    let available: Vec<Value> =
        MODES.iter().map(|(id, name, what)| json!({ "id": id, "name": name, "description": what })).collect();
    json!({ "currentModeId": mode_name(current), "availableModes": available })
}

/// The session's settings as config options: the approval mode, and the model when the
/// gateway lists its models.
fn config_options(open: &Open) -> Value {
    let options: Vec<Value> =
        MODES.iter().map(|(id, name, what)| json!({ "value": id, "name": name, "description": what })).collect();
    let mut list = vec![json!({
        "id": "mode", "name": "Approvals", "category": "mode", "type": "select",
        "currentValue": mode_name(*open.mode.lock().expect("mode")), "options": options,
    })];
    if !open.models.is_empty() {
        let current = open.agent.lock().expect("agent").gateway.model().to_owned();
        let mut options: Vec<Value> = open
            .models
            .iter()
            .map(|m| {
                let context = m.context.map(|c| format!(" · {}k context", c / 1000)).unwrap_or_default();
                json!({ "value": m.id, "name": m.id, "description": format!("{}{context}", m.tier) })
            })
            .collect();
        if !open.models.iter().any(|m| m.id == "auto") {
            options.push(json!({ "value": "auto", "name": "auto", "description": "the gateway's router picks" }));
        }
        if !options.iter().any(|o| o["value"] == current.as_str()) {
            options.insert(0, json!({ "value": current, "name": current }));
        }
        list.push(json!({
            "id": "model", "name": "Model", "category": "model", "type": "select",
            "currentValue": current, "options": options,
        }));
    }
    Value::Array(list)
}

fn string<'a>(params: &'a Value, key: &str) -> Result<&'a str, Failure> {
    params[key].as_str().ok_or_else(|| (INVALID_PARAMS, format!("`{key}` is missing")))
}

/// Slash commands the editor offers: name, what it does, what it takes.
const COMMANDS: &[(&str, &str, Option<&str>)] = &[
    ("help", "what these commands do", None),
    ("init", "write or improve the project's AGENTS.md", None),
    ("new", "start the conversation over", None),
    ("retry", "run the last request again, without its answer", None),
    ("compact", "fold the conversation so far into a summary (keeps the last turn)", None),
    ("context", "the files in play and how much each call sends", None),
    ("usage", "tokens, time and cost: this conversation and today", None),
    ("status", "model, approvals, session, MCP servers", None),
    ("recall", "what earlier conversations said about something", Some("what to look for")),
    ("memory", "what the agent remembered", None),
    ("skills", "the skills it has (run one with /<skill>)", None),
];

/// What a slash command does.
enum Command {
    /// Answered here, with this text.
    Reply(String),
    /// A request to run as a turn.
    Send(String, Vec<crate::images::Attachment>),
}

/// `label: value` lines, for the editor.
fn rows(rows: &[(String, String)]) -> String {
    rows.iter().map(|(label, value)| format!("- {label}: {value}\n")).collect()
}

/// [name] as an MCP server name: letters, digits, - and _ (no `__`), at most 32.
fn server_name(name: &str) -> String {
    let mut out = String::new();
    for c in name.chars() {
        let c = if c.is_ascii_alphanumeric() || c == '-' { c } else { '_' };
        if !(c == '_' && out.ends_with('_')) {
            out.push(c);
        }
    }
    let out: String = out.trim_matches('_').chars().take(32).collect();
    if out.is_empty() { "server".to_owned() } else { out }
}

/// The agent's own MCP servers, and those the editor passes in `mcpServers` (stdio, HTTP; one
/// it cannot use is left out, with why in the log).
fn mcp_servers(
    own: &BTreeMap<String, crate::mcp::ServerConfig>,
    given: &Value,
) -> BTreeMap<String, crate::mcp::ServerConfig> {
    let mut servers = own.clone();
    for server in given.as_array().into_iter().flatten() {
        let pairs = |key: &str| -> BTreeMap<String, String> {
            server[key]
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(|p| Some((p["name"].as_str()?.to_owned(), p["value"].as_str()?.to_owned())))
                .collect()
        };
        let label = server["name"].as_str().unwrap_or("server");
        let config = match server["type"].as_str() {
            Some("http") => crate::mcp::ServerConfig {
                url: server["url"].as_str().map(str::to_owned),
                headers: pairs("headers"),
                ..Default::default()
            },
            None | Some("stdio") => crate::mcp::ServerConfig {
                command: server["command"].as_str().unwrap_or_default().to_owned(),
                args: server["args"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .filter_map(|a| a.as_str().map(str::to_owned))
                    .collect(),
                env: pairs("env"),
                ..Default::default()
            },
            Some(other) => {
                tracing::warn!("MCP server {label}: the {other} transport is not taken here");
                continue;
            }
        };
        // Its own name, beside the agent's.
        let base = server_name(label);
        let mut name = base.clone();
        let mut n = 2;
        while servers.contains_key(&name) {
            name = format!("{}-{n}", base.chars().take(29).collect::<String>());
            n += 1;
        }
        if let Err(e) = crate::mcp::Hub::new(BTreeMap::from([(name.clone(), config.clone())])) {
            tracing::warn!("MCP server {label}: {e}");
            continue;
        }
        servers.insert(name, config);
    }
    servers
}

impl Acp {
    async fn handle(self: Arc<Self>, method: &str, params: &Value) -> Result<Value, Failure> {
        match method {
            "initialize" => Ok(self.initialize(params)),
            "authenticate" => Ok(json!({})),
            "session/new" => self.new_session(params).await,
            "session/load" => self.load_session(params).await,
            "session/prompt" => self.prompt(params).await,
            "session/set_mode" => {
                let open = self.open(string(params, "sessionId")?)?;
                self.reconfigure(&open, Some(mode_of(string(params, "modeId")?)?), None)?;
                Ok(json!({}))
            }
            "session/set_config_option" => {
                let open = self.open(string(params, "sessionId")?)?;
                let value = string(params, "value")?;
                match string(params, "configId")? {
                    "mode" => self.reconfigure(&open, Some(mode_of(value)?), None)?,
                    "model" if !open.models.is_empty() => self.reconfigure(&open, None, Some(value))?,
                    other => return Err((INVALID_PARAMS, format!("no config option {other:?}"))),
                }
                Ok(json!({ "configOptions": config_options(&open) }))
            }
            "session/cancel" => {
                self.notified(method, params);
                Ok(Value::Null)
            }
            _ => Err((NO_METHOD, format!("no method {method}"))),
        }
    }

    fn notified(&self, method: &str, params: &Value) {
        // Stopped, and still registered until its prompt has answered: no second prompt starts
        // in between.
        if method == "session/cancel"
            && let Some(open) = params["sessionId"].as_str().and_then(|id| self.open(id).ok())
            && let Some(running) = open.running.lock().expect("running").as_ref()
        {
            running.abort();
        }
    }

    /// Whether audio in a prompt can become text here ([crate::voice]).
    fn hears(&self) -> bool {
        crate::voice::available(&self.config.voice, &self.home)
    }

    fn initialize(&self, params: &Value) -> Value {
        let client = &params["clientCapabilities"];
        self.fs_read.store(client["fs"]["readTextFile"] == true, Ordering::Relaxed);
        self.fs_write.store(client["fs"]["writeTextFile"] == true, Ordering::Relaxed);
        self.terminal.store(client["terminal"] == true, Ordering::Relaxed);
        json!({
            "protocolVersion": PROTOCOL_VERSION,
            "agentCapabilities": {
                "loadSession": true,
                "promptCapabilities": { "image": true, "audio": self.hears(), "embeddedContext": true },
                "mcpCapabilities": { "http": true, "sse": false },
            },
            "agentInfo": { "name": "autobot", "title": "Autobot", "version": invincible::version::VERSION },
            "authMethods": [],
        })
    }

    fn open(&self, id: &str) -> Result<Arc<Open>, Failure> {
        self.sessions.lock().expect("sessions").get(id).cloned().ok_or((INVALID_PARAMS, format!("no session {id:?}")))
    }

    /// The agent for session [id] in [cwd]: asking as [mode] says, on [model] (of [models]),
    /// with the MCP servers of [hub], the editor's files and terminals.
    #[allow(clippy::too_many_arguments)]
    fn agent(
        &self,
        id: &str,
        cwd: &Path,
        mode: ApprovalMode,
        model: Option<&str>,
        models: &[ModelInfo],
        hub: &Arc<crate::mcp::Hub>,
        turn: &Slot,
    ) -> Result<Agent, Failure> {
        let mut config = self.config.clone();
        config.approvals.mode = mode;
        let mut agent = crate::agent_in(&config, &self.home, Some(cwd.to_owned())).map_err(|e| (INTERNAL, e))?;
        crate::for_coding(&mut agent);
        agent.mcp = hub.clone();
        if let Some(model) = model {
            crate::use_model(&mut agent, &config, models, model).map_err(|e| (INVALID_PARAMS, e))?;
        }
        let read = self.fs_read.load(Ordering::Relaxed);
        let write = self.fs_write.load(Ordering::Relaxed);
        let terminal = self.terminal.load(Ordering::Relaxed);
        // The editor's files and terminals are this machine's: not when the agent works on
        // another one.
        if (read || write || terminal) && agent.tools.ssh().is_none() {
            let files = EditorFiles {
                conn: self.conn.clone(),
                session: id.to_owned(),
                read,
                write,
                terminal,
                turn: turn.clone(),
            };
            agent.tools = agent.tools.clone().with_files(Arc::new(files));
        }
        Ok(agent)
    }

    async fn start(&self, id: &str, cwd: &Path, session: Session, servers: &Value) -> Result<Arc<Open>, Failure> {
        let mode = self.config.approvals.mode;
        let hub = Arc::new(crate::mcp::Hub::new(mcp_servers(&self.config.mcp, servers)).map_err(|e| (INTERNAL, e))?);
        let turn = Slot::default();
        let agent = self.agent(id, cwd, mode, None, &[], &hub, &turn)?;
        let models = agent.gateway.model_info().await.unwrap_or_default();
        let open = Arc::new(Open {
            id: id.to_owned(),
            cwd: cwd.to_owned(),
            mode: Mutex::new(mode),
            model: Mutex::new(None),
            models,
            hub,
            agent: Mutex::new(Arc::new(agent)),
            state: Arc::new(tokio::sync::Mutex::new((session, HashSet::new()))),
            running: Mutex::new(None),
            calls: Arc::default(),
            turn,
            recalled: Mutex::default(),
        });
        self.sessions.lock().expect("sessions").insert(id.to_owned(), open.clone());
        Ok(open)
    }

    /// The session's agent again, with [mode] and [model] where given: from the next turn.
    fn reconfigure(&self, open: &Open, mode: Option<ApprovalMode>, model: Option<&str>) -> Result<(), Failure> {
        let mode = mode.unwrap_or(*open.mode.lock().expect("mode"));
        let model = model.map(str::to_owned).or_else(|| open.model.lock().expect("model").clone());
        let agent = self.agent(&open.id, &open.cwd, mode, model.as_deref(), &open.models, &open.hub, &open.turn)?;
        *open.agent.lock().expect("agent") = Arc::new(agent);
        *open.mode.lock().expect("mode") = mode;
        *open.model.lock().expect("model") = model;
        Ok(())
    }

    fn cwd(params: &Value) -> Result<PathBuf, Failure> {
        let cwd = PathBuf::from(string(params, "cwd")?);
        if !cwd.is_absolute() {
            return Err((INVALID_PARAMS, format!("cwd {}: not an absolute path", cwd.display())));
        }
        cwd.canonicalize().map_err(|e| (INVALID_PARAMS, format!("cwd {}: {e}", cwd.display())))
    }

    async fn new_session(&self, params: &Value) -> Result<Value, Failure> {
        let cwd = Self::cwd(params)?;
        let random = invincible::token::random::<6>().map_err(|e| (INTERNAL, e))?;
        let id = format!("acp-{}", invincible::token::hex(&random));
        let session = Session::open(&self.home.join("sessions"), &id).map_err(|e| (INTERNAL, e))?;
        let open = self.start(&id, &cwd, session, &params["mcpServers"]).await?;
        Ok(json!({
            "sessionId": open.id,
            "modes": modes(*open.mode.lock().expect("mode")),
            "configOptions": config_options(&open),
        }))
    }

    /// An earlier conversation, told to the editor again from its start.
    async fn load_session(&self, params: &Value) -> Result<Value, Failure> {
        let cwd = Self::cwd(params)?;
        let id = string(params, "sessionId")?;
        let dir = self.home.join("sessions");
        if !dir.join(format!("{id}.jsonl")).is_file() {
            return Err((INVALID_PARAMS, format!("no session {id:?}")));
        }
        // Open here already: told again from what is in memory, not opened a second time; not
        // while a prompt runs in it.
        let open = match self.open(id) {
            Ok(open) => {
                let state = open
                    .state
                    .try_lock()
                    .map_err(|_| (INVALID_REQUEST, "a prompt is running in this session".to_owned()))?;
                replay(&self.conn, id, &state.0.messages);
                drop(state);
                open
            }
            Err(_) => {
                let session = Session::open(&dir, id).map_err(|e| (INVALID_PARAMS, e))?;
                replay(&self.conn, id, &session.messages);
                self.start(id, &cwd, session, &params["mcpServers"]).await?
            }
        };
        Ok(json!({ "modes": modes(*open.mode.lock().expect("mode")), "configOptions": config_options(&open) }))
    }

    /// The slash commands of [open]: Autobot's, then the owner's own and the skills.
    fn commands(&self, open: &Open) -> Vec<Value> {
        let mut list: Vec<Value> = COMMANDS
            .iter()
            .map(|(name, what, hint)| {
                let mut command = json!({ "name": name, "description": what });
                if let Some(hint) = hint {
                    command["input"] = json!({ "hint": hint });
                }
                command
            })
            .collect();
        let taken = |list: &[Value], name: &str| list.iter().any(|c| c["name"] == name);
        for custom in crate::commands::list(&open.cwd, &self.home) {
            if !taken(&list, &custom.name) {
                list.push(
                    json!({ "name": custom.name, "description": custom.description, "input": { "hint": "arguments" } }),
                );
            }
        }
        for skill in crate::skills::list(&self.home) {
            if !taken(&list, &skill.name) && !crate::commands::builtin(&skill.name) {
                list.push(json!({
                    "name": skill.name, "description": format!("skill: {}", skill.description),
                    "input": { "hint": "what for" },
                }));
            }
        }
        list
    }

    /// [text] as a slash command, when it is one this side knows; None for the rest (sent to
    /// the agent as written).
    async fn command(&self, open: &Open, text: &str) -> Option<Command> {
        let rest = text.trim().strip_prefix('/')?;
        let (name, arg) = rest.split_once(char::is_whitespace).map_or((rest, ""), |(n, a)| (n, a.trim()));
        let known = COMMANDS.iter().any(|(n, _, _)| *n == name);
        let custom = crate::commands::list(&open.cwd, &self.home).into_iter().find(|c| c.name == name);
        let skill = crate::skills::find(&self.home, name).is_some();
        if !known && custom.is_none() && !skill {
            return None;
        }
        Some(match self.run_command(open, name, arg, custom).await {
            Ok(command) => command,
            Err(e) => Command::Reply(format!("/{name}: {e}")),
        })
    }

    async fn run_command(
        &self,
        open: &Open,
        name: &str,
        arg: &str,
        custom: Option<crate::commands::Custom>,
    ) -> Result<Command, String> {
        let agent = open.agent.lock().expect("agent").clone();
        let busy = || "a prompt is running in this session".to_owned();
        let reply = match name {
            "help" => {
                let mut text = String::new();
                for (name, what, hint) in COMMANDS {
                    let hint = hint.map(|h| format!(" <{h}>")).unwrap_or_default();
                    text.push_str(&format!("- /{name}{hint}: {what}\n"));
                }
                for c in crate::commands::list(&open.cwd, &self.home) {
                    text.push_str(&format!("- /{}: {}\n", c.name, c.description));
                }
                text.push_str("\nThe model and the approval mode are in the session's settings.");
                text
            }
            "init" => return Ok(Command::Send(crate::commands::INIT.to_owned(), Vec::new())),
            "new" | "reset" => {
                let mut state = open.state.try_lock().map_err(|_| busy())?;
                state.0.reset()?;
                state.1.clear();
                open.recalled.lock().expect("recalled").clear();
                "A new conversation: what is above is no longer sent.".to_owned()
            }
            "retry" => {
                let mut state = open.state.try_lock().map_err(|_| busy())?;
                let request = state.0.take_back()?;
                let text = request["content"].as_str().unwrap_or_default().to_owned();
                return Ok(Command::Send(text, crate::images::of(&request)));
            }
            "compact" => {
                let mut state = open.state.try_lock().map_err(|_| busy())?;
                let (session, grants) = &mut *state;
                let confirmed = arg == "yes" || grants.iter().any(|a| matches!(a, Action::Cloud(_)));
                match agent.compact_now(session, confirmed, &|_| {}).await {
                    Ok(0) => "Nothing to fold yet.".to_owned(),
                    Ok(n) => format!("Folded {n} messages into the summary; the last turn stays as it is."),
                    Err(crate::gateway::GatewayError::Confirm(why)) => {
                        format!("{why}: `/compact yes` sends the conversation to it to summarize.")
                    }
                    Err(e) => return Err(e.to_string()),
                }
            }
            "context" => {
                let mut state = open.state.try_lock().map_err(|_| busy())?;
                let budget = agent.options.context_kib.map_or(crate::session::CHAR_BUDGET, |k| k * 1024);
                state.0.budget = budget;
                let window: usize = state.0.window().iter().map(crate::session::cost).sum();
                let summarized = if state.0.summary().is_some() { " · older part summarized" } else { "" };
                let head = format!(
                    "{} messages · {} KiB sent per call of {} KiB{summarized}\n\n",
                    state.0.messages.len(),
                    window / 1024,
                    budget / 1024,
                );
                head + &rows(&crate::tui::chat::context_rows(&agent, &self.home, &open.id))
            }
            "usage" => rows(&crate::insights::usage(&self.home, Some(&open.id), &self.config.prices)),
            "status" => {
                let mut list = vec![
                    ("model".to_owned(), agent.gateway.model().to_owned()),
                    ("approvals".to_owned(), mode_name(*open.mode.lock().expect("mode")).to_owned()),
                    ("private".to_owned(), agent.gateway.private().to_string()),
                    ("project".to_owned(), open.cwd.display().to_string()),
                    ("session".to_owned(), open.id.clone()),
                ];
                let servers = open.hub.names();
                if !servers.is_empty() {
                    list.push(("MCP servers".to_owned(), servers.join(", ")));
                }
                if let Ok(state) = open.state.try_lock()
                    && !state.1.is_empty()
                {
                    let grants: Vec<String> = state.1.iter().map(Action::describe).collect();
                    list.push(("always".to_owned(), grants.join("; ")));
                }
                rows(&list)
            }
            "recall" => {
                if arg.is_empty() {
                    return Err("what to look for: /recall <what>".to_owned());
                }
                let dir = self.home.join("sessions");
                let found = crate::recall::recall(&agent, &dir, arg, &open.id, &|_| {}).await;
                if found == "nothing found" {
                    "Nothing found.".to_owned()
                } else {
                    open.recalled
                        .lock()
                        .expect("recalled")
                        .push_str(&format!("(I recalled earlier conversations about \"{arg}\":)\n{found}\n"));
                    format!("{}\n\n(This goes with your next message.)", found.trim_end())
                }
            }
            "memory" => {
                let facts = crate::memory::Memory::new(&self.home).list();
                if facts.is_empty() {
                    "Nothing remembered yet.".to_owned()
                } else {
                    facts.iter().map(|f| format!("- #{} {}\n", f.id, f.text)).collect()
                }
            }
            "skills" => {
                let skills = crate::skills::list(&self.home);
                if skills.is_empty() {
                    "No skills yet (the agent proposes them; `autobot skills`).".to_owned()
                } else {
                    skills.iter().map(|s| format!("- /{}: {}\n", s.name, s.description)).collect()
                }
            }
            _ => {
                if let Some(custom) = custom {
                    return Ok(Command::Send(crate::commands::expand(&custom, arg)?, Vec::new()));
                }
                return Ok(Command::Send(crate::skills::request(&self.home, name, arg)?, Vec::new()));
            }
        };
        Ok(Command::Reply(reply))
    }

    /// A prompt, whole (what its audio says, a slash command, the turn) on one task that
    /// `session/cancel` stops wherever it is.
    async fn prompt(self: &Arc<Self>, params: &Value) -> Result<Value, Failure> {
        let open = self.open(string(params, "sessionId")?)?;
        let turn = Arc::new(Mutex::new(Turn::new(open.calls.clone())));
        let task = {
            let mut running = open.running.lock().expect("running");
            if running.is_some() {
                return Err((INVALID_REQUEST, "a prompt is running in this session".to_owned()));
            }
            let (acp, open, params, turn) = (self.clone(), open.clone(), params.clone(), turn.clone());
            let task = tokio::spawn(async move { acp.answer(&open, &params, turn).await });
            *running = Some(task.abort_handle());
            task
        };
        let result = task.await;
        open.running.lock().expect("running").take();
        open.turn.lock().expect("turn").take();
        match result {
            Err(e) if e.is_cancelled() => {
                // The call it was in stops with it.
                if let Some(call) = turn.lock().expect("turn").current.take()
                    && !call.hidden
                {
                    self.conn.update(
                        &open.id,
                        json!({ "sessionUpdate": "tool_call_update", "toolCallId": call.id, "status": "failed" }),
                    );
                }
                Ok(json!({ "stopReason": "cancelled" }))
            }
            Err(e) => Err((INTERNAL, format!("the turn failed: {e}"))),
            Ok(answered) => answered,
        }
    }

    /// What [prompt] does, on its task.
    async fn answer(&self, open: &Arc<Open>, params: &Value, turn: Arc<Mutex<Turn>>) -> Result<Value, Failure> {
        let hears = self.hears().then_some(&self.config.voice);
        let prompt = prompt_text(&params["prompt"], &self.home, hears).await?;
        if prompt.text.trim().is_empty() && prompt.images.is_empty() {
            return Err((INVALID_PARAMS, "the prompt is empty".to_owned()));
        }
        for heard in &prompt.heard {
            self.conn.update(&open.id, chunk("agent_thought_chunk", &format!("heard: \"{heard}\"\n")));
        }
        let (mut text, mut images) = (prompt.text, prompt.images);
        match self.command(open, &text).await {
            Some(Command::Reply(reply)) => {
                self.conn.update(&open.id, chunk("agent_message_chunk", &reply));
                return Ok(json!({ "stopReason": "end_turn" }));
            }
            Some(Command::Send(request, with)) => {
                text = request;
                images.extend(with);
            }
            None => {}
        }
        let recalled = std::mem::take(&mut *open.recalled.lock().expect("recalled"));
        if !recalled.is_empty() {
            text = format!("{recalled}\n{text}");
        }
        self.turn(open, text, images, turn).await
    }

    /// One turn of [open] for [text] and [images].
    async fn turn(
        &self,
        open: &Arc<Open>,
        text: String,
        images: Vec<crate::images::Attachment>,
        turn: Arc<Mutex<Turn>>,
    ) -> Result<Value, Failure> {
        let agent = open.agent.lock().expect("agent").clone();
        *open.turn.lock().expect("turn") = Some(turn.clone());
        let outcome = {
            let mut guard = open.state.lock().await;
            let (session, grants) = &mut *guard;
            let approver = EditorApprover { conn: self.conn.clone(), session: open.id.clone(), turn: turn.clone() };
            let events = |event: Event| on_event(&self.conn, &open.id, &turn, event);
            agent.turn_with(session, &text, &images, &approver, grants, &events).await.map_err(|e| (INTERNAL, e))?
        };
        // Not streamed, or the agent's own note that it stopped: the answer whole.
        let stopped = outcome.text.starts_with("Stopped after ");
        if stopped || !turn.lock().expect("turn").streamed {
            self.conn.update(&open.id, chunk("agent_message_chunk", &outcome.text));
        }
        let stop = if stopped { "max_turn_requests" } else { "end_turn" };
        Ok(json!({ "stopReason": stop }))
    }
}

fn chunk(kind: &str, text: &str) -> Value {
    json!({ "sessionUpdate": kind, "content": { "type": "text", "text": text } })
}

/// A prompt as the agent takes it.
struct Prompt {
    /// The owner's text, with the files attached to it.
    text: String,
    images: Vec<crate::images::Attachment>,
    /// What was heard in its audio.
    heard: Vec<String>,
}

/// The editor's prompt (content blocks) as the owner's text and the images with it; audio as
/// the text heard in it, when [voice] can hear it (else it is not taken).
async fn prompt_text(
    blocks: &Value,
    home: &Path,
    voice: Option<&crate::voice::VoiceConfig>,
) -> Result<Prompt, Failure> {
    let blocks = blocks.as_array().ok_or((INVALID_PARAMS, "`prompt` is not a list of content blocks".to_owned()))?;
    let mut prompt = Prompt { text: String::new(), images: Vec::new(), heard: Vec::new() };
    let decode = |block: &Value, what: &str| {
        use base64::Engine as _;
        base64::engine::general_purpose::STANDARD
            .decode(block["data"].as_str().unwrap_or_default().trim())
            .map_err(|e| (INVALID_PARAMS, format!("{what} that is not base64: {e}")))
    };
    for block in blocks {
        match block["type"].as_str().unwrap_or_default() {
            "text" => prompt.text.push_str(block["text"].as_str().unwrap_or_default()),
            // A file the editor attached: its text in the message, under its name.
            "resource" => {
                let resource = &block["resource"];
                let uri = resource["uri"].as_str().unwrap_or("a file");
                if let Some(body) = resource["text"].as_str() {
                    prompt.text.push_str(&format!("\n\n{}:\n```\n{body}\n```\n", shown_uri(uri)));
                } else {
                    prompt.text.push_str(&format!("\n\n(attached: {}, not text)\n", shown_uri(uri)));
                }
            }
            "resource_link" => {
                let uri = block["uri"].as_str().unwrap_or_default();
                prompt.text.push_str(&format!(" {} ", shown_uri(uri)));
            }
            "image" => {
                let bytes = decode(block, "an image")?;
                let ext = match block["mimeType"].as_str().unwrap_or_default() {
                    "image/jpeg" => "jpg",
                    "image/webp" => "webp",
                    "image/gif" => "gif",
                    _ => "png",
                };
                let dir = home.join("attachments");
                std::fs::create_dir_all(&dir).map_err(|e| (INTERNAL, format!("{}: {e}", dir.display())))?;
                let name = {
                    use sha2::Digest as _;
                    invincible::token::hex(&sha2::Sha256::digest(&bytes)[..8])
                };
                let path = dir.join(format!("acp-{name}.{ext}"));
                std::fs::write(&path, &bytes).map_err(|e| (INTERNAL, format!("{}: {e}", path.display())))?;
                prompt.images.push(crate::images::attach(&path).map_err(|e| (INVALID_PARAMS, e))?);
            }
            "audio" if voice.is_some() => {
                let bytes = decode(block, "audio")?;
                if bytes.len() > crate::voice::MAX_AUDIO {
                    return Err((INVALID_PARAMS, "the audio is larger than 25 MB".to_owned()));
                }
                let mime = block["mimeType"].as_str().unwrap_or("audio/wav").to_owned();
                let name = format!("voice.{}", crate::media::extension(&mime));
                let audio = crate::voice::Audio { bytes, mime, name };
                let voice = voice.expect("checked");
                let heard = crate::voice::transcribe(voice, home, audio).await.map_err(|e| (INTERNAL, e))?;
                let heard = heard.trim().to_owned();
                if heard.is_empty() {
                    return Err((INVALID_PARAMS, "nothing was heard in the audio".to_owned()));
                }
                if !prompt.text.is_empty() {
                    prompt.text.push_str("\n\n");
                }
                prompt.text.push_str(&heard);
                prompt.heard.push(heard);
            }
            _ => {}
        }
    }
    Ok(prompt)
}

/// `file:///a/b` as `/a/b`; other URIs as they are.
fn shown_uri(uri: &str) -> &str {
    uri.strip_prefix("file://").unwrap_or(uri)
}

/// The `todo` tool's items as a plan's entries.
fn plan(items: &Value) -> Value {
    let entries: Vec<Value> = items
        .as_array()
        .into_iter()
        .flatten()
        .map(|item| {
            let status = match item["status"].as_str() {
                Some("done") => "completed",
                Some("doing") => "in_progress",
                _ => "pending",
            };
            json!({ "content": item["text"].as_str().unwrap_or_default(), "priority": "medium", "status": status })
        })
        .collect();
    json!({ "sessionUpdate": "plan", "entries": entries })
}

/// The task list a `todo` call sets, from the line the agent shows for it (`todo {…}`).
fn todo_items(what: &str) -> Option<Value> {
    let arguments: Value = serde_json::from_str(what.strip_prefix("todo ")?).ok()?;
    arguments.get("items").filter(|i| i.is_array()).cloned()
}

/// [messages] of a conversation told again as updates: what the owner and the agent said, the
/// tools it ran with what they gave back, and its task list as the plan.
fn replay(conn: &Conn, session: &str, messages: &[Value]) {
    // The task lists' calls: shown as the plan, not as calls.
    let mut planned: HashSet<String> = HashSet::new();
    for m in messages {
        if m["autobot"] == "summary" {
            continue;
        }
        let text = m["content"].as_str().unwrap_or_default();
        match m["role"].as_str().unwrap_or_default() {
            "user" => {
                if !text.is_empty() {
                    conn.update(session, chunk("user_message_chunk", text));
                }
                // Its images, from their files (a note for one that is gone).
                for image in crate::images::of(m) {
                    let content = match std::fs::read(&image.path) {
                        Ok(bytes) => {
                            use base64::Engine as _;
                            let data = base64::engine::general_purpose::STANDARD.encode(bytes);
                            json!({ "type": "image", "data": data, "mimeType": image.mime })
                        }
                        Err(_) => {
                            json!({ "type": "text", "text": format!("[image: {}, no longer on disk]", image.name) })
                        }
                    };
                    conn.update(session, json!({ "sessionUpdate": "user_message_chunk", "content": content }));
                }
            }
            "assistant" => {
                if !text.trim().is_empty() {
                    conn.update(session, chunk("agent_message_chunk", text));
                }
                for call in m["tool_calls"].as_array().into_iter().flatten() {
                    let name = call["function"]["name"].as_str().unwrap_or("tool");
                    let arguments = call["function"]["arguments"].as_str().unwrap_or_default();
                    if name == "todo"
                        && let Some(items) = todo_items(&format!("todo {arguments}"))
                    {
                        conn.update(session, plan(&items));
                        planned.insert(call["id"].as_str().unwrap_or_default().to_owned());
                        continue;
                    }
                    let title: String = format!("{name} {arguments}").chars().take(160).collect();
                    conn.update(
                        session,
                        json!({
                            "sessionUpdate": "tool_call", "toolCallId": call["id"], "title": title,
                            "kind": kind_of(name), "status": "completed",
                        }),
                    );
                }
            }
            "tool" if planned.contains(m["tool_call_id"].as_str().unwrap_or_default()) => {}
            "tool" => conn.update(
                session,
                json!({
                    "sessionUpdate": "tool_call_update", "toolCallId": m["tool_call_id"], "status": "completed",
                    "content": [text_content(text)],
                }),
            ),
            _ => {}
        }
    }
}

fn text_content(text: &str) -> Value {
    let mut shown: String = text.chars().take(SHOWN).collect();
    if shown.len() < text.len() {
        shown.push_str("\n…");
    }
    json!({ "type": "content", "content": { "type": "text", "text": shown } })
}

/// The ACP kind of a tool, by its name or the line the agent shows for it.
fn kind_of(what: &str) -> &'static str {
    let first = what.split([' ', ':']).next().unwrap_or_default();
    match first {
        "read_file" | "list_dir" | "read_skill" | "read" => "read",
        "write_file" | "edit_file" | "write" | "Edit" => "edit",
        "search" | "find_files" | "search_sessions" => "search",
        "terminal" | "run" | "execute_code" | "process" => "execute",
        "web_fetch" | "fetch" | "browser" => "fetch",
        "todo" => "think",
        _ => "other",
    }
}

fn action_kind(action: &Action) -> &'static str {
    match action {
        Action::Command(_) => "execute",
        Action::Write { .. } => "edit",
        Action::Read(_) => "read",
        Action::Fetch(_) | Action::Type { .. } => "fetch",
        _ => "other",
    }
}

/// The tool call the editor is shown for what the agent does now.
struct Turn {
    current: Option<Call>,
    /// The session's tool calls so far: each gets an id of its own, in every turn.
    calls: Arc<AtomicU64>,
    /// Text streamed since the last tool call (else the answer is sent whole at the end).
    streamed: bool,
}

struct Call {
    id: String,
    /// Running (not waiting to be approved).
    started: bool,
    /// Its content is an editor's terminal (kept when it ends).
    terminal: bool,
    /// Not shown as a call (a task list, shown as the plan).
    hidden: bool,
}

impl Call {
    fn new(id: String, started: bool) -> Self {
        Self { id, started, terminal: false, hidden: false }
    }
}

impl Turn {
    fn new(calls: Arc<AtomicU64>) -> Self {
        Self { current: None, calls, streamed: false }
    }

    fn next_id(&mut self) -> String {
        format!("tool-{}", self.calls.fetch_add(1, Ordering::Relaxed) + 1)
    }
}

/// What happens in a turn, as `session/update`s.
fn on_event(conn: &Conn, session: &str, turn: &Mutex<Turn>, event: Event) {
    let mut t = turn.lock().expect("turn");
    match event {
        Event::Text(text) => {
            t.streamed = true;
            conn.update(session, chunk("agent_message_chunk", text));
        }
        Event::Reasoning(text) => conn.update(session, chunk("agent_thought_chunk", text)),
        Event::Change { path, before, after } => {
            let id = t.next_id();
            let path = path.display().to_string();
            conn.update(
                session,
                json!({
                    "sessionUpdate": "tool_call", "toolCallId": id, "title": format!("Edit {path}"), "kind": "edit",
                    "status": "pending",
                    "content": [{ "type": "diff", "path": path, "oldText": (!before.is_empty()).then_some(before), "newText": after }],
                    "locations": [{ "path": path }],
                }),
            );
            t.current = Some(Call::new(id, false));
        }
        // The task list: the editor's plan, whole each time.
        Event::Tool(text) if t.current.is_none() && todo_items(text).is_some() => {
            t.streamed = false;
            conn.update(session, plan(&todo_items(text).unwrap_or_default()));
            let id = t.next_id();
            t.current = Some(Call { hidden: true, ..Call::new(id, true) });
        }
        Event::Tool(text) => {
            t.streamed = false;
            match &mut t.current {
                // The call announced (a change, a question): now it runs.
                Some(call) if !call.started => {
                    call.started = true;
                    conn.update(
                        session,
                        json!({ "sessionUpdate": "tool_call_update", "toolCallId": call.id, "status": "in_progress", "title": text }),
                    );
                }
                // Inside a running call (a script's own calls): shown, done.
                Some(_) => {
                    let id = t.next_id();
                    conn.update(
                        session,
                        json!({ "sessionUpdate": "tool_call", "toolCallId": id, "title": text, "kind": kind_of(text), "status": "completed" }),
                    );
                }
                None => {
                    let id = t.next_id();
                    conn.update(
                        session,
                        json!({ "sessionUpdate": "tool_call", "toolCallId": id, "title": text, "kind": kind_of(text), "status": "in_progress" }),
                    );
                    t.current = Some(Call::new(id, true));
                }
            }
        }
        Event::Output { name, text } => {
            let call = match t.current.take() {
                Some(call) => call,
                None => {
                    let id = t.next_id();
                    conn.update(
                        session,
                        json!({ "sessionUpdate": "tool_call", "toolCallId": id, "title": name, "kind": kind_of(name), "status": "in_progress" }),
                    );
                    Call::new(id, true)
                }
            };
            if call.hidden {
                return;
            }
            let status = if text.starts_with("error: ") || text.starts_with("refused: ") { "failed" } else { "completed" };
            let mut update = json!({ "sessionUpdate": "tool_call_update", "toolCallId": call.id, "status": status });
            // A terminal stays what the call shows; its output is the terminal's.
            if !call.terminal {
                update["content"] = json!([text_content(text)]);
            }
            conn.update(session, update);
        }
        Event::Refused(why) => match t.current.take() {
            Some(call) => conn.update(
                session,
                json!({ "sessionUpdate": "tool_call_update", "toolCallId": call.id, "status": "failed", "content": [text_content(why)] }),
            ),
            None => {
                let id = t.next_id();
                conn.update(
                    session,
                    json!({ "sessionUpdate": "tool_call", "toolCallId": id, "title": why, "kind": "other", "status": "failed" }),
                );
            }
        },
        Event::Member { name, text } => {
            conn.update(session, chunk("agent_thought_chunk", &format!("[{name}] {text}\n")));
        }
        Event::Diff(_) | Event::Receipt { .. } | Event::Usage { .. } => {}
    }
}

/// The agent's questions, as the editor's permission prompts.
struct EditorApprover {
    conn: Arc<Conn>,
    session: String,
    turn: Arc<Mutex<Turn>>,
}

impl Approver for EditorApprover {
    fn approve<'a>(
        &'a self,
        action: &'a Action,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = Answer> + Send + 'a>> {
        Box::pin(async move {
            let title = action.describe();
            let raw = crate::api::describe(action);
            // The call it is about: the change already shown, or a new one.
            let id = {
                let mut t = self.turn.lock().expect("turn");
                match &t.current {
                    Some(call) if !call.started => call.id.clone(),
                    _ => {
                        let id = t.next_id();
                        self.conn.update(
                            &self.session,
                            json!({
                                "sessionUpdate": "tool_call", "toolCallId": id, "title": title,
                                "kind": action_kind(action), "status": "pending", "rawInput": raw,
                            }),
                        );
                        t.current = Some(Call::new(id.clone(), false));
                        id
                    }
                }
            };
            let asked = self
                .conn
                .request(
                    "session/request_permission",
                    json!({
                        "sessionId": self.session,
                        "toolCall": { "toolCallId": id, "title": title, "kind": action_kind(action), "status": "pending", "rawInput": raw },
                        "options": [
                            { "optionId": "allow-once", "name": "Allow once", "kind": "allow_once" },
                            { "optionId": "allow-always", "name": "Always allow in this session", "kind": "allow_always" },
                            { "optionId": "reject-once", "name": "Reject", "kind": "reject_once" },
                        ],
                    }),
                )
                .await;
            let answer = match asked {
                Ok(result) if result["outcome"]["outcome"] == "selected" => {
                    match result["outcome"]["optionId"].as_str().unwrap_or_default() {
                        "allow-once" => Answer::Once,
                        "allow-always" => Answer::Always,
                        _ => Answer::Deny,
                    }
                }
                // Cancelled, or the editor could not ask.
                _ => Answer::Deny,
            };
            // A cloud model is not a tool call: done with once answered.
            if matches!(action, Action::Cloud(_)) {
                let mut t = self.turn.lock().expect("turn");
                if t.current.as_ref().is_some_and(|c| c.id == id) {
                    t.current = None;
                    let status = if answer == Answer::Deny { "failed" } else { "completed" };
                    self.conn.update(
                        &self.session,
                        json!({ "sessionUpdate": "tool_call_update", "toolCallId": id, "status": status }),
                    );
                }
            }
            answer
        })
    }

    fn channel(&self) -> &'static str {
        "editor"
    }
}

/// The editor's files (its buffers, unsaved changes included) and terminals.
struct EditorFiles {
    conn: Arc<Conn>,
    session: String,
    read: bool,
    write: bool,
    terminal: bool,
    turn: Slot,
}

/// An editor's terminal, killed and released when the command is done with however that ends
/// (a cancelled turn included).
struct Terminal {
    conn: Arc<Conn>,
    params: Value,
    released: bool,
}

impl Terminal {
    async fn ask(&self, method: &str) -> Result<Value, String> {
        self.conn.request(method, self.params.clone()).await
    }

    async fn release(mut self) {
        self.released = true;
        let _ = self.ask("terminal/release").await;
    }
}

impl Drop for Terminal {
    fn drop(&mut self) {
        if self.released {
            return;
        }
        let (conn, params) = (self.conn.clone(), self.params.clone());
        if let Ok(runtime) = tokio::runtime::Handle::try_current() {
            runtime.spawn(async move {
                let _ = conn.request("terminal/kill", params.clone()).await;
                let _ = conn.request("terminal/release", params).await;
            });
        }
    }
}

impl EditorFiles {
    /// [command] in an editor's terminal: what it printed and how it ended, as the `terminal`
    /// tool says it; None when the editor could not open one.
    async fn run(&self, command: &str, cwd: &Path, timeout: Duration, limit: usize) -> Option<Result<String, String>> {
        let (program, args) = crate::shell::argv(command);
        let params = json!({
            "sessionId": self.session, "command": program, "args": args,
            "cwd": cwd.display().to_string(), "outputByteLimit": limit,
        });
        // Asked on a task of its own: a terminal the editor opens after the turn was cancelled
        // is still killed and released.
        let (tx, rx) = oneshot::channel();
        let (conn, session) = (self.conn.clone(), self.session.clone());
        tokio::spawn(async move {
            let created = conn.request("terminal/create", params).await;
            if let Err(Ok(result)) = tx.send(created)
                && let Some(id) = result["terminalId"].as_str()
            {
                let params = json!({ "sessionId": session, "terminalId": id });
                let _ = conn.request("terminal/kill", params.clone()).await;
                let _ = conn.request("terminal/release", params).await;
            }
        });
        let created = rx.await.unwrap_or_else(|_| Err("the editor went away".to_owned()));
        let id = match created.map(|r| r["terminalId"].as_str().map(str::to_owned)) {
            Ok(Some(id)) => id,
            Ok(None) | Err(_) => {
                tracing::warn!("the editor opened no terminal; the command runs here");
                return None;
            }
        };
        let terminal = Terminal {
            conn: self.conn.clone(),
            params: json!({ "sessionId": self.session, "terminalId": id }),
            released: false,
        };
        // Shown in the call it runs for.
        if let Some(turn) = self.turn.lock().expect("turn").clone()
            && let Some(call) = turn.lock().expect("turn").current.as_mut()
        {
            call.terminal = true;
            self.conn.update(
                &self.session,
                json!({
                    "sessionUpdate": "tool_call_update", "toolCallId": call.id,
                    "content": [{ "type": "terminal", "terminalId": id }],
                }),
            );
        }
        let exited = tokio::time::timeout(timeout, terminal.ask("terminal/wait_for_exit")).await;
        if exited.is_err() {
            let _ = terminal.ask("terminal/kill").await;
        }
        let output = terminal.ask("terminal/output").await;
        terminal.release().await;
        let output = match output {
            Ok(output) => output,
            Err(e) => return Some(Err(format!("the editor's terminal: {e}"))),
        };
        let mut text = output["output"].as_str().unwrap_or_default().to_owned();
        if output["truncated"] == true {
            text.insert_str(0, "…\n");
        }
        let status = match exited {
            Err(_) => {
                return Some(Err(format!("stopped after {} seconds\n{text}", timeout.as_secs())));
            }
            Ok(Ok(status)) if !status["exitCode"].is_null() || !status["signal"].is_null() => status,
            Ok(_) => output["exitStatus"].clone(),
        };
        let code = match (status["exitCode"].as_i64(), status["signal"].as_str()) {
            (Some(code), _) => format!("exit code {code}"),
            (None, Some(signal)) => format!("killed by {signal}"),
            (None, None) => "killed by a signal".to_owned(),
        };
        let gap = if text.is_empty() || text.ends_with('\n') { "" } else { "\n" };
        Some(Ok(format!("{text}{gap}[{code}]")))
    }
}

impl crate::tools::Files for EditorFiles {
    fn read<'a>(&'a self, path: &'a Path) -> crate::tools::FilesFuture<'a, String> {
        Box::pin(async move {
            if !self.read {
                return None;
            }
            let params = json!({ "sessionId": self.session, "path": path.display().to_string() });
            Some(self.conn.request("fs/read_text_file", params).await.and_then(|result| {
                result["content"].as_str().map(str::to_owned).ok_or_else(|| "the editor sent no content".to_owned())
            }))
        })
    }

    fn write<'a>(&'a self, path: &'a Path, text: &'a str) -> crate::tools::FilesFuture<'a, ()> {
        Box::pin(async move {
            if !self.write {
                return None;
            }
            let params = json!({ "sessionId": self.session, "path": path.display().to_string(), "content": text });
            Some(self.conn.request("fs/write_text_file", params).await.map(drop))
        })
    }

    fn terminal<'a>(
        &'a self,
        command: &'a str,
        cwd: &'a Path,
        timeout: Duration,
        limit: usize,
    ) -> crate::tools::FilesFuture<'a, String> {
        Box::pin(async move {
            if !self.terminal {
                return None;
            }
            self.run(command, cwd, timeout, limit).await
        })
    }
}

#[cfg(test)]
mod tests {
    use super::{kind_of, mcp_servers, plan, prompt_text, server_name, shown_uri, todo_items};
    use serde_json::json;

    #[tokio::test]
    async fn prompts_take_text_files_and_links() {
        let home = std::env::temp_dir().join(format!("autobot-acp-prompt-{}", std::process::id()));
        let blocks = json!([
            { "type": "text", "text": "fix this" },
            { "type": "resource", "resource": { "uri": "file:///p/main.rs", "mimeType": "text/x-rust", "text": "fn main() {}" } },
            { "type": "resource_link", "uri": "file:///p/lib.rs", "name": "lib.rs" },
            { "type": "audio", "data": "", "mimeType": "audio/wav" },
        ]);
        let prompt = prompt_text(&blocks, &home, None).await.unwrap();
        assert!(prompt.text.starts_with("fix this\n\n/p/main.rs:\n```\nfn main() {}\n```"), "{}", prompt.text);
        assert!(prompt.text.contains("/p/lib.rs"));
        assert!(prompt.images.is_empty() && prompt.heard.is_empty(), "audio is not taken without speech-to-text");
        assert!(prompt_text(&json!("nope"), &home, None).await.is_err());
        let bad = json!([{ "type": "image", "data": "%%%", "mimeType": "image/png" }]);
        assert!(prompt_text(&bad, &home, None).await.is_err());
        assert_eq!(shown_uri("https://x.org"), "https://x.org");
    }

    #[test]
    fn tools_have_kinds() {
        assert_eq!(kind_of("run: cargo test"), "execute");
        assert_eq!(kind_of("read_file {\"path\":\"a\"}"), "read");
        assert_eq!(kind_of("write 12 bytes to /a"), "edit");
        assert_eq!(kind_of("search x"), "search");
        assert_eq!(kind_of("remember"), "other");
    }

    #[test]
    fn task_lists_are_plans() {
        let items = todo_items(r#"todo {"items":[{"text":"read","status":"done"},{"text":"fix","status":"doing"},{"text":"test","status":"pending"}]}"#).unwrap();
        let entries = plan(&items)["entries"].clone();
        let statuses: Vec<&str> = entries.as_array().unwrap().iter().map(|e| e["status"].as_str().unwrap()).collect();
        assert_eq!(statuses, ["completed", "in_progress", "pending"]);
        assert_eq!(entries[1]["content"], "fix");
        assert!(todo_items("todo nonsense").is_none() && todo_items("terminal {}").is_none());
    }

    #[test]
    fn the_editors_mcp_servers_join_the_agents() {
        let own = std::collections::BTreeMap::from([(
            "github".to_owned(),
            crate::mcp::ServerConfig { command: "gh-mcp".into(), ..Default::default() },
        )]);
        let given = json!([
            { "name": "github", "command": "/bin/other", "args": ["-x"], "env": [{ "name": "K", "value": "v" }] },
            { "type": "http", "name": "Docs Server", "url": "https://docs.example/mcp", "headers": [{ "name": "Authorization", "value": "Bearer t" }] },
            { "type": "http", "name": "plain", "url": "http://far.example/mcp", "headers": [] },
            { "type": "sse", "name": "old", "url": "https://old.example/sse", "headers": [] },
        ]);
        let servers = mcp_servers(&own, &given);
        let names: Vec<&str> = servers.keys().map(String::as_str).collect();
        assert_eq!(names, ["Docs_Server", "github", "github-2"]);
        assert_eq!(servers["github"].command, "gh-mcp", "the agent's own stays");
        assert_eq!((servers["github-2"].args[0].as_str(), servers["github-2"].env["K"].as_str()), ("-x", "v"));
        assert_eq!(servers["Docs_Server"].headers["Authorization"], "Bearer t");
        assert_eq!(server_name("a__b c!"), "a_b_c");
        assert_eq!(server_name("!!"), "server");
    }
}
