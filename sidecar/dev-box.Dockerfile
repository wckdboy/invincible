# Dev box. The base is runpod/pytorch:1.0.2-cu1281-torch280-ubuntu2404, pinned by
# the manifest-list digest fetched from registry-1.docker.io on 2026-10-29.
# INVINCIBLE_WORKLOAD is /start.sh, which is that image's own startup.
FROM runpod/pytorch@sha256:0a360022e8de4375af99430f84e8b38951acc397252163a37ceac7204d01be35

USER root
RUN apt-get update \
  && apt-get install -y --no-install-recommends bash ca-certificates curl python3 unzip \
  && rm -rf /var/lib/apt/lists/*
COPY install-rclone.sh lib.sh bootstrap.sh drain.sh /opt/invincible/
RUN sh /opt/invincible/install-rclone.sh \
  && chmod 755 /opt/invincible/bootstrap.sh /opt/invincible/drain.sh
ENTRYPOINT ["/opt/invincible/bootstrap.sh"]
