//! The cluster membership API (spec/cluster.md, Membership API) end to end on loopback: a pairing
//! code and a join between two in-process nodes, the list on both sides, rename, unpair, the token
//! guard on every route, and the refusals — each with no part of the membership written.
//!
//! The nodes are real ones: a `remote::serve` listener behind each, the same `AppState` the binary
//! builds, and `axum::serve` on loopback for the local API. Nothing is stubbed but the engines,
//! which these routes never touch.

use std::sync::Arc;
use std::time::Duration;

use invincible::devices::{Devices, KnownNodes, StaticKey, fingerprint};
use invincible::remote::{self, Pairing, PairingCode};
use invincible::server::{self, AppState, device_app};
use invincible_policy::{Egress, NetworkMode, NodeSettings};
use serde_json::{Value, json};
use tokio::net::TcpListener;

fn temp_dir(tag: &str) -> std::path::PathBuf {
    let n: u64 = u64::from_le_bytes(invincible::token::random::<8>().unwrap());
    std::env::temp_dir().join(format!("invincible-api-{tag}-{n:x}"))
}

/// A node in the test: its home, its token, its remote listener and its local API on loopback.
struct Node {
    name: String,
    home: std::path::PathBuf,
    url: String,
    pairing: Arc<Pairing>,
}

impl Drop for Node {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.home);
    }
}

impl Node {
    fn token(&self) -> String {
        format!("token-{}", self.name)
    }

    /// The nodes this machine recorded, as `nodes.json` holds them.
    fn nodes(&self) -> Vec<Value> {
        serde_json::from_str::<KnownNodes>(&std::fs::read_to_string(self.home.join("nodes.json")).unwrap())
            .unwrap()
            .0
            .into_iter()
            .map(|node| serde_json::to_value(node).unwrap())
            .collect()
    }

    fn rewritten_nodes(&self, change: impl Fn(&mut Value)) {
        let mut list = self.nodes();
        for node in &mut list {
            change(node);
        }
        std::fs::write(self.home.join("nodes.json"), serde_json::to_string_pretty(&list).unwrap()).unwrap();
    }
}

async fn node(name: &str) -> Node {
    let home = temp_dir(name);
    std::fs::create_dir_all(&home).unwrap();
    // This machine's own name: what `join_name` defaults to, and what a peer's `[cluster] heads`
    // has to contain.
    std::fs::write(home.join("config.toml"), format!("[remote]\nname = \"{name}\"\n")).unwrap();
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap().to_string();
    let pairing = Arc::new(Pairing::new(
        StaticKey::load_or_create(&home.join("node.key")).unwrap(),
        name.to_owned(),
        vec![addr],
        Devices::load(&home.join("devices.json")).unwrap(),
    ));
    let settings = NodeSettings { network: NetworkMode::Offline, egress: Egress::Never };
    let token = format!("token-{name}");
    let state =
        Arc::new(AppState::new(vec![], settings, token).with_pairing(pairing.clone()).with_membership(home.clone()));
    tokio::spawn(remote::serve(listener, pairing.clone(), device_app(state.clone())));
    let api = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}", api.local_addr().unwrap());
    tokio::spawn(async move { axum::serve(api, server::app(state)).await.unwrap() });
    Node { name: name.to_owned(), home, url, pairing }
}

/// `POST /v1/cluster/pair` on [node].
async fn pair(client: &reqwest::Client, node: &Node, body: Value) -> (u16, Value) {
    let response = client
        .post(format!("{}/v1/cluster/pair", node.url))
        .bearer_auth(node.token())
        .json(&body)
        .send()
        .await
        .unwrap();
    let status = response.status().as_u16();
    (status, response.json().await.unwrap())
}

/// `POST /v1/cluster/join` on [node].
async fn join(client: &reqwest::Client, node: &Node, body: Value) -> (u16, Value) {
    let response = client
        .post(format!("{}/v1/cluster/join", node.url))
        .bearer_auth(node.token())
        .json(&body)
        .send()
        .await
        .unwrap();
    let status = response.status().as_u16();
    (status, response.json().await.unwrap())
}

/// `GET /v1/cluster/nodes` on [node].
async fn nodes(client: &reqwest::Client, node: &Node) -> Value {
    client
        .get(format!("{}/v1/cluster/nodes", node.url))
        .bearer_auth(node.token())
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap()
}

#[tokio::test]
async fn a_code_minted_over_http_pairs_two_nodes_and_both_sides_show_it() {
    let studio = node("studio").await;
    let laptop = node("laptop").await;
    let client = reqwest::Client::new();

    // The head opens the code over the API, with a lifetime of its own.
    let (status, code) = pair(&client, &studio, json!({ "ttl_seconds": 120, "name": "laptop" })).await;
    assert_eq!(status, 200, "{code}");
    let uri = code["code_uri"].as_str().expect("a URI");
    assert!(uri.starts_with("invincible://pair?v=0&k="), "{uri}");
    assert!(uri.contains(&format!("s={}", code["secret"].as_str().expect("a secret"))));
    assert_eq!(code["node"], "studio");
    assert_eq!(code["expires_in_seconds"], 120);
    assert_eq!(code["fingerprint"], fingerprint(&studio.pairing.key.public));
    assert!(code["expires_at"].as_u64().unwrap() > 1_700_000_000, "an absolute time, not a duration");
    // The secret is in the answer twice, and in no log: the node logs the code's label only.

    // The laptop joins with it. No name given: its own `[remote] name`, as `invincible join` does.
    let (status, joined) = join(&client, &laptop, json!({ "uri": uri })).await;
    assert_eq!(status, 200, "{joined}");
    assert_eq!(joined["node"], "studio");
    assert_eq!(joined["device"], "laptop");
    assert_eq!(joined["heads_must_name"], "laptop");
    // The fingerprint the caller can compare against the code it was given.
    assert_eq!(joined["fingerprint"], code["fingerprint"]);

    // Both sides agree on who is who.
    assert_eq!(studio.pairing.devices.list().len(), 1);
    assert_eq!(studio.pairing.devices.list()[0].name, "laptop", "the name the peer lists it under");
    let seen = nodes(&client, &laptop).await;
    assert_eq!(seen["nodes"][0]["name"], "studio");
    assert_eq!(seen["nodes"][0]["device"], "laptop", "what studio lists this machine as");
    assert_eq!(seen["nodes"][0]["fingerprint"], code["fingerprint"]);
    assert_eq!(seen["nodes"][0]["reachable"], true, "{seen}");
    assert!(seen["nodes"][0]["probe_ms"].is_u64());

    // The other direction: a code minted the CLI's way (`Pairing::start`) is consumed by the API,
    // with a name of the caller's choosing.
    let cli_code = studio.pairing.start().unwrap().encode();
    let (status, joined) = join(&client, &laptop, json!({ "uri": cli_code, "name": "mbp" })).await;
    assert_eq!(status, 200, "{joined}");
    assert_eq!(joined["device"], "mbp");
    assert_eq!(joined["heads_must_name"], "mbp");
    let seen = nodes(&client, &laptop).await;
    assert_eq!(seen["nodes"].as_array().unwrap().len(), 1, "rejoining a node replaces its entry");
    assert_eq!(seen["nodes"][0]["device"], "mbp");
    assert_eq!(studio.pairing.devices.list()[0].name, "mbp", "renamed on the peer, one entry for one key");

    // And a node joined over the API is in `nodes.json`, so `invincible tunnel`/`cluster` read it.
    assert_eq!(laptop.nodes()[0]["name"], "studio");
    assert_eq!(laptop.nodes()[0]["device"], "mbp");
}

#[tokio::test]
async fn the_list_says_whether_each_node_answers_now() {
    let studio = node("studio").await;
    let laptop = node("laptop").await;
    let client = reqwest::Client::new();
    let code: Value = pair(&client, &studio, json!({})).await.1;
    join(&client, &laptop, json!({ "uri": code["code_uri"] })).await;
    assert_eq!(nodes(&client, &laptop).await["nodes"][0]["reachable"], true);

    // Pinned at an address where nothing listens any more: down, with the reason.
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let gone = listener.local_addr().unwrap().to_string();
    drop(listener);
    laptop.rewritten_nodes(|node| node["addrs"] = json!([gone]));
    let seen = nodes(&client, &laptop).await;
    assert_eq!(seen["nodes"][0]["reachable"], false, "{seen}");
    assert!(seen["nodes"][0]["error"].as_str().is_some());

    // A peer that accepts the connection and never answers is not waited for: the probe gives up
    // inside its budget and the node is reported unknown, with why — never `false`, never a block.
    let stalled = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let stalled_addr = stalled.local_addr().unwrap().to_string();
    tokio::spawn(async move {
        let (tcp, _) = stalled.accept().await.unwrap();
        tokio::time::sleep(Duration::from_secs(30)).await;
        drop(tcp);
    });
    laptop.rewritten_nodes(|node| node["addrs"] = json!([stalled_addr]));
    let started = std::time::Instant::now();
    let seen = nodes(&client, &laptop).await;
    assert!(started.elapsed() < Duration::from_secs(5), "the list is bounded by the probe budget");
    assert!(seen["nodes"][0]["reachable"].is_null(), "unknown, not down: {seen}");
    let reason = seen["nodes"][0]["reason"].as_str().expect("a reason");
    assert!(reason.contains("no answer within"), "{reason}");
}

#[tokio::test]
async fn rename_refuses_a_name_another_node_has_and_404s_an_unknown_one() {
    let studio = node("studio").await;
    let mini = node("mini").await;
    let laptop = node("laptop").await;
    let client = reqwest::Client::new();
    // The laptop knows two nodes: studio and mini.
    let code: Value = pair(&client, &studio, json!({})).await.1;
    join(&client, &laptop, json!({ "uri": code["code_uri"] })).await;
    let code: Value = pair(&client, &mini, json!({})).await.1;
    join(&client, &laptop, json!({ "uri": code["code_uri"] })).await;
    assert_eq!(nodes(&client, &laptop).await["nodes"].as_array().unwrap().len(), 2);

    // Renaming onto a name another node already has: refused, and nothing changes.
    let response = client
        .patch(format!("{}/v1/cluster/nodes/studio", laptop.url))
        .bearer_auth(laptop.token())
        .json(&json!({ "name": "mini" }))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), 409);
    let refused: Value = response.json().await.unwrap();
    assert_eq!(refused["error"]["code"], "name_taken");
    let names: Vec<String> = nodes(&client, &laptop).await["nodes"]
        .as_array()
        .unwrap()
        .iter()
        .map(|node| node["name"].as_str().unwrap().to_owned())
        .collect();
    assert_eq!(names, ["studio", "mini"], "the collision left both names alone");

    // A rename that is free: done here, and the peer is not touched (it still calls itself studio).
    let renamed: Value = client
        .patch(format!("{}/v1/cluster/nodes/studio", laptop.url))
        .bearer_auth(laptop.token())
        .json(&json!({ "name": "studio-2" }))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(renamed["name"], "studio-2");
    assert_eq!(renamed["was"], "studio");
    assert_eq!(laptop.nodes()[0]["name"], "studio-2");
    assert_eq!(studio.pairing.name, "studio", "a local rename does not reach the peer");

    // Renaming a node this machine does not know.
    let response = client
        .patch(format!("{}/v1/cluster/nodes/nowhere", laptop.url))
        .bearer_auth(laptop.token())
        .json(&json!({ "name": "x" }))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), 404);
    let body: Value = response.json().await.unwrap();
    assert!(body["error"]["message"].as_str().unwrap().contains("nowhere"), "{body}");

    // A name that is not one: refused rather than cleaned, so a rename never means something else.
    let response = client
        .patch(format!("{}/v1/cluster/nodes/mini", laptop.url))
        .bearer_auth(laptop.token())
        .json(&json!({ "name": "two words" }))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), 400);
}

#[tokio::test]
async fn unpairing_forgets_the_node_here_and_404s_an_unknown_name() {
    let studio = node("studio").await;
    let laptop = node("laptop").await;
    let client = reqwest::Client::new();
    let code: Value = pair(&client, &studio, json!({})).await.1;
    join(&client, &laptop, json!({ "uri": code["code_uri"] })).await;

    // An unknown name: 404 with the reason, and the known node is still there.
    let response = client
        .delete(format!("{}/v1/cluster/nodes/nowhere", laptop.url))
        .bearer_auth(laptop.token())
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), 404);
    let body: Value = response.json().await.unwrap();
    assert!(body["error"]["message"].as_str().unwrap().contains("no paired node"), "{body}");
    assert_eq!(nodes(&client, &laptop).await["nodes"].as_array().unwrap().len(), 1);

    // The known one: gone from `nodes.json`, and the peer keeps its own record — a local unpair is
    // this side's half of it.
    let response = client
        .delete(format!("{}/v1/cluster/nodes/studio", laptop.url))
        .bearer_auth(laptop.token())
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), 200);
    let body: Value = response.json().await.unwrap();
    assert_eq!(body["unpaired"], "studio");
    assert!(nodes(&client, &laptop).await["nodes"].as_array().unwrap().is_empty());
    assert_eq!(studio.pairing.devices.list().len(), 1, "the peer was not contacted");
    assert_eq!(studio.pairing.devices.list()[0].name, "laptop");
}

#[tokio::test]
async fn every_route_needs_the_token() {
    let studio = node("studio").await;
    let client = reqwest::Client::new();
    let routes = [
        (reqwest::Method::POST, "/v1/cluster/pair"),
        (reqwest::Method::POST, "/v1/cluster/join"),
        (reqwest::Method::GET, "/v1/cluster/nodes"),
        (reqwest::Method::PATCH, "/v1/cluster/nodes/studio"),
        (reqwest::Method::DELETE, "/v1/cluster/nodes/studio"),
    ];
    for (method, path) in routes {
        let url = format!("{}{path}", studio.url);
        let response = client.request(method.clone(), &url).json(&json!({})).send().await.unwrap();
        assert_eq!(response.status(), 401, "{method} {path} without a token");
        let response = client.request(method.clone(), &url).bearer_auth("wrong").send().await.unwrap();
        assert_eq!(response.status(), 401, "{method} {path} with the wrong token");
        // And a body the handler would refuse never reaches it before the token check.
        let response =
            client.request(method.clone(), &url).json(&json!({ "uri": "invincible://pair?v=0" })).send().await.unwrap();
        assert_eq!(response.status(), 401, "{method} {path} with a body and no token");
        // The right token reaches the handler: not 401.
        let response = client.request(method, &url).bearer_auth(studio.token()).json(&json!({})).send().await.unwrap();
        assert_ne!(response.status(), 401, "{path} with the token");
    }
}

#[tokio::test]
async fn a_bad_or_expired_uri_is_a_400_with_a_reason_and_writes_nothing() {
    let studio = node("studio").await;
    let laptop = node("laptop").await;
    let client = reqwest::Client::new();

    for bad in [
        "not a pairing code",
        "invincible://pair?v=0&k=short&s=short&a=127.0.0.1:1",
        "invincible://pair?v=9&k=AAAA&s=AAAA&a=127.0.0.1:1",
        "invincible://pair?v=0&k=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA&s=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    ] {
        let (status, body) = join(&client, &laptop, json!({ "uri": bad })).await;
        assert_eq!(status, 400, "{bad}: {body}");
        assert_eq!(body["error"]["code"], "invalid_pairing_code", "{bad}: {body}");
    }

    // A code the node will not take: expired (its lifetime ran out before anyone joined).
    let expired = studio.pairing.start_for(Duration::ZERO).unwrap().encode();
    let (status, body) = join(&client, &laptop, json!({ "uri": expired })).await;
    assert_eq!(status, 400, "{body}");
    assert_eq!(body["error"]["code"], "pairing_refused", "{body}");
    assert!(body["error"]["message"].as_str().unwrap().contains("refused"), "{body}");

    // A code that is well formed and points nowhere: the network's fault, not the caller's.
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let dead = listener.local_addr().unwrap().to_string();
    drop(listener);
    let nowhere = PairingCode { node_key: [7; 32], secret: [9; 32], addrs: vec![dead] }.encode();
    let (status, body) = join(&client, &laptop, json!({ "uri": nowhere })).await;
    assert_eq!(status, 502, "{body}");
    assert_eq!(body["error"]["code"], "join_failed", "{body}");

    // None of it wrote a membership, and none of it pinned anything on the peer.
    assert!(!laptop.home.join("nodes.json").exists(), "a failed join records nothing");
    assert!(studio.pairing.devices.list().is_empty());
}

#[tokio::test]
async fn a_second_join_while_one_is_in_flight_is_refused() {
    let laptop = node("laptop").await;
    let client = reqwest::Client::new();
    // A peer that accepts the connection and never answers: the first join sits in the handshake,
    // which is exactly the window the second one must not race into.
    let stalled = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = stalled.local_addr().unwrap().to_string();
    tokio::spawn(async move {
        let (tcp, _) = stalled.accept().await.unwrap();
        tokio::time::sleep(Duration::from_secs(30)).await;
        drop(tcp);
    });
    let code = PairingCode { node_key: [3; 32], secret: [4; 32], addrs: vec![addr] }.encode();
    let body = json!({ "uri": code });
    let first = tokio::spawn({
        let (client, url, token, body) = (client.clone(), laptop.url.clone(), laptop.token(), body.clone());
        async move {
            client.post(format!("{url}/v1/cluster/join")).bearer_auth(token).json(&body).send().await.unwrap().status()
        }
    });
    tokio::time::sleep(Duration::from_millis(300)).await;
    let (status, second) = join(&client, &laptop, body).await;
    assert_eq!(status, 409, "{second}");
    assert_eq!(second["error"]["code"], "join_in_progress");
    assert!(!laptop.home.join("nodes.json").exists(), "the refused join wrote nothing");
    first.abort();
}
