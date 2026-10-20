//! MCP servers (Model Context Protocol, over stdio or Streamable HTTP): their tools become the
//! agent's, named `<server>__<tool>`, each call approved like a command (an `mcp` action;
//! unattended runs only with `mcp:<server>/<tool>` in the allowlist) and logged.
//!
//! ```toml
//! [mcp.github]
//! command = "npx"
//! args = ["-y", "@modelcontextprotocol/server-github"]
//! env = { GITHUB_TOKEN_FILE = "~/.autobot/github.token" }   # passed to the server
//! tools = ["search_repositories", "get_issue"]              # optional: only these
//!
//! [mcp.docs]
//! url = "https://mcp.example.com/mcp"                       # Streamable HTTP
//! headers = { Authorization = "Bearer …" }
//! ```
//!
//! A server is started (or connected to) on first use and kept; one that fails is reported in
//! the tool's result, and the rest of the agent goes on. An HTTP server is reached under the
//! node's network mode: HTTPS, or plain HTTP on this machine.

use std::collections::{BTreeMap, HashMap};
use std::process::Stdio;
use std::sync::Arc;
use std::time::Duration;

use serde::Deserialize;
use serde_json::{Value, json};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::sync::Mutex;

/// The protocol version asked for.
const PROTOCOL: &str = "2025-06-18";

#[derive(Clone, Debug, Default, Deserialize, serde::Serialize)]
#[serde(deny_unknown_fields)]
pub struct ServerConfig {
    /// The program of a server over stdio.
    #[serde(default)]
    pub command: String,
    #[serde(default)]
    pub args: Vec<String>,
    #[serde(default)]
    pub env: BTreeMap<String, String>,
    /// The address of a server over Streamable HTTP, instead of a command.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
    /// Headers sent to it with every request.
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub headers: BTreeMap<String, String>,
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

/// The line to one server (one per server: its size does not matter).
#[allow(clippy::large_enum_variant)]
enum Line {
    Stdio {
        stdin: tokio::process::ChildStdin,
        stdout: tokio::io::Lines<BufReader<tokio::process::ChildStdout>>,
        _child: tokio::process::Child,
    },
    Http {
        client: reqwest::Client,
        url: String,
        headers: BTreeMap<String, String>,
        /// The server's `Mcp-Session-Id`, once it gave one.
        session: Option<String>,
        /// The protocol version the server agreed to, once it did: sent with every request
        /// after `initialize`.
        version: Option<String>,
    },
}

struct Running {
    line: Line,
    next_id: u64,
    tools: Vec<Tool>,
}

impl Running {
    async fn request(&mut self, method: &str, params: Value) -> Result<Value, String> {
        self.next_id += 1;
        let id = self.next_id;
        let message = json!({ "jsonrpc": "2.0", "id": id, "method": method, "params": params });
        let answer = async {
            match &mut self.line {
                Line::Stdio { stdin, stdout, .. } => {
                    stdin.write_all(format!("{message}\n").as_bytes()).await.map_err(|e| e.to_string())?;
                    stdin.flush().await.map_err(|e| e.to_string())?;
                    loop {
                        let Some(line) = stdout.next_line().await.map_err(|e| e.to_string())? else {
                            return Err("the server closed its output".to_owned());
                        };
                        let Ok(message) = serde_json::from_str::<Value>(&line) else { continue };
                        // Notifications and other ids are not ours.
                        if message["id"] == json!(id) {
                            return Ok(message);
                        }
                    }
                }
                line @ Line::Http { .. } => post(line, &message, Some(id)).await,
            }
        };
        let message = tokio::time::timeout(TIMEOUT, answer)
            .await
            .map_err(|_| format!("{method}: no answer in {}s", TIMEOUT.as_secs()))??;
        if let Some(error) = message.get("error") {
            return Err(error["message"].as_str().unwrap_or("error").to_owned());
        }
        Ok(message["result"].clone())
    }

    async fn notify(&mut self, method: &str) -> Result<(), String> {
        let message = json!({ "jsonrpc": "2.0", "method": method });
        match &mut self.line {
            Line::Stdio { stdin, .. } => {
                stdin.write_all(format!("{message}\n").as_bytes()).await.map_err(|e| e.to_string())
            }
            line @ Line::Http { .. } => tokio::time::timeout(TIMEOUT, post(line, &message, None))
                .await
                .map_err(|_| format!("{method}: no answer in {}s", TIMEOUT.as_secs()))?
                .map(drop),
        }
    }
}

/// Posts [message] to an HTTP server: the answer with [id] (JSON, or an event of the stream it
/// opens), or nothing for a notification.
async fn post(line: &mut Line, message: &Value, id: Option<u64>) -> Result<Value, String> {
    let Line::Http { client, url, headers, session, version } = line else {
        return Err("not an HTTP server".to_owned());
    };
    let mut request = client
        .post(url.as_str())
        .header("content-type", "application/json")
        .header("accept", "application/json, text/event-stream")
        .body(message.to_string());
    for (name, value) in headers.iter() {
        request = request.header(name.as_str(), value.as_str());
    }
    if let Some(session) = session.as_deref() {
        request = request.header("mcp-session-id", session);
    }
    if let Some(version) = version.as_deref() {
        request = request.header("mcp-protocol-version", version);
    }
    let response = request.send().await.map_err(|e| e.without_url().to_string())?;
    let status = response.status();
    if let Some(given) = response.headers().get("mcp-session-id").and_then(|v| v.to_str().ok()) {
        *session = Some(given.to_owned());
    }
    if !status.is_success() {
        let text = response.text().await.unwrap_or_default();
        return Err(format!("HTTP {status}: {}", text.chars().take(200).collect::<String>()));
    }
    let Some(id) = id else { return Ok(Value::Null) };
    let streamed = response
        .headers()
        .get("content-type")
        .and_then(|v| v.to_str().ok())
        .is_some_and(|t| t.starts_with("text/event-stream"));
    let ours = |message: &Value| message["id"] == json!(id) && message.get("method").is_none();
    if !streamed {
        let body: Value = response.json().await.map_err(|e| format!("not JSON: {}", e.without_url()))?;
        // One answer, or a batch with ours in it.
        let found = match body {
            Value::Array(list) => list.into_iter().find(ours),
            one => Some(one).filter(ours),
        };
        return found.ok_or_else(|| "the server answered something else".to_owned());
    }
    // Server-sent events: `data:` lines, an empty line ending each event. Bytes are kept until
    // a line is whole, so a character or a line ending split between chunks stays whole.
    use futures_util::StreamExt as _;
    let mut stream = response.bytes_stream();
    let mut pending: Vec<u8> = Vec::new();
    let mut data: Vec<String> = Vec::new();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| e.without_url().to_string())?;
        pending.extend_from_slice(&chunk);
        while let Some(end) = pending.iter().position(|b| *b == b'\n') {
            let raw: Vec<u8> = pending.drain(..=end).collect();
            let line = String::from_utf8_lossy(&raw[..end]);
            let line = line.strip_suffix('\r').unwrap_or(&line);
            if !line.is_empty() {
                if let Some(d) = line.strip_prefix("data:") {
                    data.push(d.strip_prefix(' ').unwrap_or(d).to_owned());
                }
                continue;
            }
            // The event is whole.
            if let Ok(message) = serde_json::from_str::<Value>(&std::mem::take(&mut data).join("\n"))
                && ours(&message)
            {
                return Ok(message);
            }
        }
    }
    Err("the server closed the stream without an answer".to_owned())
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
        for (name, config) in &configs {
            match (&config.url, config.command.is_empty()) {
                (Some(_), false) => return Err(format!("[mcp.{name}]: a command or a url, not both")),
                (None, true) => return Err(format!("[mcp.{name}]: a command (stdio) or a url (HTTP)")),
                (Some(url), true) => {
                    invincible::egress::check(url).map_err(|e| format!("[mcp.{name}] url: {e}"))?;
                }
                (None, false) => {}
            }
        }
        Ok(Self { configs, running: Mutex::default() })
    }

    pub fn is_empty(&self) -> bool {
        self.configs.is_empty()
    }

    /// The servers, by name.
    pub fn names(&self) -> Vec<&str> {
        self.configs.keys().map(String::as_str).collect()
    }

    async fn connect(name: &str, config: &ServerConfig) -> Result<Line, String> {
        if let Some(url) = &config.url {
            let parsed = invincible::egress::check(url)?;
            let client = if crate::net::loopback(parsed.host_str().unwrap_or_default()) {
                invincible::egress::local().build().map_err(|e| e.to_string())?
            } else {
                invincible::egress::client(&crate::network()?)?
            };
            return Ok(Line::Http {
                client,
                url: url.clone(),
                headers: config.headers.clone(),
                session: None,
                version: None,
            });
        }
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
        Ok(Line::Stdio { stdin, stdout, _child: child })
    }

    async fn server(&self, name: &str) -> Result<Arc<Mutex<Running>>, String> {
        let mut running = self.running.lock().await;
        if let Some(server) = running.get(name) {
            return Ok(server.clone());
        }
        let config = self.configs.get(name).ok_or(format!("no MCP server {name:?}"))?;
        let line = Self::connect(name, config).await?;
        let mut server = Running { line, next_id: 0, tools: Vec::new() };
        let agreed = server
            .request(
                "initialize",
                json!({ "protocolVersion": PROTOCOL, "capabilities": {}, "clientInfo": { "name": "autobot", "version": invincible::version::VERSION } }),
            )
            .await
            .map_err(|e| format!("MCP server {name}: initialize: {e}"))?;
        // From here on, every request says which version (`notifications/initialized` too).
        if let Line::Http { version, .. } = &mut server.line {
            *version = Some(agreed["protocolVersion"].as_str().unwrap_or(PROTOCOL).to_owned());
        }
        server.notify("notifications/initialized").await.map_err(|e| format!("MCP server {name}: {e}"))?;
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

#[cfg(test)]
mod tests {
    use super::{Hub, ServerConfig};
    use std::collections::BTreeMap;

    #[test]
    fn a_server_is_a_command_or_an_address() {
        let hub = |config: ServerConfig| Hub::new(BTreeMap::from([("s".to_owned(), config)]));
        assert!(hub(ServerConfig { command: "x".into(), ..Default::default() }).is_ok());
        assert!(hub(ServerConfig { url: Some("https://mcp.example.com/mcp".into()), ..Default::default() }).is_ok());
        assert!(hub(ServerConfig { url: Some("http://127.0.0.1:9/mcp".into()), ..Default::default() }).is_ok());
        assert!(hub(ServerConfig::default()).unwrap_err().contains("a command (stdio) or a url"));
        let both = ServerConfig { command: "x".into(), url: Some("https://a.example".into()), ..Default::default() };
        assert!(hub(both).unwrap_err().contains("not both"));
        let plain = ServerConfig { url: Some("http://mcp.example.com/mcp".into()), ..Default::default() };
        assert!(hub(plain).unwrap_err().contains("only HTTPS"));
        let parsed: ServerConfig =
            toml::from_str("url = \"https://a.example/mcp\"\nheaders = { X-Key = \"k\" }").unwrap();
        assert_eq!(parsed.headers["X-Key"], "k");
    }
}
