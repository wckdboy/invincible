//! Static keys, and the devices a node trusts (spec/pairing.md).

use std::collections::BTreeSet;
use std::path::{Path, PathBuf};
use std::sync::RwLock;

use base64::Engine as _;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::fsutil;
use crate::remote::SESSION_PATTERN;

/// An X25519 static keypair for Noise.
#[derive(Clone)]
pub struct StaticKey {
    pub private: Vec<u8>,
    pub public: Vec<u8>,
}

impl StaticKey {
    /// Reads the key at [path]; `None` when there is none. Never creates one, for code that only
    /// wants to know whether this machine has a key (a listing, say).
    pub fn load(path: &Path) -> Result<Option<Self>, String> {
        let Some(text) = fsutil::read_optional(path)? else {
            return Ok(None);
        };
        let mut lines = text.lines().map(|l| URL_SAFE_NO_PAD.decode(l.trim()));
        match (lines.next(), lines.next()) {
            (Some(Ok(private)), Some(Ok(public))) if private.len() == 32 && public.len() == 32 => {
                Ok(Some(Self { private, public }))
            }
            _ => Err(format!("{}: not a key file", path.display())),
        }
    }

    /// Reads the key at [path] (two base64url lines: private, public), creating it (mode 0600)
    /// when absent. The private key never leaves this file.
    pub fn load_or_create(path: &Path) -> Result<Self, String> {
        if let Some(key) = Self::load(path)? {
            return Ok(key);
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

/// One thing a paired device may reach over its session (spec/pairing.md, Capabilities).
///
/// The set is recorded when the device pairs, from what the pairing code granted, and changed
/// only on the operator API: nothing a device sends can add to it.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Capability {
    /// The six routes a cluster head needs of this node as a shard: models, chat completions,
    /// receipts, node, cluster/node and the link meter.
    Shard,
    /// `/v1/agent`: the Autobot proxy, which runs with this node's own token.
    Agent,
    /// `/v1/audit`: the audit log, that device's own entries only (found by `caller_key`).
    Audit,
    /// `/v1/dispatch`: choosing among the nodes the operator owns, and sending work to them.
    Dispatch,
}

impl Capability {
    /// Every capability, in the order the spec lists them (and the order a set is written in).
    pub const ALL: [Self; 4] = [Self::Shard, Self::Agent, Self::Audit, Self::Dispatch];

    pub fn code(self) -> &'static str {
        match self {
            Self::Shard => "shard",
            Self::Agent => "agent",
            Self::Audit => "audit",
            Self::Dispatch => "dispatch",
        }
    }

    /// The capability [code] names, or why it is not one.
    pub fn parse(code: &str) -> Result<Self, String> {
        Self::ALL
            .into_iter()
            .find(|capability| capability.code() == code)
            .ok_or_else(|| format!("unknown capability \"{code}\" (the set is {})", Capabilities::known()))
    }
}

/// What one paired device may reach. Recorded at pairing and kept in `devices.json`.
///
/// The default — a device that has never been granted anything, and one recorded before
/// capabilities existed — is `shard`: the least a session is for, and exactly what a session
/// could reach when the six-route allowlist was all there was.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(transparent)]
pub struct Capabilities(BTreeSet<Capability>);

impl Default for Capabilities {
    fn default() -> Self {
        Self::of([Capability::Shard])
    }
}

impl Capabilities {
    pub fn of(capabilities: impl IntoIterator<Item = Capability>) -> Self {
        Self(capabilities.into_iter().collect())
    }

    /// `shard` only: the default for a new pairing, and the reading of a `devices.json` entry
    /// written before capabilities existed ([Default]).
    pub fn shard() -> Self {
        Self::default()
    }

    /// A device pinned but granted nothing: it can open a session that reaches no route at all.
    pub fn none() -> Self {
        Self(BTreeSet::new())
    }

    pub fn contains(&self, capability: Capability) -> bool {
        self.0.contains(&capability)
    }

    pub fn is_empty(&self) -> bool {
        self.0.is_empty()
    }

    /// The codes, in spec order: `["shard", "agent"]`.
    pub fn codes(&self) -> Vec<&'static str> {
        self.0.iter().map(|capability| capability.code()).collect()
    }

    /// Every code a set may hold, for a refusal to name: `shard, agent, audit, dispatch`.
    pub fn known() -> String {
        Capability::ALL.map(Capability::code).join(", ")
    }

    pub fn parse(codes: &[&str]) -> Result<Self, String> {
        let mut set = BTreeSet::new();
        for code in codes {
            set.insert(Capability::parse(code)?);
        }
        Ok(Self(set))
    }

    /// A request body's `{"capabilities": [...]}`, refused unless every name is one.
    pub fn from_json(value: &Value) -> Result<Self, String> {
        let Some(items) = value.as_array() else {
            return Err(format!("`capabilities` is a list of names: {}", Self::known()));
        };
        let mut set = BTreeSet::new();
        for item in items {
            let Some(code) = item.as_str() else {
                return Err(format!("`capabilities` holds names, not {item}: {}", Self::known()));
            };
            set.insert(Capability::parse(code)?);
        }
        Ok(Self(set))
    }

    /// What a pairing reply said, read defensively: no field (a node from before capabilities)
    /// is `shard`, and a name this build does not know is skipped rather than failing a pairing
    /// the node has already completed.
    pub fn reported(value: Option<&Value>) -> Self {
        let Some(items) = value.and_then(Value::as_array) else {
            return Self::default();
        };
        let known: BTreeSet<Capability> =
            items.iter().filter_map(Value::as_str).filter_map(|code| Capability::parse(code).ok()).collect();
        // An empty list is a device granted nothing; a list of names we cannot read is not.
        if known.is_empty() && !items.is_empty() { Self::default() } else { Self(known) }
    }
}

/// A device that completed pairing; its key is pinned.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Device {
    pub name: String,
    /// Static public key, base64url.
    pub key: String,
    /// What it may reach (spec/pairing.md, Capabilities). Absent from a `devices.json` written
    /// before capabilities: read as `shard`, which is what such a device had.
    #[serde(default)]
    pub capabilities: Capabilities,
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

    /// The device called [name], as `devices.json` holds it.
    pub fn named(&self, name: &str) -> Option<Device> {
        self.list.read().expect("devices lock").iter().find(|d| d.name == name).cloned()
    }

    /// What the device whose key is [key] (base64url, as `devices.json` holds it) may reach;
    /// `None` when no such device is pinned.
    pub fn capabilities_of(&self, key: &str) -> Option<Capabilities> {
        self.list.read().expect("devices lock").iter().find(|d| d.key == key).map(|d| d.capabilities.clone())
    }

    /// Pins [key] under [name]; returns the name it got. A key paired before keeps one entry
    /// (renamed); a name in use by another key gets a number.
    pub fn add(&self, name: &str, key: &[u8]) -> Result<String, String> {
        self.add_with(name, key, Capabilities::default())
    }

    /// [Devices::add] with the set the pairing code granted. A key that paired before takes the
    /// new set too: pairing again through a code cannot leave a device holding more than that
    /// code granted (spec/pairing.md, Capabilities).
    pub fn add_with(&self, name: &str, key: &[u8], capabilities: Capabilities) -> Result<String, String> {
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
        list.push(Device { name: name.clone(), key, capabilities });
        self.save(&list)?;
        Ok(name)
    }

    /// Grants the device called [name] exactly [capabilities] (spec/pairing.md, Capabilities);
    /// the device as it now stands, or `None` when no device has that name.
    ///
    /// From the next request on: the gate reads this list on every device request, so a grant or
    /// a revocation needs no re-pairing. On disk first, like [Devices::remove], so what is
    /// enforced and what survives a restart are the same file.
    pub fn set_capabilities(&self, name: &str, capabilities: Capabilities) -> Result<Option<Device>, String> {
        let mut list = self.list.write().expect("devices lock");
        let Some(index) = list.iter().position(|d| d.name == name) else {
            return Ok(None);
        };
        let mut updated = list.clone();
        updated[index].capabilities = capabilities;
        self.save(&updated)?;
        *list = updated;
        Ok(Some(list[index].clone()))
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
    /// What the peer granted this machine when it joined (spec/pairing.md, Capabilities). What
    /// the peer enforces is its own `devices.json`; this is the answer it gave here, and absent
    /// from a `nodes.json` written before capabilities, which reads as `shard`.
    #[serde(default)]
    pub capabilities: Capabilities,
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
    use super::{Capabilities, Capability, Devices, StaticKey, clean_name};

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

    #[test]
    fn a_new_pairing_holds_shard_only() {
        let dir = temp("devices-default");
        let devices = Devices::load(&dir.join("devices.json")).unwrap();
        devices.add("Phone", &[1; 32]).unwrap();
        assert_eq!(devices.list()[0].capabilities, Capabilities::shard());
        let key = devices.list()[0].key.clone();
        assert_eq!(devices.capabilities_of(&key), Some(Capabilities::shard()));
        // No key at all is no device: never a set to fall back on.
        assert_eq!(devices.capabilities_of("not-a-key"), None);
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn capabilities_are_granted_revoked_and_persisted() {
        let dir = temp("devices-grant");
        let path = dir.join("devices.json");
        let devices = Devices::load(&path).unwrap();
        devices.add("Phone", &[1; 32]).unwrap();

        let granted = Capabilities::parse(&["shard", "agent"]).unwrap();
        let updated = devices.set_capabilities("Phone", granted.clone()).unwrap().expect("the device");
        assert_eq!(updated.name, "Phone");
        assert_eq!(updated.capabilities.codes(), ["shard", "agent"]);
        // From the file too, which is what survives a restart.
        assert_eq!(Devices::load(&path).unwrap().named("Phone").unwrap().capabilities, granted);

        // Revoking is the same write with a smaller set; nothing else about the device changes.
        let back = devices.set_capabilities("Phone", Capabilities::shard()).unwrap().expect("the device");
        assert_eq!(back.capabilities.codes(), ["shard"]);
        assert_eq!(back.key, updated.key);
        assert_eq!(devices.set_capabilities("Nowhere", Capabilities::shard()).unwrap(), None);
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn pairing_again_takes_the_new_codes_set() {
        let dir = temp("devices-repair");
        let devices = Devices::load(&dir.join("devices.json")).unwrap();
        devices.add_with("Phone", &[1; 32], Capabilities::parse(&["shard", "agent", "audit"]).unwrap()).unwrap();
        assert_eq!(devices.list()[0].capabilities.codes(), ["shard", "agent", "audit"]);
        // The same key pairs again through a code that grants `shard`: one entry, the code's set.
        devices.add_with("Phone", &[1; 32], Capabilities::shard()).unwrap();
        assert_eq!(devices.list().len(), 1);
        assert_eq!(devices.list()[0].capabilities.codes(), ["shard"]);
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn a_devices_json_from_before_capabilities_reads_as_shard_only() {
        let dir = temp("devices-legacy");
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("devices.json");
        // Exactly what a node wrote before capabilities existed: a name and a key.
        std::fs::write(&path, r#"[{"name":"phone","key":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"}]"#).unwrap();
        let devices = Devices::load(&path).unwrap();
        assert_eq!(devices.list().len(), 1);
        assert_eq!(devices.list()[0].capabilities, Capabilities::shard());
        assert_eq!(devices.named("phone").unwrap().capabilities.codes(), ["shard"]);
        // And it is written back with the set, so the next start reads the same thing.
        devices.set_capabilities("phone", Capabilities::shard()).unwrap().expect("the device");
        let text = std::fs::read_to_string(&path).unwrap();
        assert!(text.contains("\"capabilities\""), "{text}");
        assert!(text.contains("\"shard\""), "{text}");
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn capability_names_are_a_closed_set() {
        assert_eq!(Capability::ALL.map(Capability::code), ["shard", "agent", "audit", "dispatch"]);
        assert_eq!(Capabilities::known(), "shard, agent, audit, dispatch");
        assert_eq!(
            Capabilities::parse(&["dispatch", "shard"]).unwrap().codes(),
            ["shard", "dispatch"],
            "written in spec order, whatever order they were given in"
        );
        // A duplicate is one capability, not an error.
        assert_eq!(Capabilities::parse(&["audit", "audit"]).unwrap().codes(), ["audit"]);

        let unknown = Capability::parse("root").unwrap_err();
        assert!(unknown.contains("root") && unknown.contains("dispatch"), "{unknown}");
        for bad in [serde_json::json!("agent"), serde_json::json!(["agent", 7]), serde_json::json!(["root"])] {
            assert!(Capabilities::from_json(&bad).is_err(), "{bad}");
        }
        // A reply from a node without the field, or with names this build does not know: the
        // least, never a set invented out of a list we cannot read.
        assert_eq!(Capabilities::reported(None), Capabilities::shard());
        assert_eq!(Capabilities::reported(Some(&serde_json::json!(["shard", "teleport"]))).codes(), ["shard"]);
        assert_eq!(Capabilities::reported(Some(&serde_json::json!(["shard", "audit"]))).codes(), ["shard", "audit"]);
        assert_eq!(Capabilities::reported(Some(&serde_json::json!([]))), Capabilities::none());
        assert_eq!(Capabilities::shard().codes(), ["shard"], "the default is the least");
    }
}
