//! `autobot acp`: the agent for an editor, over the Agent Client Protocol
//! (<https://agentclientprotocol.com>, version 1): JSON-RPC 2.0 on stdin and stdout, one message
//! per line. Zed (and any ACP client) starts it, opens sessions in a project, sends prompts and
//! shows what comes back: the answer as it streams, its reasoning, each tool call with its diff
//! or output, and the agent's questions as the editor's permission prompts.
//!
//! - A session is an Autobot conversation (`acp-…` in `$AUTOBOT_HOME/sessions`), coding in the
//!   folder the editor names, like `autobot code` there; `session/load` replays one.
//! - Approvals: what the configured mode asks about becomes `session/request_permission`
//!   (allow once, always allow for the session, reject). The modes are the approval modes:
//!   `ask`, `edits`, `allowlist`, `trust` (`session/set_mode`).
//! - Files are read and written through the editor (`fs/read_text_file`, `fs/write_text_file`)
//!   when it offers them, so unsaved buffers are what the agent sees and its edits land in them.
//! - `session/cancel` stops the turn where it is.
//!
//! Not here (yet): MCP servers the editor passes (the agent's own `[mcp]` servers work), the
//! editor's terminals (commands run as the agent runs them), authentication (none is needed).

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use serde_json::{Value, json};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt};
use tokio::sync::{mpsc, oneshot};

use crate::agent::{Agent, Event};
use crate::approval::{Action, Answer, Approver};
use crate::config::{ApprovalMode, Config};
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
        let id = self.next.fetch_add(1, Ordering::Relaxed);
        let (tx, rx) = oneshot::channel();
        self.waiting.lock().expect("waiting").insert(id, tx);
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

/// One conversation the editor opened.
struct Open {
    id: String,
    cwd: PathBuf,
    mode: Mutex<ApprovalMode>,
    agent: Mutex<Arc<Agent>>,
    state: Arc<tokio::sync::Mutex<(Session, HashSet<Action>)>>,
    running: Mutex<Option<tokio::task::AbortHandle>>,
}

struct Acp {
    conn: Arc<Conn>,
    config: Config,
    home: PathBuf,
    /// What the editor offers: reading and writing its files.
    fs_read: AtomicBool,
    fs_write: AtomicBool,
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
                    let result = acp.clone().handle(&method, params).await;
                    acp.conn.respond(id, result);
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

fn mode_name(mode: ApprovalMode) -> &'static str {
    match mode {
        ApprovalMode::Ask => "ask",
        ApprovalMode::Edits => "edits",
        ApprovalMode::Allowlist => "allowlist",
        ApprovalMode::Trust => "trust",
    }
}

/// The approval modes, as the editor's session modes.
fn modes(current: ApprovalMode) -> Value {
    json!({
        "currentModeId": mode_name(current),
        "availableModes": [
            { "id": "ask", "name": "Ask", "description": "Ask before commands, writes and reads outside the project" },
            { "id": "edits", "name": "Edits", "description": "Changes in the project without asking; ask for the rest" },
            { "id": "allowlist", "name": "Allowlist", "description": "Allowlisted commands and project changes; refuse the rest" },
            { "id": "trust", "name": "Trust", "description": "Everything without asking" },
        ],
    })
}

fn string<'a>(params: &'a Value, key: &str) -> Result<&'a str, Failure> {
    params[key].as_str().ok_or_else(|| (INVALID_PARAMS, format!("`{key}` is missing")))
}

impl Acp {
    async fn handle(self: Arc<Self>, method: &str, params: Value) -> Result<Value, Failure> {
        match method {
            "initialize" => Ok(self.initialize(&params)),
            "authenticate" => Ok(json!({})),
            "session/new" => self.new_session(&params),
            "session/load" => self.load_session(&params),
            "session/prompt" => self.prompt(&params).await,
            "session/set_mode" => self.set_mode(&params),
            "session/cancel" => {
                self.notified(method, &params);
                Ok(Value::Null)
            }
            _ => Err((NO_METHOD, format!("no method {method}"))),
        }
    }

    fn notified(&self, method: &str, params: &Value) {
        if method == "session/cancel"
            && let Some(open) = params["sessionId"].as_str().and_then(|id| self.open(id).ok())
            && let Some(running) = open.running.lock().expect("running").take()
        {
            running.abort();
        }
    }

    fn initialize(&self, params: &Value) -> Value {
        let fs = &params["clientCapabilities"]["fs"];
        self.fs_read.store(fs["readTextFile"] == true, Ordering::Relaxed);
        self.fs_write.store(fs["writeTextFile"] == true, Ordering::Relaxed);
        json!({
            "protocolVersion": PROTOCOL_VERSION,
            "agentCapabilities": {
                "loadSession": true,
                "promptCapabilities": { "image": true, "audio": false, "embeddedContext": true },
                "mcpCapabilities": { "http": false, "sse": false },
            },
            "agentInfo": { "name": "autobot", "title": "Autobot", "version": invincible::version::VERSION },
            "authMethods": [],
        })
    }

    fn open(&self, id: &str) -> Result<Arc<Open>, Failure> {
        self.sessions.lock().expect("sessions").get(id).cloned().ok_or((INVALID_PARAMS, format!("no session {id:?}")))
    }

    /// The agent for session [id] in [cwd], asking as [mode] says, with the editor's files.
    fn agent(&self, id: &str, cwd: &Path, mode: ApprovalMode) -> Result<Agent, Failure> {
        let mut config = self.config.clone();
        config.approvals.mode = mode;
        let mut agent = crate::agent_in(&config, &self.home, Some(cwd.to_owned())).map_err(|e| (INTERNAL, e))?;
        crate::for_coding(&mut agent);
        let (read, write) = (self.fs_read.load(Ordering::Relaxed), self.fs_write.load(Ordering::Relaxed));
        // The editor's files are this machine's: not when the agent works on another one.
        if (read || write) && agent.tools.ssh().is_none() {
            let files = EditorFiles { conn: self.conn.clone(), session: id.to_owned(), read, write };
            agent.tools = agent.tools.clone().with_files(Arc::new(files));
        }
        Ok(agent)
    }

    fn start(&self, id: &str, cwd: &Path, session: Session) -> Result<Arc<Open>, Failure> {
        let mode = self.config.approvals.mode;
        let open = Arc::new(Open {
            id: id.to_owned(),
            cwd: cwd.to_owned(),
            mode: Mutex::new(mode),
            agent: Mutex::new(Arc::new(self.agent(id, cwd, mode)?)),
            state: Arc::new(tokio::sync::Mutex::new((session, HashSet::new()))),
            running: Mutex::new(None),
        });
        self.sessions.lock().expect("sessions").insert(id.to_owned(), open.clone());
        Ok(open)
    }

    fn cwd(params: &Value) -> Result<PathBuf, Failure> {
        let cwd = PathBuf::from(string(params, "cwd")?);
        if !cwd.is_absolute() {
            return Err((INVALID_PARAMS, format!("cwd {}: not an absolute path", cwd.display())));
        }
        cwd.canonicalize().map_err(|e| (INVALID_PARAMS, format!("cwd {}: {e}", cwd.display())))
    }

    fn new_session(&self, params: &Value) -> Result<Value, Failure> {
        let cwd = Self::cwd(params)?;
        let random = invincible::token::random::<6>().map_err(|e| (INTERNAL, e))?;
        let id = format!("acp-{}", invincible::token::hex(&random));
        let session = Session::open(&self.home.join("sessions"), &id).map_err(|e| (INTERNAL, e))?;
        let open = self.start(&id, &cwd, session)?;
        Ok(json!({ "sessionId": open.id, "modes": modes(*open.mode.lock().expect("mode")) }))
    }

    /// An earlier conversation, told to the editor again from its start.
    fn load_session(&self, params: &Value) -> Result<Value, Failure> {
        let cwd = Self::cwd(params)?;
        let id = string(params, "sessionId")?;
        let dir = self.home.join("sessions");
        if !dir.join(format!("{id}.jsonl")).is_file() {
            return Err((INVALID_PARAMS, format!("no session {id:?}")));
        }
        let session = Session::open(&dir, id).map_err(|e| (INVALID_PARAMS, e))?;
        replay(&self.conn, id, &session.messages);
        let open = self.start(id, &cwd, session)?;
        Ok(json!({ "modes": modes(*open.mode.lock().expect("mode")) }))
    }

    fn set_mode(&self, params: &Value) -> Result<Value, Failure> {
        let open = self.open(string(params, "sessionId")?)?;
        let mode = match string(params, "modeId")? {
            "ask" => ApprovalMode::Ask,
            "edits" => ApprovalMode::Edits,
            "allowlist" => ApprovalMode::Allowlist,
            "trust" => ApprovalMode::Trust,
            other => return Err((INVALID_PARAMS, format!("no mode {other:?}"))),
        };
        // From the next turn on.
        let agent = self.agent(&open.id, &open.cwd, mode)?;
        *open.agent.lock().expect("agent") = Arc::new(agent);
        *open.mode.lock().expect("mode") = mode;
        Ok(json!({}))
    }

    async fn prompt(&self, params: &Value) -> Result<Value, Failure> {
        let open = self.open(string(params, "sessionId")?)?;
        let (text, images) = prompt_text(&params["prompt"], &self.home)?;
        if text.trim().is_empty() && images.is_empty() {
            return Err((INVALID_PARAMS, "the prompt is empty".to_owned()));
        }
        let agent = open.agent.lock().expect("agent").clone();
        let turn = Arc::new(Mutex::new(Turn::default()));
        let (conn, id, state) = (self.conn.clone(), open.id.clone(), open.state.clone());
        let task = {
            let turn = turn.clone();
            let mut running = open.running.lock().expect("running");
            if running.is_some() {
                return Err((INVALID_REQUEST, "a prompt is running in this session".to_owned()));
            }
            let task = tokio::spawn(async move {
                let mut guard = state.lock().await;
                let (session, grants) = &mut *guard;
                let approver = EditorApprover { conn: conn.clone(), session: id.clone(), turn: turn.clone() };
                let events = |event: Event| on_event(&conn, &id, &turn, event);
                agent.turn_with(session, &text, &images, &approver, grants, &events).await
            });
            *running = Some(task.abort_handle());
            task
        };
        let result = task.await;
        open.running.lock().expect("running").take();
        let outcome = match result {
            Err(e) if e.is_cancelled() => {
                // The call it was in stops with it.
                if let Some(call) = turn.lock().expect("turn").current.take() {
                    self.conn.update(
                        &open.id,
                        json!({ "sessionUpdate": "tool_call_update", "toolCallId": call.id, "status": "failed" }),
                    );
                }
                return Ok(json!({ "stopReason": "cancelled" }));
            }
            Err(e) => return Err((INTERNAL, format!("the turn failed: {e}"))),
            Ok(Err(e)) => return Err((INTERNAL, e)),
            Ok(Ok(outcome)) => outcome,
        };
        // Not streamed (or a stop note): the answer whole.
        if !turn.lock().expect("turn").streamed {
            self.conn.update(&open.id, chunk("agent_message_chunk", &outcome.text));
        }
        let stop = if outcome.text.starts_with("Stopped after ") { "max_turn_requests" } else { "end_turn" };
        Ok(json!({ "stopReason": stop }))
    }
}

fn chunk(kind: &str, text: &str) -> Value {
    json!({ "sessionUpdate": kind, "content": { "type": "text", "text": text } })
}

/// The editor's prompt (content blocks) as the owner's text and the images with it.
fn prompt_text(blocks: &Value, home: &Path) -> Result<(String, Vec<crate::images::Attachment>), Failure> {
    let blocks = blocks.as_array().ok_or((INVALID_PARAMS, "`prompt` is not a list of content blocks".to_owned()))?;
    let mut text = String::new();
    let mut images = Vec::new();
    for block in blocks {
        match block["type"].as_str().unwrap_or_default() {
            "text" => text.push_str(block["text"].as_str().unwrap_or_default()),
            // A file the editor attached: its text in the message, under its name.
            "resource" => {
                let resource = &block["resource"];
                let uri = resource["uri"].as_str().unwrap_or("a file");
                if let Some(body) = resource["text"].as_str() {
                    text.push_str(&format!("\n\n{}:\n```\n{body}\n```\n", shown_uri(uri)));
                } else {
                    text.push_str(&format!("\n\n(attached: {}, not text)\n", shown_uri(uri)));
                }
            }
            "resource_link" => {
                let uri = block["uri"].as_str().unwrap_or_default();
                text.push_str(&format!(" {} ", shown_uri(uri)));
            }
            "image" => {
                let data = block["data"].as_str().unwrap_or_default();
                let bytes = {
                    use base64::Engine as _;
                    base64::engine::general_purpose::STANDARD
                        .decode(data.trim())
                        .map_err(|e| (INVALID_PARAMS, format!("an image that is not base64: {e}")))?
                };
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
                images.push(crate::images::attach(&path).map_err(|e| (INVALID_PARAMS, e))?);
            }
            _ => {}
        }
    }
    Ok((text, images))
}

/// `file:///a/b` as `/a/b`; other URIs as they are.
fn shown_uri(uri: &str) -> &str {
    uri.strip_prefix("file://").unwrap_or(uri)
}

/// [messages] of a conversation told again as updates: what the owner and the agent said, and
/// the tools it ran with what they gave back.
fn replay(conn: &Conn, session: &str, messages: &[Value]) {
    for m in messages {
        if m["autobot"] == "summary" {
            continue;
        }
        let text = m["content"].as_str().unwrap_or_default();
        match m["role"].as_str().unwrap_or_default() {
            "user" if !text.is_empty() => conn.update(session, chunk("user_message_chunk", text)),
            "assistant" => {
                if !text.trim().is_empty() {
                    conn.update(session, chunk("agent_message_chunk", text));
                }
                for call in m["tool_calls"].as_array().into_iter().flatten() {
                    let name = call["function"]["name"].as_str().unwrap_or("tool");
                    let arguments = call["function"]["arguments"].as_str().unwrap_or_default();
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
#[derive(Default)]
struct Turn {
    current: Option<Call>,
    count: u64,
    /// Text streamed since the last tool call (else the answer is sent whole at the end).
    streamed: bool,
}

struct Call {
    id: String,
    /// Running (not waiting to be approved).
    started: bool,
}

impl Turn {
    fn next_id(&mut self) -> String {
        self.count += 1;
        format!("tool-{}", self.count)
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
            t.current = Some(Call { id, started: false });
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
                    t.current = Some(Call { id, started: true });
                }
            }
        }
        Event::Output { name, text } => {
            let id = match t.current.take() {
                Some(call) => call.id,
                None => {
                    let id = t.next_id();
                    conn.update(
                        session,
                        json!({ "sessionUpdate": "tool_call", "toolCallId": id, "title": name, "kind": kind_of(name), "status": "in_progress" }),
                    );
                    id
                }
            };
            let status = if text.starts_with("error: ") || text.starts_with("refused: ") { "failed" } else { "completed" };
            conn.update(
                session,
                json!({ "sessionUpdate": "tool_call_update", "toolCallId": id, "status": status, "content": [text_content(text)] }),
            );
        }
        Event::Refused(why) => {
            match t.current.take() {
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
            }
        }
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
                        t.current = Some(Call { id: id.clone(), started: false });
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

/// The editor's files: its buffers, unsaved changes included.
struct EditorFiles {
    conn: Arc<Conn>,
    session: String,
    read: bool,
    write: bool,
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
}

#[cfg(test)]
mod tests {
    use super::{kind_of, prompt_text, shown_uri};
    use serde_json::json;

    #[test]
    fn prompts_take_text_files_and_links() {
        let home = std::env::temp_dir().join(format!("autobot-acp-prompt-{}", std::process::id()));
        let blocks = json!([
            { "type": "text", "text": "fix this" },
            { "type": "resource", "resource": { "uri": "file:///p/main.rs", "mimeType": "text/x-rust", "text": "fn main() {}" } },
            { "type": "resource_link", "uri": "file:///p/lib.rs", "name": "lib.rs" },
            { "type": "audio", "data": "", "mimeType": "audio/wav" },
        ]);
        let (text, images) = prompt_text(&blocks, &home).unwrap();
        assert!(text.starts_with("fix this\n\n/p/main.rs:\n```\nfn main() {}\n```"), "{text}");
        assert!(text.contains("/p/lib.rs"));
        assert!(images.is_empty());
        assert!(prompt_text(&json!("nope"), &home).is_err());
        assert!(prompt_text(&json!([{ "type": "image", "data": "%%%", "mimeType": "image/png" }]), &home).is_err());
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
}
