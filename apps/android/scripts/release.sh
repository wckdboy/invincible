#!/usr/bin/env bash
# Invincible for Android, built for release: shrunk and optimized by R8, signed with the release key (scripts/make-key.sh:
# outside the repository, its password in this Mac's keychain), and checked with apksigner before it's handed out.
# Each build is numbered by its time (UTC, yyyymmddHHMM), as the Apple app's are; its version code is the minutes since
# 2026 began, so each installs over the last.
#
#   apps/android/scripts/release.sh            → apps/android/build/release/Invincible-<build>.apk
set -euo pipefail
cd "$(dirname "$0")/.."
KEYSTORE=${INVINCIBLE_ANDROID_KEYSTORE:-"$HOME/Library/Application Support/Invincible/android/release.p12"}
[[ -f $KEYSTORE ]] || { echo "no release key at $KEYSTORE: scripts/make-key.sh makes one" >&2; exit 1; }
BUILD=${BUILD_NUMBER:-$(date -u +%Y%m%d%H%M)}
[[ $BUILD =~ ^20[0-9]{10}$ ]] || { echo "a build number is yyyymmddHHMM" >&2; exit 1; }
export JAVA_HOME=${JAVA_HOME:-$(/usr/libexec/java_home -v 17)}
export ANDROID_HOME=${ANDROID_HOME:-$HOME/Library/Android/sdk}
INVINCIBLE_ANDROID_KEYSTORE_PASSWORD=$(security find-generic-password -s invincible-android-release -a invincible -w)
export INVINCIBLE_ANDROID_KEYSTORE="$KEYSTORE" INVINCIBLE_ANDROID_KEYSTORE_PASSWORD
./gradlew :app:testDebugUnitTest :app:assembleRelease -Pinvincible.build="$BUILD" --console=plain -q
APK=app/build/outputs/apk/release/app-release.apk
TOOLS=$(ls -d "$ANDROID_HOME"/build-tools/* | sort -V | tail -1)
"$TOOLS/apksigner" verify --min-sdk-version 29 "$APK"
mkdir -p build/release
OUT=build/release/Invincible-$BUILD.apk
cp "$APK" "$OUT"
echo "built $OUT ($(du -k "$OUT" | cut -f1) KB), signed by:"
"$TOOLS/apksigner" verify --print-certs "$APK" | grep -E "certificate SHA-256 digest" | head -1
