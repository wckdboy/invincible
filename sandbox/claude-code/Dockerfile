# For trials alone (galahad trial … --variant …:agent=claude): the workshop image (../Dockerfile) with Claude Code,
# pinned and checked, so that a run can put Anthropic's own harness and Galahad's to the same tasks on the same model.
# It runs on a roster model through the gateway, by Claude Code's documented way to another endpoint, on the
# sandbox's scoped token: no sign-in, no subscription, no key. A knight's VM never gets it from Galahad
# (packages/brain/src/vendor-cli.ts): there, its owner installs and signs in the tool. Built on a sandbox host the
# first time a trial needs it, after the workshop image it is made from. Same rules: unprivileged uid 1000, read-only
# at runtime, no capabilities.
FROM galahad/sandbox:1

ARG TARGETARCH
# The release and its checksums as Anthropic's signed manifest gives them:
# https://downloads.claude.ai/claude-code-releases/<version>/manifest.json. A new pin is a new image tag
# (CLAUDE_CODE_IMAGE in packages/sandbox/src/spec.ts), so a host never runs the old one under the new name.
ARG CLAUDE_CODE_VERSION=2.1.319
ARG CLAUDE_CODE_SHA256=dabafec82ca1319fa43d8be36a10fc61b1d11821cb98ad5df04ad95e199b8eed
ARG CLAUDE_CODE_SHA256_ARM64=a7e687fd1cb054d651c7588223de3786c99d4c682365e3c3ae1e59ce7f3a591f
USER root
RUN case "${TARGETARCH:-amd64}" in amd64) platform=linux-x64 sum="${CLAUDE_CODE_SHA256}" ;; arm64) platform=linux-arm64 sum="${CLAUDE_CODE_SHA256_ARM64}" ;; *) echo "no Claude Code is pinned for ${TARGETARCH}" >&2; exit 1 ;; esac \
 && curl -fsSL -o /tmp/claude "https://downloads.claude.ai/claude-code-releases/${CLAUDE_CODE_VERSION}/${platform}/claude" \
 && echo "${sum}  /tmp/claude" | sha256sum -c - \
 && install -m 0755 /tmp/claude /usr/local/bin/claude && rm /tmp/claude
# It never updates itself past the pin, nor reports on itself: a trial's sandbox reaches its models and nothing else.
ENV DISABLE_UPDATES=1 \
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1

USER 1000:1000
