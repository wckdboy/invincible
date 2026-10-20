//! Versions and release channels.
//!
//! - **stable**: the tagged releases (`v0.0.12`), version `0.0.12`.
//! - **edge**: every commit on main that passed CI, published as the moving prerelease `edge`,
//!   version `0.0.12-edge.<short sha>` (the workspace version, then the commit).
//!
//! The release workflow sets `INVINCIBLE_BUILD_VERSION` for edge builds; without it a binary is
//! the workspace version.

use std::cmp::Ordering;
use std::fmt;

/// This build's version, as `--version` prints it.
pub const VERSION: &str = match option_env!("INVINCIBLE_BUILD_VERSION") {
    Some(v) => v,
    None => env!("CARGO_PKG_VERSION"),
};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Channel {
    Stable,
    Edge,
}

impl Channel {
    pub fn parse(text: &str) -> Result<Self, String> {
        match text {
            "stable" => Ok(Self::Stable),
            "edge" => Ok(Self::Edge),
            other => Err(format!("{other:?}: the channel is stable or edge")),
        }
    }

    pub fn name(self) -> &'static str {
        match self {
            Self::Stable => "stable",
            Self::Edge => "edge",
        }
    }
}

impl fmt::Display for Channel {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.name())
    }
}

/// `major.minor.patch[-pre]`, compared as SemVer does (a prerelease comes before its release).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Version {
    pub major: u64,
    pub minor: u64,
    pub patch: u64,
    pub pre: Option<String>,
}

impl Version {
    /// Parses `0.0.12`, `v0.0.12`, `0.0.12-edge.1a2b3c4` (build metadata after `+` is ignored).
    pub fn parse(text: &str) -> Result<Self, String> {
        let bad = || format!("{text:?} is not a version (major.minor.patch)");
        let text = text.trim();
        let core = text.strip_prefix('v').unwrap_or(text);
        let core = core.split('+').next().unwrap_or(core);
        let (core, pre) = match core.split_once('-') {
            Some((core, pre)) if !pre.is_empty() => (core, Some(pre.to_owned())),
            Some(_) => return Err(bad()),
            None => (core, None),
        };
        let mut parts = core.split('.').map(|p| p.parse::<u64>().map_err(|_| bad()));
        let version = Self {
            major: parts.next().ok_or_else(bad)??,
            minor: parts.next().ok_or_else(bad)??,
            patch: parts.next().ok_or_else(bad)??,
            pre,
        };
        if parts.next().is_some() {
            return Err(bad());
        }
        Ok(version)
    }

    /// The channel a build of this version came from.
    pub fn channel(&self) -> Channel {
        if self.pre.as_deref().is_some_and(|p| p == "edge" || p.starts_with("edge.")) {
            Channel::Edge
        } else {
            Channel::Stable
        }
    }
}

impl fmt::Display for Version {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}.{}.{}", self.major, self.minor, self.patch)?;
        if let Some(pre) = &self.pre {
            write!(f, "-{pre}")?;
        }
        Ok(())
    }
}

impl PartialOrd for Version {
    fn partial_cmp(&self, other: &Self) -> Option<Ordering> {
        Some(self.cmp(other))
    }
}

impl Ord for Version {
    fn cmp(&self, other: &Self) -> Ordering {
        (self.major, self.minor, self.patch).cmp(&(other.major, other.minor, other.patch)).then_with(|| {
            match (&self.pre, &other.pre) {
                (None, None) => Ordering::Equal,
                (None, Some(_)) => Ordering::Greater,
                (Some(_), None) => Ordering::Less,
                (Some(a), Some(b)) => compare_pre(a, b),
            }
        })
    }
}

/// SemVer's rule: dot-separated identifiers, numbers numerically and before words.
fn compare_pre(a: &str, b: &str) -> Ordering {
    let mut a = a.split('.');
    let mut b = b.split('.');
    loop {
        match (a.next(), b.next()) {
            (None, None) => return Ordering::Equal,
            (None, Some(_)) => return Ordering::Less,
            (Some(_), None) => return Ordering::Greater,
            (Some(x), Some(y)) => {
                let order = match (x.parse::<u64>(), y.parse::<u64>()) {
                    (Ok(x), Ok(y)) => x.cmp(&y),
                    (Ok(_), Err(_)) => Ordering::Less,
                    (Err(_), Ok(_)) => Ordering::Greater,
                    (Err(_), Err(_)) => x.cmp(y),
                };
                if order != Ordering::Equal {
                    return order;
                }
            }
        }
    }
}

/// What to do about the latest release of a channel, given the version installed.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Decision {
    /// The same version: nothing to do.
    UpToDate,
    /// A stable release newer than the channel's latest is installed (built from source, or a
    /// release pulled back): it is kept.
    Ahead,
    /// Install the channel's latest.
    Update,
}

/// Whether to move from [current] to [latest], the newest build of [channel].
///
/// Edge builds of one base version are not ordered (a commit hash is not a number), so on the
/// edge channel any other build is the one to take. On stable, a newer stable install is never
/// replaced by an older release; an edge install switching to stable takes the release.
pub fn decide(current: &str, latest: &str, channel: Channel) -> Decision {
    if current.trim() == latest.trim() {
        return Decision::UpToDate;
    }
    match (Version::parse(current), Version::parse(latest)) {
        (Ok(current), Ok(latest)) if current == latest => Decision::UpToDate,
        (Ok(current), Ok(latest))
            if channel == Channel::Stable && current.channel() == Channel::Stable && current > latest =>
        {
            Decision::Ahead
        }
        _ => Decision::Update,
    }
}

#[cfg(test)]
mod tests {
    use super::{Channel, Decision, Version, decide};

    #[test]
    fn parses_and_prints() {
        let v = Version::parse("v0.0.12").unwrap();
        assert_eq!((v.major, v.minor, v.patch, v.pre.as_deref()), (0, 0, 12, None));
        assert_eq!(v.to_string(), "0.0.12");
        let e = Version::parse("0.0.12-edge.1a2b3c4").unwrap();
        assert_eq!(e.to_string(), "0.0.12-edge.1a2b3c4");
        assert_eq!(e.channel(), Channel::Edge);
        assert_eq!(v.channel(), Channel::Stable);
        assert_eq!(Version::parse("1.2.3+build.5").unwrap().to_string(), "1.2.3");
        for bad in ["", "1", "1.2", "1.2.x", "1.2.3.4", "1.2.3-", "edge"] {
            assert!(Version::parse(bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn orders_like_semver() {
        let order =
            ["0.0.9", "0.0.12-alpha", "0.0.12-alpha.1", "0.0.12-alpha.beta", "0.0.12-edge.2", "0.0.12", "0.1.0"];
        for pair in order.windows(2) {
            let (a, b) = (Version::parse(pair[0]).unwrap(), Version::parse(pair[1]).unwrap());
            assert!(a < b, "{a} < {b}");
        }
        assert!(Version::parse("0.0.10").unwrap() > Version::parse("0.0.9").unwrap());
    }

    #[test]
    fn decides_what_to_install() {
        use Channel::{Edge, Stable};
        assert_eq!(decide("0.0.12", "0.0.12", Stable), Decision::UpToDate);
        assert_eq!(decide("0.0.11", "0.0.12", Stable), Decision::Update);
        assert_eq!(decide("0.0.13", "0.0.12", Stable), Decision::Ahead);
        // Off edge onto stable: the release, even though the edge build sorts after it.
        assert_eq!(decide("0.0.12-edge.abc1234", "0.0.12", Stable), Decision::Update);
        assert_eq!(decide("0.0.13-edge.abc1234", "0.0.12", Stable), Decision::Update);
        // On edge any other build is newer: the hash says nothing about order.
        assert_eq!(decide("0.0.12-edge.abc1234", "0.0.12-edge.def5678", Edge), Decision::Update);
        assert_eq!(decide("0.0.12-edge.abc1234", "0.0.12-edge.abc1234", Edge), Decision::UpToDate);
        assert_eq!(decide("0.0.12", "0.0.12-edge.abc1234", Edge), Decision::Update);
        assert_eq!(decide("unknown", "0.0.12", Stable), Decision::Update);
    }
}
