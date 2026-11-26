# shellcheck shell=bash
# Q-AMP (wckdboy/qamp on sovware.io), pinned to its release and checksum-verified: the SHA-256s are the release's own
# SHA256SUMS. The forge is sign-in only, so nothing here downloads it: install_qamp takes the file you fetched and checks
# it against the pin for this machine. Sourced by remote-setup.sh, which puts it where the node looks for it, in the
# service user's Galahad home (<home>/bin/qamp; GALAHAD_QAMP_BIN names another). The binary is put in place by a rename,
# so a bridge still running the old one keeps running.
QAMP_VERSION=0.1.0
# qamp-0.1.0-x86_64-unknown-linux-gnu (built in rust:1.100-bookworm, glibc 2.36)
QAMP_SHA256_LINUX_X86_64=81d6f7107b616054fd7f7afb5017e86cd01e7c8f0e7b08620f92d8136d2bb0db
# qamp-0.1.0-aarch64-apple-darwin (ad-hoc signed only)
QAMP_SHA256_DARWIN_ARM64=c316bed93f411c8c580d08b242e6b862ea5b9abd3739d04bed3d344360462914

# install_qamp <file> <dir>: <dir>/qamp becomes <file>, which must be Q-AMP $QAMP_VERSION's binary for this machine
# (its pinned SHA-256), or the function fails and leaves <dir> as it was. The copy is what's checked, then renamed.
install_qamp() {
  local file=$1 into=$2 sha actual
  case "$(uname -s)-$(uname -m)" in
    Linux-x86_64) sha=$QAMP_SHA256_LINUX_X86_64 ;;
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
