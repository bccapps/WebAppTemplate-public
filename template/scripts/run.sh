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
# run.sh — Unified launcher for dev / preprod / prod
# ============================================================
# Designed to live in a shared scripts/ directory (symlinked from
# each project). Resolves PROJECT_ROOT as the parent of scripts/.
#
# Usage:
#   ./scripts/run.sh dev              Start infra + back + front
#   ./scripts/run.sh --trace-deprecation   Same as `dev`, with the back started under `node --trace-deprecation`
#                                     (full stack of every deprecation warning); also accepted after any
#                                     command, e.g. `dev --trace-deprecation` (only `dev` starts a local back)
#   ./scripts/run.sh dev --infra-only Start only infra containers
#                                     (dev also starts scripts-local/dev-services.sh when
#                                     present and executable — DEV_SERVICES_HOOK, opt-in)
#   ./scripts/run.sh preprod          Deploy to preprod (uses .env.preprod)
#   ./scripts/run.sh preprod --migrate   Also run DB migrations before deploying
#   ./scripts/run.sh prod             Run deploy-remote.sh
#   ./scripts/run.sh prod --migrate   Also run DB migrations before deploying
#   ./scripts/run.sh stop [dev|preprod|all]
#   ./scripts/run.sh status
#
# DB migrations (migrate-db.sh) are NEVER run unless --migrate is passed
# explicitly, and are auto-skipped even then if the target env file sets
# DB_SCHEMA_MODE=sync (the explicit schema mode, which wins when present) or, without
# DB_SCHEMA_MODE, has TYPEORM_SYNC (or SYNC) set to true — synchronize already keeps the schema
# up to date there, so running migrations on top of it is redundant and
# unsafe (TypeORM's synchronize doesn't understand native table partitioning
# etc.; mixing the two on the same run is asking for a bad interaction).
# Set DB_SCHEMA_MODE=migrations (or manual) — legacy: TYPEORM_SYNC=false — in that env
# file first if migrations should be the authoritative way schema changes reach that target.
# ============================================================

# Resolve project root (parent of scripts/)
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
require_env_file() {
  if [[ ! -f "$1" ]]; then
    err "Missing env file: $1"
    exit 1
  fi
}

load_env() {
  local env_file="$1"
  require_env_file "${env_file}"
  set -a
  # shellcheck disable=SC1090
  source "${env_file}"
  set +a
}

wait_for_postgres() {
  local container="$1"
  local max_wait=30
  local elapsed=0
  info "Waiting for postgres (${container}) to be ready..."
  while ! docker exec "${container}" pg_isready -q 2>/dev/null; do
    sleep 1
    elapsed=$((elapsed + 1))
    if [[ ${elapsed} -ge ${max_wait} ]]; then
      err "Postgres did not become ready within ${max_wait}s"
      exit 1
    fi
  done
  ok "Postgres is ready (${elapsed}s)"
}

resolve_realpath() {
  python3 - "$1" <<'PY'
import os, sys
print(os.path.realpath(sys.argv[1]))
PY
}

# Keep .repo-map.md (CLAUDE.md §9) fresh: regenerate it when scripts/repo_map.py
# says it is stale or missing. Best effort — never blocks a launch. Bytecode
# writing is off so the shared scripts/ directory does not get a __pycache__.
ensure_repo_map() {
  local script="${SCRIPT_DIR}/repo_map.py"
  [[ -f "${script}" ]] || return 0
  if ! command -v python3 >/dev/null 2>&1; then
    warn "python3 not found — skipping repo map check"
    return 0
  fi
  if PYTHONDONTWRITEBYTECODE=1 python3 "${script}" "${PROJECT_ROOT}" --check >/dev/null 2>&1; then
    return 0
  fi
  info "Repo map is stale — regenerating..."
  PYTHONDONTWRITEBYTECODE=1 python3 "${script}" "${PROJECT_ROOT}" --save --stats >/dev/null 2>&1 \
    || warn "Repo map generation failed — continuing anyway"
}

# Point at the local Docker socket if the daemon is already reachable.
# Clears any inherited DOCKER_HOST (e.g. ssh:// from user's shell). Never
# launches Docker Desktop — safe to call unconditionally, even when local
# containers turn out not to be needed. Returns 1 if no local daemon responds.
resolve_local_docker_host() {
  unset DOCKER_HOST

  local _sock=""
  for _s in "$HOME/.docker/run/docker.sock" "/var/run/docker.sock"; do
    if [[ -S "$_s" ]]; then _sock="$_s"; break; fi
  done

  if [[ -n "$_sock" ]] && DOCKER_HOST="unix://$_sock" docker info >/dev/null 2>&1; then
    export DOCKER_HOST="unix://$_sock"
    return 0
  fi

  return 1
}

# Ensure local Docker daemon is reachable. If not already up, tries to start
# Docker Desktop (macOS only) and waits up to 60 s. Only call this when local
# containers are actually required — it launches Docker Desktop as a side
# effect, which callers that merely want to *probe* should avoid.
ensure_local_docker() {
  resolve_local_docker_host && return 0

  # Daemon not responding — try to start Docker Desktop on macOS
  if [[ "$(uname -s)" == "Darwin" ]] && [[ -d "/Applications/Docker.app" ]]; then
    warn "Docker daemon not running — starting Docker Desktop..."
    open --background -a Docker
    local _elapsed=0
    while [[ $_elapsed -lt 60 ]]; do
      sleep 2
      _elapsed=$((_elapsed + 2))
      if resolve_local_docker_host; then
        # Extra wait: Docker Desktop may still be initializing networking after daemon responds
        info "Docker Desktop ready (${_elapsed}s) — waiting for full init..."
        sleep 5
        ok "Docker Desktop fully ready"
        return 0
      fi
    done
  fi

  err "Docker daemon not accessible. Please start Docker Desktop and retry."
  exit 1
}

# ============================================================
# DEV MODE
# ============================================================
cmd_dev() {
  local infra_only=0
  if [[ "${1:-}" == "--infra-only" ]]; then
    infra_only=1
  fi

  info "Syncing shared libraries..."
  "${SCRIPT_DIR}/update_common.sh" || warn "Common library sync had issues — continuing anyway"
  ensure_repo_map

  # Ensure dependencies are installed
  if [[ ! -d "./back/node_modules" ]]; then
    info "Installing backend dependencies..."
    (cd back && npm install)
  fi
  if [[ ! -d "./front/node_modules" ]]; then
    info "Installing frontend dependencies..."
    (cd front && npm install)
  fi

  load_env "./back/.env.dev"

  local back_port="${NODE_PORT:-6101}"
  local front_port="${FRONT_PORT:-6100}"
  local compose_project
  compose_project="$(echo "${PROJECT_NAME:-$(basename "${PROJECT_ROOT}")}-dev" | tr '[:upper:]' '[:lower:]')"

  # Activate profiles based on env config
  local compose_profiles=""
  local db_engine
  resolve_db_engine
  db_engine="${DB_ENGINE_NORMALIZED}"
  local needs_local_db=0
  if [[ "${db_engine}" =~ ^(postgres|selfhosted)$ && "${DB_HOST:-localhost}" =~ ^(localhost|127\.|0\.0\.0\.0|db$|postgres$|${PROJECT_NAME}) ]]; then
    compose_profiles="--profile localdb"
    needs_local_db=1
  fi
  if [[ -n "${REDIS_URL:-}" ]]; then
    compose_profiles="${compose_profiles} --profile redis"
  fi

  # SQLite is an in-process file database: no Docker at all unless Redis is requested (REDIS_URL).
  local uses_docker=1
  if [[ "${db_engine}" == "sqlite" && -z "${REDIS_URL:-}" ]]; then
    uses_docker=0
  fi

  if [[ ${uses_docker} -eq 1 ]]; then
    # Point at the local Docker socket if already reachable (clears any inherited
    # ssh:// DOCKER_HOST). Does NOT launch Docker Desktop — that only happens
    # below, and only if local containers (--profile localdb/redis) are needed.
    resolve_local_docker_host || true

    info "Stopping any existing dev containers..."
    docker compose -p "${compose_project}" --env-file ./back/.env.dev -f scripts/docker-compose-dev.yml --profile localdb --profile redis down --remove-orphans 2>/dev/null || true

    # Remove leftover containers with fixed container_name from other compose projects
    for cname in "${PROJECT_NAME}_postgres" "${PROJECT_NAME}_back" "${PROJECT_NAME}_front"; do
      if docker inspect "${cname}" >/dev/null 2>&1; then
        warn "Removing leftover container: ${cname}"
        docker rm -f "${cname}" 2>/dev/null || true
      fi
    done
  fi

  # Kill any leftover processes from a previous run (scoped to this project)
  pkill -f "${PROJECT_ROOT}/back/.*nest" 2>/dev/null || true
  pkill -f "${PROJECT_ROOT}/back/.*node.*dist/main" 2>/dev/null || true
  pkill -f "${PROJECT_ROOT}/front/.*vite" 2>/dev/null || true

  # Ensure ports are free (kill any process holding them, then wait for OS to release)
  for port in "${back_port}" "${front_port}"; do
    local pid_on_port
    pid_on_port=$(lsof -ti ":${port}" -sTCP:LISTEN 2>/dev/null || true)
    if [[ -n "${pid_on_port}" ]]; then
      warn "Killing leftover process on port ${port} (PID ${pid_on_port})"
      kill -9 ${pid_on_port} 2>/dev/null || true
    fi
  done
  # Wait for ports to be actually released (SIGKILL is immediate but the OS socket
  # lingers briefly; nest start --watch crashes on EADDRINUSE if we start too early)
  for port in "${back_port}" "${front_port}"; do
    local _wait=0
    while lsof -ti ":${port}" -sTCP:LISTEN >/dev/null 2>&1; do
      _wait=$((_wait + 1))
      if [[ $_wait -ge 10 ]]; then
        warn "Port ${port} still in use after 10s — continuing anyway"
        break
      fi
      sleep 1
    done
  done

  if [[ -n "${compose_profiles}" ]]; then
    info "Starting dev infrastructure..."
    # Local containers are actually needed here — launch Docker Desktop if necessary.
    ensure_local_docker
    local _up_attempts=0
    until docker compose -p "${compose_project}" --env-file ./back/.env.dev -f scripts/docker-compose-dev.yml ${compose_profiles} up -d; do
      _up_attempts=$((_up_attempts + 1))
      if [[ $_up_attempts -ge 3 ]]; then
        err "docker compose up failed after ${_up_attempts} attempts — is Docker Desktop running?"
        exit 1
      fi
      warn "docker compose up failed (attempt ${_up_attempts}/3), retrying in 5s..."
      sleep 5
      ensure_local_docker
    done
  else
    info "No local infrastructure needed, skipping containers"
  fi

  if [[ "${db_engine}" == "sqlite" ]]; then
    ok "Using SQLite (${DB_PATH:-data/${PROJECT_NAME}.db}), no database container"
  elif [[ ${needs_local_db} -eq 1 ]]; then
    local pg_container="${PROJECT_NAME}_postgres"
    wait_for_postgres "${pg_container}"
  else
    ok "Using remote database (${DB_HOST}:${DB_PORT}), skipping local Postgres"
  fi

  if [[ ${infra_only} -eq 1 && ${uses_docker} -eq 0 ]]; then
    ok "Nothing to start: SQLite runs inside the back process and Redis is not configured (--infra-only has no effect)"
    return
  fi

  if [[ ${infra_only} -eq 1 ]]; then
    ok "Infrastructure is running (infra-only mode)"
    echo ""
    if [[ "${db_engine}" == "sqlite" ]]; then
      echo "  SQLite   : ${DB_PATH:-data/${PROJECT_NAME}.db} (file, no container)"
    elif [[ ${needs_local_db} -eq 1 ]]; then
      echo "  Postgres : localhost:${DB_PORT}"
    else
      echo "  Postgres : ${DB_HOST}:${DB_PORT} (remote)"
    fi
    if docker ps --format '{{.Names}}' | grep -q "${PROJECT_NAME}_redis"; then
      echo "  Redis    : localhost:${REDIS_PORT:-6379}"
    fi
    echo ""
    return
  fi

  back_pid=0
  front_pid=0
  extra_pid=0
  shutting_down=0
  # Copied out of the function-local scope: cleanup_dev also runs from the EXIT
  # trap, which fires AFTER this function has returned and its locals are gone
  # (under `set -u` that is an "unbound variable" abort mid-shutdown).
  cleanup_compose_project="${compose_project}"
  cleanup_compose_profiles="${compose_profiles}"

  cleanup_dev() {
    if [[ ${shutting_down} -eq 1 ]]; then return; fi
    shutting_down=1
    echo ""
    warn "Shutting down dev environment..."
    # Send SIGTERM to each process and all its children
    for pid in ${extra_pid} ${front_pid} ${back_pid}; do
      if [[ ${pid} -gt 0 ]] && kill -0 ${pid} 2>/dev/null; then
        pkill -TERM -P ${pid} 2>/dev/null || true
        kill -TERM ${pid} 2>/dev/null || true
      fi
    done
    # Wait up to 6s for graceful exit, then SIGKILL
    local _elapsed=0
    while [[ ${_elapsed} -lt 6 ]]; do
      local _alive=0
      for pid in ${back_pid} ${front_pid} ${extra_pid}; do
        [[ ${pid} -gt 0 ]] && kill -0 ${pid} 2>/dev/null && _alive=1
      done
      [[ ${_alive} -eq 0 ]] && break
      sleep 1
      _elapsed=$((_elapsed + 1))
    done
    for pid in ${extra_pid} ${front_pid} ${back_pid}; do
      if [[ ${pid} -gt 0 ]] && kill -0 ${pid} 2>/dev/null; then
        pkill -KILL -P ${pid} 2>/dev/null || true
        kill -KILL ${pid} 2>/dev/null || true
      fi
    done
    cd "${PROJECT_ROOT}"
    if [[ -n "${cleanup_compose_profiles}" ]]; then
      docker compose -p "${cleanup_compose_project}" --env-file ./back/.env.dev -f scripts/docker-compose-dev.yml ${cleanup_compose_profiles} down
    fi
    ok "Dev environment stopped"
  }
  trap cleanup_dev INT TERM EXIT

  # -- Start backend --
  local log_dir="${PROJECT_ROOT}/logs"
  mkdir -p "${log_dir}"
  local back_log="${log_dir}/back-dev.log"
  local front_log="${log_dir}/front-dev.log"
  info "Starting backend (watch mode)... (log: ${back_log})"
  cd back
  # Redirect stdin so the process doesn't compete for terminal input.
  # Tee output to a log file so it can be inspected after the fact (terminal scrollback is lost on restart).
  # Process substitution (not a pipe) so $! below still captures npm's own PID,
  # which cleanup_dev relies on to find and kill the whole process tree.
  # --trace-deprecation: the back's node process prints the full stack of each deprecation warning (front untouched).
  local back_node_options="${NODE_OPTIONS:-}"
  if [[ "${TRACE_DEPRECATION:-0}" == "1" ]]; then
    back_node_options="--trace-deprecation ${back_node_options}"
    info "Back runs with --trace-deprecation"
  fi
  NODE_OPTIONS="${back_node_options}" npm run start:dev </dev/null > >(tee "${back_log}") 2>&1 &
  back_pid=$!
  cd "${PROJECT_ROOT}"

  # Wait for backend to be ready (listening on port)
  info "Waiting for backend on port ${back_port}..."
  local elapsed=0
  local max_wait=300
  while ! lsof -i ":${back_port}" -sTCP:LISTEN >/dev/null 2>&1; do
    # Check if backend process died
    if ! kill -0 ${back_pid} 2>/dev/null; then
      err "Backend process exited unexpectedly"
      cleanup_dev
      exit 1
    fi
    sleep 1
    elapsed=$((elapsed + 1))
    if [[ ${elapsed} -ge ${max_wait} ]]; then
      err "Backend did not start within ${max_wait}s"
      cleanup_dev
      exit 1
    fi
  done
  ok "Backend is ready (${elapsed}s) — http://localhost:${back_port}"

  # -- Start frontend --
  info "Starting frontend (vite)... (log: ${front_log})"
  cd front
  MODE=dev npm run dev </dev/null > >(tee "${front_log}") 2>&1 &
  front_pid=$!
  cd "${PROJECT_ROOT}"

  # Wait for frontend to be ready (listening on port)
  info "Waiting for frontend on port ${front_port}..."
  elapsed=0
  max_wait=30
  while ! lsof -i ":${front_port}" -sTCP:LISTEN >/dev/null 2>&1; do
    if ! kill -0 ${front_pid} 2>/dev/null; then
      err "Frontend process exited unexpectedly"
      cleanup_dev
      exit 1
    fi
    sleep 1
    elapsed=$((elapsed + 1))
    if [[ ${elapsed} -ge ${max_wait} ]]; then
      err "Frontend did not start within ${max_wait}s"
      cleanup_dev
      exit 1
    fi
  done
  ok "Frontend is ready (${elapsed}s) — http://localhost:${front_port}"

  # -- Extra dev services hook (opt-in, per-project) --
  # Same pattern as BACK_BUILD_HOOK in deploy-full.sh: a project-owned executable started
  # after back + front with the dev env already loaded (NODE_PORT, …), stopped with them.
  # A project can use it to start a local runner. Missing or non-executable = strict no-op.
  local extra_hook="${DEV_SERVICES_HOOK:-./scripts-local/dev-services.sh}"
  local extra_log="${PROJECT_ROOT}/logs/dev-services.log"
  if [[ -x "${extra_hook}" ]]; then
    info "Starting extra dev services (${extra_hook})... (log: ${extra_log})"
    "${extra_hook}" </dev/null > >(tee "${extra_log}") 2>&1 &
    extra_pid=$!
  fi
  echo ""
  ok "Dev environment is fully running"
  echo ""
  echo "  Backend  : http://localhost:${back_port}  (log: ${back_log})"
  echo "  Frontend : http://localhost:${front_port}  (log: ${front_log})"
  echo ""
  echo "  Press Ctrl+C to stop everything"
  echo ""

  # Block until Ctrl+C or a process dies (polling avoids wait being interrupted by Enter/ESC)
  while true; do
    if ! kill -0 ${back_pid} 2>/dev/null; then
      if [[ ${shutting_down} -eq 0 ]]; then
        echo ""
        err "Backend exited unexpectedly — check the output above."
      fi
      break
    fi
    if ! kill -0 ${front_pid} 2>/dev/null; then
      if [[ ${shutting_down} -eq 0 ]]; then
        echo ""
        err "Frontend exited unexpectedly — check the output above."
      fi
      break
    fi
    sleep 1
  done
}

# migrations_enabled_for_target <back_env_file> <cli args...>
# Returns 0 (run migrations) only if --migrate was passed AND the target's
# DB_SCHEMA_MODE is not sync (legacy: TYPEORM_SYNC/SYNC is not true). See the DB migrations note in the usage
# header above for why both conditions matter.
migrations_enabled_for_target() {
  local env_file="$1"
  shift
  local a migrate_flag=0
  for a in "$@"; do
    [[ "${a}" == "--migrate" ]] && migrate_flag=1
  done
  if [[ "${migrate_flag}" -ne 1 ]]; then
    return 1
  fi
  # DB_SCHEMA_MODE (docs: modules_shared/database/README.md, "Schema management") wins over the legacy flags when present.
  local mode_raw
  mode_raw="$(grep -E '^DB_SCHEMA_MODE=' "${env_file}" 2>/dev/null | tail -1 | cut -d'=' -f2- | tr -d $'"\'' | tr '[:upper:]' '[:lower:]' | tr -d ' ')"
  case "${mode_raw}" in
    sync)
      warn "DB_SCHEMA_MODE=sync in ${env_file} — skipping migrations even though --migrate was passed (synchronize manages the schema; use DB_SCHEMA_MODE=migrations or manual if migrations should run)."
      return 1
      ;;
    migrations|manual)
      return 0
      ;;
    "") ;;
    *) warn "DB_SCHEMA_MODE=${mode_raw} in ${env_file} is not one of sync|migrations|manual — falling back to the legacy TYPEORM_SYNC/SYNC flags (the back will refuse to start with this value)." ;;
  esac
  local sync_raw
  sync_raw="$(grep -E '^(TYPEORM_SYNC|SYNC)=' "${env_file}" 2>/dev/null | tail -1 | cut -d'=' -f2- | tr -d $'"\'' | tr '[:upper:]' '[:lower:]')"
  if [[ "${sync_raw}" == "true" || "${sync_raw}" == "1" ]]; then
    warn "TYPEORM_SYNC/SYNC=true in ${env_file} — skipping migrations even though --migrate was passed (synchronize already manages the schema; set TYPEORM_SYNC=false there first if migrations should run)."
    return 1
  fi
  return 0
}

# ============================================================
# PREPROD MODE
# ============================================================
cmd_preprod() {
  info "Syncing shared libraries..."
  "${SCRIPT_DIR}/update_common.sh" || warn "Common library sync had issues — continuing anyway"

  if [[ ! -f "${SCRIPT_DIR}/deploy-full.sh" ]]; then
    err "deploy-full.sh not found in scripts/"
    exit 1
  fi

  local back_env="./back/.env.preprod"
  local front_env
  if [[ -f "./front/.env.preprod" ]]; then
    front_env="./front/.env.preprod"
  else
    front_env="./front/.env"
    warn "front/.env.preprod not found — using front/.env"
  fi

  if [[ "$*" == *"--target=front"* || ! -f "${SCRIPT_DIR}/migrate-db.sh" ]]; then
    :
  elif migrations_enabled_for_target "${back_env}" "$@"; then
    info "Running database migrations (preprod: ${back_env})..."
    BACK_ENV_FILE="${back_env}" "${SCRIPT_DIR}/migrate-db.sh" \
      || { err "Migration failed — aborting deployment"; exit 1; }
  else
    info "Skipping database migrations (pass --migrate to run them; also auto-skipped if TYPEORM_SYNC/SYNC=true in ${back_env})."
  fi

  info "Launching preprod deployment (back: ${back_env}, front: ${front_env})..."
  BACK_ENV_FILE="${back_env}" FRONT_ENV_FILE="${front_env}" \
    exec "${SCRIPT_DIR}/deploy-full.sh" "$@"
}

# ============================================================
# PROD MODE
# ============================================================
cmd_prod() {
  info "Syncing shared libraries..."
  "${SCRIPT_DIR}/update_common.sh" || warn "Common library sync had issues — continuing anyway"

  if [[ ! -f "${SCRIPT_DIR}/deploy-full.sh" ]]; then
    err "deploy-full.sh not found in scripts/"
    exit 1
  fi

  if [[ "$*" == *"--target=front"* || ! -f "${SCRIPT_DIR}/migrate-db.sh" ]]; then
    :
  elif migrations_enabled_for_target "./back/.env" "$@"; then
    info "Running database migrations (prod: ./back/.env)..."
    "${SCRIPT_DIR}/migrate-db.sh" \
      || { err "Migration failed — aborting deployment"; exit 1; }
  else
    info "Skipping database migrations (pass --migrate to run them; also auto-skipped if DB_SCHEMA_MODE=sync or TYPEORM_SYNC/SYNC=true in ./back/.env)."
  fi

  info "Launching production deployment..."
  exec "${SCRIPT_DIR}/deploy-full.sh" "$@"
}

# ============================================================
# STOP
# ============================================================
cmd_stop() {
  local target="${1:-all}"

  case "${target}" in
    dev)
      load_env "./back/.env.dev"
      unset DOCKER_HOST
      for _s in "$HOME/.docker/run/docker.sock" "/var/run/docker.sock"; do
        if [[ -S "$_s" ]] && DOCKER_HOST="unix://$_s" docker info >/dev/null 2>&1; then
          export DOCKER_HOST="unix://$_s"; break
        fi
      done
      local stop_project
      stop_project="$(echo "${PROJECT_NAME:-$(basename "${PROJECT_ROOT}")}-dev" | tr '[:upper:]' '[:lower:]')"
      local stop_profiles=""
      [[ -n "${REDIS_URL:-}" ]] && stop_profiles="--profile redis"
      info "Stopping dev environment..."
      docker compose -p "${stop_project}" --env-file ./back/.env.dev -f scripts/docker-compose-dev.yml ${stop_profiles} down 2>/dev/null || true
      # Kill any lingering nest/vite processes for this project
      pkill -f "env-cmd -f .env.dev nest" 2>/dev/null || true
      pkill -f "vite.*--port" 2>/dev/null || true
      ok "Dev environment stopped"
      ;;
    preprod)
      if [[ -f "./back/.env.preprod" ]]; then
        load_env "./back/.env.preprod"
      fi
      info "Stopping preprod environment..."
      docker compose -p "${PROJECT_NAME:-app}_preprod" \
        -f scripts/docker-compose-preprod.yml down 2>/dev/null || true
      ok "Preprod environment stopped"
      ;;
    all)
      cmd_stop dev
      cmd_stop preprod
      ;;
    *)
      err "Unknown target: ${target}. Use: dev, preprod, or all"
      exit 1
      ;;
  esac
}

# ============================================================
# STATUS
# ============================================================
cmd_status() {
  unset DOCKER_HOST
  for _s in "$HOME/.docker/run/docker.sock" "/var/run/docker.sock"; do
    if [[ -S "$_s" ]] && DOCKER_HOST="unix://$_s" docker info >/dev/null 2>&1; then
      export DOCKER_HOST="unix://$_s"; break
    fi
  done
  echo ""
  printf "${CYAN}%-12s %-40s %s${NC}\n" "MODE" "CONTAINER" "STATUS"
  echo "────────────────────────────────────────────────────────────────"

  # Dev containers
  if [[ -f "./back/.env.dev" ]]; then
    load_env "./back/.env.dev" 2>/dev/null || true
    local status_project
    status_project="$(echo "${PROJECT_NAME:-$(basename "${PROJECT_ROOT}")}-dev" | tr '[:upper:]' '[:lower:]')"
    local status_profiles=""
    [[ -n "${REDIS_URL:-}" ]] && status_profiles="--profile redis"
    local dev_containers
    dev_containers=$(docker compose -p "${status_project}" --env-file ./back/.env.dev -f scripts/docker-compose-dev.yml ${status_profiles} ps --format '{{.Name}}\t{{.Status}}' 2>/dev/null || true)
    if [[ -n "${dev_containers}" ]]; then
      while IFS=$'\t' read -r name status; do
        printf "%-12s %-40s %s\n" "dev" "${name}" "${status}"
      done <<< "${dev_containers}"
    fi
    # Check for running nest/vite processes
    if pgrep -f "env-cmd -f .env.dev nest" >/dev/null 2>&1; then
      printf "%-12s %-40s %s\n" "dev" "nest (watch)" "running"
    fi
    if pgrep -f "vite" >/dev/null 2>&1; then
      printf "%-12s %-40s %s\n" "dev" "vite (front)" "running"
    fi
  fi

  # Preprod containers
  if [[ -f "./back/.env.preprod" ]]; then
    load_env "./back/.env.preprod" 2>/dev/null || true
  fi
  local preprod_containers
  preprod_containers=$(docker compose -p "${PROJECT_NAME:-app}_preprod" \
    -f scripts/docker-compose-preprod.yml ps --format '{{.Name}}\t{{.Status}}' 2>/dev/null || true)
  if [[ -n "${preprod_containers}" ]]; then
    while IFS=$'\t' read -r name status; do
      printf "%-12s %-40s %s\n" "preprod" "${name}" "${status}"
    done <<< "${preprod_containers}"
  fi

  echo ""
}

# ============================================================
# MAIN
# ============================================================
usage() {
  echo "Usage: ./scripts/run.sh <command> [options]"
  echo ""
  echo "Commands:"
  echo "  dev [--infra-only]       Start dev environment"
  echo "  --trace-deprecation      Global flag: back under node --trace-deprecation (alone = dev)"
  echo "  preprod [--target=...]   Deploy to preprod (uses back/.env.preprod + front/.env.preprod)"
  echo "  prod                     Run deploy-remote.sh"
  echo "  stop [dev|preprod|all]   Stop environment(s)"
  echo "  status                   Show running services"
  echo ""
}

# `--trace-deprecation` is a global flag (any position); alone it means `dev`.
TRACE_DEPRECATION=0
_run_args=()
for _arg in "$@"; do
  if [[ "${_arg}" == "--trace-deprecation" ]]; then
    TRACE_DEPRECATION=1
  else
    _run_args+=("${_arg}")
  fi
done
set -- ${_run_args[@]+"${_run_args[@]}"}
if [[ $# -lt 1 && "${TRACE_DEPRECATION}" == "1" ]]; then
  set -- dev
fi
export TRACE_DEPRECATION

if [[ $# -lt 1 ]]; then
  usage
  exit 1
fi

COMMAND="$1"
shift

case "${COMMAND}" in
  dev)     cmd_dev "$@" ;;
  preprod) cmd_preprod "$@" ;;
  prod)    cmd_prod "$@" ;;
  stop)    cmd_stop "$@" ;;
  status)  cmd_status "$@" ;;
  -h|--help|help)
    usage
    ;;
  *)
    err "Unknown command: ${COMMAND}"
    usage
    exit 1
    ;;
esac
