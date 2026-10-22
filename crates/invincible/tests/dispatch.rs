//! Dispatch (spec/dispatch.md) end to end on loopback: two stand-in nodes paired over Noise, the
//! head's choice over what they advertise, the answer coming back with the node's name, the one
//! retry before any byte of an answer, and the audit line that records where the answer came from.

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;

use axum::Router;
use axum::body::Bytes;
use axum::http::StatusCode;
use axum::response::IntoResponse;
use axum::routing::{get, post};
use invincible::devices::{Devices, KnownNode, StaticKey};
use invincible::dispatch::{DISPATCHED_TO, Dispatch, RETRIED_HEADER};
use invincible::engine::Engine;
use invincible::remote::{self, Pairing};
use invincible::server::AppState;
use invincible_policy::{Egress, NetworkMode, NodeSettings};
use serde_json::{Value, json};
use tokio::net::TcpListener;

fn temp_dir(tag: &str) -> PathBuf {
    let n: u64 = u64::from_le_bytes(invincible::token::random::<8>().unwrap());
    std::env::temp_dir().join(format!("invincible-dispatch-{tag}-{n:x}"))
}

/// How a stand-in node answers a chat completion.
#[derive(Clone, Copy, PartialEq, Eq)]
enum Behaviour {
    Answer,
    /// Its engine is down: a 503, which is the node's failure, not the request's.
    Fail,
}

/// A stand-in node on loopback, reachable only through its paired link.
struct Fake {
    name: String,
    addr: String,
    pairing: Arc<Pairing>,
    /// Chat completions asked of it (a retry must ask the failed node exactly once).
    asked: Arc<AtomicU64>,
    /// Whether anything listens at its address: false for a node that is gone.
    reachable: bool,
    dir: PathBuf,
}

impl Drop for Fake {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

async fn fake(name: &str, tps: f64, max_inflight: u64, behaviour: Behaviour) -> Fake {
    let dir = temp_dir(name);
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap().to_string();
    let pairing = Arc::new(Pairing::new(
        StaticKey::load_or_create(&dir.join("node.key")).unwrap(),
        name.into(),
        vec![addr.clone()],
        Devices::load(&dir.join("devices.json")).unwrap(),
    ));
    let hardware = invincible::tune::hardware_now();
    let caps = json!({
        "name": name,
        "version": "test",
        "hardware": hardware,
        "models": ["qwen3-4b"],
        "dispatch": { "max_inflight": max_inflight, "queue": 0 },
        "profiles": [{
            "model": "qwen3-4b",
            "hardware": hardware,
            "profiles": [{
                "device": "CUDA0",
                "tg_tps": tps,
                "engine": "llama-bench b1",
                "at": "2026-10-22T00:00:00Z",
            }],
        }],
    });
    let asked = Arc::new(AtomicU64::new(0));
    let count = asked.clone();
    let owner = name.to_owned();
    let app = Router::new()
        .route(
            "/v1/cluster/node",
            get(move || {
                let caps = caps.clone();
                async move { axum::Json(caps) }
            }),
        )
        .route(
            "/v1/chat/completions",
            post(move |_: Bytes| {
                let count = count.clone();
                let owner = owner.clone();
                async move {
                    count.fetch_add(1, Ordering::SeqCst);
                    match behaviour {
                        Behaviour::Answer => axum::Json(json!({
                            "model": "qwen3-4b",
                            "choices": [{ "message": { "role": "assistant", "content": format!("from {owner}") } }],
                            "usage": { "prompt_tokens": 5, "completion_tokens": 2 },
                        }))
                        .into_response(),
                        Behaviour::Fail => (
                            StatusCode::SERVICE_UNAVAILABLE,
                            axum::Json(json!({ "error": { "message": "the engine is restarting" } })),
                        )
                            .into_response(),
                    }
                }
            }),
        );
    tokio::spawn(remote::serve(listener, pairing.clone(), app));
    Fake { name: name.into(), addr, pairing, asked, reachable: true, dir }
}

/// A node this machine paired with that is not answering: its address was bound once and let go,
/// so nothing listens there, the way a node that was switched off looks.
async fn ghost(name: &str) -> Fake {
    let dir = temp_dir(name);
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap().to_string();
    drop(listener);
    let pairing = Arc::new(Pairing::new(
        StaticKey::load_or_create(&dir.join("node.key")).unwrap(),
        name.into(),
        vec![addr.clone()],
        Devices::load(&dir.join("devices.json")).unwrap(),
    ));
    Fake { name: name.into(), addr, pairing, asked: Arc::new(AtomicU64::new(0)), reachable: false, dir }
}

/// A head: this machine's own engine as a stand-in, the paired fakes, and a dispatcher over both.
struct Head {
    url: String,
    home: PathBuf,
    /// This machine's engine, which answers "from studio".
    engine_asked: Arc<AtomicU64>,
    dir: PathBuf,
}

impl Drop for Head {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

async fn head(fakes: &[&Fake]) -> Head {
    let dir = temp_dir("head");
    let device = StaticKey::load_or_create(&dir.join("device.key")).unwrap();
    let mut peers = Vec::new();
    for fake in fakes {
        if fake.reachable {
            remote::pair(&fake.pairing.start().unwrap(), &device, "studio").await.unwrap();
        }
        peers.push(KnownNode {
            name: fake.name.clone(),
            key: {
                use base64::Engine as _;
                base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(&fake.pairing.key.public)
            },
            addrs: vec![fake.addr.clone()],
            receipt_key: None,
            device: Some("studio".into()),
            capabilities: Default::default(),
        });
    }
    // This machine's engine, on loopback, answering like llama-server would.
    let engine_asked = Arc::new(AtomicU64::new(0));
    let count = engine_asked.clone();
    let engine = Router::new().route(
        "/v1/chat/completions",
        post(move |_: Bytes| {
            let count = count.clone();
            async move {
                count.fetch_add(1, Ordering::SeqCst);
                axum::Json(json!({
                    "model": "qwen3-4b",
                    "choices": [{ "message": { "role": "assistant", "content": "from studio" } }],
                    "usage": { "prompt_tokens": 5, "completion_tokens": 2 },
                }))
            }
        }),
    );
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let engine_addr = listener.local_addr().unwrap();
    tokio::spawn(async move { axum::serve(listener, engine).await.unwrap() });

    let settings = NodeSettings { network: NetworkMode::Offline, egress: Egress::Never };
    let state = AppState::new(
        vec![Engine::attached("qwen3-4b", &format!("http://{engine_addr}"), None, true)],
        settings,
        "token".into(),
    )
    .with_receipt_key("studio", invincible::receipts::ReceiptKey::from_seed(&[5; 32]))
    .with_audit(invincible::audit::AuditLog::new(&dir))
    .with_dispatch(Dispatch::new(
        "studio".into(),
        vec!["qwen3-4b".into()],
        1,
        dir.clone(),
        peers,
        Some(device),
        "offline".into(),
    ));
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let app = invincible::server::app(Arc::new(state));
    tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    Head { url: format!("http://{addr}"), home: dir.clone(), engine_asked, dir }
}

fn client() -> reqwest::Client {
    reqwest::Client::new()
}

const CHAT: &str = r#"{"model":"qwen3-4b","messages":[{"role":"user","content":"hi"}]}"#;

/// The last audit entry, once it is written (the receipt is finished when the body ends).
async fn last_audit(home: &Path) -> Value {
    let path = home.join("audit.jsonl");
    for _ in 0..200 {
        if let Ok(text) = std::fs::read_to_string(&path)
            && let Some(line) = text.lines().filter(|line| !line.trim().is_empty()).next_back()
            && let Ok(entry) = serde_json::from_str::<Value>(line)
        {
            return entry;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    panic!("no audit entry in {}", path.display());
}

#[tokio::test]
async fn the_fastest_idle_node_is_chosen_and_named_in_the_answer() {
    let (fast, slow) = (fake("fast", 40.0, 1, Behaviour::Answer).await, fake("slow", 12.0, 1, Behaviour::Answer).await);
    let head = head(&[&fast, &slow]).await;
    let client = client();

    // The rows `invincible dispatch status` prints: this machine, then both peers as probed.
    let status: Value = client
        .get(format!("{}/v1/dispatch?model=qwen3-4b", head.url))
        .bearer_auth("token")
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(status["name"], "studio");
    assert_eq!(status["model"], "qwen3-4b");
    assert_eq!(status["choice"], json!({ "action": "run", "name": "fast" }));
    let names: Vec<&str> = status["nodes"].as_array().unwrap().iter().filter_map(|n| n["name"].as_str()).collect();
    assert_eq!(names, ["studio", "fast", "slow"], "this node first, then the peers in pairing order");
    assert_eq!(status["nodes"][1]["max_inflight"], 1);
    assert_eq!(status["nodes"][1]["tg_tps"], 40.0);
    assert_eq!(status["nodes"][1]["chosen"], true);
    assert!(status["nodes"][0]["note"].as_str().unwrap().contains("no measurement"));

    // The request goes there, and says so.
    let response = client
        .post(format!("{}/v1/dispatch/chat/completions", head.url))
        .bearer_auth("token")
        .header("content-type", "application/json")
        .body(CHAT)
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), 200);
    assert_eq!(response.headers()[DISPATCHED_TO], "fast");
    assert!(response.headers().get(RETRIED_HEADER).is_none());
    let id = response.headers()[invincible::receipts::REQUEST_ID_HEADER].to_str().unwrap().to_owned();
    let answer: Value = response.json().await.unwrap();
    assert_eq!(answer["choices"][0]["message"]["content"], "from fast");
    assert_eq!(fast.asked.load(Ordering::SeqCst), 1);
    assert_eq!(slow.asked.load(Ordering::SeqCst), 0);
    assert_eq!(head.engine_asked.load(Ordering::SeqCst), 0, "this machine was not chosen");

    // The head's signed receipt describes its own part only: `dispatch` is not in it.
    let envelope: Value = client
        .get(format!("{}/v1/receipts/{id}", head.url))
        .bearer_auth("token")
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let receipt = &envelope["receipt"];
    assert!(invincible::receipts::verify(
        &invincible::receipts::ReceiptKey::from_seed(&[5; 32]).public(),
        receipt,
        envelope["signature"].as_str().unwrap()
    ));
    assert!(receipt.get("dispatch").is_none(), "the signed receipt must not claim another machine's work");
    assert_eq!(receipt["decision"]["model"], "qwen3-4b");
    assert_eq!(receipt["tokens"], json!({ "input": 5, "output": 2 }));

    // The audit line does say where it came from (spec/dispatch.md).
    let entry = last_audit(&head.home).await;
    assert_eq!(entry["dispatch"], json!({ "via": "studio", "node": "fast" }));
    assert_eq!(entry["api"], "dispatch");
    assert_eq!(entry["receipt"]["receipt"]["request_id"], id);
}

#[tokio::test]
async fn a_node_that_fails_before_answering_is_retried_once_elsewhere() {
    // The fastest node is down at the engine: its 503 is its failure, so the request goes on.
    let (broken, good) =
        (fake("broken", 40.0, 1, Behaviour::Fail).await, fake("good", 12.0, 1, Behaviour::Answer).await);
    let head = head(&[&broken, &good]).await;
    let response = client()
        .post(format!("{}/v1/dispatch/chat/completions", head.url))
        .bearer_auth("token")
        .header("content-type", "application/json")
        .body(CHAT)
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), 200, "the second node answered");
    assert_eq!(response.headers()[DISPATCHED_TO], "good");
    assert!(response.headers()[RETRIED_HEADER].to_str().unwrap().starts_with("broken: 503"));
    let answer: Value = response.json().await.unwrap();
    assert_eq!(answer["choices"][0]["message"]["content"], "from good");
    assert_eq!(broken.asked.load(Ordering::SeqCst), 1, "exactly one attempt on the failed node");
    assert_eq!(good.asked.load(Ordering::SeqCst), 1);

    // The audit line names the node that answered, not the one that failed.
    let entry = last_audit(&head.home).await;
    assert_eq!(entry["dispatch"], json!({ "via": "studio", "node": "good" }));
}

#[tokio::test]
async fn a_stream_is_refused_with_a_reason_and_nowhere_to_go() {
    let fast = fake("fast", 40.0, 1, Behaviour::Answer).await;
    let head = head(&[&fast]).await;
    let response = client()
        .post(format!("{}/v1/dispatch/chat/completions", head.url))
        .bearer_auth("token")
        .header("content-type", "application/json")
        .body(r#"{"model":"qwen3-4b","stream":true,"messages":[{"role":"user","content":"hi"}]}"#)
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), 400);
    let body: Value = response.json().await.unwrap();
    assert_eq!(body["error"]["code"], "streaming_not_dispatched");
    assert_eq!(fast.asked.load(Ordering::SeqCst), 0, "nothing was sent before the refusal");
}

#[tokio::test]
async fn the_cli_prints_the_rows_and_the_choice() {
    let (fast, slow) = (fake("fast", 40.0, 1, Behaviour::Answer).await, fake("slow", 12.0, 1, Behaviour::Answer).await);
    let head = head(&[&fast, &slow]).await;
    // The node's own config: where it listens, which is all the CLI needs (the token is in home).
    std::fs::write(head.home.join("token"), "token\n").unwrap();
    let listen = head.url.trim_start_matches("http://").to_owned();
    std::fs::write(head.home.join("config.toml"), format!("listen = \"{listen}\"\n\n[remote]\nname = \"studio\"\n"))
        .unwrap();
    let output = tokio::process::Command::new(env!("CARGO_BIN_EXE_invincible"))
        .args(["dispatch", "status", "--model", "qwen3-4b", "--config"])
        .arg(head.home.join("config.toml"))
        .env("INVINCIBLE_HOME", &head.home)
        .env("NO_COLOR", "1")
        .output()
        .await
        .unwrap();
    let stdout = String::from_utf8_lossy(&output.stdout).to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).to_string();
    assert!(output.status.success(), "dispatch status failed: {stderr}");
    println!("{stdout}");
    for line in ["studio dispatches qwen3-4b", "fast", "slow", "choice: run on fast"] {
        assert!(stdout.contains(line), "{line:?} is not in:\n{stdout}");
    }
    // A model no node serves: the rows say why, and nothing is claimed to answer.
    let none = tokio::process::Command::new(env!("CARGO_BIN_EXE_invincible"))
        .args(["dispatch", "status", "--model", "llama-70b", "--config"])
        .arg(head.home.join("config.toml"))
        .env("INVINCIBLE_HOME", &head.home)
        .env("NO_COLOR", "1")
        .output()
        .await
        .unwrap();
    let text = String::from_utf8_lossy(&none.stdout).to_string();
    assert!(none.status.success(), "{}", String::from_utf8_lossy(&none.stderr));
    println!("{text}");
    assert!(text.contains("does not serve llama-70b"), "{text}");
    assert!(text.contains("choice: no capacity"), "{text}");
}

/// A paired node that is not answering is a row that says why, and this machine answers instead.
#[tokio::test]
async fn a_down_peer_is_a_row_that_says_why_and_this_machine_answers() {
    let gone = ghost("gone").await;
    let head = head(&[&gone]).await;
    let status: Value = client()
        .get(format!("{}/v1/dispatch?model=qwen3-4b", head.url))
        .bearer_auth("token")
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(status["nodes"][1]["name"], "gone");
    assert_eq!(status["nodes"][1]["up"], false);
    assert!(status["nodes"][1]["note"].as_str().unwrap().starts_with("down"));
    assert_eq!(status["choice"], json!({ "action": "run", "name": "studio" }));

    let response = client()
        .post(format!("{}/v1/dispatch/chat/completions", head.url))
        .bearer_auth("token")
        .header("content-type", "application/json")
        .body(CHAT)
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), 200);
    assert_eq!(response.headers()[DISPATCHED_TO], "studio");
    let answer: Value = response.json().await.unwrap();
    assert_eq!(answer["choices"][0]["message"]["content"], "from studio");
    assert_eq!(head.engine_asked.load(Ordering::SeqCst), 1);
    assert_eq!(gone.asked.load(Ordering::SeqCst), 0);
}
