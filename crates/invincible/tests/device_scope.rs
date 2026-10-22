//! What a paired device may reach (spec/pairing.md, Transport), end to end over the same Noise
//! session a phone or a cluster head uses.
//!
//! The node here is a real one: `remote::serve` in front of `device_app`, the loopback `app` with
//! the operator's token beside it, a stub engine, a stub Autobot (which counts what reaches it),
//! an audit log with entries in it, a cluster and a dispatcher, so every route the device is
//! refused would answer 200 for the token. The device pairs over loopback, as the other tests do,
//! and then asks through `remote::tunnel` — the same plain-HTTP door `invincible tunnel` opens.

use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};

use axum::Router;
use axum::body::Bytes;
use axum::response::IntoResponse;
use axum::routing::post;
use invincible::devices::{Devices, StaticKey};
use invincible::dispatch::Dispatch;
use invincible::engine::Engine;
use invincible::remote::{self, Pairing, PairingCode};
use invincible::server::{AppState, device_app};
use invincible_policy::{Egress, NetworkMode, NodeSettings};
use serde_json::{Value, json};
use tokio::net::TcpListener;

const TOKEN: &str = "operator-token";
const DOOR_TOKEN: &str = "door-token";
/// The bulk payload `remote::meter_link` posts (`cluster.rs` times a link with `4 << 20`).
const BULK: usize = 4 << 20;

struct Node {
    pairing: Arc<Pairing>,
    /// The remote listener a device session reaches.
    addr: String,
    /// The loopback API, behind the operator's token.
    url: String,
    /// What the stub Autobot was asked.
    agent_hits: Arc<AtomicU64>,
    dir: std::path::PathBuf,
}

impl Drop for Node {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

fn temp_dir(tag: &str) -> std::path::PathBuf {
    let n: u64 = u64::from_le_bytes(invincible::token::random::<8>().unwrap());
    std::env::temp_dir().join(format!("invincible-scope-{tag}-{n:x}"))
}

/// An engine that answers a chat completion with what it was asked.
async fn stub_engine() -> String {
    let router = Router::new().route(
        "/v1/chat/completions",
        post(|body: Bytes| async move {
            let request: Value = serde_json::from_slice(&body).unwrap();
            axum::Json(json!({ "engine_saw": request })).into_response()
        }),
    );
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move { axum::serve(listener, router).await.unwrap() });
    format!("http://{addr}")
}

/// A stand-in for Autobot's API: answers 200 to anything and counts the requests. If a device
/// ever reached `/v1/agent`, this would answer it, and the count would say so.
async fn stub_agent() -> (String, Arc<AtomicU64>) {
    let hits = Arc::new(AtomicU64::new(0));
    let counted = hits.clone();
    let router = Router::new().fallback(move |request: axum::extract::Request| {
        let counted = counted.clone();
        async move {
            counted.fetch_add(1, Ordering::SeqCst);
            axum::Json(json!({ "agent_reached": request.uri().path() }))
        }
    });
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move { axum::serve(listener, router).await.unwrap() });
    (format!("http://{addr}"), hits)
}

/// A node with one engine, a stub agent, an audit log, a cluster and a dispatcher: every operator
/// route the device is refused has something to answer with.
async fn node() -> Node {
    let dir = temp_dir("node");
    std::fs::create_dir_all(&dir).unwrap();
    let engine = Engine::attached("small", &stub_engine().await, None, true);
    let (agent_url, agent_hits) = stub_agent().await;

    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap().to_string();
    let receipt_key = invincible::receipts::ReceiptKey::from_seed(&[7; 32]);
    let pairing = Arc::new(
        Pairing::new(
            StaticKey::load_or_create(&dir.join("node.key")).unwrap(),
            "studio".into(),
            vec![addr.clone()],
            Devices::load(&dir.join("devices.json")).unwrap(),
        )
        .with_receipt_key(receipt_key.public()),
    );
    let settings = NodeSettings { network: NetworkMode::Offline, egress: Egress::Never };
    let cluster = invincible::cluster::ClusterState {
        name: "studio".into(),
        llama_server: std::path::PathBuf::from("/nonexistent/llama-server"),
        rpc_backend: None,
        peers: Vec::new(),
        device_key: None,
        runs: Vec::new(),
        shard: false,
        models: vec!["small".into()],
        dispatch_max_inflight: 1,
    };
    let dispatch =
        Dispatch::new("studio".into(), vec!["small".into()], 1, dir.clone(), Vec::new(), None, "offline".into());
    let state = Arc::new(
        AppState::new(vec![engine], settings, TOKEN.into())
            .with_receipt_key("studio", receipt_key)
            .with_audit(invincible::audit::AuditLog::new(&dir))
            .with_membership(dir.clone())
            .with_agent(&agent_url)
            .with_cluster(cluster)
            .with_dispatch(dispatch)
            .with_pairing(pairing.clone()),
    );
    tokio::spawn(remote::serve(listener, pairing.clone(), device_app(state.clone())));

    let api = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}", api.local_addr().unwrap());
    tokio::spawn(async move { axum::serve(api, invincible::server::app(state)).await.unwrap() });
    Node { pairing, addr, url, agent_hits, dir }
}

/// A device key in its own directory (removed with the returned path).
fn device(tag: &str) -> (StaticKey, std::path::PathBuf) {
    let dir = temp_dir(tag);
    (StaticKey::load_or_create(&dir.join("device.key")).unwrap(), dir)
}

/// Pairs [key] with [node] as "phone", the way a phone does over the code.
async fn pair(node: &Node, key: &StaticKey) -> String {
    let code = PairingCode::decode(&node.pairing.start().unwrap().encode()).unwrap();
    remote::pair(&code, key, "phone").await.unwrap().device
}

/// The door `invincible tunnel` opens for [key] to [node]: a base URL whose requests each become
/// a device session.
async fn door(node: &Node, key: &StaticKey) -> String {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let door = listener.local_addr().unwrap();
    tokio::spawn(remote::tunnel(
        listener,
        vec![node.addr.clone()],
        node.pairing.key.public.clone(),
        key.clone(),
        DOOR_TOKEN.into(),
    ));
    format!("http://{door}")
}

/// A client that carries the door's token, as a program on the paired machine does.
fn client() -> reqwest::Client {
    let mut headers = reqwest::header::HeaderMap::new();
    headers.insert(reqwest::header::AUTHORIZATION, format!("Bearer {DOOR_TOKEN}").parse().unwrap());
    reqwest::Client::builder().default_headers(headers).timeout(std::time::Duration::from_secs(30)).build().unwrap()
}

/// The operator's own client: the loopback token.
fn operator() -> reqwest::Client {
    let mut headers = reqwest::header::HeaderMap::new();
    headers.insert(reqwest::header::AUTHORIZATION, format!("Bearer {TOKEN}").parse().unwrap());
    reqwest::Client::builder().default_headers(headers).timeout(std::time::Duration::from_secs(30)).build().unwrap()
}

/// Every operator route, with a body where one is needed: the ones the audit found reachable, the
/// membership and admin routes, and a path that does not exist at all (`/v1/user/models`).
const DENIED: &[(&str, &str, Option<&str>)] = &[
    ("GET", "/v1/agent", None),
    ("POST", "/v1/agent", Some(r#"{}"#)),
    ("POST", "/v1/agent/turns", Some(r#"{"input":"run something"}"#)),
    ("GET", "/v1/agent/cron", None),
    ("GET", "/v1/audit", None),
    ("GET", "/v1/dispatch", None),
    ("POST", "/v1/dispatch/chat/completions", Some(r#"{"model":"small","messages":[]}"#)),
    ("POST", "/v1/messages", Some(r#"{"model":"small","messages":[]}"#)),
    ("POST", "/v1/audio/speech", Some(r#"{"input":"hi"}"#)),
    ("POST", "/v1/images/generations", Some(r#"{"prompt":"a cat"}"#)),
    ("POST", "/v1/fetch", Some(r#"{"url":"https://example.com"}"#)),
    ("GET", "/v1/cluster", None),
    ("GET", "/v1/cluster/nodes", None),
    ("POST", "/v1/cluster/pair", Some(r#"{}"#)),
    ("GET", "/v1/admin/devices", None),
    ("GET", "/v1/admin/pairing", None),
    ("GET", "/v1/user/models", None),
];

#[tokio::test]
async fn a_device_is_refused_every_operator_route_and_cannot_tell_which_exist() {
    let node = node().await;
    let (phone, dir) = device("phone-scope");
    assert_eq!(pair(&node, &phone).await, "phone");
    let door = door(&node, &phone).await;
    let client = client();

    for (method, path, body) in DENIED {
        let mut request = match *method {
            "GET" => client.get(format!("{door}{path}")),
            "POST" => client.post(format!("{door}{path}")),
            other => panic!("unhandled method {other}"),
        };
        if let Some(body) = body {
            request = request.header("content-type", "application/json").body(*body);
        }
        let response = request.send().await.unwrap_or_else(|e| panic!("{method} {path}: {e}"));
        assert_eq!(response.status(), 404, "{method} {path} is not a device route");
        let refused = response.text().await.unwrap();

        // The refusal says nothing about whether the route exists: an operator route and a path
        // that was never mounted answer with the same status and the same bytes.
        let unknown = client.get(format!("{door}/v1/nothing-here")).send().await.unwrap();
        assert_eq!(unknown.status(), 404);
        assert_eq!(refused, unknown.text().await.unwrap(), "{method} {path} answers like an unknown path");
    }

    // None of it reached Autobot: the node's own token never left the proxy on a device's behalf.
    assert_eq!(node.agent_hits.load(Ordering::SeqCst), 0, "a device drove the agent");
    // Nothing was audited as a device's request either, because nothing answered.
    assert!(node.pairing.devices.is_pinned(&phone.public));

    // The same routes answer the operator's token, so the refusal is the device session's doing
    // and not a broken node. `/v1/agent` is reached with no body: the stub answers, which is what
    // proves the proxy ran — Autobot itself is not part of this test.
    let operator = operator();
    let agent = operator.post(format!("{}/v1/agent", node.url)).send().await.unwrap();
    assert_eq!(agent.status(), 200, "the operator's own agent route must keep working");
    assert_eq!(node.agent_hits.load(Ordering::SeqCst), 1);
    for path in ["/v1/audit", "/v1/dispatch", "/v1/cluster", "/v1/cluster/nodes", "/v1/admin/devices"] {
        let response = operator.get(format!("{}{path}", node.url)).send().await.unwrap();
        assert_eq!(response.status(), 200, "{path} for the operator: {}", response.status());
    }
    let _ = std::fs::remove_dir_all(dir);
}

#[tokio::test]
async fn a_device_reaches_exactly_what_its_app_and_a_shard_need() {
    let node = node().await;
    let (phone, dir) = device("phone-allow");
    pair(&node, &phone).await;
    let door = door(&node, &phone).await;
    let client = client();

    // The app: the models it may ask for, one turn, the receipt for it.
    let models: Value = client.get(format!("{door}/v1/models")).send().await.unwrap().json().await.unwrap();
    assert_eq!(models["data"][0]["id"], "small");

    let response = client
        .post(format!("{door}/v1/chat/completions"))
        .json(&json!({ "model": "small", "messages": [{ "role": "user", "content": "hi" }] }))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), 200);
    let id = response.headers()[invincible::receipts::REQUEST_ID_HEADER].to_str().unwrap().to_owned();
    let _ = response.bytes().await.unwrap();
    let envelope: Value = client.get(format!("{door}/v1/receipts/{id}")).send().await.unwrap().json().await.unwrap();
    // A receipt names the node by its receipt key, not its `[remote] name` (spec/receipts.md).
    assert_eq!(envelope["receipt"]["node"], node.pairing.receipt_key.as_str());

    // The membership probe's `GET /v1/node`, and the capabilities a head sizes this node by.
    let info: Value = client.get(format!("{door}/v1/node")).send().await.unwrap().json().await.unwrap();
    assert_eq!(info["name"], "studio");
    assert_eq!(info["receipt_key"], node.pairing.receipt_key.as_str());
    let caps: Value = client.get(format!("{door}/v1/cluster/node")).send().await.unwrap().json().await.unwrap();
    assert_eq!(caps["name"], "studio");
    assert_eq!(caps["models"], json!(["small"]));
    assert_eq!(caps["shard"], false, "a device that is not a head's shard is told so");

    // The meter: a round trip's worth, then the bulk payload `meter_link` sends.
    for len in [1024, BULK] {
        let answer: Value = client
            .post(format!("{door}/v1/cluster/meter"))
            .body(vec![0u8; len])
            .send()
            .await
            .unwrap()
            .json()
            .await
            .unwrap();
        assert_eq!(answer["bytes"], len as u64);
    }
    let _ = std::fs::remove_dir_all(dir);
}

#[tokio::test]
async fn the_meter_takes_one_bulk_payload_and_a_bigger_post_is_413() {
    let node = node().await;
    let (phone, dir) = device("phone-meter");
    pair(&node, &phone).await;
    let door = door(&node, &phone).await;
    let client = client();

    // What a head sends by design still fits.
    let answer = client.post(format!("{door}/v1/cluster/meter")).body(vec![0u8; BULK]).send().await.unwrap();
    assert_eq!(answer.status(), 200);
    assert_eq!(answer.json::<Value>().await.unwrap()["bytes"], BULK as u64);

    // A post past the device limit is refused rather than buffered (5 MiB + 1 byte).
    let over = client.post(format!("{door}/v1/cluster/meter")).body(vec![0u8; (5 << 20) + 1]).send().await.unwrap();
    assert_eq!(over.status(), 413, "the meter takes {} bytes, not {}", 5 << 20, (5 << 20) + 1);

    // The node is healthy afterwards: a fresh device session and the operator's own API both
    // answer, and the meter still takes the payload it is meant for.
    assert_eq!(client.get(format!("{door}/v1/models")).send().await.unwrap().status(), 200);
    assert_eq!(client.get(format!("{door}/v1/node")).send().await.unwrap().status(), 200);
    let again = client.post(format!("{door}/v1/cluster/meter")).body(vec![0u8; BULK]).send().await.unwrap();
    assert_eq!(again.status(), 200);

    let operator = operator();
    assert_eq!(operator.get(format!("{}/v1/audit", node.url)).send().await.unwrap().status(), 200);
    let chat = operator
        .post(format!("{}/v1/chat/completions", node.url))
        .json(&json!({ "model": "small", "messages": [{ "role": "user", "content": "hi" }] }))
        .send()
        .await
        .unwrap();
    assert_eq!(chat.status(), 200);
    let _ = std::fs::remove_dir_all(dir);
}
