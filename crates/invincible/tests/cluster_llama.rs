//! Phase 1 of spec/cluster.md with the real thing: two `invincible serve` processes with their own
//! homes and ports (a shard and a head), llama.cpp's `llama-server` and `ggml-rpc-server`, and one
//! GGUF split across both. Ignored by default: it needs an RPC-enabled llama.cpp build and a model.
//!
//! ```sh
//! INVINCIBLE_TEST_LLAMA=/path/to/llama.cpp/build/bin INVINCIBLE_TEST_GGUF=/models/small.gguf \
//!   cargo test --release -p invincible --test cluster_llama -- --ignored --nocapture
//! ```

use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

use serde_json::{Value, json};

const INVINCIBLE: &str = env!("CARGO_BIN_EXE_invincible");

struct Node {
    child: Child,
}

impl Drop for Node {
    fn drop(&mut self) {
        stop(&mut self.child);
    }
}

/// SIGTERM, so the node stops its engines and its ggml-rpc-server with it.
fn stop(child: &mut Child) {
    let _ = Command::new("kill").arg(child.id().to_string()).status();
    let deadline = Instant::now() + Duration::from_secs(15);
    while Instant::now() < deadline {
        if let Ok(Some(_)) = child.try_wait() {
            return;
        }
        std::thread::sleep(Duration::from_millis(100));
    }
    let _ = child.kill();
}

fn port() -> u16 {
    std::net::TcpListener::bind("127.0.0.1:0").unwrap().local_addr().unwrap().port()
}

fn invincible(home: &Path, args: &[&str]) -> String {
    let out = Command::new(INVINCIBLE).args(args).env("INVINCIBLE_HOME", home).output().unwrap();
    assert!(out.status.success(), "invincible {args:?}: {}", String::from_utf8_lossy(&out.stderr));
    String::from_utf8_lossy(&out.stdout).into_owned()
}

fn serve(home: &Path, config: &str) -> Node {
    std::fs::create_dir_all(home).unwrap();
    std::fs::write(home.join("config.toml"), config).unwrap();
    let log = std::fs::File::create(home.join("serve.log")).unwrap();
    let child = Command::new(INVINCIBLE)
        .arg("serve")
        .env("INVINCIBLE_HOME", home)
        .stdout(log.try_clone().unwrap())
        .stderr(log)
        .stdin(Stdio::null())
        .spawn()
        .unwrap();
    Node { child }
}

async fn wait_for(what: &str, limit: Duration, mut check: impl AsyncFnMut() -> bool) {
    let deadline = Instant::now() + limit;
    while Instant::now() < deadline {
        if check().await {
            return;
        }
        tokio::time::sleep(Duration::from_millis(500)).await;
    }
    panic!("timed out waiting for {what}");
}

async fn get(client: &reqwest::Client, url: &str, token: &str) -> Option<Value> {
    client.get(url).bearer_auth(token).send().await.ok()?.json().await.ok()
}

async fn healthy(client: &reqwest::Client, url: &str, token: &str, model: &str) -> bool {
    let Some(models) = get(client, &format!("{url}/v1/models"), token).await else { return false };
    models["data"].as_array().into_iter().flatten().any(|m| m["id"] == model && m["invincible"]["healthy"] == true)
}

#[tokio::test]
#[ignore = "needs an RPC-enabled llama.cpp (INVINCIBLE_TEST_LLAMA) and a GGUF (INVINCIBLE_TEST_GGUF)"]
async fn one_model_split_across_two_nodes() {
    let llama = PathBuf::from(std::env::var("INVINCIBLE_TEST_LLAMA").expect("INVINCIBLE_TEST_LLAMA"));
    let gguf = std::env::var("INVINCIBLE_TEST_GGUF").expect("INVINCIBLE_TEST_GGUF");
    let n: u64 = u64::from_le_bytes(invincible::token::random::<8>().unwrap());
    let root = std::env::temp_dir().join(format!("invincible-cluster-e2e-{n:x}"));
    let (shard_api, shard_remote, head_api) = (port(), port(), port());

    // The shard: no models of its own, ggml-rpc-server on loopback for the head "studio".
    let shard_home = root.join("mini");
    let mut shard = serve(
        &shard_home,
        &format!(
            "listen = \"127.0.0.1:{shard_api}\"\n[engine]\nllama_server = \"{l}/llama-server\"\n\
             [remote]\nname = \"mini\"\nlisten = [\"127.0.0.1:{shard_remote}\"]\n\
             [cluster]\nserve = true\nheads = [\"studio\"]\nrpc_server = \"{l}/ggml-rpc-server\"\n",
            l = llama.display()
        ),
    );
    let client = reqwest::Client::new();
    let shard_url = format!("http://127.0.0.1:{shard_api}");
    wait_for("the shard", Duration::from_secs(60), async || {
        client.get(format!("{shard_url}/healthz")).send().await.is_ok()
    })
    .await;

    // The head pairs with it, as a device named "studio".
    let head_home = root.join("studio");
    std::fs::create_dir_all(&head_home).unwrap();
    let code = invincible(&shard_home, &["pair"]).lines().find(|l| l.starts_with("invincible://")).unwrap().to_owned();
    invincible(&head_home, &["join", &code, "--name", "studio"]);
    let head = serve(
        &head_home,
        &format!(
            "listen = \"127.0.0.1:{head_api}\"\n[engine]\nllama_server = \"{l}/llama-server\"\n\
             [remote]\nname = \"studio\"\n\
             [[models]]\nid = \"split\"\npath = \"{gguf}\"\ncontext = 2048\ncluster = [\"mini\"]\nsplit = \"always\"\n",
            l = llama.display()
        ),
    );
    let token = invincible(&head_home, &["token"]).trim().to_owned();
    let url = format!("http://127.0.0.1:{head_api}");
    wait_for("the split model", Duration::from_secs(600), async || healthy(&client, &url, &token, "split").await).await;

    // It is split across both, and says so.
    let status = get(&client, &format!("{url}/v1/cluster"), &token).await.unwrap();
    assert_eq!(status["peers"][0]["reachable"], true, "{status}");
    let plan = &status["models"][0]["state"]["plan"];
    assert_eq!(plan["action"], "split", "{status}");
    let text = invincible(&head_home, &["cluster", "status"]);
    assert!(text.contains("mini") && text.contains("‰"), "{text}");

    // An answer through the router, and its receipt names both nodes.
    let response = client
        .post(format!("{url}/v1/chat/completions"))
        .bearer_auth(&token)
        .json(&json!({ "model": "split", "max_tokens": 32, "temperature": 0,
                       "messages": [{ "role": "user", "content": "Say hello." }] }))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), 200);
    let id = response.headers()["invincible-request-id"].to_str().unwrap().to_owned();
    let answer: Value = response.json().await.unwrap();
    assert!(answer["choices"][0]["message"]["content"].as_str().is_some(), "{answer}");
    let receipt = get(&client, &format!("{url}/v1/receipts/{id}"), &token).await.unwrap();
    let nodes: Vec<&str> =
        receipt["receipt"]["cluster"].as_array().unwrap().iter().map(|n| n["name"].as_str().unwrap()).collect();
    assert_eq!(nodes, ["studio", "mini"], "{receipt}");
    assert!(receipt["receipt"]["cluster"][1]["bytes_received"].as_u64().unwrap() > 0, "{receipt}");
    assert_eq!(receipt["receipt"]["egress"], json!([]));

    // The shard leaves mid-answer: the answer ends with an error event, not a cut.
    let stream = client
        .post(format!("{url}/v1/chat/completions"))
        .bearer_auth(&token)
        .json(&json!({ "model": "split", "stream": true, "max_tokens": 2000,
                       "messages": [{ "role": "user", "content": "Write a very long story." }] }))
        .send()
        .await
        .unwrap();
    let id = stream.headers()["invincible-request-id"].to_str().unwrap().to_owned();
    let reader = tokio::spawn(async move { stream.text().await.unwrap_or_default() });
    tokio::time::sleep(Duration::from_secs(2)).await;
    // As if unplugged: the node and its ggml-rpc-server die at once.
    let _ = Command::new("pkill").args(["-9", "-P", &shard.child.id().to_string()]).status();
    let _ = shard.child.kill();
    let body = tokio::time::timeout(Duration::from_secs(60), reader).await.unwrap().unwrap();
    assert!(
        body.contains("event: error") && body.contains("engine_failed"),
        "{}",
        &body[body.len().saturating_sub(500)..]
    );
    let receipt = get(&client, &format!("{url}/v1/receipts/{id}"), &token).await.unwrap();
    assert_eq!(receipt["receipt"]["error"]["code"], "engine_failed", "{receipt}");

    // The head plans again without it and serves the model alone.
    wait_for("the model back on the head alone", Duration::from_secs(600), async || {
        let Some(status) = get(&client, &format!("{url}/v1/cluster"), &token).await else { return false };
        status["models"][0]["state"]["plan"]["action"] == "local" && healthy(&client, &url, &token, "split").await
    })
    .await;
    let response = client
        .post(format!("{url}/v1/chat/completions"))
        .bearer_auth(&token)
        .json(&json!({ "model": "split", "max_tokens": 8, "messages": [{ "role": "user", "content": "Hi" }] }))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), 200);
    let id = response.headers()["invincible-request-id"].to_str().unwrap().to_owned();
    let _ = response.bytes().await;
    let receipt = get(&client, &format!("{url}/v1/receipts/{id}"), &token).await.unwrap();
    assert!(receipt["receipt"].get("cluster").is_none(), "ran on the head alone: {receipt}");

    drop(head);
    let _ = std::fs::remove_dir_all(&root);
}
