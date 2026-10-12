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

# ============================================================
# migrate-db.sh — Run TypeORM migrations on remote host(s)
# ============================================================
# Builds the back-end image (resolving symlinks like deploy-remote.sh),
# then runs TypeORM migrations inside a temporary container on
# each configured back host.
#
# Usage:
#   ./scripts/migrate-db.sh              Run migrations on all back hosts
#   ./scripts/migrate-db.sh --help       Show this help
#
# The script will:
#   1. Prepare a local build context (resolve symlinks, copy .env)
#   2. For each BACK_HOST:
#      a. Stop running services (back, postgres…)
#      b. Build the back image on the remote host
#      c. Run TypeORM migrations (schema:sync if empty, then migration:run)
#      d. Restart previously stopped services
#
# Env file: defaults to back/.env (production). Pass BACK_ENV_FILE to target
# another environment, e.g. BACK_ENV_FILE=./back/.env.preprod ./scripts/migrate-db.sh
#
# Required env vars (in that file):
#   PROJECT_NAME, REMOTE_USER, REMOTE_SSH_PORT, SSH_KEY_FILE,
#   REMOTE_CONTEXT_NAME,
#   BACK_HOSTS (comma-separated) or REMOTE_HOST (single host)
#
# Optional env vars:
#   DATABASE_ENGINE   - "postgres"/"selfhosted" (default, self-hosted DB) or cloud DB name
#   COMPOSE_FILE_NAME - override compose file (default: scripts/docker-compose.yml
#                       for self-hosted, scripts/docker-compose-cloud.yml for cloud)
#   BACK_BUILD_DIR    - temporary build dir (default: ./back_build)
# ============================================================

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
cd "${PROJECT_ROOT}"

if [[ "${1:-}" == "--help" || "${1:-}" == "-h" || "${1:-}" == "help" ]]; then
  sed -n '3,/^[^#]/p' "$0" | grep '^#' | sed 's/^# \?//'
  exit 0
fi

require_cmd() {
  command -v "$1" >/dev/null 2>&1 || {
    echo "Error: command '$1' not found."
    exit 1
  }
}

require_cmd docker
require_cmd rsync
require_cmd python3
require_cmd ssh

BACK_ENV_FILE="${BACK_ENV_FILE:-./back/.env}"
if [[ ! -f "${BACK_ENV_FILE}" ]]; then
  echo "Error: ${BACK_ENV_FILE} not found."
  exit 1
fi

# Load env for remote settings (remote host, ssh, context). Defaults to
# back/.env; pass BACK_ENV_FILE=./back/.env.preprod (etc.) to target a
# different environment than production — see run.sh's cmd_preprod/cmd_prod.
source "${BACK_ENV_FILE}"

# ---------------------------------------------------------------------------
# DATABASE_ENGINE: determines compose file and self-hosted DB behaviour
# ---------------------------------------------------------------------------
DATABASE_ENGINE_VALUE="${DATABASE_ENGINE:-postgres}"
DATABASE_ENGINE_NORMALIZED="$(echo "${DATABASE_ENGINE_VALUE}" | tr '[:upper:]' '[:lower:]')"
DEFAULT_COMPOSE_FILE="scripts/docker-compose-cloud.yml"
IS_SELF_HOSTED_DB=0
if [[ "${DATABASE_ENGINE_NORMALIZED}" =~ ^(postgres|selfhosted)$ ]]; then
  DEFAULT_COMPOSE_FILE="scripts/docker-compose.yml"
  IS_SELF_HOSTED_DB=1
fi

COMPOSE_FILE_PATH="${COMPOSE_FILE_NAME:-${DEFAULT_COMPOSE_FILE}}"
COMPOSE_FILE_PATH="${COMPOSE_FILE_PATH#./}"
COMPOSE_FILE_ABS="./${COMPOSE_FILE_PATH}"
if [[ ! -f "${COMPOSE_FILE_ABS}" ]]; then
  echo "Error: compose file '${COMPOSE_FILE_ABS}' not found."
  exit 1
fi

# ---------------------------------------------------------------------------
# Utility functions
# ---------------------------------------------------------------------------

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

resolve_ssh_key_path() {
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

resolve_realpath() {
  python3 - "$1" <<'PY'
import os
import sys
path = sys.argv[1]
if not path:
    sys.exit(1)
print(os.path.realpath(path))
PY
}

stage_back_db_cert_if_present() {
  local dest_dir="$1"
  if [[ -z "${DB_SSLROOTCERT:-}" ]]; then
    return
  fi
  local source_cert="./back/${DB_SSLROOTCERT}"
  if [[ ! -f "${source_cert}" ]]; then
    return
  fi
  mkdir -p "${dest_dir}"
  echo "==> [LOCAL] Including back/${DB_SSLROOTCERT} in ${dest_dir}"
  rsync -a "${source_cert}" "${dest_dir}/${DB_SSLROOTCERT}"
}

# ---------------------------------------------------------------------------
# Required env vars
# ---------------------------------------------------------------------------
REMOTE_USER="${REMOTE_USER:?REMOTE_USER is required}"
REMOTE_SSH_PORT="${REMOTE_SSH_PORT:?REMOTE_SSH_PORT is required}"
SSH_KEY_FILE="${SSH_KEY_FILE:?SSH_KEY_FILE is required}"
REMOTE_CONTEXT_BASE="${REMOTE_CONTEXT_NAME:?REMOTE_CONTEXT_NAME is required}"

# BACK_HOSTS with REMOTE_HOST fallback
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

SSH_KEY_PATH="$(resolve_ssh_key_path "${SSH_KEY_FILE}")"

# ---------------------------------------------------------------------------
# Temp directories & cleanup
# ---------------------------------------------------------------------------
BUILD_CONTEXT_DIR=$(mktemp -d "${TMPDIR:-/tmp}/${PROJECT_NAME:-project}-migrate-context.XXXXXX")
BACK_BUILD_DIR="${BACK_BUILD_DIR:-./back_build}"

cleanup_context() {
  if [[ -n "${BUILD_CONTEXT_DIR:-}" && -d "${BUILD_CONTEXT_DIR}" ]]; then
    rm -rf "${BUILD_CONTEXT_DIR}"
  fi
}
cleanup_back_build() {
  if [[ -n "${BACK_BUILD_DIR:-}" && -d "${BACK_BUILD_DIR}" ]]; then
    rm -rf "${BACK_BUILD_DIR}"
  fi
}

# ---------------------------------------------------------------------------
# Stop / restore running services
# ---------------------------------------------------------------------------
# Per-host arrays are managed inside the loop; the EXIT trap restores the
# services that were stopped on the host currently being processed.
CURRENT_SERVICES_TO_RESTART=()
CURRENT_DOCKER_SSH_CMD=""
CURRENT_CONTEXT_NAME=""

restore_services() {
  if [[ ${#CURRENT_SERVICES_TO_RESTART[@]} -gt 0 ]]; then
    echo "==> Restarting previously stopped services: ${CURRENT_SERVICES_TO_RESTART[*]}"
    if [[ -n "${CURRENT_DOCKER_SSH_CMD:-}" && -n "${CURRENT_CONTEXT_NAME:-}" ]]; then
      DOCKER_SSH_COMMAND="${CURRENT_DOCKER_SSH_CMD}" docker --context "${CURRENT_CONTEXT_NAME}" start "${CURRENT_SERVICES_TO_RESTART[@]}" || true
    else
      echo "WARN: Unable to restart services automatically (missing docker context info)."
    fi
    CURRENT_SERVICES_TO_RESTART=()
  fi
}

stop_running_services() {
  local docker_ssh_cmd="$1"
  local context_name="$2"
  local project_name="$3"

  CURRENT_DOCKER_SSH_CMD="${docker_ssh_cmd}"
  CURRENT_CONTEXT_NAME="${context_name}"
  CURRENT_SERVICES_TO_RESTART=()

  echo "==> Checking running services for project ${project_name}"
  running_services=()
  while IFS= read -r svc; do
    [[ -n "${svc}" ]] && running_services+=("${svc}")
  done < <(
    DOCKER_SSH_COMMAND="${docker_ssh_cmd}" docker --context "${context_name}" ps \
      -f "name=^/${project_name}_" --format '{{.Names}}' 2>/dev/null || true
  )
  if [[ ${#running_services[@]} -eq 0 ]]; then
    echo "==> No running services detected for ${project_name}"
    return
  fi
  CURRENT_SERVICES_TO_RESTART=("${running_services[@]}")
  echo "==> Stopping services: ${CURRENT_SERVICES_TO_RESTART[*]}"
  DOCKER_SSH_COMMAND="${docker_ssh_cmd}" docker --context "${context_name}" stop "${CURRENT_SERVICES_TO_RESTART[@]}" || true
}

trap 'restore_services; cleanup_context; cleanup_back_build' EXIT

# ---------------------------------------------------------------------------
# Rsync helpers
# ---------------------------------------------------------------------------
RSYNC_DIR_EXCLUDES=(
  "--exclude=.git"
  "--exclude=.gitignore"
  "--exclude=node_modules"
  "--exclude=dist"
  "--exclude=coverage"
  "--exclude=.turbo"
  "--exclude=.next"
  "--exclude=deploy-context"
)

sync_dir_into_context() {
  local src_dir="$1"
  local dest_dir="$2"
  if [[ ! -d "${src_dir}" ]]; then
    echo "Error: required directory '${src_dir}' not found."
    exit 1
  fi
  mkdir -p "${dest_dir}"
  rsync -aL --delete "${RSYNC_DIR_EXCLUDES[@]}" "${src_dir}/" "${dest_dir}/" || {
    echo "Error: rsync failed while staging '${src_dir}'."
    exit 1
  }
}

sync_file_into_context() {
  local src_file="$1"
  local dest_file="$2"
  if [[ ! -f "${src_file}" ]]; then
    echo "Error: required file '${src_file}' not found."
    exit 1
  fi
  mkdir -p "$(dirname "${dest_file}")"
  rsync -a "${src_file}" "${dest_file}" || {
    echo "Error: rsync failed while staging '${src_file}'."
    exit 1
  }
}

# ---------------------------------------------------------------------------
# Symlink resolution
# ---------------------------------------------------------------------------
stage_symlinked_modules() {
  local project="$1"
  local source_base="$2"
  local modules_dir="${source_base}/src/modules"
  if [[ ! -d "${modules_dir}" ]]; then
    return
  fi
  local project_root="${BUILD_CONTEXT_DIR}/${project}"
  local shared_root="${project_root}/.shared-modules"
  mkdir -p "${shared_root}"
  while IFS= read -r symlink_path; do
    local link_name
    link_name=$(basename "${symlink_path}")
    local resolved_path
    resolved_path=$(resolve_realpath "${symlink_path}" || true)
    if [[ -z "${resolved_path}" || ! -d "${resolved_path}" ]]; then
      echo "Warning: symlink target for ${symlink_path} not found, skipping."
      continue
    fi
    local dest_dir="${shared_root}/${link_name}"
    echo "==> [LOCAL] Staging symlinked module '${project}/${link_name}'"
    sync_dir_into_context "${resolved_path}" "${dest_dir}"
    local context_modules_dir="${project_root}/src/modules"
    if [[ -d "${context_modules_dir}" ]]; then
      rm -rf "${context_modules_dir}/${link_name}"
      ln -sf "../../.shared-modules/${link_name}" "${context_modules_dir}/${link_name}"
    fi
  done < <(find "${modules_dir}" -maxdepth 1 -type l)
}

# Fail LOUDLY (instead of letting `rsync -aL` exit non-zero and `set -e` kill us with no
# message) when ./back contains a dangling symlink — typically a modules_shared/* link whose
# nestcommon target was removed.
assert_no_broken_symlinks() {
  local scan_dir="$1"
  [[ -d "${scan_dir}" ]] || return 0
  local broken=()
  local link
  while IFS= read -r link; do
    if [[ ! -e "${link}" ]]; then
      broken+=("${link} -> $(readlink "${link}")")
    fi
  done < <(find "${scan_dir}" \( -name node_modules -o -name .git -o -name dist \) -prune -o -type l -print)
  if (( ${#broken[@]} > 0 )); then
    echo "==> ERROR: ${#broken[@]} broken symlink(s) under '${scan_dir}' — rsync -L would fail. Fix before migrating:" >&2
    local b
    for b in "${broken[@]}"; do
      printf "    ✗ %s\n" "${b}" >&2
    done
    echo "==> Hint: run 'node back/scripts/link-shared.mjs && node front/scripts/link-shared.mjs' (or reinstall), or remove the stale symlink if the module was intentionally deleted." >&2
    exit 1
  fi
}

prepare_back_build() {
  echo "==> [LOCAL] Creating temporary back_build (back copy with resolved symlinks)"
  assert_no_broken_symlinks "./back"
  rm -rf "${BACK_BUILD_DIR}"
  rsync -aL --delete \
    --exclude=.git \
    --exclude=.gitignore \
    --exclude=node_modules \
    --exclude=dist \
    --exclude=coverage \
    --exclude=.turbo \
    --exclude=.next \
    --exclude=deploy-context \
    "./back/" "${BACK_BUILD_DIR}/"

  stage_back_db_cert_if_present "${BACK_BUILD_DIR}"
}

# ---------------------------------------------------------------------------
# Build context preparation
# ---------------------------------------------------------------------------
echo "==> [LOCAL] Preparing build context for migrations"
prepare_back_build

sync_dir_into_context "${BACK_BUILD_DIR}" "${BUILD_CONTEXT_DIR}/back"
sync_file_into_context "${COMPOSE_FILE_ABS}" "${BUILD_CONTEXT_DIR}/${COMPOSE_FILE_PATH}"
sync_file_into_context "${BACK_ENV_FILE}" "${BUILD_CONTEXT_DIR}/.env"
sync_file_into_context "${BACK_ENV_FILE}" "${BUILD_CONTEXT_DIR}/back/.env"

# Flatten to the context root + rewrite relative paths, exactly like deploy-full.sh does for the
# same reason: the compose file normally lives in scripts/ and refers to ../back with a path
# relative to ITS OWN location — left nested at ${BUILD_CONTEXT_DIR}/scripts/docker-compose.yml
# (as sync_file_into_context above does by default), `docker compose --project-directory
# ${BUILD_CONTEXT_DIR}` still failed to resolve `back` as a build context (confirmed live,
# 2026-09-22: "unable to prepare context: path... /back not found" on a real preprod deploy —
# migrate-db.sh was newly wired into the auto-deploy pipeline that day and had never actually run
# end-to-end before, so this was never caught until then).
STAGED_COMPOSE_FILE="${BUILD_CONTEXT_DIR}/docker-compose.yml"
if [[ "${BUILD_CONTEXT_DIR}/${COMPOSE_FILE_PATH}" != "${STAGED_COMPOSE_FILE}" ]]; then
  cp "${BUILD_CONTEXT_DIR}/${COMPOSE_FILE_PATH}" "${STAGED_COMPOSE_FILE}"
fi
sed -i.bak -e 's|\.\./back|./back|g' -e 's|\.\./front|./front|g' "${STAGED_COMPOSE_FILE}"
rm -f "${STAGED_COMPOSE_FILE}.bak"

project_name_raw="${PROJECT_NAME:-$(basename "$PWD")}"
project_slug=$(echo "${project_name_raw}" | tr '[:upper:]' '[:lower:]' | sed 's/[^a-z0-9_-]/-/g')
if [[ -z "${project_slug}" ]]; then
  project_slug="project"
fi
if [[ ! "${project_slug}" =~ ^[a-z0-9] ]]; then
  project_slug="proj-${project_slug}"
fi
COMPOSE_PROJECT_NAME="${project_slug}-migrate"

# ---------------------------------------------------------------------------
# Run migrations on each back host
# ---------------------------------------------------------------------------
echo "==> Running migrations on ${#BACK_HOSTS_LIST[@]} back host(s)"
for entry in "${BACK_HOSTS_LIST[@]}"; do
  read -r target_user target_host <<<"$(parse_host_entry "${entry}" "${REMOTE_USER}")"
  ssh_target="${target_user}@${target_host}"
  ssh_opts=( -p "${REMOTE_SSH_PORT}" -o BatchMode=yes -o ConnectTimeout=10 )
  if [[ -n "${SSH_KEY_PATH}" ]]; then
    ssh_opts+=( -i "${SSH_KEY_PATH}" )
  fi

  echo "==> [BACK:${target_host}] Testing SSH connectivity"
  ssh "${ssh_opts[@]}" "${ssh_target}" "echo SSH_OK" >/dev/null

  docker_ssh_command="ssh -p ${REMOTE_SSH_PORT}"
  if [[ -n "${SSH_KEY_PATH}" ]]; then
    docker_ssh_command="ssh -i ${SSH_KEY_PATH} -p ${REMOTE_SSH_PORT}"
  fi

  context_name="$(build_context_name "${REMOTE_CONTEXT_BASE}" "${target_host}")"
  ensure_docker_context "${context_name}" "${ssh_target}" "${REMOTE_SSH_PORT}"

  host_project_suffix="$(sanitize_identifier "${target_host}")"
  host_project_name="${COMPOSE_PROJECT_NAME}-${host_project_suffix}"

  # Stop running services before migration, restart on exit
  stop_running_services "${docker_ssh_command}" "${context_name}" "${PROJECT_NAME:-${project_slug}}"

  if [[ "${IS_SELF_HOSTED_DB}" -eq 1 ]]; then
    # db/redis have fixed container_name values in docker-compose.yml, shared with the
    # live deploy's own compose project. `stop_running_services` above only stopped them
    # (so restore_services can bring the live stack back), which leaves their names taken
    # and blocks `compose run` below from (re)creating them under this migrate project.
    # Removing them is safe — their state lives in the postgres_data/redis_data volumes,
    # which persist across container removal (same pattern deploy-full.sh already relies
    # on for every deploy, see its "Removing leftover container" step).
    for cname in "${PROJECT_NAME}_postgres" "${PROJECT_NAME}_redis"; do
      if DOCKER_SSH_COMMAND="${docker_ssh_command}" docker --context "${context_name}" inspect "${cname}" >/dev/null 2>&1; then
        echo "==> [BACK:${target_host}] Removing leftover container: ${cname}"
        DOCKER_SSH_COMMAND="${docker_ssh_command}" docker --context "${context_name}" rm -f "${cname}" 2>/dev/null || true
        for i in "${!CURRENT_SERVICES_TO_RESTART[@]}"; do
          [[ "${CURRENT_SERVICES_TO_RESTART[$i]}" == "${cname}" ]] && unset 'CURRENT_SERVICES_TO_RESTART[i]'
        done
      fi
    done
  fi

  echo "==> [BACK:${target_host}] Building back image on remote (symlinks resolved)"
  DOCKER_SSH_COMMAND="${docker_ssh_command}" docker --context "${context_name}" compose \
    --project-directory "${BUILD_CONTEXT_DIR}" \
    --file "${STAGED_COMPOSE_FILE}" \
    --project-name "${host_project_name}" \
    build back

  if [[ "${IS_SELF_HOSTED_DB}" -eq 1 ]]; then
    echo "==> [BACK:${target_host}] Running database migrations (self-hosted DB)"
    DOCKER_SSH_COMMAND="${docker_ssh_command}" docker --context "${context_name}" compose \
      --project-directory "${BUILD_CONTEXT_DIR}" \
      --file "${STAGED_COMPOSE_FILE}" \
      --project-name "${host_project_name}" \
      run --rm back sh -c "\
        until pg_isready -h \"${DB_HOST}\" -p 5432 -U \"${DB_USER}\"; do echo 'waiting for postgres...'; sleep 1; done; \
        SCHEMA_EXISTS=\$(PGPASSWORD=\"\${DB_PASSWORD}\" psql \"\${DATABASE_URL}\" -Atc \"select to_regclass('public.trades')\"); \
        if [ -z \"\${SCHEMA_EXISTS}\" ]; then \
          echo 'Schema empty: running schema sync once'; \
          npx typeorm schema:sync -d dist/config/Datasource.js; \
        fi; \
        npx typeorm -d dist/config/Datasource.js migration:run"
  else
    echo "==> [BACK:${target_host}] DATABASE_ENGINE='${DATABASE_ENGINE_VALUE}' -> running migrations (cloud DB)"
    DOCKER_SSH_COMMAND="${docker_ssh_command}" docker --context "${context_name}" compose \
      --project-directory "${BUILD_CONTEXT_DIR}" \
      --file "${STAGED_COMPOSE_FILE}" \
      --project-name "${host_project_name}" \
      run --rm back sh -c "\
        SCHEMA_EXISTS=\$(PGPASSWORD=\"\${DB_PASSWORD}\" psql \"\${DATABASE_URL}\" -Atc \"select to_regclass('public.trades')\"); \
        if [ -z \"\${SCHEMA_EXISTS}\" ]; then \
          echo 'Schema empty: running schema sync once'; \
          npx typeorm schema:sync -d dist/config/Datasource.js; \
        fi; \
        npx typeorm -d dist/config/Datasource.js migration:run"
  fi

  # Restore services for this host before moving to the next
  restore_services
done

echo "==> Migrations completed on ${#BACK_HOSTS_LIST[@]} host(s)"
