#!/usr/bin/env python3
"""The demo: five acts, each printing a number measured in this run, and one that breaks it.

  act 1  two machines, one build          the same commit and the same binary bytes on both
  act 2  one node, one request at a time  what one machine does alone
  act 3  the same work through ONE URL    dispatch: both machines answer, one endpoint
  act 4  a node nobody configured        announce -> seed -> discover, and what it refuses to mean
  act 5  a receipt you can check offline  what the signature proves, and what it does not
  act 6  break it                         kill the peer mid-flight and keep sending

Every act verifies its own answers - HTTP 200, at least one completion token, and non-empty
text (a thinking model puts it in `reasoning_content` and leaves `content` empty) - and prints
only numbers it measured in this run. The summary refuses to print a verdict for an act that
did not run, and the script exits non-zero when an act's invariant breaks.

Usage (the head's API is loopback-only, so reach it through a forward):

  ssh -N -L 17777:127.0.0.1:7777 root@<head-ip> &
  ./demo/run.py --token "$TOKEN" --head http://127.0.0.1:17777 \
      --head-host root@<head-ip> --peer-host root@<peer-ip>

`--token` is `invincible token` on the head. A node that only serves on loopback and a driver
that reaches it through SSH is the honest way to run this: nothing is exposed to the internet.
"""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.request

MODEL = "qwen3-0.6b"
PROMPT = "Count from 1 to 40 in words, comma separated, and nothing else."
MAX_TOKENS = 64

SSH_BASE = [
    "-o", "IdentitiesOnly=yes",
    "-o", "BatchMode=yes",
    "-o", "StrictHostKeyChecking=no",
    "-o", "ConnectTimeout=15",
]


class Act:
    """One act of the demo: its title, and the numbers it measured (empty if it did not run)."""

    def __init__(self, n: int, title: str) -> None:
        self.n = n
        self.title = title
        self.measured: list[str] = []

    def say(self, line: str) -> None:
        self.measured.append(line)
        print(f"   {line}", flush=True)

    def head(self) -> None:
        print(f"\n-- {self.n}. {self.title}", flush=True)


def ssh(host: str, key: str, command: str, timeout: int = 300) -> tuple[int, str]:
    argv = ["ssh", *SSH_BASE]
    if key:
        argv += ["-i", key]
    argv += [host, command]
    p = subprocess.run(argv, capture_output=True, text=True, timeout=timeout)
    return p.returncode, (p.stdout + p.stderr).strip()


def post(url: str, token: str, body: dict, timeout: int = 300) -> tuple[int, dict, dict]:
    data = json.dumps(body).encode()
    req = urllib.request.Request(
        url,
        data=data,
        headers={"Content-Type": "application/json", "Authorization": f"Bearer {token}"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.status, json.loads(r.read() or b"{}"), dict(r.headers)
    except urllib.error.HTTPError as e:
        payload = e.read()
        try:
            return e.code, json.loads(payload or b"{}"), dict(e.headers)
        except json.JSONDecodeError:
            return e.code, {"error": payload.decode(errors="replace")}, dict(e.headers)


def get(url: str, token: str, timeout: int = 60) -> tuple[int, dict]:
    req = urllib.request.Request(url, headers={"Authorization": f"Bearer {token}"})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.status, json.loads(r.read() or b"{}")
    except urllib.error.HTTPError as e:
        return e.code, {}


def verified(status: int, obj: dict, headers: dict) -> dict | None:
    """An answer counts only if it is a 200 with at least one completion token and real text."""
    if status != 200:
        return None
    usage = obj.get("usage") or {}
    tokens = int(usage.get("completion_tokens") or 0)
    choices = obj.get("choices") or [{}]
    message = (choices[0] or {}).get("message") or {}
    text = ((message.get("content") or "") + (message.get("reasoning_content") or "")).strip()
    if tokens <= 0 or not text:
        return None
    lower = {k.lower(): v for k, v in headers.items()}
    return {
        "tokens": tokens,
        "chars": len(text),
        "by": lower.get("invincible-dispatched-to"),
        "id": lower.get("invincible-request-id"),
        "request": json.dumps(
            {
                "model": MODEL,
                "messages": [{"role": "user", "content": PROMPT}],
                "max_tokens": MAX_TOKENS,
                "temperature": 0,
            }
        ),
    }


def run_batch(url: str, token: str, n: int, concurrency: int = 1) -> tuple[float, list[dict], list[str]]:
    """Send n requests, `concurrency` of them in flight at once.

    Concurrency is what makes the two workloads comparable: a single machine reached by eight
    clients queues behind its slots exactly as the dispatcher's two machines do, so the speedup in
    act 3 is two machines against one at the same load, not concurrency against its absence.
    """
    body = {
        "model": MODEL,
        "messages": [{"role": "user", "content": PROMPT}],
        "max_tokens": MAX_TOKENS,
        "temperature": 0,
    }
    answers: list[dict] = []
    failures: list[str] = []
    lock = threading.Lock()
    slots = threading.Semaphore(max(1, concurrency))

    def one(i: int) -> None:
        with slots:
            status, obj, headers = post(url, token, body)
            answer = verified(status, obj, headers)
            with lock:
                if answer is None:
                    failures.append(f"request {i + 1}: HTTP {status} {str(obj)[:120]}")
                else:
                    answers.append(answer)

    started = time.monotonic()
    threads = [threading.Thread(target=one, args=(i,)) for i in range(n)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    return time.monotonic() - started, answers, failures


def main() -> int:
    ap = argparse.ArgumentParser(description="the five acts, measured")
    ap.add_argument("--head", default="http://127.0.0.1:17777", help="the head's API, as this box sees it")
    ap.add_argument("--token", default=os.environ.get("INVINCIBLE_TOKEN", ""), help="`invincible token` on the head")
    ap.add_argument("--head-host", default="", help="ssh destination for the head, e.g. root@10.0.0.1")
    ap.add_argument("--peer-host", default="", help="ssh destination for the peer")
    ap.add_argument("--ssh-key", default="", help="identity for both ssh destinations")
    ap.add_argument("--requests", type=int, default=8, help="requests per act (default 8)")
    ap.add_argument("--concurrency", type=int, default=0, help="in flight at once (0 = all of them)")
    ap.add_argument("--seed", default="http://10.0.1.1:7789", help="the discovery seed the peer announces to")
    ap.add_argument("--verify-bin", default="", help="a local invincible binary, for the offline receipt check")
    args = ap.parse_args()

    if not args.token:
        ap.error("--token (or INVINCIBLE_TOKEN) is required: run `invincible token` on the head")
    for name in ("head_host", "peer_host"):
        if not getattr(args, name):
            ap.error(f"--{name.replace('_', '-')} is required")

    n = args.requests
    conc = args.concurrency or n
    chat = f"{args.head}/v1/chat/completions"
    dispatch = f"{args.head}/v1/dispatch/chat/completions"
    acts: list[Act] = []
    broke = False
    dead_rate: float | None = None
    dead_count = 0

    # ---- 1. two machines, one build -------------------------------------------------------------
    act = Act(1, "two machines, one build")
    acts.append(act)
    act.head()
    builds: dict[str, str] = {}
    for name, host in (("head", args.head_host), ("peer", args.peer_host)):
        code, out = ssh(
            host,
            args.ssh_key,
            "cd /root/invincible 2>/dev/null && git rev-parse --short HEAD; "
            "/root/.local/bin/invincible --version 2>/dev/null; "
            "sha256sum /root/.local/bin/invincible 2>/dev/null | cut -c1-16",
        )
        lines = [ln.strip() for ln in out.splitlines() if ln.strip()]
        if code != 0 or len(lines) < 3:
            act.say(f"{name}: could not ask ({out[:120]})")
            broke = True
            continue
        sha, version, digest = lines[0], lines[1], lines[2]
        builds[name] = digest
        act.say(f"{host.split('@')[-1]:16} {sha:10} {version:20} binary {digest}")
    if len(builds) == 2:
        act.say(
            "the same binary bytes on both machines"
            if builds["head"] == builds["peer"]
            else "THE BUILDS DIFFER: the two halves are not the same program"
        )

    # ---- 2. one node, one request at a time -----------------------------------------------------
    act = Act(2, "one node, the same load")
    acts.append(act)
    act.head()
    alone_elapsed, alone, alone_fail = run_batch(chat, args.token, n, conc)
    alone_rate = len(alone) / alone_elapsed if alone_elapsed > 0 else 0.0
    for failure in alone_fail:
        act.say(f"FAILED {failure}")
    if alone:
        tokens = sum(a["tokens"] for a in alone)
        act.say(f"{len(alone)}/{n} requests in {alone_elapsed:.1f}s -> {alone_rate:.2f} req/s ({tokens} tokens verified)")
    if len(alone) != n:
        broke = True

    # ---- 3. the same work, one endpoint, both machines ------------------------------------------
    act = Act(3, "the same work, sent to ONE endpoint, spread across both machines")
    acts.append(act)
    act.head()
    spread_elapsed, spread, spread_fail = run_batch(dispatch, args.token, n, conc)
    spread_rate = len(spread) / spread_elapsed if spread_elapsed > 0 else 0.0
    for failure in spread_fail:
        act.say(f"FAILED {failure}")
    if spread:
        tokens = sum(a["tokens"] for a in spread)
        speedup = f"  speedup {spread_rate / alone_rate:.2f}x" if alone_rate > 0 else ""
        act.say(f"{len(spread)}/{n} requests in {spread_elapsed:.1f}s -> {spread_rate:.2f} req/s{speedup}")
        counts: dict[str, int] = {}
        for answer in spread:
            who = answer["by"] or "(no header)"
            counts[who] = counts.get(who, 0) + 1
        act.say(f"{tokens} tokens verified, answered by:")
        for who in sorted(counts):
            act.say(f"{counts[who]:4} {who}")
        if len(counts) < 2:
            act.say("ONE NODE ANSWERED EVERYTHING: this is not dispatch, it is one machine")
            broke = True
    if len(spread) != n:
        broke = True

    # ---- 4. discovery ----------------------------------------------------------------------------
    act = Act(4, "a node finds a node it was never told about")
    acts.append(act)
    act.head()
    # Ask the listening socket, not the process table: `pgrep -f 'invincible seed'` matches the
    # ssh command line that is running this very check, so it always answers "a seed is running".
    code, out = ssh(
        args.head_host,
        args.ssh_key,
        "if ss -ltnH 'sport = :7789' | grep -q .; then echo 'seed already listening on 7789'; "
        "else setsid /root/.local/bin/invincible seed --listen 10.0.1.1:7789 </dev/null "
        ">>/root/seed.log 2>&1 & sleep 1.5; echo 'started seed on 10.0.1.1:7789'; fi; "
        "ss -ltnH 'sport = :7789' | head -1",
    )
    act.say(f"seed: {out.splitlines()[-1].strip() if out else 'not listening'}")
    code, out = ssh(args.peer_host, args.ssh_key, "/root/.local/bin/invincible announce 2>&1 | head -3")
    for line in out.splitlines()[-2:]:
        act.say(f"peer announces: {line.strip()[:150]}")
    if code != 0:
        act.say(f"announce failed: {out[:150]}")
        broke = True
    code, out = ssh(args.head_host, args.ssh_key, f"/root/.local/bin/invincible discover --seed {args.seed} 2>&1")
    for line in out.splitlines()[:6]:
        if line.strip():
            act.say(line.rstrip()[:170])
    rows = [ln for ln in out.splitlines() if ln.strip()]
    pinned = [ln for ln in rows if 'paired as node "' in ln and "a found node is" not in ln]
    if pinned:
        act.say("a found node is a paired node here: the descriptor matches a key pinned in nodes.json")
    elif "unpaired" in out:
        act.say("found but NOT paired: a descriptor proposes, a code pairs")
    else:
        act.say("no descriptor verified: discovery did not complete")
        broke = True

    # ---- 5. the receipt --------------------------------------------------------------------------
    act = Act(5, "a receipt you can check without trusting the node")
    acts.append(act)
    act.head()
    hosts = {"invincible-lab-head": args.head_host, "invincible-lab-peer": args.peer_host}
    subject = next((a for a in spread if a.get("id") and (a.get("by") in hosts)), None) if spread else None
    if subject is None:
        act.say("no dispatched answer carried a request id: nothing to check")
        broke = True
    else:
        node = subject["by"]
        act.say(f"request {subject['id']} answered by {node} with {subject['tokens']} tokens")

        def node_get(path: str) -> dict:
            """GET a path on the answering node: the head through the forward, the peer over ssh."""
            if node == "invincible-lab-head":
                status, obj = get(f"{args.head}{path}", args.token)
                return obj if status == 200 else {}
            code, out = ssh(
                args.peer_host,
                args.ssh_key,
                "t=$(/root/.local/bin/invincible token) && "
                f"curl -s -H \"Authorization: Bearer $t\" http://127.0.0.1:7777{path}",
            )
            try:
                return json.loads(out)
            except json.JSONDecodeError:
                return {}

        if args.verify_bin:
            # Fetch the envelope and the node's public key, then check the receipt here: the check
            # does not run on the machine that signed it, which is the whole point of a receipt.
            envelope = node_get(f"/v1/receipts/{subject['id']}")
            key = (node_get("/v1/node") or {}).get("receipt_key") or ""
            if key:
                act.say(f"the signing node publishes its key: {key[:20]}... (fetched, not assumed)")
            if not envelope:
                act.say("the node did not return the envelope for that id")
                broke = True
            elif not key:
                act.say("the node did not publish a receipt key: nothing to verify against")
                broke = True
            else:
                p = subprocess.run(
                    [args.verify_bin, "receipt", "verify", "-", "--key", key],
                    input=json.dumps(envelope),
                    capture_output=True,
                    text=True,
                    timeout=120,
                )
                for line in (p.stdout + p.stderr).splitlines():
                    act.say(line.rstrip()[:190])
                if p.returncode != 0 or "checked" not in p.stdout.lower():
                    act.say(f"OFFLINE VERIFY FAILED (exit {p.returncode})")
                    broke = True
        else:
            code, out = ssh(hosts[node], args.ssh_key, f"/root/.local/bin/invincible receipt verify {subject['id']} 2>&1")
            for line in out.splitlines():
                act.say(line.rstrip()[:190])
            if code != 0 or "checked" not in out.lower():
                act.say(f"the node could not verify its own receipt (exit {code})")
                broke = True

    # ---- 6. break it ------------------------------------------------------------------------------
    act = Act(6, "now break it: kill the peer mid-flight")
    acts.append(act)
    act.head()
    ssh(args.peer_host, args.ssh_key, "pkill -x invincible 2>/dev/null; sleep 2; pgrep -x invincible || echo down")
    code, out = ssh(args.peer_host, args.ssh_key, "pgrep -x invincible >/dev/null && echo up || echo down")
    down = out.strip().endswith("down")
    act.say(f"peer: {'down' if down else 'STILL UP'}")
    if down:
        dead_elapsed, dead, dead_fail = run_batch(dispatch, args.token, n, conc)
        dead_rate = len(dead) / dead_elapsed if dead_elapsed > 0 else 0.0
        dead_count = len(dead)
        for failure in dead_fail:
            act.say(f"FAILED {failure}")
        alive_rate = alone_rate if alone else 0.0
        note = f" ({dead_rate / alive_rate * 100:.0f}% of one machine's rate)" if alive_rate > 0 else ""
        act.say(f"peer down, {len(dead)}/{n} requests still answered in {dead_elapsed:.1f}s ({dead_rate:.2f} req/s{note})")
        if len(dead) != n:
            act.say("A REQUEST WAS LOST WHEN THE NODE DIED: dispatch did not fall back")
            broke = True
        else:
            act.say("every request was answered by the node that was still up")
    else:
        broke = True
    ssh(args.peer_host, args.ssh_key, "/root/node-up.sh >/dev/null 2>&1; sleep 2")
    back = False
    for _ in range(12):
        code, out = ssh(args.peer_host, args.ssh_key, "/root/.local/bin/invincible cluster status >/dev/null 2>&1 && echo up")
        if out.strip().endswith("up"):
            back = True
            break
        time.sleep(3)
    act.say(f"peer back: {'yes' if back else 'no'}")
    if not back:
        broke = True

    # ---- summary ----------------------------------------------------------------------------------
    print("\n-- summary")
    ran = 0
    for act in acts:
        if act.measured:
            ran += 1
    if alone:
        print(f"   one node            {alone_rate:.2f} req/s")
    if spread and alone:
        print(f"   one endpoint, two   {spread_rate:.2f} req/s   ({spread_rate / alone_rate:.2f}x)")
    if dead_rate is not None:
        print(f"   one node, peer dead {dead_rate:.2f} req/s   ({dead_count}/{n} answered)")
    print(f"   {ran}/{len(acts)} acts ran, {n} requests per act, every figure measured in this run")
    if broke:
        print("   NOT A DEMO: an act above broke its invariant")
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
