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
# upload.sh — Create tarball if needed and upload to Cloudflare R2
# ============================================================
# Usage:
#   ./scripts/upload.sh                     Upload with default archive name
#   ./scripts/upload.sh myarchive.tar.gz    Upload a specific archive
#
# Required env vars (in front/.env or exported):
#   R2_ACCESS_KEY_ID       Cloudflare R2 API access key
#   R2_SECRET_ACCESS_KEY   Cloudflare R2 API secret key
#   R2_BUCKET              R2 bucket name
#   CLOUDFLARE_ACCOUNT_ID  Cloudflare account ID
# ============================================================

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
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

# ---------- Load env ----------
load_env_file() {
  local f="$1"
  if [[ -f "${f}" ]]; then
    set -a
    # shellcheck disable=SC1090
    source "${f}"
    set +a
  fi
}

# Load env files that might contain R2 credentials
load_env_file "${PROJECT_ROOT}/front/.env"
load_env_file "${PROJECT_ROOT}/back/.env"

# ---------- Validate required vars ----------
ACCOUNT_ID="${CLOUDFLARE_ACCOUNT_ID:-${R2_ACCOUNT_ID:-}}"
ACCESS_KEY="${R2_ACCESS_KEY_ID:-}"
SECRET_KEY="${R2_SECRET_ACCESS_KEY:-}"
BUCKET="${R2_BUCKET:-}"

if [[ -z "${ACCOUNT_ID}" ]]; then
  err "Missing CLOUDFLARE_ACCOUNT_ID or R2_ACCOUNT_ID"
  exit 1
fi
if [[ -z "${ACCESS_KEY}" ]]; then
  err "Missing R2_ACCESS_KEY_ID"
  echo ""
  echo "  To create R2 API credentials:"
  echo "    1. Go to Cloudflare Dashboard → R2 → Manage R2 API Tokens"
  echo "    2. Create a token with 'Object Read & Write' permissions"
  echo "    3. Add to front/.env or back/.env:"
  echo "       R2_ACCESS_KEY_ID=<your access key>"
  echo "       R2_SECRET_ACCESS_KEY=<your secret key>"
  echo "       R2_BUCKET=<your bucket name>"
  echo ""
  exit 1
fi
if [[ -z "${SECRET_KEY}" ]]; then
  err "Missing R2_SECRET_ACCESS_KEY"
  exit 1
fi
if [[ -z "${BUCKET}" ]]; then
  err "Missing R2_BUCKET"
  exit 1
fi

# ---------- Check rclone ----------
if ! command -v rclone &>/dev/null; then
  err "rclone is required but not installed"
  echo "  Install with: brew install rclone"
  exit 1
fi

# ---------- Determine archive ----------
PROJECT_NAME="$(basename "${PROJECT_ROOT}")"
TIMESTAMP="$(date +%Y%m%d_%H%M%S)"
ARCHIVE="${1:-${PROJECT_NAME}-${TIMESTAMP}.tar.gz}"

# If archive doesn't exist, create it via tarball.sh
if [[ ! -f "${ARCHIVE}" ]]; then
  warn "Archive '${ARCHIVE}' not found, creating it..."
  "${SCRIPT_DIR}/tarball.sh" "${ARCHIVE}"
  echo ""
fi

if [[ ! -f "${ARCHIVE}" ]]; then
  err "Archive '${ARCHIVE}' still not found after tarball.sh"
  exit 1
fi

ARCHIVE_SIZE=$(du -sh "${ARCHIVE}" | cut -f1)
info "Uploading ${ARCHIVE} (${ARCHIVE_SIZE}) to R2 bucket '${BUCKET}'..."

# ---------- Configure rclone on the fly ----------
R2_ENDPOINT="https://${ACCOUNT_ID}.r2.cloudflarestorage.com"

export RCLONE_CONFIG_R2_TYPE=s3
export RCLONE_CONFIG_R2_PROVIDER=Cloudflare
export RCLONE_CONFIG_R2_ACCESS_KEY_ID="${ACCESS_KEY}"
export RCLONE_CONFIG_R2_SECRET_ACCESS_KEY="${SECRET_KEY}"
export RCLONE_CONFIG_R2_ENDPOINT="${R2_ENDPOINT}"
export RCLONE_CONFIG_R2_ACL=private
export RCLONE_CONFIG_R2_NO_CHECK_BUCKET=true

# ---------- Upload ----------
REMOTE_PATH="r2:${BUCKET}/releases/${ARCHIVE}"

rclone copyto "${ARCHIVE}" "${REMOTE_PATH}" --progress

ok "Upload complete: ${REMOTE_PATH}"
echo ""
echo "  Bucket:  ${BUCKET}"
echo "  Path:    releases/${ARCHIVE}"
echo "  Size:    ${ARCHIVE_SIZE}"
echo ""
echo "  Download with:"
echo "    rclone copyto ${REMOTE_PATH} ./${ARCHIVE}"
echo ""
