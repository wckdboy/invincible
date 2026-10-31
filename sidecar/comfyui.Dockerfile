# ComfyUI preset. The base is runpod/comfyui:1.2.1 (CUDA, PyTorch, and ComfyUI),
# pinned by the manifest-list digest fetched from registry-1.docker.io on 2026-10-29.
# The sidecar ENTRYPOINT replaces the image entrypoint. INVINCIBLE_WORKLOAD is /start.sh.
FROM runpod/comfyui@sha256:33bbb3cb8285564563cab752d553925caeecf06f095e4c4d06988c8ebada28f6

USER root
RUN apt-get update \
  && apt-get install -y --no-install-recommends bash ca-certificates curl python3 unzip \
  && rm -rf /var/lib/apt/lists/*
COPY install-rclone.sh lib.sh bootstrap.sh drain.sh /opt/invincible/
RUN sh /opt/invincible/install-rclone.sh \
  && chmod 755 /opt/invincible/bootstrap.sh /opt/invincible/drain.sh
ENTRYPOINT ["/opt/invincible/bootstrap.sh"]
