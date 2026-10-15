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

# Duplicate the local dev DB into the remote DB (overwriting remote public schema).
# Requirements:
# - back/.env with DB_* and remote SSH settings
# - Local Postgres container running (${PROJECT_NAME}_postgres by default)
# - Remote Docker context already configured (REMOTE_CONTEXT_NAME), or accessible via SSH
#
# Usage: ./scripts/populate-db.sh

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
cd "${PROJECT_ROOT}"

require_cmd() {
  command -v "$1" >/dev/null 2>&1 || {
    echo "Error: command '$1' not found." >&2
    exit 1
  }
}

require_cmd docker
require_cmd ssh
require_cmd scp
require_cmd mktemp

if [[ ! -f "./back/.env" ]]; then
  echo "Error: back/.env not found."
  exit 1
fi

# Load env (local + remote settings)
set -a
source ./back/.env
set +a

source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib/db-engine.sh"
resolve_db_engine
require_postgres_engine "populate-db.sh"

REMOTE_USER="${REMOTE_USER:?REMOTE_USER is required}"
REMOTE_SSH_PORT="${REMOTE_SSH_PORT:?REMOTE_SSH_PORT is required}"
SSH_KEY_FILE="${SSH_KEY_FILE:?SSH_KEY_FILE is required}"
REMOTE_CONTEXT_BASE="${REMOTE_CONTEXT_NAME:?REMOTE_CONTEXT_NAME is required}"
PROJECT_NAME="${PROJECT_NAME:?PROJECT_NAME is required}"
DB_USER="${DB_USER:?DB_USER is required}"
DB_NAME="${DB_NAME:?DB_NAME is required}"

LOCAL_PG_CONTAINER="${LOCAL_PG_CONTAINER:-${PROJECT_NAME}_postgres}"
REMOTE_PG_CONTAINER="${REMOTE_PG_CONTAINER:-${PROJECT_NAME}_postgres}"

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

sanitize_identifier() {
  echo "$1" | tr '[:upper:]' '[:lower:]' | sed 's/[^a-z0-9]/-/g'
}

build_context_name() {
  local base="$1"
  local host="$2"
  local suffix
  suffix="$(sanitize_identifier "${host}")"
  printf '%s-%s' "${base}" "${suffix}"
}

resolve_key_path() {
  local key_file="$1"
  if [[ -z "${key_file}" ]]; then
    printf ''
    return
  fi
  if [[ -f "${key_file}" ]]; then
    printf '%s' "${key_file}"
    return
  fi
  if [[ -f "${HOME}/.ssh/${key_file}" ]]; then
    printf '%s' "${HOME}/.ssh/${key_file}"
    return
  fi
  echo "Error: SSH key not found (${key_file})." >&2
  exit 1
}

ensure_docker_context() {
  local context_name="$1"
  local ssh_target="$2"
  local port="$3"
  local desired_host="ssh://${ssh_target}:${port}"
  if ! docker context inspect "${context_name}" >/dev/null 2>&1; then
    docker context create "${context_name}" --docker "host=${desired_host}" >/dev/null
  else
    docker context update "${context_name}" --docker "host=${desired_host}" >/dev/null
  fi
}

BACK_HOSTS_RAW="${BACK_HOSTS:-${REMOTE_HOST:-}}"
if [[ -z "${BACK_HOSTS_RAW}" ]]; then
  echo "Error: BACK_HOSTS (or REMOTE_HOST) must define at least one host." >&2
  exit 1
fi
BACK_HOSTS_LIST=()
while IFS= read -r entry; do
  [[ -z "${entry}" ]] && continue
  BACK_HOSTS_LIST+=("${entry}")
done < <(parse_hosts "${BACK_HOSTS_RAW}")
if [[ ${#BACK_HOSTS_LIST[@]} -eq 0 ]]; then
  echo "Error: BACK_HOSTS resolved to zero hosts after parsing." >&2
  exit 1
fi

KEY_PATH="$(resolve_key_path "${SSH_KEY_FILE}")"

DUMP_FILE="$(mktemp "${TMPDIR:-/tmp}/${PROJECT_NAME}-dump.XXXXXX.sql")"
cleanup() {
  rm -f "${DUMP_FILE}"
}
trap cleanup EXIT

echo "==> Dumping local DB from container ${LOCAL_PG_CONTAINER}"
DOCKER_ENV_ARGS=()
if [[ -n "${DB_PASSWORD:-}" ]]; then
  DOCKER_ENV_ARGS+=( -e "PGPASSWORD=${DB_PASSWORD}" )
fi
if docker ps -q -f "name=^/${LOCAL_PG_CONTAINER}$" >/dev/null 2>&1 && [[ -n "$(docker ps -q -f "name=^/${LOCAL_PG_CONTAINER}$")" ]]; then
  docker exec "${DOCKER_ENV_ARGS[@]}" "${LOCAL_PG_CONTAINER}" pg_dump -U "${DB_USER}" --no-owner --no-privileges "${DB_NAME}" > "${DUMP_FILE}"
else
  echo "Error: local Postgres container ${LOCAL_PG_CONTAINER} is not running. Start it first." >&2
  exit 1
fi

for entry in "${BACK_HOSTS_LIST[@]}"; do
  read -r target_user target_host <<<"$(parse_host_entry "${entry}" "${REMOTE_USER}")"
  ssh_target="${target_user}@${target_host}"
  ssh_opts=( -p "${REMOTE_SSH_PORT}" -o BatchMode=yes -o ConnectTimeout=10 )
  scp_opts=( -P "${REMOTE_SSH_PORT}" )
  docker_ssh_command="ssh -p ${REMOTE_SSH_PORT}"
  if [[ -n "${KEY_PATH}" ]]; then
    ssh_opts+=( -i "${KEY_PATH}" )
    scp_opts+=( -i "${KEY_PATH}" )
    docker_ssh_command="ssh -i ${KEY_PATH} -p ${REMOTE_SSH_PORT}"
  fi

  echo "==> [BACK:${target_host}] Testing SSH connectivity"
  ssh "${ssh_opts[@]}" "${ssh_target}" "echo SSH_OK" >/dev/null

  context_name="$(build_context_name "${REMOTE_CONTEXT_BASE}" "${target_host}")"
  ensure_docker_context "${context_name}" "${ssh_target}" "${REMOTE_SSH_PORT}"

  host_slug="$(sanitize_identifier "${target_host}")"
  remote_tmp="/tmp/${PROJECT_NAME}-import-${host_slug}.sql"
  echo "==> [BACK:${target_host}] Uploading dump (${remote_tmp})"
  scp "${scp_opts[@]}" "${DUMP_FILE}" "${ssh_target}:${remote_tmp}"

  echo "==> [BACK:${target_host}] Importing dump into container ${REMOTE_PG_CONTAINER}"
  REMOTE_PG_ID=$(DOCKER_SSH_COMMAND="${docker_ssh_command}" docker --context "${context_name}" ps -q -f "name=^/${REMOTE_PG_CONTAINER}$" || true)
  if [[ -z "${REMOTE_PG_ID}" ]]; then
    echo "Error: remote Postgres container ${REMOTE_PG_CONTAINER} is not running on ${target_host}." >&2
    exit 1
  fi

  DOCKER_SSH_COMMAND="${docker_ssh_command}" docker --context "${context_name}" exec -i "${REMOTE_PG_CONTAINER}" \
    sh -c "PGPASSWORD='${DB_PASSWORD}' psql -U '${DB_USER}' -d '${DB_NAME}' -v ON_ERROR_STOP=1 -c \"DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public;\""

  DOCKER_SSH_COMMAND="${docker_ssh_command}" docker --context "${context_name}" exec -i "${REMOTE_PG_CONTAINER}" \
    sh -c "PGPASSWORD='${DB_PASSWORD}' psql -U '${DB_USER}' -d '${DB_NAME}' -v ON_ERROR_STOP=1" < "${DUMP_FILE}"

  echo "==> [BACK:${target_host}] Remote database populated successfully"
done
