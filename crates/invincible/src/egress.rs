//! Requests that leave the node (model downloads, cloud backends). They follow the node's network
//! mode, as Autobot's kill switch does on the phone:
//! - `offline` refuses before any DNS lookup or socket;
//! - `direct` connects directly, ignoring proxy environment variables;
//! - `tor:<host>:<port>` and `socks5:<host>:<port>` go through that proxy with remote DNS
//!   (`socks5h`), so lookups do not leak outside it;
//! - HTTPS only (system trust roots); plain HTTP only to loopback hosts, and redirects are held to
//!   the same rule.

use std::time::Duration;

use invincible_policy::NetworkMode;

/// A client for this machine's own services over plain HTTP (an engine, the agent, the
/// gateway): no proxy, and no trust roots, whose loading from the system is most of a short
/// command's run (~100 ms on macOS).
pub fn local() -> reqwest::ClientBuilder {
    reqwest::Client::builder().no_proxy().tls_built_in_root_certs(false)
}

/// The client for outbound requests under [mode].
pub fn client(mode: &NetworkMode) -> Result<reqwest::Client, String> {
    let builder = reqwest::Client::builder()
        .user_agent("Invincible")
        .connect_timeout(Duration::from_secs(15))
        .redirect(reqwest::redirect::Policy::custom(|attempt| {
            if attempt.previous().len() >= 10 {
                attempt.error("too many redirects")
            } else if allowed(attempt.url()) {
                attempt.follow()
            } else {
                attempt.error("redirect to a non-HTTPS address refused")
            }
        }))
        .no_proxy();
    let builder = match mode {
        NetworkMode::Offline => return Err("the node is offline ([node] network = \"offline\")".to_owned()),
        NetworkMode::Direct => builder,
        NetworkMode::Tor { host, port } | NetworkMode::Socks5 { host, port } => {
            let proxy = reqwest::Proxy::all(format!("socks5h://{host}:{port}")).map_err(|e| e.to_string())?;
            builder.proxy(proxy)
        }
    };
    builder.build().map_err(|e| e.to_string())
}

/// HTTPS anywhere; plain HTTP to loopback only.
pub fn allowed(url: &reqwest::Url) -> bool {
    match url.scheme() {
        "https" => true,
        "http" => url.host_str().is_some_and(|host| {
            host == "localhost"
                || host
                    .trim_start_matches('[')
                    .trim_end_matches(']')
                    .parse::<std::net::IpAddr>()
                    .is_ok_and(|ip| ip.is_loopback())
        }),
        _ => false,
    }
}

/// Refuses a URL [allowed] does not accept.
pub fn check(url: &str) -> Result<reqwest::Url, String> {
    let parsed = reqwest::Url::parse(url).map_err(|e| format!("{url}: {e}"))?;
    if allowed(&parsed) { Ok(parsed) } else { Err(format!("{url}: only HTTPS (or HTTP to loopback) is allowed")) }
}

/// The route name for logs and receipts: `direct`, `tor`, `socks5`.
pub fn route(mode: &NetworkMode) -> &'static str {
    match mode {
        NetworkMode::Offline => "offline",
        NetworkMode::Direct => "direct",
        NetworkMode::Tor { .. } => "tor",
        NetworkMode::Socks5 { .. } => "socks5",
    }
}

#[cfg(test)]
mod tests {
    use super::{check, client};
    use invincible_policy::NetworkMode;

    #[test]
    fn https_anywhere_http_only_to_loopback() {
        assert!(check("https://huggingface.co/x").is_ok());
        assert!(check("http://127.0.0.1:8080/x").is_ok());
        assert!(check("http://[::1]:8080/x").is_ok());
        assert!(check("http://localhost/x").is_ok());
        assert!(check("http://huggingface.co/x").is_err());
        assert!(check("http://192.168.1.2/x").is_err());
        assert!(check("ftp://example.com/x").is_err());
        assert!(check("file:///etc/passwd").is_err());
    }

    #[test]
    fn offline_has_no_client() {
        assert!(client(&NetworkMode::Offline).is_err());
        assert!(client(&NetworkMode::Direct).is_ok());
        assert!(client(&NetworkMode::Tor { host: "127.0.0.1".into(), port: 9050 }).is_ok());
    }
}
