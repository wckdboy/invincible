#!/usr/bin/env bash
# Push workspace paths back to the project prefix and write drain-ok.json.
set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=lib.sh
source "${SCRIPT_DIR}/lib.sh"

invincible_rclone_env

declare -a RCLONE_EXCLUDES=()
if [[ -n "${INVINCIBLE_DRAIN_EXCLUDES:-}" ]]; then
  IFS=',' read -r -a _excludes <<<"${INVINCIBLE_DRAIN_EXCLUDES}"
  for ex in "${_excludes[@]}"; do
    if [[ -n "${ex}" ]]; then
      RCLONE_EXCLUDES+=(--exclude "${ex}")
    fi
  done
fi

drain_one() {
  local src="$1"
  local dest="$2"
  if [[ ! -d "${src}" ]]; then
    invincible_log "drain source ${src} is missing; syncing an empty prefix"
    mkdir -p "${src}"
  fi
  invincible_log "drain ${src} -> s3:${INVINCIBLE_BUCKET}/${dest}"
  rclone sync "${src}" "invincible:${INVINCIBLE_BUCKET}/${dest}" --checksum "${RCLONE_EXCLUDES[@]}"
  rclone lsf -R "${src}" \
    | rclone rcat "invincible:${INVINCIBLE_BUCKET}/sessions/${INVINCIBLE_SESSION_ID}/drain-files.txt" || true
}

DRAIN_MAP="${INVINCIBLE_DRAIN_MAP:-/workspace|projects/${INVINCIBLE_PROJECT_ID}/workspace}"
invincible_each_pair "${DRAIN_MAP}" drain_one

printf '{"session_id":"%s","at":"%s","ok":true}\n' "${INVINCIBLE_SESSION_ID}" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  | rclone rcat "invincible:${INVINCIBLE_BUCKET}/sessions/${INVINCIBLE_SESSION_ID}/drain-ok.json"

invincible_log "drain-ok written for ${INVINCIBLE_SESSION_ID}"
