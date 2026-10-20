//! `autobot acp` driven by a scripted Agent Client Protocol client (as Zed drives it), against a
//! stand-in gateway with scripted answers: sessions, streamed answers, tool calls with diffs,
//! permission requests answered both ways, files through the editor, modes, cancel and load;
//! then the editor's terminals, its MCP servers and the slash commands.

mod support;

use std::collections::{HashMap, VecDeque};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use axum::body::{Body, Bytes};
use axum::extract::State;
use axum::response::{IntoResponse, Response};
use serde_json::{Value, json};
use support::{Homes, TOKEN, binary, temp};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt};

/// What the stand-in gateway answers, in order, and what it was sent.
#[derive(Default)]
struct Script {
    answers: VecDeque<(Duration, Value)>,
    seen: Vec<Value>,
}

type Shared = Arc<Mutex<Script>>;

async fn completions(State(script): State<Shared>, body: Bytes) -> Response {
    let request: Value = serde_json::from_slice(&body).unwrap();
    let (delay, message) = {
        let mut s = script.lock().unwrap();
        s.seen.push(request.clone());
        s.answers.pop_front().unwrap_or((Duration::ZERO, json!({ "role": "assistant", "content": "(no more)" })))
    };
    tokio::time::sleep(delay).await;
    if request["stream"] != true {
        return axum::Json(json!({ "choices": [{ "message": message }] })).into_response();
    }
    // Streamed: the text in two pieces, the tool calls whole.
    let mut out = String::new();
    let text = message["content"].as_str().unwrap_or_default();
    let half = text.char_indices().nth(text.chars().count() / 2).map_or(text.len(), |(i, _)| i);
    for piece in [&text[..half], &text[half..]] {
        let chunk = json!({ "choices": [{ "index": 0, "delta": { "content": piece } }] });
        out.push_str(&format!("data: {chunk}\n\n"));
    }
    if let Some(calls) = message["tool_calls"].as_array() {
        let calls: Vec<Value> = calls
            .iter()
            .enumerate()
            .map(|(i, c)| {
                let mut c = c.clone();
                c["index"] = json!(i);
                c
            })
            .collect();
        out.push_str(&format!(
            "data: {}\n\n",
            json!({ "choices": [{ "index": 0, "delta": { "tool_calls": calls } }] })
        ));
    }
    out.push_str("data: [DONE]\n\n");
    let mut response = Response::new(Body::from(out));
    response.headers_mut().insert("content-type", "text/event-stream".parse().unwrap());
    response
}

async fn gateway(script: Shared) -> String {
    let app = axum::Router::new()
        .route("/v1/chat/completions", axum::routing::post(completions))
        .route("/v1/models", axum::routing::get(|| async { axum::Json(json!({ "data": [] })) }))
        .route("/health", axum::routing::get(|| async { "ok" }))
        .with_state(script);
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}", listener.local_addr().unwrap());
    tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    url
}

fn call(id: &str, name: &str, arguments: Value) -> Value {
    json!({ "role": "assistant", "content": "", "tool_calls": [
        { "id": id, "type": "function", "function": { "name": name, "arguments": arguments.to_string() } },
    ] })
}

fn say(text: &str) -> Value {
    json!({ "role": "assistant", "content": text })
}

/// How the scripted editor answers the agent's permission requests.
#[derive(Clone, Copy)]
enum Answer {
    Allow,
    Reject,
}

/// The scripted editor: its side of the line, its open buffers, and everything it was told.
struct Editor {
    child: tokio::process::Child,
    stdin: tokio::process::ChildStdin,
    lines: tokio::io::Lines<tokio::io::BufReader<tokio::process::ChildStdout>>,
    next: u64,
    buffers: HashMap<String, String>,
    answer: Answer,
    /// The agent's `session/update`s, its requests to the editor, in order.
    updates: Vec<Value>,
    asked: Vec<Value>,
    /// Errors about lines that were not requests.
    errors: Vec<Value>,
    /// The terminals it opened (run at once, here): what each printed and its exit code.
    terminals: HashMap<String, (String, i32)>,
}

impl Editor {
    fn start(homes: &Homes, log: &std::path::Path) -> Self {
        let mut command = tokio::process::Command::new(binary("autobot"));
        command
            .arg("acp")
            .env_clear()
            .env("PATH", std::env::var_os("PATH").unwrap_or_default())
            .env("HOME", &homes.home)
            .env("AUTOBOT_HOME", &homes.autobot)
            .env("INVINCIBLE_HOME", &homes.invincible)
            .env("NO_COLOR", "1")
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .stderr(std::fs::File::create(log).unwrap())
            .kill_on_drop(true);
        let mut child = command.spawn().unwrap();
        let stdin = child.stdin.take().unwrap();
        let lines = tokio::io::BufReader::new(child.stdout.take().unwrap()).lines();
        Self {
            child,
            stdin,
            lines,
            next: 1,
            buffers: HashMap::new(),
            answer: Answer::Allow,
            updates: Vec::new(),
            asked: Vec::new(),
            errors: Vec::new(),
            terminals: HashMap::new(),
        }
    }

    async fn write(&mut self, message: &Value) {
        self.stdin.write_all(format!("{message}\n").as_bytes()).await.unwrap();
    }

    async fn send(&mut self, method: &str, params: Value) -> u64 {
        let id = self.next;
        self.next += 1;
        self.write(&json!({ "jsonrpc": "2.0", "id": id, "method": method, "params": params })).await;
        id
    }

    /// Reads until the answer to request [id], answering the agent's own requests on the way.
    async fn until(&mut self, id: u64) -> Value {
        loop {
            let line = tokio::time::timeout(Duration::from_secs(20), self.lines.next_line())
                .await
                .expect("the agent answers")
                .unwrap()
                .expect("the agent is running");
            let message: Value = serde_json::from_str(&line).unwrap_or_else(|e| panic!("not JSON ({e}): {line}"));
            assert_eq!(message["jsonrpc"], "2.0", "{message}");
            if message["id"] == id && message.get("method").is_none() {
                return message;
            }
            if message["id"].is_null() && message.get("error").is_some() {
                self.errors.push(message);
                continue;
            }
            match message["method"].as_str() {
                Some("session/update") => self.updates.push(message["params"].clone()),
                Some(method) => {
                    self.asked.push(message.clone());
                    let params = &message["params"];
                    let result = match method {
                        "session/request_permission" => {
                            let option = match self.answer {
                                Answer::Allow => "allow-once",
                                Answer::Reject => "reject-once",
                            };
                            json!({ "outcome": { "outcome": "selected", "optionId": option } })
                        }
                        "fs/read_text_file" => {
                            let path = params["path"].as_str().unwrap();
                            match self.buffers.get(path) {
                                Some(text) => json!({ "content": text }),
                                None => {
                                    let error = json!({ "code": -32002, "message": format!("{path}: not open") });
                                    self.write(&json!({ "jsonrpc": "2.0", "id": message["id"], "error": error })).await;
                                    continue;
                                }
                            }
                        }
                        "fs/write_text_file" => {
                            let path = params["path"].as_str().unwrap().to_owned();
                            self.buffers.insert(path, params["content"].as_str().unwrap().to_owned());
                            json!({})
                        }
                        "terminal/create" => {
                            let args: Vec<&str> =
                                params["args"].as_array().unwrap().iter().map(|a| a.as_str().unwrap()).collect();
                            let out = std::process::Command::new(params["command"].as_str().unwrap())
                                .args(&args)
                                .current_dir(params["cwd"].as_str().unwrap())
                                .output()
                                .unwrap();
                            let mut text = String::from_utf8_lossy(&out.stdout).into_owned();
                            text.push_str(&String::from_utf8_lossy(&out.stderr));
                            let id = format!("term-{}", self.terminals.len() + 1);
                            self.terminals.insert(id.clone(), (text, out.status.code().unwrap_or(-1)));
                            json!({ "terminalId": id })
                        }
                        "terminal/wait_for_exit" => {
                            let (_, code) = &self.terminals[params["terminalId"].as_str().unwrap()];
                            json!({ "exitCode": code, "signal": null })
                        }
                        "terminal/output" => {
                            let (text, code) = &self.terminals[params["terminalId"].as_str().unwrap()];
                            json!({ "output": text, "truncated": false, "exitStatus": { "exitCode": code, "signal": null } })
                        }
                        "terminal/release" | "terminal/kill" => json!({}),
                        other => panic!("the agent asked for {other}"),
                    };
                    self.write(&json!({ "jsonrpc": "2.0", "id": message["id"], "result": result })).await;
                }
                None => panic!("an answer to nothing we asked: {message}"),
            }
        }
    }

    async fn request(&mut self, method: &str, params: Value) -> Value {
        let id = self.send(method, params).await;
        self.until(id).await
    }

    /// The `update`s of a kind since [from].
    fn updates_of(&self, from: usize, kind: &str) -> Vec<Value> {
        self.updates[from..]
            .iter()
            .filter(|u| u["update"]["sessionUpdate"] == kind)
            .map(|u| u["update"].clone())
            .collect()
    }

    fn text_since(&self, from: usize) -> String {
        self.updates_of(from, "agent_message_chunk")
            .iter()
            .map(|u| u["content"]["text"].as_str().unwrap().to_owned())
            .collect()
    }
}

fn setup(name: &str) -> (Homes, std::path::PathBuf, std::path::PathBuf) {
    let dir = temp(&format!("acp-{name}"));
    let homes = Homes::new(&dir);
    let project = dir.join("project");
    std::fs::create_dir_all(&project).unwrap();
    (homes, project, dir)
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn an_editor_runs_sessions_with_approvals_its_own_files_modes_and_cancel() {
    let (homes, project, dir) = setup("main");
    let notes = project.join("notes.txt").display().to_string();
    let script: Shared = Arc::default();
    let url = gateway(script.clone()).await;
    homes.agent_config(&url, support::free_port(), true);
    let mut editor = Editor::start(&homes, &dir.join("acp.log"));

    // Bad lines are answered, not fatal.
    editor.write(&json!("not an object")).await;
    editor.stdin.write_all(b"{ not json\n").await.unwrap();
    let unknown = editor.request("no/such", json!({})).await;
    assert_eq!(unknown["error"]["code"], -32601, "{unknown}");
    let codes: Vec<&Value> = editor.errors.iter().map(|e| &e["error"]["code"]).collect();
    assert_eq!(codes, [&json!(-32600), &json!(-32700)]);

    let init = editor
        .request(
            "initialize",
            json!({ "protocolVersion": 1, "clientCapabilities": { "fs": { "readTextFile": true, "writeTextFile": true }, "terminal": false }, "clientInfo": { "name": "script", "version": "1" } }),
        )
        .await;
    assert_eq!(init["result"]["protocolVersion"], 1, "{init}");
    assert_eq!(init["result"]["agentCapabilities"]["loadSession"], true);
    assert_eq!(init["result"]["agentInfo"]["name"], "autobot");

    let relative = editor.request("session/new", json!({ "cwd": "project", "mcpServers": [] })).await;
    assert_eq!(relative["error"]["code"], -32602, "a relative cwd is refused: {relative}");
    let new = editor.request("session/new", json!({ "cwd": project, "mcpServers": [] })).await;
    let session = new["result"]["sessionId"].as_str().unwrap().to_owned();
    assert!(session.starts_with("acp-"), "{new}");
    assert_eq!(new["result"]["modes"]["currentModeId"], "ask");

    // 1. A write, shown as a diff, asked for, allowed, and made in the editor's buffer.
    script.lock().unwrap().answers.extend([
        (Duration::ZERO, call("w1", "write_file", json!({ "path": "notes.txt", "content": "hello\n" }))),
        (Duration::ZERO, say("Wrote notes.txt.")),
    ]);
    let from = editor.updates.len();
    let done = editor
        .request(
            "session/prompt",
            json!({ "sessionId": session, "prompt": [{ "type": "text", "text": "write hello to notes.txt" }] }),
        )
        .await;
    assert_eq!(done["result"]["stopReason"], "end_turn", "{done}");
    let calls = editor.updates_of(from, "tool_call");
    let diff = &calls[0]["content"][0];
    assert_eq!((diff["type"].as_str(), diff["path"].as_str()), (Some("diff"), Some(notes.as_str())), "{calls:?}");
    assert_eq!(diff["newText"], "hello\n");
    assert_eq!(calls[0]["kind"], "edit");
    let permission = editor.asked.iter().find(|m| m["method"] == "session/request_permission").expect("asked");
    assert_eq!(permission["params"]["toolCall"]["toolCallId"], calls[0]["toolCallId"]);
    let options: Vec<&str> =
        permission["params"]["options"].as_array().unwrap().iter().map(|o| o["kind"].as_str().unwrap()).collect();
    assert_eq!(options, ["allow_once", "allow_always", "reject_once"]);
    assert_eq!(editor.buffers.get(&notes).map(String::as_str), Some("hello\n"), "written through the editor");
    assert!(!project.join("notes.txt").exists(), "not behind the editor's back");
    let finished = editor.updates_of(from, "tool_call_update");
    assert!(
        finished.iter().any(|u| u["toolCallId"] == calls[0]["toolCallId"] && u["status"] == "completed"),
        "{finished:?}"
    );
    assert_eq!(editor.text_since(from), "Wrote notes.txt.", "streamed in pieces");
    assert!(editor.updates_of(from, "agent_message_chunk").len() >= 2);

    // 2. A read sees the editor's buffer (unsaved changes included).
    editor.buffers.insert(notes.clone(), "hello from the buffer\n".to_owned());
    script.lock().unwrap().answers.extend([
        (Duration::ZERO, call("r1", "read_file", json!({ "path": "notes.txt" }))),
        (Duration::ZERO, say("It says hello.")),
    ]);
    let done = editor
        .request("session/prompt", json!({ "sessionId": session, "prompt": [{ "type": "text", "text": "what does notes.txt say?" }, { "type": "resource_link", "uri": format!("file://{notes}"), "name": "notes.txt" }] }))
        .await;
    assert_eq!(done["result"]["stopReason"], "end_turn");
    let sent = script.lock().unwrap().seen.last().unwrap().clone();
    let tool_result = sent["messages"].as_array().unwrap().iter().rev().find(|m| m["role"] == "tool").unwrap().clone();
    assert!(tool_result["content"].as_str().unwrap().contains("hello from the buffer"), "{tool_result}");
    let user = sent["messages"].as_array().unwrap().iter().rev().find(|m| m["role"] == "user").unwrap().clone();
    assert!(user["content"].as_str().unwrap().contains(&notes), "the link is in the prompt: {user}");

    // An edit is shown, and made, against the buffer as it is (the text exists only there).
    editor.answer = Answer::Allow;
    script.lock().unwrap().answers.extend([
        (
            Duration::ZERO,
            call(
                "e1",
                "edit_file",
                json!({ "path": "notes.txt", "old_text": "from the buffer", "new_text": "edited" }),
            ),
        ),
        (Duration::ZERO, say("Edited.")),
    ]);
    let from = editor.updates.len();
    let done = editor
        .request("session/prompt", json!({ "sessionId": session, "prompt": [{ "type": "text", "text": "edit it" }] }))
        .await;
    assert_eq!(done["result"]["stopReason"], "end_turn", "{done}");
    let edit = &editor.updates_of(from, "tool_call")[0];
    assert_eq!(edit["content"][0]["oldText"], "hello from the buffer\n", "{edit}");
    assert_eq!(edit["content"][0]["newText"], "hello edited\n");
    assert_eq!(editor.buffers[&notes], "hello edited\n");

    // 3. A command the editor rejects does not run, and the call fails.
    editor.answer = Answer::Reject;
    let marker = project.join("ran");
    script.lock().unwrap().answers.extend([
        (Duration::ZERO, call("t1", "terminal", json!({ "command": format!("touch {}", marker.display()) }))),
        (Duration::ZERO, say("I will not, then.")),
    ]);
    let from = editor.updates.len();
    let done = editor
        .request("session/prompt", json!({ "sessionId": session, "prompt": [{ "type": "text", "text": "touch it" }] }))
        .await;
    assert_eq!(done["result"]["stopReason"], "end_turn");
    assert!(!marker.exists(), "rejected: not run");
    let pending = editor.updates_of(from, "tool_call");
    assert_eq!((pending[0]["kind"].as_str(), pending[0]["status"].as_str()), (Some("execute"), Some("pending")));
    let failed = editor.updates_of(from, "tool_call_update");
    assert!(
        failed.iter().any(|u| u["toolCallId"] == pending[0]["toolCallId"] && u["status"] == "failed"),
        "{failed:?}"
    );

    // 4. In trust mode the same runs without asking.
    let set = editor.request("session/set_mode", json!({ "sessionId": session, "modeId": "trust" })).await;
    assert_eq!(set["result"], json!({}), "{set}");
    let asked = editor.asked.len();
    script.lock().unwrap().answers.extend([
        (Duration::ZERO, call("t2", "terminal", json!({ "command": format!("touch {}", marker.display()) }))),
        (Duration::ZERO, say("Done.")),
    ]);
    let done = editor
        .request(
            "session/prompt",
            json!({ "sessionId": session, "prompt": [{ "type": "text", "text": "touch it now" }] }),
        )
        .await;
    assert_eq!(done["result"]["stopReason"], "end_turn");
    assert!(marker.exists(), "trusted: it ran");
    assert!(!editor.asked[asked..].iter().any(|m| m["method"] == "session/request_permission"), "nothing asked");

    // 5. Cancel: a slow model, and the editor gives up on it.
    script.lock().unwrap().answers.push_back((Duration::from_secs(30), say("too late")));
    let id = editor
        .send("session/prompt", json!({ "sessionId": session, "prompt": [{ "type": "text", "text": "think long" }] }))
        .await;
    tokio::time::sleep(Duration::from_millis(500)).await;
    editor.write(&json!({ "jsonrpc": "2.0", "method": "session/cancel", "params": { "sessionId": session } })).await;
    let started = std::time::Instant::now();
    let cancelled = editor.until(id).await;
    assert_eq!(cancelled["result"]["stopReason"], "cancelled", "{cancelled}");
    assert!(started.elapsed() < Duration::from_secs(5));

    // Every tool call of the session has an id of its own, across its turns.
    let ids: Vec<String> =
        editor.updates_of(0, "tool_call").iter().map(|u| u["toolCallId"].as_str().unwrap().to_owned()).collect();
    let unique: std::collections::HashSet<&String> = ids.iter().collect();
    assert_eq!(unique.len(), ids.len(), "{ids:?}");
    // Loaded again in the same editor (idle): told again from memory.
    let from = editor.updates.len();
    let reloaded =
        editor.request("session/load", json!({ "sessionId": session, "cwd": project, "mcpServers": [] })).await;
    assert!(reloaded.get("result").is_some(), "{reloaded}");
    assert_eq!(editor.updates_of(from, "user_message_chunk")[0]["content"]["text"], "write hello to notes.txt");

    // 6. The session again, in a new editor: told from its start.
    drop(editor);
    let mut again = Editor::start(&homes, &dir.join("acp2.log"));
    again.request("initialize", json!({ "protocolVersion": 1, "clientCapabilities": {} })).await;
    let missing =
        again.request("session/load", json!({ "sessionId": "acp-nope", "cwd": project, "mcpServers": [] })).await;
    assert!(missing.get("error").is_some(), "{missing}");
    let loaded = again.request("session/load", json!({ "sessionId": session, "cwd": project, "mcpServers": [] })).await;
    assert!(loaded.get("result").is_some(), "{loaded}");
    let said: Vec<String> = again
        .updates_of(0, "user_message_chunk")
        .iter()
        .map(|u| u["content"]["text"].as_str().unwrap().to_owned())
        .collect();
    assert_eq!(said[0], "write hello to notes.txt", "{said:?}");
    assert!(again.text_since(0).contains("Wrote notes.txt."));
    assert!(again.updates_of(0, "tool_call").iter().any(|c| c["toolCallId"] == "w1"));
    // Without the editor's files, its own disk: the file the first editor kept in its buffer is
    // not there, and a read says so.
    script.lock().unwrap().answers.extend([
        (Duration::ZERO, call("r2", "read_file", json!({ "path": "notes.txt" }))),
        (Duration::ZERO, say("Nothing there.")),
    ]);
    let done = again
        .request("session/prompt", json!({ "sessionId": session, "prompt": [{ "type": "text", "text": "read it" }] }))
        .await;
    assert_eq!(done["result"]["stopReason"], "end_turn", "{done}");
    assert!(again.asked.iter().all(|m| m["method"] != "fs/read_text_file"));
    // Done: the line closes and the agent ends.
    drop(again.stdin);
    let status = tokio::time::timeout(Duration::from_secs(10), again.child.wait()).await.unwrap().unwrap();
    assert!(status.success(), "{status}");
    let _ = TOKEN;
    let _ = std::fs::remove_dir_all(dir);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn an_editor_lends_its_terminal_and_mcp_servers_and_has_commands() {
    let (homes, project, dir) = setup("terminal");
    let script: Shared = Arc::default();
    let url = gateway(script.clone()).await;
    homes.agent_config(&url, support::free_port(), true);
    let mut editor = Editor::start(&homes, &dir.join("acp.log"));
    let init =
        editor.request("initialize", json!({ "protocolVersion": 1, "clientCapabilities": { "terminal": true } })).await;
    assert_eq!(init["result"]["protocolVersion"], 1, "{init}");
    let fixture = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/mcp_server.py");
    let new = editor
        .request(
            "session/new",
            json!({ "cwd": project, "mcpServers": [
                { "name": "calc", "command": "python3", "args": [fixture.display().to_string()], "env": [] },
            ] }),
        )
        .await;
    let session = new["result"]["sessionId"].as_str().unwrap().to_owned();
    let options: Vec<&str> =
        new["result"]["configOptions"].as_array().unwrap().iter().map(|o| o["id"].as_str().unwrap()).collect();
    assert!(options.contains(&"mode"), "{new}");

    // The commands are told once the session is open.
    let request = editor.request("session/set_mode", json!({ "sessionId": session, "modeId": "ask" })).await;
    assert!(request.get("result").is_some(), "{request}");
    let commands = editor.updates_of(0, "available_commands_update");
    let names: Vec<&str> =
        commands[0]["availableCommands"].as_array().unwrap().iter().map(|c| c["name"].as_str().unwrap()).collect();
    assert!(names.contains(&"help") && names.contains(&"recall"), "{names:?}");

    // 1. A command runs in the editor's terminal, shown in its call.
    script.lock().unwrap().answers.extend([
        (Duration::ZERO, call("t1", "terminal", json!({ "command": "echo from-the-terminal; exit 3" }))),
        (Duration::ZERO, say("It said so.")),
    ]);
    let from = editor.updates.len();
    let done = editor
        .request("session/prompt", json!({ "sessionId": session, "prompt": [{ "type": "text", "text": "run it" }] }))
        .await;
    assert_eq!(done["result"]["stopReason"], "end_turn", "{done}");
    assert_eq!(editor.terminals.len(), 1, "run in the editor's terminal");
    let shown = editor.updates_of(from, "tool_call_update");
    assert!(shown.iter().any(|u| u["content"][0]["type"] == "terminal"), "{shown:?}");
    let sent = script.lock().unwrap().seen.last().unwrap().clone();
    let result = sent["messages"].as_array().unwrap().iter().rev().find(|m| m["role"] == "tool").unwrap().clone();
    let result = result["content"].as_str().unwrap();
    assert!(result.contains("from-the-terminal") && result.contains("exit code 3"), "{result}");

    // 2. The editor's MCP server: its tools are offered, and one runs.
    script.lock().unwrap().answers.extend([
        (Duration::ZERO, call("m1", "calc__add", json!({ "a": 2, "b": 40 }))),
        (Duration::ZERO, say("It is 42.")),
    ]);
    let done = editor
        .request("session/prompt", json!({ "sessionId": session, "prompt": [{ "type": "text", "text": "2 + 40?" }] }))
        .await;
    assert_eq!(done["result"]["stopReason"], "end_turn", "{done}");
    let seen = script.lock().unwrap().seen.clone();
    let offered: Vec<String> = seen[seen.len() - 2]["tools"]
        .as_array()
        .unwrap()
        .iter()
        .map(|t| t["function"]["name"].as_str().unwrap().to_owned())
        .collect();
    assert!(offered.contains(&"calc__add".to_owned()), "{offered:?}");
    let result = seen.last().unwrap()["messages"]
        .as_array()
        .unwrap()
        .iter()
        .rev()
        .find(|m| m["role"] == "tool")
        .unwrap()
        .clone();
    assert!(result["content"].as_str().unwrap().contains("42"), "{result}");

    // 3. A slash command answered here, without a model call.
    let calls = script.lock().unwrap().seen.len();
    let from = editor.updates.len();
    let done = editor
        .request("session/prompt", json!({ "sessionId": session, "prompt": [{ "type": "text", "text": "/help" }] }))
        .await;
    assert_eq!(done["result"]["stopReason"], "end_turn", "{done}");
    assert!(editor.text_since(from).contains("/recall"), "{}", editor.text_since(from));
    assert_eq!(script.lock().unwrap().seen.len(), calls, "no model call");
    let _ = std::fs::remove_dir_all(dir);
}
