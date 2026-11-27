#!/usr/bin/env python3
"""deskd: an agent's desktop, held by one process in its VM (BRIEF-C1 step 3).

The `desktop` command is its thin client (desktop.c); the host's session for the owner and the agent's own loop speak
to it the same way, over a socket in the VM that nothing outside the VM can reach. It holds one connection to the
display and does what a process per action did, without the process:

  Display   input by XTEST, capture by MIT-SHM with the pointer drawn in, the window list and the focus
  Watch     a second connection: when the screen last changed (DAMAGE), and the windows that come and go
  Browser   Chromium's debugging port on loopback, as before: its pages, navigations, every call bounded
  Desk      the actions, named as Anthropic's computer toolset names them (screenshot, zoom, left_click, ...), and ours
            (settle, windows, focus, open, text, look, app)

Every action answers at once with what it did, whether the screen changed (and how soon), the focus before and after,
and any window that appeared; a screenshot waits for the screen to settle first (150 ms with nothing drawn, 3 s at most)
and for a navigation the last action started. Pure Python and ctypes over the libraries the image already has; the
display's libraries are loaded only when a display is used, so this file imports anywhere (its tests run on a Mac).
"""
import base64
import ctypes
import fcntl
import hashlib
import json
import os
import re
import select
import signal
import socket
import struct
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.request
import zlib

W, H = 1280, 800
DISPLAY = ":1"
RUN = os.environ.get("INVINCIBLE_DESKTOP_RUN", "/tmp/invincible-desktop")
WAIT = float(os.environ.get("INVINCIBLE_DESKTOP_WAIT", "20"))
PORT = 9222
QUIET = 0.150  # the screen is settled once nothing has been drawn for this long
# The owner's take-over (C1 step 9): it ends after HOLD_IDLE s with no input from them, and after HOLD_MOST s at most;
# an agent's request waits HOLD_WAIT s for it to end before it is told the owner still has the desktop.
HOLD_IDLE, HOLD_MOST = 120.0, 900.0
HOLD_WAIT = float(os.environ.get("INVINCIBLE_DESKTOP_HOLD_WAIT", "30"))
HELD_EXIT = 75  # what an agent's command exits with when the owner has the desktop (EX_TEMPFAIL: try again later)
# The owner's connections: the node's own exec runs its held session as this uid (never the agent's, 1000), on a socket
# of its own, so an agent can't say it is the owner.
OWNER_UID = int(os.environ.get("INVINCIBLE_DESKTOP_OWNER_UID", "1001"))
SETTLE_CAP = 3.0  # and is never waited for longer than this
GRACE = 0.060  # an action's answer waits this long at most for the screen to show it
CDP_BOUND = 2.0  # every call to the browser answers within this, or says it didn't
NAVIGATION_CAP = 10.0  # a navigation an action started is waited for this long at most
SHORT = 40  # text the keyboard has every key for, at most this long, goes key by key; anything else is inserted or pasted
COMMITS = ("Return", "KP_Enter", "Enter")  # keys that commit what was typed: the screen is let settle before them
COMMIT_SETTLE = 1.0  # for this long at most
PASTE_BOUND = 1.0  # a paste is answered once the app has taken the text, or says it didn't within this
MULTI_CLICK = 0.6  # the longest double-click time of the apps on this desktop (Chromium's 0.5 s), and a margin
# What the browser's page says has its focus: whether the page has it, whether what has it takes text, and its tag.
FOCUS_PROBE = ("(() => { const e = document.activeElement; const t = e ? e.tagName : null; const text = !!e && !e.disabled && !e.readOnly && "
               "(e.isContentEditable || t === 'TEXTAREA' || (t === 'INPUT' && /^(text|search|email|url|tel|password|number)$/i.test(e.type || 'text'))); "
               "return [document.hasFocus(), text, t]; })()")
# What the field with the focus holds, once text has gone in: what landed.
FIELD_VALUE = "(() => { const e = document.activeElement; return e ? (e.isContentEditable ? e.textContent : (e.value || '')) : ''; })()"
EYES_FRAMING = ("This is a screenshot of a desktop, 1280 pixels wide and 800 high: x runs right from 0 and y runs down from 0. "
                "Answer from what is on it and nothing else. When asked where something is, give the pixel coordinates of its "
                "centre as x,y; if it is not on the screen, say so.")


class Refused(Exception):
    """What was asked isn't something it does (exit 2): nothing was touched."""


class Failed(Exception):
    """It tried, and it didn't happen (exit 1)."""


class Held(Exception):
    """The owner has taken the desktop over, and an agent's request waited as long as it may (exit HELD_EXIT): nothing done."""


# ---------------------------------------------------------------- the display's libraries (Linux, loaded on first use)

def _proto(lib, name, restype, *argtypes):
    f = getattr(lib, name)
    f.restype = restype
    f.argtypes = list(argtypes)
    return f


class XImage(ctypes.Structure):
    _fields_ = [("width", ctypes.c_int), ("height", ctypes.c_int), ("xoffset", ctypes.c_int), ("format", ctypes.c_int),
                ("data", ctypes.c_void_p), ("byte_order", ctypes.c_int), ("bitmap_unit", ctypes.c_int),
                ("bitmap_bit_order", ctypes.c_int), ("bitmap_pad", ctypes.c_int), ("depth", ctypes.c_int),
                ("bytes_per_line", ctypes.c_int), ("bits_per_pixel", ctypes.c_int), ("red_mask", ctypes.c_ulong),
                ("green_mask", ctypes.c_ulong), ("blue_mask", ctypes.c_ulong), ("obdata", ctypes.c_void_p)]


class ShmInfo(ctypes.Structure):
    _fields_ = [("shmseg", ctypes.c_ulong), ("shmid", ctypes.c_int), ("shmaddr", ctypes.c_void_p), ("readOnly", ctypes.c_int)]


class CursorImage(ctypes.Structure):
    _fields_ = [("x", ctypes.c_short), ("y", ctypes.c_short), ("width", ctypes.c_ushort), ("height", ctypes.c_ushort),
                ("xhot", ctypes.c_ushort), ("yhot", ctypes.c_ushort), ("cursor_serial", ctypes.c_ulong),
                ("pixels", ctypes.POINTER(ctypes.c_ulong)), ("atom", ctypes.c_ulong), ("name", ctypes.c_char_p)]


class XEvent(ctypes.Union):
    _fields_ = [("type", ctypes.c_int), ("pad", ctypes.c_long * 24)]


class XPropertyEvent(ctypes.Structure):
    _fields_ = [("type", ctypes.c_int), ("serial", ctypes.c_ulong), ("send_event", ctypes.c_int), ("display", ctypes.c_void_p),
                ("window", ctypes.c_ulong), ("atom", ctypes.c_ulong), ("time", ctypes.c_ulong), ("state", ctypes.c_int)]


class XClientMessageEvent(ctypes.Structure):
    _fields_ = [("type", ctypes.c_int), ("serial", ctypes.c_ulong), ("send_event", ctypes.c_int), ("display", ctypes.c_void_p), ("window", ctypes.c_ulong),
                ("message_type", ctypes.c_ulong), ("format", ctypes.c_int), ("l", ctypes.c_long * 5)]


class XSelectionRequestEvent(ctypes.Structure):
    _fields_ = [("type", ctypes.c_int), ("serial", ctypes.c_ulong), ("send_event", ctypes.c_int), ("display", ctypes.c_void_p), ("owner", ctypes.c_ulong),
                ("requestor", ctypes.c_ulong), ("selection", ctypes.c_ulong), ("target", ctypes.c_ulong), ("property", ctypes.c_ulong), ("time", ctypes.c_ulong)]


class XSelectionEvent(ctypes.Structure):
    _fields_ = [("type", ctypes.c_int), ("serial", ctypes.c_ulong), ("send_event", ctypes.c_int), ("display", ctypes.c_void_p), ("requestor", ctypes.c_ulong),
                ("selection", ctypes.c_ulong), ("target", ctypes.c_ulong), ("property", ctypes.c_ulong), ("time", ctypes.c_ulong)]


class XWindowAttributes(ctypes.Structure):
    _fields_ = [("x", ctypes.c_int), ("y", ctypes.c_int), ("width", ctypes.c_int), ("height", ctypes.c_int), ("border_width", ctypes.c_int),
                ("depth", ctypes.c_int), ("visual", ctypes.c_void_p), ("root", ctypes.c_ulong), ("class_", ctypes.c_int),
                ("bit_gravity", ctypes.c_int), ("win_gravity", ctypes.c_int), ("backing_store", ctypes.c_int),
                ("backing_planes", ctypes.c_ulong), ("backing_pixel", ctypes.c_ulong), ("save_under", ctypes.c_int),
                ("colormap", ctypes.c_ulong), ("map_installed", ctypes.c_int), ("map_state", ctypes.c_int),
                ("all_event_masks", ctypes.c_long), ("your_event_mask", ctypes.c_long), ("do_not_propagate_mask", ctypes.c_long),
                ("override_redirect", ctypes.c_int), ("screen", ctypes.c_void_p)]


_libs = None
_IGNORE = None


def libs():
    """libX11, libXext, libXtst, libXfixes, libXdamage and libc, with the prototypes used here. Once."""
    global _libs, _IGNORE
    if _libs:
        return _libs
    x = ctypes.CDLL("libX11.so.6")
    ext = ctypes.CDLL("libXext.so.6")
    tst = ctypes.CDLL("libXtst.so.6")
    fixes = ctypes.CDLL("libXfixes.so.3")
    damage = ctypes.CDLL("libXdamage.so.1")
    libc = ctypes.CDLL("libc.so.6", use_errno=True)
    P, I, UL, L, U = ctypes.c_void_p, ctypes.c_int, ctypes.c_ulong, ctypes.c_long, ctypes.c_uint
    _proto(x, "XInitThreads", I)
    _proto(x, "XOpenDisplay", P, ctypes.c_char_p)
    _proto(x, "XCloseDisplay", I, P)
    _proto(x, "XDefaultRootWindow", UL, P)
    _proto(x, "XDefaultScreen", I, P)
    _proto(x, "XDisplayWidth", I, P, I)
    _proto(x, "XDisplayHeight", I, P, I)
    _proto(x, "XDefaultVisual", P, P, I)
    _proto(x, "XDefaultDepth", I, P, I)
    _proto(x, "XSync", I, P, I)
    _proto(x, "XFlush", I, P)
    _proto(x, "XFree", I, P)
    _proto(x, "XGetImage", ctypes.POINTER(XImage), P, UL, I, I, U, U, UL, I)
    _proto(x, "XDestroyImage", I, ctypes.POINTER(XImage))
    _proto(x, "XInternAtom", UL, P, ctypes.c_char_p, I)
    _proto(x, "XGetAtomName", ctypes.c_void_p, P, UL)
    _proto(x, "XGetWindowProperty", I, P, UL, UL, L, L, I, UL, ctypes.POINTER(UL), ctypes.POINTER(I), ctypes.POINTER(UL), ctypes.POINTER(UL), ctypes.POINTER(ctypes.c_void_p))
    _proto(x, "XQueryPointer", I, P, UL, ctypes.POINTER(UL), ctypes.POINTER(UL), ctypes.POINTER(I), ctypes.POINTER(I), ctypes.POINTER(I), ctypes.POINTER(I), ctypes.POINTER(U))
    _proto(x, "XGetInputFocus", I, P, ctypes.POINTER(UL), ctypes.POINTER(I))
    _proto(x, "XGetWindowAttributes", I, P, UL, ctypes.POINTER(XWindowAttributes))
    _proto(x, "XTranslateCoordinates", I, P, UL, UL, I, I, ctypes.POINTER(I), ctypes.POINTER(I), ctypes.POINTER(UL))
    _proto(x, "XSelectInput", I, P, UL, L)
    _proto(x, "XPending", I, P)
    _proto(x, "XNextEvent", I, P, ctypes.POINTER(XEvent))
    _proto(x, "XConnectionNumber", I, P)
    _proto(x, "XDisplayKeycodes", I, P, ctypes.POINTER(I), ctypes.POINTER(I))
    _proto(x, "XGetKeyboardMapping", ctypes.POINTER(UL), P, ctypes.c_ubyte, I, ctypes.POINTER(I))
    _proto(x, "XStringToKeysym", UL, ctypes.c_char_p)
    _proto(x, "XCreateSimpleWindow", UL, P, UL, I, I, U, U, U, UL, UL)
    _proto(x, "XSetSelectionOwner", I, P, UL, UL, UL)
    _proto(x, "XChangeProperty", I, P, UL, UL, UL, I, I, P, I)
    _proto(x, "XSendEvent", I, P, UL, I, L, P)
    handler = ctypes.CFUNCTYPE(I, P, P)
    _proto(x, "XSetErrorHandler", P, handler)
    _proto(ext, "XShmQueryExtension", I, P)
    _proto(ext, "XShmCreateImage", ctypes.POINTER(XImage), P, P, U, I, ctypes.c_char_p, ctypes.POINTER(ShmInfo), U, U)
    _proto(ext, "XShmAttach", I, P, ctypes.POINTER(ShmInfo))
    _proto(ext, "XShmGetImage", I, P, UL, ctypes.POINTER(XImage), I, I, UL)
    _proto(tst, "XTestFakeMotionEvent", I, P, I, I, I, UL)
    _proto(tst, "XTestFakeButtonEvent", I, P, U, I, UL)
    _proto(tst, "XTestFakeKeyEvent", I, P, U, I, UL)
    _proto(fixes, "XFixesGetCursorImage", ctypes.POINTER(CursorImage), P)
    _proto(damage, "XDamageQueryExtension", I, P, ctypes.POINTER(I), ctypes.POINTER(I))
    _proto(damage, "XDamageCreate", UL, P, UL, I)
    _proto(damage, "XDamageSubtract", None, P, UL, UL, UL)
    _proto(libc, "shmget", I, I, ctypes.c_size_t, I)
    _proto(libc, "shmat", P, I, P, I)
    _proto(libc, "shmctl", I, I, I, P)
    x.XInitThreads()
    # A window that goes away between being listed and being read is no reason to end: Xlib's own handler would exit.
    _IGNORE = handler(lambda display, error: 0)
    x.XSetErrorHandler(_IGNORE)
    _libs = {"x": x, "ext": ext, "tst": tst, "fixes": fixes, "damage": damage, "libc": libc}
    return _libs


MODIFIERS = {"ctrl": "Control_L", "control": "Control_L", "shift": "Shift_L", "alt": "Alt_L", "super": "Super_L", "win": "Super_L",
             "meta": "Super_L", "cmd": "Super_L", "altgr": "ISO_Level3_Shift"}
KEY_ALIASES = {"enter": "Return", "return": "Return", "esc": "Escape", "escape": "Escape", "backspace": "BackSpace", "del": "Delete",
               "delete": "Delete", "pageup": "Page_Up", "pagedown": "Page_Down", "pgup": "Page_Up", "pgdn": "Page_Down",
               "space": "space", "tab": "Tab", "up": "Up", "down": "Down", "left": "Left", "right": "Right", "home": "Home",
               "end": "End", "insert": "Insert", "ins": "Insert", "menu": "Menu", "print": "Print"}
WM_NAMES = ("_NET_WM_NAME", "UTF8_STRING", "WM_NAME", "STRING", "WM_CLASS", "_NET_ACTIVE_WINDOW", "WINDOW", "_NET_CLIENT_LIST",
            "_NET_WM_WINDOW_TYPE", "ATOM", "_NET_WM_WINDOW_TYPE_DIALOG", "WM_TRANSIENT_FOR", "_NET_WM_PID", "CARDINAL",
            "_NET_CLIENT_LIST_STACKING", "WM_PROTOCOLS", "WM_DELETE_WINDOW", "PRIMARY", "CLIPBOARD", "TARGETS", "TEXT", "text/plain;charset=utf-8", "text/plain", "DESKD_SELECTION", "AT_SPI_BUS")


class Display:
    """One connection to the display: input, capture, the pointer and the window list."""

    def __init__(self, name=DISPLAY):
        lib = libs()
        self.x, self.ext, self.tst, self.fixes, self.libc = lib["x"], lib["ext"], lib["tst"], lib["fixes"], lib["libc"]
        self.dpy = self.x.XOpenDisplay(name.encode())
        if not self.dpy:
            raise Failed("the display isn't up")
        self.root = self.x.XDefaultRootWindow(self.dpy)
        self.screen = self.x.XDefaultScreen(self.dpy)
        self.w, self.h = self.x.XDisplayWidth(self.dpy, self.screen), self.x.XDisplayHeight(self.dpy, self.screen)
        self.atoms = {n: self.x.XInternAtom(self.dpy, n.encode(), 0) for n in WM_NAMES}
        self.shm = None
        self._keys = None

    # -- capture
    def _attach_shm(self):
        if not self.ext.XShmQueryExtension(self.dpy):
            return None
        info = ShmInfo()
        img = self.ext.XShmCreateImage(self.dpy, self.x.XDefaultVisual(self.dpy, self.screen), self.x.XDefaultDepth(self.dpy, self.screen), 2, None, ctypes.byref(info), self.w, self.h)
        size = img.contents.bytes_per_line * self.h
        info.shmid = self.libc.shmget(0, size, 0o1000 | 0o600)
        if info.shmid < 0:
            return None
        info.shmaddr = self.libc.shmat(info.shmid, None, 0)
        img.contents.data = info.shmaddr
        info.readOnly = 0
        self.ext.XShmAttach(self.dpy, ctypes.byref(info))
        self.x.XSync(self.dpy, 0)
        self.libc.shmctl(info.shmid, 0, None)  # IPC_RMID: gone with the last of its two holders
        return {"info": info, "img": img, "size": size, "bpl": img.contents.bytes_per_line}

    def capture(self):
        """The whole screen as BGRX bytes, with its row length: by MIT-SHM (a tenth of a millisecond), else XGetImage."""
        if self.shm is None:
            self.shm = self._attach_shm() or False
        if self.shm:
            self.ext.XShmGetImage(self.dpy, self.root, self.shm["img"], 0, 0, 0xFFFFFFFF)
            # Into one buffer, kept: a picture every two seconds while you watch touches no new memory each time.
            if getattr(self, "_frame", None) is None:
                self._frame = bytearray(self.shm["size"])
            ctypes.memmove((ctypes.c_char * self.shm["size"]).from_buffer(self._frame), self.shm["info"].shmaddr, self.shm["size"])
            return self._frame, self.shm["bpl"]
        img = self.x.XGetImage(self.dpy, self.root, 0, 0, self.w, self.h, 0xFFFFFFFF, 2)
        bpl = img.contents.bytes_per_line
        data = bytearray(ctypes.string_at(img.contents.data, bpl * self.h))
        self.x.XDestroyImage(img)
        return data, bpl

    def cursor(self):
        """The pointer's picture and where it is: (x, y, width, height, pixels as ARGB), or None."""
        c = self.fixes.XFixesGetCursorImage(self.dpy)
        if not c:
            return None
        k = c.contents
        pixels = [k.pixels[i] & 0xFFFFFFFF for i in range(k.width * k.height)]
        out = (k.x - k.xhot, k.y - k.yhot, k.width, k.height, pixels)
        self.x.XFree(c)
        return out

    def pointer(self):
        r, ch, rx, ry, wx, wy, mask = ctypes.c_ulong(), ctypes.c_ulong(), ctypes.c_int(), ctypes.c_int(), ctypes.c_int(), ctypes.c_int(), ctypes.c_uint()
        self.x.XQueryPointer(self.dpy, self.root, ctypes.byref(r), ctypes.byref(ch), ctypes.byref(rx), ctypes.byref(ry), ctypes.byref(wx), ctypes.byref(wy), ctypes.byref(mask))
        return rx.value, ry.value

    # -- input
    def motion(self, x, y):
        self.tst.XTestFakeMotionEvent(self.dpy, -1, int(x), int(y), 0)

    def button(self, b, down):
        self.tst.XTestFakeButtonEvent(self.dpy, b, 1 if down else 0, 0)

    def key(self, code, down):
        self.tst.XTestFakeKeyEvent(self.dpy, code, 1 if down else 0, 0)

    def sync(self):
        self.x.XSync(self.dpy, 0)

    def keymap(self):
        """keysym -> (keycode, level): level 0 needs no shift, level 1 needs shift. Never remapped (C0: xdotool's
        remapping lowercased capitals and dropped characters)."""
        if self._keys is None:
            lo, hi, per = ctypes.c_int(), ctypes.c_int(), ctypes.c_int()
            self.x.XDisplayKeycodes(self.dpy, ctypes.byref(lo), ctypes.byref(hi))
            n = hi.value - lo.value + 1
            syms = self.x.XGetKeyboardMapping(self.dpy, lo.value, n, ctypes.byref(per))
            keys = {}
            for level in (0, 1):
                for k in range(n):
                    if level < per.value:
                        s = syms[k * per.value + level]
                        if s and s not in keys:
                            keys[s] = (lo.value + k, level)
            self.x.XFree(syms)
            self._keys = keys
        return self._keys

    def keysym(self, name):
        return self.x.XStringToKeysym(name.encode())

    # -- windows
    def prop(self, w, name, kind, as_ulongs=False):
        t, f, n, left, data = ctypes.c_ulong(), ctypes.c_int(), ctypes.c_ulong(), ctypes.c_ulong(), ctypes.c_void_p()
        if self.x.XGetWindowProperty(self.dpy, w, self.atoms[name], 0, 4096, 0, self.atoms[kind] if kind else 0, ctypes.byref(t), ctypes.byref(f), ctypes.byref(n), ctypes.byref(left), ctypes.byref(data)) != 0 or not data.value:
            return None
        try:
            if as_ulongs:
                return [ctypes.cast(data, ctypes.POINTER(ctypes.c_ulong))[i] for i in range(n.value)] if f.value == 32 else []
            return ctypes.string_at(data.value, n.value * (f.value // 8)).decode("utf-8", "replace")
        finally:
            self.x.XFree(data)

    def name(self, w):
        return self.prop(w, "_NET_WM_NAME", "UTF8_STRING") or self.prop(w, "WM_NAME", "STRING") or ""

    def window(self, w):
        """A window as an action's answer names it: its title, its application, whether it is a dialog, where it is."""
        klass = (self.prop(w, "WM_CLASS", "STRING") or "").split("\0")
        types = self.prop(w, "_NET_WM_WINDOW_TYPE", "ATOM", as_ulongs=True) or []
        transient = self.prop(w, "WM_TRANSIENT_FOR", "WINDOW", as_ulongs=True) or []
        a = XWindowAttributes()
        geometry = None
        if self.x.XGetWindowAttributes(self.dpy, w, ctypes.byref(a)):
            rx, ry, child = ctypes.c_int(), ctypes.c_int(), ctypes.c_ulong()
            self.x.XTranslateCoordinates(self.dpy, w, self.root, 0, 0, ctypes.byref(rx), ctypes.byref(ry), ctypes.byref(child))
            geometry = [rx.value, ry.value, a.width, a.height]
        return {"id": hex(w), "title": self.name(w), "app": klass[1] if len(klass) > 1 else klass[0],
                "dialog": self.atoms["_NET_WM_WINDOW_TYPE_DIALOG"] in types or bool(transient and transient[0]), "box": geometry}

    def clients(self):
        return self.prop(self.root, "_NET_CLIENT_LIST", "WINDOW", as_ulongs=True) or []

    def client_at(self, x, y):
        """The topmost app window whose box holds the point, as the window manager stacks them (EWMH), or 0."""
        for w in reversed(self.prop(self.root, "_NET_CLIENT_LIST_STACKING", "WINDOW", as_ulongs=True) or []):
            box = self.window(w)["box"]
            if box and box[0] <= x < box[0] + box[2] and box[1] <= y < box[1] + box[3]:
                return w
        return 0

    def close(self, w):
        """Ask a window to close, as its close button does (WM_DELETE_WINDOW): the app ends as it would for a person,
        with nothing to restore next time."""
        ev = XClientMessageEvent()
        ev.type, ev.display, ev.window, ev.message_type, ev.format = 33, self.dpy, w, self.atoms["WM_PROTOCOLS"], 32
        ev.l[0], ev.l[1] = self.atoms["WM_DELETE_WINDOW"], 0
        self.x.XSendEvent(self.dpy, w, 0, 0, ctypes.byref(ev))
        self.x.XFlush(self.dpy)

    def activate(self, w):
        """Ask the window manager to bring a window forward with the keyboard's focus, as a pager asks (EWMH)."""
        ev = XClientMessageEvent()
        ev.type, ev.display, ev.window, ev.message_type, ev.format = 33, self.dpy, w, self.x.XInternAtom(self.dpy, b"_NET_ACTIVE_WINDOW", 0), 32
        ev.l[0], ev.l[1], ev.l[2] = 2, 0, 0  # from a pager, now, nothing it had
        self.x.XSendEvent(self.dpy, self.root, 0, (1 << 20) | (1 << 19), ctypes.byref(ev))
        self.x.XFlush(self.dpy)

    def active(self):
        """The window with the keyboard's focus, as the window manager says (EWMH), else as X says."""
        got = self.prop(self.root, "_NET_ACTIVE_WINDOW", "WINDOW", as_ulongs=True)
        if got and got[0]:
            return got[0]
        w, revert = ctypes.c_ulong(), ctypes.c_int()
        self.x.XGetInputFocus(self.dpy, ctypes.byref(w), ctypes.byref(revert))
        return w.value if w.value > 1 else 0


class Watch(threading.Thread):
    """A second connection to the display, its events read as they come: when the screen was last drawn on (DAMAGE),
    how often, and the windows the window manager lists as they come and go."""

    def __init__(self, name=DISPLAY):
        super().__init__(daemon=True, name="watch")
        self.d = Display(name)
        lib = libs()
        self.damage = lib["damage"]
        base, err = ctypes.c_int(), ctypes.c_int()
        if not self.damage.XDamageQueryExtension(self.d.dpy, ctypes.byref(base), ctypes.byref(err)):
            raise Failed("the display has no DAMAGE extension")
        self.notify = base.value  # XDamageNotify
        self.handle = self.damage.XDamageCreate(self.d.dpy, self.d.root, 3)  # XDamageReportNonEmpty
        self.d.x.XSelectInput(self.d.dpy, self.d.root, (1 << 22) | (1 << 19))  # PropertyChangeMask | SubstructureNotifyMask
        self.d.sync()
        self.lock = threading.Lock()
        self.last_change = time.monotonic()
        self.changes = 0
        self.known = {}
        self.appeared = []  # (when, window) since the last answer took them
        self.gone = []
        # A window of its own, never shown, to hold a selection for a paste (own): the text pasted, as UTF-8.
        self.win = self.d.x.XCreateSimpleWindow(self.d.dpy, self.d.root, 0, 0, 1, 1, 0, 0, 0)
        self.clip = None
        self.given = threading.Event()  # (set once an app has taken what is held)
        self.started = False
        self._list()
        self.started = True

    def _list(self):
        now = self.d.clients()
        new = []
        with self.lock:
            for w in now:
                if w in self.known:
                    continue
                info = self.d.window(w)
                self.known[w] = info
                self.appeared.append((time.monotonic(), info))
                new.append(w)
            for w in set(self.known) - set(now):
                self.gone.append((time.monotonic(), self.known.pop(w)))
        # A window that appears is brought to the front with the focus: the window manager may keep one started just
        # after a click elsewhere behind it (its focus-stealing guard), and an agent's next click would miss it.
        if self.started:
            for w in new:
                self.d.activate(w)

    def run(self):
        ev = XEvent()
        fd = self.d.x.XConnectionNumber(self.d.dpy)
        while True:
            while self.d.x.XPending(self.d.dpy):
                self.d.x.XNextEvent(self.d.dpy, ctypes.byref(ev))
                if ev.type == self.notify:
                    with self.lock:
                        self.last_change = time.monotonic()
                        self.changes += 1
                    self.damage.XDamageSubtract(self.d.dpy, self.handle, 0, 0)
                elif ev.type == 28:  # PropertyNotify on the root: the client list may have changed
                    pe = ctypes.cast(ctypes.byref(ev), ctypes.POINTER(XPropertyEvent)).contents
                    if pe.atom == self.d.atoms["_NET_CLIENT_LIST"]:
                        self._list()
                elif ev.type == 30:  # SelectionRequest: an app pasting what it holds
                    self._answer(ev)
                elif ev.type == 29:  # SelectionClear: another app holds it now
                    with self.lock:
                        self.clip = None
            select.select([fd], [], [], 1.0)

    def own(self, text):
        """Hold `text` as the PRIMARY selection and the clipboard, for a paste to take (shift+Insert, ctrl+v)."""
        with self.lock:
            self.clip = text.encode("utf-8")
            self.given.clear()
        for name in ("PRIMARY", "CLIPBOARD"):
            self.d.x.XSetSelectionOwner(self.d.dpy, self.d.atoms[name], self.win, 0)
        # (A round trip: the server has it before the paste's keys come, on the other connection.)
        self.d.sync()

    def _answer(self, ev):
        a, x, dpy = self.d.atoms, self.d.x, self.d.dpy
        req = ctypes.cast(ctypes.byref(ev), ctypes.POINTER(XSelectionRequestEvent)).contents
        prop = req.property or req.target
        with self.lock:
            data = self.clip
        if data is not None and req.target == a["TARGETS"]:
            targets = (ctypes.c_ulong * 6)(a["TARGETS"], a["UTF8_STRING"], a["STRING"], a["TEXT"], a["text/plain;charset=utf-8"], a["text/plain"])
            x.XChangeProperty(dpy, req.requestor, prop, a["ATOM"], 32, 0, ctypes.cast(targets, ctypes.c_void_p), 6)
        elif data is not None and req.target in (a["UTF8_STRING"], a["TEXT"], a["text/plain;charset=utf-8"]):
            x.XChangeProperty(dpy, req.requestor, prop, a["UTF8_STRING"], 8, 0, ctypes.cast(ctypes.c_char_p(data), ctypes.c_void_p), len(data))
        elif data is not None and req.target in (a["STRING"], a["text/plain"]):
            latin = data.decode("utf-8").encode("latin-1", "replace")
            x.XChangeProperty(dpy, req.requestor, prop, a["STRING"], 8, 0, ctypes.cast(ctypes.c_char_p(latin), ctypes.c_void_p), len(latin))
        else:
            prop = 0  # refused: nothing held, or a form it isn't given in
        reply = XEvent()
        n = ctypes.cast(ctypes.byref(reply), ctypes.POINTER(XSelectionEvent)).contents
        n.type, n.display, n.requestor, n.selection, n.target, n.property, n.time = 31, dpy, req.requestor, req.selection, req.target, prop, req.time
        x.XSendEvent(dpy, req.requestor, 0, 0, ctypes.byref(reply))
        x.XFlush(dpy)
        # Taken once the app has been told it is there (the next key, on the other connection, comes after).
        if data is not None and prop and req.target != a["TARGETS"]:
            self.given.set()

    def taken(self, bound):
        """Whether an app has taken the text held for a paste, waiting `bound` seconds at most."""
        return self.given.wait(bound)

    def since(self, t):
        """Whether the screen was drawn on after `t`, and how soon after it."""
        with self.lock:
            return (self.last_change > t, self.last_change - t if self.last_change > t else None)

    def take(self):
        """The windows that appeared and went since the last answer took them."""
        with self.lock:
            appeared, gone = [w for _, w in self.appeared], [w for _, w in self.gone]
            self.appeared, self.gone = [], []
        return appeared, gone


# ---------------------------------------------------------------- pictures

def draw_cursor(frame, bpl, width, height, cursor):
    """The pointer drawn into a BGRX frame (its pixels premultiplied ARGB, as X gives them)."""
    if not cursor:
        return
    cx, cy, cw, ch, pixels = cursor
    for j in range(ch):
        y = cy + j
        if not 0 <= y < height:
            continue
        row = y * bpl
        for i in range(cw):
            x = cx + i
            p = pixels[j * cw + i]
            a = p >> 24
            if not a or not 0 <= x < width:
                continue
            o = row + x * 4
            if a == 255:
                frame[o], frame[o + 1], frame[o + 2] = p & 255, (p >> 8) & 255, (p >> 16) & 255
            else:
                k = 255 - a
                frame[o] = min(255, (p & 255) + frame[o] * k // 255)
                frame[o + 1] = min(255, ((p >> 8) & 255) + frame[o + 1] * k // 255)
                frame[o + 2] = min(255, ((p >> 16) & 255) + frame[o + 2] * k // 255)


def png(frame, width, height, bpl, level=1):
    """A BGRX frame as a PNG (RGB, no filter, zlib at `level`): exact, for a model to read text from."""
    stride = width * 3
    rgb = bytearray(stride * height)
    if bpl == width * 4:
        rgb[0::3], rgb[1::3], rgb[2::3] = frame[2::4], frame[1::4], frame[0::4]
    else:
        for y in range(height):
            row = frame[y * bpl:y * bpl + width * 4]
            rgb[y * stride:(y + 1) * stride][0::3] = row[2::4]
            line = bytearray(stride)
            line[0::3], line[1::3], line[2::3] = row[2::4], row[1::4], row[0::4]
            rgb[y * stride:(y + 1) * stride] = line
    raw = bytearray((stride + 1) * height)
    view = memoryview(rgb)
    for y in range(height):
        raw[y * (stride + 1) + 1:(y + 1) * (stride + 1)] = view[y * stride:(y + 1) * stride]

    def chunk(kind, data):
        return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data) & 0xFFFFFFFF)

    return b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0)) + chunk(b"IDAT", zlib.compress(bytes(raw), level)) + chunk(b"IEND", b"")


_tj = None


def jpeg(frame, width, height, bpl, quality=75):
    """A BGRX frame as a JPEG by TurboJPEG (a few milliseconds), or None where the image has no TurboJPEG."""
    global _tj
    if _tj is None:
        try:
            lib = ctypes.CDLL("libturbojpeg.so.0")
            _proto(lib, "tjInitCompress", ctypes.c_void_p)
            _proto(lib, "tjCompress2", ctypes.c_int, ctypes.c_void_p, ctypes.c_void_p, ctypes.c_int, ctypes.c_int, ctypes.c_int, ctypes.c_int, ctypes.POINTER(ctypes.c_void_p), ctypes.POINTER(ctypes.c_ulong), ctypes.c_int, ctypes.c_int, ctypes.c_int)
            _proto(lib, "tjFree", None, ctypes.c_void_p)
            _tj = (lib, lib.tjInitCompress())
        except OSError:
            _tj = False
    if not _tj:
        return None
    lib, handle = _tj
    src = (ctypes.c_char * len(frame)).from_buffer(frame)
    out, size = ctypes.c_void_p(), ctypes.c_ulong()
    # TJPF_BGRX (3), 4:2:0 (2), the fast DCT (2048).
    if lib.tjCompress2(handle, ctypes.cast(src, ctypes.c_void_p), width, bpl, height, 3, ctypes.byref(out), ctypes.byref(size), 2, quality, 2048) != 0:
        return None
    try:
        return ctypes.string_at(out, size.value)
    finally:
        lib.tjFree(out)


def crop_scaled(frame, bpl, region, limit=(W, H)):
    """A region of a BGRX frame, made larger by the whole number of times that fits it within `limit` (each pixel
    repeated: nothing is invented): what a zoom shows."""
    x0, y0, x1, y1 = region
    w, h = x1 - x0, y1 - y0
    k = max(1, min(limit[0] // w, limit[1] // h))
    out_w, out_h = w * k, h * k
    out = bytearray(out_w * out_h * 4)
    for y in range(h):
        src = frame[(y0 + y) * bpl + x0 * 4:(y0 + y) * bpl + x1 * 4]
        line = bytearray(out_w * 4)
        for rep in range(k):
            for c in range(4):
                line[rep * 4 + c::k * 4] = src[c::4]
        for rep in range(k):
            start = (y * k + rep) * out_w * 4
            out[start:start + out_w * 4] = line
    return out, out_w, out_h, out_w * 4


# ---------------------------------------------------------------- the browser (its debugging port, loopback only)

class Browser:
    """Chromium's pages, over one connection to its debugging port: what is opened and what is read, and when a page
    is loading. Every call answers within CDP_BOUND, or raises Failed saying it didn't."""

    def __init__(self, port=PORT, connect=None, window_title=None):
        self.port = port
        self._connect = connect  # (tests pass their own)
        self.window_title = window_title  # the browser's window's title, as the window manager shows it
        self.ws = None
        self.lock = threading.Lock()
        self.next = 0
        self.waiting = {}
        self.pages = {}  # target id -> {"session", "url", "title", "loading", "opened"}
        self.by_session = {}

    def _open(self):
        if self._connect:
            return self._connect()
        import websocket
        # A browser just started answers on its port within a second or so: waited for, up to WAIT.
        deadline = time.monotonic() + WAIT
        while True:
            try:
                version = json.load(urllib.request.urlopen("http://127.0.0.1:%d/json/version" % self.port, timeout=CDP_BOUND))
                break
            except Exception:
                if time.monotonic() > deadline:
                    raise Failed("the browser isn't answering on its port (see %s/browser.log)" % RUN)
                time.sleep(0.05)
        return websocket.create_connection(version["webSocketDebuggerUrl"], suppress_origin=True, timeout=CDP_BOUND)

    def connect(self):
        with self.lock:
            if self.ws:
                return
            self.ws = self._open()
            self.pages, self.by_session = {}, {}
        threading.Thread(target=self._read, args=(self.ws,), daemon=True, name="cdp").start()
        self.call("Target.setDiscoverTargets", {"discover": True})
        deadline = time.monotonic() + CDP_BOUND
        while time.monotonic() < deadline and not any(p.get("session") for p in self.pages.values()):
            time.sleep(0.01)

    def _send(self, message, reply=None):
        with self.lock:
            if not self.ws:
                raise Failed("the browser isn't connected")
            self.next += 1
            message["id"] = self.next
            if reply is not None:
                self.waiting[self.next] = reply
            self.ws.send(json.dumps(message))
            return self.next

    def call(self, method, params=None, session=None, bound=CDP_BOUND):
        if not self.ws:
            self.connect()
        reply = {"done": threading.Event(), "session": session, "method": method}
        message = {"method": method, "params": params or {}}
        if session:
            message["sessionId"] = session
        n = self._send(message, reply)
        if not reply["done"].wait(bound):
            with self.lock:
                self.waiting.pop(n, None)
            raise Failed("the browser didn't answer %s within %.0f s" % (method, bound))
        if "dialog" in reply:
            raise Failed(describe_dialog(reply["dialog"]))
        if "error" in reply:
            raise Failed("the browser refused %s: %s" % (method, reply["error"].get("message", reply["error"])))
        return reply.get("result", {})

    def _read(self, ws):
        try:
            while True:
                m = json.loads(ws.recv())
                if "id" in m:
                    with self.lock:
                        reply = self.waiting.pop(m["id"], None)
                    if reply is not None:
                        reply.update({k: m[k] for k in ("result", "error") if k in m})
                        reply["done"].set()
                else:
                    self._event(m)
        except Exception:
            with self.lock:
                if self.ws is ws:
                    self.ws = None
                for reply in self.waiting.values():
                    reply["error"] = {"message": "the browser went away"}
                    reply["done"].set()
                self.waiting = {}

    def _event(self, m):
        method, p = m.get("method", ""), m.get("params", {})
        if method == "Target.targetCreated" and p["targetInfo"].get("type") == "page":
            info = p["targetInfo"]
            self.pages.setdefault(info["targetId"], {"session": None, "url": info.get("url", ""), "title": info.get("title", ""), "loading": False, "opened": time.monotonic()})
            self._send({"method": "Target.attachToTarget", "params": {"targetId": info["targetId"], "flatten": True}})
        elif method == "Target.attachedToTarget":
            target = p["targetInfo"]["targetId"]
            page = self.pages.get(target)
            if page is not None:
                page["session"] = p["sessionId"]
                self.by_session[p["sessionId"]] = target
                self._send({"method": "Page.enable", "params": {}, "sessionId": p["sessionId"]})
        elif method == "Target.targetInfoChanged":
            info = p["targetInfo"]
            if info["targetId"] in self.pages:
                self.pages[info["targetId"]].update(url=info.get("url", ""), title=info.get("title", ""))
        elif method == "Target.targetDestroyed":
            page = self.pages.pop(p["targetId"], None)
            if page and page.get("session"):
                self.by_session.pop(page["session"], None)
        else:
            target = self.by_session.get(m.get("sessionId", ""))
            page = self.pages.get(target) if target else None
            if page is None:
                return
            # The main frame's id is its target's.
            if method == "Page.frameStartedLoading" and p.get("frameId") == target:
                page.update(loading=True, started=time.monotonic())
            elif method in ("Page.frameStoppedLoading",) and p.get("frameId") == target:
                page.update(loading=False, stopped=time.monotonic())
            elif method == "Page.loadEventFired":
                page.update(loading=False, stopped=time.monotonic())
            elif method == "Page.frameRequestedNavigation" and p.get("frameId") == target:
                page.update(requested=time.monotonic(), loading=True)
            elif method == "Page.javascriptDialogOpening":
                page["dialog"] = {"type": p.get("type", "alert"), "message": p.get("message", ""), "default": p.get("defaultPrompt", "")}
                # What waits on the page's script is answered now, with the dialog: the page answers nothing while it is up.
                with self.lock:
                    held = [n for n, r in self.waiting.items() if r.get("session") == m.get("sessionId") and str(r.get("method", "")).startswith("Runtime.")]
                    for n in held:
                        r = self.waiting.pop(n)
                        r["dialog"] = page["dialog"]
                        r["done"].set()
            elif method == "Page.javascriptDialogClosed":
                page.pop("dialog", None)

    def front(self):
        """The page in front, read and navigated: the one whose title the browser's window shows (Chromium names its
        window after the tab in front), else the one that says it is visible, else the newest. Never merely the first
        listed: that was the one in front only by the list's chance (C0's F5)."""
        if not self.ws:
            self.connect()
        attached = [(t, p) for t, p in self.pages.items() if p.get("session")]
        # A page with a JavaScript dialog up is the one in front: Chromium shows it in its tab.
        asking = [(t, p) for t, p in attached if p.get("dialog")]
        if asking:
            return asking[-1]
        if not attached:
            # Its last tab closed (C0's F10): a page of its own, as the shell command made one.
            self.call("Target.createTarget", {"url": "about:blank"})
            deadline = time.monotonic() + CDP_BOUND
            while time.monotonic() < deadline and not attached:
                time.sleep(0.01)
                attached = [(t, p) for t, p in self.pages.items() if p.get("session")]
            if not attached:
                raise Failed("the browser has no page, and made none")
        if len(attached) == 1:
            return attached[0]
        title = (self.window_title() if self.window_title else "") or ""
        if title.endswith(" - Chromium"):
            named = [(t, p) for t, p in attached if p.get("title") and p["title"] + " - Chromium" == title]
            if len(named) == 1:
                return named[0]
        visible = []
        for t, p in attached:
            try:
                if self.call("Runtime.evaluate", {"expression": "document.visibilityState", "returnByValue": True}, p["session"], bound=0.5).get("result", {}).get("value") == "visible":
                    visible.append((t, p))
            except Failed:
                pass
        if len(visible) == 1:
            return visible[0]
        return max(attached, key=lambda tp: tp[1].get("opened", 0))

    def evaluate(self, expression, bound=CDP_BOUND):
        target, page = self.front()
        # A page with a JavaScript dialog up answers nothing (C0's F4: 30 s, then a traceback): said at once instead.
        if page.get("dialog"):
            raise Failed(describe_dialog(page["dialog"]))
        got = self.call("Runtime.evaluate", {"expression": expression, "returnByValue": True}, page["session"], bound)
        return got.get("result", {}).get("value")

    def dialog(self):
        """The JavaScript dialog up on a page, or None."""
        for t, p in self.pages.items():
            if p.get("dialog"):
                return dict(p["dialog"], page=t)
        return None

    def answer_dialog(self, accept, text=None):
        """The dialog up answered, as its own buttons would: OK (accept) or Cancel (dismiss), a prompt's text with it."""
        for t, p in self.pages.items():
            if p.get("dialog"):
                found = p["dialog"]
                self.call("Page.handleJavaScriptDialog", {"accept": accept, **({"promptText": text} if text is not None else {})}, p["session"])
                p.pop("dialog", None)  # (answered: closed, whenever its event says so)
                return found
        raise Failed("no JavaScript dialog is open")

    def loading_since(self, t):
        """A navigation that began, or was asked for, after `t` and hasn't ended."""
        return any(p.get("loading") and max(p.get("started", 0), p.get("requested", 0)) > t for p in self.pages.values())

    def loading(self):
        return any(p.get("loading") for p in self.pages.values())


BUTTONS = {"alert": ["OK"], "confirm": ["OK", "Cancel"], "prompt": ["OK", "Cancel"], "beforeunload": ["Leave", "Cancel"]}


def describe_dialog(d):
    return ('a JavaScript %s is open on the page: %s [%s]%s. desktop dialog accept answers it (or Return), desktop dialog dismiss '
            'cancels it (or Escape)%s' % (d["type"], json.dumps(d["message"], ensure_ascii=False), "] [".join(BUTTONS.get(d["type"], ["OK"])),
                                          ", with a text box" if d["type"] == "prompt" else "", "; desktop dialog accept <text> answers its text box" if d["type"] == "prompt" else ""))


# ---------------------------------------------------------------- the accessibility tree (AT-SPI)

LAUNCHER = "/usr/libexec/at-spi-bus-launcher"
LAUNCHER_COMM = os.path.basename(LAUNCHER)[:15]  # (as /proc names it: a process's name is cut at 15 characters)
# AT-SPI's roles by number (AtspiRole), in its own words.
ROLES = ("invalid", "accelerator label", "alert", "animation", "arrow", "calendar", "canvas", "check box", "check menu item",
         "color chooser", "column header", "combo box", "date editor", "desktop icon", "desktop frame", "dial", "dialog",
         "directory pane", "drawing area", "file chooser", "filler", "focus traversable", "font chooser", "frame", "glass pane",
         "html container", "icon", "image", "internal frame", "label", "layered pane", "list", "list item", "menu", "menu bar",
         "menu item", "option pane", "page tab", "page tab list", "panel", "password text", "popup menu", "progress bar",
         "push button", "radio button", "radio menu item", "root pane", "row header", "scroll bar", "scroll pane", "separator",
         "slider", "spin button", "split pane", "status bar", "table", "table cell", "table column header", "table row header",
         "tearoff menu item", "terminal", "text", "toggle button", "tool bar", "tool tip", "tree", "tree table", "unknown",
         "viewport", "window", "extended", "header", "footer", "paragraph", "ruler", "application", "autocomplete", "edit bar",
         "embedded", "entry", "chart", "caption", "document frame", "heading", "page", "section", "redundant object", "form",
         "link", "input method window", "table row", "tree item", "document spreadsheet", "document presentation",
         "document text", "document web", "document email", "comment", "list box", "grouping", "image map", "notification",
         "info bar", "level bar", "title bar", "block quote", "audio", "video", "definition", "article", "landmark", "log",
         "marquee", "math", "rating", "timer", "static", "math fraction", "math root", "subscript", "superscript",
         "description list", "description term", "description value", "footnote", "content deletion", "content insertion",
         "mark", "suggestion", "push button menu", "switch")
# What a person acts on: clicks, types into, picks from.
ACTABLE = {"check box", "check menu item", "combo box", "entry", "link", "list item", "menu", "menu item", "page tab",
           "password text", "push button", "push button menu", "radio button", "radio menu item", "slider", "spin button",
           "switch", "toggle button", "tree item", "text"}
# The words a model may use for a role, and the role they mean.
ROLE_WORDS = {"button": "push button", "checkbox": "check box", "combobox": "combo box", "select": "combo box", "textbox": "entry",
              "field": "entry", "input": "entry", "tab": "page tab", "radio": "radio button", "menuitem": "menu item",
              "toggle": "toggle button", "password": "password text", "spinbutton": "spin button", "listitem": "list item",
              "treeitem": "tree item"}
# AT-SPI's states by bit (AtspiStateType): those said beside a node, and those that decide whether it is on the screen.
STATE = {"active": 1, "checked": 4, "collapsed": 5, "defunct": 6, "editable": 7, "expanded": 10, "focused": 12, "multi-line": 17,
         "pressed": 20, "selected": 23, "sensitive": 24, "showing": 25, "visible": 30, "required": 33, "read-only": 43}
SAID = ("focused", "checked", "selected", "pressed", "expanded", "collapsed", "required", "read-only")
WINDOWS = ("frame", "dialog", "window", "alert", "file chooser")


def _role(word):
    word = re.sub(r"[_-]+", " ", word.strip().lower())
    return ROLE_WORDS.get(word.replace(" ", ""), word)


ACC, PROPS = "org.a11y.atspi.Accessible", "org.freedesktop.DBus.Properties"
ALL, ANY = 1, 2  # (Collection's match types: with "invalid", a rule matches nothing)


def _bits(numbers, words):
    """Numbers as the bit set a match rule takes: words of 32 bits, signed."""
    w = [0] * words
    for n in numbers:
        w[n // 32] |= 1 << (n % 32)
    return [v - (1 << 32) if v >= 1 << 31 else v for v in w]


class Tree:
    """The accessibility tree (AT-SPI) beside the pixels, off the accessibility bus that starts with the desktop. A
    window's nodes on the screen and acted on come in one call, the app searching its own tree (Collection.GetMatches:
    this at-spi2-core, 2.56, has no Cache.GetItems), then each one's name, role, state and box with many calls in flight
    (a walk, one call at a time, is mostly waiting); an app without Collection is walked the same way. GTK 4 says 0,0
    for every place on the screen, so it is asked for its window's, and that window's place on the screen (from X) is
    added."""

    REGISTRY = ("org.a11y.atspi.Registry", "/org/a11y/atspi/accessible/root")
    IN_FLIGHT = 8

    def __init__(self, address=None, call=None, window_origin=None):
        self.address = address  # () -> the bus's address (the display's AT_SPI_BUS)
        self._call = call  # (tests pass their own bus)
        self.window_origin = window_origin  # (pid, title) -> where that app's window is on the screen, or None
        self.conn = None
        self.known = {}  # bus name -> the app: its name, its toolkit, its process
        self.refs = {}  # n -> the node said as [n]
        self.lock = threading.RLock()
        self.pool = None

    def call(self, bus, path, iface, method, signature=None, args=None):
        if self._call:
            return self._call(bus, path, iface, method, signature, args)
        from gi.repository import Gio, GLib
        if self.conn is None or self.conn.is_closed():
            address = self.address() if self.address else ""
            if not address:
                raise Failed("the accessibility bus isn't up (it starts with the desktop: desktop start)")
            self.conn = Gio.DBusConnection.new_for_address_sync(address, Gio.DBusConnectionFlags.AUTHENTICATION_CLIENT | Gio.DBusConnectionFlags.MESSAGE_BUS_CONNECTION, None, None)
        try:
            reply = self.conn.call_sync(bus, path, iface, method, GLib.Variant(signature, args) if signature else None, None, Gio.DBusCallFlags.NONE, int(CDP_BOUND * 1000), None)
        except GLib.Error as error:
            raise Failed("the accessibility bus didn't answer %s: %s" % (method, error.message))
        return reply.unpack() if reply is not None else ()

    def _many(self, fn, items):
        """fn of each item, many in flight (the bus answers each app's calls in turn; a caller that waits for each is
        mostly waiting)."""
        if len(items) < 2:
            return [fn(i) for i in items]
        if self.pool is None:
            from concurrent.futures import ThreadPoolExecutor
            self.pool = ThreadPoolExecutor(self.IN_FLIGHT, thread_name_prefix="tree")
        return list(self.pool.map(fn, items))

    def _app(self, bus, path):
        if bus not in self.known:
            def get(iface, name):
                try:
                    return self.call(bus, path, PROPS, "Get", "(ss)", (iface, name))[0]
                except Failed:
                    return ""
            try:
                pid = self.call("org.freedesktop.DBus", "/org/freedesktop/DBus", "org.freedesktop.DBus", "GetConnectionUnixProcessID", "(s)", (bus,))[0]
            except Failed:
                pid = 0
            self.known[bus] = {"bus": bus, "path": path, "name": get(ACC, "Name"), "toolkit": get("org.a11y.atspi.Application", "ToolkitName"),
                               "version": str(get("org.a11y.atspi.Application", "Version")), "pid": pid}
        return self.known[bus]

    def listen(self, session_bus):
        """A resident listener: deskd's connection kept, a listener registered with the registry, and the bus's
        IsEnabled on, so a toolkit that asks whether anything listens (Qt, Chromium without its switch) shows its tree
        to the apps started after it."""
        try:
            self.call("org.a11y.atspi.Registry", "/org/a11y/atspi/registry", "org.a11y.atspi.Registry", "RegisterEvent", "(sass)", ("window:activate", [], ""))
        except Failed:
            self.call("org.a11y.atspi.Registry", "/org/a11y/atspi/registry", "org.a11y.atspi.Registry", "RegisterEvent", "(s)", ("window:activate",))
        if session_bus and not self._call:
            from gi.repository import Gio, GLib
            bus = Gio.DBusConnection.new_for_address_sync(session_bus, Gio.DBusConnectionFlags.AUTHENTICATION_CLIENT | Gio.DBusConnectionFlags.MESSAGE_BUS_CONNECTION, None, None)
            bus.call_sync("org.a11y.Bus", "/org/a11y/bus", PROPS, "Set", GLib.Variant("(ssv)", ("org.a11y.Status", "IsEnabled", GLib.Variant("b", True))), None, Gio.DBusCallFlags.NONE, 2000, None)
            bus.close_sync(None)

    def apps(self):
        (children,) = self.call(*self.REGISTRY, ACC, "GetChildren")
        apps = [self._app(bus, path) for bus, path in children]
        self.known = {a["bus"]: a for a in apps}  # (an app that left is forgotten)
        return apps

    @staticmethod
    def has(node, state):
        return bool(node["states"] >> STATE[state] & 1)

    def node(self, ref, app, window=None):
        """A node by its reference: its name, its role and its states."""
        bus, path = ref
        name = self.call(bus, path, PROPS, "Get", "(ss)", (ACC, "Name"))[0]
        role = self.call(bus, path, ACC, "GetRole")[0]
        states = self.call(bus, path, ACC, "GetState")[0]
        return {"bus": bus, "path": path, "name": name or "", "role": ROLES[role] if role < len(ROLES) else "role %d" % role,
                "states": sum((int(word) & 0xFFFFFFFF) << (32 * i) for i, word in enumerate(states)), "app": app, "window": window}

    def windows(self, app):
        """An app's windows (its frames and dialogs), each a node."""
        (refs,) = self.call(app["bus"], app["path"], ACC, "GetChildren")
        found = self._many(lambda ref: self._try(self.node, ref, app), list(refs))
        return [w for w in found if w and w["role"] in WINDOWS]

    @staticmethod
    def _try(fn, *args):
        try:
            return fn(*args)
        except Failed:
            return None

    def matches(self, window, roles):
        """A window's nodes on the screen in those roles: the app searches its own tree when it can (Collection), else
        the tree is walked, many calls in flight, never below a node that isn't showing."""
        rule = ((_bits([STATE["showing"], STATE["visible"]], 2), ALL, {}, ALL, _bits([ROLES.index(r) for r in roles], 5), ANY, [], ALL, False), 1, 0, True)
        try:
            (refs,) = self.call(window["bus"], window["path"], "org.a11y.atspi.Collection", "GetMatches", "((aiia{ss}iaiiasib)uib)", rule)
            return [(b or window["bus"], p) for b, p in refs]
        except Failed as error:
            if "Unknown" not in str(error):
                raise
        found, level, seen = [], [(window["bus"], window["path"])], 0
        while level and seen < 20000:
            seen += len(level)
            nodes = [n for n in self._many(lambda ref: self._try(self.node, ref, window["app"]), level) if n]
            showing = [n for n in nodes if self.has(n, "showing") or n["path"] == window["path"]]
            found += [(n["bus"], n["path"]) for n in showing if n["role"] in roles and self.has(n, "visible")]
            kids = self._many(lambda n: self._try(self.call, n["bus"], n["path"], ACC, "GetChildren") or ([],), showing)
            level = [(b or window["bus"], p) for (refs,) in kids for b, p in refs]
        return found

    def box(self, node):
        """Where a node is on the screen now: x, y, width, height."""
        app = node["app"]
        own = app["toolkit"].upper() == "GTK" and app["version"].startswith("4")
        (box,) = self.call(node["bus"], node["path"], "org.a11y.atspi.Component", "GetExtents", "(u)", (1 if own else 0,))
        x, y, w, h = box
        if own:
            origin = self.window_origin(app["pid"], (node.get("window") or {}).get("name", "")) if self.window_origin else None
            if not origin:
                raise Failed("%s's window isn't on the screen" % (app["name"] or "the app"))
            x, y = x + origin[0], y + origin[1]
        return x, y, w, h

    def _on_screen(self, node):
        if self.has(node, "defunct") or not (self.has(node, "showing") and self.has(node, "visible")):
            return None
        try:
            x, y, w, h = self.box(node)
        except Failed:
            return None
        if w <= 0 or h <= 0 or x + w <= 0 or y + h <= 0 or x >= W or y >= H:
            return None
        return x, y, w, h

    def _chosen(self, app=None, pid=None):
        apps = self.apps()
        if app:
            chosen = [a for a in apps if re.search(app, a["name"], re.I)]
            if not chosen:
                raise Failed("no app named like %s is on the accessibility bus (on it: %s)" % (app, ", ".join(a["name"] for a in apps) or "none"))
            return chosen
        return sorted(apps, key=lambda a: a["pid"] != pid) if pid else apps

    def actable(self, app=None, pid=None, title=None, limit=400):
        """The nodes a person acts on, on the screen: of the app named, else of the window with the keyboard's focus
        (its process and title, from X), else every app's. Each is given a ref, which `click ref=N` takes."""
        with self.lock:
            chosen = self._chosen(app, pid)
            if not app and pid:
                chosen = [a for a in chosen if a["pid"] == pid] or chosen
            found = []
            for a in chosen:
                windows = [w for w in self.windows(a) if self.has(w, "showing")]
                # The window with the focus, when it is this app's; else its active one; else every one on the screen.
                these = [w for w in windows if title and w["name"] == title] or [w for w in windows if self.has(w, "active")] or windows
                for w in these:
                    refs = self.matches(w, ACTABLE)

                    def one(ref, a=a, w=w):
                        n = self._try(self.node, ref, a, w)
                        if not n or (n["role"] == "text" and not self.has(n, "editable")):
                            return None
                        box = self._on_screen(n)
                        return (n, box) if box else None
                    found += [f for f in self._many(one, refs) if f]
                    if len(found) >= limit:
                        break
            found = found[:limit]
            self.refs = {i + 1: n for i, (n, _) in enumerate(found)}
            return [(i + 1, n, box) for i, (n, box) in enumerate(found)]

    def caret_text(self, pid=None, title=None, before=400):
        """What is before the caret in the field with the keyboard's focus, as its app's tree shows it, or None when the
        tree can't say (no app of that process on the bus, no focused field in its tree, a password field)."""
        rule = ((_bits([STATE["focused"]], 2), ALL, {}, ALL, _bits([ROLES.index(r) for r in ("entry", "text")], 5), ANY, [], ALL, False), 1, 0, True)
        with self.lock:
            for a in [a for a in self.apps() if pid and a["pid"] == pid]:
                windows = [w for w in self.windows(a) if self.has(w, "showing")]
                for w in [w for w in windows if title and w["name"] == title] or [w for w in windows if self.has(w, "active")] or windows:
                    try:
                        (refs,) = self.call(w["bus"], w["path"], "org.a11y.atspi.Collection", "GetMatches", "((aiia{ss}iaiiasib)uib)", rule)
                    except Failed:
                        continue
                    for b, p in refs:
                        try:
                            caret = self.call(b or w["bus"], p, PROPS, "Get", "(ss)", ("org.a11y.atspi.Text", "CaretOffset"))[0]
                            return self.call(b or w["bus"], p, "org.a11y.atspi.Text", "GetText", "(ii)", (max(0, caret - before), caret))[0]
                        except Failed:
                            continue
        return None

    def find(self, role, name, pid=None):
        """The first node on the screen with that role and a name like that (any case), the app with the focus searched
        first: it, its box and a ref."""
        role, name = _role(role), name.strip().lower()
        if role not in ROLES:
            raise Refused("there is no role %s (desktop tree shows the roles on the screen)" % json.dumps(role))
        with self.lock:
            for a in self._chosen(pid=pid):
                for w in [w for w in self.windows(a) if self.has(w, "showing")]:
                    for ref in self.matches(w, [role]):
                        n = self._try(self.node, ref, a, w)
                        if n and name in n["name"].lower():
                            box = self._on_screen(n)
                            if box:
                                ref_n = max(self.refs, default=0) + 1
                                self.refs[ref_n] = n
                                return ref_n, n, box
        return None

    def at(self, ref):
        """A node said before, where it is now."""
        with self.lock:
            node = self.refs.get(ref)
            if node is None:
                raise Refused("there is no ref=%d: desktop tree (or find) gives them" % ref)
            try:
                box = self.box(node)
            except Failed:
                raise Failed("ref=%d (%s \"%s\") is gone: desktop tree, again" % (ref, node["role"], node["name"]))
            if box[2] <= 0 or box[3] <= 0:
                raise Failed("ref=%d (%s \"%s\") isn't on the screen now" % (ref, node["role"], node["name"]))
            return node, box


def say_node(ref, node, box):
    x, y, w, h = box
    states = [s for s in SAID if Tree.has(node, s)] + ([] if Tree.has(node, "sensitive") else ["disabled"])
    return "[%d] %s \"%s\" at %d,%d (%dx%d)%s" % (ref, node["role"], node["name"][:80], x + w // 2, y + h // 2, w, h, (" " + " ".join(states)) if states else "")


# ---------------------------------------------------------------- the desktop's processes

def _alive(pid):
    try:
        os.kill(pid, 0)
        return True
    except OSError:
        return False


def _own(comm):
    """This VM's processes of that exact name (the desktop's own: Xvfb, openbox, chromium)."""
    found = []
    for d in os.listdir("/proc"):
        if d.isdigit():
            try:
                if open("/proc/%s/comm" % d).read().strip() == comm:
                    found.append(int(d))
            except OSError:
                pass
    return found


class Pieces:
    """The display, the window manager and the browser: started when the desktop is used, as the shell command did."""

    def __init__(self, home=None):
        self.home = home or os.environ.get("HOME", "/work")
        self.profile = os.path.join(self.home, ".config/chromium")
        self.browser = None  # (its process id, when it was started)
        self.kept = {}  # what deskd started and keeps running: its name -> (the process, when it was started)
        self.ended = None  # told a kept piece's name as it ends (the desk's keeper)
        self.session_bus = None  # (its address, its process id)
        self.lock = threading.Lock()  # (the keeper and a command may both find one gone: one of them starts it)

    def _spawn(self, argv, log, keep=None):
        # (Every app it starts shows its accessibility tree: Chromium's switch, and Qt's, as the image's own environment has them.)
        p = subprocess.Popen(argv, stdin=subprocess.DEVNULL, stdout=open(os.path.join(RUN, log), "ab"), stderr=subprocess.STDOUT, start_new_session=True,
                             env=dict(os.environ, DISPLAY=DISPLAY, ACCESSIBILITY_ENABLED="1", QT_LINUX_ACCESSIBILITY_ALWAYS_ON="1"))
        if keep:
            self.kept[keep] = (p, time.monotonic())
            threading.Thread(target=self._wait, args=(keep, p), daemon=True, name="keep-" + keep).start()
        return p.pid

    def _wait(self, name, p):
        """A kept piece's end, known as it happens: its process waited on, nothing asked at rest."""
        p.wait()
        kept = self.kept.get(name)
        if not kept or kept[0] is not p:
            return
        if time.monotonic() - kept[1] < 1:
            time.sleep(1)  # (one that ends as it starts isn't started again at once, and again)
        if self.ended:
            self.ended(name)

    def display_up(self):
        try:
            d = Display()
            d.x.XCloseDisplay(d.dpy)
            return True
        except Exception:
            return False

    def browser_up(self):
        try:
            urllib.request.urlopen("http://127.0.0.1:%d/json/version" % PORT, timeout=1)
            return True
        except Exception:
            return False

    def window_manager_running(self):
        return bool(_own("openbox"))

    def a11y_bus(self):
        """The accessibility bus's address, as the display says it (AT_SPI_BUS on its root window), or ""."""
        try:
            d = Display()
            try:
                return (d.prop(d.root, "AT_SPI_BUS", "STRING") or "").strip("\0")
            finally:
                d.x.XCloseDisplay(d.dpy)
        except Exception:
            return ""

    def a11y_running(self):
        return bool(_own(LAUNCHER_COMM))

    def _buses(self):
        """A session bus and the accessibility bus on it, up before the apps: each app on the screen after them shows
        its tree there (Tree). What deskd starts is told the session bus; an app started elsewhere finds the
        accessibility bus on the display (AT_SPI_BUS), as AT-SPI looks for it."""
        if self.a11y_running():
            return
        # (Their sockets in deskd's own directory, not the workspace's .cache: the accessibility bus puts its socket in
        # the runtime directory.)
        os.environ["XDG_RUNTIME_DIR"] = RUN
        if not (self.session_bus and _alive(self.session_bus[1])):
            ran = subprocess.run(["dbus-daemon", "--session", "--fork", "--print-address=1", "--print-pid=1"], stdin=subprocess.DEVNULL, capture_output=True, text=True, timeout=5)
            lines = ran.stdout.split("\n")
            if ran.returncode != 0 or len(lines) < 2 or not lines[1].strip().isdigit():
                raise Failed("the session bus didn't start (%s)" % (ran.stderr.strip()[-200:] or ran.returncode))
            self.session_bus = (lines[0].strip(), int(lines[1]))
            os.environ["DBUS_SESSION_BUS_ADDRESS"] = self.session_bus[0]
        # (Not waited for: an app looks for it once it is up, a second into its start; Chromium found it 26 times of 26
        # on Ultra without the 90 ms this wait took.)
        self._spawn([LAUNCHER, "--launch-immediately"], "a11y.log", keep="a11y")

    def browser_running(self):
        """Its port answers, or the browser started here is still starting. Never by a process's name: a killed browser's
        children linger after it (C1's first run: the next command found "chromium" and didn't start it again)."""
        if self.browser_up():
            return True
        return bool(self.browser and _alive(self.browser[0]) and time.monotonic() - self.browser[1] < WAIT)

    def until(self, check, what, log):
        deadline = time.monotonic() + WAIT
        while not check():
            if time.monotonic() > deadline:
                raise Failed("%s did not come up (see %s/%s)" % (what, RUN, log))
            time.sleep(0.05)

    def start(self):
        with self.lock:
            self._start()

    def _start(self):
        os.makedirs(self.profile, exist_ok=True)
        if not _own("Xvfb") or not self.display_up():
            # (-noreset: the display never resets when its last client leaves, as it would after the check below, and
            # a connection made during the reset found no display.)
            self._spawn(["Xvfb", DISPLAY, "-screen", "0", "%dx%dx24" % (W, H), "-nolisten", "tcp", "-noreset"], "display.log")
            self.until(self.display_up, "the display", "display.log")
        if not _own("openbox"):
            self._spawn(["openbox"], "windows.log", keep="windows")
        self._buses()
        if not self.browser_running():
            # Its own inner sandbox is off: the VM's restrictions (no new privileges, no capabilities) forbid it, and the
            # microVM is the boundary. Its profile is on the workspace, so what is signed in there stays with this VM's disk.
            pid = self._spawn(["chromium", "--user-data-dir=" + self.profile, "--no-sandbox", "--test-type", "--no-first-run", "--no-default-browser-check", "--hide-crash-restore-bubble",
                               "--disable-gpu", "--disable-dev-shm-usage", "--remote-debugging-port=%d" % PORT, "--remote-debugging-address=127.0.0.1", "--force-renderer-accessibility",
                               # (On one CPU, the fewer processes at its start the sooner its first page: its compositing in its own
                               # process, no renderer started ahead of need; and its passwords where they were, not a keyring asked for.)
                               "--in-process-gpu", "--disable-features=SpareRendererForSitePerProcess", "--password-store=basic",
                               "--window-size=%d,%d" % (W, H), "--window-position=0,0", "about:blank"], "browser.log", keep="browser")
            # (Not waited for here: what reads or opens a page waits for its port, as before.)
            self.browser = (pid, time.monotonic())

    def stop(self):
        if self.session_bus:
            try:
                os.kill(self.session_bus[1], signal.SIGTERM)
            except OSError:
                pass
            self.session_bus = None
        for comm in ("chromium", LAUNCHER_COMM, "openbox", "Xvfb"):
            for pid in _own(comm):
                try:
                    os.kill(pid, signal.SIGTERM)
                except OSError:
                    pass


# ---------------------------------------------------------------- the desk: every action, and its answer

def _whole(s, what):
    if not re.fullmatch(r"\d{1,5}", str(s)):
        raise Refused("%s takes whole numbers" % what)
    return int(s)


class Desk:
    def __init__(self, pieces=None, display=None, watch=None, browser=None, now=time.monotonic, sleep=time.sleep, tree=None):
        self.pieces = pieces or Pieces()
        self._display, self._watch, self._browser = display, watch, browser
        self._tree = tree
        self.now, self.sleep = now, sleep
        self.lock = threading.RLock()
        self.last_click = None  # (when, x, y): clicks at one place within the double-click time count as one burst
        self.navigating_since = None
        self.stopping = False
        self._listening = False
        # The owner's take-over: the connection that took it (the node's held session), since and until when.
        self.hold = None
        self.hold_changed = threading.Condition()

    # -- the owner's take-over (C1 step 9): while they hold the desktop, an agent's requests wait, and are told
    def holding(self):
        """The hold in force, or None: one past its idle time or its most is given back as it is asked about."""
        with self.hold_changed:
            h = self.hold
            if h and (self.now() - h["last"] > h["idle"] or self.now() - h["taken"] > h["most"]):
                self.hold = h = None
                self.hold_changed.notify_all()
            return h

    def take(self, who, idle=HOLD_IDLE, most=HOLD_MOST, keep=False):
        """The owner takes the desktop over, through `who` (the node's connection): a second take starts a fresh window.
        With `keep` (their input), a hold in force is kept, its idle time started again. (The hold, whether this took it.)"""
        with self.hold_changed:
            h = self.holding() if keep else None
            if h is not None:
                h["last"] = self.now()
                return h, False
            now = self.now()
            self.hold = {"who": who, "since": time.time(), "taken": now, "last": now, "idle": idle, "most": most}
            self.hold_changed.notify_all()
            return self.hold, True

    def give_back(self, who, anyone=False):
        """The desktop given back: by the owner (their second tap, `anyone` of their connections), or as the connection
        that took it ends. Whether it was held."""
        with self.hold_changed:
            if self.hold is None or (not anyone and self.hold["who"] is not who):
                return False
            self.hold = None
            self.hold_changed.notify_all()
            return True

    def hold_ends(self, h):
        """How long the hold has left, at most: its idle time or its most, whichever ends it first."""
        return max(0.0, min(h["last"] + h["idle"], h["taken"] + h["most"]) - self.now())

    def wait_for_owner(self, cap=None):
        """An agent's request: waits while the owner holds the desktop, `cap` s at most. (seconds waited, the hold still in force or None)."""
        cap = HOLD_WAIT if cap is None else cap
        start = self.now()
        with self.hold_changed:
            while True:
                h = self.holding()
                waited = self.now() - start
                if h is None or waited >= cap:
                    return waited, h
                self.hold_changed.wait(timeout=max(0.01, min(cap - waited, self.hold_ends(h))))

    def hold_view(self, h):
        """A hold as the owner's node is told it: since when (the epoch's seconds), its idle time and its most, and how long it has left."""
        return None if h is None else {"since": h["since"], "idle": h["idle"], "most": h["most"], "ends_in": round(self.hold_ends(h), 3)}

    def held_said(self, h):
        return "the owner took this desktop over %d s ago, and has it for up to %d s more: until they give it back, or %d s pass with no input from them" % (
            round(time.time() - h["since"]), round(self.hold_ends(h)), round(h["idle"]))

    # -- what it holds, brought up on first use (once: the first commands may come together)
    def ready(self):
        with self.lock:
            return self._ready()

    def _ready(self):
        if self._display is None:
            self.pieces.start()
            self._display = Display()
            self._watch = Watch()
            self._watch.start()
            self._watch.take()
            self.supervise()
        if self._browser is None:
            self._browser = Browser(window_title=self.browser_title)
        return self._display

    def supervise(self):
        """The window manager and the browser kept running: one that ends (killed, its last tab closed) is started again
        as it ends, not at the next command (C0's F9: 0.76 s, after the next command came), its process waited on and
        nothing asked at rest. The display is the process's own: should it end, deskd ends with it, and the next
        command starts them all again."""
        if hasattr(self.pieces, "ended"):
            self.pieces.ended = self._ended

    def _ended(self, name):
        if self.stopping:
            return
        try:
            self.pieces.start()
        except Exception as error:  # (the next command tries again)
            sys.stderr.write("deskd: couldn't start the %s again: %s\n" % (name, error))

    def close_all(self, wait=2.0):
        """Every window asked to close as a person would (WM_DELETE_WINDOW), and given `wait` seconds to: an app that
        ends this way asks nothing to restore next time."""
        with self.lock:
            if self._display is None:
                return
            for w in self.d.clients():
                self.d.close(w)
            deadline = self.now() + wait
            while self.d.clients() and self.now() < deadline:
                self.sleep(0.05)

    def bring(self, name):
        """The window whose title or app matches `name` (a regular expression, any case), brought forward with the
        keyboard's focus, once the window manager has done it (half a second at most)."""
        with self.lock:
            try:
                rx = re.compile(name, re.I)
            except re.error:
                raise Refused("a window is named by a regular expression")
            found = [w for w in self.d.clients() if rx.search(self.d.window(w)["title"]) or rx.search(self.d.window(w)["app"])]
            if not found:
                raise Failed("no window like %s on the screen (desktop windows lists them)" % name)
            w = found[-1]
            self.d.activate(w)
            deadline = self.now() + 0.5
            while self.d.active() != w and self.now() < deadline:
                self.sleep(0.005)

    def browser_title(self):
        """The title of the browser's window: the active one when it is the browser's, else its first."""
        d = self._display
        active = d.active()
        windows = [d.window(w) for w in d.clients()]
        mine = [w for w in windows if w["app"].lower() == "chromium"]
        for w in mine:
            if active and w["id"] == hex(active):
                return w["title"]
        return mine[0]["title"] if mine else ""

    def browser_ready(self):
        """The browser, started again if it isn't running (killed, or its last tab closed), as every command found it
        before; and its debugging connection made again with it. One that is ending (its last tab closed a moment ago)
        is let end first."""
        self.ready()
        if self.pieces.browser_running():
            try:
                self._browser.front()
                return self._browser
            except Failed:
                deadline = self.now() + WAIT
                while self.pieces.browser_up() and self.now() < deadline:
                    self.sleep(0.05)
        self.pieces.start()
        self._browser = Browser(window_title=self.browser_title)
        return self._browser

    @property
    def d(self):
        return self.ready()

    @property
    def browser(self):
        self.ready()
        return self._browser

    @property
    def tree(self):
        self.ready()
        # The accessibility bus's resident listener, from the first lookup on, off the answer's path (at the desktop's
        # start it slowed the browser's first page on one CPU).
        if not self._listening:
            self._listening = True
            threading.Thread(target=self._listen, daemon=True, name="listen").start()
        return self._the_tree()

    def _the_tree(self):
        with self.lock:
            if self._tree is None:
                self._tree = Tree(address=getattr(self.pieces, "a11y_bus", None), window_origin=self.window_origin)
            return self._tree

    def _listen(self):
        try:
            self._the_tree().listen((self.pieces.session_bus or ("",))[0] if hasattr(self.pieces, "session_bus") else "")
        except Exception as error:
            sys.stderr.write("deskd: the accessibility bus's listener didn't start: %s\n" % error)

    def window_origin(self, pid, title=""):
        """Where an app's window is on the screen (its inside's top left), by its process (_NET_WM_PID) and title."""
        with self.lock:
            mine = [w for w in self.d.clients() if (self.d.prop(w, "_NET_WM_PID", "CARDINAL", as_ulongs=True) or [0])[0] == pid]
            box = next((self.d.window(w)["box"] for w in mine if not title or self.d.name(w) == title), None) or (self.d.window(mine[0])["box"] if mine else None)
            return (box[0], box[1]) if box else None

    def focused_app(self):
        """The window with the keyboard's focus: its process and its title, for the tree to start from."""
        with self.lock:
            w = self.d.active()
            if not w:
                return None, None
            return (self.d.prop(w, "_NET_WM_PID", "CARDINAL", as_ulongs=True) or [None])[0], self.d.name(w)

    def focus(self):
        w = self.d.active()
        if not w:
            return {"title": "", "app": ""}
        info = self.d.window(w)
        return {"title": info["title"], "app": info["app"], "id": info["id"]}

    # -- the answer every action gives
    def act(self, name, do):
        """Run one action under the desk's lock and answer as every action does."""
        with self.lock:
            self.ready()
            before = self.focus()
            t0 = self.now()
            said = do()
            self.d.sync()
            done = self.now()
            # The screen shows it within the grace, or nothing came of it (yet): never a fixed sleep.
            changed, soon = self._watch.since(t0)
            while not changed and self.now() - done < GRACE:
                self.sleep(0.002)
                changed, soon = self._watch.since(t0)
            after = self.focus()
            appeared, gone = self._watch.take()
            answer = {"ok": True, "action": name, "did": said, "changed": changed, "changed_ms": round(soon * 1000, 1) if soon is not None else None,
                      "focus": {"before": before, "after": after}, "appeared": appeared, "gone": gone}
            try:
                if self._browser and self._browser.ws and self._browser.loading_since(t0):
                    self.navigating_since = t0
                    answer["navigating"] = True
                dialog = self._browser.dialog() if self._browser and self._browser.ws else None
                if dialog:
                    answer["dialog"] = {**dialog, "buttons": BUTTONS.get(dialog["type"], ["OK"])}
            except Exception:
                pass
            return answer

    def settle(self, cap=SETTLE_CAP):
        """Until nothing has been drawn for QUIET, and a navigation the last action started has ended: at most `cap`."""
        with self.lock:
            self.ready()
            t0 = self.now()
            self.navigating_since = None
            while self.now() - t0 < cap:
                # A page still loading (a click that navigated) isn't settled, however still it looks: C0 saw the old page.
                loading = bool(self._browser and self._browser.ws and self._browser.loading())
                with self._watch.lock:
                    quiet = self.now() - self._watch.last_change
                if quiet >= QUIET and not loading:
                    return {"settled": True, "settled_ms": round((self.now() - t0) * 1000, 1)}
                self.sleep(0.01 if loading else min(0.01, QUIET - quiet))
            return {"settled": False, "settled_ms": round((self.now() - t0) * 1000, 1)}

    def picture(self, fmt="png", quality=75, settle=True, region=None):
        """The screen with the pointer drawn in, after it settled (unless told not to wait)."""
        with self.lock:
            settled = self.settle() if settle else None
            frame, bpl = self.d.capture()
            draw_cursor(frame, bpl, self.d.w, self.d.h, self.d.cursor())
            width, height = self.d.w, self.d.h
            if region:
                frame, width, height, bpl = crop_scaled(frame, bpl, region)
            data = jpeg(frame, width, height, bpl, quality) if fmt == "jpeg" else None
            media = "image/jpeg" if data else "image/png"
            if data is None:
                data = png(frame, width, height, bpl)
            return {"media_type": media, "data": data, "width": width, "height": height, "settled": settled}

    # -- input, as the toolset names it
    def _click(self, x, y, button, count, mods=""):
        def do():
            held = self._hold(mods)
            # (Asked first: nothing between the pointer's move and its press, as a person's click has nothing there.)
            before = self.d.active()
            px, py = (x, y) if x is not None else self.d.pointer()
            # A double or triple click at the place of the last click, within a toolkit's double-click time, would be
            # counted on from it (C0's F7: double clicks 0.3 s apart read as triples): it waits that time out first,
            # and a margin, as the display's clock may run behind deskd's.
            if count > 1 and self.last_click and abs(self.last_click[1] - px) <= 4 and abs(self.last_click[2] - py) <= 4:
                wait = MULTI_CLICK - (self.now() - self.last_click[0])
                if wait > 0:
                    self.sleep(wait)
            if x is not None:
                self.d.motion(x, y)
            for i in range(count):
                self.d.button(button, True)
                self.d.button(button, False)
                if i + 1 < count:
                    self.d.sync()
                    self.sleep(0.03)
            self._release(held)
            self.d.sync()
            self.last_click = (self.now(), px, py)
            under = self.d.client_at(px, py)
            # A click that gives another window the focus is answered once it has it (the window manager takes its
            # time): what is typed next goes there, not to the window before.
            if under and under != before:
                self.d.sync()
                deadline = self.now() + 0.3
                while self.d.active() != under and self.now() < deadline:
                    self.sleep(0.003)
            return "%s at %d,%d" % ({1: "clicked", 2: "middle-clicked", 3: "right-clicked"}[button] if count == 1 else {2: "double-clicked", 3: "triple-clicked"}[count], px, py)
        return do

    def _keys(self, combo):
        """`ctrl+shift+t`, `Return`, `a`: the keycodes to press, in order (modifiers first). Never remapped."""
        parts = [p for p in combo.split("+")]
        if not combo or any(not p for p in parts):
            raise Refused("keys are names like Return, Tab, Escape, ctrl+l")
        codes = []
        keymap = self.d.keymap()
        for i, part in enumerate(parts):
            last = i == len(parts) - 1
            name = MODIFIERS.get(part.lower()) if not last or part.lower() in MODIFIERS else None
            name = name or KEY_ALIASES.get(part.lower()) or part
            sym = self.d.keysym(name) or (ord(part) if len(part) == 1 and ord(part) < 256 else 0)
            if not sym or sym not in keymap:
                raise Refused("no key %s on this keyboard" % part)
            code, level = keymap[sym]
            if level == 1 and last:
                codes.append(keymap[self.d.keysym("Shift_L")][0])
            codes.append(code)
        return codes

    def _hold(self, mods):
        if not mods:
            return []
        codes = []
        for part in mods.split("+"):
            name = MODIFIERS.get(part.lower())
            if not name:
                raise Refused("a modifier is shift, ctrl, alt or super")
            codes.append(self.d.keymap()[self.d.keysym(name)][0])
        for c in codes:
            self.d.key(c, True)
        return codes

    def _release(self, codes):
        for c in reversed(codes):
            self.d.key(c, False)

    def press(self, combo, repeat=1):
        codes = self._keys(combo)

        def do():
            for _ in range(repeat):
                for c in codes:
                    self.d.key(c, True)
                for c in reversed(codes):
                    self.d.key(c, False)
            return "pressed %s%s" % (combo, " %d times" % repeat if repeat > 1 else "")
        return do

    def text_target(self):
        """What has the keyboard's focus, as typing needs it: "page" (a field of the browser's page in front that takes
        text), "bar" (the browser's own bar: the page doesn't have the focus), "terminal", "app" (another app's window), or
        None: nothing that takes text (no window; the page with nothing in it that takes text)."""
        active = self.d.active()
        if not active:
            return None
        app = self.d.window(active)["app"].lower()
        if app == "chromium":
            try:
                state = self.browser.evaluate(FOCUS_PROBE, bound=0.5)
            except Failed:
                return "bar"
            if not state or not state[0]:
                return "bar"
            return "page" if state[1] else None
        return "terminal" if app in ("xterm", "uxterm") else "app"

    def typing(self, text):
        """Text that arrives exactly, by what has the focus (C0: xdotool's remapped keys lowercased Æ and lost letters):
        into the browser's page by its own insertText, what landed checked; short text the keyboard has every key for,
        key by key; anything else pasted from a selection deskd holds (shift+Insert in a terminal, ctrl+v elsewhere).
        Never a key remapped. With nothing that takes text focused, an error, and nothing typed."""
        keymap = self.d.keymap()
        plan = []
        for ch in text:
            sym = {"\n": self.d.keysym("Return"), "\t": self.d.keysym("Tab")}.get(ch) or (ord(ch) if ord(ch) < 256 else 0x01000000 | ord(ch))
            if sym not in keymap:
                plan = None
                break
            plan.append(keymap[sym])
        shift = keymap.get(self.d.keysym("Shift_L"), (0, 0))[0]
        n = len(text)
        plural = "" if n == 1 else "s"

        def do():
            target = self.text_target()
            if target is None:
                raise Failed("nothing that takes text has the keyboard's focus: click where the text should go, then type")
            if target == "page":
                _, page = self.browser.front()
                self.browser.call("Input.insertText", {"text": text}, page["session"])
                landed = self.browser.evaluate(FIELD_VALUE, bound=1) or ""
                if text not in landed:
                    raise Failed("the text didn't land as typed: the field holds %s" % json.dumps(landed[-80:], ensure_ascii=False))
                return "typed %d character%s into the page" % (n, plural)
            if plan is not None and n <= SHORT:
                for code, level in plan:
                    if level:
                        self.d.key(shift, True)
                    self.d.key(code, True)
                    self.d.key(code, False)
                    if level:
                        self.d.key(shift, False)
                self.landed(text, target)
                return "typed %d character%s" % (n, plural)
            self._watch.own(text)
            for code in self._keys("shift+Insert" if target == "terminal" else "ctrl+v"):
                self.d.key(code, True)
            for code in reversed(self._keys("shift+Insert" if target == "terminal" else "ctrl+v")):
                self.d.key(code, False)
            # A paste is the app asking for the text, in its own time: the next key (a Return) mustn't overtake it (C1's
            # step 4 run: xterm's line came after its Return, 20 of 20). Its keys sent first: unsent, they waited in the
            # connection's buffer for the next command, and its Return went with them (0 of 15, the first try of this).
            self.d.sync()
            if not self._watch.taken(PASTE_BOUND):
                raise Failed("nothing took the pasted text within %g s: is a text field focused?" % PASTE_BOUND)
            self.landed(text, target)
            return "pasted %d character%s" % (n, plural)
        return do

    def landed(self, text, target, bound=0.5):
        """What was typed into an app (or the browser's own bar) checked where its accessibility tree can say what landed,
        as the page's is by its DOM: before the caret of the field with the focus, spacing aside (an editor may indent).
        An error when it says otherwise; nothing when it can't say (a terminal shows no tree)."""
        if target not in ("app", "bar"):
            return
        self.d.sync()  # (the keys sent before the tree is asked what they did)
        try:
            tree = self._the_tree()
            pid, title = self.focused_app()
        except Exception:
            return
        want = re.sub(r"\s+", " ", text).strip()
        deadline = self.now() + bound
        while True:
            try:
                held = tree.caret_text(pid=pid, title=title)
            except Failed:
                return
            if held is None or re.sub(r"\s+", " ", held).strip().endswith(want):
                return
            if self.now() >= deadline:
                raise Failed("the text didn't land as typed: the field holds %s" % json.dumps(held[-80:], ensure_ascii=False))
            self.sleep(0.02)

    def scroll(self, direction, amount, x=None, y=None, mods=""):
        button = {"up": 4, "down": 5, "left": 6, "right": 7}.get(direction)
        if not button:
            raise Refused("scroll goes up, down, left or right")
        if not 1 <= amount <= 50:
            raise Refused("scroll takes a whole number of times, from 1 to 50")

        def do():
            held = self._hold(mods)
            if x is not None:
                self.d.motion(x, y)
            for _ in range(amount):
                self.d.button(button, True)
                self.d.button(button, False)
            self._release(held)
            return "scrolled %s %d" % (direction, amount)
        return do

    def drag(self, x0, y0, x1, y1, mods=""):
        def do():
            held = self._hold(mods)
            self.d.motion(x0, y0)
            self.d.button(1, True)
            self.d.sync()
            for i in range(1, 9):
                self.d.motion(x0 + (x1 - x0) * i // 8, y0 + (y1 - y0) * i // 8)
                self.d.sync()
                self.sleep(0.01)
            self.d.button(1, False)
            self._release(held)
            return "dragged from %d,%d to %d,%d" % (x0, y0, x1, y1)
        return do

    # -- the toolset's members, as a model calls them (name, input) -> answer
    def tool(self, name, i):
        point = lambda key="coordinate": (lambda c: (_whole(c[0], "a place on the screen"), _whole(c[1], "a place on the screen")))(i[key]) if i.get(key) is not None else (None, None)
        if name == "screenshot":
            return {"ok": True, "action": name, "image": self.picture(i.get("format", "png"), settle=i.get("settle", True))}
        if name == "zoom":
            region = [_whole(v, "a region") for v in i.get("region", [])]
            if len(region) != 4 or not (0 <= region[0] < region[2] <= W and 0 <= region[1] < region[3] <= H):
                raise Refused("a region is x0, y0, x1, y1 on the screen, the second corner below and right of the first")
            return {"ok": True, "action": name, "image": self.picture(i.get("format", "png"), region=region)}
        if name in ("left_click", "right_click", "middle_click", "double_click", "triple_click"):
            x, y = point()
            button = {"left_click": 1, "double_click": 1, "triple_click": 1, "right_click": 3, "middle_click": 2}[name]
            count = {"double_click": 2, "triple_click": 3}.get(name, 1)
            return self.act(name, self._click(x, y, button, count, i.get("text", "")))
        if name == "left_click_drag":
            (x0, y0), (x1, y1) = point("start_coordinate"), point()
            if x0 is None or x1 is None:
                raise Refused("a drag takes where it starts and where it ends")
            return self.act(name, self.drag(x0, y0, x1, y1, i.get("text", "")))
        if name == "mouse_move":
            x, y = point()
            if x is None:
                raise Refused("mouse_move takes a place on the screen")
            return self.act(name, lambda: (self.d.motion(x, y), "moved to %d,%d" % (x, y))[1])
        if name in ("left_mouse_down", "left_mouse_up"):
            down = name == "left_mouse_down"
            return self.act(name, lambda: (self.d.button(1, down), "left button " + ("down" if down else "up"))[1])
        if name == "cursor_position":
            with self.lock:
                x, y = self.d.pointer()
            return {"ok": True, "action": name, "did": "X=%d, Y=%d" % (x, y), "x": x, "y": y}
        if name == "scroll":
            x, y = point()
            return self.act(name, self.scroll(i.get("scroll_direction", ""), int(i.get("scroll_amount", 1)), x, y, i.get("text", "")))
        if name == "type":
            text = i.get("text", "")
            if not text:
                raise Refused("type takes the text to type")
            return self.act(name, self.typing(text))
        if name == "key":
            repeat = int(i.get("repeat", 1))
            if not 1 <= repeat <= 100:
                raise Refused("a key is repeated 1 to 100 times")
            combo = i.get("text", "")
            if combo.split("+")[-1] in COMMITS:
                # What was just typed is taken in before a key that commits it, as a person's Return comes after they see
                # it: the screen let settle (150 ms with nothing drawn; at once when it is still). C1's step 3: a Save As
                # name typed in full and its Return 20 ms later, never saved, 5 of 5 (150 ms later: saved, 5 of 5).
                self.settle(cap=COMMIT_SETTLE)
            return self.act(name, self.press(combo, repeat))
        if name == "hold_key":
            codes = self._keys(i.get("text", ""))
            duration = float(i.get("duration", 0))
            if not 0 < duration <= 300:
                raise Refused("a key is held for up to 300 seconds")

            def hold():
                for c in codes:
                    self.d.key(c, True)
                self.d.sync()
                self.sleep(duration)
                for c in reversed(codes):
                    self.d.key(c, False)
                return "held %s for %g s" % (i["text"], duration)
            return self.act(name, hold)
        if name == "wait":
            duration = float(i.get("duration", 0))
            if not 0 <= duration <= 300:
                raise Refused("wait takes up to 300 seconds")
            self.sleep(duration)
            return {"ok": True, "action": name, "did": "waited %g s" % duration}
        if name == "settle":
            return {"ok": True, "action": name, **self.settle(float(i.get("cap", SETTLE_CAP)))}
        if name == "windows":
            with self.lock:
                return {"ok": True, "action": name, "windows": [self.d.window(w) for w in self.d.clients()], "focus": self.focus()}
        raise Refused("no action %s" % name)


# ---------------------------------------------------------------- the command line, as `desktop` speaks it

HELP = """desktop start                      bring up the display, the window manager and the browser
desktop stream                     the screen as H.264 on stdout while it runs (the node's watching: desktop-stream)
desktop status | desktop stop
desktop open <address>             open an address in the browser (http, https, file or about)
desktop text                       the page in front, as text: its title, its address, what it says
desktop dialog accept [text] | dismiss   answer a JavaScript dialog on the page (alert, confirm, prompt)
desktop app <terminal|editor>      start a terminal (xterm) or an editor (mousepad) on the screen
desktop shot [file.png|file.jpg]   a screenshot (the pointer drawn in), once the screen has settled; prints its path
desktop zoom <x0> <y0> <x1> <y1> [file]   that part of the screen, larger
                                   (shot or zoom --base64: printed as a PNG's data address on one line, no file;
                                   with --keep <folder>, kept there too, named by its SHA-256)
desktop look [--eyes p/m] "<question>"   ask a model that can see what is on the screen, or where something is
                                   (it answers a place as x,y, to click or move to; --space per-mille|scaled:f
                                   or INVINCIBLE_EYES_SPACE: the space it answers in, its places given in pixels)
desktop click <x> <y> [left|right|middle|double|triple]
desktop move <x> <y>               desktop drag <x0> <y0> <x1> <y1>
desktop scroll <up|down|left|right> [times] [x y]
                                   (a click, drag or scroll --hold shift|ctrl|alt|super, or ctrl+shift: held while it acts)
desktop type <text>                type text where the keyboard's focus is, exactly: into the browser's page by
                                   its own input (and checked), elsewhere pasted or key by key; an error when
                                   nothing that takes text has the focus (click there first)
desktop key <key>... [--repeat n]  press keys, e.g. Return, Tab, Escape, ctrl+l, ctrl+a, alt+Left
desktop settle                     wait until the screen is still (150 ms with nothing drawn, 3 s at most)
desktop windows                    the windows on the screen, and which has the keyboard's focus
desktop focus [window]             the window with the focus; with a name, that window brought forward with it
desktop tree [app]                 what can be acted on in the window with the focus (or that app), from its
                                   accessibility tree: each with a ref, its role, its name and where it is
desktop find <role> <name>         where one is: x,y and its ref (desktop find button "Send")
desktop click ref=<n> [button]     click a node desktop tree or find gave, where it is at that moment
Every action answers with what it did, whether the screen changed, and the focus; the names Anthropic's computer
toolset uses work too (left_click, mouse_move, left_click_drag, ...).
The display is 1280 by 800; x runs right from 0, y runs down from 0. The clipboard is xclip's
(xclip -selection clipboard), and text everywhere is UTF-8."""

ALIASES = {"shot": "screenshot", "move": "mouse_move", "drag": "left_click_drag"}
# The verbs that act with keys held (--hold), as the toolset's clicks, drag and scroll take them.
HOLDING = {"click", "left_click", "right_click", "middle_click", "double_click", "triple_click", "left_click_drag", "scroll"}


def describe(answer):
    """An action's answer in a line, as a text-only model reads it."""
    if "did" not in answer:
        return ""
    parts = [answer["did"]]
    if "changed" in answer:
        parts.append("the screen changed (%d ms)" % max(1, round(answer["changed_ms"])) if answer["changed"] else "nothing on the screen changed")
    if answer.get("navigating"):
        parts.append("a page is loading")
    f = answer.get("focus")
    if f:
        b, a = f["before"], f["after"]
        name = lambda w: ("%s \"%s\"" % (w.get("app", ""), w.get("title", ""))).strip() if w.get("app") or w.get("title") else "nothing"
        parts.append("focus: %s" % name(a) if (b.get("id") == a.get("id")) else "focus: %s, was %s" % (name(a), name(b)))
    for w in answer.get("appeared", []):
        parts.append("a %s appeared: \"%s\" (%s)" % ("dialog" if w.get("dialog") else "window", w.get("title", ""), w.get("app", "")))
    for w in answer.get("gone", []):
        parts.append("\"%s\" closed" % w.get("title", ""))
    if answer.get("dialog"):
        parts.append(describe_dialog(answer["dialog"]))
    return " · ".join(parts)


def cli(desk, argv, cwd="/work", env=None):
    """One `desktop` command: (exit code, what it prints, what it says on stderr)."""
    env = env or {}
    verb = argv[0] if argv else "help"
    args = argv[1:]
    verb = ALIASES.get(verb, verb)
    try:
        # Keys held while it acts (the toolset's `text` on a click, a drag or a scroll): --hold shift, --hold ctrl+shift.
        held = {}
        if verb in HOLDING and "--hold" in args:
            at = args.index("--hold")
            combo = args[at + 1] if at + 1 < len(args) else ""
            if not combo or any(part.lower() not in MODIFIERS for part in combo.split("+")):
                raise Refused("--hold takes the keys to hold while it acts: shift, ctrl, alt or super, joined by + (--hold ctrl+shift)")
            held, args = {"text": combo}, args[:at] + args[at + 2:]
        if verb in ("help", "--help", "-h"):
            return 0, HELP + "\n", ""
        if verb == "start":
            desk.ready()
            return 0, "The desktop is up: %dx%d, display %s.\n" % (W, H, DISPLAY), ""
        if verb == "status":
            up = desk.pieces.display_up()
            h = desk.holding()
            said = ("The desktop is up: %dx%d, display %s; the browser is %s.\n" % (W, H, DISPLAY, "running" if desk.pieces.browser_up() else "not running")) if up else "The desktop is not up: desktop start\n"
            return 0, said + ("The owner has it: %s.\n" % desk.held_said(h) if h else ""), ""
        if verb == "stop":
            # Answered first; then each window closed as a person would, the pieces stopped, and this process ended with
            # them (the next command starts both).
            desk.stopping = True

            def stop():
                try:
                    desk.close_all()
                finally:
                    desk.pieces.stop()
                    os._exit(0)
            threading.Timer(0.2, stop).start()
            return 0, "The desktop is stopped.\n", ""
        if verb == "dialog":
            if not args or args[0] not in ("accept", "dismiss"):
                raise Refused("a dialog is accepted or dismissed: desktop dialog accept [text] | desktop dialog dismiss")
            done = desk.browser_ready().answer_dialog(args[0] == "accept", " ".join(args[1:]) if len(args) > 1 else None)
            return 0, "%s the %s %s\n" % ("accepted" if args[0] == "accept" else "dismissed", done["type"], json.dumps(done["message"], ensure_ascii=False)), ""
        if verb == "open":
            address = args[0] if args else ""
            if not re.match(r"^(https?://|file://|about:)", address):
                raise Refused("an address begins with http, https, file or about")
            return 0, open_address(desk, address) + "\n", ""
        if verb == "text":
            got = desk.browser_ready().evaluate("document.title + '\\n' + location.href + '\\n' + (document.body ? document.body.innerText : '').slice(0, 20000)")
            return 0, (got or "") + "\n", ""
        if verb == "app":
            app = {"terminal": ["xterm", "-fa", "DejaVu Sans Mono", "-fs", "11", "-geometry", "100x30+120+80"], "editor": ["mousepad"]}.get(args[0] if args else "")
            if not app:
                raise Refused("app starts a terminal or an editor: desktop app <terminal|editor>")
            desk.ready()
            desk.pieces._spawn(app, "app-%s.log" % args[0])
            return 0, "Started the %s (%s).\n" % (args[0], app[0]), ""
        if verb in ("screenshot", "zoom"):
            now, printed = "--now" in args, "--base64" in args
            args = [a for a in args if a not in ("--now", "--base64")]
            # (--keep <dir>: a printed picture's own bytes kept there too, named by their SHA-256: evidence, C1 step 8.)
            keep = None
            if "--keep" in args:
                at = args.index("--keep")
                keep = args[at + 1] if at + 1 < len(args) else ""
                args = args[:at] + args[at + 2:]
                if not printed or not keep.startswith("/") or "\0" in keep:
                    raise Refused("--keep keeps a printed picture (--base64) in a folder named by its whole path")
            region = None
            if verb == "zoom":
                if len(args) < 4:
                    raise Refused("zoom takes a region: desktop zoom <x0> <y0> <x1> <y1> [file]")
                region, args = [int(v) if re.fullmatch(r"\d{1,5}", v) else -1 for v in args[:4]], args[4:]
            if printed:
                # (For a loop that hands the picture to its model: a PNG, as a data address on one line, and no file.)
                if args:
                    raise Refused("--base64 prints the picture: it writes no file")
                got = desk.tool(verb, {"format": "png", "settle": not now, **({"region": region} if region else {})})["image"]
                if keep:
                    os.makedirs(keep, exist_ok=True)
                    with open(os.path.join(keep, hashlib.sha256(got["data"]).hexdigest() + ".png"), "wb") as f:
                        f.write(got["data"])
                return 0, "data:%s;base64,%s\n" % (got["media_type"], base64.b64encode(got["data"]).decode()), ""
            path = args[0] if args else os.path.join(RUN, "shot-%d%d.png" % (int(time.time()), os.getpid()))
            path = path if os.path.isabs(path) else os.path.join(cwd, path)
            fmt = "jpeg" if re.search(r"\.jpe?g$", path, re.I) else "png"
            got = desk.tool(verb, {"format": fmt, "settle": not now, **({"region": region} if region else {})})["image"]
            with open(path, "wb") as f:
                f.write(got["data"])
            return 0, path + "\n", ""
        if verb == "look":
            eyes, space = "", ""
            while args[:1] in (["--eyes"], ["--space"]):
                if args[0] == "--eyes":
                    if len(args) < 2 or not re.fullmatch(r"[A-Za-z0-9._:-]+/[A-Za-z0-9._:/-]+", args[1]):
                        raise Refused("--eyes names a model as provider/model")
                    eyes = args[1]
                elif len(args) < 2 or not SPACE.fullmatch(args[1]):
                    raise Refused("--space is the eyes' own: pixels, per-mille, or scaled:<factor>")
                else:
                    space = args[1]
                args = args[2:]
            return look(desk, " ".join(args), env, eyes, space)
        if verb == "tree":
            pid, title = desk.focused_app()
            said = desk.tree.actable(app=" ".join(args) or None, pid=pid, title=title)
            if not said:
                return 0, "nothing to act on is on the accessibility bus there (desktop tree <app> names one; desktop shot to look)\n", ""
            lines, window = [], None
            for ref, node, box in said:
                w = node.get("window") or {}
                if w.get("path") != window:
                    window = w.get("path")
                    lines.append("%s \"%s\"" % (node["app"]["name"], w.get("name", "")))
                lines.append("  " + say_node(ref, node, box))
            return 0, "\n".join(lines) + "\n", ""
        if verb == "find":
            if len(args) < 2:
                raise Refused('find takes a role and a name: desktop find button "Send"')
            pid, _ = desk.focused_app()
            got = desk.tree.find(args[0], " ".join(args[1:]), pid=pid)
            if not got:
                return 1, "", "desktop: no %s named like \"%s\" is on the screen (desktop tree lists what is)\n" % (_role(args[0]), " ".join(args[1:]))
            ref, node, (x, y, w, h) = got
            return 0, "%d,%d · %s\n" % (x + w // 2, y + h // 2, say_node(ref, node, (x, y, w, h))), ""
        if verb == "click" and args and args[0].startswith("ref="):
            ref = _whole(args[0][4:], "ref=")
            node, (x, y, w, h) = desk.tree.at(ref)
            kind = args[1] if len(args) > 1 else "left"
            name = {"left": "left_click", "right": "right_click", "middle": "middle_click", "double": "double_click", "triple": "triple_click"}.get(kind)
            if not name:
                raise Refused("the button is left, right, middle, double or triple")
            answer = desk.tool(name, {"coordinate": [x + w // 2, y + h // 2], **held})
            answer = dict(answer, did="%s (ref=%d, %s \"%s\")" % (answer.get("did", ""), ref, node["role"], node["name"][:80]))
        elif verb == "click":
            if len(args) < 2:
                raise Refused("click takes two whole numbers: desktop click <x> <y> [left|right|middle|double|triple]")
            x, y = _whole(args[0], "click"), _whole(args[1], "click")
            kind = args[2] if len(args) > 2 else "left"
            name = {"left": "left_click", "right": "right_click", "middle": "middle_click", "double": "double_click", "triple": "triple_click"}.get(kind)
            if not name:
                raise Refused("the button is left, right, middle, double or triple")
            answer = desk.tool(name, {"coordinate": [x, y], **held})
        elif verb in ("left_click", "right_click", "middle_click", "double_click", "triple_click"):
            answer = desk.tool(verb, {**({"coordinate": [args[0], args[1]]} if len(args) >= 2 else {}), **held})
        elif verb == "mouse_move":
            if len(args) < 2:
                raise Refused("move takes two whole numbers: desktop move <x> <y>")
            answer = desk.tool(verb, {"coordinate": [args[0], args[1]]})
        elif verb == "left_click_drag":
            if len(args) < 4:
                raise Refused("drag takes where it starts and ends: desktop drag <x0> <y0> <x1> <y1>")
            answer = desk.tool(verb, {"start_coordinate": args[0:2], "coordinate": args[2:4], **held})
        elif verb in ("left_mouse_down", "left_mouse_up", "cursor_position", "windows", "settle"):
            answer = desk.tool(verb, {})
        elif verb == "scroll":
            if not args or args[0] not in ("up", "down", "left", "right"):
                raise Refused("scroll goes up, down, left or right: desktop scroll <up|down|left|right> [times] [x y]")
            times = _whole(args[1], "scroll") if len(args) > 1 else 1
            if not 1 <= times <= 50:
                raise Refused("scroll takes a whole number of times, from 1 to 50")
            answer = desk.tool(verb, {"scroll_direction": args[0], "scroll_amount": times, **({"coordinate": args[2:4]} if len(args) >= 4 else {}), **held})
        elif verb == "type":
            if not args:
                raise Refused("type takes the text to type: desktop type <text>")
            answer = desk.tool(verb, {"text": " ".join(args)})
        elif verb == "key":
            repeat = 1
            if "--repeat" in args:
                at = args.index("--repeat")
                repeat = _whole(args[at + 1] if at + 1 < len(args) else "", "--repeat")
                args = args[:at] + args[at + 2:]
            if not args or any(not re.fullmatch(r"[A-Za-z0-9_+]+", k) for k in args):
                raise Refused("keys are names like Return, Tab, Escape, ctrl+l (letters, digits, _ and + only)")
            answers = [desk.tool("key", {"text": k, "repeat": repeat}) for k in args]
            answer = answers[-1]
            if len(answers) > 1:
                answer = dict(answer, did="pressed " + ", ".join(k for k in args))
        elif verb == "hold_key":
            if len(args) < 2:
                raise Refused("hold_key takes a key and seconds: desktop hold_key <key> <seconds>")
            answer = desk.tool(verb, {"text": args[0], "duration": float(args[1])})
        elif verb == "wait":
            answer = desk.tool(verb, {"duration": float(args[0]) if args else 1})
        elif verb == "focus":
            desk.ready()
            if args:
                desk.bring(" ".join(args))
            f = desk.focus()
            return 0, ("focus: %s \"%s\"\n" % (f["app"], f["title"])) if f.get("app") or f.get("title") else "focus: nothing\n", ""
        else:
            return 2, "", HELP + "\n"
        if verb == "windows":
            lines = ["%s%s \"%s\" at %s" % ("* " if w["id"] == answer["focus"].get("id") else "  ", w["app"], w["title"], ",".join(map(str, w["box"] or []))) for w in answer["windows"]]
            return 0, "\n".join(lines) + "\n", ""
        if verb == "settle":
            return (0 if answer["settled"] else 1), ("settled in %g ms\n" % answer["settled_ms"]) if answer["settled"] else "", "" if answer["settled"] else "desktop: the screen didn't settle in %g s\n" % SETTLE_CAP
        return 0, (describe(answer) or answer.get("did", "")) + "\n", ""
    except Refused as error:
        return 2, "", "desktop: %s\n" % error
    except Failed as error:
        return 1, "", "desktop: %s\n" % error


def open_address(desk, address):
    """`address` in the page in front, once it has loaded: its title and address."""
    with desk.lock:
        browser = desk.browser_ready()
        target, page = browser.front()
        went = browser.call("Page.navigate", {"url": address}, page["session"], bound=30)
        if went.get("errorText"):
            raise Failed("the browser could not open that address (%s)" % went["errorText"])
        deadline = time.monotonic() + 30
        while time.monotonic() < deadline and not page.get("dialog"):
            try:
                if browser.evaluate("document.readyState") == "complete":
                    break
            except Failed:
                pass
            time.sleep(0.05)
        # Loaded, and painted: the screen let settle (a second at most), so the picture taken next is the page's at once.
        desk.settle(cap=1.0)
        if page.get("dialog"):
            # It put up a dialog as it loaded, and its load waits on that: opened, and the dialog said at once.
            return "%s · %s · %s" % (page.get("title") or "", page.get("url") or address, describe_dialog(page["dialog"]))
        return browser.evaluate("document.title + ' · ' + location.href") or ""


LEASE = "/work/.invincible-gateway.json"


def lease(path=LEASE):
    """The VM's model access, as its agent wrote it for the task (withGateway reads the same file): its gateway and token."""
    try:
        with open(path) as f:
            got = json.load(f)
        return {k: v for k, v in got.items() if k in ("INVINCIBLE_GATEWAY", "INVINCIBLE_TOKEN") and isinstance(v, str)} if isinstance(got, dict) else {}
    except (OSError, ValueError):
        return {}


# The space an agent's eyes answer places in, as their check measured it (core's model-checks.ts eyesSpaceOf).
SPACE = re.compile(r"pixels|per-mille|scaled:(?:0\.\d*[1-9]\d*|[1-9]\d*(?:\.\d+)?)")
# A place in the eyes' words: two numbers and a comma between them, as they are asked to give one (x,y).
PLACE = re.compile(r"(?<![\d.])(\d{1,5}(?:\.\d+)?)(\s*,\s*)(\d{1,5}(?:\.\d+)?)(?![\d.])")


def in_pixels(said, space):
    """The eyes' words with each place they give put in the screen's pixels, from the space they answer in (their check
    measured it: their own 0 to 1000, or a frame of their own); said so when one was. Their own pixels: as they are."""
    if not space or space == "pixels":
        return said
    fx, fy = (W / 1000, H / 1000) if space == "per-mille" else (float(space.split(":", 1)[1]),) * 2
    clamp = lambda v, most: max(0, min(most - 1, int(v + 0.5)))
    put, n = PLACE.subn(lambda m: "%d%s%d" % (clamp(float(m.group(1)) * fx, W), m.group(2), clamp(float(m.group(3)) * fy, H)), said)
    if not n:
        return said
    return put + ("\n(Its places, in its own 0 to 1000, are given here in the screen's pixels.)" if space == "per-mille" else "\n(Its places, in a frame of its own, are given here in the screen's pixels.)")


def look(desk, question, env, eyes="", space=""):
    """The question and a fresh picture of the screen, put to the model named for this VM (INVINCIBLE_EYES, or --eyes)
    through the gateway it was given: from the command's environment, or the VM's lease (/work/.invincible-gateway.json),
    the token never an argument. What comes back is the model's words: data, not orders."""
    if not question:
        return 2, "", 'desktop: look takes a question: desktop look "<question>"\n'
    env = {**lease(), **{k: v for k, v in env.items() if v}}
    eyes, gateway, token = eyes or env.get("INVINCIBLE_EYES", ""), env.get("INVINCIBLE_GATEWAY", ""), env.get("INVINCIBLE_TOKEN", "")
    space = space or env.get("INVINCIBLE_EYES_SPACE", "")
    if space and not SPACE.fullmatch(space):
        return 2, "", "desktop: INVINCIBLE_EYES_SPACE is the eyes' own space: pixels, per-mille, or scaled:<factor>\n"
    if not (eyes and gateway and token):
        return 3, "", "desktop: no model that can see is set for this VM (use desktop text to read a page, and desktop shot for a picture)\n"
    provider, _, model = eyes.partition("/")
    shot = desk.picture("jpeg")
    body = {"model": model, "max_tokens": 600, "messages": [{"role": "user", "content": [
        {"type": "text", "text": EYES_FRAMING + "\n\n" + question},
        {"type": "image_url", "image_url": {"url": "data:%s;base64,%s" % (shot["media_type"], base64.b64encode(shot["data"]).decode())}}]}]}
    request = urllib.request.Request(gateway + "/" + provider + "/chat/completions", data=json.dumps(body).encode(),
                                     headers={"authorization": "Bearer " + token, "content-type": "application/json", "user-agent": "invincible-desktop/2"})
    try:
        reply = json.load(urllib.request.urlopen(request, timeout=180))
    except urllib.error.HTTPError as error:
        return 1, "", "desktop: the model that looks could not answer (%s %s)\n" % (error.code, error.read().decode(errors="replace")[:300].replace("\n", " "))
    except Exception as error:
        return 1, "", "desktop: the model that looks could not be reached (%s)\n" % error
    return 0, in_pixels((reply["choices"][0]["message"].get("content") or "").strip() or "(it said nothing)", space) + "\n", ""


# ---------------------------------------------------------------- the socket

ENV_KEYS = ("INVINCIBLE_EYES", "INVINCIBLE_EYES_SPACE", "INVINCIBLE_GATEWAY", "INVINCIBLE_TOKEN")


# What an agent may ask while the owner holds the desktop, without waiting: its help, whether it is up, and `start`
# (which the owner's own stream runs first: `desktop stream`).
UNHELD = {"help", "--help", "-h", "status", "start"}
# What the owner may ask that is not their input: looking, and asking how it is. Their input (anything else) takes the
# desktop over if it is free, and starts a hold's idle time again; looking does neither, so a page that shows them the
# screen every few seconds keeps no hold of theirs alive.
LOOKS = UNHELD | {"screenshot", "zoom", "cursor_position", "text", "windows", "tree", "find", "settle", "look"}


def agent_waits(desk, verb):
    """An agent's request while the owner holds the desktop (C1 step 9): it waits for them to give it back, HOLD_WAIT s at
    most. A note for its stderr when it waited, or None; Held when the owner still has the desktop."""
    if verb in UNHELD:
        return None
    waited, still = desk.wait_for_owner()
    if still is not None:
        raise Held("nothing was done: %s. Work on something else meanwhile, and try again after." % desk.held_said(still))
    return "desktop: the owner had this desktop; they gave it back after %d s, and this ran then.\n" % round(waited) if waited >= 0.05 else None


class Who:
    """One connection to deskd: the owner's only on the owner's socket, from OWNER_UID, as the kernel says."""
    __slots__ = ("owner",)

    def __init__(self, owner=False):
        self.owner = owner


def peer_uid(conn):
    """The uid of the process at a socket's other end, the kernel's word: SO_PEERCRED (LOCAL_PEERCRED on a Mac, for its tests)."""
    try:
        if hasattr(socket, "SO_PEERCRED"):
            return struct.unpack("3i", conn.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, struct.calcsize("3i")))[1]
        if hasattr(socket, "LOCAL_PEERCRED"):
            return struct.unpack_from("I", conn.getsockopt(0, socket.LOCAL_PEERCRED, 76), 4)[0]
    except OSError:
        pass
    return None


def session(desk, request, who=None):
    """One request of a held session (the host's, for the owner or the agent's loop): a toolset member, or a command line.
    The owner's are the requests of an owner's connection (Who), whatever a request says: only they take the desktop
    over and give it back, theirs never wait, and each answer of theirs says whether they have it (`hold`)."""
    owner = who is not None and who.owner
    answer = _session(desk, request, who, owner)
    if owner:
        answer["hold"] = desk.hold_view(desk.holding())
    return answer


def _session(desk, request, who, owner):
    rid = request.get("id")
    name = str(request.get("name", ""))
    try:
        if name in ("take", "release", "hold"):
            if not owner:
                raise Refused("only the owner takes the desktop over, or gives it back: through their node")
            if name == "hold":
                # (Whether they have it, and nothing else: every answer of theirs says so.)
                return {"id": rid, "ok": True}
            if name == "release":
                return {"id": rid, "ok": True, "released": desk.give_back(who, anyone=True)}
            i = request.get("input") or {}
            desk.take(who, idle=min(max(float(i.get("idle", HOLD_IDLE)), 1.0), HOLD_MOST), most=min(max(float(i.get("most", HOLD_MOST)), 1.0), HOLD_MOST))
            return {"id": rid, "ok": True, "took": True}
        note = None
        took = False
        verb = str(request["argv"][0]) if request.get("argv") else name
        if owner:
            if ALIASES.get(verb, verb) not in LOOKS:
                took = desk.take(who, keep=True)[1]
        else:
            note = agent_waits(desk, verb)
        if "argv" in request:
            code, out, err = cli(desk, [str(a) for a in request["argv"]], request.get("cwd", "/work"), {k: str(v) for k, v in (request.get("env") or {}).items() if k in ENV_KEYS})
            return {"id": rid, "ok": code == 0, "code": code, "stdout": out, "stderr": (note or "") + err, **({"took": True} if took else {})}
        answer = desk.tool(name, request.get("input") or {})
        if request.get("screenshot") and "image" not in answer:
            answer["image"] = desk.picture(request.get("format", "png"), settle=request.get("settle", True))
        if "image" in answer:
            image = answer["image"]
            answer["image"] = {"media_type": image["media_type"], "data": base64.b64encode(image["data"]).decode(), "width": image["width"], "height": image["height"], "settled": image["settled"]}
        answer["text"] = (note or "") + describe(answer)
        return {"id": rid, **answer, **({"took": True} if took else {})}
    except Held as error:
        return {"id": rid, "ok": False, "held": True, "code": HELD_EXIT, "error": str(error)}
    except Refused as error:
        return {"id": rid, "ok": False, "refused": True, "error": str(error)}
    except Failed as error:
        return {"id": rid, "ok": False, "error": str(error)}
    except Exception as error:  # one request's bug is never the session's end
        return {"id": rid, "ok": False, "error": "deskd: %s" % error}


def handle(desk, conn, owners=False):
    f = conn.makefile("rwb")
    # (This connection: the owner's only on their socket and from their uid. A take-over is bound to it, and its end
    # gives the desktop back.)
    who = Who(owners and peer_uid(conn) == OWNER_UID)
    try:
        hello = f.readline()
        if hello == b"ARGV\n":
            # A command line is always the agent's (the owner's go through the node's held session).
            request = json.loads(f.readline().decode("utf-8", "replace"))
            argv = [str(a) for a in request.get("argv", [])]
            try:
                note = agent_waits(desk, ALIASES.get(argv[0], argv[0]) if argv else "help")
                code, out, err = cli(desk, argv, request.get("cwd", "/work"), {k: str(v) for k, v in (request.get("env") or {}).items() if k in ENV_KEYS})
                err = (note or "") + err
            except Held as error:
                code, out, err = HELD_EXIT, "", "desktop: %s\n" % error
            out_b, err_b = out.encode(), err.encode()
            f.write(b"exit=%d out=%d err=%d\n" % (code, len(out_b), len(err_b)) + out_b + err_b)
            f.flush()
        elif hello == b"SESSION\n":
            for line in f:
                try:
                    request = json.loads(line.decode("utf-8", "replace"))
                except ValueError:
                    request = {"name": ""}
                f.write(json.dumps(session(desk, request, who), ensure_ascii=False).encode() + b"\n")
                f.flush()
    except (BrokenPipeError, ConnectionResetError):
        pass
    finally:
        desk.give_back(who)
        try:
            f.close()
            conn.close()
        except OSError:
            pass


def listening(path, mode):
    """A socket at `path` with `mode`, bound under another name and put in place once it listens: it is there only when it answers."""
    staging = os.path.join(os.path.dirname(path), ".s%d" % (os.getpid() % 10 ** 8))  # (no longer than the socket's own name: a path's room is short)
    for stale in (path, staging):
        try:
            os.unlink(stale)
        except OSError:
            pass
    s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    old = os.umask(0o777 & ~mode)
    s.bind(staging)
    os.umask(old)
    s.listen(16)
    os.rename(staging, path)
    return s


def owners_socket(run=RUN):
    """The owner's socket: beside the run directory (in the VM's /tmp), so the directory stays the agent's alone."""
    return run.rstrip("/") + ".owner.sock"


def serve(desk=None, run=RUN):
    """The agent's socket in the VM's own /tmp, its alone (mode 0600, in a directory of 0700), and the owner's beside it
    (0666, so the node's exec as OWNER_UID reaches it): a connection there is the owner's only from that uid, as the
    kernel says. One deskd at a time: the second leaves."""
    os.makedirs(run, mode=0o700, exist_ok=True)
    lock = open(os.path.join(run, "deskd.lock"), "w")
    try:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except OSError:
        return 0
    desk = desk or Desk()
    # (The owner's first: once the agent's is there, deskd answers on both, as what waits for the agent's takes it to.)
    owners = listening(owners_socket(run), 0o666)
    agents = listening(os.path.join(run, "deskd.sock"), 0o600)

    def accept(s, mine):
        while True:
            conn, _ = s.accept()
            threading.Thread(target=handle, args=(desk, conn, mine), daemon=True).start()

    threading.Thread(target=accept, args=(owners, True), daemon=True).start()
    accept(agents, False)


if __name__ == "__main__":
    if sys.argv[1:2] == ["help"]:
        print(HELP)
        sys.exit(0)
    sys.exit(serve())
