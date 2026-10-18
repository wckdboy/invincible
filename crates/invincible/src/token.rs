//! The local API token. Even on loopback the API needs one: any process on the machine, and any
//! web page through DNS rebinding, can reach a loopback port, but none of them can read this file.

use std::path::Path;

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

#[cfg(test)]
mod tests {
    use super::{load_or_create, matches};

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
}
