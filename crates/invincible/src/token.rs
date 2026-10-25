//! The local API token. Even on loopback the API needs one: any process on the machine, and any
//! web page through DNS rebinding, can reach a loopback port, but none of them can read this file.

use std::path::Path;

use axum::http::HeaderMap;
use axum::http::header::AUTHORIZATION;

use crate::fsutil;

/// Reads the token at [path], creating it (32 random bytes, hex, mode 0600) when absent.
pub fn load_or_create(path: &Path) -> Result<String, String> {
    if let Some(token) = fsutil::read_optional(path)?.filter(|t| !t.trim().is_empty()) {
        return Ok(token.trim().to_owned());
    }
    let token = hex(&random::<32>()?);
    fsutil::create_private(path, &format!("{token}\n"))?;
    Ok(token)
}

pub fn random<const N: usize>() -> Result<[u8; N], String> {
    let mut bytes = [0u8; N];
    getrandom::fill(&mut bytes).map_err(|e| format!("random bytes: {e}"))?;
    Ok(bytes)
}

pub fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// Compares in time independent of where the inputs first differ.
pub fn matches(expected: &str, given: &str) -> bool {
    expected.len() == given.len() && expected.bytes().zip(given.bytes()).fold(0u8, |acc, (a, b)| acc | (a ^ b)) == 0
}

/// Where Anthropic's SDKs (and clients built on its API) put the key.
pub const API_KEY_HEADER: &str = "x-api-key";

/// Whether [headers] carry [expected]: as `Authorization: Bearer <token>` (OpenAI's clients) or
/// `x-api-key: <token>` (Anthropic's). `Authorization` wins when it is there and `x-api-key` is
/// then not read: Anthropic's SDKs and Claude Code add `x-api-key` from `ANTHROPIC_API_KEY` next to
/// a bearer token, and that key is not ours to judge. Fail closed: the header that counts is
/// there, and every value of it is the token.
pub fn presented(expected: &str, headers: &HeaderMap) -> bool {
    let all = |values: Vec<&str>| !values.is_empty() && values.iter().fold(true, |all, v| matches(expected, v) & all);
    let bearer: Vec<&str> = headers
        .get_all(AUTHORIZATION)
        .iter()
        .map(|v| {
            // The scheme's name is case-insensitive (RFC 9110 §11.1): `bearer` is `Bearer`.
            let v = v.to_str().unwrap_or("");
            v.split_once(' ').filter(|(scheme, _)| scheme.eq_ignore_ascii_case("bearer")).map_or("", |(_, t)| t)
        })
        .collect();
    if !bearer.is_empty() {
        return all(bearer);
    }
    all(headers.get_all(API_KEY_HEADER).iter().map(|v| v.to_str().unwrap_or("")).collect())
}

#[cfg(test)]
mod tests {
    use super::{load_or_create, matches, presented};

    #[test]
    fn creates_once_then_reads() {
        let dir = std::env::temp_dir().join(format!("invincible-token-{}", std::process::id()));
        let path = dir.join("token");
        let first = load_or_create(&path).unwrap();
        assert_eq!(first.len(), 64);
        assert_eq!(load_or_create(&path).unwrap(), first);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(std::fs::metadata(&path).unwrap().permissions().mode() & 0o777, 0o600);
        }
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn compares_exactly() {
        assert!(matches("abc", "abc"));
        assert!(!matches("abc", "abd"));
        assert!(!matches("abc", "ab"));
    }

    #[test]
    fn takes_the_token_as_bearer_or_else_as_x_api_key() {
        let headers = |pairs: &[(&'static str, &str)]| {
            let mut map = axum::http::HeaderMap::new();
            for (name, value) in pairs {
                map.append(*name, value.parse().unwrap());
            }
            map
        };
        for ok in [
            &[("authorization", "Bearer abc")][..],
            &[("x-api-key", "abc")],
            &[("authorization", "Bearer abc"), ("x-api-key", "abc")],
            &[("authorization", "bearer abc")],
            &[("authorization", "BEARER abc")],
            // A bearer token wins: an SDK's own `x-api-key` next to it is not read.
            &[("authorization", "Bearer abc"), ("x-api-key", "sk-ant-someone-elses")],
        ] {
            assert!(presented("abc", &headers(ok)), "{ok:?}");
        }
        for refused in [
            &[][..],
            &[("authorization", "Bearer abd")],
            &[("authorization", "Basic abc")],
            &[("authorization", "abc")],
            &[("x-api-key", "")],
            &[("x-api-key", "Bearer abc")],
            // ... and a wrong bearer token is not rescued by a right `x-api-key`.
            &[("authorization", "Bearer abd"), ("x-api-key", "abc")],
            &[("x-api-key", "abc"), ("x-api-key", "abd")],
            &[("authorization", "Bearer abc"), ("authorization", "Bearer abd")],
        ] {
            assert!(!presented("abc", &headers(refused)), "{refused:?}");
        }
    }
}
