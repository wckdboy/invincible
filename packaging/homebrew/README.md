# Homebrew

`invincible.rb` installs the published release archive — the same bytes the installer and
`invincible update` verify against the signed `SHA256SUMS`. Homebrew checks the same SHA-256, so a
formula install is as good a claim as any other, and `brew audit` re-checks the metadata.

## Try it locally

```sh
brew install ./packaging/homebrew/invincible.rb
invincible --version
autobot setup
```

## Publish it as a tap

1. Copy the file to `Formula/invincible.rb` in a repository named `homebrew-tap` under the owner
   (so the tap is `wckdboy/tap`).
2. `brew install wckdboy/tap/invincible`.

## Updates: brew owns them

A Homebrew install is updated by Homebrew. `invincible update` refuses when its binaries live in a
brew prefix and says `brew upgrade invincible` instead, because replacing Cellar files behind
Homebrew's back leaves its records untrue and breaks the next upgrade.

The installer path (`curl … | sh`) keeps the self-update: signed release, pinned key, atomic swap.

## Keeping the formula current

Bump `version` and the three `sha256` values from the release's published `SHA256SUMS` when a tag
ships. Add macOS Intel and Windows (via `brew` on WSL is not a target) only when there is an
archive to point at — a formula that builds from source needs the Rust toolchain and stops being a
five-minute install.
