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
# Migrate a project from the LEGACY shared-library mechanism (symlinks in
# `src/modules_shared` pointing at a machine-global checkout, e.g.
# ~/libraries/{nestcommon,reactcommon}) to the SUB-REPO mechanism
# used by newer projects: nestcommon / reactcommon vendored as **git submodules**
# under `back/.libs/nestcommon` and `front/.libs/reactcommon`.
#
# After this, `link-shared.mjs` resolves the submodule first (relative symlinks,
# reproducible in CI/Docker) and the global legacy path is no longer needed.
#
# Idempotent: skips a side whose submodule already exists. Works for both repo
# topologies — a single monorepo (one .git at the project root, back/ & front/
# as subdirs) and split repos (back/ and front/ each their own .git), by adding
# the submodule to whichever git repo actually owns the side directory.
#
# Usage:
#   scripts/migrate-to-submodules.sh [PROJECT_ROOT]
#   (PROJECT_ROOT defaults to the current directory.)
#
# Env overrides:
#   NESTCOMMON_URL   (default https://github.com/bccapps/common-nest.git)
#   REACTCOMMON_URL  (default https://github.com/bccapps/common-react.git)
#   LIB_BRANCH       (default main)
# =============================================================================

set -euo pipefail

PROJECT_ROOT="$(cd "${1:-$PWD}" && pwd)"
NESTCOMMON_URL="${NESTCOMMON_URL:-https://github.com/bccapps/common-nest.git}"
REACTCOMMON_URL="${REACTCOMMON_URL:-https://github.com/bccapps/common-react.git}"
LIB_BRANCH="${LIB_BRANCH:-main}"

info() { printf '\033[1;34m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m⚠\033[0m  %s\n' "$*" >&2; }
ok()   { printf '\033[1;32m✓\033[0m  %s\n' "$*"; }

if ! command -v git >/dev/null 2>&1; then
  echo "git introuvable." >&2; exit 1
fi

# Migrate one side: $1=side dir name (back|front), $2=lib name, $3=remote url.
migrate_side() {
  local side="$1" lib="$2" url="$3"
  local side_dir="${PROJECT_ROOT}/${side}"

  if [[ ! -d "${side_dir}" ]]; then
    warn "${side}/ absent — ignoré."
    return
  fi
  if ! git -C "${side_dir}" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    warn "${side}/ n'est pas dans un dépôt git — ignoré."
    return
  fi

  local top rel abs
  top="$(git -C "${side_dir}" rev-parse --show-toplevel)"
  abs="${side_dir}/.libs/${lib}"
  rel="${abs#"${top}"/}"   # path of the submodule relative to its git toplevel

  info "${side}: submodule '${rel}' dans le dépôt ${top}"

  # Already configured as a submodule?
  if git -C "${top}" config -f .gitmodules --get-regexp 'submodule\..*\.path' 2>/dev/null \
      | awk '{print $2}' | grep -qx "${rel}"; then
    ok "${side}: submodule déjà déclaré — mise à jour."
  elif [[ -e "${abs}" ]]; then
    warn "${side}: ${rel} existe déjà mais n'est pas un submodule déclaré — vérifie manuellement, ignoré."
    return
  else
    git -C "${top}" submodule add -b "${LIB_BRANCH}" "${url}" "${rel}"
    ok "${side}: submodule ajouté (${url} @ ${LIB_BRANCH})."
  fi

  git -C "${top}" submodule update --init --remote "${rel}"

  # Re-link shared modules: link-shared.mjs now prefers the submodule (relative links)
  # and prunes the old legacy symlinks.
  if [[ -f "${side_dir}/scripts/link-shared.mjs" ]]; then
    ( cd "${side_dir}" && node scripts/link-shared.mjs )
  else
    warn "${side}: scripts/link-shared.mjs absent — lance-le après avoir copié le script."
  fi
}

info "Migration vers submodules — projet: ${PROJECT_ROOT}"
migrate_side "back" "nestcommon" "${NESTCOMMON_URL}"
migrate_side "front" "reactcommon" "${REACTCOMMON_URL}"
ok "Terminé. Pense à committer .gitmodules + .libs/* (puis 'git submodule update --init --remote' au clone)."
