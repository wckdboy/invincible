#!/usr/bin/env bash
# Makes the key Invincible for Android's releases are signed with, once: RSA 4096 in a PKCS#12 file outside the repository,
# its password random and kept in this Mac's login keychain (never printed, never written to a file). A release must
# always be signed with the same key, or a phone won't install it over the last: keep the file, and back it up.
set -euo pipefail
KEYSTORE=${INVINCIBLE_ANDROID_KEYSTORE:-"$HOME/Library/Application Support/Invincible/android/release.p12"}
[[ -e $KEYSTORE ]] && { echo "a release key is there already: $KEYSTORE" >&2; exit 1; }
security find-generic-password -s invincible-android-release -a invincible >/dev/null 2>&1 && { echo "the keychain holds a release key's password already" >&2; exit 1; }
mkdir -p "$(dirname "$KEYSTORE")"
chmod 700 "$(dirname "$KEYSTORE")"
export JAVA_HOME=${JAVA_HOME:-$(/usr/libexec/java_home -v 17)}
INVINCIBLE_KEY_PASSWORD=$(openssl rand -base64 33 | tr -d '\n')
export INVINCIBLE_KEY_PASSWORD
security add-generic-password -s invincible-android-release -a invincible -l "Invincible for Android: release key's password" -w "$INVINCIBLE_KEY_PASSWORD"
"$JAVA_HOME/bin/keytool" -genkeypair -keystore "$KEYSTORE" -storetype PKCS12 -alias invincible -keyalg RSA -keysize 4096 -validity 10950 \
  -dname "CN=Invincible" -storepass:env INVINCIBLE_KEY_PASSWORD -keypass:env INVINCIBLE_KEY_PASSWORD >/dev/null 2>&1
chmod 600 "$KEYSTORE"
echo "made $KEYSTORE; its password is in the login keychain (invincible-android-release)"
"$JAVA_HOME/bin/keytool" -list -v -keystore "$KEYSTORE" -storepass:env INVINCIBLE_KEY_PASSWORD | grep -E "SHA256:" | head -1
