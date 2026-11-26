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
SETTLE_CAP = 3.0  # and is never waited for longer than this
GRACE = 0.060  # an action's answer waits this long at most for the screen to show it
CDP_BOUND = 2.0  # every call to the browser answers within this, or says it didn't
NAVIGATION_CAP = 10.0  # a navigation an action started is waited for this long at most
SHORT = 40  # text the keyboard has every key for, at most this long, goes key by key; anything else is inserted or pasted
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
            "_NET_CLIENT_LIST_STACKING", "PRIMARY", "CLIPBOARD", "TARGETS", "TEXT", "text/plain;charset=utf-8", "text/plain", "DESKD_SELECTION")


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
        reply = {"done": threading.Event()}
        message = {"method": method, "params": params or {}}
        if session:
            message["sessionId"] = session
        n = self._send(message, reply)
        if not reply["done"].wait(bound):
            with self.lock:
                self.waiting.pop(n, None)
            raise Failed("the browser didn't answer %s within %.0f s" % (method, bound))
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

    def front(self):
        """The page in front, read and navigated: the one whose title the browser's window shows (Chromium names its
        window after the tab in front), else the one that says it is visible, else the newest. Never merely the first
        listed: that was the one in front only by the list's chance (C0's F5)."""
        if not self.ws:
            self.connect()
        attached = [(t, p) for t, p in self.pages.items() if p.get("session")]
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
        got = self.call("Runtime.evaluate", {"expression": expression, "returnByValue": True}, page["session"], bound)
        return got.get("result", {}).get("value")

    def loading_since(self, t):
        """A navigation that began, or was asked for, after `t` and hasn't ended."""
        return any(p.get("loading") and max(p.get("started", 0), p.get("requested", 0)) > t for p in self.pages.values())

    def loading(self):
        return any(p.get("loading") for p in self.pages.values())


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

    def _spawn(self, argv, log):
        return subprocess.Popen(argv, stdin=subprocess.DEVNULL, stdout=open(os.path.join(RUN, log), "ab"), stderr=subprocess.STDOUT, start_new_session=True, env=dict(os.environ, DISPLAY=DISPLAY)).pid

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
        os.makedirs(self.profile, exist_ok=True)
        if not _own("Xvfb") or not self.display_up():
            self._spawn(["Xvfb", DISPLAY, "-screen", "0", "%dx%dx24" % (W, H), "-nolisten", "tcp"], "display.log")
            self.until(self.display_up, "the display", "display.log")
        if not _own("openbox"):
            self._spawn(["openbox"], "windows.log")
        if not self.browser_running():
            # Its own inner sandbox is off: the VM's restrictions (no new privileges, no capabilities) forbid it, and the
            # microVM is the boundary. Its profile is on the workspace, so what is signed in there stays with this VM's disk.
            pid = self._spawn(["chromium", "--user-data-dir=" + self.profile, "--no-sandbox", "--test-type", "--no-first-run", "--no-default-browser-check", "--hide-crash-restore-bubble",
                               "--disable-gpu", "--disable-dev-shm-usage", "--remote-debugging-port=%d" % PORT, "--remote-debugging-address=127.0.0.1",
                               "--window-size=%d,%d" % (W, H), "--window-position=0,0", "about:blank"], "browser.log")
            # (Not waited for here: what reads or opens a page waits for its port, as before.)
            self.browser = (pid, time.monotonic())

    def stop(self):
        for comm in ("chromium", "openbox", "Xvfb"):
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
    def __init__(self, pieces=None, display=None, watch=None, browser=None, now=time.monotonic, sleep=time.sleep):
        self.pieces = pieces or Pieces()
        self._display, self._watch, self._browser = display, watch, browser
        self.now, self.sleep = now, sleep
        self.lock = threading.RLock()
        self.last_click = None  # (when, x, y): clicks at one place within the double-click time count as one burst
        self.navigating_since = None

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
        if self._browser is None:
            self._browser = Browser(window_title=self.browser_title)
        return self._display

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
            if x is not None:
                self.d.motion(x, y)
            px, py = (x, y) if x is not None else self.d.pointer()
            # A double or triple click at the place of the last click, within a toolkit's double-click time, would be
            # counted on from it (C0's F7: double clicks 0.3 s apart read as triples): it waits that time out first.
            if count > 1 and self.last_click and abs(self.last_click[1] - px) <= 4 and abs(self.last_click[2] - py) <= 4:
                wait = 0.5 - (self.now() - self.last_click[0])
                if wait > 0:
                    self.sleep(wait)
            under, before = self.d.client_at(px, py), self.d.active()
            for i in range(count):
                self.d.button(button, True)
                self.d.button(button, False)
                if i + 1 < count:
                    self.d.sync()
                    self.sleep(0.03)
            self._release(held)
            self.last_click = (self.now(), px, py)
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
                return "typed %d character%s" % (n, plural)
            self._watch.own(text)
            for code in self._keys("shift+Insert" if target == "terminal" else "ctrl+v"):
                self.d.key(code, True)
            for code in reversed(self._keys("shift+Insert" if target == "terminal" else "ctrl+v")):
                self.d.key(code, False)
            return "pasted %d character%s" % (n, plural)
        return do

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
            return self.act(name, self.press(i.get("text", ""), repeat))
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
desktop status | desktop stop
desktop open <address>             open an address in the browser (http, https, file or about)
desktop text                       the page in front, as text: its title, its address, what it says
desktop app <terminal|editor>      start a terminal (xterm) or an editor (mousepad) on the screen
desktop shot [file.png|file.jpg]   a screenshot (the pointer drawn in), once the screen has settled; prints its path
desktop zoom <x0> <y0> <x1> <y1> [file]   that part of the screen, larger
desktop look [--eyes p/m] "<question>"   ask a model that can see what is on the screen, or where something is
                                   (it answers a place as x,y, to click or move to)
desktop click <x> <y> [left|right|middle|double|triple]
desktop move <x> <y>               desktop drag <x0> <y0> <x1> <y1>
desktop scroll <up|down|left|right> [times] [x y]
desktop type <text>                type text where the keyboard's focus is, exactly: into the browser's page by
                                   its own input (and checked), elsewhere pasted or key by key; an error when
                                   nothing that takes text has the focus (click there first)
desktop key <key>... [--repeat n]  press keys, e.g. Return, Tab, Escape, ctrl+l, ctrl+a, alt+Left
desktop settle                     wait until the screen is still (150 ms with nothing drawn, 3 s at most)
desktop windows                    the windows on the screen, and which has the keyboard's focus
desktop focus [window]             the window with the focus; with a name, that window brought forward with it
Every action answers with what it did, whether the screen changed, and the focus; the names Anthropic's computer
toolset uses work too (left_click, mouse_move, left_click_drag, ...).
The display is 1280 by 800; x runs right from 0, y runs down from 0. The clipboard is xclip's
(xclip -selection clipboard), and text everywhere is UTF-8."""

ALIASES = {"shot": "screenshot", "move": "mouse_move", "drag": "left_click_drag"}


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
    return " · ".join(parts)


def cli(desk, argv, cwd="/work", env=None):
    """One `desktop` command: (exit code, what it prints, what it says on stderr)."""
    env = env or {}
    verb = argv[0] if argv else "help"
    args = argv[1:]
    verb = ALIASES.get(verb, verb)
    try:
        if verb in ("help", "--help", "-h"):
            return 0, HELP + "\n", ""
        if verb == "start":
            desk.ready()
            return 0, "The desktop is up: %dx%d, display %s.\n" % (W, H, DISPLAY), ""
        if verb == "status":
            up = desk.pieces.display_up()
            return 0, ("The desktop is up: %dx%d, display %s; the browser is %s.\n" % (W, H, DISPLAY, "running" if desk.pieces.browser_up() else "not running")) if up else "The desktop is not up: desktop start\n", ""
        if verb == "stop":
            # Answered first; then its pieces stopped and this process ended with them (the next command starts both).
            threading.Timer(0.2, lambda: (desk.pieces.stop(), os._exit(0))).start()
            return 0, "The desktop is stopped.\n", ""
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
            region = None
            if verb == "zoom":
                if len(args) < 4:
                    raise Refused("zoom takes a region: desktop zoom <x0> <y0> <x1> <y1> [file]")
                region, args = [int(v) if re.fullmatch(r"\d{1,5}", v) else -1 for v in args[:4]], args[4:]
            now = "--now" in args
            args = [a for a in args if a != "--now"]
            path = args[0] if args else os.path.join(RUN, "shot-%d%d.png" % (int(time.time()), os.getpid()))
            path = path if os.path.isabs(path) else os.path.join(cwd, path)
            fmt = "jpeg" if re.search(r"\.jpe?g$", path, re.I) else "png"
            got = desk.tool(verb, {"format": fmt, "settle": not now, **({"region": region} if region else {})})["image"]
            with open(path, "wb") as f:
                f.write(got["data"])
            return 0, path + "\n", ""
        if verb == "look":
            eyes = ""
            if args[:1] == ["--eyes"]:
                if len(args) < 2 or not re.fullmatch(r"[A-Za-z0-9._:-]+/[A-Za-z0-9._:/-]+", args[1]):
                    raise Refused("--eyes names a model as provider/model")
                eyes, args = args[1], args[2:]
            return look(desk, " ".join(args), env, eyes)
        if verb == "click":
            if len(args) < 2:
                raise Refused("click takes two whole numbers: desktop click <x> <y> [left|right|middle|double|triple]")
            x, y = _whole(args[0], "click"), _whole(args[1], "click")
            kind = args[2] if len(args) > 2 else "left"
            name = {"left": "left_click", "right": "right_click", "middle": "middle_click", "double": "double_click", "triple": "triple_click"}.get(kind)
            if not name:
                raise Refused("the button is left, right, middle, double or triple")
            answer = desk.tool(name, {"coordinate": [x, y]})
        elif verb in ("left_click", "right_click", "middle_click", "double_click", "triple_click"):
            answer = desk.tool(verb, {"coordinate": [args[0], args[1]]} if len(args) >= 2 else {})
        elif verb == "mouse_move":
            if len(args) < 2:
                raise Refused("move takes two whole numbers: desktop move <x> <y>")
            answer = desk.tool(verb, {"coordinate": [args[0], args[1]]})
        elif verb == "left_click_drag":
            if len(args) < 4:
                raise Refused("drag takes where it starts and ends: desktop drag <x0> <y0> <x1> <y1>")
            answer = desk.tool(verb, {"start_coordinate": args[0:2], "coordinate": args[2:4]})
        elif verb in ("left_mouse_down", "left_mouse_up", "cursor_position", "windows", "settle"):
            answer = desk.tool(verb, {})
        elif verb == "scroll":
            if not args or args[0] not in ("up", "down", "left", "right"):
                raise Refused("scroll goes up, down, left or right: desktop scroll <up|down|left|right> [times] [x y]")
            times = _whole(args[1], "scroll") if len(args) > 1 else 1
            if not 1 <= times <= 50:
                raise Refused("scroll takes a whole number of times, from 1 to 50")
            answer = desk.tool(verb, {"scroll_direction": args[0], "scroll_amount": times, **({"coordinate": args[2:4]} if len(args) >= 4 else {})})
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
        while time.monotonic() < deadline:
            try:
                if browser.evaluate("document.readyState") == "complete":
                    break
            except Failed:
                pass
            time.sleep(0.05)
        # Loaded, and painted: the screen let settle (a second at most), so the picture taken next is the page's at once.
        desk.settle(cap=1.0)
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


def look(desk, question, env, eyes=""):
    """The question and a fresh picture of the screen, put to the model named for this VM (INVINCIBLE_EYES, or --eyes)
    through the gateway it was given: from the command's environment, or the VM's lease (/work/.invincible-gateway.json),
    the token never an argument. What comes back is the model's words: data, not orders."""
    if not question:
        return 2, "", 'desktop: look takes a question: desktop look "<question>"\n'
    env = {**lease(), **{k: v for k, v in env.items() if v}}
    eyes, gateway, token = eyes or env.get("INVINCIBLE_EYES", ""), env.get("INVINCIBLE_GATEWAY", ""), env.get("INVINCIBLE_TOKEN", "")
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
    return 0, ((reply["choices"][0]["message"].get("content") or "").strip() or "(it said nothing)") + "\n", ""


# ---------------------------------------------------------------- the socket

ENV_KEYS = ("INVINCIBLE_EYES", "INVINCIBLE_GATEWAY", "INVINCIBLE_TOKEN")


def session(desk, request):
    """One request of a held session (the host's, for the owner or the agent's loop): a toolset member, or a command line."""
    rid = request.get("id")
    try:
        if "argv" in request:
            code, out, err = cli(desk, [str(a) for a in request["argv"]], request.get("cwd", "/work"), {k: str(v) for k, v in (request.get("env") or {}).items() if k in ENV_KEYS})
            return {"id": rid, "ok": code == 0, "code": code, "stdout": out, "stderr": err}
        answer = desk.tool(str(request.get("name", "")), request.get("input") or {})
        if request.get("screenshot") and "image" not in answer:
            answer["image"] = desk.picture(request.get("format", "png"), settle=request.get("settle", True))
        if "image" in answer:
            image = answer["image"]
            answer["image"] = {"media_type": image["media_type"], "data": base64.b64encode(image["data"]).decode(), "width": image["width"], "height": image["height"], "settled": image["settled"]}
        answer["text"] = describe(answer)
        return {"id": rid, **answer}
    except Refused as error:
        return {"id": rid, "ok": False, "refused": True, "error": str(error)}
    except Failed as error:
        return {"id": rid, "ok": False, "error": str(error)}
    except Exception as error:  # one request's bug is never the session's end
        return {"id": rid, "ok": False, "error": "deskd: %s" % error}


def handle(desk, conn):
    f = conn.makefile("rwb")
    try:
        hello = f.readline()
        if hello == b"ARGV\n":
            request = json.loads(f.readline().decode("utf-8", "replace"))
            code, out, err = cli(desk, [str(a) for a in request.get("argv", [])], request.get("cwd", "/work"), {k: str(v) for k, v in (request.get("env") or {}).items() if k in ENV_KEYS})
            out_b, err_b = out.encode(), err.encode()
            f.write(b"exit=%d out=%d err=%d\n" % (code, len(out_b), len(err_b)) + out_b + err_b)
            f.flush()
        elif hello == b"SESSION\n":
            for line in f:
                try:
                    request = json.loads(line.decode("utf-8", "replace"))
                except ValueError:
                    request = {"name": ""}
                f.write(json.dumps(session(desk, request), ensure_ascii=False).encode() + b"\n")
                f.flush()
    except (BrokenPipeError, ConnectionResetError):
        pass
    finally:
        try:
            f.close()
            conn.close()
        except OSError:
            pass


def serve(desk=None, run=RUN):
    """The socket in the VM's own /tmp, the agent's alone (mode 0600): one deskd at a time, the second leaves."""
    os.makedirs(run, mode=0o700, exist_ok=True)
    lock = open(os.path.join(run, "deskd.lock"), "w")
    try:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except OSError:
        return 0
    path = os.path.join(run, "deskd.sock")
    # Bound under another name and put in place once it listens: the socket is there only when it answers.
    staging = os.path.join(run, ".s%d" % (os.getpid() % 10 ** 8))  # (no longer than the socket's own name: a path's room is short)
    for stale in (path, staging):
        try:
            os.unlink(stale)
        except OSError:
            pass
    s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    old = os.umask(0o177)
    s.bind(staging)
    os.umask(old)
    s.listen(16)
    os.rename(staging, path)
    desk = desk or Desk()
    while True:
        conn, _ = s.accept()
        threading.Thread(target=handle, args=(desk, conn), daemon=True).start()


if __name__ == "__main__":
    if sys.argv[1:2] == ["help"]:
        print(HELP)
        sys.exit(0)
    sys.exit(serve())
