#!/bin/sh
# The benchmarks: a release build, its binary sizes, then the timing and memory tests in
# crates/autobot/tests/perf.rs (ignored in a plain `cargo test`). Prints one line per number,
# `name value unit`, and a Markdown table to $GITHUB_STEP_SUMMARY when CI sets it.
#
#   sh bench/run.sh            # everything
#   sh bench/run.sh gateway    # only the tests whose names contain "gateway"
#
# Everything runs against stand-ins on loopback with homes under the system's temp dir: nothing
# here touches a node that is running on this machine. BENCH_BIN_DIR points the process tests at
# other builds of `autobot` and `invincible` (an older release, to compare).
set -eu
cd "$(dirname "$0")/.."

filter="${1:-}"
cargo build --release --locked --quiet
out=$(mktemp)
trap 'rm -f "$out"' EXIT
dir="${BENCH_BIN_DIR:-target/release}"
for bin in invincible autobot; do
  bytes=$(wc -c < "$dir/$bin" | tr -d ' ')
  awk -v b="$bytes" -v n="$bin" 'BEGIN { printf "BENCH size.%s %.3f MiB\n", n, b / 1048576 }' >> "$out"
done
cargo test --release --locked --quiet -p autobot --test perf -- --ignored --nocapture --test-threads 1 $filter \
  | grep '^BENCH' >> "$out"

sed 's/^BENCH //' "$out"
if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then
  {
    echo "| benchmark | value | unit |"
    echo "| --- | ---: | --- |"
    sed 's/^BENCH \([^ ]*\) \([^ ]*\) \(.*\)$/| \1 | \2 | \3 |/' "$out"
  } >> "$GITHUB_STEP_SUMMARY"
fi
