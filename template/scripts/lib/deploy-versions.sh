#!/usr/bin/env bash

# =============================================================================
# VXFramework
#
# Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
# SPDX-License-Identifier: MIT
#
# Licensed under the MIT License. See LICENSE in the project root.
# =============================================================================
#
# Versioning, database backup and rollback helpers of deploy-full.sh. SOURCED by it (bash 3.2 compatible), after the
# logging helpers (warn/err/info) and BEFORE the host functions: everything it needs from deploy-full.sh
# (enable_back_maintenance, disable_back_maintenance, wait_for_back_healthy, start_back_worker, patch_back_env_for_host,
# compute_back_services, BACK_WORKER_ENABLED, BUILD_CONTEXT_DIR, PROJECT_NAME, IS_SQLITE_DB, IS_SELF_HOSTED_DB...) is resolved at call time.
#
# Image tags kept on each host: `<image>:latest` (running version) and `<image>:previous` (the one before). Remote files
# next to the remote `.env`: `.env.previous`, `.deploy/current.json`, `.deploy/previous.json`.
#
# Progress markers (parsed by Agent Hub, exact strings; `<t>` = `BACK:<host>` or `FRONT:<host>`):
#   ==> [<t>] Tagging current images as previous      ==> [BACK:<host>] Backing up database
#   ==> [<t>] Rolling back to previous version        ==> [<t>] Rolled back to previous version
#   ==> [<t>] Rollback failed
#   ==> [BACK:<host>] Starting back-worker (after back is healthy)   ==> [BACK:<host>] back-worker disabled (BACK_WORKER=off): removed if present
#   ==> Deployment failed, previous version restored  (exit 3)    ==> Deployment failed, rollback failed  (exit 4)
#   ==> Rollback completed                            (manual `rollback` command)
# Exit codes 3 and 4 are produced ONLY by dv_abort_with_rollback.
#
# Functions act on the "current host" set by dv_use_host (DV_* globals).
# =============================================================================

DV_AUTO_ROLLBACK="${DEPLOY_AUTO_ROLLBACK:-1}"
DV_MIGRATE="${DV_MIGRATE:-0}"
DV_FORCE_DB_BACKUP="${DV_FORCE_DB_BACKUP:-0}"
DV_ARMED=0
DV_SCOPE="all"                 # roll back every switched host ("all") or only the front hosts ("front")
DV_DB_BACKUP=""                # reference of the backup taken for the current host in this run
DV_IDX=-1                      # index of the current host in the DV_SW_* registry
# Registry of the hosts switched in this run (parallel arrays, bash 3.2 has no associative arrays).
DV_SW_REC=()                   # role|host|ssh_target|ssh_port|key|context|project|remote_dir
DV_SW_TAGGED=()                # 1 = a `latest` image existed and was tagged `previous`
DV_SW_BACKUP=()                # database backup reference ("" = none)
DV_SW_SERVED=()                # 1 = the new version was healthy and served traffic
DV_SW_STATE=()                 # 1 = .deploy/current.json was written in this run

# ---------------------------------------------------------------------------
# Revision
# ---------------------------------------------------------------------------
# DEPLOY_REVISION when set, else `git rev-parse --short HEAD` (+ `-dirty` when the work tree has changes).
dv_compute_revision() {
  if [[ -n "${DEPLOY_REVISION:-}" ]]; then
    printf '%s' "${DEPLOY_REVISION}"
    return 0
  fi
  local rev="" dir
  for dir in "." "./back"; do
    rev="$(git -C "${dir}" rev-parse --short HEAD 2>/dev/null || true)"
    if [[ -n "${rev}" ]]; then
      if [[ -n "$(git -C "${dir}" status --porcelain 2>/dev/null || true)" ]]; then
        rev="${rev}-dirty"
      fi
      printf '%s' "${rev}"
      return 0
    fi
  done
  printf 'unknown'
}

# Sets KEY=value in an env file (replaces an existing line). Portable across BSD and GNU sed.
dv_env_set() {
  local file="$1" key="$2" value="$3"
  if grep -q "^${key}=" "${file}" 2>/dev/null; then
    sed -i.sedtmp "s|^${key}=.*|${key}=${value}|" "${file}" && rm -f "${file}.sedtmp"
  else
    # Keep a trailing newline-safe append (the file may not end with one).
    printf '\n%s=%s\n' "${key}" "${value}" >> "${file}"
  fi
}

dv_json_escape() {
  local s="$1"
  s="${s//\\/\\\\}"
  s="${s//\"/\\\"}"
  printf '%s' "${s}"
}

dv_safe_name() { printf '%s' "$1" | tr -c 'A-Za-z0-9._-' '-'; }

# ---------------------------------------------------------------------------
# Current host
# ---------------------------------------------------------------------------
# dv_use_host <BACK|FRONT> <host> <ssh_target> <ssh_port> <key_path> <context> <project> <remote_dir>
dv_use_host() {
  DV_ROLE="$1"; DV_HOST="$2"; DV_SSH_TARGET="$3"; DV_SSH_PORT="$4"; DV_KEY="$5"
  DV_CONTEXT="$6"; DV_PROJECT="$7"; DV_REMOTE_DIR="$8"
  DV_SSH_OPTS=(-p "${DV_SSH_PORT}")
  DV_SCP_OPTS=(-P "${DV_SSH_PORT}")
  DV_DOCKER_SSH="ssh -p ${DV_SSH_PORT}"
  if [[ -n "${DV_KEY}" ]]; then
    DV_SSH_OPTS+=(-i "${DV_KEY}")
    DV_SCP_OPTS+=(-i "${DV_KEY}")
    DV_DOCKER_SSH="ssh -i ${DV_KEY} -p ${DV_SSH_PORT}"
  fi
}

dv_tag() { printf '%s:%s' "${DV_ROLE}" "${DV_HOST}"; }

dv_docker()  { DOCKER_SSH_COMMAND="${DV_DOCKER_SSH}" docker --context "${DV_CONTEXT}" "$@"; }
dv_compose() { dv_docker compose --project-directory "${BUILD_CONTEXT_DIR}" --project-name "${DV_PROJECT}" "$@"; }
dv_ssh()     { ssh "${DV_SSH_OPTS[@]}" "${DV_SSH_TARGET}" "$@"; }

dv_image_exists() { dv_docker image inspect "$1" >/dev/null 2>&1; }

dv_back_image() { printf '%s_back' "${PROJECT_NAME}"; }

# Front image (compose default name `<project>-<service>`, `_` with the legacy compose v1): the first that exists,
# else the v2 name. back-worker shares the back image in the compose files, so there is nothing more to tag for it.
dv_front_image() {
  local cand
  for cand in "${DV_PROJECT}-front" "${DV_PROJECT}_front"; do
    if dv_image_exists "${cand}:latest" || dv_image_exists "${cand}:previous"; then
      printf '%s' "${cand}"
      return 0
    fi
  done
  printf '%s-front' "${DV_PROJECT}"
}

dv_role_image() {
  if [[ "${DV_ROLE}" == "BACK" ]]; then dv_back_image; else dv_front_image; fi
}

# ---------------------------------------------------------------------------
# Tag previous + save env
# ---------------------------------------------------------------------------
# Tags `<image>:latest` as `<image>:previous` when it exists. Sets DV_TAGGED (1/0).
dv_tag_previous() {
  local image="$1"
  DV_TAGGED=0
  echo "==> [$(dv_tag)] Tagging current images as previous"
  if dv_image_exists "${image}:latest"; then
    dv_docker tag "${image}:latest" "${image}:previous"
    DV_TAGGED=1
  else
    echo "==> [$(dv_tag)] No current image (${image}:latest) — first deploy, no previous version to keep"
  fi
}

# Undo of the build when a deploy stops BEFORE the switch (e.g. a failed pre-switch backup): `latest` goes back to the
# image still running, so the next deploy's dv_tag_previous keeps the right rollback target. No-op on a first deploy.
dv_restore_latest_tag() {
  local image="$1"
  [[ "${DV_TAGGED:-0}" == "1" ]] || return 0
  dv_docker tag "${image}:previous" "${image}:latest" \
    || warn "[$(dv_tag)] Could not re-tag ${image}:previous as latest — check the tags before the next deploy"
}

# Remote `.env` -> `.env.previous` (before the upload overwrites it). Best effort.
dv_save_env_previous() {
  dv_ssh "if [ -f '${DV_REMOTE_DIR}/.env' ]; then cp -p '${DV_REMOTE_DIR}/.env' '${DV_REMOTE_DIR}/.env.previous'; fi" \
    || warn "[$(dv_tag)] Could not save the remote .env as .env.previous"
}

# ---------------------------------------------------------------------------
# Registry of switched hosts
# ---------------------------------------------------------------------------
dv_register_switched() {
  DV_IDX=${#DV_SW_REC[@]}
  DV_SW_REC[DV_IDX]="${DV_ROLE}|${DV_HOST}|${DV_SSH_TARGET}|${DV_SSH_PORT}|${DV_KEY}|${DV_CONTEXT}|${DV_PROJECT}|${DV_REMOTE_DIR}"
  DV_SW_TAGGED[DV_IDX]="${DV_TAGGED:-0}"
  DV_SW_BACKUP[DV_IDX]=""
  DV_SW_SERVED[DV_IDX]=0
  DV_SW_STATE[DV_IDX]=0
}

dv_load_record() {
  local rec="${DV_SW_REC[$1]}"
  local role host target port key ctx proj dir
  IFS='|' read -r role host target port key ctx proj dir <<<"${rec}"
  dv_use_host "${role}" "${host}" "${target}" "${port}" "${key}" "${ctx}" "${proj}" "${dir}"
}

# ---------------------------------------------------------------------------
# Database backup / restore
# ---------------------------------------------------------------------------
# Any back image available on the host (the throwaway container only needs `sh` and `cp`).
dv_any_back_image() {
  local image
  image="$(dv_back_image)"
  if dv_image_exists "${image}:latest"; then printf '%s:latest' "${image}"; else printf '%s:previous' "${image}"; fi
}

dv_sqlite_volume() { printf '%s_sqlite_data' "${DV_PROJECT}"; }
dv_sqlite_file()   { printf '/data/%s.db' "${PROJECT_NAME}"; }

# Database backups. Kept per host (DEPLOY_DB_BACKUP_KEEP, default 2, read from back/.env at call time) and copied to
# ./backups/deploy-<environment>/ at the end of the deploy (dv_download_backups, same count kept locally).
#   SQLite   : at the switch (old back stopped, nothing writes), copy of the file inside the volume to
#              /data/backups/<project>-pre-<revision>-<UTC ts>.db — every deploy: the automatic rollback restores it.
#   Postgres : self-hosted `db` service, only with --migrate, --force-db-backup or DB_SCHEMA_MODE=sync. BEFORE the switch,
#              while the old back still serves (pg_dump reads a consistent snapshot; writes made between the dump and the
#              switch are not in it), into <remote app dir>/backups/<project>_pre-<revision>_<UTC ts>.dump on the server
#              (custom format, compressed in the container, written by the server's shell: the dump itself never
#              crosses the network, only the end-of-deploy local copy does). At most one per
#              DEPLOY_DB_BACKUP_MIN_AGE_HOURS (default 24, 0 = every deploy): a more recent dump is reused, unless
#              --migrate or --force-db-backup.
#   other    : cloud/supabase/neon -> warning only
DV_DL_IDX=()                   # local copies queued for the end of the deploy: registry index ...
DV_DL_REF=()                   # ... and remote reference of the backup

# Non-negative integer setting from the environment (back/.env is sourced with `set -a`), else the default.
dv_int_setting() {
  local value="${!1:-}"
  if [[ "${value}" =~ ^[0-9]+$ ]]; then printf '%s' "${value}"; else printf '%s' "$2"; fi
}

dv_backup_keep() { local k; k="$(dv_int_setting DEPLOY_DB_BACKUP_KEEP 2)"; [[ "${k}" -ge 1 ]] || k=1; printf '%s' "${k}"; }

dv_backup_forced() { [[ "${DV_MIGRATE}" == "1" || "${DV_FORCE_DB_BACKUP:-0}" == "1" ]]; }

# Before the switch (old version still serving): Postgres dump, cloud warning; nothing for SQLite. Sets DV_DB_BACKUP.
# Returns 1 when a backup that should exist failed.
dv_backup_db_before_switch() {
  local revision="$1"
  DV_DB_BACKUP=""
  [[ "${IS_SQLITE_DB:-0}" -ne 1 ]] || return 0
  echo "==> [BACK:${DV_HOST}] Backing up database"
  if [[ "${IS_SELF_HOSTED_DB:-0}" -eq 1 ]]; then
    dv_backup_postgres "${revision}"
  else
    warn "[BACK:${DV_HOST}] Cloud database (DB_ENGINE=${DB_ENGINE_VALUE:-?}): no automatic backup — rely on the provider's backups/PITR; rollback will NOT restore data"
  fi
}

# At the switch (old back stopped, new one not started): SQLite copy; nothing for the other engines. Sets DV_DB_BACKUP.
dv_backup_db_at_switch() {
  local revision="$1"
  DV_DB_BACKUP=""
  [[ "${IS_SQLITE_DB:-0}" -eq 1 ]] || return 0
  echo "==> [BACK:${DV_HOST}] Backing up database"
  dv_backup_sqlite "${revision}"
}

dv_backup_sqlite() {
  local revision="$1" vol image name out
  vol="$(dv_sqlite_volume)"
  if ! dv_docker volume inspect "${vol}" >/dev/null 2>&1; then
    echo "==> [BACK:${DV_HOST}] No SQLite volume (${vol}) yet — first deploy, nothing to back up"
    return 0
  fi
  image="$(dv_any_back_image)"
  name="${PROJECT_NAME}-pre-$(dv_safe_name "${revision}")-$(date -u +%Y%m%dT%H%M%SZ).db"
  out="$(dv_docker run --rm --entrypoint sh -v "${vol}:/data" "${image}" -c '
    set -e
    db="$1"; name="$2"; keep="$3"; dir=/data/backups
    if [ ! -f "$db" ]; then echo NO_DB; exit 0; fi
    mkdir -p "$dir"
    cp -p "$db" "$dir/$name"
    if [ -f "$db-wal" ]; then cp -p "$db-wal" "$dir/$name-wal"; fi
    if [ -f "$db-shm" ]; then cp -p "$db-shm" "$dir/$name-shm"; fi
    if [ ! -s "$dir/$name" ]; then echo EMPTY_BACKUP; exit 1; fi
    ls -1t "$dir"/*-pre-*.db 2>/dev/null | tail -n +$((keep + 1)) | while read -r f; do rm -f "$f" "$f-wal" "$f-shm"; done
    echo BACKUP_OK
  ' sh "$(dv_sqlite_file)" "${name}" "$(dv_backup_keep)")" || { err "[BACK:${DV_HOST}] SQLite backup failed"; return 1; }
  if [[ "${out}" == *BACKUP_OK* ]]; then
    DV_DB_BACKUP="/data/backups/${name}"
    echo "==> [BACK:${DV_HOST}] SQLite backup: ${DV_DB_BACKUP} (volume ${vol})"
  else
    echo "==> [BACK:${DV_HOST}] No SQLite database file yet — nothing to back up"
  fi
}

# Newest dump of this project on the server younger than DEPLOY_DB_BACKUP_MIN_AGE_HOURS (empty when none / disabled).
dv_recent_postgres_dump() {
  local dir="$1" min_age
  min_age="$(dv_int_setting DEPLOY_DB_BACKUP_MIN_AGE_HOURS 24)"
  [[ "${min_age}" -gt 0 ]] || return 0
  dv_ssh "find '${dir}' -maxdepth 1 -name '${PROJECT_NAME}_pre-*.dump' -mmin -$((min_age * 60)) -exec ls -1t {} + 2>/dev/null | head -n 1" 2>/dev/null || true
}

dv_backup_postgres() {
  local revision="$1" schema_mode ctr dir name recent waited=0
  schema_mode="$(printf '%s' "${DB_SCHEMA_MODE:-}" | tr '[:upper:]' '[:lower:]')"
  if ! dv_backup_forced && [[ "${schema_mode}" != "sync" ]]; then
    echo "==> [BACK:${DV_HOST}] Postgres: no migration and no schema sync in this deploy — pre-deploy dump skipped (use ./scripts/backup-db.sh for a manual one)"
    return 0
  fi
  dir="${DV_REMOTE_DIR}/backups"
  if ! dv_backup_forced; then
    recent="$(dv_recent_postgres_dump "${dir}")"
    if [[ -n "${recent}" ]]; then
      DV_DB_BACKUP="${recent}"
      echo "==> [BACK:${DV_HOST}] Postgres: the last pre-deploy dump is less than $(dv_int_setting DEPLOY_DB_BACKUP_MIN_AGE_HOURS 24) h old (${recent}) — no new dump (--force-db-backup forces one)"
      return 0
    fi
  fi
  ctr="${PROJECT_NAME}_postgres"
  if [[ "$(dv_docker inspect -f '{{.State.Running}}' "${ctr}" 2>/dev/null || true)" != "true" ]]; then
    if ! dv_docker inspect "${ctr}" >/dev/null 2>&1; then
      echo "==> [BACK:${DV_HOST}] No Postgres container (${ctr}) yet — first deploy, nothing to back up"
      return 0
    fi
    # Stopped (data volume untouched): start it for the dump; `up` keeps it running afterwards.
    dv_compose up -d db || { err "[BACK:${DV_HOST}] Could not start the db service for the backup"; return 1; }
    while ! dv_docker exec "${ctr}" pg_isready -q >/dev/null 2>&1; do
      sleep 1
      waited=$((waited + 1))
      if [[ ${waited} -ge 60 ]]; then err "[BACK:${DV_HOST}] Postgres not ready after 60s — cannot back up"; return 1; fi
    done
  fi
  name="${PROJECT_NAME}_pre-$(dv_safe_name "${revision}")_$(date -u +%Y%m%dT%H%M%SZ).dump"
  echo "==> [BACK:${DV_HOST}] Postgres: dumping on the server to ${dir}/${name} (the current version keeps serving)"
  if ! dv_ssh "mkdir -p '${dir}' && docker exec '${ctr}' pg_dump --username='${DB_USER:-postgres}' --dbname='${DB_NAME:-postgres}' --format=custom --compress=1 --no-owner --no-privileges > '${dir}/${name}.part' && mv -f '${dir}/${name}.part' '${dir}/${name}'"; then
    dv_ssh "rm -f '${dir}/${name}.part'" >/dev/null 2>&1 || true
    err "[BACK:${DV_HOST}] pg_dump failed"
    return 1
  fi
  dv_ssh "ls -1t '${dir}'/${PROJECT_NAME}_pre-*.dump 2>/dev/null | tail -n +$(( $(dv_backup_keep) + 1 )) | while read -r f; do rm -f \"\$f\"; done" \
    || warn "[BACK:${DV_HOST}] Could not prune the old dumps in ${dir}"
  DV_DB_BACKUP="${dir}/${name}"
  echo "==> [BACK:${DV_HOST}] Postgres dump: ${DV_DB_BACKUP} (last $(dv_backup_keep) kept on the server)"
  echo "==> [BACK:${DV_HOST}] No automatic restore for Postgres. To restore manually (on the server):"
  echo "    ssh ${DV_SSH_OPTS[*]} ${DV_SSH_TARGET} \"docker exec -i ${ctr} pg_restore --clean --if-exists --no-owner --no-privileges -U ${DB_USER:-postgres} -d ${DB_NAME:-postgres} < ${DV_DB_BACKUP}\""
}

# ---------------------------------------------------------------------------
# Local copies of the backups (end of the deploy, outside the switch)
# ---------------------------------------------------------------------------
dv_local_backup_dir() { printf './backups/deploy-%s' "$(dv_environment_name)"; }

# Queues the backup <ref> of the host at registry index <idx> for dv_download_backups.
dv_queue_backup_download() {
  [[ -n "$2" ]] || return 0
  DV_DL_IDX+=("$1")
  DV_DL_REF+=("$2")
}

# Copies one queued backup to <dest> (SQLite: tar of the file and its -wal/-shm companions). Returns 1 on failure.
dv_fetch_backup() {
  local ref="$1" dest="$2"
  if [[ "${IS_SQLITE_DB:-0}" -eq 1 ]]; then
    dv_docker run --rm --entrypoint sh -v "$(dv_sqlite_volume):/data" "$(dv_any_back_image)" -c '
      cd "$(dirname "$1")" && n="$(basename "$1")" && tar -cf - "$n" $(ls "$n-wal" "$n-shm" 2>/dev/null)
    ' sh "${ref}" > "${dest}"
  else
    scp "${DV_SCP_OPTS[@]}" "${DV_SSH_TARGET}:${ref}" "${dest}" >/dev/null
  fi
}

# End of the deploy: copies each queued backup to ./backups/deploy-<environment>/ unless that file is already there or,
# without --migrate / --force-db-backup, a local copy younger than DEPLOY_DB_BACKUP_MIN_AGE_HOURS exists; keeps the
# newest DEPLOY_DB_BACKUP_KEEP. DEPLOY_DB_BACKUP_DOWNLOAD=0 disables it. Never fails the deploy (warnings only).
dv_download_backups() {
  [[ ${#DV_DL_IDX[@]} -gt 0 ]] || return 0
  if [[ "${DEPLOY_DB_BACKUP_DOWNLOAD:-1}" == "0" ]]; then
    echo "==> Local copy of the database backups disabled (DEPLOY_DB_BACKUP_DOWNLOAD=0)"
    return 0
  fi
  local i dir pattern dest min_age recent
  dir="$(dv_local_backup_dir)"
  min_age="$(dv_int_setting DEPLOY_DB_BACKUP_MIN_AGE_HOURS 24)"
  mkdir -p "${dir}"
  for ((i = 0; i < ${#DV_DL_IDX[@]}; i++)); do
    dv_load_record "${DV_DL_IDX[i]}"
    if [[ "${IS_SQLITE_DB:-0}" -eq 1 ]]; then pattern="${PROJECT_NAME}-pre-*.db.tar"; dest="${dir}/$(basename "${DV_DL_REF[i]}").tar"
    else pattern="${PROJECT_NAME}_pre-*.dump"; dest="${dir}/$(basename "${DV_DL_REF[i]}")"; fi
    if [[ -f "${dest}" ]]; then
      echo "==> [BACK:${DV_HOST}] Database backup already copied locally (${dest})"
      continue
    fi
    if ! dv_backup_forced && [[ "${min_age}" -gt 0 ]]; then
      recent="$(find "${dir}" -maxdepth 1 -name "${pattern}" -mmin -$((min_age * 60)) 2>/dev/null | head -n 1)"
      if [[ -n "${recent}" ]]; then
        echo "==> [BACK:${DV_HOST}] A local backup copy younger than ${min_age} h exists (${recent}) — not copied again"
        continue
      fi
    fi
    echo "==> [BACK:${DV_HOST}] Copying the database backup to ${dest}"
    if ! dv_fetch_backup "${DV_DL_REF[i]}" "${dest}.part" || [[ ! -s "${dest}.part" ]]; then
      rm -f "${dest}.part"
      warn "[BACK:${DV_HOST}] Could not copy ${DV_DL_REF[i]} locally — it stays on the server"
      continue
    fi
    mv -f "${dest}.part" "${dest}"
    # shellcheck disable=SC2012 # names are generated (no spaces/newlines)
    ls -1t "${dir}"/${pattern} 2>/dev/null | tail -n +$(( $(dv_backup_keep) + 1 )) | while read -r f; do rm -f "${f}"; done
    echo "==> [BACK:${DV_HOST}] Local copy: ${dest} (last $(dv_backup_keep) kept in ${dir})"
  done
}

# Restores a SQLite backup (volume path /data/backups/...) over the live file. The back must be stopped.
dv_restore_sqlite() {
  local ref="$1" vol out
  vol="$(dv_sqlite_volume)"
  out="$(dv_docker run --rm --entrypoint sh -v "${vol}:/data" "$(dv_any_back_image)" -c '
    set -e
    src="$1"; db="$2"
    if [ ! -f "$src" ]; then echo MISSING; exit 1; fi
    rm -f "$db-wal" "$db-shm"
    cp -p "$src" "$db"
    if [ -f "$src-wal" ]; then cp -p "$src-wal" "$db-wal"; fi
    if [ -f "$src-shm" ]; then cp -p "$src-shm" "$db-shm"; fi
    echo RESTORE_OK
  ' sh "${ref}" "$(dv_sqlite_file)")" || return 1
  [[ "${out}" == *RESTORE_OK* ]]
}

# ---------------------------------------------------------------------------
# Remote state files
# ---------------------------------------------------------------------------
dv_environment_name() {
  case "$(basename "${BACK_ENV_FILE:-.env}")" in
    .env) printf 'prod' ;;
    .env.*) local n; n="$(basename "${BACK_ENV_FILE}")"; printf '%s' "${n#.env.}" ;;
    *) printf 'unknown' ;;
  esac
}

# current.json -> previous.json, then writes the new current.json {revision, environment, date, dbBackup}.
dv_write_state() {
  local revision="$1" backup="$2" json
  json="{\"revision\":\"$(dv_json_escape "${revision}")\",\"environment\":\"$(dv_json_escape "$(dv_environment_name)")\",\"date\":\"$(date -u +%Y-%m-%dT%H:%M:%SZ)\",\"dbBackup\":\"$(dv_json_escape "${backup}")\"}"
  dv_ssh "mkdir -p '${DV_REMOTE_DIR}/.deploy' && cd '${DV_REMOTE_DIR}/.deploy' && { [ ! -f current.json ] || mv -f current.json previous.json; } && cat > current.json" <<<"${json}" \
    || { warn "[BACK:${DV_HOST}] Could not write ${DV_REMOTE_DIR}/.deploy/current.json"; return 1; }
}

# Undo of dv_write_state (automatic rollback of a host that already finished).
dv_revert_state() {
  dv_ssh "cd '${DV_REMOTE_DIR}/.deploy' 2>/dev/null && { if [ -f previous.json ]; then mv -f previous.json current.json; else rm -f current.json; fi; }" || true
}

dv_swap_state() {
  dv_ssh "cd '${DV_REMOTE_DIR}/.deploy' 2>/dev/null && if [ -f current.json ] && [ -f previous.json ]; then mv -f current.json .swap.json && mv -f previous.json current.json && mv -f .swap.json previous.json; fi" || true
}

# Prints the dbBackup of the remote current.json (empty when none).
dv_current_db_backup() {
  dv_ssh "cat '${DV_REMOTE_DIR}/.deploy/current.json' 2>/dev/null || true" 2>/dev/null \
    | sed -n 's/.*"dbBackup": *"\([^"]*\)".*/\1/p' | head -n 1
}

# ---------------------------------------------------------------------------
# Rollback of one host
# ---------------------------------------------------------------------------
# Image tags: `auto` discards the bad `latest` (previous -> latest); `manual` swaps so that a second rollback rolls forward.
dv_retag_images() {
  local mode="$1" image="$2"
  if [[ "${mode}" == "manual" ]]; then
    if dv_image_exists "${image}:latest"; then
      dv_docker tag "${image}:latest" "${image}:rollback-tmp" || return 1
    fi
    dv_docker tag "${image}:previous" "${image}:latest" || return 1
    if dv_image_exists "${image}:rollback-tmp"; then
      dv_docker tag "${image}:rollback-tmp" "${image}:previous" || return 1
      dv_docker rmi "${image}:rollback-tmp" >/dev/null 2>&1 || true
    fi
  else
    dv_docker tag "${image}:previous" "${image}:latest" || return 1
  fi
}

# Remote env: auto -> .env.previous replaces .env; manual -> swap. No-op (returns 0) when there is no .env.previous.
dv_restore_env() {
  local mode="$1"
  if [[ "${mode}" == "manual" ]]; then
    dv_ssh "cd '${DV_REMOTE_DIR}' && if [ -f .env.previous ]; then if [ -f .env ]; then mv -f .env .env.swap; fi; mv -f .env.previous .env; if [ -f .env.swap ]; then mv -f .env.swap .env.previous; fi; fi"
  else
    dv_ssh "cd '${DV_REMOTE_DIR}' && if [ -f .env.previous ]; then cp -p .env.previous .env; fi"
  fi
}

# Puts the remote `.env` (now the target version's) into the staged context as back/.env (or front/.env), falling back
# to the local env file with a warning. The back env then gets the same per-host patches as a normal deploy.
dv_stage_env_from_remote() {
  local dest="$1" local_fallback="$2"
  mkdir -p "$(dirname "${dest}")"
  if ! scp "${DV_SCP_OPTS[@]}" "${DV_SSH_TARGET}:${DV_REMOTE_DIR}/.env" "${dest}" >/dev/null 2>&1; then
    warn "[$(dv_tag)] Could not fetch the remote .env — using the local ${local_fallback}"
    cp "${local_fallback}" "${dest}"
  fi
}

# Brings the previous back version up on the current host. mode: auto|manual. $2 = SQLite backup to restore ("" = none).
# Every step is checked explicitly (this runs inside `if`, where errexit is off).
dv_rollback_back() {
  local mode="$1" restore_ref="${2:-}" image
  image="$(dv_back_image)"
  echo "==> [BACK:${DV_HOST}] Rolling back to previous version"
  if ! dv_image_exists "${image}:previous"; then
    err "[BACK:${DV_HOST}] No ${image}:previous image on this host"
    echo "==> [BACK:${DV_HOST}] Rollback failed"
    return 1
  fi
  {
    enable_back_maintenance "${DV_CONTEXT}" "${DV_DOCKER_SSH}" "${DV_HOST}" &&
    { dv_compose --profile metrics rm -sf back back-worker >/dev/null 2>&1 || true; } &&
    dv_retag_images "${mode}" "${image}" &&
    dv_restore_env "${mode}" &&
    { [[ "${mode}" != "manual" ]] || dv_swap_state; } &&
    { [[ -z "${restore_ref}" ]] || { echo "==> [BACK:${DV_HOST}] Restoring SQLite backup ${restore_ref}"; dv_restore_sqlite "${restore_ref}"; }; } &&
    dv_stage_env_from_remote "${BUILD_CONTEXT_DIR}/back/.env" "${BACK_ENV_FILE}" &&
    patch_back_env_for_host "${BUILD_CONTEXT_DIR}/back/.env" "${DV_HOST}" &&
    compute_back_services "${DV_HOST}" &&
    { [[ "${BACK_WORKER_ENABLED:-1}" -eq 1 ]] || echo "==> [BACK:${DV_HOST}] back-worker disabled (BACK_WORKER=off): removed if present"; } &&
    VMAGENT_CONFIG_PATH="${DV_REMOTE_DIR}/vmagent.yml" dv_compose up -d --no-build "${BACK_SERVICES_UP[@]}" &&
    wait_for_back_healthy "${DV_CONTEXT}" "${DV_DOCKER_SSH}" "${DV_PROJECT}" "${DV_HOST}" &&
    start_back_worker "${DV_CONTEXT}" "${DV_DOCKER_SSH}" "${DV_PROJECT}" "${DV_HOST}" "${DV_REMOTE_DIR}/vmagent.yml"
  } || {
    err "[BACK:${DV_HOST}] Could not bring the previous version back up"
    echo "==> [BACK:${DV_HOST}] Rollback failed"
    return 1
  }
  # Reload BEFORE lifting maintenance: nginx resolves `back` at (re)load, the first requests must reach the new container.
  dv_compose exec -T back-lb nginx -s reload >/dev/null 2>&1 || true
  disable_back_maintenance "${DV_CONTEXT}" "${DV_DOCKER_SSH}" "${DV_HOST}"
  echo "==> [BACK:${DV_HOST}] Rolled back to previous version"
}

# Same for a front host. A front env file saved as .env.previous is restored only when the host's remote dir is not shared
# with the back (both would write the same `.env`); the local front env is used otherwise.
dv_rollback_front() {
  local mode="$1" image deps="--no-deps"
  image="$(dv_front_image)"
  echo "==> [FRONT:${DV_HOST}] Rolling back to previous version"
  if ! dv_image_exists "${image}:previous"; then
    err "[FRONT:${DV_HOST}] No ${image}:previous image on this host"
    echo "==> [FRONT:${DV_HOST}] Rollback failed"
    return 1
  fi
  {
    { dv_compose rm -sf front >/dev/null 2>&1 || true; } &&
    dv_retag_images "${mode}" "${image}" &&
    { [[ "${DV_FRONT_OWN_ENV:-1}" != "1" ]] || dv_restore_env "${mode}"; } &&
    {
      if [[ "${DV_FRONT_OWN_ENV:-1}" == "1" ]]; then
        dv_stage_env_from_remote "${BUILD_CONTEXT_DIR}/front/.env" "${FRONT_ENV_FILE}"
      else
        mkdir -p "${BUILD_CONTEXT_DIR}/front" && cp "${FRONT_ENV_FILE}" "${BUILD_CONTEXT_DIR}/front/.env"
      fi
    } &&
    dv_compose up -d --no-build ${deps} front &&
    dv_wait_front_running
  } || {
    err "[FRONT:${DV_HOST}] Could not bring the previous front version back up"
    echo "==> [FRONT:${DV_HOST}] Rollback failed"
    return 1
  }
  echo "==> [FRONT:${DV_HOST}] Rolled back to previous version"
}

# The front container must be running and not unhealthy, and still so after a short settle time (a crash loop flaps
# between running and restarting). Max 30s; a `starting` healthcheck counts as up (its first probe can take 30s+).
dv_wait_front_running() {
  local max_wait=30 elapsed=0
  while true; do
    if dv_front_state_ok; then
      sleep 5
      if dv_front_state_ok; then
        echo "==> [FRONT:${DV_HOST}] front is running"
        return 0
      fi
    fi
    if [[ "${DV_FRONT_STATE:-}" == "exited" || "${DV_FRONT_STATE:-}" == "dead" ]]; then return 1; fi
    sleep 2
    elapsed=$((elapsed + 2))
    if [[ ${elapsed} -ge ${max_wait} ]]; then return 1; fi
  done
}

dv_front_state_ok() {
  local line health
  line="$(dv_compose ps --format '{{.State}} {{.Health}}' front 2>/dev/null | head -n 1 || true)"
  DV_FRONT_STATE="${line%% *}"
  health="${line#* }"; [[ "${health}" == "${line}" ]] && health=""
  [[ "${DV_FRONT_STATE}" == "running" && "${health}" != "unhealthy" ]]
}

# ---------------------------------------------------------------------------
# Automatic rollback (deploy mode)
# ---------------------------------------------------------------------------
dv_arm() {
  DV_ARMED=1
  set -E
  trap 'dv_on_err' ERR
}

dv_disarm() {
  DV_ARMED=0
  trap - ERR
}

dv_on_err() {
  local rc=$?
  [[ "${DV_ARMED}" == "1" ]] || return 0
  [[ "${BASH_SUBSHELL:-0}" -eq 0 ]] || return 0
  err "Command failed (exit ${rc}) while switching $(dv_tag)"
  dv_abort_with_rollback
}

# Rolls back every host switched in this run (reverse order) then exits 3 (all restored) or 4 (something could not be).
# With DEPLOY_AUTO_ROLLBACK=0 (--no-auto-rollback): exit 1 and leave everything as it is (maintenance stays ON).
dv_abort_with_rollback() {
  dv_disarm
  if [[ "${DV_AUTO_ROLLBACK}" != "1" ]]; then
    err "Automatic rollback disabled (--no-auto-rollback) — leaving the failed state as is (maintenance mode stays ON on back hosts)."
    exit 1
  fi
  local failed=0 i role restore
  i=$(( ${#DV_SW_REC[@]} - 1 ))
  while [[ ${i} -ge 0 ]]; do
    dv_load_record "${i}"
    if [[ "${DV_SCOPE}" == "front" && "${DV_ROLE}" != "FRONT" ]]; then
      i=$((i - 1)); continue
    fi
    role="${DV_ROLE}"
    if [[ "${DV_SW_TAGGED[i]}" != "1" ]]; then
      err "[${role}:${DV_HOST}] No previous version to roll back to (first deploy)"
      echo "==> [${role}:${DV_HOST}] Rollback failed"
      failed=1
    elif [[ "${role}" == "BACK" ]]; then
      # The SQLite backup is restored only when the new back never served traffic (so nothing would be lost).
      restore=""
      if [[ "${IS_SQLITE_DB:-0}" -eq 1 && "${DV_SW_SERVED[i]}" != "1" ]]; then restore="${DV_SW_BACKUP[i]}"; fi
      if [[ "${DV_SW_STATE[i]}" == "1" ]]; then dv_revert_state; fi
      dv_rollback_back auto "${restore}" || failed=1
    else
      dv_rollback_front auto || failed=1
    fi
    i=$((i - 1))
  done
  if [[ "${DV_SCOPE}" == "front" ]]; then
    warn "Back hosts keep the new version (they were healthy); only the front was rolled back."
  fi
  if [[ ${failed} -eq 0 ]]; then
    echo "==> Deployment failed, previous version restored"
    exit 3
  fi
  echo "==> Deployment failed, rollback failed"
  exit 4
}
