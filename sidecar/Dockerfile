# Rent sidecar. RunPod REST API v2 `entrypoint` overrides the image ENTRYPOINT
# (OpenAPI BaseContainerConfig, https://api.runpod.io/v2/openapi.json). This image
# sets ENTRYPOINT to the bootstrap, and the node does not send that field, so
# the workload is INVINCIBLE_WORKLOAD rather than a second command in front of
# `vllm serve` or a script the stock image does not have.
FROM debian:bookworm-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends bash ca-certificates python3 rclone \
  && rm -rf /var/lib/apt/lists/*

COPY lib.sh bootstrap.sh drain.sh /opt/invincible/
RUN chmod 755 /opt/invincible/bootstrap.sh /opt/invincible/drain.sh

ENTRYPOINT ["/opt/invincible/bootstrap.sh"]
