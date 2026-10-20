//! MCP servers (Model Context Protocol, stdio transport): their tools become the agent's, named
//! `<server>__<tool>`, each call approved like a command (an `mcp` action; unattended runs only
//! with `mcp:<server>/<tool>` in the allowlist) and logged.
//!
//! ```toml
//! [mcp.github]
//! command = "npx"
//! args = ["-y", "@modelcontextprotocol/server-github"]
//! env = { GITHUB_TOKEN_FILE = "~/.autobot/github.token" }   # passed to the server
//! tools = ["search_repositories", "get_issue"]              # optional: only these
//! ```
//!
//! A server is started on first use and kept running; one that fails to start is reported in
//! the tool's result, and the rest of the agent goes on.

use std::collections::{BTreeMap, HashMap};
use std::process::Stdio;
use std::sync::Arc;
use std::time::Duration;

use serde::Deserialize;
use serde_json::{Value, json};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::sync::Mutex;

#[derive(Clone, Debug, Deserialize, serde::Serialize)]
#[serde(deny_unknown_fields)]
pub struct ServerConfig {
    pub command: String,
    #[serde(default)]
    pub args: Vec<String>,
    #[serde(default)]
    pub env: BTreeMap<String, String>,
    /// Only these of its tools (default: all).
    #[serde(default)]
    pub tools: Option<Vec<String>>,
}

/// A tool an MCP server offers.
#[derive(Clone, Debug)]
pub struct Tool {
    pub server: String,
    pub name: String,
    pub description: String,
    pub schema: Value,
}

impl Tool {
    /// The name the model sees: `<server>__<tool>`.
    pub fn qualified(&self) -> String {
        format!("{}__{}", self.server, self.name)
    }
}

/// How long one request may take.
const TIMEOUT: Duration = Duration::from_secs(60);

struct Running {
    stdin: tokio::process::ChildStdin,
    stdout: tokio::io::Lines<BufReader<tokio::process::ChildStdout>>,
    next_id: u64,
    tools: Vec<Tool>,
    _child: tokio::process::Child,
}

impl Running {
    async fn request(&mut self, method: &str, params: Value) -> Result<Value, String> {
        self.next_id += 1;
        let id = self.next_id;
        let line = json!({ "jsonrpc": "2.0", "id": id, "method": method, "params": params }).to_string();
        self.stdin.write_all(format!("{line}\n").as_bytes()).await.map_err(|e| e.to_string())?;
        self.stdin.flush().await.map_err(|e| e.to_string())?;
        let read = async {
            loop {
                let Some(line) = self.stdout.next_line().await.map_err(|e| e.to_string())? else {
                    return Err("the server closed its output".to_owned());
                };
                let Ok(message) = serde_json::from_str::<Value>(&line) else { continue };
                // Notifications and other ids are not ours.
                if message["id"] != json!(id) {
                    continue;
                }
                if let Some(error) = message.get("error") {
                    return Err(error["message"].as_str().unwrap_or("error").to_owned());
                }
                return Ok(message["result"].clone());
            }
        };
        tokio::time::timeout(TIMEOUT, read)
            .await
            .map_err(|_| format!("{method}: no answer in {}s", TIMEOUT.as_secs()))?
    }

    async fn notify(&mut self, method: &str) -> Result<(), String> {
        let line = json!({ "jsonrpc": "2.0", "method": method }).to_string();
        self.stdin.write_all(format!("{line}\n").as_bytes()).await.map_err(|e| e.to_string())
    }
}

/// The configured servers, started when first needed.
#[derive(Default)]
pub struct Hub {
    configs: BTreeMap<String, ServerConfig>,
    running: Mutex<HashMap<String, Arc<Mutex<Running>>>>,
}

impl std::fmt::Debug for Hub {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Hub").field("servers", &self.configs.keys().collect::<Vec<_>>()).finish()
    }
}

impl Hub {
    pub fn new(configs: BTreeMap<String, ServerConfig>) -> Result<Self, String> {
        if let Some(bad) = configs.keys().find(|n| !crate::team::valid_name(n) || n.contains("__")) {
            return Err(format!("[mcp.{bad}]: a server name is letters, digits, - and _"));
        }
        Ok(Self { configs, running: Mutex::default() })
    }

    pub fn is_empty(&self) -> bool {
        self.configs.is_empty()
    }

    async fn server(&self, name: &str) -> Result<Arc<Mutex<Running>>, String> {
        let mut running = self.running.lock().await;
        if let Some(server) = running.get(name) {
            return Ok(server.clone());
        }
        let config = self.configs.get(name).ok_or(format!("no MCP server {name:?}"))?;
        let mut command = tokio::process::Command::new(crate::config::expand(std::path::Path::new(&config.command)));
        command
            .args(&config.args)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .kill_on_drop(true);
        for (key, value) in &config.env {
            command.env(key, crate::config::expand(std::path::Path::new(value)));
        }
        let mut child = command.spawn().map_err(|e| format!("MCP server {name}: {}: {e}", config.command))?;
        let stdin = child.stdin.take().ok_or("no stdin")?;
        let stdout = BufReader::new(child.stdout.take().ok_or("no stdout")?).lines();
        let mut server = Running { stdin, stdout, next_id: 0, tools: Vec::new(), _child: child };
        server
            .request(
                "initialize",
                json!({ "protocolVersion": "2025-06-18", "capabilities": {}, "clientInfo": { "name": "autobot", "version": invincible::version::VERSION } }),
            )
            .await
            .map_err(|e| format!("MCP server {name}: initialize: {e}"))?;
        server.notify("notifications/initialized").await?;
        let listed = server.request("tools/list", json!({})).await.map_err(|e| format!("MCP server {name}: {e}"))?;
        server.tools = listed["tools"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(|t| {
                let tool = t["name"].as_str()?.to_owned();
                if config.tools.as_ref().is_some_and(|only| !only.contains(&tool)) {
                    return None;
                }
                Some(Tool {
                    server: name.to_owned(),
                    name: tool,
                    description: t["description"].as_str().unwrap_or_default().chars().take(400).collect(),
                    schema: t.get("inputSchema").cloned().unwrap_or_else(|| json!({ "type": "object" })),
                })
            })
            .collect();
        let server = Arc::new(Mutex::new(server));
        running.insert(name.to_owned(), server.clone());
        Ok(server)
    }

    /// Every configured server's tools (starting them); a server that cannot start is skipped,
    /// with why.
    pub async fn tools(&self) -> (Vec<Tool>, Vec<String>) {
        let mut tools = Vec::new();
        let mut problems = Vec::new();
        for name in self.configs.keys() {
            match self.server(name).await {
                Ok(server) => tools.extend(server.lock().await.tools.clone()),
                Err(e) => problems.push(e),
            }
        }
        (tools, problems)
    }

    /// Calls [tool] on [server] with [arguments]: the text of its result.
    pub async fn call(&self, server: &str, tool: &str, arguments: Value) -> Result<String, String> {
        let running = self.server(server).await?;
        let mut running = running.lock().await;
        if !running.tools.iter().any(|t| t.name == tool) {
            return Err(format!("{server} has no tool {tool:?}"));
        }
        let result = match running.request("tools/call", json!({ "name": tool, "arguments": arguments })).await {
            Ok(result) => result,
            Err(e) => {
                // A server that broke is started again next time.
                drop(running);
                self.running.lock().await.remove(server);
                return Err(e);
            }
        };
        let text: Vec<String> = result["content"]
            .as_array()
            .into_iter()
            .flatten()
            .map(|part| match part["type"].as_str() {
                Some("text") => part["text"].as_str().unwrap_or_default().to_owned(),
                Some(kind) => format!("[{kind} content]"),
                None => part.to_string(),
            })
            .collect();
        let text = if text.is_empty() { result.to_string() } else { text.join("\n") };
        if result["isError"] == true { Err(text) } else { Ok(text) }
    }
}
