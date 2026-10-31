#!/usr/bin/env bash
# Shared rclone setup for the Invincible rent sidecar.
# Copyright (c) 2026 wckdboy. Ported from wckd-gpu (MIT).

invincible_log() {
  printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*" >&2
}

invincible_require() {
  local name="$1"
  if [[ -z "${!name:-}" ]]; then
    invincible_log "missing env ${name}"
    exit 1
  fi
}

invincible_rclone_env() {
  invincible_require INVINCIBLE_SESSION_ID
  invincible_require INVINCIBLE_PROJECT_ID
  invincible_require INVINCIBLE_BUCKET
  invincible_require INVINCIBLE_ENDPOINT
  invincible_require INVINCIBLE_ACCESS_KEY_ID
  invincible_require INVINCIBLE_SECRET_ACCESS_KEY

  export RCLONE_CONFIG_INVINCIBLE_TYPE=s3
  export RCLONE_CONFIG_INVINCIBLE_PROVIDER=Other
  export RCLONE_CONFIG_INVINCIBLE_ACCESS_KEY_ID="${INVINCIBLE_ACCESS_KEY_ID}"
  export RCLONE_CONFIG_INVINCIBLE_SECRET_ACCESS_KEY="${INVINCIBLE_SECRET_ACCESS_KEY}"
  export RCLONE_CONFIG_INVINCIBLE_ENDPOINT="${INVINCIBLE_ENDPOINT}"
  export RCLONE_CONFIG_INVINCIBLE_REGION="${INVINCIBLE_REGION:-auto}"
  export RCLONE_CONFIG_INVINCIBLE_NO_CHECK_BUCKET=true
  export RCLONE_CONFIG_INVINCIBLE_FORCE_PATH_STYLE=true

  if ! command -v rclone >/dev/null 2>&1; then
    invincible_log "rclone is not installed"
    exit 1
  fi
}

# Hold the session open. GNU sleep accepts `infinity`; the macOS sleep does not,
# and CI runs these scripts on the host as well as in the Debian image.
invincible_hold() {
  while true; do
    sleep 3600
  done
}

# Run the preset command without the object-store credentials. The parent keeps
# them for rclone. The child must not.
invincible_exec_workload() {
  local command="$1"
  (
    unset INVINCIBLE_ACCESS_KEY_ID INVINCIBLE_SECRET_ACCESS_KEY
    unset AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY AWS_SESSION_TOKEN AWS_SECURITY_TOKEN AWS_DEFAULT_REGION
    local name
    while IFS='=' read -r name _; do
      case "${name}" in
        RCLONE_CONFIG*) unset "${name}" ;;
      esac
    done < <(env)
    exec bash -lc "${command}"
  ) &
  workload_pid=$!
}

# Split "a|b;;c|d" and call the given function with left and right.
invincible_each_pair() {
  local spec="$1"
  local fn="$2"
  spec="${spec};;"
  while [[ "${spec}" == *";;"* ]]; do
    local pair="${spec%%;;*}"
    spec="${spec#*;;}"
    if [[ -z "${pair}" ]]; then
      continue
    fi
    local left="${pair%%|*}"
    local right="${pair#*|}"
    if [[ -z "${left}" || -z "${right}" || "${left}" == "${right}" ]]; then
      invincible_log "skipping malformed sync pair ${pair}"
      continue
    fi
    "${fn}" "${left}" "${right}"
  done
}
