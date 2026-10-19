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
# bundle.sh — distributable desktop packages, collected in desktop/dist/
# ============================================================
# Usage:
#   ./scripts/bundle.sh                         this machine + win-x64 + linux-x64
#   ./scripts/bundle.sh --targets darwin-arm64,win-x64
#   ./scripts/bundle.sh windows                 one or more platforms: windows (win), macos (mac), linux, or a target id
#   ./scripts/bundle.sh macos linux             (macos = this Mac's architecture; windows/linux = x64)
#   ./scripts/bundle.sh --clean                 full rebuild (production node_modules, DESKTOP_CLEAN=1 for the hook)
#
# Per target (ids of scripts/desktop/lib.mjs: darwin-arm64, darwin-x64, linux-x64, linux-arm64, win-x64):
#   - this machine: native installer through `tauri build` (macOS: .app + .dmg; Linux: .deb + .AppImage; Windows: NSIS)
#   - another OS: portable archive by scripts/desktop/package-cross.mjs (Windows .zip, Linux .tar.gz + launch.sh)
#     Windows from macOS/Linux needs mingw-w64 (`brew install mingw-w64`) and zip; Linux from macOS/Windows needs
#     a running Docker (the shell is compiled in a container). macOS packages are built on a Mac only.
# A target whose tools are missing is skipped with the reason; the run goes on with the next one. Exit status 1 when
# a target failed, or when a target named by --targets was skipped.
# Project hook: scripts-local/desktop-prepare.sh <target> (DESKTOP_PREPARE_HOOK), see scripts/desktop/common.sh.
# DESKTOP_BUNDLES overrides the `tauri build --bundles` list of the host target (Windows: nsis,msi for an .msi too, needs WiX).
# Unsigned builds: see desktop/README.md (signing). Cross packages have not been run on their target hardware.
# ============================================================

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
cd "${PROJECT_ROOT}"
# shellcheck source=desktop/common.sh
source "${SCRIPT_DIR}/desktop/common.sh"

TARGETS=""; EXPLICIT=0
# Platform names accepted as arguments, resolved against the host once known.
platform_target() {
  case "$1" in
    windows|win) echo win-x64 ;;
    linux) echo linux-x64 ;;
    macos|mac|darwin) echo "${HOST_OS_ARCH_DARWIN}" ;;
    darwin-arm64|darwin-x64|linux-x64|linux-arm64|win-x64) echo "$1" ;;
    *) return 1 ;;
  esac
}
POSITIONAL=()
while [[ $# -gt 0 ]]; do
  case "$1" in
    --targets) TARGETS="${2:?--targets needs a comma-separated list}"; EXPLICIT=1; shift 2 ;;
    --clean) export DESKTOP_CLEAN=1; shift ;;
    -h|--help) sed -n '/^# Usage:/,/^# =====/p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    -*) err "Unknown option: $1"; exit 2 ;;
    *) POSITIONAL+=("$1"); shift ;;
  esac
done

desktop_check_project
HOST="$(host_target)"
HOST_OS="${HOST%%-*}"
HOST_OS_ARCH_DARWIN="darwin-${HOST##*-}"
if [[ ${#POSITIONAL[@]} -gt 0 ]]; then
  [[ -z "${TARGETS}" ]] || { err "Give either platform names or --targets, not both"; exit 2; }
  for p in "${POSITIONAL[@]}"; do
    t="$(platform_target "$p")" || { err "Unknown platform: $p (windows, macos, linux or a target id)"; exit 2; }
    TARGETS="${TARGETS:+${TARGETS},}${t}"
  done
  EXPLICIT=1
fi
if [[ -z "${TARGETS}" ]]; then
  TARGETS="${HOST}"
  for t in win-x64 linux-x64; do [[ "${t%%-*}" == "${HOST_OS}" ]] || TARGETS="${TARGETS},${t}"; done
fi
DIST="${PROJECT_ROOT}/desktop/dist"
BUNDLE_DIR="$(release_dir)/bundle"
mkdir -p "${DIST}"
mkdir -p "${PROJECT_ROOT}/desktop/build"
RUN_STAMP="$(mktemp "${PROJECT_ROOT}/desktop/build/.bundle-run.XXXXXX")"   # packages newer than this = this run
trap 'rm -f "${RUN_STAMP}"' EXIT

# Prints the reason why <target> cannot be built here, nothing when it can.
missing_tools() {
  local target="$1" os="${1%%-*}"
  if [[ "${target}" == "${HOST}" ]]; then return; fi
  case "${os}" in
    darwin) echo "macOS packages are built on a Mac (${target} on ${HOST})" ;;
    win)
      [[ "${HOST_OS}" == win ]] && { echo "build win-x64 natively on an x64 Windows machine"; return; }
      command -v x86_64-w64-mingw32-gcc >/dev/null || { echo "mingw-w64 missing (macOS: brew install mingw-w64; Debian: apt install mingw-w64)"; return; }
      command -v zip >/dev/null || echo "zip missing"
      ;;
    linux)
      command -v docker >/dev/null || { echo "Docker missing (the Linux shell is compiled in a container)"; return; }
      docker info >/dev/null 2>&1 || echo "Docker is not running"
      ;;
  esac
}

# Copies the native installers of the host build into desktop/dist/.
collect_host() {
  local found=0 f
  shopt -s nullglob
  for f in "${BUNDLE_DIR}"/dmg/*.dmg "${BUNDLE_DIR}"/deb/*.deb "${BUNDLE_DIR}"/appimage/*.AppImage "${BUNDLE_DIR}"/nsis/*.exe "${BUNDLE_DIR}"/msi/*.msi; do
    cp -f "${f}" "${DIST}/"; found=1
  done
  shopt -u nullglob
  [[ ${found} -eq 1 ]] || { err "tauri build produced no installer in ${BUNDLE_DIR}"; return 1; }
}

# Case-insensitive file systems (macOS default) can merge node_modules files that differ only by case.
warn_case_insensitive() {
  local probe; mkdir -p "${PROJECT_ROOT}/desktop/build"; probe="$(mktemp -d "${PROJECT_ROOT}/desktop/build/case.XXXXXX")"
  touch "${probe}/a"
  [[ -e "${probe}/A" ]] && warn "$1: resources assembled on a case-insensitive file system (desktop/README.md, Packaging); check the archive on Linux"
  rm -rf "${probe}"
}

# Explicit `|| return 1`: errexit is off inside a function called as an `if` condition.
build_target() {
  local target="$1"
  run_prepare_hook "${target}" || return 1
  if [[ "${target}" == "${HOST}" ]]; then
    find "${BUNDLE_DIR}" -maxdepth 2 \( -name '*.dmg' -o -name '*.deb' -o -name '*.AppImage' -o -name '*-setup.exe' -o -name '*.msi' \) -delete 2>/dev/null || true
    assemble "${target}" --bundle || return 1
    collect_host
  else
    [[ "${target%%-*}" == linux ]] && warn_case_insensitive "${target}"
    assemble "${target}" || return 1
    node "${DESKTOP_SCRIPTS}/package-cross.mjs" --root "${PROJECT_ROOT}" --target "${target}" --resources "$(resources_dir "${target}")" --out "${DIST}"
  fi
}

info "$(desktop_field 'c.productName'): packages for ${TARGETS//,/, } (host ${HOST})"
build_web
DONE=(); SKIPPED=(); FAILED=()
IFS=',' read -r -a LIST <<< "${TARGETS}"
for target in "${LIST[@]}"; do
  reason="$(missing_tools "${target}")"
  if [[ -n "${reason}" ]]; then
    warn "${target} skipped: ${reason}"; SKIPPED+=("${target} (${reason})"); continue
  fi
  info "=== ${target} ==="
  if build_target "${target}"; then DONE+=("${target}"); else err "${target} failed"; FAILED+=("${target}"); fi
done

echo ""
[[ ${#DONE[@]} -gt 0 ]] && ok "Built: ${DONE[*]}"
for s in ${SKIPPED[@]+"${SKIPPED[@]}"}; do warn "Skipped: ${s}"; done
[[ ${#FAILED[@]} -gt 0 ]] && err "Failed: ${FAILED[*]}"
echo "  Written to ${DIST} by this run:"
find "${DIST}" -maxdepth 1 -type f -newer "${RUN_STAMP}" -exec basename {} \; | sort | sed 's/^/    /'
if [[ ${#FAILED[@]} -gt 0 ]] || { [[ ${EXPLICIT} -eq 1 ]] && [[ ${#SKIPPED[@]} -gt 0 ]]; }; then exit 1; fi
