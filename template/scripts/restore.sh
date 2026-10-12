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

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
cd "${PROJECT_ROOT}"

# ============================================================
# restore.sh — Restore back/.env (and front/.env if present)
#              from the most recent pre-migration backup for
#              a given source server IP.
#
# Backups are created by migrate-server.sh under:
#   back/.env.pre-migration-<ip>-<YYYYMMDD_HHMMSS>
#   front/.env.pre-migration-<ip>-<YYYYMMDD_HHMMSS>
#
# Usage:
#   ./scripts/restore.sh [user@]x.x.x.x   Restore latest backup for that IP
#   ./scripts/restore.sh --list            List all available backups
#   ./scripts/restore.sh --help            Show this help
# ============================================================

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; CYAN='\033[0;36m'; NC='\033[0m'
ok()   { printf "${GREEN}==> %s${NC}\n" "$*"; }
info() { printf "${CYAN}==> %s${NC}\n" "$*"; }
warn() { printf "${YELLOW}==> %s${NC}\n" "$*"; }
err()  { printf "${RED}==> Error: %s${NC}\n" "$*" >&2; exit 1; }

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

is_valid_ipv4() {
  local ip="$1"
  [[ "${ip}" =~ ^([0-9]{1,3}\.){3}[0-9]{1,3}$ ]] || return 1
  local IFS='.' part
  read -ra parts <<< "${ip}"
  for part in "${parts[@]}"; do
    [[ "${part}" -le 255 ]] || return 1
  done
  return 0
}

list_all_backups() {
  local back_backups front_backups
  back_backups=$(ls -1 ./back/.env.pre-migration-* 2>/dev/null | sort -r || true)
  front_backups=$(ls -1 ./front/.env.pre-migration-* 2>/dev/null | sort -r || true)

  if [[ -z "${back_backups}" && -z "${front_backups}" ]]; then
    echo "No pre-migration backups found."
    echo "  (migrate-server.sh creates them at: back/.env.pre-migration-<ip>-<timestamp>)"
    return
  fi

  if [[ -n "${back_backups}" ]]; then
    echo "back/.env backups:"
    while IFS= read -r f; do
      printf "  %s\n" "${f}"
    done <<< "${back_backups}"
  fi

  if [[ -n "${front_backups}" ]]; then
    echo ""
    echo "front/.env backups:"
    while IFS= read -r f; do
      printf "  %s\n" "${f}"
    done <<< "${front_backups}"
  fi
}

# ---------------------------------------------------------------------------
# Parse argument
# ---------------------------------------------------------------------------

ARG="${1:-}"

if [[ -z "${ARG}" || "${ARG}" == "--help" || "${ARG}" == "-h" ]]; then
  cat <<'EOF'
Usage: ./scripts/restore.sh [user@]x.x.x.x
       ./scripts/restore.sh --list

Restores back/.env (and front/.env if a backup exists) from the most
recent pre-migration backup created by migrate-server.sh for the given IP.

Before overwriting, the current .env is saved to back/.env.before-restore-<timestamp>.
EOF
  exit 0
fi

if [[ "${ARG}" == "--list" ]]; then
  list_all_backups
  exit 0
fi

# Strip optional user@ prefix
IP="${ARG##*@}"

if ! is_valid_ipv4 "${IP}"; then
  err "'${IP}' is not a valid IPv4 address.
  Expected: [user@]x.x.x.x  (e.g. user@203.0.113.10)"
fi

# ---------------------------------------------------------------------------
# Find backups for this IP
# ---------------------------------------------------------------------------

BACK_ENV="./back/.env"
FRONT_ENV="./front/.env"
BACK_PATTERN="${BACK_ENV}.pre-migration-${IP}-"
FRONT_PATTERN="${FRONT_ENV}.pre-migration-${IP}-"

# Most recent = lexicographically last (YYYYMMDD_HHMMSS suffix)
LATEST_BACK=""
while IFS= read -r f; do
  LATEST_BACK="${f}"
done < <(ls -1 "${BACK_PATTERN}"* 2>/dev/null | sort || true)

LATEST_FRONT=""
while IFS= read -r f; do
  LATEST_FRONT="${f}"
done < <(ls -1 "${FRONT_PATTERN}"* 2>/dev/null | sort || true)

if [[ -z "${LATEST_BACK}" ]]; then
  err "No back/.env backup found for IP ${IP}.
  Searched: ${BACK_PATTERN}*

$(list_all_backups)"
fi

# ---------------------------------------------------------------------------
# Confirmation prompt
# ---------------------------------------------------------------------------

echo ""
printf "${YELLOW}Restore preview:${NC}\n"
echo "  IP:                ${IP}"
echo "  back/.env backup:  ${LATEST_BACK}"
[[ -n "${LATEST_FRONT}" ]] && \
echo "  front/.env backup: ${LATEST_FRONT}" || \
echo "  front/.env backup: (none found for this IP)"
echo ""
printf "${YELLOW}Current back/.env will be overwritten.${NC}\n"
echo ""
read -rp "Restore? [y/N] " -n 1 CONFIRM; echo
[[ "${CONFIRM}" =~ ^[Yy]$ ]] || { warn "Aborted."; exit 0; }

# ---------------------------------------------------------------------------
# Safety copy of current files
# ---------------------------------------------------------------------------

TS="$(date +%Y%m%d_%H%M%S)"

if [[ -f "${BACK_ENV}" ]]; then
  SAFETY="${BACK_ENV}.before-restore-${TS}"
  cp "${BACK_ENV}" "${SAFETY}"
  info "Current back/.env saved to ${SAFETY}"
fi

if [[ -n "${LATEST_FRONT}" && -f "${FRONT_ENV}" ]]; then
  FRONT_SAFETY="${FRONT_ENV}.before-restore-${TS}"
  cp "${FRONT_ENV}" "${FRONT_SAFETY}"
  info "Current front/.env saved to ${FRONT_SAFETY}"
fi

# ---------------------------------------------------------------------------
# Restore
# ---------------------------------------------------------------------------

cp "${LATEST_BACK}" "${BACK_ENV}"
ok "Restored: ${LATEST_BACK} → ${BACK_ENV}"

if [[ -n "${LATEST_FRONT}" ]]; then
  cp "${LATEST_FRONT}" "${FRONT_ENV}"
  ok "Restored: ${LATEST_FRONT} → ${FRONT_ENV}"
fi

# Show the restored host values for a quick sanity check
RESTORED_BACK_HOSTS=$(grep -E "^BACK_HOSTS=" "${BACK_ENV}" 2>/dev/null | head -1 || echo "(not set)")
RESTORED_REMOTE_HOST=$(grep -E "^REMOTE_HOST=" "${BACK_ENV}" 2>/dev/null | head -1 || echo "(not set)")
echo ""
info "Sanity check (from restored back/.env):"
echo "  ${RESTORED_BACK_HOSTS}"
echo "  ${RESTORED_REMOTE_HOST}"

# ---------------------------------------------------------------------------
# Next steps
# ---------------------------------------------------------------------------

PROJECT_NAME_VALUE=$(grep -E "^PROJECT_NAME=" "${BACK_ENV}" 2>/dev/null | head -1 | sed 's/^[^=]*=//' | tr -d '"' | tr -d "'" || echo "PROJECT_NAME")
echo ""
printf "${YELLOW}Next steps:${NC}\n"
echo "  Option A — restart source containers directly (fastest):"
echo "    ssh user@${IP}"
echo "    docker start \$(docker ps -aq -f 'name=${PROJECT_NAME_VALUE}')"
echo ""
echo "  Option B — full redeploy to ${IP} from current code:"
echo "    ./scripts/deploy-full.sh"
echo ""
