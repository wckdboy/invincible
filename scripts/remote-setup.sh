#!/usr/bin/env bash
# Runs ON the target host, from the staged release (see scripts/deploy.sh). Idempotent.
#   remote-setup.sh <stage> <rev> <mode> <name|-> <fleet|-> <invite|-> <port> <skip-tests> <sudo> <expose|0> <open-firewall> [<embedder>] [<open-qamp>]
# A stage that holds qamp.bin (deploy.sh --qamp <file>) installs it for the node, once it passes its pin (qamp-pin.sh).
set -euo pipefail
STAGE=$1 REV=$2 MODE=$3 NAME=$4 FLEET=$5 INVITE=$6 PORT=$7 SKIP_TESTS=$8 SUDO=$9 EXPOSE=${10} OPEN_FIREWALL=${11} EMBEDDER=${12:-0} OPEN_QAMP=${13:-0}
[[ $NAME == - ]] && NAME=$(hostname -s)
SYSTEM_PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin

# ─── Root phase: never run Invincible as root; use a dedicated service user ───────────
if [[ $(id -u) -eq 0 && -z ${INVINCIBLE_USER_PHASE:-} ]]; then
  SVC=invincible
  SVC_HOME=/var/lib/invincible
  if ! id "$SVC" >/dev/null 2>&1; then
    useradd --system --create-home --home-dir "$SVC_HOME" --shell /bin/bash "$SVC"
    echo "→ created service user $SVC ($SVC_HOME)"
  fi
  for group in docker kvm; do
    if getent group "$group" >/dev/null && ! id -nG "$SVC" | tr ' ' '\n' | grep -qx "$group"; then
      usermod -aG "$group" "$SVC"
      echo "→ $SVC joined group $group"
    fi
  done
  command -v unzip >/dev/null || { echo "→ installing unzip (needed to unpack Bun)"; DEBIAN_FRONTEND=noninteractive apt-get install -y -qq unzip >/dev/null; }

  if [[ $SUDO == 1 ]]; then
    # Full sudo, recorded. visudo validates before anything is installed, so a bad
    # rule can never break sudo for anyone else on the machine.
    TMP=$(mktemp)
    if sudo --version 2>/dev/null | grep -q sudo-rs; then
      # sudo-rs (Ubuntu 25.10+) logs every command to the journal and rejects
      # classic-sudo logging options in the shared sudoers.d.
      cat >"$TMP" <<'SUDOERS'
# Invincible's sudo rights. Remove this file to revoke them.
# sudo-rs logs every command to the journal: journalctl -t sudo
invincible ALL=(ALL:ALL) NOPASSWD: ALL
SUDOERS
      WHERE="journalctl -t sudo"
    else
      cat >"$TMP" <<'SUDOERS'
# Invincible's sudo rights. Remove this file to revoke them.
# Every command is logged to /var/log/invincible-sudo.log; output is recorded for `sudoreplay`.
Defaults:invincible logfile=/var/log/invincible-sudo.log
Defaults:invincible log_output
Defaults:invincible !requiretty
invincible ALL=(ALL:ALL) NOPASSWD: ALL
SUDOERS
      WHERE="/var/log/invincible-sudo.log + sudoreplay"
    fi
    if visudo -cf "$TMP" >/dev/null; then
      install -m 0440 -o root -g root "$TMP" /etc/sudoers.d/invincible
      echo "→ sudo granted to $SVC (audit: $WHERE)"
    else
      visudo -cf "$TMP" >&2 || true
      echo "sudoers rule failed validation; not installed" >&2
    fi
    rm -f "$TMP"
  fi

  chown -R "$SVC:$SVC" "$STAGE"
  runuser -u "$SVC" -- env -i HOME="$SVC_HOME" USER="$SVC" LOGNAME="$SVC" PATH="$SYSTEM_PATH" INVINCIBLE_USER_PHASE=1 \
    bash "$STAGE/scripts/remote-setup.sh" "$@"

  BUN="$SVC_HOME/.bun/bin/bun"
  APP="$SVC_HOME/invincible/app"
  # The tailnet-facing daemon holds the vault, so it runs sandboxed even though the
  # invincible user itself may sudo: a bug in the listener must not be a root shell via sudo.
  # (Docker group membership is still root-equivalent on sandbox hosts: see docs/SECURITY.md #6.)
  # After time-sync.target: an approval's 72-hour deadline is read off this clock, so the node
  # starts once the time is set where the host can say so (the node also refuses to send
  # while its clock reads behind the events it holds: docs/SECURITY.md).
  cat >/etc/systemd/system/invincible.service <<UNIT
[Unit]
Description=Invincible node
After=network-online.target time-sync.target tailscaled.service docker.service invincible-firewall.service
Wants=network-online.target time-sync.target

[Service]
User=$SVC
Group=$SVC
Environment=HOME=$SVC_HOME
Environment=INVINCIBLE_KEYSTORE=file
WorkingDirectory=$APP
ExecStart=$BUN $APP/packages/node/src/cli.ts serve
Restart=always
RestartSec=3
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=$SVC_HOME
ProtectKernelTunables=true
ProtectKernelModules=true
ProtectControlGroups=true
RestrictSUIDSGID=true
LockPersonality=true
SystemCallArchitectures=native

[Install]
WantedBy=multi-user.target
UNIT
  cat >/usr/local/bin/invincible <<WRAPPER
#!/bin/sh
# Run the Invincible CLI as the invincible service user.
CMD="env -i HOME=$SVC_HOME PATH=$SYSTEM_PATH INVINCIBLE_KEYSTORE=file $BUN $APP/packages/node/src/cli.ts"
if [ "\$(id -un)" = "$SVC" ]; then exec \$CMD "\$@"; fi
if [ "\$(id -u)" = 0 ]; then exec runuser -u $SVC -- \$CMD "\$@"; fi
exec sudo -u $SVC \$CMD "\$@"
WRAPPER
  chmod 0755 /usr/local/bin/invincible
  # `inv`: the same command, shorter.
  ln -sfn invincible /usr/local/bin/inv
  if [[ $OPEN_FIREWALL == 1 ]] && command -v ufw >/dev/null && ufw status | grep -q "Status: active"; then
    ufw allow in on tailscale0 to any port "$PORT" proto tcp comment "Invincible link over Tailscale" >/dev/null &&
      echo "→ ufw: allowed $PORT/tcp on tailscale0 only" || echo "ufw rule not added" >&2
    # Sandboxes on the internal gateway network may reach exactly one host port: the model gateway.
    ufw allow in on inv0 to any port 7402 proto tcp comment "Invincible sandboxes to model gateway only" >/dev/null &&
      echo "→ ufw: sandboxes may reach 7402/tcp on inv0 only" || echo "ufw sandbox rule not added" >&2
  fi
  # Q-AMP grants (docs/SECURITY.md): each grant's bridge listens on one UDP port of 7410-7419, on the node's tailnet
  # address alone, and lets one agent's key in. Opted into on its own (deploy.sh --open-qamp); nothing listens there until
  # you grant an agent something, and a grant ends by itself within a day.
  if [[ $OPEN_QAMP == 1 ]] && command -v ufw >/dev/null && ufw status | grep -q "Status: active"; then
    ufw allow in on tailscale0 to any port 7410:7419 proto udp comment "Invincible Q-AMP grant bridges over Tailscale" >/dev/null &&
      echo "→ ufw: allowed 7410-7419/udp on tailscale0 only (Q-AMP grants)" || echo "ufw Q-AMP rule not added" >&2
  fi

  # Sandbox isolation must not depend on UFW being active: Invincible owns its own rules.
  # Sandboxes may reach exactly one host port (the model gateway on inv0), nothing else.
  if command -v docker >/dev/null && command -v iptables >/dev/null; then
    cat >/usr/local/sbin/invincible-firewall <<'FIREWALL'
#!/bin/sh
# Applied before invincible.service and on every boot (idempotent).
set -e
iptables -N INVINCIBLE-SANDBOX 2>/dev/null || iptables -F INVINCIBLE-SANDBOX
iptables -A INVINCIBLE-SANDBOX -i inv0 -p tcp --dport 7402 -j ACCEPT
iptables -A INVINCIBLE-SANDBOX -i inv0 -j DROP
iptables -A INVINCIBLE-SANDBOX -i inv1 -j DROP
iptables -C INPUT -j INVINCIBLE-SANDBOX 2>/dev/null || iptables -I INPUT 1 -j INVINCIBLE-SANDBOX
FIREWALL
    chmod 0755 /usr/local/sbin/invincible-firewall
    cat >/etc/systemd/system/invincible-firewall.service <<'UNIT'
[Unit]
Description=Invincible sandbox firewall (sandboxes reach only the model gateway)
After=network-pre.target docker.service
Before=invincible.service
Wants=network-pre.target

[Service]
Type=oneshot
RemainAfterExit=yes
ExecStart=/usr/local/sbin/invincible-firewall

[Install]
WantedBy=multi-user.target
UNIT
    systemctl daemon-reload
    systemctl enable invincible-firewall.service >/dev/null 2>&1
    systemctl restart invincible-firewall.service && echo "→ sandbox firewall: only 7402/tcp on inv0; inv1 → host blocked (independent of UFW)"
  fi

  # Sandbox workspaces: each sandbox gets its own fixed-size disk, so a runaway job can't fill
  # this machine's. Mounting needs root and the node has none (NoNewPrivileges), so systemd
  # starts the helper as root, once per connection, on a socket only the service user can open.
  # No namespacing options on the helper: its mounts must be visible to Docker.
  if command -v docker >/dev/null && command -v mkfs.ext4 >/dev/null && command -v losetup >/dev/null && [[ -f $APP/sandbox/invincible-workspace ]]; then
    install -m 0755 -o root -g root "$APP/sandbox/invincible-workspace" /usr/local/sbin/invincible-workspace
    cat >/etc/systemd/system/invincible-workspace.socket <<UNIT
[Unit]
Description=Invincible sandbox workspaces (root helper; only $SVC may connect)
Before=invincible.service

[Socket]
ListenStream=/run/invincible-workspace.sock
SocketUser=$SVC
SocketGroup=$SVC
SocketMode=0600
Accept=yes
MaxConnections=8

[Install]
WantedBy=sockets.target
UNIT
    cat >/etc/systemd/system/invincible-workspace@.service <<'UNIT'
[Unit]
Description=Invincible sandbox workspace helper (one request)

[Service]
ExecStart=/usr/local/sbin/invincible-workspace
StandardInput=socket
StandardOutput=socket
StandardError=journal
RuntimeMaxSec=300
NoNewPrivileges=yes
CapabilityBoundingSet=CAP_SYS_ADMIN CAP_CHOWN CAP_FOWNER CAP_DAC_OVERRIDE
UNIT
    systemctl daemon-reload
    systemctl enable invincible-workspace.socket >/dev/null 2>&1
    systemctl restart invincible-workspace.socket && echo "→ sandbox workspaces: each sandbox gets its own fixed-size disk (invincible-workspace.socket)"
  fi

  # KVM microVMs for code there's no reason to trust: Kata Containers, pinned and checksum-verified
  # (the digest GitHub records for the release asset). Docker uses Kata's shim by name
  # (--runtime io.containerd.kata.v2, found on containerd's PATH), so Docker's own configuration is
  # never touched and nothing restarts. Hardened: the guest enforces each sandbox's seccomp filter,
  # and QEMU runs under its own seccomp sandbox as an unprivileged user.
  KATA_VERSION=4.3.1
  KATA_SHA256=66b35b06f6b41b56f8606ddf3ed3e5660b0971d1e309d903457c4056a0b9eff0
  if [[ -e /dev/kvm && $(uname -m) == x86_64 ]] && command -v docker >/dev/null; then
    if [[ $(/opt/kata/bin/kata-runtime --version 2>/dev/null | head -1) != *" $KATA_VERSION" ]]; then
      command -v zstd >/dev/null || DEBIAN_FRONTEND=noninteractive apt-get install -y -qq zstd >/dev/null
      mkdir -p /var/cache/invincible
      KATA_TAR=/var/cache/invincible/kata-go-static-$KATA_VERSION-amd64.tar.zst
      if ! echo "$KATA_SHA256  $KATA_TAR" | sha256sum -c --quiet - >/dev/null 2>&1; then
        echo "→ downloading Kata Containers $KATA_VERSION (about 1.3 GB, once)"
        curl -fsSL -o "$KATA_TAR.part" "https://github.com/kata-containers/kata-containers/releases/download/$KATA_VERSION/kata-go-static-$KATA_VERSION-amd64.tar.zst" &&
          mv "$KATA_TAR.part" "$KATA_TAR"
      fi
      if echo "$KATA_SHA256  $KATA_TAR" | sha256sum -c --quiet - >/dev/null 2>&1; then
        rm -rf /opt/kata.new && mkdir -p /opt/kata.new && tar --zstd -xf "$KATA_TAR" -C /opt/kata.new ./opt/kata &&
          rm -rf /opt/kata && mv /opt/kata.new/opt/kata /opt/kata && rm -rf /opt/kata.new &&
          echo "→ Kata Containers $KATA_VERSION installed in /opt/kata"
      else
        rm -f "$KATA_TAR.part"
        echo "Kata Containers didn't download or failed its checksum: not installed (sandboxes stay containers)" >&2
      fi
    fi
    if [[ -x /opt/kata/bin/containerd-shim-kata-v2 ]]; then
      mkdir -p /etc/kata-containers
      sed -e 's/^disable_guest_seccomp = true$/disable_guest_seccomp = false/' \
        -e 's/^seccompsandbox = ""$/seccompsandbox = "on,obsolete=deny,elevateprivileges=deny,spawn=deny,resourcecontrol=deny"/' \
        -e 's/^rootless = false$/rootless = true/' \
        /opt/kata/share/defaults/kata-containers/configuration-qemu.toml >/etc/kata-containers/configuration.toml.new
      if [[ $(grep -c -E '^(disable_guest_seccomp = false|seccompsandbox = "on,|rootless = true)' /etc/kata-containers/configuration.toml.new) == 3 ]]; then
        mv /etc/kata-containers/configuration.toml.new /etc/kata-containers/configuration.toml
        ln -sf /opt/kata/bin/containerd-shim-kata-v2 /usr/local/bin/containerd-shim-kata-v2
        echo "→ sandboxes can run as KVM microVMs (Kata: rootless QEMU, its seccomp sandbox, seccomp in the guest)"
      else
        # Never run microVMs with weaker settings than these: leave the shim off the PATH instead.
        rm -f /etc/kata-containers/configuration.toml.new /usr/local/bin/containerd-shim-kata-v2
        echo "Kata's configuration changed shape; microVMs left off until the hardening applies" >&2
      fi
    fi
  fi

  # Sandbox host: build (or refresh, from cache) the agents' image before the node starts.
  if command -v docker >/dev/null && docker info >/dev/null 2>&1; then
    if runuser -u "$SVC" -- env -i HOME="$SVC_HOME" PATH="$SYSTEM_PATH" docker build -q -t invincible/sandbox:1 "$APP/sandbox" >/dev/null; then
      echo "→ sandbox image ready (invincible/sandbox:1)"
      # The Lab (mathematics, physics, engineering): long to build the first time, cached after.
      echo "→ building the Lab image (the first build takes 10 minutes or more)"
      if runuser -u "$SVC" -- env -i HOME="$SVC_HOME" PATH="$SYSTEM_PATH" docker build -q -t invincible/lab:1 "$APP/sandbox/lab" >/dev/null; then
        LAB=$(docker run --rm --read-only --tmpfs /tmp:rw,nosuid,nodev,size=1g,mode=1777 --mount type=volume,dst=/work \
          --user 1000:1000 --cap-drop ALL --security-opt no-new-privileges:true --network none invincible/lab:1 lab-check 2>/dev/null | tail -1 || true)
        echo "→ Lab image ready: ${LAB:-lab-check gave no report}"
      else
        echo "Lab image build failed; sandboxes still work, without the Lab" >&2
      fi
      # The agents' desktop (a display, a window manager, a browser): made from the image above, a minute or two the first time.
      if runuser -u "$SVC" -- env -i HOME="$SVC_HOME" PATH="$SYSTEM_PATH" docker build -q -t invincible/desktop:1 "$APP/sandbox/desktop" >/dev/null; then
        DESK=$(docker run --rm --read-only --tmpfs /tmp:rw,nosuid,nodev,size=1g,mode=1777 --mount type=volume,dst=/work \
          --user 1000:1000 --cap-drop ALL --security-opt no-new-privileges:true --network none invincible/desktop:1 desktop start 2>&1 | tail -1 || true)
        echo "→ desktop image ready: ${DESK:-desktop start gave no report}"
      else
        echo "desktop image build failed; sandboxes still work, without a desktop" >&2
      fi
      if [[ -e /usr/local/bin/containerd-shim-kata-v2 ]]; then
        GUEST=$(docker run --rm --runtime io.containerd.kata.v2 --network none --user 1000:1000 invincible/sandbox:1 uname -r 2>&1 | tail -1 || true)
        [[ -n $GUEST && $GUEST != "$(uname -r)" ]] && echo "→ microVM check: a sandbox booted its own kernel ($GUEST)" || echo "microVM check failed: $GUEST" >&2
      fi
    else
      echo "sandbox image build failed; the node will run without sandbox hosting" >&2
    fi

    # Web search: Invincible's own SearXNG, on loopback only (the node proxies it to you, to
    # agents and to sandboxes through their gateway). Pinned by digest; replaced only when
    # the pin changes; its secret key is made once and stays on this host.
    SEARX_IMAGE="searxng/searxng:2026.11.6-ac11e14c5@sha256:c750ee1d859b26d3aeae51c07f6a48c3a0bfbaa9195d71a18b258862d88c4c3c"
    install -d -m 0755 /etc/invincible/searxng
    if [[ ! -s /etc/invincible/searxng/settings.yml ]]; then
      SEARX_SECRET=$(head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n')
      printf 'use_default_settings: true\nserver:\n  secret_key: "%s"\n  limiter: false\n  public_instance: false\n  image_proxy: false\nsearch:\n  formats: [html, json]\n  safe_search: 0\n' "$SEARX_SECRET" > /etc/invincible/searxng/settings.yml
      unset SEARX_SECRET
    fi
    if [[ $(docker inspect -f '{{.Config.Image}}' invincible-searxng 2>/dev/null) != "$SEARX_IMAGE" ]]; then
      docker rm -f invincible-searxng >/dev/null 2>&1 || true
      docker run -d --name invincible-searxng --restart unless-stopped -p 127.0.0.1:8889:8080 \
        -v /etc/invincible/searxng:/etc/searxng --label dev.invincible.service=search \
        --cap-drop ALL --cap-add CHOWN --cap-add SETGID --cap-add SETUID --cap-add DAC_OVERRIDE \
        --security-opt no-new-privileges "$SEARX_IMAGE" >/dev/null || echo "web search couldn't start; Invincible works without it" >&2
    fi
    for _ in $(seq 1 30); do
      [[ $(curl -s -o /dev/null -w '%{http_code}' 'http://127.0.0.1:8889/search?q=invincible&format=json') == 200 ]] && { echo "→ web search ready (SearXNG on 127.0.0.1:8889)"; break; }
      sleep 2
    done
  fi

  # The archive's embedder, only with --embedder: Ollama, pinned and checksum-verified (the digest
  # GitHub records for the release asset), as its own unprivileged service listening on 127.0.0.1
  # only, with one embedding model whose layer digest is checked against the one pinned here. So the
  # archive's words never leave this machine to be embedded. Without the flag nothing here runs, and
  # an install from an earlier deploy is left as it is.
  OLLAMA_VERSION=0.40.7
  OLLAMA_SHA256=7f082e625b4c334df84ed1558fe282d6d8091fe3545790aef30b3a9c50d44d41
  EMBED_MODEL=qwen3-embedding:0.6b
  EMBED_MODEL_DIGEST=sha256:06507c7b42688469c4e7298b0a1e16deff06caf291cf0a5b278c308249c3e439
  EMBEDDER_READY=0
  if [[ $EMBEDDER == 1 ]]; then
    if [[ $(uname -m) != x86_64 ]]; then
      echo "no pinned Ollama for $(uname -m): the archive keeps searching by words" >&2
    else
      if [[ $(/opt/ollama/bin/ollama --version 2>/dev/null | grep -o '[0-9]\+\.[0-9]\+\.[0-9]\+' | tail -1) != "$OLLAMA_VERSION" ]]; then
        command -v zstd >/dev/null || DEBIAN_FRONTEND=noninteractive apt-get install -y -qq zstd >/dev/null
        mkdir -p /var/cache/invincible
        OLLAMA_TAR=/var/cache/invincible/ollama-linux-amd64-$OLLAMA_VERSION.tar.zst
        if ! echo "$OLLAMA_SHA256  $OLLAMA_TAR" | sha256sum -c --quiet - >/dev/null 2>&1; then
          echo "→ downloading Ollama $OLLAMA_VERSION (about 1.5 GB, once)"
          curl -fsSL -o "$OLLAMA_TAR.part" "https://github.com/ollama/ollama/releases/download/v$OLLAMA_VERSION/ollama-linux-amd64.tar.zst" &&
            mv "$OLLAMA_TAR.part" "$OLLAMA_TAR"
        fi
        if echo "$OLLAMA_SHA256  $OLLAMA_TAR" | sha256sum -c --quiet - >/dev/null 2>&1; then
          rm -rf /opt/ollama.new && mkdir -p /opt/ollama.new && tar --zstd -xf "$OLLAMA_TAR" -C /opt/ollama.new &&
            [[ -x /opt/ollama.new/bin/ollama ]] && rm -rf /opt/ollama && mv /opt/ollama.new /opt/ollama &&
            echo "→ Ollama $OLLAMA_VERSION installed in /opt/ollama"
        else
          rm -f "$OLLAMA_TAR.part"
          echo "Ollama didn't download or failed its checksum: not installed (the archive keeps searching by words)" >&2
        fi
      fi
      if [[ -x /opt/ollama/bin/ollama ]]; then
        id invincible-ollama >/dev/null 2>&1 || useradd --system --home-dir /var/lib/invincible-ollama --create-home --shell /usr/sbin/nologin invincible-ollama
        install -d -m 0700 -o invincible-ollama -g invincible-ollama /var/lib/invincible-ollama /var/lib/invincible-ollama/models
        cat >/etc/systemd/system/invincible-ollama.service <<'UNIT'
[Unit]
Description=Invincible's local embedder (Ollama, loopback only)
After=network-online.target
Before=invincible.service

[Service]
User=invincible-ollama
Group=invincible-ollama
Environment=HOME=/var/lib/invincible-ollama
Environment=OLLAMA_HOST=127.0.0.1:11434
Environment=OLLAMA_MODELS=/var/lib/invincible-ollama/models
Environment=OLLAMA_CONTEXT_LENGTH=8192
Environment=OLLAMA_KEEP_ALIVE=30m
ExecStart=/opt/ollama/bin/ollama serve
Restart=always
RestartSec=3
# Background work: the node and its sandboxes come first.
Nice=10
CPUWeight=50
NoNewPrivileges=true
PrivateTmp=true
PrivateDevices=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=/var/lib/invincible-ollama
ProtectKernelTunables=true
ProtectKernelModules=true
ProtectControlGroups=true
RestrictSUIDSGID=true
LockPersonality=true
RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX
SystemCallArchitectures=native

[Install]
WantedBy=multi-user.target
UNIT
        systemctl daemon-reload
        systemctl enable invincible-ollama.service >/dev/null 2>&1
        systemctl restart invincible-ollama.service
        for _ in $(seq 1 30); do
          curl -fs -o /dev/null http://127.0.0.1:11434/api/version && break
          sleep 1
        done
        OLLAMA_MANIFEST=/var/lib/invincible-ollama/models/manifests/registry.ollama.ai/library/${EMBED_MODEL%%:*}/${EMBED_MODEL##*:}
        if ! grep -q "$EMBED_MODEL_DIGEST" "$OLLAMA_MANIFEST" 2>/dev/null; then
          echo "→ pulling $EMBED_MODEL (about 640 MB, once)"
          runuser -u invincible-ollama -- env HOME=/var/lib/invincible-ollama OLLAMA_HOST=127.0.0.1:11434 /opt/ollama/bin/ollama pull "$EMBED_MODEL" >/dev/null 2>&1 || true
        fi
        # Ollama checks every blob's SHA-256 as it downloads; this checks it's the model pinned here.
        if grep -q "$EMBED_MODEL_DIGEST" "$OLLAMA_MANIFEST" 2>/dev/null; then
          EMBEDDER_READY=1
          echo "→ local embedder ready: $EMBED_MODEL on 127.0.0.1:11434 (invincible-ollama.service)"
        else
          runuser -u invincible-ollama -- env HOME=/var/lib/invincible-ollama OLLAMA_HOST=127.0.0.1:11434 /opt/ollama/bin/ollama rm "$EMBED_MODEL" >/dev/null 2>&1 || true
          echo "$EMBED_MODEL didn't arrive, or isn't the model pinned here: not used (the archive keeps searching by words)" >&2
        fi
      fi
    fi
  fi

  systemctl daemon-reload
  systemctl enable invincible.service >/dev/null 2>&1
  # Restarting the node cuts off any run or investigation it is driving. Wait for running
  # ones to finish (their sandboxes go when they end), up to 30 minutes, then go ahead.
  running_runs() {
    command -v docker >/dev/null || return 0
    docker ps --filter label=dev.invincible=1 --format '{{.Label "dev.invincible.run"}}' 2>/dev/null | grep -c -E '^(q-|inv-|arm\.loop\.)' || true
  }
  # An agent's task runs in its own VM, which is always there: ask the node (as it runs now) which are running.
  # (A restart interrupts them and holds their rooms; on 14 November 2026 a deploy did, mid-review.)
  running_tasks() {
    [[ -x /usr/local/bin/invincible ]] || { echo 0; return; }
    timeout 30 /usr/local/bin/invincible agents 2>/dev/null | grep -c -E '^task-[a-z0-9_-]+ · running · ' || true
  }
  WAITED=0
  while [[ $(( $(running_runs) + $(running_tasks) )) -gt 0 && $WAITED -lt 1800 ]]; do
    [[ $WAITED == 0 ]] && echo "→ waiting for $(running_runs) running run(s) and $(running_tasks) agent task(s) to finish before restarting the node (up to 30 min)"
    sleep 15
    WAITED=$((WAITED + 15))
  done
  [[ $(( $(running_runs) + $(running_tasks) )) -gt 0 ]] && echo "$(running_runs) run(s) and $(running_tasks) agent task(s) still running after 30 min; restarting anyway (they'll be cut off: an agent's task is interrupted and its room held)" >&2
  systemctl restart invincible.service
  if [[ $EXPOSE != 0 ]]; then
    # `tailscale serve` blocks while waiting for Serve/HTTPS to be enabled for the
    # tailnet; never let that hang a deploy. Show its link instead.
    # Serve targets the dedicated "proxied" listener (port + 1), never the local-only port.
    SERVE_OUT=$(timeout 20 tailscale serve --bg --https="$EXPOSE" "http://127.0.0.1:$((PORT + 1))" 2>&1) && SERVE_OK=1 || SERVE_OK=0
    DNS=$(tailscale status --self --json 2>/dev/null | sed -n 's/.*"DNSName": *"\([^"]*\)\.".*/\1/p' | head -1 || true)
    if [[ $SERVE_OK == 1 ]]; then
      echo "→ PWA: https://$DNS:$EXPOSE/  (tailnet only)"
    else
      echo "→ tailscale serve needs a one-time approval for this tailnet; open the link below, then re-run the deploy:"
      echo "$SERVE_OUT" | grep -Eo 'https://login\.tailscale\.com/[^ ]+' | head -1 || echo "$SERVE_OUT" | tail -3
    fi
  fi

  for _ in $(seq 1 30); do
    /usr/local/bin/invincible status >/dev/null 2>&1 && break
    sleep 1
  done
  /usr/local/bin/invincible status
  # The embedder role, once the local model is there: the ollama provider (the preset: 127.0.0.1, no key)
  # if it isn't configured, and the role only if you haven't hired one yourself.
  if [[ $EMBEDDER_READY == 1 ]]; then
    /usr/local/bin/invincible provider list 2>/dev/null | grep -q '^  ollama ' || /usr/local/bin/invincible provider add ollama >/dev/null
    if /usr/local/bin/invincible roster 2>/dev/null | grep -Eq '^  embedder +\(default\)$'; then
      /usr/local/bin/invincible roster set embedder "ollama/$EMBED_MODEL" >/dev/null && echo "→ the archive embeds with ollama/$EMBED_MODEL (the embedder role); its backlog is embedded in the background"
    else
      echo "→ the embedder role is yours already: $(/usr/local/bin/invincible roster 2>/dev/null | grep -E '^  embedder' | sed 's/^  embedder *//')"
    fi
  fi
  rm -rf "$STAGE"
  exit 0
fi

# ─── User phase: install, test, create or join, (user-level service) ───────────────
export PATH="$HOME/.bun/bin:$PATH"
# Servers have no unlocked desktop keychain at boot; device keys live in a 0600 file.
export INVINCIBLE_KEYSTORE=file
# Bun, pinned and checksum-verified (bun-pin.sh), where the service runs it from ($HOME/.bun/bin/bun).
# shellcheck source=scripts/bun-pin.sh
source "$(dirname "${BASH_SOURCE[0]}")/bun-pin.sh"
if [[ $("$HOME/.bun/bin/bun" --version 2>/dev/null || true) != "$BUN_VERSION" ]]; then
  install_bun "$HOME/.bun/bin"
fi
echo "→ bun $(bun --version)"

# Q-AMP, where the deploy shipped its binary: checked against its pin, then put where the node looks (<home>/bin/qamp).
# The node's home is made private first if this is its first deploy (invincible init would make it so; this comes before).
# shellcheck source=scripts/qamp-pin.sh
source "$(dirname "${BASH_SOURCE[0]}")/qamp-pin.sh"
if [[ -f $STAGE/qamp.bin ]]; then
  [[ -d $HOME/.invincible ]] || install -d -m 0700 "$HOME/.invincible"
  install_qamp "$STAGE/qamp.bin" "$HOME/.invincible/bin" || { echo "Q-AMP's binary wasn't installed: not deploying" >&2; exit 1; }
  rm -f "$STAGE/qamp.bin"
fi
# The suite drives the real bridge too, where this host has one (its Q-AMP tests skip, saying so, where it hasn't).
QAMP_FOR_TESTS=""
[[ -x $HOME/.invincible/bin/qamp ]] && QAMP_FOR_TESTS=$HOME/.invincible/bin/qamp

RELEASE="$HOME/invincible/releases/$REV"
mkdir -p "$HOME/invincible/releases"
rm -rf "$RELEASE"
cp -a "$STAGE" "$RELEASE"
# The release knows which commit it is (git archive ships no .git): evals record it.
echo "$REV" > "$RELEASE/REVISION"
cd "$RELEASE"
bun install --frozen-lockfile >/dev/null

if [[ $SKIP_TESTS != 1 ]]; then
  echo "→ running the test suite on this host"
  LOG=$(mktemp)
  if ! env ${QAMP_FOR_TESTS:+"INVINCIBLE_QAMP_BIN=$QAMP_FOR_TESTS"} bun test >"$LOG" 2>&1; then
    tail -30 "$LOG"
    echo "tests failed on this host; not (re)starting the service" >&2
    exit 1
  fi
  tail -4 "$LOG"
  rm -f "$LOG"
fi

# Only now is it `app`, what the node starts from: a release that failed its tests here leaves
# the node's code as it was, on disk as well as running (the CLI and a restart read `app`).
ln -sfn "$RELEASE" "$HOME/invincible/app.next"
mv -T "$HOME/invincible/app.next" "$HOME/invincible/app" 2>/dev/null || { rm -f "$HOME/invincible/app"; mv "$HOME/invincible/app.next" "$HOME/invincible/app"; }
APP="$HOME/invincible/app"
cd "$APP"

if [[ ! -f $HOME/.invincible/config.json ]]; then
  case $MODE in
    found) bun invincible init --name "$NAME" --fleet "$FLEET" --port "$PORT" --keystore file ;;
    join) bun invincible join "$INVITE" --name "$NAME" --port "$PORT" --keystore file ;;
    *) echo "no Invincible node here yet; deploy with --found <fleet> or --join <invite>" >&2; exit 1 ;;
  esac
else
  echo "→ existing node kept ($(grep -o '"name": *"[^"]*"' "$HOME/.invincible/config.json"))"
fi

# Old releases go once this one has passed its tests: keep it, the two deployed before it, and
# the one the node is running from (the old one, until the restart below). Only directories in
# releases/ named like a commit are touched; where systemd can't say what's running, none are.
prune_releases() {
  local releases=$HOME/invincible/releases pid running="" kept=0 name
  local -a ctl
  [[ $(uname) == Linux && -d $releases ]] || return 0
  if [[ -n ${INVINCIBLE_USER_PHASE:-} ]]; then
    ctl=(systemctl)
  elif systemctl --user show-environment >/dev/null 2>&1; then
    ctl=(systemctl --user)
  else
    return 0
  fi
  pid=$("${ctl[@]}" show -p MainPID --value invincible.service 2>/dev/null) || return 0
  if [[ $pid =~ ^[1-9][0-9]*$ ]]; then
    running=$(readlink -f "/proc/$pid/cwd" 2>/dev/null) || return 0
    running=${running##*/}
  fi
  # Newest first; each name is checked before anything is done with it.
  # shellcheck disable=SC2012
  ls -1t "$releases" | while IFS= read -r name; do
    [[ $name =~ ^[0-9a-f]{12,40}$ && -d $releases/$name && ! -L $releases/$name ]] || continue
    [[ $name == "$REV" ]] && continue
    kept=$((kept + 1))
    [[ $kept -le 2 || $name == "$running" ]] && continue
    rm -rf -- "${releases:?}/$name"
    echo "→ removed old release $name"
  done
}
prune_releases || echo "note: old releases were not pruned" >&2

# Root deploys install a hardened system unit in the root phase.
[[ -n ${INVINCIBLE_USER_PHASE:-} ]] && exit 0

BUN="$HOME/.bun/bin/bun"
if [[ $(uname) == Linux ]] && command -v systemctl >/dev/null && systemctl --user show-environment >/dev/null 2>&1; then
  mkdir -p "$HOME/.config/systemd/user"
  cat >"$HOME/.config/systemd/user/invincible.service" <<UNIT
[Unit]
Description=Invincible node
After=network-online.target

[Service]
Environment=INVINCIBLE_KEYSTORE=file
WorkingDirectory=$APP
ExecStart=$BUN $APP/packages/node/src/cli.ts serve
Restart=always
RestartSec=3

[Install]
WantedBy=default.target
UNIT
  systemctl --user daemon-reload
  systemctl --user enable invincible.service >/dev/null 2>&1
  systemctl --user restart invincible.service
  [[ $(loginctl show-user "$USER" -p Linger --value 2>/dev/null) == yes ]] || loginctl enable-linger "$USER" 2>/dev/null ||
    echo "note: run 'sudo loginctl enable-linger $USER' once so Invincible starts at boot without a login"
elif [[ $(uname) == Darwin ]]; then
  PLIST="$HOME/Library/LaunchAgents/dev.invincible.node.plist"
  mkdir -p "$(dirname "$PLIST")" "$HOME/.invincible"
  cat >"$PLIST" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>dev.invincible.node</string>
  <key>ProgramArguments</key><array><string>$BUN</string><string>$APP/packages/node/src/cli.ts</string><string>serve</string></array>
  <key>EnvironmentVariables</key><dict><key>INVINCIBLE_KEYSTORE</key><string>file</string></dict>
  <key>WorkingDirectory</key><string>$APP</string>
  <key>RunAtLoad</key><true/><key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>$HOME/.invincible/node.log</string>
  <key>StandardErrorPath</key><string>$HOME/.invincible/node.log</string>
</dict></plist>
PLIST
  launchctl bootout "gui/$(id -u)/dev.invincible.node" 2>/dev/null || true
  launchctl bootstrap "gui/$(id -u)" "$PLIST"
else
  echo "no service manager found; start it yourself: cd $APP && INVINCIBLE_KEYSTORE=file bun invincible serve" >&2
  exit 0
fi

for _ in $(seq 1 30); do
  bun invincible status >/dev/null 2>&1 && break
  sleep 1
done
bun invincible status
rm -rf "$STAGE"
