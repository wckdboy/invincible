# shellcheck shell=bash
# Q-AMP (wckdboy/qamp on sovware.io), pinned to its release and checksum-verified: the SHA-256s are the release's own
# SHA256SUMS. The forge is sign-in only, so nothing here downloads it: install_qamp takes the file you fetched and checks
# it against the pin for this machine. Sourced by remote-setup.sh, which puts it where the node looks for it, in the
# service user's Invincible home (<home>/bin/qamp; INVINCIBLE_QAMP_BIN names another). The binary is put in place by a rename,
# so a bridge still running the old one keeps running.
QAMP_VERSION=0.3.0
# qamp-0.3.0-x86_64-unknown-linux-gnu (built in rust:1.100-bookworm, glibc 2.36, its paths remapped; it needs glibc 2.34)
QAMP_SHA256_LINUX_X86_64=c6dbf6c7b2709d4edae11a644025925a4411fae86dcccd29a08d551d44f659cf
# qamp-0.3.0-aarch64-unknown-linux-gnu (the same, on 64-bit Arm; it needs glibc 2.34)
QAMP_SHA256_LINUX_AARCH64=b0b1602c8f93ab3b9e7ac44d702a10f5b2b370419469f7e9b2fb575ad4876cfe
# qamp-0.3.0-aarch64-apple-darwin (Rust 1.100.0, its paths remapped, ad-hoc signed only)
QAMP_SHA256_DARWIN_ARM64=03578a5b3d5e4ba0b1dd4c75e61f214a30b163a182a827f6f696dc129b6b81ef

# install_qamp <file> <dir>: <dir>/qamp becomes <file>, which must be Q-AMP $QAMP_VERSION's binary for this machine
# (its pinned SHA-256), or the function fails and leaves <dir> as it was. The copy is what's checked, then renamed.
install_qamp() {
  local file=$1 into=$2 sha actual
  case "$(uname -s)-$(uname -m)" in
    Linux-x86_64) sha=$QAMP_SHA256_LINUX_X86_64 ;;
    Linux-aarch64) sha=$QAMP_SHA256_LINUX_AARCH64 ;;
    Darwin-arm64) sha=$QAMP_SHA256_DARWIN_ARM64 ;;
    *) echo "no pinned Q-AMP $QAMP_VERSION for $(uname -s) $(uname -m)" >&2; return 1 ;;
  esac
  if [[ ! -f $file ]]; then
    echo "$file: no such file (Q-AMP $QAMP_VERSION's binary for this machine)" >&2
    return 1
  fi
  mkdir -p "$into"
  install -m 0755 "$file" "$into/qamp.new"
  actual=$( (sha256sum "$into/qamp.new" 2>/dev/null || shasum -a 256 "$into/qamp.new") | cut -d' ' -f1)
  if [[ $actual != "$sha" ]]; then
    rm -f "$into/qamp.new"
    echo "$file failed its checksum (it isn't Q-AMP $QAMP_VERSION for this machine): not installed" >&2
    return 1
  fi
  mv -f "$into/qamp.new" "$into/qamp"
  echo "→ Q-AMP $QAMP_VERSION at $into/qamp (checksum-verified)"
}
