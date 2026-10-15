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
# SQLite backup / restore helpers for backup-db.sh and restore-db.sh (DB_ENGINE=sqlite). SOURCED after lib/db-engine.sh, with the
# env file already loaded and PROJECT_ROOT, info/ok/warn/err defined by the caller.
#
# A SQLite database is ONE file, written by the back process (WAL mode): copying it with `cp` while the app runs can miss pages that
# are still in the -wal file. Backups therefore use SQLite's online backup API (better-sqlite3 `.backup()`), which gives a consistent
# copy while the app keeps running. The back's own `node_modules` provide better-sqlite3 (locally in back/, remotely in the container).
#
#   sqlite_db_file                      absolute path of the LOCAL database file (DB_PATH rule of the database module)
#   sqlite_check_file <file>            integrity_check + table count of a SQLite file (prints one line, fails when not "ok")
#   sqlite_backup <env> <out>           dev: the local file; preprod/prod: the file inside the running back container over SSH
#   sqlite_restore <env> <backup>       dev only (the file is replaced, the previous one kept); remote restores are manual, see message
# =============================================================================

# One scratch directory, removed when the script exits (also when err() aborts it).
SQLITE_TMPDIR="$(mktemp -d "${TMPDIR:-/tmp}/vx-sqlite.XXXXXX")"
trap 'rm -rf "${SQLITE_TMPDIR}"' EXIT

sqlite_db_file() {
  local path="${DB_PATH:-}"
  [[ -n "${path}" ]] || err "DB_PATH is not set in the env file (DB_ENGINE=sqlite)"
  case "${path}" in
    /*) printf '%s' "${path}" ;;
    *)  printf '%s/%s' "${APP_DATA_DIR:-${PROJECT_ROOT}/back}" "${path}" ;;
  esac
}

# Runs a small script with the back's better-sqlite3.
_sqlite_node() {
  ( cd "${PROJECT_ROOT}/back" && node -e "$1" "${@:2}" )
}

sqlite_check_file() {
  _sqlite_node "
    const d = require('better-sqlite3')(process.argv[1], { readonly: true });
    const ok = d.pragma('integrity_check', { simple: true });
    const tables = d.prepare(\"select count(*) n from sqlite_master where type = 'table'\").get().n;
    console.log('integrity_check=' + ok + ', ' + tables + ' table(s)');
    process.exit(ok === 'ok' ? 0 : 1);
  " "$1"
}

# Consistent copy of a local SQLite file (online backup API), written uncompressed to <out>.
_sqlite_backup_file() {
  _sqlite_node "
    require('better-sqlite3')(process.argv[1], { readonly: true }).backup(process.argv[2]).then(() => process.exit(0), (e) => { console.error(e.message); process.exit(1); });
  " "$1" "$2"
}

# Sets SQLITE_SSH (array) and SQLITE_CONTAINER for the single back host of a remote env.
_sqlite_remote_prepare() {
  command -v ssh >/dev/null 2>&1 || err "ssh is not installed or not in PATH"
  local entry="${BACK_HOSTS:-${REMOTE_HOST:-}}"
  entry="${entry%%,*}"
  entry="${entry// /}"
  [[ -n "${entry}" ]] || err "BACK_HOSTS (or REMOTE_HOST) is not set in the env file"
  local user="${BACK_REMOTE_USER:-${REMOTE_USER:-ubuntu}}" host="${entry}"
  if [[ "${entry}" == *"@"* ]]; then user="${entry%@*}"; host="${entry#*@}"; fi
  local port="${BACK_SSH_PORT:-${REMOTE_SSH_PORT:-22}}"
  local key="${BACK_SSH_KEY_FILE:-${SSH_KEY_FILE:-}}"
  key="${key/#\~/${HOME}}"
  SQLITE_SSH=(ssh -p "${port}" -o BatchMode=yes -o ConnectTimeout=20)
  [[ -n "${key}" ]] && SQLITE_SSH+=(-i "${key}")
  SQLITE_SSH+=("${user}@${host}")
  local prefix
  prefix="$(printf '%s-back-' "${PROJECT_NAME:?PROJECT_NAME is required in the env file}" | tr '[:upper:]' '[:lower:]')"
  SQLITE_CONTAINER="$("${SQLITE_SSH[@]}" "docker ps --filter label=com.docker.compose.service=back --format '{{.Names}} {{.Label \"com.docker.compose.project\"}}'" \
    | awk -v p="${prefix}" 'index($2, p) == 1 { print $1; exit }')"
  [[ -n "${SQLITE_CONTAINER}" ]] || err "no running 'back' container of project '${prefix}*' on ${host}"
  info "Back container: ${SQLITE_CONTAINER} on ${host}"
}

# sqlite_backup <env> <out.sqlite.gz>
sqlite_backup() {
  local env_name="$1" out="$2" tmp="${SQLITE_TMPDIR}/backup.db"
  if [[ "${env_name}" == "dev" ]]; then
    local file
    file="$(sqlite_db_file)"
    [[ -f "${file}" ]] || err "SQLite file not found: ${file}"
    info "Backing up ${file} (online backup API)"
    _sqlite_backup_file "${file}" "${tmp}" || err "backup failed"
  else
    _sqlite_remote_prepare
    info "Backing up the database inside the container (online backup API)"
    "${SQLITE_SSH[@]}" "docker exec ${SQLITE_CONTAINER} node -e \"require('better-sqlite3')(process.env.DB_PATH,{readonly:true}).backup('/tmp/vx-backup.db').then(()=>process.exit(0),e=>{console.error(e.message);process.exit(1)})\"" \
      || err "backup failed inside the container"
    "${SQLITE_SSH[@]}" "docker exec ${SQLITE_CONTAINER} cat /tmp/vx-backup.db; docker exec ${SQLITE_CONTAINER} rm -f /tmp/vx-backup.db" > "${tmp}" \
      || err "could not copy the backup out of the container"
  fi
  local check
  check="$(sqlite_check_file "${tmp}")" || err "the copy is not a healthy SQLite database (${check:-unreadable})"
  mkdir -p "$(dirname "${out}")"
  gzip -c "${tmp}" > "${out}"
  ok "Backup written: ${out} ($(du -h "${out}" | cut -f1)) — ${check}"
}

# sqlite_restore <env> <backup (.sqlite.gz | .db)>
sqlite_restore() {
  local env_name="$1" backup="$2"
  if [[ "${env_name}" != "dev" ]]; then
    err "Restoring a remote SQLite database is not automated (the file is in use by the running back). By hand: stop the back and worker containers, copy the file into the sqlite_data volume as /data/${PROJECT_NAME:-<PROJECT_NAME>}.db owned by uid 1000 (docker run --rm -v <project>_sqlite_data:/data ...), start them again. See docs/sqlite-web/README.md."
  fi
  local file tmp="${SQLITE_TMPDIR}/restore.db"
  file="$(sqlite_db_file)"
  case "${backup}" in
    *.gz) gunzip -c "${backup}" > "${tmp}" ;;
    *)    cp "${backup}" "${tmp}" ;;
  esac
  local check
  check="$(sqlite_check_file "${tmp}")" || err "${backup} is not a healthy SQLite database (${check:-unreadable})"
  info "Backup: ${check}"
  warn "This REPLACES ${file}. Stop the back first. The current file is kept next to it as *.before-restore-*."
  read -rp "Type 'yes' to confirm restore: " CONFIRM
  [[ "${CONFIRM}" == "yes" ]] || err "Aborted."
  mkdir -p "$(dirname "${file}")"
  if [[ -f "${file}" ]]; then mv "${file}" "${file}.before-restore-$(date +%Y%m%d_%H%M%S)"; fi
  rm -f "${file}-wal" "${file}-shm"
  cp "${tmp}" "${file}"
  ok "Restored ${file}"
}
