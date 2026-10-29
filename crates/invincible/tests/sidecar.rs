//! The rent sidecar against real rclone and an in-process S3 mock.
//! Hydrate writes `hydrate-ok.json` before the workload, and a passed deadline drains before exit.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

use sha2::{Digest, Sha256};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use axum::body::Body;
use axum::extract::State;
use axum::http::{Request, StatusCode};
use axum::response::Response;

#[tokio::test]
async fn the_sidecar_hydrates_then_drains_when_the_deadline_has_passed() {
    let root = std::env::temp_dir().join(format!("invincible-sidecar-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&root);
    std::fs::create_dir_all(&root).unwrap();
    let workspace = root.join("workspace");
    let store = Store::default();
    store.put("projects/demo/workspace/note.txt", b"kept\n");
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let app = axum::Router::new().fallback(s3).with_state(store.clone());
    tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });

    let rclone = rclone_bin();
    let scripts = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../sidecar");
    let stdout_path = root.join("stdout.log");
    let stderr_path = root.join("stderr.log");
    let stdout_file = std::fs::File::create(&stdout_path).unwrap();
    let stderr_file = std::fs::File::create(&stderr_path).unwrap();
    let mut child = Command::new("bash")
        .arg(scripts.join("bootstrap.sh"))
        .env("PATH", format!("{}:{}", rclone.parent().unwrap().display(), std::env::var("PATH").unwrap_or_default()))
        .env("INVINCIBLE_SESSION_ID", "sess_demo")
        .env("INVINCIBLE_PROJECT_ID", "demo")
        .env("INVINCIBLE_BUCKET", "rent")
        .env("INVINCIBLE_ENDPOINT", format!("http://127.0.0.1:{port}"))
        .env("INVINCIBLE_ACCESS_KEY_ID", "access-key-test")
        .env("INVINCIBLE_SECRET_ACCESS_KEY", "secret-key-test")
        .env("INVINCIBLE_REGION", "auto")
        .env("INVINCIBLE_WORKSPACE", &workspace)
        .env("INVINCIBLE_HYDRATE_MAP", format!("projects/demo/workspace|{}", workspace.display()))
        .env("INVINCIBLE_DRAIN_MAP", format!("{}|projects/demo/workspace", workspace.display()))
        .env("INVINCIBLE_DRAIN_EXCLUDES", "")
        .env("INVINCIBLE_WORKLOAD", "true")
        .env("INVINCIBLE_DEADLINE_AT", "2020-01-01T00:00:00Z")
        .env("INVINCIBLE_POLL_SEC", "1")
        .env("INVINCIBLE_DRAIN_GRACE_SEC", "1")
        .current_dir(&scripts)
        .stdout(Stdio::from(stdout_file))
        .stderr(Stdio::from(stderr_file))
        .spawn()
        .unwrap();
    let deadline = Instant::now() + Duration::from_secs(40);
    let status = loop {
        if let Some(status) = child.try_wait().unwrap() {
            break status;
        }
        if Instant::now() > deadline {
            let _ = Command::new("pkill").args(["-KILL", "-P", &child.id().to_string()]).status();
            let _ = child.kill();
            let _ = child.wait();
            let stdout = std::fs::read_to_string(&stdout_path).unwrap_or_default();
            let stderr = std::fs::read_to_string(&stderr_path).unwrap_or_default();
            panic!("sidecar did not exit\nstdout:\n{stdout}\nstderr:\n{stderr}\nlog:\n{:?}", store.log.lock().unwrap());
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    };
    let stdout = std::fs::read_to_string(&stdout_path).unwrap_or_default();
    let stderr = std::fs::read_to_string(&stderr_path).unwrap_or_default();
    assert!(status.success(), "status {status:?}\nstdout:\n{stdout}\nstderr:\n{stderr}");
    assert_eq!(std::fs::read_to_string(workspace.join("note.txt")).unwrap_or_default(), "kept\n", "{stderr}");
    assert_eq!(store.get("projects/demo/workspace/note.txt").as_deref(), Some(b"kept\n".as_slice()));
    assert!(store.get("sessions/sess_demo/hydrate-ok.json").is_some(), "hydrate-ok missing\n{stderr}");
    assert!(store.get("sessions/sess_demo/drain-ok.json").is_some(), "drain-ok missing\n{stderr}");
    let log = store.log.lock().unwrap().clone();
    let hydrate_at =
        log.iter().position(|line| line == "hydrate-ok.json").unwrap_or_else(|| panic!("{log:?}\n{stderr}"));
    let drain_at = log.iter().position(|line| line == "drain-ok.json").unwrap_or_else(|| panic!("{log:?}\n{stderr}"));
    assert!(hydrate_at < drain_at, "{log:?}");
    assert!(
        log.iter().any(|line| line.contains("AWS4-HMAC-SHA256") && line.contains("access-key-test")),
        "rclone did not sign an S3 request: {log:?}"
    );
    let _ = std::fs::remove_dir_all(&root);
}

#[tokio::test]
async fn an_empty_workspace_does_not_wipe_a_nonempty_remote() {
    let root = std::env::temp_dir().join(format!("invincible-sidecar-empty-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&root);
    let workspace = root.join("workspace");
    std::fs::create_dir_all(&workspace).unwrap();
    let store = Store::default();
    store.put("projects/demo/workspace/note.txt", b"kept\n");
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let app = axum::Router::new().fallback(s3).with_state(store.clone());
    tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    let rclone = rclone_bin();
    let scripts = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../sidecar");
    let stderr_path = root.join("stderr.log");
    let stderr_file = std::fs::File::create(&stderr_path).unwrap();
    let mut child = Command::new("bash")
        .arg(scripts.join("drain.sh"))
        .env("PATH", format!("{}:{}", rclone.parent().unwrap().display(), std::env::var("PATH").unwrap_or_default()))
        .env("INVINCIBLE_SESSION_ID", "sess_demo")
        .env("INVINCIBLE_PROJECT_ID", "demo")
        .env("INVINCIBLE_BUCKET", "rent")
        .env("INVINCIBLE_ENDPOINT", format!("http://127.0.0.1:{port}"))
        .env("INVINCIBLE_ACCESS_KEY_ID", "access-key-test")
        .env("INVINCIBLE_SECRET_ACCESS_KEY", "secret-key-test")
        .env("INVINCIBLE_REGION", "auto")
        .env("INVINCIBLE_WORKSPACE", &workspace)
        .env_remove("INVINCIBLE_DRAIN_MAP")
        .current_dir(&scripts)
        .stdout(Stdio::from(stderr_file.try_clone().unwrap()))
        .stderr(Stdio::from(stderr_file))
        .spawn()
        .unwrap();
    let deadline = Instant::now() + Duration::from_secs(20);
    let status = loop {
        if let Some(status) = child.try_wait().unwrap() {
            break status;
        }
        if Instant::now() > deadline {
            let _ = child.kill();
            let _ = child.wait();
            panic!("drain did not exit\n{}", std::fs::read_to_string(&stderr_path).unwrap_or_default());
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    };
    let err = std::fs::read_to_string(&stderr_path).unwrap_or_default();
    assert!(!status.success(), "an empty drain must fail\n{err}");
    assert_eq!(store.get("projects/demo/workspace/note.txt").as_deref(), Some(b"kept\n".as_slice()), "{err}");
    assert!(store.get("sessions/sess_demo/drain-ok.json").is_none(), "drain-ok was written over kept data\n{err}");
    let _ = std::fs::remove_dir_all(&root);
}

#[derive(Clone, Default)]
struct Store {
    objects: Arc<Mutex<BTreeMap<String, Vec<u8>>>>,
    log: Arc<Mutex<Vec<String>>>,
}

impl Store {
    fn put(&self, key: &str, body: &[u8]) {
        self.objects.lock().unwrap().insert(key.to_owned(), body.to_vec());
    }

    fn get(&self, key: &str) -> Option<Vec<u8>> {
        self.objects.lock().unwrap().get(key).cloned()
    }
}

async fn s3(State(store): State<Store>, request: Request<Body>) -> Response {
    let method = request.method().clone();
    let path = request.uri().path().to_owned();
    let query = request.uri().query().unwrap_or("").to_owned();
    let auth = request.headers().get("authorization").and_then(|value| value.to_str().ok()).unwrap_or("").to_owned();
    store.log.lock().unwrap().push(format!("{method} {path}?{query} {auth}"));
    if !auth.starts_with("AWS4-HMAC-SHA256 ") {
        return text(StatusCode::FORBIDDEN, "unsigned");
    }
    let key = object_key(&path);
    let body = axum::body::to_bytes(request.into_body(), 8 * 1024 * 1024).await.unwrap_or_default();
    if query.contains("list-type=2") || (method == axum::http::Method::GET && key.is_empty()) {
        return text(StatusCode::OK, &list_xml(&store, &query_param(&query, "prefix").unwrap_or_default()));
    }
    if method == axum::http::Method::PUT {
        if !key.is_empty() {
            let name = key.rsplit('/').next().unwrap_or(&key).to_owned();
            store.put(&key, &body);
            store.log.lock().unwrap().push(name);
        }
        return text(StatusCode::OK, "");
    }
    if method == axum::http::Method::DELETE {
        store.objects.lock().unwrap().remove(&key);
        return text(StatusCode::NO_CONTENT, "");
    }
    if method == axum::http::Method::HEAD && key.is_empty() {
        return text(StatusCode::OK, "");
    }
    match store.get(&key) {
        Some(bytes) if method == axum::http::Method::HEAD || method == axum::http::Method::GET => {
            let mut response =
                Response::new(Body::from(if method == axum::http::Method::HEAD { Vec::new() } else { bytes.clone() }));
            *response.status_mut() = StatusCode::OK;
            response.headers_mut().insert("content-length", bytes.len().to_string().parse().unwrap());
            response.headers_mut().insert("etag", "\"sidecar-test\"".parse().unwrap());
            response.headers_mut().insert("last-modified", "Wed, 01 Jan 2020 00:00:00 GMT".parse().unwrap());
            response
        }
        Some(_) => text(StatusCode::METHOD_NOT_ALLOWED, "method"),
        None => text(StatusCode::NOT_FOUND, "missing"),
    }
}

fn list_xml(store: &Store, prefix: &str) -> String {
    let objects = store.objects.lock().unwrap();
    let mut xml =
        String::from("<?xml version=\"1.0\" encoding=\"UTF-8\"?><ListBucketResult><IsTruncated>false</IsTruncated>");
    for (key, bytes) in objects.iter().filter(|(key, _)| key.starts_with(prefix)) {
        xml.push_str(&format!(
            "<Contents><Key>{}</Key><Size>{}</Size><ETag>&quot;sidecar-test&quot;</ETag><LastModified>2020-01-01T00:00:00.000Z</LastModified></Contents>",
            xml_escape(key),
            bytes.len()
        ));
    }
    xml.push_str("</ListBucketResult>");
    xml
}

fn object_key(path: &str) -> String {
    let rest = path.trim_start_matches('/');
    match rest.split_once('/') {
        Some(("rent", key)) => decode(key),
        Some(_) => String::new(),
        None => String::new(),
    }
}

fn query_param(query: &str, name: &str) -> Option<String> {
    for pair in query.split('&') {
        let (key, value) = pair.split_once('=').unwrap_or((pair, ""));
        if decode(key) == name {
            return Some(decode(value));
        }
    }
    None
}

fn decode(text: &str) -> String {
    let bytes = text.as_bytes();
    let mut out = Vec::new();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%'
            && i + 2 < bytes.len()
            && let Ok(byte) = u8::from_str_radix(std::str::from_utf8(&bytes[i + 1..i + 3]).unwrap_or(""), 16)
        {
            out.push(byte);
            i += 3;
            continue;
        }
        if bytes[i] == b'+' {
            out.push(b' ');
        } else {
            out.push(bytes[i]);
        }
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

fn xml_escape(text: &str) -> String {
    text.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;")
}

fn text(status: StatusCode, body: &str) -> Response {
    let mut response = Response::new(Body::from(body.to_owned()));
    *response.status_mut() = status;
    response.headers_mut().insert("content-type", "application/xml".parse().unwrap());
    response
}

/// SHA-256 of the rclone v1.68.2 zip, from downloads.rclone.org/v1.68.2/SHA256SUMS.
fn rclone_sha() -> (&'static str, &'static str) {
    match (std::env::consts::OS, std::env::consts::ARCH) {
        ("linux", "x86_64") => {
            ("rclone-v1.68.2-linux-amd64", "0e6fa18051e67fc600d803a2dcb10ddedb092247fc6eee61be97f64ec080a13c")
        }
        ("linux", "aarch64") => {
            ("rclone-v1.68.2-linux-arm64", "c6e9d4cf9c88b279f6ad80cd5675daebc068e404890fa7e191412c1bc7a4ac5f")
        }
        ("macos", "x86_64") => {
            ("rclone-v1.68.2-osx-amd64", "cdc685e16abbf35b6f47c95b2a5b4ad73a73921ff6842e5f4136c8b461756188")
        }
        ("macos", "aarch64") => {
            ("rclone-v1.68.2-osx-arm64", "323f387b32bcf9ddfc3874f01879a0b2689dbd91309beb8c3a4410db04d0c41f")
        }
        (os, arch) => panic!("no pinned rclone build for {os}-{arch}"),
    }
}

fn sha256_file(path: &Path) -> String {
    let mut hasher = Sha256::new();
    hasher.update(std::fs::read(path).unwrap_or_default());
    hasher.finalize().iter().map(|byte| format!("{byte:02x}")).collect()
}

fn rclone_bin() -> PathBuf {
    let (name, sha) = rclone_sha();
    let home = std::env::var_os("HOME").map(PathBuf::from).unwrap_or_else(std::env::temp_dir);
    let cache = home.join(".cache/invincible/rclone-v1.68.2");
    std::fs::create_dir_all(&cache).unwrap();
    let _lock = CacheLock::acquire(&cache);
    let zip = cache.join(format!("{name}.zip"));
    let bin = cache.join(name).join("rclone");
    let stamp = cache.join(format!("{name}.sha256"));
    let stamp_ok = std::fs::read_to_string(&stamp).ok().is_some_and(|text| text.trim() == sha);
    if zip.is_file() && sha256_file(&zip) == sha && bin.is_file() && stamp_ok {
        return bin;
    }
    if !zip.is_file() || sha256_file(&zip) != sha {
        let url = format!("https://downloads.rclone.org/v1.68.2/{name}.zip");
        let partial = cache.join(format!("{name}.zip.partial"));
        let status = Command::new("curl").args(["-fsSL", "-o"]).arg(&partial).arg(&url).status().expect("curl");
        assert!(status.success(), "could not download rclone from {url}");
        assert_eq!(sha256_file(&partial), sha, "rclone zip does not match the pinned digest");
        std::fs::rename(&partial, &zip).unwrap();
    }
    let extracted = Command::new("python3")
        .args(["-c", "import sys, zipfile; zipfile.ZipFile(sys.argv[1]).extractall(sys.argv[2])"])
        .arg(&zip)
        .arg(&cache)
        .status()
        .expect("python3");
    assert!(extracted.success() && bin.is_file(), "rclone zip did not contain {bin:?}");
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mut mode = std::fs::metadata(&bin).unwrap().permissions();
        mode.set_mode(0o755);
        std::fs::set_permissions(&bin, mode).unwrap();
    }
    std::fs::write(&stamp, sha).unwrap();
    bin
}

/// One installer at a time. The lock is `flock`, released when this value is dropped.
struct CacheLock {
    _file: std::fs::File,
}

impl CacheLock {
    fn acquire(cache: &Path) -> Self {
        let file = std::fs::OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .open(cache.join("lock"))
            .unwrap();
        rustix::fs::flock(&file, rustix::fs::FlockOperation::LockExclusive)
            .unwrap_or_else(|err| panic!("rclone cache lock: {err}"));
        Self { _file: file }
    }
}
