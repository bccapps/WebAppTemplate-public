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
# restart.sh — Restart services without rebuild
# ============================================================
#
# Usage:
#   ./scripts/restart.sh dev      Restart local Docker infra (postgres, redis)
#   ./scripts/restart.sh preprod  SSH to preprod hosts, restart containers
#   ./scripts/restart.sh prod     SSH to prod hosts, restart containers
#
# Options (preprod / prod only):
#   --back-only    Restart back containers only (skip front)
#   --front-only   Restart front containers only (skip back)
#
# Required env vars (from back/.env or back/.env.preprod):
#   PROJECT_NAME, BACK_HOSTS, REMOTE_USER, REMOTE_SSH_PORT, SSH_KEY_FILE
# ============================================================

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
cd "${PROJECT_ROOT}"

# ---------- Colours ----------
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; CYAN='\033[0;36m'; NC='\033[0m'
info()  { printf "${CYAN}==> %s${NC}\n" "$*"; }
ok()    { printf "${GREEN}==> %s${NC}\n" "$*"; }
warn()  { printf "${YELLOW}==> %s${NC}\n" "$*"; }
err()   { printf "${RED}==> %s${NC}\n" "$*" >&2; exit 1; }

# ---------- Args ----------
if [[ $# -lt 1 || "${1:-}" == "--help" || "${1:-}" == "-h" ]]; then
  sed -n '/^# Usage:/,/^# =====/p' "$0" | grep '^#' | sed 's/^# \?//'
  exit 0
fi

ENV="$1"; shift
BACK_ONLY=0
FRONT_ONLY=0
for arg in "$@"; do
  case "${arg}" in
    --back-only)  BACK_ONLY=1 ;;
    --front-only) FRONT_ONLY=1 ;;
  esac
done

# ---------- Env loading ----------
load_env() {
  local file="$1"
  [[ -f "${file}" ]] || err "Env file not found: ${file}"
  set -a; source "${file}"; set +a
}

# ---------- SSH helper ----------
parse_hosts() {
  local raw="$1"
  echo "${raw}" | tr ',' '\n' | awk '{$1=$1};1' | grep -v '^$'
}

resolve_key_path() {
  local key_file="$1"
  [[ -z "${key_file}" ]] && return
  [[ -f "${key_file}" ]] && { printf '%s' "${key_file}"; return; }
  [[ -f "${HOME}/.ssh/${key_file}" ]] && { printf '%s' "${HOME}/.ssh/${key_file}"; return; }
  err "SSH key not found: ${key_file}"
}

restart_remote() {
  local env_file="$1"
  shift
  local -a compose_services=("$@")

  load_env "${env_file}"

  local proj="${PROJECT_NAME:?PROJECT_NAME required}"
  local ssh_port="${REMOTE_SSH_PORT:-22}"
  local ssh_user="${REMOTE_USER:-ubuntu}"
  local ssh_key="${SSH_KEY_FILE:-}"
  local hosts_raw="${BACK_HOSTS:-${REMOTE_HOST:-}}"
  local context_base="${REMOTE_CONTEXT_NAME:-example-back}"

  [[ -z "${hosts_raw}" ]] && err "BACK_HOSTS is not set in ${env_file}"

  # Determine compose file — mirrors deploy-full.sh logic exactly
  local db_engine
  db_engine="$(echo "${DATABASE_ENGINE:-postgres}" | tr '[:upper:]' '[:lower:]')"
  local compose_file
  if [[ "${db_engine}" == "postgres" || "${db_engine}" == "selfhosted" ]]; then
    compose_file="${COMPOSE_FILE_NAME:-scripts/docker-compose.yml}"
  else
    compose_file="${COMPOSE_FILE_NAME:-scripts/docker-compose-cloud.yml}"
  fi
  [[ ! -f "${compose_file}" ]] && err "Compose file not found: ${compose_file}"

  local key_path
  key_path="$(resolve_key_path "${ssh_key}")"

  while IFS= read -r raw_entry; do
    local host="${raw_entry##*@}"
    local user="${ssh_user}"
    [[ "${raw_entry}" == *"@"* ]] && user="${raw_entry%%@*}"
    local ssh_target="${user}@${host}"

    # Project name: same convention as deploy-full.sh ({proj}-back-{sanitized_host})
    local sanitized_host
    sanitized_host="$(echo "${host}" | tr '[:upper:]' '[:lower:]' | sed 's/[^a-z0-9]/-/g')"
    local context_name="${context_base}-${sanitized_host}"
    local project_name
    project_name="$(echo "${proj}-back-${sanitized_host}" | tr '[:upper:]' '[:lower:]')"

    local docker_ssh_command="ssh -p ${ssh_port}"
    [[ -n "${key_path}" ]] && docker_ssh_command="ssh -i ${key_path} -p ${ssh_port}"

    info "[${host}] Connecting... (project: ${project_name})"

    if ! docker context inspect "${context_name}" >/dev/null 2>&1; then
      info "[${host}] Creating docker context ${context_name}"
      docker context create "${context_name}" \
        --docker "host=ssh://${ssh_target}:${ssh_port}" >/dev/null
    else
      docker context update "${context_name}" \
        --docker "host=ssh://${ssh_target}:${ssh_port}" >/dev/null 2>&1 || true
    fi

    local -a compose_base=(
      "--context" "${context_name}"
      "compose"
      "-f" "${compose_file}"
      "--project-name" "${project_name}"
    )

    # Filter services by --back-only / --front-only
    local -a svcs=()
    for svc in "${compose_services[@]}"; do
      case "${svc}" in
        back|back-worker|back-lb) [[ ${FRONT_ONLY} -eq 0 ]] && svcs+=("${svc}") ;;
        front)                    [[ ${BACK_ONLY}  -eq 0 ]] && svcs+=("${svc}") ;;
        *)                        svcs+=("${svc}") ;;
      esac
    done

    [[ ${#svcs[@]} -eq 0 ]] && { warn "[${host}] No services to start after filtering"; continue; }

    info "[${host}] Stopping services: ${svcs[*]}"
    DOCKER_SSH_COMMAND="${docker_ssh_command}" \
      docker "${compose_base[@]}" rm -sf "${svcs[@]}" 2>/dev/null || true

    info "[${host}] Starting services: ${svcs[*]}"
    DOCKER_SSH_COMMAND="${docker_ssh_command}" \
      docker "${compose_base[@]}" up -d --no-build "${svcs[@]}"

    ok "[${host}] Services up: ${svcs[*]}"

  done < <(parse_hosts "${hosts_raw}")
}

# ---------- Main ----------
case "${ENV}" in
  dev)
    load_env "./back/.env.dev"
    local_proj="$(echo "${PROJECT_NAME:-$(basename "${PROJECT_ROOT}")}-dev" | tr '[:upper:]' '[:lower:]')"
    info "Restarting dev infra containers..."
    docker compose -p "${local_proj}" --env-file ./back/.env.dev \
      -f scripts/docker-compose-dev.yml \
      --profile localdb --profile redis \
      restart 2>/dev/null || true
    ok "Dev infra restarted"
    warn "NestJS / Vite run as local processes — restart them manually (Ctrl+C + run.sh dev)"
    ;;

  preprod)
    _front_env="./front/.env.preprod"
    [[ ! -f "${_front_env}" ]] && _front_env="./front/.env"
    [[ -f "${_front_env}" ]] && { set -a; source "${_front_env}"; set +a; }
    restart_remote "./back/.env.preprod" back back-worker back-lb front
    ;;

  prod)
    [[ -f "./front/.env" ]] && { set -a; source "./front/.env"; set +a; }
    restart_remote "./back/.env" back back-worker back-lb front
    ;;

  *)
    err "Unknown env '${ENV}'. Use: dev | preprod | prod"
    ;;
esac
