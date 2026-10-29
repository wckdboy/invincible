# vLLM preset. The base is vllm/vllm-openai:v0.32.0, pinned by the manifest-list
# digest fetched from registry-1.docker.io on 2026-10-29.
# RunPod REST API v2 `entrypoint` overrides the image ENTRYPOINT, so this image
# sets ENTRYPOINT to the sidecar and the preset command is INVINCIBLE_WORKLOAD.
FROM vllm/vllm-openai@sha256:befccf0e7e4089aa23926bb6f887a85c0d46c2a99e6de5c5ffdf5cb7957c5b34

USER root
RUN apt-get update \
  && apt-get install -y --no-install-recommends bash ca-certificates curl python3 unzip \
  && rm -rf /var/lib/apt/lists/*
COPY install-rclone.sh lib.sh bootstrap.sh drain.sh /opt/invincible/
RUN sh /opt/invincible/install-rclone.sh \
  && chmod 755 /opt/invincible/bootstrap.sh /opt/invincible/drain.sh
ENTRYPOINT ["/opt/invincible/bootstrap.sh"]
