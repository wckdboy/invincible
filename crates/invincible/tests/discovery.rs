//! Discovery end to end (spec/discovery.md): the two seed endpoints against an in-process server,
//! the limits a seed enforces, the operator route that shows what a node holds, and the invariant
//! that a discovered descriptor grants nothing. Real mDNS multicast is not exercised here; the
//! TXT payload it carries is unit-tested in `discovery::tests`.

use std::sync::Arc;

use axum::Router;
use invincible::devices::{Devices, KnownNodes, StaticKey};
use invincible::discovery::{self, Descriptor, Seed, Store};
use invincible::receipts::ReceiptKey;
use invincible::server::{AppState, app, device_app};
use invincible_policy::{Egress, NetworkMode, NodeSettings};
use serde_json::{Value, json};
use tokio::net::TcpListener;

const TOKEN: &str = "test-token";

fn temp_dir(tag: &str) -> std::path::PathBuf {
    let n: u64 = u64::from_le_bytes(invincible::token::random::<8>().unwrap());
    std::env::temp_dir().join(format!("invincible-discovery-{tag}-{n:x}"))
}

/// Serves [router] on loopback with connect info, which the seed's per-address limit reads.
async fn serve(router: Router) -> String {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move {
        axum::serve(listener, router.into_make_service_with_connect_info::<std::net::SocketAddr>()).await.unwrap()
    });
    format!("http://{addr}")
}

/// A valid descriptor for a node whose keys are all [byte], issued now.
fn descriptor(byte: u8) -> Descriptor {
    let at = discovery::now().unwrap();
    let mut descriptor = Descriptor {
        v: discovery::VERSION,
        node: base64(&[byte; 32]),
        fingerprint: invincible::devices::fingerprint(&[byte; 32]),
        sign_key: String::new(),
        addresses: vec!["127.0.0.1:7778".to_owned()],
        models: vec!["qwen3-4b".to_owned()],
        dispatch: discovery::Dispatch { max_inflight: 1 },
        issued: at,
        expires: at + discovery::LIFETIME,
        sig: None,
    };
    descriptor.sign(&ReceiptKey::from_seed(&[byte; 32])).unwrap();
    descriptor
}

fn base64(bytes: &[u8]) -> String {
    use base64::Engine as _;
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(bytes)
}

fn unbase64(text: &str) -> Vec<u8> {
    use base64::Engine as _;
    base64::engine::general_purpose::URL_SAFE_NO_PAD.decode(text).unwrap()
}

fn status(response: &reqwest::Response) -> u16 {
    response.status().as_u16()
}

#[tokio::test]
async fn the_seed_takes_a_signed_record_and_hands_it_back() {
    let url = serve(discovery::seed_app(Arc::new(Seed::new(10)))).await;
    let client = reqwest::Client::new();
    let first = descriptor(1);
    discovery::announce_to_seed(&client, &url, &first).await.unwrap();

    let peers = discovery::fetch_peers(&client, &url, None).await.unwrap();
    assert_eq!(peers, vec![first.clone()]);
    let one = discovery::fetch_peers(&client, &url, Some(&first.fingerprint)).await.unwrap();
    assert_eq!(one, vec![first.clone()]);
    let none = discovery::fetch_peers(&client, &url, Some("0000-0000-0000-0000")).await.unwrap();
    assert!(none.is_empty());

    // The seed stores what it was given: it does not verify signatures, and that is the point.
    // A record with a bogus signature is accepted here and refused by the consumer.
    let mut forged = descriptor(2);
    forged.sig = Some(base64(&[0u8; 64]));
    discovery::announce_to_seed(&client, &url, &forged).await.unwrap();
    let served = discovery::fetch_peers(&client, &url, None).await.unwrap();
    assert_eq!(served.len(), 2);
    assert!(served.iter().any(|record| record == &forged));
    let error = served.iter().find(|record| *record == &forged).unwrap().verify(discovery::now().unwrap()).unwrap_err();
    assert_eq!(error.field, "signature", "{error}");
}

#[tokio::test]
async fn the_seed_refuses_a_body_over_its_limit_and_a_body_that_is_not_a_descriptor() {
    let url = serve(discovery::seed_app(Arc::new(Seed::new(10)))).await;
    let client = reqwest::Client::new();
    let big = client
        .post(format!("{url}/v1/discovery/announce"))
        .body(vec![b'x'; discovery::MAX_DESCRIPTOR_BYTES + 1])
        .send()
        .await
        .unwrap();
    assert_eq!(status(&big), 413);

    let junk = client.post(format!("{url}/v1/discovery/announce")).json(&json!({ "v": 1 })).send().await.unwrap();
    assert_eq!(status(&junk), 400);
    let body: Value = junk.json().await.unwrap();
    assert_eq!(body["error"]["code"], "invalid_descriptor");

    let unsigned = client
        .post(format!("{url}/v1/discovery/announce"))
        .json(&json!({
            "v": 1, "node": base64(&[3u8; 32]), "fingerprint": "x", "sign_key": base64(&[3u8; 32]),
            "addresses": ["127.0.0.1:7778"], "models": [], "dispatch": { "max_inflight": 1 },
            "issued": 1, "expires": discovery::now().unwrap() + 60,
        }))
        .send()
        .await
        .unwrap();
    assert_eq!(status(&unsigned), 400);
    let body: Value = unsigned.json().await.unwrap();
    assert!(body["error"]["message"].as_str().unwrap().contains("signature"));
}

#[tokio::test]
async fn the_seed_caps_records_and_rate_limits_one_address() {
    let url = serve(discovery::seed_app(Arc::new(Seed::with_rate(2, 1000)))).await;
    let client = reqwest::Client::new();
    for byte in 1..=2 {
        let response =
            client.post(format!("{url}/v1/discovery/announce")).json(&descriptor(byte)).send().await.unwrap();
        assert_eq!(status(&response), 200);
    }
    let full = client.post(format!("{url}/v1/discovery/announce")).json(&descriptor(3)).send().await.unwrap();
    assert_eq!(status(&full), 503, "a full seed refuses rather than evicting");
    let body: Value = full.json().await.unwrap();
    assert_eq!(body["error"]["code"], "seed_full");
    assert_eq!(discovery::fetch_peers(&client, &url, None).await.unwrap().len(), 2);

    let limited = serve(discovery::seed_app(Arc::new(Seed::with_rate(100, 3)))).await;
    let mut statuses = Vec::new();
    for byte in 1..=4 {
        let response =
            client.post(format!("{limited}/v1/discovery/announce")).json(&descriptor(byte)).send().await.unwrap();
        statuses.push(status(&response));
    }
    assert_eq!(statuses, vec![200, 200, 200, 429]);
}

#[tokio::test]
async fn the_seed_replaces_a_nodes_record_rather_than_growing() {
    let url = serve(discovery::seed_app(Arc::new(Seed::new(10)))).await;
    let client = reqwest::Client::new();
    let first = descriptor(1);
    let mut second = first.clone();
    second.expires += 10;
    second.models.push("llama-3-8b".to_owned());
    second.sign(&ReceiptKey::from_seed(&[1u8; 32])).unwrap();
    discovery::announce_to_seed(&client, &url, &first).await.unwrap();
    discovery::announce_to_seed(&client, &url, &second).await.unwrap();
    let peers = discovery::fetch_peers(&client, &url, None).await.unwrap();
    assert_eq!(peers, vec![second]);
}

#[tokio::test]
async fn the_operator_api_shows_what_the_node_holds_and_a_device_cannot_read_it() {
    let home = temp_dir("api");
    let store = Store::load(&discovery::Store::path(&home)).unwrap();
    let held = descriptor(4);
    store.insert(&held).unwrap();
    let own = descriptor(5);
    let state = Arc::new(
        AppState::new(vec![], NodeSettings { network: NetworkMode::Offline, egress: Egress::Never }, TOKEN.to_owned())
            .with_discovery(discovery::Discovery {
                own: Some(own.clone()),
                store,
                seeds: vec!["https://seed.example".to_owned()],
            }),
    );
    let url = serve(app(state.clone())).await;
    let client = reqwest::Client::new();

    assert_eq!(status(&client.get(format!("{url}/v1/discovery")).send().await.unwrap()), 401);
    let body: Value =
        client.get(format!("{url}/v1/discovery")).bearer_auth(TOKEN).send().await.unwrap().json().await.unwrap();
    assert_eq!(body["announce"], true);
    assert_eq!(body["descriptor"]["fingerprint"], own.fingerprint);
    assert_eq!(body["held"].as_array().unwrap().len(), 1);
    assert_eq!(body["held"][0]["fingerprint"], held.fingerprint);
    assert_eq!(body["seeds"], json!(["https://seed.example"]));

    // The device allowlist is unchanged: discovery is not a route a paired peer gets.
    let devices = serve(device_app(state)).await;
    assert_eq!(status(&client.get(format!("{devices}/v1/discovery")).send().await.unwrap()), 404);
    std::fs::remove_dir_all(home).unwrap();
}

#[tokio::test]
async fn a_discovered_descriptor_does_not_pair_anything() {
    let home = temp_dir("trust");
    let store = Store::load(&discovery::Store::path(&home)).unwrap();
    let found = descriptor(6);
    store.insert(&found).unwrap();

    // Nothing in discovery writes devices.json or nodes.json, so this node still trusts no one.
    let devices = Devices::load(&home.join("devices.json")).unwrap();
    let known = KnownNodes::load(&home).unwrap();
    assert!(devices.list().is_empty());
    assert!(known.0.is_empty());
    assert_eq!(found.trust(&devices, &known), "unpaired");

    // Storing it did create the record file, mode 0600 like every other state file.
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mode = std::fs::metadata(discovery::Store::path(&home)).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o600);
    }
    // And the only key material that could authorise it is a pin in devices.json, which is absent.
    let key = unbase64(&found.node);
    assert!(!devices.is_pinned(&key));
    std::fs::remove_dir_all(home).unwrap();
}

#[test]
fn a_descriptor_names_no_path_counts_or_peers() {
    // The whole record is what a node would tell a stranger: identity, where, which model ids,
    // capacity, and when it expires. Guard the shape so a field cannot creep in unnoticed.
    let value = serde_json::to_value(descriptor(7)).unwrap();
    let mut keys: Vec<&str> = value.as_object().unwrap().keys().map(String::as_str).collect();
    keys.sort_unstable();
    assert_eq!(
        keys,
        vec!["addresses", "dispatch", "expires", "fingerprint", "issued", "models", "node", "sig", "sign_key", "v"]
    );
    let text = value.to_string();
    for forbidden in ["/models/", "path", "usage", "peers", "prompt", "token"] {
        assert!(!text.contains(forbidden), "descriptor mentions {forbidden}: {text}");
    }
    // A private key is never in it: the record only ever carries public, 32-byte values.
    let key = StaticKey { private: vec![200u8; 32], public: vec![7u8; 32] };
    assert!(!text.contains(&base64(&key.private)), "a private key leaked into the descriptor");
    assert!(text.contains(&base64(&key.public)), "the public identity is what a descriptor names");
}
