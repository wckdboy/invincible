#!/usr/bin/env bash
# Hydrate the project prefix, run the preset workload, and drain on the deadline
# or when the node writes sessions/<id>/control.json with action=drain.
set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=lib.sh
source "${SCRIPT_DIR}/lib.sh"

invincible_rclone_env

WORKSPACE="${INVINCIBLE_WORKSPACE:-/workspace}"
mkdir -p "${WORKSPACE}"

hydrate_one() {
  local src="$1"
  local dest="$2"
  mkdir -p "${dest}"
  invincible_log "hydrate s3:${INVINCIBLE_BUCKET}/${src} -> ${dest}"
  rclone sync "invincible:${INVINCIBLE_BUCKET}/${src}" "${dest}"
}

HYDRATE_MAP="${INVINCIBLE_HYDRATE_MAP:-projects/${INVINCIBLE_PROJECT_ID}/workspace|${WORKSPACE}}"
invincible_each_pair "${HYDRATE_MAP}" hydrate_one

printf '{"session_id":"%s","at":"%s"}\n' "${INVINCIBLE_SESSION_ID}" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  | rclone rcat "invincible:${INVINCIBLE_BUCKET}/sessions/${INVINCIBLE_SESSION_ID}/hydrate-ok.json"

workload_pid=""
if [[ -n "${INVINCIBLE_WORKLOAD:-}" ]]; then
  invincible_log "starting workload: ${INVINCIBLE_WORKLOAD}"
  invincible_exec_workload "${INVINCIBLE_WORKLOAD}"
else
  invincible_log "no INVINCIBLE_WORKLOAD; holding the session until drain"
  invincible_hold &
  workload_pid=$!
fi

deadline_epoch=""
if [[ -n "${INVINCIBLE_DEADLINE_AT:-}" ]]; then
  if ! deadline_epoch=$(python3 -c 'import datetime,os; print(int(datetime.datetime.fromisoformat(os.environ["INVINCIBLE_DEADLINE_AT"].replace("Z","+00:00")).timestamp()))' 2>/dev/null); then
    invincible_log "could not parse INVINCIBLE_DEADLINE_AT=${INVINCIBLE_DEADLINE_AT}"
    deadline_epoch=""
  fi
fi

control_url="invincible:${INVINCIBLE_BUCKET}/sessions/${INVINCIBLE_SESSION_ID}/control.json"

should_drain() {
  if [[ -n "${deadline_epoch}" ]]; then
    local now
    now=$(date -u +%s)
    if (( now >= deadline_epoch )); then
      return 0
    fi
  fi
  local body
  if body=$(rclone cat "${control_url}" 2>/dev/null); then
    if grep -q '"action"[[:space:]]*:[[:space:]]*"drain"' <<<"${body}"; then
      return 0
    fi
  fi
  return 1
}

draining=0
drain_and_exit() {
  if [[ "${draining}" == "1" ]]; then
    return
  fi
  draining=1
  invincible_log "draining session ${INVINCIBLE_SESSION_ID}"
  if [[ -n "${workload_pid}" ]]; then
    # The hold is a background shell with `sleep` under it. Killing only the
    # shell leaves that sleep running (it is not in the shell's process group
    # when job control is off).
    if command -v pkill >/dev/null 2>&1; then
      pkill -TERM -P "${workload_pid}" 2>/dev/null || true
    fi
    kill -TERM "${workload_pid}" 2>/dev/null || true
    local grace="${INVINCIBLE_DRAIN_GRACE_SEC:-20}"
    local i
    for ((i = 0; i < grace; i++)); do
      if ! kill -0 "${workload_pid}" 2>/dev/null; then
        break
      fi
      sleep 1
    done
    if command -v pkill >/dev/null 2>&1; then
      pkill -KILL -P "${workload_pid}" 2>/dev/null || true
    fi
    kill -KILL "${workload_pid}" 2>/dev/null || true
    wait "${workload_pid}" 2>/dev/null || true
  fi
  bash "${SCRIPT_DIR}/drain.sh"
  exit $?
}

trap drain_and_exit TERM INT

invincible_log "session ${INVINCIBLE_SESSION_ID} running until ${INVINCIBLE_DEADLINE_AT:-manual stop}"
while kill -0 "${workload_pid}" 2>/dev/null; do
  if should_drain; then
    drain_and_exit
  fi
  sleep "${INVINCIBLE_POLL_SEC:-10}"
done
if [[ "${draining}" != "1" ]]; then
  invincible_log "workload exited; draining and stopping"
  drain_and_exit
fi
