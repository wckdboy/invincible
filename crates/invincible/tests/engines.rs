//! `invincible serve` and the engines it runs, against a stand-in `llama-server` (a small Python
//! server that takes llama-server's arguments and keeps its key rule), so the test needs neither
//! llama.cpp nor a model.
//!
//! The node is started with secrets and llama.cpp flags in its environment, as a shell might give
//! it: the engine must see none of them, must refuse whoever calls it without its key, and must
//! still answer the node.

use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

use serde_json::{Value, json};

/// llama-server's key rule (tools/server/server-http.cpp, b11721): with keys set (`--api-key`, or
/// `LLAMA_API_KEY`), every path but `/health` and `/v1/health` needs one, as `Authorization:
/// Bearer` or `X-Api-Key`; anything else is a 401 `authentication_error`. On start it writes what
/// it was given to the `--env-out` file: its port, whether its key is on its command line or is
/// the shell's, and the names in its environment.
const STAND_IN: &str = r#"#!/usr/bin/env python3
import http.server, json, os, socketserver, sys
args = sys.argv[1:]
def arg(name):
    return args[args.index(name) + 1] if name in args else None
port, alias = int(arg("--port")), arg("--alias")
keys = [k for k in os.environ.get("LLAMA_API_KEY", "").split(",") if k]
PUBLIC = {"/health", "/v1/health"}
class H(http.server.BaseHTTPRequestHandler):
    def reply(self, status, body):
        data = json.dumps(body).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)
    def allowed(self):
        if not keys or self.path in PUBLIC:
            return True
        given = self.headers.get("Authorization") or self.headers.get("X-Api-Key") or ""
        if given.startswith("Bearer "):
            given = given[len("Bearer "):]
        if given in keys:
            return True
        self.reply(401, {"error": {"message": "Invalid API Key", "type": "authentication_error", "code": 401}})
        return False
    def do_GET(self):
        if not self.allowed():
            return
        if self.path in PUBLIC:
            self.reply(200, {"status": "ok"})
        else:
            self.reply(404, {"error": {"message": "not found"}})
    def do_POST(self):
        self.rfile.read(int(self.headers.get("Content-Length") or 0))
        if not self.allowed():
            return
        self.reply(200, {
            "model": alias,
            "choices": [{"index": 0, "message": {"role": "assistant", "content": "from the engine"}, "finish_reason": "stop"}],
            "usage": {"prompt_tokens": 3, "completion_tokens": 3},
        })
    def log_message(self, *a): pass
class S(http.server.HTTPServer):
    allow_reuse_address = True
    # HTTPServer.server_bind does a reverse DNS lookup, which can take seconds on CI runners.
    def server_bind(self):
        socketserver.TCPServer.server_bind(self)
        self.server_name, self.server_port = self.server_address[:2]
server = S(("127.0.0.1", port), H)
out = arg("--env-out")
with open(out + ".tmp", "w") as f:
    json.dump({
        "port": port,
        "key_in_argv": any(k in a for k in keys for a in args),
        "shell_key": "a-key-from-the-shell" in keys,
        "env": sorted(os.environ),
    }, f)
os.replace(out + ".tmp", out)
server.serve_forever()
"#;

/// Set in the node's environment, never to reach an engine: a provider key named in `api_key_env`,
/// another the shell happens to hold, and llama.cpp flags that turn on its file and shell tools.
const SECRETS: &[(&str, &str)] = &[
    ("INVINCIBLE_TEST_PROVIDER_KEY", "sk-provider"),
    ("OPENAI_API_KEY", "sk-openai"),
    ("LLAMA_ARG_TOOLS", "all"),
    ("LLAMA_ARG_AGENT", "1"),
];

/// A key of the shell's own for llama-server, which must not become the engine's.
const SHELL_KEY: (&str, &str) = ("LLAMA_API_KEY", "a-key-from-the-shell");

const TOKEN: &str = "node-token";

struct Node {
    child: Child,
    dir: PathBuf,
}

impl Drop for Node {
    fn drop(&mut self) {
        // SIGTERM, so the node stops its engine with it.
        let _ = Command::new("kill").arg(self.child.id().to_string()).status();
        let deadline = Instant::now() + Duration::from_secs(10);
        while Instant::now() < deadline && !matches!(self.child.try_wait(), Ok(Some(_))) {
            std::thread::sleep(Duration::from_millis(50));
        }
        let _ = self.child.kill();
        let _ = self.child.wait();
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

fn port() -> u16 {
    std::net::TcpListener::bind("127.0.0.1:0").unwrap().local_addr().unwrap().port()
}

/// `invincible serve` with one model on the stand-in and a cloud model whose key is in the
/// environment, offline (the default), with [SECRETS] and [env] in its environment.
fn serve(tag: &str, env: &[(&str, &str)]) -> (Node, String) {
    let dir = std::env::temp_dir().join(format!("invincible-engines-{tag}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(dir.join("bin")).unwrap();
    let program = dir.join("bin/llama-server");
    std::fs::write(&program, STAND_IN).unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&program, std::fs::Permissions::from_mode(0o755)).unwrap();
    }
    std::fs::write(dir.join("small.gguf"), b"GGUF").unwrap();
    std::fs::write(dir.join("token"), format!("{TOKEN}\n")).unwrap();
    let listen = format!("127.0.0.1:{}", port());
    let config = format!(
        "listen = \"{listen}\"\n\
         [engine]\n\
         llama_server = {program:?}\n\
         extra_args = [\"--env-out\", {out:?}]\n\
         [[models]]\n\
         id = \"small\"\n\
         path = {model:?}\n\
         [[cloud]]\n\
         id = \"frontier\"\n\
         base_url = \"https://api.example.org/v1\"\n\
         api_key_env = \"INVINCIBLE_TEST_PROVIDER_KEY\"\n\
         data_policy = \"no-retention\"\n",
        program = program.display().to_string(),
        out = dir.join("engine.json").display().to_string(),
        model = dir.join("small.gguf").display().to_string(),
    );
    std::fs::write(dir.join("config.toml"), config).unwrap();
    let log = std::fs::File::create(dir.join("serve.log")).unwrap();
    let child = Command::new(env!("CARGO_BIN_EXE_invincible"))
        .arg("serve")
        .env("INVINCIBLE_HOME", &dir)
        .env("HOME", &dir)
        .env("CUDA_VISIBLE_DEVICES", "0")
        .envs(SECRETS.iter().chain(env).copied())
        .stdin(Stdio::null())
        .stdout(log.try_clone().unwrap())
        .stderr(log)
        .spawn()
        .unwrap();
    (Node { child, dir }, format!("http://{listen}"))
}

/// What the stand-in wrote when it started.
async fn started(dir: &Path) -> Value {
    let path = dir.join("engine.json");
    let deadline = Instant::now() + Duration::from_secs(20);
    loop {
        if let Ok(text) = std::fs::read_to_string(&path) {
            return serde_json::from_str(&text).unwrap();
        }
        if Instant::now() > deadline {
            let log = std::fs::read_to_string(dir.join("serve.log")).unwrap_or_default();
            panic!("the engine did not start; node log:\n{log}");
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
}

fn chat() -> Value {
    json!({ "model": "small", "messages": [{ "role": "user", "content": "hi" }] })
}

/// The node's answer through its own API, once the engine is healthy (its health probe works).
async fn through_the_node(url: &str) -> Value {
    let client = reqwest::Client::new();
    let deadline = Instant::now() + Duration::from_secs(20);
    loop {
        let response = client.post(format!("{url}/v1/chat/completions")).bearer_auth(TOKEN).json(&chat()).send().await;
        if let Ok(response) = response
            && response.status() == 200
        {
            return response.json().await.unwrap();
        }
        assert!(Instant::now() < deadline, "the node never answered through its engine");
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
}

#[tokio::test]
async fn an_engine_answers_the_node_and_no_one_else() {
    let (node, url) = serve("door", &[]);
    let engine = started(&node.dir).await;
    let engine_url = format!("http://127.0.0.1:{}", engine["port"]);
    let client = reqwest::Client::new();
    // Health is public in llama-server, and says nothing.
    let deadline = Instant::now() + Duration::from_secs(10);
    while !client.get(format!("{engine_url}/health")).send().await.is_ok_and(|r| r.status() == 200) {
        assert!(Instant::now() < deadline, "the engine never answered /health");
        tokio::time::sleep(Duration::from_millis(50)).await;
    }

    // Anyone else on the machine, straight to the engine's port: no answer without its key, in
    // either header llama-server reads.
    let direct = client.post(format!("{engine_url}/v1/chat/completions")).json(&chat()).send().await.unwrap();
    assert_eq!(direct.status(), 401, "the engine answered a caller without its key");
    let refusal: Value = direct.json().await.unwrap();
    assert_eq!(refusal["error"]["type"], "authentication_error");
    let guessed = client
        .post(format!("{engine_url}/v1/messages"))
        .header("x-api-key", "guessed")
        .json(&chat())
        .send()
        .await
        .unwrap();
    assert_eq!(guessed.status(), 401);

    // The node itself is answered, and the key went through the environment, not the command
    // line `ps` shows.
    let answer = through_the_node(&url).await;
    assert_eq!(answer["choices"][0]["message"]["content"], "from the engine");
    assert_eq!(engine["key_in_argv"], false);
    drop(node);
}

#[tokio::test]
async fn an_engine_inherits_no_secret_and_no_llama_flag() {
    let (node, url) = serve("env", &[SHELL_KEY]);
    let engine = started(&node.dir).await;
    let names: Vec<&str> = engine["env"].as_array().unwrap().iter().map(|n| n.as_str().unwrap()).collect();
    for (name, _) in SECRETS {
        assert!(!names.contains(name), "{name} reached the engine: {names:?}");
    }
    assert!(!names.iter().any(|n| n.starts_with("LLAMA_ARG_")), "{names:?}");
    // The node's own settings stay with the node.
    assert!(!names.contains(&"INVINCIBLE_HOME"), "{names:?}");
    // What the engine needs does reach it: a key (the node's, not the shell's), where programs
    // are, and which GPU to use.
    for name in ["LLAMA_API_KEY", "PATH", "HOME", "CUDA_VISIBLE_DEVICES"] {
        assert!(names.contains(&name), "{name} is missing: {names:?}");
    }
    assert_eq!(engine["shell_key"], false, "the shell's LLAMA_API_KEY became the engine's");
    // A shell's key for llama-server does not lock the node out of its own engine.
    let answer = through_the_node(&url).await;
    assert_eq!(answer["choices"][0]["message"]["content"], "from the engine");
    drop(node);
}
