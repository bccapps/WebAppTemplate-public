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
# Single place where the deploy scripts decide WHICH compose file a deployment uses. SOURCED by run.sh, deploy-full.sh,
# migrate-db.sh and restart.sh (after lib/db-engine.sh, from the project root: paths are relative to it).
#
# Two ways to pick the hardened profile (scripts/docker-compose-hardened.yml), strictly equivalent:
#   - COMPOSE_FILE_NAME=scripts/docker-compose-hardened.yml (back/.env or the environment) — the historical way;
#   - the `--harden` flag of run.sh / deploy-full.sh / migrate-db.sh / restart.sh, which sets DEPLOY_HARDEN=1 for the
#     scripts it launches.
# With the flag, the resolution NEVER falls back to the default compose file: a missing hardened file, or a
# COMPOSE_FILE_NAME naming another file, stops the script (exit 1) before anything is built, pushed or started.
# Without the flag (DEPLOY_HARDEN unset/0) and without COMPOSE_FILE_NAME nothing changes: the default file of the DB
# engine is used.
#
#   cf_harden_requested                 returns 0 when DEPLOY_HARDEN asks for the hardened profile (1|true|on|yes),
#                                       1 when it does not (unset|""|0|false|off|no); any other value exits 1.
#   assert_harden_request <name> [src]  exits 1 when the hardened file is missing, or when <name> (a COMPOSE_FILE_NAME
#                                       value, "" = unset) names another file (src = where it comes from, for the message).
#   cf_peek_env_value <env file>        prints the COMPOSE_FILE_NAME an env file would give once sourced (nothing when
#                                       absent or empty): lets run.sh refuse BEFORE the library sync.
#   harden_preflight <back env file>    run.sh: with --harden, validates the request against the env file and the
#                                       environment, then exports COMPOSE_FILE_NAME (what an older deploy-full.sh,
#                                       e.g. the one of a DEPLOY_FROM_MAIN clone, reads). No-op without the flag.
#   resolve_compose_file_path <default> sets COMPOSE_FILE_PATH (no leading ./): the hardened file under --harden, else
#                                       ${COMPOSE_FILE_NAME:-<default>} exactly as the scripts always did.
# =============================================================================

HARDENED_COMPOSE_FILE="scripts/docker-compose-hardened.yml"

cf_harden_requested() {
  local raw
  raw="$(printf '%s' "${DEPLOY_HARDEN:-}" | tr '[:upper:]' '[:lower:]')"
  case "${raw}" in
    1|true|on|yes) return 0 ;;
    ""|0|false|off|no) return 1 ;;
    *)
      echo "Error: DEPLOY_HARDEN='${DEPLOY_HARDEN}' is not valid (expected 1|0, also true|false|on|off|yes|no); use the --harden flag or unset it." >&2
      exit 1
      ;;
  esac
}

assert_harden_request() {
  local name="${1:-}" src="${2:-COMPOSE_FILE_NAME}"
  if [[ -n "${name}" && "${name#./}" != "${HARDENED_COMPOSE_FILE}" ]]; then
    echo "Error: --harden selects ${HARDENED_COMPOSE_FILE} but ${src} already sets COMPOSE_FILE_NAME=${name}." >&2
    echo "       Remove one of the two (COMPOSE_FILE_NAME=${HARDENED_COMPOSE_FILE} is equivalent to --harden); nothing was deployed." >&2
    exit 1
  fi
  if [[ ! -f "${HARDENED_COMPOSE_FILE}" ]]; then
    echo "Error: --harden needs ${HARDENED_COMPOSE_FILE} (relative to the project root $(pwd)) and it does not exist." >&2
    echo "       Not falling back to the default compose file; update the scripts/ library or drop --harden." >&2
    exit 1
  fi
}

cf_peek_env_value() {
  local file="$1"
  [[ -f "${file}" ]] || return 0
  { grep -E '^[[:space:]]*(export[[:space:]]+)?COMPOSE_FILE_NAME=' "${file}" 2>/dev/null || true; } \
    | tail -1 | cut -d'=' -f2- \
    | sed -E 's/[[:space:]]+#.*$//; s/^[[:space:]]+//; s/[[:space:]]+$//' \
    | tr -d $'"\''
}

harden_preflight() {
  cf_harden_requested || return 0
  local name="${COMPOSE_FILE_NAME:-}" src="the environment" from_file
  from_file="$(cf_peek_env_value "$1")"
  if [[ -n "${from_file}" ]]; then
    name="${from_file}"
    src="$1"
  fi
  assert_harden_request "${name}" "${src}"
  export DEPLOY_HARDEN=1
  export COMPOSE_FILE_NAME="${HARDENED_COMPOSE_FILE}"
}

resolve_compose_file_path() {
  if cf_harden_requested; then
    assert_harden_request "${COMPOSE_FILE_NAME:-}" "COMPOSE_FILE_NAME"
    COMPOSE_FILE_PATH="${HARDENED_COMPOSE_FILE}"
    export COMPOSE_FILE_NAME="${HARDENED_COMPOSE_FILE}"
    return 0
  fi
  COMPOSE_FILE_PATH="${COMPOSE_FILE_NAME:-$1}"
  COMPOSE_FILE_PATH="${COMPOSE_FILE_PATH#./}"
}
