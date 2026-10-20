//! `autobot service install|status|restart|uninstall`, the real binary, against stand-in
//! service managers (launchctl, systemctl, loginctl on PATH that only keep notes) in an isolated
//! HOME: installing twice changes nothing the second time, a changed definition is reloaded,
//! status reads how a service last stopped, uninstall removes everything.

// launchd and systemd, with shell-script stand-ins.
#![cfg(unix)]

use std::path::{Path, PathBuf};
use std::process::Command;

fn temp(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("autobot-service-{name}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

fn script(path: &Path, body: &str) {
    std::fs::write(path, format!("#!/bin/sh\n{body}")).unwrap();
    use std::os::unix::fs::PermissionsExt;
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o755)).unwrap();
}

/// launchctl and systemctl that remember what is loaded in [state].
fn fakes(dir: &Path, state: &Path) {
    let log = state.join("calls");
    script(
        &dir.join("launchctl"),
        &format!(
            r#"echo "launchctl $*" >>"{log}"
s="{state}"
case "$1" in
    print) [ -f "$s/${{2##*/}}" ] && {{ echo "state = running"; echo "runs = 3"; echo "last exit code = 70"; }} ;;
    bootstrap) touch "$s/$(basename "$3" .plist)" ;;
    bootout) rm -f "$s/${{2##*/}}" ;;
    kickstart) [ -f "$s/${{3##*/}}" ] ;;
esac
"#,
            log = log.display(),
            state = state.display()
        ),
    );
    script(
        &dir.join("systemctl"),
        &format!(
            r#"echo "systemctl $*" >>"{log}"
s="{state}"
[ "$1" = --user ] && shift
case "$1" in
    is-active|is-enabled) [ -f "$s/$3" ] ;;
    enable) touch "$s/$3" ;;
    restart) touch "$s/$2" ;;
    disable) rm -f "$s/$3" ;;
    show) echo "Result=watchdog"; echo "NRestarts=2"; echo "ExecMainStatus=0" ;;
esac
"#,
            log = log.display(),
            state = state.display()
        ),
    );
    script(&dir.join("loginctl"), &format!("echo \"loginctl $*\" >>\"{}\"\n", log.display()));
}

fn autobot(bin: &Path, home: &Path, fake: &Path, args: &[&str]) -> (bool, String) {
    let out = Command::new(bin.join("autobot"))
        .args(args)
        .env_clear()
        .env("PATH", format!("{}:/usr/bin:/bin", fake.display()))
        .env("HOME", home)
        .env("USER", "tester")
        .env("INVINCIBLE_HOME", home.join("inv"))
        .env("AUTOBOT_HOME", home.join("agent"))
        .env("NO_COLOR", "1")
        .output()
        .unwrap();
    (out.status.success(), format!("{}{}", String::from_utf8_lossy(&out.stdout), String::from_utf8_lossy(&out.stderr)))
}

#[test]
fn installs_once_reloads_on_change_and_uninstalls() {
    // As root on Linux these would be system units in /etc: not for a test.
    if Command::new("id").arg("-u").output().is_ok_and(|o| String::from_utf8_lossy(&o.stdout).trim() == "0") {
        return;
    }
    let root = temp("root");
    let (home, bin, fake, state) = (root.join("home"), root.join("bin"), root.join("fake"), root.join("state"));
    for d in [&home, &bin, &fake, &state] {
        std::fs::create_dir_all(d).unwrap();
    }
    fakes(&fake, &state);
    // The binary under test, with an `invincible` beside it (as the installer leaves them).
    std::fs::copy(env!("CARGO_BIN_EXE_autobot"), bin.join("autobot")).unwrap();
    script(&bin.join("invincible"), "echo invincible 0.0.0\n");
    let calls = || std::fs::read_to_string(state.join("calls")).unwrap_or_default();
    let macos = cfg!(target_os = "macos");
    let (gateway_file, agent_file) = if macos {
        (
            home.join("Library/LaunchAgents/sh.invincible.gateway.plist"),
            home.join("Library/LaunchAgents/sh.invincible.autobot.plist"),
        )
    } else {
        (home.join(".config/systemd/user/invincible.service"), home.join(".config/systemd/user/autobot.service"))
    };

    let (ok, out) = autobot(&bin, &home, &fake, &["service", "install"]);
    assert!(ok, "{out}");
    assert!(gateway_file.is_file() && agent_file.is_file(), "{out}");
    let unit = std::fs::read_to_string(&gateway_file).unwrap();
    assert!(unit.contains(&home.join("inv").display().to_string()), "the gateway's home is passed on: {unit}");
    if macos {
        assert_eq!(calls().matches("launchctl bootstrap").count(), 2, "{}", calls());
    } else {
        assert!(calls().contains("systemctl --user daemon-reload"), "{}", calls());
        assert!(calls().contains("loginctl enable-linger tester"), "{}", calls());
    }

    // Again: nothing rewritten, nothing restarted.
    std::fs::remove_file(state.join("calls")).unwrap();
    let (ok, out) = autobot(&bin, &home, &fake, &["service", "install"]);
    assert!(ok, "{out}");
    assert!(!out.contains("wrote"), "{out}");
    assert!(
        !calls().contains("bootstrap") && !calls().contains("restart") && !calls().contains("daemon-reload"),
        "{}",
        calls()
    );

    // A changed definition is rewritten and reloaded.
    std::fs::write(&agent_file, "old").unwrap();
    std::fs::remove_file(state.join("calls")).unwrap();
    let (ok, out) = autobot(&bin, &home, &fake, &["service", "install"]);
    assert!(ok, "{out}");
    assert!(out.contains("wrote") && out.matches("wrote").count() == 1, "{out}");
    if macos {
        assert_eq!(calls().matches("launchctl bootstrap").count(), 1, "{}", calls());
    } else {
        assert!(
            calls().contains("restart autobot.service") && !calls().contains("restart invincible.service"),
            "{}",
            calls()
        );
    }

    let (ok, out) = autobot(&bin, &home, &fake, &["service", "status"]);
    assert!(ok, "{out}");
    assert!(out.contains("sh.invincible.gateway: running"), "{out}");
    assert!(
        out.contains(if macos { "last stop: exit code 70; 2 restarts" } else { "last stop: watchdog; 2 restarts" }),
        "{out}"
    );
    assert!(out.contains("sh.invincible.update: not installed"), "{out}");

    let (ok, out) = autobot(&bin, &home, &fake, &["service", "restart"]);
    assert!(ok && out.contains("restarted sh.invincible.gateway"), "{out}");

    let (ok, out) = autobot(&bin, &home, &fake, &["service", "uninstall"]);
    assert!(ok, "{out}");
    assert!(!gateway_file.exists() && !agent_file.exists(), "{out}");
    let (ok, out) = autobot(&bin, &home, &fake, &["service", "uninstall"]);
    assert!(ok && out.trim().is_empty(), "uninstalling twice is fine: {out}");
    std::fs::remove_dir_all(root).unwrap();
}
