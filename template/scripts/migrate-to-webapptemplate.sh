#!/usr/bin/env bash

# =============================================================================
# VXFramework
#
# Copyright (c) 2025-2026 Stéphane VAXELAIRE <svax974@gmail.com>
# SPDX-License-Identifier: MIT
#
# Licensed under the MIT License. See LICENSE in the project root.
# =============================================================================
#
# Migrates an app from the LEGACY layout (4 submodules: back/.libs/nestcommon,
# front/.libs/reactcommon, back/.libs/apptemplate, front/.libs/apptemplate) to the
# WebAppTemplate layout:
#   {back,front}/.libs/vx-public    (WebAppTemplate-public, MIT)
#   {back,front}/.libs/vx-private   (WebAppTemplate-private, proprietary)
#   {back,front}/.libs/apptemplate  committed symlink -> vx-public/template
#
# Run from the ROOT of a legacy app (a monorepo: one .git at the root). Idempotent.
# It does NOT commit: it prints a summary and the suggested commit command.
#
# Usage:
#   scripts/migrate-to-webapptemplate.sh [PROJECT_ROOT]   (default: current directory)
#   --without-private   do not mount vx-private (an app with no private module)
#
# Env overrides:
#   VX_PUBLIC_URL   (default https://github.com/bccapps/WebAppTemplate-public.git)
#   VX_PRIVATE_URL  (default https://github.com/bccapps/WebAppTemplate-private.git)
#   LIB_BRANCH      (default main)
# =============================================================================

set -euo pipefail

info() { printf '\033[1;34m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m⚠\033[0m  %s\n' "$*" >&2; }
ok()   { printf '\033[1;32m✓\033[0m  %s\n' "$*"; }
die()  { printf '\033[1;31m✖\033[0m  %s\n' "$*" >&2; exit 1; }

SCRIPT_SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/libs.sh
source "${SCRIPT_SRC_DIR}/lib/libs.sh"

WITH_PRIVATE=1
ROOT_ARG=""
for arg in "$@"; do
  case "${arg}" in
    --without-private) WITH_PRIVATE=0 ;;
    -*) die "unknown option: ${arg}" ;;
    *) ROOT_ARG="${arg}" ;;
  esac
done

ROOT="$(cd "${ROOT_ARG:-$PWD}" && pwd)"
cd "${ROOT}"
[[ -e .git ]] || die "${ROOT} is not the root of a git repository (monorepo expected)."
[[ -d back && -d front ]] || die "${ROOT} has no back/ and front/ directories."

OLD_SUBMODULES=(back/.libs/nestcommon front/.libs/reactcommon back/.libs/apptemplate front/.libs/apptemplate)
GIT_COMMON_DIR="$(git rev-parse --git-common-dir)"

already_migrated() { vx_submodule_declared back/.libs/vx-public && vx_submodule_declared front/.libs/vx-public; }

# ---------------------------------------------------------------------------
# 1. Pre-conditions
# ---------------------------------------------------------------------------
check_preconditions() {
  local problems=0 sm
  if [[ -n "$(git status --porcelain)" ]]; then
    warn "git status is not clean in ${ROOT}:"; git status --short >&2; problems=1
  fi
  for sm in "${OLD_SUBMODULES[@]}"; do
    [[ -e "${sm}/.git" ]] || continue            # not initialised: nothing local to lose
    if [[ -n "$(git -C "${sm}" status --porcelain)" ]]; then
      warn "${sm}: uncommitted changes"; problems=1
    fi
    git -C "${sm}" fetch -q origin 2>/dev/null || warn "${sm}: fetch failed (offline?) — cannot verify unpushed commits"
    local ahead
    ahead="$(git -C "${sm}" rev-list --count origin/main..HEAD 2>/dev/null || echo '?')"
    if [[ "${ahead}" != "0" ]]; then
      warn "${sm}: ${ahead} commit(s) ahead of origin/main (push them first: scripts/update_common.sh)"; problems=1
    fi
  done
  (( problems == 0 )) || die "pre-conditions failed — fix the points above and re-run."
}

# ---------------------------------------------------------------------------
# 2. Remove the legacy submodules
# ---------------------------------------------------------------------------
remove_legacy_submodules() {
  local sm
  for sm in "${OLD_SUBMODULES[@]}"; do
    if vx_submodule_declared "${sm}"; then
      info "removing legacy submodule ${sm}"
      git submodule deinit -f -- "${sm}" >/dev/null 2>&1 || true
      git rm -f -q "${sm}"
    fi
    rm -rf "${GIT_COMMON_DIR}/modules/${sm}"
  done
  # Leftover real directories of a half-done previous run (not tracked any more).
  for sm in "${OLD_SUBMODULES[@]}"; do
    if [[ -d "${sm}" && ! -L "${sm}" && -z "$(ls -A "${sm}" 2>/dev/null)" ]]; then rmdir "${sm}"; fi
  done
}

# SHA of the pre-migration wrapper copies, to know whether a local copy is a pure copy.
legacy_script_sha() {
  local stack="$1"
  local f="${stack}/.libs/apptemplate/scripts/link-shared.mjs"
  [[ -f "${f}" ]] && shasum -a 256 "${f}" | cut -d' ' -f1 || true
}

# ---------------------------------------------------------------------------
# main
# ---------------------------------------------------------------------------
if already_migrated; then
  ok "vx-public already mounted — skipping the submodule steps (idempotent re-run)."
else
  info "Checking pre-conditions..."
  check_preconditions
  LEGACY_SHA_BACK="$(legacy_script_sha back)"
  LEGACY_SHA_FRONT="$(legacy_script_sha front)"
  remove_legacy_submodules
fi

info "Mounting vx-public$([[ "${WITH_PRIVATE}" == "1" ]] && echo ' + vx-private')..."
vx_setup_libs "${WITH_PRIVATE}"

# Root pointers. `scripts` keeps its path (front/.libs/apptemplate/scripts is now a symlink hop).
vx_link_root_pointers
if [[ -f front/.libs/apptemplate/scripts/project-docs.mjs ]]; then
  node front/.libs/apptemplate/scripts/project-docs.mjs ensure "${ROOT}" || warn "project-docs.mjs failed — see above"
else
  warn "project-docs.mjs not found in the template: CLAUDE.md / AGENTS.md left untouched."
fi

info "Re-materializing config links and shared modules..."
node back/.libs/apptemplate/scripts/link-config.mjs "${ROOT}"
for stack in back front; do
  ( cd "${stack}" \
    && node .libs/apptemplate/scripts/link-shared.mjs "${stack}" \
    && if [[ -f package.local.json ]]; then node .libs/apptemplate/scripts/build-package.mjs "${stack}"; fi )
done

# Per-app copies of link-shared.mjs are obsolete (package scripts call .libs/apptemplate/scripts/*).
for stack in back front; do
  copy="${stack}/scripts/link-shared.mjs"
  [[ -f "${copy}" ]] || continue
  sha="$(shasum -a 256 "${copy}" | cut -d' ' -f1)"
  wrapper="${stack}/.libs/apptemplate/${stack}/scripts/link-shared.mjs"
  legacy_sha="LEGACY_SHA_$(echo "${stack}" | tr '[:lower:]' '[:upper:]')"
  if [[ "${sha}" == "$(shasum -a 256 "${wrapper}" 2>/dev/null | cut -d' ' -f1)" || "${sha}" == "${!legacy_sha:-}" ]]; then
    git rm -f -q "${copy}" 2>/dev/null || rm -f "${copy}"
    ok "removed obsolete ${copy}"
  else
    warn "${copy} differs from the template — kept (review it)."
  fi
done

# Report (never edit) local files still referencing the legacy library paths.
info "Files still referencing .libs/nestcommon or .libs/reactcommon (review by hand):"
legacy_refs="$(grep -rln '\.libs/\(nestcommon\|reactcommon\)' back front \
  --include=*.json --include=*.ts --include=*.mjs --include=*.js 2>/dev/null \
  | grep -v node_modules | grep -v '/\.libs/' || true)"
if [[ -n "${legacy_refs}" ]]; then echo "${legacy_refs}" | sed 's/^/    /'; else ok "none"; fi

cat <<SUMMARY

============================================================
  Migration to the WebAppTemplate layout done (NOT committed).
  - mounts: back|front/.libs/vx-public$([[ "${WITH_PRIVATE}" == "1" ]] && echo ', vx-private'), .libs/apptemplate -> vx-public/template
  - next: review 'git status', build back and front, then commit:

      git add -A && git commit -m "chore: migrate to WebAppTemplate (vx-public/vx-private)"
============================================================
SUMMARY
