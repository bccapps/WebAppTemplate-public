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
# stop.sh — Force-stop containers for dev / preprod / prod
# ============================================================
# Stops compose projects AND removes any leftover containers
# that may have been orphaned by interrupted runs or renamed
# compose projects.
#
# Usage:
#   ./scripts/stop.sh dev       Stop dev containers + processes
#   ./scripts/stop.sh preprod   Stop preprod containers
#   ./scripts/stop.sh prod      Stop prod containers
#   ./scripts/stop.sh all       Stop everything (default)
#   ./scripts/stop.sh --help    Show this help
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
err()   { printf "${RED}==> %s${NC}\n" "$*" >&2; }

# ---------- Helpers ----------
load_env_safe() {
  local env_file="$1"
  if [[ ! -f "${env_file}" ]]; then
    warn "Env file not found: ${env_file} (skipping)"
    return 1
  fi
  set -a
  # shellcheck disable=SC1090
  source "${env_file}"
  set +a
  return 0
}

remove_container() {
  local name="$1"
  if docker inspect "${name}" >/dev/null 2>&1; then
    info "Removing container: ${name}"
    docker rm -f "${name}" 2>/dev/null || true
  fi
}

# Remove leftover containers matching PROJECT_NAME pattern
remove_leftover_containers() {
  local project="${1:?}"
  local suffixes=("postgres" "back" "front" "redis")
  for suffix in "${suffixes[@]}"; do
    remove_container "${project}_${suffix}"
  done
  # Also catch compose-generated names (project-service-1)
  local running
  running=$(docker ps -a --format '{{.Names}}' 2>/dev/null | grep -E "^${project}[_-]" || true)
  if [[ -n "${running}" ]]; then
    while IFS= read -r cname; do
      info "Removing leftover container: ${cname}"
      docker rm -f "${cname}" 2>/dev/null || true
    done <<< "${running}"
  fi
}

kill_dev_processes() {
  local killed=0
  if pgrep -f "nest start --watch" >/dev/null 2>&1; then
    info "Killing nest watch processes..."
    pkill -f "nest start --watch" 2>/dev/null || true
    killed=1
  fi
  if pgrep -f "env-cmd.*nest" >/dev/null 2>&1; then
    pkill -f "env-cmd.*nest" 2>/dev/null || true
    killed=1
  fi
  if pgrep -f "vite.*--port" >/dev/null 2>&1; then
    info "Killing vite processes..."
    pkill -f "vite.*--port" 2>/dev/null || true
    killed=1
  fi
  if pgrep -f "tsx watch" >/dev/null 2>&1; then
    pkill -f "tsx watch" 2>/dev/null || true
    killed=1
  fi
  if [[ ${killed} -eq 1 ]]; then
    sleep 1
  fi
}

# ============================================================
# STOP MODES
# ============================================================
stop_dev() {
  info "Stopping dev environment..."

  # Force local Docker for dev
  export DOCKER_HOST="unix://$HOME/.docker/run/docker.sock"

  # Load env for PROJECT_NAME
  load_env_safe "./back/.env.dev" || load_env_safe "./back/.env" || true
  local project="${PROJECT_NAME:-app}"
  local compose_project
  compose_project="$(echo "${project}-dev" | tr '[:upper:]' '[:lower:]')"

  # Stop compose. Always pass both profiles so profile-gated services
  # (db under 'localdb', redis under 'redis') are explicitly included.
  # Compose silently ignores profiles whose services have no running container.
  if [[ -f "scripts/docker-compose-dev.yml" ]]; then
    docker compose -p "${compose_project}" --env-file ./back/.env.dev -f scripts/docker-compose-dev.yml \
      --profile localdb --profile redis down --remove-orphans 2>/dev/null || true
  fi

  # Kill dev processes (nest, vite)
  kill_dev_processes

  # Remove any leftover containers
  remove_leftover_containers "${project}"

  ok "Dev environment stopped"
}

stop_preprod() {
  info "Stopping preprod environment..."

  load_env_safe "./back/.env.preprod" || load_env_safe "./back/.env" || true
  local project="${PROJECT_NAME:-app}"

  # Stop compose (try multiple project name patterns)
  if [[ -f "scripts/docker-compose-preprod.yml" ]]; then
    docker compose -p "${project}_preprod" -f scripts/docker-compose-preprod.yml down --remove-orphans 2>/dev/null || true
  fi

  # Remove leftover containers
  remove_leftover_containers "${project}_preprod"
  # Also check base project name with preprod suffix
  remove_leftover_containers "${project}-preprod"

  ok "Preprod environment stopped"
}

sanitize_identifier() {
  echo "$1" | tr '[:upper:]' '[:lower:]' | sed 's/[^a-z0-9]/-/g'
}

# stop_remote_host <compose_file> <project_name> <context_name> <ssh_target> <ssh_port> [key_path]
stop_remote_host() {
  local compose_file="$1"
  local project_name="$2"
  local context_name="$3"
  local ssh_target="$4"
  local ssh_port="$5"
  local key_path="${6:-}"

  info "Stopping remote host ${ssh_target} (project: ${project_name})..."

  local desired_host="ssh://${ssh_target}:${ssh_port}"
  local docker_args=("--host" "${desired_host}")
  if [[ -n "${key_path}" ]]; then
    export GIT_SSH_COMMAND="ssh -i ${key_path} -p ${ssh_port}"
    docker_args=("--host" "ssh://${ssh_target}:${ssh_port}")
  fi

  # Ensure docker context exists
  if ! docker context inspect "${context_name}" >/dev/null 2>&1; then
    docker context create "${context_name}" --docker "host=ssh://${ssh_target}:${ssh_port}" >/dev/null 2>&1 || true
  else
    docker context update "${context_name}" --docker "host=ssh://${ssh_target}:${ssh_port}" >/dev/null 2>&1 || true
  fi

  local ssh_cmd="ssh -p ${ssh_port} -o StrictHostKeyChecking=no"
  if [[ -n "${key_path}" ]]; then
    ssh_cmd="ssh -i ${key_path} -p ${ssh_port} -o StrictHostKeyChecking=no"
  fi

  # Pass --env-file so YAML interpolations (${PROJECT_NAME}, ${DB_PORT}, ${VITE_PORT}, …)
  # resolve correctly during parsing — otherwise compose warns and may misparse
  # things like `'${DB_PORT}:5432'` → `':5432'`.
  local -a compose_args=("-p" "${project_name}" "-f" "${compose_file}")
  [[ -f "./back/.env" ]] && compose_args+=("--env-file" "./back/.env")

  DOCKER_HOST="ssh://${ssh_target}:${ssh_port}" \
    GIT_SSH_COMMAND="${ssh_cmd}" \
    docker --context "${context_name}" compose \
      "${compose_args[@]}" \
      down --remove-orphans 2>/dev/null || true

  # Also remove any leftover containers matching project prefix
  local running
  running=$(DOCKER_HOST="ssh://${ssh_target}:${ssh_port}" \
    GIT_SSH_COMMAND="${ssh_cmd}" \
    docker --context "${context_name}" ps -a --format '{{.Names}}' 2>/dev/null \
    | grep -E "^${project_name}[_-]" || true)
  if [[ -n "${running}" ]]; then
    while IFS= read -r cname; do
      info "Removing leftover container on ${ssh_target}: ${cname}"
      DOCKER_HOST="ssh://${ssh_target}:${ssh_port}" \
        GIT_SSH_COMMAND="${ssh_cmd}" \
        docker --context "${context_name}" rm -f "${cname}" 2>/dev/null || true
    done <<< "${running}"
  fi
}

stop_prod() {
  info "Stopping prod environment..."

  load_env_safe "./back/.env" || true
  local project="${PROJECT_NAME:-app}"

  # Determine compose file (same logic as deploy-full.sh)
  resolve_db_engine
  local compose_file="${DEFAULT_COMPOSE_FILE}"
  if [[ ! -f "${compose_file}" ]]; then
    # fallback: try both
    for f in scripts/docker-compose.yml scripts/docker-compose-cloud.yml; do
      [[ -f "${f}" ]] && compose_file="${f}" && break
    done
  fi

  # Load SSH config from env (same vars as deploy-full.sh)
  local back_user="${BACK_REMOTE_USER:-${REMOTE_USER:-ubuntu}}"
  local back_ssh_port="${BACK_SSH_PORT:-${REMOTE_SSH_PORT:-22}}"
  local back_key="${BACK_SSH_KEY_FILE:-${SSH_KEY_FILE:-}}"
  local back_context="${BACK_CONTEXT_NAME:-${REMOTE_CONTEXT_NAME:-${project}-back}}"
  local back_hosts_raw="${BACK_HOSTS:-${BACK_REMOTE_HOST:-${REMOTE_HOST:-}}}"

  local front_user="${FRONT_REMOTE_USER:-${REMOTE_USER:-ubuntu}}"
  local front_ssh_port="${FRONT_SSH_PORT:-${REMOTE_SSH_PORT:-22}}"
  local front_key="${FRONT_SSH_KEY_FILE:-${SSH_KEY_FILE:-}}"
  local front_context="${FRONT_CONTEXT_NAME:-${REMOTE_CONTEXT_NAME:-${project}-front}}"
  local front_hosts_raw="${FRONT_HOSTS:-${FRONT_REMOTE_HOST:-${REMOTE_HOST:-}}}"

  # Track back host names so we can detect colocated front hosts
  local -a back_host_names=()

  # Stop back hosts
  if [[ -n "${back_hosts_raw}" ]]; then
    IFS=',' read -ra back_hosts <<< "${back_hosts_raw}"
    for entry in "${back_hosts[@]}"; do
      entry="${entry// /}"
      [[ -z "${entry}" ]] && continue
      local b_user="${back_user}"
      local b_host="${entry}"
      if [[ "${entry}" == *"@"* ]]; then
        b_user="${entry%@*}"
        b_host="${entry#*@}"
      fi
      back_host_names+=("${b_host}")
      local suffix
      suffix="$(sanitize_identifier "${b_host}")"
      local proj_name="${project}-back-${suffix}"
      local ctx_name
      ctx_name="$(echo "${back_context}-${suffix}" | tr '[:upper:]' '[:lower:]')"
      stop_remote_host "${compose_file}" "${proj_name}" "${ctx_name}" "${b_user}@${b_host}" "${back_ssh_port}" "${back_key}"
    done
  else
    # Fallback: try local docker (legacy behaviour)
    warn "No BACK_HOSTS set — trying local Docker fallback"
    for cf in scripts/docker-compose.yml scripts/docker-compose-cloud.yml; do
      [[ -f "${cf}" ]] || continue
      docker compose -f "${cf}" down --remove-orphans 2>/dev/null || true
      docker compose -p "${project}" -f "${cf}" down --remove-orphans 2>/dev/null || true
    done
    remove_leftover_containers "${project}"
    remove_leftover_containers "${project}-back"
  fi

  # Stop front hosts (only if cloud front is NOT used)
  local vite_api_url=""
  [[ -f "./front/.env" ]] && vite_api_url=$(grep -E "^[[:space:]]*VITE_API_URL=" ./front/.env | tail -1 | sed 's/^[^=]*=//' | tr -d '"' | tr -d "'" 2>/dev/null || true)
  if [[ "${vite_api_url}" != https://* && -n "${front_hosts_raw}" ]]; then
    IFS=',' read -ra front_hosts <<< "${front_hosts_raw}"
    for entry in "${front_hosts[@]}"; do
      entry="${entry// /}"
      [[ -z "${entry}" ]] && continue
      local f_user="${front_user}"
      local f_host="${entry}"
      if [[ "${entry}" == *"@"* ]]; then
        f_user="${entry%@*}"
        f_host="${entry#*@}"
      fi
      # Skip front hosts colocated with a back host: deploy_front_host puts the
      # front service under the BACK project name in that case, so it was already
      # brought down when we stopped the back host above.
      local colocated=0
      for bname in "${back_host_names[@]}"; do
        if [[ "${bname}" == "${f_host}" ]]; then
          colocated=1
          break
        fi
      done
      if [[ ${colocated} -eq 1 ]]; then
        info "Front host ${f_host} colocated with back — already stopped, skipping"
        continue
      fi
      local suffix
      suffix="$(sanitize_identifier "${f_host}")"
      local proj_name="${project}-front-${suffix}"
      local ctx_name
      ctx_name="$(echo "${front_context}-${suffix}" | tr '[:upper:]' '[:lower:]')"
      stop_remote_host "${compose_file}" "${proj_name}" "${ctx_name}" "${f_user}@${f_host}" "${front_ssh_port}" "${front_key}"
    done
  fi

  ok "Prod environment stopped"
}

# ============================================================
# MAIN
# ============================================================
usage() {
  echo "Usage: ./scripts/stop.sh [dev|preprod|prod|all]"
  echo ""
  echo "Modes:"
  echo "  dev       Stop dev containers + kill nest/vite processes"
  echo "  preprod   Stop preprod containers"
  echo "  prod      Stop prod containers"
  echo "  all       Stop all environments (default)"
  echo ""
}

TARGET="${1:-all}"

case "${TARGET}" in
  dev)
    stop_dev
    ;;
  preprod)
    stop_preprod
    ;;
  prod)
    stop_prod
    ;;
  all)
    stop_dev
    stop_preprod
    stop_prod
    ;;
  -h|--help|help)
    usage
    ;;
  *)
    err "Unknown target: ${TARGET}. Use: dev, preprod, prod, or all"
    usage
    exit 1
    ;;
esac
