#!/bin/sh
# Installs Invincible (the gateway, `invincible`) and Autobot (the agent, `autobot`) on macOS
# (Apple silicon) or Linux (x86_64, arm64; desktop or VPS). No root needed.
#
#   curl -fsSL https://invincible.sh/install.sh | sh
#   curl -fsSL https://invincible.sh/install.sh | sh -s -- --channel edge --yes
#
# Run it any number of times: it converges. The same version again downloads nothing; another
# version replaces the binaries atomically (downloaded, signature and checksum checked, renamed
# into place) and restarts the running services only when a binary changed. Your config and data
# are never touched (only an `[engine] llama_server` line is added when it installs llama.cpp).
#
# Options:
#   --version X        install release X (also to go back): 0.0.11
#   --channel C        stable (tagged releases, the default) or edge (every commit on main that
#                      passed CI)
#   --prefix DIR       install into DIR/bin (default ~/.local)
#   --no-service       do not install or touch the background services
#   --no-setup         do not run `autobot setup` afterwards
#   --yes, -y          yes to every question (sudo installs of build tools and bubblewrap)
#   --uninstall        remove the binaries and the services; keeps your data
#   --purge            with --uninstall: remove the data too (~/.invincible, ~/.autobot)
#
# Piped (curl | sh), it asks nothing: questions take their defaults, sudo is not used without
# --yes, and the setup is left for you to run (`autobot setup`).
#
# Environment: INVINCIBLE_BIN=<dir> installs there; INVINCIBLE_FROM_SOURCE=1 builds from source
# (INVINCIBLE_REF=<branch|tag|commit>); INVINCIBLE_SETUP=1 runs the setup again; INVINCIBLE_HOME
# and AUTOBOT_HOME move the data. Releases are checked against the release key pinned below
# (SHA256SUMS.sig, an SSH signature) and their SHA256SUMS; with a signed-in `gh`, against their
# Sigstore build attestation too.
set -eu

REPO="https://github.com/wckdboy/invincible"
RELEASES="${INVINCIBLE_RELEASES:-$REPO/releases}"
RELEASE_KEY="ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAII/0fXPq1j51BcfGY0Jp9QfPGy6kHVQQ+W282VFPR/Qo"

# llama.cpp, pinned: build tag and the SHA-256 of each archive (from GitHub's release digests).
LLAMA_TAG="b11721"
LLAMA_URL="https://github.com/ggml-org/llama.cpp/releases/download/$LLAMA_TAG"

# --- Output: the lab's terminal grammar (BRAND.md) ----------------------------------------------
# A small square for each step, ✓ done, ! needs a look, ✗ failed; no color off a terminal or
# with NO_COLOR.
if [ -t 2 ] && [ -z "${NO_COLOR:-}" ] && [ "${TERM:-}" != dumb ]; then
    C_SIGNAL='\033[38;5;208m' C_AMBER='\033[38;5;185m' C_ERROR='\033[38;5;209m' C_ASH='\033[38;5;245m' C_BOLD='\033[1m' C_OFF='\033[0m'
else
    C_SIGNAL='' C_AMBER='' C_ERROR='' C_ASH='' C_BOLD='' C_OFF=''
fi
say() { printf '%b▪%b %s\n' "$C_SIGNAL" "$C_OFF" "$*" >&2; }
ok() { printf '%b✓%b %s\n' "$C_ASH" "$C_OFF" "$*" >&2; }
warn() { printf '%b!%b %s\n' "$C_AMBER" "$C_OFF" "$*" >&2; }
die() { printf '%b✗%b %s\n' "$C_ERROR" "$C_OFF" "$*" >&2; exit 1; }
row() { printf '  %b%-10s%b  %s\n' "$C_ASH" "$1" "$C_OFF" "$2" >&2; }
have() { command -v "$1" >/dev/null 2>&1; }

usage() {
    cat >&2 <<'EOF'
install.sh [options]: installs or updates invincible and autobot (run again any time)

  --version X      install release X (also to go back)
  --channel C      stable (default) or edge (every commit on main that passed CI)
  --prefix DIR     install into DIR/bin (default ~/.local)
  --no-service     leave the background services alone
  --no-setup       do not run `autobot setup` afterwards
  --yes, -y        yes to every question (sudo installs of build tools and bubblewrap)
  --uninstall      remove the binaries and the services; keeps your data
  --purge          with --uninstall: remove the data too

Piped (curl ... | sh -s -- --channel edge), it asks nothing.
EOF
}

# --- Options ------------------------------------------------------------------------------------
WANT_VERSION=""
CHANNEL=""
PREFIX="$HOME/.local"
NO_SERVICE=0
NO_SETUP="${INVINCIBLE_NO_SETUP:-0}"
YES="${INVINCIBLE_YES:-0}"
UNINSTALL=0
PURGE=0
need_value() { if [ $# -lt 2 ] || [ -z "$2" ]; then die "$1 needs a value (--help lists the options)"; fi; }
while [ $# -gt 0 ]; do
    case "$1" in
        --version) need_value "$@"; WANT_VERSION="${2#v}"; shift 2 ;;
        --version=*) WANT_VERSION="${1#*=}"; WANT_VERSION="${WANT_VERSION#v}"; shift ;;
        --channel) need_value "$@"; CHANNEL="$2"; shift 2 ;;
        --channel=*) CHANNEL="${1#*=}"; shift ;;
        --prefix) need_value "$@"; PREFIX="$2"; shift 2 ;;
        --prefix=*) PREFIX="${1#*=}"; shift ;;
        --no-service) NO_SERVICE=1; shift ;;
        --no-setup) NO_SETUP=1; shift ;;
        --yes|-y) YES=1; shift ;;
        --uninstall) UNINSTALL=1; shift ;;
        --purge) PURGE=1; shift ;;
        -h|--help) usage; exit 0 ;;
        *) die "unknown option $1 (--help lists the options)" ;;
    esac
done
case "$CHANNEL" in ""|stable|edge) ;; *) die "--channel is stable or edge, not $CHANNEL" ;; esac
[ -z "$WANT_VERSION" ] || [ -z "$CHANNEL" ] || die "--version and --channel: one or the other"
[ "$PURGE" = 0 ] || [ "$UNINSTALL" = 1 ] || die "--purge goes with --uninstall"

BIN="${INVINCIBLE_BIN:-$PREFIX/bin}"
INV_HOME="${INVINCIBLE_HOME:-$HOME/.invincible}"
AUTOBOT_DIR="${AUTOBOT_HOME:-$HOME/.autobot}"
STATE="$INV_HOME/installed"
CACHE="$INV_HOME/cache"

# Interactive only with a terminal on stdin: `curl | sh` asks nothing.
INTERACTIVE=0
if [ -t 0 ] && [ -r /dev/tty ]; then INTERACTIVE=1; fi
ask() { # ask "question" default(y|n): yes with --yes; the default when nobody can be asked
    if [ "$YES" = 1 ]; then return 0; fi
    if [ "$INTERACTIVE" = 0 ]; then [ "$2" = y ]; return; fi
    if [ "$2" = y ]; then hint="Y/n"; else hint="y/N"; fi
    printf '%s [%s] ' "$1" "$hint" >&2
    read -r answer </dev/tty || answer=""
    case "${answer:-$2}" in y|Y|yes) return 0 ;; *) return 1 ;; esac
}
# A question whose yes runs sudo: never yes unless asked and answered, or --yes.
ask_sudo() {
    if [ "$YES" = 1 ]; then return 0; fi
    [ "$INTERACTIVE" = 1 ] && ask "$1" y
}

# HTTPS only; a test release on loopback (INVINCIBLE_RELEASES=http://127.0.0.1:…) may be HTTP,
# and only it may bring its own key.
PROTO='=https'
LOOPBACK=0
case "$RELEASES ${INVINCIBLE_RELEASE_URL:-}" in *http://127.0.0.1:*|*http://localhost:*) PROTO='=http,https'; LOOPBACK=1 ;; esac
if [ -n "${INVINCIBLE_RELEASE_KEY:-}" ]; then
    [ "$LOOPBACK" = 1 ] || die "INVINCIBLE_RELEASE_KEY is only for a test release on loopback"
    RELEASE_KEY="$INVINCIBLE_RELEASE_KEY"
fi

sha256() {
    if have sha256sum; then sha256sum "$1" | cut -d' ' -f1; else shasum -a 256 "$1" | cut -d' ' -f1; fi
}
sha_or_none() { if [ -f "$1" ]; then sha256 "$1"; else echo none; fi; }

# get url file [resume]: curl or wget, quiet, retried; resume continues a partial file.
get() {
    if have curl; then
        if [ "${3:-}" = resume ] && [ -s "$2" ]; then
            curl -fsL --proto "$PROTO" --tlsv1.2 --retry 3 -C - -o "$2" "$1" 2>/dev/null && return 0
            rm -f "$2"
        fi
        curl -fsL --proto "$PROTO" --tlsv1.2 --retry 3 -o "$2" "$1" 2>/dev/null
    else
        https=""
        [ "$LOOPBACK" = 1 ] || https="--https-only"
        if [ "${3:-}" = resume ]; then
            # shellcheck disable=SC2086 # $https is one flag or none
            wget -q $https -c -O "$2" "$1" && return 0
            rm -f "$2"
        fi
        # shellcheck disable=SC2086
        wget -q $https -O "$2" "$1"
    fi
}

fetch() { # fetch url file sha256: downloads, resuming a partial one, and keeps it only if it matches
    part="$2.part"
    get "$1" "$part" resume || { rm -f "$part"; die "download failed: $1"; }
    got=$(sha256 "$part")
    if [ "$got" != "$3" ]; then
        # A partial file from another build, or a broken resume: once more from the start.
        rm -f "$part"
        get "$1" "$part" || { rm -f "$part"; die "download failed: $1"; }
        got=$(sha256 "$part")
        [ "$got" = "$3" ] || { rm -f "$part"; die "$(basename "$1"): SHA-256 $got, expected $3; not installing it"; }
    fi
    mv -f "$part" "$2"
}

state_get() { if [ -f "$STATE" ]; then sed -n "s/^$1=//p" "$STATE" | tail -n 1; fi; }

# --- The header ---------------------------------------------------------------------------------
if [ -n "$C_SIGNAL" ]; then
    printf '%b▀▀%b  %binvincible%b\n%b██%b  %binstaller · invincible and autobot%b\n%b██%b\n\n' \
        "$C_SIGNAL" "$C_OFF" "$C_BOLD" "$C_OFF" "$C_SIGNAL" "$C_OFF" "$C_ASH" "$C_OFF" "$C_SIGNAL" "$C_OFF" >&2
else
    printf 'invincible installer · invincible and autobot\n\n' >&2
fi

OS=$(uname -s)
ARCH=$(uname -m)
case "$OS/$ARCH" in
    Darwin/arm64) PLATFORM=macos-arm64 ;;
    Linux/x86_64|Linux/amd64) PLATFORM=linux-x64 ;;
    Linux/aarch64|Linux/arm64) PLATFORM=linux-arm64 ;;
    *) die "unsupported platform $OS/$ARCH (macOS on Apple silicon, Linux on x86_64 or arm64)" ;;
esac

# --- One run at a time --------------------------------------------------------------------------
WORK=""
STAGE=""
LOCK="$INV_HOME/.install.lock"
cleanup() {
    [ -z "$WORK" ] || rm -rf "$WORK"
    [ -z "$STAGE" ] || rm -rf "$STAGE"
    if [ -f "$LOCK/pid" ] && [ "$(cat "$LOCK/pid" 2>/dev/null)" = "$$" ]; then rm -rf "$LOCK"; fi
}
trap cleanup EXIT
trap 'exit 130' INT TERM
mkdir -p "$INV_HOME"
waited=0
while ! mkdir "$LOCK" 2>/dev/null; do
    holder=$(cat "$LOCK/pid" 2>/dev/null || true)
    if [ -n "$holder" ] && ! kill -0 "$holder" 2>/dev/null; then
        rm -rf "$LOCK" # left by a run that was killed
        continue
    fi
    [ "$waited" = 0 ] && say "waiting for another install to finish (pid ${holder:-?})"
    waited=$((waited + 1))
    [ "$waited" -le 120 ] || die "another install (pid ${holder:-?}) is still running; remove $LOCK if it is not"
    sleep 1
done
echo "$$" >"$LOCK/pid"

# --- Services: where their definitions are ----------------------------------------------------
if [ "$OS" = Darwin ]; then
    SERVICE_FILES="$HOME/Library/LaunchAgents/sh.invincible.gateway.plist $HOME/Library/LaunchAgents/sh.invincible.autobot.plist $HOME/Library/LaunchAgents/sh.invincible.update.plist"
elif [ "$(id -u)" = 0 ]; then
    SERVICE_FILES="/etc/systemd/system/invincible.service /etc/systemd/system/autobot.service /etc/systemd/system/invincible-update.service /etc/systemd/system/invincible-update.timer"
else
    SERVICE_FILES="$HOME/.config/systemd/user/invincible.service $HOME/.config/systemd/user/autobot.service $HOME/.config/systemd/user/invincible-update.service $HOME/.config/systemd/user/invincible-update.timer"
fi
services_installed() { for f in $SERVICE_FILES; do [ -f "$f" ] && return 0; done; return 1; }

# --- Uninstall ----------------------------------------------------------------------------------
if [ "$UNINSTALL" = 1 ]; then
    INSTALLED_BIN=$(state_get bin)
    BIN="${INSTALLED_BIN:-$BIN}"
    if services_installed; then
        if [ -x "$BIN/autobot" ] && "$BIN/autobot" service uninstall >/dev/null 2>&1; then
            ok "stopped and removed the services"
        else
            # No working autobot: by hand.
            for f in $SERVICE_FILES; do
                [ -f "$f" ] || continue
                name=$(basename "$f")
                if [ "$OS" = Darwin ]; then
                    launchctl bootout "gui/$(id -u)/${name%.plist}" >/dev/null 2>&1 || true
                elif [ "$(id -u)" = 0 ]; then
                    systemctl disable --now "$name" >/dev/null 2>&1 || true
                else
                    systemctl --user disable --now "$name" >/dev/null 2>&1 || true
                fi
                rm -f "$f"
            done
            ok "stopped and removed the services"
        fi
        for f in $SERVICE_FILES; do rm -f "$f"; done
    fi
    removed=""
    for program in invincible autobot; do
        if [ -e "$BIN/$program" ]; then rm -f "$BIN/$program"; removed="$removed $program"; fi
    done
    [ -n "$removed" ] && ok "removed$removed from $BIN"
    for profile in "$HOME/.profile" "$HOME/.bashrc" "$HOME/.zshrc"; do
        if grep -qs '# invincible$' "$profile"; then
            grep -v '# invincible$' "$profile" >"$profile.invincible-tmp" || true
            cat "$profile.invincible-tmp" >"$profile" && rm -f "$profile.invincible-tmp"
            ok "removed the PATH line from $profile"
        fi
    done
    rm -rf "$CACHE" "$STATE"
    if [ "$PURGE" = 1 ]; then
        for dir in "$INV_HOME" "$AUTOBOT_DIR"; do
            case "$dir" in ""|/|"$HOME"|"$HOME/") die "not removing $dir" ;; esac
        done
        rm -rf "$AUTOBOT_DIR"
        rm -rf "$INV_HOME"
        ok "removed the data: $INV_HOME, $AUTOBOT_DIR"
        printf '\n' >&2
        row "removed" "invincible, autobot, their services and data"
    else
        printf '\n' >&2
        row "removed" "invincible, autobot and their services"
        row "kept" "$INV_HOME, $AUTOBOT_DIR (--uninstall --purge removes them)"
    fi
    exit 0
fi

# --- 1. invincible and autobot ------------------------------------------------------------------
have tar || die "tar is needed"
have curl || have wget || die "curl or wget is needed"
mkdir -p "$BIN" "$CACHE"
WORK=$(mktemp -d "$CACHE/run.XXXXXX")
BEFORE=$(sha_or_none "$BIN/invincible")$(sha_or_none "$BIN/autobot")
OLD_VERSION=""
[ -x "$BIN/invincible" ] && OLD_VERSION=$("$BIN/invincible" --version 2>/dev/null | cut -d' ' -f2 || true)
VERSION=""
ARCHIVE_SHA=""

if [ -n "$WANT_VERSION" ]; then
    BASE="$RELEASES/download/v$WANT_VERSION"
    WHAT="v$WANT_VERSION"
    case "$WANT_VERSION" in *-edge.*) CHANNEL=edge ;; *) CHANNEL=stable ;; esac
elif [ "$CHANNEL" = edge ]; then
    BASE="$RELEASES/download/edge"
    WHAT="the edge channel"
else
    BASE="$RELEASES/latest/download"
    WHAT="the stable channel"
    CHANNEL=stable
fi
BASE="${INVINCIBLE_RELEASE_URL:-$BASE}"

# Puts the programs in [dir] in place of those in $BIN: each checked to run here, then renamed
# over the old one (atomic, on one file system); an identical one is left alone.
place() {
    for program in invincible autobot; do
        [ -f "$1/$program" ] || die "the archive has no $program; not installing it"
        chmod 0755 "$1/$program"
        "$1/$program" --version >/dev/null 2>&1 || die "the new $program does not run on this machine; nothing was replaced"
    done
    for program in invincible autobot; do
        if [ "$(sha256 "$1/$program")" != "$(sha_or_none "$BIN/$program")" ]; then
            mv -f "$1/$program" "$BIN/$program"
        fi
    done
}

# A release archive for this platform, checked against the release's signed SHA256SUMS (and its
# Sigstore build attestation when the GitHub CLI is here to check it). Returns 1 when there is no
# release to use (then it is built from source).
install_release() {
    [ "${INVINCIBLE_FROM_SOURCE:-}" = 1 ] && return 1
    have ssh-keygen || die "ssh-keygen (OpenSSH) is needed to check the release signature"
    say "checking $WHAT for $PLATFORM"
    # The list and its signature, side by side.
    get "$BASE/SHA256SUMS" "$WORK/SHA256SUMS" & sums_job=$!
    get "$BASE/SHA256SUMS.sig" "$WORK/SHA256SUMS.sig" & sig_job=$!
    sums_ok=0 sig_ok=0
    wait "$sums_job" && sums_ok=1
    wait "$sig_job" && sig_ok=1
    if [ "$sums_ok" = 0 ]; then
        if [ -n "$WANT_VERSION" ] || [ "$CHANNEL" = edge ]; then die "no release for $WHAT ($BASE)"; fi
        say "no release yet; building from source instead"
        return 1
    fi
    [ "$sig_ok" = 1 ] || die "the release for $WHAT is not signed (no SHA256SUMS.sig); not installing it"
    printf 'invincible-release %s\n' "$RELEASE_KEY" >"$WORK/allowed_signers"
    ssh-keygen -Y verify -f "$WORK/allowed_signers" -I invincible-release -n invincible-release \
        -s "$WORK/SHA256SUMS.sig" <"$WORK/SHA256SUMS" >/dev/null 2>&1 \
        || die "the release's SHA256SUMS is not signed with the Invincible release key; not installing it"
    archive="invincible-$PLATFORM.tar.gz"
    ARCHIVE_SHA=$(awk -v f="$archive" '$2 == f || $2 == "*"f {print $1}' "$WORK/SHA256SUMS")
    [ -n "$ARCHIVE_SHA" ] || die "the release for $WHAT has nothing for $PLATFORM"
    version_sha=$(awk '$2 == "VERSION" || $2 == "*VERSION" {print $1}' "$WORK/SHA256SUMS")
    if [ -n "$version_sha" ]; then
        get "$BASE/VERSION" "$WORK/VERSION" || die "the release lists VERSION but has none"
        [ "$(sha256 "$WORK/VERSION")" = "$version_sha" ] || die "VERSION does not match the signed SHA256SUMS; not installing it"
        VERSION=$(tr -d ' \n\r' <"$WORK/VERSION")
    fi
    ok "release signature verified${VERSION:+ ($VERSION)}"

    # Installed already, byte for byte: nothing to download.
    if [ "$(state_get archive_sha256)" = "$ARCHIVE_SHA" ] && [ "$(state_get bin)" = "$BIN" ] \
        && [ "$(state_get invincible_sha256)" = "$(sha_or_none "$BIN/invincible")" ] \
        && [ "$(state_get autobot_sha256)" = "$(sha_or_none "$BIN/autobot")" ]; then
        ok "${VERSION:-this release} is installed already; nothing to download"
        return 0
    fi

    say "downloading $archive"
    fetch "$BASE/$archive" "$CACHE/$archive" "$ARCHIVE_SHA"
    if [ "$LOOPBACK" = 0 ] && have gh && gh auth status >/dev/null 2>&1; then
        gh attestation verify "$CACHE/$archive" --repo wckdboy/invincible >/dev/null \
            || die "$archive: its build attestation does not verify; not installing it"
        ok "build attestation verified (built by wckdboy/invincible's release workflow)"
    fi
    STAGE=$(mktemp -d "$BIN/.invincible-install.XXXXXX")
    tar -xzf "$CACHE/$archive" -C "$STAGE" || die "$archive does not unpack"
    place "$STAGE/invincible-$PLATFORM"
    rm -rf "$STAGE" "${CACHE:?}/$archive"
    STAGE=""
}

build_from_source() {
    have git || die "git is needed to build (macOS: xcode-select --install; Debian/Ubuntu: sudo apt install git)"
    ref="${INVINCIBLE_REF:-main}"
    src="$INV_HOME/src"
    if ! have cc; then
        if [ "$OS" = Linux ] && have apt-get && ask_sudo "A C compiler is needed to build. Install build-essential with sudo?"; then
            sudo apt-get update -qq && sudo apt-get install -y -qq build-essential pkg-config
        else
            die "a C compiler is needed (macOS: xcode-select --install; Linux: your distribution's build-essential)"
        fi
    fi
    if [ -x "${CARGO_HOME:-$HOME/.cargo}/bin/cargo" ]; then PATH="${CARGO_HOME:-$HOME/.cargo}/bin:$PATH"; fi
    if ! have cargo; then
        ask "Rust is needed to build. Install it with rustup (into ~/.cargo, no root)?" y \
            || die "install Rust from https://rustup.rs, then run this again"
        curl -fsSL --proto '=https' --tlsv1.2 https://sh.rustup.rs | sh -s -- -y --profile minimal --no-modify-path >&2
        PATH="${CARGO_HOME:-$HOME/.cargo}/bin:$PATH"
    fi
    if [ -d "$src/.git" ]; then
        say "updating the source in $src"
        git -C "$src" fetch --quiet origin "$ref"
        git -C "$src" checkout --quiet FETCH_HEAD
    else
        say "getting the source into $src"
        git clone --quiet "$REPO" "$src"
        # Fetched by name: a branch, a tag, or any commit GitHub has (a pull request's too).
        git -C "$src" fetch --quiet origin "$ref"
        git -C "$src" checkout --quiet FETCH_HEAD
    fi
    say "building (a few minutes the first time)"
    # The workspace needs Rust 1.91 or newer.
    minor=$(rustc --version | sed -n 's/^rustc 1\.\([0-9][0-9]*\).*/\1/p')
    if [ "${minor:-0}" -lt 91 ]; then
        if have rustup; then
            say "updating Rust (1.91 or newer is needed)"
            rustup update stable >&2 && rustup default stable >&2
        else
            die "Rust 1.91 or newer is needed; you have $(rustc --version)"
        fi
    fi
    (cd "$src" && cargo build --release --locked -p invincible -p autobot) >&2
    STAGE=$(mktemp -d "$BIN/.invincible-install.XXXXXX")
    cp "$src/target/release/invincible" "$src/target/release/autobot" "$STAGE/"
    place "$STAGE"
    rm -rf "$STAGE"
    STAGE=""
    ARCHIVE_SHA="source"
    CHANNEL="source"
}

install_release || build_from_source
AFTER=$(sha_or_none "$BIN/invincible")$(sha_or_none "$BIN/autobot")
NOW_VERSION=$("$BIN/invincible" --version 2>/dev/null | cut -d' ' -f2 || true)
CHANGED=0
[ "$BEFORE" = "$AFTER" ] || CHANGED=1

# What is installed, for the next run (and `invincible update`).
{
    echo "version=${NOW_VERSION:-unknown}"
    echo "channel=$CHANNEL"
    echo "bin=$BIN"
    echo "archive_sha256=$ARCHIVE_SHA"
    echo "invincible_sha256=$(sha_or_none "$BIN/invincible")"
    echo "autobot_sha256=$(sha_or_none "$BIN/autobot")"
} >"$STATE.tmp" && mv -f "$STATE.tmp" "$STATE"

if [ "$CHANGED" = 0 ]; then
    :
elif [ -n "$OLD_VERSION" ] && [ "$OLD_VERSION" != "$NOW_VERSION" ]; then
    ok "replaced invincible and autobot in $BIN: $OLD_VERSION -> $NOW_VERSION"
else
    ok "installed invincible and autobot ${NOW_VERSION:-} in $BIN"
fi

case ":$PATH:" in
    *":$BIN:"*) ;;
    *)
        line="export PATH=\"$BIN:\$PATH\"  # invincible"
        for profile in "$HOME/.profile" "$HOME/.bashrc" "$HOME/.zshrc"; do
            if [ -f "$profile" ] || [ "$profile" = "$HOME/.profile" ]; then
                grep -qs "# invincible$" "$profile" || printf '\n%s\n' "$line" >>"$profile"
            fi
        done
        PATH="$BIN:$PATH"
        warn "$BIN is now on PATH in your shell profile; open a new shell to pick it up"
        ;;
esac

# --- 2. llama.cpp -------------------------------------------------------------------------------
LLAMA_DIR="$INV_HOME/llama.cpp"
if have llama-server; then
    ok "llama.cpp at $(command -v llama-server)"
elif [ -x "$LLAMA_DIR/llama-server" ]; then
    ok "llama.cpp at $LLAMA_DIR/llama-server"
    LLAMA_SERVER="$LLAMA_DIR/llama-server"
elif [ "$OS" = Darwin ] && have brew && ask "Install llama.cpp with Homebrew?" y; then
    say "installing llama.cpp with Homebrew"
    brew install llama.cpp >&2
else
    archive=""
    runtime=""
    case "$PLATFORM" in
        macos-arm64) archive="llama-$LLAMA_TAG-bin-macos-arm64.tar.gz 2ace55512ee1ab4e2703f80c135c2a92d40d3367a5b3a98d21b103ffa7f0eb82" ;;
        linux-x64)
            if have nvidia-smi; then
                say "NVIDIA GPU found: the CUDA 12.8 build (needs driver 570 or newer)"
                archive="llama-$LLAMA_TAG-bin-ubuntu-cuda-12.8-x64.tar.gz 9edcb8affbc342d39e52a8f551ba3fac3f7ed77bf9d73b80ec3481ea9ef06ee2"
                runtime="cudart-llama-$LLAMA_TAG-bin-ubuntu-cuda-12.8-x64.tar.gz ad8d203163148b3e47da8461ea4e6510a0efb084ce5bf19ee808c1315433220b"
            else
                archive="llama-$LLAMA_TAG-bin-ubuntu-x64.tar.gz 68c7a4dfb6a53e607b73c00c839bfc81c55141cd0a7697c0252e634190647c2f"
            fi
            ;;
        linux-arm64)
            if have nvidia-smi; then
                say "NVIDIA GPU found: the CUDA 13.4 build"
                archive="llama-$LLAMA_TAG-bin-ubuntu-cuda-13.4-arm64.tar.gz 52fcf379f1178ca567b3899a49e46f9d4540ac764cdd41a57e1e60dc4486c1cb"
                runtime="cudart-llama-$LLAMA_TAG-bin-ubuntu-cuda-13.4-arm64.tar.gz 582e85f740a4989f65a4908a016ab2ec03fbd03e2cab92a932fc14aefc123da1"
            else
                archive="llama-$LLAMA_TAG-bin-ubuntu-arm64.tar.gz fafae7c6df59f4bcaadf0e1ec4320deaacf0b3f7eeadb4fdf0ad586f0daaf397"
            fi
            ;;
    esac
    ask "Install llama.cpp $LLAMA_TAG into $LLAMA_DIR?" y || die "install llama.cpp's llama-server yourself, then run this again"
    say "downloading llama.cpp $LLAMA_TAG"
    # shellcheck disable=SC2086 # "<file> <sha256>", split on purpose
    set -- $archive
    fetch "$LLAMA_URL/$1" "$CACHE/$1" "$2"
    mkdir -p "$WORK/llama" && tar -xzf "$CACHE/$1" -C "$WORK/llama" && rm -f "$CACHE/$1"
    if [ -n "$runtime" ]; then
        # shellcheck disable=SC2086
        set -- $runtime
        fetch "$LLAMA_URL/$1" "$CACHE/$1" "$2"
        mkdir -p "$WORK/cudart" && tar -xzf "$CACHE/$1" -C "$WORK/cudart" && rm -f "$CACHE/$1"
    fi
    server=$(find "$WORK/llama" -type f -name llama-server | head -n 1)
    [ -n "$server" ] || die "the llama.cpp archive has no llama-server"
    rm -rf "$LLAMA_DIR.new" && mkdir -p "$LLAMA_DIR.new"
    cp -R "$(dirname "$server")"/. "$LLAMA_DIR.new"/
    if [ -n "$runtime" ]; then find "$WORK/cudart" -name '*.so*' -exec cp -P {} "$LLAMA_DIR.new"/ \; ; fi
    rm -rf "$LLAMA_DIR" && mv "$LLAMA_DIR.new" "$LLAMA_DIR"
    LLAMA_SERVER="$LLAMA_DIR/llama-server"
    ok "llama.cpp installed in $LLAMA_DIR"
fi

# --- The sandbox for unattended commands (Linux: bubblewrap) ----------------------------------
# Scheduled tasks, board work and phone recipes run commands sandboxed; without bwrap they are
# refused. macOS has sandbox-exec built in.
if [ "$OS" = Linux ] && ! have bwrap; then
    question="Install bubblewrap (the sandbox for unattended agent commands) with sudo?"
    if have apt-get && ask_sudo "$question"; then
        sudo apt-get install -y -qq bubblewrap >&2 || warn "bubblewrap did not install"
    elif have dnf && ask_sudo "$question"; then
        sudo dnf install -y -q bubblewrap >&2 || warn "bubblewrap did not install"
    elif have apk && ask_sudo "$question"; then
        sudo apk add -q bubblewrap >&2 || warn "bubblewrap did not install"
    fi
    have bwrap || warn "no bubblewrap: unattended agent commands are refused until it is installed (sudo apt install bubblewrap), or [agent] sandbox = \"off\""
fi

# The gateway finds llama-server on its PATH, unless told where it is.
if [ -n "${LLAMA_SERVER:-}" ]; then
    config="$INV_HOME/config.toml"
    if ! grep -qs '^llama_server' "$config"; then
        if grep -qs '^\[engine\]' "$config"; then
            awk -v line="llama_server = \"$LLAMA_SERVER\"" '{print} /^\[engine\]/{print line}' "$config" >"$config.tmp" && mv "$config.tmp" "$config"
        else
            printf '\n[engine]\nllama_server = "%s"\n' "$LLAMA_SERVER" >>"$config"
        fi
    fi
fi

# --- 3. Services and setup ----------------------------------------------------------------------
SET_UP=0
if [ -f "$AUTOBOT_DIR/config.toml" ] && grep -qsE '^\[\[(models|cloud)\]\]' "$INV_HOME/config.toml"; then SET_UP=1; fi

if [ "$NO_SERVICE" = 1 ]; then
    :
elif services_installed; then
    # Brought up to date (only what changed is rewritten), restarted on new binaries.
    # (A definition changes with the binaries' path or the PATH services are given.)
    refreshed=$("$BIN/autobot" service install 2>&1) || warn "the services did not update (\`autobot service install\` says why)"
    if [ "$CHANGED" = 1 ]; then
        "$BIN/autobot" service restart >/dev/null 2>&1 && ok "restarted the services on the new binaries"
    elif printf '%s\n' "$refreshed" | grep -qE '^(started|reloaded) '; then
        ok "updated the service definitions and restarted what changed"
    else
        ok "the services are up to date"
    fi
elif [ "$SET_UP" = 1 ] && { [ "$YES" = 1 ] || { [ "$INTERACTIVE" = 1 ] && ask "Run the gateway and the agent in the background, also after reboots?" y; }; }; then
    if "$BIN/autobot" service install >/dev/null 2>&1; then
        ok "installed the services"
    else
        warn "the services did not install (\`autobot service install\` says why)"
    fi
fi

NEXT="autobot doctor"
if [ "$SET_UP" = 1 ] && [ "${INVINCIBLE_SETUP:-}" != 1 ]; then
    ok "your setup is kept (\`autobot setup\` changes it)"
elif [ "$NO_SETUP" = 1 ] || [ "$INTERACTIVE" = 0 ]; then
    NEXT="autobot setup"
else
    "$BIN/autobot" setup </dev/tty || warn "the setup did not finish; \`autobot setup\` runs it again"
fi

# --- Summary ------------------------------------------------------------------------------------
status=""
if services_installed; then status=$("$BIN/autobot" service status 2>/dev/null || true); fi
service_state() {
    line=$(printf '%s\n' "$status" | grep "^$1:" | head -n 1)
    line=${line#*: }
    echo "${line%% (*}"
}
if [ "$NO_SERVICE" = 1 ] && ! services_installed; then
    services="not installed (--no-service)"
elif services_installed; then
    services="gateway $(service_state sh.invincible.gateway), agent $(service_state sh.invincible.autobot)"
else
    services="not installed (\`autobot service install\` runs them 24/7)"
fi
printf '\n' >&2
row "version" "${NOW_VERSION:-unknown} ($CHANNEL)"
row "binaries" "$BIN/invincible, $BIN/autobot"
row "data" "$INV_HOME, $AUTOBOT_DIR"
row "services" "$services"
row "update" "invincible update (or run this again)"
row "next" "$NEXT"
