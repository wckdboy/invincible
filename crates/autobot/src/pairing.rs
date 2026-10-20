//! Who may talk to a bot on a platform, and who asked: `$AUTOBOT_HOME/<platform>-users.json`
//! (Hermes-style DM pairing). A stranger gets a one-time code; nobody gets in until the owner runs
//! `autobot <platform> approve <code>` on the machine. Read on every message, so an approval works
//! while the bot runs.
//!
//! Telegram keeps its own file shape (numeric ids, [crate::telegram::Users]); every other
//! platform uses [Users] here, with ids as text (a Discord snowflake, a Slack user id, an email
//! address, a phone number, a Matrix user id).

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

/// How long a pairing code works.
pub const CODE_LIFETIME: u64 = 60 * 60;
/// Live codes kept at once, so a flood of strangers cannot grow the file without bound.
const MAX_PENDING: usize = 10;

/// The platforms a bot can be reached on, as commands and addresses name them.
pub const PLATFORMS: &[&str] = &["telegram", "discord", "slack", "email", "signal", "matrix"];

#[derive(Debug, Default, Serialize, Deserialize)]
pub struct Users {
    #[serde(default)]
    pub allowed: Vec<User>,
    #[serde(default)]
    pub pending: Vec<Pending>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct User {
    pub id: String,
    pub name: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Pending {
    pub code: String,
    pub user: User,
    pub expires: u64,
}

pub fn now() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or_default()
}

impl Users {
    pub fn path(home: &Path, platform: &str) -> PathBuf {
        home.join(format!("{platform}-users.json"))
    }

    pub fn load(home: &Path, platform: &str) -> Result<Self, String> {
        let path = Self::path(home, platform);
        match invincible::fsutil::read_optional(&path)? {
            Some(text) => serde_json::from_str(&text).map_err(|e| format!("{}: {e}", path.display())),
            None => Ok(Self::default()),
        }
    }

    pub fn save(&self, home: &Path, platform: &str) -> Result<(), String> {
        let text = serde_json::to_string_pretty(self).map_err(|e| e.to_string())?;
        invincible::fsutil::replace_private(&Self::path(home, platform), &text)
    }

    pub fn allows(&self, id: &str) -> bool {
        self.allowed.iter().any(|u| u.id == id)
    }

    /// The code [user] should give the owner: their live one, or a new one.
    pub fn code_for(&mut self, user: &User) -> Result<String, String> {
        let now = now();
        self.pending.retain(|p| p.expires > now);
        if let Some(p) = self.pending.iter().find(|p| p.user.id == user.id) {
            return Ok(p.code.clone());
        }
        if self.pending.len() >= MAX_PENDING {
            self.pending.remove(0);
        }
        let code = new_code()?;
        self.pending.push(Pending { code: code.clone(), user: user.clone(), expires: now + CODE_LIFETIME });
        Ok(code)
    }

    /// Lets in the user who was given [code].
    pub fn approve(&mut self, code: &str) -> Result<User, String> {
        let wanted = normalize(code);
        let now = now();
        let at =
            self.pending.iter().position(|p| p.expires > now && normalize(&p.code) == wanted).ok_or_else(|| {
                format!("no live pairing code {code:?} (codes work for {} minutes)", CODE_LIFETIME / 60)
            })?;
        let user = self.pending.remove(at).user;
        if !self.allows(&user.id) {
            self.allowed.push(user.clone());
        }
        Ok(user)
    }

    /// Whether a live code [code] is waiting here.
    pub fn has_code(&self, code: &str) -> bool {
        let wanted = normalize(code);
        let now = now();
        self.pending.iter().any(|p| p.expires > now && normalize(&p.code) == wanted)
    }

    pub fn revoke(&mut self, id: &str) -> bool {
        let before = self.allowed.len();
        self.allowed.retain(|u| u.id != id);
        before != self.allowed.len()
    }
}

/// 8 characters from an alphabet without look-alikes (no 0/O, 1/I/L), shown as `ABCD-EFGH`.
pub fn new_code() -> Result<String, String> {
    const ALPHABET: &[u8] = b"ABCDEFGHJKMNPQRSTUVWXYZ23456789";
    let bytes = invincible::token::random::<8>()?;
    let chars: String = bytes.iter().map(|b| ALPHABET[*b as usize % ALPHABET.len()] as char).collect();
    Ok(format!("{}-{}", &chars[..4], &chars[4..]))
}

pub fn normalize(code: &str) -> String {
    code.chars().filter(char::is_ascii_alphanumeric).map(|c| c.to_ascii_uppercase()).collect()
}

/// Whether [id] may talk to the bot in [home] on [platform].
pub fn allows(home: &Path, platform: &str, id: &str) -> Result<bool, String> {
    if platform == "telegram" {
        let Ok(id) = id.parse::<i64>() else { return Ok(false) };
        return Ok(crate::telegram::Users::load(home)?.allows(id));
    }
    Ok(Users::load(home, platform)?.allows(id))
}

/// The pairing code for [user] on [platform], kept for `autobot <platform> approve`.
pub fn code_for(home: &Path, platform: &str, user: &User) -> Result<String, String> {
    if platform == "telegram" {
        let id = user.id.parse::<i64>().map_err(|_| format!("not a Telegram id: {}", user.id))?;
        let mut users = crate::telegram::Users::load(home)?;
        let code = users.code_for(&crate::telegram::User { id, name: user.name.clone() })?;
        users.save(home)?;
        return Ok(code);
    }
    let mut users = Users::load(home, platform)?;
    let code = users.code_for(user)?;
    users.save(home, platform)?;
    Ok(code)
}

/// The users allowed on [platform], as text ids.
pub fn allowed(home: &Path, platform: &str) -> Vec<User> {
    if platform == "telegram" {
        return crate::telegram::Users::load(home)
            .map(|u| u.allowed.into_iter().map(|u| User { id: u.id.to_string(), name: u.name }).collect())
            .unwrap_or_default();
    }
    Users::load(home, platform).map(|u| u.allowed).unwrap_or_default()
}

/// Approves [code] on [platform] in the first of [homes] that issued it: the home and the user.
pub fn approve_in<'a>(homes: &[&'a Path], platform: &str, code: &str) -> Result<(&'a Path, User), String> {
    for home in homes {
        if platform == "telegram" {
            let mut users = crate::telegram::Users::load(home)?;
            if users.pending.iter().any(|p| normalize(&p.code) == normalize(code) && p.expires > now()) {
                let user = users.approve(code)?;
                users.save(home)?;
                return Ok((home, User { id: user.id.to_string(), name: user.name }));
            }
            continue;
        }
        let mut users = Users::load(home, platform)?;
        if users.has_code(code) {
            let user = users.approve(code)?;
            users.save(home, platform)?;
            return Ok((home, user));
        }
    }
    Err(format!("no live pairing code {code:?} (codes work for {} minutes)", CODE_LIFETIME / 60))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn codes_pair_once() {
        let mut users = Users::default();
        let ann = User { id: "U123".into(), name: "ann".into() };
        let code = users.code_for(&ann).unwrap();
        assert_eq!(code.len(), 9);
        assert_eq!(users.code_for(&ann).unwrap(), code, "the same code until it expires");
        assert!(users.has_code(&code.to_lowercase()));
        assert!(users.approve("WRONG-CODE").is_err());
        assert_eq!(users.approve(&code.to_lowercase().replace('-', " ")).unwrap().id, "U123");
        assert!(users.allows("U123"));
        assert!(users.approve(&code).is_err(), "single use");
        assert!(users.revoke("U123"));
        assert!(!users.allows("U123"));
    }

    #[test]
    fn pending_codes_are_bounded_and_unambiguous() {
        let mut users = Users::default();
        for id in 0..50 {
            users.code_for(&User { id: id.to_string(), name: String::new() }).unwrap();
        }
        assert_eq!(users.pending.len(), MAX_PENDING);
        assert!(new_code().unwrap().chars().all(|c| c == '-' || !"01OIL".contains(c)));
    }

    #[test]
    fn approve_finds_the_bot_that_issued_the_code() {
        let base = std::env::temp_dir().join(format!("autobot-pairing-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        let (a, b) = (base.join("a"), base.join("b"));
        std::fs::create_dir_all(&a).unwrap();
        std::fs::create_dir_all(&b).unwrap();
        let code = code_for(&b, "slack", &User { id: "U9".into(), name: "ann".into() }).unwrap();
        let tg = code_for(&a, "telegram", &User { id: "42".into(), name: "@ann".into() }).unwrap();
        assert!(code_for(&a, "telegram", &User { id: "x".into(), name: String::new() }).is_err());
        let (home, user) = approve_in(&[&a, &b], "slack", &code).unwrap();
        assert_eq!((home, user.id.as_str()), (b.as_path(), "U9"));
        assert!(allows(&b, "slack", "U9").unwrap());
        assert!(!allows(&a, "slack", "U9").unwrap());
        assert!(approve_in(&[&a, &b], "slack", &code).is_err());
        let (home, user) = approve_in(&[&a, &b], "telegram", &tg).unwrap();
        assert_eq!((home, user.id.as_str()), (a.as_path(), "42"));
        assert!(allows(&a, "telegram", "42").unwrap());
        assert_eq!(allowed(&a, "telegram")[0].name, "@ann");
        std::fs::remove_dir_all(base).unwrap();
    }
}
