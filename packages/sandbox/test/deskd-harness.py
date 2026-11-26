#!/usr/bin/env python3
"""deskd as it runs in a VM, with stand-ins for what a VM has: the display (its input, its pixels, its windows), the
window manager's list, the browser and the desktop's processes. Each stand-in writes what it was asked to the trace
file, a JSON line a call, and the tests read it. Nothing here is deskd's own logic: that is imported, as it is.

  INVINCIBLE_DESKTOP_RUN=<dir> DESKD_TRACE=<file> python3 deskd-harness.py      serves on <dir>/deskd.sock
  DESKD_QUIET=1             the screen never changes after an input (an action that shows nothing)
  DESKD_BUSY=1              the screen never stops changing (a page that animates)
  DESKD_FOCUS=…             what has the keyboard's focus: field (a text field of the browser's page, the default),
                            body (the page, with nothing in it that takes text), bar (the browser's own bar), xterm,
                            mousepad, none
"""
import importlib.util, json, os, sys, threading, time

sys.dont_write_bytecode = True  # (no __pycache__ left beside the image's own files)
HERE = os.path.dirname(os.path.abspath(__file__))
spec = importlib.util.spec_from_file_location("deskd", os.path.join(HERE, "../../../sandbox/desktop/deskd.py"))
deskd = importlib.util.module_from_spec(spec)
spec.loader.exec_module(deskd)

TRACE = os.environ["DESKD_TRACE"]
QUIET = os.environ.get("DESKD_QUIET") == "1"
FOCUS = os.environ.get("DESKD_FOCUS", "field")
BUSY = os.environ.get("DESKD_BUSY") == "1"
lock = threading.Lock()


def trace(**what):
    with lock, open(TRACE, "a") as f:
        f.write(json.dumps(what) + "\n")


# A US keyboard's map, as X gives it: keysym -> (keycode, level).
NAMES = {"Return": 0xFF0D, "Tab": 0xFF09, "Escape": 0xFF1B, "BackSpace": 0xFF08, "Delete": 0xFFFF, "Left": 0xFF51, "Up": 0xFF52, "Right": 0xFF53,
         "Down": 0xFF54, "Home": 0xFF50, "End": 0xFF57, "Page_Up": 0xFF55, "Page_Down": 0xFF56, "space": 0x20, "Control_L": 0xFFE3, "Shift_L": 0xFFE1,
         "Alt_L": 0xFFE9, "Super_L": 0xFFEB, "F5": 0xFFC2, "Insert": 0xFF63}
KEYS = {}
code = 10
for lower, upper in zip("abcdefghijklmnopqrstuvwxyz1234567890-=[];',./\\`", "ABCDEFGHIJKLMNOPQRSTUVWXYZ!@#$%^&*()_+{}:\"<>?|~"):
    KEYS[ord(lower)] = (code, 0)
    KEYS[ord(upper)] = (code, 1)
    code += 1
for name, sym in NAMES.items():
    KEYS[sym] = (code, 0)
    code += 1
CODE_NAMES = {c: next((n for n, v in NAMES.items() if v == s), None) or (chr(s) if s < 0x100 else None) for s, (c, level) in KEYS.items() if level == 0}


class Screen:
    """When the screen was last drawn on, as DAMAGE would say: 5 ms after each input, unless quiet; always, if busy."""

    def __init__(self):
        self.lock = threading.Lock()
        self._last = time.monotonic() - 10
        self.appeared, self.gone = [], []

    @property
    def last_change(self):
        return time.monotonic() if BUSY else self._last

    @last_change.setter
    def last_change(self, t):
        self._last = t

    def drawn(self):
        if not QUIET:
            with self.lock:
                self.last_change = time.monotonic() + 0.005

    def since(self, t):
        with self.lock:
            return (self.last_change > t, self.last_change - t if self.last_change > t else None)

    def take(self):
        with self.lock:
            a, g = self.appeared, self.gone
            self.appeared, self.gone = [], []
        return a, g

    def own(self, text):
        # (A selection held for a paste: the stand-in app that pastes it is the trace's reader.)
        trace(call="own", text=text)


class FakeDisplay:
    w, h = deskd.W, deskd.H

    def __init__(self, screen):
        self.screen = screen
        self.at = (0, 0)
        self.windows = {"0x400001": {"id": "0x400001", "title": "about:blank - Chromium", "app": "Chromium", "dialog": False, "box": [0, 0, 1280, 800]},
                        "0x500001": {"id": "0x500001", "title": "xterm", "app": "XTerm", "dialog": False, "box": [20, 600, 300, 150]},
                        "0x600001": {"id": "0x600001", "title": "Untitled 1 - Mousepad", "app": "Mousepad", "dialog": False, "box": [800, 300, 400, 300]}}
        self.focused = {"xterm": "0x500001", "mousepad": "0x600001", "none": "0x0"}.get(FOCUS, "0x400001")
        self.stacking = ["0x400001", "0x500001", "0x600001"]  # bottom to top

    def client_at(self, x, y):
        """The topmost window whose box holds the point, as the window manager stacks them."""
        for w in reversed(self.stacking):
            bx, by, bw, bh = self.windows[w]["box"]
            if bx <= x < bx + bw and by <= y < by + bh:
                return int(w, 16)
        return 0

    def activate(self, w):
        trace(call="activate", window=hex(w))
        # (The window manager takes its time: a few milliseconds later it is in front, with the focus.)
        def later():
            time.sleep(0.02)
            self.focused = hex(w)
            if hex(w) in self.stacking:
                self.stacking.remove(hex(w))
                self.stacking.append(hex(w))
        threading.Thread(target=later, daemon=True).start()

    def motion(self, x, y):
        self.at = (x, y)
        trace(call="motion", x=x, y=y)
        self.screen.drawn()

    def button(self, b, down):
        trace(call="button", button=b, down=down)
        if down:
            # Click to focus, as the window manager does, in its own time.
            under = self.client_at(*self.at)
            if under and hex(under) != self.focused:
                def later():
                    time.sleep(0.03)
                    self.focused = hex(under)
                threading.Thread(target=later, daemon=True).start()
        if not down:
            self.screen.drawn()

    def key(self, code, down):
        trace(call="key", key=CODE_NAMES.get(code, code), down=down)
        if not down:
            self.screen.drawn()
            if CODE_NAMES.get(code) == "F5":  # (a key that opens a dialog, for the window watcher's answer)
                self.windows["0x400002"] = {"id": "0x400002", "title": "Save As", "app": "Mousepad", "dialog": True, "box": [300, 200, 600, 400]}
                with self.screen.lock:
                    self.screen.appeared.append(self.windows["0x400002"])

    def sync(self):
        pass

    def keymap(self):
        return KEYS

    def keysym(self, name):
        return NAMES.get(name) or (ord(name) if len(name) == 1 else 0)

    def pointer(self):
        return self.at

    def capture(self):
        # A white screen with a black square at 600,400: what the pictures are checked against.
        frame = bytearray(b"\xff" * (self.w * self.h * 4))
        for y in range(400, 410):
            frame[y * self.w * 4 + 600 * 4:y * self.w * 4 + 610 * 4] = b"\x00\x00\x00\xff" * 10
        return frame, self.w * 4

    def cursor(self):
        # A 2x2 red pointer whose hotspot is where the pointer is.
        return (self.at[0], self.at[1], 2, 2, [0xFFFF0000] * 4)

    def active(self):
        return int(self.focused, 16)

    def window(self, w):
        return self.windows.get(hex(w), {"id": hex(w), "title": "", "app": "", "dialog": False, "box": None})

    def clients(self):
        return [int(k, 16) for k in self.windows]


class FakeBrowser:
    ws = True

    def loading_since(self, t):
        return False

    def loading(self):
        return False

    def front(self):
        return ("page-1", {"session": "s1", "url": "about:blank"})

    typed = ""

    def evaluate(self, expression, bound=deskd.CDP_BOUND):
        trace(call="evaluate", expression=expression[:60])
        if expression == deskd.FOCUS_PROBE:
            return {"field": [True, True, "INPUT"], "body": [True, False, "BODY"]}.get(FOCUS, [False, False, None])
        if expression == deskd.FIELD_VALUE:
            return FakeBrowser.typed
        if expression == "document.readyState":
            return "complete"
        if "' · '" in expression:
            return "Example · https://example.test/"
        return "Example\nhttps://example.test/\nHello"

    def call(self, method, params=None, session=None, bound=deskd.CDP_BOUND):
        trace(call="cdp", method=method, params=params)
        if method == "Input.insertText":
            FakeBrowser.typed += params["text"]
        return {}


class FakePieces:
    def start(self):
        trace(call="start")

    def stop(self):
        trace(call="stop")

    def display_up(self):
        return True

    def browser_up(self):
        return True

    def browser_running(self):
        return True

    def _spawn(self, argv, log):
        trace(call="spawn", argv=argv)


if sys.argv[1:2] == ["help"]:
    print(deskd.HELP)
    sys.exit(0)
screen = Screen()
desk = deskd.Desk(pieces=FakePieces(), display=FakeDisplay(screen), watch=screen, browser=FakeBrowser())
trace(call="serving", pid=os.getpid())
sys.exit(deskd.serve(desk, run=os.environ["INVINCIBLE_DESKTOP_RUN"]))
