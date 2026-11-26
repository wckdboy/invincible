#!/usr/bin/env bash
# Invincible's Apple app to TestFlight: archived for devices, signed by Xcode for your team (automatic signing: its
# distribution certificate and profile are made with the App Store Connect API key the first time), and uploaded to
# App Store Connect, where TestFlight offers it to your testers once Apple has processed it.
#
#   TEAM_ID=… ASC_KEY_ID=… ASC_ISSUER_ID=… ASC_KEY_PATH=/path/to/AuthKey.p8 apps/apple/scripts/testflight.sh
#
# The key is an App Store Connect API team key (Users and Access → Integrations → App Store Connect API) with the
# Admin role, which may make the certificate. This keeps nothing of it: give the path of a file you delete afterwards.
# The team id is given here, never committed. Each upload is a new build, numbered by the time (UTC, yyyymmddHHMM).
# App Store Connect must already hold an app for sh.invincible.bot (My Apps → New App), or the upload says so.
set -euo pipefail
: "${TEAM_ID:?the Apple Developer team id}"
: "${ASC_KEY_ID:?the id of the App Store Connect API key}"
: "${ASC_ISSUER_ID:?its issuer id}"
: "${ASC_KEY_PATH:?the path of its .p8 file}"
[[ $TEAM_ID =~ ^[A-Z0-9]{10}$ ]] || { echo "a team id is ten capitals and digits" >&2; exit 1; }
[[ $ASC_KEY_ID =~ ^[A-Z0-9]{10}$ ]] || { echo "a key id is ten capitals and digits" >&2; exit 1; }
[[ $ASC_ISSUER_ID =~ ^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$ ]] || { echo "an issuer id is a UUID in lowercase" >&2; exit 1; }
[[ -f $ASC_KEY_PATH ]] || { echo "no key file at the path given" >&2; exit 1; }
BUILD=${BUILD_NUMBER:-$(date -u +%Y%m%d%H%M)}
[[ $BUILD =~ ^[0-9]{1,18}$ ]] || { echo "a build number is digits" >&2; exit 1; }

cd "$(dirname "$0")/.."
OUT=build/testflight
rm -rf "$OUT"
mkdir -p "$OUT"
xcodegen generate --quiet
auth=(-allowProvisioningUpdates -authenticationKeyPath "$ASC_KEY_PATH" -authenticationKeyID "$ASC_KEY_ID" -authenticationKeyIssuerID "$ASC_ISSUER_ID")

echo "→ archiving build $BUILD for iOS devices"
xcodebuild -project Invincible.xcodeproj -scheme Invincible -configuration Release -destination 'generic/platform=iOS' \
  -archivePath "$OUT/Invincible.xcarchive" -derivedDataPath build \
  DEVELOPMENT_TEAM="$TEAM_ID" CODE_SIGN_STYLE=Automatic CURRENT_PROJECT_VERSION="$BUILD" \
  "${auth[@]}" archive

# Uploaded straight from the archive, its build number kept as given.
plutil -create xml1 "$OUT/ExportOptions.plist"
plutil -insert method -string app-store-connect "$OUT/ExportOptions.plist"
plutil -insert destination -string upload "$OUT/ExportOptions.plist"
plutil -insert teamID -string "$TEAM_ID" "$OUT/ExportOptions.plist"
plutil -insert signingStyle -string automatic "$OUT/ExportOptions.plist"
plutil -insert uploadSymbols -bool YES "$OUT/ExportOptions.plist"
plutil -insert manageAppVersionAndBuildNumber -bool NO "$OUT/ExportOptions.plist"

echo "→ uploading it to App Store Connect"
xcodebuild -exportArchive -archivePath "$OUT/Invincible.xcarchive" -exportOptionsPlist "$OUT/ExportOptions.plist" -exportPath "$OUT/export" "${auth[@]}"
echo "Uploaded build $BUILD. App Store Connect processes it (a few minutes to an hour), then TestFlight offers it to your testers."
