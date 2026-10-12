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

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
cd "${PROJECT_ROOT}"

# ======================
# migrate-server.sh
# ======================
# Migrate the application from one server to another.
#
# What it does:
#   1. Dumps the database on the source server
#   2. Stops the application on the source server
#   3. Updates local .env to point FRONT_HOSTS/BACK_HOSTS to the target
#   4. Runs deploy-remote.sh to build & deploy containers on the target
#   5. Transfers & restores the DB dump on the target
#
# Usage:
#   ./scripts/migrate-server.sh --source user@old-ip --target user@new-ip [options]
#
# Options:
#   --source   user@host   Source server (required)
#   --target   user@host   Target server (required)
#   --ssh-port PORT        SSH port (default: from .env or 22)
#   --ssh-key  PATH        SSH key file (default: from .env)
#   --skip-db              Skip database dump/restore
#   --skip-deploy          Skip deploy-remote.sh (target already deployed)
#   --dry-run              Print commands without executing

# ======================
# HELPERS
# ======================

require_cmd() {
  command -v "$1" >/dev/null 2>&1 || {
    echo "Error: command '$1' not found."
    exit 1
  }
}

is_valid_ipv4() {
  local ip="$1"
  [[ "${ip}" =~ ^([0-9]{1,3}\.){3}[0-9]{1,3}$ ]] || return 1
  local IFS='.' part
  read -ra parts <<< "${ip}"
  for part in "${parts[@]}"; do
    [[ "${part}" -le 255 ]] || return 1
  done
  return 0
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

parse_host_entry() {
  local entry="$1"
  local default_user="${2:-ubuntu}"
  local user="$default_user"
  local host="$entry"
  if [[ "${entry}" == *"@"* ]]; then
    user="${entry%@*}"
    host="${entry#*@}"
  fi
  printf '%s %s' "${user}" "${host}"
}

log() {
  echo "==> $1"
}

log_step() {
  echo ""
  echo "============================================"
  echo "  $1"
  echo "============================================"
}

ssh_run() {
  local target="$1"
  shift
  if [[ "${DRY_RUN}" -eq 1 ]]; then
    echo "[DRY-RUN] ssh ${SSH_OPTS[*]} ${target} $*"
  else
    ssh "${SSH_OPTS[@]}" "${target}" "$@"
  fi
}

rsync_run() {
  if [[ "${DRY_RUN}" -eq 1 ]]; then
    echo "[DRY-RUN] rsync $*"
  else
    rsync "$@"
  fi
}

update_env_key() {
  local file="$1"
  local key="$2"
  local old_val="$3"
  local new_val="$4"
  if grep -q "${key}=.*${old_val}" "${file}" 2>/dev/null; then
    sed -i.bak "s|${key}=.*|${key}=\"${new_val}\"|" "${file}"
    rm -f "${file}.bak"
    log "  Updated ${key} in ${file}"
  fi
}

# ======================
# PARSE ARGUMENTS
# ======================

SOURCE_ENTRY=""
TARGET_ENTRY=""
SSH_PORT=""
SSH_KEY_FILE_ARG=""
SKIP_DB=0
SKIP_DEPLOY=0
DRY_RUN=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --source=*) SOURCE_ENTRY="${1#*=}"; shift ;;
    --source)   SOURCE_ENTRY="$2";     shift 2 ;;
    --target=*) TARGET_ENTRY="${1#*=}"; shift ;;
    --target)   TARGET_ENTRY="$2";     shift 2 ;;
    --ssh-port=*) SSH_PORT="${1#*=}";  shift ;;
    --ssh-port)   SSH_PORT="$2";       shift 2 ;;
    --ssh-key=*)  SSH_KEY_FILE_ARG="${1#*=}"; shift ;;
    --ssh-key)    SSH_KEY_FILE_ARG="$2";      shift 2 ;;
    --skip-db)
      SKIP_DB=1
      shift
      ;;
    --skip-deploy)
      SKIP_DEPLOY=1
      shift
      ;;
    --dry-run)
      DRY_RUN=1
      shift
      ;;
    *)
      echo "Unknown option: $1"
      echo "Usage: ./scripts/migrate-server.sh --source user@old-ip --target user@new-ip [--ssh-port PORT] [--ssh-key PATH] [--skip-db] [--skip-deploy] [--dry-run]"
      exit 1
      ;;
  esac
done

if [[ -z "${SOURCE_ENTRY}" ]]; then
  echo "Error: --source is required."
  exit 1
fi

if [[ -z "${TARGET_ENTRY}" ]]; then
  echo "Error: --target is required."
  exit 1
fi

# ======================
# READ CONFIGURATION
# ======================

ENV_FILE="./back/.env"
if [[ ! -f "${ENV_FILE}" ]]; then
  echo "Error: ${ENV_FILE} not found. Run this script from the project root."
  exit 1
fi

# Save original .env for rollback on failure
cp "${ENV_FILE}" "${ENV_FILE}.migrate-backup"

set -a
source "${ENV_FILE}"
set +a

COMPOSE_PROJECT_NAME="${PROJECT_NAME:?PROJECT_NAME is required in back/.env}"

# Database config
DATABASE_ENGINE_VALUE="${DATABASE_ENGINE:-postgres}"
DATABASE_ENGINE_NORMALIZED="$(echo "${DATABASE_ENGINE_VALUE}" | tr '[:upper:]' '[:lower:]')"
IS_SELF_HOSTED_DB=0
if [[ "${DATABASE_ENGINE_NORMALIZED}" == "postgres" || "${DATABASE_ENGINE_NORMALIZED}" == "selfhosted" ]]; then
  IS_SELF_HOSTED_DB=1
fi

# Ports
NODE_PORT_VALUE="${NODE_PORT:-9741}"
FRONT_PORT_VALUE="${FRONT_PORT:-${VITE_PORT:-3900}}"

# SSH config (args override .env)
if [[ -n "${SSH_PORT}" ]]; then
  EFFECTIVE_SSH_PORT="${SSH_PORT}"
else
  EFFECTIVE_SSH_PORT="${REMOTE_SSH_PORT:-22}"
fi

if [[ -n "${SSH_KEY_FILE_ARG}" ]]; then
  EFFECTIVE_SSH_KEY="$(resolve_key_path "${SSH_KEY_FILE_ARG}")"
elif [[ -n "${SSH_KEY_FILE:-}" ]]; then
  EFFECTIVE_SSH_KEY="$(resolve_key_path "${SSH_KEY_FILE}")"
else
  EFFECTIVE_SSH_KEY=""
fi

# Build SSH options
SSH_OPTS=("-p" "${EFFECTIVE_SSH_PORT}" "-o" "BatchMode=yes" "-o" "ConnectTimeout=15" "-o" "StrictHostKeyChecking=accept-new")
RSYNC_SSH_CMD="ssh -p ${EFFECTIVE_SSH_PORT} -o BatchMode=yes -o StrictHostKeyChecking=accept-new"
if [[ -n "${EFFECTIVE_SSH_KEY}" ]]; then
  SSH_OPTS+=("-i" "${EFFECTIVE_SSH_KEY}")
  RSYNC_SSH_CMD="${RSYNC_SSH_CMD} -i ${EFFECTIVE_SSH_KEY}"
fi

# Parse source and target
read -r SOURCE_USER SOURCE_HOST <<<"$(parse_host_entry "${SOURCE_ENTRY}" "${REMOTE_USER:-ubuntu}")"
SOURCE_SSH="${SOURCE_USER}@${SOURCE_HOST}"

read -r TARGET_USER TARGET_HOST <<<"$(parse_host_entry "${TARGET_ENTRY}" "${REMOTE_USER:-ubuntu}")"
TARGET_SSH="${TARGET_USER}@${TARGET_HOST}"

# Require IPv4 addresses — domain names are not accepted to keep config replacement deterministic
if ! is_valid_ipv4 "${SOURCE_HOST}"; then
  echo "Error: --source host must be a plain IPv4 address, not a hostname."
  echo "  Got:      '${SOURCE_HOST}'"
  echo "  Expected: user@x.x.x.x  (e.g. user@203.0.113.10)"
  exit 1
fi

if ! is_valid_ipv4 "${TARGET_HOST}"; then
  echo "Error: --target host must be a plain IPv4 address, not a hostname."
  echo "  Got:      '${TARGET_HOST}'"
  echo "  Expected: user@x.x.x.x  (e.g. user@203.0.113.20)"
  exit 1
fi

# Container names
POSTGRES_CONTAINER="${COMPOSE_PROJECT_NAME}_postgres"

# Dump file
DUMP_FILENAME="${COMPOSE_PROJECT_NAME}_migration_$(date +%Y%m%d_%H%M%S).dump"

# Temp dir for DB dump relay
TEMP_TRANSFER_DIR=""
cleanup_temp() {
  if [[ -n "${TEMP_TRANSFER_DIR:-}" && -d "${TEMP_TRANSFER_DIR}" ]]; then
    rm -rf "${TEMP_TRANSFER_DIR}"
  fi
}
trap cleanup_temp EXIT

# ======================
# CHECKS
# ======================

require_cmd ssh
require_cmd rsync

if [[ "${IS_SELF_HOSTED_DB}" -eq 0 ]]; then
  log "Cloud database (${DATABASE_ENGINE_VALUE}) — DB migration will be skipped"
  SKIP_DB=1
fi

log_step "Migration: ${SOURCE_HOST} -> ${TARGET_HOST}"

echo "  Project:       ${COMPOSE_PROJECT_NAME}"
echo "  Database:      ${DATABASE_ENGINE_VALUE} (selfhosted: ${IS_SELF_HOSTED_DB})"
echo "  SSH port:      ${EFFECTIVE_SSH_PORT}"
echo "  SSH key:       ${EFFECTIVE_SSH_KEY:-<agent/default>}"
echo "  Skip DB:       ${SKIP_DB}"
echo "  Skip deploy:   ${SKIP_DEPLOY}"
echo "  Dry run:       ${DRY_RUN}"
echo ""

# ======================
# STEP 1: Test SSH connectivity
# ======================

log_step "Step 1: Testing SSH connectivity"

log "Testing source: ${SOURCE_SSH}"
ssh_run "${SOURCE_SSH}" "echo 'Source SSH OK'"

log "Testing target: ${TARGET_SSH}"
ssh_run "${TARGET_SSH}" "echo 'Target SSH OK'"

# ======================
# STEP 2: Dump database on source (while app is still running)
# ======================

if [[ "${SKIP_DB}" -eq 0 ]]; then
  log_step "Step 2: Dumping database on source"

  DB_USER_VALUE="${DB_USER:-postgres}"
  DB_NAME_VALUE="${DB_NAME:-postgres}"

  DUMP_SCRIPT="
set -euo pipefail
STARTED_PG=0

# Check running first
CONTAINER_ID=\$(docker ps -q -f 'name=^/${POSTGRES_CONTAINER}\$' 2>/dev/null || true)

# If not running, try to start a stopped container
if [ -z \"\${CONTAINER_ID}\" ]; then
  STOPPED_ID=\$(docker ps -aq -f 'name=^/${POSTGRES_CONTAINER}\$' 2>/dev/null || true)
  if [ -n \"\${STOPPED_ID}\" ]; then
    echo '==> Postgres container is stopped, starting it...'
    docker start \${STOPPED_ID}
    sleep 3
    CONTAINER_ID=\$(docker ps -q -f 'name=^/${POSTGRES_CONTAINER}\$' 2>/dev/null || true)
    STARTED_PG=1
  fi
fi

if [ -z \"\${CONTAINER_ID}\" ]; then
  echo 'Error: postgres container ${POSTGRES_CONTAINER} not found (running or stopped) on source.'
  exit 1
fi

# Wait for postgres to be ready
for i in \$(seq 1 15); do
  if docker exec \${CONTAINER_ID} pg_isready -U '${DB_USER_VALUE}' -d '${DB_NAME_VALUE}' >/dev/null 2>&1; then
    break
  fi
  if [ \"\$i\" -eq 15 ]; then
    echo 'Error: PostgreSQL did not become ready in time'
    exit 1
  fi
  echo \"  Waiting for postgres... (\${i}/15)\"
  sleep 2
done

echo '==> Dumping database ${DB_NAME_VALUE} from container ${POSTGRES_CONTAINER}'
docker exec \${CONTAINER_ID} pg_dump -U '${DB_USER_VALUE}' -Fc '${DB_NAME_VALUE}' > /tmp/${DUMP_FILENAME}
DUMP_SIZE=\$(du -sh /tmp/${DUMP_FILENAME} | cut -f1)
echo \"==> Dump complete: /tmp/${DUMP_FILENAME} (\${DUMP_SIZE})\"

# Stop postgres again if we started it
if [ \"\${STARTED_PG}\" -eq 1 ]; then
  echo '==> Stopping postgres (was stopped before dump)'
  docker stop \${CONTAINER_ID} >/dev/null
fi
"

  ssh_run "${SOURCE_SSH}" "${DUMP_SCRIPT}"
else
  log_step "Step 2: Skipped (DB migration disabled)"
fi

# ======================
# STEP 3: Stop application on source
# ======================

log_step "Step 3: Stopping application on source"

STOP_SCRIPT="
set -euo pipefail
CONTAINERS=\$(docker ps -q -f 'name=^/${COMPOSE_PROJECT_NAME}' 2>/dev/null || true)
if [ -n \"\${CONTAINERS}\" ]; then
  echo '==> Stopping containers...'
  docker stop \${CONTAINERS}
  echo '==> Containers stopped'
else
  echo '==> No running containers found'
fi
"

ssh_run "${SOURCE_SSH}" "${STOP_SCRIPT}"

# ======================
# STEP 4: Update .env and deploy to target via deploy-remote.sh
# ======================

log_step "Step 4: Updating .env and deploying to target"

if [[ "${DRY_RUN}" -eq 0 ]]; then
  # Update FRONT_HOSTS/BACK_HOSTS/REMOTE_HOST in local .env to point to target
  update_env_key "${ENV_FILE}" "FRONT_HOSTS" "${SOURCE_HOST}" "${TARGET_HOST}"
  update_env_key "${ENV_FILE}" "BACK_HOSTS" "${SOURCE_HOST}" "${TARGET_HOST}"
  update_env_key "${ENV_FILE}" "REMOTE_HOST" "${SOURCE_HOST}" "${TARGET_HOST}"

  # Update CLIENT_ORIGINS too
  if [[ -n "${CLIENT_ORIGINS:-}" ]] && echo "${CLIENT_ORIGINS}" | grep -q "${SOURCE_HOST}"; then
    NEW_CLIENT_ORIGINS="${CLIENT_ORIGINS//${SOURCE_HOST}/${TARGET_HOST}}"
    update_env_key "${ENV_FILE}" "CLIENT_ORIGINS" "${SOURCE_HOST}" "${NEW_CLIENT_ORIGINS}"
  fi
else
  echo "[DRY-RUN] Would update FRONT_HOSTS/BACK_HOSTS/REMOTE_HOST/CLIENT_ORIGINS in ${ENV_FILE}"
fi

if [[ "${SKIP_DEPLOY}" -eq 0 ]]; then
  log "Running deploy-full.sh to build & deploy on target..."
  if [[ "${DRY_RUN}" -eq 1 ]]; then
    echo "[DRY-RUN] Would run: ${SCRIPT_DIR}/deploy-full.sh"
  else
    "${SCRIPT_DIR}/deploy-full.sh"
  fi
else
  log "Skipped (--skip-deploy)"
fi

# ======================
# STEP 5: Transfer & restore database on target
# ======================

if [[ "${SKIP_DB}" -eq 0 ]]; then
  log_step "Step 5: Transferring and restoring database"

  DB_USER_VALUE="${DB_USER:-postgres}"
  DB_NAME_VALUE="${DB_NAME:-postgres}"

  # Transfer dump: source -> local -> target
  TEMP_TRANSFER_DIR=$(mktemp -d "${TMPDIR:-/tmp}/${COMPOSE_PROJECT_NAME}-migration.XXXXXX")

  log "Downloading DB dump from source..."
  rsync_run -avz --progress -e "${RSYNC_SSH_CMD}" \
    "${SOURCE_SSH}:/tmp/${DUMP_FILENAME}" \
    "${TEMP_TRANSFER_DIR}/${DUMP_FILENAME}"

  log "Uploading DB dump to target..."
  rsync_run -avz --progress -e "${RSYNC_SSH_CMD}" \
    "${TEMP_TRANSFER_DIR}/${DUMP_FILENAME}" \
    "${TARGET_SSH}:/tmp/${DUMP_FILENAME}"

  # Restore on target
  log "Restoring database on target..."

  RESTORE_SCRIPT="
set -euo pipefail

echo '==> Waiting for PostgreSQL to be ready...'
for i in \$(seq 1 30); do
  CONTAINER_ID=\$(docker ps -q -f 'name=^/${POSTGRES_CONTAINER}\$' 2>/dev/null || true)
  if [ -n \"\${CONTAINER_ID}\" ] && docker exec \${CONTAINER_ID} pg_isready -U '${DB_USER_VALUE}' -d '${DB_NAME_VALUE}' >/dev/null 2>&1; then
    echo '==> PostgreSQL is ready'
    break
  fi
  if [ \"\$i\" -eq 30 ]; then
    echo 'Error: PostgreSQL did not become ready in time'
    exit 1
  fi
  echo \"  Waiting... (\${i}/30)\"
  sleep 2
done

CONTAINER_ID=\$(docker ps -q -f 'name=^/${POSTGRES_CONTAINER}\$')

echo '==> Stopping back containers to avoid write conflicts during restore...'
BACK_IDS=\$(docker ps -q -f 'name=^/${COMPOSE_PROJECT_NAME}_back' 2>/dev/null || true)
if [ -n \"\${BACK_IDS}\" ]; then
  docker stop \${BACK_IDS}
fi

echo '==> Restoring database from dump...'
docker exec -i \${CONTAINER_ID} pg_restore -U '${DB_USER_VALUE}' -d '${DB_NAME_VALUE}' --no-owner --no-acl --clean --if-exists < /tmp/${DUMP_FILENAME} || true
echo '==> Database restored'

TABLE_COUNT=\$(docker exec \${CONTAINER_ID} psql -U '${DB_USER_VALUE}' -d '${DB_NAME_VALUE}' -t -c \"SELECT count(*) FROM information_schema.tables WHERE table_schema = 'public';\" 2>/dev/null | tr -d ' ')
echo \"==> Verification: \${TABLE_COUNT} table(s) in restored database\"

echo '==> Restarting back containers...'
if [ -n \"\${BACK_IDS}\" ]; then
  docker start \${BACK_IDS}
fi
"

  ssh_run "${TARGET_SSH}" "${RESTORE_SCRIPT}"
else
  log_step "Step 5: Skipped (DB migration disabled)"
fi

# ======================
# STEP 6: Health check & cleanup
# ======================

log_step "Step 6: Health check & cleanup"

# Health check
log "Running health check..."
if [[ "${DRY_RUN}" -eq 0 ]]; then
  sleep 5
  HEALTH_URL="http://${TARGET_HOST}:${NODE_PORT_VALUE}/api/v1/admin/infra/health"
  if curl -sf --connect-timeout 10 --max-time 15 "${HEALTH_URL}" >/dev/null 2>&1; then
    log "Health check PASSED: ${HEALTH_URL}"
  else
    log "Warning: Health check failed (${HEALTH_URL}). The app may still be starting up."
    log "Check manually: curl ${HEALTH_URL}"
  fi
else
  echo "[DRY-RUN] Would curl http://${TARGET_HOST}:${NODE_PORT_VALUE}/api/v1/admin/infra/health"
fi

# Cleanup dump files
if [[ "${SKIP_DB}" -eq 0 ]]; then
  if [[ "${DRY_RUN}" -eq 0 ]]; then
    echo ""
    read -p "Delete temporary dump files on source and target? [y/N] " -n 1 -r REPLY
    echo ""
    if [[ "${REPLY}" =~ ^[Yy]$ ]]; then
      log "Removing dump on source..."
      ssh "${SSH_OPTS[@]}" "${SOURCE_SSH}" "rm -f '/tmp/${DUMP_FILENAME}'" 2>/dev/null || true
      log "Removing dump on target..."
      ssh "${SSH_OPTS[@]}" "${TARGET_SSH}" "rm -f '/tmp/${DUMP_FILENAME}'" 2>/dev/null || true
      log "Dumps cleaned up"
    else
      log "Keeping dump files:"
      log "  Source: ${SOURCE_SSH}:/tmp/${DUMP_FILENAME}"
      log "  Target: ${TARGET_SSH}:/tmp/${DUMP_FILENAME}"
    fi
  fi
fi

# Keep .env backups under timestamped + IP-tagged names for easy identification and restore
BACKUP_TS="$(date +%Y%m%d_%H%M%S)"
BACKUP_SNAPSHOT="${ENV_FILE}.pre-migration-${SOURCE_HOST}-${BACKUP_TS}"
mv "${ENV_FILE}.migrate-backup" "${BACKUP_SNAPSHOT}"
log "Pre-migration back/.env saved: ${BACKUP_SNAPSHOT}"

FRONT_ENV_FILE="./front/.env"
FRONT_BACKUP_SNAPSHOT=""
if [[ -f "${FRONT_ENV_FILE}.migrate-backup" ]]; then
  FRONT_BACKUP_SNAPSHOT="${FRONT_ENV_FILE}.pre-migration-${SOURCE_HOST}-${BACKUP_TS}"
  mv "${FRONT_ENV_FILE}.migrate-backup" "${FRONT_BACKUP_SNAPSHOT}"
  log "Pre-migration front/.env saved: ${FRONT_BACKUP_SNAPSHOT}"
fi

# ======================
# DONE
# ======================

log_step "Migration complete!"
echo ""
echo "  Source (stopped):    ${SOURCE_SSH}"
echo "  Target (running):    ${TARGET_SSH}"
echo "  App URL:             http://${TARGET_HOST}:${FRONT_PORT_VALUE}"
echo "  API URL:             http://${TARGET_HOST}:${NODE_PORT_VALUE}"
echo "  Pre-migration back/.env:  ${BACKUP_SNAPSHOT}"
[[ -n "${FRONT_BACKUP_SNAPSHOT}" ]] && \
echo "  Pre-migration front/.env: ${FRONT_BACKUP_SNAPSHOT}"
echo ""
echo "  To roll back to the source server:"
echo "    1. ./scripts/restore.sh ${SOURCE_SSH}   # or manually:"
echo "       cp ${BACKUP_SNAPSHOT} ${ENV_FILE}"
[[ -n "${FRONT_BACKUP_SNAPSHOT}" ]] && \
echo "       cp ${FRONT_BACKUP_SNAPSHOT} ${FRONT_ENV_FILE}"
echo "    2. ssh ${SSH_OPTS[*]} ${SOURCE_SSH}"
echo "       docker start \$(docker ps -aq -f 'name=${COMPOSE_PROJECT_NAME}')"
echo "    3. Update DNS A record back to ${SOURCE_HOST}"
echo ""
echo "  Once the target is confirmed stable, clean up the source:"
echo "    ssh ${SSH_OPTS[*]} ${SOURCE_SSH}"
echo "    docker rm \$(docker ps -aq -f 'name=^/${COMPOSE_PROJECT_NAME}') 2>/dev/null"
echo ""

if [[ "${DRY_RUN}" -eq 1 ]]; then
  echo "  *** This was a DRY RUN — no changes were made ***"
  echo ""
fi
