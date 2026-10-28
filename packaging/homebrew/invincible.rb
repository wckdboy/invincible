class Invincible < Formula
  desc "The node you own: a self-hosted AI gateway with a signed receipt for every call"
  homepage "https://invincible.sh"
  version "0.0.21"
  license "MIT"

  # The release archives are the same signed, reproducible ones the installer and
  # `invincible update` verify: https://github.com/wckdboy/invincible/releases
  # The checksums below are the published SHA256SUMS, not recomputed here.
  on_macos do
    on_arm do
      url "https://github.com/wckdboy/invincible/releases/download/v0.0.21/invincible-macos-arm64.tar.gz"
      sha256 "808f90e564011498497ae770100d1c11fc01bae9595b82665eb7c8b30ce8ce11"
    end
    # Intel Macs have no release archive yet; building from source would need the Rust toolchain.
  end

  on_linux do
    on_intel do
      url "https://github.com/wckdboy/invincible/releases/download/v0.0.21/invincible-linux-x64.tar.gz"
      sha256 "55a8bb06a1dd1f5f280c2e58e449500366811fdfe61b1a01f7223f4ebfd4b35c"
    end
    on_arm do
      url "https://github.com/wckdboy/invincible/releases/download/v0.0.21/invincible-linux-arm64.tar.gz"
      sha256 "9e1077b50d4e4890b4b4f0eb2fa7dda1a55b161361778f7bf7b29206e59361c9"
    end
  end

  def install
    # Each archive holds one directory with both programs.
    bin.install Dir["*/invincible"] + Dir["*/autobot"]
    doc.install Dir["*/README.md"] if Dir["*/README.md"].any?
  end

  def caveats
    <<~EOS
      Set the node up first (it asks about the network, a model and the services):

        autobot setup

      Then it runs at login as a launchd agent or a systemd user unit:

        autobot service status

      Your data stays in ~/.invincible and ~/.autobot.

      Updates install with Homebrew, not by itself:
        brew upgrade invincible

      (`invincible update` refuses while the binaries are in a Homebrew prefix, so the
      Cellar's records stay true.)
    EOS
  end

  test do
    assert_match version.to_s, shell_output("#{bin}/invincible --version")
    assert_path_exists bin/"autobot"
  end
end
