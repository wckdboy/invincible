#!/usr/bin/env bash
# A release of Invincible for the Mac, ready to go out, and the feed that offers it as an update:
#   - built (Release), numbered by the time (UTC, yyyymmddHHMM, as TestFlight's builds are): Sparkle offers a build whose
#     number is higher than the one running, so each release is newer than the last;
#   - its node bundled and everything signed with the Developer ID (mac-node-bundle.sh), notarized and stapled;
#   - zipped, and signed for Sparkle with the owner's key: the login keychain's `invincible` account, made by Sparkle's
#     generate_keys. The key is never printed and never in the repository; its public half is in project.yml;
#   - the feed written for that one release: apps/site/public/mac/appcast.xml, which the site's deploy serves at
#     https://invincible.sh/mac/appcast.xml. Its archive is the GitHub release mac-<build>, too big for the site.
#
#   apps/apple/scripts/mac-release.sh     then publish as it says: the release first, then the feed (commit it and land it through a pull request)
#
# Needs Xcode, xcodegen, the Developer ID and the notarytool profile invincible-notary in this Mac's keychain, and Sparkle's
# tools, which the build resolves into build/SourcePackages.
set -euo pipefail
cd "$(dirname "$0")/.."

REPO=wckdboy/invincible
BUILD=$(date -u +%Y%m%d%H%M)
# The commit this release is of: its tag goes on it (scripts/release-tag.sh).
COMMIT=$(git rev-parse HEAD)
VERSION=$(awk -F'"' '/MARKETING_VERSION:/ {print $2; exit}' project.yml)
MIN_MACOS=$(awk -F'"' '/^    macOS:/ {print $2; exit}' project.yml)
APP=build/Build/Products/Release/Invincible.app
OUT=build/mac-release/$BUILD
NAME=Invincible-for-Mac-$BUILD.zip
FEED=../site/public/mac/appcast.xml

grep -q 'INVINCIBLE_SPARKLE_PUBLIC_KEY: "[A-Za-z0-9+/=]\{40,\}"' project.yml || { echo "project.yml carries no Sparkle public key: an app built so can't update" >&2; exit 1; }
mkdir -p "$OUT"

echo "→ building $VERSION ($BUILD)"
xcodegen generate --quiet
xcodebuild -quiet -scheme InvincibleMac -configuration Release -destination 'platform=macOS' -derivedDataPath build CURRENT_PROJECT_VERSION="$BUILD" build
INVINCIBLE_MAC_SIGN=developer-id scripts/mac-node-bundle.sh "$APP"

echo "→ notarizing"
ditto -c -k --keepParent "$APP" "$OUT/notarize.zip"
said=$(xcrun notarytool submit "$OUT/notarize.zip" --keychain-profile invincible-notary --wait 2>&1 || true)
rm -f "$OUT/notarize.zip"
grep -q "status: Accepted" <<<"$said" || { echo "notarization didn't accept it:" >&2; grep -E "status:|id:" <<<"$said" >&2; exit 1; }
xcrun stapler staple -q "$APP"
ditto -c -k --keepParent "$APP" "$OUT/$NAME"

echo "→ signing it for Sparkle"
# sign_update prints the enclosure's attributes: sparkle:edSignature="…" length="…"
signed=$(build/SourcePackages/artifacts/sparkle/Sparkle/bin/sign_update --account invincible "$OUT/$NAME")
grep -q '^sparkle:edSignature="[A-Za-z0-9+/=]*" length="[0-9]*"$' <<<"$signed" || { echo "sign_update said something unexpected" >&2; exit 1; }

mkdir -p "$(dirname "$FEED")"
cat > "$FEED" <<XML
<?xml version="1.0" encoding="utf-8"?>
<rss version="2.0" xmlns:sparkle="http://www.andymatuschak.org/xml-namespaces/sparkle">
  <channel>
    <title>Invincible for Mac</title>
    <link>https://invincible.sh</link>
    <item>
      <title>Invincible $VERSION ($BUILD)</title>
      <pubDate>$(LC_ALL=C date -u "+%a, %d %b %Y %H:%M:%S +0000")</pubDate>
      <sparkle:version>$BUILD</sparkle:version>
      <sparkle:shortVersionString>$VERSION</sparkle:shortVersionString>
      <sparkle:minimumSystemVersion>$MIN_MACOS</sparkle:minimumSystemVersion>
      <enclosure url="https://github.com/$REPO/releases/download/mac-$BUILD/$NAME" $signed type="application/octet-stream"/>
    </item>
  </channel>
</rss>
XML

echo "→ ready: apps/apple/$OUT/$NAME, and the feed in apps/site/public/mac/appcast.xml"
echo "  publish the archive first: its tag on sovware.io, then the release on GitHub (a tag made there is deleted by the mirror):"
echo "    GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=remote.github.url GIT_CONFIG_VALUE_0=https://github.com/$REPO.git \\"
echo "      scripts/release-tag.sh mac-$BUILD $COMMIT     (its watch for the mirror is given a github remote for this run only, as apps/android/scripts/publish.sh does)"
echo "    gh release create mac-$BUILD apps/apple/$OUT/$NAME --repo $REPO --verify-tag --title 'Invincible for Mac $VERSION ($BUILD)' --notes '…'"
echo "  then the feed: commit apps/site/public/mac/appcast.xml and land it through a pull request into main (main takes only what passed CI); the site deploys from main"
