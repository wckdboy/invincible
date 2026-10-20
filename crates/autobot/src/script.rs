//! `execute_code`: a short Python or shell script the agent writes and runs like a command
//! (same approval, sandbox, container or SSH machine), which can call the agent's read-only
//! tools without a model turn per call: `search`, `read_file`, `find_files`, `list_dir`,
//! `search_sessions`, `read_skill`, and `web_fetch` (asked for like any fetch). A pipeline of
//! twenty searches and reads costs one tool call.
//!
//! The script talks to the agent over its own stdin and stdout: a call is a line
//! `\x1eAUTOBOT_RPC {"tool": …, "args": {…}}` on stdout, the answer one line back on stdin
//! (JSON for Python; for the shell, the text with its line breaks as `\x1f`). Everything else
//! the script prints is its output.

use std::time::Duration;

use serde_json::{Value, json};
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt};

/// What starts a call on the script's stdout.
pub const MARK: &str = "\x1eAUTOBOT_RPC ";
/// Longest script (bytes): it goes on the command line.
pub const MAX_CODE: usize = 64 * 1024;
/// Most tool calls one script makes.
pub const MAX_CALLS: usize = 200;
/// The tools a script can call.
pub const TOOLS: &[&str] =
    &["search", "read_file", "find_files", "list_dir", "search_sessions", "read_skill", "web_fetch"];

const PYTHON: &str = r#"import json as _json, sys as _sys
def _call(_tool, **args):
    _sys.stdout.write("\x1eAUTOBOT_RPC " + _json.dumps({"tool": _tool, "args": {k: v for k, v in args.items() if v is not None}}) + "\n")
    _sys.stdout.flush()
    line = _sys.stdin.readline()
    if not line:
        raise RuntimeError("the agent went away")
    reply = _json.loads(line)
    if "error" in reply:
        raise RuntimeError(reply["error"])
    return reply["result"]
def search(pattern, path=None, glob=None, ignore_case=None): return _call("search", pattern=pattern, path=path, glob=glob, ignore_case=ignore_case)
def read_file(path, offset=None, limit=None): return _call("read_file", path=path, offset=offset, limit=limit)
def find_files(pattern, path=None): return _call("find_files", pattern=pattern, path=path)
def list_dir(path=None): return _call("list_dir", path=path)
def search_sessions(query): return _call("search_sessions", query=query)
def read_skill(name, file=None): return _call("read_skill", name=name, file=file)
def web_fetch(url): return _call("web_fetch", url=url)
"#;

const SHELL: &str = r#"autobot_tool() {
  _autobot_args=${2-}
  [ -n "$_autobot_args" ] || _autobot_args='{}'
  printf '\036AUTOBOT_RPC {"tool": "%s", "args": %s}\n' "$1" "$_autobot_args"
  IFS= read -r _autobot_reply || return 1
  case "$_autobot_reply" in "error: "*) printf '%s\n' "$_autobot_reply" >&2; return 1;; esac
  printf '%s\n' "$_autobot_reply" | tr '\037' '\n'
}
"#;

/// Answers a script's calls.
pub trait Rpc: Send {
    fn call<'a>(
        &'a mut self,
        tool: String,
        args: Value,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<String, String>> + Send + 'a>>;
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Language {
    Python,
    Shell,
}

impl Language {
    pub fn parse(name: &str) -> Result<Self, String> {
        match name.trim().to_lowercase().as_str() {
            "" | "python" | "python3" | "py" => Ok(Self::Python),
            "sh" | "shell" | "bash" => Ok(Self::Shell),
            other => Err(format!("{other:?}: python or sh")),
        }
    }

    pub fn name(self) -> &'static str {
        match self {
            Self::Python => "python3",
            Self::Shell => "sh",
        }
    }
}

/// The command line that runs [code] with its helper (`sh -c` runs it).
pub fn command_line(language: Language, code: &str) -> Result<String, String> {
    if code.trim().is_empty() {
        return Err("the code is empty".to_owned());
    }
    if code.len() > MAX_CODE {
        return Err(format!("the script is {} bytes; at most {MAX_CODE}", code.len()));
    }
    let q = crate::ssh::quote;
    Ok(match language {
        Language::Python => format!("python3 -I -u -c {}", q(&format!("{PYTHON}{code}"))),
        Language::Shell => format!("sh -c {}", q(&format!("{SHELL}{code}"))),
    })
}

/// How the script is shown for approval: what it is, then the code.
pub fn shown(language: Language, code: &str) -> String {
    format!("{} - <<'EOF'\n{}\nEOF", language.name(), code.trim_end())
}

/// A call from the script: the tool and its arguments.
pub fn request(line: &str) -> Option<Result<(String, Value), String>> {
    let rest = line.strip_prefix(MARK)?;
    let parsed = serde_json::from_str::<Value>(rest.trim()).map_err(|e| format!("not a call: {e}"));
    Some(parsed.and_then(|v| {
        let tool = v["tool"].as_str().ok_or("no tool named")?.to_owned();
        let args = if v["args"].is_object() { v["args"].clone() } else { json!({}) };
        Ok((tool, args))
    }))
}

/// The answer line for the script.
pub fn reply(language: Language, result: &Result<String, String>) -> String {
    match language {
        Language::Python => match result {
            Ok(text) => json!({ "result": text }).to_string(),
            Err(e) => json!({ "error": e }).to_string(),
        },
        Language::Shell => match result {
            Ok(text) => text.replace('\r', "").replace('\n', "\x1f"),
            Err(e) => format!("error: {}", e.replace(['\n', '\r'], " ")),
        },
    }
}

/// Runs [command] (made by the tools' backend, stdin to be piped), answering its calls with
/// [rpc] as they come, for at most [timeout]. What it printed (to [limit]), its exit code, and
/// the calls it made.
pub async fn run(
    mut command: tokio::process::Command,
    language: Language,
    timeout: Duration,
    limit: usize,
    rpc: &mut dyn Rpc,
) -> Result<String, String> {
    let mut child = command
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .map_err(|e| format!("{}: {e}", language.name()))?;
    let mut stdin = child.stdin.take().expect("piped");
    let mut stdout = tokio::io::BufReader::new(child.stdout.take().expect("piped"));
    let mut stderr = child.stderr.take().expect("piped");
    let errors = tokio::spawn(async move {
        let mut err = Vec::new();
        let _ = (&mut stderr).take(1 << 20).read_to_end(&mut err).await;
        String::from_utf8_lossy(&err).into_owned()
    });
    let mut out = String::new();
    let mut calls = 0;
    let work = async {
        let mut line = Vec::new();
        loop {
            line.clear();
            let n = stdout.read_until(b'\n', &mut line).await.map_err(|e| e.to_string())?;
            if n == 0 {
                break;
            }
            let text = String::from_utf8_lossy(&line);
            match request(text.trim_end_matches(['\n', '\r'])) {
                Some(call) => {
                    calls += 1;
                    let result = match call {
                        _ if calls > MAX_CALLS => Err(format!("at most {MAX_CALLS} tool calls from one script")),
                        Ok((tool, args)) if TOOLS.contains(&tool.as_str()) => rpc.call(tool, args).await,
                        Ok((tool, _)) => Err(format!("{tool:?} is not for scripts (they have: {})", TOOLS.join(", "))),
                        Err(e) => Err(e),
                    };
                    let mut answer = reply(language, &result);
                    answer.push('\n');
                    // A script that stopped reading has ended; what it printed still counts.
                    if stdin.write_all(answer.as_bytes()).await.is_err() {
                        continue;
                    }
                    let _ = stdin.flush().await;
                }
                None if out.len() < 4 * limit => out.push_str(&text),
                None => {}
            }
        }
        child.wait().await.map_err(|e| e.to_string())
    };
    let status = match tokio::time::timeout(timeout, work).await {
        Ok(status) => status?,
        Err(_) => {
            return Err(format!(
                "stopped after {} seconds ({calls} tool calls); output so far:\n{}",
                timeout.as_secs(),
                crate::tools::cut_to(out, limit / 2)
            ));
        }
    };
    let err = errors.await.unwrap_or_default();
    if !err.is_empty() {
        out.push_str(&err);
    }
    let code = status.code().map_or("killed by a signal".to_owned(), |c| format!("exit code {c}"));
    let sep = if out.is_empty() || out.ends_with('\n') { "" } else { "\n" };
    let made =
        if calls == 0 { String::new() } else { format!(", {calls} tool call{}", if calls == 1 { "" } else { "s" }) };
    Ok(crate::tools::cut_to(format!("{out}{sep}[{code}{made}]"), limit))
}

/// The tool's definition.
pub fn definition() -> Value {
    json!({ "type": "function", "function": {
        "name": "execute_code",
        "description": "Run a short Python 3 (or sh) script, approved like a command, that can call your read-only tools as functions without a turn each: search(pattern, path, glob, ignore_case), read_file(path, offset, limit), find_files(pattern, path), list_dir(path), search_sessions(query), read_skill(name, file), web_fetch(url) (asked for like a fetch). They return text (Python raises RuntimeError on errors; in sh: autobot_tool search '{\"pattern\": \"x\"}'). Use it to collapse many reads or searches into one step, then print just what matters: only what it prints comes back.",
        "parameters": { "type": "object", "properties": {
            "language": { "type": "string", "enum": ["python", "sh"], "description": "Default python." },
            "code": { "type": "string" },
        }, "required": ["code"] },
    }})
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn calls_and_replies() {
        assert_eq!(
            request("\x1eAUTOBOT_RPC {\"tool\": \"search\", \"args\": {\"pattern\": \"x\"}}").unwrap().unwrap(),
            ("search".to_owned(), json!({"pattern": "x"}))
        );
        assert!(request("plain output").is_none());
        assert!(request("\x1eAUTOBOT_RPC nope").unwrap().is_err());
        assert_eq!(reply(Language::Python, &Ok("a\nb".into())), r#"{"result":"a\nb"}"#);
        assert_eq!(reply(Language::Shell, &Ok("a\nb\r".into())), "a\x1fb");
        assert_eq!(reply(Language::Shell, &Err("no\nway".into())), "error: no way");
        assert_eq!(Language::parse("Python3").unwrap(), Language::Python);
        assert_eq!(Language::parse("bash").unwrap(), Language::Shell);
        assert!(Language::parse("ruby").is_err());
        assert!(command_line(Language::Python, "  ").is_err());
        assert!(command_line(Language::Python, &"x".repeat(MAX_CODE + 1)).is_err());
        assert!(command_line(Language::Python, "print(1)").unwrap().starts_with("python3 -I -u -c 'import json"));
        assert_eq!(shown(Language::Shell, "ls\n"), "sh - <<'EOF'\nls\nEOF");
    }

    #[tokio::test]
    async fn a_shell_script_calls_tools_through_its_pipes() {
        let line = command_line(
            Language::Shell,
            "echo start\nautobot_tool search '{\"pattern\": \"fn main\"}'\nautobot_tool nope || echo refused\necho end",
        )
        .unwrap();
        let mut command = tokio::process::Command::new("sh");
        command.arg("-c").arg(line);
        struct Seen(Vec<(String, Value)>);
        impl Rpc for Seen {
            fn call<'a>(
                &'a mut self,
                tool: String,
                args: Value,
            ) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<String, String>> + Send + 'a>> {
                self.0.push((tool, args));
                Box::pin(async { Ok("src/main.rs:1: fn main() {}\nsrc/b.rs:3: fn main()".to_owned()) })
            }
        }
        let mut seen = Seen(Vec::new());
        let out = run(command, Language::Shell, Duration::from_secs(10), 16 * 1024, &mut seen).await.unwrap();
        assert_eq!(seen.0, [("search".to_owned(), json!({"pattern": "fn main"}))]);
        assert!(out.starts_with("start\nsrc/main.rs:1: fn main() {}\nsrc/b.rs:3: fn main()\n"), "{out}");
        assert!(out.contains("refused\nend\n"), "{out}");
        assert!(out.contains("\"nope\" is not for scripts"), "the error goes to stderr: {out}");
        assert!(out.ends_with("[exit code 0, 2 tool calls]"), "{out}");
    }
}
