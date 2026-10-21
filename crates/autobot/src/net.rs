//! Connections the agent's channels open themselves (websockets, IMAP, SMTP), under Invincible
//! Gateway's network mode: direct, through Tor or a SOCKS5 proxy (host names resolved by the
//! proxy, so lookups stay inside Tor), and never when the node is offline.

use std::sync::Arc;

use invincible_policy::NetworkMode;

pub type Socket = tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>;

/// Whether [host] is this machine.
pub fn loopback(host: &str) -> bool {
    host == "localhost" || host.trim_matches(['[', ']']).parse::<std::net::IpAddr>().is_ok_and(|ip| ip.is_loopback())
}

/// How long opening a connection may take, the proxy's handshake included (a Tor circuit can
/// take tens of seconds); and then its TLS or websocket handshake. A server that accepts and never
/// speaks, or a lost SYN, is an error the channel retries, not a channel stuck for good.
const CONNECT_WAIT: std::time::Duration = std::time::Duration::from_secs(60);
const HANDSHAKE_WAIT: std::time::Duration = std::time::Duration::from_secs(30);

/// A TCP connection to [host]:[port] under [network]. This machine is reached directly.
pub async fn tcp(host: &str, port: u16, network: &NetworkMode) -> Result<tokio::net::TcpStream, String> {
    tokio::time::timeout(CONNECT_WAIT, tcp_now(host, port, network))
        .await
        .map_err(|_| format!("{host}:{port}: no connection in {} seconds", CONNECT_WAIT.as_secs()))?
}

async fn tcp_now(host: &str, port: u16, network: &NetworkMode) -> Result<tokio::net::TcpStream, String> {
    if loopback(host) {
        return tokio::net::TcpStream::connect((host.trim_matches(['[', ']']), port))
            .await
            .map_err(|e| format!("{host}:{port}: {e}"));
    }
    match network {
        NetworkMode::Offline => Err("the node is offline ([node] network = \"offline\")".to_owned()),
        NetworkMode::Direct => {
            tokio::net::TcpStream::connect((host, port)).await.map_err(|e| format!("{host}:{port}: {e}"))
        }
        NetworkMode::Tor { host: proxy, port: proxy_port } | NetworkMode::Socks5 { host: proxy, port: proxy_port } => {
            let mut stream = tokio::net::TcpStream::connect((proxy.as_str(), *proxy_port))
                .await
                .map_err(|e| format!("the proxy {proxy}:{proxy_port}: {e}"))?;
            socks5_connect(&mut stream, host, port).await?;
            Ok(stream)
        }
    }
}

/// Opens the websocket at [url] under [network]: `wss://`, or `ws://` to this machine.
pub async fn websocket(url: &str, network: &NetworkMode) -> Result<Socket, String> {
    let parsed = reqwest::Url::parse(url).map_err(|e| format!("{url}: {e}"))?;
    let host = parsed.host_str().ok_or("the websocket address has no host")?.to_owned();
    let port = parsed.port_or_known_default().unwrap_or(443);
    match parsed.scheme() {
        "wss" => {}
        "ws" if loopback(&host) => {}
        _ => return Err(format!("{host}: only wss:// (or ws:// to this machine) is allowed")),
    }
    let stream = tcp(&host, port, network).await?;
    let (socket, _) = tokio::time::timeout(HANDSHAKE_WAIT, tokio_tungstenite::client_async_tls(url, stream))
        .await
        .map_err(|_| format!("{host}: no websocket handshake in {} seconds", HANDSHAKE_WAIT.as_secs()))?
        .map_err(|e| format!("{host}: {e}"))?;
    Ok(socket)
}

/// A SOCKS5 CONNECT to [host] (resolved by the proxy).
pub async fn socks5_connect(stream: &mut tokio::net::TcpStream, host: &str, port: u16) -> Result<(), String> {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let fail = |e: std::io::Error| format!("SOCKS5: {e}");
    stream.write_all(&[5, 1, 0]).await.map_err(fail)?;
    let mut reply = [0u8; 2];
    stream.read_exact(&mut reply).await.map_err(fail)?;
    if reply != [5, 0] {
        return Err("SOCKS5: the proxy wants a login".to_owned());
    }
    let name = host.as_bytes();
    if name.len() > 255 {
        return Err("SOCKS5: host name too long".to_owned());
    }
    let mut request = vec![5, 1, 0, 3, name.len() as u8];
    request.extend_from_slice(name);
    request.extend_from_slice(&port.to_be_bytes());
    stream.write_all(&request).await.map_err(fail)?;
    let mut head = [0u8; 4];
    stream.read_exact(&mut head).await.map_err(fail)?;
    if head[1] != 0 {
        return Err(format!("SOCKS5: the proxy could not connect (code {})", head[1]));
    }
    let rest = match head[3] {
        1 => 4,
        4 => 16,
        3 => {
            let mut len = [0u8; 1];
            stream.read_exact(&mut len).await.map_err(fail)?;
            usize::from(len[0])
        }
        other => return Err(format!("SOCKS5: unknown address type {other}")),
    };
    let mut skip = vec![0u8; rest + 2];
    stream.read_exact(&mut skip).await.map_err(fail)?;
    Ok(())
}

pub type Tls = tokio_rustls::client::TlsStream<tokio::net::TcpStream>;

/// TLS over [stream] to [host], checked against the system's trust roots.
pub async fn tls(stream: tokio::net::TcpStream, host: &str) -> Result<Tls, String> {
    let config = client_config()?;
    let name =
        tokio_rustls::rustls::pki_types::ServerName::try_from(host.to_owned()).map_err(|e| format!("{host}: {e}"))?;
    tokio::time::timeout(HANDSHAKE_WAIT, tokio_rustls::TlsConnector::from(config).connect(name, stream))
        .await
        .map_err(|_| format!("{host}: no TLS handshake in {} seconds", HANDSHAKE_WAIT.as_secs()))?
        .map_err(|e| format!("{host}: TLS: {e}"))
}

fn client_config() -> Result<Arc<tokio_rustls::rustls::ClientConfig>, String> {
    static CONFIG: std::sync::OnceLock<Result<Arc<tokio_rustls::rustls::ClientConfig>, String>> =
        std::sync::OnceLock::new();
    CONFIG
        .get_or_init(|| {
            let mut roots = tokio_rustls::rustls::RootCertStore::empty();
            let found = rustls_native_certs::load_native_certs();
            for cert in found.certs {
                let _ = roots.add(cert);
            }
            if roots.is_empty() {
                return Err("no trusted certificates on this system".to_owned());
            }
            let provider = Arc::new(tokio_rustls::rustls::crypto::ring::default_provider());
            let config = tokio_rustls::rustls::ClientConfig::builder_with_provider(provider)
                .with_safe_default_protocol_versions()
                .map_err(|e| e.to_string())?
                .with_root_certificates(roots)
                .with_no_client_auth();
            Ok(Arc::new(config))
        })
        .clone()
}

#[cfg(test)]
mod tests {
    #[test]
    fn loopback_hosts() {
        assert!(super::loopback("localhost"));
        assert!(super::loopback("127.0.0.1"));
        assert!(super::loopback("[::1]"));
        assert!(!super::loopback("example.com"));
        assert!(!super::loopback("10.0.0.1"));
    }

    #[tokio::test]
    async fn offline_means_no_connection() {
        let offline = invincible_policy::NetworkMode::Offline;
        assert!(super::tcp("example.com", 993, &offline).await.unwrap_err().contains("offline"));
        assert!(super::websocket("ws://example.com/x", &invincible_policy::NetworkMode::Direct).await.is_err());
    }

    /// A server that takes the connection and never answers: the handshake gives up, and the
    /// channel's reconnect loop gets to run again.
    #[tokio::test(start_paused = true)]
    async fn a_server_that_never_speaks_is_given_up_on() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let held = tokio::spawn(async move {
            let mut kept = Vec::new();
            while let Ok((stream, _)) = listener.accept().await {
                kept.push(stream);
            }
        });
        let direct = invincible_policy::NetworkMode::Direct;
        let error = super::websocket(&format!("ws://127.0.0.1:{port}/x"), &direct).await.unwrap_err();
        assert!(error.contains("no websocket handshake in 30 seconds"), "{error}");
        let stream = super::tcp("127.0.0.1", port, &direct).await.unwrap();
        let error = super::tls(stream, "localhost").await.unwrap_err();
        assert!(error.contains("no TLS handshake"), "{error}");
        held.abort();
    }
}
