//! Renting a GPU with the in-process engine (spec/rent.md).
//!
//! RunPod and the object store are mock HTTP servers. The node reads their keys from mode-0600
//! files and never puts those keys in a response, a log, or the audit trail.

use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use axum::extract::{Path as UrlPath, Query, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::IntoResponse;
use axum::routing::get;
use axum::{Json, Router};
use invincible::devices::StaticKey;
use invincible::remote::{self, PairingCode};
use serde_json::{Value, json};
use tokio::net::TcpListener;

const TOKEN: &str = "node-token";
const DOOR_TOKEN: &str = "door-token";
const RUNPOD_KEY: &str = "rp-test-key-0123456789";
const R2_ACCESS: &str = "r2-access-key-012345";
const R2_SECRET: &str = "r2-secret-key-0123456789abcdef";

#[derive(Clone)]
struct Mocks {
    key: String,
    log: Arc<Mutex<Vec<String>>>,
    slow: bool,
    hostile: bool,
    raise: bool,
    fail_create: bool,
    hold_create: bool,
    release_create: Arc<tokio::sync::Notify>,
    hold_hydrate: bool,
    release_hydrate: Arc<tokio::sync::Notify>,
    delete_failures: Arc<Mutex<u32>>,
    catalogs: Arc<Mutex<u32>>,
    pods: Arc<Mutex<Vec<String>>>,
    named: Arc<Mutex<Vec<Value>>>,
    seq: Arc<Mutex<u64>>,
    objects: Arc<Mutex<std::collections::HashMap<String, Vec<u8>>>>,
}

struct Node {
    child: Child,
    dir: PathBuf,
}

impl Node {
    fn stop(&mut self) -> bool {
        if matches!(self.child.try_wait(), Ok(None)) {
            let _ = Command::new("kill").args(["-TERM", &self.child.id().to_string()]).status();
        }
        let deadline = Instant::now() + Duration::from_secs(15);
        while Instant::now() < deadline {
            if matches!(self.child.try_wait(), Ok(Some(_))) {
                return true;
            }
            std::thread::sleep(Duration::from_millis(50));
        }
        false
    }
}

impl Drop for Node {
    fn drop(&mut self) {
        if !self.stop() {
            let _ = self.child.kill();
            let _ = self.child.wait();
        }
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

fn secret(path: &Path, text: &str) {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).unwrap();
    }
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create(true).truncate(true);
    #[cfg(unix)]
    std::os::unix::fs::OpenOptionsExt::mode(&mut options, 0o600);
    use std::io::Write;
    let mut file = options.open(path).unwrap();
    writeln!(file, "{text}").unwrap();
}

fn spawn(dir: &Path) -> Child {
    let log = std::fs::OpenOptions::new().create(true).append(true).open(dir.join("serve.log")).unwrap();
    Command::new(env!("CARGO_BIN_EXE_invincible"))
        .arg("serve")
        .current_dir(dir)
        .env("INVINCIBLE_HOME", dir)
        .env("HOME", dir)
        .env_remove("RUST_LOG")
        .stdin(Stdio::null())
        .stdout(log.try_clone().unwrap())
        .stderr(log)
        .spawn()
        .unwrap()
}

struct Stack {
    dir: PathBuf,
    url: String,
    remote: String,
    mocks: Mocks,
}

async fn stack(tag: &str, monthly: &str, slow: bool, hostile: bool, raise: bool) -> (Stack, Node) {
    let mocks = Mocks {
        key: RUNPOD_KEY.to_owned(),
        log: Arc::new(Mutex::new(Vec::new())),
        slow,
        hostile,
        raise,
        fail_create: tag == "create-fail" || tag == "hold-fail",
        hold_create: tag == "hold-create" || tag == "delete-once" || tag == "hold-fail",
        release_create: Arc::new(tokio::sync::Notify::new()),
        hold_hydrate: tag == "hold-hydrate",
        release_hydrate: Arc::new(tokio::sync::Notify::new()),
        delete_failures: Arc::new(Mutex::new(u32::from(tag == "delete-once"))),
        catalogs: Arc::new(Mutex::new(0)),
        pods: Arc::new(Mutex::new(Vec::new())),
        named: Arc::new(Mutex::new(Vec::new())),
        seq: Arc::new(Mutex::new(0)),
        objects: Arc::new(Mutex::new(std::collections::HashMap::new())),
    };
    let runpod = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let s3 = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let runpod_port = runpod.local_addr().unwrap().port();
    let s3_port = s3.local_addr().unwrap().port();
    let runpod_app = Router::new()
        .route("/v2/catalog/gpus", get(catalog))
        .route("/v2/pods", get(list_pods).post(create_pod))
        .route("/v2/pods/{id}", get(pod_status).delete(delete_pod))
        .route("/__log", get(show_log))
        .with_state(mocks.clone());
    let s3_app = Router::new()
        .route("/{bucket}", get(list_bucket))
        .route("/{bucket}/{*key}", get(get_object).put(put_object).head(head_object))
        .with_state(mocks.clone());
    tokio::spawn(async move { axum::serve(runpod, runpod_app).await.unwrap() });
    tokio::spawn(async move { axum::serve(s3, s3_app).await.unwrap() });

    let dir = std::env::temp_dir().join(format!("invincible-rent-{tag}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    secret(&dir.join("secrets/runpod.key"), RUNPOD_KEY);
    secret(&dir.join("secrets/r2.access"), R2_ACCESS);
    secret(&dir.join("secrets/r2.secret"), R2_SECRET);
    std::fs::write(dir.join("token"), format!("{TOKEN}\n")).unwrap();
    let api = std::net::TcpListener::bind("127.0.0.1:0").unwrap().local_addr().unwrap().port();
    let remote = std::net::TcpListener::bind("127.0.0.1:0").unwrap().local_addr().unwrap().port();
    let config = format!(
        "listen = \"127.0.0.1:{api}\"\n\
         [remote]\n\
         name = \"studio\"\n\
         listen = [\"127.0.0.1:{remote}\"]\n\
         [rent]\n\
         enabled = true\n\
         binary = \"wckd\"\n\
         max_usd_per_hour = 1.0\n\
         max_hours = 2\n\
         {monthly}\
         idle_minutes = 15\n\
         insecure_endpoint = true\n\
         runpod_key_file = \"secrets/runpod.key\"\n\
         runpod_url = \"http://127.0.0.1:{runpod_port}\"\n\
         [rent.store]\n\
         endpoint = \"http://127.0.0.1:{s3_port}\"\n\
         bucket = \"rent\"\n\
         region = \"auto\"\n\
         access_key_file = \"secrets/r2.access\"\n\
         secret_key_file = \"secrets/r2.secret\"\n"
    );
    std::fs::write(dir.join("config.toml"), config).unwrap();
    if tag == "rerank" {
        std::fs::create_dir_all(dir.join("rent/presets")).unwrap();
        std::fs::write(
            dir.join("rent/presets/rerank.yaml"),
            "apiVersion: wckd.gpu/v1\nkind: Preset\nmetadata:\n  id: rerank\n  name: rerank\nspec:\n  workload_class: generic\n  constraints:\n    min_vram_gb: 24\n    gpu_families: [\"4090\"]\n    reliability: any\n  runtime:\n    image: test/rerank\n    ports: []\n",
        )
        .unwrap();
    }
    let node = Node { child: spawn(&dir), dir: dir.clone() };
    let url = format!("http://127.0.0.1:{api}");
    (Stack { dir, url, remote: format!("127.0.0.1:{remote}"), mocks }, node)
}

fn log_of(mocks: &Mocks) -> Vec<String> {
    mocks.log.lock().unwrap().clone()
}

fn count(log: &[String], event: &str) -> usize {
    log.iter().filter(|line| line.as_str() == event).count()
}

async fn ready(url: &str, dir: &Path) -> Value {
    let client = reqwest::Client::new();
    let deadline = Instant::now() + Duration::from_secs(20);
    loop {
        if let Ok(response) = client.get(format!("{url}/v1/rent/health")).bearer_auth(TOKEN).send().await
            && response.status() == 200
        {
            let body: Value = response.json().await.unwrap();
            if body["ok"] == true && body["in_process"] == true && body["engine"] == "invincible" {
                return body;
            }
        }
        assert!(
            Instant::now() < deadline,
            "rent never became healthy\n{}",
            std::fs::read_to_string(dir.join("serve.log")).unwrap_or_default()
        );
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
}

async fn call(url: &str, method: reqwest::Method, path: &str, body: Option<Value>, confirm: bool) -> (u16, Value) {
    let client = reqwest::Client::new();
    let mut request = client.request(method, format!("{url}{path}")).bearer_auth(TOKEN);
    if confirm {
        request = request.header("invincible-confirmed", "1");
    }
    if let Some(body) = body {
        request = request.json(&body);
    }
    let response = request.send().await.unwrap();
    let status = response.status().as_u16();
    let text = response.text().await.unwrap();
    (status, serde_json::from_str(&text).unwrap_or(json!({"raw": text})))
}

fn create_body(preset: &str, hours: f64, confirm_field: bool) -> Value {
    let mut body = json!({"project_id": "hailuo-tests", "preset_id": preset, "hours": hours});
    if confirm_field {
        body["confirm"] = json!(true);
    }
    body
}

fn assert_clean(dir: &Path, needles: &[&str]) {
    fn walk(dir: &Path, out: &mut Vec<PathBuf>) {
        for entry in std::fs::read_dir(dir).unwrap() {
            let path = entry.unwrap().path();
            if path.is_dir() {
                walk(&path, out);
            } else {
                out.push(path);
            }
        }
    }
    let mut files = Vec::new();
    walk(dir, &mut files);
    for path in files {
        if path.components().any(|c| c.as_os_str() == "secrets") {
            continue;
        }
        let text = std::fs::read_to_string(&path).unwrap_or_default();
        for needle in needles {
            assert!(!text.contains(needle), "{needle} leaked in {}", path.display());
        }
    }
}

fn bearer_ok(headers: &HeaderMap, key: &str) -> bool {
    headers.get("authorization").and_then(|value| value.to_str().ok()) == Some(format!("Bearer {key}")).as_deref()
}

async fn catalog(
    State(mocks): State<Mocks>,
    headers: HeaderMap,
    Query(query): Query<std::collections::HashMap<String, String>>,
) -> axum::response::Response {
    if !bearer_ok(&headers, &mocks.key) {
        return (StatusCode::UNAUTHORIZED, Json(json!({"error": "unauthorized"}))).into_response();
    }
    let cloud = query.get("cloud").map(String::as_str).unwrap_or("").to_owned();
    mocks.log.lock().unwrap().push(format!("runpod:catalog:{cloud}"));
    let n = {
        let mut catalogs = mocks.catalogs.lock().unwrap();
        *catalogs += 1;
        *catalogs
    };
    if mocks.hostile {
        return (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({"error": mocks.key}))).into_response();
    }
    Json(json!({"gpus": [
        {
            "id": "NVIDIA GeForce RTX 4090",
            "name": "RTX 4090",
            "memory": 24,
            "secure": true,
            "community": true,
            "availability": "HIGH",
            "price": {"community": 0.34, "secure": if mocks.raise && n > 1 { 0.90 } else { 0.50 }},
            "dataCenters": [
                {"id": "EU-RO-1", "name": "EU Romania", "availability": "HIGH"},
                {"id": "US-OR-1", "name": "US Oregon", "availability": "HIGH"}
            ]
        },
        {
            "id": "NVIDIA RTX A6000",
            "name": "RTX A6000",
            "memory": 48,
            "secure": true,
            "community": true,
            "availability": "HIGH",
            "price": {"community": 4.0, "secure": 4.0},
            "dataCenters": [{"id": "EU-RO-1", "name": "EU Romania", "availability": "HIGH"}]
        }
    ]}))
    .into_response()
}

async fn create_pod(
    State(mocks): State<Mocks>,
    headers: HeaderMap,
    Json(body): Json<Value>,
) -> axum::response::Response {
    if !bearer_ok(&headers, &mocks.key) {
        return (StatusCode::UNAUTHORIZED, Json(json!({"error": "unauthorized"}))).into_response();
    }
    if mocks.slow {
        tokio::time::sleep(Duration::from_secs(3)).await;
    }
    let id = {
        let mut seq = mocks.seq.lock().unwrap();
        *seq += 1;
        format!("pod-{}", *seq)
    };
    if mocks.hold_create {
        mocks.log.lock().unwrap().push("runpod:create-waiting".into());
        mocks.release_create.notified().await;
    }
    mocks.log.lock().unwrap().push("runpod:create".into());
    if mocks.fail_create {
        return (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({"error": "unavailable"}))).into_response();
    }
    mocks.pods.lock().unwrap().push(id.clone());
    mocks.named.lock().unwrap().push(json!({"id": id, "name": body["name"].as_str().unwrap_or("")}));
    let image = body["image"].as_str().unwrap_or("");
    let cloud = body["cloud"].as_str().unwrap_or("");
    mocks.log.lock().unwrap().push(format!("runpod:cloud:{cloud}"));
    let center =
        body["dataCenterIds"].as_array().and_then(|ids| ids.first()).and_then(Value::as_str).unwrap_or("US-OR-1");
    let cost = if image == "test/rerank" { 5.0 } else { 0.50 };
    let _ = body.get("env");
    Json(json!({"id": id, "status": "RUNNING", "cost": cost, "dataCenterId": center})).into_response()
}

async fn pod_status(
    State(mocks): State<Mocks>,
    headers: HeaderMap,
    UrlPath(id): UrlPath<String>,
) -> axum::response::Response {
    if !bearer_ok(&headers, &mocks.key) {
        return (StatusCode::UNAUTHORIZED, Json(json!({"error": "unauthorized"}))).into_response();
    }
    if !mocks.pods.lock().unwrap().iter().any(|pod| pod == &id) {
        return (StatusCode::NOT_FOUND, Json(json!({"error": "missing"}))).into_response();
    }
    Json(json!({"id": id, "status": "RUNNING", "cost": 0.50, "dataCenterId": "EU-RO-1"})).into_response()
}

async fn list_pods(State(mocks): State<Mocks>, headers: HeaderMap) -> axum::response::Response {
    if !bearer_ok(&headers, &mocks.key) {
        return (StatusCode::UNAUTHORIZED, Json(json!({"error": "unauthorized"}))).into_response();
    }
    let pods = mocks.named.lock().unwrap().clone();
    Json(json!({"pods": pods, "pagination": {"nextCursor": null, "hasNextPage": false}})).into_response()
}

async fn delete_pod(State(mocks): State<Mocks>, headers: HeaderMap, UrlPath(id): UrlPath<String>) -> StatusCode {
    if !bearer_ok(&headers, &mocks.key) {
        return StatusCode::UNAUTHORIZED;
    }
    {
        let mut left = mocks.delete_failures.lock().unwrap();
        if *left > 0 {
            *left -= 1;
            mocks.log.lock().unwrap().push(format!("runpod:delete-fail:{id}"));
            return StatusCode::CONFLICT;
        }
    }
    mocks.log.lock().unwrap().push(format!("runpod:delete:{id}"));
    mocks.pods.lock().unwrap().retain(|pod| pod != &id);
    mocks.named.lock().unwrap().retain(|pod| pod["id"].as_str() != Some(id.as_str()));
    StatusCode::NO_CONTENT
}

async fn show_log(State(mocks): State<Mocks>) -> Json<Vec<String>> {
    Json(log_of(&mocks))
}

async fn list_bucket(State(mocks): State<Mocks>, headers: HeaderMap) -> String {
    assert_sigv4(&headers);
    let objects = mocks.objects.lock().unwrap();
    let mut xml = String::from("<ListBucketResult>");
    for key in objects.keys() {
        xml.push_str(&format!("<Contents><Key>{key}</Key></Contents>"));
    }
    xml.push_str("</ListBucketResult>");
    xml
}

async fn put_object(
    State(mocks): State<Mocks>,
    headers: HeaderMap,
    UrlPath((_, key)): UrlPath<(String, String)>,
    body: axum::body::Bytes,
) -> StatusCode {
    assert_sigv4(&headers);
    let hold_hydrate = {
        let mut objects = mocks.objects.lock().unwrap();
        objects.insert(key.clone(), body.to_vec());
        if key.ends_with("/control.json") {
            mocks.log.lock().unwrap().push("s3:control".into());
            let marker = key.trim_end_matches("control.json").to_owned() + "drain-ok.json";
            objects.insert(marker, br#"{"ok":true}"#.to_vec());
        }
        let hydrate = key.ends_with("/hydrate.json");
        if hydrate {
            mocks.log.lock().unwrap().push("s3:hydrate".into());
        }
        if hydrate && !mocks.hold_hydrate {
            let marker = key.trim_end_matches("hydrate.json").to_owned() + "hydrate-ok.json";
            objects.insert(marker, br#"{"ok":true}"#.to_vec());
        }
        hydrate && mocks.hold_hydrate
    };
    if hold_hydrate {
        mocks.release_hydrate.notified().await;
        let marker = key.trim_end_matches("hydrate.json").to_owned() + "hydrate-ok.json";
        mocks.objects.lock().unwrap().insert(marker, br#"{"ok":true}"#.to_vec());
    }
    StatusCode::OK
}

async fn head_object(
    State(mocks): State<Mocks>,
    headers: HeaderMap,
    UrlPath((_, key)): UrlPath<(String, String)>,
) -> StatusCode {
    assert_sigv4(&headers);
    if key.ends_with("/drain-ok.json") {
        mocks.log.lock().unwrap().push("s3:drain-ok".into());
    }
    if mocks.objects.lock().unwrap().contains_key(&key) { StatusCode::OK } else { StatusCode::NOT_FOUND }
}

async fn get_object(
    State(mocks): State<Mocks>,
    headers: HeaderMap,
    UrlPath((_, key)): UrlPath<(String, String)>,
) -> axum::response::Response {
    assert_sigv4(&headers);
    match mocks.objects.lock().unwrap().get(&key).cloned() {
        Some(body) => (StatusCode::OK, body).into_response(),
        None => StatusCode::NOT_FOUND.into_response(),
    }
}

fn assert_sigv4(headers: &HeaderMap) {
    let auth = headers.get("authorization").and_then(|value| value.to_str().ok()).unwrap_or("");
    assert!(auth.starts_with("AWS4-HMAC-SHA256 "), "{auth}");
    assert!(!auth.contains(R2_SECRET), "the signature header must not carry the secret");
}

fn order_drains_before_delete(log: &[String]) {
    let control = log.iter().position(|line| line == "s3:control").expect("drain was requested");
    let marker = log.iter().position(|line| line == "s3:drain-ok").expect("drain marker was checked");
    let delete = log.iter().position(|line| line.starts_with("runpod:delete:")).expect("pod was deleted");
    assert!(control < marker && marker < delete, "drain then delete, got {log:?}");
}

#[test]
fn doctor_fails_when_rent_is_enabled_without_a_provider_key() {
    let dir = std::env::temp_dir().join(format!("invincible-rent-doctor-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(dir.join("config.toml"), "[rent]\nenabled = true\nbinary = \"/nonexistent/wckd\"\n").unwrap();
    let report = invincible::doctor::run(&dir, None);
    let rent = report.checks.iter().find(|check| check.name == "rent").expect("a rent check");
    assert_eq!(rent.state, invincible::doctor::State::Fail, "{}", rent.detail);
    assert!(
        rent.detail.contains("endpoint") || rent.detail.contains("store") || rent.detail.contains("key"),
        "{}",
        rent.detail
    );
    assert!(!rent.detail.contains("not on PATH"), "{}", rent.detail);
    let _ = std::fs::remove_dir_all(&dir);
}

#[tokio::test]
async fn the_node_rents_in_process_and_keeps_the_caps() {
    let (stack, mut node) = stack("proxy", "monthly_cap_usd = 0.75\n", false, false, false).await;
    let health = ready(&stack.url, &stack.dir).await;
    assert_eq!(health["limits"]["require_regions"], json!(["EU-secure"]));
    assert_eq!(health["limits"]["max_hours"], 2.0);
    assert_eq!(health["engine"], "invincible");
    assert!(health.get("supervised").is_none());

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mode = std::fs::metadata(stack.dir.join("secrets/runpod.key")).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o600);
    }

    let client = reqwest::Client::new();
    let pairing = client.post(format!("{}/v1/admin/pairing", stack.url)).bearer_auth(TOKEN).send().await.unwrap();
    let pairing_status = pairing.status();
    let pairing: Value = pairing.json().await.unwrap();
    assert_eq!(pairing_status, 200, "{pairing}");
    let code = PairingCode::decode(pairing["code"].as_str().unwrap()).unwrap();
    let device = StaticKey::load_or_create(&stack.dir.join("phone.key")).unwrap();
    remote::pair(&code, &device, "phone").await.unwrap();
    let door_listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let door_addr = door_listener.local_addr().unwrap();
    tokio::spawn(remote::tunnel(
        door_listener,
        vec![stack.remote.clone()],
        code.node_key.to_vec(),
        device,
        DOOR_TOKEN.into(),
    ));
    let door = format!("http://{door_addr}");
    let denied = reqwest::Client::new()
        .get(format!("{door}/v1/rent/offers?preset=comfyui-minimax-h3&hours=1"))
        .bearer_auth(DOOR_TOKEN)
        .send()
        .await
        .unwrap();
    assert_eq!(denied.status(), 403);
    let denied: Value = denied.json().await.unwrap();
    assert_eq!(denied["error"]["code"], "forbidden");
    let grant = client
        .patch(format!("{}/v1/admin/devices/phone", stack.url))
        .bearer_auth(TOKEN)
        .json(&json!({"capabilities": ["rent"]}))
        .send()
        .await
        .unwrap();
    assert_eq!(grant.status(), 200, "{}", grant.text().await.unwrap_or_default());
    let allowed =
        reqwest::Client::new().get(format!("{door}/v1/rent/health")).bearer_auth(DOOR_TOKEN).send().await.unwrap();
    assert_eq!(allowed.status(), 200, "{}", allowed.text().await.unwrap_or_default());

    let (status, offers) =
        call(&stack.url, reqwest::Method::GET, "/v1/rent/offers?preset=comfyui-minimax-h3&hours=1", None, false).await;
    assert_eq!(status, 200, "{offers}");
    assert_eq!(offers["require_regions"], json!(["EU-secure"]));
    assert_eq!(offers["offers"][0]["usd_per_hr"], 0.5);
    assert_eq!(offers["offers"][0]["cloud"], "secure");
    assert_eq!(offers["offers"][0]["id"], "runpod:secure:NVIDIA GeForce RTX 4090");
    assert!(log_of(&stack.mocks).iter().any(|line| line == "runpod:catalog:SECURE"), "{:?}", log_of(&stack.mocks));
    assert!(!log_of(&stack.mocks).iter().any(|line| line.contains("COMMUNITY")), "{:?}", log_of(&stack.mocks));
    assert!(
        offers["offers"][0]["data_center_ids"]
            .as_array()
            .unwrap()
            .iter()
            .all(|id| id.as_str().unwrap().starts_with("EU"))
    );
    assert!(!offers.to_string().contains(RUNPOD_KEY));

    let cli = Command::new(env!("CARGO_BIN_EXE_invincible"))
        .args(["rent", "offers", "--preset", "comfyui-minimax-h3", "--hours", "1"])
        .env("INVINCIBLE_HOME", &stack.dir)
        .env("HOME", &stack.dir)
        .output()
        .unwrap();
    let cli_out = String::from_utf8_lossy(&cli.stdout);
    assert!(cli.status.success(), "stderr: {}", String::from_utf8_lossy(&cli.stderr));
    assert!(cli_out.contains("0.5"), "{cli_out}");

    let catalogs = log_of(&stack.mocks).iter().filter(|line| line.starts_with("runpod:catalog")).count();
    let (status, body) = call(
        &stack.url,
        reqwest::Method::POST,
        "/v1/rent/sessions",
        Some(create_body("comfyui-minimax-h3", 3.0, false)),
        true,
    )
    .await;
    assert_eq!(status, 403, "{body}");
    assert_eq!(body["error"]["limit"], "max_hours");
    assert_eq!(
        log_of(&stack.mocks).iter().filter(|line| line.starts_with("runpod:catalog")).count(),
        catalogs,
        "over max_hours does not ask the vendor"
    );
    assert_eq!(count(&log_of(&stack.mocks), "runpod:create"), 0);

    let (status, body) = call(
        &stack.url,
        reqwest::Method::POST,
        "/v1/rent/sessions",
        Some(create_body("comfyui-minimax-h3", 1.0, true)),
        false,
    )
    .await;
    assert_eq!(status, 409, "{body}");
    assert_eq!(body["error"]["code"], "confirmation_required");
    assert_eq!(body["error"]["confirm_header"], "invincible-confirmed");
    assert_eq!(body["cost_estimate_usd"], 0.5);
    assert_eq!(body["require_regions"], json!(["EU-secure"]));
    assert_eq!(count(&log_of(&stack.mocks), "runpod:create"), 0);
    assert!(std::fs::read_dir(stack.dir.join("rent/state")).unwrap().next().is_none(), "a quote writes no session");

    let catalogs = log_of(&stack.mocks).iter().filter(|line| line.starts_with("runpod:catalog")).count();
    let (status, body) = call(
        &stack.url,
        reqwest::Method::POST,
        "/v1/rent/sessions",
        Some(
            json!({"project_id": "hailuo-tests", "preset_id": "comfyui-minimax-h3", "hours": 1, "require_regions": []}),
        ),
        true,
    )
    .await;
    assert_eq!(status, 400, "{body}");
    assert!(body["error"]["message"].as_str().unwrap_or("").contains("cannot be cleared"), "{body}");
    let (status, body) = call(
        &stack.url,
        reqwest::Method::POST,
        "/v1/rent/sessions",
        Some(json!({"project_id": "hailuo-tests", "preset_id": "comfyui-minimax-h3", "hours": 1, "require_regions": ["US"]})),
        true,
    )
    .await;
    assert_eq!(status, 400, "{body}");
    let (status, body) = call(
        &stack.url,
        reqwest::Method::POST,
        "/v1/rent/sessions",
        Some(json!({"project_id": "hailuo-tests", "preset_id": "comfyui-minimax-h3", "hours": 1, "require_regions": ["EU-x,US"]})),
        true,
    )
    .await;
    assert_eq!(status, 400, "{body}");
    assert_eq!(
        log_of(&stack.mocks).iter().filter(|line| line.starts_with("runpod:catalog")).count(),
        catalogs,
        "a refused region does not ask the vendor"
    );
    let (status, offers) = call(
        &stack.url,
        reqwest::Method::GET,
        "/v1/rent/offers?preset=comfyui-minimax-h3&hours=1&require_regions=EU-secure",
        None,
        false,
    )
    .await;
    assert_eq!(status, 200, "{offers}");
    assert!(offers["offers"].as_array().unwrap().iter().all(|offer| offer["cloud"] == "secure"), "{offers}");

    let (status, body) =
        call(&stack.url, reqwest::Method::POST, "/v1/rent/sessions", Some(create_body("dev-box", 1.0, false)), true)
            .await;
    assert_eq!(status, 403, "{body}");
    assert_eq!(body["error"]["limit"], "max_usd_per_hour");
    assert_eq!(count(&log_of(&stack.mocks), "runpod:create"), 0);

    let mut started_body = create_body("comfyui-minimax-h3", 1.0, false);
    started_body["offer_id"] = json!(" ");
    let (status, started) =
        call(&stack.url, reqwest::Method::POST, "/v1/rent/sessions", Some(started_body.clone()), true).await;
    assert_eq!(status, 201, "{started}");
    let session_id = started["id"].as_str().unwrap().to_owned();
    assert_eq!(started["phase"], "ready");
    assert_eq!(started["offer"]["id"], "runpod:secure:NVIDIA GeForce RTX 4090");
    assert_eq!(started["offer"]["usd_per_hr"], 0.5);
    assert_eq!(started["data_center"], "EU-RO-1");
    assert_eq!(count(&log_of(&stack.mocks), "runpod:create"), 1);
    assert!(log_of(&stack.mocks).iter().any(|line| line == "runpod:cloud:SECURE"), "{:?}", log_of(&stack.mocks));
    assert!(count(&log_of(&stack.mocks), "s3:hydrate") >= 1);

    let (status, body) = call(
        &stack.url,
        reqwest::Method::POST,
        "/v1/rent/sessions",
        Some(create_body("comfyui-minimax-h3", 1.0, false)),
        true,
    )
    .await;
    assert_eq!(status, 403, "{body}");
    assert_eq!(body["error"]["limit"], "monthly_cap_usd");
    assert_eq!(count(&log_of(&stack.mocks), "runpod:create"), 1);

    let stop_body = json!({"force": false, "note": "bye"});
    let (status, stopped) = call(
        &stack.url,
        reqwest::Method::POST,
        &format!("/v1/rent/sessions/{session_id}/stop"),
        Some(stop_body.clone()),
        false,
    )
    .await;
    assert_eq!(status, 200, "{stopped}");
    assert_eq!(stopped["phase"], "stopped");
    assert_eq!(stopped["drain_ok"], true);
    order_drains_before_delete(&log_of(&stack.mocks));

    let audit = std::fs::read_to_string(stack.dir.join("audit.jsonl")).unwrap();
    assert!(audit.contains("rent.start"), "{audit}");
    assert!(audit.contains("rent.stop"), "{audit}");
    assert!(!audit.contains(RUNPOD_KEY) && !audit.contains(R2_SECRET), "{audit}");
    let receipt_key = invincible::receipts::ReceiptKey::load_or_create(&stack.dir.join("receipt.key")).unwrap();
    let log = invincible::audit::AuditLog::new(&stack.dir);
    assert_eq!(log.verify(&receipt_key.public()).unwrap(), 2);
    let entries = log.read(0, 10);
    let start = entries.iter().find(|entry| entry["api"] == "rent.start").unwrap();
    let bound = invincible::receipts::request_hash("rent.start", &started_body).unwrap();
    assert_eq!(start["receipt"]["receipt"]["request_sha256"], bound);
    assert_eq!(start["rewrite"]["require_regions"], json!(["EU-secure"]));
    assert_eq!(start["rewrite"]["offer_id"], "runpod:secure:NVIDIA GeForce RTX 4090");
    let stop =
        entries.iter().find(|entry| entry["api"] == "rent.stop" && entry["rent"]["session_id"] == session_id).unwrap();
    assert_eq!(
        stop["receipt"]["receipt"]["request_sha256"],
        invincible::receipts::request_hash("rent.stop", &stop_body).unwrap()
    );

    let creates = count(&log_of(&stack.mocks), "runpod:create");
    assert!(node.stop(), "the node did not exit");
    node.child = spawn(&stack.dir);
    ready(&stack.url, &stack.dir).await;
    let (status, again) =
        call(&stack.url, reqwest::Method::GET, &format!("/v1/rent/sessions/{session_id}"), None, false).await;
    assert_eq!(status, 200, "{again}");
    assert_eq!(again["phase"], "stopped");
    assert_eq!(count(&log_of(&stack.mocks), "runpod:create"), creates, "a restart must not provision");

    let report = tokio::task::spawn_blocking({
        let dir = stack.dir.clone();
        move || invincible::doctor::run(&dir, None)
    })
    .await
    .unwrap();
    let rent = report.checks.iter().find(|check| check.name == "rent").unwrap();
    assert_eq!(rent.state, invincible::doctor::State::Ok, "{}", rent.detail);
    assert_clean(&stack.dir, &[RUNPOD_KEY, R2_ACCESS, R2_SECRET]);
}

#[tokio::test]
async fn an_over_cap_pod_is_drained_and_deleted() {
    let (stack, _node) = stack("rerank", "monthly_cap_usd = 100\n", false, false, false).await;
    ready(&stack.url, &stack.dir).await;
    let (status, body) =
        call(&stack.url, reqwest::Method::POST, "/v1/rent/sessions", Some(create_body("rerank", 1.0, false)), true)
            .await;
    assert_eq!(status, 403, "{body}");
    assert_eq!(body["error"]["code"], "rent_cap");
    order_drains_before_delete(&log_of(&stack.mocks));
    assert!(stack.mocks.pods.lock().unwrap().is_empty(), "the over-cap pod is gone");
}

#[tokio::test]
async fn a_restart_drains_an_expired_pod_and_an_idle_one() {
    let (stack, mut node) = stack("sweep", "monthly_cap_usd = 50\n", false, false, false).await;
    ready(&stack.url, &stack.dir).await;
    let (status, started) = call(
        &stack.url,
        reqwest::Method::POST,
        "/v1/rent/sessions",
        Some(create_body("comfyui-minimax-h3", 1.0, false)),
        true,
    )
    .await;
    assert_eq!(status, 201, "{started}");
    let session_id = started["id"].as_str().unwrap().to_owned();
    assert!(node.stop());
    rewrite_session(&stack.dir, &session_id, "2020-01-01T00:00:00Z", None);
    node.child = spawn(&stack.dir);
    ready(&stack.url, &stack.dir).await;
    wait_deleted(&stack).await;
    order_drains_before_delete(&log_of(&stack.mocks));
    let (status, again) =
        call(&stack.url, reqwest::Method::GET, &format!("/v1/rent/sessions/{session_id}"), None, false).await;
    assert_eq!(status, 200, "{again}");
    assert_eq!(again["phase"], "stopped", "{again}");

    let (status, idle) =
        call(&stack.url, reqwest::Method::POST, "/v1/rent/sessions", Some(create_body("vllm", 1.0, false)), true).await;
    assert_eq!(status, 201, "{idle}");
    let idle_id = idle["id"].as_str().unwrap().to_owned();
    assert!(node.stop());
    rewrite_session(&stack.dir, &idle_id, "2099-01-01T00:00:00Z", Some("2020-01-01T00:00:00Z"));
    let before = count(&log_of(&stack.mocks), "runpod:delete:pod-2");
    node.child = spawn(&stack.dir);
    ready(&stack.url, &stack.dir).await;
    let deadline = Instant::now() + Duration::from_secs(8);
    while count(&log_of(&stack.mocks), "runpod:delete:pod-2") == before {
        assert!(Instant::now() < deadline, "idle pod was not deleted\n{}", log_of(&stack.mocks).join("\n"));
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    let (status, body) =
        call(&stack.url, reqwest::Method::GET, &format!("/v1/rent/sessions/{idle_id}"), None, false).await;
    assert_eq!(status, 200, "{body}");
    assert_eq!(body["phase"], "stopped", "{body}");

    let node_id = std::fs::read_to_string(stack.dir.join("rent/node-id")).unwrap();
    let node_id = node_id.trim();
    stack.mocks.pods.lock().unwrap().extend(["pod-orphan".into(), "pod-other".into(), "pod-hand".into()]);
    stack.mocks.named.lock().unwrap().extend([
        json!({"id": "pod-orphan", "name": format!("invincible-{node_id}-sess_gone")}),
        json!({"id": "pod-other", "name": "invincible-other-node-sess_other"}),
        json!({"id": "pod-hand", "name": "invincible-foo"}),
    ]);
    assert!(node.stop());
    node.child = spawn(&stack.dir);
    ready(&stack.url, &stack.dir).await;
    let deadline = Instant::now() + Duration::from_secs(8);
    while !log_of(&stack.mocks).iter().any(|line| line == "runpod:delete:pod-orphan") {
        assert!(Instant::now() < deadline, "untracked pod was not deleted\n{}", log_of(&stack.mocks).join("\n"));
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    let log = log_of(&stack.mocks);
    assert!(!log.iter().any(|line| line == "runpod:delete:pod-other" || line == "runpod:delete:pod-hand"), "{log:?}");
    let left = stack.mocks.pods.lock().unwrap().clone();
    assert!(left.iter().any(|pod| pod == "pod-other") && left.iter().any(|pod| pod == "pod-hand"), "{left:?}");
}

#[tokio::test]
async fn a_dearer_or_different_offer_than_the_approved_preview_is_refused() {
    let (stack, _node) = stack("price", "monthly_cap_usd = 50\n", false, false, true).await;
    ready(&stack.url, &stack.dir).await;
    let (status, preview) = call(
        &stack.url,
        reqwest::Method::POST,
        "/v1/rent/sessions",
        Some(create_body("comfyui-minimax-h3", 1.0, false)),
        false,
    )
    .await;
    assert_eq!(status, 409, "{preview}");
    assert_eq!(preview["offer"]["usd_per_hr"], 0.5);
    let mut body = create_body("comfyui-minimax-h3", 1.0, false);
    body["offer_id"] = preview["offer"]["id"].clone();
    body["approved_usd_per_hr"] = json!(0.5);
    let (status, again) = call(&stack.url, reqwest::Method::POST, "/v1/rent/sessions", Some(body), true).await;
    assert_eq!(status, 409, "{again}");
    assert_eq!(again["error"]["code"], "confirmation_required");
    assert_eq!(again["offer"]["usd_per_hr"], 0.9);
    assert_eq!(count(&log_of(&stack.mocks), "runpod:create"), 0, "a dearer offer is not provisioned");

    let (status, missing) = call(
        &stack.url,
        reqwest::Method::POST,
        "/v1/rent/sessions",
        Some(json!({
            "project_id": "hailuo-tests",
            "preset_id": "comfyui-minimax-h3",
            "hours": 1,
            "offer_id": "runpod:secure:does-not-exist",
            "approved_usd_per_hr": 0.5
        })),
        true,
    )
    .await;
    assert_eq!(status, 422, "{missing}");
    assert_eq!(missing["error"]["code"], "no_offers");
    assert_eq!(count(&log_of(&stack.mocks), "runpod:create"), 0);
}

#[tokio::test]
async fn a_vendor_error_does_not_return_the_api_key() {
    let (stack, _node) = stack("scrub", "", false, true, false).await;
    ready(&stack.url, &stack.dir).await;
    let (status, body) =
        call(&stack.url, reqwest::Method::GET, "/v1/rent/offers?preset=vllm&hours=1", None, false).await;
    assert!(status >= 500, "{status} {body}");
    let text = body.to_string();
    assert!(!text.contains(RUNPOD_KEY), "{text}");
    let serve = std::fs::read_to_string(stack.dir.join("serve.log")).unwrap_or_default();
    assert!(!serve.contains(RUNPOD_KEY), "{serve}");
}

#[tokio::test]
async fn a_dropped_client_still_gets_a_rent_start_audit() {
    let (stack, node) = stack("detach", "monthly_cap_usd = 50\n", true, false, false).await;
    ready(&stack.url, &stack.dir).await;
    let body = create_body("comfyui-minimax-h3", 1.0, false);
    let client = reqwest::Client::builder().timeout(Duration::from_secs(1)).build().unwrap();
    let dropped = client
        .post(format!("{}/v1/rent/sessions", stack.url))
        .bearer_auth(TOKEN)
        .header("invincible-confirmed", "1")
        .json(&body)
        .send()
        .await;
    assert!(dropped.is_err(), "the client should have given up while the pod was still provisioning");
    let deadline = Instant::now() + Duration::from_secs(10);
    let hash = invincible::receipts::request_hash("rent.start", &body).unwrap();
    loop {
        if let Ok(text) = std::fs::read_to_string(stack.dir.join("audit.jsonl"))
            && text.contains("rent.start")
            && text.contains(&hash)
        {
            break;
        }
        assert!(Instant::now() < deadline, "the start was not audited after the client left");
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    let deadline = Instant::now() + Duration::from_secs(15);
    let instance = loop {
        let mut found = None;
        if let Ok(entries) = std::fs::read_dir(stack.dir.join("rent/state")) {
            for entry in entries.flatten() {
                let Ok(text) = std::fs::read_to_string(entry.path()) else { continue };
                let Ok(value) = serde_json::from_str::<Value>(&text) else { continue };
                if let Some(id) = value["instance_id"].as_str().filter(|id| !id.is_empty()) {
                    found = Some(id.to_owned());
                }
            }
        }
        if found.is_some() || log_of(&stack.mocks).iter().any(|line| line.starts_with("runpod:delete:")) {
            break found;
        }
        assert!(
            Instant::now() < deadline,
            "the pod was neither recorded nor deleted\n{}",
            log_of(&stack.mocks).join("\n")
        );
        tokio::time::sleep(Duration::from_millis(50)).await;
    };
    match instance {
        Some(id) => assert!(stack.mocks.pods.lock().unwrap().iter().any(|pod| pod == &id), "tracked pod {id} is gone"),
        None => assert!(log_of(&stack.mocks).iter().any(|line| line.starts_with("runpod:delete:"))),
    }
    drop(node);
}

#[tokio::test]
async fn a_create_error_is_not_retried() {
    let (stack, _node) = stack("create-fail", "monthly_cap_usd = 50\n", false, false, false).await;
    ready(&stack.url, &stack.dir).await;
    let (status, body) = call(
        &stack.url,
        reqwest::Method::POST,
        "/v1/rent/sessions",
        Some(create_body("comfyui-minimax-h3", 1.0, false)),
        true,
    )
    .await;
    assert!(status >= 500, "{status} {body}");
    tokio::time::sleep(Duration::from_millis(700)).await;
    assert_eq!(count(&log_of(&stack.mocks), "runpod:create"), 1, "{:?}", log_of(&stack.mocks));
}

#[tokio::test]
async fn a_stop_during_create_is_not_revived_when_the_pod_appears() {
    let (stack, _node) = stack("hold-create", "monthly_cap_usd = 50\n", false, false, false).await;
    ready(&stack.url, &stack.dir).await;
    let url = stack.url.clone();
    let create = tokio::spawn(async move {
        call(
            &url,
            reqwest::Method::POST,
            "/v1/rent/sessions",
            Some(create_body("comfyui-minimax-h3", 1.0, false)),
            true,
        )
        .await
    });
    let deadline = Instant::now() + Duration::from_secs(10);
    while !log_of(&stack.mocks).iter().any(|line| line == "runpod:create-waiting") {
        assert!(Instant::now() < deadline, "create did not reach the vendor\n{}", log_of(&stack.mocks).join("\n"));
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    let session_id = loop {
        let (status, body) = call(&stack.url, reqwest::Method::GET, "/v1/rent/sessions", None, false).await;
        assert_eq!(status, 200, "{body}");
        if let Some(id) = body["sessions"].as_array().and_then(|rows| rows.first()).and_then(|row| row["id"].as_str()) {
            break id.to_owned();
        }
        assert!(Instant::now() < deadline, "the provisioning session was not saved");
        tokio::time::sleep(Duration::from_millis(20)).await;
    };
    let (status, stopped) = call(
        &stack.url,
        reqwest::Method::POST,
        &format!("/v1/rent/sessions/{session_id}/stop"),
        Some(json!({})),
        false,
    )
    .await;
    assert_eq!(status, 200, "{stopped}");
    assert_eq!(stopped["phase"], "draining", "{stopped}");
    stack.mocks.release_create.notify_one();
    let (status, created) = create.await.unwrap();
    assert_eq!(status, 201, "{created}");
    assert_eq!(created["phase"], "stopped", "{created}");
    assert_eq!(created["drain_ok"], true, "{created}");
    assert_eq!(created["forced"], false, "a plain stop was recorded as forced: {created}");
    assert!(created["cost_actual_usd"].as_f64().is_some_and(|cost| cost > 0.0), "{created}");
    assert!(created["ended_at"].is_string(), "{created}");
    assert_eq!(created["id"], session_id);
    let receipt_key = format!("sessions/{session_id}/receipt.json");
    let receipt_bytes = stack.mocks.objects.lock().unwrap().get(&receipt_key).cloned().expect("stop receipt");
    let receipt: Value = serde_json::from_slice(&receipt_bytes).unwrap();
    assert_eq!(receipt["instance_id"], created["instance_id"], "{receipt}");
    assert_eq!(receipt["drain_ok"], true, "{receipt}");
    assert_eq!(receipt["cost_actual_usd"], created["cost_actual_usd"], "{receipt}");
    assert_eq!(receipt["ended_at"], created["ended_at"], "{receipt}");
    let deadline = Instant::now() + Duration::from_secs(8);
    while !log_of(&stack.mocks).iter().any(|line| line.starts_with("runpod:delete:")) {
        assert!(Instant::now() < deadline, "the late pod was not deleted\n{}", log_of(&stack.mocks).join("\n"));
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    tokio::time::sleep(Duration::from_millis(200)).await;
    let (status, again) =
        call(&stack.url, reqwest::Method::GET, &format!("/v1/rent/sessions/{session_id}"), None, false).await;
    assert_eq!(status, 200, "{again}");
    assert_eq!(again["phase"], "stopped", "the create path revived the session: {again}");
    assert!(stack.mocks.pods.lock().unwrap().is_empty(), "the pod is still billed");
    let log = log_of(&stack.mocks);
    let control = log.iter().position(|line| line == "s3:control").expect("drain was requested");
    let delete = log.iter().position(|line| line.starts_with("runpod:delete:")).expect("pod was deleted");
    assert!(control < delete, "{log:?}");
}

#[tokio::test]
async fn a_failed_delete_of_a_late_pod_stays_open_for_another_stop() {
    let (stack, _node) = stack("delete-once", "monthly_cap_usd = 50\n", false, false, false).await;
    ready(&stack.url, &stack.dir).await;
    let url = stack.url.clone();
    let create = tokio::spawn(async move {
        call(
            &url,
            reqwest::Method::POST,
            "/v1/rent/sessions",
            Some(create_body("comfyui-minimax-h3", 1.0, false)),
            true,
        )
        .await
    });
    let deadline = Instant::now() + Duration::from_secs(10);
    while !log_of(&stack.mocks).iter().any(|line| line == "runpod:create-waiting") {
        assert!(Instant::now() < deadline, "create did not reach the vendor");
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    let (status, listed) = call(&stack.url, reqwest::Method::GET, "/v1/rent/sessions", None, false).await;
    assert_eq!(status, 200, "{listed}");
    let session_id = listed["sessions"][0]["id"].as_str().unwrap().to_owned();
    let (status, stopped) = call(
        &stack.url,
        reqwest::Method::POST,
        &format!("/v1/rent/sessions/{session_id}/stop"),
        Some(json!({})),
        false,
    )
    .await;
    assert_eq!(status, 200, "{stopped}");
    stack.mocks.release_create.notify_one();
    let (status, created) = create.await.unwrap();
    assert_eq!(status, 201, "{created}");
    assert_ne!(created["phase"], "stopped", "{created}");
    assert!(!created["instance_id"].is_null(), "{created}");
    let receipt_key = format!("sessions/{session_id}/receipt.json");
    assert!(!stack.mocks.objects.lock().unwrap().contains_key(&receipt_key), "a failed delete wrote a stop receipt");
    assert!(
        log_of(&stack.mocks).iter().any(|line| line.starts_with("runpod:delete-fail:")),
        "{:?}",
        log_of(&stack.mocks)
    );
    assert!(!stack.mocks.pods.lock().unwrap().is_empty(), "the failed delete removed the pod");
    let (status, again) = call(
        &stack.url,
        reqwest::Method::POST,
        &format!("/v1/rent/sessions/{session_id}/stop"),
        Some(json!({"force": true})),
        false,
    )
    .await;
    assert_eq!(status, 200, "{again}");
    assert_eq!(again["phase"], "stopped", "{again}");
    assert!(again["cost_actual_usd"].as_f64().is_some_and(|cost| cost > 0.0), "{again}");
    assert!(stack.mocks.pods.lock().unwrap().is_empty(), "the retry did not delete the pod");
    let receipt_bytes = stack.mocks.objects.lock().unwrap().get(&receipt_key).cloned().expect("retry receipt");
    let receipt: Value = serde_json::from_slice(&receipt_bytes).unwrap();
    assert_eq!(receipt["instance_id"], again["instance_id"], "{receipt}");
    assert_eq!(receipt["cost_actual_usd"], again["cost_actual_usd"], "{receipt}");
}

#[tokio::test]
async fn a_create_that_fails_after_a_stop_is_a_503_and_the_stop_finishes() {
    let (stack, _node) = stack("hold-fail", "monthly_cap_usd = 50\n", false, false, false).await;
    ready(&stack.url, &stack.dir).await;
    let url = stack.url.clone();
    let create = tokio::spawn(async move {
        call(
            &url,
            reqwest::Method::POST,
            "/v1/rent/sessions",
            Some(create_body("comfyui-minimax-h3", 1.0, false)),
            true,
        )
        .await
    });
    let deadline = Instant::now() + Duration::from_secs(10);
    while !log_of(&stack.mocks).iter().any(|line| line == "runpod:create-waiting") {
        assert!(Instant::now() < deadline, "create did not reach the vendor");
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    let (status, listed) = call(&stack.url, reqwest::Method::GET, "/v1/rent/sessions", None, false).await;
    assert_eq!(status, 200, "{listed}");
    let session_id = listed["sessions"][0]["id"].as_str().unwrap().to_owned();
    let (status, stopped) = call(
        &stack.url,
        reqwest::Method::POST,
        &format!("/v1/rent/sessions/{session_id}/stop"),
        Some(json!({})),
        false,
    )
    .await;
    assert_eq!(status, 200, "{stopped}");
    assert_eq!(stopped["phase"], "draining", "{stopped}");
    stack.mocks.release_create.notify_one();
    let (status, created) = create.await.unwrap();
    assert_eq!(status, 503, "a create with no pod was reported as started: {created}");
    assert_eq!(created["error"]["code"], "rent_unavailable", "{created}");
    let (status, session) =
        call(&stack.url, reqwest::Method::GET, &format!("/v1/rent/sessions/{session_id}"), None, false).await;
    assert_eq!(status, 200, "{session}");
    assert_eq!(session["phase"], "stopped", "the stop was left waiting for a pod: {session}");
    assert!(session["instance_id"].is_null(), "{session}");
    assert_eq!(session["drain_ok"], true, "{session}");
    assert_eq!(session["forced"], false, "a plain stop was recorded as forced: {session}");
    assert_eq!(session["cost_actual_usd"], 0.0, "no pod ran, so nothing is charged: {session}");
    let log = log_of(&stack.mocks);
    assert!(!log.iter().any(|line| line.starts_with("runpod:delete")), "{log:?}");
    let audit = std::fs::read_to_string(stack.dir.join("audit.jsonl")).unwrap_or_default();
    assert!(!audit.contains("rent.start"), "a failed create was audited as a start: {audit}");
    assert!(audit.contains("rent.stop"), "{audit}");
}

#[tokio::test]
async fn a_stop_during_hydrate_is_not_overwritten() {
    let (stack, _node) = stack("hold-hydrate", "monthly_cap_usd = 50\n", false, false, false).await;
    ready(&stack.url, &stack.dir).await;
    let url = stack.url.clone();
    let create = tokio::spawn(async move {
        call(
            &url,
            reqwest::Method::POST,
            "/v1/rent/sessions",
            Some(create_body("comfyui-minimax-h3", 1.0, false)),
            true,
        )
        .await
    });
    let deadline = Instant::now() + Duration::from_secs(10);
    while !log_of(&stack.mocks).iter().any(|line| line == "s3:hydrate") {
        assert!(Instant::now() < deadline, "hydrate did not start\n{}", log_of(&stack.mocks).join("\n"));
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    let (status, listed) = call(&stack.url, reqwest::Method::GET, "/v1/rent/sessions", None, false).await;
    assert_eq!(status, 200, "{listed}");
    let session_id = listed["sessions"][0]["id"].as_str().unwrap().to_owned();
    let (status, stopped) = call(
        &stack.url,
        reqwest::Method::POST,
        &format!("/v1/rent/sessions/{session_id}/stop"),
        Some(json!({})),
        false,
    )
    .await;
    assert_eq!(status, 200, "{stopped}");
    assert_eq!(stopped["phase"], "stopped", "{stopped}");
    stack.mocks.release_hydrate.notify_one();
    let (status, created) = create.await.unwrap();
    assert_eq!(status, 201, "{created}");
    assert_eq!(created["phase"], "stopped", "{created}");
    tokio::time::sleep(Duration::from_millis(200)).await;
    let (status, again) =
        call(&stack.url, reqwest::Method::GET, &format!("/v1/rent/sessions/{session_id}"), None, false).await;
    assert_eq!(status, 200, "{again}");
    assert_eq!(again["phase"], "stopped", "hydrate saved over the stop: {again}");
}

fn rewrite_session(dir: &Path, id: &str, deadline: &str, last_active: Option<&str>) {
    let path = dir.join("rent/state").join(format!("{id}.json"));
    let mut value: Value = serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
    value["deadline_at"] = json!(deadline);
    if let Some(at) = last_active {
        value["last_active"] = json!(at);
    }
    std::fs::write(&path, serde_json::to_vec_pretty(&value).unwrap()).unwrap();
}

async fn wait_deleted(stack: &Stack) {
    let deadline = Instant::now() + Duration::from_secs(8);
    while stack.mocks.pods.lock().unwrap().iter().any(|pod| pod == "pod-1")
        || !log_of(&stack.mocks).iter().any(|line| line.starts_with("runpod:delete:"))
    {
        assert!(Instant::now() < deadline, "expired pod was not deleted\n{}", log_of(&stack.mocks).join("\n"));
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
}
