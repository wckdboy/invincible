//! SSH signatures (`ssh-keygen -Y sign`, the SSHSIG format of OpenSSH's PROTOCOL.sshsig) made
//! with an Ed25519 key: what signs every release's `SHA256SUMS`. `invincible update` checks them
//! here, without needing `ssh-keygen`; install.sh checks the same files with `ssh-keygen -Y verify`.

use base64::Engine as _;
use base64::engine::general_purpose::STANDARD;
use ed25519_dalek::{Signature, Signer, SigningKey, VerifyingKey};
use sha2::{Digest, Sha512};

const MAGIC: &[u8] = b"SSHSIG";
const KEY_TYPE: &str = "ssh-ed25519";

/// The key's wire blob from an OpenSSH public key line (`ssh-ed25519 AAAA… [comment]`).
fn key_blob(public_key: &str) -> Result<Vec<u8>, String> {
    let mut fields = public_key.split_whitespace();
    if fields.next() != Some(KEY_TYPE) {
        return Err("the release key is not an ssh-ed25519 key".to_owned());
    }
    STANDARD.decode(fields.next().unwrap_or_default()).map_err(|e| format!("the release key: {e}"))
}

fn ed25519(blob: &[u8]) -> Result<VerifyingKey, String> {
    let mut r = Reader(blob);
    if r.string()? != KEY_TYPE.as_bytes() {
        return Err("not an ssh-ed25519 key".to_owned());
    }
    let bytes: [u8; 32] = r.string()?.try_into().map_err(|_| "an Ed25519 key is 32 bytes".to_owned())?;
    VerifyingKey::from_bytes(&bytes).map_err(|e| e.to_string())
}

struct Reader<'a>(&'a [u8]);

impl<'a> Reader<'a> {
    fn take(&mut self, n: usize) -> Result<&'a [u8], String> {
        if self.0.len() < n {
            return Err("the signature is cut short".to_owned());
        }
        let (head, rest) = self.0.split_at(n);
        self.0 = rest;
        Ok(head)
    }

    fn u32(&mut self) -> Result<u32, String> {
        let b = self.take(4)?;
        Ok(u32::from_be_bytes([b[0], b[1], b[2], b[3]]))
    }

    fn string(&mut self) -> Result<&'a [u8], String> {
        let n = self.u32()? as usize;
        self.take(n)
    }
}

fn put_string(out: &mut Vec<u8>, bytes: &[u8]) {
    out.extend_from_slice(&u32::try_from(bytes.len()).unwrap_or(u32::MAX).to_be_bytes());
    out.extend_from_slice(bytes);
}

/// What the key actually signs: the namespace, the hash algorithm and the message's hash.
fn signed_data(namespace: &str, reserved: &[u8], hash_alg: &str, message: &[u8]) -> Result<Vec<u8>, String> {
    let hash = match hash_alg {
        "sha512" => Sha512::digest(message).to_vec(),
        "sha256" => sha2::Sha256::digest(message).to_vec(),
        other => return Err(format!("unknown signature hash {other:?}")),
    };
    let mut data = MAGIC.to_vec();
    put_string(&mut data, namespace.as_bytes());
    put_string(&mut data, reserved);
    put_string(&mut data, hash_alg.as_bytes());
    put_string(&mut data, &hash);
    Ok(data)
}

/// Checks that [armored] (a `-----BEGIN SSH SIGNATURE-----` block) is [public_key]'s signature of
/// [message] in [namespace], as `ssh-keygen -Y verify -n <namespace>` does.
pub fn verify(public_key: &str, namespace: &str, message: &[u8], armored: &str) -> Result<(), String> {
    let pinned = key_blob(public_key)?;
    let body: String = armored
        .lines()
        .map(str::trim)
        .skip_while(|l| *l != "-----BEGIN SSH SIGNATURE-----")
        .skip(1)
        .take_while(|l| *l != "-----END SSH SIGNATURE-----")
        .collect();
    let blob = STANDARD.decode(body).map_err(|e| format!("not an SSH signature: {e}"))?;
    let mut r = Reader(&blob);
    if r.take(MAGIC.len())? != MAGIC {
        return Err("not an SSH signature".to_owned());
    }
    if r.u32()? != 1 {
        return Err("an SSH signature of an unknown version".to_owned());
    }
    let key = r.string()?;
    if key != pinned.as_slice() {
        return Err("signed with another key, not the release key".to_owned());
    }
    if r.string()? != namespace.as_bytes() {
        return Err(format!("not signed for {namespace:?}"));
    }
    let reserved = r.string()?;
    let hash_alg = std::str::from_utf8(r.string()?).map_err(|_| "a bad hash name".to_owned())?;
    let mut sig = Reader(r.string()?);
    if sig.string()? != KEY_TYPE.as_bytes() {
        return Err("not an Ed25519 signature".to_owned());
    }
    let bytes: [u8; 64] = sig.string()?.try_into().map_err(|_| "an Ed25519 signature is 64 bytes".to_owned())?;
    let data = signed_data(namespace, reserved, hash_alg, message)?;
    ed25519(key)?
        .verify_strict(&data, &Signature::from_bytes(&bytes))
        .map_err(|_| "the signature does not match".to_owned())
}

/// The OpenSSH public key line of the Ed25519 key with [seed].
pub fn public_key(seed: &[u8; 32]) -> String {
    let mut blob = Vec::new();
    put_string(&mut blob, KEY_TYPE.as_bytes());
    put_string(&mut blob, SigningKey::from_bytes(seed).verifying_key().as_bytes());
    format!("{KEY_TYPE} {}", STANDARD.encode(blob))
}

/// Signs [message] in [namespace] with the Ed25519 key with [seed], as `ssh-keygen -Y sign` does
/// (for tests and test releases; real releases are signed by the release workflow).
pub fn sign(seed: &[u8; 32], namespace: &str, message: &[u8]) -> String {
    let key = SigningKey::from_bytes(seed);
    let mut key_blob = Vec::new();
    put_string(&mut key_blob, KEY_TYPE.as_bytes());
    put_string(&mut key_blob, key.verifying_key().as_bytes());
    let data = signed_data(namespace, b"", "sha512", message).expect("sha512");
    let mut sig_blob = Vec::new();
    put_string(&mut sig_blob, KEY_TYPE.as_bytes());
    put_string(&mut sig_blob, &key.sign(&data).to_bytes());
    let mut blob = MAGIC.to_vec();
    blob.extend_from_slice(&1u32.to_be_bytes());
    put_string(&mut blob, &key_blob);
    put_string(&mut blob, namespace.as_bytes());
    put_string(&mut blob, b"");
    put_string(&mut blob, b"sha512");
    put_string(&mut blob, &sig_blob);
    let encoded = STANDARD.encode(blob);
    let lines: Vec<&str> =
        encoded.as_bytes().chunks(70).map(|c| std::str::from_utf8(c).expect("base64 is ASCII")).collect();
    format!("-----BEGIN SSH SIGNATURE-----\n{}\n-----END SSH SIGNATURE-----\n", lines.join("\n"))
}

#[cfg(test)]
mod tests {
    use super::{public_key, sign, verify};

    // Made with `ssh-keygen -t ed25519` and `ssh-keygen -Y sign -n invincible-release` (a test
    // key, thrown away after; only its public half is here).
    const KEY: &str = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIH4fOZfwQ25Pxb6tmQG3VibvmVAZHCpR09XXvQF8Ey9w test";
    const MESSAGE: &[u8] = b"abc123  invincible-macos-arm64.tar.gz\n";
    const SIG: &str = "-----BEGIN SSH SIGNATURE-----
U1NIU0lHAAAAAQAAADMAAAALc3NoLWVkMjU1MTkAAAAgfh85l/BDbk/Fvq2ZAbdWJu+ZUB
kcKlHT1de9AXwTL3AAAAASaW52aW5jaWJsZS1yZWxlYXNlAAAAAAAAAAZzaGE1MTIAAABT
AAAAC3NzaC1lZDI1NTE5AAAAQMc+q68tqesKcwiwYg+yjBDxmoNgr2X6k9sC6ETC/GVKnR
wk+9w3EdzTb24r8Dj+bgfLH7WKO21EY+BNx1g7sAM=
-----END SSH SIGNATURE-----
";

    #[test]
    fn verifies_what_ssh_keygen_signed() {
        verify(KEY, "invincible-release", MESSAGE, SIG).unwrap();
        assert!(verify(KEY, "invincible-release", b"abc124  invincible-macos-arm64.tar.gz\n", SIG).is_err());
        assert!(verify(KEY, "file", MESSAGE, SIG).unwrap_err().contains("not signed for"));
        let other = public_key(&[7; 32]);
        assert!(verify(&other, "invincible-release", MESSAGE, SIG).unwrap_err().contains("another key"));
        assert!(verify(KEY, "invincible-release", MESSAGE, "garbage").is_err());
        assert!(verify("ssh-rsa AAAA", "invincible-release", MESSAGE, SIG).is_err());
    }

    #[test]
    fn signs_as_ssh_keygen_does() {
        let seed = [3u8; 32];
        let sig = sign(&seed, "invincible-release", MESSAGE);
        verify(&public_key(&seed), "invincible-release", MESSAGE, &sig).unwrap();
        assert!(verify(&public_key(&seed), "invincible-release", b"other", &sig).is_err());
        // When ssh-keygen is here, it agrees.
        let dir = std::env::temp_dir().join(format!("invincible-sshsig-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("allowed"), format!("t {}\n", public_key(&seed))).unwrap();
        std::fs::write(dir.join("msg.sig"), &sig).unwrap();
        let checked = std::process::Command::new("ssh-keygen")
            .args(["-Y", "verify", "-f"])
            .arg(dir.join("allowed"))
            .args(["-I", "t", "-n", "invincible-release", "-s"])
            .arg(dir.join("msg.sig"))
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .spawn()
            .and_then(|mut child| {
                use std::io::Write;
                child.stdin.take().expect("stdin").write_all(MESSAGE)?;
                child.wait()
            });
        if let Ok(status) = checked {
            assert!(status.success(), "ssh-keygen does not accept our signature");
        }
        std::fs::remove_dir_all(dir).unwrap();
    }
}
