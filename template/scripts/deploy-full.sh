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
# deploy-full.sh — Deploy back and/or front to remote hosts
# ============================================================
# Builds Docker images (resolving symlinks), deploys via SSH
# to remote hosts. Front can be deployed to Cloudflare Pages
# when VITE_API_URL starts with https://.
#
# Usage:
#   ./scripts/deploy-full.sh                Deploy back + front
#   ./scripts/deploy-full.sh --target=back   Deploy back only
#   ./scripts/deploy-full.sh --target=front  Deploy front only
#   ./scripts/deploy-full.sh --no-auto-rollback   Do not roll back automatically when the new back is not healthy
#                                            (default: roll back, exit 3 = restored, exit 4 = rollback failed)
#   ./scripts/deploy-full.sh --migrate       Tell the script migrations ran (self-hosted Postgres: always dump)
#   ./scripts/deploy-full.sh --force-db-backup   Self-hosted Postgres: dump even when the last one is recent
#   ./scripts/deploy-full.sh --rollback [--restore-db] [--target=...]
#                                            Swap back to the previous version (no build, no submodule update);
#                                            normally launched through `./scripts/run.sh rollback <preprod|prod>`
#   ./scripts/deploy-full.sh --help          Show this help
#
# Versioning (lib/deploy-versions.sh): each host keeps `<image>:previous` next to `:latest`, the remote
# .env as .env.previous and .deploy/current.json|previous.json; DEPLOY_REVISION (env var, else git short sha
# + -dirty) is injected into the back env and exposed by GET /api/v1/health. Database backups (lib/deploy-versions.sh):
# SQLite: on the volume at every switch; self-hosted Postgres (--migrate or DB_SCHEMA_MODE=sync): a dump on the server
# while the old back still serves, at most one per DEPLOY_DB_BACKUP_MIN_AGE_HOURS (24); DEPLOY_DB_BACKUP_KEEP (2) kept
# on the server and in ./backups (local copy at the end of the deploy, DEPLOY_DB_BACKUP_DOWNLOAD=0 to skip).
# Exit codes: 0 ok, 3 failed + previous version restored, 4 failed + rollback failed.
#
# Speed: SSH connections are reused (lib/ssh-mux.sh, DEPLOY_SSH_MUX=0 to disable); every phase is timed
# (lib/deploy-timing.sh, `==> [TIME]` lines and a summary at exit); after run.sh's library sync
# (DEPLOY_LIBS_SYNCED=1) the submodules are not fetched a second time.
#
# Required env vars (in back/.env):
#   PROJECT_NAME, REMOTE_USER, REMOTE_SSH_PORT, SSH_KEY_FILE,
#   REMOTE_CONTEXT_NAME, BACK_HOSTS (or REMOTE_HOST)
#
# Front hosts (Docker mode):
#   FRONT_HOSTS (or REMOTE_HOST)
#
# Cloud front mode (Cloudflare Pages):
#   Set VITE_API_URL=https://... in front/.env
#   Optional: CLOUDFLARE_PAGES_PROJECT (defaults to PROJECT_NAME)
#   Optional: CLOUDFLARE_PAGES_BRANCH (defaults to main) — read from front/.env
# ============================================================

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
# Physical template root (scripts/ is a symlink into front/.libs/apptemplate): back|front/Dockerfile.prebuilt live there.
TEMPLATE_ROOT="$(dirname "$(dirname "$(python3 -c 'import os, sys; print(os.path.realpath(sys.argv[1]))' "${BASH_SOURCE[0]}")")")"
source "${SCRIPT_DIR}/lib/db-engine.sh"
cd "${PROJECT_ROOT}"

if [[ "${1:-}" == "--help" || "${1:-}" == "-h" || "${1:-}" == "help" ]]; then
  sed -n '3,/^[^#]/p' "$0" | grep '^#' | sed 's/^# \?//'
  exit 0
fi

# Parse --target flag
DEPLOY_TARGET="${DEPLOY_TARGET:-all}"
RUNNER_ROTATE_CLI=0
ROLLBACK_MODE=0
RESTORE_DB=0
DV_MIGRATE=0
DV_FORCE_DB_BACKUP=0
DEPLOY_AUTO_ROLLBACK="${DEPLOY_AUTO_ROLLBACK:-1}"
for arg in "$@"; do
  case "${arg}" in
    --target=*) DEPLOY_TARGET="${arg#*=}" ;;
    --rotate-runner) RUNNER_ROTATE_CLI=1 ;;
    --rollback) ROLLBACK_MODE=1 ;;
    --restore-db) RESTORE_DB=1 ;;
    --no-auto-rollback) DEPLOY_AUTO_ROLLBACK=0 ;;
    --migrate) DV_MIGRATE=1 ;;
    --force-db-backup) DV_FORCE_DB_BACKUP=1 ;;
  esac
done
if [[ "${DEPLOY_TARGET}" != "all" && "${DEPLOY_TARGET}" != "back" && "${DEPLOY_TARGET}" != "front" ]]; then
  echo "Error: --target must be 'all', 'back', or 'front'."
  exit 1
fi

# ── Runner auto-provisioning (opt-in hook, per-project) ─────────────────────
# Pairs a colocated runner without manual token handling: after a back host is
# deployed and healthy, the project-owned hook below mints/rotates the runner's
# token via the hub's own API and runs the project's runner installer with it.
#
# Everything defaults to OFF so projects that set none of these get byte-for-byte
# today's behavior: the hook is never called, no new failure mode exists.
#   RUNNER_PROVISION=1            master switch (also settable per-project in back/.env,
#                                 which this script sources with `set -a` above).
#   RUNNER_PROVISION_HOOK=...     project-owned executable receiving its context via
#                                 RUNNER_* env (see the call site at the end of
#                                 deploy_back_host). Missing/non-executable = skip with info.
#   RUNNER_ROTATE=1 / --rotate-runner
#                                 rotate the runner token even when the runner exists
#                                 (default policy lives in the hook: create if missing,
#                                 rotate only if offline).
#   RUNNER_PROVISION_ORDER=after  when the hook runs on a back host: `after` (default) once the
#                                 new back is healthy; `before` = before this host's new back is
#                                 deployed, through the back still serving there — for a runner
#                                 that works with the previous hub, so the new hub never sees an
#                                 old runner. No back serving yet (first deploy) or any hook failure
#                                 ⇒ the hook runs again `after`, as by default.
RUNNER_PROVISION="${RUNNER_PROVISION:-0}"
RUNNER_PROVISION_HOOK="${RUNNER_PROVISION_HOOK:-./runner/scripts/provision-hub-runner.sh}"
RUNNER_ROTATE="${RUNNER_ROTATE:-${RUNNER_ROTATE_CLI:-0}}"
RUNNER_PROVISION_ORDER="${RUNNER_PROVISION_ORDER:-after}"

# ── Back post-build hook (opt-in, per-project) ───────────────────────────────
# Same pattern as RUNNER_PROVISION_HOOK above: after a local back build, the
# project-owned executable below receives BACK_BUILD_DIR ($1) and may stage extras
# into the image context. A project can use it to bake a runner install payload
# (tarball + install.sh + unit) for UI-triggered remote deploys. Missing or
# non-executable = strict no-op, byte-for-byte today's behavior.
BACK_BUILD_HOOK="${BACK_BUILD_HOOK:-./scripts-local/stage-runner-dist.sh}"

# ======================
# LOGGING
# ======================
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; CYAN='\033[0;36m'; NC='\033[0m'
info()    { printf "${CYAN}==> %s${NC}\n" "$*"; }
warn()    { printf "${YELLOW}==> %s${NC}\n" "$*"; }
err()     { printf "${RED}==> %s${NC}\n" "$*" >&2; }
success() { printf "${GREEN}==> %s${NC}\n" "$*"; }

# Versioning, database backup and rollback (tag previous, state files, automatic/manual rollback).
source "${SCRIPT_DIR}/lib/deploy-versions.sh"
# Phase timing (`==> [TIME]` lines + summary at exit) and SSH connection reuse.
source "${SCRIPT_DIR}/lib/deploy-timing.sh"
source "${SCRIPT_DIR}/lib/ssh-mux.sh"
dt_import

# ======================
# CONFIGURATION
# ======================
# Env file overrides — set BACK_ENV_FILE / FRONT_ENV_FILE before calling this
# script to target a different environment (e.g. preprod).
BACK_ENV_FILE="${BACK_ENV_FILE:-./back/.env}"
FRONT_ENV_FILE="${FRONT_ENV_FILE:-./front/.env}"

# Export all vars from back env so compose interpolation works without a root .env
set -a
source "${BACK_ENV_FILE}"
set +a
COMPOSE_PROJECT_NAME="${PROJECT_NAME:?PROJECT_NAME is required}"

# ── Deploy from `main` regardless of the branch checked out (opt-in, per-project: back/.env DEPLOY_FROM_MAIN=true) ──
# A project working from `dev` (template convention) but wanting every deploy to ship only the user's own "roughly
# stable" publish point (`main`), never whatever is checked out locally mid-feature. restore_deploy_branch() is
# chained into every EXIT trap this script sets later (ssh_mux / build-context cleanup) so the original branch (and
# any stashed local change) comes back no matter how the deploy ends — success, failure, rollback, Ctrl-C. Off by
# default: a project that never sets DEPLOY_FROM_MAIN keeps deploying whatever branch is checked out, byte-for-byte
# today's behaviour.
DEPLOY_BRANCH_SWITCHED=0
DEPLOY_STASHED=0
DEPLOY_ORIGINAL_BRANCH=""
restore_deploy_branch() {
  [[ "${DEPLOY_BRANCH_SWITCHED}" -eq 1 ]] || return 0
  git -C "${PROJECT_ROOT}" checkout "${DEPLOY_ORIGINAL_BRANCH}" >/dev/null 2>&1 \
    || err "Could not switch back to '${DEPLOY_ORIGINAL_BRANCH}' after the deploy — check 'git status' in ${PROJECT_ROOT}."
  if [[ "${DEPLOY_STASHED}" -eq 1 ]]; then
    git -C "${PROJECT_ROOT}" stash pop >/dev/null 2>&1 \
      || err "Could not restore the stashed changes — run 'git stash list' / 'git stash pop' manually in ${PROJECT_ROOT}."
  fi
  DEPLOY_BRANCH_SWITCHED=0
}
if [[ "$(printf '%s' "${DEPLOY_FROM_MAIN:-0}" | tr '[:upper:]' '[:lower:]')" =~ ^(1|true|on|yes)$ ]]; then
  DEPLOY_ORIGINAL_BRANCH="$(git -C "${PROJECT_ROOT}" branch --show-current)"
  if [[ -z "${DEPLOY_ORIGINAL_BRANCH}" ]]; then
    err "DEPLOY_FROM_MAIN=true requires a checked-out branch (detached HEAD found) — aborting."
    exit 1
  fi
  if [[ "${DEPLOY_ORIGINAL_BRANCH}" != "main" ]]; then
    if [[ -n "$(git -C "${PROJECT_ROOT}" status --porcelain)" ]]; then
      info "DEPLOY_FROM_MAIN=true: stashing local changes on '${DEPLOY_ORIGINAL_BRANCH}' before switching to main"
      git -C "${PROJECT_ROOT}" stash push -u -m "deploy-full.sh: auto-stash before switching to main" >/dev/null
      DEPLOY_STASHED=1
    fi
    DEPLOY_BRANCH_SWITCHED=1
    trap restore_deploy_branch EXIT
    info "DEPLOY_FROM_MAIN=true: switching from '${DEPLOY_ORIGINAL_BRANCH}' to main for this deploy"
    git -C "${PROJECT_ROOT}" fetch origin main
    git -C "${PROJECT_ROOT}" checkout main
    git -C "${PROJECT_ROOT}" merge --ff-only origin/main \
      || { err "Local main cannot fast-forward on origin/main — resolve manually, then re-run."; exit 1; }
  fi
fi

# ── back-worker on/off (BACK_WORKER in back/.env: on (default) | off) ────────
# off = no back-worker container: `back` runs as a single process with NODE_ROLE=all (API + background work). The
# compose files read it through `NODE_ROLE: ${BACK_NODE_ROLE:-api}`; BACK_NODE_ROLE is exported here, so it reaches every
# `docker compose` call of this script (and of lib/deploy-versions.sh, rollbacks included) through the process env.
# Validated here, before any host is touched.
BACK_WORKER_ENABLED=1
case "$(printf '%s' "${BACK_WORKER:-on}" | tr '[:upper:]' '[:lower:]')" in
  on|true|1|"") BACK_WORKER_ENABLED=1 ;;
  off|false|0) BACK_WORKER_ENABLED=0 ;;
  *)
    err "BACK_WORKER='${BACK_WORKER}' is not valid (expected on|off, also true|false|1|0)."
    exit 1
    ;;
esac
if [[ "${BACK_WORKER_ENABLED}" -eq 0 ]]; then
  export BACK_NODE_ROLE=all
else
  unset BACK_NODE_ROLE
fi

# ── Destinations de supervision (vmagent) ────────────────────────────────────
# PROMETHEUS_REMOTE_WRITE_URLS accepte une LISTE séparée par des virgules : un
# même back pousse ses métriques vers plusieurs serveurs Prometheus, vmagent
# répliquant les séries vers chacun. PROMETHEUS_REMOTE_WRITE_URL (singulier)
# reste accepté pour ne pas casser les .env existants.
#
# Les identifiants s'apparient aux URL par POSITION côté vmagent : une valeur
# unique n'authentifierait que la PREMIÈRE destination, les suivantes partiraient
# en anonyme et seraient refusées en 401 — sans que rien ne le signale, vmagent
# réessayant indéfiniment en silence. On duplique donc la valeur autant de fois
# qu'il y a d'URL.
PROMETHEUS_REMOTE_WRITE_URLS="${PROMETHEUS_REMOTE_WRITE_URLS:-${PROMETHEUS_REMOTE_WRITE_URL:-}}"
if [[ -n "${PROMETHEUS_REMOTE_WRITE_URLS}" ]]; then
  RW_URL_COUNT=$(awk -F',' '{print NF}' <<<"${PROMETHEUS_REMOTE_WRITE_URLS}")
  replicate_credential() {
    local value="$1" count="$2" out="" i
    [[ -z "${value}" ]] && { printf ''; return; }
    # Déjà une liste de la bonne longueur : on n'y touche pas (identifiants
    # distincts par destination).
    if [[ "$(awk -F',' '{print NF}' <<<"${value}")" -eq "${count}" ]]; then
      printf '%s' "${value}"
      return
    fi
    for ((i = 0; i < count; i++)); do
      # `if` et non `(( )) && …` : sous `set -e`, une liste ET dont le test
      # échoue à la dernière itération renvoie 1, et le comportement dépend
      # alors de la position de la commande dans la fonction. Trop subtil pour
      # un script de déploiement.
      if (( i > 0 )); then out+=","; fi
      out+="${value}"
    done
    printf '%s' "${out}"
  }
  PROMETHEUS_BASIC_AUTH_USER="$(replicate_credential "${PROMETHEUS_BASIC_AUTH_USER:-}" "${RW_URL_COUNT}")"
  PROMETHEUS_BASIC_AUTH_PASSWORD="$(replicate_credential "${PROMETHEUS_BASIC_AUTH_PASSWORD:-}" "${RW_URL_COUNT}")"
  export PROMETHEUS_REMOTE_WRITE_URLS PROMETHEUS_BASIC_AUTH_USER PROMETHEUS_BASIC_AUTH_PASSWORD
fi
# Layer cache is safe because Dockerfiles copy package.json before source.
# Set FORCE_REBUILD=1 to bypass layer cache. Base images are always refreshed (build --pull), so a Node security release is picked up.
FORCE_REBUILD="${FORCE_REBUILD:-0}"
NO_CACHE_FLAG=""
[[ "${FORCE_REBUILD}" == "1" ]] && NO_CACHE_FLAG="--no-cache"
resolve_db_engine
COMPOSE_FILE_PATH="${COMPOSE_FILE_NAME:-${DEFAULT_COMPOSE_FILE}}"
COMPOSE_FILE_PATH="${COMPOSE_FILE_PATH#./}"
assert_compose_matches_db_engine "${COMPOSE_FILE_PATH}"
KEEP_BUILD_CONTEXT="${KEEP_BUILD_CONTEXT:-0}"

# Revision of this deploy (DEPLOY_REVISION, else git short sha + -dirty): injected into the back env below and shown
# by GET /api/v1/health, so a deploy can be verified (and a rollback recognised) from the outside.
if [[ "${ROLLBACK_MODE}" != "1" ]]; then
  DEPLOY_REVISION="$(dv_compute_revision)"
  export DEPLOY_REVISION
  echo "==> [LOCAL] Deploy revision: ${DEPLOY_REVISION}"
fi

# Cloud front detection (early, needed to make FRONT_HOSTS optional)
VITE_API_URL_VALUE=""
if [[ -f "${FRONT_ENV_FILE}" ]]; then
  VITE_API_URL_VALUE=$(grep -E "^[[:space:]]*VITE_API_URL=" "${FRONT_ENV_FILE}" | tail -1 | sed 's/^[^=]*=//' | tr -d '"' | tr -d "'" || true)
fi
IS_CLOUD_FRONT=0
CLOUDFLARE_PAGES_PROJECT="${CLOUDFLARE_PAGES_PROJECT:-${PROJECT_NAME}}"
if [[ "${VITE_API_URL_VALUE}" == https://* ]]; then
  IS_CLOUD_FRONT=1
fi

ALLOWED_IPS=()
PROXY_IPS=()
WHITELIST_IPS=()
FRONT_FIREWALL_PORTS=()
BACK_FIREWALL_PORTS=()
FIREWALL_RULES_READY=0

# Front hosts configuration (comma-separated list via FRONT_HOSTS)
FRONT_REMOTE_USER="${FRONT_REMOTE_USER:-${REMOTE_USER:-ubuntu}}"
FRONT_SSH_PORT="${FRONT_SSH_PORT:-${REMOTE_SSH_PORT:-22}}"
FRONT_SSH_KEY_FILE="${FRONT_SSH_KEY_FILE:-${SSH_KEY_FILE:-}}"
FRONT_CONTEXT_NAME="${FRONT_CONTEXT_NAME:-${REMOTE_CONTEXT_NAME:-example-front}}"
FRONT_REMOTE_APP_DIR="${FRONT_REMOTE_APP_DIR:-${REMOTE_APP_DIR:-~/example/front}}"
FRONT_HOSTS_RAW="${FRONT_HOSTS:-${FRONT_REMOTE_HOST:-${REMOTE_HOST:-}}}"

# Back hosts configuration (comma-separated list via BACK_HOSTS)
BACK_REMOTE_USER="${BACK_REMOTE_USER:-${REMOTE_USER:-ubuntu}}"
BACK_SSH_PORT="${BACK_SSH_PORT:-${REMOTE_SSH_PORT:-22}}"
BACK_SSH_KEY_FILE="${BACK_SSH_KEY_FILE:-${SSH_KEY_FILE:-}}"
BACK_CONTEXT_NAME="${BACK_CONTEXT_NAME:-${REMOTE_CONTEXT_NAME:-example-back}}"
BACK_REMOTE_APP_DIR="${BACK_REMOTE_APP_DIR:-${REMOTE_APP_DIR:-~/example/back}}"
BACK_HOSTS_RAW="${BACK_HOSTS:-${BACK_REMOTE_HOST:-${REMOTE_HOST:-}}}"

if [[ "${DEPLOY_TARGET}" != "back" && -z "${FRONT_HOSTS_RAW}" && "${IS_CLOUD_FRONT}" -eq 0 ]]; then
  echo "Error: FRONT_HOSTS must specify at least one host (comma-separated), or set VITE_API_URL to https://... for cloud front deployment."
  exit 1
fi

if [[ "${DEPLOY_TARGET}" != "front" && -z "${BACK_HOSTS_RAW}" ]]; then
  echo "Error: BACK_HOSTS must specify at least one host (comma-separated)."
  exit 1
fi

# SQLite is one file in the `sqlite_data` volume of ONE host: several back hosts would each get their own copy,
# and several replicas share the file only through that volume (single writer at a time).
if [[ "${IS_SQLITE_DB}" -eq 1 && "${DEPLOY_TARGET}" != "front" ]]; then
  if [[ "${BACK_HOSTS_RAW}" == *,* ]]; then
    echo "Error: DB_ENGINE=sqlite supports a single back host (BACK_HOSTS='${BACK_HOSTS_RAW}')." >&2
    exit 1
  fi
  [[ "${BACK_REPLICAS:-1}" -gt 1 ]] && echo "Warning: DB_ENGINE=sqlite with BACK_REPLICAS=${BACK_REPLICAS}: replicas share one SQLite file (writes are serialized); prefer BACK_REPLICAS=1." >&2
fi

# ======================
# HELPERS
# ======================

require_cmd() {
  command -v "$1" >/dev/null 2>&1 || {
    echo "Error: command '$1' not found."
    exit 1
  }
}

# Returns available memory in MB on macOS (free + inactive pages), 0 on other OSes.
# macOS keeps "Pages free" near zero by design — inactive pages are immediately reclaimable.
available_memory_mb() {
  if ! command -v vm_stat >/dev/null 2>&1; then echo 0; return; fi
  local free_pages inactive_pages page_size
  free_pages=$(vm_stat | awk '/^Pages free:/ {gsub(/\./, "", $3); print $3+0}')
  inactive_pages=$(vm_stat | awk '/^Pages inactive:/ {gsub(/\./, "", $3); print $3+0}')
  page_size=$(pagesize 2>/dev/null || echo 4096)
  echo $(( (free_pages + inactive_pages) * page_size / 1024 / 1024 ))
}

check_build_memory() {
  local required_mb="${1:-1024}"
  local avail_mb
  avail_mb="$(available_memory_mb)"
  if [[ "${avail_mb}" -eq 0 ]]; then return; fi
  if [[ "${avail_mb}" -lt "${required_mb}" ]]; then
    echo ""
    echo "Error: not enough free memory to build the front end."
    echo "       Free pages: ~${avail_mb} MB — minimum required: ~${required_mb} MB"
    echo "       The build process (Node.js + vite) needs at least ${required_mb} MB of"
    echo "       immediately available RAM; the OS memory compressor is saturated."
    echo ""
    echo "       To fix:"
    echo "         1. Quit Docker Desktop   (typically frees 4-8 GB)"
    echo "         2. Close heavy apps/tabs (Chrome, Slack, etc.)"
    echo "         3. Run:  sudo purge      (flushes disk cache, reclaims more pages)"
    echo "         4. Retry the deploy"
    echo ""
    exit 1
  fi
  echo "==> [CLOUD] Free memory: ~${avail_mb} MB — OK"
}

resolve_realpath() {
  python3 - "$1" <<'PY'
import os
import sys
path = sys.argv[1]
if not path:
    sys.exit(1)
print(os.path.realpath(path))
PY
}

resolve_key_path() {
  local key_file="$1"
  if [[ -z "${key_file}" ]]; then
    printf ''
    return
  fi
  if [[ -f "${key_file}" ]]; then
    printf '%s' "${key_file}"
    return
  fi
  if [[ -f "${HOME}/.ssh/${key_file}" ]]; then
    printf '%s' "${HOME}/.ssh/${key_file}"
    return
  fi
  echo "Error: SSH key not found (${key_file})." >&2
  exit 1
}

extract_env_value() {
  local file="$1"
  local key="$2"
  local line value
  if [[ ! -f "${file}" ]]; then
    return 1
  fi
  line=$(grep -E "^[[:space:]]*${key}=" "${file}" | tail -n 1 || true)
  if [[ -z "${line}" ]]; then
    return 1
  fi
  value="${line#*=}"
  value="${value%\"}"
  value="${value#\"}"
  value="${value%\'}"
  value="${value#\'}"
  printf "%s" "${value}"
}

trim_string() {
  printf '%s' "$(echo "$1" | awk '{$1=$1};1')"
}

clean_list_item() {
  local value
  value="$(trim_string "$1")"
  value="${value//\"/}"
  value="${value//\'/}"
  printf '%s' "${value}"
}

parse_hosts() {
  local raw="$1"
  local IFS=','
  read -ra parts <<<"${raw}"
  local result=()
  for entry in "${parts[@]}"; do
    local trimmed
    trimmed="$(trim_string "${entry}")"
    if [[ -n "${trimmed}" ]]; then
      result+=("${trimmed}")
    fi
  done
  [[ ${#result[@]} -gt 0 ]] && printf '%s\n' "${result[@]}"
}

sanitize_identifier() {
  echo "$1" | tr '[:upper:]' '[:lower:]' | sed 's/[^a-z0-9]/-/g'
}

build_context_name() {
  local base="$1"
  local host="$2"
  local suffix
  suffix="$(sanitize_identifier "${host}")"
  printf '%s-%s' "${base}" "${suffix}"
}

build_project_name() {
  local role="$1"
  local host="$2"
  local suffix
  suffix="$(sanitize_identifier "${host}")"
  # Docker compose project names must be lowercase
  printf '%s-%s-%s' "${COMPOSE_PROJECT_NAME}" "${role}" "${suffix}" | tr '[:upper:]' '[:lower:]'
}

ensure_docker_context() {
  local context_name="$1"
  local ssh_target="$2"
  local port="$3"
  local desired_host="ssh://${ssh_target}:${port}"
  if ! docker context inspect "${context_name}" >/dev/null 2>&1; then
    echo "==> Creating docker context ${context_name}"
    docker context create "${context_name}" --docker "host=${desired_host}" >/dev/null
  else
    echo "==> Updating docker context ${context_name}"
    docker context update "${context_name}" --docker "host=${desired_host}" >/dev/null
  fi
}

parse_host_entry() {
  local entry="$1"
  local default_user="$2"
  local user="$default_user"
  local host="$entry"
  if [[ "${entry}" == *"@"* ]]; then
    user="${entry%@*}"
    host="${entry#*@}"
  fi
  printf '%s %s' "${user}" "${host}"
}

apply_ufw_rules_for_host() {
  local entry="$1"
  local default_user="$2"
  local ssh_port="$3"
  local key_path="$4"
  shift 4
  local ports=("$@")
  if [[ "${#ports[@]}" -eq 0 || "${#ALLOWED_IPS[@]}" -eq 0 ]]; then
    return
  fi

  read -r target_user target_host <<<"$(parse_host_entry "${entry}" "${default_user}")"
  local ssh_target="${target_user}@${target_host}"
  local -a ssh_opts=("-p" "${ssh_port}")
  if [[ -n "${key_path}" ]]; then
    ssh_opts+=("-i" "${key_path}")
  fi

  local commands=()
  for port in "${ports[@]}"; do
    if [[ -z "${port}" ]]; then
      continue
    fi
    for ip in "${ALLOWED_IPS[@]}"; do
      commands+=("sudo ufw allow from '${ip}' to any port ${port}")
    done
  done

  if [[ "${#commands[@]}" -eq 0 ]]; then
    return
  fi

  local remote_script="set -euo pipefail;"
  for cmd in "${commands[@]}"; do
    remote_script+=" ${cmd};"
  done

  echo "==> [FIREWALL:${target_host}] Applying ${#commands[@]} UFW rule(s)"
  ssh "${ssh_opts[@]}" "${ssh_target}" "${remote_script}"
}

parse_ip_list() {
  local raw="$1"
  local result=()
  if [[ -n "${raw}" ]]; then
    while IFS= read -r entry; do
      local cleaned
      cleaned="$(clean_list_item "${entry}")"
      if [[ -n "${cleaned}" ]]; then
        result+=("${cleaned}")
      fi
    done < <(parse_hosts "${raw}")
  fi
  [[ ${#result[@]} -gt 0 ]] && printf '%s\n' "${result[@]}"
}

fetch_cloudflare_ips() {
  CLOUDFLARE_IPS=()
  local v4_url="https://www.cloudflare.com/ips-v4"
  local v6_url="https://www.cloudflare.com/ips-v6"
  local raw_v4 raw_v6
  raw_v4=$(curl -sf --max-time 10 "${v4_url}" 2>/dev/null || true)
  raw_v6=$(curl -sf --max-time 10 "${v6_url}" 2>/dev/null || true)
  local line
  for line in ${raw_v4} ${raw_v6}; do
    line=$(echo "${line}" | tr -d '[:space:]')
    [[ -n "${line}" ]] && CLOUDFLARE_IPS+=("${line}")
  done
  if [[ "${#CLOUDFLARE_IPS[@]}" -eq 0 ]]; then
    echo "==> [FIREWALL] WARNING: Could not fetch Cloudflare IPs — skipping Cloudflare firewall rules"
  else
    echo "==> [FIREWALL] Fetched ${#CLOUDFLARE_IPS[@]} Cloudflare IP range(s)"
  fi
}

configure_firewall_rules() {
  FIREWALL_RULES_READY=0

  # Parse IP lists
  PROXY_IPS=()
  while IFS= read -r ip; do [[ -n "${ip}" ]] && PROXY_IPS+=("${ip}"); done < <(parse_ip_list "${PROXY_HOSTS:-}")

  WHITELIST_IPS=()
  while IFS= read -r ip; do [[ -n "${ip}" ]] && WHITELIST_IPS+=("${ip}"); done < <(parse_ip_list "${WHITELIST:-}")

  BACK_WHITELIST_IPS=()
  while IFS= read -r ip; do [[ -n "${ip}" ]] && BACK_WHITELIST_IPS+=("${ip}"); done < <(parse_ip_list "${BACK_WHITELIST:-}")

  # Fetch Cloudflare IPs when front is hosted on Cloudflare Pages
  CLOUDFLARE_IPS=()
  if [[ "${IS_CLOUD_FRONT}" -eq 1 ]]; then
    fetch_cloudflare_ips
  fi

  if [[ "${#PROXY_IPS[@]}" -eq 0 && "${#WHITELIST_IPS[@]}" -eq 0 && "${#BACK_WHITELIST_IPS[@]}" -eq 0 && "${#CLOUDFLARE_IPS[@]}" -eq 0 ]]; then
    echo "==> [FIREWALL] No PROXY_HOSTS, WHITELIST, BACK_WHITELIST, or Cloudflare entries provided, skipping UFW changes"
    return
  fi

  FIREWALL_RULES_READY=1
  echo "==> [FIREWALL] Prepared: ${#PROXY_IPS[@]} proxy IP(s), ${#WHITELIST_IPS[@]} whitelist IP(s), ${#BACK_WHITELIST_IPS[@]} back-whitelist IP(s), ${#CLOUDFLARE_IPS[@]} Cloudflare range(s)"
}

apply_firewall_rules() {
  if [[ "${FIREWALL_RULES_READY}" -ne 1 ]]; then
    return
  fi

  # PROXY_HOSTS → VITE_PORT only on front hosts (skip if cloud front)
  if [[ "${IS_CLOUD_FRONT}" -eq 0 && "${#PROXY_IPS[@]}" -gt 0 && -n "${VITE_PORT:-}" && "${#FRONT_HOSTS[@]}" -gt 0 ]]; then
    echo "==> [FIREWALL] PROXY_HOSTS → VITE_PORT=${VITE_PORT} on ${#FRONT_HOSTS[@]} front host(s)"
    ALLOWED_IPS=("${PROXY_IPS[@]}")
    for host_entry in "${FRONT_HOSTS[@]}"; do
      apply_ufw_rules_for_host "${host_entry}" "${FRONT_REMOTE_USER}" "${FRONT_SSH_PORT}" "${FRONT_KEY_PATH}" "${VITE_PORT}"
    done
  fi

  # WHITELIST → NODE_PORT + DB_PORT (if self-hosted) on back hosts, VITE_PORT on front hosts (skip if cloud front)
  if [[ "${#WHITELIST_IPS[@]}" -gt 0 ]]; then
    ALLOWED_IPS=("${WHITELIST_IPS[@]}")

    # Front: VITE_PORT (skip if cloud front)
    if [[ "${IS_CLOUD_FRONT}" -eq 0 && -n "${VITE_PORT:-}" && "${#FRONT_HOSTS[@]}" -gt 0 ]]; then
      echo "==> [FIREWALL] WHITELIST → VITE_PORT=${VITE_PORT} on ${#FRONT_HOSTS[@]} front host(s)"
      for host_entry in "${FRONT_HOSTS[@]}"; do
        apply_ufw_rules_for_host "${host_entry}" "${FRONT_REMOTE_USER}" "${FRONT_SSH_PORT}" "${FRONT_KEY_PATH}" "${VITE_PORT}"
      done
    fi

    # Back: NODE_PORT + DB_PORT (if self-hosted)
    local back_ports=()
    [[ -n "${NODE_PORT:-}" ]] && back_ports+=("${NODE_PORT}")
    [[ "${IS_SELF_HOSTED_DB}" -eq 1 && -n "${DB_PORT:-}" ]] && back_ports+=("${DB_PORT}")
    if [[ "${#back_ports[@]}" -gt 0 ]]; then
      echo "==> [FIREWALL] WHITELIST → ports ${back_ports[*]} on ${#BACK_HOSTS[@]} back host(s)"
      for host_entry in "${BACK_HOSTS[@]}"; do
        apply_ufw_rules_for_host "${host_entry}" "${BACK_REMOTE_USER}" "${BACK_SSH_PORT}" "${BACK_KEY_PATH}" "${back_ports[@]}"
      done
    fi
  fi

  # BACK_WHITELIST → NODE_PORT only
  if [[ "${#BACK_WHITELIST_IPS[@]}" -gt 0 && -n "${NODE_PORT:-}" ]]; then
    echo "==> [FIREWALL] BACK_WHITELIST → NODE_PORT=${NODE_PORT} on ${#BACK_HOSTS[@]} back host(s)"
    ALLOWED_IPS=("${BACK_WHITELIST_IPS[@]}")
    for host_entry in "${BACK_HOSTS[@]}"; do
      apply_ufw_rules_for_host "${host_entry}" "${BACK_REMOTE_USER}" "${BACK_SSH_PORT}" "${BACK_KEY_PATH}" "${NODE_PORT}"
    done
  fi

  # BACK_HOSTS → Redis port (6379) on REDIS_HOST — allow each back server to reach Redis
  # Only applies when REDIS_HOST is defined and there are multiple back hosts on different servers
  if [[ -n "${REDIS_HOST_VALUE:-}" && "${#BACK_HOSTS[@]}" -gt 0 ]]; then
    local redis_back_ips=()
    for host_entry in "${BACK_HOSTS[@]}"; do
      read -r _ bhost <<<"$(parse_host_entry "${host_entry}" "${BACK_REMOTE_USER}")"
      # Only add if the back host is NOT the Redis host (colocated backs reach Redis via Docker network)
      if [[ "${bhost}" != "${REDIS_HOST_VALUE}" ]]; then
        redis_back_ips+=("${bhost}")
      fi
    done
    if [[ "${#redis_back_ips[@]}" -gt 0 ]]; then
      echo "==> [FIREWALL] BACK_HOSTS (external) → Redis port 6379 on ${REDIS_HOST_VALUE}"
      ALLOWED_IPS=("${redis_back_ips[@]}")
      apply_ufw_rules_for_host "${REDIS_HOST_VALUE}" "${BACK_REMOTE_USER}" "${BACK_SSH_PORT}" "${BACK_KEY_PATH}" "6379"
    fi
  fi

  # CLOUDFLARE → NODE_PORT on back hosts (when front is on Cloudflare Pages)
  # if [[ "${#CLOUDFLARE_IPS[@]}" -gt 0 && -n "${NODE_PORT:-}" && "${#BACK_HOSTS[@]}" -gt 0 ]]; then
  #   echo "==> [FIREWALL] CLOUDFLARE → NODE_PORT=${NODE_PORT} on ${#BACK_HOSTS[@]} back host(s) (${#CLOUDFLARE_IPS[@]} ranges)"
  #   ALLOWED_IPS=("${CLOUDFLARE_IPS[@]}")
  #   for host_entry in "${BACK_HOSTS[@]}"; do
  #     apply_ufw_rules_for_host "${host_entry}" "${BACK_REMOTE_USER}" "${BACK_SSH_PORT}" "${BACK_KEY_PATH}" "${NODE_PORT}"
  #   done
  # fi

  # PROXY_HOSTS → NODE_PORT on back hosts (reverse proxy needs to reach the backend)
  if [[ "${#PROXY_IPS[@]}" -gt 0 && -n "${NODE_PORT:-}" && "${#BACK_HOSTS[@]}" -gt 0 ]]; then
    echo "==> [FIREWALL] PROXY_HOSTS → NODE_PORT=${NODE_PORT} on ${#BACK_HOSTS[@]} back host(s)"
    ALLOWED_IPS=("${PROXY_IPS[@]}")
    for host_entry in "${BACK_HOSTS[@]}"; do
      apply_ufw_rules_for_host "${host_entry}" "${BACK_REMOTE_USER}" "${BACK_SSH_PORT}" "${BACK_KEY_PATH}" "${NODE_PORT}"
    done
  fi
}

stage_back_db_cert_if_present() {
  local dest_dir="$1"
  if [[ -z "${DB_SSLROOTCERT:-}" ]]; then
    return
  fi
  local source_cert="./back/${DB_SSLROOTCERT}"
  if [[ ! -f "${source_cert}" ]]; then
    return
  fi
  mkdir -p "${dest_dir}"
  echo "==> [LOCAL] Including back/${DB_SSLROOTCERT} in ${dest_dir}"
  rsync -a "${source_cert}" "${dest_dir}/${DB_SSLROOTCERT}"
}

# A project's optional prod→preprod cross-env admin publish feature (Workshop graphs, CMS
# content, tiers/features… see nestcommon's CrossEnvDbConnection.ts) needs the PREPROD
# database's credentials at runtime. This can NOT be a bind-mounted file: `back` is deployed via
# `docker --context ssh://… compose --project-directory <local-tmp-dir> up`, which runs the
# Compose CLI on THIS machine — `env_file:`/`build:` are resolved/streamed client-side (no file
# needs to exist on the remote host), but a `volumes:` bind mount only ever sends a host PATH to
# the remote daemon, which resolves it against ITS OWN filesystem; a local build-context tmpdir
# path doesn't exist there, so Docker silently creates an empty directory and mounts that instead
# (crashes the feature with EISDIR at read time, discovered the hard way in prod on 2026-09-22).
# So instead: read `back/.env.preprod`'s DB_* keys locally and append them, re-prefixed
# `CROSSENV_TARGET_`, straight into the build context's `back/.env` — the file `env_file:`
# already delivers reliably. A project without such a `back/.env.preprod` gets nothing appended
# (CrossEnvDbConnection then reports "not configured" at call time, same as before — never blocks
# the deploy of a project that doesn't use the feature).
stage_back_env_preprod() {
  local dest_env_file="$1"
  local source_file="./back/.env.preprod"
  if [[ ! -f "${source_file}" ]]; then
    return
  fi
  echo "==> [LOCAL] Injecting CROSSENV_TARGET_DB_* (from back/.env.preprod) into back/.env"
  {
    echo ""
    grep -E '^(DB_HOST|DB_PORT|DB_USER|DB_PASSWORD|DB_NAME|DB_SSLMODE|DB_SSLROOTCERT)=' "${source_file}" | sed -E 's/^/CROSSENV_TARGET_/'
  } >> "${dest_env_file}"
}

# ======================
# HOST LISTS & SSH KEYS
# ======================
FRONT_KEY_PATH="$(resolve_key_path "${FRONT_SSH_KEY_FILE}")"
BACK_KEY_PATH="$(resolve_key_path "${BACK_SSH_KEY_FILE}")"

FRONT_HOSTS=()
if [[ -n "${FRONT_HOSTS_RAW}" ]]; then
  while IFS= read -r host; do
    FRONT_HOSTS+=("${host}")
  done < <(parse_hosts "${FRONT_HOSTS_RAW}")
fi
if [[ "${#FRONT_HOSTS[@]}" -eq 0 && "${IS_CLOUD_FRONT}" -eq 0 ]]; then
  echo "Error: FRONT_HOSTS resolved to zero hosts after parsing."
  exit 1
fi

BACK_HOSTS=()
BACK_HOST_NAME_LIST=()
while IFS= read -r host; do
  if [[ -z "${host}" ]]; then
    continue
  fi
  BACK_HOSTS+=("${host}")
  read -r _ parsed_host <<<"$(parse_host_entry "${host}" "${BACK_REMOTE_USER}")"
  BACK_HOST_NAME_LIST+=("${parsed_host}")
done < <(parse_hosts "${BACK_HOSTS_RAW}")
if [[ "${#BACK_HOSTS[@]}" -eq 0 ]]; then
  echo "Error: BACK_HOSTS resolved to zero hosts after parsing."
  exit 1
fi

is_back_host_name() {
  local query="$1"
  for existing_host in "${BACK_HOST_NAME_LIST[@]}"; do
    if [[ "${existing_host}" == "${query}" ]]; then
      return 0
    fi
  done
  return 1
}

# ======================
# CHECKS
# ======================
# Docker only needed for non-cloud-front targets
if [[ "${DEPLOY_TARGET}" != "front" || "${IS_CLOUD_FRONT}" -eq 0 ]]; then
  require_cmd docker
fi
if [[ "${DEPLOY_TARGET}" != "front" || "${IS_CLOUD_FRONT}" -eq 0 ]]; then
  require_cmd ssh
  require_cmd scp
fi
require_cmd python3
if [[ "${ROLLBACK_MODE}" != "1" ]]; then
  require_cmd rsync
  require_cmd git
  require_cmd node
fi

# Every ssh / scp / docker call below rides on one SSH connection per host (lib/ssh-mux.sh).
ssh_mux_enable
trap 'ssh_mux_close; dt_summary; restore_deploy_branch' EXIT   # extended with the build-dir cleanup once those exist (BUILD CONTEXT PREP)

# ======================
# SHARED DOCKER FILES (homogeneity)
# ======================
# Every project builds from the template's Dockerfiles, .dockerignore and nginx.conf (config-links.json): a project
# copy, or a link to anything else, is refused before anything is built (template CLAUDE.md, « Template files »).
if [[ "${ROLLBACK_MODE}" != "1" ]]; then
  node "${SCRIPT_DIR}/link-config.mjs" --check --only=back/Dockerfile,back/.dockerignore,front/Dockerfile,front/nginx.conf "${PROJECT_ROOT}" \
    || { err "Shared Docker files differ from the template — fix them before deploying (see above)."; exit 1; }
fi

# ======================
# SHARED LIB SUBMODULES
# ======================
# Ensure the shared-library git submodules (.libs/{vx-public,vx-private}) are present
# BEFORE staging the build context. Staging uses `rsync -aL`, which dereferences the
# `src/modules_shared/*` symlinks and `.libs/apptemplate` into the library checkouts; on
# a fresh checkout those submodules are empty → dangling symlinks → the build fails.
# Idempotent. No-op for projects without .gitmodules.
# Works for monorepos (one .gitmodules at root) and split back/front repos.
#
# DEPLOY_LIBS_SYNCED=1 (exported by run.sh after a successful update_common.sh): the library mounts were just brought
# to origin/main, so fetching them again is pure network time; only a submodule that is not checked out yet is
# initialised (update_common.sh skips those).

sync_submodules_of() {
  local top="$1" path
  if [[ "${DEPLOY_LIBS_SYNCED:-0}" != "1" ]]; then
    info "Initialisation des submodules (.libs) — ${top}"
    git -C "${top}" submodule update --init --remote \
      || warn "git submodule update a échoué pour ${top} (build risque d'échouer sur modules_shared)."
    return 0
  fi
  while read -r _ path; do
    [[ -n "${path}" && ! -e "${top}/${path}/.git" ]] || continue
    info "Initialisation du submodule ${path} — ${top}"
    git -C "${top}" submodule update --init --remote -- "${path}" \
      || warn "git submodule update a échoué pour ${top}/${path} (build risque d'échouer sur modules_shared)."
  done < <(git -C "${top}" config -f .gitmodules --get-regexp '^submodule\..*\.path$' 2>/dev/null || true)
}

__t0="$(dt_now)"
__seen_submodule_tops=""
for __side in back front; do
  [[ "${ROLLBACK_MODE}" != "1" ]] || continue   # rollback never touches the working tree
  [[ -d "./${__side}" ]] || continue
  __top="$(git -C "./${__side}" rev-parse --show-toplevel 2>/dev/null)" || continue
  [[ -f "${__top}/.gitmodules" ]] || continue
  case " ${__seen_submodule_tops} " in *" ${__top} "*) continue ;; esac
  __seen_submodule_tops="${__seen_submodule_tops} ${__top}"
  sync_submodules_of "${__top}"
done
[[ -z "${__seen_submodule_tops}" ]] || dt_record "submodules ($([[ "${DEPLOY_LIBS_SYNCED:-0}" == "1" ]] && echo "init only, synced by update_common" || echo "fetch --remote"))" "${__t0}"
unset __seen_submodule_tops __side __top __t0

COMPOSE_FILE_ABS="./${COMPOSE_FILE_PATH}"
if [[ ! -f "${COMPOSE_FILE_ABS}" ]]; then
  echo "Error: ${COMPOSE_FILE_ABS} not found at repo root."
  exit 1
fi

if [[ ! -f "${FRONT_ENV_FILE}" ]]; then
  echo "Error: ${FRONT_ENV_FILE} not found."
  exit 1
fi

if [[ ! -f "${BACK_ENV_FILE}" ]]; then
  echo "Error: ${BACK_ENV_FILE} not found."
  exit 1
fi

# Redis consistency check — must be done early so the user gets a clear error before any build
REDIS_HOST_VALUE="${REDIS_HOST:-}"
REDIS_URL_VALUE="${REDIS_URL:-}"
if [[ -n "${REDIS_HOST_VALUE}" && -z "${REDIS_URL_VALUE}" ]]; then
  echo "Error: REDIS_HOST is set to '${REDIS_HOST_VALUE}' but REDIS_URL is not defined."
  echo "       Set REDIS_URL to the connection URL that back containers will use (e.g. redis://<host>:6379)."
  exit 1
fi

# ======================
# BUILD CONTEXT PREP (symlinks resolved)
# ======================
BUILD_CONTEXT_DIR=$(mktemp -d "${TMPDIR:-/tmp}/${PROJECT_NAME}-build-context.XXXXXX")
FRONT_BUILD_DIR="${FRONT_BUILD_DIR:-./front_build}"
BACK_BUILD_DIR="${BACK_BUILD_DIR:-./back_build}"
cleanup_context() {
  if [[ "${KEEP_BUILD_CONTEXT}" == "1" ]]; then
    if [[ -n "${BUILD_CONTEXT_DIR:-}" && -d "${BUILD_CONTEXT_DIR}" ]]; then
      echo "==> KEEP_BUILD_CONTEXT=1: skipping cleanup for ${BUILD_CONTEXT_DIR}"
    fi
    return
  fi
  if [[ -n "${BUILD_CONTEXT_DIR:-}" && -d "${BUILD_CONTEXT_DIR}" ]]; then
    rm -rf "${BUILD_CONTEXT_DIR}"
  fi
}
cleanup_front_build() {
  if [[ "${KEEP_BUILD_CONTEXT}" == "1" ]]; then
    return
  fi
  if [[ -n "${FRONT_BUILD_DIR:-}" && -d "${FRONT_BUILD_DIR}" ]]; then
    rm -rf "${FRONT_BUILD_DIR}"
  fi
}
cleanup_back_build() {
  if [[ "${KEEP_BUILD_CONTEXT}" == "1" ]]; then
    return
  fi
  if [[ -n "${BACK_BUILD_DIR:-}" && -d "${BACK_BUILD_DIR}" ]]; then
    rm -rf "${BACK_BUILD_DIR}"
  fi
}
trap 'cleanup_context; cleanup_front_build; cleanup_back_build; ssh_mux_close; dt_summary; restore_deploy_branch' EXIT

# .cache / logs are runtime artefacts: already excluded by back/.dockerignore, so they never
# reach an image — but staging them still cost two full local copies per deploy (measured
# 10,3 s each for a 1,7 Go backtest cache, plus the rm -rf that precedes them).
RSYNC_DIR_EXCLUDES=(
  "--exclude=.git"
  "--exclude=.gitignore"
  "--exclude=node_modules"
  "--exclude=dist"
  "--exclude=coverage"
  "--exclude=.turbo"
  "--exclude=.next"
  "--exclude=deploy-context"
  "--exclude=.cache"
  "--exclude=logs"
)
CONTEXT_DIRS=("front" "back")
CONTEXT_FILES=("${COMPOSE_FILE_PATH}")

sync_dir_into_context() {
  local src_dir="$1"
  local dest_dir="$2"
  if [[ ! -d "${src_dir}" ]]; then
    echo "Error: required directory '${src_dir}' not found."
    exit 1
  fi
  mkdir -p "${dest_dir}"
  rsync -aL --delete "${RSYNC_DIR_EXCLUDES[@]}" "${src_dir}/" "${dest_dir}/" || {
    echo "Error: rsync failed while staging '${src_dir}'."
    exit 1
  }
}

sync_file_into_context() {
  local src_file="$1"
  local dest_file="$2"
  if [[ ! -f "${src_file}" ]]; then
    echo "Error: required file '${src_file}' not found."
    exit 1
  fi
  mkdir -p "$(dirname "${dest_file}")"
  rsync -a "${src_file}" "${dest_file}" || {
    echo "Error: rsync failed while staging '${src_file}'."
    exit 1
  }
}

# Fail LOUDLY (instead of letting `rsync -aL` exit non-zero and `set -e` kill us with no
# message) when a source tree contains a dangling symlink — typically a modules_shared/* link
# whose nestcommon/reactcommon target was removed. Lists every offender with a fix hint.
assert_no_broken_symlinks() {
  local scan_dir="$1"
  [[ -d "${scan_dir}" ]] || return 0
  local broken=()
  local link
  while IFS= read -r link; do
    if [[ ! -e "${link}" ]]; then
      broken+=("${link} -> $(readlink "${link}")")
    fi
  done < <(find "${scan_dir}" \( -name node_modules -o -name .git -o -name dist \) -prune -o -type l -print)
  if (( ${#broken[@]} > 0 )); then
    err "Aborting: ${#broken[@]} broken symlink(s) under '${scan_dir}'."
    err "rsync -L follows these dangling links and fails — fix them before deploying:"
    local b
    for b in "${broken[@]}"; do
      printf "    ✗ %s\n" "${b}" >&2
    done
    err "Hint: run 'node back/scripts/link-shared.mjs && node front/scripts/link-shared.mjs' to recreate library links, or remove the stale symlink if the module was intentionally deleted."
    exit 1
  fi
}

stage_symlinked_modules() {
  local project="$1"
  local source_base="$2"
  local project_root="${BUILD_CONTEXT_DIR}/${project}"
  local shared_root="${project_root}/.shared-modules"
  mkdir -p "${shared_root}"

  local modules_dirs=("${source_base}/src/modules" "${source_base}/src/modules_shared")
  for modules_dir in "${modules_dirs[@]}"; do
    if [[ ! -d "${modules_dir}" ]]; then
      continue
    fi
    local rel_modules_dir="${modules_dir#"${source_base}"/}"
    while IFS= read -r symlink_path; do
      local link_name
      link_name=$(basename "${symlink_path}")
      local resolved_path
      resolved_path=$(resolve_realpath "${symlink_path}" || true)
      if [[ -z "${resolved_path}" || ! -d "${resolved_path}" ]]; then
        echo "Warning: symlink target for ${symlink_path} not found, skipping."
        continue
      fi
      local dest_dir="${shared_root}/${link_name}"
      echo "==> [LOCAL] Staging symlinked module '${project}/${rel_modules_dir}/${link_name}'"
      sync_dir_into_context "${resolved_path}" "${dest_dir}"
      local context_modules_dir="${project_root}/${rel_modules_dir}"
      if [[ -d "${context_modules_dir}" ]]; then
        local depth
        depth=$(echo "${rel_modules_dir}" | awk -F/ '{print NF}')
        local rel_prefix=""
        for ((i=0; i<depth; i++)); do rel_prefix="../${rel_prefix}"; done
        rm -rf "${context_modules_dir}/${link_name}"
        ln -sf "${rel_prefix}.shared-modules/${link_name}" "${context_modules_dir}/${link_name}"
      fi
    done < <(find "${modules_dir}" -maxdepth 1 -type l)
  done
}

prepare_front_build() {
  echo "==> [LOCAL] Creating temporary front_build (front copy with resolved symlinks)"
  assert_no_broken_symlinks "./front"
  rm -rf "${FRONT_BUILD_DIR}"
  rsync -aL --delete "${RSYNC_DIR_EXCLUDES[@]}" "./front/" "${FRONT_BUILD_DIR}/"
  # App-specific nginx locations (optional front/nginx.locations.conf) at the `# @app-locations` marker of nginx.conf.
  node "${SCRIPT_DIR}/merge-nginx-locations.mjs" "${FRONT_BUILD_DIR}/nginx.conf" "${FRONT_BUILD_DIR}/nginx.locations.conf" \
    || { err "[LOCAL] front/nginx.locations.conf could not be merged into nginx.conf"; exit 1; }
}

prepare_back_build() {
  echo "==> [LOCAL] Creating temporary back_build (back copy with resolved symlinks)"
  assert_no_broken_symlinks "./back"
  rm -rf "${BACK_BUILD_DIR}"
  rsync -aL --delete "${RSYNC_DIR_EXCLUDES[@]}" "./back/" "${BACK_BUILD_DIR}/"

  # Copy .tgz files explicitly (local npm packages)
  for tgz_file in ./back/*.tgz; do
    if [[ -f "${tgz_file}" ]]; then
      cp "${tgz_file}" "${BACK_BUILD_DIR}/"
    fi
  done

  stage_back_db_cert_if_present "${BACK_BUILD_DIR}"
}

# Local `npm install` of a stack, skipped when nothing it depends on changed since the last install made here: a no-op
# install still costs 5-15 s per stack and per deploy. package.json is regenerated first (build-package.mjs, normally
# run by `prebuild`, i.e. AFTER the install), so a dependency added to package.base.json or to a module fragment always
# reaches node_modules before the build. The stamp (hash of package.json + package-lock.json + Node version) lives in
# node_modules: deleting node_modules forces an install. DEPLOY_NPM_INSTALL=always installs every time.
npm_install_if_changed() {
  local stack="$1" stamp="$1/node_modules/.vx-deploy-install" sum
  if [[ -f "${stack}/.libs/apptemplate/scripts/build-package.mjs" ]]; then
    (cd "${stack}" && node .libs/apptemplate/scripts/build-package.mjs "${stack}" >/dev/null) \
      || { warn "[LOCAL] ${stack}: package.json regeneration failed"; return 1; }
  fi
  sum="$(stack_install_hash "${stack}")"
  if [[ "${DEPLOY_NPM_INSTALL:-auto}" != "always" && -f "${stamp}" && "$(cat "${stamp}")" == "${sum}" ]]; then
    info "[LOCAL] ${stack}: package.json, package-lock.json and Node unchanged since the last install — npm install skipped"
    return 0
  fi
  (cd "${stack}" && npm install --no-audit --no-fund) || return 1
  # Hashed again: npm install may have updated package-lock.json.
  if [[ -d "${stack}/node_modules" ]]; then stack_install_hash "${stack}" > "${stamp}"; fi
}

stack_install_hash() {
  { cat "$1/package.json" "$1/package-lock.json" 2>/dev/null; node --version; } \
    | python3 -c 'import hashlib, sys; print(hashlib.sha256(sys.stdin.buffer.read()).hexdigest())'
}

# Copies the template's prebuilt Dockerfile and whitelist .dockerignore (<stack>/Dockerfile.prebuilt and
# <stack>/.dockerignore.prebuilt, shared by every project) over the staged build dir of a stack built locally.
use_prebuilt_docker_files() {
  local stack="$1" dir="$2" src="${TEMPLATE_ROOT}/$1"
  if [[ ! -f "${src}/Dockerfile.prebuilt" || ! -f "${src}/.dockerignore.prebuilt" ]]; then
    warn "[LOCAL] ${src}/Dockerfile.prebuilt or .dockerignore.prebuilt missing — ${stack} will be built on remote"
    return 1
  fi
  cp "${src}/Dockerfile.prebuilt" "${dir}/Dockerfile"
  cp "${src}/.dockerignore.prebuilt" "${dir}/.dockerignore"
}

# Builds the front locally (Mac npm cache + local CPU) and rewrites the Dockerfile
# in FRONT_BUILD_DIR to a minimal prebuilt variant (nginx COPY only).
# Falls back silently to remote build on any failure.
build_front_locally() {
  if [[ "${IS_CLOUD_FRONT}" -eq 1 ]]; then
    return 1
  fi
  if ! command -v npm &>/dev/null; then
    warn "[LOCAL] npm not found — front will be built on remote"
    return 1
  fi

  info "[LOCAL] Building front locally (warm npm cache + local CPU)..."

  # Never skipped just because node_modules exists: it can be STALE relative to package.json (see
  # npm_install_if_changed, which regenerates package.json and compares hashes).
  info "[LOCAL] Installing front dependencies..."
  local t0
  t0="$(dt_now)"
  npm_install_if_changed front || { warn "[LOCAL] Front install failed — building on remote"; return 1; }
  dt_record "front: npm install (local, skipped when unchanged)" "${t0}"

  t0="$(dt_now)"
  if ! (cd front && npm run build); then
    warn "[LOCAL] Front build failed — building on remote"
    return 1
  fi
  dt_record "front: build (local, tsc -b + vite)" "${t0}"

  # Copy resulting dist into the staged build dir
  rsync -a --delete "./front/dist/" "${FRONT_BUILD_DIR}/dist/"

  # Process nginx.conf locally: substitute ${NODE_PORT} now so the Docker image
  # does not need a build ARG or runtime envsubst (which would fail because
  # NODE_PORT is not a runtime env var in the front container).
  if [[ -z "${NODE_PORT:-}" ]]; then
    err "[LOCAL] NODE_PORT is not set — cannot process nginx.conf (check back/.env)"; exit 1
  fi
  if [[ ! -f "${FRONT_BUILD_DIR}/nginx.conf" ]]; then
    err "[LOCAL] ${FRONT_BUILD_DIR}/nginx.conf not found — cannot process template"; exit 1
  fi
  envsubst '${NODE_PORT}' < "${FRONT_BUILD_DIR}/nginx.conf" > "${FRONT_BUILD_DIR}/nginx.conf.processed"
  mv "${FRONT_BUILD_DIR}/nginx.conf.processed" "${FRONT_BUILD_DIR}/nginx.conf"
  info "[LOCAL] nginx.conf: \${NODE_PORT} → ${NODE_PORT}"

  # Replace Dockerfile with the template's prebuilt variant (no npm, no vite on remote) and its whitelist
  # .dockerignore (only nginx.conf + dist are streamed to the remote daemon).
  # nginx.conf is already processed above — no ARG/envsubst needed at build or runtime.
  use_prebuilt_docker_files front "${FRONT_BUILD_DIR}" || return 1

  success "[LOCAL] Front built locally — remote will only run nginx COPY"
  return 0
}

# Builds the back locally (Mac npm cache + local CPU) and rewrites the Dockerfile
# in BACK_BUILD_DIR to a minimal prebuilt variant (prod-deps + runtime COPY only).
# Falls back silently to remote build on any failure.
build_back_locally() {
  if ! command -v npm &>/dev/null; then
    warn "[LOCAL] npm not found — back will be built on remote"
    return 1
  fi

  info "[LOCAL] Building back locally (local CPU + npm cache)..."

  # Never skipped just because node_modules exists: it can be STALE relative to package.json. Proven live
  # 2026-08-22: otplib/qrcode were added to package.base.json the day before, node_modules already existed
  # from an older install, a guard on its existence skipped npm install and `nest build` failed with "Cannot
  # find module 'otplib'". npm_install_if_changed regenerates package.json first and compares hashes.
  info "[LOCAL] Installing back dependencies..."
  local t0
  t0="$(dt_now)"
  npm_install_if_changed back || { warn "[LOCAL] Back install failed — building on remote"; return 1; }
  dt_record "back: npm install (local, skipped when unchanged)" "${t0}"

  t0="$(dt_now)"
  if ! (cd back && npm run build); then
    warn "[LOCAL] Back build failed — building on remote"
    return 1
  fi
  dt_record "back: build (local, nest build)" "${t0}"

  if [[ ! -d "./back/dist" ]]; then
    warn "[LOCAL] Back dist not found after build — building on remote"
    return 1
  fi

  # Collect locale JSONs locally (mirrors the Docker builder's find step).
  # BACK_BUILD_DIR has symlinks resolved via rsync -aL — use it as module source.
  local locales_dir="${BACK_BUILD_DIR}/_prebuilt_locales"
  rm -rf "${locales_dir}"
  mkdir -p "${locales_dir}/app" "${locales_dir}/modules/src"
  if [[ -d "./back/src/locales" ]]; then
    cp -r ./back/src/locales/* "${locales_dir}/app/" 2>/dev/null || true
  fi
  for _mdir in "${BACK_BUILD_DIR}/src/modules" "${BACK_BUILD_DIR}/src/modules_shared"; do
    [[ -d "${_mdir}" ]] || continue
    while IFS= read -r _f; do
      _rel="${_f#${BACK_BUILD_DIR}/}"
      mkdir -p "${locales_dir}/modules/$(dirname "${_rel}")"
      cp "${_f}" "${locales_dir}/modules/${_rel}"
    done < <(find -L "${_mdir}" -path '*/locales/*.json' 2>/dev/null)
  done

  # Sentinel so the optional *.crt COPY in the Dockerfile never fails when no cert exists.
  local _has_crt=0
  for _f in "${BACK_BUILD_DIR}"/*.crt; do
    [[ -f "${_f}" ]] && { _has_crt=1; break; }
  done
  [[ ${_has_crt} -eq 0 ]] && touch "${BACK_BUILD_DIR}/.no-cert.crt"

  # The template's prebuilt variant (builder stage eliminated) replaces the staged Dockerfile — the one both compose
  # files build — and its whitelist .dockerignore replaces the canonical one: the canonical file excludes `dist`
  # (right for the remote build, where dist comes from the builder stage) while the prebuilt image copies the locally
  # compiled dist, and only package*.json, *.tgz, *.crt, dist and the `_*` staged entries reach the remote daemon
  # (never src/ nor the resolved .libs). Only the staged copies change, never the project's symlinked files.
  use_prebuilt_docker_files back "${BACK_BUILD_DIR}" || return 1

  # Project-owned post-build hook (opt-in, same pattern as RUNNER_PROVISION_HOOK below): receives
  # BACK_BUILD_DIR and may stage extras into the image context (e.g. a runner install
  # payload for UI-triggered remote deploys). Missing/non-executable by default — strict no-op.
  if [[ -n "${BACK_BUILD_HOOK:-}" && -x "${BACK_BUILD_HOOK}" ]]; then
    "${BACK_BUILD_HOOK}" "${BACK_BUILD_DIR}" \
      || warn "[LOCAL] BACK_BUILD_HOOK failed — continuing without staged extras"
  fi

  success "[LOCAL] Back built locally — remote will only run prod npm ci + runtime packaging"
  return 0
}

# Rollback mode (--rollback) builds nothing: it stages its own minimal context (see run_manual_rollback).
if [[ "${ROLLBACK_MODE}" != "1" ]]; then
FRONT_PREBUILT=0
BACK_PREBUILT=0
echo "==> [LOCAL] Preparing build context"
__t0="$(dt_now)"
if [[ "${DEPLOY_TARGET}" != "back" ]]; then
  # Cloud front builds directly from ./front/ — no need to create a copy
  if [[ "${IS_CLOUD_FRONT}" -eq 0 ]]; then
    prepare_front_build
    dt_record "front: stage build dir (rsync -aL)" "${__t0}"
    if build_front_locally; then
      FRONT_PREBUILT=1
    fi
  fi
fi
if [[ "${DEPLOY_TARGET}" != "front" ]]; then
  __t0="$(dt_now)"
  prepare_back_build
  dt_record "back: stage build dir (rsync -aL)" "${__t0}"
  if build_back_locally; then
    BACK_PREBUILT=1
  fi
fi

__t0="$(dt_now)"
for dir in "${CONTEXT_DIRS[@]}"; do
  if [[ "${dir}" == "front" && "${DEPLOY_TARGET}" == "back" ]]; then
    continue
  fi
  if [[ "${dir}" == "back" && "${DEPLOY_TARGET}" == "front" ]]; then
    if [[ "${IS_CLOUD_FRONT}" -eq 1 ]]; then
      continue
    fi
    # Docker front-only: sync raw ./back for compose file parsing (back service won't be built)
    sync_dir_into_context "./back" "${BUILD_CONTEXT_DIR}/back"
    continue
  fi
  if [[ "${dir}" == "front" ]]; then
    # Cloud front is built and deployed directly from ./front/ — no Docker context needed
    if [[ "${IS_CLOUD_FRONT}" -eq 1 ]]; then
      continue
    fi
    sync_dir_into_context "${FRONT_BUILD_DIR}" "${BUILD_CONTEXT_DIR}/front"
    # dist is excluded by RSYNC_DIR_EXCLUDES — copy it separately when pre-built locally
    if [[ "${FRONT_PREBUILT}" == "1" ]]; then
      mkdir -p "${BUILD_CONTEXT_DIR}/front/dist"
      rsync -a --delete "./front/dist/" "${BUILD_CONTEXT_DIR}/front/dist/"
    fi
  elif [[ "${dir}" == "back" ]]; then
    sync_dir_into_context "${BACK_BUILD_DIR}" "${BUILD_CONTEXT_DIR}/back"
    # dist is excluded by RSYNC_DIR_EXCLUDES — copy it separately when pre-built locally.
    # Sourcemaps and .d.ts are stripped from the STAGED copy only: nothing loads them at
    # runtime, they are ~55% of dist's weight (17 Mo -> 8 Mo, over an SSH tunnel), and
    # ./back/dist keeps them so `nest start --debug` still maps breakpoints locally.
    if [[ "${BACK_PREBUILT}" == "1" ]]; then
      mkdir -p "${BUILD_CONTEXT_DIR}/back/dist"
      rsync -a --delete \
        --exclude='*.js.map' --exclude='*.d.ts' \
        "./back/dist/" "${BUILD_CONTEXT_DIR}/back/dist/"
    fi
  else
    sync_dir_into_context "./${dir}" "${BUILD_CONTEXT_DIR}/${dir}"
  fi
done

for file in "${CONTEXT_FILES[@]}"; do
  # Skip files not needed for the target
  if [[ "${file}" == front/* && "${DEPLOY_TARGET}" == "back" ]]; then
    continue
  fi
  if [[ -f "./${file}" ]]; then
    sync_file_into_context "./${file}" "${BUILD_CONTEXT_DIR}/${file}"
  fi
done
# Env files: staged as back/.env / front/.env in the context regardless of the source filename
# (compose and the container always look for .env, but the source may be .env.preprod etc.)
if [[ "${DEPLOY_TARGET}" != "front" ]]; then
  sync_file_into_context "${BACK_ENV_FILE}" "${BUILD_CONTEXT_DIR}/back/.env"
  stage_back_env_preprod "${BUILD_CONTEXT_DIR}/back/.env"
  dv_env_set "${BUILD_CONTEXT_DIR}/back/.env" "DEPLOY_REVISION" "${DEPLOY_REVISION}"
  # What is uploaded as the remote .env (and swapped by rollbacks): the staged env, before the per-host patches.
  cp "${BUILD_CONTEXT_DIR}/back/.env" "${BUILD_CONTEXT_DIR}/.env.remote"
fi
if [[ "${DEPLOY_TARGET}" != "back" ]]; then
  sync_file_into_context "${FRONT_ENV_FILE}" "${BUILD_CONTEXT_DIR}/front/.env"
fi
# Provide a root .env in the staged context so compose interpolation works without needing repo .env
sync_file_into_context "${BACK_ENV_FILE}" "${BUILD_CONTEXT_DIR}/.env"

# vmagent.yml is referenced as a Docker Compose config (file: ./vmagent.yml) in docker-compose.yml.
# With a remote Docker context, Docker CLI reads this file locally and sends its content to the
# remote daemon — the file must exist in the build context root alongside docker-compose.yml.
if [[ "${DEPLOY_TARGET}" != "front" && -f "scripts/vmagent.yml" ]]; then
  sync_file_into_context "scripts/vmagent.yml" "${BUILD_CONTEXT_DIR}/vmagent.yml"
fi

dt_record "stage compose context" "${__t0}"
echo "==> [LOCAL] Build context staged at ${BUILD_CONTEXT_DIR}"
if [[ "${KEEP_BUILD_CONTEXT}" == "1" ]]; then
  echo "==> KEEP_BUILD_CONTEXT=1: artifacts remain at ${BUILD_CONTEXT_DIR} for inspection"
fi

# Ensure docker compose finds a default file inside the staged context
STAGED_COMPOSE_FILE="${BUILD_CONTEXT_DIR}/${COMPOSE_FILE_PATH}"
if [[ ! -f "${STAGED_COMPOSE_FILE}" ]]; then
  echo "Error: compose file '${COMPOSE_FILE_PATH}' missing from build context (${STAGED_COMPOSE_FILE})."
  exit 1
fi
if [[ "${STAGED_COMPOSE_FILE}" != "${BUILD_CONTEXT_DIR}/docker-compose.yml" ]]; then
  cp "${STAGED_COMPOSE_FILE}" "${BUILD_CONTEXT_DIR}/docker-compose.yml"
fi
# Rewrite relative paths: compose files use ../back and ../front (relative to scripts/)
# but in the flat build context they sit next to docker-compose.yml as ./back and ./front
sed -i.bak -e 's|\.\./back|./back|g' -e 's|\.\./front|./front|g' "${BUILD_CONTEXT_DIR}/docker-compose.yml"
rm -f "${BUILD_CONTEXT_DIR}/docker-compose.yml.bak"
fi  # end of the build/staging section (skipped by --rollback)

NODE_PORT_DEFAULT=9741
VITE_PORT_DEFAULT=3900
NODE_PORT_VALUE=$(extract_env_value "${BACK_ENV_FILE}" "NODE_PORT" || true)
VITE_PORT_VALUE=$(extract_env_value "${FRONT_ENV_FILE}" "VITE_PORT" || true)
export NODE_PORT="${NODE_PORT_VALUE:-${NODE_PORT:-$NODE_PORT_DEFAULT}}"
export VITE_PORT="${VITE_PORT_VALUE:-${VITE_PORT:-$VITE_PORT_DEFAULT}}"
echo "==> Using NODE_PORT=${NODE_PORT}, VITE_PORT=${VITE_PORT}"

if [[ "${IS_CLOUD_FRONT}" -eq 1 ]]; then
  echo "==> Cloud front detected (VITE_API_URL=${VITE_API_URL_VALUE})"
  echo "==> Front will be deployed to Cloudflare Pages (project: ${CLOUDFLARE_PAGES_PROJECT})"
fi

# ======================
# MULTI-HOST DEPLOYMENT HELPERS
# ======================

# Maintenance mode toggle for back-lb (see the maintenance.flag `if` block added to its
# generated nginx conf in docker-compose.yml / docker-compose-cloud.yml). back-lb is
# deliberately never stopped/recreated by deploy_back_host below — these just touch/remove
# a file inside its already-running container, so NODE_PORT is never actually closed. A
# project on its very first-ever back deploy has no back-lb yet (nothing public to
# protect), so both are no-ops when the container doesn't exist.
enable_back_maintenance() {
  local context_name="$1" docker_ssh_command="$2" target_host="$3"
  local lb_container="${COMPOSE_PROJECT_NAME}_back_lb"
  if ! DOCKER_SSH_COMMAND="${docker_ssh_command}" docker --context "${context_name}" inspect "${lb_container}" >/dev/null 2>&1; then
    return 0
  fi
  info "[BACK:${target_host}] Enabling maintenance mode (${lb_container})"
  DOCKER_SSH_COMMAND="${docker_ssh_command}" docker --context "${context_name}" exec "${lb_container}" \
    touch /etc/nginx/maintenance.flag \
    || warn "[BACK:${target_host}] Could not enable maintenance mode on ${lb_container} — continuing without it"
}

disable_back_maintenance() {
  local context_name="$1" docker_ssh_command="$2" target_host="$3"
  local lb_container="${COMPOSE_PROJECT_NAME}_back_lb"
  if ! DOCKER_SSH_COMMAND="${docker_ssh_command}" docker --context "${context_name}" inspect "${lb_container}" >/dev/null 2>&1; then
    return 0
  fi
  if DOCKER_SSH_COMMAND="${docker_ssh_command}" docker --context "${context_name}" exec "${lb_container}" \
      rm -f /etc/nginx/maintenance.flag; then
    success "[BACK:${target_host}] Maintenance mode disabled — back-lb resumed proxying"
  else
    warn "[BACK:${target_host}] Could not disable maintenance mode on ${lb_container} — check it manually"
  fi
}

# Polls until every `back` replica reports healthy, or returns 1 after ${max_wait}s. Used
# to decide when it is safe to lift maintenance mode — back-lb's own `depends_on: back:
# condition: service_healthy` no longer applies here since back-lb is never restarted.
wait_for_back_healthy() {
  local context_name="$1" docker_ssh_command="$2" project_name="$3" target_host="$4"
  local max_wait=180 elapsed=0
  info "[BACK:${target_host}] Waiting for the new back replica(s) to become healthy (max ${max_wait}s)..."
  while true; do
    local statuses
    statuses=$(DOCKER_SSH_COMMAND="${docker_ssh_command}" docker --context "${context_name}" compose \
      --project-directory "${BUILD_CONTEXT_DIR}" --project-name "${project_name}" \
      ps --format '{{.Health}}' back 2>/dev/null || true)
    if [[ -n "${statuses}" ]] && ! grep -qv '^healthy$' <<<"${statuses}"; then
      success "[BACK:${target_host}] back is healthy (${elapsed}s)"
      return 0
    fi
    sleep 3
    elapsed=$((elapsed + 3))
    if [[ ${elapsed} -ge ${max_wait} ]]; then
      return 1
    fi
  done
}

# Starts back-worker once back is healthy (BACK_WORKER=on). `--no-deps`: back is already up and must not be recreated
# (it would be if the staged env differs); a no-op with BACK_WORKER=off. Returns the exit status of `up`.
start_back_worker() {
  local context_name="$1" docker_ssh_command="$2" project_name="$3" target_host="$4" vmagent_config="${5:-}"
  if [[ "${BACK_WORKER_ENABLED}" -ne 1 ]]; then return 0; fi
  echo "==> [BACK:${target_host}] Starting back-worker (after back is healthy)"
  VMAGENT_CONFIG_PATH="${vmagent_config}" \
  DOCKER_SSH_COMMAND="${docker_ssh_command}" docker --context "${context_name}" compose \
    --project-directory "${BUILD_CONTEXT_DIR}" \
    --project-name "${project_name}" \
    up -d --no-build --no-deps back-worker
}

# Starts the services that `depends_on: back: condition: service_healthy` (back-lb, vmagent) once `back` is
# confirmed healthy by wait_for_back_healthy — never bundled into the initial `up -d back ...` (see
# compute_back_services for why). `--no-deps`: back is already up and healthy, so this must not re-trigger that
# same native wait. Best-effort: back-lb is normally unchanged (long-lived, just needs its upstream reloaded
# separately — see the nginx -s reload call after this) and vmagent is a metrics sidecar off the request path;
# neither is worth failing an otherwise good deploy over.
start_back_dependents() {
  local context_name="$1" docker_ssh_command="$2" project_name="$3" target_host="$4" vmagent_config="${5:-}"
  [[ "${#BACK_SERVICES_UP_DEFERRED[@]}" -eq 0 ]] && return 0
  VMAGENT_CONFIG_PATH="${vmagent_config}" \
  DOCKER_SSH_COMMAND="${docker_ssh_command}" docker --context "${context_name}" compose \
    --project-directory "${BUILD_CONTEXT_DIR}" \
    --project-name "${project_name}" \
    up -d --no-build --no-deps "${BACK_SERVICES_UP_DEFERRED[@]}" \
    || warn "[BACK:${target_host}] $(printf '%s ' "${BACK_SERVICES_UP_DEFERRED[@]}")did not (re)start — check manually"
}

# Fills BACK_SERVICES_STOP (stopped at the switch) and BACK_SERVICES_UP (started by `up -d`) for a back host.
# Only the application containers are stopped: db and a colocated Redis keep running through the switch (`up -d`
# recreates them only when their configuration changed), so a deploy never restarts Postgres (cold cache, extra wait)
# nor drops the Redis connections for nothing. vmagent (metrics, not on the request path) is restarted at the switch
# so it always runs the uploaded vmagent.yml.
compute_back_services() {
  local target_host="$1"
  # back-worker is always stopped/removed by a switch (also when BACK_WORKER=off, to drop an existing container), but
  # never part of BACK_SERVICES_UP: start_back_worker starts it once back is healthy (only `back` manages the schema).
  BACK_SERVICES_STOP=("back" "back-worker")
  # `back`'s own dependencies (db, redis) become healthy almost instantly (observed) and are safe to bring up
  # together with it. back-lb and vmagent are started separately, by start_back_dependents, once
  # wait_for_back_healthy's own polling confirms `back` is healthy: both `depends_on: back: condition:
  # service_healthy`, and compose's native wait for that condition — triggered simply by sharing an `up -d` call
  # with `back` — has been observed to give up well before the healthcheck's own start_period/retries budget
  # (TradeKong, 2026-10-29: ~30s elapsed vs. a configured 120s start_period, 3/3 reproductions, `back` itself
  # demonstrably healthy within seconds when inspected directly). Exactly the race start_back_worker below was
  # already written to avoid for back-worker; back-lb/vmagent just never got the same treatment.
  BACK_SERVICES_UP=("back")
  BACK_SERVICES_UP_DEFERRED=("back-lb")
  if [[ "${IS_SELF_HOSTED_DB}" -eq 1 ]]; then
    BACK_SERVICES_UP+=("db")
  fi
  if [[ -n "${REDIS_HOST_VALUE:-}" ]]; then
    local redis_service_host
    read -r _ redis_service_host <<<"$(parse_host_entry "${REDIS_HOST_VALUE}" "${BACK_REMOTE_USER}")"
    if [[ "${target_host}" == "${redis_service_host}" ]]; then
      BACK_SERVICES_UP+=("redis")
    fi
  fi
  if [[ -n "${PROMETHEUS_REMOTE_WRITE_URLS:-}" ]]; then
    BACK_SERVICES_STOP+=("vmagent")
    BACK_SERVICES_UP_DEFERRED+=("vmagent")
  fi
}

# Removes the containers that hold one of the given fixed names (`container_name:` of the compose files) or carry an
# older compose project name of this app's back (`<project>-back-*`, e.g. after a host rename) — but only when they do
# NOT belong to <project_name>: those would block the fixed names, ports or volumes of the new containers. The current
# project's own containers are left to `up -d`, which recreates only what changed, so a running db, Redis or front is
# never killed early. One `docker ps` call (each docker call is an SSH round trip).
remove_foreign_containers() {
  local context_name="$1" docker_ssh_command="$2" project_name="$3" tag="$4"
  shift 4
  local id name proj wanted remove back_prefix
  back_prefix="$(printf '%s-back-' "${COMPOSE_PROJECT_NAME}" | tr '[:upper:]' '[:lower:]')"
  while read -r id name proj; do
    [[ -n "${id}" && "${proj}" != "${project_name}" ]] || continue
    remove=0
    if [[ -n "${proj}" && "${proj}" == "${back_prefix}"* ]]; then remove=1; fi
    for wanted in "$@"; do
      if [[ "${name}" == "${wanted}" ]]; then remove=1; fi
    done
    [[ "${remove}" -eq 1 ]] || continue
    echo "==> [${tag}] Removing leftover container ${name} (compose project '${proj:-none}')"
    DOCKER_SSH_COMMAND="${docker_ssh_command}" docker --context "${context_name}" rm -f "${id}" >/dev/null 2>&1 || true
  done < <(DOCKER_SSH_COMMAND="${docker_ssh_command}" docker --context "${context_name}" \
    ps -a --format '{{.ID}} {{.Names}} {{.Label "com.docker.compose.project"}}' 2>/dev/null || true)
}

# In-place `sed` that works with BSD (macOS) and GNU sed (the empty-suffix form of -i is BSD-only, the bare form GNU-only). The backup suffix
# is distinct from `.env.bak`, which deploy_back_host keeps to restore the public env between hosts.
portable_sed_inplace() {
  local file="$1"; shift
  sed -i.sedtmp "$@" "${file}" && rm -f "${file}.sedtmp"
}

# Patch a staged back env to use Docker-internal service names instead of public hostnames.
# From inside Docker containers on Linux, connecting to the host's own public hostname
# does not work reliably (hairpin NAT). We rewrite REDIS_URL / DB_HOST / DATABASE_URL
# in back/.env (loaded into the back container via env_file) to use the compose service
# names, which resolve via Docker's internal DNS, and always inject SERVER_IP so the backend can
# identify its server for per-server run limits. The root .env (used for compose YAML
# interpolation) is never touched: it must keep the public DB_PORT so the `'${DB_PORT}:5432'`
# port mapping stays correct. Shared by deploys and rollbacks.
patch_back_env_for_host() {
  local env_file="$1" target_host="$2"

  if [[ -n "${REDIS_HOST_VALUE:-}" ]]; then
    local redis_clean_host
    read -r _ redis_clean_host <<<"$(parse_host_entry "${REDIS_HOST_VALUE}" "${BACK_REMOTE_USER}")"
    if [[ "${target_host}" == "${redis_clean_host}" ]]; then
      # The password must be URL-encoded so ioredis parses the URL correctly.
      local encoded_pw
      encoded_pw=$(python3 -c "import urllib.parse,sys; print(urllib.parse.quote(sys.argv[1], safe=''))" "${REDIS_PASSWORD:-}")
      local internal_redis_url="redis://:${encoded_pw}@redis:6379"
      portable_sed_inplace "${env_file}" "s|^REDIS_URL=.*|REDIS_URL=${internal_redis_url}|"
      echo "==> [BACK:${target_host}] Redis colocated — REDIS_URL patched to internal Docker hostname"
    fi
  fi

  if [[ "${IS_SELF_HOSTED_DB}" -eq 1 ]]; then
    local db_user_value db_name_value db_pass_value
    db_user_value="$(extract_env_value "${BACK_ENV_FILE}" "DB_USER" || true)"
    db_name_value="$(extract_env_value "${BACK_ENV_FILE}" "DB_NAME" || true)"
    db_pass_value="$(extract_env_value "${BACK_ENV_FILE}" "DB_PASSWORD" || true)"
    local encoded_db_pw
    encoded_db_pw=$(python3 -c "import urllib.parse,sys; print(urllib.parse.quote(sys.argv[1], safe=''))" "${db_pass_value}")
    local internal_db_url="postgresql://${db_user_value}:${encoded_db_pw}@db:5432/${db_name_value}"
    portable_sed_inplace "${env_file}" \
      -e "s|^DB_HOST=.*|DB_HOST=db|" \
      -e "s|^DB_PORT=.*|DB_PORT=5432|" \
      -e "s|^DATABASE_URL=.*|DATABASE_URL=\"${internal_db_url}\"|"
    echo "==> [BACK:${target_host}] Self-hosted DB — DB_HOST/DB_PORT/DATABASE_URL patched to internal Docker hostname"
  fi

  if grep -q "^SERVER_IP=" "${env_file}"; then
    portable_sed_inplace "${env_file}" "s|^SERVER_IP=.*|SERVER_IP=${target_host}|"
  else
    printf '\nSERVER_IP=%s' "${target_host}" >> "${env_file}"
  fi
  echo "==> [BACK:${target_host}] SERVER_IP set to ${target_host}"
}

# Runs the project's runner provisioning hook for one back host (RUNNER_PROVISION above), `$5` = the
# phase (`before` / `after`, exported as RUNNER_PROVISION_PHASE). Warn-only: returns the hook's status,
# never fails the deploy. A missing hook is said once and counts as done.
run_runner_provision_hook() {
  local ssh_target="$1" ssh_port="$2" key_path="$3" target_host="$4" phase="$5"
  if [[ ! -x "${RUNNER_PROVISION_HOOK}" ]]; then
    info "[BACK:${target_host}] RUNNER_PROVISION=1 but hook '${RUNNER_PROVISION_HOOK}' not found/executable — skipping runner auto-provisioning"
    return 0
  fi
  RUNNER_SSH_TARGET="${ssh_target}" RUNNER_SSH_PORT="${ssh_port}" RUNNER_SSH_KEY="${key_path}" \
  RUNNER_TARGET_HOST="${target_host}" RUNNER_ROTATE="${RUNNER_ROTATE:-0}" RUNNER_PROVISION_PHASE="${phase}" \
    "${RUNNER_PROVISION_HOOK}"
}

deploy_back_host() {
  local entry="$1"
  read -r target_user target_host <<<"$(parse_host_entry "${entry}" "${BACK_REMOTE_USER}")"
  local ssh_target="${target_user}@${target_host}"
  local ssh_port="${BACK_SSH_PORT}"
  local key_path="${BACK_KEY_PATH}"
  local context_name
  context_name="$(build_context_name "${BACK_CONTEXT_NAME}" "${target_host}")"
  local project_name
  project_name="$(build_project_name "back" "${target_host}")"
  local docker_ssh_command="ssh -p ${ssh_port}"
  local -a ssh_opts=("-p" "${ssh_port}")
  local -a scp_opts=("-P" "${ssh_port}")
  if [[ -n "${key_path}" ]]; then
    docker_ssh_command="ssh -i ${key_path} -p ${ssh_port}"
    ssh_opts+=("-i" "${key_path}")
    scp_opts+=("-i" "${key_path}")
  fi

  local t0 t_switch db_backup
  t0="$(dt_now)"
  echo "==> [BACK:${target_host}] Testing SSH connectivity"
  ssh "${ssh_opts[@]}" -o BatchMode=yes -o ConnectTimeout=10 "${ssh_target}" "echo SSH_OK" >/dev/null

  local remote_home
  remote_home=$(ssh "${ssh_opts[@]}" "${ssh_target}" 'printf %s "$HOME"')
  local remote_dir="${BACK_REMOTE_APP_DIR/#\~/${remote_home}}"
  local remote_env_path="${remote_dir}/.env"

  echo "==> [BACK:${target_host}] Preparing remote directory (${remote_dir})"
  ssh "${ssh_opts[@]}" "${ssh_target}" "mkdir -p '${remote_dir}'"

  # Runner auto-provisioning BEFORE this host's new back (RUNNER_PROVISION_ORDER=before): the back still
  # serving there answers the hook; on a failure (no back yet, unreachable API…) it runs again once the
  # new back is healthy, below.
  local runner_provisioned=0
  if [[ "${RUNNER_PROVISION:-0}" == "1" && "${RUNNER_PROVISION_ORDER:-after}" == "before" ]]; then
    echo "==> [BACK:${target_host}] Runner auto-provisioning before the new back (RUNNER_PROVISION_ORDER=before)"
    if run_runner_provision_hook "${ssh_target}" "${ssh_port}" "${key_path}" "${target_host}" before; then
      runner_provisioned=1
    else
      warn "[BACK:${target_host}] Runner auto-provisioning before the back failed — retried once the new back is healthy"
    fi
  fi

  dv_use_host BACK "${target_host}" "${ssh_target}" "${ssh_port}" "${key_path}" "${context_name}" "${project_name}" "${remote_dir}"
  dv_save_env_previous

  echo "==> [BACK:${target_host}] Uploading env file"
  scp "${scp_opts[@]}" "${BUILD_CONTEXT_DIR}/.env.remote" "${ssh_target}:${remote_env_path}"
  ssh "${ssh_opts[@]}" "${ssh_target}" "chmod 600 '${remote_env_path}'" || true

  if [[ -f "scripts/vmagent.yml" ]]; then
    echo "==> [BACK:${target_host}] Uploading vmagent config"
    scp "${scp_opts[@]}" "scripts/vmagent.yml" "${ssh_target}:${remote_dir}/vmagent.yml"
  fi

  ensure_docker_context "${context_name}" "${ssh_target}" "${ssh_port}"

  # Keep the running version as `previous` BEFORE the build overwrites `latest` (rollback target).
  dv_tag_previous "$(dv_back_image)"
  dt_record "back ${target_host}: prepare (ssh, env upload, docker context, tag previous)" "${t0}"

  # back-worker shares the back image (no build section of its own): nothing to build for it when it is off.
  local -a BACK_BUILD_SERVICES=("back")
  if [[ "${BACK_WORKER_ENABLED}" -eq 1 ]]; then BACK_BUILD_SERVICES+=("back-worker"); fi

  echo "==> [BACK:${target_host}] Building service"
  t0="$(dt_now)"
  DOCKER_SSH_COMMAND="${docker_ssh_command}" docker --context "${context_name}" compose \
    --project-directory "${BUILD_CONTEXT_DIR}" \
    --project-name "${project_name}" \
    build --pull ${NO_CACHE_FLAG} "${BACK_BUILD_SERVICES[@]}"
  dt_record "back ${target_host}: image build on the server (context upload + prod deps + layers)" "${t0}"

  # Self-hosted Postgres dump (cloud DB: warning) while the CURRENT version still serves: outside the maintenance
  # window. A failure stops the deploy before anything was switched (the running version is untouched).
  t0="$(dt_now)"
  if ! dv_backup_db_before_switch "${DEPLOY_REVISION}"; then
    err "[BACK:${target_host}] Database backup failed — deploy stopped before the switch, the current version keeps running"
    dv_restore_latest_tag "$(dv_back_image)"
    exit 1
  fi
  db_backup="${DV_DB_BACKUP}"
  if [[ "${IS_SELF_HOSTED_DB}" -eq 1 ]]; then dt_record "back ${target_host}: Postgres backup (old version serving)" "${t0}"; fi

  # Per-host env patches (internal service names, SERVER_IP) on the staged back/.env — local file edits, done before
  # the maintenance window; the public env is restored after the switch so subsequent hosts start from it.
  cp "${BUILD_CONTEXT_DIR}/back/.env" "${BUILD_CONTEXT_DIR}/back/.env.bak"
  patch_back_env_for_host "${BUILD_CONTEXT_DIR}/back/.env" "${target_host}"
  compute_back_services "${target_host}"
  if [[ -n "${PROMETHEUS_REMOTE_WRITE_URLS:-}" ]]; then
    echo "==> [BACK:${target_host}] vmagent will push to: ${PROMETHEUS_REMOTE_WRITE_URLS}"
  fi

  # From here on the host is "switched": any failure rolls every switched host back (see lib/deploy-versions.sh).
  DV_SCOPE="all"
  dv_register_switched
  DV_SW_BACKUP[DV_IDX]="${db_backup}"
  dv_arm

  # ---- Switch: everything above ran while the current version kept serving. ----
  t_switch="$(dt_now)"
  enable_back_maintenance "${context_name}" "${docker_ssh_command}" "${target_host}"
  dt_record "back ${target_host}:   maintenance on" "${t_switch}"

  # Scoped stop of the application containers only (never `down`/`--remove-orphans`, which would also tear down
  # back-lb — the whole point of enable_back_maintenance above is that back-lb stays up throughout; db and Redis keep
  # running, see compute_back_services).
  echo "==> [BACK:${target_host}] Stopping existing services (back, back-worker; back-lb, db and Redis keep running)"
  t0="$(dt_now)"
  DOCKER_SSH_COMMAND="${docker_ssh_command}" docker --context "${context_name}" compose \
    --project-directory "${BUILD_CONTEXT_DIR}" \
    --project-name "${project_name}" \
    --profile metrics \
    rm -sf "${BACK_SERVICES_STOP[@]}" 2>/dev/null || true
  # Includes each container's graceful shutdown (SIGTERM, then SIGKILL after the stop timeout, 10 s by default).
  dt_record "back ${target_host}:   stop old $(printf '%s ' "${BACK_SERVICES_STOP[@]}")(graceful shutdown)" "${t0}"
  if [[ "${BACK_WORKER_ENABLED}" -ne 1 ]]; then
    echo "==> [BACK:${target_host}] back-worker disabled (BACK_WORKER=off): removed if present"
  fi

  # Containers of ANOTHER compose project holding a fixed name the new ones need (project/host renamed). The front
  # is not hunted on a back-only run (`--target=back`): it belongs to a target this run does not deploy, and removing
  # a LIVE front takes the site down until the next front deploy (observed 2026-10-06).
  local -a fixed_names=("${COMPOSE_PROJECT_NAME}_postgres" "${COMPOSE_PROJECT_NAME}_redis" "${COMPOSE_PROJECT_NAME}_back")
  if [[ "${DEPLOY_TARGET}" != "back" ]]; then
    fixed_names+=("${COMPOSE_PROJECT_NAME}_front")
  fi
  t0="$(dt_now)"
  remove_foreign_containers "${context_name}" "${docker_ssh_command}" "${project_name}" "BACK:${target_host}" "${fixed_names[@]}"
  dt_record "back ${target_host}:   leftover containers scan" "${t0}"

  # SQLite copy: the old back is stopped and nothing writes yet (maintenance + no new back), so the copy is consistent.
  # A failed backup aborts (and rolls back): going on without the safety net the deploy promised is not acceptable.
  t0="$(dt_now)"
  if ! dv_backup_db_at_switch "${DEPLOY_REVISION}"; then
    err "[BACK:${target_host}] Database backup failed — aborting"
    dv_abort_with_rollback
  fi
  if [[ "${IS_SQLITE_DB}" -eq 1 ]]; then
    db_backup="${DV_DB_BACKUP}"
    DV_SW_BACKUP[DV_IDX]="${db_backup}"
    dt_record "back ${target_host}:   SQLite backup" "${t0}"
  fi

  echo "==> [BACK:${target_host}] Deploying service"
  t0="$(dt_now)"
  VMAGENT_CONFIG_PATH="${remote_dir}/vmagent.yml" \
  DOCKER_SSH_COMMAND="${docker_ssh_command}" docker --context "${context_name}" compose \
    --project-directory "${BUILD_CONTEXT_DIR}" \
    --project-name "${project_name}" \
    up -d "${BACK_SERVICES_UP[@]}"

  # back (the only service managing the schema) is up: wait for it, THEN start back-worker (see start_back_worker).
  # The patched back/.env stays in place until then, so back-worker gets the same per-host env as back.
  local serving=0
  if wait_for_back_healthy "${context_name}" "${docker_ssh_command}" "${project_name}" "${target_host}"; then
    dt_record "back ${target_host}:   new back started and healthy (up + boot)" "${t0}"
    start_back_dependents "${context_name}" "${docker_ssh_command}" "${project_name}" "${target_host}" "${remote_dir}/vmagent.yml"
    t0="$(dt_now)"
    if start_back_worker "${context_name}" "${docker_ssh_command}" "${project_name}" "${target_host}" "${remote_dir}/vmagent.yml"; then
      serving=1
      if [[ "${BACK_WORKER_ENABLED}" -eq 1 ]]; then
        dt_record "back ${target_host}:   back-worker started (not awaited: boots after maintenance is lifted)" "${t0}"
      fi
    else
      err "[BACK:${target_host}] back-worker did not start."
    fi
  else
    err "[BACK:${target_host}] New back service did not become healthy in time."
    err "[BACK:${target_host}] Check 'docker --context ${context_name} compose --project-name ${project_name} logs back' once the deploy is over."
  fi

  # Restore original back/.env so subsequent host deployments (non-colocated) get the public values.
  # The root .env was never touched, so nothing to restore there.
  mv "${BUILD_CONTEXT_DIR}/back/.env.bak" "${BUILD_CONTEXT_DIR}/back/.env"

  if [[ "${serving}" -eq 1 ]]; then
    t0="$(dt_now)"
    # nginx resolves upstream hostnames once at (re)load: after a back recreate the back-lb keeps proxying the OLD
    # container IP → 502 until reloaded (observed 2026-10-06: lb 7 days old, back 8 minutes, every request 502).
    # Reloaded BEFORE maintenance is lifted so the first requests already reach the new container. Warn-only: a
    # missing/absent back-lb must never red an otherwise good deploy.
    DOCKER_SSH_COMMAND="${docker_ssh_command}" docker --context "${context_name}" compose \
      --project-directory "${BUILD_CONTEXT_DIR}" \
      --project-name "${project_name}" \
      exec -T back-lb nginx -s reload 2>/dev/null \
      && echo "==> [BACK:${target_host}] back-lb reloaded (fresh back upstream)" \
      || warn "[BACK:${target_host}] back-lb reload skipped/failed — reload it manually if the public URL 502s"
    disable_back_maintenance "${context_name}" "${docker_ssh_command}" "${target_host}"
    dt_record "back ${target_host}:   back-lb reload + maintenance off" "${t0}"
    dt_record "back ${target_host}: maintenance window total (requests answered 503)" "${t_switch}"
    DV_SW_SERVED[DV_IDX]=1
    # Remote state: current.json -> previous.json, then the new current.json (revision, environment, date, dbBackup).
    if dv_write_state "${DEPLOY_REVISION}" "${db_backup}"; then
      DV_SW_STATE[DV_IDX]=1
    fi
    dv_disarm
  else
    dv_abort_with_rollback
  fi
  dv_queue_backup_download "${DV_IDX}" "${db_backup}"

  echo "==> [BACK:${target_host}] Status"
  DOCKER_SSH_COMMAND="${docker_ssh_command}" docker --context "${context_name}" compose \
    --project-directory "${BUILD_CONTEXT_DIR}" \
    --project-name "${project_name}" ps back back-worker back-lb

  if [[ "${IS_SELF_HOSTED_DB}" -eq 1 ]]; then
    local postgres_container_name
    postgres_container_name="${PROJECT_NAME}_postgres"
    echo "==> [BACK:${target_host}] Checking remote postgres container (${postgres_container_name})"
    local postgres_container_id
    postgres_container_id=$(DOCKER_SSH_COMMAND="${docker_ssh_command}" docker --context "${context_name}" ps -q -f "name=^/${postgres_container_name}$" || true)
    if [[ -z "${postgres_container_id}" ]]; then
      echo "Error: postgres container '${postgres_container_name}' is not running on ${target_host}." >&2
      exit 1
    fi
    echo "==> [BACK:${target_host}] Postgres container is running (ID: ${postgres_container_id})"
  else
    echo "==> [BACK:${target_host}] Cloud Database -> skipping postgres container check"
  fi

  # Runner auto-provisioning (opt-in, see RUNNER_PROVISION above): the back is healthy
  # and serving at this point, so the hook can mint/pair the colocated runner's token.
  # Warn-only by design — a pairing failure must never red an otherwise good deploy; the
  # hook prints the manual fallback (« Nouveau runner » page + project's runner installer).
  # Skipped when it already ran before the back (RUNNER_PROVISION_ORDER=before).
  if [[ "${RUNNER_PROVISION:-0}" == "1" && "${runner_provisioned}" -eq 0 ]]; then
    run_runner_provision_hook "${ssh_target}" "${ssh_port}" "${key_path}" "${target_host}" after \
      || warn "[BACK:${target_host}] Runner auto-provisioning failed — pair manually (see hook output above)"
  fi
}

deploy_redis_host() {
  local entry="${REDIS_HOST_VALUE}"
  read -r target_user target_host <<<"$(parse_host_entry "${entry}" "${BACK_REMOTE_USER}")"
  local ssh_target="${target_user}@${target_host}"
  local ssh_port="${BACK_SSH_PORT}"
  local key_path="${BACK_KEY_PATH}"
  # Reuse the back context/project if Redis is colocated on a back host, otherwise create a dedicated one
  local context_name project_name
  if is_back_host_name "${target_host}"; then
    context_name="$(build_context_name "${BACK_CONTEXT_NAME}" "${target_host}")"
    project_name="$(build_project_name "back" "${target_host}")"
  else
    context_name="$(build_context_name "${BACK_CONTEXT_NAME}" "${target_host}")"
    project_name="$(build_project_name "back" "${target_host}")"
  fi
  local docker_ssh_command="ssh -p ${ssh_port}"
  local -a ssh_opts=("-p" "${ssh_port}")
  if [[ -n "${key_path}" ]]; then
    docker_ssh_command="ssh -i ${key_path} -p ${ssh_port}"
    ssh_opts+=("-i" "${key_path}")
  fi

  echo "==> [REDIS:${target_host}] Testing SSH connectivity"
  ssh "${ssh_opts[@]}" -o BatchMode=yes -o ConnectTimeout=10 "${ssh_target}" "echo SSH_OK" >/dev/null

  ensure_docker_context "${context_name}" "${ssh_target}" "${ssh_port}"

  # A container holding the fixed name but belonging to a previous project name is removed; the running Redis of this
  # project is left to `up -d`, which recreates it only when its configuration changed (no restart, no dropped
  # connections on an ordinary deploy).
  remove_foreign_containers "${context_name}" "${docker_ssh_command}" "${project_name}" "REDIS:${target_host}" "${COMPOSE_PROJECT_NAME}_redis"

  echo "==> [REDIS:${target_host}] Deploying Redis service"
  DOCKER_SSH_COMMAND="${docker_ssh_command}" docker --context "${context_name}" compose \
    --project-directory "${BUILD_CONTEXT_DIR}" \
    --project-name "${project_name}" \
    up -d redis

  echo "==> [REDIS:${target_host}] Status"
  DOCKER_SSH_COMMAND="${docker_ssh_command}" docker --context "${context_name}" compose \
    --project-directory "${BUILD_CONTEXT_DIR}" \
    --project-name "${project_name}" ps redis
}

# Sets DV_FRONT_OWN_ENV: 1 when this front host has its own remote dir, 0 when it shares it with the back on the same
# host (both upload a `.env` there, so .env.previous cannot be trusted for the front: rollbacks use the local front env).
front_env_ownership() {
  local remote_home="$1" remote_dir="$2" back_dir
  DV_FRONT_OWN_ENV=1
  if is_back_host_name "${DV_HOST}"; then
    back_dir="${BACK_REMOTE_APP_DIR/#\~/${remote_home}}"
    if [[ "${back_dir%/}" == "${remote_dir%/}" ]]; then
      DV_FRONT_OWN_ENV=0
    fi
  fi
}

deploy_front_host() {
  local entry="$1"
  read -r target_user target_host <<<"$(parse_host_entry "${entry}" "${FRONT_REMOTE_USER}")"
  local ssh_target="${target_user}@${target_host}"
  local ssh_port="${FRONT_SSH_PORT}"
  local key_path="${FRONT_KEY_PATH}"
  local context_name
  local project_name
  if is_back_host_name "${target_host}"; then
    context_name="$(build_context_name "${BACK_CONTEXT_NAME}" "${target_host}")"
    project_name="$(build_project_name "back" "${target_host}")"
  else
    context_name="$(build_context_name "${FRONT_CONTEXT_NAME}" "${target_host}")"
    project_name="$(build_project_name "front" "${target_host}")"
  fi
  local docker_ssh_command="ssh -p ${ssh_port}"
  local -a ssh_opts=("-p" "${ssh_port}")
  local -a scp_opts=("-P" "${ssh_port}")
  if [[ -n "${key_path}" ]]; then
    docker_ssh_command="ssh -i ${key_path} -p ${ssh_port}"
    ssh_opts+=("-i" "${key_path}")
    scp_opts+=("-i" "${key_path}")
  fi

  local t0
  t0="$(dt_now)"
  echo "==> [FRONT:${target_host}] Testing SSH connectivity"
  ssh "${ssh_opts[@]}" -o BatchMode=yes -o ConnectTimeout=10 "${ssh_target}" "echo SSH_OK" >/dev/null

  local remote_home
  remote_home=$(ssh "${ssh_opts[@]}" "${ssh_target}" 'printf %s "$HOME"')
  local remote_dir="${FRONT_REMOTE_APP_DIR/#\~/${remote_home}}"
  local remote_env_path="${remote_dir}/.env"

  echo "==> [FRONT:${target_host}] Preparing remote directory (${remote_dir})"
  ssh "${ssh_opts[@]}" "${ssh_target}" "mkdir -p '${remote_dir}'"

  dv_use_host FRONT "${target_host}" "${ssh_target}" "${ssh_port}" "${key_path}" "${context_name}" "${project_name}" "${remote_dir}"
  front_env_ownership "${remote_home}" "${remote_dir}"
  if [[ "${DV_FRONT_OWN_ENV}" == "1" ]]; then
    dv_save_env_previous
  fi

  echo "==> [FRONT:${target_host}] Uploading env file"
  scp "${scp_opts[@]}" "${FRONT_ENV_FILE}" "${ssh_target}:${remote_env_path}"
  ssh "${ssh_opts[@]}" "${ssh_target}" "chmod 600 '${remote_env_path}'" || true

  ensure_docker_context "${context_name}" "${ssh_target}" "${ssh_port}"

  # Keep the running front as `previous` BEFORE the build overwrites `latest` (rollback target).
  dv_tag_previous "$(dv_front_image)"
  dt_record "front ${target_host}: prepare (ssh, env upload, docker context, tag previous)" "${t0}"

  echo "==> [FRONT:${target_host}] Building service"
  t0="$(dt_now)"
  DOCKER_SSH_COMMAND="${docker_ssh_command}" docker --context "${context_name}" compose \
    --project-directory "${BUILD_CONTEXT_DIR}" \
    --project-name "${project_name}" \
    build --pull ${NO_CACHE_FLAG} front
  dt_record "front ${target_host}: image build on the server" "${t0}"

  # Set to --no-deps in the colocated branch below (see the note there): the front must
  # never reconcile the back service it shares its host with.
  local front_dep_flags=""
  # From here the front host is "switched": a front that does not start is rolled back (front hosts only).
  DV_SCOPE="front"
  dv_register_switched
  dv_arm
  if is_back_host_name "${target_host}"; then
    # --no-deps is REQUIRED on a host shared with the back: `front` declares
    # `depends_on: {back: {condition: service_healthy}}`, so `up -d front` also
    # reconciles `back` — and deploy_back_host has by then RESTORED the public back/.env
    # (its DB_PORT patch removed), so compose recomputes a different config hash and
    # RECREATES back. The new container then gets DB_PORT=<public mapped port> instead of
    # 5432, tries `db:4702`, gets ECONNREFUSED, goes unhealthy, and `up -d front` aborts
    # with "dependency failed to start: …back-1 is unhealthy".
    # Back is already deployed and health-guaranteed by its own phase (deploy_back_host
    # aborts otherwise), so the front needs no dependency check here — only no tampering.
    # Reproduced and validated locally 2026-09-27: without --no-deps back is recreated,
    # with it back stays intact and front starts.
    front_dep_flags="--no-deps"
  else
    # Dedicated front host: the project holds only the front, stale services of older compose files go with it.
    front_dep_flags="--remove-orphans"
  fi

  # A container of ANOTHER compose project holding the fixed name (project/host renamed) is removed; the running front
  # of this project is NOT stopped beforehand: `up -d` replaces it by the new image in one step (stop + start), so
  # the old front serves until the very last moment.
  remove_foreign_containers "${context_name}" "${docker_ssh_command}" "${project_name}" "FRONT:${target_host}" "${COMPOSE_PROJECT_NAME}_front"

  echo "==> [FRONT:${target_host}] Deploying service"
  t0="$(dt_now)"
  DOCKER_SSH_COMMAND="${docker_ssh_command}" docker --context "${context_name}" compose \
    --project-directory "${BUILD_CONTEXT_DIR}" \
    --project-name "${project_name}" \
    up -d ${front_dep_flags} front

  if ! dv_wait_front_running; then
    err "[FRONT:${target_host}] The new front container did not stay up"
    dv_abort_with_rollback
  fi
  dv_disarm
  dt_record "front ${target_host}: switch (recreate + running check)" "${t0}"

  echo "==> [FRONT:${target_host}] Status"
  DOCKER_SSH_COMMAND="${docker_ssh_command}" docker --context "${context_name}" compose \
    --project-directory "${BUILD_CONTEXT_DIR}" \
    --project-name "${project_name}" ps front
}

# ======================
# MANUAL ROLLBACK (--rollback, via ./scripts/run.sh rollback <env>)
# ======================
# Positions DV_* on a host for a rollback: same context/project naming as the deploy functions.
rollback_init_host() {
  local role="$1" entry="$2" user_default ssh_port key_path ctx_base app_dir ssh_user host ctx project ssh_target remote_home
  if [[ "${role}" == "BACK" ]]; then
    user_default="${BACK_REMOTE_USER}"; ssh_port="${BACK_SSH_PORT}"; key_path="${BACK_KEY_PATH}"
    ctx_base="${BACK_CONTEXT_NAME}"; app_dir="${BACK_REMOTE_APP_DIR}"
  else
    user_default="${FRONT_REMOTE_USER}"; ssh_port="${FRONT_SSH_PORT}"; key_path="${FRONT_KEY_PATH}"
    ctx_base="${FRONT_CONTEXT_NAME}"; app_dir="${FRONT_REMOTE_APP_DIR}"
  fi
  read -r ssh_user host <<<"$(parse_host_entry "${entry}" "${user_default}")"
  ssh_target="${ssh_user}@${host}"
  if [[ "${role}" == "FRONT" ]] && ! is_back_host_name "${host}"; then
    ctx="$(build_context_name "${ctx_base}" "${host}")"
    project="$(build_project_name "front" "${host}")"
  elif [[ "${role}" == "FRONT" ]]; then
    ctx="$(build_context_name "${BACK_CONTEXT_NAME}" "${host}")"
    project="$(build_project_name "back" "${host}")"
  else
    ctx="$(build_context_name "${ctx_base}" "${host}")"
    project="$(build_project_name "back" "${host}")"
  fi
  dv_use_host "${role}" "${host}" "${ssh_target}" "${ssh_port}" "${key_path}" "${ctx}" "${project}" ""
  echo "==> [${role}:${host}] Testing SSH connectivity"
  ssh "${DV_SSH_OPTS[@]}" -o BatchMode=yes -o ConnectTimeout=10 "${ssh_target}" "echo SSH_OK" >/dev/null
  remote_home=$(ssh "${DV_SSH_OPTS[@]}" "${ssh_target}" 'printf %s "$HOME"')
  DV_REMOTE_DIR="${app_dir/#\~/${remote_home}}"
  if [[ "${role}" == "FRONT" ]]; then front_env_ownership "${remote_home}" "${DV_REMOTE_DIR}"; fi
  ensure_docker_context "${ctx}" "${ssh_target}" "${ssh_port}"
}

# Minimal compose context: the compose file, the (empty) back/front dirs it references and placeholder env files
# (the real ones are fetched from the hosts); nothing is built.
stage_rollback_context() {
  mkdir -p "${BUILD_CONTEXT_DIR}/back" "${BUILD_CONTEXT_DIR}/front"
  cp "${COMPOSE_FILE_ABS}" "${BUILD_CONTEXT_DIR}/docker-compose.yml"
  portable_sed_inplace "${BUILD_CONTEXT_DIR}/docker-compose.yml" -e 's|\.\./back|./back|g' -e 's|\.\./front|./front|g'
  cp "${BACK_ENV_FILE}" "${BUILD_CONTEXT_DIR}/.env"
  : > "${BUILD_CONTEXT_DIR}/back/.env"
  cp "${FRONT_ENV_FILE}" "${BUILD_CONTEXT_DIR}/front/.env"
  if [[ -f "scripts/vmagent.yml" ]]; then
    cp "scripts/vmagent.yml" "${BUILD_CONTEXT_DIR}/vmagent.yml"
  fi
}

# Swaps latest <-> previous (images, remote .env, state files) on every selected host; --restore-db also restores the
# SQLite backup recorded in the CURRENT state. A second rollback therefore rolls forward again.
run_manual_rollback() {
  local do_back=1 do_front=1 entry restore_ref image
  [[ "${DEPLOY_TARGET}" == "front" ]] && do_back=0
  [[ "${DEPLOY_TARGET}" == "back" ]] && do_front=0
  if [[ "${IS_CLOUD_FRONT}" -eq 1 ]]; then
    if [[ "${do_back}" -eq 0 ]]; then
      err "The front is deployed to Cloudflare Pages: roll it back from the Cloudflare dashboard (Deployments > Rollback)."
      exit 1
    fi
    do_front=0
  fi
  stage_rollback_context
  if [[ "${RESTORE_DB}" -eq 1 && "${IS_SQLITE_DB}" -ne 1 && "${do_back}" -eq 1 ]]; then
    warn "--restore-db only applies to SQLite (DB_ENGINE=${DB_ENGINE_VALUE}): the database is NOT restored (Postgres: restore the dump named in .deploy/current.json by hand)."
  fi

  # Pass 1: refuse before touching anything when a host has nothing to go back to.
  local refused=0
  if [[ "${do_back}" -eq 1 ]]; then
    for entry in "${BACK_HOSTS[@]}"; do
      rollback_init_host BACK "${entry}"
      image="$(dv_back_image)"
      if ! dv_image_exists "${image}:previous"; then
        err "[BACK:${DV_HOST}] Cannot roll back: no ${image}:previous image on this host (first deploy, or no deploy since versioning was introduced)."
        refused=1
      elif [[ "${RESTORE_DB}" -eq 1 && "${IS_SQLITE_DB}" -eq 1 && -z "$(dv_current_db_backup || true)" ]]; then
        err "[BACK:${DV_HOST}] --restore-db: .deploy/current.json records no database backup on this host."
        refused=1
      fi
    done
  fi
  if [[ "${do_front}" -eq 1 ]]; then
    for entry in "${FRONT_HOSTS[@]}"; do
      rollback_init_host FRONT "${entry}"
      image="$(dv_front_image)"
      if ! dv_image_exists "${image}:previous"; then
        err "[FRONT:${DV_HOST}] Cannot roll back: no ${image}:previous image on this host (first deploy, or no deploy since versioning was introduced)."
        refused=1
      fi
    done
  fi
  if [[ "${refused}" -eq 1 ]]; then
    err "Nothing was changed."
    exit 1
  fi

  # Pass 2: swap.
  if [[ "${do_back}" -eq 1 ]]; then
    for entry in "${BACK_HOSTS[@]}"; do
      rollback_init_host BACK "${entry}"
      restore_ref=""
      if [[ "${RESTORE_DB}" -eq 1 && "${IS_SQLITE_DB}" -eq 1 ]]; then
        restore_ref="$(dv_current_db_backup || true)"
      fi
      dv_rollback_back manual "${restore_ref}" || { err "Rollback failed on back host ${DV_HOST}"; exit 1; }
    done
  fi
  if [[ "${do_front}" -eq 1 ]]; then
    for entry in "${FRONT_HOSTS[@]}"; do
      rollback_init_host FRONT "${entry}"
      dv_rollback_front manual || { err "Rollback failed on front host ${DV_HOST}"; exit 1; }
    done
  fi
  echo "==> Rollback completed"
}

if [[ "${ROLLBACK_MODE}" == "1" ]]; then
  run_manual_rollback
  exit 0
fi

if [[ "${DEPLOY_TARGET}" != "front" && -n "${REDIS_HOST_VALUE}" ]]; then
  echo "==> Deploying Redis on ${REDIS_HOST_VALUE}"
  __t0="$(dt_now)"
  deploy_redis_host
  dt_record "redis ${REDIS_HOST_VALUE}: up (recreated only when changed)" "${__t0}"
fi

# Local copies of the database backups (lib/deploy-versions.sh): after every switch, outside any maintenance window.
download_db_backups() {
  [[ ${#DV_DL_IDX[@]} -gt 0 ]] || return 0
  local t0
  t0="$(dt_now)"
  dv_download_backups
  dt_record "database backup: local copy" "${t0}"
}

if [[ "${DEPLOY_TARGET}" != "front" ]]; then
  echo "==> Deploying back services on ${#BACK_HOSTS[@]} host(s)"
  for host in "${BACK_HOSTS[@]}"; do
    deploy_back_host "${host}"
  done
fi

if [[ "${DEPLOY_TARGET}" == "back" ]]; then
  download_db_backups
  echo "==> Deployment completed (back only)"
  exit 0
fi

if [[ "${IS_CLOUD_FRONT}" -eq 1 ]]; then
  echo "==> Deploying front to Cloudflare Pages"
  require_cmd npx

  # Build directly from ./front/ to reuse existing node_modules (avoids full reinstall)
  FRONT_DIST_DIR="./front/dist"

  # Installs only when package.json / package-lock.json / Node changed (npm_install_if_changed): a mere existence
  # check of node_modules would build with a stale install.
  echo "==> [CLOUD] Installing front dependencies"
  __t0="$(dt_now)"
  npm_install_if_changed front || { echo "Error: front npm install failed"; exit 1; }
  dt_record "front: npm install (local, skipped when unchanged)" "${__t0}"

  check_build_memory 1024

  # Derive the Vite mode from the env file name so `.env.<mode>` overrides are
  # applied to the bundle (front/.env -> default production build,
  # front/.env.preprod -> --mode preprod, which loads .env then .env.preprod).
  FRONT_VITE_MODE=""
  case "$(basename "${FRONT_ENV_FILE}")" in
    .env) ;;
    .env.*) FRONT_VITE_MODE="$(basename "${FRONT_ENV_FILE}")"; FRONT_VITE_MODE="${FRONT_VITE_MODE#.env.}" ;;
  esac

  echo "==> [CLOUD] Building front${FRONT_VITE_MODE:+ (vite mode: ${FRONT_VITE_MODE})}"
  __t0="$(dt_now)"
  (cd front && NODE_OPTIONS="--max-old-space-size=4096" ./node_modules/.bin/vite build ${FRONT_VITE_MODE:+--mode "${FRONT_VITE_MODE}"}) || {
    echo "Error: front build failed"
    exit 1
  }

  if [[ ! -d "${FRONT_DIST_DIR}" ]]; then
    echo "Error: front build did not produce dist/ directory."
    exit 1
  fi
  dt_record "front: build (local, vite)" "${__t0}"

  # Load front env to pick up CLOUDFLARE_API_TOKEN / CLOUDFLARE_ACCOUNT_ID / CLOUDFLARE_PAGES_BRANCH
  if [[ -f "${FRONT_ENV_FILE}" ]]; then
    set -a
    source "${FRONT_ENV_FILE}"
    set +a
  fi

  # Use per-project Cloudflare credentials if set (avoids relying on global wrangler login)
  if [[ -z "${CLOUDFLARE_API_TOKEN:-}" || -z "${CLOUDFLARE_ACCOUNT_ID:-}" ]]; then
    echo "==> [CLOUD] WARNING: CLOUDFLARE_API_TOKEN / CLOUDFLARE_ACCOUNT_ID not set — falling back to global wrangler auth"
    echo "==> [CLOUD] To use per-project auth, set both variables in your .env or environment"
  fi

  # Pages branch drives the deployment environment (production vs preview)
  CLOUDFLARE_PAGES_BRANCH_VALUE="${CLOUDFLARE_PAGES_BRANCH:-main}"

  echo "==> [CLOUD] Deploying to Cloudflare Pages (project: ${CLOUDFLARE_PAGES_PROJECT}, branch: ${CLOUDFLARE_PAGES_BRANCH_VALUE})"
  __t0="$(dt_now)"
  npx --yes wrangler pages deploy "${FRONT_DIST_DIR}" --project-name="${CLOUDFLARE_PAGES_PROJECT}" --branch="${CLOUDFLARE_PAGES_BRANCH_VALUE}"
  dt_record "front: Cloudflare Pages upload" "${__t0}"

  echo "==> [CLOUD] Front deployed to Cloudflare Pages"
else
  echo "==> Deploying front services on ${#FRONT_HOSTS[@]} host(s)"
  for host in "${FRONT_HOSTS[@]}"; do
    deploy_front_host "${host}"
  done
fi

if [[ "${DEPLOY_TARGET}" != "front" ]]; then
  __t0="$(dt_now)"
  configure_firewall_rules
  apply_firewall_rules
  dt_record "firewall rules" "${__t0}"
fi

download_db_backups
echo "==> Deployment completed"
