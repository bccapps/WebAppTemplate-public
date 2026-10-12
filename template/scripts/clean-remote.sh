#!/usr/bin/env bash

# =============================================================================
# VXFramework
#
# Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
# SPDX-License-Identifier: MIT
#
# Licensed under the MIT License. See LICENSE in the project root.
# =============================================================================

set -euo pipefail

# Stop and remove remote containers for this project (all hosts)
# Relies on .env values used by deploy-remote.sh
#
# Usage: ./scripts/clean-remote.sh

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
cd "${PROJECT_ROOT}"

require_cmd() {
  command -v "$1" >/dev/null 2>&1 || {
    echo "Error: command '$1' not found." >&2
    exit 1
  }
}

require_cmd ssh
require_cmd docker

if [[ ! -f ./back/.env ]]; then
  echo "Error: back/.env not found." >&2
  exit 1
fi

set -a
source ./back/.env
set +a

REMOTE_USER="${REMOTE_USER:?REMOTE_USER is required}"
REMOTE_SSH_PORT="${REMOTE_SSH_PORT:?REMOTE_SSH_PORT is required}"
SSH_KEY_FILE="${SSH_KEY_FILE:?SSH_KEY_FILE is required}"
PROJECT_NAME="${PROJECT_NAME:?PROJECT_NAME is required}"

trim_string() {
  printf '%s' "$(echo "$1" | awk '{$1=$1};1')"
}

parse_hosts() {
  local raw="$1"
  local IFS=','
  read -ra parts <<<"${raw}"
  for entry in "${parts[@]}"; do
    local trimmed
    trimmed="$(trim_string "${entry}")"
    if [[ -n "${trimmed}" ]]; then
      printf '%s\n' "${trimmed}"
    fi
  done
}

parse_host_entry() {
  local entry="$1"
  local default_user="$2"
  local user="${default_user}"
  local host="${entry}"
  if [[ "${entry}" == *"@"* ]]; then
    user="${entry%@*}"
    host="${entry#*@}"
  fi
  printf '%s %s' "${user}" "${host}"
}

resolve_key_path() {
  local key_file="$1"
  if [[ -z "${key_file}" ]]; then printf ''; return; fi
  if [[ -f "${key_file}" ]]; then printf '%s' "${key_file}"; return; fi
  if [[ -f "${HOME}/.ssh/${key_file}" ]]; then printf '%s' "${HOME}/.ssh/${key_file}"; return; fi
  echo "Error: SSH key not found (${key_file})." >&2
  exit 1
}

TARGET_KEYS=()
TARGET_USERS=()
TARGET_HOSTS=()
TARGET_LABELS=()

collect_targets() {
  local raw="$1" default_user="$2" label="$3"
  while IFS= read -r entry; do
    [[ -z "${entry}" ]] && continue
    read -r entry_user entry_host <<<"$(parse_host_entry "${entry}" "${default_user}")"
    local key="${entry_user}@${entry_host}"
    local already=0
    for existing_key in "${TARGET_KEYS[@]+"${TARGET_KEYS[@]}"}"; do
      [[ "${existing_key}" == "${key}" ]] && { already=1; break; }
    done
    if [[ "${already}" -eq 0 ]]; then
      TARGET_KEYS+=("${key}")
      TARGET_USERS+=("${entry_user}")
      TARGET_HOSTS+=("${entry_host}")
      TARGET_LABELS+=("${label}")
    fi
  done < <(parse_hosts "${raw}")
}

FRONT_HOSTS_RAW="${FRONT_HOSTS:-${REMOTE_HOST:-}}"
BACK_HOSTS_RAW="${BACK_HOSTS:-${REMOTE_HOST:-}}"

[[ -n "${FRONT_HOSTS_RAW}" ]] && collect_targets "${FRONT_HOSTS_RAW}" "${REMOTE_USER}" "front"
[[ -n "${BACK_HOSTS_RAW}" ]] && collect_targets "${BACK_HOSTS_RAW}" "${REMOTE_USER}" "back"

if [[ ${#TARGET_KEYS[@]} -eq 0 ]]; then
  echo "Error: FRONT_HOSTS/BACK_HOSTS or REMOTE_HOST must define at least one host." >&2
  exit 1
fi

KEY_PATH="$(resolve_key_path "${SSH_KEY_FILE}")"

TARGET_CONTAINERS=(
  "${PROJECT_NAME}_front"
  "${PROJECT_NAME}_back"
  "${PROJECT_NAME}_postgres"
)

for idx in "${!TARGET_KEYS[@]}"; do
  target_user="${TARGET_USERS[$idx]}"
  target_host="${TARGET_HOSTS[$idx]}"
  label="${TARGET_LABELS[$idx]}"
  ssh_target="${target_user}@${target_host}"
  ssh_opts=("-p" "${REMOTE_SSH_PORT}" "-o" "BatchMode=yes" "-o" "ConnectTimeout=10")
  [[ -n "${KEY_PATH}" ]] && ssh_opts+=("-i" "${KEY_PATH}")

  label_upper=$(printf '%s' "${label}" | tr '[:lower:]' '[:upper:]')
  echo "==> [${label_upper}:${target_host}] Testing SSH connectivity"
  ssh "${ssh_opts[@]}" "${ssh_target}" "echo SSH_OK" >/dev/null

  remote_stop="docker stop ${TARGET_CONTAINERS[*]} >/dev/null 2>&1 || true"
  remote_rm="docker rm -f ${TARGET_CONTAINERS[*]} >/dev/null 2>&1 || true"
  echo "==> [${label_upper}:${target_host}] Stopping & removing containers"
  ssh "${ssh_opts[@]}" "${ssh_target}" "${remote_stop}; ${remote_rm}"
  echo "==> [${label_upper}:${target_host}] Removed containers: ${TARGET_CONTAINERS[*]}"
done
