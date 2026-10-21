//! Cluster phase 1 (spec/cluster.md) end to end on loopback, with a stand-in for
//! `ggml-rpc-server`: shard links are encrypted and only for the heads a shard names, the head's
//! door leads through them, capabilities and status answer, and receipts name the nodes.

use std::sync::Arc;
use std::time::Duration;

use axum::Router;
use axum::body::Bytes;
use axum::routing::post;
use invincible::cluster::{self, ClusterRun, ClusterState, RunState};
use invincible::devices::{Devices, KnownNode, StaticKey};
use invincible::engine::Engine;
use invincible::remote::{self, Pairing, ShardService};
use invincible::server::{AppState, device_app};
use invincible_policy::{Egress, NetworkMode, NodeSettings, PlanDevice, PlanInput, SplitMode};
use serde_json::{Value, json};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};

fn temp_dir(tag: &str) -> std::path::PathBuf {
    let n: u64 = u64::from_le_bytes(invincible::token::random::<8>().unwrap());
    std::env::temp_dir().join(format!("invincible-cluster-{tag}-{n:x}"))
}

/// A stand-in for `ggml-rpc-server` on loopback: echoes every byte back.
async fn echo_server() -> u16 {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    tokio::spawn(async move {
        loop {
            let (mut tcp, _) = listener.accept().await.unwrap();
            tokio::spawn(async move {
                let (mut r, mut w) = tcp.split();
                let _ = tokio::io::copy(&mut r, &mut w).await;
            });
        }
    });
    port
}

/// A TCP relay that keeps every byte that crosses it, as someone on the network would see them.
async fn wiretap(to: String) -> (String, Arc<std::sync::Mutex<Vec<u8>>>) {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap().to_string();
    let seen = Arc::new(std::sync::Mutex::new(Vec::new()));
    let keep = seen.clone();
    tokio::spawn(async move {
        loop {
            let (mut inbound, _) = listener.accept().await.unwrap();
            let mut outbound = TcpStream::connect(&to).await.unwrap();
            let keep = keep.clone();
            tokio::spawn(async move {
                let mut a = [0u8; 65536];
                let mut b = [0u8; 65536];
                loop {
                    tokio::select! {
                        n = inbound.read(&mut a) => {
                            let Ok(n @ 1..) = n else { break };
                            keep.lock().unwrap().extend_from_slice(&a[..n]);
                            if outbound.write_all(&a[..n]).await.is_err() { break }
                        }
                        n = outbound.read(&mut b) => {
                            let Ok(n @ 1..) = n else { break };
                            keep.lock().unwrap().extend_from_slice(&b[..n]);
                            if inbound.write_all(&b[..n]).await.is_err() { break }
                        }
                    }
                }
            });
        }
    });
    (addr, seen)
}

struct Shard {
    pairing: Arc<Pairing>,
    addr: String,
    dir: std::path::PathBuf,
}

impl Drop for Shard {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

/// A node that serves as a shard for the device called `laptop`, with remote access on loopback.
async fn shard() -> Shard {
    let dir = temp_dir("shard");
    let rpc = echo_server().await;
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap().to_string();
    let pairing = Arc::new(
        Pairing::new(
            StaticKey::load_or_create(&dir.join("node.key")).unwrap(),
            "mini".into(),
            vec![addr.clone()],
            Devices::load(&dir.join("devices.json")).unwrap(),
        )
        .with_shard(ShardService { port: rpc, heads: vec!["laptop".into()], traffic: Arc::default() }),
    );
    let settings = NodeSettings { network: NetworkMode::Offline, egress: Egress::Never };
    let state = Arc::new(AppState::new(vec![], settings, "token".into()).with_pairing(pairing.clone()).with_cluster(
        ClusterState {
            name: "mini".into(),
            llama_server: "/nonexistent/llama-server".into(),
            rpc_backend: Some(true),
            peers: vec![],
            device_key: None,
            runs: vec![],
            shard: true,
        },
    ));
    tokio::spawn(remote::serve(listener, pairing.clone(), device_app(state)));
    Shard { pairing, addr, dir }
}

fn device(tag: &str) -> (StaticKey, std::path::PathBuf) {
    let dir = temp_dir(tag);
    (StaticKey::load_or_create(&dir.join("device.key")).unwrap(), dir)
}

/// [device] paired with [shard] under [name], as `invincible join` saves it.
async fn join(shard: &Shard, device: &StaticKey, name: &str) -> KnownNode {
    remote::pair(&shard.pairing.start().unwrap(), device, name).await.unwrap();
    known(shard, vec![shard.addr.clone()])
}

fn known(shard: &Shard, addrs: Vec<String>) -> KnownNode {
    use base64::Engine as _;
    KnownNode {
        name: "mini".into(),
        key: base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(&shard.pairing.key.public),
        addrs,
        receipt_key: None,
    }
}

/// Writes [data] into [port] and reads as many bytes back.
async fn round_trip(port: u16, data: &[u8]) -> std::io::Result<Vec<u8>> {
    let mut tcp = TcpStream::connect(("127.0.0.1", port)).await?;
    tcp.write_all(data).await?;
    let mut back = vec![0u8; data.len()];
    tokio::time::timeout(Duration::from_secs(10), tcp.read_exact(&mut back)).await??;
    Ok(back)
}

#[tokio::test]
async fn a_head_reaches_the_shard_through_an_encrypted_link_only() {
    let shard = shard().await;
    let (laptop, dir) = device("laptop");
    let (tapped, seen) = wiretap(shard.addr.clone()).await;
    let peer = join(&shard, &laptop, "laptop").await;
    let peer = KnownNode { addrs: vec![tapped], ..peer };
    let link = cluster::open_link(peer, laptop.clone(), "offline".into()).await.unwrap();

    // What llama-server sends its RPC server comes back from the stand-in, through the link.
    let marker = b"GRAPH_COMPUTE layer 17 activations ".repeat(4000);
    assert_eq!(round_trip(link.port, &marker).await.unwrap(), marker);
    let (sent, received) = link.traffic.get();
    assert_eq!((sent, received), (marker.len() as u64, marker.len() as u64));
    let served = shard.pairing.shard.as_ref().unwrap().traffic.get();
    assert_eq!(served, (marker.len() as u64, marker.len() as u64));

    // On the wire it is ciphertext: the plaintext never appears.
    let wire = seen.lock().unwrap().clone();
    assert!(wire.len() > 2 * marker.len(), "both directions crossed the tap");
    assert!(!wire.windows(24).any(|w| w == &marker[..24]), "plaintext on the wire");
    let _ = std::fs::remove_dir_all(dir);
}

#[tokio::test]
async fn only_the_heads_a_shard_names_get_a_link() {
    let shard = shard().await;
    // Paired, but not one of the shard's heads: a phone, say.
    let (phone, dir) = device("phone");
    join(&shard, &phone, "phone").await;
    let refused = remote::connect_shard(std::slice::from_ref(&shard.addr), &shard.pairing.key.public, &phone).await;
    assert!(refused.is_err(), "a paired device that is not a head gets no shard link");
    // It still has its ordinary session.
    assert!(remote::connect(std::slice::from_ref(&shard.addr), &shard.pairing.key.public, &phone).await.is_ok());

    // Never paired at all.
    let (stranger, dir2) = device("stranger");
    assert!(
        remote::connect_shard(std::slice::from_ref(&shard.addr), &shard.pairing.key.public, &stranger).await.is_err()
    );

    // A head that knows the shard by a different key (an impostor shard) cannot complete it.
    let (laptop, dir3) = device("laptop");
    join(&shard, &laptop, "laptop").await;
    let (impostor, dir4) = device("impostor");
    assert!(remote::connect_shard(std::slice::from_ref(&shard.addr), &impostor.public, &laptop).await.is_err());
    assert!(remote::connect_shard(std::slice::from_ref(&shard.addr), &shard.pairing.key.public, &laptop).await.is_ok());
    for d in [dir, dir2, dir3, dir4] {
        let _ = std::fs::remove_dir_all(d);
    }
}

#[tokio::test]
async fn unpairing_the_head_cuts_its_open_link() {
    let shard = shard().await;
    let (laptop, dir) = device("laptop");
    let peer = join(&shard, &laptop, "laptop").await;
    let link = cluster::open_link(peer, laptop, "offline".into()).await.unwrap();
    let mut tcp = TcpStream::connect(("127.0.0.1", link.port)).await.unwrap();
    tcp.write_all(b"hello").await.unwrap();
    let mut back = [0u8; 5];
    tcp.read_exact(&mut back).await.unwrap();
    assert!(shard.pairing.devices.remove("laptop").unwrap());
    // The next frame is refused and the link drops.
    let _ = tcp.write_all(b"more").await;
    let mut rest = Vec::new();
    let read = tokio::time::timeout(Duration::from_secs(5), tcp.read_to_end(&mut rest)).await;
    assert!(matches!(read, Ok(Ok(0)) | Ok(Err(_))), "the link closed: {read:?} {rest:?}");
    let _ = std::fs::remove_dir_all(dir);
}

#[tokio::test]
async fn a_link_refuses_addresses_off_the_lan() {
    let shard = shard().await;
    let (laptop, dir) = device("laptop");
    join(&shard, &laptop, "laptop").await;
    // Pinned only under a public address: the rule refuses it before any connection.
    let peer = known(&shard, vec!["203.0.113.9:7778".into()]);
    let link = cluster::open_link(peer.clone(), laptop.clone(), "direct".into()).await.unwrap();
    assert!(round_trip(link.port, b"x").await.is_err());
    assert!(link.error.lock().unwrap().as_deref().unwrap().contains("not_lan"));
    let probe = cluster::probe_peer(&peer, &laptop, "direct").await.unwrap_err();
    assert!(probe.contains("not_lan"), "{probe}");
    let _ = std::fs::remove_dir_all(dir);
}

#[tokio::test]
async fn capabilities_say_who_may_use_the_shard() {
    let shard = shard().await;
    let (laptop, dir) = device("laptop");
    let (phone, dir2) = device("phone");
    let peer = join(&shard, &laptop, "laptop").await;
    join(&shard, &phone, "phone").await;
    let caps = cluster::probe_peer(&peer, &laptop, "offline").await.unwrap();
    assert_eq!(caps.name, "mini");
    assert!(caps.shard);
    assert_eq!(caps.rpc_backend, Some(true));
    let caps = cluster::probe_peer(&peer, &phone, "offline").await.unwrap();
    assert!(!caps.shard, "the phone may not use it as a shard");
    for d in [dir, dir2] {
        let _ = std::fs::remove_dir_all(d);
    }
}

/// A head with one split model whose engine is a stand-in, and the shard as its peer.
async fn head(shard: &Shard, laptop: &StaticKey, peer: KnownNode) -> (String, Arc<ClusterRun>, Arc<AppState>) {
    let link = cluster::open_link(peer.clone(), laptop.clone(), "offline".into()).await.unwrap();
    let port = link.port;
    // The stand-in engine sends something through the link for each request, as llama-server
    // would, and answers with usage.
    let router = Router::new().route(
        "/v1/chat/completions",
        post(move |_: Bytes| async move {
            let back = round_trip(port, &[7u8; 1000]).await.unwrap();
            assert_eq!(back.len(), 1000);
            axum::Json(json!({ "choices": [], "usage": { "prompt_tokens": 3, "completion_tokens": 2 } }))
        }),
    );
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let engine_addr = listener.local_addr().unwrap();
    tokio::spawn(async move { axum::serve(listener, router).await.unwrap() });
    let run = Arc::new(ClusterRun::new("big", SplitMode::Always, "studio", vec![link]));
    let plan = invincible_policy::plan(&PlanInput {
        model_bytes: 1 << 30,
        split: SplitMode::Always,
        devices: vec![
            PlanDevice { node: "studio".into(), device: "MTL0".into(), free_mib: 3000 },
            PlanDevice { node: "mini".into(), device: "MTL0".into(), free_mib: 1000 },
        ],
    });
    run.set(RunState { plan: Some(plan), notes: vec![] });
    let engine = Engine::attached("big", &format!("http://{engine_addr}"), None, true).with_cluster(run.clone());
    let dir = temp_dir("head");
    let settings = NodeSettings { network: NetworkMode::Offline, egress: Egress::Never };
    let state = Arc::new(
        AppState::new(vec![engine], settings, "token".into())
            .with_receipt_key("studio", invincible::receipts::ReceiptKey::from_seed(&[3; 32]))
            .with_audit(invincible::audit::AuditLog::new(&dir))
            .with_cluster(ClusterState {
                name: "studio".into(),
                llama_server: "/nonexistent/llama-server".into(),
                rpc_backend: Some(true),
                peers: vec![peer],
                device_key: Some(laptop.clone()),
                runs: vec![run.clone()],
                shard: false,
            }),
    );
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let app = invincible::server::app(state.clone());
    tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    let _ = shard;
    (format!("http://{addr}"), run, state)
}

#[tokio::test]
async fn the_router_sends_requests_to_the_split_model_and_the_receipt_names_the_nodes() {
    let shard = shard().await;
    let (laptop, dir) = device("laptop");
    let peer = join(&shard, &laptop, "laptop").await;
    let (url, _run, state) = head(&shard, &laptop, peer.clone()).await;
    let client = reqwest::Client::new();
    let response = client
        .post(format!("{url}/v1/chat/completions"))
        .bearer_auth("token")
        .header("invincible-private", "1")
        .json(&json!({ "messages": [{ "role": "user", "content": "hi" }] }))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), 200);
    // A split model is still the node's own hardware: a private request runs on it.
    assert_eq!(
        response.headers()[invincible::server::DECISION_HEADER],
        r#"{"action":"run","model":"big","tier":"node","reason":"local-first"}"#
    );
    let id = response.headers()[invincible::receipts::REQUEST_ID_HEADER].to_str().unwrap().to_owned();
    let _ = response.bytes().await.unwrap();
    let envelope: Value =
        client.get(format!("{url}/v1/receipts/{id}")).bearer_auth("token").send().await.unwrap().json().await.unwrap();
    let receipt = &envelope["receipt"];
    assert!(invincible::receipts::verify(
        &state.receipt_key.public(),
        receipt,
        envelope["signature"].as_str().unwrap()
    ));
    assert_eq!(
        receipt["cluster"],
        json!([
            { "name": "studio", "share": 750 },
            { "name": "mini", "share": 250, "key": peer.key, "bytes_sent": 1000, "bytes_received": 1000 },
        ])
    );
    assert_eq!(receipt["egress"], json!([]), "a paired shard is not egress");

    // /v1/models says which peers a model is split across.
    let models: Value =
        client.get(format!("{url}/v1/models")).bearer_auth("token").send().await.unwrap().json().await.unwrap();
    assert_eq!(models["data"][0]["invincible"]["cluster"], json!(["mini"]));

    // The status: the peer is up and a shard for us, the model split as planned, bytes counted.
    let status: Value =
        client.get(format!("{url}/v1/cluster")).bearer_auth("token").send().await.unwrap().json().await.unwrap();
    assert_eq!(status["node"]["name"], "studio");
    assert_eq!(status["peers"][0]["name"], "mini");
    assert_eq!(status["peers"][0]["reachable"], true);
    assert_eq!(status["peers"][0]["capabilities"]["shard"], true);
    assert_eq!(status["models"][0]["id"], "big");
    assert_eq!(status["models"][0]["state"]["plan"]["action"], "split");
    assert_eq!(status["models"][0]["links"][0]["bytes_sent"], 1000);
    // Behind the token, like the other admin endpoints.
    assert_eq!(client.get(format!("{url}/v1/cluster")).send().await.unwrap().status(), 401);
    let _ = std::fs::remove_dir_all(dir);
}

#[tokio::test]
async fn a_down_peer_shows_in_the_status() {
    let shard = shard().await;
    let (laptop, dir) = device("laptop");
    let peer = join(&shard, &laptop, "laptop").await;
    // Pinned at an address where nothing listens any more.
    let gone = TcpListener::bind("127.0.0.1:0").await.unwrap().local_addr().unwrap().to_string();
    let (url, _, _) = head(&shard, &laptop, KnownNode { addrs: vec![gone], ..peer }).await;
    let status: Value = reqwest::Client::new()
        .get(format!("{url}/v1/cluster"))
        .bearer_auth("token")
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(status["peers"][0]["reachable"], false);
    assert!(status["peers"][0]["error"].as_str().is_some());
    let _ = std::fs::remove_dir_all(dir);
}
