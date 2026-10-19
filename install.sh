#!/bin/sh
# Installs Invincible Gateway and the Autobot Agent, one product, on macOS (Apple silicon) or
# Linux (x86_64, arm64; desktop or VPS), then runs `autobot setup`.
#
#   curl -fsSL https://raw.githubusercontent.com/wckdboy/invincible/main/install.sh | sh
#
# What it does, all in your home directory (no root needed):
#   1. puts `invincible` and `autobot` in ~/.local/bin: the latest release's binaries, its
#      SHA256SUMS signed with the release key pinned below and the archive checked against it (and
#      its Sigstore build attestation if `gh` is installed), or, without a signed release, built
#      from source with Rust from rustup if you have none;
#   2. installs llama.cpp's server if it is missing: Homebrew on macOS, else a pinned upstream
#      build checked against its SHA-256 (CUDA when an NVIDIA GPU is present);
#   3. runs `autobot setup`: network, model, approvals, Telegram, background services.
#
# An upgrade restarts the running services and keeps the setup (INVINCIBLE_SETUP=1 runs it again).
#
# Options (environment): INVINCIBLE_YES=1 answers yes to every question; INVINCIBLE_NO_SETUP=1
# skips step 3; INVINCIBLE_FROM_SOURCE=1 builds even when there is a release; INVINCIBLE_REF=
# <branch|tag> builds that ref; INVINCIBLE_BIN=<dir> installs there.
set -eu

REPO="https://github.com/wckdboy/invincible"
REF="${INVINCIBLE_REF:-main}"
BIN="${INVINCIBLE_BIN:-$HOME/.local/bin}"
INV_HOME="${INVINCIBLE_HOME:-$HOME/.invincible}"
SRC="$INV_HOME/src"

# The release key: SHA256SUMS of every release is signed with it (an SSH signature, checked with
# ssh-keygen, which comes with OpenSSH on every Mac and Linux machine).
RELEASE_KEY="ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAII/0fXPq1j51BcfGY0Jp9QfPGy6kHVQQ+W282VFPR/Qo"

# llama.cpp, pinned: build tag and the SHA-256 of each archive (from GitHub's release digests).
LLAMA_TAG="b11721"
LLAMA_URL="https://github.com/ggml-org/llama.cpp/releases/download/$LLAMA_TAG"

# The lab's terminal grammar (BRAND.md): a small square for each step in Invincible's orange,
# yellow ! for what needs a look, ✗ for a failure; no color off a terminal or with NO_COLOR.
if [ -t 2 ] && [ -z "${NO_COLOR:-}" ] && [ "${TERM:-}" != dumb ]; then
    C_SIGNAL='\033[38;5;208m' C_AMBER='\033[38;5;185m' C_ERROR='\033[38;5;209m' C_ASH='\033[38;5;245m' C_BOLD='\033[1m' C_OFF='\033[0m'
else
    C_SIGNAL='' C_AMBER='' C_ERROR='' C_ASH='' C_BOLD='' C_OFF=''
fi
say() { printf '%b▪%b %s\n' "$C_SIGNAL" "$C_OFF" "$*" >&2; }
warn() { printf '%b!%b %s\n' "$C_AMBER" "$C_OFF" "$*" >&2; }
die() { printf '%b✗%b %s\n' "$C_ERROR" "$C_OFF" "$*" >&2; exit 1; }
# The header: Invincible's pixel i (half blocks) beside the name, on a terminal that has color.
if [ -n "$C_SIGNAL" ]; then
    printf '%b▀▀%b  %binvincible%b\n%b██%b  %binstaller · invincible and autobot%b\n%b██%b\n\n' \
        "$C_SIGNAL" "$C_OFF" "$C_BOLD" "$C_OFF" "$C_SIGNAL" "$C_OFF" "$C_ASH" "$C_OFF" "$C_SIGNAL" "$C_OFF" >&2
else
    printf 'invincible installer · invincible and autobot\n\n' >&2
fi
have() { command -v "$1" >/dev/null 2>&1; }

# Questions go to the terminal even when this script arrives through a pipe.
TTY=""
if [ -r /dev/tty ] && (: </dev/tty) 2>/dev/null; then TTY=/dev/tty; fi
ask() { # ask "question" default(y|n)
    if [ "${INVINCIBLE_YES:-}" = 1 ]; then return 0; fi
    if [ -z "$TTY" ]; then [ "$2" = y ]; return; fi
    if [ "$2" = y ]; then hint="Y/n"; else hint="y/N"; fi
    printf '%s [%s] ' "$1" "$hint" >&2
    read -r answer <"$TTY" || answer=""
    case "${answer:-$2}" in y|Y|yes) return 0 ;; *) return 1 ;; esac
}

sha256() {
    if have sha256sum; then sha256sum "$1" | cut -d' ' -f1; else shasum -a 256 "$1" | cut -d' ' -f1; fi
}

# HTTPS only; a test release on loopback (INVINCIBLE_RELEASE_URL=http://127.0.0.1:…) may be HTTP.
PROTO='=https'
case "${INVINCIBLE_RELEASE_URL:-}" in http://127.0.0.1:*|http://localhost:*) PROTO='=http,https' ;; esac

fetch() { # fetch url file sha256
    say "downloading $(basename "$1")"
    curl -fL --proto "$PROTO" --tlsv1.2 --retry 3 -o "$2" "$1" || die "download failed: $1"
    got=$(sha256 "$2")
    [ "$got" = "$3" ] || die "$(basename "$1"): SHA-256 $got, expected $3; not installing it"
}

OS=$(uname -s)
ARCH=$(uname -m)
case "$OS/$ARCH" in
    Darwin/arm64) PLATFORM=macos-arm64 ;;
    Linux/x86_64|Linux/amd64) PLATFORM=linux-x64 ;;
    Linux/aarch64|Linux/arm64) PLATFORM=linux-arm64 ;;
    *) die "unsupported platform $OS/$ARCH (macOS on Apple silicon, Linux on x86_64 or arm64)" ;;
esac
have curl || die "curl is needed"
have git || die "git is needed (macOS: xcode-select --install; Debian/Ubuntu: sudo apt install git)"

# --- 1. invincible and autobot -------------------------------------------------------------------

# A release archive for this platform, checked against the release's SHA256SUMS, and against its
# Sigstore build attestation when the GitHub CLI is here to check it. Returns 1 when there is no
# release to use (then we build from source).
install_release() {
    [ "${INVINCIBLE_FROM_SOURCE:-}" = 1 ] && return 1
    base="${INVINCIBLE_RELEASE_URL:-$REPO/releases/latest/download}"
    work=$(mktemp -d)
    archive="invincible-$PLATFORM.tar.gz"
    say "looking for a release for $PLATFORM"
    if ! curl -fsL --proto "$PROTO" --tlsv1.2 --retry 2 -o "$work/SHA256SUMS" "$base/SHA256SUMS" 2>/dev/null; then
        rm -rf "$work"
        say "no release yet; building from source instead"
        return 1
    fi
    if ! curl -fsL --proto "$PROTO" --tlsv1.2 --retry 2 -o "$work/SHA256SUMS.sig" "$base/SHA256SUMS.sig" 2>/dev/null; then
        rm -rf "$work"
        say "this release is not signed; building from source instead"
        return 1
    fi
    have ssh-keygen || die "ssh-keygen (OpenSSH) is needed to check the release signature"
    printf 'invincible-release %s\n' "$RELEASE_KEY" > "$work/allowed_signers"
    ssh-keygen -Y verify -f "$work/allowed_signers" -I invincible-release -n invincible-release \
        -s "$work/SHA256SUMS.sig" < "$work/SHA256SUMS" >/dev/null 2>&1 \
        || die "the release's SHA256SUMS is not signed with the Invincible release key; not installing it"
    say "release signature verified"
    expected=$(awk -v f="$archive" '$2 == f || $2 == "*"f {print $1}' "$work/SHA256SUMS")
    [ -n "$expected" ] || { rm -rf "$work"; say "the release has nothing for $PLATFORM; building from source"; return 1; }
    fetch "$base/$archive" "$work/$archive" "$expected"
    if have gh && gh auth status >/dev/null 2>&1; then
        gh attestation verify "$work/$archive" --repo wckdboy/invincible >/dev/null \
            || die "$archive: its build attestation does not verify; not installing it"
        say "build attestation verified (built by wckdboy/invincible's release workflow)"
    fi
    tar -xzf "$work/$archive" -C "$work"
    mkdir -p "$BIN"
    for program in invincible autobot; do
        install -m 0755 "$work/invincible-$PLATFORM/$program" "$BIN/$program"
    done
    rm -rf "$work"
}

build_from_source() {
    if ! have cc; then
        if [ "$OS" = Linux ] && have apt-get && ask "A C compiler is needed to build. Install build-essential with sudo?" y; then
            sudo apt-get update -qq && sudo apt-get install -y -qq build-essential pkg-config
        else
            die "a C compiler is needed (macOS: xcode-select --install; Linux: your distribution's build-essential)"
        fi
    fi

    if [ -x "$HOME/.cargo/bin/cargo" ]; then PATH="$HOME/.cargo/bin:$PATH"; fi
    if ! have cargo; then
        ask "Rust is needed to build. Install it with rustup (into ~/.cargo, no root)?" y \
            || die "install Rust from https://rustup.rs, then run this again"
        curl -fsSL --proto '=https' --tlsv1.2 https://sh.rustup.rs | sh -s -- -y --profile minimal --no-modify-path >&2
        PATH="$HOME/.cargo/bin:$PATH"
    fi

    if [ -d "$SRC/.git" ]; then
        say "updating the source in $SRC"
        git -C "$SRC" fetch --quiet origin "$REF"
        git -C "$SRC" checkout --quiet FETCH_HEAD
    else
        say "getting the source into $SRC"
        mkdir -p "$INV_HOME"
        git clone --quiet "$REPO" "$SRC"
        git -C "$SRC" checkout --quiet "$REF"
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
    (cd "$SRC" && cargo build --release --locked -p invincible -p autobot) >&2
    mkdir -p "$BIN"
    for program in invincible autobot; do
        install -m 0755 "$SRC/target/release/$program" "$BIN/$program"
    done
}

# What was here before: an upgrade restarts the services and keeps the setup.
before=""
if [ -x "$BIN/autobot" ]; then before=$("$BIN/autobot" --version 2>/dev/null | cut -d' ' -f2 || true); fi

install_release || build_from_source
now=$("$BIN/autobot" --version 2>/dev/null | cut -d' ' -f2 || true)
if [ -n "$before" ] && [ "$before" != "$now" ]; then
    say "upgraded invincible and autobot in $BIN: $before -> $now"
else
    say "installed invincible and autobot $now in $BIN"
fi

case ":$PATH:" in
    *":$BIN:"*) ;;
    *)
        line="export PATH=\"$BIN:\$PATH\"  # invincible"
        for profile in "$HOME/.profile" "$HOME/.bashrc" "$HOME/.zshrc"; do
            if [ -f "$profile" ] || [ "$profile" = "$HOME/.profile" ]; then
                grep -qs "# invincible" "$profile" || printf '\n%s\n' "$line" >>"$profile"
            fi
        done
        PATH="$BIN:$PATH"
        warn "added $BIN to PATH in your shell profile; open a new shell to pick it up"
        ;;
esac

# --- 2. llama.cpp ------------------------------------------------------------------------------

LLAMA_DIR="$INV_HOME/llama.cpp"
if have llama-server; then
    say "llama.cpp: $(command -v llama-server)"
elif [ -x "$LLAMA_DIR/llama-server" ]; then
    say "llama.cpp: $LLAMA_DIR/llama-server"
    LLAMA_SERVER="$LLAMA_DIR/llama-server"
elif [ "$OS" = Darwin ] && have brew && ask "Install llama.cpp with Homebrew?" y; then
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
    work=$(mktemp -d)
    trap 'rm -rf "$work"' EXIT
    # shellcheck disable=SC2086 # "<file> <sha256>", split on purpose
    set -- $archive
    fetch "$LLAMA_URL/$1" "$work/llama.tar.gz" "$2"
    mkdir -p "$work/llama" && tar -xzf "$work/llama.tar.gz" -C "$work/llama"
    if [ -n "$runtime" ]; then
        # shellcheck disable=SC2086
        set -- $runtime
        fetch "$LLAMA_URL/$1" "$work/cudart.tar.gz" "$2"
        mkdir -p "$work/cudart" && tar -xzf "$work/cudart.tar.gz" -C "$work/cudart"
    fi
    server=$(find "$work/llama" -type f -name llama-server | head -n 1)
    [ -n "$server" ] || die "the llama.cpp archive has no llama-server"
    rm -rf "$LLAMA_DIR" && mkdir -p "$LLAMA_DIR"
    cp -R "$(dirname "$server")"/. "$LLAMA_DIR"/
    if [ -n "$runtime" ]; then find "$work/cudart" -name '*.so*' -exec cp -P {} "$LLAMA_DIR"/ \; ; fi
    LLAMA_SERVER="$LLAMA_DIR/llama-server"
    say "llama.cpp installed in $LLAMA_DIR"
fi

# --- The sandbox for unattended commands (Linux: bubblewrap) ---------------------------------
# Scheduled tasks, board work and phone recipes run commands sandboxed; without bwrap they are
# refused. macOS has sandbox-exec built in.
if [ "$OS" = Linux ] && ! have bwrap; then
    if have apt-get && ask "Install bubblewrap (the sandbox for unattended agent commands) with sudo?" y; then
        sudo apt-get install -y -qq bubblewrap >&2 || warn "bubblewrap did not install"
    elif have dnf && ask "Install bubblewrap (the sandbox for unattended agent commands) with sudo?" y; then
        sudo dnf install -y -q bubblewrap >&2 || warn "bubblewrap did not install"
    elif have apk && ask "Install bubblewrap (the sandbox for unattended agent commands) with sudo?" y; then
        sudo apk add -q bubblewrap >&2 || warn "bubblewrap did not install"
    fi
    have bwrap || warn "no bubblewrap: the agent's scheduled tasks and recipes will refuse to run commands until it is installed (or [agent] sandbox = \"off\")"
fi

# The gateway finds llama-server on its PATH, unless told where it is.
if [ -n "${LLAMA_SERVER:-}" ]; then
    config="$INV_HOME/config.toml"
    mkdir -p "$INV_HOME"
    if ! grep -qs '^llama_server' "$config"; then
        if grep -qs '^\[engine\]' "$config"; then
            tmp="$config.tmp"
            awk -v line="llama_server = \"$LLAMA_SERVER\"" '{print} /^\[engine\]/{print line}' "$config" >"$tmp" && mv "$tmp" "$config"
        else
            printf '\n[engine]\nllama_server = "%s"\n' "$LLAMA_SERVER" >>"$config"
        fi
    fi
fi

# --- Running services pick up the new binaries ----------------------------------------------

restarted=""
if [ "$OS" = Darwin ]; then
    for label in sh.invincible.gateway sh.invincible.autobot; do
        if launchctl print "gui/$(id -u)/$label" >/dev/null 2>&1; then
            launchctl kickstart -k "gui/$(id -u)/$label" >/dev/null 2>&1 && restarted="$restarted $label"
        fi
    done
elif have systemctl; then
    for unit in invincible.service autobot.service; do
        if systemctl --user is-active --quiet "$unit" 2>/dev/null; then
            systemctl --user restart "$unit" && restarted="$restarted $unit"
        fi
    done
fi
[ -n "$restarted" ] && say "restarted the running services:$restarted"

# --- 3. setup ----------------------------------------------------------------------------------

# Set up already (an upgrade): kept as it is, unless asked for again.
AUTOBOT_DIR="${AUTOBOT_HOME:-$HOME/.autobot}"
if [ -f "$AUTOBOT_DIR/config.toml" ] && grep -qsE '^\[\[(models|cloud)\]\]' "$INV_HOME/config.toml" && [ "${INVINCIBLE_SETUP:-}" != 1 ]; then
    say "done; your setup is kept (\`autobot setup\` changes it, \`autobot doctor\` checks it)"
elif [ "${INVINCIBLE_NO_SETUP:-}" = 1 ]; then
    say "done; run \`autobot setup\` when you are ready"
elif [ -n "$TTY" ]; then
    "$BIN/autobot" setup <"$TTY"
else
    say "done; no terminal to ask questions on, so run \`autobot setup\` next"
fi
