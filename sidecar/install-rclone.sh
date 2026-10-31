#!/bin/sh
# Install a pinned rclone binary. The zip digest is from
# https://downloads.rclone.org/v1.68.2/SHA256SUMS (fetched 2026-10-29).
set -eu
url="https://downloads.rclone.org/v1.68.2/rclone-v1.68.2-linux-amd64.zip"
sha="0e6fa18051e67fc600d803a2dcb10ddedb092247fc6eee61be97f64ec080a13c"
curl -fsSL -o /tmp/rclone.zip "${url}"
echo "${sha}  /tmp/rclone.zip" | sha256sum -c -
unzip -q -d /tmp /tmp/rclone.zip
install -m 755 /tmp/rclone-v1.68.2-linux-amd64/rclone /usr/local/bin/rclone
rm -rf /tmp/rclone.zip /tmp/rclone-v1.68.2-linux-amd64
