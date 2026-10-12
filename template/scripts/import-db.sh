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

# Import a SQL dump file into a local Docker postgres container.
#
# Usage:
#   ./scripts/import-db.sh [--yes] [--no-drop] [--container <name>] [--db <name>] [--user <name>] [--password <pwd>] <dump.sql>

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
cd "${PROJECT_ROOT}"

usage() {
  cat <<'EOF'
Usage:
  ./scripts/import-db.sh [--yes] [--no-drop] [--container <name>] [--db <name>] [--user <name>] [--password <pwd>] <dump.sql>

Defaults:
  - Loads DB_USER / DB_PASSWORD / DB_NAME from back/.env when present
  - Auto-detects the first running postgres container if --container is not provided
  - Drops and recreates schema public before import unless --no-drop is provided
EOF
}

YES=0
NO_DROP=0
CONTAINER=""
DB_NAME=""
DB_USER=""
DB_PASSWORD=""
DUMP_FILE=""

while [ "$#" -gt 0 ]; do
  case "$1" in
    -h|--help) usage; exit 0 ;;
    -y|--yes) YES=1; shift ;;
    --no-drop) NO_DROP=1; shift ;;
    --container) CONTAINER="${2:-}"; shift 2 ;;
    --db) DB_NAME="${2:-}"; shift 2 ;;
    --user) DB_USER="${2:-}"; shift 2 ;;
    --password) DB_PASSWORD="${2:-}"; shift 2 ;;
    --) shift; break ;;
    -*) echo "Unknown option: $1" >&2; usage >&2; exit 2 ;;
    *)
      if [ -z "$DUMP_FILE" ]; then DUMP_FILE="$1"; shift
      else echo "Unexpected argument: $1" >&2; usage >&2; exit 2; fi
      ;;
  esac
done

if [ -z "$DUMP_FILE" ]; then echo "Missing dump file (.sql)" >&2; usage >&2; exit 2; fi
if [ ! -f "$DUMP_FILE" ]; then echo "Dump file not found: $DUMP_FILE" >&2; exit 2; fi

# Load env from back/.env
if [ -f ./back/.env ]; then
  set -a; . ./back/.env; set +a
fi

DB_NAME="${DB_NAME:-${DB_NAME:-postgres}}"
DB_USER="${DB_USER:-${DB_USER:-postgres}}"
DB_PASSWORD="${DB_PASSWORD:-}"

if [ -z "$CONTAINER" ]; then
  CONTAINER="$(docker ps --format '{{.Names}}\t{{.Image}}' | awk '$2 ~ /^postgres([:-]|$)/ {print $1; exit}')"
fi

if [ -z "$CONTAINER" ]; then
  echo "Unable to auto-detect a postgres container. Provide one with --container <name>." >&2
  exit 2
fi

if ! docker ps --format '{{.Names}}' | grep -qx "$CONTAINER"; then
  echo "Container not running or not found: $CONTAINER" >&2
  exit 2
fi

if [ "$YES" -ne 1 ] && [ "$NO_DROP" -ne 1 ]; then
  echo "About to DROP SCHEMA public and import '$DUMP_FILE' into:"
  echo "  container: $CONTAINER"
  echo "  db:        $DB_NAME"
  echo "  user:      $DB_USER"
  read -r -p "Continue? (y/N) " answer
  case "${answer}" in y|Y|yes|YES) ;; *) echo "Aborted."; exit 1 ;; esac
fi

DOCKER_ENV_ARGS=()
[ -n "$DB_PASSWORD" ] && DOCKER_ENV_ARGS+=( -e "PGPASSWORD=$DB_PASSWORD" )

if [ "$NO_DROP" -ne 1 ]; then
  docker exec "${DOCKER_ENV_ARGS[@]}" -i "$CONTAINER" psql -U "$DB_USER" -d "$DB_NAME" -v ON_ERROR_STOP=1 \
    -c "DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public;"
fi

docker exec "${DOCKER_ENV_ARGS[@]}" -i "$CONTAINER" psql -U "$DB_USER" -d "$DB_NAME" -v ON_ERROR_STOP=1 < "$DUMP_FILE"

echo "Import complete."
