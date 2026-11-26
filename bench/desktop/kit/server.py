#!/usr/bin/env python3
"""The desktop bench's server, on the VM's own loopback (a bench VM has no network).

  GET  /<page>                   the test pages in /work/bench/pages
  GET  /slow                     a page that takes 1.5 s to come (a click that navigates, and the picture after it)
  POST /submit                   a form: written to /work/bench/out/form-<ms>.json, answered with a Thanks page
  POST /…/chat/completions       a stand-in for the eyes, answering at once with /work/bench/eyes-answer.txt
                                 (default "640,400"): so a look is timed without the model

Nothing here is the node's: it stands where the network and the model would be.
"""
import json, os, sys, time, urllib.parse
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

ROOT = "/work/bench"
OUT = ROOT + "/out"
os.makedirs(OUT, exist_ok=True)
LOG = open(OUT + "/server.log", "a", buffering=1)


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *a, **k):
        super().__init__(*a, directory=ROOT + "/pages", **k)

    def do_GET(self):
        if self.path.startswith("/slow"):
            time.sleep(1.5)
            self._send(200, "text/html; charset=utf-8", b"<!doctype html><title>slow page</title><style>body{background:#000}</style><h1 style=color:#fff>Arrived</h1>")
            return
        return super().do_GET()

    def log_message(self, fmt, *args):
        LOG.write("%.3f %s\n" % (time.time(), fmt % args))

    def do_POST(self):
        n = int(self.headers.get("content-length") or 0)
        body = self.rfile.read(n)
        if self.path == "/submit":
            fields = {k: v[0] for k, v in urllib.parse.parse_qs(body.decode("utf-8", "replace"), keep_blank_values=True).items()}
            name = "%s/form-%d.json" % (OUT, int(time.time() * 1000))
            with open(name, "w", encoding="utf-8") as f:
                json.dump(fields, f, ensure_ascii=False)
            page = "<!doctype html><meta charset=utf-8><title>Thanks</title><h1>Thanks</h1><pre>%s</pre>" % json.dumps(fields, ensure_ascii=False)
            self._send(200, "text/html; charset=utf-8", page.encode())
        elif self.path.endswith("/chat/completions"):
            LOG.write("%.3f eyes body=%d\n" % (time.time(), len(body)))
            try:
                answer = open(ROOT + "/eyes-answer.txt").read().strip()
            except OSError:
                answer = "640,400"
            self._send(200, "application/json", json.dumps({"choices": [{"message": {"content": answer}}]}).encode())
        else:
            self._send(404, "text/plain", b"no")

    def _send(self, code, ctype, data):
        self.send_response(code)
        self.send_header("content-type", ctype)
        self.send_header("content-length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)


if __name__ == "__main__":
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8000
    ThreadingHTTPServer(("127.0.0.1", port), Handler).serve_forever()
