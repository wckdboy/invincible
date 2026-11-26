# shellcheck shell=bash
# Bun, pinned to the version the repo is developed and tested with, and checksum-verified: the SHA-256s are the
# release's own SHASUMS256.txt, which match the digests GitHub records for the assets. Sourced by remote-setup.sh (a
# server's service user, into $HOME/.bun/bin) and install.sh (anyone's machine, into Galahad's own folder, never over a
# Bun of their own). The binary is put in place by a rename, so a node still running the old one keeps running.
BUN_VERSION=1.4.4

# install_bun <dir>: <dir>/bun becomes Bun $BUN_VERSION, or the function fails and leaves <dir> as it was.
install_bun() {
  local into=$1 target sha dir actual
  case "$(uname -s)-$(uname -m)" in
    Linux-x86_64)
      if grep -qw avx2 /proc/cpuinfo 2>/dev/null; then
        target=linux-x64 sha=bf8ccbfb2b0b80159e0f9a6d15c55317add8077534dbc6130a3edb52fccb395c
      else
        target=linux-x64-baseline sha=e0446eb55995772eb9894bebae9a6be368d985a8b9271ee124486f9946eedd76
      fi
      ;;
    Linux-aarch64 | Linux-arm64) target=linux-aarch64 sha=baa6bb36f51d6e58561e02bbea825038a9df454f673d6d776e8bbf86f8c7850e ;;
    Darwin-x86_64) target=darwin-x64 sha=50a3491f73abc2fe81673171a85762d3bc2cc1680ccecadd983de99adf77977e ;;
    Darwin-arm64) target=darwin-aarch64 sha=c240d7f0ccb90c263a849fcdb09b7ee62630d921348ed6aafda86b9d577bc510 ;;
    *) echo "no pinned Bun $BUN_VERSION for $(uname -s) $(uname -m)" >&2; return 1 ;;
  esac
  echo "→ installing bun $BUN_VERSION ($target, checksum-verified)"
  dir=$(mktemp -d)
  curl -fsSL -o "$dir/bun.zip" "https://github.com/oven-sh/bun/releases/download/bun-v$BUN_VERSION/bun-$target.zip"
  actual=$( (sha256sum "$dir/bun.zip" 2>/dev/null || shasum -a 256 "$dir/bun.zip") | cut -d' ' -f1)
  if [[ $actual != "$sha" ]]; then
    rm -rf "$dir"
    echo "bun-$target.zip failed its checksum: not installed" >&2
    return 1
  fi
  unzip -oq "$dir/bun.zip" -d "$dir"
  mkdir -p "$into"
  install -m 0755 "$dir/bun-$target/bun" "$into/bun.new"
  mv -f "$into/bun.new" "$into/bun"
  ln -sfn bun "$into/bunx"
  rm -rf "$dir"
}
