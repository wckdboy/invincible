//! Provider and object-store secrets. They live in mode-0600 files. A log line, an error
//! returned to a client, and a session record never contain them.

use std::path::{Path, PathBuf};

/// Replaces every [secret] that is long enough to be a key. Short strings are left alone so a
/// scrub cannot eat ordinary words.
pub fn scrub(text: &str, secrets: &[String]) -> String {
    let mut out = text.to_owned();
    for secret in secrets {
        let secret = secret.trim();
        if secret.len() >= 8 {
            out = out.replace(secret, "[redacted]");
        }
    }
    out
}

/// [path] when it is absolute, otherwise under [home].
pub fn resolve(home: &Path, path: &Path) -> PathBuf {
    if path.is_absolute() { path.to_owned() } else { home.join(path) }
}

/// Reads a one-line secret. Refuses a symlink and, on Unix, a file other people can read.
/// The error names the path and the problem. It does not include the file.
pub fn read_secret(path: &Path) -> Result<String, String> {
    let meta = std::fs::symlink_metadata(path).map_err(|e| format!("{}: {e}", path.display()))?;
    if meta.file_type().is_symlink() {
        return Err(format!("{} is a symlink; refusing to read a secret through one", path.display()));
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mode = meta.permissions().mode() & 0o777;
        if mode & 0o077 != 0 {
            return Err(format!("{} is mode {mode:o}; a secret file must be mode 0600", path.display()));
        }
    }
    let text = std::fs::read_to_string(path).map_err(|e| format!("{}: {e}", path.display()))?;
    let text = text.trim();
    if text.is_empty() || text.lines().count() != 1 {
        return Err(format!("{} must be one non-empty line", path.display()));
    }
    Ok(text.to_owned())
}

/// Whether [endpoint] may be used with [regions] as the node's ceiling.
///
/// An EU ceiling allows a loopback endpoint (a test, or a tunnel that terminates here) and a
/// Cloudflare R2 EU-jurisdiction host (`*.eu.r2.cloudflarestorage.com`). Anything else can place
/// project data outside the region the owner required.
pub fn endpoint_allowed(endpoint: &str, regions: &[String]) -> Result<(), String> {
    let url = reqwest::Url::parse(endpoint).map_err(|e| format!("[rent.store] endpoint: {e}"))?;
    let host = url.host_str().unwrap_or("");
    let loopback = host == "localhost" || host.parse::<std::net::IpAddr>().is_ok_and(|ip| ip.is_loopback());
    if !loopback && url.scheme() != "https" {
        return Err(format!("[rent.store] endpoint {endpoint}: https, or a loopback address"));
    }
    if unconstrained(regions) || loopback {
        return Ok(());
    }
    let eu = regions.iter().any(|token| {
        let token = token.strip_suffix("-secure").unwrap_or(token).trim();
        token == "EU" || token.starts_with("EU-") || token.starts_with("EU_")
    });
    if eu && !host.ends_with(".eu.r2.cloudflarestorage.com") {
        return Err(format!(
            "[rent.store] endpoint {host}: an EU ceiling needs a Cloudflare R2 EU-jurisdiction host (*.eu.r2.cloudflarestorage.com)"
        ));
    }
    Ok(())
}

fn unconstrained(regions: &[String]) -> bool {
    regions.is_empty() || regions.iter().any(|token| token == "any" || token == "*")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn scrub_replaces_keys_and_leaves_short_tokens() {
        assert_eq!(scrub("key sekret-value in sekret-value", &["sekret-value".into()]), "key [redacted] in [redacted]");
        assert_eq!(scrub("eu stays", &["eu".into()]), "eu stays");
    }

    #[test]
    fn an_eu_ceiling_accepts_the_eu_r2_host_and_refuses_the_default_one() {
        let eu = ["EU".to_owned()];
        assert!(endpoint_allowed("https://abc.eu.r2.cloudflarestorage.com", &eu).is_ok());
        assert!(endpoint_allowed("http://127.0.0.1:9", &eu).is_ok());
        let err = endpoint_allowed("https://abc.r2.cloudflarestorage.com", &eu).unwrap_err();
        assert!(err.contains("EU"), "{err}");
        assert!(endpoint_allowed("https://abc.r2.cloudflarestorage.com", &["any".into()]).is_ok());
    }
}
