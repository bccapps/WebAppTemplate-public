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
# Single place where the shell scripts read the database engine. SOURCED by run.sh, deploy-full.sh, restart.sh,
# stop.sh, migrate-db.sh, migrate-server.sh, backup-db.sh and restore-db.sh, after back/.env(.dev) is loaded.
#
# Same rule as nest/common/utils/dbEngine.ts: DB_ENGINE only, default `postgres`. The former DATABASE_ENGINE is
# refused (not silently ignored: a supabase project falling back to a local Postgres would be a bad surprise).
#
#   resolve_db_engine          sets DB_ENGINE_VALUE (as written), DB_ENGINE_NORMALIZED (lower case),
#                              IS_SELF_HOSTED_DB (1 = postgres/selfhosted: a Postgres container may be needed),
#                              IS_SQLITE_DB (1 = file database, no database container at all),
#                              DEFAULT_COMPOSE_FILE (docker-compose.yml with the `db` service for a self-hosted
#                              Postgres, docker-compose-cloud.yml — no `db` service — for every other engine).
#   require_postgres_engine S  exits when the engine is not a Postgres one (S = script name for the message).
#   assert_compose_matches_db_engine <compose file>
#                              exits when the engine needs no Postgres container but the compose file defines a
#                              `db` service (e.g. COMPOSE_FILE_NAME=docker-compose.yml with sqlite or supabase):
#                              `up` would start it through `depends_on`.
# =============================================================================

resolve_db_engine() {
  if [[ -n "${DATABASE_ENGINE+x}" && -z "${DB_ENGINE+x}" ]]; then
    echo "Error: DATABASE_ENGINE is no longer supported — rename it to DB_ENGINE (same values) in back/.env*." >&2
    exit 1
  fi
  DB_ENGINE_VALUE="${DB_ENGINE:-postgres}"
  DB_ENGINE_NORMALIZED="$(echo "${DB_ENGINE_VALUE}" | tr '[:upper:]' '[:lower:]')"
  IS_SELF_HOSTED_DB=0
  IS_SQLITE_DB=0
  DEFAULT_COMPOSE_FILE="scripts/docker-compose-cloud.yml"
  if [[ "${DB_ENGINE_NORMALIZED}" == "postgres" || "${DB_ENGINE_NORMALIZED}" == "selfhosted" ]]; then
    IS_SELF_HOSTED_DB=1
    DEFAULT_COMPOSE_FILE="scripts/docker-compose.yml"
  elif [[ "${DB_ENGINE_NORMALIZED}" == "sqlite" ]]; then
    IS_SQLITE_DB=1
  fi
}

require_postgres_engine() {
  local script_name="${1:-this script}"
  if [[ "${IS_SQLITE_DB}" -eq 1 ]]; then
    echo "Error: ${script_name} only handles PostgreSQL databases (DB_ENGINE=${DB_ENGINE_VALUE})." >&2
    echo "       A SQLite database is a single file (DB_PATH): copy/back it up with the file tools; the schema follows DB_SCHEMA_MODE." >&2
    exit 1
  fi
}

assert_compose_matches_db_engine() {
  local compose_file="$1"
  [[ "${IS_SELF_HOSTED_DB}" -eq 1 || ! -f "${compose_file}" ]] && return 0
  if grep -Eq '^  db:[[:space:]]*$' "${compose_file}"; then
    echo "Error: ${compose_file} defines a 'db' (Postgres) service but DB_ENGINE=${DB_ENGINE_VALUE} needs no database container." >&2
    echo "       Use ${DEFAULT_COMPOSE_FILE} (default for this engine) or unset COMPOSE_FILE_NAME." >&2
    exit 1
  fi
}
