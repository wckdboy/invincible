# The workshop where Galahad's knights work. Built on each sandbox host by
# `galahad sandbox build`. Runs unprivileged (uid 1000), read-only at runtime,
# with all capabilities dropped; see packages/sandbox/src/spec.ts.
FROM debian:trixie-slim

RUN apt-get update \
 && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
      ca-certificates curl git unzip jq ripgrep procps python3 python3-venv build-essential \
 && rm -rf /var/lib/apt/lists/*

# Pinned toolchain, installed system-wide and readable by the knight.
ENV BUN_INSTALL=/opt/bun
ENV PATH=/opt/bun/bin:$PATH
RUN curl -fsSL https://bun.sh/install | bash -s "bun-v1.4.4" && chmod -R a+rX /opt/bun

# The platform it is built for, as BuildKit says: amd64 on Ultra, arm64 on a Mac (container build
# --platform linux/arm64). A builder that doesn't say builds for amd64, as before.
ARG TARGETARCH
# Node.js, its long-term-support release, for what a repository's own scripts and gates run with it (`npm test`,
# `npx tsc`, `node build.js`): bun is no node. On 19 and 21 November 2026 real tasks' gates exited 127 for want of it
# (a knight installed it in its VM itself; a trial of its task couldn't be graded). Pinned, and checked against the
# SHA-256 in that release's SHASUMS256.txt, whose signature by a Node release key was checked when it was pinned
# (26.13.1, the 10 November security release). Global installs go to the workspace: the image is read-only.
ARG NODE_VERSION=26.13.1
ARG NODE_SHA256=518674de2b621728a5e4486f5fb3b7d2900bb3cc4aa97969edaa463db99f9778
ARG NODE_SHA256_ARM64=80a330b35415382878df18d41afbd106ea89bfb3be0087d6608e289a14c5cc7d
RUN case "${TARGETARCH:-amd64}" in amd64) asset=x64 sum="${NODE_SHA256}" ;; arm64) asset=arm64 sum="${NODE_SHA256_ARM64}" ;; *) echo "no Node.js is pinned for ${TARGETARCH}" >&2; exit 1 ;; esac \
 && curl -fsSL -o /tmp/node.tgz "https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-${asset}.tar.gz" \
 && echo "${sum}  /tmp/node.tgz" | sha256sum -c - \
 && mkdir -p /opt/node && tar -xzf /tmp/node.tgz -C /opt/node --strip-components=1 \
 && chmod -R a+rX /opt/node && rm /tmp/node.tgz
ENV PATH=/opt/node/bin:$PATH
ENV NPM_CONFIG_PREFIX=/work/.local

# OpenCode, the coding agent for long quests (galahad do --agent opencode). Pinned, and
# checked against its SHA-256 for the platform (each GitHub's own digest of the asset); it
# reaches models only through Galahad's gateway.
ARG OPENCODE_VERSION=2.2.6
ARG OPENCODE_SHA256=08bb21d6326ce740d91cce7ebe88a6536933f6e1e30353b91a06b01f25da306c
ARG OPENCODE_SHA256_ARM64=f2d27600c367e45057d6a16f6a5c2aa8d77b41a9b10d4bc3d849c2f88870e944
RUN case "${TARGETARCH:-amd64}" in amd64) asset=x64 sum="${OPENCODE_SHA256}" ;; arm64) asset=arm64 sum="${OPENCODE_SHA256_ARM64}" ;; *) echo "no OpenCode is pinned for ${TARGETARCH}" >&2; exit 1 ;; esac \
 && curl -fsSL -o /tmp/opencode.tgz "https://github.com/anomalyco/opencode/releases/download/v${OPENCODE_VERSION}/opencode-linux-${asset}.tar.gz" \
 && echo "${sum}  /tmp/opencode.tgz" | sha256sum -c - \
 && mkdir -p /opt/opencode/bin && tar -xzf /tmp/opencode.tgz -C /opt/opencode/bin opencode \
 && chmod 0755 /opt/opencode/bin/opencode && rm /tmp/opencode.tgz
ENV PATH=/opt/opencode/bin:$PATH

# Engram, the notes store a knight's harness may be given (galahad roundtable engram on). Pinned, and
# checked against its SHA-256. A newer one migrates a store when it first opens it, so a bump says what
# becomes of the stores there are. Its store is on the knight's own disk and its update check is off;
# nothing here starts it (a harness does, for the length of a run: packages/brain/src/engram.ts).
ARG ENGRAM_VERSION=3.7.2
ARG ENGRAM_SHA256=8db9d5db1c1574b8b830aac4ffbe86c024014aed6b9a3f0406ac3361a152cdf0
ARG ENGRAM_SHA256_ARM64=cdbbcb68d3e842d3e52e27edccef55e6fe98ce3cdbc90cd79894323b029efb50
RUN case "${TARGETARCH:-amd64}" in amd64) sum="${ENGRAM_SHA256}" ;; arm64) sum="${ENGRAM_SHA256_ARM64}" ;; *) echo "no Engram is pinned for ${TARGETARCH}" >&2; exit 1 ;; esac \
 && curl -fsSL -o /tmp/engram.tgz "https://github.com/Gentleman-Programming/engram/releases/download/v${ENGRAM_VERSION}/engram_${ENGRAM_VERSION}_linux_${TARGETARCH:-amd64}.tar.gz" \
 && echo "${sum}  /tmp/engram.tgz" | sha256sum -c - \
 && mkdir -p /opt/engram/bin && tar -xzf /tmp/engram.tgz -C /opt/engram/bin engram \
 && chmod 0755 /opt/engram/bin/engram && rm /tmp/engram.tgz
ENV PATH=/opt/engram/bin:$PATH
ENV ENGRAM_DATA_DIR=/work/.memory/engram
ENV ENGRAM_NO_UPDATE_CHECK=1

# A login shell sets PATH afresh (/etc/profile), and a knight's commands run in one: this puts the tools
# above back on it (tools-path.sh says why; a directory added to the PATH here is added there too).
COPY tools-path.sh /etc/profile.d/galahad-tools.sh
RUN chmod 0644 /etc/profile.d/galahad-tools.sh

# Web search through Galahad's own SearXNG, via the gateway (no internet needed).
COPY websearch /usr/local/bin/websearch
RUN chmod 0755 /usr/local/bin/websearch

RUN useradd --uid 1000 --create-home --home-dir /home/knight --shell /bin/bash knight \
 && mkdir -p /work && chown 1000:1000 /work

USER 1000:1000
WORKDIR /work
ENV HOME=/work
# What is installed in a VM for itself (a vendor's coding tool) is found, after everything above.
ENV PATH=$PATH:/work/.local/bin
CMD ["sleep", "infinity"]
