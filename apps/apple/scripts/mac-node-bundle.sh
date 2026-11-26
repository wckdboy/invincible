#!/usr/bin/env bash
# The node inside Invincible for the Mac (docs/MAC.md, M2): puts into a built Invincible.app what makes it a node, then signs it.
#
#   apps/apple/scripts/mac-node-bundle.sh path/to/Invincible.app                                ad hoc: runs on this Mac
#   INVINCIBLE_MAC_SIGN=developer-id apps/apple/scripts/mac-node-bundle.sh path/to/Invincible.app  a release (a Release build)
#
#   Contents/Helpers/bun                                  Bun at the pin in scripts/bun-pin.sh, checksum-verified
#   Contents/Resources/node                               this repository at HEAD (git archive), with what the node runs of
#                                                         its dependencies laid out flat: no development tools, no links out
#   Contents/Library/LaunchAgents/sh.invincible.node.plist   the node's agent, which the app registers (SMAppService)
#
# Then every Mach-O inside is signed, the deepest first: Bun with the hardened runtime and allow-jit alone (and a fixed
# identifier, so the Keychain knows the node's Bun from one release to the next), what the app embeds keeping its own
# entitlements, and the app. INVINCIBLE_MAC_SIGN=developer-id signs with the Developer ID in this Mac's keychain and Apple's
# timestamp (the identity is never printed), everything with the hardened runtime, as notarization asks. Otherwise it is
# signed ad hoc, and only Bun is hardened: ad hoc code has no team, so the hardened runtime's library validation would
# refuse the app its own frameworks (measured: Sparkle, and a Debug build's dylib, "have different Team IDs").
#
# It is a release step, run on a built app, not a build phase of InvincibleMac: measured on the owner's MacBook (16 November),
# it makes the app 165 MB bigger (19 → 184 MB) and takes 8 s with Bun's package cache warm, and it needs the network each
# time (Bun's release) and the whole repository, which Xcode's script sandbox keeps a build phase from; it also carries
# HEAD, not the tree being edited. A build without it is the client alone: the app says so and offers only that.
set -euo pipefail
APP=${1:?usage: mac-node-bundle.sh path/to/Invincible.app}
APP=$(cd "$APP" && pwd)
HERE=$(cd "$(dirname "$0")" && pwd)
REPO=$(git -C "$HERE" rev-parse --show-toplevel)
[[ -x $APP/Contents/MacOS/Invincible && $(/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "$APP/Contents/Info.plist" 2>/dev/null) == sh.invincible.bot.mac ]] ||
  { echo "not Invincible for the Mac (sh.invincible.bot.mac): $APP" >&2; exit 1; }

SIGN=(--force)
# The hardened runtime for the app and what it embeds (Bun has it always).
HARDENED=()
case ${INVINCIBLE_MAC_SIGN:-adhoc} in
  developer-id)
    # The identity's fingerprint, read from the keychain, never printed.
    ID=$(security find-identity -v -p codesigning | awk '/"Developer ID Application: / {print $2; exit}')
    [[ -n $ID ]] || { echo "no Developer ID Application identity in this Mac's keychain" >&2; exit 1; }
    if codesign -d --entitlements - --xml "$APP" 2>/dev/null | grep -q get-task-allow; then
      echo "this build lets a debugger in (get-task-allow), which notarization refuses: build it Release" >&2
      exit 1
    fi
    SIGN+=(--sign "$ID" --timestamp)
    HARDENED=(--options runtime)
    HOW="with the Developer ID and Apple's timestamp, under the hardened runtime"
    ;;
  adhoc)
    SIGN+=(--sign -)
    HOW="ad hoc, to run on this Mac (Bun under the hardened runtime)"
    ;;
  *) echo "INVINCIBLE_MAC_SIGN is developer-id, or unset (ad hoc)" >&2; exit 1 ;;
esac

# codesign, quiet unless it fails; what it says then is scrubbed of any identity's name and team.
sign() {
  local said
  if ! said=$(codesign "${SIGN[@]}" "$@" 2>&1); then
    printf 'codesign failed on %s:\n%s\n' "${*: -1}" "$(sed -E 's/(Developer ID Application|Apple Development|Apple Distribution): [^"]*/\1: …/g; s/\([A-Z0-9]{10}\)/(…)/g' <<<"$said")" >&2
    return 1
  fi
}

REV=$(git -C "$REPO" rev-parse HEAD)
[[ -z $(git -C "$REPO" status --porcelain) ]] || echo "note: the node is HEAD (${REV:0:12}); changes not committed aren't in it" >&2
STAGE=$(mktemp -d "${TMPDIR:-/tmp}/invincible-mac-node.XXXXXX")
trap 'rm -rf "$STAGE"' EXIT
mkdir -p "$STAGE/node"

echo "→ the node at ${REV:0:12}"
git -C "$REPO" archive --format=tar HEAD | tar -x -C "$STAGE/node"
echo "$REV" >"$STAGE/node/REVISION"
# shellcheck source=scripts/bun-pin.sh
source "$REPO/scripts/bun-pin.sh"
install_bun "$STAGE/helpers"
rm -f "$STAGE/helpers/bunx"
echo "→ what the node runs of its dependencies, laid out flat"
(cd "$STAGE/node" && "$STAGE/helpers/bun" install --frozen-lockfile --production --linker hoisted >/dev/null)

machos=0
while IFS= read -r -d '' file; do
  if file -b "$file" | grep -q Mach-O; then
    sign --options runtime "$file"
    machos=$((machos + 1))
  fi
done < <(find "$STAGE/node" -type f \( -perm -u+x -o -name '*.node' -o -name '*.dylib' -o -name '*.so' \) -print0)
sign --options runtime --identifier sh.invincible.bot.mac.bun --entitlements "$HERE/mac-node/bun.entitlements" "$STAGE/helpers/bun"

rm -rf "$APP/Contents/Helpers" "$APP/Contents/Resources/node"
mv "$STAGE/helpers" "$APP/Contents/Helpers"
mv "$STAGE/node" "$APP/Contents/Resources/node"
mkdir -p "$APP/Contents/Library/LaunchAgents"
cp "$HERE/mac-node/sh.invincible.node.plist" "$APP/Contents/Library/LaunchAgents/sh.invincible.node.plist"

# What the app embeds (Sparkle: its XPC services, its helpers, the framework), the deepest first, each keeping its own
# entitlements; then the app.
if [[ -d $APP/Contents/Frameworks ]]; then
  while IFS= read -r -d '' item; do
    if [[ -d $item ]] || file -b "$item" | grep -q Mach-O; then sign ${HARDENED[@]+"${HARDENED[@]}"} --preserve-metadata=entitlements "$item"; fi
  done < <(find "$APP/Contents/Frameworks" -depth \( -name '*.framework' -o -name '*.app' -o -name '*.xpc' -o -name '*.dylib' -o \( -type f -perm -u+x \) \) -print0)
fi
sign ${HARDENED[@]+"${HARDENED[@]}"} --preserve-metadata=entitlements "$APP"
codesign --verify --deep --strict "$APP"

# Gatekeeper refuses an app with a link that leads out of it.
links=0
while IFS= read -r -d '' link; do
  target=$(cd "$(dirname "$link")" && realpath "$(readlink "$link")" 2>/dev/null || true)
  [[ $target == "$APP"/* ]] || { echo "a link leads out of the app, or nowhere: ${link#"$APP"/}" >&2; exit 1; }
  links=$((links + 1))
done < <(find "$APP" -type l -print0)

echo "signed $HOW: $APP"
echo "  the node ${REV:0:12}, Bun $("$APP/Contents/Helpers/bun" --version), $machos Mach-O files among its dependencies, $links links (all inside), $(du -sh "$APP" | cut -f1)"
