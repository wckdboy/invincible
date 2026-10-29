//! Renting a GPU through a supervised `wckd` (spec/rent.md).
//!
//! The stand-in is a small Python server that speaks the `wckd serve` contract the node launches:
//! loopback, bearer from `--api-key-file`, 401 without it, 409 and no session until `confirm` is
//! true. It keeps sessions in `WCKD_STATE_DIR`, which is how a restarted node finds them again.

use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

use invincible::devices::StaticKey;
use invincible::remote::{self, PairingCode};
use serde_json::{Value, json};
use tokio::net::TcpListener;

const TOKEN: &str = "node-token";
const DOOR_TOKEN: &str = "door-token";

const STAND_IN: &str = r#"#!/usr/bin/env python3
import json, os, sys, threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import socketserver
from urllib.parse import parse_qs, urlparse

args = sys.argv[1:]
def flag(name):
    return args[args.index(name) + 1] if name in args else None
listen = flag("--listen") or "127.0.0.1:9"
host, port = listen.rsplit(":", 1)
port = int(port)
key_path = flag("--api-key-file")
state = os.environ.get("WCKD_STATE_DIR")
if not key_path or not state:
    sys.stderr.write("wckd stand-in: missing --api-key-file or WCKD_STATE_DIR\n")
    sys.exit(2)
KEY = open(key_path).read().strip()
KEY_IN_ARGV = any(KEY and KEY in arg for arg in args)
KEY_IN_ENV = any(value == KEY for value in os.environ.values())
os.makedirs(state, exist_ok=True)
STORE = os.path.join(state, "store.json")
LOCK = threading.Lock()

def load():
    if os.path.exists(STORE):
        with open(STORE) as handle:
            data = json.load(handle)
    else:
        data = {"sessions": [], "previews": 0, "provisions": 0}
    data["key_in_argv"] = KEY_IN_ARGV
    data["key_in_env"] = KEY_IN_ENV
    return data

def save(data):
    tmp = STORE + ".tmp"
    with open(tmp, "w") as handle:
        json.dump(data, handle)
    os.replace(tmp, STORE)

save(load())

def regions_of(raw):
    if raw is None:
        return ["EU"]
    if isinstance(raw, list):
        return raw
    return [part for part in str(raw).split(",") if part != ""]

class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    def log_message(self, fmt, *args):
        sys.stderr.write((fmt % args) + "\n")
    def bearer_ok(self):
        given = self.headers.get("Authorization") or ""
        if given.startswith("Bearer "):
            given = given[len("Bearer "):]
        return given == KEY
    def send_json(self, status, body):
        data = json.dumps(body).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)
    def read_json(self):
        length = int(self.headers.get("Content-Length") or 0)
        raw = self.rfile.read(length) if length else b""
        if not raw.strip():
            return {}
        return json.loads(raw)
    def guard(self):
        if self.bearer_ok():
            return True
        self.send_json(401, {"error": {"code": "unauthorized", "message": "missing or invalid bearer token"}})
        return False
    def do_GET(self):
        if not self.guard():
            return
        parsed = urlparse(self.path)
        path = parsed.path
        if path in ("/health", "/v1/rent/health"):
            self.send_json(200, {"ok": True, "engine": "wckd"})
            return
        if path == "/v1/rent/offers":
            query = parse_qs(parsed.query)
            preset = (query.get("preset") or [""])[0]
            try:
                hours = float((query.get("hours") or ["0"])[0])
            except ValueError:
                hours = 0
            if not preset or not (0 < hours <= 24):
                self.send_json(400, {"error": {"code": "bad_request", "message": "preset and hours are required"}})
                return
            usd = 5.0 if preset == "expensive" else 0.5
            regions = regions_of((query.get("require_regions") or [None])[0])
            estimate = round(usd * hours, 4)
            self.send_json(200, {
                "preset_id": preset,
                "hours": hours,
                "require_regions": regions,
                "cost_basis": "catalog_usd_per_hr_times_hours",
                "offers": [{
                    "id": "runpod:community:NVIDIA GeForce RTX 4090",
                    "usd_per_hr": usd,
                    "estimate_usd": estimate,
                    "region": "EU-RO-1",
                    "cloud": "community",
                }],
            })
            return
        if path == "/v1/rent/sessions":
            with LOCK:
                sessions = list(reversed(load()["sessions"]))
            self.send_json(200, {"sessions": sessions})
            return
        if path.startswith("/v1/rent/sessions/"):
            session_id = path.split("/")[4]
            with LOCK:
                found = next((session for session in load()["sessions"] if session["id"] == session_id), None)
            if found is None:
                self.send_json(404, {"error": {"code": "not_found", "message": "no such session"}})
            else:
                self.send_json(200, found)
            return
        self.send_json(404, {"error": {"code": "not_found", "message": "unknown route"}})
    def do_POST(self):
        if not self.guard():
            return
        path = urlparse(self.path).path
        if path == "/v1/rent/sessions":
            body = self.read_json()
            hours = float(body.get("hours") or 0)
            preset = body.get("preset_id") or ""
            if not preset or not (0 < hours <= 24):
                self.send_json(400, {"error": {"code": "bad_request", "message": "preset and hours are required"}})
                return
            usd = 5.0 if preset == "expensive" else 0.5
            estimate = round(usd * hours, 4)
            regions = regions_of(body.get("require_regions"))
            confirmed = body.get("confirm") is True or self.headers.get("X-Wckd-Confirm") == "true"
            offer = {
                "id": body.get("offer_id") or "runpod:community:NVIDIA GeForce RTX 4090",
                "usd_per_hr": usd,
                "estimate_usd": estimate,
            }
            if not confirmed:
                with LOCK:
                    data = load()
                    data["previews"] += 1
                    save(data)
                self.send_json(409, {
                    "error": {"code": "confirmation_required", "message": "confirmation required; resend with confirm true to rent the chosen offer. Nothing was created."},
                    "project_id": body.get("project_id"),
                    "preset_id": preset,
                    "hours": hours,
                    "cost_basis": "catalog_usd_per_hr_times_hours",
                    "cost_estimate_usd": estimate,
                    "require_regions": regions,
                    "require_secure": False,
                    "offer": offer,
                    "failover": [offer],
                })
                return
            with LOCK:
                data = load()
                data["provisions"] += 1
                session = {
                    "id": "sess_%d" % data["provisions"],
                    "project_id": body.get("project_id"),
                    "preset_id": preset,
                    "hours": hours,
                    "created_at": __import__("datetime").datetime.now(__import__("datetime").timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
                    "phase": "ready",
                    "offer": offer,
                    "cost_estimate_usd": estimate,
                    "endpoints": [],
                }
                data["sessions"].append(session)
                save(data)
            self.send_json(201, session)
            return
        if path.startswith("/v1/rent/sessions/") and path.endswith("/stop"):
            session_id = path.split("/")[4]
            body = self.read_json()
            with LOCK:
                data = load()
                found = next((session for session in data["sessions"] if session["id"] == session_id), None)
                if found is None:
                    self.send_json(404, {"error": {"code": "not_found", "message": "no such session"}})
                    return
                found["phase"] = "terminated"
                found["forced"] = bool(body.get("force"))
                save(data)
            self.send_json(200, found)
            return
        self.send_json(404, {"error": {"code": "not_found", "message": "unknown route"}})

class Server(ThreadingHTTPServer):
    allow_reuse_address = True
    def server_bind(self):
        socketserver.TCPServer.server_bind(self)
        self.server_name, self.server_port = self.server_address[:2]

Server((host, port), Handler).serve_forever()
"#;

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

fn free_port() -> u16 {
    std::net::TcpListener::bind("127.0.0.1:0").unwrap().local_addr().unwrap().port()
}

fn spawn(dir: &Path) -> Child {
    let log = std::fs::OpenOptions::new().create(true).append(true).open(dir.join("serve.log")).unwrap();
    Command::new(env!("CARGO_BIN_EXE_invincible"))
        .arg("serve")
        .current_dir(dir)
        .env("INVINCIBLE_HOME", dir)
        .env("HOME", dir)
        .stdin(Stdio::null())
        .stdout(log.try_clone().unwrap())
        .stderr(log)
        .spawn()
        .unwrap()
}

fn layout(tag: &str) -> (PathBuf, String, String) {
    let dir = std::env::temp_dir().join(format!("invincible-rent-{tag}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    let program = dir.join("wckd");
    std::fs::write(&program, STAND_IN).unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&program, std::fs::Permissions::from_mode(0o755)).unwrap();
    }
    std::fs::write(dir.join("token"), format!("{TOKEN}\n")).unwrap();
    let api = free_port();
    let remote = free_port();
    let config = format!(
        "listen = \"127.0.0.1:{api}\"\n\
         [remote]\n\
         name = \"studio\"\n\
         listen = [\"127.0.0.1:{remote}\"]\n\
         [rent]\n\
         enabled = true\n\
         binary = {program:?}\n\
         max_usd_per_hour = 1.0\n\
         max_hours = 2\n\
         monthly_cap_usd = 0.75\n\
         idle_minutes = 15\n\
         require_regions = [\"EU\"]\n",
        program = program.display().to_string(),
    );
    std::fs::write(dir.join("config.toml"), config).unwrap();
    (dir, format!("http://127.0.0.1:{api}"), format!("127.0.0.1:{remote}"))
}

fn store(dir: &Path) -> Value {
    let text = std::fs::read_to_string(dir.join("rent/state/store.json")).unwrap();
    serde_json::from_str(&text).unwrap()
}

async fn ready(url: &str, dir: &Path) -> Value {
    let client = reqwest::Client::new();
    let deadline = Instant::now() + Duration::from_secs(20);
    loop {
        if let Ok(response) = client.get(format!("{url}/v1/rent/health")).bearer_auth(TOKEN).send().await
            && response.status() == 200
        {
            let body: Value = response.json().await.unwrap();
            if body["ok"] == true && body["supervised"] == true {
                return body;
            }
        }
        assert!(
            Instant::now() < deadline,
            "wckd never became healthy\n{}",
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

#[test]
fn doctor_fails_when_rent_is_enabled_and_wckd_is_missing() {
    let dir = std::env::temp_dir().join(format!("invincible-rent-doctor-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(dir.join("config.toml"), "[rent]\nenabled = true\nbinary = \"/nonexistent/wckd\"\n").unwrap();
    let report = invincible::doctor::run(&dir, None);
    let rent = report.checks.iter().find(|check| check.name == "rent").expect("a rent check");
    assert_eq!(rent.state, invincible::doctor::State::Fail, "{}", rent.detail);
    assert!(rent.detail.contains("wckd"), "{}", rent.detail);
    let _ = std::fs::remove_dir_all(&dir);
}

#[tokio::test]
async fn the_node_proxies_wckd_and_keeps_the_key_and_the_caps() {
    let (dir, url, remote) = layout("proxy");
    let mut node = Node { child: spawn(&dir), dir: dir.clone() };
    let health = ready(&url, &dir).await;
    assert_eq!(health["limits"]["require_regions"], json!(["EU"]));
    assert_eq!(health["limits"]["max_hours"], 2.0);
    assert_eq!(health["limits"]["idle_minutes"], 15);

    let key = std::fs::read_to_string(dir.join("rent/wckd.key")).unwrap();
    let key = key.trim().to_owned();
    assert_eq!(key.len(), 64);
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mode = std::fs::metadata(dir.join("rent/wckd.key")).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o600);
    }
    let flags = store(&dir);
    assert_eq!(flags["key_in_argv"], false);
    assert_eq!(flags["key_in_env"], false);
    assert_eq!(flags["provisions"], 0);

    // A paired device without the rent scope is refused in the open. With it, the same door works.
    let client = reqwest::Client::new();
    let pairing = client.post(format!("{url}/v1/admin/pairing")).bearer_auth(TOKEN).send().await.unwrap();
    let pairing_status = pairing.status();
    let pairing: Value = pairing.json().await.unwrap();
    assert_eq!(pairing_status, 200, "{pairing}");
    let code = PairingCode::decode(pairing["code"].as_str().unwrap()).unwrap();
    let device = StaticKey::load_or_create(&dir.join("phone.key")).unwrap();
    remote::pair(&code, &device, "phone").await.unwrap();
    let door_listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let door_addr = door_listener.local_addr().unwrap();
    tokio::spawn(remote::tunnel(door_listener, vec![remote], code.node_key.to_vec(), device, DOOR_TOKEN.into()));
    let door = format!("http://{door_addr}");
    let denied = reqwest::Client::new()
        .get(format!("{door}/v1/rent/offers?preset=comfy&hours=1"))
        .bearer_auth(DOOR_TOKEN)
        .send()
        .await
        .unwrap();
    assert_eq!(denied.status(), 403);
    let denied: Value = denied.json().await.unwrap();
    assert_eq!(denied["error"]["code"], "forbidden");
    assert!(!denied.to_string().contains(&key));
    let grant = client
        .patch(format!("{url}/v1/admin/devices/phone"))
        .bearer_auth(TOKEN)
        .json(&json!({"capabilities": ["rent"]}))
        .send()
        .await
        .unwrap();
    assert_eq!(grant.status(), 200, "{}", grant.text().await.unwrap_or_default());
    let allowed =
        reqwest::Client::new().get(format!("{door}/v1/rent/health")).bearer_auth(DOOR_TOKEN).send().await.unwrap();
    assert_eq!(allowed.status(), 200, "{}", allowed.text().await.unwrap_or_default());

    let (status, offers) = call(&url, reqwest::Method::GET, "/v1/rent/offers?preset=comfy&hours=1", None, false).await;
    assert_eq!(status, 200, "{offers}");
    assert_eq!(offers["require_regions"], json!(["EU"]));
    assert_eq!(offers["offers"][0]["usd_per_hr"], 0.5);
    assert!(!offers.to_string().contains(&key));

    let cli = Command::new(env!("CARGO_BIN_EXE_invincible"))
        .args(["rent", "offers", "--preset", "comfy", "--hours", "1"])
        .env("INVINCIBLE_HOME", &dir)
        .env("HOME", &dir)
        .output()
        .unwrap();
    let cli_out = String::from_utf8_lossy(&cli.stdout);
    assert!(cli.status.success(), "stderr: {}", String::from_utf8_lossy(&cli.stderr));
    assert!(cli_out.contains("0.5"), "{cli_out}");
    assert!(!cli_out.contains(&key));

    // Over the hour cap: the node rejects before wckd is asked, so nothing is previewed.
    let (status, body) =
        call(&url, reqwest::Method::POST, "/v1/rent/sessions", Some(create_body("comfy", 3.0, false)), true).await;
    assert_eq!(status, 403, "{body}");
    assert_eq!(body["error"]["code"], "rent_cap");
    assert_eq!(body["error"]["limit"], "max_hours");
    assert_eq!(store(&dir)["provisions"], 0);
    assert_eq!(store(&dir)["previews"], 0);

    // A body that says confirm, without the header, does not provision.
    let (status, body) =
        call(&url, reqwest::Method::POST, "/v1/rent/sessions", Some(create_body("comfy", 1.0, true)), false).await;
    assert_eq!(status, 409, "{body}");
    assert_eq!(body["error"]["code"], "confirmation_required");
    assert_eq!(body["error"]["confirm_header"], "invincible-confirmed");
    assert_eq!(body["cost_estimate_usd"], 0.5);
    assert_eq!(body["require_regions"], json!(["EU"]));
    assert_eq!(store(&dir)["provisions"], 0);
    assert_eq!(store(&dir)["previews"], 1);
    assert!(!body.to_string().contains(&key));

    // Over the hourly cap: wckd was asked for a price and did not provision.
    let (status, body) =
        call(&url, reqwest::Method::POST, "/v1/rent/sessions", Some(create_body("expensive", 1.0, false)), true).await;
    assert_eq!(status, 403, "{body}");
    assert_eq!(body["error"]["limit"], "max_usd_per_hour");
    assert_eq!(store(&dir)["provisions"], 0);

    let (status, started) =
        call(&url, reqwest::Method::POST, "/v1/rent/sessions", Some(create_body("comfy", 1.0, false)), true).await;
    assert_eq!(status, 201, "{started}");
    let session_id = started["id"].as_str().unwrap().to_owned();
    assert_eq!(started["phase"], "ready");
    assert_eq!(store(&dir)["provisions"], 1);
    assert!(!started.to_string().contains(&key));

    // A second one crosses the monthly cap. The first session is already on the books.
    let (status, body) =
        call(&url, reqwest::Method::POST, "/v1/rent/sessions", Some(create_body("comfy", 1.0, false)), true).await;
    assert_eq!(status, 403, "{body}");
    assert_eq!(body["error"]["limit"], "monthly_cap_usd");
    assert_eq!(store(&dir)["provisions"], 1);

    let (status, stopped) = call(
        &url,
        reqwest::Method::POST,
        &format!("/v1/rent/sessions/{session_id}/stop"),
        Some(json!({"force": false})),
        false,
    )
    .await;
    assert_eq!(status, 200, "{stopped}");
    assert_eq!(stopped["phase"], "terminated");

    let audit = std::fs::read_to_string(dir.join("audit.jsonl")).unwrap();
    assert!(audit.contains("rent.start"), "{audit}");
    assert!(audit.contains("rent.stop"), "{audit}");
    assert!(audit.contains(&session_id), "{audit}");
    assert!(!audit.contains(&key), "the bearer is in the audit log");
    let receipt_key = invincible::receipts::ReceiptKey::load_or_create(&dir.join("receipt.key")).unwrap();
    let log = invincible::audit::AuditLog::new(&dir);
    assert_eq!(log.verify(&receipt_key.public()).unwrap(), 2);

    // A new node process supervises a new wckd on the same state directory.
    assert!(node.stop(), "the node did not exit");
    node.child = spawn(&dir);
    ready(&url, &dir).await;
    let key_again = std::fs::read_to_string(dir.join("rent/wckd.key")).unwrap();
    let key_again = key_again.trim().to_owned();
    let (status, again) =
        call(&url, reqwest::Method::GET, &format!("/v1/rent/sessions/{session_id}"), None, false).await;
    assert_eq!(status, 200, "{again}");
    assert_eq!(again["id"], session_id);
    assert_eq!(again["phase"], "terminated");
    assert_eq!(store(&dir)["provisions"], 1, "a restart must not provision");

    let doctor_dir = dir.clone();
    let report = tokio::task::spawn_blocking(move || invincible::doctor::run(&doctor_dir, None)).await.unwrap();
    let rent = report.checks.iter().find(|check| check.name == "rent").unwrap();
    assert_eq!(rent.state, invincible::doctor::State::Ok, "{}", rent.detail);

    let mut files = Vec::new();
    walk(&dir, &mut files);
    for path in files {
        if path.ends_with("wckd.key") {
            continue;
        }
        let text = std::fs::read_to_string(&path).unwrap_or_default();
        assert!(!text.contains(&key), "first bearer in {}", path.display());
        assert!(!text.contains(&key_again), "restart bearer in {}", path.display());
    }
}
