//! Remote access over Noise (spec/pairing.md): pairing codes, the node's listener, the client
//! side, and the encrypted byte pipe both use. Inside the pipe runs plain HTTP/1.1 to the same
//! API as on loopback, minus the token: a paired device is authenticated by its pinned key.

use std::sync::{Arc, Mutex};
use std::time::Duration;

use axum::Router;
use base64::Engine as _;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use serde_json::json;
use snow::{HandshakeState, TransportState};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::time::{Instant, timeout};

use crate::devices::{Capabilities, Devices, StaticKey};

/// `psk1`, not `psk2`: the secret must be mixed in by the end of the *first* message, so the node
/// can tell a device that knows the code from one that does not before pinning anything. With
/// `psk2` the node would read the first message, and pin the key, without any proof.
pub const PAIR_PATTERN: &str = "Noise_IKpsk1_25519_ChaChaPoly_SHA256";
pub const SESSION_PATTERN: &str = "Noise_IK_25519_ChaChaPoly_SHA256";
const PAIR_PROLOGUE: &[u8] = b"invincible/0 pair";
const SESSION_PROLOGUE: &[u8] = b"invincible/0 session";
/// The first byte on a connection, in the clear (and bound into the handshake by the prologue).
pub const MODE_PAIR: u8 = 1;
pub const MODE_SESSION: u8 = 2;

const MAX_FRAME: usize = 65535;
const TAG: usize = 16;
const MAX_PLAIN: usize = MAX_FRAME - TAG;
const HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(10);
/// Handshakes in progress at once, from anyone: more wait their turn or are dropped.
const MAX_HANDSHAKES: usize = 64;
/// Sessions one paired device may hold open at once.
const MAX_SESSIONS_PER_DEVICE: usize = 32;
pub const CODE_LIFETIME: Duration = Duration::from_secs(600);
/// Failed pairing handshakes before a code is burned.
const MAX_PAIR_FAILURES: u32 = 5;
const MAX_HANDSHAKE_PAYLOAD: usize = 1024;

// ---------------------------------------------------------------------------------------------
// Pairing codes

/// What a node shows as a QR code: its key, a one-time secret, and where to reach it.
/// Text form: `invincible://pair?v=0&k=<key>&s=<secret>&a=<host:port>,<host:port>` (base64url).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PairingCode {
    pub node_key: [u8; 32],
    pub secret: [u8; 32],
    pub addrs: Vec<String>,
}

impl PairingCode {
    pub fn encode(&self) -> String {
        format!(
            "invincible://pair?v=0&k={}&s={}&a={}",
            URL_SAFE_NO_PAD.encode(self.node_key),
            URL_SAFE_NO_PAD.encode(self.secret),
            self.addrs.join(",")
        )
    }

    pub fn decode(text: &str) -> Result<Self, String> {
        let query = text.trim().strip_prefix("invincible://pair?").ok_or("not an Invincible pairing code")?;
        let (mut version, mut key, mut secret, mut addrs) = (None, None, None, None);
        for pair in query.split('&') {
            match pair.split_once('=') {
                Some(("v", v)) => version = Some(v),
                Some(("k", v)) => key = Some(v),
                Some(("s", v)) => secret = Some(v),
                Some(("a", v)) => addrs = Some(v),
                _ => {}
            }
        }
        if version != Some("0") {
            return Err(format!("unsupported pairing code version {:?}", version.unwrap_or("none")));
        }
        let bytes32 = |what: &str, value: Option<&str>| -> Result<[u8; 32], String> {
            URL_SAFE_NO_PAD
                .decode(value.ok_or(format!("pairing code has no {what}"))?)
                .ok()
                .and_then(|b| <[u8; 32]>::try_from(b).ok())
                .ok_or(format!("pairing code has a malformed {what}"))
        };
        let addrs: Vec<String> =
            addrs.unwrap_or("").split(',').map(str::trim).filter(|a| !a.is_empty()).map(str::to_owned).collect();
        if addrs.is_empty() {
            return Err("pairing code has no address".to_owned());
        }
        Ok(Self { node_key: bytes32("key", key)?, secret: bytes32("secret", secret)?, addrs })
    }
}

// ---------------------------------------------------------------------------------------------
// Framing: u16 big-endian length, then that many bytes.

async fn read_frame<R: AsyncRead + Unpin>(r: &mut R) -> std::io::Result<Vec<u8>> {
    let len = r.read_u16().await? as usize;
    let mut frame = vec![0u8; len];
    r.read_exact(&mut frame).await?;
    Ok(frame)
}

async fn write_frame<W: AsyncWrite + Unpin>(w: &mut W, frame: &[u8]) -> std::io::Result<()> {
    let len = u16::try_from(frame.len()).map_err(|_| std::io::Error::other("frame too large"))?;
    let mut out = Vec::with_capacity(2 + frame.len());
    out.extend_from_slice(&len.to_be_bytes());
    out.extend_from_slice(frame);
    w.write_all(&out).await
}

fn responder(
    pattern: &str,
    local: &StaticKey,
    prologue: &[u8],
    psk: Option<&[u8; 32]>,
) -> Result<HandshakeState, String> {
    let mut builder = snow::Builder::new(pattern.parse().expect("Noise pattern"))
        .local_private_key(&local.private)
        .and_then(|b| b.prologue(prologue))
        .map_err(|e| e.to_string())?;
    if let Some(psk) = psk {
        builder = builder.psk(1, psk).map_err(|e| e.to_string())?;
    }
    builder.build_responder().map_err(|e| e.to_string())
}

fn initiator(
    pattern: &str,
    local: &StaticKey,
    remote: &[u8],
    prologue: &[u8],
    psk: Option<&[u8; 32]>,
) -> Result<HandshakeState, String> {
    let mut builder = snow::Builder::new(pattern.parse().expect("Noise pattern"))
        .local_private_key(&local.private)
        .and_then(|b| b.remote_public_key(remote))
        .and_then(|b| b.prologue(prologue))
        .map_err(|e| e.to_string())?;
    if let Some(psk) = psk {
        builder = builder.psk(1, psk).map_err(|e| e.to_string())?;
    }
    builder.build_initiator().map_err(|e| e.to_string())
}

// ---------------------------------------------------------------------------------------------
// The encrypted pipe

/// Why the inbound half of a pipe ended.
enum Inbound {
    /// The peer finished sending; the answer may still be on its way.
    Eof,
    /// Bad frame, failed decryption, revoked device: drop everything now.
    Abort,
}

/// Pipes [plain] through [transport] over [tcp] in both directions until both are done. When
/// [allowed] turns false (the device was unpaired) the connection is dropped at the next frame.
pub async fn pipe<P>(tcp: TcpStream, transport: TransportState, plain: P, allowed: impl Fn() -> bool)
where
    P: AsyncRead + AsyncWrite + Unpin,
{
    let transport = Mutex::new(transport);
    let (mut tcp_read, mut tcp_write) = tcp.into_split();
    let (mut plain_read, mut plain_write) = tokio::io::split(plain);

    let inbound = async {
        let mut buf = vec![0u8; MAX_FRAME];
        loop {
            let frame = match read_frame(&mut tcp_read).await {
                Ok(frame) => frame,
                Err(e) if e.kind() == std::io::ErrorKind::UnexpectedEof => break Inbound::Eof,
                Err(_) => break Inbound::Abort,
            };
            if !allowed() {
                break Inbound::Abort;
            }
            let Ok(n) = transport.lock().expect("transport lock").read_message(&frame, &mut buf) else {
                break Inbound::Abort;
            };
            if plain_write.write_all(&buf[..n]).await.is_err() {
                break Inbound::Abort;
            }
        }
    };
    let outbound = async {
        let mut plain = vec![0u8; MAX_PLAIN];
        let mut out = vec![0u8; MAX_FRAME];
        loop {
            let n = match plain_read.read(&mut plain).await {
                Ok(0) | Err(_) => break,
                Ok(n) => n,
            };
            // An unpaired device gets nothing more, not even the rest of a stream.
            if !allowed() {
                break;
            }
            let Ok(m) = transport.lock().expect("transport lock").write_message(&plain[..n], &mut out) else {
                break;
            };
            if write_frame(&mut tcp_write, &out[..m]).await.is_err() {
                break;
            }
        }
        let _ = tcp_write.shutdown().await;
    };

    tokio::pin!(outbound);
    tokio::select! {
        how = inbound => {
            if let Inbound::Eof = how {
                let _ = plain_write.shutdown().await;
                outbound.await;
            }
        }
        () = &mut outbound => {}
    }
}

// ---------------------------------------------------------------------------------------------
// Node side

/// The node's half of pairing: its key, where it can be reached, the open pairing code, and the
/// pinned devices.
pub struct Pairing {
    pub key: StaticKey,
    pub name: String,
    /// The receipt public key, sent to devices when they pair (spec/receipts.md).
    pub receipt_key: String,
    pub advertise: Vec<String>,
    pub devices: Devices,
    pending: Mutex<Option<Pending>>,
    /// Open sessions per device key.
    sessions: Mutex<std::collections::HashMap<Vec<u8>, usize>>,
}

struct Pending {
    secret: [u8; 32],
    expires: Instant,
    failures: u32,
    /// What the device that consumes this code is granted (spec/pairing.md, Capabilities): the
    /// operator's decision, carried by the code, never something the device asks for.
    capabilities: Capabilities,
}

impl Pairing {
    pub fn new(key: StaticKey, name: String, advertise: Vec<String>, devices: Devices) -> Self {
        Self {
            key,
            name,
            advertise,
            devices,
            receipt_key: String::new(),
            pending: Mutex::new(None),
            sessions: Mutex::default(),
        }
    }

    pub fn with_receipt_key(mut self, public: String) -> Self {
        self.receipt_key = public;
        self
    }

    /// Opens a pairing code (replacing any open one), valid for [CODE_LIFETIME] and one pairing.
    /// The device that consumes it is granted `shard`: the least a session is for.
    pub fn start(&self) -> Result<PairingCode, String> {
        self.start_for(CODE_LIFETIME)
    }

    /// [Pairing::start] with another lifetime, still granting `shard` only.
    pub fn start_for(&self, lifetime: Duration) -> Result<PairingCode, String> {
        self.start_granting(lifetime, Capabilities::shard())
    }

    /// [Pairing::start] with another lifetime and the set the device that consumes the code will
    /// hold (spec/pairing.md, Capabilities). The set belongs to the code, not to the handshake:
    /// a device that asks for more in its hello is given what this says.
    pub fn start_granting(&self, lifetime: Duration, capabilities: Capabilities) -> Result<PairingCode, String> {
        let secret = crate::token::random::<32>()?;
        *self.pending.lock().expect("pending lock") =
            Some(Pending { secret, expires: Instant::now() + lifetime, failures: 0, capabilities });
        Ok(PairingCode {
            node_key: self.key.public.as_slice().try_into().expect("32-byte key"),
            secret,
            addrs: self.advertise.clone(),
        })
    }

    fn open_secret(&self) -> Option<[u8; 32]> {
        let mut pending = self.pending.lock().expect("pending lock");
        match pending.as_ref() {
            Some(p) if Instant::now() < p.expires => Some(p.secret),
            _ => {
                *pending = None;
                None
            }
        }
    }

    fn pairing_failed(&self) {
        let mut pending = self.pending.lock().expect("pending lock");
        if let Some(p) = pending.as_mut() {
            p.failures += 1;
            if p.failures >= MAX_PAIR_FAILURES {
                tracing::warn!("pairing code burned after {MAX_PAIR_FAILURES} failed attempts");
                *pending = None;
            }
        }
    }

    /// Uses up the code [secret] once its handshake succeeded, answering what it grants: Some
    /// for exactly one caller, and only while it is still the open, unexpired code (two
    /// handshakes racing on one code, or a code replaced or burned meanwhile, pin nothing).
    fn take_code(&self, secret: &[u8; 32]) -> Option<Capabilities> {
        let mut pending = self.pending.lock().expect("pending lock");
        let granted = match pending.as_ref() {
            Some(p) if &p.secret == secret && Instant::now() < p.expires => Some(p.capabilities.clone()),
            _ => None,
        };
        if granted.is_some() {
            *pending = None;
        }
        granted
    }

    /// Counts a session of device [key]; None when it has [MAX_SESSIONS_PER_DEVICE] open already.
    fn session(self: &Arc<Self>, key: &[u8]) -> Option<SessionSlot> {
        let mut open = self.sessions.lock().expect("sessions lock");
        let n = open.entry(key.to_vec()).or_insert(0);
        if *n >= MAX_SESSIONS_PER_DEVICE {
            return None;
        }
        *n += 1;
        Some(SessionSlot { pairing: self.clone(), key: key.to_vec() })
    }
}

/// One open session of a device; counted down when dropped.
struct SessionSlot {
    pairing: Arc<Pairing>,
    key: Vec<u8>,
}

impl Drop for SessionSlot {
    fn drop(&mut self) {
        let mut open = self.pairing.sessions.lock().expect("sessions lock");
        if let Some(n) = open.get_mut(&self.key) {
            *n = n.saturating_sub(1);
            if *n == 0 {
                open.remove(&self.key);
            }
        }
    }
}

/// Accepts remote connections on [listener] and serves [app] to paired devices.
pub async fn serve(listener: TcpListener, pairing: Arc<Pairing>, app: Router) {
    let handshakes = Arc::new(tokio::sync::Semaphore::new(MAX_HANDSHAKES));
    // Accept errors logged at most once a minute, with how many there were.
    let (mut warned, mut failed) = (None::<tokio::time::Instant>, 0u64);
    loop {
        let (tcp, peer) = match listener.accept().await {
            Ok(accepted) => accepted,
            // Out of file descriptors (or the like): a moment's pause, not a loop at full speed
            // that keeps them from being freed (or a log filled with the same line).
            Err(e) => {
                failed += 1;
                if warned.is_none_or(|at| at.elapsed() >= std::time::Duration::from_secs(60)) {
                    tracing::warn!("remote: accept: {e} ({failed} times since the last note)");
                    (warned, failed) = (Some(tokio::time::Instant::now()), 0);
                }
                tokio::time::sleep(std::time::Duration::from_millis(100)).await;
                continue;
            }
        };
        // Unauthenticated work is bounded: past MAX_HANDSHAKES in flight, new peers are dropped.
        let Ok(permit) = handshakes.clone().try_acquire_owned() else {
            tracing::debug!(%peer, "too many handshakes in progress; connection dropped");
            continue;
        };
        let (pairing, app) = (pairing.clone(), app.clone());
        tokio::spawn(async move {
            if let Err(e) = accept(tcp, pairing, app, permit).await {
                tracing::info!(%peer, "remote connection refused: {e}");
            }
        });
    }
}

async fn accept(
    mut tcp: TcpStream,
    pairing: Arc<Pairing>,
    app: Router,
    permit: tokio::sync::OwnedSemaphorePermit,
) -> Result<(), String> {
    let _ = tcp.set_nodelay(true);
    let (transport, device_key) = timeout(HANDSHAKE_TIMEOUT, respond(&mut tcp, &pairing))
        .await
        .map_err(|_| "handshake timed out".to_owned())??;
    drop(permit);
    let _slot = pairing.session(&device_key).ok_or("too many open sessions for this device")?;

    let (ours, theirs) = tokio::io::duplex(MAX_FRAME);
    // Requests on this session are the device's (for the audit log).
    let name = pairing.devices.name_of(&device_key).unwrap_or_else(|| crate::devices::fingerprint(&device_key));
    let app = app.layer(axum::Extension(crate::audit::Caller::device(&name, &device_key)));
    let service = hyper_util::service::TowerToHyperService::new(app);
    tokio::spawn(async move {
        let _ = hyper::server::conn::http1::Builder::new()
            .timer(hyper_util::rt::TokioTimer::new())
            .header_read_timeout(Duration::from_secs(30))
            .serve_connection(hyper_util::rt::TokioIo::new(theirs), service)
            .await;
    });
    let devices = pairing.clone();
    pipe(tcp, transport, ours, move || devices.devices.is_pinned(&device_key)).await;
    Ok(())
}

/// The responder's handshake: pairing (pins the device) or a session (requires a pinned device).
async fn respond(tcp: &mut TcpStream, pairing: &Pairing) -> Result<(TransportState, Vec<u8>), String> {
    let mode = tcp.read_u8().await.map_err(|e| e.to_string())?;
    let mut payload = vec![0u8; MAX_FRAME];
    let mut out = vec![0u8; MAX_FRAME];
    match mode {
        MODE_PAIR => {
            let secret = pairing.open_secret().ok_or("no open pairing code")?;
            let mut hs = responder(PAIR_PATTERN, &pairing.key, PAIR_PROLOGUE, Some(&secret))?;
            let first = read_frame(tcp).await.map_err(|e| e.to_string())?;
            let n = match hs.read_message(&first, &mut payload) {
                Ok(n) => n,
                Err(e) => {
                    pairing.pairing_failed();
                    return Err(format!("pairing handshake failed: {e}"));
                }
            };
            if n > MAX_HANDSHAKE_PAYLOAD {
                return Err("pairing hello is too long".to_owned());
            }
            let hello: serde_json::Value =
                serde_json::from_slice(&payload[..n]).map_err(|_| "pairing hello is not JSON".to_owned())?;
            let device_key = hs.get_remote_static().ok_or("no device key")?.to_vec();
            let Some(granted) = pairing.take_code(&secret) else {
                return Err("the pairing code was used, replaced or expired meanwhile".to_owned());
            };
            // Only the name is read from the hello. A device that puts `capabilities` in it gets
            // the code's set: what the operator granted, never what the device asked for.
            let name =
                pairing.devices.add_with(hello["name"].as_str().unwrap_or("device"), &device_key, granted.clone())?;
            let reply = json!({
                "node": pairing.name,
                "device": name,
                "receipts": pairing.receipt_key,
                "capabilities": granted.codes(),
            })
            .to_string();
            let m = hs.write_message(reply.as_bytes(), &mut out).map_err(|e| e.to_string())?;
            write_frame(tcp, &out[..m]).await.map_err(|e| e.to_string())?;
            tracing::info!(
                device = %name,
                key = %crate::devices::fingerprint(&device_key),
                capabilities = ?granted.codes(),
                "device paired"
            );
            Ok((hs.into_transport_mode().map_err(|e| e.to_string())?, device_key))
        }
        MODE_SESSION => {
            let mut hs = responder(SESSION_PATTERN, &pairing.key, SESSION_PROLOGUE, None)?;
            let first = read_frame(tcp).await.map_err(|e| e.to_string())?;
            hs.read_message(&first, &mut payload).map_err(|e| format!("session handshake failed: {e}"))?;
            let device_key = hs.get_remote_static().ok_or("no device key")?.to_vec();
            if !pairing.devices.is_pinned(&device_key) {
                return Err(format!("device {} is not paired", crate::devices::fingerprint(&device_key)));
            }
            let m = hs.write_message(&[], &mut out).map_err(|e| e.to_string())?;
            write_frame(tcp, &out[..m]).await.map_err(|e| e.to_string())?;
            Ok((hs.into_transport_mode().map_err(|e| e.to_string())?, device_key))
        }
        other => Err(format!("unknown mode {other}")),
    }
}

// ---------------------------------------------------------------------------------------------
// Client side

/// What pairing told the device: the node's name, the name it pinned the device under, and what
/// that device may reach (spec/pairing.md, Capabilities).
#[derive(Debug)]
pub struct Paired {
    pub node: String,
    pub device: String,
    /// The node's receipt key, received over the authenticated channel; pin it.
    pub receipt_key: Option<String>,
    /// What the node grants this device, as its reply said. `None` from a node before 0.0.22,
    /// which sends no set because it gave a paired device its whole API.
    pub capabilities: Option<Capabilities>,
}

async fn dial(addrs: &[String]) -> Result<TcpStream, String> {
    let mut last = "no address".to_owned();
    for addr in addrs {
        match timeout(HANDSHAKE_TIMEOUT, TcpStream::connect(addr)).await {
            Ok(Ok(tcp)) => {
                let _ = tcp.set_nodelay(true);
                return Ok(tcp);
            }
            Ok(Err(e)) => last = format!("{addr}: {e}"),
            Err(_) => last = format!("{addr}: timed out"),
        }
    }
    Err(last)
}

/// Pairs [device] with the node in [code], under [name].
pub async fn pair(code: &PairingCode, device: &StaticKey, name: &str) -> Result<Paired, String> {
    pair_with_hello(code, device, json!({ "name": name })).await
}

/// The pairing handshake with a hello of the caller's choosing.
///
/// Only `name` is read from it (spec/pairing.md): a device that puts `capabilities` in its hello
/// is granted what the code says and nothing more, so asking is not a way to escalate. The
/// parameter exists because that has to be testable against a real node.
async fn pair_with_hello(code: &PairingCode, device: &StaticKey, hello: serde_json::Value) -> Result<Paired, String> {
    let mut tcp = dial(&code.addrs).await?;
    let work = async {
        let mut hs = initiator(PAIR_PATTERN, device, &code.node_key, PAIR_PROLOGUE, Some(&code.secret))?;
        let mut out = vec![0u8; MAX_FRAME];
        // What the node was asked to call us, for a reply that leaves the name out.
        let requested = hello["name"].as_str().unwrap_or("device").to_owned();
        let hello = hello.to_string();
        let m = hs.write_message(hello.as_bytes(), &mut out).map_err(|e| e.to_string())?;
        tcp.write_u8(MODE_PAIR).await.map_err(|e| e.to_string())?;
        write_frame(&mut tcp, &out[..m]).await.map_err(|e| e.to_string())?;
        let reply = read_frame(&mut tcp).await.map_err(|_| "the node refused pairing (code wrong, used or expired)")?;
        let mut payload = vec![0u8; MAX_FRAME];
        let n = hs.read_message(&reply, &mut payload).map_err(|e| format!("pairing handshake failed: {e}"))?;
        let reply: serde_json::Value = serde_json::from_slice(&payload[..n]).map_err(|e| e.to_string())?;
        Ok(Paired {
            node: reply["node"].as_str().unwrap_or("node").to_owned(),
            device: reply["device"].as_str().unwrap_or(&requested).to_owned(),
            receipt_key: reply["receipts"].as_str().filter(|k| !k.is_empty()).map(str::to_owned),
            capabilities: Capabilities::reported(reply.get("capabilities")),
        })
    };
    timeout(HANDSHAKE_TIMEOUT, work).await.map_err(|_| "pairing timed out".to_owned())?
}

/// Opens an encrypted session to a node whose key the device pinned when it paired.
pub async fn connect(
    addrs: &[String],
    node_key: &[u8],
    device: &StaticKey,
) -> Result<(TcpStream, TransportState), String> {
    let mut tcp = dial(addrs).await?;
    let work = async {
        let mut hs = initiator(SESSION_PATTERN, device, node_key, SESSION_PROLOGUE, None)?;
        let mut out = vec![0u8; MAX_FRAME];
        let m = hs.write_message(&[], &mut out).map_err(|e| e.to_string())?;
        tcp.write_u8(MODE_SESSION).await.map_err(|e| e.to_string())?;
        write_frame(&mut tcp, &out[..m]).await.map_err(|e| e.to_string())?;
        let reply = read_frame(&mut tcp).await.map_err(|_| "the node refused the session (device not paired?)")?;
        let mut payload = vec![0u8; MAX_FRAME];
        hs.read_message(&reply, &mut payload).map_err(|e| format!("session handshake failed: {e}"))?;
        hs.into_transport_mode().map_err(|e| e.to_string())
    };
    let transport = timeout(HANDSHAKE_TIMEOUT, work).await.map_err(|_| "session handshake timed out".to_owned())??;
    Ok((tcp, transport))
}

/// The tunnel's door: where the node is, and the local token a request must carry.
struct Door {
    addrs: Vec<String>,
    node_key: Vec<u8>,
    device: StaticKey,
    token: String,
}

/// Serves a plain-HTTP door on [listener] (loopback) that leads to the node: each request goes
/// through its own encrypted session. A request needs this machine's local token (`Authorization:
/// Bearer`, as on a node's own API) and a loopback `Host`, so a web page in a browser on this
/// machine cannot use the door (no cross-site requests, no DNS rebinding).
pub async fn tunnel(listener: TcpListener, addrs: Vec<String>, node_key: Vec<u8>, device: StaticKey, token: String) {
    let door = Arc::new(Door { addrs, node_key, device, token });
    let app = axum::Router::new().fallback(through_door).with_state(door);
    let _ = axum::serve(listener, app).await;
}

/// Whether a `Host` header names this machine (`127.0.0.1:7780`, `localhost`, `[::1]:7780`).
fn loopback_host(host: &str) -> bool {
    let name = if let Some(rest) = host.strip_prefix('[') {
        rest.split(']').next().unwrap_or_default()
    } else {
        host.rsplit_once(':').map_or(host, |(name, _)| name)
    };
    name.eq_ignore_ascii_case("localhost") || name.parse::<std::net::IpAddr>().is_ok_and(|ip| ip.is_loopback())
}

async fn through_door(
    axum::extract::State(door): axum::extract::State<Arc<Door>>,
    mut request: axum::extract::Request,
) -> axum::response::Response {
    use axum::http::{StatusCode, header};
    use axum::response::IntoResponse;
    let host = request.headers().get(header::HOST).and_then(|v| v.to_str().ok()).unwrap_or_default();
    if !loopback_host(host) {
        return (StatusCode::FORBIDDEN, "the tunnel answers only requests to 127.0.0.1 or localhost").into_response();
    }
    let given = request
        .headers()
        .get(header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "))
        .unwrap_or("");
    if !crate::token::matches(&door.token, given) {
        return (StatusCode::UNAUTHORIZED, "missing or wrong token (see `invincible token` on this machine)")
            .into_response();
    }
    // The node knows the device by its key; the local token stays here.
    request.headers_mut().remove(header::AUTHORIZATION);
    let (tcp, transport) = match connect(&door.addrs, &door.node_key, &door.device).await {
        Ok(session) => session,
        Err(e) => return (StatusCode::BAD_GATEWAY, format!("the node: {e}")).into_response(),
    };
    let (ours, theirs) = tokio::io::duplex(MAX_FRAME);
    tokio::spawn(async move { pipe(tcp, transport, theirs, || true).await });
    let (mut sender, connection) = match hyper::client::conn::http1::handshake(hyper_util::rt::TokioIo::new(ours)).await
    {
        Ok(pair) => pair,
        Err(e) => return (StatusCode::BAD_GATEWAY, format!("the node: {e}")).into_response(),
    };
    tokio::spawn(connection);
    match sender.send_request(request).await {
        Ok(response) => response.map(axum::body::Body::new),
        Err(e) => (StatusCode::BAD_GATEWAY, format!("the node: {e}")).into_response(),
    }
}

#[cfg(test)]
mod tests {
    use super::PairingCode;

    #[test]
    fn codes_round_trip() {
        let code = PairingCode {
            node_key: [7; 32],
            secret: [9; 32],
            addrs: vec!["192.168.1.20:7778".into(), "[fd00::1]:7778".into()],
        };
        assert_eq!(PairingCode::decode(&code.encode()).unwrap(), code);
    }

    #[test]
    fn a_code_is_taken_once_and_not_after_it_is_replaced() {
        let dir = std::env::temp_dir().join(format!("invincible-take-{}", std::process::id()));
        let pairing = super::Pairing::new(
            crate::devices::StaticKey::load_or_create(&dir.join("node.key")).unwrap(),
            "n".into(),
            vec![],
            crate::devices::Devices::load(&dir.join("devices.json")).unwrap(),
        );
        let first = pairing.start().unwrap();
        assert_eq!(pairing.take_code(&first.secret), Some(crate::devices::Capabilities::shard()));
        assert_eq!(pairing.take_code(&first.secret), None, "used once");
        let old = pairing.start().unwrap();
        let _new = pairing.start().unwrap();
        assert_eq!(pairing.take_code(&old.secret), None, "replaced");
        let short = pairing.start_for(std::time::Duration::ZERO).unwrap();
        assert_eq!(pairing.take_code(&short.secret), None, "expired");
        // A code opened with a set carries it to the device that consumes it.
        let granted = crate::devices::Capabilities::parse(&["shard", "audit"]).unwrap();
        let code = pairing.start_granting(super::CODE_LIFETIME, granted.clone()).unwrap();
        assert_eq!(pairing.take_code(&code.secret), Some(granted));
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn a_device_holds_a_bounded_number_of_sessions() {
        let dir = std::env::temp_dir().join(format!("invincible-slots-{}", std::process::id()));
        let pairing = std::sync::Arc::new(super::Pairing::new(
            crate::devices::StaticKey::load_or_create(&dir.join("node.key")).unwrap(),
            "n".into(),
            vec![],
            crate::devices::Devices::load(&dir.join("devices.json")).unwrap(),
        ));
        let slots: Vec<_> = (0..super::MAX_SESSIONS_PER_DEVICE).map(|_| pairing.session(b"k").unwrap()).collect();
        assert!(pairing.session(b"k").is_none());
        assert!(pairing.session(b"other").is_some());
        drop(slots);
        assert!(pairing.session(b"k").is_some());
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn the_door_knows_loopback_hosts() {
        for ok in ["127.0.0.1:7780", "localhost:7780", "LOCALHOST", "[::1]:7780", "127.0.0.1"] {
            assert!(super::loopback_host(ok), "{ok}");
        }
        for bad in
            ["evil.example:7780", "evil.example", "192.168.1.2:7780", "", "[fd00::1]:80", "127.0.0.1.evil.example"]
        {
            assert!(!super::loopback_host(bad), "{bad}");
        }
    }

    /// A device that puts `capabilities` in its pairing hello is granted what the code says and
    /// nothing more: the set is the operator's, recorded at pairing, never the device's ask. This
    /// runs the real handshake — a real node, a real Noise session — with a hello no client would
    /// send, because that is the only way to show the field is not read.
    #[tokio::test]
    async fn a_hello_asking_for_capabilities_gets_the_codes_set() {
        let dir = std::env::temp_dir().join(format!("invincible-ask-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap().to_string();
        let pairing = std::sync::Arc::new(super::Pairing::new(
            crate::devices::StaticKey::load_or_create(&dir.join("node.key")).unwrap(),
            "studio".into(),
            vec![addr],
            crate::devices::Devices::load(&dir.join("devices.json")).unwrap(),
        ));
        let settings = invincible_policy::NodeSettings {
            network: invincible_policy::NetworkMode::Offline,
            egress: invincible_policy::Egress::Never,
        };
        let state = std::sync::Arc::new(
            crate::server::AppState::new(Vec::new(), settings, "token".into()).with_pairing(pairing.clone()),
        );
        tokio::spawn(super::serve(listener, pairing.clone(), crate::server::device_app(state)));
        let device = crate::devices::StaticKey::load_or_create(&dir.join("device.key")).unwrap();
        let hello = serde_json::json!({
            "name": "phone",
            "capabilities": ["shard", "agent", "audit"],
        });

        // The default code grants `shard`: the device is told so, and recorded so.
        let code = super::PairingCode::decode(&pairing.start().unwrap().encode()).unwrap();
        let paired = super::pair_with_hello(&code, &device, hello.clone()).await.unwrap();
        assert_eq!(paired.capabilities.unwrap().codes(), ["shard"], "the code's grant, not the hello's ask");
        assert_eq!(paired.device, "phone");
        assert_eq!(pairing.devices.named("phone").unwrap().capabilities.codes(), ["shard"]);

        // A code that grants `agent` gives exactly that, asked for or not.
        let granted = crate::devices::Capabilities::parse(&["shard", "agent"]).unwrap();
        let code = super::PairingCode::decode(&pairing.start_granting(super::CODE_LIFETIME, granted).unwrap().encode())
            .unwrap();
        let paired = super::pair_with_hello(&code, &device, hello).await.unwrap();
        assert_eq!(paired.capabilities.unwrap().codes(), ["shard", "agent"]);
        assert_eq!(pairing.devices.named("phone").unwrap().capabilities.codes(), ["shard", "agent"]);

        // Pairing again through a code that grants less narrows the device: the code decides, so
        // re-pairing is not a way back to more.
        let code = super::PairingCode::decode(&pairing.start().unwrap().encode()).unwrap();
        let paired = super::pair_with_hello(&code, &device, serde_json::json!({ "name": "phone" })).await.unwrap();
        assert_eq!(paired.capabilities.unwrap().codes(), ["shard"]);
        assert_eq!(pairing.devices.list().len(), 1, "one key, one entry");
        assert_eq!(pairing.devices.named("phone").unwrap().capabilities.codes(), ["shard"]);
        let _ = std::fs::remove_dir_all(dir);
    }
}
