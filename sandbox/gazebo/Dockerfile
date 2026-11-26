# Gazebo: robotics simulation (Gazebo Harmonic: gz-sim 8, headless, DART physics).
# Same rules as the workshop image (../Dockerfile): unprivileged uid 1000, read-only
# at runtime, no capabilities.
# Ubuntu 24.04, because Open Robotics publishes Gazebo for Ubuntu (Debian doesn't
# package gz-sim). No GUI and no rendering: physics only, which needs no GPU.
FROM ubuntu:24.04

ARG GZ_SIM_VERSION=8.15.0-1~noble

RUN apt-get update \
 && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends ca-certificates curl gnupg \
 && curl -fsSL https://packages.osrfoundation.org/gazebo.gpg -o /usr/share/keyrings/pkgs-osrf-archive-keyring.gpg \
 && echo "deb [arch=amd64 signed-by=/usr/share/keyrings/pkgs-osrf-archive-keyring.gpg] http://packages.osrfoundation.org/gazebo/ubuntu-stable noble main" > /etc/apt/sources.list.d/gazebo-stable.list \
 && apt-get update \
 && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
      git jq procps file python3 python3-numpy \
      gz-tools2 gz-sim8-cli=${GZ_SIM_VERSION} libgz-sim8=${GZ_SIM_VERSION} libgz-sim8-plugins=${GZ_SIM_VERSION} \
      python3-gz-sim8=${GZ_SIM_VERSION} python3-gz-math7 python3-gz-msgs10 python3-gz-transport13 libgz-physics7-dartsim \
 && rm -rf /var/lib/apt/lists/* \
# Gazebo loads DART by its unversioned name; only the -dev package (headers, ~1 GB) ships that link.
 && ln -s libgz-physics7-dartsim-plugin.so.7 /usr/lib/x86_64-linux-gnu/gz-physics-7/engine-plugins/libgz-physics-dartsim-plugin.so

COPY gz-check /usr/local/bin/gz-check
COPY websearch /usr/local/bin/websearch
RUN chmod 0755 /usr/local/bin/gz-check /usr/local/bin/websearch

# Ubuntu's image already has uid 1000 ("ubuntu"); the knight takes its place.
RUN userdel --remove ubuntu 2>/dev/null; useradd --uid 1000 --create-home --home-dir /home/knight --shell /bin/bash knight \
 && mkdir -p /work && chown 1000:1000 /work

USER 1000:1000
WORKDIR /work
# Transport stays on loopback (no discovery across a sandbox's network).
ENV HOME=/work GZ_SIM_RESOURCE_PATH=/work GZ_IP=127.0.0.1
CMD ["sleep", "infinity"]
