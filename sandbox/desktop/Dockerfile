# The agents' desktop: the workshop image (../Dockerfile) with a display, a window manager, a browser, a terminal, an
# editor, the accessibility bus and the tools that operate them. Every agent's VM is made from it unless it is made
# without a desktop (Computer Use). Built on a sandbox host by `invincible sandbox build --desktop`, after the workshop
# image it is made from. Same rules: unprivileged uid 1000, read-only at runtime, no capabilities. Nothing listens
# outside the VM.
FROM invincible/sandbox:1

USER root
RUN apt-get update \
 && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
      xvfb openbox chromium xdotool scrot x11-utils xauth dbus-x11 python3-websocket \
      xterm mousepad xclip at-spi2-core python3-pyatspi python3-xlib libturbojpeg0 \
      fonts-dejavu-core fonts-liberation fonts-noto-color-emoji fonts-noto-cjk \
 && rm -rf /var/lib/apt/lists/*

# Text is UTF-8 for every process in the VM, not only where Python's own coercion happens to set it (C0: a command
# run without it stopped at the first letter that isn't ASCII).
ENV LANG=C.UTF-8

# No app asks a first-run or restore question: Mousepad never offers to restore a session, which it would after every
# VM that ended without its goodbye. Compiled with GLib's own copy of its compiler (the one its triggers run; the
# command of that name is in a package of its own), and checked as it is built, so an image whose seed didn't take is
# never made.
COPY seed/90_invincible-desktop.gschema.override /usr/share/glib-2.0/schemas/
RUN "$(ls /usr/lib/*/glib-2.0/glib-compile-schemas)" /usr/share/glib-2.0/schemas \
 && GSETTINGS_BACKEND=memory python3 -c "from gi.repository import Gio; v = Gio.Settings.new('org.xfce.mousepad.preferences.file').get_string('session-restore'); assert v == 'never', v"

# One process holds the desktop (deskd: its input, its pictures, its windows, its browser), and one command for the
# agent (and for you, from the console) is its client, a millisecond a command, built here with the workshop's own
# compiler: desktop help.
COPY deskd.py /usr/local/lib/invincible/deskd.py
COPY desktop.c /tmp/desktop.c
RUN cc -O2 -Wall -Wextra -Werror -o /usr/local/bin/desktop /tmp/desktop.c && rm /tmp/desktop.c \
 && chmod 0755 /usr/local/bin/desktop && chmod 0644 /usr/local/lib/invincible/deskd.py

USER 1000:1000
