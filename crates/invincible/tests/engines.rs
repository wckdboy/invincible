//! `invincible serve` and the engines it runs, against a stand-in `llama-server` (a small Python
//! server that takes llama-server's arguments and keeps its key rule), so the test needs neither
//! llama.cpp nor a model.
//!
//! The node is started with secrets and llama.cpp flags in its environment, as a shell might give
//! it: the engine must see none of them, must refuse whoever calls it without its key, and must
//! still answer the node. An engine that does not take the key it is given is not served, and is
//! stopped with what it started, as it is when the node stops.

use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

use serde_json::{Value, json};

/// llama-server's key rule (tools/server/server-http.cpp, b11887): with keys set
/// (`--api-key-file`, one per line, or `LLAMA_API_KEY`), every path but `/health` and `/v1/health`
/// needs one, as `Authorization: Bearer` or `X-Api-Key`; anything else is a 401
/// `authentication_error`. Given `--ignore-api-key-file`, it stands in for an engine that does not
/// take the key the node gives it, and answers everyone; given `--leave-group` too, for one the
/// node cannot stop (a container), in a process group of its own, gone by itself after a minute.
/// On start it writes what it was given to the `--env-out` file: its process and port, whether
/// its key is on its command line or is the shell's, its key file's mode, and the names in its
/// environment.
const STAND_IN: &str = r#"#!/usr/bin/env python3
import http.server, json, os, socketserver, sys, threading
args = sys.argv[1:]
def arg(name):
    return args[args.index(name) + 1] if name in args else None
port, alias = int(arg("--port")), arg("--alias")
key_file = arg("--api-key-file")
keys = [k for k in os.environ.get("LLAMA_API_KEY", "").split(",") if k]
if key_file and "--ignore-api-key-file" not in args:
    keys += [line for line in open(key_file).read().splitlines() if line]
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
if "--leave-group" in args:
    os.setpgid(0, 0)
    threading.Timer(60, lambda: os._exit(0)).start()
out = arg("--env-out")
with open(out + ".tmp", "w") as f:
    json.dump({
        "pid": os.getpid(),
        "port": port,
        "key_in_argv": any(k in a for k in keys for a in args),
        "key_file_mode": oct(os.stat(key_file).st_mode & 0o777) if key_file else None,
        "shell_key": "a-key-from-the-shell" in keys,
        "env": sorted(os.environ),
    }, f)
os.replace(out + ".tmp", out)
server.serve_forever()
"#;

/// Set in the node's environment, never to reach an engine: a provider key named in `api_key_env`,
/// another the shell happens to hold, llama.cpp flags that turn on its file and shell tools, and a
/// library ggml would load into the engine.
const SECRETS: &[(&str, &str)] = &[
    ("INVINCIBLE_TEST_PROVIDER_KEY", "sk-provider"),
    ("OPENAI_API_KEY", "sk-openai"),
    ("LLAMA_ARG_TOOLS", "all"),
    ("LLAMA_ARG_AGENT", "1"),
    ("GGML_BACKEND_PATH", "/tmp/not-a-backend.so"),
];

/// A key of the shell's own for llama-server, which must not become the engine's.
const SHELL_KEY: (&str, &str) = ("LLAMA_API_KEY", "a-key-from-the-shell");

const TOKEN: &str = "node-token";

struct Node {
    child: Child,
    dir: PathBuf,
}

impl Node {
    /// Sends the node [signal] (`-TERM`, as `kill` takes it), unless it has exited; whether it has
    /// exited within 10 s.
    fn stop(&mut self, signal: &str) -> bool {
        if matches!(self.child.try_wait(), Ok(None)) {
            let _ = Command::new("kill").args([signal, &self.child.id().to_string()]).status();
        }
        let deadline = Instant::now() + Duration::from_secs(10);
        while Instant::now() < deadline {
            if matches!(self.child.try_wait(), Ok(Some(_))) {
                return true;
            }
            std::thread::sleep(Duration::from_millis(50));
        }
        false
    }

    /// The node's log once it says [what].
    async fn logged(&self, what: &str) -> String {
        let deadline = Instant::now() + Duration::from_secs(20);
        loop {
            let log = std::fs::read_to_string(self.dir.join("serve.log")).unwrap_or_default();
            if log.contains(what) {
                return log;
            }
            assert!(Instant::now() < deadline, "the node never said {what:?}; node log:\n{log}");
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
    }
}

impl Drop for Node {
    fn drop(&mut self) {
        // SIGTERM, so the node stops its engine with it.
        if !self.stop("-TERM") {
            let _ = self.child.kill();
            let _ = self.child.wait();
        }
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

/// How the node runs the stand-in: as its `llama-server`, or through a script that runs it without
/// `exec`, as a wrapper might, so the server is the script's child and not the node's.
#[derive(Clone, Copy)]
enum Run {
    Direct,
    Wrapped,
}

fn port() -> u16 {
    std::net::TcpListener::bind("127.0.0.1:0").unwrap().local_addr().unwrap().port()
}

/// `invincible serve` with one model on the stand-in (given [args] too, and run as [run] says) and
/// a cloud model whose key is in the environment, offline (the default), with [SECRETS] and [env]
/// in its environment.
fn serve(tag: &str, env: &[(&str, &str)], args: &[&str], run: Run) -> (Node, String) {
    let dir = std::env::temp_dir().join(format!("invincible-engines-{tag}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(dir.join("bin")).unwrap();
    let program = dir.join("bin/llama-server");
    let stand_in = match run {
        Run::Direct => program.clone(),
        Run::Wrapped => dir.join("bin/stand-in.py"),
    };
    std::fs::write(&stand_in, STAND_IN).unwrap();
    if let Run::Wrapped = run {
        let script = format!("#!/bin/sh\n{stand_in:?} \"$@\"\necho \"the stand-in exited: $?\"\n");
        std::fs::write(&program, script).unwrap();
    }
    #[cfg(unix)]
    for file in [&program, &stand_in] {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(file, std::fs::Permissions::from_mode(0o755)).unwrap();
    }
    std::fs::write(dir.join("small.gguf"), b"GGUF").unwrap();
    std::fs::write(dir.join("token"), format!("{TOKEN}\n")).unwrap();
    let listen = format!("127.0.0.1:{}", port());
    let config = format!(
        "listen = \"{listen}\"\n\
         [engine]\n\
         llama_server = {program:?}\n\
         extra_args = [\"--env-out\", {out:?}{args}]\n\
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
        args = args.iter().map(|a| format!(", {a:?}")).collect::<String>(),
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
    let (node, url) = serve("door", &[], &[], Run::Direct);
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

    // The node itself is answered, and the key went in a file only the node's user can read, not
    // on the command line `ps` shows.
    let answer = through_the_node(&url).await;
    assert_eq!(answer["choices"][0]["message"]["content"], "from the engine");
    assert_eq!(engine["key_in_argv"], false);
    assert_eq!(engine["key_file_mode"], "0o600");
    drop(node);
}

#[tokio::test]
async fn an_engine_that_does_not_take_its_key_is_not_served() {
    // As ik_llama.cpp would be given the key only in LLAMA_API_KEY, or a wrapper that drops
    // --api-key-file and runs the server without exec: the engine starts, is healthy, and answers
    // anyone, and the server is not the node's own child.
    let (node, url) = serve("unkeyed", &[], &["--ignore-api-key-file"], Run::Wrapped);
    let engine = started(&node.dir).await;
    let engine_url = format!("http://127.0.0.1:{}", engine["port"]);
    let client = reqwest::Client::new();

    // The node finds out, says so, and stops the engine: the server too, not only the script.
    let log = node.logged("does not enforce its key").await;
    assert!(log.contains("small") && log.contains("It is stopped"), "{log}");
    assert!(log.contains("use a llama-server that honours --api-key-file"), "{log}");
    assert!(client.get(format!("{engine_url}/health")).send().await.is_err(), "the server is still running");

    // And does not serve the model, now or after a restart's backoff and first health probe
    // would have passed: the engine was started once, and found out once.
    tokio::time::sleep(Duration::from_secs(3)).await;
    let log = std::fs::read_to_string(node.dir.join("serve.log")).unwrap();
    assert_eq!(log.matches("engine started").count(), 1, "{log}");
    assert_eq!(log.matches("does not enforce its key").count(), 1, "{log}");
    let models: Value =
        client.get(format!("{url}/v1/models")).bearer_auth(TOKEN).send().await.unwrap().json().await.unwrap();
    let small = models["data"].as_array().unwrap().iter().find(|m| m["id"] == "small").unwrap();
    assert_eq!(small["invincible"]["healthy"], false, "{models}");
    let answer =
        client.post(format!("{url}/v1/chat/completions")).bearer_auth(TOKEN).json(&chat()).send().await.unwrap();
    assert_ne!(answer.status(), 200, "{}", answer.text().await.unwrap());
    drop(node);
}

/// A process the node did not start, killed when the test ends, however it ends.
struct Stray(u64);

impl Drop for Stray {
    fn drop(&mut self) {
        let _ = Command::new("kill").args(["-KILL", &self.0.to_string()]).status();
    }
}

#[tokio::test]
async fn a_server_the_node_cannot_stop_is_not_said_to_be_stopped() {
    // As a container would be, which killing the `docker` client the node started does not stop:
    // the server is in a process group of its own.
    let (node, _) = serve("stray", &[], &["--ignore-api-key-file", "--leave-group"], Run::Wrapped);
    let engine = started(&node.dir).await;
    let _server = Stray(engine["pid"].as_u64().unwrap());

    let log = node.logged("does not enforce its key").await;
    let still = format!("something the node did not start still answers at http://127.0.0.1:{}", engine["port"]);
    assert!(log.contains(&still) && log.contains("must be stopped by hand"), "{log}");
    assert!(!log.contains("It is stopped"), "{log}");
    drop(node);
}

#[tokio::test]
async fn what_an_engine_started_stops_with_the_node() {
    // Ctrl-C in a terminal, `kill` or a service manager, the terminal closing: each reaches the
    // node alone, as engines run in process groups of their own. Behind a script that runs it
    // without exec, the server is not the node's child, and stops too.
    for signal in ["-INT", "-TERM", "-HUP"] {
        let (mut node, url) = serve(&format!("stop{signal}"), &[], &[], Run::Wrapped);
        let engine = started(&node.dir).await;
        through_the_node(&url).await;
        assert!(node.stop(signal), "the node did not stop on {signal}");
        let health = format!("http://127.0.0.1:{}/health", engine["port"]);
        assert!(reqwest::get(health).await.is_err(), "the server outlived the node, stopped with {signal}");
    }
}

#[tokio::test]
async fn what_an_engine_started_goes_when_the_node_dies() {
    // Killed (`kill -9`, as for a node out of memory) or quit (Ctrl-\), the node stops nothing on
    // the way out, and neither launchd, which kills what is left in the node's process group, nor
    // the terminal reach engines: the engine's group must go by itself, the server with it.
    for signal in ["-KILL", "-QUIT"] {
        let (mut node, url) = serve(&format!("die{signal}"), &[], &[], Run::Wrapped);
        let engine = started(&node.dir).await;
        through_the_node(&url).await;
        assert!(node.stop(signal), "the node did not die on {signal}");
        let health = format!("http://127.0.0.1:{}/health", engine["port"]);
        let deadline = Instant::now() + Duration::from_secs(5);
        while reqwest::get(&health).await.is_ok() {
            if Instant::now() > deadline {
                let _ = Command::new("kill").args(["-KILL", &engine["pid"].to_string()]).status();
                panic!("the server outlived the node, killed with {signal}");
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
    }
}

#[tokio::test]
async fn an_engine_inherits_no_secret_and_no_llama_flag() {
    let (node, url) = serve("env", &[SHELL_KEY], &[], Run::Direct);
    let engine = started(&node.dir).await;
    let names: Vec<&str> = engine["env"].as_array().unwrap().iter().map(|n| n.as_str().unwrap()).collect();
    for (name, _) in SECRETS {
        assert!(!names.contains(name), "{name} reached the engine: {names:?}");
    }
    assert!(!names.iter().any(|n| n.starts_with("LLAMA_ARG_")), "{names:?}");
    // The node's own settings stay with the node.
    assert!(!names.contains(&"INVINCIBLE_HOME"), "{names:?}");
    // What the engine needs does reach it: where programs are, and which GPU to use. Its key is
    // in its key file, and the shell's is not added to it.
    for name in ["PATH", "HOME", "CUDA_VISIBLE_DEVICES"] {
        assert!(names.contains(&name), "{name} is missing: {names:?}");
    }
    assert!(!names.contains(&"LLAMA_API_KEY"), "{names:?}");
    assert_eq!(engine["shell_key"], false, "the shell's LLAMA_API_KEY became the engine's");
    // A shell's key for llama-server does not lock the node out of its own engine.
    let answer = through_the_node(&url).await;
    assert_eq!(answer["choices"][0]["message"]["content"], "from the engine");
    drop(node);
}
