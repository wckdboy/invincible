//! `invincible update` end to end against a release server on loopback: signed SHA256SUMS,
//! VERSION, an archive with stand-in programs; up to date, update, check, go back, and a release
//! that is not signed with the pinned key.
// The stand-in programs are shell scripts.
#![cfg(unix)]

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};

use invincible::sshsig;
use invincible::update::{self, Installed, Outcome, Source, Target};
use invincible::version::Channel;
use sha2::{Digest, Sha256};

const SEED: [u8; 32] = [9; 32];
const PLATFORM: &str = "linux-x64";

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

fn temp(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("invincible-update-{name}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

/// A stand-in program: says its version.
fn program(path: &Path, name: &str, version: &str) {
    std::fs::write(path, format!("#!/bin/sh\necho \"{name} {version}\"\n")).unwrap();
    use std::os::unix::fs::PermissionsExt;
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o755)).unwrap();
}

/// A release of [version] in [dir], signed with [seed].
fn release(dir: &Path, version: &str, seed: &[u8; 32]) {
    std::fs::create_dir_all(dir).unwrap();
    let work = dir.join("work");
    let inner = work.join(format!("invincible-{PLATFORM}"));
    std::fs::create_dir_all(&inner).unwrap();
    for p in ["invincible", "autobot"] {
        program(&inner.join(p), p, version);
    }
    let archive = format!("invincible-{PLATFORM}.tar.gz");
    let status = std::process::Command::new("tar")
        .arg("-czf")
        .arg(dir.join(&archive))
        .arg("-C")
        .arg(&work)
        .arg(format!("invincible-{PLATFORM}"))
        .status()
        .unwrap();
    assert!(status.success());
    std::fs::remove_dir_all(&work).unwrap();
    std::fs::write(dir.join("VERSION"), format!("{version}\n")).unwrap();
    let mut sums = String::new();
    for f in [archive.as_str(), "VERSION"] {
        sums.push_str(&format!("{}  {f}\n", hex(&Sha256::digest(std::fs::read(dir.join(f)).unwrap()))));
    }
    std::fs::write(dir.join("SHA256SUMS"), &sums).unwrap();
    std::fs::write(dir.join("SHA256SUMS.sig"), sshsig::sign(seed, update::NAMESPACE, sums.as_bytes())).unwrap();
}

/// Serves [root] over HTTP on loopback; counts archive downloads.
async fn serve(root: PathBuf) -> (String, Arc<AtomicUsize>) {
    let hits = Arc::new(AtomicUsize::new(0));
    let counter = hits.clone();
    let app = axum::Router::new().fallback(move |uri: axum::http::Uri| {
        let root = root.clone();
        let counter = counter.clone();
        async move {
            let path = root.join(uri.path().trim_start_matches('/'));
            if uri.path().ends_with(".tar.gz") {
                counter.fetch_add(1, Ordering::SeqCst);
            }
            match std::fs::read(&path) {
                Ok(bytes) => (axum::http::StatusCode::OK, bytes),
                Err(_) => (axum::http::StatusCode::NOT_FOUND, Vec::new()),
            }
        }
    });
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    (format!("http://{addr}"), hits)
}

fn options<'a>(
    client: &'a reqwest::Client,
    source: &'a Source,
    target: Target,
    bin: &Path,
    home: &Path,
    current: &str,
) -> update::Options<'a> {
    update::Options {
        client,
        source,
        target,
        platform: PLATFORM,
        bin: bin.to_owned(),
        home: home.to_owned(),
        current: current.to_owned(),
        check: false,
        force: false,
    }
}

#[tokio::test]
async fn updates_checks_goes_back_and_refuses_unsigned_releases() {
    let root = temp("server");
    release(&root.join("latest/download"), "0.0.2", &SEED);
    release(&root.join("download/v0.0.1"), "0.0.1", &SEED);
    release(&root.join("download/edge"), "0.0.2-edge.abc1234", &[1; 32]); // another key
    let (url, hits) = serve(root.clone()).await;
    let source = Source { root: url, key: sshsig::public_key(&SEED) };
    let client = reqwest::Client::new();
    let bin = temp("bin");
    let home = temp("home");
    for p in ["invincible", "autobot"] {
        program(&bin.join(p), p, "0.0.1");
    }
    let stable = Target::Latest(Channel::Stable);

    // --check: says, changes nothing.
    let mut check = options(&client, &source, stable.clone(), &bin, &home, "0.0.1");
    check.check = true;
    assert_eq!(update::run(check).await.unwrap(), Outcome::Available { version: Some("0.0.2".into()) });
    assert_eq!(update::version_of(&bin.join("invincible")), "0.0.1");
    assert_eq!(hits.load(Ordering::SeqCst), 0);

    // An update: both programs swapped, the record kept, nothing left behind.
    let outcome = update::run(options(&client, &source, stable.clone(), &bin, &home, "0.0.1")).await.unwrap();
    assert_eq!(
        outcome,
        Outcome::Updated {
            from: "0.0.1".into(),
            to: "0.0.2".into(),
            changed: vec!["invincible".into(), "autobot".into()]
        }
    );
    assert_eq!(update::version_of(&bin.join("invincible")), "0.0.2");
    assert_eq!(update::version_of(&bin.join("autobot")), "0.0.2");
    let record = Installed::load(&home);
    assert_eq!(record.get("version"), Some("0.0.2"));
    assert_eq!(record.get("channel"), Some("stable"));
    assert_eq!(record.get("autobot_sha256"), update::sha256_file(&bin.join("autobot")).as_deref());
    let mut left: Vec<_> = std::fs::read_dir(&bin).unwrap().map(|e| e.unwrap().file_name()).collect();
    left.sort();
    assert_eq!(left, ["autobot", "invincible"]);
    assert_eq!(std::fs::read_dir(home.join("cache")).unwrap().count(), 0);
    assert_eq!(hits.load(Ordering::SeqCst), 1);

    // Again: up to date, no download.
    let again = update::run(options(&client, &source, stable.clone(), &bin, &home, "0.0.2")).await.unwrap();
    assert_eq!(again, Outcome::UpToDate { version: "0.0.2".into(), ahead: false });
    assert_eq!(hits.load(Ordering::SeqCst), 1);

    // Newer than the channel: kept.
    let ahead = update::run(options(&client, &source, stable.clone(), &bin, &home, "0.0.3")).await.unwrap();
    assert_eq!(ahead, Outcome::UpToDate { version: "0.0.3".into(), ahead: true });

    // Back to 0.0.1 by version.
    let back =
        update::run(options(&client, &source, Target::Version("0.0.1".into()), &bin, &home, "0.0.2")).await.unwrap();
    assert!(matches!(back, Outcome::Updated { ref to, .. } if to == "0.0.1"), "{back:?}");
    assert_eq!(update::version_of(&bin.join("invincible")), "0.0.1");

    // The edge release is signed with another key: refused, nothing replaced.
    let err =
        update::run(options(&client, &source, Target::Latest(Channel::Edge), &bin, &home, "0.0.1")).await.unwrap_err();
    assert!(err.contains("not signed with the Invincible release key"), "{err}");
    assert_eq!(update::version_of(&bin.join("invincible")), "0.0.1");

    // No such version.
    let err = update::run(options(&client, &source, Target::Version("9.9.9".into()), &bin, &home, "0.0.1"))
        .await
        .unwrap_err();
    assert!(err.contains("no release for v9.9.9"), "{err}");

    // A release whose archive is not what SHA256SUMS says: refused.
    let tampered = root.join("latest/download").join(format!("invincible-{PLATFORM}.tar.gz"));
    let mut bytes = std::fs::read(&tampered).unwrap();
    bytes.push(0);
    std::fs::write(&tampered, bytes).unwrap();
    let err = update::run(options(&client, &source, stable, &bin, &home, "0.0.1")).await.unwrap_err();
    assert!(err.contains("SHA-256"), "{err}");
    assert_eq!(update::version_of(&bin.join("invincible")), "0.0.1");

    for dir in [root, bin, home] {
        std::fs::remove_dir_all(dir).unwrap();
    }
}
