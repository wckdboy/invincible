#!/bin/sh
# The installer, end to end, against a fake release server on loopback: fake signed releases (a
# test key made here), stand-in programs, an isolated HOME, prefix and data, and stand-ins for
# launchctl/systemctl/loginctl/sudo on PATH so no real service is touched.
#
#   sh tests/install/test.sh
#
# Fresh install, the same again (nothing downloaded), set up with services, an upgrade (services
# restarted once), again (not restarted), going back with --version, edge, a broken partial
# download, two runs at once, a stale lock, a release signed with another key, uninstall (data
# kept), uninstall --purge.
set -eu

ROOT=$(cd "$(dirname "$0")/../.." && pwd)
INSTALL="$ROOT/install.sh"
T=$(mktemp -d "${TMPDIR:-/tmp}/invincible-install-test.XXXXXX")
SERVER=""
cleanup() {
    if [ -n "$SERVER" ]; then kill "$SERVER" 2>/dev/null || true; wait "$SERVER" 2>/dev/null || true; fi
    rm -rf "$T"
}
trap cleanup EXIT

fail() { printf 'FAIL: %s\n' "$*" >&2; [ -f "$T/out" ] && sed 's/^/  | /' "$T/out" >&2; exit 1; }
pass() { printf 'ok   %s\n' "$*"; }
contains() { grep -q -- "$2" "$1" || fail "$3: expected \"$2\""; }
lacks() { if grep -q -- "$2" "$1"; then fail "$3: did not expect \"$2\""; fi; }

case "$(uname -s)/$(uname -m)" in
    Darwin/arm64) PLATFORM=macos-arm64 ;;
    Linux/x86_64) PLATFORM=linux-x64 ;;
    Linux/aarch64) PLATFORM=linux-arm64 ;;
    *) echo "skip: no releases for this platform"; exit 0 ;;
esac
if command -v sha256sum >/dev/null 2>&1; then SHA="sha256sum"; else SHA="shasum -a 256"; fi

# --- An isolated machine -----------------------------------------------------------------------
unset INVINCIBLE_BIN INVINCIBLE_FROM_SOURCE INVINCIBLE_REF INVINCIBLE_RELEASE_URL INVINCIBLE_SETUP \
    INVINCIBLE_YES INVINCIBLE_NO_SETUP XDG_CONFIG_HOME
export HOME="$T/home"
export INVINCIBLE_HOME="$T/data/invincible"
export AUTOBOT_HOME="$T/data/autobot"
export CARGO_HOME="$T/cargo" RUSTUP_HOME="$T/rustup"
export FAKE_LOG="$T/calls"
export NO_COLOR=1
PREFIX="$T/prefix"
mkdir -p "$HOME" "$T/fake" "$T/releases"
: >"$FAKE_LOG"

# Service managers and sudo that only record what they were asked; llama-server and bwrap so the
# installer has nothing to fetch from upstream.
for tool in launchctl systemctl loginctl sudo; do
    # shellcheck disable=SC2016 # expanded when the stand-in runs
    printf '#!/bin/sh\necho "%s $*" >>"$FAKE_LOG"\nexit 1\n' "$tool" >"$T/fake/$tool"
done
for tool in llama-server bwrap; do printf '#!/bin/sh\nexit 0\n' >"$T/fake/$tool"; done
# No GitHub CLI: attestations are for real releases.
printf '#!/bin/sh\nexit 1\n' >"$T/fake/gh"
chmod +x "$T/fake"/*
export PATH="$T/fake:$PATH"

if [ "$(uname -s)" = Darwin ]; then
    SERVICE_FILE="$HOME/Library/LaunchAgents/sh.invincible.gateway.plist"
elif [ "$(id -u)" = 0 ]; then
    SERVICE_FILE="/etc/systemd/system/invincible.service"
else
    SERVICE_FILE="$HOME/.config/systemd/user/invincible.service"
fi

# --- Fake releases -----------------------------------------------------------------------------
ssh-keygen -q -t ed25519 -N '' -C test -f "$T/key"
ssh-keygen -q -t ed25519 -N '' -C other -f "$T/other"
export INVINCIBLE_RELEASE_KEY
INVINCIBLE_RELEASE_KEY=$(cut -d' ' -f1,2 "$T/key.pub")

# release <dir> <version> [key]: an archive with stand-in programs, VERSION, signed SHA256SUMS.
release() {
    dir="$T/releases/$1"
    rm -rf "$dir" && mkdir -p "$dir/pkg/invincible-$PLATFORM"
    cat >"$dir/pkg/invincible-$PLATFORM/invincible" <<EOF
#!/bin/sh
[ "\${1:-}" = --version ] && { echo "invincible $2"; exit 0; }
echo "invincible $2 \$*" >>"\$FAKE_LOG"
EOF
    cat >"$dir/pkg/invincible-$PLATFORM/autobot" <<EOF
#!/bin/sh
[ "\${1:-}" = --version ] && { echo "autobot $2"; exit 0; }
echo "autobot $2 \$*" >>"\$FAKE_LOG"
case "\$1 \${2:-}" in
    "service install") mkdir -p "$(dirname "$SERVICE_FILE")" && touch "$SERVICE_FILE" ;;
    "service uninstall") rm -f "$SERVICE_FILE" ;;
    "service status") [ -f "$SERVICE_FILE" ] && printf 'sh.invincible.gateway: running (enabled)\nsh.invincible.autobot: running (enabled)\n' ;;
esac
exit 0
EOF
    chmod +x "$dir/pkg/invincible-$PLATFORM"/*
    (cd "$dir/pkg" && tar -cf - "invincible-$PLATFORM" | gzip -n >"../invincible-$PLATFORM.tar.gz")
    rm -rf "$dir/pkg"
    echo "$2" >"$dir/VERSION"
    (cd "$dir" && $SHA "invincible-$PLATFORM.tar.gz" VERSION >SHA256SUMS)
    ssh-keygen -Y sign -q -f "$T/${3:-key}" -n invincible-release "$dir/SHA256SUMS"
}
release download/v0.0.1 0.0.1
release download/v0.0.2 0.0.2
release download/v0.0.3 0.0.3 other
release download/edge 0.0.3-edge.abc1234
mkdir -p "$T/releases/latest" && cp -R "$T/releases/download/v0.0.1" "$T/releases/latest/download"

# --- The server --------------------------------------------------------------------------------
PORT=""
for p in 7851 7852 7853 7854 7855 7856 7857 7858; do
    if ! curl -s "http://127.0.0.1:$p/" >/dev/null 2>&1; then PORT=$p; break; fi
done
[ -n "$PORT" ] || fail "no free port in 7851-7858"
python3 -m http.server "$PORT" --bind 127.0.0.1 --directory "$T/releases" >"$T/server.log" 2>&1 &
SERVER=$!
for _ in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20; do
    curl -sf "http://127.0.0.1:$PORT/download/v0.0.1/VERSION" >/dev/null 2>&1 && break
    sleep 0.25
done
export INVINCIBLE_RELEASES="http://127.0.0.1:$PORT"

run() { # run [options…]: the installer, piped as `curl | sh` runs it
    : >"$FAKE_LOG"
    if sh -s -- --prefix "$PREFIX" "$@" <"$INSTALL" >"$T/out" 2>&1; then return 0; else return 1; fi
}
version() { "$PREFIX/bin/$1" --version | cut -d' ' -f2; }
archives() { grep -c "tar.gz" "$T/server.log" || true; }

# 1. Fresh.
run || fail "fresh install"
if [ "$(version invincible)" != 0.0.1 ] || [ "$(version autobot)" != 0.0.1 ]; then fail "fresh install: not 0.0.1"; fi
contains "$T/out" "release signature verified (0.0.1)" "fresh"
contains "$T/out" "next        autobot setup" "fresh: next step"
contains "$INVINCIBLE_HOME/installed" "version=0.0.1" "fresh: record"
lacks "$FAKE_LOG" "service install" "fresh: no services before setup"
[ -z "$(find "$PREFIX/bin" -name '.invincible-install.*')" ] || fail "fresh: staging left behind"
[ ! -e "$INVINCIBLE_HOME/.install.lock" ] || fail "fresh: lock left behind"
pass "fresh install"

# 2. The same again: nothing downloaded, nothing replaced.
inode() { find "$PREFIX/bin/invincible" -exec ls -i {} \; | awk '{print $1}'; }
before_inode=$(inode)
before=$(archives)
run || fail "same again"
contains "$T/out" "installed already; nothing to download" "same again"
[ "$(archives)" = "$before" ] || fail "same again: the archive was downloaded"
[ "$(inode)" = "$before_inode" ] || fail "same again: binary replaced"
pass "same version again: no download"

# 3. Set up (as `autobot setup` leaves it): the services go in with --yes; the config is kept.
mkdir -p "$INVINCIBLE_HOME" "$AUTOBOT_HOME"
printf '# mine\n[node]\nnetwork = "direct"\n\n[[models]]\nid = "m"\npath = "/m.gguf"\n' >"$INVINCIBLE_HOME/config.toml"
printf '[agent]\nworkdir = "/w"\n' >"$AUTOBOT_HOME/config.toml"
cp "$INVINCIBLE_HOME/config.toml" "$T/gateway.before"
cp "$AUTOBOT_HOME/config.toml" "$T/agent.before"
run || fail "piped, set up, no --yes"
lacks "$FAKE_LOG" "service install" "piped without --yes: no services"
run --yes || fail "with --yes"
contains "$FAKE_LOG" "autobot 0.0.1 service install" "--yes: services installed"
contains "$T/out" "your setup is kept" "--yes"
contains "$T/out" "gateway running, agent running" "--yes: summary"
pass "services installed when set up and asked"

# 4. An upgrade: replaced, services restarted once, config untouched.
rm -rf "$T/releases/latest/download" && cp -R "$T/releases/download/v0.0.2" "$T/releases/latest/download"
run || fail "upgrade"
[ "$(version invincible)" = 0.0.2 ] || fail "upgrade: not 0.0.2"
contains "$T/out" "0.0.1 -> 0.0.2" "upgrade"
[ "$(grep -c "service restart" "$FAKE_LOG")" = 1 ] || fail "upgrade: services not restarted exactly once"
cmp -s "$INVINCIBLE_HOME/config.toml" "$T/gateway.before" || fail "upgrade: gateway config changed"
cmp -s "$AUTOBOT_HOME/config.toml" "$T/agent.before" || fail "upgrade: agent config changed"
pass "upgrade: services restarted, config kept"

# 5. Again: no restart.
run || fail "after upgrade"
lacks "$FAKE_LOG" "service restart" "unchanged: no restart"
contains "$T/out" "the services are up to date" "unchanged"
pass "unchanged: no restart"

# 6. Back with --version.
run --version 0.0.1 || fail "downgrade"
[ "$(version invincible)" = 0.0.1 ] || fail "downgrade: not 0.0.1"
contains "$FAKE_LOG" "service restart" "downgrade: restarted"
pass "--version goes back"

# 7. Edge.
run --channel edge || fail "edge"
[ "$(version autobot)" = 0.0.3-edge.abc1234 ] || fail "edge: not the edge build"
contains "$INVINCIBLE_HOME/installed" "channel=edge" "edge: record"
pass "--channel edge"

# 8. A broken partial download from an interrupted run converges.
printf 'garbage' >"$INVINCIBLE_HOME/cache/invincible-$PLATFORM.tar.gz.part"
run --version 0.0.2 || fail "after an interrupted download"
[ "$(version invincible)" = 0.0.2 ] || fail "interrupted: not 0.0.2"
[ ! -e "$INVINCIBLE_HOME/cache/invincible-$PLATFORM.tar.gz.part" ] || fail "interrupted: partial left"
pass "a broken partial download is replaced"

# 9. Two runs at once, and a lock left by a run that was killed.
sh -s -- --prefix "$PREFIX" --version 0.0.1 <"$INSTALL" >"$T/a" 2>&1 & a=$!
sh -s -- --prefix "$PREFIX" --version 0.0.1 <"$INSTALL" >"$T/b" 2>&1 & b=$!
status_a=0 status_b=0
wait "$a" || status_a=$?
wait "$b" || status_b=$?
if [ "$status_a" != 0 ] || [ "$status_b" != 0 ]; then
    # Both runs, their pids (as "waiting … (pid N)" names them) and what is left of the lock.
    {
        echo "run a: pid $a, exit $status_a"; cat "$T/a"
        echo "run b: pid $b, exit $status_b"; cat "$T/b"
        if [ -d "$INVINCIBLE_HOME/.install.lock" ]; then
            echo "lock left behind, pid file: $(cat "$INVINCIBLE_HOME/.install.lock/pid" 2>/dev/null || echo none)"
        else
            echo "no lock left behind"
        fi
    } >"$T/out"
    fail "two runs at once"
fi
[ "$(version invincible)" = 0.0.1 ] || fail "concurrent: not 0.0.1"
mkdir -p "$INVINCIBLE_HOME/.install.lock" && echo 999999 >"$INVINCIBLE_HOME/.install.lock/pid"
run || fail "stale lock"
pass "two runs at once; a stale lock"

# 10. Signed with another key: refused, nothing replaced.
if run --version 0.0.3; then fail "another key: installed"; fi
contains "$T/out" "not signed with the Invincible release key" "another key"
[ "$(version invincible)" = 0.0.2 ] || fail "another key: binaries changed"
pass "a release signed with another key is refused"

# 11. Uninstall keeps the data; --purge removes it.
run --uninstall || fail "uninstall"
if [ -e "$PREFIX/bin/invincible" ] || [ -e "$PREFIX/bin/autobot" ]; then fail "uninstall: binaries left"; fi
[ ! -e "$SERVICE_FILE" ] || fail "uninstall: services left"
cmp -s "$INVINCIBLE_HOME/config.toml" "$T/gateway.before" || fail "uninstall: data removed"
contains "$T/out" "kept" "uninstall"
run --uninstall || fail "uninstall twice"
run --uninstall --purge || fail "purge"
if [ -e "$INVINCIBLE_HOME" ] || [ -e "$AUTOBOT_HOME" ]; then fail "purge: data left"; fi
pass "uninstall keeps data; --purge removes it"

# 12. After all that, a fresh install still works.
run || fail "install after purge"
[ "$(version invincible)" = 0.0.2 ] || fail "after purge: not 0.0.2"
pass "install after purge"

echo "installer: all passed"
