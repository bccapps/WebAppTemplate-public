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
# app.sh — build the desktop app for THIS machine and launch it
# ============================================================
# Usage:
#   ./scripts/app.sh             build back + front, the prepare hook, the resources, the shell; then launch
#   ./scripts/app.sh --no-run    build only
#   ./scripts/app.sh --no-build  launch the last build
#   ./scripts/app.sh --clean     full rebuild (production node_modules, DESKTOP_CLEAN=1 for the hook)
#
# macOS: builds and opens desktop/src-tauri/target/release/bundle/macos/<Product>.app (no .dmg: see bundle.sh).
# Linux / Windows (Git Bash): builds the shell binary only (no installer) and runs it on the resources folder
# (DESKTOP_RESOURCES). Installers and packages for every platform: scripts/bundle.sh.
# Project hook: scripts-local/desktop-prepare.sh <target> (DESKTOP_PREPARE_HOOK), see scripts/desktop/common.sh.
# Needs Node >= 22 and Rust (rustup); Linux also WebKitGTK dev packages (desktop/README.md).
# ============================================================

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
cd "${PROJECT_ROOT}"
# shellcheck source=desktop/common.sh
source "${SCRIPT_DIR}/desktop/common.sh"

BUILD=1; RUN=1
for arg in "$@"; do
  case "${arg}" in
    --no-run) RUN=0 ;;
    --no-build) BUILD=0 ;;
    --clean) export DESKTOP_CLEAN=1 ;;
    -h|--help) sed -n '/^# Usage:/,/^# =====/p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) err "Unknown option: ${arg}"; exit 2 ;;
  esac
done

desktop_check_project
TARGET="$(host_target)"
PRODUCT="$(desktop_field 'c.productName')"
RESOURCES="$(resources_dir "${TARGET}")"
OS="${TARGET%%-*}"

if [[ ${BUILD} -eq 1 ]]; then
  info "${PRODUCT}: desktop build for ${TARGET}"
  build_web
  run_prepare_hook "${TARGET}"
  if [[ "${OS}" == darwin ]]; then
    assemble "${TARGET}" --bundle --bundles app --no-dmg
  else
    assemble "${TARGET}" --bundle --bundles none
  fi
  ok "Build done"
fi
[[ ${RUN} -eq 1 ]] || exit 0

if [[ "${OS}" == darwin ]]; then
  APP="$(release_dir)/bundle/macos/${PRODUCT}.app"
  [[ -d "${APP}" ]] || { err "No build found (${APP}): run without --no-build"; exit 1; }
  # Single instance: a running copy would only be focused, so quit it first to see the new build.
  if pgrep -f "${APP}/Contents/MacOS/" >/dev/null; then
    info "Quitting the running ${PRODUCT}"
    pkill -TERM -f "${APP}/Contents/MacOS/" || true   # the shell stops its processes on SIGTERM
    for _ in $(seq 1 20); do pgrep -f "${APP}/Contents/MacOS/" >/dev/null || break; sleep 0.5; done
  fi
  ok "Opening ${APP}"
  open "${APP}"
  echo "  Logs: ~/Library/Application Support/$(desktop_field 'c.identifier')/logs"
else
  BIN="$(release_dir)/desktop-shell"
  [[ "${OS}" == win ]] && BIN="${BIN}.exe"
  [[ -x "${BIN}" ]] || { err "No build found (${BIN}): run without --no-build"; exit 1; }
  [[ -d "${RESOURCES}" ]] || { err "No resources folder (${RESOURCES}): run without --no-build"; exit 1; }
  ok "Launching ${PRODUCT} (resources: ${RESOURCES})"
  DESKTOP_RESOURCES="${RESOURCES}" exec "${BIN}"
fi
