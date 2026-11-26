#!/bin/bash
# The app's launch, measured plainly: launched by the simulator itself, with nothing of XCUITest's (or a device panel's)
# in its process, its probe on (-InvincibleMeasure YES, App/PerfProbe.swift), each launch's marks read from its log. On a
# simulator of its own where the app is installed and paired (the UI tests leave it so): never one a device panel opened.
#
#   apps/apple/scripts/launch-plain.sh <simulator udid> [launches, default 8]
#
# Prints each launch's marks, counted from the app's first line, and the app's own part (first line to a usable Home),
# with its median. Before the first line is the platform's (the process and its loader).
set -euo pipefail
udid="$1"
n="${2:-8}"
log="$(mktemp -t invincible-launch)"
xcrun simctl spawn "$udid" log stream --level info --style compact --predicate 'subsystem == "sh.invincible.bot" AND category == "perf"' > "$log" 2>&1 &
logger=$!
trap 'kill "$logger" 2>/dev/null || true; rm -f "$log"' EXIT
sleep 3
for _ in $(seq 1 "$n"); do
  xcrun simctl terminate "$udid" sh.invincible.bot > /dev/null 2>&1 || true
  sleep 2
  xcrun simctl launch "$udid" sh.invincible.bot -InvincibleMeasure YES > /dev/null
  sleep 7
done
xcrun simctl terminate "$udid" sh.invincible.bot > /dev/null 2>&1 || true
sleep 1
python3 -I - "$log" <<'PY'
import re, statistics, sys
launches = []
for line in open(sys.argv[1]):
    m = re.search(r"Invincible\[(\d+):[0-9a-f]+\] \[sh\.invincible\.bot:perf\] (launch mark (.+?): (\d+) ms|launch to usable: (\d+) ms)", line)
    if not m:
        continue
    if not launches or launches[-1]["pid"] != m.group(1):
        launches.append({"pid": m.group(1), "marks": []})
    if m.group(3):
        launches[-1]["marks"].append((m.group(3), int(m.group(4))))
    else:
        launches[-1]["usable"] = int(m.group(5))
own = []
for launch in launches:
    if not launch["marks"] or "usable" not in launch:
        continue
    start = launch["marks"][0][1]
    own.append(launch["usable"] - start)
    print(f"platform {start:5d} ms · own {launch['usable'] - start:4d} ms | " + " ".join(f"{name} +{ms - start}" for name, ms in launch["marks"][1:]))
if own:
    print(f"the app's own part, launched plainly: {sorted(own)} ms, median {statistics.median(own):.0f} ms")
else:
    print("no launch was measured: is the app installed and paired on that simulator?")
PY
