# The knights' desktop: the workshop image (../Dockerfile) with a display, a window manager, a browser
# and the tools that operate them, for a knight whose work needs a screen (Computer Use). Built on a
# sandbox host by `galahad sandbox build --desktop`, after the workshop image it is made from. Same rules:
# unprivileged uid 1000, read-only at runtime, no capabilities. Nothing listens outside the VM.
FROM galahad/sandbox:1

USER root
RUN apt-get update \
 && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
      xvfb openbox chromium xdotool scrot x11-utils xauth dbus-x11 python3-websocket \
      fonts-dejavu-core fonts-liberation fonts-noto-color-emoji fonts-noto-cjk \
 && rm -rf /var/lib/apt/lists/*

# One command for the knight (and for you, from the console): desktop help.
COPY desktop /usr/local/bin/desktop
RUN chmod 0755 /usr/local/bin/desktop

USER 1000:1000
