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
# backup-db.sh — Backup a Postgres database to a compressed file
# ============================================================
# Connects directly from your local machine to the database
# defined in the env file and dumps it via pg_dump.
#
# Usage:
#   ./scripts/backup-db.sh <env>            Run backup
#   ./scripts/backup-db.sh <env> --pooler   Force the connection pooler
#   ./scripts/backup-db.sh --help           Show this help
#
# Env:
#   dev      → reads back/.env.dev
#   preprod  → reads back/.env.preprod
#   prod     → reads back/.env
#
# Output: ./backups/<PROJECT_NAME>_<env>_YYYY-MM-DD_HH-MM-SS.sql.gz
#
# Supabase:
#   Supavisor (the *.pooler.supabase.com endpoint) closes the SSL connection
#   on large COPY operations, so pg_dump aborts mid-table with
#   "PQgetCopyData() failed / SSL connection has been closed unexpectedly".
#   When the env file points at a pooler host, this script switches to the
#   direct endpoint db.<project-ref>.supabase.co, which has no such limit.
#   That endpoint is IPv6-only: if it is unreachable the script warns and
#   falls back to the pooler. Use --pooler to skip the switch entirely.
#
#   Supabase also owns the auth/storage/realtime/vault/graphql/extensions
#   schemas, which must never be dumped or restored. DB_ENGINE=supabase
#   therefore restricts the dump to the public schema by default.
#
# Required env vars (in the env file):
#   DB_HOST, DB_PORT, DB_USER, DB_NAME, DB_PASSWORD
#
# Optional env vars:
#   DB_SSLMODE       — SSL mode (default: disable)
#   DB_SSLROOTCERT   — path to SSL root certificate
#   DB_ENGINE  — 'supabase' restricts the dump to the public schema
#   BACKUP_SCHEMAS   — comma-separated schemas to dump (overrides the above;
#                      empty means every schema)
#   DB_DIRECT_HOST   — override the direct (non-pooler) host
#   PROJECT_NAME     — used in the output filename
#
# Prerequisites: pg_dump, psql, gzip
# ============================================================

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPT_PATH="${SCRIPT_DIR}/$(basename "${BASH_SOURCE[0]}")"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
source "${SCRIPT_DIR}/lib/db-engine.sh"
cd "${PROJECT_ROOT}"

# ---------- Colours ----------
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m'

info()  { printf "${CYAN}==> %s${NC}\n" "$*"; }
ok()    { printf "${GREEN}==> %s${NC}\n" "$*"; }
warn()  { printf "${YELLOW}==> %s${NC}\n" "$*"; }
err()   { printf "${RED}==> %s${NC}\n" "$*" >&2; exit 1; }

# ---------- Help ----------
if [[ "${1:-}" == "--help" || "${1:-}" == "-h" || "${1:-}" == "help" ]]; then
  sed -n '/^# backup-db.sh/,/^SCRIPT_DIR=/p' "$SCRIPT_PATH" | grep '^#' | sed 's/^# \?//'
  exit 0
fi

# ---------- Args ----------
[[ $# -lt 1 ]] && err "Usage: $0 <env> [--pooler]  (dev | preprod | prod)"
ENV="$1"
shift

FORCE_POOLER=0
for arg in "$@"; do
  case "$arg" in
    --pooler) FORCE_POOLER=1 ;;
    *)        err "Unknown argument '$arg' (see --help)" ;;
  esac
done

case "$ENV" in
  dev)     ENV_FILE="./back/.env.dev" ;;
  preprod) ENV_FILE="./back/.env.preprod" ;;
  prod)    ENV_FILE="./back/.env" ;;
  *)       err "Unknown env '$ENV'. Use: dev | preprod | prod" ;;
esac

[[ ! -f "$ENV_FILE" ]] && err "Env file not found: $ENV_FILE"

# ---------- Load env ----------
set -a
# shellcheck disable=SC1090
source "$ENV_FILE"
set +a

info "Loaded env from $ENV_FILE"
resolve_db_engine
require_postgres_engine "backup-db.sh"

# ---------- Validate ----------
for var in DB_HOST DB_PORT DB_USER DB_NAME DB_PASSWORD; do
  [[ -z "${!var:-}" ]] && err "Missing required variable: $var"
done

# ---------- Commands ----------
command -v pg_dump >/dev/null 2>&1 || err "pg_dump is not installed or not in PATH"
command -v psql    >/dev/null 2>&1 || err "psql is not installed or not in PATH"
command -v gzip    >/dev/null 2>&1 || err "gzip is not installed or not in PATH"

# ---------- SSL ----------
export PGPASSWORD="$DB_PASSWORD"

SSL_MODE="${DB_SSLMODE:-disable}"
if [[ "$SSL_MODE" != "disable" ]]; then
  export PGSSLMODE="$SSL_MODE"
  info "SSL mode: $PGSSLMODE"
  if [[ -n "${DB_SSLROOTCERT:-}" ]]; then
    if [[ -f "$DB_SSLROOTCERT" ]]; then
      export PGSSLROOTCERT="$(cd "$(dirname "$DB_SSLROOTCERT")" && pwd)/$(basename "$DB_SSLROOTCERT")"
    elif [[ -f "./back/$DB_SSLROOTCERT" ]]; then
      export PGSSLROOTCERT="$(cd "./back" && pwd)/$DB_SSLROOTCERT"
    else
      warn "SSL root cert '$DB_SSLROOTCERT' not found - pg_dump may fail"
    fi
    [[ -n "${PGSSLROOTCERT:-}" ]] && info "SSL root cert: $PGSSLROOTCERT"
  fi
fi

# ---------- Supabase: prefer the direct (non-pooler) endpoint ----------
# Supavisor closes the SSL connection on large COPY operations, which makes
# pg_dump fail mid-table. db.<project-ref>.supabase.co has no such limit, but
# resolves to IPv6 only — fall back to the pooler when it cannot be reached.
if [[ "$FORCE_POOLER" -eq 0 && "$DB_HOST" == *.pooler.supabase.com && "$DB_USER" == postgres.* ]]; then
  PROJECT_REF="${DB_USER#postgres.}"
  DIRECT_HOST="${DB_DIRECT_HOST:-db.${PROJECT_REF}.supabase.co}"
  if PGCONNECT_TIMEOUT=10 psql \
      --host="$DIRECT_HOST" --port="$DB_PORT" --username=postgres --dbname="$DB_NAME" \
      -qtAXc 'select 1' >/dev/null 2>&1; then
    info "Supabase pooler detected - switching to the direct endpoint $DIRECT_HOST"
    DB_HOST="$DIRECT_HOST"
    DB_USER="postgres"
  else
    warn "Direct endpoint $DIRECT_HOST unreachable (it is IPv6-only) - using the pooler"
    warn "pg_dump may abort on large tables: 'SSL connection has been closed unexpectedly'"
  fi
fi

# ---------- Output ----------
PROJECT="${PROJECT_NAME:-$(basename "$PROJECT_ROOT")}"
TIMESTAMP="$(date +%Y-%m-%d_%H-%M-%S)"
BACKUP_DIR="./backups"
BACKUP_FILE="${BACKUP_DIR}/${PROJECT}_${ENV}_${TIMESTAMP}.sql.gz"

mkdir -p "$BACKUP_DIR"

# ---------- Schemas ----------
# Supabase owns auth/storage/realtime/vault/graphql/extensions: dumping them
# produces a backup that cannot be restored into another Supabase project.
SCHEMA_ARGS=()
DEFAULT_SCHEMAS=""
[[ "${DB_ENGINE_NORMALIZED}" == "supabase" ]] && DEFAULT_SCHEMAS="public"
SCHEMAS="${BACKUP_SCHEMAS-$DEFAULT_SCHEMAS}"
if [[ -n "$SCHEMAS" ]]; then
  IFS=',' read -ra schema_list <<< "$SCHEMAS"
  for schema in "${schema_list[@]}"; do
    schema="$(echo "${schema}" | xargs)"
    if [[ -n "${schema}" ]]; then
      SCHEMA_ARGS+=("--schema=${schema}")
      info "Including schema: ${schema}"
    fi
  done
else
  info "Including all schemas"
fi

# ---------- Exclude tables ----------
EXCLUDE_ARGS=()
if [[ -n "${BACKUP_EXCLUDE_TABLES:-}" ]]; then
  IFS=',' read -ra tables <<< "${BACKUP_EXCLUDE_TABLES}"
  for table in "${tables[@]}"; do
    table="$(echo "${table}" | xargs)"
    if [[ -n "${table}" ]]; then
      EXCLUDE_ARGS+=("--exclude-table-data=${table}")
      info "Excluding table data: ${table}"
    fi
  done
fi

# ---------- Dump ----------
info "Backing up ${DB_NAME}@${DB_HOST}:${DB_PORT} (user: ${DB_USER})"
info "Output: $BACKUP_FILE"

pg_dump \
  --host="$DB_HOST" \
  --port="$DB_PORT" \
  --username="$DB_USER" \
  --dbname="$DB_NAME" \
  --verbose \
  --clean \
  --no-owner \
  --no-privileges \
  --if-exists \
  ${SCHEMA_ARGS[@]+"${SCHEMA_ARGS[@]}"} \
  ${EXCLUDE_ARGS[@]+"${EXCLUDE_ARGS[@]}"} \
  | gzip -c > "$BACKUP_FILE"

# ---------- Summary ----------
FILE_SIZE="$(du -h "$BACKUP_FILE" | cut -f1)"
ok "Backup complete!"
ok "  File: $BACKUP_FILE"
ok "  Size: $FILE_SIZE"
