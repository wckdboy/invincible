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
  DESKD_DIALOG=confirm      the page puts up a JavaScript confirm once it has been clicked
  DESKD_PASTE_TAKES=…       how long the app with the focus takes to take a paste, in seconds, or never (0.01)
  DESKD_LANDED=…            what the accessibility tree reads before the caret of the field with the focus, once
                            anything was typed or pasted (unset: the tree says nothing)
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
DIALOG = os.environ.get("DESKD_DIALOG")
PASTE_TAKES = os.environ.get("DESKD_PASTE_TAKES", "0.01")
clicked = threading.Event()
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
        self.given = threading.Event()
        self.pending = True

    def paste_keys_arrived(self):
        """The app with the focus got its paste keys: it asks for the text, in its own time (DESKD_PASTE_TAKES)."""
        if not getattr(self, "pending", False) or PASTE_TAKES == "never":
            return
        self.pending = False
        def take():
            time.sleep(float(PASTE_TAKES))
            trace(call="taken")
            self.given.set()
        threading.Thread(target=take, daemon=True).start()

    def taken(self, bound):
        return self.given.wait(bound)


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
        # Input waits in the connection's buffer, as Xlib's requests do, until a sync or a round trip sends it.
        self.out = []
        self.lock = threading.Lock()

    def _deliver(self):
        with self.lock:
            out, self.out = self.out, []
        for event in out:
            event()

    def client_at(self, x, y, delivering=False):
        """The topmost window whose box holds the point, as the window manager stacks them."""
        if not delivering:
            self._deliver()
            trace(call="client_at")
        for w in reversed(self.stacking):
            bx, by, bw, bh = self.windows[w]["box"]
            if bx <= x < bx + bw and by <= y < by + bh:
                return int(w, 16)
        return 0

    def close(self, w):
        self._deliver()
        trace(call="close", window=hex(w))
        self.windows.pop(hex(w), None)

    def activate(self, w):
        self._deliver()
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
        def sent():
            self.at = (x, y)
            trace(call="motion", x=x, y=y)
            self.screen.drawn()
        with self.lock:
            self.out.append(sent)

    def button(self, b, down):
        def sent():
            trace(call="button", button=b, down=down, at=time.monotonic())
            if not down:
                clicked.set()
            if down:
                # Click to focus, as the window manager does, in its own time.
                under = self.client_at(*self.at, delivering=True)
                if under and hex(under) != self.focused:
                    def later():
                        time.sleep(0.03)
                        self.focused = hex(under)
                    threading.Thread(target=later, daemon=True).start()
            if not down:
                self.screen.drawn()
        with self.lock:
            self.out.append(sent)

    def key(self, code, down):
        def sent():
            trace(call="key", key=CODE_NAMES.get(code, code), down=down, at=time.monotonic())
            if not down:
                self.screen.drawn()
                if CODE_NAMES.get(code) == "F5":  # (a key that opens a dialog, for the window watcher's answer)
                    self.windows["0x400002"] = {"id": "0x400002", "title": "Save As", "app": "Mousepad", "dialog": True, "box": [300, 200, 600, 400]}
                    with self.screen.lock:
                        self.screen.appeared.append(self.windows["0x400002"])
                if CODE_NAMES.get(code) in ("Insert", "v"):  # (a paste's keys: the app asks for the text)
                    self.screen.paste_keys_arrived()
        with self.lock:
            self.out.append(sent)

    def sync(self):
        self._deliver()

    def keymap(self):
        return KEYS

    def keysym(self, name):
        return NAMES.get(name) or (ord(name) if len(name) == 1 else 0)

    def pointer(self):
        self._deliver()
        return self.at

    def capture(self):
        self._deliver()
        # A white screen with a black square at 600,400: what the pictures are checked against.
        frame = bytearray(b"\xff" * (self.w * self.h * 4))
        for y in range(400, 410):
            frame[y * self.w * 4 + 600 * 4:y * self.w * 4 + 610 * 4] = b"\x00\x00\x00\xff" * 10
        return frame, self.w * 4

    def cursor(self):
        # A 2x2 red pointer whose hotspot is where the pointer is.
        return (self.at[0], self.at[1], 2, 2, [0xFFFF0000] * 4)

    def active(self):
        self._deliver()
        trace(call="active")
        return int(self.focused, 16)

    def window(self, w):
        self._deliver()
        return self.windows.get(hex(w), {"id": hex(w), "title": "", "app": "", "dialog": False, "box": None})

    def prop(self, w, name, kind, as_ulongs=False):
        # (A window's process, as the window manager's list says it: the browser's 300, the terminal's 500, the editor's 600.)
        if name == "_NET_WM_PID":
            return [{"0x400001": 300, "0x500001": 500, "0x600001": 600}.get(hex(w), 0)]
        return None

    def name(self, w):
        return self.windows.get(hex(w), {}).get("title", "")

    def clients(self):
        self._deliver()
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

    def dialog(self):
        return {"type": DIALOG, "message": "Delete the draft?", "default": "", "page": "page-1"} if DIALOG and clicked.is_set() else None

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

    def window_manager_running(self):
        return True

    def watched(self):
        """Someone watches while the test's file is there (the stream's encoder running, in a VM)."""
        return os.path.exists(os.environ.get("DESKD_WATCHED", "/nonexistent/deskd-watched"))

    def _spawn(self, argv, log, keep=None, env=None):
        trace(call="spawn", argv=argv, **({"env": env} if env else {}))


if sys.argv[1:2] == ["help"]:
    print(deskd.help_text())
    sys.exit(0)
screen = Screen()
class FakeTree:
    """The accessibility tree, as far as typing asks it: what is before the caret of the field with the focus."""
    def caret_text(self, pid=None, title=None):
        trace(call="caret_text")
        return os.environ.get("DESKD_LANDED")


desk = deskd.Desk(pieces=FakePieces(), display=FakeDisplay(screen), watch=screen, browser=FakeBrowser(), tree=FakeTree() if "DESKD_LANDED" in os.environ else None)
trace(call="serving", pid=os.getpid())


def ends_with_its_test():
    """Ended once its test is over, its trace gone with the test's folder: a deskd the `desktop` client started on its
    own, after an idle stop, is apart from the test (its own session, as in a VM), so no test can stop it, and one that
    never brings its desktop up never stops for being unused either. Every run of deskd.test.ts left one running."""
    while os.path.exists(TRACE):
        time.sleep(0.2)
    os._exit(0)


threading.Thread(target=ends_with_its_test, daemon=True).start()
sys.exit(deskd.serve(desk, run=os.environ["INVINCIBLE_DESKTOP_RUN"]))
