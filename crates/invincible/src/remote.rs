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

use crate::devices::{Devices, StaticKey};

/// `psk1`, not `psk2`: the secret must be mixed in by the end of the *first* message, so the node
/// can tell a device that knows the code from one that does not before pinning anything. With
/// `psk2` the node would read the first message, and pin the key, without any proof.
pub const PAIR_PATTERN: &str = "Noise_IKpsk1_25519_ChaChaPoly_SHA256";
pub const SESSION_PATTERN: &str = "Noise_IK_25519_ChaChaPoly_SHA256";
const PAIR_PROLOGUE: &[u8] = b"invincible/0 pair";
const SESSION_PROLOGUE: &[u8] = b"invincible/0 session";
const SHARD_PROLOGUE: &[u8] = b"invincible/0 shard";
/// The first byte on a connection, in the clear (and bound into the handshake by the prologue).
pub const MODE_PAIR: u8 = 1;
pub const MODE_SESSION: u8 = 2;
/// A shard link (spec/cluster.md): the same handshake as a session, but the stream inside is the
/// node's own `ggml-rpc-server` on loopback, for a device the node lets use it as a shard.
pub const MODE_SHARD: u8 = 3;

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
pub async fn pipe<P>(
    tcp: TcpStream,
    transport: TransportState,
    plain: P,
    allowed: impl Fn() -> bool + Send + Sync + 'static,
) where
    P: AsyncRead + AsyncWrite + Unpin + Send + 'static,
{
    pipe_counted(tcp, transport, plain, allowed, None).await;
}

/// Plaintext bytes through a pipe, each way: `sent` to the peer, `received` from it.
#[derive(Debug, Default)]
pub struct Traffic {
    pub sent: std::sync::atomic::AtomicU64,
    pub received: std::sync::atomic::AtomicU64,
}

impl Traffic {
    /// (sent, received) so far.
    pub fn get(&self) -> (u64, u64) {
        use std::sync::atomic::Ordering::Relaxed;
        (self.sent.load(Relaxed), self.received.load(Relaxed))
    }
}

/// [pipe], counting the plaintext each way in [traffic].
pub async fn pipe_counted<P>(
    tcp: TcpStream,
    transport: TransportState,
    plain: P,
    allowed: impl Fn() -> bool + Send + Sync + 'static,
    traffic: Option<Arc<Traffic>>,
) where
    P: AsyncRead + AsyncWrite + Unpin + Send + 'static,
{
    use std::sync::atomic::Ordering::Relaxed;
    // Each direction is its own task, so a bulk transfer (weights to a shard) encrypts on one
    // core while the other decrypts; the transport is locked only for one message at a time.
    let transport = Arc::new(Mutex::new(transport));
    let allowed = Arc::new(allowed);
    let (tcp_read, mut tcp_write) = tcp.into_split();
    let mut tcp_read = tokio::io::BufReader::with_capacity(2 * MAX_FRAME, tcp_read);
    let (mut plain_read, mut plain_write) = tokio::io::split(plain);

    let outbound = {
        let (transport, allowed, traffic) = (transport.clone(), allowed.clone(), traffic.clone());
        tokio::spawn(async move {
            let mut plain = vec![0u8; MAX_PLAIN];
            // The length, then the message: one write per frame.
            let mut out = vec![0u8; 2 + MAX_FRAME];
            loop {
                let n = match plain_read.read(&mut plain).await {
                    Ok(0) | Err(_) => break,
                    Ok(n) => n,
                };
                // An unpaired device gets nothing more, not even the rest of a stream.
                if !allowed() {
                    break;
                }
                let Ok(m) = transport.lock().expect("transport lock").write_message(&plain[..n], &mut out[2..]) else {
                    break;
                };
                out[..2].copy_from_slice(&(m as u16).to_be_bytes());
                if tcp_write.write_all(&out[..2 + m]).await.is_err() {
                    break;
                }
                if let Some(t) = &traffic {
                    t.sent.fetch_add(n as u64, Relaxed);
                }
            }
            let _ = tcp_write.shutdown().await;
        })
    };
    let inbound = async {
        let mut frame = vec![0u8; MAX_FRAME];
        let mut buf = vec![0u8; MAX_FRAME];
        loop {
            let len = match tcp_read.read_u16().await {
                Ok(len) => len as usize,
                Err(e) if e.kind() == std::io::ErrorKind::UnexpectedEof => break Inbound::Eof,
                Err(_) => break Inbound::Abort,
            };
            if tcp_read.read_exact(&mut frame[..len]).await.is_err() {
                break Inbound::Abort;
            }
            if !allowed() {
                break Inbound::Abort;
            }
            let Ok(n) = transport.lock().expect("transport lock").read_message(&frame[..len], &mut buf) else {
                break Inbound::Abort;
            };
            if let Some(t) = &traffic {
                t.received.fetch_add(n as u64, Relaxed);
            }
            if plain_write.write_all(&buf[..n]).await.is_err() {
                break Inbound::Abort;
            }
        }
    };

    let mut outbound = outbound;
    tokio::select! {
        how = inbound => match how {
            Inbound::Eof => {
                let _ = plain_write.shutdown().await;
                let _ = (&mut outbound).await;
            }
            Inbound::Abort => outbound.abort(),
        },
        _ = &mut outbound => {}
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
    /// This node as a shard for others: where its `ggml-rpc-server` listens, and who may use it.
    pub shard: Option<ShardService>,
}

/// The node's `ggml-rpc-server` on loopback, and the paired devices (by name) that may reach it
/// through a shard link. Nobody else can: not other paired devices, not the network.
#[derive(Clone, Debug)]
pub struct ShardService {
    pub port: u16,
    pub heads: Vec<String>,
    /// Bytes through shard links, for `GET /v1/cluster`.
    pub traffic: Arc<Traffic>,
}

struct Pending {
    secret: [u8; 32],
    expires: Instant,
    failures: u32,
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
            shard: None,
        }
    }

    /// Serves [shard] to the devices it names (spec/cluster.md).
    pub fn with_shard(mut self, shard: ShardService) -> Self {
        self.shard = Some(shard);
        self
    }

    /// Whether the device with [key] may use this node as a shard: paired, and named in `heads`.
    pub fn may_shard(&self, key: &[u8]) -> bool {
        match (&self.shard, self.devices.name_of(key)) {
            (Some(shard), Some(name)) => shard.heads.contains(&name),
            _ => false,
        }
    }

    pub fn with_receipt_key(mut self, public: String) -> Self {
        self.receipt_key = public;
        self
    }

    /// Opens a pairing code (replacing any open one), valid for [CODE_LIFETIME] and one pairing.
    pub fn start(&self) -> Result<PairingCode, String> {
        self.start_for(CODE_LIFETIME)
    }

    /// [Pairing::start] with another lifetime.
    pub fn start_for(&self, lifetime: Duration) -> Result<PairingCode, String> {
        let secret = crate::token::random::<32>()?;
        *self.pending.lock().expect("pending lock") =
            Some(Pending { secret, expires: Instant::now() + lifetime, failures: 0 });
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

    /// Uses up the code [secret] once its handshake succeeded: true for exactly one caller, and
    /// only while it is still the open, unexpired code (two handshakes racing on one code, or a
    /// code replaced or burned meanwhile, pin nothing).
    fn take_code(&self, secret: &[u8; 32]) -> bool {
        let mut pending = self.pending.lock().expect("pending lock");
        let open = pending.as_ref().is_some_and(|p| &p.secret == secret && Instant::now() < p.expires);
        if open {
            *pending = None;
        }
        open
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
    let (transport, device_key, mode) = timeout(HANDSHAKE_TIMEOUT, respond(&mut tcp, &pairing))
        .await
        .map_err(|_| "handshake timed out".to_owned())??;
    drop(permit);
    let _slot = pairing.session(&device_key).ok_or("too many open sessions for this device")?;
    if mode == MODE_SHARD {
        let shard = pairing.shard.clone().ok_or("this node is not a shard")?;
        let rpc = TcpStream::connect(("127.0.0.1", shard.port)).await.map_err(|e| format!("ggml-rpc-server: {e}"))?;
        let _ = rpc.set_nodelay(true);
        let name = pairing.devices.name_of(&device_key).unwrap_or_default();
        tracing::info!(head = %name, "shard link open");
        let check = pairing.clone();
        // Unpairing the head, or taking it out of `heads`, cuts the link at the next frame.
        pipe_counted(tcp, transport, rpc, move || check.may_shard(&device_key), Some(shard.traffic)).await;
        tracing::info!(head = %name, "shard link closed");
        return Ok(());
    }

    let (ours, theirs) = tokio::io::duplex(MAX_FRAME);
    // Requests on this session are the device's (for the audit log).
    let name = pairing.devices.name_of(&device_key).unwrap_or_else(|| crate::devices::fingerprint(&device_key));
    let app = app.layer(axum::Extension(crate::audit::Caller::Device(name)));
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
async fn respond(tcp: &mut TcpStream, pairing: &Pairing) -> Result<(TransportState, Vec<u8>, u8), String> {
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
            if !pairing.take_code(&secret) {
                return Err("the pairing code was used, replaced or expired meanwhile".to_owned());
            }
            let name = pairing.devices.add(hello["name"].as_str().unwrap_or("device"), &device_key)?;
            let reply = json!({ "node": pairing.name, "device": name, "receipts": pairing.receipt_key }).to_string();
            let m = hs.write_message(reply.as_bytes(), &mut out).map_err(|e| e.to_string())?;
            write_frame(tcp, &out[..m]).await.map_err(|e| e.to_string())?;
            tracing::info!(device = %name, key = %crate::devices::fingerprint(&device_key), "device paired");
            Ok((hs.into_transport_mode().map_err(|e| e.to_string())?, device_key, MODE_SESSION))
        }
        MODE_SESSION | MODE_SHARD => {
            let prologue = if mode == MODE_SHARD { SHARD_PROLOGUE } else { SESSION_PROLOGUE };
            let mut hs = responder(SESSION_PATTERN, &pairing.key, prologue, None)?;
            let first = read_frame(tcp).await.map_err(|e| e.to_string())?;
            hs.read_message(&first, &mut payload).map_err(|e| format!("session handshake failed: {e}"))?;
            let device_key = hs.get_remote_static().ok_or("no device key")?.to_vec();
            if !pairing.devices.is_pinned(&device_key) {
                return Err(format!("device {} is not paired", crate::devices::fingerprint(&device_key)));
            }
            // Refused before the node answers: a device that may not shard learns nothing more.
            if mode == MODE_SHARD && !pairing.may_shard(&device_key) {
                return Err(format!(
                    "device {} may not use this node as a shard ([cluster] heads)",
                    crate::devices::fingerprint(&device_key)
                ));
            }
            let m = hs.write_message(&[], &mut out).map_err(|e| e.to_string())?;
            write_frame(tcp, &out[..m]).await.map_err(|e| e.to_string())?;
            Ok((hs.into_transport_mode().map_err(|e| e.to_string())?, device_key, mode))
        }
        other => Err(format!("unknown mode {other}")),
    }
}

// ---------------------------------------------------------------------------------------------
// Client side

/// What pairing told the device: the node's name and the name it pinned the device under.
#[derive(Debug)]
pub struct Paired {
    pub node: String,
    pub device: String,
    /// The node's receipt key, received over the authenticated channel; pin it.
    pub receipt_key: Option<String>,
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
    let mut tcp = dial(&code.addrs).await?;
    let work = async {
        let mut hs = initiator(PAIR_PATTERN, device, &code.node_key, PAIR_PROLOGUE, Some(&code.secret))?;
        let mut out = vec![0u8; MAX_FRAME];
        let hello = json!({ "name": name }).to_string();
        let m = hs.write_message(hello.as_bytes(), &mut out).map_err(|e| e.to_string())?;
        tcp.write_u8(MODE_PAIR).await.map_err(|e| e.to_string())?;
        write_frame(&mut tcp, &out[..m]).await.map_err(|e| e.to_string())?;
        let reply = read_frame(&mut tcp).await.map_err(|_| "the node refused pairing (code wrong, used or expired)")?;
        let mut payload = vec![0u8; MAX_FRAME];
        let n = hs.read_message(&reply, &mut payload).map_err(|e| format!("pairing handshake failed: {e}"))?;
        let reply: serde_json::Value = serde_json::from_slice(&payload[..n]).map_err(|e| e.to_string())?;
        Ok(Paired {
            node: reply["node"].as_str().unwrap_or("node").to_owned(),
            device: reply["device"].as_str().unwrap_or(name).to_owned(),
            receipt_key: reply["receipts"].as_str().filter(|k| !k.is_empty()).map(str::to_owned),
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
    open(addrs, node_key, device, MODE_SESSION).await
}

/// Opens a shard link to a node that lets this device use it as a shard (spec/cluster.md).
pub async fn connect_shard(
    addrs: &[String],
    node_key: &[u8],
    device: &StaticKey,
) -> Result<(TcpStream, TransportState), String> {
    open(addrs, node_key, device, MODE_SHARD).await
}

async fn open(
    addrs: &[String],
    node_key: &[u8],
    device: &StaticKey,
    mode: u8,
) -> Result<(TcpStream, TransportState), String> {
    let mut tcp = dial(addrs).await?;
    let prologue = if mode == MODE_SHARD { SHARD_PROLOGUE } else { SESSION_PROLOGUE };
    let work = async {
        let mut hs = initiator(SESSION_PATTERN, device, node_key, prologue, None)?;
        let mut out = vec![0u8; MAX_FRAME];
        let m = hs.write_message(&[], &mut out).map_err(|e| e.to_string())?;
        tcp.write_u8(mode).await.map_err(|e| e.to_string())?;
        write_frame(&mut tcp, &out[..m]).await.map_err(|e| e.to_string())?;
        let reply = read_frame(&mut tcp).await.map_err(|_| "the node refused the session (device not paired?)")?;
        let mut payload = vec![0u8; MAX_FRAME];
        hs.read_message(&reply, &mut payload).map_err(|e| format!("session handshake failed: {e}"))?;
        hs.into_transport_mode().map_err(|e| e.to_string())
    };
    let transport = timeout(HANDSHAKE_TIMEOUT, work).await.map_err(|_| "session handshake timed out".to_owned())??;
    Ok((tcp, transport))
}

/// `GET [path]` on a paired node's API, through one encrypted session; the answer's JSON.
pub async fn get_json(
    addrs: &[String],
    node_key: &[u8],
    device: &StaticKey,
    path: &str,
) -> Result<serde_json::Value, String> {
    let (tcp, transport) = connect(addrs, node_key, device).await?;
    let (ours, theirs) = tokio::io::duplex(MAX_FRAME);
    tokio::spawn(async move { pipe(tcp, transport, theirs, || true).await });
    let (mut sender, connection) =
        hyper::client::conn::http1::handshake(hyper_util::rt::TokioIo::new(ours)).await.map_err(|e| e.to_string())?;
    tokio::spawn(connection);
    let request = axum::http::Request::get(path)
        .header(axum::http::header::HOST, "node")
        .body(axum::body::Body::empty())
        .map_err(|e| e.to_string())?;
    let response = sender.send_request(request).await.map_err(|e| e.to_string())?;
    let status = response.status();
    let body =
        axum::body::to_bytes(axum::body::Body::new(response.into_body()), 1 << 20).await.map_err(|e| e.to_string())?;
    if !status.is_success() {
        return Err(format!("{path}: {status}"));
    }
    serde_json::from_slice(&body).map_err(|e| format!("{path}: {e}"))
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
        assert!(pairing.take_code(&first.secret));
        assert!(!pairing.take_code(&first.secret), "used once");
        let old = pairing.start().unwrap();
        let _new = pairing.start().unwrap();
        assert!(!pairing.take_code(&old.secret), "replaced");
        let short = pairing.start_for(std::time::Duration::ZERO).unwrap();
        assert!(!pairing.take_code(&short.secret), "expired");
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
}
