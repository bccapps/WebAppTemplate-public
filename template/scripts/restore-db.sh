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
# restore-db.sh — Restore a compressed SQL backup into a Postgres database
# ============================================================
# Connects directly from your local machine to the database
# defined in the env file and restores the given backup via psql.
#
# Usage:
#   ./scripts/restore-db.sh <env> <backup_file>            Run restore
#   ./scripts/restore-db.sh <env> <backup_file> --pooler   Force the pooler
#   ./scripts/restore-db.sh <env> <backup_file> --force    Skip the Supabase
#                                                          schema guard
#   ./scripts/restore-db.sh --help                         Show this help
#
# Env:
#   dev      → reads back/.env.dev
#   preprod  → reads back/.env.preprod
#   prod     → reads back/.env
#
# Backup file: path to a .sql.gz file (created by backup-db.sh)
#
# Supabase:
#   Supavisor (the *.pooler.supabase.com endpoint) closes the SSL connection
#   on large data transfers. When the env file points at a pooler host, this
#   script switches to the direct endpoint db.<project-ref>.supabase.co.
#   That endpoint is IPv6-only: if it is unreachable the script warns and
#   falls back to the pooler. Use --pooler to skip the switch entirely.
#
#   The auth/storage/realtime/vault/graphql/extensions schemas belong to
#   Supabase and must never be restored — doing so breaks the project. When
#   DB_ENGINE=supabase, a backup containing DDL for those schemas is
#   rejected. Re-dump with backup-db.sh (public schema only), or pass --force
#   if you really know what you are doing.
#
# Required env vars (in the env file):
#   DB_HOST, DB_PORT, DB_USER, DB_NAME, DB_PASSWORD
#
# Optional env vars:
#   DB_SSLMODE       — SSL mode (default: disable)
#   DB_SSLROOTCERT   — path to SSL root certificate
#   DB_ENGINE  — 'supabase' enables the schema guard
#   DB_DIRECT_HOST   — override the direct (non-pooler) host
#
# Prerequisites: psql, gunzip
#
# WARNING: This will OVERWRITE the target database! A confirmation
#          prompt is shown before proceeding.
# ============================================================

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
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
  sed -n '/^# restore-db.sh/,/^SCRIPT_DIR=/p' "$0" | grep '^#' | sed 's/^# \?//'
  exit 0
fi

# ---------- Args ----------
[[ $# -lt 2 ]] && err "Usage: $0 <env> <backup_file> [--pooler] [--force]  (env: dev | preprod | prod)"
ENV="$1"
BACKUP_FILE="$2"
shift 2

FORCE_POOLER=0
FORCE_RESTORE=0
for arg in "$@"; do
  case "$arg" in
    --pooler) FORCE_POOLER=1 ;;
    --force)  FORCE_RESTORE=1 ;;
    *)        err "Unknown argument '$arg' (see --help)" ;;
  esac
done

case "$ENV" in
  dev)     ENV_FILE="./back/.env.dev" ;;
  preprod) ENV_FILE="./back/.env.preprod" ;;
  prod)    ENV_FILE="./back/.env" ;;
  *)       err "Unknown env '$ENV'. Use: dev | preprod | prod" ;;
esac

[[ ! -f "$ENV_FILE" ]]    && err "Env file not found: $ENV_FILE"
[[ ! -f "$BACKUP_FILE" ]] && err "Backup file not found: $BACKUP_FILE"

# ---------- Load env ----------
set -a
# shellcheck disable=SC1090
source "$ENV_FILE"
set +a

info "Loaded env from $ENV_FILE"
resolve_db_engine
require_postgres_engine "restore-db.sh"

# ---------- Validate ----------
for var in DB_HOST DB_PORT DB_USER DB_NAME DB_PASSWORD; do
  [[ -z "${!var:-}" ]] && err "Missing required variable: $var"
done

# ---------- Commands ----------
command -v psql   >/dev/null 2>&1 || err "psql is not installed or not in PATH"
command -v gunzip >/dev/null 2>&1 || err "gunzip is not installed or not in PATH"

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
      warn "SSL root cert '$DB_SSLROOTCERT' not found — psql may fail"
    fi
    [[ -n "${PGSSLROOTCERT:-}" ]] && info "SSL root cert: $PGSSLROOTCERT"
  fi
fi

# ---------- Supabase: prefer the direct (non-pooler) endpoint ----------
# Supavisor closes the SSL connection on large data transfers.
# db.<project-ref>.supabase.co has no such limit, but resolves to IPv6 only —
# fall back to the pooler when it cannot be reached.
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
    warn "The restore may abort: 'SSL connection has been closed unexpectedly'"
  fi
fi

# ---------- Supabase: reject backups carrying Supabase-owned schemas ----------
# auth/storage/realtime/vault/graphql/extensions belong to the platform.
# Restoring them over a live project breaks authentication and storage.
if [[ "${DB_ENGINE_NORMALIZED}" == "supabase" && "$FORCE_RESTORE" -eq 0 ]]; then
  RESERVED='auth|storage|realtime|vault|graphql|graphql_public|extensions|supabase_migrations'
  FOUND="$(gunzip -c "$BACKUP_FILE" \
    | grep -m1 -ioE "(CREATE|DROP|ALTER) SCHEMA (IF (NOT )?EXISTS )?(${RESERVED})\b" || true)"
  if [[ -n "$FOUND" ]]; then
    warn "This backup contains DDL for a Supabase-owned schema: ${FOUND}"
    warn "Restoring it would break auth/storage on the target project."
    err  "Re-dump with backup-db.sh (public schema only), or pass --force to override."
  fi
  info "Schema guard: no Supabase-owned schema in the backup"
fi

# ---------- Confirmation ----------
FILE_SIZE="$(du -h "$BACKUP_FILE" | cut -f1)"

echo ""
printf "${YELLOW}╔══════════════════════════════════════════════╗${NC}\n"
printf "${YELLOW}║           DATABASE RESTORE SUMMARY           ║${NC}\n"
printf "${YELLOW}╠══════════════════════════════════════════════╣${NC}\n"
printf "${YELLOW}║${NC} Target env:  %-31s ${YELLOW}║${NC}\n" "$ENV"
printf "${YELLOW}║${NC} Database:    %-31s ${YELLOW}║${NC}\n" "$DB_NAME"
printf "${YELLOW}║${NC} Host:        %-31s ${YELLOW}║${NC}\n" "${DB_HOST}:${DB_PORT}"
printf "${YELLOW}║${NC} User:        %-31s ${YELLOW}║${NC}\n" "$DB_USER"
printf "${YELLOW}║${NC} Backup file: %-31s ${YELLOW}║${NC}\n" "$(basename "$BACKUP_FILE")"
printf "${YELLOW}║${NC} File size:   %-31s ${YELLOW}║${NC}\n" "$FILE_SIZE"
printf "${YELLOW}╚══════════════════════════════════════════════╝${NC}\n"
echo ""
printf "${RED}⚠  This will OVERWRITE the target database!${NC}\n"
echo ""
read -rp "Type 'yes' to confirm restore: " CONFIRM
[[ "$CONFIRM" != "yes" ]] && { warn "Restore cancelled."; exit 0; }

# ---------- Restore ----------
info "Restoring $BACKUP_FILE into ${DB_NAME}@${DB_HOST}:${DB_PORT}..."

RESTORE_LOG="$(dirname "$BACKUP_FILE")/$(basename "$BACKUP_FILE" .sql.gz).restore.log"

set +e
gunzip -c "$BACKUP_FILE" | psql \
  --host="$DB_HOST" \
  --port="$DB_PORT" \
  --username="$DB_USER" \
  --dbname="$DB_NAME" \
  --quiet 2>&1 | tee "$RESTORE_LOG"
PSQL_STATUS="${PIPESTATUS[1]}"
set -e

# psql keeps going after a failed statement, so a zero exit code is not proof
# that the restore was clean — count what actually failed.
#
# Two errors are expected and harmless on a managed Postgres such as Supabase:
# the dump's --clean header tries to drop and recreate the public schema, which
# the connecting role is not allowed to do (and does not need to — the objects
# inside it were already dropped individually just before).
BENIGN='schema "public" already exists|cannot drop schema public because other objects depend on it'

TOTAL_ERRORS="$(grep -c '^ERROR:' "$RESTORE_LOG" || true)"
REAL_ERRORS="$(grep '^ERROR:' "$RESTORE_LOG" | grep -cvE "$BENIGN" || true)"
BENIGN_ERRORS="$(( TOTAL_ERRORS - REAL_ERRORS ))"

info "Log: $RESTORE_LOG"
[[ "$BENIGN_ERRORS" -gt 0 ]] && info "Ignored $BENIGN_ERRORS harmless public-schema error(s)"
[[ "$PSQL_STATUS" -ne 0 ]] && err "psql exited with status $PSQL_STATUS - restore incomplete"

if [[ "$REAL_ERRORS" -gt 0 ]]; then
  warn "Restore finished with $REAL_ERRORS error(s) - review $RESTORE_LOG"
  grep '^ERROR:' "$RESTORE_LOG" | grep -vE "$BENIGN" | head -5 | sed 's/^/    /'
  exit 1
fi

ok "Restore complete - no errors."
