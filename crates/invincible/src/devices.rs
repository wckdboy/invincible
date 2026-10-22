//! Static keys, and the devices a node trusts (spec/pairing.md).

use std::path::{Path, PathBuf};
use std::sync::RwLock;

use base64::Engine as _;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use serde::{Deserialize, Serialize};

use crate::fsutil;
use crate::remote::SESSION_PATTERN;

/// An X25519 static keypair for Noise.
#[derive(Clone)]
pub struct StaticKey {
    pub private: Vec<u8>,
    pub public: Vec<u8>,
}

impl StaticKey {
    /// Reads the key at [path] (two base64url lines: private, public), creating it (mode 0600)
    /// when absent. The private key never leaves this file.
    pub fn load_or_create(path: &Path) -> Result<Self, String> {
        if let Some(text) = fsutil::read_optional(path)? {
            let mut lines = text.lines().map(|l| URL_SAFE_NO_PAD.decode(l.trim()));
            return match (lines.next(), lines.next()) {
                (Some(Ok(private)), Some(Ok(public))) if private.len() == 32 && public.len() == 32 => {
                    Ok(Self { private, public })
                }
                _ => Err(format!("{}: not a key file", path.display())),
            };
        }
        let params = SESSION_PATTERN.parse().expect("Noise pattern");
        let pair = snow::Builder::new(params).generate_keypair().map_err(|e| format!("key generation: {e}"))?;
        let text = format!("{}\n{}\n", URL_SAFE_NO_PAD.encode(&pair.private), URL_SAFE_NO_PAD.encode(&pair.public));
        fsutil::create_private(path, &text)?;
        Ok(Self { private: pair.private, public: pair.public })
    }
}

impl std::fmt::Debug for StaticKey {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "StaticKey({})", fingerprint(&self.public))
    }
}

/// A short, readable form of a public key for people to compare: the first 8 bytes in hex groups.
pub fn fingerprint(public: &[u8]) -> String {
    public
        .iter()
        .take(8)
        .map(|b| format!("{b:02x}"))
        .collect::<Vec<_>>()
        .chunks(2)
        .map(|c| c.concat())
        .collect::<Vec<_>>()
        .join("-")
}

/// A device that completed pairing; its key is pinned.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Device {
    pub name: String,
    /// Static public key, base64url.
    pub key: String,
}

/// The pinned devices, persisted in `devices.json`.
pub struct Devices {
    path: PathBuf,
    list: RwLock<Vec<Device>>,
}

impl Devices {
    pub fn load(path: &Path) -> Result<Self, String> {
        let list = match fsutil::read_optional(path)? {
            Some(text) => serde_json::from_str(&text).map_err(|e| format!("{}: {e}", path.display()))?,
            None => Vec::new(),
        };
        Ok(Self { path: path.to_owned(), list: RwLock::new(list) })
    }

    pub fn list(&self) -> Vec<Device> {
        self.list.read().expect("devices lock").clone()
    }

    pub fn is_pinned(&self, key: &[u8]) -> bool {
        let key = URL_SAFE_NO_PAD.encode(key);
        self.list.read().expect("devices lock").iter().any(|d| d.key == key)
    }

    /// The name [key] is pinned under.
    pub fn name_of(&self, key: &[u8]) -> Option<String> {
        let key = URL_SAFE_NO_PAD.encode(key);
        self.list.read().expect("devices lock").iter().find(|d| d.key == key).map(|d| d.name.clone())
    }

    /// Pins [key] under [name]; returns the name it got. A key paired before keeps one entry
    /// (renamed); a name in use by another key gets a number.
    pub fn add(&self, name: &str, key: &[u8]) -> Result<String, String> {
        let key = URL_SAFE_NO_PAD.encode(key);
        let mut list = self.list.write().expect("devices lock");
        list.retain(|d| d.key != key);
        let base = clean_name(name);
        let mut name = base.clone();
        let mut n = 2;
        while list.iter().any(|d| d.name == name) {
            name = format!("{base}-{n}");
            n += 1;
        }
        list.push(Device { name: name.clone(), key });
        self.save(&list)?;
        Ok(name)
    }

    /// Unpins the device called [name]; false when there is none.
    pub fn remove(&self, name: &str) -> Result<bool, String> {
        let mut list = self.list.write().expect("devices lock");
        let kept: Vec<Device> = list.iter().filter(|d| d.name != name).cloned().collect();
        if kept.len() == list.len() {
            return Ok(false);
        }
        // On disk first: if that fails, the device stays paired here too, rather than coming back
        // at the next start.
        self.save(&kept)?;
        *list = kept;
        Ok(true)
    }

    fn save(&self, list: &[Device]) -> Result<(), String> {
        fsutil::replace_private(&self.path, &serde_json::to_string_pretty(list).expect("devices serialise"))
    }
}

/// Nodes this machine paired with as a device (`nodes.json`): for the tunnel, and as the peers
/// a cluster model may be split across (spec/cluster.md).
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct KnownNodes(pub Vec<KnownNode>);

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct KnownNode {
    pub name: String,
    /// Static public key, base64url, pinned at pairing.
    pub key: String,
    pub addrs: Vec<String>,
    /// The node's receipt key, pinned at pairing.
    #[serde(default)]
    pub receipt_key: Option<String>,
    /// The name this node is listed under *on that node* (what its `[cluster] heads` must
    /// contain). Learned at join and kept, because it is the one string a person cannot see
    /// from here, and the reason two correct configs can still disagree.
    #[serde(default)]
    pub device: Option<String>,
}

impl KnownNode {
    /// The pinned static key, decoded.
    pub fn key_bytes(&self) -> Result<Vec<u8>, String> {
        URL_SAFE_NO_PAD.decode(&self.key).map_err(|e| format!("node {}: {e}", self.name))
    }
}

impl KnownNodes {
    pub fn load(home: &Path) -> Result<Self, String> {
        let path = home.join("nodes.json");
        match fsutil::read_optional(&path)? {
            Some(text) => serde_json::from_str(&text).map_err(|e| format!("{}: {e}", path.display())),
            None => Ok(Self::default()),
        }
    }

    pub fn save(&self, home: &Path) -> Result<(), String> {
        fsutil::replace_private(&home.join("nodes.json"), &serde_json::to_string_pretty(self).expect("nodes serialise"))
    }
}

/// Up to 40 ASCII letters, digits, `-` and `_` (no look-alike letters); anything else becomes `-`.
fn clean_name(name: &str) -> String {
    let cleaned: String = name
        .trim()
        .chars()
        .take(40)
        .map(|c| if c.is_ascii_alphanumeric() || c == '-' || c == '_' { c } else { '-' })
        .collect();
    let cleaned = cleaned.trim_matches('-').to_owned();
    if cleaned.is_empty() { "device".to_owned() } else { cleaned }
}

#[cfg(test)]
mod tests {
    use super::{Devices, StaticKey, clean_name};

    fn temp(name: &str) -> std::path::PathBuf {
        std::env::temp_dir().join(format!("invincible-{name}-{}", std::process::id()))
    }

    #[test]
    fn keys_are_created_once() {
        let dir = temp("keys");
        let first = StaticKey::load_or_create(&dir.join("node.key")).unwrap();
        let again = StaticKey::load_or_create(&dir.join("node.key")).unwrap();
        assert_eq!(first.public, again.public);
        assert_eq!(first.private, again.private);
        assert_eq!(first.public.len(), 32);
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn devices_pin_rename_and_remove() {
        let dir = temp("devices");
        let path = dir.join("devices.json");
        let devices = Devices::load(&path).unwrap();
        assert_eq!(devices.add("Phone", &[1; 32]).unwrap(), "Phone");
        assert_eq!(devices.add("Phone", &[2; 32]).unwrap(), "Phone-2");
        assert!(devices.is_pinned(&[1; 32]));
        // The same key pairing again keeps one entry.
        assert_eq!(devices.add("Pixel", &[1; 32]).unwrap(), "Pixel");
        assert_eq!(devices.list().len(), 2);
        assert!(devices.remove("Pixel").unwrap());
        assert!(!devices.is_pinned(&[1; 32]));
        assert!(!devices.remove("Pixel").unwrap());
        // Persisted.
        assert_eq!(Devices::load(&path).unwrap().list(), devices.list());
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn names_are_cleaned() {
        assert_eq!(clean_name("  my phone!  "), "my-phone");
        assert_eq!(clean_name("../../etc"), "etc");
        assert_eq!(clean_name("***"), "device");
    }
}
