# The hardware tools (C1 step 11): the agents' desktop (../desktop/Dockerfile) with KiCad and FreeCAD, a choice per
# agent (`invincible agents provision <id> --hardware`). Built on a sandbox host after the desktop image it is made from,
# by `invincible sandbox build --hardware`, or the first time an agent's VM needs it. Same rules: unprivileged uid 1000,
# read-only at runtime, no capabilities. Nothing listens outside the VM: KiCad's API server is a socket in its /tmp.
FROM invincible/desktop:1

USER root
# KiCad 9.0.2 (9.0.2+dfsg-1) and FreeCAD 1.0.0 (1.0.0+dfsg-8+deb13u3), Debian trixie's, as C0 measured them (26
# November 2026), from the archive the image already uses: about 1.9 GB installed between them. Without recommends: no
# 3D model library, no symbol or footprint library, no documentation. Each version is checked as the image is built,
# so a release that moved is never made quietly.
RUN apt-get update \
 && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends kicad freecad \
 && rm -rf /var/lib/apt/lists/* \
 && kicad-cli version | grep -q '^9\.0\.2' \
 && HOME=/tmp/freecad-check freecadcmd --version | grep -q 'FreeCAD 1\.0\.0' \
 && rm -rf /tmp/freecad-check

# KiCad's API client (kipy, kicad-python on PyPI), pinned (requirements.txt says why 0.3.0), for board edits on a running
# pcbnew: in a venv of its own that sees Debian's packages, pcbnew's own Python module among them (the SWIG one, in the
# kicad package, for what the API doesn't reach yet). Debian's python3 takes no pip install outside one.
COPY requirements.txt /opt/hardware/requirements.txt
RUN python3 -m venv --system-site-packages /opt/hardware \
 && /opt/hardware/bin/pip install --no-cache-dir --disable-pip-version-check -r /opt/hardware/requirements.txt \
 && /opt/hardware/bin/python -c "import kipy, pcbnew" \
 && chmod -R a+rX /opt/hardware
ENV PATH=/opt/hardware/bin:$PATH INVINCIBLE_IMAGE=hardware

# What stopped their windows in C0, seeded into the agent's own settings as its VM starts, where they aren't there yet
# (hardware-seed): its home is /work, a volume of its own, which no image can fill. KiCad's global footprint and symbol
# library tables (empty: no library is installed), no first-run question, and its API server on, for kipy; FreeCAD
# with no first-start question. What the agent changes after is its own.
COPY seed/ /usr/share/invincible/hardware/
COPY hardware-seed /usr/local/bin/hardware-seed
RUN chmod 0755 /usr/local/bin/hardware-seed && chmod -R a+rX /usr/share/invincible/hardware \
 && HOME=/tmp/seed-check /usr/local/bin/hardware-seed true \
 && test -s /tmp/seed-check/.config/kicad/9.0/fp-lib-table && rm -rf /tmp/seed-check

USER 1000:1000
ENTRYPOINT ["/usr/local/bin/hardware-seed"]
CMD ["sleep", "infinity"]
