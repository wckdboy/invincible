#!/bin/bash
# The one lock for every on-screen Apple run on this Mac: the iPhone's UI and performance tests in a simulator, the Mac
# app's tests and pictures, whether a forge runner's CI job runs them or an agent does. They take it in turn, so none
# measures beside another's screen (27 November 2026: CI's testScrollHome took 17.5 ms a second, against about 7, while
# an agent's MacShots run had the Mac app on screen beside it, and the CPU's load of 5.0 hid it). Builds don't take it.
#
#   apps/apple/scripts/ui-lock.sh [-t <seconds>] <command> [arguments…]
#
# The command runs holding `lockf -k "$HOME/work/.apple-ui.lock"`, which the OS lets go when its holder ends, even if it
# crashes. On the mini, the runners' jobs and agents' ssh sessions run as one user, with one home, so they share it.
# Free, the command runs at once and nothing is said. Held, it waits up to -t seconds (30 minutes unless said), and says
# in one line how long it waited, once it holds the lock. Its exit is the command's, or 75 (EX_TEMPFAIL) when the lock
# wasn't free in time, and then the command never ran.
set -u
wait=1800
if [ "${1:-}" = "-t" ]; then
  wait="${2:-}"
  shift 2 2>/dev/null || shift $#
fi
case "$wait" in '' | *[!0-9]*) echo "ui-lock.sh: -t takes a whole number of seconds" >&2; exit 64 ;; esac
if [ $# -eq 0 ]; then
  echo "usage: ui-lock.sh [-t <seconds>] <command> [arguments…]" >&2
  exit 64
fi
lock="$HOME/work/.apple-ui.lock"
mkdir -p "$HOME/work" || exit 73
# The command's side leaves a mark here once it holds the lock: whether it ran, whatever its own exit (even 75).
marks="$(mktemp -d "${TMPDIR:-/tmp}/ui-lock.XXXXXX")" || exit 71
trap 'rm -rf "$marks"' EXIT

# shellcheck disable=SC2016 # (the inner shell's own $0 and $@)
lockf -k -s -t 0 "$lock" /bin/sh -c 'touch "$0/held" || exit 71; exec "$@"' "$marks" "$@"
status=$?
if [ -e "$marks/held" ]; then exit "$status"; fi
if [ "$status" -ne 75 ]; then
  echo "ui-lock: couldn't take $lock (lockf's exit $status)" >&2
  exit "$status"
fi

# Another on-screen run holds it: wait for it, and say so once it's ours.
since=$(date +%s)
# shellcheck disable=SC2016 # (the inner shell's own $0, $1, $2 and $@)
lockf -k -s -t "$wait" "$lock" /bin/sh -c '
  touch "$0/held" || exit 71
  echo "ui-lock: waited $(( $(date +%s) - $1 )) s for $2: another on-screen Apple run held it" >&2
  shift 2
  exec "$@"' "$marks" "$since" "$lock" "$@"
status=$?
if [ -e "$marks/held" ]; then exit "$status"; fi
if [ "$status" -eq 75 ]; then
  echo "ui-lock: gave up after $wait s: another on-screen Apple run still holds $lock" >&2
else
  echo "ui-lock: couldn't take $lock (lockf's exit $status)" >&2
fi
exit "$status"
