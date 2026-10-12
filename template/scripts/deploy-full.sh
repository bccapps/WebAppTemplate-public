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
#   ./scripts/deploy-full.sh --help          Show this help
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
cd "${PROJECT_ROOT}"

if [[ "${1:-}" == "--help" || "${1:-}" == "-h" || "${1:-}" == "help" ]]; then
  sed -n '3,/^[^#]/p' "$0" | grep '^#' | sed 's/^# \?//'
  exit 0
fi

# Parse --target flag
DEPLOY_TARGET="${DEPLOY_TARGET:-all}"
RUNNER_ROTATE_CLI=0
for arg in "$@"; do
  case "${arg}" in
    --target=*) DEPLOY_TARGET="${arg#*=}" ;;
    --rotate-runner) RUNNER_ROTATE_CLI=1 ;;
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
RUNNER_PROVISION="${RUNNER_PROVISION:-0}"
RUNNER_PROVISION_HOOK="${RUNNER_PROVISION_HOOK:-./runner/scripts/provision-hub-runner.sh}"
RUNNER_ROTATE="${RUNNER_ROTATE:-${RUNNER_ROTATE_CLI:-0}}"

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
# Set FORCE_REBUILD=1 to bypass layer cache (e.g. after a base-image upgrade).
FORCE_REBUILD="${FORCE_REBUILD:-0}"
NO_CACHE_FLAG=""
[[ "${FORCE_REBUILD}" == "1" ]] && NO_CACHE_FLAG="--no-cache"
DATABASE_ENGINE_VALUE="${DATABASE_ENGINE:-postgres}"
DATABASE_ENGINE_NORMALIZED="$(echo "${DATABASE_ENGINE_VALUE}" | tr '[:upper:]' '[:lower:]')"
DEFAULT_COMPOSE_FILE="scripts/docker-compose-cloud.yml"
IS_SELF_HOSTED_DB=0
if [[ "${DATABASE_ENGINE_NORMALIZED}" == "postgres" || "${DATABASE_ENGINE_NORMALIZED}" == "selfhosted" ]]; then
  IS_SELF_HOSTED_DB=1
  DEFAULT_COMPOSE_FILE="scripts/docker-compose.yml"
fi
COMPOSE_FILE_PATH="${COMPOSE_FILE_NAME:-${DEFAULT_COMPOSE_FILE}}"
COMPOSE_FILE_PATH="${COMPOSE_FILE_PATH#./}"
KEEP_BUILD_CONTEXT="${KEEP_BUILD_CONTEXT:-0}"

# Base image for the back builder stage (NestJS CLI pre-installed).
# Must match the FROM line in back/Dockerfile.selfhosted and back/Dockerfile.
NESTJS_CLI_VERSION="11.0.16"
BACK_BASE_IMAGE_TAG="$(echo "${COMPOSE_PROJECT_NAME}" | tr '[:upper:]' '[:lower:]')-nestcli:22-${NESTJS_CLI_VERSION}"

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
require_cmd rsync
require_cmd python3
require_cmd git

# ======================
# SHARED LIB SUBMODULES
# ======================
# Ensure the shared-library git submodules (.libs/{nestcommon,reactcommon}) are
# present BEFORE staging the build context. Staging uses `rsync -aL`, which
# dereferences the `src/modules_shared/*` symlinks into `.libs/*`; on a fresh
# checkout those submodules are empty → dangling symlinks → the build fails.
# Idempotent. No-op for projects not yet migrated to submodules (no .gitmodules).
# Works for monorepos (one .gitmodules at root) and split back/front repos.
__seen_submodule_tops=""
for __side in back front; do
  [[ -d "./${__side}" ]] || continue
  __top="$(git -C "./${__side}" rev-parse --show-toplevel 2>/dev/null)" || continue
  [[ -f "${__top}/.gitmodules" ]] || continue
  case " ${__seen_submodule_tops} " in *" ${__top} "*) continue ;; esac
  __seen_submodule_tops="${__seen_submodule_tops} ${__top}"
  info "Initialisation des submodules (.libs) — ${__top}"
  git -C "${__top}" submodule update --init --remote \
    || warn "git submodule update a échoué pour ${__top} (build risque d'échouer sur modules_shared)."
done
unset __seen_submodule_tops __side __top

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
trap 'cleanup_context; cleanup_front_build; cleanup_back_build' EXIT

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

  # Always run npm install, not just when node_modules is entirely absent — an existing
  # node_modules can still be STALE relative to package.json (a dependency added to
  # package.base.json since the last install is silently missing). npm install is fast/a
  # no-op when node_modules already matches package-lock.json, so this costs nothing in the
  # common case and only actually installs when something really changed.
  info "[LOCAL] Installing front dependencies..."
  (cd front && npm install) || { warn "[LOCAL] Front install failed — building on remote"; return 1; }

  if ! (cd front && npm run build); then
    warn "[LOCAL] Front build failed — building on remote"
    return 1
  fi

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

  # Replace Dockerfile with a minimal prebuilt version (no npm, no vite on remote).
  # nginx.conf is already processed above — no ARG/envsubst needed at build or runtime.
  cat > "${FRONT_BUILD_DIR}/Dockerfile" << 'DOCKEREOF'
FROM nginx:1.27-alpine
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY dist /usr/share/nginx/html
DOCKEREOF

  success "[LOCAL] Front built locally — remote will only run nginx COPY"
  return 0
}

# Builds the back locally (Mac npm cache + local CPU) and rewrites Dockerfile.selfhosted
# in BACK_BUILD_DIR to a minimal prebuilt variant (prod-deps + runtime COPY only).
# Falls back silently to remote build on any failure.
build_back_locally() {
  if ! command -v npm &>/dev/null; then
    warn "[LOCAL] npm not found — back will be built on remote"
    return 1
  fi

  info "[LOCAL] Building back locally (local CPU + npm cache)..."

  # Always run npm install, not just when node_modules is entirely absent — an existing
  # node_modules can still be STALE relative to package.json (a dependency added to
  # package.base.json since the last install is silently missing). Proven live 2026-08-22:
  # otplib/qrcode were added to package.base.json the day before, node_modules already
  # existed from an older install so this guard skipped npm install entirely, and `nest
  # build` failed with "Cannot find module 'otplib'" — a false "build error" that was
  # actually just a stale local install. npm install is fast/a no-op when node_modules
  # already matches package-lock.json, so this costs nothing in the common case and only
  # actually installs when something really changed.
  info "[LOCAL] Installing back dependencies..."
  (cd back && npm install) || { warn "[LOCAL] Back install failed — building on remote"; return 1; }

  if ! (cd back && npm run build); then
    warn "[LOCAL] Back build failed — building on remote"
    return 1
  fi

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

  # Write the prebuilt variant (builder stage eliminated) over BOTH Dockerfile names:
  # docker-compose.yml (self-hosted DB) builds `Dockerfile.selfhosted`, while
  # docker-compose-cloud.yml (cloud DB) builds `Dockerfile`. Writing only the former made
  # every cloud-DB project (e.g. a Supabase-hosted DB) silently fall back to the full remote
  # build — npm ci + npm ci --omit=dev + nest build on the server, on every deploy.
  local _prebuilt_dockerfile
  _prebuilt_dockerfile=$(cat << 'DOCKEREOF'
# Prebuilt back Dockerfile — dist compiled locally; remote only installs prod deps.
# glibc-based (not alpine/musl): some npm deps ship prebuilt Linux .so binaries linked
# against glibc (e.g. zklighter-sdk's signer) that musl can't load even with the gcompat
# shim. Must match back/Dockerfile's runtime base.
#
# Caching rules — keep in sync with back/Dockerfile:
#   1. no `--mount=type=bind,source=.` around npm ci (it folds the whole context into the
#      cache key, so every dist change re-runs a 739 MB install)
#   2. node_modules copied BEFORE dist (stable layers first, volatile last)
FROM node:22-bookworm-slim AS prod-deps
WORKDIR /app
# npm major MUST match the machine that writes the lock (see the matching note in
# back/Dockerfile): node 22 ships npm 10, the control machine runs npm 11, and npm 10
# rejects an npm 11 lock with:
#     npm error Missing: chokidar@3.6.0 from lock file
# npm 11 accepts locks written by both majors, npm 10 only its own.
RUN npm install -g npm@11
# *.tgz: local tarball deps (`file:` in package.json). BuildKit tolerates a wildcard
# matching nothing, so this is a no-op for projects without tarball deps.
COPY package*.json *.tgz ./
RUN --mount=type=cache,target=/root/.npm \
    npm ci --omit=dev

FROM node:22-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production

# wget: used by the compose healthcheck (CMD-SHELL wget ...). Alpine's busybox has it
# built in; Debian slim images don't ship it by default.
# ca-certificates: TLS verification for outbound HTTPS calls made by native Go binaries
# (e.g. zklighter-sdk's signer) — Debian slim doesn't ship the CA bundle either.
RUN apt-get update && apt-get install -y --no-install-recommends wget ca-certificates && \
    rm -rf /var/lib/apt/lists/*

COPY --chown=node:node --from=prod-deps /app/node_modules ./node_modules
COPY --chown=node:node package.json ./
COPY --chown=node:node *.crt ./
RUN rm -f .no-cert.crt

ARG APP_RUNTIME_DIR=.cache
RUN mkdir -p "/app/${APP_RUNTIME_DIR}" && chown -R node:node "/app/${APP_RUNTIME_DIR}"

COPY --chown=node:node _prebuilt_locales/app ./src/locales
COPY --chown=node:node _prebuilt_locales/modules/src/ ./src/
COPY --chown=node:node dist ./dist

USER node
CMD ["node", "dist/main.js"]
DOCKEREOF
)
  printf '%s\n' "${_prebuilt_dockerfile}" > "${BACK_BUILD_DIR}/Dockerfile.selfhosted"
  printf '%s\n' "${_prebuilt_dockerfile}" > "${BACK_BUILD_DIR}/Dockerfile"

  # The canonical .dockerignore excludes `dist` — correct for the remote-build path, where
  # dist is produced inside the builder stage and a stale local copy must not leak into the
  # context. But the prebuilt path above ships a locally-compiled dist via `COPY dist ./dist`,
  # so it must be re-included here; otherwise Docker strips dist from the context and the COPY
  # fails with `"/dist": not found`. Patch only the staged copy (deleted after deploy), never
  # the repo's symlinked .dockerignore, and only on this prebuilt path.
  if [[ -f "${BACK_BUILD_DIR}/.dockerignore" ]] && ! grep -qx '!dist' "${BACK_BUILD_DIR}/.dockerignore"; then
    printf '\n!dist\n' >> "${BACK_BUILD_DIR}/.dockerignore"
  fi

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

FRONT_PREBUILT=0
BACK_PREBUILT=0
echo "==> [LOCAL] Preparing build context"
if [[ "${DEPLOY_TARGET}" != "back" ]]; then
  # Cloud front builds directly from ./front/ — no need to create a copy
  if [[ "${IS_CLOUD_FRONT}" -eq 0 ]]; then
    prepare_front_build
    if build_front_locally; then
      FRONT_PREBUILT=1
    fi
  fi
fi
if [[ "${DEPLOY_TARGET}" != "front" ]]; then
  prepare_back_build
  if build_back_locally; then
    BACK_PREBUILT=1
  fi
fi

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

# Ensures the NestJS CLI base image exists on the remote Docker host.
# Built once; skipped on subsequent deploys unless the tag changes.
ensure_back_base_image() {
  local context_name="$1"
  local docker_ssh_command="$2"
  local target_host="$3"

  if DOCKER_SSH_COMMAND="${docker_ssh_command}" docker --context "${context_name}" \
      image inspect "${BACK_BASE_IMAGE_TAG}" >/dev/null 2>&1; then
    echo "==> [BACK:${target_host}] Base image ${BACK_BASE_IMAGE_TAG} already present — skipping"
    return
  fi

  echo "==> [BACK:${target_host}] Building base image ${BACK_BASE_IMAGE_TAG} (one-time setup, ~2 min)"
  DOCKER_SSH_COMMAND="${docker_ssh_command}" docker --context "${context_name}" build \
    --tag "${BACK_BASE_IMAGE_TAG}" \
    - <<EOF
FROM node:22-bookworm-slim
RUN npm -g install @nestjs/cli@${NESTJS_CLI_VERSION} --omit=dev
EOF
}

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

  echo "==> [BACK:${target_host}] Testing SSH connectivity"
  ssh "${ssh_opts[@]}" -o BatchMode=yes -o ConnectTimeout=10 "${ssh_target}" "echo SSH_OK" >/dev/null

  local remote_home
  remote_home=$(ssh "${ssh_opts[@]}" "${ssh_target}" 'printf %s "$HOME"')
  local remote_dir="${BACK_REMOTE_APP_DIR/#\~/${remote_home}}"
  local remote_env_path="${remote_dir}/.env"

  echo "==> [BACK:${target_host}] Preparing remote directory (${remote_dir})"
  ssh "${ssh_opts[@]}" "${ssh_target}" "mkdir -p '${remote_dir}'"

  echo "==> [BACK:${target_host}] Uploading env file"
  scp "${scp_opts[@]}" "${BACK_ENV_FILE}" "${ssh_target}:${remote_env_path}"
  ssh "${ssh_opts[@]}" "${ssh_target}" "chmod 600 '${remote_env_path}'" || true

  if [[ -f "scripts/vmagent.yml" ]]; then
    echo "==> [BACK:${target_host}] Uploading vmagent config"
    scp "${scp_opts[@]}" "scripts/vmagent.yml" "${ssh_target}:${remote_dir}/vmagent.yml"
  fi

  ensure_docker_context "${context_name}" "${ssh_target}" "${ssh_port}"
  ensure_back_base_image "${context_name}" "${docker_ssh_command}" "${target_host}"

  echo "==> [BACK:${target_host}] Building service"
  DOCKER_SSH_COMMAND="${docker_ssh_command}" docker --context "${context_name}" compose \
    --project-directory "${BUILD_CONTEXT_DIR}" \
    --project-name "${project_name}" \
    build ${NO_CACHE_FLAG} back back-worker

  enable_back_maintenance "${context_name}" "${docker_ssh_command}" "${target_host}"

  # Scoped stop (never `down`/`--remove-orphans`, which would also tear down back-lb — the
  # whole point of enable_back_maintenance above is that back-lb stays up throughout). Mirrors
  # the same self-hosted-DB / colocated-Redis / metrics conditions as the `back_services` list
  # built below, just without the side-effecting env patches (not needed to decide what to stop).
  local -a stop_services=("back" "back-worker")
  if [[ "${IS_SELF_HOSTED_DB}" -eq 1 ]]; then
    stop_services+=("db")
  fi
  if [[ -n "${REDIS_HOST_VALUE:-}" ]]; then
    local stop_redis_host
    read -r _ stop_redis_host <<<"$(parse_host_entry "${REDIS_HOST_VALUE}" "${BACK_REMOTE_USER}")"
    [[ "${target_host}" == "${stop_redis_host}" ]] && stop_services+=("redis")
  fi
  [[ -n "${PROMETHEUS_REMOTE_WRITE_URLS:-}" ]] && stop_services+=("vmagent")

  echo "==> [BACK:${target_host}] Stopping existing services (back-lb kept alive for maintenance mode)"
  DOCKER_SSH_COMMAND="${docker_ssh_command}" docker --context "${context_name}" compose \
    --project-directory "${BUILD_CONTEXT_DIR}" \
    --project-name "${project_name}" \
    --profile metrics \
    rm -sf "${stop_services[@]}" 2>/dev/null || true

  # Remove containers with fixed container_name that may belong to a previous project name.
  # back_lb is deliberately NOT in this list — see enable_back_maintenance above. Neither is
  # front on a back-only run (`--target=back`): it belongs to a target this run does not deploy,
  # and removing a LIVE front to hunt a hypothetical stale one takes the site down until the
  # next front deploy (observed 2026-10-06). A truly stale front is cleaned by the next
  # front/all run and breaks nothing for back-only deploys (different ports).
  local -a leftover_names=("${COMPOSE_PROJECT_NAME}_postgres" "${COMPOSE_PROJECT_NAME}_redis" "${COMPOSE_PROJECT_NAME}_back")
  if [[ "${DEPLOY_TARGET}" != "back" ]]; then
    leftover_names+=("${COMPOSE_PROJECT_NAME}_front")
  fi
  for cname in "${leftover_names[@]}"; do
    if DOCKER_SSH_COMMAND="${docker_ssh_command}" docker --context "${context_name}" inspect "${cname}" >/dev/null 2>&1; then
      echo "==> [BACK:${target_host}] Removing leftover container: ${cname}"
      DOCKER_SSH_COMMAND="${docker_ssh_command}" docker --context "${context_name}" rm -f "${cname}" 2>/dev/null || true
    fi
  done

  # Remove stale containers from old project names (same app, hostname was renamed or changed).
  # docker compose down only cleans the current project; if the project name changed the old
  # containers keep running and hold ports / volume references.
  while IFS= read -r cid; do
    [[ -z "${cid}" ]] && continue
    local stale_proj
    stale_proj=$(DOCKER_SSH_COMMAND="${docker_ssh_command}" docker --context "${context_name}" \
      inspect "${cid}" --format '{{index .Config.Labels "com.docker.compose.project"}}' 2>/dev/null || true)
    if [[ "${stale_proj}" == ${COMPOSE_PROJECT_NAME}-back-* && "${stale_proj}" != "${project_name}" ]]; then
      echo "==> [BACK:${target_host}] Removing stale container from old project '${stale_proj}': ${cid}"
      DOCKER_SSH_COMMAND="${docker_ssh_command}" docker --context "${context_name}" rm -f "${cid}" 2>/dev/null || true
    fi
  done < <(DOCKER_SSH_COMMAND="${docker_ssh_command}" docker --context "${context_name}" ps -aq 2>/dev/null || true)

  # Build the list of services to start.
  # Include redis if it is colocated on this back host, so the --remove-orphans
  # step above does not kill the redis container.
  local -a back_services=("back" "back-worker" "back-lb")
  if [[ "${IS_SELF_HOSTED_DB}" -eq 1 ]]; then
    back_services+=("db")
  fi
  if [[ -n "${PROMETHEUS_REMOTE_WRITE_URLS:-}" ]]; then
    back_services+=("vmagent")
    echo "==> [BACK:${target_host}] vmagent will push to: ${PROMETHEUS_REMOTE_WRITE_URLS}"
  fi

  # Patch back/.env to use Docker-internal service names instead of public hostnames.
  # From inside Docker containers on Linux, connecting to the host's own public hostname
  # does not work reliably (hairpin NAT). We rewrite REDIS_URL / DB_HOST / DATABASE_URL
  # in back/.env (loaded into the back container via env_file) to use the compose service
  # names, which resolve via Docker's internal DNS.
  #
  # We do NOT touch the root .env (used for compose YAML interpolation) — it must keep
  # the public DB_PORT so the `'${DB_PORT}:5432'` port mapping stays correct.
  local env_patched=0

  if [[ -n "${REDIS_HOST_VALUE:-}" ]]; then
    local redis_clean_host
    read -r _ redis_clean_host <<<"$(parse_host_entry "${REDIS_HOST_VALUE}" "${BACK_REMOTE_USER}")"
    if [[ "${target_host}" == "${redis_clean_host}" ]]; then
      back_services+=("redis")
      # The password must be URL-encoded so ioredis parses the URL correctly.
      local encoded_pw
      encoded_pw=$(python3 -c "import urllib.parse,sys; print(urllib.parse.quote(sys.argv[1], safe=''))" "${REDIS_PASSWORD:-}")
      local internal_redis_url="redis://:${encoded_pw}@redis:6379"
      cp "${BUILD_CONTEXT_DIR}/back/.env" "${BUILD_CONTEXT_DIR}/back/.env.bak"
      sed -i '' "s|^REDIS_URL=.*|REDIS_URL=${internal_redis_url}|" "${BUILD_CONTEXT_DIR}/back/.env"
      echo "==> [BACK:${target_host}] Redis colocated — REDIS_URL patched to internal Docker hostname"
      env_patched=1
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
    [[ ${env_patched} -eq 0 ]] && cp "${BUILD_CONTEXT_DIR}/back/.env" "${BUILD_CONTEXT_DIR}/back/.env.bak"
    sed -i '' \
      -e "s|^DB_HOST=.*|DB_HOST=db|" \
      -e "s|^DB_PORT=.*|DB_PORT=5432|" \
      -e "s|^DATABASE_URL=.*|DATABASE_URL=\"${internal_db_url}\"|" \
      "${BUILD_CONTEXT_DIR}/back/.env"
    echo "==> [BACK:${target_host}] Self-hosted DB — DB_HOST/DB_PORT/DATABASE_URL patched to internal Docker hostname"
    env_patched=1
  fi

  # Always inject SERVER_IP so the backend can identify its server for per-server run limits.
  [[ ${env_patched} -eq 0 ]] && cp "${BUILD_CONTEXT_DIR}/back/.env" "${BUILD_CONTEXT_DIR}/back/.env.bak"
  if grep -q "^SERVER_IP=" "${BUILD_CONTEXT_DIR}/back/.env"; then
    sed -i '' "s|^SERVER_IP=.*|SERVER_IP=${target_host}|" "${BUILD_CONTEXT_DIR}/back/.env"
  else
    printf '\nSERVER_IP=%s' "${target_host}" >> "${BUILD_CONTEXT_DIR}/back/.env"
  fi
  env_patched=1
  echo "==> [BACK:${target_host}] SERVER_IP set to ${target_host}"

  echo "==> [BACK:${target_host}] Deploying service"
  VMAGENT_CONFIG_PATH="${remote_dir}/vmagent.yml" \
  DOCKER_SSH_COMMAND="${docker_ssh_command}" docker --context "${context_name}" compose \
    --project-directory "${BUILD_CONTEXT_DIR}" \
    --project-name "${project_name}" \
    up -d "${back_services[@]}"

  # Restore original back/.env so subsequent host deployments (non-colocated) get the public values.
  # The root .env was never touched, so nothing to restore there.
  if [[ "${env_patched}" -eq 1 ]]; then
    mv "${BUILD_CONTEXT_DIR}/back/.env.bak" "${BUILD_CONTEXT_DIR}/back/.env"
  fi

  if wait_for_back_healthy "${context_name}" "${docker_ssh_command}" "${project_name}" "${target_host}"; then
    disable_back_maintenance "${context_name}" "${docker_ssh_command}" "${target_host}"
    # nginx resolves upstream hostnames once at (re)load: after a back recreate the
    # back-lb keeps proxying the OLD container IP → 502 until reloaded (observed
    # 2026-10-06: lb 7 days old, back 8 minutes, every request 502). Warn-only: a
    # missing/absent back-lb must never red an otherwise good deploy.
    DOCKER_SSH_COMMAND="${docker_ssh_command}" docker --context "${context_name}" compose \
      --project-directory "${BUILD_CONTEXT_DIR}" \
      --project-name "${project_name}" \
      exec -T back-lb nginx -s reload 2>/dev/null \
      && echo "==> [BACK:${target_host}] back-lb reloaded (fresh back upstream)" \
      || warn "[BACK:${target_host}] back-lb reload skipped/failed — reload it manually if the public URL 502s"
  else
    err "[BACK:${target_host}] New back service did not become healthy in time — leaving maintenance mode ON, aborting deploy."
    err "[BACK:${target_host}] Check 'docker --context ${context_name} compose --project-name ${project_name} logs back', fix the issue, then re-run the deploy to clear maintenance mode."
    exit 1
  fi

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
  if [[ "${RUNNER_PROVISION:-0}" == "1" ]]; then
    if [[ -x "${RUNNER_PROVISION_HOOK}" ]]; then
      RUNNER_SSH_TARGET="${ssh_target}" RUNNER_SSH_PORT="${ssh_port}" RUNNER_SSH_KEY="${key_path}" \
      RUNNER_TARGET_HOST="${target_host}" RUNNER_ROTATE="${RUNNER_ROTATE:-0}" \
        "${RUNNER_PROVISION_HOOK}" \
        || warn "[BACK:${target_host}] Runner auto-provisioning failed — pair manually (see hook output above)"
    else
      info "[BACK:${target_host}] RUNNER_PROVISION=1 but hook '${RUNNER_PROVISION_HOOK}' not found/executable — skipping runner auto-provisioning"
    fi
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

  # Remove any leftover container with a fixed container_name from a previous project name
  for cname in "${COMPOSE_PROJECT_NAME}_redis"; do
    if DOCKER_SSH_COMMAND="${docker_ssh_command}" docker --context "${context_name}" inspect "${cname}" >/dev/null 2>&1; then
      echo "==> [REDIS:${target_host}] Removing leftover container: ${cname}"
      DOCKER_SSH_COMMAND="${docker_ssh_command}" docker --context "${context_name}" rm -f "${cname}" 2>/dev/null || true
    fi
  done

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

  echo "==> [FRONT:${target_host}] Testing SSH connectivity"
  ssh "${ssh_opts[@]}" -o BatchMode=yes -o ConnectTimeout=10 "${ssh_target}" "echo SSH_OK" >/dev/null

  local remote_home
  remote_home=$(ssh "${ssh_opts[@]}" "${ssh_target}" 'printf %s "$HOME"')
  local remote_dir="${FRONT_REMOTE_APP_DIR/#\~/${remote_home}}"
  local remote_env_path="${remote_dir}/.env"

  echo "==> [FRONT:${target_host}] Preparing remote directory (${remote_dir})"
  ssh "${ssh_opts[@]}" "${ssh_target}" "mkdir -p '${remote_dir}'"

  echo "==> [FRONT:${target_host}] Uploading env file"
  scp "${scp_opts[@]}" "${FRONT_ENV_FILE}" "${ssh_target}:${remote_env_path}"
  ssh "${ssh_opts[@]}" "${ssh_target}" "chmod 600 '${remote_env_path}'" || true

  ensure_docker_context "${context_name}" "${ssh_target}" "${ssh_port}"

  echo "==> [FRONT:${target_host}] Building service"
  DOCKER_SSH_COMMAND="${docker_ssh_command}" docker --context "${context_name}" compose \
    --project-directory "${BUILD_CONTEXT_DIR}" \
    --project-name "${project_name}" \
    build ${NO_CACHE_FLAG} front

  # Set to --no-deps in the colocated branch below (see the note there): the front must
  # never reconcile the back service it shares its host with.
  local front_dep_flags=""
  if is_back_host_name "${target_host}"; then
    # Front is colocated with back — only stop the front service to avoid killing back + back-lb.
    #
    # --no-deps (used on the `up` below) is REQUIRED for exactly the same reason: `front`
    # declares `depends_on: {back: {condition: service_healthy}}`, so `up -d front` also
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
    echo "==> [FRONT:${target_host}] Stopping front service (colocated with back)"
    DOCKER_SSH_COMMAND="${docker_ssh_command}" docker --context "${context_name}" compose \
      --project-directory "${BUILD_CONTEXT_DIR}" \
      --project-name "${project_name}" \
      rm -sf front 2>/dev/null || true
  else
    echo "==> [FRONT:${target_host}] Stopping existing services"
    DOCKER_SSH_COMMAND="${docker_ssh_command}" docker --context "${context_name}" compose \
      --project-directory "${BUILD_CONTEXT_DIR}" \
      --project-name "${project_name}" \
      down --remove-orphans 2>/dev/null || true
  fi

  # Also remove any leftover containers with fixed container_name (from previous deployments with different project names)
  for cname in "${COMPOSE_PROJECT_NAME}_front"; do
    if DOCKER_SSH_COMMAND="${docker_ssh_command}" docker --context "${context_name}" inspect "${cname}" >/dev/null 2>&1; then
      echo "==> [FRONT:${target_host}] Removing leftover container: ${cname}"
      DOCKER_SSH_COMMAND="${docker_ssh_command}" docker --context "${context_name}" rm -f "${cname}" 2>/dev/null || true
    fi
  done

  echo "==> [FRONT:${target_host}] Deploying service"
  DOCKER_SSH_COMMAND="${docker_ssh_command}" docker --context "${context_name}" compose \
    --project-directory "${BUILD_CONTEXT_DIR}" \
    --project-name "${project_name}" \
    up -d ${front_dep_flags} front

  echo "==> [FRONT:${target_host}] Status"
  DOCKER_SSH_COMMAND="${docker_ssh_command}" docker --context "${context_name}" compose \
    --project-directory "${BUILD_CONTEXT_DIR}" \
    --project-name "${project_name}" ps front
}

if [[ "${DEPLOY_TARGET}" != "front" && -n "${REDIS_HOST_VALUE}" ]]; then
  echo "==> Deploying Redis on ${REDIS_HOST_VALUE}"
  deploy_redis_host
fi

if [[ "${DEPLOY_TARGET}" != "front" ]]; then
  echo "==> Deploying back services on ${#BACK_HOSTS[@]} host(s)"
  for host in "${BACK_HOSTS[@]}"; do
    deploy_back_host "${host}"
  done
fi

if [[ "${DEPLOY_TARGET}" == "back" ]]; then
  echo "==> Deployment completed (back only)"
  exit 0
fi

if [[ "${IS_CLOUD_FRONT}" -eq 1 ]]; then
  echo "==> Deploying front to Cloudflare Pages"
  require_cmd npx

  # Build directly from ./front/ to reuse existing node_modules (avoids full reinstall)
  FRONT_DIST_DIR="./front/dist"

  if [[ ! -d "./front/node_modules" ]]; then
    echo "==> [CLOUD] Installing front dependencies"
    (cd front && npm install) || { echo "Error: front npm install failed"; exit 1; }
  else
    echo "==> [CLOUD] Reusing existing node_modules"
  fi

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
  (cd front && NODE_OPTIONS="--max-old-space-size=4096" ./node_modules/.bin/vite build ${FRONT_VITE_MODE:+--mode "${FRONT_VITE_MODE}"}) || {
    echo "Error: front build failed"
    exit 1
  }

  if [[ ! -d "${FRONT_DIST_DIR}" ]]; then
    echo "Error: front build did not produce dist/ directory."
    exit 1
  fi

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
  npx --yes wrangler pages deploy "${FRONT_DIST_DIR}" --project-name="${CLOUDFLARE_PAGES_PROJECT}" --branch="${CLOUDFLARE_PAGES_BRANCH_VALUE}"

  echo "==> [CLOUD] Front deployed to Cloudflare Pages"
else
  echo "==> Deploying front services on ${#FRONT_HOSTS[@]} host(s)"
  for host in "${FRONT_HOSTS[@]}"; do
    deploy_front_host "${host}"
  done
fi

if [[ "${DEPLOY_TARGET}" != "front" ]]; then
  configure_firewall_rules
  apply_firewall_rules
fi

echo "==> Deployment completed"
