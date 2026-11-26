#!/usr/bin/env bash
# Puts a release's tag on sovware.io, Galahad's main copy, and waits until its push mirror has brought the tag to
# GitHub, where the release itself is published (GitHub is the public mirror; sovware.io asks you to sign in). A tag
# made on GitHub instead (`gh release create` without --verify-tag) is deleted by the mirror's next sync, and its
# release with it, so a release is always tagged here first and then created on GitHub with --verify-tag.
#
#   scripts/release-tag.sh <mac-<build>|android-<build>> [commit]     (commit: HEAD; it must be on sovware.io's main)
set -euo pipefail
TAG=${1:?a release tag: mac-<build> or android-<build>}
[[ $TAG =~ ^(mac|android)-20[0-9]{10}$ ]] || { echo "a release tag: mac-<build> or android-<build>" >&2; exit 1; }
COMMIT=$(git rev-parse --verify "${2:-HEAD}^{commit}")
git fetch -q origin main
git merge-base --is-ancestor "$COMMIT" origin/main || { echo "${COMMIT:0:8} is not on sovware.io's main: release only what the gate let through" >&2; exit 1; }
if git rev-parse -q --verify "refs/tags/$TAG" >/dev/null; then
  [ "$(git rev-parse "refs/tags/$TAG^{commit}")" = "$COMMIT" ] || { echo "$TAG is already the tag of another commit" >&2; exit 1; }
else
  git tag "$TAG" "$COMMIT"
fi
git push -q origin "refs/tags/$TAG"
# The mirror pushes on every push to sovware.io: seconds, as a rule.
for _ in $(seq 1 60); do
  if [ "$(git ls-remote github "refs/tags/$TAG" | cut -f1)" = "$COMMIT" ]; then echo "$TAG is on sovware.io and GitHub, at ${COMMIT:0:8}"; exit 0; fi
  sleep 5
done
echo "$TAG is on sovware.io, but not on GitHub after five minutes: see the push mirror in sovware.io's amiriteorg/galahad, Settings, Mirror settings" >&2
exit 1
