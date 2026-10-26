//! What a paired device may reach (spec/pairing.md, Transport and Capabilities), end to end over
//! the same Noise session a phone or a cluster head uses.
//!
//! The node here is a real one: `remote::serve` in front of `device_app`, the loopback `app` with
//! the operator's token beside it, a stub engine, a stub Autobot (which counts what reaches it),
//! an audit log with entries in it, a cluster and a dispatcher, so every route a device is
//! refused would answer 200 for the token. The device pairs over loopback, as the other tests do,
//! and then asks through `remote::tunnel` — the same plain-HTTP door `invincible tunnel` opens.
//!
//! A device is admitted by the capability set it was granted at pairing: `shard` (the default,
//! and the six routes this file's first two tests walk), and `agent`, `audit`, `dispatch` only
//! when the operator granted them on the node's own API — `PATCH /v1/admin/devices/{name}`, what
//! `invincible devices grant` sends, or `PATCH /v1/cluster/nodes/{name}`, the same write. The
//! tests here are about that boundary: a shard is a shard, a grant opens exactly one more route, a
//! revocation closes it again with no re-pairing, a device cannot widen its own set — the 404 it
//! gets answers byte for byte like a path that was never mounted — and a device granted `audit`
//! reads its own entries in the log and no one else's, as does a node that sends work here.

use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};

use axum::Router;
use axum::body::Bytes;
use axum::response::IntoResponse;
use axum::routing::post;
use invincible::devices::{Devices, KnownNode, StaticKey};
use invincible::dispatch::{DISPATCHED_TO, Dispatch};
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

/// An engine that answers a chat completion with what it was asked — at once, or after the
/// `hold_ms` the request asks for, so a test can keep a request in flight.
async fn stub_engine() -> String {
    let router = Router::new().route(
        "/v1/chat/completions",
        post(|body: Bytes| async move {
            let request: Value = serde_json::from_slice(&body).unwrap();
            if let Some(ms) = request["hold_ms"].as_u64() {
                tokio::time::sleep(std::time::Duration::from_millis(ms)).await;
            }
            axum::Json(json!({ "engine_saw": request, "seen_bytes": body.len() })).into_response()
        })
        .layer(axum::extract::DefaultBodyLimit::max(64 << 20)),
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
    node_in(temp_dir("node")).await
}

/// [node], in a home of the caller's choosing (so a test can put a `devices.json` there first).
async fn node_in(dir: std::path::PathBuf) -> Node {
    node_holding_in(dir, invincible::config::DEFAULT_MAX_BUFFERED_BYTES).await
}

/// The same node, holding at most [ceiling] bytes of device request bodies at once
/// (`[node] max_buffered_bytes`, spec/pairing.md, Limits).
async fn node_holding(ceiling: u64) -> Node {
    node_holding_in(temp_dir("node"), ceiling).await
}

async fn node_holding_in(dir: std::path::PathBuf, ceiling: u64) -> Node {
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
        llama_build: None,
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
            .with_max_buffered_bytes(ceiling)
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
    pair_as(node, key, "phone").await
}

/// Pairs [key] with [node] under [name], through a code that grants the default.
async fn pair_as(node: &Node, key: &StaticKey, name: &str) -> String {
    let code = PairingCode::decode(&node.pairing.start().unwrap().encode()).unwrap();
    remote::pair(&code, key, name).await.unwrap().device
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

/// `PATCH /v1/admin/devices/{name}` on the operator API with [capabilities] — what `invincible
/// devices grant` sends; the status and body.
async fn grant(node: &Node, name: &str, capabilities: Value) -> (u16, Value) {
    operator_patch(node, &format!("/v1/admin/devices/{name}"), json!({ "capabilities": capabilities })).await
}

/// The same grant on `PATCH /v1/cluster/nodes/{name}`, the membership route.
async fn grant_on_cluster_route(node: &Node, name: &str, capabilities: Value) -> (u16, Value) {
    operator_patch(node, &format!("/v1/cluster/nodes/{name}"), json!({ "capabilities": capabilities })).await
}

/// `PATCH` [path] on the operator API with [body]; the status and the answer's JSON.
async fn operator_patch(node: &Node, path: &str, body: Value) -> (u16, Value) {
    let response = operator().patch(format!("{}{path}", node.url)).json(&body).send().await.unwrap();
    let status = response.status().as_u16();
    (status, response.json().await.unwrap_or(Value::Null))
}

/// `POST` [path] on the operator API with [body]; the status and the answer's JSON.
async fn operator_post(node: &Node, path: &str, body: Value) -> (u16, Value) {
    let response = operator().post(format!("{}{path}", node.url)).json(&body).send().await.unwrap();
    let status = response.status().as_u16();
    (status, response.json().await.unwrap_or(Value::Null))
}

/// `GET /v1/admin/devices` on the operator API: every paired device with its set.
async fn listed(node: &Node) -> Value {
    operator().get(format!("{}/v1/admin/devices", node.url)).send().await.unwrap().json().await.unwrap()
}

/// A request through the door, and the status and body it answered.
async fn ask(client: &reqwest::Client, door: &str, method: &str, path: &str) -> (u16, String) {
    let mut request = client
        .request(reqwest::Method::from_bytes(method.as_bytes()).unwrap(), format!("{door}{path}"))
        .header("content-type", "application/json");
    if method != "GET" {
        request = request.body(r#"{}"#);
    }
    let response = request.send().await.unwrap_or_else(|e| panic!("{method} {path}: {e}"));
    (response.status().as_u16(), response.text().await.unwrap())
}

/// Asserts [method] [path] is answered exactly as a path that was never mounted: same status and
/// the same bytes. This is the property a revoked or un-granted route keeps.
async fn refused_like_unknown(client: &reqwest::Client, door: &str, method: &str, path: &str) {
    let (status, body) = ask(client, door, method, path).await;
    assert_eq!(status, 404, "{method} {path} is not in this device's set");
    let (unknown_status, unknown) = ask(client, door, "GET", "/v1/nothing-here").await;
    assert_eq!(unknown_status, 404);
    assert_eq!(body, unknown, "{method} {path} answers like an unknown path");
}

/// A chat completion through [door]; its request id (what its receipt and audit entry carry).
async fn chat(client: &reqwest::Client, door: &str) -> String {
    completion(client, &format!("{door}/v1/chat/completions")).await
}

/// A completion the head at [door] dispatches; its request id.
async fn dispatched(client: &reqwest::Client, door: &str) -> String {
    completion(client, &format!("{door}/v1/dispatch/chat/completions")).await
}

/// A completion posted to [url]; its request id.
async fn completion(client: &reqwest::Client, url: &str) -> String {
    let response = client
        .post(url)
        .json(&json!({ "model": "small", "messages": [{ "role": "user", "content": "hi" }] }))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), 200, "{url}");
    let id = response.headers()[invincible::receipts::REQUEST_ID_HEADER].to_str().unwrap().to_owned();
    let _ = response.bytes().await.unwrap();
    id
}

/// The operator's read of the log once it holds [n] entries: an entry is written as its answer
/// ends, which can be just after the client has read the last byte.
async fn audited(node: &Node, n: usize) -> Value {
    for _ in 0..200 {
        let log: Value =
            operator().get(format!("{}/v1/audit?limit=500", node.url)).send().await.unwrap().json().await.unwrap();
        if log["entries"].as_array().unwrap().len() >= n {
            return log;
        }
        tokio::time::sleep(std::time::Duration::from_millis(10)).await;
    }
    panic!("the audit log never held {n} entries");
}

/// `GET /v1/audit` through [door], as the device there reads it.
async fn read_audit(client: &reqwest::Client, door: &str, query: &str) -> Value {
    let response = client.get(format!("{door}/v1/audit{query}")).send().await.unwrap();
    assert_eq!(response.status(), 200, "{door}/v1/audit{query}");
    response.json().await.unwrap()
}

/// The request ids in a `GET /v1/audit` answer, oldest first.
fn ids(audit: &Value) -> Vec<String> {
    audit["entries"]
        .as_array()
        .unwrap()
        .iter()
        .map(|entry| entry["receipt"]["receipt"]["request_id"].as_str().unwrap().to_owned())
        .collect()
}

/// Every operator route, with a body where one is needed: the ones the audit found reachable, the
/// membership and admin routes, and a path that does not exist at all (`/v1/user/models`). All of
/// them are refused for a device holding the default set — `shard`, which is what pairing grants
/// unless the operator says otherwise — including the three routes a grant can open.
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
    ("POST", "/v1/admin/pairing", Some(r#"{}"#)),
    ("PATCH", "/v1/admin/devices/phone", Some(r#"{"capabilities":["shard","agent","audit","dispatch"]}"#)),
    ("DELETE", "/v1/admin/devices/phone", None),
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
        let mut request =
            client.request(reqwest::Method::from_bytes(method.as_bytes()).unwrap(), format!("{door}{path}"));
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
    // Nor did any of it change the device: still pinned, still `shard` alone.
    assert!(node.pairing.devices.is_pinned(&phone.public));
    assert_eq!(listed(&node).await["devices"][0]["capabilities"], json!(["shard"]));

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

    // And the set it all comes from is the default one, visible to the operator: pairing granted
    // `shard` and nothing else (spec/pairing.md, Capabilities).
    assert_eq!(listed(&node).await["devices"][0]["name"], "phone");
    assert_eq!(listed(&node).await["devices"][0]["capabilities"], json!(["shard"]));
    let _ = std::fs::remove_dir_all(dir);
}

#[tokio::test]
async fn a_device_cannot_hold_more_than_the_nodes_body_ceiling() {
    // 2 MiB of device bodies at once, over the real session path: the door, the Noise pipe, the
    // listener. Bodies of 1.5 MiB are legal on their own; four at once are not.
    let node = node_holding(2 << 20).await;
    let (phone, dir) = device("phone-ceiling");
    pair(&node, &phone).await;
    let door = door(&node, &phone).await;
    let client = client();
    let body = json!({
        "model": "small",
        "max_tokens": 16,
        "messages": [{ "role": "user", "content": "x".repeat(1 << 20) }],
        "hold_ms": 1_000,
    });

    let mut tasks = Vec::new();
    for _ in 0..4 {
        let url = format!("{door}/v1/chat/completions");
        let body = body.clone();
        let client = client.clone();
        tasks.push(tokio::spawn(async move {
            let response = client.post(url).json(&body).send().await.unwrap();
            let status = response.status().as_u16();
            let retry = response.headers().get("retry-after").and_then(|v| v.to_str().ok()).map(str::to_owned);
            (status, retry, response.text().await.unwrap())
        }));
    }
    let mut answered = 0;
    let mut refused = 0;
    for task in tasks {
        let (status, retry, body) = task.await.unwrap();
        match status {
            200 => answered += 1,
            503 => {
                refused += 1;
                assert_eq!(retry.as_deref(), Some("2"), "a refusal says when to come back");
                assert!(body.contains(&(2 << 20).to_string()), "a refusal names the ceiling: {body}");
            }
            other => panic!("unexpected answer {other}: {body}"),
        }
    }
    assert!(answered <= 1, "{answered} bodies of 1.5 MiB were held past a 2 MiB ceiling");
    assert!(refused >= 1, "nothing was refused, so the ceiling was not applied");

    // Refusing did not take the node with it: healthz, the operator's API, and one more device
    // turn all answer.
    assert_eq!(client.get(format!("{}/healthz", node.url)).send().await.unwrap().status(), 200);
    let operator = operator();
    assert_eq!(operator.get(format!("{}/v1/audit", node.url)).send().await.unwrap().status(), 200);
    let chat = client
        .post(format!("{door}/v1/chat/completions"))
        .json(&json!({ "model": "small", "messages": [{ "role": "user", "content": "hi" }] }))
        .send()
        .await
        .unwrap();
    assert_eq!(chat.status(), 200);
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

#[tokio::test]
async fn granting_agent_opens_the_proxy_and_revoking_it_closes_it_without_re_pairing() {
    let node = node().await;
    let (phone, dir) = device("phone-grant");
    assert_eq!(pair(&node, &phone).await, "phone");
    let door = door(&node, &phone).await;
    let client = client();

    // The default: `shard`, so the proxy is not there — and says so the way any absent path does.
    refused_like_unknown(&client, &door, "GET", "/v1/agent").await;
    refused_like_unknown(&client, &door, "POST", "/v1/agent/turns").await;
    assert_eq!(node.agent_hits.load(Ordering::SeqCst), 0, "a shard drove the agent");

    // The operator grants `agent` on the device this node hosts.
    let (status, answer) = grant(&node, "phone", json!(["shard", "agent"])).await;
    assert_eq!(status, 200, "{answer}");
    assert_eq!(answer["device"], "phone");
    assert_eq!(answer["capabilities"], json!(["shard", "agent"]));
    assert_eq!(answer["was"], json!(["shard"]));
    assert_eq!(answer["changed"], true);

    // The same pairing, the same doorway, no re-pairing: the proxy answers now, with the node's
    // token, and Autobot is the one that answered.
    let reply = client.get(format!("{door}/v1/agent")).send().await.unwrap();
    assert_eq!(reply.status(), 200);
    assert_eq!(node.agent_hits.load(Ordering::SeqCst), 1);
    let turn =
        client.post(format!("{door}/v1/agent/sessions/s1/turns")).json(&json!({ "text": "hi" })).send().await.unwrap();
    assert_eq!(turn.status(), 200);
    assert_eq!(node.agent_hits.load(Ordering::SeqCst), 2);

    // One capability is one route family: what was not granted stays absent, byte for byte.
    refused_like_unknown(&client, &door, "GET", "/v1/audit").await;
    refused_like_unknown(&client, &door, "POST", "/v1/dispatch/chat/completions").await;
    // And a grant is not a whole-API grant: the admin and membership routes are still not there.
    refused_like_unknown(&client, &door, "PATCH", "/v1/admin/devices/phone").await;
    refused_like_unknown(&client, &door, "PATCH", "/v1/cluster/nodes/phone").await;
    refused_like_unknown(&client, &door, "POST", "/v1/cluster/pair").await;

    // Revoking is the same route with the smaller set, and it needs no re-pairing either.
    let (status, revoked) = grant(&node, "phone", json!(["shard"])).await;
    assert_eq!(status, 200, "{revoked}");
    assert_eq!(revoked["capabilities"], json!(["shard"]));
    assert_eq!(revoked["was"], json!(["shard", "agent"]));
    assert_eq!(revoked["changed"], true);
    let before = node.agent_hits.load(Ordering::SeqCst);
    refused_like_unknown(&client, &door, "GET", "/v1/agent").await;
    assert_eq!(node.agent_hits.load(Ordering::SeqCst), before, "a revoked device still reached the agent");

    // A shard stays a shard: the six routes answer, and the device is still the one that paired.
    assert!(node.pairing.devices.is_pinned(&phone.public), "the device was never unpinned");
    assert_eq!(node.pairing.devices.list().len(), 1);
    for path in ["/v1/models", "/v1/node", "/v1/cluster/node"] {
        assert_eq!(client.get(format!("{door}{path}")).send().await.unwrap().status(), 200, "{path}");
    }
    // The operator's listing is the record the gate reads.
    assert_eq!(listed(&node).await["devices"][0]["capabilities"], json!(["shard"]));

    // Revoking a capability the device does not hold changes nothing, and says so.
    let (status, same) = grant(&node, "phone", json!(["shard"])).await;
    assert_eq!(status, 200);
    assert_eq!(same["changed"], false);
    // A device this node does not host, a name that is not a capability, and a set that is not a
    // list.
    let (status, unknown) = grant(&node, "nowhere", json!(["shard"])).await;
    assert_eq!(status, 404, "{unknown}");
    assert!(unknown["error"]["message"].as_str().unwrap().contains("nowhere"), "{unknown}");
    for bad in [json!(["root"]), json!(["shard", "teleport"]), json!("agent")] {
        let (status, refused) = grant(&node, "phone", bad.clone()).await;
        assert_eq!(status, 400, "{bad}: {refused}");
        assert_eq!(refused["error"]["code"], "invalid_capabilities", "{bad}");
    }
    assert_eq!(listed(&node).await["devices"][0]["capabilities"], json!(["shard"]), "a refused grant wrote nothing");

    // A set can be emptied: the device stays paired, and reaches nothing — no route at all, each
    // answered as an unknown path. Its key is still pinned and it can be granted again.
    let (status, empty) = grant(&node, "phone", json!([])).await;
    assert_eq!(status, 200, "{empty}");
    assert_eq!(empty["capabilities"], json!([]));
    assert_eq!(empty["was"], json!(["shard"]));
    for path in ["/v1/models", "/v1/node", "/v1/cluster/node", "/v1/agent"] {
        refused_like_unknown(&client, &door, "GET", path).await;
    }
    assert!(node.pairing.devices.is_pinned(&phone.public));
    let (status, _) = grant(&node, "phone", json!(["shard"])).await;
    assert_eq!(status, 200);
    assert_eq!(client.get(format!("{door}/v1/models")).send().await.unwrap().status(), 200);
    let _ = std::fs::remove_dir_all(dir);
}

#[tokio::test]
async fn a_code_carries_the_grant_and_a_device_cannot_widen_its_own_set() {
    let node = node().await;
    let client = client();

    // A code minted with no capabilities grants `shard`, and the answer says so where the code is
    // handed out: the default is visible, not implied.
    let (status, code) = operator_post(&node, "/v1/cluster/pair", json!({ "name": "a phone" })).await;
    assert_eq!(status, 200, "{code}");
    assert_eq!(code["capabilities"], json!(["shard"]));

    // A code that pre-grants `agent` gives the device that consumes it the proxy at once.
    let (status, code) = operator_post(&node, "/v1/cluster/pair", json!({ "capabilities": ["shard", "agent"] })).await;
    assert_eq!(status, 200, "{code}");
    assert_eq!(code["capabilities"], json!(["shard", "agent"]));
    let (phone, dir) = device("phone-pregrant");
    let code = PairingCode::decode(code["code_uri"].as_str().unwrap()).unwrap();
    let paired = remote::pair(&code, &phone, "phone").await.unwrap();
    assert_eq!(paired.capabilities.codes(), ["shard", "agent"], "the joining side is told what it got");
    let door = door(&node, &phone).await;
    assert_eq!(client.get(format!("{door}/v1/agent")).send().await.unwrap().status(), 200);

    // The device cannot widen its set: every route that would change it is absent to it, and each
    // refusal is byte for byte an unknown path's.
    refused_like_unknown(&client, &door, "PATCH", "/v1/cluster/nodes/phone").await;
    refused_like_unknown(&client, &door, "POST", "/v1/cluster/pair").await;
    refused_like_unknown(&client, &door, "POST", "/v1/cluster/join").await;
    refused_like_unknown(&client, &door, "PATCH", "/v1/admin/devices/phone").await;
    refused_like_unknown(&client, &door, "POST", "/v1/admin/pairing").await;
    refused_like_unknown(&client, &door, "DELETE", "/v1/admin/devices/phone").await;
    let (patch_status, _) = ask(&client, &door, "PATCH", "/v1/cluster/nodes/phone").await;
    assert_eq!(patch_status, 404, "a device asked for more and was answered with no such route");
    assert_eq!(
        node.pairing.devices.named("phone").unwrap().capabilities.codes(),
        ["shard", "agent"],
        "the set the code granted, unchanged by anything the device sent"
    );

    // A body naming a capability that does not exist is refused before a code exists at all.
    let (status, bad) = operator_post(&node, "/v1/cluster/pair", json!({ "capabilities": ["shard", "root"] })).await;
    assert_eq!(status, 400, "{bad}");
    assert_eq!(bad["error"]["code"], "invalid_capabilities");
    let _ = std::fs::remove_dir_all(dir);
}

#[tokio::test]
async fn a_device_recorded_before_capabilities_loads_as_a_shard() {
    let (phone, dir) = device("phone-legacy");
    // A `devices.json` exactly as an older node wrote it: a name and a key, no set at all.
    let home = temp_dir("node-legacy");
    std::fs::create_dir_all(&home).unwrap();
    let legacy = json!([{ "name": "phone", "key": base64_key(&phone.public) }]);
    std::fs::write(home.join("devices.json"), serde_json::to_string_pretty(&legacy).unwrap()).unwrap();
    let node = node_in(home).await;
    let door = door(&node, &phone).await;
    let client = client();

    // No re-pairing: the key is already pinned, and the safe reading of "no set" is `shard`.
    assert!(node.pairing.devices.is_pinned(&phone.public));
    assert_eq!(listed(&node).await["devices"][0]["capabilities"], json!(["shard"]));
    for path in ["/v1/models", "/v1/node", "/v1/cluster/node"] {
        assert_eq!(client.get(format!("{door}{path}")).send().await.unwrap().status(), 200, "{path}");
    }
    // And it is a shard only: the grants an older file could not have recorded are absent.
    refused_like_unknown(&client, &door, "GET", "/v1/agent").await;
    refused_like_unknown(&client, &door, "GET", "/v1/audit").await;
    refused_like_unknown(&client, &door, "GET", "/v1/dispatch").await;
    assert_eq!(node.agent_hits.load(Ordering::SeqCst), 0);

    // Granting works on a migrated record like on any other.
    let (status, answer) = grant(&node, "phone", json!(["shard", "audit"])).await;
    assert_eq!(status, 200, "{answer}");
    assert_eq!(answer["was"], json!(["shard"]));
    let audit: Value = client.get(format!("{door}/v1/audit")).send().await.unwrap().json().await.unwrap();
    assert!(audit["entries"].is_array(), "{audit}");
    let _ = std::fs::remove_dir_all(dir);
}

#[tokio::test]
async fn both_grant_routes_write_the_one_record_the_gate_reads_and_answer_alike() {
    let node = node().await;
    let (phone, dir) = device("phone-routes");
    pair(&node, &phone).await;
    let door = door(&node, &phone).await;
    let client = client();

    // A paired device and a node that joined this one are one entry in `devices.json`: what the
    // admin route grants, the membership route reads back as what the device held, and the other
    // way round.
    let (status, admin) = grant(&node, "phone", json!(["shard", "audit"])).await;
    assert_eq!(status, 200, "{admin}");
    assert_eq!(
        admin,
        json!({ "device": "phone", "capabilities": ["shard", "audit"], "was": ["shard"], "changed": true })
    );
    assert_eq!(client.get(format!("{door}/v1/audit")).send().await.unwrap().status(), 200);
    let (status, cluster) = grant_on_cluster_route(&node, "phone", json!(["shard", "audit"])).await;
    assert_eq!(status, 200, "{cluster}");
    assert_eq!(
        cluster,
        json!({ "device": "phone", "capabilities": ["shard", "audit"], "was": ["shard", "audit"], "changed": false })
    );
    let (status, revoked) = grant_on_cluster_route(&node, "phone", json!(["shard"])).await;
    assert_eq!(status, 200, "{revoked}");
    let (status, again) = grant(&node, "phone", json!(["shard"])).await;
    assert_eq!(status, 200, "{again}");
    assert_eq!(again["was"], json!(["shard"]), "the admin route reads what the membership route wrote");
    refused_like_unknown(&client, &door, "GET", "/v1/audit").await;

    // The same refusals, word for word: a device this node does not host, a name that is not a
    // capability.
    for (name, set) in [("nowhere", json!(["shard"])), ("phone", json!(["shard", "root"])), ("phone", json!("audit"))] {
        let admin = grant(&node, name, set.clone()).await;
        let cluster = grant_on_cluster_route(&node, name, set.clone()).await;
        assert!(admin.0 == 404 || admin.0 == 400, "{name} {set}: {admin:?}");
        assert_eq!(admin, cluster, "{name} {set}: the two routes refuse alike");
    }
    // The admin route takes a set and nothing else: a body without one is refused, and names the
    // codes it could have held.
    for body in [json!({}), json!({ "name": "pixel" })] {
        let (status, refused) = operator_patch(&node, "/v1/admin/devices/phone", body.clone()).await;
        assert_eq!(status, 400, "{body}: {refused}");
        assert_eq!(refused["error"]["code"], "invalid_request_error", "{body}");
        assert!(refused["error"]["message"].as_str().unwrap().contains("dispatch"), "{refused}");
    }
    let not_json =
        operator().patch(format!("{}/v1/admin/devices/phone", node.url)).body("shard,agent").send().await.unwrap();
    assert_eq!(not_json.status(), 400);

    // It is the operator's: without the token it is refused before it reads the body, and from
    // the device's own session it is not there at all, whatever the body asks for.
    let anonymous = reqwest::Client::new()
        .patch(format!("{}/v1/admin/devices/phone", node.url))
        .json(&json!({ "capabilities": ["shard", "agent", "audit", "dispatch"] }))
        .send()
        .await
        .unwrap();
    assert_eq!(anonymous.status(), 401);
    let widened = client
        .patch(format!("{door}/v1/admin/devices/phone"))
        .json(&json!({ "capabilities": ["shard", "agent", "audit", "dispatch"] }))
        .send()
        .await
        .unwrap();
    assert_eq!(widened.status(), 404);
    assert_eq!(listed(&node).await["devices"][0]["name"], "phone", "a refused body renamed nothing");
    assert_eq!(listed(&node).await["devices"][0]["capabilities"], json!(["shard"]), "a refused grant wrote nothing");
    let _ = std::fs::remove_dir_all(dir);
}

#[tokio::test]
async fn a_device_granted_audit_reads_only_its_own_entries() {
    let node = node().await;
    let (phone, phone_dir) = device("phone-audit");
    let (laptop, laptop_dir) = device("laptop-audit");
    pair_as(&node, &phone, "phone").await;
    pair_as(&node, &laptop, "laptop").await;
    let (phone_door, laptop_door) = (door(&node, &phone).await, door(&node, &laptop).await);
    let client = client();

    // Three callers write to the log: the operator, the phone, the laptop.
    completion(&operator(), &format!("{}/v1/chat/completions", node.url)).await;
    let phone_first = chat(&client, &phone_door).await;
    let laptop_only = chat(&client, &laptop_door).await;
    let phone_second = chat(&client, &phone_door).await;
    let operator_view = audited(&node, 4).await;
    assert_eq!(operator_view["entries"].as_array().unwrap().len(), 4, "the operator reads every caller's");
    // An entry an older node wrote for a device of the same name: no key in it, so it cannot be
    // shown as anyone's own. (Appended as one from before the key was recorded, with a receipt the
    // node signed.)
    let mut legacy = operator_view["entries"]
        .as_array()
        .unwrap()
        .iter()
        .find(|entry| entry["request_id"] == phone_first.as_str())
        .unwrap()
        .clone();
    legacy.as_object_mut().unwrap().remove("caller_key");
    let log = node.dir.join("audit.jsonl");
    let mut text = std::fs::read_to_string(&log).unwrap();
    text.push_str(&format!("{legacy}\n"));
    std::fs::write(&log, text).unwrap();

    let (status, _) = grant(&node, "phone", json!(["shard", "audit"])).await;
    assert_eq!(status, 200);
    let mine = read_audit(&client, &phone_door, "").await;
    assert_eq!(ids(&mine), [phone_first.clone(), phone_second.clone()], "the phone's own entries, and only those");
    for entry in mine["entries"].as_array().unwrap() {
        assert_eq!(entry["caller"], "device:phone");
        assert_eq!(entry["caller_key"], base64_key(&phone.public));
    }
    // The totals are over what the device may see, not the whole log.
    assert_eq!(mine["summary"]["requests"], 2);
    // `limit` counts the device's own entries: the newest of them, not the newest overall.
    let newest = read_audit(&client, &phone_door, "?limit=1").await;
    assert_eq!(ids(&newest), [phone_second]);
    assert_eq!(newest["summary"]["requests"], 1);
    // `since` past every entry leaves nothing, for the device as for the operator.
    let later = read_audit(&client, &phone_door, "?since=99999999999").await;
    assert_eq!(ids(&later), Vec::<String>::new());

    // The laptop holds `shard` alone: the log is not there for it at all.
    refused_like_unknown(&client, &laptop_door, "GET", "/v1/audit").await;
    // Granted `audit`, it reads its one entry and nothing of the phone's or the operator's.
    let (status, _) = grant(&node, "laptop", json!(["shard", "audit"])).await;
    assert_eq!(status, 200);
    let theirs = read_audit(&client, &laptop_door, "").await;
    assert_eq!(ids(&theirs), [laptop_only]);

    // A name is a label, not an identity: a new device paired as "phone" after the first is
    // unpaired reads none of the first phone's entries.
    assert_eq!(operator().delete(format!("{}/v1/admin/devices/phone", node.url)).send().await.unwrap().status(), 204);
    let (successor, successor_dir) = device("phone-successor");
    assert_eq!(pair_as(&node, &successor, "phone").await, "phone");
    let (status, _) = grant(&node, "phone", json!(["shard", "audit"])).await;
    assert_eq!(status, 200);
    let successor_door = door(&node, &successor).await;
    let inherited = read_audit(&client, &successor_door, "").await;
    assert_eq!(ids(&inherited), Vec::<String>::new(), "a new key under an old name inherits nothing");
    assert_eq!(inherited["summary"]["requests"], 0);
    for dir in [phone_dir, laptop_dir, successor_dir] {
        let _ = std::fs::remove_dir_all(dir);
    }
}

#[tokio::test]
async fn a_device_granted_dispatch_reads_its_dispatched_requests_and_no_one_elses() {
    let node = node().await;
    let (phone, phone_dir) = device("phone-dispatch");
    let (laptop, laptop_dir) = device("laptop-dispatch");
    pair_as(&node, &phone, "phone").await;
    pair_as(&node, &laptop, "laptop").await;
    assert_eq!(grant(&node, "phone", json!(["shard", "audit", "dispatch"])).await.0, 200);
    assert_eq!(grant(&node, "laptop", json!(["shard", "dispatch"])).await.0, 200);
    let (phone_door, laptop_door) = (door(&node, &phone).await, door(&node, &laptop).await);
    let client = client();

    // Each asks this node to dispatch a completion (it is the only node it owns, so it answers
    // itself), and the phone sends one turn of its own as well.
    let phone_dispatched = dispatched(&client, &phone_door).await;
    let laptop_dispatched = dispatched(&client, &laptop_door).await;
    let operator_dispatched = dispatched(&operator(), &node.url).await;
    let phone_chat = chat(&client, &phone_door).await;
    audited(&node, 4).await;

    let mine = read_audit(&client, &phone_door, "").await;
    assert_eq!(ids(&mine), [phone_dispatched.clone(), phone_chat], "the phone's own requests, dispatched or not");
    let entry = &mine["entries"][0];
    assert_eq!(entry["api"], "dispatch");
    assert_eq!(entry["dispatch"], json!({ "via": "studio", "node": "studio" }));
    assert_eq!(entry["caller_key"], base64_key(&phone.public));
    assert_eq!(mine["summary"]["requests"], 2);

    // The laptop holds `dispatch` and not `audit`: the log is not there for it.
    refused_like_unknown(&client, &laptop_door, "GET", "/v1/audit").await;
    // And what the dispatcher shows a device is nodes, not callers: no one's request is in it.
    let status: Value = client.get(format!("{phone_door}/v1/dispatch")).send().await.unwrap().json().await.unwrap();
    assert_eq!(status["name"], "studio");
    for id in [&phone_dispatched, &laptop_dispatched, &operator_dispatched] {
        assert!(!status.to_string().contains(id.as_str()), "{status}");
    }
    for dir in [phone_dir, laptop_dir] {
        let _ = std::fs::remove_dir_all(dir);
    }
}

/// A head that dispatches to [node] over the link [key] paired: its own machine serves no model,
/// so whatever its operator asks it to dispatch goes to [node]. The URL of its loopback API, and
/// its home.
async fn head(node: &Node, key: &StaticKey, name: &str) -> (String, std::path::PathBuf) {
    let dir = temp_dir("head");
    std::fs::create_dir_all(&dir).unwrap();
    let peer = KnownNode {
        name: "studio".into(),
        key: base64_key(&node.pairing.key.public),
        addrs: vec![node.addr.clone()],
        receipt_key: Some(node.pairing.receipt_key.clone()),
        device: Some(name.into()),
        capabilities: Default::default(),
    };
    let settings = NodeSettings { network: NetworkMode::Offline, egress: Egress::Never };
    let dispatch =
        Dispatch::new(name.into(), Vec::new(), 1, dir.clone(), vec![peer], Some(key.clone()), "offline".into());
    let state = AppState::new(Vec::new(), settings, TOKEN.into())
        .with_receipt_key(name, invincible::receipts::ReceiptKey::from_seed(&[9; 32]))
        .with_dispatch(dispatch);
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}", listener.local_addr().unwrap());
    tokio::spawn(async move { axum::serve(listener, invincible::server::app(Arc::new(state))).await.unwrap() });
    (url, dir)
}

#[tokio::test]
async fn a_node_that_sends_work_here_reads_only_its_own_entries() {
    let node = node().await;
    let (phone, phone_dir) = device("phone-peer");
    pair(&node, &phone).await;
    assert_eq!(grant(&node, "phone", json!(["shard", "audit"])).await.0, 200);
    let phone_door = door(&node, &phone).await;
    let client = client();
    let phone_chat = chat(&client, &phone_door).await;
    completion(&operator(), &format!("{}/v1/chat/completions", node.url)).await;

    // Another node joins this one as a cluster node does, through a code from the membership API,
    // and dispatches here: its operator asks it, and this node is the one that serves the model.
    let (status, code) = operator_post(&node, "/v1/cluster/pair", json!({ "name": "mini" })).await;
    assert_eq!(status, 200, "{code}");
    let (mini, mini_dir) = device("mini-head");
    let code = PairingCode::decode(code["code_uri"].as_str().unwrap()).unwrap();
    assert_eq!(remote::pair(&code, &mini, "mini").await.unwrap().device, "mini");
    let (head, head_dir) = head(&node, &mini, "mini").await;
    let response = operator()
        .post(format!("{head}/v1/dispatch/chat/completions"))
        .json(&json!({ "model": "small", "messages": [{ "role": "user", "content": "hi" }] }))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), 200);
    assert_eq!(response.headers()[DISPATCHED_TO], "studio");
    let _ = response.bytes().await.unwrap();

    // Here, the head's request is the paired device "mini"'s, and its key is on the entry.
    let log = audited(&node, 3).await;
    let sent: Vec<&Value> =
        log["entries"].as_array().unwrap().iter().filter(|entry| entry["caller"] == "device:mini").collect();
    assert_eq!(sent.len(), 1, "{log}");
    assert_eq!(sent[0]["caller_key"], base64_key(&mini.public));
    let worked = sent[0]["request_id"].as_str().unwrap().to_owned();

    // Granted `audit` on the membership route, the head reads the work it sent and nothing else:
    // not the phone's turn, not the operator's, though all three are this node's log.
    let (status, _) = grant_on_cluster_route(&node, "mini", json!(["shard", "audit"])).await;
    assert_eq!(status, 200);
    let head_door = door(&node, &mini).await;
    let theirs = read_audit(&client, &head_door, "").await;
    assert_eq!(ids(&theirs), [worked]);
    assert_eq!(theirs["summary"]["requests"], 1);
    // And the phone, which holds `audit` too, does not read the head's.
    assert_eq!(ids(&read_audit(&client, &phone_door, "").await), [phone_chat]);
    for dir in [phone_dir, mini_dir, head_dir] {
        let _ = std::fs::remove_dir_all(dir);
    }
}

/// `invincible devices grant`, as the operator runs it on the node: the admin route, and one line
/// that says what the device reaches now and what it reached before.
#[tokio::test]
async fn invincible_devices_grant_sets_the_whole_set_and_says_what_it_was() {
    let node = node().await;
    let (phone, dir) = device("phone-cli");
    pair(&node, &phone).await;
    // The operator's home: the token, and the address the node's API listens on.
    let home = temp_dir("operator-home");
    std::fs::create_dir_all(&home).unwrap();
    std::fs::write(home.join("token"), format!("{TOKEN}\n")).unwrap();
    std::fs::write(home.join("config.toml"), format!("listen = \"{}\"\n", node.url.trim_start_matches("http://")))
        .unwrap();
    let run = |args: &[&str]| {
        tokio::process::Command::new(env!("CARGO_BIN_EXE_invincible"))
            .args(args)
            .env("INVINCIBLE_HOME", &home)
            .env("NO_COLOR", "1")
            .output()
    };

    let output = run(&["devices", "grant", "phone", "shard,agent"]).await.unwrap();
    assert!(output.status.success(), "{}", String::from_utf8_lossy(&output.stderr));
    let said = String::from_utf8_lossy(&output.stdout);
    assert!(said.contains("phone now reaches: shard, agent (was: shard)"), "{said}");
    assert_eq!(node.pairing.devices.named("phone").unwrap().capabilities.codes(), ["shard", "agent"]);

    // The list is the whole set: a code left out is revoked.
    let output = run(&["devices", "grant", "phone", "audit"]).await.unwrap();
    assert!(output.status.success(), "{}", String::from_utf8_lossy(&output.stderr));
    let said = String::from_utf8_lossy(&output.stdout);
    assert!(said.contains("phone now reaches: audit (was: shard, agent)"), "{said}");
    let listing = run(&["devices"]).await.unwrap();
    assert!(String::from_utf8_lossy(&listing.stdout).contains("audit"), "the listing shows the set");

    // A device the node does not host, and a name that is not a capability: the node's reason,
    // and nothing written.
    for (args, reason) in
        [(["devices", "grant", "nowhere", "shard"], "nowhere"), (["devices", "grant", "phone", "root"], "root")]
    {
        let output = run(&args).await.unwrap();
        assert!(!output.status.success(), "{args:?}");
        assert!(String::from_utf8_lossy(&output.stderr).contains(reason), "{args:?}");
    }
    // Unpairing is `--remove` on its own, never a side effect of a grant.
    let output = run(&["devices", "--remove", "phone", "grant", "phone", "shard"]).await.unwrap();
    assert!(!output.status.success());
    assert!(String::from_utf8_lossy(&output.stderr).contains("--remove"));
    assert!(node.pairing.devices.is_pinned(&phone.public));
    assert_eq!(node.pairing.devices.named("phone").unwrap().capabilities.codes(), ["audit"]);
    for dir in [dir, home] {
        let _ = std::fs::remove_dir_all(dir);
    }
}

/// [key] as `devices.json` holds it: base64url, no padding.
fn base64_key(key: &[u8]) -> String {
    use base64::Engine as _;
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(key)
}
