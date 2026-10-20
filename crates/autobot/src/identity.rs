//! Linked identities: the same person on several platforms (`telegram:123`, `slack:U456`,
//! `email:me@example.com`), kept in `$AUTOBOT_HOME/identities.json` for every bot of this machine.
//!
//! A direct conversation with a linked identity is one conversation, whichever platform it is
//! on: start it on Telegram, go on in Slack. Linking does not let anyone in: each platform still
//! pairs its accounts (`autobot <platform> approve`). The person named `owner` is the owner: only
//! they use owner commands (`/bots`, `/model <id>`, `/sethome`) once someone is linked as owner;
//! before that, every approved user counts as the owner, as with one person and one bot.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

#[derive(Debug, Default, Serialize, Deserialize)]
pub struct Identities {
    #[serde(default)]
    pub people: Vec<Person>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Person {
    pub name: String,
    /// `platform:id`, as [check] makes them.
    pub ids: Vec<String>,
}

/// The name of the person who owns the machine.
pub const OWNER: &str = "owner";

/// [id] as `platform:id` with a known platform and a plain id (an email address in lower case);
/// an error saying what is wrong otherwise.
pub fn check(id: &str) -> Result<String, String> {
    let (platform, rest) =
        id.trim().split_once(':').ok_or_else(|| format!("{id:?}: write platform:id, like telegram:123456"))?;
    let platform = platform.to_ascii_lowercase();
    if !crate::pairing::PLATFORMS.contains(&platform.as_str()) {
        return Err(format!("{id:?}: the platform is one of {}", crate::pairing::PLATFORMS.join(", ")));
    }
    let rest = rest.trim();
    if rest.is_empty() || rest.chars().any(char::is_whitespace) || rest.len() > 200 {
        return Err(format!("{id:?}: no id after the platform"));
    }
    let rest = if platform == "email" { rest.to_ascii_lowercase() } else { rest.to_owned() };
    Ok(format!("{platform}:{rest}"))
}

/// A person's name: letters, digits, `-` and `_`, at most 32.
pub fn valid_name(name: &str) -> bool {
    (1..=32).contains(&name.len()) && name.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

impl Identities {
    pub fn path(root: &Path) -> PathBuf {
        root.join("identities.json")
    }

    pub fn load(root: &Path) -> Result<Self, String> {
        let path = Self::path(root);
        match invincible::fsutil::read_optional(&path)? {
            Some(text) => serde_json::from_str(&text).map_err(|e| format!("{}: {e}", path.display())),
            None => Ok(Self::default()),
        }
    }

    pub fn save(&self, root: &Path) -> Result<(), String> {
        let text = serde_json::to_string_pretty(self).map_err(|e| e.to_string())?;
        invincible::fsutil::replace_private(&Self::path(root), &text)
    }

    /// Links [ids] as one person: [name], or the person one of them already belongs to, or
    /// `owner` for the first person linked. Persons that held some of them are merged into it.
    pub fn link(&mut self, ids: &[String], name: Option<&str>) -> Result<String, String> {
        if ids.len() < 2 && name.is_none() {
            return Err("link at least two ids (or one, with --name)".to_owned());
        }
        let ids: Vec<String> = ids.iter().map(|i| check(i)).collect::<Result<_, _>>()?;
        if let Some(name) = name
            && !valid_name(name)
        {
            return Err(format!("{name:?}: a name is letters, digits, - and _"));
        }
        let holders: Vec<String> =
            self.people.iter().filter(|p| p.ids.iter().any(|i| ids.contains(i))).map(|p| p.name.clone()).collect();
        let name = match name {
            Some(name) => name.to_owned(),
            None => holders.first().cloned().unwrap_or_else(|| {
                if self.people.is_empty() { OWNER.to_owned() } else { format!("person{}", self.people.len() + 1) }
            }),
        };
        let mut merged: Vec<String> = Vec::new();
        self.people.retain(|p| {
            if p.name == name || holders.contains(&p.name) {
                merged.extend(p.ids.iter().cloned());
                false
            } else {
                true
            }
        });
        for id in ids {
            if !merged.contains(&id) {
                merged.push(id);
            }
        }
        self.people.push(Person { name: name.clone(), ids: merged });
        self.people.sort_by(|a, b| (a.name != OWNER, &a.name).cmp(&(b.name != OWNER, &b.name)));
        Ok(name)
    }

    /// Takes [id] out of whoever it was linked to; whether it was linked.
    pub fn unlink(&mut self, id: &str) -> Result<bool, String> {
        let id = check(id)?;
        let mut found = false;
        for person in &mut self.people {
            let before = person.ids.len();
            person.ids.retain(|i| *i != id);
            found |= before != person.ids.len();
        }
        self.people.retain(|p| !p.ids.is_empty());
        Ok(found)
    }

    /// Who [id] (`platform:id`) is linked as.
    pub fn person(&self, id: &str) -> Option<&Person> {
        let id = check(id).ok()?;
        self.people.iter().find(|p| p.ids.contains(&id))
    }

    /// Whether [id] is the owner: linked as `owner`, or anyone approved while nobody is.
    pub fn is_owner(&self, id: &str) -> bool {
        match self.people.iter().find(|p| p.name == OWNER) {
            Some(owner) => check(id).is_ok_and(|id| owner.ids.contains(&id)),
            None => true,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ids_are_checked() {
        assert_eq!(check("telegram:123").unwrap(), "telegram:123");
        assert_eq!(check("Email:Me@Example.com").unwrap(), "email:me@example.com");
        assert_eq!(check("slack:U456").unwrap(), "slack:U456");
        for bad in ["123", "fax:1", "slack:", "slack:a b"] {
            assert!(check(bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn linking_merges_people_and_the_first_is_the_owner() {
        let mut ids = Identities::default();
        assert!(ids.is_owner("telegram:1"), "nobody linked: every approved user counts");
        let name = ids.link(&["telegram:1".into(), "slack:U1".into()], None).unwrap();
        assert_eq!(name, "owner");
        assert!(ids.is_owner("slack:U1"));
        assert!(!ids.is_owner("slack:U2"));
        assert_eq!(ids.link(&["slack:U2".into(), "email:b@x.org".into()], None).unwrap(), "person2");
        // One id of each: the two become one person, the owner (listed first).
        assert_eq!(ids.link(&["email:b@x.org".into(), "telegram:1".into()], None).unwrap(), "owner");
        assert_eq!(ids.people.len(), 1);
        assert_eq!(ids.person("slack:U2").unwrap().name, "owner");
        assert!(ids.link(&["telegram:1".into()], None).is_err());
        assert_eq!(ids.link(&["signal:+100".into()], Some("owner")).unwrap(), "owner");
        assert_eq!(ids.people[0].name, "owner", "the owner first");
        assert!(ids.unlink("signal:+100").unwrap());
        assert!(!ids.unlink("signal:+100").unwrap());
        assert_eq!(ids.people.len(), 1, "an empty person is gone");
    }
}
