#!/usr/bin/env python3
"""The desktop bench's probe, run in the VM: it watches the screen from outside the code under test, with reads of a
fraction of a millisecond. Plain ctypes against libX11 and libXext (the image needs no Python imaging packages).

  probe.py pixel X Y                       the pixel's 0xRRGGBB
  probe.py a2p X Y TIMEOUT_S -- CMD...     run CMD (desktop click 640 400, say); JSON: when its pixels changed, when
                                           it returned
  probe.py grabs N                         time N full-screen grabs: XGetImage, XShmGetImage
  probe.py settle TIMEOUT_S QUIET_MS       wait until 48 points of the screen stop changing; how long it took
  probe.py settle-full TIMEOUT_S QUIET_MS  the same over every pixel (MIT-SHM)
"""
import ctypes, json, os, subprocess, sys, time

X = ctypes.CDLL("libX11.so.6")
Xext = ctypes.CDLL("libXext.so.6")
libc = ctypes.CDLL("libc.so.6", use_errno=True)


class XImage(ctypes.Structure):
    _fields_ = [("width", ctypes.c_int), ("height", ctypes.c_int), ("xoffset", ctypes.c_int), ("format", ctypes.c_int),
                ("data", ctypes.c_void_p), ("byte_order", ctypes.c_int), ("bitmap_unit", ctypes.c_int),
                ("bitmap_bit_order", ctypes.c_int), ("bitmap_pad", ctypes.c_int), ("depth", ctypes.c_int),
                ("bytes_per_line", ctypes.c_int), ("bits_per_pixel", ctypes.c_int), ("red_mask", ctypes.c_ulong),
                ("green_mask", ctypes.c_ulong), ("blue_mask", ctypes.c_ulong), ("obdata", ctypes.c_void_p)]


class ShmInfo(ctypes.Structure):
    _fields_ = [("shmseg", ctypes.c_ulong), ("shmid", ctypes.c_int), ("shmaddr", ctypes.c_void_p), ("readOnly", ctypes.c_int)]


X.XOpenDisplay.restype = ctypes.c_void_p
X.XOpenDisplay.argtypes = [ctypes.c_char_p]
X.XDefaultRootWindow.restype = ctypes.c_ulong
X.XDefaultRootWindow.argtypes = [ctypes.c_void_p]
X.XGetImage.restype = ctypes.POINTER(XImage)
X.XGetImage.argtypes = [ctypes.c_void_p, ctypes.c_ulong, ctypes.c_int, ctypes.c_int, ctypes.c_uint, ctypes.c_uint, ctypes.c_ulong, ctypes.c_int]
X.XDestroyImage.argtypes = [ctypes.POINTER(XImage)]
X.XDefaultScreen.argtypes = [ctypes.c_void_p]
X.XDefaultVisual.restype = ctypes.c_void_p
X.XDefaultVisual.argtypes = [ctypes.c_void_p, ctypes.c_int]
X.XDefaultDepth.argtypes = [ctypes.c_void_p, ctypes.c_int]
X.XDisplayWidth.argtypes = [ctypes.c_void_p, ctypes.c_int]
X.XDisplayHeight.argtypes = [ctypes.c_void_p, ctypes.c_int]
X.XSync.argtypes = [ctypes.c_void_p, ctypes.c_int]
Xext.XShmCreateImage.restype = ctypes.POINTER(XImage)
Xext.XShmCreateImage.argtypes = [ctypes.c_void_p, ctypes.c_void_p, ctypes.c_uint, ctypes.c_int, ctypes.c_char_p, ctypes.POINTER(ShmInfo), ctypes.c_uint, ctypes.c_uint]
Xext.XShmAttach.argtypes = [ctypes.c_void_p, ctypes.POINTER(ShmInfo)]
Xext.XShmGetImage.argtypes = [ctypes.c_void_p, ctypes.c_ulong, ctypes.POINTER(XImage), ctypes.c_int, ctypes.c_int, ctypes.c_ulong]
Xext.XShmQueryExtension.argtypes = [ctypes.c_void_p]
libc.shmget.argtypes = [ctypes.c_int, ctypes.c_size_t, ctypes.c_int]
libc.shmat.restype = ctypes.c_void_p
libc.shmat.argtypes = [ctypes.c_int, ctypes.c_void_p, ctypes.c_int]
libc.shmctl.argtypes = [ctypes.c_int, ctypes.c_int, ctypes.c_void_p]

ALL = 0xFFFFFFFF
ZPIXMAP = 2
dpy = X.XOpenDisplay(os.environ.get("DISPLAY", ":1").encode())
if not dpy:
    sys.exit("probe: no display")
root = X.XDefaultRootWindow(dpy)
scr = X.XDefaultScreen(dpy)
W, H = X.XDisplayWidth(dpy, scr), X.XDisplayHeight(dpy, scr)


def pixel(x, y):
    img = X.XGetImage(dpy, root, x, y, 1, 1, ALL, ZPIXMAP)
    v = ctypes.cast(img.contents.data, ctypes.POINTER(ctypes.c_uint32))[0] & 0xFFFFFF
    X.XDestroyImage(img)
    return v


def grid():
    # 48 points: enough to tell "the screen changed" without a whole grab
    return tuple(pixel(int(W * (i + 0.5) / 8), int(H * (j + 0.5) / 6)) for i in range(8) for j in range(6))


def a2p(x, y, timeout, cmd):
    ref = pixel(x, y)
    t0 = time.monotonic()
    proc = subprocess.Popen(cmd, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
    changed = None
    exited = None
    while time.monotonic() - t0 < timeout:
        if changed is None and pixel(x, y) != ref:
            changed = time.monotonic()
        if exited is None and proc.poll() is not None:
            exited = time.monotonic()
        if changed is not None and exited is not None:
            break
        time.sleep(0.0005)
    err = proc.stderr.read().decode(errors="replace").strip() if proc.stderr else ""
    if exited is None:
        proc.wait()
        exited = time.monotonic()
    return {"pixels_ms": None if changed is None else round((changed - t0) * 1000, 1),
            "command_ms": round((exited - t0) * 1000, 1), "code": proc.returncode,
            "stale_after_exit": changed is None or changed > exited, "err": err[-200:]}


class Shm:
    """A full-screen MIT-SHM grab, reused: about 0.1 ms a frame."""

    def __init__(self):
        self.info = ShmInfo()
        vis = X.XDefaultVisual(dpy, scr)
        self.img = Xext.XShmCreateImage(dpy, vis, X.XDefaultDepth(dpy, scr), ZPIXMAP, None, ctypes.byref(self.info), W, H)
        self.size = self.img.contents.bytes_per_line * H
        self.info.shmid = libc.shmget(0, self.size, 0o1000 | 0o600)
        self.info.shmaddr = libc.shmat(self.info.shmid, None, 0)
        self.img.contents.data = self.info.shmaddr
        Xext.XShmAttach(dpy, ctypes.byref(self.info))
        X.XSync(dpy, 0)
        libc.shmctl(self.info.shmid, 0, None)  # IPC_RMID once both ends hold it

    def frame(self):
        Xext.XShmGetImage(dpy, root, self.img, 0, 0, ALL)
        X.XSync(dpy, 0)
        return ctypes.string_at(self.info.shmaddr, self.size)


def grabs(n):
    t = []
    for _ in range(n):
        s = time.monotonic()
        X.XDestroyImage(X.XGetImage(dpy, root, 0, 0, W, H, ALL, ZPIXMAP))
        t.append((time.monotonic() - s) * 1000)
    out = {"xgetimage_ms": summary(t)}
    if Xext.XShmQueryExtension(dpy):
        shm = Shm()
        t = []
        for _ in range(n):
            s = time.monotonic()
            Xext.XShmGetImage(dpy, root, shm.img, 0, 0, ALL)
            X.XSync(dpy, 0)
            t.append((time.monotonic() - s) * 1000)
        out["xshmgetimage_ms"] = summary(t)
    return out


def settle_full(timeout, quiet_ms):
    """Until no pixel of the whole screen has changed for quiet_ms."""
    shm = Shm()
    t0 = time.monotonic()
    last = shm.frame()
    since = t0
    while time.monotonic() - t0 < timeout:
        time.sleep(0.015)
        f = shm.frame()
        now = time.monotonic()
        if f != last:
            last, since = f, now
        elif (now - since) * 1000 >= quiet_ms:
            return {"settled_ms": round((since - t0) * 1000, 1), "waited_ms": round((now - t0) * 1000, 1)}
    return {"settled_ms": None, "waited_ms": round((time.monotonic() - t0) * 1000, 1)}


def settle(timeout, quiet_ms):
    t0 = time.monotonic()
    last = grid()
    since = t0
    while time.monotonic() - t0 < timeout:
        time.sleep(0.01)
        g = grid()
        now = time.monotonic()
        if g != last:
            last, since = g, now
        elif (now - since) * 1000 >= quiet_ms:
            return {"settled_ms": round((since - t0) * 1000, 1), "waited_ms": round((now - t0) * 1000, 1)}
    return {"settled_ms": None, "waited_ms": round((time.monotonic() - t0) * 1000, 1)}


def summary(t):
    t = sorted(t)
    return {"n": len(t), "p50": round(t[len(t) // 2], 2), "min": round(t[0], 2), "max": round(t[-1], 2)}


if __name__ == "__main__":
    a = sys.argv[1:]
    if a[0] == "pixel":
        print("0x%06x" % pixel(int(a[1]), int(a[2])))
    elif a[0] == "a2p":
        i = a.index("--")
        print(json.dumps(a2p(int(a[1]), int(a[2]), float(a[3]), a[i + 1:])))
    elif a[0] == "grabs":
        print(json.dumps(grabs(int(a[1]))))
    elif a[0] == "settle-full":
        print(json.dumps(settle_full(float(a[1]), float(a[2]))))
    elif a[0] == "settle":
        print(json.dumps(settle(float(a[1]), float(a[2]))))
    elif a[0] == "size":
        print("%dx%d" % (W, H))
