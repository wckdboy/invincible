#!/usr/bin/env bash
# Invincible in one line, on a Mac or a Linux machine of yours:
#
#   curl -fsSL https://invincible.sh | bash
#
# It installs Invincible (the latest commit on main, or --ref) with its own pinned, checksum-verified Bun, an `invincible`
# command, and a service that keeps the node running (launchd on a Mac, systemd for you on Linux); founds a fleet on
# this machine (or joins one, with --join); publishes the app on your tailnet when Tailscale is here; and shows the
# code to pair your phone. Run it again to update: the node keeps its home (~/.invincible) and is restarted on the new
# release. Nothing runs as root, and nothing is written outside your home.
#
#   --join <invite>     join a fleet (from `invincible invite` on one of its nodes) instead of founding one
#   --name <name>       this node's name (default: this machine's short host name)
#   --fleet <name>      a new fleet's name (default: camelot)
#   --ref <ref>         which Invincible: a branch, a tag or a commit (default: main)
#   --no-service        don't keep it running as a service (nor publish it: there'd be nothing to publish)
#   --no-expose         don't publish the app on your tailnet
#   --no-pair           don't show the code to pair a phone at the end
#   --plan              say what it would do, and do nothing
#
# Where things go: INVINCIBLE_INSTALL_DIR (default ~/.local/share/invincible), INVINCIBLE_BIN_DIR (~/.local/bin), INVINCIBLE_HOME
# (~/.invincible). INVINCIBLE_SOURCE=<a checkout> installs that, as it stands, instead of downloading (for trying the
# installer itself).
set -euo pipefail

REPO=wckdboy/invincible
REF=main NAME="" FLEET=camelot INVITE="" SERVICE=1 EXPOSE=1 PAIR=1 PLAN=0
while (($#)); do
  case $1 in
    --join) INVITE=${2:?--join needs an invite}; shift ;;
    --name) NAME=${2:?--name needs a name}; shift ;;
    --fleet) FLEET=${2:?--fleet needs a name}; shift ;;
    --ref) REF=${2:?--ref needs a branch, tag or commit}; shift ;;
    --no-service) SERVICE=0 ;;
    --no-expose) EXPOSE=0 ;;
    --no-pair) PAIR=0 ;;
    --plan) PLAN=1 ;;
    -h | --help) sed -n '2,23p' "$0" 2>/dev/null | sed 's/^# \{0,1\}//' || true; exit 0 ;;
    *) echo "unknown option: $1 (--help lists them)" >&2; exit 2 ;;
  esac
  shift
done

say() { printf '\033[1m→\033[0m %s\n' "$*"; }
fail() { printf 'invincible install: %s\n' "$*" >&2; exit 1; }
# In --plan, each change is said, not made.
act() { if ((PLAN)); then printf '  would: %s\n' "$*"; else "$@"; fi; }

case "$(uname -s)" in
  Darwin) OS=mac ;;
  Linux) OS=linux ;;
  *) fail "Invincible runs on macOS and Linux; this is $(uname -s)." ;;
esac
[[ $(id -u) -ne 0 ]] || fail "run it as yourself, not as root: Invincible never runs as root."
for tool in curl tar; do command -v "$tool" >/dev/null || fail "it needs $tool; install it and run this again."; done
[[ $OS == mac ]] || command -v unzip >/dev/null || fail "it needs unzip (for Bun); install it and run this again."

DIR=${INVINCIBLE_INSTALL_DIR:-${XDG_DATA_HOME:-$HOME/.local/share}/invincible}
BIN=${INVINCIBLE_BIN_DIR:-$HOME/.local/bin}
NODE_HOME=${INVINCIBLE_HOME:-$HOME/.invincible}
NAME=${NAME:-$(hostname -s 2>/dev/null || hostname)}
NAME=$(printf '%s' "$NAME" | tr -c 'A-Za-z0-9_-' '-' | cut -c1-40)

# ─── Which Invincible: a commit, so a release is exactly one ───────────────────────────────────────────────────────
if [[ -n ${INVINCIBLE_SOURCE:-} ]]; then
  REV=$(git -C "$INVINCIBLE_SOURCE" rev-parse HEAD 2>/dev/null) || fail "INVINCIBLE_SOURCE isn't a git checkout: $INVINCIBLE_SOURCE"
else
  REV=$(curl -fsSL -H "Accept: application/vnd.github.sha" "https://api.github.com/repos/$REPO/commits/$REF") || fail "couldn't find $REF in $REPO"
fi
[[ $REV =~ ^[0-9a-f]{40}$ ]] || fail "$REF didn't name a commit"
RELEASE=$DIR/releases/${REV:0:12}
say "Invincible ${REV:0:12} ($REF) into $DIR"
((PLAN)) && say "--plan: nothing below is done"

# ─── The release ─────────────────────────────────────────────────────────────────────────────────────────────────
# (A checkout of yours is installed as it stands, changes and all, every time: that's what trying the installer needs.)
if [[ -n ${INVINCIBLE_SOURCE:-} ]] && ((!PLAN)); then rm -f "$RELEASE/.installed"; fi
if [[ -f $RELEASE/.installed ]]; then
  say "already installed: ${REV:0:12}"
else
  act mkdir -p "$DIR/releases"
  STAGE=$DIR/releases/.stage-$$
  if ((PLAN)); then
    printf '  would: fetch %s at %s into %s\n' "$REPO" "${REV:0:12}" "$RELEASE"
  else
    rm -rf "$STAGE" && mkdir -p "$STAGE"
    if [[ -n ${INVINCIBLE_SOURCE:-} ]]; then
      (cd "$INVINCIBLE_SOURCE" && git ls-files -z --cached --others --exclude-standard | xargs -0 tar -cf -) | tar -x -C "$STAGE"
    else
      curl -fsSL "https://codeload.github.com/$REPO/tar.gz/$REV" | tar -xz -C "$STAGE" --strip-components=1
    fi
    echo "$REV" > "$STAGE/REVISION"
    rm -rf "$RELEASE" && mv "$STAGE" "$RELEASE"
  fi
fi

# ─── Bun, Invincible's own: pinned, checksum-verified, never over a Bun of yours ────────────────────────────────────
if ((PLAN)) && [[ ! -f $RELEASE/scripts/bun-pin.sh ]]; then
  BUN=$DIR/bun/bun
  printf '  would: install the pinned Bun into %s\n' "$DIR/bun"
else
  # shellcheck source=scripts/bun-pin.sh
  source "$RELEASE/scripts/bun-pin.sh"
  BUN=$DIR/bun/bun
  if [[ $("$BUN" --version 2>/dev/null || true) != "$BUN_VERSION" ]]; then
    act install_bun "$DIR/bun"
  fi
fi
if [[ ! -f $RELEASE/.installed ]]; then
  if ((PLAN)); then
    printf '  would: install its dependencies (bun install --frozen-lockfile)\n'
  else
    say "its dependencies"
    (cd "$RELEASE" && "$BUN" install --frozen-lockfile >/dev/null)
    touch "$RELEASE/.installed"
  fi
fi
act ln -sfn "$RELEASE" "$DIR/current"

# ─── The invincible command ─────────────────────────────────────────────────────────────────────────────────────────
if ((PLAN)); then
  printf '  would: write %s\n' "$BIN/invincible"
  printf '  would: link %s to it\n' "$BIN/inv"
else
  mkdir -p "$BIN"
  printf '#!/bin/sh\n# Invincible (scripts/install.sh): the node in %s.\nexec "%s" "%s/current/packages/node/src/cli.ts" "$@"\n' "$DIR" "$BUN" "$DIR" > "$BIN/invincible.new"
  chmod 0755 "$BIN/invincible.new" && mv -f "$BIN/invincible.new" "$BIN/invincible"
  # `inv`: the same command, shorter.
  ln -sfn invincible "$BIN/inv"
fi
invincible() { "$BIN/invincible" "$@"; }
case ":$PATH:" in *":$BIN:"*) ;; *) say "add $BIN to your PATH to type invincible anywhere: export PATH=\"$BIN:\$PATH\"" ;; esac

# ─── This node: founded, or joined to your fleet (once; an update keeps it) ──────────────────────────────────────
if [[ -f $NODE_HOME/config.json ]]; then
  NAME=$(sed -n 's/.*"name": *"\([^"]*\)".*/\1/p' "$NODE_HOME/config.json" | head -1)
  say "this machine is already a node ($NODE_HOME): kept as it is"
elif [[ -n $INVITE ]]; then
  say "joining your fleet as $NAME: approve it on the node that invited it"
  act invincible join "$INVITE" --name "$NAME"
else
  say "founding the fleet $FLEET, with this machine as $NAME"
  act invincible init --name "$NAME" --fleet "$FLEET"
fi

# ─── Kept running ────────────────────────────────────────────────────────────────────────────────────────────────
if ((SERVICE)); then
  ((PLAN)) || mkdir -p "$NODE_HOME/logs"
  if [[ $OS == mac ]]; then
    PLIST=$HOME/Library/LaunchAgents/sh.invincible.node.plist
    if ((PLAN)); then
      printf '  would: write %s and start it with launchctl\n' "$PLIST"
    else
      mkdir -p "$(dirname "$PLIST")"
      cat > "$PLIST" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>sh.invincible.node</string>
  <key>ProgramArguments</key><array><string>$BUN</string><string>$DIR/current/packages/node/src/cli.ts</string><string>serve</string></array>
  <key>WorkingDirectory</key><string>$DIR/current</string>
  <key>EnvironmentVariables</key><dict>
    <key>PATH</key><string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
    <key>INVINCIBLE_HOME</key><string>$NODE_HOME</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>$NODE_HOME/logs/node.log</string>
  <key>StandardErrorPath</key><string>$NODE_HOME/logs/node.log</string>
</dict></plist>
PLIST
      launchctl bootout "gui/$(id -u)/sh.invincible.node" 2>/dev/null || true
      launchctl bootstrap "gui/$(id -u)" "$PLIST"
      say "running as a login item (sh.invincible.node); its log: $NODE_HOME/logs/node.log"
    fi
  elif systemctl --user show-environment >/dev/null 2>&1; then
    UNIT=${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user/invincible.service
    if ((PLAN)); then
      printf '  would: write %s and start it with systemctl --user\n' "$UNIT"
    else
      mkdir -p "$(dirname "$UNIT")"
      cat > "$UNIT" <<UNIT
[Unit]
Description=Invincible node
After=network-online.target

[Service]
Environment=INVINCIBLE_HOME=$NODE_HOME
WorkingDirectory=$DIR/current
ExecStart=$BUN $DIR/current/packages/node/src/cli.ts serve
Restart=always
RestartSec=3

[Install]
WantedBy=default.target
UNIT
      systemctl --user daemon-reload
      systemctl --user enable invincible >/dev/null 2>&1
      systemctl --user restart invincible
      say "running as your systemd service (systemctl --user status invincible)"
      if [[ $(loginctl show-user "${USER:-$(id -un)}" -p Linger 2>/dev/null) != "Linger=yes" ]]; then
        say "so it keeps running when you log out: sudo loginctl enable-linger ${USER:-$(id -un)}"
      fi
    fi
  else
    say "no service manager for you here: run it with 'invincible serve'"
    SERVICE=0
  fi
fi

if ((PLAN)); then
  ((SERVICE && EXPOSE)) && printf '  would: publish the app on your tailnet when Tailscale is here\n'
  ((SERVICE && PAIR)) && printf '  would: show the code to pair a phone\n'
  exit 0
fi

# ─── Reachable from your phone, and paired ───────────────────────────────────────────────────────────────────────
if ((SERVICE)); then
  for _ in $(seq 1 30); do invincible status >/dev/null 2>&1 && break; sleep 1; done
  invincible status >/dev/null 2>&1 || fail "the node didn't answer: see $NODE_HOME/logs/node.log (or journalctl --user -u invincible)"
fi
# Published only for a node this run left running: Tailscale Serve is this machine's, and nothing else of it is touched.
if ((!SERVICE || !EXPOSE)); then
  say "to reach it from your phone: invincible expose (with Tailscale on this machine and your phone)"
elif command -v tailscale >/dev/null && tailscale status >/dev/null 2>&1; then
  invincible expose || say "publishing on your tailnet needs your permission once: sudo tailscale set --operator=${USER:-$(id -un)}, then invincible expose"
else
  say "Tailscale isn't running here: install it and sign in on this machine and your phone, then run invincible expose (https://tailscale.com/download)"
fi
# Old releases go; the current one and the one before it stay, to go back to.
find "$DIR/releases" -mindepth 1 -maxdepth 1 -type d ! -name '.stage-*' -print0 2>/dev/null | xargs -0 ls -dt 2>/dev/null | tail -n +3 | while read -r old; do
  [[ $old == "$(readlink "$DIR/current")" ]] || rm -rf "$old"
done
if ((PAIR)) && ((SERVICE)) && [[ -r /dev/tty ]] && [[ -t 1 ]]; then
  say "pair your phone: scan this with its camera, then check the six digits match"
  invincible invite --client </dev/tty || true
else
  say "to pair your phone: invincible invite --client"
fi
say "done: Invincible ${REV:0:12} on $NAME"
