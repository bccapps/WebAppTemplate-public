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

# Copy databases between postgres instances.
#
# Usage:
#   ./scripts/copy-db.sh stream <source_uri> <target_uri> [table_name]
#   ./scripts/copy-db.sh dump   <source_uri> <output_dump.gz> [table_name]
#   ./scripts/copy-db.sh restore <dump_file.gz> <target_uri> [table_name]

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
cd "${PROJECT_ROOT}"

# Auto-load back/.env if present so DB_SSL* vars are available
ENV_FILE="./back/.env"
if [[ -f "${ENV_FILE}" ]]; then
  set -a
  # shellcheck disable=SC1090
  source "${ENV_FILE}"
  set +a
fi

usage() {
  cat >&2 <<'USAGE'
Usage:
  ./scripts/copy-db.sh stream <source_uri> <target_uri> [table_name]
  ./scripts/copy-db.sh dump <source_uri> <output_dump.gz> [table_name]
  ./scripts/copy-db.sh restore <dump_file.gz> <target_uri> [table_name]

Modes:
  stream   - pg_dump | psql streaming copy between two live hosts
  dump     - pg_dump custom-format backup from <source_uri> into <output_dump.gz>
  restore  - restore compressed custom-format dump into <target_uri>

Optional table_name limits operations to that specific table using pg_dump --table.
USAGE
  exit 1
}

[[ $# -lt 1 ]] && usage

MODE="$1"; shift

require_cmd() {
  command -v "$1" >/dev/null 2>&1 || { echo "Error: $1 is not installed or not in PATH" >&2; exit 2; }
}

export PGPASSWORD="${PGPASSWORD:-}"

COMMON_PGDUMP_FLAGS=(--verbose --clean --no-owner --no-privileges --if-exists)
COMMON_PGRESTORE_FLAGS=(--verbose --clean --no-owner --no-privileges --if-exists)

normalize_db_uri() {
  local raw="$1"
  if [[ "$raw" == *=postgresql://* || "$raw" == *=postgres://* ]]; then
    printf '%s\n' "${raw#*=}"
  else
    printf '%s\n' "$raw"
  fi
}

extract_uri_host() {
  require_cmd python3
  python3 - "$1" <<'PY'
import sys, urllib.parse
try:
    print(urllib.parse.urlparse(sys.argv[1]).hostname or '')
except Exception:
    print('')
PY
}

maybe_apply_ssl_params() {
  local uri="$1"
  local target_host
  target_host=$(extract_uri_host "$uri")
  local db_host_normalized="${DB_HOST:-}"
  [[ -n "$db_host_normalized" ]] && db_host_normalized=$(printf '%s' "$db_host_normalized" | tr '[:upper:]' '[:lower:]')
  local target_host_normalized="$target_host"
  [[ -n "$target_host_normalized" ]] && target_host_normalized=$(printf '%s' "$target_host_normalized" | tr '[:upper:]' '[:lower:]')

  if [[ -z "${db_host_normalized}" || -z "$target_host_normalized" || "$target_host_normalized" != "$db_host_normalized" ]]; then
    printf '%s\n' "$uri"; return
  fi

  local result="$uri" delim='?'
  [[ "$result" == *\?* ]] && delim='&'
  if [[ -n "${PGSSLMODE:-}" ]]; then result+="${delim}sslmode=${PGSSLMODE}"; delim='&'; fi
  if [[ -n "${PGSSLROOTCERT:-}" ]]; then
    local encoded_cert
    encoded_cert=$(python3 -c "import urllib.parse; print(urllib.parse.quote('${PGSSLROOTCERT}'))")
    result+="${delim}sslrootcert=${encoded_cert}"
  fi
  printf '%s\n' "$result"
}

canonicalize_ssl_mode() {
  local lower; lower=$(printf '%s' "$1" | tr '[:upper:]' '[:lower:]')
  case "$lower" in
    verify|verifyfull) printf 'verify-full\n' ;; verifyca) printf 'verify-ca\n' ;; *) printf '%s\n' "$lower" ;;
  esac
}

resolve_cert_path() {
  local input="$1"
  [[ -z "$input" ]] && return 1
  local candidates=("$input")
  [[ "$input" != /* ]] && candidates+=("./$input" "./back/$input")
  for path in "${candidates[@]}"; do
    if [[ -f "$path" ]]; then
      require_cmd python3
      python3 -c "import os,sys; print(os.path.realpath(sys.argv[1]))" "$path"
      return 0
    fi
  done
  return 1
}

setup_ssl_env() {
  if [[ -n "${DB_SSLMODE:-}" ]]; then
    export PGSSLMODE="$(canonicalize_ssl_mode "${DB_SSLMODE}")"
    echo "Using PGSSLMODE=${PGSSLMODE}" >&2
  fi
  if [[ -n "${DB_SSLROOTCERT:-}" ]]; then
    local resolved
    if resolved=$(resolve_cert_path "${DB_SSLROOTCERT}" 2>/dev/null); then
      export PGSSLROOTCERT="$resolved"
      echo "Using PGSSLROOTCERT=${PGSSLROOTCERT}" >&2
    else
      echo "Warning: DB_SSLROOTCERT '${DB_SSLROOTCERT}' not found." >&2
    fi
  fi
}

setup_ssl_env

case "$MODE" in
  stream)
    [[ $# -lt 2 || $# -gt 3 ]] && usage
    SRC_URI="$(maybe_apply_ssl_params "$(normalize_db_uri "$1")")"
    DEST_URI="$(maybe_apply_ssl_params "$(normalize_db_uri "$2")")"
    TABLE_ARGS=(); [[ -n "${3:-}" ]] && TABLE_ARGS=(--table="$3") && echo "Limiting stream to table '$3'." >&2
    require_cmd pg_dump; require_cmd psql
    echo "Starting streaming dump from source database..." >&2
    pg_dump "${COMMON_PGDUMP_FLAGS[@]}" "${TABLE_ARGS[@]+"${TABLE_ARGS[@]}"}" --dbname="$SRC_URI" | psql "$DEST_URI"
    echo "Database streaming copy completed successfully." >&2
    ;;
  dump)
    [[ $# -lt 2 || $# -gt 3 ]] && usage
    SRC_URI="$(normalize_db_uri "$1")"; OUT_FILE="$2"
    TABLE_ARGS=(); [[ -n "${3:-}" ]] && TABLE_ARGS=(--table="$3") && echo "Limiting dump to table '$3'." >&2
    require_cmd pg_dump; require_cmd gzip
    echo "Creating compressed custom-format dump to $OUT_FILE..." >&2
    pg_dump "${COMMON_PGDUMP_FLAGS[@]}" --format=custom "${TABLE_ARGS[@]+"${TABLE_ARGS[@]}"}" --dbname="$SRC_URI" | gzip -c > "$OUT_FILE"
    echo "Compressed dump created at $OUT_FILE." >&2
    ;;
  restore)
    [[ $# -lt 2 || $# -gt 3 ]] && usage
    DUMP_FILE="$1"; DEST_URI="$(normalize_db_uri "$2")"
    TABLE_ARGS=(); [[ -n "${3:-}" ]] && TABLE_ARGS=(--table="$3") && echo "Restoring limited to table '$3'." >&2
    [[ ! -f "$DUMP_FILE" ]] && { echo "Error: dump file '$DUMP_FILE' not found" >&2; exit 3; }
    require_cmd pg_restore; require_cmd gzip
    echo "Restoring compressed dump $DUMP_FILE into target database..." >&2
    gzip -dc "$DUMP_FILE" | pg_restore "${COMMON_PGRESTORE_FLAGS[@]}" "${TABLE_ARGS[@]+"${TABLE_ARGS[@]}"}" --dbname="$DEST_URI"
    echo "Restore completed successfully." >&2
    ;;
  *) usage ;;
esac
