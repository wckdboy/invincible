#!/usr/bin/env python3
"""The desktop bench's stand-in for the eyes. Where a model would answer "where is X" from a screenshot, this answers
from the truth: the page's DOM over Chromium's debugging port, or the X window list. So a task's runs measure the
machinery (the actions, focus, timing, dialogs) with perfect targeting: everything but the model. Prints JSON.

  oracle.py dom <css>               centre of the element in the page in front, in screen pixels
  oracle.py settings-font           centre of chrome://settings' "Font size" select, and its value
  oracle.py pref <dotted.pref>      a value from Chromium's Preferences file (the gate for a settings change)
  oracle.py font-reset              the font size back to Medium (16), through settingsPrivate (between runs)
  oracle.py eval <js> [url-regex]   a value from the page in front (or the one whose address matches)
  oracle.py targets                 the browser's pages: title and address
  oracle.py window <name-regex>     centre and size of the newest visible window whose name matches
  oracle.py focus                   the window that has the keyboard's focus, and its name
  oracle.py pids <class-regex>      the process ids of the apps whose windows' class matches (_NET_WM_PID)
"""
import ctypes, json, os, re, sys, urllib.request

PORT = "http://127.0.0.1:9222"
# Chromium fills the screen at 0,0 with its own frame: the page's viewport starts 4 px in and 87 px down (C0, measured:
# a click at 640,450 on the screen arrives at 636,363 in the page). Checked against the viewport's size on every use.
VIEW = {"dx": 4, "dy": 87, "w": 1271, "h": 708}


def pages():
    return [t for t in json.load(urllib.request.urlopen(PORT + "/json", timeout=5)) if t.get("type") == "page"]


def evaluate(expr, match=None):
    import websocket
    found = pages()
    if match:
        found = [p for p in found if re.search(match, p.get("url", ""))] or found
    ws = websocket.create_connection(found[0]["webSocketDebuggerUrl"], suppress_origin=True, timeout=20)
    ws.send(json.dumps({"id": 1, "method": "Runtime.evaluate", "params": {"expression": expr, "returnByValue": True, "awaitPromise": True}}))
    while True:
        r = json.loads(ws.recv())
        if r.get("id") == 1:
            ws.close()
            return r.get("result", {}).get("result", {}).get("value")


def to_screen(cx, cy, iw, ih):
    if (iw, ih) != (VIEW["w"], VIEW["h"]):
        return {"error": "the viewport is %sx%s, not %sx%s: the window moved or changed size" % (iw, ih, VIEW["w"], VIEW["h"])}
    if not (0 <= cx < iw and 0 <= cy < ih):
        return {"offscreen": True, "client": [cx, cy]}
    return {"x": int(round(VIEW["dx"] + cx)), "y": int(round(VIEW["dy"] + cy))}


DEEP = """(()=>{const out=[];const walk=n=>{if(!n)return;if(n.nodeType===1)out.push(n);if(n.shadowRoot)for(const k of n.shadowRoot.children)walk(k);for(const k of n.children||[])walk(k)};walk(document.documentElement);return out})()"""


class Windows:
    """The X window tree, read with plain Xlib calls (no tool between)."""

    def __init__(self):
        self.x = ctypes.CDLL("libX11.so.6")
        x = self.x
        x.XOpenDisplay.restype = ctypes.c_void_p
        x.XOpenDisplay.argtypes = [ctypes.c_char_p]
        x.XDefaultRootWindow.restype = ctypes.c_ulong
        x.XDefaultRootWindow.argtypes = [ctypes.c_void_p]
        x.XQueryTree.argtypes = [ctypes.c_void_p, ctypes.c_ulong, ctypes.POINTER(ctypes.c_ulong), ctypes.POINTER(ctypes.c_ulong), ctypes.POINTER(ctypes.POINTER(ctypes.c_ulong)), ctypes.POINTER(ctypes.c_uint)]
        x.XFree.argtypes = [ctypes.c_void_p]
        x.XInternAtom.restype = ctypes.c_ulong
        x.XInternAtom.argtypes = [ctypes.c_void_p, ctypes.c_char_p, ctypes.c_int]
        x.XGetWindowProperty.argtypes = [ctypes.c_void_p, ctypes.c_ulong, ctypes.c_ulong, ctypes.c_long, ctypes.c_long, ctypes.c_int, ctypes.c_ulong, ctypes.POINTER(ctypes.c_ulong), ctypes.POINTER(ctypes.c_int), ctypes.POINTER(ctypes.c_ulong), ctypes.POINTER(ctypes.c_ulong), ctypes.POINTER(ctypes.c_void_p)]
        x.XGetInputFocus.argtypes = [ctypes.c_void_p, ctypes.POINTER(ctypes.c_ulong), ctypes.POINTER(ctypes.c_int)]
        x.XTranslateCoordinates.argtypes = [ctypes.c_void_p, ctypes.c_ulong, ctypes.c_ulong, ctypes.c_int, ctypes.c_int, ctypes.POINTER(ctypes.c_int), ctypes.POINTER(ctypes.c_int), ctypes.POINTER(ctypes.c_ulong)]
        self.dpy = x.XOpenDisplay(os.environ.get("DISPLAY", ":1").encode())
        if not self.dpy:
            raise SystemExit(json.dumps({"error": "no display"}))
        self.root = x.XDefaultRootWindow(self.dpy)
        self.atoms = {n: x.XInternAtom(self.dpy, n.encode(), 0) for n in ("_NET_WM_NAME", "UTF8_STRING", "WM_NAME", "WM_CLASS", "STRING", "_NET_WM_PID", "CARDINAL")}

        class Attrs(ctypes.Structure):
            _fields_ = [("x", ctypes.c_int), ("y", ctypes.c_int), ("width", ctypes.c_int), ("height", ctypes.c_int), ("border_width", ctypes.c_int), ("depth", ctypes.c_int), ("visual", ctypes.c_void_p), ("root", ctypes.c_ulong), ("class_", ctypes.c_int), ("bit_gravity", ctypes.c_int), ("win_gravity", ctypes.c_int), ("backing_store", ctypes.c_int), ("backing_planes", ctypes.c_ulong), ("backing_pixel", ctypes.c_ulong), ("save_under", ctypes.c_int), ("colormap", ctypes.c_ulong), ("map_installed", ctypes.c_int), ("map_state", ctypes.c_int), ("all_event_masks", ctypes.c_long), ("your_event_mask", ctypes.c_long), ("do_not_propagate_mask", ctypes.c_long), ("override_redirect", ctypes.c_int), ("screen", ctypes.c_void_p)]

        self.Attrs = Attrs
        x.XGetWindowAttributes.argtypes = [ctypes.c_void_p, ctypes.c_ulong, ctypes.POINTER(Attrs)]

    def prop(self, w, name, kind):
        t, f, n, left, data = ctypes.c_ulong(), ctypes.c_int(), ctypes.c_ulong(), ctypes.c_ulong(), ctypes.c_void_p()
        if self.x.XGetWindowProperty(self.dpy, w, self.atoms[name], 0, 4096, 0, self.atoms[kind] if kind else 0, ctypes.byref(t), ctypes.byref(f), ctypes.byref(n), ctypes.byref(left), ctypes.byref(data)) != 0 or not data.value:
            return None
        try:
            return ctypes.string_at(data.value, n.value * (f.value // 8)).decode("utf-8", "replace")
        finally:
            self.x.XFree(data)

    def pid(self, w):
        t, f, n, left, data = ctypes.c_ulong(), ctypes.c_int(), ctypes.c_ulong(), ctypes.c_ulong(), ctypes.c_void_p()
        if self.x.XGetWindowProperty(self.dpy, w, self.atoms["_NET_WM_PID"], 0, 1, 0, self.atoms["CARDINAL"], ctypes.byref(t), ctypes.byref(f), ctypes.byref(n), ctypes.byref(left), ctypes.byref(data)) != 0 or not data.value:
            return None
        try:
            return ctypes.cast(data, ctypes.POINTER(ctypes.c_ulong))[0] if n.value else None
        finally:
            self.x.XFree(data)

    def name(self, w):
        return self.prop(w, "_NET_WM_NAME", "UTF8_STRING") or self.prop(w, "WM_NAME", "STRING") or ""

    def children(self, w):
        root, parent, kids, n = ctypes.c_ulong(), ctypes.c_ulong(), ctypes.POINTER(ctypes.c_ulong)(), ctypes.c_uint()
        if not self.x.XQueryTree(self.dpy, w, ctypes.byref(root), ctypes.byref(parent), ctypes.byref(kids), ctypes.byref(n)):
            return [], 0
        out = [kids[i] for i in range(n.value)]
        if kids:
            self.x.XFree(kids)
        return out, parent.value

    def geometry(self, w):
        a = self.Attrs()
        if not self.x.XGetWindowAttributes(self.dpy, w, ctypes.byref(a)):
            return None
        rx, ry, child = ctypes.c_int(), ctypes.c_int(), ctypes.c_ulong()
        self.x.XTranslateCoordinates(self.dpy, w, self.root, 0, 0, ctypes.byref(rx), ctypes.byref(ry), ctypes.byref(child))
        return {"x": rx.value, "y": ry.value, "w": a.width, "h": a.height, "viewable": a.map_state == 2}

    def all(self):
        """Every window, in the order the tree gives (bottom to top), depth first."""
        out, stack = [], [self.root]
        while stack:
            w = stack.pop()
            out.append(w)
            kids, _ = self.children(w)
            stack.extend(reversed(kids))
        return out

    def focus(self):
        w, revert = ctypes.c_ulong(), ctypes.c_int()
        self.x.XGetInputFocus(self.dpy, ctypes.byref(w), ctypes.byref(revert))
        win = w.value
        # The focus as a tool would name it: the first window up from it that says what application it is.
        while win and win != self.root and self.prop(win, "WM_CLASS", "STRING") is None:
            _, parent = self.children(win)
            win = parent
        return win if win != self.root else w.value


if __name__ == "__main__":
    a = sys.argv[1:]
    if a[0] == "dom":
        v = evaluate("(()=>{const e=document.querySelector(%s);if(!e)return null;e.scrollIntoViewIfNeeded&&e.scrollIntoViewIfNeeded();const r=e.getBoundingClientRect();return [r.left+r.width/2,r.top+r.height/2,innerWidth,innerHeight]})()" % json.dumps(a[1]))
        print(json.dumps({"error": "no such element"} if v is None else to_screen(*v)))
    elif a[0] == "settings-font":
        v = evaluate("(()=>{for(const e of %s){if(e.tagName==='SELECT'&&/font size/i.test(e.getAttribute('aria-label')||'')){const r=e.getBoundingClientRect();return [r.left+r.width/2,r.top+r.height/2,innerWidth,innerHeight,e.value]}}return null})()" % DEEP, match=r"^chrome://settings")
        if v is None:
            print(json.dumps({"error": "no font size select on the page in front"}))
        else:
            r = to_screen(*v[:4])
            r["value"] = v[4]
            print(json.dumps(r))
    elif a[0] == "pref":
        prefs = json.load(open(os.path.expanduser("~/.config/chromium/Default/Preferences")))
        cur = prefs
        for k in a[1].split("."):
            cur = cur.get(k) if isinstance(cur, dict) else None
        print(json.dumps({"pref": a[1], "value": cur}))
    elif a[0] == "font-reset":
        v = evaluate("new Promise(r=>chrome.settingsPrivate.setPref('webkit.webprefs.default_font_size',16,'',ok=>r(ok)))", match=r"^chrome://settings")
        print(json.dumps({"reset": v}))
    elif a[0] == "eval":
        print(json.dumps({"value": evaluate(a[1], match=a[2] if len(a) > 2 else None)}, ensure_ascii=False))
    elif a[0] == "targets":
        print(json.dumps([{"title": p.get("title"), "url": p.get("url")} for p in pages()], ensure_ascii=False))
    elif a[0] == "focus":
        w = Windows()
        f = w.focus()
        print(json.dumps({"window": hex(f), "name": w.name(f)}, ensure_ascii=False))
    elif a[0] == "pids":
        w = Windows()
        found = set()
        for win in w.all():
            klass = (w.prop(win, "WM_CLASS", "STRING") or "").split("\0")
            if any(re.search(a[1], k) for k in klass if k):
                pid = w.pid(win)
                if pid:
                    found.add(pid)
        print(json.dumps(sorted(found)))
    elif a[0] == "window":
        w = Windows()
        found = [(win, g) for win in w.all() for g in [w.geometry(win)] if g and g["viewable"] and re.search(a[1], w.name(win))]
        if not found:
            print(json.dumps({"error": "no window named like %s" % a[1]}))
        else:
            win, g = found[-1]
            print(json.dumps({"x": g["x"] + g["w"] // 2, "y": g["y"] + g["h"] // 2, "window": hex(win), "w": g["w"], "h": g["h"], "name": w.name(win)}, ensure_ascii=False))
