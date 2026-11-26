# The vendors' own coding tools, pinned and unmodified (I15; packages/core/src/seats.ts): the workshop image (../Dockerfile)
# with Claude Code and Codex, each fetched by version from its vendor's own release and checked against that platform's
# SHA-256 before it is installed. OpenCode is the workshop's own. Every run of one of these tools is made in a VM from this
# image, sharing the agent's /work, so its owner never installs one. A seat's sign-in is never in the image: each tool
# keeps it in its seat's own home, a volume of its own mounted where the run is. Nothing here changes how a tool behaves:
# no patch and no wrapper, and each tool's own documented setting turns its updates off. Built on a sandbox host the first
# time a VM needs it, after the workshop image it is made from. Same rules: unprivileged uid 1000, read-only at runtime,
# no capabilities.
FROM invincible/sandbox:1

ARG TARGETARCH
USER root

# Claude Code: the release and its checksums as Anthropic's signed manifest gives them
# (https://downloads.claude.ai/claude-code-releases/<version>/manifest.json). Its detached signature (manifest.json.sig)
# was checked when the pin was made, 26 November 2026, as code.claude.com/docs/en/setup says to: a good signature by
# "Anthropic Claude Code Release Signing", key 31DD DE24 DDFA B679 F42D 7BD2 BAA9 29FF 1A7E CACE
# (downloads.claude.ai/keys/claude-code.asc). 2.1.326 was the stable channel's then. A new pin is a new image tag
# (HARNESS_IMAGE in packages/sandbox/src/spec.ts), so a host never runs the old one under the new name.
ARG CLAUDE_CODE_VERSION=2.1.326
ARG CLAUDE_CODE_SHA256=b6b3647d981130dc44fc670846ae97b6cde531ffb667cf9c4d17cfcafb38cb37
ARG CLAUDE_CODE_SHA256_ARM64=98d56f6ffe53469767a74864a38eaf359d62ef557a8de1b1ad524d61a66ec119
RUN case "${TARGETARCH:-amd64}" in amd64) platform=linux-x64 sum="${CLAUDE_CODE_SHA256}" ;; arm64) platform=linux-arm64 sum="${CLAUDE_CODE_SHA256_ARM64}" ;; *) echo "no Claude Code is pinned for ${TARGETARCH}" >&2; exit 1 ;; esac \
 && curl -fsSL -o /tmp/claude "https://downloads.claude.ai/claude-code-releases/${CLAUDE_CODE_VERSION}/${platform}/claude" \
 && echo "${sum}  /tmp/claude" | sha256sum -c - \
 && install -m 0755 /tmp/claude /usr/local/bin/claude && rm /tmp/claude

# Codex: OpenAI's release (github.com/openai/codex, tag rust-v<version>), its static Linux build for the platform, checked
# against the SHA-256 GitHub records for the asset. The tarball holds the one binary, named for its target.
ARG CODEX_VERSION=0.172.0
ARG CODEX_SHA256=a2342a8f7f68f088be30620ccfe9cb84162c93a6b56177855961cda3ed6be392
ARG CODEX_SHA256_ARM64=0b99526c185a4425fe96a2214fb7b6a6a7f7c1471883b7afbebe97e15e83e79e
RUN case "${TARGETARCH:-amd64}" in amd64) target=x86_64-unknown-linux-musl sum="${CODEX_SHA256}" ;; arm64) target=aarch64-unknown-linux-musl sum="${CODEX_SHA256_ARM64}" ;; *) echo "no Codex is pinned for ${TARGETARCH}" >&2; exit 1 ;; esac \
 && curl -fsSL -o /tmp/codex.tgz "https://github.com/openai/codex/releases/download/rust-v${CODEX_VERSION}/codex-${target}.tar.gz" \
 && echo "${sum}  /tmp/codex.tgz" | sha256sum -c - \
 && tar -xzf /tmp/codex.tgz -C /tmp "codex-${target}" \
 && install -m 0755 "/tmp/codex-${target}" /usr/local/bin/codex && rm /tmp/codex.tgz "/tmp/codex-${target}"

# Neither updates itself past its pin. Claude Code by its documented settings (code.claude.com/docs/en/env-vars): no
# update of any kind, and none of its nonessential traffic (telemetry, error reports, feature flags, release notes): a
# VM from this image reaches its vendor only for the work. Codex's only update check is its interactive screen's
# (codex-rs/tui at rust-v0.172.0): `codex exec` and its app server, all a VM runs, have none to turn off.
ENV DISABLE_UPDATES=1 \
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1

USER 1000:1000
