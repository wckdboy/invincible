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
/// The first byte on a connection, in the clear (and bound into the handshake by the prologue).
pub const MODE_PAIR: u8 = 1;
pub const MODE_SESSION: u8 = 2;

const MAX_FRAME: usize = 65535;
const TAG: usize = 16;
const MAX_PLAIN: usize = MAX_FRAME - TAG;
const HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(10);
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
}

struct Pending {
    secret: [u8; 32],
    expires: Instant,
    failures: u32,
}

impl Pairing {
    pub fn new(key: StaticKey, name: String, advertise: Vec<String>, devices: Devices) -> Self {
        Self { key, name, advertise, devices, receipt_key: String::new(), pending: Mutex::new(None) }
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

    fn close_code(&self, secret: &[u8; 32]) {
        let mut pending = self.pending.lock().expect("pending lock");
        if pending.as_ref().is_some_and(|p| &p.secret == secret) {
            *pending = None;
        }
    }
}

/// Accepts remote connections on [listener] and serves [app] to paired devices.
pub async fn serve(listener: TcpListener, pairing: Arc<Pairing>, app: Router) {
    loop {
        let Ok((tcp, peer)) = listener.accept().await else { continue };
        let (pairing, app) = (pairing.clone(), app.clone());
        tokio::spawn(async move {
            if let Err(e) = accept(tcp, pairing, app).await {
                tracing::info!(%peer, "remote connection refused: {e}");
            }
        });
    }
}

async fn accept(mut tcp: TcpStream, pairing: Arc<Pairing>, app: Router) -> Result<(), String> {
    let _ = tcp.set_nodelay(true);
    let (transport, device_key) = timeout(HANDSHAKE_TIMEOUT, respond(&mut tcp, &pairing))
        .await
        .map_err(|_| "handshake timed out".to_owned())??;

    let (ours, theirs) = tokio::io::duplex(MAX_FRAME);
    // Requests on this session are the device's (for the audit log).
    let name = pairing.devices.name_of(&device_key).unwrap_or_else(|| crate::devices::fingerprint(&device_key));
    let app = app.layer(axum::Extension(crate::audit::Caller::Device(name)));
    let service = hyper_util::service::TowerToHyperService::new(app);
    tokio::spawn(async move {
        let _ = hyper::server::conn::http1::Builder::new()
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
            let hello: serde_json::Value = serde_json::from_slice(&payload[..n.min(MAX_HANDSHAKE_PAYLOAD)])
                .map_err(|_| "pairing hello is not JSON".to_owned())?;
            let device_key = hs.get_remote_static().ok_or("no device key")?.to_vec();
            let name = pairing.devices.add(hello["name"].as_str().unwrap_or("device"), &device_key)?;
            pairing.close_code(&secret);
            let reply = json!({ "node": pairing.name, "device": name, "receipts": pairing.receipt_key }).to_string();
            let m = hs.write_message(reply.as_bytes(), &mut out).map_err(|e| e.to_string())?;
            write_frame(tcp, &out[..m]).await.map_err(|e| e.to_string())?;
            tracing::info!(device = %name, key = %crate::devices::fingerprint(&device_key), "device paired");
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

/// Serves a plain-HTTP door on [listener] (loopback) that leads to the node: each local
/// connection becomes one encrypted session.
pub async fn tunnel(listener: TcpListener, addrs: Vec<String>, node_key: Vec<u8>, device: StaticKey) {
    let (addrs, node_key) = (Arc::new(addrs), Arc::new(node_key));
    loop {
        let Ok((local, _)) = listener.accept().await else { continue };
        let (addrs, node_key, device) = (addrs.clone(), node_key.clone(), device.clone());
        tokio::spawn(async move {
            match connect(&addrs, &node_key, &device).await {
                Ok((tcp, transport)) => pipe(tcp, transport, local, || true).await,
                Err(e) => tracing::warn!("tunnel: {e}"),
            }
        });
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
}
