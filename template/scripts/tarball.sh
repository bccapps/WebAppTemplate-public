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
# tarball.sh — Create a portable archive of the project
# ============================================================
# Produces a .tar.gz containing front/, back/, and scripts/
# with all symlinks resolved (real files copied, not links).
# The archive is self-contained and ready to run:
#   tar xzf <archive>.tar.gz
#   cd <project>/
#   ./scripts/run.sh dev
#
# Usage:
#   ./scripts/tarball.sh                  Default output name
#   ./scripts/tarball.sh myarchive.tar.gz Custom output name
# ============================================================

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
cd "${PROJECT_ROOT}"

PROJECT_NAME="$(basename "${PROJECT_ROOT}")"
TIMESTAMP="$(date +%Y%m%d_%H%M%S)"
OUTPUT="${1:-${PROJECT_NAME}-${TIMESTAMP}.tar.gz}"

# ---------- Colours ----------
GREEN='\033[0;32m'
CYAN='\033[0;36m'
NC='\033[0m'

info()  { printf "${CYAN}==> %s${NC}\n" "$*"; }
ok()    { printf "${GREEN}==> %s${NC}\n" "$*"; }

# ---------- Build staging directory ----------
STAGING_DIR=$(mktemp -d "${TMPDIR:-/tmp}/${PROJECT_NAME}-tarball.XXXXXX")
STAGING_PROJECT="${STAGING_DIR}/${PROJECT_NAME}"

cleanup() {
  rm -rf "${STAGING_DIR}"
}
trap cleanup EXIT

RSYNC_EXCLUDES=(
  "--exclude=.git"
  "--exclude=node_modules"
  "--exclude=dist"
  "--exclude=coverage"
  "--exclude=.turbo"
  "--exclude=.next"
  "--exclude=.cache"
  "--exclude=.db"
  "--exclude=*.bak"
  "--exclude=*.dump"
  "--exclude=*.sql"
)

mkdir -p "${STAGING_PROJECT}"

# Copy front/, back/, scripts/ with symlinks resolved (-L)
for dir in front back scripts; do
  if [[ -d "./${dir}" ]]; then
    info "Staging ${dir}/ (resolving symlinks)..."
    rsync -aL --delete "${RSYNC_EXCLUDES[@]}" "./${dir}/" "${STAGING_PROJECT}/${dir}/"
  fi
done

# Copy root-level config files needed for run.sh
for f in .env package.json tsconfig.json CLAUDE.md README.md FEATURES.md SCALING.md; do
  [[ -f "./${f}" ]] && cp "./${f}" "${STAGING_PROJECT}/${f}" 2>/dev/null || true
done

# ---------- Create archive ----------
info "Creating archive: ${OUTPUT}"
tar czf "${OUTPUT}" -C "${STAGING_DIR}" "${PROJECT_NAME}"

ARCHIVE_SIZE=$(du -sh "${OUTPUT}" | cut -f1)
ok "Archive created: ${OUTPUT} (${ARCHIVE_SIZE})"
echo ""
echo "  To use:"
echo "    tar xzf ${OUTPUT}"
echo "    cd ${PROJECT_NAME}/"
echo "    ./scripts/run.sh dev"
echo ""
